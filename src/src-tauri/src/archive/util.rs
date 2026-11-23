use std::fs::{self, File};
use std::io::{ErrorKind, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

pub const MAX_TOTAL_UNPACKED: u64 = 32 * 1024 * 1024 * 1024;
pub const MAX_PREVIEW_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PerfProfile {
    pub mode: &'static str,
    pub threads: usize,
    pub buf_size: usize,
    pub zip_level: u32,
    pub sevenz_level: u32,
    pub gzip_level: u32,
    pub smart_store: bool,
    pub saver_pace: bool,
}

impl PerfProfile {
    pub fn from_mode(raw: &str) -> Self {
        let avail = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4)
            .max(1);
        match raw {
            "saver" => Self {
                mode: "saver",
                threads: 1,
                buf_size: 64 * 1024,
                zip_level: 6,
                sevenz_level: 5,
                gzip_level: 6,
                smart_store: false,
                saver_pace: true,
            },
            "performance" => Self {
                mode: "performance",
                threads: 4.min(avail).max(1),
                buf_size: 512 * 1024,
                zip_level: 3,
                sevenz_level: 2,
                gzip_level: 3,
                smart_store: true,
                saver_pace: false,
            },
            "hyper" => Self {
                mode: "hyper",
                threads: avail.clamp(1, 16),
                buf_size: 1024 * 1024,
                zip_level: 1,
                sevenz_level: 1,
                gzip_level: 1,
                smart_store: true,
                saver_pace: false,
            },
            _ => Self {
                mode: "balanced",
                threads: 2.min(avail).max(1),
                buf_size: 256 * 1024,
                zip_level: 5,
                sevenz_level: 3,
                gzip_level: 5,
                smart_store: false,
                saver_pace: false,
            },
        }
    }
}

/// 已经高强度压缩过的媒体/文档/归档格式：高性能与超线程档位下在 ZIP 中直接存储，
/// 避免白费 CPU 去重压毫无收益的 jpg/mp4/zip。严格排除 .tar/.sql/.txt/.json 等高可压文本与镜像。
pub fn is_incompressible_ext(path: &Path) -> bool {
    let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
        return false;
    };
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "jpg"
            | "jpeg"
            | "png"
            | "webp"
            | "gif"
            | "heic"
            | "heif"
            | "avif"
            | "mp4"
            | "mkv"
            | "avi"
            | "mov"
            | "webm"
            | "wmv"
            | "flv"
            | "m4v"
            | "mp3"
            | "aac"
            | "m4a"
            | "ogg"
            | "opus"
            | "flac"
            | "wma"
            | "zip"
            | "7z"
            | "rar"
            | "gz"
            | "tgz"
            | "bz2"
            | "xz"
            | "zst"
            | "lz4"
            | "br"
            | "cab"
            | "docx"
            | "xlsx"
            | "pptx"
            | "epub"
            | "apk"
            | "ipa"
            | "jar"
            | "whl"
            | "pdf"
    )
}

/// RAII 线程优先级守卫：按性能档调整当前工作线程（包括 Windows 后台 I/O 模式），
/// Drop 时恢复为 NORMAL，绝不污染 Tokio `spawn_blocking` 全局线程池。
pub struct ThreadPriorityGuard {
    #[cfg(windows)]
    changed: bool,
    #[cfg(windows)]
    bg_mode: bool,
}

impl ThreadPriorityGuard {
    pub fn enter(mode: &str) -> Self {
        #[cfg(windows)]
        {
            #[link(name = "kernel32")]
            extern "system" {
                fn GetCurrentThread() -> isize;
                fn SetThreadPriority(handle: isize, priority: i32) -> i32;
            }
            const THREAD_MODE_BACKGROUND_BEGIN: i32 = 0x00010000;
            const THREAD_PRIORITY_BELOW_NORMAL: i32 = -1;
            const THREAD_PRIORITY_ABOVE_NORMAL: i32 = 1;
            const THREAD_PRIORITY_HIGHEST: i32 = 2;

            let h = unsafe { GetCurrentThread() };
            match mode {
                "saver" => {
                    let ok = unsafe { SetThreadPriority(h, THREAD_MODE_BACKGROUND_BEGIN) };
                    if ok != 0 {
                        Self {
                            changed: true,
                            bg_mode: true,
                        }
                    } else {
                        let ok2 = unsafe { SetThreadPriority(h, THREAD_PRIORITY_BELOW_NORMAL) };
                        Self {
                            changed: ok2 != 0,
                            bg_mode: false,
                        }
                    }
                }
                "performance" => {
                    let ok = unsafe { SetThreadPriority(h, THREAD_PRIORITY_ABOVE_NORMAL) };
                    Self {
                        changed: ok != 0,
                        bg_mode: false,
                    }
                }
                "hyper" => {
                    let ok = unsafe { SetThreadPriority(h, THREAD_PRIORITY_HIGHEST) };
                    Self {
                        changed: ok != 0,
                        bg_mode: false,
                    }
                }
                _ => Self {
                    changed: false,
                    bg_mode: false,
                },
            }
        }
        #[cfg(not(windows))]
        {
            let _ = mode;
            Self {}
        }
    }
}

impl Drop for ThreadPriorityGuard {
    fn drop(&mut self) {
        #[cfg(windows)]
        if self.changed {
            #[link(name = "kernel32")]
            extern "system" {
                fn GetCurrentThread() -> isize;
                fn SetThreadPriority(handle: isize, priority: i32) -> i32;
            }
            const THREAD_MODE_BACKGROUND_END: i32 = 0x00020000;
            const THREAD_PRIORITY_NORMAL: i32 = 0;
            let h = unsafe { GetCurrentThread() };
            unsafe {
                if self.bg_mode {
                    let _ = SetThreadPriority(h, THREAD_MODE_BACKGROUND_END);
                } else {
                    let _ = SetThreadPriority(h, THREAD_PRIORITY_NORMAL);
                }
            }
        }
    }
}

/// 统一的归档任务运行控制：支持无锁快路径检查、阻塞式暂停/恢复与瞬时取消。
/// 取消时无条件清除 paused 并唤醒全部等待线程，彻底杜绝暂停态下取消死锁。
#[derive(Default)]
pub struct TaskControl {
    cancel: AtomicBool,
    paused: AtomicBool,
    gate: Mutex<()>,
    cv: Condvar,
}

impl TaskControl {
    pub fn reset(&self) {
        let _g = self.gate.lock().unwrap_or_else(|e| e.into_inner());
        self.cancel.store(false, Ordering::SeqCst);
        self.paused.store(false, Ordering::SeqCst);
        self.cv.notify_all();
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::Acquire)
    }

    #[cfg(test)]
    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::Acquire)
    }

    pub fn request_cancel(&self) {
        let _g = self.gate.lock().unwrap_or_else(|e| e.into_inner());
        self.cancel.store(true, Ordering::SeqCst);
        self.paused.store(false, Ordering::SeqCst);
        self.cv.notify_all();
    }

    pub fn set_paused(&self, paused: bool) -> bool {
        let _g = self.gate.lock().unwrap_or_else(|e| e.into_inner());
        if self.cancel.load(Ordering::Acquire) {
            return false;
        }
        self.paused.store(paused, Ordering::SeqCst);
        self.cv.notify_all();
        true
    }

    /// 核心检查点：正常运行态仅两次原子 Acquire 读（零锁开销）；暂停时在 Condvar 上挂起；
    /// 取消时立刻返回 Err("操作已取消")。
    pub fn checkpoint(&self, _progress: Option<&Progress>) -> Result<()> {
        if !self.cancel.load(Ordering::Acquire) && !self.paused.load(Ordering::Acquire) {
            return Ok(());
        }
        if self.cancel.load(Ordering::Acquire) {
            bail!("操作已取消");
        }
        let mut guard = self.gate.lock().unwrap_or_else(|e| e.into_inner());
        while self.paused.load(Ordering::Acquire) && !self.cancel.load(Ordering::Acquire) {
            guard = self.cv.wait(guard).unwrap_or_else(|e| e.into_inner());
        }
        if self.cancel.load(Ordering::Acquire) {
            bail!("操作已取消");
        }
        Ok(())
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressPayload {
    op: String,
    phase: String,
    paused: bool,
    mode: String,
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
    paused: AtomicBool,
    cancelling: AtomicBool,
    mode: Mutex<String>,
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
            paused: AtomicBool::new(false),
            cancelling: AtomicBool::new(false),
            mode: Mutex::new("balanced".to_string()),
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
            paused: AtomicBool::new(false),
            cancelling: AtomicBool::new(false),
            mode: Mutex::new("balanced".to_string()),
            name: Mutex::new(String::new()),
            last: Mutex::new(Instant::now() - Duration::from_secs(1)),
        }
    }

    pub fn set_mode(&self, mode: &str) {
        if let Ok(mut m) = self.mode.lock() {
            m.clear();
            m.push_str(mode);
        }
    }

    pub fn set_paused(&self, paused: bool) {
        if self.cancelling.load(Ordering::Acquire) {
            return;
        }
        self.paused.store(paused, Ordering::SeqCst);
        self.emit(true, if paused { "paused" } else { "run" });
    }

    pub fn mark_cancelling(&self) {
        self.cancelling.store(true, Ordering::SeqCst);
        self.paused.store(false, Ordering::SeqCst);
        self.emit(true, "cancelling");
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
        self.paused.store(false, Ordering::SeqCst);
        self.emit(true, "done");
    }

    pub fn files_count(&self) -> u64 {
        self.files.load(Ordering::Relaxed)
    }

    pub fn bytes_count(&self) -> u64 {
        self.bytes.load(Ordering::Relaxed)
    }

    fn emit(&self, force: bool, phase: &str) {
        let paused = self.paused.load(Ordering::Acquire);
        let cancelling = self.cancelling.load(Ordering::Acquire);
        // 在暂停或取消状态下的非强制吞吐事件直接丢弃，避免覆盖「已暂停/取消中」状态。
        if !force && (paused || cancelling) {
            return;
        }
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
        let mode = self
            .mode
            .lock()
            .map(|m| m.clone())
            .unwrap_or_else(|_| "balanced".to_string());
        let payload = ProgressPayload {
            op: self.op.to_string(),
            phase: phase.to_string(),
            paused,
            mode,
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

/// 跨成员累计的字节预算。整次解压共用一个，不是每个成员各一份。
///
/// 为什么需要这个：`copy_cancellable` 原来的计数器是函数内局部的，于是
/// `MAX_TOTAL_UNPACKED` 的实际语义变成了「单个成员不超过 32 GiB」。一个含
/// 上千个 31 GiB 成员的压缩包（全部由零字节构成、压缩后可能只有几百 MB）
/// 会一路写到磁盘满为止 —— 用户看到的是「解压到一半报错、盘红了」，而不是
/// 「检测到可疑压缩包，已停止」。实测见 `cap_is_cumulative`。
///
/// 两道闸：`check_declared` 在动手之前用归档头声明的尺寸算总量（一个字节都
/// 不写就拒绝），`charge` 在实际写出的过程中累计（防声明的尺寸本身撒谎）。
pub struct Budget {
    used: AtomicU64,
    cap: u64,
}

impl Budget {
    pub fn new(cap: u64) -> Self {
        Self {
            used: AtomicU64::new(0),
            cap,
        }
    }

    pub fn for_extraction() -> Self {
        Self::new(MAX_TOTAL_UNPACKED)
    }

    /// 动手之前的预检：归档声明的解压后总量已经超限，就直接拒绝。
    ///
    /// 先拒绝而不是写到一半再拒绝，是因为前者只留下一个错误提示，后者会
    /// 在磁盘上留下成百上千个半成品文件，而且那些文件正是用户要清理的对象。
    pub fn check_declared(&self, declared: u64) -> Result<()> {
        if declared > self.cap {
            bail!(
                "解压后总量约 {} GiB，超过 {} GiB 上限，已停止（未写入任何文件）",
                declared / (1024 * 1024 * 1024),
                self.cap / (1024 * 1024 * 1024)
            );
        }
        Ok(())
    }

    /// 实际写出的字节记账。并发路径下由多个线程同时调用。
    fn charge(&self, n: u64) -> Result<()> {
        let total = self.used.fetch_add(n, Ordering::Relaxed) + n;
        if total > self.cap {
            bail!(
                "解压数据累计超过 {} GiB 上限，已停止",
                self.cap / (1024 * 1024 * 1024)
            );
        }
        Ok(())
    }

    /// 只给测试看的读数。生产代码不需要知道已经写了多少 —— 判断全在
    /// `charge` 里做完了。不标 `#[cfg(test)]` 的话 `cargo build --release`
    /// 会把它算成死代码（`cargo test` 反而看不到，因为测试在用）。
    #[cfg(test)]
    pub fn used(&self) -> u64 {
        self.used.load(Ordering::Relaxed)
    }
}

/// Copy while honouring TaskControl (pause/resume/cancel), PerfProfile buffer/pacing, and a shared byte budget.
pub fn copy_controlled<R: Read + ?Sized, W: Write>(
    reader: &mut R,
    writer: &mut W,
    control: &TaskControl,
    profile: PerfProfile,
    budget: Option<&Budget>,
    progress: Option<&Progress>,
    on_bytes: impl FnMut(u64),
) -> Result<u64> {
    copy_controlled_abortable(reader, writer, control, None, profile, budget, progress, on_bytes)
}

/// 同 `copy_controlled`，额外接受并发任务共享的 `abort` 标志：同组任一工作线程遇致命错误时，
/// 其余正在拷贝大文件的兄弟线程可在单块（<=1 MiB）内中止并清理半成品，避免拖住整任务。
#[allow(clippy::too_many_arguments)]
pub fn copy_controlled_abortable<R: Read + ?Sized, W: Write>(
    reader: &mut R,
    writer: &mut W,
    control: &TaskControl,
    abort: Option<&AtomicBool>,
    profile: PerfProfile,
    budget: Option<&Budget>,
    progress: Option<&Progress>,
    mut on_bytes: impl FnMut(u64),
) -> Result<u64> {
    let chunk_size = profile.buf_size.clamp(64 * 1024, 1024 * 1024);
    let mut buf = vec![0u8; chunk_size];
    let mut total = 0u64;
    let mut paced_bytes = 0u64;
    loop {
        if abort.is_some_and(|a| a.load(Ordering::Acquire)) {
            if control.is_cancelled() {
                bail!("操作已取消");
            }
            bail!("并行任务已中止");
        }
        control.checkpoint(progress)?;
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        writer.write_all(&buf[..n])?;
        let chunk = n as u64;
        total += chunk;
        if let Some(b) = budget {
            b.charge(chunk)?;
        }
        on_bytes(chunk);
        if profile.saver_pace {
            paced_bytes += chunk;
            if paced_bytes >= 2 * 1024 * 1024 {
                paced_bytes = 0;
                control.checkpoint(progress)?;
                std::thread::sleep(Duration::from_millis(2));
            }
        }
    }
    Ok(total)
}

/// 分块流式 ControlledReader：让逐文件读取（如 TAR/7Z 压缩大文件）在成员内部也能毫秒级响应暂停/取消并持续推送进度。
pub struct ControlledReader<R: Read> {
    inner: R,
    control: Arc<TaskControl>,
    progress: Arc<Progress>,
    saver_pace: bool,
    paced_bytes: u64,
}

impl<R: Read> ControlledReader<R> {
    pub fn new(
        inner: R,
        control: Arc<TaskControl>,
        progress: Arc<Progress>,
        saver_pace: bool,
    ) -> Self {
        Self {
            inner,
            control,
            progress,
            saver_pace,
            paced_bytes: 0,
        }
    }
}

impl<R: Read> Read for ControlledReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        // 绝不能返回 ErrorKind::Interrupted：std::io::copy / write_all 会对 Interrupted 无限重试导致取消死循环。
        self.control
            .checkpoint(Some(&self.progress))
            .map_err(|_| std::io::Error::new(ErrorKind::Other, "操作已取消"))?;
        let max_slice = if self.saver_pace { 256 * 1024 } else { 512 * 1024 };
        let cap = buf.len().min(max_slice);
        let n = self.inner.read(&mut buf[..cap])?;
        if n > 0 {
            let chunk = n as u64;
            self.progress.add_bytes(chunk);
            if self.saver_pace {
                self.paced_bytes += chunk;
                if self.paced_bytes >= 2 * 1024 * 1024 {
                    self.paced_bytes = 0;
                    self.control
                        .checkpoint(Some(&self.progress))
                        .map_err(|_| std::io::Error::new(ErrorKind::Other, "操作已取消"))?;
                    std::thread::sleep(Duration::from_millis(2));
                }
            }
        }
        Ok(n)
    }
}

/// Copy while honouring cancellation and a shared byte budget (retained for tests).
#[cfg(test)]
pub fn copy_cancellable<R: Read + ?Sized, W: Write>(
    reader: &mut R,
    writer: &mut W,
    cancel: &AtomicBool,
    budget: &Budget,
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
        // 记在整个任务的账上，不是这个成员自己的账上
        budget.charge(n as u64)?;
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
    let owned = normalized_name(raw);
    let mut name = owned.trim_end_matches('/');
    // 兼容 GNU/BSD tar 常见的 `./proj/a.txt` 前导相对前缀，同时继续拦截 `..` 与路径中段 `.`。
    while let Some(rest) = name.strip_prefix("./") {
        name = rest;
    }
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

/// 同 `safe_join`，在「二者并存（自动重命名）」模式下将冲突顶层目录名映射到新目录名。
pub fn safe_join_mapped(
    root: &Path,
    raw: &str,
    dir_map: &std::collections::HashMap<String, String>,
) -> Result<PathBuf> {
    let rel = safe_relative(raw)?;
    for c in rel.components() {
        if !matches!(c, Component::Normal(_)) {
            bail!("拒绝不安全的路径: {raw}");
        }
    }
    if dir_map.is_empty() {
        return Ok(root.join(&rel));
    }
    let mut comps = rel.components();
    let Some(Component::Normal(first)) = comps.next() else {
        return Ok(root.join(&rel));
    };
    let key = first.to_string_lossy().to_lowercase();
    let Some(mapped_first) = dir_map.get(&key) else {
        return Ok(root.join(&rel));
    };
    let mut out = root.join(mapped_first);
    for c in comps {
        out.push(c.as_os_str());
    }
    Ok(out)
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
///
/// 覆盖分支要额外看一眼落点：如果目标位置是个符号链接（或 junction），
/// `File::create` 会**跟随它**把内容写到链接指向的地方去。`safe_join` 只校验
/// 成员名是安全的相对路径，管不到这件事 —— 名字校验得再严，落点是链接就
/// 全白费。判据用 `symlink_metadata`（不跟随），查不到就当普通文件。
pub fn resolve_dest(path: PathBuf, is_dir: bool, policy: Overwrite) -> Result<Option<PathBuf>> {
    if is_dir {
        return Ok(Some(path));
    }
    if !path.exists() {
        return Ok(Some(path));
    }
    match policy {
        Overwrite::Overwrite => {
            if is_reparse(&path) {
                // 不顺着链接覆盖：改名放旁边，用户能看见、也不会写到自己
                // 没指定的地方去。
                return Ok(Some(unique_path(&path)));
            }
            Ok(Some(path))
        }
        Overwrite::Skip => Ok(None),
        Overwrite::Rename => Ok(Some(unique_path(&path))),
    }
}

/// 这个路径本身是不是重解析点（符号链接 / junction / 其他 reparse 标签）。
///
/// 用 `symlink_metadata` 而不是 `metadata`：后者会跟随链接、永远返回目标的
/// 属性，那样这个判断永远为假。读不到就当不是 —— 目标不存在时本来也不会走
/// 到需要判断的分支。
pub fn is_reparse(path: &Path) -> bool {
    match fs::symlink_metadata(path) {
        Ok(m) => {
            if m.file_type().is_symlink() {
                return true;
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
                if m.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                    return true;
                }
            }
            false
        }
        Err(_) => false,
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
        if !candidate.exists() && fs::symlink_metadata(&candidate).is_err() {
            return candidate;
        }
    }
    parent.join(format!("{stem} (copy)"))
}

/// 文件夹专用不重名路径：不在 `.` 上拆分（如 `v1.2.0` -> `v1.2.0 (2)`）。
pub fn unique_dir_path(path: &Path) -> PathBuf {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "folder".to_string());
    for i in 2..10000 {
        let candidate = parent.join(format!("{name} ({i})"));
        if !candidate.exists() && fs::symlink_metadata(&candidate).is_err() {
            return candidate;
        }
    }
    parent.join(format!("{name} (copy)"))
}

/// 压缩包专用不重名路径：正确保留 `.tar.gz` / `.tar.bz2` / `.tar.xz` 复合后缀。
pub fn unique_archive_path(path: &Path) -> PathBuf {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let raw_name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "archive.zip".to_string());
    let low = raw_name.to_ascii_lowercase();
    let compound = [".tar.gz", ".tar.bz2", ".tar.xz"]
        .into_iter()
        .find(|s| low.ends_with(s));
    let (stem, suffix) = if let Some(suf) = compound {
        let cut = raw_name.len() - suf.len();
        (raw_name[..cut].to_string(), raw_name[cut..].to_string())
    } else if let Some(dot) = raw_name.rfind('.') {
        if dot > 0 {
            (raw_name[..dot].to_string(), raw_name[dot..].to_string())
        } else {
            (raw_name, String::new())
        }
    } else {
        (raw_name, String::new())
    };
    for i in 2..10000 {
        let candidate = parent.join(format!("{stem} ({i}){suffix}"));
        if !candidate.exists() && fs::symlink_metadata(&candidate).is_err() {
            return candidate;
        }
    }
    parent.join(format!("{stem} (copy){suffix}"))
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

/// 将文件本地修改时间打包为标准 MS-DOS `(time, date)` 16 位字段（供并行 ZIP64 写入器使用）。
pub fn dos_datetime(path: &Path) -> (u16, u16) {
    let parts = fs::metadata(path)
        .ok()
        .map(|m| metadata_filetime(&m))
        .and_then(filetime_to_local_parts);
    if let Some((y, mo, d, h, mi, s)) = parts {
        let yr = y.clamp(1980, 2107) - 1980;
        let date = (yr << 9) | (((mo as u16).clamp(1, 12)) << 5) | ((d as u16).clamp(1, 31));
        let time = ((h as u16).min(23) << 11) | ((mi as u16).min(59) << 5) | ((s as u16).min(59) / 2);
        return (time, date);
    }
    (0, (1 << 5) | 1)
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

    /// 上限必须是「整个解压任务累计」，不是「每个成员各一份」。
    ///
    /// 这条用例用 io::repeat + io::sink 跑真实函数、不碰磁盘。两个 17 GiB
    /// 成员合计 34 GiB，超过 MAX_TOTAL_UNPACKED。第二个成员必须在写出去的
    /// 过程中被拦住 —— 如果它通过了，说明计数器是函数内局部的，那么一个含
    /// N 个大成员的压缩包能把磁盘写满到 N×32 GiB 才停。
    ///
    /// 标了 ignore：要跑 34 GiB 的内存拷贝，约十几秒，不值得每次门禁都跑。
    /// 手动验证用 `cargo test --release cap_is_cumulative -- --ignored`。
    #[test]
    #[ignore = "要跑 34 GiB 内存拷贝，手动验证上限语义时再跑"]
    fn cap_is_cumulative() {
        use std::io;
        let cancel = AtomicBool::new(false);
        let budget = Budget::for_extraction();
        let half: u64 = MAX_TOTAL_UNPACKED / 2 + 1024 * 1024 * 1024; // 略过一半
        let mut s1 = io::repeat(0).take(half);
        let mut d1 = io::sink();
        let a = copy_cancellable(&mut s1, &mut d1, &cancel, &budget, |_| {})
            .expect("第一个成员低于上限，应当通过");
        assert_eq!(a, half);
        assert_eq!(budget.used(), half, "预算必须记在整任务上");

        let mut s2 = io::repeat(0).take(half);
        let mut d2 = io::sink();
        let b = copy_cancellable(&mut s2, &mut d2, &cancel, &budget, |_| {});
        assert!(
            b.is_err(),
            "合计 {} GiB 已超过 32 GiB 上限，第二个成员应当被拦住；\
             这里通过说明上限是逐成员算的，整包总量没有任何封顶",
            (half * 2) / (1024 * 1024 * 1024)
        );
    }

    /// 动手前就能用归档头声明的尺寸拒绝：一个字节都不写。
    ///
    /// 与上一条的分工：`cap_is_cumulative` 管「写到一半发现超了」，这条管
    /// 「还没写就发现超了」。后者才是 ZIP / 7Z 的常规路径。
    #[test]
    fn declared_total_is_rejected_before_writing() {
        let budget = Budget::for_extraction();
        assert!(budget.check_declared(1024).is_ok());
        let over = MAX_TOTAL_UNPACKED + 1;
        let e = budget.check_declared(over).unwrap_err().to_string();
        assert!(e.contains("未写入任何文件"), "错误信息要说清没动磁盘: {e}");
        assert!(
            budget.check_declared(MAX_TOTAL_UNPACKED).is_ok(),
            "恰好等于上限不算超"
        );
    }

    /// 覆盖策略不得顺着已存在的符号链接写到目标目录之外。
    ///
    /// 场景：解压目录里事先有一个叫 `a.txt` 的符号链接指向外部文件。
    /// 用户选「覆盖」解压同名成员时，`File::create` 会跟随链接把内容写到
    /// 链接目标上 —— 名字校验（safe_relative）管不住这件事，因为它只校验
    /// 成员名是不是安全的相对路径，不校验落点是不是重解析点。
    ///
    /// 需要创建符号链接，普通权限下会失败。创建不了就跳过，不把环境限制
    /// 当成测试失败。
    #[test]
    fn overwrite_does_not_follow_existing_symlink() {
        use std::os::windows::fs::symlink_file;
        let root = std::env::temp_dir().join(format!("tidy_link_{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let outside = root.join("outside.txt");
        fs::write(&outside, b"original").unwrap();
        let inner = root.join("inner");
        fs::create_dir_all(&inner).unwrap();
        let link = inner.join("a.txt");
        if symlink_file(&outside, &link).is_err() {
            let _ = fs::remove_dir_all(&root);
            eprintln!("跳过：当前权限下创建符号链接失败（需要管理员或开发者模式）");
            return;
        }

        let got = resolve_dest(link.clone(), false, Overwrite::Overwrite).unwrap();
        // 落点解析出来还是那个链接本身 —— 说明后续 File::create 会顺着它写出去
        let resolved_is_link = got
            .as_deref()
            .map(|p| fs::symlink_metadata(p).map(|m| m.file_type().is_symlink()).unwrap_or(false))
            .unwrap_or(false);
        // 而且必须给出一个替代落点，不能让调用方拿到 None 把文件静默丢掉
        let has_alternative = got.as_deref().map(|p| p != link.as_path()).unwrap_or(false);
        let _ = fs::remove_dir_all(&root);
        assert!(
            !resolved_is_link,
            "覆盖策略把符号链接当成了普通文件；File::create 会跟随它写到目标目录之外"
        );
        assert!(
            has_alternative,
            "碰到链接应当改成相邻的新名字，而不是静默跳过这个文件"
        );
    }

    #[test]
    fn perf_profile_modes_and_priority_guard() {
        let saver = PerfProfile::from_mode("saver");
        let balanced = PerfProfile::from_mode("balanced");
        let perf = PerfProfile::from_mode("performance");
        let hyper = PerfProfile::from_mode("hyper");

        assert_eq!(saver.threads, 1);
        assert!(saver.saver_pace);
        assert!(!saver.smart_store);
        assert_eq!(saver.zip_level, 6);
        assert_eq!(balanced.zip_level, 5);
        assert_eq!(perf.zip_level, 3);
        assert!(perf.smart_store);
        assert_eq!(hyper.zip_level, 1);
        assert!(hyper.smart_store);
        assert!(hyper.threads >= balanced.threads);

        assert!(is_incompressible_ext(Path::new("photo.JPG")));
        assert!(is_incompressible_ext(Path::new("clip.mp4")));
        assert!(is_incompressible_ext(Path::new("inner.zip")));
        assert!(!is_incompressible_ext(Path::new("backup.tar")));
        assert!(!is_incompressible_ext(Path::new("dump.sql")));
        assert!(!is_incompressible_ext(Path::new("notes.txt")));
        assert!(!is_incompressible_ext(Path::new("data.json")));

        for m in ["saver", "balanced", "performance", "hyper"] {
            let g = ThreadPriorityGuard::enter(m);
            drop(g);
        }
    }

    #[test]
    fn unique_dir_and_archive_path_preserve_dots_and_compound_ext() {
        let root = PathBuf::from("D:\\Builds\\tidy-util-tests")
            .join(format!("uniq_{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("v1.2.0")).unwrap();
        fs::create_dir_all(root.join("v1.2.0 (2)")).unwrap();
        let next_dir = unique_dir_path(&root.join("v1.2.0"));
        assert_eq!(next_dir.file_name().unwrap().to_string_lossy(), "v1.2.0 (3)");

        fs::write(root.join("备份.tar.gz"), b"old").unwrap();
        let next_tgz = unique_archive_path(&root.join("备份.tar.gz"));
        assert_eq!(
            next_tgz.file_name().unwrap().to_string_lossy(),
            "备份 (2).tar.gz"
        );

        fs::write(root.join("a.zip"), b"old").unwrap();
        let next_zip = unique_archive_path(&root.join("a.zip"));
        assert_eq!(next_zip.file_name().unwrap().to_string_lossy(), "a (2).zip");

        assert_eq!(safe_relative("./proj/a.txt").unwrap(), PathBuf::from("proj/a.txt"));
        assert!(safe_relative(".").is_err());
        assert!(safe_relative("./../evil.txt").is_err());
        assert!(safe_relative("proj/../evil.txt").is_err());

        let _ = fs::remove_dir_all(&root);
    }
}
