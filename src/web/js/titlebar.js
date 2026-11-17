/* 自绘标题栏：无边框窗口的最小化 / 最大化 / 关闭 / 边缘缩放
   依赖 Tauri 2 的 window API（withGlobalTauri 暴露在 __TAURI__.window）。
   拖动与贴边由 data-tauri-drag-region 交给系统处理，这里只补按钮和缩放热区。 */
(function () {
  'use strict';

  const T = window.__TAURI__;
  if (!T || !T.window || !T.window.getCurrentWindow) return;

  const win = T.window.getCurrentWindow();
  const $ = (sel) => document.querySelector(sel);

  const ICON_MAX =
    '<svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"><rect x="2.5" y="2.5" width="7" height="7" rx="1"/></svg>';
  const ICON_RESTORE =
    '<svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"><rect x="2" y="3.5" width="6" height="6" rx="1"/><path d="M4 3.5V2.6a.6.6 0 0 1 .6-.6h5a.6.6 0 0 1 .6.6v5a.6.6 0 0 1-.6.6H8.6"/></svg>';

  const maxBtn = $('#tb-max');
  let maximized = false;

  /* 用 Rust 侧的 Win32 命令，而不是 win.toggleMaximize()——
     无边框窗口上后者会出现“图标变了、窗口没变”的状态不同步。 */
  async function toggleMaximize() {
    try {
      maximized = await T.core.invoke('window_toggle_maximize');
    } catch (e) { /* 忽略 */ }
    applyState();
  }

  function applyState() {
    document.body.classList.toggle('is-maximized', maximized);
    if (maxBtn) {
      const label = maximized ? '还原' : '最大化';
      maxBtn.title = label;
      maxBtn.setAttribute('aria-label', label);
      maxBtn.innerHTML = maximized ? ICON_RESTORE : ICON_MAX;
    }
  }

  async function syncMaximized() {
    let fullscreen = false;
    try {
      maximized = await T.core.invoke('window_is_maximized');
      fullscreen = await win.isFullscreen();
    } catch (e) {
      maximized = false;
      fullscreen = false;
    }
    document.body.classList.toggle('is-fullscreen', fullscreen);
    applyState();
  }

  const minBtn = $('#tb-min');
  if (minBtn) minBtn.addEventListener('click', () => { win.minimize().catch(() => {}); });

  if (maxBtn) maxBtn.addEventListener('click', () => { toggleMaximize(); });

  const closeBtn = $('#tb-close');
  if (closeBtn) closeBtn.addEventListener('click', () => { win.close().catch(() => {}); });

  // 拖动：顶栏空白处（含标题文字）按下即拖；双击标题区最大化/还原
  const bar = document.querySelector('.topbar');
  if (bar) {
    const noDrag = (t) => t && t.closest && t.closest('.tb-pill, button, a, input, .top-actions');
    bar.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || noDrag(e.target)) return;
      T.core.invoke('window_begin_drag').catch(() => {});
    });
    bar.addEventListener('dblclick', (e) => {
      if (noDrag(e.target)) return;
      toggleMaximize();
    });
  }

  win.onResized(() => { syncMaximized(); }).catch(() => {});
  syncMaximized();

  // 8 个缩放热区：交给系统做真正的 resize，避免手写坐标计算
  const DIRS = {
    n: 'North', s: 'South', e: 'East', w: 'West',
    ne: 'NorthEast', nw: 'NorthWest', se: 'SouthEast', sw: 'SouthWest'
  };
  document.querySelectorAll('[data-resize]').forEach((el) => {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const dir = DIRS[el.dataset.resize];
      if (dir) win.startResizeDragging(dir).catch(() => {});
    });
  });
})();
