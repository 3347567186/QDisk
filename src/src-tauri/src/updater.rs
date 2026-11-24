use std::ffi::c_void;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
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
pub const OFFICIAL_LATEST_REDIRECT_URL: &str =
    "https://github.com/3347567186/QDisk/releases/latest";
pub const OFFICIAL_API_LATEST_URL: &str =
    "https://api.github.com/repos/3347567186/QDisk/releases/latest";
pub const OFFICIAL_API_RELEASES_URL: &str =
    "https://api.github.com/repos/3347567186/QDisk/releases?per_page=8";
/// 零 API 限流官方发布 Atom 订阅源（覆盖正式版与 Beta 预发布版，规避未登录 `api.github.com` 403 限流）。
pub const OFFICIAL_RELEASES_ATOM_URL: &str =
    "https://github.com/3347567186/QDisk/releases.atom";
pub const OFFICIAL_RELEASES_PAGE: &str =
    "https://github.com/3347567186/QDisk/releases";
/// 远端历史版本日志（按需同步，带 20 条上限与独立超时）。
pub const OFFICIAL_API_CHANGELOG_URL: &str =
    "https://api.github.com/repos/3347567186/QDisk/releases?per_page=20";

/// 编译期内嵌完整变更记录，确保安装版与便携版在完全离线状态下也能秒开全部历史版本日志。
const EMBEDDED_CHANGELOG_MD: &str = include_str!("../../../docs/01-当前版/变更记录.md");

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

/// 将 WinHTTP 常见错误码映射为清晰可读的中文网络诊断信息。
pub fn describe_winhttp_error(code: u32) -> &'static str {
    match code {
        12002 => "连接或读取超时（WinHTTP 12002）",
        12007 => "DNS 无法解析更新服务器域名（WinHTTP 12007）",
        12015 => "代理身份验证失败（WinHTTP 12015）",
        12017 => "网络请求已取消（WinHTTP 12017）",
        12029 => "无法连接到更新服务器或代理端口（WinHTTP 12029）",
        12030 => "与更新服务器的连接被意外断开（WinHTTP 12030）",
        12031 => "与更新服务器的连接被重置（WinHTTP 12031）",
        12152 => "更新服务器返回了无效响应（WinHTTP 12152）",
        12175 => "TLS/HTTPS 安全握手失败（WinHTTP 12175）",
        12178 => "系统自动代理配置失败（WinHTTP 12178）",
        12180 => "无法发现系统代理脚本（WinHTTP 12180）",
        _ => "网络传输异常",
    }
}

/// 从 GitHub `/releases/latest` 的 302 Location 中安全提取合法发布标签（如 `v1.43.18`）。
pub fn extract_tag_from_release_location(loc: &str) -> Option<String> {
    let trimmed = loc.trim();
    let idx = trimmed.find("/releases/tag/")?;
    let rest = &trimmed[idx + "/releases/tag/".len()..];
    let tag = rest.split(['?', '#', '/']).next()?.trim();
    if tag.is_empty() || tag.len() > 64 {
        return None;
    }
    if !tag
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
    {
        return None;
    }
    let ver = tag.trim_start_matches(['v', 'V']);
    if SemVer::parse(ver).is_err() {
        return None;
    }
    Some(tag.to_string())
}

/// 从 GitHub `releases.atom` XML 中安全提取属于本仓库的有效 SemVer 发布标签，并按 SemVer 倒序排列（最高版本优先）。
/// 仅解析每个 `<entry>` 头部（截断 `<content>` / `<summary>` 正文）中的 `<link ... href="...">`，
/// 且强制校验精确仓库前缀，杜绝更新说明正文中的第三方链接或畸形标签劫持更新源。
pub fn extract_release_tags_from_atom(xml: &str) -> Vec<String> {
    const ABS_PREFIX: &str = "https://github.com/3347567186/QDisk/releases/tag/";
    const REL_PREFIX: &str = "/3347567186/QDisk/releases/tag/";
    let mut parsed: Vec<(SemVer, String)> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    let mut rest = xml;
    while let Some(entry_start) = rest.find("<entry") {
        let after_tag = &rest[entry_start + "<entry".len()..];
        let next_ch = after_tag.as_bytes().first().copied().unwrap_or(0);
        if !matches!(next_ch, b'>' | b' ' | b'\t' | b'\r' | b'\n') {
            rest = after_tag;
            continue;
        }
        let Some(gt) = after_tag.find('>') else {
            break;
        };
        let body_start = &after_tag[gt + 1..];
        let entry_body = match body_start.find("</entry>") {
            Some(end) => {
                rest = &body_start[end + "</entry>".len()..];
                &body_start[..end]
            }
            None => {
                rest = "";
                body_start
            }
        };

        // 截断正文内容（<content / <summary），绝不扫描发布说明 HTML 里的任意外链
        let header_end = [entry_body.find("<content"), entry_body.find("<summary")]
            .into_iter()
            .flatten()
            .min()
            .unwrap_or(entry_body.len());
        let header = &entry_body[..header_end];

        // 在 entry 头部查找所有 <link ...> 标签并解析独立的 href="..." / href='...' 属性
        let mut hrest = header;
        while let Some(lpos) = hrest.find("<link") {
            let after_l = &hrest[lpos + "<link".len()..];
            let lnext = after_l.as_bytes().first().copied().unwrap_or(0);
            if !matches!(lnext, b' ' | b'\t' | b'\r' | b'\n') {
                hrest = after_l;
                continue;
            }
            let Some(lend) = after_l.find('>') else {
                break;
            };
            let attrs = &after_l[..lend];
            hrest = &after_l[lend + 1..];

            let href = extract_xml_href_attr(attrs);
            let Some(href_val) = href else {
                continue;
            };
            let trimmed_href = href_val.trim();
            let prefix_ok = (trimmed_href.len() > ABS_PREFIX.len()
                && trimmed_href[..ABS_PREFIX.len()].eq_ignore_ascii_case(ABS_PREFIX))
                || (trimmed_href.len() > REL_PREFIX.len()
                    && trimmed_href[..REL_PREFIX.len()].eq_ignore_ascii_case(REL_PREFIX));
            if !prefix_ok {
                continue;
            }
            if let Some(tag) = extract_tag_from_release_location(trimmed_href) {
                let ver_str = tag.trim_start_matches(['v', 'V']);
                if let Ok(sv) = SemVer::parse(ver_str) {
                    let key = tag.to_ascii_lowercase();
                    if seen.insert(key) {
                        parsed.push((sv, tag));
                    }
                    // 每个 <entry> 仅采信首个合法本仓库发布链接，防止尾部杂链注入
                    break;
                }
            }
        }
    }

    parsed.sort_by(|a, b| b.0.cmp(&a.0));
    parsed.into_iter().map(|(_, t)| t).collect()
}

fn extract_xml_href_attr(attrs: &str) -> Option<&str> {
    let bytes = attrs.as_bytes();
    let mut i = 0;
    while i + 6 <= bytes.len() {
        let prev_is_ws = i == 0 || bytes[i - 1].is_ascii_whitespace();
        if prev_is_ws && bytes[i..].starts_with(b"href=") {
            let quote = bytes[i + 5];
            if quote == b'"' || quote == b'\'' {
                let start = i + 6;
                if let Some(rel_end) = attrs[start..].find(quote as char) {
                    return Some(&attrs[start..start + rel_end]);
                }
            }
        }
        i += 1;
    }
    None
}

#[cfg(windows)]
fn is_retryable_transport_err(msg: &str) -> bool {
    msg.contains("WinHTTP 12")
        || msg.contains("连接超时")
        || msg.contains("超时")
        || msg.contains("断开")
        || msg.contains("重置")
        || msg.contains("无法连接")
        || msg.contains("代理")
        || msg.contains("握手")
        || msg.contains("读取更新数据")
}

#[cfg(windows)]
fn is_dns_err(msg: &str) -> bool {
    msg.contains("WinHTTP 12007")
}

#[cfg(windows)]
fn winhttp_fetch_bytes(
    url: &str,
    max_bytes: usize,
    timeout_ms: u64,
    accept: &str,
) -> Result<(u32, Vec<u8>, String)> {
    let mut last_err = None;
    for attempt in 0..2 {
        let mut sink = Vec::new();
        let mut total_written = 0u64;
        match winhttp_stream_get(
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
        ) {
            Ok((status, final_url)) => return Ok((status, sink, final_url)),
            Err(e) => {
                let msg = format!("{e:#}");
                let retryable = is_retryable_transport_err(&msg) && !is_dns_err(&msg);
                last_err = Some(e);
                if attempt == 0 && retryable {
                    std::thread::sleep(Duration::from_millis(350));
                    continue;
                }
                break;
            }
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow::anyhow!("获取更新清单失败")))
}

/// 先尝试系统自动代理（识别 Windows 系统代理 / Clash / v2rayN / PAC），
/// 若遇代理或连接类错误则自动回退直连，规避 `DEFAULT_PROXY` 读不到系统代理或僵尸代理端口卡死的问题。
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
    let (_, init_host, _, _) = validate_update_url(initial_url, false)?;
    if is_local_host(&init_host) {
        return winhttp_stream_get_with_proxy(
            initial_url,
            timeout_ms,
            accept,
            cancel,
            hard_cap_bytes,
            false,
            on_chunk,
        );
    }
    let mut received_any = false;
    let first = winhttp_stream_get_with_proxy(
        initial_url,
        timeout_ms,
        accept,
        cancel,
        hard_cap_bytes,
        true,
        &mut |chunk, expected| {
            received_any = true;
            on_chunk(chunk, expected)
        },
    );
    match first {
        Ok(ok) => Ok(ok),
        Err(err) => {
            if received_any || cancel.is_some_and(|c| c.load(Ordering::SeqCst)) {
                return Err(err);
            }
            let msg = format!("{err:#}");
            if !is_retryable_transport_err(&msg) {
                return Err(err);
            }
            append_log("warn", &format!("更新请求自动代理模式失败，切换直连重试：{msg}"));
            winhttp_stream_get_with_proxy(
                initial_url,
                timeout_ms,
                accept,
                cancel,
                hard_cap_bytes,
                false,
                on_chunk,
            )
            .map_err(|direct_err| {
                anyhow::anyhow!("{direct_err:#}（自动代理模式：{msg}）")
            })
        }
    }
}

#[cfg(windows)]
fn winhttp_stream_get_with_proxy<F>(
    initial_url: &str,
    timeout_ms: u64,
    accept: &str,
    cancel: Option<&AtomicBool>,
    hard_cap_bytes: u64,
    use_auto_proxy: bool,
    on_chunk: &mut F,
) -> Result<(u32, String)>
where
    F: FnMut(&[u8], u64) -> Result<()>,
{
    use windows_sys::Win32::Foundation::GetLastError;
    use windows_sys::Win32::Networking::WinHttp::{
        WinHttpCloseHandle, WinHttpConnect, WinHttpOpen, WinHttpOpenRequest,
        WinHttpQueryDataAvailable, WinHttpQueryHeaders, WinHttpReadData, WinHttpReceiveResponse,
        WinHttpSendRequest, WinHttpSetOption, WinHttpSetTimeouts,
        WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_ACCESS_TYPE_NO_PROXY,
        WINHTTP_DISABLE_REDIRECTS, WINHTTP_FLAG_SECURE, WINHTTP_OPTION_DISABLE_FEATURE,
        WINHTTP_OPTION_SECURE_PROTOCOLS, WINHTTP_QUERY_CONTENT_LENGTH,
        WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_QUERY_LOCATION, WINHTTP_QUERY_STATUS_CODE,
    };

    const WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_2: u32 = 0x0000_0800;
    const WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_3: u32 = 0x0000_2000;

    let (init_sec, init_host, _, _) = validate_update_url(initial_url, false)?;
    let origin_remote_https = init_sec && !is_local_host(&init_host);
    let mut current_url = initial_url.trim().to_string();
    let timeout = timeout_ms.clamp(2000, 180_000) as i32;
    let wide = |s: &str| -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() };
    let agent_w = wide(&format!("TidyAssistant/{}", env!("CARGO_PKG_VERSION")));
    let header_text = format!(
        "Accept: {accept}\r\nCache-Control: no-cache\r\nX-GitHub-Api-Version: 2022-11-28\r\n"
    );
    let header_w = wide(&header_text);

    for hop in 0..=MAX_REDIRECTS {
        if cancel.is_some_and(|c| c.load(Ordering::SeqCst)) {
            bail!("已取消更新下载");
        }
        let (secure, host, port, path) =
            validate_update_url(&current_url, hop > 0 && origin_remote_https)?;
        let local = is_local_host(&host);
        let access = if local || !use_auto_proxy {
            WINHTTP_ACCESS_TYPE_NO_PROXY
        } else {
            WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY
        };
        let host_w = wide(&host);
        let path_w = wide(&path);
        let method_w = wide("GET");

        let next_location: Option<String> = unsafe {
            let session = WinHttpOpen(agent_w.as_ptr(), access, ptr::null(), ptr::null(), 0);
            if session.is_null() {
                let code = GetLastError();
                bail!("WinHTTP 初始化失败：{}（错误码 {code}）", describe_winhttp_error(code));
            }
            let step = (|| -> Result<Result<Option<String>, (u32, String)>> {
                WinHttpSetTimeouts(session, timeout, timeout, timeout, timeout);
                // 显式启用 TLS 1.2 + 1.3（老系统不支持 1.3 时自动回退 1.2），消除 12175 握手异常
                let mut protos = WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_2 | WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_3;
                if WinHttpSetOption(
                    session,
                    WINHTTP_OPTION_SECURE_PROTOCOLS,
                    &mut protos as *mut _ as *mut c_void,
                    std::mem::size_of::<u32>() as u32,
                ) == 0
                {
                    let mut tls12 = WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_2;
                    let _ = WinHttpSetOption(
                        session,
                        WINHTTP_OPTION_SECURE_PROTOCOLS,
                        &mut tls12 as *mut _ as *mut c_void,
                        std::mem::size_of::<u32>() as u32,
                    );
                }
                let connect = WinHttpConnect(session, host_w.as_ptr(), port, 0);
                if connect.is_null() {
                    let code = GetLastError();
                    bail!("无法连接更新服务器 {host}:{port}：{}（{code}）", describe_winhttp_error(code));
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
                        let code = GetLastError();
                        bail!("连接更新服务器失败：{}（错误码 {code}）", describe_winhttp_error(code));
                    }
                    if WinHttpReceiveResponse(request, ptr::null_mut()) == 0 {
                        let code = GetLastError();
                        bail!("更新服务器无响应：{}（错误码 {code}）", describe_winhttp_error(code));
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

                    if status == 403 || status == 429 {
                        bail!("更新服务器触发访问限流（HTTP {status}）");
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

#[cfg(windows)]
fn probe_latest_tag_via_redirect(timeout_ms: u64) -> Result<String> {
    use windows_sys::Win32::Foundation::GetLastError;
    use windows_sys::Win32::Networking::WinHttp::{
        WinHttpCloseHandle, WinHttpConnect, WinHttpOpen, WinHttpOpenRequest, WinHttpQueryHeaders,
        WinHttpReceiveResponse, WinHttpSendRequest, WinHttpSetOption, WinHttpSetTimeouts,
        WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_ACCESS_TYPE_NO_PROXY,
        WINHTTP_DISABLE_REDIRECTS, WINHTTP_FLAG_SECURE, WINHTTP_OPTION_DISABLE_FEATURE,
        WINHTTP_OPTION_SECURE_PROTOCOLS, WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_QUERY_LOCATION,
        WINHTTP_QUERY_STATUS_CODE,
    };
    const TLS12: u32 = 0x0000_0800;
    const TLS13: u32 = 0x0000_2000;

    let (secure, host, port, path) = validate_update_url(OFFICIAL_LATEST_REDIRECT_URL, false)?;
    let wide = |s: &str| -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() };
    let agent_w = wide(&format!("TidyAssistant/{}", env!("CARGO_PKG_VERSION")));
    let host_w = wide(&host);
    let path_w = wide(&path);
    let method_w = wide("GET");
    let timeout = timeout_ms.clamp(2000, 30_000) as i32;

    let mut last_err = None;
    for use_auto in [true, false] {
        let access = if use_auto {
            WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY
        } else {
            WINHTTP_ACCESS_TYPE_NO_PROXY
        };
        let res = unsafe {
            let session = WinHttpOpen(agent_w.as_ptr(), access, ptr::null(), ptr::null(), 0);
            if session.is_null() {
                Err(anyhow::anyhow!("WinHTTP 初始化失败"))
            } else {
                let out = (|| -> Result<String> {
                    WinHttpSetTimeouts(session, timeout, timeout, timeout, timeout);
                    let mut protos = TLS12 | TLS13;
                    if WinHttpSetOption(
                        session,
                        WINHTTP_OPTION_SECURE_PROTOCOLS,
                        &mut protos as *mut _ as *mut c_void,
                        std::mem::size_of::<u32>() as u32,
                    ) == 0
                    {
                        let mut p12 = TLS12;
                        let _ = WinHttpSetOption(
                            session,
                            WINHTTP_OPTION_SECURE_PROTOCOLS,
                            &mut p12 as *mut _ as *mut c_void,
                            std::mem::size_of::<u32>() as u32,
                        );
                    }
                    let connect = WinHttpConnect(session, host_w.as_ptr(), port, 0);
                    if connect.is_null() {
                        let code = GetLastError();
                        bail!("无法连接 GitHub：{}（{code}）", describe_winhttp_error(code));
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
                        bail!("无法创建标签探测请求");
                    }
                    let inner = (|| -> Result<String> {
                        let mut disable_redir: u32 = WINHTTP_DISABLE_REDIRECTS;
                        WinHttpSetOption(
                            request,
                            WINHTTP_OPTION_DISABLE_FEATURE,
                            &mut disable_redir as *mut _ as *mut c_void,
                            std::mem::size_of::<u32>() as u32,
                        );
                        if WinHttpSendRequest(request, ptr::null(), 0, ptr::null_mut(), 0, 0, 0) == 0 {
                            let code = GetLastError();
                            bail!("探测最新版本失败：{}（{code}）", describe_winhttp_error(code));
                        }
                        if WinHttpReceiveResponse(request, ptr::null_mut()) == 0 {
                            let code = GetLastError();
                            bail!("探测最新版本超时：{}（{code}）", describe_winhttp_error(code));
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
                        if !matches!(status, 301 | 302 | 303 | 307 | 308) {
                            bail!("未获得版本重定向（HTTP {status}）");
                        }
                        let mut loc_bytes: u32 = 0;
                        WinHttpQueryHeaders(
                            request,
                            WINHTTP_QUERY_LOCATION,
                            ptr::null(),
                            ptr::null_mut(),
                            &mut loc_bytes,
                            ptr::null_mut(),
                        );
                        if loc_bytes == 0 || loc_bytes > 4096 {
                            bail!("重定向缺少有效 Location");
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
                            bail!("读取版本重定向地址失败");
                        }
                        let end = wbuf.iter().position(|&c| c == 0).unwrap_or(wbuf.len());
                        let loc = String::from_utf16_lossy(&wbuf[..end]);
                        extract_tag_from_release_location(&loc)
                            .context("无法从重定向地址解析最新版本号")
                    })();
                    WinHttpCloseHandle(request);
                    WinHttpCloseHandle(connect);
                    inner
                })();
                WinHttpCloseHandle(session);
                out
            }
        };
        match res {
            Ok(tag) => return Ok(tag),
            Err(e) => {
                let msg = format!("{e:#}");
                last_err = Some(e);
                if !is_retryable_transport_err(&msg) {
                    break;
                }
            }
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow::anyhow!("无法探测最新版本标签")))
}

/// 解析 GitHub Releases API JSON（支持 `/releases/latest` 单对象与 `/releases?per_page=8` 数组）。
/// 优先使用附件中的 `latest.json`（拉取失败时自动平滑降级到 API 原生 assets + digest / SHA256SUMS.txt）。
#[cfg(windows)]
fn fetch_and_parse_manifest(feed_url: &str) -> Result<ReleaseManifest> {
    let (_status, bytes, final_url) =
        winhttp_fetch_bytes(feed_url, MAX_MANIFEST_BYTES, 9_000, "application/json, application/vnd.github+json")?;
    let raw_v: Value = serde_json::from_slice(&bytes).context("更新清单不是合法的 JSON 格式")?;

    // 支持 GitHub `/releases?per_page=8` 列表（beta 通道取最高 SemVer 的公开非 draft 发布，防老分支热修复时间倒挂）
    let v = if let Some(arr) = raw_v.as_array() {
        let non_drafts: Vec<&Value> = arr
            .iter()
            .filter(|item| !item.get("draft").and_then(|d| d.as_bool()).unwrap_or(false))
            .collect();
        non_drafts
            .iter()
            .filter_map(|item| {
                let tag = item.get("tag_name").and_then(|t| t.as_str())?;
                let sv = SemVer::parse(tag.trim().trim_start_matches(['v', 'V'])).ok()?;
                Some((sv, *item))
            })
            .max_by(|a, b| a.0.cmp(&b.0))
            .map(|(_, item)| item.clone())
            .or_else(|| non_drafts.first().map(|item| (*item).clone()))
            .context("当前仓库尚未发布任何公开版本")?
    } else {
        raw_v
    };

    // 判断是否为 GitHub Releases API 响应（含 tag_name + assets 数组）
    if v.get("tag_name").is_some() && v.get("assets").and_then(|a| a.as_array()).is_some() {
        let assets = v["assets"].as_array().unwrap();
        // 1. 若 Release 附件自带 latest.json，优先拉取它；若附件拉取失败不直接报错，平滑降级到 API 资产列表
        if let Some(manifest_asset) = assets.iter().find(|a| {
            a.get("name")
                .and_then(|n| n.as_str())
                .is_some_and(|n| n.eq_ignore_ascii_case("latest.json"))
        }) {
            if let Some(dl) = manifest_asset.get("browser_download_url").and_then(|u| u.as_str()) {
                match winhttp_fetch_bytes(dl, MAX_MANIFEST_BYTES, 9_000, "application/json")
                    .and_then(|(_, mbytes, murl)| {
                        let mv: Value = serde_json::from_slice(&mbytes)
                            .context("GitHub Release 内的 latest.json 解析失败")?;
                        parse_static_manifest(&murl, &mv)
                    }) {
                    Ok(m) => return Ok(m),
                    Err(e) => {
                        append_log("warn", &format!("附件 latest.json 拉取失败，降级解析 API 资产列表：{e:#}"));
                    }
                }
            }
        }
        // 2. 从 assets 直接装配（读取可选 SHA256SUMS.txt 补齐摘要）
        let mut sums = std::collections::HashMap::new();
        if let Some(sum_asset) = assets.iter().find(|a| {
            a.get("name")
                .and_then(|n| n.as_str())
                .is_some_and(|n| n.eq_ignore_ascii_case("SHA256SUMS.txt"))
        }) {
            if let Some(dl) = sum_asset.get("browser_download_url").and_then(|u| u.as_str()) {
                if let Ok((_, sbytes, _)) = winhttp_fetch_bytes(dl, 256 * 1024, 9_000, "text/plain") {
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
    $oldLoc = Join-Path $oldEng '数据位置.json'
    $savedLoc = Join-Path $bakDir '数据位置.json'
    if (Test-Path -LiteralPath $oldLoc) { Copy-Item -LiteralPath $oldLoc -Destination $savedLoc -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $oldEng) { Remove-Item -LiteralPath $oldEng -Recurse -Force }
    Copy-Item -LiteralPath $newEng -Destination $oldEng -Recurse -Force
    if (Test-Path -LiteralPath $savedLoc) { Copy-Item -LiteralPath $savedLoc -Destination (Join-Path $oldEng '数据位置.json') -Force -ErrorAction SilentlyContinue }
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

/// Atom 探测结果：
/// - `Primary(m)`: 最高 SemVer 标签直接命中有效 `latest.json`（零 API 限流，直接返回）
/// - `FallbackOnly(m)`: 最高标签缺失或版本不匹配，但次高标签有效（保留作兜底，先给 API 通道一次装配最高标签的机会）
#[cfg(windows)]
enum AtomBetaFetch {
    Primary(ReleaseManifest),
    FallbackOnly(ReleaseManifest),
}

#[cfg(windows)]
fn fetch_beta_manifest_via_atom(
    atom_url: &str,
    download_base_prefix: &str,
) -> Result<AtomBetaFetch> {
    let (_status, bytes, _final_url) = winhttp_fetch_bytes(
        atom_url,
        MAX_MANIFEST_BYTES,
        9_000,
        "application/atom+xml, application/xml, text/xml",
    )?;
    let xml = String::from_utf8_lossy(&bytes);
    let tags = extract_release_tags_from_atom(&xml);
    if tags.is_empty() {
        bail!("官方发布订阅未包含有效版本标签");
    }

    let prefix = download_base_prefix.trim_end_matches('/');
    let mut last_err: Option<anyhow::Error> = None;
    for (idx, tag) in tags.into_iter().take(3).enumerate() {
        let direct_url = format!("{prefix}/{tag}/latest.json");
        match fetch_and_parse_manifest(&direct_url) {
            Ok(manifest) => {
                let tag_sv = SemVer::parse(tag.trim_start_matches(['v', 'V'])).ok();
                let mf_sv = SemVer::parse(&manifest.version).ok();
                if tag_sv.is_some() && mf_sv.is_some() && tag_sv != mf_sv {
                    let msg = format!(
                        "标签 {tag} 下的 latest.json 版本号不匹配（实际为 {}），已跳过",
                        manifest.version
                    );
                    append_log("warn", &msg);
                    last_err = Some(anyhow::anyhow!(msg));
                    continue;
                }
                return Ok(if idx == 0 {
                    AtomBetaFetch::Primary(manifest)
                } else {
                    AtomBetaFetch::FallbackOnly(manifest)
                });
            }
            Err(e) => {
                let msg = format!("{e:#}");
                if is_dns_err(&msg) {
                    return Err(e);
                }
                append_log("warn", &format!("Atom 候选标签 {tag} 拉取 latest.json 失败：{msg}"));
                last_err = Some(e);
            }
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow::anyhow!("Atom 候选发布均缺少有效 latest.json")))
}

#[cfg(windows)]
fn fetch_official_manifest<F>(channel: &str, mut on_stage: F) -> Result<ReleaseManifest>
where
    F: FnMut(&str, u8),
{
    if let Some(local_feed) = dev_loopback_feed() {
        on_stage("正在连接本地调试更新源…", 40);
        return fetch_and_parse_manifest(&local_feed);
    }
    let mut errors: Vec<String> = Vec::new();
    let mut saw_dns_fail = false;

    if channel == "beta" {
        let mut atom_fallback: Option<ReleaseManifest> = None;
        on_stage("正在查询官方预发布订阅源 (1/3)…", 25);
        match fetch_beta_manifest_via_atom(
            OFFICIAL_RELEASES_ATOM_URL,
            "https://github.com/3347567186/QDisk/releases/download",
        ) {
            Ok(AtomBetaFetch::Primary(m)) => return Ok(m),
            Ok(AtomBetaFetch::FallbackOnly(m)) => {
                atom_fallback = Some(m);
            }
            Err(e) => {
                let msg = format!("{e:#}");
                saw_dns_fail |= is_dns_err(&msg);
                append_log("warn", &format!("更新通道 beta-atom 失败：{msg}"));
                errors.push(msg);
            }
        }
        if !saw_dns_fail {
            on_stage("正在切换 GitHub Releases API 重试 (2/3)…", 55);
            match fetch_and_parse_manifest(OFFICIAL_API_RELEASES_URL) {
                Ok(m) => {
                    if let Some(fb) = atom_fallback {
                        let m_sv = SemVer::parse(&m.version).ok();
                        let fb_sv = SemVer::parse(&fb.version).ok();
                        if fb_sv > m_sv {
                            return Ok(fb);
                        }
                    }
                    return Ok(m);
                }
                Err(e) => {
                    let msg = format!("{e:#}");
                    saw_dns_fail |= is_dns_err(&msg);
                    append_log("warn", &format!("更新通道 beta-api 失败：{msg}"));
                    errors.push(msg);
                }
            }
        }
        if let Some(fb) = atom_fallback {
            return Ok(fb);
        }
        if !saw_dns_fail {
            on_stage("正在切换官方正式版清单兜底 (3/3)…", 80);
            match fetch_and_parse_manifest(OFFICIAL_FEED_URL) {
                Ok(m) => return Ok(m),
                Err(e) => {
                    let msg = format!("{e:#}");
                    append_log("warn", &format!("更新通道 beta-feed 失败：{msg}"));
                    errors.push(msg);
                }
            }
        }
    } else {
        on_stage("正在连接官方更新清单 (1/3)…", 25);
        match fetch_and_parse_manifest(OFFICIAL_FEED_URL) {
            Ok(m) => return Ok(m),
            Err(e) => {
                let msg = format!("{e:#}");
                saw_dns_fail |= is_dns_err(&msg);
                append_log("warn", &format!("更新通道 primary-feed 失败：{msg}"));
                errors.push(msg);
            }
        }

        if !saw_dns_fail {
            on_stage("主源响应异常，正在通过标签直链重试 (2/3)…", 55);
            match probe_latest_tag_via_redirect(8_000).and_then(|tag| {
                let direct_url = format!(
                    "https://github.com/3347567186/QDisk/releases/download/{tag}/latest.json"
                );
                fetch_and_parse_manifest(&direct_url)
            }) {
                Ok(m) => return Ok(m),
                Err(e) => {
                    let msg = format!("{e:#}");
                    saw_dns_fail |= is_dns_err(&msg);
                    append_log("warn", &format!("更新通道 tag-direct 失败：{msg}"));
                    errors.push(msg);
                }
            }
        }

        if !saw_dns_fail {
            on_stage("正在切换 GitHub Releases API 备用通道 (3/3)…", 80);
            match fetch_and_parse_manifest(OFFICIAL_API_LATEST_URL) {
                Ok(m) => return Ok(m),
                Err(e) => {
                    let msg = format!("{e:#}");
                    append_log("warn", &format!("更新通道 github-api 失败：{msg}"));
                    errors.push(msg);
                }
            }
        }
    }

    if saw_dns_fail {
        bail!("无法解析 GitHub 域名（DNS 失败），请检查网络连接或系统代理设置");
    }
    let summary = errors.into_iter().next().unwrap_or_else(|| "网络不可达".into());
    bail!("获取更新失败：{summary}（可检查网络/系统代理后重试，或点击「查看发布页」手动下载）")
}

#[tauri::command]
pub async fn updater_check(
    app: AppHandle,
    state: State<'_, UpdaterState>,
    channel: Option<String>,
) -> Result<UpdateCheckResult, String> {
    let cfg = read_updater_config();
    let ch = channel
        .map(|s| if s == "beta" { "beta".to_string() } else { "stable".to_string() })
        .unwrap_or(cfg.channel);
    let ignored = cfg.ignored_version;
    let staged = state.staged.lock().ok().and_then(|g| g.clone());
    let app2 = app.clone();

    let res = tauri::async_runtime::spawn_blocking(move || -> Result<UpdateCheckResult, String> {
        let emit_check = |stage: &str, percent: u8| {
            let _ = app2.emit(
                "updater-check-progress",
                json!({ "stage": stage, "percent": percent }),
            );
        };
        emit_check("正在准备检查更新…", 10);
        let manifest = fetch_official_manifest(&ch, |stage, pct| emit_check(stage, pct))
            .map_err(|e| format!("{e:#}"))?;
        emit_check("正在核验版本信息…", 92);
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

// ---------------------------------------------------------------- 更新日志与历史版本解析（离线内置 + 可选远端同步 + 隐私红线脱敏）

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangelogEntry {
    pub id: String,
    pub version: String,
    pub kind: String,
    pub title: String,
    pub summary: String,
    pub body: String,
    pub date: String,
    pub is_current: bool,
    pub is_prerelease: bool,
    pub source: String,
    pub url: String,
}

fn contains_dev_private_marker(s: &str) -> bool {
    s.contains("白林")
        || s.contains("3347567186@qq.com")
        || s.contains("是个帅气的男孩")
        || s.contains("开发者底层")
        || s.contains("独立开发者署名")
}

/// 剥离版本标题中的内部开发者元信息片段（严格守住可见 UI 零暴露开发者信息的红线）。
fn sanitize_changelog_title(raw: &str) -> String {
    let cleaned = raw
        .replace("与开发者底层元信息", "")
        .replace("、开发者底层元信息", "")
        .replace("及开发者底层元信息", "")
        .replace("开发者底层元信息", "")
        .replace("独立开发者署名", "")
        .replace("白林", "")
        .replace("3347567186@qq.com", "")
        .replace("是个帅气的男孩", "")
        .trim()
        .trim_end_matches(['、', '，', ',', '与', '+', ' '])
        .trim()
        .to_string();
    cleaned
}

/// 剥离正文中的开发者隐私小节与敏感行，确保任何历史版本在可见 UI 渲染时绝对零泄露。
fn sanitize_changelog_body(raw: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    let mut skip_sub = false;
    let mut in_fence = false;
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") {
            in_fence = !in_fence;
        }
        if !in_fence && trimmed.starts_with("###") {
            if contains_dev_private_marker(trimmed) {
                skip_sub = true;
                continue;
            } else {
                skip_sub = false;
            }
        }
        if skip_sub {
            continue;
        }
        if contains_dev_private_marker(line) {
            continue;
        }
        out.push(line);
    }
    out.join("\n").trim().to_string()
}

fn extract_inline_date(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    if bytes.len() < 10 {
        return None;
    }
    for i in 0..=bytes.len() - 10 {
        let sub = &bytes[i..i + 10];
        if sub[0..4].iter().all(|b| b.is_ascii_digit())
            && sub[4] == b'-'
            && sub[5..7].iter().all(|b| b.is_ascii_digit())
            && sub[7] == b'-'
            && sub[8..10].iter().all(|b| b.is_ascii_digit())
        {
            if let Ok(d) = std::str::from_utf8(sub) {
                return Some(d.to_string());
            }
        }
    }
    None
}

fn infer_release_kind(version: &str, meta_hint: &str) -> String {
    let low = meta_hint.to_ascii_lowercase();
    if low.contains("major") {
        return "major".into();
    }
    if low.contains("minor") {
        return "minor".into();
    }
    if low.contains("patch") {
        return "patch".into();
    }
    if let Ok(sv) = SemVer::parse(version) {
        if sv.minor == 0 && sv.patch == 0 {
            return "major".into();
        }
        if sv.patch == 0 {
            return "minor".into();
        }
        return "patch".into();
    }
    "legacy".into()
}

/// 尝试将 Markdown 一级/二级标题解析为版本头 `(version_key, kind, date, title)`。
/// 仅匹配真实版本标题（`1.45.0`、`v1.42.12`、`1.42.15 – 1.42.26`、以及早期里程碑 `v6`..`v9.8`、`a11`、`b1`..`b5`），
/// 忽略普通子标题（如 `## 1. 卸载程序`、`## 2026-10-30 ...`、`## 2.1.x` 废弃说明）。
fn parse_changelog_heading(line: &str) -> Option<(String, String, String, String)> {
    let trimmed = line.trim();
    let rest = if let Some(r) = trimmed.strip_prefix("## ") {
        r.trim()
    } else if let Some(r) = trimmed.strip_prefix("# ") {
        // 早期仅 v7 使用了一级标题 `# v7：...`
        let r = r.trim();
        if !r.starts_with('v') && !r.starts_with('V') {
            return None;
        }
        r
    } else {
        return None;
    };

    if rest.is_empty() {
        return None;
    }

    // 提取开头的版本 token（如 `1.45.0`、`v1.42.10`、`v9.8`、`b5`、`a11`）
    let mut end = 0usize;
    for (idx, ch) in rest.char_indices() {
        if ch.is_ascii_alphanumeric() || ch == '.' || ch == '-' {
            end = idx + ch.len_utf8();
        } else {
            break;
        }
    }
    if end == 0 {
        return None;
    }
    let raw_tok = &rest[..end];
    let after_tok = rest[end..].trim_start();

    // 检查是否是区间版本（如 `1.42.15 – 1.42.26`）
    let (ver_raw, tail) = if let Some(after_dash) = after_tok
        .strip_prefix('–')
        .or_else(|| after_tok.strip_prefix('-'))
        .or_else(|| after_tok.strip_prefix('—'))
    {
        let ad = after_dash.trim_start();
        let mut end2 = 0usize;
        for (idx, ch) in ad.char_indices() {
            if ch.is_ascii_digit() || ch == '.' {
                end2 = idx + ch.len_utf8();
            } else {
                break;
            }
        }
        let tok2 = &ad[..end2];
        if SemVer::parse(raw_tok).is_ok() && SemVer::parse(tok2).is_ok() {
            (
                format!("{}–{}", raw_tok.trim_start_matches(['v', 'V']), tok2),
                ad[end2..].trim_start(),
            )
        } else {
            (raw_tok.to_string(), after_tok)
        }
    } else {
        (raw_tok.to_string(), after_tok)
    };

    // 1) 标准三段语义版本或区间版本
    let is_semver = SemVer::parse(&ver_raw).is_ok();
    let is_semver_range = ver_raw.contains('–');
    // 2) 早期里程碑版本：v6 / v7 / v9.8 / a11 / b1..b5（跳过 `b5 补充 ...` 这类零碎补注）
    let is_legacy = !is_semver && !is_semver_range && {
        let low = ver_raw.to_ascii_lowercase();
        let bytes = low.as_bytes();
        let valid_v = bytes.len() >= 2
            && bytes[0] == b'v'
            && bytes[1].is_ascii_digit()
            && bytes[1..].iter().all(|b| b.is_ascii_digit() || *b == b'.');
        let valid_ab = bytes.len() >= 2
            && (bytes[0] == b'a' || bytes[0] == b'b')
            && bytes[1..].iter().all(|b| b.is_ascii_digit())
            && !tail.starts_with("补充");
        valid_v || valid_ab
    };

    if !is_semver && !is_semver_range && !is_legacy {
        return None;
    }

    let clean_ver = if is_semver {
        ver_raw.trim_start_matches(['v', 'V']).to_string()
    } else {
        ver_raw
    };

    // 解析括号里的元信息（如 `（minor）` / `（patch）` / `（2026-11-15）`）
    let mut meta = String::new();
    let mut title_part = tail;
    if let Some(rest_paren) = title_part
        .strip_prefix('（')
        .or_else(|| title_part.strip_prefix('('))
    {
        if let Some(close_pos) = rest_paren.find(['）', ')']) {
            meta = rest_paren[..close_pos].trim().to_string();
            let close_len = rest_paren[close_pos..].chars().next().map_or(1, |c| c.len_utf8());
            title_part = rest_paren[close_pos + close_len..].trim_start();
        }
    }

    let date = extract_inline_date(&meta)
        .or_else(|| extract_inline_date(title_part))
        .unwrap_or_default();

    let title_clean = title_part
        .trim_start_matches(['—', '–', '-', '：', ':', ' '])
        .trim();
    let title = sanitize_changelog_title(title_clean);
    let kind = if is_legacy || is_semver_range {
        if is_semver_range {
            "patch".into()
        } else {
            "legacy".into()
        }
    } else {
        infer_release_kind(&clean_ver, &meta)
    };

    Some((clean_ver, kind, date, title))
}

fn extract_summary_line(title: &str, body: &str) -> String {
    if !title.is_empty() {
        return title.chars().take(110).collect();
    }
    for line in body.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with("---") || t.starts_with("```") {
            continue;
        }
        let clean = t
            .trim_start_matches(['#', '-', '*', '>', ' '])
            .replace("**", "")
            .replace('`', "");
        let clean = clean.trim();
        if !clean.is_empty() {
            return clean.chars().take(110).collect();
        }
    }
    String::new()
}

/// 将 `变更记录.md` 解析为倒序（最新在前）的结构化历史版本列表，合并同号段并完成隐私脱敏。
pub fn parse_embedded_changelog(raw: &str, current_version: &str) -> Vec<ChangelogEntry> {
    let mut sections: Vec<(String, String, String, String, Vec<&str>)> = Vec::new();
    let mut in_fence = false;

    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") {
            in_fence = !in_fence;
        }
        if !in_fence {
            if let Some((ver, kind, date, title)) = parse_changelog_heading(line) {
                sections.push((ver, kind, date, title, Vec::new()));
                continue;
            }
        }
        if let Some(last) = sections.last_mut() {
            last.4.push(line);
        }
    }

    // 按原始时间先后合并重复版本号（如历史文档中出现两次的 1.42.12），再整体反转为「最新在前」。
    let mut merged: Vec<ChangelogEntry> = Vec::new();
    let mut index_by_id: std::collections::HashMap<String, usize> = std::collections::HashMap::new();

    for (ver, kind, date, title, lines) in sections {
        let body_raw = lines.join("\n");
        let body = sanitize_changelog_body(&body_raw);
        let id = ver.to_ascii_lowercase();
        let is_cur = ver == current_version;
        let url = if SemVer::parse(&ver).is_ok() {
            format!("{OFFICIAL_RELEASES_PAGE}/tag/v{ver}")
        } else {
            OFFICIAL_RELEASES_PAGE.to_string()
        };

        if let Some(&pos) = index_by_id.get(&id) {
            let existing = &mut merged[pos];
            if !title.is_empty() && !existing.title.contains(&title) {
                if existing.title.is_empty() {
                    existing.title = title.clone();
                } else {
                    existing.title = format!("{} · {}", existing.title, title);
                }
            }
            if existing.date.is_empty() && !date.is_empty() {
                existing.date = date;
            }
            if !body.is_empty() {
                let extra = if !title.is_empty() {
                    format!("### {title}\n\n{body}")
                } else {
                    body
                };
                if existing.body.is_empty() {
                    existing.body = extra;
                } else {
                    existing.body.push_str("\n\n---\n\n");
                    existing.body.push_str(&extra);
                }
            }
            existing.summary = extract_summary_line(&existing.title, &existing.body);
            continue;
        }

        let summary = extract_summary_line(&title, &body);
        index_by_id.insert(id.clone(), merged.len());
        merged.push(ChangelogEntry {
            id,
            version: ver,
            kind,
            title,
            summary,
            body,
            date,
            is_current: is_cur,
            is_prerelease: false,
            source: "local".into(),
            url,
        });
    }

    merged.reverse();
    merged
}

fn decode_xml_entities(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        let after = &rest[amp + 1..];
        let Some(semi) = after.find(';') else {
            out.push('&');
            rest = after;
            continue;
        };
        if semi == 0 || semi > 16 {
            out.push('&');
            rest = after;
            continue;
        }
        let ent = &after[..semi];
        let decoded = match ent {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some(' '),
            _ if ent.starts_with("#x") || ent.starts_with("#X") => {
                u32::from_str_radix(&ent[2..], 16).ok().and_then(char::from_u32)
            }
            _ if ent.starts_with('#') => ent[1..].parse::<u32>().ok().and_then(char::from_u32),
            _ => None,
        };
        if let Some(ch) = decoded {
            out.push(ch);
            rest = &after[semi + 1..];
        } else {
            out.push('&');
            rest = after;
        }
    }
    out.push_str(rest);
    out
}

fn extract_xml_tag_inner<'a>(xml: &'a str, tag: &str) -> Option<&'a str> {
    let open_pat = format!("<{tag}");
    let close_pat = format!("</{tag}>");
    let mut rest = xml;
    while let Some(pos) = rest.find(&open_pat) {
        let after = &rest[pos + open_pat.len()..];
        let next = after.as_bytes().first().copied().unwrap_or(0);
        if !matches!(next, b'>' | b' ' | b'\t' | b'\r' | b'\n' | b'/') {
            rest = after;
            continue;
        }
        let gt = after.find('>')?;
        if after[..gt].trim_end().ends_with('/') {
            rest = &after[gt + 1..];
            continue;
        }
        let inner_start = &after[gt + 1..];
        let end = inner_start.find(&close_pat)?;
        return Some(&inner_start[..end]);
    }
    None
}

fn html_to_changelog_markdown(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    let mut skip_leading_ws = true;

    let ensure_nl = |buf: &mut String| {
        if !buf.is_empty() && !buf.ends_with('\n') {
            buf.push('\n');
        }
    };

    while !rest.is_empty() {
        if let Some(lt) = rest.find('<') {
            if lt > 0 {
                let text = decode_xml_entities(&rest[..lt]);
                let slice = if skip_leading_ws {
                    text.trim_start()
                } else {
                    text.as_str()
                };
                if !slice.is_empty() {
                    out.push_str(slice);
                    skip_leading_ws = false;
                }
            }
            let after_lt = &rest[lt + 1..];
            // 查找标签闭合 '>'，跳过属性值引号内的 '>'
            let mut quote: Option<u8> = None;
            let mut gt_pos = None;
            for (idx, b) in after_lt.bytes().enumerate() {
                if let Some(q) = quote {
                    if b == q {
                        quote = None;
                    }
                } else if b == b'"' || b == b'\'' {
                    quote = Some(b);
                } else if b == b'>' {
                    gt_pos = Some(idx);
                    break;
                }
            }
            let Some(gt) = gt_pos else {
                break;
            };
            let raw_tag = after_lt[..gt].trim();
            rest = &after_lt[gt + 1..];

            let is_close = raw_tag.starts_with('/');
            let name = raw_tag
                .trim_start_matches('/')
                .split(|c: char| c.is_ascii_whitespace() || c == '/')
                .next()
                .unwrap_or("")
                .to_ascii_lowercase();

            match (is_close, name.as_str()) {
                (false, "h1" | "h2") => {
                    ensure_nl(&mut out);
                    if !out.is_empty() && !out.ends_with("\n\n") {
                        out.push('\n');
                    }
                    out.push_str("## ");
                    skip_leading_ws = true;
                }
                (false, "h3" | "h4" | "h5" | "h6") => {
                    ensure_nl(&mut out);
                    if !out.is_empty() && !out.ends_with("\n\n") {
                        out.push('\n');
                    }
                    out.push_str("### ");
                    skip_leading_ws = true;
                }
                (false, "li") => {
                    ensure_nl(&mut out);
                    out.push_str("- ");
                    skip_leading_ws = true;
                }
                (false, "p" | "div" | "blockquote" | "pre") => {
                    if !skip_leading_ws {
                        ensure_nl(&mut out);
                    }
                }
                (false, "br") => {
                    out.push('\n');
                    skip_leading_ws = true;
                }
                (false, "hr") => {
                    ensure_nl(&mut out);
                    out.push_str("---\n");
                    skip_leading_ws = true;
                }
                (_, "strong" | "b") => {
                    out.push_str("**");
                    skip_leading_ws = false;
                }
                (_, "code") => {
                    out.push('`');
                    skip_leading_ws = false;
                }
                (true, "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "p" | "li" | "div" | "tr" | "pre" | "blockquote") => {
                    if !skip_leading_ws {
                        ensure_nl(&mut out);
                        skip_leading_ws = true;
                    }
                }
                _ => {}
            }
        } else {
            let text = decode_xml_entities(rest);
            let slice = if skip_leading_ws {
                text.trim_start()
            } else {
                text.as_str()
            };
            if !slice.is_empty() {
                out.push_str(slice);
            }
            break;
        }
    }

    let mut clean: Vec<String> = Vec::new();
    let mut blank_run = 0usize;
    for line in out.lines() {
        let t = line.trim_end();
        if t.trim().is_empty() {
            blank_run += 1;
            if blank_run <= 1 && !clean.is_empty() {
                clean.push(String::new());
            }
        } else {
            blank_run = 0;
            clean.push(t.to_string());
        }
    }
    clean.join("\n").trim().to_string()
}

fn normalize_remote_changelog_title(raw_name: &str, ver: &str) -> String {
    sanitize_changelog_title(
        raw_name
            .trim()
            .trim_start_matches("轻盘")
            .trim_start_matches([' ', '·', '-'])
            .trim_start_matches("QDisk")
            .trim_start_matches([' ', '·', '-', 'v', 'V'])
            .trim_start_matches(ver)
            .trim_start_matches([' ', '—', '–', '-', '：', ':']),
    )
}

/// 从 GitHub `releases.atom` 零限流订阅源解析结构化更新日志（自动忽略 `build-*` 等非 SemVer 标签并拦截正文伪造链接）。
pub fn parse_atom_changelog_entries(xml: &str, current_version: &str) -> Vec<ChangelogEntry> {
    const ABS_PREFIX: &str = "https://github.com/3347567186/QDisk/releases/tag/";
    const REL_PREFIX: &str = "/3347567186/QDisk/releases/tag/";
    let mut parsed: Vec<(SemVer, ChangelogEntry)> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    let mut rest = xml;
    while let Some(entry_start) = rest.find("<entry") {
        let after_tag = &rest[entry_start + "<entry".len()..];
        let next_ch = after_tag.as_bytes().first().copied().unwrap_or(0);
        if !matches!(next_ch, b'>' | b' ' | b'\t' | b'\r' | b'\n') {
            rest = after_tag;
            continue;
        }
        let Some(gt) = after_tag.find('>') else {
            break;
        };
        let body_start = &after_tag[gt + 1..];
        let entry_body = match body_start.find("</entry>") {
            Some(end) => {
                rest = &body_start[end + "</entry>".len()..];
                &body_start[..end]
            }
            None => {
                rest = "";
                body_start
            }
        };

        // 仅在 <entry> 头部（截断 <content>/<summary> 之前）解析发布链接、标题与时间，防正文伪造
        let header_end = [entry_body.find("<content"), entry_body.find("<summary")]
            .into_iter()
            .flatten()
            .min()
            .unwrap_or(entry_body.len());
        let header = &entry_body[..header_end];

        let mut matched_tag: Option<(SemVer, String)> = None;
        let mut hrest = header;
        while let Some(lpos) = hrest.find("<link") {
            let after_l = &hrest[lpos + "<link".len()..];
            let lnext = after_l.as_bytes().first().copied().unwrap_or(0);
            if !matches!(lnext, b' ' | b'\t' | b'\r' | b'\n') {
                hrest = after_l;
                continue;
            }
            let Some(lend) = after_l.find('>') else {
                break;
            };
            let attrs = &after_l[..lend];
            hrest = &after_l[lend + 1..];

            let Some(href_val) = extract_xml_href_attr(attrs) else {
                continue;
            };
            let trimmed_href = href_val.trim();
            let prefix_ok = (trimmed_href.len() > ABS_PREFIX.len()
                && trimmed_href[..ABS_PREFIX.len()].eq_ignore_ascii_case(ABS_PREFIX))
                || (trimmed_href.len() > REL_PREFIX.len()
                    && trimmed_href[..REL_PREFIX.len()].eq_ignore_ascii_case(REL_PREFIX));
            if !prefix_ok {
                continue;
            }
            if let Some(tag) = extract_tag_from_release_location(trimmed_href) {
                let ver_str = tag.trim_start_matches(['v', 'V']);
                if let Ok(sv) = SemVer::parse(ver_str) {
                    matched_tag = Some((sv, tag));
                    break;
                }
            }
        }

        let Some((sv, tag)) = matched_tag else {
            continue;
        };
        let ver = tag.trim_start_matches(['v', 'V']).to_string();
        let id = ver.to_ascii_lowercase();
        if !seen.insert(id.clone()) {
            continue;
        }

        let date = extract_xml_tag_inner(header, "updated")
            .and_then(extract_inline_date)
            .unwrap_or_default();
        let raw_title = extract_xml_tag_inner(header, "title")
            .map(decode_xml_entities)
            .unwrap_or_default();
        let title = normalize_remote_changelog_title(&raw_title, &ver);

        let raw_content = extract_xml_tag_inner(entry_body, "content")
            .or_else(|| extract_xml_tag_inner(entry_body, "summary"))
            .unwrap_or("");
        let unescaped_html = decode_xml_entities(raw_content);
        let md_body = html_to_changelog_markdown(&unescaped_html);
        let body = sanitize_changelog_body(&md_body);
        let summary = extract_summary_line(&title, &body);
        let kind = infer_release_kind(&ver, "");
        let is_prerelease = sv.is_prerelease();
        let url = format!("{OFFICIAL_RELEASES_PAGE}/tag/{tag}");

        parsed.push((
            sv,
            ChangelogEntry {
                id,
                version: ver.clone(),
                kind,
                title,
                summary,
                body,
                date,
                is_current: ver == current_version,
                is_prerelease,
                source: "remote".into(),
                url,
            },
        ));
    }

    parsed.sort_by(|a, b| b.0.cmp(&a.0));
    parsed.into_iter().map(|(_, entry)| entry).collect()
}

fn parse_github_changelog_json(bytes: &[u8], current_version: &str) -> Result<Vec<ChangelogEntry>> {
    let arr: Vec<Value> =
        serde_json::from_slice(bytes).context("远端发布列表不是合法的 JSON 数组")?;
    let mut out = Vec::new();
    for item in arr {
        if item.get("draft").and_then(|d| d.as_bool()).unwrap_or(false) {
            continue;
        }
        let tag = item
            .get("tag_name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        let ver = tag.trim_start_matches(['v', 'V']).to_string();
        if ver.is_empty() || SemVer::parse(&ver).is_err() {
            continue;
        }
        let prerelease = item
            .get("prerelease")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let pub_date = item
            .get("published_at")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let date = extract_inline_date(pub_date).unwrap_or_default();
        let raw_name = item.get("name").and_then(|v| v.as_str()).unwrap_or("").trim();
        let raw_body = item.get("body").and_then(|v| v.as_str()).unwrap_or("");
        let body = sanitize_changelog_body(raw_body);
        let title = normalize_remote_changelog_title(raw_name, &ver);
        let summary = extract_summary_line(&title, &body);
        let url = item
            .get("html_url")
            .and_then(|v| v.as_str())
            .filter(|u| u.starts_with("https://github.com/3347567186/QDisk/"))
            .map(|u| u.to_string())
            .unwrap_or_else(|| format!("{OFFICIAL_RELEASES_PAGE}/tag/v{ver}"));
        let kind = infer_release_kind(&ver, "");
        out.push(ChangelogEntry {
            id: ver.to_ascii_lowercase(),
            version: ver.clone(),
            kind,
            title,
            summary,
            body,
            date,
            is_current: ver == current_version,
            is_prerelease: prerelease,
            source: "remote".into(),
            url,
        });
    }
    Ok(out)
}

#[cfg(windows)]
fn fetch_remote_changelog_from_urls(
    atom_url: &str,
    api_url: &str,
    current_version: &str,
) -> Result<Vec<ChangelogEntry>> {
    // 1. 优先走零限流官方 releases.atom 订阅源，彻底规避匿名 api.github.com 60次/小时 HTTP 403 限流
    let atom_err = match winhttp_fetch_bytes(
        atom_url,
        MAX_MANIFEST_BYTES,
        6_500,
        "application/atom+xml, application/xml, text/xml",
    ) {
        Ok((_status, bytes, _final_url)) => {
            let xml = String::from_utf8_lossy(&bytes);
            let entries = parse_atom_changelog_entries(&xml, current_version);
            if !entries.is_empty() {
                return Ok(entries);
            }
            Some(anyhow::anyhow!("官方发布订阅未包含有效版本日志"))
        }
        Err(e) => {
            let msg = format!("{e:#}");
            if is_dns_err(&msg) {
                return Err(e);
            }
            Some(e)
        }
    };

    if let Some(ref e) = atom_err {
        append_log("warn", &format!("更新日志 Atom 订阅同步失败，切换 GitHub API 重试：{e:#}"));
    }

    // 2. Atom 失败或无有效版本时回退 GitHub Releases API
    match winhttp_fetch_bytes(
        api_url,
        MAX_MANIFEST_BYTES,
        6_500,
        "application/vnd.github+json, application/json",
    )
    .and_then(|(_status, bytes, _final_url)| parse_github_changelog_json(&bytes, current_version))
    {
        Ok(entries) => Ok(entries),
        Err(api_err) => {
            if let Some(ae) = atom_err {
                Err(anyhow::anyhow!("{api_err:#}（订阅源：{ae:#}）"))
            } else {
                Err(api_err)
            }
        }
    }
}

#[cfg(windows)]
fn fetch_remote_changelog_entries(current_version: &str) -> Result<Vec<ChangelogEntry>> {
    fetch_remote_changelog_from_urls(
        OFFICIAL_RELEASES_ATOM_URL,
        OFFICIAL_API_CHANGELOG_URL,
        current_version,
    )
}

fn merge_local_and_remote_changelogs(
    mut local: Vec<ChangelogEntry>,
    remote: Vec<ChangelogEntry>,
) -> Vec<ChangelogEntry> {
    let mut extras: Vec<ChangelogEntry> = Vec::new();
    for r in remote {
        if let Some(hit) = local.iter_mut().find(|x| x.id == r.id) {
            if hit.date.is_empty() && !r.date.is_empty() {
                hit.date = r.date;
            }
            if !r.url.is_empty() {
                hit.url = r.url;
            }
            if hit.body.is_empty() && !r.body.is_empty() {
                hit.body = r.body;
            }
            hit.source = "merged".into();
        } else {
            extras.push(r);
        }
    }
    // 远端独有按语义版本降序归位：比本地新版高的置顶，较旧的按真实版本号插入对应位置，避免旧版倒挂在顶部
    extras.sort_by(|a, b| {
        let sa = SemVer::parse(&a.version).ok();
        let sb = SemVer::parse(&b.version).ok();
        sb.cmp(&sa)
    });
    for extra in extras.into_iter().rev() {
        let extra_sv = SemVer::parse(&extra.version).ok();
        let insert_at = if let Some(ref esv) = extra_sv {
            local
                .iter()
                .position(|it| {
                    SemVer::parse(&it.version)
                        .ok()
                        .is_some_and(|lsv| *esv >= lsv)
                })
                .unwrap_or(0)
        } else {
            0
        };
        local.insert(insert_at, extra);
    }
    local
}

static EMBEDDED_CHANGELOG_CACHE: OnceLock<Vec<ChangelogEntry>> = OnceLock::new();

fn cached_embedded_changelog() -> Vec<ChangelogEntry> {
    EMBEDDED_CHANGELOG_CACHE
        .get_or_init(|| parse_embedded_changelog(EMBEDDED_CHANGELOG_MD, env!("CARGO_PKG_VERSION")))
        .clone()
}

/// 获取全部更新日志（离线秒开全部内置历史版本；`include_remote=true` 时尝试同步线上最新 Release 并优雅离线兜底）。
#[tauri::command]
pub async fn updater_changelog(include_remote: Option<bool>) -> Result<Value, String> {
    let want_remote = include_remote.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        let cur = env!("CARGO_PKG_VERSION");
        let local = cached_embedded_changelog();
        let mut remote_synced = false;
        let mut remote_error = String::new();
        let entries = if want_remote {
            #[cfg(windows)]
            {
                match fetch_remote_changelog_entries(cur) {
                    Ok(remote) => {
                        remote_synced = true;
                        merge_local_and_remote_changelogs(local, remote)
                    }
                    Err(e) => {
                        remote_error = format!("{e:#}");
                        local
                    }
                }
            }
            #[cfg(not(windows))]
            {
                local
            }
        } else {
            local
        };

        json!({
            "currentVersion": cur,
            "total": entries.len(),
            "remoteSynced": remote_synced,
            "remoteError": remote_error,
            "releasesPage": OFFICIAL_RELEASES_PAGE,
            "entries": entries
        })
    })
    .await
    .map_err(|e| format!("读取更新日志任务异常：{e}"))
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

    #[test]
    fn release_redirect_tag_extraction_and_error_diagnostics() {
        assert_eq!(
            extract_tag_from_release_location("https://github.com/3347567186/QDisk/releases/tag/v1.43.18"),
            Some("v1.43.18".into())
        );
        assert_eq!(
            extract_tag_from_release_location("/3347567186/QDisk/releases/tag/v1.44.0-beta.1?foo=1"),
            Some("v1.44.0-beta.1".into())
        );
        assert_eq!(
            extract_tag_from_release_location("https://github.com/3347567186/QDisk/releases/tag/../../evil"),
            None
        );
        assert_eq!(
            extract_tag_from_release_location("https://github.com/3347567186/QDisk/releases"),
            None
        );
        assert!(describe_winhttp_error(12007).contains("DNS"));
        assert!(describe_winhttp_error(12002).contains("超时"));
        assert!(describe_winhttp_error(12175).contains("TLS"));
    }

    #[test]
    fn embedded_changelog_parses_history_merges_dupes_and_strips_private_dev_info() {
        let entries = parse_embedded_changelog(EMBEDDED_CHANGELOG_MD, "1.45.0");
        assert!(
            entries.len() >= 50,
            "历史版本条数异常偏少: {}",
            entries.len()
        );
        // 必须倒序（最新在前），1.45.0 应在非常靠前的位置并标为 is_current
        let cur = entries.iter().find(|e| e.version == "1.45.0").expect("应包含 1.45.0");
        assert!(cur.is_current);
        assert_eq!(cur.kind, "minor");
        // 去重校验：1.42.12 在源文档出现两次，解析后必须合并为唯一一条且保留两部分内容
        let dup_14212: Vec<&ChangelogEntry> =
            entries.iter().filter(|e| e.version == "1.42.12").collect();
        assert_eq!(dup_14212.len(), 1, "重复版本号 1.42.12 必须合并去重");
        assert!(dup_14212[0].body.contains("浮窗") || dup_14212[0].title.contains("浮窗"));
        // 唯一 id 校验
        let mut ids = std::collections::HashSet::new();
        for e in &entries {
            assert!(ids.insert(e.id.clone()), "出现重复 changelog id: {}", e.id);
            // 红队隐私铁律：任何可见更新日志条目绝不允许泄露开发者隐私信息
            for field in [&e.title, &e.summary, &e.body] {
                assert!(!field.contains("白林"), "日志 {} 泄露开发者姓名", e.version);
                assert!(
                    !field.contains("3347567186@qq.com"),
                    "日志 {} 泄露开发者邮箱",
                    e.version
                );
                assert!(
                    !field.contains("是个帅气的男孩"),
                    "日志 {} 泄露开发者备注",
                    e.version
                );
                assert!(
                    !field.contains("开发者底层"),
                    "日志 {} 泄露开发者底层段落",
                    e.version
                );
            }
        }
        // 确认代码块里的 `# 整理报告` / `## 2026-09` 未被误解析为版本
        assert!(!entries.iter().any(|e| e.version.contains("整理报告") || e.version.contains("2026-09")));
        // 确认合并远端 Release 正确前置更高版本并补齐已有版本日期
        let remote = vec![
            ChangelogEntry {
                id: "9.9.9".into(),
                version: "9.9.9".into(),
                kind: "major".into(),
                title: "远端测试".into(),
                summary: "远端测试".into(),
                body: "远端正文".into(),
                date: "2026-11-25".into(),
                is_current: false,
                is_prerelease: false,
                source: "remote".into(),
                url: "https://github.com/3347567186/QDisk/releases/tag/v9.9.9".into(),
            },
            ChangelogEntry {
                id: "1.45.0".into(),
                version: "1.45.0".into(),
                kind: "minor".into(),
                title: String::new(),
                summary: String::new(),
                body: String::new(),
                date: "2026-11-24".into(),
                is_current: true,
                is_prerelease: false,
                source: "remote".into(),
                url: "https://github.com/3347567186/QDisk/releases/tag/v1.45.0".into(),
            },
        ];
        let merged = merge_local_and_remote_changelogs(entries, remote);
        assert_eq!(merged[0].version, "9.9.9");
        let m145 = merged.iter().find(|e| e.version == "1.45.0").unwrap();
        assert_eq!(m145.date, "2026-11-24");
        assert_eq!(m145.source, "merged");

        // 红队加测：较旧的远端独有版本不得倒挂排在最新版本前面，且远端标题隐私字段必清洗
        let older_remote = vec![ChangelogEntry {
            id: "1.44.5".into(),
            version: "1.44.5".into(),
            kind: "patch".into(),
            title: sanitize_changelog_title("远端补丁 · 白林 3347567186@qq.com"),
            summary: "远端补丁".into(),
            body: "补丁正文".into(),
            date: "2026-11-23".into(),
            is_current: false,
            is_prerelease: false,
            source: "remote".into(),
            url: "https://github.com/3347567186/QDisk/releases/tag/v1.44.5".into(),
        }];
        assert!(!older_remote[0].title.contains("白林"));
        assert!(!older_remote[0].title.contains("3347567186@qq.com"));
        let merged2 = merge_local_and_remote_changelogs(merged, older_remote);
        let pos_145 = merged2.iter().position(|e| e.version == "1.45.0").unwrap();
        let pos_1445 = merged2.iter().position(|e| e.version == "1.44.5").unwrap();
        let pos_1441 = merged2.iter().position(|e| e.version == "1.44.1").unwrap();
        assert!(
            pos_145 < pos_1445 && pos_1445 < pos_1441,
            "旧远端版本 1.44.5 应插在 1.45.0 与 1.44.1 之间: pos145={pos_145}, pos1445={pos_1445}, pos1441={pos_1441}"
        );
    }

    #[test]
    fn atom_feed_tag_extraction_blocks_spoofing_and_sorts_semver() {
        assert!(validate_update_url(OFFICIAL_RELEASES_ATOM_URL, false).is_ok());

        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <link rel="alternate" href="https://github.com/3347567186/QDisk/releases/tag/v99.0.0"/>
  <entry_meta><link href="https://github.com/3347567186/QDisk/releases/tag/v88.0.0"/></entry_meta>
  <entry>
    <link rel="alternate" data-href="https://github.com/3347567186/QDisk/releases/tag/v77.0.0" href="https://github.com/3347567186/QDisk/releases/tag/v1.46.8"/>
    <title>Hotfix 1.46.8</title>
    <content type="html"><link href="https://github.com/3347567186/QDisk/releases/tag/v9.9.9"/></content>
  </entry>
  <entry>
    <link href='https://github.com/3347567186/QDisk/releases/tag/v1.47.0-beta.1' rel='alternate'/>
    <summary><link href="https://github.com/3347567186/QDisk/releases/tag/v9.8.8"/></summary>
  </entry>
  <entry>
    <link rel="alternate" href="https://evil.com/3347567186/QDisk/releases/tag/v50.0.0"/>
  </entry>
  <entry>
    <link rel="alternate" href="https://github.com/attacker/QDisk/releases/tag/v40.0.0"/>
  </entry>
  <entry>
    <link rel="alternate" href="https://github.com/3347567186/QDisk/releases/tag/build-1.46.9"/>
  </entry>
  <entry>
    <link rel="alternate" href="/3347567186/QDisk/releases/tag/v1.46.7-beta.2"/>
  </entry>
  <entry>
    <link rel="alternate" href="https://github.com/3347567186/QDisk/releases/tag/../../evil"/>
  </entry>
</feed>"#;

        let tags = extract_release_tags_from_atom(xml);
        assert_eq!(tags, vec!["v1.47.0-beta.1", "v1.46.8", "v1.46.7-beta.2"]);
    }

    #[cfg(windows)]
    #[test]
    fn end_to_end_beta_atom_http_handles_missing_and_mismatched_manifests() {
        use std::io::{Read as _, Write as _};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let base = format!("http://127.0.0.1:{port}");
        let fake_sha = "a".repeat(64);

        let atom_fallback_xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry><link rel="alternate" href="https://github.com/3347567186/QDisk/releases/tag/v1.48.0-beta.2"/></entry>
  <entry><link rel="alternate" href="https://github.com/3347567186/QDisk/releases/tag/v1.48.0-beta.1"/></entry>
  <entry><link rel="alternate" href="https://github.com/3347567186/QDisk/releases/tag/v1.47.0-beta.1"/></entry>
</feed>"#
            .to_string();

        let atom_primary_xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry><link rel="alternate" href="https://github.com/3347567186/QDisk/releases/tag/v1.49.0-beta.1"/></entry>
  <entry><link rel="alternate" href="https://github.com/3347567186/QDisk/releases/tag/v1.46.2"/></entry>
</feed>"#
            .to_string();

        let make_mf = |ver: &str, ch: &str| {
            format!(
                r#"{{"version":"{ver}","channel":"{ch}","notes":"test {ver}","installer":{{"file":"QDisk_{ver}_x64-setup.exe","url":"{base}/dl/QDisk_{ver}_x64-setup.exe","size":1234,"sha256":"{fake_sha}"}}}}"#
            )
        };
        let mf_mismatched = make_mf("1.46.0", "beta");
        let mf_147 = make_mf("1.47.0-beta.1", "beta");
        let mf_149 = make_mf("1.49.0-beta.1", "beta");

        let srv = std::thread::spawn(move || {
            for _ in 0..6 {
                let Ok((mut stream, _)) = listener.accept() else {
                    break;
                };
                let mut req_buf = [0u8; 2048];
                let n = stream.read(&mut req_buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&req_buf[..n]);
                let path = req
                    .lines()
                    .next()
                    .and_then(|l| l.split_whitespace().nth(1))
                    .unwrap_or("/");
                let (code, ctype, body) = match path {
                    "/atom-fallback" => ("200 OK", "application/atom+xml", atom_fallback_xml.as_str()),
                    "/atom-primary" => ("200 OK", "application/atom+xml", atom_primary_xml.as_str()),
                    "/dl/v1.48.0-beta.2/latest.json" => ("404 Not Found", "text/plain", "not found"),
                    "/dl/v1.48.0-beta.1/latest.json" => ("200 OK", "application/json", mf_mismatched.as_str()),
                    "/dl/v1.47.0-beta.1/latest.json" => ("200 OK", "application/json", mf_147.as_str()),
                    "/dl/v1.49.0-beta.1/latest.json" => ("200 OK", "application/json", mf_149.as_str()),
                    _ => ("404 Not Found", "text/plain", "missing"),
                };
                let resp = format!(
                    "HTTP/1.1 {code}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(resp.as_bytes());
            }
        });

        // 场景 1：最高标签 404、次高标签清单版本错配，自动跳过并安全命中第 3 个合法候选作为 FallbackOnly
        let r1 = fetch_beta_manifest_via_atom(
            &format!("{base}/atom-fallback"),
            &format!("{base}/dl"),
        )
        .expect("应成功回退到 v1.47.0-beta.1");
        match r1 {
            AtomBetaFetch::FallbackOnly(m) => assert_eq!(m.version, "1.47.0-beta.1"),
            AtomBetaFetch::Primary(m) => panic!("预期 FallbackOnly，实际 Primary({})", m.version),
        }

        // 场景 2：最高标签直接命中合法清单 -> Primary，且 Beta 通道可升级而 Stable 通道不误收预发布版
        let r2 = fetch_beta_manifest_via_atom(
            &format!("{base}/atom-primary"),
            &format!("{base}/dl"),
        )
        .expect("应直接命中 v1.49.0-beta.1");
        let m2 = match r2 {
            AtomBetaFetch::Primary(m) => m,
            AtomBetaFetch::FallbackOnly(m) => panic!("预期 Primary，实际 FallbackOnly({})", m.version),
        };
        assert_eq!(m2.version, "1.49.0-beta.1");

        let eval_beta = evaluate_manifest("1.46.2", "installer", "beta", "", &m2, None).unwrap();
        assert!(eval_beta.has_update);
        assert!(eval_beta.is_prerelease);
        assert_eq!(eval_beta.latest_version, "1.49.0-beta.1");

        let eval_stable = evaluate_manifest("1.46.2", "installer", "stable", "", &m2, None).unwrap();
        assert!(!eval_stable.has_update, "正式版通道绝不可接收预发布版更新");

        let _ = srv.join();
    }

    #[cfg(windows)]
    #[test]
    #[ignore]
    fn live_beta_atom_resolves_real_github_release() {
        let mut stages = Vec::new();
        let m = fetch_official_manifest("beta", |s, p| stages.push(format!("{p}% {s}")))
            .expect("实网 beta 通道应绕过 api.github.com 403 限流成功拉取");
        assert!(SemVer::parse(&m.version).unwrap() >= SemVer::parse("1.46.7-beta.1").unwrap());
        let eval = evaluate_manifest("1.46.2", "installer", "beta", "", &m, None).unwrap();
        assert!(eval.has_update, "v1.46.2 在测试版通道必须检测到新包 {}", m.version);
    }

    #[test]
    fn atom_changelog_parsing_converts_html_filters_build_tags_and_blocks_spoofing() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <updated>2026-11-24T12:58:44Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/3347567186/QDisk/releases/tag/v1.46.8"/>
    <title>轻盘 QDisk v1.46.8 — 更新源加固</title>
    <content type="html">&lt;h2&gt;本版亮点&lt;/h2&gt;
&lt;ol&gt;
&lt;li&gt;
&lt;p&gt;&lt;strong&gt;测试版更新 &amp;amp; 零限流&lt;/strong&gt;&lt;/p&gt;
&lt;ul&gt;&lt;li&gt;使用 &lt;code&gt;releases.atom&lt;/code&gt; 避开 403&lt;/li&gt;&lt;/ul&gt;
&lt;/li&gt;
&lt;/ol&gt;
&lt;p&gt;开发者 3347567186@qq.com 隐私行必须剔除&lt;/p&gt;
&lt;link href="https://github.com/3347567186/QDisk/releases/tag/v9.9.9"/&gt;</content>
  </entry>
  <entry>
    <updated>2026-11-24T12:21:47Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/3347567186/QDisk/releases/tag/v1.46.7-beta.1"/>
    <title>QDisk v1.46.7-beta.1</title>
    <content type="html">&lt;p&gt;预发布验证&lt;/p&gt;</content>
  </entry>
  <entry>
    <updated>2026-11-24T12:49:01Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/3347567186/QDisk/releases/tag/build-1.46.8"/>
    <title>build-1.46.8</title>
    <content type="html">&lt;p&gt;pre-build 1.46.8 (full)&lt;/p&gt;</content>
  </entry>
  <entry>
    <updated>2026-11-24T13:00:00Z</updated>
    <link rel="alternate" type="text/html" href="https://evil.com/3347567186/QDisk/releases/tag/v99.0.0"/>
    <title>Evil v99.0.0</title>
    <content type="html">&lt;p&gt;spoof&lt;/p&gt;</content>
  </entry>
</feed>"#;

        let list = parse_atom_changelog_entries(xml, "1.46.8");
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].version, "1.46.8");
        assert!(list[0].is_current);
        assert!(!list[0].is_prerelease);
        assert_eq!(list[0].date, "2026-11-24");
        assert_eq!(list[0].title, "更新源加固");
        assert_eq!(
            list[0].url,
            "https://github.com/3347567186/QDisk/releases/tag/v1.46.8"
        );
        assert!(list[0].body.contains("## 本版亮点"));
        assert!(list[0].body.contains("- **测试版更新 & 零限流**"));
        assert!(list[0].body.contains("- 使用 `releases.atom` 避开 403"));
        assert!(!list[0].body.contains("3347567186@qq.com"));

        assert_eq!(list[1].version, "1.46.7-beta.1");
        assert!(list[1].is_prerelease);
        assert!(!list[1].is_current);
    }

    #[cfg(windows)]
    #[test]
    fn end_to_end_remote_changelog_bypasses_api_403_via_atom_and_falls_back_to_api() {
        use std::io::{Read as _, Write as _};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let base = format!("http://127.0.0.1:{port}");

        let atom_ok = r#"<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <updated>2026-11-24T13:52:12Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/3347567186/QDisk/releases/tag/v1.46.9"/>
    <title>轻盘 QDisk v1.46.9 — 整理预设修复</title>
    <content type="html">&lt;p&gt;修复整理文件预设高亮&lt;/p&gt;</content>
  </entry>
</feed>"#
            .to_string();
        let atom_only_builds = r#"<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <updated>2026-11-24T13:52:12Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/3347567186/QDisk/releases/tag/build-1.46.9"/>
    <title>build-1.46.9</title>
  </entry>
</feed>"#
            .to_string();
        let api_ok = r#"[{"tag_name":"v1.46.9","name":"轻盘 QDisk v1.46.9","draft":false,"prerelease":false,"published_at":"2026-11-24T13:52:12Z","body":"API 回退日志","html_url":"https://github.com/3347567186/QDisk/releases/tag/v1.46.9"}]"#
            .to_string();

        let srv = std::thread::spawn(move || {
            for _ in 0..3 {
                let Ok((mut stream, _)) = listener.accept() else {
                    break;
                };
                let mut req_buf = [0u8; 2048];
                let n = stream.read(&mut req_buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&req_buf[..n]);
                let path = req
                    .lines()
                    .next()
                    .and_then(|l| l.split_whitespace().nth(1))
                    .unwrap_or("/");
                let (code, ctype, body) = match path {
                    "/atom-ok" => ("200 OK", "application/atom+xml", atom_ok.as_str()),
                    "/atom-empty" => ("200 OK", "application/atom+xml", atom_only_builds.as_str()),
                    "/api-403" => ("403 Forbidden", "application/json", r#"{"message":"API rate limit exceeded"}"#),
                    "/api-ok" => ("200 OK", "application/json", api_ok.as_str()),
                    _ => ("404 Not Found", "text/plain", "missing"),
                };
                let resp = format!(
                    "HTTP/1.1 {code}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(resp.as_bytes());
            }
        });

        // 场景 1：API 处于 403 限流状态时，直接通过 Atom 零限流成功同步
        let r1 = fetch_remote_changelog_from_urls(
            &format!("{base}/atom-ok"),
            &format!("{base}/api-403"),
            "1.46.8",
        )
        .expect("API 403 时应直接通过 Atom 同步成功");
        assert_eq!(r1.len(), 1);
        assert_eq!(r1[0].version, "1.46.9");
        assert!(r1[0].body.contains("修复整理文件预设高亮"));

        // 场景 2：Atom 仅含 build-* 标签无有效正式版本时，自动回退 GitHub API
        let r2 = fetch_remote_changelog_from_urls(
            &format!("{base}/atom-empty"),
            &format!("{base}/api-ok"),
            "1.46.8",
        )
        .expect("Atom 无有效版本时应自动回退 API 通道");
        assert_eq!(r2.len(), 1);
        assert_eq!(r2[0].version, "1.46.9");
        assert!(r2[0].body.contains("API 回退日志"));

        let _ = srv.join();
    }

    #[cfg(windows)]
    #[test]
    #[ignore]
    fn live_remote_changelog_bypasses_api_403() {
        let entries = fetch_remote_changelog_entries("1.46.8")
            .expect("实网更新日志线上同步应绕过 api.github.com 403 限流成功拉取");
        assert!(!entries.is_empty(), "应解析出至少一条官方远端版本日志");
        assert!(
            entries.iter().any(|e| e.version == "1.46.8"),
            "远端日志列表应包含 v1.46.8"
        );
    }
}
