use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::archive::{self, Overwrite, Progress, TaskControl};
use crate::updater::{
    self, find_portable_payload_root, normalize_sha256, sanitize_file_name, updates_dir,
    validate_update_url, verify_binary_magic, SemVer, Sha256Verifier, UpdateVerifier,
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const HOST_SUBDIR: &str = "_host";
const HOST_EXE_NAME: &str = "qdisk-updater.exe";
const MAIN_EXE_NAME: &str = "tidy-assistant.exe";
const ENGINE_DIR_NAME: &str = "引擎";
const ENGINE_EXE_NAME: &str = "整理助手引擎.exe";
const DATA_LOC_FILE: &str = "数据位置.json";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateJob {
    pub current_version: String,
    pub target_version: String,
    pub package_kind: String, // "installer" | "portable"
    pub download_url: String,
    pub sha256: String,
    pub size: u64,
    pub file_name: String,
    pub staged_path: Option<String>,
    pub app_dir: String,
    pub app_exe: String,
    pub main_pid: u32,
    pub theme: String, // "light" | "dark"
    pub lang: String,  // "zh" | "en"
    #[serde(default)]
    pub preview: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostProgressEvent {
    pub phase: String, // "waiting_exit" | "downloading" | "verifying" | "installing" | "launching" | "done" | "error" | "cancelled"
    pub step_index: u8, // 0=download, 1=verify, 2=install, 3=launch
    pub percent: f64,
    pub title: String,
    pub detail: String,
    pub downloaded: u64,
    pub total: u64,
    pub speed_bps: u64,
    pub can_cancel: bool,
    pub can_retry: bool,
    pub can_elevate: bool,
    pub can_manual: bool,
    pub error: Option<String>,
}

pub enum UpdaterHostCli {
    Apply(PathBuf),
    Preview { theme: String, lang: String },
}

pub struct UpdaterHostState {
    pub job: UpdateJob,
    pub started: AtomicBool,
    pub running: AtomicBool,
    pub cancel: Arc<AtomicBool>,
    pub resolved_pkg: Mutex<Option<PathBuf>>,
}

pub fn host_root_dir() -> PathBuf {
    updates_dir().join(HOST_SUBDIR)
}

pub fn parse_updater_host_cli() -> Option<UpdaterHostCli> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--apply-update" => {
                if let Some(p) = args.get(i + 1) {
                    return Some(UpdaterHostCli::Apply(PathBuf::from(p)));
                }
            }
            "--preview-updater" => {
                let mut theme = "light".to_string();
                let mut lang = "zh".to_string();
                for a in &args {
                    if let Some(t) = a.strip_prefix("--theme=") {
                        theme = if t.eq_ignore_ascii_case("dark") {
                            "dark".into()
                        } else {
                            "light".into()
                        };
                    } else if let Some(l) = a.strip_prefix("--lang=") {
                        lang = if l.eq_ignore_ascii_case("en") {
                            "en".into()
                        } else {
                            "zh".into()
                        };
                    }
                }
                return Some(UpdaterHostCli::Preview { theme, lang });
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// 正常启动后异步清理上次更新遗留的 `_host` 目录。
pub fn cleanup_updater_host_artifacts() {
    let dir = host_root_dir();
    if dir.exists() {
        let _ = fs::remove_dir_all(&dir);
    }
}

fn is_en(job: &UpdateJob) -> bool {
    job.lang.eq_ignore_ascii_case("en")
}

fn copy_file_with_retry(src: &Path, dst: &Path, attempts: u32) -> Result<()> {
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut last_err = None;
    for attempt in 1..=attempts.max(1) {
        match fs::copy(src, dst) {
            Ok(_) => return Ok(()),
            Err(e) => {
                last_err = Some(e);
                if attempt < attempts {
                    std::thread::sleep(Duration::from_millis(180 * u64::from(attempt.min(6))));
                }
            }
        }
    }
    Err(anyhow::anyhow!(
        "复制文件失败 ({} -> {}): {}",
        src.display(),
        dst.display(),
        last_err
            .map(|e| e.to_string())
            .unwrap_or_else(|| "unknown error".into())
    ))
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        if ty.is_symlink() {
            continue;
        }
        let target = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &target)?;
        } else if ty.is_file() {
            copy_file_with_retry(&entry.path(), &target, 6)?;
        }
    }
    Ok(())
}

/// 将当前 exe 与 WebView2Loader.dll 复制到 `_host` 临时目录并拉起独立可视化更新弹窗。
#[cfg(windows)]
pub fn prepare_and_spawn_updater_host(job: &UpdateJob) -> Result<()> {
    let cur_exe = std::env::current_exe().context("无法获取当前程序路径")?;
    let cur_dir = cur_exe
        .parent()
        .ok_or_else(|| anyhow::anyhow!("无法解析当前程序目录"))?;

    let host_base = host_root_dir();
    fs::create_dir_all(&host_base).context("无法创建更新宿主目录")?;

    let run_dir = {
        let candidate = host_base.join(HOST_EXE_NAME);
        if copy_file_with_retry(&cur_exe, &candidate, 3).is_ok() {
            host_base.clone()
        } else {
            let sub = host_base.join(format!("run_{}", std::process::id()));
            fs::create_dir_all(&sub)?;
            copy_file_with_retry(&cur_exe, &sub.join(HOST_EXE_NAME), 3)
                .context("无法复制更新宿主程序")?;
            sub
        }
    };

    let wv_src = cur_dir.join("WebView2Loader.dll");
    if wv_src.is_file() {
        let _ = copy_file_with_retry(&wv_src, &run_dir.join("WebView2Loader.dll"), 2);
    }

    let job_path = run_dir.join("job.json");
    let raw = serde_json::to_vec_pretty(job).context("序列化更新任务失败")?;
    fs::write(&job_path, raw).context("写入更新任务清单失败")?;

    let host_exe = run_dir.join(HOST_EXE_NAME);
    Command::new(&host_exe)
        .arg("--apply-update")
        .arg(&job_path)
        .spawn()
        .with_context(|| format!("启动独立更新弹窗失败：{}", host_exe.display()))?;
    Ok(())
}

/// 构造 NSIS 静默就地更新参数（`/S /UPDATE /D=<dir>`），全程免卸载确认与安装向导。
pub fn format_nsis_silent_update_args(app_dir: &Path) -> Vec<String> {
    let mut args = vec!["/S".to_string(), "/UPDATE".to_string()];
    let trimmed = app_dir
        .to_string_lossy()
        .trim()
        .trim_end_matches(['\\', '/'])
        .to_string();
    if !trimmed.is_empty()
        && !trimmed.contains('"')
        && !trimmed.contains('\n')
        && !trimmed.contains('\r')
    {
        args.push(format!("/D={trimmed}"));
    }
    args
}

/// 更新宿主侧再次校验核心安全不变量（防降级、防非法 URL、防目录穿越）。
pub fn validate_update_job_security(job: &UpdateJob) -> Result<()> {
    if !matches!(job.package_kind.as_str(), "installer" | "portable") {
        bail!("未知更新包类型：{}", job.package_kind);
    }
    let cur = SemVer::parse(&job.current_version)?;
    let target = SemVer::parse(&job.target_version)?;
    if target <= cur {
        bail!(
            "安全拦截：目标版本 v{} 不高于当前版本 v{}",
            job.target_version,
            job.current_version
        );
    }
    let _ = sanitize_file_name(&job.file_name)?;
    let _ = normalize_sha256(&job.sha256)?;
    if !job.download_url.trim().is_empty() {
        let _ = validate_update_url(&job.download_url, false)?;
    }
    Ok(())
}

fn verify_existing_staged_for_job(updates_root: &Path, job: &UpdateJob) -> Option<PathBuf> {
    let raw = job.staged_path.as_deref()?;
    let p = PathBuf::from(raw);
    let canon_root = fs::canonicalize(updates_root).ok()?;
    let meta = fs::symlink_metadata(&p).ok()?;
    if meta.file_type().is_symlink() {
        return None;
    }
    let canon = fs::canonicalize(&p).ok()?;
    if !canon.starts_with(&canon_root) {
        return None;
    }
    Sha256Verifier.verify_file(&canon, &job.sha256, job.size).ok()?;
    verify_binary_magic(&canon, &job.package_kind).ok()?;
    Some(canon)
}

#[cfg(windows)]
fn wait_for_pid_exit(pid: u32, timeout: Duration) {
    if pid == 0 || pid == std::process::id() {
        return;
    }
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
    };
    unsafe {
        let h = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if h.is_null() {
            return;
        }
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            let r = WaitForSingleObject(h, 80);
            if r == WAIT_OBJECT_0 {
                break;
            }
        }
        CloseHandle(h);
    }
}

/// 等待目标程序与随包引擎解除文件写锁，避免替换冲突。
fn wait_for_file_unlock(path: &Path, timeout: Duration) {
    if !path.is_file() {
        return;
    }
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if fs::OpenOptions::new().write(true).open(path).is_ok() {
            return;
        }
        std::thread::sleep(Duration::from_millis(120));
    }
}

#[cfg(windows)]
fn run_nsis_silent_update(
    installer_path: &Path,
    app_dir: &Path,
    elevate: bool,
    en: bool,
    mut on_tick: impl FnMut(f64, &str),
) -> Result<()> {
    // 升级前先在内存中备份用户自定义数据位置指针，防止 NSIS 随包资源覆盖
    let loc_path = app_dir.join(ENGINE_DIR_NAME).join(DATA_LOC_FILE);
    let saved_loc = fs::read(&loc_path).ok();

    let args = format_nsis_silent_update_args(app_dir);
    let started = Instant::now();

    let run_res = if elevate {
        run_nsis_elevated(installer_path, &args, en, &mut on_tick)
    } else {
        let mut cmd = Command::new(installer_path);
        cmd.arg("/S").arg("/UPDATE");
        if let Some(d_arg) = args.iter().find(|a| a.starts_with("/D=")) {
            cmd.raw_arg(d_arg);
        }
        cmd.creation_flags(CREATE_NO_WINDOW);
        let mut child = cmd.spawn().context("无法启动静默更新安装程序")?;

        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    if status.success() {
                        break Ok(());
                    }
                    let code = status.code().unwrap_or(-1);
                    break Err(anyhow::anyhow!(
                        "安装程序返回异常退出码（{code}），可能需要管理员权限或文件被占用"
                    ));
                }
                Ok(None) => {
                    let secs = started.elapsed().as_secs_f64();
                    let pct = 72.0 + 20.0 * (1.0 - (-secs / 4.8).exp());
                    let detail = if secs < 2.6 {
                        if en {
                            "Updating core app & engine silently (no uninstall wizard)…"
                        } else {
                            "正在静默更新主程序与随包引擎（无需手动卸载或点击向导）…"
                        }
                    } else if secs < 7.0 {
                        if en {
                            "Writing new release files and syncing shortcuts…"
                        } else {
                            "正在写入新版程序并更新快捷方式…"
                        }
                    } else if en {
                        "Finalizing installation and preserving user data…"
                    } else {
                        "正在收尾安装并校验数据目录完整性…"
                    };
                    on_tick(pct.min(92.0), detail);
                    std::thread::sleep(Duration::from_millis(160));
                }
                Err(e) => break Err(anyhow::anyhow!("监控安装进程失败：{e}")),
            }
        }
    };

    if run_res.is_ok() {
        if let Some(bytes) = saved_loc {
            if let Some(parent) = loc_path.parent() {
                let _ = fs::create_dir_all(parent);
            }
            let _ = fs::write(&loc_path, bytes);
        }
    }
    run_res
}

#[cfg(windows)]
fn run_nsis_elevated(
    installer_path: &Path,
    args: &[String],
    en: bool,
    on_tick: &mut impl FnMut(f64, &str),
) -> Result<()> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject};
    use windows_sys::Win32::UI::Shell::{
        ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
    };

    fn to_wide(s: &str) -> Vec<u16> {
        OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
    }

    let verb = to_wide("runas");
    let file = to_wide(&installer_path.to_string_lossy());
    let params = to_wide(&args.join(" "));

    let mut sei: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    sei.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
    sei.fMask = SEE_MASK_NOCLOSEPROCESS;
    sei.lpVerb = verb.as_ptr();
    sei.lpFile = file.as_ptr();
    sei.lpParameters = params.as_ptr();
    sei.nShow = 0; // SW_HIDE

    let ok = unsafe { ShellExecuteExW(&mut sei) };
    if ok == 0 || sei.hProcess.is_null() {
        bail!("未获得管理员授权或启动提权安装失败");
    }

    let started = Instant::now();
    let exit_code = unsafe {
        loop {
            let r = WaitForSingleObject(sei.hProcess, 160);
            if r == WAIT_OBJECT_0 {
                break;
            }
            let secs = started.elapsed().as_secs_f64();
            let pct = 72.0 + 20.0 * (1.0 - (-secs / 4.8).exp());
            on_tick(
                pct.min(92.0),
                if en {
                    "Installing silently with administrator privileges…"
                } else {
                    "正在以管理员权限静默完成安装…"
                },
            );
        }
        let mut code: u32 = 1;
        GetExitCodeProcess(sei.hProcess, &mut code);
        CloseHandle(sei.hProcess);
        code
    };

    if exit_code == 0 {
        Ok(())
    } else {
        bail!("提权静默安装失败（退出码 {exit_code}）");
    }
}

/// 纯 Rust 便携版原子替换：备份旧主程序 + `引擎\`，保留 `引擎\数据位置.json`，失败自动完整回滚。
pub fn apply_portable_swap_atomic(
    payload_root: &Path,
    app_dir: &Path,
    backup_dir: &Path,
    en: bool,
    mut on_progress: impl FnMut(f64, &str),
) -> Result<()> {
    if backup_dir.exists() {
        let _ = fs::remove_dir_all(backup_dir);
    }
    fs::create_dir_all(backup_dir).context("创建旧版备份目录失败")?;

    on_progress(
        79.0,
        if en {
            "Backing up current binaries and engine for safe rollback…"
        } else {
            "正在备份当前主程序与引擎，确保异常可安全回滚…"
        },
    );

    let old_exe = app_dir.join(MAIN_EXE_NAME);
    if old_exe.is_file() {
        copy_file_with_retry(&old_exe, &backup_dir.join(MAIN_EXE_NAME), 4)
            .context("备份旧版主程序失败")?;
    }
    let old_wv = app_dir.join("WebView2Loader.dll");
    if old_wv.is_file() {
        let _ = copy_file_with_retry(&old_wv, &backup_dir.join("WebView2Loader.dll"), 3);
    }
    let old_eng = app_dir.join(ENGINE_DIR_NAME);
    let saved_loc = fs::read(old_eng.join(DATA_LOC_FILE)).ok();
    if old_eng.is_dir() {
        copy_dir_recursive(&old_eng, &backup_dir.join(ENGINE_DIR_NAME))
            .context("备份旧版引擎目录失败")?;
    }

    let swap_res: Result<()> = (|| {
        on_progress(
            85.0,
            if en {
                "Replacing core executable…"
            } else {
                "正在原子替换新版核心程序…"
            },
        );
        let new_exe = payload_root.join(MAIN_EXE_NAME);
        if !new_exe.is_file() {
            bail!("新版本便携包缺少 {MAIN_EXE_NAME}");
        }
        copy_file_with_retry(&new_exe, &old_exe, 14).context("替换主程序失败（文件可能仍被占用）")?;

        let new_wv = payload_root.join("WebView2Loader.dll");
        if new_wv.is_file() {
            let _ = copy_file_with_retry(&new_wv, &old_wv, 5);
        }

        let new_eng = payload_root.join(ENGINE_DIR_NAME);
        if new_eng.is_dir() {
            on_progress(
                89.0,
                if en {
                    "Updating bundled engine & preserving data location…"
                } else {
                    "正在同步随包引擎并保留数据位置配置…"
                },
            );
            if old_eng.is_dir() {
                fs::remove_dir_all(&old_eng).context("清理旧版引擎目录失败")?;
            }
            copy_dir_recursive(&new_eng, &old_eng).context("写入新版引擎目录失败")?;
            if let Some(bytes) = &saved_loc {
                let _ = fs::write(old_eng.join(DATA_LOC_FILE), bytes);
            }
        }

        let new_tp = payload_root.join("THIRD_PARTY.md");
        if new_tp.is_file() {
            let _ = copy_file_with_retry(&new_tp, &app_dir.join("THIRD_PARTY.md"), 4);
        }
        Ok(())
    })();

    if let Err(err) = swap_res {
        let bak_exe = backup_dir.join(MAIN_EXE_NAME);
        if bak_exe.is_file() {
            let _ = copy_file_with_retry(&bak_exe, &old_exe, 6);
        }
        let bak_wv = backup_dir.join("WebView2Loader.dll");
        if bak_wv.is_file() {
            let _ = copy_file_with_retry(&bak_wv, &old_wv, 4);
        }
        let bak_eng = backup_dir.join(ENGINE_DIR_NAME);
        if bak_eng.is_dir() {
            let _ = fs::remove_dir_all(&old_eng);
            let _ = copy_dir_recursive(&bak_eng, &old_eng);
        }
        return Err(err);
    }

    let _ = fs::remove_dir_all(backup_dir);
    Ok(())
}

fn emit_progress(app: &AppHandle, ev: HostProgressEvent) {
    let _ = app.emit("updater-host-progress", ev);
}

fn spawn_preview_sequence(app: AppHandle, state: Arc<UpdaterHostState>) {
    std::thread::spawn(move || {
        let en = is_en(&state.job);
        let ver = state.job.target_version.clone();
        let total = state.job.size.max(38_600_000);
        let emit = |phase: &str, step: u8, pct: f64, title: &str, detail: &str, dl: u64, spd: u64, cancel: bool| {
            emit_progress(
                &app,
                HostProgressEvent {
                    phase: phase.into(),
                    step_index: step,
                    percent: pct,
                    title: title.into(),
                    detail: detail.into(),
                    downloaded: dl,
                    total,
                    speed_bps: spd,
                    can_cancel: cancel,
                    can_retry: false,
                    can_elevate: false,
                    can_manual: false,
                    error: None,
                },
            );
        };

        emit(
            "waiting_exit",
            0,
            4.0,
            if en { "Preparing update" } else { "正在准备自动更新" },
            if en {
                "Main app closed safely, initializing updater…"
            } else {
                "主程序与引擎已安全退出，正在初始化更新…"
            },
            0,
            0,
            true,
        );
        std::thread::sleep(Duration::from_millis(650));

        for i in 1..=18 {
            if state.cancel.load(Ordering::SeqCst) {
                emit(
                    "cancelled",
                    0,
                    0.0,
                    if en { "Preview cancelled" } else { "已取消预览" },
                    if en { "Update preview stopped" } else { "更新预览已停止" },
                    0,
                    0,
                    false,
                );
                return;
            }
            let frac = f64::from(i) / 18.0;
            let pct = 6.0 + frac * 54.0;
            let dl = (total as f64 * frac) as u64;
            let spd = 8_900_000 + (i as u64 % 5) * 450_000;
            emit(
                "downloading",
                0,
                pct,
                &if en {
                    format!("Downloading QDisk v{ver}")
                } else {
                    format!("正在下载轻盘 v{ver}")
                },
                if en {
                    "Streaming from official release channel…"
                } else {
                    "正在通过官方安全通道高速下载…"
                },
                dl,
                spd,
                true,
            );
            std::thread::sleep(Duration::from_millis(160));
        }

        emit(
            "verifying",
            1,
            66.0,
            if en { "Verifying package integrity" } else { "正在校验更新包签名" },
            if en {
                "Checking SHA-256 digest & anti-downgrade guard…"
            } else {
                "正在核对 SHA-256 哈希与防降级策略…"
            },
            total,
            0,
            false,
        );
        std::thread::sleep(Duration::from_millis(750));

        let steps = if en {
            [
                (74.0, "Updating core app & engine silently (no uninstall wizard)…"),
                (84.0, "Writing new release files and preserving data folder…"),
                (92.0, "Cleaning cache and verifying version consistency…"),
            ]
        } else {
            [
                (74.0, "正在静默更新主程序与随包引擎（无需手动卸载或向导）…"),
                (84.0, "正在写入新版本并保留全部用户配置与数据目录…"),
                (92.0, "正在清理临时缓存并确认版本一致性…"),
            ]
        };
        for (pct, msg) in steps {
            emit(
                "installing",
                2,
                pct,
                &if en {
                    format!("Installing QDisk v{ver}")
                } else {
                    format!("正在自动安装 v{ver}")
                },
                msg,
                total,
                0,
                false,
            );
            std::thread::sleep(Duration::from_millis(620));
        }

        emit(
            "launching",
            3,
            97.0,
            if en { "Update complete" } else { "安装完成，即将启动" },
            &if en {
                format!("Launching QDisk v{ver}…")
            } else {
                format!("正在唤醒轻盘 v{ver}…")
            },
            total,
            0,
            false,
        );
        std::thread::sleep(Duration::from_millis(550));
        emit(
            "done",
            3,
            100.0,
            &if en {
                format!("Updated to v{ver}")
            } else {
                format!("已升级至 v{ver}")
            },
            if en {
                "Preview finished (no local files modified)"
            } else {
                "更新预览完成（未改动本地文件），即将自动关闭"
            },
            total,
            0,
            false,
        );
        std::thread::sleep(Duration::from_millis(1600));
        app.exit(0);
    });
}

#[cfg(windows)]
fn spawn_real_update_pipeline(app: AppHandle, state: Arc<UpdaterHostState>, elevate: bool) {
    if state
        .running
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }
    state.cancel.store(false, Ordering::SeqCst);

    std::thread::spawn(move || {
        let job = state.job.clone();
        let en = is_en(&job);
        let ver = job.target_version.clone();
        let total_hint = job.size;

        let fail = |msg: String, allow_elevate: bool, allow_manual: bool| {
            state.running.store(false, Ordering::SeqCst);
            emit_progress(
                &app,
                HostProgressEvent {
                    phase: "error".into(),
                    step_index: 2,
                    percent: 0.0,
                    title: if en {
                        "Automatic update failed".into()
                    } else {
                        "自动更新未能完成".into()
                    },
                    detail: msg.clone(),
                    downloaded: 0,
                    total: total_hint,
                    speed_bps: 0,
                    can_cancel: false,
                    can_retry: true,
                    can_elevate: allow_elevate,
                    can_manual: allow_manual,
                    error: Some(msg),
                },
            );
        };

        if let Err(e) = validate_update_job_security(&job) {
            fail(format!("{e:#}"), false, false);
            return;
        }

        // 1. 等待旧主程序与随包引擎彻底释放锁
        emit_progress(
            &app,
            HostProgressEvent {
                phase: "waiting_exit".into(),
                step_index: 0,
                percent: 4.0,
                title: if en { "Preparing update".into() } else { "正在准备自动更新".into() },
                detail: if en {
                    "Waiting for QDisk and engine to exit cleanly…".into()
                } else {
                    "等待主程序与随包引擎安全退出并释放文件锁…".into()
                },
                downloaded: 0,
                total: total_hint,
                speed_bps: 0,
                can_cancel: true,
                can_retry: false,
                can_elevate: false,
                can_manual: false,
                error: None,
            },
        );
        wait_for_pid_exit(job.main_pid, Duration::from_secs(15));
        let app_dir = PathBuf::from(&job.app_dir);
        wait_for_file_unlock(&app_dir.join(MAIN_EXE_NAME), Duration::from_secs(4));
        wait_for_file_unlock(
            &app_dir.join(ENGINE_DIR_NAME).join(ENGINE_EXE_NAME),
            Duration::from_secs(4),
        );
        std::thread::sleep(Duration::from_millis(200));

        let root = updates_dir();
        if let Err(e) = fs::create_dir_all(&root) {
            fail(format!("无法访问更新缓存目录：{e}"), false, false);
            return;
        }

        // 2. 获取更新包（命中已校验本地缓存直接复用，否则断点续传下载）
        let pkg_path = if let Some(existing) = verify_existing_staged_for_job(&root, &job) {
            emit_progress(
                &app,
                HostProgressEvent {
                    phase: "verifying".into(),
                    step_index: 1,
                    percent: 64.0,
                    title: if en { "Using verified local package".into() } else { "已复用本地更新包".into() },
                    detail: if en {
                        "Local package passed SHA-256 verification".into()
                    } else {
                        "本地缓存已通过 SHA-256 完整性校验".into()
                    },
                    downloaded: job.size,
                    total: job.size,
                    speed_bps: 0,
                    can_cancel: false,
                    can_retry: false,
                    can_elevate: false,
                    can_manual: false,
                    error: None,
                },
            );
            existing
        } else {
            emit_progress(
                &app,
                HostProgressEvent {
                    phase: "downloading".into(),
                    step_index: 0,
                    percent: 6.0,
                    title: if en {
                        format!("Downloading QDisk v{ver}")
                    } else {
                        format!("正在下载轻盘 v{ver}")
                    },
                    detail: if en {
                        "Connecting to official release channel…".into()
                    } else {
                        "正在连接官方安全更新源…".into()
                    },
                    downloaded: 0,
                    total: total_hint,
                    speed_bps: 0,
                    can_cancel: true,
                    can_retry: false,
                    can_elevate: false,
                    can_manual: false,
                    error: None,
                },
            );
            let res = updater::download_and_verify_to(
                &root,
                &job.download_url,
                &job.sha256,
                job.size,
                &job.target_version,
                &job.version_file_name(),
                &job.package_kind,
                &state.cancel,
                Some(&app),
            );
            match res {
                Ok(staged) => PathBuf::from(staged.path),
                Err(e) => {
                    let msg = format!("{e:#}");
                    if state.cancel.load(Ordering::SeqCst) || msg.contains("取消") {
                        state.running.store(false, Ordering::SeqCst);
                        emit_progress(
                            &app,
                            HostProgressEvent {
                                phase: "cancelled".into(),
                                step_index: 0,
                                percent: 0.0,
                                title: if en { "Update cancelled".into() } else { "已取消更新".into() },
                                detail: if en {
                                    "No files were modified. You can reopen the current version.".into()
                                } else {
                                    "未对当前软件做任何更改，可随时重新打开原版本".into()
                                },
                                downloaded: 0,
                                total: total_hint,
                                speed_bps: 0,
                                can_cancel: false,
                                can_retry: true,
                                can_elevate: false,
                                can_manual: false,
                                error: None,
                            },
                        );
                    } else {
                        fail(format!("下载或校验更新包失败：{msg}"), false, false);
                    }
                    return;
                }
            }
        };

        if let Ok(mut g) = state.resolved_pkg.lock() {
            *g = Some(pkg_path.clone());
        }

        // 3. 安装前二次完整性复核
        emit_progress(
            &app,
            HostProgressEvent {
                phase: "verifying".into(),
                step_index: 1,
                percent: 69.0,
                title: if en { "Security check passed".into() } else { "安全校验通过".into() },
                detail: if en {
                    "Preparing seamless in-place update; all user data will be preserved…".into()
                } else {
                    "准备就地无缝安装，你的数据目录、历史与配置将完整保留…".into()
                },
                downloaded: job.size,
                total: job.size,
                speed_bps: 0,
                can_cancel: false,
                can_retry: false,
                can_elevate: false,
                can_manual: false,
                error: None,
            },
        );
        if let Err(e) = Sha256Verifier.verify_file(&pkg_path, &job.sha256, job.size) {
            fail(format!("安装前哈希复核失败：{e:#}"), false, false);
            return;
        }
        if let Err(e) = verify_binary_magic(&pkg_path, &job.package_kind) {
            fail(format!("安装前格式校验失败：{e:#}"), false, false);
            return;
        }

        // 4. 全自动安装（安装版走 NSIS /S /UPDATE /D=...；便携版走纯 Rust 原子替换 + 回滚）
        if job.package_kind == "portable" {
            emit_progress(
                &app,
                HostProgressEvent {
                    phase: "installing".into(),
                    step_index: 2,
                    percent: 73.0,
                    title: if en {
                        format!("Updating to v{ver}")
                    } else {
                        format!("正在自动更新至 v{ver}")
                    },
                    detail: if en {
                        "Extracting portable update package…".into()
                    } else {
                        "正在解压便携更新包…".into()
                    },
                    downloaded: job.size,
                    total: job.size,
                    speed_bps: 0,
                    can_cancel: false,
                    can_retry: false,
                    can_elevate: false,
                    can_manual: false,
                    error: None,
                },
            );
            let stage_dir = root.join(format!("stage_{}", job.target_version));
            let backup_dir = root.join(format!("backup_{}", job.target_version));
            if stage_dir.exists() {
                let _ = fs::remove_dir_all(&stage_dir);
            }
            let p = Arc::new(Progress::detached());
            let c = Arc::new(TaskControl::default());
            if let Err(e) = archive::extract_archive(
                None,
                &pkg_path,
                &stage_dir,
                None,
                None,
                Overwrite::Overwrite,
                "performance",
                &p,
                &c,
            ) {
                let _ = fs::remove_dir_all(&stage_dir);
                fail(format!("解压便携更新包失败：{e:#}"), false, false);
                return;
            }
            let payload_root = match find_portable_payload_root(&stage_dir) {
                Ok(pr) => pr,
                Err(e) => {
                    let _ = fs::remove_dir_all(&stage_dir);
                    fail(format!("{e:#}"), false, false);
                    return;
                }
            };
            let app_inst = app.clone();
            let ver_inst = ver.clone();
            let swap_res = apply_portable_swap_atomic(&payload_root, &app_dir, &backup_dir, en, |pct, detail| {
                emit_progress(
                    &app_inst,
                    HostProgressEvent {
                        phase: "installing".into(),
                        step_index: 2,
                        percent: pct,
                        title: if en {
                            format!("Updating to v{ver_inst}")
                        } else {
                            format!("正在自动更新至 v{ver_inst}")
                        },
                        detail: detail.into(),
                        downloaded: job.size,
                        total: job.size,
                        speed_bps: 0,
                        can_cancel: false,
                        can_retry: false,
                        can_elevate: false,
                        can_manual: false,
                        error: None,
                    },
                );
            });
            let _ = fs::remove_dir_all(&stage_dir);
            if let Err(e) = swap_res {
                fail(format!("便携版更新失败（已自动回滚旧版）：{e:#}"), false, false);
                return;
            }
        } else {
            let app_inst = app.clone();
            let ver_inst = ver.clone();
            let res = run_nsis_silent_update(&pkg_path, &app_dir, elevate, en, |pct, detail| {
                emit_progress(
                    &app_inst,
                    HostProgressEvent {
                        phase: "installing".into(),
                        step_index: 2,
                        percent: pct,
                        title: if en {
                            format!("Installing QDisk v{ver_inst}")
                        } else {
                            format!("正在自动安装 v{ver_inst}")
                        },
                        detail: detail.into(),
                        downloaded: job.size,
                        total: job.size,
                        speed_bps: 0,
                        can_cancel: false,
                        can_retry: false,
                        can_elevate: false,
                        can_manual: false,
                        error: None,
                    },
                );
            });
            if let Err(e) = res {
                fail(format!("{e:#}"), !elevate, true);
                return;
            }
        }

        // 清理已下载的旧包（保留 _host 供当前小窗体面退场）
        let host_dir = host_root_dir();
        updater::sweep_old_updates_keep(&host_dir);

        // 5. 自动启动新版并优雅退场
        emit_progress(
            &app,
            HostProgressEvent {
                phase: "launching".into(),
                step_index: 3,
                percent: 96.0,
                title: if en { "Update installed".into() } else { "安装完成，正在启动".into() },
                detail: if en {
                    format!("Launching QDisk v{ver}…")
                } else {
                    format!("正在启动新版轻盘 v{ver}…")
                },
                downloaded: job.size,
                total: job.size,
                speed_bps: 0,
                can_cancel: false,
                can_retry: false,
                can_elevate: false,
                can_manual: false,
                error: None,
            },
        );
        std::thread::sleep(Duration::from_millis(280));

        let launch_target = if Path::new(&job.app_exe).is_file() {
            PathBuf::from(&job.app_exe)
        } else {
            app_dir.join(MAIN_EXE_NAME)
        };
        if launch_target.is_file() {
            let _ = Command::new(&launch_target).arg("--restarted").spawn();
        }

        emit_progress(
            &app,
            HostProgressEvent {
                phase: "done".into(),
                step_index: 3,
                percent: 100.0,
                title: if en {
                    format!("Updated to v{ver}")
                } else {
                    format!("已升级至 v{ver}")
                },
                detail: if en {
                    "QDisk is starting, closing updater…".into()
                } else {
                    "新版轻盘已启动，更新窗口即将关闭".into()
                },
                downloaded: job.size,
                total: job.size,
                speed_bps: 0,
                can_cancel: false,
                can_retry: false,
                can_elevate: false,
                can_manual: false,
                error: None,
            },
        );
        state.running.store(false, Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(850));
        app.exit(0);
    });
}

impl UpdateJob {
    fn version_file_name(&self) -> String {
        if self.file_name.trim().is_empty() {
            format!("QDisk_{}_x64-update.bin", self.target_version)
        } else {
            self.file_name.clone()
        }
    }
}

#[tauri::command]
fn updater_host_init(app: AppHandle, state: State<'_, Arc<UpdaterHostState>>) -> UpdateJob {
    if let Some(w) = app.get_webview_window("updater") {
        let _ = w.show();
        let _ = w.set_focus();
    }
    if state
        .started
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        let st = Arc::clone(state.inner());
        if st.job.preview {
            spawn_preview_sequence(app, st);
        } else {
            #[cfg(windows)]
            spawn_real_update_pipeline(app, st, false);
        }
    }
    state.job.clone()
}

#[tauri::command]
fn updater_host_retry(
    app: AppHandle,
    state: State<'_, Arc<UpdaterHostState>>,
    elevate: Option<bool>,
) -> bool {
    let st = Arc::clone(state.inner());
    if st.job.preview {
        spawn_preview_sequence(app, st);
    } else {
        #[cfg(windows)]
        spawn_real_update_pipeline(app, st, elevate.unwrap_or(false));
    }
    true
}

#[tauri::command]
fn updater_host_cancel(app: AppHandle, state: State<'_, Arc<UpdaterHostState>>) -> bool {
    state.cancel.store(true, Ordering::SeqCst);
    if !state.running.load(Ordering::SeqCst) {
        app.exit(0);
    }
    true
}

#[tauri::command]
fn updater_host_reopen_app(app: AppHandle, state: State<'_, Arc<UpdaterHostState>>) -> bool {
    if !state.job.preview {
        let exe = PathBuf::from(&state.job.app_exe);
        if exe.is_file() {
            let _ = Command::new(exe).arg("--restarted").spawn();
        }
    }
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(160));
        handle.exit(0);
    });
    true
}

#[tauri::command]
fn updater_host_open_manual(app: AppHandle, state: State<'_, Arc<UpdaterHostState>>) -> Result<bool, String> {
    let pkg = state
        .resolved_pkg
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .or_else(|| state.job.staged_path.as_ref().map(PathBuf::from))
        .ok_or_else(|| "尚未定位已下载的安装包".to_string())?;
    if !pkg.is_file() {
        return Err("安装包文件不存在".into());
    }
    Command::new(&pkg)
        .spawn()
        .map_err(|e| format!("无法打开安装包：{e}"))?;
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(180));
        handle.exit(0);
    });
    Ok(true)
}

pub fn run_updater_host_app(cli: UpdaterHostCli) {
    let webview_dir = host_root_dir().join("webview");
    let _ = fs::create_dir_all(&webview_dir);
    std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &webview_dir);

    let job = match cli {
        UpdaterHostCli::Apply(path) => match fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<UpdateJob>(&bytes).ok())
        {
            Some(j) => j,
            None => return,
        },
        UpdaterHostCli::Preview { theme, lang } => UpdateJob {
            current_version: env!("CARGO_PKG_VERSION").to_string(),
            target_version: "1.48.0".to_string(),
            package_kind: "installer".to_string(),
            download_url: String::new(),
            sha256: "0".repeat(64),
            size: 38_600_000,
            file_name: "QDisk_1.48.0_x64-setup.exe".to_string(),
            staged_path: None,
            app_dir: String::new(),
            app_exe: String::new(),
            main_pid: 0,
            theme,
            lang,
            preview: true,
        },
    };

    let win_title = if is_en(&job) {
        "QDisk Auto Update"
    } else {
        "轻盘自动更新"
    };

    let state = Arc::new(UpdaterHostState {
        job,
        started: AtomicBool::new(false),
        running: AtomicBool::new(false),
        cancel: Arc::new(AtomicBool::new(false)),
        resolved_pkg: Mutex::new(None),
    });

    let mut ctx = tauri::generate_context!();
    if let Some(win) = ctx.config_mut().app.windows.first_mut() {
        win.label = "updater".into();
        win.title = win_title.into();
        win.url = tauri::WebviewUrl::App("updater.html".into());
        win.width = 400.0;
        win.height = 296.0;
        win.min_width = None;
        win.min_height = None;
        win.resizable = false;
        win.maximizable = false;
        win.minimizable = true;
        win.decorations = false;
        win.shadow = true;
        win.center = true;
        win.always_on_top = true;
        win.visible = false;
    }

    tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            updater_host_init,
            updater_host_retry,
            updater_host_cancel,
            updater_host_reopen_app,
            updater_host_open_manual,
        ])
        .run(ctx)
        .expect("轻盘更新弹窗启动失败");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_qdisk_nsis_silent_update_args() {
        let args = format_nsis_silent_update_args(Path::new(r"C:\Users\Dev\AppData\Local\QDisk\"));
        assert_eq!(args, vec!["/S", "/UPDATE", r"/D=C:\Users\Dev\AppData\Local\QDisk"]);
    }

    #[test]
    fn test_qdisk_job_security_blocks_downgrade_and_bad_url() {
        let base = UpdateJob {
            current_version: "1.47.5".into(),
            target_version: "1.48.0".into(),
            package_kind: "installer".into(),
            download_url: "https://github.com/3347567186/QDisk/releases/download/v1.48.0/QDisk_1.48.0_x64-setup.exe".into(),
            sha256: "b".repeat(64),
            size: 4096,
            file_name: "QDisk_1.48.0_x64-setup.exe".into(),
            staged_path: None,
            app_dir: r"C:\Apps\QDisk".into(),
            app_exe: r"C:\Apps\QDisk\tidy-assistant.exe".into(),
            main_pid: 99,
            theme: "light".into(),
            lang: "zh".into(),
            preview: false,
        };
        assert!(validate_update_job_security(&base).is_ok());

        let mut downgrade = base.clone();
        downgrade.target_version = "1.47.5".into();
        assert!(validate_update_job_security(&downgrade).is_err());

        let mut bad_url = base;
        bad_url.download_url = "https://evil.example.com/qdisk.exe".into();
        assert!(validate_update_job_security(&bad_url).is_err());
    }

    #[test]
    fn test_qdisk_portable_swap_preserves_data_location_and_rolls_back() {
        let tmp = std::env::temp_dir().join(format!("qdisk_upd_host_test_{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let app_dir = tmp.join("app");
        let payload = tmp.join("payload");
        let backup = tmp.join("backup");
        fs::create_dir_all(app_dir.join(ENGINE_DIR_NAME)).unwrap();
        fs::create_dir_all(payload.join(ENGINE_DIR_NAME)).unwrap();

        fs::write(app_dir.join(MAIN_EXE_NAME), b"OLD_QDISK").unwrap();
        fs::write(app_dir.join(ENGINE_DIR_NAME).join(ENGINE_EXE_NAME), b"OLD_ENG").unwrap();
        fs::write(
            app_dir.join(ENGINE_DIR_NAME).join(DATA_LOC_FILE),
            br#"{"data_dir":"D:\\CustomData"}"#,
        )
        .unwrap();

        fs::write(payload.join(MAIN_EXE_NAME), b"NEW_QDISK").unwrap();
        fs::write(payload.join(ENGINE_DIR_NAME).join(ENGINE_EXE_NAME), b"NEW_ENG").unwrap();
        fs::write(
            payload.join(ENGINE_DIR_NAME).join(DATA_LOC_FILE),
            br#"{"data_dir":"DEFAULT_SHOULD_NOT_OVERWRITE"}"#,
        )
        .unwrap();

        apply_portable_swap_atomic(&payload, &app_dir, &backup, false, |_, _| {}).unwrap();
        assert_eq!(fs::read(app_dir.join(MAIN_EXE_NAME)).unwrap(), b"NEW_QDISK");
        assert_eq!(
            fs::read(app_dir.join(ENGINE_DIR_NAME).join(ENGINE_EXE_NAME)).unwrap(),
            b"NEW_ENG"
        );
        assert_eq!(
            fs::read_to_string(app_dir.join(ENGINE_DIR_NAME).join(DATA_LOC_FILE)).unwrap(),
            r#"{"data_dir":"D:\\CustomData"}"#,
            "升级必须完整保留用户自定义数据位置指针"
        );
        assert!(!backup.exists());

        // 缺少主程序时应失败并完整保留现有版本
        let broken = tmp.join("broken");
        fs::create_dir_all(&broken).unwrap();
        assert!(apply_portable_swap_atomic(&broken, &app_dir, &backup, false, |_, _| {}).is_err());
        assert_eq!(fs::read(app_dir.join(MAIN_EXE_NAME)).unwrap(), b"NEW_QDISK");

        let _ = fs::remove_dir_all(&tmp);
    }
}
