/* AI 助手 · 请求体自测（强度字段与温度）
   ------------------------------------------------------------
   跑法：node src/web/js/ai/body.selftest.mjs
   不连真模型：transport 由本文件提供，只把请求体抓下来断言。
   覆盖：温度数字才发、温度为 null 不发、原生字段按 caps 摘除、
         被 400 拒后学一次不再发、思考 token 汇总、json 模式字段。 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createAgent } = require('./agent.js');
const prompt = require('./prompt.js');

const results = [];
let seq = 0;

function test(name, fn) {
  seq += 1;
  const id = 'B' + String(seq).padStart(2, '0');
  const bad = [];
  try {
    fn((m) => bad.push(m));
  } catch (e) {
    bad.push('抛异常：' + ((e && e.message) || e));
  }
  results.push({ id, name, pass: bad.length === 0, why: bad.join('；') });
}

const ok = (v, fail, what) => { if (!v) fail((what || '断言') + ' 为假'); };
const no = (v, fail, what) => { if (v) fail((what || '断言') + ' 应不成立'); };

const ANSWER = JSON.stringify({ answer: '好的。', evidence: [], suggest: [] });

/* 一个只回答案的 transport：把每次请求体记进 seen */
function recorder(replies) {
  const seen = [];
  let i = 0;
  const fn = async (req) => {
    seen.push(JSON.parse(req.body));
    const r = replies[Math.min(i, replies.length - 1)];
    i += 1;
    return r;
  };
  fn.seen = seen;
  return fn;
}

function okReply() {
  return { status: 200, body: JSON.stringify({ choices: [{ message: { content: ANSWER } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) };
}

function baseSettings(over) {
  return Object.assign({
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    model: 'qwen-max',
    apiKey: 'k',
    maxSteps: 3,
    jsonMode: false,
    temperature: 0,
    turnBudget: 0
  }, over || {});
}

async function run(settings, replies, extraDeps) {
  const transport = recorder(replies);
  const learned = [];
  const agent = createAgent(Object.assign({
    transport,
    prompt,
    tools: {},
    settings,
    learn: (k, caps) => learned.push(Object.assign({ key: k }, caps))
  }, extraDeps || {}));
  const res = await agent.run({ userText: '算一下 1+1', ctx: { page: 'ai' } });
  return { res, seen: transport.seen, learned };
}

/* ---------------- 温度 ---------------- */

test('温度是数字时才发', async (fail) => {
  const t = recorder([okReply()]);
  const agent = createAgent({ transport: t, prompt, tools: {}, settings: baseSettings({ temperature: 0.1 }) });
  await agent.run({ userText: '算一下 1+1', ctx: { page: 'ai' } });
  ok(t.seen[0].temperature === 0.1, fail, '温度应进请求体');
});

test('温度为 null（推理模型锁温）时不发', async (fail) => {
  const t = recorder([okReply()]);
  const agent = createAgent({ transport: t, prompt, tools: {}, settings: baseSettings({ temperature: null }) });
  await agent.run({ userText: '算一下 1+1', ctx: { page: 'ai' } });
  no('temperature' in t.seen[0], fail, '不该带 temperature');
});

/* ---------------- 原生字段 ---------------- */

test('原生字段按 extraBody 并进请求体', async (fail) => {
  const t = recorder([okReply()]);
  const agent = createAgent({
    transport: t, prompt, tools: {},
    settings: baseSettings({ extraBody: { enable_thinking: true } })
  });
  await agent.run({ userText: '算一下 1+1', ctx: { page: 'ai' } });
  ok(t.seen[0].enable_thinking === true, fail, 'enable_thinking 应进请求体');
});

test('已被拒过的字段不再发', async (fail) => {
  const t = recorder([okReply()]);
  const agent = createAgent({
    transport: t, prompt, tools: {},
    settings: baseSettings({ caps: { noThinking: true }, extraBody: { enable_thinking: true } })
  });
  await agent.run({ userText: '算一下 1+1', ctx: { page: 'ai' } });
  no('enable_thinking' in t.seen[0], fail, 'noThinking 时应摘掉');
});

test('400 拒 enable_thinking 后学一次、重试不再发', async (fail) => {
  const bad = {
    status: 400,
    body: JSON.stringify({ error: { message: 'enable_thinking is not supported for this model' } })
  };
  const t = recorder([bad, okReply()]);
  const learned = [];
  const agent = createAgent({
    transport: t, prompt, tools: {},
    settings: baseSettings({ extraBody: { enable_thinking: true } }),
    learn: (k, caps) => learned.push(caps)
  });
  const res = await agent.run({ userText: '算一下 1+1', ctx: { page: 'ai' } });
  ok(t.seen.length >= 2, fail, '应重试过（实际请求 ' + t.seen.length + ' 次）');
  ok(t.seen[0].enable_thinking === true, fail, '第一次应带字段');
  no('enable_thinking' in t.seen[1], fail, '重试应摘掉字段');
  ok(res.ok, fail, '重试后应成功');
  ok(learned.some((c) => c.noThinking === true), fail, '应记住 noThinking');
});

test('400 拒 reasoning_effort 只摘这一个', async (fail) => {
  const bad = { status: 400, body: JSON.stringify({ error: { message: 'Unknown field reasoning_effort' } }) };
  const t = recorder([bad, okReply()]);
  const agent = createAgent({
    transport: t, prompt, tools: {},
    settings: baseSettings({ extraBody: { reasoning_effort: 'high' } })
  });
  await agent.run({ userText: '算一下 1+1', ctx: { page: 'ai' } });
  no('reasoning_effort' in t.seen[1], fail, '重试应摘掉 reasoning_effort');
  ok(t.seen[0].temperature === 0, fail, '温度不该被连坐摘掉');
});

/* ---------------- JSON 模式与思考 token ---------------- */

test('jsonMode 打开时带 response_format', async (fail) => {
  const t = recorder([okReply()]);
  const agent = createAgent({ transport: t, prompt, tools: {}, settings: baseSettings({ jsonMode: true }) });
  await agent.run({ userText: '算一下 1+1', ctx: { page: 'ai' } });
  ok(t.seen[0].response_format && t.seen[0].response_format.type === 'json_object', fail, '应带 response_format');
});

test('服务端上报的推理 token 汇总进 usage', async (fail) => {
  const withThink = {
    status: 200,
    body: JSON.stringify({
      choices: [{ message: { content: ANSWER } }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 50,
        completion_tokens_details: { reasoning_tokens: 320 }
      }
    })
  };
  const t = recorder([withThink]);
  const agent = createAgent({ transport: t, prompt, tools: {}, settings: baseSettings() });
  const res = await agent.run({ userText: '算一下 1+1', ctx: { page: 'ai' } });
  ok(res.usage && res.usage.reasoning_tokens === 320, fail, '应累计 reasoning_tokens');
  ok(res.usage && res.usage.reasoning_reported === true, fail, '应标记为真实上报');
});

test('没上报时 reasoning_tokens 保持 0 且未标记', async (fail) => {
  const t = recorder([okReply()]);
  const agent = createAgent({ transport: t, prompt, tools: {}, settings: baseSettings() });
  const res = await agent.run({ userText: '算一下 1+1', ctx: { page: 'ai' } });
  ok(res.usage && res.usage.reasoning_tokens === 0, fail, '应为 0');
  ok(res.usage && res.usage.reasoning_reported === false, fail, '不应标记上报');
});

/* ---------------- 上下文行 ---------------- */

test('上下文行写清强度、温度、任务', (fail) => {
  const line = prompt.contextLine({ page: 'ai', thinking: '高', temperature: 0.2, tempSrc: '任务', task: '代码' });
  ok(line.indexOf('强度=高') > 0, fail, '缺强度：' + line);
  ok(line.indexOf('温度=0.2') > 0, fail, '缺温度：' + line);
  ok(line.indexOf('任务=代码') > 0, fail, '缺任务：' + line);
});

test('温度被锁时不写温度', (fail) => {
  const line = prompt.contextLine({ page: 'ai', thinking: '高', temperature: null, task: '代码' });
  no(line.indexOf('温度=') >= 0, fail, '不该写温度：' + line);
});

test('系统提示词含强度行为约定', (fail) => {
  const sys = prompt.systemPrompt([]);
  ok(sys.indexOf('【推理强度怎么用】') > 0, fail, '缺强度段');
  ok(sys.indexOf('不要为了显得努力而空转') > 0, fail, '缺防空转约定');
  ok(sys.indexOf('温度由任务决定，不由强度决定') > 0, fail, '缺温度分工说明');
  ok(sys.indexOf('不要复述') >= 0 || sys.indexOf('不要在回答里复述') > 0, fail, '缺不许复述约定');
});

/* ---------------- 输出 ---------------- */

const line = '─'.repeat(72);
console.log('');
const bad2 = [];
for (const r of results) {
  console.log((r.pass ? 'PASS  ' : 'FAIL  ') + r.id + '  ' + r.name + (r.pass ? '' : '  · ' + r.why));
  if (!r.pass) bad2.push(r.id);
}
console.log(line);
console.log('用例通过        ' + (results.length - bad2.length) + '/' + results.length);
console.log('');
console.log(bad2.length ? '结果：有 ' + bad2.length + ' 条不通过' : '结果：全部通过');
console.log(line);
process.exit(bad2.length ? 1 : 0);
