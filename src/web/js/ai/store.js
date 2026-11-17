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
    temperature: 0.2,
    jsonMode: true,
    maxSteps: 6,
    turnBudget: 8000
  };

  /* 端点没报窗口时的保守兜底：32K。
     界面上会明确写「未上报，按 32K 处理」，不会假装读过。 */
  const FALLBACK_CTX = 32768;

  const MAX_SESSIONS = 20;

  let cache = null;

  function normalize(raw) {
    const out = Object.assign({}, DEFAULTS);
    if (!raw || typeof raw !== 'object') return out;
    if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
    if (typeof raw.endpoint === 'string') out.endpoint = raw.endpoint.trim();
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
    if (typeof raw.temperature === 'number' && raw.temperature >= 0 && raw.temperature <= 2) out.temperature = raw.temperature;
    if (typeof raw.jsonMode === 'boolean') out.jsonMode = raw.jsonMode;
    const steps = Number(raw.maxSteps);
    if (steps >= 1 && steps <= 10) out.maxSteps = Math.round(steps);
    const budget = Number(raw.turnBudget);
    if (budget >= 2000 && budget <= 400000) out.turnBudget = Math.round(budget);
    const win = Number(raw.ctxWindow);
    if (win >= 2000 && win <= 2000000) out.ctxWindow = Math.round(win);
    if (raw.modelCtx && typeof raw.modelCtx === 'object' && !Array.isArray(raw.modelCtx)) {
      const map = {};
      Object.keys(raw.modelCtx).slice(0, 200).forEach((k) => {
        const v = Number(raw.modelCtx[k]);
        if (typeof k === 'string' && k && k.length <= 120 && v >= 1000 && v <= 2000000) map[k] = Math.round(v);
      });
      out.modelCtx = map;
    }
    return out;
  }

  async function load(force) {
    if (cache && !force) return cache;
    let cfg = {};
    try { cfg = await API.configGet(); } catch { cfg = {}; }
    cache = normalize(cfg && cfg.ai);
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

  async function saveSession(session) {
    if (!session || !session.id) throw new Error('会话缺少 id');
    const payload = {
      id: session.id,
      title: String(session.title || '新会话').slice(0, 60),
      created: session.created || Date.now(),
      updated: Date.now(),
      messages: (session.messages || []).slice(-60)
    };
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
    FALLBACK_CTX,
    MAX_SESSIONS,
    normalize,
    load,
    save,
    isConfigured,
    maskKey,
    listSessions,
    loadSession,
    saveSession,
    deleteSession,
    clearAll,
    logUsage
  };
  root.AIStore = API_;
})(typeof window !== 'undefined' ? window : globalThis);
