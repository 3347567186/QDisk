mod download;
mod preview;
mod rar;
mod sevenz_impl;
mod tar_impl;
mod undo;
mod util;
mod zip_impl;

use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use anyhow::{bail, Context, Result};
use serde::Serialize;
use tauri::{AppHandle, State};

pub use undo::{UndoReport, UndoTracker};
pub use util::{Overwrite, PerfProfile, Progress, TaskControl, ThreadPriorityGuard};

use crate::data_dir;

static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

/// The product data directory is fixed for the process lifetime. Archive
/// listing/extraction functions do not carry an AppHandle, so the RAR loader
/// reads the DLL path from here.
pub fn set_data_dir(path: PathBuf) {
    let _ = DATA_DIR.set(path.clone());
    sweep_stale_preview_dirs();
    undo::sweep_stale_undo_dirs(&path);
}

/// 启动时清掉上次运行（崩溃、进程被杀）残留的预览目录，避免预览目录越积越多。
fn sweep_stale_preview_dirs() {
    let base = data_dir().join("preview");
    let me = std::process::id().to_string();
    let Ok(rd) = fs::read_dir(&base) else {
        return;
    };
    for entry in rd.flatten() {
        let path = entry.path();
        if !path.is_dir() || entry.file_name().to_string_lossy() == me {
            continue;
        }
        let _ = fs::remove_dir_all(&path);
    }
}

pub fn data_dir_for_rar() -> PathBuf {
    DATA_DIR
        .get()
        .cloned()
        .unwrap_or_else(|| std::env::temp_dir())
}

#[derive(Clone, Default)]
pub struct ArchiveCtx {
    control: Arc<TaskControl>,
    busy: Arc<AtomicBool>,
    active_progress: Arc<Mutex<Option<Arc<Progress>>>>,
    preview_dir: Arc<Mutex<Option<PathBuf>>>,
    undo_history: Arc<Mutex<VecDeque<undo::UndoRecord>>>,
}

pub struct OpGuard {
    ctx: ArchiveCtx,
}

impl Drop for OpGuard {
    fn drop(&mut self) {
        if let Ok(mut slot) = self.ctx.active_progress.lock() {
            *slot = None;
        }
        self.ctx.control.reset();
        self.ctx.busy.store(false, Ordering::SeqCst);
    }
}

impl ArchiveCtx {
    fn begin(&self, progress: Option<Arc<Progress>>) -> Result<OpGuard> {
        if self.busy.swap(true, Ordering::SeqCst) {
            bail!("已有压缩或解压任务在运行，请先等待或取消");
        }
        self.control.reset();
        if let Ok(mut slot) = self.active_progress.lock() {
            *slot = progress;
        }
        Ok(OpGuard { ctx: self.clone() })
    }

    fn push_undo(&self, record: undo::UndoRecord) {
        if let Ok(mut hist) = self.undo_history.lock() {
            hist.push_back(record);
            while hist.len() > undo::MAX_UNDO_RECORDS {
                if let Some(old) = hist.pop_front() {
                    old.cleanup_backup_dir();
                }
            }
        }
    }

    fn take_undo(&self, id: &str) -> Option<undo::UndoRecord> {
        let mut hist = self.undo_history.lock().ok()?;
        let pos = hist.iter().position(|r| r.id == id)?;
        hist.remove(pos)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Zip,
    SevenZ,
    Tar,
    TarGz,
    TarBz2,
    TarXz,
    Gz,
    Bz2,
    Xz,
    Rar,
}

impl Kind {
    pub fn label(self) -> &'static str {
        match self {
            Kind::Zip => "ZIP",
            Kind::SevenZ => "7Z",
            Kind::Tar => "TAR",
            Kind::TarGz => "TAR.GZ",
            Kind::TarBz2 => "TAR.BZ2",
            Kind::TarXz => "TAR.XZ",
            Kind::Gz => "GZ",
            Kind::Bz2 => "BZ2",
            Kind::Xz => "XZ",
            Kind::Rar => "RAR",
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryInfo {
    pub index: usize,
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub packed: u64,
    pub modified: String,
    pub encrypted: bool,
    pub crc: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveInfo {
    pub path: String,
    pub format: String,
    pub entries: Vec<EntryInfo>,
    pub total_size: u64,
    pub total_packed: u64,
    pub encrypted: bool,
    pub solid: bool,
    pub comment: String,
    pub needs_rar: bool,
    pub rar_ready: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractReport {
    pub files: u64,
    pub dirs: u64,
    pub bytes: u64,
    pub skipped: u64,
    pub warnings: Vec<String>,
    pub out_dir: String,
    pub undo_id: Option<String>,
    pub can_undo: bool,
    pub backup_incomplete: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateReport {
    pub path: String,
    pub format: String,
    pub files: u64,
    pub bytes: u64,
    pub packed: u64,
    pub elapsed_ms: u64,
    pub undo_id: Option<String>,
    pub can_undo: bool,
    pub backup_incomplete: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictSample {
    pub name: String,
    pub is_dir: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractConflictInfo {
    pub has_conflicts: bool,
    pub out_dir_exists: bool,
    pub out_dir_is_file: bool,
    pub suggested_out_dir: String,
    pub file_conflicts: u64,
    pub dir_conflicts: u64,
    pub samples: Vec<ConflictSample>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateConflictInfo {
    pub exists: bool,
    pub is_dir: bool,
    pub size: u64,
    pub modified: String,
    pub suggested_dest: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewData {
    pub kind: String,
    pub name: String,
    pub text: String,
    pub file: String,
    pub mime: String,
    pub size: u64,
    pub truncated: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RarStatus {
    pub ready: bool,
    pub path: String,
    pub version: u32,
}

/// 压缩包后缀清单：**唯一来源**。
///
/// `detect()` 和「打开压缩包」对话框的过滤器都从这张表生成，前端
/// `web/js/pages/archive.js` 的正则由 `tests::js_regex_covers_every_suffix` 盯着。
///
/// 为什么集中到一处：这份清单以前写了三遍（detect 的 if 链、`pick_archive` 的
/// `add_filter`、前端正则）。漂移的表现不是报错，而是「对话框里挑不出 .cb7，
/// 但把它拖进窗口又能打开」——这种不一致没有任何人会把当 bug 报上来，
/// 所以我选择让它在编译期/测试期就无处可藏。
///
/// 顺序有意义：**长后缀必须排在它的短尾之前**（`.tar.gz` 在 `.gz` 前），
/// 否则 `a.tar.gz` 会先命中 `.gz` 被当成单流压缩包。
pub(crate) const ARCHIVE_SUFFIXES: &[(&str, Kind)] = &[
    (".tar.gz", Kind::TarGz),
    (".tar.bz2", Kind::TarBz2),
    (".tar.xz", Kind::TarXz),
    (".tgz", Kind::TarGz),
    (".tbz2", Kind::TarBz2),
    (".tbz", Kind::TarBz2),
    (".txz", Kind::TarXz),
    (".zip", Kind::Zip),
    (".zipx", Kind::Zip),
    (".cbz", Kind::Zip),
    (".7z", Kind::SevenZ),
    (".cb7", Kind::SevenZ),
    (".rar", Kind::Rar),
    (".cbr", Kind::Rar),
    (".tar", Kind::Tar),
    (".gz", Kind::Gz),
    (".bz2", Kind::Bz2),
    (".xz", Kind::Xz),
];

/// 按后缀名判类型。传进来的名字必须已经小写。
pub(crate) fn kind_of_suffix(name: &str) -> Option<Kind> {
    ARCHIVE_SUFFIXES
        .iter()
        .find(|(suffix, _)| name.ends_with(suffix))
        .map(|(_, kind)| *kind)
}

/// 文件对话框过滤器用的裸扩展名。
///
/// 对话框只看最后一段，所以 `.tar.gz` 只需列一次 `gz`——这正是原来手写清单的
/// 做法（里面有 gz 没有 tar.gz），这里保持同一语义，只是改成从表里推出来，
/// 不再有第二份手抄。
pub(crate) fn archive_ext_names() -> Vec<&'static str> {
    let mut out: Vec<&'static str> = Vec::new();
    for (suffix, _) in ARCHIVE_SUFFIXES {
        let last = suffix.rsplit('.').next().unwrap_or("");
        if !last.is_empty() && !out.contains(&last) {
            out.push(last);
        }
    }
    out
}

pub fn detect(path: &Path) -> Result<Kind> {
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if let Some(k) = kind_of_suffix(&name) {
        return Ok(k);
    }
    // 后缀靠不住时（被改过、或者干脆没有后缀）再看文件头。
    sniff(path)
}

fn sniff(path: &Path) -> Result<Kind> {
    use std::io::Read;
    let mut f = fs::File::open(path).with_context(|| format!("无法打开 {}", path.display()))?;
    let mut head = [0u8; 512];
    let n = f.read(&mut head)?;
    let b = &head[..n];
    if b.starts_with(b"PK\x03\x04") || b.starts_with(b"PK\x05\x06") {
        return Ok(Kind::Zip);
    }
    if b.starts_with(b"7z\xbc\xaf\x27\x1c") {
        return Ok(Kind::SevenZ);
    }
    if b.starts_with(b"Rar!\x1a\x07") {
        return Ok(Kind::Rar);
    }
    if b.starts_with(b"\x1f\x8b") {
        return Ok(Kind::Gz);
    }
    if b.starts_with(b"BZh") {
        return Ok(Kind::Bz2);
    }
    if b.starts_with(b"\xfd7zXZ\x00") {
        return Ok(Kind::Xz);
    }
    if b.len() >= 262 && &b[257..262] == b"ustar" {
        return Ok(Kind::Tar);
    }
    bail!("无法识别的压缩包格式；支持 ZIP / 7Z / TAR / TAR.GZ / TAR.BZ2 / TAR.XZ / GZ / BZ2 / XZ / RAR")
}

fn modified_string(parts: Option<(u16, u8, u8, u8, u8, u8)>) -> String {
    match parts {
        Some((y, mo, d, h, mi, s)) => format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}"),
        None => "—".to_string(),
    }
}

fn zip_entry_info<R: std::io::Read + ?Sized>(
    index: usize,
    e: &zip::read::ZipFile<'_, R>,
) -> EntryInfo {
    let name = e
        .name()
        .map(|n| n.replace('\\', "/"))
        .unwrap_or_else(|_| "(无效文件名)".to_string());
    let is_dir = e.is_dir() || name.ends_with('/');
    let modified = e.last_modified().map(|d| {
        modified_string(Some((
            d.year(),
            d.month(),
            d.day(),
            d.hour(),
            d.minute(),
            d.second(),
        )))
    });
    EntryInfo {
        index,
        name,
        is_dir,
        size: e.size(),
        packed: e.compressed_size(),
        modified: modified.unwrap_or_else(|| "—".to_string()),
        encrypted: e.encrypted(),
        crc: e.crc32(),
    }
}

pub fn list_archive(path: &Path, password: Option<&str>) -> Result<ArchiveInfo> {
    let kind = detect(path)?;
    match kind {
        Kind::Zip => {
            let mut zip = zip_impl::open(path)?;
            let mut entries = Vec::with_capacity(zip.len());
            for i in 0..zip.len() {
                let e = zip.by_index_raw(i)?;
                entries.push(zip_entry_info(i, &e));
            }
            let total_size = entries.iter().filter(|e| !e.is_dir).map(|e| e.size).sum();
            let total_packed = entries.iter().filter(|e| !e.is_dir).map(|e| e.packed).sum();
            let encrypted = entries.iter().any(|e| e.encrypted);
            Ok(ArchiveInfo {
                path: path.display().to_string(),
                format: kind.label().into(),
                entries,
                total_size,
                total_packed,
                encrypted,
                solid: false,
                comment: String::new(),
                needs_rar: false,
                rar_ready: true,
            })
        }
        Kind::SevenZ => sevenz_impl::list(path, password),
        Kind::Tar | Kind::TarGz | Kind::TarBz2 | Kind::TarXz => {
            tar_impl::list(path, kind, password)
        }
        Kind::Gz | Kind::Bz2 | Kind::Xz => tar_impl::list_single(path, kind),
        Kind::Rar => rar::list(path, password),
    }
}

fn resolve_selected_indices(info: &ArchiveInfo, indices: Option<Vec<usize>>) -> HashSet<usize> {
    let mut selected: HashSet<usize> = match indices {
        Some(v) => v.into_iter().collect(),
        None => info
            .entries
            .iter()
            .filter(|e| !e.is_dir)
            .map(|e| e.index)
            .collect(),
    };
    let dirs: Vec<String> = info
        .entries
        .iter()
        .filter(|e| e.is_dir && selected.contains(&e.index))
        .map(|e| e.name.trim_end_matches('/').to_string() + "/")
        .collect();
    if !dirs.is_empty() {
        for e in &info.entries {
            if dirs.iter().any(|d| e.name.starts_with(d)) {
                selected.insert(e.index);
            }
        }
    }
    selected
}

pub fn check_extract_conflicts(
    path: &Path,
    out_dir: &Path,
    indices: Option<Vec<usize>>,
    password: Option<&str>,
    create_subfolder: bool,
) -> Result<ExtractConflictInfo> {
    let out_meta = fs::symlink_metadata(out_dir).ok();
    let out_dir_is_file = out_meta.as_ref().is_some_and(|m| !m.is_dir());
    let out_dir_exists = out_meta.is_some();
    let suggested_out_dir = if out_dir_exists {
        util::unique_dir_path(out_dir).display().to_string()
    } else {
        out_dir.display().to_string()
    };

    if out_dir_is_file {
        let name = out_dir
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| out_dir.display().to_string());
        return Ok(ExtractConflictInfo {
            has_conflicts: true,
            out_dir_exists: true,
            out_dir_is_file: true,
            suggested_out_dir,
            file_conflicts: 1,
            dir_conflicts: 0,
            samples: vec![ConflictSample { name, is_dir: false }],
        });
    }

    if !out_dir_exists {
        return Ok(ExtractConflictInfo {
            has_conflicts: false,
            out_dir_exists: false,
            out_dir_is_file: false,
            suggested_out_dir,
            file_conflicts: 0,
            dir_conflicts: 0,
            samples: Vec::new(),
        });
    }

    let info = list_archive(path, password)?;
    let selected = resolve_selected_indices(&info, indices);
    let mut file_conflicts = 0u64;
    let mut dir_conflicts = 0u64;
    let mut seen_dirs: HashSet<String> = HashSet::new();
    let mut seen_files: HashSet<String> = HashSet::new();
    let mut samples: Vec<ConflictSample> = Vec::new();

    for e in &info.entries {
        if !selected.contains(&e.index) {
            continue;
        }
        let Ok(rel) = util::safe_relative(&e.name) else {
            continue;
        };
        let mut comps = rel.components();
        let Some(std::path::Component::Normal(first_os)) = comps.next() else {
            continue;
        };
        let first = first_os.to_string_lossy().to_string();
        let has_nested = comps.next().is_some();
        if e.is_dir || has_nested {
            let low = first.to_lowercase();
            if seen_dirs.insert(low) && fs::symlink_metadata(out_dir.join(&first)).is_ok() {
                dir_conflicts += 1;
                if samples.len() < 8 {
                    samples.push(ConflictSample {
                        name: first,
                        is_dir: true,
                    });
                }
            }
        }
        if !e.is_dir {
            let target = out_dir.join(&rel);
            let low = target.to_string_lossy().to_lowercase();
            if seen_files.insert(low) && fs::symlink_metadata(&target).is_ok() {
                file_conflicts += 1;
                if samples.len() < 8 {
                    samples.push(ConflictSample {
                        name: rel.to_string_lossy().replace('\\', "/"),
                        is_dir: false,
                    });
                }
            }
        }
    }

    let subfolder_clash = create_subfolder && out_dir_exists;
    if subfolder_clash && samples.is_empty() {
        let name = out_dir
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| out_dir.display().to_string());
        samples.push(ConflictSample { name, is_dir: true });
    }

    Ok(ExtractConflictInfo {
        has_conflicts: subfolder_clash || file_conflicts > 0 || dir_conflicts > 0,
        out_dir_exists,
        out_dir_is_file: false,
        suggested_out_dir,
        file_conflicts,
        dir_conflicts: if subfolder_clash && dir_conflicts == 0 {
            1
        } else {
            dir_conflicts
        },
        samples,
    })
}

pub fn check_create_conflict(dest: &Path) -> CreateConflictInfo {
    let meta = fs::symlink_metadata(dest).ok();
    let exists = meta.is_some();
    let is_dir = meta.as_ref().is_some_and(|m| m.is_dir()) || util::is_reparse(dest);
    let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
    let modified = meta
        .as_ref()
        .map(|m| modified_string(util::filetime_to_local_parts(util::metadata_filetime(m))))
        .unwrap_or_else(|| "—".to_string());
    let suggested_dest = if exists {
        util::unique_archive_path(dest).display().to_string()
    } else {
        dest.display().to_string()
    };
    CreateConflictInfo {
        exists,
        is_dir,
        size,
        modified,
        suggested_dest,
    }
}

#[allow(clippy::too_many_arguments)]
pub fn extract_archive(
    ctx: Option<&ArchiveCtx>,
    path: &Path,
    out_dir: &Path,
    indices: Option<Vec<usize>>,
    password: Option<&str>,
    policy: Overwrite,
    mode: &str,
    progress: &Arc<Progress>,
    control: &Arc<TaskControl>,
) -> Result<ExtractReport> {
    let profile = PerfProfile::from_mode(mode);
    let _prio = ThreadPriorityGuard::enter(profile.mode);
    progress.set_mode(profile.mode);
    let kind = detect(path)?;
    let info = list_archive(path, password)?;
    if info.needs_rar {
        bail!("RAR 组件尚未安装");
    }

    let selected = resolve_selected_indices(&info, indices);
    if selected.is_empty() {
        bail!("没有选中要解压的文件");
    }

    let total_bytes: u64 = info
        .entries
        .iter()
        .filter(|e| selected.contains(&e.index) && !e.is_dir)
        .map(|e| e.size)
        .sum();
    let total_files = info
        .entries
        .iter()
        .filter(|e| selected.contains(&e.index) && !e.is_dir)
        .count() as u64;
    progress.set_totals(total_files, total_bytes);

    let dir_map: HashMap<String, String> = if policy == Overwrite::Rename {
        undo::build_dir_rename_map(
            out_dir,
            info.entries
                .iter()
                .filter(|e| selected.contains(&e.index))
                .map(|e| (e.name.as_str(), e.is_dir)),
        )
    } else {
        HashMap::new()
    };

    let tracker = Arc::new(UndoTracker::new(
        "extract",
        out_dir.to_path_buf(),
        &data_dir_for_rar(),
    ));
    tracker
        .ensure_dir(out_dir)
        .with_context(|| format!("无法创建目标目录 {}", out_dir.display()))?;

    let res = match kind {
        Kind::Zip => zip_impl::extract(
            path,
            out_dir,
            &selected,
            password,
            policy,
            profile,
            &dir_map,
            Some(&tracker),
            progress,
            control,
        ),
        Kind::SevenZ => sevenz_impl::extract(
            path,
            out_dir,
            &selected,
            password,
            policy,
            profile,
            &dir_map,
            Some(&tracker),
            progress,
            control,
        ),
        Kind::Tar | Kind::TarGz | Kind::TarBz2 | Kind::TarXz => tar_impl::extract(
            path,
            out_dir,
            kind,
            &selected,
            password,
            policy,
            profile,
            &dir_map,
            Some(&tracker),
            progress,
            control,
        ),
        Kind::Gz | Kind::Bz2 | Kind::Xz => tar_impl::extract_single(
            path,
            out_dir,
            kind,
            &selected,
            policy,
            profile,
            Some(&tracker),
            progress,
            control,
        ),
        Kind::Rar => rar::extract(
            path,
            out_dir,
            &selected,
            password,
            policy,
            profile,
            &dir_map,
            Some(&tracker),
            progress,
            control,
        ),
    };

    match res {
        Ok(mut report) => {
            let record = tracker.finalize();
            let incomplete = record.backup_incomplete;
            if let Some(c) = ctx {
                if !record.is_empty() {
                    let id = record.id.clone();
                    c.push_undo(record);
                    report.undo_id = Some(id);
                    report.can_undo = true;
                    report.backup_incomplete = incomplete;
                } else {
                    record.cleanup_backup_dir();
                }
            } else {
                record.cleanup_backup_dir();
            }
            Ok(report)
        }
        Err(e) => {
            tracker.rollback_on_error();
            Err(e)
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub fn create_archive(
    ctx: Option<&ArchiveCtx>,
    sources: &[PathBuf],
    dest: &Path,
    format: &str,
    mode: &str,
    password: Option<&str>,
    progress: &Arc<Progress>,
    control: &Arc<TaskControl>,
) -> Result<CreateReport> {
    if sources.is_empty() {
        bail!("请先选择要压缩的文件或文件夹");
    }
    if fs::symlink_metadata(dest).is_ok_and(|m| m.is_dir()) {
        bail!("目标路径是一个已存在的文件夹，无法作为压缩包写入");
    }
    if util::is_reparse(dest) {
        bail!("目标路径为符号链接或重解析点，禁止直接覆盖");
    }
    let profile = PerfProfile::from_mode(mode);
    let _prio = ThreadPriorityGuard::enter(profile.mode);
    progress.set_mode(profile.mode);
    let started = Instant::now();

    let root_dir = dest
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    let tracker = Arc::new(UndoTracker::new("create", root_dir, &data_dir_for_rar()));
    if let Some(parent) = dest.parent() {
        tracker.ensure_dir(parent)?;
    }

    let tmp = dest.with_extension(format!(
        "{}part",
        dest.extension()
            .map(|e| format!("{}.", e.to_string_lossy()))
            .unwrap_or_default()
    ));
    if tmp.exists() {
        let _ = fs::remove_file(&tmp);
    }
    let result = match format {
        "zip" => zip_impl::create(sources, &tmp, password, profile, progress, control),
        "7z" | "sevenz" => sevenz_impl::create(sources, &tmp, password, profile, progress, control),
        "tar" => tar_impl::create_tar(sources, &tmp, profile, progress, control),
        "tgz" | "tar.gz" => tar_impl::create_tgz(sources, &tmp, profile, progress, control),
        _ => bail!("不支持创建 {format} 格式；可选 ZIP / 7Z / TAR / TAR.GZ"),
    };
    if let Err(e) = result {
        let _ = fs::remove_file(&tmp);
        tracker.rollback_on_error();
        return Err(e);
    }

    if let Err(e) = tracker.prepare_file_write(dest, Overwrite::Overwrite) {
        let _ = fs::remove_file(&tmp);
        tracker.rollback_on_error();
        return Err(e);
    }
    if dest.exists() {
        if let Err(e) = fs::remove_file(dest).with_context(|| format!("无法覆盖 {}", dest.display())) {
            let _ = fs::remove_file(&tmp);
            tracker.rollback_on_error();
            return Err(e);
        }
    }
    if let Err(e) = fs::rename(&tmp, dest).with_context(|| format!("无法写入 {}", dest.display())) {
        let _ = fs::remove_file(&tmp);
        tracker.rollback_on_error();
        return Err(e);
    }
    tracker.record_created_file(dest);
    let packed = fs::metadata(dest).map(|m| m.len()).unwrap_or(0);

    let record = tracker.finalize();
    let incomplete = record.backup_incomplete;
    let (undo_id, can_undo) = if let Some(c) = ctx {
        if !record.is_empty() {
            let id = record.id.clone();
            c.push_undo(record);
            (Some(id), true)
        } else {
            record.cleanup_backup_dir();
            (None, false)
        }
    } else {
        record.cleanup_backup_dir();
        (None, false)
    };

    Ok(CreateReport {
        path: dest.display().to_string(),
        format: format.to_string(),
        files: progress.files_count(),
        bytes: progress.bytes_count(),
        packed,
        elapsed_ms: started.elapsed().as_millis() as u64,
        undo_id,
        can_undo,
        backup_incomplete: incomplete,
    })
}

pub fn preview_archive(
    app: &AppHandle,
    ctx: &ArchiveCtx,
    path: &Path,
    index: usize,
    password: Option<&str>,
    hint: Option<(&str, u64)>,
) -> Result<PreviewData> {
    let kind = detect(path)?;
    let dir = prepare_preview_dir(app, ctx)?;
    preview::read_entry(kind, path, index, password, &dir, hint)
}

/// 预览文件目录按进程固定（`preview/<pid>`）。以前每次预览都先 `remove_dir_all`
/// 上一份再建新目录，正在加载的图片/PDF 会被当场删掉，连续双击还会互相踩。
fn prepare_preview_dir(_app: &AppHandle, ctx: &ArchiveCtx) -> Result<PathBuf> {
    if let Ok(slot) = ctx.preview_dir.lock() {
        if let Some(dir) = slot.as_ref() {
            if dir.is_dir() {
                return Ok(dir.clone());
            }
        }
    }
    let dir = data_dir()
        .join("preview")
        .join(std::process::id().to_string());
    fs::create_dir_all(&dir)?;
    if let Ok(mut slot) = ctx.preview_dir.lock() {
        *slot = Some(dir.clone());
    }
    Ok(dir)
}

pub fn clear_preview(ctx: &ArchiveCtx) {
    if let Ok(mut old) = ctx.preview_dir.lock() {
        if let Some(p) = old.take() {
            let _ = fs::remove_dir_all(p);
        }
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn archive_open(
    path: String,
    password: Option<String>,
) -> Result<ArchiveInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        if !p.exists() {
            return Err(format!("文件不存在: {path}"));
        }
        list_archive(&p, password.as_deref()).map_err(util::io_err)
    })
    .await
    .map_err(|e| format!("任务失败: {e}"))?
}

#[tauri::command]
pub async fn archive_check_extract_conflicts(
    path: String,
    out_dir: String,
    indices: Option<Vec<usize>>,
    password: Option<String>,
    create_subfolder: Option<bool>,
) -> Result<ExtractConflictInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        check_extract_conflicts(
            Path::new(&path),
            Path::new(&out_dir),
            indices,
            password.as_deref(),
            create_subfolder.unwrap_or(false),
        )
        .map_err(util::io_err)
    })
    .await
    .map_err(|e| format!("冲突检查失败: {e}"))?
}

#[tauri::command]
pub async fn archive_check_create_conflict(dest: String) -> Result<CreateConflictInfo, String> {
    tauri::async_runtime::spawn_blocking(move || check_create_conflict(Path::new(&dest)))
        .await
        .map_err(|e| format!("冲突检查失败: {e}"))
}

#[tauri::command]
pub async fn archive_undo(
    state: State<'_, ArchiveCtx>,
    undo_id: String,
) -> Result<UndoReport, String> {
    let ctx = state.inner().clone();
    let guard = ctx.begin(None).map_err(|e| format!("{e:#}"))?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let Some(record) = ctx.take_undo(&undo_id) else {
            bail!("未找到可撤回记录，可能已撤回或已被新任务覆盖");
        };
        undo::execute_undo(record)
    })
    .await
    .map_err(|e| format!("撤回任务失败: {e}"))?
    .map_err(util::io_err);
    drop(guard);
    result
}

#[tauri::command]
pub async fn archive_extract(
    app: AppHandle,
    state: State<'_, ArchiveCtx>,
    path: String,
    out_dir: String,
    indices: Option<Vec<usize>>,
    password: Option<String>,
    overwrite: Option<String>,
    mode: Option<String>,
) -> Result<ExtractReport, String> {
    let ctx = state.inner().clone();
    let progress = Arc::new(Progress::new(app, "extract"));
    let guard = ctx.begin(Some(progress.clone())).map_err(|e| format!("{e:#}"))?;
    let control = ctx.control.clone();
    let ctx_for_run = ctx.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let policy = Overwrite::parse(overwrite.as_deref().unwrap_or("rename"));
        let mode = mode.as_deref().unwrap_or("balanced");
        extract_archive(
            Some(&ctx_for_run),
            Path::new(&path),
            Path::new(&out_dir),
            indices,
            password.as_deref(),
            policy,
            mode,
            &progress,
            &control,
        )
        .map_err(util::io_err)
    })
    .await
    .map_err(|e| format!("任务失败: {e}"))?;
    drop(guard);
    result
}

#[tauri::command]
pub async fn archive_create(
    app: AppHandle,
    state: State<'_, ArchiveCtx>,
    sources: Vec<String>,
    dest: String,
    format: String,
    mode: Option<String>,
    password: Option<String>,
) -> Result<CreateReport, String> {
    let ctx = state.inner().clone();
    let progress = Arc::new(Progress::new(app, "create"));
    let guard = ctx.begin(Some(progress.clone())).map_err(|e| format!("{e:#}"))?;
    let control = ctx.control.clone();
    let ctx_for_run = ctx.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let sources: Vec<PathBuf> = sources.into_iter().map(PathBuf::from).collect();
        create_archive(
            Some(&ctx_for_run),
            &sources,
            Path::new(&dest),
            &format,
            mode.as_deref().unwrap_or("balanced"),
            password.as_deref(),
            &progress,
            &control,
        )
        .map_err(util::io_err)
    })
    .await
    .map_err(|e| format!("任务失败: {e}"))?;
    drop(guard);
    result
}

#[tauri::command]
pub fn archive_pause(state: State<'_, ArchiveCtx>) -> bool {
    if !state.busy.load(Ordering::Acquire) {
        return false;
    }
    if state.control.set_paused(true) {
        if let Ok(slot) = state.active_progress.lock() {
            if let Some(p) = slot.as_ref() {
                p.set_paused(true);
            }
        }
        return true;
    }
    false
}

#[tauri::command]
pub fn archive_resume(state: State<'_, ArchiveCtx>) -> bool {
    if !state.busy.load(Ordering::Acquire) {
        return false;
    }
    if state.control.set_paused(false) {
        if let Ok(slot) = state.active_progress.lock() {
            if let Some(p) = slot.as_ref() {
                p.set_paused(false);
            }
        }
        return true;
    }
    false
}

#[tauri::command]
pub fn archive_cancel(state: State<'_, ArchiveCtx>) -> bool {
    state.control.request_cancel();
    if let Ok(slot) = state.active_progress.lock() {
        if let Some(p) = slot.as_ref() {
            p.mark_cancelling();
        }
    }
    true
}

#[tauri::command]
pub async fn archive_preview(
    app: AppHandle,
    state: State<'_, ArchiveCtx>,
    path: String,
    index: usize,
    password: Option<String>,
    name: Option<String>,
    size: Option<u64>,
) -> Result<PreviewData, String> {
    let ctx = state.inner().clone();
    let app2 = app.clone();
    let hint = name.map(|n| (n, size.unwrap_or(0)));
    tauri::async_runtime::spawn_blocking(move || {
        let hint = hint.as_ref().map(|(n, s)| (n.as_str(), *s));
        preview_archive(&app2, &ctx, Path::new(&path), index, password.as_deref(), hint)
            .map_err(util::io_err)
    })
    .await
    .map_err(|e| format!("任务失败: {e}"))?
}

#[tauri::command]
pub fn archive_preview_clear(state: State<'_, ArchiveCtx>) {
    clear_preview(state.inner());
}

#[tauri::command]
// app 参数没有用到（下面的闭包不捕获它），但 tauri::command 的签名里保留它
// 让前端调用形态与其他命令一致；下划线前缀表明这是有意的，不是漏传。
pub async fn archive_rar_status(_app: AppHandle) -> Result<RarStatus, String> {
    tauri::async_runtime::spawn_blocking(move || rar::status(&data_dir()).map_err(util::io_err))
        .await
        .map_err(|e| format!("任务失败: {e}"))?
}

#[tauri::command]
pub async fn archive_rar_install(
    app: AppHandle,
    state: State<'_, ArchiveCtx>,
) -> Result<RarStatus, String> {
    let ctx = state.inner().clone();
    let guard = ctx.begin(None).map_err(|e| format!("{e:#}"))?;
    let app2 = app.clone();
    let control = ctx.control.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        rar::install(&app2, &data_dir(), &control).map_err(util::io_err)
    })
    .await
    .map_err(|e| format!("任务失败: {e}"))?;
    drop(guard);
    result
}

#[tauri::command]
pub async fn pick_archive() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        // 过滤器从 ARCHIVE_SUFFIXES 推出来，不再是第二份手抄清单。
        let names = archive_ext_names();
        rfd::FileDialog::new()
            .add_filter("压缩包", &names)
            .add_filter("所有文件", &["*"])
            .pick_file()
            .map(|p| p.display().to_string())
    })
    .await
    .map_err(|e| format!("任务失败: {e}"))
}

#[tauri::command]
pub async fn pick_files() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let files = rfd::FileDialog::new().pick_files().unwrap_or_default();
        files
            .into_iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|e| format!("任务失败: {e}"))
}

#[tauri::command]
pub async fn pick_archive_save(default_name: Option<String>) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut dlg = rfd::FileDialog::new()
            .add_filter("ZIP 压缩包", &["zip"])
            .add_filter("7Z 压缩包", &["7z"])
            .add_filter("TAR 归档", &["tar"])
            .add_filter("TAR.GZ 归档", &["tgz", "gz"]);
        if let Some(name) = default_name {
            dlg = dlg.set_file_name(name);
        }
        dlg.save_file().map(|p| p.display().to_string())
    })
    .await
    .map_err(|e| format!("任务失败: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 长后缀必须先匹配：`a.tar.gz` 是 TarGz，不是 Gz。
    ///
    /// 这条不只是「表里顺序对不对」，它固定的是 ARCHIVE_SUFFIXES 的唯一硬约束。
    /// 顺序错了不会有编译错误、不会有警告，只会让 tar.gz 被当成单流 gzip 打开，
    /// 用户看到的是一堆乱码一样的 tar 头。
    #[test]
    fn longest_suffix_wins() {
        assert_eq!(kind_of_suffix("a.tar.gz"), Some(Kind::TarGz));
        assert_eq!(kind_of_suffix("a.tar.bz2"), Some(Kind::TarBz2));
        assert_eq!(kind_of_suffix("a.tar.xz"), Some(Kind::TarXz));
        assert_eq!(kind_of_suffix("a.gz"), Some(Kind::Gz));
        assert_eq!(kind_of_suffix("a.bz2"), Some(Kind::Bz2));
        assert_eq!(kind_of_suffix("a.xz"), Some(Kind::Xz));
        assert_eq!(kind_of_suffix("a.tar"), Some(Kind::Tar));
    }

    /// 表里每一项都能被自己匹配到，没有写了却永远命不中的死条目。
    #[test]
    fn every_suffix_resolves_to_its_own_kind() {
        for (suffix, kind) in ARCHIVE_SUFFIXES {
            let name = format!("x{suffix}");
            assert_eq!(
                kind_of_suffix(&name),
                Some(*kind),
                "后缀 {suffix} 在表里，但匹配不到它自己"
            );
        }
    }

    /// 过滤器里的裸扩展名必须覆盖表中所有后缀的最后一段。
    ///
    /// 对话框只认最后一段，漏一个的表现是「这个格式能打开，但在选择框里挑不出来」。
    #[test]
    fn filter_names_cover_every_suffix() {
        let names = archive_ext_names();
        for (suffix, _) in ARCHIVE_SUFFIXES {
            let last = suffix.rsplit('.').next().unwrap();
            assert!(
                names.contains(&last),
                "后缀 {suffix} 的扩展名 {last} 没进对话框过滤器（当前：{names:?}）"
            );
        }
        let mut sorted = names.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), names.len(), "过滤器里有重复扩展名：{names:?}");
    }

    /// 前端那份正则是同一份知识的第三处副本，这条测试直接读 JS 源码比对。
    ///
    /// 为什么值得跨语言读文件做断言：漂移的表现不是崩溃，而是「拖进窗口能打开、
    /// 但从页面上的判断走另一条路」——没人会把它当 bug 报上来，只会觉得软件偶尔
    /// 怪一下。宁可让测试在 CI 里红，也不要这种静默不一致。
    #[test]
    fn js_regex_covers_every_suffix() {
        let js_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("web")
            .join("js")
            .join("pages")
            .join("archive.js");
        let src = match fs::read_to_string(&js_path) {
            Ok(s) => s,
            // 读不到 web 目录时不该让构建失败，但也不能假装验证过了。
            Err(e) => {
                eprintln!("跳过 JS 正则比对（读不到 {}: {e}）", js_path.display());
                return;
            }
        };
        let line = src
            .lines()
            .find(|l| l.contains("const ARCHIVE_EXT"))
            .expect("archive.js 里找不到 ARCHIVE_EXT 定义");
        for (suffix, _) in ARCHIVE_SUFFIXES {
            // 正则写成 `tar\.(?:gz|bz2|xz)` 这种分段形式，逐段核对字面量。
            let parts: Vec<&str> = suffix.trim_start_matches('.').split('.').collect();
            for part in &parts {
                assert!(
                    line.contains(part),
                    "前端正则漏了 {part}（来自后缀 {suffix}）：{line}"
                );
            }
        }
    }

    #[test]
    fn extract_conflict_check_coexist_folder_and_undo() {
        let root = PathBuf::from("D:\\Builds\\tidy-mod-tests")
            .join(format!("coexist_{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let src = root.join("src");
        fs::create_dir_all(src.join("proj")).unwrap();
        fs::write(src.join("proj/a.txt"), b"from-archive-a").unwrap();
        fs::write(src.join("readme.txt"), b"from-archive-readme").unwrap();

        let zip = root.join("bundle.zip");
        let p0 = Arc::new(Progress::detached());
        let c0 = Arc::new(TaskControl::default());
        create_archive(
            None,
            &[src.join("proj"), src.join("readme.txt")],
            &zip,
            "zip",
            "hyper",
            None,
            &p0,
            &c0,
        )
        .unwrap();

        // 目标目录已有同名目录 proj/old.txt 与同名文件 readme.txt
        let out = root.join("out");
        fs::create_dir_all(out.join("proj")).unwrap();
        fs::write(out.join("proj/old.txt"), b"keep-old-dir").unwrap();
        fs::write(out.join("readme.txt"), b"keep-old-file").unwrap();

        let chk = check_extract_conflicts(&zip, &out, None, None, false).unwrap();
        assert!(chk.has_conflicts);
        assert!(chk.dir_conflicts >= 1);
        assert!(chk.file_conflicts >= 1);

        let ctx = ArchiveCtx::default();
        let p1 = Arc::new(Progress::detached());
        let c1 = Arc::new(TaskControl::default());
        let rep = extract_archive(
            Some(&ctx),
            &zip,
            &out,
            None,
            None,
            Overwrite::Rename,
            "hyper",
            &p1,
            &c1,
        )
        .unwrap();
        assert!(rep.can_undo);
        let undo_id = rep.undo_id.clone().expect("应生成 undo_id");

        // 并存：原有目录和文件毫发无伤，新内容自动改名为 proj (2) 与 readme (2).txt
        assert_eq!(fs::read(out.join("proj/old.txt")).unwrap(), b"keep-old-dir");
        assert_eq!(fs::read(out.join("readme.txt")).unwrap(), b"keep-old-file");
        assert_eq!(
            fs::read(out.join("proj (2)/a.txt")).unwrap(),
            b"from-archive-a"
        );
        assert_eq!(
            fs::read(out.join("readme (2).txt")).unwrap(),
            b"from-archive-readme"
        );

        // 撤回解压：仅删新建的 proj (2) 与 readme (2).txt，绝不动原有 proj/old.txt 与 readme.txt
        let rec = ctx.take_undo(&undo_id).expect("应能取出 undo 记录");
        let urep = undo::execute_undo(rec).unwrap();
        assert_eq!(urep.removed_files, 2);
        assert!(!out.join("proj (2)").exists());
        assert!(!out.join("readme (2).txt").exists());
        assert_eq!(fs::read(out.join("proj/old.txt")).unwrap(), b"keep-old-dir");
        assert_eq!(fs::read(out.join("readme.txt")).unwrap(), b"keep-old-file");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn extract_overwrite_and_undo_restores_original() {
        let root = PathBuf::from("D:\\Builds\\tidy-mod-tests")
            .join(format!("ow_undo_{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let src = root.join("src");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("doc.txt"), b"new-content-from-zip").unwrap();
        fs::write(src.join("added.txt"), b"brand-new-file").unwrap();

        let zip = root.join("p.zip");
        let p0 = Arc::new(Progress::detached());
        let c0 = Arc::new(TaskControl::default());
        create_archive(
            None,
            &[src.join("doc.txt"), src.join("added.txt")],
            &zip,
            "zip",
            "balanced",
            None,
            &p0,
            &c0,
        )
        .unwrap();

        let out = root.join("out");
        fs::create_dir_all(&out).unwrap();
        fs::write(out.join("doc.txt"), b"original-user-bytes").unwrap();

        let ctx = ArchiveCtx::default();
        let p1 = Arc::new(Progress::detached());
        let c1 = Arc::new(TaskControl::default());
        let rep = extract_archive(
            Some(&ctx),
            &zip,
            &out,
            None,
            None,
            Overwrite::Overwrite,
            "hyper",
            &p1,
            &c1,
        )
        .unwrap();
        assert_eq!(fs::read(out.join("doc.txt")).unwrap(), b"new-content-from-zip");
        assert_eq!(fs::read(out.join("added.txt")).unwrap(), b"brand-new-file");

        let rec = ctx.take_undo(rep.undo_id.as_deref().unwrap()).unwrap();
        let urep = undo::execute_undo(rec).unwrap();
        assert_eq!(urep.removed_files, 1);
        assert_eq!(urep.restored_files, 1);
        assert_eq!(fs::read(out.join("doc.txt")).unwrap(), b"original-user-bytes");
        assert!(!out.join("added.txt").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn create_conflict_and_undo_overwrite_and_new() {
        let root = PathBuf::from("D:\\Builds\\tidy-mod-tests")
            .join(format!("create_undo_{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let src = root.join("src");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("hello.txt"), b"hello-zip").unwrap();

        let dest = root.join("archive.zip");
        let chk_empty = check_create_conflict(&dest);
        assert!(!chk_empty.exists);

        let ctx = ArchiveCtx::default();
        let p1 = Arc::new(Progress::detached());
        let c1 = Arc::new(TaskControl::default());
        let r1 = create_archive(
            Some(&ctx),
            &[src.join("hello.txt")],
            &dest,
            "zip",
            "balanced",
            None,
            &p1,
            &c1,
        )
        .unwrap();
        assert!(dest.exists());
        assert!(r1.can_undo);

        // 已有压缩包时冲突检测应给出 suggestedDest
        let chk_hit = check_create_conflict(&dest);
        assert!(chk_hit.exists && !chk_hit.is_dir);
        assert!(chk_hit.suggested_dest.ends_with("archive (2).zip"));

        // 撤回新建压缩包 -> 删除压缩包，且不可二次撤回
        let id1 = r1.undo_id.unwrap();
        let rec1 = ctx.take_undo(&id1).unwrap();
        let u1 = undo::execute_undo(rec1).unwrap();
        assert_eq!(u1.removed_files, 1);
        assert!(!dest.exists());
        assert!(ctx.take_undo(&id1).is_none(), "同一撤回 ID 不可二次使用");

        // 覆盖已有压缩包 -> 撤回后按字节还原旧压缩包
        fs::write(&dest, b"OLD-ARCHIVE-SIGNATURE-12345").unwrap();
        let p2 = Arc::new(Progress::detached());
        let c2 = Arc::new(TaskControl::default());
        let r2 = create_archive(
            Some(&ctx),
            &[src.join("hello.txt")],
            &dest,
            "zip",
            "balanced",
            None,
            &p2,
            &c2,
        )
        .unwrap();
        assert_ne!(fs::read(&dest).unwrap(), b"OLD-ARCHIVE-SIGNATURE-12345");
        let rec2 = ctx.take_undo(r2.undo_id.as_deref().unwrap()).unwrap();
        let u2 = undo::execute_undo(rec2).unwrap();
        assert_eq!(u2.restored_files, 1);
        assert_eq!(fs::read(&dest).unwrap(), b"OLD-ARCHIVE-SIGNATURE-12345");

        let _ = fs::remove_dir_all(&root);
    }
}


