/* 卸载程序页：管理员状态条 + 图标列表 + 紧凑表格 + 行内操作 + 右键菜单 + 残留清理 */
(function () {
  'use strict';
  const { h, T, icon, fmtCount, fmtBytes, toast, busy, confirm, card, section, table,
    skeleton, empty, attachMenu, modal, softIn, setActions } = UI;
  const fmtSize = fmtBytes;

  let liveJump = null;

  /* 全局跨挂载持久化内存缓存：避免切页/切Tab重复发请求、闪骨架屏与白屏 */
  const GlobalAppsCache = {
    // 软件管理 Tab
    apps: null,
    store: null,
    storeLoaded: false,
    selectedKey: '',
    appsFilter: '',
    appsView: 'all',
    appsSortBy: 'name',
    appsSortAsc: true,
    appsPage: 1,

    // 开机自启 Tab
    startup: null,
    startupFilter: '',
    startupView: 'all',
    startupScope: 'all',
    startupPage: 1,

    // 后台进程 Tab
    procs: null,
    procRawCount: 0,
    procTotalRam: 0,
    procFilter: '',
    procView: 'all',
    procPage: 1,

    // 空间画像 Tab
    perfSamples: [],
    perfData: null,

    // 当前活跃 Tab
    activeTab: 'apps'
  };

  /* 每页 50 条；表头粘性由 .table th 的 position:sticky 提供，外层用 .table-wrap */
  let PAGE_SIZE = 15;
  /* 复用一个 Collator：每次 localeCompare 都新建选项对象，排序会慢一个数量级 */
  const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

  const errText = UI.errText;
  const keyOf = (a) => String((a && a.name) || '') + '\u0000' + String((a && a.version) || '');

  /**
   * 把注册表 DisplayIcon 值转成可显示的 URL。
   * 引擎给的形态可能是：`"C:\App\app.exe",0` / `C:\App\icon.ico` / 空串。
   * 只做「去引号 + 去 ,索引 + 转 convertFileSrc」，环境变量引擎已展开，这里不重复处理。
   * 非绝对路径（图标资源引用、相对路径等）返回空串，由调用方显示占位图标。
   */
  function iconUrl(raw) {
    let s = String(raw === null || raw === undefined ? '' : raw).trim();
    if (!s) return '';
    // `"C:\path\app.exe",0` → 先去引号与引号外的索引
    s = s.replace(/^"(.+?)"\s*(?:,\s*-?\d+)?$/, '$1');
    // 未加引号的 `C:\path\app.exe,0`
    s = s.replace(/,\s*-?\d+\s*$/, '');
    s = s.trim().replace(/^"+|"+$/g, '').trim();
    if (!s) return '';
    // DisplayIcon 里出现过资源写法（如 @dll,-1），非文件路径不渲染
    if (!/^[a-zA-Z]:[\\/]/.test(s) && !/^\\\\/.test(s)) return '';
    // 只有图片文件才值得走资产协议；.exe/.dll 会被整文件读出再解码失败
    // （实测一页 50 项因此读 887MB，见 2026-11-15 卡顿排查）
    if (!/\.(ico|png|jpe?g|gif|bmp|webp|svg)$/i.test(s)) return '';
    try {
      const core = window.__TAURI__ && window.__TAURI__.core;
      if (core && typeof core.convertFileSrc === 'function') return core.convertFileSrc(s);
    } catch (e) { /* 没有 Tauri 时退回 file:// */ }
    return 'file:///' + s.replace(/\\/g, '/');
  }

  /* 文本按钮：带图标 + 文案，记住双语标签方便切忙碌态 */
  function btn(zh, en, kind, iconName, onclick) {
    const label = h('span', null, T(zh, en));
    const b = h('button', {
      class: 'btn' + (kind ? ' ' + kind : ''),
      onclick: onclick
    }, iconName ? icon(iconName, 14) : null, label);
    b._zh = zh;
    b._en = en;
    b._label = label;
    return b;
  }

  function setBtnBusy(b, on, zh, en) {
    if (!b) return;
    b.disabled = !!on;
    b.classList.toggle('busy', !!on);
    if (b.classList.contains('no-label-swap') || b.querySelector('.ic-refresh')) {
      return;
    }
    if (b._label) b._label.textContent = on ? T(zh || '处理中…', en || 'Working…') : T(b._zh, b._en);
  }

  /* 行内 / 小尺寸图标按钮：只有图标，无障碍名称放 title + aria-label */
  function iconBtn(zh, en, iconName, onclick, danger) {
    return h('button', {
      class: 'btn icon sm ghost' + (danger ? ' danger' : ''),
      title: T(zh, en),
      'aria-label': T(zh, en),
      onclick: onclick
    }, icon(iconName, 13));
  }

  /* 分页条里的圆形图标键 */
  function pagerBtn(iconName, zh, en, onclick) {
    const b = h('button', {
      class: 'pg-btn',
      type: 'button',
      title: T(zh, en),
      'aria-label': T(zh, en)
    }, icon(iconName, 15));
    b.addEventListener('click', onclick);
    return b;
  }

  const copyText = UI.copy;

  async function mount(root) {
    root.classList.add('stack');
    PAGE_SIZE = UI.pageSize();

    /* 图标与首字母徽章：全页面通用共享 */
    function letterBlock(a) {
      const name = String((typeof a === 'string' ? a : (a && a.name)) || '?').trim();
      const ch = name ? name[0] : '?';
      let sum = 0;
      for (let i = 0; i < name.length; i++) sum = (sum + name.charCodeAt(i)) % 6;
      return h('span', {
        class: 'app-icon letter c' + (sum + 1),
        title: name,
        text: ch.toUpperCase()
      });
    }
    const iconCache = new WeakMap();
    function appIcon(a) {
      if (!a) return letterBlock(a);
      let targetObj = typeof a === 'object' ? a : null;
      let url = '';
      if (targetObj) {
        if (iconCache.has(targetObj)) url = iconCache.get(targetObj);
        else {
          url = iconUrl(targetObj.icon);
          iconCache.set(targetObj, url);
        }
      } else {
        url = iconUrl(a);
      }
      let node;
      if (!url) node = letterBlock(a);
      else {
        const img = h('img', {
          class: 'app-icon',
          alt: '',
          src: url,
          style: { width: '20px', height: '20px' },
          loading: 'lazy'
        });
        img.addEventListener('error', () => {
          const fb = letterBlock(a);
          if (targetObj) targetObj.__iconEl = fb;
          img.replaceWith(fb);
        });
        node = img;
      }
      if (targetObj) targetObj.__iconEl = node;
      return node;
    }

    let iconSeq = 0;
    async function hydrateIcons(items) {
      const seq = ++iconSeq;
      const need = [];
      (items || []).forEach((a) => {
        if (!a || a.icon || !a.icon_src || a.__iconAsked) return;
        if (!/\.(exe|dll|ico|png)$/i.test(a.icon_src)) return;
        a.__iconAsked = true;
        need.push(a);
      });
      if (!need.length) return;
      for (let i = 0; i < need.length; i += 16) {
        const chunk = need.slice(i, i + 16);
        let map = null;
        try {
          const r = await API.engine('apps.icons', { sources: chunk.map((a) => a.icon_src) });
          map = (r && r.icons) || null;
        } catch (e) {
          return;
        }
        if (seq !== iconSeq) return;
        if (!map) continue;
        chunk.forEach((a) => {
          const png = map[a.icon_src];
          if (!png || a.icon) return;
          a.icon = png;
          iconCache.delete(a);
          const old = a.__iconEl;
          if (old && old.parentNode) {
            const fresh = appIcon(a);
            old.replaceWith(fresh);
            a.__iconEl = fresh;
          }
        });
      }
    }

    function fmtAppSize(a) {
      const bytes = (Number(a.size) || 0) || ((Number(a.size_kb) || 0) * 1024);
      if (bytes <= 0) return '—';
      return fmtBytes(bytes);
    }

    function fmtAppDate(a) {
      if (a.install_date && typeof a.install_date === 'string' && a.install_date.trim()) {
        return a.install_date.trim();
      }
      if (a.date && Number(a.date) > 0) {
        try {
          const d = new Date(Number(a.date) * 1000);
          if (!isNaN(d.getTime()) && d.getFullYear() > 1990) {
            const y = d.getFullYear();
            const m = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return `${y}-${m}-${day}`;
          }
        } catch (_) {}
      }
      return '—';
    }

    const S = {
      items: GlobalAppsCache.apps ? GlobalAppsCache.apps.slice() : [],
      store: GlobalAppsCache.store ? GlobalAppsCache.store.slice() : [],
      storeLoaded: !!GlobalAppsCache.storeLoaded,
      storeLoading: false,
      filtered: [],
      visible: [],
      filter: GlobalAppsCache.appsFilter || '',
      page: GlobalAppsCache.appsPage || 1,
      sortAsc: GlobalAppsCache.appsSortAsc !== false,
      sortBy: GlobalAppsCache.appsSortBy || 'name',
      view: GlobalAppsCache.appsView || 'all',
      loading: false,
      isAdmin: false,
      uninstalling: false,
      selected: null,
      selectedKey: GlobalAppsCache.selectedKey || '',
      leftovers: null,
      leftoverApp: null,
      loSeq: 0,
      checkDirs: new Set(),
      checkRegs: new Set()
    };

    /* ---------------- 顶部：管理员状态（未提权强提醒横幅 vs 提权后融合按钮） ---------------- */
    let adminBannerDismissed = false;

    const adminIconBox = h('div', { class: 'admin-icon-box' }, icon('shield', 16));
    const adminTitle = h('span', { class: 'admin-title' }, T('未获取管理员权限', 'Running as standard user'));
    const adminDesc = h('span', { class: 'admin-desc' }, T('部分系统级软件卸载与 HKLM 开机自启项修改需要提升权限', 'Some system uninstallers and startup items require elevation'));
    const adminTextBox = h('div', { class: 'admin-content' }, adminTitle, adminDesc);
    const btnAdmin = h('button', {
      class: 'btn-admin-action',
      title: T('以管理员身份重新启动轻盘', 'Restart QDisk with administrator privileges'),
      onclick: doRestartAsAdmin
    }, icon('shield', 14), h('span', null, T('以管理员身份重启', 'Restart as admin')));

    const btnDismissBanner = h('button', {
      class: 'btn-dismiss',
      title: T('收起提醒（本次会话隐藏）', 'Dismiss for this session'),
      onclick: () => {
        adminBannerDismissed = true;
        updateAdminDisplay();
      }
    }, icon('close', 12));

    const adminBar = h('div', { class: 'admin-strip' },
      adminIconBox,
      adminTextBox,
      h('span', { class: 'spacer' }),
      btnAdmin,
      btnDismissBanner
    );

    // 提权后（或横幅收起后）融合到界面的精致状态按钮
    const fusedAdminDot = h('span', { class: 'admin-dot' });
    const fusedAdminLabel = h('span', { class: 'admin-label' }, T('检查中…', 'Checking…'));
    const fusedAdminBtn = h('button', {
      class: 'btn sm admin-fused-btn',
      style: { display: 'none' }
    }, icon('shield', 13), fusedAdminLabel, fusedAdminDot);

    /* ---------------- 主卡：过滤 + 统计一行 + 表格 + 分页 ---------------- */
    const filterInput = h('input', {
      class: 'input grow',
      type: 'search',
      autocomplete: 'off',
      spellcheck: 'false',
      value: S.filter,
      placeholder: T('按名称、发行商或安装路径过滤…', 'Filter by name, publisher or install path…')
    });
    filterInput.addEventListener('input', () => {
      S.filter = filterInput.value;
      GlobalAppsCache.appsFilter = S.filter;
      S.page = 1;
      GlobalAppsCache.appsPage = 1;
      /* 打字时每敲一个键都会重建表格：这时不做逐键淡入，否则整块表格一直在闪 */
      S.typing = true;
      clearTimeout(S.typingTimer);
      S.typingTimer = setTimeout(() => { S.typing = false; }, 400);
      applyFilter();
    });

    const btnRefresh = btn('刷新', 'Refresh', 'ghost no-label-swap', 'refresh', () => loadApps(true));
    btnRefresh.style.minWidth = '68px';
    const btnOrphan = btn('排查孤立残留', 'Scan orphans', 'ghost sm', 'scan', () => scanOrphanLeftovers());
    const pageInput = h('input', {
      class: 'input sm pg-input',
      type: 'text',
      inputmode: 'numeric',
      autocomplete: 'off',
      'aria-label': T('页码', 'Page number'),
      title: T('输入页码后回车跳转', 'Type a page number, then press Enter')
    });
    const pageTotal = h('span', { class: 'muted small num' }, '1');
    const pageSumNum = h('span', { class: 'muted small num' }, '0');
    const pageWrap = h('span', { class: 'pg-wrap' },
      h('span', { class: 'muted small' }, T('第', 'Page')),
      pageInput,
      h('span', { class: 'muted small pg-slash' }, '/'),
      pageTotal,
      h('span', { class: 'muted small' }, T('页', ''))
    );
    const btnPrev = pagerBtn('chevron-left', '上一页', 'Previous', () => gotoPage(S.page - 1));
    const btnNext = pagerBtn('chevron-right', '下一页', 'Next', () => gotoPage(S.page + 1));
    const pagerBar = h('div', { class: 'pager' }, btnPrev, pageWrap, btnNext);

    const statPill = h('span', { class: 'badge', style: { fontVariantNumeric: 'tabular-nums' } });
    const selInfo = h('span', { class: 'muted small ellipsis', style: { maxWidth: '240px' } }, '');

    function renderStatLine() {
      const total = allItems().length;
      let totalBytes = 0;
      allItems().forEach((it) => {
        totalBytes += (Number(it.size) || 0) || ((Number(it.size_kb) || 0) * 1024);
      });
      const remCount = (S.filtered || []).filter((a) => a.uninstall).length;
      const q = String(S.filter || '').trim();
      const countPart = q
        ? T(`已匹配 ${fmtCount(S.filtered.length)} 款（共 ${fmtCount(total)} 款）`, `Matched ${fmtCount(S.filtered.length)} of ${fmtCount(total)}`)
        : T(`共 ${fmtCount(total)} 款`, `Total ${fmtCount(total)}`);
      statPill.textContent = `${countPart} · ${fmtBytes(totalBytes)} · ${T('可卸载 ' + fmtCount(remCount), fmtCount(remCount) + ' removable')}`;
      selInfo.textContent = S.selected
        ? T('当前: ', 'Selected: ') + (S.selected.name || '') +
          (S.selected.version ? ' ' + S.selected.version : '')
        : '';
      selInfo.title = selInfo.textContent;
    }

    const tableBox = h('div');
    const actionMsg = h('div', { class: 'small muted ellipsis' });
    actionMsg.hidden = true;

    /* 分类按钮：全部 / 桌面应用 / 系统应用 */
    const viewBtns = {};
    function viewBtn(id, zh, en) {
      const b = h('button', { class: 'chip' + (S.view === id ? ' active' : '') }, T(zh, en));
      b.addEventListener('click', () => {
        if (S.view === id) {
          applyFilter();
          return;
        }
        S.view = id;
        GlobalAppsCache.appsView = id;
        Object.entries(viewBtns).forEach(([k, el]) => el.classList.toggle('active', k === id));
        S.page = 1;
        GlobalAppsCache.appsPage = 1;
        switchView();
      });
      viewBtns[id] = b;
      return b;
    }

    /* 切分类不许等网络：先用手里已有的数据立刻出表，Appx 列表在后台补齐后再补一帧。
       桌面App / 系统App 都可能包含 Appx 项，所以两边都要等它到齐。 */
    function switchView() {
      if (S.storeLoaded) { applyFilter(); return; }
      if (S.view === 'store') {
        S.filtered = [];
        S.visible = [];
        tableBox.replaceChildren(skeleton(6, 'apps'));
        renderStatLine();
        renderPager();
      } else {
        applyFilter();   // 桌面 / 全部：先显示已有数据，Appx 到了再补
      }
      ensureStore().then(() => {
        if (S.view === 'store' || S.view === 'all' || S.view === 'desktop') applyFilter();
      }).catch(() => {});
    }

    /* 商店应用按需读取：PowerShell 枚举约 1 秒。用共享 Promise 保证连点只跑一次，
       读取期间切分类既不重复发起，也不阻塞渲染。 */
    let storePromise = null;
    function ensureStore() {
      if (S.storeLoaded) return Promise.resolve(S.store);
      if (storePromise) return storePromise;
      S.storeLoading = true;
      storePromise = (async () => {
        try {
          const list = await API.storeApps();
          S.store = Array.isArray(list) ? list : [];
          S.storeLoaded = true;
          GlobalAppsCache.store = S.store;
          GlobalAppsCache.storeLoaded = true;
        } catch (e) {
          S.store = [];
          toast(T('读取系统应用失败：' + errText(e), 'Failed to read system apps: ' + errText(e)), 'error');
        } finally {
          S.storeLoading = false;
          storePromise = null;
        }
        return S.store;
      })();
      return storePromise;
    }

    /* 分类按安装来源判定，不看发行商：
       商店 = 安装在 WindowsApps（微软商店下载/预装应用）；
       系统 = 装在 Windows 目录或没有安装路径的微软组件；
       其余 = 第三方桌面程序，不打标。 */
    function appKind(it) {
      const p = String(it.install_path || '');
      if (it.source === 'store' || /\\windowsapps\\/i.test(p)) return 'store';
      if (/^[a-z]:\\windows(\\|$)/i.test(p)) return 'system';
      if (!p && /microsoft|windows/i.test(String(it.publisher || ''))) return 'system';
      return 'plain';
    }

    function allItems() {
      if (S.view === 'store') return S.items.filter((it) => appKind(it) === 'system' || appKind(it) === 'store').concat(S.store);
      if (S.view === 'desktop') return S.items.filter((it) => appKind(it) === 'plain');
      return S.items.concat(S.store);
    }

    function kindTag(it) {
      const k = appKind(it);
      if (k === 'store') return h('span', { class: 'tag store', title: T('微软商店应用', 'Microsoft Store app') }, T('商店', 'Store'));
      if (k === 'system') return h('span', { class: 'tag system', title: T('系统组件', 'System component') }, T('系统', 'System'));
      return null;
    }

    /* 排序：支持名称、大小、安装日期、发行商，点击同项可升降序切换 */
    const sortChips = {};
    function sortChip(id, zh, en) {
      const b = h('button', { class: 'chip' + (S.sortBy === id ? ' active' : ''), type: 'button' }, T(zh, en));
      b.addEventListener('click', () => {
        if (S.sortBy === id) {
          S.sortAsc = !S.sortAsc;
        } else {
          S.sortBy = id;
          // 大小和日期默认降序（大到小、新到旧），名称和发行商默认升序
          S.sortAsc = (id === 'name' || id === 'publisher');
        }
        GlobalAppsCache.appsSortBy = S.sortBy;
        GlobalAppsCache.appsSortAsc = S.sortAsc;
        S.page = 1;
        GlobalAppsCache.appsPage = 1;
        updateSortChips();
        applyFilter();
      });
      sortChips[id] = b;
      return b;
    }

    function updateSortChips() {
      const labels = {
        name: ['名称', 'Name'],
        size: ['大小', 'Size'],
        date: ['安装日期', 'Date'],
        publisher: ['发行商', 'Publisher']
      };
      Object.entries(sortChips).forEach(([k, el]) => {
        const isActive = (S.sortBy === k);
        el.classList.toggle('active', isActive);
        const pair = labels[k] || [k, k];
        const arrow = isActive ? (S.sortAsc ? ' ↑' : ' ↓') : '';
        el.textContent = T(pair[0] + arrow, pair[1] + arrow);
      });
    }

    const mainCard = card(
      h('div', { class: 'card-title' },
        h('h2', null, T('已安装程序', 'Installed programs'))
      ),
      // 第一行：搜索过滤 + 视图切换 (全部/桌面/系统) + 刷新 + 孤立残留排查
      h('div', { class: 'toolbar' },
        filterInput,
        h('div', { class: 'seg' },
          viewBtn('all', '全部', 'All'),
          viewBtn('desktop', '桌面应用', 'Desktop apps'),
          viewBtn('store', '系统应用', 'System apps')
        ),
        btnRefresh,
        btnOrphan
      ),
      // 第二行：数据统计 + 排序分段控件 + 分页
      h('div', { class: 'toolbar wrap' },
        statPill,
        selInfo,
        h('span', { class: 'spacer' }),
        h('span', { class: 'muted small' }, T('排序', 'Sort')),
        h('div', { class: 'seg' },
          sortChip('name', '名称', 'Name'),
          sortChip('size', '大小', 'Size'),
          sortChip('date', '安装日期', 'Date'),
          sortChip('publisher', '发行商', 'Publisher')
        ),
        h('span', { class: 'spacer' }),
        pagerBar,
        UI.pageSizePick((n) => App.setPageSize(n))
      ),
      tableBox,
      actionMsg
    );



    /* ================================================================
       顶级领域分类 Tab 切换器：严格物理隔离【软件本体】/【开机自启动】/【空间画像】
       ================================================================ */
    let currentTab = 'apps';

    function makeTabBtn(id, iconName, zh, en) {
      const badge = h('span', { class: 'wb-tab-badge', style: { display: 'none' } }, '0');
      const b = h('button', {
        class: 'wb-tab' + (currentTab === id ? ' active' : ''),
        type: 'button',
        onclick: () => switchTab(id)
      }, icon(iconName, 13), h('span', null, T(zh, en)), badge);
      b._badge = badge;
      return b;
    }

    const tabAppsBtn = makeTabBtn('apps', 'apps', '已安装程序', 'Installed Apps');
    const tabStartupBtn = makeTabBtn('startup', 'spark', '开机自启', 'Startup Apps');
    const tabProcsBtn = makeTabBtn('procs', 'scan', '后台进程', 'Running Procs');
    const tabFootprintBtn = makeTabBtn('footprint', 'chart', '空间画像', 'Space Footprint');

    function setTabBadge(btnEl, n) {
      if (!btnEl || !btnEl._badge) return;
      const num = Number(n) || 0;
      if (num > 0) {
        btnEl._badge.textContent = String(num);
        btnEl._badge.style.display = '';
      } else {
        btnEl._badge.style.display = 'none';
      }
    }

    function updateTabBadges() {
      const appsTotal = S.items.length + S.store.length;
      setTabBadge(tabAppsBtn, appsTotal);
      setTabBadge(tabStartupBtn, StartupState.items.length);
      setTabBadge(tabProcsBtn, ProcState.items.length);
    }

    /* 面板内【问助手】入口（Tab 感知上下文） */
    let isMounted = true;
    const topAskBtn = UI.askBtn({
      title: T('让助手分析已安装软件、开机自启与磁盘空间画像', 'Ask AI about apps, startup items, and space footprint'),
      ctx: () => {
        if (currentTab === 'startup') {
          return {
            page: '应用与自启',
            tool: '开机自启动',
            tab: 'startup',
            count: StartupState.items.length,
            note: `共 ${StartupState.items.length} 个自启动项（已启用 ${StartupState.items.filter((i) => i.enabled).length}，失效 ${StartupState.items.filter((i) => !i.exists).length}）`
          };
        }
        if (currentTab === 'procs') {
          return {
            page: '应用与自启',
            tool: '后台进程管理',
            tab: 'procs',
            count: ProcState.items.length,
            note: `共 ${ProcState.items.length} 个后台应用 (${ProcState.rawCount} 进程)，物理内存总计 ${fmtSize(ProcState.totalMemory)}`
          };
        }
        if (currentTab === 'footprint') {
          const valid = S.items.map((it) => {
            const sz = Number(it.size) || (Number(it.size_kb) ? Number(it.size_kb) * 1024 : 0);
            return Object.assign({}, it, { size: sz });
          }).filter((it) => (it.size || 0) > 0);
          const total = valid.reduce((sum, it) => sum + (it.size || 0), 0);
          return {
            page: '应用与自启',
            tool: '磁盘空间画像',
            tab: 'footprint',
            count: S.items.length,
            size: fmtBytes(total),
            note: `已测算 ${valid.length} 款软件的磁盘空间占用`
          };
        }
        return {
          page: '应用与自启',
          tool: '已安装程序',
          tab: 'apps',
          count: S.items.length,
          filter: S.filter,
          note: `共发现 ${S.items.length} 个已安装程序`
        };
      }
    });

    const topTabBar = h('div', { class: 'wb-bar top-tab-bar', style: { marginBottom: '4px' } },
      h('div', { class: 'wb-tabs' }, tabAppsBtn, tabStartupBtn, tabProcsBtn, tabFootprintBtn),
      h('span', { class: 'spacer' }),
      fusedAdminBtn,
      topAskBtn
    );

    /* ================================================================
       TAB 2: 开机自启动管理 (Startup Items Governance)
       ================================================================ */
    const StartupState = {
      items: GlobalAppsCache.startup ? GlobalAppsCache.startup.slice() : [],
      filtered: [],
      visible: [],
      filter: GlobalAppsCache.startupFilter || '',
      view: GlobalAppsCache.startupView || 'all', // 'all' | 'enabled' | 'disabled' | 'broken'
      scope: GlobalAppsCache.startupScope || 'all', // 'all' | 'user' | 'system'
      page: GlobalAppsCache.startupPage || 1,
      loading: false
    };

    const startupTableBox = h('div', { class: 'table-wrap' });

    const startupFilterInput = h('input', {
      class: 'input grow',
      type: 'search',
      autocomplete: 'off',
      spellcheck: 'false',
      value: StartupState.filter,
      placeholder: T('按名称、位置或路径过滤…', 'Filter by name, location or path…')
    });
    startupFilterInput.addEventListener('input', () => {
      StartupState.filter = startupFilterInput.value.trim().toLowerCase();
      GlobalAppsCache.startupFilter = StartupState.filter;
      StartupState.page = 1;
      GlobalAppsCache.startupPage = 1;
      applyStartupFilter();
    });

    const btnRefreshStartup = btn('刷新', 'Refresh', 'ghost sm', 'refresh', () => loadStartup(true));
    const btnCleanBroken = btn('清理失效项', 'Clean Broken', 'danger sm', 'trash', cleanAllBroken);
    btnCleanBroken.style.display = 'none';

    // 状态分类按钮与来源范围按钮
    const startupViewBtns = {};
    function startupViewBtn(kind, zh, en) {
      const b = h('button', {
        class: 'chip' + (StartupState.view === kind ? ' active' : ''),
        type: 'button',
        onclick: () => {
          if (StartupState.view === kind) return;
          StartupState.view = kind;
          Object.entries(startupViewBtns).forEach(([k, el]) => el.classList.toggle('active', k === kind));
          StartupState.page = 1;
          applyStartupFilter();
        }
      }, T(zh, en));
      startupViewBtns[kind] = b;
      return b;
    }

    const startupScopeBtns = {};
    function startupScopeBtn(scope, zh, en) {
      const b = h('button', {
        class: 'chip' + (StartupState.scope === scope ? ' active' : ''),
        type: 'button',
        onclick: () => {
          if (StartupState.scope === scope) return;
          StartupState.scope = scope;
          Object.entries(startupScopeBtns).forEach(([k, el]) => el.classList.toggle('active', k === scope));
          StartupState.page = 1;
          applyStartupFilter();
        }
      }, T(zh, en));
      startupScopeBtns[scope] = b;
      return b;
    }

    // 分页控件
    const startupPageInput = h('input', {
      class: 'input sm pg-input',
      type: 'text',
      inputmode: 'numeric',
      autocomplete: 'off',
      'aria-label': T('页码', 'Page number'),
      title: T('输入页码后回车跳转', 'Type a page number, then press Enter')
    });
    const startupPageTotal = h('span', { class: 'muted small num' }, '1');
    const startupPageSumNum = h('span', { class: 'muted small num' }, '0');
    const startupPageWrap = h('span', { class: 'pg-wrap' },
      h('span', { class: 'muted small' }, T('第', 'Page')),
      startupPageInput,
      h('span', { class: 'muted small pg-slash' }, '/'),
      startupPageTotal,
      h('span', { class: 'muted small' }, T('页', '')),
      h('span', { class: 'muted small pg-dot' }, '·'),
      h('span', { class: 'muted small' }, T('共', 'Total')),
      startupPageSumNum,
      h('span', { class: 'muted small' }, T('项', 'items'))
    );
    const btnStartupPrev = pagerBtn('chevron-left', '上一页', 'Previous', () => gotoStartupPage(StartupState.page - 1));
    const btnStartupNext = pagerBtn('chevron-right', '下一页', 'Next', () => gotoStartupPage(StartupState.page + 1));
    const startupPagerBar = h('div', { class: 'pager' }, btnStartupPrev, startupPageWrap, btnStartupNext);

    startupPageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const v = parseInt(startupPageInput.value, 10);
        if (!isNaN(v)) gotoStartupPage(v);
      }
    });

    function gotoStartupPage(p) {
      const total = StartupState.filtered.length;
      const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      StartupState.page = Math.min(Math.max(1, p), pages);
      applyStartupFilter();
    }

    // 统计徽章
    const statStartupAll = h('span', { class: 'badge' });
    const statStartupEnabled = h('span', { class: 'badge ok' });
    const statStartupDisabled = h('span', { class: 'badge neutral' });
    const statStartupBroken = h('span', { class: 'badge danger' });
    statStartupBroken.style.display = 'none';

    const startupStatLine = h('div', { class: 'row wrap', style: { alignItems: 'center', gap: '8px' } },
      statStartupAll,
      statStartupEnabled,
      statStartupDisabled,
      statStartupBroken,
      h('span', { class: 'spacer' }),
      h('span', { class: 'muted small' }, T('每页', 'Per page')),
      UI.pageSizePick((n) => {
        PAGE_SIZE = n;
        StartupState.page = 1;
        applyStartupFilter();
      })
    );

    const startupCard = card(
      h('div', { class: 'card-title' },
        h('h2', null, T('开机自启', 'Startup Apps'))
      ),
      h('div', { class: 'toolbar' },
        startupFilterInput,
        btnRefreshStartup,
        btnCleanBroken,
        h('span', { class: 'spacer' }),
        startupPagerBar
      ),
      h('div', { class: 'toolbar row wrap', style: { gap: '8px', alignItems: 'center' } },
        h('div', { class: 'seg' },
          startupViewBtn('all', '全部状态', 'All Status'),
          startupViewBtn('enabled', '已启用', 'Enabled'),
          startupViewBtn('disabled', '已禁用', 'Disabled'),
          startupViewBtn('broken', '⚠️ 失效项', '⚠️ Broken')
        ),
        h('span', { class: 'spacer' }),
        h('div', { class: 'seg' },
          startupScopeBtn('all', '全部来源', 'All Sources'),
          startupScopeBtn('user', '👤 桌面应用', '👤 User Apps'),
          startupScopeBtn('system', '🛡️ 系统服务', '🛡️ System & Services')
        )
      ),
      startupStatLine,
      startupTableBox
    );
    startupCard.style.display = 'none';

    async function loadStartup(force) {
      if (StartupState.loading) return;
      StartupState.loading = true;
      if (force || !StartupState.items.length) {
        startupTableBox.innerHTML = '';
        startupTableBox.appendChild(skeleton(6, 'apps'));
      }
      try {
        const res = await API.engine('startup.list', { refresh: !!force });
        StartupState.items = Array.isArray(res && res.items) ? res.items : [];
        GlobalAppsCache.startup = StartupState.items;
        StartupState.page = 1;
        applyStartupFilter();
      } catch (err) {
        startupTableBox.innerHTML = '';
        startupTableBox.appendChild(empty(T('读取自启动项失败：' + errText(err), 'Failed to load startup items: ' + errText(err))));
      } finally {
        StartupState.loading = false;
      }
    }

    function applyStartupFilter() {
      const q = String(StartupState.filter || '').trim().toLowerCase();
      let list = StartupState.items.slice();
      if (StartupState.view === 'enabled') {
        list = list.filter((it) => it.enabled && it.exists);
      } else if (StartupState.view === 'disabled') {
        list = list.filter((it) => !it.enabled && it.exists);
      } else if (StartupState.view === 'broken') {
        list = list.filter((it) => !it.exists);
      }

      if (StartupState.scope === 'user') {
        list = list.filter((it) => it.scope === 'user');
      } else if (StartupState.scope === 'system') {
        list = list.filter((it) => it.scope === 'system');
      }

      if (q) {
        list = list.filter((it) =>
          String(it.name || '').toLowerCase().includes(q) ||
          String(it.command || '').toLowerCase().includes(q) ||
          String(it.location || '').toLowerCase().includes(q)
        );
      }
      StartupState.filtered = list;
      const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
      StartupState.page = Math.min(Math.max(1, StartupState.page), pages);
      const start = (StartupState.page - 1) * PAGE_SIZE;
      StartupState.visible = list.slice(start, start + PAGE_SIZE);

      renderStartupStats();
      renderStartupTable();
    }

    function renderStartupStats() {
      const total = StartupState.items.length;
      const enabled = StartupState.items.filter((it) => it.enabled && it.exists).length;
      const disabled = StartupState.items.filter((it) => !it.enabled && it.exists).length;
      const broken = StartupState.items.filter((it) => !it.exists).length;

      statStartupAll.textContent = T(`全部 ${fmtCount(total)}`, `All ${fmtCount(total)}`);
      statStartupEnabled.textContent = T(`已启用 ${fmtCount(enabled)}`, `Enabled ${fmtCount(enabled)}`);
      statStartupDisabled.textContent = T(`已禁用 ${fmtCount(disabled)}`, `Disabled ${fmtCount(disabled)}`);
      updateTabBadges();

      if (broken > 0) {
        statStartupBroken.style.display = '';
        statStartupBroken.textContent = T(`⚠️ 失效项 ${fmtCount(broken)}`, `⚠️ Broken ${fmtCount(broken)}`);
        btnCleanBroken.style.display = '';
        if (btnCleanBroken._label) {
          btnCleanBroken._label.textContent = T(`清理失效项 (${broken})`, `Clean broken (${broken})`);
        }
      } else {
        statStartupBroken.style.display = 'none';
        btnCleanBroken.style.display = 'none';
      }

      const matchTotal = StartupState.filtered.length;
      const pages = Math.max(1, Math.ceil(matchTotal / PAGE_SIZE));
      startupPageInput.value = String(StartupState.page);
      startupPageTotal.textContent = String(pages);
      startupPageSumNum.textContent = fmtCount(matchTotal);
      btnStartupPrev.disabled = StartupState.page <= 1;
      btnStartupNext.disabled = StartupState.page >= pages;
    }

    async function handleStartupAdminError(err, actionName) {
      const msg = (err && (err.message || err.error)) || String(err || '');
      const isDenied = msg.includes('管理员权限') || msg.includes('拒绝访问') || msg.includes('WinError 5') || (err && err.code === 'admin_required');
      if (isDenied) {
        const goAdmin = await confirm({
          title: T('需要管理员权限', 'Administrator Privileges Required'),
          body: T(`${actionName || '此操作'}涉及系统级（HKLM）注册表或系统启动目录，需要以管理员身份运行才能修改。\n\n是否立即以管理员身份重启轻盘？`,
            `${actionName || 'This action'} modifies system-level (HKLM) registry or system startup folders, requiring administrator privileges.\n\nRestart QDisk as Administrator now?`),
          okText: T('以管理员身份重启', 'Restart as admin')
        });
        if (goAdmin) {
          doRestartAsAdmin();
        }
        return true;
      }
      return false;
    }

    function renderStartupTable() {
      startupTableBox.innerHTML = '';
      if (!StartupState.filtered.length) {
        startupTableBox.appendChild(empty(T('没有符合条件的自启动项', 'No matching startup items')));
        return;
      }

      const tbl = table({
        columns: [
          {
            key: 'status',
            label: T('状态', 'Status'),
            width: '95px',
            render: (it) => {
              if (!it.exists) return h('span', { class: 'badge danger' }, T('⚠️ 文件丢失', '⚠️ Broken'));
              if (it.enabled) return h('span', { class: 'badge ok' }, T('已启用', 'Enabled'));
              return h('span', { class: 'badge neutral' }, T('已禁用', 'Disabled'));
            }
          },
          {
            key: 'name',
            label: T('启动程序', 'Program'),
            width: '28%',
            render: (it) => {
              const iconEl = appIcon(it);
              const scopeTag = it.scope === 'user'
                ? h('span', { class: 'tag user', style: { color: 'var(--c-accent, #3b82f6)', background: 'rgba(59, 130, 246, 0.1)', borderColor: 'rgba(59, 130, 246, 0.25)' }, title: T('用户级自启（仅对当前登录用户生效）', 'User-level startup') }, T('👤 桌面应用', '👤 User App'))
                : h('span', { class: 'tag system', title: T('系统级自启（对所有系统用户生效，通常为系统组件、服务或驱动）', 'System-level startup') }, T('🛡️ 系统服务', '🛡️ System'));
              const sourceTag = it.source_type === 'folder'
                ? h('span', { class: 'tag store', title: T('开机启动文件夹', 'Startup folder') }, T('文件夹', 'Folder'))
                : h('span', { class: 'tag system', title: T('Windows 注册表', 'Windows registry') }, T('注册表', 'Registry'));
              return h('div', { class: 'name' },
                iconEl,
                h('span', { class: 'txt ellipsis', style: { minWidth: '0' }, title: it.name }, it.name || '—'),
                scopeTag,
                sourceTag
              );
            }
          },
          {
            key: 'location',
            label: T('位置 / 来源', 'Location'),
            width: '20%',
            render: (it) => h('div', { class: 'muted small ellipsis', title: it.location || '' }, it.location || '—')
          },
          {
            key: 'command',
            label: T('启动命令 / 执行路径', 'Command / Path'),
            render: (it) => h('div', { class: 'muted small mono ellipsis', title: it.command || '' }, it.command || '—')
          },
          {
            key: 'actions',
            label: T('操作', 'Actions'),
            width: '110px',
            align: 'right',
            render: (it) => {
              const acts = [];
              if (it.exists) {
                const bToggle = iconBtn(it.enabled ? '禁用' : '启用', it.enabled ? 'Disable' : 'Enable',
                  it.enabled ? 'close' : 'check', async () => {
                    bToggle.disabled = true;
                    try {
                      const r = await API.engine('startup.toggle', {
                        name: it.name,
                        source_type: it.source_type,
                        hive: it.hive,
                        file_path: it.file_path,
                        enabled: !it.enabled
                      });
                      if (r && r.ok) {
                        it.enabled = !it.enabled;
                        if (r.new_file_path) it.file_path = r.new_file_path;
                        it.status = it.enabled ? 'enabled' : 'disabled';
                        toast(T(`已${it.enabled ? '启用' : '禁用'}自启动项：${it.name}`, `${it.enabled ? 'Enabled' : 'Disabled'} ${it.name}`), 'ok');
                        applyStartupFilter();
                      }
                    } catch (e) {
                      const handled = await handleStartupAdminError(e, T('切换自启动状态', 'Toggle startup status'));
                      if (!handled) toast(errText(e), 'error');
                      bToggle.disabled = false;
                    }
                  });
                acts.push(bToggle);
              }
              if (it.exe_path && it.exists) {
                acts.push(iconBtn('打开所在位置', 'Open location', 'folder', () => {
                  API.reveal(it.exe_path).catch((e) => toast(errText(e), 'error'));
                }));
              }
              acts.push(iconBtn('删除自启动项', 'Delete entry', 'trash', async () => {
                const ok = await confirm({
                  title: T('确认删除自启动项？', 'Delete startup entry?'),
                  body: T(`确定要从系统启动配置中移除【${it.name}】吗？这仅删除启动配置，不会卸载软件文件。`,
                    `Remove "${it.name}" from autorun configuration? This only removes boot config, keeping program files.`),
                  danger: true
                });
                if (!ok) return;
                try {
                  await API.engine('startup.delete', {
                    name: it.name,
                    source_type: it.source_type,
                    hive: it.hive,
                    key: it.key,
                    file_path: it.file_path
                  });
                  toast(T('已删除自启动配置', 'Startup entry removed'), 'ok');
                  loadStartup(true);
                } catch (e) {
                  const handled = await handleStartupAdminError(e, T('删除自启动项', 'Delete startup entry'));
                  if (!handled) toast(errText(e), 'error');
                }
              }, true));
              return h('div', { class: 'row', style: { justifyContent: 'flex-end', gap: '4px' } }, ...acts);
            }
          }
        ],
        rows: StartupState.visible,
        rowKey: (row, i) => String(i)
      });
      tbl.style.tableLayout = 'fixed';

      attachMenu(tbl, (e) => {
        const tr = e.target.closest('tbody tr');
        if (!tr) return null;
        const it = StartupState.visible[Number(tr.dataset.key)];
        if (!it) return null;
        return [
          { header: it.name || '' },
          it.exists ? {
            label: T(it.enabled ? '禁用自启动' : '启用自启动', it.enabled ? 'Disable' : 'Enable'),
            icon: it.enabled ? 'close' : 'check',
            action: async () => {
              try {
                const r = await API.engine('startup.toggle', {
                  name: it.name,
                  source_type: it.source_type,
                  hive: it.hive,
                  file_path: it.file_path,
                  enabled: !it.enabled
                });
                if (r && r.ok) {
                  it.enabled = !it.enabled;
                  if (r.new_file_path) it.file_path = r.new_file_path;
                  it.status = it.enabled ? 'enabled' : 'disabled';
                  toast(T(`已${it.enabled ? '启用' : '禁用'}自启动项：${it.name}`, `${it.enabled ? 'Enabled' : 'Disabled'} ${it.name}`), 'ok');
                  applyStartupFilter();
                }
              } catch (err) {
                const handled = await handleStartupAdminError(err, T('切换自启动状态', 'Toggle startup status'));
                if (!handled) toast(errText(err), 'error');
              }
            }
          } : null,
          it.exe_path && it.exists ? {
            label: T('打开文件所在位置', 'Open file location'),
            icon: 'folder',
            action: () => API.reveal(it.exe_path).catch((err) => toast(errText(err), 'error'))
          } : null,
          it.command ? {
            label: T('复制启动命令', 'Copy command'),
            icon: 'copy',
            action: () => copyText(it.command)
          } : null,
          {
            label: T('复制名称', 'Copy name'),
            icon: 'copy',
            action: () => copyText(it.name)
          },
          { sep: true },
          {
            label: T('删除自启动项', 'Delete startup entry'),
            icon: 'trash',
            danger: true,
            action: async () => {
              const ok = await confirm({
                title: T('确认删除自启动项？', 'Delete startup entry?'),
                body: T(`确定要从系统启动配置中移除【${it.name}】吗？这仅删除启动配置，不会卸载软件文件。`,
                  `Remove "${it.name}" from autorun configuration? This only removes boot config, keeping program files.`),
                danger: true
              });
              if (!ok) return;
              try {
                await API.engine('startup.delete', {
                  name: it.name,
                  source_type: it.source_type,
                  hive: it.hive,
                  key: it.key,
                  file_path: it.file_path
                });
                toast(T('已删除自启动配置', 'Startup entry removed'), 'ok');
                loadStartup(true);
              } catch (err) {
                const handled = await handleStartupAdminError(err, T('删除自启动项', 'Delete startup entry'));
                if (!handled) toast(errText(err), 'error');
              }
            }
          }
        ].filter(Boolean);
      });

      startupTableBox.appendChild(tbl);
      hydrateIcons(StartupState.visible).catch(() => {});
    }

    async function cleanAllBroken() {
      const brokenList = StartupState.items.filter((it) => !it.exists);
      if (!brokenList.length) {
        toast(T('没有发现失效自启动项', 'No broken startup items found'), 'ok');
        return;
      }
      const ok = await confirm({
        title: T('一键清理失效自启动项', 'Clean Broken Startup Items'),
        body: T(`检测到 ${brokenList.length} 项自启动的主程序已被删除，确定一次性清理这些残留的注册表项和快捷方式吗？`,
          `Detected ${brokenList.length} startup items whose target files are missing. Clean all of them?`),
        danger: true
      });
      if (!ok) return;

      let cleaned = 0;
      let denied = 0;
      for (const it of brokenList) {
        try {
          await API.engine('startup.delete', {
            name: it.name,
            source_type: it.source_type,
            hive: it.hive,
            key: it.key,
            file_path: it.file_path
          });
          cleaned += 1;
        } catch (e) {
          const msg = (e && (e.message || e.error)) || String(e || '');
          if (msg.includes('管理员权限') || msg.includes('拒绝访问') || msg.includes('WinError 5') || (e && e.code === 'admin_required')) {
            denied += 1;
          }
        }
      }
      if (denied > 0) {
        const promptText = cleaned > 0
          ? T(`已成功清理 ${cleaned} 项失效项，其余 ${denied} 项位于系统级（HKLM）注册表，需要管理员权限。\n\n是否以管理员身份重启轻盘继续清理？`,
              `Cleaned ${cleaned} items. Remaining ${denied} items are in HKLM registry.\n\nRestart QDisk as admin to clean?`)
          : T(`清理失败：${denied} 项失效项属于系统级（HKLM）注册表，需要管理员权限。\n\n是否以管理员身份重启轻盘？`,
              `Failed: ${denied} items are in HKLM registry.\n\nRestart QDisk as admin?`);
        const goAdmin = await confirm({
          title: T('需要管理员权限', 'Admin Required'),
          body: promptText,
          okText: T('以管理员身份重启', 'Restart as admin')
        });
        if (goAdmin) doRestartAsAdmin();
      } else if (cleaned > 0) {
        toast(T(`已清理 ${fmtCount(cleaned)} 项失效启动残留`, `Cleaned ${fmtCount(cleaned)} broken items`), 'ok');
      }
      loadStartup(true);
    }

    /* ================================================================
       TAB 3: 后台进程动态管理 (Running Processes Management)
       ================================================================ */
    const ProcState = {
      items: GlobalAppsCache.procs ? GlobalAppsCache.procs.slice() : [],
      filtered: [],
      visible: [],
      view: GlobalAppsCache.procView || 'all', // 'all' | 'apps' | 'system'
      filter: GlobalAppsCache.procFilter || '',
      page: GlobalAppsCache.procPage || 1,
      loading: false,
      totalMemory: GlobalAppsCache.procTotalRam || 0,
      rawCount: GlobalAppsCache.procRawCount || 0,
      liveTimer: null,
      isLive: true
    };

    const procFilterInput = h('input', {
      class: 'input grow',
      type: 'search',
      spellcheck: 'false',
      value: ProcState.filter,
      placeholder: T('搜索进程名、路径或应用…', 'Search process name, path or app…')
    });
    procFilterInput.addEventListener('input', () => {
      ProcState.filter = procFilterInput.value.trim().toLowerCase();
      GlobalAppsCache.procFilter = ProcState.filter;
      ProcState.page = 1;
      GlobalAppsCache.procPage = 1;
      applyProcFilter();
    });

    const btnRefreshProc = btn('刷新快照', 'Refresh', 'ghost sm', 'refresh', () => loadProcs(true));

    const procViewBtns = {};
    function procViewBtn(kind, zh, en) {
      const b = h('button', {
        class: 'chip' + (ProcState.view === kind ? ' active' : ''),
        type: 'button',
        onclick: () => {
          if (ProcState.view === kind) return;
          ProcState.view = kind;
          Object.entries(procViewBtns).forEach(([k, el]) => el.classList.toggle('active', k === kind));
          ProcState.page = 1;
          applyProcFilter();
        }
      }, T(zh, en));
      procViewBtns[kind] = b;
      return b;
    }

    const procPageInput = h('input', {
      class: 'input sm pg-input',
      type: 'text',
      value: '1',
      title: T('输入页码回车跳转', 'Type page and Enter')
    });
    procPageInput.onkeydown = (e) => {
      if (e.key === 'Enter') {
        const p = parseInt(procPageInput.value, 10);
        if (!isNaN(p)) gotoProcPage(p);
      }
    };
    const procPageTotal = h('span', { class: 'pg-total' }, '1');
    const btnProcPrev = pagerBtn('prev', () => gotoProcPage(ProcState.page - 1));
    const btnProcNext = pagerBtn('next', () => gotoProcPage(ProcState.page + 1));
    const procPagerBar = h('div', { class: 'row pg-bar', style: { gap: '4px', alignItems: 'center' } },
      btnProcPrev, procPageInput, h('span', { style: { color: 'var(--text-3)', fontSize: '11px' } }, '/'), procPageTotal, btnProcNext
    );

    function gotoProcPage(p) {
      const total = ProcState.filtered.length;
      const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      ProcState.page = Math.min(Math.max(1, p), pages);
      applyProcFilter();
    }

    const statProcAll = h('span', { class: 'badge', title: T('当前快照所有进程', 'All processes') }, '共 0 个应用');
    const statProcApps = h('span', { class: 'badge ok', title: T('用户与第三方应用后台', 'User applications') }, '后台应用 0');
    const statProcSys = h('span', { class: 'badge neutral', title: T('Windows 系统保留关键组件', 'System protected') }, '系统保护 0');
    const statProcMem = h('span', { class: 'badge accent', title: T('当前进程总物理内存工作集', 'Total RAM') }, '内存 0 B');

    const procPagePicker = UI.pageSizePick(PAGE_SIZE, [15, 30, 60, 100, 200], (n) => {
      PAGE_SIZE = n;
      ProcState.page = 1;
      applyProcFilter();
    });

    const procToolbar1 = h('div', { class: 'toolbar row wrap', style: { gap: '8px', alignItems: 'center' } },
      procFilterInput,
      h('div', { class: 'seg' },
        procViewBtn('all', '全部', 'All'),
        procViewBtn('apps', '后台应用', 'Apps'),
        procViewBtn('system', '系统保护', 'System')
      ),
      h('span', { class: 'spacer' }),
      procPagerBar
    );

    const procToolbar2 = h('div', { class: 'row wrap', style: { gap: '8px', alignItems: 'center', marginTop: '6px' } },
      statProcAll, statProcApps, statProcSys, statProcMem,
      h('span', { class: 'spacer' }),
      procPagePicker
    );

    const liveProcBadge = h('span', {
      class: 'chip ok sm',
      style: { cursor: 'pointer', userSelect: 'none', fontSize: '11px', padding: '3px 8px' },
      title: T('点击暂停/恢复实时采样', 'Click to pause/resume live sampling')
    }, icon('activity', 12), h('span', { style: { marginLeft: '4px' } }, T('动态采样中 (2.5s)', 'Live (2.5s)')));

    function updateProcLiveBadge() {
      if (ProcState.isLive && ProcState.liveTimer) {
        liveProcBadge.className = 'chip ok sm';
        liveProcBadge.innerHTML = '';
        liveProcBadge.appendChild(icon('activity', 12));
        liveProcBadge.appendChild(h('span', { style: { marginLeft: '4px' } }, T('动态采样中 (2.5s)', 'Live (2.5s)')));
      } else {
        liveProcBadge.className = 'chip neutral sm';
        liveProcBadge.innerHTML = '';
        liveProcBadge.appendChild(icon('pause', 12));
        liveProcBadge.appendChild(h('span', { style: { marginLeft: '4px' } }, T('已暂停采样', 'Paused')));
      }
    }

    liveProcBadge.onclick = () => {
      ProcState.isLive = !ProcState.isLive;
      if (ProcState.isLive) {
        startProcLiveMonitoring();
      } else {
        stopProcLiveMonitoring();
      }
      updateProcLiveBadge();
    };

    const procVisualBox = h('div', { class: 'proc-visual', style: { marginBottom: '12px' } });
    const procTableBox = h('div', { class: 'table-wrap' });

    const procsCard = card(
      h('div', { class: 'card-title' },
        h('h2', null, T('后台进程管理', 'Running Processes')),
        h('span', { class: 'spacer' }),
        liveProcBadge,
        btnRefreshProc
      ),
      procVisualBox,
      procToolbar1,
      procToolbar2,
      procTableBox
    );
    procsCard.style.display = 'none';

    async function loadProcs(force, silent = false) {
      if (ProcState.loading) return;
      ProcState.loading = true;
      if (!silent && (force || !ProcState.items.length)) {
        procTableBox.innerHTML = '';
        const spinner = h('div', { class: 'center text-muted', style: { padding: '32px' } }, icon('refresh', 20), h('span', { style: { marginLeft: '8px' } }, T('正在生成进程快照…', 'Snapshotting processes…')));
        procTableBox.appendChild(spinner);
      }
      try {
        const res = await API.engine('process.list', { aggregate: true });
        if (!isMounted) return;
        ProcState.items = Array.isArray(res && res.items) ? res.items : [];
        ProcState.totalMemory = Number(res && res.total_memory) || 0;
        ProcState.rawCount = Number(res && res.raw_count) || ProcState.items.length;
        GlobalAppsCache.procs = ProcState.items;
        GlobalAppsCache.procRawCount = ProcState.rawCount;
        GlobalAppsCache.procTotalRam = ProcState.totalMemory;
        if (!silent) ProcState.page = 1;
        applyProcFilter();
        renderProcVisual();
      } catch (err) {
        if (!silent) {
          procTableBox.innerHTML = '';
          procTableBox.appendChild(empty(T('读取进程列表失败', 'Failed to read processes'), (err && err.message) || String(err)));
        }
      } finally {
        ProcState.loading = false;
      }
    }

    function startProcLiveMonitoring() {
      if (!isMounted || ProcState.liveTimer) return;
      ProcState.isLive = true;
      if (currentTab === 'procs') {
        loadProcs(false, !!ProcState.items.length);
      }
      ProcState.liveTimer = setInterval(() => {
        if (isMounted && ProcState.isLive && currentTab === 'procs' && !document.hidden) {
          loadProcs(false, true);
        }
      }, 2500);
      updateProcLiveBadge();
    }

    function stopProcLiveMonitoring() {
      if (ProcState.liveTimer) {
        clearInterval(ProcState.liveTimer);
        ProcState.liveTimer = null;
      }
      updateProcLiveBadge();
    }

    function applyProcFilter() {
      const q = String(ProcState.filter || '').trim().toLowerCase();
      let list = ProcState.items.slice();
      if (ProcState.view === 'apps') {
        list = list.filter((it) => !it.is_system);
      } else if (ProcState.view === 'system') {
        list = list.filter((it) => it.is_system);
      }
      if (q) {
        list = list.filter((it) => {
          return it.name.toLowerCase().includes(q)
            || (it.exe_path && it.exe_path.toLowerCase().includes(q))
            || it.clean_name.toLowerCase().includes(q);
        });
      }
      ProcState.filtered = list;
      const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
      ProcState.page = Math.min(Math.max(1, ProcState.page), pages);
      const start = (ProcState.page - 1) * PAGE_SIZE;
      ProcState.visible = list.slice(start, start + PAGE_SIZE);

      renderProcStats();
      renderProcTable();
    }

    function renderProcStats() {
      const total = ProcState.items.length;
      const apps = ProcState.items.filter((it) => !it.is_system).length;
      const sys = ProcState.items.filter((it) => it.is_system).length;
      statProcAll.textContent = `共 ${fmtCount(total)} 个应用 (${ProcState.rawCount} 进程)`;
      statProcApps.textContent = `后台应用 ${fmtCount(apps)}`;
      statProcSys.textContent = `系统保护 ${fmtCount(sys)}`;
      statProcMem.textContent = `总内存 ${fmtSize(ProcState.totalMemory)}`;
      updateTabBadges();

      const pages = Math.max(1, Math.ceil(ProcState.filtered.length / PAGE_SIZE));
      procPageInput.value = String(ProcState.page);
      procPageTotal.textContent = String(pages);
      btnProcPrev.disabled = ProcState.page <= 1;
      btnProcNext.disabled = ProcState.page >= pages;
    }

    function renderProcVisual() {
      procVisualBox.innerHTML = '';
      if (!ProcState.items.length) return;
      const topProcs = ProcState.items.slice(0, 5);
      const topSum = topProcs.reduce((sum, p) => sum + (p.memory || 0), 0);
      const otherMem = Math.max(0, ProcState.totalMemory - topSum);

      const slices = topProcs.map((p) => ({
        name: p.name,
        clean_name: p.clean_name || p.name,
        mem: p.memory || 0,
        pct: ProcState.totalMemory ? (p.memory || 0) / ProcState.totalMemory : 0
      }));
      if (otherMem > 0) {
        slices.push({
          name: T('其他进程', 'Other processes'),
          clean_name: '',
          mem: otherMem,
          pct: ProcState.totalMemory ? otherMem / ProcState.totalMemory : 0
        });
      }

      const palette = [
        'var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)',
        'var(--chart-4)', 'var(--chart-5)', 'var(--chart-6)'
      ];

      // 响应式双栏：左 50% 环形透视图，右 50% 内存大户 Top 5 动态条形图（等高伸展对齐）
      const visualGrid = h('div', {
        style: {
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
          gap: '12px',
          alignItems: 'stretch',
          marginBottom: '8px'
        }
      });

      // ---------------- 左栏：动态可交互甜甜圈环形图 ----------------
      const leftCol = h('div', {
        style: {
          padding: '12px 16px',
          background: 'var(--surface-2)',
          borderRadius: 'var(--radius)',
          border: '1px solid var(--line)',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          minHeight: '238px'
        }
      });

      const donutTitle = h('div', { class: 'row', style: { justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' } },
        h('strong', { style: { fontSize: '13px', color: 'var(--text-1)' } }, T('内存空间分布透视', 'Memory Distribution'))
      );

      const r = 50;
      const circ = 2 * Math.PI * r;
      let offset = 0;
      const slicePaths = slices.map((s, idx) => {
        const strokeLen = Math.max(0.01, s.pct * circ);
        const color = palette[idx % palette.length];
        const circleStr = `<circle class="proc-donut-slice" data-idx="${idx}" cx="65" cy="65" r="${r}" fill="none" stroke="${color}" stroke-width="16" stroke-dasharray="${strokeLen} ${circ - strokeLen}" stroke-dashoffset="${-offset}" style="cursor:pointer; transition: stroke-width 0.2s ease, opacity 0.2s ease;" />`;
        offset += strokeLen;
        return circleStr;
      }).join('');

      const donutSvgBox = h('div', { style: { position: 'relative', width: '120px', height: '120px', flexShrink: 0 } });
      donutSvgBox.innerHTML = `
        <svg viewBox="0 0 130 130" width="120" height="120" style="transform: rotate(-90deg); display: block; overflow: visible;">
          <circle cx="65" cy="65" r="${r}" fill="none" stroke="var(--line)" stroke-width="16" opacity="0.3" />
          ${slicePaths}
        </svg>
      `;

      // 甜甜圈中心孔：高对比动态数据显示（默认总内存，悬停时为该扇区详情）
      const centerBox = h('div', {
        style: {
          position: 'absolute',
          top: '0', left: '0', width: '100%', height: '100%',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          pointerEvents: 'none', textAlign: 'center', padding: '6px'
        }
      },
        h('span', { id: 'proc-donut-center-val', style: { fontSize: '14px', fontWeight: '700', fontFamily: 'var(--mono)', color: 'var(--text-1)' } }, fmtSize(ProcState.totalMemory)),
        h('span', { id: 'proc-donut-center-lbl', class: 'ellipsis', style: { fontSize: '11px', color: 'var(--text-3)', maxWidth: '80px' } }, T('后台总计', 'Total RAM'))
      );
      donutSvgBox.appendChild(centerBox);

      // 绑定悬停与点击交互
      const svgCircles = donutSvgBox.querySelectorAll('.proc-donut-slice');
      const centerVal = centerBox.querySelector('#proc-donut-center-val');
      const centerLbl = centerBox.querySelector('#proc-donut-center-lbl');

      svgCircles.forEach((c) => {
        const idx = Number(c.dataset.idx);
        const s = slices[idx];
        c.addEventListener('mouseenter', () => {
          c.setAttribute('stroke-width', '20');
          c.style.filter = 'brightness(1.15)';
          if (centerVal) centerVal.textContent = fmtSize(s.mem);
          if (centerLbl) {
            centerLbl.textContent = s.name;
            centerLbl.title = `${s.name} (${(s.pct * 100).toFixed(1)}%)`;
          }
        });
        c.addEventListener('mouseleave', () => {
          c.setAttribute('stroke-width', '16');
          c.style.filter = 'none';
          if (centerVal) centerVal.textContent = fmtSize(ProcState.totalMemory);
          if (centerLbl) {
            centerLbl.textContent = T('后台总计', 'Total RAM');
            centerLbl.title = '';
          }
        });
        c.addEventListener('click', () => {
          if (s.clean_name) {
            ProcState.filter = s.clean_name;
            procFilterInput.value = s.clean_name;
            applyProcFilter();
          }
        });
      });

      // 图例 Legend（多列自适应排布，点击直接触发过滤）
      const legendGrid = h('div', {
        style: {
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
          gap: '6px 10px',
          flex: '1',
          fontSize: '11px'
        }
      });
      slices.forEach((s, idx) => {
        const color = palette[idx % palette.length];
        const legItem = h('div', {
          class: 'row',
          style: {
            alignItems: 'center',
            gap: '5px',
            cursor: s.clean_name ? 'pointer' : 'default',
            padding: '2px 4px',
            borderRadius: 'var(--radius-sm)',
            minWidth: '0'
          },
          title: s.clean_name ? T(`点击过滤【${s.name}】`, `Click to filter [${s.name}]`) : ''
        },
          h('span', { style: { width: '8px', height: '8px', borderRadius: '50%', background: color, flexShrink: '0' } }),
          h('span', { class: 'ellipsis', style: { flex: '1', minWidth: '0', color: 'var(--text-1)' } }, s.name),
          h('span', { style: { color: 'var(--text-3)', fontFamily: 'var(--mono)', flexShrink: '0' } }, fmtSize(s.mem))
        );
        if (s.clean_name) {
          legItem.addEventListener('click', () => {
            ProcState.filter = s.clean_name;
            procFilterInput.value = s.clean_name;
            applyProcFilter();
          });
        }
        legendGrid.appendChild(legItem);
      });

      const donutContentRow = h('div', {
        class: 'row',
        style: {
          alignItems: 'center',
          gap: '16px',
          flex: '1',
          minHeight: '130px'
        }
      }, donutSvgBox, legendGrid);

      const donutFoot = h('div', {
        class: 'row',
        style: {
          justifyContent: 'space-between',
          alignItems: 'center',
          paddingTop: '8px',
          marginTop: '6px',
          borderTop: '1px solid var(--line)',
          fontSize: '11px',
          color: 'var(--text-3)'
        }
      },
        h('span', null, T(`共 ${ProcState.items.length} 个应用 (${ProcState.rawCount} 进程)`, `Total ${ProcState.items.length} apps (${ProcState.rawCount} procs)`)),
        h('span', { style: { color: 'var(--text-2)', fontFamily: 'var(--mono)', fontWeight: '600' } }, T('后台总计: ' + fmtSize(ProcState.totalMemory), 'Total: ' + fmtSize(ProcState.totalMemory)))
      );

      leftCol.appendChild(donutTitle);
      leftCol.appendChild(donutContentRow);
      leftCol.appendChild(donutFoot);

      // ---------------- 右栏：Top 5 内存大户条形图 (Bar Chart) ----------------
      const rightCol = h('div', {
        style: {
          padding: '12px 16px',
          background: 'var(--surface-2)',
          borderRadius: 'var(--radius)',
          border: '1px solid var(--line)',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          minHeight: '238px'
        }
      });

      const barTitle = h('div', { class: 'row', style: { justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' } },
        h('strong', { style: { fontSize: '13px', color: 'var(--text-1)' } }, T('内存大户排行榜 Top 5', 'Top 5 Memory Consumers'))
      );
      rightCol.appendChild(barTitle);

      const barListWrap = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '5px', flex: '1', justifyContent: 'center' } });
      const top1Mem = (topProcs[0] && topProcs[0].memory) || 1;
      topProcs.forEach((p, idx) => {
        const mem = p.memory || 0;
        const pctRel = Math.min(100, Math.max(8, Math.round((mem / top1Mem) * 100)));
        const pctTotal = ProcState.totalMemory ? ((mem / ProcState.totalMemory) * 100).toFixed(1) : '0';
        const color = palette[idx % palette.length];

        const pRow = h('div', {
          class: 'row',
          style: {
            alignItems: 'center',
            gap: '8px',
            padding: '3px 6px',
            borderRadius: 'var(--radius-sm)',
            cursor: 'pointer',
            transition: 'background 0.15s ease'
          },
          title: T(`点击定位筛选 ${p.name}`, `Click to filter ${p.name}`)
        },
          h('span', {
            style: {
              fontFamily: 'var(--mono)',
              fontSize: '11px',
              fontWeight: '700',
              minWidth: '20px',
              textAlign: 'center',
              color: idx === 0 ? '#ef4444' : (idx === 1 ? '#f59e0b' : (idx === 2 ? '#3b82f6' : 'var(--text-3)'))
            }
          }, '#' + (idx + 1)),
          appIcon(p),
          h('span', { class: 'ellipsis', style: { width: '100px', fontSize: '12px', fontWeight: '500', color: 'var(--text-1)' }, title: p.name }, p.name),
          h('div', {
            class: 'grow',
            style: {
              height: '8px',
              background: 'var(--line)',
              borderRadius: '4px',
              overflow: 'hidden'
            }
          },
            h('div', {
              style: {
                width: `${pctRel}%`,
                height: '100%',
                borderRadius: '4px',
                background: `linear-gradient(90deg, ${color}, var(--accent, #3b82f6))`,
                transition: 'width 0.4s ease'
              }
            })
          ),
          h('span', {
            style: {
              fontFamily: 'var(--mono)',
              fontSize: '11px',
              minWidth: '95px',
              textAlign: 'right',
              color: 'var(--text-2)'
            }
          }, `${fmtSize(mem)} (${pctTotal}%)`)
        );

        pRow.addEventListener('mouseenter', () => { pRow.style.background = 'var(--surface-hover, rgba(255,255,255,0.06))'; });
        pRow.addEventListener('mouseleave', () => { pRow.style.background = 'transparent'; });
        pRow.addEventListener('click', () => {
          ProcState.filter = p.clean_name;
          procFilterInput.value = p.clean_name;
          applyProcFilter();
        });

        barListWrap.appendChild(pRow);
      });
      rightCol.appendChild(barListWrap);

      const barFoot = h('div', {
        class: 'row',
        style: {
          justifyContent: 'space-between',
          alignItems: 'center',
          paddingTop: '8px',
          marginTop: '6px',
          borderTop: '1px solid var(--line)',
          fontSize: '11px',
          color: 'var(--text-3)'
        }
      },
        h('span', null, T(`Top 5 合计: ${fmtSize(topSum)}`, `Top 5 sum: ${fmtSize(topSum)}`)),
        h('span', null, T(`占后台总计 ${ProcState.totalMemory ? Math.round((topSum / ProcState.totalMemory) * 100) : 0}%`, `${ProcState.totalMemory ? Math.round((topSum / ProcState.totalMemory) * 100) : 0}% of total`))
      );
      rightCol.appendChild(barFoot);

      visualGrid.appendChild(leftCol);
      visualGrid.appendChild(rightCol);
      procVisualBox.appendChild(visualGrid);
    }

    async function closeProcOne(it, force) {
      if (!it) return;
      if (it.is_system) {
        toast(T('系统核心组件受保护，禁止关闭', 'System component is protected'), 'warn');
        return;
      }
      const r = await busy(
        () => API.engine('process.close', {
          name: it.clean_name,
          force: !!force,
          confirm_sensitive: false
        }),
        T(`正在关闭进程【${it.name}】…`, `Closing process [${it.name}]…`),
        'apps'
      );
      if (!r) return;
      if (r.need_confirm) {
        const ok = await UI.confirm({
          title: T('敏感数据应用提示', 'Sensitive App Warning'),
          body: r.warning + '\n\n' + T('确定要强制关闭该进程吗？', 'Are you sure you want to close it?'),
          ok: T('强制关闭', 'Force close'),
          danger: true
        });
        if (!ok) return;
        const r2 = await busy(
          () => API.engine('process.close', {
            name: it.clean_name,
            force: true,
            confirm_sensitive: true
          }),
          T(`正在强制关闭【${it.name}】…`, `Force closing [${it.name}]…`),
          'apps'
        );
        if (!r2) return;
      }
      toast(T(`已关闭进程【${it.name}】`, `Closed process [${it.name}]`), 'ok');
      loadProcs(true);
    }

    function renderProcTable() {
      procTableBox.innerHTML = '';
      if (!ProcState.filtered.length) {
        procTableBox.appendChild(empty(T('未找到匹配的后台进程', 'No matching processes found'), T('可调整搜索关键字或切换分类筛选', 'Try clearing filter or switching categories')));
        return;
      }

      const columns = [
        {
          key: 'name',
          label: T('应用与进程', 'App & Process'),
          render: (it) => {
            const iconEl = appIcon(it);
            const countTag = it.process_count > 1
              ? h('span', { class: 'badge', style: { marginLeft: '6px', flexShrink: '0' } }, `${it.process_count} 进程`)
              : (it.pids && it.pids.length ? h('span', { class: 'badge neutral', style: { marginLeft: '6px', flexShrink: '0' } }, `PID ${it.pids[0]}`) : null);

            return h('div', { class: 'name', style: { minWidth: '0' } },
              iconEl,
              h('div', { class: 'txt', style: { minWidth: '0', overflow: 'hidden' } },
                h('div', { class: 'ellipsis', title: it.name, style: { fontWeight: '600', fontSize: '13px', color: 'var(--text-1)' } }, it.name),
                it.exe_path ? h('div', { class: 'hint ellipsis mono', style: { fontSize: '11px', color: 'var(--text-3)' }, title: it.exe_path }, it.exe_path) : null
              ),
              countTag
            );
          }
        },
        {
          key: 'memory',
          label: T('占用内存', 'Memory'),
          width: '110px',
          align: 'right',
          className: 'col-memory',
          render: (it) => {
            const memText = fmtSize(it.memory);
            const maxMem = 1024 * 1024 * 1024; // 1GB scale
            const pct = Math.min(100, Math.max(4, Math.round((it.memory / maxMem) * 100)));
            const isHigh = it.memory > 400 * 1024 * 1024;
            const isCrit = it.memory > 1024 * 1024 * 1024;
            const barCol = isCrit ? '#ef4444' : (isHigh ? '#f59e0b' : 'var(--chart-1, #3b82f6)');
            return h('div', { style: { minWidth: '75px', textAlign: 'right' } },
              h('div', { style: { fontWeight: '600', fontFamily: 'var(--mono)', fontSize: '12px', color: isHigh ? barCol : 'var(--text-1)' } }, memText),
              h('div', { style: { height: '4px', background: 'var(--line)', borderRadius: '2px', overflow: 'hidden', marginTop: '3px' } },
                h('div', { style: { width: `${pct}%`, height: '100%', background: barCol, borderRadius: '2px', transition: 'width 0.3s ease' } })
              )
            );
          }
        },
        {
          key: 'threads',
          label: T('线程', 'Threads'),
          width: '55px',
          align: 'right',
          className: 'col-threads hide-sm',
          render: (it) => h('span', { class: 'num mono small', style: { color: 'var(--text-3)' } }, String(it.threads || 1))
        },
        {
          key: 'type',
          label: T('属性', 'Type'),
          width: '80px',
          className: 'col-type',
          render: (it) => {
            if (it.is_system) {
              return h('span', { class: 'tag system', style: { whiteSpace: 'nowrap' }, title: T('Windows 系统核心与关键保护组件，严禁终止', 'Protected system component') }, T('🛡️ 系统', '🛡️ System'));
            }
            return h('span', { class: 'tag user', style: { color: 'var(--c-accent, #3b82f6)', background: 'rgba(59, 130, 246, 0.1)', borderColor: 'rgba(59, 130, 246, 0.25)', whiteSpace: 'nowrap' }, title: T('用户态运行的第三方应用程序', 'User app') }, T('👤 应用', '👤 App'));
          }
        },
        {
          key: 'actions',
          label: T('操作', 'Actions'),
          width: '105px',
          align: 'right',
          className: 'col-actions',
          render: (it) => {
            const bClose = btn(T('结束', 'Kill'), T('结束任务', 'Close task'), 'ghost danger sm', 'power', () => closeProcOne(it, false));
            if (it.is_system) {
              bClose.disabled = true;
              bClose.title = T('系统核心保护组件受系统级保护，禁止关闭', 'Protected system component');
            }
            const bFolder = iconBtn('打开所在目录', 'Open file location', 'folder', () => {
              if (it.exe_path) openPath(it.exe_path);
            });
            if (!it.exe_path) bFolder.disabled = true;

            return h('div', { class: 'row', style: { justifyContent: 'flex-end', gap: '4px', flexWrap: 'nowrap' } }, bClose, bFolder);
          }
        }
      ];

      const tbl = UI.table({
        className: 'proc-table',
        columns,
        rows: ProcState.visible,
        rowKey: (row, i) => String(i)
      });
      procTableBox.appendChild(tbl);
      hydrateIcons(ProcState.visible).catch(() => {});
    }

    /* 后台进程右键菜单 */
    attachMenu(procTableBox, (e) => {
      const tr = e.target.closest('tbody tr[data-key]');
      if (tr) {
        const it = ProcState.visible[Number(tr.dataset.key)];
        if (!it) return [];
        return [
          { header: it.name },
          { label: T('结束任务 (优雅关闭)', 'Close task'), icon: 'power',
            danger: true, disabled: it.is_system, action: () => closeProcOne(it, false) },
          { label: T('强制结束进程', 'Force kill'), icon: 'trash',
            danger: true, disabled: it.is_system, action: () => closeProcOne(it, true) },
          { sep: true },
          { label: T('打开文件所在位置', 'Open file location'), icon: 'folder',
            disabled: !it.exe_path, action: () => openPath(it.exe_path) },
          { label: T('复制完整路径', 'Copy full path'), icon: 'copy',
            disabled: !it.exe_path, action: () => copyText(it.exe_path) },
          { label: T('复制进程名称', 'Copy name'), icon: 'copy', action: () => copyText(it.name) },
          { sep: true },
          { label: T('在「已安装程序」中查找', 'Find in installed apps'), icon: 'apps', action: () => {
            switchTab('apps');
            const kw = it.clean_name;
            searchInput.value = kw;
            S.filter = kw.trim().toLowerCase();
            applyFilter();
          }},
          { label: T('在「开机自启」中查找', 'Find in startup items'), icon: 'spark', action: () => {
            switchTab('startup');
            const kw = it.clean_name;
            startupFilterInput.value = kw;
            StartupState.filter = kw.trim().toLowerCase();
            applyStartupFilter();
          }}
        ];
      }
      return [];
    });

    /* ================================================================
       TAB 4: 空间透视与系统画像 (Storage & System Performance Footprint)
       ================================================================ */
    const PerfState = {
      perfData: GlobalAppsCache.perfData || null,
      samples: GlobalAppsCache.perfSamples && GlobalAppsCache.perfSamples.length
        ? GlobalAppsCache.perfSamples.slice()
        : [],
      liveTimer: null,
      isLive: true,
      lastFetch: 0
    };

    const livePerfBadge = h('span', {
      class: 'chip ok sm',
      style: { cursor: 'pointer', userSelect: 'none', fontSize: '11px', padding: '3px 8px' },
      title: T('点击暂停/恢复实时采样', 'Click to pause/resume live sampling')
    }, icon('activity', 12), h('span', { style: { marginLeft: '4px' } }, T('动态采样中 (1.5s)', 'Live (1.5s)')));

    livePerfBadge.onclick = () => {
      PerfState.isLive = !PerfState.isLive;
      if (PerfState.isLive) {
        startLiveMonitoring();
      } else {
        stopLiveMonitoring();
      }
      updateLiveBadge();
    };

    function updateLiveBadge() {
      if (PerfState.isLive && PerfState.liveTimer) {
        livePerfBadge.className = 'chip ok sm';
        livePerfBadge.innerHTML = '';
        livePerfBadge.appendChild(icon('activity', 12));
        livePerfBadge.appendChild(h('span', { style: { marginLeft: '4px' } }, T('动态采样中 (1.5s)', 'Live (1.5s)')));
      } else {
        livePerfBadge.className = 'chip neutral sm';
        livePerfBadge.innerHTML = '';
        livePerfBadge.appendChild(icon('pause', 12));
        livePerfBadge.appendChild(h('span', { style: { marginLeft: '4px' } }, T('已暂停采样', 'Paused')));
      }
    }

    const btnPerfRefresh = btn('刷新快照', 'Refresh Snapshot', 'ghost sm', 'refresh', () => {
      fetchPerfSample(true);
      if (!S.items.length) loadApps(false);
      if (!ProcState.items.length) loadProcs(false);
    });

    const footprintCard = card(
      h('div', { class: 'card-title' },
        h('h2', null, T('空间透视与系统画像', 'Storage & System Footprint')),
        h('span', { class: 'spacer' }),
        livePerfBadge,
        btnPerfRefresh
      ),
      h('div', { class: 'footprint-body', style: { display: 'flex', flexDirection: 'column', gap: '16px' } })
    );
    footprintCard.style.display = 'none';

    async function fetchPerfSample(force) {
      if (!isMounted || (!PerfState.isLive && !force) || currentTab !== 'footprint') return;
      try {
        const isFirst = !PerfState.perfData;
        const data = await API.engine('system.performance', {});
        if (!isMounted || !data) return;
        PerfState.perfData = data;
        const now = new Date();
        const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
        const memPct = Number(data.memory && data.memory.percent) || 0;
        const cpuPct = Number(data.cpu && data.cpu.percent) || 0;
        const diskR_MB = Number(((data.disk_io && data.disk_io.read_bps) || 0) / (1024 * 1024)).toFixed(2);
        const diskW_MB = Number(((data.disk_io && data.disk_io.write_bps) || 0) / (1024 * 1024)).toFixed(2);
        const netIn_KB = Number(((data.network_io && data.network_io.in_bps) || 0) / 1024).toFixed(1);
        const netOut_KB = Number(((data.network_io && data.network_io.out_bps) || 0) / 1024).toFixed(1);

        PerfState.samples.push({
          time: timeStr,
          memPct,
          cpuPct,
          diskR: parseFloat(diskR_MB),
          diskW: parseFloat(diskW_MB),
          netIn: parseFloat(netIn_KB),
          netOut: parseFloat(netOut_KB),
          timestamp: Date.now()
        });
        if (PerfState.samples.length > 30) {
          PerfState.samples.shift();
        }
        GlobalAppsCache.perfSamples = PerfState.samples.slice();
        GlobalAppsCache.perfData = PerfState.perfData;
        if ((isFirst || force) && currentTab === 'footprint') {
          renderFootprint();
        } else {
          updateFootprintLiveView();
        }
      } catch (err) {
        // 静默单次采样失败
      }
    }

    function startLiveMonitoring() {
      if (!isMounted || PerfState.liveTimer) return;
      PerfState.isLive = true;
      fetchPerfSample(true);
      PerfState.liveTimer = setInterval(() => fetchPerfSample(false), 1500);
      updateLiveBadge();
    }

    function stopLiveMonitoring() {
      if (PerfState.liveTimer) {
        clearInterval(PerfState.liveTimer);
        PerfState.liveTimer = null;
      }
      updateLiveBadge();
    }

    function onVisChange() {
      if (!isMounted) return;
      if (document.hidden) {
        stopLiveMonitoring();
        stopProcLiveMonitoring();
      } else {
        if (currentTab === 'footprint' && PerfState.isLive) startLiveMonitoring();
        if (currentTab === 'procs' && ProcState.isLive) startProcLiveMonitoring();
      }
    }
    document.addEventListener('visibilitychange', onVisChange);

    // 渲染通用单张交互式 SVG 速率/负载折线图
    function buildInteractiveRateSvg(samples, keyA, keyB, colorA, colorB, maxValFixed, gradId) {
      const W = 360;
      const H = 76;
      const padTop = 8;
      const padBottom = 14;
      const plotH = H - padTop - padBottom;
      const count = samples.length;

      if (count === 0) {
        return `
          <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" style="display: block;">
            <line x1="0" y1="${padTop + plotH}" x2="${W}" y2="${padTop + plotH}" stroke="var(--line)" stroke-width="1" />
            <text x="${W / 2}" y="${H / 2}" fill="var(--text-3)" font-size="11" text-anchor="middle">正在采集动态样本…</text>
          </svg>
        `;
      }

      let maxVal = maxValFixed || 1.0;
      if (!maxValFixed) {
        samples.forEach((s) => {
          if (s[keyA] > maxVal) maxVal = s[keyA];
          if (s[keyB] > maxVal) maxVal = s[keyB];
        });
        maxVal = Math.max(1.0, maxVal * 1.25);
      }

      const getX = (i) => {
        if (count <= 1) return W / 2;
        return (i / (count - 1)) * (W - 20) + 10;
      };
      const getY = (val) => padTop + (1.0 - Math.min(maxVal, Math.max(0, val || 0)) / maxVal) * plotH;

      const ptsA = samples.map((s, i) => `${getX(i).toFixed(1)},${getY(s[keyA]).toFixed(1)}`);
      const ptsB = samples.map((s, i) => `${getX(i).toFixed(1)},${getY(s[keyB]).toFixed(1)}`);

      const firstX = getX(0).toFixed(1);
      const lastX = getX(count - 1).toFixed(1);
      const baseH = (padTop + plotH).toFixed(1);

      const lineA = `M ${ptsA.join(' L ')}`;
      const areaA = `M ${firstX},${baseH} L ${ptsA.join(' L ')} L ${lastX},${baseH} Z`;
      const lineB = `M ${ptsB.join(' L ')}`;

      const latest = samples[count - 1];
      const curX = getX(count - 1).toFixed(1);
      const curYA = getY(latest[keyA]).toFixed(1);
      const curYB = getY(latest[keyB]).toFixed(1);

      return `
        <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" style="display: block; overflow: visible;">
          <defs>
            <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="${colorA}" stop-opacity="0.22" />
              <stop offset="100%" stop-color="${colorA}" stop-opacity="0.0" />
            </linearGradient>
          </defs>
          <line x1="0" y1="${padTop}" x2="${W}" y2="${padTop}" stroke="var(--line)" stroke-dasharray="3 3" opacity="0.4" />
          <line x1="0" y1="${padTop + plotH * 0.5}" x2="${W}" y2="${padTop + plotH * 0.5}" stroke="var(--line)" stroke-dasharray="3 3" opacity="0.4" />
          <line x1="0" y1="${baseH}" x2="${W}" y2="${baseH}" stroke="var(--line)" opacity="0.8" />

          <path d="${areaA}" fill="url(#${gradId})" />
          <path d="${lineA}" fill="none" stroke="${colorA}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          <path d="${lineB}" fill="none" stroke="${colorB}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" opacity="0.95" />

          <circle cx="${curX}" cy="${curYA}" r="3" fill="${colorA}" stroke="var(--surface)" stroke-width="1.5" />
          <circle cx="${curX}" cy="${curYB}" r="3" fill="${colorB}" stroke="var(--surface)" stroke-width="1.5" />

          <!-- 交互悬停辅助标线、数据光点及浮动数据胶囊 -->
          <g class="chart-crosshair" style="display:none; pointer-events:none;">
            <line class="crosshair-line" x1="0" y1="${padTop}" x2="0" y2="${baseH}" stroke="var(--text-2)" stroke-dasharray="2 2" stroke-width="1" opacity="0.8" />
            <circle class="crosshair-dot-a" cx="0" cy="0" r="4" fill="${colorA}" stroke="#fff" stroke-width="1.5" />
            <circle class="crosshair-dot-b" cx="0" cy="0" r="4" fill="${colorB}" stroke="#fff" stroke-width="1.5" />
            <g class="crosshair-tip" transform="translate(0, 0)">
              <rect class="crosshair-tip-bg" x="-62" y="2" width="124" height="18" rx="4" ry="4" fill="#0f172a" fill-opacity="0.92" stroke="rgba(255,255,255,0.2)" stroke-width="0.8" />
              <text class="crosshair-tip-text" x="0" y="14" text-anchor="middle" font-size="9" font-family="var(--mono)" fill="#f8fafc" font-weight="600"></text>
            </g>
          </g>
        </svg>
      `;
    }

    // 绑定交互：鼠标滑过时动态展示光标、高亮样本点与悬浮数值（零布局位移 CLS 防护）
    function attachChartCrosshair(cardEl, samples, keyA, keyB, unit, defaultFmt, compactFmt) {
      const svg = cardEl.querySelector('svg');
      const crosshair = cardEl.querySelector('.chart-crosshair');
      const valEl = cardEl.querySelector('.chart-cur-val');
      if (!svg || !crosshair || !samples || !samples.length) return;

      const line = crosshair.querySelector('.crosshair-line');
      const dotA = crosshair.querySelector('.crosshair-dot-a');
      const dotB = crosshair.querySelector('.crosshair-dot-b');
      const tipGroup = crosshair.querySelector('.crosshair-tip');
      const tipBg = crosshair.querySelector('.crosshair-tip-bg');
      const tipText = crosshair.querySelector('.crosshair-tip-text');

      const W = 360;
      const H = 76;
      const padTop = 8;
      const padBottom = 14;
      const plotH = H - padTop - padBottom;
      const count = samples.length;

      let maxVal = unit === '%' ? 100 : 1.0;
      if (unit !== '%') {
        samples.forEach((s) => {
          if (s[keyA] > maxVal) maxVal = s[keyA];
          if (s[keyB] > maxVal) maxVal = s[keyB];
        });
        maxVal = Math.max(1.0, maxVal * 1.25);
      }

      const getX = (i) => (count <= 1 ? W / 2 : (i / (count - 1)) * (W - 20) + 10);
      const getY = (val) => padTop + (1.0 - Math.min(maxVal, Math.max(0, val || 0)) / maxVal) * plotH;

      svg.onmousemove = (e) => {
        const rect = svg.getBoundingClientRect();
        const mouseX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
        const ratio = rect.width > 0 ? mouseX / rect.width : 0;
        const idx = Math.min(count - 1, Math.max(0, Math.round(ratio * (count - 1))));
        const s = samples[idx];
        if (!s) return;

        const cx = getX(idx);
        const cyA = getY(s[keyA]);
        const cyB = getY(s[keyB]);

        crosshair.style.display = '';
        line.setAttribute('x1', cx);
        line.setAttribute('x2', cx);
        dotA.setAttribute('cx', cx);
        dotA.setAttribute('cy', cyA);
        dotB.setAttribute('cx', cx);
        dotB.setAttribute('cy', cyB);

        // 浮动数据胶囊：自适应文本宽度 + 动态计算边界防裁切
        if (tipGroup && tipText && tipBg) {
          const str = `${s.time || ''} · ${compactFmt ? compactFmt(s) : defaultFmt(s)}`;
          tipText.textContent = str;
          const textW = tipText.getComputedTextLength ? tipText.getComputedTextLength() : (str.length * 6.2);
          const boxW = Math.max(120, Math.round(textW + 18));
          tipBg.setAttribute('width', boxW);
          tipBg.setAttribute('x', -Math.round(boxW / 2));
          const halfW = boxW / 2 + 6;
          const clampedX = Math.max(halfW, Math.min(W - halfW, cx));
          tipGroup.setAttribute('transform', `translate(${clampedX}, ${padTop})`);
        }

        // 顶部文本保持精简，避免折行破坏卡片高度
        if (valEl) {
          valEl.textContent = defaultFmt(s);
        }
      };

      svg.onmouseleave = () => {
        crosshair.style.display = 'none';
        if (valEl && samples.length) {
          const latest = samples[samples.length - 1];
          valEl.textContent = defaultFmt(latest);
        }
      };
    }

    function updateFootprintLiveView() {
      const container = footprintCard.querySelector('.footprint-body');
      if (!container || !PerfState.perfData) return;

      const p = PerfState.perfData;
      const mem = p.memory || {};
      const cpu = p.cpu || {};
      const disk = p.disk_summary || {};
      const drives = p.drives || [];
      const samples = PerfState.samples;
      const latest = samples.length ? samples[samples.length - 1] : { memPct: 0, cpuPct: 0, diskR: 0, diskW: 0, netIn: 0, netOut: 0 };

      // 更新顶部 4 KPI 卡片
      const elMemVal = container.querySelector('#fp-kpi-mem-val');
      const elMemBar = container.querySelector('#fp-kpi-mem-bar');
      const elMemSub = container.querySelector('#fp-kpi-mem-sub');
      const elMemFoot = container.querySelector('#fp-kpi-mem-foot');

      if (elMemVal) elMemVal.textContent = (mem.percent || 0) + '%';
      if (elMemBar) elMemBar.style.width = Math.min(100, Math.max(0, mem.percent || 0)) + '%';
      if (elMemSub) elMemSub.textContent = fmtSize(mem.used || 0) + ' / ' + fmtSize(mem.total || 0);
      if (elMemFoot) elMemFoot.textContent = T('可用 ', 'Avail ') + fmtSize(mem.available || 0);

      const elCpuVal = container.querySelector('#fp-kpi-cpu-val');
      const elCpuBar = container.querySelector('#fp-kpi-cpu-bar');
      const elCpuFoot = container.querySelector('#fp-kpi-cpu-foot');

      if (elCpuVal) elCpuVal.textContent = (cpu.percent || 0).toFixed(1) + '%';
      if (elCpuBar) elCpuBar.style.width = Math.min(100, Math.max(0, cpu.percent || 0)) + '%';
      if (elCpuFoot) elCpuFoot.textContent = (cpu.percent > 70 ? T('负载偏高', 'High load') : T('负载平稳', 'Stable load'));

      const elDiskVal = container.querySelector('#fp-kpi-disk-val');
      const elDiskBar = container.querySelector('#fp-kpi-disk-bar');
      const elDiskSub = container.querySelector('#fp-kpi-disk-sub');
      const elDiskFoot = container.querySelector('#fp-kpi-disk-foot');

      if (elDiskVal) elDiskVal.textContent = fmtSize(disk.total || 0);
      if (elDiskBar) elDiskBar.style.width = Math.min(100, Math.max(0, disk.percent || 0)) + '%';
      if (elDiskSub) elDiskSub.textContent = T(`已用 ${fmtSize(disk.used || 0)} (${disk.percent || 0}%)`, `Used ${fmtSize(disk.used || 0)} (${disk.percent || 0}%)`);
      if (elDiskFoot) elDiskFoot.textContent = T(`可用 ${fmtSize(disk.free || 0)}`, `Free ${fmtSize(disk.free || 0)}`);

      // 实时更新 3 张动态图表
      const cardCpuRam = container.querySelector('#fp-chart-card-cpu-ram');
      const cardDisk = container.querySelector('#fp-chart-card-disk');
      const cardNet = container.querySelector('#fp-chart-card-net');

      if (cardCpuRam) {
        const svgBox = cardCpuRam.querySelector('.chart-svg-box');
        if (svgBox) svgBox.innerHTML = buildInteractiveRateSvg(samples, 'memPct', 'cpuPct', 'var(--chart-1)', 'var(--chart-2)', 100, 'gradCpuRam');
        attachChartCrosshair(cardCpuRam, samples, 'memPct', 'cpuPct', '%',
          (s) => `内存 ${s.memPct || 0}% · CPU ${s.cpuPct || 0}%`,
          (s) => `RAM ${s.memPct || 0}% / CPU ${s.cpuPct || 0}%`
        );
      }

      if (cardDisk) {
        const svgBox = cardDisk.querySelector('.chart-svg-box');
        if (svgBox) svgBox.innerHTML = buildInteractiveRateSvg(samples, 'diskR', 'diskW', '#38bdf8', '#f43f5e', 0, 'gradDiskIO');
        attachChartCrosshair(cardDisk, samples, 'diskR', 'diskW', 'MB/s',
          (s) => `读 ${(s.diskR || 0).toFixed(1)}M · 写 ${(s.diskW || 0).toFixed(1)}M`,
          (s) => `读 ${(s.diskR || 0).toFixed(1)}M / 写 ${(s.diskW || 0).toFixed(1)}M`
        );
      }

      if (cardNet) {
        const svgBox = cardNet.querySelector('.chart-svg-box');
        if (svgBox) svgBox.innerHTML = buildInteractiveRateSvg(samples, 'netIn', 'netOut', '#10b981', '#a855f7', 0, 'gradNetIO');
        attachChartCrosshair(cardNet, samples, 'netIn', 'netOut', 'KB/s',
          (s) => `↓ ${(s.netIn || 0).toFixed(0)}K · ↑ ${(s.netOut || 0).toFixed(0)}K`,
          (s) => `↓ ${(s.netIn || 0).toFixed(0)}K / ↑ ${(s.netOut || 0).toFixed(0)}K`
        );
      }
    }

    function renderFootprint() {
      const container = footprintCard.querySelector('.footprint-body');
      if (!container) return;
      container.innerHTML = '';

      if (!PerfState.perfData) {
        fetchPerfSample(true);
      }

      const valid = S.items.map((it) => {
        const sz = Number(it.size) || (Number(it.size_kb) ? Number(it.size_kb) * 1024 : 0);
        return Object.assign({}, it, { size: sz });
      }).filter((it) => (it.size || 0) > 0);
      valid.sort((a, b) => (b.size || 0) - (a.size || 0));

      const totalAppsSize = valid.reduce((sum, it) => sum + (it.size || 0), 0);
      const topApps = valid.slice(0, 6);
      const topSum = topApps.reduce((sum, it) => sum + (it.size || 0), 0);
      const otherSize = Math.max(0, totalAppsSize - topSum);

      const p = PerfState.perfData || {
        drives: [],
        disk_summary: { total: 0, used: 0, free: 0, percent: 0 },
        memory: { total: 0, available: 0, used: 0, percent: 0 },
        cpu: { percent: 0, cores: 1 }
      };
      const drives = p.drives || [];
      const mem = p.memory || {};
      const cpu = p.cpu || {};
      const disk = p.disk_summary || {};

      /* ================= SECTION 1: 四大指标核心卡片 ================= */
      const kpiRow = h('div', { class: 'app-kpi-grid' });

      function createKpiCard(iconName, title, valId, valText, barId, barPct, barColor, subId, subText, footId, footText) {
        const barFill = h('div', {
          id: barId,
          style: {
            height: '100%',
            width: Math.min(100, Math.max(0, barPct)) + '%',
            background: barColor,
            borderRadius: '2px',
            transition: 'width 0.4s ease'
          }
        });
        const barTrack = h('div', {
          style: {
            height: '4px',
            background: 'var(--line)',
            borderRadius: '2px',
            overflow: 'hidden',
            margin: '4px 0'
          }
        }, barFill);

        return h('div', { class: 'app-kpi-card' },
          h('div', { class: 'row app-kpi-label', style: { alignItems: 'center', gap: '6px' } },
            icon(iconName, 14),
            h('span', null, title)
          ),
          h('div', { id: valId, class: 'app-kpi-val' }, valText),
          barTrack,
          h('div', { class: 'row app-kpi-sub', style: { justifyContent: 'space-between' } },
            h('span', { id: subId }, subText),
            h('span', { id: footId, class: 'mono' }, footText)
          )
        );
      }

      const cardMem = createKpiCard(
        'cpu',
        T('物理内存占用', 'Physical Memory'),
        'fp-kpi-mem-val',
        (mem.percent || 0) + '%',
        'fp-kpi-mem-bar',
        mem.percent || 0,
        'var(--chart-1)',
        'fp-kpi-mem-sub',
        fmtBytes(mem.used || 0) + ' / ' + fmtBytes(mem.total || 0),
        'fp-kpi-mem-foot',
        T('可用 ', 'Free ') + fmtBytes(mem.available || 0)
      );

      const cardCpu = createKpiCard(
        'zap',
        T('处理器实时负载', 'CPU Load'),
        'fp-kpi-cpu-val',
        (cpu.percent || 0).toFixed(1) + '%',
        'fp-kpi-cpu-bar',
        cpu.percent || 0,
        'var(--chart-2)',
        'fp-kpi-cpu-sub',
        (cpu.cores || 1) + T(' 个逻辑处理器', ' Cores'),
        'fp-kpi-cpu-foot',
        (cpu.percent || 0) < 30 ? T('负载平稳', 'Idle/Smooth') : T('正在运转', 'Active')
      );

      const cardApps = createKpiCard(
        'box',
        T('已安装软件总占用', 'Installed Apps'),
        'fp-kpi-apps-val',
        fmtBytes(totalAppsSize),
        'fp-kpi-apps-bar',
        disk.total ? (totalAppsSize / disk.total) * 100 : 0,
        'var(--chart-3)',
        'fp-kpi-apps-sub',
        `已统计 ${valid.length} 款软件`,
        'fp-kpi-apps-foot',
        totalAppsSize ? `Top 6 占 ${((topSum / totalAppsSize) * 100).toFixed(1)}%` : '—'
      );

      const cardDisk = createKpiCard(
        'folder',
        T('全盘存储总容量', 'Total Storage'),
        'fp-kpi-disk-val',
        fmtBytes(disk.total || 0),
        'fp-kpi-disk-bar',
        disk.percent || 0,
        'var(--chart-4)',
        'fp-kpi-disk-sub',
        T(`已用 ${fmtBytes(disk.used || 0)} (${disk.percent || 0}%)`, `Used ${fmtBytes(disk.used || 0)} (${disk.percent || 0}%)`),
        'fp-kpi-disk-foot',
        T(`可用 ${fmtBytes(disk.free || 0)}`, `Free ${fmtBytes(disk.free || 0)}`)
      );

      kpiRow.appendChild(cardMem);
      kpiRow.appendChild(cardCpu);
      kpiRow.appendChild(cardApps);
      kpiRow.appendChild(cardDisk);
      container.appendChild(kpiRow);

      /* ================= SECTION 2: 三维度实时动态监控栅格 (计算/内存 + 磁盘I/O + 网络吞吐) ================= */
      const monitorGrid = h('div', {
        style: {
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: '12px'
        }
      });

      function createMonitorCard(id, title, legA, legB, colorA, colorB, keyA, keyB, unit, defaultFmt, compactFmt, gradId) {
        const samples = PerfState.samples;
        const latest = samples.length ? samples[samples.length - 1] : { memPct: 0, cpuPct: 0, diskR: 0, diskW: 0, netIn: 0, netOut: 0 };

        const cHeader = h('div', {
          class: 'row',
          style: {
            justifyContent: 'space-between',
            alignItems: 'center',
            height: '24px',
            minHeight: '24px',
            maxHeight: '24px',
            lineHeight: '24px',
            overflow: 'hidden',
            whiteSpace: 'nowrap',
            flexWrap: 'nowrap',
            marginBottom: '6px'
          }
        },
          h('div', { class: 'row', style: { alignItems: 'center', gap: '6px', minWidth: '0', flexShrink: '0', whiteSpace: 'nowrap' } },
            h('strong', { style: { fontSize: '12px', color: 'var(--text-1)', whiteSpace: 'nowrap', flexShrink: '0', wordBreak: 'keep-all' } }, title),
            h('div', { class: 'row', style: { gap: '6px', fontSize: '10px', whiteSpace: 'nowrap', flexShrink: '0', wordBreak: 'keep-all' } },
              h('span', { class: 'row', style: { alignItems: 'center', gap: '3px', whiteSpace: 'nowrap', flexShrink: '0', wordBreak: 'keep-all' } },
                h('span', { style: { width: '6px', height: '6px', borderRadius: '50%', background: colorA, flexShrink: '0' } }),
                h('span', { style: { color: 'var(--text-3)', whiteSpace: 'nowrap', wordBreak: 'keep-all' } }, legA)
              ),
              h('span', { class: 'row', style: { alignItems: 'center', gap: '3px', whiteSpace: 'nowrap', flexShrink: '0', wordBreak: 'keep-all' } },
                h('span', { style: { width: '6px', height: '6px', borderRadius: '50%', background: colorB, flexShrink: '0' } }),
                h('span', { style: { color: 'var(--text-3)', whiteSpace: 'nowrap', wordBreak: 'keep-all' } }, legB)
              )
            )
          ),
          h('span', {
            class: 'chart-cur-val mono',
            style: {
              fontSize: '11px',
              color: 'var(--text-2)',
              whiteSpace: 'nowrap',
              flexShrink: '0',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              textAlign: 'right',
              wordBreak: 'keep-all'
            }
          }, defaultFmt(latest))
        );

        const svgBox = h('div', { class: 'chart-svg-box', style: { width: '100%', height: '76px' } });
        svgBox.innerHTML = buildInteractiveRateSvg(samples, keyA, keyB, colorA, colorB, unit === '%' ? 100 : 0, gradId);

        const timeAxis = h('div', { class: 'row', style: { justifyContent: 'space-between', fontSize: '10px', color: 'var(--text-3)', marginTop: '2px' } },
          h('span', null, '-45s'),
          h('span', null, '-30s'),
          h('span', null, '-15s'),
          h('span', null, T('实时', 'Live'))
        );

        const cardEl = h('div', {
          id,
          style: {
            padding: '10px 14px',
            background: 'var(--surface-2)',
            border: '1px solid var(--line)',
            borderRadius: 'var(--radius)',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between'
          }
        }, cHeader, svgBox, timeAxis);

        attachChartCrosshair(cardEl, samples, keyA, keyB, unit, defaultFmt, compactFmt);
        return cardEl;
      }

      const cardCpuRam = createMonitorCard(
        'fp-chart-card-cpu-ram',
        T('计算与内存', 'Compute & RAM'),
        T('内存', 'RAM'), 'CPU',
        'var(--chart-1)', 'var(--chart-2)',
        'memPct', 'cpuPct', '%',
        (s) => `内存 ${s.memPct || 0}% · CPU ${s.cpuPct || 0}%`,
        (s) => `RAM ${s.memPct || 0}% / CPU ${s.cpuPct || 0}%`,
        'gradCpuRam'
      );

      const cardDiskIO = createMonitorCard(
        'fp-chart-card-disk',
        T('磁盘 I/O', 'Disk I/O'),
        T('读', 'Read'), T('写', 'Write'),
        '#38bdf8', '#f43f5e',
        'diskR', 'diskW', 'MB/s',
        (s) => `读 ${(s.diskR || 0).toFixed(1)}M · 写 ${(s.diskW || 0).toFixed(1)}M`,
        (s) => `读 ${(s.diskR || 0).toFixed(1)}M / 写 ${(s.diskW || 0).toFixed(1)}M`,
        'gradDiskIO'
      );

      const cardNetIO = createMonitorCard(
        'fp-chart-card-net',
        T('网络吞吐', 'Network'),
        T('下行', 'Down'), T('上行', 'Up'),
        '#10b981', '#a855f7',
        'netIn', 'netOut', 'KB/s',
        (s) => `↓ ${(s.netIn || 0).toFixed(0)}K · ↑ ${(s.netOut || 0).toFixed(0)}K`,
        (s) => `↓ ${(s.netIn || 0).toFixed(0)}K / ↑ ${(s.netOut || 0).toFixed(0)}K`,
        'gradNetIO'
      );

      monitorGrid.appendChild(cardCpuRam);
      monitorGrid.appendChild(cardDiskIO);
      monitorGrid.appendChild(cardNetIO);
      container.appendChild(monitorGrid);

      /* ================= SECTION 3: 磁盘分区水位透视 ================= */
      if (drives.length) {
        const partitionsBox = h('div', {
          style: {
            padding: '14px 16px',
            background: 'var(--surface-2)',
            border: '1px solid var(--line)',
            borderRadius: 'var(--radius)',
            display: 'flex',
            flexDirection: 'column',
            gap: '12px'
          }
        },
          h('div', { class: 'row', style: { alignItems: 'center', justifyContent: 'space-between' } },
            h('strong', { style: { fontSize: '13px', color: 'var(--text-1)' } }, T('全盘存储水位与应用分布', 'Disk Partitions & App Distribution')),
            h('span', { class: 'muted small' }, `共 ${drives.length} 个逻辑驱动器`)
          )
        );

        drives.forEach((d) => {
          const letterUpper = (d.letter || 'C').toUpperCase();
          const dApps = valid.filter((it) => (it.install_path || '').toUpperCase().startsWith(letterUpper + ':'));
          const dAppSize = dApps.reduce((s, it) => s + (it.size || 0), 0);
          const dOtherSize = Math.max(0, (d.used || 0) - dAppSize);
          const dFree = d.free || 0;
          const dTotal = Math.max(1, d.total || 1);

          const pctApp = Math.min(100, (dAppSize / dTotal) * 100);
          const pctOther = Math.min(100 - pctApp, (dOtherSize / dTotal) * 100);
          const pctFree = Math.max(0, 100 - pctApp - pctOther);

          const bar = h('div', {
            style: {
              display: 'flex',
              height: '8px',
              borderRadius: 'var(--radius-sm)',
              overflow: 'hidden',
              background: 'var(--line)',
              margin: '6px 0'
            }
          },
            h('div', { style: { width: pctApp + '%', background: 'var(--chart-1)', transition: 'width 0.3s ease' }, title: `已安装软件: ${fmtBytes(dAppSize)}` }),
            h('div', { style: { width: pctOther + '%', background: '#94a3b8', transition: 'width 0.3s ease' }, title: `系统与其他数据: ${fmtBytes(dOtherSize)}` }),
            h('div', { style: { width: pctFree + '%', background: 'var(--line)', opacity: 0.4 }, title: `空闲可用: ${fmtBytes(dFree)}` })
          );

          const driveRow = h('div', { style: { display: 'flex', flexDirection: 'column' } },
            h('div', { class: 'row', style: { justifyContent: 'space-between', fontSize: '12px' } },
              h('div', { class: 'row', style: { alignItems: 'center', gap: '6px' } },
                icon('folder', 14),
                h('strong', { style: { color: 'var(--text-1)' } }, d.drive + (d.is_system ? ' (系统盘)' : '')),
                h('span', { class: 'muted small' }, `已用 ${fmtBytes(d.used || 0)} (${d.percent || 0}%)`)
              ),
              h('div', { class: 'row', style: { gap: '10px', fontSize: '11px', color: 'var(--text-3)' } },
                h('span', null, `软件: ${fmtBytes(dAppSize)} (${pctApp.toFixed(1)}%)`),
                h('span', null, `系统及其他: ${fmtBytes(dOtherSize)}`),
                h('span', { style: { fontWeight: '600', color: 'var(--text-2)' } }, `剩余 ${fmtBytes(dFree)}`)
              )
            ),
            bar
          );

          partitionsBox.appendChild(driveRow);
        });

        container.appendChild(partitionsBox);
      }

      /* ================= SECTION 4: 双维度占用大户治理 ================= */
      const dualGrid = h('div', {
        style: {
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
          gap: '16px',
          alignItems: 'stretch'
        }
      });

      /* 维度一：已安装软件磁盘空间大户 */
      const diskCol = h('div', {
        style: {
          padding: '14px 16px',
          background: 'var(--surface-2)',
          border: '1px solid var(--line)',
          borderRadius: 'var(--radius)',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          gap: '10px'
        }
      },
        h('strong', { style: { fontSize: '13px', color: 'var(--text-1)' } }, T('磁盘空间大户排行', 'Top Disk Space Consumers'))
      );

      if (!valid.length) {
        diskCol.appendChild(empty(T('暂无已安装软件空间数据', 'No software size data'), T('可切换至「已安装程序」测算应用体积', 'Switch to Installed Apps to scan sizes')));
      } else {
        const slices = topApps.map((a) => ({
          name: a.name,
          size: a.size || 0,
          pct: totalAppsSize ? (a.size || 0) / totalAppsSize : 0,
          app: a
        }));
        if (otherSize > 0) {
          slices.push({
            name: T('其他已安装应用', 'Other installed apps'),
            size: otherSize,
            pct: totalAppsSize ? otherSize / totalAppsSize : 0,
            app: null
          });
        }

        const palette = [
          'var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)',
          'var(--chart-4)', 'var(--chart-5)', 'var(--chart-6)', 'var(--chart-7)'
        ];

        const r = 50;
        const circ = 2 * Math.PI * r;
        let offset = 0;
        const paths = slices.map((s, idx) => {
          const strokeLen = s.pct * circ;
          const color = palette[idx % palette.length];
          const circle = `<circle cx="65" cy="65" r="${r}" fill="none" stroke="${color}" stroke-width="16" stroke-dasharray="${strokeLen} ${circ - strokeLen}" stroke-dashoffset="${-offset}" />`;
          offset += strokeLen;
          return circle;
        }).join('');

        const donutSvg = `
          <svg viewBox="0 0 130 130" width="90" height="90" style="transform: rotate(-90deg); display: block; flex-shrink: 0;">
            <circle cx="65" cy="65" r="${r}" fill="none" stroke="var(--line)" stroke-width="16" />
            ${paths}
          </svg>
        `;

        const donutRow = h('div', { class: 'row wrap', style: { alignItems: 'center', gap: '16px', paddingBottom: '8px', borderBottom: '1px solid var(--line)' } });
        const svgWrap = h('div', { style: { position: 'relative', width: '90px', height: '90px', flexShrink: 0 } });
        svgWrap.innerHTML = donutSvg;

        const legendWrap = h('div', { class: 'stack', style: { gap: '4px', flex: '1', minWidth: '160px' } },
          ...slices.slice(0, 4).map((s, idx) => h('div', { class: 'row', style: { alignItems: 'center', gap: '6px', fontSize: '11px' } },
            h('span', { style: { width: '8px', height: '8px', borderRadius: '50%', background: palette[idx % palette.length], flexShrink: '0' } }),
            h('span', { class: 'ellipsis', style: { flex: '1', color: 'var(--text-1)' }, title: s.name }, s.name),
            h('span', { style: { fontFamily: 'var(--mono)', color: 'var(--text-3)' } }, fmtBytes(s.size))
          ))
        );
        donutRow.appendChild(svgWrap);
        donutRow.appendChild(legendWrap);
        diskCol.appendChild(donutRow);

        const listWrap = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } });
        topApps.slice(0, 5).forEach((a, i) => {
          const row = h('div', {
            class: 'row',
            style: {
              alignItems: 'center',
              gap: '10px',
              padding: '6px 8px',
              background: 'var(--surface)',
              border: '1px solid var(--line)',
              borderRadius: 'var(--radius-sm)'
            }
          },
            h('strong', { class: 'mono' + (i < 3 ? ' badge accent sm' : ' muted'), style: { minWidth: '22px', textAlign: 'center' } }, '#' + (i + 1)),
            h('div', { class: 'stack', style: { flex: '1', minWidth: '0' } },
              h('span', { class: 'ellipsis small', style: { fontWeight: '600' }, title: a.name }, a.name),
              h('span', { class: 'muted tiny mono ellipsis' }, a.install_path || a.publisher || '—')
            ),
            h('span', { class: 'badge mono accent sm' }, fmtBytes(a.size || 0)),
            btn('定位', 'Inspect', 'ghost sm', 'external', () => {
              switchTab('apps');
              filterInput.value = a.name;
              S.filter = a.name.toLowerCase();
              applyFilter();
            })
          );
          listWrap.appendChild(row);
        });
        diskCol.appendChild(listWrap);
      }

      /* 维度二：运行中应用内存占用大户 */
      const ramCol = h('div', {
        style: {
          padding: '14px 16px',
          background: 'var(--surface-2)',
          border: '1px solid var(--line)',
          borderRadius: 'var(--radius)',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          gap: '10px'
        }
      },
        h('strong', { style: { fontSize: '13px', color: 'var(--text-1)' } }, T('后台运行内存大户', 'Top Running RAM Consumers'))
      );

      const runningApps = (ProcState.items || []).filter((p) => !p.is_system);
      if (!runningApps.length) {
        const btnLoadProcs = btn('获取进程快照', 'Snapshot Processes', 'ghost sm', 'refresh', async () => {
          setBtnBusy(btnLoadProcs, true);
          try {
            await loadProcs(false);
            renderFootprint();
          } finally {
            setBtnBusy(btnLoadProcs, false);
          }
        });
        const emptyProcs = empty(T('暂无运行中进程快照', 'No process snapshot yet'));
        emptyProcs.appendChild(h('div', { style: { marginTop: '8px' } }, btnLoadProcs));
        ramCol.appendChild(emptyProcs);
      } else {
        const topProcs = runningApps.slice(0, 5);
        const ramTopSum = topProcs.reduce((sum, p) => sum + (p.memory || 0), 0);
        const ramOtherMem = Math.max(0, (ProcState.totalMemory || ramTopSum) - ramTopSum);
        const ramSlices = topProcs.map((p) => ({
          name: p.name,
          size: p.memory || 0,
          pct: ProcState.totalMemory ? (p.memory || 0) / ProcState.totalMemory : 0
        }));
        if (ramOtherMem > 0) {
          ramSlices.push({
            name: T('其他运行中进程', 'Other processes'),
            size: ramOtherMem,
            pct: ProcState.totalMemory ? ramOtherMem / ProcState.totalMemory : 0
          });
        }

        const ramPalette = [
          'var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)',
          'var(--chart-4)', 'var(--chart-5)', 'var(--chart-6)'
        ];

        const ramR = 50;
        const ramCirc = 2 * Math.PI * ramR;
        let ramOffset = 0;
        const ramPaths = ramSlices.map((s, idx) => {
          const strokeLen = s.pct * ramCirc;
          const color = ramPalette[idx % ramPalette.length];
          const circle = `<circle cx="65" cy="65" r="${ramR}" fill="none" stroke="${color}" stroke-width="16" stroke-dasharray="${strokeLen} ${ramCirc - strokeLen}" stroke-dashoffset="${-ramOffset}" />`;
          ramOffset += strokeLen;
          return circle;
        }).join('');

        const ramDonutSvg = `
          <svg viewBox="0 0 130 130" width="90" height="90" style="transform: rotate(-90deg); display: block; flex-shrink: 0;">
            <circle cx="65" cy="65" r="${ramR}" fill="none" stroke="var(--line)" stroke-width="16" />
            ${ramPaths}
          </svg>
        `;

        const ramDonutRow = h('div', { class: 'row wrap', style: { alignItems: 'center', gap: '16px', paddingBottom: '8px', borderBottom: '1px solid var(--line)' } });
        const ramSvgWrap = h('div', { style: { position: 'relative', width: '90px', height: '90px', flexShrink: 0 } });
        ramSvgWrap.innerHTML = ramDonutSvg;

        const ramLegendWrap = h('div', { class: 'stack', style: { gap: '4px', flex: '1', minWidth: '160px' } },
          ...ramSlices.slice(0, 4).map((s, idx) => h('div', { class: 'row', style: { alignItems: 'center', gap: '6px', fontSize: '11px' } },
            h('span', { style: { width: '8px', height: '8px', borderRadius: '50%', background: ramPalette[idx % ramPalette.length], flexShrink: '0' } }),
            h('span', { class: 'ellipsis', style: { flex: '1', color: 'var(--text-1)' }, title: s.name }, s.name),
            h('span', { style: { fontFamily: 'var(--mono)', color: 'var(--text-3)' } }, fmtSize(s.size))
          ))
        );
        ramDonutRow.appendChild(ramSvgWrap);
        ramDonutRow.appendChild(ramLegendWrap);
        ramCol.appendChild(ramDonutRow);

        const listProcWrap = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } });
        topProcs.forEach((p, i) => {
          const row = h('div', {
            class: 'row',
            style: {
              alignItems: 'center',
              gap: '10px',
              padding: '6px 8px',
              background: 'var(--surface)',
              border: '1px solid var(--line)',
              borderRadius: 'var(--radius-sm)'
            }
          },
            h('strong', { class: 'mono' + (i < 3 ? ' badge accent sm' : ' muted'), style: { minWidth: '22px', textAlign: 'center' } }, '#' + (i + 1)),
            h('div', { class: 'stack', style: { flex: '1', minWidth: '0' } },
              h('span', { class: 'ellipsis small', style: { fontWeight: '600' }, title: p.name }, p.name),
              h('span', { class: 'muted tiny mono ellipsis' }, p.process_count > 1 ? `${p.process_count} 个进程` : `PID ${p.pids ? p.pids[0] : '—'}`)
            ),
            h('span', { class: 'badge mono sm' }, fmtSize(p.memory || 0)),
            btn('结束', 'Close', 'ghost sm danger', 'close', async () => {
              await closeProcOne(p, false);
              renderFootprint();
            }),
            btn('管理', 'Manage', 'ghost sm', 'external', () => {
              switchTab('procs');
              procFilterInput.value = p.clean_name;
              ProcState.filter = p.clean_name;
              applyProcFilter();
            })
          );
          listProcWrap.appendChild(row);
        });
        ramCol.appendChild(listProcWrap);
      }

      dualGrid.appendChild(diskCol);
      dualGrid.appendChild(ramCol);
      container.appendChild(dualGrid);
    }

    function switchTab(tab) {
      currentTab = tab;
      GlobalAppsCache.activeTab = tab;
      tabAppsBtn.className = 'wb-tab' + (tab === 'apps' ? ' active' : '');
      tabStartupBtn.className = 'wb-tab' + (tab === 'startup' ? ' active' : '');
      tabProcsBtn.className = 'wb-tab' + (tab === 'procs' ? ' active' : '');
      tabFootprintBtn.className = 'wb-tab' + (tab === 'footprint' ? ' active' : '');

      updateAdminDisplay();
      mainCard.style.display = tab === 'apps' ? '' : 'none';
      startupCard.style.display = tab === 'startup' ? '' : 'none';
      procsCard.style.display = tab === 'procs' ? '' : 'none';
      footprintCard.style.display = tab === 'footprint' ? '' : 'none';

      if (tab === 'footprint') {
        startLiveMonitoring();
      } else {
        stopLiveMonitoring();
      }

      if (tab === 'procs') {
        startProcLiveMonitoring();
      } else {
        stopProcLiveMonitoring();
      }

      if (tab === 'apps') {
        if (!S.items.length) {
          loadApps(false);
        } else {
          applyFilter();
        }
      } else if (tab === 'startup') {
        if (!StartupState.items.length) {
          loadStartup(false);
        } else {
          applyStartupFilter();
        }
      } else if (tab === 'procs') {
        if (!ProcState.items.length) {
          loadProcs(false);
        } else {
          applyProcFilter();
        }
      } else if (tab === 'footprint') {
        renderFootprint();
        if (!S.items.length) loadApps(false);
        if (!ProcState.items.length) loadProcs(false);
      }
    }

    tabAppsBtn.onclick = () => switchTab('apps');
    tabStartupBtn.onclick = () => switchTab('startup');
    tabProcsBtn.onclick = () => switchTab('procs');
    tabFootprintBtn.onclick = () => switchTab('footprint');

    root.appendChild(topTabBar);
    root.appendChild(adminBar);
    root.appendChild(mainCard);
    root.appendChild(startupCard);
    root.appendChild(procsCard);
    root.appendChild(footprintCard);

    /* 右键菜单：对齐现代化深度卸载与残留清理工作流 */
    attachMenu(tableBox, (e) => {
      const tr = e.target.closest('tbody tr[data-key]');
      if (tr) {
        const it = S.visible[Number(tr.dataset.key)];
        if (!it) return [];
        // Appx 商店应用
        if (it.source === 'store') {
          return [
            { header: it.name || '' },
            { label: T('🚀 深度卸载与残留清理', '🚀 Deep uninstall & clean'), icon: 'trash',
              danger: true, action: () => openUninstallWizard(it, 'prepare') },
            { label: T('打开安装目录', 'Open install folder'), icon: 'folder',
              disabled: !it.install_path, action: () => openInstallDir(it) },
            { sep: true },
            { label: T('复制名称', 'Copy name'), icon: 'copy', action: () => copyText(it.name) },
            { label: T('复制包名', 'Copy package name'), icon: 'copy',
              disabled: !it.package, action: () => copyText(it.package) }
          ];
        }
        return [
          { header: it.name || '' },
          { label: T('🚀 深度卸载与残留清理（推荐）', '🚀 Deep uninstall & clean (Recommended)'), icon: 'trash',
            danger: true, action: () => openUninstallWizard(it, 'prepare') },
          { label: T('🔍 仅扫描并清理残留', '🔍 Scan & clean leftovers only'), icon: 'scan',
            action: () => openUninstallWizard(it, 'scan') },
          { label: T('⚡ 强制删除（目录 + 注册表）', '⚡ Force remove (files + registry)'), icon: 'trash',
            danger: true, action: () => forceRemove(it) },
          { label: T('删除条目（只删注册表项）', 'Delete entry (registry only)'), icon: 'close',
            action: () => deleteEntry(it) },
          { sep: true },
          { label: T('注册表条目…', 'Registry entry…'), icon: 'search', action: () => showRegistry(it) },
          { label: T('安装文件夹', 'Install folder'), icon: 'folder',
            disabled: !it.install_path, action: () => openInstallDir(it) },
          { label: T('程序网站', 'Program website'), icon: 'external',
            disabled: !it.url, action: () => openSite(it) },
          { sep: true },
          { label: T('通过谷歌搜索', 'Search on Google'), icon: 'search',
            action: () => googleSearch(it) },
          { sep: true },
          { label: T('复制名称', 'Copy name'), icon: 'copy', action: () => copyText(it.name) },
          { label: T('复制版本', 'Copy version'), icon: 'copy',
            disabled: !it.version, action: () => copyText(it.version) }
        ];
      }
      return [
        { label: T('刷新', 'Refresh'), icon: 'refresh', action: () => loadApps(true) },
        { sep: true },
        { label: T(S.sortAsc ? '按名称排序（升序）' : '按名称排序（降序）',
          S.sortAsc ? 'Sort by name (A-Z)' : 'Sort by name (Z-A)'), icon: 'rules', action: toggleSort },
        { label: T('按大小排序', 'Sort by size'), icon: 'rules',
          disabled: false, action: () => { S.sortBy = 'size'; S.sortAsc = false; applyFilter(); } }
      ];
    });

    // 统一初始化当前活跃 Tab 的数据流与视图呈现（消灭单独分支导致的未过滤与空白状态）
    switchTab(currentTab);

    /* 每页条数改了：就地重排当前表格，不重建页面 */
    App._onPageSize = (v) => {
      PAGE_SIZE = Number(v) || UI.pageSize();
      if (currentTab === 'apps') {
        S.page = 1;
        applyFilter();
      } else if (currentTab === 'startup') {
        StartupState.page = 1;
        applyStartupFilter();
      } else if (currentTab === 'procs') {
        ProcState.page = 1;
        applyProcFilter();
      }
    };
    // 先让页面壳完成一帧绘制，再发数据请求：切页动画不被读取列表拖住。
    // 引擎调用已搬到后台线程，这里只是把首帧让给动画。
    requestAnimationFrame(() => {
      refreshAdmin();
      if (!GlobalAppsCache.storeLoaded) {
        setTimeout(() => {
          ensureStore().then(() => {
            if (S.view === 'store' || S.view === 'all' || S.view === 'desktop') applyFilter();
          }).catch(() => {});
        }, 900);
      }
    });

    /* ---------------- 管理员权限展示与交互 ---------------- */
    function updateAdminDisplay() {
      const isAppsOrStartup = (currentTab === 'apps' || currentTab === 'startup');
      if (S.isAdmin) {
        // 已开启权限：横幅强提醒完全隐藏，释放垂直空间，融入为顶栏状态按钮
        adminBar.style.display = 'none';
        fusedAdminBtn.style.display = (isAppsOrStartup || currentTab === 'procs') ? 'inline-flex' : 'none';
        fusedAdminBtn.className = 'btn sm admin-fused-btn ok';
        fusedAdminLabel.textContent = T('管理员模式', 'Admin Mode');
        fusedAdminBtn.title = T('已具备系统管理员特权，受保护卸载器与系统自启均可直接操作（点击查看详情）',
          'Elevated privileges active; click to view details');
        fusedAdminBtn.onclick = () => showAdminDetailsModal();
      } else {
        // 未开启权限（普通权限）
        if (!adminBannerDismissed && isAppsOrStartup) {
          adminBar.style.display = '';
          fusedAdminBtn.style.display = 'none';
        } else {
          // 横幅被用户关闭，或在其他 Tab：在顶栏保留低调警示融合按钮，确保入口永不丢失
          adminBar.style.display = 'none';
          fusedAdminBtn.style.display = isAppsOrStartup ? 'inline-flex' : 'none';
          fusedAdminBtn.className = 'btn sm admin-fused-btn warn';
          fusedAdminLabel.textContent = T('普通权限', 'Standard User');
          fusedAdminBtn.title = T('当前以普通权限运行，点击重新展开提醒或以管理员身份重启',
            'Standard user; click to elevate or view details');
          fusedAdminBtn.onclick = () => {
            adminBannerDismissed = false;
            updateAdminDisplay();
          };
        }
      }
    }

    let adminModalActive = false;
    function showAdminDetailsModal() {
      if (adminModalActive) return;
      adminModalActive = true;
      const isElevated = S.isAdmin;
      const content = h('div', { class: 'admin-modal-box', style: { display: 'flex', flexDirection: 'column', gap: '12px', padding: '4px 0' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
          h('div', {
            style: {
              width: '38px',
              height: '38px',
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: isElevated ? 'var(--ok-weak)' : 'var(--warn-weak)',
              color: isElevated ? 'var(--ok)' : 'var(--warn)',
              flexShrink: '0'
            }
          }, icon('shield', 20)),
          h('div', null,
            h('div', { style: { fontWeight: '600', fontSize: 'var(--fs-body)', color: 'var(--text-1)' } },
              isElevated ? T('已获得系统管理员完整特权', 'Elevated Administrator Privileges Active') : T('当前以普通用户权限运行', 'Standard User Privileges')
            ),
            h('div', { class: 'muted small', style: { marginTop: '2px' } },
              isElevated ? T('Windows 令牌级别：高完整性 (High Integrity Level)', 'Windows Token: High Integrity Level') : T('Windows 令牌级别：中完整性 (Medium Integrity Level)', 'Windows Token: Medium Integrity Level')
            )
          )
        ),
        h('div', {
          style: {
            background: 'var(--surface-2)',
            borderRadius: 'var(--radius)',
            padding: '12px 14px',
            fontSize: 'var(--fs-small)',
            lineHeight: '1.6',
            color: 'var(--text-2)'
          }
        },
          isElevated ? [
            h('div', { style: { color: 'var(--ok)', fontWeight: '600', marginBottom: '6px' } }, T('已就绪的高级权限能力：', 'Active Privileged Capabilities:')),
            h('div', null, T('• 可直接静默启动位于 Program Files 的受保护卸载程序', '• Launch protected uninstallers in Program Files directly')),
            h('div', null, T('• 可修改与禁用系统级 (HKLM) 开机自启动注册表项', '• Modify and disable system-wide (HKLM) startup items')),
            h('div', null, T('• 可扫描并清除需要系统特权的顽固残留文件与注册表键值', '• Scan and remove privileged leftover files and registry keys')),
            h('div', null, T('• 卸载与清理过程免去频繁弹出的 Windows UAC 提权中断', '• Seamless uninstallation without repetitive UAC interruption prompts'))
          ] : [
            h('div', { style: { color: 'var(--warn)', fontWeight: '600', marginBottom: '6px' } }, T('当前权限下的受限场景：', 'Restricted Scenarios in Current Mode:')),
            h('div', null, T('• 无法修改或禁用 HKEY_LOCAL_MACHINE 系统级启动项', '• Cannot modify HKLM system startup items')),
            h('div', null, T('• 部分系统软件卸载器可能因无提权而启动失败或频繁弹窗', '• Protected uninstallers may fail or repeatedly prompt for UAC')),
            h('div', null, T('• 无法清理位于受保护系统目录的软件卸载残留', '• Cannot clean leftover files in protected system directories'))
          ]
        )
      );

      modal({
        title: T('权限运行环境说明', 'Privilege Environment Details'),
        body: content,
        buttons: isElevated ? [
          { id: 'ok', label: T('知道了', 'Got it'), kind: 'primary' }
        ] : [
          { id: 'cancel', label: T('暂不处理', 'Dismiss'), kind: 'ghost' },
          { id: 'restart', label: T('以管理员身份重启', 'Restart as admin'), kind: 'primary' }
        ],
        onClose: () => {
          adminModalActive = false;
        },
        onAction: (actionId) => {
          if (actionId === 'restart') {
            doRestartAsAdmin();
          }
        }
      });
    }

    async function refreshAdmin() {
      try {
        S.isAdmin = !!(await API.isAdmin());
      } catch (e) {
        S.isAdmin = false;
      }
      updateAdminDisplay();
    }

    async function doRestartAsAdmin() {
      btnAdmin.disabled = true;
      await busy(async () => {
        await API.runAsAdmin();
        toast(T('已请求管理员权限，应用会重启，请在系统弹窗里确认',
          'Elevation requested. The app will restart; confirm the system prompt'), 'ok', 6000);
      }, T('正在请求管理员权限并重启…', 'Requesting admin rights and restarting…'), 'apps');
      btnAdmin.disabled = false;
    }

    /* ---------------- 数据 ---------------- */
    async function loadApps(loud) {
      if (S.loading) return;
      S.loading = true;
      setBtnBusy(btnRefresh, true, '读取中…', 'Loading…');
      if (loud || !S.items.length) {
        tableBox.replaceChildren(skeleton(8, 'apps'));
      }
      try {
        const r = await API.engine('apps.list', {});
        S.items = Array.isArray(r.items) ? r.items : [];
        GlobalAppsCache.apps = S.items;
        const keep = S.selectedKey;
        S.selected = S.items.find((a) => keyOf(a) === keep) || null;
        S.selectedKey = S.selected ? keep : '';
        GlobalAppsCache.selectedKey = S.selectedKey;
        applyFilter();
        if (loud) {
          toast(T('已刷新程序列表：' + fmtCount(S.items.length) + ' 项',
            'Program list refreshed: ' + fmtCount(S.items.length) + ' item(s)'), 'ok');
        }
      } catch (e) {
        S.items = [];
        S.filtered = [];
        S.visible = [];
        S.selected = null;
        S.selectedKey = '';
        tableBox.replaceChildren(empty(T('读取已安装程序失败', 'Failed to read installed programs'),
          errText(e)));
        renderStatLine();
        renderPager();
        toast(errText(e), 'error');
      } finally {
        S.loading = false;
        setBtnBusy(btnRefresh, false);
        // 关键：renderTable() 在 loading 期间会直接 return，
        // 所以加载结束后必须再渲染一次，否则表格只剩表头（历史回归点）。
        // 只在「商店App」视图刷新商店列表；桌面视图保留旧数据，
        // 避免每次刷新都白跑一次约 1 秒的 PowerShell 枚举。
        if (S.storeLoaded && S.view === 'store') {
          S.store = [];
          S.storeLoaded = false;
          await ensureStore();
        }
        if (S.items.length || S.store.length) applyFilter();
        else renderTable();
      }
    }

    function applyFilter() {
      const q = String(S.filter || '').trim().toLowerCase();
      const base = allItems().slice().sort((a, b) => {
        if (S.sortBy === 'size') {
          const szA = (Number(a.size) || 0) || ((Number(a.size_kb) || 0) * 1024);
          const szB = (Number(b.size) || 0) || ((Number(b.size_kb) || 0) * 1024);
          return S.sortAsc ? (szA - szB) : (szB - szA);
        }
        if (S.sortBy === 'date') {
          const dtA = Number(a.date) || 0;
          const dtB = Number(b.date) || 0;
          return S.sortAsc ? (dtA - dtB) : (dtB - dtA);
        }
        const field = S.sortBy === 'publisher' ? 'publisher' : 'name';
        const c = collator.compare(String(a[field] || ''), String(b[field] || ''));
        return S.sortAsc ? c : -c;
      });
      let list = base;
      S.filtered = q
        ? list.filter((a) => [a.name, a.publisher, a.install_path, a.version, a.install_date]
          .some((v) => String(v || '').toLowerCase().includes(q)))
        : list;
      const pages = Math.max(1, Math.ceil(S.filtered.length / PAGE_SIZE));
      S.page = Math.min(Math.max(1, S.page), pages);
      renderTable();
      renderStatLine();
      updateTabBadges();
      renderPager();
    }

    function toggleSort() {
      S.sortAsc = !S.sortAsc;
      S.page = 1;
      GlobalAppsCache.appsSortAsc = S.sortAsc;
      updateSortChips();
      applyFilter();
    }

    function renderTable() {
      // 刷新期间保留旧表，别先闪成空白再等加载
      if (S.loading && tableBox.querySelector('table')) return;
      tableBox.innerHTML = '';
      if (S.loading) return;
      if (!allItems().length) {
        tableBox.appendChild(empty(T('没有读取到已安装程序', 'No installed programs found'),
          S.view === 'store'
            ? T('切换「全部」或「桌面应用」看看', 'Try All or Desktop apps')
            : T('点「刷新」重新读取注册表', 'Click Refresh to read the registry again')));
        S.visible = [];
        return;
      }
      if (!S.filtered.length) {
        tableBox.appendChild(empty(T('没有匹配的程序', 'No matching programs'),
          T('清除过滤关键词试试', 'Try clearing the filter')));
        S.visible = [];
        return;
      }

      const start = (S.page - 1) * PAGE_SIZE;
      S.visible = S.filtered.slice(start, start + PAGE_SIZE);

      const tbl = table({
        className: 'apps-table',
        columns: [
          {
            key: 'name',
            className: 'col-name',
            label: T('名称 / 版本', 'Name / version'),
            render: (a) => h('div', { class: 'name' },
              appIcon(a),
              h('span', { class: 'txt', style: { minWidth: '0' }, title: a.name || '' },
                a.name || ''),
              a.version
                ? h('span', { class: 'small muted', style: { flex: '0 0 auto' },
                  title: T('版本 ', 'Version ') + a.version }, a.version)
                : null,
              kindTag(a))
          },
          {
            key: 'size',
            className: 'col-size',
            align: 'right',
            label: T('大小', 'Size'),
            render: (a) => {
              const szText = fmtAppSize(a);
              const szNum = (Number(a.size) || 0) || ((Number(a.size_kb) || 0) * 1024);
              return h('span', {
                class: szNum > 0 ? 'txt-size' : 'muted small',
                style: { fontVariantNumeric: 'tabular-nums' }
              }, szText);
            }
          },
          {
            key: 'date',
            className: 'col-date',
            align: 'center',
            label: T('安装日期', 'Install date'),
            render: (a) => h('span', {
              class: 'small muted',
              style: { fontVariantNumeric: 'tabular-nums' }
            }, fmtAppDate(a))
          },
          {
            key: 'publisher',
            className: 'col-publisher',
            label: T('发行商', 'Publisher'),
            render: (a) => h('div', { class: 'ellipsis', title: a.publisher || '' },
              a.publisher || '—')
          },
          {
            key: 'install_path',
            className: 'col-path',
            label: T('安装路径', 'Install path'),
            render: (a) => h('div', { class: 'mono ellipsis', title: a.install_path || '' },
              a.install_path || '—')
          },
          {
            key: 'ops',
            className: 'col-actions',
            align: 'right',
            label: T('操作', 'Actions'),
            render: (a) => {
              const bTrash = iconBtn('深度卸载', 'Deep uninstall', 'trash', () => {
                select(a);
                openUninstallWizard(a, 'prepare');
              }, true);
              const bScan = iconBtn('仅清理残留', 'Clean leftovers only', 'scan', () => {
                select(a);
                openUninstallWizard(a, 'scan');
              });
              if (a.source === 'store') {
                bScan.disabled = true;
                bScan.title = T('商店应用由系统沙盒管理，点击深度卸载即可', 'Store app managed by sandbox; click Deep uninstall');
              }
              const bFolder = iconBtn('打开安装目录', 'Open install folder', 'folder', () => openInstallDir(a));
              if (!a.install_path) {
                bFolder.disabled = true;
                bFolder.title = T('未检测到本地安装目录', 'No local folder detected');
              }
              return h('div', { class: 'app-actions' }, bTrash, bScan, bFolder);
            }
          }
        ],
        rows: S.visible,
        rowKey: (row, i) => String(i)
      });
      // 固定列宽，让名称 / 路径的省略号真正生效，避免表格被长路径撑宽
      tbl.style.tableLayout = 'fixed';

      tbl.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        const tr = e.target.closest('tbody tr');
        if (!tr) return;
        const it = S.visible[Number(tr.dataset.key)];
        if (it) select(it);
      });
      tbl.addEventListener('dblclick', (e) => {
        if (e.target.closest('button')) return;
        const tr = e.target.closest('tbody tr');
        if (!tr) return;
        const it = S.visible[Number(tr.dataset.key)];
        if (it && it.install_path) openPath(it.install_path);
      });

      tableBox.appendChild(h('div', { class: 'table-wrap' }, tbl));
      applySelection(tbl);
      // 换页 / 切换视图后只让新表落定，不做整页重播；打字过滤时不淡入，避免逐键闪
      if (!S.typing) softIn(tableBox);
      hydrateIcons(S.visible).catch(() => {});
    }

    // letterBlock, iconCache, appIcon, hydrateIcons 已提升至 mount() 顶部作为各 Tab 通用能力

    function applySelection(tbl) {
      tbl.querySelectorAll('tbody tr[data-key]').forEach((tr) => {
        const it = S.visible[Number(tr.dataset.key)];
        tr.classList.toggle('selected', !!it && keyOf(it) === S.selectedKey);
      });
    }

    function select(it) {
      S.selected = it;
      S.selectedKey = keyOf(it);
      const tbl = tableBox.querySelector('table');
      if (tbl) applySelection(tbl);
      renderStatLine();
    }

    function renderPager() {
      const pages = Math.max(1, Math.ceil(S.filtered.length / PAGE_SIZE));
      if (document.activeElement !== pageInput) pageInput.value = String(S.page);
      pageTotal.textContent = String(pages);
      pageSumNum.textContent = fmtCount(S.filtered.length);
      btnPrev.disabled = S.page <= 1;
      btnNext.disabled = S.page >= pages;
    }

    function commitPageJump() {
      const pages = Math.max(1, Math.ceil(S.filtered.length / PAGE_SIZE));
      const raw = String(pageInput.value).replace(/[^\d]/g, '');
      const n = raw ? parseInt(raw, 10) : NaN;
      const target = Number.isFinite(n) ? Math.min(Math.max(1, n), pages) : S.page;
      pageInput.value = String(target);
      if (target !== S.page) gotoPage(target);
    }

    pageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commitPageJump(); pageInput.blur(); }
      else if (e.key === 'Escape') { pageInput.value = String(S.page); pageInput.blur(); }
    });
    pageInput.addEventListener('blur', () => { commitPageJump(); });

    function gotoPage(p) {
      const pages = Math.max(1, Math.ceil(S.filtered.length / PAGE_SIZE));
      S.page = Math.min(Math.max(1, p), pages);
      renderTable();
      renderPager();
    }

    function openPath(p) {
      API.openPath(p).catch((e) => toast(errText(e), 'error'));
    }

    function openInstallDir(it) {
      const target = it || S.selected;
      if (!target || !target.install_path) {
        toast(T('该程序没有安装路径信息', 'No install path for this program'), 'warn');
        return;
      }
      openPath(target.install_path);
    }

    /* ---------------- 深度卸载与残留清理工作流 ---------------- */
    async function uninstallOne(it) {
      if (!it) return;
      openUninstallWizard(it, 'prepare');
    }

    async function forceRemove(it) {
      if (!it) return;
      const yes = await confirm({
        title: T('强制删除', 'Force remove'),
        body: T('会直接删除「' + it.name + '」的安装目录并移除注册表卸载项，无法撤销。仅在没有卸载器或卸载器损坏时使用。',
          'This deletes the install folder of "' + it.name + '" and its registry entry. It cannot be undone; use only when the uninstaller is missing or broken.'),
        ok: T('强制删除', 'Force remove'),
        danger: true
      });
      if (!yes) return;
      const res = await busy(() => API.engine('apps.force_remove', {
        name: it.name, version: it.version || '', confirm: true
      }), T('正在删除…', 'Removing…'), 'apps');
      if (!res) return;
      const failed = (res && res.failed) || [];
      if (failed.length) {
        toast(T('部分内容没能删除：', 'Some items failed: ') +
          failed.map((f) => f.path || f.why).join(', '), 'warn');
      } else {
        toast(T('已强制删除', 'Force removed'), 'ok');
      }
      await loadApps(false);
    }

    async function deleteEntry(it) {
      if (!it) return;
      const yes = await confirm({
        title: T('删除条目', 'Delete entry'),
        body: T('只从「已安装程序」列表里移除「' + it.name + '」的注册表项，不删除任何文件。',
          'Removes the registry entry of "' + it.name + '" from the installed list. No files are deleted.'),
        ok: T('删除条目', 'Delete entry'),
        danger: true
      });
      if (!yes) return;
      const deleted = await busy(async () => {
        await API.engine('apps.delete_entry', {
          name: it.name, version: it.version || '', confirm: true
        });
        return true;
      }, T('正在删除注册表条目…', 'Deleting registry entry…'), 'apps');
      if (deleted) {
        toast(T('已删除注册表条目', 'Registry entry deleted'), 'ok');
        await loadApps(false);
      }
    }

    async function showRegistry(it) {
      if (!it) return;
      const r = await busy(
        () => API.engine('apps.registry', { name: it.name, version: it.version || '' }),
        T('正在读取注册表信息…', 'Reading registry entry…'),
        'apps'
      );
      if (!r) return;
      const rows = (r.values || []).map((v) =>
        h('tr', null,
          h('td', { class: 'mono small' }, v.name),
          h('td', { class: 'mono small ellipsis', title: v.value }, v.value)
        ));
      modal({
        title: T('注册表条目', 'Registry entry'),
        wide: true,
        body: h('div', { class: 'stack' },
          h('div', { class: 'small muted mono ellipsis', title: (r.hive || '') + '\\' + (r.key || '') },
            (r.hive || '') + '\\' + (r.key || '')),
          h('div', { class: 'table-wrap' },
            h('table', { class: 'table dense' },
              h('thead', null, h('tr', null,
                h('th', null, T('名称', 'Name')), h('th', null, T('值', 'Value')))),
              h('tbody', null, ...rows)))
        ),
        buttons: [{ id: 'ok', label: T('关闭', 'Close'), kind: 'primary' }]
      });
    }

    function openSite(it) {
      if (!it || !it.url) {
        toast(T('该程序没有登记官网', 'No website registered'), 'warn');
        return;
      }
      API.openPath(it.url).catch((e) => toast(errText(e), 'error'));
    }

    function googleSearch(it) {
      const q = encodeURIComponent((it && it.name) || '');
      API.openPath('https://www.google.com/search?q=' + q)
        .catch((e) => toast(errText(e), 'error'));
    }

    /* ================================================================
       智能深度卸载与残留清理全流程工作台（Smart Deep Uninstaller & Leftover Wizard）
       彻底推翻旧版底部折叠面板，打造真正一流的卸载与残留清理一体化闭环向导
       ================================================================ */
    let activeWizard = null;

    async function openUninstallWizard(app, initialPhase = 'prepare') {
      if (!app) return;
      if (activeWizard) {
        try { activeWizard.close(); } catch (_) {}
        activeWizard = null;
      }

      let currentStep = initialPhase === 'scan' ? 2 : 1; // 1: 准备, 2: 勘探, 3: 审查, 4: 报告
      let isUninstallerLaunched = false;
      let isCleaning = false;
      let leftoversData = null;
      let checkedDirs = new Set();
      let checkedRegs = new Set();
      let cleanupReport = null;

      const mask = h('div', {
        class: 'modal-mask',
        onclick: (e) => {
          if (e.target === mask && currentStep !== 2 && !isCleaning) wizardModal.close();
        }
      });
      const wizardBox = h('div', {
        class: 'modal uninstall-wizard-modal',
        role: 'dialog',
        'aria-modal': 'true'
      });
      mask.appendChild(wizardBox);
      document.getElementById('modal-root').appendChild(mask);

      function closeWizard() {
        mask.classList.add('closing');
        wizardBox.classList.add('closing');
        setTimeout(() => mask.remove(), 190);
        activeWizard = null;
      }
      const wizardModal = { close: closeWizard };
      activeWizard = wizardModal;

      const onEsc = (e) => {
        if (e.key === 'Escape' && currentStep !== 2 && !isCleaning) {
          closeWizard();
        }
      };
      document.addEventListener('keydown', onEsc);
      const origClose = wizardModal.close;
      wizardModal.close = () => {
        document.removeEventListener('keydown', onEsc);
        origClose();
      };

      const headEl = h('div', { class: 'wizard-head' });
      const bodyEl = h('div', { class: 'wizard-body' });
      const footEl = h('div', { class: 'wizard-foot' });
      wizardBox.appendChild(headEl);
      wizardBox.appendChild(bodyEl);
      wizardBox.appendChild(footEl);

      function renderHead() {
        headEl.innerHTML = '';
        const titleRow = h('div', { class: 'wizard-title-row' },
          h('div', { class: 'wizard-title' },
            icon('trash', 16),
            T('深度卸载与残留清理工作台', 'Deep Uninstall & Leftover Cleaning')
          ),
          iconBtn('关闭', 'Close', 'close', () => closeWizard())
        );

        const steps = [
          { num: 1, zh: '准备卸载', en: 'Prepare' },
          { num: 2, zh: '痕迹勘探', en: 'Scan traces' },
          { num: 3, zh: '残留审查', en: 'Review & clean' },
          { num: 4, zh: '彻底抹除', en: 'Completed' }
        ];

        const stepEls = [];
        steps.forEach((s, idx) => {
          const isDone = currentStep > s.num;
          const isActive = currentStep === s.num;
          const stepDiv = h('div', { class: 'wizard-step' + (isActive ? ' active' : '') + (isDone ? ' done' : '') },
            h('div', { class: 'wizard-step-dot' }, isDone ? icon('check', 12) : String(s.num)),
            h('span', null, T(s.zh, s.en))
          );
          stepEls.push(stepDiv);
          if (idx < steps.length - 1) {
            stepEls.push(h('div', { class: 'wizard-step-line' + (currentStep > s.num ? ' done' : '') }));
          }
        });

        const stepsBar = h('div', { class: 'wizard-steps' }, ...stepEls);
        headEl.appendChild(titleRow);
        headEl.appendChild(stepsBar);
      }

      function renderHeroCard() {
        const iconWrap = h('div', { class: 'app-icon-wrap' }, appIcon(app));
        const sizeVal = (Number(app.size) || 0) || ((Number(app.size_kb) || 0) * 1024);
        const heroInfo = h('div', { class: 'wizard-hero-info' },
          h('div', { class: 'wizard-hero-name' },
            h('span', { class: 'ellipsis' }, app.name),
            app.version ? h('span', { class: 'badge' }, app.version) : null,
            sizeVal > 0 ? h('span', { class: 'badge ghost' }, fmtBytes(sizeVal)) : null
          ),
          h('div', { class: 'wizard-hero-sub mono ellipsis', title: app.install_path || app.location || app.publisher || '' },
            (app.install_path || app.location)
              ? `${T('安装目录', 'Path')}: ${app.install_path || app.location}`
              : (app.publisher
                  ? `${T('发行商', 'Publisher')}: ${app.publisher}`
                  : (app._orphan || !app.key
                      ? T('已卸载软件 · 全盘孤立残留深度排查', 'Uninstalled App · Deep Orphan Scan')
                      : T('Windows 系统注册条目', 'System registered entry')))
          )
        );
        return h('div', { class: 'wizard-hero-card' }, iconWrap, heroInfo);
      }

      function renderBody() {
        bodyEl.innerHTML = '';
        bodyEl.appendChild(renderHeroCard());

        if (currentStep === 1) {
          renderPhase1();
        } else if (currentStep === 2) {
          renderPhase2();
        } else if (currentStep === 3) {
          renderPhase3();
        } else if (currentStep === 4) {
          renderPhase4();
        }
      }

      // Step 1: 准备卸载
      function renderPhase1() {
        const isStore = app.source === 'store';
        const hasUninstaller = !!(app.uninstall_cmd || app.quiet_cmd);

        let banner;
        let actionBtn;
        let altAction = null;

        if (isStore) {
          banner = h('div', { class: 'wizard-status-banner info' },
            icon('info', 18),
            h('div', { style: { flex: '1', minWidth: '0' } },
              h('div', { style: { fontWeight: '600' } }, T('Windows 应用商店组件', 'Windows Store Package')),
              h('div', { style: { fontSize: 'var(--fs-tiny)', opacity: 0.9, marginTop: '3px' } },
                T('此软件由系统沙盒环境托管。点击下方按钮将调用 PowerShell 安全移除，随后将扫描用户数据残留。',
                  'Managed by Windows sandbox. Click below to remove via PowerShell, then scan leftover data.'))
            )
          );
          actionBtn = btn('移除此商店应用并扫描残留', 'Uninstall Store app & scan', 'primary', 'trash', async () => {
            try {
              setBtnBusy(actionBtn, true, '正在卸载…', 'Uninstalling…');
              await API.removeStoreApp(app.package, true);
              toast(T('已完成商店应用基础卸载，正在勘探残留…', 'Store app removed, scanning traces…'), 'ok');
              goToStep(2);
            } catch (e) {
              toast(errText(e), 'error');
            } finally {
              setBtnBusy(actionBtn, false);
            }
          });
        } else if (!hasUninstaller) {
          banner = h('div', { class: 'wizard-status-banner' },
            icon('shield', 18),
            h('div', { style: { flex: '1', minWidth: '0' } },
              h('div', { style: { fontWeight: '600' } }, T('无自带卸载程序（强力粉碎模式）', 'No built-in uninstaller (Force mode)')),
              h('div', { style: { fontSize: 'var(--fs-tiny)', opacity: 0.9, marginTop: '3px' } },
                T('该软件未注册系统卸载命令（常见于绿色软件、残留项或卸载器丢失）。向导将直接对该软件的安装目录与全部注册表项进行深度痕迹勘探与强力清除。',
                  'No uninstaller registered. The wizard will deeply scan install folders and registry keys for forced cleanup.'))
            )
          );
          actionBtn = btn('开始深度痕迹勘探与强力清除', 'Start deep trace scan & force clean', 'primary', 'scan', () => {
            goToStep(2);
          });
        } else {
          // 具备官方卸载器
          if (!isUninstallerLaunched) {
            banner = h('div', { class: 'wizard-status-banner info' },
              icon('activity', 18),
              h('div', { style: { flex: '1', minWidth: '0' } },
                h('div', { style: { fontWeight: '600' } }, T('阶段一：运行官方卸载向导', 'Phase 1: Run official uninstaller')),
                h('div', { style: { fontSize: 'var(--fs-tiny)', opacity: 0.9, marginTop: '3px' } },
                  T('首先启动软件自带的卸载程序，请在系统弹出的窗口中操作完成。官方卸载完成后，向导将无缝承接进行深层残留扫除。',
                    'Launch official uninstaller first. After it finishes in system window, wizard will deeply clean leftovers.'))
              )
            );
            actionBtn = btn('启动官方卸载向导', 'Launch official uninstaller', 'primary', 'trash', async () => {
              try {
                setBtnBusy(actionBtn, true, '正在启动…', 'Launching…');
                const r = await API.engine('apps.uninstall', {
                  name: app.name, version: app.version || '', confirm: true, mode: 'auto'
                });
                if (r && r.started === false) {
                  toast(T('官方卸载程序未响应，可直接跳过', 'Uninstaller failed to start; you can skip'), 'warn');
                } else {
                  toast(T('已启动系统卸载窗口，请完成卸载', 'Uninstaller launched, please finish in window'), 'ok');
                }
                isUninstallerLaunched = true;
                renderBody();
              } catch (e) {
                toast(errText(e), 'error');
              } finally {
                setBtnBusy(actionBtn, false);
              }
            });
            altAction = h('a', {
              class: 'small muted',
              style: { cursor: 'pointer', textDecoration: 'underline' },
              onclick: () => goToStep(2)
            }, T('跳过官方卸载，直接扫描残留', 'Skip official uninstaller, scan leftovers directly'));
          } else {
            banner = h('div', { class: 'wizard-status-banner' },
              icon('activity', 18),
              h('div', { style: { flex: '1', minWidth: '0' } },
                h('div', { style: { fontWeight: '600', color: 'var(--accent)' } }, T('官方卸载程序正在运行中…', 'Official uninstaller is running…')),
                h('div', { style: { fontSize: 'var(--fs-tiny)', opacity: 0.9, marginTop: '3px' } },
                  T('请在弹出的系统窗口中按照提示完成卸载。完成官方卸载后，点击下方按钮开始深度排查其遗留在电脑中的文件与注册表残留。',
                    'Finish uninstallation in the system window. When done, click the button below to scan all remaining files and registry keys.'))
              )
            );
            actionBtn = btn('已完成卸载，开始深度勘探残留', 'Done uninstalling, scan leftover traces', 'primary', 'scan', () => {
              goToStep(2);
            });
            altAction = h('a', {
              class: 'small muted',
              style: { cursor: 'pointer', textDecoration: 'underline' },
              onclick: () => goToStep(2)
            }, T('官方卸载器卡死？直接扫描残留', 'Uninstaller frozen? Scan leftovers directly'));
          }
        }

        bodyEl.appendChild(banner);
        if (altAction) {
          bodyEl.appendChild(h('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '6px' } }, altAction));
        }

        footEl.innerHTML = '';
        footEl.appendChild(h('div', { class: 'wizard-foot-left' },
          h('span', null, T('卸载前建议关闭该程序的所有后台进程', 'Close background processes before uninstalling'))
        ));
        footEl.appendChild(h('div', { class: 'wizard-foot-right' },
          btn('取消', 'Cancel', 'ghost', null, () => closeWizard()),
          actionBtn
        ));
      }

      // Step 2: 痕迹勘探中
      async function renderPhase2() {
        const scanBox = h('div', { class: 'wizard-status-banner info' },
          icon('scan', 20),
          h('div', { style: { flex: '1', minWidth: '0' } },
            h('div', { style: { fontWeight: '600' } }, T('阶段二：全盘深层痕迹勘探中…', 'Phase 2: Deep leftover trace exploration…')),
            h('div', { style: { fontSize: 'var(--fs-tiny)', opacity: 0.85, marginTop: '3px' } },
              T(`正在多维排查「${app.name}」在 Program Files、AppData、LocalLow、以及 HKLM / HKCU 注册表分区的孤立项…`,
                `Scanning Program Files, AppData, LocalLow, and HKLM/HKCU registry keys for "${app.name}"…`))
          )
        );
        bodyEl.appendChild(scanBox);
        bodyEl.appendChild(skeleton(3, 'apps'));

        footEl.innerHTML = '';
        footEl.appendChild(h('div', { class: 'wizard-foot-left' },
          h('span', null, T('正在分析磁盘扇区与注册表关联树…', 'Analyzing disk and registry tree…'))
        ));
        const btnCancelScan = btn('取消', 'Cancel', 'ghost', null, () => closeWizard());
        footEl.appendChild(h('div', { class: 'wizard-foot-right' }, btnCancelScan));

        try {
          const r = await API.engine('apps.leftovers', {
            name: app.name,
            version: app.version || '',
            location: app.install_path || app.location || '',
            publisher: app.publisher || '',
            hive: app.hive || '',
            key: app.key || ''
          });
          leftoversData = r || { name: app.name, dirs: [], regs: [], blocked: [] };
          checkedDirs = new Set((leftoversData.dirs || []).map((_, i) => i));
          checkedRegs = new Set((leftoversData.regs || []).map((_, i) => i));
          goToStep(3);
        } catch (e) {
          bodyEl.innerHTML = '';
          bodyEl.appendChild(renderHeroCard());
          bodyEl.appendChild(empty(T('勘探残留失败', 'Scan traces failed'), errText(e)));
          footEl.innerHTML = '';
          footEl.appendChild(h('div', { class: 'wizard-foot-left' }, null));
          footEl.appendChild(h('div', { class: 'wizard-foot-right' },
            btn('返回上一步', 'Back', 'ghost', null, () => goToStep(1)),
            btn('重试勘探', 'Retry scan', 'primary', 'refresh', () => renderPhase2())
          ));
        }
      }

      // Step 3: 残留审查与决策
      function renderPhase3() {
        const dirs = (leftoversData && leftoversData.dirs) || [];
        const regs = (leftoversData && leftoversData.regs) || [];
        const blocked = (leftoversData && leftoversData.blocked) || [];

        // 场景 A：无任何残留
        if (!dirs.length && !regs.length) {
          const cleanBox = h('div', { class: 'wizard-report-box' },
            h('div', { class: 'wizard-report-icon' }, icon('check', 28)),
            h('div', { style: { fontSize: 'var(--fs-title)', fontWeight: '700', color: 'var(--ok)' } },
              T('太棒了！未发现任何残留痕迹', 'Awesome! No leftover traces found')),
            h('div', { class: 'muted small', style: { maxWidth: '440px', lineHeight: '1.6' } },
              T(`该程序的安装目录、AppData 与注册表项均已彻底干净，无需额外清理。前台列表已为您自动移除该软件。`,
                `All folders and registry keys for "${app.name}" are completely clean. App list has been updated.`))
          );
          bodyEl.appendChild(cleanBox);

          removeAppFromState(app);

          footEl.innerHTML = '';
          footEl.appendChild(h('div', { class: 'wizard-foot-left' }, null));
          footEl.appendChild(h('div', { class: 'wizard-foot-right' },
            btn('完成并关闭', 'Done & close', 'primary', 'check', () => closeWizard())
          ));
          return;
        }

        // 场景 B：存在残留
        const summaryBanner = h('div', { class: 'wizard-status-banner ok' },
          icon('shield', 18),
          h('div', { style: { flex: '1', minWidth: '0' } },
            h('div', { style: { fontWeight: '600' } },
              T(`勘探完毕：发现 ${fmtCount(dirs.length)} 个残留目录、${fmtCount(regs.length)} 个注册表项`,
                `Scan completed: ${fmtCount(dirs.length)} folder(s), ${fmtCount(regs.length)} registry key(s)`)),
            h('div', { style: { fontSize: 'var(--fs-tiny)', opacity: 0.9, marginTop: '3px' } },
              T('已为您智能全选所有高信度残留项。注册表项将在清理前自动导出备份，防止误删。',
                'High-confidence items are pre-selected. Registry entries will be automatically backed up.'))
          )
        );
        bodyEl.appendChild(summaryBanner);

        // 磁盘残留分组
        if (dirs.length) {
          const groupHead = h('div', { class: 'wizard-group-head' },
            h('span', null, T(`📁 磁盘残留目录 (${dirs.length})`, `📁 Residual Folders (${dirs.length})`)),
            h('span', { class: 'muted small' }, T('点击右侧可在资源管理器中查看', 'Click folder icon to inspect'))
          );
          const groupList = h('div', { class: 'wizard-group-list' },
            ...dirs.map((d, i) => {
              const chk = h('input', {
                type: 'checkbox',
                checked: checkedDirs.has(i),
                onchange: (e) => {
                  if (e.target.checked) checkedDirs.add(i);
                  else checkedDirs.delete(i);
                  updateCleanBtnState();
                }
              });
              return h('div', { class: 'wizard-item-row' },
                h('label', null,
                  chk,
                  h('span', { class: 'mono ellipsis', title: d }, d)
                ),
                iconBtn('在文件夹中打开', 'Open folder', 'folder', () => openPath(d))
              );
            })
          );
          bodyEl.appendChild(h('div', { class: 'wizard-group' }, groupHead, groupList));
        }

        // 注册表残留分组
        if (regs.length) {
          const groupHead = h('div', { class: 'wizard-group-head' },
            h('span', null, T(`🔑 注册表残留键值 (${regs.length})`, `🔑 Registry Keys (${regs.length})`)),
            h('span', { class: 'muted small' }, T('清理前自动导出至数据备份区', 'Auto-backed up before removal'))
          );
          const groupList = h('div', { class: 'wizard-group-list' },
            ...regs.map((r, i) => {
              const label = String(r.hive || '') + '\\' + String(r.key || '');
              const chk = h('input', {
                type: 'checkbox',
                checked: checkedRegs.has(i),
                onchange: (e) => {
                  if (e.target.checked) checkedRegs.add(i);
                  else checkedRegs.delete(i);
                  updateCleanBtnState();
                }
              });
              return h('div', { class: 'wizard-item-row' },
                h('label', null,
                  chk,
                  h('span', { class: 'mono ellipsis', title: label }, label)
                ),
                iconBtn('复制注册表路径', 'Copy path', 'copy', () => copyText(label))
              );
            })
          );
          bodyEl.appendChild(h('div', { class: 'wizard-group' }, groupHead, groupList));
        }

        if (blocked.length) {
          bodyEl.appendChild(h('div', { class: 'row wrap' },
            h('span', { class: 'badge warn' }, T('被系统占用', 'In use')),
            h('span', { class: 'small muted ellipsis', style: { maxWidth: '560px' }, title: blocked.join('\n') },
              T(`${fmtCount(blocked.length)} 项被占用，将在下次重启后自动清理`,
                `${fmtCount(blocked.length)} item(s) locked; will be cleaned on reboot`))
          ));
        }

        renderFootStep3();
      }

      let btnCleanExec = null;
      function updateCleanBtnState() {
        if (!btnCleanExec) return;
        const total = checkedDirs.size + checkedRegs.size;
        btnCleanExec.disabled = total === 0;
        btnCleanExec._label.textContent = total
          ? T(`彻底抹除选中残留 (${total})`, `Clean selected (${total})`)
          : T('彻底抹除选中残留', 'Clean selected');
      }

      function renderFootStep3() {
        footEl.innerHTML = '';
        const leftWrap = h('div', { class: 'wizard-foot-left' },
          btn('全选', 'Select all', 'ghost sm', 'check', () => {
            const dirs = (leftoversData && leftoversData.dirs) || [];
            const regs = (leftoversData && leftoversData.regs) || [];
            checkedDirs = new Set(dirs.map((_, i) => i));
            checkedRegs = new Set(regs.map((_, i) => i));
            renderBody();
          }),
          btn('全不选', 'Select none', 'ghost sm', 'close', () => {
            checkedDirs = new Set();
            checkedRegs = new Set();
            renderBody();
          }),
          btn('重新扫描', 'Rescan', 'ghost sm', 'refresh', () => goToStep(2))
        );

        btnCleanExec = btn('彻底抹除选中残留', 'Clean selected', 'danger', 'trash', async () => {
          await executeCleanup();
        });
        updateCleanBtnState();

        const rightWrap = h('div', { class: 'wizard-foot-right' },
          btn('暂不清理', 'Skip', 'ghost', null, () => closeWizard()),
          btnCleanExec
        );
        footEl.appendChild(leftWrap);
        footEl.appendChild(rightWrap);
      }

      async function executeCleanup() {
        const dirs = (leftoversData.dirs || []).filter((_, i) => checkedDirs.has(i));
        const regs = (leftoversData.regs || []).filter((_, i) => checkedRegs.has(i));
        if (!dirs.length && !regs.length) return;

        try {
          isCleaning = true;
          setBtnBusy(btnCleanExec, true, '正在抹除…', 'Cleaning…');
          const r = await API.engine('apps.cleanup', {
            name: app.name,
            version: app.version || '',
            location: app.install_path || app.location || '',
            publisher: app.publisher || '',
            hive: app.hive || '',
            key: app.key || '',
            dirs: dirs,
            regs: regs,
            confirm: true
          });
          cleanupReport = r || {};
          removeAppFromState(app);
          goToStep(4);
        } catch (e) {
          toast(errText(e), 'error');
        } finally {
          isCleaning = false;
          if (btnCleanExec) setBtnBusy(btnCleanExec, false);
        }
      }

      // Step 4: 成果报告
      function renderPhase4() {
        const removedDirs = (cleanupReport && cleanupReport.removed_dirs) || [];
        const removedRegs = (cleanupReport && cleanupReport.removed_regs) || [];
        const backupDir = cleanupReport && cleanupReport.backup_dir;
        const failed = (cleanupReport && cleanupReport.failed) || [];

        const reportBox = h('div', { class: 'wizard-report-box' },
          h('div', { class: 'wizard-report-icon' }, icon('check', 28)),
          h('div', { style: { fontSize: 'var(--fs-title)', fontWeight: '700', color: 'var(--ok)' } },
            T('残留已全部清除，软件已从系统彻底抹除！', 'Leftovers cleaned! Program completely purged')),
          h('div', { class: 'muted small', style: { maxWidth: '440px' } },
            T(`「${app.name}」的所有关联文件与注册表键已安全抹除，列表已实时剔除，系统恢复洁净。`,
              `All traces of "${app.name}" have been permanently removed. App list updated.`)),
          h('div', { class: 'wizard-report-stats' },
            h('div', { class: 'wizard-report-stat-item' },
              h('span', { class: 'wizard-report-stat-num' }, String(removedDirs.length)),
              h('span', { class: 'wizard-report-stat-label' }, T('已清理磁盘目录', 'Folders removed'))
            ),
            h('div', { style: { width: '1px', height: '24px', background: 'var(--line)' } }),
            h('div', { class: 'wizard-report-stat-item' },
              h('span', { class: 'wizard-report-stat-num' }, String(removedRegs.length)),
              h('span', { class: 'wizard-report-stat-label' }, T('已清除注册表项', 'Keys removed'))
            )
          )
        );
        bodyEl.appendChild(reportBox);

        if (backupDir) {
          const backupRow = h('div', { class: 'wizard-status-banner info', style: { alignItems: 'center' } },
            icon('shield', 18),
            h('div', { style: { flex: '1', minWidth: '0' } },
              h('div', { style: { fontWeight: '600' } }, T('注册表项安全备份位置', 'Registry Backup Location')),
              h('div', { class: 'mono small ellipsis', style: { opacity: 0.85, marginTop: '2px' }, title: backupDir }, backupDir)
            ),
            btn('打开备份文件夹', 'Open folder', 'ghost sm', 'folder', () => openPath(backupDir))
          );
          bodyEl.appendChild(backupRow);
        }

        if (failed.length) {
          const failGroup = h('div', { class: 'wizard-group' },
            h('div', { class: 'wizard-group-head', style: { color: 'var(--danger)' } },
              T(`部分项目未能清除 (${failed.length})`, `Items failed to clean (${failed.length})`)
            ),
            h('div', { class: 'wizard-group-list' },
              ...failed.map((f) => h('div', { class: 'wizard-item-row' },
                h('span', { class: 'mono ellipsis', title: f.target || '' }, f.target || ''),
                h('span', { class: 'small', style: { color: 'var(--danger)' } }, f.why || '')
              ))
            )
          );
          bodyEl.appendChild(failGroup);
        }

        footEl.innerHTML = '';
        footEl.appendChild(h('div', { class: 'wizard-foot-left' }, null));
        footEl.appendChild(h('div', { class: 'wizard-foot-right' },
          btn('完成并关闭向导', 'Done & close', 'primary', 'check', () => closeWizard())
        ));
      }

      function goToStep(s) {
        currentStep = s;
        renderHead();
        renderBody();
      }

      function removeAppFromState(targetApp) {
        if (!targetApp) return;
        S.items = S.items.filter((x) => keyOf(x) !== keyOf(targetApp));
        S.store = S.store.filter((x) => keyOf(x) !== keyOf(targetApp));
        GlobalAppsCache.apps = S.items;
        GlobalAppsCache.store = S.store;
        applyFilter();
        renderStatLine();
      }

      renderHead();
      renderBody();
    }

    /* 拓展功能：排查已卸载软件的孤立残留 */
    async function scanOrphanLeftovers() {
      const inputEl = h('input', {
        class: 'input grow',
        type: 'text',
        placeholder: T('输入已卸载软件名（如 百度网盘、WPS、迅雷…）', 'Type uninstalled app name (e.g. BaiduNetdisk, Thunder…)'),
        style: { minWidth: '240px' }
      });

      const commonOrphans = ['百度网盘', '迅雷', '搜狗输入法', 'TeamViewer', 'WPS Office', '鲁大师', '优酷', '爱奇艺'];
      let orphanModal = null;
      function startOrphanScan(name) {
        const q = String(name || inputEl.value).trim();
        if (!q) {
          toast(T('请输入要排查的软件名称', 'Enter an app name to scan'), 'warn');
          return;
        }
        if (orphanModal) orphanModal.close();
        openUninstallWizard({ name: q, _orphan: true }, 'scan');
      }

      const chips = commonOrphans.map((name) =>
        h('button', {
          class: 'chip',
          type: 'button',
          onclick: () => {
            inputEl.value = name;
            startOrphanScan(name);
          }
        }, name)
      );

      orphanModal = modal({
        title: T('排查已卸载软件的孤立残留', 'Scan Orphaned App Traces'),
        wide: true,
        body: h('div', { class: 'stack', style: { gap: '14px' } },
          h('div', { class: 'small muted' },
            T('用于深度清理过去通过其他方式卸载后、遗留在 AppData、ProgramData 或注册表中的陈年孤立残留项。',
              'Detect and purge leftover files/registry keys from previously uninstalled applications.')),
          h('div', { class: 'row', style: { gap: '8px' } },
            inputEl,
            btn('深度排查', 'Deep Scan', 'primary', 'scan', () => startOrphanScan())
          ),
          h('div', { class: 'small muted', style: { marginTop: '4px' } }, T('常见高残留软件快捷排查：', 'Quick candidates:')),
          h('div', { class: 'row wrap', style: { gap: '6px' } }, ...chips)
        ),
        buttons: [{ id: 'close', label: T('关闭', 'Close'), kind: 'ghost' }]
      });
      setTimeout(() => inputEl.focus(), 50);
    }

    /* 第四块不存在：残留内容合并进 loSection，保持顶层 3 块 */

    liveJump = async (payload) => {
      const tab = (payload && payload.tab) || (payload && payload.status ? 'startup' : 'apps');
      switchTab(tab);
      if (tab === 'startup') {
        if (payload && payload.status) {
          const st = String(payload.status).toLowerCase();
          setStartupView(st === 'invalid' ? 'broken' : st);
        }
        if (payload && (payload.filter || payload.name || payload.q)) {
          const kw = String(payload.filter || payload.name || payload.q || '');
          startupFilterInput.value = kw;
          StartupState.filter = kw.trim().toLowerCase();
          applyStartupFilter();
        }
      } else if (tab === 'apps') {
        if (payload && (payload.filter || payload.name || payload.q)) {
          const kw = String(payload.filter || payload.name || payload.q || '');
          filterInput.value = kw;
          S.filter = kw.trim().toLowerCase();
          applyFilter();
        }
      } else if (tab === 'footprint') {
        renderFootprint();
      }
    };

    return function unmount() {
      isMounted = false;
      liveJump = null;
      PerfState.isLive = false;
      stopLiveMonitoring();
      ProcState.isLive = false;
      stopProcLiveMonitoring();
      document.removeEventListener('visibilitychange', onVisChange);
      GlobalAppsCache.activeTab = currentTab;
      GlobalAppsCache.appsFilter = S.filter;
      GlobalAppsCache.appsView = S.view;
      GlobalAppsCache.appsSortBy = S.sortBy;
      GlobalAppsCache.appsSortAsc = S.sortAsc;
      GlobalAppsCache.appsPage = S.page;
      GlobalAppsCache.selectedKey = S.selectedKey;
      GlobalAppsCache.startupFilter = StartupState.filter;
      GlobalAppsCache.startupView = StartupState.view;
      GlobalAppsCache.startupScope = StartupState.scope;
      GlobalAppsCache.startupPage = StartupState.page;
      GlobalAppsCache.procFilter = ProcState.filter;
      GlobalAppsCache.procView = ProcState.view;
      GlobalAppsCache.procPage = ProcState.page;
      GlobalAppsCache.perfSamples = PerfState.samples.slice();
      GlobalAppsCache.perfData = PerfState.perfData;
      if (window.App) window.App._onPageSize = null;
      setActions();
    };
  }

  window.Pages = window.Pages || {};
  window.Pages.apps = {
    title: ['应用与自启', 'Apps & Startup'],
    subtitle: ['全面管理已安装程序、开机自启动项与磁盘空间画像',
      'Manage installed software, startup items, and disk space footprint'],
    mount: mount,
    jump(payload) {
      return liveJump ? liveJump(payload || {}) : undefined;
    }
  };
})();
