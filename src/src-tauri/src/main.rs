// TidyAssistant / 整理助手
// Developer: 白林 (Type) <3347567186@qq.com>
// Note: 独立开发者白林（是个帅气的男孩）；本注释仅留存于底层源码供二次开发与维护查阅，严禁展示在软件可见 UI。
// 发布版不要控制台窗口：Windows 下把子系统设为 windows，
// 否则每次启动都会额外弹一个黑色终端（双击快捷方式时最明显）。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
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

#[tauri::command]
fn resolve_local_path(path: String) -> Option<String> {
    let raw = path.trim();
    if raw.is_empty() || raw.chars().any(|c| c == '"' || c == '\n' || c == '\r' || (c as u32) < 0x20) {
        return None;
    }
    resolve_existing_local_path(raw).map(|p| p.to_string_lossy().to_string())
}

/// 在资源管理器里定位一个位置：目录就打开它，文件就选中它。
/// 同样先检查存在性——「定位了一个不存在的东西」等于没定位。
#[tauri::command]
fn reveal(path: String) -> Result<(), String> {
    let raw = path.trim().to_string();
    if raw.is_empty() {
        return Err("路径是空的".into());
    }
    if raw.chars().any(|c| c == '"' || c == '\n' || c == '\r' || (c as u32) < 0x20) {
        return Err("路径里有不能用的字符".into());
    }
    let p = resolve_existing_local_path(&raw)
        .ok_or_else(|| format!("这个位置已经不在了：{raw}"))?;
    let target = p.to_string_lossy().to_string();
    let mut cmd = Command::new("explorer.exe");
    if p.is_dir() {
        cmd.arg(&target);
    } else {
        cmd.arg(format!("/select,{target}"));
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
            "updater": true
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

/// 以管理员身份重新启动自己：走 PowerShell 的 Start-Process -Verb RunAs，
/// 由系统弹 UAC；提权实例带 `--elevated` 参数（启动时跳过单实例转发），
/// 本进程在该实例起来后主动退出，把数据目录与 WebView2 profile 让出去。
#[tauri::command]
async fn run_as_admin(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    // 先把引擎收掉，避免两个引擎同时写同一个数据目录
    if let Ok(mut guard) = state.engine.lock() {
        if let Some(mut old) = guard.take() {
            let _ = old.child.kill();
            let _ = old.child.wait();
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
    read_tail_utf8(Path::new(&path), max_bytes.unwrap_or(512 * 1024))
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
        if md.file_type().is_symlink() {
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
            if md.is_dir() && !md.file_type().is_symlink() {
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
#[tauri::command(async)]
fn list_dir(dir: String, limit: Option<usize>, offset: Option<usize>) -> Result<Value, String> {
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
    let skip = offset.unwrap_or(0);
    let mut files: Vec<Value> = Vec::new();
    let mut dirs: Vec<Value> = Vec::new();
    let rd = std::fs::read_dir(&p).map_err(|e| format!("无法读取目录：{e}"))?;
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
    let dir_count = dirs.len();
    let file_count = files.len();
    // 目录在前、文件在后拼成一条序列，分页只在序列上切一段。
    let all: Vec<Value> = dirs.into_iter().chain(files.into_iter()).collect();
    let items: Vec<Value> = all.iter().skip(skip).take(cap).cloned().collect();
    let shown = items.len();
    Ok(json!({
        "dir": p.to_string_lossy(),
        "total": dir_count + file_count,
        "offset": skip,
        "shown": shown,
        "dirs": dir_count,
        "files": file_count,
        // 只在「后面还有」时为真：翻到最后一页它会变 false，界面据此收掉「加载更多」。
        "truncated": skip + shown < dir_count + file_count,
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
                // 换行会破坏头结束符，直接拒绝而不是偷偷清掉
                if k.contains('\r') || k.contains('\n') || val.contains('\r') || val.contains('\n') {
                    return Err("请求头包含非法字符".into());
                }
                headers.push((k.clone(), val.to_string()));
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
                if k.contains('\r') || k.contains('\n') || val.contains('\r') || val.contains('\n') {
                    return Err("请求头包含非法字符".into());
                }
                headers.push((k.clone(), val.to_string()));
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
            app_info,
            app_capabilities,
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
            updater::updater_install
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
}

