/* 卸载程序页：管理员状态条 + 图标列表 + 紧凑表格 + 行内操作 + 右键菜单 + 残留清理 */
(function () {
  'use strict';
  const { h, T, icon, fmtCount, fmtBytes, toast, busy, confirm, card, section, table,
    skeleton, empty, attachMenu, modal, softIn, setActions } = UI;

  let liveJump = null;

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
    b.disabled = on;
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

    const S = {
      items: [],
      store: [],
      storeLoaded: false,
      storeLoading: false,
      filtered: [],
      visible: [],
      filter: '',
      page: 1,
      sortAsc: true,
      sortBy: 'name',
      view: 'all',
      loading: false,
      isAdmin: false,
      uninstalling: false,
      selected: null,
      selectedKey: '',
      leftovers: null,
      leftoverApp: null,
      loSeq: 0,
      checkDirs: new Set(),
      checkRegs: new Set()
    };

    /* ---------------- 顶部：管理员状态 ---------------- */
    const adminBadge = h('span', { class: 'badge' }, T('检查中…', 'Checking…'));
    const adminHint = h('span', { class: 'muted small ellipsis' }, '');
    const btnAdmin = btn('以管理员身份重启', 'Restart as admin', 'ghost sm', 'shield', doRestartAsAdmin);

    const adminBar = h('div', { class: 'admin-strip' },
      icon('shield', 16),
      adminBadge,
      adminHint,
      h('span', { class: 'spacer' }),
      btnAdmin
    );

    /* ---------------- 主卡：过滤 + 统计一行 + 表格 + 分页 ---------------- */
    const filterInput = h('input', {
      class: 'input grow',
      type: 'search',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: T('按名称、发行商或安装路径过滤', 'Filter by name, publisher or install path')
    });
    filterInput.addEventListener('input', () => {
      S.filter = filterInput.value;
      S.page = 1;
      /* 打字时每敲一个键都会重建表格：这时不做逐键淡入，否则整块表格一直在闪 */
      S.typing = true;
      clearTimeout(S.typingTimer);
      S.typingTimer = setTimeout(() => { S.typing = false; }, 400);
      applyFilter();
    });

    const btnRefresh = btn('刷新', 'Refresh', 'ghost', 'refresh', () => loadApps(true));
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
      h('span', { class: 'muted small' }, T('页', '')),
      h('span', { class: 'muted small pg-dot' }, '·'),
      h('span', { class: 'muted small' }, T('共', 'Total')),
      pageSumNum,
      h('span', { class: 'muted small' }, T('项', 'items'))
    );
    const btnPrev = pagerBtn('chevron-left', '上一页', 'Previous', () => gotoPage(S.page - 1));
    const btnNext = pagerBtn('chevron-right', '下一页', 'Next', () => gotoPage(S.page + 1));
    const pagerBar = h('div', { class: 'pager' }, btnPrev, pageWrap, btnNext);

    const statAll = h('span', { class: 'badge' });
    const statMatch = h('span', { class: 'badge accent' });
    const statRemovable = h('span', { class: 'badge ok' });
    const selInfo = h('span', { class: 'muted small ellipsis', style: { maxWidth: '320px' } }, '');
    const statLine = h('div', { class: 'row wrap' },
      statAll, statMatch, statRemovable,
      h('span', { class: 'spacer' }),
      selInfo,
      h('span', { class: 'muted small' }, T('每页', 'Per page')),
      UI.pageSizePick((n) => App.setPageSize(n))
    );

    const tableBox = h('div');
    const actionMsg = h('div', { class: 'small muted ellipsis' });
    actionMsg.hidden = true;

    /* 分类按钮：全部 / 桌面App / 系统App */
    const viewBtns = {};
    function viewBtn(id, zh, en) {
      const b = h('button', { class: 'chip' + (S.view === id ? ' active' : '') }, T(zh, en));
      b.addEventListener('click', () => {
        if (S.view === id) return;
        S.view = id;
        Object.entries(viewBtns).forEach(([k, el]) => el.classList.toggle('active', k === id));
        S.page = 1;
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
      if (S.view === 'store') return S.items.filter((it) => appKind(it) === 'system');
      if (S.view === 'desktop') return S.items.filter((it) => appKind(it) !== 'system').concat(S.store);
      return S.items.concat(S.store);
    }

    function kindTag(it) {
      const k = appKind(it);
      if (k === 'store') return h('span', { class: 'tag store', title: T('微软商店应用', 'Microsoft Store app') }, T('商店', 'Store'));
      if (k === 'system') return h('span', { class: 'tag system', title: T('系统组件', 'System component') }, T('系统', 'System'));
      return null;
    }

    /* 排序：和上面的分类用同一套 chip，替掉原来的下拉框 */
    const sortChips = {};
    function sortChip(id, zh, en) {
      const b = h('button', { class: 'chip' + (S.sortBy === id ? ' active' : ''), type: 'button' }, T(zh, en));
      b.addEventListener('click', () => {
        if (S.sortBy === id) return;
        S.sortBy = id;
        S.page = 1;
        Object.entries(sortChips).forEach(([k, el]) => el.classList.toggle('active', k === id));
        applyFilter();
      });
      sortChips[id] = b;
      return b;
    }

    const mainCard = card(
      h('div', { class: 'card-title' },
        h('h2', null, T('已安装程序', 'Installed programs')),
        h('span', { class: 'hint' },
          T('右键行有更多操作', 'Right-click a row for more'))
      ),
      h('div', { class: 'toolbar' },
        filterInput, btnRefresh,
        h('span', { class: 'spacer' }),
        pagerBar
      ),
      h('div', { class: 'toolbar' },
        h('div', { class: 'seg' },
          viewBtn('all', '全部', 'All'),
          viewBtn('desktop', '桌面App', 'Desktop apps'),
          viewBtn('store', '系统App', 'System apps')
        ),
        h('span', { class: 'spacer' }),
        h('span', { class: 'muted small' }, T('排序', 'Sort')),
        h('div', { class: 'seg' },
          sortChip('name', '名称', 'Name'),
          sortChip('size', '大小', 'Size'),
          sortChip('publisher', '发行商', 'Publisher')
        )
      ),
      statLine,
      tableBox,
      actionMsg
    );

    /* ---------------- 第三块：残留清理（折叠） ---------------- */
    const loSummary = h('div', { class: 'muted small' },
      T('先在上方选中一个程序，再点「扫描残留」', 'Select a program above, then scan for leftovers'));
    const loList = h('div', { class: 'stack' });
    const loResult = h('div', { class: 'stack' });

    const btnRescan = btn('重新扫描', 'Rescan', 'ghost sm', 'refresh', () => scanLeftovers(S.leftoverApp || S.selected));
    const btnCheckAll = btn('全选', 'Select all', 'ghost sm', 'check', () => setAllChecks(true));
    const btnNone = btn('全不选', 'Select none', 'ghost sm', 'close', () => setAllChecks(false));
    const btnCleanup = btn('清理选中', 'Clean selected', 'danger', 'trash', cleanup);
    btnCleanup.disabled = true;

    const loSection = section(T('残留清理', 'Leftovers'),
      h('div', { class: 'stack' },
        loSummary,
        h('div', { class: 'toolbar' }, btnRescan, btnCheckAll, btnNone,
          h('span', { class: 'spacer' }), btnCleanup),
        loList,
        loResult
      ),
      { open: false, hint: T('注册表项清理前会先导出备份', 'Registry keys are backed up before removal') }
    );

    /* ================================================================
       顶级领域分类 Tab 切换器：严格物理隔离【软件本体】/【开机自启动】/【空间画像】
       ================================================================ */
    let currentTab = 'apps';

    function makeTabBtn(id, iconName, zh, en) {
      const b = h('button', {
        class: 'chip' + (currentTab === id ? ' active' : ''),
        type: 'button',
        onclick: () => switchTab(id)
      }, icon(iconName, 13), h('span', null, T(zh, en)));
      return b;
    }

    const tabAppsBtn = makeTabBtn('apps', 'apps', '已安装程序', 'Installed Apps');
    const tabStartupBtn = makeTabBtn('startup', 'spark', '开机自启', 'Startup Apps');
    const tabProcsBtn = makeTabBtn('procs', 'scan', '后台进程', 'Running Procs');
    const tabFootprintBtn = makeTabBtn('footprint', 'chart', '空间画像', 'Space Footprint');

    const topTabBar = h('div', { class: 'toolbar', style: { marginBottom: '4px' } },
      h('div', { class: 'seg' }, tabAppsBtn, tabStartupBtn, tabProcsBtn, tabFootprintBtn),
      h('span', { class: 'spacer' })
    );

    /* 顶栏常驻【问助手】入口（Tab 感知上下文与 SteveAvatar 微动效） */
    const askMark = window.SteveAvatar
      ? window.SteveAvatar.el({ size: 24, variant: 'btn' })
      : icon('spark');
    const topAskBtn = h('button', {
      class: 'btn ghost',
      title: T('让助手分析已安装软件、开机自启与磁盘空间画像', 'Ask AI about apps, startup items, and space footprint')
    }, askMark, T('问助手', 'Ask AI'));
    topAskBtn.onclick = () => {
      if (window.SteveAvatar) {
        window.SteveAvatar.spin(askMark);
      }
      if (!window.AIDrawer) return;
      if (currentTab === 'startup') {
        window.AIDrawer.open({
          title: T('问助手 · 开机自启', 'Ask AI · Startup items'),
          ctx: () => ({
            page: '应用与自启',
            tool: '开机自启动',
            tab: 'startup',
            count: StartupState.items.length,
            note: `共 ${StartupState.items.length} 个自启动项（已启用 ${StartupState.items.filter((i) => i.enabled).length}，失效 ${StartupState.items.filter((i) => !i.exists).length}）`
          })
        });
      } else if (currentTab === 'procs') {
        window.AIDrawer.open({
          title: T('问助手 · 后台进程', 'Ask AI · Running Processes'),
          ctx: () => ({
            page: '应用与自启',
            tool: '后台进程管理',
            tab: 'procs',
            count: ProcState.items.length,
            note: `共 ${ProcState.items.length} 个后台应用 (${ProcState.rawCount} 进程)，物理内存总计 ${fmtSize(ProcState.totalMemory)}`
          })
        });
      } else if (currentTab === 'footprint') {
        const valid = S.items.map((it) => {
          const sz = Number(it.size) || (Number(it.size_kb) ? Number(it.size_kb) * 1024 : 0);
          return Object.assign({}, it, { size: sz });
        }).filter((it) => (it.size || 0) > 0);
        const total = valid.reduce((sum, it) => sum + (it.size || 0), 0);
        window.AIDrawer.open({
          title: T('问助手 · 空间画像', 'Ask AI · Space footprint'),
          ctx: () => ({
            page: '应用与自启',
            tool: '磁盘空间画像',
            tab: 'footprint',
            count: S.items.length,
            size: fmtBytes(total),
            note: `已测算 ${valid.length} 款软件的磁盘空间占用`
          })
        });
      } else {
        window.AIDrawer.open({
          title: T('问助手 · 软件管理', 'Ask AI · Installed apps'),
          ctx: () => ({
            page: '应用与自启',
            tool: '已安装程序',
            tab: 'apps',
            count: S.items.length,
            filter: S.filter,
            note: `共发现 ${S.items.length} 个已安装程序`
          })
        });
      }
    };
    setActions(topAskBtn);

    /* ================================================================
       TAB 2: 开机自启动管理 (Startup Items Governance)
       ================================================================ */
    const StartupState = {
      items: [],
      filtered: [],
      visible: [],
      filter: '',
      view: 'all', // 'all' | 'enabled' | 'disabled' | 'broken'
      page: 1,
      loading: false
    };

    const startupTableBox = h('div', { class: 'table-wrap' });

    const startupFilterInput = h('input', {
      class: 'input grow',
      type: 'search',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: T('按名称、位置或路径过滤…', 'Filter by name, location or path…')
    });
    startupFilterInput.addEventListener('input', () => {
      StartupState.filter = startupFilterInput.value.trim().toLowerCase();
      StartupState.page = 1;
      applyStartupFilter();
    });

    const btnRefreshStartup = btn('刷新', 'Refresh', 'ghost sm', 'refresh', () => loadStartup(true));
    const btnCleanBroken = btn('清理失效项', 'Clean Broken', 'danger sm', 'trash', cleanAllBroken);
    btnCleanBroken.style.display = 'none';

    // 状态分类按钮
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
        h('h2', null, T('开机自启', 'Startup Apps')),
        h('span', { class: 'hint' }, T('管理随系统启动的应用与清理失效残留', 'Manage boot autorun & clean broken entries'))
      ),
      h('div', { class: 'toolbar' },
        startupFilterInput,
        btnRefreshStartup,
        btnCleanBroken,
        h('span', { class: 'spacer' }),
        startupPagerBar
      ),
      h('div', { class: 'toolbar' },
        h('div', { class: 'seg' },
          startupViewBtn('all', '全部', 'All'),
          startupViewBtn('enabled', '已启用', 'Enabled'),
          startupViewBtn('disabled', '已禁用', 'Disabled'),
          startupViewBtn('broken', '⚠️ 失效项', '⚠️ Broken')
        ),
        h('span', { class: 'spacer' })
      ),
      startupStatLine,
      startupTableBox
    );
    startupCard.style.display = 'none';

    async function loadStartup(force) {
      if (StartupState.loading) return;
      StartupState.loading = true;
      startupTableBox.innerHTML = '';
      startupTableBox.appendChild(skeleton(6, 'apps'));
      try {
        const res = await API.engine('startup.list', { refresh: !!force });
        StartupState.items = Array.isArray(res && res.items) ? res.items : [];
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
          body: T(`${actionName || '此操作'}涉及系统级（HKLM）注册表或系统启动目录，需要以管理员身份运行才能修改。\n\n是否立即以管理员身份重启整理助手？`,
            `${actionName || 'This action'} modifies system-level (HKLM) registry or system startup folders, requiring administrator privileges.\n\nRestart TidyAssistant as Administrator now?`),
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
              const ic = it.exe_path && it.exists ? iconUrl(it.exe_path) : '';
              const iconEl = ic
                ? h('img', { class: 'app-icon', src: ic, alt: '', loading: 'lazy' })
                : letterBlock(it);
              const sourceTag = it.source_type === 'folder'
                ? h('span', { class: 'tag store', title: T('开机启动文件夹', 'Startup folder') }, T('文件夹', 'Folder'))
                : h('span', { class: 'tag system', title: T('Windows 注册表', 'Windows registry') }, T('注册表', 'Registry'));
              return h('div', { class: 'name' },
                iconEl,
                h('span', { class: 'txt ellipsis', style: { minWidth: '0' }, title: it.name }, it.name || '—'),
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
          ? T(`已成功清理 ${cleaned} 项失效项，其余 ${denied} 项位于系统级（HKLM）注册表，需要管理员权限。\n\n是否以管理员身份重启整理助手继续清理？`,
              `Cleaned ${cleaned} items. Remaining ${denied} items are in HKLM registry.\n\nRestart as admin to clean?`)
          : T(`清理失败：${denied} 项失效项属于系统级（HKLM）注册表，需要管理员权限。\n\n是否以管理员身份重启整理助手？`,
              `Failed: ${denied} items are in HKLM registry.\n\nRestart as admin?`);
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
      items: [],
      filtered: [],
      visible: [],
      view: 'all', // 'all' | 'apps' | 'system'
      filter: '',
      page: 1,
      loading: false,
      totalMemory: 0,
      rawCount: 0
    };

    const procFilterInput = h('input', {
      class: 'input grow',
      type: 'search',
      spellcheck: 'false',
      placeholder: T('搜索进程名、路径或应用…', 'Search process name, path or app…')
    });
    procFilterInput.addEventListener('input', () => {
      ProcState.filter = procFilterInput.value.trim().toLowerCase();
      ProcState.page = 1;
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
      btnRefreshProc,
      h('span', { class: 'spacer' }),
      procPagerBar
    );

    const procToolbar2 = h('div', { class: 'row wrap', style: { gap: '8px', alignItems: 'center', marginTop: '6px' } },
      statProcAll, statProcApps, statProcSys, statProcMem,
      h('span', { class: 'spacer' }),
      procPagePicker
    );

    const procVisualBox = h('div', { class: 'proc-visual', style: { marginBottom: '12px' } });
    const procTableBox = h('div', { class: 'table-wrap' });

    const procsCard = card(
      h('div', { class: 'card-title' },
        h('h2', null, T('后台进程管理', 'Running Processes')),
        h('span', { class: 'hint' }, T('实时快照 · 优雅通知释放 · 严禁系统误杀 · 0% 闲置后台负载', 'Instant snapshot, safe shutdown, zero idle CPU'))
      ),
      procVisualBox,
      procToolbar1,
      procToolbar2,
      procTableBox
    );
    procsCard.style.display = 'none';

    async function loadProcs(force) {
      if (ProcState.loading) return;
      ProcState.loading = true;
      procTableBox.innerHTML = '';
      const spinner = h('div', { class: 'center text-muted', style: { padding: '32px' } }, icon('refresh', 20), h('span', { style: { marginLeft: '8px' } }, T('正在生成进程快照…', 'Snapshotting processes…')));
      procTableBox.appendChild(spinner);
      try {
        const res = await API.engine('process.list', { aggregate: true });
        ProcState.items = Array.isArray(res && res.items) ? res.items : [];
        ProcState.totalMemory = Number(res && res.total_memory) || 0;
        ProcState.rawCount = Number(res && res.raw_count) || ProcState.items.length;
        ProcState.page = 1;
        applyProcFilter();
        renderProcVisual();
      } catch (err) {
        procTableBox.innerHTML = '';
        procTableBox.appendChild(empty(T('读取进程列表失败', 'Failed to read processes'), (err && err.message) || String(err)));
      } finally {
        ProcState.loading = false;
      }
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
        mem: p.memory || 0,
        pct: ProcState.totalMemory ? (p.memory || 0) / ProcState.totalMemory : 0
      }));
      if (otherMem > 0) {
        slices.push({
          name: T('其他进程', 'Other processes'),
          mem: otherMem,
          pct: ProcState.totalMemory ? otherMem / ProcState.totalMemory : 0
        });
      }

      const palette = [
        'var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)',
        'var(--chart-4)', 'var(--chart-5)', 'var(--chart-6)'
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

      const svgHtml = `
        <svg viewBox="0 0 130 130" width="100" height="100" style="transform: rotate(-90deg); display: block; flex-shrink: 0;">
          <circle cx="65" cy="65" r="${r}" fill="none" stroke="var(--line)" stroke-width="16" />
          ${paths}
        </svg>
      `;

      const chartWrap = h('div', {
        class: 'row wrap',
        style: {
          alignItems: 'center',
          gap: '20px',
          padding: '12px 16px',
          background: 'var(--surface-2)',
          borderRadius: 'var(--radius)',
          border: '1px solid var(--line)',
          marginBottom: '8px'
        }
      });
      const svgContainer = h('div', { style: { position: 'relative', width: '100px', height: '100px', flexShrink: 0 } });
      svgContainer.innerHTML = svgHtml;

      const legend = h('div', { class: 'row wrap grow', style: { gap: '10px 20px', alignItems: 'center' } });
      slices.forEach((s, idx) => {
        const color = palette[idx % palette.length];
        const item = h('div', { class: 'row', style: { alignItems: 'center', gap: '6px', fontSize: '12px', minWidth: '140px' } },
          h('span', { style: { width: '8px', height: '8px', borderRadius: '50%', background: color, flexShrink: 0 } }),
          h('span', { class: 'ellipsis', style: { maxWidth: '120px', color: 'var(--text-1)' }, title: s.name }, s.name),
          h('span', { style: { color: 'var(--text-3)', fontVariantNumeric: 'tabular-nums' } }, fmtSize(s.mem))
        );
        legend.appendChild(item);
      });

      chartWrap.appendChild(svgContainer);
      chartWrap.appendChild(legend);
      procVisualBox.appendChild(chartWrap);
    }

    async function closeProcOne(it, force) {
      if (!it) return;
      if (it.is_system) {
        toast(T('系统核心组件受保护，禁止关闭', 'System component is protected'), 'warn');
        return;
      }
      try {
        const r = await API.engine('process.close', {
          name: it.clean_name,
          force: !!force,
          confirm_sensitive: false
        });
        if (r && r.need_confirm) {
          const ok = await UI.confirm(
            T('敏感数据应用提示', 'Sensitive App Warning'),
            r.warning + '\n\n' + T('确定要强制关闭该进程吗？', 'Are you sure you want to close it?')
          );
          if (!ok) return;
          await API.engine('process.close', {
            name: it.clean_name,
            force: true,
            confirm_sensitive: true
          });
        }
        toast(T(`已关闭进程【${it.name}】`, `Closed process [${it.name}]`), 'ok');
        loadProcs(true);
      } catch (err) {
        toast(T('关闭进程失败：', 'Failed to close process: ') + ((err && err.message) || String(err)), 'error');
      }
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
          title: T('应用与进程', 'App & Process'),
          render: (it) => {
            const iconEl = it.exe_path ? appIcon(it.exe_path, it.name) : letterBlock(it);
            const countTag = it.process_count > 1
              ? h('span', { class: 'badge', style: { marginLeft: '6px' } }, `${it.process_count} 进程`)
              : (it.pids && it.pids.length ? h('span', { class: 'badge neutral', style: { marginLeft: '6px' } }, `PID ${it.pids[0]}`) : null);

            return h('div', { class: 'name' },
              iconEl,
              h('div', { class: 'txt' },
                h('div', { class: 'ellipsis', title: it.exe_path || it.name, style: { fontWeight: '500' } }, it.name),
                it.exe_path ? h('div', { class: 'hint ellipsis', style: { fontSize: '11px' }, title: it.exe_path }, it.exe_path) : null
              ),
              countTag
            );
          }
        },
        {
          key: 'memory',
          title: T('占用内存', 'Memory'),
          width: '140px',
          render: (it) => {
            const memText = fmtSize(it.memory);
            const maxMem = 500 * 1024 * 1024; // 500MB scale
            const pct = Math.min(100, Math.max(3, Math.round((it.memory / maxMem) * 100)));
            const isHigh = it.memory > 400 * 1024 * 1024;
            return h('div', { style: { minWidth: '100px' } },
              h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '12px', fontVariantNumeric: 'tabular-nums' } },
                h('span', { style: { fontWeight: isHigh ? '600' : 'normal', color: isHigh ? 'var(--warn)' : 'inherit' } }, memText)
              ),
              h('div', { style: { height: '4px', background: 'var(--line)', borderRadius: '2px', overflow: 'hidden', marginTop: '3px' } },
                h('div', { style: { width: `${pct}%`, height: '100%', background: isHigh ? 'var(--warn)' : 'var(--accent)' } })
              )
            );
          }
        },
        {
          key: 'threads',
          title: T('线程', 'Threads'),
          width: '70px',
          render: (it) => h('span', { class: 'num' }, String(it.threads || 1))
        },
        {
          key: 'type',
          title: T('属性', 'Type'),
          width: '90px',
          render: (it) => {
            if (it.is_system) {
              return h('span', { class: 'badge neutral' }, T('系统保护', 'System'));
            }
            return h('span', { class: 'badge ok' }, T('后台应用', 'App'));
          }
        },
        {
          key: 'actions',
          title: T('操作', 'Actions'),
          width: '130px',
          render: (it) => {
            const bClose = btn('结束', 'Kill', 'danger sm', 'power', () => closeProcOne(it, false));
            if (it.is_system) {
              bClose.disabled = true;
              bClose.title = T('系统核心保护进程不可关闭', 'System process is protected');
            }
            const bFolder = iconBtn('folder', '打开文件位置', () => {
              if (it.exe_path) openPath(it.exe_path);
            });
            if (!it.exe_path) bFolder.disabled = true;

            return h('div', { class: 'row', style: { gap: '4px' } }, bClose, bFolder);
          }
        }
      ];

      const tbl = UI.table({
        columns,
        rows: ProcState.visible,
        rowKey: (row, i) => String(i)
      });
      procTableBox.appendChild(tbl);
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
      perfData: null,
      samples: [],
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
        h('span', { class: 'hint' }, T('全盘存储水位 · 实时资源走势 · 空间与内存占用大户治理', 'Partitions, live trend charts & consumer governance')),
        h('span', { class: 'spacer' }),
        livePerfBadge,
        btnPerfRefresh
      ),
      h('div', { class: 'footprint-body', style: { display: 'flex', flexDirection: 'column', gap: '16px' } })
    );
    footprintCard.style.display = 'none';

    async function fetchPerfSample(force) {
      if ((!PerfState.isLive && !force) || currentTab !== 'footprint') return;
      try {
        const data = await API.engine('system.performance', {});
        if (!data) return;
        PerfState.perfData = data;
        const now = new Date();
        const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
        const memPct = Number(data.memory && data.memory.percent) || 0;
        const cpuPct = Number(data.cpu && data.cpu.percent) || 0;
        PerfState.samples.push({
          time: timeStr,
          memPct,
          cpuPct,
          timestamp: Date.now()
        });
        if (PerfState.samples.length > 30) {
          PerfState.samples.shift();
        }
        updateFootprintLiveView();
      } catch (err) {
        // 静默单次采样失败
      }
    }

    function startLiveMonitoring() {
      if (PerfState.liveTimer) return;
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

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        stopLiveMonitoring();
      } else if (currentTab === 'footprint' && PerfState.isLive) {
        startLiveMonitoring();
      }
    });

    function buildTrendSvgHtml(samples) {
      const W = 600;
      const H = 90;
      const padTop = 10;
      const padBottom = 16;
      const plotH = H - padTop - padBottom;

      const count = samples.length;
      if (count === 0) {
        return `
          <svg viewBox="0 0 ${W} ${H}" width="100%" height="90" style="display: block;">
            <line x1="0" y1="${padTop + plotH}" x2="${W}" y2="${padTop + plotH}" stroke="var(--line)" stroke-width="1" />
            <text x="${W / 2}" y="${H / 2}" fill="var(--text-3)" font-size="12" text-anchor="middle">正在采集实时性能样本…</text>
          </svg>
        `;
      }

      const getX = (i) => {
        if (count <= 1) return W / 2;
        return (i / (count - 1)) * (W - 24) + 12;
      };
      const getY = (val) => padTop + (1.0 - Math.min(100, Math.max(0, val)) / 100) * plotH;

      const memPoints = samples.map((s, i) => `${getX(i).toFixed(1)},${getY(s.memPct).toFixed(1)}`);
      const cpuPoints = samples.map((s, i) => `${getX(i).toFixed(1)},${getY(s.cpuPct).toFixed(1)}`);

      const firstX = getX(0).toFixed(1);
      const lastX = getX(count - 1).toFixed(1);
      const baseH = (padTop + plotH).toFixed(1);

      const memLineD = `M ${memPoints.join(' L ')}`;
      const memAreaD = `M ${firstX},${baseH} L ${memPoints.join(' L ')} L ${lastX},${baseH} Z`;
      const cpuLineD = `M ${cpuPoints.join(' L ')}`;

      const latestSample = samples[count - 1];
      const lastMemX = getX(count - 1).toFixed(1);
      const lastMemY = getY(latestSample.memPct).toFixed(1);
      const lastCpuY = getY(latestSample.cpuPct).toFixed(1);

      return `
        <svg viewBox="0 0 ${W} ${H}" width="100%" height="90" preserveAspectRatio="none" style="display: block; overflow: visible;">
          <defs>
            <linearGradient id="tidyMemGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="var(--chart-1)" stop-opacity="0.25" />
              <stop offset="100%" stop-color="var(--chart-1)" stop-opacity="0.0" />
            </linearGradient>
            <linearGradient id="tidyCpuGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="var(--chart-2)" stop-opacity="0.18" />
              <stop offset="100%" stop-color="var(--chart-2)" stop-opacity="0.0" />
            </linearGradient>
          </defs>
          <line x1="0" y1="${padTop}" x2="${W}" y2="${padTop}" stroke="var(--line)" stroke-dasharray="3 3" opacity="0.6" />
          <line x1="0" y1="${padTop + plotH * 0.5}" x2="${W}" y2="${padTop + plotH * 0.5}" stroke="var(--line)" stroke-dasharray="3 3" opacity="0.6" />
          <line x1="0" y1="${baseH}" x2="${W}" y2="${baseH}" stroke="var(--line)" opacity="0.9" />

          <path d="${memAreaD}" fill="url(#tidyMemGrad)" />
          <path d="${memLineD}" fill="none" stroke="var(--chart-1)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />

          <path d="${cpuLineD}" fill="none" stroke="var(--chart-2)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" opacity="0.95" />

          <circle cx="${lastMemX}" cy="${lastMemY}" r="3.5" fill="var(--chart-1)" stroke="var(--surface)" stroke-width="1.5" />
          <circle cx="${lastMemX}" cy="${lastCpuY}" r="3.5" fill="var(--chart-2)" stroke="var(--surface)" stroke-width="1.5" />
        </svg>
      `;
    }

    function updateFootprintLiveView() {
      const container = footprintCard.querySelector('.footprint-body');
      if (!container || !PerfState.perfData) return;

      const p = PerfState.perfData;
      const mem = p.memory || {};
      const cpu = p.cpu || {};
      const disk = p.disk_summary || {};

      const elMemVal = container.querySelector('#fp-kpi-mem-val');
      const elMemBar = container.querySelector('#fp-kpi-mem-bar');
      const elCpuVal = container.querySelector('#fp-kpi-cpu-val');
      const elCpuBar = container.querySelector('#fp-kpi-cpu-bar');
      const elTrendSvg = container.querySelector('#fp-trend-svg-box');
      const elTrendLegMem = container.querySelector('#fp-trend-leg-mem');
      const elTrendLegCpu = container.querySelector('#fp-trend-leg-cpu');

      if (elMemVal) elMemVal.textContent = (mem.percent || 0) + '%';
      if (elMemBar) elMemBar.style.width = Math.min(100, Math.max(0, mem.percent || 0)) + '%';
      if (elCpuVal) elCpuVal.textContent = (cpu.percent || 0).toFixed(1) + '%';
      if (elCpuBar) elCpuBar.style.width = Math.min(100, Math.max(0, cpu.percent || 0)) + '%';
      if (elTrendSvg) elTrendSvg.innerHTML = buildTrendSvgHtml(PerfState.samples);
      if (elTrendLegMem) elTrendLegMem.textContent = T('物理内存', 'RAM') + ': ' + (mem.percent || 0) + '%';
      if (elTrendLegCpu) elTrendLegCpu.textContent = 'CPU: ' + (cpu.percent || 0).toFixed(1) + '%';
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
      const kpiRow = h('div', {
        style: {
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
          gap: '12px'
        }
      });

      function createKpiCard(iconName, title, valId, valText, barId, barPct, barColor, subText, footText) {
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
            margin: '6px 0'
          }
        }, barFill);

        return h('div', {
          style: {
            padding: '12px 14px',
            background: 'var(--surface-2)',
            border: '1px solid var(--line)',
            borderRadius: 'var(--radius)'
          }
        },
          h('div', { class: 'row', style: { alignItems: 'center', gap: '6px', color: 'var(--text-3)', fontSize: '12px' } },
            icon(iconName, 14),
            h('span', null, title)
          ),
          h('div', {
            id: valId,
            style: {
              fontSize: '22px',
              fontWeight: '700',
              fontFamily: 'var(--mono)',
              color: 'var(--text-1)',
              margin: '4px 0 2px 0'
            }
          }, valText),
          barTrack,
          h('div', { class: 'row', style: { justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-3)' } },
            h('span', null, subText),
            h('span', { style: { fontFamily: 'var(--mono)' } }, footText)
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
        fmtBytes(mem.used || 0) + ' / ' + fmtBytes(mem.total || 0),
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
        (cpu.cores || 1) + T(' 个逻辑处理器', ' Cores'),
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
        `已统计 ${valid.length} 款软件`,
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
        `已用 ${fmtBytes(disk.used || 0)} (${disk.percent || 0}%)`,
        `跨 ${drives.length} 分区 · 余 ${fmtBytes(disk.free || 0)}`
      );

      kpiRow.appendChild(cardMem);
      kpiRow.appendChild(cardCpu);
      kpiRow.appendChild(cardApps);
      kpiRow.appendChild(cardDisk);
      container.appendChild(kpiRow);

      /* ================= SECTION 2: 实时性能动态走势折线图 ================= */
      const trendWrap = h('div', {
        style: {
          padding: '12px 16px',
          background: 'var(--surface-2)',
          border: '1px solid var(--line)',
          borderRadius: 'var(--radius)'
        }
      });

      const trendHeader = h('div', {
        class: 'row',
        style: { alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }
      },
        h('strong', { style: { fontSize: '13px', color: 'var(--text-1)' } }, T('实时性能与内存动态走势', 'Live Performance & Resource Trends')),
        h('div', { class: 'row', style: { gap: '16px', fontSize: '12px' } },
          h('span', { class: 'row', style: { alignItems: 'center', gap: '6px' } },
            h('span', { style: { width: '8px', height: '8px', borderRadius: '50%', background: 'var(--chart-1)' } }),
            h('span', { id: 'fp-trend-leg-mem', style: { color: 'var(--text-2)', fontFamily: 'var(--mono)' } },
              T('物理内存', 'RAM') + ': ' + (mem.percent || 0) + '%'
            )
          ),
          h('span', { class: 'row', style: { alignItems: 'center', gap: '6px' } },
            h('span', { style: { width: '8px', height: '8px', borderRadius: '50%', background: 'var(--chart-2)' } }),
            h('span', { id: 'fp-trend-leg-cpu', style: { color: 'var(--text-2)', fontFamily: 'var(--mono)' } },
              'CPU: ' + (cpu.percent || 0).toFixed(1) + '%'
            )
          )
        )
      );

      const trendSvgBox = h('div', { id: 'fp-trend-svg-box', style: { width: '100%', height: '90px' } });
      trendSvgBox.innerHTML = buildTrendSvgHtml(PerfState.samples);

      const trendTimeAxis = h('div', {
        class: 'row',
        style: { justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-3)', marginTop: '4px' }
      },
        h('span', null, '-45s'),
        h('span', null, '-30s'),
        h('span', null, '-15s'),
        h('span', null, T('当前 (实时采样)', 'Now (Live)'))
      );

      trendWrap.appendChild(trendHeader);
      trendWrap.appendChild(trendSvgBox);
      trendWrap.appendChild(trendTimeAxis);
      container.appendChild(trendWrap);

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
          gap: '16px'
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
      tabAppsBtn.className = 'chip' + (tab === 'apps' ? ' active' : '');
      tabStartupBtn.className = 'chip' + (tab === 'startup' ? ' active' : '');
      tabProcsBtn.className = 'chip' + (tab === 'procs' ? ' active' : '');
      tabFootprintBtn.className = 'chip' + (tab === 'footprint' ? ' active' : '');

      adminBar.style.display = (tab === 'apps' || tab === 'startup') ? '' : 'none';
      mainCard.style.display = tab === 'apps' ? '' : 'none';
      loSection.style.display = tab === 'apps' ? '' : 'none';
      startupCard.style.display = tab === 'startup' ? '' : 'none';
      procsCard.style.display = tab === 'procs' ? '' : 'none';
      footprintCard.style.display = tab === 'footprint' ? '' : 'none';

      if (tab === 'footprint') {
        startLiveMonitoring();
      } else {
        stopLiveMonitoring();
      }

      if (tab === 'startup' && !StartupState.items.length) {
        loadStartup(false);
      } else if (tab === 'procs' && !ProcState.items.length) {
        loadProcs(false);
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
    root.appendChild(loSection);
    root.appendChild(startupCard);
    root.appendChild(procsCard);
    root.appendChild(footprintCard);

    /* 右键菜单：对齐 Geek Uninstaller 的完整动作集 */
    attachMenu(tableBox, (e) => {
      const tr = e.target.closest('tbody tr[data-key]');
      if (tr) {
        const it = S.visible[Number(tr.dataset.key)];
        if (!it) return [];
        // Appx 应用只有「卸载 / 打开目录 / 复制」这几件事可做
        if (it.source === 'store') {
          return [
            { header: it.name || '' },
            { label: T('卸载应用', 'Uninstall app'), icon: 'trash',
              danger: true, action: () => uninstallOne(it) },
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
          { label: T('卸载（系统卸载器）', 'Uninstall (system uninstaller)'), icon: 'trash',
            danger: true, disabled: !it.uninstall, action: () => uninstallOne(it) },
          { label: T('强制删除（目录 + 注册表）', 'Force remove (files + registry)'), icon: 'trash',
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
          { label: T('扫描残留', 'Scan leftovers'), icon: 'scan', action: () => scanLeftovers(it) },
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

    renderStatLine();
    renderPager();
    renderTable();
    /* 每页条数改了：就地重排当前表格，不重建页面 */
    App._onPageSize = () => {
      PAGE_SIZE = UI.pageSize();
      S.page = 1;
      applyFilter();
    };
    // 先让页面壳完成一帧绘制，再发数据请求：切页动画不被读取列表拖住。
    // 引擎调用已搬到后台线程，这里只是把首帧让给动画。
    requestAnimationFrame(() => {
      refreshAdmin();
      loadApps(false).catch(() => {});
      // 空闲时预热商店列表：等用户点到「商店App」时数据通常已就绪，切换就是瞬时的
      setTimeout(() => {
        ensureStore().then(() => {
          if (!S.filter && (S.view === 'store' || S.view === 'all')) applyFilter();
        }).catch(() => {});
      }, 900);
    });

    /* ---------------- 管理员 ---------------- */
    async function refreshAdmin() {
      try {
        S.isAdmin = !!(await API.isAdmin());
      } catch (e) {
        S.isAdmin = false;
      }
      // API.isAdmin 失败按普通权限处理，不影响列表使用
      adminBadge.className = 'badge ' + (S.isAdmin ? 'ok' : 'warn');
      adminBadge.textContent = S.isAdmin ? T('当前为管理员', 'Administrator') : T('普通权限', 'Standard user');
      adminHint.textContent = S.isAdmin
        ? T('需要提升权限的卸载器可以直接启动', 'Elevated uninstallers can start directly')
        : T('部分卸载器需要提升权限，可用右侧按钮重启', 'Some uninstallers need elevation; use the button at right');
      btnAdmin.hidden = S.isAdmin;
    }

    async function doRestartAsAdmin() {
      btnAdmin.disabled = true;
      try {
        await API.runAsAdmin();
        toast(T('已请求管理员权限，应用会重启，请在系统弹窗里确认',
          'Elevation requested. The app will restart; confirm the system prompt'), 'ok', 6000);
      } catch (e) {
        toast(errText(e), 'error');
      } finally {
        btnAdmin.disabled = false;
      }
    }

    /* ---------------- 数据 ---------------- */
    async function loadApps(loud) {
      if (S.loading) return;
      S.loading = true;
      setBtnBusy(btnRefresh, true, '读取中…', 'Loading…');
      tableBox.replaceChildren(skeleton(8, 'apps'));
      try {
        const r = await API.engine('apps.list', {});
        S.items = Array.isArray(r.items) ? r.items : [];
        const keep = S.selectedKey;
        S.selected = S.items.find((a) => keyOf(a) === keep) || null;
        S.selectedKey = S.selected ? keep : '';
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
          return (Number(b.size_kb) || 0) - (Number(a.size_kb) || 0);
        }
        const field = S.sortBy === 'publisher' ? 'publisher' : 'name';
        const c = collator.compare(String(a[field] || ''), String(b[field] || ''));
        return S.sortAsc ? c : -c;
      });
      let list = base;
      S.filtered = q
        ? list.filter((a) => [a.name, a.publisher, a.install_path, a.version]
          .some((v) => String(v || '').toLowerCase().includes(q)))
        : list;
      const pages = Math.max(1, Math.ceil(S.filtered.length / PAGE_SIZE));
      S.page = Math.min(Math.max(1, S.page), pages);
      renderTable();
      renderStatLine();
      renderPager();
    }

    function toggleSort() {
      S.sortAsc = !S.sortAsc;
      S.page = 1;
      applyFilter();
    }

    function renderStatLine() {
      const total = S.items.length + S.store.length;
      statAll.textContent = T('已安装 ', 'Installed ') + fmtCount(total);
      statMatch.textContent = T('当前匹配 ', 'Matching ') + fmtCount(S.filtered.length);
      statRemovable.textContent = T('可卸载 ', 'Removable ') +
        fmtCount(S.filtered.filter((a) => a.uninstall).length);
      selInfo.textContent = S.selected
        ? T('当前 ', 'Selected ') + (S.selected.name || '') +
          (S.selected.version ? ' ' + S.selected.version : '')
        : T('未选择程序', 'No program selected');
      selInfo.title = selInfo.textContent;
    }

    function renderTable() {
      // 刷新期间保留旧表，别先闪成空白再等加载
      if (S.loading && tableBox.querySelector('table')) return;
      tableBox.innerHTML = '';
      if (S.loading) return;
      if (!allItems().length) {
        tableBox.appendChild(empty(T('没有读取到已安装程序', 'No installed programs found'),
          S.view === 'store'
            ? T('切换「全部」或「桌面App」看看', 'Try All or Desktop apps')
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
        columns: [
          {
            key: 'name',
            label: T('名称 / 版本', 'Name / version'),
            width: '32%',
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
            key: 'publisher',
            label: T('发行商', 'Publisher'),
            width: '16%',
            render: (a) => h('div', { class: 'ellipsis', title: a.publisher || '' },
              a.publisher || '—')
          },
          {
            key: 'install_path',
            label: T('安装路径', 'Install path'),
            render: (a) => h('div', { class: 'mono ellipsis', title: a.install_path || '' },
              a.install_path || '—')
          },
          {
            key: 'ops',
            label: T('操作', 'Actions'),
            width: '104px',
            align: 'right',
            render: (a) => h('div', { class: 'row', style: { justifyContent: 'flex-end' } },
              (() => {
                const b = iconBtn('卸载', a.uninstall ? 'Uninstall' : 'No uninstaller', 'trash',
                  () => { select(a); uninstallOne(a); }, true);
                if (!a.uninstall) { b.disabled = true; b.title = T('没有可用的卸载程序', 'No uninstaller available'); }
                return b;
              })(),
              a.source === 'store' ? null
                : iconBtn('扫描残留', 'Scan leftovers', 'scan', () => { select(a); scanLeftovers(a); }),
              iconBtn('打开安装目录', 'Open install folder', 'folder', () => openInstallDir(a))
            )
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

    /* 图标：icon 是注册表里的路径；没有图标或加载失败时，用「首字母 + 色块」兜底，
       保证每一行左侧都有一致的视觉锚点，不会出现空白格子。 */
    function letterBlock(a) {
      const name = String((a && a.name) || '?').trim();
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
      let url;
      if (a && typeof a === 'object') {
        if (iconCache.has(a)) url = iconCache.get(a);
        else { url = iconUrl(a.icon); iconCache.set(a, url); }
      } else {
        url = iconUrl(a && a.icon);
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
          if (a && typeof a === 'object') a.__iconEl = fb;
          img.replaceWith(fb);
        });
        node = img;
      }
      if (a && typeof a === 'object') a.__iconEl = node;
      return node;
    }

    /* 图标按页补：列表先出（apps.list 不再现场抠图），这一页的图标
       再分小批问引擎要，到一批换一批，不阻塞表格。 */
    let iconSeq = 0;
    async function hydrateIcons(items) {
      const seq = ++iconSeq;
      const need = [];
      items.forEach((a) => {
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
          return;   // 取不到就保留首字母兜底，不打扰用户
        }
        if (seq !== iconSeq) return;   // 换页 / 换视图了，这轮作废
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

    /* ---------------- 卸载 / 强制删除 / 删条目 / 注册表 / 官网 ---------------- */
    async function uninstallOne(it) {
      if (!it) return;
      if (it.source === 'store') {
        const yes = await confirm({
          title: T('卸载应用', 'Uninstall app'),
          body: T('将卸载「' + it.name + '」（Microsoft Store 应用，仅当前用户）。',
            'Uninstall "' + it.name + '" for the current user only.'),
          ok: T('卸载', 'Uninstall'),
          danger: true
        });
        if (!yes) return;
        try {
          await API.removeStoreApp(it.package, true);
          toast(T('已卸载：', 'Uninstalled: ') + it.name, 'ok');
          S.store = [];
          S.storeLoaded = false;
          await ensureStore();
          applyFilter();
        } catch (e) {
          toast(errText(e), 'error');
        }
        return;
      }
      if (!it.uninstall_cmd && !it.quiet_cmd) {
        toast(T('这个程序没有自带卸载器，可用「强制删除」', 'No uninstaller; use Force remove'), 'warn');
        return;
      }
      const yes = await confirm({
        title: T('卸载程序', 'Uninstall program'),
        body: T('将启动「' + it.name + '」自带的卸载程序，请在弹出的窗口里完成卸载。',
          'The uninstaller for "' + it.name + '" will start; finish it in its own window.'),
        ok: T('启动卸载程序', 'Launch uninstaller'),
        danger: true
      });
      if (!yes) return;
      if (S.uninstalling) return;
      S.uninstalling = true;
      try {
        const r = await API.engine('apps.uninstall', {
          name: it.name, version: it.version || '', confirm: true, mode: 'auto'
        });
        actionMsg.hidden = false;
        actionMsg.textContent = T('已启动卸载程序：', 'Uninstaller started: ') + (it.name || '');
        toast(r && r.started === false
          ? T('卸载器没能启动，试试「强制删除」', 'Uninstaller failed to start; try Force remove')
          : T('已启动系统卸载程序', 'System uninstaller started'), 'ok');
      } catch (e) {
        toast(errText(e), 'error');
      } finally {
        S.uninstalling = false;
      }
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
      if (!res) return; // busy 吞了异常时别再报「已删除」
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
      try {
        await API.engine('apps.delete_entry', {
          name: it.name, version: it.version || '', confirm: true
        });
        toast(T('已删除注册表条目', 'Registry entry deleted'), 'ok');
        await loadApps(false);
      } catch (e) {
        toast(errText(e), 'error');
      }
    }

    async function showRegistry(it) {
      if (!it) return;
      try {
        const r = await API.engine('apps.registry', {
          name: it.name, version: it.version || ''
        });
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
      } catch (e) {
        toast(errText(e), 'error');
      }
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

    /* ---------------- 残留 ---------------- */
    async function scanLeftovers(itArg) {
      const it = itArg || S.selected;
      if (!it) {
        toast(T('请先选择一个程序', 'Select a program first'), 'warn');
        return;
      }
      const mySeq = ++S.loSeq;
      loSection.classList.add('open');
      setBtnBusy(btnRescan, true, '扫描中…', 'Scanning…');
      loSummary.textContent = T('正在扫描「' + it.name + '」的安装目录与注册表…',
        'Scanning install folders and registry for "' + it.name + '"…');
      loList.replaceChildren(skeleton(4, 'apps'));
      loResult.innerHTML = '';
      try {
        const r = await API.engine('apps.leftovers', {
          name: it.name,
          version: it.version || ''
        });
        if (mySeq !== S.loSeq) return; // 慢响应回来时用户已换目标，别覆盖新面板
        S.leftovers = r || { name: it.name, dirs: [], regs: [], blocked: [] };
        S.leftoverApp = it;
        // 默认不勾：残留目录里可能有仍在用的配置，全选等于一键全删。
        S.checkDirs = new Set();
        S.checkRegs = new Set();
        renderLeftovers();
      } catch (e) {
        if (mySeq !== S.loSeq) return;
        S.leftovers = null;
        S.leftoverApp = it;
        loSummary.textContent = '';
        loList.replaceChildren(empty(T('扫描失败', 'Scan failed'), errText(e)));
        btnCleanup.disabled = true;
        toast(errText(e), 'error');
      } finally {
        setBtnBusy(btnRescan, false);
      }
    }

    function renderLeftovers() {
      loList.innerHTML = '';
      refreshCleanupBtn();
      const L = S.leftovers;
      if (!L) {
        loList.appendChild(empty(T('尚未扫描', 'Not scanned yet'),
          T('选中程序后点「扫描残留」', 'Select a program and scan for leftovers')));
        return;
      }
      const dirs = Array.isArray(L.dirs) ? L.dirs : [];
      const regs = Array.isArray(L.regs) ? L.regs : [];
      const blocked = Array.isArray(L.blocked) ? L.blocked : [];
      const name = L.name || (S.leftoverApp && S.leftoverApp.name) || '';

      if (!dirs.length && !regs.length) {
        loSummary.textContent = name;
        loList.appendChild(empty(T('没有发现残留', 'No leftovers found'),
          T('这个程序的安装目录与注册表项已清理干净', 'Nothing left behind by this program')));
        return;
      }

      loSummary.textContent = T(
        name + '：发现 ' + fmtCount(dirs.length) + ' 个目录、' + fmtCount(regs.length) + ' 个注册表项' +
        (blocked.length ? '，' + fmtCount(blocked.length) + ' 项被占用' : ''),
        name + ': ' + fmtCount(dirs.length) + ' folder(s), ' + fmtCount(regs.length) +
        ' registry key(s)' + (blocked.length ? ', ' + fmtCount(blocked.length) + ' in use' : ''));

      if (dirs.length) {
        loList.appendChild(h('div', { class: 'stack' },
          h('div', { class: 'small muted' }, T('目录', 'Folders')),
          h('div', { class: 'list' }, ...dirs.map((d, i) => h('div', { class: 'list-item' },
            h('label', { class: 'check', style: { flex: '1', minWidth: '0' } },
              h('input', {
                type: 'checkbox',
                checked: S.checkDirs.has(i),
                onchange: (e) => {
                  if (e.target.checked) S.checkDirs.add(i);
                  else S.checkDirs.delete(i);
                  refreshCleanupBtn();
                }
              }),
              h('span', { class: 'mono ellipsis', style: { minWidth: '0' }, title: d }, d)
            ),
            iconBtn('打开目录', 'Open folder', 'external', () => openPath(d))
          )))
        ));
      }
      if (regs.length) {
        loList.appendChild(h('div', { class: 'stack' },
          h('div', { class: 'small muted' }, T('注册表项', 'Registry keys')),
          h('div', { class: 'list' }, ...regs.map((r, i) => {
            const label = String(r.hive || '') + '\\' + String(r.key || '');
            return h('div', { class: 'list-item' },
              h('label', { class: 'check', style: { flex: '1', minWidth: '0' } },
                h('input', {
                  type: 'checkbox',
                  checked: S.checkRegs.has(i),
                  onchange: (e) => {
                    if (e.target.checked) S.checkRegs.add(i);
                    else S.checkRegs.delete(i);
                    refreshCleanupBtn();
                  }
                }),
                h('span', { class: 'mono ellipsis', style: { minWidth: '0' }, title: label }, label)
              ),
              iconBtn('复制注册表路径', 'Copy registry path', 'copy', () => copyText(label))
            );
          }))
        ));
      }
      if (blocked.length) {
        loList.appendChild(h('div', { class: 'row wrap' },
          h('span', { class: 'badge warn' }, T('被占用', 'In use')),
          h('span', { class: 'small muted ellipsis', style: { maxWidth: '560px' },
            title: blocked.join('\n') },
            T(fmtCount(blocked.length) + ' 项被系统占用，本次不能清理',
              fmtCount(blocked.length) + ' item(s) are in use and cannot be cleaned now'))
        ));
      }
    }

    function setAllChecks(on) {
      const L = S.leftovers;
      if (!L) return;
      S.checkDirs = on ? new Set((L.dirs || []).map((_, i) => i)) : new Set();
      S.checkRegs = on ? new Set((L.regs || []).map((_, i) => i)) : new Set();
      renderLeftovers();
    }

    function refreshCleanupBtn() {
      const n = S.checkDirs.size + S.checkRegs.size;
      btnCleanup.disabled = n === 0;
      btnCleanup._label.textContent = n
        ? T('清理选中（' + fmtCount(n) + '）', 'Clean ' + fmtCount(n))
        : T('清理选中', 'Clean selected');
    }

    async function cleanup() {
      const L = S.leftovers;
      if (!L) return;
      const app = S.leftoverApp || S.selected;
      const dirs = (L.dirs || []).filter((_, i) => S.checkDirs.has(i));
      const regs = (L.regs || []).filter((_, i) => S.checkRegs.has(i));
      if (!dirs.length && !regs.length) {
        toast(T('请先勾选要清理的残留项', 'Select leftover items first'), 'warn');
        return;
      }
      const yes = await confirm({
        title: T('清理残留', 'Clean leftovers'),
        body: T('删除 ' + fmtCount(dirs.length) + ' 个残留目录、' + fmtCount(regs.length) + ' 个注册表项。\n\n注册表项会先导出备份；残留目录是直接删除，不进回收站，删完无法恢复。',
          'Delete ' + fmtCount(dirs.length) + ' folder(s) and ' + fmtCount(regs.length) +
          ' registry key(s).\n\nRegistry keys are exported first; leftover folders are deleted permanently, not moved to the recycle bin.'),
        ok: T('永久清理', 'Clean permanently'),
        danger: true
      });
      if (!yes) return;

      setBtnBusy(btnCleanup, true, '清理中…', 'Cleaning…');
      const r = await busy(
        () => API.engine('apps.cleanup', {
          name: (app && app.name) || L.name,
          version: (app && app.version) || '',
          dirs: dirs,
          regs: regs,
          confirm: true
        }),
        T('正在清理残留…', 'Cleaning leftovers…')
      );
      setBtnBusy(btnCleanup, false);
      refreshCleanupBtn();
      if (!r) return;

      const removedDirs = Array.isArray(r.removed_dirs) ? r.removed_dirs : [];
      const removedRegs = Array.isArray(r.removed_regs) ? r.removed_regs : [];
      // 引擎返回实际删除项，按返回值从列表里摘掉，避免重扫
      S.leftovers.dirs = (L.dirs || []).filter((d) => !removedDirs.includes(d));
      const removedKeys = new Set(removedRegs.map((x) => String(x.hive || '') + '\\' + String(x.key || '')));
      S.leftovers.regs = (L.regs || []).filter((x) =>
        !removedKeys.has(String(x.hive || '') + '\\' + String(x.key || '')));
      S.checkDirs = new Set();
      S.checkRegs = new Set();
      renderLeftovers();
      renderCleanupResult(r);
      const failed = Array.isArray(r.failed) ? r.failed.length : 0;
      if (!failed) toast(T('残留已清理', 'Leftovers cleaned'), 'ok');
      else toast(T('清理完成，有 ' + fmtCount(failed) + ' 项失败',
        'Cleaned with ' + fmtCount(failed) + ' failure(s)'), 'warn');
    }

    function renderCleanupResult(r) {
      loResult.innerHTML = '';
      const removedDirs = Array.isArray(r.removed_dirs) ? r.removed_dirs : [];
      const removedRegs = Array.isArray(r.removed_regs) ? r.removed_regs : [];
      loResult.appendChild(h('div', { class: 'row wrap' },
        h('span', { class: 'badge ok' },
          T('已清理 ' + fmtCount(removedDirs.length + removedRegs.length) + ' 项',
            fmtCount(removedDirs.length + removedRegs.length) + ' removed')),
        h('span', { class: 'muted small' },
          T('目录 ' + fmtCount(removedDirs.length) + ' 个 · 注册表 ' + fmtCount(removedRegs.length) + ' 项',
            fmtCount(removedDirs.length) + ' folder(s), ' + fmtCount(removedRegs.length) + ' key(s)'))
      ));
      if (r.backup_dir) {
        loResult.appendChild(h('div', { class: 'row' },
          h('span', { class: 'muted small' }, T('注册表备份', 'Registry backup')),
          h('span', { class: 'mono ellipsis', style: { maxWidth: '460px' }, title: r.backup_dir },
            r.backup_dir),
          btn('打开', 'Open', 'ghost sm', 'external', () => openPath(r.backup_dir))
        ));
      }
      const failed = Array.isArray(r.failed) ? r.failed : [];
      if (failed.length) {
        loResult.appendChild(h('div', { class: 'small' },
          T('失败 ' + fmtCount(failed.length) + ' 项', fmtCount(failed.length) + ' failed')));
        loResult.appendChild(h('div', { class: 'list' }, ...failed.map((f) => h('div', { class: 'list-item' },
          h('div', { class: 'stack', style: { minWidth: '0' } },
            h('div', { class: 'mono small ellipsis', title: f.target || '' }, f.target || ''),
            h('div', { class: 'small', style: { color: 'var(--danger)' } }, f.why || '')
          )
        ))));
      }
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
      liveJump = null;
      setActions();
    };
  }

  window.Pages = window.Pages || {};
  window.Pages.apps = {
    title: ['应用与自启', 'Apps & Startup'],
    subtitle: ['全面管理已安装程序、开机自启动项与磁盘空间画像',
      'Manage installed software, startup items, and disk space footprint'],
    mount: mount,
    unmount: () => {
      setActions();
      liveJump = null;
    },
    jump(payload) {
      return liveJump ? liveJump(payload || {}) : undefined;
    }
  };
})();
