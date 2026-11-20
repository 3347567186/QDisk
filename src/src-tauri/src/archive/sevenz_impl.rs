use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File};
use std::io::{self, BufWriter, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc};
use std::time::Instant;

use anyhow::{bail, Context, Result};
use sevenz_rust2::encoder_options::{AesEncoderOptions, Lzma2Options};
use sevenz_rust2::{
    ArchiveEntry, ArchiveReader, ArchiveWriter, EncoderConfiguration, EntryDecision, Password,
    SourceReader,
};

use super::util::{
    collect_sources, copy_cancellable, ensure_parent, filetime_to_local_parts, resolve_dest,
    safe_join, Budget, Overwrite, Progress, SourceItem,
};
use super::{modified_string, ArchiveInfo, CreateReport, EntryInfo, ExtractReport};

const BLOCK_BYTES: u64 = 8 * 1024 * 1024;

fn password(pw: Option<&str>) -> Password {
    match pw.filter(|p| !p.is_empty()) {
        Some(p) => Password::from(p),
        None => Password::empty(),
    }
}

fn methods(level: u32, threads: u32, pw: Option<&str>) -> Vec<EncoderConfiguration> {
    let lzma = if threads > 1 {
        Lzma2Options::from_level_mt(level, threads, 8 * 1024 * 1024)
    } else {
        Lzma2Options::from_level(level)
    };
    let mut out = Vec::with_capacity(2);
    if let Some(pw) = pw.filter(|p| !p.is_empty()) {
        out.push(AesEncoderOptions::new(Password::from(pw)).into());
    }
    out.push(lzma.into());
    out
}

pub fn list(path: &Path, pw: Option<&str>) -> Result<ArchiveInfo> {
    let mut reader = ArchiveReader::open(path, password(pw))
        .with_context(|| "7Z 压缩包损坏，或密码不正确")?;
    reader.set_thread_count(2);
    let archive = reader.archive();
    let mut entries = Vec::with_capacity(archive.files.len());
    for (i, e) in archive.files.iter().enumerate() {
        // 7Z 头里存的是 Windows FILETIME（100ns since 1601），只有条目确实带
        // 时间时 has_last_modified_date 才为 true；转成本地时间再格式化。
        let modified = if e.has_last_modified_date {
            modified_string(filetime_to_local_parts(e.last_modified_date.into()))
        } else {
            "—".to_string()
        };
        entries.push(EntryInfo {
            index: i,
            name: e.name.replace('\\', "/"),
            is_dir: e.is_directory,
            size: e.size,
            packed: e.compressed_size,
            modified,
            encrypted: archive.is_file_encrypted(i),
            crc: if e.has_crc { e.crc as u32 } else { 0 },
        });
    }
    let total_size = entries.iter().filter(|e| !e.is_dir).map(|e| e.size).sum();
    let total_packed = entries.iter().filter(|e| !e.is_dir).map(|e| e.packed).sum();
    let encrypted = entries.iter().any(|e| e.encrypted);
    Ok(ArchiveInfo {
        path: path.display().to_string(),
        format: "7Z".into(),
        entries,
        total_size,
        total_packed,
        encrypted,
        solid: archive.is_solid,
        comment: String::new(),
        needs_rar: false,
        rar_ready: true,
    })
}

pub fn create(
    sources: &[PathBuf],
    dest: &Path,
    pw: Option<&str>,
    threads: usize,
    progress: &Progress,
    cancel: &AtomicBool,
) -> Result<CreateReport> {
    let started = Instant::now();
    let (mut items, total) = collect_sources(sources, Some(dest))?;
    items.retain(|i| i.path != dest);
    let file_count = items.iter().filter(|i| !i.is_dir).count() as u64;
    progress.set_totals(file_count, total);
    progress.phase("compress");

    let file = File::create(dest).with_context(|| format!("无法创建 {}", dest.display()))?;
    let mut writer = ArchiveWriter::new(BufWriter::new(file)).context("无法初始化 7Z 写入器")?;
    let methods = Arc::new(methods(3, threads as u32, pw));
    writer.set_content_methods((*methods).clone());

    let chunks = split_chunks(&items, BLOCK_BYTES);
    let chunk_meta: Vec<(u64, u64)> = chunks
        .iter()
        .map(|c| {
            (
                c.iter().filter(|i| !i.is_dir).count() as u64,
                c.iter().map(|i| i.size).sum(),
            )
        })
        .collect();

    if threads <= 1 {
        for (ci, chunk) in chunks.iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                bail!("操作已取消");
            }
            let (entries, readers) = materialize(chunk)?;
            writer
                .push_archive_entries(entries, readers)
                .context("7Z 压缩失败")?;
            progress.add_bytes(chunk_meta[ci].1);
            for _ in 0..chunk_meta[ci].0 {
                progress.file_done();
            }
        }
    } else {
        let next = AtomicUsize::new(0);
        let (tx, rx) = mpsc::sync_channel::<(usize, Result<sevenz_rust2::PreparedBlock>)>(
            threads * 2,
        );
        let mut failure: Option<anyhow::Error> = None;
        std::thread::scope(|scope| {
            for _ in 0..threads {
                let tx = tx.clone();
                let next = &next;
                let chunks = &chunks;
                let methods = methods.clone();
                let cancel = cancel;
                scope.spawn(move || loop {
                    let i = next.fetch_add(1, Ordering::SeqCst);
                    if i >= chunks.len() {
                        break;
                    }
                    if cancel.load(Ordering::Relaxed) {
                        let _ = tx.send((i, Err(anyhow::anyhow!("操作已取消"))));
                        break;
                    }
                    let result = materialize(&chunks[i])
                        .and_then(|(entries, readers)| {
                            sevenz_rust2::prepare_block(methods.clone(), entries, readers)
                                .map_err(|e| anyhow::anyhow!("{e}"))
                        });
                    if tx.send((i, result)).is_err() {
                        break;
                    }
                });
            }
            drop(tx);
            let mut pending: BTreeMap<usize, sevenz_rust2::PreparedBlock> = BTreeMap::new();
            let mut next_write = 0usize;
            for (i, result) in rx {
                match result {
                    Ok(block) => {
                        pending.insert(i, block);
                    }
                    Err(e) => {
                        failure = Some(e);
                        break;
                    }
                }
                while let Some(block) = pending.remove(&next_write) {
                    if let Err(e) = writer.push_prepared_block(block) {
                        failure = Some(anyhow::anyhow!("{e}"));
                        break;
                    }
                    progress.add_bytes(chunk_meta[next_write].1);
                    for _ in 0..chunk_meta[next_write].0 {
                        progress.file_done();
                    }
                    next_write += 1;
                }
                if failure.is_some() {
                    break;
                }
            }
        });
        if let Some(e) = failure {
            return Err(e);
        }
        if cancel.load(Ordering::Relaxed) {
            bail!("操作已取消");
        }
    }

    let out = writer.finish().context("无法完成 7Z 写入")?;
    out.into_inner()
        .map_err(|e| anyhow::anyhow!("{e}"))?
        .sync_all()?;
    Ok(CreateReport {
        path: dest.display().to_string(),
        format: "7z".into(),
        files: progress.files_count(),
        bytes: progress.bytes_count(),
        packed: fs::metadata(dest).map(|m| m.len()).unwrap_or(0),
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

fn split_chunks(items: &[SourceItem], limit: u64) -> Vec<Vec<SourceItem>> {
    let mut out: Vec<Vec<SourceItem>> = Vec::new();
    let mut current: Vec<SourceItem> = Vec::new();
    let mut bytes = 0u64;
    for item in items {
        if !item.is_dir && bytes > 0 && bytes + item.size > limit {
            out.push(std::mem::take(&mut current));
            bytes = 0;
        }
        if !item.is_dir {
            bytes += item.size;
        }
        current.push(item.clone());
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

type AnyReader = Box<dyn Read + Send>;

fn materialize(
    chunk: &[SourceItem],
) -> Result<(Vec<ArchiveEntry>, Vec<SourceReader<AnyReader>>)> {
    let mut entries = Vec::with_capacity(chunk.len());
    let mut readers = Vec::with_capacity(chunk.len());
    for item in chunk {
        let entry = ArchiveEntry::from_path(&item.path, item.name.clone());
        let reader: AnyReader = if item.is_dir {
            Box::new(io::empty())
        } else {
            Box::new(
                File::open(&item.path)
                    .with_context(|| format!("无法读取 {}", item.path.display()))?,
            )
        };
        entries.push(entry);
        readers.push(SourceReader::new(reader));
    }
    Ok((entries, readers))
}

pub fn extract(
    path: &Path,
    out_dir: &Path,
    selected: &HashSet<usize>,
    pw: Option<&str>,
    policy: Overwrite,
    progress: &Progress,
    cancel: &AtomicBool,
) -> Result<ExtractReport> {
    let mut reader = ArchiveReader::open(path, password(pw))
        .with_context(|| "7Z 压缩包损坏，或密码不正确")?;
    reader.set_thread_count(2);
    let selected_names: HashSet<String> = {
        let names: Vec<String> = reader
            .archive()
            .files
            .iter()
            .enumerate()
            .filter(|(i, _)| selected.contains(i))
            .map(|(_, e)| e.name.clone())
            .collect();
        names.into_iter().collect()
    };
    // 7Z 的头部同样带每个条目解压后的大小，和 ZIP 一样可以「一个字节都不写
    // 就拒绝」。以前这个上限是逐条目算的，整包总量没有封顶。
    let budget = Budget::for_extraction();
    let declared: u64 = reader
        .archive()
        .files
        .iter()
        .enumerate()
        .filter(|(i, _)| selected.contains(i))
        .filter(|(_, e)| !e.is_directory)
        .map(|(_, e)| e.size)
        .sum();
    budget.check_declared(declared)?;
    let mut report = ExtractReport {
        files: 0,
        dirs: 0,
        bytes: 0,
        skipped: 0,
        warnings: Vec::new(),
        out_dir: out_dir.display().to_string(),
    };
    let mut stopped = false;

    reader
        .for_each_entries_with_decision(|entry, data| {
            if cancel.load(Ordering::Relaxed) {
                stopped = true;
                return Ok(EntryDecision::Stop);
            }
            let raw = entry.name.replace('\\', "/");
            if entry.is_directory {
                if selected_names.contains(&entry.name) {
                    match safe_join(out_dir, &raw) {
                        Ok(dir) => {
                            if fs::create_dir_all(&dir).is_ok() {
                                report.dirs += 1;
                            }
                        }
                        Err(e) => report.warnings.push(format!("{e}")),
                    }
                }
                return Ok(EntryDecision::Continue);
            }
            if !selected_names.contains(&entry.name) {
                return Ok(EntryDecision::Continue);
            }
            progress.set_current(&raw);
            if entry.windows_attributes & 0x400 != 0 {
                report.skipped += 1;
                report
                    .warnings
                    .push(format!("跳过重解析点/符号链接: {raw}"));
                return Ok(EntryDecision::Continue);
            }
            let target = match safe_join(out_dir, &raw) {
                Ok(p) => p,
                Err(e) => {
                    report.skipped += 1;
                    report.warnings.push(format!("{e}"));
                    return Ok(EntryDecision::Continue);
                }
            };
            let target = match resolve_dest(target, false, policy) {
                Ok(Some(p)) => p,
                Ok(None) => {
                    report.skipped += 1;
                    return Ok(EntryDecision::Continue);
                }
                Err(e) => {
                    report.skipped += 1;
                    report.warnings.push(format!("{e}"));
                    return Ok(EntryDecision::Continue);
                }
            };
            if let Err(e) = ensure_parent(&target) {
                report.skipped += 1;
                report.warnings.push(format!("{e}"));
                return Ok(EntryDecision::Continue);
            }
            let mut out = match File::create(&target) {
                Ok(f) => f,
                Err(e) => {
                    report.skipped += 1;
                    report.warnings.push(format!("{raw}: {e}"));
                    return Ok(EntryDecision::Continue);
                }
            };
            match copy_cancellable(&mut *data, &mut out, cancel, &budget, |n| {
                progress.add_bytes(n)
            }) {
                Ok(n) => {
                    report.files += 1;
                    report.bytes += n;
                    progress.file_done();
                    Ok(EntryDecision::Continue)
                }
                Err(e) => {
                    report.warnings.push(format!("{raw}: {e}"));
                    Ok(EntryDecision::Stop)
                }
            }
        })
        .map_err(|e| anyhow::anyhow!("7Z 解压失败: {e}"))?;
    if stopped || cancel.load(Ordering::Relaxed) {
        bail!("操作已取消");
    }
    progress.finish();
    Ok(report)
}

pub fn read_entry(
    path: &Path,
    index: usize,
    pw: Option<&str>,
    limit: u64,
) -> Result<Vec<u8>> {
    let mut reader = ArchiveReader::open(path, password(pw))
        .with_context(|| "7Z 压缩包损坏，或密码不正确")?;
    reader.set_thread_count(1);
    let target = reader
        .archive()
        .files
        .get(index)
        .map(|e| e.name.clone())
        .context("条目索引超出范围")?;
    let mut result: Option<Vec<u8>> = None;
    reader
        .for_each_entries_with_decision(|entry, data| {
            if entry.name != target {
                return Ok(EntryDecision::Continue);
            }
            let mut out = Vec::new();
            data.take(limit).read_to_end(&mut out)?;
            result = Some(out);
            Ok(EntryDecision::Stop)
        })
        .map_err(|e| anyhow::anyhow!("7Z 读取失败: {e}"))?;
    result.context("未找到该条目")
}
