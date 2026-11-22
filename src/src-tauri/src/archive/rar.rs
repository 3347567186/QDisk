use std::collections::HashSet;
use std::ffi::{c_char, c_void, CString};
use std::fs;
use std::io::Read;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use libloading::Library;

use super::download;
use super::util::{
    ensure_parent, resolve_dest, safe_relative, sha256_file, utf16_to_string, wide_path, Overwrite,
    PerfProfile, Progress, TaskControl, ThreadPriorityGuard,
};
use super::{ArchiveInfo, EntryInfo, ExtractReport, RarStatus};

const RAR_URL: &str = "https://www.rarlab.com/rar/unrardll-710.exe";
const SFX_SHA256: &str = "34874EF05212A49B74929A5C33329BA0326C57CCCFBCC51D8E07FD115AAAD5F3";
const DLL_SHA256: &str = "D3F371AD0E7D2E7904756C8CC5DEBE0BF9037E4729A95D5E17D60223B725AA90";
const DLL_SIZE: u64 = 398_992;

const RAR_OM_LIST: u32 = 0;
const RAR_OM_EXTRACT: u32 = 1;
const RAR_SKIP: i32 = 0;
const RAR_EXTRACT: i32 = 2;
const UCM_PROCESSDATA: u32 = 1;

const RHDF_ENCRYPTED: u32 = 0x04;
const RHDF_SOLID: u32 = 0x10;
const RHDF_DIRECTORY: u32 = 0x20;

#[repr(C, packed(1))]
struct OpenDataEx {
    arc_name: *mut c_char,
    arc_name_w: *mut u16,
    open_mode: u32,
    open_result: u32,
    cmt_buf: *mut c_char,
    cmt_buf_size: u32,
    cmt_size: u32,
    cmt_state: u32,
    flags: u32,
    callback: *mut c_void,
    user_data: isize,
    op_flags: u32,
    cmt_buf_w: *mut u16,
    mark_of_the_web: *mut u16,
    reserved: [u32; 23],
}

#[repr(C, packed(1))]
struct HeaderDataEx {
    arc_name: [c_char; 1024],
    arc_name_w: [u16; 1024],
    file_name: [c_char; 1024],
    file_name_w: [u16; 1024],
    flags: u32,
    pack_size: u32,
    pack_size_high: u32,
    unp_size: u32,
    unp_size_high: u32,
    host_os: u32,
    file_crc: u32,
    file_time: u32,
    unp_ver: u32,
    method: u32,
    file_attr: u32,
    cmt_buf: *mut c_char,
    cmt_buf_size: u32,
    cmt_size: u32,
    cmt_state: u32,
    dict_size: u32,
    hash_type: u32,
    hash: [u8; 32],
    redir_type: u32,
    redir_name: *mut u16,
    redir_name_size: u32,
    dir_target: u32,
    mtime_low: u32,
    mtime_high: u32,
    ctime_low: u32,
    ctime_high: u32,
    atime_low: u32,
    atime_high: u32,
    arc_name_ex: *mut u16,
    arc_name_ex_size: u32,
    file_name_ex: *mut u16,
    file_name_ex_size: u32,
    reserved: [u32; 982],
}

type OpenFn = unsafe extern "system" fn(*mut OpenDataEx) -> *mut c_void;
type ReadFn = unsafe extern "system" fn(*mut c_void, *mut HeaderDataEx) -> i32;
type ProcessFn = unsafe extern "system" fn(*mut c_void, i32, *const u16, *const u16) -> i32;
type CloseFn = unsafe extern "system" fn(*mut c_void) -> i32;
type PasswordFn = unsafe extern "system" fn(*mut c_void, *const c_char);
type VersionFn = unsafe extern "system" fn() -> i32;
type RarCallback = unsafe extern "system" fn(u32, isize, isize, isize) -> i32;
type SetCallbackFn = unsafe extern "system" fn(*mut c_void, RarCallback, isize);

struct RarApi {
    _lib: Library,
    open: OpenFn,
    read: ReadFn,
    process: ProcessFn,
    close: CloseFn,
    set_password: PasswordFn,
    set_callback: Option<SetCallbackFn>,
    version: VersionFn,
}

impl RarApi {
    fn load(dll: &Path) -> Result<Self> {
        unsafe {
            let lib = Library::new(dll)
                .with_context(|| format!("无法加载 {}", dll.display()))?;
            let set_callback = lib
                .get::<SetCallbackFn>(b"RARSetCallback\0")
                .ok()
                .map(|s| *s);
            Ok(Self {
                open: *lib.get(b"RAROpenArchiveEx\0")?,
                read: *lib.get(b"RARReadHeaderEx\0")?,
                process: *lib.get(b"RARProcessFileW\0")?,
                close: *lib.get(b"RARCloseArchive\0")?,
                set_password: *lib.get(b"RARSetPassword\0")?,
                set_callback,
                version: *lib.get(b"RARGetDllVersion\0")?,
                _lib: lib,
            })
        }
    }

    fn open_archive(&self, path: &Path, mode: u32) -> Result<*mut c_void> {
        let mut wide = wide_path(path);
        let mut data: OpenDataEx = unsafe { std::mem::zeroed() };
        data.arc_name_w = wide.as_mut_ptr();
        data.open_mode = mode;
        let handle = unsafe { (self.open)(&mut data) };
        if handle.is_null() {
            let code = unsafe { ptr::read_unaligned(ptr::addr_of!(data.open_result)) };
            bail!("RAR 打开失败: {}", rar_error(code as i32));
        }
        Ok(handle)
    }

    fn set_callback(&self, handle: *mut c_void, cb: RarCallback, user_data: isize) {
        if let Some(f) = self.set_callback {
            unsafe { f(handle, cb, user_data) };
        }
    }

    fn header(&self, handle: *mut c_void) -> Result<(Option<HeaderDataEx>, i32)> {
        let mut header: HeaderDataEx = unsafe { std::mem::zeroed() };
        let rc = unsafe { (self.read)(handle, &mut header) };
        if rc == 0 {
            Ok((Some(header), 0))
        } else {
            Ok((None, rc))
        }
    }

    fn process(&self, handle: *mut c_void, op: i32, dir: Option<&Path>, name: Option<&str>) -> i32 {
        let dir_w = dir.map(wide_path);
        let name_w = name.map(wide_string);
        unsafe {
            (self.process)(
                handle,
                op,
                dir_w.as_ref().map(|v| v.as_ptr()).unwrap_or(ptr::null()),
                name_w.as_ref().map(|v| v.as_ptr()).unwrap_or(ptr::null()),
            )
        }
    }

    fn set_password(&self, handle: *mut c_void, password: &str) {
        if let Ok(c) = CString::new(password) {
            unsafe { (self.set_password)(handle, c.as_ptr()) };
        }
    }

    fn close(&self, handle: *mut c_void) {
        unsafe {
            (self.close)(handle);
        }
    }

    fn version(&self) -> i32 {
        unsafe { (self.version)() }
    }
}

struct RarCbState {
    control: *const TaskControl,
    progress: *const Progress,
    extracting: AtomicBool,
    entry_bytes: AtomicU64,
    saver_pace: bool,
    paced: AtomicU64,
}

struct HandleGuard<'a> {
    api: &'a RarApi,
    handle: *mut c_void,
}

impl Drop for HandleGuard<'_> {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            self.api.close(self.handle);
        }
    }
}

unsafe extern "system" fn rar_callback(
    msg: u32,
    user_data: isize,
    _p1: isize,
    p2: isize,
) -> i32 {
    std::panic::catch_unwind(|| {
        if user_data == 0 {
            return 1;
        }
        let state = &*(user_data as *const RarCbState);
        let control = &*state.control;
        let progress = &*state.progress;
        if msg == UCM_PROCESSDATA {
            if control.checkpoint(Some(progress)).is_err() {
                return -1;
            }
            if state.extracting.load(Ordering::Relaxed) && p2 > 0 {
                let n = p2 as u64;
                state.entry_bytes.fetch_add(n, Ordering::Relaxed);
                progress.add_bytes(n);
                if state.saver_pace {
                    let prev = state.paced.fetch_add(n, Ordering::Relaxed);
                    if (prev + n) / (2 * 1024 * 1024) > prev / (2 * 1024 * 1024) {
                        if control.checkpoint(Some(progress)).is_err() {
                            return -1;
                        }
                        std::thread::sleep(Duration::from_millis(2));
                    }
                }
            }
            return 1;
        }
        if control.is_cancelled() {
            return -1;
        }
        0
    })
    .unwrap_or(-1)
}

fn wide_string(s: &str) -> Vec<u16> {
    std::ffi::OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

fn rar_error(code: i32) -> String {
    match code {
        0 => "成功".into(),
        10 => "归档结束".into(),
        11 => "内存不足".into(),
        12 => "数据损坏".into(),
        13 => "不是有效 RAR".into(),
        14 => "未知格式".into(),
        15 => "无法打开".into(),
        16 => "无法创建".into(),
        17 => "无法关闭".into(),
        18 => "读取错误".into(),
        19 => "写入错误".into(),
        20 => "缓冲区太小".into(),
        22 => "需要密码".into(),
        23 => "引用错误".into(),
        24 => "密码错误".into(),
        25 => "字典过大".into(),
        _ => format!("错误码 {code}"),
    }
}

fn dll_path(data_dir: &Path) -> PathBuf {
    data_dir.join("bin").join("unrar").join("UnRAR64.dll")
}

pub fn status(data_dir: &Path) -> Result<RarStatus> {
    let dll = dll_path(data_dir);
    if !dll.exists() {
        return Ok(RarStatus {
            ready: false,
            path: dll.display().to_string(),
            version: 0,
        });
    }
    let version = RarApi::load(&dll).map(|api| api.version()).unwrap_or(0);
    Ok(RarStatus {
        ready: version > 0,
        path: dll.display().to_string(),
        version: version.max(0) as u32,
    })
}

pub fn install(_app: &tauri::AppHandle, data_dir: &Path, control: &TaskControl) -> Result<RarStatus> {
    let dll = dll_path(data_dir);
    if status(data_dir)?.ready {
        return status(data_dir);
    }
    let dir = data_dir.join("bin").join("unrar");
    fs::create_dir_all(&dir)?;
    let sfx = dir.join("unrardll-710.exe");
    let part = dir.join("unrardll-710.exe.part");
    let unpack = dir.join("unpack");

    let result = (|| -> Result<()> {
        if !sfx.exists() || sha256_file(&sfx).ok().as_deref() != Some(SFX_SHA256) {
            let _ = fs::remove_file(&sfx);
            let mut last_err: Option<String> = None;
            for _ in 0..3 {
                control.checkpoint(None)?;
                let _ = fs::remove_file(&part);
                match download::download(RAR_URL, &part) {
                    Ok(()) => {}
                    Err(e) => {
                        last_err = Some(format!("{e:#}"));
                        continue;
                    }
                }
                match sha256_file(&part) {
                    Ok(got) if got == SFX_SHA256 => {
                        fs::rename(&part, &sfx)?;
                        last_err = None;
                        break;
                    }
                    Ok(got) => {
                        last_err = Some(format!("下载文件校验失败（{got}）"));
                    }
                    Err(e) => {
                        last_err = Some(format!("{e:#}"));
                    }
                }
            }
            if !sfx.exists() {
                bail!(
                    "RAR 组件下载失败，已重试 3 次：{}",
                    last_err.unwrap_or_else(|| "未知错误".into())
                );
            }
        }
        let _ = fs::remove_dir_all(&unpack);
        let extracted = download::extract_sfx_member(&sfx, "x64/UnRAR64.dll", &unpack)?;
        let got = sha256_file(&extracted)?;
        if got != DLL_SHA256 {
            bail!("UnRAR64.dll 校验失败，已停止");
        }
        let size = fs::metadata(&extracted)?.len();
        if size != DLL_SIZE {
            bail!("UnRAR64.dll 大小异常: {size}");
        }
        fs::copy(&extracted, &part)?;
        fs::rename(&part, &dll)?;
        Ok(())
    })();

    let _ = fs::remove_dir_all(&unpack);
    let _ = fs::remove_file(&part);
    result?;
    status(data_dir)
}

pub fn list(path: &Path, password: Option<&str>) -> Result<ArchiveInfo> {
    let data_dir = super::data_dir_for_rar();
    let dll = dll_path(&data_dir);
    if !dll.exists() {
        return Ok(ArchiveInfo {
            path: path.display().to_string(),
            format: "RAR".into(),
            entries: Vec::new(),
            total_size: 0,
            total_packed: 0,
            encrypted: false,
            solid: false,
            comment: String::new(),
            needs_rar: true,
            rar_ready: false,
        });
    }
    let api = RarApi::load(&dll)?;
    let handle = api.open_archive(path, RAR_OM_LIST)?;
    if let Some(pw) = password.filter(|p| !p.is_empty()) {
        api.set_password(handle, pw);
    }
    let mut entries = Vec::new();
    let mut total_size = 0u64;
    let mut total_packed = 0u64;
    let mut encrypted = false;
    let mut solid = false;
    let mut index = 0usize;
    loop {
        let (header, rc) = api.header(handle)?;
        if rc == 10 {
            break;
        }
        if rc != 0 {
            api.close(handle);
            bail!("RAR 读取失败: {}", rar_error(rc));
        }
        let Some(h) = header else { break };
        let flags = unsafe { ptr::read_unaligned(ptr::addr_of!(h.flags)) };
        let raw = unsafe { ptr::read_unaligned(ptr::addr_of!(h.file_name_w)) };
        let ansi = unsafe { ptr::read_unaligned(ptr::addr_of!(h.file_name)) };
        let name = if raw[0] != 0 {
            utf16_to_string(&raw)
        } else {
            ansi.iter()
                .take_while(|&&c| c != 0)
                .map(|&c| c as u8 as char)
                .collect()
        };
        let is_dir = flags & RHDF_DIRECTORY != 0;
        let unp = unsafe { ptr::read_unaligned(ptr::addr_of!(h.unp_size)) } as u64
            | ((unsafe { ptr::read_unaligned(ptr::addr_of!(h.unp_size_high)) } as u64) << 32);
        let pack = unsafe { ptr::read_unaligned(ptr::addr_of!(h.pack_size)) } as u64
            | ((unsafe { ptr::read_unaligned(ptr::addr_of!(h.pack_size_high)) } as u64) << 32);
        if !is_dir {
            total_size += unp;
            total_packed += pack;
        }
        encrypted |= flags & RHDF_ENCRYPTED != 0;
        solid |= flags & RHDF_SOLID != 0;
        let ftime = unsafe { ptr::read_unaligned(ptr::addr_of!(h.file_time)) };
        let modified = if ftime > 0 {
            let s = ((ftime & 0x1f) * 2) as u8;
            let mi = ((ftime >> 5) & 0x3f) as u8;
            let h = ((ftime >> 11) & 0x1f) as u8;
            let d = ((ftime >> 16) & 0x1f) as u8;
            let mo = ((ftime >> 21) & 0x0f) as u8;
            let y = (((ftime >> 25) & 0x7f) + 1980) as u16;
            super::modified_string(Some((y, mo, d, h, mi, s)))
        } else {
            "—".to_string()
        };
        entries.push(EntryInfo {
            index,
            name: name.replace('\\', "/"),
            is_dir,
            size: unp,
            packed: pack,
            modified,
            encrypted: flags & RHDF_ENCRYPTED != 0,
            crc: unsafe { ptr::read_unaligned(ptr::addr_of!(h.file_crc)) },
        });
        index += 1;
        let skip = api.process(handle, RAR_SKIP, None, None);
        if skip != 0 {
            api.close(handle);
            bail!("RAR 跳过条目失败: {}", rar_error(skip));
        }
    }
    api.close(handle);
    Ok(ArchiveInfo {
        path: path.display().to_string(),
        format: "RAR".into(),
        entries,
        total_size,
        total_packed,
        encrypted,
        solid,
        comment: String::new(),
        needs_rar: false,
        rar_ready: true,
    })
}

pub fn extract(
    path: &Path,
    out_dir: &Path,
    selected: &HashSet<usize>,
    password: Option<&str>,
    policy: Overwrite,
    profile: PerfProfile,
    progress: &Progress,
    control: &TaskControl,
) -> Result<ExtractReport> {
    let _prio = ThreadPriorityGuard::enter(profile.mode);
    let data_dir = super::data_dir_for_rar();
    let dll = dll_path(&data_dir);
    if !dll.exists() {
        bail!("RAR 组件尚未安装");
    }
    let api = RarApi::load(&dll)?;
    // 声明顺序保证 HandleGuard 先于 cb_state Drop，避免 UnRAR 持有悬空回调上下文。
    let cb_state = RarCbState {
        control: control as *const TaskControl,
        progress: progress as *const Progress,
        extracting: AtomicBool::new(false),
        entry_bytes: AtomicU64::new(0),
        saver_pace: profile.saver_pace,
        paced: AtomicU64::new(0),
    };
    let handle = api.open_archive(path, RAR_OM_EXTRACT)?;
    let _guard = HandleGuard { api: &api, handle };
    api.set_callback(handle, rar_callback, &cb_state as *const RarCbState as isize);
    if let Some(pw) = password.filter(|p| !p.is_empty()) {
        api.set_password(handle, pw);
    }
    let mut report = ExtractReport {
        files: 0,
        dirs: 0,
        bytes: 0,
        skipped: 0,
        warnings: Vec::new(),
        out_dir: out_dir.display().to_string(),
    };
    let mut index = 0usize;
    loop {
        control.checkpoint(Some(progress))?;
        let (header, rc) = api.header(handle)?;
        if rc == 10 {
            break;
        }
        if rc != 0 {
            bail!("RAR 读取失败: {}", rar_error(rc));
        }
        let Some(h) = header else { break };
        let flags = unsafe { ptr::read_unaligned(ptr::addr_of!(h.flags)) };
        let redir = unsafe { ptr::read_unaligned(ptr::addr_of!(h.redir_type)) };
        let attr = unsafe { ptr::read_unaligned(ptr::addr_of!(h.file_attr)) };
        let raw_w = unsafe { ptr::read_unaligned(ptr::addr_of!(h.file_name_w)) };
        let raw_a = unsafe { ptr::read_unaligned(ptr::addr_of!(h.file_name)) };
        let name = if raw_w[0] != 0 {
            utf16_to_string(&raw_w)
        } else {
            raw_a
                .iter()
                .take_while(|&&c| c != 0)
                .map(|&c| c as u8 as char)
                .collect()
        };
        let is_dir = flags & RHDF_DIRECTORY != 0;
        let size = unsafe { ptr::read_unaligned(ptr::addr_of!(h.unp_size)) } as u64
            | ((unsafe { ptr::read_unaligned(ptr::addr_of!(h.unp_size_high)) } as u64) << 32);
        let wanted = selected.contains(&index);
        index += 1;
        if !wanted {
            let skip = api.process(handle, RAR_SKIP, None, None);
            if skip != 0 {
                bail!("RAR 跳过条目失败: {}", rar_error(skip));
            }
            continue;
        }
        if redir != 0 || attr & 0x400 != 0 {
            report.skipped += 1;
            report
                .warnings
                .push(format!("跳过重解析点/符号链接: {name}"));
            let _ = api.process(handle, RAR_SKIP, None, None);
            continue;
        }
        if is_dir {
            if let Ok(rel) = safe_relative(&name) {
                let dir = out_dir.join(rel);
                if fs::create_dir_all(&dir).is_ok() {
                    report.dirs += 1;
                }
            }
            let _ = api.process(handle, RAR_SKIP, None, None);
            continue;
        }
        let rel = match safe_relative(&name) {
            Ok(r) => r,
            Err(e) => {
                report.skipped += 1;
                report.warnings.push(format!("{e}"));
                let _ = api.process(handle, RAR_SKIP, None, None);
                continue;
            }
        };
        let target = match resolve_dest(out_dir.join(&rel), false, policy)? {
            Some(p) => p,
            None => {
                report.skipped += 1;
                progress.add_bytes(size);
                progress.file_done();
                let _ = api.process(handle, RAR_SKIP, None, None);
                continue;
            }
        };
        ensure_parent(&target)?;
        let parent = target.parent().unwrap_or(out_dir);
        let original_name = std::path::Path::new(&name)
            .file_name()
            .map(|s| s.to_os_string())
            .unwrap_or_else(|| std::ffi::OsString::from("file"));
        let extracted = parent.join(&original_name);

        progress.set_current(&name);
        cb_state.entry_bytes.store(0, Ordering::Relaxed);
        cb_state.extracting.store(true, Ordering::Release);
        let rc = api.process(handle, RAR_EXTRACT, Some(parent), None);
        cb_state.extracting.store(false, Ordering::Release);

        if control.is_cancelled() {
            let _ = fs::remove_file(&extracted);
            if extracted != target {
                let _ = fs::remove_file(&target);
            }
            bail!("操作已取消");
        }
        if rc != 0 {
            let _ = fs::remove_file(&extracted);
            report.skipped += 1;
            report.warnings.push(format!("{name}: {}", rar_error(rc)));
            let _ = api.process(handle, RAR_SKIP, None, None);
            continue;
        }
        if extracted != target {
            if let Err(e) = fs::rename(&extracted, &target) {
                report.skipped += 1;
                report
                    .warnings
                    .push(format!("{name}: 重命名失败: {e}"));
                continue;
            }
        }
        let reported = cb_state.entry_bytes.load(Ordering::Relaxed);
        if size > reported {
            progress.add_bytes(size - reported);
        }
        report.files += 1;
        report.bytes += size;
        progress.file_done();
    }
    progress.finish();
    Ok(report)
}

pub fn read_entry(
    path: &Path,
    index: usize,
    password: Option<&str>,
    limit: u64,
) -> Result<Vec<u8>> {
    let data_dir = super::data_dir_for_rar();
    let dll = dll_path(&data_dir);
    if !dll.exists() {
        bail!("RAR 组件尚未安装");
    }
    let api = RarApi::load(&dll)?;
    let handle = api.open_archive(path, RAR_OM_EXTRACT)?;
    if let Some(pw) = password.filter(|p| !p.is_empty()) {
        api.set_password(handle, pw);
    }
    let tmp = std::env::temp_dir().join(format!(
        "tidy-rar-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ));
    fs::create_dir_all(&tmp)?;
    let mut found: Option<Vec<u8>> = None;
    let mut i = 0usize;
    loop {
        let (header, rc) = api.header(handle)?;
        if rc == 10 {
            break;
        }
        if rc != 0 {
            break;
        }
        let Some(h) = header else { break };
        let flags = unsafe { ptr::read_unaligned(ptr::addr_of!(h.flags)) };
        let raw_w = unsafe { ptr::read_unaligned(ptr::addr_of!(h.file_name_w)) };
        let name = utf16_to_string(&raw_w);
        if i == index && flags & RHDF_DIRECTORY == 0 {
            let base = safe_relative(&name)
                .ok()
                .and_then(|p| p.file_name().map(|s| s.to_string_lossy().to_string()))
                .unwrap_or_else(|| "preview.bin".to_string());
            let rc = api.process(handle, RAR_EXTRACT, Some(&tmp), Some(&base));
            if rc == 0 {
                let mut f = fs::File::open(tmp.join(&base))?;
                let mut data = Vec::new();
                std::io::Read::take(&mut f, limit).read_to_end(&mut data)?;
                found = Some(data);
            }
            break;
        }
        i += 1;
        if api.process(handle, RAR_SKIP, None, None) != 0 {
            break;
        }
    }
    api.close(handle);
    let _ = fs::remove_dir_all(&tmp);
    found.context("未找到该 RAR 条目")
}
