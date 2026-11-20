use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

pub const MAX_TOTAL_UNPACKED: u64 = 32 * 1024 * 1024 * 1024;
pub const MAX_PREVIEW_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressPayload {
    op: String,
    phase: String,
    files: u64,
    total_files: u64,
    bytes: u64,
    total_bytes: u64,
    name: String,
}

/// Throttled progress reporter. All counters are atomic so worker threads can
/// report without taking the UI lock.
pub struct Progress {
    app: Option<AppHandle>,
    op: &'static str,
    files: AtomicU64,
    total_files: AtomicU64,
    bytes: AtomicU64,
    total_bytes: AtomicU64,
    name: Mutex<String>,
    last: Mutex<Instant>,
}

impl Progress {
    pub fn new(app: AppHandle, op: &'static str) -> Self {
        Self {
            app: Some(app),
            op,
            files: AtomicU64::new(0),
            total_files: AtomicU64::new(0),
            bytes: AtomicU64::new(0),
            total_bytes: AtomicU64::new(0),
            name: Mutex::new(String::new()),
            last: Mutex::new(Instant::now() - Duration::from_secs(1)),
        }
    }

    /// 无 AppHandle 的进度对象：只保留计数，不发事件。仅供单元测试使用。
    #[cfg(test)]
    pub fn detached() -> Self {
        Self {
            app: None,
            op: "test",
            files: AtomicU64::new(0),
            total_files: AtomicU64::new(0),
            bytes: AtomicU64::new(0),
            total_bytes: AtomicU64::new(0),
            name: Mutex::new(String::new()),
            last: Mutex::new(Instant::now() - Duration::from_secs(1)),
        }
    }

    pub fn set_totals(&self, files: u64, bytes: u64) {
        self.total_files.store(files, Ordering::Relaxed);
        self.total_bytes.store(bytes, Ordering::Relaxed);
        self.emit(true, "start");
    }

    pub fn set_current(&self, name: &str) {
        if let Ok(mut n) = self.name.lock() {
            n.clear();
            n.push_str(name);
        }
    }

    pub fn add_bytes(&self, n: u64) {
        self.bytes.fetch_add(n, Ordering::Relaxed);
        self.emit(false, "run");
    }

    pub fn file_done(&self) {
        self.files.fetch_add(1, Ordering::Relaxed);
        self.emit(false, "run");
    }

    pub fn phase(&self, phase: &str) {
        self.emit(true, phase);
    }

    pub fn finish(&self) {
        self.emit(true, "done");
    }

    pub fn files_count(&self) -> u64 {
        self.files.load(Ordering::Relaxed)
    }

    pub fn bytes_count(&self) -> u64 {
        self.bytes.load(Ordering::Relaxed)
    }

    fn emit(&self, force: bool, phase: &str) {
        let now = Instant::now();
        if !force {
            if let Ok(last) = self.last.lock() {
                if now.duration_since(*last) < Duration::from_millis(90) {
                    return;
                }
            }
        }
        if let Ok(mut last) = self.last.lock() {
            *last = now;
        }
        let name = self.name.lock().map(|n| n.clone()).unwrap_or_default();
        let payload = ProgressPayload {
            op: self.op.to_string(),
            phase: phase.to_string(),
            files: self.files.load(Ordering::Relaxed),
            total_files: self.total_files.load(Ordering::Relaxed),
            bytes: self.bytes.load(Ordering::Relaxed),
            total_bytes: self.total_bytes.load(Ordering::Relaxed),
            name,
        };
        if let Some(app) = &self.app {
            let _ = app.emit("archive-progress", payload);
        } else {
            let _ = payload;
        }
    }
}

/// Copy while honouring cancellation and a byte budget. The callback receives
/// each chunk so the UI can show movement inside a large member.
pub fn copy_cancellable<R: Read + ?Sized, W: Write>(
    reader: &mut R,
    writer: &mut W,
    cancel: &AtomicBool,
    mut on_bytes: impl FnMut(u64),
) -> Result<u64> {
    let mut buf = vec![0u8; 256 * 1024];
    let mut total = 0u64;
    loop {
        if cancel.load(Ordering::Relaxed) {
            bail!("操作已取消");
        }
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        writer.write_all(&buf[..n])?;
        total += n as u64;
        if total > MAX_TOTAL_UNPACKED {
            bail!("解压数据超过 32 GiB 上限，已停止");
        }
        on_bytes(n as u64);
    }
    Ok(total)
}

pub fn normalized_name(raw: &str) -> String {
    raw.replace('\\', "/")
}

/// Validate one archive member name and turn it into a relative path.
/// Rejects absolute paths, drive letters, UNC, `..`, ADS, reserved device names
/// and names Windows would silently rewrite (trailing dot/space).
pub fn safe_relative(raw: &str) -> Result<PathBuf> {
    let name = normalized_name(raw);
    let name = name.trim_end_matches('/');
    if name.is_empty() {
        bail!("压缩包内存在空文件名");
    }
    if name.starts_with('/') || name.starts_with("//") {
        bail!("拒绝绝对路径: {raw}");
    }
    let bytes = name.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' {
        bail!("拒绝盘符路径: {raw}");
    }
    let mut parts: Vec<&str> = Vec::new();
    for part in name.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            bail!("拒绝不安全的相对路径: {raw}");
        }
        if part.contains(':') {
            bail!("拒绝 NTFS 数据流路径: {raw}");
        }
        if part.ends_with(' ') || part.ends_with('.') {
            bail!("拒绝 Windows 会改写的文件名: {raw}");
        }
        if part.chars().any(|c| c < ' ' || c == '\u{7f}') {
            bail!("拒绝包含控制字符的文件名: {raw}");
        }
        if is_reserved(part) {
            bail!("拒绝 Windows 保留设备名: {raw}");
        }
        parts.push(part);
    }
    let mut out = PathBuf::new();
    for p in parts {
        out.push(p);
    }
    Ok(out)
}

fn is_reserved(part: &str) -> bool {
    let base = part.split('.').next().unwrap_or(part).trim().to_ascii_uppercase();
    matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$")
        || (base.len() == 4
            && (base.starts_with("COM") || base.starts_with("LPT"))
            && base.as_bytes()[3].is_ascii_digit()
            && base.as_bytes()[3] != b'0')
}

pub fn safe_join(root: &Path, raw: &str) -> Result<PathBuf> {
    let rel = safe_relative(raw)?;
    let joined = root.join(&rel);
    // Belt and braces: no component may be ParentDir.
    for c in rel.components() {
        if !matches!(c, Component::Normal(_)) {
            bail!("拒绝不安全的路径: {raw}");
        }
    }
    Ok(joined)
}

pub fn ensure_parent(path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("无法创建目录 {}", parent.display()))?;
    }
    Ok(())
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Overwrite {
    Overwrite,
    Skip,
    Rename,
}

impl Overwrite {
    pub fn parse(s: &str) -> Self {
        match s {
            "overwrite" => Self::Overwrite,
            "skip" => Self::Skip,
            _ => Self::Rename,
        }
    }
}

/// Resolve a destination. Directories always merge; files follow the policy.
pub fn resolve_dest(path: PathBuf, is_dir: bool, policy: Overwrite) -> Result<Option<PathBuf>> {
    if is_dir {
        return Ok(Some(path));
    }
    if !path.exists() {
        return Ok(Some(path));
    }
    match policy {
        Overwrite::Overwrite => Ok(Some(path)),
        Overwrite::Skip => Ok(None),
        Overwrite::Rename => Ok(Some(unique_path(&path))),
    }
}

pub fn unique_path(path: &Path) -> PathBuf {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    let ext = path.extension().map(|s| s.to_string_lossy().to_string());
    for i in 2..10000 {
        let name = match &ext {
            Some(ext) if !ext.is_empty() => format!("{stem} ({i}).{ext}"),
            _ => format!("{stem} ({i})"),
        };
        let candidate = parent.join(name);
        if !candidate.exists() {
            return candidate;
        }
    }
    parent.join(format!("{stem} (copy)"))
}

pub fn sha256_file(path: &Path) -> Result<String> {
    use sha2::{Digest, Sha256};
    let mut f = File::open(path).with_context(|| format!("无法读取 {}", path.display()))?;
    let mut h = Sha256::new();
    let mut buf = [0u8; 128 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02X}")).collect())
}

pub fn decode_ansi(bytes: &[u8]) -> String {
    use windows_sys::Win32::Globalization::{GetACP, MultiByteToWideChar};
    if bytes.is_empty() {
        return String::new();
    }
    unsafe {
        let cp = GetACP();
        let need = MultiByteToWideChar(
            cp,
            0,
            bytes.as_ptr(),
            bytes.len().min(i32::MAX as usize) as i32,
            std::ptr::null_mut(),
            0,
        );
        if need <= 0 {
            return String::from_utf8_lossy(bytes).to_string();
        }
        let mut out = vec![0u16; need as usize];
        let got = MultiByteToWideChar(
            cp,
            0,
            bytes.as_ptr(),
            bytes.len().min(i32::MAX as usize) as i32,
            out.as_mut_ptr(),
            need,
        );
        if got <= 0 {
            return String::from_utf8_lossy(bytes).to_string();
        }
        String::from_utf16_lossy(&out[..got as usize])
    }
}

pub fn utf16_to_string(buf: &[u16]) -> String {
    // 找不到 NUL 时保留整个缓冲区（unwrap_or(buf.len())），不是返回空串。
    // rar.rs 原来三处手写的是 unwrap_or(0)，即「没有 NUL 就当空名字」；
    // 对 HeaderDataEx 里固定 1024 宽、DLL 保证以 NUL 结尾的字段两者等价，
    // 但「截断到 0」会把一个完整的名字变成空串，是更坏的失败方式。
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

pub fn to_wide(s: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

pub fn wide_path(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// Convert a Windows FILETIME (100ns since 1601, UTC) to local ZIP date parts.
pub fn filetime_to_local_parts(ft: u64) -> Option<(u16, u8, u8, u8, u8, u8)> {
    use windows_sys::Win32::Foundation::{FILETIME, SYSTEMTIME};
    use windows_sys::Win32::Storage::FileSystem::FileTimeToLocalFileTime;
    use windows_sys::Win32::System::Time::FileTimeToSystemTime;
    let src = FILETIME {
        dwLowDateTime: ft as u32,
        dwHighDateTime: (ft >> 32) as u32,
    };
    let mut local = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let mut st: SYSTEMTIME = unsafe { std::mem::zeroed() };
    unsafe {
        if FileTimeToLocalFileTime(&src, &mut local) == 0 {
            return None;
        }
        if FileTimeToSystemTime(&local, &mut st) == 0 {
            return None;
        }
    }
    Some((
        st.wYear,
        st.wMonth as u8,
        st.wDay as u8,
        st.wHour as u8,
        st.wMinute as u8,
        st.wSecond as u8,
    ))
}

pub fn metadata_filetime(meta: &fs::Metadata) -> u64 {
    use std::os::windows::fs::MetadataExt;
    meta.last_write_time()
}

pub fn io_err(e: impl std::fmt::Display) -> String {
    format!("{e:#}")
}

/// 判一段字节像不像文本（前 8 KiB 采样）：含 NUL 即非文本，控制字符占比超 5% 即非文本。
///
/// 调用方是 preview.rs 的 maybe_text —— 未知扩展名的条目靠它决定走文本视图还是
/// 十六进制视图（无扩展名的 LICENSE、Makefile、.gitignore、README 走前者）。
///
/// 判据取样的代价必须小：它跑在双击预览的同步路径上，用的是已经读进来的 64 KiB
/// 头（HEX_LIMIT），不额外读盘。改判据要连着 preview.rs 那段注释一起看。
pub fn is_probably_text(bytes: &[u8]) -> bool {
    if bytes.is_empty() {
        return true;
    }
    let sample = &bytes[..bytes.len().min(8192)];
    if sample.contains(&0) {
        return false;
    }
    let mut bad = 0usize;
    for &b in sample {
        if b < 0x09 || (b > 0x0d && b < 0x20) {
            bad += 1;
        }
    }
    bad * 20 < sample.len()
}

#[derive(Clone)]
pub struct SourceItem {
    pub path: PathBuf,
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
}

/// Walk the user's selection and produce archive member names rooted at each
/// selected item (selecting C:\foo\bar stores it as `bar/...`, not its contents).
pub fn collect_sources(sources: &[PathBuf], skip: Option<&Path>) -> Result<(Vec<SourceItem>, u64)> {
    use walkdir::WalkDir;
    let mut items = Vec::new();
    let mut used = std::collections::HashSet::new();
    let mut total = 0u64;

    for source in sources {
        let source = source.as_path();
        if !source.exists() {
            bail!("路径不存在: {}", source.display());
        }
        let base = source.parent().unwrap_or_else(|| Path::new(""));
        let root_name = source
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "data".to_string());
        let root_name = unique_name(&mut used, root_name.trim_end_matches(['/', '\\']).to_string());

        if source.is_file() {
            if Some(source) == skip {
                continue;
            }
            let size = fs::metadata(source).map(|m| m.len()).unwrap_or(0);
            total += size;
            items.push(SourceItem {
                path: source.to_path_buf(),
                name: root_name,
                is_dir: false,
                size,
            });
            continue;
        }

        let walker = WalkDir::new(source)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| {
                let p = e.path();
                if Some(p) == skip {
                    return false;
                }
                if let Some(skip) = skip {
                    if p == skip {
                        return false;
                    }
                }
                true
            });
        for entry in walker {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            let path = entry.path();
            if Some(path) == skip {
                continue;
            }
            let rel = match path.strip_prefix(base) {
                Ok(r) => r,
                Err(_) => continue,
            };
            let mut name = rel.to_string_lossy().replace('\\', "/");
            if name.is_empty() {
                continue;
            }
            if entry.file_type().is_symlink() {
                continue;
            }
            if entry.file_type().is_dir() {
                name.push('/');
                items.push(SourceItem {
                    path: path.to_path_buf(),
                    name,
                    is_dir: true,
                    size: 0,
                });
            } else if entry.file_type().is_file() {
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                total += size;
                items.push(SourceItem {
                    path: path.to_path_buf(),
                    name,
                    is_dir: false,
                    size,
                });
            }
        }
    }
    items.sort_by(|a, b| a.name.cmp(&b.name));
    Ok((items, total))
}

fn unique_name(used: &mut std::collections::HashSet<String>, name: String) -> String {
    let lower = name.to_ascii_lowercase();
    if used.insert(lower.clone()) {
        return name;
    }
    for i in 2..10000 {
        let candidate = format!("{name} ({i})");
        if used.insert(candidate.to_ascii_lowercase()) {
            return candidate;
        }
    }
    name
}

/// Build a ZIP DateTime from a filesystem timestamp (local time).
pub fn zip_datetime(path: &Path) -> Option<zip::DateTime> {
    let meta = fs::metadata(path).ok()?;
    let ft = metadata_filetime(&meta);
    let (y, mo, d, h, mi, s) = filetime_to_local_parts(ft)?;
    zip::DateTime::from_date_and_time(y, mo, d, h, mi, s).ok()
}

// 已删除 read_limited：从进入版本库那天起就没被调用过。四个解压实现
// （zip_impl / tar_impl / sevenz_impl / rar）各自内联了同样的
// `entry.take(limit).read_to_end(&mut out)`，它只是一份没人用的第三副本。

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_stops_at_nul() {
        // HeaderDataEx.file_name_w 是 [u16; 1024]，DLL 填完后面全是 0。
        let mut buf = vec![0u16; 16];
        for (i, ch) in "报告.txt".encode_utf16().enumerate() {
            buf[i] = ch;
        }
        assert_eq!(utf16_to_string(&buf), "报告.txt");
    }

    #[test]
    fn utf16_without_nul_keeps_everything() {
        // 极端情况：整个缓冲区没有 NUL。旧的三处手写实现是 unwrap_or(0)，
        // 会把这个完整名字变成空串。空名字会让 safe_relative 拒绝整个条目，
        // 表现成「压缩包里明明有这个文件，却读不出来」。
        let buf: Vec<u16> = "abc".encode_utf16().collect();
        assert_eq!(utf16_to_string(&buf), "abc");
    }

    #[test]
    fn utf16_empty_is_empty() {
        assert_eq!(utf16_to_string(&[]), "");
        assert_eq!(utf16_to_string(&[0u16, 0, 0]), "");
    }

    #[test]
    fn to_wide_appends_nul() {
        let w = to_wide("ab");
        assert_eq!(w, vec![0x61u16, 0x62, 0]);
        // 与 wide_path 必须逐元素一致：download.rs 用前者、rar.rs 用后者，
        // 两者一旦漂移，Win32 调用会在不同路径上看到不同的字符串。
        assert_eq!(w, wide_path(Path::new("ab")));
    }
}
