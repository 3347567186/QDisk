/* 压缩包：打开 / 解压 / 预览 / 新建
 * 全部走 Rust 侧 archive_* 命令，不经过 Python 引擎。
 * 列表与进度都只在本地 DOM 更新，十万条目也不会碰引擎 RPC。 */
(function () {
  'use strict';

  const { h, T, icon, fmtBytes, fmtCount, toast, empty, modal, confirm, setActions, busy } = UI;
  const errText = UI.errText;

  const MODES = [
    { id: 'saver', zh: '节约', en: 'Saver', hint: T('单核低占 · 约 25% 负载，省电静音', 'Single core · ~25% load, quiet') },
    { id: 'balanced', zh: '平衡', en: 'Balanced', hint: T('均衡阶梯 · 约 50% 负载，体积速度兼顾', 'Balanced · ~50% load') },
    { id: 'performance', zh: '高性能', en: 'Performance', hint: T('多核加速 · 约 75% 负载，媒体免重压', 'Multi-core · ~75% load, smart store') },
    { id: 'hyper', zh: '超线程', en: 'Hyper', hint: T('满核全速 · 100% 零限速极速引擎', 'All cores · 100% unthrottled') }
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
    caps: null,
    rar: null,
    rarBusy: false,
    busy: false,
    paused: false,
    pauseLock: '',
    cancelling: false,
    cancelSentAt: 0,
    opKind: '',
    activeMode: 'balanced',
    opLabel: '',
    progress: null,
    /* 实时速率：每来一条 archive-progress 采样一次，画成小窗里的折线 */
    speed: { t: 0, bytes: 0, ema: 0, samples: [] },
    overwrite: 'rename',
    extract: { dir: '', openAfter: true },
    create: { sources: [], dest: '', dir: '', format: 'zip', mode: 'balanced', password: '' },
    report: null,
    lastCreate: null,
    lastExtract: null,
    activeUndoId: null,
    undoBusy: false,
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
  let mountGen = 0;
  let keyHandler = null;
  const hooks = new Map();

  function onHook(event, fn) {
    if (typeof event !== 'string' || !event || typeof fn !== 'function') return () => {};
    let set = hooks.get(event);
    if (!set) { set = new Set(); hooks.set(event, set); }
    set.add(fn);
    return () => offHook(event, fn);
  }

  function offHook(event, fn) {
    const set = hooks.get(event);
    if (!set) return;
    if (fn) set.delete(fn);
    else set.clear();
    if (!set.size) hooks.delete(event);
  }

  function cloneCaps(caps) {
    if (!caps || typeof caps !== 'object') return null;
    try { return JSON.parse(JSON.stringify(caps)); } catch { return Object.assign({}, caps); }
  }

  function emitHook(event, payload) {
    const set = hooks.get(event);
    if (!set || !set.size) return;
    for (const fn of Array.from(set)) {
      try { fn(payload); } catch { /* 外部扩展钩子异常不得阻断核心流程 */ }
    }
  }

  function modeHint(m) {
    const caps = S.caps;
    const spec = caps && Array.isArray(caps.modes)
      ? caps.modes.find((x) => x && x.id === m.id)
      : null;
    if (!spec || !Number.isFinite(spec.threads)) return m.hint;
    const threads = Math.max(1, Math.round(spec.threads));
    const duty = Number.isFinite(spec.ioDutyPct) ? Math.round(spec.ioDutyPct) : null;
    if (m.id === 'saver') {
      return T(`${threads} 核 · 约 ${duty || 25}% 负载，省电静音`, `${threads} core · ~${duty || 25}% load, quiet`);
    }
    if (m.id === 'balanced') {
      return T(`${threads} 核 · 约 ${duty || 50}% 负载，体积速度兼顾`, `${threads} cores · ~${duty || 50}% load, balanced`);
    }
    if (m.id === 'performance') {
      return T(`${threads} 核 · 约 ${duty || 75}% 负载，媒体免重压`, `${threads} cores · ~${duty || 75}% load, smart store`);
    }
    if (m.id === 'hyper') {
      return T(`${threads} 核满核 · 100% 零限速极速引擎`, `${threads} cores · 100% unthrottled`);
    }
    return m.hint;
  }

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

  const BAD_FOLDER_CHARS = /[<>:"/\\|?*\u0000-\u001f]/;
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

  function modeLabel(id) {
    const m = MODES.find((x) => x.id === id) || MODES[1];
    return T(m.zh, m.en);
  }

  function startOp(label, kind) {
    S.busy = true;
    S.paused = false;
    S.pauseLock = '';
    S.cancelling = false;
    S.opKind = kind || '';
    S.activeMode = S.create.mode || 'balanced';
    S.opLabel = label || T('正在处理…', 'Working…');
    S.progress = null;
    S.speed = { t: 0, bytes: 0, ema: 0, samples: [] };
    renderProgress();
    renderLastExtract();
    renderLastCreate();
  }

  function endOp() {
    S.busy = false;
    S.paused = false;
    S.pauseLock = '';
    S.cancelling = false;
    S.opKind = '';
    S.opLabel = '';
    S.progress = null;
    renderProgress();
    renderLastExtract();
    renderLastCreate();
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
    els.modeSel = modeSel;
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
    const lastExtractBox = h('div', { class: 'arc-last', hidden: true });
    const view = h('div', { class: 'arc-view', id: 'arc-open' }, lastExtractBox, grid);

    els.open = view; els.path = path; els.meta = meta; els.rar = rar;
    els.lastExtractBox = lastExtractBox;
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
    renderLastExtract();
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
    if (S.busy) {
      toast(T('当前有压缩或解压任务正在进行，请先等待完成或取消', 'An archive operation is running; wait or cancel first'), 'warn');
      return;
    }
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
    startOp(T('正在读取压缩包…', 'Reading archive…'), 'open');
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
          if (entered !== null && entered !== '') { pw = entered; startOp(T('正在读取压缩包…', 'Reading archive…'), 'open'); continue; }
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

  function releasePreviewMedia() {
    if (!els.side) return;
    if (UI && typeof UI.releaseMediaHandles === 'function') {
      UI.releaseMediaHandles(els.side);
      return;
    }
    try {
      els.side.querySelectorAll('video, audio').forEach((m) => {
        try { m.pause(); } catch (_) {}
        try { m.removeAttribute('src'); m.load(); } catch (_) {}
      });
      els.side.querySelectorAll('iframe').forEach((f) => {
        try { f.setAttribute('src', 'about:blank'); } catch (_) {}
      });
    } catch (_) {}
  }

  function closePreview() {
    previewSeq += 1; // 关掉之后别再让在途请求把面板弹回来
    releasePreviewMedia();
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

  /* 软件内的「解压到」对话框：支持「直接解压 / 同名文件夹 / 自定义新建文件夹」，
     输入文件夹名称后在解压时自动创建并实时预览完整目标路径。 */
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
      const defaultName = sameRoot ? root : (soloStem || stem);

      let folderMode = sameRoot ? 'none' : 'same'; // 'none' | 'same' | 'custom'
      let customDraft = '';

      const nameEl = h('input', {
        class: 'input grow',
        placeholder: T('输入文件夹名称，解压时自动创建', 'Enter folder name (auto-created on extract)'),
        value: defaultName
      });
      const openCb = h('input', { type: 'checkbox', checked: S.extract.openAfter !== false });
      const target = h('code', { class: 'xdlg-path' }, '');
      const autoBadge = h('span', { class: 'badge accent xdlg-auto-badge' }, T('自动创建', 'Auto-create'));
      const errEl = h('div', { class: 'xdlg-err' }, '');
      const hint = h('div', { class: 'small muted xdlg-hint' }, '');

      const browse = h('button', { class: 'btn', type: 'button' }, icon('folder', 15), T('浏览', 'Browse'));
      browse.onclick = async () => {
        try {
          const p = await API.pickFolder(dest.value.trim() || S.extract.dir || dirName(S.path) || undefined);
          if (p) { dest.value = p; sync(); }
        } catch (e) { toast(errText(e), 'error'); }
      };

      const modeNoneBtn = h('button', {
        type: 'button',
        class: 'xdlg-mode',
        'aria-pressed': 'false',
        onclick: () => setMode('none', false)
      }, T('直接解压', 'Direct'));
      const modeSameBtn = h('button', {
        type: 'button',
        class: 'xdlg-mode',
        'aria-pressed': 'false',
        onclick: () => setMode('same', true)
      }, T('同名文件夹', 'Same-name'));
      const modeCustomBtn = h('button', {
        type: 'button',
        class: 'xdlg-mode',
        'aria-pressed': 'false',
        onclick: () => setMode('custom', true)
      }, T('自定义新建文件夹', 'Custom new folder'));

      const resetNameBtn = h('button', {
        type: 'button',
        class: 'btn ghost sm',
        title: T('恢复为压缩包同名文件夹', 'Reset to archive name'),
        onclick: () => setMode('same', false)
      }, T('用同名', 'Use archive name'));

      const clearNameBtn = h('button', {
        type: 'button',
        class: 'btn ghost sm icon',
        title: T('清空名称', 'Clear name'),
        'aria-label': T('清空名称', 'Clear name'),
        onclick: () => {
          customDraft = '';
          nameEl.value = '';
          folderMode = 'custom';
          sync();
          nameEl.focus();
        }
      }, icon('close', 12));

      const nameRow = h('div', { class: 'xdlg-name-row' }, nameEl, resetNameBtn, clearNameBtn);

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
            h('div', { class: 'xdlg-modes' }, modeNoneBtn, modeSameBtn, modeCustomBtn),
            nameRow)),
        hint,
        h('div', { class: 'xdlg-target' }, icon('folder', 14), target, autoBadge),
        errEl,
        h('label', { class: 'check' }, openCb, h('span', null, T('完成后打开文件夹', 'Open the folder when done')))
      );

      function setMode(mode, focusInput) {
        if (folderMode === 'custom') customDraft = nameEl.value;
        folderMode = mode;
        if (mode === 'same') {
          nameEl.value = defaultName;
        } else if (mode === 'custom') {
          nameEl.value = customDraft || defaultName;
        }
        sync();
        if (focusInput && mode !== 'none') {
          nameEl.focus();
          if ((mode === 'same' || !customDraft) && typeof nameEl.select === 'function') nameEl.select();
        }
      }

      function peek() {
        const dir = dest.value.trim();
        const name = nameEl.value.trim();
        const subOn = folderMode !== 'none';
        return { dir, name, mode: folderMode, subOn, out: subOn ? joinPath(dir, name) : dir };
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
        modeNoneBtn.classList.toggle('on', folderMode === 'none');
        modeNoneBtn.setAttribute('aria-pressed', folderMode === 'none' ? 'true' : 'false');
        modeSameBtn.classList.toggle('on', folderMode === 'same');
        modeSameBtn.setAttribute('aria-pressed', folderMode === 'same' ? 'true' : 'false');
        modeCustomBtn.classList.toggle('on', folderMode === 'custom');
        modeCustomBtn.setAttribute('aria-pressed', folderMode === 'custom' ? 'true' : 'false');

        nameRow.hidden = !p.subOn;
        nameEl.disabled = !p.subOn;
        resetNameBtn.hidden = !(folderMode === 'custom' && p.name !== defaultName);
        clearNameBtn.hidden = !nameEl.value.length;

        const nameOk = p.subOn && !folderNameError(p.name);
        autoBadge.hidden = !nameOk;
        target.textContent = p.out || '—';
        errEl.textContent = validate();
        if (folderMode === 'custom') {
          const base = p.name
            ? T('解压时会自动新建文件夹「' + p.name + '」，内容将放入其中。',
              'Folder “' + p.name + '” will be created automatically on extract.')
            : T('请输入新建文件夹名称，解压时会自动创建。',
              'Enter a folder name to auto-create on extract.');
          hint.textContent = root
            ? base + ' ' + T('（提示：压缩包内已自带顶层目录「' + root + '」）', '(Note: archive already has top folder “' + root + '”)')
            : base;
        } else if (folderMode === 'same') {
          hint.textContent = T('自动新建「' + p.name + '」并将压缩包内容解压入内。',
            'Auto-creates “' + p.name + '” and extracts files inside.');
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
        const p = peek();
        const bad = validate();
        if (bad) {
          errEl.textContent = bad;
          if (p.subOn && folderNameError(p.name)) nameEl.focus();
          else dest.focus();
          return false;
        }
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
      nameEl.addEventListener('input', () => {
        if (folderMode === 'same' && nameEl.value.trim() !== defaultName) folderMode = 'custom';
        if (folderMode === 'custom') customDraft = nameEl.value;
        sync();
      });
      sync();
      // 弹窗默认把焦点给了第一个按钮，这里抢回到文件夹命名输入框或路径框，开箱即改。
      setTimeout(() => { if (folderMode !== 'none') { nameEl.focus(); if (typeof nameEl.select === 'function') nameEl.select(); } else { dest.focus(); } }, 30);
    });
  }

  function askExtractConflict(conflict, out, picked) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      const targetName = baseName(out) || out;
      const summaryText = conflict.outDirIsFile
        ? T(`目标位置已存在同名文件「${targetName}」，无法在此处创建文件夹。`,
            `A file named "${targetName}" already exists here, so a folder cannot be created at this path.`)
        : (picked.subfolder && conflict.outDirExists)
          ? T(`目标文件夹「${targetName}」已存在（检测到 ${fmtCount(conflict.dirConflicts)} 个文件夹、${fmtCount(conflict.fileConflicts)} 个文件冲突）。`,
              `Target folder "${targetName}" already exists (${fmtCount(conflict.dirConflicts)} folder and ${fmtCount(conflict.fileConflicts)} file conflicts).`)
          : T(`目标位置已存在同名内容：${fmtCount(conflict.dirConflicts)} 个文件夹、${fmtCount(conflict.fileConflicts)} 个文件。`,
              `Conflicts found at destination: ${fmtCount(conflict.dirConflicts)} folders, ${fmtCount(conflict.fileConflicts)} files.`);

      const samples = Array.isArray(conflict.samples) ? conflict.samples : [];
      const listEl = samples.length
        ? h('div', { class: 'arc-conflict-list' },
            ...samples.map((s) => h('div', { class: 'arc-conflict-item' },
              h('span', { class: 'arc-conflict-tag' + (s.isDir ? ' is-dir' : '') },
                s.isDir ? T('文件夹', 'Folder') : T('文件', 'File')),
              h('span', { class: 'ellipsis', title: s.name }, s.name)
            ))
          )
        : null;

      const coexistHint = (picked.subfolder && (conflict.outDirExists || conflict.outDirIsFile) && conflict.suggestedOutDir)
        ? T(`选择「二者并存」将自动新建「${baseName(conflict.suggestedOutDir)}」，完整保留原有内容。`,
            `Choosing "Keep both" will extract into "${baseName(conflict.suggestedOutDir)}" without touching existing items.`)
        : T('选择「二者并存」会自动为冲突的文件与顶层文件夹追加序号（如 (2)），完整保留原有内容。',
            'Choosing "Keep both" auto-renames conflicting files and top-level folders (e.g. (2)), leaving existing items untouched.');

      const body = h('div', { class: 'arc-conflict-box' },
        h('div', { class: 'arc-conflict-summary' }, summaryText),
        listEl,
        h('div', { class: 'small muted' }, coexistHint),
        conflict.outDirIsFile
          ? h('div', { class: 'small muted' }, T('该路径为普通文件，无法直接覆盖为文件夹。', 'Cannot overwrite a regular file as a directory.'))
          : h('div', { class: 'small muted' }, T('选择「直接覆盖」会替换同名文件（解压后仍可点击「撤回解压」还原原文件）。', 'Choosing "Overwrite" replaces matching files (you can still click Undo afterwards to restore them).'))
      );

      const buttons = [{ id: 'cancel', label: T('取消', 'Cancel'), kind: 'ghost' }];
      if (!conflict.outDirIsFile) {
        buttons.push({ id: 'overwrite', label: T('直接覆盖', 'Overwrite'), kind: 'danger' });
      }
      buttons.push({ id: 'rename', label: T('二者并存（自动重命名）', 'Keep both (auto-rename)'), kind: 'primary' });

      const m = modal({
        title: T('发现同名文件或文件夹', 'Existing files or folders found'),
        body,
        wide: true,
        buttons,
        onClose: (v) => done(v === 'rename' || v === 'overwrite' ? v : null)
      });
      // 遵循安全默认原则：焦点给非破坏性的「二者并存」，绝不默认聚焦「直接覆盖」
      const safeBtn = m.el.querySelector('.btn.primary');
      if (safeBtn) safeBtn.focus();
    });
  }

  function askCreateConflict(conflict, dest) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      const curName = baseName(dest) || dest;
      const nextName = baseName(conflict.suggestedDest || dest) || dest;
      const summaryText = conflict.isDir
        ? T(`目标路径「${curName}」是一个已存在的文件夹，无法直接覆盖为压缩包。`,
            `Destination "${curName}" is an existing folder and cannot be overwritten.`)
        : T(`目标位置已存在同名压缩包「${curName}」（${fmtBytes(conflict.size || 0)} · ${conflict.modified || '—'}）。`,
            `An archive named "${curName}" already exists (${fmtBytes(conflict.size || 0)} · ${conflict.modified || '—'}).`);

      const body = h('div', { class: 'arc-conflict-box' },
        h('div', { class: 'arc-conflict-summary' }, summaryText),
        h('div', { class: 'arc-conflict-list' },
          h('div', { class: 'arc-conflict-item' },
            h('span', { class: 'arc-conflict-tag' + (conflict.isDir ? ' is-dir' : '') },
              conflict.isDir ? T('文件夹', 'Folder') : T('已有文件', 'Existing')),
            h('span', { class: 'ellipsis', title: dest }, dest)
          ),
          h('div', { class: 'arc-conflict-item' },
            h('span', { class: 'arc-conflict-tag is-new' }, T('新文件名', 'New name')),
            h('span', { class: 'ellipsis', title: conflict.suggestedDest || dest }, nextName)
          )
        ),
        h('div', { class: 'small muted' },
          T(`选择「二者并存」将保存为「${nextName}」；`, `Choosing "Keep both" saves as "${nextName}"; `) +
          (conflict.isDir
            ? T('目标为文件夹，不支持直接覆盖。', 'direct overwrite is unavailable for folders.')
            : T('选择「直接覆盖」会替换原文件（完成后仍可点击「撤回压缩」还原旧包）。', 'choosing "Overwrite" replaces the old file (Undo can restore it).')))
      );

      const buttons = [{ id: 'cancel', label: T('取消', 'Cancel'), kind: 'ghost' }];
      if (!conflict.isDir) {
        buttons.push({ id: 'overwrite', label: T('直接覆盖', 'Overwrite'), kind: 'danger' });
      }
      buttons.push({ id: 'rename', label: T('二者并存（自动重命名）', 'Keep both (auto-rename)'), kind: 'primary' });

      const m = modal({
        title: T('目标压缩包已存在', 'Archive already exists'),
        body,
        wide: true,
        buttons,
        onClose: (v) => done(v === 'rename' || v === 'overwrite' ? v : null)
      });
      const safeBtn = m.el.querySelector('.btn.primary');
      if (safeBtn) safeBtn.focus();
    });
  }

  function formatUndoSummary(urep) {
    const parts = [];
    if (urep.removedFiles) parts.push(T(`删除 ${fmtCount(urep.removedFiles)} 个新建文件`, `removed ${fmtCount(urep.removedFiles)} files`));
    if (urep.removedDirs) parts.push(T(`清理 ${fmtCount(urep.removedDirs)} 个新建目录`, `cleaned ${fmtCount(urep.removedDirs)} folders`));
    if (urep.restoredFiles) parts.push(T(`还原 ${fmtCount(urep.restoredFiles)} 个被覆盖文件`, `restored ${fmtCount(urep.restoredFiles)} files`));
    if (urep.skipped) parts.push(T(`保留 ${fmtCount(urep.skipped)} 项已修改或原有内容`, `kept ${fmtCount(urep.skipped)} modified/existing items`));
    return parts.length ? parts.join(' · ') : T('未发现需要变更的文件', 'Nothing to revert');
  }

  function discardUndoIfActive(record) {
    if (!record || !record.undoId || record.undone || record.undoId !== S.activeUndoId) return;
    const id = record.undoId;
    S.activeUndoId = null;
    if (typeof API.archiveUndoDiscard === 'function') {
      API.archiveUndoDiscard(id).catch(() => {});
    }
  }

  async function runUndo(record, kind) {
    if (!record || !record.undoId || record.undone || S.undoBusy) return;
    if (record.undoId !== S.activeUndoId) {
      toast(T('仅保留最近一次操作的可撤回记录，该记录已过期', 'Only the most recent operation can be undone'), 'warn');
      renderLastExtract();
      renderLastCreate();
      return;
    }
    if (S.busy) {
      toast(T('当前有任务正在运行，请稍后再撤回', 'Wait for the running task to finish before undoing'), 'warn');
      return;
    }
    S.undoBusy = true;
    renderLastExtract();
    renderLastCreate();
    try {
      await busy(async () => {
        try {
          const urep = await API.archiveUndo(record.undoId);
          record.undone = true;
          record.undoReport = urep;
          record.undoSummary = formatUndoSummary(urep);
          if (S.activeUndoId === record.undoId) S.activeUndoId = null;
          S.undoBusy = false;
          renderLastExtract();
          renderLastCreate();
          emitHook('undo:done', { kind, record, report: urep });
          const label = kind === 'create' ? T('已撤回压缩：', 'Reverted compression: ') : T('已撤回解压：', 'Reverted extraction: ');
          const hasWarn = Array.isArray(urep.warnings) && urep.warnings.length > 0;
          toast(label + record.undoSummary + (hasWarn ? `（${urep.warnings[0]}）` : ''), hasWarn ? 'warn' : 'ok', 6500);
        } catch (e) {
          const msg = errText(e);
          if (/未找到可撤回记录/.test(msg) && S.activeUndoId === record.undoId) {
            S.activeUndoId = null;
          }
          toast(msg, 'error');
        }
      }, kind === 'create'
        ? T('正在撤回压缩并清理产物…', 'Reverting compression…')
        : T('正在撤回解压并还原文件…', 'Reverting extraction…'), 'spin');
    } finally {
      S.undoBusy = false;
      renderLastExtract();
      renderLastCreate();
    }
  }

  function renderLastExtract() {
    const box = els.lastExtractBox;
    if (!box) return;
    const r = S.lastExtract;
    box.innerHTML = '';
    box.hidden = !r;
    if (!r) return;
    const open = h('button', { class: 'btn ghost sm' }, icon('scan', 14), T('在软件内打开', 'Open in app'));
    open.onclick = () => {
      if (window.AIEntries && typeof window.AIEntries.open === 'function') window.AIEntries.open(r.outDir);
      else API.openPath(r.outDir).catch((e) => toast(errText(e), 'error'));
    };
    const openExt = h('button', { class: 'btn ghost sm', title: T('在系统文件管理器中打开', 'Open in Explorer') }, icon('external', 14), T('系统管理器', 'Explorer'));
    openExt.onclick = () => API.reveal(r.outDir).catch((e) => toast(errText(e), 'error'));
    const isCurrentUndo = !!(r.canUndo && r.undoId && r.undoId === S.activeUndoId);
    const undoBtn = (r.undone || isCurrentUndo)
      ? h('button', {
          class: 'btn ghost sm',
          disabled: !!(r.undone || S.undoBusy || S.busy),
          title: r.undone ? '' : T('仅保留最近 1 次操作可撤回，下次操作、收起或关闭软件自动清理备份', 'Only the latest operation is undoable; backups clear automatically')
        }, icon('undo', 14), r.undone ? T('已撤回', 'Reverted') : (S.undoBusy ? T('撤回中…', 'Undoing…') : T('撤回解压', 'Undo extract')))
      : null;
    if (undoBtn && !r.undone) undoBtn.onclick = () => runUndo(r, 'extract');
    const hide = h('button', { class: 'btn ghost sm icon', title: T('收起并释放撤回缓存', 'Dismiss and clear undo cache'), 'aria-label': T('收起', 'Dismiss') }, icon('close', 14));
    hide.onclick = () => {
      discardUndoIfActive(r);
      S.lastExtract = null;
      renderLastExtract();
      renderLastCreate();
    };
    const title = r.undone
      ? T('已撤回解压：', 'Reverted extract: ') + (r.archiveName || baseName(r.outDir))
      : T('已解压：', 'Extracted: ') + (r.archiveName || baseName(r.outDir));
    const cacheNote = (!r.undone && isCurrentUndo && r.backupBytes > 0)
      ? (' · ' + T('撤回备份 ', 'Undo backup ') + fmtBytes(r.backupBytes))
      : '';
    const sub = r.undone
      ? (r.undoSummary || r.outDir)
      : (T('文件 ', 'Files ') + fmtCount(r.files) + ' · ' + T('目录 ', 'Folders ') + fmtCount(r.dirs) + ' · ' + fmtBytes(r.bytes) + cacheNote + ' · ' + r.outDir);
    box.appendChild(h('div', { class: 'arc-last-card' + (r.undone ? ' is-undone' : '') },
      h('span', { class: 'arc-last-ic' }, icon(r.undone ? 'undo' : 'export', 18)),
      h('div', { class: 'arc-last-text' },
        h('div', { class: 'arc-last-title' }, title),
        h('div', { class: 'small muted ellipsis', title: r.outDir }, sub)),
      h('span', { class: 'spacer' }),
      h('div', { class: 'arc-last-acts' }, open, openExt, undoBtn, hide)));
  }

  async function doExtract(indices) {
    if (!S.path || S.busy) return;
    const picked = await askExtractDest(indices);
    if (!picked || destroyed || S.busy) return;
    let out = picked.subfolder ? joinPath(picked.dir, picked.folder) : picked.dir;
    let effectiveOverwrite = S.overwrite;

    // 解压前冲突检测：发现目标目录/文件重名时，提示「直接覆盖」或「二者并存（自动重命名）」
    if (typeof API.archiveCheckExtractConflicts === 'function') {
      let conflict = null;
      try {
        conflict = await API.archiveCheckExtractConflicts(S.path, out, indices, S.password || null, !!picked.subfolder);
      } catch { conflict = null; }
      if (destroyed || S.busy) return;
      if (conflict && conflict.hasConflicts) {
        const choice = await askExtractConflict(conflict, out, picked);
        if (!choice || destroyed || S.busy) return;
        if (choice === 'rename') {
          if (picked.subfolder && (conflict.outDirExists || conflict.outDirIsFile) && conflict.suggestedOutDir) {
            out = conflict.suggestedOutDir;
          }
          effectiveOverwrite = 'rename';
        } else if (choice === 'overwrite') {
          effectiveOverwrite = 'overwrite';
        }
      }
    }

    S.extract.dir = picked.dir;
    S.extract.openAfter = picked.openAfter;
    API.configSet({
      archive_extract_dir: picked.dir,
      archive_extract_open: picked.openAfter
    }).catch(() => {});
    startOp(T('正在解压…', 'Extracting…'), 'extract');
    try {
      const report = await API.archiveExtract(S.path, out, indices, S.password || null, effectiveOverwrite, S.create.mode);
      endOp();
      S.lastExtract = Object.assign({}, report, {
        archiveName: baseName(S.path),
        undone: false,
        undoSummary: ''
      });
      S.activeUndoId = (report.canUndo && report.undoId) ? report.undoId : null;
      renderLastExtract();
      renderLastCreate();
      emitHook('extract:done', report);
      const body = h('div', { class: 'arc-report' },
        h('div', null, T('解压完成', 'Extraction complete')),
        h('div', { class: 'small muted' },
          T('文件 ', 'Files ') + fmtCount(report.files) + ' · ' +
          T('目录 ', 'Folders ') + fmtCount(report.dirs) + ' · ' +
          fmtBytes(report.bytes) + (report.skipped ? ' · ' + T('跳过 ', 'Skipped ') + fmtCount(report.skipped) : '')),
        h('div', { class: 'small muted ellipsis' }, report.outDir),
        report.backupIncomplete
          ? h('div', { class: 'small muted' }, T('注：部分超大覆盖文件超出撤回备份上限（同盘 1 GB / 跨盘 128 MB），撤回时将保留现状。', 'Note: some large overwritten files exceeded the undo backup cap (1 GB same-drive / 128 MB cross-drive) and will be kept on undo.'))
          : null
      );
      const modalBtns = [{ id: 'close', label: T('关闭', 'Close'), kind: 'ghost' }];
      if (report.canUndo && report.undoId) {
        modalBtns.push({ id: 'undo', label: T('撤回本次解压', 'Undo extract'), kind: 'ghost' });
      }
      modalBtns.push({ id: 'explorer', label: T('系统管理器', 'Explorer'), kind: 'ghost' });
      modalBtns.push({ id: 'open', label: T('在软件内打开', 'Open in app'), kind: 'primary' });
      const recRef = S.lastExtract;
      modal({
        title: T('解压完成', 'Done'),
        body,
        buttons: modalBtns,
        onClose: (v) => {
          if (v === 'open') {
            if (window.AIEntries && typeof window.AIEntries.open === 'function') window.AIEntries.open(report.outDir);
            else API.openPath(report.outDir).catch(() => {});
          }
          if (v === 'explorer') API.reveal(report.outDir).catch((e) => toast(errText(e), 'error'));
          if (v === 'undo') runUndo(recRef, 'extract');
        }
      });
      if (picked.openAfter) {
        if (window.AIEntries && typeof window.AIEntries.open === 'function') window.AIEntries.open(report.outDir);
        else API.openPath(report.outDir).catch(() => {});
      }
    } catch (e) {
      const wasCancelling = S.cancelling;
      S.activeUndoId = null;
      endOp();
      const msg = errText(e);
      if (wasCancelling || /操作已取消/.test(msg)) toast(T('任务已取消', 'Task cancelled'), 'info');
      else toast(msg, 'error');
    }
  }

  async function pauseOp() {
    if (!S.busy || S.paused || S.cancelling || S.pauseLock || S.opKind === 'open') return;
    S.paused = true;
    S.pauseLock = 'pausing';
    S.speed.t = 0;
    renderProgress();
    try {
      let ok = await API.archivePause();
      // 启动前几毫秒内后端尚未进入 ctx.begin() 时，短延迟重试一次防竞态失手。
      if (ok === false && !destroyed && S.busy && !S.cancelling) {
        await new Promise((r) => setTimeout(r, 60));
        if (!destroyed && S.busy && !S.cancelling && S.paused) {
          ok = await API.archivePause();
        }
      }
      if (destroyed || !S.busy || S.cancelling) { S.pauseLock = ''; return; }
      S.pauseLock = '';
      if (ok === false) {
        S.paused = false;
        renderProgress();
      }
    } catch {
      S.pauseLock = '';
      if (!destroyed && S.busy && !S.cancelling) {
        S.paused = false;
        renderProgress();
      }
    }
  }

  async function resumeOp() {
    if (!S.busy || !S.paused || S.cancelling || S.pauseLock || S.opKind === 'open') return;
    S.paused = false;
    S.pauseLock = 'resuming';
    S.speed.t = 0;
    renderProgress();
    try {
      const ok = await API.archiveResume();
      if (destroyed || !S.busy || S.cancelling) { S.pauseLock = ''; return; }
      S.pauseLock = '';
      if (ok === false) {
        S.paused = true;
        renderProgress();
      }
    } catch {
      S.pauseLock = '';
      if (!destroyed && S.busy && !S.cancelling) {
        S.paused = true;
        renderProgress();
      }
    }
  }

  async function cancelOp() {
    if (!S.busy || S.cancelling) return;
    S.cancelling = true;
    S.cancelSentAt = Date.now();
    S.paused = false;
    S.pauseLock = '';
    S.speed.t = 0;
    renderProgress();
    try { await API.archiveCancel(); } catch { /* ignore */ }
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

  /* 速率折线 SVG 字符串（仅替换图表内部 svgHost，绝不重建外层卡片与控制按钮 DOM） */
  function buildSpeedSvg(percent) {
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
    return (
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
      '</svg>'
    );
  }

  /* 持久进度卡 DOM：按钮只创建一次并终身保活，避免 90ms 高频进度推送通过 innerHTML=''
     在 mousedown 与 mouseup 之间销毁按钮导致浏览器吞掉 click 事件。 */
  function ensureProgressDom() {
    if (els.prog && els.prog.host === els.progress) return els.prog;
    const host = els.progress;
    host.innerHTML = '';

    const titleEl = h('strong', { class: 'ellipsis' }, '');
    const modeTagEl = h('span', { class: 'arc-mode-tag' }, '');
    const statEl = h('div', { class: 'small muted' }, '');
    const topEl = h('div', { class: 'arc-progress-top' },
      h('div', { class: 'arc-progress-label' }, icon('archive', 15), titleEl, modeTagEl),
      statEl
    );

    const svgHost = h('div', { class: 'arc-chart-svg' });
    const chartLeftEl = h('span', null, '');
    const chartRightEl = h('span', { class: 'arc-chart-spd' }, '');
    const chartBox = h('div', { class: 'arc-chart', role: 'img', hidden: true },
      svgHost,
      h('div', { class: 'arc-chart-meta' }, chartLeftEl, chartRightEl)
    );

    const barFill = h('i');
    const barBox = h('div', { class: 'arc-bar' }, barFill);

    const bannerEl = h('div', { class: 'arc-pause-banner', hidden: true }, '');
    const nameEl = h('div', { class: 'small muted ellipsis' }, '');

    const toggleBtn = h('button', { type: 'button', class: 'btn ghost sm' }, T('暂停', 'Pause'));
    toggleBtn.addEventListener('click', () => {
      if (S.paused) resumeOp();
      else pauseOp();
    });
    const cancelBtn = h('button', { type: 'button', class: 'btn ghost sm' }, T('取消', 'Cancel'));
    cancelBtn.addEventListener('click', () => cancelOp());
    const actsEl = h('div', { class: 'arc-progress-acts', hidden: true }, toggleBtn, cancelBtn);

    host.appendChild(topEl);
    host.appendChild(chartBox);
    host.appendChild(barBox);
    host.appendChild(bannerEl);
    host.appendChild(nameEl);
    host.appendChild(actsEl);

    els.prog = {
      host, titleEl, modeTagEl, statEl,
      chartBox, svgHost, chartLeftEl, chartRightEl,
      barBox, barFill, bannerEl, nameEl,
      actsEl, toggleBtn, cancelBtn
    };
    return els.prog;
  }

  function renderProgress() {
    if (!els.progress) return;
    const p = S.progress;
    const show = S.busy || !!p;
    els.progress.hidden = !show;
    if (!show) return;

    const ui = ensureProgressDom();
    const bytes = p ? Number(p.bytes) || 0 : 0;
    const totalBytes = p ? Number(p.totalBytes) || 0 : 0;
    const files = p ? Number(p.files) || 0 : 0;
    const totalFiles = p ? Number(p.totalFiles) || 0 : 0;
    const percent = totalBytes ? pct(bytes, totalBytes) : (totalFiles ? pct(files, totalFiles) : 0);

    const isCreate = (p && p.op) ? (p.op === 'create') : (S.opKind ? S.opKind === 'create' : (S.tab === 'create'));
    const titleName = isCreate
      ? (baseName(S.create.dest || (S.lastCreate && S.lastCreate.path) || '') || T('新建压缩包', 'New archive'))
      : (baseName(S.path) || T('解压任务', 'Extract'));
    const phaseText = S.cancelling ? T('正在取消并清理临时文件…', 'Cancelling…')
      : S.paused ? T('已暂停', 'Paused')
      : (p && p.phase === 'compress') ? T('正在压缩…', 'Compressing…')
      : (p && p.phase === 'extract') ? T('正在解压…', 'Extracting…')
      : (S.opLabel || T('正在处理…', 'Working…'));
    const curMode = (p && p.mode) || S.activeMode || S.create.mode || 'balanced';

    ui.titleEl.textContent = titleName;
    ui.titleEl.title = titleName;
    ui.modeTagEl.textContent = modeLabel(curMode);
    ui.statEl.textContent =
      (totalFiles ? fmtCount(files) + ' / ' + fmtCount(totalFiles) : fmtCount(files)) + ' · ' +
      fmtBytes(bytes) + (totalBytes ? ' / ' + fmtBytes(totalBytes) : '');

    // 速率折线图与进度条就地更新（不销毁按钮与外层卡片）
    if (S.speed.samples.length >= 2) {
      ui.chartBox.hidden = false;
      ui.barBox.hidden = true;
      ui.chartBox.className = 'arc-chart' + (S.paused ? ' is-paused' : '');
      ui.svgHost.innerHTML = buildSpeedSvg(percent);
      const remain = Math.max(0, totalBytes - bytes);
      const spd = S.speed.ema > 0 ? fmtBytes(S.speed.ema) + '/s' : '';
      const eta = (spd && remain > 0) ? T('剩余 ' + fmtDur(remain / S.speed.ema), fmtDur(remain / S.speed.ema) + ' left') : '';
      ui.chartLeftEl.textContent = S.cancelling ? T('正在取消…', 'Cancelling…')
        : S.paused ? T('已暂停 · 进度已保留', 'Paused · progress held')
        : (eta || (S.speed.samples.length ? T('速度', 'Speed') : T('正在准备…', 'Starting…')));
      ui.chartRightEl.textContent = S.paused ? (percent + '%') : (spd || '—');
      ui.chartBox.setAttribute('aria-label',
        S.paused ? T('已暂停', 'Paused') : (spd ? T('当前速度 ', 'Speed ') + spd : T('速率图', 'Speed chart')));
    } else {
      ui.chartBox.hidden = true;
      ui.barBox.hidden = false;
      ui.barBox.className = 'arc-bar' + (S.paused ? ' is-paused' : '');
      ui.barFill.style.width = (totalBytes || totalFiles) ? (percent + '%') : '34%';
    }

    if (S.cancelling) {
      ui.bannerEl.hidden = false;
      ui.bannerEl.className = 'arc-pause-banner is-cancelling';
      ui.bannerEl.textContent = T('正在取消任务并清理未完成文件…', 'Cancelling and cleaning up partial files…');
    } else if (S.paused) {
      const bytePart = totalBytes ? (fmtBytes(bytes) + ' / ' + fmtBytes(totalBytes)) : fmtBytes(bytes);
      const details = [
        percent + '%',
        totalFiles ? (fmtCount(files) + ' / ' + fmtCount(totalFiles) + T(' 个文件', ' files'))
          : (files ? (fmtCount(files) + T(' 个文件', ' files')) : '')
      ].filter(Boolean).join(T('，', ', '));
      ui.bannerEl.hidden = false;
      ui.bannerEl.className = 'arc-pause-banner';
      ui.bannerEl.textContent = T(
        '已暂停 · 已完成 ' + bytePart + '（' + details + '）· 点击「继续」恢复',
        'Paused at ' + bytePart + ' (' + details + ') · Click Resume to continue'
      );
    } else {
      ui.bannerEl.hidden = true;
      ui.bannerEl.textContent = '';
    }

    const currentName = (p && p.name) ? p.name : phaseText;
    ui.nameEl.textContent = currentName;
    ui.nameEl.title = currentName;

    const canControl = S.opKind === 'extract' || S.opKind === 'create';
    if (els.cancel) {
      els.cancel.hidden = !(S.busy && canControl);
      els.cancel.disabled = !!S.cancelling;
    }
    const showActs = !!(S.busy && canControl);
    ui.actsEl.hidden = !showActs;
    if (showActs) {
      ui.toggleBtn.className = S.paused ? 'btn primary sm' : 'btn ghost sm';
      ui.toggleBtn.disabled = !!S.cancelling;
      ui.toggleBtn.textContent = S.paused ? T('继续', 'Resume') : T('暂停', 'Pause');
      ui.cancelBtn.disabled = !!S.cancelling;
      ui.cancelBtn.textContent = S.cancelling ? T('取消中…', 'Cancelling…') : T('取消', 'Cancel');
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
    if (!show) { releasePreviewMedia(); return; }
    releasePreviewMedia();
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
        const execBlocked = (window.AIEntries && typeof window.AIEntries.isExecPath === 'function')
          ? window.AIEntries.isExecPath(d.name || d.file)
          : /\.(?:exe|msi|msp|mst|msix|appx|bat|cmd|ps1|psm1|psd1|ps1xml|scr|com|pif|cpl|msc|jar|vbs|vbe|js|jse|wsf|wsh|lnk|url|reg|hta|chm|inf|scf|appref-ms|application|gadget)$/i.test(String(d.name || d.file || ''));
        if (execBlocked) {
          body.appendChild(h('div', { class: 'small muted' }, T('安全保护：压缩包内可执行文件禁止直接运行，请先核验来源。', 'Safety guard: executables inside archives cannot be launched directly.')));
          const b = h('button', { class: 'btn sm ghost' }, icon('external', 13), T('在系统文件管理器中定位（不运行）', 'Reveal in Explorer (safe)'));
          b.onclick = () => API.reveal(d.file).catch((e) => toast(errText(e), 'error'));
          body.appendChild(b);
        } else {
          const b = h('button', { class: 'btn sm' }, T('用系统默认程序打开', 'Open with system app'));
          b.onclick = () => API.openPath(d.file).catch((e) => toast(errText(e), 'error'));
          body.appendChild(b);
        }
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
          T('按本机核心数动态分配线程、缓冲块、压缩级别（6/5/3/1）与自适应占空比（25%/50%/75%/100%），超线程零限速满核直通；高性能与超线程对音视频/图片/压缩包免重压。',
            'Dynamically scales threads, buffers, levels (6/5/3/1) and adaptive duty cycle (25%/50%/75%/100%) to your hardware; Hyper runs 100% unthrottled.'))),
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
     不用再回列表里找。下次创建时替换，并支持一键撤回。 */
  function renderLastCreate() {
    const box = els.lastBox;
    if (!box) return;
    const r = S.lastCreate;
    box.innerHTML = '';
    box.hidden = !r;
    if (!r) return;
    const restored = !!(r.undone && r.undoReport && r.undoReport.restoredFiles > 0);
    const open = (!r.undone || restored)
      ? h('button', { class: 'btn sm' }, icon('archive', 14), T('打开压缩包', 'Open'))
      : null;
    if (open) open.onclick = () => openArchive(r.path, null);
    const show = (!r.undone || restored)
      ? h('button', { class: 'btn ghost sm' }, icon('folder', 14), T('在文件夹中显示', 'Show in folder'))
      : null;
    if (show) show.onclick = () => API.reveal(r.path).catch((e) => toast(errText(e), 'error'));
    const isCurrentUndo = !!(r.canUndo && r.undoId && r.undoId === S.activeUndoId);
    const undoBtn = (r.undone || isCurrentUndo)
      ? h('button', {
          class: 'btn ghost sm',
          disabled: !!(r.undone || S.undoBusy || S.busy),
          title: r.undone ? '' : T('仅保留最近 1 次操作可撤回，下次操作、收起或关闭软件自动清理备份', 'Only the latest operation is undoable; backups clear automatically')
        }, icon('undo', 14), r.undone ? T('已撤回', 'Reverted') : (S.undoBusy ? T('撤回中…', 'Undoing…') : T('撤回压缩', 'Undo compress')))
      : null;
    if (undoBtn && !r.undone) undoBtn.onclick = () => runUndo(r, 'create');
    const hide = h('button', { class: 'btn ghost sm icon', title: T('收起并释放撤回缓存', 'Dismiss and clear undo cache'), 'aria-label': T('收起', 'Dismiss') }, icon('close', 14));
    hide.onclick = () => {
      discardUndoIfActive(r);
      S.lastCreate = null;
      renderLastCreate();
      renderLastExtract();
    };
    const title = r.undone
      ? T('已撤回压缩：', 'Reverted archive: ') + baseName(r.path)
      : T('已创建：', 'Created: ') + baseName(r.path);
    const cacheNote = (!r.undone && isCurrentUndo && r.backupBytes > 0)
      ? (' · ' + T('撤回备份 ', 'Undo backup ') + fmtBytes(r.backupBytes))
      : '';
    const sub = r.undone
      ? (r.undoSummary || r.path)
      : (fmtBytes(r.packed) + ' · ' + fmtCount(r.files) + T(' 个文件', ' files') +
          ' · ' + ((r.elapsedMs || 0) / 1000).toFixed(1) + ' s' + cacheNote);
    box.appendChild(h('div', { class: 'arc-last-card' + (r.undone ? ' is-undone' : '') },
      h('span', { class: 'arc-last-ic' }, icon(r.undone ? 'undo' : 'archive', 18)),
      h('div', { class: 'arc-last-text' },
        h('div', { class: 'arc-last-title' }, title),
        h('div', { class: 'small muted ellipsis', title: r.path }, sub)),
      h('span', { class: 'spacer' }),
      h('div', { class: 'arc-last-acts' }, show, open, undoBtn, hide)));
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
      }, h('strong', null, T(m.zh, m.en)), h('span', { class: 'small muted' }, modeHint(m)));
      els.modeBox.appendChild(b);
    });
    if (els.modeSel && typeof els.modeSel.setValue === 'function') {
      els.modeSel.setValue(S.create.mode);
    }
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
      if (!ok || destroyed || S.busy) return;
    }

    // 压缩前冲突检测：发现同名压缩包/目录时，提示「直接覆盖」或「二者并存（自动重命名）」
    if (typeof API.archiveCheckCreateConflict === 'function') {
      let conflict = null;
      try { conflict = await API.archiveCheckCreateConflict(dest); } catch { conflict = null; }
      if (destroyed || S.busy) return;
      if (conflict && conflict.exists) {
        const choice = await askCreateConflict(conflict, dest);
        if (!choice || destroyed || S.busy) return;
        if (choice === 'rename' && conflict.suggestedDest) {
          dest = conflict.suggestedDest;
        }
      }
    }

    S.create.dest = dest;
    S.create.dir = dirName(dest);
    if (els.dest) els.dest.value = dest;
    API.configSet({ archive_create_dir: S.create.dir }).catch(() => {});
    const pw = (S.create.format === 'zip' || S.create.format === '7z') ? (S.create.password || null) : null;
    startOp(T('正在创建压缩包…', 'Creating archive…'), 'create');
    try {
      const report = await API.archiveCreate(sources, dest, S.create.format, S.create.mode, pw);
      endOp();
      S.report = report;
      S.lastCreate = Object.assign({}, report, { undone: false, undoSummary: '' });
      S.activeUndoId = (report.canUndo && report.undoId) ? report.undoId : null;
      renderLastCreate();
      renderLastExtract();
      emitHook('create:done', report);
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
        h('div', { class: 'small muted ellipsis', title: report.path }, report.path),
        report.backupIncomplete
          ? h('div', { class: 'small muted' }, T('注：原压缩包超出撤回备份上限（同盘 1 GB / 跨盘 128 MB），撤回时将保留现状。', 'Note: original archive exceeded the undo backup cap (1 GB same-drive / 128 MB cross-drive) and will be kept on undo.'))
          : null
      );
      const modalBtns = [
        { id: 'close', label: T('关闭', 'Close'), kind: 'ghost' },
        { id: 'reveal', label: T('在文件夹中显示', 'Show in folder'), kind: 'ghost' }
      ];
      if (report.canUndo && report.undoId) {
        modalBtns.push({ id: 'undo', label: T('撤回本次压缩', 'Undo compress'), kind: 'ghost' });
      }
      modalBtns.push({ id: 'open', label: T('打开压缩包', 'Open archive'), kind: 'primary' });
      const recRef = S.lastCreate;
      modal({
        title: T('压缩包已创建', 'Archive created'),
        body,
        buttons: modalBtns,
        onClose: (v) => {
          if (v === 'open') openArchive(report.path, null);
          if (v === 'reveal') API.reveal(report.path).catch(() => {});
          if (v === 'undo') runUndo(recRef, 'create');
        }
      });
    } catch (e) {
      const wasCancelling = S.cancelling;
      S.activeUndoId = null;
      endOp();
      const msg = errText(e);
      if (wasCancelling || /操作已取消/.test(msg)) toast(T('任务已取消', 'Task cancelled'), 'info');
      else toast(msg, 'error');
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

  async function bindDropTarget(gen) {
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
        if (destroyed || gen !== mountGen) return;
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
      // 页面在注册完成前就被切走或被新挂载覆盖时，立刻退订，避免留下悬空监听。
      if (destroyed || gen !== mountGen) { try { off(); } catch { /* ignore */ } }
      else {
        if (dropUnlisten) { try { dropUnlisten(); } catch { /* ignore */ } }
        dropUnlisten = off;
      }
    } catch { dropUnlisten = null; }
  }

  /* ---------------------------------------------------------------- 生命周期 */
  async function mount(node) {
    const myGen = ++mountGen;
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
    const askBtn = UI.askBtn({
      title: T('问助手 · 压缩包', 'Ask AI · Archives'),
      question: T('帮我分析当前压缩包结构或推荐解压/打包方案。', 'Help me inspect this archive or choose extract/compress options.'),
      ctx: () => ({ page: '压缩包', tab: S.tab, path: S.path, entries: S.info ? S.info.total : 0 })
    });
    const head = h('div', { class: 'arc-head' }, tabs, headTools, askBtn);
    /* 页头固定、视图占满剩余高度：包一层 page-fill，页面本体就不再整页滚动，
       滚动交给 .arc-table-wrap（虚拟列表按它自己的 scrollTop 取窗口）。 */
    const body = h('div', { class: 'stack page-fill arc-body' }, head, open, create);
    root.appendChild(body);
    if (els.progress) root.appendChild(els.progress);
    renderTabs();
    renderViews();

    try {
      if (window.__TAURI__ && window.__TAURI__.event) {
        const offProgress = await window.__TAURI__.event.listen('archive-progress', (ev) => {
          if (destroyed || myGen !== mountGen || !S.busy) return;
          const p = ev.payload || {};
          S.progress = p;
          if (p.mode) S.activeMode = p.mode;
          if (p.phase === 'cancelling') {
            S.cancelling = true;
            S.paused = false;
            S.pauseLock = '';
            S.speed.t = 0;
          } else if (S.cancelling) {
            // 若用户在任务刚启动的毫秒级窗口点了取消，后端尚未收到或被 reset，超过 250ms 仍在推进时自愈重发一次取消。
            S.speed.t = 0;
            const now = Date.now();
            if (now - S.cancelSentAt > 250) {
              S.cancelSentAt = now;
              API.archiveCancel().catch(() => {});
            }
          } else {
            const incomingPaused = !!(p.paused || p.phase === 'paused');
            // 暂停/继续 RPC 在途期间，忽略来自 IPC 队列的反向旧状态，消除按钮与横幅闪烁。
            if (S.pauseLock === 'pausing' && !incomingPaused) {
              S.speed.t = 0;
            } else if (S.pauseLock === 'resuming' && incomingPaused) {
              S.speed.t = 0;
            } else {
              S.paused = incomingPaused;
              if (S.paused) S.speed.t = 0;
              else sampleSpeed(p);
            }
          }
          renderProgress();
        });
        if (destroyed || myGen !== mountGen) {
          try { offProgress(); } catch { /* ignore */ }
          return () => unmount(myGen);
        }
        if (unlisten) { try { unlisten(); } catch { /* ignore */ } }
        unlisten = offProgress;
      }
    } catch { /* 事件不可用时仍有返回结果 */ }

    try {
      const cfg = await API.configGet();
      if (destroyed || myGen !== mountGen) return () => unmount(myGen);
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

    if (typeof API.archiveCapabilities === 'function') {
      try {
        const caps = await API.archiveCapabilities();
        if (!destroyed && myGen === mountGen && caps && typeof caps === 'object') {
          S.caps = cloneCaps(caps);
          renderCreateChoices();
          emitHook('capabilities:ready', cloneCaps(S.caps));
        }
      } catch { /* 能力查询失败时平滑退回默认文案 */ }
    }
    if (destroyed || myGen !== mountGen) return () => unmount(myGen);

    refreshRar();
    if (S.info) renderOpen();
    setActions();

    if (dropLayer) { dropLayer.remove(); dropLayer = null; }
    dropLayer = buildDropLayer();
    document.body.appendChild(dropLayer);
    bindDropTarget(myGen);

    if (keyHandler) { document.removeEventListener('keydown', keyHandler); keyHandler = null; }
    keyHandler = (e) => {
      if (e.key === 'Escape' && S.preview) closePreview();
    };
    document.addEventListener('keydown', keyHandler);

    return () => unmount(myGen);
  }

  function unmount(gen) {
    if (gen !== undefined && gen !== mountGen) return;
    destroyed = true;
    setActions();
    releasePreviewMedia();
    if (S.busy) {
      // 离开页面会中断任务：把状态收干净，回到本页时不能停在「永远处理中」
      API.archiveCancel().catch(() => {});
      S.busy = false;
      S.paused = false;
      S.pauseLock = '';
      S.cancelling = false;
      S.opKind = '';
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
    S.undoBusy = false;
    root = null;
    els = {};
  }

  window.Pages = window.Pages || {};
  window.Pages.archive = {
    title: ['压缩包', 'Archives'],
    subtitle: ['压缩、解压与查看', 'Compress, extract, preview'],
    mount,
    getCapabilities() {
      return cloneCaps(S.caps);
    },
    on: onHook,
    off: offHook,
    /* AI 说「这几个压缩包可以看看」时，跳进来要直接把这个包打开，
       而不是停在一个让你自己再选一次的空页面。 */
    async jump(payload) {
      let paths = ((payload && payload.paths) || []).filter(Boolean).map(String);
      if (paths.length && window.AIEntries && typeof window.AIEntries.resolvePaths === 'function') {
        try {
          const resolved = await window.AIEntries.resolvePaths(paths);
          if (resolved && resolved.length) paths = resolved;
        } catch (_) {}
      }
      if (destroyed) return undefined;
      const arc = paths.find((p) => isArchivePath(p) || /\.zst$/i.test(p));
      if (!arc) return undefined;
      try {
        return await openArchive(arc, null);
      } catch (_) {
        return undefined;
      }
    }
  };
})();
