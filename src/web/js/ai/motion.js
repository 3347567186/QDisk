/* AI 输入框 · 动效内核
   ------------------------------------------------------------
   为什么不用 gsap：本软件界面是纯 <script> 加载，没有 npm、没有打包器，
   npm 包引不进来。这里只实现组件真正用到的那部分语义，参数口径与规格一致：

   - 弹簧：入参就是 stiffness / damping（质量恒为 1），不做二次换算，
     因此 306.25/28、196/18.34、400/23 这些数字可以原样写进配置。
     中途反向 = 改 target，位置与速度都保留，天然连续。
   - 定时长补间：press 80ms、release 320ms 这类固定时长的过渡。
   - 单一 ticker：页面不可见时停，恢复可见时继续；订阅清空后自动停。

   所有动画都尊重 prefers-reduced-motion（也可由 options.reducedMotion 覆盖）。 */
(function (root) {
  'use strict';

  const M = {};

  M.prefersReduced = function (override) {
    if (typeof override === 'boolean') return override;
    try {
      return !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) {
      return false;
    }
  };

  /* ---------------- ticker ---------------- */

  const subs = new Set();
  let raf = 0;
  let last = 0;

  function hidden() {
    return !!(root.document && root.document.hidden);
  }

  function frame(now) {
    raf = 0;
    const dt = last ? Math.min(64, now - last) : 16.7;
    last = now;
    Array.from(subs).forEach(function (fn) {
      /* 回调抛错通常意味着它绑的 DOM 已经没了：退订，否则这条订阅会
         一直把 ticker 撑在那里空转（每帧 144 次），而且看不出来。 */
      try { fn(dt); } catch (e) { subs.delete(fn); }
    });
    if (subs.size && !hidden()) raf = root.requestAnimationFrame(frame);
    else last = 0;
  }

  function ensure() {
    if (raf || !subs.size || hidden()) return;
    last = 0;
    raf = root.requestAnimationFrame(frame);
  }

  function onTick(fn) {
    subs.add(fn);
    ensure();
    return function () {
      subs.delete(fn);
      if (!subs.size && raf) { root.cancelAnimationFrame(raf); raf = 0; last = 0; }
    };
  }

  if (root.document && root.document.addEventListener) {
    root.document.addEventListener('visibilitychange', function () {
      if (!hidden()) ensure();
    });
  }

  M.onTick = onTick;

  /* ---------------- 弹簧 ---------------- */

  /* M.spring(initialValue, onChange) → 控制器
     controller.to(target, {stiffness, damping, duration, velocity, onDone})
       duration 只作为兜底上限（规格里每个弹簧都带时长），到达即吸附目标值。
     controller.jump(value)  立即落位（reducedMotion / 初始化）
     controller.value        当前值
     controller.stop()       停止并将回调解绑 */
  M.spring = function (initial, onChange) {
    let x = Number(initial) || 0;
    let v = 0;
    let target = x;
    let k = 400;
    let c = 30;
    let dur = 0;
    let elapsed = 0;
    let onDone = null;
    let un = null;

    function detach() {
      if (un) { un(); un = null; }
    }

    function commit() {
      x = target;
      v = 0;
      detach();
      onChange(x);
      const cb = onDone;
      onDone = null;
      if (cb) cb();
    }

    function tick(dt) {
      // 半隐式欧拉 + 3 次子步，保证高刚度下不炸
      const sec = Math.max(0.004, Math.min(0.064, dt / 1000));
      const n = 3;
      const h = sec / n;
      for (let i = 0; i < n; i++) {
        const a = -k * (x - target) - c * v;
        v += a * h;
        x += v * h;
      }
      elapsed += dt;
      const settled = Math.abs(x - target) < 0.08 && Math.abs(v) < 2;
      if (settled || (dur && elapsed >= dur)) {
        commit();
        return;
      }
      onChange(x);
    }

    const ctrl = {
      get value() { return x; },
      get velocity() { return v; },
      get running() { return !!un; },
      to: function (nextTarget, cfg) {
        const o = cfg || {};
        target = Number(nextTarget) || 0;
        k = o.stiffness || 400;
        c = o.damping == null ? 2 * Math.sqrt(k) : o.damping;
        dur = o.duration || 0;
        if (o.velocity != null) v = o.velocity;
        onDone = o.onDone || null;
        elapsed = 0;
        if (M.prefersReduced(o.reducedMotion)) {
          commit();
          return ctrl;
        }
        detach();
        un = onTick(tick);
        return ctrl;
      },
      jump: function (value) {
        x = Number(value) || 0;
        v = 0;
        target = x;
        detach();
        onChange(x);
        return ctrl;
      },
      stop: detach
    };
    return ctrl;
  };

  /* ---------------- 定时长补间 ---------------- */

  const EASE = {
    out: function (t) { return 1 - Math.pow(1 - t, 3); },
    inOut: function (t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; },
    linear: function (t) { return t; }
  };

  M.ease = EASE;

  M.tween = function (from, to, duration, onUpdate, opts) {
    const o = opts || {};
    const ease = o.ease || EASE.out;
    const done = o.onDone || null;
    if (M.prefersReduced(o.reducedMotion)) {
      onUpdate(to);
      if (done) done();
      return function () {};
    }
    let t = 0;
    let un = null;
    un = onTick(function (dt) {
      t += dt;
      const p = Math.min(1, duration ? t / duration : 1);
      onUpdate(from + (to - from) * ease(p));
      if (p >= 1) {
        if (un) { un(); un = null; }
        if (done) done();
      }
    });
    return function () { if (un) { un(); un = null; } };
  };

  /* ---------------- 弹簧缓动函数（gsap 口径） ----------------
     原版用的是 gsap 的 springEase(stiffness, damping, duration)：它把阻尼振荡
     直接解成 [0,1] 上的缓动曲线，交给普通补间去走时长。这里照抄同一公式，
     于是 306.25/28/700ms、196/18.34/860ms、400/33/640ms 这些数字可以原样搬。 */
  M.springEase = function (stiffness, damping, duration) {
    const decay = damping / 2;
    const freq = Math.sqrt(Math.max(1e-6, stiffness - decay * decay));
    return function (progress) {
      if (progress <= 0 || progress >= 1) return progress;
      const time = progress * duration;
      return 1 - Math.exp(-decay * time) *
        (Math.cos(freq * time) + decay / freq * Math.sin(freq * time));
    };
  };

  /* ---------------- 时间线（多属性 + 绝对/相对起点） ----------------
     gsap.timeline() 的最小可用子集：一个对象上的若干属性各自补间，共享一个
     起点时钟。opts.delay 是相对时间线起点的秒数，opts.after 是相对「上一个
     补间结束」的秒数（对应 gsap 的 ">0.07"）。一个属性只保留最后一条通道，
     后写覆盖先写，等价于 gsap 的 overwrite。 */
  M.timeline = function (onUpdate) {
    const chans = new Map();
    let un = null;
    let elapsed = 0;
    let prevEnd = 0;
    let finished = false;

    function ensureRun() {
      if (un) return;
      finished = false;
      elapsed = 0;
      un = onTick(tick);
    }

    function tick(dt) {
      elapsed += dt / 1000;

      for (const ch of Array.from(chans.values())) {
        if (ch.dead) continue;
        const local = elapsed - ch.start;
        if (local < 0) continue;
        const p = ch.dur > 0 ? Math.min(1, local / ch.dur) : 1;
        const v = ch.from + (ch.to - ch.from) * ch.ease(p);
        ch.apply(v);
        if (p >= 1) {
          ch.dead = true;
          if (ch.onDone) ch.onDone();
        }
      }

      if (onUpdate) onUpdate(elapsed);

      const running = Array.from(chans.values()).some(function (c) { return c && !c.dead; });
      if (!running || finished) {
        if (un) { un(); un = null; }
      }
    }

    const tl = {
      to: function (obj, props, opts) {
        const o = opts || {};
        const dur = o.duration == null ? 0 : Number(o.duration);
        const start = o.delay != null ? Number(o.delay) : (o.after != null ? prevEnd + Number(o.after) : 0);
        const ease = o.ease || EASE.out;
        prevEnd = Math.max(prevEnd, start + dur);
        Object.keys(props).forEach(function (key) {
          const from = o.from != null ? Number(o.from) : Number(obj[key]) || 0;
          const to = Number(props[key]);
          chans.set(key, {
            from: from, to: to, start: start, dur: M.prefersReduced(o.reducedMotion) ? 0 : dur,
            ease: ease, dead: false, onDone: o.onDone || null,
            apply: function (v) {
              const value = o.round ? Math.round(v) : v;
              obj[key] = value;
              if (o.set) o.set(key, value);
            }
          });
        });
        ensureRun();
        return tl;
      },
      /* 立即落值（reducedMotion 与初始化用） */
      set: function (obj, props, opts) {
        const o = opts || {};
        Object.keys(props).forEach(function (key) {
          const to = Number(props[key]);
          chans.set(key, null);
          obj[key] = to;
          if (o.set) o.set(key, to);
        });
        if (onUpdate) onUpdate(elapsed);
        return tl;
      },
      call: function (fn, at) {
        const start = at == null ? prevEnd : Number(at);
        chans.set('__call_' + Math.random().toString(36).slice(2), {
          from: 0, to: 1, start: start, dur: 0.0001, ease: EASE.linear, dead: false,
          apply: function () {}, onDone: fn
        });
        ensureRun();
        return tl;
      },
      kill: function () {
        chans.clear();
        finished = true;
        if (un) { un(); un = null; }
        return tl;
      },
      get time() { return elapsed; }
    };
    return tl;
  };

  /* 连续圆角（squircle）：支持 corner-shape 时半径按 1.6 倍放大并写曲率，
     不支持时退回普通圆角——不能假装支持，否则 Windows 上圆角会过大。 */
  const CORNER_SCALE = 1.6;
  const CORNER_CURVATURE = Math.log2(
    -Math.LN2 / Math.log(1 - (1 - Math.SQRT1_2) / CORNER_SCALE)
  );
  M.CORNER_CURVATURE = CORNER_CURVATURE;
  M.continuousRadius = function (radius) {
    return M.superellipse() ? radius * CORNER_SCALE : radius;
  };

  /* 数值工具：多处共用，放这里避免各文件各写一份 */
  M.clamp = function (n, lo, hi) { return n < lo ? lo : n > hi ? hi : n; };
  M.lerp = function (a, b, t) { return a + (b - a) * t; };

  /* 连续圆角：浏览器支持 corner-shape: superellipse 时按 1.6 倍放大半径，
     否则退回普通圆角。规格要求「支持时乘 1.6」，不支持时不能假装支持。 */
  M.superellipse = function () {
    try {
      return !!(root.CSS && root.CSS.supports && (
        root.CSS.supports('corner-shape', 'superellipse') ||
        root.CSS.supports('corner-shape', 'squircle')
      ));
    } catch (e) {
      return false;
    }
  };

  M.applyRadius = function (el, base) {
    if (!el) return;
    if (M.superellipse()) {
      el.style.borderRadius = (base * 1.6) + 'px';
      el.style.cornerShape = 'superellipse';
    } else {
      el.style.borderRadius = base + 'px';
      el.style.cornerShape = '';
    }
  };

  root.AIMotion = M;
  if (typeof module !== 'undefined' && module.exports) module.exports = M;
})(typeof window !== 'undefined' ? window : globalThis);
