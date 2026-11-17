mod download;
mod preview;
mod rar;
mod sevenz_impl;
mod tar_impl;
mod util;
mod zip_impl;

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use anyhow::{bail, Context, Result};
use serde::Serialize;
use tauri::{AppHandle, State};

pub use util::{Overwrite, Progress};

use crate::data_dir;

/// 归档任务的性能档：只调当前工作线程的优先级，不改全局进程优先级。
/// saver 让出 CPU，hyper 抢在普通任务之前；balanced/performance 介于两者之间。
pub(super) fn set_thread_priority(mode: &str) {
    #[cfg(windows)]
    {
        #[link(name = "kernel32")]
        extern "system" {
            fn GetCurrentThread() -> isize;
            fn SetThreadPriority(handle: isize, priority: i32) -> i32;
        }
        let level = match mode {
            "saver" => -1,        // THREAD_PRIORITY_BELOW_NORMAL
            "performance" => 1,   // THREAD_PRIORITY_ABOVE_NORMAL
            "hyper" => 2,         // THREAD_PRIORITY_HIGHEST
            _ => 0,               // THREAD_PRIORITY_NORMAL
        };
        unsafe {
            SetThreadPriority(GetCurrentThread(), level);
        }
    }
    #[cfg(not(windows))]
    {
        let _ = mode;
    }
}

static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

/// The product data directory is fixed for the process lifetime. Archive
/// listing/extraction functions do not carry an AppHandle, so the RAR loader
/// reads the DLL path from here.
pub fn set_data_dir(path: PathBuf) {
    let _ = DATA_DIR.set(path);
    sweep_stale_preview_dirs();
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
    cancel: Arc<AtomicBool>,
    busy: Arc<AtomicBool>,
    preview_dir: Arc<Mutex<Option<PathBuf>>>,
}

pub struct OpGuard {
    ctx: ArchiveCtx,
}

impl Drop for OpGuard {
    fn drop(&mut self) {
        self.ctx.busy.store(false, Ordering::SeqCst);
    }
}

impl ArchiveCtx {
    fn begin(&self) -> Result<OpGuard> {
        if self.busy.swap(true, Ordering::SeqCst) {
            bail!("已有压缩或解压任务在运行，请先等待或取消");
        }
        self.cancel.store(false, Ordering::SeqCst);
        Ok(OpGuard { ctx: self.clone() })
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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractReport {
    pub files: u64,
    pub dirs: u64,
    pub bytes: u64,
    pub skipped: u64,
    pub warnings: Vec<String>,
    pub out_dir: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateReport {
    pub path: String,
    pub format: String,
    pub files: u64,
    pub bytes: u64,
    pub packed: u64,
    pub elapsed_ms: u64,
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

pub fn detect(path: &Path) -> Result<Kind> {
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    let kind = if name.ends_with(".tar.gz") || name.ends_with(".tgz") {
        Some(Kind::TarGz)
    } else if name.ends_with(".tar.bz2") || name.ends_with(".tbz2") || name.ends_with(".tbz") {
        Some(Kind::TarBz2)
    } else if name.ends_with(".tar.xz") || name.ends_with(".txz") {
        Some(Kind::TarXz)
    } else if name.ends_with(".zip") || name.ends_with(".zipx") || name.ends_with(".cbz") {
        Some(Kind::Zip)
    } else if name.ends_with(".7z") || name.ends_with(".cb7") {
        Some(Kind::SevenZ)
    } else if name.ends_with(".rar") || name.ends_with(".cbr") {
        Some(Kind::Rar)
    } else if name.ends_with(".tar") {
        Some(Kind::Tar)
    } else if name.ends_with(".gz") {
        Some(Kind::Gz)
    } else if name.ends_with(".bz2") {
        Some(Kind::Bz2)
    } else if name.ends_with(".xz") {
        Some(Kind::Xz)
    } else {
        None
    };
    if let Some(k) = kind {
        return Ok(k);
    }
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

pub fn extract_archive(
    path: &Path,
    out_dir: &Path,
    indices: Option<Vec<usize>>,
    password: Option<&str>,
    policy: Overwrite,
    mode: &str,
    progress: &Progress,
    cancel: &AtomicBool,
) -> Result<ExtractReport> {
    set_thread_priority(mode);
    let kind = detect(path)?;
    let info = list_archive(path, password)?;
    if info.needs_rar {
        bail!("RAR 组件尚未安装");
    }

    let mut selected: HashSet<usize> = match indices {
        Some(v) => v.into_iter().collect(),
        None => info
            .entries
            .iter()
            .filter(|e| !e.is_dir)
            .map(|e| e.index)
            .collect(),
    };
    // If a directory was selected, include every descendant.
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

    fs::create_dir_all(out_dir)
        .with_context(|| format!("无法创建目标目录 {}", out_dir.display()))?;

    match kind {
        Kind::Zip => zip_impl::extract(
            path, out_dir, &selected, password, policy, mode, progress, cancel,
        ),
        Kind::SevenZ => sevenz_impl::extract(
            path, out_dir, &selected, password, policy, progress, cancel,
        ),
        Kind::Tar | Kind::TarGz | Kind::TarBz2 | Kind::TarXz => tar_impl::extract(
            path, out_dir, kind, &selected, password, policy, progress, cancel,
        ),
        Kind::Gz | Kind::Bz2 | Kind::Xz => {
            tar_impl::extract_single(path, out_dir, kind, &selected, policy, progress, cancel)
        }
        Kind::Rar => rar::extract(
            path, out_dir, &selected, password, policy, progress, cancel,
        ),
    }
}

pub fn create_archive(
    sources: &[PathBuf],
    dest: &Path,
    format: &str,
    mode: &str,
    password: Option<&str>,
    progress: &Progress,
    cancel: &AtomicBool,
) -> Result<CreateReport> {
    if sources.is_empty() {
        bail!("请先选择要压缩的文件或文件夹");
    }
    let threads = match mode {
        "saver" => 1usize,
        "balanced" => 2,
        "performance" => 4,
        "hyper" => 8,
        _ => 2,
    };
    let threads = threads.min(std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4));
    set_thread_priority(mode);
    let started = Instant::now();
    let tmp = dest.with_extension(format!(
        "{}part",
        dest.extension()
            .map(|e| format!("{}.", e.to_string_lossy()))
            .unwrap_or_default()
    ));
    if tmp.exists() {
        let _ = fs::remove_file(&tmp);
    }
    // ZIP 的 Deflate 是单线程格式，用压缩级别换速度：档位越高越快、体积略大。
    let zip_level: i64 = match mode {
        "saver" => 1,
        "performance" => 3,
        "hyper" => 1,
        _ => 6,
    };
    let result = match format {
        "zip" => zip_impl::create(sources, &tmp, password, zip_level, progress, cancel),
        "7z" | "sevenz" => sevenz_impl::create(sources, &tmp, password, threads, progress, cancel),
        "tar" => tar_impl::create_tar(sources, &tmp, progress, cancel),
        "tgz" | "tar.gz" => tar_impl::create_tgz(sources, &tmp, progress, cancel),
        _ => bail!("不支持创建 {format} 格式；可选 ZIP / 7Z / TAR / TAR.GZ"),
    };
    if let Err(e) = result {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    if dest.exists() {
        fs::remove_file(dest).with_context(|| format!("无法覆盖 {}", dest.display()))?;
    }
    fs::rename(&tmp, dest).with_context(|| format!("无法写入 {}", dest.display()))?;
    let packed = fs::metadata(dest).map(|m| m.len()).unwrap_or(0);
    Ok(CreateReport {
        path: dest.display().to_string(),
        format: format.to_string(),
        files: progress.files_count(),
        bytes: progress.bytes_count(),
        packed,
        elapsed_ms: started.elapsed().as_millis() as u64,
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
    let guard = ctx.begin().map_err(|e| format!("{e:#}"))?;
    let progress = Progress::new(app, "extract");
    let cancel = ctx.cancel.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let policy = Overwrite::parse(overwrite.as_deref().unwrap_or("rename"));
        let mode = mode.as_deref().unwrap_or("balanced");
        extract_archive(
            Path::new(&path),
            Path::new(&out_dir),
            indices,
            password.as_deref(),
            policy,
            mode,
            &progress,
            &cancel,
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
    let guard = ctx.begin().map_err(|e| format!("{e:#}"))?;
    let progress = Progress::new(app, "create");
    let cancel = ctx.cancel.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let sources: Vec<PathBuf> = sources.into_iter().map(PathBuf::from).collect();
        create_archive(
            &sources,
            Path::new(&dest),
            &format,
            mode.as_deref().unwrap_or("balanced"),
            password.as_deref(),
            &progress,
            &cancel,
        )
        .map_err(util::io_err)
    })
    .await
    .map_err(|e| format!("任务失败: {e}"))?;
    drop(guard);
    result
}

#[tauri::command]
pub fn archive_cancel(state: State<'_, ArchiveCtx>) -> bool {
    state.cancel.store(true, Ordering::SeqCst);
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
pub async fn archive_rar_status(app: AppHandle) -> Result<RarStatus, String> {
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
    let guard = ctx.begin().map_err(|e| format!("{e:#}"))?;
    let app2 = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        rar::install(&app2, &data_dir(), &ctx.cancel).map_err(util::io_err)
    })
    .await
    .map_err(|e| format!("任务失败: {e}"))?;
    drop(guard);
    result
}

#[tauri::command]
pub async fn pick_archive() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .add_filter(
                "压缩包",
                &[
                    "zip", "zipx", "cbz", "7z", "cb7", "rar", "cbr", "tar", "tgz", "tbz",
                    "tbz2", "txz", "gz", "bz2", "xz",
                ],
            )
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


