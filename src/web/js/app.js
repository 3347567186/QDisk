/* 应用外壳：导航、路由、主题、侧栏折叠、引擎状态
 * Developer: 白林 (Type) <3347567186@qq.com>
 * Note: 独立开发者白林（是个帅气的男孩）；开发者信息仅留存于底层源码与 AI 助手内部认知，不展示于软件界面。
 */
(function () {
  const { h, T, icon, toast, setActions } = UI;

  const NAV = [
    { id: 'ai', zh: 'AI 助手', en: 'Assistant', icon: 'spark' },
    { id: 'organize', zh: '整理文件', en: 'Organize', icon: 'organize' },
    { id: 'shots', zh: '清理截图', en: 'Screenshots', icon: 'shots' },
    { id: 'cache', zh: '清理缓存', en: 'Cache', icon: 'cache' },
    { id: 'tools', zh: '空间工具', en: 'Space tools', icon: 'scan' },
    { id: 'archive', zh: '压缩包', en: 'Archives', icon: 'archive' },
    { id: 'search', zh: '搜索文件', en: 'Search', icon: 'search' },
    { id: 'rules', zh: '高级规则', en: 'Rules', icon: 'rules' },
    { id: 'apps', zh: '应用与自启', en: 'Apps & Startup', icon: 'apps' },
    { id: 'migrate', zh: '数据迁移', en: 'Migrate', icon: 'migrate' },
    { id: 'log', zh: '日志', en: 'Logs', icon: 'log' },
    { id: 'settings', zh: '设置', en: 'Settings', icon: 'settings' }
  ];

  const BUILTIN_NAV_IDS = new Set(NAV.map((n) => n.id));
  const appHooks = new Map();

  function onAppHook(event, fn) {
    if (typeof event !== 'string' || !event || typeof fn !== 'function') return () => {};
    let set = appHooks.get(event);
    if (!set) { set = new Set(); appHooks.set(event, set); }
    set.add(fn);
    return () => offAppHook(event, fn);
  }

  function offAppHook(event, fn) {
    const set = appHooks.get(event);
    if (!set) return;
    if (fn) set.delete(fn);
    else set.clear();
    if (!set.size) appHooks.delete(event);
  }

  function emitAppHook(event, payload) {
    const set = appHooks.get(event);
    if (!set || !set.size) return;
    for (const fn of Array.from(set)) {
      try { fn(payload); } catch { /* 外部钩子异常不得中断主应用流程 */ }
    }
  }

  /* 只在轻量页播光标搭建动画：数据页的 canvas/clip-path 会额外吃数秒 CPU */

  const App = {
    current: 'organize',
    cfg: null,
    async boot() {
      /* 前端异常原来只进控制台，用户看到的是「点了没反应」；这里兜一条可见提示，
         免得一个渲染错误把功能变成哑巴。 */
      window.addEventListener('error', (e) => {
        try { UI.toast('脚本错误：' + ((e && e.message) || '未知'), 'error'); } catch (err) { /* ignore */ }
      });
      window.addEventListener('unhandledrejection', (e) => {
        try {
          const r = e && e.reason;
          UI.toast('脚本错误：' + ((r && r.message) || String(r || '未知')), 'error');
        } catch (err) { /* ignore */ }
      });
      try { this.cfg = await API.configGet(); } catch { this.cfg = {}; }
      const sizes = [15, 30, 60, 100, 200];
      UI.state.pageSize = sizes.includes(Number(this.cfg.page_size)) ? Number(this.cfg.page_size) : 15;
      this.powerMode = ['balanced', 'silent', 'turbo'].includes(this.cfg.power_mode) ? this.cfg.power_mode : 'balanced';
      applyMotion(this.cfg.motion || (this.powerMode === 'silent' ? 'lite' : 'full'));
      try { API.logLine('info', '启动：运行模式=' + this.powerMode + ' 动效=' + (document.body.dataset.motion || '')); } catch { /* ignore */ }
      applyTheme(this.cfg.theme || 'light');
      UI.setLang(this.cfg.lang || 'zh-CN');
      applySidebar(!!this.cfg.sidebar_collapsed);
      buildNav(this);
      initNavTip();
      if (UI.initGlobalTooltip) UI.initGlobalTooltip();
      window.addEventListener('hashchange', () => {
        const id = location.hash.replace('#', '');
        if (id && id !== this.current) navigate(id, false);
      });
      const start = NAV.some((n) => n.id === location.hash.replace('#', ''))
        ? location.hash.replace('#', '')
        : (this.cfg.last_page && NAV.some((n) => n.id === this.cfg.last_page) ? this.cfg.last_page : 'organize');
      await navigate(start, false);
      pollEngine(true);
      this._pollTimer = setInterval(() => pollEngine(false), 15000);
      /* 启动后延迟 6 秒静默检查一次官方 GitHub Releases 更新（无需用户配置任何网址） */
      this._updTimer = setTimeout(() => {
        if (document.hidden || typeof API.updaterStatus !== 'function' || typeof API.updaterCheck !== 'function') return;
        API.updaterStatus().then((st) => {
          if (!st || !st.config || !st.config.autoCheck) return null;
          return API.updaterCheck(st.config.channel);
        }).then((res) => {
          if (!res || !res.hasUpdate || res.isIgnored) return;
          App._pendingUpdate = res;
          emitAppHook('updater:available', res);
          const btn = document.querySelector('.nav-item[data-id="settings"]');
          if (btn) btn.classList.add('has-update');
          toast(UI.T('发现新版本 v' + res.latestVersion + '，可前往「设置 → 版本与在线更新」升级',
            'Update v' + res.latestVersion + ' available in Settings'), 'info', 6000);
        }).catch(() => { /* 离线或网络异常静默吞掉，绝不打扰启动 */ });
      }, 6000);
      /* 静默：窗口被隐藏/最小化后暂停轮询，按模式延迟退出引擎进程 */
      const onHidden = () => enterIdle(this);
      const onShown = () => leaveIdle(this);
      try {
        const ev = window.__TAURI__ && window.__TAURI__.event;
        ev && ev.listen('app-hidden', onHidden);
        ev && ev.listen('app-shown', onShown);
      } catch { /* ignore */ }
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) onHidden(); else onShown();
      });
      UI.onLangChange(() => { buildNav(this); renderChrome(this.current, this.cfg); });
      // 侧栏折叠按钮
      const toggle = document.getElementById('sidebar-toggle');
      toggle && toggle.addEventListener('click', () => {
        const on = !document.getElementById('app').classList.contains('collapsed');
        applySidebar(on);
        this.cfg = { ...(this.cfg || {}), sidebar_collapsed: on };
        API.configSet({ sidebar_collapsed: on }).catch(() => {});
      });
      wireShortcuts();
    },
    async setTheme(theme) {
      applyTheme(theme);
      this.cfg = { ...(this.cfg || {}), theme };
      emitAppHook('theme:changed', UI.state.theme);
      try { await API.configSet({ theme }); } catch { /* ignore */ }
    },
    async setLang(lang) {
      UI.setLang(lang);
      this.cfg = { ...(this.cfg || {}), lang };
      try { await API.configSet({ lang }); } catch { /* ignore */ }
      buildNav(this);
      renderChrome(this.current, this.cfg);
      emitAppHook('lang:changed', lang);
    },
    async setPageSize(n) {
      const sizes = [15, 30, 60, 100, 200];
      const v = sizes.includes(Number(n)) ? Number(n) : 15;
      UI.state.pageSize = v;
      this.cfg = { ...(this.cfg || {}), page_size: v };
      try { await API.configSet({ page_size: v }); } catch { /* ignore */ }
      /* 页面自己就地重渲染：直接 navigate 会因为「已在这一页」而提前返回，
         强制重挂载又会清空页面状态（例如扫描结果），所以交给页面接管。 */
      if (typeof App._onPageSize === 'function') {
        try { App._onPageSize(v); } catch (e) { console.error(e); }
        return;
      }
      await navigate(this.current, false);
    },
    async setPowerMode(mode) {
      const m = ['balanced', 'silent', 'turbo'].includes(mode) ? mode : 'balanced';
      this.powerMode = m;
      this.cfg = { ...(this.cfg || {}), power_mode: m };
      const motion = m === 'silent' ? 'lite' : (['lite', 'off'].includes(this.cfg.motion) ? this.cfg.motion : 'full');
      applyMotion(motion);
      emitAppHook('power:changed', m);
      try { await API.configSet({ power_mode: m }); } catch { /* ignore */ }
    },
    on: onAppHook,
    off: offAppHook,
    /** 预留拓展接口：注册自定义页面到导航与 Pages 注册表，无需修改 app.js 核心代码。 */
    registerPage(meta, pageModule, opts) {
      const o = opts || {};
      const m = meta || {};
      const id = String(m.id || '').trim();
      if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(id)) {
        throw new Error('扩展页面 id 须为 2-32 位小写字母/数字/_/- 组合');
      }
      if (!pageModule || typeof pageModule.mount !== 'function') {
        throw new Error('扩展页面必须提供 mount(node) 函数');
      }
      if (BUILTIN_NAV_IDS.has(id)) {
        throw new Error('内置页面不可被扩展覆盖：' + id);
      }
      if (NAV.some((n) => n.id === id) && !o.overwrite) {
        throw new Error('扩展页面已存在：' + id);
      }
      window.Pages = window.Pages || {};
      window.Pages[id] = pageModule;
      const entry = {
        id,
        zh: String(m.zh || m.label || id),
        en: String(m.en || m.label || id),
        icon: String(m.icon || 'tools')
      };
      const idx = NAV.findIndex((n) => n.id === id);
      if (idx >= 0) NAV[idx] = entry;
      else NAV.push(entry);
      if (document.getElementById('nav')) buildNav(this);
      emitAppHook('page:registered', { id, meta: entry });
      return () => this.unregisterPage(id);
    },
    unregisterPage(id) {
      const key = String(id || '').trim();
      if (BUILTIN_NAV_IDS.has(key)) {
        throw new Error('内置页面不可注销：' + key);
      }
      const idx = NAV.findIndex((n) => n.id === key);
      if (idx < 0) return false;
      NAV.splice(idx, 1);
      if (window.Pages && Object.prototype.hasOwnProperty.call(window.Pages, key)) {
        delete window.Pages[key];
      }
      if (document.getElementById('nav')) buildNav(this);
      emitAppHook('page:unregistered', { id: key });
      if (App._mountedId === key && document.getElementById('page')) {
        navigate('organize', true).catch(() => {});
      }
      return true;
    },
    listPages() {
      return NAV.map((n) => Object.assign({}, n, { builtin: BUILTIN_NAV_IDS.has(n.id) }));
    },
    async setMotion(mode) {
      const v = ['full', 'lite', 'off'].includes(mode) ? mode : 'full';
      this.cfg = { ...(this.cfg || {}), motion: v };
      applyMotion(v);
      try { await API.configSet({ motion: v }); } catch { /* ignore */ }
    }
  };
  window.App = App;

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
    UI.state.theme = document.documentElement.dataset.theme;
    /* 原生标题栏跟随应用主题：Windows 默认跟随系统深浅色，会在浅色界面上留一条黑边 */
    try { API.setWindowTheme(UI.state.theme).catch(() => {}); } catch { /* ignore */ }
    /* 只做首帧镜像，配置仍是唯一来源 */
    try { localStorage.setItem('ta.theme', UI.state.theme); } catch { /* ignore */ }
  }

  /* 动效强度：full / lite / off，由设置页与运行模式共同决定 */
  function applyMotion(mode) {
    const v = mode === 'off' ? 'off' : (mode === 'lite' ? 'lite' : 'full');
    document.body.dataset.motion = v;
    UI.state.motion = v;
  }

  /* 静默：隐藏后停轮询，按模式延迟释放引擎进程；恢复时立即重连 */
  function enterIdle(app) {
    if (document.body.dataset.idle === '1') return;
    document.body.dataset.idle = '1';
    try { API.logLine('info', '静默：进入空闲，模式=' + app.powerMode); } catch { /* ignore */ }
    if (app._pollTimer) { clearInterval(app._pollTimer); app._pollTimer = null; }
    if (app._updTimer) { clearTimeout(app._updTimer); app._updTimer = null; }
    if (app.powerMode === 'turbo') return;
    const delay = app.powerMode === 'silent' ? 20000 : 120000;
    clearTimeout(app._idleTimer);
    app._idleTimer = setTimeout(() => {
      if (document.body.dataset.idle !== '1') return;
      try { API.logLine('info', '静默：准备释放引擎'); } catch { /* ignore */ }
      API.engineSleep().then((r) => {
        try { API.logLine('info', '静默：引擎释放结果=' + JSON.stringify(r)); } catch { /* ignore */ }
      }).catch((e) => {
        try { API.logLine('error', '静默：释放失败 ' + (e && e.message ? e.message : e)); } catch { /* ignore */ }
      });
    }, delay);
  }

  function leaveIdle(app) {
    if (document.body.dataset.idle !== '1') return;
    delete document.body.dataset.idle;
    clearTimeout(app._idleTimer);
    app._idleTimer = null;
    if (!app._pollTimer) app._pollTimer = setInterval(() => pollEngine(false), 15000);
    pollEngine(false);
  }
  function applySidebar(collapsed) {
    document.getElementById('app').classList.toggle('collapsed', !!collapsed);
    if (navTip) navTip.hide();
  }

  /**
   * 快捷键与缩放防护：
   * WebView2 默认会响应 Ctrl+滚轮 / Ctrl+加减 做页面缩放，把整个界面放大后
   * 布局会错位、元素被裁掉。这里直接拦掉，缩放只保留系统 DPI。
   * F11 切全屏（走 Rust 的 toggle_fullscreen，比 DOM 全屏更贴合窗口行为）。
   */
  function wireShortcuts() {
    window.addEventListener('wheel', (e) => {
      if (e.ctrlKey) e.preventDefault();
    }, { passive: false });

    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && ['+', '-', '=', '0'].includes(e.key)) {
        e.preventDefault();
        return;
      }
      if (e.key === 'F11') {
        e.preventDefault();
        API.toggleFullscreen().catch(() => {});
      }
    });
  }

  /* 侧栏分组：只影响视觉层级，路由、页面与配置完全不变 */
  const NAV_GROUPS = [
    { zh: '助手', en: 'Assistant', ids: ['ai'] },
    { zh: '整理与清理', en: 'Organize', ids: ['organize', 'shots', 'cache', 'tools', 'archive'] },
    { zh: '查找与规则', en: 'Find', ids: ['search', 'rules'] },
    { zh: '系统', en: 'System', ids: ['apps', 'migrate', 'log', 'settings'] }
  ];

  /* AI 项不用线框图标：放一颗体素头像当入口。
     语言切换会重建导航，旧头像要先停掉自己的渲染循环再丢弃。 */
  function navMark(item) {
    if (item.id === 'ai' && window.SteveAvatar) {
      return window.SteveAvatar.el({ size: 28, variant: 'nav' });
    }
    return icon(item.icon);
  }

  /* 点 AI 入口：体素反馈动画 + 视口内安全爆裂 + 斯蒂夫声音 */
  function goNav(item, mark) {
    navigate(item.id);
    if (item.id === 'ai' && window.SteveAvatar) {
      if (typeof window.SteveAvatar.click === 'function') {
        window.SteveAvatar.click(mark);
      } else {
        window.SteveAvatar.spin(mark);
        window.SteveAvatar.burst(mark);
      }
    }
  }

  function buildNav(app) {
    const nav = document.getElementById('nav');
    nav.querySelectorAll('.steve').forEach((n) => { if (n._steve) n._steve.destroy(); });
    nav.innerHTML = '';
    const placed = new Set();
    NAV_GROUPS.forEach((group) => {
      const items = group.ids.map((id) => NAV.find((n) => n.id === id)).filter(Boolean);
      if (!items.length) return;
      const isAiGroup = group.ids.length === 1 && group.ids[0] === 'ai';
      const box = h('div', { class: 'nav-group' },
        isAiGroup ? null : h('div', { class: 'nav-group-label' }, UI.T(group.zh, group.en))
      );
      items.forEach((item) => {
        placed.add(item.id);
        const mark = navMark(item);
        const labelText = UI.T(item.zh, item.en);
        box.appendChild(h('button', {
          class: 'nav-item' + (item.id === app.current ? ' active' : ''),
          dataset: { id: item.id, icon: item.icon },
          'aria-label': labelText,
          title: item.id === 'ai' ? labelText : undefined,
          onclick: () => goNav(item, mark)
        }, mark, item.id === 'ai' ? null : h('span', { class: 'lbl' }, labelText)));
      });
      nav.appendChild(box);
    });
    // 兜底：将来新增但还没分组的页面仍能显示出来
    const rest = NAV.filter((n) => !placed.has(n.id));
    if (rest.length) {
      const box = h('div', { class: 'nav-group' },
        h('div', { class: 'nav-group-label' }, UI.T('其他', 'More'))
      );
      rest.forEach((item) => {
        const mark = navMark(item);
        box.appendChild(h('button', {
          class: 'nav-item' + (item.id === app.current ? ' active' : ''),
          dataset: { id: item.id, icon: item.icon },
          'aria-label': UI.T(item.zh, item.en),
          onclick: () => goNav(item, mark)
        }, mark, h('span', { class: 'lbl' }, UI.T(item.zh, item.en))));
      });
      nav.appendChild(box);
    }
    // 语言切换会重建导航，提示层的文案跟着换，胶囊本身不重建
    if (navTip) navTip.refresh();
  }

  /* 折叠轨的流体提示：整个侧栏只有一个胶囊。它沿入口纵向移动、宽度随文案变化；
     文案固定在各自入口的高度，被胶囊用 clip-path 裁切出来，形成上下滚动的切换。
     这样做是为了不让每个按钮各弹一个气泡，也不把提示堆在右侧挡住内容。 */
  let navTip = null;

  function initNavTip() {
    const nav = document.getElementById('nav');
    const sidebar = document.querySelector('.sidebar');
    if (!nav || !sidebar || navTip) return;
    const root = h('div', { class: 'nav-tip', 'aria-hidden': 'true' },
      h('div', { class: 'nav-tip-pill' }),
      h('div', { class: 'nav-tip-labels' })
    );
    const measure = h('span', { class: 'nav-tip-measure', 'aria-hidden': 'true' });
    root.appendChild(measure);
    document.body.appendChild(root);
    const labels = root.querySelector('.nav-tip-labels');
    const pill = root.querySelector('.nav-tip-pill');
    const H = 22;        // 胶囊高度：比 30px 的行高再收一圈
    const PAD = 7;       // 文案左右留白
    const OVERLAP = 14;  // 胶囊压进轨道右缘的宽度，尽量少盖右侧内容
    const MIN_W = 36;
    let on = false;
    let current = null;
    let lastY = 0;
    let showTimer = 0;
    let hideTimer = 0;

    const isRail = () => document.getElementById('app').classList.contains('collapsed')
      || (window.matchMedia && window.matchMedia('(max-width: 940px)').matches);

    const labelOf = (it) => {
      const lbl = it.querySelector('.lbl');
      return (lbl ? lbl.textContent : (it.getAttribute('aria-label') || '')).trim();
    };

    function labelWidth(text) {
      measure.textContent = text;
      return Math.ceil(measure.getBoundingClientRect().width);
    }

    /* 文案各自钉在自己入口的中心线上，只有胶囊在动 */
    function layoutLabels() {
      const x = Math.round(sidebar.getBoundingClientRect().right - OVERLAP);
      labels.style.setProperty('--tip-x', (x + PAD) + 'px');
      labels.querySelectorAll('.nav-tip-label').forEach((span) => {
        const it = nav.querySelector('.nav-item[data-id="' + span.dataset.id + '"]');
        if (!it) { span.style.display = 'none'; return; }
        span.style.display = '';
        const r = it.getBoundingClientRect();
        span.style.top = Math.round(r.top + r.height / 2) + 'px';
      });
    }

    function place(it, animate) {
      const nr = sidebar.getBoundingClientRect();
      const r = it.getBoundingClientRect();
      const x = Math.round(nr.right - OVERLAP);
      const y = Math.round(r.top + r.height / 2 - H / 2);
      const w = Math.max(MIN_W, labelWidth(labelOf(it)) + PAD * 2);
      // 距离越远走得越久，但收在 320ms 内，快速划过多项时不拖影
      const dur = animate ? Math.min(320, Math.round(170 + Math.abs(y - lastY) * 0.55)) : 0;
      root.style.setProperty('--tip-dur', dur + 'ms');
      if (!animate) {
        pill.style.transition = 'none';
        labels.style.transition = 'none';
      }
      pill.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';
      pill.style.width = w + 'px';
      labels.style.clipPath = 'inset(' + y + 'px ' + Math.max(0, window.innerWidth - (x + w)) + 'px '
        + Math.max(0, window.innerHeight - (y + H)) + 'px ' + x + 'px round ' + (H / 2) + 'px)';
      lastY = y;
      if (!animate) {
        void pill.offsetWidth; // 先把落点写进去，再放开过渡，否则会从上一个位置滑过来
        pill.style.transition = '';
        labels.style.transition = '';
      }
    }

    function show(it) {
      if (!it || !isRail()) return;
      const first = !on;
      current = it;
      if (first) layoutLabels();
      place(it, !first);
      if (first) { on = true; root.classList.add('on'); }
    }

    function hide() {
      clearTimeout(showTimer);
      current = null;
      if (!on) return;
      on = false;
      root.classList.remove('on');
    }

    nav.addEventListener('pointerover', (e) => {
      if (e.pointerType && e.pointerType !== 'mouse' && e.pointerType !== 'pen') return;
      const it = e.target.closest && e.target.closest('.nav-item');
      if (!it || !nav.contains(it)) return;
      clearTimeout(hideTimer);
      if (!isRail()) { hide(); return; }
      if (on) { show(it); return; } // 已经在：直接滑过去，不再闪一下
      clearTimeout(showTimer);
      showTimer = setTimeout(() => show(it), 80); // 只是路过时不亮
    });
    nav.addEventListener('pointerleave', () => {
      clearTimeout(showTimer);
      hideTimer = setTimeout(hide, 70);
    });
    // 点入口就切页了，胶囊没必要还留在原处
    nav.addEventListener('click', (e) => {
      if (e.target.closest && e.target.closest('.nav-item')) hide();
    });
    nav.addEventListener('focusin', (e) => {
      const it = e.target.closest && e.target.closest('.nav-item');
      if (it) show(it);
    });
    nav.addEventListener('focusout', (e) => {
      if (e.relatedTarget && nav.contains(e.relatedTarget)) return;
      hideTimer = setTimeout(hide, 60);
    });
    // 滚动/改窗口后入口位置变了，先收起，下次悬停再按新位置落
    nav.addEventListener('scroll', hide, { passive: true });
    window.addEventListener('resize', hide);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });

    // 侧栏列宽在动（折叠过渡、改窗口）时跟着走，别把胶囊留在旧位置
    if (window.ResizeObserver) {
      new ResizeObserver(() => {
        if (!on || !current) return;
        layoutLabels();
        place(current, false);
      }).observe(sidebar);
    }

    navTip = {
      refresh() {
        hide();
        labels.innerHTML = '';
        nav.querySelectorAll('.nav-item').forEach((it) => {
          labels.appendChild(h('span', {
            class: 'nav-tip-label',
            dataset: { id: it.dataset.id },
            text: labelOf(it)
          }));
        });
        layoutLabels();
      },
      hide,
      sync() { if (!isRail()) hide(); }
    };
    navTip.refresh();
  }

  function renderChrome(id, cfg) {
    const item = NAV.find((n) => n.id === id) || NAV[0];
    const page = (window.Pages || {})[id];
    const title = page && page.title ? UI.T(page.title[0], page.title[1]) : UI.T(item.zh, item.en);
    document.getElementById('page-title').textContent = title;
    document.getElementById('page-sub').textContent = '';
    document.title = title + ' · ' + UI.T('轻盘', 'QDisk');
  }

  /* 切页反馈：只在挂载真的变慢时出现，避免快页面闪一下进度条 */
  let navProg = null;
  let navProgOn = false;
  function setNavLoading(on) {
    if (!navProg) {
      navProg = document.createElement('div');
      navProg.className = 'nav-progress';
      document.body.appendChild(navProg);
    }
    if (on) {
      if (!navProgOn) { navProgOn = true; navProg.classList.add('on'); }
      return;
    }
    if (!navProgOn) return;
    navProgOn = false;
    navProg.classList.remove('on');
  }

  async function navigate(id, updateHash = true, opts = {}) {
    const page = (window.Pages || {})[id];
    if (!page) { toast(UI.T('页面尚未加载', 'Page not loaded'), 'warn'); return; }
    const root = document.getElementById('page');

    /* 已经在这一页：只同步导航状态，不重建 DOM。
       以前重复挂载会整页重播进场动画，看起来就是「每次点一下都闪一下刷新」。
       opts.force：带着载荷重新进来时必须重挂载，否则页面还留着上一次的结果。 */
    if (!(opts && opts.force) && App._mountedId === id && root && root.querySelector('.page-body')) {
      if (updateHash && location.hash !== '#' + id) history.replaceState(null, '', '#' + id);
      document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.id === id));
      UI.closeMenu();
      return;
    }

    App.current = id;
    const token = (App._navToken = (App._navToken || 0) + 1);
    if (updateHash && location.hash !== '#' + id) history.replaceState(null, '', '#' + id);
    // 离开上一页：让页面释放事件监听、临时预览文件与后台任务
    const prevId = App._mountedId || null;
    if (App._unmount) {
      try { App._unmount(); } catch { /* 页面清理失败不应阻塞切页 */ }
      App._unmount = null;
      if (prevId) emitAppHook('page:unmounted', { id: prevId });
    }
    /* 页面级钩子只属于刚卸载的那一页，切页时清掉，避免改到别的页 */
    App._onPageSize = null;
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.id === id));
    renderChrome(id, App.cfg);
    setActions();
    UI.closeMenu();
    // 切页时把残留的图片预览遮罩一并收掉，避免挡住新页面
    if (UI.closePreview) UI.closePreview();
    const holder = document.createElement('div');
    holder.className = 'page-body';
    /* data-enter 只在这一页刚挂载时存在，挂载完就摘掉：
       页内重新渲染（排序 / 翻页 / 扫描完成）不会再重播进场动画。 */
    holder.dataset.enter = '1';
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const old = root.firstElementChild;
    if (old && !reduce) {
      old.classList.add('page-exit');
      await new Promise((r) => setTimeout(r, 150));
      if (token !== App._navToken) return;
    }
    root.innerHTML = '';
    root.appendChild(holder);
    const navBtn = document.querySelector('.nav-item[data-id="' + id + '"]');
    if (navBtn) navBtn.classList.add('loading');
    const scroller = document.getElementById('scroll');
    if (scroller) scroller.scrollTop = 0;
    const slow = setTimeout(() => setNavLoading(true), 180);
    try {
      const unmount = await page.mount(holder);
      // 红队竞态防护：若挂载在途期间用户已切到新页面，必须立刻卸载过期页面，
      // 绝不能覆盖当前新页面的 App._unmount 导致资源永久泄漏！
      if (token !== App._navToken) {
        if (typeof unmount === 'function') {
          try { unmount(); } catch { /* ignore */ }
        }
        return;
      }
      App._unmount = typeof unmount === 'function' ? unmount : null;
    } catch (e) {
      if (navBtn) navBtn.classList.remove('loading');
      if (token !== App._navToken) return;
      holder.innerHTML = '';
      holder.appendChild(h('div', { class: 'empty' },
        h('div', { class: 'big' }, UI.T('页面加载失败', 'Failed to load page')),
        h('div', null, e && e.message ? e.message : String(e))
      ));
    } finally {
      clearTimeout(slow);
      setNavLoading(false);
    }
    if (navBtn) navBtn.classList.remove('loading');
    if (token !== App._navToken) return;
    clearTimeout(App._enterTimer);
    App._enterTimer = setTimeout(() => { delete holder.dataset.enter; }, 700);
    App._mountedId = id;
    emitAppHook('page:mounted', { id });
    App.cfg = { ...(App.cfg || {}), last_page: id };
    API.configSet({ last_page: id }).catch(() => {});
  }
  window.navigate = navigate;

  /* ---------------- 跨页跳转：带载荷 ----------------
     navigate 只负责「切到哪一页」，不带任何上下文。AI 回答里的「去工具页」
     以前只调 location.hash，于是目标页打开是空的，用户以为按钮坏了。
     跳转要说清「把什么带过去」：
       App.jump('tools', { paths: [...], action: 'check', why: '...' })
     目标页实现 page.jump(payload) 就地接收（切页后调用，页面已挂载完）。
     没有 jump 的页面退回普通切页，不报错。 */
  App.jump = async function (id, payload) {
    const page = (window.Pages || {})[id];
    if (!page) { toast(UI.T('页面尚未加载', 'Page not loaded'), 'warn'); return; }
    const data = payload || {};
    const pageEl = document.getElementById('page');
    const mounted = App._mountedId === id && pageEl && pageEl.querySelector('.page-body');
    if (mounted) {
      updateHashOf(id);
      document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.id === id));
      UI.closeMenu();
    } else {
      await navigate(id, true, { force: true });
    }
    if (typeof page.jump === 'function') {
      try { await page.jump(data); } catch (e) { toast((e && e.message) || String(e), 'error'); }
    }
  };
  function updateHashOf(id) {
    if (location.hash === '#' + id) return false;
    try { history.replaceState(null, '', '#' + id); } catch { /* ignore */ }
    return true;
  }

  async function pollEngine(first) {
    // 窗口最小化/切到后台时不打扰引擎，回来后的下一次心跳会自愈
    if (document.hidden) return;
    const dot = document.getElementById('engine-dot');
    const label = document.getElementById('engine-label');
    if (!dot || !label) return;
    try {
      await API.ping();
      dot.className = 'dot ok';
      label.textContent = UI.T('引擎已连接', 'Engine connected');
    } catch (e) {
      dot.className = 'dot bad';
      label.textContent = UI.T('引擎未连接', 'Engine offline');
      if (first) setTimeout(() => pollEngine(false), 3000);
    }
  }

  document.addEventListener('DOMContentLoaded', () => App.boot());
})();
