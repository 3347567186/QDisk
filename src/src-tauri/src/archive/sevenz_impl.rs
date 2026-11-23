use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File};
use std::io::{self, BufWriter, Read, Write};
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

use super::undo::UndoTracker;
use super::util::{
    collect_sources, copy_controlled, ensure_parent, filetime_to_local_parts, resolve_dest,
    safe_join_mapped, Budget, ControlledReader, Overwrite, PerfProfile, Progress, SourceItem,
    TaskControl, ThreadPriorityGuard,
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
    let level = level.clamp(1, 9);
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
    profile: PerfProfile,
    progress: &Arc<Progress>,
    control: &Arc<TaskControl>,
) -> Result<CreateReport> {
    let _prio = ThreadPriorityGuard::enter(profile.mode);
    let started = Instant::now();
    let (mut items, total) = collect_sources(sources, Some(dest))?;
    items.retain(|i| i.path != dest);
    let file_count = items.iter().filter(|i| !i.is_dir).count() as u64;
    progress.set_totals(file_count, total);
    progress.phase("compress");

    let file = File::create(dest).with_context(|| format!("无法创建 {}", dest.display()))?;
    let mut writer = ArchiveWriter::new(BufWriter::with_capacity(profile.buf_size, file))
        .context("无法初始化 7Z 写入器")?;

    let chunks = split_chunks(&items, BLOCK_BYTES);
    let chunk_files: Vec<u64> = chunks
        .iter()
        .map(|c| c.iter().filter(|i| !i.is_dir).count() as u64)
        .collect();

    // 避免 outer(8) × inner(8) = 64 线程过度竞争：总并发严格控制在 profile.threads 以内。
    let (outer_threads, inner_threads) = if profile.threads <= 1 {
        (1usize, 1u32)
    } else if chunks.len() <= 1 {
        (1usize, profile.threads as u32)
    } else {
        let outer = profile.threads.min(chunks.len());
        let inner = (profile.threads / outer).max(1) as u32;
        (outer, inner)
    };

    let methods = Arc::new(methods(profile.sevenz_level, inner_threads, pw));
    writer.set_content_methods((*methods).clone());

    if outer_threads <= 1 {
        for (ci, chunk) in chunks.iter().enumerate() {
            control.checkpoint(Some(progress))?;
            let (entries, readers) = materialize(chunk, control, progress, profile.saver_pace)?;
            if let Err(e) = writer.push_archive_entries(entries, readers) {
                if control.is_cancelled() {
                    bail!("操作已取消");
                }
                return Err(anyhow::anyhow!("7Z 压缩失败: {e}"));
            }
            for _ in 0..chunk_files[ci] {
                progress.file_done();
            }
        }
    } else {
        let next = AtomicUsize::new(0);
        let abort = AtomicBool::new(false);
        let (tx, rx) =
            mpsc::sync_channel::<(usize, Result<sevenz_rust2::PreparedBlock>)>(outer_threads * 2);
        let mut failure: Option<anyhow::Error> = None;

        std::thread::scope(|scope| {
            for _ in 0..outer_threads {
                let tx = tx.clone();
                let next = &next;
                let chunks = &chunks;
                let methods = methods.clone();
                let ctl = control.clone();
                let prog = progress.clone();
                let abort_ref = &abort;
                scope.spawn(move || {
                    let _prio = ThreadPriorityGuard::enter(profile.mode);
                    loop {
                        if abort_ref.load(Ordering::Acquire) {
                            break;
                        }
                        let i = next.fetch_add(1, Ordering::SeqCst);
                        if i >= chunks.len() {
                            break;
                        }
                        if let Err(e) = ctl.checkpoint(Some(&prog)) {
                            abort_ref.store(true, Ordering::SeqCst);
                            let _ = tx.send((i, Err(e)));
                            break;
                        }
                        let result = materialize(&chunks[i], &ctl, &prog, profile.saver_pace)
                            .and_then(|(entries, readers)| {
                                sevenz_rust2::prepare_block(methods.clone(), entries, readers)
                                    .map_err(|e| anyhow::anyhow!("{e}"))
                            });
                        if result.is_err() {
                            abort_ref.store(true, Ordering::SeqCst);
                        }
                        if tx.send((i, result)).is_err() {
                            break;
                        }
                    }
                });
            }
            drop(tx);
            let mut pending: BTreeMap<usize, sevenz_rust2::PreparedBlock> = BTreeMap::new();
            let mut next_write = 0usize;
            for (i, result) in &rx {
                match result {
                    Ok(block) => {
                        pending.insert(i, block);
                    }
                    Err(e) => {
                        abort.store(true, Ordering::SeqCst);
                        failure = Some(e);
                        break;
                    }
                }
                while let Some(block) = pending.remove(&next_write) {
                    if let Err(e) = control.checkpoint(Some(progress)) {
                        abort.store(true, Ordering::SeqCst);
                        failure = Some(e);
                        break;
                    }
                    if let Err(e) = writer.push_prepared_block(block) {
                        abort.store(true, Ordering::SeqCst);
                        failure = Some(anyhow::anyhow!("{e}"));
                        break;
                    }
                    for _ in 0..chunk_files[next_write] {
                        progress.file_done();
                    }
                    next_write += 1;
                }
                if failure.is_some() {
                    break;
                }
            }
            drop(rx);
        });
        if control.is_cancelled() {
            bail!("操作已取消");
        }
        if let Some(e) = failure {
            return Err(e);
        }
    }

    let out = writer.finish().context("无法完成 7Z 写入")?;
    let mut inner = out.into_inner().map_err(|e| anyhow::anyhow!("{e}"))?;
    inner.flush()?;
    inner.sync_all()?;
    Ok(CreateReport {
        path: dest.display().to_string(),
        format: "7z".into(),
        files: progress.files_count(),
        bytes: progress.bytes_count(),
        packed: fs::metadata(dest).map(|m| m.len()).unwrap_or(0),
        elapsed_ms: started.elapsed().as_millis() as u64,
        undo_id: None,
        can_undo: false,
        backup_incomplete: false,
        backup_bytes: 0,
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
    control: &Arc<TaskControl>,
    progress: &Arc<Progress>,
    saver_pace: bool,
) -> Result<(Vec<ArchiveEntry>, Vec<SourceReader<AnyReader>>)> {
    let mut entries = Vec::with_capacity(chunk.len());
    let mut readers = Vec::with_capacity(chunk.len());
    for item in chunk {
        control.checkpoint(Some(progress))?;
        progress.set_current(&item.name);
        let entry = ArchiveEntry::from_path(&item.path, item.name.clone());
        let reader: AnyReader = if item.is_dir {
            Box::new(io::empty())
        } else {
            let f = File::open(&item.path)
                .with_context(|| format!("无法读取 {}", item.path.display()))?;
            Box::new(ControlledReader::new(
                f,
                control.clone(),
                progress.clone(),
                saver_pace,
            ))
        };
        entries.push(entry);
        readers.push(SourceReader::new(reader));
    }
    Ok((entries, readers))
}

#[allow(clippy::too_many_arguments)]
pub fn extract(
    path: &Path,
    out_dir: &Path,
    selected: &HashSet<usize>,
    pw: Option<&str>,
    policy: Overwrite,
    profile: PerfProfile,
    dir_map: &HashMap<String, String>,
    undo: Option<&Arc<UndoTracker>>,
    progress: &Progress,
    control: &TaskControl,
) -> Result<ExtractReport> {
    extract_with_budget(
        path,
        out_dir,
        selected,
        pw,
        policy,
        profile,
        dir_map,
        undo,
        progress,
        control,
        Budget::for_extraction(),
    )
}

#[allow(clippy::too_many_arguments)]
fn extract_with_budget(
    path: &Path,
    out_dir: &Path,
    selected: &HashSet<usize>,
    pw: Option<&str>,
    policy: Overwrite,
    profile: PerfProfile,
    dir_map: &HashMap<String, String>,
    undo: Option<&Arc<UndoTracker>>,
    progress: &Progress,
    control: &TaskControl,
    budget: Budget,
) -> Result<ExtractReport> {
    let _prio = ThreadPriorityGuard::enter(profile.mode);
    let mut reader = ArchiveReader::open(path, password(pw))
        .with_context(|| "7Z 压缩包损坏，或密码不正确")?;
    reader.set_thread_count(profile.threads as u32);
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
        undo_id: None,
        can_undo: false,
        backup_incomplete: false,
        backup_bytes: 0,
    };
    let mut stopped = false;
    let mut fatal_err: Option<anyhow::Error> = None;

    let iter_res = reader.for_each_entries_with_decision(|entry, data| {
        if control.checkpoint(Some(progress)).is_err() {
            stopped = true;
            return Ok(EntryDecision::Stop);
        }
        let raw = entry.name.replace('\\', "/");
        if entry.is_directory {
            if selected_names.contains(&entry.name) {
                match safe_join_mapped(out_dir, &raw, dir_map) {
                    Ok(dir) => {
                        let ok = if let Some(u) = undo {
                            u.ensure_dir(&dir).is_ok()
                        } else {
                            fs::create_dir_all(&dir).is_ok()
                        };
                        if ok {
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
        let target = match safe_join_mapped(out_dir, &raw, dir_map) {
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
                progress.add_bytes(entry.size);
                progress.file_done();
                return Ok(EntryDecision::Continue);
            }
            Err(e) => {
                report.skipped += 1;
                report.warnings.push(format!("{e}"));
                return Ok(EntryDecision::Continue);
            }
        };
        let prep_res = if let Some(u) = undo {
            u.prepare_file_write(&target, policy)
        } else {
            ensure_parent(&target)
        };
        if let Err(e) = prep_res {
            report.skipped += 1;
            report.warnings.push(format!("{e}"));
            return Ok(EntryDecision::Continue);
        }
        let f = match File::create(&target) {
            Ok(f) => f,
            Err(e) => {
                report.skipped += 1;
                report.warnings.push(format!("{raw}: {e}"));
                return Ok(EntryDecision::Continue);
            }
        };
        let mut out = BufWriter::with_capacity(profile.buf_size, f);
        match copy_controlled(
            &mut *data,
            &mut out,
            control,
            profile,
            Some(&budget),
            Some(progress),
            |n| progress.add_bytes(n),
        )
        .and_then(|n| {
            out.flush()?;
            Ok(n)
        }) {
            Ok(n) => {
                if let Some(u) = undo {
                    u.record_created_file(&target);
                }
                report.files += 1;
                report.bytes += n;
                progress.file_done();
                Ok(EntryDecision::Continue)
            }
            Err(e) => {
                drop(out);
                let _ = fs::remove_file(&target);
                if control.is_cancelled() {
                    stopped = true;
                } else {
                    // 预算超限/写盘失败等硬错误必须向上传播，绝不能静默返回 Ok("解压完成")。
                    fatal_err = Some(e);
                }
                Ok(EntryDecision::Stop)
            }
        }
    });
    if stopped || control.is_cancelled() {
        bail!("操作已取消");
    }
    if let Some(e) = fatal_err {
        return Err(e);
    }
    iter_res.map_err(|e| anyhow::anyhow!("7Z 解压失败: {e}"))?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn sevenz_roundtrip_budget_and_pause_cancel() {
        let root = PathBuf::from("D:\\Builds\\tidy-7z-tests")
            .join(format!("sz_{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let src = root.join("src");
        fs::create_dir_all(src.join("子目录")).unwrap();
        let data_a = "7z-redteam-content-".repeat(8 * 1024).into_bytes();
        let data_b = b"small-7z-utf8-\xe4\xb8\xad\xe6\x96\x87".to_vec();
        fs::write(src.join("a.txt"), &data_a).unwrap();
        fs::write(src.join("子目录/b.txt"), &data_b).unwrap();

        for mode in ["saver", "hyper"] {
            let sz = root.join(format!("out_{mode}.7z"));
            let pc = Arc::new(Progress::detached());
            let ctlc = Arc::new(TaskControl::default());
            let prof = PerfProfile::from_mode(mode);
            let crep = create(&[src.clone()], &sz, None, prof, &pc, &ctlc).unwrap();
            assert_eq!(crep.files, 2, "mode {mode}");
            assert_eq!(pc.bytes_count(), (data_a.len() + data_b.len()) as u64);

            let info = list(&sz, None).unwrap();
            let sel: HashSet<usize> = info.entries.iter().map(|e| e.index).collect();
            let out = root.join(format!("ext_{mode}"));
            fs::create_dir_all(&out).unwrap();
            let pe = Arc::new(Progress::detached());
            let ctle = Arc::new(TaskControl::default());
            let empty_map = HashMap::new();
            let erep = extract(
                &sz,
                &out,
                &sel,
                None,
                Overwrite::Overwrite,
                prof,
                &empty_map,
                None,
                &pe,
                &ctle,
            )
            .unwrap();
            assert_eq!(erep.files, 2);
            assert_eq!(fs::read(out.join("src/a.txt")).unwrap(), data_a);
            assert_eq!(fs::read(out.join("src/子目录/b.txt")).unwrap(), data_b);
        }

        // 预算超限硬错误必须返回 Err，绝不静默返回 Ok
        let sz = root.join("out_hyper.7z");
        let info = list(&sz, None).unwrap();
        let sel: HashSet<usize> = info.entries.iter().map(|e| e.index).collect();
        let out_over = root.join("ext_over");
        fs::create_dir_all(&out_over).unwrap();
        let pe = Arc::new(Progress::detached());
        let ctle = Arc::new(TaskControl::default());
        let empty_map = HashMap::new();
        let over = extract_with_budget(
            &sz,
            &out_over,
            &sel,
            None,
            Overwrite::Overwrite,
            PerfProfile::from_mode("hyper"),
            &empty_map,
            None,
            &pe,
            &ctle,
            Budget::new(1024),
        );
        assert!(over.is_err(), "超预算 7Z 必须返回 Err");

        // 暂停态下取消 7Z 压缩不死锁且 <500ms 退出
        let sz_cancel = root.join("cancel.7z");
        let pc2 = Arc::new(Progress::detached());
        let ctl2 = Arc::new(TaskControl::default());
        assert!(ctl2.set_paused(true));
        let src_c = src.clone();
        let sz_c = sz_cancel.clone();
        let pc2_c = Arc::clone(&pc2);
        let ctl2_c = Arc::clone(&ctl2);
        let h = std::thread::spawn(move || {
            create(&[src_c], &sz_c, None, PerfProfile::from_mode("hyper"), &pc2_c, &ctl2_c)
        });
        std::thread::sleep(Duration::from_millis(50));
        let t0 = Instant::now();
        ctl2.request_cancel();
        let res = h.join().unwrap();
        assert!(t0.elapsed() < Duration::from_millis(500));
        assert!(res.is_err() && format!("{}", res.unwrap_err()).contains("取消"));
        let _ = fs::remove_dir_all(&root);
    }
}
