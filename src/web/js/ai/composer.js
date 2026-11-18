/* AI 输入框 · 逐项复刻原版 DeepAgent Composer
   ------------------------------------------------------------
   原版是 React + Tailwind + gsap 的 Composer。本软件是纯 <script> 加载、
   没有 npm 与打包器，所以这里用原生 DOM 重做同一套界面与动效：

     .dac
       └ .dac-surface            24px 圆角白面，两档阴影（聚焦加深）
           └ .dac-body           14px / 底部 10px 内边距
               ├ .dac-atts       附件区（图片 68×68、文件 56×220）
               ├ .dac-field      textarea，14px/24px，60~300px 自适应
               │   └ .dac-mentions  @ 候选
               └ .dac-bar        32px 工具条
                   ├ .dac-left   附件按钮 + 权限 chip
                   └ .dac-right  容量环 + 模型胶囊 + 发送键
       └ .dac-menu               形变菜单外壳（宽高由弹簧驱动）
       └ .dac-perm-wrap          权限菜单外壳

   与原版一致的硬指标：
   - 开菜单：宽 springEase(306.25,28,0.7) 0ms 起，高 springEase(196,18.34,0.86)
     57ms 起；关菜单：宽 springEase(400,33,0.64) 70ms 起，高 springEase(600.25,40,0.62)
     0ms 起。圆角/底色/阴影 220ms power2.out，内容透明度 240ms/180ms，模糊 8px↔0。
   - 选择模型后菜单不关；点外面 / Esc 才关。
   - 菜单宽度：模型菜单 264px、权限菜单 min(288px, 100vw-48px)；高度随内容实测。
   - 选中行底色用一条绝对定位的 pill 滑动（220ms，cubic-bezier(.22,.8,.28,1)）。
*/
(function (root) {
  'use strict';

  const UIx = root.UI;
  const M = root.AIMotion;

  /* ---------- 常量 ---------- */
  const TEXTAREA_MIN_H = 60;
  const TEXTAREA_MAX_H = 300;
  const MAX_ATTACH = 8;

  const MENU_W = 264;
  const PERM_W = 288;

  /* 原版 SHARE_MOTION：开/关两组弹簧参数，原样照抄 */
  const SHARE_OPEN = {
    width: { stiffness: 306.25, damping: 28, duration: 0.7, delay: 0 },
    height: { stiffness: 196, damping: 18.34, duration: 0.86, delay: 0.057 }
  };
  const SHARE_CLOSE = {
    width: { stiffness: 400, damping: 33, duration: 0.64, delay: 0.07 },
    height: { stiffness: 600.25, damping: 40, duration: 0.62, delay: 0 }
  };
  const OPEN_SHADOW = '0 6px 24px rgba(0,0,0,0.10)';
  const CLOSED_SHADOW = '0 0 0 rgba(0,0,0,0)';
  const MENU_RADIUS = 16;

  const THINK_STOPS = [
    { id: 'simple', label: ['简单', 'Simple'], icon: 'feather' },
    { id: 'medium', label: ['中度', 'Medium'], icon: 'bulb' },
    { id: 'deep', label: ['深度', 'Deep'], icon: 'brain' }
  ];

  /* 三档都只影响「查证深度」，不改变只读边界 */
  const PERM_OPTIONS = [
    {
      id: 'readonly',
      label: ['只读', 'Read-only'],
      desc: ['只列目录与历史，最省 token', 'List directory and history only'],
      icon: 'shield',
      tone: 'default'
    },
    {
      id: 'standard',
      label: ['标准', 'Standard'],
      desc: ['可查大文件、空目录与已装程序', 'Also inspect large files, empty dirs, apps'],
      icon: 'layers',
      tone: 'default'
    },
    {
      id: 'deep',
      label: ['深度', 'Deep'],
      desc: ['额外读文件签名与归属，最慢最全', 'Also read file signatures and owners'],
      icon: 'scan',
      tone: 'danger'
    }
  ];

  const PERM_TEXT = {
    readonly: ['只读', 'Read-only'],
    standard: ['标准', 'Standard'],
    deep: ['深度', 'Deep']
  };

  /* 动手档位：和「标准」并排的第二枚胶囊。
     查证深度管「能看多少」，动手档位管「能改到什么程度」，是两条正交的轴，
     所以不复用同一枚按钮，也不用同一个菜单。默认「只读」= 一个能改文件的工具都不发。 */
  const MODE_OPTIONS = [
    {
      id: 'off',
      label: ['只读', 'Read-only'],
      desc: ['只查不改：没有任何能改文件的工具', 'Look only: no tool can change files'],
      icon: 'shield'
    },
    {
      id: 'confirm',
      label: ['确认', 'Confirm'],
      desc: ['每个动作先变成卡片，你点了才执行', 'Every action becomes a card first'],
      icon: 'check'
    },
    {
      id: 'auto',
      label: ['自动', 'Auto'],
      desc: ['可撤销的动作直接执行，3 秒内可停', 'Reversible actions run at once, stoppable'],
      icon: 'spark'
    },
    {
      id: 'full',
      label: ['放手', 'Full'],
      desc: ['回收站级也会自动；撤不回来的仍要点', 'Trash-level runs too; permanent still needs a tap'],
      icon: 'alert',
      tone: 'danger'
    }
  ];

  const MODE_TEXT = {
    off: ['只读', 'Read-only'],
    confirm: ['确认', 'Confirm'],
    auto: ['自动', 'Auto'],
    full: ['放手', 'Full']
  };

  function T(zh, en) { return UIx && UIx.T ? UIx.T(zh, en) : zh; }
  function icon(name, size) { return UIx.icon(name, size || 14); }
  function fmtTokens(n) {
    const v = Math.max(0, Math.round(n || 0));
    if (v >= 1024 * 1024) return (v / (1024 * 1024)).toFixed(1).replace(/\.0$/, '') + 'M';
    if (v >= 1024) return Math.round(v / 1024) + 'K';
    return String(v);
  }
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function permIndex(id) {
    const i = PERM_OPTIONS.findIndex(function (p) { return p.id === id; });
    return i < 0 ? 1 : i;
  }
  function thinkIndex(id) {
    const i = THINK_STOPS.findIndex(function (s) { return s.id === id; });
    return i < 0 ? 1 : i;
  }
  function modeIndex(id) {
    const i = MODE_OPTIONS.findIndex(function (m) { return m.id === id; });
    return i < 0 ? 0 : i;
  }

  /* ============================================================
     锚定气泡：在触发块「上方」展开（1.23.6 替换掉形变菜单）
     ------------------------------------------------------------
     形变菜单的三个毛病：
     ① 展开时把触发块 opacity 归 0 —— 胶囊/权限按钮直接消失；
     ② 面板被外壳裁剪，模型列表只剩 2.5 行；
     ③ 打开一次跑 3 条弹簧时间线，逐帧写 width/height/filter，
        每帧都要重新布局，抽屉里连开两次就肉眼可见地卡。
     改成：面板挂 body、position: fixed、贴着触发块上沿弹出来；
     动画只做 transform/opacity 的 CSS 过渡（合成层，不触发布局）；
     触发块保持原样，只翻 chevron、标 aria-expanded。
     ============================================================ */
  const POP_GAP = 8;
  const POP_PAD = 12;

  function createPopover(trigger, shell, panel, cfg) {
    const align = cfg.align || 'left';
    const width = cfg.width || MENU_W;
    let open = false;
    let closeTimer = 0;

    shell.classList.add('dac-pop');
    shell.hidden = true;
    if (shell.parentNode !== root.document.body) root.document.body.appendChild(shell);

    /* 量一次自然高度 → 按「触发块上方剩余空间」限高；上方放不下才向下翻，
       两边都挤就取空间大的一侧，内部滚动。任何情况下都不出窗口。 */
    function place() {
      const w = Math.min(width, root.innerWidth - POP_PAD * 2);
      shell.style.width = w + 'px';
      panel.style.maxHeight = '';
      panel.style.overflowY = '';
      const natural = shell.offsetHeight;
      const r = trigger.getBoundingClientRect();
      const up = r.top - POP_GAP - POP_PAD;
      const down = root.innerHeight - r.bottom - POP_GAP - POP_PAD;
      const side = (up >= down || down < 120) ? 'up' : 'down';
      const room = Math.max(96, side === 'up' ? up : down);
      if (natural > room) {
        panel.style.maxHeight = room + 'px';
        panel.style.overflowY = 'auto';
      }
      const h = Math.min(natural, room);
      let left = align === 'right' ? r.right - w : r.left;
      left = Math.max(POP_PAD, Math.min(left, root.innerWidth - w - POP_PAD));
      let top = side === 'up' ? r.top - POP_GAP - h : r.bottom + POP_GAP;
      top = Math.max(POP_PAD, Math.min(top, root.innerHeight - h - POP_PAD));
      shell.dataset.side = side;
      shell.style.left = Math.round(left) + 'px';
      shell.style.top = Math.round(top) + 'px';
      return { side: side, h: h, w: w };
    }

    function show() {
      if (open) return;
      open = true;
      if (closeTimer) { clearTimeout(closeTimer); closeTimer = 0; }
      shell.hidden = false;
      shell.classList.remove('in');
      place();
      trigger.setAttribute('data-open', '');
      trigger.setAttribute('aria-expanded', 'true');
      /* 隔一帧再上 .in，过渡才有起点（同一帧加类浏览器会合并成直跳） */
      root.requestAnimationFrame(function () {
        if (open) shell.classList.add('in');
      });
      if (cfg.onOpen) cfg.onOpen();
    }

    function hide() {
      if (!open) return;
      open = false;
      shell.classList.remove('in');
      trigger.removeAttribute('data-open');
      trigger.setAttribute('aria-expanded', 'false');
      if (closeTimer) clearTimeout(closeTimer);
      closeTimer = setTimeout(function () {
        closeTimer = 0;
        if (!open) shell.hidden = true;
      }, 150);
      if (cfg.onClose) cfg.onClose();
    }

    const api = {
      get open() { return open; },
      show: show,
      hide: hide,
      toggle: function () { if (open) hide(); else show(); },
      /* 窗口 resize / 抽屉滑入时重算位置；关着就什么都不做 */
      layout: function () { if (open) place(); },
      destroy: function () {
        if (closeTimer) { clearTimeout(closeTimer); closeTimer = 0; }
        if (shell.parentNode) shell.parentNode.removeChild(shell);
        open = false;
      }
    };
    return api;
  }

  /* 选中行底色 pill：滑动到当前行 */
  function placePill(pill, rows, activeIndex) {
    if (!pill) return;
    if (activeIndex < 0 || !rows.length) { pill.style.opacity = '0'; return; }
    const row = rows[activeIndex];
    pill.style.opacity = '1';
    pill.style.height = row.offsetHeight + 'px';
    pill.style.transform = 'translateY(' + row.offsetTop + 'px)';
  }

  /* ============================================================
     主组件
     ============================================================ */
  const AIComposer = {};

  AIComposer.PERM_TEXT = PERM_TEXT;
  AIComposer.THINK_STOPS = THINK_STOPS;

  AIComposer.create = function (host, opts) {
    const o = opts || {};
    const compact = !!o.compact;
    let models = (o.models || []).slice();
    let model = o.model || (models[0] ? models[0].id || models[0] : '');
    let thinking = o.thinking || 'medium';
    let permission = o.permission || 'standard';
    let agentMode = o.mode || 'off';
    let disabled = !!o.disabled;
    let busy = false;
    let stopping = false;
    let attachments = [];
    let usage = o.usage || { used: 0, budget: 8000 };
    let mentionState = null;
    let dirCache = null;
    let dirCacheKey = '';

    if (models.length && typeof models[0] === 'string') {
      models = models.map(function (id) { return { id: id, label: id }; });
    }
    if (!model && models.length) model = models[0].id;

    /* ---------- DOM ---------- */
    const wrap = el('div', 'dac' + (compact ? ' dac-compact' : ''));
    const surface = el('div', 'dac-surface');
    const body = el('div', 'dac-body');

    const atts = el('div', 'dac-atts');
    atts.hidden = true;

    const field = el('div', 'dac-field');
    const input = document.createElement('textarea');
    input.className = 'dac-input';
    input.rows = 1;
    input.placeholder = T('尽管问…', 'Ask anything…');
    input.setAttribute('aria-label', T('向助手提问', 'Ask the assistant'));
    input.setAttribute('autocomplete', 'off');
    field.appendChild(input);
    body.appendChild(atts);
    body.appendChild(field);

    const bar = el('div', 'dac-bar');
    const left = el('div', 'dac-left');
    const right = el('div', 'dac-right');

    const attachBtn = el('button', 'dac-attach');
    attachBtn.type = 'button';
    attachBtn.title = T('添加附件', 'Add attachment');
    attachBtn.setAttribute('aria-label', T('添加附件', 'Add attachment'));
    attachBtn.appendChild(icon('paperclip', 14));

    const permWrap = el('div');
    permWrap.style.position = 'relative';
    permWrap.style.display = 'inline-flex';
    permWrap.style.maxWidth = '100%';
    const permBtn = el('button', 'dac-perm dac-perm-btn');
    permBtn.type = 'button';
    permBtn.setAttribute('aria-haspopup', 'menu');
    const permIc = el('span', 'dac-ic');
    const permLabel = el('span', 'dac-label');
    const permChev = el('span', 'dac-chev');
    permChev.appendChild(icon('chevron', 10));
    permBtn.appendChild(permIc);
    permBtn.appendChild(permLabel);
    permBtn.appendChild(permChev);
    permWrap.appendChild(permBtn);

    left.appendChild(attachBtn);
    left.appendChild(permWrap);

    /* 第二枚胶囊：动手档位。样式与「标准」同一套（.dac-perm），
       只是换了图标与文案，菜单里多一句「这档会发生什么」。 */
    const modeWrap = el('div');
    modeWrap.style.position = 'relative';
    modeWrap.style.display = 'inline-flex';
    modeWrap.style.maxWidth = '100%';
    const modeBtn = el('button', 'dac-perm dac-agent-mode');
    modeBtn.type = 'button';
    modeBtn.setAttribute('aria-haspopup', 'menu');
    modeBtn.title = T('助手能动手到什么程度', 'How far the assistant may act');
    const modeIc = el('span', 'dac-ic');
    const modeLabel = el('span', 'dac-label');
    const modeChev = el('span', 'dac-chev');
    modeChev.appendChild(icon('chevron', 10));
    modeBtn.appendChild(modeIc);
    modeBtn.appendChild(modeLabel);
    modeBtn.appendChild(modeChev);
    modeWrap.appendChild(modeBtn);
    left.appendChild(modeWrap);

    /* 容量环 */
    const capBtn = el('button', 'dac-cap');
    capBtn.type = 'button';
    capBtn.title = T('上下文占用', 'Context usage');
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    const R = 6.5;
    const C = 2 * Math.PI * R;
    const trail = document.createElementNS(NS, 'circle');
    trail.setAttribute('cx', '8'); trail.setAttribute('cy', '8'); trail.setAttribute('r', String(R));
    trail.setAttribute('fill', 'none');
    trail.setAttribute('stroke', 'color-mix(in srgb, var(--text-2) 30%, var(--surface))');
    trail.setAttribute('stroke-width', '2');
    const path = document.createElementNS(NS, 'circle');
    path.setAttribute('class', 'dac-cap-path');
    path.setAttribute('cx', '8'); path.setAttribute('cy', '8'); path.setAttribute('r', String(R));
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'var(--text-2)');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-dasharray', String(C));
    path.setAttribute('stroke-dashoffset', String(C));
    path.setAttribute('transform', 'rotate(-90 8 8)');
    svg.appendChild(trail);
    svg.appendChild(path);
    capBtn.appendChild(svg);

    /* 模型胶囊 + 菜单 */
    const pillWrap = el('div');
    pillWrap.style.position = 'relative';
    pillWrap.style.display = 'flex';
    pillWrap.style.height = '32px';
    pillWrap.style.alignItems = 'center';

    const pill = el('button', 'dac-pill');
    pill.type = 'button';
    pill.setAttribute('aria-haspopup', 'menu');
    pill.setAttribute('aria-expanded', 'false');
    const pillIc = el('span', 'dac-ic');
    const pillModel = el('span', 'dac-model');
    const pillThink = el('span', 'dac-think');
    const pillChev = el('span', 'dac-chev');
    pillChev.appendChild(icon('chevron', 10));
    pill.appendChild(pillIc);
    pill.appendChild(pillModel);
    pill.appendChild(pillThink);
    pill.appendChild(pillChev);
    pillWrap.appendChild(pill);

    /* 发送键 */
    const sendBtn = el('button', 'dac-send');
    sendBtn.type = 'button';
    sendBtn.setAttribute('data-state', 'idle');
    sendBtn.setAttribute('aria-label', T('发送', 'Send'));
    sendBtn.disabled = true;

    right.appendChild(capBtn);
    right.appendChild(pillWrap);
    right.appendChild(sendBtn);

    bar.appendChild(left);
    bar.appendChild(right);
    body.appendChild(bar);
    surface.appendChild(body);
    wrap.appendChild(surface);

    /* ---------- 模型菜单 ---------- */
    const modelMenu = el('div', 'dac-menu');
    modelMenu.hidden = true;
    const modelPanel = el('div', 'dac-menu-panel');
    const modelInner = el('div', 'dac-menu-inner');

    const modelBlock = el('div', 'dac-menu-block');
    const modelSec = el('div', 'dac-sec');
    modelSec.appendChild(el('span', 'dac-sec-title', T('模型', 'Model')));
    const modelScroll = el('div', 'dac-menu-scroll');
    const rowsBox = el('div', 'dac-rows');
    const rowsPill = el('div', 'dac-rows-pill');
    rowsPill.style.opacity = '0';
    rowsBox.appendChild(rowsPill);
    modelScroll.appendChild(rowsBox);
    modelBlock.appendChild(modelSec);
    modelBlock.appendChild(modelScroll);
    modelInner.appendChild(modelBlock);
    modelInner.appendChild(el('div', 'dac-divider'));

    const effortBlock = el('div', 'dac-effort-block');
    const effortHead = el('div', 'dac-effort-head');
    effortHead.appendChild(el('span', 'dac-sec-title', T('推理强度', 'Reasoning effort')));
    /* 窗口是多少、三档各能吃多少，写在标题右边 —— 数字由上层按模型能力给 */
    const effortMeta = el('span', 'dac-effort-meta', '');
    effortHead.appendChild(effortMeta);
    const effortHost = el('div');
    effortBlock.appendChild(effortHead);
    effortBlock.appendChild(effortHost);
    modelInner.appendChild(effortBlock);

    modelPanel.appendChild(modelInner);
    modelMenu.appendChild(modelPanel);
    /* 菜单不再挂在这条输入框里：createPopover 会把它挪到 body 上按 fixed 定位，
       这样既不会被 .ai-scroll / .dac-surface 裁剪，也不用跟着 flex 重排。 */

    const effort = root.AIEffortSlider.create(effortHost, {
      stops: THINK_STOPS.map(function (s) {
        return { value: s.id, label: T(s.label[0], s.label[1]) };
      }),
      value: thinking,
      ariaLabel: T('推理强度', 'Reasoning effort'),
      onChange: function (v) {
        thinking = v;
        syncPill();
        if (o.onThinkingChange) o.onThinkingChange(v);
      }
    });

    const modelRows = [];
    function rebuildModels() {
      rowsBox.querySelectorAll('.dac-row').forEach(function (n) { n.remove(); });
      modelRows.length = 0;
      if (!models.length) {
        const empty = el('div', 'dac-row', T('还没有配置模型', 'No models configured'));
        empty.style.cursor = 'default';
        rowsBox.appendChild(empty);
        /* 没配就给条路：直接去设置页，而不是让人对着一个空菜单发呆 */
        const go = el('button', 'dac-row dac-row-go');
        go.type = 'button';
        go.setAttribute('role', 'menuitem');
        go.appendChild(el('span', 'dac-row-name', T('去设置里填模型', 'Set a model in Settings')));
        const arrow = el('span', 'dac-check');
        arrow.appendChild(icon('chevron-right', 10));
        go.appendChild(arrow);
        go.addEventListener('click', function () {
          modelMorph.hide();
          root.location.hash = '#settings';
        });
        rowsBox.appendChild(go);
        return;
      }
      models.forEach(function (m) {
        const row = el('button', 'dac-row');
        row.type = 'button';
        row.setAttribute('role', 'menuitem');
        row.dataset.model = m.id;
        row.appendChild(el('span', 'dac-row-name', m.label || m.id));
        const ck = el('span', 'dac-check');
        ck.appendChild(icon('check', 10));
        ck.hidden = true;
        row.appendChild(ck);
        row.addEventListener('click', function () { pickModel(m.id); });
        rowsBox.appendChild(row);
        modelRows.push(row);
      });
      syncRows();
    }

    function syncRows() {
      const index = models.findIndex(function (m) { return m.id === model; });
      modelRows.forEach(function (row, i) {
        if (i === index) row.setAttribute('data-selected', '');
        else row.removeAttribute('data-selected');
        const ck = row.querySelector('.dac-check');
        if (ck) ck.hidden = i !== index;
      });
      placePill(rowsPill, modelRows, index);
    }

    function pickModel(id) {
      if (id === model) return;
      model = id;
      syncRows();
      syncPill();
      if (o.onModelChange) o.onModelChange(id);
      /* 原版：选完不关菜单 */
    }

    const modelMorph = createPopover(pill, modelMenu, modelPanel, {
      align: 'right',
      width: MENU_W,
      onOpen: function () { permMorph.hide(); modeMorph.hide(); pill.setAttribute('aria-expanded', 'true'); effort.resize(); },
      onClose: function () { pill.setAttribute('aria-expanded', 'false'); }
    });

    pill.addEventListener('click', function () {
      if (disabled) return;
      modelMorph.toggle();
    });

    /* ---------- 权限菜单 ---------- */
    const permMenu = el('div', 'dac-menu');
    permMenu.hidden = true;
    const permPanel = el('div', 'dac-perm-panel');
    const permInner = el('div', 'dac-perm-inner');
    const permRowsBox = el('div', 'dac-rows');
    permRowsBox.style.display = 'flex';
    permRowsBox.style.flexDirection = 'column';
    permRowsBox.style.gap = '2px';
    const permPill = el('div', 'dac-rows-pill');
    permPill.style.borderRadius = '12px';
    permRowsBox.appendChild(permPill);

    const permRowEls = [];
    PERM_OPTIONS.forEach(function (opt) {
      const row = el('button', 'dac-perm-row');
      row.type = 'button';
      row.setAttribute('role', 'menuitem');
      row.dataset.perm = opt.id;
      if (opt.tone === 'danger') row.setAttribute('data-tone', 'danger');
      const ic = el('span', 'dac-perm-ic');
      ic.appendChild(icon(opt.icon, 12));
      const bodyBox = el('div', 'dac-perm-body');
      bodyBox.appendChild(el('div', 'dac-perm-title', T(opt.label[0], opt.label[1])));
      bodyBox.appendChild(el('div', 'dac-perm-desc', T(opt.desc[0], opt.desc[1])));
      const ck = el('span', 'dac-perm-check');
      ck.appendChild(icon('check', 10));
      ck.hidden = true;
      row.appendChild(ic);
      row.appendChild(bodyBox);
      row.appendChild(ck);
      row.addEventListener('click', function () {
        permission = opt.id;
        syncPerm();
        permMorph.hide();
        if (o.onPermissionChange) o.onPermissionChange(permission);
      });
      permRowsBox.appendChild(row);
      permRowEls.push(row);
    });
    permInner.appendChild(permRowsBox);
    permPanel.appendChild(permInner);
    permMenu.appendChild(permPanel);
    /* 同模型菜单：交给 createPopover 挂到 body，按 fixed 定位 */

    const permMorph = createPopover(permBtn, permMenu, permPanel, {
      align: 'left',
      width: PERM_W,
      onOpen: function () { modelMorph.hide(); modeMorph.hide(); playPermPill(); },
      onClose: function () { }
    });

    permBtn.addEventListener('click', function () {
      if (disabled) return;
      permMorph.toggle();
    });

    function playPermPill() {
      const index = permIndex(permission);
      placePill(permPill, permRowEls, index);
      if (PERM_OPTIONS[index] && PERM_OPTIONS[index].tone === 'danger') {
        permPill.style.background = 'color-mix(in srgb, #e25507 10%, transparent)';
      } else {
        permPill.style.background = 'color-mix(in srgb, var(--text-1) 7%, transparent)';
      }
    }

    function syncPerm() {
      const index = permIndex(permission);
      const opt = PERM_OPTIONS[index];
      permIc.innerHTML = '';
      permIc.appendChild(icon(opt.icon, 12));
      permLabel.textContent = T(opt.label[0], opt.label[1]);
      /* 抽屉里这枚只剩图标（放不下两行文字），title 让它仍然说得清是什么 */
      permBtn.title = T('查证深度：' + opt.label[0], 'Lookup depth: ' + opt.label[1]);
      if (opt.tone === 'danger') permBtn.setAttribute('data-tone', 'danger');
      else permBtn.removeAttribute('data-tone');
      permRowEls.forEach(function (row, i) {
        const ck = row.querySelector('.dac-perm-check');
        if (ck) ck.hidden = i !== index;
      });
      playPermPill();
    }

    /* ---------- 动手档位菜单 ---------- */
    const modeMenu = el('div', 'dac-menu');
    modeMenu.hidden = true;
    const modePanel = el('div', 'dac-perm-panel');
    const modeInner = el('div', 'dac-perm-inner');
    const modeRowsBox = el('div', 'dac-rows');
    modeRowsBox.style.display = 'flex';
    modeRowsBox.style.flexDirection = 'column';
    modeRowsBox.style.gap = '2px';
    const modePill = el('div', 'dac-rows-pill');
    modePill.style.borderRadius = '12px';
    modeRowsBox.appendChild(modePill);

    const modeRowEls = [];
    MODE_OPTIONS.forEach(function (opt) {
      const row = el('button', 'dac-perm-row');
      row.type = 'button';
      row.setAttribute('role', 'menuitem');
      row.dataset.mode = opt.id;
      if (opt.tone === 'danger') row.setAttribute('data-tone', 'danger');
      const ic = el('span', 'dac-perm-ic');
      ic.appendChild(icon(opt.icon, 12));
      const bodyBox = el('div', 'dac-perm-body');
      bodyBox.appendChild(el('div', 'dac-perm-title', T(opt.label[0], opt.label[1])));
      bodyBox.appendChild(el('div', 'dac-perm-desc', T(opt.desc[0], opt.desc[1])));
      const ck = el('span', 'dac-perm-check');
      ck.appendChild(icon('check', 10));
      ck.hidden = true;
      row.appendChild(ic);
      row.appendChild(bodyBox);
      row.appendChild(ck);
      row.addEventListener('click', function () {
        agentMode = opt.id;
        syncMode();
        modeMorph.hide();
        if (o.onModeChange) o.onModeChange(agentMode);
      });
      modeRowsBox.appendChild(row);
      modeRowEls.push(row);
    });
    modeInner.appendChild(modeRowsBox);
    modePanel.appendChild(modeInner);
    modeMenu.appendChild(modePanel);

    const modeMorph = createPopover(modeBtn, modeMenu, modePanel, {
      align: 'left',
      width: PERM_W,
      onOpen: function () {
        modelMorph.hide();
        permMorph.hide();
        playModePill();
      },
      onClose: function () { }
    });

    modeBtn.addEventListener('click', function () {
      if (disabled) return;
      modeMorph.toggle();
    });

    function playModePill() {
      const index = modeIndex(agentMode);
      placePill(modePill, modeRowEls, index);
      const danger = MODE_OPTIONS[index] && MODE_OPTIONS[index].tone === 'danger';
      modePill.style.background = danger
        ? 'color-mix(in srgb, #e25507 10%, transparent)'
        : 'color-mix(in srgb, var(--text-1) 7%, transparent)';
    }

    function syncMode() {
      const index = modeIndex(agentMode);
      const opt = MODE_OPTIONS[index];
      modeIc.innerHTML = '';
      modeIc.appendChild(icon(opt.icon, 12));
      modeLabel.textContent = T(opt.label[0], opt.label[1]);
      if (opt.tone === 'danger') modeBtn.setAttribute('data-tone', 'danger');
      else modeBtn.removeAttribute('data-tone');
      modeRowEls.forEach(function (row, i) {
        const ck = row.querySelector('.dac-perm-check');
        if (ck) ck.hidden = i !== index;
      });
      playModePill();
    }

    /* ---------- 胶囊 / 用量 ---------- */
    function thinkOf(id) {
      return THINK_STOPS[thinkIndex(id)];
    }

    function syncPill() {
      const t = thinkOf(thinking);
      pillIc.innerHTML = '';
      pillIc.appendChild(icon(t.icon, 12));
      const hit = models.find(function (m) { return m.id === model; });
      pillModel.textContent = hit ? (hit.label || hit.id) : (model || T('未配置模型', 'No model'));
      pillThink.textContent = T(t.label[0], t.label[1]);
      effort.setValue(thinking);
    }

    function syncUsage() {
      const budget = Math.max(1, usage.budget || 1);
      const ratio = M.clamp((usage.used || 0) / budget, 0, 1);
      path.setAttribute('stroke-dashoffset', String(C * (1 - ratio)));
      let stroke = 'var(--text-2)';
      if (ratio >= 0.92) stroke = '#dc4b41';
      else if (ratio >= 0.8) stroke = '#d99015';
      path.setAttribute('stroke', stroke);
      capBtn.title = T('上下文占用 ', 'Context ') + Math.round(ratio * 100) + '%';
      capBtn.setAttribute('aria-label', capBtn.title);
      /* 0% 的时候那颗圆环就是个空圈，看着像多出来的控件（用户截图里就把它圈出来了）。
         没占用就不显示，用了一次之后淡入。 */
      capBtn.classList.toggle('is-empty', ratio < 0.005);
    }

    /* ---------- 输入 / 自适应高度 ---------- */
    /* 长文本：从 60 长到 min(300, 窗口 42%)，到顶后框内滚动。
       高度写在 rAF 里算，连续输入时一帧只排一次版。 */
    let sizeTick = 0;
    function autosizeNow() {
      input.style.height = 'auto';
      const cap = Math.min(TEXTAREA_MAX_H, Math.max(120, Math.round(root.innerHeight * 0.42)));
      const next = Math.max(TEXTAREA_MIN_H, Math.min(cap, input.scrollHeight));
      input.style.height = next + 'px';
    }
    function autosize() {
      if (sizeTick) return;
      sizeTick = root.requestAnimationFrame(function () {
        sizeTick = 0;
        autosizeNow();
      });
    }

    function hasContent() {
      return !!input.value.trim() || attachments.length > 0;
    }

    function syncSend() {
      if (busy) {
        sendBtn.disabled = !o.onStop || stopping;
        sendBtn.setAttribute('data-state', o.onStop ? 'stop' : 'idle');
        sendBtn.innerHTML = '';
        sendBtn.appendChild(icon(stopping ? 'clock' : 'stop', 12));
        sendBtn.setAttribute('aria-label', stopping ? T('正在停止', 'Stopping') : T('停止', 'Stop'));
        return;
      }
      const ready = hasContent();
      sendBtn.disabled = !ready || disabled;
      sendBtn.setAttribute('data-state', ready ? 'ready' : 'idle');
      sendBtn.innerHTML = '';
      sendBtn.appendChild(icon('send', 12));
      sendBtn.setAttribute('aria-label', T('发送', 'Send'));
    }

    /* ---------- @ 候选 ---------- */
    function closeMentions() {
      if (mentionState && mentionState.box) mentionState.box.remove();
      mentionState = null;
      input.setAttribute('aria-expanded', 'false');
    }

    function resolveDir() {
      const d = typeof o.dir === 'function' ? o.dir() : (o.dir || '');
      if (d) return Promise.resolve(d);
      /* AI 整页没有页面上下文，退回上次用过的目录，@ 才不会变成死功能 */
      return Promise.resolve(API.configGet ? API.configGet() : null).then(function (c) {
        return (c && (c.last_folder || c.lastFolder)) || '';
      }).catch(function () { return ''; });
    }

    function loadDir() {
      return resolveDir().then(function (d) {
        if (!d) return { dir: '', items: [] };
        if (dirCacheKey === d && dirCache) return { dir: d, items: dirCache };
        return Promise.resolve(API.listDir(d)).then(function (res) {
          const items = (res && (res.items || res.entries)) || [];
          dirCache = items;
          dirCacheKey = d;
          return { dir: d, items: items };
        }).catch(function () { return { dir: d, items: [] }; });
      });
    }

    function activeToken() {
      const caret = input.selectionStart || 0;
      const before = input.value.slice(0, caret);
      const at = before.lastIndexOf('@');
      if (at < 0) return null;
      const chunk = before.slice(at + 1);
      if (/[\s\n]/.test(chunk)) return null;
      return { at: at, query: chunk, caret: caret };
    }

    function openMentions(token) {
      loadDir().then(function (res) {
        if (!token || input.selectionStart !== token.caret) return;
        const q = token.query.toLowerCase();
        const hits = res.items.filter(function (it) {
          const name = it.name || it.path || '';
          return !q || String(name).toLowerCase().indexOf(q) >= 0;
        }).slice(0, 8);
        if (!hits.length) {
          if (res.dir) { closeMentions(); return; }
          closeMentions();
          const box = el('div', 'dac-mentions');
          const hint = el('div', 'dac-mention-hint',
            T('当前页面没有目录上下文，去「整理文件」或「空间工具」页再试',
              'No directory context here — try from Organize or Space tools'));
          box.appendChild(hint);
          field.appendChild(box);
          mentionState = { box: box, rows: [], token: token, index: 0 };
          input.setAttribute('aria-expanded', 'true');
          return;
        }
        closeMentions();
        const box = el('div', 'dac-mentions');
        box.setAttribute('role', 'listbox');
        const rows = hits.map(function (it, i) {
          const b = el('button', 'dac-mention');
          b.type = 'button';
          b.setAttribute('role', 'option');
          b.appendChild(icon(it.dir ? 'folder' : 'file', 12));
          b.appendChild(el('span', 'dac-mention-name', it.name || it.path));
          if (i === 0) b.setAttribute('data-active', '');
          b.addEventListener('click', function () { applyMention(token, it); });
          box.appendChild(b);
          return b;
        });
        field.appendChild(box);
        mentionState = { box: box, rows: rows, token: token, index: 0 };
        input.setAttribute('aria-expanded', 'true');
      });
    }

    function applyMention(token, item) {
      const name = item.name || item.path || '';
      const before = input.value.slice(0, token.at);
      const after = input.value.slice(input.selectionStart || token.caret);
      const insert = '@' + name + ' ';
      input.value = before + insert + after;
      const caret = (before + insert).length;
      input.setSelectionRange(caret, caret);
      closeMentions();
      autosize();
      syncSend();
      input.focus();
    }

    function moveMention(delta) {
      if (!mentionState || !mentionState.rows.length) return false;
      const rows = mentionState.rows;
      rows[mentionState.index].removeAttribute('data-active');
      mentionState.index = (mentionState.index + delta + rows.length) % rows.length;
      rows[mentionState.index].setAttribute('data-active', '');
      return true;
    }

    /* ---------- 附件 ---------- */
    function kindOf(path) {
      return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(path) ? 'image' : 'file';
    }

    function nameOf(path) {
      const parts = String(path).split(/[\\/]/);
      return parts[parts.length - 1] || path;
    }

    function addPaths(paths) {
      (paths || []).forEach(function (p) {
        if (attachments.length >= MAX_ATTACH) return;
        if (attachments.some(function (a) { return a.path === p; })) return;
        attachments.push({ path: p, name: nameOf(p), kind: kindOf(p) });
      });
      renderAtts();
      syncSend();
    }

    function renderAtts() {
      atts.innerHTML = '';
      atts.hidden = attachments.length === 0;
      if (!attachments.length) return;
      attachments.forEach(function (att, index) {
        const box = el('div', 'dac-att');
        if (att.kind === 'image') {
          const frame = el('div', 'dac-att-img');
          let url = '';
          try {
            url = root.__TAURI__ && root.__TAURI__.core && root.__TAURI__.core.convertFileSrc
              ? root.__TAURI__.core.convertFileSrc(att.path) : '';
          } catch (e) { url = ''; }
          if (url) {
            const img = document.createElement('img');
            img.src = url;
            img.alt = att.name;
            img.addEventListener('error', function () {
              frame.innerHTML = '';
              const ph = el('span', 'dac-att-ph');
              ph.appendChild(icon('image', 20));
              frame.appendChild(ph);
            });
            frame.appendChild(img);
          } else {
            const ph = el('span', 'dac-att-ph');
            ph.appendChild(icon('image', 20));
            frame.appendChild(ph);
          }
          const x = el('button', 'dac-att-x dac-att-x--img');
          x.type = 'button';
          x.setAttribute('aria-label', T('移除 ', 'Remove ') + att.name);
          x.appendChild(icon('close', 10));
          x.addEventListener('click', function () { removeAtt(index); });
          box.appendChild(frame);
          box.appendChild(x);
        } else {
          const card = el('div', 'dac-att-file');
          const boxIc = el('div', 'dac-att-box');
          boxIc.appendChild(icon(/\.(txt|md|csv|json|log)$/i.test(att.name) ? 'file' : 'archive', 16));
          const meta = el('div', 'dac-att-meta');
          meta.appendChild(el('div', 'dac-att-name', att.name));
          meta.appendChild(el('div', 'dac-att-kind', att.kind === 'image' ? T('图片', 'Image') : T('文件', 'File')));
          const x = el('button', 'dac-att-x');
          x.type = 'button';
          x.setAttribute('aria-label', T('移除 ', 'Remove ') + att.name);
          x.appendChild(icon('close', 11));
          x.addEventListener('click', function () { removeAtt(index); });
          card.appendChild(boxIc);
          card.appendChild(meta);
          card.appendChild(x);
          box.appendChild(card);
        }
        atts.appendChild(box);
      });
    }

    function removeAtt(index) {
      attachments.splice(index, 1);
      renderAtts();
      syncSend();
    }

    /* ---------- 提交 ---------- */
    function payload() {
      const mentions = [];
      const re = /@([^\s@]+)/g;
      let m;
      while ((m = re.exec(input.value))) mentions.push(m[1]);
      return {
        text: input.value.trim(),
        model: model,
        thinking: thinking,
        attachments: attachments.map(function (a) { return a.path; }),
        skills: [],
        mentions: mentions,
        permission: permission
      };
    }

    function submit() {
      if (busy || disabled || !hasContent()) return;
      const p = payload();
      input.value = '';
      attachments = [];
      renderAtts();
      autosize();
      syncSend();
      if (o.onSubmit) o.onSubmit(p);
    }

    /* ---------- 事件 ---------- */
    input.addEventListener('input', function () {
      autosize();
      syncSend();
      const token = activeToken();
      if (token) openMentions(token);
      else closeMentions();
    });

    let composing = false;
    input.addEventListener('compositionstart', function () { composing = true; });
    input.addEventListener('compositionend', function () { composing = false; });

    input.addEventListener('keydown', function (e) {
      if (mentionState) {
        if (e.key === 'ArrowDown') { e.preventDefault(); moveMention(1); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); moveMention(-1); return; }
        if (e.key === 'Escape') { e.preventDefault(); closeMentions(); return; }
        if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) {
          e.preventDefault();
          const row = mentionState.rows[mentionState.index];
          if (row) row.click();
          return;
        }
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        if (composing || e.keyCode === 229) return;
        e.preventDefault();
        submit();
        return;
      }
      /* 输入框为空时退格，先把最后一个附件拿掉（原版同手感） */
      if (e.key === 'Backspace' && !input.value && attachments.length) {
        e.preventDefault();
        removeAtt(attachments.length - 1);
      }
    });

    input.addEventListener('paste', function () {
      root.setTimeout(function () { autosize(); syncSend(); }, 0);
    });

    input.addEventListener('focus', function () { surface.classList.add('is-focus'); });
    input.addEventListener('blur', function () { surface.classList.remove('is-focus'); });

    attachBtn.addEventListener('click', function () {
      if (disabled || attachments.length >= MAX_ATTACH) return;
      Promise.resolve(API.pickFiles()).then(function (paths) {
        if (paths && paths.length) addPaths(paths);
      }).catch(function () { });
    });

    capBtn.addEventListener('click', function () {
      UIx.toast(T('上下文占用 ', 'Context ') + Math.round(M.clamp((usage.used || 0) / Math.max(1, usage.budget || 1), 0, 1) * 100) +
        '% · ' + (usage.used || 0) + ' / ' + (usage.budget || 0) + ' token', 'info', 2600);
    });

    sendBtn.addEventListener('click', function () {
      if (busy) { if (o.onStop && !stopping) o.onStop(); return; }
      submit();
    });

    /* 拖放文件 */
    surface.addEventListener('dragover', function (e) { e.preventDefault(); });
    surface.addEventListener('drop', function (e) {
      e.preventDefault();
      const files = e.dataTransfer && e.dataTransfer.files;
      if (!files || !files.length) return;
      const paths = [];
      for (let i = 0; i < files.length; i++) {
        if (files[i].path) paths.push(files[i].path);
      }
      if (paths.length) addPaths(paths);
    });

    /* 点外面关菜单 / Esc 关菜单 */
    function onDocDown(e) {
      if (modelMorph.open && !pillWrap.contains(e.target) && !modelMenu.contains(e.target)) modelMorph.hide();
      if (permMorph.open && !permWrap.contains(e.target) && !permMenu.contains(e.target)) permMorph.hide();
      if (mentionState && !field.contains(e.target)) closeMentions();
    }
    function onDocKey(e) {
      if (e.key !== 'Escape') return;
      if (modelMorph.open) { modelMorph.hide(); return; }
      if (permMorph.open) { permMorph.hide(); return; }
      if (mentionState) closeMentions();
    }
    /* 气泡是 fixed 定位，跟着页面滚会脱开触发块 —— 一滚就关掉（捕获阶段收，
       包括 .ai-scroll 这种内部滚动容器）。 */
    function onAnyScroll(e) {
      if (!modelMorph.open && !permMorph.open) return;
      const t = e.target;
      if (t && t.nodeType === 1 && (modelMenu.contains(t) || permMenu.contains(t))) return;
      if (modelMorph.open) modelMorph.hide();
      if (permMorph.open) permMorph.hide();
    }
    root.document.addEventListener('mousedown', onDocDown, true);
    root.document.addEventListener('keydown', onDocKey, true);
    root.document.addEventListener('scroll', onAnyScroll, true);

    function onResize() {
      modelMorph.layout();
      permMorph.layout();
      effort.resize();
    }
    root.addEventListener('resize', onResize);

    /* ---------- 初始化 ---------- */
    rebuildModels();
    syncPill();
    syncPerm();
    syncMode();
    syncUsage();
    autosize();
    syncSend();

    if (disabled) {
      wrap.classList.add('is-disabled');
      input.disabled = true;
      attachBtn.disabled = true;
    }

    if (typeof host.appendChild === 'function') host.appendChild(wrap);

    const api = {
      el: wrap,
      input: input,
      get value() { return input.value; },
      getValue: function () { return input.value; },
      setValue: function (v) { input.value = v || ''; autosize(); syncSend(); },
      focus: function () { input.focus(); },
      setBusy: function (next, isStopping) {
        busy = !!next;
        stopping = !!isStopping;
        input.readOnly = busy;
        syncSend();
      },
      setUsage: function (u) { usage = u || usage; syncUsage(); },
      setModel: function (id) {
        model = id;
        if (models.length && !models.some(function (m) { return m.id === id; })) {
          models = models.concat([{ id: id, label: id }]);
          rebuildModels();
        }
        syncRows();
        syncPill();
      },
      setThinking: function (v) { thinking = v; syncPill(); },
      setPermission: function (p) { permission = p; syncPerm(); },
      setMode: function (m) { agentMode = m || 'off'; syncMode(); },
      getMode: function () { return agentMode; },
      setModels: function (list) {
        models = (list || []).map(function (m) { return typeof m === 'string' ? { id: m, label: m } : m; });
        rebuildModels();
        syncPill();
      },
      setDisabled: function (next) {
        disabled = !!next;
        input.disabled = disabled;
        attachBtn.disabled = disabled;
        wrap.classList.toggle('is-disabled', disabled);
        syncSend();
      },
      setReducedMotion: function (v) { effort.setReducedMotion(v); },
      /* 档位上的 token 数字由上层按当前模型窗口算好传进来；window 写进标题右侧，
         让人一眼看到「档位是窗口的 25/50/75%，窗口是模型自己报的」 */
      setThinkBudgets: function (list, window) {
        effort.setBudgets(list);
        const win = Number(window) || 0;
        effortMeta.textContent = win > 0 ? T('窗口 ', 'window ') + fmtTokens(win) : '';
        effort.resize();
        if (modelMorph.open) modelMorph.layout();
      },
      openMenu: function () { modelMorph.show(); },
      closeMenu: function () { modelMorph.hide(); },
      destroy: function () {
        root.document.removeEventListener('mousedown', onDocDown, true);
        root.document.removeEventListener('keydown', onDocKey, true);
        root.document.removeEventListener('scroll', onAnyScroll, true);
        root.removeEventListener('resize', onResize);
        if (sizeTick) { root.cancelAnimationFrame(sizeTick); sizeTick = 0; }
        modelMorph.destroy();
        permMorph.destroy();
        modeMorph.destroy();
        effort.destroy();
        if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      }
    };

    return api;
  };

  root.AIComposer = AIComposer;
  if (typeof module !== 'undefined' && module.exports) module.exports = AIComposer;
})(typeof window !== 'undefined' ? window : globalThis);

