use std::ffi::c_void;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::archive::{self, Overwrite, Progress, TaskControl};
use crate::{append_log, data_dir, exe_dir, is_local_host, read_config, split_url, write_config, AppState, CONFIG_LOCK};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 单次更新清单最大体积（2 MiB），防恶意超大 JSON 耗尽内存。
pub const MAX_MANIFEST_BYTES: usize = 2 * 1024 * 1024;
/// 单次更新安装包/便携包最大体积（512 MiB），防无限流 DoS。
pub const MAX_UPDATE_BYTES: u64 = 512 * 1024 * 1024;
/// 最大重定向跳数。
const MAX_REDIRECTS: usize = 5;

/// 官方内置 GitHub Releases 更新源（无需用户在设置中手动填写任何网址）。
pub const OFFICIAL_FEED_URL: &str =
    "https://github.com/3347567186/QDisk/releases/latest/download/latest.json";
pub const OFFICIAL_API_LATEST_URL: &str =
    "https://api.github.com/repos/3347567186/QDisk/releases/latest";
pub const OFFICIAL_API_RELEASES_URL: &str =
    "https://api.github.com/repos/3347567186/QDisk/releases?per_page=8";
pub const OFFICIAL_RELEASES_PAGE: &str =
    "https://github.com/3347567186/QDisk/releases";

static PART_SEQ: AtomicU64 = AtomicU64::new(1);

// ---------------------------------------------------------------- 可扩展抽象接口

/// 预留拓展接口：更新清单源提供者（内置静态 latest.json 与 GitHub Releases API 两种适配器）。
#[allow(dead_code)]
pub trait ManifestProvider: Send + Sync {
    fn id(&self) -> &'static str;
    fn can_handle(&self, url: &str) -> bool;
    fn fetch_manifest(&self, url: &str, channel: &str) -> Result<ReleaseManifest>;
}

/// 预留拓展接口：更新包完整性/签名校验器（默认强制 SHA-256，后续可无缝挂接 Ed25519 公钥验签）。
#[allow(dead_code)]
pub trait UpdateVerifier: Send + Sync {
    fn id(&self) -> &'static str;
    fn verify_file(&self, path: &Path, expected_sha256: &str, expected_size: u64) -> Result<String>;
}

pub struct Sha256Verifier;

impl UpdateVerifier for Sha256Verifier {
    fn id(&self) -> &'static str {
        "sha256"
    }

    fn verify_file(&self, path: &Path, expected_sha256: &str, expected_size: u64) -> Result<String> {
        let want = normalize_sha256(expected_sha256)?;
        let meta = fs::symlink_metadata(path)
            .with_context(|| format!("读取更新文件元信息失败：{}", path.display()))?;
        if meta.file_type().is_symlink() {
            bail!("拒绝校验符号链接更新包");
        }
        if expected_size > 0 && meta.len() != expected_size {
            bail!(
                "更新包大小不匹配（期望 {} B，实际 {} B）",
                expected_size,
                meta.len()
            );
        }
        let mut f = File::open(path).with_context(|| format!("无法打开更新包：{}", path.display()))?;
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = f.read(&mut buf)?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
        let got = hex_lower(&hasher.finalize());
        if got != want {
            bail!("更新包 SHA-256 校验失败（期望 {want}，实际 {got}），文件可能损坏或被篡改");
        }
        Ok(got)
    }
}

// ---------------------------------------------------------------- SemVer 比较

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SemVer {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
    pub prerelease: Option<String>,
}

impl SemVer {
    pub fn parse(raw: &str) -> Result<Self> {
        let s = raw.trim().trim_start_matches(['v', 'V']);
        if s.is_empty() {
            bail!("版本号为空");
        }
        let without_build = s.split('+').next().unwrap_or(s);
        let (core, pre) = match without_build.split_once('-') {
            Some((c, p)) if !p.is_empty() => (c, Some(p.to_string())),
            Some((c, _)) => (c, None),
            None => (without_build, None),
        };
        let parts: Vec<&str> = core.split('.').collect();
        if parts.len() != 3 {
            bail!("版本号格式不合法：{raw}");
        }
        let major = parts[0].parse::<u64>().with_context(|| format!("无效主版本号：{raw}"))?;
        let minor = parts[1].parse::<u64>().with_context(|| format!("无效次版本号：{raw}"))?;
        let patch = parts[2].parse::<u64>().with_context(|| format!("无效修订号：{raw}"))?;
        Ok(Self {
            major,
            minor,
            patch,
            prerelease: pre,
        })
    }

    pub fn is_prerelease(&self) -> bool {
        self.prerelease.is_some()
    }
}

impl Ord for SemVer {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        use std::cmp::Ordering;
        match (self.major, self.minor, self.patch).cmp(&(other.major, other.minor, other.patch)) {
            Ordering::Equal => match (&self.prerelease, &other.prerelease) {
                (None, None) => Ordering::Equal,
                (None, Some(_)) => Ordering::Greater, // 正式版 > 预发布版
                (Some(_), None) => Ordering::Less,
                (Some(a), Some(b)) => compare_prerelease(a, b),
            },
            ord => ord,
        }
    }
}

impl PartialOrd for SemVer {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

fn compare_prerelease(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let sa: Vec<&str> = a.split('.').collect();
    let sb: Vec<&str> = b.split('.').collect();
    for (pa, pb) in sa.iter().zip(sb.iter()) {
        let ord = match (pa.parse::<u64>(), pb.parse::<u64>()) {
            (Ok(na), Ok(nb)) => na.cmp(&nb),
            (Ok(_), Err(_)) => Ordering::Less,
            (Err(_), Ok(_)) => Ordering::Greater,
            (Err(_), Err(_)) => pa.cmp(pb),
        };
        if ord != Ordering::Equal {
            return ord;
        }
    }
    sa.len().cmp(&sb.len())
}

// ---------------------------------------------------------------- 数据模型

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterConfig {
    pub channel: String,
    pub auto_check: bool,
    pub ignored_version: String,
    pub last_check_at: String,
}

impl Default for UpdaterConfig {
    fn default() -> Self {
        Self {
            channel: "stable".into(),
            auto_check: true,
            ignored_version: String::new(),
            last_check_at: String::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseAsset {
    pub file: String,
    pub url: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseManifest {
    pub version: String,
    pub channel: String,
    pub pub_date: String,
    pub min_version: String,
    pub notes: String,
    pub installer: Option<ReleaseAsset>,
    pub portable: Option<ReleaseAsset>,
    pub manifest_url: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub current_version: String,
    pub latest_version: String,
    pub has_update: bool,
    pub is_ignored: bool,
    pub is_prerelease: bool,
    pub install_kind: String,
    pub package_kind: String,
    pub channel: String,
    pub pub_date: String,
    pub notes: String,
    pub download_url: String,
    pub file_name: String,
    pub size: u64,
    pub sha256: String,
    pub manifest_url: String,
    pub staged: Option<StagedInfo>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedInfo {
    pub version: String,
    pub package_kind: String,
    pub file_name: String,
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterProgressPayload {
    pub phase: String,
    pub downloaded: u64,
    pub total: u64,
    pub speed_bps: u64,
    pub percent: u8,
    pub version: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterStatusSnapshot {
    pub current_version: String,
    pub install_kind: String,
    pub busy: bool,
    pub config: UpdaterConfig,
    pub releases_page: String,
    pub updates_dir: String,
    pub cache_bytes: u64,
    pub staged: Option<StagedInfo>,
}

pub struct UpdaterState {
    busy: AtomicBool,
    cancel: Arc<AtomicBool>,
    staged: Mutex<Option<StagedInfo>>,
}

impl Default for UpdaterState {
    fn default() -> Self {
        Self {
            busy: AtomicBool::new(false),
            cancel: Arc::new(AtomicBool::new(false)),
            staged: Mutex::new(None),
        }
    }
}

struct BusyGuard<'a>(&'a AtomicBool);
impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

// ---------------------------------------------------------------- 安全校验与路径辅助

pub fn updates_dir() -> PathBuf {
    data_dir().join("updates")
}

/// 自动识别当前运行形态：安装版（NSIS）或便携版（ZIP）。
pub fn detect_install_kind_for(dir: &Path) -> &'static str {
    let low = dir.to_string_lossy().replace('/', "\\").to_ascii_lowercase();
    if dir.join("uninstall.exe").is_file()
        || dir.join("Uninstall.exe").is_file()
        || low.contains("\\appdata\\local\\programs\\")
        || low.contains("\\program files\\")
        || low.contains("\\program files (x86)\\")
    {
        "installer"
    } else {
        "portable"
    }
}

pub fn detect_install_kind() -> &'static str {
    detect_install_kind_for(&exe_dir())
}

pub fn normalize_sha256(raw: &str) -> Result<String> {
    let cleaned = raw
        .trim()
        .strip_prefix("sha256:")
        .unwrap_or(raw.trim())
        .trim()
        .to_ascii_lowercase();
    if cleaned.len() != 64 || !cleaned.bytes().all(|b| b.is_ascii_hexdigit()) {
        bail!("SHA-256 摘要格式无效（必须为 64 位十六进制字符串）");
    }
    Ok(cleaned)
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

pub fn sanitize_file_name(raw: &str) -> Result<String> {
    let name = raw.trim();
    if name.is_empty() || name.len() > 160 {
        bail!("更新文件名不合法");
    }
    if name.contains("..")
        || name.contains('/')
        || name.contains('\\')
        || name.contains(':')
        || name
            .chars()
            .any(|c| (c as u32) < 0x20 || matches!(c, '<' | '>' | '"' | '|' | '?' | '*'))
    {
        bail!("更新文件名包含非法路径或危险字符：{name}");
    }
    let low = name.to_ascii_lowercase();
    if !low.ends_with(".exe") && !low.ends_with(".zip") {
        bail!("更新包仅支持 .exe 安装包或 .zip 便携包：{name}");
    }
    Ok(name.to_string())
}

/// 仅信任 GitHub 官方发布域名与本机回环（联调）；防止任意第三方域名劫持或恶意跳转。
pub fn is_trusted_release_host(host: &str) -> bool {
    let low = host.to_ascii_lowercase();
    is_local_host(&low)
        || matches!(
            low.as_str(),
            "github.com"
                | "api.github.com"
                | "objects.githubusercontent.com"
                | "release-assets.githubusercontent.com"
                | "codeload.github.com"
        )
        || low.ends_with(".githubusercontent.com")
}

/// 开发者本机联调覆盖：仅放行指向回环（127.0.0.1 / localhost / ::1）的环境变量 `TIDY_UPDATE_FEED`。
fn dev_loopback_feed() -> Option<String> {
    let raw = std::env::var("TIDY_UPDATE_FEED").ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let (_, host, _, _) = split_url(trimmed).ok()?;
    if is_local_host(&host) {
        Some(trimmed.to_string())
    } else {
        None
    }
}

/// 严格校验更新 URL：远端强制 HTTPS 且仅限官方 GitHub 域名；仅本机回环放行 HTTP 用于本地发包联调。
/// 当 `origin_is_remote_https` 为 true 时（重定向场景），禁止跨回环降级到本机 HTTP（防 SSRF + 降级）。
pub fn validate_update_url(url: &str, origin_is_remote_https: bool) -> Result<(bool, String, u16, String)> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        bail!("更新地址不能为空");
    }
    if trimmed.len() > 2048 {
        bail!("更新地址过长");
    }
    let (secure, host, port, path) = split_url(trimmed).map_err(anyhow::Error::msg)?;
    if host.contains('@') {
        bail!("更新地址不允许携带认证凭据");
    }
    let local = is_local_host(&host);
    if !secure && !local {
        bail!("出于安全要求，远端更新地址必须使用 https://");
    }
    if !local && !is_trusted_release_host(&host) {
        bail!("安全拦截：拒绝连接非官方受信任更新域名（{host}）");
    }
    if host.eq_ignore_ascii_case("github.com")
        && !path
            .to_ascii_lowercase()
            .starts_with("/3347567186/qdisk/")
    {
        bail!("安全拦截：拒绝从非官方仓库路径下载更新（{path}）");
    }
    if host.eq_ignore_ascii_case("api.github.com")
        && !path
            .to_ascii_lowercase()
            .starts_with("/repos/3347567186/qdisk/")
    {
        bail!("安全拦截：拒绝访问非官方仓库 API（{path}）");
    }
    if origin_is_remote_https && (!secure || local) {
        bail!("拒绝从远端 HTTPS 重定向到非 HTTPS 或本机回环地址");
    }
    Ok((secure, host, port, path))
}

/// 将清单里的相对文件名解析为完整下载 URL；已是绝对 URL 则原样返回。
pub fn resolve_asset_url(manifest_url: &str, raw_asset_url: &str) -> Result<String> {
    let u = raw_asset_url.trim();
    if u.is_empty() {
        bail!("更新清单缺少下载地址");
    }
    if u.starts_with("https://") || u.starts_with("http://") {
        return Ok(u.to_string());
    }
    if u.starts_with("//") || u.contains("://") {
        bail!("不支持的下载地址协议：{u}");
    }
    // 去掉 query/fragment 后按目录拼接
    let base_no_q = manifest_url.split('?').next().unwrap_or(manifest_url);
    let dir = match base_no_q.rfind('/') {
        Some(i) => &base_no_q[..=i],
        None => bail!("无法基于清单地址解析相对下载路径"),
    };
    let rel = u.trim_start_matches("./").trim_start_matches('/');
    Ok(format!("{dir}{rel}"))
}

// ---------------------------------------------------------------- 原生 WinHTTP 流式客户端（支持安全跳转与取消）

#[cfg(windows)]
fn winhttp_fetch_bytes(
    url: &str,
    max_bytes: usize,
    timeout_ms: u64,
    accept: &str,
) -> Result<(u32, Vec<u8>, String)> {
    let mut sink = Vec::new();
    let mut total_written = 0u64;
    let (status, final_url) = winhttp_stream_get(
        url,
        timeout_ms,
        accept,
        None,
        max_bytes as u64,
        &mut |chunk, _expected| {
            total_written += chunk.len() as u64;
            if total_written > max_bytes as u64 {
                bail!("响应体积超过上限（{} B）", max_bytes);
            }
            sink.extend_from_slice(chunk);
            Ok(())
        },
    )?;
    Ok((status, sink, final_url))
}

#[cfg(windows)]
fn winhttp_stream_get<F>(
    initial_url: &str,
    timeout_ms: u64,
    accept: &str,
    cancel: Option<&AtomicBool>,
    hard_cap_bytes: u64,
    on_chunk: &mut F,
) -> Result<(u32, String)>
where
    F: FnMut(&[u8], u64) -> Result<()>,
{
    use windows_sys::Win32::Networking::WinHttp::{
        WinHttpCloseHandle, WinHttpConnect, WinHttpOpen, WinHttpOpenRequest,
        WinHttpQueryDataAvailable, WinHttpQueryHeaders, WinHttpReadData, WinHttpReceiveResponse,
        WinHttpSendRequest, WinHttpSetOption, WinHttpSetTimeouts,
        WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, WINHTTP_ACCESS_TYPE_NO_PROXY, WINHTTP_DISABLE_REDIRECTS,
        WINHTTP_FLAG_SECURE, WINHTTP_OPTION_DISABLE_FEATURE, WINHTTP_QUERY_CONTENT_LENGTH,
        WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_QUERY_LOCATION, WINHTTP_QUERY_STATUS_CODE,
    };

    let (init_sec, init_host, _, _) = validate_update_url(initial_url, false)?;
    let origin_remote_https = init_sec && !is_local_host(&init_host);
    let mut current_url = initial_url.trim().to_string();
    let timeout = timeout_ms.clamp(2000, 180_000) as i32;
    let wide = |s: &str| -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() };
    let agent_w = wide(&format!("TidyAssistant/{}", env!("CARGO_PKG_VERSION")));
    let header_text = format!("Accept: {accept}\r\nCache-Control: no-cache\r\n");
    let header_w = wide(&header_text);

    for hop in 0..=MAX_REDIRECTS {
        if cancel.is_some_and(|c| c.load(Ordering::SeqCst)) {
            bail!("已取消更新下载");
        }
        let (secure, host, port, path) =
            validate_update_url(&current_url, hop > 0 && origin_remote_https)?;
        let local = is_local_host(&host);
        let access = if local {
            WINHTTP_ACCESS_TYPE_NO_PROXY
        } else {
            WINHTTP_ACCESS_TYPE_DEFAULT_PROXY
        };
        let host_w = wide(&host);
        let path_w = wide(&path);
        let method_w = wide("GET");

        let next_location: Option<String> = unsafe {
            let session = WinHttpOpen(agent_w.as_ptr(), access, ptr::null(), ptr::null(), 0);
            if session.is_null() {
                bail!("WinHTTP 初始化失败");
            }
            let step = (|| -> Result<Result<Option<String>, (u32, String)>> {
                WinHttpSetTimeouts(session, timeout, timeout, timeout, timeout);
                let connect = WinHttpConnect(session, host_w.as_ptr(), port, 0);
                if connect.is_null() {
                    bail!("无法连接更新服务器 {host}:{port}");
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
                    bail!("无法创建更新请求");
                }
                let inner = (|| -> Result<Result<Option<String>, (u32, String)>> {
                    // 禁用自动重定向：手动逐跳校验每跳 URL 协议，阻断 HTTPS -> HTTP 降级与回环 SSRF
                    let mut disable_redir: u32 = WINHTTP_DISABLE_REDIRECTS;
                    WinHttpSetOption(
                        request,
                        WINHTTP_OPTION_DISABLE_FEATURE,
                        &mut disable_redir as *mut _ as *mut c_void,
                        std::mem::size_of::<u32>() as u32,
                    );
                    if WinHttpSendRequest(
                        request,
                        header_w.as_ptr(),
                        u32::MAX,
                        ptr::null_mut(),
                        0,
                        0,
                        0,
                    ) == 0
                    {
                        bail!("连接更新服务器失败（请检查网络、代理或更新源地址）");
                    }
                    if WinHttpReceiveResponse(request, ptr::null_mut()) == 0 {
                        bail!("更新服务器无响应或连接超时");
                    }
                    let mut status: u32 = 0;
                    let mut slen = std::mem::size_of::<u32>() as u32;
                    WinHttpQueryHeaders(
                        request,
                        WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                        ptr::null(),
                        &mut status as *mut _ as *mut c_void,
                        &mut slen,
                        ptr::null_mut(),
                    );
                    if matches!(status, 301 | 302 | 303 | 307 | 308) {
                        let mut loc_bytes: u32 = 0;
                        WinHttpQueryHeaders(
                            request,
                            WINHTTP_QUERY_LOCATION,
                            ptr::null(),
                            ptr::null_mut(),
                            &mut loc_bytes,
                            ptr::null_mut(),
                        );
                        if loc_bytes == 0 || loc_bytes > 8192 {
                            bail!("服务器返回重定向但缺少有效 Location");
                        }
                        let mut wbuf = vec![0u16; (loc_bytes as usize / 2) + 2];
                        let mut actual = loc_bytes;
                        if WinHttpQueryHeaders(
                            request,
                            WINHTTP_QUERY_LOCATION,
                            ptr::null(),
                            wbuf.as_mut_ptr() as *mut c_void,
                            &mut actual,
                            ptr::null_mut(),
                        ) == 0
                        {
                            bail!("读取重定向地址失败");
                        }
                        let end = wbuf.iter().position(|&c| c == 0).unwrap_or(wbuf.len());
                        let loc = String::from_utf16_lossy(&wbuf[..end]).trim().to_string();
                        if loc.is_empty() {
                            bail!("重定向目标为空");
                        }
                        let resolved = if loc.starts_with("http://") || loc.starts_with("https://") {
                            loc
                        } else if loc.starts_with("//") {
                            let scheme = if secure { "https" } else { "http" };
                            format!("{scheme}:{loc}")
                        } else if loc.starts_with('/') {
                            let scheme = if secure { "https" } else { "http" };
                            let host_fmt = if host.contains(':') {
                                format!("[{host}]")
                            } else {
                                host.clone()
                            };
                            let default_p = if secure { 443 } else { 80 };
                            if port == default_p {
                                format!("{scheme}://{host_fmt}{loc}")
                            } else {
                                format!("{scheme}://{host_fmt}:{port}{loc}")
                            }
                        } else {
                            resolve_asset_url(&current_url, &loc)?
                        };
                        return Ok(Ok(Some(resolved)));
                    }

                    if status != 200 {
                        bail!("更新服务器返回 HTTP {status}");
                    }

                    // 读取可选 Content-Length（用于实时进度条）
                    let mut cl_buf = [0u16; 64];
                    let mut cl_bytes = (cl_buf.len() * 2) as u32;
                    let expected_len = if WinHttpQueryHeaders(
                        request,
                        WINHTTP_QUERY_CONTENT_LENGTH,
                        ptr::null(),
                        cl_buf.as_mut_ptr() as *mut c_void,
                        &mut cl_bytes,
                        ptr::null_mut(),
                    ) != 0
                    {
                        let end = cl_buf.iter().position(|&c| c == 0).unwrap_or(cl_buf.len());
                        String::from_utf16_lossy(&cl_buf[..end])
                            .trim()
                            .parse::<u64>()
                            .unwrap_or(0)
                    } else {
                        0
                    };
                    if expected_len > hard_cap_bytes {
                        bail!(
                            "更新文件体积过大（{} B，超过上限 {} B）",
                            expected_len,
                            hard_cap_bytes
                        );
                    }

                    let mut buf = vec![0u8; 64 * 1024];
                    let mut seen: u64 = 0;
                    loop {
                        if cancel.is_some_and(|c| c.load(Ordering::SeqCst)) {
                            bail!("已取消更新下载");
                        }
                        let mut available: u32 = 0;
                        if WinHttpQueryDataAvailable(request, &mut available) == 0 {
                            bail!("读取更新数据失败");
                        }
                        if available == 0 {
                            break;
                        }
                        let want = available.min(buf.len() as u32);
                        let mut got: u32 = 0;
                        if WinHttpReadData(
                            request,
                            buf.as_mut_ptr() as *mut c_void,
                            want,
                            &mut got,
                        ) == 0
                        {
                            bail!("读取更新数据中断");
                        }
                        if got == 0 {
                            break;
                        }
                        seen = seen.saturating_add(got as u64);
                        if seen > hard_cap_bytes {
                            bail!("下载体积超过安全上限（{} B）", hard_cap_bytes);
                        }
                        on_chunk(&buf[..got as usize], expected_len)?;
                    }
                    Ok(Err((status, current_url.clone())))
                })();
                WinHttpCloseHandle(request);
                WinHttpCloseHandle(connect);
                inner
            })();
            WinHttpCloseHandle(session);
            match step? {
                Ok(loc) => loc,
                Err(done) => return Ok(done),
            }
        };

        if let Some(next) = next_location {
            if hop == MAX_REDIRECTS {
                bail!("更新地址重定向次数过多（超过 {MAX_REDIRECTS} 次）");
            }
            current_url = next;
        } else {
            break;
        }
    }
    bail!("更新地址重定向次数过多")
}

// ---------------------------------------------------------------- 清单解析（兼容静态 latest.json + Tauri + GitHub Releases）

pub fn parse_sha256sums_text(text: &str) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    for line in text.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        let mut parts = t.splitn(2, |c: char| c.is_whitespace());
        let Some(hash) = parts.next() else { continue };
        let Some(rest) = parts.next() else { continue };
        let name = rest.trim().trim_start_matches('*').trim();
        if let Ok(norm) = normalize_sha256(hash) {
            if !name.is_empty() {
                map.insert(name.to_ascii_lowercase(), norm);
            }
        }
    }
    map
}

fn parse_asset_obj(manifest_url: &str, v: &Value) -> Result<ReleaseAsset> {
    let raw_url = v
        .get("url")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim();
    if raw_url.is_empty() {
        bail!("更新资产缺少 url 字段");
    }
    let url = resolve_asset_url(manifest_url, raw_url)?;
    let raw_file = v
        .get("file")
        .or_else(|| v.get("name"))
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            url.split('?')
                .next()
                .unwrap_or(&url)
                .rsplit('/')
                .next()
                .unwrap_or("")
        });
    let file = sanitize_file_name(raw_file)?;
    let sha_raw = v
        .get("sha256")
        .or_else(|| v.get("digest"))
        .and_then(|x| x.as_str())
        .unwrap_or("");
    let sha256 = normalize_sha256(sha_raw)?;
    let size = v.get("size").and_then(|x| x.as_u64()).unwrap_or(0);
    Ok(ReleaseAsset {
        file,
        url,
        size,
        sha256,
    })
}

/// 解析标准 `latest.json`（兼容 TidyAssistant 双产物 schema 与 Tauri `platforms.windows-x86_64`）。
pub fn parse_static_manifest(manifest_url: &str, v: &Value) -> Result<ReleaseManifest> {
    let version = v
        .get("version")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim()
        .trim_start_matches(['v', 'V'])
        .to_string();
    let _ = SemVer::parse(&version)?;

    let channel = v
        .get("channel")
        .and_then(|x| x.as_str())
        .unwrap_or("stable")
        .trim()
        .to_ascii_lowercase();
    let pub_date = v
        .get("pubDate")
        .or_else(|| v.get("pub_date"))
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let min_version = v
        .get("minVersion")
        .or_else(|| v.get("min_version"))
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let notes = v
        .get("notes")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();

    let mut installer = match v.get("installer") {
        Some(obj) if obj.is_object() => Some(parse_asset_obj(manifest_url, obj)?),
        _ => None,
    };
    let portable = match v.get("portable") {
        Some(obj) if obj.is_object() => Some(parse_asset_obj(manifest_url, obj)?),
        _ => None,
    };
    // 兼容 Tauri v2 `platforms["windows-x86_64"]` 写法（需带 sha256）
    if installer.is_none() {
        if let Some(win) = v
            .get("platforms")
            .and_then(|p| p.get("windows-x86_64"))
            .filter(|x| x.is_object())
        {
            installer = Some(parse_asset_obj(manifest_url, win)?);
        }
    }
    if installer.is_none() && portable.is_none() {
        bail!("更新清单未包含可用的 installer 或 portable 产物");
    }

    Ok(ReleaseManifest {
        version,
        channel: if channel.is_empty() { "stable".into() } else { channel },
        pub_date,
        min_version,
        notes,
        installer,
        portable,
        manifest_url: manifest_url.to_string(),
    })
}

/// 解析 GitHub Releases API JSON（支持 `/releases/latest` 单对象与 `/releases?per_page=8` 数组）。
/// 优先使用附件中的 `latest.json`，其次使用资产原生 `digest`（sha256）或 `SHA256SUMS.txt`。
#[cfg(windows)]
fn fetch_and_parse_manifest(feed_url: &str) -> Result<ReleaseManifest> {
    let (_status, bytes, final_url) =
        winhttp_fetch_bytes(feed_url, MAX_MANIFEST_BYTES, 15_000, "application/json, application/vnd.github+json")?;
    let raw_v: Value = serde_json::from_slice(&bytes).context("更新清单不是合法的 JSON 格式")?;

    // 支持 GitHub `/releases?per_page=8` 列表（beta 通道取最新一条非 draft 发布）
    let v = if let Some(arr) = raw_v.as_array() {
        arr.iter()
            .find(|item| !item.get("draft").and_then(|d| d.as_bool()).unwrap_or(false))
            .cloned()
            .context("当前仓库尚未发布任何公开版本")?
    } else {
        raw_v
    };

    // 判断是否为 GitHub Releases API 响应（含 tag_name + assets 数组）
    if v.get("tag_name").is_some() && v.get("assets").and_then(|a| a.as_array()).is_some() {
        let assets = v["assets"].as_array().unwrap();
        // 1. 若 Release 附件自带 latest.json，直接拉取它（最完整）
        if let Some(manifest_asset) = assets.iter().find(|a| {
            a.get("name")
                .and_then(|n| n.as_str())
                .is_some_and(|n| n.eq_ignore_ascii_case("latest.json"))
        }) {
            if let Some(dl) = manifest_asset.get("browser_download_url").and_then(|u| u.as_str()) {
                let (_, mbytes, murl) =
                    winhttp_fetch_bytes(dl, MAX_MANIFEST_BYTES, 15_000, "application/json")?;
                let mv: Value = serde_json::from_slice(&mbytes)
                    .context("GitHub Release 内的 latest.json 解析失败")?;
                return parse_static_manifest(&murl, &mv);
            }
        }
        // 2. 否则从 assets 直接装配（读取可选 SHA256SUMS.txt 补齐摘要）
        let mut sums = std::collections::HashMap::new();
        if let Some(sum_asset) = assets.iter().find(|a| {
            a.get("name")
                .and_then(|n| n.as_str())
                .is_some_and(|n| n.eq_ignore_ascii_case("SHA256SUMS.txt"))
        }) {
            if let Some(dl) = sum_asset.get("browser_download_url").and_then(|u| u.as_str()) {
                if let Ok((_, sbytes, _)) = winhttp_fetch_bytes(dl, 256 * 1024, 15_000, "text/plain") {
                    sums = parse_sha256sums_text(&String::from_utf8_lossy(&sbytes));
                }
            }
        }
        return parse_github_release(&final_url, &v, &sums);
    }

    parse_static_manifest(&final_url, &v)
}

pub fn parse_github_release(
    manifest_url: &str,
    v: &Value,
    sums: &std::collections::HashMap<String, String>,
) -> Result<ReleaseManifest> {
    let version = v
        .get("tag_name")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim()
        .trim_start_matches(['v', 'V'])
        .to_string();
    let _ = SemVer::parse(&version)?;
    let prerelease = v.get("prerelease").and_then(|x| x.as_bool()).unwrap_or(false);
    let pub_date = v
        .get("published_at")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let notes = v
        .get("body")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let assets = v
        .get("assets")
        .and_then(|a| a.as_array())
        .context("GitHub Release 缺少 assets 字段")?;

    let mut installer: Option<ReleaseAsset> = None;
    let mut portable: Option<ReleaseAsset> = None;

    for a in assets {
        let name = a.get("name").and_then(|x| x.as_str()).unwrap_or("").trim();
        let url = a
            .get("browser_download_url")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .trim();
        let size = a.get("size").and_then(|x| x.as_u64()).unwrap_or(0);
        if name.is_empty() || url.is_empty() {
            continue;
        }
        let low = name.to_ascii_lowercase();
        let is_inst = low.ends_with(".exe") && low.contains("setup");
        let is_port = low.ends_with(".zip") && (low.contains("便携") || low.contains("portable"));
        if !is_inst && !is_port {
            continue;
        }
        let sha_raw = a
            .get("digest")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string())
            .or_else(|| sums.get(&low).cloned())
            .unwrap_or_default();
        let Ok(sha256) = normalize_sha256(&sha_raw) else {
            continue;
        };
        let Ok(file) = sanitize_file_name(name) else {
            continue;
        };
        let item = ReleaseAsset {
            file,
            url: url.to_string(),
            size,
            sha256,
        };
        if is_inst && installer.is_none() {
            installer = Some(item);
        } else if is_port && portable.is_none() {
            portable = Some(item);
        }
    }

    if installer.is_none() && portable.is_none() {
        bail!("GitHub Release 中未找到带 SHA-256 摘要的安装包或便携包（请随包上传 latest.json 或 SHA256SUMS.txt）");
    }

    Ok(ReleaseManifest {
        version,
        channel: if prerelease { "beta".into() } else { "stable".into() },
        pub_date,
        min_version: String::new(),
        notes,
        installer,
        portable,
        manifest_url: manifest_url.to_string(),
    })
}

// ---------------------------------------------------------------- 配置读写

pub fn read_updater_config() -> UpdaterConfig {
    let _guard = CONFIG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let cfg = read_config();
    let u = cfg.get("updater");
    let def = UpdaterConfig::default();
    UpdaterConfig {
        channel: match u
            .and_then(|x| x.get("channel"))
            .and_then(|x| x.as_str())
            .unwrap_or("stable")
        {
            "beta" => "beta".into(),
            _ => "stable".into(),
        },
        auto_check: u
            .and_then(|x| x.get("auto_check").or_else(|| x.get("autoCheck")))
            .and_then(|x| x.as_bool())
            .unwrap_or(def.auto_check),
        ignored_version: u
            .and_then(|x| x.get("ignored_version").or_else(|| x.get("ignoredVersion")))
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .trim()
            .to_string(),
        last_check_at: u
            .and_then(|x| x.get("last_check_at").or_else(|| x.get("lastCheckAt")))
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .trim()
            .to_string(),
    }
}

pub fn save_updater_config(patch: Value) -> Result<UpdaterConfig, String> {
    let _guard = CONFIG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut cfg = read_config();
    let cur = cfg.get("updater").cloned().unwrap_or_else(|| json!({}));
    let mut next = UpdaterConfig {
        channel: match cur.get("channel").and_then(|x| x.as_str()).unwrap_or("stable") {
            "beta" => "beta".into(),
            _ => "stable".into(),
        },
        auto_check: cur.get("auto_check").and_then(|x| x.as_bool()).unwrap_or(true),
        ignored_version: cur
            .get("ignored_version")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .trim()
            .to_string(),
        last_check_at: cur
            .get("last_check_at")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .trim()
            .to_string(),
    };

    if let Some(obj) = patch.as_object() {
        if let Some(ch) = obj.get("channel").and_then(|x| x.as_str()) {
            next.channel = if ch == "beta" { "beta".into() } else { "stable".into() };
        }
        if let Some(ac) = obj
            .get("autoCheck")
            .or_else(|| obj.get("auto_check"))
            .and_then(|x| x.as_bool())
        {
            next.auto_check = ac;
        }
        if let Some(ig) = obj
            .get("ignoredVersion")
            .or_else(|| obj.get("ignored_version"))
            .and_then(|x| x.as_str())
        {
            next.ignored_version = ig.trim().to_string();
        }
        if let Some(lc) = obj
            .get("lastCheckAt")
            .or_else(|| obj.get("last_check_at"))
            .and_then(|x| x.as_str())
        {
            next.last_check_at = lc.trim().to_string();
        }
    }

    cfg["updater"] = json!({
        "channel": next.channel,
        "auto_check": next.auto_check,
        "ignored_version": next.ignored_version,
        "last_check_at": next.last_check_at,
    });
    write_config(&cfg)?;
    Ok(next)
}

fn dir_size_bytes(dir: &Path) -> u64 {
    let mut sum = 0u64;
    if let Ok(rd) = fs::read_dir(dir) {
        for ent in rd.flatten() {
            let p = ent.path();
            if let Ok(m) = fs::symlink_metadata(&p) {
                if m.file_type().is_symlink() {
                    continue;
                }
                if m.is_dir() {
                    sum = sum.saturating_add(dir_size_bytes(&p));
                } else {
                    sum = sum.saturating_add(m.len());
                }
            }
        }
    }
    sum
}

/// 清理旧版本更新缓存，始终只保留当前已下载的最新 1 份，防止磁盘体积膨胀。
fn sweep_old_updates(keep_dir: Option<&Path>) {
    let root = updates_dir();
    let Ok(rd) = fs::read_dir(&root) else { return };
    for ent in rd.flatten() {
        let p = ent.path();
        if keep_dir.is_some_and(|k| k == p) {
            continue;
        }
        if let Ok(m) = fs::symlink_metadata(&p) {
            if m.is_dir() && !m.file_type().is_symlink() {
                let _ = fs::remove_dir_all(&p);
            } else {
                let _ = fs::remove_file(&p);
            }
        }
    }
}

// ---------------------------------------------------------------- 核心业务流程

pub fn evaluate_manifest(
    current_version: &str,
    install_kind: &str,
    channel: &str,
    ignored_version: &str,
    manifest: &ReleaseManifest,
    staged: Option<StagedInfo>,
) -> Result<UpdateCheckResult> {
    let cur = SemVer::parse(current_version)?;
    let latest = SemVer::parse(&manifest.version)?;

    if !manifest.min_version.is_empty() {
        if let Ok(min_v) = SemVer::parse(&manifest.min_version) {
            if cur < min_v {
                bail!(
                    "当前版本 {current_version} 低于在线升级最低要求 {}，请手动下载完整安装包升级",
                    manifest.min_version
                );
            }
        }
    }

    let is_pre = latest.is_prerelease() || manifest.channel == "beta";
    let channel_allows = channel == "beta" || !is_pre;
    let has_update = latest > cur && channel_allows;
    let is_ignored = !ignored_version.is_empty() && ignored_version == manifest.version;

    // 优先匹配当前运行形态（安装版选 installer、便携版选 portable），缺省回退另一形态
    let (package_kind, asset) = if install_kind == "installer" {
        if let Some(a) = &manifest.installer {
            ("installer", a)
        } else if let Some(a) = &manifest.portable {
            ("portable", a)
        } else {
            bail!("清单缺少可下载产物");
        }
    } else if let Some(a) = &manifest.portable {
        ("portable", a)
    } else if let Some(a) = &manifest.installer {
        ("installer", a)
    } else {
        bail!("清单缺少可下载产物");
    };

    let matched_staged = staged.filter(|s| {
        s.version == manifest.version
            && s.sha256.eq_ignore_ascii_case(&asset.sha256)
            && Path::new(&s.path).is_file()
    });

    Ok(UpdateCheckResult {
        current_version: current_version.to_string(),
        latest_version: manifest.version.clone(),
        has_update,
        is_ignored,
        is_prerelease: is_pre,
        install_kind: install_kind.to_string(),
        package_kind: package_kind.to_string(),
        channel: manifest.channel.clone(),
        pub_date: manifest.pub_date.clone(),
        notes: manifest.notes.clone(),
        download_url: asset.url.clone(),
        file_name: asset.file.clone(),
        size: asset.size,
        sha256: asset.sha256.clone(),
        manifest_url: manifest.manifest_url.clone(),
        staged: matched_staged,
    })
}

/// 下载并校验更新包到 `<updates_root>\v<version>\<file_name>`。
#[cfg(windows)]
pub fn download_and_verify_to(
    updates_root: &Path,
    url: &str,
    expected_sha256: &str,
    expected_size: u64,
    version: &str,
    file_name: &str,
    package_kind: &str,
    cancel: &AtomicBool,
    app: Option<&AppHandle>,
) -> Result<StagedInfo> {
    let cur = SemVer::parse(env!("CARGO_PKG_VERSION"))?;
    let target_ver = SemVer::parse(version)?;
    if target_ver <= cur {
        bail!(
            "拒绝降级或重复安装：目标版本 {version} 不高于当前版本 {}",
            env!("CARGO_PKG_VERSION")
        );
    }
    let want_sha = normalize_sha256(expected_sha256)?;
    let safe_name = sanitize_file_name(file_name)?;
    validate_update_url(url, false)?;

    fs::create_dir_all(updates_root).context("无法创建更新缓存目录")?;
    let ver_dir = updates_root.join(format!("v{}", version.trim().trim_start_matches(['v', 'V'])));
    fs::create_dir_all(&ver_dir).context("无法创建版本更新目录")?;
    let final_path = ver_dir.join(&safe_name);

    // 若已存在同版本且哈希完全一致的已下载包，直接复用（零重复下载）
    if final_path.is_file() {
        if let Ok(verified) = Sha256Verifier.verify_file(&final_path, &want_sha, expected_size) {
            let size = fs::metadata(&final_path).map(|m| m.len()).unwrap_or(expected_size);
            verify_binary_magic(&final_path, package_kind)?;
            return Ok(StagedInfo {
                version: version.to_string(),
                package_kind: package_kind.to_string(),
                file_name: safe_name,
                path: final_path.to_string_lossy().to_string(),
                size,
                sha256: verified,
            });
        }
        let _ = fs::remove_file(&final_path);
    }

    let seq = PART_SEQ.fetch_add(1, Ordering::Relaxed);
    let part_path = ver_dir.join(format!("{safe_name}.{}.{seq}.part", std::process::id()));

    let emit_prog = |phase: &str, downloaded: u64, total: u64, speed_bps: u64| {
        let pct = if total > 0 {
            ((downloaded.saturating_mul(100)) / total).min(100) as u8
        } else {
            0
        };
        if let Some(a) = app {
            let _ = a.emit(
                "updater-progress",
                UpdaterProgressPayload {
                    phase: phase.to_string(),
                    downloaded,
                    total,
                    speed_bps,
                    percent: pct,
                    version: version.to_string(),
                },
            );
        }
    };

    emit_prog("downloading", 0, expected_size, 0);

    let dl_res = (|| -> Result<(u64, String)> {
        let mut file = File::create(&part_path)
            .with_context(|| format!("无法创建临时更新文件：{}", part_path.display()))?;
        let mut hasher = Sha256::new();
        let mut downloaded: u64 = 0;
        let mut total_hint = expected_size;
        let started = Instant::now();
        let mut last_emit = Instant::now();

        winhttp_stream_get(
            url,
            30_000,
            "application/octet-stream, */*",
            Some(cancel),
            MAX_UPDATE_BYTES,
            &mut |chunk, content_len| {
                file.write_all(chunk)?;
                hasher.update(chunk);
                downloaded = downloaded.saturating_add(chunk.len() as u64);
                if total_hint == 0 && content_len > 0 {
                    total_hint = content_len;
                }
                if last_emit.elapsed() >= Duration::from_millis(100) {
                    let secs = started.elapsed().as_secs_f64().max(0.05);
                    let speed = (downloaded as f64 / secs) as u64;
                    emit_prog("downloading", downloaded, total_hint, speed);
                    last_emit = Instant::now();
                }
                Ok(())
            },
        )?;
        file.sync_all()?;
        drop(file);

        emit_prog("verifying", downloaded, total_hint.max(downloaded), 0);
        if expected_size > 0 && downloaded != expected_size {
            bail!(
                "下载体积与清单不一致（期望 {} B，实际 {} B）",
                expected_size,
                downloaded
            );
        }
        let got_sha = hex_lower(&hasher.finalize());
        if got_sha != want_sha {
            bail!("更新包 SHA-256 校验失败（期望 {want_sha}，实际 {got_sha}）");
        }
        verify_binary_magic(&part_path, package_kind)?;
        Ok((downloaded, got_sha))
    })();

    let (downloaded, got_sha) = match dl_res {
        Ok(v) => v,
        Err(e) => {
            let _ = fs::remove_file(&part_path);
            emit_prog("error", 0, expected_size, 0);
            return Err(e);
        }
    };

    if let Err(e) = fs::rename(&part_path, &final_path) {
        let _ = fs::remove_file(&part_path);
        return Err(e).context("落盘更新包失败");
    }

    emit_prog("ready", downloaded, downloaded, 0);
    Ok(StagedInfo {
        version: version.to_string(),
        package_kind: package_kind.to_string(),
        file_name: safe_name,
        path: final_path.to_string_lossy().to_string(),
        size: downloaded,
        sha256: got_sha,
    })
}

/// 校验更新包二进制魔数：安装包必须为 PE (`MZ`)，便携包必须为 ZIP (`PK\x03\x04`)。
pub fn verify_binary_magic(path: &Path, package_kind: &str) -> Result<()> {
    let mut f = File::open(path).with_context(|| format!("无法打开更新包：{}", path.display()))?;
    let mut head = [0u8; 4];
    let n = f.read(&mut head)?;
    if package_kind == "installer" {
        if n < 2 || &head[..2] != b"MZ" {
            bail!("安装包文件头无效（非合法 Windows 可执行安装程序）");
        }
    } else if package_kind == "portable" {
        if n < 4 || &head[..4] != b"PK\x03\x04" {
            bail!("便携包文件头无效（非合法 ZIP 压缩包）");
        }
    } else {
        bail!("未知的更新包类型：{package_kind}");
    }
    Ok(())
}

/// 定位便携包解压后的实际程序根目录（兼容平铺与单层外壳目录），同时校验主程序与引擎完整存在。
pub fn find_portable_payload_root(stage_dir: &Path) -> Result<PathBuf> {
    let has_core = |d: &Path| {
        d.join("tidy-assistant.exe").is_file()
            && d.join("引擎").join("整理助手引擎.exe").is_file()
    };
    if has_core(stage_dir) {
        return Ok(stage_dir.to_path_buf());
    }
    let mut dirs = Vec::new();
    if let Ok(rd) = fs::read_dir(stage_dir) {
        for ent in rd.flatten() {
            let p = ent.path();
            if p.is_dir() {
                dirs.push(p);
            }
        }
    }
    if dirs.len() == 1 && has_core(&dirs[0]) {
        return Ok(dirs.remove(0));
    }
    bail!("便携更新包结构不完整：缺少 tidy-assistant.exe 或 引擎\\整理助手引擎.exe")
}

/// 校验安装前的已暂存文件仍位于受控更新目录内、严格高于当前版本且未被篡改（防 TOCTOU、降级与任意路径执行）。
pub fn validate_staged_before_install(updates_root: &Path, staged: &StagedInfo) -> Result<PathBuf> {
    let cur = SemVer::parse(env!("CARGO_PKG_VERSION"))?;
    let target = SemVer::parse(&staged.version)?;
    if target <= cur {
        bail!(
            "安全拦截：拒绝安装低于或等于当前版本的更新包（目标 v{}，当前 v{}）",
            staged.version,
            env!("CARGO_PKG_VERSION")
        );
    }
    let p = PathBuf::from(&staged.path);
    let canon_root = fs::canonicalize(updates_root)
        .with_context(|| format!("更新目录不可用：{}", updates_root.display()))?;
    let meta = fs::symlink_metadata(&p)
        .with_context(|| format!("已下载的更新包不存在：{}", p.display()))?;
    if meta.file_type().is_symlink() {
        bail!("拒绝执行符号链接更新包");
    }
    let canon_file = fs::canonicalize(&p)
        .with_context(|| format!("无法定位更新包：{}", p.display()))?;
    if !canon_file.starts_with(&canon_root) {
        bail!("安全拦截：更新包路径不在受控更新缓存目录内");
    }
    Sha256Verifier.verify_file(&canon_file, &staged.sha256, staged.size)?;
    verify_binary_magic(&canon_file, &staged.package_kind)?;
    Ok(canon_file)
}

#[cfg(windows)]
fn spawn_installer_bootstrap(installer_path: &Path, silent: bool) -> Result<()> {
    let cur_pid = std::process::id().to_string();
    let cur_exe = std::env::current_exe()
        .context("无法获取当前程序路径")?
        .to_string_lossy()
        .to_string();
    // 所有路径严格通过环境变量传递，杜绝任何命令行/PowerShell 字符串注入
    let script = if silent {
        r#"
$ErrorActionPreference = 'SilentlyContinue'
$pidVal = [int]$env:_TIDY_UPD_PID
for ($i = 0; $i -lt 150; $i++) {
  if (-not (Get-Process -Id $pidVal -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Milliseconds 100
}
$p = Start-Process -FilePath $env:_TIDY_UPD_FILE -ArgumentList '/S' -PassThru -Wait
if ($p -and $p.ExitCode -eq 0 -and (Test-Path -LiteralPath $env:_TIDY_UPD_EXE)) {
  Start-Process -FilePath $env:_TIDY_UPD_EXE
}
"#
    } else {
        r#"
$ErrorActionPreference = 'SilentlyContinue'
$pidVal = [int]$env:_TIDY_UPD_PID
for ($i = 0; $i -lt 150; $i++) {
  if (-not (Get-Process -Id $pidVal -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Milliseconds 100
}
Start-Process -FilePath $env:_TIDY_UPD_FILE
"#
    };
    Command::new("powershell")
        .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", script])
        .env("_TIDY_UPD_PID", cur_pid)
        .env("_TIDY_UPD_FILE", installer_path.to_string_lossy().to_string())
        .env("_TIDY_UPD_EXE", cur_exe)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .context("启动安装更新引导器失败")?;
    Ok(())
}

#[cfg(windows)]
fn spawn_portable_swap_bootstrap(payload_root: &Path, app_dir: &Path, backup_dir: &Path, stage_root: &Path) -> Result<()> {
    let cur_pid = std::process::id().to_string();
    let script = r#"
$ErrorActionPreference = 'Stop'
$pidVal = [int]$env:_TIDY_UPD_PID
$appDir = $env:_TIDY_UPD_APP
$srcDir = $env:_TIDY_UPD_SRC
$bakDir = $env:_TIDY_UPD_BAK
$stgDir = $env:_TIDY_UPD_STG

for ($i = 0; $i -lt 150; $i++) {
  if (-not (Get-Process -Id $pidVal -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Milliseconds 100
}
Start-Sleep -Milliseconds 250

try {
  if (Test-Path -LiteralPath $bakDir) { Remove-Item -LiteralPath $bakDir -Recurse -Force -ErrorAction SilentlyContinue }
  New-Item -ItemType Directory -Path $bakDir -Force | Out-Null

  # 1. 备份旧版程序与引擎，失败时可完整回滚
  $oldExe = Join-Path $appDir 'tidy-assistant.exe'
  if (Test-Path -LiteralPath $oldExe) {
    Copy-Item -LiteralPath $oldExe -Destination (Join-Path $bakDir 'tidy-assistant.exe') -Force
  }
  $oldEng = Join-Path $appDir '引擎'
  if (Test-Path -LiteralPath $oldEng) {
    Copy-Item -LiteralPath $oldEng -Destination (Join-Path $bakDir '引擎') -Recurse -Force
  }

  # 2. 替换新版核心文件（保留用户本地数据目录不受影响）
  $newExe = Join-Path $srcDir 'tidy-assistant.exe'
  Copy-Item -LiteralPath $newExe -Destination $oldExe -Force

  $newEng = Join-Path $srcDir '引擎'
  if (Test-Path -LiteralPath $newEng) {
    if (Test-Path -LiteralPath $oldEng) { Remove-Item -LiteralPath $oldEng -Recurse -Force }
    Copy-Item -LiteralPath $newEng -Destination $oldEng -Recurse -Force
  }
  $newTp = Join-Path $srcDir 'THIRD_PARTY.md'
  if (Test-Path -LiteralPath $newTp) {
    Copy-Item -LiteralPath $newTp -Destination (Join-Path $appDir 'THIRD_PARTY.md') -Force
  }
  Remove-Item -LiteralPath $bakDir -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $stgDir -Recurse -Force -ErrorAction SilentlyContinue
} catch {
  # 异常自动回滚旧版，确保软件绝不变砖
  try {
    $bakExe = Join-Path $bakDir 'tidy-assistant.exe'
    if (Test-Path -LiteralPath $bakExe) { Copy-Item -LiteralPath $bakExe -Destination (Join-Path $appDir 'tidy-assistant.exe') -Force }
    $bakEng = Join-Path $bakDir '引擎'
    if (Test-Path -LiteralPath $bakEng) {
      $oldEng = Join-Path $appDir '引擎'
      if (Test-Path -LiteralPath $oldEng) { Remove-Item -LiteralPath $oldEng -Recurse -Force -ErrorAction SilentlyContinue }
      Copy-Item -LiteralPath $bakEng -Destination $oldEng -Recurse -Force
    }
  } catch {}
} finally {
  $launch = Join-Path $appDir 'tidy-assistant.exe'
  if (Test-Path -LiteralPath $launch) {
    Start-Process -FilePath $launch
  }
}
"#;
    Command::new("powershell")
        .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", script])
        .env("_TIDY_UPD_PID", cur_pid)
        .env("_TIDY_UPD_APP", app_dir.to_string_lossy().to_string())
        .env("_TIDY_UPD_SRC", payload_root.to_string_lossy().to_string())
        .env("_TIDY_UPD_BAK", backup_dir.to_string_lossy().to_string())
        .env("_TIDY_UPD_STG", stage_root.to_string_lossy().to_string())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .context("启动便携版原子替换引导器失败")?;
    Ok(())
}

// ---------------------------------------------------------------- Tauri 命令接口

#[tauri::command]
pub fn updater_status(state: State<'_, UpdaterState>) -> UpdaterStatusSnapshot {
    let dir = updates_dir();
    let staged = state
        .staged
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .filter(|s| Path::new(&s.path).is_file());
    UpdaterStatusSnapshot {
        current_version: env!("CARGO_PKG_VERSION").to_string(),
        install_kind: detect_install_kind().to_string(),
        busy: state.busy.load(Ordering::SeqCst),
        config: read_updater_config(),
        releases_page: OFFICIAL_RELEASES_PAGE.to_string(),
        updates_dir: dir.to_string_lossy().to_string(),
        cache_bytes: dir_size_bytes(&dir),
        staged,
    }
}

#[tauri::command]
pub fn updater_config_get() -> UpdaterConfig {
    read_updater_config()
}

#[tauri::command]
pub fn updater_config_set(patch: Value) -> Result<UpdaterConfig, String> {
    save_updater_config(patch)
}

#[cfg(windows)]
fn fetch_official_manifest(channel: &str) -> Result<ReleaseManifest> {
    if let Some(local_feed) = dev_loopback_feed() {
        return fetch_and_parse_manifest(&local_feed);
    }
    let endpoints: &[&str] = if channel == "beta" {
        &[OFFICIAL_API_RELEASES_URL, OFFICIAL_FEED_URL]
    } else {
        &[OFFICIAL_FEED_URL, OFFICIAL_API_LATEST_URL]
    };
    let mut last_err = None;
    for ep in endpoints {
        match fetch_and_parse_manifest(ep) {
            Ok(m) => return Ok(m),
            Err(e) => last_err = Some(e),
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow::anyhow!("无法连接官方 GitHub 更新源，请检查网络或代理")))
}

#[tauri::command]
pub async fn updater_check(
    state: State<'_, UpdaterState>,
    channel: Option<String>,
) -> Result<UpdateCheckResult, String> {
    let cfg = read_updater_config();
    let ch = channel
        .map(|s| if s == "beta" { "beta".to_string() } else { "stable".to_string() })
        .unwrap_or(cfg.channel);
    let ignored = cfg.ignored_version;
    let staged = state.staged.lock().ok().and_then(|g| g.clone());

    let res = tauri::async_runtime::spawn_blocking(move || -> Result<UpdateCheckResult, String> {
        let manifest = fetch_official_manifest(&ch).map_err(|e| format!("{e:#}"))?;
        let mut res = evaluate_manifest(
            env!("CARGO_PKG_VERSION"),
            detect_install_kind(),
            &ch,
            &ignored,
            &manifest,
            staged,
        )
        .map_err(|e| format!("{e:#}"))?;
        // 重启后内存 staged 为空时，自动探测磁盘更新缓存是否已有哈希一致的同版本已下载包
        if res.has_update && res.staged.is_none() {
            let candidate = updates_dir()
                .join(format!("v{}", res.latest_version))
                .join(&res.file_name);
            if candidate.is_file() {
                if let Ok(verified) = Sha256Verifier.verify_file(&candidate, &res.sha256, res.size) {
                    if verify_binary_magic(&candidate, &res.package_kind).is_ok() {
                        let actual_size = fs::metadata(&candidate).map(|m| m.len()).unwrap_or(res.size);
                        res.staged = Some(StagedInfo {
                            version: res.latest_version.clone(),
                            package_kind: res.package_kind.clone(),
                            file_name: res.file_name.clone(),
                            path: candidate.to_string_lossy().to_string(),
                            size: actual_size,
                            sha256: verified,
                        });
                    }
                }
            }
        }
        let now = crate::clock();
        let _ = save_updater_config(json!({ "lastCheckAt": now }));
        append_log(
            "info",
            &format!(
                "检查更新：当前 {}，最新 {}，has_update={}",
                res.current_version, res.latest_version, res.has_update
            ),
        );
        Ok(res)
    })
    .await
    .map_err(|e| format!("检查更新任务失败：{e}"))??;
    if let Some(st_info) = res.staged.clone() {
        if let Ok(mut g) = state.staged.lock() {
            *g = Some(st_info);
        }
    }
    Ok(res)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn updater_download(
    app: AppHandle,
    state: State<'_, UpdaterState>,
    url: String,
    sha256: String,
    size: u64,
    version: String,
    file_name: String,
    package_kind: String,
) -> Result<StagedInfo, String> {
    if state
        .busy
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("当前已有更新下载正在进行中".into());
    }
    state.cancel.store(false, Ordering::SeqCst);
    let cancel = Arc::clone(&state.cancel);
    let app2 = app.clone();
    let res = tauri::async_runtime::spawn_blocking(move || {
        let root = updates_dir();
        let info = download_and_verify_to(
            &root,
            &url,
            &sha256,
            size,
            &version,
            &file_name,
            &package_kind,
            &cancel,
            Some(&app2),
        )
        .map_err(|e| format!("{e:#}"))?;
        let keep = Path::new(&info.path).parent().map(Path::to_path_buf);
        sweep_old_updates(keep.as_deref());
        Ok::<StagedInfo, String>(info)
    })
    .await
    .map_err(|e| format!("下载更新任务失败：{e}"));

    state.busy.store(false, Ordering::SeqCst);
    let info = res??;
    if let Ok(mut g) = state.staged.lock() {
        *g = Some(info.clone());
    }
    append_log(
        "info",
        &format!("更新包已下载并校验通过：v{} ({})", info.version, info.file_name),
    );
    Ok(info)
}

#[tauri::command]
pub fn updater_cancel(state: State<'_, UpdaterState>) -> bool {
    state.cancel.store(true, Ordering::SeqCst);
    true
}

#[tauri::command]
pub fn updater_clear_cache(state: State<'_, UpdaterState>) -> Result<bool, String> {
    if state.busy.load(Ordering::SeqCst) {
        return Err("更新下载进行中，请先取消后再清理缓存".into());
    }
    if let Ok(mut g) = state.staged.lock() {
        *g = None;
    }
    sweep_old_updates(None);
    Ok(true)
}

#[tauri::command]
pub async fn updater_install(
    app: AppHandle,
    state: State<'_, UpdaterState>,
    silent: Option<bool>,
) -> Result<bool, String> {
    if state
        .busy
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("更新任务正在进行中，请稍候".into());
    }
    let _guard = BusyGuard(&state.busy);
    let staged = state
        .staged
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .ok_or_else(|| "尚未下载已校验的更新包，请先下载更新".to_string())?;

    let staged_clone = staged.clone();
    let silent_flag = silent.unwrap_or(false);
    let prepared = tauri::async_runtime::spawn_blocking(move || -> Result<PathBuf, String> {
        let root = updates_dir();
        let file = validate_staged_before_install(&root, &staged_clone)
            .map_err(|e| format!("{e:#}"))?;
        if staged_clone.package_kind == "portable" {
            // 退出前先探测当前便携目录是否可写，避免退出后替换失败（如用户手动解压到了 Program Files）
            let probe = exe_dir().join(format!(".tidy_upd_probe_{}.tmp", std::process::id()));
            if let Err(e) = fs::write(&probe, b"ok") {
                return Err(format!(
                    "程序目录无写入权限（{e}），请先以管理员身份重启后再安装便携更新"
                ));
            }
            let _ = fs::remove_file(&probe);

            let stage_dir = root.join(format!("stage_{}", staged_clone.version));
            if stage_dir.exists() {
                let _ = fs::remove_dir_all(&stage_dir);
            }
            let p = Arc::new(Progress::detached());
            let c = Arc::new(TaskControl::default());
            archive::extract_archive(
                None,
                &file,
                &stage_dir,
                None,
                None,
                Overwrite::Overwrite,
                "performance",
                &p,
                &c,
            )
            .map_err(|e| format!("解压便携更新包失败：{e:#}"))?;
            let payload = find_portable_payload_root(&stage_dir).map_err(|e| format!("{e:#}"))?;
            Ok(payload)
        } else {
            Ok(file)
        }
    })
    .await
    .map_err(|e| format!("准备安装失败：{e}"))??;

    // 优雅收掉子进程与撤回缓存，避免更新替换时遇到文件锁
    app.state::<archive::ArchiveCtx>().clear_undo();
    if let Ok(mut g) = app.state::<AppState>().engine.lock() {
        if let Some(mut old) = g.take() {
            let _ = old.child.kill();
            let _ = old.child.wait();
        }
    }

    if staged.package_kind == "portable" {
        let root = updates_dir();
        let stage_dir = root.join(format!("stage_{}", staged.version));
        let backup_dir = root.join(format!("backup_{}", staged.version));
        spawn_portable_swap_bootstrap(&prepared, &exe_dir(), &backup_dir, &stage_dir)
            .map_err(|e| format!("{e:#}"))?;
    } else {
        spawn_installer_bootstrap(&prepared, silent_flag).map_err(|e| format!("{e:#}"))?;
    }

    append_log(
        "info",
        &format!("即将退出并安装更新 v{} ({})", staged.version, staged.package_kind),
    );
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(260));
        handle.exit(0);
    });
    Ok(true)
}

// ---------------------------------------------------------------- 单元测试（含真实本地 HTTP 端到端对抗测试）

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::net::TcpListener;

    #[test]
    fn semver_ordering_and_channel_anti_downgrade() {
        assert!(SemVer::parse("1.43.13").unwrap() > SemVer::parse("1.43.12").unwrap());
        assert!(SemVer::parse("v2.0.0").unwrap() > SemVer::parse("1.99.99").unwrap());
        assert!(SemVer::parse("1.44.0").unwrap() > SemVer::parse("1.44.0-beta.2").unwrap());
        assert!(SemVer::parse("1.44.0-beta.2").unwrap() > SemVer::parse("1.44.0-beta.1").unwrap());
        assert!(SemVer::parse("1.44.0-rc.1").unwrap() > SemVer::parse("1.44.0-beta.9").unwrap());
        assert!(SemVer::parse("bad").is_err());

        let m = ReleaseManifest {
            version: "1.44.0-beta.1".into(),
            channel: "beta".into(),
            pub_date: "2026-11-23".into(),
            min_version: String::new(),
            notes: "beta notes".into(),
            installer: Some(ReleaseAsset {
                file: "TidyAssistant_1.44.0_x64-setup.exe".into(),
                url: "https://example.com/a.exe".into(),
                size: 100,
                sha256: "a".repeat(64),
            }),
            portable: None,
            manifest_url: "https://example.com/latest.json".into(),
        };
        let stable_res = evaluate_manifest("1.43.12", "installer", "stable", "", &m, None).unwrap();
        assert!(!stable_res.has_update, "stable 通道不得推送 beta 预发布版");
        let beta_res = evaluate_manifest("1.43.12", "installer", "beta", "", &m, None).unwrap();
        assert!(beta_res.has_update, "beta 通道应识别 beta 预发布版");

        // 降级必须被拒绝
        let old = ReleaseManifest {
            version: "1.43.10".into(),
            channel: "stable".into(),
            ..m
        };
        let down = evaluate_manifest("1.43.12", "installer", "stable", "", &old, None).unwrap();
        assert!(!down.has_update, "旧版本绝不能提示更新");
    }

    #[test]
    fn url_security_blocks_remote_http_untrusted_hosts_and_downgrade_redirects() {
        assert!(validate_update_url(OFFICIAL_FEED_URL, false).is_ok());
        assert!(validate_update_url(OFFICIAL_API_LATEST_URL, false).is_ok());
        assert!(validate_update_url("https://objects.githubusercontent.com/github-production-release-asset/a.exe", false).is_ok());
        assert!(validate_update_url("http://127.0.0.1:18765/latest.json", false).is_ok());
        assert!(validate_update_url("http://localhost:18765/latest.json", false).is_ok());
        // 非官方第三方域名与非官方仓库路径一律拦截，防任意下载劫持
        assert!(validate_update_url("https://evil.com/latest.json", false).is_err());
        assert!(validate_update_url("https://fakegithub.com/latest.json", false).is_err());
        assert!(validate_update_url("https://github.com/attacker/malware/releases/download/v1/a.exe", false).is_err());
        assert!(validate_update_url("https://api.github.com/repos/attacker/malware/releases/latest", false).is_err());
        assert!(validate_update_url("https://github.com/3347567186/TidyAssistant/releases/latest/download/latest.json", false).is_err());
        assert!(validate_update_url("http://github.com/3347567186/QDisk/releases/latest/download/latest.json", false).is_err());
        assert!(validate_update_url("https://user:pass@github.com/latest.json", false).is_err());
        assert!(validate_update_url("https://github.com/a\r\nX: 1", false).is_err());
        // 远端 HTTPS 禁止重定向到 HTTP 或本机回环（防 SSRF + 降级攻击）
        assert!(validate_update_url("http://127.0.0.1:8080/a.exe", true).is_err());
        assert!(validate_update_url("https://127.0.0.1:8443/a.exe", true).is_err());
        assert!(validate_update_url("https://release-assets.githubusercontent.com/a.exe", true).is_ok());

        assert_eq!(
            resolve_asset_url("https://github.com/3347567186/QDisk/releases/latest/download/latest.json", "QDisk_1.0_x64-setup.exe").unwrap(),
            "https://github.com/3347567186/QDisk/releases/latest/download/QDisk_1.0_x64-setup.exe"
        );
    }

    #[test]
    fn filename_and_github_release_parsing() {
        assert!(sanitize_file_name("../evil.exe").is_err());
        assert!(sanitize_file_name("evil.bat").is_err());
        assert!(sanitize_file_name("TidyAssistant_9.9.9_x64-setup.exe").is_ok());
        assert!(sanitize_file_name("整理助手_9.9.9_便携版.zip").is_ok());

        let sha = "0123456789abcdef".repeat(4);
        let sums = parse_sha256sums_text(&format!("{sha}  TidyAssistant_9.9.9_x64-setup.exe\n"));
        let gh = json!({
            "tag_name": "v9.9.9",
            "prerelease": false,
            "published_at": "2026-11-23T17:00:00Z",
            "body": "新增在线更新",
            "assets": [
                {
                    "name": "TidyAssistant_9.9.9_x64-setup.exe",
                    "browser_download_url": "https://github.com/demo/app/releases/download/v9.9.9/TidyAssistant_9.9.9_x64-setup.exe",
                    "size": 12345
                }
            ]
        });
        let m = parse_github_release("https://api.github.com/repos/demo/app/releases/latest", &gh, &sums).unwrap();
        assert_eq!(m.version, "9.9.9");
        assert_eq!(m.installer.as_ref().unwrap().sha256, sha);
    }

    #[test]
    fn end_to_end_http_check_redirect_download_verify_and_tamper_guard() {
        // 构造真实含 MZ 头的测试安装包载荷
        let mut payload = b"MZ\x90\x00".to_vec();
        payload.extend_from_slice(&vec![0x5Au8; 64 * 1024]);
        let payload_sha = hex_lower(&Sha256::digest(&payload));
        let payload_len = payload.len() as u64;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let base = format!("http://127.0.0.1:{}", addr.port());
        let manifest_body = serde_json::to_vec(&json!({
            "schemaVersion": 1,
            "version": "9.9.9",
            "channel": "stable",
            "pubDate": "2026-11-23T17:00:00+08:00",
            "notes": "端到端联调版本",
            "installer": {
                "file": "TidyAssistant_9.9.9_x64-setup.exe",
                "url": format!("{base}/redir/setup.exe"),
                "size": payload_len,
                "sha256": payload_sha
            }
        }))
        .unwrap();

        let p_clone = payload.clone();
        let m_clone = manifest_body.clone();
        let srv = std::thread::spawn(move || {
            // 处理 4 次请求（latest.json + 302 跳转 + 真实下载 + 错哈希下载）
            for _ in 0..4 {
                let Ok((mut stream, _)) = listener.accept() else { break };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut req_line = String::new();
                let _ = reader.read_line(&mut req_line);
                // 消耗剩余请求头
                loop {
                    let mut h = String::new();
                    if reader.read_line(&mut h).unwrap_or(0) == 0 || h == "\r\n" || h == "\n" {
                        break;
                    }
                }
                let path = req_line.split_whitespace().nth(1).unwrap_or("/");
                if path == "/latest.json" {
                    let hdr = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        m_clone.len()
                    );
                    let _ = stream.write_all(hdr.as_bytes());
                    let _ = stream.write_all(&m_clone);
                } else if path == "/redir/setup.exe" {
                    let hdr = "HTTP/1.1 302 Found\r\nLocation: /bin/setup.exe\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                    let _ = stream.write_all(hdr.as_bytes());
                } else if path == "/bin/setup.exe" {
                    let hdr = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        p_clone.len()
                    );
                    let _ = stream.write_all(hdr.as_bytes());
                    let _ = stream.write_all(&p_clone);
                }
            }
        });

        // 1. 拉取并解析真实 HTTP latest.json
        let manifest = fetch_and_parse_manifest(&format!("{base}/latest.json")).unwrap();
        assert_eq!(manifest.version, "9.9.9");
        let check = evaluate_manifest("1.43.12", "installer", "stable", "", &manifest, None).unwrap();
        assert!(check.has_update);

        // 2. 跟随 302 跳转下载 + SHA-256 + MZ 魔数校验
        let root = std::env::temp_dir().join(format!(
            "tidy_upd_e2e_{}_{}",
            std::process::id(),
            PART_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let cancel = AtomicBool::new(false);
        let staged = download_and_verify_to(
            &root,
            &check.download_url,
            &check.sha256,
            check.size,
            &check.latest_version,
            &check.file_name,
            &check.package_kind,
            &cancel,
            None,
        )
        .unwrap();
        assert!(Path::new(&staged.path).is_file());
        assert!(validate_staged_before_install(&root, &staged).is_ok());

        // 3. 红队 TOCTOU 篡改检测：若磁盘上的已下载文件被篡改，安装前复核必须拦截
        let mut tampered = fs::read(&staged.path).unwrap();
        tampered[100] ^= 0xFF;
        fs::write(&staged.path, &tampered).unwrap();
        assert!(
            validate_staged_before_install(&root, &staged).is_err(),
            "磁盘更新包被篡改后，validate_staged_before_install 必须拦截"
        );

        // 4. 红队错哈希下载：必须报错且彻底删除 .part 临时文件
        let wrong_sha = "f".repeat(64);
        let err_root = root.join("bad_sha");
        assert!(download_and_verify_to(
            &err_root,
            &format!("{base}/bin/setup.exe"),
            &wrong_sha,
            payload_len,
            "9.9.9",
            "TidyAssistant_9.9.9_x64-setup.exe",
            "installer",
            &cancel,
            None,
        )
        .is_err());
        let has_part = fs::read_dir(err_root.join("v9.9.9"))
            .ok()
            .into_iter()
            .flatten()
            .flatten()
            .any(|e| e.file_name().to_string_lossy().ends_with(".part"));
        assert!(!has_part, "校验失败后不得残留 .part 文件");

        // 5. 红队边界：取消下载立即退出并清理 .part；便携包结构缺失引擎拦截；越界路径与降级拦截
        let pre_cancel = AtomicBool::new(true);
        assert!(download_and_verify_to(
            &root.join("cancelled"),
            &format!("{base}/bin/setup.exe"),
            &payload_sha,
            payload_len,
            "9.9.9",
            "TidyAssistant_9.9.9_x64-setup.exe",
            "installer",
            &pre_cancel,
            None,
        )
        .is_err());

        let bad_stage = root.join("stage_bad");
        fs::create_dir_all(&bad_stage).unwrap();
        fs::write(bad_stage.join("tidy-assistant.exe"), b"MZ").unwrap();
        assert!(
            find_portable_payload_root(&bad_stage).is_err(),
            "缺少 引擎\\整理助手引擎.exe 的残缺便携包必须拦截"
        );
        let good_stage = root.join("stage_good").join("整理助手_9.9.9_便携版");
        fs::create_dir_all(good_stage.join("引擎")).unwrap();
        fs::write(good_stage.join("tidy-assistant.exe"), b"MZ").unwrap();
        fs::write(good_stage.join("引擎").join("整理助手引擎.exe"), b"MZ").unwrap();
        assert_eq!(
            find_portable_payload_root(&root.join("stage_good")).unwrap(),
            good_stage
        );

        // 越界 staged 路径与降级版本号必须被 validate_staged_before_install 拒绝
        let outside = root.join("outside.exe");
        fs::write(&outside, &payload).unwrap();
        let escaped_staged = StagedInfo {
            version: "9.9.9".into(),
            package_kind: "installer".into(),
            file_name: "outside.exe".into(),
            path: outside.to_string_lossy().to_string(),
            size: payload_len,
            sha256: payload_sha.clone(),
        };
        assert!(validate_staged_before_install(&root.join("v9.9.9"), &escaped_staged).is_err());
        let downgrade_staged = StagedInfo {
            version: "1.0.0".into(),
            ..staged.clone()
        };
        assert!(validate_staged_before_install(&root, &downgrade_staged).is_err());

        let _ = srv.join();
        let _ = fs::remove_dir_all(&root);
    }
}
