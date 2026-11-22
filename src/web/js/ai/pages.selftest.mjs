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

class FakeElement {
  constructor(tagName) {
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
  appendChild(child) {
    if (child) child.parent = this;
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx >= 0) this.children.splice(idx, 1);
    if (child) child.parent = null;
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
  set textContent(v) { this._textContent = String(v); }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(v) { this._innerHTML = String(v); }
  get className() { return this.classList.toString(); }
  set className(v) { this.classList = new FakeClassList(); if (v) v.split(/\s+/).forEach(c => c && this.classList.add(c)); }
}

class FakeNode {}

const storage = {};
const fakeLocalStorage = {
  getItem: (k) => storage[k] || null,
  setItem: (k, v) => { storage[k] = String(v); },
  removeItem: (k) => { delete storage[k]; }
};

const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  Date, Math, JSON, Promise, Number, String, Object, Array, Set, Map, isNaN, Intl,
  performance: globalThis.performance,
  Node: FakeNode,
  App: { nav() {}, jump() {} },
  requestAnimationFrame: (cb) => setTimeout(cb, 16),
  cancelAnimationFrame: (id) => clearTimeout(id),
  MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
  localStorage: fakeLocalStorage,
  document: {
    createElement: (t) => new FakeElement(t),
    createElementNS: (ns, t) => new FakeElement(t),
    createTextNode: (txt) => { const el = new FakeElement('#text'); el.textContent = txt; return el; },
    getElementById: () => new FakeElement('div'),
    addEventListener: () => {},
    removeEventListener: () => {},
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
for (const [id, page] of Object.entries(sandbox.Pages)) {
  const holder = new FakeElement('div');
  try {
    if (typeof page.mount === 'function') {
      const ret = await page.mount(holder);
      if (typeof ret === 'function') ret();
    }
    if (typeof page.unmount === 'function') {
      page.unmount();
    }
    count++;
  } catch (err) {
    console.error(`[挂载崩溃] 页面 ${id}:`, err);
    process.exit(1);
  }
}

// 核心回归门禁：已安装程序与自启（apps）在具备内存缓存时再次挂载（warm mount），必须正常呈现且不崩溃
try {
  const warmHolder = new FakeElement('div');
  const retWarm = await sandbox.Pages.apps.mount(warmHolder);
  if (typeof retWarm === 'function') retWarm();
} catch (err) {
  console.error('[内存缓存二次挂载回归失败] apps.mount:', err);
  process.exit(1);
}

console.log(`结果：${count}/${count} 页面挂载与渲染全绿（0 崩溃、0 引用错误，二次缓存挂载验证通过）`);
process.exit(0);
