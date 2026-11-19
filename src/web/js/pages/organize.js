/* 整理文件页：选择文件夹 → 扫描预览 → 勾选 → 执行整理 → 撤销 / 导出
   第二轮改版：整页只由外层 #scroll 滚动，页面内不套任何 max-height / overflow 容器；
   分组默认收起，展开后内容自然撑高整页。 */
(function () {
  'use strict';
  const { h, T, icon, fmtBytes, fmtCount, fmtTime, toast, busy, confirm,
    card, section, skeleton, empty, attachMenu, modal, setActions } = UI;

  const MIN_AGE_MAX = 1440;      // 与引擎一致：min_age_minutes 允许 0~1440
  const GROUP_STEP = 200;        // 单组首屏渲染条数，超大目录分批追加，避免一次建满 DOM
  const MAX_DETAIL_ROWS = 300;   // 详情弹窗最多渲染条数，避免弹窗无限变长

  /* ---------------- 纯工具 ---------------- */
  const errText = UI.errText;

  function clampAge(v) {
    let n = Number(v);
    if (!isFinite(n)) n = 0;
    n = Math.round(n);
    if (n < 0) n = 0;
    if (n > MIN_AGE_MAX) n = MIN_AGE_MAX;
    return n;
  }

  function splitList(raw) {
    const out = [];
    const seen = new Set();
    String(raw || '').split(/[\s,，;；]+/).forEach((part) => {
      const v = part.trim();
      if (!v) return;
      const k = v.toLowerCase();
      if (seen.has(k)) return;
      seen.add(k);
      out.push(v);
    });
    return out;
  }

  function joinPath(folder, name) {
    const f = String(folder || '');
    const sep = f.indexOf('\\') >= 0 ? '\\' : '/';
    return f.replace(/[\\/]+$/, '') + sep + name;
  }

  const normKey = (folder, name) => (String(folder || '').replace(/[\\/]+$/, '') + '\\' + name).toLowerCase();
  const groupKey = (folder, cat) => normKey(folder, '\u0001' + cat);

  function csvCell(v) {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function stamp() {
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    return '' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '_' + p2(d.getHours()) + p2(d.getMinutes());
  }

  /* 复制文本：优先剪贴板，旧环境用临时输入框兜底 */
  const copyText = UI.copy;

  /* ---------------- 页面 ---------------- */
  async function mount(root) {
    const state = {
      folder: '',         // 主路径（第一个目录，或第一个文件的父目录）：撤销 / 打开 / 导出用
      sources: [],        // [{ path, kind:'dir'|'file' }]，可以混选目录与文件
      items: [],          // 预览项（扁平化后的文件），移除预览项时直接从这里删
      index: new Map(),   // key(normKey) → item
      groups: new Map(),  // gid → { gid, folder, cat, files: [item], size }
      blocked: [],
      total: 0,
      total_size: 0,
      loaded: false,
      loading: false,
      error: null,        // { kind: 'no-path'|'missing'|'scan', message }
      selected: new Set(),
      openGroups: new Set(),
      shown: new Map(),   // gid → 已渲染条数（点「显示更多」后增长）
      skips: { n: 0, reasons: [] } // 被过滤掉的文件数与原因，用于空态解释
    };

    const opts = {
      preset: 'standard', // standard | all | careful
      recursive: true,
      use_content: null,   // null=跟随引擎设置 / true=按内容识别 / false=仅按扩展名
      by_date: false,
      conflict: 'rename',
      skip_recent: true,
      min_age_minutes: 10,
      skip_shortcuts: true,
      force: false,
      exclude_exts: '',
      exclude_dirs: ''
    };

    /* ---------------- 通用控件 ---------------- */
    function actBtn(zh, en, kind, iconName, onclick) {
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

    function topBtn(zh, en, iconName, onclick) {
      return h('button', {
        class: 'btn icon ghost',
        title: T(zh, en),
        'aria-label': T(zh, en),
        onclick: onclick
      }, icon(iconName, 15));
    }

    function field(label, control, desc) {
      return h('div', { class: 'field' },
        h('label', null, label),
        control,
        desc ? h('div', { class: 'desc' }, desc) : null
      );
    }

    function checkEl(zh, en, checked, onchange, title) {
      return h('label', { class: 'check', title: title || T(zh, en) },
        h('input', {
          type: 'checkbox',
          checked: !!checked,
          onchange: (e) => onchange(e.target.checked)
        }),
        h('span', null, T(zh, en)));
    }

    function selectEl(options, value, onchange) {
      const el = h('select', { class: 'select', onchange: (e) => onchange(e.target.value) });
      options.forEach((o) => el.appendChild(h('option', { value: o.v, selected: o.v === value }, o.label)));
      el.value = value;
      return el;
    }

    const conflictLabel = () => (opts.conflict === 'skip'
      ? T('重名跳过', 'Skip duplicates')
      : opts.conflict === 'overwrite' ? T('重名覆盖', 'Overwrite') : T('重名重命名', 'Rename duplicates'));

    const contentLabel = () => (opts.use_content === true
      ? T('按内容识别', 'By content')
      : opts.use_content === false ? T('仅按扩展名', 'Extension only') : T('自动识别', 'Auto'));

    const recursiveLabel = () => (opts.recursive ? T('递归子目录', 'Recursive') : T('仅当前目录', 'Top level only'));

    const optionSummary = () => [presetLabel(), conflictLabel()].join(' · ');

    const presetLabel = () => (opts.preset === 'all' ? T('全部文件', 'Everything')
      : opts.preset === 'careful' ? T('谨慎', 'Careful')
        : opts.preset === 'standard' ? T('标准', 'Standard') : T('自定义', 'Custom'));

    /* ---------------- 第一块：来源 + 主操作 ---------------- */
    const pathInput = h('input', {
      class: 'input grow mono',
      type: 'text',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: T('也可以直接粘文件夹或文件的完整路径', 'Or paste a full folder / file path')
    });
    pathInput.value = state.folder;
    // 只把输入框当「待加入的来源」，不直接改写 state.folder：
    // 撤销 / 打开文件夹都指向上一次真正扫描过的来源。
    pathInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { addTypedSource(); doScan(); }
    });

    const btnBrowse = actBtn('加文件夹', 'Add folder', 'ghost', 'folder', doBrowse);
    const btnPickFiles = actBtn('加文件', 'Add files', 'ghost', 'file', doPickFiles);
    const btnScan = actBtn('扫描', 'Scan', 'primary', 'scan', () => doScan());
    const btnOrganize = actBtn('开始整理', 'Start tidying', 'primary', 'play', doOrganize);
    btnOrganize.disabled = true;

    const srcBar = h('div', { class: 'src-bar', hidden: true });
    /* 入口的形象统一：这里也放史蒂夫，不再用线框图标 */
    const askMark = window.SteveAvatar
      ? window.SteveAvatar.el({ size: 24, variant: 'btn' })
      : icon('spark');
    const btnAsk = h('button', {
      class: 'btn ghost',
      title: T('让助手看看这些文件该怎么分', 'Ask the assistant how these files should be sorted')
    }, askMark, T('问助手', 'Ask AI'));
    btnAsk.onclick = () => {
      if (window.SteveAvatar) {
        window.SteveAvatar.spin(askMark);
      }
      window.AIDrawer.open({
        title: T('问助手 · 整理', 'Ask AI · Tidy'),
        ctx: () => ({
          page: '整理文件',
          dir: state.sources[0] ? state.sources[0].path : '',
          count: state.sources.length,
          note: state.groups && state.groups.size ? ('已识别 ' + state.groups.size + ' 类') : ''
        })
      });
    };
    const cardToolbar = card(
      h('div', { class: 'stack' },
        h('div', { class: 'toolbar' },
          pathInput, btnBrowse, btnPickFiles, btnScan, btnOrganize, btnAsk),
        srcBar
      )
    );

    /* ---------------- 第二块：选项（预设 + 少量开关 + 更多） ---------------- */
    const selectContent = selectEl([
      { v: 'auto', label: T('自动识别（跟随设置）', 'Auto (follow settings)') },
      { v: 'content', label: T('按文件内容识别', 'Detect by content') },
      { v: 'ext', label: T('仅按扩展名', 'Extension only') }
    ], opts.use_content === true ? 'content' : opts.use_content === false ? 'ext' : 'auto', (v) => {
      opts.use_content = v === 'auto' ? null : v === 'content';
      markManual();
    });

    const selectConflict = selectEl([
      { v: 'rename', label: T('重命名', 'Rename') },
      { v: 'skip', label: T('跳过', 'Skip') },
      { v: 'overwrite', label: T('覆盖', 'Overwrite') }
    ], opts.conflict, (v) => {
      opts.conflict = v;
      markManual();
    });

    const ageInput = h('input', {
      class: 'input',
      type: 'number',
      min: '0',
      max: String(MIN_AGE_MAX),
      step: '1',
      value: String(opts.min_age_minutes),
      style: { width: '76px' },
      oninput: (e) => { opts.min_age_minutes = clampAge(e.target.value); markManual(); },
      onchange: (e) => { e.target.value = String(clampAge(e.target.value)); }
    });

    const checkSkipRecent = checkEl('跳过最近修改', 'Skip recent', opts.skip_recent, (v) => {
      opts.skip_recent = v;
      ageInput.disabled = !v;
      markManual();
    }, T('刚动过的文件可能还在用，默认跳过', 'Recently touched files may still be in use'));

    const checkRecursive = checkEl('含子文件夹', 'Include subfolders', opts.recursive, (v) => {
      opts.recursive = v;
      markManual();
    });

    const checkByDate = checkEl('按日期分目录', 'Split by date', opts.by_date, (v) => {
      opts.by_date = v;
      markManual();
    });

    const checkShortcuts = checkEl('跳过快捷方式', 'Skip shortcuts', opts.skip_shortcuts, (v) => {
      opts.skip_shortcuts = v;
      markManual();
    });

    const checkForce = checkEl('强制整理疑似程序目录', 'Force questionable folders', opts.force, (v) => {
      opts.force = v;
      markManual();
    }, T('危险：会整理看起来像程序/工程/源码的目录', 'Dangerous: also tidies folders that look like programs or projects'));

    const extInput = h('input', {
      class: 'input mono',
      type: 'text',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: T('例如 .tmp .log .bak', 'e.g. .tmp .log .bak'),
      oninput: (e) => { opts.exclude_exts = e.target.value; }
    });
    extInput.value = opts.exclude_exts;

    const dirInput = h('input', {
      class: 'input mono',
      type: 'text',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: T('例如 node_modules .git', 'e.g. node_modules .git'),
      oninput: (e) => { opts.exclude_dirs = e.target.value; }
    });
    dirInput.value = opts.exclude_dirs;

    /* 三档预设：一次点完，不用逐个拨开关 */
    const PRESETS = {
      standard: {
        zh: '标准', en: 'Standard',
        hint: T('含子文件夹；跳过 10 分钟内改动与快捷方式；重名自动改名',
          'Subfolders; skip files changed in the last 10 min and shortcuts; rename on duplicate'),
        apply: () => {
          opts.recursive = true; opts.by_date = false; opts.skip_recent = true;
          opts.min_age_minutes = 10; opts.skip_shortcuts = true; opts.force = false;
          opts.conflict = 'rename'; opts.use_content = null;
        }
      },
      all: {
        zh: '全部文件', en: 'Everything',
        hint: T('含子文件夹；不跳过最近改动与快捷方式；重名自动改名',
          'Subfolders; do not skip recent files or shortcuts; rename on duplicate'),
        apply: () => {
          opts.recursive = true; opts.by_date = false; opts.skip_recent = false;
          opts.min_age_minutes = 10; opts.skip_shortcuts = false; opts.force = false;
          opts.conflict = 'rename'; opts.use_content = null;
        }
      },
      careful: {
        zh: '谨慎', en: 'Careful',
        hint: T('只看当前目录；跳过 60 分钟内改动；重名跳过、不覆盖',
          'Top level only; skip files changed in the last hour; skip duplicates, never overwrite'),
        apply: () => {
          opts.recursive = false; opts.by_date = false; opts.skip_recent = true;
          opts.min_age_minutes = 60; opts.skip_shortcuts = true; opts.force = false;
          opts.conflict = 'skip'; opts.use_content = null;
        }
      }
    };
    const presetRow = h('div', { class: 'seg', role: 'group' });
    const presetBtns = {};
    Object.keys(PRESETS).forEach((k) => {
      const b = h('button', {
        class: 'chip',
        type: 'button',
        title: PRESETS[k].hint,
        onclick: () => {
          opts.preset = k;
          PRESETS[k].apply();
          syncControls();
          refreshSummary();
        }
      }, T(PRESETS[k].zh, PRESETS[k].en));
      presetBtns[k] = b;
      presetRow.appendChild(b);
    });

    function markManual() {
      opts.preset = detectPreset();
      syncPresetButtons();
      refreshSummary();
    }

    /* 当前开关组合正好等于某一档时，仍然高亮那一档 */
    function detectPreset() {
      const keys = ['recursive', 'by_date', 'skip_recent', 'min_age_minutes',
        'skip_shortcuts', 'force', 'conflict', 'use_content'];
      let hit = '';
      Object.keys(PRESETS).forEach((k) => {
        if (hit) return;
        const save = {};
        keys.forEach((x) => { save[x] = opts[x]; });
        PRESETS[k].apply();
        const same = keys.every((x) => opts[x] === save[x]);
        keys.forEach((x) => { opts[x] = save[x]; });
        if (same) hit = k;
      });
      return hit;
    }

    function syncPresetButtons() {
      Object.keys(presetBtns).forEach((k) => {
        presetBtns[k].classList.toggle('active', opts.preset === k);
        presetBtns[k].setAttribute('aria-pressed', opts.preset === k ? 'true' : 'false');
      });
    }

    function syncControls() {
      checkRecursive.querySelector('input').checked = !!opts.recursive;
      checkByDate.querySelector('input').checked = !!opts.by_date;
      checkSkipRecent.querySelector('input').checked = !!opts.skip_recent;
      checkShortcuts.querySelector('input').checked = !!opts.skip_shortcuts;
      checkForce.querySelector('input').checked = !!opts.force;
      ageInput.value = String(clampAge(opts.min_age_minutes));
      ageInput.disabled = !opts.skip_recent;
      selectConflict.value = opts.conflict;
      selectContent.value = opts.use_content === true ? 'content'
        : opts.use_content === false ? 'ext' : 'auto';
      syncPresetButtons();
    }

    const moreDetails = h('details', { class: 'more-opts' },
      h('summary', null, T('更多选项', 'More options')),
      h('div', { class: 'grid-2' },
        field(T('识别方式', 'Detection'), selectContent,
          T('自动跟随设置；按内容更准但更慢', 'Auto follows settings; content is slower but more accurate')),
        field(T('重名时', 'On duplicate'), selectConflict,
          T('分类目录里已有同名文件时怎么处理', 'What to do when the category folder already has the same name')),
        field(T('排除扩展名', 'Skip extensions'), extInput,
          T('空格或逗号分隔，命中后缀的文件不整理', 'Space or comma separated')),
        field(T('排除目录名', 'Skip folder names'), dirInput,
          T('目录名精确匹配，整棵子树跳过', 'Exact folder name; whole subtree skipped'))
      ),
      h('div', { class: 'row wrap', style: { marginTop: '10px' } },
        checkShortcuts, checkForce)
    );

    const optsSection = section(T('整理选项', 'Tidy options'),
      h('div', { class: 'stack' },
        h('div', { class: 'row wrap' },
          h('span', { class: 'small muted', style: { minWidth: '52px' } }, T('预设', 'Preset')),
          presetRow
        ),
        h('div', { class: 'row wrap' },
          checkRecursive, checkByDate, checkSkipRecent, ageInput,
          h('span', { class: 'small muted' }, T('分钟内不改动', 'min untouched'))
        ),
        moreDetails,
        h('div', { class: 'note' },
          T('扫描只生成预览，不会移动或删除任何文件；真正执行时才会按分类移动。',
            'Scanning only builds a preview; nothing is moved or deleted until you start tidying.'))
      ),
      { open: true, hint: optionSummary(), id: 'organize-options' }
    );
    presetsInit();
    function presetsInit() {
      PRESETS.standard.apply();
      syncControls();
      refreshSummary();
    }

    /* ---------------- 第三块：预览 ---------------- */
    function statBox() {
      const v = h('div', { class: 'v' }, '0');
      const k = h('div', { class: 'k' }, '');
      return { el: h('div', { class: 'stat' }, v, k), v: v, k: k };
    }
    const statFiles = statBox();
    const statSize = statBox();
    const statCats = statBox();
    const statBlocked = statBox();
    const statsRow = h('div', { class: 'stats inline' },
      statFiles.el, statSize.el, statCats.el, statBlocked.el);

    const btnAll = actBtn('全选', 'Select all', 'ghost sm', 'check', () => setAll(true));
    const btnInvert = actBtn('反选', 'Invert', 'ghost sm', 'rules', invertAll);
    const btnNone = actBtn('清空', 'Clear', 'ghost sm', 'close', () => setAll(false));
    const selInfo = h('span', { class: 'muted small ellipsis', style: { maxWidth: '360px' } }, '');
    const btnTrash = actBtn('移到回收站', 'Move to recycle bin', 'ghost sm', 'trash', () => doDelete('trash'));
    const btnPurge = actBtn('永久删除', 'Delete permanently', 'danger sm', 'trash', () => doDelete('permanent'));
    btnTrash.disabled = true;
    btnPurge.disabled = true;

    const selBar = h('div', { class: 'toolbar' },
      btnAll, btnInvert, btnNone,
      h('span', { class: 'spacer' }),
      selInfo, btnTrash, btnPurge
    );

    const previewHint = h('span', { class: 'hint ellipsis', style: { maxWidth: '52%' } }, '');
    const results = h('div', { class: 'stack' });

    const previewBody = h('div', { class: 'preview-body' }, results);
    const previewCard = card(
      h('div', { class: 'card-title' },
        h('h2', null, T('扫描预览', 'Scan preview')),
        previewHint
      ),
      statsRow,
      selBar,
      previewBody
    );
    previewCard.classList.add('stretch-card', 'preview-card');

    root.appendChild(cardToolbar);
    root.appendChild(optsSection);
    root.appendChild(previewCard);
    root.classList.add('page-fill');

    /* ---------------- 顶部动作（撤销 / 导出 / 打开目录） ---------------- */
    const btnUndo = topBtn('撤销上次整理', 'Undo last tidy', 'undo', doUndo);
    const btnExport = topBtn('导出预览 CSV', 'Export preview CSV', 'export', doExport);
    const btnOpen = topBtn('打开当前文件夹', 'Open current folder', 'folder', () => {
      if (!state.folder) {
        toast(T('还没有选择文件夹', 'No folder selected'), 'warn');
        return;
      }
      API.reveal(state.folder).catch((e) => toast(errText(e), 'error'));
    });
    setActions(btnUndo, btnExport, btnOpen);

    /* 行内状态：复选框登记表（只登记已渲染的行） */
    const rowChecks = new Map();   // key → checkbox
    const groupEls = new Map();    // gid → { el, check, setOpen }

    /* ---------------- 扫描选项摘要 ---------------- */
    function refreshSummary() {
      const hint = optsSection.querySelector('.section-head .hint');
      if (hint) hint.textContent = optionSummary();
    }

    /* ---------------- 参数 ---------------- */
    function scanParams() {
      return {
        paths: sourcePaths(),
        recursive: !!opts.recursive,
        by_date: !!opts.by_date,
        conflict: opts.conflict,
        use_content: opts.use_content,
        skip_recent: !!opts.skip_recent,
        min_age_minutes: opts.skip_recent ? clampAge(opts.min_age_minutes) : null,
        skip_shortcuts: !!opts.skip_shortcuts,
        force: !!opts.force,
        exclude_exts: splitList(opts.exclude_exts),
        exclude_dirs: splitList(opts.exclude_dirs)
      };
    }

    /* ---------------- 来源（目录 / 文件可混选） ---------------- */
    function guessKind(p) {
      const name = String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
      return /\.[^.]{1,10}$/.test(name) ? 'file' : 'dir';
    }

    const sourcePaths = () => state.sources.map((s) => s.path);

    function addSources(items) {
      const seen = new Set(state.sources.map((s) => s.path.toLowerCase()));
      let added = 0;
      (items || []).forEach((it) => {
        const p = String(it && it.path ? it.path : it || '').trim();
        if (!p || seen.has(p.toLowerCase())) return;
        state.sources.push({ path: p, kind: (it && it.kind) || guessKind(p) });
        seen.add(p.toLowerCase());
        added += 1;
      });
      if (added) renderSources();
      return added;
    }

    function removeSource(p) {
      state.sources = state.sources.filter((s) => s.path !== p);
      renderSources();
      refreshSummary();
    }

    function primaryFolder() {
      const dir = state.sources.find((s) => s.kind === 'dir');
      if (dir) return dir.path;
      const f = state.sources.find((s) => s.kind === 'file');
      if (f) {
        const i = Math.max(f.path.lastIndexOf('\\'), f.path.lastIndexOf('/'));
        return i > 0 ? f.path.slice(0, i) : f.path;
      }
      return '';
    }

    function renderSources() {
      srcBar.replaceChildren();
      if (!state.sources.length) {
        srcBar.hidden = true;
        state.folder = '';
        refreshButtons();
        return;
      }
      state.folder = primaryFolder();
      state.sources.forEach((s) => {
        const kind = s.kind === 'file' ? 'file' : 'folder';
        const chip = h('span', { class: 'src-chip', title: s.path },
          icon(kind, 13),
          h('span', { class: 'ellipsis' }, s.path),
          h('button', {
            class: 'src-x', type: 'button',
            title: T('移除', 'Remove'), 'aria-label': T('移除', 'Remove'),
            onclick: () => removeSource(s.path)
          }, icon('close', 12)));
        srcBar.appendChild(chip);
      });
      srcBar.hidden = false;
      refreshButtons();
    }

    function addTypedSource() {
      const v = String(pathInput.value || '').trim();
      if (!v) return false;
      addSources([{ path: v, kind: guessKind(v) }]);
      pathInput.value = '';
      return true;
    }

    /* ---------------- 选择来源 ---------------- */
    async function doBrowse() {
      try {
        const p = await API.pickFolder(state.folder || null);
        if (!p) return;
        addSources([{ path: p, kind: 'dir' }]);
        await doScan();
      } catch (e) {
        toast(errText(e), 'error');
      }
    }

    async function doPickFiles() {
      try {
        const list = await API.pickFiles();
        if (!list || !list.length) return;
        addSources((Array.isArray(list) ? list : [list]).map((p) => ({ path: p, kind: 'file' })));
        await doScan();
      } catch (e) {
        toast(errText(e), 'error');
      }
    }

    /* ---------------- 扫描 ---------------- */
    async function doScan(silent) {
      if (state.loading) return;
      if (String(pathInput.value || '').trim()) addTypedSource();

      // 一个来源都没有：直接进入内联错误态，不再调引擎
      if (!state.sources.length) {
        state.error = {
          kind: 'no-path',
          message: T('还没有选择要整理的文件夹或文件', 'No folder or file selected yet')
        };
        state.loaded = false;
        resetPreview();
        renderResults();
        renderStats();
        refreshButtons();
        if (!silent) {
          toast(T('请先添加文件夹或文件', 'Add a folder or file first'), 'warn');
          pathInput.focus();
        }
        return;
      }

      state.loading = true;
      state.error = null;
      state.loaded = false;
      renderResults();
      setBtnBusy(btnScan, true, '扫描中…', 'Scanning…');
      refreshButtons();

      // busy 自己会吞异常，这里把错误抓出来，用于渲染内联错误态
      let err = null;
      const res = await busy(async () => {
        try {
          return await API.engine('scan', scanParams());
        } catch (e) {
          err = e;
          return null;
        }
      }, T('正在扫描…', 'Scanning…'), 'scan');

      state.loading = false;
      setBtnBusy(btnScan, false);

      if (!res) {
        state.error = { kind: 'scan', message: errText(err) };
        state.items = [];
        state.index = new Map();
        state.groups = new Map();
        state.blocked = [];
        state.selected = new Set();
        state.openGroups = new Set();
        state.shown = new Map();
        recomputeTotals();
        renderResults();
        renderStats();
        refreshButtons();
        if (!silent) toast(errText(err), 'error');
        return;
      }

      buildFromScan(res);
      state.loaded = !state.error;

      // 记住上次使用的文件夹，下次进入页面直接带上
      API.configSet({ last_folder: state.folder }).catch(() => {});

      renderResults();
      renderStats();
      refreshSelectionUI();
      refreshButtons();

      if (!silent && state.loaded) {
        const sk = state.skips || { n: 0, reasons: [] };
        if (!state.total && sk.n) {
          toast(T('没有可整理的文件：' + fmtCount(sk.n) + ' 个被跳过（' + sk.reasons[0] + '）',
            'Nothing to tidy: ' + fmtCount(sk.n) + ' skipped (' + sk.reasons[0] + ')'), 'warn');
        } else {
          toast(T('扫描完成：' + fmtCount(state.total) + ' 个文件待整理',
            'Scan finished: ' + fmtCount(state.total) + ' file(s) to tidy'), 'ok');
        }
      }
    }

    /* 把引擎返回的 plans / blocked 摊平成预览项 */
    function buildFromScan(res) {
      const plans = Array.isArray(res.plans) ? res.plans : [];
      let blocked = Array.isArray(res.blocked) ? res.blocked : [];

      state.items = [];
      state.index = new Map();
      state.groups = new Map();
      state.openGroups = new Set();
      state.shown = new Map();
      state.error = null;
      state.skips = { n: 0, reasons: [] };
      [...plans, ...blocked].forEach((plan) => {
        (plan.skipped || []).forEach((s) => {
          state.skips.n += 1;
          const why = String((s && s.reason) || '已跳过');
          if (!state.skips.reasons.includes(why)) state.skips.reasons.push(why);
        });
      });

      plans.forEach((plan) => {
        (plan.groups || []).forEach((g) => {
          const gid = groupKey(plan.folder, g.cat);
          let grp = state.groups.get(gid);
          if (!grp) {
            grp = { gid: gid, folder: plan.folder, cat: g.cat, files: [], size: 0 };
            state.groups.set(gid, grp);
          }
          (g.files || []).forEach((f) => {
            const key = normKey(plan.folder, f.name);
            const it = {
              key: key,
              folder: plan.folder,
              cat: g.cat,
              name: f.name,
              size: Number(f.size) || 0,
              mtime: f.mtime || 0,
              path: joinPath(plan.folder, f.name)
            };
            state.items.push(it);
            grp.files.push(it);
            grp.size += it.size;
          });
        });
      });
      state.index = new Map(state.items.map((it) => [it.key, it]));

      // 来源不存在 / 不可读：引擎把它放在 blocked 里，这里提升成错误态
      const srcKeys = new Set(sourcePaths().map((p) => normKey(p, '')));
      if (state.folder) srcKeys.add(normKey(state.folder, ''));
      const fatal = blocked.find((p) => srcKeys.has(normKey(p.folder, '')) &&
        /不存在|无法读取|拒绝访问|not exist|denied|no such/i.test(String(p.error || '')));
      if (fatal && !state.items.length) {
        state.error = {
          kind: 'missing',
          message: String(fatal.error || T('路径不存在或无法读取', 'Path missing or unreadable'))
        };
        blocked = blocked.filter((p) => p !== fatal);
      }
      state.blocked = blocked;

      // 扫描结果变了，丢掉已经不存在的勾选
      state.selected = new Set(Array.from(state.selected).filter((k) => state.index.has(k)));
      recomputeTotals();
    }

    function recomputeTotals() {
      state.total = state.items.length;
      state.total_size = state.items.reduce((a, it) => a + it.size, 0);
    }

    function resetPreview() {
      state.items = [];
      state.index = new Map();
      state.groups = new Map();
      state.blocked = [];
      state.selected = new Set();
      state.openGroups = new Set();
      state.shown = new Map();
      recomputeTotals();
    }

    /* ---------------- 统计 ---------------- */
    function renderStats() {
      statFiles.v.textContent = fmtCount(state.total);
      statFiles.k.textContent = T('待整理文件', 'Files to tidy');
      statSize.v.textContent = fmtBytes(state.total_size);
      statSize.k.textContent = T('合计大小', 'Total size');
      statCats.v.textContent = fmtCount(state.groups.size);
      statCats.k.textContent = T('分类', 'Categories');
      statBlocked.v.textContent = fmtCount(state.blocked.length);
      statBlocked.k.textContent = T('被拦截目录', 'Blocked folders');

      previewHint.textContent = state.folder
        ? state.folder
        : T('未选择文件夹', 'No folder selected');
      previewHint.title = previewHint.textContent;
    }

    /* ---------------- 预览渲染 ---------------- */
    function renderResults() {
      results.replaceChildren();
      rowChecks.clear();
      groupEls.clear();

      if (state.loading) {
        results.appendChild(skeleton(6, 'scan'));
        return;
      }
      if (state.error) {
        results.appendChild(errorNotice());
        return;
      }
      if (!state.loaded) {
        results.appendChild(startNotice());
        return;
      }

      const groups = Array.from(state.groups.values());
      if (!groups.length) {
        const sk = state.skips || { n: 0, reasons: [] };
        results.appendChild(empty(
          T('没有需要整理的文件', 'Nothing to tidy'),
          sk.n
            ? T('跳过 ' + fmtCount(sk.n) + ' 个文件：' + sk.reasons.slice(0, 3).join('、') +
              (sk.reasons.length > 3 ? ' 等' : '') + '。想让它们参与，把「跳过最近修改」关掉或调小分钟数。',
              'Skipped ' + fmtCount(sk.n) + ' file(s): ' + sk.reasons.slice(0, 3).join(', ') +
              (sk.reasons.length > 3 ? ', …' : '') + '. Turn off "Skip recent" or lower the minutes to include them.')
            : T('这个文件夹已经整理干净，或者当前过滤条件排除了全部文件',
              'This folder is already tidy, or the current filters excluded everything')));
      } else {
        const box = h('div', { class: 'stack' });
        groups.forEach((g) => box.appendChild(renderGroup(g)));
        results.appendChild(box);
      }

      if (state.skips && state.skips.n) results.appendChild(skipNotice());
      if (state.blocked.length) results.appendChild(blockedNotice());
    }

    /* 有文件被跳过：一句话说清跳了多少、为什么，再给一个问助手的口子。
       用户看到「少了几个文件」时最想知道的就是这条 */
    function skipNotice() {
      const sk = state.skips || { n: 0, reasons: [] };
      const why = sk.reasons.slice(0, 3).join('、') + (sk.reasons.length > 3 ? ' 等' : '');
      return h('div', { class: 'row wrap' },
        h('span', { class: 'badge' }, T('跳过 ' + fmtCount(sk.n) + ' 个文件', fmtCount(sk.n) + ' file(s) skipped')),
        h('span', { class: 'small muted ellipsis', style: { maxWidth: '560px' }, title: why }, why),
        h('span', { class: 'spacer' }),
        h('button', {
          class: 'btn ghost sm',
          onclick: () => askWhy(T('这些文件为什么被跳过？', 'Why were these files skipped?'),
            T('跳过 ' + fmtCount(sk.n) + ' 个文件 · ' + why, fmtCount(sk.n) + ' skipped · ' + why))
        }, T('为什么跳过', 'Why skipped'))
      );
    }

    /* 未扫描：引导态 */
    function startNotice() {
      return h('div', { class: 'stack' },
        empty(T('还没有扫描结果', 'No preview yet'),
          T('选择文件夹后点「扫描」生成预览，扫描不会改动任何文件',
            'Pick a folder and click Scan to build a preview; nothing is changed')),
        h('div', { class: 'row' },
          h('span', { class: 'spacer' }),
          h('button', { class: 'btn ghost sm', onclick: doBrowse }, T('选择文件夹', 'Choose folder')))
      );
    }

    /* 错误态：路径为空 / 目录不存在 / 扫描失败 */
    function errorNotice() {
      const e = state.error || {};
      const isNoPath = e.kind === 'no-path';
      const badge = isNoPath ? T('未选择文件夹', 'No folder')
        : e.kind === 'missing' ? T('路径不可用', 'Path unavailable') : T('扫描失败', 'Scan failed');
      const kind = isNoPath ? 'warn' : 'danger';
      const text = isNoPath
        ? T('还没有选择要整理的文件夹，先点「浏览」或直接输入路径',
          'No folder selected yet; click Browse or type a path')
        : (e.message || T('未知错误', 'Unknown error'));

      return h('div', { class: 'stack' },
        h('div', { class: 'row wrap' },
          h('span', { class: 'badge ' + kind }, badge),
          h('span', { class: 'small ellipsis', style: { maxWidth: '620px' }, title: text }, text),
          h('span', { class: 'spacer' }),
          h('button', { class: 'btn ghost sm', onclick: doBrowse }, T('浏览…', 'Browse…')),
          h('button', {
            class: 'btn ghost sm',
            onclick: () => showDetails(T('扫描错误详情', 'Scan error details'), [
              [T('当前路径', 'Current path'), state.folder || T('（空）', '(empty)')],
              [T('错误类型', 'Error kind'), isNoPath ? T('路径为空', 'Empty path') : (e.kind || 'scan')],
              [T('引擎返回', 'Engine message'), text]
            ])
          }, T('查看详情', 'Details'))
        ),
        blockedNoticeIfAny()
      );
    }

    function blockedNoticeIfAny() {
      return state.blocked.length ? blockedNotice() : null;
    }

    /* 被拦截目录：安全规则跳过的文件夹 */
    function blockedNotice() {
      const n = state.blocked.length;
      return h('div', { class: 'row wrap' },
        h('span', { class: 'badge warn' }, T('已跳过 ' + fmtCount(n) + ' 个目录',
          'Skipped ' + fmtCount(n) + ' folder(s)')),
        h('span', { class: 'small muted ellipsis', style: { maxWidth: '560px' } },
          T('这些目录被安全规则判定为程序目录、工程目录或不可读，未参与整理',
            'Safety rules treated these folders as program/project folders or unreadable; they were left alone')),
        h('span', { class: 'spacer' }),
        h('button', {
          class: 'btn ghost sm',
          onclick: () => askWhy(T('这些目录为什么被跳过？',
            'Why were these folders skipped?'),
            T('已跳过 ' + fmtCount(n) + ' 个目录', fmtCount(n) + ' folder(s) skipped'))
        }, T('为什么跳过', 'Why skipped')),
        h('button', {
          class: 'btn ghost sm',
          onclick: () => showDetails(T('被拦截的目录', 'Blocked folders'),
            state.blocked.map((p) => [
              p.folder || '',
              [p.error, p.blocked_kind ? '(' + p.blocked_kind + ')' : '',
                Array.isArray(p.evidence) ? p.evidence.join(' / ') : ''].filter(Boolean).join(' · ')
            ]))
        }, T('查看详情', 'Details'))
      );
    }

    /* 「为什么这样分」统一走助手抽屉：预填问题，上下文带上当前分组，
       回答里的分类规则来自引擎的 rules.explain，不是模型猜的 */
    function askWhy(question, note) {
      if (!window.AIDrawer) return;
      if (window.SteveAvatar) window.SteveAvatar.spin(askMark);
      window.AIDrawer.open({
        title: T('问助手 · 为什么', 'Ask AI · Why'),
        question: question,
        ctx: () => ({
          page: '整理文件',
          dir: state.sources[0] ? state.sources[0].path : '',
          count: state.sources.length,
          note: note || ''
        })
      });
    }

    /* 单个分组：默认收起，展开时才建表，避免大目录一次渲染 */
    function renderGroup(g) {
      const open = state.openGroups.has(g.gid);
      const el = h('div', { class: 'group' + (open ? ' open' : '') });
      const caret = h('span', {
        class: 'caret',
        html: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>'
      });

      const check = h('input', {
        type: 'checkbox',
        checked: false,
        onclick: (e) => e.stopPropagation(),
        onchange: (e) => setMany(g.files.map((f) => f.key), e.target.checked)
      });

      const head = h('div', {
        class: 'group-head',
        role: 'button',
        tabindex: '0',
        dataset: { group: g.gid },
        'aria-expanded': open ? 'true' : 'false',
        onclick: (e) => {
          if (e.target.closest('input, button')) return;
          G.setOpen(!state.openGroups.has(g.gid));
        },
        onkeydown: (e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          G.setOpen(!state.openGroups.has(g.gid));
        }
      },
        caret,
        check,
        h('span', { class: 'ellipsis', style: { minWidth: '0' }, title: g.cat }, g.cat),
        h('span', { class: 'badge' },
          T(fmtCount(g.files.length) + ' 个文件', fmtCount(g.files.length) + ' files')),
        h('span', { class: 'spacer' }),
        h('button', {
          class: 'btn ghost sm group-why',
          title: T('这一类是按什么规则分的', 'What rule puts files in this group'),
          onclick: (e) => {
            e.stopPropagation();
            askWhy(
              T('为什么「' + g.cat + '」这个分类会收这些文件？',
                'Why does the "' + g.cat + '" group collect these files?'),
              T('分类：' + g.cat + ' · ' + fmtCount(g.files.length) + ' 个文件 · ' +
                fmtBytes(g.size), 'Group: ' + g.cat + ' · ' + g.files.length + ' files'));
          }
        }, T('为什么', 'Why')),
        h('span', { class: 'muted small' }, fmtBytes(g.size))
      );

      const body = h('div', { class: 'group-body' });
      el.appendChild(head);
      el.appendChild(body);

      let built = false;
      let tbody = null;
      let more = null;
      let renderRows = null;

      const G = {
        el: el,
        check: check,
        setOpen: function (next) {
          if (next) state.openGroups.add(g.gid);
          else state.openGroups.delete(g.gid);
          el.classList.toggle('open', next);
          head.setAttribute('aria-expanded', next ? 'true' : 'false');
          if (next) ensureBuilt();
        }
      };
      groupEls.set(g.gid, G);

      function ensureBuilt() {
        if (built) return;
        built = true;

        tbody = h('tbody');
        const thead = h('thead', null, h('tr', null,
          h('th', { style: { width: '34px' } }, ''),
          h('th', null, T('文件名', 'Name')),
          h('th', { class: 'num', style: { width: '96px' } }, T('大小', 'Size')),
          h('th', { class: 'num', style: { width: '150px' } }, T('修改时间', 'Modified'))
        ));
        const tbl = h('table', { class: 'table dense' }, thead, tbody);
        more = h('div', { class: 'row', style: { padding: '6px 8px' } });
        body.appendChild(tbl);
        body.appendChild(more);

        renderRows = function () {
          const total = g.files.length;
          const limit = Math.max(GROUP_STEP, state.shown.get(g.gid) || GROUP_STEP);
          const have = tbody.children.length;
          const end = Math.min(limit, total);
          for (let i = have; i < end; i++) {
            tbody.appendChild(renderFileRow(g, g.files[i]));
          }
          more.replaceChildren();
          if (end < total) {
            more.appendChild(h('button', {
              class: 'btn ghost sm',
              onclick: () => {
                state.shown.set(g.gid, end + GROUP_STEP);
                renderRows();
                refreshSelectionUI();
              }
            }, T('显示更多（剩余 ' + fmtCount(total - end) + ' 条）',
              'Show more (' + fmtCount(total - end) + ' left)')));
          }
        };
        renderRows();
      }

      if (open) ensureBuilt();
      return el;
    }

    /* 单个文件行 */
    function renderFileRow(g, it) {
      const cb = h('input', {
        type: 'checkbox',
        checked: state.selected.has(it.key),
        onchange: (e) => {
          if (e.target.checked) state.selected.add(it.key);
          else state.selected.delete(it.key);
          refreshSelectionUI();
        }
      });
      rowChecks.set(it.key, cb);
      // row-in：新行插入时做一次淡入（前 10 行错峰，见 styles.css），只在建行时触发
      return h('tr', { class: 'row-in', dataset: { file: it.key }, title: T('双击定位文件', 'Double-click to show in folder') },
        h('td', { style: { width: '34px' } }, cb),
        h('td', null, h('div', { class: 'name' },
          icon('file', 14),
          h('span', { class: 'txt', style: { minWidth: '0' }, title: it.name }, it.name))),
        h('td', { class: 'num' }, fmtBytes(it.size)),
        h('td', { class: 'num small muted' }, it.mtime ? fmtTime(it.mtime) : '—')
      );
    }

    /* ---------------- 勾选 ---------------- */
    function setMany(keys, on) {
      keys.forEach((k) => { if (on) state.selected.add(k); else state.selected.delete(k); });
      refreshSelectionUI();
    }

    function invertKeys(keys) {
      keys.forEach((k) => {
        if (state.selected.has(k)) state.selected.delete(k);
        else state.selected.add(k);
      });
      refreshSelectionUI();
    }

    function setAll(on) {
      if (!on) {
        state.selected = new Set();
      } else {
        state.selected = new Set(state.items.map((it) => it.key));
      }
      refreshSelectionUI();
    }

    function invertAll() {
      invertKeys(state.items.map((it) => it.key));
    }

    function selectedItems() {
      return state.items.filter((it) => state.selected.has(it.key));
    }

    function selectedSize() {
      return selectedItems().reduce((a, it) => a + it.size, 0);
    }

    function refreshSelectionUI() {
      // 只更新已渲染行的复选框
      rowChecks.forEach((cb, key) => { cb.checked = state.selected.has(key); });

      groupEls.forEach((G, gid) => {
        const g = state.groups.get(gid);
        if (!g || !g.files.length) return;
        let n = 0;
        g.files.forEach((f) => { if (state.selected.has(f.key)) n++; });
        G.check.checked = n === g.files.length;
        G.check.indeterminate = n > 0 && n < g.files.length;
      });

      const n = state.selected.size;
      selInfo.textContent = n
        ? T('已选 ' + fmtCount(n) + ' 个 · ' + fmtBytes(selectedSize()),
          fmtCount(n) + ' selected · ' + fmtBytes(selectedSize()))
        : T('未选择文件', 'No file selected');
      selInfo.title = selInfo.textContent;
      refreshButtons();
    }

    function refreshButtons() {
      const has = state.items.length > 0;
      const n = state.selected.size;
      btnOrganize.disabled = !has || state.loading;
      btnTrash.disabled = n === 0 || state.loading;
      btnPurge.disabled = n === 0 || state.loading;
      btnExport.disabled = !has || state.loading;
      btnUndo.disabled = !state.folder || state.loading;
      btnAll.disabled = !has;
      btnInvert.disabled = !has;
      btnNone.disabled = !has;
    }

    /* ---------------- 整理 ---------------- */
    async function doOrganize() {
      if (!state.items.length) {
        toast(T('没有待整理的文件，先扫描一次', 'Nothing to tidy; scan first'), 'warn');
        return;
      }
      const n = state.items.length;
      const size = state.total_size;
      const picked = state.selected.size;
      const yes = await confirm({
        title: T('开始整理', 'Start tidying'),
        body: T('将按分类把 ' + fmtCount(n) + ' 个文件（' + fmtBytes(size) + '）全部移到分类子文件夹。' +
          (picked ? '\n\n当前勾选的 ' + fmtCount(picked) + ' 个文件只影响「删除 / 导出」，整理始终作用于全部扫描结果。' : '') +
          '\n\n重名策略：' + conflictLabel() + '；执行后可以用「撤销上次整理」回退最近一次操作。',
          'All ' + fmtCount(n) + ' file(s) (' + fmtBytes(size) + ') will be moved into category subfolders.' +
          (picked ? '\n\nThe ' + fmtCount(picked) + ' ticked file(s) only affect delete/export; tidying always covers every scanned file.' : '') +
          '\n\nConflict policy: ' + conflictLabel() + '. You can undo the latest run from the top bar.'),
        ok: T('开始整理', 'Start'),
        danger: true
      });
      if (!yes) return;

      setBtnBusy(btnOrganize, true, '整理中…', 'Tidying…');
      let err = null;
      const res = await busy(async () => {
        try {
          const params = Object.assign(scanParams(), { confirm: true, policy: opts.conflict });
          return await API.engine('organize', params);
        } catch (e) {
          err = e;
          return null;
        }
      }, T('正在移动文件…', 'Moving files…'), 'scan');
      setBtnBusy(btnOrganize, false);
      refreshButtons();

      if (!res) {
        toast(errText(err), 'error');
        return;
      }
      const moved = Number(res.moved) || 0;
      if (moved) {
        toast(T('已整理 ' + fmtCount(moved) + ' 个文件', 'Moved ' + fmtCount(moved) + ' file(s)'), 'ok');
      } else if (opts.conflict === 'skip') {
        toast(T('没有文件被移动：目标里已有同名文件，重名策略是「跳过」',
          'Nothing moved: targets already exist and the conflict policy is Skip'), 'warn');
      } else {
        toast(T('没有文件被移动', 'Nothing was moved'), 'warn');
      }
      if (Array.isArray(res.failed) && res.failed.length) {
        toast(T('有 ' + fmtCount(res.failed.length) + ' 个文件移动失败',
          fmtCount(res.failed.length) + ' file(s) failed'), 'warn');
        showDetails(T('移动失败的文件', 'Files that failed to move'),
          res.failed.map((f) => [f.name, f.why]));
      }
      if (Array.isArray(res.blocked) && res.blocked.length) {
        toast(T('有 ' + fmtCount(res.blocked.length) + ' 个目录被拦截',
          fmtCount(res.blocked.length) + ' folder(s) blocked'), 'warn');
      }
      // 文件来源：搬走的换成父目录（撤销/重扫还能用），没搬走的留着
      const failedNames = new Set((res.failed || []).map((f) => String(f.name || '')));
      const next = [];
      state.sources.forEach((s) => {
        if (s.kind !== 'file') { next.push(s); return; }
        const base = String(s.path).split(/[\\/]/).pop();
        if (failedNames.has(base)) { next.push(s); return; }
        const cut = Math.max(s.path.lastIndexOf('\\'), s.path.lastIndexOf('/'));
        next.push(cut > 0 ? { path: s.path.slice(0, cut), kind: 'dir' } : s);
      });
      const seen = new Set();
      const merged = [];
      next.forEach((s) => {
        const k = String(s.path).toLowerCase();
        if (seen.has(k)) return;
        seen.add(k);
        merged.push(s);
      });
      if (merged.length !== state.sources.length || state.sources.some((s) => s.kind === 'file')) {
        state.sources = merged;
        renderSources();
      }
      await doScan(true);
    }

    /* ---------------- 撤销 ---------------- */
    async function doUndo() {
      const folder = String(state.folder || '').trim();
      if (!folder) {
        toast(T('请先选择文件夹', 'Choose a folder first'), 'warn');
        return;
      }
      const yes = await confirm({
        title: T('撤销上次整理', 'Undo last tidy'),
        body: T('将把「' + folder + '」最近一次整理移动过的文件移回原位置。',
          'Move files from the latest tidy run in "' + folder + '" back to where they were.'),
        ok: T('撤销', 'Undo')
      });
      if (!yes) return;

      let err = null;
      const res = await busy(async () => {
        try {
          return await API.engine('undo', { path: folder });
        } catch (e) {
          err = e;
          return null;
        }
      }, T('正在撤销…', 'Undoing…'), 'spin');

      if (!res) {
        toast(errText(err), 'error');
        return;
      }
      const restored = Number(res.restored) || 0;
      const failed = Array.isArray(res.failed) ? res.failed : [];
      if (restored) {
        toast(T('已恢复 ' + fmtCount(restored) + ' 个文件',
          'Restored ' + fmtCount(restored) + ' file(s)'), 'ok');
      } else if (failed.length) {
        // 业务提示（无整理记录）会以 name 为空的失败项返回
        const hint = failed.find((f) => !f.name);
        toast(hint ? (hint.why || T('没有可撤销的整理记录', 'Nothing to undo'))
          : T('没有可撤销的整理记录', 'Nothing to undo'), 'warn');
      } else {
        toast(T('没有可撤销的整理记录', 'Nothing to undo'), 'warn');
      }
      if (failed.length && failed.some((f) => f.name)) {
        showDetails(T('撤销失败的文件', 'Files that failed to restore'),
          failed.filter((f) => f.name).map((f) => [f.name, f.why]));
      }
      await doScan(true);
    }

    /* ---------------- 删除 ---------------- */
    async function doDelete(mode, targets) {
      const list = Array.isArray(targets) ? targets : selectedItems();
      if (!list.length) {
        toast(T('请先勾选要删除的文件', 'Select files first'), 'warn');
        return;
      }
      const permanent = mode === 'permanent';
      const yes = await confirm({
        title: permanent ? T('永久删除', 'Delete permanently') : T('移到回收站', 'Move to recycle bin'),
        body: permanent
          ? T('将永久删除 ' + fmtCount(list.length) + ' 个文件，删除后无法恢复。',
            'Permanently delete ' + fmtCount(list.length) + ' file(s); this cannot be undone.')
          : T('将把 ' + fmtCount(list.length) + ' 个文件移到系统回收站。',
            'Move ' + fmtCount(list.length) + ' file(s) to the system recycle bin.'),
        ok: permanent ? T('永久删除', 'Delete') : T('移到回收站', 'Move'),
        danger: permanent
      });
      if (!yes) return;

      const busyBtn = permanent ? btnPurge : btnTrash;
      setBtnBusy(busyBtn, true, '删除中…', 'Deleting…');
      let err = null;
      const res = await busy(async () => {
        try {
          return await API.engine('files.delete', {
            paths: list.map((it) => it.path),
            mode: mode,
            confirm: true
          });
        } catch (e) {
          err = e;
          return null;
        }
      }, T('正在删除…', 'Deleting…'), 'scan');
      setBtnBusy(busyBtn, false);
      refreshButtons();

      if (!res) {
        toast(errText(err), 'error');
        return;
      }
      const deleted = Array.isArray(res.deleted) ? res.deleted : [];
      toast(T('已删除 ' + fmtCount(deleted.length) + ' 个文件',
        'Deleted ' + fmtCount(deleted.length) + ' file(s)'), deleted.length ? 'ok' : 'warn');
      if (Array.isArray(res.failed) && res.failed.length) {
        showDetails(T('删除失败', 'Delete failed'),
          res.failed.map((f) => [f.target, f.why]));
      }
      await doScan(true);
    }

    /* ---------------- 导出 CSV ---------------- */
    async function doExport() {
      if (!state.items.length) {
        toast(T('没有可导出的预览数据', 'No preview data to export'), 'warn');
        return;
      }
      const lines = ['分类,文件夹,文件名,大小(字节),大小'];
      state.items.forEach((it) => {
        lines.push([it.cat, it.folder, it.name, String(it.size || 0), fmtBytes(it.size)]
          .map(csvCell).join(','));
      });
      const content = '\uFEFF' + lines.join('\r\n') + '\r\n';
      const name = T('整理预览', 'tidy-preview') + '_' + stamp() + '.csv';

      btnExport.disabled = true;
      try {
        const saved = await API.saveText(name, content);
        if (saved) toast(T('已导出 CSV：', 'CSV exported: ') + saved, 'ok');
      } catch (e) {
        toast(errText(e), 'error');
      }
      btnExport.disabled = false;
      refreshButtons();
    }

    /* ---------------- 定位 / 复制 ---------------- */
    function revealFile(it) {
      if (!it || !it.path) return;
      API.reveal(it.path).catch((e) => toast(errText(e), 'error'));
    }

    /* ---------------- 从预览中移除（只动预览，不动磁盘） ---------------- */
    function removeFromPreview(it) {
      const i = state.items.indexOf(it);
      if (i < 0) return;
      state.items.splice(i, 1);
      state.index.delete(it.key);
      state.selected.delete(it.key);

      const gid = groupKey(it.folder, it.cat);
      const g = state.groups.get(gid);
      if (g) {
        g.files = g.files.filter((f) => f.key !== it.key);
        g.size = g.files.reduce((a, f) => a + f.size, 0);
        if (!g.files.length) state.groups.delete(gid);
      }
      state.shown.delete(gid);
      recomputeTotals();
      renderResults();
      renderStats();
      refreshSelectionUI();
      toast(T('已从预览中移除：', 'Removed from preview: ') + it.name, 'ok');
    }

    function expandAll(on) {
      if (on) state.groups.forEach((g) => state.openGroups.add(g.gid));
      else state.openGroups = new Set();
      renderResults();
      refreshSelectionUI();
    }

    /* ---------------- 详情弹窗（用 UI.modal，不在弹窗里套滚动条） ---------------- */
    function showDetails(title, rows) {
      const all = Array.isArray(rows) ? rows : [];
      const capped = all.slice(0, MAX_DETAIL_ROWS);
      const body = h('div', { class: 'list' },
        ...capped.map((pair) => h('div', { class: 'list-item' },
          h('div', { class: 'stack', style: { minWidth: '0' } },
            h('div', { class: 'ellipsis', title: pair[0] || '' }, pair[0] || T('提示', 'Notice')),
            pair[1] ? h('div', { class: 'small muted' }, pair[1]) : null))),
        all.length > capped.length
          ? h('div', { class: 'list-item' },
            h('div', { class: 'small muted' },
              T('仅显示前 ' + fmtCount(capped.length) + ' 条，共 ' + fmtCount(all.length) + ' 条',
                'Showing first ' + fmtCount(capped.length) + ' of ' + fmtCount(all.length))))
          : null
      );
      modal({
        title: title,
        body: body,
        wide: capped.length > 3,
        buttons: [{ id: 'ok', label: T('关闭', 'Close'), kind: 'primary' }]
      });
    }

    /* ---------------- 右键菜单 ---------------- */
    attachMenu(previewCard, (e) => {
      // 输入类保留系统菜单，避免抢走复制粘贴
      if (e.target.closest('input, textarea, select')) return [];

      const tr = e.target.closest('tr[data-file]');
      if (tr) {
        const it = state.index.get(tr.dataset.file);
        if (!it) return [];
        return [
          { header: it.name },
          { label: T('定位文件', 'Show in folder'), icon: 'external', action: () => revealFile(it) },
          { label: T('复制路径', 'Copy path'), icon: 'copy', action: () => copyText(it.path) },
          { sep: true },
          { label: T('从预览中移除', 'Remove from preview'), icon: 'close', danger: true,
            action: () => removeFromPreview(it) }
        ];
      }

      const gh = e.target.closest('[data-group]');
      if (gh) {
        const g = state.groups.get(gh.dataset.group);
        if (!g) return [];
        return [
          { header: g.cat },
          { label: T('全选本组', 'Select group'), icon: 'check',
            action: () => setMany(g.files.map((f) => f.key), true) },
          { label: T('反选本组', 'Invert group'), icon: 'rules',
            action: () => invertKeys(g.files.map((f) => f.key)) },
          { sep: true },
          { label: T('展开全部', 'Expand all'), icon: 'plus', action: () => expandAll(true) },
          { label: T('收起全部', 'Collapse all'), icon: 'close', action: () => expandAll(false) },
          { sep: true },
          { label: T('复制组名', 'Copy group name'), icon: 'copy', action: () => copyText(g.cat) }
        ];
      }

      return [
        { label: T('刷新扫描', 'Rescan'), icon: 'refresh', action: () => doScan() },
        { sep: true },
        { label: T('全选', 'Select all'), icon: 'check', action: () => setAll(true) },
        { label: T('清空选择', 'Clear selection'), icon: 'close', action: () => setAll(false) },
        { sep: true },
        { label: T('导出 CSV', 'Export CSV'), icon: 'export',
          disabled: state.items.length === 0, action: doExport }
      ];
    });

    /* ---------------- 初始数据 ---------------- */
    renderResults();
    renderStats();
    refreshSelectionUI();
    refreshButtons();

    try {
      const cfg = await API.configGet();
      if (cfg && typeof cfg.last_folder === 'string' && cfg.last_folder) {
        addSources([{ path: cfg.last_folder, kind: 'dir' }]);
      }
    } catch (e) { /* 首次运行没有配置，忽略 */ }

    try {
      const s = await API.engine('settings.get', {});
      if (s) {
        if (typeof s.default_recursive === 'boolean') {
          opts.recursive = s.default_recursive;
        }
        if (typeof s.default_content === 'boolean') {
          opts.use_content = s.default_content ? true : null;
        }
        if (s.conflict_policy === 'rename' || s.conflict_policy === 'skip' || s.conflict_policy === 'overwrite') {
          opts.conflict = s.conflict_policy;
        }
        opts.preset = detectPreset(); // 设置覆盖后按实际组合回显预设
        syncControls();
      }
    } catch (e) { /* 引擎未连上就沿用默认选项 */ }

    refreshSummary();
    renderStats();
    refreshButtons();
  }

  /* 右下角保留挂载点：滚动交给外层 #scroll，页面自身不创建滚动容器 */
  window.Pages = window.Pages || {};
  window.Pages.organize = {
    title: ['整理文件', 'Organize files'],
    subtitle: ['按分类整理文件夹，先预览再执行，可撤销',
      'Tidy folders by category: preview first, then run, and undo if needed'],
    mount: mount
  };
})();
