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
  const DEFAULT_TURN_BUDGET = 8000;      // token（按字符数/2 估算）
  /* 20s 只够 chat 小模型；实测 glm-4.7-flash 单轮 118s、中转站推理模型 71s，
     超时会被当成失败，用户看到的是「AI 没能给出结论」。
     流式下这个值是「多久没收到新数据算断」，不是总时长。 */
  const DEFAULT_CALL_TIMEOUT = 180000;
  /* 原来硬编码 700：300 字中文 + evidence/suggest 会被截断成「JSON 没有闭合」 */
  const DEFAULT_REPLY_TOKENS = 1400;
  const MAX_REPLY_TOKENS = 8192;
  const REPLY_MAX_CHARS = 600;
  const KEEP_TURNS = 3;                  // 原文保护的最近轮数

  const estTokens = (text) => Math.ceil(String(text || '').length / 2);

  const SUGGEST_ACTIONS = ['delete', 'archive', 'check', 'none'];

  /* ---------------- 输出解析 ---------------- */

  /** 从模型返回的 content 里取出 JSON 对象：容忍 ```json 围栏与前后废话 */
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
          const raw = s.slice(start, i + 1);
          try {
            const obj = JSON.parse(raw);
            if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
              return { error: '输出的不是 JSON 对象' };
            }
            return { obj };
          } catch (e) {
            return { error: 'JSON 解析失败：' + (e && e.message ? e.message : e) };
          }
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
    if (hasTool && hasAnswer) return { ok: false, error: 'tool 与 answer 只能出现一个' };
    if (!hasTool && !hasAnswer) return { ok: false, error: '必须包含 tool 或 answer' };

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

  function compressHistory(msgs, budget) {
    let total = msgs.reduce((n, m) => n + estTokens(m.content), 0);
    if (total <= budget) return { msgs, level: 'none' };
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
    total = msgs.reduce((n, m) => n + estTokens(m.content), 0);
    if (total <= budget) return { msgs, level };
    // 70–85%：硬裁剪，更早的工具结果压成一行
    level = 'hard';
    for (let i = 1; i < keepIdx; i += 1) {
      const m = msgs[i];
      if (m.role !== 'user' || !/^工具结果/.test(m.content)) continue;
      const head = m.content.split('\n')[0].slice(0, 60);
      msgs[i] = { role: 'user', content: head + ' …（早期结果已省略）' };
    }
    total = msgs.reduce((n, m) => n + estTokens(m.content), 0);
    if (total <= budget) return { msgs, level };
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

  /* ---------------- 环路 ---------------- */

  function createAgent(deps) {
    const transport = deps.transport;
    const tools = deps.tools;
    const prompt = deps.prompt;
    const settings = deps.settings || {};

    const maxSteps = Number(settings.maxSteps) || DEFAULT_MAX_STEPS;
    const budget = Number(settings.turnBudget) || DEFAULT_TURN_BUDGET;
    const callTimeout = Number(settings.callTimeout) || DEFAULT_CALL_TIMEOUT;

    /** 单次回复的 token 上限：按「回复字数 × 1.6 + 结构余量」估，
     *  思考模式下回复更长（replyMax 由调用方按强度传入）。 */
    function replyTokens() {
      const explicit = Number(settings.maxTokens);
      if (explicit > 0) return Math.max(512, Math.min(MAX_REPLY_TOKENS, Math.round(explicit)));
      const chars = Number(settings.replyMax) || REPLY_MAX_CHARS;
      return Math.max(DEFAULT_REPLY_TOKENS, Math.min(MAX_REPLY_TOKENS, Math.round(chars * 1.6) + 320));
    }

    function buildBody(messages, stream, maxTokens) {
      const body = {
        model: settings.model || '',
        messages,
        temperature: typeof settings.temperature === 'number' ? settings.temperature : 0.2,
        max_tokens: maxTokens || replyTokens(),
        stream: !!stream
      };
      if (stream) body.stream_options = { include_usage: true };
      if (settings.jsonMode !== false) body.response_format = { type: 'json_object' };
      return body;
    }

    /** 一步模型调用：HTTP → 取 content → 解析 → 校验（失败修复一次）
     *  支持 SSE：transport 认 onDelta 时边读边把推理片段抛成 thought 事件，
     *  正文 Delta 先攒起来，等这一轮结束再当完整 JSON 解析。 */
    async function callModel(messages, ctxTools, calledTools, onEvent) {
      let repairLeft = 1;
      let tokenCap = replyTokens();
      for (;;) {
        let sseBuf = '';
        let sseText = '';
        let sawSse = false;
        let sseFinish = '';
        let streamUsage = null;
        let reasoningSeen = false;
        const pump = (piece) => {
          if (typeof piece !== 'string' || !piece) return;
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
            if (d.reasoning_content) reasoningSeen = true;
            if (d.content) sseText += d.content;
          }
        };
        const wantStream = !!deps.streaming;
        const res = await transport({
          url: settings.endpoint || '',
          headers: settings.apiKey ? { Authorization: 'Bearer ' + settings.apiKey } : {},
          body: JSON.stringify(buildBody(messages, wantStream, tokenCap)),
          timeoutMs: callTimeout,
          onDelta: wantStream ? pump : null
        });
        if (res && res.status && res.status !== 200) {
          const detail = String(res.body || '').slice(0, 300);
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
          /* 只有当 reasoning_content 本身就是合法 JSON 时才当正文用；
             原先是无条件顶替，结果把一段思考文字塞给解析器，必然格式错 */
          if (!content && reasoning && !extractJson(reasoning).error) content = reasoning;
          usage = (payload && payload.usage) || {};
        }
        /* 见了 reasoning_content 就说明是推理模型：思考也吃 token 预算，
           给宽一点，别让正文被挤成空串 */
        if (reasoningSeen && tokenCap < 2400) tokenCap = 2400;
        const parsed = extractJson(content);
        if (parsed.error) {
          /* 被 max_tokens 截断：放宽长度重来，别算进「格式修一次」的配额 */
          if (finish === 'length' && tokenCap < MAX_REPLY_TOKENS) {
            tokenCap = Math.min(MAX_REPLY_TOKENS, tokenCap * 2);
            messages.push({ role: 'assistant', content: String(content || '').slice(0, 200) });
            messages.push({
              role: 'user',
              content: '上次输出达到长度上限被截断了。请更简短：answer 不超过 150 字，suggest 最多 3 条，只输出一个完整的 JSON 对象。'
            });
            if (onEvent) onEvent({ type: 'notice', level: 'warn', message: '输出太长被截断，正在放宽长度重试' });
            continue;
          }
          if (repairLeft > 0) {
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
      const messages = [{ role: 'system', content: system }];

      // 历史：只带最近的对话原文，更早的靠压缩兜底
      const history = Array.isArray(opts && opts.history) ? opts.history : [];
      history.slice(-KEEP_TURNS * 2).forEach((m) => {
        if (m && m.role && m.content) messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content) });
      });
      const ctxLine = prompt.contextLine(ctx);
      /* 末尾再提醒一次格式：弱模型对 system 里的长规则不敏感，
         贴在生成位置前的这句它才看得见 */
      const tail = prompt.OUTPUT_REMINDER || '';
      messages.push({ role: 'user', content: (ctxLine ? ctxLine + '\n' : '') + String((opts && opts.userText) || '') + tail });

      const trace = [];
      const calledTools = [];
      const followUps = [];
      let steps = 0;
      let usageTotal = { prompt_tokens: 0, completion_tokens: 0 };
      let compressed = 'none';
      let degraded = false;

      while (steps < maxSteps) {
        if (token.stopped) {
          return { ok: false, stopped: true, answer: '已停止。', evidence: [], suggest: [], trace, followUps, usage: { steps, elapsed_ms: Date.now() - started, ...usageTotal }, compressed };
        }
        const c = compressHistory(messages, budget);
        compressed = c.level;
        let step;
        try {
          step = await callModel(messages, ctxTools, calledTools, onEvent);
        } catch (e) {
          const msg = (e && e.message) || '模型调用失败';
          const code = (e && e.code) || 'error';
          if (code === 'auth' || code === 'rate') throw Object.assign(new Error(msg), { code });
          degraded = true;
          return {
            ok: false,
            degraded: true,
            answer: fallbackAnswer(msg, trace),
            evidence: trace.map((t) => ({ tool: t.tool })),
            suggest: [],
            followUps,
            trace,
            compressed,
            usage: { steps, elapsed_ms: Date.now() - started, ...usageTotal }
          };
        }
        if (step.usage) {
          usageTotal.prompt_tokens += Number(step.usage.prompt_tokens) || 0;
          usageTotal.completion_tokens += Number(step.usage.completion_tokens) || 0;
        }

        if (step.kind === 'answer') {
          // evidence 只保留真正调用过的（校验已保证，这里再兜一层）
          const evidence = (step.evidence || []).filter((e) => calledTools.includes(e.tool));
          const follow = suggestFollowUps(ctx, trace);
          const res = {
            ok: true,
            answer: step.answer,
            evidence,
            suggest: step.suggest || [],
            followUps: follow,
            trace,
            compressed,
            interrupted: false,
            usage: { steps, elapsed_ms: Date.now() - started, ...usageTotal }
          };
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

        // tool 步：执行
        const args = step.args || {};
        if (onEvent) onEvent({ type: 'step-start', tool: step.tool, args });
        const t0 = Date.now();
        let result;
        let ok = true;
        let errorText = '';
        try {
          const runner = tools[step.tool];
          if (!runner) throw new Error('工具不存在：' + step.tool);
          result = await runner.run(args);
        } catch (e) {
          ok = false;
          errorText = (e && e.message) || '工具执行失败';
          result = { error: errorText };
        }
        const ms = Date.now() - t0;
        const summary = ok && tools[step.tool].summary ? tools[step.tool].summary(args, result) : errorText;
        trace.push({ tool: step.tool, args, ok, ms, summary, result });
        calledTools.push(step.tool);
        if (onEvent) onEvent({ type: 'step', tool: step.tool, args, ok, ms, summary, result, error: errorText });

        messages.push({ role: 'assistant', content: JSON.stringify({ tool: step.tool, args }) });
        messages.push({
          role: 'user',
          content: '工具结果：' + JSON.stringify(result)
        });
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
    estTokens,
    DEFAULT_MAX_STEPS,
    DEFAULT_TURN_BUDGET
  };
  root.AIAgent = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
