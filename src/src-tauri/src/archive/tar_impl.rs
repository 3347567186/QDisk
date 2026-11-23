use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File};
use std::io::{self, BufReader, BufWriter, ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Instant;

use anyhow::{bail, Context, Result};
use bzip2::read::BzDecoder;
use flate2::read::MultiGzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use lzma_rust2::XzReader;

use super::undo::UndoTracker;
use super::util::{
    collect_sources, copy_controlled, ensure_parent, filetime_to_local_parts, resolve_dest,
    safe_join, safe_join_mapped, Budget, ControlledReader, Overwrite, PerfProfile, Progress,
    TaskControl, ThreadPriorityGuard, WorkPacer,
};
use super::{ArchiveInfo, CreateReport, EntryInfo, ExtractReport, Kind};

fn reader(path: &Path, kind: Kind) -> Result<Box<dyn Read>> {
    let f = File::open(path).with_context(|| format!("无法打开 {}", path.display()))?;
    let f = BufReader::new(f);
    Ok(match kind {
        Kind::Tar => Box::new(f),
        Kind::TarGz => Box::new(MultiGzDecoder::new(f)),
        Kind::TarBz2 => Box::new(BzDecoder::new(f)),
        Kind::TarXz => Box::new(XzReader::new(f, true)),
        _ => bail!("不是 TAR 格式"),
    })
}

pub fn list(path: &Path, kind: Kind, _password: Option<&str>) -> Result<ArchiveInfo> {
    let mut ar = tar::Archive::new(reader(path, kind)?);
    let mut entries = Vec::new();
    let mut total_size = 0u64;
    let mut total_packed = 0u64;
    let mut idx = 0usize;
    for item in ar.entries().context("TAR 读取失败")? {
        let entry = match item {
            Ok(e) => e,
            Err(_) => continue,
        };
        let header = entry.header();
        let raw = entry
            .path()
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| format!("file-{idx}"));
        let is_dir = header.entry_type().is_dir();
        let size = entry.size();
        if !is_dir {
            total_size += size;
            total_packed += size;
        }
        let modified = header
            .mtime()
            .ok()
            .and_then(unix_to_local_parts)
            .map(|(y, mo, d, h, mi, s)| format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}"))
            .unwrap_or_else(|| "—".to_string());
        entries.push(EntryInfo {
            index: idx,
            name: raw,
            is_dir,
            size,
            packed: size,
            modified,
            encrypted: false,
            crc: 0,
        });
        idx += 1;
    }
    Ok(ArchiveInfo {
        path: path.display().to_string(),
        format: kind.label().into(),
        entries,
        total_size,
        total_packed,
        encrypted: false,
        solid: false,
        comment: String::new(),
        needs_rar: false,
        rar_ready: true,
    })
}

pub fn list_single(path: &Path, kind: Kind) -> Result<ArchiveInfo> {
    let name = single_name(path);
    let meta = fs::metadata(path).ok();
    let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
    let modified = meta
        .and_then(|m| m.modified().ok())
        .and_then(|t| {
            let dur = t.duration_since(std::time::UNIX_EPOCH).ok()?;
            unix_to_local_parts(dur.as_secs())
        })
        .map(|(y, mo, d, h, mi, s)| format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}"))
        .unwrap_or_else(|| "—".to_string());
    Ok(ArchiveInfo {
        path: path.display().to_string(),
        format: kind.label().into(),
        entries: vec![EntryInfo {
            index: 0,
            name,
            is_dir: false,
            size,
            packed: size,
            modified,
            encrypted: false,
            crc: 0,
        }],
        total_size: size,
        total_packed: size,
        encrypted: false,
        solid: false,
        comment: String::new(),
        needs_rar: false,
        rar_ready: true,
    })
}

fn single_name(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "data".to_string())
}

fn unix_to_local_parts(secs: u64) -> Option<(u16, u8, u8, u8, u8, u8)> {
    let ft = secs.checked_add(11_644_473_600)?.checked_mul(10_000_000)?;
    filetime_to_local_parts(ft)
}

#[allow(clippy::too_many_arguments)]
pub fn extract(
    path: &Path,
    out_dir: &Path,
    kind: Kind,
    selected: &HashSet<usize>,
    _password: Option<&str>,
    policy: Overwrite,
    profile: PerfProfile,
    dir_map: &HashMap<String, String>,
    undo: Option<&Arc<UndoTracker>>,
    progress: &Progress,
    control: &TaskControl,
) -> Result<ExtractReport> {
    let _prio = ThreadPriorityGuard::enter(profile.mode);
    let mut ar = tar::Archive::new(reader(path, kind)?);
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
    let budget = Budget::for_extraction();
    for (idx, item) in ar.entries().context("TAR 读取失败")?.enumerate() {
        // 即使跳过未选中条目，也要先过检查点，确保多 GB 归档部分解压时可随时暂停或取消。
        control.checkpoint(Some(progress))?;
        if !selected.contains(&idx) {
            continue;
        }
        let mut entry = match item {
            Ok(e) => e,
            Err(e) => {
                report.warnings.push(format!("{e}"));
                continue;
            }
        };
        let raw = match entry.path() {
            Ok(p) => p.to_string_lossy().replace('\\', "/"),
            Err(e) => {
                report.warnings.push(format!("{e}"));
                continue;
            }
        };
        progress.set_current(&raw);
        let ty = entry.header().entry_type();
        // 目录不计入 total_files，不能调用 file_done()，避免总文件数溢出。
        if ty.is_dir() {
            match safe_join_mapped(out_dir, &raw, dir_map) {
                Ok(dir) => {
                    if let Some(u) = undo {
                        u.ensure_dir(&dir)?;
                    } else {
                        fs::create_dir_all(&dir)?;
                    }
                    report.dirs += 1;
                }
                Err(e) => {
                    report.skipped += 1;
                    report.warnings.push(format!("{e}"));
                }
            }
            continue;
        }
        if ty.is_symlink() || ty.is_hard_link() {
            report.skipped += 1;
            report.warnings.push(format!("跳过链接: {raw}"));
            progress.file_done();
            continue;
        }
        if !ty.is_file() {
            report.skipped += 1;
            report.warnings.push(format!("跳过非普通文件: {raw}"));
            progress.file_done();
            continue;
        }
        let target = match safe_join_mapped(out_dir, &raw, dir_map) {
            Ok(p) => p,
            Err(e) => {
                report.skipped += 1;
                report.warnings.push(format!("{e}"));
                continue;
            }
        };
        let target = match resolve_dest(target, false, policy)? {
            Some(p) => p,
            None => {
                report.skipped += 1;
                progress.add_bytes(entry.size());
                progress.file_done();
                continue;
            }
        };
        if let Some(u) = undo {
            u.prepare_file_write(&target, policy)?;
        } else {
            ensure_parent(&target)?;
        }
        let f = File::create(&target).with_context(|| format!("无法写入 {}", target.display()))?;
        let mut out = BufWriter::with_capacity(profile.buf_size, f);
        let n = match copy_controlled(
            &mut entry,
            &mut out,
            control,
            profile,
            Some(&budget),
            Some(progress),
            |chunk| progress.add_bytes(chunk),
        )
        .and_then(|n| {
            out.flush()?;
            Ok(n)
        }) {
            Ok(n) => n,
            Err(e) => {
                drop(out);
                let _ = fs::remove_file(&target);
                return Err(e);
            }
        };
        if let Some(u) = undo {
            u.record_created_file(&target);
        }
        report.files += 1;
        report.bytes += n;
        progress.file_done();
    }
    progress.finish();
    Ok(report)
}

pub fn read_entry(path: &Path, kind: Kind, index: usize, limit: u64) -> Result<Vec<u8>> {
    let mut ar = tar::Archive::new(reader(path, kind)?);
    for (i, item) in ar.entries().context("TAR 读取失败")?.enumerate() {
        if i != index {
            continue;
        }
        // 不需要 mut：Read::take 按值消耗 entry。
        let entry = item?;
        if entry.header().entry_type().is_dir() {
            return Ok(Vec::new());
        }
        let mut out = Vec::new();
        entry.take(limit).read_to_end(&mut out)?;
        return Ok(out);
    }
    bail!("条目索引超出范围")
}

#[allow(clippy::too_many_arguments)]
pub fn extract_single(
    path: &Path,
    out_dir: &Path,
    kind: Kind,
    selected: &HashSet<usize>,
    policy: Overwrite,
    profile: PerfProfile,
    undo: Option<&Arc<UndoTracker>>,
    progress: &Progress,
    control: &TaskControl,
) -> Result<ExtractReport> {
    let _prio = ThreadPriorityGuard::enter(profile.mode);
    if !selected.is_empty() && !selected.contains(&0) {
        bail!("没有选中要解压的文件");
    }
    let name = single_name(path);
    let target = safe_join(out_dir, &name)?;
    let Some(target) = resolve_dest(target, false, policy)? else {
        return Ok(ExtractReport {
            files: 0,
            dirs: 0,
            bytes: 0,
            skipped: 1,
            warnings: vec!["目标已存在，按策略跳过".into()],
            out_dir: out_dir.display().to_string(),
            undo_id: None,
            can_undo: false,
            backup_incomplete: false,
            backup_bytes: 0,
        });
    };
    if let Some(u) = undo {
        u.prepare_file_write(&target, policy)?;
    } else {
        ensure_parent(&target)?;
    }
    let mut src = single_reader(path, kind)?;
    let f = File::create(&target)?;
    let mut out = BufWriter::with_capacity(profile.buf_size, f);
    let budget = Budget::for_extraction();
    let n = match copy_controlled(
        &mut src,
        &mut out,
        control,
        profile,
        Some(&budget),
        Some(progress),
        |chunk| progress.add_bytes(chunk),
    )
    .and_then(|n| {
        out.flush()?;
        Ok(n)
    }) {
        Ok(n) => n,
        Err(e) => {
            drop(out);
            let _ = fs::remove_file(&target);
            return Err(e);
        }
    };
    if let Some(u) = undo {
        u.record_created_file(&target);
    }
    progress.file_done();
    progress.finish();
    Ok(ExtractReport {
        files: 1,
        dirs: 0,
        bytes: n,
        skipped: 0,
        warnings: Vec::new(),
        out_dir: out_dir.display().to_string(),
        undo_id: None,
        can_undo: false,
        backup_incomplete: false,
        backup_bytes: 0,
    })
}

pub fn single_reader_pub(path: &Path, kind: Kind) -> Result<Box<dyn Read>> {
    single_reader(path, kind)
}

fn single_reader(path: &Path, kind: Kind) -> Result<Box<dyn Read>> {
    let f = BufReader::new(File::open(path)?);
    Ok(match kind {
        Kind::Gz => Box::new(MultiGzDecoder::new(f)),
        Kind::Bz2 => Box::new(BzDecoder::new(f)),
        Kind::Xz => Box::new(XzReader::new(f, true)),
        _ => bail!("不是单文件压缩格式"),
    })
}

pub fn create_tar(
    sources: &[PathBuf],
    dest: &Path,
    profile: PerfProfile,
    progress: &Arc<Progress>,
    control: &Arc<TaskControl>,
) -> Result<CreateReport> {
    let _prio = ThreadPriorityGuard::enter(profile.mode);
    let started = Instant::now();
    let f = File::create(dest)?;
    let mut builder = tar::Builder::new(BufWriter::with_capacity(profile.buf_size, f));
    let (files, bytes) = append_sources(&mut builder, sources, dest, profile.io_duty_pct, progress, control)?;
    let mut out = builder.into_inner().context("无法完成 TAR 写入")?;
    out.flush()?;
    out.into_inner()
        .map_err(|e| anyhow::anyhow!("{e}"))?
        .sync_all()?;
    Ok(CreateReport {
        path: dest.display().to_string(),
        format: "tar".into(),
        files,
        bytes,
        packed: fs::metadata(dest).map(|m| m.len()).unwrap_or(0),
        elapsed_ms: started.elapsed().as_millis() as u64,
        undo_id: None,
        can_undo: false,
        backup_incomplete: false,
        backup_bytes: 0,
    })
}

/// 多成员并行 GZIP 写入器：将 TAR 流按 1 MiB 切块并行压缩成独立 GZIP 成员（RFC 1952），
/// 再由顺序写入线程重排落盘，兼容标准 gunzip 与 `MultiGzDecoder`。
struct ParallelGzWriter {
    buf: Vec<u8>,
    block_size: usize,
    seq: usize,
    in_tx: Option<mpsc::SyncSender<(usize, Vec<u8>)>>,
    abort: Arc<AtomicBool>,
    failed: Arc<AtomicBool>,
    control: Arc<TaskControl>,
    progress: Arc<Progress>,
    workers: Vec<JoinHandle<()>>,
    writer_handle: Option<JoinHandle<Result<BufWriter<File>>>>,
}

impl ParallelGzWriter {
    fn new(
        out: BufWriter<File>,
        profile: PerfProfile,
        control: Arc<TaskControl>,
        progress: Arc<Progress>,
    ) -> Self {
        let block_size = profile.block_size.clamp(512 * 1024, 2 * 1024 * 1024);
        let threads = profile.threads.max(2);
        let qcap = (threads * 2).max(4);
        let (in_tx, in_rx) = mpsc::sync_channel::<(usize, Vec<u8>)>(qcap);
        let in_rx = Arc::new(Mutex::new(in_rx));
        let (out_tx, out_rx) = mpsc::sync_channel::<(usize, Result<Vec<u8>>)>(qcap);
        let abort = Arc::new(AtomicBool::new(false));
        let failed = Arc::new(AtomicBool::new(false));

        let mut workers = Vec::with_capacity(threads);
        for _ in 0..threads {
            let rx_shared = Arc::clone(&in_rx);
            let tx = out_tx.clone();
            let abort_w = Arc::clone(&abort);
            let failed_w = Arc::clone(&failed);
            let ctl = Arc::clone(&control);
            let prog = Arc::clone(&progress);
            let level = profile.gzip_level.clamp(1, 9);
            let mode = profile.mode;
            let cpu_duty = profile.cpu_duty_pct;
            workers.push(std::thread::spawn(move || {
                let _prio = ThreadPriorityGuard::enter(mode);
                let mut pacer = WorkPacer::new(cpu_duty);
                loop {
                    if abort_w.load(Ordering::Acquire) {
                        break;
                    }
                    let item = {
                        let g = rx_shared.lock().unwrap_or_else(|e| e.into_inner());
                        g.recv()
                    };
                    let Ok((seq, raw)) = item else {
                        break;
                    };
                    if abort_w.load(Ordering::Acquire) {
                        break;
                    }
                    if let Err(e) = ctl.checkpoint(Some(&prog)) {
                        abort_w.store(true, Ordering::SeqCst);
                        failed_w.store(true, Ordering::SeqCst);
                        let _ = tx.send((seq, Err(e)));
                        break;
                    }
                    let step_t0 = pacer.mark_start();
                    let mut gz = GzEncoder::new(Vec::with_capacity(raw.len() / 2 + 64), Compression::new(level));
                    let res = gz.write_all(&raw).and_then(|_| gz.finish()).map_err(Into::into);
                    if res.is_err() {
                        abort_w.store(true, Ordering::SeqCst);
                        failed_w.store(true, Ordering::SeqCst);
                    }
                    if let Err(e) = pacer.finish_step(step_t0, &ctl) {
                        abort_w.store(true, Ordering::SeqCst);
                        failed_w.store(true, Ordering::SeqCst);
                        let _ = tx.send((seq, Err(e)));
                        break;
                    }
                    if tx.send((seq, res)).is_err() {
                        break;
                    }
                }
            }));
        }
        drop(in_rx);
        drop(out_tx);

        let abort_wr = Arc::clone(&abort);
        let failed_wr = Arc::clone(&failed);
        let ctl_wr = Arc::clone(&control);
        let prog_wr = Arc::clone(&progress);
        let writer_handle = std::thread::spawn(move || -> Result<BufWriter<File>> {
            let _prio = ThreadPriorityGuard::enter(profile.mode);
            let mut writer = out;
            let mut pending: BTreeMap<usize, Vec<u8>> = BTreeMap::new();
            let mut expect = 0usize;
            for (seq, res) in &out_rx {
                if ctl_wr.is_cancelled() {
                    abort_wr.store(true, Ordering::SeqCst);
                    failed_wr.store(true, Ordering::SeqCst);
                    return Err(anyhow::anyhow!("操作已取消"));
                }
                match res {
                    Ok(compressed) => {
                        pending.insert(seq, compressed);
                    }
                    Err(e) => {
                        abort_wr.store(true, Ordering::SeqCst);
                        failed_wr.store(true, Ordering::SeqCst);
                        return Err(e);
                    }
                }
                while let Some(chunk) = pending.remove(&expect) {
                    if let Err(e) = ctl_wr.checkpoint(Some(&prog_wr)) {
                        abort_wr.store(true, Ordering::SeqCst);
                        failed_wr.store(true, Ordering::SeqCst);
                        return Err(e);
                    }
                    if let Err(e) = writer.write_all(&chunk) {
                        abort_wr.store(true, Ordering::SeqCst);
                        failed_wr.store(true, Ordering::SeqCst);
                        return Err(e.into());
                    }
                    expect += 1;
                }
            }
            writer.flush()?;
            Ok(writer)
        });

        Self {
            buf: Vec::with_capacity(block_size),
            block_size,
            seq: 0,
            in_tx: Some(in_tx),
            abort,
            failed,
            control,
            progress,
            workers,
            writer_handle: Some(writer_handle),
        }
    }

    fn flush_block(&mut self) -> io::Result<()> {
        if self.buf.is_empty() {
            return Ok(());
        }
        // 使用 ErrorKind::Other 而非 Interrupted，避免 std::io::Write::write_all 无限重试。
        self.control
            .checkpoint(Some(&self.progress))
            .map_err(|_| io::Error::new(ErrorKind::Other, "操作已取消"))?;
        if self.failed.load(Ordering::Acquire) {
            return Err(io::Error::new(ErrorKind::BrokenPipe, "GZIP 写入线程已中止"));
        }
        let block = std::mem::replace(&mut self.buf, Vec::with_capacity(self.block_size));
        let seq = self.seq;
        self.seq += 1;
        let Some(tx) = self.in_tx.as_ref() else {
            return Err(io::Error::new(ErrorKind::BrokenPipe, "GZIP 通道已关闭"));
        };
        tx.send((seq, block))
            .map_err(|_| io::Error::new(ErrorKind::BrokenPipe, "GZIP 工作线程已结束"))
    }

    fn finish(mut self) -> Result<BufWriter<File>> {
        if self.seq == 0 && self.buf.is_empty() {
            if let Some(tx) = self.in_tx.as_ref() {
                let _ = tx.send((0, Vec::new()));
                self.seq = 1;
            }
        } else if !self.buf.is_empty() {
            self.flush_block()?;
        }
        self.in_tx.take();
        for w in self.workers.drain(..) {
            let _ = w.join();
        }
        if let Some(wh) = self.writer_handle.take() {
            let res = wh.join().unwrap_or_else(|_| Err(anyhow::anyhow!("GZIP 写入线程异常")));
            if self.control.is_cancelled() {
                bail!("操作已取消");
            }
            return res;
        }
        bail!("GZIP 写入句柄缺失")
    }
}

impl Write for ParallelGzWriter {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        self.control
            .checkpoint(Some(&self.progress))
            .map_err(|_| io::Error::new(ErrorKind::Other, "操作已取消"))?;
        if self.failed.load(Ordering::Acquire) {
            return Err(io::Error::new(ErrorKind::BrokenPipe, "GZIP 并行压缩失败"));
        }
        let mut offset = 0usize;
        while offset < data.len() {
            let take = (self.block_size - self.buf.len()).min(data.len() - offset);
            self.buf.extend_from_slice(&data[offset..offset + take]);
            offset += take;
            if self.buf.len() >= self.block_size {
                self.flush_block()?;
            }
        }
        Ok(data.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Drop for ParallelGzWriter {
    fn drop(&mut self) {
        if self.writer_handle.is_none() && self.workers.is_empty() {
            return;
        }
        self.abort.store(true, Ordering::SeqCst);
        // 非正常退出路径若与暂停竞态，主动唤醒可能停在 checkpoint 的写线程，杜绝析构死锁。
        self.control.request_cancel();
        self.in_tx.take();
        for w in self.workers.drain(..) {
            let _ = w.join();
        }
        if let Some(wh) = self.writer_handle.take() {
            let _ = wh.join();
        }
    }
}

pub fn create_tgz(
    sources: &[PathBuf],
    dest: &Path,
    profile: PerfProfile,
    progress: &Arc<Progress>,
    control: &Arc<TaskControl>,
) -> Result<CreateReport> {
    let _prio = ThreadPriorityGuard::enter(profile.mode);
    let started = Instant::now();
    let f = File::create(dest)?;
    let out_buf = BufWriter::with_capacity(profile.buf_size, f);

    if profile.threads <= 1 {
        let gz = GzEncoder::new(out_buf, Compression::new(profile.gzip_level.clamp(1, 9)));
        let mut builder = tar::Builder::new(gz);
        let (files, bytes) = append_sources(&mut builder, sources, dest, profile.io_duty_pct, progress, control)?;
        let gz = match builder.into_inner() {
            Ok(g) => g,
            Err(e) => {
                if control.is_cancelled() {
                    bail!("操作已取消");
                }
                return Err(anyhow::Error::new(e)).context("无法完成 TAR.GZ 写入");
            }
        };
        let mut out = match gz.finish() {
            Ok(o) => o,
            Err(e) => {
                if control.is_cancelled() {
                    bail!("操作已取消");
                }
                return Err(anyhow::Error::new(e)).context("无法完成 GZIP 写入");
            }
        };
        out.flush()?;
        out.into_inner()
            .map_err(|e| anyhow::anyhow!("{e}"))?
            .sync_all()?;
        return Ok(CreateReport {
            path: dest.display().to_string(),
            format: "tgz".into(),
            files,
            bytes,
            packed: fs::metadata(dest).map(|m| m.len()).unwrap_or(0),
            elapsed_ms: started.elapsed().as_millis() as u64,
            undo_id: None,
            can_undo: false,
            backup_incomplete: false,
            backup_bytes: 0,
        });
    }

    let pgz = ParallelGzWriter::new(out_buf, profile, control.clone(), progress.clone());
    let mut builder = tar::Builder::new(pgz);
    // 并行 GZIP 由 ParallelGzWriter 工作线程按 cpu_duty_pct 控速，reader 侧直通 100 避免双重节流。
    let (files, bytes) = append_sources(&mut builder, sources, dest, 100, progress, control)?;
    let pgz = match builder.into_inner() {
        Ok(g) => g,
        Err(e) => {
            if control.is_cancelled() {
                bail!("操作已取消");
            }
            return Err(anyhow::Error::new(e)).context("无法完成 TAR.GZ 写入");
        }
    };
    let mut out = pgz.finish().context("无法完成并行 GZIP 写入")?;
    out.flush()?;
    out.into_inner()
        .map_err(|e| anyhow::anyhow!("{e}"))?
        .sync_all()?;
    Ok(CreateReport {
        path: dest.display().to_string(),
        format: "tgz".into(),
        files,
        bytes,
        packed: fs::metadata(dest).map(|m| m.len()).unwrap_or(0),
        elapsed_ms: started.elapsed().as_millis() as u64,
        undo_id: None,
        can_undo: false,
        backup_incomplete: false,
        backup_bytes: 0,
    })
}

fn append_sources<W: Write>(
    builder: &mut tar::Builder<W>,
    sources: &[PathBuf],
    dest: &Path,
    reader_duty_pct: u8,
    progress: &Arc<Progress>,
    control: &Arc<TaskControl>,
) -> Result<(u64, u64)> {
    let (mut items, total) = collect_sources(sources, Some(dest), Some(control))?;
    items.retain(|i| i.path != dest);
    progress.set_totals(items.iter().filter(|i| !i.is_dir).count() as u64, total);
    progress.phase("compress");
    let mut files = 0u64;
    let mut bytes = 0u64;
    for item in &items {
        control.checkpoint(Some(progress))?;
        progress.set_current(&item.name);
        if item.is_dir {
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(tar::EntryType::Directory);
            header.set_size(0);
            header.set_mode(0o755);
            header.set_cksum();
            builder
                .append_data(&mut header, &item.name, io::empty())
                .with_context(|| format!("无法写入 {}", item.name))?;
            continue;
        }
        let file = File::open(&item.path)
            .with_context(|| format!("无法读取 {}", item.path.display()))?;
        let meta = file.metadata()?;
        let len = meta.len();
        let mut header = tar::Header::new_gnu();
        header.set_metadata(&meta);
        header.set_size(len);
        header.set_cksum();
        let reader = ControlledReader::new(
            file.take(len),
            control.clone(),
            progress.clone(),
            reader_duty_pct,
        );
        if let Err(e) = builder.append_data(&mut header, &item.name, reader) {
            if control.is_cancelled() {
                bail!("操作已取消");
            }
            return Err(anyhow::Error::new(e)).with_context(|| format!("无法写入 {}", item.name));
        }
        bytes += len;
        files += 1;
        progress.file_done();
    }
    Ok((files, bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parallel_tgz_multimember_roundtrip() {
        let root = PathBuf::from("D:\\Builds\\tidy-tar-tests")
            .join(format!("tgz_{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let src_dir = root.join("src");
        fs::create_dir_all(src_dir.join("子目录")).unwrap();

        let small = b"hello tar.gz multimember!".to_vec();
        // 3 MiB 数据触发多成员（>= 3 个 1 MiB GZIP 成员）
        let mut big = Vec::with_capacity(3 * 1024 * 1024);
        for i in 0..(3 * 1024 * 1024 / 32) {
            big.extend_from_slice(format!("tgz-block-{i:08}-aaaaaaaaaaaa\n").as_bytes());
        }
        fs::write(src_dir.join("子目录/hello.txt"), &small).unwrap();
        fs::write(src_dir.join("stream.bin"), &big).unwrap();

        let tgz = root.join("out.tar.gz");
        let p_c = Arc::new(Progress::detached());
        let ctl_c = Arc::new(TaskControl::default());
        let prof = PerfProfile::from_mode("hyper");
        let crep = create_tgz(&[src_dir.clone()], &tgz, prof, &p_c, &ctl_c).unwrap();
        assert_eq!(crep.files, 2);

        let info = list(&tgz, Kind::TarGz, None).unwrap();
        let selected: HashSet<usize> = info
            .entries
            .iter()
            .filter(|e| !e.is_dir)
            .map(|e| e.index)
            .collect();
        assert_eq!(selected.len(), 2);

        let out = root.join("extracted");
        fs::create_dir_all(&out).unwrap();
        let p_e = Arc::new(Progress::detached());
        let ctl_e = Arc::new(TaskControl::default());
        let empty_map = HashMap::new();
        let erep = extract(
            &tgz,
            &out,
            Kind::TarGz,
            &selected,
            None,
            Overwrite::Overwrite,
            prof,
            &empty_map,
            None,
            &p_e,
            &ctl_e,
        )
        .unwrap();
        assert_eq!(erep.files, 2);
        assert_eq!(p_e.files_count(), erep.files);
        assert_eq!(fs::read(out.join("src/子目录/hello.txt")).unwrap(), small);
        assert_eq!(fs::read(out.join("src/stream.bin")).unwrap(), big);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn parallel_tgz_pause_cancel_and_skip_cancel() {
        use std::time::Duration;

        let root = PathBuf::from("D:\\Builds\\tidy-tar-tests")
            .join(format!("tgz_ctl_{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let src_dir = root.join("src");
        fs::create_dir_all(&src_dir).unwrap();
        let blob = vec![b'Z'; 3 * 1024 * 1024];
        fs::write(src_dir.join("a.bin"), &blob).unwrap();
        fs::write(src_dir.join("b.bin"), b"tail").unwrap();

        // A: 暂停态取消 ParallelGzWriter 必须 <500ms 干净退出且无死锁
        let tgz_cancel = root.join("cancel.tar.gz");
        let p1 = Arc::new(Progress::detached());
        let ctl1 = Arc::new(TaskControl::default());
        assert!(ctl1.set_paused(true));
        let src_c = src_dir.clone();
        let dst_c = tgz_cancel.clone();
        let p1_c = Arc::clone(&p1);
        let ctl1_c = Arc::clone(&ctl1);
        let h = std::thread::spawn(move || {
            create_tgz(&[src_c], &dst_c, PerfProfile::from_mode("hyper"), &p1_c, &ctl1_c)
        });
        std::thread::sleep(Duration::from_millis(50));
        let t0 = Instant::now();
        ctl1.request_cancel();
        let res = h.join().unwrap();
        assert!(t0.elapsed() < Duration::from_millis(500));
        assert!(res.is_err() && format!("{}", res.unwrap_err()).contains("取消"));

        // B: 正常创建后，仅选最后一个条目解压且在首条目跳过前取消 -> 必须立即返回取消
        let tgz_ok = root.join("ok.tar.gz");
        let p2 = Arc::new(Progress::detached());
        let ctl2 = Arc::new(TaskControl::default());
        create_tgz(&[src_dir], &tgz_ok, PerfProfile::from_mode("hyper"), &p2, &ctl2).unwrap();
        let info = list(&tgz_ok, Kind::TarGz, None).unwrap();
        let last_idx = info.entries.last().unwrap().index;
        let mut only_last = HashSet::new();
        only_last.insert(last_idx);
        let out = root.join("out");
        fs::create_dir_all(&out).unwrap();
        let p3 = Arc::new(Progress::detached());
        let ctl3 = Arc::new(TaskControl::default());
        ctl3.request_cancel();
        let empty_map = HashMap::new();
        let res_skip = extract(
            &tgz_ok,
            &out,
            Kind::TarGz,
            &only_last,
            None,
            Overwrite::Overwrite,
            PerfProfile::from_mode("hyper"),
            &empty_map,
            None,
            &p3,
            &ctl3,
        );
        assert!(res_skip.is_err() && format!("{}", res_skip.unwrap_err()).contains("取消"));
        let _ = fs::remove_dir_all(&root);
    }
}
