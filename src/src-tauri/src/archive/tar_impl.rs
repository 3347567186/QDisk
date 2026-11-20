use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use anyhow::{bail, Context, Result};
use bzip2::read::BzDecoder;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use lzma_rust2::XzReader;

use super::util::{
    collect_sources, copy_cancellable, ensure_parent, filetime_to_local_parts, resolve_dest,
    safe_join, Overwrite, Progress,
};
use super::{ArchiveInfo, CreateReport, EntryInfo, ExtractReport, Kind};

fn reader(path: &Path, kind: Kind) -> Result<Box<dyn Read>> {
    let f = File::open(path).with_context(|| format!("无法打开 {}", path.display()))?;
    let f = BufReader::new(f);
    Ok(match kind {
        Kind::Tar => Box::new(f),
        Kind::TarGz => Box::new(GzDecoder::new(f)),
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
    let size = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    Ok(ArchiveInfo {
        path: path.display().to_string(),
        format: kind.label().into(),
        entries: vec![EntryInfo {
            index: 0,
            name,
            is_dir: false,
            size,
            packed: size,
            modified: "—".into(),
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

pub fn extract(
    path: &Path,
    out_dir: &Path,
    kind: Kind,
    selected: &HashSet<usize>,
    _password: Option<&str>,
    policy: Overwrite,
    progress: &Progress,
    cancel: &AtomicBool,
) -> Result<ExtractReport> {
    let mut ar = tar::Archive::new(reader(path, kind)?);
    let mut report = ExtractReport {
        files: 0,
        dirs: 0,
        bytes: 0,
        skipped: 0,
        warnings: Vec::new(),
        out_dir: out_dir.display().to_string(),
    };
    for (idx, item) in ar.entries().context("TAR 读取失败")?.enumerate() {
        if !selected.contains(&idx) {
            continue;
        }
        if cancel.load(Ordering::Relaxed) {
            bail!("操作已取消");
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
        if ty.is_dir() {
            match safe_join(out_dir, &raw) {
                Ok(dir) => {
                    fs::create_dir_all(&dir)?;
                    report.dirs += 1;
                }
                Err(e) => {
                    report.skipped += 1;
                    report.warnings.push(format!("{e}"));
                }
            }
            progress.file_done();
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
        let target = match safe_join(out_dir, &raw) {
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

pub fn extract_single(
    path: &Path,
    out_dir: &Path,
    kind: Kind,
    selected: &HashSet<usize>,
    policy: Overwrite,
    progress: &Progress,
    cancel: &AtomicBool,
) -> Result<ExtractReport> {
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
        });
    };
    ensure_parent(&target)?;
    let mut src = single_reader(path, kind)?;
    let mut out = File::create(&target)?;
    let n = copy_cancellable(&mut src, &mut out, cancel, |n| progress.add_bytes(n))?;
    out.sync_all().ok();
    progress.file_done();
    progress.finish();
    Ok(ExtractReport {
        files: 1,
        dirs: 0,
        bytes: n,
        skipped: 0,
        warnings: Vec::new(),
        out_dir: out_dir.display().to_string(),
    })
}

pub fn single_reader_pub(path: &Path, kind: Kind) -> Result<Box<dyn Read>> {
    single_reader(path, kind)
}

fn single_reader(path: &Path, kind: Kind) -> Result<Box<dyn Read>> {
    let f = BufReader::new(File::open(path)?);
    Ok(match kind {
        Kind::Gz => Box::new(GzDecoder::new(f)),
        Kind::Bz2 => Box::new(BzDecoder::new(f)),
        Kind::Xz => Box::new(XzReader::new(f, true)),
        _ => bail!("不是单文件压缩格式"),
    })
}

pub fn create_tar(
    sources: &[PathBuf],
    dest: &Path,
    progress: &Progress,
    cancel: &AtomicBool,
) -> Result<CreateReport> {
    let started = Instant::now();
    let f = File::create(dest)?;
    let mut builder = tar::Builder::new(BufWriter::new(f));
    let (files, bytes) = append_sources(&mut builder, sources, dest, progress, cancel)?;
    let out = builder.into_inner().context("无法完成 TAR 写入")?;
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
    })
}

pub fn create_tgz(
    sources: &[PathBuf],
    dest: &Path,
    progress: &Progress,
    cancel: &AtomicBool,
) -> Result<CreateReport> {
    let started = Instant::now();
    let f = File::create(dest)?;
    let gz = GzEncoder::new(BufWriter::new(f), Compression::new(6));
    let mut builder = tar::Builder::new(gz);
    let (files, bytes) = append_sources(&mut builder, sources, dest, progress, cancel)?;
    let gz = builder.into_inner().context("无法完成 TAR.GZ 写入")?;
    let out = gz.finish().context("无法完成 GZIP 写入")?;
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
    })
}

fn append_sources<W: Write>(
    builder: &mut tar::Builder<W>,
    sources: &[PathBuf],
    dest: &Path,
    progress: &Progress,
    cancel: &AtomicBool,
) -> Result<(u64, u64)> {
    let (mut items, total) = collect_sources(sources, Some(dest))?;
    items.retain(|i| i.path != dest);
    progress.set_totals(items.iter().filter(|i| !i.is_dir).count() as u64, total);
    progress.phase("compress");
    let mut files = 0u64;
    let mut bytes = 0u64;
    for item in &items {
        if cancel.load(Ordering::Relaxed) {
            bail!("操作已取消");
        }
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
        builder
            .append_path_with_name(&item.path, &item.name)
            .with_context(|| format!("无法写入 {}", item.name))?;
        bytes += item.size;
        files += 1;
        progress.add_bytes(item.size);
        progress.file_done();
    }
    Ok((files, bytes))
}
