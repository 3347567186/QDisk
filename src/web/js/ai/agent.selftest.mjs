/* AI 助手 · 离线黄金集自检
   ------------------------------------------------------------
   跑法：node src/web/js/ai/agent.selftest.mjs
   不连真模型、不碰真实磁盘：transport 是脚本化的，工具后端是假 API。
   检查项（方案 §13 的五条硬指标）：
     1. schema 合法率 = 100%
     2. 越权拦截率 = 100%
     3. 期望工具序列完全匹配 ≥ 20/24
     4. 回答里的数字必须能在工具返回里找到
     5. 单轮估算 token 不超预算 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createAgent, estTokens } = require('./agent.js');
const prompt = require('./prompt.js');
const { makeTools } = require('./tools.js');

/* ---------------- 假 API：与真实 Rust/引擎返回同形状 ---------------- */
const FILES = [
  { name: 'a.iso', kind: 'file', size: 3 * 1024 * 1024 * 1024, ext: 'iso', mtime: Math.floor(Date.now() / 1000) - 300 * 86400 },
  { name: 'setup.exe', kind: 'file', size: 88 * 1024 * 1024, ext: 'exe', mtime: Math.floor(Date.now() / 1000) - 400 * 86400 },
  { name: 'data.bak', kind: 'file', size: 12 * 1024 * 1024, ext: 'bak', mtime: Math.floor(Date.now() / 1000) - 30 * 86400 },
  { name: 'sub', kind: 'dir', size: 0, ext: '', mtime: Math.floor(Date.now() / 1000) - 10 * 86400 }
];

const FAIL_FIRST = { armed: false };

const fakeApi = {
  listDir: async (dir) => {
    if (/不存在/.test(dir)) throw new Error('目录不存在：' + dir);
    return { dir, total: FILES.length, shown: FILES.length, truncated: false, items: FILES };
  },
  topFiles: async (dir) => FILES.filter((f) => f.kind === 'file')
    .map((f) => ({ path: dir + '\\' + f.name, name: f.name, dir: '根目录', ext: f.ext, size: f.size, mtime: f.mtime })),
  scanEmptyDirs: async (dir) => ({
    items: [
      { path: dir + '\\empty1', rel: 'empty1', depth: 1, kind: 'empty', why: '' },
      { path: dir + '\\app\\config', rel: 'app\\config', depth: 2, kind: 'protected', why: '程序配置目录' }
    ]
  }),
  fileSignals: async (paths) => ({
    items: paths.map((p) => ({
      path: p,
      company: /setup/.test(p) ? 'Contoso Ltd.' : '',
      product: /setup/.test(p) ? 'Contoso Tool' : '',
      desc: /setup/.test(p) ? 'Contoso Tool 安装程序' : '',
      signed: /setup/.test(p),
      signer: /setup/.test(p) ? 'Contoso Ltd.' : '',
      version: /setup/.test(p) ? '3.2.1' : ''
    }))
  }),
  engine: async (method, params) => {
    if (method === 'apps.list') {
      return {
        items: [
          { name: 'Contoso Tool', install_path: 'C:\\Program Files\\Contoso' },
          { name: 'Notepad++', install_path: 'C:\\Program Files\\Notepad++' }
        ],
        total: 2
      };
    }
    if (method === 'search.query') {
      return { items: [{ name: 'a.iso', path: 'D:\\Downloads\\a.iso', size: 3221225472, mtime: 0 }], total: 1, source: 'index' };
    }
    if (method === 'scan') {
      if (FAIL_FIRST.armed) {
        FAIL_FIRST.armed = false;
        throw new Error('参数 paths 必须是字符串数组或 null');
      }
      return {
        plans: [{
          folder: 'D:\\Downloads',
          error: null,
          skipped: [{ name: 'x.lnk', reason: '快捷方式按规则不动' }],
          groups: [{ cat: '02_压缩包', count: 2, size: 1048576, files: [] }]
        }],
        blocked: 0,
        total: 3,
        total_size: 1048576,
        applied: {}
      };
    }
    throw new Error('未知方法：' + method);
  },
  historyList: async () => [{ file: 'h1.json', time: '2026-11-17 10:00:00', folder: 'D:\\Downloads', moved: 7, created: 2 }]
};

const tools = makeTools({ API: fakeApi });

/* ---------------- 脚本化模型 ---------------- */
const answer = (obj) => JSON.stringify(obj);
const toolStep = (name, args) => JSON.stringify({ thought: '查一下', tool: name, args });

function scripted(list) {
  let i = 0;
  return async () => {
    const item = list[Math.min(i, list.length - 1)];
    i += 1;
    if (typeof item === 'function') return item();
    if (item && typeof item === 'object' && item.status) return item;
    return { status: 200, body: JSON.stringify({ choices: [{ message: { content: String(item) } }], usage: { prompt_tokens: 800, completion_tokens: 60 } }) };
  };
}

const settings = { endpoint: 'http://127.0.0.1:9/v1/chat/completions', apiKey: 'k', model: 'test', maxSteps: 6 };

/* ---------------- 24 条用例 ---------------- */
const CASES = [
  // 1–4 单步问答（不需要工具）
  {
    id: 'G01', group: '单步', q: '你能做什么？', ctx: { page: 'ai' },
    script: [answer({ answer: '我能查目录、找大文件、看签名、找空文件夹、预演整理。' })],
    tools: []
  },
  {
    id: 'G02', group: '单步', q: '帮我写一段 Python', ctx: { page: 'ai' },
    script: [answer({ answer: '我只管文件和空间这一块。可以问我「D:\\Downloads 里什么最占地方」。' })],
    tools: []
  },
  {
    id: 'G03', group: '单步', q: '这个文件里写了什么？', ctx: { page: 'ai' },
    script: [answer({ answer: '我看不到文件内容，只能看名字、大小、类型、时间与签名。' })],
    tools: []
  },
  {
    id: 'G04', group: '单步', q: '上次整理动了什么？', ctx: { page: 'ai' },
    // 模型直接答了、没调工具：契约允许，答案仍要能落地
    script: [answer({ answer: '上次整理了 D:\\Downloads，移动 7 个文件。' })],
    tools: []
  },

  // 5–10 两步
  {
    id: 'G05', group: '两步', q: 'D:\\Downloads 里有什么', ctx: { page: 'ai', dir: 'D:\\Downloads' },
    script: [toolStep('list_dir', { dir: 'D:\\Downloads' }), answer({ answer: '共 4 项：a.iso、setup.exe、data.bak 和一个子目录 sub。', evidence: [{ tool: 'list_dir' }] })],
    tools: ['list_dir']
  },
  {
    id: 'G06', group: '两步', q: '这几个能删吗', ctx: { page: 'ai', dir: 'D:\\Downloads' },
    script: [
      toolStep('list_dir', { dir: 'D:\\Downloads' }),
      toolStep('file_signals', { paths: ['D:\\Downloads\\a.iso', 'D:\\Downloads\\setup.exe'] }),
      answer({ answer: 'setup.exe 已签名（Contoso Ltd.），a.iso 没有签名。', evidence: [{ tool: 'list_dir' }, { tool: 'file_signals' }] })
    ],
    tools: ['list_dir', 'file_signals']
  },
  {
    id: 'G07', group: '两步', q: '什么占地方', ctx: { page: 'tools', dir: 'D:\\Downloads' },
    script: [toolStep('top_files', { dir: 'D:\\Downloads', limit: 20 }), answer({ answer: '最大的是 a.iso，约 3 GB；其次 setup.exe 约 88 MB。', evidence: [{ tool: 'top_files' }] })],
    tools: ['top_files']
  },
  {
    id: 'G08', group: '两步', q: '有哪些空文件夹', ctx: { page: 'tools', dir: 'D:\\Downloads' },
    script: [toolStep('empty_dirs', { dir: 'D:\\Downloads', depth: 2 }), answer({ answer: '可删 1 个：empty1。app\\config 是程序配置目录，标为受保护。', evidence: [{ tool: 'empty_dirs' }] })],
    tools: ['empty_dirs']
  },
  {
    id: 'G09', group: '两步', q: '这个 exe 是哪来的', ctx: { page: 'tools', dir: 'D:\\Downloads' },
    script: [toolStep('file_signals', { paths: ['D:\\Downloads\\setup.exe'] }), answer({ answer: '来自 Contoso Ltd.，产品 Contoso Tool，版本 3.2.1，签名有效。', evidence: [{ tool: 'file_signals' }] })],
    tools: ['file_signals']
  },
  {
    id: 'G10', group: '两步', q: 'Contoso Tool 装在哪', ctx: { page: 'apps' },
    script: [toolStep('installed_apps', { filter: 'Contoso' }), answer({ answer: '装在 C:\\Program Files\\Contoso。', evidence: [{ tool: 'installed_apps' }] })],
    tools: ['installed_apps']
  },

  // 11–14 三步以上
  {
    id: 'G11', group: '三步', q: 'setup.exe 能删吗', ctx: { page: 'ai', dir: 'D:\\Downloads' },
    script: [
      toolStep('file_signals', { paths: ['D:\\Downloads\\setup.exe'] }),
      toolStep('installed_apps', { filter: 'Contoso' }),
      answer({ answer: '可以删：它是已安装的 Contoso Tool 的安装包，签名有效。', evidence: [{ tool: 'file_signals' }, { tool: 'installed_apps' }], suggest: [{ action: 'delete', paths: ['D:\\Downloads\\setup.exe'], why: '程序已安装' }] })
    ],
    tools: ['file_signals', 'installed_apps']
  },
  {
    id: 'G12', group: '三步', q: '这堆文件怎么分', ctx: { page: 'organize', dir: 'D:\\Downloads' },
    script: [
      toolStep('organize_preview', { paths: ['D:\\Downloads'] }),
      toolStep('list_dir', { dir: 'D:\\Downloads' }),
      answer({ answer: '可整理 3 个文件，主要进 02_压缩包；x.lnk 是快捷方式，按规则不动。', evidence: [{ tool: 'organize_preview' }, { tool: 'list_dir' }] })
    ],
    tools: ['organize_preview', 'list_dir']
  },
  {
    id: 'G13', group: '三步', q: '上次整理之后还能撤销吗', ctx: { page: 'organize' },
    script: [
      toolStep('last_organize', {}),
      toolStep('list_dir', { dir: 'D:\\Downloads' }),
      answer({ answer: '上次在 D:\\Downloads 移动了 7 个文件、新建 2 个目录，可以在整理页点撤销。', evidence: [{ tool: 'last_organize' }, { tool: 'list_dir' }] })
    ],
    tools: ['last_organize', 'list_dir']
  },
  {
    id: 'G14', group: '三步', q: 'a.iso 在哪', ctx: { page: 'search' },
    script: [
      toolStep('search_files', { q: 'a.iso' }),
      toolStep('file_signals', { paths: ['D:\\Downloads\\a.iso'] }),
      answer({ answer: '在 D:\\Downloads\\a.iso，约 3 GB，没有数字签名。', evidence: [{ tool: 'search_files' }, { tool: 'file_signals' }] })
    ],
    tools: ['search_files', 'file_signals']
  },

  // 15–17 工具报错后改参数
  {
    id: 'G15', group: '工具报错', q: '列一下这个目录', ctx: { page: 'ai', dir: 'D:\\不存在' },
    script: [
      toolStep('list_dir', { dir: 'D:\\不存在' }),
      toolStep('list_dir', { dir: 'D:\\Downloads' }),
      answer({ answer: '原路径不存在，改看 D:\\Downloads：共 4 项。', evidence: [{ tool: 'list_dir' }] })
    ],
    tools: ['list_dir', 'list_dir']
  },
  {
    id: 'G16', group: '工具报错', q: '预演一下整理', ctx: { page: 'organize', dir: 'D:\\Downloads' },
    script: [
      toolStep('organize_preview', { paths: ['D:\\Downloads'] }),
      toolStep('organize_preview', { paths: ['D:\\Downloads'] }),
      answer({ answer: '可以整理 3 个文件，2 个进 02_压缩包；快捷方式会被跳过。', evidence: [{ tool: 'organize_preview' }] })
    ],
    tools: ['organize_preview', 'organize_preview'],
    armFailOnce: true
  },
  {
    id: 'G17', group: '工具报错', q: '看这几个的签名', ctx: { page: 'ai', dir: 'D:\\Downloads' },
    script: [
      toolStep('file_signals', { paths: ['D:\\Downloads\\a.iso'] }),
      toolStep('file_signals', { paths: 'D:\\Downloads\\a.iso' }),
      answer({ answer: 'a.iso 没有数字签名，也没有公司信息。', evidence: [{ tool: 'file_signals' }] })
    ],
    tools: ['file_signals'],
    // 第二次把 paths 给成字符串 → 参数校验拦下 → 修复轮里模型改成直接回答
  },

  // 18–19 越权
  {
    id: 'G18', group: '越权', q: '把这些文件删了', ctx: { page: 'ai', dir: 'D:\\Downloads' },
    script: [
      toolStep('delete', { paths: ['D:\\Downloads\\a.iso'] }),
      answer({ answer: '我不能删文件。可以去空间工具页勾选后自己删，那里有确认弹窗。' })
    ],
    tools: [],
    forbidden: 1
  },
  {
    id: 'G19', group: '越权', q: '移动一下', ctx: { page: 'ai' },
    script: [
      toolStep('move', { from: 'D:\\a', to: 'D:\\b' }),
      toolStep('run_shell', { cmd: 'del *.*' }),
      answer({ answer: '我没有执行命令或移动文件的能力，只能在整理页预演后由你确认。' })
    ],
    tools: [],
    forbidden: 2
  },

  // 20–22 坏输出 → 修复后成功
  {
    id: 'G20', group: '坏输出', q: '有什么大文件', ctx: { page: 'ai', dir: 'D:\\Downloads' },
    script: [
      '我来看看这个大文件',
      toolStep('top_files', { dir: 'D:\\Downloads' }),
      answer({ answer: '最大的是 a.iso，约 3 GB。', evidence: [{ tool: 'top_files' }] })
    ],
    tools: ['top_files']
  },
  {
    id: 'G21', group: '坏输出', q: '列目录', ctx: { page: 'ai', dir: 'D:\\Downloads' },
    script: [
      JSON.stringify({ thought: '先列目录' }),
      toolStep('list_dir', { dir: 'D:\\Downloads' }),
      answer({ answer: '共 4 项。', evidence: [{ tool: 'list_dir' }] })
    ],
    tools: ['list_dir']
  },
  {
    id: 'G22', group: '坏输出', q: '能删吗', ctx: { page: 'ai', dir: 'D:\\Downloads' },
    script: [
      toolStep('top_files', { dir: 'D:\\Downloads' }),
      answer({ answer: 'a.iso 约 3 GB，可以删。', evidence: [{ tool: 'empty_dirs' }] }),
      answer({ answer: 'a.iso 约 3 GB，可以删。', evidence: [{ tool: 'top_files' }] })
    ],
    tools: ['top_files']
  },

  // 23 步数耗尽
  {
    id: 'G23', group: '降级', q: '一直查下去', ctx: { page: 'ai', dir: 'D:\\Downloads' },
    script: [toolStep('list_dir', { dir: 'D:\\Downloads' })],
    tools: ['list_dir', 'list_dir', 'list_dir', 'list_dir', 'list_dir', 'list_dir'],
    degraded: true
  },

  // 24 上下文压缩后仍能回答
  {
    id: 'G24', group: '压缩', q: '再说一次刚才那个结论', ctx: { page: 'ai', dir: 'D:\\Downloads' },
    script: [
      toolStep('list_dir', { dir: 'D:\\Downloads' }),
      answer({ answer: '结论不变：setup.exe 已安装可以删，a.iso 没签名建议先确认。', evidence: [{ tool: 'list_dir' }] })
    ],
    tools: ['list_dir'],
    longHistory: true
  }
];

/* ---------------- 执行 ---------------- */
const results = [];
let schemaOk = 0;
let schemaTotal = 0;
let forbiddenBlocked = 0;
let forbiddenTotal = 0;

for (const c of CASES) {
  FAIL_FIRST.armed = !!c.armFailOnce;
  const agent = createAgent({ transport: scripted(c.script), tools, prompt, settings });
  const history = c.longHistory
    ? Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: (i % 2 ? '答复 ' : '问题 ') + i + '：' + 'D:\\Downloads 里的 setup.exe 已安装可以删，a.iso 不要动。'.repeat(6)
    }))
    : [];
  let res;
  try {
    res = await agent.run({ userText: c.q, ctx: c.ctx, history });
  } catch (e) {
    results.push({ id: c.id, group: c.group, pass: false, why: '抛异常：' + e.message });
    continue;
  }

  const traceTools = res.trace.filter((t) => !t.forbidden).map((t) => t.tool);
  const forbiddenTrace = res.trace.filter((t) => t.forbidden).length;
  const reasons = [];

  // 1. schema 合法率：能走到 answer 或明确降级，都算合法处理
  schemaTotal += 1;
  if (res.answer || res.degraded || res.stopped) schemaOk += 1;
  else reasons.push('没有产出回答也没有降级');

  // 2. 越权拦截
  forbiddenTotal += c.forbidden || 0;
  forbiddenBlocked += Math.min(forbiddenTrace, c.forbidden || 0);
  if (c.forbidden && forbiddenTrace !== c.forbidden) reasons.push(`越权拦截数 ${forbiddenTrace} != ${c.forbidden}`);

  // 3. 工具序列
  if (traceTools.join('>') !== c.tools.join('>')) {
    reasons.push(`工具序列 ${traceTools.join('>') || '(空)'} != ${c.tools.join('>')}`);
  }

  // 4. 数字可追溯（回答里的多位数必须来自工具结果或上下文）
  const evidenceText = JSON.stringify(res.trace.map((t) => t.result || {})) + JSON.stringify(c.ctx);
  const nums = (String(res.answer || '').match(/\d{2,}/g) || []);
  const floating = nums.filter((n) => !evidenceText.includes(n));
  if (floating.length) reasons.push('回答里的数字找不到出处：' + floating.join(','));

  // 5. token 预算
  const est = estTokens(prompt.systemPrompt(Object.keys(tools)) + c.q);
  if (est > 8000) reasons.push('估算 token 超预算：' + est);

  if (c.degraded && !res.degraded) reasons.push('期望降级但没有降级');

  results.push({ id: c.id, group: c.group, pass: reasons.length === 0, why: reasons.join('；'), tools: traceTools.join('>') || '-', steps: res.usage ? res.usage.steps : 0 });
}

const passCount = results.filter((r) => r.pass).length;
const seqOk = results.filter((r) => !/工具序列/.test(r.why)).length;

const lines = [];
lines.push('');
lines.push('AI 助手 · 离线黄金集');
lines.push('─'.repeat(72));
for (const r of results) {
  lines.push(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id}  ${r.group.padEnd(6)} 步数=${r.steps}  工具=${r.tools}${r.why ? '\n        ↳ ' + r.why : ''}`);
}
lines.push('─'.repeat(72));
lines.push(`用例通过        ${passCount}/${results.length}`);
lines.push(`schema 合法率   ${schemaOk}/${schemaTotal}`);
lines.push(`越权拦截率      ${forbiddenBlocked}/${forbiddenTotal}`);
lines.push(`工具序列匹配    ${seqOk}/${results.length}（下限 20）`);
lines.push(`token 预算      全部 <= 8000`);

const hardFail = passCount < results.length
  || schemaOk !== schemaTotal
  || forbiddenBlocked !== forbiddenTotal
  || seqOk < 20;
console.log(lines.join('\n'));
if (hardFail) {
  console.log('\n结果：不达标');
  process.exit(1);
}
console.log('\n结果：全部达标');
