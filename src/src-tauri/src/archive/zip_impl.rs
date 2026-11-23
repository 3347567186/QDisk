use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Instant;

use anyhow::{bail, Context, Result};
use flate2::{Compress, Compression, Crc, FlushCompress, Status};
use zip::write::SimpleFileOptions;
use zip::{AesMode, CompressionMethod, ZipArchive, ZipWriter};

use super::undo::UndoTracker;
use super::util::{
    collect_sources, copy_controlled, copy_controlled_abortable, dos_datetime, ensure_parent,
    is_incompressible_ext, resolve_dest, safe_join_mapped, zip_datetime, Budget, Overwrite,
    PerfProfile, Progress, SourceItem, TaskControl, ThreadPriorityGuard, WorkPacer,
};
use super::{CreateReport, ExtractReport};

const LARGE_FILE_THRESHOLD: u64 = 2 * 1024 * 1024;
const SMALL_BATCH_ITEMS: usize = 16;

pub fn open(path: &Path) -> Result<ZipArchive<BufReader<File>>> {
    let f = File::open(path).with_context(|| format!("无法打开 {}", path.display()))?;
    ZipArchive::new(BufReader::new(f)).with_context(|| "ZIP 压缩包损坏或不是有效 ZIP")
}

pub fn create(
    sources: &[std::path::PathBuf],
    dest: &Path,
    password: Option<&str>,
    profile: PerfProfile,
    progress: &Arc<Progress>,
    control: &Arc<TaskControl>,
) -> Result<CreateReport> {
    let _prio = ThreadPriorityGuard::enter(profile.mode);
    let started = Instant::now();
    let (mut items, total) = collect_sources(sources, Some(dest), Some(control))?;
    items.retain(|i| i.path != dest);
    let file_count = items.iter().filter(|i| !i.is_dir).count() as u64;
    progress.set_totals(file_count, total);
    progress.phase("compress");

    let pw = password.filter(|p| !p.is_empty());
    if pw.is_some() || profile.threads <= 1 {
        return create_sequential(&items, dest, pw, profile, progress, control, started);
    }
    create_parallel(&items, dest, profile, progress, control, started)
}

fn create_sequential(
    items: &[SourceItem],
    dest: &Path,
    password: Option<&str>,
    profile: PerfProfile,
    progress: &Arc<Progress>,
    control: &Arc<TaskControl>,
    started: Instant,
) -> Result<CreateReport> {
    let file = File::create(dest).with_context(|| format!("无法创建 {}", dest.display()))?;
    let mut writer = ZipWriter::new(BufWriter::with_capacity(profile.buf_size, file));
    let mut bytes = 0u64;
    let mut files = 0u64;

    for item in items {
        control.checkpoint(Some(progress))?;
        let use_store =
            item.is_dir || item.size == 0 || (profile.smart_store && is_incompressible_ext(&item.path));
        let mut opts = SimpleFileOptions::default()
            .compression_method(if use_store {
                CompressionMethod::Stored
            } else {
                CompressionMethod::Deflated
            })
            .unix_permissions(if item.is_dir { 0o755 } else { 0o644 });
        if !use_store {
            opts = opts.compression_level(Some((profile.zip_level as i64).clamp(1, 9)));
        }
        if item.size >= u32::MAX as u64 {
            opts = opts.large_file(true);
        }
        if let Some(dt) = zip_datetime(&item.path) {
            opts = opts.last_modified_time(dt);
        }
        if let Some(pw) = password.filter(|_| !item.is_dir) {
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
        let n = copy_controlled(
            &mut src,
            &mut writer,
            control,
            profile,
            None,
            Some(progress),
            |chunk| progress.add_bytes(chunk),
        )?;
        bytes += n;
        files += 1;
        progress.file_done();
    }

    let out = writer.finish().context("无法完成 ZIP 写入")?;
    let mut inner = out.into_inner().map_err(|e| anyhow::anyhow!("{e}"))?;
    inner.flush()?;
    inner.sync_all()?;
    Ok(CreateReport {
        path: dest.display().to_string(),
        format: "zip".into(),
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

struct CdEntry {
    name: String,
    is_dir: bool,
    method: u16,
    dos_time: u16,
    dos_date: u16,
    crc: u32,
    comp_size: u64,
    uncomp_size: u64,
    lfh_offset: u64,
}

struct ParallelZipWriter {
    writer: BufWriter<File>,
    entries: Vec<CdEntry>,
}

impl ParallelZipWriter {
    fn new(dest: &Path, buf_size: usize) -> Result<Self> {
        let file = File::create(dest).with_context(|| format!("无法创建 {}", dest.display()))?;
        Ok(Self {
            writer: BufWriter::with_capacity(buf_size, file),
            entries: Vec::new(),
        })
    }

    fn write_dir(&mut self, name: &str, dos_time: u16, dos_date: u16) -> Result<()> {
        let dir_name = if name.ends_with('/') {
            name.to_string()
        } else {
            format!("{name}/")
        };
        if dir_name.len() > u16::MAX as usize {
            bail!("目录名过长: {dir_name}");
        }
        let lfh_offset = self.writer.stream_position()?;
        write_lfh_header(
            &mut self.writer,
            20,
            0x0800,
            0,
            dos_time,
            dos_date,
            0,
            0,
            0,
            dir_name.as_bytes(),
            &[],
        )?;
        self.entries.push(CdEntry {
            name: dir_name,
            is_dir: true,
            method: 0,
            dos_time,
            dos_date,
            crc: 0,
            comp_size: 0,
            uncomp_size: 0,
            lfh_offset,
        });
        Ok(())
    }

    fn write_prepared_file(
        &mut self,
        name: &str,
        dos_time: u16,
        dos_date: u16,
        method: u16,
        crc: u32,
        uncomp_size: u64,
        payload: &[u8],
    ) -> Result<()> {
        if name.len() > u16::MAX as usize {
            bail!("文件名过长: {name}");
        }
        let comp_size = payload.len() as u64;
        let need64 = comp_size >= 0xFFFF_FFFF || uncomp_size >= 0xFFFF_FFFF;
        let extra = if need64 {
            zip64_extra(Some(uncomp_size), Some(comp_size), None)
        } else {
            Vec::new()
        };
        let lfh_offset = self.writer.stream_position()?;
        write_lfh_header(
            &mut self.writer,
            if need64 { 45 } else { 20 },
            0x0800,
            method,
            dos_time,
            dos_date,
            crc,
            if need64 { 0xFFFF_FFFF } else { comp_size as u32 },
            if need64 { 0xFFFF_FFFF } else { uncomp_size as u32 },
            name.as_bytes(),
            &extra,
        )?;
        if !payload.is_empty() {
            self.writer.write_all(payload)?;
        }
        self.entries.push(CdEntry {
            name: name.to_string(),
            is_dir: false,
            method,
            dos_time,
            dos_date,
            crc,
            comp_size,
            uncomp_size,
            lfh_offset,
        });
        Ok(())
    }

    fn write_large_stored(
        &mut self,
        item: &SourceItem,
        dos_time: u16,
        dos_date: u16,
        profile: PerfProfile,
        progress: &Arc<Progress>,
        control: &Arc<TaskControl>,
    ) -> Result<u64> {
        let lfh_offset = self.writer.stream_position()?;
        let placeholder_extra = zip64_extra(Some(0), Some(0), None);
        write_lfh_header(
            &mut self.writer,
            45,
            0x0800,
            0,
            dos_time,
            dos_date,
            0,
            0xFFFF_FFFF,
            0xFFFF_FFFF,
            item.name.as_bytes(),
            &placeholder_extra,
        )?;
        let mut src = File::open(&item.path)
            .with_context(|| format!("无法读取 {}", item.path.display()))?;
        let mut buf = vec![0u8; profile.buf_size.clamp(64 * 1024, 2 * 1024 * 1024)];
        let mut crc = Crc::new();
        let mut total = 0u64;
        let mut pacer = WorkPacer::new(profile.io_duty_pct);
        loop {
            control.checkpoint(Some(progress))?;
            let step_t0 = pacer.mark_start();
            let n = src.read(&mut buf)?;
            if n == 0 {
                break;
            }
            crc.update(&buf[..n]);
            self.writer.write_all(&buf[..n])?;
            total += n as u64;
            progress.add_bytes(n as u64);
            pacer.finish_step(step_t0, control)?;
        }
        let sum = crc.sum();
        patch_zip64_lfh(
            &mut self.writer,
            lfh_offset,
            item.name.len(),
            0,
            sum,
            total,
            total,
        )?;
        self.entries.push(CdEntry {
            name: item.name.clone(),
            is_dir: false,
            method: 0,
            dos_time,
            dos_date,
            crc: sum,
            comp_size: total,
            uncomp_size: total,
            lfh_offset,
        });
        Ok(total)
    }

    fn write_large_deflate_parallel(
        &mut self,
        item: &SourceItem,
        dos_time: u16,
        dos_date: u16,
        profile: PerfProfile,
        progress: &Arc<Progress>,
        control: &Arc<TaskControl>,
    ) -> Result<u64> {
        let lfh_offset = self.writer.stream_position()?;
        let placeholder_extra = zip64_extra(Some(0), Some(0), None);
        write_lfh_header(
            &mut self.writer,
            45,
            0x0800,
            8,
            dos_time,
            dos_date,
            0,
            0xFFFF_FFFF,
            0xFFFF_FFFF,
            item.name.as_bytes(),
            &placeholder_extra,
        )?;

        let block_size = profile.block_size.clamp(512 * 1024, 2 * 1024 * 1024);
        let threads = profile.threads.max(2);
        let qcap = (threads * 2).max(4);
        let (in_tx, in_rx) = mpsc::sync_channel::<(usize, Vec<u8>, bool)>(qcap);
        let in_rx = Arc::new(Mutex::new(in_rx));
        let (out_tx, out_rx) = mpsc::sync_channel::<(usize, u64, Result<Vec<u8>>)>(qcap);
        let abort = AtomicBool::new(false);

        let mut uncomp_bytes = 0u64;
        let mut comp_bytes = 0u64;
        let mut crc_sum = 0u32;
        let mut write_err: Option<anyhow::Error> = None;

        std::thread::scope(|scope| {
            let reader_ctl = control.clone();
            let reader_prog = progress.clone();
            let abort_ref = &abort;
            let src_path = &item.path;
            let reader_handle = scope.spawn(move || -> Result<(u32, u64)> {
                let _prio = ThreadPriorityGuard::enter(profile.mode);
                let mut f = File::open(src_path)
                    .with_context(|| format!("无法读取 {}", src_path.display()))?;
                let mut crc = Crc::new();
                let mut total = 0u64;
                let mut seq = 0usize;
                let mut current = read_exact_or_eof(&mut f, block_size, &reader_ctl, &reader_prog, abort_ref)?;
                while !current.is_empty() {
                    if abort_ref.load(Ordering::Acquire) {
                        bail!("并行压缩已中止");
                    }
                    reader_ctl.checkpoint(Some(&reader_prog))?;
                    crc.update(&current);
                    total += current.len() as u64;
                    let next = read_exact_or_eof(&mut f, block_size, &reader_ctl, &reader_prog, abort_ref)?;
                    let is_last = next.is_empty();
                    if in_tx.send((seq, current, is_last)).is_err() {
                        bail!("并行压缩通道已关闭");
                    }
                    seq += 1;
                    current = next;
                }
                drop(in_tx);
                Ok((crc.sum(), total))
            });

            let mut worker_handles = Vec::with_capacity(threads);
            for _ in 0..threads {
                let rx_shared = Arc::clone(&in_rx);
                let tx = out_tx.clone();
                let w_ctl = control.clone();
                let w_prog = progress.clone();
                let abort_ref = &abort;
                let level = profile.zip_level;
                let cpu_duty = profile.cpu_duty_pct;
                worker_handles.push(scope.spawn(move || {
                    let _prio = ThreadPriorityGuard::enter(profile.mode);
                    let mut pacer = WorkPacer::new(cpu_duty);
                    loop {
                        if abort_ref.load(Ordering::Acquire) {
                            break;
                        }
                        let msg = {
                            let guard = rx_shared.lock().unwrap_or_else(|e| e.into_inner());
                            guard.recv()
                        };
                        let Ok((seq, chunk, is_last)) = msg else {
                            break;
                        };
                        if abort_ref.load(Ordering::Acquire) {
                            break;
                        }
                        if let Err(e) = w_ctl.checkpoint(Some(&w_prog)) {
                            abort_ref.store(true, Ordering::SeqCst);
                            let _ = tx.send((seq, 0, Err(e)));
                            break;
                        }
                        let raw_len = chunk.len() as u64;
                        let step_t0 = pacer.mark_start();
                        let res = compress_deflate_block(&chunk, level, is_last);
                        if res.is_err() {
                            abort_ref.store(true, Ordering::SeqCst);
                        }
                        if let Err(e) = pacer.finish_step(step_t0, &w_ctl) {
                            abort_ref.store(true, Ordering::SeqCst);
                            let _ = tx.send((seq, 0, Err(e)));
                            break;
                        }
                        if tx.send((seq, raw_len, res)).is_err() {
                            break;
                        }
                    }
                }));
            }
            // 先丢弃主线程自身的 receiver/sender 克隆，防止错误退出或 EOF 时 channel 挂死。
            drop(in_rx);
            drop(out_tx);

            let mut pending: BTreeMap<usize, (u64, Vec<u8>)> = BTreeMap::new();
            let mut next_seq = 0usize;
            for (seq, raw_len, res) in &out_rx {
                if control.is_cancelled() {
                    abort.store(true, Ordering::SeqCst);
                    write_err = Some(anyhow::anyhow!("操作已取消"));
                    break;
                }
                match res {
                    Ok(buf) => {
                        pending.insert(seq, (raw_len, buf));
                    }
                    Err(e) => {
                        abort.store(true, Ordering::SeqCst);
                        write_err = Some(e);
                        break;
                    }
                }
                while let Some((raw_sz, buf)) = pending.remove(&next_seq) {
                    if let Err(e) = control.checkpoint(Some(progress)) {
                        abort.store(true, Ordering::SeqCst);
                        write_err = Some(e);
                        break;
                    }
                    if let Err(e) = self.writer.write_all(&buf) {
                        abort.store(true, Ordering::SeqCst);
                        write_err = Some(e.into());
                        break;
                    }
                    comp_bytes += buf.len() as u64;
                    progress.add_bytes(raw_sz);
                    next_seq += 1;
                }
                if write_err.is_some() {
                    break;
                }
            }
            drop(out_rx);

            match reader_handle.join() {
                Ok(Ok((crc, total))) => {
                    crc_sum = crc;
                    uncomp_bytes = total;
                }
                Ok(Err(e)) => {
                    abort.store(true, Ordering::SeqCst);
                    if write_err.is_none() {
                        write_err = Some(e);
                    }
                }
                Err(_) => {
                    abort.store(true, Ordering::SeqCst);
                    if write_err.is_none() {
                        write_err = Some(anyhow::anyhow!("读取线程异常"));
                    }
                }
            }
            for h in worker_handles {
                let _ = h.join();
            }
        });

        if let Some(e) = write_err {
            if control.is_cancelled() {
                bail!("操作已取消");
            }
            return Err(e);
        }
        control.checkpoint(Some(progress))?;

        let method = if uncomp_bytes == 0 { 0u16 } else { 8u16 };
        if uncomp_bytes == 0 {
            comp_bytes = 0;
        }
        patch_zip64_lfh(
            &mut self.writer,
            lfh_offset,
            item.name.len(),
            method,
            crc_sum,
            comp_bytes,
            uncomp_bytes,
        )?;
        self.entries.push(CdEntry {
            name: item.name.clone(),
            is_dir: false,
            method,
            dos_time,
            dos_date,
            crc: crc_sum,
            comp_size: comp_bytes,
            uncomp_size: uncomp_bytes,
            lfh_offset,
        });
        Ok(uncomp_bytes)
    }

    fn finish(mut self) -> Result<()> {
        let cd_offset = self.writer.stream_position()?;
        for e in &self.entries {
            let need64 = e.comp_size >= 0xFFFF_FFFF
                || e.uncomp_size >= 0xFFFF_FFFF
                || e.lfh_offset >= 0xFFFF_FFFF;
            let extra = if need64 {
                zip64_extra(
                    (e.uncomp_size >= 0xFFFF_FFFF).then_some(e.uncomp_size),
                    (e.comp_size >= 0xFFFF_FFFF).then_some(e.comp_size),
                    (e.lfh_offset >= 0xFFFF_FFFF).then_some(e.lfh_offset),
                )
            } else {
                Vec::new()
            };
            let ver_needed = if need64 { 45u16 } else { 20u16 };
            let ext_attr = if e.is_dir {
                (0o040755u32 << 16) | 0x10
            } else {
                0o100644u32 << 16
            };
            let name_bytes = e.name.as_bytes();
            // Central directory file header (46 bytes + name + extra)
            write_u32(&mut self.writer, 0x0201_4b50)?;
            write_u16(&mut self.writer, (3u16 << 8) | 45u16)?;
            write_u16(&mut self.writer, ver_needed)?;
            write_u16(&mut self.writer, 0x0800)?;
            write_u16(&mut self.writer, e.method)?;
            write_u16(&mut self.writer, e.dos_time)?;
            write_u16(&mut self.writer, e.dos_date)?;
            write_u32(&mut self.writer, e.crc)?;
            write_u32(
                &mut self.writer,
                if e.comp_size >= 0xFFFF_FFFF {
                    0xFFFF_FFFF
                } else {
                    e.comp_size as u32
                },
            )?;
            write_u32(
                &mut self.writer,
                if e.uncomp_size >= 0xFFFF_FFFF {
                    0xFFFF_FFFF
                } else {
                    e.uncomp_size as u32
                },
            )?;
            write_u16(&mut self.writer, name_bytes.len() as u16)?;
            write_u16(&mut self.writer, extra.len() as u16)?;
            write_u16(&mut self.writer, 0)?; // comment len
            write_u16(&mut self.writer, 0)?; // disk start
            write_u16(&mut self.writer, 0)?; // internal attr
            write_u32(&mut self.writer, ext_attr)?;
            write_u32(
                &mut self.writer,
                if e.lfh_offset >= 0xFFFF_FFFF {
                    0xFFFF_FFFF
                } else {
                    e.lfh_offset as u32
                },
            )?;
            self.writer.write_all(name_bytes)?;
            if !extra.is_empty() {
                self.writer.write_all(&extra)?;
            }
        }
        let cd_end = self.writer.stream_position()?;
        let cd_size = cd_end - cd_offset;
        let count = self.entries.len() as u64;

        let need64_eocd = count >= 0xFFFF || cd_size >= 0xFFFF_FFFF || cd_offset >= 0xFFFF_FFFF;
        if need64_eocd {
            let z64_offset = cd_end;
            write_u32(&mut self.writer, 0x0606_4b50)?;
            write_u64(&mut self.writer, 44)?; // fixed body size
            write_u16(&mut self.writer, (3u16 << 8) | 45u16)?;
            write_u16(&mut self.writer, 45)?;
            write_u32(&mut self.writer, 0)?;
            write_u32(&mut self.writer, 0)?;
            write_u64(&mut self.writer, count)?;
            write_u64(&mut self.writer, count)?;
            write_u64(&mut self.writer, cd_size)?;
            write_u64(&mut self.writer, cd_offset)?;

            write_u32(&mut self.writer, 0x0706_4b50)?;
            write_u32(&mut self.writer, 0)?;
            write_u64(&mut self.writer, z64_offset)?;
            write_u32(&mut self.writer, 1)?;
        }

        write_u32(&mut self.writer, 0x0605_4b50)?;
        write_u16(&mut self.writer, 0)?;
        write_u16(&mut self.writer, 0)?;
        write_u16(&mut self.writer, count.min(0xFFFF) as u16)?;
        write_u16(&mut self.writer, count.min(0xFFFF) as u16)?;
        write_u32(&mut self.writer, cd_size.min(0xFFFF_FFFF) as u32)?;
        write_u32(&mut self.writer, cd_offset.min(0xFFFF_FFFF) as u32)?;
        write_u16(&mut self.writer, 0)?;

        self.writer.flush()?;
        self.writer
            .into_inner()
            .map_err(|e| anyhow::anyhow!("{e}"))?
            .sync_all()?;
        Ok(())
    }
}

fn read_exact_or_eof(
    file: &mut File,
    cap: usize,
    control: &TaskControl,
    progress: &Progress,
    abort: &AtomicBool,
) -> Result<Vec<u8>> {
    let mut buf = vec![0u8; cap];
    let mut filled = 0usize;
    while filled < cap {
        if abort.load(Ordering::Acquire) {
            bail!("并行压缩已中止");
        }
        control.checkpoint(Some(progress))?;
        let step = (cap - filled).min(256 * 1024);
        let n = file.read(&mut buf[filled..filled + step])?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    buf.truncate(filled);
    Ok(buf)
}

fn compress_deflate_block(chunk: &[u8], level: u32, is_last: bool) -> Result<Vec<u8>> {
    let mut comp = Compress::new(Compression::new(level.clamp(1, 9)), false);
    // 预留稍高于源块尺寸的容量，即便遇到高熵随机不可压数据也能一次完成避免多次扩容。
    let mut out = Vec::with_capacity(chunk.len() + 16 * 1024);
    let mut offset = 0usize;
    let flush = if is_last {
        FlushCompress::Finish
    } else {
        FlushCompress::Sync
    };

    loop {
        if out.capacity() - out.len() < 32 * 1024 {
            out.reserve(64 * 1024);
        }
        let cap_before = out.capacity();
        let prev_in = comp.total_in();
        let status = comp
            .compress_vec(&chunk[offset..], &mut out, flush)
            .map_err(|e| anyhow::anyhow!("Deflate 压缩失败: {e}"))?;
        offset += (comp.total_in() - prev_in) as usize;

        if is_last {
            if matches!(status, Status::StreamEnd) {
                break;
            }
        } else if offset >= chunk.len() && out.len() < cap_before && matches!(status, Status::Ok) {
            break;
        }
    }
    Ok(out)
}

struct PreparedSmall {
    name: String,
    dos_time: u16,
    dos_date: u16,
    method: u16,
    crc: u32,
    uncomp_size: u64,
    payload: Vec<u8>,
}

fn prepare_small_item(item: &SourceItem, profile: PerfProfile) -> Result<PreparedSmall> {
    let (dos_time, dos_date) = dos_datetime(&item.path);
    let raw = fs::read(&item.path).with_context(|| format!("无法读取 {}", item.path.display()))?;
    let mut crc = Crc::new();
    crc.update(&raw);
    let sum = crc.sum();
    let uncomp_size = raw.len() as u64;

    if raw.is_empty() || (profile.smart_store && is_incompressible_ext(&item.path)) {
        return Ok(PreparedSmall {
            name: item.name.clone(),
            dos_time,
            dos_date,
            method: 0,
            crc: sum,
            uncomp_size,
            payload: raw,
        });
    }

    let compressed = compress_deflate_block(&raw, profile.zip_level, true)?;
    if compressed.len() < raw.len() {
        Ok(PreparedSmall {
            name: item.name.clone(),
            dos_time,
            dos_date,
            method: 8,
            crc: sum,
            uncomp_size,
            payload: compressed,
        })
    } else {
        Ok(PreparedSmall {
            name: item.name.clone(),
            dos_time,
            dos_date,
            method: 0,
            crc: sum,
            uncomp_size,
            payload: raw,
        })
    }
}

fn write_small_batch(
    pz: &mut ParallelZipWriter,
    batch: &[&SourceItem],
    profile: PerfProfile,
    progress: &Arc<Progress>,
    control: &Arc<TaskControl>,
    files: &mut u64,
    bytes: &mut u64,
) -> Result<()> {
    if batch.is_empty() {
        return Ok(());
    }
    control.checkpoint(Some(progress))?;
    if batch.len() == 1 {
        let item = batch[0];
        progress.set_current(&item.name);
        let prep = prepare_small_item(item, profile)?;
        pz.write_prepared_file(
            &prep.name,
            prep.dos_time,
            prep.dos_date,
            prep.method,
            prep.crc,
            prep.uncomp_size,
            &prep.payload,
        )?;
        *bytes += prep.uncomp_size;
        *files += 1;
        progress.add_bytes(prep.uncomp_size);
        progress.file_done();
        return Ok(());
    }

    let threads = profile.threads.min(batch.len()).max(1);
    let next_idx = AtomicUsize::new(0);
    let abort = AtomicBool::new(false);
    let (tx, rx) = mpsc::sync_channel::<(usize, Result<PreparedSmall>)>(threads * 2);
    let mut err_out: Option<anyhow::Error> = None;

    std::thread::scope(|scope| {
        for _ in 0..threads {
            let tx = tx.clone();
            let next = &next_idx;
            let abort_ref = &abort;
            let ctl = control.clone();
            let prog = progress.clone();
            scope.spawn(move || {
                let _prio = ThreadPriorityGuard::enter(profile.mode);
                let mut pacer = WorkPacer::new(profile.cpu_duty_pct);
                loop {
                    if abort_ref.load(Ordering::Acquire) {
                        break;
                    }
                    let idx = next.fetch_add(1, Ordering::Relaxed);
                    if idx >= batch.len() {
                        break;
                    }
                    if let Err(e) = ctl.checkpoint(Some(&prog)) {
                        abort_ref.store(true, Ordering::SeqCst);
                        let _ = tx.send((idx, Err(e)));
                        break;
                    }
                    let step_t0 = pacer.mark_start();
                    let res = prepare_small_item(batch[idx], profile);
                    if res.is_err() {
                        abort_ref.store(true, Ordering::SeqCst);
                    }
                    if let Err(e) = pacer.finish_step(step_t0, &ctl) {
                        abort_ref.store(true, Ordering::SeqCst);
                        let _ = tx.send((idx, Err(e)));
                        break;
                    }
                    if tx.send((idx, res)).is_err() {
                        break;
                    }
                }
            });
        }
        drop(tx);

        let mut pending: BTreeMap<usize, PreparedSmall> = BTreeMap::new();
        let mut expect = 0usize;
        for (idx, res) in &rx {
            if control.is_cancelled() {
                abort.store(true, Ordering::SeqCst);
                err_out = Some(anyhow::anyhow!("操作已取消"));
                break;
            }
            match res {
                Ok(p) => {
                    pending.insert(idx, p);
                }
                Err(e) => {
                    abort.store(true, Ordering::SeqCst);
                    err_out = Some(e);
                    break;
                }
            }
            while let Some(prep) = pending.remove(&expect) {
                if let Err(e) = control.checkpoint(Some(progress)) {
                    abort.store(true, Ordering::SeqCst);
                    err_out = Some(e);
                    break;
                }
                progress.set_current(&prep.name);
                if let Err(e) = pz.write_prepared_file(
                    &prep.name,
                    prep.dos_time,
                    prep.dos_date,
                    prep.method,
                    prep.crc,
                    prep.uncomp_size,
                    &prep.payload,
                ) {
                    abort.store(true, Ordering::SeqCst);
                    err_out = Some(e);
                    break;
                }
                *bytes += prep.uncomp_size;
                *files += 1;
                progress.add_bytes(prep.uncomp_size);
                progress.file_done();
                expect += 1;
            }
            if err_out.is_some() {
                break;
            }
        }
        drop(rx);
    });

    if let Some(e) = err_out {
        if control.is_cancelled() {
            bail!("操作已取消");
        }
        return Err(e);
    }
    Ok(())
}

fn create_parallel(
    items: &[SourceItem],
    dest: &Path,
    profile: PerfProfile,
    progress: &Arc<Progress>,
    control: &Arc<TaskControl>,
    started: Instant,
) -> Result<CreateReport> {
    let mut pz = ParallelZipWriter::new(dest, profile.buf_size)?;
    let mut small_batch: Vec<&SourceItem> = Vec::with_capacity(SMALL_BATCH_ITEMS);
    let mut batch_bytes = 0u64;
    let mut files = 0u64;
    let mut bytes = 0u64;

    for item in items {
        control.checkpoint(Some(progress))?;
        if item.is_dir || item.size >= LARGE_FILE_THRESHOLD {
            if !small_batch.is_empty() {
                write_small_batch(
                    &mut pz,
                    &small_batch,
                    profile,
                    progress,
                    control,
                    &mut files,
                    &mut bytes,
                )?;
                small_batch.clear();
                batch_bytes = 0;
            }
            let (dos_time, dos_date) = dos_datetime(&item.path);
            progress.set_current(&item.name);
            if item.is_dir {
                pz.write_dir(&item.name, dos_time, dos_date)?;
                continue;
            }
            let n = if profile.smart_store && is_incompressible_ext(&item.path) {
                pz.write_large_stored(item, dos_time, dos_date, profile, progress, control)?
            } else {
                pz.write_large_deflate_parallel(
                    item, dos_time, dos_date, profile, progress, control,
                )?
            };
            bytes += n;
            files += 1;
            progress.file_done();
        } else {
            small_batch.push(item);
            batch_bytes += item.size;
            if small_batch.len() >= SMALL_BATCH_ITEMS || batch_bytes >= 16 * 1024 * 1024 {
                write_small_batch(
                    &mut pz,
                    &small_batch,
                    profile,
                    progress,
                    control,
                    &mut files,
                    &mut bytes,
                )?;
                small_batch.clear();
                batch_bytes = 0;
            }
        }
    }

    if !small_batch.is_empty() {
        write_small_batch(
            &mut pz,
            &small_batch,
            profile,
            progress,
            control,
            &mut files,
            &mut bytes,
        )?;
    }

    pz.finish().context("无法完成 ZIP 写入")?;
    Ok(CreateReport {
        path: dest.display().to_string(),
        format: "zip".into(),
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

fn write_u16<W: Write>(w: &mut W, v: u16) -> std::io::Result<()> {
    w.write_all(&v.to_le_bytes())
}

fn write_u32<W: Write>(w: &mut W, v: u32) -> std::io::Result<()> {
    w.write_all(&v.to_le_bytes())
}

fn write_u64<W: Write>(w: &mut W, v: u64) -> std::io::Result<()> {
    w.write_all(&v.to_le_bytes())
}

fn zip64_extra(uncomp: Option<u64>, comp: Option<u64>, offset: Option<u64>) -> Vec<u8> {
    let payload_len = (uncomp.is_some() as usize + comp.is_some() as usize + offset.is_some() as usize) * 8;
    let mut buf = Vec::with_capacity(4 + payload_len);
    buf.extend_from_slice(&0x0001u16.to_le_bytes());
    buf.extend_from_slice(&(payload_len as u16).to_le_bytes());
    if let Some(u) = uncomp {
        buf.extend_from_slice(&u.to_le_bytes());
    }
    if let Some(c) = comp {
        buf.extend_from_slice(&c.to_le_bytes());
    }
    if let Some(o) = offset {
        buf.extend_from_slice(&o.to_le_bytes());
    }
    buf
}

#[allow(clippy::too_many_arguments)]
fn write_lfh_header<W: Write>(
    w: &mut W,
    ver_needed: u16,
    flags: u16,
    method: u16,
    dos_time: u16,
    dos_date: u16,
    crc: u32,
    comp32: u32,
    uncomp32: u32,
    name: &[u8],
    extra: &[u8],
) -> std::io::Result<()> {
    write_u32(w, 0x0403_4b50)?;
    write_u16(w, ver_needed)?;
    write_u16(w, flags)?;
    write_u16(w, method)?;
    write_u16(w, dos_time)?;
    write_u16(w, dos_date)?;
    write_u32(w, crc)?;
    write_u32(w, comp32)?;
    write_u32(w, uncomp32)?;
    write_u16(w, name.len() as u16)?;
    write_u16(w, extra.len() as u16)?;
    w.write_all(name)?;
    if !extra.is_empty() {
        w.write_all(extra)?;
    }
    Ok(())
}

fn patch_zip64_lfh(
    writer: &mut BufWriter<File>,
    lfh_offset: u64,
    name_len: usize,
    method: u16,
    crc: u32,
    comp: u64,
    uncomp: u64,
) -> Result<()> {
    writer.flush()?;
    let end_pos = writer.stream_position()?;
    writer.seek(SeekFrom::Start(lfh_offset + 8))?;
    write_u16(writer, method)?;
    // LFH 带 16 字节 ZIP64 extra 时保持 comp32/uncomp32 = 0xFFFFFFFF，严格符合 PKZIP APPNOTE 4.5.3。
    writer.seek(SeekFrom::Start(lfh_offset + 14))?;
    write_u32(writer, crc)?;
    let extra_data_pos = lfh_offset + 30 + name_len as u64 + 4;
    writer.seek(SeekFrom::Start(extra_data_pos))?;
    write_u64(writer, uncomp)?;
    write_u64(writer, comp)?;
    writer.flush()?;
    writer.seek(SeekFrom::Start(end_pos))?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub fn extract(
    path: &Path,
    out_dir: &Path,
    selected: &HashSet<usize>,
    password: Option<&str>,
    policy: Overwrite,
    profile: PerfProfile,
    dir_map: &HashMap<String, String>,
    undo: Option<&Arc<UndoTracker>>,
    progress: &Arc<Progress>,
    control: &Arc<TaskControl>,
) -> Result<ExtractReport> {
    if profile.threads > 1 {
        if let Some(report) = extract_parallel(
            path, out_dir, selected, password, policy, profile, dir_map, undo, progress, control,
        )? {
            return Ok(report);
        }
    }
    extract_sequential(
        path, out_dir, selected, password, policy, profile, dir_map, undo, progress, control,
    )
}

#[allow(clippy::too_many_arguments)]
fn extract_sequential(
    path: &Path,
    out_dir: &Path,
    selected: &HashSet<usize>,
    password: Option<&str>,
    policy: Overwrite,
    profile: PerfProfile,
    dir_map: &HashMap<String, String>,
    undo: Option<&Arc<UndoTracker>>,
    progress: &Progress,
    control: &TaskControl,
) -> Result<ExtractReport> {
    let mut zip = open(path)?;
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
    let declared: u64 = selected
        .iter()
        .filter_map(|&i| zip.by_index_raw(i).ok().map(|e| e.size()))
        .sum();
    budget.check_declared(declared)?;

    for i in 0..zip.len() {
        if !selected.contains(&i) {
            continue;
        }
        control.checkpoint(Some(progress))?;
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

        // 目录不计入 total_files，决不能调用 file_done()，避免出现 954 / 734 计数溢出。
        if is_dir {
            let target = safe_join_mapped(out_dir, &raw_name, dir_map)?;
            if let Some(u) = undo {
                u.ensure_dir(&target)?;
            } else {
                fs::create_dir_all(&target)?;
            }
            report.dirs += 1;
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
        let target = safe_join_mapped(out_dir, &raw_name, dir_map)?;
        let Some(target) = resolve_dest(target, false, policy)? else {
            report.skipped += 1;
            progress.add_bytes(entry.size());
            progress.file_done();
            continue;
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

struct ZipJob {
    index: usize,
    name: String,
    size: u64,
    target: std::path::PathBuf,
    encrypted: bool,
}

/// 多文件 ZIP 并行解压：先顺序预扫描做全部安全检查（目标冲突/符号链接/密码/
/// 覆盖策略），确定安全后按 LPT（大文件优先）放入动态窃取队列多核并行写入。
#[allow(clippy::too_many_arguments)]
fn extract_parallel(
    path: &Path,
    out_dir: &Path,
    selected: &HashSet<usize>,
    password: Option<&str>,
    policy: Overwrite,
    profile: PerfProfile,
    dir_map: &HashMap<String, String>,
    undo: Option<&Arc<UndoTracker>>,
    progress: &Arc<Progress>,
    control: &Arc<TaskControl>,
) -> Result<Option<ExtractReport>> {
    let mut zip = open(path)?;
    let mut jobs: Vec<ZipJob> = Vec::new();
    let mut dir_targets: Vec<std::path::PathBuf> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut seen_resolved: HashSet<String> = HashSet::new();
    let mut skipped: u64 = 0;
    let mut skipped_bytes: u64 = 0;
    let mut dirs: u64 = 0;

    for i in 0..zip.len() {
        if !selected.contains(&i) {
            continue;
        }
        control.checkpoint(Some(progress))?;
        let raw_name;
        let is_dir;
        let encrypted;
        let unix_mode;
        let raw_size;
        {
            let raw = zip.by_index_raw(i)?;
            raw_name = raw
                .name()
                .map_err(|e| anyhow::anyhow!("ZIP 文件名读取失败: {e}"))?
                .to_string();
            is_dir = raw.is_dir() || raw_name.ends_with('/');
            encrypted = raw.encrypted();
            unix_mode = raw.unix_mode();
            raw_size = raw.size();
        }
        if is_dir {
            dir_targets.push(safe_join_mapped(out_dir, &raw_name, dir_map)?);
            dirs += 1;
            continue;
        }
        if unix_mode.map(|m| m & 0o170000 == 0o120000).unwrap_or(false) {
            return Ok(None);
        }
        if encrypted && password.map_or(true, |p| p.is_empty()) {
            bail!("该 ZIP 已加密，请先输入密码");
        }
        let target = safe_join_mapped(out_dir, &raw_name, dir_map)?;
        if !seen.insert(target.to_string_lossy().to_lowercase()) {
            return Ok(None);
        }
        match resolve_dest(target, false, policy)? {
            Some(target) => {
                // 防止 Rename 自动重命名后的目标与归档内另一条目发生并发撞车（如 foo.txt -> foo (2).txt 撞上归档内原 foo (2).txt）
                if !seen_resolved.insert(target.to_string_lossy().to_lowercase()) {
                    return Ok(None);
                }
                jobs.push(ZipJob {
                    index: i,
                    name: raw_name,
                    size: raw_size,
                    target,
                    encrypted,
                })
            }
            None => {
                // 延迟到确认走并行路径后再统一计入进度，避免回退顺序解压时重复计数。
                skipped += 1;
                skipped_bytes += raw_size;
            }
        }
    }
    if jobs.len() < 2 {
        return Ok(None);
    }

    let budget = Budget::for_extraction();
    let declared: u64 = jobs.iter().map(|j| j.size).sum();
    budget.check_declared(declared)?;
    let budget = &budget;
    if skipped > 0 {
        progress.add_bytes(skipped_bytes);
        for _ in 0..skipped {
            progress.file_done();
        }
    }
    for d in &dir_targets {
        control.checkpoint(Some(progress))?;
        if let Some(u) = undo {
            u.ensure_dir(d)?;
        } else {
            fs::create_dir_all(d)?;
        }
    }

    // 大文件优先 (LPT)：避免所有小文件写完后只剩单核跑最后一个大文件拖长尾。
    jobs.sort_unstable_by(|a, b| b.size.cmp(&a.size));

    let threads = profile.threads.min(jobs.len()).max(1);
    let next_idx = AtomicUsize::new(0);
    let failed = AtomicBool::new(false);
    let files = std::sync::atomic::AtomicU64::new(0);
    let bytes = std::sync::atomic::AtomicU64::new(0);
    let pw_owned = password.map(|p| p.to_string());

    let results: Vec<Result<()>> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..threads)
            .map(|_| {
                let jobs = &jobs;
                let next_idx = &next_idx;
                let failed = &failed;
                let files = &files;
                let bytes = &bytes;
                let pw = pw_owned.as_deref();
                let ctl = control.clone();
                let prog = progress.clone();
                scope.spawn(move || -> Result<()> {
                    let _prio = ThreadPriorityGuard::enter(profile.mode);
                    let mut zip = open(path)?;
                    loop {
                        if failed.load(Ordering::Acquire) {
                            bail!("并行解压已中止");
                        }
                        ctl.checkpoint(Some(&prog))?;
                        let idx = next_idx.fetch_add(1, Ordering::Relaxed);
                        if idx >= jobs.len() {
                            break;
                        }
                        let job = &jobs[idx];
                        let mut entry = if job.encrypted {
                            let pw = pw
                                .ok_or_else(|| anyhow::anyhow!("该 ZIP 已加密，请先输入密码"))?;
                            zip.by_index_decrypt(job.index, pw.as_bytes()).map_err(|_| {
                                anyhow::anyhow!("密码错误，或不支持该 ZIP 加密方式")
                            })?
                        } else {
                            zip.by_index(job.index)?
                        };
                        prog.set_current(&job.name);
                        if let Some(u) = undo {
                            u.prepare_file_write(&job.target, policy)?;
                        } else {
                            ensure_parent(&job.target)?;
                        }
                        let f = File::create(&job.target)
                            .with_context(|| format!("无法写入 {}", job.target.display()))?;
                        let mut out = BufWriter::with_capacity(profile.buf_size, f);
                        let n = match copy_controlled_abortable(
                            &mut entry,
                            &mut out,
                            &ctl,
                            Some(failed),
                            profile,
                            Some(budget),
                            Some(&prog),
                            |chunk| prog.add_bytes(chunk),
                        )
                        .and_then(|n| {
                            out.flush()?;
                            Ok(n)
                        }) {
                            Ok(n) => n,
                            Err(e) => {
                                drop(out);
                                let _ = fs::remove_file(&job.target);
                                failed.store(true, Ordering::Release);
                                return Err(e);
                            }
                        };
                        if let Some(u) = undo {
                            u.record_created_file(&job.target);
                        }
                        files.fetch_add(1, Ordering::Relaxed);
                        bytes.fetch_add(n, Ordering::Relaxed);
                        prog.file_done();
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

    if control.is_cancelled() {
        bail!("操作已取消");
    }
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
        undo_id: None,
        can_undo: false,
        backup_incomplete: false,
        backup_bytes: 0,
    }))
}

pub fn read_entry(path: &Path, index: usize, password: Option<&str>, limit: u64) -> Result<Vec<u8>> {
    let mut zip = open(path)?;
    if index >= zip.len() {
        bail!("条目索引超出范围");
    }
    let encrypted = zip.by_index_raw(index).map(|e| e.encrypted()).unwrap_or(false);
    // 不需要 mut：Read::take 按值消耗 entry，绑定之后只用返回的 Take。
    let entry = if encrypted {
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
        // 只读 len()，不需要 mut。
        let archive = open(zip_path).unwrap();
        (0..archive.len()).collect()
    }

    fn run(mode: &str, zip: &Path, out: &Path, policy: Overwrite) -> Result<ExtractReport> {
        let p = Arc::new(Progress::detached());
        let ctl = Arc::new(TaskControl::default());
        let selected = all_indices(zip);
        let empty_map = HashMap::new();
        extract(
            zip,
            out,
            &selected,
            None,
            policy,
            PerfProfile::from_mode(mode),
            &empty_map,
            None,
            &p,
            &ctl,
        )
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
    fn cancel_before_start_errors() {
        let root = temp_root("cancel");
        let zip = root.join("a.zip");
        make_zip(&zip, &[("a.txt", b"a"), ("b.txt", b"b")]);
        let out = root.join("out");
        let p = Arc::new(Progress::detached());
        let ctl = Arc::new(TaskControl::default());
        ctl.request_cancel();
        let selected = all_indices(&zip);
        let empty_map = HashMap::new();
        let res = extract(
            &zip,
            &out,
            &selected,
            None,
            Overwrite::Overwrite,
            PerfProfile::from_mode("saver"),
            &empty_map,
            None,
            &p,
            &ctl,
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

    #[test]
    fn parallel_zip_roundtrip_large_and_mixed() {
        let root = temp_root("pz_roundtrip");
        let src_dir = root.join("src_bundle");
        let sub_dir = src_dir.join("中文目录");
        fs::create_dir_all(&sub_dir).unwrap();

        let small_txt = b"hello parallel zip!".to_vec();
        let utf8_txt = "中文内容测试-白林归档引擎\n".repeat(32).into_bytes();
        let jpg_fake: Vec<u8> = (0..128 * 1024).map(|i| ((i * 73 + 19) % 251) as u8).collect();
        // 5 MiB 可压缩文本块：触发 write_large_deflate_parallel 多块并行压缩（>= 2 MiB，5 个 1 MiB 块）
        let mut big_tar = Vec::with_capacity(5 * 1024 * 1024);
        for i in 0..(5 * 1024 * 1024 / 64) {
            big_tar.extend_from_slice(
                format!("record-{i:08}-tidy-assistant-archive-engine-benchmark!!\n").as_bytes(),
            );
        }

        fs::write(src_dir.join("empty.txt"), b"").unwrap();
        fs::write(src_dir.join("small.txt"), &small_txt).unwrap();
        fs::write(sub_dir.join("说明.txt"), &utf8_txt).unwrap();
        fs::write(src_dir.join("cover.jpg"), &jpg_fake).unwrap();
        fs::write(src_dir.join("big.tar"), &big_tar).unwrap();

        let dest = root.join("mixed.zip");
        let p = Arc::new(Progress::detached());
        let ctl = Arc::new(TaskControl::default());
        let profile = PerfProfile::from_mode("hyper");
        let rep = create(&[src_dir.clone()], &dest, None, profile, &p, &ctl).unwrap();
        assert_eq!(rep.files, 5);
        assert_eq!(p.files_count(), 5);

        {
            let mut za = open(&dest).unwrap();
            let mut checked_jpg = false;
            let mut checked_big = false;
            for i in 0..za.len() {
                let entry = za.by_index_raw(i).unwrap();
                let ename = entry.name().unwrap();
                if ename.ends_with("cover.jpg") {
                    assert_eq!(entry.compression(), CompressionMethod::Stored, "hyper 应对 jpg 免重压");
                    checked_jpg = true;
                } else if ename.ends_with("big.tar") {
                    assert_eq!(entry.compression(), CompressionMethod::Deflated, "big.tar 必须走压缩");
                    checked_big = true;
                }
            }
            assert!(checked_jpg && checked_big);
        }

        let out = root.join("out");
        let erep = run("hyper", &dest, &out, Overwrite::Overwrite).unwrap();
        assert_eq!(erep.files, 5);
        assert_eq!(fs::read(out.join("src_bundle/empty.txt")).unwrap(), b"");
        assert_eq!(fs::read(out.join("src_bundle/small.txt")).unwrap(), small_txt);
        assert_eq!(fs::read(out.join("src_bundle/中文目录/说明.txt")).unwrap(), utf8_txt);
        assert_eq!(fs::read(out.join("src_bundle/cover.jpg")).unwrap(), jpg_fake);
        assert_eq!(fs::read(out.join("src_bundle/big.tar")).unwrap(), big_tar);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn sequential_and_parallel_file_counts_match() {
        let root = temp_root("dir_count");
        let zip = root.join("dirs.zip");
        {
            let f = File::create(&zip).unwrap();
            let mut w = ZipWriter::new(f);
            let opts = SimpleFileOptions::default();
            w.add_directory("dir_a/", opts).unwrap();
            w.add_directory("dir_a/sub/", opts).unwrap();
            w.start_file("dir_a/one.txt", opts).unwrap();
            w.write_all(b"111").unwrap();
            w.start_file("dir_a/sub/two.txt", opts).unwrap();
            w.write_all(b"222").unwrap();
            w.finish().unwrap();
        }
        for mode in ["saver", "hyper"] {
            let out = root.join(format!("out_{mode}"));
            let p = Arc::new(Progress::detached());
            let ctl = Arc::new(TaskControl::default());
            let selected = all_indices(&zip);
            let empty_map = HashMap::new();
            let rep = extract(
                &zip,
                &out,
                &selected,
                None,
                Overwrite::Overwrite,
                PerfProfile::from_mode(mode),
                &empty_map,
                None,
                &p,
                &ctl,
            )
            .unwrap();
            assert_eq!(rep.files, 2, "mode {mode}");
            assert_eq!(rep.dirs, 2, "mode {mode}");
            assert_eq!(
                p.files_count(),
                rep.files,
                "目录不得计入 progress.files_count（防 954/734 溢出）"
            );
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn pause_resume_and_cancel_while_paused_no_deadlock() {
        use std::time::Duration;

        let root = temp_root("pause_ctl");
        let zip = root.join("big.zip");
        let payload = vec![b'A'; 512 * 1024];
        let entries: Vec<(String, Vec<u8>)> = (0..12)
            .map(|i| (format!("part_{i:02}.bin"), payload.clone()))
            .collect();
        let refs: Vec<(&str, &[u8])> = entries.iter().map(|(n, d)| (n.as_str(), d.as_slice())).collect();
        make_zip(&zip, &refs);

        // 子场景 A：先暂停，验证任务冻结，再恢复直至完成
        let out_a = root.join("out_a");
        let p_a = Arc::new(Progress::detached());
        let ctl_a = Arc::new(TaskControl::default());
        assert!(ctl_a.set_paused(true));
        assert!(ctl_a.is_paused());
        let zip_a = zip.clone();
        let out_a_c = out_a.clone();
        let p_a_c = Arc::clone(&p_a);
        let ctl_a_c = Arc::clone(&ctl_a);
        let selected_a = all_indices(&zip);
        let handle_a = std::thread::spawn(move || {
            let empty_map = HashMap::new();
            extract(
                &zip_a,
                &out_a_c,
                &selected_a,
                None,
                Overwrite::Overwrite,
                PerfProfile::from_mode("hyper"),
                &empty_map,
                None,
                &p_a_c,
                &ctl_a_c,
            )
        });
        std::thread::sleep(Duration::from_millis(60));
        assert_eq!(p_a.files_count(), 0, "暂停期间不应完成任何文件");
        assert!(ctl_a.set_paused(false));
        let rep_a = handle_a.join().unwrap().unwrap();
        assert_eq!(rep_a.files, 12);

        // 子场景 B：暂停状态下立即请求取消，必须 <500ms 解锁退出并报错，绝不死锁
        let out_b = root.join("out_b");
        let p_b = Arc::new(Progress::detached());
        let ctl_b = Arc::new(TaskControl::default());
        assert!(ctl_b.set_paused(true));
        let zip_b = zip.clone();
        let out_b_c = out_b.clone();
        let p_b_c = Arc::clone(&p_b);
        let ctl_b_c = Arc::clone(&ctl_b);
        let selected_b = all_indices(&zip);
        let handle_b = std::thread::spawn(move || {
            let empty_map = HashMap::new();
            extract(
                &zip_b,
                &out_b_c,
                &selected_b,
                None,
                Overwrite::Overwrite,
                PerfProfile::from_mode("balanced"),
                &empty_map,
                None,
                &p_b_c,
                &ctl_b_c,
            )
        });
        std::thread::sleep(Duration::from_millis(50));
        let t0 = Instant::now();
        ctl_b.request_cancel();
        assert!(!ctl_b.set_paused(true), "取消后不得重新置为暂停");
        let res_b = handle_b.join().unwrap();
        assert!(
            t0.elapsed() < Duration::from_millis(500),
            "暂停态取消耗时过长: {:?}",
            t0.elapsed()
        );
        match res_b {
            Ok(_) => panic!("取消后不应成功"),
            Err(e) => assert!(format!("{e}").contains("取消"), "unexpected: {e}"),
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn parallel_zip_incompressible_random_and_boundaries() {
        let root = temp_root("pz_rand");
        let src_dir = root.join("src");
        fs::create_dir_all(&src_dir).unwrap();

        // 确定性 xorshift64 伪随机高熵数据：Deflate 无法压缩会轻微膨胀，覆盖扩块边界
        let make_rand = |len: usize, mut s: u64| -> Vec<u8> {
            let mut out = vec![0u8; len];
            for chunk in out.chunks_mut(8) {
                s ^= s << 13;
                s ^= s >> 7;
                s ^= s << 17;
                let b = s.to_le_bytes();
                for (i, dst) in chunk.iter_mut().enumerate() {
                    *dst = b[i];
                }
            }
            out
        };
        let b_under = make_rand(2 * 1024 * 1024 - 1, 0x1111_2222_3333_4444);
        let b_exact = make_rand(2 * 1024 * 1024, 0x5555_6666_7777_8888);
        let b_over = make_rand(2 * 1024 * 1024 + 1, 0x9999_aaaa_bbbb_cccc);
        let b_big = make_rand(3 * 1024 * 1024 + 513 * 1024, 0xdead_beef_cafe_babe);

        fs::write(src_dir.join("under_2m.bin"), &b_under).unwrap();
        fs::write(src_dir.join("exact_2m.bin"), &b_exact).unwrap();
        fs::write(src_dir.join("over_2m.bin"), &b_over).unwrap();
        fs::write(src_dir.join("rand_3_5m.bin"), &b_big).unwrap();

        let dest = root.join("rand.zip");
        let p = Arc::new(Progress::detached());
        let ctl = Arc::new(TaskControl::default());
        let rep = create(&[src_dir], &dest, None, PerfProfile::from_mode("hyper"), &p, &ctl).unwrap();
        assert_eq!(rep.files, 4);

        let out = root.join("out");
        let erep = run("hyper", &dest, &out, Overwrite::Overwrite).unwrap();
        assert_eq!(erep.files, 4);
        assert_eq!(fs::read(out.join("src/under_2m.bin")).unwrap(), b_under);
        assert_eq!(fs::read(out.join("src/exact_2m.bin")).unwrap(), b_exact);
        assert_eq!(fs::read(out.join("src/over_2m.bin")).unwrap(), b_over);
        assert_eq!(fs::read(out.join("src/rand_3_5m.bin")).unwrap(), b_big);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn parallel_extract_skip_fallback_no_double_count() {
        let root = temp_root("skip_fb");
        let zip = root.join("three.zip");
        make_zip(
            &zip,
            &[("a.txt", b"aaa"), ("b.txt", b"bbb"), ("c.txt", b"ccc")],
        );
        let out = root.join("out");
        fs::create_dir_all(&out).unwrap();
        // 预先放好 2 个文件，Skip 策略下只剩 1 个待写任务，迫使 extract_parallel 回退顺序路径
        fs::write(out.join("a.txt"), b"keep-a").unwrap();
        fs::write(out.join("b.txt"), b"keep-b").unwrap();

        let p = Arc::new(Progress::detached());
        let ctl = Arc::new(TaskControl::default());
        let selected = all_indices(&zip);
        let empty_map = HashMap::new();
        let rep = extract(
            &zip,
            &out,
            &selected,
            None,
            Overwrite::Skip,
            PerfProfile::from_mode("hyper"),
            &empty_map,
            None,
            &p,
            &ctl,
        )
        .unwrap();
        assert_eq!(rep.files, 1);
        assert_eq!(rep.skipped, 2);
        assert_eq!(p.files_count(), 3, "回退顺序解压时跳过条目不得被重复计数");
        assert_eq!(p.bytes_count(), 9, "回退顺序解压时跳过字节不得被重复计数");
        assert_eq!(fs::read(out.join("a.txt")).unwrap(), b"keep-a");
        assert_eq!(fs::read(out.join("c.txt")).unwrap(), b"ccc");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn parallel_create_pause_resume_and_cancel_no_deadlock() {
        use std::time::Duration;

        let root = temp_root("pz_pause");
        let big_file = root.join("payload.tar");
        let mut content = Vec::with_capacity(6 * 1024 * 1024);
        for i in 0..(6 * 1024 * 1024 / 64) {
            content.extend_from_slice(format!("block-data-{i:08}-tidy-assistant-redteam-verify-!!\n").as_bytes());
        }
        fs::write(&big_file, &content).unwrap();

        // A: 暂停大文件并行 ZIP 压缩 -> 恢复 -> 完整解压校验
        let zip_a = root.join("a.zip");
        let p_a = Arc::new(Progress::detached());
        let ctl_a = Arc::new(TaskControl::default());
        assert!(ctl_a.set_paused(true));
        let src_a = big_file.clone();
        let dest_a = zip_a.clone();
        let p_a_c = Arc::clone(&p_a);
        let ctl_a_c = Arc::clone(&ctl_a);
        let h_a = std::thread::spawn(move || {
            create(&[src_a], &dest_a, None, PerfProfile::from_mode("hyper"), &p_a_c, &ctl_a_c)
        });
        std::thread::sleep(Duration::from_millis(60));
        assert_eq!(p_a.bytes_count(), 0, "暂停期间并行压缩不得推进字节数");
        assert!(ctl_a.set_paused(false));
        let rep_a = h_a.join().unwrap().unwrap();
        assert_eq!(rep_a.files, 1);
        let out_a = root.join("out_a");
        run("hyper", &zip_a, &out_a, Overwrite::Overwrite).unwrap();
        assert_eq!(fs::read(out_a.join("payload.tar")).unwrap(), content);

        // B: 暂停态下取消大文件并行 ZIP 压缩，必须 <500ms 退出且无死锁
        let zip_b = root.join("b.zip");
        let p_b = Arc::new(Progress::detached());
        let ctl_b = Arc::new(TaskControl::default());
        assert!(ctl_b.set_paused(true));
        let src_b = big_file.clone();
        let dest_b = zip_b.clone();
        let p_b_c = Arc::clone(&p_b);
        let ctl_b_c = Arc::clone(&ctl_b);
        let h_b = std::thread::spawn(move || {
            create(&[src_b], &dest_b, None, PerfProfile::from_mode("hyper"), &p_b_c, &ctl_b_c)
        });
        std::thread::sleep(Duration::from_millis(50));
        let t0 = Instant::now();
        ctl_b.request_cancel();
        let res_b = h_b.join().unwrap();
        assert!(t0.elapsed() < Duration::from_millis(500), "取消耗时过长: {:?}", t0.elapsed());
        assert!(res_b.is_err() && format!("{}", res_b.unwrap_err()).contains("取消"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn parallel_rename_resolved_collision_falls_back_safely() {
        let root = temp_root("ren_col");
        let zip = root.join("col.zip");
        // 磁盘已有 foo.txt，而包内同时有 foo.txt 和 foo (2).txt：
        // 并行预扫描中 foo.txt -> foo (2).txt 会撞上另一条目 foo (2).txt，必须安全回退顺序解压不丢数据！
        make_zip(&zip, &[("foo.txt", b"new-foo"), ("foo (2).txt", b"new-foo2")]);
        let out = root.join("out");
        fs::create_dir_all(&out).unwrap();
        fs::write(out.join("foo.txt"), b"disk-orig").unwrap();

        let rep = run("hyper", &zip, &out, Overwrite::Rename).unwrap();
        assert_eq!(rep.files, 2);
        assert_eq!(fs::read(out.join("foo.txt")).unwrap(), b"disk-orig");
        let mut contents = vec![
            fs::read(out.join("foo (2).txt")).unwrap(),
            fs::read(out.join("foo (2) (2).txt")).unwrap(),
        ];
        contents.sort();
        assert_eq!(contents, vec![b"new-foo".to_vec(), b"new-foo2".to_vec()]);
        let _ = fs::remove_dir_all(&root);
    }
}
