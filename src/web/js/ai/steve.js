/* 史蒂夫像素头像（自建 3D 体素模型 + 多态反馈动画 + 视口安全爆裂 + 合成语音）
   ------------------------------------------------------------
   设计：8×8×8 体素头，正交投影，六个面烘焙 8×8 像素贴图；
   使用带透明过扫描边距（overscan）的画布，按真实 3D 对角线标定缩放，
   保证无论 360° 旋转、跳跃、歪头还是挤压拉伸，动画都不会被画布裁切。
   动效：
   - 空闲（15fps）：呼吸偏航、轻微俯仰、微浮动、自然眨眼；
   - 悬停（hover）：敏捷抬眸探头；
   - 点击（60fps rAF）：4 套轮换交互动画（蓄力跳转 / 开心双点头 / 好奇张望 /
     欢呼连跳）+ 视口防裁剪粒子字效爆裂 + Web Audio 共振峰斯蒂夫语音。
   性能：全实例共用一条调度循环；不可见 / 窗口隐藏 / 关闭动效零重绘；
   卸载自动摘除悬停监听与实例引用，零内存/监听器泄漏。 */
(function () {
  'use strict';
  if (window.SteveAvatar) return;

  /* ---------- 调色板与贴图 ---------- */
  const PAL = {
    H: '#3a2b20', h: '#4a3729', S: '#b98c66', s: '#a67955',
    W: '#f3efe6', I: '#44559b', C: '#758ae3', N: '#a2734f',
    M: '#6c4835', b: '#553a29', T: '#4d3929'
  };

  /* 正脸：标准神态 */
  const FACE_FRONT = [
    'HHHHHHHH',
    'HHHHHHHH',
    'HhSSSShH',
    'SSSSSSSS',
    'SWISSIWS',
    'SSSNNSSS',
    'SSMMMMSS',
    'SSSbbSSS'
  ];
  /* 眨眼 */
  const FACE_BLINK = FACE_FRONT.slice();
  FACE_BLINK[4] = 'SSSSSSSS';

  /* 开心：笑眯弯眼 */
  const FACE_HAPPY = FACE_FRONT.slice();
  FACE_HAPPY[4] = 'SHHSSHHS';
  FACE_HAPPY[6] = 'SMMMMMMS';

  /* 兴奋/好奇：高光亮眸 */
  const FACE_EXCITED = FACE_FRONT.slice();
  FACE_EXCITED[4] = 'SWCSSCWS';

  /* 侧面 / 后脑 / 顶 / 底 */
  const FACE_SIDE = [
    'HHHHHHHH',
    'HHHHHHHH',
    'HHHHHHHH',
    'HSSSSSSS',
    'SSSSSSSS',
    'SSSSSSSS',
    'SSSSSSSS',
    'SSSSSSSS'
  ];
  const FACE_BACK = [
    'HHHHHHHH',
    'HHHHHHHH',
    'HHHHHHHH',
    'HHHHHHHH',
    'SSSSSSSS',
    'SSSSSSSS',
    'SSSSSSSS',
    'SSSSSSSS'
  ];
  const FACE_TOP = [
    'TTTTTTTT', 'TTTTTTTT', 'TTTTTTTT', 'TTTTTTTT',
    'TTTTTTTT', 'TTTTTTTT', 'TTTTTTTT', 'TTTTTTTT'
  ];
  const FACE_BOTTOM = [
    'ssssssss', 'ssssssss', 'ssssssss', 'ssssssss',
    'ssssssss', 'ssssssss', 'ssssssss', 'ssssssss'
  ];

  const LIGHT = { front: 1, right: 0.82, left: 0.74, top: 1.14, bottom: 0.58, back: 0.9 };
  const EDGE = '#241a12';
  const BASE_YAW = -24 * Math.PI / 180;
  const BASE_PITCH = -14 * Math.PI / 180;
  const REACT_MS = 720;
  const IDLE_FPS = 15;
  const REACT_COUNT = 4;

  /* ---------- 颜色工具 ---------- */
  function rgbOf(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function shade(hex, k) {
    const c = rgbOf(hex);
    const f = k > 1 ? 1 : k;
    const lift = k > 1 ? (k - 1) * 255 : 0;
    const r = Math.min(255, Math.round(c[0] * f + lift));
    const g = Math.min(255, Math.round(c[1] * f + lift));
    const b = Math.min(255, Math.round(c[2] * f + lift));
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  /* ---------- 贴图烘焙（每张 8×8，应用生命周期内只烘一次） ---------- */
  let TEX = null;
  function tex() {
    if (TEX) return TEX;
    const bake = (rows, k) => {
      const c = document.createElement('canvas');
      c.width = 8; c.height = 8;
      const g = c.getContext('2d');
      for (let y = 0; y < 8; y++) {
        const row = rows[y] || 'SSSSSSSS';
        for (let x = 0; x < 8; x++) {
          const key = row[x] || 'S';
          g.fillStyle = shade(PAL[key] || PAL.S, k);
          g.fillRect(x, y, 1, 1);
        }
      }
      return c;
    };
    TEX = {
      front: bake(FACE_FRONT, LIGHT.front),
      blink: bake(FACE_BLINK, LIGHT.front),
      happy: bake(FACE_HAPPY, LIGHT.front),
      excited: bake(FACE_EXCITED, LIGHT.front),
      right: bake(FACE_SIDE, LIGHT.right),
      left: bake(FACE_SIDE, LIGHT.left),
      back: bake(FACE_BACK, LIGHT.back),
      top: bake(FACE_TOP, LIGHT.top),
      bottom: bake(FACE_BOTTOM, LIGHT.bottom)
    };
    return TEX;
  }

  /* ---------- 斯蒂夫语音合成器（Web Audio API 零素材离线合成） ---------- */
  let audioCtx = null;
  let lastSoundAt = 0;

  function ensureAudio() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!audioCtx) audioCtx = new AC();
    if (audioCtx.state === 'suspended' && typeof audioCtx.resume === 'function') {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  }

  /** 双共振峰人声发声单元：还原方块人温厚略带鼻音的复古音色 */
  function emitVocalSyllable(ctx, dest, t0, dur, fStart, fEnd, f1Start, f1End, f2Freq, gainPeak) {
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    osc1.type = 'sawtooth';
    osc2.type = 'triangle';
    osc1.frequency.setValueAtTime(fStart, t0);
    osc1.frequency.exponentialRampToValueAtTime(Math.max(55, fEnd), t0 + dur);
    osc2.frequency.setValueAtTime(fStart * 0.5, t0);
    osc2.frequency.exponentialRampToValueAtTime(Math.max(35, fEnd * 0.5), t0 + dur);

    const form1 = ctx.createBiquadFilter();
    form1.type = 'bandpass';
    form1.Q.value = 4.2;
    form1.frequency.setValueAtTime(f1Start, t0);
    form1.frequency.exponentialRampToValueAtTime(Math.max(120, f1End), t0 + dur);

    const form2 = ctx.createBiquadFilter();
    form2.type = 'bandpass';
    form2.Q.value = 5.4;
    form2.frequency.setValueAtTime(f2Freq, t0);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(2200, t0);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(gainPeak, t0 + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    const bodyGain = ctx.createGain();
    bodyGain.gain.value = 0.45;
    const f1Gain = ctx.createGain();
    f1Gain.gain.value = 1.25;
    const f2Gain = ctx.createGain();
    f2Gain.gain.value = 0.65;

    osc1.connect(form1);
    osc1.connect(form2);
    osc2.connect(lp);
    form1.connect(f1Gain);
    form2.connect(f2Gain);
    lp.connect(bodyGain);
    f1Gain.connect(env);
    f2Gain.connect(env);
    bodyGain.connect(env);
    env.connect(dest);

    osc1.start(t0);
    osc2.start(t0);
    osc1.stop(t0 + dur + 0.02);
    osc2.stop(t0 + dur + 0.02);
  }

  /** 方块像素轻响瞬态：点击瞬间的清脆木/像素质感 */
  function emitVoxelPop(ctx, dest, t0, pitch) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(pitch, t0);
    osc.frequency.exponentialRampToValueAtTime(pitch * 0.45, t0 + 0.026);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(0.11, t0 + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.028);
    osc.connect(g);
    g.connect(dest);
    osc.start(t0);
    osc.stop(t0 + 0.032);
    return osc;
  }

  function playSteveSound(kind) {
    try {
      const nowMs = Date.now();
      if (nowMs - lastSoundAt < 90) return false;
      lastSoundAt = nowMs;

      const ctx = ensureAudio();
      if (!ctx) return false;

      const master = ctx.createGain();
      master.gain.value = 0.16;
      master.connect(ctx.destination);

      const t = ctx.currentTime + 0.005;
      const jit = 1 + (Math.random() - 0.5) * 0.07;
      const mode = ((Number(kind) || 0) % REACT_COUNT + REACT_COUNT) % REACT_COUNT;

      const popOsc = emitVoxelPop(ctx, master, t, 420 * jit);

      if (mode === 0) {
        /* 经典斯蒂夫“Uh!” + 清亮上扬尾音 */
        emitVocalSyllable(ctx, master, t, 0.135, 192 * jit, 126 * jit, 560, 420, 1140, 0.72);
      } else if (mode === 1) {
        /* 双音节开心“Hm-hm!” */
        emitVocalSyllable(ctx, master, t, 0.075, 162 * jit, 182 * jit, 480, 560, 1180, 0.6);
        emitVocalSyllable(ctx, master, t + 0.085, 0.105, 188 * jit, 218 * jit, 540, 640, 1260, 0.68);
      } else if (mode === 2) {
        /* 好奇疑问“Huh?” */
        emitVocalSyllable(ctx, master, t, 0.145, 148 * jit, 208 * jit, 470, 650, 1220, 0.68);
      } else {
        /* 欢呼“Oof-ha!” */
        emitVocalSyllable(ctx, master, t, 0.09, 190 * jit, 134 * jit, 550, 440, 1120, 0.64);
        emitVocalSyllable(ctx, master, t + 0.095, 0.11, 204 * jit, 242 * jit, 580, 690, 1320, 0.65);
      }
      setTimeout(() => { try { master.disconnect(); } catch (e) { /* 已释放 */ } }, 320);
      void popOsc;
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ---------- 六个面：法线、贴图、原点与两条边向量（模型单位 8×8×8） ---------- */
  const FACES = [
    { img: 'front', n: [0, 0, 1], o: [-4, -4, 4], u: [1, 0, 0], v: [0, 1, 0] },
    { img: 'right', n: [1, 0, 0], o: [4, -4, 4], u: [0, 0, -1], v: [0, 1, 0] },
    { img: 'top', n: [0, -1, 0], o: [-4, -4, 4], u: [1, 0, 0], v: [0, 0, -1] },
    { img: 'left', n: [-1, 0, 0], o: [-4, -4, -4], u: [0, 0, 1], v: [0, 1, 0] },
    { img: 'back', n: [0, 0, -1], o: [4, -4, -4], u: [-1, 0, 0], v: [0, 1, 0] },
    { img: 'bottom', n: [0, 1, 0], o: [-4, 4, -4], u: [1, 0, 0], v: [0, 0, 1] }
  ];

  /* ---------- 实例与调度 ---------- */
  const live = new Set();
  let raf = 0;
  let timer = 0;
  let lastTs = 0;
  let globalClickSeq = 0;

  const REDUCE = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  function reduceMotion() { return !!(REDUCE && REDUCE.matches); }
  function motionMode() { return document.body.dataset.motion || 'full'; }

  function activeFast(now) {
    for (const a of live) {
      if (a.reactAt && now - a.reactAt < REACT_MS + 40) return true;
      if (Math.abs(a.hover - a.hoverTarget) > 0.01) return true;
    }
    return false;
  }

  function schedule() {
    if (raf || timer || document.hidden) return;
    if (activeFast(performance.now())) raf = window.requestAnimationFrame(frame);
    else timer = window.setTimeout(tickTimed, 1000 / IDLE_FPS);
  }

  function step(ts) {
    const dt = lastTs ? Math.min(64, ts - lastTs) : 16;
    lastTs = ts;
    let alive = 0;
    for (const a of live) {
      if (a.el.isConnected === false && ts - a.t0 > 1500) { a.destroy(); continue; }
      if (a.tick(ts, dt)) alive++;
    }
    if (!alive) lastTs = 0;
    return alive;
  }

  function frame(ts) {
    raf = 0;
    if (step(ts)) schedule();
  }

  function tickTimed() {
    timer = 0;
    if (document.hidden) { lastTs = 0; return; }
    if (step(performance.now())) schedule();
  }

  function easeOutCubic(x) { return 1 - Math.pow(1 - x, 3); }
  function easeOutBack(x) {
    const c1 = 1.9, c3 = c1 + 1;
    return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
  }
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  function Avatar(host, cv, opts) {
    this.el = host;
    this.cv = cv;
    this.g = cv.getContext('2d');
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.t0 = performance.now();
    this.reactAt = 0;
    this.reactKind = 0;
    this.reactDir = 1;
    this.lastKind = 0;
    this.hover = 0;
    this.hoverTarget = 0;
    this.blinkAt = 0;
    this.blinkEnd = 0;
    this.visible = true;
    this.lastPaint = -1e9;
    this.resize(opts.size);

    this.io = null;
    if (window.IntersectionObserver) {
      this.io = new IntersectionObserver((es) => {
        for (const e of es) this.visible = e.isIntersecting;
        if (this.visible) schedule();
      }, { threshold: 0 });
      this.io.observe(host);
    }

    this._onEnter = () => {
      if (motionMode() === 'off' || reduceMotion()) return;
      this.hoverTarget = 1;
      if (timer) { window.clearTimeout(timer); timer = 0; }
      schedule();
    };
    this._onLeave = () => {
      this.hoverTarget = 0;
      if (timer) { window.clearTimeout(timer); timer = 0; }
      schedule();
    };
    this._hoverEl = (host.closest && host.closest('button')) || host;
    if (this._hoverEl && this._hoverEl.addEventListener) {
      this._hoverEl.addEventListener('pointerenter', this._onEnter);
      this._hoverEl.addEventListener('pointerleave', this._onLeave);
    }
  }

  Avatar.prototype.bindButtonHover = function () {
    const btn = this.el.closest ? this.el.closest('button') : null;
    if (!btn || btn === this._hoverEl) return;
    if (this._hoverEl && this._hoverEl.removeEventListener) {
      this._hoverEl.removeEventListener('pointerenter', this._onEnter);
      this._hoverEl.removeEventListener('pointerleave', this._onLeave);
    }
    this._hoverEl = btn;
    btn.addEventListener('pointerenter', this._onEnter);
    btn.addEventListener('pointerleave', this._onLeave);
  };

  Avatar.prototype.resize = function (size) {
    this.size = size;
    const g = this.g;
    /* 过扫描画布：主机盒子维持紧凑 size×size，画布四边额外留 42% 安全余量，
       让 360° 旋转对角线、跳跃与挤压拉伸永不被画布边界切掉。 */
    this.pad = Math.max(6, Math.ceil(size * 0.42));
    const drawSize = size + this.pad * 2;
    const px = Math.max(16, Math.round(drawSize * this.dpr));
    this.cv.width = px;
    this.cv.height = px;
    this.cv.style.width = drawSize + 'px';
    this.cv.style.height = drawSize + 'px';
    if (g) g.imageSmoothingEnabled = false;
    /* 按 8×8×8 体素真实 3D 包络（斜对角约 12.6~13.86）相对于名义尺寸标定缩放 */
    const nomPx = size * this.dpr;
    this.scale = (nomPx * 0.86) / 12.6;
    this.ox = px / 2;
    this.oy = px / 2;
    this.paint(performance.now(), true);
  };

  Avatar.prototype.destroy = function () {
    if (this.io) { this.io.disconnect(); this.io = null; }
    if (this._hoverEl && this._hoverEl.removeEventListener) {
      this._hoverEl.removeEventListener('pointerenter', this._onEnter);
      this._hoverEl.removeEventListener('pointerleave', this._onLeave);
    }
    this._hoverEl = null;
    live.delete(this);
  };

  Avatar.prototype.react = function (kind) {
    const k = (typeof kind === 'number') ? kind : (globalClickSeq++ % REACT_COUNT);
    this.lastKind = k;
    if (motionMode() === 'off' || reduceMotion()) return k;
    this.reactKind = k;
    this.reactDir = this.reactDir === 1 ? -1 : 1;
    this.reactAt = performance.now() || 1;
    if (timer) { window.clearTimeout(timer); timer = 0; }
    schedule();
    return k;
  };

  Avatar.prototype.spin = function () {
    return this.react();
  };

  Avatar.prototype.tick = function (ts, dt) {
    this.bindButtonHover();
    const motion = motionMode();
    const animated = motion === 'full' && !reduceMotion();
    const reacting = !!(this.reactAt && ts - this.reactAt < REACT_MS + 40);
    const hoverDelta = this.hoverTarget - this.hover;
    if (Math.abs(hoverDelta) > 0.005) {
      const stepH = Math.min(1, (dt || 16) / 110);
      this.hover += hoverDelta * stepH;
      if (Math.abs(this.hoverTarget - this.hover) <= 0.005) this.hover = this.hoverTarget;
    }
    const hoveringAnim = Math.abs(this.hover - this.hoverTarget) > 0.005;

    if (!animated && !reacting && !hoveringAnim) {
      if (!this.staticPainted) { this.paint(ts, true); this.staticPainted = true; }
      return false;
    }
    this.staticPainted = false;
    if (!this.visible) return false;
    if (document.hidden) return true;
    const interval = (reacting || hoveringAnim) ? 0 : 1000 / IDLE_FPS;
    if (ts - this.lastPaint >= interval) {
      this.paint(ts, false);
      this.lastPaint = ts;
    }
    return true;
  };

  Avatar.prototype.paint = function (now, staticOnly) {
    const g = this.g, cv = this.cv;
    if (!g) return;
    const px = cv.width;
    const T = tex();
    const animated = !staticOnly && motionMode() === 'full' && !reduceMotion();

    let yaw = BASE_YAW;
    let pitch = BASE_PITCH;
    let roll = 0;
    let hop = 0;
    let sxScale = 1;
    let syScale = 1;
    let faceKey = 'front';

    if (animated) {
      const t = now - this.t0;
      yaw += Math.sin(t * 0.00048) * 0.11;
      pitch += Math.sin(t * 0.00033 + 1.2) * 0.022;
      hop += Math.sin(t * 0.0018) * 0.32 * this.dpr;
    }

    /* 悬停敏锐回眸：轻微前倾并微微探起 */
    if (!staticOnly && this.hover > 0.001) {
      const hv = this.hover;
      yaw += 0.16 * hv;
      pitch -= 0.07 * hv;
      roll -= 0.06 * hv;
      hop -= 0.9 * this.dpr * hv;
      sxScale *= 1 + 0.04 * hv;
      syScale *= 1 + 0.04 * hv;
    }

    /* 点击 4 套编排反馈动画 */
    if (!staticOnly && this.reactAt) {
      const p = (now - this.reactAt) / REACT_MS;
      if (p >= 0 && p < 1) {
        const dir = this.reactDir || 1;
        const maxHop = Math.max(2.2, this.size * 0.16) * this.dpr;
        const k = this.reactKind % REACT_COUNT;
        if (k === 0) {
          /* 1) 蓄力下蹲 -> 跃起 360° 转体 -> 弹性落地 */
          if (p < 0.14) {
            const c = Math.sin((p / 0.14) * Math.PI * 0.5);
            syScale *= 1 - 0.14 * c;
            sxScale *= 1 + 0.11 * c;
            hop += maxHop * 0.25 * c;
          } else if (p < 0.78) {
            const j = (p - 0.14) / 0.64;
            const arc = Math.sin(j * Math.PI);
            yaw += easeOutCubic(j) * Math.PI * 2 * dir;
            roll += arc * 0.14 * dir;
            hop -= arc * maxHop;
            syScale *= 1 + 0.08 * arc;
            sxScale *= 1 - 0.05 * arc;
          } else {
            const l = (p - 0.78) / 0.22;
            const sq = Math.sin(l * Math.PI);
            syScale *= 1 - 0.12 * sq;
            sxScale *= 1 + 0.10 * sq;
            hop += maxHop * 0.15 * sq;
          }
          faceKey = p < 0.85 ? 'happy' : 'front';
        } else if (k === 1) {
          /* 2) 开心双点头 + 俏皮歪头 */
          const nod = Math.sin(p * Math.PI * 3);
          const env = Math.sin(p * Math.PI);
          pitch += nod * 0.26 * env;
          roll += Math.sin(p * Math.PI * 1.5) * 0.20 * dir;
          hop -= Math.abs(Math.sin(p * Math.PI * 2)) * maxHop * 0.65;
          syScale *= 1 + 0.06 * env;
          faceKey = 'happy';
        } else if (k === 2) {
          /* 3) 好奇探头张望 -> 轻快转回 */
          if (p < 0.45) {
            const e = easeOutBack(p / 0.45);
            yaw += 0.52 * dir * e;
            roll += 0.22 * dir * e;
            pitch -= 0.12 * e;
            hop -= Math.sin((p / 0.45) * Math.PI) * maxHop * 0.45;
            faceKey = 'excited';
          } else {
            const r = (p - 0.45) / 0.55;
            const s = 1 - easeOutCubic(r);
            yaw += 0.52 * dir * s + easeOutCubic(r) * Math.PI * 2 * dir;
            roll += 0.22 * dir * s;
            hop -= Math.sin(r * Math.PI) * maxHop * 0.7;
            faceKey = r < 0.65 ? 'excited' : 'happy';
          }
        } else {
          /* 4) 欢呼双连跳 + 左右摇摆 */
          const bounce = Math.abs(Math.sin(p * Math.PI * 2));
          hop -= bounce * maxHop * 0.92;
          roll += Math.sin(p * Math.PI * 4) * 0.19 * dir;
          yaw += Math.sin(p * Math.PI * 2) * 0.34 * dir;
          const stretch = bounce > 0.2 ? 0.07 : -0.09;
          syScale *= 1 + stretch;
          sxScale *= 1 - stretch * 0.7;
          faceKey = 'happy';
        }
      }
    }

    /* 自然眨眼（仅在标准神态下触发） */
    if (animated && faceKey === 'front') {
      if (!this.blinkAt) this.blinkAt = now + 2600 + Math.random() * 3400;
      if (now >= this.blinkAt && !this.blinkEnd) this.blinkEnd = now + 130;
      if (this.blinkEnd) {
        if (now < this.blinkEnd) faceKey = 'blink';
        else { this.blinkAt = now + 2800 + Math.random() * 3600; this.blinkEnd = 0; }
      }
    }

    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const cr = Math.cos(roll), sr = Math.sin(roll);
    const s = this.scale;
    const ox = this.ox;
    const oy = this.oy + hop;

    const rotN = (x, y, z) => {
      const x1 = x * cy + z * sy;
      const z1 = -x * sy + z * cy;
      const y2 = y * cp - z1 * sp;
      const z2 = y * sp + z1 * cp;
      return [x1 * cr - y2 * sr, x1 * sr + y2 * cr, z2];
    };
    const rot = (x, y, z) => rotN(x * sxScale, y * syScale, z * sxScale);
    const sx = (x, y, z) => {
      const r = rot(x, y, z);
      return [ox + r[0] * s, oy + r[1] * s];
    };

    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, px, px);

    /* 外轮廓暗边 */
    g.fillStyle = EDGE;
    for (let i = 0; i < FACES.length; i++) {
      const f = FACES[i];
      const a = sx(f.o[0], f.o[1], f.o[2]);
      const b = sx(f.o[0] + f.u[0], f.o[1] + f.u[1], f.o[2] + f.u[2]);
      const c = sx(f.o[0] + f.v[0], f.o[1] + f.v[1], f.o[2] + f.v[2]);
      const d = sx(f.o[0] + f.u[0] + f.v[0], f.o[1] + f.u[1] + f.v[1], f.o[2] + f.u[2] + f.v[2]);
      g.beginPath();
      g.moveTo(a[0], a[1]);
      g.lineTo(b[0], b[1]);
      g.lineTo(d[0], d[1]);
      g.lineTo(c[0], c[1]);
      g.closePath();
      g.fill();
    }

    /* 贴图朝向面 */
    for (let i = 0; i < FACES.length; i++) {
      const f = FACES[i];
      if (rotN(f.n[0], f.n[1], f.n[2])[2] <= 0) continue;
      const o = f.o, u = f.u, v = f.v;
      const a = rot(o[0], o[1], o[2]);
      const b = rot(o[0] + u[0], o[1] + u[1], o[2] + u[2]);
      const c = rot(o[0] + v[0], o[1] + v[1], o[2] + v[2]);
      const ax = ox + a[0] * s, ay = oy + a[1] * s;
      g.setTransform((b[0] - a[0]) * s, (b[1] - a[1]) * s, (c[0] - a[0]) * s, (c[1] - a[1]) * s, ax, ay);
      const texImg = f.img === 'front' ? (T[faceKey] || T.front) : T[f.img];
      g.drawImage(texImg, 0, 0);
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
  };

  /* ---------- 像素字：问号 / 感叹号 / 星星 / 音符 ---------- */
  const GLYPH = {
    '?': [
      '01110',
      '10001',
      '00001',
      '00010',
      '00100',
      '00000',
      '00100'
    ],
    '!': [
      '00100',
      '00100',
      '00100',
      '00100',
      '00100',
      '00000',
      '00100'
    ],
    '★': [
      '00100',
      '00100',
      '11111',
      '01110',
      '01010',
      '10001',
      '00000'
    ],
    '♪': [
      '00111',
      '00101',
      '00100',
      '00100',
      '01100',
      '11100',
      '01100'
    ]
  };

  const GLYPH_PAIRS = [
    ['?', '!'],
    ['★', '♪'],
    ['!', '?'],
    ['♪', '★']
  ];

  const BURST_COLORS = ['#b98c66', '#3a2b20', '#f3efe6', '#5e6ad2', '#4a3729'];

  /* 点击爆裂：严格夹紧在可视视口内，并向空间充足的方向偏置粒子与像素字，
     彻底避免贴在侧栏左上角或顶栏右上角时被窗口边缘截断。 */
  function burst(host, kind) {
    const motion = motionMode();
    if (motion === 'off' || reduceMotion()) return;
    const el = host && host.closest ? (host.closest('.steve') || host) : host;
    if (!el || !el.getBoundingClientRect) return;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;

    const vw = window.innerWidth || 1200;
    const vh = window.innerHeight || 800;
    if (r.right < 0 || r.left > vw || r.bottom < 0 || r.top > vh) return;
    const pad = 8;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const R = Math.round(Math.max(76, Math.min(104, r.width * 3.1)));

    const left = Math.max(pad, Math.min(cx - R, vw - R * 2 - pad));
    const top = Math.max(pad, Math.min(cy - R, vh - R * 2 - pad));
    const right = Math.min(vw - pad, left + R * 2);
    const bottom = Math.min(vh - pad, top + R * 2);
    const boxW = Math.max(72, Math.round(right - left));
    const boxH = Math.max(72, Math.round(bottom - top));
    const ox = cx - left;
    const oy = cy - top;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cv = document.createElement('canvas');
    cv.className = 'steve-burst';
    cv.setAttribute('aria-hidden', 'true');
    cv.width = Math.round(boxW * dpr);
    cv.height = Math.round(boxH * dpr);
    cv.style.width = boxW + 'px';
    cv.style.height = boxH + 'px';
    cv.style.left = Math.round(left) + 'px';
    cv.style.top = Math.round(top) + 'px';
    document.body.appendChild(cv);

    const g = cv.getContext('2d');
    if (!g) { cv.remove(); return; }
    if (typeof g.scale === 'function') g.scale(dpr, dpr);
    g.imageSmoothingEnabled = false;

    const roomL = Math.max(10, ox - 8);
    const roomR = Math.max(10, boxW - ox - 8);
    const roomT = Math.max(10, oy - 8);
    const roomB = Math.max(10, boxH - oy - 8);
    const maxRing = Math.max(18, Math.min(36, roomL, roomR, roomT, roomB));

    const lite = motion === 'lite';
    const N = lite ? 12 : 30;
    const parts = [];
    const biasX = roomR > roomL + 16 ? 18 : (roomL > roomR + 16 ? -18 : 0);
    const biasY = roomB > roomT + 16 ? 26 : -28;
    for (let i = 0; i < N; i++) {
      const ang = (i / N) * Math.PI * 2 + Math.random() * 0.4;
      const sp = 54 + Math.random() * 124;
      parts.push({
        x: ox, y: oy,
        vx: Math.cos(ang) * sp + biasX,
        vy: Math.sin(ang) * sp + biasY,
        g: 360 + Math.random() * 160,
        s: 1.6 + Math.random() * 2.4,
        c: BURST_COLORS[(Math.random() * BURST_COLORS.length) | 0],
        life: 400 + Math.random() * 340,
        t: 0
      });
    }
    if (!lite) {
      for (let i = 0; i < 6; i++) {
        const ang = (i / 6) * Math.PI * 2 + 0.3;
        parts.push({
          x: ox, y: oy, vx: Math.cos(ang) * 168 + biasX, vy: Math.sin(ang) * 168 + biasY,
          g: 180, s: 5, thin: true, c: '#5e6ad2',
          life: 280 + Math.random() * 140, t: 0
        });
      }
    }

    /* 两个像素字向空间更开阔的象限弹出，并钳在画布安全内边距里 */
    const pair = GLYPH_PAIRS[((Number(kind) || 0) % GLYPH_PAIRS.length + GLYPH_PAIRS.length) % GLYPH_PAIRS.length];
    const unit = Math.max(2, Math.round(Math.min(boxW, boxH) / 56));
    const gwPad = 5 * unit * 0.6 + 6;
    const ghPad = 7 * unit * 0.6 + 6;
    const clampX = (x) => Math.max(gwPad, Math.min(boxW - gwPad, x));
    const clampY = (y) => Math.max(ghPad, Math.min(boxH - ghPad, y));
    const dirY = roomT >= 38 ? -1 : 1;
    const leftX = roomL >= 34 ? clampX(ox - Math.min(40, roomL * 0.68)) : clampX(ox + 26);
    const rightX = roomR >= 34 ? clampX(ox + Math.min(40, roomR * 0.68)) : clampX(ox - 26);
    const glyphs = lite ? [] : [
      { ch: pair[0], tx: leftX - ox, ty: clampY(oy + dirY * Math.min(40, (dirY < 0 ? roomT : roomB) * 0.72)) - oy, rot: -0.16, delay: 20 },
      { ch: pair[1], tx: rightX - ox, ty: clampY(oy + dirY * Math.min(46, (dirY < 0 ? roomT : roomB) * 0.82)) - oy, rot: 0.14, delay: 75 }
    ];

    const total = lite ? 500 : 760;
    const t0 = performance.now();
    let prev = t0;

    function drawGlyph(item, t) {
      const p = clamp01((t - item.delay) / 240);
      if (p <= 0) return;
      const move = easeOutCubic(p);
      const sc = 0.45 + 0.55 * easeOutBack(p);
      const fade = t > total * 0.66 ? clamp01(1 - (t - total * 0.66) / (total * 0.34)) : 1;
      if (fade <= 0) return;
      const bits = GLYPH[item.ch];
      if (!bits) return;
      const gw = bits[0].length * unit;
      const gh = bits.length * unit;
      const gx = clampX(ox + item.tx * move);
      const gy = clampY(oy + item.ty * move);
      if (typeof g.save === 'function') g.save();
      g.globalAlpha = fade;
      if (typeof g.translate === 'function') {
        g.translate(gx, gy);
        if (typeof g.rotate === 'function') g.rotate(item.rot * move);
        if (typeof g.scale === 'function') g.scale(sc, sc);
        g.translate(-gw / 2, -gh / 2);
        const stamp = (dx, dy, color) => {
          g.fillStyle = color;
          for (let y = 0; y < bits.length; y++) {
            for (let x = 0; x < bits[y].length; x++) {
              if (bits[y][x] === '1') g.fillRect(x * unit + dx, y * unit + dy, unit + 0.4, unit + 0.4);
            }
          }
        };
        stamp(unit * 0.55, unit * 0.55, '#333b86');
        stamp(unit * 0.28, unit * 0.28, '#414ba4');
        stamp(0, 0, '#5e6ad2');
      }
      if (typeof g.restore === 'function') g.restore();
    }

    function draw(now) {
      const t = now - t0;
      const dt = Math.min(48, now - prev);
      prev = now;
      g.clearRect(0, 0, boxW, boxH);

      const rk = clamp01(t / 360);
      if (rk < 1) {
        const rad = 5 + Math.max(6, maxRing - 5) * easeOutCubic(rk);
        g.globalAlpha = (1 - rk) * 0.5;
        g.strokeStyle = '#5e6ad2';
        g.lineWidth = 1.4;
        if (typeof g.roundRect === 'function') {
          g.beginPath();
          g.roundRect(ox - rad, oy - rad, rad * 2, rad * 2, 8);
          g.stroke();
        } else if (typeof g.strokeRect === 'function') {
          g.strokeRect(ox - rad, oy - rad, rad * 2, rad * 2);
        }
        g.globalAlpha = 1;
      }

      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        if (p.t >= p.life) continue;
        p.t += dt;
        const sec = dt / 1000;
        p.vy += p.g * sec;
        p.x += p.vx * sec;
        p.y += p.vy * sec;
        /* 轻量视口内壁回弹，不让粒子飞出画布截断 */
        if (p.x < 4) { p.x = 4; p.vx = Math.abs(p.vx) * 0.45; }
        else if (p.x > boxW - 4) { p.x = boxW - 4; p.vx = -Math.abs(p.vx) * 0.45; }
        if (p.y < 4) { p.y = 4; p.vy = Math.abs(p.vy) * 0.45; }
        else if (p.y > boxH - 4) { p.y = boxH - 4; p.vy = -Math.abs(p.vy) * 0.35; }

        const k = clamp01(p.t / p.life);
        const a = 1 - k * k;
        if (a <= 0) continue;
        g.globalAlpha = a;
        g.fillStyle = p.c;
        if (p.thin && typeof g.save === 'function' && typeof g.translate === 'function' && typeof g.rotate === 'function') {
          const ang = Math.atan2(p.vy, p.vx);
          g.save();
          g.translate(p.x, p.y);
          g.rotate(ang);
          g.fillRect(-p.s * 2.8, -0.7, p.s * 3.2, 1.4);
          g.restore();
        } else {
          const side = p.s * (1 - k * 0.45);
          g.fillRect(Math.round(p.x - side / 2), Math.round(p.y - side / 2), side, side);
        }
      }
      g.globalAlpha = 1;

      for (let i = 0; i < glyphs.length; i++) drawGlyph(glyphs[i], t);

      if (t < total) {
        window.requestAnimationFrame(draw);
      } else {
        cv.remove();
      }
    }
    window.requestAnimationFrame(draw);
  }

  /* ---------- 对外接口 ---------- */
  const SteveAvatar = {
    el(opts) {
      const o = opts || {};
      const size = o.size || 22;
      const host = document.createElement('span');
      host.className = 'steve' + (o.variant ? ' steve--' + o.variant : '');
      host.setAttribute('data-steve-size', String(size));
      host.setAttribute('aria-hidden', 'true');
      const cv = document.createElement('canvas');
      cv.className = 'steve-cv';
      host.appendChild(cv);
      const inst = new Avatar(host, cv, { size });
      host._steve = inst;
      live.add(inst);
      schedule();
      return host;
    },
    burst(host, kind) { burst(host, kind); },
    spin(host, kind) {
      const el = host && host.closest ? (host.closest('.steve') || host) : host;
      const inst = el && el._steve;
      if (!inst) return 0;
      return inst.react(kind);
    },
    sound(kind) { return playSteveSound(kind); },
    click(host, opts) {
      const o = opts || {};
      const el = host && host.closest ? (host.closest('.steve') || host) : host;
      const inst = el && el._steve;
      const isBtn = !!(el && el.classList && el.classList.contains('steve--btn'));
      const wantBurst = o.burst !== undefined ? !!o.burst : !isBtn;
      const kind = inst ? inst.react(o.kind) : (globalClickSeq++ % REACT_COUNT);
      if (wantBurst && el) burst(el, kind);
      if (o.sound !== false) playSteveSound(kind);
      return kind;
    },
    stats(host) {
      const el = host && host.closest ? (host.closest('.steve') || host) : host;
      const cv = el && el.querySelector ? el.querySelector('.steve-cv') : null;
      if (!cv) return null;
      const g = cv.getContext('2d');
      if (!g || typeof g.getImageData !== 'function') return null;
      const d = g.getImageData(0, 0, cv.width, cv.height).data;
      let n = 0, minX = 1e9, maxX = -1, minY = 1e9, maxY = -1;
      const colors = new Set();
      for (let y = 0; y < cv.height; y++) {
        for (let x = 0; x < cv.width; x++) {
          const i = (y * cv.width + x) * 4;
          if (d[i + 3] < 24) continue;
          n++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          if (colors.size < 400) colors.add(d[i] + ',' + d[i + 1] + ',' + d[i + 2]);
        }
      }
      return {
        size: cv.width, painted: n, ratio: +(n / (cv.width * cv.height)).toFixed(3),
        box: n ? [minX, minY, maxX - minX + 1, maxY - minY + 1] : null,
        colors: colors.size
      };
    },
    count() {
      let n = 0;
      live.forEach((a) => { if (a.el.isConnected !== false) n++; });
      return n;
    }
  };

  const mo = new MutationObserver(() => { live.forEach(() => schedule()); });
  mo.observe(document.body, { attributes: true, attributeFilter: ['data-motion'] });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    for (const a of live) {
      if (!a.el || a.el.isConnected === false) a.destroy();
    }
    if (live.size) schedule();
  });

  let rzTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(rzTimer);
    rzTimer = setTimeout(() => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      live.forEach((a) => {
        if (a.dpr !== dpr) { a.dpr = dpr; a.resize(a.size); }
      });
    }, 200);
  });

  window.SteveAvatar = SteveAvatar;
})();
