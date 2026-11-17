use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use anyhow::{bail, Context, Result};
use zip::write::SimpleFileOptions;
use zip::{AesMode, CompressionMethod, ZipArchive, ZipWriter};

use super::util::{
    collect_sources, copy_cancellable, ensure_parent, resolve_dest, safe_join, zip_datetime,
    Overwrite, Progress,
};
use super::{CreateReport, ExtractReport};

pub fn open(path: &Path) -> Result<ZipArchive<BufReader<File>>> {
    let f = File::open(path).with_context(|| format!("无法打开 {}", path.display()))?;
    ZipArchive::new(BufReader::new(f)).with_context(|| "ZIP 压缩包损坏或不是有效 ZIP")
}

pub fn create(
    sources: &[std::path::PathBuf],
    dest: &Path,
    password: Option<&str>,
    level: i64,
    progress: &Progress,
    cancel: &AtomicBool,
) -> Result<CreateReport> {
    let started = Instant::now();
    let (mut items, total) = collect_sources(sources, Some(dest))?;
    items.retain(|i| i.path != dest);
    progress.set_totals(items.iter().filter(|i| !i.is_dir).count() as u64, total);
    progress.phase("compress");

    let file = File::create(dest).with_context(|| format!("无法创建 {}", dest.display()))?;
    let mut writer = ZipWriter::new(BufWriter::new(file));
    let mut buf = vec![0u8; 256 * 1024];
    let mut bytes = 0u64;
    let mut files = 0u64;

    for item in &items {
        if cancel.load(Ordering::Relaxed) {
            bail!("操作已取消");
        }
        let mut opts = SimpleFileOptions::default()
            .compression_method(if item.is_dir {
                CompressionMethod::Stored
            } else {
                CompressionMethod::Deflated
            })
            .unix_permissions(if item.is_dir { 0o755 } else { 0o644 });
        if !item.is_dir {
            opts = opts.compression_level(Some(level.clamp(1, 9)));
        }
        if let Some(dt) = zip_datetime(&item.path) {
            opts = opts.last_modified_time(dt);
        }
        if let Some(pw) = password.filter(|p| !p.is_empty() && !item.is_dir) {
            opts = opts.with_aes_encryption(AesMode::Aes256, pw);
        }
        progress.set_current(&item.name);
        writer
            .start_file(item.name.clone(), opts)
            .with_context(|| format!("无法写入 {}", item.name))?;
        if item.is_dir {
            continue;
        }
        let mut src = File::open(&item.path)
            .with_context(|| format!("无法读取 {}", item.path.display()))?;
        loop {
            if cancel.load(Ordering::Relaxed) {
                bail!("操作已取消");
            }
            let n = src.read(&mut buf)?;
            if n == 0 {
                break;
            }
            writer.write_all(&buf[..n])?;
            bytes += n as u64;
            progress.add_bytes(n as u64);
        }
        files += 1;
        progress.file_done();
    }

    let out = writer.finish().context("无法完成 ZIP 写入")?;
    out.into_inner().map_err(|e| anyhow::anyhow!("{e}"))?.sync_all()?;
    Ok(CreateReport {
        path: dest.display().to_string(),
        format: "zip".into(),
        files,
        bytes,
        packed: fs::metadata(dest).map(|m| m.len()).unwrap_or(0),
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

pub fn extract(
    path: &Path,
    out_dir: &Path,
    selected: &std::collections::HashSet<usize>,
    password: Option<&str>,
    policy: Overwrite,
    mode: &str,
    progress: &Progress,
    cancel: &AtomicBool,
) -> Result<ExtractReport> {
    let threads = match mode {
        "balanced" => 2,
        "performance" => 4,
        "hyper" => 8,
        _ => 1,
    };
    if threads > 1 {
        if let Some(report) = extract_parallel(
            path, out_dir, selected, password, policy, mode, threads, progress, cancel,
        )? {
            return Ok(report);
        }
    }
    extract_sequential(path, out_dir, selected, password, policy, progress, cancel)
}

fn extract_sequential(
    path: &Path,
    out_dir: &Path,
    selected: &std::collections::HashSet<usize>,
    password: Option<&str>,
    policy: Overwrite,
    progress: &Progress,
    cancel: &AtomicBool,
) -> Result<ExtractReport> {
    let mut zip = open(path)?;
    let mut report = ExtractReport {
        files: 0,
        dirs: 0,
        bytes: 0,
        skipped: 0,
        warnings: Vec::new(),
        out_dir: out_dir.display().to_string(),
    };

    for i in 0..zip.len() {
        if !selected.contains(&i) {
            continue;
        }
        if cancel.load(Ordering::Relaxed) {
            bail!("操作已取消");
        }
        let encrypted = zip.by_index_raw(i).map(|e| e.encrypted()).unwrap_or(false);
        let mut entry = if encrypted {
            match password.filter(|p| !p.is_empty()) {
                Some(pw) => zip
                    .by_index_decrypt(i, pw.as_bytes())
                    .map_err(|_| anyhow::anyhow!("密码错误，或不支持该 ZIP 加密方式"))?,
                None => bail!("该 ZIP 已加密，请先输入密码"),
            }
        } else {
            zip.by_index(i)?
        };
        let raw_name = entry
            .name()
            .map_err(|e| anyhow::anyhow!("ZIP 文件名读取失败: {e}"))?
            .to_string();
        let is_dir = entry.is_dir() || raw_name.ends_with('/');
        progress.set_current(&raw_name);

        if is_dir {
            let target = safe_join(out_dir, &raw_name)?;
            fs::create_dir_all(&target)?;
            report.dirs += 1;
            progress.file_done();
            continue;
        }
        if entry
            .unix_mode()
            .map(|m| m & 0o170000 == 0o120000)
            .unwrap_or(false)
        {
            report.skipped += 1;
            report.warnings.push(format!("跳过符号链接: {raw_name}"));
            progress.add_bytes(entry.size());
            progress.file_done();
            continue;
        }
        let target = safe_join(out_dir, &raw_name)?;
        let Some(target) = resolve_dest(target, false, policy)? else {
            report.skipped += 1;
            progress.add_bytes(entry.size());
            progress.file_done();
            continue;
        };
        ensure_parent(&target)?;
        let mut out = File::create(&target)
            .with_context(|| format!("无法写入 {}", target.display()))?;
        let n = copy_cancellable(&mut entry, &mut out, cancel, |n| progress.add_bytes(n))?;
        out.sync_all().ok();
        report.files += 1;
        report.bytes += n;
        progress.file_done();
    }
    progress.finish();
    Ok(report)
}

struct ZipJob {
    index: usize,
    name: String,
    target: std::path::PathBuf,
    encrypted: bool,
}

/// 多文件 ZIP 并行解压：先顺序预扫描做全部安全检查（目标冲突/符号链接/密码/
/// 覆盖策略），只有确定安全时才并行写文件；否则返回 None 回退顺序实现。
fn extract_parallel(
    path: &Path,
    out_dir: &Path,
    selected: &std::collections::HashSet<usize>,
    password: Option<&str>,
    policy: Overwrite,
    mode: &str,
    threads: usize,
    progress: &Progress,
    cancel: &AtomicBool,
) -> Result<Option<ExtractReport>> {
    use std::collections::HashSet as Set;

    let mut zip = open(path)?;
    let mut jobs: Vec<ZipJob> = Vec::new();
    let mut dir_targets: Vec<std::path::PathBuf> = Vec::new();
    let mut seen: Set<String> = Set::new();
    let mut skipped: u64 = 0;
    let mut dirs: u64 = 0;

    for i in 0..zip.len() {
        if !selected.contains(&i) {
            continue;
        }
        let raw_name;
        let is_dir;
        let encrypted;
        let unix_mode;
        {
            let raw = zip.by_index_raw(i)?;
            raw_name = raw
                .name()
                .map_err(|e| anyhow::anyhow!("ZIP 文件名读取失败: {e}"))?
                .to_string();
            is_dir = raw.is_dir() || raw_name.ends_with('/');
            encrypted = raw.encrypted();
            unix_mode = raw.unix_mode();
        }
        if is_dir {
            dir_targets.push(safe_join(out_dir, &raw_name)?);
            dirs += 1;
            continue;
        }
        // 符号链接与同名目标都交回顺序实现，保持原语义
        if unix_mode.map(|m| m & 0o170000 == 0o120000).unwrap_or(false) {
            return Ok(None);
        }
        if encrypted && password.map_or(true, |p| p.is_empty()) {
            bail!("该 ZIP 已加密，请先输入密码");
        }
        let target = safe_join(out_dir, &raw_name)?;
        if !seen.insert(target.to_string_lossy().to_lowercase()) {
            return Ok(None);
        }
        match resolve_dest(target, false, policy)? {
            Some(target) => jobs.push(ZipJob {
                index: i,
                name: raw_name,
                target,
                encrypted,
            }),
            None => {
                skipped += 1;
                progress.add_bytes(0);
                progress.file_done();
            }
        }
    }
    if jobs.len() < 2 {
        return Ok(None);
    }
    for d in &dir_targets {
        fs::create_dir_all(d)?;
    }

    let threads = threads.min(jobs.len());
    let mut chunks: Vec<Vec<ZipJob>> = (0..threads).map(|_| Vec::new()).collect();
    for (n, job) in jobs.into_iter().enumerate() {
        chunks[n % threads].push(job);
    }

    let failed = AtomicBool::new(false);
    let files = std::sync::atomic::AtomicU64::new(0);
    let bytes = std::sync::atomic::AtomicU64::new(0);
    let pw_owned = password.map(|p| p.to_string());

    let results: Vec<Result<()>> = std::thread::scope(|scope| {
        let handles: Vec<_> = chunks
            .into_iter()
            .map(|chunk| {
                let failed = &failed;
                let files = &files;
                let bytes = &bytes;
                let pw = pw_owned.as_deref();
                scope.spawn(move || -> Result<()> {
                    super::set_thread_priority(mode);
                    let mut zip = open(path)?;
                    for job in chunk {
                        if failed.load(Ordering::Relaxed) {
                            bail!("并行解压已中止");
                        }
                        if cancel.load(Ordering::Relaxed) {
                            bail!("操作已取消");
                        }
                        let mut entry = if job.encrypted {
                            let pw = pw
                                .ok_or_else(|| anyhow::anyhow!("该 ZIP 已加密，请先输入密码"))?;
                            zip.by_index_decrypt(job.index, pw.as_bytes()).map_err(|_| {
                                anyhow::anyhow!("密码错误，或不支持该 ZIP 加密方式")
                            })?
                        } else {
                            zip.by_index(job.index)?
                        };
                        progress.set_current(&job.name);
                        ensure_parent(&job.target)?;
                        let mut out = File::create(&job.target)
                            .with_context(|| format!("无法写入 {}", job.target.display()))?;
                        let n = match copy_cancellable(&mut entry, &mut out, cancel, |n| {
                            progress.add_bytes(n)
                        }) {
                            Ok(n) => n,
                            Err(e) => {
                                failed.store(true, Ordering::Relaxed);
                                return Err(e);
                            }
                        };
                        out.sync_all().ok();
                        files.fetch_add(1, Ordering::Relaxed);
                        bytes.fetch_add(n, Ordering::Relaxed);
                        progress.file_done();
                    }
                    Ok(())
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|h| h.join().unwrap_or_else(|_| Err(anyhow::anyhow!("解压线程异常"))))
            .collect()
    });

    for r in results {
        if let Err(e) = r {
            return Err(e);
        }
    }
    progress.finish();
    Ok(Some(ExtractReport {
        files: files.load(Ordering::Relaxed),
        dirs,
        bytes: bytes.load(Ordering::Relaxed),
        skipped,
        warnings: Vec::new(),
        out_dir: out_dir.display().to_string(),
    }))
}

pub fn read_entry(path: &Path, index: usize, password: Option<&str>, limit: u64) -> Result<Vec<u8>> {
    let mut zip = open(path)?;
    if index >= zip.len() {
        bail!("条目索引超出范围");
    }
    let encrypted = zip.by_index_raw(index).map(|e| e.encrypted()).unwrap_or(false);
    let mut entry = if encrypted {
        let pw = password.filter(|p| !p.is_empty()).context("该文件已加密")?;
        zip.by_index_decrypt(index, pw.as_bytes())
            .map_err(|_| anyhow::anyhow!("密码错误"))?
    } else {
        zip.by_index(index)?
    };
    let mut out = Vec::new();
    entry.take(limit).read_to_end(&mut out)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn make_zip(path: &Path, entries: &[(&str, &[u8])]) {
        let f = File::create(path).unwrap();
        let mut w = ZipWriter::new(f);
        let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        for (name, data) in entries {
            w.start_file(*name, opts).unwrap();
            w.write_all(data).unwrap();
        }
        w.finish().unwrap();
    }

    fn all_indices(zip_path: &Path) -> HashSet<usize> {
        let mut archive = open(zip_path).unwrap();
        (0..archive.len()).collect()
    }

    fn run(mode: &str, zip: &Path, out: &Path, policy: Overwrite) -> Result<ExtractReport> {
        let p = Progress::detached();
        let cancel = AtomicBool::new(false);
        let selected = all_indices(zip);
        extract(zip, out, &selected, None, policy, mode, &p, &cancel)
    }

    fn temp_root(tag: &str) -> std::path::PathBuf {
        let base = std::env::var_os("TIDY_TEST_TMP")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::path::PathBuf::from("D:\\Builds\\tidy-zip-tests"));
        let dir = base.join(format!("{tag}_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn sequential_and_parallel_match() {
        let root = temp_root("modes");
        let zip = root.join("a.zip");
        let data: Vec<(String, Vec<u8>)> = (0..5)
            .map(|i| (format!("f{i}.bin"), vec![i as u8; 96 * 1024]))
            .collect();
        let refs: Vec<(&str, &[u8])> = data.iter().map(|(n, d)| (n.as_str(), d.as_slice())).collect();
        make_zip(&zip, &refs);

        for mode in ["saver", "balanced", "hyper"] {
            let out = root.join(format!("out_{mode}"));
            let rep = run(mode, &zip, &out, Overwrite::Rename).unwrap();
            assert_eq!(rep.files, 5, "mode {mode}");
            for (name, bytes) in &data {
                assert_eq!(&fs::read(out.join(name)).unwrap(), bytes, "mode {mode} {name}");
            }
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn single_entry_falls_back_to_sequential() {
        let root = temp_root("single");
        let zip = root.join("one.zip");
        make_zip(&zip, &[("only.txt", b"hello")]);
        let out = root.join("out");
        let rep = run("hyper", &zip, &out, Overwrite::Overwrite).unwrap();
        assert_eq!(rep.files, 1);
        assert_eq!(fs::read(out.join("only.txt")).unwrap(), b"hello");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn case_collision_falls_back_and_keep_last() {
        let root = temp_root("dup");
        let zip = root.join("dup.zip");
        make_zip(&zip, &[("Dup.txt", b"one"), ("dup.txt", b"two")]);
        let out = root.join("out");
        let rep = run("hyper", &zip, &out, Overwrite::Overwrite).unwrap();
        assert_eq!(rep.files, 2, "两个大小写不同的条目都应被处理");
        let got = fs::read(out.join("dup.txt")).unwrap();
        assert_eq!(got, b"two", "后写入的条目应覆盖前者");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn overwrite_policy_keeps_new_content() {
        let root = temp_root("ow");
        let zip1 = root.join("a.zip");
        let zip2 = root.join("b.zip");
        make_zip(&zip1, &[("x.txt", b"old")]);
        make_zip(&zip2, &[("x.txt", b"new")]);
        let out = root.join("out");
        run("saver", &zip1, &out, Overwrite::Overwrite).unwrap();
        run("hyper", &zip2, &out, Overwrite::Overwrite).unwrap();
        assert_eq!(fs::read(out.join("x.txt")).unwrap(), b"new");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn cancel_before_start_errors() {        let root = temp_root("cancel");
        let zip = root.join("a.zip");
        make_zip(&zip, &[("a.txt", b"a"), ("b.txt", b"b")]);
        let out = root.join("out");
        let p = Progress::detached();
        let cancel = AtomicBool::new(true);
        let selected = all_indices(&zip);
        let res = extract(
            &zip,
            &out,
            &selected,
            None,
            Overwrite::Overwrite,
            "saver",
            &p,
            &cancel,
        );
        match res {
            Ok(_) => panic!("取消后不应成功"),
            Err(err) => assert!(format!("{err}").contains("取消"), "unexpected: {err}"),
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn nested_paths_create_dirs_and_files() {
        let root = temp_root("nested");
        let zip = root.join("n.zip");
        make_zip(
            &zip,
            &[("sub/deep/a.txt", b"a"), ("sub/b.txt", b"b"), ("root.txt", b"r")],
        );
        let out = root.join("out");
        let rep = run("hyper", &zip, &out, Overwrite::Overwrite).unwrap();
        assert_eq!(rep.files, 3);
        assert_eq!(fs::read(out.join("sub/deep/a.txt")).unwrap(), b"a");
        assert_eq!(fs::read(out.join("sub/b.txt")).unwrap(), b"b");
        assert_eq!(fs::read(out.join("root.txt")).unwrap(), b"r");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn traversal_is_rejected() {
        let root = temp_root("traversal");
        let zip = root.join("evil.zip");
        make_zip(&zip, &[("../evil.txt", b"x")]);
        let out = root.join("out");
        let res = run("hyper", &zip, &out, Overwrite::Overwrite);
        assert!(res.is_err(), "路径穿越必须报错而不是写出");
        assert!(!root.join("evil.txt").exists());
        let _ = fs::remove_dir_all(&root);
    }
}
