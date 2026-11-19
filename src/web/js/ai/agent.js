/* AI 助手 · 本地 agent 环路（无 DOM，可在 Node 里直接跑黄金集）
   ------------------------------------------------------------
   为什么环路在 JS 而不是引擎：引擎是单线程 stdin/stdout，一次调用只读一行，
   跑起来没法取消；`_engine_progress` 在引擎模式下被吞掉。详见方案 §3。

   一次 run() 的结构（方案 §5）：
     system(稳定段) → 历史(压缩后) → user(问题+一行上下文)
     循环：模型 → 校验 → 越权拒绝 / 调工具 → 结果回灌；直到出 answer 或用尽步数

   可测性（方案 §13）：transport 与 tools 都是注入的，
   黄金集里用脚本化的 transport 就能覆盖「越权、坏 JSON、工具报错、步数耗尽」。 */
(function (root) {
  'use strict';

  const DEFAULT_MAX_STEPS = 6;
  const DEFAULT_TURN_BUDGET = 8000;      // token（按字符数/2 估算），只在调用方显式给预算时用

  /** 从一家厂商的 usage 里挖出「思考用了多少 token」。
   *  挖不到就返回 null —— 调用方据此说「未上报」，而不是拿 0 冒充精确值。 */
  function thinkTokensOf(usage) {
    if (!usage || typeof usage !== 'object') return null;
    const cands = [
      usage.reasoning_tokens,
      usage.reasoning,
      usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens,
      usage.output_tokens_details && usage.output_tokens_details.reasoning_tokens
    ];
    for (let i = 0; i < cands.length; i += 1) {
      const n = Number(cands[i]);
      if (Number.isFinite(n) && n > 0) return Math.round(n);
    }
    return null;
  }
  /* 上下文窗口不知道的时候按 1M 算：DeepSeek V4 / GPT-5 这一代都在 1M 量级，
     保守取 32K 会让「明明装得下」的对话先被掐掉，那才是真正的失忆。 */
  const DEFAULT_WINDOW = 1000000;
  /* 20s 只够 chat 小模型；实测 glm-4.7-flash 单轮 118s、中转站推理模型 71s，
     超时会被当成失败，用户看到的是「AI 没能给出结论」。
     流式下这个值是「多久没收到新数据算断」，不是总时长。 */
  const DEFAULT_CALL_TIMEOUT = 180000;
  /* 原来硬编码 700：300 字中文 + evidence/suggest 会被截断成「JSON 没有闭合」 */
  const DEFAULT_REPLY_TOKENS = 1400;
  const MAX_REPLY_TOKENS = 8192;
  const REPLY_MAX_CHARS = 600;
  const KEEP_TURNS = 3;                  // 原文保护的最近轮数
  /* 一步里最多并行给几个工具：彼此独立的一次查询合成一轮，
     少一次往返就少一次整段 prompt 的重发（长上下文下这最费钱）。
     上限 3 是提示词与校验共用的一条；再多模型容易挑错，收益也饱和。 */
  const MAX_BATCH_TOOLS = 3;

  const estTokens = (text) => Math.ceil(String(text || '').length / 2);

  /** 用户点「停止」时统一用这个错误穿出去：上层据此返回「已停止」而不是「调用失败」 */
  const abortError = () => Object.assign(new Error('已停止'), { code: 'aborted' });

  const SUGGEST_ACTIONS = ['delete', 'archive', 'check', 'none'];

  /* ---------------- 输出解析 ---------------- */

  /** 从模型返回的 content 里取出 JSON 对象：容忍 ```json 围栏与前后废话 */
  /* 模型写 Windows 路径时经常忘了转义："D:\Tools\_aitest" 里的 \T \_ 不是合法转义，
     JSON.parse 直接抛错。这不是模型「答错」，只是漏了反斜杠，按字面意思补一层就对了。
     只补不合法的那些，合法转义（\" \\ \/ \b \f \n \r \t \uXXXX）原样保留。 */
  function fixEscapes(raw) {
    return String(raw)
      .replace(/\\(?!["\\/bfnrtu])/g, '\\\\')
      .replace(/\\u(?![0-9a-fA-F]{4})/g, '\\\\u');
  }

  /** 模型写 "D:\tools" 时 JSON 里的 \t 是合法转义，fixEscapes 管不了，
   *  解析出来就是一个制表符，显示成 "D:	ools"。回答里本来不允许出现制表符
   *  （格式规定一行一条），所以把制表符还原成「\T」——路径就对了。 */
  function repairStrings(node) {
    if (typeof node === 'string') return node.replace(/\t/g, '\\T');
    if (Array.isArray(node)) return node.map(repairStrings);
    if (node && typeof node === 'object') {
      const out = {};
      for (const k of Object.keys(node)) out[k] = repairStrings(node[k]);
      return out;
    }
    return node;
  }

  function extractJson(text) {
    let s = String(text || '').trim();
    if (!s) return { error: '模型返回了空内容' };
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1].trim();
    const start = s.search(/[{]/);
    if (start < 0) return { error: '模型没有输出 JSON 对象' };
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < s.length; i += 1) {
      const c = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '{') depth += 1;
      else if (c === '}') {
        depth -= 1;
        if (depth === 0) {
          let raw = s.slice(start, i + 1);
          let obj = null;
          try {
            obj = JSON.parse(raw);
          } catch (e0) {
            try {
              obj = JSON.parse(fixEscapes(raw));
            } catch (e1) {
              return { error: 'JSON 解析失败：' + (e0 && e0.message ? e0.message : e0) };
            }
          }
          if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
            return { error: '输出的不是 JSON 对象' };
          }
          return { obj: repairStrings(obj) };
        }
      }
    }
    return { error: 'JSON 没有闭合' };
  }

  /** 弱模型（glm-4-flash 这类）会把回答直接写成散文，怎么要求都不给 JSON。
   *  这时别硬失败：把整段文字当 answer 兜住，用户至少能看到答案。
   *  只在「完全没有 { 的纯文本」时启用，避免把半截 JSON 猜错。 */
  function salvageProse(text) {
    const s = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
    if (!s || s.indexOf('{') >= 0) return null;
    if (s.length < 4 || s.length > 1600) return null;
    return { answer: s.slice(0, 1200), evidence: [], suggest: [] };
  }

  /* 参数类型/范围校验（方案 §7 第 3 条） */
  const NUM_CAP = {
    list_dir: { limit: 200 },
    top_files: { limit: 50 },
    empty_dirs: { depth: 3 },
    search_files: { limit: 20 }
  };

  function checkArgs(tool, args) {
    if (args === undefined) return { ok: true, args: {} };
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return { ok: false, error: 'args 必须是 JSON 对象' };
    }
    if (tool === 'file_signals') {
      if (!Array.isArray(args.paths)) return { ok: false, error: 'file_signals 需要 paths 字符串数组' };
      if (args.paths.length > 20) return { ok: false, error: 'paths 一次最多 20 个' };
      if (args.paths.some((p) => typeof p !== 'string')) return { ok: false, error: 'paths 里只能放字符串' };
    }
    if (tool === 'organize_preview') {
      if (!Array.isArray(args.paths)) return { ok: false, error: 'organize_preview 需要 paths 字符串数组' };
      if (args.paths.length > 50) return { ok: false, error: 'paths 一次最多 50 个' };
    }
    if (tool === 'search_files') {
      if (typeof args.q !== 'string' || !args.q.trim()) return { ok: false, error: 'search_files 需要 q 字符串' };
    }
    /* 分页参数：结果被截断时按 next_offset 再取一页。
       上限 5000 是「翻得太深不如换个更小的目录」的那条线。 */
    if (args.offset !== undefined) {
      const off = Number(args.offset);
      if (!Number.isFinite(off) || off < 0 || off > 5000) return { ok: false, error: 'offset 必须是 0–5000 的数' };
    }
    const caps = NUM_CAP[tool];
    if (caps) {
      for (const k of Object.keys(caps)) {
        if (args[k] === undefined) continue;
        const n = Number(args[k]);
        if (!Number.isFinite(n) || n <= 0) return { ok: false, error: `${k} 必须是正数` };
        if (n > caps[k]) return { ok: false, error: `${k} 不能超过 ${caps[k]}` };
      }
    }
    if (['list_dir', 'top_files', 'empty_dirs'].includes(tool)) {
      if (typeof args.dir !== 'string' || !args.dir.trim()) return { ok: false, error: `${tool} 需要 dir 字符串` };
    }
    return { ok: true, args };
  }

  /** 校验一步输出；ctxTools 决定白名单，calledTools 用于校验 evidence 真实性 */
  function validateStep(obj, ctxTools, calledTools) {
    if (!obj || typeof obj !== 'object') return { ok: false, error: '不是 JSON 对象' };
    const hasTool = Object.prototype.hasOwnProperty.call(obj, 'tool') && obj.tool !== null && obj.tool !== undefined;
    const hasAnswer = Object.prototype.hasOwnProperty.call(obj, 'answer') && obj.answer !== null && obj.answer !== undefined;
    const hasBatch = Array.isArray(obj.tools);
    if (hasTool && hasAnswer) return { ok: false, error: 'tool 与 answer 只能出现一个' };
    if (hasBatch && hasAnswer) return { ok: false, error: 'tools 与 answer 只能出现一个' };
    if (hasBatch && hasTool) return { ok: false, error: 'tool 与 tools 只能出现一个' };
    if (!hasTool && !hasAnswer && !hasBatch) return { ok: false, error: '必须包含 tool、tools 或 answer' };

    /* 一步多个互不依赖的查询：{"tools":[{tool,args},...]}
       执行上仍是顺序的（引擎调用本来就是串行的），省的是模型往返与整段重发。 */
    if (hasBatch) {
      const list = obj.tools;
      if (!list.length) return { ok: false, error: 'tools 不能是空数组' };
      if (list.length > MAX_BATCH_TOOLS) return { ok: false, error: `一次最多 ${MAX_BATCH_TOOLS} 个工具` };
      const seen = new Set();
      const calls = [];
      for (const it of list) {
        if (!it || typeof it !== 'object' || Array.isArray(it)) return { ok: false, error: 'tools 里每一项都要是对象' };
        const name = String(it.tool || '').trim();
        if (!name) return { ok: false, error: 'tools 里有一项缺少 tool' };
        if (!ctxTools.includes(name)) return { ok: false, kind: 'forbidden', tool: name, error: `工具不存在：${name}` };
        const a = checkArgs(name, it.args);
        if (!a.ok) return { ok: false, error: a.error };
        const key = name + '|' + JSON.stringify(a.args || {});
        if (seen.has(key)) return { ok: false, error: 'tools 里有重复的同一调用' };
        seen.add(key);
        calls.push({ tool: name, args: a.args });
      }
      return { ok: true, kind: 'tools', tools: calls, thought: String(obj.thought || '').slice(0, 200) };
    }

    if (hasTool) {
      const name = String(obj.tool || '').trim();
      if (!name) return { ok: false, error: 'tool 不能为空' };
      if (!ctxTools.includes(name)) {
        // 越权（含模型幻觉出的 delete/move）：这是最硬的一条，绝不「猜你想调」
        return { ok: false, kind: 'forbidden', error: `工具不存在：${name}` };
      }
      const a = checkArgs(name, obj.args);
      if (!a.ok) return { ok: false, error: a.error };
      return { ok: true, kind: 'tool', tool: name, args: a.args, thought: String(obj.thought || '').slice(0, 200) };
    }

    const answer = String(obj.answer || '').trim();
    if (!answer) return { ok: false, error: 'answer 不能为空' };
    if (answer.length > REPLY_MAX_CHARS * 2) return { ok: false, error: 'answer 太长（超过 1200 字）' };

    const called = new Set(calledTools || []);
    const evidence = [];
    if (Array.isArray(obj.evidence)) {
      for (const ev of obj.evidence) {
        const t = ev && typeof ev === 'object' ? String(ev.tool || '') : String(ev || '');
        if (!t) continue;
        if (!called.has(t)) {
          return { ok: false, error: `evidence 引用了没有调用过的工具：${t}` };
        }
        evidence.push({ tool: t });
      }
    }
    const suggest = [];
    if (Array.isArray(obj.suggest)) {
      for (const s of obj.suggest.slice(0, 5)) {
        if (!s || typeof s !== 'object') continue;
        const action = String(s.action || '').toLowerCase();
        if (!SUGGEST_ACTIONS.includes(action)) return { ok: false, error: `suggest.action 只能是 ${SUGGEST_ACTIONS.join(' / ')}` };
        const paths = Array.isArray(s.paths) ? s.paths.filter((p) => typeof p === 'string').slice(0, 20) : [];
        suggest.push({ action, paths, why: String(s.why || '').slice(0, 120) });
      }
    }
    return { ok: true, kind: 'answer', answer, evidence, suggest, thought: String(obj.thought || '').slice(0, 200) };
  }

  /* ---------------- 历史压缩（方案 §6） ---------------- */

  /* 上下文压缩：阈值按「模型窗口」的百分比算，不按写死的 token 数。
     50% 以下不动；50–70% 软裁剪（工具结果留头尾）；
     70–85% 硬裁剪（更早的工具结果压成一行）；
     ≥85% 摘要压缩（更早的对话压成一行速记，保留路径与否定结论）。
     窗口来自端点上报（没报就按模型名推断，默认 1M），所以同一套代码在 32K
     和 1M 的模型上都不会「明明装得下却先掐掉」。 */
  function compressHistory(msgs, window) {
    const win = Math.max(4000, Number(window) || DEFAULT_WINDOW);
    const total = () => msgs.reduce((n, m) => n + estTokens(m.content), 0);
    if (total() <= win * 0.5) return { msgs, level: 'none' };
    const keepIdx = Math.max(1, msgs.length - KEEP_TURNS * 2);
    let level = 'soft';
    // 50–70%：软裁剪，工具结果留头 8 行 + 尾 2 行
    for (let i = 1; i < keepIdx; i += 1) {
      const m = msgs[i];
      if (m.role !== 'user' || !/^工具结果/.test(m.content)) continue;
      const lines = m.content.split('\n');
      if (lines.length > 11) {
        msgs[i] = { role: 'user', content: lines.slice(0, 8).concat(['…（已截断）'], lines.slice(-2)).join('\n') };
      }
    }
    if (total() <= win * 0.7) return { msgs, level };
    // 70–85%：硬裁剪，更早的工具结果压成一行
    level = 'hard';
    for (let i = 1; i < keepIdx; i += 1) {
      const m = msgs[i];
      if (m.role !== 'user' || !/^工具结果/.test(m.content)) continue;
      const head = m.content.split('\n')[0].slice(0, 60);
      msgs[i] = { role: 'user', content: head + ' …（早期结果已省略）' };
    }
    if (total() <= win * 0.85) return { msgs, level };
    // ≥85%：摘要压缩，把 keepIdx 之前压成一行速记（保留路径与否定结论）
    level = 'summary';
    const dropped = msgs.slice(1, keepIdx);
    const paths = [];
    const negatives = [];
    dropped.forEach((m) => {
      const found = m.content.match(/[A-Za-z]:\\[^\s"',）)]+/g);
      if (found) found.forEach((p) => { if (paths.length < 6 && !paths.includes(p)) paths.push(p); });
      if (/不能删|不要删|已安装|受保护|不要动/.test(m.content)) {
        const line = m.content.split('\n').find((l) => /不能删|不要删|已安装|受保护|不要动/.test(l));
        if (line && negatives.length < 4) negatives.push(line.trim().slice(0, 60));
      }
    });
    const note = ['【更早对话已压缩】'];
    if (paths.length) note.push('提到过的路径：' + paths.join('、'));
    if (negatives.length) note.push('已确认结论：' + negatives.join('；'));
    msgs.splice(1, keepIdx - 1, { role: 'user', content: note.join('\n') });
    return { msgs, level };
  }

  /* ---------------- 历史回合 ----------------
     用户原话：「没有上下文记忆，根本不知道我上面发了什么、它自己做了什么」。
     根因不在窗口大小，而在这里：以前只把 `{role,content}` 的答案正文塞回模型，
     这一轮查过什么、拿到什么结果，全部丢掉。于是用户说「继续」「那个文件夹呢」，
     模型既不知道刚才查过哪儿，也不知道哪几个数字是真查到的 —— 只能重新瞎猜。
     现在每个历史回合都带一行「上一轮记录」，把工具摘要和失败原因一起给它。 */

  /** 一个历史回合的自述：查了什么、拿到了什么、成没成 */
  function turnDigest(m) {
    const parts = [];
    const trace = Array.isArray(m.trace) ? m.trace : [];
    const ok = trace.filter((t) => t && t.ok);
    const bad = trace.filter((t) => t && !t.ok);
    if (ok.length) {
      parts.push('查过：' + ok.slice(0, 6).map((t) => t.summary || t.label || t.tool).join('；'));
    }
    if (bad.length) {
      parts.push('没查成：' + bad.slice(0, 4).map((t) => {
        const why = String(t.error || t.summary || '').slice(0, 40);
        return (t.label || t.tool) + (why ? '（' + why + '）' : '');
      }).join('；'));
    }
    if (m.status === 'unfinished' || m.ok === false) parts.push('这一轮没查完');
    if (m.status === 'stopped') parts.push('这一轮被中止');
    return parts.join(' · ');
  }

  /** 取最近 maxTurns 个完整回合（用户问 + 助手答 + 那一轮的查证记录） */
  function buildHistory(history, maxTurns) {
    const turns = [];
    let q = '';
    (Array.isArray(history) ? history : []).forEach((m) => {
      if (!m || !m.role) return;
      const text = String(m.content == null ? '' : m.content).trim();
      if (m.role === 'user') { q = text; return; }
      if (m.role !== 'assistant') return;
      turns.push({ q, a: text, d: turnDigest(m) });
      q = '';
    });
    /* 最后一条 user 没有配对 answer（上一轮挂了）也要留着：
       那就是用户「继续」要接上的那句话。 */
    if (q) turns.push({ q, a: '', d: '' });
    return turns.slice(-Math.max(1, maxTurns));
  }

  /* ---------------- 数字同源 ----------------
     用户原话里的「随便给一个数据」。提示词里写了「数字必须来自工具返回」，
     但那只是请求，不是闸门：模型换个单位、记串上一轮的结果，都能混过去。
     这里做一次机械比对：带体积单位的数字必须能在成功工具结果里找到同源值。 */

  const SIZE_UNITS = { B: 1, KB: 1024, MB: 1048576, GB: 1073741824, TB: 1099511627776 };

  /** 抽出文本里所有「数字 + 体积单位」，换算成字节 */
  function sizeTokens(text) {
    const out = [];
    const re = /(\d+(?:\.\d+)?)\s*(TB|GB|MB|KB|B)(?![A-Za-z])/gi;
    let m = re.exec(String(text || ''));
    while (m) {
      const n = Number(m[1]);
      const mul = SIZE_UNITS[String(m[2]).toUpperCase()] || 0;
      if (Number.isFinite(n) && mul) out.push(n * mul);
      m = re.exec(String(text || ''));
    }
    return out;
  }

  /** 答案里没有出处的体积值（字节）。没有可用参照时返回空，绝不凭空判错。 */
  function unsourcedSizes(answer, hay) {
    const have = sizeTokens(hay);
    if (!have.length) return [];
    const bad = [];
    sizeTokens(answer).forEach((v) => {
      /* 容差 2%：显示层会四舍五入成一位小数（3.3 GB），
         不能因为这一点点误差就把真数据判成编的。 */
      const hit = have.some((h) => Math.abs(h - v) <= Math.max(1024, h * 0.02));
      if (!hit && !bad.some((b) => Math.abs(b - v) <= Math.max(1024, v * 0.02))) bad.push(v);
    });
    return bad;
  }

  const fmtSize = (v) => {
    const n = Number(v) || 0;
    if (n >= SIZE_UNITS.TB) return (n / SIZE_UNITS.TB).toFixed(1) + ' TB';
    if (n >= SIZE_UNITS.GB) return (n / SIZE_UNITS.GB).toFixed(1) + ' GB';
    if (n >= SIZE_UNITS.MB) return (n / SIZE_UNITS.MB).toFixed(1) + ' MB';
    if (n >= SIZE_UNITS.KB) return (n / SIZE_UNITS.KB).toFixed(1) + ' KB';
    return n + ' B';
  };

  /* ---------------- 端点能力记忆 ----------------
     不同家的接口接受的字段不一样：有的不认 response_format，有的不认
     stream_options，有的根本不支持流式；同一家的不同模型耗时也差两个数量级。
     这里不按厂商名写死，而是「先按最全的请求发，报错就降级并记住」，
     下次同一个端点+模型直接按记住的能力发请求。 */

  /** 端点能力按「主机 + 模型名」记，换模型重新学：model 换了习惯也换 */
  function capKeyOf(endpoint, model) {
    let host = String(endpoint || '');
    try { host = new URL(String(endpoint || '')).host; } catch (e) { host = String(endpoint || '').replace(/^https?:\/\//i, '').split('/')[0]; }
    return (host || 'local') + '|' + String(model || 'default');
  }

  function readCaps(all, key) {
    const box = all && typeof all === 'object' ? all[key] : null;
    return box && typeof box === 'object' && !Array.isArray(box) ? Object.assign({}, box) : {};
  }

  /* ---------------- 环路 ---------------- */

  function createAgent(deps) {
    const transport = deps.transport;
    const tools = deps.tools;
    const prompt = deps.prompt;
    const settings = deps.settings || {};

    const maxSteps = Number(settings.maxSteps) || DEFAULT_MAX_STEPS;
    /* 压缩阈值跟着「模型窗口」走，跟思考强度无关：
       窗口是模型能力，不是深度旋钮。用户手填的 turnBudget 只当窗口用，
       三档仍是窗口的 50/70/85%。 */
    const ctxWin = Number(settings.ctxWindow) || 0;
    const budget = Number(settings.turnBudget) || ctxWin || DEFAULT_WINDOW;
    const callTimeout = Number(settings.callTimeout) || DEFAULT_CALL_TIMEOUT;
    const capKey = capKeyOf(settings.endpoint, settings.model);
    const caps = readCaps(settings.caps, capKey);

    /** 记住这个端点+模型的一个能力，落盘后下次直接照做 */
    function remember(patch) {
      Object.assign(caps, patch);
      caps.updatedAt = Date.now();
      if (typeof deps.learn === 'function') {
        try { deps.learn(capKey, Object.assign({}, caps)); } catch (e) { /* 记忆失败不影响这一轮 */ }
      }
    }

    /** 等待上限：用户设的、学到的耗时、默认值取最大；上限 300s（Rust 侧封顶） */
    function waitMs() {
      const seen = Number(caps.timeoutMs) || 0;
      const measured = (Number(caps.latencyMs) || 0) * 3;
      return Math.max(30000, Math.min(300000, Math.max(callTimeout, seen, measured)));
    }

    /** 单次回复的 token 上限：按「回复字数 × 1.6 + 结构余量」估，
     *  思考模式下回复更长（replyMax 由调用方按强度传入）：
     *  · 用户显式设了 maxTokens 就用它
     *  · 见过截断就以学到的更大值为准（不把这类模型一直卡在截断）
     *  · 再按上下文窗口封顶，别把 prompt 挤出去 */
    function replyTokens() {
      const ctxWin = Number(settings.ctxWindow) || Number(settings.window) || 0;
      const ceiling = ctxWin > 0
        ? Math.min(MAX_REPLY_TOKENS, Math.max(1024, Math.floor(ctxWin * 0.25)))
        : MAX_REPLY_TOKENS;
      const explicit = Number(settings.maxTokens);
      const learned = Number(caps.maxTokens) || 0;
      const chars = Number(settings.replyMax) || REPLY_MAX_CHARS;
      const base = explicit > 0
        ? Math.max(512, Math.round(explicit))
        : Math.max(DEFAULT_REPLY_TOKENS, Math.round(chars * 1.6) + 320);
      return Math.max(512, Math.min(ceiling, Math.max(base, learned)));
    }

    /* 强度原生字段：由 strength 层算好放在 settings.extraBody，
       这里只负责「被拒过就摘掉」。摘掉的是字段本身，不是整轮请求——
       认不出 reasoning_effort 的接口照样能用提示词里的强度规则工作。 */
    function extraFields() {
      const src = settings.extraBody;
      if (!src || typeof src !== 'object') return null;
      const out = {};
      let any = false;
      Object.keys(src).forEach((k) => {
        if (k === 'reasoning_effort' && caps.noReasoningEffort === true) return;
        if (k === 'reasoning' && caps.noReasoning === true) return;
        if ((k === 'thinking' || k === 'enable_thinking' || k === 'thinking_budget') && caps.noThinking === true) return;
        out[k] = src[k];
        any = true;
      });
      return any ? out : null;
    }

    function buildBody(messages, stream, maxTokens) {
      const body = {
        model: settings.model || '',
        messages,
        stream: !!stream
      };
      /* OpenAI 的推理模型（o1/o3/gpt-5 这类）不认 max_tokens，要 max_completion_tokens；
         有的模型连 temperature 都不接受。被拒过就按学到的参数名发 */
      const tokenParam = caps.tokenParam === 'max_completion_tokens' ? 'max_completion_tokens' : 'max_tokens';
      body[tokenParam] = maxTokens || replyTokens();
      /* temperature 为 null = 这家把温度锁死了（推理模型），别硬塞：
         塞了也要吃一次 400 才学会，不如一开始就不发 */
      if (caps.noTemperature !== true && typeof settings.temperature === 'number') {
        body.temperature = settings.temperature;
      }
      /* 能力是「学到的否定」：只有明确被拒过才不发这个字段 */
      if (stream && caps.streamOptions !== false) body.stream_options = { include_usage: true };
      if (settings.jsonMode !== false && caps.jsonMode !== false) body.response_format = { type: 'json_object' };
      const extra = extraFields();
      if (extra) Object.assign(body, extra);
      return body;
    }

    /** 4xx 里能认出「这个字段我不认」就把该能力关掉并返回要重试；
     *  认不出但有 response_format 嫌疑时也先降级试一次。 */
    function downgrade(status, detail, streamed) {
      if ([400, 404, 415, 422].indexOf(status) < 0) return false;
      const t = String(detail || '');
      /* 参数名不同的模型（o1/o3/gpt-5 要 max_completion_tokens）：
         报错里点名了就换成它，没点名但提到 max_tokens 不认也换 */
      if (/max_completion_tokens/i.test(t) && caps.tokenParam !== 'max_completion_tokens') {
        remember({ tokenParam: 'max_completion_tokens' });
        return 'tokenParam';
      }
      if (/max_tokens/i.test(t) && !/max_completion_tokens/i.test(t) && caps.tokenParam !== 'max_completion_tokens') {
        remember({ tokenParam: 'max_completion_tokens' });
        return 'tokenParam';
      }
      if (/temperature/i.test(t) && caps.noTemperature !== true) {
        remember({ noTemperature: true });
        return 'temperature';
      }
      /* 强度原生字段被拒：逐类摘掉再试。顺序讲究——先摘最具体的
         （reasoning_effort / thinking），再摘概括的（reasoning），
         否则一次就把能用的字段全关了 */
      if (/reasoning_effort|reasoning\.effort/i.test(t) && caps.noReasoningEffort !== true) {
        remember({ noReasoningEffort: true });
        return 'reasoningEffort';
      }
      if (/thinking_budget|enable_thinking|budget_tokens|\bthinking\b/i.test(t) && caps.noThinking !== true) {
        remember({ noThinking: true });
        return 'thinking';
      }
      if (/\breasoning\b/i.test(t) && caps.noReasoning !== true) {
        remember({ noReasoning: true });
        return 'reasoning';
      }
      if (/response_format|json_object|json_schema/i.test(t)) {
        if (caps.jsonMode === false) return false;
        remember({ jsonMode: false });
        return 'jsonMode';
      }
      if (/stream_options|include_usage/i.test(t)) {
        if (caps.streamOptions === false) return false;
        remember({ streamOptions: false });
        return 'streamOptions';
      }
      if (streamed && /stream|sse|chunk|event-stream/i.test(t)) {
        if (caps.stream === false) return false;
        remember({ stream: false });
        return 'stream';
      }
      if (caps.jsonMode !== false && /(400|422)/.test(String(status))) {
        remember({ jsonMode: false });
        return 'jsonMode';
      }
      if (streamed && caps.stream !== false) {
        remember({ stream: false });
        return 'stream';
      }
      return false;
    }

    const DOWN_MSG = {
      tokenParam: '这个模型要 max_completion_tokens 而不是 max_tokens，已自动换参数重试',
      temperature: '这个模型不接受 temperature，已自动去掉重试',
      reasoningEffort: '这个接口不认 reasoning_effort，已改回用提示词控制强度',
      thinking: '这个接口不认 thinking 字段，已改回用提示词控制强度',
      reasoning: '这个接口不认 reasoning 字段，已改回用提示词控制强度',
      jsonMode: '这个接口不支持强制 JSON 模式，已自动关掉重试',
      streamOptions: '这个接口不认 stream_options，已自动去掉重试',
      stream: '这个接口不支持流式返回，已自动改成分段拿结果'
    };

    /** 一步模型调用：HTTP → 取 content → 解析 → 校验（失败修复一次）
     *  支持 SSE：transport 认 onDelta 时边读边把推理片段抛成 thought 事件，
     *  正文 Delta 先攒起来，等这一轮结束再当完整 JSON 解析。 */
    /* sink.thought 收这一轮模型的推理原文：界面把它挂成「思考」行，
       历史回放才看得到「当时为什么这么查」，而不是只剩工具名。 */
    async function callModel(messages, ctxTools, calledTools, onEvent, stop, sink) {
      let repairLeft = 1;
      let tokenCap = replyTokens();
      let downLeft = 4;       // 能力降级最多四次（参数名 / 温度 / json / 流式）
      let slowLeft = 2;       // 超时放宽最多两次
      let busyLeft = 2;       // 临时性 5xx/429 退避重试最多两次
      let grewTokens = 0;     // 空回复时加预算最多两次
      for (;;) {
        if (stop && stop.isStopped()) throw abortError();
        let sseBuf = '';
        let sseText = '';
        let sawSse = false;
        let sseFinish = '';
        let streamUsage = null;
        let reasoningSeen = false;
        let reasonAcc = '';
        if (sink) sink.thought = '';
        const pump = (piece) => {
          if (typeof piece !== 'string' || !piece) return;
          /* 点了停止就别再往界面推字：网络那头可能还在吐，界面已经收尾了 */
          if (stop && stop.isStopped()) return;
          sseBuf += piece;
          const lines = sseBuf.split('\n');
          sseBuf = lines.pop() || '';
          for (let i = 0; i < lines.length; i += 1) {
            const line = lines[i].replace(/\r$/, '');
            if (!line.startsWith('data:')) continue;
            sawSse = true;
            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            let obj = null;
            try { obj = JSON.parse(data); } catch (e) { continue; }
            if (obj.usage) streamUsage = obj.usage;
            if (obj.error) {
              throw Object.assign(new Error(String(obj.error.message || '接口返回错误')), { code: 'stream_error' });
            }
            const ch = obj.choices && obj.choices[0];
            const d = ch && ch.delta;
            if (ch && ch.finish_reason) sseFinish = ch.finish_reason;
            if (!d) continue;
            if (d.reasoning_content && onEvent) onEvent({ type: 'thought', text: d.reasoning_content });
            if (d.reasoning_content) {
              reasoningSeen = true;
              reasonAcc += d.reasoning_content;
              if (sink) sink.thought = reasonAcc;
            }
            if (d.content) sseText += d.content;
          }
        };
        const wantStream = !!deps.streaming && caps.stream !== false;
        const sentAt = Date.now();
        let res;
        try {
          const sent = transport({
            url: settings.endpoint || '',
            headers: settings.apiKey ? { Authorization: 'Bearer ' + settings.apiKey } : {},
            body: JSON.stringify(buildBody(messages, wantStream, tokenCap)),
            timeoutMs: waitMs(),
            onDelta: wantStream ? pump : null
          });
          /* 取消后后端仍会把这次请求跑完再报错，挂个空 catch 免得变成未处理拒绝 */
          if (sent && typeof sent.catch === 'function') sent.catch(() => {});
          /* 逻辑取消：不等网络，立即收手（Rust 侧另有旗标去断掉连接） */
          res = await (stop ? stop.race(sent) : sent);
        } catch (e) {
          /* 用户点了停止：不能当成接口超时去放宽重试 */
          if ((e && e.code === 'aborted') || (stop && stop.isStopped())) throw abortError();
          const msg = String((e && e.message) || e);
          /* 推理模型本来就慢，别让一次超时判死刑：记下实际耗时，放宽等一次 */
          if (slowLeft > 0 && /超时|timeout|timed out|ETIMEDOUT|abort/i.test(msg)) {
            slowLeft -= 1;
            const spent = Date.now() - sentAt;
            remember({
              latencyMs: Math.max(Number(caps.latencyMs) || 0, spent),
              timeoutMs: Math.min(300000, Math.max(waitMs(), Math.round(spent * 2.5)))
            });
            if (onEvent) {
              onEvent({
                type: 'notice',
                level: 'warn',
                message: '模型 ' + Math.round(spent / 1000) + ' 秒还没回完，已自动放宽等待时间重试'
              });
            }
            continue;
          }
          throw e;
        }
        const spentMs = Date.now() - sentAt;
        /* 记住这个模型的实际耗时：下次按它给等待上限，不用每次先撞墙 */
        if (spentMs > 2000) remember({ latencyMs: Math.max(Number(caps.latencyMs) || 0, spentMs) });
        if (res && res.status && res.status !== 200) {
          const detail = String(res.body || '').slice(0, 300);
          if (downLeft > 0) {
            const what = downgrade(res.status, detail, wantStream);
            if (what) {
              downLeft -= 1;
              if (onEvent) onEvent({ type: 'notice', level: 'warn', message: DOWN_MSG[what] || '接口不认这个参数，已自动换一种发法' });
              continue;
            }
          }
          /* 临时性故障（免费端点常见的 429/500/502/503/504）不该一次就放弃：
             真实日志里一整轮「还没开始查就失败」几乎都是这里被 503 直接怼死。
             退避重试两次，每次把等待时间往上抬——比让用户手动点「重试」强。 */
          const transient = [429, 500, 502, 503, 504].indexOf(res.status) >= 0;
          if (transient && busyLeft > 0) {
            busyLeft -= 1;
            const wait = Math.min(8000, 1200 * Math.pow(2, 2 - busyLeft));
            if (onEvent) {
              onEvent({
                type: 'notice',
                level: 'warn',
                message: '接口暂时不可用（HTTP ' + res.status + '），' + Math.round(wait / 1000) + ' 秒后自动重试'
              });
            }
            await new Promise((r) => setTimeout(r, wait));
            if (stop && stop.isStopped()) throw abortError();
            continue;
          }
          const err = new Error(`接口返回 HTTP ${res.status}${detail ? '：' + detail : ''}`);
          err.code = res.status === 401 || res.status === 403 ? 'auth'
            : (res.status === 429 ? 'rate' : 'http');
          throw err;
        }
        const streamed = wantStream && sawSse;
        let payload = null;
        let choice = null;
        let content = '';
        let usage = {};
        let finish = '';
        if (streamed) {
          content = sseText;
          usage = streamUsage || {};
          finish = sseFinish;
        } else {
          try {
            payload = JSON.parse(String((res && res.body) || ''));
          } catch (e) {
            throw Object.assign(new Error('接口返回的不是 JSON'), { code: 'bad_response' });
          }
          choice = payload && payload.choices && payload.choices[0];
          content = choice && choice.message ? choice.message.content : '';
          if (Array.isArray(content)) {
            content = content.map((c) => (typeof c === 'string' ? c : (c && c.text) || '')).join('');
          }
          finish = (choice && choice.finish_reason) || '';
          /* 不认流式时，推理模型会把思考放在 reasoning_content 里：
             直接抛给界面，别浪费掉 */
          const reasoning = choice && choice.message && choice.message.reasoning_content;
          if (reasoning) reasoningSeen = true;
          if (reasoning && onEvent) onEvent({ type: 'thought', text: reasoning });
          if (reasoning) {
            reasonAcc = String(reasoning);
            if (sink) sink.thought = reasonAcc;
          }
          /* 只有当 reasoning_content 本身就是合法 JSON 时才当正文用；
             原先是无条件顶替，结果把一段思考文字塞给解析器，必然格式错 */
          if (!content && reasoning && !extractJson(reasoning).error) content = reasoning;
          usage = (payload && payload.usage) || {};
        }
        /* 见了 reasoning_content 就说明是推理模型：思考也吃 token 预算，
           给宽一点，别让正文被挤成空串（学到后记下来，下次一开始就给够） */
        if (reasoningSeen) {
          if (caps.reasoning !== true) remember({ reasoning: true });
          const wide = Math.max(2400, Math.round(replyTokens() * 2.5));
          const room = Math.min(MAX_REPLY_TOKENS, wide);
          if (tokenCap < room) tokenCap = room;
        }
        const parsed = extractJson(content);
        if (parsed.error) {
          /* 只回了思考、正文被挤空：加预算重来，不消耗「格式修一次」的配额 */
          if (/空内容/.test(parsed.error) && grewTokens < 2 && tokenCap < MAX_REPLY_TOKENS) {
            grewTokens += 1;
            tokenCap = Math.min(MAX_REPLY_TOKENS, tokenCap * 2);
            remember({ maxTokens: tokenCap });
            if (onEvent) onEvent({ type: 'notice', level: 'warn', message: '模型这次没回正文（可能把预算全花在思考上），已加大长度重试' });
            continue;
          }
          /* 被 max_tokens 截断：放宽长度重来，别算进「格式修一次」的配额 */
          if (finish === 'length' && tokenCap < MAX_REPLY_TOKENS) {
            tokenCap = Math.min(MAX_REPLY_TOKENS, tokenCap * 2);
            remember({ maxTokens: tokenCap });
            messages.push({ role: 'assistant', content: String(content || '').slice(0, 200) });
            messages.push({
              role: 'user',
              content: '上次输出达到长度上限被截断了。请更简短：answer 不超过 150 字，suggest 最多 3 条，只输出一个完整的 JSON 对象。'
            });
            if (onEvent) onEvent({ type: 'notice', level: 'warn', message: '输出太长被截断，正在放宽长度重试' });
            continue;
          }
          /* 学到的「这个模型根本不吐 JSON」就直接兜底，不再白花一次修复调用 */
          if (repairLeft > 0 && caps.noJson !== true) {
            repairLeft -= 1;
            messages.push({ role: 'assistant', content: String(content || '').slice(0, 400) });
            messages.push({
              role: 'user',
              content: `你的输出不符合要求：${parsed.error}。只输出一个 JSON 对象，形如 {"tool":"...","args":{...}} 或 {"answer":"..."}。`
            });
            if (onEvent) onEvent({ type: 'notice', level: 'warn', message: '输出格式不对，正在让模型改一次' });
            continue;
          }
          /* 改了一次还是纯散文（glm-4-flash 这类弱模型根本不认 JSON 约定）：
             与其抛错让整轮作废，不如把这段文字当回答显示 —— 用户要的是答案 */
          const prose = salvageProse(content);
          if (prose) {
            const sv = validateStep(prose, ctxTools, calledTools);
            if (sv.ok) {
              /* 记下来：这个模型不认 JSON，下一轮直接按散文兜，省一次调用 */
              remember({ noJson: true });
              if (onEvent) onEvent({ type: 'notice', level: 'warn', message: '模型没按 JSON 输出，已按普通回答显示' });
              return Object.assign({ usage, raw: prose, salvaged: true }, sv);
            }
          }
          throw Object.assign(new Error('模型输出无法解析：' + parsed.error), { code: 'bad_output' });
        }
        const v = validateStep(parsed.obj, ctxTools, calledTools);
        if (!v.ok) {
          if (v.kind === 'forbidden') {
            // 越权不走修复重试：把「工具不存在」回给模型，让它自己换工具
            return { kind: 'forbidden', tool: String(parsed.obj.tool || ''), error: v.error, usage };
          }
          if (repairLeft > 0) {
            repairLeft -= 1;
            messages.push({ role: 'assistant', content: JSON.stringify(parsed.obj) });
            messages.push({ role: 'user', content: `你的输出不符合要求：${v.error}。请修正后重新输出一个 JSON 对象。` });
            if (onEvent) onEvent({ type: 'notice', level: 'warn', message: '输出不符合约定，正在让模型改一次' });
            continue;
          }
          /* 修了一次仍不合约定：能提取出回答就照常给，别让整轮作废 */
          if (typeof parsed.obj.answer === 'string' && parsed.obj.answer.trim()) {
            return {
              kind: 'answer',
              answer: parsed.obj.answer.trim().slice(0, 1200),
              evidence: [],
              suggest: [],
              usage,
              loose: true
            };
          }
          throw Object.assign(new Error('模型输出不符合约定：' + v.error), { code: 'bad_output' });
        }
        return Object.assign({ usage, raw: parsed.obj }, v);
      }
    }

    async function run(opts) {
      const started = Date.now();
      const onEvent = (opts && opts.onEvent) || function () {};
      const token = (opts && opts.token) || { stopped: false };
      const ctx = (opts && opts.ctx) || {};
      const ctxTools = (ctx.tools && ctx.tools.length ? ctx.tools : Object.keys(tools)).filter((n) => tools[n]);
      const system = prompt.systemPrompt(ctxTools);

      /* 停止：`token.stopped` 只是旗标，真正让在飞请求立刻结束的是这里的 race。
         Rust 侧还有 ai_cancel 去断掉连接，两边都不能省：
         旗标管界面，断连管不把 token 白花完。 */
      const waiters = [];
      const stop = {
        isStopped: () => !!token.stopped,
        race: (p) => new Promise((resolve, reject) => {
          waiters.push(reject);
          Promise.resolve(p).then(resolve, reject);
        })
      };
      token.onStop = () => {
        token.stopped = true;
        waiters.splice(0).forEach((fn) => fn(abortError()));
      };
      if (token.stopped) token.onStop();

      let messages;
      let trace = [];
      let calledTools = [];
      let steps = 0;
      let usageTotal = { prompt_tokens: 0, completion_tokens: 0, prompt_cache_hit_tokens: 0 };
      let compressed = 'none';
      const followUps = [];
      /* 数字对不上时给模型一次改正机会：一次就够，再多就是把钱花在辩解上 */
      let repairLeft = 1;

      /* 断点：把这一轮已经花掉的上下文原样留下。
         继续时从断点接着跑，已经查过的工具不必重查——重查一次就是重发一次整段 prompt。 */
      const checkpoint = () => ({
        v: 1,
        messages: (messages || []).map((m) => ({ role: m.role, content: m.content })),
        steps,
        trace: trace.map((t) => ({
          tool: t.tool, label: t.label, args: t.args, ok: t.ok, ms: t.ms, summary: t.summary,
          /* 断点里的思考只留开头一小段：继续时界面上的过程行还在，文件不至于胀 */
          thought: String(t.thought || '').slice(0, 400)
        })),
        calledTools: calledTools.slice(),
        compressed
      });
      const stoppedResult = () => ({
        ok: false,
        stopped: true,
        interrupted: true,
        answer: steps ? `已停止（查了 ${steps} 步）。点「继续」能从这儿接着查。` : '已停止。',
        evidence: trace.filter((t) => t.ok).map((t) => ({ tool: t.tool })),
        suggest: [],
        followUps,
        trace,
        compressed,
        checkpoint: checkpoint(),
        usage: { steps, elapsed_ms: Date.now() - started, ...usageTotal }
      });

      const resume = (opts && opts.resume) || null;
      if (resume && Array.isArray(resume.messages) && resume.messages.length) {
        messages = resume.messages.map((m) => ({ role: m.role, content: String(m.content) }));
        steps = Number(resume.steps) || 0;
        calledTools = Array.isArray(resume.calledTools) ? resume.calledTools.slice() : [];
        trace = Array.isArray(resume.trace) ? resume.trace.slice() : [];
        compressed = resume.compressed || 'none';
        if (onEvent) onEvent({ type: 'resume', steps });
      } else {
        messages = [{ role: 'system', content: system }];
        /* 历史：按「回合」注入，每轮带上它自己查过什么。
           以前只塞答案正文，模型看不到自己做过什么，用户一追问就得重新猜。
           轮数跟着窗口走：窗口越大会话越长，别拿固定 3 轮把大窗口浪费掉。 */
        const history = Array.isArray(opts && opts.history) ? opts.history : [];
        const maxTurns = Math.max(
          KEEP_TURNS,
          Math.min(12, Math.floor((budget > 0 ? budget : DEFAULT_WINDOW) / 6000))
        );
        buildHistory(history, maxTurns).forEach((t) => {
          if (!t.q && !t.a) return;
          const qText = t.q || '（上一轮没有提问）';
          messages.push({ role: 'user', content: qText });
          if (t.a) {
            /* 助手消息里带一行「上一轮记录」：模型据此知道自己查过什么、
               哪儿失败了，也才会在「继续」时接着往下查而不是从零重来。 */
            messages.push({
              role: 'assistant',
              content: t.d ? (t.a + '\n（上一轮记录：' + t.d + '）') : t.a
            });
          }
        });
        const ctxLine = prompt.contextLine(ctx);
        /* 末尾再提醒一次格式：弱模型对 system 里的长规则不敏感，
           贴在生成位置前的这句它才看得见 */
        const tail = prompt.OUTPUT_REMINDER || '';
        messages.push({ role: 'user', content: (ctxLine ? ctxLine + '\n' : '') + String((opts && opts.userText) || '') + tail });
      }

      let degraded = false;

      while (steps < maxSteps) {
        if (stop.isStopped()) return stoppedResult();
        const c = compressHistory(messages, budget);
        compressed = c.level;
        let step;
        const sink = { thought: '' };
        try {
          step = await callModel(messages, ctxTools, calledTools, onEvent, stop, sink);
        } catch (e) {
          /* 停止不是故障：不要走降级文案，直接把断点交给界面 */
          if ((e && e.code === 'aborted') || stop.isStopped()) return stoppedResult();
          const msg = (e && e.message) || '模型调用失败';
          const code = (e && e.code) || 'error';
          if (code === 'auth' || code === 'rate') throw Object.assign(new Error(msg), { code });
          degraded = true;
          return {
            ok: false,
            degraded: true,
            answer: fallbackAnswer(msg, trace),
            evidence: trace.filter((t) => t.ok).map((t) => ({ tool: t.tool })),
            suggest: [],
            followUps,
            trace,
            compressed,
            /* 调用失败也要留断点：503 / 网络抖动是最常见的失败，
               以前这里不给 checkpoint，「继续」按钮根本不出现，
               用户只能把问题重打一遍 —— 那就是他说的「没有上下文记忆」。 */
            checkpoint: checkpoint(),
            usage: { steps, elapsed_ms: Date.now() - started, ...usageTotal }
          };
        }
        if (step.usage) {
          usageTotal.prompt_tokens += Number(step.usage.prompt_tokens) || 0;
          usageTotal.completion_tokens += Number(step.usage.completion_tokens) || 0;
          /* 命中率：DeepSeek 用 prompt_cache_hit_tokens，OpenAI 兼容口放在 prompt_tokens_details.cached_tokens */
          usageTotal.prompt_cache_hit_tokens += Number(step.usage.prompt_cache_hit_tokens ||
            (step.usage.prompt_tokens_details && step.usage.prompt_tokens_details.cached_tokens) || 0) || 0;
          /* 思考 token：有的家给 reasoning_tokens，有的藏在 details 里，
             有的压根不给。累计「有就加、没有就记 0 并标未上报」，绝不假装 0 是真数 */
          const r = thinkTokensOf(step.usage);
          if (r !== null) {
            usageTotal.reasoning_tokens = (usageTotal.reasoning_tokens || 0) + r;
            usageTotal.reasoning_reported = true;
          }
        }
        if (stop.isStopped()) return stoppedResult();

        if (step.kind === 'answer') {
          /* 两件事，缺一不可：
             1) evidence 只认「真的成功查过」的工具 —— 以前失败也算调用过，
                于是「查崩了」也能当依据，答案凭空就有了出处。
             2) 体积数字必须能在成功结果里找到同源值，对不上就再给模型一次机会；
                两次都对不上，就如实说「没查全」，而不是让它把数字圆下去。 */
          const evidence = (step.evidence || []).filter((e) => calledTools.includes(e.tool));
          const okTools = trace.filter((t) => t.ok);
          const hay = okTools.map((t) => JSON.stringify(t.result || '')).join('\n');
          const bad = unsourcedSizes(step.answer, hay);
          if (bad.length && repairLeft > 0) {
            repairLeft -= 1;
            messages.push({ role: 'assistant', content: JSON.stringify({ answer: step.answer }) });
            messages.push({
              role: 'user',
              content: '这些数字在你的工具结果里找不到：' + bad.map(fmtSize).join('、') +
                '。只能用工具真实返回的数字，或者直接说「没查到」。请重新只输出一个 JSON 对象。' +
                (prompt.OUTPUT_REMINDER || '')
            });
            steps += 1;
            continue;
          }
          const answerText = bad.length
            ? step.answer + '\n\n· 注意：上面有体积数字没能在工具结果里核对上，可能不准。'
            : step.answer;
          const follow = suggestFollowUps(ctx, trace);
          const res = {
            ok: !bad.length,
            answer: answerText,
            evidence,
            suggest: step.suggest || [],
            followUps: follow,
            trace,
            compressed,
            interrupted: false,
            usage: { steps, elapsed_ms: Date.now() - started, ...usageTotal }
          };
          if (bad.length) {
            res.degraded = true;
            res.unsourced = bad.length;
            res.checkpoint = checkpoint();
          }
          if (onEvent) onEvent(Object.assign({ type: 'answer' }, res));
          return res;
        }

        if (step.kind === 'forbidden') {
          trace.push({ tool: step.tool, forbidden: true, error: step.error });
          if (onEvent) onEvent({ type: 'step', tool: step.tool, args: {}, ok: false, forbidden: true, error: step.error });
          messages.push({ role: 'assistant', content: JSON.stringify({ tool: step.tool }) });
          messages.push({ role: 'user', content: `工具结果：调用失败。${step.error}。你只能使用这些工具：${ctxTools.join('、')}。` });
          steps += 1;
          continue;
        }

        /* 工具步：一步最多 MAX_BATCH_TOOLS 个互不依赖的查询。
           执行仍是串行的（引擎调用本来就串行），省下的是模型往返与整段重发。 */
        const calls = step.kind === 'tools' ? step.tools : [{ tool: step.tool, args: step.args || {} }];
        /* 这一步之前的推理原文：挂到第一行工具上，回放时「思考 → 调用」的顺序才在。
           同一轮思考在多工具批里只记一次，不复制成 N 份。 */
        const stepThought = String(sink.thought || '').slice(0, 2000);
        const ran = [];
        for (const call of calls) {
          if (stop.isStopped()) return stoppedResult();
          const args = call.args || {};
          if (onEvent) onEvent({ type: 'step-start', tool: call.tool, args });
          const t0 = Date.now();
          let result;
          let ok = true;
          let errorText = '';
          try {
            const runner = tools[call.tool];
            if (!runner) throw new Error('工具不存在：' + call.tool);
            result = await stop.race(runner.run(args));
          } catch (e) {
            if ((e && e.code === 'aborted') || stop.isStopped()) return stoppedResult();
            ok = false;
            errorText = (e && e.message) || '工具执行失败';
            result = { error: errorText };
          }
          const ms = Date.now() - t0;
          const summary = ok && tools[call.tool].summary ? tools[call.tool].summary(args, result) : errorText;
          const label = (tools[call.tool] && tools[call.tool].label) || call.tool;
          const thought = ran.length ? '' : stepThought;
          trace.push({ tool: call.tool, label, args, ok, ms, summary, result, thought });
          calledTools.push(call.tool);
          if (onEvent) onEvent({ type: 'step', tool: call.tool, label, args, ok, ms, summary, result, thought, error: errorText });
          ran.push({ tool: call.tool, args, ok, result });
        }

        if (ran.length === 1) {
          messages.push({ role: 'assistant', content: JSON.stringify({ tool: ran[0].tool, args: ran[0].args }) });
          messages.push({ role: 'user', content: '工具结果：' + JSON.stringify(ran[0].result) });
        } else {
          messages.push({ role: 'assistant', content: JSON.stringify({ tools: ran.map((r) => ({ tool: r.tool, args: r.args })) }) });
          /* 多个结果按序号对齐，逐个标出 id：模型才分得清哪份属于哪个调用 */
          messages.push({
            role: 'user',
            content: '工具结果：\n' + ran.map((r, i) => `[${i + 1}] id=${r.tool}\n${JSON.stringify(r.result)}`).join('\n')
          });
        }
        steps += 1;
      }

      // 步数用尽：把已有信息交给模型做一次收尾？
      // 不额外花钱：直接给本地兜底，并明确标注信息可能不全。
      degraded = true;
      return {
        ok: false,
        degraded: true,
        exhausted: true,
        answer: fallbackAnswer('步数用尽', trace) + '\n· 信息可能不全，可以继续追问，我会接着查。',
        evidence: trace.map((t) => ({ tool: t.tool })),
        suggest: [],
        followUps,
        trace,
        compressed,
        checkpoint: checkpoint(),
        usage: { steps, elapsed_ms: Date.now() - started, ...usageTotal }
      };
    }

    return { run, validateStep, extractJson, compressHistory };
  }

  /** 工具全失败时的本地兜底：说清楚发生了什么，不编结论 */
  function fallbackAnswer(reason, trace) {
    const done = (trace || []).filter((t) => t.ok).map((t) => t.tool);
    const lines = ['AI 没能给出结论（' + reason + '）。'];
    if (done.length) lines.push('· 已经查过：' + done.join('、'));
    else lines.push('· 还没来得及查任何东西。');
    lines.push('· 可以重试，或先在设置里检查 AI 端点与密钥。');
    return lines.join('\n');
  }

  /** 建议追问：完全由本轮用过的工具推出，不额外花 token */
  function suggestFollowUps(ctx, trace) {
    const used = new Set((trace || []).map((t) => t.tool));
    const out = [];
    if (used.has('top_files')) out.push('这些文件里哪个最占地方？');
    if (used.has('empty_dirs')) out.push('这些空文件夹删了会影响什么？');
    if (used.has('file_signals')) out.push('有没有没签名的可疑文件？');
    if (used.has('installed_apps')) out.push('这些程序里哪个占用最大？');
    if (used.has('organize_preview')) out.push('为什么有些文件被跳过了？');
    if (used.has('last_organize')) out.push('上次整理能撤销吗？');
    if (!out.length) {
      out.push(ctx && ctx.dir ? '这个目录里最占地方的是什么？' : '最近什么最占空间？');
      out.push('有哪些空文件夹可以清掉？');
    }
    return out.slice(0, 2);
  }

  const API = {
    createAgent,
    validateStep,
    extractJson,
    compressHistory,
    fallbackAnswer,
    suggestFollowUps,
    capKeyOf,
    readCaps,
    salvageProse,
    estTokens,
    turnDigest,
    buildHistory,
    sizeTokens,
    unsourcedSizes,
    fmtSize,
    DEFAULT_MAX_STEPS,
    DEFAULT_TURN_BUDGET,
    DEFAULT_WINDOW,
    DEFAULT_CALL_TIMEOUT,
    DEFAULT_REPLY_TOKENS,
    MAX_REPLY_TOKENS
  };
  root.AIAgent = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
