/* 史蒂夫像素头像（自建体素模型 + 点击爆裂特效）
   ------------------------------------------------------------
   设计：8×8×8 的体素头，正交投影，三个可见面各贴一张 8×8 的
   像素贴图；贴图按面烘焙一次（前亮、侧暗、顶最亮），每帧只用
   6 次 drawImage 把仿射变换贴上去，不做逐像素重绘。
   动效：呼吸式偏航 ±5.7°、轻微俯仰、0.35px 上下浮动、随机眨眼；
   点击时整颗头转一圈（体素模型真的转，不是贴图旋转）+ 让号与
   感叹号像素字弹出 + 方块粒子爆裂。全部由一处 rAF 驱动。
   性能：所有实例共用一条 rAF；不可见 / 窗口隐藏 / 动效关闭时
   一帧都不画；空闲 15fps，旋转期间才 60fps；页面卸载即从
   调度表里摘掉。无第三方素材，颜色只取中性色相，深浅主题通用。 */
(function () {
  'use strict';
  if (window.SteveAvatar) return;

  /* ---------- 调色板与贴图 ----------
     键位：H 发、h 发高光、S 肤、s 肤暗、W 眼白、I 瞳、N 鼻影、
          M 嘴、b 胡子、T 头顶。数值取自史蒂夫经典皮肤的色相，
          饱和度压低一档，跟应用的暖中性底不打架。 */
  const PAL = {
    H: '#3a2b20', h: '#4a3729', S: '#b98c66', s: '#a67955',
    W: '#f3efe6', I: '#44559b', N: '#a2734f', M: '#6c4835',
    b: '#553a29', T: '#4d3929'
  };

  /* 正脸：两行刘海、鬓角、双眼（外白内瞳）、鼻影、嘴、下巴胡 */
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
  /* 闭眼：把眼那一行换成皮肤，眨眼时换贴图，不重算几何 */
  const FACE_BLINK = FACE_FRONT.slice();
  FACE_BLINK[4] = 'SSSSSSSS';

  /* 侧面：上三行头发，第四行鬓角，往下全是皮肤 */
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
  /* 后脑：头发盖到第四行，下面是脖子 */
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

  /* 每个面的受光系数：正面 1、右侧 .82、左侧 .74、顶 1.14、底 .58 */
  const LIGHT = { front: 1, right: 0.82, left: 0.74, top: 1.14, bottom: 0.58, back: 0.9 };

  /* 立方体边线（露出来的那一圈暗边，像素画的描边感） */
  const EDGE = '#241a12';
  /* 基础姿态：偏航 -24°、俯仰 -14°，看到正 / 右 / 顶三个面 */
  const BASE_YAW = -24 * Math.PI / 180;
  const BASE_PITCH = -14 * Math.PI / 180;
  const SPIN_MS = 620;
  const IDLE_FPS = 15;

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

  /* ---------- 贴图烘焙（每张 8×8，整个应用只烘一次） ---------- */
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
      right: bake(FACE_SIDE, LIGHT.right),
      left: bake(FACE_SIDE, LIGHT.left),
      back: bake(FACE_BACK, LIGHT.back),
      top: bake(FACE_TOP, LIGHT.top),
      bottom: bake(FACE_BOTTOM, LIGHT.bottom)
    };
    return TEX;
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
  let raf = 0;    // 旋转时用逐帧循环，跟手
  let timer = 0;  // 平时用 15fps 的定时节拍，不再每帧唤醒
  let lastTs = 0;

  const REDUCE = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  function reduceMotion() { return !!(REDUCE && REDUCE.matches); }
  function motionMode() { return document.body.dataset.motion || 'full'; }

  function spinningNow(now) {
    for (const a of live) {
      if (a.spinAt && now - a.spinAt < SPIN_MS + 40) return true;
    }
    return false;
  }

  /* 只在需要时才排下一拍：旋转走 rAF，空闲走 15fps 定时器。
     这样一个静止的头不会再每帧抢一次主线程。 */
  function schedule() {
    if (raf || timer || document.hidden) return;
    if (spinningNow(performance.now())) raf = window.requestAnimationFrame(frame);
    else timer = window.setTimeout(tickTimed, 1000 / IDLE_FPS);
  }

  function step(ts) {
    const dt = lastTs ? Math.min(64, ts - lastTs) : 16;
    lastTs = ts;
    let alive = 0;
    for (const a of live) {
      if (!a.el.isConnected) { a.destroy(); continue; }
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
    this.spinAt = 0;
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
  }

  Avatar.prototype.resize = function (size) {
    this.size = size;
    const g = this.g;
    const px = Math.max(12, Math.round(size * this.dpr));
    this.cv.width = px;
    this.cv.height = px;
    this.cv.style.width = size + 'px';
    this.cv.style.height = size + 'px';
    g.imageSmoothingEnabled = false;
    /* 用基础姿态标定缩放：让头在画布里占到 88%，旋转时也不会被裁 */
    const cy0 = Math.cos(BASE_YAW), sy0 = Math.sin(BASE_YAW);
    const cp0 = Math.cos(BASE_PITCH), sp0 = Math.sin(BASE_PITCH);
    const rot = (x, y, z) => {
      const x1 = x * cy0 + z * sy0;
      const z1 = -x * sy0 + z * cy0;
      return [x1, y * cp0 - z1 * sp0];
    };
    let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
    for (let i = 0; i < 8; i++) {
      const x = (i & 1) ? 4 : -4;
      const y = (i & 2) ? 4 : -4;
      const z = (i & 4) ? 4 : -4;
      const p = rot(x, y, z);
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
    const bw = Math.max(0.001, maxX - minX);
    const bh = Math.max(0.001, maxY - minY);
    const s = Math.min(px * 0.88 / bw, px * 0.88 / bh);
    this.scale = s;
    this.ox = px / 2 - ((minX + maxX) / 2) * s;
    this.oy = px / 2 - ((minY + maxY) / 2) * s;
    this.paint(performance.now(), true);
  };

  Avatar.prototype.destroy = function () {
    if (this.io) { this.io.disconnect(); this.io = null; }
    live.delete(this);
  };

  Avatar.prototype.spin = function () {
    if (motionMode() === 'off' || reduceMotion()) return;
    this.spinAt = performance.now() || 1;
    /* 空闲节拍还挂着就先撤掉，立刻进逐帧循环，别让第一圈等 66ms */
    if (timer) { window.clearTimeout(timer); timer = 0; }
    schedule();
  };

  /* 返回 true 表示这一帧之后还需要继续调度 */
  Avatar.prototype.tick = function (ts) {
    const motion = motionMode();
    const animated = motion === 'full' && !reduceMotion();
    const spinning = this.spinAt && ts - this.spinAt < SPIN_MS + 40;
    if (!animated && !spinning) {
      /* 关动效时只画一帧静态图，之后退出调度 */
      if (!this.staticPainted) { this.paint(ts, true); this.staticPainted = true; }
      return false;
    }
    this.staticPainted = false;
    /* 不可见就退出调度，由 IntersectionObserver 看到再续上 */
    if (!this.visible) return false;
    if (document.hidden) return true;
    const interval = spinning ? 0 : 1000 / IDLE_FPS;
    if (ts - this.lastPaint >= interval) {
      this.paint(ts, false);
      this.lastPaint = ts;
    }
    return true;
  };

  Avatar.prototype.paint = function (now, staticOnly) {
    const g = this.g, cv = this.cv;
    const px = cv.width;
    const T = tex();
    const animated = !staticOnly && motionMode() === 'full' && !reduceMotion();

    let yaw = BASE_YAW;
    let pitch = BASE_PITCH;
    let bob = 0;

    if (animated) {
      const t = now - this.t0;
      yaw += Math.sin(t * 0.00042) * 0.10;
      pitch += Math.sin(t * 0.00031 + 1.2) * 0.018;
      bob = Math.sin(t * 0.0017) * 0.35 * this.dpr;
    }

    /* 点击：模型真的绕竖轴转一圈，方向交替，避免每次都一样 */
    if (this.spinAt) {
      const p = clamp01((now - this.spinAt) / SPIN_MS);
      if (p < 1) yaw += easeOutCubic(p) * Math.PI * 2 * (this.spinDir || 1);
    }

    /* 眨眼：2.8~6.6 秒一次，闭眼 130ms */
    let blink = false;
    if (animated) {
      if (!this.blinkAt) this.blinkAt = now + 2600 + Math.random() * 3400;
      if (now >= this.blinkAt && !this.blinkEnd) this.blinkEnd = now + 130;
      if (this.blinkEnd) {
        blink = now < this.blinkEnd;
        if (!blink) { this.blinkAt = now + 2800 + Math.random() * 3600; this.blinkEnd = 0; }
      }
    }

    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const s = this.scale;
    const ox = this.ox;
    const oy = this.oy + bob;

    const rot = (x, y, z) => {
      const x1 = x * cy + z * sy;
      const z1 = -x * sy + z * cy;
      return [x1, y * cp - z1 * sp, y * sp + z1 * cp];
    };
    const sx = (x, y, z) => {
      const r = rot(x, y, z);
      return [ox + r[0] * s, oy + r[1] * s];
    };

    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, px, px);

    /* 先铺一层暗色轮廓：贴图边缘抗锯齿时会和它混，形成一圈发丝般的描边 */
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

    /* 只贴朝向镜头的面（正交投影下法线深度 > 0），近似的三面体 */
    for (let i = 0; i < FACES.length; i++) {
      const f = FACES[i];
      if (rot(f.n[0], f.n[1], f.n[2])[2] <= 0) continue;
      const o = f.o, u = f.u, v = f.v;
      const a = rot(o[0], o[1], o[2]);
      const b = rot(o[0] + u[0], o[1] + u[1], o[2] + u[2]);
      const c = rot(o[0] + v[0], o[1] + v[1], o[2] + v[2]);
      const ax = ox + a[0] * s, ay = oy + a[1] * s;
      g.setTransform((b[0] - a[0]) * s, (b[1] - a[1]) * s, (c[0] - a[0]) * s, (c[1] - a[1]) * s, ax, ay);
      g.drawImage(f.img === 'front' && blink ? T.blink : T[f.img], 0, 0);
      /* 闭眼时在正面补两笔肤色，盖掉贴图上的眼睛（贴图列 1-2 / 5-6，行 4） */
      if (blink && f.img === 'front') {
        g.fillStyle = shade(PAL.S, LIGHT.front);
        g.fillRect(1, 4, 2, 1);
        g.fillRect(5, 4, 2, 1);
      }
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
  };

  /* ---------- 像素字：问号 / 感叹号 ---------- */
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
    ]
  };

  const BURST_COLORS = ['#b98c66', '#3a2b20', '#f3efe6', '#5e6ad2', '#4a3729'];

  /* 点击爆裂：独立的 fixed 画布，落在头像正上方，用完即删。
     不放在按钮里，避免被侧栏 / 卡片的裁剪与层叠上下文切掉。 */
  function burst(host) {
    const motion = motionMode();
    if (motion === 'off' || reduceMotion()) return;
    const el = host && host.closest ? (host.closest('.steve') || host) : host;
    if (!el || !el.getBoundingClientRect) return;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;

    const box = Math.round(Math.max(136, r.width * 5));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cv = document.createElement('canvas');
    cv.className = 'steve-burst';
    cv.setAttribute('aria-hidden', 'true');
    cv.width = Math.round(box * dpr);
    cv.height = Math.round(box * dpr);
    cv.style.width = box + 'px';
    cv.style.height = box + 'px';
    cv.style.left = Math.round(r.left + r.width / 2 - box / 2) + 'px';
    cv.style.top = Math.round(r.top + r.height / 2 - box / 2) + 'px';
    document.body.appendChild(cv);

    const g = cv.getContext('2d');
    g.scale(dpr, dpr);
    g.imageSmoothingEnabled = false;

    const lite = motion === 'lite';
    const N = lite ? 12 : 34;
    const C = box / 2;
    const parts = [];
    for (let i = 0; i < N; i++) {
      const ang = (i / N) * Math.PI * 2 + Math.random() * 0.4;
      const sp = 62 + Math.random() * 148;
      parts.push({
        x: 0, y: 0,
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp - 42,
        g: 440 + Math.random() * 190,
        s: 1.6 + Math.random() * 2.6,
        c: BURST_COLORS[(Math.random() * BURST_COLORS.length) | 0],
        life: 420 + Math.random() * 380,
        t: 0
      });
    }
    /* 六道火花：拉长的细方块，比纯方块更像爆炸 */
    if (!lite) {
      for (let i = 0; i < 6; i++) {
        const ang = (i / 6) * Math.PI * 2 + 0.3;
        parts.push({
          x: 0, y: 0, vx: Math.cos(ang) * 205, vy: Math.sin(ang) * 205 - 30,
          g: 210, s: 5.5, thin: true, c: '#5e6ad2',
          life: 300 + Math.random() * 160, t: 0
        });
      }
    }

    const glyphs = lite ? [] : [
      { ch: '?', tx: -box * 0.255, ty: -box * 0.255, rot: -0.17, delay: 20 },
      { ch: '!', tx: box * 0.245, ty: -box * 0.30, rot: 0.14, delay: 80 }
    ];
    const total = lite ? 520 : 800;
    const t0 = performance.now();
    let prev = t0;

    function drawGlyph(item, t) {
      const p = clamp01((t - item.delay) / 250);
      if (p <= 0) return;
      const move = easeOutCubic(p);
      const sc = 0.45 + 0.55 * easeOutBack(p);
      const fade = t > total * 0.66 ? clamp01(1 - (t - total * 0.66) / (total * 0.34)) : 1;
      if (fade <= 0) return;
      const bits = GLYPH[item.ch];
      const unit = Math.max(2, Math.round(box / 54));
      const gw = bits[0].length * unit;
      const gh = bits.length * unit;
      g.save();
      g.globalAlpha = fade;
      g.translate(C + item.tx * move, C + item.ty * move);
      g.rotate(item.rot * move);
      g.scale(sc, sc);
      g.translate(-gw / 2, -gh / 2);
      const stamp = (dx, dy, color) => {
        g.fillStyle = color;
        for (let y = 0; y < bits.length; y++) {
          for (let x = 0; x < bits[y].length; x++) {
            if (bits[y][x] === '1') g.fillRect(x * unit + dx, y * unit + dy, unit + 0.4, unit + 0.4);
          }
        }
      };
      /* 两层错位的深色挤出，做出像素块厚度 */
      stamp(unit * 0.55, unit * 0.55, '#333b86');
      stamp(unit * 0.28, unit * 0.28, '#414ba4');
      stamp(0, 0, '#5e6ad2');
      g.restore();
    }

    function draw(now) {
      const t = now - t0;
      const dt = Math.min(48, now - prev);
      prev = now;
      g.clearRect(0, 0, box, box);

      /* 冲击波：一个从中心涨开的圆角方框 */
      const rk = clamp01(t / 380);
      if (rk < 1) {
        const rad = 5 + 34 * easeOutCubic(rk);
        g.globalAlpha = (1 - rk) * 0.5;
        g.strokeStyle = '#5e6ad2';
        g.lineWidth = 1.4;
        if (g.roundRect) {
          g.beginPath();
          g.roundRect(C - rad, C - rad, rad * 2, rad * 2, 9);
          g.stroke();
        } else {
          g.strokeRect(C - rad, C - rad, rad * 2, rad * 2);
        }
        g.globalAlpha = 1;
      }

      /* 粒子 */
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        if (p.t >= p.life) continue;
        p.t += dt;
        const sec = dt / 1000;
        p.vy += p.g * sec;
        p.x += p.vx * sec;
        p.y += p.vy * sec;
        const k = clamp01(p.t / p.life);
        const a = 1 - k * k;
        if (a <= 0) continue;
        g.globalAlpha = a;
        g.fillStyle = p.c;
        if (p.thin) {
          const ang = Math.atan2(p.vy, p.vx);
          g.save();
          g.translate(C + p.x, C + p.y);
          g.rotate(ang);
          g.fillRect(-p.s * 3, -0.7, p.s * 3.4, 1.4);
          g.restore();
        } else {
          const side = p.s * (1 - k * 0.45);
          g.fillRect(Math.round(C + p.x - side / 2), Math.round(C + p.y - side / 2), side, side);
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
    burst(host) { burst(host); },
    spin(host) {
      const el = host && host.closest ? (host.closest('.steve') || host) : host;
      const inst = el && el._steve;
      if (!inst) return;
      inst.spinDir = inst.spinDir === 1 ? -1 : 1;
      inst.spin();
    },
    /* 测试用：读画布统计，确认头真的画出来了 */
    stats(host) {
      const el = host && host.closest ? (host.closest('.steve') || host) : host;
      const cv = el && el.querySelector ? el.querySelector('.steve-cv') : null;
      if (!cv) return null;
      const g = cv.getContext('2d');
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
    /* 测试 / 调试：当前有多少个活着的头像 */
    count() {
      let n = 0;
      live.forEach((a) => { if (a.el.isConnected) n++; });
      return n;
    }
  };

  /* 动效档位切换时补一帧（从 lite 回到 full 也能立刻动起来） */
  const mo = new MutationObserver(() => { live.forEach((a) => schedule()); });
  mo.observe(document.body, { attributes: true, attributeFilter: ['data-motion'] });

  /* 全局唯一可见性监听：切回前台时顺带清掉已卸载的旧实例并恢复调度 */
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    for (const a of live) {
      if (!a.el || !a.el.isConnected) a.destroy();
    }
    if (live.size) schedule();
  });

  /* 换显示器 / 改缩放：DPR 变了就按新倍率重开画布，200ms 防抖 */
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
