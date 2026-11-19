/* AI 推理强度滑块 · 逐项复刻原版 EffortSlider
   ------------------------------------------------------------
   原版是 React + radix Slider + gsap 的 `.reasoning-effort` 组件。本软件没有
   npm/打包器，因此这里用原生 DOM + AIMotion 做同一套东西，DOM 结构、CSS 变量、
   数值、手势阈值、缓动曲线全部与原版一一对应：

     .reasoning-effort[data-dragging][data-maximum][data-disabled]
       └ .reasoning-effort-input            role=slider，30px 高，cursor grab
           ├ .reasoning-effort-track        30px，999px 圆角
           │   ├ .reasoning-effort-fill     clip-path 裁切（不是改 canvas 宽度）
           │   │   └ canvas                 满宽绘制，64 星点 + 7 条柔光带
           │   ├ .reasoning-effort-dots     左右 16px，三点；到顶时 opacity 0
           │   └ .reasoning-effort-thumb    26px 白滑块，带形变变量
           └ .reasoning-effort-input-thumb  32×30 透明焦点块（对齐原版 thumb）
       └ .reasoning-effort-stops            三列 grid，ghost 按钮 简单/中度/深度

   要点（与原版一致，改这些等于改行为）：
   - canvas 永远铺满整条轨道，进度靠 clip-path 裁；拖动时只更新 preview。
   - 指针位移 < 4px 不算拖动；只有松手 / 键盘才 onChange，拖动中不发事件。
   - 松手先 Math.round 到整数档再 commit；pointercancel / lostpointercapture 回退。
   - 位置 500ms glideEase（20 点弹簧表线性插值）、按下 80ms 缩到 .96、
     松手 320ms 恢复；形变速度驱动，上限 3.5 / 0.46，90ms 跟随后 720ms 归位。
*/
(function (root) {
  'use strict';

  const M = root.AIMotion;
  /* 这里只用到两个词，借 UI 的语言开关即可，不另造一套 */
  const T = (zh, en) => {
    const ui = root.UI;
    if (ui && typeof ui.T === 'function') return ui.T(zh, en);
    return typeof document !== 'undefined' && document.documentElement.lang === 'en-US' ? en : zh;
  };

  /* ---------- 常量（全部照原版） ---------- */
  const TRACK_H = 30;
  const KNOB = 26;          /* 视觉滑块直径 */
  const KNOB_TOP = 2;
  const KNOB_PAD = 3;       /* 滑块距轨道左端 */
  const INSET = 32;         /* clip-path 与 dots 用的内缩 */
  const THUMB_HIT_W = 32;   /* 原版 .reasoning-effort-input-thumb 宽 */

  const DRAG_THRESHOLD = 4; /* px，位移小于它不算拖动 */
  const V_MAX = 3.5;
  const D_MAX = 0.46;

  const SPRING_TABLE = [
    [0, 0], [0.02, 0.015], [0.04, 0.0532], [0.06, 0.1065], [0.08, 0.1686],
    [0.1, 0.2351], [0.13, 0.3363], [0.16, 0.4332], [0.2, 0.5495], [0.24, 0.648],
    [0.28, 0.7287], [0.33, 0.807], [0.38, 0.8646], [0.44, 0.9128], [0.5, 0.9447],
    [0.57, 0.968], [0.65, 0.9834], [0.74, 0.9924], [0.85, 0.9975], [1, 1]
  ];

  function glideEase(p) {
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    let end = -1;
    for (let i = 0; i < SPRING_TABLE.length; i++) {
      if (SPRING_TABLE[i][0] >= p) { end = i; break; }
    }
    if (end <= 0) return end === 0 ? 0 : 1;
    const x0 = SPRING_TABLE[end - 1][0], y0 = SPRING_TABLE[end - 1][1];
    const x1 = SPRING_TABLE[end][0], y1 = SPRING_TABLE[end][1];
    return y0 + (y1 - y0) * (p - x0) / (x1 - x0);
  }

  const RETURN_EASE = M.springEase(400, 23, 0.72);
  const POWER2_OUT = M.ease.out;

  /* ---------- Canvas 场：色带 + 星点 ---------- */
  function createEffortField(canvas, getRatio, onResize) {
    const ctx = canvas.getContext('2d');
    let width = 0, height = 0, phase = 0;

    const stars = Array.from({ length: 64 }, function (_, i) {
      return {
        x: (i * 0.61803398875) % 1,
        y: (i * 0.754877666) % 1,
        size: 0.35 + (i % 5) * 0.13,
        speed: 0.3 + (i % 7) * 0.1
      };
    });

    function resize() {
      /* 菜单收起时 shell 是 hidden，clientWidth 为 0；此时不能把画布压成 1×1，
         否则重新展开会闪一帧空白（ResizeObserver 之后才补回来）。 */
      const host = canvas.parentElement || canvas;
      const w = host.clientWidth || 0;
      const h = host.clientHeight || 0;
      if (w < 8 || h < 8) return;
      width = w;
      height = h;
      const dpr = Math.min(root.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function draw(dt, ratio, still, boost) {
      if (!ctx || width <= 0 || height <= 0) return;
      const b = boost || 1;
      if (!still) phase += Math.min(Math.max(dt, 0), 0.05) * (0.16 + ratio * 0.85) * Math.max(1, b);

      const hue = 210 + ratio * ratio * 63;
      const fill = 32 + (width - 32) * ratio;

      ctx.clearRect(0, 0, width, height);

      /* 底色：满宽铺，靠 fill 决定渐变的右端 */
      const base = ctx.createLinearGradient(0, 0, Math.max(fill, 32), 0);
      base.addColorStop(0, '#30343a');
      base.addColorStop(0.28, 'hsl(' + (hue - 12) + ' 38% 47%)');
      base.addColorStop(0.65, 'hsl(' + hue + ' 79% 70%)');
      base.addColorStop(1, 'hsl(' + (hue + 5) + ' 88% 70%)');
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, width, height);

      ctx.save();
      ctx.globalCompositeOperation = 'screen';

      /* 7 条正弦带宽线 */
      for (let band = 0; band < 7; band++) {
        ctx.beginPath();
        for (let x = 0; x <= width + 4; x += 4) {
          const y = height * (0.12 + band * 0.15) +
            Math.sin(x * 0.034 + phase + band * 1.8) * 5 +
            Math.sin(x * 0.079 - phase * 0.6 + band) * 2 -
            x * 0.035;
          if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.lineWidth = 2 + (band % 3) * 2;
        ctx.strokeStyle = 'hsla(' + (hue + band * 2) + ' 90% 87% / ' + (0.06 + ratio * 0.025) + ')';
        ctx.stroke();
      }

      /* 右侧径向光 */
      const glowX = fill * (0.6 + Math.sin(phase * 0.7) * 0.12);
      const glow = ctx.createRadialGradient(glowX, height * 0.7, 0, glowX, height * 0.7, 46);
      glow.addColorStop(0, 'hsla(' + (hue - 12) + ' 100% 88% / .35)');
      glow.addColorStop(1, 'hsla(' + hue + ' 100% 80% / 0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, width, height);

      /* 星点 */
      for (let i = 0; i < stars.length; i++) {
        const star = stars[i];
        const x = ((star.x + phase * star.speed * 0.08) % 1) * width;
        const y = ((((star.y - phase * star.speed * 0.04) % 1) + 1) % 1) * height;
        const fade = Math.min(1, x / 55);
        const twinkle = 0.45 + Math.sin(phase * 2 + i * 1.9) * 0.25;
        ctx.fillStyle = 'rgba(255,255,255,' + (fade * twinkle * (0.4 + ratio * 0.6)) + ')';
        ctx.beginPath();
        ctx.ellipse(x, y, star.size * (1 + ratio * 0.5), star.size * 0.65, -0.45, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();

      /* 左侧压暗，让白滑块有对比 */
      const shade = ctx.createLinearGradient(0, 0, Math.max(fill, 32), 0);
      shade.addColorStop(0, 'rgba(36,39,44,.8)');
      shade.addColorStop(0.45, 'rgba(36,39,44,0)');
      ctx.fillStyle = shade;
      ctx.fillRect(0, 0, width, height);
    }

    resize();
    let ro = null;
    if (root.ResizeObserver) {
      ro = new root.ResizeObserver(function () { resize(); if (onResize) onResize(); });
      ro.observe(canvas);
    }

    return {
      draw: draw,
      resize: resize,
      dispose: function () { if (ro) ro.disconnect(); }
    };
  }

  /* ---------- 形变控制器：位置 + 按压 + 拉伸/倾斜 ---------- */
  function createEffortMotion(el, canvas, initialRatio, initialReduced) {
    const state = { ratio: initialRatio, press: 1, body: 0, lean: 0, boost: 1 };
    let targetRatio = initialRatio;
    let reduced = !!initialReduced;
    let disposed = false;
    let posTl = null, pressTl = null, shapeTl = null, boostTl = null;
    let unTick = null;

    const field = createEffortField(canvas, function () { return state.ratio; },
      function () { resumeIfSized(); });

    /* 画布被收起（0×0）时没人看得见，却还在每帧重算 64 星点 + 7 条柔光带。
       AI 页默认把强度滑块收在折叠区里，于是整页常驻 144 次/秒的 rAF。
       这里按「画布真的有像素」开关 ticker：收起即停，展开再起。 */
    function fieldSized() {
      const host = canvas.parentElement || canvas;
      return (host.clientWidth || 0) >= 8 && (host.clientHeight || 0) >= 8;
    }

    function resumeIfSized() {
      if (disposed) return;
      if (fieldSized() || !root.ResizeObserver) startTicker();
      else stopTicker();
    }

    function paint() {
      if (disposed) return;
      el.style.setProperty('--effort-ratio', String(state.ratio));
      el.style.setProperty('--effort-press', String(state.press));
      el.style.setProperty('--effort-jelly-x', String(1 + state.body));
      el.style.setProperty('--effort-jelly-y', String(1 - state.body * 0.3));
      el.style.setProperty('--effort-jelly-offset', (-state.lean * 9) + 'px');
      el.style.setProperty('--effort-jelly-skew', (-state.lean * 12) + 'deg');
      el.style.setProperty('--effort-jelly-left', (50 + state.lean * 32) + '%');
      el.style.setProperty('--effort-jelly-right', (50 - state.lean * 24) + '%');
    }

    function startTicker() {
      stopTicker();
      if (reduced) {
        field.draw(0, state.ratio, true, state.boost);
        return;
      }
      let last = 0;
      unTick = M.onTick(function (dt) {
        if (root.document && root.document.hidden) { last = 0; return; }
        last = dt;
        field.draw(dt / 1000, state.ratio, false, state.boost);
      });
    }

    function stopTicker() {
      if (unTick) { unTick(); unTick = null; }
    }

    function killAll() {
      if (posTl) { posTl.kill(); posTl = null; }
      if (pressTl) { pressTl.kill(); pressTl = null; }
      if (shapeTl) { shapeTl.kill(); shapeTl = null; }
      if (boostTl) { boostTl.kill(); boostTl = null; }
    }

    paint();
    resumeIfSized();

    return {
      moveTo: function (ratio, immediate) {
        resumeIfSized();
        targetRatio = Math.max(0, Math.min(1, ratio));
        if (posTl) posTl.kill();
        posTl = M.timeline(paint);
        posTl.to(state, { ratio: targetRatio }, {
          duration: (immediate || reduced) ? 0 : 0.5,
          ease: glideEase,
          reducedMotion: reduced
        });
      },
      press: function () {
        if (pressTl) pressTl.kill();
        pressTl = M.timeline(paint);
        pressTl.to(state, { press: reduced ? 1 : 0.96 }, {
          duration: reduced ? 0 : 0.08,
          ease: M.ease.out,
          reducedMotion: reduced
        });
      },
      drag: function (velocity) {
        if (reduced || disposed) return;
        const speed = Math.min(V_MAX, Math.abs(velocity));
        const deformation = Math.min(D_MAX, 0.045 + speed * 0.17);
        const lean = (velocity < 0 ? -1 : 1) * deformation;

        if (shapeTl) shapeTl.kill();
        shapeTl = M.timeline(paint);
        /* 90ms 压出形变，停手后 70ms 静默再 720ms 回弹（原版 timeline 同序） */
        shapeTl.to(state, { body: deformation, lean: lean }, {
          duration: 0.09, ease: POWER2_OUT
        });
        shapeTl.to(state, { body: 0, lean: 0 }, {
          duration: 0.72, ease: RETURN_EASE, after: 0.07
        });

        if (boostTl) boostTl.kill();
        boostTl = M.timeline(null);
        boostTl.to(state, { boost: 1 + Math.min(2.2, 0.55 + speed * 0.6) }, {
          duration: 0.12, ease: POWER2_OUT
        });
      },
      release: function () {
        if (pressTl) pressTl.kill();
        if (shapeTl) shapeTl.kill();
        if (boostTl) boostTl.kill();

        pressTl = M.timeline(paint);
        pressTl.to(state, { press: 1 }, {
          duration: reduced ? 0 : 0.32, ease: POWER2_OUT, reducedMotion: reduced
        });

        shapeTl = M.timeline(paint);
        shapeTl.to(state, { body: 0, lean: 0 }, {
          duration: reduced ? 0 : 0.72, ease: RETURN_EASE, reducedMotion: reduced
        });

        boostTl = M.timeline(null);
        boostTl.to(state, { boost: 1 }, {
          duration: reduced ? 0 : 0.7, ease: POWER2_OUT, reducedMotion: reduced
        });
      },
      setReducedMotion: function (next) {
        next = !!next;
        if (next === reduced) return;
        reduced = next;
        killAll();
        state.ratio = targetRatio;
        state.press = 1;
        state.body = 0;
        state.lean = 0;
        state.boost = 1;
        paint();
        resumeIfSized();
      },
      resize: field.resize,
      dispose: function () {
        disposed = true;
        killAll();
        stopTicker();
        field.dispose();
      }
    };
  }

  /* ---------- 组件 ---------- */
  /* 兜底刻度：上层总会传自己的 stops（来自 strength.js），
     这里只在没人传时保证滑块不是空的 */
  const DEFAULT_STOPS = [
    { value: 'off', label: '关闭' },
    { value: 'low', label: '低' },
    { value: 'medium', label: '中' },
    { value: 'high', label: '高' }
  ];

  const Effort = {};

  /* Effort.create(host, {stops, value, onChange, ariaLabel, disabled})
     → {el, value(), setValue(), setDisabled(), setReducedMotion(), resize(), destroy()} */
  Effort.create = function (host, opts) {
    const o = opts || {};
    const stops = Array.isArray(o.stops) && o.stops.length >= 2 ? o.stops : DEFAULT_STOPS;
    const max = stops.length - 1;
    let disabled = !!o.disabled;
    let value = o.value != null ? o.value : stops[Math.min(1, max)].value;
    let onChange = o.onChange || null;

    let active = Math.max(0, stops.findIndex(function (s) { return s.value === value; }));
    let preview = active;
    let dragging = false;
    let gesture = null;
    let reduced = M.prefersReduced();
    /* 档位值（token）由上层按档位算好传进来；没传就不显示数字，不编造。
      budgetLabels 是上层给的显示文案（例如「1.6K」「不思考」），
       有它就用它——数字怎么念由策略层决定，滑块不自己发明单位。 */
    let budgets = {};
    let budgetLabels = {};
    /* 档位刻度上写的是「思考预算多少 token」，而 budgets 里放的是「查几轮」。
       两个数字不能混用：写 10 token 是错的，写 10 轮才是对的。 */
    let budgetTokens = {};

    const el = document.createElement('div');
    el.className = 'reasoning-effort';

    const input = document.createElement('div');
    input.className = 'reasoning-effort-input';
    input.setAttribute('role', 'slider');
    input.setAttribute('tabindex', '0');
    input.setAttribute('aria-label', o.ariaLabel || '推理强度');
    input.setAttribute('aria-orientation', 'horizontal');
    input.setAttribute('aria-valuemin', '0');
    input.setAttribute('aria-valuemax', String(max));

    const track = document.createElement('div');
    track.className = 'reasoning-effort-track';

    const fill = document.createElement('div');
    fill.className = 'reasoning-effort-fill';
    fill.setAttribute('aria-hidden', 'true');
    const canvas = document.createElement('canvas');
    fill.appendChild(canvas);

    const dots = document.createElement('div');
    dots.className = 'reasoning-effort-dots';
    dots.setAttribute('aria-hidden', 'true');
    stops.forEach(function () { dots.appendChild(document.createElement('span')); });

    const knob = document.createElement('span');
    knob.className = 'reasoning-effort-thumb';
    knob.setAttribute('aria-hidden', 'true');

    track.appendChild(fill);
    track.appendChild(dots);
    track.appendChild(knob);

    /* 原版 radix Thumb：透明的 32×30 焦点块，位置跟着值走 */
    const hit = document.createElement('span');
    hit.className = 'reasoning-effort-input-thumb';
    hit.setAttribute('aria-hidden', 'true');

    input.appendChild(track);
    input.appendChild(hit);

    const stopRow = document.createElement('div');
    stopRow.className = 'reasoning-effort-stops';
    /* 每档除了名字，还带一个 token 数字：这个数字由上层按「当前模型窗口」算好传进来，
       滑块本身不去猜 —— 模型能吃多少，档位就标多少。 */
    const stopVals = [];
    const stopBtns = stops.map(function (stop, index) {
      const b = document.createElement('button');
      b.type = 'button';
      const nm = document.createElement('span');
      nm.className = 're-stop-name';
      nm.textContent = stop.label;
      const val = document.createElement('span');
      val.className = 're-stop-val';
      val.hidden = true;
      b.appendChild(nm);
      b.appendChild(val);
      b.setAttribute('aria-pressed', String(index === active));
      b.addEventListener('click', function () { if (!disabled) commit(index); });
      stopRow.appendChild(b);
      stopVals.push(val);
      return b;
    });

    el.appendChild(input);
    el.appendChild(stopRow);
    host.appendChild(el);

    const motion = createEffortMotion(el, canvas, max ? preview / max : 0, reduced);

    function ratio() { return max ? preview / max : 0; }
    function selected() { return Math.min(max, Math.max(0, Math.round(preview))); }

    function fmtTokens(n) {
      const v = Math.max(0, Math.round(n || 0));
      if (v >= 1024 * 1024) return (v / (1024 * 1024)).toFixed(1).replace(/\.0$/, '') + 'M';
      if (v >= 1024) return Math.round(v / 1024) + 'K';
      return String(v);
    }

    /* 档位旁边标的是「思考预算多少 token」（0 就直说「不思考」）。
       上下文窗口是另一处的数字：想得深不该等于记得少。 */
    function paintBudgets() {
      stops.forEach(function (stop, i) {
        const t = Number(budgetTokens[stop.value] || 0);
        const n = Number(budgets[stop.value] || 0);
        const label = budgetLabels[stop.value];
        const v = stopVals[i];
        if (!v) return;
        if (label || t > 0) {
          v.textContent = label || (t >= 1024 ? fmtTokens(t) : String(t));
          v.hidden = false;
          v.title = t > 0
            ? T('思考预算约 ', 'thinking budget ~') + t + T(' token · 最多查 ', ' tokens · up to ') + n + T(' 轮', ' rounds')
            : T('不分配思考预算', 'no thinking budget');
        } else {
          v.textContent = '';
          v.hidden = true;
          v.removeAttribute('title');
        }
      });
      syncAria();
    }

    function syncAria() {
      const s = selected();
      const cur = stops[s];
      const t = cur ? Number(budgetTokens[cur.value] || 0) : 0;
      const txt = cur ? (budgetLabels[cur.value] || (t > 0 ? String(t) : '')) : '';
      input.setAttribute('aria-valuenow', String(s));
      input.setAttribute('aria-valuetext', cur
        ? cur.label + (txt ? ' · ' + txt + T(' 思考预算', ' thinking budget') : '')
        : '');
      hit.style.left = 'calc((100% - ' + THUMB_HIT_W + 'px) * ' + ratio() + ' + ' +
        ((THUMB_HIT_W - KNOB) / 2) + 'px)';
      stopBtns.forEach(function (b, i) {
        b.setAttribute('aria-pressed', String(i === s));
        const one = stops[i];
        const lab = one ? (budgetLabels[one.value] || '') : '';
        const tt = one ? Number(budgetTokens[one.value] || 0) : 0;
        if (one && (lab || tt > 0)) {
          b.setAttribute('title', one.label + ' · ' + (lab || tt) + T(' 思考预算', ' thinking budget'));
        } else {
          b.removeAttribute('title');
        }
      });
      if (s === max) el.setAttribute('data-maximum', '');
      else el.removeAttribute('data-maximum');
    }

    function updatePreview(next) {
      preview = Math.max(0, Math.min(max, next));
      syncAria();
      motion.moveTo(ratio(), dragging);
    }

    function commit(next) {
      const index = Math.max(0, Math.min(max, Math.round(next)));
      updatePreview(index);
      if (stops[index] && stops[index].value !== value) {
        value = stops[index].value;
        active = index;
        if (onChange) onChange(value);
      }
    }

    function cancelGesture() {
      gesture = null;
      dragging = false;
      el.removeAttribute('data-dragging');
      preview = active;
      syncAria();
      motion.moveTo(ratio(), false);
      motion.release();
    }

    /* 指针位置 → 连续档位。轨道内可用行程是 (宽 - 32)，两侧各留 3px。 */
    function ratioAt(clientX) {
      const rect = track.getBoundingClientRect();
      const travel = Math.max(1, rect.width - INSET);
      return Math.max(0, Math.min(1, (clientX - rect.left - INSET / 2) / travel));
    }

    function onDown(e) {
      if (disabled || !max) return;
      if (!e.isPrimary || e.button !== 0) return;
      gesture = { id: e.pointerId, startX: e.clientX, lastX: e.clientX, time: e.timeStamp, moved: false };
      /* 必须抓住指针：不抓的话指针一离开这 30px 高的轨道，pointerup 就落在
         别的元素上，gesture 永远清不掉 —— 之后鼠标在轨道上随便一动就被
         当成还在拖，滑块跟着鼠标跑（用户报的那个 bug）。 */
      try { input.setPointerCapture(e.pointerId); } catch (err) { /* 老内核兜底 */ }
      /* radix 的指针按下就是「跳到该位置」，这里照做，否则点轨道没反应 */
      updatePreview(ratioAt(e.clientX) * max);
      motion.press();
    }

    function onMove(e) {
      if (!gesture || e.pointerId !== gesture.id) return;
      /* 没按键 = 手势已经结束（例如在窗口外松手），立刻收摊，不跟手 */
      if (e.buttons === 0) { endGesture(); return; }
      if (!gesture.moved && Math.abs(e.clientX - gesture.startX) < DRAG_THRESHOLD) return;
      if (!gesture.moved) {
        gesture.moved = true;
        dragging = true;
        el.setAttribute('data-dragging', '');
      }
      const velocity = (e.clientX - gesture.lastX) / Math.max(8, e.timeStamp - gesture.time);
      updatePreview(ratioAt(e.clientX) * max);
      motion.drag(velocity);
      gesture.lastX = e.clientX;
      gesture.time = e.timeStamp;
    }

    /* 松手：能落在轨道上就提交，落在窗口任何地方都算结束（window 上也挂了监听） */
    function onUp(e) {
      if (!gesture || e.pointerId !== gesture.id) return;
      endGesture();
      /* 松手先吸附到最近整数档，再 commit */
      commit(Math.round(preview));
      motion.release();
      try { input.releasePointerCapture(e.pointerId); } catch (err) { /* 已释放 */ }
    }

    function endGesture() {
      gesture = null;
      dragging = false;
      el.removeAttribute('data-dragging');
      motion.release();
    }

    input.addEventListener('pointerdown', onDown);
    input.addEventListener('pointermove', onMove);
    input.addEventListener('pointerup', onUp);
    /* 指针在轨道外、窗口内松手：捕获期间事件仍在 input 上，但窗口丢了焦点
       （Alt+Tab、抽屉关闭）就不一定了，所以再挂一层 window 兜底。 */
    root.addEventListener('pointerup', onUp);
    root.addEventListener('pointercancel', function () { if (gesture) cancelGesture(); });
    input.addEventListener('pointercancel', function () { if (gesture) cancelGesture(); });
    input.addEventListener('lostpointercapture', function () { if (gesture) cancelGesture(); });
    root.addEventListener('blur', function () { if (gesture) cancelGesture(); });

    input.addEventListener('keydown', function (e) {
      let next = selected();
      const key = e.key;
      if (key === 'ArrowRight' || key === 'ArrowUp' || key === 'PageUp') next += 1;
      else if (key === 'ArrowLeft' || key === 'ArrowDown' || key === 'PageDown') next -= 1;
      else if (key === 'Home') next = 0;
      else if (key === 'End') next = max;
      else return;
      e.preventDefault();
      e.stopPropagation();
      if (!disabled) commit(next);
    });

    const media = root.matchMedia ? root.matchMedia('(prefers-reduced-motion: reduce)') : null;
    function onMedia() {
      reduced = media.matches;
      motion.setReducedMotion(reduced);
    }
    if (media && media.addEventListener) media.addEventListener('change', onMedia);

    syncAria();
    paintBudgets();
    motion.moveTo(ratio(), true);

    return {
      el: el,
      get value() { return value; },
      setValue: function (next) {
        const index = Math.max(0, stops.findIndex(function (s) { return s.value === next; }));
        value = stops[index].value;
        active = index;
        if (!dragging) { preview = index; syncAria(); motion.moveTo(ratio(), false); }
      },
      /* list: [{ id: 'simple', steps: 3 }, ...] —— 每档查几轮。
         兼容旧的 {id, budget}：老调用方传 token 数时不再标 token，
         只当「有值」处理，不会把 16384 印到界面上。 */
      setBudgets: function (list) {
        budgets = {};
        budgetLabels = {};
        budgetTokens = {};
        (list || []).forEach(function (s) {
          if (!s || !s.id) return;
          if (typeof s.label === 'string' && s.label) budgetLabels[s.id] = s.label;
          const t = Number(s.budget || s.think || 0);
          if (t > 0) budgetTokens[s.id] = t;
          const n = Number(s.steps || 0);
          if (n > 0) budgets[s.id] = n;
        });
        paintBudgets();
      },
      setDisabled: function (next) {
        disabled = !!next;
        if (disabled) el.setAttribute('data-disabled', '');
        else el.removeAttribute('data-disabled');
        input.setAttribute('tabindex', disabled ? '-1' : '0');
      },
      setReducedMotion: function (next) {
        reduced = !!next;
        motion.setReducedMotion(reduced);
      },
      resize: function () { motion.resize(); },
      destroy: function () {
        if (media && media.removeEventListener) media.removeEventListener('change', onMedia);
        root.removeEventListener('pointerup', onUp);
        motion.dispose();
        if (el.parentNode) el.parentNode.removeChild(el);
      }
    };
  };

  root.AIEffortSlider = Effort;
  if (typeof module !== 'undefined' && module.exports) module.exports = Effort;
})(typeof window !== 'undefined' ? window : globalThis);
