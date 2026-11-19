/* AI 助手 · 设置与会话存储
   ------------------------------------------------------------
   设置放在 app.json 的 ai 段（跟其它设置同一个文件，用户备份一次就全带走）；
   会话、事实缓存、用量记录放在 %LOCALAPPDATA%\整理助手数据\ai\。
   密钥明文落在本机 app.json 里——这是本地单机工具的取舍：
   不写日志、不随会话文件导出、界面上只显示后四位。 */
(function (root) {
  'use strict';

  const PROVIDERS = [
    { id: 'deepseek', zh: 'DeepSeek', endpoint: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-chat' },
    { id: 'openai', zh: 'OpenAI', endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini' },
    { id: 'moonshot', zh: 'Kimi', endpoint: 'https://api.moonshot.cn/v1/chat/completions', model: 'moonshot-v1-8k' },
    { id: 'zhipu', zh: '智谱', endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', model: 'glm-4-flash' },
    { id: 'qwen', zh: '通义千问', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-plus' },
    { id: 'ollama', zh: '本地 Ollama', endpoint: 'http://127.0.0.1:11434/v1/chat/completions', model: 'qwen2.5:7b' },
    { id: 'custom', zh: '自定义', endpoint: '', model: '' }
  ];

  const DEFAULTS = {
    enabled: true,
    endpoint: '',
    key: '',
    model: '',
    /* 从端点 GET /models 拉回来的真实模型清单：只用来给用户挑，
       不参与「是否已配置」的判断，清空它也不影响对话。 */
    models: [],
    /* 当前模型的上下文窗口（token）：由端点报告的 max context length 决定。
       modelCtx 是「每个模型各自报了多少」，ctxWindow 是当前选中那个生效的值。 */
    ctxWindow: 0,
    modelCtx: {},
    /* 温度：tempAuto=true 时由任务决定（查文件 0.1、算数字 0、写文案 0.85），
       false 时用手填的 temperature。温度管随机性，不该由「思考强度」推导——
       那会让「想更认真」变成「更容易胡说」。
       temperature 仍留 0.2 作为手填的初值，auto 时不使用它。 */
    tempAuto: true,
    temperature: 0.2,
    jsonMode: true,
    /* 查证轮数硬上限：不是「强度」，是防一路跑飞的安全闸。
       强度档位自己也有轮数（off 6 / low 8 / medium 10 / high 14），
       strength 会把两者取小，所以这里调到 12 也不会让 low 档变啰嗦。 */
    maxSteps: 12,
    /* 单轮历史预算（token）。0 = 不写死，按模型窗口算（窗口 × 70%）：
       思考强度只决定查证轮数，不再切分上下文长度。 */
    turnBudget: 0,
    /* 1.35.x 及更早存下来的「32K 窗口 + 8000 预算」是软件自己填的默认值，
       不是用户的选择。这份老账只迁一次：迁完置 true，之后用户改什么都不再动。 */
    ctxFixed: false,
    /* 端点能力记忆：键是「主机|模型」，值是学到的习惯（是否认 response_format、
       是否认 stream_options、能不能流式、要不要预留给思考、实测耗时）。
       不同模型差异很大，所以按模型各记一份，换模型就重新学。 */
    caps: {},
    /* 备用端点：主端点限流/欠费/模型下线时按顺序往后切。
       每项 {endpoint, model, key?}；key 省略就沿用主密钥。
       真实日志里 60% 的失败是 429/402/503，没有备份就只能整轮作废。 */
    fallbacks: []
  };

  /* 端点没报窗口时的兜底：1M。
     现在的模型动辄 128K–1M，先按 32K 处理会让助手「明明能记住却自己忘掉」。
     界面上仍会明确写「端点未上报，按 1M」——是默认值，不是假装读过。 */
  const FALLBACK_CTX = 1000000;

  /* 已知模型的窗口：端点不报 max context length 时按名字推一个，
     比一律 1M 更接近真实能力；推不出才落到 FALLBACK_CTX。
     顺序即优先级（先匹配到的胜出），所以「deepseek-v4」要排在「deepseek」前面。 */
  const CTX_TABLE = [
    [/deepseek[-_ ]?v?4|deepseek[-_ ]?r2/i, 1000000],
    [/deepseek[-_ ]?(v3\.2|3\.2)|deepseek[-_ ]?chat|deepseek[-_ ]?reasoner/i, 131072],
    [/deepseek/i, 1000000],
    [/gpt-4\.1|gpt-5|o3|o4/i, 1000000],
    [/gpt-4o|gpt-4|gpt-3\.5|o1/i, 131072],
    [/claude/i, 200000],
    [/gemini/i, 1048576],
    [/qwen|tongyi/i, 131072],
    [/glm|chatglm/i, 131072],
    [/kimi|moonshot/i, 262144],
    [/llama|mistral|mixtral/i, 131072]
  ];

  /** 按模型名推窗口；推不出返回 0，交给调用方决定兜底 */
  function inferCtx(model) {
    const id = String(model || '');
    if (!id) return 0;
    for (let i = 0; i < CTX_TABLE.length; i += 1) {
      if (CTX_TABLE[i][0].test(id)) return CTX_TABLE[i][1];
    }
    return 0;
  }


  const MAX_SESSIONS = 20;

  /* ---------------- 界面偏好：跟接口配置分开存 ----------------
     推理强度、权限、选中的模型、上次打开的会话是「使用习惯」，
     不是接口配置：换端点或换密钥时不该把它们重置，重存 AI 配置时
     也不该被顺手覆盖掉。所以单开 app.json 的 ai_ui 段——Rust 的
     config_set 是按 key 合并的，两段互不打扰。 */
  const UI_DEFAULTS = {
    thinking: 'medium',
    permission: 'standard',
    model: '',
    lastSession: '',
    railClosed: false,
    /* 动手策略（档位 / 类别开关 / 预算上限）。字段语义由 proposals.js 的
       normalizePolicy 解释，这里只原样存取——策略改了界面要立刻生效，
       所以不在这里做二次归一，免得两处规则打架。默认空对象 → 归一成 off。 */
    agent: {},
    /* 迁移版本号。用整数而不是布尔，将来还要迁移别的字段时直接加 2、3。
       为什么需要它：1.41.0 之前「关」的语义是「只做必要的一次查询」，
       结果用户把强度设成关之后，问「什么最占空间」只拿到一个裸路径。
       提示词已经改成「关也要给完整结论」，但已经存成 off 的老配置不会
       自动享受新语义——它们当初选 off 是因为「省点 token」，不是想要
       一句话答案。所以这里迁移一次，把老的 off 提升为 medium。 */
    v: 0
  };

  /* 四档：关闭 / 低 / 中 / 高（老版本的 simple、deep 由 AIStrength.migrateLevel 迁移） */
  const THINK_IDS = ['off', 'low', 'medium', 'high'];
  const PERM_IDS = ['readonly', 'standard', 'deep'];

  let uiCache = null;

  function normalizeUi(raw) {
    const out = Object.assign({}, UI_DEFAULTS);
    if (!raw || typeof raw !== 'object') return out;
    if (THINK_IDS.indexOf(raw.thinking) >= 0) out.thinking = raw.thinking;
    if (PERM_IDS.indexOf(raw.permission) >= 0) out.permission = raw.permission;
    if (typeof raw.model === 'string') out.model = raw.model.trim().slice(0, 120);
    if (typeof raw.lastSession === 'string') out.lastSession = raw.lastSession.trim().slice(0, 80);
    if (typeof raw.railClosed === 'boolean') out.railClosed = raw.railClosed;
    if (raw.agent && typeof raw.agent === 'object') out.agent = raw.agent;
    out.v = Number(raw.v) || 0;
    /* 一次性迁移：v<1 的配置里 thinking==='off' 是老语义（只做一次查询）。
       新语义下 off 只省查证步骤、不省答案内容，但老用户当初选它是为了省钱，
       继续按 off 跑会重复「一句话结论」的体验，所以提到 medium。 */
    if (out.v < 1) {
      if (out.thinking === 'off') out.thinking = 'medium';
      out.v = 1;
    }
    return out;
  }

  async function loadUi(force) {
    if (uiCache && !force) return uiCache;
    let cfg = {};
    try { cfg = await API.configGet(); } catch { cfg = {}; }
    const rawUi = (cfg && cfg.ai_ui) || null;
    uiCache = normalizeUi(rawUi);
    /* 迁移只改内存等于没改：下次启动又读回旧值。发现真的动过就写回。 */
    if (rawUi && (Number(rawUi.v) || 0) !== uiCache.v) {
      try { await API.configSet({ ai_ui: uiCache }); } catch { /* 写不进去就下次再说 */ }
    }
    return uiCache;
  }

  async function saveUi(patch) {
    /* 必须先有基线再写：uiCache 为空时拿 UI_DEFAULTS 兜底，会把别处
       已经存好的 agent 档位、上次会话一起冲成默认值（1.30.0–1.30.2 的档位一重启就丢）。 */
    if (!uiCache) {
      try { await loadUi(true); } catch (e) { /* 读不到就按默认写，至少不崩 */ }
    }
    const next = normalizeUi(Object.assign({}, uiCache || UI_DEFAULTS, patch || {}));
    await API.configSet({ ai_ui: next });
    uiCache = next;
    return next;
  }

  let cache = null;

  /* 控制台给的是 base URL（…/v1、…/compatible-mode/v1），直接发请求会 404。
     统一补成 …/chat/completions；已经是完整地址的原样保留。 */
  function normEndpoint(u) {
    const s = String(u || '').trim();
    if (!s) return s;
    if (/\/chat\/completions\/?$/i.test(s)) return s.replace(/\/+$/, '');
    if (/\/(v\d+[a-z]*|compatible-mode\/v1|openai\/v1|api\/v1|api\/coding\/\w+\/v\d+)\/?$/i.test(s)) {
      return s.replace(/\/+$/, '') + '/chat/completions';
    }
    return s;
  }

  function normalize(raw) {
    const out = Object.assign({}, DEFAULTS);
    if (!raw || typeof raw !== 'object') return out;
    if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
    if (typeof raw.endpoint === 'string') out.endpoint = normEndpoint(raw.endpoint);
    if (typeof raw.key === 'string') out.key = raw.key.trim();
    if (typeof raw.model === 'string') out.model = raw.model.trim();
    if (Array.isArray(raw.models)) {
      const seen = new Set();
      out.models = raw.models
        .map((x) => (typeof x === 'string' ? x.trim() : ''))
        .filter((x) => {
          if (!x || x.length > 120 || seen.has(x)) return false;
          seen.add(x);
          return true;
        })
        .slice(0, 200);
    }
    /* 温度三态在存储里用 tempAuto 表达，不靠「null 还是数字」猜：
       老配置没有 tempAuto 字段，那时的 0.2 是软件写死的默认值（不是用户选的），
       正好等于「自动」，所以缺省按自动处理；用户真改过别的值就当他手填。 */
    if (typeof raw.temperature === 'number' && raw.temperature >= 0 && raw.temperature <= 2) out.temperature = raw.temperature;
    if (typeof raw.tempAuto === 'boolean') out.tempAuto = raw.tempAuto;
    else out.tempAuto = !(typeof raw.temperature === 'number' && Math.abs(raw.temperature - 0.2) > 1e-9);
    if (typeof raw.jsonMode === 'boolean') out.jsonMode = raw.jsonMode;
    /* 步数上限：强度档位另有自己的轮数，这里只当总闸用 */
    const steps = Number(raw.maxSteps);
    if (steps >= 1 && steps <= 30) out.maxSteps = Math.round(steps);
    const budget = Number(raw.turnBudget);
    if (budget >= 2000 && budget <= 4000000) out.turnBudget = Math.round(budget);
    const win = Number(raw.ctxWindow);
    if (win >= 2000 && win <= 4000000) out.ctxWindow = Math.round(win);
    if (raw.modelCtx && typeof raw.modelCtx === 'object' && !Array.isArray(raw.modelCtx)) {
      const map = {};
      Object.keys(raw.modelCtx).slice(0, 200).forEach((k) => {
        const v = Number(raw.modelCtx[k]);
        if (typeof k === 'string' && k && k.length <= 120 && v >= 1000 && v <= 2000000) map[k] = Math.round(v);
      });
      out.modelCtx = map;
    }
    /* 旧默认值的迁移：模型没报过窗口时，1.35.x 把 32768 写进设置，还按 8000 token
       分历史——「选深反而记得少」就是这两笔账造成的。它们由软件写入、不是用户选的值，
       第一次加载时清掉，交给 inferCtx / 窗口比例压缩接管。迁完打标记，只做一次。 */
    if (raw.ctxFixed === true) out.ctxFixed = true;
    if (!out.ctxFixed) {
      const legacyWin = [8192, 16384, 32768, 65536].indexOf(Number(out.ctxWindow)) >= 0;
      const legacyBudget = Number(out.turnBudget) === 8000;
      const reported = (out.modelCtx || {})[String(out.model || '')];
      if (!reported) {
        if (legacyWin) out.ctxWindow = 0;
        if (legacyBudget) out.turnBudget = 0;
      }
      out.ctxFixed = true;
    }
    if (raw.caps && typeof raw.caps === 'object' && !Array.isArray(raw.caps)) {
      const caps = {};
      Object.keys(raw.caps).slice(0, 60).forEach((k) => {
        const v = raw.caps[k];
        if (typeof k !== 'string' || !k || k.length > 200) return;
        if (!v || typeof v !== 'object' || Array.isArray(v)) return;
        const one = {};
        ['jsonMode', 'streamOptions', 'stream', 'reasoning', 'noJson', 'noTemperature',
          'noReasoningEffort', 'noThinking', 'noReasoning'].forEach((f) => {
          if (typeof v[f] === 'boolean') one[f] = v[f];
        });
        if (v.tokenParam === 'max_tokens' || v.tokenParam === 'max_completion_tokens') one.tokenParam = v.tokenParam;
        /* nativeTools 是「这个端点认不认 function calling」的结论：
           true 记得住（下次直接按原生发），false 也记得住（永久回落 JSON）。 */
        if (typeof v.nativeTools === 'boolean') one.nativeTools = v.nativeTools;
        ['maxTokens', 'latencyMs', 'timeoutMs'].forEach((f) => {
          const n = Number(v[f]);
          if (Number.isFinite(n) && n > 0 && n <= 400000) one[f] = Math.round(n);
        });
        one.updatedAt = Number(v.updatedAt) || Date.now();
        caps[k] = one;
      });
      out.caps = caps;
    }
    /* 备用端点：最多 5 条，只留 endpoint/model/key 三个字段。
       空项直接丢掉——界面上删到一半的空白行不该变成一条「配置」。 */
    if (Array.isArray(raw.fallbacks)) {
      const list = [];
      const seen = new Set();
      raw.fallbacks.forEach((f) => {
        if (!f || typeof f !== 'object') return;
        const endpoint = normEndpoint(typeof f.endpoint === 'string' ? f.endpoint : '');
        const model = typeof f.model === 'string' ? f.model.trim().slice(0, 120) : '';
        if (!endpoint || !model) return;
        const id = endpoint + '|' + model;
        if (seen.has(id)) return;
        seen.add(id);
        const one = { endpoint: endpoint, model: model };
        if (typeof f.key === 'string' && f.key.trim()) one.key = f.key.trim();
        list.push(one);
      });
      out.fallbacks = list.slice(0, 5);
    }
    return out;
  }

  async function load(force) {
    if (cache && !force) return cache;
    let cfg = {};
    try { cfg = await API.configGet(); } catch { cfg = {}; }
    const rawAi = (cfg && cfg.ai) || null;
    cache = normalize(rawAi);
    /* 迁移只改内存是没用的：下次启动还会从文件里读到那两笔旧账。
       发现这次真的改过（迁完 ctxFixed 由 false 变 true）就立刻写回。 */
    if (rawAi && rawAi.ctxFixed !== true && cache.ctxFixed === true) {
      try { await API.configSet({ ai: cache }); } catch { /* 写不进去就下次再说 */ }
    }
    /* 老配置里只存了 base URL（例如百炼 …/compatible-mode/v1），运行时会 404；
       读一次就补全并写回，用户不用自己改。 */
    if (rawAi && typeof rawAi.endpoint === 'string' && rawAi.endpoint !== cache.endpoint) {
      try { await API.configSet({ ai: cache }); } catch { /* 同上 */ }
    }
    return cache;
  }

  async function save(patch) {
    const next = normalize(Object.assign({}, cache || DEFAULTS, patch || {}));
    await API.configSet({ ai: next });
    cache = next;
    return next;
  }

  function isConfigured(s) {
    const c = s || cache || DEFAULTS;
    return !!(c.endpoint && c.key && c.model);
  }

  function maskKey(key) {
    const k = String(key || '');
    if (!k) return '';
    if (k.length <= 8) return '••••';
    return k.slice(0, 3) + '••••' + k.slice(-4);
  }

  /* ---------------- 会话 ---------------- */

  const idOf = (name) => String(name || '').replace(/^s-/, '').replace(/\.json$/, '');

  async function listSessions() {
    const r = await API.aiStore('list', null, null);
    const items = ((r && r.items) || [])
      .filter((it) => /^s-.*\.json$/.test(it.name))
      .map((it) => ({ name: it.name, id: idOf(it.name), size: it.size, mtime: it.mtime }));
    return items;
  }

  async function loadSession(id) {
    const name = id.startsWith('s-') ? id : 's-' + id;
    const r = await API.aiStore('read', name + (name.endsWith('.json') ? '' : '.json'), null);
    try {
      const obj = JSON.parse(r.content);
      if (obj && Array.isArray(obj.messages)) return obj;
    } catch { /* 坏文件当作空会话 */ }
    return null;
  }

  /* ---------------- 会话落盘：白名单 + 上限 ----------------
     只落「回看要用到」的东西：正文、查证过程、依据、建议、可点入口、用量、
     执行记录。原始工具结果可能几十 KB（一次 list_dir 就够呛），所以按长度
     决定保不保——留在会话里是为了解释「当时凭什么这么说」，不是为了存全量。

     上限写在这里而不是散在各处：会话文件小，读回来才快，坏一个也只坏一条。 */
  const LIMITS = {
    messages: 60,
    trace: 24,
    summary: 300,
    error: 200,
    thought: 400,
    result: 600,
    suggest: 6,
    evidence: 8,
    entries: 16,
    acts: 40,
    paths: 8,
    /* system 提示是「规则本身」，不是对话内容：它一被截断，模型就开始
       不守规矩（不调工具、乱编体积），而且截断点在句子中间，看不出被截过。
       给到 32KB 远大于实测 4KB，正常永远碰不到这个上限。 */
    system: 32000
  };

  function cut(v, n) {
    const s = v == null ? '' : String(v);
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  /* 落盘与恢复都只认这三种角色：别的一律当 user。
     以前这里是 `x.role === 'assistant' ? 'assistant' : 'user'`，
     把 system 折成 user —— 见 slimMsg 里 checkpoint 那段注释。 */
  const ROLES = { system: 'system', user: 'user', assistant: 'assistant' };
  function roleOf(r) {
    return ROLES[String(r || '')] || 'user';
  }

  function slimStep(t) {
    if (!t) return null;
    const out = {
      tool: t.tool || '',
      ok: t.ok !== false,
      ms: Math.max(0, Math.round(Number(t.ms) || 0)),
      summary: cut(t.summary, LIMITS.summary)
    };
    const a = t.args || {};
    /* 参数只留位置类字段：这些是回放「当时查了哪里」唯一有用的部分 */
    const args = {};
    ['dir', 'path', 'kind', 'pattern', 'depth'].forEach((k) => {
      if (a[k] !== undefined && a[k] !== null && a[k] !== '') args[k] = a[k];
    });
    if (Array.isArray(a.paths)) args.paths = a.paths.slice(0, LIMITS.paths);
    if (Object.keys(args).length) out.args = args;
    /* 回放要用到「这一步是思考什么、工具叫什么」：label 是类别名（磁盘 / 空文件夹），
       thought 是模型在调这个工具之前想的那段。以前这两样都没存，
       历史里的过程行只剩英文工具名，思考更是整段消失 */
    if (t.label) out.label = cut(t.label, 60);
    if (t.thought) out.thought = cut(t.thought, LIMITS.thought);
    if (t.error) out.error = cut(t.error, LIMITS.error);
    if (t.result) {
      let json = '';
      try { json = JSON.stringify(t.result); } catch { json = ''; }
      if (json && json.length <= LIMITS.result) out.result = t.result;
    }
    return out;
  }

  function slimMsg(m) {
    const base = { role: m.role, content: String(m.content || ''), at: m.at || Date.now() };
    if (m.role !== 'assistant') return base;
    base.ok = m.ok !== false;
    /* 这三样也是回放那一行要用的：计数（想了几次、调了几次、记了几条）、
       状态词（已停止 / 未完成）、压缩提示 */
    if (m.status) base.status = String(m.status);
    if (m.counts && typeof m.counts === 'object') {
      base.counts = {
        thoughts: Number(m.counts.thoughts) || 0,
        tools: Number(m.counts.tools) || 0,
        records: Number(m.counts.records) || 0
      };
    }
    if (m.compressed && m.compressed !== 'none') base.compressed = String(m.compressed);
    if (Array.isArray(m.trace) && m.trace.length) {
      base.trace = m.trace.slice(-LIMITS.trace).map(slimStep).filter(Boolean);
    }
    if (Array.isArray(m.evidence) && m.evidence.length) {
      base.evidence = m.evidence.slice(-LIMITS.evidence).map((e) => ({
        tool: e && e.tool ? String(e.tool) : '',
        ok: !e || e.ok !== false,
        summary: cut(e && e.summary, LIMITS.summary)
      }));
    }
    if (Array.isArray(m.suggest) && m.suggest.length) {
      base.suggest = m.suggest.slice(0, LIMITS.suggest).map((s) => ({
        action: (s && s.action) || 'check',
        why: cut(s && s.why, LIMITS.summary),
        paths: ((s && s.paths) || []).slice(0, 5)
      }));
    }
    if (Array.isArray(m.entries) && m.entries.length) {
      base.entries = m.entries.slice(0, LIMITS.entries).map((e) => ({
        p: String(e && e.p ? e.p : ''),
        k: e && e.k === 'file' ? 'file' : 'dir',
        n: String((e && e.n) || ''),
        s: String((e && e.s) || ''),
        src: String((e && e.src) || 'tool')
      }));
    }
    if (m.usage) {
      const u = m.usage;
      base.usage = {
        steps: Number(u.steps) || 0,
        elapsed_ms: Number(u.elapsed_ms) || 0,
        prompt_tokens: Number(u.prompt_tokens) || 0,
        completion_tokens: Number(u.completion_tokens) || 0,
        prompt_cache_hit_tokens: Number(u.prompt_cache_hit_tokens) || 0,
        /* 服务端上报过思考 token 才有这个字段：有就存，回看时不用再估算 */
        reasoning_tokens: Number(u.reasoning_tokens) || 0,
        reasoning_reported: !!u.reasoning_reported
      };
    }
    /* 强度与温度：这条答案当时按哪档跑、温度是多少、温度从哪来。
       只存结论不存档位表——档位表会随版本变，回看时按 id 现查。 */
    if (m.policy && typeof m.policy === 'object') {
      base.policy = {
        level: String(m.policy.level || ''),
        temperature: typeof m.policy.temperature === 'number' ? m.policy.temperature : null,
        tempSrc: String(m.policy.tempSrc || ''),
        task: String(m.policy.task || ''),
        think: Number(m.policy.think) || 0
      };
    }
    /* 断点也落盘：不存的话，关掉软件再打开，那一轮「继续」就没了，
       用户只能把问题重说一遍 —— 看上去就是「它不记得自己做过什么」。
       断点里的 messages 已经是这一轮的真实上下文，是恢复时唯一可靠的凭据。 */
    if (m.checkpoint && typeof m.checkpoint === 'object' && Array.isArray(m.checkpoint.messages)) {
      base.checkpoint = {
        v: Number(m.checkpoint.v) || 1,
        steps: Number(m.checkpoint.steps) || 0,
        calledTools: (m.checkpoint.calledTools || []).slice(-LIMITS.trace).map(String),
        compressed: String(m.checkpoint.compressed || 'none'),
        /* messages 可能很长，但这是续跑的本体：截太狠会让「继续」变成
           「带着半截上下文重新猜」。这里只挡一个上限，正常一轮远达不到。
           角色必须原样保留：以前把非 assistant 一律写成 user，system 提示
           落盘后变成一条 user 消息，重启点「继续」时模型面前就没有规则了
           （实测被腰斩在 4001 字，正好是 cut 的上限）。 */
        messages: m.checkpoint.messages.slice(-60).map((x) => ({
          role: roleOf(x && x.role),
          content: cut(x && x.content, roleOf(x && x.role) === 'system' ? LIMITS.system : 4000)
        })),
        trace: (m.checkpoint.trace || []).slice(-LIMITS.trace).map(slimStep).filter(Boolean)
      };
    }
    return base;
  }

  function slimAct(a) {
    if (!a || !a.action) return null;
    return {
      at: a.at || Date.now(),
      action: String(a.action),
      ok: a.ok !== false,
      undone: !!a.undone,
      summary: cut(a.summary || a.message, LIMITS.summary),
      paths: (a.paths || []).slice(0, LIMITS.paths)
    };
  }

  async function saveSession(session) {
    if (!session || !session.id) throw new Error('会话缺少 id');
    const payload = {
      id: session.id,
      title: String(session.title || '新会话').slice(0, 60),
      created: session.created || Date.now(),
      updated: Date.now(),
      version: 3,
      messages: (session.messages || []).slice(-LIMITS.messages).map(slimMsg)
    };
    const acts = (session.acts || []).slice(-LIMITS.acts).map(slimAct).filter(Boolean);
    if (acts.length) payload.acts = acts;
    await API.aiStore('write', 's-' + payload.id + '.json', JSON.stringify(payload));
    await pruneSessions();
    return payload;
  }

  async function deleteSession(id) {
    const clean = String(id).replace(/^s-/, '').replace(/\.json$/, '');
    return API.aiStore('delete', 's-' + clean + '.json', null);
  }

  async function pruneSessions() {
    const list = await listSessions();
    if (list.length <= MAX_SESSIONS) return 0;
    const drop = list.slice(MAX_SESSIONS);
    for (const it of drop) {
      try { await API.aiStore('delete', it.name, null); } catch { /* 忽略单个删除失败 */ }
    }
    return drop.length;
  }

  async function clearAll() {
    return API.aiStore('clear', null, null);
  }

  async function logUsage(entry) {
    const row = Object.assign({ at: new Date().toISOString() }, entry || {});
    try { await API.aiStore('append', 'usage.jsonl', JSON.stringify(row)); } catch { /* 用量记录失败不影响对话 */ }
  }

  const API_ = {
    PROVIDERS,
    DEFAULTS,
    UI_DEFAULTS,
    FALLBACK_CTX,
    inferCtx,
    MAX_SESSIONS,
    normalize,
    normalizeUi,
    load,
    save,
    loadUi,
    saveUi,
    isConfigured,
    maskKey,
    normEndpoint,
    listSessions,
    loadSession,
    saveSession,
    deleteSession,
    clearAll,
    logUsage
  };
  root.AIStore = API_;
  /* 自检要直接验「落盘后还能捡回来」：把精简器一起导出，
     否则只能整套跑浏览器环境才测得到。 */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Object.assign({}, API_, { slimMsg, slimStep, LIMITS, roleOf });
  }
})(typeof window !== 'undefined' ? window : globalThis);
