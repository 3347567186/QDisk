// TidyAssistant / 整理助手
// Developer: 白林 (Type) <3347567186@qq.com>
// Note: 独立开发者白林（是个帅气的男孩）；本注释仅留存于底层源码供二次开发与维护查阅，严禁展示在软件可见 UI。
// 发布版不要控制台窗口：Windows 下把子系统设为 windows，
// 否则每次启动都会额外弹一个黑色终端（双击快捷方式时最明显）。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::menu::{Menu, MenuItem};

mod archive;
mod updater;
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

/// 全局配置读写锁与原子写临时文件序号，防止并发 config_set / schedule_set 互相覆盖或写半截。
static CONFIG_LOCK: Mutex<()> = Mutex::new(());
static ATOMIC_WRITE_SEQ: AtomicU64 = AtomicU64::new(1);

/// 当前进程生效的统一数据目录（启动时从 `数据位置.json` 解析并锁定，全进程单一真相源）。
static ACTIVE_DATA_DIR: OnceLock<PathBuf> = OnceLock::new();
/// 防止并发触发数据目录迁移。
static DATA_MIGRATE_BUSY: AtomicBool = AtomicBool::new(false);

const DATA_LOCATOR_NAME: &str = "数据位置.json";

/// 软件已知核心持久数据项（统一迁移白名单，绝不触碰用户放进旧目录的其他无关文件）。
const CORE_MIGRATE_ENTRIES: &[&str] = &[
    "app.json",
    "配置",
    "ai",
    "history",
    "logs",
    "迁移",
    "卸载备份",
    "updates",
    "bin",
];

/// 重启后由新目录自动重建的运行时缓存目录（迁移时不硬搬被 WebView2/SQLite 锁住的缓存）。
const REBUILD_SUBDIRS: &[&str] = &["配置", "logs", "history", "cache", "ai", "webview"];

/// 主进程退出后，旧数据目录中允许由隐藏引导脚本安全清扫的软件已知子项。
const CLEANUP_KNOWN_ENTRIES: &[&str] = &[
    "webview",
    "cache",
    "preview",
    "archive_undo",
    "thumbs",
    "logs",
    "history",
    "配置",
    "ai",
    "app.json",
    "迁移",
    "卸载备份",
    "updates",
    "bin",
];

// ---------------------------------------------------------------- paths

fn env_dir(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).map(PathBuf::from)
}

fn default_data_dir() -> PathBuf {
    let base = env_dir("LOCALAPPDATA").unwrap_or_else(|| PathBuf::from("."));
    base.join("整理助手数据")
}

fn unix_now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn normalize_path_str(raw: &str) -> String {
    let mut s = raw.trim().trim_matches('"').replace('/', "\\");
    while s.len() > 3 && s.ends_with('\\') {
        s.pop();
    }
    s
}

fn locator_read_candidates_for(exe_d: &Path, local_app_data: Option<&Path>) -> Vec<PathBuf> {
    let mut out = Vec::with_capacity(3);
    out.push(exe_d.join("引擎").join(DATA_LOCATOR_NAME));
    out.push(exe_d.join(DATA_LOCATOR_NAME));
    if let Some(la) = local_app_data {
        out.push(la.join("整理助手").join(DATA_LOCATOR_NAME));
    }
    out
}

fn locator_write_candidates_for(exe_d: &Path, local_app_data: Option<&Path>) -> Vec<PathBuf> {
    let mut out = Vec::with_capacity(2);
    let eng_dir = exe_d.join("引擎");
    if eng_dir.is_dir() {
        out.push(eng_dir.join(DATA_LOCATOR_NAME));
    }
    if let Some(la) = local_app_data {
        out.push(la.join("整理助手").join(DATA_LOCATOR_NAME));
    }
    out
}

/// 从多个候选指针文件中读取最新且有效的 `data_dir`（按 `updated_ms` 仲裁，缺失时回退文件 mtime）。
fn read_locator_from_candidates(candidates: &[PathBuf]) -> Option<PathBuf> {
    let mut best: Option<(u64, PathBuf)> = None;
    for path in candidates {
        let Ok(raw_text) = std::fs::read_to_string(path) else {
            continue;
        };
        let cleaned = raw_text.trim_start_matches('\u{feff}');
        let Ok(v) = serde_json::from_str::<Value>(cleaned) else {
            continue;
        };
        let Some(raw_dir) = v.get("data_dir").and_then(|d| d.as_str()) else {
            continue;
        };
        let norm = normalize_path_str(raw_dir);
        if norm.is_empty() {
            continue;
        }
        let pb = PathBuf::from(&norm);
        if !pb.is_absolute() || !pb.is_dir() {
            continue;
        }
        let ts = v
            .get("updated_ms")
            .and_then(|x| x.as_u64())
            .unwrap_or_else(|| {
                std::fs::metadata(path)
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0)
            });
        let replace = match &best {
            None => true,
            Some((best_ts, _)) => ts > *best_ts,
        };
        if replace {
            best = Some((ts, pb));
        }
    }
    best.map(|(_, p)| p)
}

fn write_locator_to_candidates(target: &Path, candidates: &[PathBuf]) -> Result<Vec<PathBuf>, String> {
    let norm = normalize_path_str(&target.to_string_lossy());
    let now_ms = unix_now_ms();
    let body = json!({
        "data_dir": norm,
        "updated": format!("{} {}", chrono_like_stamp(), clock()),
        "updated_ms": now_ms
    });
    let txt = serde_json::to_string_pretty(&body).map_err(|e| e.to_string())?;
    let mut written = Vec::new();
    let mut last_err = String::new();
    for loc in candidates {
        match write_file_atomic(loc, txt.as_bytes()) {
            Ok(()) => written.push(loc.clone()),
            Err(e) => last_err = e,
        }
    }
    if written.is_empty() {
        return Err(if last_err.is_empty() {
            "无法写入数据目录指针文件".into()
        } else {
            format!("无法写入数据目录指针文件：{last_err}")
        });
    }
    Ok(written)
}

fn data_dir() -> PathBuf {
    ACTIVE_DATA_DIR
        .get_or_init(|| {
            let local = env_dir("LOCALAPPDATA");
            let cands = locator_read_candidates_for(&exe_dir(), local.as_deref());
            read_locator_from_candidates(&cands).unwrap_or_else(default_data_dir)
        })
        .clone()
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

fn write_file_atomic(target: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(dir) = target.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("创建目录失败：{e}"))?;
    }
    let seq = ATOMIC_WRITE_SEQ.fetch_add(1, Ordering::Relaxed);
    let name = target
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".into());
    let tmp = target.with_file_name(format!("{name}.{}.{seq}.tmp", std::process::id()));
    if let Err(e) = std::fs::write(&tmp, bytes) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("写入临时文件失败：{e}"));
    }
    if let Err(e) = std::fs::rename(&tmp, target) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("替换目标文件失败：{e}"));
    }
    Ok(())
}

fn write_config(cfg: &Value) -> Result<(), String> {
    let dir = data_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败：{e}"))?;
    let text = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    write_file_atomic(&config_path(), text.as_bytes()).map_err(|e| format!("写入配置失败：{e}"))
}

#[tauri::command]
fn config_get() -> Value {
    let _guard = CONFIG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    read_config()
}

#[tauri::command]
fn config_set(patch: Value) -> Result<Value, String> {
    let _guard = CONFIG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
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

/// 确保引擎旁 `数据位置.json` 与当前生效的仲裁后数据目录一致，绝不倒退覆盖。
fn ensure_engine_data_dir(engine: &Path) {
    if DATA_MIGRATE_BUSY.load(Ordering::SeqCst) {
        return;
    }
    let Some(dir) = engine.parent() else { return };
    let locator = dir.join(DATA_LOCATOR_NAME);
    let want = data_dir();
    let _ = std::fs::create_dir_all(&want);
    let current = std::fs::read_to_string(&locator)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(s.trim_start_matches('\u{feff}')).ok())
        .and_then(|v| v.get("data_dir").and_then(|d| d.as_str()).map(normalize_path_str));
    let want_text = normalize_path_str(&want.to_string_lossy());
    if current.as_deref().is_some_and(|c| c.eq_ignore_ascii_case(&want_text)) {
        return;
    }
    let body = json!({
        "data_dir": want_text,
        "updated": format!("{} {}", chrono_like_stamp(), clock()),
        "updated_ms": unix_now_ms()
    });
    if let Ok(txt) = serde_json::to_string_pretty(&body) {
        let _ = write_file_atomic(&locator, txt.as_bytes());
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
    for _ in 0..8 {
        let mut resp = String::new();
        engine
            .stdout
            .read_line(&mut resp)
            .map_err(|e| format!("读引擎失败：{e}"))?;
        let trimmed = resp.trim();
        if trimmed.is_empty() {
            return Err("引擎没有返回（可能已退出）".into());
        }
        let v: Value = match serde_json::from_str(trimmed) {
            Ok(val) => val,
            Err(e) => {
                // 以 '{' 开头却解析失败说明是损坏的 JSON 响应，立即报错防死等；
                // 非 '{' 开头的杂散调试输出跳过继续读真正的响应行。
                if trimmed.starts_with('{') {
                    return Err(format!("引擎返回非法 JSON：{e}"));
                }
                continue;
            }
        };
        if let Some(rid) = v.get("id").and_then(|x| x.as_u64()) {
            if rid != id {
                if rid < id {
                    continue;
                }
                return Err(format!("引擎响应序号错位（期望 {id}，收到 {rid}）"));
            }
        }
        return if v.get("ok").and_then(|b| b.as_bool()) == Some(true) {
            Ok(v.get("result").cloned().unwrap_or(Value::Null))
        } else {
            Err(v
                .get("error")
                .and_then(|e| e.as_str())
                .unwrap_or("引擎调用失败")
                .to_string())
        };
    }
    Err("引擎返回协议失步或非法 JSON".into())
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
                let _ = old.child.wait();
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
            let _ = old.child.wait();
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

fn is_cjk_or_fullwidth(c: char) -> bool {
    let cp = c as u32;
    (0x4E00..=0x9FFF).contains(&cp)
        || (0x3400..=0x4DBF).contains(&cp)
        || (0x3000..=0x303F).contains(&cp)
        || (0xFF00..=0xFFEF).contains(&cp)
        || matches!(c, '—' | '…' | '·')
}

fn is_cjk_punct_stopper(c: char) -> bool {
    matches!(
        c,
        '（' | '）'
            | '【'
            | '】'
            | '「'
            | '」'
            | '『'
            | '』'
            | '《'
            | '》'
            | '〈'
            | '〉'
            | '—'
            | '…'
            | '·'
            | '，'
            | '。'
            | '；'
            | '：'
            | '！'
            | '？'
            | '、'
    )
}

fn trim_unbalanced_and_punct(input: &str) -> &str {
    let mut s = input
        .trim()
        .trim_matches(|c| matches!(c, '`' | '\'' | '"'))
        .trim();
    s = s.trim_end_matches(|c| matches!(c, '.' | ',' | ';' | ':' | '!' | '?'));
    while let Some(last) = s.chars().last() {
        if !matches!(last, ')' | ']' | '}') {
            break;
        }
        let opens = s.chars().filter(|c| matches!(c, '(' | '[' | '{')).count();
        let closes = s.chars().filter(|c| matches!(c, ')' | ']' | '}')).count();
        if closes <= opens {
            break;
        }
        s = &s[..s.len() - last.len_utf8()];
    }
    s.trim_end_matches(|c| matches!(c, '.' | ',' | ';' | ':' | '!' | '?'))
}

fn trim_nonroot_sep(s: &str) -> &str {
    if s.len() > 3 && (s.ends_with('\\') || s.ends_with('/')) {
        s.trim_end_matches(['\\', '/'])
    } else {
        s
    }
}

/// 存在性优先的本地路径解析兜底：
/// 1. 只要原路径在磁盘上真实存在，直接原样返回（绝不误伤任何带汉字后缀的真实目录/文件）；
/// 2. 仅当原路径不存在时，按「中文标点 → 扩展名边界 → ASCII 末段粘连汉字 → 中文末段自然语言后缀」
///    逐级剥离尾部粘连，且只放行磁盘上真实存在的候选路径（绝不跨 `\` 静默回退到父目录，
///    除非尾段本身就是纯中文介词/目录提示词如 `D:\Downloads\里的文件`）。
fn resolve_existing_local_path(raw: &str) -> Option<PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let exact = PathBuf::from(trimmed);
    if exact.exists() {
        return Some(exact);
    }

    // 1. 剥离包裹引号、全角标点后缀与不平衡右括号
    let mut s = trim_unbalanced_and_punct(trimmed);
    if let Some(idx) = s.find(is_cjk_punct_stopper) {
        if idx > 0 {
            s = trim_unbalanced_and_punct(&s[..idx]);
        }
    }
    if !s.is_empty() {
        let cand = PathBuf::from(s);
        if cand.exists() {
            return Some(cand);
        }
    }

    // 2. 仅在最后一个路径分隔符之后的末段做语义边界剥离
    let last_sep = s.rfind(['\\', '/'])?;
    let prefix = &s[..=last_sep];
    let leaf = &s[last_sep + 1..];
    if leaf.is_empty() {
        let p = trim_nonroot_sep(prefix);
        let cand = PathBuf::from(p);
        return cand.exists().then_some(cand);
    }

    // 2a. 尾斜杠后紧跟纯中文介词/提示词（如 D:\里的文件、D:\Downloads\目录下）
    const ROOT_PROSE_PREFIXES: &[&str] = &[
        "里的", "中的", "下的", "上的", "内的", "里面", "下面", "上面", "内部", "里有",
        "中有", "下有", "盘里", "盘中", "盘上", "盘下", "根目录", "目录下", "目录中",
        "目录里", "文件夹下", "文件夹中", "文件夹里", "路径下", "共有", "一共", "占用",
        "占据", "约有", "大约", "包含", "可以", "需要", "建议", "是否", "已经", "没有",
        "目录", "文件夹", "路径", "里", "中", "下", "上", "内", "盘",
    ];
    if ROOT_PROSE_PREFIXES.iter().any(|p| leaf.starts_with(p)) {
        let base = trim_nonroot_sep(prefix);
        let cand = PathBuf::from(base);
        if cand.exists() {
            return Some(cand);
        }
    }

    // 2b. 文件扩展名后紧跟汉字/全角字符（如 setup.exe是否可删、报告.pdf里的内容、a.7z压缩包）
    for (dot_idx, ch) in leaf.char_indices() {
        if ch != '.' || dot_idx == 0 {
            continue;
        }
        let rest = &leaf[dot_idx + 1..];
        let mut ext_end = 0usize;
        for (i, rc) in rest.char_indices() {
            if rc.is_ascii_alphanumeric() {
                ext_end = i + rc.len_utf8();
            } else {
                break;
            }
        }
        if ext_end == 0 || ext_end > 8 || ext_end >= rest.len() {
            continue;
        }
        let ext = &rest[..ext_end];
        let after = &rest[ext_end..];
        let valid_ext = ext.eq_ignore_ascii_case("7z")
            || ext.eq_ignore_ascii_case("3gp")
            || ext.eq_ignore_ascii_case("3ds")
            || ext.as_bytes()[0].is_ascii_alphabetic();
        if valid_ext && after.chars().next().is_some_and(is_cjk_or_fullwidth) {
            let candidate = format!("{prefix}{}", &leaf[..dot_idx + 1 + ext_end]);
            let pb = PathBuf::from(&candidate);
            if pb.exists() {
                return Some(pb);
            }
        }
    }

    // 2c. ASCII 末段后紧跟汉字（如 Downloads里的文件、Temp缓存、AppData目录）
    if leaf.as_bytes().first().is_some_and(|b| b.is_ascii_alphanumeric()) {
        if let Some(cjk_idx) = leaf.find(is_cjk_or_fullwidth) {
            if cjk_idx > 0 {
                let stem = trim_unbalanced_and_punct(&leaf[..cjk_idx]);
                if !stem.is_empty() {
                    let candidate = format!("{prefix}{stem}");
                    let pb = PathBuf::from(&candidate);
                    if pb.exists() {
                        return Some(pb);
                    }
                }
            }
        }
    }

    // 2d. 中文末段尾部粘连自然语言后缀（如 D:\工作资料目录下、D:\下载\旧文件里的文件）
    const CJK_PROSE_MARKERS: &[&str] = &[
        "目录下", "目录中", "目录里", "目录内", "文件夹下", "文件夹中", "文件夹里",
        "文件夹内", "路径下", "路径中", "路径里", "位置下", "位置里", "里的", "中的",
        "下的", "上的", "内的", "里面", "下面", "上面", "里有", "中有", "下有", "共有",
        "一共", "合计", "约有", "大约", "占用", "占据", "包含", "含有", "可以", "需要",
        "建议", "是否", "已经", "没有", "无法", "清理", "删除", "移动", "打开", "定位",
        "目录", "文件夹", "路径", "以及", "等等",
    ];
    for marker in CJK_PROSE_MARKERS {
        if let Some(idx) = leaf.find(marker) {
            if idx > 0 {
                let stem = trim_unbalanced_and_punct(&leaf[..idx]);
                if !stem.is_empty() {
                    let candidate = format!("{prefix}{stem}");
                    let pb = PathBuf::from(&candidate);
                    if pb.exists() {
                        return Some(pb);
                    }
                }
            }
        }
    }
    // 末段以单个连接词/方位词结尾（如 D:\下载和、D:\工作里）
    if let Some((idx, last_ch)) = leaf.char_indices().next_back() {
        if idx > 0 && matches!(last_ch, '里' | '中' | '下' | '上' | '内' | '和' | '与' | '或' | '及' | '跟' | '至' | '等') {
            let candidate = format!("{prefix}{}", &leaf[..idx]);
            let pb = PathBuf::from(&candidate);
            if pb.exists() {
                return Some(pb);
            }
        }
    }

    None
}

const LOCAL_EXEC_EXTS: &[&str] = &[
    "exe", "msi", "msp", "mst", "bat", "cmd", "ps1", "psm1", "psd1", "ps1xml", "scr", "com",
    "pif", "cpl", "msc", "jar", "vbs", "vbe", "js", "jse", "wsf", "wsh", "lnk", "url", "reg",
    "hta", "chm", "msix", "appx", "inf", "scf", "appref-ms", "application", "gadget",
];

fn path_ext_lower(p: &Path) -> String {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default()
}

fn is_exec_path(p: &Path) -> bool {
    let ext = path_ext_lower(p);
    !ext.is_empty() && LOCAL_EXEC_EXTS.contains(&ext.as_str())
}

fn is_archive_path_local(p: &Path) -> bool {
    let name = p
        .file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    if name.ends_with(".tar.gz")
        || name.ends_with(".tar.bz2")
        || name.ends_with(".tar.xz")
        || name.ends_with(".tar.zst")
    {
        return true;
    }
    matches!(
        path_ext_lower(p).as_str(),
        "zip" | "rar" | "7z" | "tar" | "tgz" | "tbz2" | "txz" | "gz" | "bz2" | "xz" | "zst"
    )
}

fn normalized_parent_str(p: &Path) -> String {
    match p.parent() {
        Some(par) if !par.as_os_str().is_empty() => {
            let s = par.to_string_lossy().to_string();
            let b = s.as_bytes();
            if b.len() == 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
                format!("{s}\\")
            } else {
                s
            }
        }
        _ => String::new(),
    }
}

fn is_perm_denied(e: &std::io::Error) -> bool {
    e.kind() == std::io::ErrorKind::PermissionDenied || e.raw_os_error() == Some(5)
}

fn probe_path_meta(p: &Path) -> Result<std::fs::Metadata, std::io::Error> {
    let sm = std::fs::symlink_metadata(p)?;
    if sm.file_type().is_symlink() {
        if let Ok(target) = std::fs::metadata(p) {
            return Ok(target);
        }
    }
    Ok(sm)
}

fn find_nearest_readable_ancestor(p: &Path) -> (Option<String>, Option<String>) {
    let mut child: Option<PathBuf> = None;
    let mut cur = p.to_path_buf();
    loop {
        if let Ok(md) = probe_path_meta(&cur) {
            if md.is_dir() && std::fs::read_dir(&cur).is_ok() {
                let dir_s = {
                    let s = cur.to_string_lossy().to_string();
                    let b = s.as_bytes();
                    if b.len() == 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
                        format!("{s}\\")
                    } else {
                        s
                    }
                };
                let hi_s = child.map(|c| c.to_string_lossy().to_string());
                return (Some(dir_s), hi_s);
            }
        }
        match cur.parent().map(|par| par.to_path_buf()) {
            Some(next) if next != cur && !next.as_os_str().is_empty() => {
                child = Some(cur);
                cur = next;
            }
            _ => break,
        }
    }
    (None, None)
}

fn has_permission_denied_ancestor(p: &Path) -> bool {
    let mut cur = p.to_path_buf();
    loop {
        match probe_path_meta(&cur) {
            Ok(md) => {
                if md.is_dir() {
                    if let Err(e) = std::fs::read_dir(&cur) {
                        if is_perm_denied(&e) {
                            return true;
                        }
                    } else {
                        return false;
                    }
                }
            }
            Err(e) if is_perm_denied(&e) => return true,
            Err(_) => {}
        }
        match cur.parent() {
            Some(par) if par != cur && !par.as_os_str().is_empty() => cur = par.to_path_buf(),
            _ => break,
        }
    }
    false
}

/// 真实探测本地路径：彻底消除前端靠「有没有 `.`」猜目录/文件，并精确区分
/// 「正常存在」「权限受限（如 WindowsApps）」与「真正不存在」，同时回传最近可读上级目录。
fn inspect_local_path_core(raw: &str) -> Value {
    let trimmed0 = raw.trim();
    if trimmed0.is_empty()
        || trimmed0
            .chars()
            .any(|c| c == '"' || c == '\n' || c == '\r' || (c as u32) < 0x20)
    {
        return json!({
            "status": "invalid",
            "path": trimmed0,
            "exists": false,
            "readable": false,
            "error": "路径为空或包含不能用的字符",
        });
    }
    let normalized_raw = {
        let mut s = trimmed0.replace('/', "\\");
        let b = s.as_bytes();
        if b.len() == 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
            s.push('\\');
        }
        s
    };
    let trimmed = normalized_raw.as_str();

    let make_ok = |pb: &PathBuf, md: &std::fs::Metadata| -> Value {
        let is_dir = md.is_dir();
        let path_s = pb.to_string_lossy().to_string();
        let parent_s = normalized_parent_str(pb);
        let is_exec = !is_dir && is_exec_path(pb);
        let is_archive = !is_dir && is_archive_path_local(pb);
        if is_dir {
            if let Err(e) = std::fs::read_dir(pb) {
                if is_perm_denied(&e) {
                    let (nr, hi) = find_nearest_readable_ancestor(pb);
                    return json!({
                        "status": "permission_denied",
                        "path": path_s,
                        "exists": true,
                        "kind": "dir",
                        "readable": false,
                        "parent": parent_s,
                        "nearestReadable": nr,
                        "nearestReadableHighlight": hi.unwrap_or_else(|| path_s.clone()),
                        "isExec": false,
                        "isArchive": false,
                        "error": format!("权限受限（受 Windows 系统保护，需要管理员权限）：{path_s}"),
                    });
                }
            }
        } else if !parent_s.is_empty() {
            if let Err(e) = std::fs::read_dir(&parent_s) {
                if is_perm_denied(&e) {
                    let (nr, hi) = find_nearest_readable_ancestor(pb);
                    return json!({
                        "status": "permission_denied",
                        "path": path_s,
                        "exists": true,
                        "kind": "file",
                        "readable": false,
                        "parent": parent_s,
                        "nearestReadable": nr,
                        "nearestReadableHighlight": hi.unwrap_or_else(|| path_s.clone()),
                        "isExec": is_exec,
                        "isArchive": is_archive,
                        "error": format!("所在目录受 Windows 权限保护，需要管理员权限：{path_s}"),
                    });
                }
            }
        }
        json!({
            "status": "ok",
            "path": path_s,
            "exists": true,
            "kind": if is_dir { "dir" } else { "file" },
            "readable": true,
            "parent": parent_s,
            "isExec": is_exec,
            "isArchive": is_archive,
        })
    };

    let exact = PathBuf::from(trimmed);
    match probe_path_meta(&exact) {
        Ok(md) => return make_ok(&exact, &md),
        Err(e) if is_perm_denied(&e) => {
            let (nr, hi) = find_nearest_readable_ancestor(&exact);
            return json!({
                "status": "permission_denied",
                "path": trimmed,
                "exists": true,
                "kind": if is_exec_path(&exact) || is_archive_path_local(&exact) {
                    Value::String("file".into())
                } else {
                    Value::Null
                },
                "readable": false,
                "parent": normalized_parent_str(&exact),
                "nearestReadable": nr,
                "nearestReadableHighlight": hi,
                "isExec": is_exec_path(&exact),
                "isArchive": is_archive_path_local(&exact),
                "error": format!("权限受限（受 Windows 系统保护，需要管理员权限）：{trimmed}"),
            });
        }
        Err(_) => {}
    }

    // 先尝试粘连中文/标点真实路径兜底
    if let Some(rescued) = resolve_existing_local_path(trimmed) {
        if let Ok(md) = probe_path_meta(&rescued) {
            return make_ok(&rescued, &md);
        }
    }

    // 若任一祖先目录（例如 C:\Program Files\WindowsApps）拒绝列目录/遍历，明确报权限受限而非「不存在」
    if has_permission_denied_ancestor(&exact) {
        let (nr, hi) = find_nearest_readable_ancestor(&exact);
        return json!({
            "status": "permission_denied",
            "path": trimmed,
            "exists": true,
            "kind": Value::Null,
            "readable": false,
            "parent": normalized_parent_str(&exact),
            "nearestReadable": nr,
            "nearestReadableHighlight": hi,
            "isExec": is_exec_path(&exact),
            "isArchive": is_archive_path_local(&exact),
            "error": format!("权限受限（受 Windows 系统保护，需要管理员权限）：{trimmed}"),
        });
    }

    let (nearest_existing, nearest_hi) = find_nearest_readable_ancestor(&exact);
    json!({
        "status": "not_found",
        "path": trimmed,
        "exists": false,
        "kind": Value::Null,
        "readable": false,
        "parent": normalized_parent_str(&exact),
        "nearestExisting": nearest_existing,
        "nearestExistingHighlight": nearest_hi,
        "isExec": is_exec_path(&exact),
        "isArchive": is_archive_path_local(&exact),
        "error": format!("这个位置已经不在了：{trimmed}"),
    })
}

#[tauri::command]
fn inspect_local_path(path: String) -> Value {
    inspect_local_path_core(&path)
}

#[tauri::command]
fn resolve_local_path(path: String) -> Option<String> {
    let raw = path.trim();
    if raw.is_empty() || raw.chars().any(|c| c == '"' || c == '\n' || c == '\r' || (c as u32) < 0x20) {
        return None;
    }
    resolve_existing_local_path(raw).map(|p| p.to_string_lossy().to_string())
}

/// 在资源管理器里定位一个位置：目录就打开它，文件就选中它。
/// 同样先检查存在性——「定位了一个不存在的东西」等于没定位；
/// 若命中 WindowsApps 等权限受限路径，尝试交由资源管理器定位而不是谎报「不存在」。
#[tauri::command]
fn reveal(path: String) -> Result<(), String> {
    let raw = path.trim().to_string();
    if raw.is_empty() {
        return Err("路径是空的".into());
    }
    if raw.chars().any(|c| c == '"' || c == '\n' || c == '\r' || (c as u32) < 0x20) {
        return Err("路径里有不能用的字符".into());
    }
    let resolved = resolve_existing_local_path(&raw);
    let (target, is_dir) = if let Some(p) = resolved {
        let dir = probe_path_meta(&p).map(|m| m.is_dir()).unwrap_or_else(|_| p.is_dir());
        (p.to_string_lossy().to_string(), dir)
    } else {
        let info = inspect_local_path_core(&raw);
        if info["status"].as_str() == Some("permission_denied") {
            let fallback = info["nearestReadableHighlight"]
                .as_str()
                .filter(|s| !s.is_empty())
                .unwrap_or(&raw)
                .to_string();
            (fallback, false)
        } else {
            return Err(format!("这个位置已经不在了：{raw}"));
        }
    };
    let mut cmd = Command::new("explorer.exe");
    let clean_sel = target.trim_end_matches(['\\', '/']);
    let is_bare_drive = clean_sel.len() == 2
        && clean_sel.as_bytes()[0].is_ascii_alphabetic()
        && clean_sel.as_bytes()[1] == b':';
    if is_dir || is_bare_drive || clean_sel.is_empty() {
        cmd.arg(&target);
    } else {
        #[cfg(windows)]
        {
            // explorer.exe 要求 /select,"<path>" 格式，且末尾绝不能带 `\` 防止 `\"` 转义闭合引号；
            // 上方已拦截 `"` 与控制字符，raw_arg 不存在注入面。
            cmd.raw_arg(format!("/select,\"{clean_sel}\""));
        }
        #[cfg(not(windows))]
        {
            cmd.arg(format!("/select,{clean_sel}"));
        }
    }
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.spawn().map_err(|e| format!("定位失败：{e}"))?;
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
enum OpenTarget {
    Url,
    SafeShell,
    LocalPath(PathBuf),
}

/// 严格校验 open_path 目标，拒绝危险协议与控制字符；放行安全网页、白名单回收站 shell URI 与已存在的本地路径。
fn validate_open_target(raw: &str) -> Result<OpenTarget, String> {
    if raw.is_empty() {
        return Err("路径是空的".into());
    }
    if raw
        .chars()
        .any(|c| c == '"' || c == '\n' || c == '\r' || (c as u32) < 0x20)
    {
        return Err("路径里有不能用的字符".into());
    }
    let low = raw.to_ascii_lowercase();
    if low.starts_with("http://") || low.starts_with("https://") || low.starts_with("mailto:") {
        return Ok(OpenTarget::Url);
    }
    if low == "shell:recyclebinfolder" {
        return Ok(OpenTarget::SafeShell);
    }
    // 识别非盘符的自定义协议头（如 javascript: / ms-msdt: / cmd: / file: / 未白名单 shell:）并一律拒绝
    let is_drive = raw.len() >= 2
        && raw.as_bytes()[0].is_ascii_alphabetic()
        && raw.as_bytes()[1] == b':';
    let is_unc = raw.starts_with("\\\\");
    if !is_drive && !is_unc {
        if let Some(colon) = raw.find(':') {
            let scheme = &raw[..colon];
            if !scheme.is_empty()
                && scheme
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
            {
                return Err(format!("不支持打开该协议：{scheme}:"));
            }
        }
    }
    let resolved = resolve_existing_local_path(raw)
        .ok_or_else(|| format!("这个位置已经不在了：{raw}"))?;
    Ok(OpenTarget::LocalPath(resolved))
}

#[cfg(target_os = "windows")]
#[link(name = "shell32")]
extern "system" {
    fn ShellExecuteW(
        hwnd: isize,
        operation: *const u16,
        file: *const u16,
        parameters: *const u16,
        directory: *const u16,
        show_cmd: i32,
    ) -> isize;
}

/// 打开一个本地位置、安全网址或白名单系统位置（如回收站）。
/// 直接调用 Win32 ShellExecuteW，完全绕开 cmd.exe 壳解析，杜绝 %VAR%/&/|/^ 注入。
#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    let raw = path.trim().to_string();
    let target = match validate_open_target(&raw)? {
        OpenTarget::LocalPath(pb) => pb.to_string_lossy().to_string(),
        OpenTarget::Url | OpenTarget::SafeShell => raw,
    };
    #[cfg(target_os = "windows")]
    {
        let op: Vec<u16> = "open\0".encode_utf16().collect();
        let file: Vec<u16> = target.encode_utf16().chain(std::iter::once(0)).collect();
        const SW_SHOWNORMAL: i32 = 1;
        let rc = unsafe {
            ShellExecuteW(
                0,
                op.as_ptr(),
                file.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            )
        };
        if rc <= 32 {
            return Err(format!("打不开（ShellExecute 错误码 {rc}）：{target}"));
        }
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

/// 统一全软件能力发现清单（schemaVersion=1）：为前端页面、AI 助手与未来扩展插件提供单一真相源。
#[tauri::command]
fn app_capabilities() -> Value {
    let cpu_cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .max(1);
    let arc_caps = archive::capabilities_snapshot();
    json!({
        "schemaVersion": 1,
        "version": env!("CARGO_PKG_VERSION"),
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "cpuCores": cpu_cores,
        "dataDir": data_dir().to_string_lossy().to_string(),
        "logDir": log_dir().to_string_lossy().to_string(),
        "archive": arc_caps,
        "extensions": {
            "pages": true,
            "aiActions": true,
            "engineMethods": true,
            "archiveCodecs": true,
            "lifecycleHooks": true,
            "updater": true,
            "filePreview": true
        }
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
    fn GetSystemMetrics(n_index: i32) -> i32;
    fn LoadImageW(hinst: isize, name: *const u16, img_type: u32, cx: i32, cy: i32, fu_load: u32) -> isize;
    fn SendMessageW(hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> isize;
}
#[cfg(target_os = "windows")]
#[link(name = "kernel32")]
extern "system" {
    fn GetModuleHandleW(lp_module_name: *const u16) -> isize;
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
#[cfg(target_os = "windows")]
const WM_SETICON: u32 = 0x0080;
#[cfg(target_os = "windows")]
const ICON_SMALL: usize = 0;
#[cfg(target_os = "windows")]
const ICON_BIG: usize = 1;
#[cfg(target_os = "windows")]
const IMAGE_ICON: u32 = 1;
#[cfg(target_os = "windows")]
const LR_DEFAULTCOLOR: u32 = 0x0000;
#[cfg(target_os = "windows")]
const LR_SHARED: u32 = 0x8000;
#[cfg(target_os = "windows")]
const SM_CXICON: i32 = 11;
#[cfg(target_os = "windows")]
const SM_CYICON: i32 = 12;
#[cfg(target_os = "windows")]
const SM_CXSMICON: i32 = 49;
#[cfg(target_os = "windows")]
const SM_CYSMICON: i32 = 50;
/// `tauri_build` 将 `icon.ico` 写入 PE 资源 ID `32512`（`IDI_APPLICATION`）。
#[cfg(target_os = "windows")]
const PE_APP_ICON_ID: usize = 32512;

/// 同步主窗口任务栏与 Alt+Tab 图标：先走 Tauri `set_icon` 兜底，
/// 再从本进程 PE 资源按系统 DPI 精确加载大/小 DIB 图标发 `WM_SETICON`，
/// 绕过 Windows Shell 旧快捷方式与图标缓存残留。
fn sync_window_taskbar_icon(window: &tauri::WebviewWindow, fallback: Option<&tauri::image::Image<'_>>) {
    if let Some(ic) = fallback {
        let _ = window.set_icon(ic.clone());
    }
    #[cfg(target_os = "windows")]
    if let Ok(raw) = window.hwnd() {
        let hwnd = raw.0 as isize;
        unsafe {
            let hinst = GetModuleHandleW(std::ptr::null());
            if hinst != 0 {
                let res_id = PE_APP_ICON_ID as *const u16;
                let big_w = GetSystemMetrics(SM_CXICON).max(32);
                let big_h = GetSystemMetrics(SM_CYICON).max(32);
                let h_big = LoadImageW(hinst, res_id, IMAGE_ICON, big_w, big_h, LR_DEFAULTCOLOR | LR_SHARED);
                if h_big != 0 {
                    SendMessageW(hwnd, WM_SETICON, ICON_BIG, h_big);
                }
                let sm_w = GetSystemMetrics(SM_CXSMICON).max(16);
                let sm_h = GetSystemMetrics(SM_CYSMICON).max(16);
                let h_sm = LoadImageW(hinst, res_id, IMAGE_ICON, sm_w, sm_h, LR_DEFAULTCOLOR | LR_SHARED);
                if h_sm != 0 {
                    SendMessageW(hwnd, WM_SETICON, ICON_SMALL, h_sm);
                }
            }
        }
    }
}

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

/// 以管理员身份重新启动自己：在阻塞线程中直接调用 Win32 ShellExecuteW("runas")，
/// 仅在 UAC 真正放行（rc > 32）后才停引擎并退出当前进程；若用户取消 UAC，当前窗口与引擎保持完好。
#[tauri::command]
async fn run_as_admin(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe_str = exe.to_string_lossy().to_string();
    let dir_str = exe
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    #[cfg(target_os = "windows")]
    {
        let rc = tauri::async_runtime::spawn_blocking(move || -> isize {
            let op: Vec<u16> = "runas\0".encode_utf16().collect();
            let file: Vec<u16> = exe_str.encode_utf16().chain(std::iter::once(0)).collect();
            let params: Vec<u16> = "--elevated\0".encode_utf16().collect();
            let dir: Vec<u16> = dir_str.encode_utf16().chain(std::iter::once(0)).collect();
            let dir_ptr = if dir.len() > 1 { dir.as_ptr() } else { std::ptr::null() };
            unsafe { ShellExecuteW(0, op.as_ptr(), file.as_ptr(), params.as_ptr(), dir_ptr, 1) }
        })
        .await
        .map_err(|e| format!("提权启动失败：{e}"))?;
        if rc <= 32 {
            if rc == 5 || rc == 1223 {
                return Err("已取消管理员提权".into());
            }
            return Err(format!("无法以管理员身份重启（错误码 {rc}）"));
        }
    }

    // 提权实例已确认启动，再优雅停止当前引擎并退出，释放数据目录与 WebView2 profile
    if let Ok(mut guard) = state.engine.lock() {
        if let Some(mut old) = guard.take() {
            let _ = old.child.kill();
            let _ = old.child.wait();
        }
    }
    append_log("info", "已请求以管理员身份重启");
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(600));
        handle.exit(0);
    });
    Ok(())
}

// ---------------------------------------------------------------- data dir migration

fn is_drive_root_str(norm: &str) -> bool {
    let b = norm.as_bytes();
    (b.len() == 2 && b[0].is_ascii_alphabetic() && b[1] == b':')
        || (b.len() == 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && b[2] == b'\\')
}

fn path_eq_ci(a: &Path, b: &Path) -> bool {
    normalize_path_str(&a.to_string_lossy())
        .to_lowercase()
        == normalize_path_str(&b.to_string_lossy()).to_lowercase()
}

fn path_is_inside_ci(child: &Path, parent: &Path) -> bool {
    let c = normalize_path_str(&child.to_string_lossy()).to_lowercase();
    let p = normalize_path_str(&parent.to_string_lossy()).to_lowercase();
    c.starts_with(&format!("{p}\\"))
}

fn is_forbidden_system_dir(norm: &str) -> bool {
    let low = norm.to_lowercase();
    if low.contains("\\$recycle.bin") || low.contains("\\system volume information") {
        return true;
    }
    let mut blocked = vec![
        r"c:\windows".to_string(),
        r"c:\program files".to_string(),
        r"c:\program files (x86)".to_string(),
        r"c:\programdata".to_string(),
    ];
    for key in ["SystemRoot", "WINDIR", "ProgramFiles", "ProgramFiles(x86)", "ProgramData"] {
        if let Some(p) = env_dir(key) {
            let s = normalize_path_str(&p.to_string_lossy()).to_lowercase();
            if !s.is_empty() {
                blocked.push(s);
            }
        }
    }
    for b in blocked {
        if low == b || (b.ends_with("\\windows") && low.starts_with(&format!("{b}\\"))) {
            return true;
        }
    }
    false
}

fn validate_data_dir_target(
    raw_target: &str,
    current: &Path,
    exe_d: &Path,
    keep_created: bool,
) -> Result<PathBuf, String> {
    let norm = normalize_path_str(raw_target);
    if norm.is_empty() {
        return Err("数据目录不能为空".into());
    }
    if norm.chars().count() > 160 {
        return Err("路径过长（不能超过 160 个字符），请选择更短的目录以免索引与 WebView2 失败".into());
    }
    let target = PathBuf::from(&norm);
    if !target.is_absolute() {
        return Err("数据目录必须是绝对路径（例如 D:\\QDiskData）".into());
    }
    if is_drive_root_str(&norm) {
        return Err(format!("{norm} 是盘符根目录，请在其下新建一个专属子目录（例如 {norm}\\整理助手数据）"));
    }
    if target.is_file() {
        return Err(format!("目标路径是文件而不是目录：{norm}"));
    }
    if is_forbidden_system_dir(&norm) {
        return Err(format!("不能把数据目录设在系统受保护目录中：{norm}"));
    }
    if path_eq_ci(&target, current) {
        return Err("新目录与当前数据目录相同，无需迁移".into());
    }
    if path_is_inside_ci(&target, current) {
        return Err("新数据目录不能位于当前数据目录内部".into());
    }
    if path_is_inside_ci(current, &target) {
        return Err("新数据目录不能是当前数据目录的上级目录".into());
    }
    let eng_dir = exe_d.join("引擎");
    if path_eq_ci(&target, exe_d) || path_eq_ci(&target, &eng_dir) || path_is_inside_ci(&target, &eng_dir) {
        return Err("不能直接把数据目录放在程序目录或引擎目录内（可放在程序外的独立目录）".into());
    }
    // 记录原本不存在的祖先链，预检模式（keep_created=false）结束时清理干净，避免取消后留下空目录
    let mut created_chain = Vec::new();
    if !target.exists() {
        let mut cur = target.as_path();
        while !cur.exists() {
            created_chain.push(cur.to_path_buf());
            match cur.parent() {
                Some(p) if !p.as_os_str().is_empty() => cur = p,
                _ => break,
            }
        }
    }
    if let Err(e) = std::fs::create_dir_all(&target) {
        return Err(format!("无法创建目标目录：{e}"));
    }
    let probe = target.join(format!(".tidy_write_probe_{}", std::process::id()));
    let write_res = std::fs::write(&probe, b"ok");
    let _ = std::fs::remove_file(&probe);
    if write_res.is_err() || !keep_created {
        for d in &created_chain {
            let _ = std::fs::remove_dir(d);
        }
    }
    if let Err(e) = write_res {
        return Err(format!("目标目录不可写（权限不足或磁盘只读）：{e}"));
    }
    Ok(target)
}

#[cfg(windows)]
fn disk_free_bytes_for(path: &Path) -> Option<u64> {
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let mut wide: Vec<u16> = path
        .to_string_lossy()
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let mut free_avail: u64 = 0;
    let mut total: u64 = 0;
    let mut total_free: u64 = 0;
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_mut_ptr(),
            &mut free_avail as *mut u64,
            &mut total as *mut u64,
            &mut total_free as *mut u64,
        )
    };
    if ok != 0 { Some(free_avail) } else { None }
}

#[cfg(not(windows))]
fn disk_free_bytes_for(_path: &Path) -> Option<u64> {
    None
}

struct MigrateFile {
    src: PathBuf,
    rel: PathBuf,
    size: u64,
}

fn collect_core_migrate_files(src_root: &Path) -> (Vec<MigrateFile>, Vec<PathBuf>, u64) {
    let mut files = Vec::new();
    let mut dirs = Vec::new();
    let mut total_bytes: u64 = 0;

    for &name in CORE_MIGRATE_ENTRIES {
        let entry = src_root.join(name);
        if !entry.exists() {
            continue;
        }
        if entry.is_file() {
            let sz = std::fs::metadata(&entry).map(|m| m.len()).unwrap_or(0);
            total_bytes = total_bytes.saturating_add(sz);
            files.push(MigrateFile {
                src: entry,
                rel: PathBuf::from(name),
                size: sz,
            });
        } else if entry.is_dir() {
            dirs.push(PathBuf::from(name));
            for item in walkdir::WalkDir::new(&entry).follow_links(false).into_iter().flatten() {
                let p = item.path();
                let Ok(rel) = p.strip_prefix(src_root) else {
                    continue;
                };
                if item.file_type().is_dir() {
                    dirs.push(rel.to_path_buf());
                } else if item.file_type().is_file() {
                    let sz = item.metadata().map(|m| m.len()).unwrap_or(0);
                    total_bytes = total_bytes.saturating_add(sz);
                    files.push(MigrateFile {
                        src: p.to_path_buf(),
                        rel: rel.to_path_buf(),
                        size: sz,
                    });
                }
            }
        }
    }
    (files, dirs, total_bytes)
}

fn sync_migrated_settings_json(old_dir: &Path, new_dir: &Path) -> Result<(), String> {
    let cfg_dir = new_dir.join("配置");
    std::fs::create_dir_all(&cfg_dir).map_err(|e| format!("创建配置目录失败：{e}"))?;
    let sp = cfg_dir.join("settings.json");
    let mut val = if sp.is_file() {
        std::fs::read_to_string(&sp)
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(s.trim_start_matches('\u{feff}')).ok())
            .unwrap_or_else(|| json!({}))
    } else {
        json!({})
    };
    if !val.is_object() {
        val = json!({});
    }
    let new_str = normalize_path_str(&new_dir.to_string_lossy());
    if let Some(obj) = val.as_object_mut() {
        obj.insert("data_dir".into(), json!(new_str));
        if let Some(cd) = obj.get("cache_dir").and_then(|x| x.as_str()).map(normalize_path_str) {
            if !cd.is_empty() {
                let cd_path = PathBuf::from(&cd);
                if path_eq_ci(&cd_path, old_dir) || path_is_inside_ci(&cd_path, old_dir) {
                    obj.insert("cache_dir".into(), json!(""));
                }
            }
        }
    }
    let text = serde_json::to_string_pretty(&val).map_err(|e| e.to_string())?;
    write_file_atomic(&sp, text.as_bytes()).map_err(|e| format!("更新新目录 settings.json 失败：{e}"))
}

fn copy_core_data_with_progress<F>(
    old_dir: &Path,
    new_dir: &Path,
    mut on_progress: F,
) -> Result<(usize, u64, Vec<String>), String>
where
    F: FnMut(u8, usize, usize, &str),
{
    let (files, dirs, total_bytes) = collect_core_migrate_files(old_dir);
    let need_bytes = total_bytes.saturating_add(64 * 1024 * 1024);
    if let Some(free) = disk_free_bytes_for(new_dir) {
        if free < need_bytes {
            return Err(format!(
                "目标磁盘剩余空间不足（至少需要约 {:.1} MB，当前剩余 {:.1} MB）",
                need_bytes as f64 / 1048576.0,
                free as f64 / 1048576.0
            ));
        }
    }

    for rel_dir in &dirs {
        let dst_d = new_dir.join(rel_dir);
        std::fs::create_dir_all(&dst_d)
            .map_err(|e| format!("创建目录 {} 失败：{e}", dst_d.display()))?;
    }

    let total_files = files.len();
    let mut copied_files: usize = 0;
    let mut copied_bytes: u64 = 0;
    let mut skipped_warnings: Vec<String> = Vec::new();
    let mut last_pct: u8 = 0;

    for (idx, item) in files.iter().enumerate() {
        let dst = new_dir.join(&item.rel);
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("创建目标子目录失败：{e}"))?;
        }
        let rel_txt = item.rel.to_string_lossy().to_string();
        let is_log = rel_txt.to_lowercase().starts_with("logs\\");
        match std::fs::copy(&item.src, &dst) {
            Ok(_) => {
                copied_files += 1;
                copied_bytes = copied_bytes.saturating_add(item.size);
            }
            Err(e) => {
                // 正在追加写入的当日日志文件若被短暂锁定，不阻断整体配置与历史迁移
                if is_log {
                    skipped_warnings.push(format!("跳过锁定日志 {rel_txt}：{e}"));
                } else {
                    return Err(format!("复制 {rel_txt} 失败：{e}"));
                }
            }
        }
        let pct = if total_bytes > 0 {
            18u8.saturating_add(((copied_bytes.saturating_mul(64)) / total_bytes).min(64) as u8)
        } else if total_files > 0 {
            18u8.saturating_add((((idx + 1) * 64) / total_files).min(64) as u8)
        } else {
            82
        };
        if pct != last_pct || idx + 1 == total_files {
            last_pct = pct;
            on_progress(pct, idx + 1, total_files, &rel_txt);
        }
    }

    // 在新目录重建必需子目录结构，重启后自动在新目录生成索引/WebView2/日志
    for &sub in REBUILD_SUBDIRS {
        std::fs::create_dir_all(new_dir.join(sub))
            .map_err(|e| format!("重建目录 {sub} 失败：{e}"))?;
    }
    sync_migrated_settings_json(old_dir, new_dir)?;
    Ok((copied_files, copied_bytes, skipped_warnings))
}

#[cfg(windows)]
fn spawn_migrate_restart_bootstrap(old_dir: &Path, exe_path: &Path) -> Result<(), String> {
    let cur_pid = std::process::id().to_string();
    let known = CLEANUP_KNOWN_ENTRIES.join("|");
    let script = r#"
$ErrorActionPreference = 'SilentlyContinue'
$pidVal = [int]$env:_TIDY_MIG_PID
$oldDir = $env:_TIDY_MIG_OLD
$exePath = $env:_TIDY_MIG_EXE
$known = ($env:_TIDY_MIG_KNOWN -split '\|') | Where-Object { $_ }

for ($i = 0; $i -lt 150; $i++) {
  if (-not (Get-Process -Id $pidVal -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Milliseconds 100
}
Start-Sleep -Milliseconds 300

if ($oldDir -and (Test-Path -LiteralPath $oldDir)) {
  foreach ($name in $known) {
    $p = Join-Path $oldDir $name
    if (Test-Path -LiteralPath $p) {
      Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  $left = Get-ChildItem -LiteralPath $oldDir -Force -ErrorAction SilentlyContinue
  if (-not $left) {
    Remove-Item -LiteralPath $oldDir -Force -ErrorAction SilentlyContinue
  }
}

if ($exePath -and (Test-Path -LiteralPath $exePath)) {
  Start-Process -FilePath $exePath -ArgumentList '--restarted'
}
"#;
    Command::new("powershell")
        .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", script])
        .env("_TIDY_MIG_PID", cur_pid)
        .env("_TIDY_MIG_OLD", old_dir.to_string_lossy().to_string())
        .env("_TIDY_MIG_EXE", exe_path.to_string_lossy().to_string())
        .env("_TIDY_MIG_KNOWN", known)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("启动重启引导器失败：{e}"))?;
    Ok(())
}

#[cfg(not(windows))]
fn spawn_migrate_restart_bootstrap(_old_dir: &Path, _exe_path: &Path) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
async fn data_dir_migrate_preview(target_dir: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Value, String> {
        let current = data_dir();
        let target = validate_data_dir_target(&target_dir, &current, &exe_dir(), false)?;
        let (files, _dirs, total_bytes) = collect_core_migrate_files(&current);
        let probe_disk = if target.exists() {
            target.as_path()
        } else {
            target.parent().unwrap_or(target.as_path())
        };
        let free_bytes = disk_free_bytes_for(probe_disk).unwrap_or(0);
        let target_has_files = target.is_dir()
            && std::fs::read_dir(&target)
                .ok()
                .and_then(|mut rd| rd.next())
                .is_some();
        Ok(json!({
            "oldDir": normalize_path_str(&current.to_string_lossy()),
            "newDir": normalize_path_str(&target.to_string_lossy()),
            "fileCount": files.len(),
            "totalBytes": total_bytes,
            "freeBytes": free_bytes,
            "targetHasFiles": target_has_files
        }))
    })
    .await
    .map_err(|e| format!("预检任务失败：{e}"))?
}

#[tauri::command]
async fn data_dir_migrate(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    target_dir: String,
) -> Result<Value, String> {
    if DATA_MIGRATE_BUSY
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("当前正在迁移数据目录，请等待完成".into());
    }
    struct ResetGuard;
    impl Drop for ResetGuard {
        fn drop(&mut self) {
            DATA_MIGRATE_BUSY.store(false, Ordering::SeqCst);
        }
    }

    let engine = Arc::clone(&state.engine);
    let app2 = app.clone();
    let emit = |app_h: &tauri::AppHandle, phase: &str, percent: u8, done: usize, total: usize, current: &str, detail: &str| {
        let _ = app_h.emit(
            "data-dir-migrate-progress",
            json!({
                "phase": phase,
                "percent": percent,
                "done": done,
                "total": total,
                "current": current,
                "detail": detail
            }),
        );
    };

    let result = tauri::async_runtime::spawn_blocking(move || -> Result<Value, String> {
        let _guard = ResetGuard;
        let old_dir = data_dir();
        let exe_d = exe_dir();
        emit(&app2, "validate", 5, 0, 0, "", "正在校验目标目录与磁盘空间…");
        let new_dir = validate_data_dir_target(&target_dir, &old_dir, &exe_d, true)?;

        emit(&app2, "stop_engine", 14, 0, 0, "", "正在停止后台引擎并释放文件句柄…");
        if let Ok(mut g) = engine.lock() {
            if let Some(mut old) = g.take() {
                let _ = old.child.kill();
                let _ = old.child.wait();
            }
        }
        std::thread::sleep(Duration::from_millis(200));

        emit(&app2, "copy", 18, 0, 0, "", "正在一次性迁移配置、历史、AI 会话与日志…");
        let (copied_files, copied_bytes, warnings) =
            copy_core_data_with_progress(&old_dir, &new_dir, |pct, done, total, rel| {
                emit(&app2, "copy", pct, done, total, rel, &format!("正在迁移 ({done}/{total})：{rel}"));
            })?;

        emit(&app2, "locator", 90, copied_files, copied_files, "", "正在写入新目录指针并建立目录骨架…");
        let local = env_dir("LOCALAPPDATA");
        let write_cands = locator_write_candidates_for(&exe_d, local.as_deref());
        let written = write_locator_to_candidates(&new_dir, &write_cands)?;

        emit(&app2, "restarting", 98, copied_files, copied_files, "", "迁移完成，正在自动重启轻盘并在新目录重建运行文件…");
        let cur_exe = std::env::current_exe().map_err(|e| format!("获取当前程序路径失败：{e}"))?;
        spawn_migrate_restart_bootstrap(&old_dir, &cur_exe)?;

        emit(&app2, "done", 100, copied_files, copied_files, "", "即将自动重启生效…");
        Ok(json!({
            "oldDir": normalize_path_str(&old_dir.to_string_lossy()),
            "newDir": normalize_path_str(&new_dir.to_string_lossy()),
            "copiedFiles": copied_files,
            "copiedBytes": copied_bytes,
            "warnings": warnings,
            "locators": written.iter().map(|p| p.to_string_lossy().to_string()).collect::<Vec<_>>(),
            "restarting": true
        }))
    })
    .await
    .map_err(|e| format!("迁移任务失败：{e}"))??;

    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(450));
        handle.exit(0);
    });
    Ok(result)
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

fn validate_schedule_time(raw: &str) -> Result<String, String> {
    let t = raw.trim();
    let Some((hh, mm)) = t.split_once(':') else {
        return Err("定时时间格式必须为 HH:MM（如 03:00）".into());
    };
    if hh.len() != 2
        || mm.len() != 2
        || !hh.bytes().all(|b| b.is_ascii_digit())
        || !mm.bytes().all(|b| b.is_ascii_digit())
    {
        return Err("定时时间格式必须为 HH:MM（如 03:00）".into());
    }
    let h: u8 = hh.parse().map_err(|_| "小时无效".to_string())?;
    let m: u8 = mm.parse().map_err(|_| "分钟无效".to_string())?;
    if h > 23 || m > 59 {
        return Err("定时时间范围应为 00:00 至 23:59".into());
    }
    Ok(format!("{h:02}:{m:02}"))
}

#[tauri::command(async)]
fn schedule_set(enabled: bool, time: String, days: i64, cache: bool, screenshots: bool) -> Result<bool, String> {
    let time = validate_schedule_time(&time)?;
    let days = days.clamp(1, 3650);
    if !enabled {
        let _ = Command::new("schtasks")
            .args(["/Delete", "/TN", TASK_NAME, "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        let _guard = CONFIG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
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
        let _guard = CONFIG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
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

/// 读取任意文本文件（规则 YAML、迁移报告、日志尾部等），带大小上限且按 UTF-8 字符边界对齐。
/// 修复旧版 seek 到 `len - limit` 落在多字节中文中间导致 `read_to_string` 报非法 UTF-8 失败的问题。
fn read_tail_utf8(path: &Path, max_bytes: u64) -> Result<String, String> {
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let limit = max_bytes.min(len);
    let truncated = len > limit;
    if truncated {
        use std::io::Seek;
        f.seek(std::io::SeekFrom::Start(len - limit))
            .map_err(|e| e.to_string())?;
    }
    let mut buf = Vec::with_capacity(limit as usize);
    f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    let mut start = 0usize;
    if truncated {
        // 跳过最多 3 个 UTF-8 续字节（10xxxxxx），对齐到下一个完整字符起始位
        while start < buf.len() && start < 3 && (buf[start] & 0xC0) == 0x80 {
            start += 1;
        }
    }
    Ok(String::from_utf8_lossy(&buf[start..]).into_owned())
}

#[tauri::command(async)]
fn read_text(path: String, max_bytes: Option<u64>) -> Result<String, String> {
    if is_windows_device_path(&path) {
        return Err("拒绝读取系统设备路径或保留设备名".into());
    }
    let capped = max_bytes.unwrap_or(512 * 1024).clamp(1, 8 * 1024 * 1024);
    read_tail_utf8(Path::new(&path), capped)
}

// ---------------------------------------------------------------- 全能只读文件内容预览（整理文件 / 空间工具 / 目录浏览共用）

const FILE_PREVIEW_TEXT_DEFAULT: u64 = 256 * 1024;
const FILE_PREVIEW_TEXT_MAX: u64 = 512 * 1024;
const FILE_PREVIEW_HEX_DEFAULT: usize = 32 * 1024;
const FILE_PREVIEW_HEX_MAX: usize = 64 * 1024;
const FILE_PREVIEW_SNIFF_BYTES: usize = 64 * 1024;
const OOXML_XML_MAX_BYTES: u64 = 2 * 1024 * 1024;
const OOXML_TOTAL_XML_BUDGET: u64 = 6 * 1024 * 1024;
const OOXML_MAX_ARCHIVE_ENTRIES: usize = 4096;
const OOXML_MAX_CHARS: usize = 120_000;

fn is_windows_device_path(raw: &str) -> bool {
    let norm = raw.trim().replace('/', "\\");
    let low = norm.to_ascii_lowercase();
    if low.starts_with(r"\\.\")
        || low.starts_with(r"\\?\pipe\")
        || low.starts_with(r"\\?\globalroot")
        || low.starts_with(r"\\?\device\")
    {
        return true;
    }
    // 拦截 NTFS 备用数据流（ADS，如 C:\foo.txt:stream），跳过盘符冒号与 \\?\C: 前缀
    let after_prefix = norm.strip_prefix(r"\\?\").unwrap_or(&norm);
    let after_drive = if after_prefix.len() >= 2
        && after_prefix.as_bytes()[0].is_ascii_alphabetic()
        && after_prefix.as_bytes()[1] == b':'
    {
        &after_prefix[2..]
    } else {
        after_prefix
    };
    if after_drive.contains(':') {
        return true;
    }
    // 逐段检查 Windows 保留设备名（不仅是末段，中间段如 C:\foo\CON\bar 同样会触发设备句柄挂起）
    for seg in after_drive.split('\\') {
        let clean = seg.trim_end_matches([' ', '.']);
        if clean.is_empty() {
            continue;
        }
        let stem = clean.split('.').next().unwrap_or("").to_ascii_uppercase();
        if matches!(
            stem.as_str(),
            "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
                | "COM1" | "COM2" | "COM3" | "COM4" | "COM5" | "COM6" | "COM7" | "COM8" | "COM9"
                | "LPT1" | "LPT2" | "LPT3" | "LPT4" | "LPT5" | "LPT6" | "LPT7" | "LPT8" | "LPT9"
        ) {
            return true;
        }
    }
    false
}

fn is_image_preview_ext(ext: &str) -> bool {
    matches!(
        ext,
        "png" | "jpg" | "jpeg" | "jfif" | "gif" | "webp" | "bmp" | "ico" | "avif" | "svg"
    )
}

fn is_video_preview_ext(ext: &str) -> bool {
    matches!(ext, "mp4" | "webm" | "mov" | "m4v" | "mkv" | "avi" | "wmv" | "ogv")
}

fn is_audio_preview_ext(ext: &str) -> bool {
    matches!(ext, "mp3" | "wav" | "flac" | "m4a" | "aac" | "ogg" | "opus" | "wma")
}

fn is_text_preview_ext(ext: &str) -> bool {
    matches!(
        ext,
        "txt" | "log" | "md" | "markdown" | "json" | "jsonl" | "ndjson" | "jsonc"
            | "yaml" | "yml" | "toml" | "ini" | "cfg" | "conf" | "properties" | "env"
            | "xml" | "xsd" | "xsl" | "plist" | "xaml" | "csproj" | "sln" | "vcxproj"
            | "csv" | "tsv" | "sql" | "graphql" | "gql"
            | "js" | "mjs" | "cjs" | "ts" | "tsx" | "jsx" | "vue" | "svelte"
            | "html" | "htm" | "css" | "scss" | "sass" | "less"
            | "py" | "pyw" | "pyi" | "rs" | "go" | "java" | "kt" | "kts" | "scala"
            | "c" | "h" | "cpp" | "cc" | "cxx" | "hpp" | "hh" | "cs" | "swift" | "m" | "mm"
            | "php" | "rb" | "pl" | "pm" | "lua" | "r" | "dart" | "zig" | "nim" | "ex" | "exs"
            | "sh" | "bash" | "zsh" | "fish" | "bat" | "cmd" | "ps1" | "psm1" | "psd1" | "vbs" | "reg"
            | "srt" | "ass" | "ssa" | "vtt" | "lrc" | "nfo" | "diff" | "patch"
            | "tex" | "bib" | "rst" | "adoc" | "org" | "ics" | "vcf" | "rtf"
            | "gitignore" | "gitattributes" | "gitmodules" | "editorconfig" | "npmrc" | "yarnrc"
            | "dockerfile" | "makefile" | "cmake" | "gradle" | "lock" | "spec" | "inf" | "url"
    )
}

fn is_known_text_filename(name: &str) -> bool {
    let low = name.to_ascii_lowercase();
    matches!(
        low.as_str(),
        "readme" | "license" | "licence" | "notice" | "authors" | "changelog" | "history"
            | "makefile" | "dockerfile" | "jenkinsfile" | "vagrantfile" | "procfile"
            | "hosts" | "cmakelists.txt" | ".gitignore" | ".env" | ".editorconfig"
    )
}

fn preview_mime_of(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" | "jfif" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "avi" => "video/x-msvideo",
        "wmv" => "video/x-ms-wmv",
        "ogv" => "video/ogg",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "ogg" | "opus" => "audio/ogg",
        "wma" => "audio/x-ms-wma",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        _ => "application/octet-stream",
    }
}

fn trim_utf8_incomplete_tail(bytes: &[u8]) -> &[u8] {
    let n = bytes.len();
    for back in 1..=3usize {
        if n < back {
            break;
        }
        let idx = n - back;
        let b = bytes[idx];
        if b < 0x80 {
            return bytes;
        }
        if b >= 0xC0 {
            let need = if b >= 0xF0 {
                4
            } else if b >= 0xE0 {
                3
            } else {
                2
            };
            return if back < need { &bytes[..idx] } else { bytes };
        }
    }
    bytes
}

fn looks_like_utf16le_no_bom(bytes: &[u8]) -> bool {
    let sample = &bytes[..bytes.len().min(4096)];
    if sample.len() < 8 {
        return false;
    }
    let pairs = sample.len() / 2;
    let mut odd_zero = 0usize;
    let mut even_zero = 0usize;
    let mut even_printable = 0usize;
    for pair in sample.chunks_exact(2) {
        if pair[1] == 0 {
            odd_zero += 1;
        }
        if pair[0] == 0 {
            even_zero += 1;
        }
        if matches!(pair[0], b'\t' | b'\n' | b'\r' | 0x20..=0x7E) {
            even_printable += 1;
        }
    }
    odd_zero * 100 >= pairs * 35 && even_zero * 100 < pairs * 5 && even_printable * 100 >= pairs * 35
}

fn is_probably_text_bytes(bytes: &[u8]) -> bool {
    if bytes.is_empty() {
        return true;
    }
    if bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) || looks_like_utf16le_no_bom(bytes) {
        return true;
    }
    let sample = &bytes[..bytes.len().min(8192)];
    if sample.contains(&0) {
        return false;
    }
    let ctrl = sample
        .iter()
        .filter(|&&b| b < 0x20 && !matches!(b, b'\t' | b'\n' | b'\r' | 0x0C))
        .count();
    ctrl * 20 <= sample.len()
}

fn decode_preview_text(bytes: &[u8], truncated: bool) -> (&'static str, String) {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        let body = &bytes[3..];
        let trimmed = if truncated { trim_utf8_incomplete_tail(body) } else { body };
        if let Ok(s) = std::str::from_utf8(trimmed) {
            return ("utf-8-bom", s.to_string());
        }
    }
    if bytes.starts_with(&[0xFF, 0xFE]) && bytes.len() >= 2 {
        let body = &bytes[2..];
        let even_len = body.len() & !1;
        let units: Vec<u16> = body[..even_len]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        return ("utf-16le", String::from_utf16_lossy(&units));
    }
    if bytes.starts_with(&[0xFE, 0xFF]) && bytes.len() >= 2 {
        let body = &bytes[2..];
        let even_len = body.len() & !1;
        let units: Vec<u16> = body[..even_len]
            .chunks_exact(2)
            .map(|c| u16::from_be_bytes([c[0], c[1]]))
            .collect();
        return ("utf-16be", String::from_utf16_lossy(&units));
    }
    if looks_like_utf16le_no_bom(bytes) {
        let even_len = bytes.len() & !1;
        let units: Vec<u16> = bytes[..even_len]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        return ("utf-16le", String::from_utf16_lossy(&units));
    }
    let utf8_slice = if truncated { trim_utf8_incomplete_tail(bytes) } else { bytes };
    if let Ok(s) = std::str::from_utf8(utf8_slice) {
        return ("utf-8", s.to_string());
    }
    #[cfg(windows)]
    {
        // GBK 截断对齐：若末尾悬空奇数个高位字节（0x81..=0xFE），退 1 字节避免最后一个汉字乱码
        let mut gbk_slice = bytes;
        if truncated && !bytes.is_empty() {
            let mut hi = 0usize;
            for &b in bytes.iter().rev() {
                if b >= 0x81 && b <= 0xFE {
                    hi += 1;
                } else {
                    break;
                }
            }
            if hi % 2 == 1 {
                gbk_slice = &bytes[..bytes.len() - 1];
            }
        }
        if let Some(s) = gbk_decode(gbk_slice) {
            return ("gbk", s);
        }
    }
    ("utf-8-lossy", String::from_utf8_lossy(utf8_slice).into_owned())
}

fn detect_magic_label(bytes: &[u8]) -> &'static str {
    if bytes.len() >= 2 && bytes.starts_with(b"MZ") {
        return "Windows 可执行文件 / 动态库 (PE)";
    }
    if bytes.len() >= 4 && bytes.starts_with(&[0x7F, b'E', b'L', b'F']) {
        return "Linux ELF 二进制程序";
    }
    if bytes.len() >= 16 && bytes.starts_with(b"SQLite format 3\0") {
        return "SQLite 3 数据库";
    }
    if bytes.len() >= 8 && bytes.starts_with(&[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]) {
        return "Microsoft OLE2 复合文档 (.doc / .xls / .ppt / .msi)";
    }
    if bytes.len() >= 5 && bytes.starts_with(b"%PDF-") {
        return "PDF 文档";
    }
    if bytes.len() >= 4 && bytes.starts_with(&[0x50, 0x4B, 0x03, 0x04]) {
        return "ZIP 容器（压缩包 / Office / JAR / APK）";
    }
    if bytes.len() >= 6 && bytes.starts_with(&[0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C]) {
        return "7-Zip 压缩包";
    }
    if bytes.len() >= 7 && bytes.starts_with(b"Rar!\x1A\x07") {
        return "RAR 压缩包";
    }
    if bytes.len() >= 8 && bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return "PNG 图片";
    }
    if bytes.len() >= 3 && bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return "JPEG 图片";
    }
    if bytes.len() >= 4 && bytes.starts_with(&[0xCA, 0xFE, 0xBA, 0xBE]) {
        return "Java 字节码 / Mach-O 通用二进制";
    }
    if bytes.len() >= 4 && bytes.starts_with(b"wOF2") {
        return "WOFF2 字体文件";
    }
    if bytes.len() >= 4 && (bytes.starts_with(&[0x00, 0x01, 0x00, 0x00]) || bytes.starts_with(b"OTTO")) {
        return "TrueType / OpenType 字体文件";
    }
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        return "ISO BMFF 媒体容器 (MP4 / MOV / M4A / HEIC)";
    }
    if bytes.len() >= 4 && bytes.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        return "Matroska / WebM 媒体容器";
    }
    "二进制数据文件"
}

fn format_hex_dump(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut out = String::with_capacity(bytes.len() * 4);
    for (row, chunk) in bytes.chunks(16).enumerate() {
        let _ = write!(out, "{:08X}  ", row * 16);
        for i in 0..16 {
            if i == 8 {
                out.push(' ');
            }
            if let Some(b) = chunk.get(i) {
                let _ = write!(out, "{b:02X} ");
            } else {
                out.push_str("   ");
            }
        }
        out.push_str(" |");
        for &b in chunk {
            out.push(if (0x20..=0x7E).contains(&b) { b as char } else { '.' });
        }
        out.push_str("|\n");
    }
    out
}

fn unescape_xml_entities(input: &str) -> String {
    if !input.contains('&') {
        return input.to_string();
    }
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        rest = &rest[amp + 1..];
        if let Some(semi) = rest.find(';') {
            let ent = &rest[..semi];
            let decoded: Option<char> = match ent {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                _ if ent.starts_with("#x") || ent.starts_with("#X") => {
                    u32::from_str_radix(&ent[2..], 16).ok().and_then(char::from_u32)
                }
                _ if ent.starts_with('#') => ent[1..].parse::<u32>().ok().and_then(char::from_u32),
                _ => None,
            };
            if let Some(ch) = decoded {
                out.push(ch);
                rest = &rest[semi + 1..];
                continue;
            }
        }
        out.push('&');
    }
    out.push_str(rest);
    out
}

fn read_zip_member_capped<R: Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
    name: &str,
    cap: u64,
    budget: &mut u64,
) -> Option<String> {
    let allow = cap.min(*budget);
    if allow == 0 {
        return None;
    }
    let f = archive.by_name(name).ok()?;
    let mut buf = Vec::new();
    let _ = f.take(allow).read_to_end(&mut buf).ok()?;
    *budget = budget.saturating_sub(buf.len() as u64);
    let trimmed = if buf.len() as u64 >= allow {
        trim_utf8_incomplete_tail(&buf)
    } else {
        &buf[..]
    };
    Some(String::from_utf8_lossy(trimmed).into_owned())
}

/// O(N) 字符上限追加：通过外部计数 `used` 避免每字符重扫全串导致 O(N²) 卡顿。
fn push_capped(out: &mut String, used: &mut usize, piece: &str, max_chars: usize) -> bool {
    if *used >= max_chars {
        return true;
    }
    for ch in piece.chars() {
        out.push(ch);
        *used += 1;
        if *used >= max_chars {
            return true;
        }
    }
    false
}

fn extract_docx_xml_text(xml: &str) -> (String, bool) {
    let mut out = String::new();
    let mut used = 0usize;
    let mut truncated = false;
    let mut rest = xml;
    let mut in_text = false;
    let mut cur_text = String::new();

    while let Some(lt) = rest.find('<') {
        let text_chunk = &rest[..lt];
        if in_text && !text_chunk.is_empty() {
            cur_text.push_str(text_chunk);
        }
        rest = &rest[lt + 1..];
        let Some(gt) = rest.find('>') else {
            break;
        };
        let tag = rest[..gt].trim();
        rest = &rest[gt + 1..];

        let tag_name = tag
            .trim_end_matches('/')
            .trim()
            .split(|c: char| c.is_ascii_whitespace())
            .next()
            .unwrap_or("");
        if tag_name == "w:t" && !tag.ends_with('/') {
            in_text = true;
            cur_text.clear();
        } else if tag_name == "/w:t" {
            if in_text {
                let dec = unescape_xml_entities(&cur_text);
                truncated |= push_capped(&mut out, &mut used, &dec, OOXML_MAX_CHARS);
                cur_text.clear();
                in_text = false;
            }
        } else if tag_name == "w:tab" {
            truncated |= push_capped(&mut out, &mut used, "\t", OOXML_MAX_CHARS);
        } else if tag_name == "w:br" || tag_name == "w:cr" || tag_name == "/w:p" {
            if !out.ends_with('\n') || tag_name == "w:br" {
                truncated |= push_capped(&mut out, &mut used, "\n", OOXML_MAX_CHARS);
            }
        } else if tag_name == "/w:tc" {
            truncated |= push_capped(&mut out, &mut used, "\t", OOXML_MAX_CHARS);
        }
        if truncated {
            break;
        }
    }
    (out.trim().to_string(), truncated)
}

fn extract_xml_attr<'a>(tag: &'a str, attr: &str) -> Option<&'a str> {
    let needle = format!("{attr}=\"");
    let pos = tag.find(needle.as_str())?;
    let after = &tag[pos + needle.len()..];
    let end = after.find('"')?;
    Some(&after[..end])
}

fn parse_xlsx_shared_strings(xml: &str) -> Vec<String> {
    let mut list = Vec::new();
    let mut rest = xml;
    while let Some(si_pos) = rest.find("<si") {
        rest = &rest[si_pos + 3..];
        let Some(si_gt) = rest.find('>') else { break };
        rest = &rest[si_gt + 1..];
        let Some(end_si) = rest.find("</si>") else { break };
        let chunk = &rest[..end_si];
        rest = &rest[end_si + 5..];

        let mut cell = String::new();
        let mut sub = chunk;
        while let Some(t_pos) = sub.find("<t") {
            let after_t = &sub[t_pos + 2..];
            let next_c = after_t.as_bytes().first().copied().unwrap_or(0);
            if next_c != b'>' && !next_c.is_ascii_whitespace() {
                sub = after_t;
                continue;
            }
            let Some(gt) = after_t.find('>') else { break };
            let header = &after_t[..gt];
            sub = &after_t[gt + 1..];
            if header.ends_with('/') {
                continue;
            }
            let Some(end_t) = sub.find("</t>") else { break };
            cell.push_str(&unescape_xml_entities(&sub[..end_t]));
            sub = &sub[end_t + 4..];
        }
        list.push(cell);
        if list.len() >= 100_000 {
            break;
        }
    }
    list
}

fn parse_xlsx_sheet_names(xml: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut rest = xml;
    while let Some(lt) = rest.find('<') {
        rest = &rest[lt + 1..];
        let Some(gt) = rest.find('>') else { break };
        let tag = rest[..gt].trim();
        rest = &rest[gt + 1..];
        let tname = tag.split(|c: char| c.is_ascii_whitespace() || c == '/').next().unwrap_or("");
        if tname == "sheet" || tname.ends_with(":sheet") {
            if let Some(n) = extract_xml_attr(tag, "name") {
                names.push(unescape_xml_entities(n));
            }
        }
    }
    names
}

fn extract_xlsx_sheet_text(xml: &str, shared: &[String], max_rows: usize, max_cols: usize) -> (String, bool) {
    let mut lines: Vec<String> = Vec::new();
    let mut truncated = false;
    let mut rest = xml;
    while let Some(row_pos) = rest.find("<row") {
        if lines.len() >= max_rows {
            truncated = true;
            break;
        }
        rest = &rest[row_pos + 4..];
        let Some(row_gt) = rest.find('>') else { break };
        let row_hdr = &rest[..row_gt];
        rest = &rest[row_gt + 1..];
        if row_hdr.ends_with('/') {
            continue;
        }
        let Some(end_row) = rest.find("</row>") else { break };
        let row_body = &rest[..end_row];
        rest = &rest[end_row + 6..];

        let mut cells: Vec<String> = Vec::new();
        let mut sub = row_body;
        while let Some(c_pos) = sub.find("<c") {
            let after_c = &sub[c_pos + 2..];
            let nc = after_c.as_bytes().first().copied().unwrap_or(0);
            if nc != b'>' && !nc.is_ascii_whitespace() {
                sub = after_c;
                continue;
            }
            let Some(gt) = after_c.find('>') else { break };
            let hdr = &after_c[..gt];
            sub = &after_c[gt + 1..];
            if hdr.ends_with('/') {
                continue;
            }
            let Some(end_c) = sub.find("</c>") else { break };
            let c_body = &sub[..end_c];
            sub = &sub[end_c + 4..];
            if cells.len() >= max_cols {
                truncated = true;
                break;
            }
            let c_type = extract_xml_attr(hdr, "t").unwrap_or("");
            let val = if c_type == "inlineStr" {
                let mut s = String::new();
                let mut ts = c_body;
                while let Some(tp) = ts.find("<t") {
                    let at = &ts[tp + 2..];
                    let Some(tgt) = at.find('>') else { break };
                    ts = &at[tgt + 1..];
                    let Some(te) = ts.find("</t>") else { break };
                    s.push_str(&unescape_xml_entities(&ts[..te]));
                    ts = &ts[te + 4..];
                }
                s
            } else if let Some(vp) = c_body.find("<v") {
                let av = &c_body[vp + 2..];
                if let Some(vgt) = av.find('>') {
                    let vbody = &av[vgt + 1..];
                    if let Some(ve) = vbody.find("</v>") {
                        let raw_v = unescape_xml_entities(vbody[..ve].trim());
                        if c_type == "s" {
                            raw_v
                                .parse::<usize>()
                                .ok()
                                .and_then(|idx| shared.get(idx).cloned())
                                .unwrap_or(raw_v)
                        } else if c_type == "b" {
                            if raw_v == "1" { "TRUE".into() } else { "FALSE".into() }
                        } else {
                            raw_v
                        }
                    } else {
                        String::new()
                    }
                } else {
                    String::new()
                }
            } else {
                String::new()
            };
            cells.push(val.replace(['\r', '\n', '\t'], " "));
        }
        if cells.iter().any(|c| !c.trim().is_empty()) {
            lines.push(cells.join("\t"));
        }
    }
    (lines.join("\n"), truncated)
}

fn extract_pptx_slide_text(xml: &str) -> String {
    let mut out = String::new();
    let mut rest = xml;
    let mut in_t = false;
    let mut buf = String::new();
    while let Some(lt) = rest.find('<') {
        if in_t {
            buf.push_str(&rest[..lt]);
        }
        rest = &rest[lt + 1..];
        let Some(gt) = rest.find('>') else { break };
        let tag = rest[..gt].trim();
        rest = &rest[gt + 1..];
        let name = tag
            .trim_end_matches('/')
            .trim()
            .split(|c: char| c.is_ascii_whitespace())
            .next()
            .unwrap_or("");
        if name == "a:t" && !tag.ends_with('/') {
            in_t = true;
            buf.clear();
        } else if name == "/a:t" {
            if in_t {
                out.push_str(&unescape_xml_entities(&buf));
                buf.clear();
                in_t = false;
            }
        } else if name == "/a:p" || name == "a:br" {
            if !out.ends_with('\n') {
                out.push('\n');
            }
        }
    }
    out.trim().to_string()
}

fn extract_ooxml_preview(path: &Path, ext: &str) -> Result<(String, bool, &'static str), String> {
    let f = std::fs::File::open(path).map_err(|e| format!("打开文档失败：{e}"))?;
    let mut archive = zip::ZipArchive::new(f).map_err(|_| {
        "该 Office 文档可能已加密、损坏或属于旧版二进制格式，暂不支持软件内正文提取".to_string()
    })?;

    // 仅扫描内存中的中央目录（限 4096 条，零逐项磁盘 seek）并统一做大小写不敏感匹配
    let member_names: Vec<String> = archive
        .file_names()
        .take(OOXML_MAX_ARCHIVE_ENTRIES)
        .filter_map(|r| r.ok().map(|c| c.into_owned()))
        .collect();
    let find_ci = |want_lower: &str| -> Option<String> {
        member_names
            .iter()
            .find(|n| n.trim_start_matches('/').eq_ignore_ascii_case(want_lower))
            .cloned()
    };
    let mut xml_budget = OOXML_TOTAL_XML_BUDGET;

    match ext {
        "docx" => {
            let doc_member = find_ci("word/document.xml")
                .ok_or_else(|| "DOCX 文档中未找到正文内容（word/document.xml）".to_string())?;
            let xml = read_zip_member_capped(&mut archive, &doc_member, OOXML_XML_MAX_BYTES, &mut xml_budget)
                .ok_or_else(|| "DOCX 文档中未找到正文内容（word/document.xml）".to_string())?;
            let (text, trunc) = extract_docx_xml_text(&xml);
            Ok((text, trunc, "Word 文档 (.docx)"))
        }
        "xlsx" => {
            let shared = find_ci("xl/sharedstrings.xml")
                .and_then(|n| read_zip_member_capped(&mut archive, &n, OOXML_XML_MAX_BYTES, &mut xml_budget))
                .map(|x| parse_xlsx_shared_strings(&x))
                .unwrap_or_default();
            let names = find_ci("xl/workbook.xml")
                .and_then(|n| read_zip_member_capped(&mut archive, &n, 512 * 1024, &mut xml_budget))
                .map(|x| parse_xlsx_sheet_names(&x))
                .unwrap_or_default();
            let mut sheet_files: Vec<(u32, String)> = Vec::new();
            for n in &member_names {
                let low = n.trim_start_matches('/').to_ascii_lowercase();
                if let Some(rest) = low.strip_prefix("xl/worksheets/sheet").and_then(|s| s.strip_suffix(".xml")) {
                    if let Ok(idx) = rest.parse::<u32>() {
                        sheet_files.push((idx, n.clone()));
                    }
                }
            }
            sheet_files.sort_by_key(|x| x.0);
            let mut out = String::new();
            let mut used = 0usize;
            let mut truncated = sheet_files.len() > 6;
            for (pos, (_idx, file_name)) in sheet_files.into_iter().take(6).enumerate() {
                if xml_budget == 0 {
                    truncated = true;
                    break;
                }
                let Some(xml) = read_zip_member_capped(&mut archive, &file_name, OOXML_XML_MAX_BYTES, &mut xml_budget) else {
                    continue;
                };
                let (sheet_txt, t) = extract_xlsx_sheet_text(&xml, &shared, 200, 30);
                truncated |= t;
                let title = names
                    .get(pos)
                    .cloned()
                    .unwrap_or_else(|| format!("工作表 {}", pos + 1));
                if !out.is_empty() {
                    truncated |= push_capped(&mut out, &mut used, "\n\n", OOXML_MAX_CHARS);
                }
                let hdr = format!("=== {title} ===\n");
                truncated |= push_capped(&mut out, &mut used, &hdr, OOXML_MAX_CHARS);
                if sheet_txt.is_empty() {
                    truncated |= push_capped(&mut out, &mut used, "（空工作表）", OOXML_MAX_CHARS);
                } else {
                    truncated |= push_capped(&mut out, &mut used, &sheet_txt, OOXML_MAX_CHARS);
                }
                if used >= OOXML_MAX_CHARS {
                    truncated = true;
                    break;
                }
            }
            Ok((out, truncated, "Excel 工作簿 (.xlsx)"))
        }
        "pptx" => {
            let mut slides: Vec<(u32, String)> = Vec::new();
            for n in &member_names {
                let low = n.trim_start_matches('/').to_ascii_lowercase();
                if let Some(rest) = low.strip_prefix("ppt/slides/slide").and_then(|s| s.strip_suffix(".xml")) {
                    if let Ok(idx) = rest.parse::<u32>() {
                        slides.push((idx, n.clone()));
                    }
                }
            }
            slides.sort_by_key(|x| x.0);
            let mut out = String::new();
            let mut used = 0usize;
            let mut truncated = slides.len() > 60;
            for (idx, file_name) in slides.into_iter().take(60) {
                if xml_budget == 0 {
                    truncated = true;
                    break;
                }
                let Some(xml) = read_zip_member_capped(&mut archive, &file_name, 512 * 1024, &mut xml_budget) else {
                    continue;
                };
                let slide_txt = extract_pptx_slide_text(&xml);
                if !out.is_empty() {
                    truncated |= push_capped(&mut out, &mut used, "\n\n", OOXML_MAX_CHARS);
                }
                let hdr = format!("--- 第 {idx} 页 ---\n");
                truncated |= push_capped(&mut out, &mut used, &hdr, OOXML_MAX_CHARS);
                if slide_txt.is_empty() {
                    truncated |= push_capped(&mut out, &mut used, "（无文本内容）", OOXML_MAX_CHARS);
                } else {
                    truncated |= push_capped(&mut out, &mut used, &slide_txt, OOXML_MAX_CHARS);
                }
                if used >= OOXML_MAX_CHARS {
                    truncated = true;
                    break;
                }
            }
            Ok((out, truncated, "PowerPoint 演示文稿 (.pptx)"))
        }
        _ => Err("暂不支持该 Office 格式".into()),
    }
}

fn read_head_bytes(path: &Path, limit: usize) -> Result<Vec<u8>, String> {
    let f = std::fs::File::open(path).map_err(|e| {
        if is_perm_denied(&e) {
            "受 Windows 系统权限保护，无法读取文件内容（可尝试以管理员身份重启）".to_string()
        } else if e.raw_os_error() == Some(32) || e.raw_os_error() == Some(33) {
            "文件正被其他程序独占占用，暂时无法读取".to_string()
        } else {
            format!("无法读取文件：{e}")
        }
    })?;
    let mut buf = Vec::with_capacity(limit.min(64 * 1024));
    f.take(limit as u64)
        .read_to_end(&mut buf)
        .map_err(|e| format!("读取文件内容失败：{e}"))?;
    Ok(buf)
}

/// 统一全能只读文件预览核心（供整理文件、空间工具大文件与目录浏览共用）。
/// 支持图片 / PDF / 音视频 / Word(.docx) / Excel(.xlsx) / PPT(.pptx) / 多编码文本(UTF-8/UTF-16LE/BE/GBK) /
/// 压缩包 / 未知扩展名内容嗅探 / 二进制十六进制视图与魔数识别，且严守可执行文件只读不运行红线。
fn file_preview_core(raw: &str, max_bytes: Option<u64>, mode: Option<&str>) -> Result<Value, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("缺少文件路径".into());
    }
    if is_windows_device_path(trimmed) {
        return Err("安全限制：禁止预览系统设备路径".into());
    }
    let resolved = resolve_existing_local_path(trimmed)
        .ok_or_else(|| format!("文件不存在或已被移动：{trimmed}"))?;
    let meta = match std::fs::metadata(&resolved) {
        Ok(m) => m,
        Err(e) if is_perm_denied(&e) => {
            return Err("受 Windows 系统权限保护，无法读取该文件（可尝试以管理员身份重启）".into());
        }
        Err(e) => return Err(format!("无法访问文件：{e}")),
    };
    if meta.is_dir() {
        return Err("这是文件夹，请通过目录浏览查看".into());
    }
    if !meta.is_file() {
        return Err("该目标不是普通文件，无法预览内容".into());
    }

    let clean_resolved = strip_extended_prefix(&resolved);
    let path_str = clean_resolved.to_string_lossy().to_string();
    if is_windows_device_path(&path_str) {
        return Err("安全限制：禁止预览系统设备路径".into());
    }
    let name = clean_resolved
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path_str.clone());
    let ext = path_ext_lower(&resolved);
    let size = meta.len();
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let is_exec = is_exec_path(&resolved);
    let is_archive = is_archive_path_local(&resolved);
    let want_mode = mode.unwrap_or("auto").trim().to_ascii_lowercase();
    let text_cap = max_bytes
        .unwrap_or(FILE_PREVIEW_TEXT_DEFAULT)
        .clamp(4096, FILE_PREVIEW_TEXT_MAX) as usize;
    let hex_cap = max_bytes
        .map(|v| (v as usize).clamp(1024, FILE_PREVIEW_HEX_MAX))
        .unwrap_or(FILE_PREVIEW_HEX_DEFAULT);

    if size == 0 {
        return Ok(json!({
            "path": path_str,
            "name": name,
            "ext": ext,
            "size": 0,
            "mtime": mtime,
            "kind": "empty",
            "mime": "text/plain",
            "encoding": "",
            "text": "",
            "truncated": false,
            "isExec": is_exec,
            "isArchive": is_archive,
            "canHex": false,
            "canText": false,
            "magic": "",
            "note": "空文件（0 字节），暂无内容"
        }));
    }

    if want_mode == "hex" {
        let buf = read_head_bytes(&resolved, hex_cap)?;
        let magic = detect_magic_label(&buf);
        let truncated = size > buf.len() as u64;
        return Ok(json!({
            "path": path_str,
            "name": name,
            "ext": ext,
            "size": size,
            "mtime": mtime,
            "kind": "hex",
            "mime": "application/octet-stream",
            "encoding": "hex",
            "text": format_hex_dump(&buf),
            "truncated": truncated,
            "isExec": is_exec,
            "isArchive": is_archive,
            "canHex": true,
            "canText": is_probably_text_bytes(&buf),
            "magic": magic,
            "note": format!("{magic} · 十六进制只读预览（前 {} 字节）", buf.len())
        }));
    }

    if is_archive && want_mode != "text" {
        return Ok(json!({
            "path": path_str,
            "name": name,
            "ext": ext,
            "size": size,
            "mtime": mtime,
            "kind": "archive",
            "mime": "application/x-archive",
            "encoding": "",
            "text": "",
            "truncated": false,
            "isExec": false,
            "isArchive": true,
            "canHex": true,
            "canText": false,
            "magic": "压缩包",
            "note": "压缩包文件，可直接跳转至「压缩包」页浏览、预览或解压内部文件"
        }));
    }

    if is_image_preview_ext(&ext) && want_mode != "text" {
        return Ok(json!({
            "path": path_str,
            "name": name,
            "ext": ext,
            "size": size,
            "mtime": mtime,
            "kind": "image",
            "mime": preview_mime_of(&ext),
            "encoding": "",
            "text": "",
            "truncated": false,
            "isExec": false,
            "isArchive": false,
            "canHex": true,
            "canText": ext == "svg",
            "magic": "",
            "note": ""
        }));
    }

    if ext == "pdf" && want_mode != "text" {
        return Ok(json!({
            "path": path_str,
            "name": name,
            "ext": ext,
            "size": size,
            "mtime": mtime,
            "kind": "pdf",
            "mime": "application/pdf",
            "encoding": "",
            "text": "",
            "truncated": false,
            "isExec": false,
            "isArchive": false,
            "canHex": true,
            "canText": false,
            "magic": "PDF 文档",
            "note": ""
        }));
    }

    if is_video_preview_ext(&ext) && want_mode != "text" {
        return Ok(json!({
            "path": path_str,
            "name": name,
            "ext": ext,
            "size": size,
            "mtime": mtime,
            "kind": "video",
            "mime": preview_mime_of(&ext),
            "encoding": "",
            "text": "",
            "truncated": false,
            "isExec": false,
            "isArchive": false,
            "canHex": true,
            "canText": false,
            "magic": "",
            "note": ""
        }));
    }

    if is_audio_preview_ext(&ext) && want_mode != "text" {
        return Ok(json!({
            "path": path_str,
            "name": name,
            "ext": ext,
            "size": size,
            "mtime": mtime,
            "kind": "audio",
            "mime": preview_mime_of(&ext),
            "encoding": "",
            "text": "",
            "truncated": false,
            "isExec": false,
            "isArchive": false,
            "canHex": true,
            "canText": false,
            "magic": "",
            "note": ""
        }));
    }

    if matches!(ext.as_str(), "docx" | "xlsx" | "pptx") && want_mode != "text" {
        match extract_ooxml_preview(&resolved, &ext) {
            Ok((text, truncated, label)) => {
                return Ok(json!({
                    "path": path_str,
                    "name": name,
                    "ext": ext,
                    "size": size,
                    "mtime": mtime,
                    "kind": "office",
                    "mime": preview_mime_of(&ext),
                    "encoding": "utf-8",
                    "text": text,
                    "truncated": truncated,
                    "isExec": false,
                    "isArchive": false,
                    "canHex": true,
                    "canText": false,
                    "magic": label,
                    "note": if truncated { format!("{label} · 内容较长，已截取前段正文供快速预览") } else { format!("{label} · 已提取纯文本正文") }
                }));
            }
            Err(why) => {
                return Ok(json!({
                    "path": path_str,
                    "name": name,
                    "ext": ext,
                    "size": size,
                    "mtime": mtime,
                    "kind": "unsupported",
                    "mime": preview_mime_of(&ext),
                    "encoding": "",
                    "text": "",
                    "truncated": false,
                    "isExec": false,
                    "isArchive": false,
                    "canHex": true,
                    "canText": false,
                    "magic": "Office 文档",
                    "note": why
                }));
            }
        }
    }

    // 老版 .doc / .xls / .ppt：先嗅探（很多导出 .xls 实为 HTML/TSV 文本，可以直接看！）
    if matches!(ext.as_str(), "doc" | "xls" | "ppt") && want_mode != "text" {
        let sniff = read_head_bytes(&resolved, FILE_PREVIEW_SNIFF_BYTES)?;
        if is_probably_text_bytes(&sniff) {
            let buf = if size > sniff.len() as u64 {
                read_head_bytes(&resolved, text_cap)?
            } else {
                sniff
            };
            let truncated = size > buf.len() as u64;
            let (enc, text) = decode_preview_text(&buf, truncated);
            return Ok(json!({
                "path": path_str,
                "name": name,
                "ext": ext,
                "size": size,
                "mtime": mtime,
                "kind": "text",
                "mime": "text/plain",
                "encoding": enc,
                "text": text,
                "truncated": truncated,
                "isExec": false,
                "isArchive": false,
                "canHex": true,
                "canText": true,
                "magic": "文本型导出文档",
                "note": "检测到该文件实际为可读文本内容，已自动解码预览"
            }));
        }
        return Ok(json!({
            "path": path_str,
            "name": name,
            "ext": ext,
            "size": size,
            "mtime": mtime,
            "kind": "unsupported",
            "mime": "application/octet-stream",
            "encoding": "",
            "text": "",
            "truncated": false,
            "isExec": false,
            "isArchive": false,
            "canHex": true,
            "canText": false,
            "magic": detect_magic_label(&sniff),
            "note": "旧版二进制 Office 格式（.doc / .xls / .ppt）暂不支持内嵌正文提取，可点击「用默认程序打开」或切换「十六进制」查看"
        }));
    }

    if is_text_preview_ext(&ext) || is_known_text_filename(&name) || want_mode == "text" {
        let buf = read_head_bytes(&resolved, text_cap)?;
        let truncated = size > buf.len() as u64;
        let (enc, text) = decode_preview_text(&buf, truncated);
        return Ok(json!({
            "path": path_str,
            "name": name,
            "ext": ext,
            "size": size,
            "mtime": mtime,
            "kind": "text",
            "mime": "text/plain",
            "encoding": enc,
            "text": text,
            "truncated": truncated,
            "isExec": is_exec,
            "isArchive": false,
            "canHex": true,
            "canText": true,
            "magic": "",
            "note": if is_exec {
                "安全保护：脚本/可执行文件仅支持软件内只读查看源码，禁止直接运行"
            } else if truncated {
                "文件较大，已从开头截取前段内容预览"
            } else {
                ""
            }
        }));
    }

    // 未知/无扩展名文件：先 64 KiB 嗅探，能当文本读就按文本解，否则展示十六进制 + 文件魔数识别
    let sniff = read_head_bytes(&resolved, FILE_PREVIEW_SNIFF_BYTES)?;
    if is_probably_text_bytes(&sniff) {
        let buf = if size > sniff.len() as u64 {
            read_head_bytes(&resolved, text_cap)?
        } else {
            sniff
        };
        let truncated = size > buf.len() as u64;
        let (enc, text) = decode_preview_text(&buf, truncated);
        return Ok(json!({
            "path": path_str,
            "name": name,
            "ext": ext,
            "size": size,
            "mtime": mtime,
            "kind": "text",
            "mime": "text/plain",
            "encoding": enc,
            "text": text,
            "truncated": truncated,
            "isExec": is_exec,
            "isArchive": false,
            "canHex": true,
            "canText": true,
            "magic": "",
            "note": if truncated { "自动识别为文本文件 · 内容较长已截断" } else { "自动识别为可读文本文件" }
        }));
    }

    let hex_slice = &sniff[..sniff.len().min(hex_cap)];
    let magic = detect_magic_label(&sniff);
    let truncated = size > hex_slice.len() as u64;
    Ok(json!({
        "path": path_str,
        "name": name,
        "ext": ext,
        "size": size,
        "mtime": mtime,
        "kind": "hex",
        "mime": "application/octet-stream",
        "encoding": "hex",
        "text": format_hex_dump(hex_slice),
        "truncated": truncated,
        "isExec": is_exec,
        "isArchive": false,
        "canHex": true,
        "canText": false,
        "magic": magic,
        "note": if is_exec {
            format!("{magic} · 可执行文件禁止直接运行，以下为只读十六进制预览")
        } else {
            format!("{magic} · 暂不支持富文本渲染，以下为只读十六进制预览（前 {} 字节）", hex_slice.len())
        }
    }))
}

#[tauri::command(async)]
fn file_preview(path: String, max_bytes: Option<u64>, mode: Option<String>) -> Result<Value, String> {
    file_preview_core(&path, max_bytes, mode.as_deref())
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
/// 整盘递归没有天然终点：D:\ 上 20 万个文件只是个开头，慢盘、机械盘还会更久。
/// 以前这里是「一直数到完」，于是调用方只能靠 8 秒超时把它掐死 ——
/// 用户看到的就是「超时，没拿到数据」。现在给遍历一个时间预算，
/// 到点就停，并把「只数到这儿」一起交回，让上层能说「这是部分结果」。
const WALK_BUDGET_MS: u64 = 20_000;

/// 遍历进度：每 128 项看一次表，不必每读一个文件就调一次 Instant::now。
struct WalkStat {
    deadline: Instant,
    seen: u64,
    expired: bool,
}

impl WalkStat {
    fn new(budget_ms: u64) -> Self {
        Self {
            deadline: Instant::now() + Duration::from_millis(budget_ms),
            seen: 0,
            expired: false,
        }
    }
    /// 记一项；返回 true 表示预算已用完
    fn tick(&mut self) -> bool {
        self.seen += 1;
        if !self.expired && self.seen % 128 == 0 && Instant::now() >= self.deadline {
            self.expired = true;
        }
        self.expired
    }
}

fn walk_files<F: FnMut(&std::path::Path, u64, u64)>(
    dir: &std::path::Path,
    depth: usize,
    st: &mut WalkStat,
    f: &mut F,
) {
    if depth > WALK_MAX_DEPTH || st.tick() {
        return;
    }
    let rd = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    for ent in rd.flatten() {
        if st.tick() {
            return;
        }
        let path = ent.path();
        let md = match std::fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if is_reparse_point(&path) || md.file_type().is_symlink() {
            continue;
        }
        if md.is_dir() {
            walk_files(&path, depth + 1, st, f);
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

/// 大文件排行。返回对象而不是裸数组：调用方需要知道
/// 「一共看了多少项、是不是按时限提前收手」——部分结果不等于全盘结论。
#[tauri::command(async)]
fn top_files(dir: String, limit: usize) -> Result<Value, String> {
    let root = std::path::PathBuf::from(&dir);
    if !root.is_dir() {
        return Err(format!("目录不存在：{dir}"));
    }
    let t0 = Instant::now();
    let mut st = WalkStat::new(WALK_BUDGET_MS);
    let mut items: Vec<(u64, std::path::PathBuf, u64)> = Vec::new();
    walk_files(&root, 0, &mut st, &mut |p, size, mtime| {
        items.push((size, p.to_path_buf(), mtime));
    });
    items.sort_by(|a, b| b.0.cmp(&a.0));
    let limit = limit.clamp(10, 500);
    let found = items.len();
    let list: Vec<Value> = items
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
        .collect();
    Ok(json!({
        "dir": dir,
        "items": list,
        "scanned": st.seen,
        "found": found,
        /* partial=true：预算用完提前收手，只扫了一部分目录 */
        "partial": st.expired,
        "elapsed_ms": t0.elapsed().as_millis() as u64,
        "budget_ms": WALK_BUDGET_MS,
    }))
}

/// 取文件/文件夹的真实来源：版本信息里的公司、产品，以及 Authenticode 签名状态。
/// 一次 PowerShell 批量问，最多 80 个，避免逐个进程把界面拖住。
const SIG_SCRIPT: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::InputEncoding = [System.Text.Encoding]::UTF8 } catch {}
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
    // 并发排空 stdout，根治批量 80 个路径输出 >4KB 时触发 Windows 匿名管道满写死锁
    let stdout_handle = child.stdout.take().map(|mut so| {
        std::thread::spawn(move || {
            let mut buf = String::new();
            let _ = so.read_to_string(&mut buf);
            buf
        })
    });
    // 最多等 25 秒，PowerShell 卡住就杀掉并回收句柄，别把界面吊死。
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if started.elapsed() > Duration::from_secs(25) {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("读取签名超时".into());
                }
                std::thread::sleep(Duration::from_millis(80));
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(e.to_string());
            }
        }
    }
    let text = stdout_handle
        .and_then(|h| h.join().ok())
        .unwrap_or_default();
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
    st: &mut WalkStat,
    out: &mut Vec<Value>,
) {
    if depth > max_depth || st.tick() {
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
        if st.tick() {
            return;
        }
        if let Ok(md) = std::fs::symlink_metadata(&p) {
            if md.is_dir() && !is_reparse_point(&p) && !md.file_type().is_symlink() {
                scan_empty_rec(root, &p, depth + 1, max_depth, st, out);
            }
        }
    }
}

/// 空文件夹扫描。和 top_files 一样：整盘递归可能几百万个目录，
/// 以前只能靠上层 8 秒超时掐断，结果就是「什么都没拿到」。
/// 现在到时见好就收，把 partial 一起交回去。
#[tauri::command(async)]
fn scan_empty_dirs(dir: String, max: usize, depth: Option<usize>) -> Result<Value, String> {
    let root = std::path::PathBuf::from(&dir);
    if !root.is_dir() {
        return Err(format!("目录不存在：{dir}"));
    }
    let t0 = Instant::now();
    // 用户要的就是「1–3 层够判断」，默认 3，最多 4。
    let depth = depth.unwrap_or(3).clamp(1, 4);
    let mut st = WalkStat::new(WALK_BUDGET_MS);
    let mut out: Vec<Value> = Vec::new();
    scan_empty_rec(&root, &root, 0, depth, &mut st, &mut out);
    let max = max.clamp(20, 5000);
    // 可删的排前面（浅的优先），受保护的排后面。
    out.sort_by_key(|v| {
        let kind = v.get("kind").and_then(|k| k.as_str()).unwrap_or("empty");
        let depth = v.get("depth").and_then(|d| d.as_u64()).unwrap_or(0);
        (if kind == "empty" { 0 } else { 1 }, depth)
    });
    let found = out.len();
    out.truncate(max);
    Ok(json!({
        "dir": dir,
        "items": out,
        "depth": depth,
        "scanned": st.seen,
        "found": found,
        /* partial=true：预算用完提前收手，不保证扫全 */
        "partial": st.expired,
        "elapsed_ms": t0.elapsed().as_millis() as u64,
        "budget_ms": WALK_BUDGET_MS,
    }))
}

/// 空目录清理的安全闸：盘符根、系统树、程序目录、数据目录，以及用户主目录/常用个人目录本体一律不动
/// （注意：桌面/下载/文档等目录下的普通空子目录允许正常清理，不再被 USERPROFILE 前缀误伤）。
fn empty_dir_denied(path: &Path) -> Option<&'static str> {
    let s = path.to_string_lossy().replace('/', "\\");
    let low = s.trim_end_matches('\\').to_lowercase();
    if low.len() <= 3 {
        return Some("盘符根目录");
    }
    if path.parent().is_none() {
        return Some("盘符根目录");
    }
    // 整棵树保护（本身及任何子目录均禁止清理）
    let mut tree_roots: Vec<String> = Vec::new();
    for k in ["SystemRoot", "WINDIR", "ProgramFiles", "ProgramFiles(x86)", "ProgramData", "PUBLIC"] {
        if let Ok(v) = std::env::var(k) {
            if !v.is_empty() {
                tree_roots.push(v.replace('/', "\\").trim_end_matches('\\').to_lowercase());
            }
        }
    }
    let dd = normalize_path_str(&data_dir().to_string_lossy()).to_lowercase();
    if !dd.is_empty() {
        if low == dd || low.starts_with(&(dd.clone() + "\\")) {
            return Some("轻盘自身数据目录");
        }
        if dd.starts_with(&(low.clone() + "\\")) {
            return Some("包含轻盘数据目录的上级目录");
        }
    }
    let ed = normalize_path_str(&exe_dir().to_string_lossy()).to_lowercase();
    if !ed.is_empty() {
        if low == ed || low.starts_with(&(ed.clone() + "\\")) {
            return Some("轻盘程序目录");
        }
        if ed.starts_with(&(low.clone() + "\\")) {
            return Some("包含轻盘程序目录的上级目录");
        }
    }
    // 任意盘符下的系统保留顶层目录（回收站 / 卷信息 / 恢复分区）
    let mut seg_iter = low.split('\\').filter(|x| !x.is_empty());
    let _drv = seg_iter.next();
    if let Some(top) = seg_iter.next() {
        if matches!(top, "$recycle.bin" | "system volume information" | "recovery") {
            return Some("系统保留目录");
        }
    }
    for r in tree_roots {
        if low == r || low.starts_with(&(r.clone() + "\\")) {
            return Some("受保护的系统或程序目录");
        }
    }
    if low.contains("\\windows\\") || low.ends_with("\\windows") {
        return Some("Windows 目录");
    }
    // 仅保护目录本体（不拦截其下用户自己建的空子文件夹）
    let mut self_only: Vec<String> = Vec::new();
    let sys_drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into());
    self_only.push(format!("{}\\users", sys_drive.trim_end_matches(['\\', '/']).to_lowercase()));
    for k in ["USERPROFILE", "OneDrive", "OneDriveConsumer", "OneDriveCommercial"] {
        if let Ok(v) = std::env::var(k) {
            let base = v.replace('/', "\\").trim_end_matches('\\').to_lowercase();
            if base.is_empty() {
                continue;
            }
            self_only.push(base.clone());
            for sh in ["desktop", "documents", "downloads", "pictures", "videos", "music", "appdata", "onedrive", "桌面", "文档", "下载", "图片"] {
                self_only.push(format!("{base}\\{sh}"));
            }
        }
    }
    if self_only.iter().any(|r| low == *r) {
        return Some("受保护的用户关键目录");
    }
    None
}

fn is_reparse_point(path: &Path) -> bool {
    match std::fs::symlink_metadata(path) {
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

fn strip_extended_prefix(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        p.to_path_buf()
    }
}

#[tauri::command(async)]
fn remove_empty_dirs(paths: Vec<String>) -> Result<Value, String> {
    let mut removed = 0usize;
    let mut failed: Vec<Value> = Vec::new();
    for p in paths {
        let path = std::path::PathBuf::from(&p);
        if is_reparse_point(&path) {
            failed.push(json!({ "path": p, "why": "拒绝删除符号链接或目录联接" }));
            continue;
        }
        // 先规范化真实路径再过安全闸，防止通过 `..` 绕过系统目录检查
        let check_path = std::fs::canonicalize(&path)
            .map(|c| strip_extended_prefix(&c))
            .unwrap_or_else(|_| path.clone());
        if let Some(why) = empty_dir_denied(&check_path).or_else(|| empty_dir_risky(&check_path)) {
            failed.push(json!({ "path": p, "why": why }));
            continue;
        }
        let is_empty = std::fs::read_dir(&check_path)
            .map(|mut r| r.next().is_none())
            .unwrap_or(false);
        if !is_empty {
            failed.push(json!({ "path": p, "why": "目录不为空或不存在" }));
            continue;
        }
        match std::fs::remove_dir(&check_path) {
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
            // 先写进程+序号唯一临时文件再原子替换：并发写入不撞车，中途崩溃不留半截会话
            write_file_atomic(&dir.join(&n), body.as_bytes())
                .map_err(|e| format!("写入失败：{e}"))?;
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
///
/// `offset` 是分页起点（默认 0）。加它是因为原来的实现把「目录」截满 cap 之后
/// 才轮到文件：一个装了 300 个子目录的文件夹，文件永远显示不出来，而且界面
/// 只能看到 `truncated: true` 却没地方翻页 —— 用户会以为「里面就这些」。
/// 现在先拼成一条「目录在前、文件在后」的序列，再按 offset/cap 切，能一页页翻完。
/// `offset` 是分页起点（默认 0）；`locate` 可指定要定位的文件/子目录名或完整路径，
/// 当 `offset` 未显式指定时自动计算目标所在页并返回 `located` / `locateIndex`；
/// `filter` 可在全量目录项上做不区分大小写子串过滤，突破单页 200 项限制。
#[tauri::command(async)]
fn list_dir(
    dir: String,
    limit: Option<usize>,
    offset: Option<usize>,
    locate: Option<String>,
    filter: Option<String>,
) -> Result<Value, String> {
    let raw = dir.trim();
    if raw.is_empty() {
        return Err("缺少目录".into());
    }
    let mut p = PathBuf::from(raw);
    let md = match probe_path_meta(&p) {
        Ok(m) => m,
        Err(e) if is_perm_denied(&e) => {
            return Err(format!("权限不足（需要管理员权限）：{}", p.display()));
        }
        Err(_) => {
            if let Some(rescued) = resolve_existing_local_path(raw) {
                p = rescued;
                probe_path_meta(&p)
                    .map_err(|e| {
                        if is_perm_denied(&e) {
                            format!("权限不足（需要管理员权限）：{}", p.display())
                        } else {
                            format!("目录不存在：{}", p.display())
                        }
                    })?
            } else if has_permission_denied_ancestor(&p) {
                return Err(format!("权限不足（需要管理员权限）：{}", p.display()));
            } else {
                return Err(format!("目录不存在：{}", p.display()));
            }
        }
    };
    if !md.is_dir() {
        return Err(format!("这不是文件夹：{}", p.display()));
    }
    let cap = limit.unwrap_or(100).clamp(1, 200);
    let mut files: Vec<Value> = Vec::new();
    let mut dirs: Vec<Value> = Vec::new();
    let rd = std::fs::read_dir(&p).map_err(|e| {
        if is_perm_denied(&e) {
            format!("权限不足（需要管理员权限）：{}", p.display())
        } else {
            format!("无法读取目录：{e}")
        }
    })?;
    for ent in rd.flatten() {
        let name = ent.file_name().to_string_lossy().to_string();
        let meta = match ent.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
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
    let unfiltered_total = dirs.len() + files.len();

    let flt = filter
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_lowercase());
    if let Some(ref kw) = flt {
        dirs.retain(|it| it["name"].as_str().unwrap_or("").to_lowercase().contains(kw));
        files.retain(|it| it["name"].as_str().unwrap_or("").to_lowercase().contains(kw));
    }

    let dir_count = dirs.len();
    let file_count = files.len();
    let all: Vec<Value> = dirs.into_iter().chain(files.into_iter()).collect();

    // 目标定位：同时支持传完整路径或纯文件名/目录名，自动落到包含该项的那一页；
    // 若 locate 本身就是当前目录 dir，则不误高亮同名子目录。
    let dir_norm_low = trim_nonroot_sep(&p.to_string_lossy().replace('/', "\\")).to_lowercase();
    let locate_leaf = locate.as_deref().and_then(|raw_loc| {
        let s = trim_nonroot_sep(&raw_loc.trim().replace('/', "\\")).to_string();
        if s.is_empty() || s.to_lowercase() == dir_norm_low {
            return None;
        }
        let leaf = s
            .rsplit(['\\', '/'])
            .next()
            .unwrap_or(&s)
            .trim();
        (!leaf.is_empty()).then(|| leaf.to_lowercase())
    });
    let locate_idx = locate_leaf.as_ref().and_then(|want| {
        all.iter()
            .position(|it| it["name"].as_str().unwrap_or("").to_lowercase() == *want)
    });
    let locate_name = locate_idx
        .and_then(|i| all[i]["name"].as_str())
        .map(|s| s.to_string());

    let skip = match (offset, locate_idx) {
        (Some(explicit), _) => explicit,
        (None, Some(idx)) => (idx / cap) * cap,
        (None, None) => 0,
    };
    let items: Vec<Value> = all.iter().skip(skip).take(cap).cloned().collect();
    let shown = items.len();
    Ok(json!({
        "dir": p.to_string_lossy(),
        "total": dir_count + file_count,
        "unfilteredTotal": unfiltered_total,
        "offset": skip,
        "shown": shown,
        "dirs": dir_count,
        "files": file_count,
        "hasPrev": skip > 0,
        "truncated": skip + shown < dir_count + file_count,
        "located": locate_idx.is_some(),
        "locateIndex": locate_idx,
        "locateName": locate_name,
        "items": items,
    }))
}

// ---------------------------------------------------------------- agent 文件访问
// 用户明确要求「agent 能看整台电脑的文件」：这里只补只读能力（读文本、枚举磁盘），
// 写入/删除仍然只属于整理流程本身。解码顺序 UTF-8 → GBK，GBK 走系统 API，
// 不引第三方编码库（Cargo 不增加任何依赖）。

/// 一段字节 → (编码名, 文本)。UTF-16LE 认 BOM，其余先试 UTF-8，再落 GBK。
fn decode_text(bytes: &[u8]) -> (&'static str, String) {
    if bytes.starts_with(&[0xFF, 0xFE]) && bytes.len() > 2 {
        let body = &bytes[2..];
        let units: Vec<u16> = body
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        return ("utf-16le", String::from_utf16_lossy(&units));
    }
    if let Ok(s) = std::str::from_utf8(bytes) {
        return ("utf-8", s.to_string());
    }
    #[cfg(windows)]
    if let Some(s) = gbk_decode(bytes) {
        return ("gbk", s);
    }
    ("unknown", String::from_utf8_lossy(bytes).to_string())
}

/// 代码页 936 解码（Windows 自带，零新依赖）。
#[cfg(windows)]
fn gbk_decode(bytes: &[u8]) -> Option<String> {
    use std::ptr;
    use windows_sys::Win32::Globalization::MultiByteToWideChar;
    let n = unsafe {
        MultiByteToWideChar(936, 0, bytes.as_ptr(), bytes.len() as i32, ptr::null_mut(), 0)
    };
    if n <= 0 {
        return None;
    }
    let mut out = vec![0u16; n as usize];
    let got = unsafe {
        MultiByteToWideChar(936, 0, bytes.as_ptr(), bytes.len() as i32, out.as_mut_ptr(), n)
    };
    if got <= 0 {
        return None;
    }
    out.truncate(got as usize);
    Some(String::from_utf16_lossy(&out))
}

/// 把文本按 GBK 量出字节数：算下一页偏移用，避免中文按字数当字节数跳错。
#[cfg(windows)]
fn gbk_byte_len(text: &str) -> usize {
    use std::ptr;
    use windows_sys::Win32::Globalization::WideCharToMultiByte;
    let wide: Vec<u16> = text.encode_utf16().collect();
    let n = unsafe {
        WideCharToMultiByte(936, 0, wide.as_ptr(), wide.len() as i32, ptr::null_mut(), 0, ptr::null(), ptr::null_mut())
    };
    if n <= 0 {
        text.len()
    } else {
        n as usize
    }
}

/// 读一段文件内容：给 agent 的「这个文件里写了什么」。
/// 只读、有上限、可续读；二进制只回元信息，不把乱码塞进上下文。
#[tauri::command(async)]
fn agent_read(path: String, offset: Option<u64>, max_chars: Option<usize>) -> Result<Value, String> {
    let p = PathBuf::from(path.trim());
    if p.as_os_str().is_empty() {
        return Err("缺少文件路径".into());
    }
    let meta = std::fs::metadata(&p).map_err(|e| format!("打不开 {}：{e}", p.display()))?;
    if meta.is_dir() {
        return Err(format!("这是文件夹，用 list_dir 看：{}", p.display()));
    }
    let size = meta.len();
    let off = offset.unwrap_or(0).min(size);
    let want = max_chars.unwrap_or(700).clamp(50, 4000);
    let mut f = std::fs::File::open(&p).map_err(|e| format!("打不开 {}：{e}", p.display()))?;
    {
        use std::io::{Seek, SeekFrom};
        f.seek(SeekFrom::Start(off)).map_err(|e| e.to_string())?;
    }
    let mut buf = vec![0u8; 8192];
    let n = f.read(&mut buf).map_err(|e| e.to_string())?;
    if n == 0 {
        return Ok(json!({ "path": p.to_string_lossy(), "size": size, "eof": true, "text": "" }));
    }
    buf.truncate(n);
    let nul = buf.iter().filter(|b| **b == 0).count();
    if nul > buf.len() / 8 && !buf.starts_with(&[0xFF, 0xFE]) {
        return Ok(json!({
            "path": p.to_string_lossy(),
            "size": size,
            "kind": "binary",
            "text": ""
        }));
    }
    let (enc, text) = decode_text(&buf);
    let total_chars = text.chars().count();
    let cut: String = text.chars().take(want).collect();
    let mut next: Option<u64> = None;
    if total_chars > want {
        let consumed = match enc {
            "utf-8" => cut.len(),
            "gbk" => gbk_byte_len(&cut),
            "utf-16le" => cut.encode_utf16().count() * 2 + 2,
            _ => cut.len(),
        };
        next = Some(off + consumed as u64);
    } else if (off + n as u64) < size {
        next = Some(off + n as u64);
    }
    Ok(json!({
        "path": p.to_string_lossy(),
        "size": size,
        "encoding": enc,
        "text": cut,
        "next_offset": next,
        "eof": next.is_none(),
    }))
}

/// 枚举本机磁盘根 + 用户主目录，给 agent 一个「从哪儿看起」的起点。
#[tauri::command]
fn agent_roots() -> Value {
    let mut roots: Vec<String> = Vec::new();
    for c in b'A'..=b'Z' {
        let root = format!("{}:\\", c as char);
        if Path::new(&root).exists() {
            roots.push(root);
        }
    }
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    json!({ "roots": roots, "home": home })
}

/// 解析 http(s) 地址：返回 (是否 https, host, port, path+query)；支持 IPv6 字面量并拦截控制字符。
fn split_url(url: &str) -> Result<(bool, String, u16, String), String> {
    if url
        .chars()
        .any(|c| c.is_whitespace() || (c as u32) < 0x20 || c == '\u{7f}')
    {
        return Err("地址包含非法空白或控制字符".into());
    }
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
    let default_port = if secure { 443 } else { 80 };
    let (host, port) = if let Some(after_open) = authority.strip_prefix('[') {
        let Some(close) = after_open.find(']') else {
            return Err("IPv6 地址缺少闭合括号".into());
        };
        let h = &after_open[..close];
        if h.is_empty() {
            return Err("地址缺少主机名".into());
        }
        let rem = &after_open[close + 1..];
        let pt = if rem.is_empty() {
            default_port
        } else if let Some(pstr) = rem.strip_prefix(':') {
            if pstr.is_empty() || !pstr.chars().all(|c| c.is_ascii_digit()) {
                return Err("端口不合法".into());
            }
            pstr.parse::<u16>().map_err(|_| "端口不合法".to_string())?
        } else {
            return Err("IPv6 地址格式不合法".into());
        };
        (h.to_string(), pt)
    } else {
        match authority.rsplit_once(':') {
            Some((h, pt))
                if !h.is_empty() && !pt.is_empty() && pt.chars().all(|c| c.is_ascii_digit()) =>
            {
                (
                    h.to_string(),
                    pt.parse::<u16>().map_err(|_| "端口不合法".to_string())?,
                )
            }
            _ => (authority.to_string(), default_port),
        }
    };
    let path = if tail.starts_with('/') {
        tail.to_string()
    } else {
        format!("/{tail}")
    };
    Ok((secure, host, port, path))
}

fn is_local_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost") || host.starts_with("127.") || host == "::1"
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
    start_epoch: u64,
) -> Result<(u32, String), String> {
    use std::ffi::c_void;
    use std::ptr;
    use windows_sys::Win32::Networking::WinHttp::{
        WinHttpCloseHandle, WinHttpConnect, WinHttpOpen, WinHttpOpenRequest, WinHttpQueryDataAvailable,
        WinHttpQueryHeaders, WinHttpReadData, WinHttpReceiveResponse, WinHttpSendRequest,
        WinHttpSetTimeouts, WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, WINHTTP_ACCESS_TYPE_NO_PROXY,
        WINHTTP_FLAG_SECURE, WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_QUERY_STATUS_CODE,
    };

    let cancelled = || AI_CANCEL_EPOCH.load(Ordering::SeqCst) != start_epoch;
    if cancelled() {
        return Err("已取消".into());
    }
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
    // 本地端点走直连，避免系统代理把 127.0.0.1 / ::1 也劫走
    let local = is_local_host(&host);
    let access = if local {
        WINHTTP_ACCESS_TYPE_NO_PROXY
    } else {
        WINHTTP_ACCESS_TYPE_DEFAULT_PROXY
    };

    unsafe {
        if cancelled() {
            return Err("已取消".into());
        }
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
            let req_guard = AiRequestGuard::register(request);
            let inner = (|| -> Result<(u32, String), String> {
                // 登记后立刻复核一次代次，消除 start_epoch 采样到登记之间的取消竞态
                if cancelled() {
                    return Err("已取消".into());
                }
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
                    if cancelled() {
                        return Err("已取消".into());
                    }
                    return Err("请求发送失败（地址或代理不可达）".into());
                }
                if cancelled() {
                    return Err("已取消".into());
                }
                if WinHttpReceiveResponse(request, ptr::null_mut()) == 0 {
                    if cancelled() {
                        return Err("已取消".into());
                    }
                    return Err("服务器无响应".into());
                }
                if cancelled() {
                    return Err("已取消".into());
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
                    if cancelled() {
                        return Err("已取消".into());
                    }
                    let mut available: u32 = 0;
                    if WinHttpQueryDataAvailable(request, &mut available) == 0 {
                        if cancelled() {
                            return Err("已取消".into());
                        }
                        return Err("读取响应失败".into());
                    }
                    if available == 0 {
                        break;
                    }
                    let want = available.min(buf.len() as u32);
                    let mut got: u32 = 0;
                    if WinHttpReadData(request, buf.as_mut_ptr() as *mut c_void, want, &mut got) == 0 {
                        if cancelled() {
                            return Err("已取消".into());
                        }
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
            // 必须先释放/注销 request 句柄，再关父级 connect 句柄
            drop(req_guard);
            WinHttpCloseHandle(connect);
            inner
        })();
        WinHttpCloseHandle(session);
        out
    }
}

/// AI 请求的取消代次（单调递增）与在飞 WinHTTP 请求句柄表。
/// 用代次替代单个布尔旗标，避免「旧请求取消后立刻发新请求」时把旧请求的取消信号冲掉；
/// 配合句柄表，ai_cancel() 会跨线程直接关闭在飞的 HINTERNET 请求句柄，
/// 让阻塞在 SendRequest / ReceiveResponse / QueryDataAvailable / ReadData 的线程在 <1ms 内立刻返回。
static AI_CANCEL_EPOCH: AtomicU64 = AtomicU64::new(0);
#[cfg(windows)]
static AI_REQ_SEQ: AtomicU64 = AtomicU64::new(1);
#[cfg(windows)]
static ACTIVE_AI_HANDLES: Mutex<Vec<(u64, usize)>> = Mutex::new(Vec::new());

/// RAII 守卫：保证每个 WinHTTP 请求句柄被精确关闭一次（要么由 ai_cancel() 主动关闭打断阻塞，
/// 要么在请求正常退出时由 Drop 关闭），彻底杜绝双重关闭或悬空句柄。
#[cfg(windows)]
struct AiRequestGuard {
    req_id: u64,
    handle: *mut std::ffi::c_void,
}

#[cfg(windows)]
impl AiRequestGuard {
    fn register(handle: *mut std::ffi::c_void) -> Self {
        let req_id = AI_REQ_SEQ.fetch_add(1, Ordering::SeqCst);
        let mut g = ACTIVE_AI_HANDLES.lock().unwrap_or_else(|e| e.into_inner());
        g.push((req_id, handle as usize));
        Self { req_id, handle }
    }
}

#[cfg(windows)]
impl Drop for AiRequestGuard {
    fn drop(&mut self) {
        let still_owned = {
            let mut g = ACTIVE_AI_HANDLES.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(pos) = g.iter().position(|(id, _)| *id == self.req_id) {
                g.swap_remove(pos);
                true
            } else {
                false
            }
        };
        if still_owned && !self.handle.is_null() {
            unsafe {
                windows_sys::Win32::Networking::WinHttp::WinHttpCloseHandle(self.handle);
            }
        }
    }
}

/// 立即中止所有在飞的 AI WinHTTP 请求：在锁外关闭句柄，避免阻塞或死锁。
#[cfg(windows)]
fn abort_active_ai_handles() {
    let handles: Vec<(u64, usize)> = {
        let mut g = ACTIVE_AI_HANDLES.lock().unwrap_or_else(|e| e.into_inner());
        std::mem::take(&mut *g)
    };
    for (_, raw) in handles {
        if raw != 0 {
            unsafe {
                windows_sys::Win32::Networking::WinHttp::WinHttpCloseHandle(
                    raw as *mut std::ffi::c_void,
                );
            }
        }
    }
}

/// 页面主动停止：推进取消代次并立刻关闭在飞 WinHTTP 请求句柄，毫秒级中止阻塞连接。
#[tauri::command]
fn ai_cancel() -> bool {
    AI_CANCEL_EPOCH.fetch_add(1, Ordering::SeqCst);
    #[cfg(windows)]
    abort_active_ai_handles();
    true
}

/// 网络出口：唯一的对外请求命令。任何模型端点都走这里。
/// 入参 {url, headers?:{k:v}, body, timeout_ms?, method?:'POST'|'GET'}，出参 {status, body, elapsed_ms}
#[tauri::command(async)]
fn ai_http(req: Value) -> Result<Value, String> {
    let start_epoch = AI_CANCEL_EPOCH.load(Ordering::SeqCst);
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
                let kt = k.trim();
                // 拦截换行/空字节/非法键名，防 WinHTTP 头注入与字符串截断
                if kt.is_empty()
                    || kt.contains(':')
                    || kt.chars().any(|c| c.is_whitespace() || (c as u32) < 0x20 || c == '\u{7f}')
                    || val.chars().any(|c| c == '\r' || c == '\n' || c == '\0')
                {
                    return Err("请求头包含非法字符".into());
                }
                if let Some(slot) = headers.iter_mut().find(|(ek, _)| ek.eq_ignore_ascii_case(kt)) {
                    slot.1 = val.to_string();
                } else {
                    headers.push((kt.to_string(), val.to_string()));
                }
            }
        }
    }
    let started = Instant::now();
    let (status, text) = http_post(&url, &headers, &body, timeout, &method, start_epoch)?;
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
    start_epoch: u64,
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

    let cancelled = || AI_CANCEL_EPOCH.load(Ordering::SeqCst) != start_epoch;
    if cancelled() {
        return Err("已取消".into());
    }
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
    let local = is_local_host(&host);
    let access = if local {
        WINHTTP_ACCESS_TYPE_NO_PROXY
    } else {
        WINHTTP_ACCESS_TYPE_DEFAULT_PROXY
    };

    unsafe {
        if cancelled() {
            return Err("已取消".into());
        }
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
            let req_guard = AiRequestGuard::register(request);
            let inner = (|| -> Result<(u32, String), String> {
                if cancelled() {
                    return Err("已取消".into());
                }
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
                    if cancelled() {
                        return Err("已取消".into());
                    }
                    return Err("请求发送失败（地址或代理不可达）".into());
                }
                if cancelled() {
                    return Err("已取消".into());
                }
                if WinHttpReceiveResponse(request, ptr::null_mut()) == 0 {
                    if cancelled() {
                        return Err("已取消".into());
                    }
                    return Err("服务器无响应".into());
                }
                if cancelled() {
                    return Err("已取消".into());
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
                    // 页面点了停止：立刻停读。已经推出去的分片页面会丢弃
                    if cancelled() {
                        return Err("已取消".into());
                    }
                    let mut available: u32 = 0;
                    if WinHttpQueryDataAvailable(request, &mut available) == 0 {
                        if cancelled() {
                            return Err("已取消".into());
                        }
                        return Err("读取响应失败".into());
                    }
                    if available == 0 {
                        break;
                    }
                    let want = available.min(buf.len() as u32);
                    let mut got: u32 = 0;
                    if WinHttpReadData(request, buf.as_mut_ptr() as *mut c_void, want, &mut got) == 0 {
                        if cancelled() {
                            return Err("已取消".into());
                        }
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
                        if cancelled() {
                            return Err("已取消".into());
                        }
                        // valid 前缀一定是合法 UTF-8，from_utf8_lossy 这里不会替换任何字符
                        on_chunk(&String::from_utf8_lossy(&tail[..valid]));
                        emitted += valid;
                    }
                }
                Ok((status, String::from_utf8_lossy(&body_out).to_string()))
            })();
            drop(req_guard);
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
    let start_epoch = AI_CANCEL_EPOCH.load(Ordering::SeqCst);
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
                let kt = k.trim();
                if kt.is_empty()
                    || kt.contains(':')
                    || kt.chars().any(|c| c.is_whitespace() || (c as u32) < 0x20 || c == '\u{7f}')
                    || val.chars().any(|c| c == '\r' || c == '\n' || c == '\0')
                {
                    return Err("请求头包含非法字符".into());
                }
                if let Some(slot) = headers.iter_mut().find(|(ek, _)| ek.eq_ignore_ascii_case(kt)) {
                    slot.1 = val.to_string();
                } else {
                    headers.push((kt.to_string(), val.to_string()));
                }
            }
        }
    }
    let started = Instant::now();
    let (status, text) = http_post_cb(
        &url,
        &headers,
        &body,
        timeout,
        &method,
        start_epoch,
        &mut |piece| {
            // 页面关掉或切走的瞬间送不出去，属于正常情况，不打断读取
            let _ = on_chunk.send(piece.to_string());
        },
    )?;
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
    let script = "try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}; Get-AppxPackage | Where-Object { -not $_.IsFramework -and -not $_.NonRemovable } | Select-Object Name,Version,Publisher,InstallLocation,PackageFullName,PackageFamilyName | ConvertTo-Json -Compress -Depth 3";
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
        let path_str = it.get("InstallLocation").and_then(|x| x.as_str()).unwrap_or("");
        let mut date_ts = 0.0;
        if !path_str.is_empty() {
            if let Ok(meta) = std::fs::metadata(path_str) {
                if let Ok(time) = meta.created().or_else(|_| meta.modified()) {
                    if let Ok(dur) = time.duration_since(std::time::UNIX_EPOCH) {
                        date_ts = dur.as_secs_f64();
                    }
                }
            }
        }
        list.push(json!({
            "name": name,
            "version": it.get("Version").and_then(|x| x.as_str()).unwrap_or(""),
            "publisher": it.get("Publisher").and_then(|x| x.as_str()).unwrap_or(""),
            "install_path": path_str,
            "package": it.get("PackageFullName").and_then(|x| x.as_str()).unwrap_or(""),
            "source": "store",
            "uninstall": true,
            "size_kb": 0,
            "date": date_ts,
        }));
    }
    list.sort_by_key(|v| v["name"].as_str().unwrap_or("").to_lowercase());
    if let Ok(mut g) = STORE_CACHE.lock() {
        *g = Some((Instant::now(), list.clone()));
    }
    Ok(list)
}

fn validate_store_package(raw: &str) -> Result<String, String> {
    let pkg = raw.trim();
    if pkg.is_empty() || pkg.len() > 256 {
        return Err("包名无效".into());
    }
    if pkg.contains("..")
        || !pkg
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '+' | '-'))
    {
        return Err("商店包名包含非法字符".into());
    }
    Ok(pkg.to_string())
}

/// 卸载商店应用：Remove-AppxPackage（当前用户范围）。
#[tauri::command(async)]
fn remove_store_app(package: String, confirm: bool) -> Result<Value, String> {
    let package = validate_store_package(&package)?;
    if !confirm {
        return Ok(json!({ "dry_run": true, "package": package }));
    }
    let script = format!("Remove-AppxPackage -Package '{package}'");
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
                json!({ "path": folder, "confirm": true, "dry_run": false }),
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
    let restarted = std::env::args().any(|a| a == "--restarted");

    // 提权/迁移重启实例：等旧实例把单实例锁 / WebView2 profile 放掉再起，避免 0x800700AA
    if elevated {
        std::thread::sleep(std::time::Duration::from_millis(1500));
    } else if restarted {
        std::thread::sleep(std::time::Duration::from_millis(300));
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
        .manage(updater::UpdaterState::default())
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
            resolve_local_path,
            inspect_local_path,
            app_info,
            app_capabilities,
            data_dir_migrate_preview,
            data_dir_migrate,
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
            file_preview,
            top_files,
            scan_empty_dirs,
            remove_empty_dirs,
            file_signals,
            list_dir,
            ai_http,
            ai_http_stream,
            ai_cancel,
            agent_read,
            agent_roots,
            ai_store,
            history_list,
            store_apps,
            remove_store_app,
            archive::archive_open,
            archive::archive_check_extract_conflicts,
            archive::archive_check_create_conflict,
            archive::archive_extract,
            archive::archive_create,
            archive::archive_undo,
            archive::archive_undo_discard,
            archive::archive_pause,
            archive::archive_resume,
            archive::archive_cancel,
            archive::archive_preview,
            archive::archive_preview_clear,
            archive::archive_capabilities,
            archive::archive_rar_status,
            archive::archive_rar_install,
            archive::pick_archive,
            archive::pick_files,
            archive::pick_archive_save,
            updater::updater_status,
            updater::updater_config_get,
            updater::updater_config_set,
            updater::updater_check,
            updater::updater_download,
            updater::updater_cancel,
            updater::updater_clear_cache,
            updater::updater_install,
            updater::updater_changelog
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let show = MenuItem::with_id(app, "show", "打开主界面", true, None::<&str>)?;
            let tidy_dl = MenuItem::with_id(app, "tidy_downloads", "整理下载文件夹", true, None::<&str>)?;
            let open_data = MenuItem::with_id(app, "open_data", "打开数据目录", true, None::<&str>)?;
            let open_logs = MenuItem::with_id(app, "open_logs", "打开日志目录", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出轻盘", true, None::<&str>)?;
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
                .tooltip("轻盘 · QDisk")
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
            if let Some(w) = app.get_webview_window("main") {
                sync_window_taskbar_icon(&w, app.default_window_icon());
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
                                json!({ "path": folder, "confirm": true, "dry_run": false }),
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
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|handle, event| {
            if let tauri::RunEvent::Exit = event {
                handle.state::<archive::ArchiveCtx>().clear_undo();
                if let Ok(mut guard) = handle.state::<AppState>().engine.lock() {
                    if let Some(mut old) = guard.take() {
                        let _ = old.child.kill();
                        let _ = old.child.wait();
                    }
                }
            }
        });
}

#[cfg(test)]
mod shell_tests {
    use super::*;

    #[test]
    fn validate_open_target_blocks_dangerous_schemes_and_allows_recycle_bin() {
        assert_eq!(
            validate_open_target("shell:RecycleBinFolder").unwrap(),
            OpenTarget::SafeShell
        );
        assert_eq!(
            validate_open_target("SHELL:RecycleBinFolder").unwrap(),
            OpenTarget::SafeShell
        );
        assert_eq!(
            validate_open_target("https://example.com/a?x=1&y=2").unwrap(),
            OpenTarget::Url
        );
        for bad in [
            "",
            "javascript:alert(1)",
            "ms-msdt:/id PCWDiagnostic",
            "file:///C:/Windows/win.ini",
            "shell:Startup",
            "cmd:/c calc",
            "C:\\Windows\\notepad.exe\" & calc",
            "https://example.com\nX-Inject: 1",
        ] {
            assert!(
                validate_open_target(bad).is_err(),
                "危险或非法 open_path 目标必须被拒绝: {bad}"
            );
        }
    }

    #[test]
    fn validate_schedule_time_and_store_package_reject_injection() {
        assert_eq!(validate_schedule_time("03:00").unwrap(), "03:00");
        assert_eq!(validate_schedule_time("23:59").unwrap(), "23:59");
        assert_eq!(validate_schedule_time("00:00").unwrap(), "00:00");
        for bad_t in ["24:00", "03:60", "3:00", "03:00 & calc", "ab:cd", ""] {
            assert!(
                validate_schedule_time(bad_t).is_err(),
                "非法定时时间应被拒绝: {bad_t}"
            );
        }

        assert_eq!(
            validate_store_package("Microsoft.Paint_11.2302.18.0_x64__8wekyb3d8bbwe").unwrap(),
            "Microsoft.Paint_11.2302.18.0_x64__8wekyb3d8bbwe"
        );
        for bad_p in ["", "pkg'; calc; '", "pkg name", "a..b", "pkg$(calc)", "pkg|dir"] {
            assert!(
                validate_store_package(bad_p).is_err(),
                "非法商店包名应被拒绝: {bad_p}"
            );
        }
    }

    #[test]
    fn read_tail_utf8_handles_multibyte_chinese_boundary() {
        let root = std::env::temp_dir().join(format!(
            "tidy_shell_utf8_{}_{}",
            std::process::id(),
            ATOMIC_WRITE_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("zh.log");
        let mut content = String::new();
        for i in 0..300 {
            content.push_str(&format!("[2026-11-23] 第{i:03}条中文日志记录——安全稳定\n"));
        }
        std::fs::write(&file, content.as_bytes()).unwrap();
        // 连续 3 个字节偏移必命中 3 字节 UTF-8 中文字符的起始与中间续字节
        for cut in [99u64, 100u64, 101u64] {
            let tail = read_tail_utf8(&file, cut).expect("截断多字节 UTF-8 尾部绝不可报错");
            assert!(
                tail.contains("第299条中文日志记录"),
                "尾部内容缺失 (cut={cut}): {tail}"
            );
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn split_url_handles_ipv6_and_blocks_control_chars() {
        let (sec, host, port, path) = split_url("http://[::1]:11434/v1/chat?s=1").unwrap();
        assert!(!sec);
        assert_eq!(host, "::1");
        assert_eq!(port, 11434);
        assert_eq!(path, "/v1/chat?s=1");
        assert!(is_local_host(&host));
        assert!(split_url("https://api.example.com/v1\r\nX: 1").is_err());
        assert!(split_url("http://[::1").is_err());
    }

    #[test]
    fn write_file_atomic_and_app_capabilities_schema() {
        let root = std::env::temp_dir().join(format!(
            "tidy_shell_atomic_{}_{}",
            std::process::id(),
            ATOMIC_WRITE_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let target = root.join("config.json");
        write_file_atomic(&target, b"{\"v\":1}").unwrap();
        write_file_atomic(&target, b"{\"v\":2}").unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "{\"v\":2}");
        let leftover_tmp = std::fs::read_dir(&root)
            .unwrap()
            .flatten()
            .any(|e| e.file_name().to_string_lossy().ends_with(".tmp"));
        assert!(!leftover_tmp, "原子写入后不应残留 .tmp 文件");

        let caps = app_capabilities();
        assert_eq!(caps["schemaVersion"], json!(1));
        assert!(caps["cpuCores"].as_u64().unwrap_or(0) >= 1);
        assert_eq!(caps["extensions"]["pages"], json!(true));
        assert_eq!(caps["extensions"]["aiActions"], json!(true));
        assert_eq!(caps["extensions"]["engineMethods"], json!(true));
        assert_eq!(caps["extensions"]["archiveCodecs"], json!(true));
        assert_eq!(caps["archive"]["schemaVersion"], json!(1));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(windows)]
    #[test]
    fn ai_cancel_aborts_blocked_winhttp_in_milliseconds() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        use std::sync::{Arc, Barrier};

        // 场景 1：服务端接受连接后刻意沉默 10 秒（模拟推理模型卡在 WinHttpReceiveResponse），
        // ai_cancel() 必须跨线程关闭请求句柄，在 < 600ms 内返回 Err("已取消")，绝不等 10s/30s 超时。
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let accepted = Arc::new(Barrier::new(2));
        let accepted_srv = Arc::clone(&accepted);
        let srv = std::thread::spawn(move || {
            if let Ok((mut s, _)) = listener.accept() {
                let mut req_buf = [0u8; 512];
                let _ = s.read(&mut req_buf);
                accepted_srv.wait();
                std::thread::sleep(Duration::from_secs(2));
            }
        });

        let url = format!("http://127.0.0.1:{}/v1/chat/completions", addr.port());
        let start_epoch = AI_CANCEL_EPOCH.load(Ordering::SeqCst);
        let url_clone = url.clone();
        let worker = std::thread::spawn(move || {
            let mut chunks = 0usize;
            http_post_cb(
                &url_clone,
                &[("Content-Type".into(), "application/json".into())],
                "{}",
                30_000,
                "POST",
                start_epoch,
                &mut |_| {
                    chunks += 1;
                },
            )
        });

        // 等服务端真正收到请求、客户端已经阻塞在 WinHttpReceiveResponse
        accepted.wait();
        std::thread::sleep(Duration::from_millis(30));
        let cancel_at = Instant::now();
        assert!(ai_cancel());
        let res = worker.join().expect("worker 线程不应 panic");
        let abort_ms = cancel_at.elapsed().as_millis();
        assert_eq!(res, Err("已取消".to_string()), "阻塞请求应返回已取消");
        assert!(
            abort_ms < 600,
            "ai_cancel 应在毫秒级打断阻塞 WinHTTP，实际耗时 {abort_ms}ms"
        );
        {
            let g = ACTIVE_AI_HANDLES.lock().unwrap_or_else(|e| e.into_inner());
            assert!(g.is_empty(), "取消并退出后活动句柄表必须为空，无泄漏");
        }
        let _ = srv.join();

        // 场景 2：上一轮取消后立刻发起新请求，新代次必须正常收到 HTTP 200，不受旧取消影响
        let listener2 = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr2 = listener2.local_addr().unwrap();
        let srv2 = std::thread::spawn(move || {
            if let Ok((mut s, _)) = listener2.accept() {
                let mut req_buf = [0u8; 512];
                let _ = s.read(&mut req_buf);
                let _ = s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
                let _ = s.flush();
            }
        });
        let url2 = format!("http://127.0.0.1:{}/v1/chat/completions", addr2.port());
        let next_epoch = AI_CANCEL_EPOCH.load(Ordering::SeqCst);
        let ok_res = http_post(
            &url2,
            &[("Content-Type".into(), "application/json".into())],
            "{}",
            5_000,
            "POST",
            next_epoch,
        );
        let _ = srv2.join();
        assert_eq!(ok_res, Ok((200, "ok".to_string())));
    }

    #[test]
    fn resolve_existing_local_path_rescues_glued_cjk_and_preserves_real_cjk_dirs() {
        let root = std::env::temp_dir().join(format!(
            "qdisk_path_rescue_{}_{}",
            std::process::id(),
            ATOMIC_WRITE_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let downloads = root.join("Downloads");
        let work_dir = root.join("工作资料");
        let real_cjk_suffix = root.join("Temp缓存");
        let real_temp = root.join("Temp");
        let setup_exe = root.join("setup.exe");
        let zh_pdf = work_dir.join("2026年报告.pdf");
        std::fs::create_dir_all(&downloads).unwrap();
        std::fs::create_dir_all(&work_dir).unwrap();
        std::fs::create_dir_all(&real_cjk_suffix).unwrap();
        std::fs::create_dir_all(&real_temp).unwrap();
        std::fs::write(&setup_exe, b"bin").unwrap();
        std::fs::write(&zh_pdf, b"pdf").unwrap();

        // 1. ASCII 目录后粘连中文自然语言 / 全角括号 -> 精确兜底到真实目录
        let glued1 = format!("{}里的文件", downloads.display());
        assert_eq!(resolve_existing_local_path(&glued1), Some(downloads.clone()));
        let glued2 = format!("{}（约 2 GB）", downloads.display());
        assert_eq!(resolve_existing_local_path(&glued2), Some(downloads.clone()));
        let glued3 = format!("{}\\目录下", downloads.display());
        assert_eq!(resolve_existing_local_path(&glued3), Some(downloads.clone()));

        // 2. 扩展名后粘连汉字 -> 精确兜底到真实文件
        let glued_exe = format!("{}是否可删", setup_exe.display());
        assert_eq!(resolve_existing_local_path(&glued_exe), Some(setup_exe.clone()));
        let glued_pdf = format!("{}里的内容", zh_pdf.display());
        assert_eq!(resolve_existing_local_path(&glued_pdf), Some(zh_pdf.clone()));

        // 3. 中文目录后粘连自然语言 -> 精确兜底到真实中文目录
        let glued_zh = format!("{}目录下", work_dir.display());
        assert_eq!(resolve_existing_local_path(&glued_zh), Some(work_dir.clone()));

        // 4. 若带汉字后缀的目录本身真实存在，必须原样命中，绝不误切到 Temp
        let exact_cjk = real_cjk_suffix.to_string_lossy().to_string();
        assert_eq!(resolve_existing_local_path(&exact_cjk), Some(real_cjk_suffix.clone()));

        // 5. 真正不存在的子目录必须返回 None，绝不静默回退到父目录
        let missing = format!("{}\\不存在的子目录", downloads.display());
        assert_eq!(resolve_existing_local_path(&missing), None);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn inspect_local_path_distinguishes_dot_dirs_files_missing_and_drive_roots() {
        let root = std::env::temp_dir().join(format!(
            "qdisk_inspect_{}_{}",
            std::process::id(),
            ATOMIC_WRITE_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let dot_dir = root.join("157.0.4341.60");
        let exe_file = dot_dir.join("msedgewebview2.exe");
        let zip_file = root.join("backup.tar.gz");
        std::fs::create_dir_all(&dot_dir).unwrap();
        std::fs::write(&exe_file, b"MZ").unwrap();
        std::fs::write(&zip_file, b"gz").unwrap();

        // 1. 带点目录必须被识别为真实 dir，绝不误判为 file
        let r_dir = inspect_local_path_core(&dot_dir.to_string_lossy());
        assert_eq!(r_dir["status"], "ok");
        assert_eq!(r_dir["kind"], "dir");
        assert_eq!(r_dir["isExec"], false);

        // 2. .exe 文件被识别为 file + isExec=true，parent 准确指向带点目录
        let r_exe = inspect_local_path_core(&exe_file.to_string_lossy());
        assert_eq!(r_exe["status"], "ok");
        assert_eq!(r_exe["kind"], "file");
        assert_eq!(r_exe["isExec"], true);
        assert_eq!(r_exe["isArchive"], false);
        assert_eq!(r_exe["parent"].as_str().unwrap(), dot_dir.to_string_lossy());

        // 3. 复合扩展名压缩包被识别为 file + isArchive=true
        let r_zip = inspect_local_path_core(&zip_file.to_string_lossy());
        assert_eq!(r_zip["status"], "ok");
        assert_eq!(r_zip["kind"], "file");
        assert_eq!(r_zip["isArchive"], true);

        // 4. 缺失目标返回 not_found 并给出最近存在的上级目录
        let missing = dot_dir.join("ghost").join("missing.exe");
        let r_miss = inspect_local_path_core(&missing.to_string_lossy());
        assert_eq!(r_miss["status"], "not_found");
        assert_eq!(r_miss["nearestExisting"].as_str().unwrap(), dot_dir.to_string_lossy());

        // 5. 盘符根父目录规范化带尾斜杠（C:\foo.exe -> C:\ 而非 C:）
        assert_eq!(normalized_parent_str(Path::new(r"C:\foo.exe")), r"C:\");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn list_dir_locate_and_filter_handles_over_200_items() {
        let root = std::env::temp_dir().join(format!(
            "qdisk_listdir_{}_{}",
            std::process::id(),
            ATOMIC_WRITE_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&root).unwrap();
        for i in 0..225 {
            std::fs::write(root.join(format!("item_{:03}.txt", i)), b"x").unwrap();
        }
        let target = root.join("item_218.txt");
        let res = list_dir(
            root.to_string_lossy().to_string(),
            Some(200),
            None,
            Some(target.to_string_lossy().to_string()),
            None,
        )
        .unwrap();
        assert_eq!(res["located"], true);
        assert_eq!(res["locateIndex"], 218);
        assert_eq!(res["offset"], 200);
        assert_eq!(res["hasPrev"], true);
        let items = res["items"].as_array().unwrap();
        assert!(items.iter().any(|it| it["name"] == "item_218.txt"));

        // 后端过滤突破 200 项限制
        let flt = list_dir(
            root.to_string_lossy().to_string(),
            Some(50),
            None,
            None,
            Some("item_21".to_string()),
        )
        .unwrap();
        assert_eq!(flt["unfilteredTotal"], 225);
        assert_eq!(flt["total"], 10);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn bundled_app_icon_has_dib_and_png_frames_for_windows_taskbar() {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let ico_path = manifest_dir.join("icons").join("icon.ico");
        let bytes = std::fs::read(&ico_path).expect("icons/icon.ico must exist");
        assert!(bytes.len() > 22, "icon.ico too small");
        let rsv = u16::from_le_bytes([bytes[0], bytes[1]]);
        let typ = u16::from_le_bytes([bytes[2], bytes[3]]);
        let count = u16::from_le_bytes([bytes[4], bytes[5]]) as usize;
        assert_eq!(rsv, 0);
        assert_eq!(typ, 1);
        assert!(count >= 7, "expected at least 7 multi-DPI icon frames, got {count}");
        let mut sizes = Vec::new();
        for i in 0..count {
            let base = 6 + i * 16;
            let w = if bytes[base] == 0 { 256u32 } else { bytes[base] as u32 };
            let sz = u32::from_le_bytes([bytes[base + 8], bytes[base + 9], bytes[base + 10], bytes[base + 11]]) as usize;
            let off = u32::from_le_bytes([bytes[base + 12], bytes[base + 13], bytes[base + 14], bytes[base + 15]]) as usize;
            assert!(off + sz <= bytes.len(), "frame {i} out of bounds");
            if w <= 128 {
                // 32-bit DIB BITMAPINFOHEADER starts with biSize = 40 (0x28 00 00 00)
                assert_eq!(&bytes[off..off + 4], &[40, 0, 0, 0], "size {w} must be DIB for Win32 Taskbar compatibility");
            } else {
                assert_eq!(&bytes[off..off + 4], b"\x89PNG", "256px frame must be PNG");
            }
            sizes.push(w);
        }
        for req in [16u32, 24, 32, 48, 64, 128, 256] {
            assert!(sizes.contains(&req), "missing {req}px taskbar icon frame");
        }
        for png in ["32x32.png", "128x128.png", "128x128@2x.png", "icon.png"] {
            let p = manifest_dir.join("icons").join(png);
            let data = std::fs::read(&p).unwrap_or_else(|_| panic!("missing {png}"));
            assert!(data.starts_with(b"\x89PNG"), "{png} must be valid PNG");
        }
    }

    #[test]
    fn locator_arbitrates_by_latest_timestamp_and_migrates_core_data() {
        let root = std::env::temp_dir().join(format!("tidy_mig_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let exe_d = root.join("app");
        let eng_d = exe_d.join("引擎");
        let local_d = root.join("local");
        let old_data = root.join("old_data");
        let new_data = root.join("new_data");
        std::fs::create_dir_all(&eng_d).unwrap();
        std::fs::create_dir_all(&local_d).unwrap();
        std::fs::create_dir_all(old_data.join("配置")).unwrap();
        std::fs::create_dir_all(old_data.join("ai")).unwrap();
        std::fs::create_dir_all(old_data.join("webview")).unwrap();
        std::fs::create_dir_all(old_data.join("cache")).unwrap();
        std::fs::create_dir_all(&new_data).unwrap();

        // 1. 两个指针冲突时，必须选 updated_ms 更新的目录（防只读程序目录旧指针盖掉用户新选择）
        let eng_loc = eng_d.join(DATA_LOCATOR_NAME);
        let user_loc = local_d.join("整理助手").join(DATA_LOCATOR_NAME);
        write_file_atomic(
            &eng_loc,
            serde_json::to_string(&json!({ "data_dir": old_data, "updated_ms": 1000 }))
                .unwrap()
                .as_bytes(),
        )
        .unwrap();
        write_file_atomic(
            &user_loc,
            serde_json::to_string(&json!({ "data_dir": new_data, "updated_ms": 2000 }))
                .unwrap()
                .as_bytes(),
        )
        .unwrap();
        let read_cands = locator_read_candidates_for(&exe_d, Some(&local_d));
        let picked = read_locator_from_candidates(&read_cands).expect("must resolve locator");
        assert!(path_eq_ci(&picked, &new_data), "should pick newer timestamp locator");

        // 2. 校验规则拒绝盘符根、程序目录、嵌套目录、相同目录、超长路径；预检模式不残留新建目录
        assert!(validate_data_dir_target("C:\\", &old_data, &exe_d, false).is_err());
        assert!(validate_data_dir_target(&exe_d.to_string_lossy(), &old_data, &exe_d, false).is_err());
        assert!(validate_data_dir_target(&old_data.join("sub").to_string_lossy(), &old_data, &exe_d, false).is_err());
        assert!(validate_data_dir_target(&old_data.to_string_lossy(), &old_data, &exe_d, false).is_err());
        let long_path = format!("C:\\{}", "a".repeat(170));
        assert!(validate_data_dir_target(&long_path, &old_data, &exe_d, false).is_err());
        let dry_target = root.join("preview_only_dir");
        assert!(validate_data_dir_target(&dry_target.to_string_lossy(), &old_data, &exe_d, false).is_ok());
        assert!(!dry_target.exists(), "preview mode must not leave behind newly created dir");

        // 3. 核心迁移：搬走 app.json / 配置 / ai 并更新 settings.json，跳过 webview 与 cache，在新目录重建空骨架
        std::fs::write(old_data.join("app.json"), r#"{"theme":"dark"}"#).unwrap();
        std::fs::write(
            old_data.join("配置").join("settings.json"),
            serde_json::to_string(&json!({
                "data_dir": old_data,
                "cache_dir": old_data.join("cache")
            }))
            .unwrap(),
        )
        .unwrap();
        std::fs::write(old_data.join("ai").join("sessions.json"), "[]").unwrap();
        std::fs::write(old_data.join("webview").join("lock.db"), "locked").unwrap();
        std::fs::write(old_data.join("cache").join("idx.db"), "cache").unwrap();
        std::fs::write(old_data.join("user_unrelated.txt"), "keep").unwrap();

        let target = root.join("migrated_target");
        let valid_target = validate_data_dir_target(&target.to_string_lossy(), &old_data, &exe_d, true).unwrap();
        let (cnt, _bytes, warns) = copy_core_data_with_progress(&old_data, &valid_target, |_, _, _, _| {}).unwrap();
        assert!(warns.is_empty());
        assert_eq!(cnt, 3);
        assert!(valid_target.join("app.json").is_file());
        assert!(valid_target.join("ai").join("sessions.json").is_file());
        assert!(!valid_target.join("webview").join("lock.db").exists());
        assert!(!valid_target.join("cache").join("idx.db").exists());
        assert!(!valid_target.join("user_unrelated.txt").exists());
        for &sub in REBUILD_SUBDIRS {
            assert!(valid_target.join(sub).is_dir(), "must recreate {sub}");
        }
        let s_txt = std::fs::read_to_string(valid_target.join("配置").join("settings.json")).unwrap();
        let s_val: Value = serde_json::from_str(&s_txt).unwrap();
        assert_eq!(
            s_val["data_dir"].as_str().unwrap().to_lowercase(),
            normalize_path_str(&valid_target.to_string_lossy()).to_lowercase()
        );
        assert_eq!(s_val["cache_dir"].as_str().unwrap(), "");

        // 4. 双写指针并验证读回
        let write_cands = locator_write_candidates_for(&exe_d, Some(&local_d));
        let written = write_locator_to_candidates(&valid_target, &write_cands).unwrap();
        assert_eq!(written.len(), 2);
        let picked2 = read_locator_from_candidates(&read_cands).unwrap();
        assert!(path_eq_ci(&picked2, &valid_target));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn file_preview_handles_encodings_ooxml_scripts_binaries_and_guards() {
        let stamp = unix_now_ms();
        let root = std::env::temp_dir().join(format!("qdisk_preview_test_{stamp}"));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        // 1. UTF-8 中文文本与截断边界对齐
        let utf8_p = root.join("notes.txt");
        std::fs::write(&utf8_p, "你好世界".repeat(1500)).unwrap();
        let r_utf8 = file_preview_core(&utf8_p.to_string_lossy(), Some(4097), None).unwrap();
        assert_eq!(r_utf8["kind"], "text");
        assert_eq!(r_utf8["encoding"], "utf-8");
        assert_eq!(r_utf8["truncated"], true);
        assert!(!r_utf8["text"].as_str().unwrap().contains('\u{FFFD}'));

        // 2. UTF-16LE BOM 文本（如 Windows .reg / 记事本）
        let u16_p = root.join("export.reg");
        let mut u16_bytes = vec![0xFFu8, 0xFEu8];
        for cu in "Windows Registry Editor\r\n测试键=1".encode_utf16() {
            u16_bytes.extend_from_slice(&cu.to_le_bytes());
        }
        std::fs::write(&u16_p, &u16_bytes).unwrap();
        let r_u16 = file_preview_core(&u16_p.to_string_lossy(), None, None).unwrap();
        assert_eq!(r_u16["kind"], "text");
        assert_eq!(r_u16["encoding"], "utf-16le");
        assert_eq!(r_u16["isExec"], true);
        assert!(r_u16["text"].as_str().unwrap().contains("测试键=1"));

        // 3. GBK (CP936) 中文文件正确解码（无乱码）
        #[cfg(windows)]
        {
            let gbk_p = root.join("gbk_doc.csv");
            // "中文测试" in GBK: D6 D0 CE C4 B2 E2 CA D4
            let gbk_bytes: &[u8] = &[0xD6, 0xD0, 0xCE, 0xC4, 0xB2, 0xE2, 0xCA, 0xD4, b',', b'1', b'2', b'3'];
            std::fs::write(&gbk_p, gbk_bytes).unwrap();
            let r_gbk = file_preview_core(&gbk_p.to_string_lossy(), None, None).unwrap();
            assert_eq!(r_gbk["kind"], "text");
            assert_eq!(r_gbk["encoding"], "gbk");
            assert_eq!(r_gbk["text"], "中文测试,123");
        }

        // 4. 真实 .docx / .xlsx / .pptx 正文提取
        let docx_p = root.join("demo.docx");
        {
            let f = std::fs::File::create(&docx_p).unwrap();
            let mut zw = zip::ZipWriter::new(f);
            let opts = zip::write::SimpleFileOptions::default();
            zw.start_file("word/document.xml", opts).unwrap();
            zw.write_all(br#"<w:document><w:body><w:p><w:r><w:t>QDisk &amp; Word</w:t></w:r></w:p><w:p><w:r><w:t>&#20013;&#25991;&#27573;&#33853;</w:t></w:r></w:p></w:body></w:document>"#).unwrap();
            zw.finish().unwrap();
        }
        let r_docx = file_preview_core(&docx_p.to_string_lossy(), None, None).unwrap();
        assert_eq!(r_docx["kind"], "office");
        let dt = r_docx["text"].as_str().unwrap();
        assert!(dt.contains("QDisk & Word") && dt.contains("中文段落"), "docx={dt}");

        let xlsx_p = root.join("demo.xlsx");
        {
            let f = std::fs::File::create(&xlsx_p).unwrap();
            let mut zw = zip::ZipWriter::new(f);
            let opts = zip::write::SimpleFileOptions::default();
            zw.start_file("xl/workbook.xml", opts).unwrap();
            zw.write_all(r#"<workbook><sheets><sheet name="财务表" sheetId="1"/></sheets></workbook>"#.as_bytes()).unwrap();
            zw.start_file("xl/sharedStrings.xml", opts).unwrap();
            zw.write_all(r#"<sst><si><t>项目</t></si><si><t>金额</t></si></sst>"#.as_bytes()).unwrap();
            zw.start_file("xl/worksheets/sheet1.xml", opts).unwrap();
            zw.write_all(r#"<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>预算</t></is></c><c r="B2"><v>998</v></c></row></sheetData></worksheet>"#.as_bytes()).unwrap();
            zw.finish().unwrap();
        }
        let r_xlsx = file_preview_core(&xlsx_p.to_string_lossy(), None, None).unwrap();
        assert_eq!(r_xlsx["kind"], "office");
        let xt = r_xlsx["text"].as_str().unwrap();
        assert!(xt.contains("财务表") && xt.contains("项目\t金额") && xt.contains("预算\t998"), "xlsx={xt}");

        let pptx_p = root.join("demo.pptx");
        {
            let f = std::fs::File::create(&pptx_p).unwrap();
            let mut zw = zip::ZipWriter::new(f);
            let opts = zip::write::SimpleFileOptions::default();
            zw.start_file("ppt/slides/slide1.xml", opts).unwrap();
            zw.write_all(r#"<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>第一页标题</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>"#.as_bytes()).unwrap();
            zw.finish().unwrap();
        }
        let r_pptx = file_preview_core(&pptx_p.to_string_lossy(), None, None).unwrap();
        assert_eq!(r_pptx["kind"], "office");
        let pt = r_pptx["text"].as_str().unwrap();
        assert!(pt.contains("第 1 页") && pt.contains("第一页标题"), "pptx={pt}");

        // 5. 文本伪装的 .xls 自动嗅探可读；真 OLE2 .doc 友好提示 unsupported
        let html_xls = root.join("export_table.xls");
        std::fs::write(&html_xls, "<table><tr><td>OK</td></tr></table>").unwrap();
        let r_hxls = file_preview_core(&html_xls.to_string_lossy(), None, None).unwrap();
        assert_eq!(r_hxls["kind"], "text");

        let bin_doc = root.join("legacy.doc");
        std::fs::write(&bin_doc, &[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1, 0, 0, 0, 0]).unwrap();
        let r_bdoc = file_preview_core(&bin_doc.to_string_lossy(), None, None).unwrap();
        assert_eq!(r_bdoc["kind"], "unsupported");
        assert_eq!(r_bdoc["canHex"], true);

        // 6. 无扩展名文本自动嗅探为 text；二进制 PE 识别为 hex + isExec=true
        let plain_noext = root.join("CUSTOM_README");
        std::fs::write(&plain_noext, "plain text without ext\nline 2").unwrap();
        let r_noext = file_preview_core(&plain_noext.to_string_lossy(), None, None).unwrap();
        assert_eq!(r_noext["kind"], "text");

        let exe_p = root.join("tool.exe");
        std::fs::write(&exe_p, &[b'M', b'Z', 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]).unwrap();
        let r_exe = file_preview_core(&exe_p.to_string_lossy(), None, None).unwrap();
        assert_eq!(r_exe["kind"], "hex");
        assert_eq!(r_exe["isExec"], true);
        assert!(r_exe["magic"].as_str().unwrap().contains("PE"));

        // 7. 空文件、目录与设备路径拦截
        let empty_p = root.join("zero.txt");
        std::fs::write(&empty_p, b"").unwrap();
        let r_empty = file_preview_core(&empty_p.to_string_lossy(), None, None).unwrap();
        assert_eq!(r_empty["kind"], "empty");

        assert!(file_preview_core(&root.to_string_lossy(), None, None).is_err());
        assert!(file_preview_core(r"\\.\PhysicalDrive0", None, None).is_err());
        assert!(file_preview_core("C:\\temp\\CON.txt", None, None).is_err());
        assert!(file_preview_core(&format!("{}:secret_ads", empty_p.to_string_lossy()), None, None).is_err());

        // 8. 红队加测：13 万字大 DOCX 必须 O(N) 毫秒级截断（防 push_capped O(N²) 假死），
        //    大写 Sheet1.xml + <x:sheet> 命名空间 XLSX 正常提取，且 \\?\ 扩展前缀自动剥离
        let big_docx = root.join("large_perf.docx");
        {
            let f = std::fs::File::create(&big_docx).unwrap();
            let mut zw = zip::ZipWriter::new(f);
            let opts = zip::write::SimpleFileOptions::default();
            zw.start_file("WORD/Document.xml", opts).unwrap();
            let chunk = "<w:p><w:r><w:t>0123456789中文性能压测段落</w:t></w:r></w:p>".repeat(8000);
            zw.write_all(format!("<w:document><w:body>{chunk}</w:body></w:document>").as_bytes()).unwrap();
            zw.finish().unwrap();
        }
        let t_big = std::time::Instant::now();
        let ext_path = format!(r"\\?\{}", big_docx.to_string_lossy());
        let r_big = file_preview_core(&ext_path, None, None).unwrap();
        let elapsed_ms = t_big.elapsed().as_millis();
        assert_eq!(r_big["kind"], "office");
        assert_eq!(r_big["truncated"], true);
        assert!(
            r_big["text"].as_str().unwrap().chars().count() <= OOXML_MAX_CHARS,
            "超过 OOXML 字符上限"
        );
        assert!(
            elapsed_ms < 2000,
            "大 DOCX 提取耗时异常（可能退化为 O(N²)）: {elapsed_ms}ms"
        );
        assert!(
            !r_big["path"].as_str().unwrap().starts_with(r"\\?\"),
            "返回路径必须剥离 \\\\?\\ 扩展前缀"
        );

        let cap_xlsx = root.join("wps_case.xlsx");
        {
            let f = std::fs::File::create(&cap_xlsx).unwrap();
            let mut zw = zip::ZipWriter::new(f);
            let opts = zip::write::SimpleFileOptions::default();
            zw.start_file("xl/Workbook.xml", opts).unwrap();
            zw.write_all(r#"<x:workbook><x:sheets><x:sheet name="总览表" sheetId="1"/></x:sheets></x:workbook>"#.as_bytes()).unwrap();
            zw.start_file("xl/SharedStrings.xml", opts).unwrap();
            zw.write_all(r#"<sst><si><t>指标</t></si></sst>"#.as_bytes()).unwrap();
            zw.start_file("xl/worksheets/Sheet1.xml", opts).unwrap();
            zw.write_all(r#"<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>"#.as_bytes()).unwrap();
            zw.finish().unwrap();
        }
        let r_capx = file_preview_core(&cap_xlsx.to_string_lossy(), None, None).unwrap();
        assert_eq!(r_capx["kind"], "office");
        let cxt = r_capx["text"].as_str().unwrap();
        assert!(cxt.contains("总览表") && cxt.contains("指标"), "wps_xlsx={cxt}");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn redteam_r1_r2_guards_empty_dir_device_path_and_exec_exts() {
        // 1. empty_dir_denied 必须放行用户目录（下载/桌面）下的普通空子文件夹，同时严格拦截目录本体与系统树
        if let Ok(home) = std::env::var("USERPROFILE") {
            let user_sub = PathBuf::from(&home).join("Downloads").join("EmptyTestSubdir_99");
            assert!(
                empty_dir_denied(&user_sub).is_none(),
                "普通用户下载子目录不应被 empty_dir_denied 误杀: {:?}",
                user_sub
            );
            assert!(empty_dir_denied(&PathBuf::from(&home)).is_some());
            assert!(empty_dir_denied(&PathBuf::from(&home).join("Downloads")).is_some());
            assert!(empty_dir_denied(&PathBuf::from(&home).join("Desktop")).is_some());
        }
        assert!(empty_dir_denied(Path::new(r"C:\Windows\Temp\EmptySub")).is_some());
        assert!(empty_dir_denied(Path::new(r"D:\$Recycle.Bin\S-1-5-21")).is_some());
        assert!(empty_dir_denied(&data_dir()).is_some());

        // 2. is_windows_device_path 拦截正斜杠设备路径、GLOBALROOT、中间段保留设备名与 ADS
        assert!(is_windows_device_path("//./COM1"));
        assert!(is_windows_device_path(r"\\?\GLOBALROOT\Device\Harddisk0"));
        assert!(is_windows_device_path(r"C:\foo\CON\bar.txt"));
        assert!(is_windows_device_path(r"D:\docs\note.txt:hidden"));
        assert!(!is_windows_device_path(r"D:\docs\config.json"));

        // 3. LOCAL_EXEC_EXTS 覆盖高危 Windows 可执行/帮助/脚本/快捷方式扩展名
        for ext in ["chm", "cpl", "msc", "jar", "pif", "url", "wsh", "msix", "appref-ms"] {
            let p = PathBuf::from(format!(r"D:\tmp\payload.{ext}"));
            assert!(is_exec_path(&p), "未拦截高危可执行扩展名 .{ext}");
        }
        assert!(!is_exec_path(Path::new(r"D:\tmp\readme.txt")));
    }
}

