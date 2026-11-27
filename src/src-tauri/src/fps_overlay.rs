//! 原生 Win32 零背景纯数字 FPS 帧率检测悬浮窗（`UpdateLayeredWindow` 逐像素 Alpha）。
//!
//! 特性：
//! - 彻底无窗口边框、无标题栏、无底色卡片、无任务栏占位、不抢焦点（`WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE`）
//! - 5 种预设位置（左上 / 中上 / 右上 / 左下 / 右下）自动开启鼠标穿透（`WS_EX_TRANSPARENT`）
//! - 支持自定义拖动（`custom`）：可按住数字自由拖放到屏幕任意位置（含多屏）并自动持久化坐标，支持锁定穿透防误触
//! - 通过 `dwmapi.dll!DwmGetCompositionTimingInfo` 无侵入被动采样桌面/游戏呈现帧率（零注入、无需管理员）

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

pub const PRESET_POSITIONS: &[&str] = &[
    "top-left",
    "top-center",
    "top-right",
    "bottom-left",
    "bottom-right",
    "custom",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FpsOverlayConfig {
    #[serde(default)]
    pub enabled: bool,
    /// Hex 颜色，如 `#34D399`
    #[serde(default = "default_color")]
    pub color: String,
    /// `top-left` | `top-center` | `top-right` | `bottom-left` | `bottom-right` | `custom`
    #[serde(default = "default_position")]
    pub position: String,
    #[serde(default = "default_custom_x")]
    pub custom_x: i32,
    #[serde(default = "default_custom_y")]
    pub custom_y: i32,
    /// 自定义拖动模式下是否锁定并开启鼠标穿透（false = 允许按住数字拖动）
    #[serde(default)]
    pub locked: bool,
    /// 字号（像素高度，20..=56，默认 32）
    #[serde(default = "default_font_size")]
    pub font_size: u32,
}

fn default_color() -> String {
    "#34D399".to_string()
}
fn default_position() -> String {
    "top-left".to_string()
}
fn default_custom_x() -> i32 {
    24
}
fn default_custom_y() -> i32 {
    18
}
fn default_font_size() -> u32 {
    32
}

impl Default for FpsOverlayConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            color: default_color(),
            position: default_position(),
            custom_x: default_custom_x(),
            custom_y: default_custom_y(),
            locked: false,
            font_size: default_font_size(),
        }
    }
}

impl FpsOverlayConfig {
    pub fn sanitize(&mut self) {
        let pos = self.position.trim().to_ascii_lowercase();
        if PRESET_POSITIONS.contains(&pos.as_str()) {
            self.position = pos;
        } else {
            self.position = default_position();
        }
        if parse_hex_rgb(&self.color).is_none() {
            self.color = default_color();
        } else {
            let trimmed = self.color.trim();
            self.color = if trimmed.starts_with('#') {
                trimmed.to_ascii_uppercase()
            } else {
                format!("#{}", trimmed.to_ascii_uppercase())
            };
        }
        self.font_size = self.font_size.clamp(20, 56);
    }

    pub fn is_click_through(&self) -> bool {
        self.position != "custom" || self.locked
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FpsSample {
    pub fps: u32,
    pub refresh_hz: u32,
    pub frame_ms: f64,
}

/// 解析 `#RRGGBB` / `RRGGBB` / `#RGB` 为 `(r, g, b)`。
pub fn parse_hex_rgb(raw: &str) -> Option<(u8, u8, u8)> {
    let s = raw.trim().trim_start_matches('#');
    if s.len() == 6 {
        let r = u8::from_str_radix(&s[0..2], 16).ok()?;
        let g = u8::from_str_radix(&s[2..4], 16).ok()?;
        let b = u8::from_str_radix(&s[4..6], 16).ok()?;
        return Some((r, g, b));
    }
    if s.len() == 3 {
        let r = u8::from_str_radix(&s[0..1], 16).ok()? * 17;
        let g = u8::from_str_radix(&s[1..2], 16).ok()? * 17;
        let b = u8::from_str_radix(&s[2..3], 16).ok()? * 17;
        return Some((r, g, b));
    }
    None
}

/// 根据位置预设与屏幕区域计算悬浮窗左上角坐标 `(x, y)`。
pub fn compute_overlay_origin(
    position: &str,
    custom_x: i32,
    custom_y: i32,
    win_w: i32,
    win_h: i32,
    primary_w: i32,
    primary_h: i32,
    virt_x: i32,
    virt_y: i32,
    virt_w: i32,
    virt_h: i32,
) -> (i32, i32) {
    let margin_x = 20;
    let margin_y = 14;
    let pw = primary_w.max(win_w + margin_x * 2);
    let ph = primary_h.max(win_h + margin_y * 2);
    match position {
        "top-left" => (margin_x, margin_y),
        "top-center" => (((pw - win_w) / 2).max(0), margin_y),
        "top-right" => ((pw - win_w - margin_x).max(0), margin_y),
        "bottom-left" => (margin_x, (ph - win_h - margin_y - 44).max(margin_y)),
        "bottom-right" => (
            (pw - win_w - margin_x).max(0),
            (ph - win_h - margin_y - 44).max(margin_y),
        ),
        "custom" => {
            let min_x = virt_x;
            let min_y = virt_y;
            let max_x = (virt_x + virt_w - win_w).max(min_x);
            let max_y = (virt_y + virt_h - win_h).max(min_y);
            (custom_x.clamp(min_x, max_x), custom_y.clamp(min_y, max_y))
        }
        _ => (margin_x, margin_y),
    }
}

/// 把前景灰度掩码 + 阴影轮廓灰度掩码合成为 32-bit 预乘 BGRA 缓冲。
/// 背景区域 alpha 严格为 0（仅未锁定的自定义拖动模式允许极微弱 `hit_alpha = 1` 以便轻松抓拖）。
pub fn composite_premultiplied_bgra(
    fg_luma: &[u8],
    shadow_luma: &[u8],
    rgb: (u8, u8, u8),
    draggable_hit_box: bool,
) -> Vec<u8> {
    let n = fg_luma.len().min(shadow_luma.len());
    let mut out = vec![0u8; n * 4];
    let (fr, fg, fb) = (rgb.0 as f32, rgb.1 as f32, rgb.2 as f32);
    for i in 0..n {
        let fa = fg_luma[i] as f32 / 255.0;
        let sa = (shadow_luma[i] as f32 / 255.0) * 0.72;
        let mut oa = fa + sa * (1.0 - fa);
        if oa <= 0.0001 {
            if draggable_hit_box {
                // 1/255 对肉眼完全不可见，但确保 Win32 UpdateLayeredWindow 命中测试稳定可拖动
                out[i * 4 + 3] = 1;
            }
            continue;
        }
        if oa > 1.0 {
            oa = 1.0;
        }
        let a_u8 = (oa * 255.0).round().clamp(0.0, 255.0) as u8;
        let r_u8 = (fr * fa).round().clamp(0.0, a_u8 as f32) as u8;
        let g_u8 = (fg * fa).round().clamp(0.0, a_u8 as f32) as u8;
        let b_u8 = (fb * fa).round().clamp(0.0, a_u8 as f32) as u8;
        out[i * 4] = b_u8;
        out[i * 4 + 1] = g_u8;
        out[i * 4 + 2] = r_u8;
        out[i * 4 + 3] = a_u8;
    }
    out
}

/// 滑动窗口 DWM 帧率计算器（纯算法层，支持单元测试）。
#[derive(Debug, Default)]
pub struct FpsWindow {
    ring: VecDeque<(f64, u64)>,
    smoothed: f64,
    has_smoothed: bool,
}

impl FpsWindow {
    pub fn push(&mut self, now_sec: f64, frame_counter: u64, refresh_hz: u32) -> FpsSample {
        // 若计数器倒退或停顿超过 3 秒，重置窗口防异常尖峰
        if let Some(&(last_t, last_c)) = self.ring.back() {
            if now_sec < last_t || (now_sec - last_t) > 3.0 || frame_counter < last_c {
                self.ring.clear();
                self.has_smoothed = false;
            }
        }
        self.ring.push_back((now_sec, frame_counter));
        while self.ring.len() > 2 {
            if let Some(&(oldest_t, _)) = self.ring.front() {
                if now_sec - oldest_t > 1.05 {
                    self.ring.pop_front();
                } else {
                    break;
                }
            } else {
                break;
            }
        }

        let raw_fps = if self.ring.len() >= 2 {
            let (t0, c0) = *self.ring.front().unwrap();
            let dt = (now_sec - t0).max(0.001);
            let df = frame_counter.saturating_sub(c0) as f64;
            (df / dt).clamp(0.0, 999.0)
        } else {
            0.0
        };

        let fps_val = if self.ring.len() < 2 {
            0.0
        } else if !self.has_smoothed {
            self.smoothed = raw_fps;
            self.has_smoothed = true;
            raw_fps
        } else {
            // 适度响应的指数平滑：帧率突变快速跟上，平稳时不抖动
            self.smoothed = self.smoothed * 0.45 + raw_fps * 0.55;
            self.smoothed
        };

        let fps_u32 = fps_val.round().clamp(0.0, 999.0) as u32;
        let frame_ms = if fps_val >= 0.5 {
            ((1000.0 / fps_val) * 10.0).round() / 10.0
        } else {
            0.0
        };
        FpsSample {
            fps: fps_u32,
            refresh_hz,
            frame_ms,
        }
    }
}

type PersistCallback = Arc<dyn Fn(&FpsOverlayConfig) + Send + Sync + 'static>;

struct SharedState {
    config: FpsOverlayConfig,
    latest: FpsSample,
    persist_cb: Option<PersistCallback>,
    #[cfg(windows)]
    hwnd_raw: isize,
}

static OVERLAY_STATE: OnceLock<Mutex<SharedState>> = OnceLock::new();
static SAMPLE_WINDOW: OnceLock<Mutex<(Instant, FpsWindow)>> = OnceLock::new();

fn state_lock() -> &'static Mutex<SharedState> {
    OVERLAY_STATE.get_or_init(|| {
        Mutex::new(SharedState {
            config: FpsOverlayConfig::default(),
            latest: FpsSample {
                fps: 0,
                refresh_hz: 60,
                frame_ms: 0.0,
            },
            persist_cb: None,
            #[cfg(windows)]
            hwnd_raw: 0,
        })
    })
}

pub fn init_with_config(mut cfg: FpsOverlayConfig, on_persist: PersistCallback) {
    cfg.sanitize();
    let should_start = cfg.enabled;
    if let Ok(mut st) = state_lock().lock() {
        st.config = cfg;
        st.persist_cb = Some(on_persist);
    }
    if should_start {
        #[cfg(windows)]
        win32_impl::ensure_started();
    }
}

pub fn get_config() -> FpsOverlayConfig {
    state_lock()
        .lock()
        .map(|s| s.config.clone())
        .unwrap_or_default()
}

pub fn get_latest_sample() -> FpsSample {
    #[cfg(windows)]
    {
        if let Ok(st) = state_lock().lock() {
            if st.hwnd_raw != 0 {
                return st.latest.clone();
            }
        }
        return sample_dwm_once();
    }
    #[cfg(not(windows))]
    {
        FpsSample {
            fps: 0,
            refresh_hz: 60,
            frame_ms: 0.0,
        }
    }
}

pub fn apply_config(mut cfg: FpsOverlayConfig) -> FpsOverlayConfig {
    cfg.sanitize();
    let (cb_opt, was_enabled) = {
        let mut st = state_lock().lock().unwrap();
        let prev = st.config.enabled;
        st.config = cfg.clone();
        (st.persist_cb.clone(), prev)
    };
    if let Some(cb) = cb_opt {
        cb(&cfg);
    }
    #[cfg(windows)]
    {
        if cfg.enabled {
            win32_impl::ensure_started();
            win32_impl::notify_config_changed();
        } else if was_enabled {
            win32_impl::stop_overlay();
        }
    }
    cfg
}

pub fn shutdown() {
    #[cfg(windows)]
    win32_impl::stop_overlay();
}

#[cfg(windows)]
fn read_dwm_timing() -> Option<(u64, u32)> {
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct UnsignedRatio {
        ui_numerator: u32,
        ui_denominator: u32,
    }

    #[repr(C, packed(1))]
    #[derive(Clone, Copy)]
    struct DwmTimingInfo {
        cb_size: u32,
        rate_refresh: UnsignedRatio,
        qpc_refresh_period: u64,
        rate_compose: UnsignedRatio,
        qpc_vblank: u64,
        c_refresh: u64,
        c_dx_refresh: u32,
        qpc_compose: u64,
        c_frame: u64,
        c_dx_present: u32,
        c_refresh_frame: u64,
        c_frame_submitted: u64,
        c_dx_present_submitted: u32,
        c_frame_confirmed: u64,
        c_dx_present_confirmed: u32,
        c_refresh_confirmed: u64,
        c_dx_refresh_confirmed: u32,
        c_frames_late: u64,
        c_frames_outstanding: u32,
        c_frame_displayed: u64,
        qpc_frame_displayed: u64,
        c_refresh_frame_displayed: u64,
        c_frame_complete: u64,
        qpc_frame_complete: u64,
        c_frame_pending: u64,
        qpc_frame_pending: u64,
        c_frames_displayed: u64,
        c_frames_complete: u64,
        c_frames_pending: u64,
        c_frames_available: u64,
        c_frames_dropped: u64,
        c_frames_missed: u64,
        c_refresh_next_displayed: u64,
        c_refresh_next_presented: u64,
        c_refreshes_displayed: u64,
        c_refreshes_presented: u64,
        c_refresh_started: u64,
        c_pixels_received: u64,
        c_pixels_drawn: u64,
        c_buffers_empty: u64,
    }

    type FnDwmTiming = unsafe extern "system" fn(isize, *mut DwmTimingInfo) -> i32;
    static DWM_LIB: OnceLock<Option<libloading::Library>> = OnceLock::new();
    let lib = DWM_LIB
        .get_or_init(|| unsafe { libloading::Library::new("dwmapi.dll").ok() })
        .as_ref()?;
    let func: libloading::Symbol<FnDwmTiming> =
        unsafe { lib.get(b"DwmGetCompositionTimingInfo\0").ok()? };
    let mut info: DwmTimingInfo = unsafe { std::mem::zeroed() };
    info.cb_size = std::mem::size_of::<DwmTimingInfo>() as u32;
    let hr = unsafe { func(0, &mut info) };
    if hr != 0 {
        return None;
    }
    let num = { info.rate_refresh.ui_numerator };
    let den = { info.rate_refresh.ui_denominator }.max(1);
    let hz = ((num as f64) / (den as f64)).round().clamp(1.0, 1000.0) as u32;
    let c_frame = { info.c_frame };
    let c_dx = { info.c_dx_present } as u64;
    Some((c_frame.max(c_dx), hz))
}

#[cfg(windows)]
fn sample_dwm_once() -> FpsSample {
    let lock = SAMPLE_WINDOW.get_or_init(|| Mutex::new((Instant::now(), FpsWindow::default())));
    let mut guard = lock.lock().unwrap();
    let now_sec = guard.0.elapsed().as_secs_f64();
    if let Some((counter, hz)) = read_dwm_timing() {
        guard.1.push(now_sec, counter, hz)
    } else {
        FpsSample {
            fps: 0,
            refresh_hz: 60,
            frame_ms: 0.0,
        }
    }
}

#[cfg(windows)]
mod win32_impl {
    use super::*;
    use std::ffi::c_void;
    use std::ptr::{null, null_mut};
    use std::sync::atomic::{AtomicBool, Ordering};

    const WS_POPUP: u32 = 0x8000_0000;
    const WS_EX_TOPMOST: u32 = 0x0000_0008;
    const WS_EX_TRANSPARENT: u32 = 0x0000_0020;
    const WS_EX_TOOLWINDOW: u32 = 0x0000_0080;
    const WS_EX_LAYERED: u32 = 0x0008_0000;
    const WS_EX_NOACTIVATE: u32 = 0x0800_0000;

    const SW_SHOWNOACTIVATE: i32 = 4;
    const HWND_TOPMOST: isize = -1;
    const SWP_NOSIZE: u32 = 0x0001;
    const SWP_NOMOVE: u32 = 0x0002;
    const SWP_NOACTIVATE: u32 = 0x0010;
    const SWP_FRAMECHANGED: u32 = 0x0020;

    const GWL_EXSTYLE: i32 = -20;
    const SM_CXSCREEN: i32 = 0;
    const SM_CYSCREEN: i32 = 1;
    const SM_XVIRTUALSCREEN: i32 = 76;
    const SM_YVIRTUALSCREEN: i32 = 77;
    const SM_CXVIRTUALSCREEN: i32 = 78;
    const SM_CYVIRTUALSCREEN: i32 = 79;

    const WM_DESTROY: u32 = 0x0002;
    const WM_CLOSE: u32 = 0x0010;
    const WM_SETCURSOR: u32 = 0x0020;
    const WM_NCLBUTTONDOWN: u32 = 0x00A1;
    const WM_TIMER: u32 = 0x0113;
    const WM_LBUTTONDOWN: u32 = 0x0201;
    const WM_EXITSIZEMOVE: u32 = 0x0232;
    const WM_APP_REFRESH: u32 = 0x8000 + 17;
    const HTCAPTION: usize = 2;
    const IDC_SIZEALL: usize = 32646;

    const ULW_ALPHA: u32 = 0x0000_0002;
    const AC_SRC_OVER: u8 = 0x00;
    const AC_SRC_ALPHA: u8 = 0x01;
    const BI_RGB: u32 = 0;
    const DIB_RGB_COLORS: u32 = 0;
    const TRANSPARENT_BK: i32 = 1;
    const ANTIALIASED_QUALITY: u32 = 4;
    const FW_BOLD: i32 = 700;
    const DT_SINGLELINE: u32 = 0x0020;
    const DT_CENTER: u32 = 0x0001;
    const DT_VCENTER: u32 = 0x0004;
    const DT_NOCLIP: u32 = 0x0100;

    const TIMER_ID: usize = 1;
    const TIMER_MS: u32 = 250;

    static RUNNING: AtomicBool = AtomicBool::new(false);

    #[repr(C)]
    struct Point {
        x: i32,
        y: i32,
    }
    #[repr(C)]
    struct Size {
        cx: i32,
        cy: i32,
    }
    #[repr(C)]
    struct Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }
    #[repr(C)]
    struct BlendFunction {
        blend_op: u8,
        blend_flags: u8,
        source_constant_alpha: u8,
        alpha_format: u8,
    }
    #[repr(C)]
    struct BitmapInfoHeader {
        bi_size: u32,
        bi_width: i32,
        bi_height: i32,
        bi_planes: u16,
        bi_bit_count: u16,
        bi_compression: u32,
        bi_size_image: u32,
        bi_xpels_per_meter: i32,
        bi_ypels_per_meter: i32,
        bi_clr_used: u32,
        bi_clr_important: u32,
    }
    #[repr(C)]
    struct BitmapInfo {
        bmi_header: BitmapInfoHeader,
        bmi_colors: [u32; 1],
    }
    #[repr(C)]
    struct WndClassExW {
        cb_size: u32,
        style: u32,
        lpfn_wnd_proc: unsafe extern "system" fn(isize, u32, usize, isize) -> isize,
        cb_cls_extra: i32,
        cb_wnd_extra: i32,
        h_instance: isize,
        h_icon: isize,
        h_cursor: isize,
        h_br_background: isize,
        lpsz_menu_name: *const u16,
        lpsz_class_name: *const u16,
        h_icon_sm: isize,
    }
    #[repr(C)]
    struct Msg {
        hwnd: isize,
        message: u32,
        w_param: usize,
        l_param: isize,
        time: u32,
        pt: Point,
    }

    #[link(name = "user32")]
    extern "system" {
        fn RegisterClassExW(wc: *const WndClassExW) -> u16;
        fn CreateWindowExW(
            ex_style: u32,
            class_name: *const u16,
            window_name: *const u16,
            style: u32,
            x: i32,
            y: i32,
            w: i32,
            h: i32,
            parent: isize,
            menu: isize,
            inst: isize,
            param: *mut c_void,
        ) -> isize;
        fn DefWindowProcW(hwnd: isize, msg: u32, wp: usize, lp: isize) -> isize;
        fn ShowWindow(hwnd: isize, cmd: i32) -> i32;
        fn SetWindowPos(hwnd: isize, after: isize, x: i32, y: i32, cx: i32, cy: i32, flags: u32) -> i32;
        fn GetWindowRect(hwnd: isize, rect: *mut Rect) -> i32;
        fn GetWindowLongPtrW(hwnd: isize, index: i32) -> isize;
        fn SetWindowLongPtrW(hwnd: isize, index: i32, val: isize) -> isize;
        fn GetSystemMetrics(index: i32) -> i32;
        fn GetDC(hwnd: isize) -> isize;
        fn ReleaseDC(hwnd: isize, hdc: isize) -> i32;
        fn UpdateLayeredWindow(
            hwnd: isize,
            hdc_dst: isize,
            ppt_dst: *const Point,
            psize: *const Size,
            hdc_src: isize,
            ppt_src: *const Point,
            cr_key: u32,
            pblend: *const BlendFunction,
            flags: u32,
        ) -> i32;
        fn SetTimer(hwnd: isize, id: usize, elapse: u32, func: *const c_void) -> usize;
        fn KillTimer(hwnd: isize, id: usize) -> i32;
        fn PostMessageW(hwnd: isize, msg: u32, wp: usize, lp: isize) -> i32;
        fn SendMessageW(hwnd: isize, msg: u32, wp: usize, lp: isize) -> isize;
        fn GetMessageW(msg: *mut Msg, hwnd: isize, min: u32, max: u32) -> i32;
        fn TranslateMessage(msg: *const Msg) -> i32;
        fn DispatchMessageW(msg: *const Msg) -> isize;
        fn PostQuitMessage(code: i32);
        fn ReleaseCapture() -> i32;
        fn LoadCursorW(inst: isize, name: usize) -> isize;
        fn SetCursor(hcursor: isize) -> isize;
        fn DrawTextW(hdc: isize, text: *const u16, count: i32, rect: *mut Rect, fmt: u32) -> i32;
    }

    #[link(name = "gdi32")]
    extern "system" {
        fn CreateCompatibleDC(hdc: isize) -> isize;
        fn DeleteDC(hdc: isize) -> i32;
        fn CreateDIBSection(
            hdc: isize,
            pbmi: *const BitmapInfo,
            usage: u32,
            ppv_bits: *mut *mut c_void,
            h_section: isize,
            offset: u32,
        ) -> isize;
        fn CreateFontW(
            height: i32,
            width: i32,
            esc: i32,
            orient: i32,
            weight: i32,
            italic: u32,
            underline: u32,
            strike: u32,
            charset: u32,
            out_prec: u32,
            clip_prec: u32,
            quality: u32,
            pitch: u32,
            face: *const u16,
        ) -> isize;
        fn SelectObject(hdc: isize, obj: isize) -> isize;
        fn DeleteObject(obj: isize) -> i32;
        fn SetBkMode(hdc: isize, mode: i32) -> i32;
        fn SetTextColor(hdc: isize, color: u32) -> u32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetModuleHandleW(name: *const u16) -> isize;
    }

    fn to_wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn overlay_box_size(font_size: u32) -> (i32, i32) {
        let fs = font_size.clamp(20, 56) as i32;
        let w = (fs * 3 + 22).max(88);
        let h = (fs + 16).max(40);
        (w, h)
    }

    fn apply_ex_style(hwnd: isize, cfg: &FpsOverlayConfig) {
        unsafe {
            let cur = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
            let next = if cfg.is_click_through() {
                cur | WS_EX_TRANSPARENT
            } else {
                cur & !WS_EX_TRANSPARENT
            };
            if next != cur {
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next as isize);
                SetWindowPos(
                    hwnd,
                    HWND_TOPMOST,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED,
                );
            }
        }
    }

    fn render_fps_layered(hwnd: isize, fps: u32, cfg: &FpsOverlayConfig, reposition: bool) {
        let (win_w, win_h) = overlay_box_size(cfg.font_size);
        let rgb = parse_hex_rgb(&cfg.color).unwrap_or((52, 211, 153));
        let text_w = to_wide(&fps.to_string());
        let text_len = (text_w.len() - 1) as i32;
        let font_face = to_wide("Bahnschrift");

        unsafe {
            let screen_dc = GetDC(0);
            if screen_dc == 0 {
                return;
            }
            let mem_dc = CreateCompatibleDC(screen_dc);
            if mem_dc == 0 {
                ReleaseDC(0, screen_dc);
                return;
            }

            let bmi = BitmapInfo {
                bmi_header: BitmapInfoHeader {
                    bi_size: std::mem::size_of::<BitmapInfoHeader>() as u32,
                    bi_width: win_w,
                    bi_height: -win_h, // top-down DIB
                    bi_planes: 1,
                    bi_bit_count: 32,
                    bi_compression: BI_RGB,
                    bi_size_image: 0,
                    bi_xpels_per_meter: 0,
                    bi_ypels_per_meter: 0,
                    bi_clr_used: 0,
                    bi_clr_important: 0,
                },
                bmi_colors: [0],
            };
            let mut bits_ptr: *mut c_void = null_mut();
            let hbm = CreateDIBSection(mem_dc, &bmi, DIB_RGB_COLORS, &mut bits_ptr, 0, 0);
            if hbm == 0 || bits_ptr.is_null() {
                DeleteDC(mem_dc);
                ReleaseDC(0, screen_dc);
                return;
            }
            let old_bm = SelectObject(mem_dc, hbm);
            let hfont = CreateFontW(
                -(cfg.font_size.clamp(20, 56) as i32),
                0,
                0,
                0,
                FW_BOLD,
                0,
                0,
                0,
                1, // DEFAULT_CHARSET
                0,
                0,
                ANTIALIASED_QUALITY,
                0,
                font_face.as_ptr(),
            );
            let old_font = if hfont != 0 { SelectObject(mem_dc, hfont) } else { 0 };
            SetBkMode(mem_dc, TRANSPARENT_BK);
            SetTextColor(mem_dc, 0x00FF_FFFF);

            let pixel_count = (win_w * win_h) as usize;
            let buf = std::slice::from_raw_parts_mut(bits_ptr as *mut u8, pixel_count * 4);

            // Pass 1: 1px 轮廓 + 轻投影灰度掩码（保证纯数字在纯白/纯黑画面上均清晰）
            buf.fill(0);
            let offsets: [(i32, i32); 9] = [
                (-1, 0),
                (1, 0),
                (0, -1),
                (0, 1),
                (-1, -1),
                (1, -1),
                (-1, 1),
                (1, 1),
                (1, 2),
            ];
            let dt_flags = DT_SINGLELINE | DT_CENTER | DT_VCENTER | DT_NOCLIP;
            for (dx, dy) in offsets {
                let mut rc = Rect {
                    left: dx,
                    top: dy,
                    right: win_w + dx,
                    bottom: win_h + dy,
                };
                DrawTextW(mem_dc, text_w.as_ptr(), text_len, &mut rc, dt_flags);
            }
            let mut shadow_luma = vec![0u8; pixel_count];
            for i in 0..pixel_count {
                shadow_luma[i] = buf[i * 4].max(buf[i * 4 + 1]).max(buf[i * 4 + 2]);
            }

            // Pass 2: 纯前景数字抗锯齿灰度掩码
            buf.fill(0);
            let mut rc_fg = Rect {
                left: 0,
                top: 0,
                right: win_w,
                bottom: win_h,
            };
            DrawTextW(mem_dc, text_w.as_ptr(), text_len, &mut rc_fg, dt_flags);
            let mut fg_luma = vec![0u8; pixel_count];
            for i in 0..pixel_count {
                fg_luma[i] = buf[i * 4].max(buf[i * 4 + 1]).max(buf[i * 4 + 2]);
            }

            // Pass 3: 合成逐像素预乘 BGRA（零背景底框）
            let draggable = !cfg.is_click_through();
            let composed = composite_premultiplied_bgra(&fg_luma, &shadow_luma, rgb, draggable);
            buf.copy_from_slice(&composed);

            let dst_pt = if reposition {
                let (x, y) = compute_overlay_origin(
                    &cfg.position,
                    cfg.custom_x,
                    cfg.custom_y,
                    win_w,
                    win_h,
                    GetSystemMetrics(SM_CXSCREEN),
                    GetSystemMetrics(SM_CYSCREEN),
                    GetSystemMetrics(SM_XVIRTUALSCREEN),
                    GetSystemMetrics(SM_YVIRTUALSCREEN),
                    GetSystemMetrics(SM_CXVIRTUALSCREEN),
                    GetSystemMetrics(SM_CYVIRTUALSCREEN),
                );
                Some(Point { x, y })
            } else {
                None
            };
            let src_pt = Point { x: 0, y: 0 };
            let sz = Size { cx: win_w, cy: win_h };
            let blend = BlendFunction {
                blend_op: AC_SRC_OVER,
                blend_flags: 0,
                source_constant_alpha: 255,
                alpha_format: AC_SRC_ALPHA,
            };
            UpdateLayeredWindow(
                hwnd,
                screen_dc,
                dst_pt.as_ref().map_or(null(), |p| p as *const Point),
                &sz,
                mem_dc,
                &src_pt,
                0,
                &blend,
                ULW_ALPHA,
            );
            // 确保始终置顶且不抢焦点
            SetWindowPos(
                hwnd,
                HWND_TOPMOST,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            );

            if old_font != 0 {
                SelectObject(mem_dc, old_font);
            }
            if hfont != 0 {
                DeleteObject(hfont);
            }
            SelectObject(mem_dc, old_bm);
            DeleteObject(hbm);
            DeleteDC(mem_dc);
            ReleaseDC(0, screen_dc);
        }
    }

    unsafe extern "system" fn wnd_proc(hwnd: isize, msg: u32, wp: usize, lp: isize) -> isize {
        match msg {
            WM_TIMER => {
                let sample = sample_dwm_once();
                let cfg = {
                    let mut st = state_lock().lock().unwrap();
                    st.latest = sample.clone();
                    st.config.clone()
                };
                render_fps_layered(hwnd, sample.fps, &cfg, false);
                0
            }
            WM_APP_REFRESH => {
                let (cfg, fps) = {
                    let st = state_lock().lock().unwrap();
                    (st.config.clone(), st.latest.fps)
                };
                apply_ex_style(hwnd, &cfg);
                render_fps_layered(hwnd, fps, &cfg, true);
                0
            }
            WM_SETCURSOR => {
                let cfg = get_config();
                if !cfg.is_click_through() {
                    let cur = LoadCursorW(0, IDC_SIZEALL);
                    if cur != 0 {
                        SetCursor(cur);
                        return 1;
                    }
                }
                DefWindowProcW(hwnd, msg, wp, lp)
            }
            WM_LBUTTONDOWN => {
                let cfg = get_config();
                if !cfg.is_click_through() {
                    ReleaseCapture();
                    SendMessageW(hwnd, WM_NCLBUTTONDOWN, HTCAPTION, 0);
                    return 0;
                }
                0
            }
            WM_EXITSIZEMOVE => {
                let mut rc = Rect {
                    left: 0,
                    top: 0,
                    right: 0,
                    bottom: 0,
                };
                if GetWindowRect(hwnd, &mut rc) != 0 {
                    let (cb_opt, next_cfg) = {
                        let mut st = state_lock().lock().unwrap();
                        st.config.position = "custom".to_string();
                        st.config.custom_x = rc.left;
                        st.config.custom_y = rc.top;
                        (st.persist_cb.clone(), st.config.clone())
                    };
                    if let Some(cb) = cb_opt {
                        cb(&next_cfg);
                    }
                }
                0
            }
            WM_CLOSE => {
                KillTimer(hwnd, TIMER_ID);
                PostQuitMessage(0);
                0
            }
            WM_DESTROY => {
                KillTimer(hwnd, TIMER_ID);
                if let Ok(mut st) = state_lock().lock() {
                    st.hwnd_raw = 0;
                }
                PostQuitMessage(0);
                0
            }
            _ => DefWindowProcW(hwnd, msg, wp, lp),
        }
    }

    pub fn ensure_started() {
        if RUNNING.swap(true, Ordering::SeqCst) {
            return;
        }
        std::thread::Builder::new()
            .name("qdisk-fps-overlay".into())
            .spawn(|| {
                let class_name = to_wide("QDiskFpsHudOverlayWindowV1");
                let title = to_wide("QDisk FPS");
                unsafe {
                    let hinst = GetModuleHandleW(null());
                    let wc = WndClassExW {
                        cb_size: std::mem::size_of::<WndClassExW>() as u32,
                        style: 0,
                        lpfn_wnd_proc: wnd_proc,
                        cb_cls_extra: 0,
                        cb_wnd_extra: 0,
                        h_instance: hinst,
                        h_icon: 0,
                        h_cursor: LoadCursorW(0, IDC_SIZEALL),
                        h_br_background: 0,
                        lpsz_menu_name: null(),
                        lpsz_class_name: class_name.as_ptr(),
                        h_icon_sm: 0,
                    };
                    let _ = RegisterClassExW(&wc);

                    let cfg = get_config();
                    let (win_w, win_h) = overlay_box_size(cfg.font_size);
                    let (x, y) = compute_overlay_origin(
                        &cfg.position,
                        cfg.custom_x,
                        cfg.custom_y,
                        win_w,
                        win_h,
                        GetSystemMetrics(SM_CXSCREEN),
                        GetSystemMetrics(SM_CYSCREEN),
                        GetSystemMetrics(SM_XVIRTUALSCREEN),
                        GetSystemMetrics(SM_YVIRTUALSCREEN),
                        GetSystemMetrics(SM_CXVIRTUALSCREEN),
                        GetSystemMetrics(SM_CYVIRTUALSCREEN),
                    );
                    let mut ex_style =
                        WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
                    if cfg.is_click_through() {
                        ex_style |= WS_EX_TRANSPARENT;
                    }
                    let hwnd = CreateWindowExW(
                        ex_style,
                        class_name.as_ptr(),
                        title.as_ptr(),
                        WS_POPUP,
                        x,
                        y,
                        win_w,
                        win_h,
                        0,
                        0,
                        hinst,
                        null_mut(),
                    );
                    if hwnd == 0 {
                        RUNNING.store(false, Ordering::SeqCst);
                        return;
                    }
                    if let Ok(mut st) = state_lock().lock() {
                        st.hwnd_raw = hwnd;
                    }
                    let first = sample_dwm_once();
                    if let Ok(mut st) = state_lock().lock() {
                        st.latest = first.clone();
                    }
                    render_fps_layered(hwnd, first.fps, &cfg, true);
                    ShowWindow(hwnd, SW_SHOWNOACTIVATE);
                    SetTimer(hwnd, TIMER_ID, TIMER_MS, null());

                    let mut msg: Msg = std::mem::zeroed();
                    while GetMessageW(&mut msg, 0, 0, 0) > 0 {
                        TranslateMessage(&msg);
                        DispatchMessageW(&msg);
                    }

                    if let Ok(mut st) = state_lock().lock() {
                        st.hwnd_raw = 0;
                    }
                }
                RUNNING.store(false, Ordering::SeqCst);
            })
            .ok();
    }

    pub fn notify_config_changed() {
        let hwnd = state_lock().lock().map(|s| s.hwnd_raw).unwrap_or(0);
        if hwnd != 0 {
            unsafe {
                PostMessageW(hwnd, WM_APP_REFRESH, 0, 0);
            }
        }
    }

    pub fn stop_overlay() {
        let hwnd = state_lock().lock().map(|s| s.hwnd_raw).unwrap_or(0);
        if hwnd != 0 {
            unsafe {
                PostMessageW(hwnd, WM_CLOSE, 0, 0);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_hex_rgb_supports_six_and_three_digits_and_rejects_invalid() {
        assert_eq!(parse_hex_rgb("#34D399"), Some((52, 211, 153)));
        assert_eq!(parse_hex_rgb("FACC15"), Some((250, 204, 21)));
        assert_eq!(parse_hex_rgb("#fff"), Some((255, 255, 255)));
        assert_eq!(parse_hex_rgb("xyz"), None);
        assert_eq!(parse_hex_rgb("#12345"), None);
    }

    #[test]
    fn compute_overlay_origin_handles_all_five_presets_and_custom_clamping() {
        let (x1, y1) = compute_overlay_origin("top-left", 0, 0, 118, 48, 1920, 1080, 0, 0, 1920, 1080);
        assert_eq!((x1, y1), (20, 14));

        let (x2, y2) = compute_overlay_origin("top-center", 0, 0, 118, 48, 1920, 1080, 0, 0, 1920, 1080);
        assert_eq!((x2, y2), ((1920 - 118) / 2, 14));

        let (x3, y3) = compute_overlay_origin("top-right", 0, 0, 118, 48, 1920, 1080, 0, 0, 1920, 1080);
        assert_eq!((x3, y3), (1920 - 118 - 20, 14));

        let (x4, y4) = compute_overlay_origin("bottom-left", 0, 0, 118, 48, 1920, 1080, 0, 0, 1920, 1080);
        assert_eq!((x4, y4), (20, 1080 - 48 - 14 - 44));

        let (x5, y5) = compute_overlay_origin("bottom-right", 0, 0, 118, 48, 1920, 1080, 0, 0, 1920, 1080);
        assert_eq!((x5, y5), (1920 - 118 - 20, 1080 - 48 - 14 - 44));

        // Custom supports negative multi-monitor coords and clamps out-of-bounds
        let (xc1, yc1) = compute_overlay_origin("custom", -500, 120, 118, 48, 1920, 1080, -1920, 0, 3840, 1080);
        assert_eq!((xc1, yc1), (-500, 120));
        let (xc2, yc2) = compute_overlay_origin("custom", 99999, -999, 118, 48, 1920, 1080, 0, 0, 1920, 1080);
        assert_eq!((xc2, yc2), (1920 - 118, 0));
    }

    #[test]
    fn composite_premultiplied_bgra_has_zero_bg_alpha_and_valid_premult() {
        let fg = [0u8, 0, 255, 128];
        let sh = [0u8, 200, 255, 255];
        let buf = composite_premultiplied_bgra(&fg, &sh, (52, 211, 153), false);
        // Pixel 0: pure transparent background
        assert_eq!(&buf[0..4], &[0, 0, 0, 0]);
        // Pixel 1: shadow-only pixel -> black color with partial alpha
        assert_eq!(buf[4], 0);
        assert_eq!(buf[5], 0);
        assert_eq!(buf[6], 0);
        assert!(buf[7] > 100 && buf[7] < 200);
        // Pixel 2: full opaque foreground -> exact RGB & alpha 255
        assert_eq!(&buf[8..12], &[153, 211, 52, 255]);
        // Pixel 3: premultiplied invariant (b <= a, g <= a, r <= a)
        let a = buf[15];
        assert!(buf[12] <= a && buf[13] <= a && buf[14] <= a);

        // Draggable mode sets invisible 1/255 hit-test alpha on empty pixels
        let drag_buf = composite_premultiplied_bgra(&fg, &sh, (52, 211, 153), true);
        assert_eq!(&drag_buf[0..4], &[0, 0, 0, 1]);
    }

    #[test]
    fn fps_window_computes_accurate_rate_and_recovers_from_counter_reset() {
        let mut w = FpsWindow::default();
        let s0 = w.push(1.0, 1000, 144);
        assert_eq!(s0.fps, 0);
        let s1 = w.push(1.5, 1072, 144);
        assert_eq!(s1.fps, 144);
        assert_eq!(s1.refresh_hz, 144);
        assert!((s1.frame_ms - 6.9).abs() <= 0.2);

        // Counter reset must not underflow or spike
        let s_reset = w.push(2.0, 10, 144);
        assert_eq!(s_reset.fps, 0);
        let s_after = w.push(2.5, 40, 144);
        assert_eq!(s_after.fps, 60);
    }
}
