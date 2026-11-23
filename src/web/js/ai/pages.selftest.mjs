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
    const check = (node) => {
      if (!node || !node.classList) return;
      let match = false;
      if (sel.startsWith('#') && node.id === sel.slice(1)) match = true;
      else if (sel.startsWith('.') && node.classList.contains(sel.slice(1))) match = true;
      else if (node.tagName && node.tagName.toLowerCase() === sel.toLowerCase()) match = true;
      else if (sel.includes('.')) {
        const [tag, cls] = sel.split('.');
        if ((!tag || (node.tagName && node.tagName.toLowerCase() === tag.toLowerCase())) && node.classList.contains(cls)) match = true;
      }
      if (match) res.push(node);
      for (const child of node.children) check(child);
    };
    for (const child of this.children) check(child);
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
  App: { nav() {}, jump() {} },
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
    releasesPage: 'https://github.com/3347567186/TidyAssistant/releases',
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
    downloadUrl: 'https://github.com/3347567186/TidyAssistant/releases/download/v9.9.9/app.zip',
    fileName: '整理助手_9.9.9_便携版.zip',
    size: 25 * 1024 * 1024,
    sha256: fakeSha,
    manifestUrl: 'https://github.com/3347567186/TidyAssistant/releases/latest/download/latest.json',
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

  const checkBtn = findNodes(rootSet, (n) => n.tagName === 'BUTTON' && txt(n).includes('立即检查更新'))[0];
  const urlInputs = findNodes(rootSet, (n) => n.tagName === 'INPUT' && (n.type === 'url' || (n.classList && n.classList.contains('upd-feed-input'))));
  const saveFeedBtn = findNodes(rootSet, (n) => n.tagName === 'BUTTON' && txt(n).includes('保存源'))[0];
  if (urlInputs.length > 0 || saveFeedBtn) {
    console.error(`[在线更新回归] 设置页不得出现填网址功能: urlInputs=${urlInputs.length}, saveFeedBtn=${!!saveFeedBtn}`);
    process.exit(1);
  }
  if (!checkBtn) {
    console.error('[在线更新回归] 设置页缺少「立即检查更新」按钮');
    process.exit(1);
  }
  clickBtn(checkBtn);
  await new Promise((r) => setTimeout(r, 30));

  const dlBtn = findNodes(rootSet, (n) => n.tagName === 'BUTTON' && txt(n).includes('下载更新包'))[0];
  if (!dlBtn || !txt(rootSet).includes('v9.9.9') || !txt(rootSet).includes('红队验证版本更新说明')) {
    console.error('[在线更新回归] 检查更新后未展示新版本卡片与下载按钮');
    process.exit(1);
  }

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

console.log(`结果：${count}/${count} 页面双轮挂载、销毁、防泄漏回归全绿（0 崩溃、0 累积定时器/监听器，二次缓存挂载、CSS 令牌、设置页/Steve/抽屉/日志页/全屏按钮/开发者边界/压缩包自定义目录、性能暂停流、冲突撤回、能力扩展钩子、外壳竞态与在线更新全链路校验通过）`);
process.exit(0);
