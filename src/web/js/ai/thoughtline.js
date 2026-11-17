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

    /* 思考正文：模型的推理片段按帧追加进 .tl-thought。
       必须在这里先声明——初始化时 refreshToggle() 会读它，晚声明会踩 TDZ。 */
    let thoughtEl = null;
    let thoughtBuf = '';
    let thoughtRaf = 0;
    let stick = true;

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
    const chevron = UIx.h('span', { class: 'tl-chevron', 'aria-hidden': 'true' }, UIx.icon('chevron'));
    const sr = UIx.h('span', { class: 'tl-sr', role: 'status' }, o.label);

    const stepsEl = UIx.h('div', { class: 'tl-steps' });
    const fold = UIx.h('div', { class: 'tl-fold' }, stepsEl);
    const trace = UIx.h('div', { class: 'tl-trace' }, fold);

    const parts = [];
    if (glyph) parts.push(glyph);
    parts.push(stack);
    if (o.showTimer) parts.push(timer);
    if (o.collapsible) parts.push(chevron);
    parts.push(sr);

    const head = o.collapsible
      ? UIx.h('button', { type: 'button', class: 'tl-head', tabindex: '-1' }, parts)
      : UIx.h('div', { class: 'tl-head' }, parts);

    if (o.collapsible) {
      head.addEventListener('click', function () {
        if (toggleable()) setOpen(!open);
      });
    }

    const el = UIx.h('div', { class: 'tl', 'data-working': '' }, head, trace);

    /* ---------------- 状态 ---------------- */

    function toggleable() {
      return o.collapsible && (stepsEl.children.length > 0 || !!thoughtEl);
    }

    function hasBody() {
      return stepsEl.children.length > 0 || !!thoughtEl;
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
      } else {
        head.removeAttribute('data-toggle');
        head.tabIndex = -1;
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

    /* 思考正文：模型吐一段推理，就往里追一段。
       追加走 rAF 合批（一帧最多写一次 DOM），只有用户本来就在底部时才自动跟随，
       自己滚上去看前文时不会被拽回底部。 */
    function flushThought() {
      thoughtRaf = 0;
      if (dead || !thoughtEl || !thoughtBuf) return;
      thoughtEl.appendChild(document.createTextNode(thoughtBuf));
      thoughtBuf = '';
      if (stick) thoughtEl.scrollTop = thoughtEl.scrollHeight;
    }

    function addThought(text) {
      if (dead || typeof text !== 'string' || !text) return;
      if (!thoughtEl) {
        thoughtEl = UIx.h('div', { class: 'tl-thought', 'data-streaming': '', role: 'log' });
        thoughtEl.addEventListener('scroll', function () {
          stick = thoughtEl.scrollHeight - thoughtEl.scrollTop - thoughtEl.clientHeight < 24;
        });
        fold.insertBefore(thoughtEl, stepsEl);
        refreshToggle();
        if (working) setOpen(true);
      }
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
      if (thoughtEl && thoughtBuf) {
        thoughtEl.appendChild(document.createTextNode(thoughtBuf));
        thoughtBuf = '';
        thoughtEl.scrollTop = thoughtEl.scrollHeight;
      }
      if (thoughtEl) thoughtEl.removeAttribute('data-streaming');
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
      get seconds() { return ds / 10; }
    };
  }

  root.AIThoughtLine = { create: create };
})(typeof window !== 'undefined' ? window : globalThis);
