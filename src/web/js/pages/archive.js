/* 压缩包：打开 / 解压 / 预览 / 新建
 * 全部走 Rust 侧 archive_* 命令，不经过 Python 引擎。
 * 列表与进度都只在本地 DOM 更新，十万条目也不会碰引擎 RPC。 */
(function () {
  'use strict';

  const { h, T, icon, fmtBytes, fmtCount, toast, empty, modal, confirm, setActions } = UI;
  const errText = UI.errText;

  const MODES = [
    { id: 'saver', zh: '节约', en: 'Saver', hint: T('1 线程 · 内存最低', '1 thread · lowest memory') },
    { id: 'balanced', zh: '平衡', en: 'Balanced', hint: T('2 线程 · 推荐', '2 threads · recommended') },
    { id: 'performance', zh: '高性能', en: 'Performance', hint: T('4 线程 · 更快', '4 threads · faster') },
    { id: 'hyper', zh: '超线程', en: 'Hyper', hint: T('8 线程 · 最快，内存最高', '8 threads · fastest, most memory') }
  ];

  const FORMATS = [
    { id: 'zip', zh: 'ZIP', en: 'ZIP', hint: T('兼容最好', 'Most compatible') },
    { id: '7z', zh: '7Z', en: '7Z', hint: T('压缩率最高', 'Smallest output') },
    { id: 'tar', zh: 'TAR', en: 'TAR', hint: T('不压缩，打包', 'Pack only') },
    { id: 'tgz', zh: 'TAR.GZ', en: 'TAR.GZ', hint: T('Linux 常用', 'Common on Linux') }
  ];

  const EXT = { zip: '.zip', '7z': '.7z', tar: '.tar', tgz: '.tar.gz' };

  const S = {
    tab: 'open',
    info: null,
    path: '',
    password: '',
    selected: new Set(),
    cwd: '',
    filter: '',
    sortKey: 'name',
    sortDir: 1,
    preview: null,
    previewLoading: false,
    rar: null,
    rarBusy: false,
    busy: false,
    opLabel: '',
    progress: null,
    /* 实时速率：每来一条 archive-progress 采样一次，画成小窗里的折线 */
    speed: { t: 0, bytes: 0, ema: 0, samples: [] },
    overwrite: 'rename',
    extract: { dir: '', openAfter: true },
    create: { sources: [], dest: '', dir: '', format: 'zip', mode: 'balanced', password: '' },
    report: null,
    lastCreate: null,
    /* 列表渲染状态：行模型按目录缓存，视口外的行不建 DOM（虚拟滚动） */
    rowsByCwd: new Map(),
    viewKey: '',
    viewRows: [],
    vlist: { rowH: 0, start: -1, end: -1 },
    scrollRaf: 0,
    tableRO: null,
    indexByName: null
  };

  let root = null;
  let els = {};
  let unlisten = null;
  let dropUnlisten = null;
  let dropLayer = null;
  let destroyed = false;
  let keyHandler = null;

  /* 拖放：只认这些后缀，其余交给后端报错反而看不懂。
     .tar.* 系列先按整体匹配，避免被 .gz / .bz2 / .xz 抢先。 */
  const ARCHIVE_EXT = /\.(?:tar\.(?:gz|bz2|xz)|tgz|tbz2|tbz|txz|zipx?|cbz|7z|cb7|rar|cbr|tar|gz|bz2|xz)$/i;
  const isArchivePath = (p) => ARCHIVE_EXT.test(String(p || '').trim());

  const norm = (s) => String(s || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const baseName = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
  const dirName = (p) => {
    const s = String(p || '').replace(/[\\/]+$/, '');
    const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
    return i > 0 ? s.slice(0, i) : '';
  };
  const assetUrl = (p) => {
    try { return window.__TAURI__.core.convertFileSrc(p); } catch { return p; }
  };

  /* 解压 / 压缩共用的路径小工具。Windows 目标，统一用反斜杠拼接。 */
  const joinPath = (dir, name) => {
    const left = String(dir || '').trim().replace(/[\\/]+$/, '');
    const right = String(name || '').trim().replace(/^[\\/]+/, '');
    if (!left) return right;
    if (!right) return left;
    return left + '\\' + right;
  };
  const isAbsPath = (p) => /^[a-zA-Z]:[\\/]/.test(String(p || '')) || /^\\\\[^\\]/.test(String(p || ''));

  /* 压缩包 → 文件夹名：只剥掉压缩后缀，foo.tar.gz → foo */
  const ARCHIVE_SUFFIX = /\.(?:tar\.(?:gz|bz2|xz)|tgz|tbz2?|txz|zipx?|cbz|7z|cb7|rar|cbr|tar|gz|bz2|xz)$/i;
  const archiveStem = (p) => {
    const n = baseName(p);
    return n.replace(ARCHIVE_SUFFIX, '') || n;
  };

  const BAD_FOLDER_CHARS = /[<>:"\\|?*\u0000-\u001f]/;
  function folderNameError(name) {
    const n = String(name || '').trim();
    if (!n) return T('文件夹名不能为空', 'Folder name is required');
    if (n === '.' || n === '..') return T('文件夹名无效', 'Invalid folder name');
    if (BAD_FOLDER_CHARS.test(n)) return T('文件夹名不能包含 \\ / : * ? " < > |', 'Name cannot contain \\ / : * ? " < > |');
    if (/[. ]$/.test(n)) return T('文件夹名不能以空格或点结尾', 'Name cannot end with a space or dot');
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(n)) return T('这是系统保留名称', 'Reserved system name');
    return '';
  }

  /* 压缩包是否自带唯一的顶层文件夹。自带的话再套一层同名文件夹就会 foo\foo。 */
  function singleRootFolder() {
    const info = S.info;
    if (!info || !Array.isArray(info.entries) || !info.entries.length) return null;
    let seg = '';
    for (const e of info.entries) {
      const n = norm(e.name);
      if (!n) continue;
      const i = n.indexOf('/');
      if (i < 0) return null;               // 顶层直接有文件，不算自带文件夹
      const top = n.slice(0, i);
      if (!seg) seg = top;
      else if (seg.toLowerCase() !== top.toLowerCase()) return null;
    }
    return seg || null;
  }

  function startOp(label) {
    S.busy = true;
    S.opLabel = label || T('正在处理…', 'Working…');
    S.progress = null;
    S.speed = { t: 0, bytes: 0, ema: 0, samples: [] };
    renderProgress();
  }

  function endOp() {
    S.busy = false;
    S.opLabel = '';
    S.progress = null;
    renderProgress();
  }

  function pct(n, d) {
    if (!d) return 0;
    return Math.max(0, Math.min(100, Math.round((Number(n) || 0) * 100 / d)));
  }

  function renderTabs() {
    if (!els.tabs) return;
    els.tabs.innerHTML = '';
    els.tabs.setAttribute('role', 'tablist');
    [['open', T('打开压缩包', 'Open archive'), T('浏览、解压、预览', 'Browse, extract, preview')],
     ['create', T('新建压缩包', 'New archive'), T('ZIP / 7Z / TAR.GZ', 'ZIP / 7Z / TAR.GZ')]]
      .forEach(([id, label, sub]) => {
        els.tabs.appendChild(h('button', {
          class: 'arc-tab' + (S.tab === id ? ' active' : ''),
          role: 'tab',
          title: sub,
          'aria-selected': S.tab === id ? 'true' : 'false',
          onclick: () => { S.tab = id; renderTabs(); renderViews(); }
        }, h('span', { class: 'arc-tab-ic' }, icon(id === 'open' ? 'archive' : 'plus', 15)),
          h('strong', null, label)));
      });
  }

  function renderViews() {
    if (els.headTools) els.headTools.hidden = false;
    if (els.pathRow) els.pathRow.hidden = S.tab !== 'open';
    if (els.createTools) els.createTools.hidden = S.tab !== 'create';
    if (els.open) els.open.hidden = S.tab !== 'open';
    if (els.create) els.create.hidden = S.tab !== 'create';
    if (S.tab === 'open') renderOpen();
    else renderCreate();
    renderProgress();
  }

  /* ---------------------------------------------------------------- 打开视图 */
  function buildOpen() {
    const path = h('input', {
      class: 'input grow arc-path',
      readonly: true,
      placeholder: T('尚未选择压缩包', 'No archive selected'),
      value: S.path || ''
    });
    const pick = h('button', { class: 'btn primary' }, icon('folder', 15), T('选择压缩包', 'Open'));
    pick.onclick = chooseArchive;
    const refresh = h('button', { class: 'btn ghost icon sm', title: T('重新读取', 'Reload') }, icon('refresh', 15));
    refresh.onclick = () => { if (S.path) openArchive(S.path, S.password || null); };
    const close = h('button', { class: 'btn ghost icon sm', title: T('关闭', 'Close') }, icon('close', 15));
    close.onclick = closeArchive;

    const meta = h('div', { class: 'arc-meta' });
    const rar = h('div', { class: 'arc-rar', hidden: true });
    const crumbs = h('div', { class: 'arc-crumbs' });
    const filter = h('input', {
      class: 'input sm arc-filter',
      type: 'search',
      placeholder: T('在当前文件夹筛选', 'Filter this folder'),
      value: S.filter
    });
    // 每敲一个字就重建列表在几千条时很贵，按 120ms 防抖合并连续输入
    let filterTimer = 0;
    filter.oninput = () => {
      S.filter = filter.value;
      clearTimeout(filterTimer);
      filterTimer = setTimeout(() => renderTable(), 120);
    };
    const all = h('button', { class: 'btn ghost sm' }, T('全选 / 反选', 'Select all'));
    all.onclick = selectAll;
    const count = h('span', { class: 'small muted arc-count' }, '');

    const thead = h('thead', null, h('tr', null,
      h('th', { class: 'arc-check' }, ''),
      h('th', { class: 'arc-sort', onclick: () => sortBy('name') }),
      h('th', { class: 'arc-sort num', onclick: () => sortBy('size') }),
      h('th', { class: 'arc-sort num', onclick: () => sortBy('packed') }),
      h('th', { class: 'arc-sort', onclick: () => sortBy('modified') }),
      h('th', { class: 'arc-sort', onclick: () => sortBy('encrypted') }, T('加密', 'Encrypted'))
    ));
    const heads = thead.querySelectorAll('th.arc-sort');
    const mark = (k) => S.sortKey === k ? (S.sortDir > 0 ? ' ↑' : ' ↓') : '';
    const setHeads = () => {
      heads[0].textContent = T('名称', 'Name') + mark('name');
      heads[1].textContent = T('大小', 'Size') + mark('size');
      heads[2].textContent = T('压缩后', 'Packed') + mark('packed');
      heads[3].textContent = T('修改时间', 'Modified') + mark('modified');
      heads[4].textContent = T('加密', 'Encrypted');
    };

    const tbody = h('tbody');
    const table = h('table', { class: 'arc-table' }, thead, tbody);
    const emptyBox = h('div', { class: 'arc-empty-box', hidden: true });
    const tableWrap = h('div', { class: 'arc-table-wrap' }, table, emptyBox);

    const footLeft = h('div', { class: 'arc-foot-left small muted' }, '');
    const overwrite = UI.customSelect({
      options: [
        { value: 'rename', label: T('重名时自动改名', 'Rename duplicates') },
        { value: 'overwrite', label: T('覆盖同名文件', 'Overwrite') },
        { value: 'skip', label: T('跳过同名文件', 'Skip') }
      ],
      value: S.overwrite,
      alignUp: true,
      title: T('同名文件处理', 'Existing files'),
      onChange: (v) => { S.overwrite = v; }
    });
    const extractSel = h('button', { class: 'btn primary sm' }, icon('export', 14), T('解压选中', 'Extract selected'));
    extractSel.onclick = () => extractSelected();
    const extractAll = h('button', { class: 'btn sm' }, T('解压全部', 'Extract all'));
    extractAll.onclick = () => extractAllFiles();
    const cancel = h('button', { class: 'btn danger sm', hidden: true }, T('取消任务', 'Cancel'));
    cancel.onclick = cancelOp;

    const modeSel = UI.customSelect({
      options: MODES.map((m) => ({ value: m.id, label: T(m.zh, m.en) })),
      value: S.create.mode,
      alignUp: true,
      title: T('解压性能模式', 'Extract performance mode'),
      onChange: (v) => {
        S.create.mode = v;
        API.configSet({ archive_mode: v }).catch(() => {});
        renderCreateChoices();
      }
    });
    const side = h('aside', { class: 'arc-side card', hidden: true });
    const listTools = h('div', { class: 'arc-list-tools' }, filter, all, count);
    const listHead = h('div', { class: 'arc-list-head' }, crumbs, listTools);
    const footActions = h('div', { class: 'arc-foot-actions' },
      modeSel, overwrite, extractSel, extractAll, cancel);
    const grid = h('div', { class: 'arc-grid' },
      h('div', { class: 'arc-list card' },
        listHead,
        rar,
        tableWrap,
        h('div', { class: 'arc-foot' },
          h('div', { class: 'arc-foot-info' }, meta, footLeft),
          footActions)
      ),
      side
    );

    const progress = h('div', { class: 'arc-progress card', hidden: true });
    const view = h('div', { class: 'arc-view', id: 'arc-open' }, grid);

    els.open = view; els.path = path; els.meta = meta; els.rar = rar;
    els.pathRow = h('div', { class: 'arc-path-row arc-path-row-head' }, path, pick, refresh, close);
    els.crumbs = crumbs; els.tbody = tbody; els.count = count;
    els.footLeft = footLeft; els.cancel = cancel; els.side = side;
    els.grid = grid; els.progress = progress; els.tableWrap = tableWrap;
    els.table = table; els.emptyBox = emptyBox; els.listHead = listHead;
    els.modeSel = modeSel;

    // 滚动只重画可视区（rAF 合帧）；容器尺寸变化（窗口缩放/侧栏折叠）也要重算可视行数
    tableWrap.addEventListener('scroll', () => {
      if (S.scrollRaf) return;
      S.scrollRaf = requestAnimationFrame(() => {
        S.scrollRaf = 0;
        renderSlice(false);
      });
    }, { passive: true });
    if (typeof ResizeObserver === 'function') {
      S.tableRO = new ResizeObserver(() => { if (S.vlist.start >= 0) renderSlice(true); });
      S.tableRO.observe(tableWrap);
    }
    els.setHeads = setHeads;
    return view;
  }

  function sortBy(k) {
    if (S.sortKey === k) S.sortDir = -S.sortDir;
    else { S.sortKey = k; S.sortDir = 1; }
    if (els.setHeads) els.setHeads();
    renderTable();
  }

  function chooseArchive() {
    API.pickArchive().then((p) => {
      if (p) openArchive(p, null);
    }).catch((e) => toast(errText(e), 'error'));
  }

  async function openArchive(path, password) {
    if (!path) return;
    S.path = path;
    S.password = password || '';
    S.selected.clear();
    S.cwd = '';
    S.filter = '';
    S.preview = null;
    S.info = null;
    S.report = null;
    resetRowCaches();          // 换包就丢掉旧的目录行缓存
    if (els.path) els.path.value = path;
    let pw = password || '';
    startOp(T('正在读取压缩包…', 'Reading archive…'));
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const info = await API.archiveOpen(path, pw || null);
        if (!info) throw new Error(T('读取失败', 'Failed to read'));
        S.info = info;
        S.path = info.path || path;
        S.password = pw;
        if (els.path) els.path.value = S.path;
        if (S.rar) S.rar = { ...S.rar, ready: !!info.rarReady };
        endOp();
        renderOpen();
        if (info.needsRar) refreshRar();
        return;
      } catch (e) {
            if (!pw && attempt === 0 && looksEncrypted(e)) {
          endOp();
          const entered = await askPassword(T('这个压缩包可能有密码', 'This archive may be encrypted'));
          if (entered !== null && entered !== '') { pw = entered; startOp(T('正在读取压缩包…', 'Reading archive…')); continue; }
        }
        endOp();
        toast(errText(e), 'error');
        renderOpen();
        return;
      }
    }
    endOp();
  }

  function looksEncrypted(e) {
    const s = String((e && e.message) || e || '').toLowerCase();
    return /密码|password|encrypt|加密/.test(s);
  }

  function askPassword(title) {
    return new Promise((resolve) => {
      const input = h('input', {
        class: 'input',
        type: 'password',
        autocomplete: 'off',
        placeholder: T('留空则取消', 'Leave empty to cancel')
      });
      const body = h('div', { class: 'arc-password' },
        h('div', { class: 'small muted' }, T('密码只用于本次解压，不会保存。', 'Used for this operation only; not saved.')),
        input
      );
      const m = modal({
        title: title || T('输入密码', 'Password'),
        body,
        buttons: [
          { id: 'cancel', label: T('取消', 'Cancel'), kind: 'ghost' },
          { id: 'ok', label: T('确定', 'OK'), kind: 'primary' }
        ],
        onClose: (v) => resolve(v === 'ok' ? input.value : null)
      });
      setTimeout(() => input.focus(), 30);
    });
  }

  function closeArchive() {
    S.info = null;
    S.path = '';
    S.password = '';
    S.selected.clear();
    S.cwd = '';
    S.preview = null;
    S.report = null;
    if (els.path) els.path.value = '';
    resetRowCaches();
    closePreview();
    renderOpen();
  }

  // 预览请求序号：连续双击不同条目时，先发的请求可能后回来，
  // 没有序号就会把 A 的内容显示成 B 的。
  let previewSeq = 0;

  function closePreview() {
    previewSeq += 1; // 关掉之后别再让在途请求把面板弹回来
    if (S.preview) API.archivePreviewClear().catch(() => {});
    S.preview = null;
    S.previewLoading = false;
    renderPreview();
  }

  /* 当前目录的直接子项：目录优先，再按排序键 */
  /* ---------------------------------------------------------------- 行模型
     大包（几万条目）的规则：
       1. 每个目录只扫描一遍 entries，结果按 cwd 缓存，切回来不再重算；
       2. 筛选与排序只在缓存数组的副本上做，不碰原始 entries；
       3. 三者都没有变化时直接复用上一次的结果（S.viewRows）。 */
  function buildRowsFor(cwd) {
    let targetCwd = String(cwd || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (targetCwd && !targetCwd.endsWith('/')) targetCwd += '/';
    const map = new Map();
    const entries = (S.info && S.info.entries) || [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      let name = norm(e.name);
      if (!name) continue;
      if (targetCwd) {
        if (!name.startsWith(targetCwd)) continue;
        name = name.slice(targetCwd.length).replace(/^\/+/, '');
      }
      if (!name) continue;
      const slash = name.indexOf('/');
      if (slash >= 0) {
        const seg = name.slice(0, slash);
        if (!seg) continue;
        const key = targetCwd + seg + '/';
        if (!map.has(key)) map.set(key, {
          key, name: seg, isDir: true, index: null,
          size: 0, packed: 0, fileCount: 0, modified: '', encrypted: false, synthetic: true
        });
        continue;
      }
      const isDir = !!e.isDir || name.endsWith('/');
      const clean = name.replace(/\/+$/, '');
      if (!clean) continue;
      const key = targetCwd + clean + (isDir ? '/' : '');
      if (!map.has(key)) map.set(key, {
        key, name: clean, isDir, index: e.index,
        size: isDir ? 0 : (Number(e.size) || 0),
        packed: isDir ? 0 : (Number(e.packed) || 0),
        fileCount: isDir ? 0 : 1,
        modified: (e.modified && e.modified !== '—') ? e.modified : '',
        encrypted: !!e.encrypted, synthetic: false
      });
    }

    // 聚合统计目录项的子条目总大小、压缩后大小、文件数和最新修改时间
    const dirRows = [];
    map.forEach((row) => { if (row.isDir) dirRows.push(row); });
    if (dirRows.length > 0) {
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const ename = norm(e.name);
        if (!ename) continue;
        const isEntryDir = !!e.isDir || ename.endsWith('/');
        for (let j = 0; j < dirRows.length; j++) {
          const d = dirRows[j];
          if (ename.startsWith(d.key)) {
            if (!isEntryDir) {
              d.size += (Number(e.size) || 0);
              d.packed += (Number(e.packed) || 0);
              d.fileCount = (d.fileCount || 0) + 1;
            }
            if (e.modified && e.modified !== '—' && (!d.modified || String(e.modified) > String(d.modified))) {
              d.modified = String(e.modified);
            }
            if (e.encrypted) d.encrypted = true;
          }
        }
      }
    }

    return [...map.values()];
  }

  function baseRows() {
    const cwd = S.cwd;
    let rows = S.rowsByCwd.get(cwd);
    if (!rows) {
      rows = buildRowsFor(cwd);
      S.rowsByCwd.set(cwd, rows);
    }
    return rows;
  }

  function rowsCacheKey() {
    return [S.info ? S.info.path || '' : '', S.cwd, S.filter, S.sortKey, S.sortDir].join('\u0000');
  }

  function currentRows() {
    if (!S.info) return [];
    const key = rowsCacheKey();
    if (key === S.viewKey) return S.viewRows;
    let rows = baseRows().slice();
    if (S.filter) {
      const q = S.filter.toLowerCase();
      rows = rows.filter((r) => r.name.toLowerCase().includes(q));
    }
    const dir = S.sortDir;
    rows.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      let r = 0;
      if (S.sortKey === 'name') r = a.name.localeCompare(b.name, 'zh-CN');
      else if (S.sortKey === 'size') r = (a.size || 0) - (b.size || 0);
      else if (S.sortKey === 'packed') r = (a.packed || 0) - (b.packed || 0);
      else if (S.sortKey === 'modified') r = String(a.modified || '').localeCompare(String(b.modified || ''));
      else if (S.sortKey === 'encrypted') r = Number(a.encrypted) - Number(b.encrypted);
      if (!r) r = a.name.localeCompare(b.name, 'zh-CN');
      return r * dir;
    });
    S.viewKey = key;
    S.viewRows = rows;
    return rows;
  }

  function resetRowCaches() {
    S.rowsByCwd.clear();
    S.viewKey = '';
    S.viewRows = [];
    S.vlist.start = -1;
    S.vlist.end = -1;
    S.indexByName = null;
    if (els.tbody) els.tbody.innerHTML = '';
  }

  /* 条目名 → entry 的索引，选中项换算成 Rust 的 index 时用，避免每次全表扫 */
  function entryIndex() {
    if (S.indexByName) return S.indexByName;
    const m = new Map();
    const entries = (S.info && S.info.entries) || [];
    for (let i = 0; i < entries.length; i++) {
      const nm = norm(entries[i].name);
      if (nm && !m.has(nm)) m.set(nm, entries[i]);
    }
    S.indexByName = m;
    return m;
  }

  function renderOpen() {
    if (!els.open) return;
    if (els.modeSel) els.modeSel.value = S.create.mode;
    if (S.info) {
      els.open.classList.add('has-archive');
      if (els.path) els.path.value = S.path;
      if (els.cancel) els.cancel.hidden = !S.busy;
    } else {
      els.open.classList.remove('has-archive');
    }
    if (els.listHead) els.listHead.hidden = !S.info;
    renderMeta();
    renderRar();
    renderCrumbs();
    const f = els.open.querySelector('.arc-filter');
    if (f) f.value = S.filter;
    renderTable();
    renderFoot();
    renderPreview();
    renderProgress();
  }

  function renderMeta() {
    if (!els.meta) return;
    els.meta.innerHTML = '';
    if (!S.info) {
      els.meta.appendChild(h('span', { class: 'arc-meta-hint' },
        T('支持 ZIP / 7Z / TAR / TAR.GZ / GZ / BZ2 / XZ / RAR',
          'ZIP / 7Z / TAR / TAR.GZ / GZ / BZ2 / XZ / RAR')));
      return;
    }
    const i = S.info;
    els.meta.appendChild(h('span', { class: 'arc-badge format' }, String(i.format || '').toUpperCase()));
    const bits = [
      T('条目 ', 'Entries ') + fmtCount((i.entries || []).length),
      T('原始 ', 'Size ') + fmtBytes(i.totalSize),
      T('压缩后 ', 'Packed ') + fmtBytes(i.totalPacked)
    ];
    if (i.solid) bits.push(T('固实', 'Solid'));
    if (i.comment) bits.push(T('注释', 'Comment'));
    els.meta.appendChild(h('span', { class: 'arc-meta-text' }, bits.join(' · ')));
    if (i.encrypted) {
      els.meta.appendChild(h('span', { class: 'arc-badge warn' }, T('加密', 'Encrypted')));
    }
  }

  function renderRar() {
    if (!els.rar) return;
    const need = !!(S.info && (S.info.needsRar || (S.info.format === 'RAR' && S.info.rarReady === false)));
    els.rar.hidden = !need;
    els.rar.innerHTML = '';
    if (!need) return;
    const ready = S.rar && S.rar.ready;
    els.rar.appendChild(h('div', { class: 'arc-rar-text' },
      h('strong', null, T('需要 RAR 解压组件', 'RAR component required')),
      h('span', { class: 'small muted' },
        ready ? T('组件已就绪，正在重新读取…', 'Ready; reopening archive…')
          : T('首次打开 RAR 时下载官方 UnRAR64.dll（约 1.2 MB），不随安装包分发。',
              'Downloads the official UnRAR64.dll (~1.2 MB) on first RAR use.'))
    ));
    const btn = h('button', { class: 'btn primary sm', disabled: S.rarBusy || ready },
      S.rarBusy ? T('正在下载…', 'Downloading…') : T('下载并安装', 'Download and install'));
    btn.onclick = installRar;
    els.rar.appendChild(btn);
  }

  async function refreshRar() {
    try {
      S.rar = await API.archiveRarStatus();
      if (S.info && S.rar && S.rar.ready) S.info.rarReady = true;
      renderRar();
      renderMeta();
    } catch { /* 状态查询失败不阻塞其它格式 */ }
  }

  async function installRar() {
    if (S.rarBusy) return;
    S.rarBusy = true;
    renderRar();
    try {
      const st = await API.archiveRarInstall();
      S.rar = st;
      if (st && st.ready) {
        toast(T('RAR 组件已安装', 'RAR component installed'), 'ok');
        await refreshRar();
        if (S.path) await openArchive(S.path, S.password || null);
      } else {
        toast(T('安装未完成，请稍后重试', 'Install did not complete'), 'warn');
      }
    } catch (e) {
      toast(errText(e), 'error');
    } finally {
      S.rarBusy = false;
      renderRar();
    }
  }

  function renderCrumbs() {
    if (!els.crumbs) return;
    els.crumbs.innerHTML = '';
    if (!S.info) return;
    const rootName = baseName(S.path) || T('压缩包', 'Archive');
    const rootBtn = h('button', { class: 'arc-crumb', onclick: () => goCwd('') }, icon('archive', 13), rootName);
    els.crumbs.appendChild(rootBtn);
    const parts = S.cwd.replace(/\/$/, '').split('/').filter(Boolean);
    let acc = '';
    parts.forEach((p) => {
      acc += p + '/';
      const target = acc;
      els.crumbs.appendChild(h('span', { class: 'arc-crumb-sep' }, '/'));
      els.crumbs.appendChild(h('button', { class: 'arc-crumb', onclick: () => goCwd(target) }, p));
    });
  }

  function goCwd(p) {
    let clean = String(p || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (clean && !clean.endsWith('/')) clean += '/';
    S.cwd = clean;
    S.selected.clear();
    S.filter = '';
    if (els.open) {
      const f = els.open.querySelector('.arc-filter');
      if (f) f.value = '';
    }
    renderCrumbs();
    renderTable();
    renderFoot();
  }

  /* ---------------------------------------------------------------- 虚拟列表
     只给视口内的行建 DOM：几千上万条时首屏依然只插 30~50 个 <tr>，
     上下各用一个空行撑出滚动高度，滚轮走的是原生滚动，不重排整张表。 */
  const VROW_OVERSCAN = 8;

  function rowHeight() {
    if (S.vlist.rowH) return S.vlist.rowH;
    let h = 0;
    try {
      const raw = getComputedStyle(els.tableWrap || document.documentElement).getPropertyValue('--row-h');
      const v = parseFloat(raw);
      if (v > 0) h = v + 1;          // td 高度 + 1px 分隔线
    } catch { /* 取不到就用兜底值 */ }
    S.vlist.rowH = h || 33;
    return S.vlist.rowH;
  }

  function makeSpacer(px) {
    const tr = h('tr', { class: 'arc-spacer', 'aria-hidden': 'true' }, h('td', { colspan: 6 }));
    tr.firstChild.style.height = Math.max(0, px) + 'px';
    return tr;
  }

  function buildRow(r) {
    const checked = S.selected.has(r.key);
    const cb = h('input', {
      type: 'checkbox',
      class: 'arc-checkbox',
      checked,
      'aria-label': T('选择 ', 'Select ') + r.name
    });
    cb.onchange = (e) => { e.stopPropagation(); toggleKey(r.key, cb.checked); };
    cb.onclick = (e) => e.stopPropagation();
    const tr = h('tr', {
      class: 'arc-row' + (checked ? ' selected' : '') + (r.isDir ? ' dir' : ''),
      'data-key': r.key,
      title: r.isDir ? T('双击进入', 'Double-click to open') : T('双击预览', 'Double-click to preview')
    },
      h('td', { class: 'arc-check' }, cb),
      h('td', { class: 'arc-name' }, h('span', { class: 'arc-name-in' },
        h('span', { class: 'arc-file-ic' }, icon(r.isDir ? 'folder' : 'file', 15)),
        h('span', { class: 'ellipsis' }, r.name))),
      h('td', { class: 'num' }, r.isDir ? (r.size ? fmtBytes(r.size) + (r.fileCount ? ' (' + r.fileCount + T('项', ' items') + ')' : '') : (r.fileCount ? r.fileCount + T('项', ' items') : '—')) : fmtBytes(r.size)),
      h('td', { class: 'num muted' }, r.isDir ? (r.packed ? fmtBytes(r.packed) : '—') : fmtBytes(r.packed)),
      h('td', { class: 'muted small' }, r.modified || '—'),
      h('td', { class: 'small' }, r.encrypted ? T('是', 'Yes') : '—')
    );
    tr.onclick = () => {
      if (!r.isDir) toggleKey(r.key, !S.selected.has(r.key));
    };
    tr.ondblclick = () => {
      if (r.isDir) goCwd(r.key);
      else openPreview(r);
    };
    tr.oncontextmenu = (e) => {
      e.preventDefault();
      UI.menu(e, [
        r.isDir
          ? { label: T('进入文件夹', 'Open folder'), icon: 'folder', action: () => goCwd(r.key) }
          : { label: T('预览', 'Preview'), icon: 'external', action: () => openPreview(r) },
        { sep: true },
        { label: T('解压选中', 'Extract selected'), icon: 'export', action: () => extractSelected() },
        { label: T('复制名称', 'Copy name'), icon: 'copy', action: () => { try { navigator.clipboard.writeText(r.name); } catch { /* ignore */ } } }
      ]);
    };
    return tr;
  }

  function renderSlice(force) {
    const wrap = els.tableWrap;
    const tbody = els.tbody;
    if (!wrap || !tbody) return;
    const rows = S.viewRows;
    const total = rows.length;
    if (!total) {
      tbody.innerHTML = '';
      S.vlist.start = -1;
      S.vlist.end = -1;
      return;
    }
    const rowH = rowHeight();
    const viewH = wrap.clientHeight || 420;
    const top = wrap.scrollTop || 0;
    let start = Math.max(0, Math.floor(top / rowH) - VROW_OVERSCAN);
    let end = Math.min(total, Math.ceil((top + viewH) / rowH) + VROW_OVERSCAN);
    if (end <= start) end = Math.min(total, start + 1);
    if (!force && start === S.vlist.start && end === S.vlist.end) return;
    S.vlist.start = start;
    S.vlist.end = end;
    const frag = document.createDocumentFragment();
    if (start > 0) frag.appendChild(makeSpacer(start * rowH));
    for (let i = start; i < end; i++) frag.appendChild(buildRow(rows[i]));
    if (end < total) frag.appendChild(makeSpacer((total - end) * rowH));
    tbody.innerHTML = '';
    tbody.appendChild(frag);
    // 第一次画完量一次真实行高，估算偏差超过 1px 就按实测重画，避免滚动错位
    const probe = tbody.querySelector('tr.arc-row');
    const real = probe ? probe.getBoundingClientRect().height : 0;
    if (real > 0 && Math.abs(real - S.vlist.rowH) > 1) {
      S.vlist.rowH = real;
      S.vlist.start = -1;
      S.vlist.end = -1;
      renderSlice(true);
    }
  }

  function findRowEl(key) {
    if (!els.tbody) return null;
    const list = els.tbody.querySelectorAll('tr.arc-row');
    for (let i = 0; i < list.length; i++) if (list[i].dataset.key === key) return list[i];
    return null;
  }

  function renderTable() {
    if (!els.tbody) return;
    if (els.setHeads) els.setHeads();
    const rows = currentRows();
    const isEmpty = !S.info || !rows.length;
    if (els.tableWrap) els.tableWrap.classList.toggle('is-empty', isEmpty);
    if (els.table) els.table.hidden = isEmpty;
    if (els.emptyBox) {
      els.emptyBox.hidden = !isEmpty;
      els.emptyBox.innerHTML = '';
      if (isEmpty) {
        els.emptyBox.appendChild(S.info
          ? empty(T('这个文件夹是空的', 'This folder is empty'),
            S.filter ? T('没有匹配当前筛选的内容', 'Nothing matches the filter') : '', 'folder')
          : empty(T('还没有打开压缩包', 'No archive open'),
            T('选择或拖入 ZIP / 7Z / TAR / RAR 压缩包', 'Choose or drop a ZIP / 7Z / TAR / RAR archive'), 'archive'));
      }
    }
    if (!S.info) {
      if (els.count) els.count.textContent = '';
      els.tbody.innerHTML = '';
      return;
    }
    if (!rows.length) {
      if (els.count) els.count.textContent = fmtCount(0);
      els.tbody.innerHTML = '';
      S.vlist.start = -1;
      S.vlist.end = -1;
      return;
    }
    if (els.count) {
      els.count.textContent = (S.filter ? T('匹配 ', 'Matches ') : T('共 ', 'Total ')) +
        fmtCount(rows.length) + T(' 项', ' items');
    }
    // 筛选/排序/换目录都会走到这里：视图换了就回顶部，别停在旧的滚动偏移上
    if (els.tableWrap) els.tableWrap.scrollTop = 0;
    S.vlist.start = -1;
    S.vlist.end = -1;
    renderSlice(true);
  }

  function toggleKey(key, on) {
    if (on) S.selected.add(key); else S.selected.delete(key);
    const tr = findRowEl(key);
    if (tr) {
      tr.classList.toggle('selected', on);
      const cb = tr.querySelector('input.arc-checkbox');
      if (cb) cb.checked = on;
    }
    renderFoot();
  }

  function selectAll() {
    const rows = currentRows();
    const all = rows.length && rows.every((r) => S.selected.has(r.key));
    if (all) S.selected.clear();
    else rows.forEach((r) => S.selected.add(r.key));
    renderSlice(true);    // 只重画可视区，全选几千条也不重建整张表
    renderFoot();
  }

  function selectedIndices() {
    if (!S.info) return [];
    const idx = entryIndex();
    const out = new Set();
    for (const key of S.selected) {
      if (key.endsWith('/')) {
        for (const [name, e] of idx) if (name.startsWith(key)) out.add(e.index);
      } else {
        const e = idx.get(key);
        if (e) out.add(e.index);
      }
    }
    return [...out].filter((n) => Number.isInteger(n));
  }

  function renderFoot() {
    if (!els.footLeft) return;
    const n = S.selected.size;
    els.footLeft.textContent = n
      ? T('已选 ' + fmtCount(n) + ' 项', fmtCount(n) + ' selected')
      : T('未选择时解压全部', 'Nothing selected means all');
    if (els.cancel) els.cancel.hidden = !S.busy;
  }

  async function extractSelected() {
    const idx = selectedIndices();
    if (!idx.length) { toast(T('先选择要解压的文件或文件夹', 'Select something first'), 'warn'); return; }
    await doExtract(idx);
  }

  async function extractAllFiles() {
    await doExtract(null);
  }

  /* 软件内的「解压到」对话框：选位置、定文件夹名、实时看最终路径。
     取代系统选择器，解压结果不再散落在目标目录。 */
  function askExtractDest(indices) {
    return new Promise((resolve) => {
      const stem = archiveStem(S.path);
      const root = singleRootFolder();
      const sameRoot = !!root && norm(root).toLowerCase() === norm(stem).toLowerCase();
      const entries = (S.info && Array.isArray(S.info.entries)) ? S.info.entries : [];
      const only = (indices && indices.length) ? new Set(indices) : null;
      let count = 0;
      let bytes = 0;
      for (const e of entries) {
        if (!only || only.has(e.index)) { count++; bytes += Number(e.size) || 0; }
      }

      const dest = h('input', {
        class: 'input grow',
        placeholder: T('例如 D:\\下载', 'e.g. D:\\Downloads'),
        value: S.extract.dir || dirName(S.path) || ''
      });
      // 单文件压缩包（foo.txt.gz 这类）：条目名和压缩包去掉后缀后的名字一致时，
      // 文件夹名再用条目名去扩展名，免得出现 foo.txt\foo.txt。
      const solo = entries.length === 1 && !norm(entries[0].name).includes('/');
      const soloName = solo ? baseName(entries[0].name) : '';
      const soloStem = (solo && soloName.toLowerCase() === stem.toLowerCase())
        ? (soloName.replace(/\.[^.]+$/, '') || stem) : '';
      const nameEl = h('input', { class: 'input', value: sameRoot ? root : (soloStem || stem) });
      const sub = h('input', { type: 'checkbox', checked: !sameRoot });
      const openCb = h('input', { type: 'checkbox', checked: S.extract.openAfter !== false });
      const target = h('code', { class: 'xdlg-path' }, '');
      const errEl = h('div', { class: 'xdlg-err' }, '');
      const hint = h('div', { class: 'small muted xdlg-hint' }, '');

      const browse = h('button', { class: 'btn', type: 'button' }, icon('folder', 15), T('浏览', 'Browse'));
      browse.onclick = async () => {
        try {
          const p = await API.pickFolder(dest.value.trim() || S.extract.dir || dirName(S.path) || undefined);
          if (p) { dest.value = p; sync(); }
        } catch (e) { toast(errText(e), 'error'); }
      };

      const body = h('div', { class: 'xdlg' },
        h('div', { class: 'xdlg-src' },
          icon('archive', 16),
          h('span', { class: 'ellipsis' }, baseName(S.path)),
          h('span', { class: 'small muted' }, count ? fmtCount(count) + T(' 项', ' items') + (bytes ? ' · ' + fmtBytes(bytes) : '') : '')),
        h('div', { class: 'arc-field' },
          h('span', { class: 'arc-field-label' }, T('解压到', 'Extract to')),
          h('div', { class: 'arc-path-row' }, dest, browse)),
        h('div', { class: 'arc-field' },
          h('span', { class: 'arc-field-label' }, T('文件夹', 'Folder')),
          h('div', { class: 'xdlg-sub' },
            h('label', { class: 'check' }, sub, h('span', null, T('放进同名文件夹', 'Into a folder'))),
            nameEl)),
        hint,
        h('div', { class: 'xdlg-target' }, icon('folder', 14), target),
        errEl,
        h('label', { class: 'check' }, openCb, h('span', null, T('完成后打开文件夹', 'Open the folder when done')))
      );

      function peek() {
        const dir = dest.value.trim();
        const name = nameEl.value.trim();
        return { dir, name, subOn: !!sub.checked, out: sub.checked ? joinPath(dir, name) : dir };
      }
      function validate() {
        const p = peek();
        if (!p.dir) return T('请选择解压位置', 'Choose where to extract');
        if (!isAbsPath(p.dir)) return T('请填写完整路径，例如 D:\\下载', 'Enter a full path, e.g. D:\\Downloads');
        if (p.subOn) {
          const bad = folderNameError(p.name);
          if (bad) return bad;
        }
        return '';
      }
      function sync() {
        const p = peek();
        target.textContent = p.out || '—';
        errEl.textContent = validate();
        if (p.subOn) {
          hint.textContent = T('压缩包里的文件保持原文件名，放进「' + p.name + '」。',
            'Files keep their names and go into “' + p.name + '”.');
        } else {
          hint.textContent = root
            ? T('压缩包自带顶层文件夹「' + root + '」，直接解压到所选位置，不会多套一层。',
              'The archive already has “' + root + '”; extracting straight into the chosen folder.')
            : T('压缩包顶层没有文件夹，文件会直接散落在所选位置。',
              'No top-level folder; files would land directly in the chosen folder.');
        }
        if (m) {
          const ok = m.el.querySelector('.modal-foot .btn.primary');
          if (ok) ok.disabled = !!validate();
        }
      }

      let settled = false;
      const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
      const submit = () => {
        const bad = validate();
        if (bad) { errEl.textContent = bad; dest.focus(); return false; }
        const p = peek();
        finish({ dir: p.dir, folder: p.name, subfolder: p.subOn, openAfter: !!openCb.checked });
        return true;
      };

      let m = null;
      m = modal({
        title: T('解压到', 'Extract to'),
        wide: true,
        body,
        buttons: [
          { id: 'cancel', label: T('取消', 'Cancel'), kind: 'ghost' },
          { id: 'ok', label: T('开始解压', 'Extract'), kind: 'primary' }
        ],
        onAction: (id) => (id === 'ok' ? submit() : true),
        onClose: () => finish(null)
      });

      const onEnter = (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        if (submit()) m.close('ok');
      };
      dest.addEventListener('keydown', onEnter);
      nameEl.addEventListener('keydown', onEnter);
      dest.addEventListener('input', sync);
      nameEl.addEventListener('input', sync);
      sub.addEventListener('change', () => { nameEl.disabled = !sub.checked; sync(); });
      nameEl.disabled = !sub.checked;
      sync();
      // 弹窗默认把焦点给了第一个按钮，这里抢回到名字输入框，开箱即改。
      setTimeout(() => { if (sub.checked) { nameEl.focus(); nameEl.select(); } else { dest.focus(); } }, 30);
    });
  }

  async function doExtract(indices) {
    if (!S.path || S.busy) return;
    const picked = await askExtractDest(indices);
    if (!picked) return;
    const out = picked.subfolder ? joinPath(picked.dir, picked.folder) : picked.dir;
    S.extract.dir = picked.dir;
    S.extract.openAfter = picked.openAfter;
    API.configSet({
      archive_extract_dir: picked.dir,
      archive_extract_open: picked.openAfter
    }).catch(() => {});
    startOp(T('正在解压…', 'Extracting…'));
    try {
      const report = await API.archiveExtract(S.path, out, indices, S.password || null, S.overwrite, S.create.mode);
      endOp();
      const body = h('div', { class: 'arc-report' },
        h('div', null, T('解压完成', 'Extraction complete')),
        h('div', { class: 'small muted' },
          T('文件 ', 'Files ') + fmtCount(report.files) + ' · ' +
          T('目录 ', 'Folders ') + fmtCount(report.dirs) + ' · ' +
          fmtBytes(report.bytes) + (report.skipped ? ' · ' + T('跳过 ', 'Skipped ') + fmtCount(report.skipped) : '')),
        h('div', { class: 'small muted ellipsis' }, report.outDir)
      );
      modal({
        title: T('解压完成', 'Done'),
        body,
        buttons: [
          { id: 'close', label: T('关闭', 'Close'), kind: 'ghost' },
          { id: 'open', label: T('打开文件夹', 'Open folder'), kind: 'primary' }
        ],
        onClose: (v) => { if (v === 'open') API.openPath(report.outDir).catch(() => {}); }
      });
      if (picked.openAfter) API.openPath(report.outDir).catch(() => {});
    } catch (e) {
      endOp();
      toast(errText(e), 'error');
    }
  }

  async function cancelOp() {
    try { await API.archiveCancel(); toast(T('已请求取消', 'Cancel requested'), 'warn'); } catch { /* ignore */ }
  }

  /* ---------------------------------------------------------------- 进度与速率 */
  const SPEED_SAMPLES = 56;   // 约 90ms 一条事件，56 条 ≈ 5 秒窗口

  /* 每来一条进度事件采样一次：瞬时速率做指数平滑，样本留在环形数组里给折线图用。 */
  function sampleSpeed(p) {
    const st = S.speed;
    const now = performance.now();
    const bytes = Number(p && p.bytes) || 0;
    if (!st.t) {
      // 第一条事件只做基线：先垫一个 0，曲线从底边起步，短任务也能看到爬升。
      st.samples.push(0);
      st.t = now;
      st.bytes = bytes;
      return;
    }
    const dt = now - st.t;
    if (dt < 40) return;                      // 事件太密时丢弃，避免抖动
    const inst = Math.max(0, (bytes - st.bytes) / (dt / 1000));
    st.ema = st.ema ? st.ema * 0.6 + inst * 0.4 : inst;
    st.samples.push(st.ema);
    if (st.samples.length > SPEED_SAMPLES) st.samples.shift();
    st.t = now;
    st.bytes = bytes;
  }

  function fmtDur(sec) {
    if (!isFinite(sec) || sec <= 0) return '';
    if (sec < 1) return T('1 秒内', '<1s');
    const s = Math.round(sec);
    if (s < 60) return T(s + ' 秒', s + 's');
    const m = Math.floor(s / 60);
    const r = s % 60;
    return T(m + ' 分 ' + r + ' 秒', m + 'm ' + r + 's');
  }

  /* 小窗里的速率折线：底板 + 已处理比例的浅色填充 + 速率面积线 + 底部进度线。
     尺寸写死在 viewBox 里，靠 CSS 铺满 320px 宽的小窗，不额外撑大它。 */
  function buildSpeedChart(percent) {
    const st = S.speed;
    const vals = st.samples;
    const W = 296, H = 56, pad = 3;
    const peak = Math.max(1, st.ema, ...vals);
    const n = Math.max(2, vals.length);
    const px = (i) => pad + (i / (n - 1)) * (W - pad * 2);
    const py = (v) => H - pad - Math.min(1, v / peak) * (H - pad * 2 - 12);
    const line = vals.map((v, i) => px(i).toFixed(1) + ',' + py(v).toFixed(1)).join(' ');
    const areaPts = vals.length > 1
      ? '0,' + (H - pad) + ' ' + line + ' ' + px(vals.length - 1).toFixed(1) + ',' + (H - pad)
      : '';
    const fillW = (Math.max(0, Math.min(100, percent)) * W / 100).toFixed(1);
    const svg =
      '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-hidden="true">' +
        '<defs><linearGradient id="arcSpeedFill" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0" stop-color="var(--accent)" stop-opacity=".30"/>' +
          '<stop offset="1" stop-color="var(--accent)" stop-opacity=".03"/>' +
        '</linearGradient></defs>' +
        '<rect x="0" y="0" width="' + fillW + '" height="' + H + '" fill="var(--accent)" opacity=".10"/>' +
        (vals.length > 1
          ? '<polygon points="' + areaPts + '" fill="url(#arcSpeedFill)"/>' +
            '<polyline points="' + line + '" fill="none" stroke="var(--accent)" stroke-width="1.6" ' +
            'stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>'
          : '') +
        '<line x1="0" y1="' + (H - 1) + '" x2="' + fillW + '" y2="' + (H - 1) + '" ' +
          'stroke="var(--accent)" stroke-width="2"/>' +
      '</svg>';

    const p = S.progress;
    const total = p ? Number(p.totalBytes) || 0 : 0;
    const done = p ? Number(p.bytes) || 0 : 0;
    const remain = Math.max(0, total - done);
    const spd = st.ema > 0 ? fmtBytes(st.ema) + '/s' : '';
    const eta = (spd && remain > 0) ? T('剩余 ' + fmtDur(remain / st.ema), fmtDur(remain / st.ema) + ' left') : '';

    const box = h('div', {
      class: 'arc-chart',
      role: 'img',
      'aria-label': (spd ? T('当前速度 ', 'Speed ') + spd : T('速率图', 'Speed chart'))
    });
    box.innerHTML = svg;
    box.appendChild(h('div', { class: 'arc-chart-meta' },
      h('span', null, eta || (vals.length ? T('速度', 'Speed') : T('正在准备…', 'Starting…'))),
      h('span', { class: 'arc-chart-spd' }, spd || '—')));
    return box;
  }

  function renderProgress() {
    if (!els.progress) return;
    const p = S.progress;
    const show = S.busy || !!p;
    els.progress.hidden = !show;
    if (!show) return;
    els.progress.innerHTML = '';
    const bytes = p ? Number(p.bytes) || 0 : 0;
    const totalBytes = p ? Number(p.totalBytes) || 0 : 0;
    const files = p ? Number(p.files) || 0 : 0;
    const totalFiles = p ? Number(p.totalFiles) || 0 : 0;
    const percent = totalBytes ? pct(bytes, totalBytes) : (totalFiles ? pct(files, totalFiles) : 0);

    const isCreate = S.tab === 'create' || (p && p.phase === 'compress');
    const titleName = isCreate
      ? (baseName(S.create.dest || (S.lastCreate && S.lastCreate.path) || '') || T('新建压缩包', 'New archive'))
      : (baseName(S.path) || T('解压任务', 'Extract'));
    const phaseText = (p && p.phase === 'compress') ? T('正在压缩…', 'Compressing…')
      : (p && p.phase === 'extract') ? T('正在解压…', 'Extracting…')
      : (S.opLabel || T('正在处理…', 'Working…'));

    els.progress.appendChild(h('div', { class: 'arc-progress-top' },
      h('div', { class: 'arc-progress-label' }, icon('archive', 15), h('strong', { class: 'ellipsis', title: titleName }, titleName)),
      h('div', { class: 'small muted' },
        (totalFiles ? fmtCount(files) + ' / ' + fmtCount(totalFiles) : fmtCount(files)) + ' · ' +
        fmtBytes(bytes) + (totalBytes ? ' / ' + fmtBytes(totalBytes) : ''))
    ));
    // 速率折线图：解压与压缩统一拥有折线速度波形、剩余预估时间与实时速率
    if (S.speed.samples.length >= 2) {
      els.progress.appendChild(buildSpeedChart(percent));
    } else {
      els.progress.appendChild(h('div', { class: 'arc-bar' },
        h('i', { style: { width: (totalBytes || totalFiles) ? percent + '%' : '34%' } })));
    }
    const currentName = (p && p.name) ? p.name : phaseText;
    els.progress.appendChild(h('div', { class: 'small muted ellipsis', title: currentName }, currentName));
    if (S.busy) {
      const b = h('button', { class: 'btn ghost sm' }, T('取消', 'Cancel'));
      b.onclick = cancelOp;
      els.progress.appendChild(b);
    }
  }

  function openPreview(r) {
    if (!S.info || r.isDir || r.index === null || r.index === undefined) return;
    const seq = ++previewSeq;
    S.preview = null;
    S.previewLoading = true;
    renderPreview();
    API.archivePreview(S.path, r.index, S.password || null, r.name || null, r.size || 0).then((data) => {
      if (destroyed || seq !== previewSeq) return;
      S.preview = data;
      S.previewLoading = false;
      renderPreview();
    }).catch((e) => {
      if (destroyed || seq !== previewSeq) return;
      S.previewLoading = false;
      renderPreview();
      toast(errText(e), 'error');
    });
  }

  function renderPreview() {
    if (!els.side) return;
    const show = !!(S.preview || S.previewLoading);
    els.side.hidden = !show;
    if (els.grid) els.grid.classList.toggle('has-side', show);
    if (!show) return;
    els.side.innerHTML = '';
    if (S.previewLoading) {
      els.side.appendChild(h('div', { class: 'arc-side-head' }, h('strong', null, T('预览', 'Preview'))));
      els.side.appendChild(UI.skeleton(5, 'file'));
      return;
    }
    const d = S.preview;
    const head = h('div', { class: 'arc-side-head' },
      h('span', { class: 'arc-name-in' }, icon(d.kind === 'image' ? 'image' : 'file', 15), h('strong', { class: 'ellipsis' }, d.name || '')),
      h('button', { class: 'btn ghost icon sm', title: T('关闭预览', 'Close preview') }, icon('close', 14))
    );
    head.querySelector('button').onclick = closePreview;
    els.side.appendChild(head);
    const body = h('div', { class: 'arc-side-body' });
    if (d.kind === 'text' || d.kind === 'hex') {
      body.appendChild(h('pre', { class: 'arc-text' }, d.text || ''));
      if (d.kind === 'hex') {
        body.appendChild(h('div', { class: 'small muted' }, d.truncated
          ? T('十六进制预览 · 仅显示前 64 KB', 'Hex preview · first 64 KB only')
          : T('十六进制预览', 'Hex preview')));
      } else if (d.truncated) {
        body.appendChild(h('div', { class: 'small muted' }, T('内容较大，已截断', 'Truncated for preview')));
      }
    } else if (d.kind === 'image') {
      body.appendChild(h('img', { class: 'arc-image', src: assetUrl(d.file), alt: d.name || '' }));
    } else if (d.kind === 'pdf') {
      body.appendChild(h('iframe', { class: 'arc-pdf', src: assetUrl(d.file), title: d.name || 'PDF' }));
    } else if (d.kind === 'audio') {
      body.appendChild(h('audio', { class: 'arc-media', src: assetUrl(d.file), controls: true }));
    } else if (d.kind === 'video') {
      body.appendChild(h('video', { class: 'arc-media', controls: true, src: assetUrl(d.file) }));
    } else {
      body.appendChild(h('div', { class: 'small muted' }, T('这个格式暂不支持内嵌预览。', 'No inline preview for this format.')));
      if (d.file) {
        const b = h('button', { class: 'btn sm' }, T('用系统默认程序打开', 'Open with system app'));
        b.onclick = () => API.openPath(d.file).catch(() => {});
        body.appendChild(b);
      }
    }
    els.side.appendChild(body);
    els.side.appendChild(h('div', { class: 'arc-side-foot small muted' },
      fmtBytes(d.size || 0) + (d.mime ? ' · ' + d.mime : '')));
  }

  /* ---------------------------------------------------------------- 新建视图 */
  function buildCreate() {
    const srcList = h('div', { class: 'arc-src-list' });
    const srcCount = h('span', { class: 'small muted arc-src-count' }, '');
    const addFiles = h('button', { class: 'btn sm' }, icon('plus', 14), T('添加文件', 'Add files'));
    addFiles.onclick = addFilesToCreate;
    const addFolder = h('button', { class: 'btn sm' }, icon('folder', 14), T('添加文件夹', 'Add folder'));
    addFolder.onclick = addFolderToCreate;
    const createTools = h('div', { class: 'arc-path-row arc-create-tools' }, addFiles, addFolder);

    const dest = h('input', {
      class: 'input grow arc-path',
      placeholder: T('选择保存位置', 'Choose destination'),
      value: S.create.dest || ''
    });
    dest.oninput = () => { S.create.dest = dest.value; };
    const destBtn = h('button', { class: 'btn' }, icon('folder', 15), T('浏览', 'Browse'));
    destBtn.onclick = pickDest;

    const fmtBox = h('div', { class: 'arc-choice' });
    const modeBox = h('div', { class: 'arc-modes' });
    const pw = h('input', {
      class: 'input', type: 'password', autocomplete: 'new-password',
      placeholder: T('可选；ZIP / 7Z 支持 AES-256', 'Optional; ZIP / 7Z use AES-256'),
      value: S.create.password || ''
    });
    pw.oninput = () => { S.create.password = pw.value; };
    const make = h('button', { class: 'btn primary' }, icon('archive', 15), T('开始创建', 'Create'));
    make.onclick = createArchive;

    const body = h('div', { class: 'arc-create-body' },
      h('div', { class: 'arc-field' },
        h('span', { class: 'arc-field-label' }, T('保存到', 'Save to')),
        h('div', { class: 'arc-path-row' }, dest, destBtn)),
      h('div', { class: 'arc-field' },
        h('span', { class: 'arc-field-label' }, T('格式', 'Format')),
        fmtBox),
      h('div', { class: 'arc-field' },
        h('span', { class: 'arc-field-label' }, T('性能模式', 'Performance mode')),
        modeBox,
        h('div', { class: 'small muted arc-field-hint' },
          T('7Z 按档位使用 1 / 2 / 4 / 8 线程；ZIP 用 Deflate 级别 6 / 6 / 3 / 1。',
            '7Z uses 1 / 2 / 4 / 8 threads; ZIP uses Deflate level 6 / 6 / 3 / 1.'))),
      h('div', { class: 'arc-field' },
        h('span', { class: 'arc-field-label' }, T('密码', 'Password')),
        pw)
    );

    const view = h('div', { class: 'arc-view', id: 'arc-create', hidden: true },
      h('div', { class: 'arc-last', hidden: true }),
      h('div', { class: 'arc-create-grid' },
        h('section', { class: 'card arc-create-card' },
          h('div', { class: 'arc-card-head' },
            h('h3', null, T('压缩内容', 'Content')),
            srcCount),
          srcList
        ),
        h('section', { class: 'card arc-create-card' },
          h('div', { class: 'arc-card-head' },
            h('h3', null, T('输出设置', 'Output')),
            h('span', { class: 'small muted' }, 'ZIP · 7Z · TAR.GZ')),
          body,
          h('div', { class: 'arc-create-foot' }, make)
        )
      )
    );

    els.create = view; els.srcList = srcList; els.srcCount = srcCount; els.dest = dest;
    els.fmtBox = fmtBox; els.modeBox = modeBox; els.make = make;
    els.lastBox = view.querySelector('.arc-last');
    els.createTools = createTools;
    renderCreateChoices();
    renderLastCreate();
    return view;
  }

  /* 建完的压缩包留在页面顶部：关掉弹窗后仍然看得到「刚才那个已经建好了」，
     不用再回列表里找。下次创建时替换。 */
  function renderLastCreate() {
    const box = els.lastBox;
    if (!box) return;
    const r = S.lastCreate;
    box.innerHTML = '';
    box.hidden = !r;
    if (!r) return;
    const open = h('button', { class: 'btn sm' }, icon('archive', 14), T('打开压缩包', 'Open'));
    open.onclick = () => openArchive(r.path, null);
    const show = h('button', { class: 'btn ghost sm' }, icon('folder', 14), T('在文件夹中显示', 'Show in folder'));
    show.onclick = () => API.reveal(r.path).catch((e) => toast(errText(e), 'error'));
    const hide = h('button', { class: 'btn ghost sm icon', title: T('收起', 'Dismiss'), 'aria-label': T('收起', 'Dismiss') }, icon('close', 14));
    hide.onclick = () => { S.lastCreate = null; renderLastCreate(); };
    box.appendChild(h('div', { class: 'arc-last-card' },
      h('span', { class: 'arc-last-ic' }, icon('archive', 18)),
      h('div', { class: 'arc-last-text' },
        h('div', { class: 'arc-last-title' }, T('已创建：', 'Created: ') + baseName(r.path)),
        h('div', { class: 'small muted ellipsis', title: r.path },
          fmtBytes(r.packed) + ' · ' + fmtCount(r.files) + T(' 个文件', ' files') +
          ' · ' + ((r.elapsedMs || 0) / 1000).toFixed(1) + ' s')),
      h('span', { class: 'spacer' }),
      show, open, hide));
  }

  function renderCreate() {
    if (!els.create) return;
    if (els.dest) els.dest.value = S.create.dest || '';
    renderSources();
    renderCreateChoices();
  }

  function renderSources() {
    if (!els.srcList) return;
    els.srcList.innerHTML = '';
    if (els.srcCount) {
      els.srcCount.textContent = S.create.sources.length
        ? T(fmtCount(S.create.sources.length) + ' 项', fmtCount(S.create.sources.length) + ' items')
        : T('未添加', 'Empty');
    }
    if (!S.create.sources.length) {
      const box = empty(T('还没有添加内容', 'Nothing added'),
        T('添加文件或文件夹，也可以直接拖入窗口', 'Add files or folders, or drop them here'), 'archive');
      box.classList.add('arc-src-empty');
      els.srcList.appendChild(box);
      return;
    }
    S.create.sources.forEach((p, i) => {
      const row = h('div', { class: 'arc-src-row' },
        h('span', { class: 'arc-file-ic' }, icon('file', 14)),
        h('div', { class: 'arc-src-text' },
          h('div', { class: 'ellipsis' }, baseName(p)),
          h('div', { class: 'small muted ellipsis' }, p)
        ),
        h('button', { class: 'btn ghost icon sm', title: T('移除', 'Remove') }, icon('close', 13))
      );
      row.querySelector('button').onclick = () => {
        S.create.sources.splice(i, 1);
        renderSources();
      };
      els.srcList.appendChild(row);
    });
  }

  function renderCreateChoices() {
    if (!els.fmtBox || !els.modeBox) return;
    els.fmtBox.innerHTML = '';
    FORMATS.forEach((f) => {
      const b = h('button', {
        class: 'arc-choice-btn' + (S.create.format === f.id ? ' active' : ''),
        onclick: () => {
          const old = EXT[S.create.format];
          S.create.format = f.id;
          if (S.create.dest && old && S.create.dest.toLowerCase().endsWith(old)) {
            S.create.dest = S.create.dest.slice(0, -old.length) + EXT[f.id];
          }
          renderCreate();
          if (els.dest) els.dest.value = S.create.dest;
        }
      }, h('strong', null, f.zh), h('span', { class: 'small muted' }, f.hint));
      els.fmtBox.appendChild(b);
    });
    els.modeBox.innerHTML = '';
    MODES.forEach((m) => {
      const b = h('button', {
        class: 'arc-mode' + (S.create.mode === m.id ? ' active' : ''),
        onclick: () => {
          S.create.mode = m.id;
          renderCreateChoices();
          API.configSet({ archive_mode: m.id }).catch(() => {});
        }
      }, h('strong', null, T(m.zh, m.en)), h('span', { class: 'small muted' }, m.hint));
      els.modeBox.appendChild(b);
    });
  }

  async function addFilesToCreate() {
    try {
      const list = await API.pickFiles();
      (list || []).forEach((p) => {
        if (!S.create.sources.includes(p)) S.create.sources.push(p);
      });
      if (S.create.sources.length && !S.create.dest) {
        const d = dirName(S.create.sources[0]);
        S.create.dest = (d ? d + '\\' : '') + defaultName();
      }
      renderCreate();
    } catch (e) { toast(errText(e), 'error'); }
  }

  async function addFolderToCreate() {
    try {
      const p = await API.pickFolder();
      if (!p) return;
      if (!S.create.sources.includes(p)) S.create.sources.push(p);
      if (!S.create.dest) {
        const d = dirName(p);
        S.create.dest = (d ? d + '\\' : '') + defaultName();
      }
      renderCreate();
    } catch (e) { toast(errText(e), 'error'); }
  }

  function defaultName() {
    return T('压缩包', 'archive') + EXT[S.create.format];
  }

  async function pickDest() {
    const r = await askSaveDest();
    if (!r) return;
    S.create.dest = joinPath(r.dir, r.name);
    S.create.dir = r.dir;
    if (els.dest) els.dest.value = S.create.dest;
  }

  /* 软件内的「保存压缩包」对话框：和「解压到」一致，不再弹系统另存为。 */
  function askSaveDest() {
    return new Promise((resolve) => {
      const ext = EXT[S.create.format];
      const cur = S.create.dest || '';
      const fallbackDir = S.create.dir
        || (S.create.sources.length ? dirName(S.create.sources[0]) : '')
        || S.extract.dir || '';
      const dirEl = h('input', {
        class: 'input grow',
        placeholder: T('例如 D:\\下载', 'e.g. D:\\Downloads'),
        value: cur ? dirName(cur) : fallbackDir
      });
      const nameEl = h('input', { class: 'input', value: cur ? baseName(cur) : defaultName() });
      const target = h('code', { class: 'xdlg-path' }, '');
      const errEl = h('div', { class: 'xdlg-err' }, '');

      const browse = h('button', { class: 'btn', type: 'button' }, icon('folder', 15), T('浏览', 'Browse'));
      browse.onclick = async () => {
        try {
          const p = await API.pickFolder(dirEl.value.trim() || fallbackDir || undefined);
          if (p) { dirEl.value = p; sync(); }
        } catch (e) { toast(errText(e), 'error'); }
      };

      const body = h('div', { class: 'xdlg' },
        h('div', { class: 'xdlg-src' },
          icon('archive', 16),
          h('span', { class: 'ellipsis' }, T('新建压缩包', 'New archive')),
          h('span', { class: 'small muted' }, fmtCount(S.create.sources.length) + T(' 项', ' items') + ' · ' + S.create.format.toUpperCase())),
        h('div', { class: 'arc-field' },
          h('span', { class: 'arc-field-label' }, T('保存到', 'Save to')),
          h('div', { class: 'arc-path-row' }, dirEl, browse)),
        h('div', { class: 'arc-field' },
          h('span', { class: 'arc-field-label' }, T('文件名', 'File name')),
          nameEl),
        h('div', { class: 'xdlg-target' }, icon('archive', 14), target),
        errEl
      );

      function normalized() {
        let name = nameEl.value.trim();
        // 只认已知压缩后缀：备份.2024 这种带点但没后缀的名字要补成 备份.2024.zip
        if (name && !ARCHIVE_SUFFIX.test(name)) name += ext;
        return { dir: dirEl.value.trim(), name, out: joinPath(dirEl.value.trim(), name) };
      }
      function validate() {
        const p = normalized();
        if (!p.dir) return T('请选择保存位置', 'Choose where to save');
        if (!isAbsPath(p.dir)) return T('请填写完整路径，例如 D:\\下载', 'Enter a full path, e.g. D:\\Downloads');
        if (!p.name) return T('文件名不能为空', 'File name is required');
        if (BAD_FOLDER_CHARS.test(p.name)) return T('文件名不能包含 \\ / : * ? " < > |', 'Name cannot contain \\ / : * ? " < > |');
        return '';
      }
      function sync() {
        target.textContent = normalized().out || '—';
        errEl.textContent = validate();
        if (m) {
          const ok = m.el.querySelector('.modal-foot .btn.primary');
          if (ok) ok.disabled = !!validate();
        }
      }

      let settled = false;
      const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
      const submit = () => {
        const bad = validate();
        if (bad) { errEl.textContent = bad; dirEl.focus(); return false; }
        const p = normalized();
        finish({ dir: p.dir, name: p.name });
        return true;
      };

      let m = null;
      m = modal({
        title: T('保存压缩包', 'Save archive'),
        wide: true,
        body,
        buttons: [
          { id: 'cancel', label: T('取消', 'Cancel'), kind: 'ghost' },
          { id: 'ok', label: T('确定', 'OK'), kind: 'primary' }
        ],
        onAction: (id) => (id === 'ok' ? submit() : true),
        onClose: () => finish(null)
      });

      const onEnter = (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        if (submit()) m.close('ok');
      };
      dirEl.addEventListener('keydown', onEnter);
      nameEl.addEventListener('keydown', onEnter);
      dirEl.addEventListener('input', sync);
      nameEl.addEventListener('input', sync);
      sync();
      setTimeout(() => { nameEl.focus(); nameEl.select(); }, 30);
    });
  }

  async function createArchive() {
    if (S.busy) return;
    const sources = S.create.sources.slice();
    if (!sources.length) { toast(T('先添加要压缩的文件或文件夹', 'Add something first'), 'warn'); return; }
    let dest = S.create.dest;
    if (!dest) {
      const r = await askSaveDest();
      if (!r) return;
      dest = joinPath(r.dir, r.name);
      S.create.dest = dest;
      S.create.dir = r.dir;
      if (els.dest) els.dest.value = dest;
    }
    if (!ARCHIVE_SUFFIX.test(dest)) dest += EXT[S.create.format];
    if (!dest.toLowerCase().endsWith(EXT[S.create.format])) {
      const ok = await confirm({
        title: T('扩展名与格式不一致', 'Extension mismatch'),
        body: T('目标文件扩展名不是 ' + EXT[S.create.format] + '，仍要继续吗？', 'The extension is not ' + EXT[S.create.format] + '. Continue?'),
        ok: T('继续', 'Continue')
      });
      if (!ok) return;
    }
    S.create.dest = dest;
    S.create.dir = dirName(dest);
    if (els.dest) els.dest.value = dest;
    API.configSet({ archive_create_dir: S.create.dir }).catch(() => {});
    const pw = (S.create.format === 'zip' || S.create.format === '7z') ? (S.create.password || null) : null;
    startOp(T('正在创建压缩包…', 'Creating archive…'));
    try {
      const report = await API.archiveCreate(sources, dest, S.create.format, S.create.mode, pw);
      endOp();
      S.report = report;
      S.lastCreate = report;
      renderLastCreate();
      // 创建完的压缩包是从待压缩列表里「出货」了：清掉列表，避免再点一次生成重复包
      S.create.sources = [];
      S.create.dest = '';
      if (els.dest) els.dest.value = '';
      renderSources();
      toast(T('压缩包已创建：' + baseName(report.path), 'Archive created: ' + baseName(report.path)), 'ok', 6000);
      const body = h('div', { class: 'arc-report' },
        h('div', { class: 'arc-report-name' }, icon('archive', 18),
          h('span', { class: 'ellipsis', title: report.path }, baseName(report.path))),
        h('div', { class: 'small muted' },
          fmtBytes(report.packed) + ' · ' + fmtCount(report.files) + T(' 个文件', ' files') + ' · ' + ((report.elapsedMs || 0) / 1000).toFixed(1) + ' s'),
        h('div', { class: 'small muted ellipsis', title: report.path }, report.path)
      );
      modal({
        title: T('压缩包已创建', 'Archive created'),
        body,
        buttons: [
          { id: 'close', label: T('关闭', 'Close'), kind: 'ghost' },
          { id: 'reveal', label: T('在文件夹中显示', 'Show in folder'), kind: 'ghost' },
          { id: 'open', label: T('打开压缩包', 'Open archive'), kind: 'primary' }
        ],
        onClose: (v) => {
          if (v === 'open') openArchive(report.path, null);
          if (v === 'reveal') API.reveal(report.path).catch(() => {});
        }
      });
    } catch (e) {
      endOp();
      toast(errText(e), 'error');
    }
  }

  /* ---------------------------------------------------------------- 拖放 */
  /* Tauri 接管了 WebView 的原生拖放（dragDropEnabled 默认开），HTML5 的
     dragenter/drop 收不到事件，所以只能监听 webview 的 drag-drop 通道。 */
  function buildDropLayer() {
    const title = h('strong', { class: 'arc-drop-title' }, '');
    const sub = h('span', { class: 'arc-drop-sub' }, '');
    const layer = h('div', { class: 'arc-drop', 'aria-hidden': 'true' },
      h('div', { class: 'arc-drop-card' },
        h('div', { class: 'arc-drop-ic' }, icon('archive', 26)),
        title, sub));
    layer.titleEl = title;
    layer.subEl = sub;
    return layer;
  }

  function syncDropText() {
    if (!dropLayer || !dropLayer.titleEl) return;
    const creating = S.tab === 'create';
    dropLayer.titleEl.textContent = creating
      ? T('松开以添加文件', 'Drop to add files')
      : T('松开以打开压缩包', 'Drop to open the archive');
    dropLayer.subEl.textContent = creating
      ? T('文件和文件夹会加入待压缩列表', 'Files and folders are added to the list')
      : T('支持 ZIP / 7Z / TAR / RAR 等格式', 'ZIP / 7Z / TAR / RAR and more');
  }

  function showDrop(on) {
    if (!dropLayer) return;
    const want = !!on;
    if (dropLayer.classList.contains('on') === want) return;
    dropLayer.classList.toggle('on', want);
    dropLayer.setAttribute('aria-hidden', want ? 'false' : 'true');
  }

  function handleDrop(paths) {
    const list = (paths || []).filter(Boolean);
    if (!list.length) return;
    if (S.tab === 'create') {
      let added = 0;
      list.forEach((p) => {
        if (!S.create.sources.includes(p)) { S.create.sources.push(p); added++; }
      });
      if (!S.create.dest) S.create.dest = (dirName(list[0]) ? dirName(list[0]) + '\\' : '') + defaultName();
      renderCreate();
      if (added) toast(T('已添加 ' + added + ' 项', 'Added ' + added + ' item(s)'), 'ok');
      else toast(T('这些项目已经在列表里', 'Those items are already listed'), 'info');
      return;
    }
    const archive = list.find(isArchivePath);
    if (!archive) {
      toast(T('拖入的不是支持的压缩包格式', 'That is not a supported archive'), 'warn');
      return;
    }
    if (list.length > 1) toast(T('一次只打开一个，已打开第一个', 'Opening the first archive'), 'info');
    openArchive(archive, null);
  }

  async function bindDropTarget() {
    const tauri = window.__TAURI__;
    if (!tauri) return;
    let view = null;
    try {
      view = tauri.webview && tauri.webview.getCurrentWebview
        ? tauri.webview.getCurrentWebview()
        : tauri.webviewWindow && tauri.webviewWindow.getCurrentWebviewWindow();
    } catch { view = null; }
    if (!view || typeof view.onDragDropEvent !== 'function') return;
    try {
      const off = await view.onDragDropEvent((ev) => {
        if (destroyed) return;
        const p = (ev && ev.payload) || {};
        if (p.type === 'enter' || p.type === 'over') {
          syncDropText();
          showDrop(true);
        } else if (p.type === 'drop') {
          showDrop(false);
          handleDrop(p.paths);
        } else {
          showDrop(false);
        }
      });
      // 页面在注册完成前就被切走时，立刻退订，避免留下悬空监听。
      if (destroyed) { try { off(); } catch { /* ignore */ } }
      else dropUnlisten = off;
    } catch { dropUnlisten = null; }
  }

  /* ---------------------------------------------------------------- 生命周期 */
  async function mount(node) {
    destroyed = false;
    root = node;
    root.classList.add('arc-page');
    root.innerHTML = '';

    els = {};
    const tabs = h('div', { class: 'arc-tabs' });
    els.tabs = tabs;
    const open = buildOpen();
    const create = buildCreate();
    const headTools = h('div', { class: 'arc-head-tools' }, els.pathRow || null, els.createTools || null);
    els.headTools = headTools;
    const head = h('div', { class: 'arc-head' }, tabs, headTools);
    /* 页头固定、视图占满剩余高度：包一层 page-fill，页面本体就不再整页滚动，
       滚动交给 .arc-table-wrap（虚拟列表按它自己的 scrollTop 取窗口）。 */
    const body = h('div', { class: 'stack page-fill arc-body' }, head, open, create);
    root.appendChild(body);
    if (els.progress) root.appendChild(els.progress);
    renderTabs();
    renderViews();

    try {
      if (window.__TAURI__ && window.__TAURI__.event) {
        unlisten = await window.__TAURI__.event.listen('archive-progress', (ev) => {
          if (destroyed) return;
          S.progress = ev.payload || {};
          sampleSpeed(S.progress);
          renderProgress();
        });
      }
    } catch { /* 事件不可用时仍有返回结果 */ }

    try {
      const cfg = await API.configGet();
      if (['saver', 'balanced', 'performance', 'hyper'].includes(cfg && cfg.archive_mode)) {
        S.create.mode = cfg.archive_mode;
        renderCreateChoices();
      }
      if (cfg) {
        if (typeof cfg.archive_extract_dir === 'string') S.extract.dir = cfg.archive_extract_dir;
        if (typeof cfg.archive_extract_open === 'boolean') S.extract.openAfter = cfg.archive_extract_open;
        if (typeof cfg.archive_create_dir === 'string') S.create.dir = cfg.archive_create_dir;
      }
    } catch { /* ignore */ }

    refreshRar();
    if (S.info) renderOpen();
    setActions();

    dropLayer = buildDropLayer();
    document.body.appendChild(dropLayer);
    bindDropTarget();

    keyHandler = (e) => {
      if (e.key === 'Escape' && S.preview) closePreview();
    };
    document.addEventListener('keydown', keyHandler);

    return unmount;
  }

  function unmount() {
    destroyed = true;
    if (S.busy) {
      // 离开页面会中断任务：把状态收干净，回到本页时不能停在「永远处理中」
      API.archiveCancel().catch(() => {});
      S.busy = false;
      S.opLabel = '';
      S.progress = null;
    }
    if (unlisten) { try { unlisten(); } catch { /* ignore */ } unlisten = null; }
    if (dropUnlisten) { try { dropUnlisten(); } catch { /* ignore */ } dropUnlisten = null; }
    if (dropLayer) { dropLayer.remove(); dropLayer = null; }
    if (keyHandler) { document.removeEventListener('keydown', keyHandler); keyHandler = null; }
    if (S.preview) API.archivePreviewClear().catch(() => {});
    S.preview = null;
    if (S.scrollRaf) { cancelAnimationFrame(S.scrollRaf); S.scrollRaf = 0; }
    if (S.tableRO) { try { S.tableRO.disconnect(); } catch { /* ignore */ } S.tableRO = null; }
    root = null;
    els = {};
  }

  window.Pages = window.Pages || {};
  window.Pages.archive = {
    title: ['压缩包', 'Archives'],
    subtitle: ['压缩、解压与查看', 'Compress, extract, preview'],
    mount,
    /* AI 说「这几个压缩包可以看看」时，跳进来要直接把这个包打开，
       而不是停在一个让你自己再选一次的空页面。 */
    jump(payload) {
      const paths = ((payload && payload.paths) || []).filter(Boolean).map(String);
      const arc = paths.find((p) => /\.(zip|rar|7z|tar|gz|tgz|bz2|xz|zst)$/i.test(p));
      if (!arc) return undefined;
      const run = openArchive(arc, null);
      return run && typeof run.catch === 'function' ? run.catch(() => {}) : run;
    }
  };
})();
