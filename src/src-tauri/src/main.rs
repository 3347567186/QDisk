// 发布版不要控制台窗口：Windows 下把子系统设为 windows，
// 否则每次启动都会额外弹一个黑色终端（双击快捷方式时最明显）。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::menu::{Menu, MenuItem};

mod archive;
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager, State, WindowEvent};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

struct Engine {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

struct AppState {
    // 用 Arc 是为了让阻塞的引擎调用可以搬到线程池里执行：
    // spawn_blocking 要求闭包 'static，不能借用 State。
    engine: Arc<Mutex<Option<Engine>>>,
}

/// is_admin 的结果在一个进程生命周期里不会变，缓存一次即可。
/// net session 单次 20–170ms，而每个页面 mount 都会问一次。
static ADMIN_CACHE: OnceLock<bool> = OnceLock::new();

/// 商店应用枚举（PowerShell Get-AppxPackage）约 1 秒，缓存 5 分钟。
static STORE_CACHE: Mutex<Option<(Instant, Vec<Value>)>> = Mutex::new(None);
const STORE_CACHE_TTL: Duration = Duration::from_secs(300);

// ---------------------------------------------------------------- paths

fn env_dir(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).map(PathBuf::from)
}

fn data_dir() -> PathBuf {
    let base = env_dir("LOCALAPPDATA").unwrap_or_else(|| PathBuf::from("."));
    base.join("整理助手数据")
}

fn log_dir() -> PathBuf {
    data_dir().join("logs")
}

fn config_path() -> PathBuf {
    data_dir().join("app.json")
}

fn exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

fn engine_exe(handle: &tauri::AppHandle) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    let here = exe_dir();
    candidates.push(here.join("引擎").join("整理助手引擎.exe"));
    candidates.push(here.join("整理助手引擎.exe"));
    if let Ok(res) = handle.path().resource_dir() {
        candidates.push(res.join("引擎").join("整理助手引擎.exe"));
    }
    candidates.push(here.join("..").join("引擎").join("整理助手引擎.exe"));
    candidates.into_iter().find(|p| p.exists())
}

// ---------------------------------------------------------------- log

fn append_log(level: &str, msg: &str) {
    let dir = log_dir();
    let _ = std::fs::create_dir_all(&dir);
    let name = format!("app-{}.log", chrono_like_stamp());
    let path = dir.join(name);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "[{}] [{}] {}", clock(), level, msg);
    }
}

fn clock() -> String {
    // 用系统时间做本地时间字符串，避免引入 chrono 依赖
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let secs = now % 86400;
    let days = now / 86400;
    // 本地时区偏移（秒），Windows 下用 GetTimeZoneInformation 略复杂，这里用文件时间近似
    let _ = days;
    format!("{:02}:{:02}:{:02}", secs / 3600, (secs % 3600) / 60, secs % 60)
}

fn chrono_like_stamp() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = now / 86400;
    // 1970-01-01 起的天数换算成 yyyyMMdd
    let mut y = 1970i64;
    let mut d = days as i64;
    loop {
        let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
        let len = if leap { 366 } else { 365 };
        if d >= len {
            d -= len;
            y += 1;
        } else {
            break;
        }
    }
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let months = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut m = 0usize;
    let mut rest = d;
    while m < 12 && rest >= months[m] {
        rest -= months[m];
        m += 1;
    }
    format!("{:04}{:02}{:02}", y, m + 1, rest + 1)
}

// ---------------------------------------------------------------- config

fn read_config() -> Value {
    if let Ok(text) = std::fs::read_to_string(config_path()) {
        if let Ok(v) = serde_json::from_str::<Value>(&text) {
            return v;
        }
    }
    json!({
        "theme": "light",
        "lang": "zh-CN",
        "close_action": "tray",
        "last_folder": "",
        "scheduled": { "enabled": false, "time": "03:00", "folder": "" }
    })
}

fn write_config(cfg: &Value) -> Result<(), String> {
    let dir = data_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败：{e}"))?;
    let text = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(config_path(), text).map_err(|e| format!("写入配置失败：{e}"))
}

#[tauri::command]
fn config_get() -> Value {
    read_config()
}

#[tauri::command]
fn config_set(patch: Value) -> Result<Value, String> {
    let mut cfg = read_config();
    if let (Some(dst), Some(src)) = (cfg.as_object_mut(), patch.as_object()) {
        for (k, v) in src {
            dst.insert(k.clone(), v.clone());
        }
    }
    write_config(&cfg)?;
    Ok(cfg)
}

// ---------------------------------------------------------------- engine

/// 把引擎的数据目录固定到 %LOCALAPPDATA%\整理助手数据，
/// 避免和安装目录（%LOCALAPPDATA%\整理助手）混在一起、卸载时误删。
fn ensure_engine_data_dir(engine: &Path) {
    let Some(dir) = engine.parent() else { return };
    let locator = dir.join("数据位置.json");
    let want = data_dir();
    let _ = std::fs::create_dir_all(&want);
    let current = std::fs::read_to_string(&locator)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("data_dir").and_then(|d| d.as_str()).map(str::to_string));
    let want_text = want.to_string_lossy().to_string();
    if current.as_deref() == Some(want_text.as_str()) {
        return;
    }
    let body = json!({ "data_dir": want_text, "updated": clock() });
    if let Ok(txt) = serde_json::to_string_pretty(&body) {
        let _ = std::fs::write(&locator, txt);
    }
}

fn spawn_engine(handle: &tauri::AppHandle) -> Result<Engine, String> {
    let exe = engine_exe(handle).ok_or("找不到 整理助手引擎.exe")?;
    ensure_engine_data_dir(&exe);
    let mut cmd = Command::new(&exe);
    cmd.arg("--engine")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let mut child = cmd.spawn().map_err(|e| format!("启动引擎失败：{e}"))?;
    let stdin = child.stdin.take().ok_or("引擎 stdin 不可用")?;
    let stdout = BufReader::new(child.stdout.take().ok_or("引擎 stdout 不可用")?);
    if let Some(err) = child.stderr.take() {
        std::thread::spawn(move || {
            let mut r = BufReader::new(err);
            let mut line = String::new();
            while r.read_line(&mut line).unwrap_or(0) > 0 {
                let t = line.trim_end().to_string();
                if !t.is_empty() {
                    append_log("engine", &t);
                }
                line.clear();
            }
        });
    }
    append_log("info", &format!("引擎已启动：{}", exe.display()));
    Ok(Engine { child, stdin, stdout, next_id: 1 })
}

fn call_raw(engine: &mut Engine, method: &str, params: Value) -> Result<Value, String> {
    let id = engine.next_id;
    engine.next_id += 1;
    let req = json!({ "id": id, "method": method, "params": params });
    let mut line = serde_json::to_string(&req).map_err(|e| e.to_string())?;
    line.push('\n');
    engine
        .stdin
        .write_all(line.as_bytes())
        .map_err(|e| format!("写引擎失败：{e}"))?;
    engine.stdin.flush().map_err(|e| e.to_string())?;
    let mut resp = String::new();
    engine
        .stdout
        .read_line(&mut resp)
        .map_err(|e| format!("读引擎失败：{e}"))?;
    if resp.trim().is_empty() {
        return Err("引擎没有返回（可能已退出）".into());
    }
    let v: Value =
        serde_json::from_str(resp.trim()).map_err(|e| format!("引擎返回非法 JSON：{e}"))?;
    if v.get("ok").and_then(|b| b.as_bool()) == Some(true) {
        Ok(v.get("result").cloned().unwrap_or(Value::Null))
    } else {
        Err(v
            .get("error")
            .and_then(|e| e.as_str())
            .unwrap_or("引擎调用失败")
            .to_string())
    }
}

/// 真正跑引擎调用的同步逻辑。只能在 spawn_blocking 的线程里调用：
/// 它会在管道上阻塞读，绝不能回到主线程。
fn engine_call_blocking(
    app: &tauri::AppHandle,
    engine: &Arc<Mutex<Option<Engine>>>,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let mut guard = engine.lock().map_err(|_| "引擎锁失败")?;
    if guard.is_none() {
        *guard = Some(spawn_engine(app)?);
    }
    let eng = guard.as_mut().unwrap();
    match call_raw(eng, method, params.clone()) {
        Ok(v) => Ok(v),
        Err(e) => {
            // 管道断开时自动重启一次
            let broken = e.contains("写引擎失败") || e.contains("读引擎失败") || e.contains("没有返回");
            if !broken {
                return Err(e);
            }
            append_log("warn", &format!("引擎异常，重启：{e}"));
            if let Some(mut old) = guard.take() {
                let _ = old.child.kill();
            }
            *guard = Some(spawn_engine(app)?);
            call_raw(guard.as_mut().unwrap(), method, params)
        }
    }
}

#[tauri::command]
async fn engine_call(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    method: String,
    params: Option<Value>,
) -> Result<Value, String> {
    let engine = Arc::clone(&state.engine);
    let params = params.unwrap_or_else(|| json!({}));
    // 同步命令会在主线程执行；引擎一次调用可能几十毫秒到几秒，
    // 搬到线程池后页面动画/滚动不再被管道读阻塞。
    tauri::async_runtime::spawn_blocking(move || {
        engine_call_blocking(&app, &engine, &method, params)
    })
    .await
    .map_err(|e| format!("引擎任务失败：{e}"))?
}

#[tauri::command]
async fn engine_restart(state: State<'_, AppState>, app: tauri::AppHandle) -> Result<bool, String> {
    let engine = Arc::clone(&state.engine);
    tauri::async_runtime::spawn_blocking(move || -> Result<bool, String> {
        let mut guard = engine.lock().map_err(|_| "引擎锁失败")?;
        if let Some(mut old) = guard.take() {
            let _ = old.child.kill();
        }
        *guard = Some(spawn_engine(&app)?);
        Ok(true)
    })
    .await
    .map_err(|e| format!("引擎重启失败：{e}"))?
}

#[tauri::command(async)]
fn engine_sleep(state: State<'_, AppState>) -> Result<bool, String> {
    // 静默模式：退出常驻引擎进程，下一次调用会按需重启
    let mut guard = state.engine.lock().map_err(|_| "引擎锁失败")?;
    if let Some(mut old) = guard.take() {
        let _ = old.child.kill();
        let _ = old.child.wait();
        append_log("info", "静默模式：引擎已退出");
    }
    Ok(true)
}

#[tauri::command(async)]
fn engine_info(app: tauri::AppHandle, state: State<'_, AppState>) -> Value {
    // 同步实现：锁只短暂持有，不跨 await，避免 async 命令持有 State 引用
    let pid = state
        .engine
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|e| e.child.id()))
        .unwrap_or(0);
    let exe = engine_exe(&app)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    json!({
        "exe": exe,
        "pid": pid,
        "data_dir": data_dir().to_string_lossy().to_string(),
        "log_dir": log_dir().to_string_lossy().to_string()
    })
}

// ---------------------------------------------------------------- files / shell

#[tauri::command]
fn pick_folder(start: Option<String>) -> Option<String> {
    let mut dlg = rfd::FileDialog::new();
    if let Some(s) = start {
        if !s.is_empty() && Path::new(&s).is_dir() {
            dlg = dlg.set_directory(s);
        }
    }
    dlg.pick_folder().map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
fn save_text(name: String, content: String) -> Result<Option<String>, String> {
    let mut dlg = rfd::FileDialog::new().set_file_name(&name);
    if let Some(home) = env_dir("USERPROFILE") {
        let d = home.join("Downloads");
        if d.is_dir() {
            dlg = dlg.set_directory(d);
        }
    }
    let Some(path) = dlg.save_file() else {
        return Ok(None);
    };
    std::fs::write(&path, content.as_bytes()).map_err(|e| format!("写入失败：{e}"))?;
    Ok(Some(path.to_string_lossy().to_string()))
}

#[tauri::command]
fn reveal(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    let mut cmd = Command::new("explorer.exe");
    if p.is_dir() {
        cmd.arg(&path);
    } else {
        cmd.arg(format!("/select,{}", path));
    }
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", "start", "", &path]);
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn app_info() -> Value {
    json!({
        "version": env!("CARGO_PKG_VERSION"),
        "exe_dir": exe_dir().to_string_lossy().to_string(),
        "data_dir": data_dir().to_string_lossy().to_string(),
        "log_dir": log_dir().to_string_lossy().to_string(),
    })
}

/// 全屏切换：给顶栏的「全屏」按钮和 F11 快捷键用。
#[tauri::command]
fn toggle_fullscreen(window: tauri::WebviewWindow) -> Result<bool, String> {
    let now = window.is_fullscreen().map_err(|e| e.to_string())?;
    window.set_fullscreen(!now).map_err(|e| e.to_string())?;
    Ok(!now)
}

/// 原生标题栏跟随应用主题。
/// Windows 的标题栏默认跟随系统深浅色，不做同步时浅色界面上会留一条黑边。
#[tauri::command]
fn set_window_theme(window: tauri::WebviewWindow, theme: String) -> Result<(), String> {
    let t = if theme == "dark" {
        tauri::Theme::Dark
    } else {
        tauri::Theme::Light
    };
    window.set_theme(Some(t)).map_err(|e| e.to_string())
}

#[cfg(target_os = "windows")]
#[link(name = "user32")]
extern "system" {
    fn ShowWindow(hwnd: isize, cmd: i32) -> i32;
    fn IsZoomed(hwnd: isize) -> i32;
    fn GetCursorPos(p: *mut POINT) -> i32;
    fn GetWindowRect(hwnd: isize, r: *mut RECT) -> i32;
    fn SetWindowPos(hwnd: isize, after: isize, x: i32, y: i32, cx: i32, cy: i32, flags: u32) -> i32;
    fn GetAsyncKeyState(vk: i32) -> i16;
}
#[cfg(target_os = "windows")]
#[repr(C)]
#[derive(Default)]
struct POINT {
    x: i32,
    y: i32,
}
#[cfg(target_os = "windows")]
#[repr(C)]
#[derive(Default)]
struct RECT {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}
const SW_MAXIMIZE: i32 = 3;
const SW_RESTORE: i32 = 9;
const SWP_NOSIZE: u32 = 0x0001;
const SWP_NOZORDER: u32 = 0x0004;
const SWP_NOACTIVATE: u32 = 0x0010;
const VK_LBUTTON: i32 = 0x01;

/// 自绘标题栏拖动：在后台线程里跟随鼠标移动窗口。
/// 不走 WM_NCLBUTTONDOWN，避免无边框窗口上原生 caption 拖动不生效。
#[tauri::command]
fn window_begin_drag(window: tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
        std::thread::spawn(move || unsafe {
            if IsZoomed(hwnd) != 0 {
                return;
            }
            let mut start = POINT::default();
            if GetCursorPos(&mut start) == 0 {
                return;
            }
            let mut rect = RECT::default();
            if GetWindowRect(hwnd, &mut rect) == 0 {
                return;
            }
            loop {
                if (GetAsyncKeyState(VK_LBUTTON) as u16 & 0x8000) == 0 {
                    break;
                }
                // 拖动途中窗口被最大化（双击标题栏）时立刻收手，避免把最大化又拖回还原态
                if IsZoomed(hwnd) != 0 {
                    break;
                }
                let mut p = POINT::default();
                if GetCursorPos(&mut p) == 0 {
                    break;
                }
                SetWindowPos(
                    hwnd,
                    0,
                    rect.left + (p.x - start.x),
                    rect.top + (p.y - start.y),
                    0,
                    0,
                    SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
                );
                std::thread::sleep(std::time::Duration::from_millis(8));
            }
        });
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = window;
        Err("only supported on Windows".into())
    }
}

/// 自绘标题栏用：无边框窗口的最大化 / 还原。
/// 直接走 Win32，避免 WebView 侧 toggleMaximize 在无边框窗口上状态不同步。
#[tauri::command]
fn window_toggle_maximize(window: tauri::WebviewWindow) -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
        unsafe {
            if IsZoomed(hwnd) != 0 {
                ShowWindow(hwnd, SW_RESTORE);
            } else {
                ShowWindow(hwnd, SW_MAXIMIZE);
            }
            Ok(IsZoomed(hwnd) != 0)
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = window;
        Err("only supported on Windows".into())
    }
}

/// 当前窗口是否最大化（给自绘标题栏切换按钮图标用）。
#[tauri::command]
fn window_is_maximized(window: tauri::WebviewWindow) -> bool {
    #[cfg(target_os = "windows")]
    {
        match window.hwnd() {
            Ok(h) => unsafe { IsZoomed(h.0 as isize) != 0 },
            Err(_) => false,
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = window;
        false
    }
}

/// 当前进程是否已提权。`net session` 需要管理员令牌，成功即视为已提权；
/// 普通权限下会立即失败（约 20ms），不会弹任何窗口。
#[tauri::command(async)]
fn is_admin() -> bool {
    *ADMIN_CACHE.get_or_init(|| {
        match Command::new("net")
            .arg("session")
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        {
            Ok(o) => o.status.success(),
            Err(_) => false,
        }
    })
}

/// 以管理员身份重新启动自己：走 PowerShell 的 Start-Process -Verb RunAs，
/// 由系统弹 UAC；提权实例带 `--elevated` 参数（启动时跳过单实例转发），
/// 本进程在该实例起来后主动退出，把数据目录与 WebView2 profile 让出去。
#[tauri::command]
async fn run_as_admin(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    // 先把引擎收掉，避免两个引擎同时写同一个数据目录
    if let Ok(mut guard) = state.engine.lock() {
        if let Some(mut old) = guard.take() {
            let _ = old.child.kill();
        }
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe = exe.to_string_lossy().to_string();
    // 用 -EncodedCommand 传脚本：路径里有单引号、空格、中文都不会被解析坏
    let script = format!(
        "Start-Process -FilePath '{}' -ArgumentList '--elevated' -Verb RunAs",
        exe.replace('\'', "''")
    );
    let encoded = ps_encoded(&script);
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-WindowStyle", "Hidden", "-EncodedCommand", &encoded]);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.spawn().map_err(|e| e.to_string())?;
    append_log("info", "请求以管理员身份重启");
    let handle = app.clone();
    std::thread::spawn(move || {
        // 给提权实例一点启动时间，再释放单实例锁与 profile
        std::thread::sleep(std::time::Duration::from_millis(900));
        handle.exit(0);
    });
    Ok(())
}

/// PowerShell `-EncodedCommand` 要 UTF-16LE 字节的 Base64；这里自己编码，不引依赖。
fn ps_encoded(script: &str) -> String {
    let mut bytes = Vec::with_capacity(script.len() * 2);
    for unit in script.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    const TBL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TBL[(n >> 18) as usize & 63] as char);
        out.push(TBL[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TBL[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TBL[n as usize & 63] as char } else { '=' });
    }
    out
}

// ---------------------------------------------------------------- startup

const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";

#[tauri::command(async)]
fn get_autostart() -> bool {
    let out = Command::new("reg")
        .args(["query", RUN_KEY, "/v", "TidyAssistant"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    matches!(out, Ok(o) if o.status.success())
}

#[tauri::command(async)]
fn set_autostart(enabled: bool) -> Result<bool, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe = exe.to_string_lossy().to_string();
    let out = if enabled {
        Command::new("reg")
            .args([
                "add", RUN_KEY, "/v", "TidyAssistant", "/t", "REG_SZ", "/d", &format!("\"{exe}\""), "/f",
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
    } else {
        Command::new("reg")
            .args(["delete", RUN_KEY, "/v", "TidyAssistant", "/f"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
    };
    match out {
        Ok(o) if o.status.success() => Ok(enabled),
        Ok(o) => Err(String::from_utf8_lossy(&o.stderr).to_string()),
        Err(e) => Err(e.to_string()),
    }
}

const TASK_NAME: &str = "整理助手_定时清理";

#[tauri::command(async)]
fn schedule_set(enabled: bool, time: String, days: i64, cache: bool, screenshots: bool) -> Result<bool, String> {
    if !enabled {
        let _ = Command::new("schtasks")
            .args(["/Delete", "/TN", TASK_NAME, "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        let mut cfg = read_config();
        cfg["clean_schedule"] = json!({ "enabled": false, "time": time, "days": days, "cache": cache, "screenshots": screenshots });
        write_config(&cfg)?;
        return Ok(false);
    }
    if !cache && !screenshots {
        return Err("请至少选择缓存或截图中的一项".into());
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let tr = format!("\"{}\" --auto-clean", exe.to_string_lossy());
    let out = Command::new("schtasks")
        .args([
            "/Create", "/SC", "DAILY", "/ST", &time, "/TN", TASK_NAME, "/TR", &tr, "/F",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        let mut cfg = read_config();
        cfg["clean_schedule"] = json!({ "enabled": true, "time": time, "days": days, "cache": cache, "screenshots": screenshots });
        write_config(&cfg)?;
        Ok(true)
    } else {
        Err(String::from_utf8_lossy(&out.stderr).to_string())
    }
}

#[tauri::command(async)]
fn schedule_get() -> Value {
    let out = Command::new("schtasks")
        .args(["/Query", "/TN", TASK_NAME])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    let exists = matches!(out, Ok(o) if o.status.success());
    let cfg = read_config();
    let mut s = cfg.get("clean_schedule").cloned().unwrap_or_else(|| json!({}));
    s["exists"] = json!(exists);
    s
}

// ---------------------------------------------------------------- logs

#[tauri::command]
fn log_line(level: String, msg: String) {
    append_log(&level, &msg);
}

#[tauri::command(async)]
fn log_list() -> Vec<Value> {
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(log_dir()) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().map(|x| x == "log").unwrap_or(false) {
                let size = e.metadata().map(|m| m.len()).unwrap_or(0);
                let mtime = e
                    .metadata()
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                out.push(json!({
                    "name": p.file_name().unwrap_or_default().to_string_lossy(),
                    "path": p.to_string_lossy(),
                    "size": size,
                    "mtime": mtime
                }));
            }
        }
    }
    out.sort_by(|a, b| b["mtime"].as_u64().cmp(&a["mtime"].as_u64()));
    out
}

/// 读取任意文本文件（规则 YAML、迁移报告等），带大小上限。
#[tauri::command(async)]
fn read_text(path: String, max_bytes: Option<u64>) -> Result<String, String> {
    let mut f = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let limit = max_bytes.unwrap_or(512 * 1024).min(len);
    if len > limit {
        use std::io::Seek;
        f.seek(std::io::SeekFrom::Start(len - limit)).map_err(|e| e.to_string())?;
    }
    let mut s = String::new();
    f.read_to_string(&mut s).map_err(|e| e.to_string())?;
    Ok(s)
}

/// 只读日志目录内的文件，避免前端拿到任意路径后读取系统文件。
#[tauri::command(async)]
fn log_read(path: String, max_bytes: Option<u64>) -> Result<String, String> {
    let p = std::fs::canonicalize(&path).map_err(|e| e.to_string())?;
    let root = std::fs::canonicalize(log_dir()).unwrap_or_else(|_| log_dir());
    if !p.starts_with(&root) {
        return Err("只能读取日志目录内的文件".into());
    }
    read_text(p.to_string_lossy().to_string(), max_bytes)
}

#[tauri::command(async)]
fn log_clear() -> Result<(), String> {
    if let Ok(rd) = std::fs::read_dir(log_dir()) {
        for e in rd.flatten() {
            let _ = std::fs::remove_file(e.path());
        }
    }
    Ok(())
}

// ---------------------------------------------------------------- 实用工具
// 大文件排行 / 空文件夹清理 / 操作历史：直接读文件系统与引擎历史，无需引擎参与。

const WALK_MAX_DEPTH: usize = 12;

fn walk_files<F: FnMut(&std::path::Path, u64, u64)>(dir: &std::path::Path, depth: usize, f: &mut F) {
    if depth > WALK_MAX_DEPTH {
        return;
    }
    let rd = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    for ent in rd.flatten() {
        let path = ent.path();
        let md = match std::fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if md.file_type().is_symlink() {
            continue;
        }
        if md.is_dir() {
            walk_files(&path, depth + 1, f);
        } else if md.is_file() {
            let mtime = md
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            f(&path, md.len(), mtime);
        }
    }
}

#[tauri::command(async)]
fn top_files(dir: String, limit: usize) -> Result<Vec<Value>, String> {
    let root = std::path::PathBuf::from(&dir);
    if !root.is_dir() {
        return Err(format!("目录不存在：{dir}"));
    }
    let mut items: Vec<(u64, std::path::PathBuf, u64)> = Vec::new();
    walk_files(&root, 0, &mut |p, size, mtime| {
        items.push((size, p.to_path_buf(), mtime));
    });
    items.sort_by(|a, b| b.0.cmp(&a.0));
    let limit = limit.clamp(10, 500);
    Ok(items
        .into_iter()
        .take(limit)
        .map(|(size, p, mtime)| {
            json!({
                "path": p.to_string_lossy().to_string(),
                "name": p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
                "dir": p.parent().map(|d| d.to_string_lossy().to_string()).unwrap_or_default(),
                "ext": p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default(),
                "size": size,
                "mtime": mtime,
            })
        })
        .collect())
}

/// 取文件/文件夹的真实来源：版本信息里的公司、产品，以及 Authenticode 签名状态。
/// 一次 PowerShell 批量问，最多 80 个，避免逐个进程把界面拖住。
const SIG_SCRIPT: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
# 从 Tauri 启动时 PSModulePath 往往指向 PowerShell 7 的目录，5.1 的 Security 模块会加载失败，
# 于是 Authenticode 检查全部变成 Unknown。先钉回 Windows PowerShell 自带模块路径。
try { $env:PSModulePath = Join-Path $env:SystemRoot 'system32\WindowsPowerShell\v1.0\Modules' } catch {}
Import-Module Microsoft.PowerShell.Security -ErrorAction SilentlyContinue
$raw = [Console]::In.ReadToEnd()
if (-not $raw) { '[]'; exit }
$paths = $raw | ConvertFrom-Json
$out = @()
foreach ($p in @($paths)) {
  $vi = $null; $sig = $null; $signer = ''
  try { $vi = (Get-Item -LiteralPath $p -Force).VersionInfo } catch {}
  try {
    $cert = [System.Security.Cryptography.X509Certificates.X509Certificate]::CreateFromSignedFile($p)
    if ($cert) { $signer = [string]$cert.Subject }
  } catch {}
  try { $sig = Get-AuthenticodeSignature -LiteralPath $p } catch {}
  $status = 'Unknown'
  if ($sig) { $status = [string]$sig.Status }
  elseif ($signer) { $status = 'Present' }
  if (-not $signer -and $sig -and $sig.SignerCertificate) { $signer = [string]$sig.SignerCertificate.Subject }
  $out += [pscustomobject]@{
    path    = [string]$p
    company = [string]$vi.CompanyName
    product = [string]$vi.ProductName
    desc    = [string]$vi.FileDescription
    sig     = $status
    signer  = $signer
  }
}
ConvertTo-Json -InputObject @($out) -Compress -Depth 3
"#;

#[tauri::command(async)]
fn file_signals(paths: Vec<String>) -> Result<Value, String> {
    let capped: Vec<String> = paths.into_iter().filter(|p| !p.trim().is_empty()).take(80).collect();
    if capped.is_empty() {
        return Ok(json!({ "items": [] }));
    }
    let payload = serde_json::to_string(&capped).map_err(|e| e.to_string())?;
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", SIG_SCRIPT]);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = cmd.spawn().map_err(|e| format!("启动 PowerShell 失败：{e}"))?;
    if let Some(si) = child.stdin.as_mut() {
        let _ = si.write_all(payload.as_bytes());
    }
    drop(child.stdin.take());
    // 最多等 25 秒，PowerShell 卡住就杀掉，别把界面吊死。
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if started.elapsed() > Duration::from_secs(25) {
                    let _ = child.kill();
                    return Err("读取签名超时".into());
                }
                std::thread::sleep(Duration::from_millis(80));
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    let mut text = String::new();
    if let Some(mut so) = child.stdout.take() {
        let _ = so.read_to_string(&mut text);
    }
    let text = text.trim();
    if text.is_empty() {
        return Ok(json!({ "items": [] }));
    }
    let v: Value = serde_json::from_str(text).map_err(|e| format!("签名结果解析失败：{e}"))?;
    let items = match v {
        Value::Array(a) => a,
        Value::Object(_) => vec![v],
        _ => Vec::new(),
    };
    Ok(json!({ "items": items }))
}

/* ---------------- 空文件夹：只下探 N 层，并区分「真空」与「重要」 ---------------- */

/// 程序常需要存在的空目录名。空着也可能是在等运行期写入。
const EMPTY_VITAL_NAMES: &[&str] = &[
    "config", "configs", "conf", "settings", "plugins", "plugin", "extensions", "themes", "theme",
    "templates", "logs", "log", "cache", "caches", "temp", "tmp", "data", "assets", "resources",
    "bin", "lib", "libs", "drivers", "backups", "backup", "saves", "save", "profiles", "sessions",
    "modules", "locale", "locales", "fonts", "shaders", "addons", "packs", "runtime", "certificates",
];

fn env_low(key: &str) -> String {
    std::env::var(key).unwrap_or_default().to_lowercase()
}

fn under_any(path: &Path, roots: &[String]) -> bool {
    let low = path.to_string_lossy().replace('/', "\\").to_lowercase();
    roots.iter().any(|r| {
        let r = r.trim_end_matches('\\');
        !r.is_empty() && (low == r || low.starts_with(&(r.to_string() + "\\")))
    })
}

/// 目录看起来属于某个已安装程序（Program Files / AppData / 同级有 exe）。
fn looks_like_app_zone(path: &Path) -> bool {
    let roots = vec![
        env_low("ProgramFiles"),
        env_low("ProgramFiles(x86)"),
        env_low("ProgramData"),
        env_low("LOCALAPPDATA"),
        env_low("APPDATA"),
    ];
    if under_any(path, &roots) {
        return true;
    }
    if let Some(parent) = path.parent() {
        if let Ok(rd) = std::fs::read_dir(parent) {
            for e in rd.flatten() {
                if e.path().extension().and_then(|s| s.to_str()).map(|s| s.eq_ignore_ascii_case("exe")).unwrap_or(false) {
                    return true;
                }
            }
        }
    }
    false
}

/// 空目录是否属于「不要删」：系统闸门、程序运行目录、引擎自己的数据目录。
fn empty_dir_risky(path: &Path) -> Option<&'static str> {
    let low_name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let low_path = path.to_string_lossy().replace('/', "\\").to_lowercase();

    if low_path.contains("\\_整理记录") {
        return Some("整理记录目录");
    }
    if let Ok(dd) = std::env::var("LOCALAPPDATA") {
        let ours = format!("{}\\整理助手数据", dd.to_lowercase());
        if low_path == ours || low_path.starts_with(&(ours + "\\")) {
            return Some("整理助手自己的数据目录");
        }
    }
    match low_name.as_str() {
        ".git" => return Some("Git 版本库目录"),
        ".svn" => return Some("SVN 版本库目录"),
        ".hg" => return Some("Mercurial 版本库目录"),
        ".vscode" | ".idea" => return Some("编辑器工程配置目录"),
        "node_modules" => return Some("依赖目录"),
        _ => {}
    }
    if EMPTY_VITAL_NAMES.contains(&low_name.as_str()) && looks_like_app_zone(path) {
        return Some("程序运行时可能要用到的空目录");
    }
    if low_name.starts_with('.') && looks_like_app_zone(path) {
        return Some("程序隐藏目录");
    }
    None
}

fn scan_empty_rec(
    root: &Path,
    dir: &Path,
    depth: usize,
    max_depth: usize,
    out: &mut Vec<Value>,
) {
    if depth > max_depth {
        return;
    }
    let rd = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    let entries: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
    if entries.is_empty() {
        let (kind, why) = match empty_dir_denied(dir).or_else(|| empty_dir_risky(dir)) {
            Some(w) => ("protected", w),
            None => ("empty", ""),
        };
        let rel = dir
            .strip_prefix(root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        out.push(json!({
            "path": dir.to_string_lossy().to_string(),
            "depth": depth,
            "kind": kind,
            "why": why,
            "rel": rel,
        }));
        return;
    }
    for p in entries {
        if let Ok(md) = std::fs::symlink_metadata(&p) {
            if md.is_dir() && !md.file_type().is_symlink() {
                scan_empty_rec(root, &p, depth + 1, max_depth, out);
            }
        }
    }
}

#[tauri::command(async)]
fn scan_empty_dirs(dir: String, max: usize, depth: Option<usize>) -> Result<Vec<Value>, String> {
    let root = std::path::PathBuf::from(&dir);
    if !root.is_dir() {
        return Err(format!("目录不存在：{dir}"));
    }
    // 用户要的就是「1–3 层够判断」，默认 3，最多 4。
    let depth = depth.unwrap_or(3).clamp(1, 4);
    let mut out: Vec<Value> = Vec::new();
    scan_empty_rec(&root, &root, 0, depth, &mut out);
    let max = max.clamp(20, 5000);
    // 可删的排前面（浅的优先），受保护的排后面。
    out.sort_by_key(|v| {
        let kind = v.get("kind").and_then(|k| k.as_str()).unwrap_or("empty");
        let depth = v.get("depth").and_then(|d| d.as_u64()).unwrap_or(0);
        (if kind == "empty" { 0 } else { 1 }, depth)
    });
    out.truncate(max);
    Ok(out)
}

#[tauri::command(async)]
/// 空目录清理的安全闸：盘符根、系统目录、用户主目录、程序目录一律不动。
fn empty_dir_denied(path: &Path) -> Option<&'static str> {
    let s = path.to_string_lossy().replace('/', "\\");
    let low = s.trim_end_matches('\\').to_lowercase();
    if low.len() <= 3 {
        return Some("盘符根目录");
    }
    if path.parent().is_none() {
        return Some("盘符根目录");
    }
    let sysroot = std::env::var("SystemRoot").unwrap_or_default().to_lowercase();
    let home = std::env::var("USERPROFILE").unwrap_or_default().to_lowercase();
    let mut roots: Vec<String> = Vec::new();
    if !sysroot.is_empty() { roots.push(sysroot); }
    if !home.is_empty() { roots.push(home); }
    for k in ["ProgramFiles", "ProgramFiles(x86)", "ProgramData", "PUBLIC"] {
        if let Ok(v) = std::env::var(k) {
            if !v.is_empty() { roots.push(v.to_lowercase()); }
        }
    }
    for r in roots {
        let r = r.trim_end_matches('\\').to_string();
        if low == r || low.starts_with(&(r.clone() + "\\")) {
            return Some("受保护的系统或用户目录");
        }
    }
    if low.contains("\\windows\\") || low.ends_with("\\windows") {
        return Some("Windows 目录");
    }
    None
}

#[tauri::command(async)]
fn remove_empty_dirs(paths: Vec<String>) -> Result<Value, String> {
    let mut removed = 0usize;
    let mut failed: Vec<Value> = Vec::new();
    for p in paths {
        let path = std::path::PathBuf::from(&p);
        if let Some(why) = empty_dir_denied(&path).or_else(|| empty_dir_risky(&path)) {
            failed.push(json!({ "path": p, "why": why }));
            continue;
        }
        let is_empty = std::fs::read_dir(&path)
            .map(|mut r| r.next().is_none())
            .unwrap_or(false);
        if !is_empty {
            failed.push(json!({ "path": p, "why": "目录不为空或不存在" }));
            continue;
        }
        match std::fs::remove_dir(&path) {
            Ok(_) => removed += 1,
            Err(e) => failed.push(json!({ "path": p, "why": e.to_string() })),
        }
    }
    Ok(json!({ "removed": removed, "failed": failed }))
}

#[tauri::command(async)]
fn history_list() -> Vec<Value> {
    let dir = data_dir().join("history");
    let mut out: Vec<Value> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for ent in rd.flatten() {
            let p = ent.path();
            if p.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let raw = std::fs::read_to_string(&p).unwrap_or_default();
            let v: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
            let moved = v
                .get("moves")
                .and_then(|m| m.as_array())
                .map(|a| a.len())
                .unwrap_or(0);
            let created = v
                .get("created_dirs")
                .and_then(|m| m.as_array())
                .map(|a| a.len())
                .unwrap_or(0);
            out.push(json!({
                "file": p.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string(),
                "time": v.get("time").cloned().unwrap_or(json!("")),
                "folder": v.get("folder").cloned().unwrap_or(json!("")),
                "moved": moved,
                "created": created,
            }));
        }
    }
    out.sort_by(|a, b| {
        b["time"]
            .as_str()
            .unwrap_or("")
            .cmp(a["time"].as_str().unwrap_or(""))
    });
    out
}

// ---------------------------------------------------------------- AI 助手底层
//
// 设计见 docs\01-当前版\AI助手方案.md（第三版实现）。
// 这一层只做三件「搬数据」的事，不含任何业务判断：
//   1. list_dir  只读列目录（agent 的工具 1）
//   2. ai_http   唯一网络出口（WinHTTP，零新增依赖；密钥不进页面 JS）
//   3. ai_store  会话 / 事实缓存 / usage 落盘
// 网络不重试、不解析模型业务字段：schema 校验与降级全在前端 ai\agent.js，
// 这样离线黄金集可以在 Node 里跑，不需要真的连模型。

fn ai_dir() -> PathBuf {
    data_dir().join("ai")
}

fn ai_safe_name(name: &str) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty() || n.len() > 96 {
        return Err("文件名不合法".into());
    }
    if n.contains("..") || n.contains('/') || n.contains('\\') {
        return Err("文件名不合法".into());
    }
    if !(n.ends_with(".json") || n.ends_with(".jsonl")) {
        return Err("只允许 .json 或 .jsonl".into());
    }
    if !n
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err("文件名只能包含字母、数字、- _ .".into());
    }
    Ok(n.to_string())
}

/// AI 数据目录的读写：op = list / read / write / append / delete / clear
#[tauri::command(async)]
fn ai_store(op: String, name: Option<String>, content: Option<String>) -> Result<Value, String> {
    let dir = ai_dir();
    let op = op.trim();
    if op != "list" && op != "clear" {
        std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建 AI 目录：{e}"))?;
    }
    match op {
        "list" => {
            let mut items: Vec<Value> = Vec::new();
            if let Ok(rd) = std::fs::read_dir(&dir) {
                for ent in rd.flatten() {
                    let p = ent.path();
                    let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("");
                    if ext != "json" && ext != "jsonl" {
                        continue;
                    }
                    let meta = ent.metadata().ok();
                    items.push(json!({
                        "name": p.file_name().and_then(|s| s.to_str()).unwrap_or(""),
                        "size": meta.as_ref().map(|m| m.len()).unwrap_or(0),
                        "mtime": meta
                            .and_then(|m| m.modified().ok())
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_secs())
                            .unwrap_or(0),
                    }));
                }
            }
            items.sort_by(|a, b| b["mtime"].as_u64().cmp(&a["mtime"].as_u64()));
            Ok(json!({ "dir": dir.to_string_lossy(), "items": items }))
        }
        "read" => {
            let n = ai_safe_name(name.as_deref().unwrap_or(""))?;
            let p = dir.join(&n);
            if !p.exists() {
                return Err(format!("不存在：{n}"));
            }
            let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
            if meta.len() > 8 * 1024 * 1024 {
                return Err("文件过大（超过 8 MB）".into());
            }
            let txt = std::fs::read_to_string(&p).map_err(|e| format!("读取失败：{e}"))?;
            Ok(json!({ "name": n, "content": txt }))
        }
        "write" => {
            let n = ai_safe_name(name.as_deref().unwrap_or(""))?;
            let body = content.ok_or_else(|| "缺少 content".to_string())?;
            if body.len() > 8 * 1024 * 1024 {
                return Err("内容过大（超过 8 MB）".into());
            }
            // 先写临时文件再改名：中途崩溃不会留下半个会话文件
            let tmp = dir.join(format!("{n}.tmp"));
            std::fs::write(&tmp, body.as_bytes()).map_err(|e| format!("写入失败：{e}"))?;
            std::fs::rename(&tmp, dir.join(&n)).map_err(|e| format!("写入失败：{e}"))?;
            Ok(json!({ "name": n, "size": body.len() }))
        }
        "append" => {
            let n = ai_safe_name(name.as_deref().unwrap_or(""))?;
            let body = content.ok_or_else(|| "缺少 content".to_string())?;
            let mut line = body;
            if !line.ends_with('\n') {
                line.push('\n');
            }
            use std::io::Write as _;
            let mut f = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(dir.join(&n))
                .map_err(|e| format!("追加失败：{e}"))?;
            f.write_all(line.as_bytes()).map_err(|e| format!("追加失败：{e}"))?;
            Ok(json!({ "name": n, "bytes": line.len() }))
        }
        "delete" => {
            let n = ai_safe_name(name.as_deref().unwrap_or(""))?;
            let p = dir.join(&n);
            if p.exists() {
                std::fs::remove_file(&p).map_err(|e| format!("删除失败：{e}"))?;
            }
            Ok(json!({ "deleted": true, "name": n }))
        }
        "clear" => {
            let mut removed = 0;
            if let Ok(rd) = std::fs::read_dir(&dir) {
                for ent in rd.flatten() {
                    let p = ent.path();
                    let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("");
                    if (ext == "json" || ext == "jsonl" || p.to_string_lossy().ends_with(".tmp"))
                        && std::fs::remove_file(&p).is_ok()
                    {
                        removed += 1;
                    }
                }
            }
            Ok(json!({ "removed": removed }))
        }
        other => Err(format!("未知操作：{other}")),
    }
}

/// 只读列目录：目录在前，按名字排序；给 agent 的「这个目录里有什么」。
#[tauri::command(async)]
fn list_dir(dir: String, limit: Option<usize>) -> Result<Value, String> {
    let p = PathBuf::from(dir.trim());
    if p.as_os_str().is_empty() {
        return Err("缺少目录".into());
    }
    if !p.exists() {
        return Err(format!("目录不存在：{}", p.display()));
    }
    if !p.is_dir() {
        return Err(format!("这不是文件夹：{}", p.display()));
    }
    let cap = limit.unwrap_or(100).clamp(1, 200);
    let mut files: Vec<Value> = Vec::new();
    let mut dirs: Vec<Value> = Vec::new();
    let mut total = 0usize;
    let rd = std::fs::read_dir(&p).map_err(|e| format!("无法读取目录：{e}"))?;
    for ent in rd.flatten() {
        let name = ent.file_name().to_string_lossy().to_string();
        let meta = match ent.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        total += 1;
        let is_dir = meta.is_dir();
        let ext = if is_dir {
            String::new()
        } else {
            Path::new(&name)
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_lowercase()
        };
        let item = json!({
            "name": name,
            "kind": if is_dir { "dir" } else { "file" },
            "size": if is_dir { 0 } else { meta.len() },
            "ext": ext,
            "mtime": meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0),
        });
        if is_dir {
            dirs.push(item);
        } else {
            files.push(item);
        }
    }
    let by_name = |a: &Value, b: &Value| {
        a["name"]
            .as_str()
            .unwrap_or("")
            .to_lowercase()
            .cmp(&b["name"].as_str().unwrap_or("").to_lowercase())
    };
    dirs.sort_by(by_name);
    files.sort_by(by_name);
    let shown = total.min(cap);
    dirs.truncate(cap);
    let left = cap.saturating_sub(dirs.len());
    files.truncate(left);
    let mut items = dirs;
    items.extend(files);
    Ok(json!({
        "dir": p.to_string_lossy(),
        "total": total,
        "shown": shown,
        "truncated": total > shown,
        "items": items,
    }))
}

/// 解析 http(s) 地址：返回 (是否 https, host, port, path+query)
fn split_url(url: &str) -> Result<(bool, String, u16, String), String> {
    let (secure, rest) = if let Some(r) = url.strip_prefix("https://") {
        (true, r)
    } else if let Some(r) = url.strip_prefix("http://") {
        (false, r)
    } else {
        return Err("地址必须以 http:// 或 https:// 开头".into());
    };
    let (authority, tail) = match rest.find(|c| c == '/' || c == '?') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    if authority.is_empty() {
        return Err("地址缺少主机名".into());
    }
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, pt)) if !h.is_empty() && !pt.is_empty() && pt.chars().all(|c| c.is_ascii_digit()) => (
            h.to_string(),
            pt.parse::<u16>().map_err(|_| "端口不合法".to_string())?,
        ),
        _ => (authority.to_string(), if secure { 443 } else { 80 }),
    };
    let path = if tail.starts_with('/') {
        tail.to_string()
    } else {
        format!("/{tail}")
    };
    Ok((secure, host, port, path))
}

/// 一次请求：不重试、不改写内容。返回 (状态码, 响应体文本)
/// method 只接受 POST / GET：POST 带 body（对话），GET 不带（列模型）。
#[cfg(windows)]
fn http_post(
    url: &str,
    headers: &[(String, String)],
    body: &str,
    timeout_ms: u64,
    method: &str,
) -> Result<(u32, String), String> {
    use std::ffi::c_void;
    use std::ptr;
    use windows_sys::Win32::Networking::WinHttp::{
        WinHttpCloseHandle, WinHttpConnect, WinHttpOpen, WinHttpOpenRequest, WinHttpQueryDataAvailable,
        WinHttpQueryHeaders, WinHttpReadData, WinHttpReceiveResponse, WinHttpSendRequest,
        WinHttpSetTimeouts, WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, WINHTTP_ACCESS_TYPE_NO_PROXY,
        WINHTTP_FLAG_SECURE, WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_QUERY_STATUS_CODE,
    };

    let (secure, host, port, path) = split_url(url)?;
    let timeout = timeout_ms.clamp(1000, 120_000) as i32;
    let wide = |s: &str| -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() };

    let agent_w = wide("TidyAssistant-AI/1.0");
    let host_w = wide(&host);
    let path_w = wide(&path);
    let is_get = method.eq_ignore_ascii_case("GET");
    let method_w = wide(if is_get { "GET" } else { "POST" });
    let header_text: String = headers
        .iter()
        .map(|(k, v)| format!("{k}: {v}\r\n"))
        .collect();
    let header_w = wide(&header_text);
    // 本地端点走直连，避免系统代理把 127.0.0.1 也劫走
    let local = host.eq_ignore_ascii_case("localhost") || host.starts_with("127.");
    let access = if local {
        WINHTTP_ACCESS_TYPE_NO_PROXY
    } else {
        WINHTTP_ACCESS_TYPE_DEFAULT_PROXY
    };

    unsafe {
        let session = WinHttpOpen(agent_w.as_ptr(), access, ptr::null(), ptr::null(), 0);
        if session.is_null() {
            return Err("WinHTTP 初始化失败".into());
        }
        let out = (|| -> Result<(u32, String), String> {
            WinHttpSetTimeouts(session, timeout, timeout, timeout, timeout);
            let connect = WinHttpConnect(session, host_w.as_ptr(), port, 0);
            if connect.is_null() {
                return Err(format!("无法连接 {host}:{port}"));
            }
            let flags = if secure { WINHTTP_FLAG_SECURE } else { 0 };
            let request = WinHttpOpenRequest(
                connect,
                method_w.as_ptr(),
                path_w.as_ptr(),
                ptr::null(),
                ptr::null(),
                ptr::null(),
                flags,
            );
            if request.is_null() {
                WinHttpCloseHandle(connect);
                return Err("无法创建请求".into());
            }
            let inner = (|| -> Result<(u32, String), String> {
                // GET 不带包体：有些服务端收到长度为 0 的 POST 风格包体会直接 400
                let (body_ptr, body_len) = if is_get {
                    (ptr::null::<c_void>(), 0u32)
                } else {
                    (body.as_ptr() as *const c_void, body.len() as u32)
                };
                let ok = WinHttpSendRequest(
                    request,
                    header_w.as_ptr(),
                    u32::MAX, // -1L：头是 null 结尾字符串
                    body_ptr,
                    body_len,
                    body_len,
                    0,
                );
                if ok == 0 {
                    return Err("请求发送失败（地址或代理不可达）".into());
                }
                if WinHttpReceiveResponse(request, ptr::null_mut()) == 0 {
                    return Err("服务器无响应".into());
                }
                let mut status: u32 = 0;
                let mut len = std::mem::size_of::<u32>() as u32;
                WinHttpQueryHeaders(
                    request,
                    WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                    ptr::null(),
                    &mut status as *mut _ as *mut c_void,
                    &mut len,
                    ptr::null_mut(),
                );
                let mut buf = vec![0u8; 64 * 1024];
                let mut body_out: Vec<u8> = Vec::new();
                loop {
                    let mut available: u32 = 0;
                    if WinHttpQueryDataAvailable(request, &mut available) == 0 {
                        return Err("读取响应失败".into());
                    }
                    if available == 0 {
                        break;
                    }
                    let want = available.min(buf.len() as u32);
                    let mut got: u32 = 0;
                    if WinHttpReadData(request, buf.as_mut_ptr() as *mut c_void, want, &mut got) == 0 {
                        return Err("读取响应失败".into());
                    }
                    if got == 0 {
                        break;
                    }
                    body_out.extend_from_slice(&buf[..got as usize]);
                    if body_out.len() > 8 * 1024 * 1024 {
                        return Err("响应过大（超过 8 MB）".into());
                    }
                }
                Ok((status, String::from_utf8_lossy(&body_out).to_string()))
            })();
            WinHttpCloseHandle(request);
            WinHttpCloseHandle(connect);
            inner
        })();
        WinHttpCloseHandle(session);
        out
    }
}

/// 网络出口：唯一的对外请求命令。任何模型端点都走这里。
/// 入参 {url, headers?:{k:v}, body, timeout_ms?, method?:'POST'|'GET'}，出参 {status, body, elapsed_ms}
#[tauri::command(async)]
fn ai_http(req: Value) -> Result<Value, String> {
    let url = req
        .get("url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if url.is_empty() {
        return Err("缺少 url".into());
    }
    let method = req
        .get("method")
        .and_then(|v| v.as_str())
        .unwrap_or("POST")
        .trim()
        .to_uppercase();
    if method != "POST" && method != "GET" {
        return Err("只支持 POST / GET".into());
    }
    let body = req
        .get("body")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let timeout = req
        .get("timeout_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(20_000);
    let mut headers: Vec<(String, String)> = vec![
        ("Content-Type".into(), "application/json".into()),
        ("Accept".into(), "application/json".into()),
    ];
    if let Some(h) = req.get("headers").and_then(|v| v.as_object()) {
        for (k, v) in h {
            if let Some(val) = v.as_str() {
                // 换行会破坏头结束符，直接拒绝而不是偷偷清掉
                if k.contains('\r') || k.contains('\n') || val.contains('\r') || val.contains('\n') {
                    return Err("请求头包含非法字符".into());
                }
                headers.push((k.clone(), val.to_string()));
            }
        }
    }
    let started = Instant::now();
    let (status, text) = http_post(&url, &headers, &body, timeout, &method)?;
    Ok(json!({
        "status": status,
        "body": text,
        "elapsed_ms": started.elapsed().as_millis() as u64,
    }))
}

/// 流式版本：把响应边读边推给页面（SSE 用）。返回体仍是完整全文，
/// 页面自己拆增量；这样即使服务端不认流式，页面也能按普通 JSON 处理。
#[cfg(windows)]
fn http_post_cb(
    url: &str,
    headers: &[(String, String)],
    body: &str,
    timeout_ms: u64,
    method: &str,
    on_chunk: &mut dyn FnMut(&str),
) -> Result<(u32, String), String> {
    use std::ffi::c_void;
    use std::ptr;
    use windows_sys::Win32::Networking::WinHttp::{
        WinHttpCloseHandle, WinHttpConnect, WinHttpOpen, WinHttpOpenRequest, WinHttpQueryDataAvailable,
        WinHttpQueryHeaders, WinHttpReadData, WinHttpReceiveResponse, WinHttpSendRequest,
        WinHttpSetTimeouts, WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, WINHTTP_ACCESS_TYPE_NO_PROXY,
        WINHTTP_FLAG_SECURE, WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_QUERY_STATUS_CODE,
    };

    let (secure, host, port, path) = split_url(url)?;
    let timeout = timeout_ms.clamp(1000, 300_000) as i32;
    let wide = |s: &str| -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() };

    let agent_w = wide("TidyAssistant-AI/1.0");
    let host_w = wide(&host);
    let path_w = wide(&path);
    let is_get = method.eq_ignore_ascii_case("GET");
    let method_w = wide(if is_get { "GET" } else { "POST" });
    let header_text: String = headers
        .iter()
        .map(|(k, v)| format!("{k}: {v}\r\n"))
        .collect();
    let header_w = wide(&header_text);
    let local = host.eq_ignore_ascii_case("localhost") || host.starts_with("127.");
    let access = if local {
        WINHTTP_ACCESS_TYPE_NO_PROXY
    } else {
        WINHTTP_ACCESS_TYPE_DEFAULT_PROXY
    };

    unsafe {
        let session = WinHttpOpen(agent_w.as_ptr(), access, ptr::null(), ptr::null(), 0);
        if session.is_null() {
            return Err("WinHTTP 初始化失败".into());
        }
        let out = (|| -> Result<(u32, String), String> {
            WinHttpSetTimeouts(session, timeout, timeout, timeout, timeout);
            let connect = WinHttpConnect(session, host_w.as_ptr(), port, 0);
            if connect.is_null() {
                return Err(format!("无法连接 {host}:{port}"));
            }
            let flags = if secure { WINHTTP_FLAG_SECURE } else { 0 };
            let request = WinHttpOpenRequest(
                connect,
                method_w.as_ptr(),
                path_w.as_ptr(),
                ptr::null(),
                ptr::null(),
                ptr::null(),
                flags,
            );
            if request.is_null() {
                WinHttpCloseHandle(connect);
                return Err("无法创建请求".into());
            }
            let inner = (|| -> Result<(u32, String), String> {
                let (body_ptr, body_len) = if is_get {
                    (ptr::null::<c_void>(), 0u32)
                } else {
                    (body.as_ptr() as *const c_void, body.len() as u32)
                };
                let ok = WinHttpSendRequest(
                    request,
                    header_w.as_ptr(),
                    u32::MAX,
                    body_ptr,
                    body_len,
                    body_len,
                    0,
                );
                if ok == 0 {
                    return Err("请求发送失败（地址或代理不可达）".into());
                }
                if WinHttpReceiveResponse(request, ptr::null_mut()) == 0 {
                    return Err("服务器无响应".into());
                }
                let mut status: u32 = 0;
                let mut len = std::mem::size_of::<u32>() as u32;
                WinHttpQueryHeaders(
                    request,
                    WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                    ptr::null(),
                    &mut status as *mut _ as *mut c_void,
                    &mut len,
                    ptr::null_mut(),
                );
                let mut buf = vec![0u8; 16 * 1024];
                let mut body_out: Vec<u8> = Vec::new();
                // 已推出去多少字节：中文是多字节，切在半路上会出乱码，
                // 所以每次只推「能完整解码」的那一段，剩下的留到下一轮。
                let mut emitted = 0usize;
                loop {
                    let mut available: u32 = 0;
                    if WinHttpQueryDataAvailable(request, &mut available) == 0 {
                        return Err("读取响应失败".into());
                    }
                    if available == 0 {
                        break;
                    }
                    let want = available.min(buf.len() as u32);
                    let mut got: u32 = 0;
                    if WinHttpReadData(request, buf.as_mut_ptr() as *mut c_void, want, &mut got) == 0 {
                        return Err("读取响应失败".into());
                    }
                    if got == 0 {
                        break;
                    }
                    body_out.extend_from_slice(&buf[..got as usize]);
                    if body_out.len() > 8 * 1024 * 1024 {
                        return Err("响应过大（超过 8 MB）".into());
                    }
                    let tail = &body_out[emitted..];
                    let valid = match std::str::from_utf8(tail) {
                        Ok(_) => tail.len(),
                        Err(e) => e.valid_up_to(),
                    };
                    if valid > 0 {
                        // valid 前缀一定是合法 UTF-8，from_utf8_lossy 这里不会替换任何字符
                        on_chunk(&String::from_utf8_lossy(&tail[..valid]));
                        emitted += valid;
                    }
                }
                Ok((status, String::from_utf8_lossy(&body_out).to_string()))
            })();
            WinHttpCloseHandle(request);
            WinHttpCloseHandle(connect);
            inner
        })();
        WinHttpCloseHandle(session);
        out
    }
}

/// 流式对话：每读到一段就通过 Channel 推给页面，最后再回完整结果。
#[tauri::command(async)]
fn ai_http_stream(req: Value, on_chunk: tauri::ipc::Channel<String>) -> Result<Value, String> {
    let url = req
        .get("url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if url.is_empty() {
        return Err("缺少 url".into());
    }
    let method = req
        .get("method")
        .and_then(|v| v.as_str())
        .unwrap_or("POST")
        .trim()
        .to_uppercase();
    if method != "POST" && method != "GET" {
        return Err("只支持 POST / GET".into());
    }
    let body = req
        .get("body")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let timeout = req
        .get("timeout_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(60_000);
    let mut headers: Vec<(String, String)> = vec![
        ("Content-Type".into(), "application/json".into()),
        ("Accept".into(), "text/event-stream".into()),
        ("Cache-Control".into(), "no-cache".into()),
    ];
    if let Some(h) = req.get("headers").and_then(|v| v.as_object()) {
        for (k, v) in h {
            if let Some(val) = v.as_str() {
                if k.contains('\r') || k.contains('\n') || val.contains('\r') || val.contains('\n') {
                    return Err("请求头包含非法字符".into());
                }
                headers.push((k.clone(), val.to_string()));
            }
        }
    }
    let started = Instant::now();
    let (status, text) = http_post_cb(&url, &headers, &body, timeout, &method, &mut |piece| {
        // 页面关掉或切走的瞬间送不出去，属于正常情况，不打断读取
        let _ = on_chunk.send(piece.to_string());
    })?;
    Ok(json!({
        "status": status,
        "body": text,
        "elapsed_ms": started.elapsed().as_millis() as u64,
    }))
}

/// 商店应用：直接用系统自带的 PowerShell 枚举，不引额外依赖。
#[tauri::command(async)]
fn store_apps() -> Result<Vec<Value>, String> {
    // 一次 PowerShell 枚举约 1 秒；5 分钟内重复进页面直接用缓存。
    if let Ok(g) = STORE_CACHE.lock() {
        if let Some((at, list)) = g.as_ref() {
            if at.elapsed() < STORE_CACHE_TTL {
                return Ok(list.clone());
            }
        }
    }
    // 只列用户可卸载的应用：IsFramework / NonRemovable 是运行时与系统组件，
    // 名字也是一串 GUID，列出来只会干扰卸载。
    let script = "Get-AppxPackage | Where-Object { -not $_.IsFramework -and -not $_.NonRemovable } | Select-Object Name,Version,Publisher,InstallLocation,PackageFullName,PackageFamilyName | ConvertTo-Json -Compress -Depth 3";
    let out = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("调用 PowerShell 失败：{e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let txt = String::from_utf8_lossy(&out.stdout);
    let t = txt.trim();
    if t.is_empty() {
        return Ok(Vec::new());
    }
    let parsed: Value = serde_json::from_str(t).map_err(|e| format!("解析商店应用失败：{e}"))?;
    // ConvertTo-Json 只有一项时给对象而不是数组
    let arr = match parsed {
        Value::Array(a) => a,
        other => vec![other],
    };
    let mut list: Vec<Value> = Vec::new();
    for it in arr {
        let name = it.get("Name").and_then(|x| x.as_str()).unwrap_or("");
        if name.is_empty() {
            continue;
        }
        list.push(json!({
            "name": name,
            "version": it.get("Version").and_then(|x| x.as_str()).unwrap_or(""),
            "publisher": it.get("Publisher").and_then(|x| x.as_str()).unwrap_or(""),
            "install_path": it.get("InstallLocation").and_then(|x| x.as_str()).unwrap_or(""),
            "package": it.get("PackageFullName").and_then(|x| x.as_str()).unwrap_or(""),
            "source": "store",
            "uninstall": true,
        }));
    }
    list.sort_by_key(|v| v["name"].as_str().unwrap_or("").to_lowercase());
    if let Ok(mut g) = STORE_CACHE.lock() {
        *g = Some((Instant::now(), list.clone()));
    }
    Ok(list)
}

/// 卸载商店应用：Remove-AppxPackage（当前用户范围）。
#[tauri::command(async)]
fn remove_store_app(package: String, confirm: bool) -> Result<Value, String> {
    let package = package.trim().to_string();
    if !confirm {
        return Ok(json!({ "dry_run": true, "package": package }));
    }
    if package.is_empty() {
        return Err("缺少包名".into());
    }
    // 单引号包裹 + 内部单引号翻倍，避免 PowerShell 注入
    let quoted = package.replace('\'', "''");
    let script = format!("Remove-AppxPackage -Package '{quoted}'");
    let out = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("调用 PowerShell 失败：{e}"))?;
    if out.status.success() {
        // 卸载成功后缓存作废，下次进页面重新枚举
        if let Ok(mut g) = STORE_CACHE.lock() {
            *g = None;
        }
        Ok(json!({ "removed": true, "package": package }))
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

fn downloads_dir() -> String {    env_dir("USERPROFILE")
        .map(|p| p.join("Downloads").to_string_lossy().to_string())
        .unwrap_or_default()
}

/// 托盘快捷动作：对「下载」文件夹跑一次整理（后台，不抢窗口）。
fn tray_quick_organize(app: &tauri::AppHandle) {
    let folder = downloads_dir();
    if folder.is_empty() || !std::path::Path::new(&folder).is_dir() {
        append_log("warn", "托盘整理：找不到下载文件夹");
        return;
    }
    let handle = app.clone();
    std::thread::spawn(move || {
        let st = handle.state::<AppState>();
        // 先声明 guard 再使用，保证 drop 顺序：guard 先于 st 释放（否则借用检查报 E0597）。
        let mut guard = match st.engine.lock() {
            Ok(g) => g,
            Err(_) => {
                append_log("error", "托盘整理：引擎锁不可用");
                return;
            }
        };
        if guard.is_none() {
            if let Ok(e) = spawn_engine(&handle) {
                *guard = Some(e);
            }
        }
        if let Some(engine) = guard.as_mut() {
            match call_raw(
                engine,
                "organize",
                json!({ "path": folder, "dry_run": false }),
            ) {
                Ok(v) => append_log(
                    "info",
                    &format!("托盘快捷整理：{} 个文件", v["moved"].as_u64().unwrap_or(0)),
                ),
                Err(e) => append_log("error", &format!("托盘快捷整理失败：{e}")),
            }
        }
        drop(guard);
    });
}

// ---------------------------------------------------------------- main

fn webview_browser_args() -> String {
    // 这些参数要在 WebView2 创建之前通过环境变量给到，运行时改不了。
    // --max-old-space-size 只是给 V8 老生代设上限；96 MB 太紧，大列表/大预览文本
    // 会直接把渲染进程打成 OOM（表现为闪退），留 256 MB 仍有明确上界。
    let mut args = String::from(
        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection \
         --disable-background-networking --disable-component-update --disable-sync \
         --js-flags=--max-old-space-size=256",
    );
    let gpu = std::fs::read_to_string(config_path())
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get("gpu_accel").and_then(|b| b.as_bool()))
        .unwrap_or(true);
    if !gpu {
        args.push_str(" --disable-gpu --disable-gpu-compositing");
    }
    // 测试壳用：允许外部追加 WebView2 参数（远程调试端口等）。
    // 只有显式设置 TIDY_WEBVIEW_ARGS 才生效，正常启动不读、不影响任何行为。
    if let Ok(extra) = std::env::var("TIDY_WEBVIEW_ARGS") {
        let extra = extra.trim();
        if !extra.is_empty() {
            args.push(' ');
            args.push_str(extra);
        }
    }
    args
}

fn main() {
    std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", webview_browser_args());
    let auto = std::env::args().any(|a| a == "--auto");
    let auto_clean = std::env::args().any(|a| a == "--auto-clean");
    let elevated = std::env::args().any(|a| a == "--elevated");

    // 提权实例：等旧实例把单实例锁 / WebView2 profile 放掉再起，避免 0x800700AA
    if elevated {
        std::thread::sleep(std::time::Duration::from_millis(1500));
    }

    // WebView2 的配置目录固定放进我们自己的数据目录，
    // 既避免和安装目录混杂，也方便排查/清理损坏的缓存。
    let webview_data = data_dir().join("webview");
    let _ = std::fs::create_dir_all(&webview_data);
    std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &webview_data);
    archive::set_data_dir(data_dir());

    let mut builder = tauri::Builder::default();
    if !elevated {
        // 提权重启的实例不能再走单实例转发，否则会被旧实例「吃掉」
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // 定时任务再次触发时只做整理/清理，不抢前台窗口
            if args.iter().any(|a| a == "--auto" || a == "--auto-clean") {
                return;
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
                let _ = w.emit("app-shown", ());
            }
        }));
    }
    builder
        .manage(AppState {
            engine: Arc::new(Mutex::new(None)),
        })
        .manage(archive::ArchiveCtx::default())
        .invoke_handler(tauri::generate_handler![
            engine_call,
            engine_restart,
            engine_sleep,
            engine_info,
            config_get,
            config_set,
            pick_folder,
            save_text,
            reveal,
            open_path,
            app_info,
            is_admin,
            run_as_admin,
            toggle_fullscreen,
            set_window_theme,
            window_toggle_maximize,
            window_is_maximized,
            window_begin_drag,
            get_autostart,
            set_autostart,
            schedule_set,
            schedule_get,
            log_line,
            log_list,
            log_read,
            log_clear,
            read_text,
            top_files,
            scan_empty_dirs,
            remove_empty_dirs,
            file_signals,
            list_dir,
            ai_http,
            ai_http_stream,
            ai_store,
            history_list,
            store_apps,
            remove_store_app,
            archive::archive_open,
            archive::archive_extract,
            archive::archive_create,
            archive::archive_cancel,
            archive::archive_preview,
            archive::archive_preview_clear,
            archive::archive_rar_status,
            archive::archive_rar_install,
            archive::pick_archive,
            archive::pick_files,
            archive::pick_archive_save
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let show = MenuItem::with_id(app, "show", "打开主界面", true, None::<&str>)?;
            let tidy_dl = MenuItem::with_id(app, "tidy_downloads", "整理下载文件夹", true, None::<&str>)?;
            let open_data = MenuItem::with_id(app, "open_data", "打开数据目录", true, None::<&str>)?;
            let open_logs = MenuItem::with_id(app, "open_logs", "打开日志目录", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出整理助手", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[
                    &show,
                    &tidy_dl,
                    &tauri::menu::PredefinedMenuItem::separator(app)?,
                    &open_data,
                    &open_logs,
                    &tauri::menu::PredefinedMenuItem::separator(app)?,
                    &quit,
                ],
            )?;
            let mut tray = TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("整理助手")
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                    }
                    "tidy_downloads" => tray_quick_organize(app),
                    "open_data" => {
                        let _ = std::process::Command::new("explorer")
                            .arg(data_dir())
                            .spawn();
                    }
                    "open_logs" => {
                        let _ = std::fs::create_dir_all(log_dir());
                        let _ = std::process::Command::new("explorer").arg(log_dir()).spawn();
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click { button, .. } = event {
                        if button == tauri::tray::MouseButton::Left {
                            let app = tray.app_handle();
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.unminimize();
                                let _ = w.set_focus();
                                let _ = w.emit("app-shown", ());
                            }
                        }
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            append_log("info", "应用启动");

            if auto {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
                let st = handle.state::<AppState>();
                // 借用 State 而非 AppState：先跑，再退出
                {
                    let cfg = read_config();
                    let folder = cfg["scheduled"]["folder"].as_str().unwrap_or("").to_string();
                    if folder.is_empty() {
                        append_log("warn", "--auto 未配置文件夹");
                    } else if let Ok(mut guard) = st.engine.lock() {
                        if guard.is_none() {
                            if let Ok(e) = spawn_engine(&handle) {
                                *guard = Some(e);
                            }
                        }
                        if let Some(engine) = guard.as_mut() {
                            let res = call_raw(
                                engine,
                                "organize",
                                json!({ "path": folder, "dry_run": false }),
                            );
                            match res {
                                Ok(v) => append_log("info", &format!("定时整理完成：{v}")),
                                Err(e) => append_log("error", &format!("定时整理失败：{e}")),
                            }
                        }
                    }
                }
                handle.exit(0);
            }
            if auto_clean {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
                let st = handle.state::<AppState>();
                let cfg = read_config();
                let cs = cfg
                    .get("clean_schedule")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                let cache = cs["cache"].as_bool().unwrap_or(true);
                let shots = cs["screenshots"].as_bool().unwrap_or(true);
                let days = cs["days"].as_i64().unwrap_or(30);
                if let Ok(mut guard) = st.engine.lock() {
                    if guard.is_none() {
                        if let Ok(e) = spawn_engine(&handle) {
                            *guard = Some(e);
                        }
                    }
                    if let Some(engine) = guard.as_mut() {
                        let res = call_raw(
                            engine,
                            "clean.auto",
                            json!({ "cache": cache, "screenshots": shots, "days": days, "confirm": true }),
                        );
                        match res {
                            Ok(v) => append_log("info", &format!("定时清理完成：{v}")),
                            Err(e) => append_log("error", &format!("定时清理失败：{e}")),
                        }
                    }
                }
                handle.exit(0);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let action = read_config()["close_action"]
                    .as_str()
                    .unwrap_or("tray")
                    .to_string();
                if action == "quit" {
                    append_log("info", "关闭即退出");
                    window.app_handle().exit(0);
                } else {
                    api.prevent_close();
                    let _ = window.hide();
                    let _ = window.emit("app-hidden", ());
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

