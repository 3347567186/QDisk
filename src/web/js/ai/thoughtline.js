/* AI 助手 · 思路行（查证过程）
   ------------------------------------------------------------
   移植自 React Bits 的 ThoughtLine 组件（reactbits.dev，MIT，见 THIRD_PARTY.md）。
   原版是 React + motion + hugeicons；本软件没有 npm、没有打包器（纯 <script>），
   所以按「同样的语义、同样的参数口径」用原生 DOM 重写，不重新发明交互：

   - 呼吸：glyph 与 label 在谷值到 1 之间明暗往复，谷值 = 1 - depth。
     指针是 glyph，文字是句子；有微光时文字不呼吸，呼吸只留给 glyph。
   - 微光：工作态一道亮带从左扫到右（线性、无限），落定即停。
   - 落定：文字交叉淡入淡出 + 2px 模糊 + 计时器滑到句子末尾 + 过程折起。
     计时器用 transform 滑动（不改布局），宽度变化由 ResizeObserver 兜住。
   - 过程：每个工具一行，追加即入列、带 tick 标记；落定后整块折成一行，
     点标题可再摊开（chevron 翻转，fold 走 grid-template-rows）。

   动效全部交给 CSS（keyframes / transition），JS 只管状态、计时与测量，
   这样 reduced-motion 能被「JS 侧 prefersReduced + CSS 媒体查询」双重兜住。
   对外：AIThoughtLine.create(opts) → { el, addStep, settle, setLabel, destroy } */
(function (root) {
  'use strict';

  const UIx = root.UI;

  /* 四角星：原版用 Hugeicons SparklesIcon；这里内联一条等价路径，
     不为了一个图标再引一包图标（软件本身零 npm 依赖）。 */
  const SPARKLE =
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
    '<path d="M12 2.4c.38 3.2 1.36 5.4 3.1 6.9 1.55 1.34 3.6 2.1 6.5 2.7' +
    '-2.9.6-4.95 1.36-6.5 2.7-1.74 1.5-2.72 3.7-3.1 6.9-.38-3.2-1.36-5.4-3.1-6.9' +
    '-1.55-1.34-3.6-2.1-6.5-2.7 2.9-.6 4.95-1.36 6.5-2.7C10.64 7.8 11.62 5.6 12 2.4z"/>' +
    '</svg>';

  /* 计时文本：0.1s 精度，过一分钟换成 m s */
  function fmt(sec) {
    if (sec < 60) return sec.toFixed(1) + 's';
    const m = Math.floor(sec / 60);
    return m + 'm ' + (sec - m * 60).toFixed(1) + 's';
  }

  function create(opts) {
    const o = Object.assign({
      label: 'Thinking…',
      doneLabel: '',
      glyph: 'sparkle',       /* 'sparkle' | 'dot' | 'none' */
      collapsible: true,
      collapseOnSettle: true,
      showTimer: true,
      breathPeriod: 1.6,
      breathDepth: 0.45,
      shimmer: true,
      shimmerDuration: 1.8,
      settleDuration: 350,
      settleBlur: 2,
      fontSize: 0,          /* 0 = 跟随 CSS 的 --tl-font（默认 --fs-small） */
      copyLabel: '复制',
      copiedLabel: '已复制',
      thoughtLabel: '思考',   /* 每行思考前面的那枚标签 */
      onAppend: null,
      speak: null,
      onSettle: null
    }, opts || {});

    const reduce = !!(root.AIMotion && root.AIMotion.prefersReduced());
    const depth = reduce ? Math.min(o.breathDepth, 0.2) : o.breathDepth;
    const period = reduce ? o.breathPeriod * 1.5 : o.breathPeriod;
    const sheen = o.shimmer && !reduce;

    let working = true;
    let open = true;
    let ds = 0;                 /* 十分之一秒，和原版口径一致 */
    let ticker = 0;
    let ro = null;
    let dead = false;

    /* 思考正文：模型的推理片段按「行」追加，一行一句、单行截断。
       形状对齐常用的 agent 轨迹列表：左侧一枚「思考 ·」标签，右侧灰色小字，
       超出宽度直接省略，不把整段推理摊成正文抢回答的注意力。
       必须在这里先声明——初始化时 refreshToggle() 会读它，晚声明会踩 TDZ。 */
    let thoughtWrap = null;     /* .tl-thoughts 容器 */
    let curRow = null;          /* 当前这一行 */
    let curText = null;         /* 当前行的文字层 */
    let thoughtCount = 0;       /* 已经起了多少行（用于落定摘要） */
    let thoughtBuf = '';        /* 攒着等下一帧一起写，避免一帧一个节点 */
    let thoughtRaf = 0;

    /* ---------------- DOM ---------------- */

    /* glyph：sparkle（默认）| dot | none | 自定义 HTML 片段 */
    let glyph = null;
    if (o.glyph !== 'none') {
      if (o.glyph === 'sparkle') glyph = UIx.h('span', { class: 'tl-glyph', 'aria-hidden': 'true', html: SPARKLE });
      else if (o.glyph === 'dot') glyph = UIx.h('span', { class: 'tl-glyph', 'aria-hidden': 'true' }, UIx.h('span', { class: 'tl-dot' }));
      else glyph = UIx.h('span', { class: 'tl-glyph', 'aria-hidden': 'true', html: String(o.glyph) });
    }
    const breath = UIx.h('span', { class: 'tl-breath' }, o.label);
    if (sheen) breath.setAttribute('data-shimmer', '');

    const workText = UIx.h('span', { class: 'tl-text', 'data-active': '' }, breath);
    const doneText = UIx.h('span', { class: 'tl-text tl-text--done' }, o.doneLabel);
    const stack = UIx.h('span', { class: 'tl-label', 'aria-hidden': 'true' }, workText, doneText);
    const timer = UIx.h('span', { class: 'tl-timer', 'aria-hidden': 'true' }, '0.0s');

    /* 复制：整段思考正文一键带走（正文本身也可直接拖动选中）。
       按钮在思路行标题里，点它不能连带折起/摊开整块，所以 stopPropagation。 */
    const copyBtn = UIx.h('button', {
      type: 'button',
      class: 'tl-copy',
      title: o.copyLabel,
      'aria-label': o.copyLabel,
      hidden: ''
    }, UIx.icon('copy'));
    copyBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      ev.preventDefault();
      const text = thoughtWrap ? thoughtWrap.textContent : '';
      if (!text) return;
      try { UIx.copy(text); } catch (e) { /* 复制失败不该影响对话 */ }
      copyBtn.setAttribute('data-done', '');
      root.setTimeout(function () { if (!dead) copyBtn.removeAttribute('data-done'); }, 1200);
    });

    const chevron = UIx.h('span', { class: 'tl-chevron', 'aria-hidden': 'true' }, UIx.icon('chevron'));
    const sr = UIx.h('span', { class: 'tl-sr', role: 'status' }, o.label);

    const stepsEl = UIx.h('div', { class: 'tl-steps' });
    const fold = UIx.h('div', { class: 'tl-fold' }, stepsEl);
    const trace = UIx.h('div', { class: 'tl-trace' }, fold);

    const parts = [];
    if (glyph) parts.push(glyph);
    parts.push(stack);
    if (o.showTimer) parts.push(timer);
    parts.push(copyBtn);
    if (o.collapsible) parts.push(chevron);
    parts.push(sr);

    /* 标题行用 div + role=button：里面还要放「复制」按钮，
       嵌套 <button> 是非法结构，浏览器会把内层按钮拆到外层去。 */
    const head = UIx.h('div', { class: 'tl-head', tabindex: '-1' }, parts);

    if (o.collapsible) {
      head.addEventListener('click', function (ev) {
        if (ev.target && ev.target.closest && ev.target.closest('.tl-copy')) return;
        if (toggleable()) setOpen(!open);
      });
      head.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        if (!toggleable()) return;
        ev.preventDefault();
        setOpen(!open);
      });
    }

    const el = UIx.h('div', { class: 'tl', 'data-working': '' }, head, trace);

    /* ---------------- 状态 ---------------- */

    function toggleable() {
      return o.collapsible && (stepsEl.children.length > 0 || !!thoughtWrap);
    }

    function hasBody() {
      return stepsEl.children.length > 0 || !!thoughtWrap;
    }

    function setOpen(v) {
      open = !!v;
      const show = open && hasBody();
      if (show) trace.setAttribute('data-open', '');
      else trace.removeAttribute('data-open');
      if (show) el.setAttribute('data-open', '');
      else el.removeAttribute('data-open');
      if (toggleable()) head.setAttribute('aria-expanded', open ? 'true' : 'false');
      else head.removeAttribute('aria-expanded');
    }

    function refreshToggle() {
      const t = toggleable();
      if (t) {
        head.setAttribute('data-toggle', '');
        head.tabIndex = 0;
        head.setAttribute('role', 'button');
      } else {
        head.removeAttribute('data-toggle');
        head.tabIndex = -1;
        head.removeAttribute('role');
      }
      if (t) chevron.setAttribute('data-on', '');
      else chevron.removeAttribute('data-on');
    }

    /* 计时器滑动：落定后贴到句子末尾，宽度变化时重算（不改布局，只动 transform） */
    function placeTimer(glide) {
      if (!o.showTimer) return;
      const active = working ? workText : doneText;
      const shift = active.offsetWidth - stack.offsetWidth;
      if (!glide) timer.style.transition = 'none';
      timer.style.transform = 'translateX(' + shift + 'px)';
      if (!glide) {
        void timer.offsetWidth;
        timer.style.transition = '';
      }
    }

    function paint(next) {
      ds = next;
      if (o.showTimer) timer.textContent = fmt(ds / 10);
    }

    function startClock() {
      if (!o.showTimer || !working) return;
      const t0 = performance.now();
      paint(0);
      ticker = root.setInterval(function () {
        paint(Math.floor((performance.now() - t0) / 100));
      }, 100);
    }

    /* ---------------- 对外 ---------------- */

    function addStep(step) {
      if (dead) return null;
      const s = step || {};
      const ok = s.ok !== false;
      const summary = s.summary || s.error || '';
      const row = UIx.h('div', { class: 'ai-step tl-step' + (ok ? '' : ' bad'), 'data-ok': ok ? '' : undefined },
        UIx.h('span', { class: 'tl-mark', 'aria-hidden': 'true' }),
        UIx.h('span', { class: 'ai-step-name' }, s.text || ''),
        summary ? UIx.h('span', { class: 'ai-step-sum', title: summary }, summary) : null,
        s.ms ? UIx.h('span', { class: 'ai-step-ms' }, Math.round(s.ms) + 'ms') : null
      );
      stepsEl.appendChild(row);
      paintMarks();
      refreshToggle();
      setOpen(working ? true : open);
      if (working) sr.textContent = s.text ? s.text + '…' : o.label;
      return row;
    }

    /* 思考正文按行追加：一句一行，行内单行截断。
       形状对齐 agent 的轨迹列表——行首一枚「思考」标签，右侧灰色小字，
       超宽直接省略号；完整文字仍留在 DOM 里，复制按钮与读屏都拿得到全量。 */
    function newRow() {
      curText = UIx.h('span', { class: 'tl-thought-text' });
      curRow = UIx.h('div', { class: 'tl-thought-row', 'data-streaming': '' },
        UIx.h('span', { class: 'tl-tag', 'aria-hidden': 'true' }, o.thoughtLabel),
        curText
      );
      thoughtWrap.appendChild(curRow);
      thoughtCount += 1;
    }

    function ensureWrap() {
      if (thoughtWrap) return;
      thoughtWrap = UIx.h('div', { class: 'tl-thoughts', role: 'log' });
      fold.insertBefore(thoughtWrap, stepsEl);
      refreshToggle();
      if (working) setOpen(true);
    }

    function endRow() {
      if (curRow) curRow.removeAttribute('data-streaming');
      curRow = null;
      curText = null;
    }

    /* 句末标点就收行；没收到的半句留在当前行，下一批继续往里接 */
    function writeThought(buf) {
      ensureWrap();
      if (!curRow) newRow();
      let rest = buf;
      while (rest) {
        const m = rest.match(/[\n。！？；]+/);
        if (!m) {
          curText.appendChild(document.createTextNode(rest));
          break;
        }
        const cut = m.index + m[0].length;
        curText.appendChild(document.createTextNode(rest.slice(0, cut)));
        rest = rest.slice(cut).replace(/^\s+/, '');
        endRow();
        if (rest) newRow();
      }
    }

    function flushThought() {
      thoughtRaf = 0;
      if (dead || !thoughtBuf) return;
      const buf = thoughtBuf;
      thoughtBuf = '';
      writeThought(buf);
      copyBtn.hidden = false;
      if (typeof o.onAppend === 'function') o.onAppend();
    }

    function addThought(text) {
      if (dead || typeof text !== 'string' || !text) return;
      ensureWrap();
      thoughtBuf += text;
      if (!thoughtRaf) thoughtRaf = root.requestAnimationFrame(flushThought);
    }

    /* 过程行的标记：跑着的最后一步是一颗呼吸的点，其余（和落定后全部）是勾或叹号。
       原版就是这个口径（i < steps.length - 1 ? tick : pulse）。 */
    function paintMarks() {
      const rows = stepsEl.children;
      const last = rows.length - 1;
      for (let i = 0; i < rows.length; i += 1) {
        const mark = rows[i].firstChild;
        if (!mark) continue;
        if (working && i === last) {
          if (!mark.firstChild || !mark.firstChild.classList || !mark.firstChild.classList.contains('tl-pulse')) {
            mark.innerHTML = '<i class="tl-pulse"></i>';
          }
        } else {
          const ok = rows[i].hasAttribute('data-ok');
          const name = ok ? 'check' : 'alert';
          if (mark.dataset.icon !== name) {
            mark.dataset.icon = name;
            mark.innerHTML = '';
            mark.appendChild(UIx.icon(name));
          }
        }
      }
    }

    function settle(info) {
      if (dead || !working) return;
      /* 收尾时把攒着的最后一段同步写完，不然会丢尾巴 */
      if (thoughtRaf) { root.cancelAnimationFrame(thoughtRaf); thoughtRaf = 0; }
      if (thoughtBuf) {
        const tail = thoughtBuf;
        thoughtBuf = '';
        writeThought(tail);
        copyBtn.hidden = false;
      }
      endRow();
      const i = info || {};
      working = false;
      const done = typeof i.doneLabel === 'string' && i.doneLabel
        ? i.doneLabel
        : (o.doneLabel || (o.showTimer ? 'Thought for' : 'Done thinking'));
      doneText.textContent = done;
      paintMarks();

      if (ticker) { root.clearInterval(ticker); ticker = 0; }
      el.removeAttribute('data-working');
      workText.removeAttribute('data-active');
      doneText.setAttribute('data-active', '');
      if (o.showTimer) timer.setAttribute('data-done', '');
      if (o.collapseOnSettle) setOpen(false);
      refreshToggle();
      placeTimer(true);

      const seconds = ds / 10;
      sr.textContent = done + ' ' + (o.speak ? o.speak(seconds) : fmt(seconds));
      if (typeof o.onSettle === 'function') o.onSettle(seconds);
    }

    function setLabel(text) {
      if (dead || !working) return;
      breath.textContent = text;
      placeTimer(false);
    }

    function destroy() {
      dead = true;
      if (ticker) { root.clearInterval(ticker); ticker = 0; }
      if (thoughtRaf) { root.cancelAnimationFrame(thoughtRaf); thoughtRaf = 0; }
      if (ro) { ro.disconnect(); ro = null; }
      el.remove();
    }

    /* ---------------- 初始化 ---------------- */

    el.style.setProperty('--tl-trough', String(1 - depth));
    el.style.setProperty('--tl-period', period + 's');
    el.style.setProperty('--tl-shimmer', o.shimmerDuration + 's');
    el.style.setProperty('--tl-settle', o.settleDuration + 'ms');
    el.style.setProperty('--tl-blur', o.settleBlur + 'px');
    if (o.fontSize) el.style.setProperty('--tl-font', o.fontSize + 'px');

    refreshToggle();
    setOpen(true);
    startClock();

    if (root.ResizeObserver) {
      ro = new root.ResizeObserver(function () { placeTimer(false); });
      ro.observe(stack);
      ro.observe(workText);
      ro.observe(doneText);
    }
    /* 首次测量要等节点进 DOM；进 DOM 后 ResizeObserver 也会补一次 */
    root.requestAnimationFrame(function () { if (!dead) placeTimer(false); });

    return {
      el: el,
      addStep: addStep,
      addThought: addThought,
      settle: settle,
      setLabel: setLabel,
      open: function () { setOpen(true); },
      close: function () { setOpen(false); },
      destroy: destroy,
      get working() { return working; },
      get seconds() { return ds / 10; },
      get thoughts() { return thoughtCount; }
    };
  }

  root.AIThoughtLine = { create: create };
})(typeof window !== 'undefined' ? window : globalThis);
