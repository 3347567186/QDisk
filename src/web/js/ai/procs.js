/* 查证过程组 · DSH（DeepSeek Harness）式过程行
   ------------------------------------------------------------
   一轮对话里的「想过什么、查了什么」不再塞进正文，也不再用一大团缩进段落：
     ▸ 执行 3 次思考，调用 4 次工具，记录 2 条
       ✳ 思考   · 先看这台机器上有几块盘…
       ▸ 磁盘   · 磁盘 3 个 · 4ms
       ▸ 空文件夹 · dir="C:\Users\十二" · depth=2
   折叠时只剩组头一行；展开后是平铺的过程行，每行 = 图标 + 类别 + 参数摘要（等宽）。
   行可点开：思考行展开原文，工具行展开结果摘要与原始返回。

   视觉口径抄自 dsh-claude-style 的 Process rows（MIT，见 THIRD_PARTY.md），
   颜色与字号换成本项目的 token，不另造一套。

   对外：AIProcs.create(opts) → { el, addThought, addStep, setRunning, settle,
                                  open, close, destroy, counts }
   opts: { lang, onAppend } —— onAppend 在内容变化后调用，用来把对话滚到底。 */
(function (root) {
  'use strict';

  const UIx = root.UI;
  const h = UIx.h;
  const T = UIx.T;

  /* 图标按「这一步在干什么」分，不按工具名硬编码：
     同一个图标族的工具有同一个观感，新工具不用改这里也能落到默认图标。 */
  const ICON = {
    think: 'spark',
    list_dir: 'folder',
    read_file: 'file',
    open_path: 'external',
    disk_roots: 'drive',
    top_files: 'chart',
    empty_dirs: 'broom',
    search_files: 'search',
    search_roots: 'search',
    file_signals: 'shield',
    installed_apps: 'apps',
    archive_entries: 'archive',
    organize_preview: 'organize',
    last_organize: 'clock',
    clean_candidates: 'broom',
    settings_read: 'settings',
    propose_action: 'bulb',
    list_proposals: 'layers',
    cancel_proposal: 'close',
    navigate: 'external'
  };

  /* 没有 label 的工具（未来新增）退回工具名本身，行上不会出现空白 */
  function labelOf(step) {
    const l = String((step && step.label) || '').trim();
    if (l) return l;
    return String((step && step.tool) || '工具');
  }

  /* 参数摘要：一眼能看出「查的是哪儿」。
     路径与关键字原样保留，长串最后才截；空参数不出分隔符。 */
  function argsLine(args) {
    if (!args || typeof args !== 'object') return '';
    const keys = Object.keys(args).filter(function (k) {
      const v = args[k];
      return v !== undefined && v !== null && v !== '' &&
        !(Array.isArray(v) && !v.length) &&
        !(typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);
    });
    const parts = [];
    for (let i = 0; i < keys.length && parts.length < 3; i += 1) {
      const k = keys[i];
      let v = args[k];
      if (typeof v === 'object') {
        try { v = JSON.stringify(v); } catch (e) { v = String(v); }
      }
      let s = String(v);
      if (s.length > 56) s = s.slice(0, 55) + '…';
      parts.push(k + '=' + s);
    }
    return parts.join(' · ');
  }

  /* 思考的第一句：折叠时给一行，别把整段推理摊在对话里。
     中英文都要切得开：中文按句末标点，英文按「句点 + 空格」，
     这样「3.5 GB」「v1.2」不会被当成句子边界。 */
  function firstSentence(text) {
    const raw = String(text || '').replace(/\*\*/g, '').replace(/^[-*\s]+/, '');
    const cut = raw
      .split(/(?<=[。！？\n])|(?<=[.!?])\s+/)
      .map(function (s) { return s.trim(); })
      .filter(Boolean)[0] || '';
    return cut.length > 64 ? cut.slice(0, 63) + '…' : cut;
  }

  /* 可点元素：鼠标、回车、空格三件事都要能用 */
  function clickable(el, fn) {
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.addEventListener('click', fn);
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); }
    });
    return el;
  }

  function create(opts) {
    const o = opts || {};
    const onAppend = typeof o.onAppend === 'function' ? o.onAppend : function () {};

    const counts = { thoughts: 0, tools: 0, records: 0 };
    let running = true;
    let thought = null;      // 当前正在流式接收的思考行
    let open = false;
    let started = Date.now();

    const caret = h('span', { class: 'pg-caret', 'aria-hidden': 'true' }, UIx.icon('chevron', 11));
    const title = h('span', { class: 'pg-title' });
    const head = h('div', { class: 'pg-head' }, caret, title);

    /* 过程行与等待行分开装：等待行永远在最后，插行只往 list 里塞 */
    const list = h('div', { class: 'pg-list' });
    const runDot = h('span', { class: 'pg-run-dots', 'aria-hidden': 'true' },
      h('i', {}), h('i', {}), h('i', {}));
    /* 等待行是「现在在干什么」的唯一出口，读屏要能听到换词不重复播报 */
    const runText = h('span', { class: 'pg-run-text', role: 'status', 'aria-live': 'polite' });
    const runTime = h('span', { class: 'pg-run-time' });
    const run = h('div', { class: 'pg-run' }, runDot, runText, runTime);
    const rows = h('div', { class: 'pg-rows' }, list, run);

    const body = h('div', { class: 'pg-body' }, rows);
    const el = h('div', { class: 'pg', 'data-running': '' }, head, body);

    function paintTitle() {
      const parts = [];
      if (counts.thoughts) parts.push(T('执行 ' + counts.thoughts + ' 次思考', counts.thoughts + ' thoughts'));
      if (counts.tools) parts.push(T('调用 ' + counts.tools + ' 次工具', counts.tools + ' tool calls'));
      if (counts.records) parts.push(T('记录 ' + counts.records + ' 条', counts.records + ' records'));
      const line = parts.join(T('，', ', '));
      /* 还没数出东西的时候，组头就跟等待行说同一句话：
         上面写「正在查证」、下面写「正在思考」，用户会以为这是两件事 */
      title.textContent = line || (running && runText.textContent ? runText.textContent : T('正在查证', 'Checking'));
    }

    function setOpen(next) {
      open = !!next;
      if (open) el.setAttribute('data-open', '');
      else el.removeAttribute('data-open');
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
      onAppend();
    }

    clickable(head, function () { setOpen(!open); });
    head.setAttribute('aria-expanded', 'false');

    /* 每条可展开的行下面紧跟一个折叠容器：展开就是 0fr → 1fr，
       高度由内容自己撑，不用测量，也不会在收起的瞬间塌成 0 高度闪一下 */
    function rowWithOut(row, outInner) {
      const out = h('div', { class: 'pg-out' }, h('div', { class: 'pg-out-in' }, outInner));
      row.setAttribute('aria-expanded', 'false');
      clickable(row, function () {
        const on = row.getAttribute('aria-expanded') !== 'true';
        row.setAttribute('aria-expanded', on ? 'true' : 'false');
        onAppend();
      });
      list.insertBefore(row, null);
      list.insertBefore(out, null);
      return { row: row, out: out };
    }

    /* 思考行：先建行，随后流式片段都往里追加；这一段的原文折在行下 */
    function addThought(text) {
      const piece = String(text || '');
      if (!piece) return;
      if (!thought) {
        const detail = h('span', { class: 'pg-detail' });
        const ic = h('span', { class: 'pg-ic' }, UIx.icon(ICON.think, 15));
        const row = h('div', { class: 'pg-row pg-think', 'data-openable': '' },
          ic,
          h('span', { class: 'pg-label' }, T('思考', 'Thinking')),
          h('span', { class: 'pg-dot', 'aria-hidden': 'true' }, '·'),
          detail
        );
        const text2 = h('div', { class: 'pg-thought' });
        const box = rowWithOut(row, text2);
        thought = { row: row, detail: detail, text: '', textEl: text2, out: box.out };
        counts.thoughts += 1;
        paintTitle();
      }
      thought.text += piece;
      thought.textEl.textContent = thought.text;
      thought.detail.textContent = firstSentence(thought.text);
      if (running && open) onAppend();
    }

    /* 工具行：类别 + 参数摘要；展开是结果摘要与原始返回 */
    function addStep(step) {
      const s = step || {};
      thought = null;   // 下一次思考是新的一段
      const tool = String(s.tool || '');
      const detailText = String(s.detailText || (argsLine(s.args) || s.summary || ''));
      const ic = h('span', { class: 'pg-ic' }, UIx.icon(ICON[tool] || 'settings', 15));
      const row = h('div', {
        class: 'pg-row pg-tool' + (s.ok === false ? ' bad' : ''),
        'data-openable': ''
      },
        ic,
        h('span', { class: 'pg-label' }, labelOf(s)),
        h('span', { class: 'pg-dot', 'aria-hidden': 'true' }, '·'),
        h('span', { class: 'pg-detail' }, detailText),
        /* 耗时靠右贴着行尾：它是这一步的「多久」，不是展开里的内容 */
        s.ms ? h('span', { class: 'pg-ms' }, Math.round(Number(s.ms)) + 'ms') : null
      );
      const inner = h('div', { class: 'pg-out-box' });
      const lines = [];
      if (s.summary) lines.push(h('div', { class: 'pg-sum-line' }, String(s.summary)));
      if (s.error) lines.push(h('div', { class: 'pg-sum-line bad' }, String(s.error)));
      if (s.result !== undefined && s.result !== null) {
        let raw = s.result;
        if (typeof raw !== 'string') {
          try { raw = JSON.stringify(raw, null, 1); } catch (e) { raw = String(raw); }
        }
        if (raw) lines.push(h('pre', {}, String(raw).slice(0, 4000)));
      }
      if (!lines.length) lines.push(h('div', { class: 'pg-sum-line' }, T('没有返回内容', 'No output')));
      lines.forEach(function (l) { inner.appendChild(l); });

      const box = rowWithOut(row, inner);
      if (s.open) row.setAttribute('aria-expanded', 'true');
      counts.tools += 1;
      paintTitle();
      if (running && open) onAppend();
      /* 思考折在行下的容器：先把思考行与新行之间的顺序摆正 */
      return box;
    }

    function setRunning(next, word) {
      running = !!next;
      el.toggleAttribute('data-running', running);
      if (run.parentNode) run.hidden = !running;
      if (word) runText.textContent = word;
      else runText.textContent = T('正在查证', 'Working');
      /* 第一段思考还没到的时候，组头也得有字：只画一个 chevron 上去，
         用户会以为这一组已经空了 */
      paintTitle();
    }

    function setRecordCount(n) {
      counts.records = Math.max(0, Number(n) || 0);
      paintTitle();
    }

    /* 落定：计数定格、等待行收掉、过程折回一行 */
    function settle(info) {
      const i = info || {};
      if (Number(i.thoughts) >= 0) counts.thoughts = Math.max(counts.thoughts, Number(i.thoughts) || 0);
      if (Number(i.tools) >= 0) counts.tools = Math.max(counts.tools, Number(i.tools) || 0);
      if (Number(i.records) >= 0) counts.records = Math.max(0, Number(i.records) || 0);
      running = false;
      el.removeAttribute('data-running');
      if (run.parentNode) run.parentNode.removeChild(run);
      paintTitle();
      /* 状态词是「附注」不是「替身」：计数是这一轮的事实，不能被
         「已停止」三个字吃掉——用户要能同时看到查了几次、停在哪 */
      if (i.label) {
        const base = title.textContent;
        title.textContent = /正在(查证|思考|推理|整理)/.test(base) ? i.label : base + T(' · ', ' · ') + i.label;
      }
      setOpen(false);
      started = 0;
      /* 一问一答、没有思考也没有工具的一轮：这一组本来就是空的，
         留一行「正在查证」等于给用户看一个假过程，直接收掉 */
      if (!counts.thoughts && !counts.tools) el.hidden = true;
      onAppend();
    }

    const timer = root.setInterval(function () {
      if (!running) return;
      const sec = Math.max(0, Math.round((Date.now() - started) / 1000));
      const m = Math.floor(sec / 60);
      runTime.textContent = m ? m + T(' 分 ', 'm ') + (sec % 60) + T(' 秒', 's') : sec + T(' 秒', 's');
    }, 1000);

    setRunning(true, T('正在思考', 'Thinking'));

    return {
      el: el,
      addThought: addThought,
      addStep: addStep,
      setRunning: setRunning,
      setRecords: setRecordCount,
      settle: settle,
      open: function () { setOpen(true); },
      close: function () { setOpen(false); },
      get counts() { return { thoughts: counts.thoughts, tools: counts.tools, records: counts.records }; },
      destroy: function () {
        root.clearInterval(timer);
        if (el.parentNode) el.parentNode.removeChild(el);
      }
    };
  }

  root.AIProcs = { create: create, argsLine: argsLine };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.AIProcs;
})(typeof window !== 'undefined' ? window : globalThis);
