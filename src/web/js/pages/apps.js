/* 卸载程序页：管理员状态条 + 图标列表 + 紧凑表格 + 行内操作 + 右键菜单 + 残留清理 */
(function () {
  'use strict';
  const { h, T, icon, fmtCount, toast, busy, confirm, card, section, table,
    skeleton, empty, attachMenu, modal, softIn } = UI;

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

    root.appendChild(adminBar);
    root.appendChild(mainCard);
    root.appendChild(loSection);

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
  }

  window.Pages = window.Pages || {};
  window.Pages.apps = {
    title: ['卸载程序', 'Uninstall'],
    subtitle: ['卸载已安装程序并清理残留目录与注册表项',
      'Uninstall programs and clean leftover folders and registry keys'],
    mount: mount
  };
})();
