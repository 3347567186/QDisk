/* 页面挂载与渲染端到端自测：
   验证全部 12 个页面脚本在 DOM 环境下的加载、mount、unmount 及核心子视图渲染。
   盯死 TDZ、未声明变量（如 fmtSize）、API 签名错位等回归问题。
   跑法：node src\web\js\ai\pages.selftest.mjs （失败退出码 1） */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../../..');

class FakeClassList {
  constructor() { this.classes = new Set(); }
  add(...cls) { cls.forEach(c => this.classes.add(c)); }
  remove(...cls) { cls.forEach(c => this.classes.delete(c)); }
  contains(c) { return this.classes.has(c); }
  toggle(c, force) {
    if (force === undefined) {
      if (this.classes.has(c)) { this.classes.delete(c); return false; }
      else { this.classes.add(c); return true; }
    }
    if (force) this.classes.add(c); else this.classes.delete(c);
    return force;
  }
  toString() { return Array.from(this.classes).join(' '); }
}

class FakeStyle {
  constructor() {}
  setProperty(k, v) { this[k] = v; }
  removeProperty(k) { delete this[k]; }
}

class FakeNode {}

class FakeElement extends FakeNode {
  constructor(tagName) {
    super();
    this.tagName = tagName ? tagName.toUpperCase() : 'DIV';
    this.classList = new FakeClassList();
    this.children = [];
    this.attributes = {};
    this.style = new FakeStyle();
    this.dataset = {};
    this.listeners = {};
    this._textContent = '';
    this._innerHTML = '';
    this.value = '';
    this.id = '';
    this.checked = false;
    this.width = 100;
    this.height = 100;
    this.parent = null;
  }
  get parentNode() { return this.parent; }
  appendChild(child) {
    if (child && child.tagName === '#FRAGMENT') {
      const items = child.children.slice();
      items.forEach((n) => this.appendChild(n));
      child.children = [];
      return child;
    }
    if (child) {
      if (child.parent && child.parent !== this && typeof child.parent.removeChild === 'function') {
        child.parent.removeChild(child);
      }
      child.parent = this;
    }
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx >= 0) this.children.splice(idx, 1);
    if (child && child.parent === this) child.parent = null;
    return child;
  }
  remove() {
    if (this.parent) this.parent.removeChild(this);
  }
  contains(node) {
    let cur = node;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parent || cur.parentNode || null;
    }
    return false;
  }
  closest(sel) {
    let cur = this;
    while (cur) {
      if (sel.startsWith('.') && cur.classList && cur.classList.contains(sel.slice(1))) return cur;
      if (sel.startsWith('#') && cur.id === sel.slice(1)) return cur;
      if (cur.tagName && cur.tagName.toLowerCase() === sel.toLowerCase()) return cur;
      cur = cur.parent || cur.parentNode || null;
    }
    return null;
  }
  replaceChildren(...nodes) {
    this.children = nodes;
    nodes.forEach(n => { if (n) n.parent = this; });
  }
  querySelector(sel) {
    const check = (node) => {
      if (!node || !node.classList) return null;
      if (sel.startsWith('#') && node.id === sel.slice(1)) return node;
      if (sel.startsWith('.') && node.classList.contains(sel.slice(1))) return node;
      if (node.tagName && node.tagName.toLowerCase() === sel.toLowerCase()) return node;
      for (const child of node.children) {
        const found = check(child);
        if (found) return found;
      }
      return null;
    };
    return check(this) || new FakeElement('div');
  }
  querySelectorAll(sel) {
    const res = [];
    const parts = String(sel || '').trim().split(/\s+/);
    const leafSel = parts[parts.length - 1] || '';
    const ancSel = parts.length > 1 ? parts[parts.length - 2] : '';
    const matchesOne = (node, s) => {
      if (!node || !node.classList || !s) return false;
      if (s.startsWith('#')) return node.id === s.slice(1);
      if (s.startsWith('.')) return node.classList.contains(s.slice(1));
      if (s.includes('.')) {
        const [tag, cls] = s.split('.');
        return (!tag || (node.tagName && node.tagName.toLowerCase() === tag.toLowerCase())) && node.classList.contains(cls);
      }
      return !!(node.tagName && node.tagName.toLowerCase() === s.toLowerCase());
    };
    const check = (node, ancHit) => {
      if (!node || !node.classList) return;
      const nowAnc = ancHit || !ancSel || matchesOne(node, ancSel);
      if (ancHit && matchesOne(node, leafSel)) res.push(node);
      else if (!ancSel && matchesOne(node, leafSel)) res.push(node);
      for (const child of node.children) check(child, nowAnc);
    };
    for (const child of this.children) check(child, !ancSel);
    return res.length > 0 ? res : [new FakeElement('div'), new FakeElement('div'), new FakeElement('div'), new FakeElement('div'), new FakeElement('div')];
  }
  addEventListener(evt, cb) {
    if (!this.listeners[evt]) this.listeners[evt] = [];
    this.listeners[evt].push(cb);
  }
  removeEventListener(evt, cb) {
    if (this.listeners[evt]) {
      this.listeners[evt] = this.listeners[evt].filter(f => f !== cb);
    }
  }
  dispatchEvent(e) {
    const cbs = this.listeners[e.type] || [];
    cbs.forEach(cb => cb(e));
  }
  focus() {}
  blur() {}
  select() {}
  scrollIntoView() {}
  getContext() {
    return {
      fillRect() {}, clearRect() {}, beginPath() {}, arc() {}, fill() {}, stroke() {},
      moveTo() {}, lineTo() {}, closePath() {}, setTransform() {}, save() {}, restore() {},
      drawImage() {}, measureText() { return { width: 10 }; }, createLinearGradient() { return { addColorStop() {} }; }
    };
  }
  getBoundingClientRect() {
    return { top: 0, left: 0, right: 100, bottom: 100, width: 100, height: 100 };
  }
  setAttribute(k, v) { this.attributes[k] = v; if (k === 'id') this.id = v; }
  getAttribute(k) { return this.attributes[k]; }
  hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k); }
  toggleAttribute(k, force) {
    const on = force === undefined ? !this.hasAttribute(k) : !!force;
    if (on) this.setAttribute(k, '');
    else this.removeAttribute(k);
    return on;
  }
  removeAttribute(k) { delete this.attributes[k]; }
  get textContent() { return this._textContent; }
  set textContent(v) { this._textContent = String(v); this.children = []; }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(v) { this._innerHTML = String(v); if (!v) this.children = []; }
  get className() { return this.classList.toString(); }
  set className(v) { this.classList = new FakeClassList(); if (v) v.split(/\s+/).forEach(c => c && this.classList.add(c)); }
}

const storage = {};
const fakeLocalStorage = {
  getItem: (k) => storage[k] || null,
  setItem: (k, v) => { storage[k] = String(v); },
  removeItem: (k) => { delete storage[k]; }
};

const activeIntervals = new Set();
const docListeners = new Map();
const trackedSetInterval = (fn, ms, ...args) => {
  const id = setInterval(fn, ms, ...args);
  activeIntervals.add(id);
  return id;
};
const trackedClearInterval = (id) => {
  activeIntervals.delete(id);
  return clearInterval(id);
};
const trackedDocAdd = (evt, cb) => {
  if (!docListeners.has(evt)) docListeners.set(evt, []);
  const arr = docListeners.get(evt);
  if (!arr.includes(cb)) arr.push(cb);
};
const trackedDocRemove = (evt, cb) => {
  const arr = docListeners.get(evt);
  if (arr) docListeners.set(evt, arr.filter((x) => x !== cb));
};

const sandbox = {
  console, setTimeout, clearTimeout,
  setInterval: trackedSetInterval,
  clearInterval: trackedClearInterval,
  Date, Math, JSON, Promise, Number, String, Object, Array, Set, Map, isNaN, Intl,
  performance: globalThis.performance,
  Node: FakeNode,
  App: {
    nav() {},
    jump() {},
    setPowerMode: async () => {},
    setTheme: async () => {},
    setLang: async () => {},
    setMotion: async () => {},
    setPageSize: async () => {}
  },
  requestAnimationFrame: (cb) => setTimeout(cb, 16),
  cancelAnimationFrame: (id) => clearTimeout(id),
  MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
  localStorage: fakeLocalStorage,
  document: {
    _byId: { 'modal-root': new FakeElement('div') },
    createElement: (t) => new FakeElement(t),
    createElementNS: (ns, t) => new FakeElement(t),
    createDocumentFragment: () => new FakeElement('#fragment'),
    createTextNode: (txt) => { const el = new FakeElement('#text'); el.textContent = txt; return el; },
    getElementById: (id) => (id && sandbox.document._byId[id]) ? sandbox.document._byId[id] : new FakeElement('div'),
    addEventListener: trackedDocAdd,
    removeEventListener: trackedDocRemove,
    head: new FakeElement('head'),
    body: new FakeElement('body'),
    querySelector: () => new FakeElement('div'),
    querySelectorAll: () => []
  },
  addEventListener: () => {},
  removeEventListener: () => {},
  location: { href: 'http://localhost/' },
  navigator: { userAgent: 'node' },
  Event: class FakeEvent { constructor(type) { this.type = type; } },
  CustomEvent: class FakeCustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

sandbox.API = {
  engine: async (method) => {
    if (method === 'system.performance') {
      return {
        cpu_usage_pct: 12.5,
        memory: { total_mb: 16384, available_mb: 8192, used_mb: 8192, used_pct: 50.0 },
        system_drives: [{ drive: 'C:\\', total_gb: 500, free_gb: 250, used_gb: 250, used_pct: 50.0 }],
        top_apps: [{ name: 'TestApp', clean_name: 'test', memory: 104857600, process_count: 1, pids: [1234] }]
      };
    }
    if (method === 'process.list') {
      return {
        ok: true,
        items: [
          { name: 'App1.exe', clean_name: 'app1', memory: 52428800, process_count: 1, is_system: false, pids: [100] },
          { name: 'System.exe', clean_name: 'sys', memory: 10485760, process_count: 1, is_system: true, pids: [4] }
        ],
        raw_count: 2,
        total_memory: 62914560
      };
    }
    if (method === 'startup.list') {
      return {
        ok: true,
        items: [
          { name: 'AutoApp', enabled: true, exists: true, location: 'HKCU', command: 'app.exe' },
          { name: 'BrokenApp', enabled: true, exists: false, location: 'HKCU', command: 'missing.exe' }
        ]
      };
    }
    if (method === 'apps.list') {
      return {
        ok: true,
        items: [
          { name: 'App1', version: '1.0', publisher: 'Pub1', install_path: 'C:\\App1', size: 1048576, date: 1700000000, uninstall: 'cmd1' },
          { name: 'App2', version: '2.0', publisher: 'Pub2', install_path: 'C:\\App2', size: 2097152, date: 1710000000, uninstall: 'cmd2' }
        ]
      };
    }
    return { ok: true, items: [], partitions: [], drives: [] };
  },
  isAdmin: async () => true,
  platform: () => ({ os: 'windows' }),
  pickFolder: async () => 'D:\\Test',
  pickFiles: async () => [],
  showInFolder: async () => {},
  openPath: async () => {},
  convertFileSrc: (p) => 'asset://' + p
};

vm.createContext(sandbox);

const scripts = [
  'src/web/js/ui.js',
  'src/web/js/api.js',
  'src/web/js/ai/steve.js',
  'src/web/js/ai/prompt.js',
  'src/web/js/ai/md.js',
  'src/web/js/ai/guard.js',
  'src/web/js/ai/registry.js',
  'src/web/js/ai/proposals.js',
  'src/web/js/ai/tools.js',
  'src/web/js/ai/agent.js',
  'src/web/js/ai/store.js',
  'src/web/js/ai/strength.js',
  'src/web/js/ai/pool.js',
  'src/web/js/ai/motion.js',
  'src/web/js/ai/procs.js',
  'src/web/js/ai/follow.js',
  'src/web/js/ai/turnrail.js',
  'src/web/js/ai/effort.js',
  'src/web/js/ai/composer.js',
  'src/web/js/ai/entries.js',
  'src/web/js/ai/chatui.js',
  'src/web/js/ai/drawer.js',
  'src/web/js/pages/ai.js',
  'src/web/js/pages/organize.js',
  'src/web/js/pages/shots.js',
  'src/web/js/pages/cache.js',
  'src/web/js/dirview.js',
  'src/web/js/pages/tools.js',
  'src/web/js/pages/archive.js',
  'src/web/js/pages/search.js',
  'src/web/js/pages/rules.js',
  'src/web/js/pages/apps.js',
  'src/web/js/pages/migrate.js',
  'src/web/js/pages/log.js',
  'src/web/js/pages/settings.js'
];

for (const s of scripts) {
  const full = path.join(root, s);
  const code = fs.readFileSync(full, 'utf8');
  try {
    vm.runInContext(code, sandbox, { filename: path.basename(s) });
  } catch (err) {
    console.error(`[加载失败] ${s}:`, err);
    process.exit(1);
  }
}

// 门禁断言：UI.fmtBytes 与 UI.fmtSize 必须一致且可用
if (typeof sandbox.UI.fmtBytes !== 'function') throw new Error('UI.fmtBytes 缺失');
if (typeof sandbox.UI.fmtSize !== 'function') throw new Error('UI.fmtSize 缺失');
if (sandbox.UI.fmtBytes(1048576) !== '1.0 MB') throw new Error('fmtBytes(1048576) 结果不符合预期');
if (sandbox.UI.fmtSize(1048576) !== '1.0 MB') throw new Error('fmtSize(1048576) 结果不符合预期');

let count = 0;
const pageIds = Object.keys(sandbox.Pages);
if (pageIds.length !== 12) {
  console.error(`[页面计数异常] 期望 12 页，实际 ${pageIds.length}: ${pageIds.join(', ')}`);
  process.exit(1);
}

for (const round of [1, 2]) {
  count = 0;
  for (const [id, page] of Object.entries(sandbox.Pages)) {
    const holder = new FakeElement('div');
    const beforeInt = activeIntervals.size;
    const beforeVis = (docListeners.get('visibilitychange') || []).length;
    const beforeKey = (docListeners.get('keydown') || []).length;
    try {
      if (typeof page.mount === 'function') {
        const ret = await page.mount(holder);
        if (id === 'apps' && typeof page.jump === 'function') {
          await page.jump({ tab: 'footprint' });
        }
        if (typeof ret === 'function') ret();
      }
      if (typeof page.unmount === 'function') {
        page.unmount();
      }
      const leakInt = activeIntervals.size - beforeInt;
      const leakVis = (docListeners.get('visibilitychange') || []).length - beforeVis;
      const leakKey = (docListeners.get('keydown') || []).length - beforeKey;
      /* round=1 时 ai 会懒创建应用级单例 sharedChat（SteveAvatar + AIComposer 常驻），
         round=2 起包括 ai 在内的全部 12 页监听器/定时器增量必须严格归零。 */
      const allowSingleton = (round === 1 && id === 'ai');
      if (leakInt > 0 || (!allowSingleton && (leakVis > 0 || leakKey > 0))) {
        console.error(`[资源泄漏 round=${round}] 页面 ${id} unmount 后残留: intervals=${leakInt}, visibilitychange=${leakVis}, keydown=${leakKey}`);
        process.exit(1);
      }
      count++;
    } catch (err) {
      console.error(`[挂载崩溃 round=${round}] 页面 ${id}:`, err);
      process.exit(1);
    }
  }
}

// 核心回归门禁：已安装程序与自启（apps）在具备内存缓存时再次挂载（warm mount），必须正常呈现且不崩溃
try {
  const warmHolder = new FakeElement('div');
  const beforeWarmInt = activeIntervals.size;
  const retWarm = await sandbox.Pages.apps.mount(warmHolder);
  if (typeof retWarm === 'function') retWarm();
  if (activeIntervals.size > beforeWarmInt) {
    console.error('[二次挂载定时器泄漏] apps warm mount 未释放 interval');
    process.exit(1);
  }
} catch (err) {
  console.error('[内存缓存二次挂载回归失败] apps.mount:', err);
  process.exit(1);
}

// 静态样式令牌校验：防止 CSS 里引用未定义且无回退值的 var(--*) 导致弹窗透明等隐蔽渲染故障
{
  const cssPath = path.join(root, 'src', 'web', 'styles.css');
  const cssText = fs.readFileSync(cssPath, 'utf8');
  const defs = new Set([...cssText.matchAll(/(--[a-zA-Z0-9_-]+)\s*:/g)].map((m) => m[1]));
  const badVars = [];
  cssText.split(/\r?\n/).forEach((line, idx) => {
    for (const m of line.matchAll(/var\((--[a-zA-Z0-9_-]+)\s*\)/g)) {
      if (!defs.has(m[1])) badVars.push(`styles.css:${idx + 1} ${m[1]}`);
    }
  });
  if (badVars.length) {
    console.error(`[CSS 未定义令牌] 发现 ${badVars.length} 处无回退未定义 CSS 变量:\n` + badVars.join('\n'));
    process.exit(1);
  }
}

// 真实递归节点检索（FakeElement.querySelectorAll 无匹配时会返回 5 个占位 div，不可用于否定断言）
function findNodes(rootNode, pred, out = []) {
  if (!rootNode) return out;
  if (pred(rootNode)) out.push(rootNode);
  if (Array.isArray(rootNode.children)) {
    for (const ch of rootNode.children) findNodes(ch, pred, out);
  }
  return out;
}

// 回归 1：设置页移除顶部快速导航条（.set-nav-bar）与 AI 入口（.ask-ai-btn），同时保留 AI 助手配置手风琴
{
  const holder = new FakeElement('div');
  const beforeInt = activeIntervals.size;
  const ret = await sandbox.Pages.settings.mount(holder);
  if (findNodes(holder, (n) => n.classList && n.classList.contains('set-nav-bar')).length !== 0) {
    console.error('[设置页回归] 顶部快速导航条 .set-nav-bar 仍被渲染');
    process.exit(1);
  }
  if (findNodes(holder, (n) => n.classList && n.classList.contains('ask-ai-btn')).length !== 0) {
    console.error('[设置页回归] 设置页仍残留 AI 入口 .ask-ai-btn');
    process.exit(1);
  }
  const assistantSecs = findNodes(
    holder,
    (n) => (n.attributes && n.attributes['data-section'] === 'assistant') || (n.dataset && n.dataset.section === 'assistant')
  );
  if (!assistantSecs.length) {
    console.error('[设置页回归] 未保留 AI 助手配置手风琴 [data-section="assistant"]');
    process.exit(1);
  }
  const modeBars = findNodes(assistantSecs[0], (n) => n.classList && n.classList.contains('ai-modes'));
  const catChips = findNodes(assistantSecs[0], (n) => n.classList && n.classList.contains('agent-cat-chip'));
  const limitFields = [];
  findNodes(assistantSecs[0], (n) => n.classList && n.classList.contains('agent-limits')).forEach((lim) => {
    findNodes(lim, (c) => c.classList && c.classList.contains('field'), limitFields);
  });
  const setBars = findNodes(assistantSecs[0], (n) => n.classList && n.classList.contains('ai-set-bar'));
  if (!modeBars.length || catChips.length < 7 || limitFields.length !== 3 || !setBars.length) {
    console.error(`[设置页回归] AI 助手配置重排结构缺失: modes=${modeBars.length}, chips=${catChips.length}, limits=${limitFields.length}, bar=${setBars.length}`);
    process.exit(1);
  }
  sandbox.Pages.settings.jump({ section: 'assistant' });
  if (typeof ret === 'function') ret();
  if (typeof sandbox.Pages.settings.unmount === 'function') sandbox.Pages.settings.unmount();
  if (activeIntervals.size > beforeInt) {
    console.error('[设置页回归] unmount 后残留定时器');
    process.exit(1);
  }
}

// 回归 2：SteveAvatar 3D 渲染、点击动作、音效合成与「导航/主图保留爆裂、按钮问助手入口禁爆裂」回归
{
  const burstCount = () => findNodes(sandbox.document.body, (n) => n.classList && n.classList.contains('steve-burst')).length;

  const st = sandbox.SteveAvatar.el({ size: 28, variant: 'nav' });
  const b0 = burstCount();
  sandbox.SteveAvatar.click(st);
  if (burstCount() <= b0) {
    console.error('[SteveAvatar 回归] 侧栏导航入口 variant=nav 点击未触发爆裂效果');
    process.exit(1);
  }
  sandbox.SteveAvatar.sound(0);
  if (!st || !st._steve || typeof st._steve.destroy !== 'function') {
    console.error('[SteveAvatar 回归] 未挂载 _steve 控制器或 destroy 方法');
    process.exit(1);
  }
  st._steve.destroy();

  const btnMark = sandbox.SteveAvatar.el({ size: 18, variant: 'btn' });
  const b1 = burstCount();
  sandbox.SteveAvatar.click(btnMark);
  if (burstCount() !== b1) {
    console.error('[SteveAvatar 回归] 面板按钮入口 variant=btn 默认点击不应触发爆裂效果');
    process.exit(1);
  }
  btnMark._steve.destroy();

  const askEl = sandbox.UI.askBtn({ title: '测试问助手', question: '测试问题' });
  const beforeKey = (docListeners.get('keydown') || []).length;
  const beforeInt = activeIntervals.size;
  const b2 = burstCount();
  askEl.dispatchEvent(new sandbox.Event('click'));
  if (burstCount() !== b2) {
    console.error('[SteveAvatar 回归] UI.askBtn 问助手入口点击时不应显示爆炸效果');
    process.exit(1);
  }
  sandbox.AIDrawer.close();
  if ((docListeners.get('keydown') || []).length !== beforeKey || activeIntervals.size !== beforeInt) {
    console.error('[SteveAvatar 回归] UI.askBtn 打开后关闭未完整回收监听或定时器');
    process.exit(1);
  }
}

// 回归 3：AIDrawer 打开仅生成建议提示词（绝不 120ms 自动发送），关闭严格回收 keydown Esc 监听与 busyTimer
{
  const scene = sandbox.AIChat.scene();
  if (!scene) {
    console.error('[AIDrawer 回归] 未获取到共享聊天现场 AIChat.scene()');
    process.exit(1);
  }
  const origAsk = scene.ask;
  let askCalls = 0;
  scene.ask = (...a) => {
    askCalls += 1;
    return origAsk.apply(scene, a);
  };
  const beforeKey = (docListeners.get('keydown') || []).length;
  const beforeInt = activeIntervals.size;
  sandbox.AIDrawer.open({
    question: '帮我看看当前缓存',
    suggestions: ['还有哪些大文件？'],
    ctx: () => ({ page: 'cache' })
  });
  await new Promise((r) => setTimeout(r, 160));
  scene.ask = origAsk;
  if (askCalls !== 0) {
    console.error(`[AIDrawer 回归] 打开抽屉后仍自动触发了 chat.ask (${askCalls} 次)`);
    process.exit(1);
  }
  const nodeText = (n) => {
    if (!n) return '';
    let s = String(n._textContent || '');
    if (Array.isArray(n.children)) s += n.children.map(nodeText).join('');
    return s;
  };
  const sugNodes = findNodes(
    sandbox.document.body,
    (n) => n.classList && (n.classList.contains('ai-sp-chip') || n.classList.contains('ai-empty-q'))
      && nodeText(n).includes('帮我看看当前缓存')
  );
  if (!sugNodes.length) {
    console.error('[AIDrawer 回归] 打开抽屉后未渲染传入的建议提示词「帮我看看当前缓存」');
    process.exit(1);
  }
  sandbox.AIDrawer.close();
  const afterKey = (docListeners.get('keydown') || []).length;
  const afterInt = activeIntervals.size;
  if (afterKey !== beforeKey || afterInt !== beforeInt) {
    console.error(`[AIDrawer 回归] close 后资源未回收: keydown=${afterKey - beforeKey}, intervals=${afterInt - beforeInt}`);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 200));
}

// 回归 4：全软件移除顶栏全屏按钮 (#btn-fullscreen) 与 app.js 绑定
{
  const html = fs.readFileSync(path.join(root, 'src', 'web', 'index.html'), 'utf8');
  if (/id\s*=\s*["']btn-fullscreen["']/.test(html)) {
    console.error('[全局回归] index.html 中仍残留全屏按钮 #btn-fullscreen');
    process.exit(1);
  }
}

// 回归 5：日志页主从工作台单行顶栏重排（无旧双重工具条，左侧图标动作组，右侧问助手/复制/定位）
{
  const origLogList = sandbox.API.logList;
  const origLogRead = sandbox.API.logRead;
  sandbox.API.logList = async () => ([
    { name: 'tidy-2026.log', path: 'D:\\Logs\\tidy-2026.log', size: 2048, mtime: 1732200000 }
  ]);
  sandbox.API.logRead = async () => '[INFO] moved 3 files\n';
  const logHolder = new FakeElement('div');
  const beforeInt = activeIntervals.size;
  const ret = await sandbox.Pages.log.mount(logHolder);
  await sandbox.Pages.log.jump({ file: 'tidy-2026.log' });
  const splitLeft = findNodes(logHolder, (n) => n.classList && n.classList.contains('split-left'))[0];
  const splitRight = findNodes(logHolder, (n) => n.classList && n.classList.contains('split-right'))[0];
  const heads = findNodes(logHolder, (n) => n.classList && n.classList.contains('log-pane-head'));
  const leftToolbars = splitLeft ? findNodes(splitLeft, (n) => n.classList && n.classList.contains('toolbar')) : [];
  const leftAsk = splitLeft ? findNodes(splitLeft, (n) => n.classList && n.classList.contains('ask-ai-btn')) : [];
  const rightAsk = splitRight ? findNodes(splitRight, (n) => n.classList && n.classList.contains('ask-ai-btn')) : [];
  const items = findNodes(logHolder, (n) => n.classList && n.classList.contains('log-file-item'));
  const preNodes = findNodes(logHolder, (n) => n.classList && n.classList.contains('log-viewer-pre'));
  if (heads.length !== 2 || leftToolbars.length !== 0 || leftAsk.length !== 0 || rightAsk.length !== 1 || items.length !== 1 || preNodes.length !== 1) {
    console.error(`[日志页回归] 重排结构校验失败: heads=${heads.length}, leftToolbars=${leftToolbars.length}, leftAsk=${leftAsk.length}, rightAsk=${rightAsk.length}, items=${items.length}, pre=${preNodes.length}`);
    process.exit(1);
  }
  if (typeof ret === 'function') ret();
  if (typeof sandbox.Pages.log.unmount === 'function') sandbox.Pages.log.unmount();
  sandbox.API.logList = origLogList;
  sandbox.API.logRead = origLogRead;
  if (activeIntervals.size > beforeInt) {
    console.error('[日志页回归] unmount 后残留定时器');
    process.exit(1);
  }
}

// 回归 6：开发者信息仅存于底层源码注释，软件可见 UI 与 HTML 正文严禁渲染展示
{
  const txt = (n) => {
    if (!n) return '';
    let s = String(n._textContent || '');
    if (Array.isArray(n.children)) s += n.children.map(txt).join('');
    return s;
  };
  const html = fs.readFileSync(path.join(root, 'src', 'web', 'index.html'), 'utf8');
  if (!/<!--[\s\S]*?白林[\s\S]*?3347567186@qq\.com[\s\S]*?-->/.test(html)) {
    console.error('[开发者隐私回归] index.html 底层注释中缺少白林 / Type / 3347567186@qq.com 信息');
    process.exit(1);
  }
  const visibleHtml = html.replace(/<!--[\s\S]*?-->/g, '');
  if (/白林|3347567186@qq\.com|帅气的男孩/.test(visibleHtml)) {
    console.error('[开发者隐私回归] index.html 可见正文不应暴露开发者信息');
    process.exit(1);
  }
  const setHolder = new FakeElement('div');
  const retSet = await sandbox.Pages.settings.mount(setHolder);
  if (/白林|3347567186@qq\.com|帅气的男孩/.test(txt(setHolder))) {
    console.error('[开发者隐私回归] 设置页渲染文本不应包含开发者信息');
    process.exit(1);
  }
  if (typeof retSet === 'function') retSet();
  if (typeof sandbox.Pages.settings.unmount === 'function') sandbox.Pages.settings.unmount();
}

// 回归 7：压缩包「解压到」支持自定义新建文件夹并自动创建目标目录
{
  const txt = (n) => {
    if (!n) return '';
    let s = String(n._textContent || '');
    if (Array.isArray(n.children)) s += n.children.map(txt).join('');
    return s;
  };
  const clickBtn = (btn) => {
    if (!btn) return;
    if (btn.listeners && btn.listeners.click && btn.listeners.click.length) {
      btn.dispatchEvent(new sandbox.Event('click'));
    } else if (typeof btn.onclick === 'function') {
      btn.onclick();
    }
  };
  const modalRoot = sandbox.document._byId['modal-root'];
  modalRoot.children = [];
  const origOpen = sandbox.API.archiveOpen;
  const origExtract = sandbox.API.archiveExtract;
  const extractCalls = [];
  sandbox.API.archiveOpen = async (p) => ({
    path: p,
    format: 'zip',
    rarReady: true,
    entries: [{ index: 0, name: 'init.sql', size: 1024, is_dir: false, mtime: 1732200000 }]
  });
  sandbox.API.archiveExtract = async (pathArg, outDir) => {
    extractCalls.push({ path: pathArg, outDir });
    return { files: 1, dirs: 0, bytes: 1024, skipped: 0, outDir };
  };

  const arcHolder = new FakeElement('div');
  const beforeKey = (docListeners.get('keydown') || []).length;
  const beforeInt = activeIntervals.size;
  const retArc = await sandbox.Pages.archive.mount(arcHolder);
  await sandbox.Pages.archive.jump({ paths: ['D:\\下载\\数据库.zip'] });

  const extractAllBtn = findNodes(arcHolder, (n) => n.tagName === 'BUTTON' && txt(n).includes('解压全部'))[0];
  if (!extractAllBtn) {
    console.error('[压缩包回归] 未找到「解压全部」按钮');
    process.exit(1);
  }
  clickBtn(extractAllBtn);

  const modes = findNodes(modalRoot, (n) => n.classList && n.classList.contains('xdlg-mode'));
  const customBtn = modes.find((b) => txt(b).includes('自定义新建文件夹'));
  const nameRow = findNodes(modalRoot, (n) => n.classList && n.classList.contains('xdlg-name-row'))[0];
  const nameInput = nameRow ? findNodes(nameRow, (n) => n.tagName === 'INPUT')[0] : null;
  const targetCode = findNodes(modalRoot, (n) => n.classList && n.classList.contains('xdlg-path'))[0];
  const errDiv = findNodes(modalRoot, (n) => n.classList && n.classList.contains('xdlg-err'))[0];
  const startBtn = findNodes(modalRoot, (n) => n.tagName === 'BUTTON' && txt(n).includes('开始解压'))[0];
  if (modes.length !== 3 || !customBtn || !nameInput || !targetCode || !errDiv || !startBtn) {
    console.error(`[压缩包回归] 解压弹窗自定义文件夹控件缺失: modes=${modes.length}, custom=${!!customBtn}, input=${!!nameInput}`);
    process.exit(1);
  }

  clickBtn(customBtn);
  nameInput.value = 'bad/name';
  nameInput.dispatchEvent(new sandbox.Event('input'));
  if (!errDiv.textContent) {
    console.error('[压缩包回归] 含 / 的非法文件夹名未触发错误提示');
    process.exit(1);
  }
  clickBtn(startBtn);
  if (extractCalls.length !== 0) {
    console.error('[压缩包回归] 非法文件夹名不应触发解压调用');
    process.exit(1);
  }

  nameInput.value = '我的新目录';
  nameInput.dispatchEvent(new sandbox.Event('input'));
  if (errDiv.textContent || targetCode.textContent !== 'D:\\下载\\我的新目录') {
    console.error(`[压缩包回归] 自定义文件夹预览路径异常: err=${errDiv.textContent}, target=${targetCode.textContent}`);
    process.exit(1);
  }
  clickBtn(startBtn);
  await new Promise((r) => setTimeout(r, 40));

  if (extractCalls.length !== 1 || extractCalls[0].outDir !== 'D:\\下载\\我的新目录') {
    console.error('[压缩包回归] API.archiveExtract 收到的目标路径不符合自定义目录:', extractCalls);
    process.exit(1);
  }

  const closeDoneBtn = findNodes(modalRoot, (n) => n.tagName === 'BUTTON' && txt(n) === '关闭')[0];
  clickBtn(closeDoneBtn);
  if (typeof retArc === 'function') retArc();
  sandbox.API.archiveOpen = origOpen;
  sandbox.API.archiveExtract = origExtract;
  await new Promise((r) => setTimeout(r, 220));
  const afterKey = (docListeners.get('keydown') || []).length;
  const afterInt = activeIntervals.size;
  if (afterKey !== beforeKey || afterInt !== beforeInt) {
    console.error(`[压缩包回归] unmount/关闭弹窗后资源未回收: keydown=${afterKey - beforeKey}, intervals=${afterInt - beforeInt}`);
    process.exit(1);
  }
}

/* ==================== 回归 8：压缩包性能档位联动 & 暂停 / 继续 / 取消进度流 ==================== */
{
  const txt = (n) => {
    if (!n) return '';
    let s = String(n._textContent || '');
    if (Array.isArray(n.children)) s += n.children.map(txt).join('');
    return s;
  };
  const clickBtn = (btn) => {
    if (!btn) return;
    if (btn.listeners && btn.listeners.click && btn.listeners.click.length) {
      btn.dispatchEvent(new sandbox.Event('click'));
    } else if (typeof btn.onclick === 'function') {
      btn.onclick();
    }
  };
  const rootArc = new FakeElement('div');
  const modalRoot = sandbox.document._byId['modal-root'];
  modalRoot.children = [];

  const origTauri = sandbox.__TAURI__;
  const origCfgGet = sandbox.API.configGet;
  const origCfgSet = sandbox.API.configSet;
  const origOpen = sandbox.API.archiveOpen;
  const origExtract = sandbox.API.archiveExtract;
  const origPause = sandbox.API.archivePause;
  const origResume = sandbox.API.archiveResume;
  const origCancel = sandbox.API.archiveCancel;

  const eventHandlers = new Map();
  let cfgMode = 'hyper';
  let pauseCalls = 0;
  let resumeCalls = 0;
  let cancelCalls = 0;
  let rejectExtract = null;

  sandbox.__TAURI__ = Object.assign({}, origTauri || {}, {
    event: {
      listen: async (name, fn) => {
        eventHandlers.set(name, fn);
        return () => eventHandlers.delete(name);
      }
    }
  });
  sandbox.API.configGet = async () => ({ archive_mode: cfgMode, archive_extract_dir: 'D:\\下载', archive_extract_open: false });
  sandbox.API.configSet = async (patch) => { if (patch && patch.archive_mode) cfgMode = patch.archive_mode; };
  sandbox.API.archiveOpen = async (p) => ({
    path: p,
    format: 'ZIP',
    entries: [{ index: 0, name: 'big.tar', isDir: false, size: 1024 * 1024 * 100, packed: 512000, modified: '2026-11-22 10:00:00', encrypted: false, crc: 1 }],
    totalSize: 1024 * 1024 * 100,
    totalPacked: 512000,
    encrypted: false,
    solid: false,
    comment: '',
    needsRar: false,
    rarReady: true
  });
  sandbox.API.archiveExtract = () => new Promise((_, rej) => { rejectExtract = rej; });
  sandbox.API.archivePause = async () => { pauseCalls++; return true; };
  sandbox.API.archiveResume = async () => { resumeCalls++; return true; };
  sandbox.API.archiveCancel = async () => { cancelCalls++; return true; };

  const beforeKey = (docListeners.get('keydown') || []).length;
  const beforeInt = activeIntervals.size;
  const ret = await sandbox.Pages.archive.mount(rootArc);
  await new Promise((r) => setTimeout(r, 30));

  // 验证 configGet 加载的超线程档位同时同步到解压下拉和创建卡片
  const activeCreateMode = findNodes(rootArc, (n) => n.classList && n.classList.contains('arc-mode') && n.classList.contains('active'))[0];
  const extractModeLabel = findNodes(rootArc, (n) => n.classList && n.classList.contains('custom-select-label'))[0];
  if (!activeCreateMode || !txt(activeCreateMode).includes('超线程') || !extractModeLabel || txt(extractModeLabel) !== '超线程') {
    console.error(`[压缩包性能回归] configGet 档位未能同步到两侧控件: card=${txt(activeCreateMode)}, select=${txt(extractModeLabel)}`);
    process.exit(1);
  }

  // 点击创建区「性能模式」的「节约」卡片，验证解压侧 customSelect 联动同步
  const saverCard = findNodes(rootArc, (n) => n.classList && n.classList.contains('arc-mode') && txt(n).includes('节约'))[0];
  clickBtn(saverCard);
  if (txt(extractModeLabel) !== '节约') {
    console.error(`[压缩包性能回归] 创建页切换性能模式未联动解压选择器: select=${txt(extractModeLabel)}`);
    process.exit(1);
  }
  const hyperCard = findNodes(rootArc, (n) => n.classList && n.classList.contains('arc-mode') && txt(n).includes('超线程'))[0];
  clickBtn(hyperCard);

  // 打开压缩包并触发一个长时间未决的解压任务
  await sandbox.Pages.archive.jump({ paths: ['D:\\data.zip'] });
  const extractAllBtn = findNodes(rootArc, (n) => n.tagName === 'BUTTON' && txt(n).includes('解压全部'))[0];
  clickBtn(extractAllBtn);
  const startBtn = findNodes(modalRoot, (n) => n.tagName === 'BUTTON' && txt(n).includes('开始解压'))[0];
  clickBtn(startBtn);
  await new Promise((r) => setTimeout(r, 20));

  // 推送进度事件并验证档位徽标、暂停/继续、取消提示横幅
  const emitProgress = eventHandlers.get('archive-progress');
  if (!emitProgress) {
    console.error('[压缩包进度回归] 未注册 archive-progress 监听器');
    process.exit(1);
  }
  emitProgress({
    payload: {
      op: 'extract',
      phase: 'extract',
      paused: false,
      mode: 'hyper',
      files: 120,
      totalFiles: 500,
      bytes: 40 * 1024 * 1024,
      totalBytes: 100 * 1024 * 1024,
      name: 'big.tar'
    }
  });
  const modeTag = findNodes(rootArc, (n) => n.classList && n.classList.contains('arc-mode-tag'))[0];
  const pauseBtn = findNodes(rootArc, (n) => n.tagName === 'BUTTON' && txt(n) === '暂停')[0];
  const cancelBtnInitial = findNodes(rootArc, (n) => n.tagName === 'BUTTON' && txt(n) === '取消')[0];
  if (!modeTag || txt(modeTag) !== '超线程' || !pauseBtn || !cancelBtnInitial) {
    console.error(`[压缩包进度回归] 进度卡缺少档位徽标或暂停/取消按钮: tag=${txt(modeTag)}, pause=${!!pauseBtn}, cancel=${!!cancelBtnInitial}`);
    process.exit(1);
  }

  // 红队关键校验：连续推送高频进度事件（模拟 90ms 刷新覆盖 mousedown->mouseup 窗口），
  // 暂停与取消按钮必须保持同一 DOM 节点引用（绝不可 innerHTML 重建销毁按钮导致 click 被吞！）
  for (let step = 1; step <= 5; step++) {
    emitProgress({
      payload: {
        op: 'extract',
        phase: 'run',
        paused: false,
        mode: 'hyper',
        files: 120 + step,
        totalFiles: 500,
        bytes: (40 + step * 5) * 1024 * 1024,
        totalBytes: 100 * 1024 * 1024,
        name: `chunk_${step}.tar`
      }
    });
  }
  const pauseBtnAfterStream = findNodes(rootArc, (n) => n.tagName === 'BUTTON' && txt(n) === '暂停')[0];
  const cancelBtnAfterStream = findNodes(rootArc, (n) => n.tagName === 'BUTTON' && txt(n) === '取消')[0];
  if (pauseBtnAfterStream !== pauseBtn || cancelBtnAfterStream !== cancelBtnInitial) {
    console.error('[压缩包红队回归] 高频进度刷新重建了暂停/取消按钮 DOM，真实鼠标点击会被 WebView 吞掉！');
    process.exit(1);
  }

  // 红队边界：点击「暂停」在途期间若收到一条过期的 paused:false IPC 进度事件，不得闪退回运行态
  let resolvePauseRpc = null;
  sandbox.API.archivePause = () => new Promise((res) => { pauseCalls++; resolvePauseRpc = res; });
  clickBtn(pauseBtn);
  emitProgress({
    payload: {
      op: 'extract',
      phase: 'run',
      paused: false,
      mode: 'hyper',
      files: 126,
      totalFiles: 500,
      bytes: 65 * 1024 * 1024,
      totalBytes: 100 * 1024 * 1024,
      name: 'big.tar'
    }
  });
  const pauseBannerMidFlight = findNodes(rootArc, (n) => n.classList && n.classList.contains('arc-pause-banner') && !n.hidden)[0];
  if (!pauseBannerMidFlight || !txt(pauseBannerMidFlight).includes('已暂停')) {
    console.error('[压缩包红队回归] 暂停 RPC 在途期收到过期 run 事件导致暂停横幅闪烁消失');
    process.exit(1);
  }
  if (resolvePauseRpc) resolvePauseRpc(true);
  await new Promise((r) => setTimeout(r, 20));
  const pauseBanner = findNodes(rootArc, (n) => n.classList && n.classList.contains('arc-pause-banner') && !n.hidden)[0];
  const resumeBtn = findNodes(rootArc, (n) => n.tagName === 'BUTTON' && txt(n) === '继续')[0];
  if (pauseCalls !== 1 || !pauseBanner || !txt(pauseBanner).includes('已暂停') || !txt(pauseBanner).includes('65%') || resumeBtn !== pauseBtn) {
    console.error(`[压缩包暂停回归] 暂停态界面状态异常: calls=${pauseCalls}, banner=${txt(pauseBanner)}, sameBtn=${resumeBtn === pauseBtn}`);
    process.exit(1);
  }

  // 红队边界：任务运行/暂停期间再次尝试打开新压缩包，必须拦截，不能顶掉当前进度卡
  let openCallsDuringBusy = 0;
  const busyOpenSpy = sandbox.API.archiveOpen;
  sandbox.API.archiveOpen = async () => { openCallsDuringBusy++; return null; };
  await sandbox.Pages.archive.jump({ paths: ['D:\\other.zip'] });
  sandbox.API.archiveOpen = busyOpenSpy;
  if (openCallsDuringBusy !== 0) {
    console.error('[压缩包红队回归] 任务进行/暂停期间允许打开新压缩包覆盖进度状态');
    process.exit(1);
  }

  // 点击「继续」：恢复执行，隐藏暂停横幅（持久化节点 hidden=true）
  clickBtn(resumeBtn);
  await new Promise((r) => setTimeout(r, 20));
  const pauseBannerAfterResume = findNodes(rootArc, (n) => n.classList && n.classList.contains('arc-pause-banner') && !n.hidden)[0];
  if (resumeCalls !== 1 || pauseBannerAfterResume) {
    console.error(`[压缩包恢复回归] 恢复后状态异常: resumeCalls=${resumeCalls}, banner=${!!pauseBannerAfterResume}`);
    process.exit(1);
  }

  // 点击「取消」：即时切到「取消中…」状态并展示取消清理提示横幅
  const cancelBtn = findNodes(rootArc, (n) => n.tagName === 'BUTTON' && txt(n) === '取消')[0];
  clickBtn(cancelBtn);
  await new Promise((r) => setTimeout(r, 20));
  const cancellingBanner = findNodes(rootArc, (n) => n.classList && n.classList.contains('arc-pause-banner') && n.classList.contains('is-cancelling') && !n.hidden)[0];
  if (cancelCalls !== 1 || !cancellingBanner || !txt(cancellingBanner).includes('正在取消')) {
    console.error(`[压缩包取消回归] 取消中提示缺失: cancelCalls=${cancelCalls}, banner=${txt(cancellingBanner)}`);
    process.exit(1);
  }

  // 模拟后端返回取消错误并退出任务
  if (rejectExtract) rejectExtract(new Error('操作已取消'));
  await new Promise((r) => setTimeout(r, 30));
  const progCard = findNodes(rootArc, (n) => n.classList && n.classList.contains('arc-progress'))[0];
  if (progCard && !progCard.hidden) {
    console.error('[压缩包取消回归] 任务取消结束后进度卡未隐藏');
    process.exit(1);
  }

  if (typeof ret === 'function') ret();
  sandbox.__TAURI__ = origTauri;
  sandbox.API.configGet = origCfgGet;
  sandbox.API.configSet = origCfgSet;
  sandbox.API.archiveOpen = origOpen;
  sandbox.API.archiveExtract = origExtract;
  sandbox.API.archivePause = origPause;
  sandbox.API.archiveResume = origResume;
  sandbox.API.archiveCancel = origCancel;
  await new Promise((r) => setTimeout(r, 220));
  const afterKey = (docListeners.get('keydown') || []).length;
  const afterInt = activeIntervals.size;
  if (afterKey !== beforeKey || afterInt !== beforeInt) {
    console.error(`[压缩包性能回归] unmount 后资源未回收: keydown=${afterKey - beforeKey}, intervals=${afterInt - beforeInt}`);
    process.exit(1);
  }
}

// 回归 9：解压 / 压缩同名冲突提示（直接覆盖 vs 二者并存自动重命名）与安全撤回（防连点 + 0 泄漏）
{
  const txt = (n) => {
    if (!n) return '';
    let s = String(n._textContent || '');
    if (Array.isArray(n.children)) s += n.children.map(txt).join('');
    return s;
  };
  const clickBtn = (btn) => {
    if (!btn) return;
    if (btn.listeners && btn.listeners.click && btn.listeners.click.length) {
      btn.dispatchEvent(new sandbox.Event('click'));
    } else if (typeof btn.onclick === 'function') {
      btn.onclick();
    }
  };
  const rootArc = new FakeElement('div');
  const modalRoot = sandbox.document._byId['modal-root'];
  modalRoot.children = [];
  const origCfgGet = sandbox.API.configGet;
  const origCfgSet = sandbox.API.configSet;
  const origOpen = sandbox.API.archiveOpen;
  const origExtract = sandbox.API.archiveExtract;
  const origCreate = sandbox.API.archiveCreate;
  const origCheckExt = sandbox.API.archiveCheckExtractConflicts;
  const origCheckCre = sandbox.API.archiveCheckCreateConflict;
  const origUndo = sandbox.API.archiveUndo;
  const origDiscard = sandbox.API.archiveUndoDiscard;
  const origPickFiles = sandbox.API.pickFiles;
  const origOpenPath = sandbox.API.openPath;

  let capturedExtract = null;
  let capturedCreate = null;
  const undoCalls = [];
  const discardCalls = [];

  sandbox.API.configGet = async () => ({ archive_mode: 'balanced', archive_extract_dir: 'D:\\下载', archive_extract_open: false, archive_create_dir: 'D:\\下载' });
  sandbox.API.configSet = async () => {};
  sandbox.API.openPath = async () => {};
  sandbox.API.archiveOpen = async (p) => ({
    path: p,
    format: 'ZIP',
    entries: [{ index: 0, name: 'readme.txt', isDir: false, size: 512, packed: 256, modified: '2026-11-23 10:00:00', encrypted: false, crc: 1 }],
    totalSize: 512,
    totalPacked: 256,
    encrypted: false,
    solid: false,
    comment: '',
    needsRar: false,
    rarReady: true
  });
  sandbox.API.archiveCheckExtractConflicts = async () => ({
    hasConflicts: true,
    outDirExists: true,
    outDirIsFile: false,
    suggestedOutDir: 'D:\\下载\\demo (2)',
    fileConflicts: 1,
    dirConflicts: 1,
    samples: [{ name: 'demo', isDir: true }, { name: 'readme.txt', isDir: false }]
  });
  sandbox.API.archiveExtract = async (path, outDir, indices, password, overwrite, mode) => {
    capturedExtract = { path, outDir, indices, overwrite, mode };
    return { files: 1, dirs: 1, bytes: 512, skipped: 0, warnings: [], outDir, undoId: 'u-ext-99', canUndo: true, backupIncomplete: false };
  };
  sandbox.API.pickFiles = async () => ['D:\\下载\\src.txt'];
  sandbox.API.archiveCheckCreateConflict = async () => ({
    exists: true,
    isDir: false,
    size: 2048,
    modified: '2026-11-23 11:00:00',
    suggestedDest: 'D:\\下载\\src (2).zip'
  });
  sandbox.API.archiveCreate = async (sources, dest, format, mode) => {
    capturedCreate = { sources, dest, format, mode };
    return { path: dest, format, files: 1, bytes: 128, packed: 96, elapsedMs: 40, undoId: 'u-cre-99', canUndo: true, backupIncomplete: false, backupBytes: 4096 };
  };
  sandbox.API.archiveUndo = async (undoId) => {
    undoCalls.push(undoId);
    return { op: undoId.includes('cre') ? 'create' : 'extract', removedFiles: 1, removedDirs: 1, restoredFiles: 0, skipped: 0, warnings: [] };
  };
  sandbox.API.archiveUndoDiscard = async (undoId) => {
    discardCalls.push(undoId);
    return true;
  };

  const beforeKey = (docListeners.get('keydown') || []).length;
  const beforeInt = activeIntervals.size;
  const ret = await sandbox.Pages.archive.mount(rootArc);
  await new Promise((r) => setTimeout(r, 30));

  // A: 解压冲突弹窗 -> 选择「二者并存（自动重命名）」-> 应改落到 suggestedOutDir 且策略为 rename
  await sandbox.Pages.archive.jump({ paths: ['D:\\demo.zip'] });
  const extractAllBtn = findNodes(rootArc, (n) => n.tagName === 'BUTTON' && txt(n).includes('解压全部'))[0];
  clickBtn(extractAllBtn);
  const startExtBtn = findNodes(modalRoot, (n) => n.tagName === 'BUTTON' && txt(n).includes('开始解压'))[0];
  clickBtn(startExtBtn);
  await new Promise((r) => setTimeout(r, 30));

  const owBtn = findNodes(modalRoot, (n) => n.tagName === 'BUTTON' && txt(n).includes('直接覆盖'))[0];
  const coexistBtn = findNodes(modalRoot, (n) => n.tagName === 'BUTTON' && txt(n).includes('二者并存'))[0];
  if (!owBtn || !coexistBtn) {
    console.error(`[压缩包冲突回归] 解压冲突弹窗缺少选项按钮: ow=${!!owBtn}, coexist=${!!coexistBtn}`);
    process.exit(1);
  }
  clickBtn(coexistBtn);
  await new Promise((r) => setTimeout(r, 40));
  if (!capturedExtract || capturedExtract.outDir !== 'D:\\下载\\demo (2)' || capturedExtract.overwrite !== 'rename') {
    console.error(`[压缩包冲突回归] 二者并存未正确切到建议目录与重命名策略: ${JSON.stringify(capturedExtract)}`);
    process.exit(1);
  }

  // 关掉完成弹窗，确认解压页顶部出现「撤回解压」（此时暂不撤回，验证后续创建压缩包会令其自动失效，只保留最近 1 次）
  const closeDoneBtn = findNodes(modalRoot, (n) => n.tagName === 'BUTTON' && txt(n) === '关闭').pop();
  if (closeDoneBtn) clickBtn(closeDoneBtn);
  await new Promise((r) => setTimeout(r, 30));
  const undoExtBtnBefore = findNodes(rootArc, (n) => n.tagName === 'BUTTON' && txt(n).includes('撤回解压'))[0];
  if (!undoExtBtnBefore) {
    console.error('[压缩包撤回回归] 解压完成后顶部卡片缺少「撤回解压」按钮');
    process.exit(1);
  }

  // B: 切到「创建压缩包」-> 添加文件 -> 点「开始创建」-> 冲突弹窗选「二者并存」-> 验证改名、跨页单槽撤回联动与收起释放缓存
  const createTab = findNodes(rootArc, (n) => n.tagName === 'BUTTON' && txt(n).includes('创建压缩包'))[0];
  clickBtn(createTab);
  const addFilesBtn = findNodes(rootArc, (n) => n.tagName === 'BUTTON' && txt(n).includes('添加文件'))[0];
  clickBtn(addFilesBtn);
  await new Promise((r) => setTimeout(r, 30));
  const startCreateBtn = findNodes(rootArc, (n) => n.tagName === 'BUTTON' && txt(n).includes('开始创建'))[0];
  clickBtn(startCreateBtn);
  await new Promise((r) => setTimeout(r, 30));

  const createCoexistBtn = findNodes(modalRoot, (n) => n.tagName === 'BUTTON' && txt(n).includes('二者并存')).pop();
  if (!createCoexistBtn) {
    console.error('[压缩包冲突回归] 压缩冲突弹窗未弹出「二者并存」选项');
    process.exit(1);
  }
  clickBtn(createCoexistBtn);
  await new Promise((r) => setTimeout(r, 40));
  if (!capturedCreate || capturedCreate.dest !== 'D:\\下载\\src (2).zip') {
    console.error(`[压缩包冲突回归] 压缩二者并存未切换到 suggestedDest: ${JSON.stringify(capturedCreate)}`);
    process.exit(1);
  }

  const closeCreateDone = findNodes(modalRoot, (n) => n.tagName === 'BUTTON' && txt(n) === '关闭').pop();
  if (closeCreateDone) clickBtn(closeCreateDone);
  await new Promise((r) => setTimeout(r, 30));

  // 红队单槽校验：压缩完成后（u-cre-99 成为唯一可撤回项），旧解压卡片上的「撤回解压」必须自动消失，且创建卡片显示备份体积
  const staleUndoExtBtn = findNodes(rootArc, (n) => n.tagName === 'BUTTON' && txt(n).includes('撤回解压'))[0];
  if (staleUndoExtBtn) {
    console.error('[压缩包单槽撤回回归] 新压缩完成后旧解压卡片仍残留过期的「撤回解压」按钮');
    process.exit(1);
  }
  const createCardText = txt(findNodes(rootArc, (n) => n.classList && n.classList.contains('arc-last-card')).pop());
  if (!createCardText.includes('撤回备份')) {
    console.error(`[压缩包单槽撤回回归] 覆盖备份体积未展示在状态卡上: ${createCardText}`);
    process.exit(1);
  }

  // 点击创建卡片的「收起」按钮：必须触发 archiveUndoDiscard('u-cre-99') 立即释放磁盘缓存
  const dismissCreateBtn = findNodes(rootArc, (n) => n.tagName === 'BUTTON' && typeof n.getAttribute === 'function' && n.getAttribute('aria-label') === '收起').pop();
  if (!dismissCreateBtn) {
    console.error('[压缩包单槽撤回回归] 创建状态卡缺少收起按钮');
    process.exit(1);
  }
  clickBtn(dismissCreateBtn);
  await new Promise((r) => setTimeout(r, 20));
  if (discardCalls.length !== 1 || discardCalls[0] !== 'u-cre-99') {
    console.error(`[压缩包单槽撤回回归] 收起卡片未触发 archiveUndoDiscard 释放备份: ${JSON.stringify(discardCalls)}`);
    process.exit(1);
  }

  // C: 再做一次解压并执行真实撤回（验证撤回按钮完整闭环 + 防连点）
  const openTab = findNodes(rootArc, (n) => n.tagName === 'BUTTON' && txt(n).includes('浏览与解压'))[0];
  if (openTab) clickBtn(openTab);
  clickBtn(extractAllBtn);
  const startExtBtn2 = findNodes(modalRoot, (n) => n.tagName === 'BUTTON' && txt(n).includes('开始解压')).pop();
  clickBtn(startExtBtn2);
  await new Promise((r) => setTimeout(r, 30));
  const coexistBtn2 = findNodes(modalRoot, (n) => n.tagName === 'BUTTON' && txt(n).includes('二者并存')).pop();
  clickBtn(coexistBtn2);
  await new Promise((r) => setTimeout(r, 40));
  const closeDoneBtn2 = findNodes(modalRoot, (n) => n.tagName === 'BUTTON' && txt(n) === '关闭').pop();
  if (closeDoneBtn2) clickBtn(closeDoneBtn2);
  await new Promise((r) => setTimeout(r, 30));
  const undoExtBtn2 = findNodes(rootArc, (n) => n.tagName === 'BUTTON' && txt(n).includes('撤回解压'))[0];
  if (!undoExtBtn2) {
    console.error('[压缩包撤回回归] 二次解压后缺少「撤回解压」按钮');
    process.exit(1);
  }
  clickBtn(undoExtBtn2);
  await new Promise((r) => setTimeout(r, 30));
  const revertedExtBtn = findNodes(rootArc, (n) => n.tagName === 'BUTTON' && txt(n).includes('已撤回'))[0];
  if (undoCalls.length !== 1 || undoCalls[0] !== 'u-ext-99' || !revertedExtBtn) {
    console.error(`[压缩包撤回回归] 解压撤回状态异常: calls=${JSON.stringify(undoCalls)}, reverted=${!!revertedExtBtn}`);
    process.exit(1);
  }

  if (typeof ret === 'function') ret();
  sandbox.API.configGet = origCfgGet;
  sandbox.API.configSet = origCfgSet;
  sandbox.API.archiveOpen = origOpen;
  sandbox.API.archiveExtract = origExtract;
  sandbox.API.archiveCreate = origCreate;
  sandbox.API.archiveCheckExtractConflicts = origCheckExt;
  sandbox.API.archiveCheckCreateConflict = origCheckCre;
  sandbox.API.archiveUndo = origUndo;
  sandbox.API.archiveUndoDiscard = origDiscard;
  sandbox.API.pickFiles = origPickFiles;
  sandbox.API.openPath = origOpenPath;
  await new Promise((r) => setTimeout(r, 220));
  const afterKey = (docListeners.get('keydown') || []).length;
  const afterInt = activeIntervals.size;
  if (afterKey !== beforeKey || afterInt !== beforeInt) {
    console.error(`[压缩包冲突撤回回归] unmount 后资源未回收: keydown=${afterKey - beforeKey}, intervals=${afterInt - beforeInt}`);
    process.exit(1);
  }
}

// 回归 10：压缩包能力发现动态核心文案、getCapabilities 深拷贝隔离、生命周期钩子异常隔离与 off 解绑
{
  const txt = (n) => {
    if (!n) return '';
    let s = String(n._textContent || '');
    if (Array.isArray(n.children)) s += n.children.map(txt).join('');
    return s;
  };
  const clickBtn = (btn) => {
    if (!btn) return;
    if (btn.listeners && btn.listeners.click && btn.listeners.click.length) {
      btn.dispatchEvent(new sandbox.Event('click'));
    } else if (typeof btn.onclick === 'function') {
      btn.onclick();
    }
  };
  const rootArc = new FakeElement('div');
  const modalRoot = sandbox.document._byId['modal-root'];
  modalRoot.children = [];
  const origCfgGet = sandbox.API.configGet;
  const origCfgSet = sandbox.API.configSet;
  const origCaps = sandbox.API.archiveCapabilities;
  const origOpen = sandbox.API.archiveOpen;
  const origCheckExt = sandbox.API.archiveCheckExtractConflicts;
  const origExtract = sandbox.API.archiveExtract;
  const origOpenPath = sandbox.API.openPath;

  sandbox.API.configGet = async () => ({ archive_mode: 'balanced', archive_extract_dir: 'D:\\下载', archive_extract_open: false });
  sandbox.API.configSet = async () => {};
  sandbox.API.openPath = async () => {};
  sandbox.API.archiveCapabilities = async () => ({
    schemaVersion: 1,
    cpuCores: 12,
    formats: [{ id: 'zip', label: 'ZIP', canRead: true, canExtract: true, canCreate: true }],
    modes: [
      { id: 'saver', threads: 1, ioDutyPct: 25, cpuDutyPct: 35, smartStore: false },
      { id: 'balanced', threads: 4, ioDutyPct: 50, cpuDutyPct: 65, smartStore: false },
      { id: 'performance', threads: 8, ioDutyPct: 75, cpuDutyPct: 85, smartStore: true },
      { id: 'hyper', threads: 12, ioDutyPct: 100, cpuDutyPct: 100, smartStore: true }
    ],
    limits: { maxUndoRecords: 1, maxEntries: 500000 },
    rarReady: true
  });
  sandbox.API.archiveOpen = async (p) => ({
    path: p,
    format: 'ZIP',
    entries: [{ index: 0, name: 'a.txt', isDir: false, size: 128, packed: 64, modified: '2026-11-23 12:00:00', encrypted: false, crc: 1 }],
    totalSize: 128,
    totalPacked: 64,
    encrypted: false,
    solid: false,
    comment: '',
    needsRar: false,
    rarReady: true
  });
  sandbox.API.archiveCheckExtractConflicts = async () => ({
    hasConflicts: false, outDirExists: false, outDirIsFile: false, suggestedOutDir: 'D:\\下载\\demo', fileConflicts: 0, dirConflicts: 0, samples: []
  });
  sandbox.API.archiveExtract = async (path, outDir) => ({
    files: 1, dirs: 0, bytes: 128, skipped: 0, warnings: [], outDir, undoId: 'u-hook-1', canUndo: true, backupIncomplete: false, backupBytes: 0
  });

  const received = [];
  const capEvents = [];
  const throwingHook = () => { throw new Error('故意抛错的第三方钩子'); };
  const okHook = (rep) => { received.push(rep && rep.undoId); };
  const unsubCap = sandbox.Pages.archive.on('capabilities:ready', (c) => capEvents.push(c && c.cpuCores));
  const unsubThrow = sandbox.Pages.archive.on('extract:done', throwingHook);
  sandbox.Pages.archive.on('extract:done', okHook);

  const beforeKey = (docListeners.get('keydown') || []).length;
  const beforeInt = activeIntervals.size;
  const ret = await sandbox.Pages.archive.mount(rootArc);
  await new Promise((r) => setTimeout(r, 30));

  // 1. 校验四档动态核心文案按 12 核后端能力渲染
  const modeCards = findNodes(rootArc, (n) => n.classList && n.classList.contains('arc-mode')).map(txt);
  if (!modeCards.some((s) => s.includes('1 核')) || !modeCards.some((s) => s.includes('4 核')) || !modeCards.some((s) => s.includes('8 核')) || !modeCards.some((s) => s.includes('12 核满核'))) {
    console.error(`[压缩包扩展回归] 模式卡片未按后端 12 核能力动态渲染: ${JSON.stringify(modeCards)}`);
    process.exit(1);
  }
  if (capEvents.length !== 1 || capEvents[0] !== 12) {
    console.error(`[压缩包扩展回归] capabilities:ready 钩子未触发或数据不对: ${JSON.stringify(capEvents)}`);
    process.exit(1);
  }

  // 2. 校验 getCapabilities() 深拷贝隔离（外部篡改不得污染内部状态）
  const snap1 = sandbox.Pages.archive.getCapabilities();
  snap1.modes[0].threads = 999;
  snap1.limits.maxEntries = 0;
  const snap2 = sandbox.Pages.archive.getCapabilities();
  if (!snap2 || snap2.modes[0].threads !== 1 || snap2.limits.maxEntries !== 500000) {
    console.error(`[压缩包扩展回归] getCapabilities() 未深拷贝隔离外部修改: ${JSON.stringify(snap2)}`);
    process.exit(1);
  }

  // 3. 校验异常钩子隔离 + 正常钩子触发 + off() 生效
  await sandbox.Pages.archive.jump({ paths: ['D:\\demo.zip'] });
  const extractBtn = findNodes(rootArc, (n) => n.tagName === 'BUTTON' && txt(n).includes('解压全部'))[0];
  clickBtn(extractBtn);
  const startBtn = findNodes(modalRoot, (n) => n.tagName === 'BUTTON' && txt(n).includes('开始解压')).pop();
  clickBtn(startBtn);
  await new Promise((r) => setTimeout(r, 40));
  if (received.length !== 1 || received[0] !== 'u-hook-1') {
    console.error(`[压缩包扩展回归] 异常钩子阻断了正常 extract:done 钩子执行: ${JSON.stringify(received)}`);
    process.exit(1);
  }
  const closeDone = findNodes(modalRoot, (n) => n.tagName === 'BUTTON' && txt(n) === '关闭').pop();
  if (closeDone) clickBtn(closeDone);
  await new Promise((r) => setTimeout(r, 30));

  unsubCap();
  unsubThrow();
  sandbox.Pages.archive.off('extract:done', okHook);
  clickBtn(extractBtn);
  const startBtn2 = findNodes(modalRoot, (n) => n.tagName === 'BUTTON' && txt(n).includes('开始解压')).pop();
  clickBtn(startBtn2);
  await new Promise((r) => setTimeout(r, 40));
  if (received.length !== 1) {
    console.error(`[压缩包扩展回归] off() 解绑后钩子仍被触发: ${JSON.stringify(received)}`);
    process.exit(1);
  }
  const closeDone2 = findNodes(modalRoot, (n) => n.tagName === 'BUTTON' && txt(n) === '关闭').pop();
  if (closeDone2) clickBtn(closeDone2);
  await new Promise((r) => setTimeout(r, 30));

  if (typeof ret === 'function') ret();
  sandbox.API.configGet = origCfgGet;
  sandbox.API.configSet = origCfgSet;
  sandbox.API.archiveCapabilities = origCaps;
  sandbox.API.archiveOpen = origOpen;
  sandbox.API.archiveCheckExtractConflicts = origCheckExt;
  sandbox.API.archiveExtract = origExtract;
  sandbox.API.openPath = origOpenPath;
  await new Promise((r) => setTimeout(r, 220));
  const afterKey = (docListeners.get('keydown') || []).length;
  const afterInt = activeIntervals.size;
  if (afterKey !== beforeKey || afterInt !== beforeInt) {
    console.error(`[压缩包扩展回归] unmount 后资源未回收: keydown=${afterKey - beforeKey}, intervals=${afterInt - beforeInt}`);
    process.exit(1);
  }
}

// 回归 11：应用外壳 app.js 极速切页异步 _unmount 竞态防泄漏 + App.registerPage / App.on 扩展体系
{
  const appCode = fs.readFileSync(path.join(root, 'src/web/js/app.js'), 'utf8');
  const pageEl = new FakeElement('div');
  pageEl.id = 'page';
  sandbox.document._byId['page'] = pageEl;
  const titleEl = new FakeElement('div');
  titleEl.id = 'page-title';
  sandbox.document._byId['page-title'] = titleEl;
  const subEl = new FakeElement('div');
  subEl.id = 'page-sub';
  sandbox.document._byId['page-sub'] = subEl;
  const navEl = new FakeElement('div');
  navEl.id = 'nav';
  sandbox.document._byId['nav'] = navEl;
  const origApp = sandbox.App;
  const origNav = sandbox.navigate;
  const origCfgSet = sandbox.API.configSet;
  sandbox.API.configSet = async () => {};
  sandbox.history = sandbox.history || { replaceState() {} };
  sandbox.location = sandbox.location || { hash: '' };
  sandbox.matchMedia = () => ({ matches: true });
  vm.runInContext(appCode, sandbox, { filename: 'app.js' });

  // 1. 内置页面防覆盖/防注销校验
  let blockedBuiltinPage = false;
  try { sandbox.App.registerPage({ id: 'organize', zh: '伪造' }, { mount: () => {} }, { overwrite: true }); } catch { blockedBuiltinPage = true; }
  let blockedBuiltinUnreg = false;
  try { sandbox.App.unregisterPage('organize'); } catch { blockedBuiltinUnreg = true; }
  if (!blockedBuiltinPage || !blockedBuiltinUnreg) {
    console.error('[外壳扩展回归] 未拦截对内置页面的覆盖或注销');
    process.exit(1);
  }

  // 2. 极速切页异步竞态：ext_slow 挂载未完时切去 ext_fast，随后 ext_slow resolve 必须立刻卸载且不得覆盖 ext_fast 的 _unmount
  let releaseSlow = null;
  let slowUnmounted = 0;
  let fastUnmounted = 0;
  const mountedEvents = [];
  const unsubThrow = sandbox.App.on('page:mounted', () => { throw new Error('故意抛错的扩展钩子'); });
  const unsubOk = sandbox.App.on('page:mounted', (ev) => mountedEvents.push(ev && ev.id));

  const unregSlow = sandbox.App.registerPage({ id: 'ext_slow', zh: '慢扩展页', en: 'Slow' }, {
    title: ['慢扩展页', 'Slow'],
    mount: () => new Promise((res) => { releaseSlow = () => res(() => { slowUnmounted++; }); })
  });
  const unregFast = sandbox.App.registerPage({ id: 'ext_fast', zh: '快扩展页', en: 'Fast' }, {
    title: ['快扩展页', 'Fast'],
    mount: () => () => { fastUnmounted++; }
  });
  if (!sandbox.App.listPages().some((p) => p.id === 'ext_slow' && p.builtin === false)) {
    console.error('[外壳扩展回归] registerPage 未写入 listPages');
    process.exit(1);
  }

  const pSlow = sandbox.navigate('ext_slow', false, { force: true });
  await new Promise((r) => setTimeout(r, 10));
  await sandbox.navigate('ext_fast', false, { force: true });
  if (releaseSlow) releaseSlow();
  await pSlow;

  if (slowUnmounted !== 1 || fastUnmounted !== 0 || sandbox.App._mountedId !== 'ext_fast') {
    console.error(`[外壳竞态回归] 过期慢页未立即卸载或覆盖了当前页: slowUnmounted=${slowUnmounted}, fastUnmounted=${fastUnmounted}, mounted=${sandbox.App._mountedId}`);
    process.exit(1);
  }
  if (!mountedEvents.includes('ext_fast') || mountedEvents.includes('ext_slow')) {
    console.error(`[外壳钩子回归] page:mounted 事件触发异常: ${JSON.stringify(mountedEvents)}`);
    process.exit(1);
  }

  // 切走 ext_fast 必须触发 fastUnmounted === 1（证明 _unmount 没被 ext_slow 踩掉）
  const pSlow2 = sandbox.navigate('ext_slow', false, { force: true });
  await new Promise((r) => setTimeout(r, 10));
  if (releaseSlow) releaseSlow();
  await pSlow2;
  if (fastUnmounted !== 1) {
    console.error(`[外壳竞态回归] fastUnmounted=${fastUnmounted}，证明 App._unmount 被过期慢页覆盖泄漏`);
    process.exit(1);
  }

  unsubThrow();
  unsubOk();
  unregSlow();
  unregFast();
  if (sandbox.App.listPages().some((p) => p.id === 'ext_slow' || p.id === 'ext_fast')) {
    console.error('[外壳扩展回归] unregisterPage 未从导航列表移除');
    process.exit(1);
  }
  if (sandbox.App._enterTimer) clearTimeout(sandbox.App._enterTimer);
  sandbox.API.configSet = origCfgSet;
  sandbox.App = origApp;
  sandbox.navigate = origNav;
}

// 回归 12：设置页「版本与在线更新」全链路（检查更新 / 持久进度流取消按钮不重建 / 校验就绪安装 / 卸载 0 泄漏）
{
  const txt = (n) => {
    if (!n) return '';
    let s = String(n._textContent || '');
    if (Array.isArray(n.children)) s += n.children.map(txt).join('');
    return s;
  };
  const clickBtn = (btn) => {
    if (!btn) return;
    if (btn.listeners && btn.listeners.click && btn.listeners.click.length) {
      btn.dispatchEvent(new sandbox.Event('click'));
    } else if (typeof btn.onclick === 'function') {
      btn.onclick();
    }
  };
  const rootSet = new FakeElement('div');
  const modalRoot = sandbox.document._byId['modal-root'];
  modalRoot.children = [];
  const eventHandlers = new Map();
  const origTauri = sandbox.__TAURI__;
  const origStatus = sandbox.API.updaterStatus;
  const origCfgSetU = sandbox.API.updaterConfigSet;
  const origCheck = sandbox.API.updaterCheck;
  const origDownload = sandbox.API.updaterDownload;
  const origCancel = sandbox.API.updaterCancel;
  const origInstall = sandbox.API.updaterInstall;

  let cancelCalls = 0;
  let installCalls = 0;
  let rejectDl = null;
  let resolveDl = null;
  let dlCount = 0;
  const fakeSha = 'a'.repeat(64);

  sandbox.__TAURI__ = Object.assign({}, origTauri || {}, {
    event: {
      listen: async (name, fn) => {
        eventHandlers.set(name, fn);
        return () => eventHandlers.delete(name);
      }
    }
  });
  sandbox.API.updaterStatus = async () => ({
    currentVersion: '1.43.13',
    installKind: 'portable',
    busy: false,
    releasesPage: 'https://github.com/3347567186/QDisk/releases',
    config: {
      channel: 'stable',
      autoCheck: true,
      ignoredVersion: '',
      lastCheckAt: ''
    },
    updatesDir: 'D:\\data\\updates',
    cacheBytes: 0,
    staged: null
  });
  sandbox.API.updaterConfigSet = async (p) => Object.assign({
    channel: 'stable',
    autoCheck: true,
    ignoredVersion: '',
    lastCheckAt: ''
  }, p || {});
  sandbox.API.updaterCheck = async () => ({
    currentVersion: '1.43.13',
    latestVersion: '9.9.9',
    hasUpdate: true,
    isIgnored: false,
    isPrerelease: false,
    installKind: 'portable',
    packageKind: 'portable',
    channel: 'stable',
    pubDate: '2026-11-23',
    notes: '红队验证版本更新说明',
    downloadUrl: 'https://github.com/3347567186/QDisk/releases/download/v9.9.9/app.zip',
    fileName: '整理助手_9.9.9_便携版.zip',
    size: 25 * 1024 * 1024,
    sha256: fakeSha,
    manifestUrl: 'https://github.com/3347567186/QDisk/releases/latest/download/latest.json',
    staged: null
  });
  sandbox.API.updaterDownload = () => new Promise((res, rej) => {
    dlCount++;
    resolveDl = res;
    rejectDl = rej;
  });
  sandbox.API.updaterCancel = async () => { cancelCalls++; return true; };
  sandbox.API.updaterInstall = async () => { installCalls++; return true; };

  const beforeInt = activeIntervals.size;
  const ret = await sandbox.Pages.settings.mount(rootSet);
  sandbox.Pages.settings.jump({ section: 'updater' });
  await new Promise((r) => setTimeout(r, 20));

  const checkBtn = findNodes(rootSet, (n) => n.tagName === 'BUTTON' && txt(n).includes('检查更新'))[0];
  const urlInputs = findNodes(rootSet, (n) => n.tagName === 'INPUT' && (n.type === 'url' || (n.classList && n.classList.contains('upd-feed-input'))));
  const saveFeedBtn = findNodes(rootSet, (n) => n.tagName === 'BUTTON' && txt(n).includes('保存源'))[0];
  if (urlInputs.length > 0 || saveFeedBtn) {
    console.error(`[在线更新回归] 设置页不得出现填网址功能: urlInputs=${urlInputs.length}, saveFeedBtn=${!!saveFeedBtn}`);
    process.exit(1);
  }
  if (!checkBtn) {
    console.error('[在线更新回归] 设置页缺少「检查更新」按钮');
    process.exit(1);
  }
  const segBtns = findNodes(rootSet, (n) => n.tagName === 'BUTTON' && n.classList && n.classList.contains('upd-seg-btn'));
  if (segBtns.length !== 2 || !txt(segBtns[0]).includes('稳定版') || !txt(segBtns[1]).includes('测试版')) {
    console.error(`[在线更新回归] 设置页缺少融合的「稳定版 / 测试版」切换控件: count=${segBtns.length}`);
    process.exit(1);
  }
  let lastSavedCh = 'stable';
  const origCfgSetSnap = sandbox.API.updaterConfigSet;
  sandbox.API.updaterConfigSet = async (p) => {
    if (p && p.channel) lastSavedCh = p.channel;
    return origCfgSetSnap(p);
  };
  const origStatusSnap = sandbox.API.updaterStatus;
  sandbox.API.updaterStatus = async () => {
    const base = await origStatusSnap();
    base.config.channel = lastSavedCh;
    return base;
  };
  clickBtn(segBtns[1]);
  await new Promise((r) => setTimeout(r, 20));
  const segAfterBeta = findNodes(rootSet, (n) => n.tagName === 'BUTTON' && n.classList && n.classList.contains('upd-seg-btn'));
  if (lastSavedCh !== 'beta' || !segAfterBeta[1].classList.contains('active')) {
    console.error(`[在线更新回归] 切换融合「测试版」通道失败: ch=${lastSavedCh}`);
    process.exit(1);
  }
  clickBtn(segAfterBeta[0]);
  await new Promise((r) => setTimeout(r, 20));
  const checkBtnNow = findNodes(rootSet, (n) => n.tagName === 'BUTTON' && txt(n).includes('检查更新'))[0];
  clickBtn(checkBtnNow || checkBtn);
  await new Promise((r) => setTimeout(r, 30));

  const dlBtn = findNodes(rootSet, (n) => n.tagName === 'BUTTON' && txt(n).includes('下载更新包'))[0];
  const notesBtn = findNodes(rootSet, (n) => n.tagName === 'BUTTON' && txt(n).includes('更新内容'))[0];
  const inlineRawPre = findNodes(rootSet, (n) => n.tagName === 'PRE' && n.classList && n.classList.contains('upd-notes'));
  if (!dlBtn || !notesBtn || inlineRawPre.length > 0 || !txt(rootSet).includes('v9.9.9') || !txt(rootSet).includes('红队验证版本更新说明')) {
    console.error(`[在线更新回归] 检查更新后卡片简化或更新内容入口异常: dl=${!!dlBtn}, notesBtn=${!!notesBtn}, rawPre=${inlineRawPre.length}`);
    process.exit(1);
  }
  // 点击「更新内容」必须打开独立卡片时间轴窗口展示，且点击「知道了」彻底清理
  clickBtn(notesBtn);
  await new Promise((r) => setTimeout(r, 15));
  const notesFeed = findNodes(modalRoot, (n) => n.classList && n.classList.contains('cl-feed'))[0];
  if (!notesFeed || !txt(modalRoot).includes('更新内容') || !txt(modalRoot).includes('v9.9.9')) {
    console.error('[在线更新回归] 点击「更新内容」未打开独立更新内容弹窗');
    process.exit(1);
  }
  const closeNotesBtn = findNodes(modalRoot, (n) => n.tagName === 'BUTTON' && txt(n) === '知道了').pop();
  if (closeNotesBtn) clickBtn(closeNotesBtn);
  await new Promise((r) => setTimeout(r, 15));

  // 开始下载并推送 5 帧高频进度：取消下载按钮必须保持同一 DOM 节点引用（防点击被吞）
  clickBtn(dlBtn);
  await new Promise((r) => setTimeout(r, 15));
  const cancelBtn1 = findNodes(rootSet, (n) => n.tagName === 'BUTTON' && txt(n) === '取消下载')[0];
  const emitUpd = eventHandlers.get('updater-progress');
  if (!cancelBtn1 || !emitUpd) {
    console.error('[在线更新回归] 下载中缺少持久化取消按钮或 updater-progress 监听');
    process.exit(1);
  }
  for (let i = 1; i <= 5; i++) {
    emitUpd({ payload: { phase: 'downloading', downloaded: i * 3 * 1024 * 1024, total: 25 * 1024 * 1024, speedBps: 5 * 1024 * 1024, percent: i * 12, version: '9.9.9' } });
  }
  const cancelBtn2 = findNodes(rootSet, (n) => n.tagName === 'BUTTON' && txt(n) === '取消下载')[0];
  const progMeta = findNodes(rootSet, (n) => n.classList && n.classList.contains('upd-prog-meta'))[0];
  if (cancelBtn2 !== cancelBtn1 || !progMeta || !txt(progMeta).includes('60%')) {
    console.error(`[在线更新回归] 高频进度流重建了取消按钮或未更新进度: same=${cancelBtn2 === cancelBtn1}, meta=${txt(progMeta)}`);
    process.exit(1);
  }
  clickBtn(cancelBtn2);
  await new Promise((r) => setTimeout(r, 15));
  if (cancelCalls !== 1) {
    console.error('[在线更新回归] 点击取消下载未触发 API.updaterCancel');
    process.exit(1);
  }
  if (rejectDl) rejectDl(new Error('已取消更新下载'));
  await new Promise((r) => setTimeout(r, 25));

  // 二次下载成功 -> 出现「立即重启并安装更新」按钮 -> 二次确认后调用 updaterInstall
  const dlBtn2 = findNodes(rootSet, (n) => n.tagName === 'BUTTON' && txt(n).includes('下载更新包'))[0];
  clickBtn(dlBtn2);
  await new Promise((r) => setTimeout(r, 15));
  if (resolveDl) resolveDl({
    version: '9.9.9',
    packageKind: 'portable',
    fileName: '整理助手_9.9.9_便携版.zip',
    path: 'D:\\data\\updates\\v9.9.9\\整理助手_9.9.9_便携版.zip',
    size: 25 * 1024 * 1024,
    sha256: fakeSha
  });
  await new Promise((r) => setTimeout(r, 30));
  const instBtn = findNodes(rootSet, (n) => n.tagName === 'BUTTON' && txt(n).includes('立即重启并安装更新'))[0];
  if (!instBtn || dlCount !== 2) {
    console.error('[在线更新回归] 下载校验完成后未出现安装按钮');
    process.exit(1);
  }
  clickBtn(instBtn);
  await new Promise((r) => setTimeout(r, 15));
  const confirmInst = findNodes(modalRoot, (n) => n.tagName === 'BUTTON' && txt(n).includes('立即重启更新')).pop();
  clickBtn(confirmInst);
  await new Promise((r) => setTimeout(r, 25));
  if (installCalls !== 1) {
    console.error(`[在线更新回归] 确认安装未触发 API.updaterInstall: calls=${installCalls}`);
    process.exit(1);
  }

  if (typeof ret === 'function') ret();
  if (eventHandlers.has('updater-progress') || activeIntervals.size !== beforeInt) {
    console.error('[在线更新回归] unmount 后未回收 updater-progress 监听或定时器');
    process.exit(1);
  }
  sandbox.__TAURI__ = origTauri;
  sandbox.API.updaterStatus = origStatus;
  sandbox.API.updaterConfigSet = origCfgSetU;
  sandbox.API.updaterCheck = origCheck;
  sandbox.API.updaterDownload = origDownload;
  sandbox.API.updaterCancel = origCancel;
  sandbox.API.updaterInstall = origInstall;
}

/* ==================== 回归 13：AI 切换权限模式不进虚假思考态 + 对话暂停即时生效与紧接重发 ==================== */
{
  const txt = (n) => {
    if (!n) return '';
    let s = String(n._textContent || '');
    if (Array.isArray(n.children)) s += n.children.map(txt).join('');
    return s;
  };
  const clickBtn = (btn) => {
    if (!btn) return;
    if (btn.listeners && btn.listeners.click && btn.listeners.click.length) {
      btn.dispatchEvent(new sandbox.Event('click'));
    } else if (typeof btn.onclick === 'function') {
      btn.onclick();
    }
  };
  const rootAi = new FakeElement('div');
  const origCfgGetAi = sandbox.API.configGet;
  const origStore = sandbox.API.aiStore;
  const origHttp = sandbox.API.aiHttp;
  const origHttpStream = sandbox.API.aiHttpStream;
  const origCancel = sandbox.API.aiCancel;

  const storeMem = new Map();
  let cancelCalls = 0;
  let httpCalls = 0;
  let httpMode = 'hang';

  sandbox.API.configGet = async () => ({
    ai: {
      enabled: true,
      endpoint: 'http://127.0.0.1:11434/v1/chat/completions',
      key: 'sk-selftest',
      model: 'test-model',
      models: ['test-model']
    }
  });
  sandbox.API.aiStore = async (op, name, content) => {
    if (op === 'read') return storeMem.has(name) ? storeMem.get(name) : null;
    if (op === 'write') { storeMem.set(name, String(content || '')); return true; }
    if (op === 'list') return Array.from(storeMem.keys()).filter((k) => k.startsWith('session_'));
    if (op === 'delete') { storeMem.delete(name); return true; }
    return null;
  };
  sandbox.API.aiCancel = async () => { cancelCalls += 1; return true; };
  sandbox.API.aiHttpStream = null;
  sandbox.API.aiHttp = async () => {
    httpCalls += 1;
    if (httpMode === 'hang') {
      return new Promise(() => {});
    }
    return {
      status: 200,
      body: JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ answer: '第二轮正常回答。' }) } }],
        usage: { prompt_tokens: 100, completion_tokens: 20 }
      })
    };
  };

  const retAi = await sandbox.Pages.ai.mount(rootAi);
  if (sandbox.AIStore && sandbox.AIStore.load) await sandbox.AIStore.load(true);
  await new Promise((r) => setTimeout(r, 40));

  // 1) 打开「动手档位」菜单（只读/确认/自动/放手）并依次切换 -> 绝不能凭空生成任何「思考中」气泡或转圈
  const modeBtn = findNodes(rootAi, (n) => n.classList && n.classList.contains('dac-agent-mode'))[0];
  if (!modeBtn) {
    console.error('[AI 权限切换回归] 未找到权限档位按钮 .dac-agent-mode');
    process.exit(1);
  }
  const allDocNodes = () => [rootAi, sandbox.document.body];
  const findAll = (pred) => allDocNodes().flatMap((r) => findNodes(r, pred));

  clickBtn(modeBtn);
  const autoRow = findAll((n) => n.classList && n.classList.contains('dac-perm-row') && n.dataset && n.dataset.mode === 'auto')[0];
  const fullRow = findAll((n) => n.classList && n.classList.contains('dac-perm-row') && n.dataset && n.dataset.mode === 'full')[0];
  if (!autoRow || !fullRow) {
    console.error('[AI 权限切换回归] 权限菜单缺少「自动」或「放手」选项');
    process.exit(1);
  }
  clickBtn(autoRow);
  await new Promise((r) => setTimeout(r, 20));
  const runningAfterAuto = findNodes(rootAi, (n) => n.classList && n.classList.contains('pg') && n.hasAttribute && n.hasAttribute('data-running'));
  const botBubblesAfterAuto = findNodes(rootAi, (n) => n.classList && n.classList.contains('ai-msg') && n.classList.contains('bot'));
  if (runningAfterAuto.length !== 0 || botBubblesAfterAuto.length !== 0) {
    console.error(`[AI 权限切换回归] 切换到「自动」后误触发了虚假思考气泡: running=${runningAfterAuto.length}, bots=${botBubblesAfterAuto.length}`);
    process.exit(1);
  }

  clickBtn(modeBtn);
  clickBtn(fullRow);
  await new Promise((r) => setTimeout(r, 20));
  const runningAfterFull = findNodes(rootAi, (n) => n.classList && n.classList.contains('pg') && n.hasAttribute && n.hasAttribute('data-running'));
  const botBubblesAfterFull = findNodes(rootAi, (n) => n.classList && n.classList.contains('ai-msg') && n.classList.contains('bot'));
  if (runningAfterFull.length !== 0 || botBubblesAfterFull.length !== 0) {
    console.error(`[AI 权限切换回归] 切换到「放手」后误触发了虚假思考气泡: running=${runningAfterFull.length}, bots=${botBubblesAfterFull.length}`);
    process.exit(1);
  }

  // 验证 Escape 与点菜单外侧均可正确收起 modeMenu（之前遗漏了 modeMorph）
  clickBtn(modeBtn);
  const modeMenuEl = autoRow.parentNode && autoRow.parentNode.parentNode && autoRow.parentNode.parentNode.parentNode && autoRow.parentNode.parentNode.parentNode.parentNode;
  if (!modeMenuEl || modeMenuEl.hidden) {
    console.error('[AI 权限切换回归] 点击按钮后 modeMenu 未打开');
    process.exit(1);
  }
  const fireDoc = (type, extra) => {
    const ev = Object.assign(new sandbox.Event(type), { preventDefault() {}, stopPropagation() {} }, extra || {});
    (docListeners.get(type) || []).slice().forEach((fn) => fn(ev));
  };
  fireDoc('keydown', { key: 'Escape' });
  if (modeBtn.getAttribute('aria-expanded') !== 'false') {
    console.error('[AI 权限切换回归] 按 Escape 未关闭权限档位菜单');
    process.exit(1);
  }
  clickBtn(modeBtn);
  if (modeBtn.getAttribute('aria-expanded') !== 'true') {
    console.error('[AI 权限切换回归] 二次打开权限档位菜单失败');
    process.exit(1);
  }
  fireDoc('mousedown', { target: sandbox.document.body });
  if (modeBtn.getAttribute('aria-expanded') !== 'false') {
    console.error('[AI 权限切换回归] 点击外部未关闭权限档位菜单');
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 170));
  if (!modeMenuEl.hidden) {
    console.error('[AI 权限切换回归] 淡出后 modeMenu 仍未 hidden');
    process.exit(1);
  }

  // 2) 发起一轮挂起的 AI 对话 -> 点击停止按钮 -> 必须在 < 100ms 内停住、调用 aiCancel、清除转圈并恢复发送态
  const inputEl = findNodes(rootAi, (n) => n.classList && n.classList.contains('dac-input'))[0];
  const sendBtn = findNodes(rootAi, (n) => n.classList && n.classList.contains('dac-send'))[0];
  if (!inputEl || !sendBtn) {
    console.error('[AI 停止回归] 未找到输入框或发送/停止按钮');
    process.exit(1);
  }
  inputEl.value = '帮我看看下载目录';
  inputEl.dispatchEvent(new sandbox.Event('input'));
  clickBtn(sendBtn);
  await new Promise((r) => setTimeout(r, 35));
  if (sendBtn.getAttribute('data-state') !== 'stop') {
    console.error(`[AI 停止回归] 对话进行中按钮未切到 stop 态: state=${sendBtn.getAttribute('data-state')}`);
    process.exit(1);
  }
  const stopT0 = Date.now();
  clickBtn(sendBtn);
  await new Promise((r) => setTimeout(r, 45));
  const stopDt = Date.now() - stopT0;
  const runningAfterStop = findNodes(rootAi, (n) => n.classList && n.classList.contains('pg') && n.hasAttribute && n.hasAttribute('data-running'));
  if (cancelCalls < 1 || runningAfterStop.length !== 0 || sendBtn.getAttribute('data-state') === 'stop' || !txt(rootAi).includes('已停止')) {
    console.error(`[AI 停止回归] 点击停止后未能即时落定: cancelCalls=${cancelCalls}, running=${runningAfterStop.length}, state=${sendBtn.getAttribute('data-state')}, dt=${stopDt}ms`);
    process.exit(1);
  }

  // 3) 停止后立刻发送新消息：不得被残留的 inFlight 锁静默吞掉
  httpMode = 'fast';
  const callsBefore = httpCalls;
  inputEl.value = '第二轮验证';
  inputEl.dispatchEvent(new sandbox.Event('input'));
  clickBtn(sendBtn);
  await new Promise((r) => setTimeout(r, 60));
  if (httpCalls <= callsBefore || !txt(rootAi).includes('第二轮正常回答')) {
    console.error(`[AI 停止回归] 停止后紧接发起新提问被吞或失败: httpCalls=${httpCalls - callsBefore}`);
    process.exit(1);
  }

  if (typeof retAi === 'function') retAi();
  sandbox.API.configGet = origCfgGetAi;
  if (sandbox.AIStore && sandbox.AIStore.load) await sandbox.AIStore.load(true);
  sandbox.API.aiStore = origStore;
  sandbox.API.aiHttp = origHttp;
  sandbox.API.aiHttpStream = origHttpStream;
  sandbox.API.aiCancel = origCancel;
}

// 回归 14（红队对抗审查）：[Q]Disk 品牌联合标志 + 侧栏 AI 指令卡边界条件与生命周期防泄漏
{
  const indexHtml = fs.readFileSync(path.join(root, 'src/web/index.html'), 'utf8');
  const stylesCss = fs.readFileSync(path.join(root, 'src/web/styles.css'), 'utf8');
  const appJs = fs.readFileSync(path.join(root, 'src/web/js/app.js'), 'utf8');

  if (!indexHtml.includes('brand-lockup') || !indexHtml.includes('brand-disk') || !indexHtml.includes('disk-i-dot')) {
    console.error('[红队回归 14] src/web/index.html 缺少 [Q]Disk 品牌联合锁排结构');
    process.exit(1);
  }
  if (!stylesCss.includes('html[lang^="en"] .brand-cn { display: none; }') || !stylesCss.includes('.app.collapsed .brand-lockup { display: none; }')) {
    console.error('[红队回归 14] 品牌锁排缺少英文去重隐藏或折叠隐藏规则');
    process.exit(1);
  }
  if (!appJs.includes('nav-ai-card') || !appJs.includes('bindButtonHover') || !appJs.includes('ai-nav-pip')) {
    console.error('[红队回归 14] 侧栏 AI 入口缺少指令卡、bindButtonHover 或纯装饰强调点');
    process.exit(1);
  }
  if (/nav-ai-card[\s\S]{0,240}title\s*:/.test(appJs)) {
    console.error('[红队回归 14] 侧栏 AI 指令卡仍含原生 title 属性，将与折叠轨 navTip 产生双重气泡冲突');
    process.exit(1);
  }
  if (!stylesCss.includes('body[data-motion="off"] .nav-item[data-id="ai"]') || !stylesCss.includes('.app.collapsed .nav-item[data-id="ai"] {\n  width: 100%;')) {
    console.error('[红队回归 14] 侧栏 AI 指令卡缺少 data-motion=off 降级或折叠态 width: 100% 防裁切约束');
    process.exit(1);
  }

  // 运行态校验：按钮悬停绑定到整卡、navTip 文案不被副标题污染、销毁零泄漏
  const liveBefore = sandbox.SteveAvatar.count();
  const mark = sandbox.SteveAvatar.el({ size: 22, variant: 'nav' });
  const lbl = sandbox.UI.h('span', { class: 'lbl' }, 'AI 助手');
  const sub = sandbox.UI.h('span', { class: 'ai-nav-sub' }, '查盘 · 问诊');
  const badge = sandbox.UI.h('span', { class: 'ai-nav-badge' }, mark, sandbox.UI.h('span', { class: 'ai-nav-pip' }));
  const btn = sandbox.UI.h('button', { class: 'nav-item nav-ai-card', dataset: { id: 'ai' }, 'aria-label': 'AI 助手' },
    badge,
    sandbox.UI.h('span', { class: 'ai-nav-meta' }, lbl, sub),
    sandbox.UI.h('span', { class: 'ai-nav-arrow' })
  );
  sandbox.document.body.appendChild(btn);
  mark._steve.bindButtonHover();
  if (mark._steve._hoverEl !== btn) {
    console.error('[红队回归 14] bindButtonHover 未将 Steve 悬停事件绑定至整张 AI 指令卡按钮');
    process.exit(1);
  }
  const readTxt = (n) => {
    if (!n) return '';
    if (typeof n === 'string') return n;
    let s = String(n._textContent || n.nodeValue || '');
    if (Array.isArray(n.children)) s += n.children.map(readTxt).join('');
    return s;
  };
  const foundLbl = findNodes(btn, (n) => n.classList && n.classList.contains('lbl'))[0];
  if (!foundLbl || readTxt(foundLbl).trim() !== 'AI 助手') {
    console.error('[红队回归 14] AI 指令卡 .lbl 文案异常（可能被副标题污染导致 navTip 错乱）');
    process.exit(1);
  }
  mark._steve.destroy();
  btn.remove();
  if (sandbox.SteveAvatar.count() !== liveBefore) {
    console.error(`[红队回归 14] AI 指令卡销毁后存在 SteveAvatar 实例泄漏: ${sandbox.SteveAvatar.count()} vs ${liveBefore}`);
    process.exit(1);
  }
}

// 回归 15（红队对抗审查）：全链路「软件内优先打开 + 系统管理器保留」+ 防「没有搜索到」竞态/ACL/超200项定位
{
  const origJump = sandbox.App.jump;
  const origReveal = sandbox.API.reveal;
  const origOpenPath = sandbox.API.openPath;
  const origInspectPath = sandbox.API.inspectPath;
  const origListDir = sandbox.API.listDir;
  const origCfgGet = sandbox.API.configGet;
  const origTopFiles = sandbox.API.topFiles;
  const origScanEmpty = sandbox.API.scanEmptyDirs;
  const origEngine = sandbox.API.engine;
  const origArchiveOpen = sandbox.API.archiveOpen;
  const origArchivePreview = sandbox.API.archivePreview;

  const jumps = [];
  const reveals = [];
  const externalOpens = [];
  sandbox.App.jump = async (page, payload) => {
    jumps.push({ page, payload });
  };
  sandbox.API.reveal = async (p) => { reveals.push(p); };
  sandbox.API.openPath = async (p) => { externalOpens.push(p); };

  // 模拟截图中的 5 条真实路径（含带点目录 157.0.4341.60、ACL 受限 WindowsApps、缺失路径与压缩包）
  const MOCK_FS = {
    'c:\\program files\\google\\chrome\\application\\chrome.exe': {
      status: 'ok', path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      exists: true, kind: 'file', readable: true,
      parent: 'C:\\Program Files\\Google\\Chrome\\Application', isExec: true, isArchive: false
    },
    'c:\\users\\十二\\appdata\\local\\programs\\antigravity\\antigravity.exe': {
      status: 'ok', path: 'C:\\Users\\十二\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe',
      exists: true, kind: 'file', readable: true,
      parent: 'C:\\Users\\十二\\AppData\\Local\\Programs\\antigravity', isExec: true, isArchive: false
    },
    'c:\\program files (x86)\\microsoft\\edgewebview\\application\\157.0.4341.60\\msedgewebview2.exe': {
      status: 'ok', path: 'C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application\\157.0.4341.60\\msedgewebview2.exe',
      exists: true, kind: 'file', readable: true,
      parent: 'C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application\\157.0.4341.60', isExec: true, isArchive: false
    },
    'c:\\program files (x86)\\microsoft\\edgewebview\\application\\157.0.4341.60': {
      status: 'ok', path: 'C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application\\157.0.4341.60',
      exists: true, kind: 'dir', readable: true,
      parent: 'C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application', isExec: false, isArchive: false
    },
    'c:\\program files\\windowsapps\\openai.codex_26.1016.6573.0_x64__2p2nqsd0c76g0\\app\\chatgpt.exe': {
      status: 'permission_denied',
      path: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1016.6573.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe',
      exists: true, kind: 'file', readable: false,
      parent: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1016.6573.0_x64__2p2nqsd0c76g0\\app',
      nearestReadable: 'C:\\Program Files',
      nearestReadableHighlight: 'C:\\Program Files\\WindowsApps',
      isExec: true, isArchive: false,
      error: '权限受限'
    },
    'd:\\backups\\archive.tar.gz': {
      status: 'ok', path: 'D:\\backups\\archive.tar.gz',
      exists: true, kind: 'file', readable: true,
      parent: 'D:\\backups', isExec: false, isArchive: true
    },
    'd:\\downloads\\gone.exe': {
      status: 'not_found', path: 'D:\\Downloads\\gone.exe',
      exists: false, kind: null, readable: false,
      parent: 'D:\\Downloads', nearestExisting: 'D:\\Downloads',
      isExec: true, isArchive: false, error: '这个位置已经不在了'
    }
  };
  sandbox.API.inspectPath = async (p) => {
    const key = String(p || '').replace(/[\\/]+$/, '').toLowerCase();
    return MOCK_FS[key] || { status: 'not_found', path: p, exists: false, readable: false, nearestExisting: 'C:\\' };
  };

  // 1) parentOf 盘符根规整（C:\foo.exe -> C:\ 而非 C:）
  if (sandbox.AIEntries.parentOf('C:\\foo.exe') !== 'C:\\') {
    console.error(`[红队回归 15] parentOf("C:\\foo.exe") 返回错误值: ${sandbox.AIEntries.parentOf('C:\\foo.exe')}`);
    process.exit(1);
  }

  // 2) 点击 .exe：必须留在软件内 DirView 定位高亮，0 次调用 reveal / openPath
  const rExe = await sandbox.AIEntries.open('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  if (!rExe.ok || !rExe.inApp || reveals.length !== 0 || externalOpens.length !== 0) {
    console.error(`[红队回归 15] 点击 .exe 未留在软件内: r=${JSON.stringify(rExe)}, reveals=${reveals.length}, opens=${externalOpens.length}`);
    process.exit(1);
  }
  const lastJ = jumps[jumps.length - 1];
  if (!lastJ || lastJ.page !== 'tools' || lastJ.payload.action !== 'browse'
      || lastJ.payload.dir !== 'C:\\Program Files\\Google\\Chrome\\Application'
      || lastJ.payload.highlight !== 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe') {
    console.error(`[红队回归 15] .exe 跳转载荷错误: ${JSON.stringify(lastJ)}`);
    process.exit(1);
  }

  // 3) 带点文件夹（157.0.4341.60）必须作为 dir 进入 DirView，而不是被误猜为 file
  await sandbox.AIEntries.open('C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application\\157.0.4341.60');
  const jDot = jumps[jumps.length - 1];
  if (!jDot || jDot.page !== 'tools' || jDot.payload.dir !== 'C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application\\157.0.4341.60') {
    console.error(`[红队回归 15] 带点目录被误判: ${JSON.stringify(jDot)}`);
    process.exit(1);
  }

  // 4) 压缩包直达软件「压缩包」页
  await sandbox.AIEntries.open('D:\\backups\\archive.tar.gz');
  const jArc = jumps[jumps.length - 1];
  if (!jArc || jArc.page !== 'archive' || jArc.payload.paths[0] !== 'D:\\backups\\archive.tar.gz') {
    console.error(`[红队回归 15] 压缩包未路由至压缩包页: ${JSON.stringify(jArc)}`);
    process.exit(1);
  }

  // 5) ACL 权限受限（WindowsApps）必须携带 accessDenied 回退最近可读目录
  await sandbox.AIEntries.open('C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1016.6573.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe');
  const jAcl = jumps[jumps.length - 1];
  if (!jAcl || !jAcl.payload.accessDenied || jAcl.payload.dir !== 'C:\\Program Files' || jAcl.payload.highlight !== 'C:\\Program Files\\WindowsApps') {
    console.error(`[红队回归 15] WindowsApps 权限受限未正确降级回退: ${JSON.stringify(jAcl)}`);
    process.exit(1);
  }

  // 6) 缺失目标自动回退最近存在的上级目录（不撞死空页）
  await sandbox.AIEntries.open('D:\\Downloads\\gone.exe');
  const jMiss = jumps[jumps.length - 1];
  if (!jMiss || jMiss.payload.dir !== 'D:\\Downloads' || jMiss.payload.missingTarget !== 'D:\\Downloads\\gone.exe') {
    console.error(`[红队回归 15] 缺失目标未回退至最近上级目录: ${JSON.stringify(jMiss)}`);
    process.exit(1);
  }

  // 7) 显式系统管理器按钮（chip .ai-entry-ext / external: true）必须准确调用 API.reveal，绝不调 openPath
  const chipEl = sandbox.AIEntries.chip('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', { compact: true });
  const extChipBtn = findNodes(chipEl, (n) => n.classList && n.classList.contains('ai-entry-ext'))[0];
  if (!extChipBtn) {
    console.error('[红队回归 15] AIEntries.chip 缺少伴随式系统文件管理器按钮 .ai-entry-ext');
    process.exit(1);
  }
  const revBefore = reveals.length;
  extChipBtn.dispatchEvent(Object.assign(new sandbox.Event('click'), { preventDefault() {}, stopPropagation() {} }));
  await new Promise((r) => setTimeout(r, 20));
  if (reveals.length !== revBefore + 1 || externalOpens.length !== 0) {
    console.error(`[红队回归 15] 点击芯片系统管理器按钮未调 reveal 或误调 openPath: reveals=${reveals.length}, opens=${externalOpens.length}`);
    process.exit(1);
  }
  // openSystemApp 严格拦截 .exe 防止直接启动程序
  const blockedExec = await sandbox.AIEntries.openSystemApp('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  if (blockedExec.ok || !blockedExec.blockedExec || externalOpens.length !== 0) {
    console.error(`[红队回归 15] openSystemApp 未拦截可执行文件: ${JSON.stringify(blockedExec)}`);
    process.exit(1);
  }

  // 8) tools.js + dirview.js：删除非空下载目录不得误跳空文件夹页；延迟 configGet 不得覆写 jump；超 200 项 locate 高亮 + 权限横幅
  const listDirCalls = [];
  let scanBigCalled = 0;
  let scanEmptyCalled = 0;
  sandbox.API.configGet = () => new Promise((resolve) => setTimeout(() => resolve({ last_folder: 'D:\\StaleFolder' }), 30));
  sandbox.API.topFiles = async (dir) => { scanBigCalled++; return { dir, items: [{ path: dir + '\\big.iso', name: 'big.iso', size: 1024 * 1024 * 500, ext: 'iso' }], scanned: 1 }; };
  sandbox.API.scanEmptyDirs = async (dir) => { scanEmptyCalled++; return { dir, items: [], depth: 3 }; };
  sandbox.API.listDir = async (dir, limit, offset, opts) => {
    listDirCalls.push({ dir, limit, offset, opts });
    if (opts && opts.locate && /item_218/i.test(opts.locate)) {
      return {
        dir, total: 225, unfilteredTotal: 225, offset: 200, shown: 25, dirs: 0, files: 225,
        hasPrev: true, truncated: false, located: true, locateIndex: 218, locateName: 'item_218.exe',
        items: [{ name: 'item_218.exe', kind: 'file', size: 4096, ext: 'exe', mtime: 1700000000 }]
      };
    }
    return {
      dir, total: 2, unfilteredTotal: 2, offset: 0, shown: 2, dirs: 1, files: 1,
      hasPrev: false, truncated: false, located: false,
      items: [
        { name: 'WindowsApps', kind: 'dir', size: 0, ext: '', mtime: 1700000000 },
        { name: 'chrome.exe', kind: 'file', size: 2048, ext: 'exe', mtime: 1700000000 }
      ]
    };
  };

  const toolsRoot = new FakeElement('div');
  const unmountTools = await sandbox.Pages.tools.mount(toolsRoot);
  // 8a. 「可以直接删，共 10.4 GB：下载目录」不能进空文件夹清理
  await sandbox.Pages.tools.jump({ action: 'delete', paths: ['C:\\Users\\十二\\Downloads'], why: '可以直接删，共 10.4 GB：下载目录' });
  if (scanBigCalled < 1 || scanEmptyCalled !== 0) {
    console.error(`[红队回归 15] tools.js 把删除非空目录误路由到空文件夹清理: big=${scanBigCalled}, empty=${scanEmptyCalled}`);
    process.exit(1);
  }
  // 8b. 跳进目录浏览定位超 200 项，并等待延迟的 configGet(30ms) 完成校验不被覆写
  await sandbox.Pages.tools.jump({
    action: 'browse',
    dir: 'C:\\ManyFiles',
    highlight: 'C:\\ManyFiles\\item_218.exe',
    paths: ['C:\\ManyFiles\\item_218.exe']
  });
  await new Promise((r) => setTimeout(r, 50));
  const hitRows = findNodes(toolsRoot, (n) => n.classList && n.classList.contains('dv-row') && n.hasAttribute('data-hit'));
  const focusBar = findNodes(toolsRoot, (n) => n.classList && n.classList.contains('dv-focus-bar') && !n.hidden)[0];
  const staleCall = listDirCalls.find((c) => c.dir === 'D:\\StaleFolder');
  if (staleCall || hitRows.length !== 1 || !focusBar || !listDirCalls.some((c) => c.opts && c.opts.locate === 'C:\\ManyFiles\\item_218.exe')) {
    console.error(`[红队回归 15] DirView 超200项定位或防竞态失败: stale=${!!staleCall}, hits=${hitRows.length}, focusBar=${!!focusBar}`);
    process.exit(1);
  }
  // 8c. ACL 受限跳入 DirView 必须展示权限提示横幅与管理员重启续跳按钮
  await sandbox.Pages.tools.jump({
    action: 'browse',
    dir: 'C:\\Program Files',
    highlight: 'C:\\Program Files\\WindowsApps',
    paths: ['C:\\Program Files\\WindowsApps\\OpenAI.Codex\\ChatGPT.exe'],
    accessDenied: true,
    requestedPath: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex\\ChatGPT.exe'
  });
  await new Promise((r) => setTimeout(r, 20));
  const aclBanner = findNodes(toolsRoot, (n) => n.classList && n.classList.contains('dv-notice') && n.classList.contains('is-warn') && !n.hidden)[0];
  if (!aclBanner) {
    console.error('[红队回归 15] WindowsApps 权限受限横幅未显示');
    process.exit(1);
  }
  if (typeof unmountTools === 'function') unmountTools();

  // 9) search.js：接收 paths 跳转并自动检索，单击结果行留在软件内（不直接跳 Explorer）
  let lastSearchQ = '';
  sandbox.API.engine = async (method, params) => {
    if (method === 'search.status') return { backend: 'index', files: 10, entries: [], roots: [], dirs: 1 };
    if (method === 'search.query') {
      lastSearchQ = (params && params.q) || '';
      return {
        source: 'direct', elapsed_ms: 2,
        items: [{ name: 'chrome.exe', path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', size: 2048, mtime: 1700000000, kind: 'file' }]
      };
    }
    return origEngine(method, params);
  };
  const searchRoot = new FakeElement('div');
  const unmountSearch = await sandbox.Pages.search.mount(searchRoot);
  const jumpCountBeforeSearch = jumps.length;
  const revBeforeSearch = reveals.length;
  await sandbox.Pages.search.jump({ paths: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'] });
  await new Promise((r) => setTimeout(r, 20));
  const resultTr = findNodes(searchRoot, (n) => n.tagName === 'TR' && n.dataset && n.dataset.ctx === 'result')[0];
  if (lastSearchQ !== 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' || !resultTr) {
    console.error(`[红队回归 15] search.js 未接收 paths 载荷执行搜索: q=${lastSearchQ}, tr=${!!resultTr}`);
    process.exit(1);
  }
  resultTr.dispatchEvent(new sandbox.Event('click'));
  await new Promise((r) => setTimeout(r, 20));
  if (jumps.length <= jumpCountBeforeSearch || reveals.length !== revBeforeSearch) {
    console.error(`[红队回归 15] search.js 单击结果行未走软件内打开或误弹 Explorer: jumps=${jumps.length - jumpCountBeforeSearch}, reveals=${reveals.length - revBeforeSearch}`);
    process.exit(1);
  }
  if (typeof unmountSearch === 'function') unmountSearch();

  // 10) apps.js：无未定义 searchInput；liveJump 支持 procs+paths 且不误调 openPath(exe)
  const appsSrc = fs.readFileSync(path.join(root, 'src/web/js/pages/apps.js'), 'utf8');
  if (/\bsearchInput\b/.test(appsSrc)) {
    console.error('[红队回归 15] apps.js 仍残留未定义变量 searchInput');
    process.exit(1);
  }
  sandbox.API.engine = async (method, params) => {
    if (method === 'process.list') {
      return {
        ok: true, raw_count: 1, total_memory: 104857600,
        items: [{ name: 'chrome.exe', clean_name: 'chrome', memory: 104857600, process_count: 1, is_system: false, pids: [888], exe_path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' }]
      };
    }
    return origEngine(method, params);
  };
  const appsRoot = new FakeElement('div');
  const unmountApps = await sandbox.Pages.apps.mount(appsRoot);
  await sandbox.Pages.apps.jump({ tab: 'procs', paths: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'] });
  await new Promise((r) => setTimeout(r, 25));
  const procLocateBtn = findNodes(appsRoot, (n) => n.tagName === 'BUTTON' && (n.title === '在软件内定位' || n.getAttribute('title') === '在软件内定位'))[0];
  const opensBeforeProc = externalOpens.length;
  const jumpsBeforeProc = jumps.length;
  if (!procLocateBtn) {
    console.error('[红队回归 15] apps.js 后台进程表缺少「在软件内定位」按钮或 liveJump 未加载进程');
    process.exit(1);
  }
  procLocateBtn.dispatchEvent(new sandbox.Event('click'));
  await new Promise((r) => setTimeout(r, 20));
  if (externalOpens.length !== opensBeforeProc || jumps.length <= jumpsBeforeProc) {
    console.error(`[红队回归 15] apps.js 进程定位误调 openPath(.exe) 或未进软件内: opens=${externalOpens.length - opensBeforeProc}, jumps=${jumps.length - jumpsBeforeProc}`);
    process.exit(1);
  }
  if (typeof unmountApps === 'function') unmountApps();

  // 11) archive.js 预览区拦截 .exe 直接运行
  const arcSrc = fs.readFileSync(path.join(root, 'src/web/js/pages/archive.js'), 'utf8');
  if (!arcSrc.includes('execBlocked') || !arcSrc.includes('压缩包内可执行文件禁止直接运行')) {
    console.error('[红队回归 15] archive.js 预览区缺少可执行文件直启拦截保护');
    process.exit(1);
  }

  sandbox.App.jump = origJump;
  sandbox.API.reveal = origReveal;
  sandbox.API.openPath = origOpenPath;
  sandbox.API.inspectPath = origInspectPath;
  sandbox.API.listDir = origListDir;
  sandbox.API.configGet = origCfgGet;
  sandbox.API.topFiles = origTopFiles;
  sandbox.API.scanEmptyDirs = origScanEmpty;
  sandbox.API.engine = origEngine;
  sandbox.API.archiveOpen = origArchiveOpen;
  sandbox.API.archivePreview = origArchivePreview;
}

// 回归 16（红队对抗审查）：AI 用户发送内容快捷复制（含降级/防爆/防泄漏/无损原文本）+ 全 12 页按钮冒烟
{
  const origNavClip = sandbox.navigator.clipboard;
  const origExecCmd = sandbox.document.execCommand;
  let copiedViaLegacy = '';
  // 模拟 WebView2 剪贴板 API 拒权：UI.copy 必须自动降级到 execCommand('copy')
  const directCopyTas = () => sandbox.document.body.children.filter((n) => n.tagName === 'TEXTAREA');
  const tasBefore = directCopyTas().length;
  sandbox.navigator.clipboard = { writeText: () => Promise.reject(new Error('Clipboard denied')) };
  sandbox.document.execCommand = (cmd) => {
    if (cmd === 'copy') {
      const list = directCopyTas();
      const ta = list[list.length - 1];
      copiedViaLegacy = ta ? String(ta.value || '') : '';
      return !!copiedViaLegacy;
    }
    return false;
  };

  // 1) UI.copy 超长文本截断 Toast 且返回 true，不残留临时 textarea
  const longText = '第一行：C:\\Program Files (x86)\\test.exe\n' + '超长内容'.repeat(300);
  const copyOk = await sandbox.UI.copy(longText);
  const leftoverTa = directCopyTas().length - tasBefore;
  if (!copyOk || copiedViaLegacy !== longText || leftoverTa !== 0) {
    console.error(`[红队回归 16] UI.copy 降级失败或残留 textarea: ok=${copyOk}, match=${copiedViaLegacy === longText}, leftover=${leftoverTa}`);
    process.exit(1);
  }

  // 2) AI 对话用户消息气泡下方必须渲染 .ai-user-copy 快捷复制按钮（实时 + 历史回放），无损复制原文、不禁用按钮、防泄漏
  const origStore16 = sandbox.API.aiStore;
  const origHttp16 = sandbox.API.aiHttp;
  const origHttpStream16 = sandbox.API.aiHttpStream;
  const origCfg16 = sandbox.API.configGet;
  const rawPrompt = '帮我排查 <script>alert(1)</script>\n  D:\\Program Files (x86)\\test.exe\n保留缩进与换行';
  const savedHist = {
    id: 'hist-copy-test',
    version: 2,
    title: '复制测试',
    messages: [
      { role: 'user', content: rawPrompt },
      { role: 'assistant', content: '已收到' }
    ]
  };
  sandbox.API.configGet = async () => ({
    ai: { provider: 'custom', endpoint: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'm-test', enabled: true }
  });
  sandbox.API.aiStore = async (op, name) => {
    if (op === 'list') return ['hist-copy-test.json'];
    if (op === 'read' && name === 'hist-copy-test.json') return JSON.stringify(savedHist);
    return null;
  };
  sandbox.API.aiHttp = async () => ({
    status: 200,
    body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer: 'ok' }) } }] })
  });
  sandbox.API.aiHttpStream = null;
  if (sandbox.AIStore && sandbox.AIStore.load) await sandbox.AIStore.load(true);

  const aiHost = new FakeElement('div');
  const unmountAi16 = await sandbox.Pages.ai.mount(aiHost);
  await new Promise((r) => setTimeout(r, 30));

  // 实时发送一条用户消息
  const inp = findNodes(aiHost, (n) => n.tagName === 'TEXTAREA' && n.classList && n.classList.contains('dac-input'))[0];
  const sBtn = findNodes(aiHost, (n) => n.tagName === 'BUTTON' && n.classList && n.classList.contains('dac-send'))[0];
  if (!inp || !sBtn) {
    console.error('[红队回归 16] AI 对话输入框或发送按钮未渲染');
    process.exit(1);
  }
  inp.value = rawPrompt;
  inp.dispatchEvent(new sandbox.Event('input'));
  sBtn.dispatchEvent(new sandbox.Event('click'));
  await new Promise((r) => setTimeout(r, 40));

  const userCopyBtns = findNodes(aiHost, (n) => n.tagName === 'BUTTON' && n.classList && n.classList.contains('ai-user-copy'));
  if (!userCopyBtns.length) {
    console.error('[红队回归 16] 用户发送消息下方未渲染快捷复制按钮 .ai-user-copy');
    process.exit(1);
  }
  copiedViaLegacy = '';
  const uBtn = userCopyBtns[userCopyBtns.length - 1];
  uBtn.dispatchEvent(Object.assign(new sandbox.Event('click'), { preventDefault() {}, stopPropagation() {} }));
  await new Promise((r) => setTimeout(r, 25));
  if (copiedViaLegacy !== rawPrompt || !uBtn.hasAttribute('data-copied') || uBtn.disabled) {
    console.error(`[红队回归 16] 用户快捷复制内容失真或错误禁用按钮: match=${copiedViaLegacy === rawPrompt}, attr=${uBtn.hasAttribute('data-copied')}, disabled=${uBtn.disabled}`);
    process.exit(1);
  }
  // 连续快速再点一次（验证防抖清理前定时器不报错）
  uBtn.dispatchEvent(Object.assign(new sandbox.Event('click'), { preventDefault() {}, stopPropagation() {} }));
  await new Promise((r) => setTimeout(r, 20));

  if (typeof unmountAi16 === 'function') unmountAi16();
  sandbox.navigator.clipboard = origNavClip;
  sandbox.document.execCommand = origExecCmd;
  sandbox.API.aiStore = origStore16;
  sandbox.API.aiHttp = origHttp16;
  sandbox.API.aiHttpStream = origHttpStream16;
  sandbox.API.configGet = origCfg16;
  if (sandbox.AIStore && sandbox.AIStore.load) await sandbox.AIStore.load(true);

  // 3) 全站 12 页可见交互按钮全面点击冒烟（Tab/筛选/视图切换/刷新/收起/定位等非破坏性按钮，校验 0 异常、0 泄漏）
  const readNodeText = (n) => {
    if (!n) return '';
    if (typeof n === 'string') return n;
    let s = String(n._textContent || n.nodeValue || '');
    if (Array.isArray(n.children)) s += n.children.map(readNodeText).join('');
    return s;
  };
  const DANGER_RE = /删除|清空|卸载|结束|强制|重建|迁移|重置|重启|执行|取消|恢复默认|安装更新|delete|remove|kill|uninstall|reset|restart|clean|migrate|format/i;
  let totalClicked = 0;
  for (const pid of Object.keys(sandbox.Pages)) {
    const pMod = sandbox.Pages[pid];
    if (!pMod || typeof pMod.mount !== 'function') continue;
    const intervalsBefore = activeIntervals.size;
    const listenersBefore = Array.from(docListeners.values()).reduce((s, a) => s + a.length, 0);
    const host = new FakeElement('div');
    const um = await pMod.mount(host);
    await new Promise((r) => setTimeout(r, 15));
    const btns = findNodes(host, (n) => n.tagName === 'BUTTON' && !n.disabled && !n.hidden);
    for (const b of btns) {
      const label = (readNodeText(b) + ' ' + String(b.title || b.getAttribute('title') || '') + ' ' + String(b.getAttribute('aria-label') || '')).trim();
      if (DANGER_RE.test(label) || b.classList.contains('danger')) continue;
      if (b.classList.contains('dac-send') || b.classList.contains('btn-admin-action')) continue;
      try {
        b.dispatchEvent(Object.assign(new sandbox.Event('click'), { preventDefault() {}, stopPropagation() {} }));
        totalClicked++;
      } catch (e) {
        console.error(`[红队回归 16 · 全站按钮冒烟] 页面 ${pid} 按钮「${label}」点击抛异常:`, e);
        process.exit(1);
      }
    }
    await new Promise((r) => setTimeout(r, 20));
    if (typeof um === 'function') um();
    if (sandbox.UI && sandbox.UI.closeMenu) sandbox.UI.closeMenu();
    if (sandbox.UI && sandbox.UI.closePreview) sandbox.UI.closePreview();
    if (sandbox.UI && sandbox.UI.closeModals) sandbox.UI.closeModals();
    if (sandbox.AIDrawer && sandbox.AIDrawer.isOpen && sandbox.AIDrawer.isOpen()) sandbox.AIDrawer.close();
    const intervalsAfter = activeIntervals.size;
    const listenersAfter = Array.from(docListeners.values()).reduce((s, a) => s + a.length, 0);
    if (intervalsAfter > intervalsBefore || listenersAfter > listenersBefore) {
      console.error(`[红队回归 16 · 全站按钮冒烟] 页面 ${pid} 点击按钮并卸载后发生泄漏: intervals ${intervalsBefore}->${intervalsAfter}, listeners ${listenersBefore}->${listenersAfter}`);
      process.exit(1);
    }
  }
  if (totalClicked < 40) {
    console.error(`[红队回归 16 · 全站按钮冒烟] 覆盖按钮数异常偏少: ${totalClicked}`);
    process.exit(1);
  }
}

/* ==================== 回归 17（红队对抗审查）：幽灵目录修复 / 全能文件预览 / 历史更新日志弹窗 / 一键全盘索引 ==================== */
{
  const txt = (n) => {
    if (!n) return '';
    if (typeof n === 'string') return n;
    let s = String(n._textContent || n.nodeValue || '');
    if (Array.isArray(n.children)) s += n.children.map(txt).join('');
    return s;
  };
  const clickBtn = (btn) => {
    if (!btn) return;
    const ev = Object.assign(new sandbox.Event('click'), { preventDefault() {}, stopPropagation() {}, target: btn, currentTarget: btn });
    if (btn.listeners && btn.listeners.click && btn.listeners.click.length) {
      btn.dispatchEvent(ev);
    } else if (typeof btn.onclick === 'function') {
      btn.onclick(ev);
    }
  };
  const modalRoot = sandbox.document._byId['modal-root'];
  const previewRoot = (sandbox.document._byId['preview-root'] = sandbox.document._byId['preview-root'] || new FakeElement('div'));
  modalRoot.children = [];
  previewRoot.children = [];

  const origCfgGet = sandbox.API.configGet;
  const origCfgSet = sandbox.API.configSet;
  const origInspect = sandbox.API.inspectPath;
  const origEngine = sandbox.API.engine;
  const origFilePreview = sandbox.API.filePreview;
  const origTopFiles = sandbox.API.topFiles;
  const origListDir = sandbox.API.listDir;
  const origOpenPath = sandbox.API.openPath;
  const origUpdStatus = sandbox.API.updaterStatus;
  const origUpdChangelog = sandbox.API.updaterChangelog;

  // 1) 幽灵目录根治：点击 × 立即清空 last_folder，且失效目录自动清脏，空间工具绝不自动打开 last_folder
  let savedCfg = { last_folder: 'E:\\AI\\DeepSeek\\下载\\20261120-临时验证\\整理测试' };
  const cfgWrites = [];
  sandbox.API.configGet = async () => Object.assign({}, savedCfg);
  sandbox.API.configSet = async (patch) => {
    cfgWrites.push(Object.assign({}, patch));
    savedCfg = Object.assign({}, savedCfg, patch || {});
    return savedCfg;
  };
  sandbox.API.inspectPath = async (p) => ({ status: 'ok', path: p, exists: true, kind: 'dir', readable: true });
  sandbox.API.engine = async (method) => {
    if (method === 'settings.get') return { default_recursive: true, default_content: false, conflict_policy: 'rename' };
    if (method === 'scan') {
      return {
        plans: [{
          folder: 'E:\\AI\\DeepSeek\\下载\\20261120-临时验证\\整理测试',
          groups: [{ cat: '文档', files: [{ name: '测试报告.docx', size: 4096, mtime: 1700000000 }] }],
          skipped: []
        }],
        blocked: []
      };
    }
    return origEngine(method, {});
  };

  // 1a. 整理页挂载看到历史目录芯片 -> 点击 × 移除 -> 立即写盘清空 last_folder -> 重新挂载不再出现
  const orgHost1 = new FakeElement('div');
  const umOrg1 = await sandbox.Pages.organize.mount(orgHost1);
  await new Promise((r) => setTimeout(r, 20));
  const srcXBtn = findNodes(orgHost1, (n) => n.classList && n.classList.contains('src-x'))[0];
  if (!srcXBtn) {
    console.error('[红队回归 17] organize 挂载后未渲染 .src-x 移除按钮');
    process.exit(1);
  }
  clickBtn(srcXBtn);
  await new Promise((r) => setTimeout(r, 20));
  if (savedCfg.last_folder !== '' || findNodes(orgHost1, (n) => n.classList && n.classList.contains('src-chip')).length !== 0) {
    console.error(`[红队回归 17] 点击 × 移除来源后未清空 last_folder: saved=${JSON.stringify(savedCfg)}`);
    process.exit(1);
  }
  umOrg1();

  // 重新挂载整理页：不再恢复被删掉的目录
  const orgHost2 = new FakeElement('div');
  const umOrg2 = await sandbox.Pages.organize.mount(orgHost2);
  await new Promise((r) => setTimeout(r, 20));
  if (findNodes(orgHost2, (n) => n.classList && n.classList.contains('src-chip')).length !== 0) {
    console.error('[红队回归 17] 删除来源后重新进入整理页仍复活了旧目录胶囊');
    process.exit(1);
  }
  umOrg2();

  // 1b. 失效/已删除目录自动清脏
  savedCfg = { last_folder: 'E:\\已删除的临时目录' };
  sandbox.API.inspectPath = async (p) => ({ status: 'not_found', path: p, exists: false, kind: 'missing' });
  const orgHost3 = new FakeElement('div');
  const umOrg3 = await sandbox.Pages.organize.mount(orgHost3);
  await new Promise((r) => setTimeout(r, 20));
  if (savedCfg.last_folder !== '' || findNodes(orgHost3, (n) => n.classList && n.classList.contains('src-chip')).length !== 0) {
    console.error(`[红队回归 17] 失效 last_folder 未自动清理: saved=${JSON.stringify(savedCfg)}`);
    process.exit(1);
  }
  umOrg3();

  // 1c. 空间工具挂载绝不自动打开 config.last_folder
  savedCfg = { last_folder: 'E:\\AI\\DeepSeek\\下载\\20261120-临时验证\\整理测试' };
  const autoListDirs = [];
  sandbox.API.listDir = async (dir) => { autoListDirs.push(dir); return { dir, total: 0, items: [] }; };
  const toolsHost17 = new FakeElement('div');
  const umTools17 = await sandbox.Pages.tools.mount(toolsHost17);
  await new Promise((r) => setTimeout(r, 40));
  if (autoListDirs.length !== 0) {
    console.error(`[红队回归 17] 空间工具挂载时仍自动打开了 last_folder: ${JSON.stringify(autoListDirs)}`);
    process.exit(1);
  }
  umTools17();

  // 2) 文件预览修复：UI.preview 自动补 src（含剥离 \\?\ 扩展前缀）+ UI.previewFile 媒体句柄释放 + 内部模式切换防竞态 + XSS 清洗 + 整理/空间工具直看内容
  const strippedSrc = sandbox.UI.fileSrc('\\\\?\\D:\\Photos\\sample #1.png');
  if (!strippedSrc || strippedSrc.includes('%3F') || !strippedSrc.includes('sample%20%231.png')) {
    console.error(`[红队回归 17] UI.fileSrc 未剥离 \\\\?\\ 扩展前缀: ${strippedSrc}`);
    process.exit(1);
  }
  sandbox.UI.preview({ items: [{ path: 'D:\\Photos\\sample #1.png', name: 'sample #1.png' }], index: 0, title: 'sample #1.png' });
  const prevImg = findNodes(previewRoot, (n) => n.tagName === 'IMG')[0];
  if (!prevImg || !prevImg.src || !String(prevImg.src).includes('sample%20%231.png')) {
    console.error(`[红队回归 17] UI.preview 未将 path 转换为合法 src: src=${prevImg && prevImg.src}`);
    process.exit(1);
  }
  sandbox.UI.closePreview();

  const xssHost = new FakeElement('div');
  sandbox.UI.safeSetHtml(xssHost, '<p>正常内容</p><script>window.__xss=1</script><iframe src="https://evil.test"></iframe><a href="javascript:alert(1)" onclick="evil()">bad</a>');
  const xssOut = String(xssHost._innerHTML || '').toLowerCase();
  if (xssOut.includes('<script') || xssOut.includes('<iframe') || xssOut.includes('onclick=') || xssOut.includes('javascript:')) {
    console.error(`[红队回归 17] UI.safeSetHtml 未拦截脚本/iframe/协议注入: ${xssHost._innerHTML}`);
    process.exit(1);
  }

  // 2-rt. previewFile 内部模式切换竞态：先切 hex（慢返回）再切 text（快返回），慢响应不得反覆盖新视图
  modalRoot.children = [];
  let resolveSlowHex = null;
  sandbox.API.filePreview = async (p, _max, mode) => {
    if (mode === 'hex') {
      return await new Promise((resolve) => {
        resolveSlowHex = () => resolve({
          path: p, name: 'doc.md', ext: 'md', size: 32, mtime: 1700000000,
          kind: 'hex', encoding: 'hex', text: 'STALE_HEX_DUMP_0000', truncated: false,
          isExec: false, isArchive: false, canHex: true, canText: true, note: ''
        });
      });
    }
    return {
      path: p, name: 'doc.md', ext: 'md', size: 32, mtime: 1700000000,
      kind: 'text', encoding: 'utf-8', text: 'FRESH_MD_TEXT [官网](https://example.com)', truncated: false,
      isExec: false, isArchive: false, canHex: true, canText: true, note: ''
    };
  };
  const raceHandle = await sandbox.UI.previewFile('D:\\docs\\doc.md', { name: 'doc.md' });
  await new Promise((r) => setTimeout(r, 15));
  const hexBtnR = findNodes(modalRoot, (n) => n.tagName === 'BUTTON' && txt(n).includes('十六进制'))[0];
  clickBtn(hexBtnR);
  await new Promise((r) => setTimeout(r, 10));
  // 模拟同一预览弹窗里立刻切回文本（重新打开或重试）前先让慢 hex 处于在途，随后打开新预览，再释放旧 hex
  const raceHandle2 = await sandbox.UI.previewFile('D:\\docs\\doc.md', { name: 'doc.md' });
  await new Promise((r) => setTimeout(r, 15));
  if (resolveSlowHex) resolveSlowHex();
  await new Promise((r) => setTimeout(r, 15));
  if (txt(modalRoot).includes('STALE_HEX_DUMP_0000') || !txt(modalRoot).includes('FRESH_MD_TEXT')) {
    console.error('[红队回归 17] UI.previewFile 在途慢响应反覆盖了当前预览内容');
    process.exit(1);
  }
  raceHandle2.close();
  if (raceHandle && raceHandle.close) raceHandle.close();
  await new Promise((r) => setTimeout(r, 15));

  const previewCalls = [];
  sandbox.API.filePreview = async (p, _max, mode) => {
    previewCalls.push({ p, mode });
    if (/\.bat$/i.test(p)) {
      return {
        path: p, name: 'run.bat', ext: 'bat', size: 64, mtime: 1700000000,
        kind: 'text', encoding: 'gbk', text: '@echo off\necho 中文批处理', truncated: false,
        isExec: true, isArchive: false, canHex: true, canText: true, note: '安全保护：只读查看'
      };
    }
    if (/\.mp4$/i.test(p)) {
      return {
        path: p, name: 'clip.mp4', ext: 'mp4', size: 10240, mtime: 1700000000,
        kind: 'video', mime: 'video/mp4', encoding: '', text: '', truncated: false,
        isExec: false, isArchive: false, canHex: true, canText: false, note: ''
      };
    }
    return {
      path: p, name: '测试报告.docx', ext: 'docx', size: 4096, mtime: 1700000000,
      kind: 'office', encoding: 'utf-8', text: '季度汇报正文内容', truncated: false,
      isExec: false, isArchive: false, canHex: true, canText: false, magic: 'Word 文档 (.docx)', note: ''
    };
  };

  // 2a. .bat 脚本只读查看文本且严禁提供「默认程序打开」按钮
  modalRoot.children = [];
  const batHandle = await sandbox.UI.previewFile('D:\\scripts\\run.bat', { name: 'run.bat' });
  await new Promise((r) => setTimeout(r, 20));
  const batText = txt(modalRoot);
  const batDefaultOpen = findNodes(modalRoot, (n) => n.tagName === 'BUTTON' && txt(n).includes('默认程序打开'));
  if (!batText.includes('中文批处理') || batDefaultOpen.length > 0) {
    console.error(`[红队回归 17] .bat 脚本只读预览异常或暴露了默认程序运行按钮: defaultBtns=${batDefaultOpen.length}`);
    process.exit(1);
  }
  batHandle.close();
  await new Promise((r) => setTimeout(r, 20));

  // 2b. 视频预览关闭时必须 pause + 清空 src 释放文件句柄
  modalRoot.children = [];
  let pausedCount = 0;
  let loadedCount = 0;
  const mp4Handle = await sandbox.UI.previewFile('D:\\video\\clip.mp4', { name: 'clip.mp4' });
  await new Promise((r) => setTimeout(r, 20));
  const vidEl = findNodes(modalRoot, (n) => n.tagName === 'VIDEO')[0];
  const vidSrcBefore = vidEl && (vidEl.src || vidEl.getAttribute('src'));
  if (!vidEl || !vidSrcBefore) {
    console.error('[红队回归 17] 视频预览未渲染 <video src=...>');
    process.exit(1);
  }
  vidEl.pause = () => { pausedCount++; };
  vidEl.load = () => { loadedCount++; };
  mp4Handle.close();
  await new Promise((r) => setTimeout(r, 20));
  const vidSrcAfter = vidEl.src || vidEl.getAttribute('src') || '';
  if (pausedCount !== 1 || loadedCount !== 1 || vidSrcAfter !== '') {
    console.error(`[红队回归 17] 视频预览关闭未释放媒体句柄: paused=${pausedCount}, loaded=${loadedCount}, src=${vidSrcAfter}`);
    process.exit(1);
  }

  // 2c. 整理文件页双击/点击预览按钮查看扫描结果文件内容
  savedCfg = { last_folder: 'E:\\AI\\DeepSeek\\下载\\20261120-临时验证\\整理测试' };
  sandbox.API.inspectPath = async (p) => ({ status: 'ok', path: p, exists: true, kind: 'dir', readable: true });
  const orgHost4 = new FakeElement('div');
  const umOrg4 = await sandbox.Pages.organize.mount(orgHost4);
  await new Promise((r) => setTimeout(r, 20));
  const scanBtn4 = findNodes(orgHost4, (n) => n.tagName === 'BUTTON' && txt(n).trim() === '扫描')[0];
  clickBtn(scanBtn4);
  await new Promise((r) => setTimeout(r, 280));
  const grpHead = findNodes(orgHost4, (n) => n.classList && n.classList.contains('group-head'))[0];
  if (grpHead) clickBtn(grpHead);
  await new Promise((r) => setTimeout(r, 20));
  const orgViewBtn = findNodes(orgHost4, (n) => n.classList && n.classList.contains('org-view-btn'))[0];
  if (!orgViewBtn) {
    console.error('[红队回归 17] 整理文件扫描预览行缺少查看内容按钮 .org-view-btn');
    process.exit(1);
  }
  const prevBeforeOrg = previewCalls.length;
  clickBtn(orgViewBtn);
  await new Promise((r) => setTimeout(r, 25));
  if (previewCalls.length <= prevBeforeOrg || !txt(modalRoot).includes('季度汇报正文内容')) {
    console.error('[红队回归 17] 整理文件行点击预览未展示 docx 正文内容');
    process.exit(1);
  }
  sandbox.UI.closeModals();
  umOrg4();

  // 2d. 空间工具大文件排行行内预览按钮查看内容
  sandbox.API.topFiles = async (dir) => ({ dir, items: [{ path: dir + '\\测试报告.docx', name: '测试报告.docx', size: 4096, ext: 'docx' }], scanned: 1 });
  const toolsHostBig = new FakeElement('div');
  const umToolsBig = await sandbox.Pages.tools.mount(toolsHostBig);
  await sandbox.Pages.tools.jump({ tab: 'big', dir: 'D:\\Work', paths: ['D:\\Work'] });
  await new Promise((r) => setTimeout(r, 25));
  const toolViewBtn = findNodes(toolsHostBig, (n) => n.classList && n.classList.contains('tool-view-btn'))[0];
  if (!toolViewBtn) {
    console.error('[红队回归 17] 空间工具大文件行缺少查看内容按钮 .tool-view-btn');
    process.exit(1);
  }
  const prevBeforeTool = previewCalls.length;
  clickBtn(toolViewBtn);
  await new Promise((r) => setTimeout(r, 25));
  if (previewCalls.length <= prevBeforeTool) {
    console.error('[红队回归 17] 空间工具大文件点击预览未触发 API.filePreview');
    process.exit(1);
  }
  sandbox.UI.closeModals();
  umToolsBig();

  // 3) 图 2 更新日志独立弹窗：无需发现新版本也能随时打开、可切换历史版本、可搜索筛选、零开发者隐私泄露
  modalRoot.children = [];
  if (sandbox.App) sandbox.App._pendingUpdate = null;
  sandbox.API.updaterStatus = async () => ({
    currentVersion: '1.46.0',
    installKind: 'installer',
    busy: false,
    releasesPage: 'https://github.com/3347567186/QDisk/releases',
    config: { channel: 'stable', autoCheck: true, ignoredVersion: '', lastCheckAt: '04:25:23' },
    updatesDir: 'D:\\data\\updates',
    cacheBytes: 0,
    staged: null
  });
  let clRemoteCalls = 0;
  sandbox.API.updaterChangelog = async (includeRemote) => {
    if (includeRemote) clRemoteCalls++;
    return {
      currentVersion: '1.46.0',
      total: 3,
      remoteSynced: !!includeRemote,
      remoteError: '',
      releasesPage: 'https://github.com/3347567186/QDisk/releases',
      entries: [
        { id: '1.46.0', version: '1.46.0', kind: 'minor', title: '全能文件预览与一键全盘索引', summary: '全能文件预览', body: '### 新功能\n- 完整更新内容弹窗', date: '2026-11-24', isCurrent: true, isPrerelease: false, source: 'local', url: 'https://github.com/3347567186/QDisk/releases/tag/v1.46.0' },
        { id: '1.45.0', version: '1.45.0', kind: 'minor', title: '软件内优先打开重构', summary: '软件内优先打开', body: '### 历史版本内容\n- 真实磁盘探测', date: '2026-11-24', isCurrent: false, isPrerelease: false, source: 'local', url: 'https://github.com/3347567186/QDisk/releases/tag/v1.45.0' },
        { id: '1.44.1', version: '1.44.1', kind: 'patch', title: '极简更新卡片', summary: '极简更新卡片', body: '### 修复\n- 极简更新体验', date: '2026-11-23', isCurrent: false, isPrerelease: false, source: 'local', url: 'https://github.com/3347567186/QDisk/releases/tag/v1.44.1' }
      ]
    };
  };
  const setHost17 = new FakeElement('div');
  const umSet17 = await sandbox.Pages.settings.mount(setHost17);
  sandbox.Pages.settings.jump({ section: 'updater' });
  await new Promise((r) => setTimeout(r, 25));
  const openClBtn = findNodes(setHost17, (n) => n.tagName === 'BUTTON' && txt(n).includes('更新内容'))[0];
  if (!openClBtn) {
    console.error('[红队回归 17] 设置页「版本与在线更新」在未发现新版本时缺少「更新内容」按钮');
    process.exit(1);
  }
  clickBtn(openClBtn);
  await new Promise((r) => setTimeout(r, 25));
  const clDialog = findNodes(modalRoot, (n) => n.tagName === 'DIALOG' && n.classList && n.classList.contains('cl-dialog'))[0];
  const clCards = findNodes(modalRoot, (n) => n.classList && n.classList.contains('cl-card'));
  if (!clDialog || clDialog.getAttribute('closedby') !== 'any' || clCards.length !== 3) {
    console.error(`[红队回归 17] 更新内容弹窗未以原生 <dialog closedby="any"> 渲染全部历史版本卡片: dialog=${!!clDialog}, cards=${clCards.length}`);
    process.exit(1);
  }
  const clModalText = txt(modalRoot);
  if (!clModalText.includes('v1.46.0') || !clModalText.includes('当前版本') || !clModalText.includes('真实磁盘探测') || !clModalText.includes('v1.44.1')) {
    console.error(`[红队回归 17] 更新内容时间轴卡片缺少版本标签、当前版本徽章或正文条目`);
    process.exit(1);
  }
  const clSyncBtn = findNodes(modalRoot, (n) => n.tagName === 'BUTTON' && txt(n).includes('同步线上'))[0];
  if (!clSyncBtn) {
    console.error('[红队回归 17] 更新内容弹窗缺少「同步线上」按钮');
    process.exit(1);
  }
  clickBtn(clSyncBtn);
  await new Promise((r) => setTimeout(r, 20));
  if (clRemoteCalls !== 1) {
    console.error(`[红队回归 17] 点击「同步线上」未触发远端同步: calls=${clRemoteCalls}`);
    process.exit(1);
  }
  if (/白林|3347567186@qq\.com|是个帅气的男孩/.test(txt(modalRoot))) {
    console.error('[红队回归 17] 更新内容弹窗暴露了开发者隐私信息');
    process.exit(1);
  }
  umSet17();
  if (findNodes(modalRoot, (n) => n.tagName === 'DIALOG' && n.classList && n.classList.contains('cl-dialog')).length !== 0) {
    console.error('[红队回归 17] 设置页 unmount 后未彻底回收更新内容 <dialog>');
    process.exit(1);
  }

  // 4) 图 3 一键建立索引：自动识别电脑主要盘（C:\、D:\、E:\）并全覆盖建库（含空列表启用、排除项展示、确认建库）
  modalRoot.children = [];
  let oneClickIndexPayload = null;
  let mockIndexedEntries = [];
  sandbox.API.engine = async (method, params) => {
    if (method === 'search.status') {
      return {
        backend: '本地索引', files: mockIndexedEntries.length ? 52000 : 0, dirs: mockIndexedEntries.length ? 3000 : 0,
        size_bytes: mockIndexedEntries.length ? 8388608 : 0, built_at: mockIndexedEntries.length ? 1700000000 : 0,
        entries: mockIndexedEntries, roots: mockIndexedEntries.map((x) => x.root), index_dir: 'D:\\data\\index'
      };
    }
    if (method === 'search.drives') {
      return {
        drives: [
          { root: 'C:\\', letter: 'C', label: '系统', fs: 'NTFS', total: 512e9, used: 200e9, free: 312e9, is_system: true, drive_type: 'fixed', in_catalog: false, built: false, files: 0 },
          { root: 'D:\\', letter: 'D', label: '数据', fs: 'NTFS', total: 1000e9, used: 400e9, free: 600e9, is_system: false, drive_type: 'fixed', in_catalog: false, built: false, files: 0 },
          { root: 'E:\\', letter: 'E', label: '资料', fs: 'NTFS', total: 1000e9, used: 100e9, free: 900e9, is_system: false, drive_type: 'fixed', in_catalog: false, built: false, files: 0 }
        ],
        excluded: [{ root: 'F:\\', letter: 'F', drive_type: 'removable', reason: '移动存储 / U 盘' }],
        missing_roots: ['C:\\', 'D:\\', 'E:\\'],
        all_covered: false,
        total_drives: 3
      };
    }
    if (method === 'search.index') {
      oneClickIndexPayload = params;
      mockIndexedEntries = (params.roots || []).map((r, idx) => ({
        id: 'id_' + idx, root: r, files: 18000, dirs: 1000, size_bytes: 2097152,
        built_at: 1700000000, exists: true, exists_root: true, why: ''
      }));
      return { indexed: 54000, built: 54000, entries: mockIndexedEntries.length, reused: false, failed: [], elapsed_ms: 820 };
    }
    return origEngine(method, params);
  };

  const searchHost17 = new FakeElement('div');
  // 预设局部搜索范围：一键全盘覆盖后必须自动清空局部 scope 回到全盘可搜
  sandbox.localStorage.setItem('ta.index.scope', JSON.stringify(['id_0']));
  const umSearch17 = await sandbox.Pages.search.mount(searchHost17);
  await new Promise((r) => setTimeout(r, 25));
  const oneClickBtn = findNodes(searchHost17, (n) => n.tagName === 'BUTTON' && txt(n).includes('一键建立索引'))[0];
  if (!oneClickBtn || oneClickBtn.disabled) {
    console.error(`[红队回归 17] 搜索页空列表时未启用「一键建立索引」按钮: found=${!!oneClickBtn}, disabled=${oneClickBtn && oneClickBtn.disabled}`);
    process.exit(1);
  }
  // 红队并发连点校验：连续点击两次「一键建立索引」，严禁堆叠两个确认弹窗
  clickBtn(oneClickBtn);
  clickBtn(oneClickBtn);
  await new Promise((r) => setTimeout(r, 30));
  const openMasks = findNodes(modalRoot, (n) => n.classList && n.classList.contains('modal-mask'));
  if (openMasks.length !== 1) {
    console.error(`[红队回归 17] 连点「一键建立索引」堆叠了 ${openMasks.length} 个弹窗`);
    process.exit(1);
  }
  const driveRows = findNodes(modalRoot, (n) => n.classList && n.classList.contains('ix-drive-row'));
  const modalTxt17 = txt(modalRoot);
  if (driveRows.length !== 3 || !modalTxt17.includes('C:\\') || !modalTxt17.includes('D:\\') || !modalTxt17.includes('E:\\') || !modalTxt17.includes('移动存储 / U 盘')) {
    console.error(`[红队回归 17] 一键建索引弹窗未正确识别 C/D/E 盘与排除项: rows=${driveRows.length}`);
    process.exit(1);
  }
  const startIdxBtn = findNodes(modalRoot, (n) => n.tagName === 'BUTTON' && txt(n).includes('开始建立索引')).pop();
  clickBtn(startIdxBtn);
  await new Promise((r) => setTimeout(r, 280));
  if (!oneClickIndexPayload || JSON.stringify(oneClickIndexPayload.roots) !== JSON.stringify(['C:\\', 'D:\\', 'E:\\']) || oneClickIndexPayload.reuse !== true || oneClickIndexPayload.full !== false) {
    console.error(`[红队回归 17] 一键建立索引提交参数异常: ${JSON.stringify(oneClickIndexPayload)}`);
    process.exit(1);
  }
  if (sandbox.localStorage.getItem('ta.index.scope')) {
    console.error(`[红队回归 17] 一键全盘覆盖后未重置旧局部 scope: ${sandbox.localStorage.getItem('ta.index.scope')}`);
    process.exit(1);
  }
  // 打开「管理索引」弹窗（图 3 界面）校验列表含 C/D/E 且弹窗内也具备「一键建立索引」按钮
  const manageBtn17 = findNodes(searchHost17, (n) => n.tagName === 'BUTTON' && txt(n).includes('管理索引'))[0];
  clickBtn(manageBtn17);
  await new Promise((r) => setTimeout(r, 25));
  const mgrTxt = txt(modalRoot);
  const mgrOneClick = findNodes(modalRoot, (n) => n.tagName === 'BUTTON' && txt(n).includes('一键建立索引'))[0];
  if (!mgrOneClick || !mgrTxt.includes('索引列表 · 3') || !mgrTxt.includes('C:\\') || !mgrTxt.includes('D:\\') || !mgrTxt.includes('E:\\')) {
    console.error(`[红队回归 17] 管理索引弹窗缺少「一键建立索引」或未刷新 C/D/E 列表: hasBtn=${!!mgrOneClick}`);
    process.exit(1);
  }
  umSearch17();
  sandbox.UI.closeModals();

  sandbox.API.configGet = origCfgGet;
  sandbox.API.configSet = origCfgSet;
  sandbox.API.inspectPath = origInspect;
  sandbox.API.engine = origEngine;
  sandbox.API.filePreview = origFilePreview;
  sandbox.API.topFiles = origTopFiles;
  sandbox.API.listDir = origListDir;
  sandbox.API.openPath = origOpenPath;
  sandbox.API.updaterStatus = origUpdStatus;
  sandbox.API.updaterChangelog = origUpdChangelog;
}

// 回归 18：红队专项 —— 后台进程绝不假成功（优雅→强制/复生/提权防环/自保护）、开机自启 setStartupView 与文件重命名同步、资源概览（原空间画像）改名与实时图读数刷新
{
  const txt = (n) => {
    if (!n) return '';
    let s = String(n._textContent || '');
    if (Array.isArray(n.children)) s += n.children.map(txt).join('');
    return s;
  };
  const clickBtn = (btn) => {
    if (!btn) return;
    if (btn.listeners && btn.listeners.click && btn.listeners.click.length) {
      btn.dispatchEvent(new sandbox.Event('click'));
    } else if (typeof btn.onclick === 'function') {
      btn.onclick();
    }
  };
  const origEngine = sandbox.API.engine;
  const origIsAdmin = sandbox.API.isAdmin;
  const modalRoot18 = sandbox.document._byId['modal-root'];
  const toastsRoot18 = new FakeElement('div');
  sandbox.document._byId['toasts'] = toastsRoot18;

  const getToasts = () => findNodes(toastsRoot18, (n) => n.classList && n.classList.contains('toast')).map((n) => ({
    kind: n.classList.contains('ok') ? 'ok' : (n.classList.contains('error') ? 'error' : (n.classList.contains('warn') ? 'warn' : 'info')),
    msg: txt(n)
  }));
  const clearToasts = () => { toastsRoot18.children = []; };
  const clickModalBtn = (labelMatch) => {
    const btns = findNodes(modalRoot18, (n) => n.tagName === 'BUTTON' && txt(n).includes(labelMatch));
    if (btns.length) clickBtn(btns[btns.length - 1]);
    return btns.length > 0;
  };

  let mockIsAdmin = false;
  let mockProcs = [
    { name: 'ChatGPT.exe', clean_name: 'chatgpt', pids: [101, 102, 103], process_count: 10, threads: 259, memory: 1100 * 1024 * 1024, exe_path: 'C:\\Program Files\\WindowsApps\\OpenAI\\ChatGPT.exe', is_system: false, is_self: false, self_protected_count: 0 },
    { name: 'msedgewebview2.exe', clean_name: 'msedgewebview2', pids: [201, 202], process_count: 12, threads: 120, memory: 800 * 1024 * 1024, exe_path: 'C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\msedgewebview2.exe', is_system: false, is_self: false, self_protected_count: 4 },
    { name: 'WatchdogSvc.exe', clean_name: 'watchdogsvc', pids: [301, 302], process_count: 2, threads: 16, memory: 120 * 1024 * 1024, exe_path: 'C:\\Program Files\\Vendor\\WatchdogSvc.exe', is_system: false, is_self: false, self_protected_count: 0 },
    { name: 'PplGuard.exe', clean_name: 'pplguard', pids: [401], process_count: 1, threads: 8, memory: 90 * 1024 * 1024, exe_path: 'C:\\Program Files\\Guard\\PplGuard.exe', is_system: false, is_self: false, self_protected_count: 0 }
  ];
  let mockStartup = [
    { id: 'folder_user_MyTool.lnk', name: 'MyTool', command: 'C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\MyTool.lnk', exe_path: 'C:\\Tools\\MyTool.exe', exists: true, enabled: true, status: 'enabled', location: '用户启动目录', scope: 'user', source_type: 'folder', hive: '', key: '', file_path: 'C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\MyTool.lnk' },
    { id: 'HKCU_BrokenApp', name: 'BrokenApp', command: 'C:\\Missing\\app.exe', exe_path: 'C:\\Missing\\app.exe', exists: false, enabled: true, status: 'broken', location: '当前用户注册表', scope: 'user', source_type: 'registry', hive: 'HKCU', key: 'Software\\Microsoft\\Windows\\CurrentVersion\\Run', file_path: '' }
  ];
  let perfSeq = 0;
  let closeCalls = [];

  sandbox.API.isAdmin = async () => mockIsAdmin;
  sandbox.API.engine = async (method, params) => {
    if (method === 'apps.list') {
      return { items: [{ name: 'BigStudio', version: '1.0', size: 2 * 1024 ** 3, install_path: '"C:\\Program Files\\BigStudio"' }], total: 1 };
    }
    if (method === 'process.list') {
      return { items: mockProcs.slice(), total_count: mockProcs.length, raw_count: mockProcs.reduce((s, x) => s + x.process_count, 0), total_memory: mockProcs.reduce((s, x) => s + x.memory, 0) };
    }
    if (method === 'process.close') {
      closeCalls.push(Object.assign({}, params));
      if (params.name === 'chatgpt' && !params.force) {
        return { ok: true, name: 'chatgpt', was_running: true, initial_count: 10, terminated_count: 0, remaining_count: 10, closed: false, still_running: true, admin_required: false, respawned: false, reason: 'graceful_no_window', message: '该应用当前在后台驻留（无可见主窗口），优雅通知无法关闭，仍有 10 个进程在运行' };
      }
      if (params.name === 'chatgpt' && params.force) {
        mockProcs = mockProcs.filter((x) => x.clean_name !== 'chatgpt');
        return { ok: true, name: 'chatgpt', was_running: true, initial_count: 10, terminated_count: 10, remaining_count: 0, closed: true, still_running: false, admin_required: false, respawned: false, reason: 'closed' };
      }
      if (params.name === 'msedgewebview2') {
        return { ok: true, name: 'msedgewebview2', was_running: true, initial_count: 8, terminated_count: 8, remaining_count: 0, skipped_self_count: 4, closed: true, still_running: false, admin_required: false, respawned: false, reason: 'closed' };
      }
      if (params.name === 'watchdogsvc') {
        return { ok: true, name: 'watchdogsvc', was_running: true, initial_count: 2, terminated_count: 2, remaining_count: 2, closed: false, still_running: true, admin_required: false, respawned: true, reason: 'respawned_by_service_or_watchdog' };
      }
      if (params.name === 'pplguard') {
        return { ok: true, name: 'pplguard', was_running: true, initial_count: 1, terminated_count: 0, remaining_count: 1, closed: false, still_running: true, admin_required: true, respawned: false, reason: 'access_denied' };
      }
      return { ok: true, was_running: false, closed: false, still_running: false };
    }
    if (method === 'startup.list') {
      return { total: mockStartup.length, enabled_count: 1, disabled_count: 0, broken_count: 1, items: mockStartup.map((x) => Object.assign({}, x)) };
    }
    if (method === 'startup.toggle') {
      return { ok: true, name: params.name, enabled: params.enabled, new_file_path: params.file_path + '.disabled' };
    }
    if (method === 'system.performance') {
      perfSeq += 1;
      const cpuPct = perfSeq === 1 ? 11.0 : 42.5;
      const usedC = perfSeq === 1 ? 150 * 1024 ** 3 : 170 * 1024 ** 3;
      return {
        timestamp: Date.now(),
        drives: [{ drive: 'C:\\', letter: 'C', label: '系统', drive_type: 'fixed', total: 256 * 1024 ** 3, used: usedC, free: (256 * 1024 ** 3) - usedC, percent: perfSeq === 1 ? 58.6 : 66.4, is_system: true }],
        disk_summary: { total: 256 * 1024 ** 3, used: usedC, free: (256 * 1024 ** 3) - usedC, percent: perfSeq === 1 ? 58.6 : 66.4 },
        disk_io: { read_bps: perfSeq * 2 * 1024 * 1024, write_bps: 1024 * 1024, total_bps: (perfSeq * 2 + 1) * 1024 * 1024 },
        network_io: { in_bps: perfSeq * 100 * 1024, out_bps: 20 * 1024, total_bps: (perfSeq * 100 + 20) * 1024 },
        memory: { total: 32 * 1024 ** 3, available: 16 * 1024 ** 3, used: 16 * 1024 ** 3, percent: perfSeq === 1 ? 45 : 52 },
        cpu: { percent: cpuPct, cores: 16 }
      };
    }
    return origEngine(method, params);
  };

  const appsHost18 = new FakeElement('div');
  const umApps18 = await sandbox.Pages.apps.mount(appsHost18);
  await new Promise((r) => setTimeout(r, 30));

  // 18a. 改名检查：可见 UI 不得出现「空间画像」，Tab 与标题必须为「资源概览」/「系统资源与存储概览」
  const allAppsTxt = txt(appsHost18);
  if (allAppsTxt.includes('空间画像') || !allAppsTxt.includes('资源概览') || !allAppsTxt.includes('系统资源与存储概览')) {
    console.error('[红队回归 18] 「空间画像」未完整更名为「资源概览」/「系统资源与存储概览」');
    process.exit(1);
  }

  // 18b. 后台进程：ChatGPT.exe 优雅关闭失败 + 用户点取消 -> 绝不弹成功 ok toast，且弹窗按钮正确显示「强制终止 (10)」！
  await sandbox.Pages.apps.jump({ tab: 'procs', filter: '' });
  await new Promise((r) => setTimeout(r, 30));
  const findCloseBtnFor = (host, procName) => {
    const trs = findNodes(host, (n) => n.tagName === 'TR' && txt(n).includes(procName));
    if (!trs.length) return null;
    return findNodes(trs[0], (n) => n.tagName === 'BUTTON' && txt(n).includes('结束'))[0] || null;
  };
  clearToasts(); closeCalls.length = 0; modalRoot18.children = [];
  clickBtn(findCloseBtnFor(appsHost18, 'ChatGPT.exe'));
  await new Promise((r) => setTimeout(r, 270)); // 等待 UI.busy 220ms 最小展示时长
  const hasForceBtnLabel = txt(modalRoot18).includes('强制终止 (10)');
  if (!hasForceBtnLabel || !clickModalBtn('取消')) {
    console.error(`[红队回归 18] 优雅关闭失败未弹出「强制终止 (10)」确认框: modal=${txt(modalRoot18)}, calls=${closeCalls.length}`);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 40));
  const toastsCancel = getToasts();
  if (toastsCancel.some((t) => t.kind === 'ok') || !toastsCancel.some((t) => t.kind === 'warn') || closeCalls.length !== 1) {
    console.error(`[红队回归 18] 取消强制终止后竟假报成功: toasts=${JSON.stringify(toastsCancel)}, calls=${closeCalls.length}`);
    process.exit(1);
  }

  // 18c. 后台进程：ChatGPT.exe 优雅关闭失败 + 用户点「强制终止 (10)」 -> 触发 force:true、真实成功并从列表消失
  clearToasts(); closeCalls.length = 0; modalRoot18.children = [];
  clickBtn(findCloseBtnFor(appsHost18, 'ChatGPT.exe'));
  await new Promise((r) => setTimeout(r, 270));
  if (!clickModalBtn('强制终止')) {
    console.error('[红队回归 18] 未找到「强制终止」确认按钮');
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 280));
  const toastsForce = getToasts();
  if (closeCalls.length !== 2 || closeCalls[1].force !== true || !toastsForce.some((t) => t.kind === 'ok' && t.msg.includes('已彻底关闭')) || findCloseBtnFor(appsHost18, 'ChatGPT.exe')) {
    console.error(`[红队回归 18] 强制终止流程异常: calls=${JSON.stringify(closeCalls)}, toasts=${JSON.stringify(toastsForce)}`);
    process.exit(1);
  }

  // 18d. 后台进程：混合 WebView2 跳过轻盘自身 4 个进程 -> 明确告知自动保护
  clearToasts();
  clickBtn(findCloseBtnFor(appsHost18, 'msedgewebview2.exe'));
  await new Promise((r) => setTimeout(r, 280));
  const toastsSelf = getToasts();
  if (!toastsSelf.some((t) => t.kind === 'ok' && t.msg.includes('自动保护轻盘自身 4 个进程'))) {
    console.error(`[红队回归 18] 混合进程组未提示自动保护轻盘自身进程: ${JSON.stringify(toastsSelf)}`);
    process.exit(1);
  }

  // 18e. 后台进程：被服务/守护程序复生 -> 严禁弹 ok，必须弹 warn 提示复生
  clearToasts(); modalRoot18.children = [];
  clickBtn(findCloseBtnFor(appsHost18, 'WatchdogSvc.exe'));
  await new Promise((r) => setTimeout(r, 270));
  clickModalBtn('强制终止');
  await new Promise((r) => setTimeout(r, 280));
  const toastsRespawn = getToasts();
  if (toastsRespawn.some((t) => t.kind === 'ok') || !toastsRespawn.some((t) => t.kind === 'warn' && t.msg.includes('重新拉起'))) {
    console.error(`[红队回归 18] 服务复生进程未给出诚实警告: ${JSON.stringify(toastsRespawn)}`);
    process.exit(1);
  }

  // 18f. 后台进程：已是管理员模式仍遇 PPL/拒绝访问 -> 严禁再弹「是否以管理员重启」死循环，改弹 error 说明
  mockIsAdmin = true;
  umApps18();
  const appsHost18b = new FakeElement('div');
  const umApps18b = await sandbox.Pages.apps.mount(appsHost18b);
  await new Promise((r) => setTimeout(r, 40));
  await sandbox.Pages.apps.jump({ tab: 'procs', filter: '' });
  await new Promise((r) => setTimeout(r, 30));
  clearToasts(); modalRoot18.children = [];
  clickBtn(findCloseBtnFor(appsHost18b, 'PplGuard.exe'));
  await new Promise((r) => setTimeout(r, 280));
  const toastsPpl = getToasts();
  const openMasksPpl = findNodes(modalRoot18, (n) => n.classList && n.classList.contains('modal-mask'));
  if (openMasksPpl.length !== 0 || !toastsPpl.some((t) => t.kind === 'error' && t.msg.includes('已是管理员模式'))) {
    console.error(`[红队回归 18] 管理员模式下遇 PPL 拒绝访问仍触发重启死循环: masks=${openMasksPpl.length}, toasts=${JSON.stringify(toastsPpl)}`);
    process.exit(1);
  }

  // 18g. 开机自启：jump({ tab: 'startup', status: 'broken' }) 不再报 setStartupView ReferenceError；切换目录启动项同步更新 command
  await sandbox.Pages.apps.jump({ tab: 'startup', status: 'broken', filter: '' });
  await new Promise((r) => setTimeout(r, 25));
  const brokenTxt = txt(appsHost18b);
  if (!brokenTxt.includes('BrokenApp') || brokenTxt.includes('MyTool')) {
    console.error('[红队回归 18] startup jump status=broken 未正确筛选失效项');
    process.exit(1);
  }
  await sandbox.Pages.apps.jump({ tab: 'startup', status: 'all', filter: '' });
  await new Promise((r) => setTimeout(r, 25));
  const myToolTr = findNodes(appsHost18b, (n) => n.tagName === 'TR' && txt(n).includes('MyTool'))[0];
  const disableBtn = findNodes(myToolTr, (n) => n.tagName === 'BUTTON' && (n.attributes['aria-label'] === '禁用' || n.attributes.title === '禁用'))[0];
  clickBtn(disableBtn);
  await new Promise((r) => setTimeout(r, 35));
  const afterToggleTr = findNodes(appsHost18b, (n) => n.tagName === 'TR' && txt(n).includes('MyTool'))[0];
  if (!afterToggleTr || !txt(afterToggleTr).includes('MyTool.lnk.disabled')) {
    console.error('[红队回归 18] 启动文件夹项禁用后 command 列未同步更新为 .disabled 路径');
    process.exit(1);
  }

  // 18h. 资源概览：jump({ tab: 'overview' }) 兼容路由 + 连续采样必须实时刷新 .chart-cur-val 与磁盘分区已用文本
  perfSeq = 0;
  await sandbox.Pages.apps.jump({ tab: 'overview' });
  await new Promise((r) => setTimeout(r, 35));
  const cpuCard1 = findNodes(appsHost18b, (n) => n.id === 'fp-chart-card-cpu-ram')[0];
  const curVal1 = cpuCard1 && findNodes(cpuCard1, (n) => n.classList && n.classList.contains('chart-cur-val'))[0];
  const driveRow1 = findNodes(appsHost18b, (n) => n.id === 'fp-drive-row-C')[0];
  if (!curVal1 || !txt(curVal1).includes('11%') || !driveRow1 || !txt(driveRow1).includes('58.6%')) {
    console.error(`[红队回归 18] 资源概览首次采样渲染异常: curVal=${txt(curVal1)}, drive=${txt(driveRow1)}`);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 1650));
  const cpuCard2 = findNodes(appsHost18b, (n) => n.id === 'fp-chart-card-cpu-ram')[0];
  const curVal2 = cpuCard2 && findNodes(cpuCard2, (n) => n.classList && n.classList.contains('chart-cur-val'))[0];
  const driveRow2 = findNodes(appsHost18b, (n) => n.id === 'fp-drive-row-C')[0];
  if (!curVal2 || !txt(curVal2).includes('42.5%') || !driveRow2 || !txt(driveRow2).includes('66.4%')) {
    console.error(`[红队回归 18] 资源概览实时轮询未刷新 .chart-cur-val 或分区水位: curVal=${txt(curVal2)}, drive=${txt(driveRow2)}`);
    process.exit(1);
  }

  umApps18b();
  sandbox.UI.closeModals();
  delete sandbox.document._byId['toasts'];
  sandbox.API.engine = origEngine;
  sandbox.API.isAdmin = origIsAdmin;
}

// 回归 19：整理文件页「整理选项」默认高亮「标准」预设、use_content 保持自动跟随设置、三档切换与「自定义」徽章、带引号路径粘贴与防异步覆写
{
  const txt = (n) => {
    if (!n) return '';
    let s = String(n._textContent || '');
    if (Array.isArray(n.children)) s += n.children.map(txt).join('');
    return s;
  };
  const clickBtn = (btn) => {
    if (!btn) return;
    if (btn.listeners && btn.listeners.click && btn.listeners.click.length) {
      btn.dispatchEvent(new sandbox.Event('click'));
    } else if (typeof btn.onclick === 'function') {
      btn.onclick();
    }
  };
  const origEngine = sandbox.API.engine;
  const origCfgGet = sandbox.API.configGet;
  const origInspect = sandbox.API.inspectPath;

  let lastScanParams = null;
  let releaseDelayedSettings = null;
  let delaySettings = false;

  sandbox.API.configGet = async () => ({ last_folder: '' });
  sandbox.API.inspectPath = async (p) => ({ status: 'ok', kind: 'dir', path: p, readable: true });
  sandbox.API.engine = async (method, params) => {
    if (method === 'settings.get') {
      const payload = { default_recursive: false, default_content: true, conflict_policy: 'rename' };
      if (delaySettings) {
        return await new Promise((resolve) => { releaseDelayedSettings = () => resolve(payload); });
      }
      return payload;
    }
    if (method === 'scan') {
      lastScanParams = params;
      return { plans: [], blocked: [], total: 0, total_size: 0 };
    }
    return origEngine(method, params);
  };

  // 19a. 工厂默认 settings.get 返回后，「标准」预设必须保持高亮（不再全部熄灭），use_content 为 null（跟随设置）
  const orgHost19 = new FakeElement('div');
  const umOrg19 = await sandbox.Pages.organize.mount(orgHost19);
  await new Promise((r) => setTimeout(r, 30));
  const segBtns = findNodes(orgHost19, (n) => n.tagName === 'BUTTON' && n.classList && n.classList.contains('chip'));
  const btnStd = segBtns.find((b) => txt(b) === '标准');
  const btnAll = segBtns.find((b) => txt(b) === '全部文件');
  const btnCareful = segBtns.find((b) => txt(b) === '谨慎');
  const customBadge = findNodes(orgHost19, (n) => n.classList && n.classList.contains('badge') && txt(n) === '自定义')[0];
  if (!btnStd || !btnStd.classList.contains('active') || btnStd.getAttribute('aria-pressed') !== 'true' || !customBadge || !customBadge.hidden) {
    console.error(`[红队回归 19] 打开整理页默认「标准」预设未高亮或误显自定义: stdActive=${btnStd && btnStd.classList.contains('active')}, customHidden=${customBadge && customBadge.hidden}`);
    process.exit(1);
  }

  // 19b. 点击「全部文件」与「谨慎」切换，并验证带双引号路径粘贴 + 扫描参数精确传递
  clickBtn(btnAll);
  if (!btnAll.classList.contains('active') || btnStd.classList.contains('active')) {
    console.error('[红队回归 19] 点击「全部文件」预设未切换高亮');
    process.exit(1);
  }
  const pathInp = findNodes(orgHost19, (n) => n.tagName === 'INPUT' && n.classList && n.classList.contains('grow'))[0];
  const scanBtn = findNodes(orgHost19, (n) => n.tagName === 'BUTTON' && txt(n).includes('扫描'))[0];
  pathInp.value = '"D:\\Downloads\\Release.v1.46.1"';
  clickBtn(scanBtn);
  await new Promise((r) => setTimeout(r, 270));
  if (!lastScanParams || lastScanParams.paths[0] !== 'D:\\Downloads\\Release.v1.46.1' || lastScanParams.recursive !== true || lastScanParams.skip_recent !== false || lastScanParams.use_content !== null) {
    console.error(`[红队回归 19] 带引号路径剥离或全部文件扫描参数异常: ${JSON.stringify(lastScanParams)}`);
    process.exit(1);
  }

  // 19c. 手动拨动「含子文件夹」脱离预设 -> 必须显示「自定义」徽章；再拨回原组合应自动恢复高亮
  const findCheckByLabel = (host, kw) => {
    const lbl = findNodes(host, (n) => n.tagName === 'LABEL' && txt(n).includes(kw))[0];
    return lbl ? findNodes(lbl, (n) => n.tagName === 'INPUT' && (n.type === 'checkbox' || n.getAttribute('type') === 'checkbox'))[0] : null;
  };
  const chkRecursive = findCheckByLabel(orgHost19, '含子文件夹');
  const chkSkipRecent = findCheckByLabel(orgHost19, '跳过最近修改');
  const chkShortcuts = findCheckByLabel(orgHost19, '跳过快捷方式');
  if (!chkRecursive || !chkSkipRecent || !chkShortcuts) {
    console.error('[红队回归 19] 未找到整理选项关键复选框');
    process.exit(1);
  }
  chkRecursive.checked = false;
  chkRecursive.dispatchEvent({ type: 'change', target: chkRecursive });
  if (btnAll.classList.contains('active') || customBadge.hidden) {
    console.error(`[红队回归 19] 手动改开关后未显示「自定义」徽章: customHidden=${customBadge.hidden}`);
    process.exit(1);
  }
  // 拨回「含子文件夹」=true，应自动恢复命中「全部文件」并隐藏「自定义」
  chkRecursive.checked = true;
  chkRecursive.dispatchEvent({ type: 'change', target: chkRecursive });
  if (!btnAll.classList.contains('active') || !customBadge.hidden) {
    console.error('[红队回归 19] 手动拨回全部文件组合后未自动恢复预设高亮');
    process.exit(1);
  }
  // 把「谨慎」切过去（min_age=60, conflict=skip），确认命中；再切回「标准」确认回显正常
  clickBtn(btnCareful);
  if (!btnCareful.classList.contains('active') || !customBadge.hidden) {
    console.error('[红队回归 19] 点击「谨慎」预设未高亮');
    process.exit(1);
  }
  // 处于「谨慎」（min_age=60）时，关闭 skip_recent + 开启 recursive + 关闭 shortcuts + 改回 rename，应忽略禁用态 min_age=60 命中「全部文件」
  chkSkipRecent.checked = false;
  chkSkipRecent.dispatchEvent({ type: 'change', target: chkSkipRecent });
  chkRecursive.checked = true;
  chkRecursive.dispatchEvent({ type: 'change', target: chkRecursive });
  chkShortcuts.checked = false;
  chkShortcuts.dispatchEvent({ type: 'change', target: chkShortcuts });
  const conflictSel = findNodes(orgHost19, (n) => n.classList && n.classList.contains('custom-select') && txt(n).includes('重命名'))[0];
  if (!conflictSel) {
    console.error('[红队回归 19] 未找到重名处理下拉框');
    process.exit(1);
  }
  const renameOpt = findNodes(conflictSel, (n) => n.classList && n.classList.contains('custom-select-item') && txt(n).includes('重命名'))[0];
  if (!renameOpt) {
    console.error('[红队回归 19] 未找到重命名选项');
    process.exit(1);
  }
  renameOpt.dispatchEvent({ type: 'click', target: renameOpt, stopPropagation() {} });
  if (!btnAll.classList.contains('active') || !customBadge.hidden) {
    console.error(`[红队回归 19] skip_recent=false 时禁用态 min_age=60 阻碍了识别「全部文件」: allActive=${btnAll.classList.contains('active')}, customHidden=${customBadge.hidden}`);
    process.exit(1);
  }
  umOrg19();

  // 19d. 异步 settings.get 延迟返回：用户已先点「谨慎」时，绝不得被迟到的 settings.get 覆写
  delaySettings = true;
  const orgHost19b = new FakeElement('div');
  const mountP19b = sandbox.Pages.organize.mount(orgHost19b);
  await new Promise((r) => setTimeout(r, 20));
  const btnCareful2 = findNodes(orgHost19b, (n) => n.tagName === 'BUTTON' && txt(n) === '谨慎')[0];
  clickBtn(btnCareful2);
  if (releaseDelayedSettings) releaseDelayedSettings();
  const umOrg19b = await mountP19b;
  if (!btnCareful2.classList.contains('active')) {
    console.error('[红队回归 19] 迟到的 settings.get 覆写了用户已点击的「谨慎」预设');
    process.exit(1);
  }
  umOrg19b();

  sandbox.API.engine = origEngine;
  sandbox.API.configGet = origCfgGet;
  sandbox.API.inspectPath = origInspect;
}

console.log(`结果：${count}/${count} 页面双轮挂载、销毁、防泄漏回归全绿（0 崩溃、0 累积定时器/监听器，含后台进程真实关闭核验、开机自启排雷、资源概览实时监控与全站红队回归）`);
process.exit(0);
