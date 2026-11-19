/* AI 助手 · 作用域自测
   ------------------------------------------------------------
   跑法：node src/web/js/ai/scope.selftest.mjs
   纯离线：只读源码文本，不加载 DOM、不连网络。

   为什么要有这个文件
   1.36.19 把 policyFor 提到模块作用域时，顺手把函数体里的
   `state.thinking` 一起带了上去 —— 而 state 是 create() 里的局部变量。
   语法完全合法，`node --check` 也通过，只有真跑到那一行才炸：

     ReferenceError: state is not defined

   炸的位置又正好在 ask() 里 try/catch 之外、setBusy(true) 之后，
   于是 running 永远停在 true，输入框永久只读、停止键也按不动。
   同一个坑 1.36.17 已经踩过一次（normEndpoint is not defined）。

   这类错误机器一眼就能看出来：某个标识符在文件里被声明过，
   但引用它的那个位置，沿作用域链往上根本走不到那份声明。
   下面就是照这个口径写的检查 —— 不做完整 JS 解析，
   只把「声明在哪个作用域」和「引用出现在哪个作用域」对齐。 */
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const results = [];
let seq = 0;
function test(name, fn) {
  seq += 1;
  const id = 'P' + String(seq).padStart(2, '0');
  const bad = [];
  try {
    fn((m) => bad.push(m));
  } catch (e) {
    bad.push('抛异常：' + ((e && e.message) || e));
  }
  results.push({ id, name, pass: bad.length === 0, why: bad.join('；') });
}

/* ============================================================
   1. 词法：把注释、字符串、正则都抹成空格，保留长度与换行
   ============================================================ */

const REGEX_PREV = new Set('(,=:[!&|?{};+-*%<>~^'.split(''));
/* 这些关键字后面出现的 `/` 一定是正则开头，不是除号 */
const REGEX_KEYWORDS = new Set((
  'return typeof instanceof case in of delete void throw new do else yield await'
).split(' '));

function stripNoise(src) {
  const out = src.split('');
  const n = src.length;
  let i = 0;
  /* 模板字符串里 ${...} 是代码，需要递归；用栈记住当前是否在模板里 */
  const tmplStack = [];

  function blank(from, to) {
    for (let k = from; k < to && k < n; k += 1) {
      if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
    }
  }

  function prevSignificant(pos) {
    for (let k = pos - 1; k >= 0; k -= 1) {
      const c = out[k];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') continue;
      return c;
    }
    return '';
  }

  /* 上一个完整单词：用来判断 `return /re/` 这种。
     注意 out 是字符数组，slice 出来要拼回字符串再比较。 */
  function prevWord(pos) {
    let end = pos - 1;
    while (end >= 0 && /\s/.test(out[end])) end -= 1;
    if (end < 0 || !/[A-Za-z0-9_$]/.test(out[end])) return '';
    let s = end;
    while (s > 0 && /[A-Za-z0-9_$]/.test(out[s - 1])) s -= 1;
    return out.slice(s, end + 1).join('');
  }

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];

    if (c === '/' && d === '/') {
      let j = i;
      while (j < n && src[j] !== '\n') j += 1;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '/' && d === '*') {
      let j = i + 2;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j += 1;
      blank(i, Math.min(j + 2, n));
      i = Math.min(j + 2, n);
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') j += 1;
        j += 1;
      }
      blank(i, Math.min(j + 1, n));
      i = Math.min(j + 1, n);
      continue;
    }
    if (c === '`') {
      /* 扫到配对的 ` ，途中遇到 ${ 就把里面当代码递归处理 */
      let j = i + 1;
      let segStart = i;
      let depth = 0;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (depth === 0 && src[j] === '`') break;
        if (src[j] === '$' && src[j + 1] === '{') {
          depth += 1;
          j += 2;
          continue;
        }
        if (depth > 0 && src[j] === '}') { depth -= 1; j += 1; continue; }
        j += 1;
      }
      /* 模板整体抹掉：${} 里的表达式这里不追，代价是漏检，
         收益是绝不会把字符串当代码误报。宁可少报，不可误报。 */
      blank(segStart, Math.min(j + 1, n));
      i = Math.min(j + 1, n);
      continue;
    }
    if (c === '/' && (REGEX_PREV.has(prevSignificant(i)) || REGEX_KEYWORDS.has(prevWord(i)))) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        const ch = src[j];
        if (ch === '\\') { j += 2; continue; }
        if (ch === '\n') break;
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) { closed = true; break; }
        j += 1;
      }
      if (closed) {
        j += 1;
        while (j < n && /[a-z]/i.test(src[j])) j += 1;
        blank(i, j);
        i = j;
        continue;
      }
    }
    i += 1;
  }
  return out.join('');
}

/* ============================================================
   2. 作用域：函数/块各自成一个作用域，声明绑到最近的那层
   ============================================================ */

const KEYWORDS = new Set((
  'break case catch class const continue debugger default delete do else export extends ' +
  'finally for function if import in instanceof let new return super switch this throw try ' +
  'typeof var void while with yield await async of get set static true false null undefined'
).split(' '));

const BUILTINS = new Set((
  'window document console Math JSON Object Array String Number Boolean Promise Error ' +
  'Date RegExp Map Set WeakMap WeakSet Symbol parseInt parseFloat isNaN isFinite ' +
  'encodeURIComponent decodeURIComponent setTimeout clearTimeout setInterval clearInterval ' +
  'requestAnimationFrame cancelAnimationFrame fetch module exports require globalThis ' +
  'Intl URL URLSearchParams TextEncoder TextDecoder Blob File FormData AbortController ' +
  'structuredClone queueMicrotask process Buffer __dirname __filename'
).split(' '));

function tokenize(clean) {
  const toks = [];
  const n = clean.length;
  let i = 0;
  while (i < n) {
    const c = clean[i];
    if (/\s/.test(c)) { i += 1; continue; }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(clean[j])) j += 1;
      toks.push({ t: 'id', v: clean.slice(i, j), pos: i });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < n && /[0-9a-fx._eE+-]/i.test(clean[j])) {
        if ((clean[j] === '+' || clean[j] === '-') && !/[eE]/.test(clean[j - 1])) break;
        j += 1;
      }
      toks.push({ t: 'num', v: clean.slice(i, j), pos: i });
      i = j;
      continue;
    }
    toks.push({ t: 'p', v: c, pos: i });
    i += 1;
  }
  return toks;
}

/* 粗粒度但够用的作用域分析：
   - 每个 `{` 开一层作用域；函数体也算（参数绑到函数作用域）
   - `let/const/var/function/class` 后面的名字绑到当前作用域
   - 其余标识符算引用，绑到「从当前作用域往外找得到的第一份声明」 */
function analyze(clean) {
  const toks = tokenize(clean);
  const scopes = [{ parent: null, names: new Set(), kind: 'module' }];
  const refs = [];      // { name, scope, pos }
  const decls = [];     // { name, scope, pos }
  const stack = [0];

  const cur = () => scopes[stack[stack.length - 1]];

  function declare(name, pos) {
    cur().names.add(name);
    decls.push({ name, scope: stack[stack.length - 1], pos });
  }

  /* 参数也算声明：function f(a, b) / (a, b) => */
  function declareParams(fromIdx, toIdx) {
    for (let k = fromIdx; k < toIdx; k += 1) {
      const tk = toks[k];
      if (tk && tk.t === 'id' && !KEYWORDS.has(tk.v)) {
        const prev = toks[k - 1];
        const next = toks[k + 1];
        if (prev && (prev.v === '.' || prev.v === '...')) continue;
        if (next && next.v === ':') continue;   // 对象解构的键
        declare(tk.v, tk.pos);
      }
    }
  }

  let pendingDecl = 0;   // 刚读到 let/const/var，后面这段名字都要声明
  let pendingParams = -1;
  /* let a = 1, b = 2 —— 逗号之后仍在同一条声明里，要继续认名字。
     记下声明开始时的括号/花括号深度，退出这层就作废。 */
  let declDepth = -1;
  let depth = 0;

  /* 从开括号找配对的闭括号 */
  function matchParen(from) {
    let d = 0;
    for (let k = from; k < toks.length; k += 1) {
      const v = toks[k].v;
      if (toks[k].t !== 'p') continue;
      if (v === '(' || v === '[' || v === '{') d += 1;
      else if (v === ')' || v === ']' || v === '}') {
        d -= 1;
        if (d === 0) return k;
      }
    }
    return -1;
  }

  for (let idx = 0; idx < toks.length; idx += 1) {
    const tk = toks[idx];
    const prev = toks[idx - 1];
    const next = toks[idx + 1];

    if (tk.t === 'p' && (tk.v === '(' || tk.v === '[')) depth += 1;
    if (tk.t === 'p' && (tk.v === ')' || tk.v === ']')) depth -= 1;
    if (declDepth >= 0 && depth < declDepth) { declDepth = -1; pendingDecl = 0; }

    if (tk.t === 'p' && tk.v === '{') {
      scopes.push({ parent: stack[stack.length - 1], names: new Set(), kind: 'block' });
      stack.push(scopes.length - 1);
      pendingDecl = 0;
      declDepth = -1;
      continue;
    }
    if (tk.t === 'p' && tk.v === '}') {
      if (stack.length > 1) stack.pop();
      pendingDecl = 0;
      declDepth = -1;
      continue;
    }
    if (tk.t === 'p' && tk.v === '(') {
      const close = matchParen(idx);
      const after = close >= 0 ? toks[close + 1] : null;
      const isArrow = after && after.t === 'p' && after.v === '=' &&
        toks[close + 2] && toks[close + 2].v === '>';
      /* 方法简写 / getter：`name(a, b) {` 或 `get name() {`
         —— 名字不是引用，括号里是形参 */
      const isMethod = after && after.t === 'p' && after.v === '{' &&
        prev && prev.t === 'id' && !KEYWORDS.has(prev.v);
      if (isArrow || isMethod) {
        declareParams(idx + 1, close);
        idx = close;
        continue;
      }
      if (prev && prev.t === 'id' && (prev.v === 'function' || beforeIsFnName(toks, idx))) {
        pendingParams = idx;
      }
      continue;
    }
    if (tk.t === 'p' && tk.v === ')') {
      if (pendingParams >= 0) { declareParams(pendingParams + 1, idx); pendingParams = -1; }
      continue;
    }
    /* 单参数箭头：`m => ...` */
    if (tk.t === 'id' && next && next.t === 'p' && next.v === '=' &&
        toks[idx + 2] && toks[idx + 2].v === '>' && !KEYWORDS.has(tk.v)) {
      declare(tk.v, tk.pos);
      idx += 2;
      continue;
    }

    if (tk.t === 'id') {
      if (tk.v === 'let' || tk.v === 'const' || tk.v === 'var') {
        pendingDecl = 1; declDepth = depth; continue;
      }
      if (tk.v === 'function' || tk.v === 'class') { pendingDecl = 2; continue; }
      if (tk.v === 'catch') { pendingDecl = 1; declDepth = depth; continue; }

      const afterDot = prev && prev.v === '.';
      const isKey = next && next.v === ':' && prev && (prev.v === '{' || prev.v === ',');
      const isMember = afterDot;
      /* 方法简写的名字：`name(` 且不在声明位置 —— 名字本身不是引用。
         get/set 后面那个名字同理（`get running() {`）。 */
      const isMethodName = next && next.v === '(' && !pendingDecl &&
        prev && (prev.v === '{' || prev.v === ',' || prev.v === 'get' || prev.v === 'set' ||
          prev.v === 'static' || prev.v === 'async' || prev.v === ';' || prev.v === '}');

      if (!isMember && !isKey && !isMethodName && pendingDecl) {
        declare(tk.v, tk.pos);
        pendingDecl = 0;
        continue;
      }
      if (!isMember && !isKey && !isMethodName && !KEYWORDS.has(tk.v)) {
        refs.push({ name: tk.v, scope: stack[stack.length - 1], pos: tk.pos });
      }
      continue;
    }
    /* 声明列表里的逗号：后面还是名字 */
    if (tk.t === 'p' && tk.v === ',' && declDepth >= 0 && depth === declDepth) {
      pendingDecl = 1;
      continue;
    }
    if (tk.t === 'p' && tk.v === ';') { pendingDecl = 0; declDepth = -1; continue; }
  }

  /* 解析每条引用：沿作用域链往上找 */
  function resolve(name, scopeIdx) {
    let s = scopeIdx;
    while (s !== null && s !== undefined) {
      if (scopes[s].names.has(name)) return s;
      s = scopes[s].parent;
    }
    return -1;
  }

  /* 每个名字在哪些作用域里被声明过 */
  const declScopes = new Map();
  decls.forEach((d) => {
    if (!declScopes.has(d.name)) declScopes.set(d.name, new Set());
    declScopes.get(d.name).add(d.scope);
  });

  const problems = [];
  refs.forEach((r) => {
    if (BUILTINS.has(r.name)) return;
    const hit = resolve(r.name, r.scope);
    if (hit >= 0) return;
    /* 链上找不到 —— 如果这个名字在本文件别处被声明过，那就是本文件内的
       作用域错位（真正的 bug）；从没声明过的多半是外部全局，放行。 */
    const elsewhere = declScopes.get(r.name);
    if (!elsewhere || !elsewhere.size) return;
    problems.push({ name: r.name, pos: r.pos });
  });

  /* 同一处重复只报一次 */
  const seen = new Set();
  return problems.filter((p) => {
    const k = p.name + '@' + p.pos;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function beforeIsFnName(toks, idx) {
  /* 处理 `const f = function (a)` 与 `function name (` 两种 */
  const p1 = toks[idx - 1];
  if (!p1) return false;
  if (p1.v === 'function') return true;
  const p2 = toks[idx - 2];
  if (p1.t === 'id' && p2 && p2.v === 'function') return true;
  return false;
}

function lineOf(src, pos) {
  let line = 1;
  for (let k = 0; k < pos && k < src.length; k += 1) if (src[k] === '\n') line += 1;
  return line;
}

function scanFile(file) {
  const src = readFileSync(file, 'utf8');
  const clean = stripNoise(src);
  const problems = analyze(clean);
  return problems.map((p) => ({
    file,
    line: lineOf(src, p.pos),
    name: p.name,
    text: (src.split(/\r?\n/)[lineOf(src, p.pos) - 1] || '').trim()
  }));
}

/* ============================================================
   3. 用例
   ============================================================ */

const AI_DIR = here;
const FILES = readdirSync(AI_DIR).filter((f) => f.endsWith('.js')).sort();

test('自检器能抓到「模块作用域读函数内局部变量」这类错', (fail) => {
  const bad = 'const M = {};\nM.f = function (x) { return x + inner; };\nfunction g() { var inner = 1; return inner; }\n';
  const found = analyze(stripNoise(bad));
  if (!found.some((p) => p.name === 'inner')) fail('应报出 inner，实际：' + JSON.stringify(found.map((p) => p.name)));
});

test('自检器不误报正常闭包', (fail) => {
  const good = 'const M = {};\nfunction outer() { var k = 1; return function () { return k; }; }\nM.x = outer();\n';
  const found = analyze(stripNoise(good));
  if (found.length) fail('不该报错，实际：' + JSON.stringify(found.map((p) => p.name)));
});

test('自检器不把字符串和注释里的词当引用', (fail) => {
  const good = 'var s = "state is not defined";\n/* state 只在注释里 */\nfunction f() { var state = 1; return state; }\n';
  const found = analyze(stripNoise(good));
  if (found.length) fail('不该报错，实际：' + JSON.stringify(found.map((p) => p.name)));
});

test('自检器认得属性访问不算引用', (fail) => {
  const good = 'var o = { state: 1 };\nfunction f() { return o.state; }\n';
  const found = analyze(stripNoise(good));
  if (found.length) fail('不该报错，实际：' + JSON.stringify(found.map((p) => p.name)));
});

test('ai/ 下所有模块都没有作用域错位的引用', (fail) => {
  const all = [];
  FILES.forEach((f) => {
    const bad = scanFile(join(AI_DIR, f));
    bad.forEach((b) => all.push(b.file.split(/[\\/]/).pop() + ':' + b.line + '  ' + b.name + '  ← ' + b.text));
  });
  if (all.length) fail('发现 ' + all.length + ' 处：\n    ' + all.join('\n    '));
});

test('chatui.js 的 policyFor 不再碰 state', (fail) => {
  const src = readFileSync(join(AI_DIR, 'chatui.js'), 'utf8');
  const clean = stripNoise(src);
  const at = clean.indexOf('function policyFor');
  if (at < 0) { fail('找不到 policyFor'); return; }
  /* 取到函数体结束：从 function 起配对花括号 */
  let depth = 0;
  let started = false;
  let end = at;
  for (let k = at; k < clean.length; k += 1) {
    if (clean[k] === '{') { depth += 1; started = true; }
    else if (clean[k] === '}') { depth -= 1; if (started && depth === 0) { end = k; break; } }
  }
  const body = clean.slice(at, end + 1);
  if (/\bstate\b/.test(body)) fail('policyFor 里仍然出现 state：' + body.slice(0, 120));
});

test('policyFor 的档位由调用方显式传入', (fail) => {
  const src = readFileSync(join(AI_DIR, 'chatui.js'), 'utf8');
  const clean = stripNoise(src);
  if (!/function policyFor\s*\(\s*text\s*,\s*settings\s*,\s*level\s*\)/.test(clean)) {
    fail('policyFor 应接收第三个参数 level');
  }
  const calls = clean.match(/policyFor\s*\([^)]*\)/g) || [];
  const badCalls = calls.filter((c) => !/policyFor\s*\(/.test(c) ? false : c.split(',').length < 3);
  if (badCalls.length) fail('有调用没传第三参：' + badCalls.join(' / '));
});

test('ask 有兜底：抛错也要把 running 放回去', (fail) => {
  const src = readFileSync(join(AI_DIR, 'chatui.js'), 'utf8');
  const clean = stripNoise(src);
  const at = clean.indexOf('async function ask(');
  if (at < 0) { fail('找不到 ask()'); return; }
  const body = clean.slice(at, at + 900);
  if (!/try\s*\{/.test(body)) fail('ask() 里没有 try');
  if (!/catch\s*\(/.test(body)) fail('ask() 里没有 catch');
  if (!/state\.running\s*=\s*false/.test(body)) fail('catch 里没把 state.running 置回 false');
  if (!/setBusy\s*\(\s*false/.test(body)) fail('catch 里没把 composer 的 busy 解开');
});

/* ---------------- 输出 ---------------- */

const line = '─'.repeat(72);
console.log('');
results.forEach((r) => {
  console.log((r.pass ? 'PASS  ' : 'FAIL  ') + r.id + '  ' + r.name + (r.pass ? '' : '  · ' + r.why));
});
const bad = results.filter((r) => !r.pass);
console.log(line);
console.log('用例通过        ' + (results.length - bad.length) + '/' + results.length);
console.log('');
console.log(bad.length ? '结果：有 ' + bad.length + ' 条不通过' : '结果：全部通过');
console.log(line);
process.exit(bad.length ? 1 : 0);
