/* 官网（website/）全按钮、全链接、双语、深浅主题、Tab 键盘导航、基准切换、剪贴板降级与赞赏弹窗红队自测 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');
const siteDir = path.join(repoRoot, 'website');
const html = fs.readFileSync(path.join(siteDir, 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(siteDir, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(siteDir, 'styles.css'), 'utf8');
const pagesYml = fs.readFileSync(path.join(repoRoot, '.github/workflows/pages.yml'), 'utf8');

const fail = (msg) => {
  console.error('[官网红队自测失败] ' + msg);
  process.exit(1);
};

// 1. 静态资源、页面锚点与截图完备性校验（含 pages.yml 部署复制的 docs/assets/screenshots 与 Release 拉取的 qdisk-promo.mp4）
const assetHrefs = [...html.matchAll(/(?:src|href|poster)="([^"]+)"/g)].map((m) => m[1]);
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
for (const ref of assetHrefs) {
  if (/^https?:|^mailto:|^data:/.test(ref)) continue;
  if (ref.startsWith('#')) {
    const anchor = ref.slice(1);
    if (!ids.has(anchor)) fail(`发现断链锚点 href="${ref}"`);
    continue;
  }
  if (ref === 'assets/media/qdisk-promo.mp4') {
    if (!pagesYml.includes('_site/assets/media/qdisk-promo.mp4')) {
      fail('index.html 引用了 assets/media/qdisk-promo.mp4，但 pages.yml 未配置拉取步骤');
    }
    continue;
  }
  const direct = path.join(siteDir, ref);
  const fromDocs = ref.startsWith('assets/screenshots/')
    ? path.join(repoRoot, 'docs', ref)
    : '';
  if (!fs.existsSync(direct) && !(fromDocs && fs.existsSync(fromDocs))) {
    fail(`缺失官网静态资源: ${ref}`);
  }
}
for (const m of appJs.matchAll(/assets\/screenshots\/[^'"\s]+/g)) {
  const fromDocs = path.join(repoRoot, 'docs', m[0]);
  if (!fs.existsSync(fromDocs)) fail(`website/app.js 引用了不存在的截图: ${m[0]}`);
}

// 2. 轻量 DOM 沙盒执行真实 website/app.js，逐一点击官网全部按钮
class MiniClassList {
  constructor(init = '') { this.set = new Set(String(init).split(/\s+/).filter(Boolean)); }
  add(...c) { c.forEach((x) => this.set.add(x)); }
  remove(...c) { c.forEach((x) => this.set.delete(x)); }
  contains(c) { return this.set.has(c); }
  toggle(c, force) {
    const on = force === undefined ? !this.set.has(c) : !!force;
    if (on) this.set.add(c); else this.set.delete(c);
    return on;
  }
}

class MiniEl {
  constructor(tag, attrs = {}, text = '') {
    this.tagName = tag.toUpperCase();
    this.attrs = new Map();
    this.dataset = {};
    this.listeners = new Map();
    this.children = [];
    this.style = {
      _vars: {},
      setProperty(k, v) { this._vars[k] = v; },
      cssText: ''
    };
    this.textContent = text;
    this.innerHTML = text;
    this.value = '';
    this.src = '';
    this.alt = '';
    this.href = '';
    this.content = '';
    this.tabIndex = 0;
    this.hidden = false;
    this.open = false;
    this.disabled = false;
    this.currentTime = 0;
    this.readyState = 4;
    this.paused = true;
    this.classList = new MiniClassList(attrs.class || '');
    for (const [k, v] of Object.entries(attrs)) {
      this.setAttribute(k, v);
    }
  }
  get id() { return this.attrs.get('id') || ''; }
  set id(v) { this.setAttribute('id', v); }
  setAttribute(k, v) {
    const val = String(v);
    this.attrs.set(k, val);
    if (k === 'class') this.classList = new MiniClassList(val);
    if (k === 'content') this.content = val;
    if (k === 'src') this.src = val;
    if (k === 'alt') this.alt = val;
    if (k === 'href') this.href = val;
    if (k === 'hidden') this.hidden = true;
    if (k.startsWith('data-')) {
      const camel = k.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
      this.dataset[camel] = val;
    }
  }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  hasAttribute(k) { return this.attrs.has(k); }
  removeAttribute(k) {
    this.attrs.delete(k);
    if (k === 'hidden') this.hidden = false;
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  dispatchEvent(ev) {
    ev.target = ev.target || this;
    ev.preventDefault = ev.preventDefault || (() => { ev.defaultPrevented = true; });
    const list = this.listeners.get(ev.type) || [];
    for (const fn of list) fn.call(this, ev);
    return !ev.defaultPrevented;
  }
  appendChild(ch) { this.children.push(ch); ch.parentNode = this; return ch; }
  remove() {
    if (this.parentNode) {
      this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
      this.parentNode = null;
    }
  }
  focus() { focusedEl = this; }
  select() {}
  setSelectionRange() {}
  getBoundingClientRect() { return { top: 100, left: 100, width: 400, height: 300, bottom: 400, right: 500 }; }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatchEvent({ type: 'close' }); }
  play() { this.paused = false; this.dispatchEvent({ type: 'play' }); this.dispatchEvent({ type: 'playing' }); return Promise.resolve(); }
  pause() { this.paused = true; }
  load() {}
  getAnimations() { return []; }
  querySelector(sel) {
    if (sel === 'img') {
      const idx = allEls.indexOf(this);
      if (idx >= 0) {
        for (let i = idx + 1; i < Math.min(allEls.length, idx + 4); i++) {
          if (allEls[i].tagName === 'IMG') return allEls[i];
        }
      }
    }
    return allEls.find((el) => matchesSelector(el, sel)) || null;
  }
  querySelectorAll(sel) {
    return allEls.filter((el) => matchesSelector(el, sel));
  }
}

const allEls = [];
const byId = new Map();
let focusedEl = null;

// 解析 index.html 中的全部核心交互与数据元素
const tagRe = /<(meta|header|a|button|span|h1|h2|h3|p|div|strong|code|img|dialog|section|figure)\b([^>]*)>([\s\S]*?)(?=<\/|\n|$)/gi;
function parseAttrs(raw) {
  const out = {};
  for (const m of raw.matchAll(/([a-zA-Z0-9:-]+)(?:="([^"]*)")?/g)) {
    out[m[1]] = m[2] !== undefined ? m[2] : '';
  }
  return out;
}
for (const m of html.matchAll(/<([a-zA-Z0-9]+)\b([^>]*)>/g)) {
  const tag = m[1].toLowerCase();
  if (['!doctype', 'html', 'head', 'body', 'link', 'script', 'svg', 'path', 'circle', 'polygon', 'line', 'rect', 'br'].includes(tag)) continue;
  const attrs = parseAttrs(m[2]);
  const el = new MiniEl(tag, attrs);
  if (tag === 'code' && attrs.id === 'dev-cmd-text') {
    el.textContent = 'git clone https://github.com/3347567186/QDisk.git && cd QDisk';
  }
  allEls.push(el);
  if (attrs.id) byId.set(attrs.id, el);
}
// 补充嵌套关系（sponsor QR img）
const sponsorWechatImg = allEls.find((e) => e.tagName === 'IMG' && e.src.includes('wechat.jpg'));
const sponsorAlipayImg = allEls.find((e) => e.tagName === 'IMG' && e.src.includes('alipay.jpg'));

function matchesSelector(el, sel) {
  const parts = sel.split(',').map((s) => s.trim());
  return parts.some((s) => {
    if (s === 'meta[name="color-scheme"]') return el.tagName === 'META' && el.getAttribute('name') === 'color-scheme';
    if (s === '.stage-tabs') return el.classList.contains('stage-tabs');
    if (s === '[role="tab"]') return el.getAttribute('role') === 'tab';
    if (s === '.stage-tabs [role="tab"][aria-selected="true"]') return el.getAttribute('role') === 'tab' && el.getAttribute('aria-selected') === 'true';
    if (s === '[data-bench-mode]') return el.hasAttribute('data-bench-mode');
    if (s === '[data-i18n]') return el.hasAttribute('data-i18n');
    if (s === '.brand') return el.classList.contains('brand');
    if (s === '.sponsor-wechat img') return el === sponsorWechatImg;
    if (s === '.sponsor-alipay img') return el === sponsorAlipayImg;
    if (s === '.count-up') return el.classList.contains('count-up');
    if (s === '.site-nav [data-section]') return el.hasAttribute('data-section');
    if (s === '.float-in' || s === '.float-group') return el.classList.contains(s.slice(1));
    if (s === '[data-scroll-hero="copy"]') return el.getAttribute('data-scroll-hero') === 'copy';
    if (s === '.film-chapter') return el.classList.contains('film-chapter');
    if (s === '[data-cinema-seek]') return el.hasAttribute('data-cinema-seek');
    if (s === '.zoom-trigger') return el.classList.contains('zoom-trigger');
    if (s === 'video[loading="lazy"]') return el.tagName === 'VIDEO' && el.getAttribute('loading') === 'lazy';
    if (s === 'source[data-src]') return el.tagName === 'SOURCE' && el.hasAttribute('data-src');
    if (s === 'source[src]') return el.tagName === 'SOURCE' && el.hasAttribute('src');
    return false;
  });
}

const storageMap = new Map();
const winListeners = new Map();
const docBody = new MiniEl('body');
const docEl = new MiniEl('html', { lang: 'zh-CN' });
docEl.scrollHeight = 3000;

let clipboardShouldFail = false;
let clipboardVal = '';
let legacyCopied = '';

const win = {
  console, setTimeout, clearTimeout,
  requestAnimationFrame: (cb) => { cb(Date.now()); return 1; },
  matchMedia: () => ({ matches: false }),
  CSS: { supports: () => false },
  HTMLDialogElement: function HTMLDialogElement() {},
  URLSearchParams,
  location: { search: '' },
  navigator: {
    language: 'zh-CN',
    clipboard: {
      writeText: async (t) => {
        if (clipboardShouldFail) throw new Error('clipboard denied');
        clipboardVal = t;
      }
    }
  },
  localStorage: {
    getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
    setItem: (k, v) => storageMap.set(k, String(v)),
    removeItem: (k) => storageMap.delete(k)
  },
  innerHeight: 900,
  scrollY: 0,
  fetch: async (url) => {
    if (url.includes('latest.json')) {
      return { ok: true, json: async () => JSON.parse(fs.readFileSync(path.join(siteDir, 'latest.json'), 'utf8')) };
    }
    return { ok: true, json: async () => ({ stars: 42 }) };
  },
  addEventListener: (type, fn) => {
    if (!winListeners.has(type)) winListeners.set(type, []);
    winListeners.get(type).push(fn);
  },
  dispatchEvent: (ev) => {
    (winListeners.get(ev.type) || []).forEach((fn) => fn(ev));
  },
  document: {
    documentElement: docEl,
    body: docBody,
    title: '',
    get activeElement() { return focusedEl; },
    createElement: (t) => new MiniEl(t),
    getElementById: (id) => byId.get(id) || null,
    querySelector: (sel) => allEls.find((el) => matchesSelector(el, sel)) || null,
    querySelectorAll: (sel) => allEls.filter((el) => matchesSelector(el, sel)),
    execCommand: (cmd) => {
      if (cmd !== 'copy') return false;
      const ta = docBody.children.find((c) => c.tagName === 'TEXTAREA');
      legacyCopied = ta ? ta.value : '';
      return !!legacyCopied;
    }
  }
};
win.window = win;
win.globalThis = win;

vm.runInNewContext(appJs, win, { filename: 'website/app.js' });
await new Promise((r) => setTimeout(r, 30));

// 3. 逐一测试所有按钮与交互
// 3a. 语言切换按钮（ZH -> EN -> ZH），校验所有 data-i18n 与双语 aria/title/alt
const langBtn = byId.get('lang-toggle');
if (!langBtn) fail('缺少 #lang-toggle');
langBtn.dispatchEvent({ type: 'click' });
if (docEl.lang !== 'en' || !win.document.title.includes('QDisk')) fail(`英文切换失败: lang=${docEl.lang}, title=${win.document.title}`);
if (!byId.get('theme-toggle').getAttribute('aria-label').includes('Switch')) fail('英文模式下 #theme-toggle 缺少英文 aria-label');
if (sponsorWechatImg && !sponsorWechatImg.alt.includes('WeChat')) fail('英文模式下微信二维码 alt 未切换');
langBtn.dispatchEvent({ type: 'click' });
if (docEl.lang !== 'zh-CN') fail('切回中文失败');

// 3b. 深浅主题按钮 + 跨标签页 storage 同步（含非法值防护）
const themeBtn = byId.get('theme-toggle');
const metaScheme = allEls.find((e) => e.tagName === 'META' && e.getAttribute('name') === 'color-scheme');
themeBtn.dispatchEvent({ type: 'click' });
if (metaScheme.content !== 'dark' || themeBtn.getAttribute('aria-pressed') !== 'true') {
  fail(`切换深色模式失败: meta=${metaScheme.content}, aria-pressed=${themeBtn.getAttribute('aria-pressed')}`);
}
win.dispatchEvent({ type: 'storage', key: 'qdisk-site-scheme', newValue: 'invalid-garbage' });
if (metaScheme.content !== 'light dark') fail(`storage 非法值未安全回退: ${metaScheme.content}`);

// 3c. 4 个演示 Tab 点击 + 键盘 ArrowRight / ArrowLeft / Home / End
const tabIds = ['tab-ai', 'tab-org', 'tab-arc', 'tab-cache'];
for (const tid of tabIds) {
  const t = byId.get(tid);
  if (!t) fail(`缺少 Tab ${tid}`);
  t.dispatchEvent({ type: 'click' });
  if (t.getAttribute('aria-selected') !== 'true') fail(`点击 ${tid} 未激活`);
  const panel = byId.get(t.dataset.panel);
  if (!panel || panel.hidden) fail(`点击 ${tid} 后对应面板 ${t.dataset.panel} 未显示`);
}
byId.get('tab-ai').dispatchEvent({ type: 'keydown', key: 'ArrowRight' });
if (byId.get('tab-org').getAttribute('aria-selected') !== 'true') fail('Tab 键盘 ArrowRight 切换失败');
byId.get('tab-org').dispatchEvent({ type: 'keydown', key: 'End' });
if (byId.get('tab-cache').getAttribute('aria-selected') !== 'true') fail('Tab 键盘 End 切换失败');
byId.get('tab-cache').dispatchEvent({ type: 'keydown', key: 'Home' });
if (byId.get('tab-ai').getAttribute('aria-selected') !== 'true') fail('Tab 键盘 Home 切换失败');

// 3d. 基准数据切换按钮（ZIP 压缩 / ZIP 解压）
const benchExtract = allEls.find((e) => e.getAttribute('data-bench-mode') === 'extract');
const benchCreate = allEls.find((e) => e.getAttribute('data-bench-mode') === 'create');
benchExtract.dispatchEvent({ type: 'click' });
if (benchExtract.getAttribute('aria-pressed') !== 'true' || !byId.get('bm-val-2').textContent.includes('3,844.1')) {
  fail('基准数据切换至 ZIP 解压失败');
}
benchCreate.dispatchEvent({ type: 'click' });
if (benchCreate.getAttribute('aria-pressed') !== 'true' || !byId.get('bm-val-2').textContent.includes('304.3')) {
  fail('基准数据切回 ZIP 压缩失败');
}

// 3e. 开发者命令复制按钮（正常 Async Clipboard + 拒权 execCommand 降级 + 永不禁用 + 0 临时 DOM 残留）
const copyBtn = byId.get('copy-dev-cmd');
clipboardShouldFail = false;
copyBtn.dispatchEvent({ type: 'click' });
await new Promise((r) => setTimeout(r, 15));
if (!clipboardVal.includes('git clone') || !copyBtn.hasAttribute('data-copied') || copyBtn.disabled) {
  fail(`官网复制按钮主路径失败: val=${clipboardVal}, disabled=${copyBtn.disabled}`);
}
clipboardShouldFail = true;
legacyCopied = '';
copyBtn.dispatchEvent({ type: 'click' });
await new Promise((r) => setTimeout(r, 15));
if (!legacyCopied.includes('git clone') || docBody.children.some((c) => c.tagName === 'TEXTAREA')) {
  fail(`官网复制按钮降级路径失败或残留 textarea: legacy=${legacyCopied}`);
}

// 3f. 赞赏弹窗（顶栏按钮打开 -> X 关闭 -> 页脚按钮打开 -> 遮罩点击关闭 -> Escape 关闭 -> 快速重开防竞态）
const dialog = byId.get('sponsor-dialog');
byId.get('header-coffee-btn').dispatchEvent({ type: 'click' });
if (!dialog.open) fail('顶栏咖啡按钮未能打开赞赏弹窗');
byId.get('sponsor-close-x').dispatchEvent({ type: 'click' });
await new Promise((r) => setTimeout(r, 15));
if (dialog.open) fail('赞赏弹窗右上角关闭按钮失效');
byId.get('footer-coffee-btn').dispatchEvent({ type: 'click' });
if (!dialog.open) fail('页脚赞赏按钮未能打开弹窗');
// 点击遮罩外侧（rect 之外：clientX=10, clientY=10）触发无 closedBy 降级关闭
dialog.dispatchEvent({ type: 'click', target: dialog, clientX: 10, clientY: 10 });
await new Promise((r) => setTimeout(r, 15));
if (dialog.open) fail('赞赏弹窗遮罩点击关闭降级失效');
byId.get('header-coffee-btn').dispatchEvent({ type: 'click' });
dialog.dispatchEvent({ type: 'cancel' });
await new Promise((r) => setTimeout(r, 15));
if (dialog.open) fail('赞赏弹窗 Escape(cancel) 关闭失效');

// 3g. 宣传片影幕起播、章节跳播与影院模式弹窗（含关闭自动暂停）
const filmViewport = byId.get('film-viewport');
const filmFacade = byId.get('film-play-facade');
const promoVideo = byId.get('promo-video');
const cinemaDialog = byId.get('cinema-dialog');
const cinemaVideo = byId.get('cinema-video');
if (!filmFacade || !promoVideo || !cinemaDialog || !cinemaVideo) {
  fail('缺少宣传片影幕或影院模式关键 DOM 元素');
}
if (promoVideo.getAttribute('loading') !== 'lazy' || promoVideo.getAttribute('preload') !== 'none' || !promoVideo.getAttribute('width') || !promoVideo.getAttribute('height')) {
  fail('promo-video 未满足 lazy-load-video-and-audio 规范（需 loading=lazy, preload=none, 显式宽高）');
}
filmFacade.dispatchEvent({ type: 'click' });
if (!filmViewport.classList.contains('is-playing') || promoVideo.paused) {
  fail('点击影幕封面未能无缝切入播放');
}
const ch2 = byId.get('film-ch-2');
ch2.dispatchEvent({ type: 'click' });
if (promoVideo.currentTime !== 34 || !ch2.classList.contains('is-active')) {
  fail(`章节跳播失败: currentTime=${promoVideo.currentTime}, active=${ch2.classList.contains('is-active')}`);
}
byId.get('film-open-cinema').dispatchEvent({ type: 'click' });
if (!cinemaDialog.open || !promoVideo.paused || cinemaVideo.paused || cinemaVideo.currentTime !== 34) {
  fail('影院模式未能接力时间戳并暂停页面内嵌视频');
}
cinemaDialog.dispatchEvent({ type: 'cancel' });
await new Promise((r) => setTimeout(r, 15));
if (cinemaDialog.open || !cinemaVideo.paused) {
  fail('关闭影院弹窗后未自动暂停视频或未关闭');
}
byId.get('hero-watch-film').dispatchEvent({ type: 'click' });
if (!cinemaDialog.open || cinemaVideo.paused) {
  fail('首屏「观看宣传片」按钮未能打开影院弹窗起播');
}
byId.get('cinema-close-btn').dispatchEvent({ type: 'click' });
await new Promise((r) => setTimeout(r, 15));
if (cinemaDialog.open || !cinemaVideo.paused) {
  fail('影院关闭按钮未能关闭并暂停视频');
}

// 3h. 全站 9 处产品截图点击无缝放大灯箱（含图集切换、2× 缩放、焦点归还与 Esc/遮罩关闭）
const zoomTriggers = allEls.filter((e) => e.classList.contains('zoom-trigger'));
if (zoomTriggers.length !== 9) {
  fail(`预期 9 处可放大产品截图，实测 ${zoomTriggers.length} 处`);
}
const lbDialog = byId.get('media-lightbox');
const lbImg = byId.get('lb-img');
const lbCounter = byId.get('lb-counter');
const lbZoomBtn = byId.get('lb-zoom-btn');
const spaceTrigger = byId.get('zoom-story-space');
spaceTrigger.dispatchEvent({ type: 'click' });
await new Promise((r) => setTimeout(r, 20));
if (!lbDialog.open || !lbImg.src.includes('05-space-tools.png') || lbCounter.textContent !== '5 / 5') {
  fail(`点击 Story 04 叠加副图打开灯箱失败: open=${lbDialog.open}, src=${lbImg.src}, counter=${lbCounter.textContent}`);
}
lbDialog.dispatchEvent({ type: 'keydown', key: 'ArrowRight' });
if (!lbImg.src.includes('01-ai-assistant.png') || lbCounter.textContent !== '1 / 5') {
  fail(`灯箱 ArrowRight 循环切图失败: src=${lbImg.src}, counter=${lbCounter.textContent}`);
}
lbZoomBtn.dispatchEvent({ type: 'click' });
if (lbZoomBtn.getAttribute('aria-pressed') !== 'true') {
  fail('灯箱 2× 细节放大按钮状态未切换');
}
lbDialog.dispatchEvent({ type: 'cancel' });
await new Promise((r) => setTimeout(r, 20));
if (lbDialog.open || focusedEl !== spaceTrigger) {
  fail(`灯箱 Esc 关闭或焦点归还失败: open=${lbDialog.open}, focus=${focusedEl && focusedEl.id}`);
}
// 遮罩点击降级关闭
byId.get('zoom-stage-org').dispatchEvent({ type: 'click' });
await new Promise((r) => setTimeout(r, 20));
if (!lbDialog.open || !lbImg.src.includes('02-organize.png')) {
  fail('点击首屏智能整理截图未能打开灯箱');
}
lbDialog.dispatchEvent({ type: 'click', target: lbDialog, clientX: 5, clientY: 5 });
await new Promise((r) => setTimeout(r, 20));
if (lbDialog.open) {
  fail('灯箱遮罩点击关闭降级失效');
}

// 3i. 校验样式表无断规则（.sr-only、sponsor-dialog、film-frame、cinema-dialog、media-lightbox 与 View Transition）
const requiredCss = [
  '.sr-only',
  'dialog.sponsor-dialog',
  '.film-frame',
  'dialog.cinema-dialog',
  'dialog.media-lightbox',
  '::view-transition-group(qdisk-zoom-media)',
  'overscroll-behavior: contain'
];
for (const rule of requiredCss) {
  if (!css.includes(rule)) fail(`website/styles.css 缺少核心样式规则: ${rule}`);
}

console.log('结果：官网（website/）全部按钮、宣传片影幕、影院弹窗、9 处图片放大灯箱、资源、锚点、双语、主题、Tab 键盘导航、基准切换、剪贴板降级与赞赏弹窗红队自测全绿');
process.exit(0);
