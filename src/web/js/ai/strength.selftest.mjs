/* AI 助手 · 强度与温度策略层自测
   ------------------------------------------------------------
   跑法：node src/web/js/ai/strength.selftest.mjs
   纯离线：require('./strength.js')（它挂在 globalThis 上）后逐条断言，
   不连网络、不碰磁盘、不碰 DOM。
   覆盖：档位表结构、任务识别与优先级、温度来源优先级、手填覆盖、
         jsonMode 压闸、推理模型锁温、厂商原生字段、步数硬闸、
         思考 token 读取与估算口径、迁移与一行摘要。 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('./strength.js');
const S = globalThis.AIStrength;

const results = [];
let seq = 0;

function test(name, fn) {
  seq += 1;
  const id = 'S' + String(seq).padStart(2, '0');
  const bad = [];
  const fail = (msg) => { bad.push(msg); };
  try {
    fn(fail);
  } catch (e) {
    fail('抛异常：' + ((e && e.message) || e));
  }
  results.push({ id, name, pass: bad.length === 0, why: bad.join('；') });
}

function eq(got, want, fail, what) {
  if (got !== want) fail((what ? what + '：' : '') + '期望 ' + JSON.stringify(want) + '，实际 ' + JSON.stringify(got));
}
function ok(v, fail, what) {
  if (!v) fail((what || '断言') + ' 为假');
}
function no(v, fail, what) {
  if (v) fail((what || '断言') + ' 应不成立');
}

/* ---------------- 档位表 ---------------- */

test('四档齐全且按固定顺序', (fail) => {
  eq(S.ORDER.join(','), 'off,low,medium,high', fail, '档位顺序');
  S.ORDER.forEach((id) => ok(S.LEVELS[id], fail, '档位 ' + id + ' 存在'));
  eq(S.DEFAULT_LEVEL, 'medium', fail, '默认档');
});

test('档位的思考预算与查证轮数递增', (fail) => {
  const think = S.ORDER.map((id) => S.LEVELS[id].think);
  ok(think[0] === 0 && think[1] === 0, fail, 'off/low 不思考');
  ok(think[2] > 0 && think[3] > think[2], fail, '中/高思考预算递增');
  const steps = S.ORDER.map((id) => S.LEVELS[id].steps);
  for (let i = 1; i < steps.length; i += 1) ok(steps[i] >= steps[i - 1], fail, '步数不减');
});

test('每档都有中英文案与提示', (fail) => {
  S.ORDER.forEach((id) => {
    const L = S.LEVELS[id];
    eq(L.label.length, 2, fail, id + ' 标签');
    eq(L.hint.length, 2, fail, id + ' 提示');
    ok(L.band[0] <= L.band[1], fail, id + ' 温度区间顺序');
  });
});

/* ---------------- 任务识别 ---------------- */

test('代码问题识别为 code', (fail) => {
  eq(S.detectTask('这段代码报错了，帮我看下堆栈').id, 'code', fail, '任务');
});

test('代码优先于工具（同句里都有）', (fail) => {
  eq(S.detectTask('读这个文件里的函数并修掉报错').id, 'code', fail, '任务');
});

test('算数字识别为 math', (fail) => {
  eq(S.detectTask('帮我算一下这周平均每天用了多少').id, 'math', fail, '任务');
});

test('文件整理识别为 tool', (fail) => {
  eq(S.detectTask('D 盘空间不够，哪些大文件可以清理').id, 'tool', fail, '任务');
});

test('写文案识别为 creative', (fail) => {
  eq(S.detectTask('帮我写一段朋友圈文案').id, 'creative', fail, '任务');
});

test('认不出的问题落到默认任务', (fail) => {
  eq(S.detectTask('嗯').id, 'tool', fail, '默认任务');
  eq(S.detectTask(''), null, fail, '空串不猜任务');
});

/* ---------------- 温度 ---------------- */

test('温度由任务决定，不由强度决定', (fail) => {
  const code = S.resolve({ level: 'high', text: '这段代码报错了' });
  eq(code.temperature, 0.2, fail, '代码温度');
  eq(code.tempSrc, 'task', fail, '代码温度来源');
  const write = S.resolve({ level: 'medium', text: '帮我写一段文案' });
  eq(write.temperature, 0.85, fail, '文案温度');
});

test('同一温度不随档位变化', (fail) => {
  const lo = S.resolve({ level: 'low', text: 'D 盘哪些大文件可以清理' });
  const hi = S.resolve({ level: 'high', text: 'D 盘哪些大文件可以清理' });
  eq(lo.temperature, hi.temperature, fail, '低/高档温度应一致');
});

test('手填温度盖过任务默认', (fail) => {
  const p = S.resolve({ level: 'medium', text: '帮我写一段文案', temperature: 0.1 });
  eq(p.temperature, 0.1, fail, '手填温度');
  eq(p.tempSrc, 'manual', fail, '来源');
});

test('jsonMode 把高温压到 0.7', (fail) => {
  const p = S.resolve({ level: 'high', text: '帮我写一段文案', jsonMode: true });
  ok(p.temperature <= 0.7, fail, 'json 模式温度应 ≤0.7');
});

test('推理专用模型不发温度', (fail) => {
  const p = S.resolve({ level: 'high', text: '这段代码报错了', model: 'o3-mini' });
  eq(p.temperature, null, fail, '温度应为 null');
  eq(p.tempSrc, 'locked', fail, '来源');
  ok(S.isLockedTemp('deepseek-r1'), fail, 'deepseek-r1 应锁温');
  ok(!S.isLockedTemp('deepseek-chat'), fail, 'deepseek-chat 不锁温');
});

/* ---------------- 原生字段 ---------------- */

test('OpenAI 系发 reasoning_effort', (fail) => {
  const p = S.resolve({ level: 'high', text: 'x', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o' });
  eq(p.family, 'openai', fail, '厂商');
  eq(p.extra.reasoning_effort, 'high', fail, '字段');
  eq(S.resolve({ level: 'off', text: 'x', endpoint: 'https://api.openai.com/v1' }).extra.reasoning_effort, 'minimal', fail, '关闭档');
});

test('Anthropic 用 thinking.budget_tokens 且不小于 1024', (fail) => {
  const p = S.resolve({ level: 'high', text: 'x', endpoint: 'https://api.anthropic.com', model: 'claude-x' });
  eq(p.family, 'anthropic', fail, '厂商');
  eq(p.extra.thinking.type, 'enabled', fail, 'thinking 类型');
  ok(p.extra.thinking.budget_tokens >= 1024, fail, 'budget 下限');
  const off = S.resolve({ level: 'off', text: 'x', endpoint: 'https://api.anthropic.com' });
  eq(off.extra.thinking.type, 'disabled', fail, '关闭档');
});

test('Qwen 用 enable_thinking 布尔', (fail) => {
  const on = S.resolve({ level: 'medium', text: 'x', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1' });
  eq(on.family, 'qwen', fail, '厂商');
  eq(on.extra.enable_thinking, true, fail, '开启');
  const off = S.resolve({ level: 'off', text: 'x', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1' });
  eq(off.extra.enable_thinking, false, fail, '关闭');
});

test('本地模型不发原生字段', (fail) => {
  const p = S.resolve({ level: 'high', text: 'x', endpoint: 'http://127.0.0.1:11434/v1' });
  eq(p.family, 'local', fail, '厂商');
  eq(p.extra, null, fail, '不应有额外字段');
});

/* ---------------- 硬闸 ---------------- */

test('步数上限与设置的硬闸取小', (fail) => {
  eq(S.resolve({ level: 'high', text: 'x' }).steps, 14, fail, '高档默认步数');
  eq(S.resolve({ level: 'high', text: 'x', stepCap: 5 }).steps, 5, fail, '被硬闸压住');
  eq(S.resolve({ level: 'off', text: 'x', stepCap: 20 }).steps, 6, fail, '硬闸放宽也不超档位');
});

test('未知档位回落到默认档', (fail) => {
  eq(S.resolve({ level: 'turbo', text: 'x' }).level, 'medium', fail, '回落');
});

/* ---------------- 思考 token ---------------- */

test('思考 token 能从四种常见字段读到', (fail) => {
  eq(S.thinkUsed({ reasoning_tokens: 1200 }), 1200, fail, 'reasoning_tokens');
  eq(S.thinkUsed({ reasoning: 800 }), 800, fail, 'reasoning');
  eq(S.thinkUsed({ completion_tokens_details: { reasoning_tokens: 640 } }), 640, fail, 'completion_tokens_details');
  eq(S.thinkUsed({ output_tokens_details: { reasoning_tokens: 320 } }), 320, fail, 'output_tokens_details');
});

test('没上报时返回 null，不编 0', (fail) => {
  eq(S.thinkUsed({ completion_tokens: 500 }), null, fail, '未上报');
  eq(S.thinkUsed(null), null, fail, '空输入');
});

test('估算值必须带 estimated 标记', (fail) => {
  const policy = { think: 4000 };
  const fake = S.thinkEstimate(policy, { completion_tokens: 1000 });
  eq(fake.tokens, 900, fail, '估算值');
  eq(fake.estimated, true, fail, '估算标记');
  const real = S.thinkEstimate(policy, { reasoning_tokens: 2100, completion_tokens: 1000 });
  eq(real.tokens, 2100, fail, '真值优先');
  eq(real.estimated, false, fail, '真值不算估算');
  const none = S.thinkEstimate(null, { completion_tokens: 1000 });
  eq(none.tokens, 0, fail, '无策略不显示');
});

/* ---------------- 文案与迁移 ---------------- */

test('一行摘要写清档位与温度来源', (fail) => {
  const p = S.resolve({ level: 'high', text: '这段代码报错了' });
  const s = S.line(p);
  ok(s.indexOf('高') === 0, fail, '以档位名开头：' + s);
  ok(s.indexOf('0.2') > 0, fail, '含温度：' + s);
  ok(s.indexOf('任务') > 0, fail, '含来源：' + s);
});

test('回放用的精简策略也能出摘要', (fail) => {
  const s = S.line({ level: 'medium', temperature: 0.1, tempSrc: 'task' });
  ok(s.indexOf('中') === 0, fail, '按 id 现查档位：' + s);
  eq(S.line(null), '', fail, '空策略返回空串');
});

test('锁温模型的摘要说明温度由模型固定', (fail) => {
  const s = S.line({ level: 'high', temperature: null, tempSrc: 'locked' });
  ok(s.indexOf('模型') > 0, fail, '说明来源：' + s);
});

test('老档位名迁移到新档位', (fail) => {
  eq(S.migrateLevel('simple'), 'low', fail, 'simple');
  eq(S.migrateLevel('deep'), 'high', fail, 'deep');
  eq(S.migrateLevel('high'), 'high', fail, '原值');
  eq(S.migrateLevel('nope'), 'medium', fail, '非法值');
  eq(S.migrateLevel(undefined), 'medium', fail, '缺省');
});

test('stops() 给滑块的形状', (fail) => {
  const list = S.stops();
  eq(list.length, 4, fail, '档位数');
  list.forEach((s) => {
    ok(s.id && s.label && s.icon, fail, '字段齐全');
    ok(typeof s.think === 'number' && typeof s.steps === 'number', fail, '预算字段');
  });
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
