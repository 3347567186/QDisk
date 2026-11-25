/* 动作层自测：guard / registry / proposals 端到端走一遍。
   不连真引擎、不发网络请求，只验证闸门与接口对接。
   跑法：node src\web\js\ai\actions.selftest.mjs  （失败退出码 1） */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  Date, Math, JSON, Promise, Number, String, Object, Array, Set, Map, isNaN
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of ['guard.js', 'registry.js', 'proposals.js']) {
  vm.runInContext(fs.readFileSync(path.join(here, f), 'utf8'), sandbox, { filename: f });
}

const calls = [];
const FILES = {
  'D:\\Users\\me\\Downloads\\a.iso': 3_000_000_000,
  'D:\\Users\\me\\Downloads\\b.txt': 12_000,
  'C:\\Windows\\System32\\x.dll': 200_000
};
const size = (p) => FILES[p] || 0;

const engine = async (method, params) => {
  calls.push([method, params]);
  if (method === 'files.delete') {
    const items = (params.paths || []).map((p) => ({
      path: p, size: size(p), files: 1, exists: true, why: '', partial: false
    }));
    if (params.confirm) {
      return { dry_run: false, mode: params.mode, deleted: params.paths, failed: [], count: params.paths.length };
    }
    return {
      dry_run: true, paths: params.paths, mode: params.mode, items,
      failed: [], total_size: items.reduce((n, i) => n + i.size, 0), count: items.length
    };
  }
  if (method === 'scan') {
    return {
      plans: [{ folder: 'D:\\Users\\me\\Downloads', groups: [{ cat: '图片', count: 300 }, { cat: '压缩包', count: 45 }] }],
      total: 345, total_size: 900_000_000, blocked: 2
    };
  }
  if (method === 'organize') {
    if (!params.confirm) return { dry_run: true, plans: [{ cat: '图片', count: 2, size: 5000 }], total: 2, total_size: 5000 };
    return { dry_run: false, moved: 2, failed: [], history: [{ folder: 'D:\\X\\图片' }], total: 2 };
  }
  if (method === 'shots.clean') return { dry_run: true, would_delete: 1, would_free: 200000, failed: [] };
  if (method === 'settings.get') return { conflict_policy: 'rename', recursive_depth: 3 };
  if (method === 'settings.set') return { ok: true, key: params.key, value: params.value };
  if (method === 'undo') return { restored: 2, failed: [], folder: params.path };
  if (method === 'process.close') return { closed: true, pid: params.pid || 0, name: params.name || '' };
  if (method === 'cache.list') {
    return {
      groups: [{
        key: 'temp', name: '临时缓存',
        items: [{ level: 'safe', exists: true, size: 1024000, paths: ['D:\\Users\\me\\AppData\\Local\\Temp\\x'] }]
      }]
    };
  }
  if (method === 'shots.scan') return { items: [{ path: 'D:\\Users\\me\\Pictures\\Screenshots\\old.png', size: 204800 }], size: 204800 };
  if (method === 'clean.auto') return { ok: true, freed: 1228800 };
  if (method === 'search.status') return { backend: 'everything', entries: [{ root: 'D:\\Users\\me\\Downloads', files: 120 }] };
  if (method === 'search.selfcheck') return { ok: true, checked: 1 };
  if (method === 'rules.validate') return { ok: true, rule_count: 1 };
  throw new Error('未模拟的引擎方法 ' + method);
};

const API = {
  engine,
  openPath: async () => ({ ok: true }),
  listDir: async (dir) => ({
    items: dir.toLowerCase().includes('empty') ? [] : [{ name: 'x', dir: false }],
    total: dir.toLowerCase().includes('empty') ? 0 : 1
  }),
  appInfo: async () => ({
    exe_dir: 'D:\\Tools\\TidyAssistant',
    data_dir: 'C:\\Users\\me\\AppData\\Local\\整理助手数据'
  }),
  agentRoots: async () => ({ roots: ['C:\\', 'D:\\'], home: 'C:\\Users\\me' })
};

sandbox.AIGuard.configure({
  home: 'C:\\Users\\me',
  appDir: 'D:\\Tools\\TidyAssistant',
  dataDir: 'C:\\Users\\me\\AppData\\Local\\整理助手数据',
  roots: ['C:\\', 'D:\\']
});
sandbox.AIRulesDraft = {
  fill: (yaml) => { calls.push(['AIRulesDraft.fill', yaml]); return true; }
};
sandbox.App = {
  jump: (page, payload) => { calls.push(['App.jump', page, payload]); }
};

const journal = [];
const store = { aiStore: async (op, name, content) => { journal.push([op, name, content]); return ''; } };
const actions = sandbox.AIRegistry.create({ API });
const props = sandbox.AIProposals.create({ API, store, actions, policy: { mode: 'confirm' } });

const out = [];
const ok = (name, cond, extra) => out.push((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' · ' + extra : ''));
const clearQueue = async () => { for (const q of props.list()) await props.deny(q.id, 'test'); };

/* 1 目录与目录文本 */
ok('registry 动作数 ' + actions.ids.length, actions.ids.length === 25);
ok('catalog 可生成', String(actions.catalog()).length > 200);

/* 2 正常提议 */
let r = await props.propose({
  action: 'files.delete',
  args: { paths: ['D:\\Users\\me\\Downloads\\a.iso'], mode: 'trash' },
  reason: '最大的文件'
});
ok('提议成功', r.ok, r.error);
ok('卡片数量与体积', r.ok && r.proposal.card.count === 1 && r.proposal.card.bytes === 3_000_000_000,
  r.ok ? JSON.stringify(r.proposal.card.summary) : r.error);
ok('等用户确认（非自动）', r.ok && r.auto === false);

/* 3 模型不能自己执行 */
const bad = await props.commit(r.proposal.id, {});
ok('无 approvedBy 被拒', !bad.ok, bad.error);

/* 4 用户点了才执行 */
const good = await props.commit(r.proposal.id, { approvedBy: 'user' });
ok('用户确认后执行', good.ok, good.error);
ok('执行时带 confirm=true', calls.some((c) => c[0] === 'files.delete' && c[1].confirm === true));
ok('执行后给出撤销入口', !!(good.proposal && good.proposal.undo));

/* 5 系统目录要被拦 */
const g = await props.propose({
  action: 'files.delete',
  args: { paths: ['C:\\Windows\\System32\\x.dll'], mode: 'permanent' }
});
ok('系统目录提议被拒', !g.ok, g.error);

/* 6 关掉之后一律不接受 */
props.setPolicy(Object.assign({}, props.getPolicy(), { mode: 'off' }));
const off = await props.propose({ action: 'organize.apply', args: { paths: ['D:\\Users\\me\\Downloads'] } });
ok('off 档拒绝提议', !off.ok, off.error);
props.setPolicy(Object.assign({}, props.getPolicy(), { mode: 'confirm' }));

/* 7 一轮最多两个提案 */
props.startTurn();
await props.propose({ action: 'organize.apply', args: { paths: ['D:\\Users\\me\\Downloads'], recursive: false } });
await props.propose({ action: 'organize.apply', args: { paths: ['D:\\Users\\me\\Downloads'], recursive: false } });
const third = await props.propose({ action: 'organize.apply', args: { paths: ['D:\\Users\\me\\Downloads'], recursive: false } });
ok('一轮第三个提案被拒', !third.ok, third.error);

/* 8 过期时间 */
const pend = props.list();
ok('待确认队列非空', pend.length > 0);
if (pend.length) ok('TTL 是 10 分钟', Math.round((pend[0].expires - Date.now()) / 60000) <= 10);

/* 9 撤销整理 → 引擎 undo */
await clearQueue();
props.startTurn();
const org = await props.propose({ action: 'organize.apply', args: { paths: ['D:\\Users\\me\\Downloads'], recursive: false } });
if (org.ok) {
  const c = await props.commit(org.proposal.id, { approvedBy: 'user' });
  const u = await props.undo(org.proposal.id);
  ok('整理后可撤销', c.ok && u.ok, (c.error || '') + (u.error || ''));
} else {
  ok('整理后可撤销', false, org.error);
}

/* 10 审计写了 propose / approve / commit */
const phases = journal.filter((j) => j[0] === 'append').map((j) => {
  try { return JSON.parse(j[2]).phase; } catch (e) { return '?'; }
});
ok('审计含 propose', phases.includes('propose'), phases.join(','));
ok('审计含 approve', phases.includes('approve'), phases.join(','));
ok('审计含 commit', phases.includes('commit'), phases.join(','));

/* 11 自动档：只自动跑「风险1 且可撤销」 */
await clearQueue();
props.setPolicy(Object.assign({}, props.getPolicy(), { mode: 'auto' }));
props.startTurn();
const orgA = await props.propose({ action: 'organize.apply', args: { paths: ['D:\\Users\\me\\Downloads'] } });
ok('自动档可撤销动作自动执行', orgA.ok && orgA.auto === true, orgA.error || '');

props.startTurn();
const shots = await props.propose({
  action: 'clean.shots',
  args: { paths: ['D:\\Users\\me\\Pictures\\Screenshots\\a.png'], all_images: false }
});
ok('自动档不自动跑风险2', shots.ok && shots.auto === false && shots.proposal.needsWord === false, shots.error || '');

/* 12 放手档：回收站删除自动，撤不回来的必须点 */
await clearQueue();
props.setPolicy(Object.assign({}, props.getPolicy(), { mode: 'full' }));
props.startTurn();
const trash = await props.propose({ action: 'files.delete', args: { paths: ['D:\\Users\\me\\Downloads\\b.txt'], mode: 'trash' } });
ok('放手档回收站删除自动执行', trash.ok && trash.auto === true, trash.error || '');

props.startTurn();
const perm = await props.propose({ action: 'files.delete', args: { paths: ['D:\\Users\\me\\Downloads\\b.txt'], mode: 'permanent' } });
ok('永久删除要确认词', perm.ok && perm.proposal.needsWord === true && perm.auto === false,
  (perm.error || '') + ' needsWord=' + (perm.ok && perm.proposal.needsWord));

props.startTurn();
const rmdir = await props.propose({ action: 'files.remove_empty', args: { paths: ['D:\\Users\\me\\Downloads\\empty'] } });
ok('删空目录不自动', rmdir.ok && rmdir.auto === false && rmdir.proposal.needsWord === false, rmdir.error || '');

/* 13 设置改动要能改回去 */
await clearQueue();
props.setPolicy(Object.assign({}, props.getPolicy(), { mode: 'confirm' }));
props.startTurn();
const set = await props.propose({ action: 'settings.set', args: { key: 'conflict_policy', value: 'skip' } });
if (set.ok) {
  const c = await props.commit(set.proposal.id, { approvedBy: 'user' });
  const u = await props.undo(set.proposal.id);
  const back = calls.filter((x) => x[0] === 'settings.set' && x[1].value === 'rename').length > 0;
  ok('设置可撤销回原值', c.ok && u.ok && back, (c.error || '') + (u.error || '') + ' back=' + back);
} else {
  ok('设置可撤销回原值', false, set.error);
}

/* 14 批量确认：一张卡里勾选一部分执行 */
await clearQueue();
props.setPolicy(Object.assign({}, props.getPolicy(), { mode: 'confirm' }));
props.startTurn();
const three = await props.propose({
  action: 'files.delete',
  args: {
    paths: ['D:\\Users\\me\\Downloads\\a.iso', 'D:\\Users\\me\\Downloads\\b.txt', 'D:\\Users\\me\\Downloads\\c.log'],
    mode: 'trash'
  }
});
ok('可挑选项列出三条', three.ok && Array.isArray(three.proposal.picks) && three.proposal.picks.length === 3,
  three.error || '');
ok('挑选列是 paths', three.ok && three.proposal.pickKey === 'paths', three.ok ? three.proposal.pickKey : '');

if (three.ok) {
  const pre = await props.preview(three.proposal.id, ['D:\\Users\\me\\Downloads\\b.txt']);
  ok('预演只算勾选项', pre.ok && pre.count === 1 && pre.bytes === 12_000,
    (pre.error || '') + ' count=' + pre.count + ' bytes=' + pre.bytes);

  const before = calls.filter((c) => c[0] === 'files.delete' && c[1].confirm === true).length;
  const sub = await props.commit(three.proposal.id, {
    approvedBy: 'user',
    paths: ['D:\\Users\\me\\Downloads\\b.txt']
  });
  const executed = calls.filter((c) => c[0] === 'files.delete' && c[1].confirm === true).slice(before);
  const sentPaths = executed.length ? executed[executed.length - 1][1].paths : [];
  ok('只执行勾选的那一条', sub.ok && sentPaths.length === 1 && sentPaths[0].endsWith('b.txt'),
    (sub.error || '') + ' sent=' + JSON.stringify(sentPaths));
  ok('执行记录记下勾选数', sub.ok && sub.proposal.picked === 1, String(sub.proposal && sub.proposal.picked));
}

/* 15 勾选不能变成加东西的入口 */
props.startTurn();
const guardPick = await props.propose({ action: 'organize.apply', args: { paths: ['D:\\Users\\me\\Downloads'] } });
if (guardPick.ok) {
  const evil = await props.commit(guardPick.proposal.id, {
    approvedBy: 'user',
    paths: ['C:\\Windows']
  });
  ok('勾选项不在原提案里被拒', !evil.ok, evil.error);
  const emptyPick = await props.commit(guardPick.proposal.id, { approvedBy: 'user', paths: [] });
  ok('一项都没勾被拒', !emptyPick.ok, emptyPick.error);
} else {
  ok('勾选项不在原提案里被拒', false, guardPick.error);
  ok('一项都没勾被拒', false, guardPick.error);
}
await clearQueue();

/* 16 整页与抽屉共用同一份队列 */
const sharedA = sandbox.AIProposals.shared({ API, store, actions, policy: { mode: 'confirm' } });
const sharedB = sandbox.AIProposals.shared({ API, store, actions, policy: { mode: 'confirm' } });
ok('shared 返回同一个实例', sharedA === sharedB);

/* 17 新增 4 个全栈闭环动作（process.close / clean.auto / search.selfcheck / rules.draft） */
await clearQueue();
props.setPolicy(Object.assign({}, props.getPolicy(), { mode: 'confirm' }));
props.startTurn();
const pProc = await props.propose({ action: 'process.close', args: { pid: 4321, name: 'demo.exe', force: false }, reason: '释放占用' });
const cProc = pProc.ok ? await props.commit(pProc.proposal.id, { approvedBy: 'user' }) : { ok: false };
ok('process.close 提议与确认执行通过', pProc.ok && cProc.ok && calls.some((c) => c[0] === 'process.close' && c[1].pid === 4321));

/* 17b process.close 后端返回 still_running 时，AI 动作必须报错而非假报成功 */
const origEngForProc = API.engine;
API.engine = async (method, params) => {
  if (method === 'process.close') return { ok: true, closed: false, still_running: true, remaining_count: 5, message: '后台驻留未退出' };
  return origEngForProc(method, params);
};
props.startTurn();
const pProcFail = await props.propose({ action: 'process.close', args: { name: 'ChatGPT.exe', force: false }, reason: '测试假成功拦截' });
const cProcFail = pProcFail.ok ? await props.commit(pProcFail.proposal.id, { approvedBy: 'user' }) : { ok: true };
API.engine = origEngForProc;
ok('process.close 残留仍在运行时 AI 动作拒报成功', pProcFail.ok && !cProcFail.ok && String(cProcFail.error || '').includes('未能彻底关闭'));

props.startTurn();
const pClean = await props.propose({ action: 'clean.auto', args: { cache: true, screenshots: true, days: 30 }, reason: '安全清理' });
const cClean = pClean.ok ? await props.commit(pClean.proposal.id, { approvedBy: 'user' }) : { ok: false };
ok('clean.auto 提议与确认执行通过', pClean.ok && cClean.ok && calls.some((c) => c[0] === 'clean.auto' && c[1].confirm === true));

await clearQueue();
props.startTurn();
const pSelf = await props.propose({ action: 'search.selfcheck', args: { rebuild: true }, reason: '检查索引' });
const cSelf = pSelf.ok ? await props.commit(pSelf.proposal.id, { approvedBy: 'user' }) : { ok: false };
ok('search.selfcheck 提议与确认执行通过', pSelf.ok && cSelf.ok && calls.some((c) => c[0] === 'search.selfcheck'));

props.startTurn();
const pRule = await props.propose({ action: 'rules.draft', args: { yaml: "rules:\n  - name: 'test'\n    locations: '.'\n    actions:\n      - echo: 'ok'\n", folder: 'D:\\Users\\me\\Downloads' }, reason: '写入规则草稿' });
const cRule = pRule.ok ? await props.commit(pRule.proposal.id, { approvedBy: 'user' }) : { ok: false };
ok('rules.draft 校验并跳转填充编辑器', pRule.ok && cRule.ok && calls.some((c) => c[0] === 'AIRulesDraft.fill') && calls.some((c) => c[0] === 'App.jump' && c[1] === 'rules'));

/* 18 红队加固与扩展接口：AIGuard 拦截 ADS/设备名/控制字符 + AIRegistry 动态注册与内置保护 */
ok('AIGuard 拒绝 NTFS ADS 数据流', !!sandbox.AIGuard.denyWhy('D:\\safe\\doc.txt:hidden'));
ok('AIGuard 拒绝 Windows 保留设备名', !!sandbox.AIGuard.denyWhy('D:\\safe\\CON.txt') && !!sandbox.AIGuard.denyWhy('D:\\safe\\NUL'));
ok('AIGuard 拒绝控制字符路径', !!sandbox.AIGuard.denyWhy('D:\\safe\\a\x01b.txt'));

let blockedBuiltinOverwrite = false;
try {
  actions.register('files.delete', { risk: 'low', plan: async () => ({}), run: async () => ({}) }, { overwrite: true });
} catch { blockedBuiltinOverwrite = true; }
ok('AIRegistry 拒绝覆盖内置动作', blockedBuiltinOverwrite);

let blockedBadRisk = false;
try {
  actions.register('ext.bad', { risk: 'extreme', plan: async () => ({}), run: async () => ({}) });
} catch { blockedBadRisk = true; }
ok('AIRegistry 拒绝非法 risk 等级', blockedBadRisk);

const unregExt = actions.register('ext.ping', {
  cat: 'ext',
  label: '扩展测试',
  desc: '测试扩展动作',
  risk: 'low',
  schema: { msg: { type: 'string', req: true } },
  plan: async (a) => ({ summary: a.msg }),
  run: async (a) => ({ ok: true, msg: a.msg })
});
ok('AIRegistry 动态注册扩展动作同步进入 ids/list/catalog',
  actions.ids.includes('ext.ping')
  && actions.list().some((x) => x.id === 'ext.ping' && x.builtin === false)
  && actions.catalog().includes('ext.ping | 测试扩展动作'));
unregExt();
ok('AIRegistry 注销扩展动作干净回收', !actions.ids.includes('ext.ping') && actions.get('ext.ping') === null);

/* 19 全站红队二轮加固：AIGuard 上级/尾点/跨盘回收站/..与未展开环境变量 + proposals 并发双提交锁 + 动作契约核验 */
ok('AIGuard 拒绝波及程序目录的上级路径', !!sandbox.AIGuard.denyWhy('D:\\Tools'));
ok('AIGuard 拒绝包含用户主目录的 C:\\Users', !!sandbox.AIGuard.denyWhy('C:\\Users'));
ok('AIGuard 拒绝非系统盘 $Recycle.Bin', !!sandbox.AIGuard.denyWhy('D:\\$Recycle.Bin\\S-1-5-21'));
ok('AIGuard 拒绝 Windows 尾点规范化绕过', !!sandbox.AIGuard.denyWhy('C:\\Windows.\\System32') && !!sandbox.AIGuard.denyWhy('D:\\repo\\.git.\\HEAD'));
ok('AIGuard 拒绝原始 .. 穿越段', !!sandbox.AIGuard.denyWhy('D:\\safe\\..\\safe\\a.txt'));
ok('AIGuard 拒绝未展开环境变量绕过', !!sandbox.AIGuard.denyWhy('C:\\Users\\%USERNAME%'));

// 19b. files.remove_empty 返回数字 removed 时正确汇报数字而非 undefined
const origRemoveEmpty = API.removeEmptyDirs;
API.removeEmptyDirs = async (paths) => ({ removed: paths.length, failed: [] });
props.setPolicy({ mode: 'confirm' });
props.startTurn();
const pRmEmpty = await props.propose({ action: 'files.remove_empty', args: { paths: ['D:\\Users\\me\\Downloads\\empty1', 'D:\\Users\\me\\Downloads\\empty2'] } });
const cRmEmpty = pRmEmpty.ok ? await props.commit(pRmEmpty.proposal.id, { approvedBy: 'user' }) : { ok: false };
ok('files.remove_empty 正确统计数字 removed 不再显示 undefined', cRmEmpty.ok && cRmEmpty.message.includes('2 个空文件夹') && !cRmEmpty.message.includes('undefined'), cRmEmpty.message || cRmEmpty.error);
API.removeEmptyDirs = origRemoveEmpty;

// 19c. archive.extract 传字符串 overwrite 策略并使用 archive-undo 精确撤销（绝不把目标目录整棵扔回收站）
let gotExtractArgs = null;
let gotUndoId = null;
API.archiveOpen = async () => ({ entries: [{ name: 'a.txt', size: 10, dir: false }], totalSize: 10 });
API.archiveExtract = async (path, out, idx, pw, overwrite, mode) => {
  gotExtractArgs = { path, out, overwrite, mode };
  return { files: 1, bytes: 10, undoId: 'u-arc-99' };
};
API.archiveUndo = async (id) => { gotUndoId = id; return { removedFiles: 1, restoredFiles: 0 }; };
props.startTurn();
const pArc = await props.propose({ action: 'archive.extract', args: { path: 'D:\\Users\\me\\Downloads\\demo.zip', out_dir: 'D:\\Users\\me\\Downloads\\out', overwrite: false } });
const cArc = pArc.ok ? await props.commit(pArc.proposal.id, { approvedBy: 'user' }) : { ok: false };
const uArc = cArc.ok ? await props.undo(cArc.proposal.id) : { ok: false };
ok('archive.extract 传字符串策略且走 archiveUndo 精确撤销',
  cArc.ok && gotExtractArgs && typeof gotExtractArgs.overwrite === 'string' && gotExtractArgs.overwrite === 'rename'
  && uArc.ok && gotUndoId === 'u-arc-99',
  JSON.stringify({ gotExtractArgs, gotUndoId, cArc: cArc.error, uArc }));

// 19d. apps.remove_store 在仅传 name 时自动反查 package 并成功卸载
let removedPkg = '';
API.storeApps = async () => [{ name: 'DemoStoreApp', version: '1.0', publisher: 'Test', package: 'DemoStoreApp_1.0_x64__abc' }];
API.removeStoreApp = async (pkg, confirm) => { removedPkg = confirm ? pkg : ''; return { removed: true }; };
props.startTurn();
const pStore = await props.propose({ action: 'apps.remove_store', args: { name: 'DemoStoreApp' } });
const cStore = pStore.ok ? await props.commit(pStore.proposal.id, { approvedBy: 'user' }) : { ok: false };
ok('apps.remove_store 反查 package 正常卸载', pStore.ok && cStore.ok && removedPkg === 'DemoStoreApp_1.0_x64__abc', removedPkg || cStore.error);

// 19e. proposals.commit 子集异步预演期间同步加锁，防双击并发双执行
let slowRunCount = 0;
const origDeleteEngine = API.engine;
API.engine = async (m, p) => {
  if (m === 'files.delete' && p.confirm === false) {
    await new Promise((r) => setTimeout(r, 30));
    return { items: p.paths.map((x) => ({ path: x, size: 100 })), failed: [], total_size: p.paths.length * 100, count: p.paths.length };
  }
  if (m === 'files.delete' && p.confirm === true) {
    slowRunCount += 1;
    return { deleted: p.paths, failed: [] };
  }
  return origDeleteEngine(m, p);
};
props.startTurn();
const pRace = await props.propose({ action: 'files.delete', args: { paths: ['D:\\Users\\me\\Downloads\\r1.txt', 'D:\\Users\\me\\Downloads\\r2.txt'], mode: 'trash' } });
const [rRace1, rRace2] = pRace.ok
  ? await Promise.all([
    props.commit(pRace.proposal.id, { approvedBy: 'user', paths: ['D:\\Users\\me\\Downloads\\r1.txt'] }),
    props.commit(pRace.proposal.id, { approvedBy: 'user', paths: ['D:\\Users\\me\\Downloads\\r1.txt'] })
  ])
  : [{ ok: false }, { ok: false }];
ok('proposals.commit 并发双击仅允许一次执行', slowRunCount === 1 && (rRace1.ok !== rRace2.ok), `runs=${slowRunCount}`);
API.engine = origDeleteEngine;

console.log(out.join('\n'));
const failed = out.filter((x) => x.startsWith('FAIL')).length;
console.log('\n' + (out.length - failed) + '/' + out.length + ' 通过，失败 ' + failed);
process.exit(failed ? 1 : 0);
