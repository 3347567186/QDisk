/* AI 助手 · 对话界面（Linear 风格）
   ------------------------------------------------------------
   视觉口径沿用 styles.css 的既有 token（--surface / --line / --accent），
   不另造一套。布局是「一条竖列」：
     消息区（用户提问 → 查证过程 → 回答 → 依据 → 建议动作 → 追问 chip）
     + 固定底部输入框（AIComposer：模型菜单 + 推理强度滑块）
   查证过程默认折成一行（Linear 的密度感来自「细节默认收起」），
   点开才看到每个工具的参数、耗时、命中条数。

   写死的两条：
   1. 建议动作卡片上没有任何「删除」按钮。AI 只有只读工具，界面也就不该
      出现会写盘的按钮——按钮只负责「带你去那页」。
   2. 权限档位只放宽「可以查什么」，不放宽「可以改什么」。三档都不含写工具。 */
(function (root) {
  'use strict';

  const UIx = root.UI;
  const h = UIx.h;
  const T = UIx.T;

  const PAGE_LABEL = {
    tools: ['空间工具', 'Space tools'],
    organize: ['整理文件', 'Organize'],
    search: ['搜索文件', 'Search'],
    apps: ['卸载程序', 'Uninstall'],
    archive: ['压缩包', 'Archives'],
    ai: ['AI 助手', 'Assistant']
  };

  const ACTION_LABEL = {
    delete: ['去清理', 'Clean up'],
    archive: ['去压缩', 'Archive'],
    check: ['去看看', 'Inspect'],
    none: ['知道了', 'OK']
  };

  const ACTION_PAGE = {
    delete: 'tools',
    archive: 'archive',
    check: 'tools',
    none: 'tools'
  };

  /* 推理强度：不是「想得更久」的玄学，而是三个可量化的预算旋钮。
     simple 少查几步、答案更短；deep 多给两步、单次结果读得更全。
     budget 不再是写死的 token 数，而是「占上下文窗口的比例」——
     窗口本身来自模型能力（设置页从端点 /models 读回来，读不到才用保守默认值）。 */
  const THINKING = {
    simple: { steps: 3, share: 0.25, replyMax: 320 },
    medium: { steps: 6, share: 0.50, replyMax: 600 },
    deep: { steps: 9, share: 0.75, replyMax: 900 }
  };

  /* 权限档位决定「这一轮允许模型看见哪些工具」。写工具一个都没有。 */
  const PERM_TOOLS = {
    readonly: ['list_dir', 'last_organize'],
    standard: ['list_dir', 'top_files', 'empty_dirs', 'installed_apps', 'search_files', 'organize_preview', 'last_organize'],
    deep: ['list_dir', 'top_files', 'empty_dirs', 'file_signals', 'installed_apps', 'search_files', 'organize_preview', 'last_organize']
  };

  function permLabel(p) {
    const m = root.AIComposer.PERM_TEXT[p] || root.AIComposer.PERM_TEXT.standard;
    return T(m[0], m[1]);
  }

  /* 模型菜单只镜像「设置里真配过的那一个」，加上设置页从端点拉回来的真实清单
     （GET /models 的结果，存在 settings.models 里）。
     1.23.6 之前这里硬编码 deepseek-chat / deepseek-reasoner，再拼上 7 家厂商的
     默认型号，菜单里等于摆了一排点不动的假模型 —— 点哪个都还是打用户配的
     那个端点，失败时只会回「还没有配置模型端点」。现在配置里有什么就显示什么，
     没配就显示「未配置」并给一条去设置的入口。 */
  function realModels(settings) {
    const id = String((settings && settings.model) || '').trim();
    const fetched = Array.isArray(settings && settings.models) ? settings.models : [];
    const out = [];
    const seen = new Set();
    const push = (v) => {
      const s = String(v || '').trim();
      if (!s || seen.has(s)) return;
      seen.add(s);
      out.push({ id: s, label: s });
    };
    push(id);                       // 当前在用的排第一，菜单打开就能看到它
    fetched.forEach(push);          // 然后是端点报告可用的
    return out;
  }

  function evidenceRow(list, trace) {
    if (!list || !list.length) return null;
    const box = h('div', { class: 'ai-ev' });
    list.forEach((ev) => {
      const hit = (trace || []).find((t) => t.tool === ev.tool);
      const detail = h('div', { class: 'ai-ev-detail', hidden: true },
        hit ? h('pre', { class: 'ai-ev-pre' }, JSON.stringify(hit.result, null, 2)) : h('div', {}, T('没有保留原始结果', 'No raw result'))
      );
      const btn = h('button', {
        class: 'ai-ev-chip',
        onclick: () => { detail.hidden = !detail.hidden; }
      }, UIx.icon('file'), h('span', {}, ev.tool));
      box.appendChild(btn);
      box.appendChild(detail);
    });
    const wrap = h('div', { class: 'ai-ev-wrap' },
      h('span', { class: 'ai-ev-label' }, T('依据', 'Evidence')),
      box
    );
    return wrap;
  }

  function suggestCards(list) {
    if (!list || !list.length) return null;
    const wrap = h('div', { class: 'ai-suggest' });
    list.forEach((s) => {
      if (!s.paths || !s.paths.length) return;
      const page = ACTION_PAGE[s.action] || 'tools';
      const label = ACTION_LABEL[s.action] || ACTION_LABEL.check;
      const body = h('div', { class: 'ai-card-body' });
      s.paths.slice(0, 5).forEach((p) => {
        body.appendChild(h('div', { class: 'ai-card-path', title: p },
          UIx.icon('file'),
          h('span', { class: 'ai-card-path-t' }, p)
        ));
      });
      if (s.paths.length > 5) {
        body.appendChild(h('div', { class: 'ai-card-more' }, T('还有 ', 'and ') + (s.paths.length - 5) + T(' 项', ' more')));
      }
      const btns = h('div', { class: 'ai-card-bar' },
        h('button', {
          class: 'btn sm',
          onclick: () => { location.hash = '#' + page; }
        }, T(label[0], label[1])),
        h('button', {
          class: 'btn sm ghost',
          onclick: () => { UIx.copy(s.paths.join('\r\n')); }
        }, T('复制路径', 'Copy paths'))
      );
      wrap.appendChild(h('div', { class: 'ai-card' },
        h('div', { class: 'ai-card-head' },
          UIx.icon('shield'),
          h('span', {}, s.why || T('建议处理', 'Suggested')),
          h('span', { class: 'ai-card-badge' }, T('需你确认', 'Confirm'))
        ),
        body,
        btns
      ));
    });
    return wrap.children.length ? wrap : null;
  }

  function followChips(list, onPick) {
    if (!list || !list.length) return null;
    const wrap = h('div', { class: 'ai-follow' });
    list.forEach((q) => {
      wrap.appendChild(h('button', { class: 'ai-chip', onclick: () => onPick(q) }, q));
    });
    return wrap;
  }

  /* ---------------- 主体 ---------------- */

  function create(rootEl, opts) {
    const options = opts || {};
    const ctxProvider = options.ctx || (() => ({}));
    const compact = !!options.compact;

    const scroller = h('div', { class: 'ai-scroll' });
    const msgs = h('div', { class: 'ai-msgs' });
    const emptyBox = h('div', { class: 'ai-empty' });
    scroller.appendChild(emptyBox);
    scroller.appendChild(msgs);

    const shell = h('div', { class: 'ai-shell' + (compact ? ' compact' : '') }, scroller);
    rootEl.appendChild(shell);

    let state = {
      running: false,
      token: { stopped: false },
      session: null,
      history: [],
      lastResult: null,
      thinking: 'medium',
      permission: 'standard',
      model: ''
    };

    /* 输入框：模型菜单与推理强度都在它里面，这里只接回调 */
    const composer = root.AIComposer.create(shell, {
      compact: compact,
      models: options.models || [],
      model: options.model,
      thinking: 'medium',
      permission: 'standard',
      disabled: false,
      dir: () => {
        const c = ctxProvider() || {};
        return c.dir || c.path || '';
      },
      usage: { used: 0, budget: 8000 },
      onSubmit: (payload) => { ask(payload); },
      onStop: () => {
        state.token.stopped = true;
        composer.setBusy(true, true);
      },
      onThinkingChange: (v) => { state.thinking = v; },
      onModelChange: (id) => {
        /* 换模型就换窗口：每个模型的上下文长度是各自的能力，不共用上一个的 */
        state.model = id;
        const w = Number((state.settings && state.settings.modelCtx && state.settings.modelCtx[id]) || 0);
        if (w) {
          state.ctxWindow = w;
          composer.setUsage({ used: state.usedTokens || 0, budget: w });
          composer.setThinkBudgets(thinkBudgets({ ctxWindow: w }), w);
        }
      }
    });
    shell.appendChild(composer.el);

    const foot = h('div', { class: 'ai-foot' },
      UIx.icon('shield'),
      h('span', {}, T('只读助手：只查不改，不会删除或移动任何文件', 'Read-only: inspects only, never deletes or moves'))
    );
    shell.appendChild(foot);

    function scrollEnd(force) {
      /* 只有贴着底（80px 内）才跟着滚：用户往上翻历史时不该被新内容拽回去 */
      if (!force) {
        const gap = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
        if (gap > 80) return;
      }
      scroller.scrollTop = scroller.scrollHeight;
    }

    /* 配置变了就同步胶囊与菜单：模型是单一真值，不在菜单里编造 */
    function applyModels(settings) {
      const list = realModels(settings);
      composer.setModels(list);
      if (list.length) {
        state.model = list[0].id;
        composer.setModel(list[0].id);
      } else {
        state.model = '';
      }
      /* 上下文占用环的分母是模型真窗口，不是写死的 8000 */
      state.ctxWindow = ctxWindowOf(settings);
      composer.setUsage({ used: state.usedTokens || 0, budget: state.ctxWindow });
      /* 三档滑块上标出来的 token 数，同一套公式，跟着窗口走 */
      composer.setThinkBudgets(thinkBudgets(settings), state.ctxWindow);
      return list;
    }

    /* 每一档能塞多少 token：窗口 × 档位占比，夹在 [2000, 窗口-2000]
       —— 滑块上标的数字和真正发请求时用的是同一份，不各算各的 */
    function thinkBudgetOf(id, settings) {
      const t = THINKING[id] || THINKING.medium;
      const win = ctxWindowOf(settings);
      return Math.max(2000, Math.min(Math.round(win * t.share), win - 2000));
    }

    function thinkBudgets(settings) {
      return Object.keys(THINKING).map(function (id) {
        return { id: id, budget: thinkBudgetOf(id, settings) };
      });
    }

    /* 模型窗口：优先用设置里存的端点实测值，没有才退回保守默认 */
    function ctxWindowOf(settings) {
      const n = Number(settings && settings.ctxWindow);
      if (Number.isFinite(n) && n >= 2000 && n <= 2000000) return Math.round(n);
      return (AIStore && AIStore.FALLBACK_CTX) || 32768;
    }

    function setEmpty(show) {
      emptyBox.hidden = !show;
    }

    function renderEmpty() {
      emptyBox.innerHTML = '';
      const samples = compact
        ? ['这个目录里最占地方的是什么？', '这些空文件夹能删吗？']
        : ['最近什么最占空间？', 'D:\\Downloads 里有什么大文件？', '有哪些空文件夹可以清掉？', '上次整理动了哪些文件？'];
      const grid = h('div', { class: 'ai-empty-grid' });
      samples.forEach((q) => {
        grid.appendChild(h('button', { class: 'ai-empty-card', onclick: () => ask({ text: q }) },
          h('span', { class: 'ai-empty-q' }, q)
        ));
      });
      emptyBox.appendChild(h('div', { class: 'ai-empty-head' },
        h('div', { class: 'ai-empty-ic' },
          window.SteveAvatar ? window.SteveAvatar.el({ size: 38, variant: 'hero' }) : UIx.icon('spark')),
        h('div', {},
          h('div', { class: 'ai-empty-title' }, T('问我这台电脑上的文件', 'Ask about the files on this PC')),
          h('div', { class: 'ai-empty-sub' }, T('我会真的去查目录、签名、已安装程序，再给结论', 'I look at directories, signatures and installed apps, then answer'))
        )
      ));
      emptyBox.appendChild(grid);
    }

    function addUser(text) {
      setEmpty(false);
      msgs.appendChild(h('div', { class: 'ai-msg user' },
        h('div', { class: 'ai-msg-role' }, T('你', 'You')),
        h('div', { class: 'ai-msg-body' }, text)
      ));
      scrollEnd(true);
    }

    let current = null;

    /* 思路行：一行呼吸中的句子 + 可折起的过程（thoughtline.js）。
       label 是「正在做什么」，落定后换成「查了 N 项 · 用时」，计时器滑到句尾；
       过程在跑的时候是摊开的，落定即折成一行，点一下可再摊开。 */
    function startAnswer(opts) {
      const replay = !!(opts && opts.replay);
      const tl = replay ? null : root.AIThoughtLine.create({
        label: T('正在思考…', 'Thinking…'),
        collapsible: true,
        collapseOnSettle: true,
        showTimer: true,
        speak: (sec) => T(sec.toFixed(1) + ' 秒', sec.toFixed(1) + ' seconds')
      });
      const body = h('div', { class: 'ai-msg-body ai-answer' });
      const extra = h('div', { class: 'ai-extra' });
      const node = h('div', { class: 'ai-msg bot' },
        h('div', { class: 'ai-msg-role' }, T('助手', 'Assistant')),
        tl ? tl.el : null,
        body,
        extra
      );
      msgs.appendChild(node);
      scrollEnd(true);
      current = { node, tl, body, extra, steps: [], replay, stopped: false };
      return current;
    }

    function pushStep(step) {
      if (!current || !current.tl) return;
      current.steps.push(step);
      current.tl.addStep({
        text: step.label || step.tool,
        summary: step.summary,
        error: step.error,
        ms: step.ms,
        ok: step.ok
      });
      scrollEnd();
    }

    /* 落定后的那句话：把「查了什么、查了几项」压进一句，时间由计时器接在后面 */
    function doneLabelFor(steps, res) {
      const n = steps.length;
      if (res.stopped) return T('已停止', 'Stopped');
      if (!res.ok) return n ? T(`查了 ${n} 项 · 未完成`, `Checked ${n} · unfinished`) : T('查证失败', 'Failed');
      if (!n) return T('思考了', 'Thought for');
      return T(`查了 ${n} 项 · 用时`, `Checked ${n} · `);
    }

    function finishAnswer(res) {
      if (!current) startAnswer();
      const c = current;
      if (c.tl) c.tl.settle({ doneLabel: doneLabelFor(c.steps, res) });
      c.body.textContent = res.answer || '';
      if (res.degraded && !res.ok) c.body.classList.add('degraded');
      if (res.stopped) c.body.classList.add('degraded');

      const ev = evidenceRow(res.evidence, res.trace);
      if (ev) c.extra.appendChild(ev);
      const cards = suggestCards(res.suggest);
      if (cards) c.extra.appendChild(cards);

      const bar = h('div', { class: 'ai-msg-bar' });
      bar.appendChild(h('button', {
        class: 'btn sm ghost',
        onclick: () => { UIx.copy(res.answer || ''); }
      }, T('复制', 'Copy')));
      bar.appendChild(h('button', {
        class: 'btn sm ghost',
        onclick: () => { retryLast(); }
      }, T('重试', 'Retry')));
      if (res.usage) {
        const parts = [];
        if (res.usage.steps) parts.push(res.usage.steps + T(' 步', ' steps'));
        if (res.usage.elapsed_ms) parts.push((res.usage.elapsed_ms / 1000).toFixed(1) + 's');
        if (res.usage.prompt_tokens) parts.push(res.usage.prompt_tokens + ' in / ' + (res.usage.completion_tokens || 0) + ' out');
        if (parts.length) bar.appendChild(h('span', { class: 'ai-usage' }, parts.join(' · ')));
      }
      c.extra.appendChild(bar);

      const chips = followChips(res.followUps, (q) => ask({ text: q }));
      if (chips) c.extra.appendChild(chips);
      scrollEnd();
      current = null;
    }

    function addNotice(message, level) {
      if (!current) startAnswer();
      current.extra.appendChild(h('div', { class: 'ai-notice ' + (level || 'info') }, message));
      scrollEnd();
    }

    /* ---------------- 运行 ---------------- */

    let lastAsk = null;

    function budgetFor(thinking, settings) {
      const key = THINKING[thinking] ? thinking : 'medium';
      const t = THINKING[key];
      /* 单轮能塞进上下文的消息预算：直接取滑块上标出来的那个数，
         两边共用 thinkBudgetOf，不存在「显示的 32K、实际发 40K」 */
      return {
        steps: Math.min(t.steps, Number(settings.maxSteps) || t.steps),
        budget: thinkBudgetOf(key, settings),
        replyMax: t.replyMax
      };
    }

    async function ask(input) {
      const payload = (input && typeof input === 'object') ? input : { text: String(input || '') };
      const q = String(payload.text || '').trim();
      if ((!q && !(payload.attachments || []).length) || state.running) return;
      lastAsk = payload;

      state.thinking = payload.thinking || state.thinking;
      state.permission = payload.permission || state.permission;

      const shown = q || T('（已附加 ', '(attached ') + (payload.attachments || []).length + T(' 个路径）', ' paths)');
      addUser(q ? shown : shown);

      state.running = true;
      state.token = { stopped: false };
      composer.setBusy(true, false);

      const settings = await AIStore.load();
      applyModels(settings);
      if (!AIStore.isConfigured(settings)) {
        state.running = false;
        composer.setBusy(false, false);
        finishAnswer({
          ok: false,
          degraded: true,
          answer: T(
            '还没有配置模型端点。去「设置 → AI 助手」填接口地址、密钥和模型名，再回来问。',
            'No model endpoint configured yet. Fill in endpoint, key and model under Settings → AI Assistant.'
          ),
          evidence: [],
          suggest: [],
          followUps: [],
          trace: []
        });
        return;
      }

      if (payload.model) {
        state.model = payload.model;
      } else if (settings.model) {
        // 用户没在菜单里换模型时，胶囊跟着设置走
        state.model = settings.model;
        composer.setModel(settings.model);
      }

      const bud = budgetFor(state.thinking, settings);
      const allowed = PERM_TOOLS[state.permission] || PERM_TOOLS.standard;
      const allTools = AITools.makeTools({ API: window.API });
      const tools = {};
      allowed.forEach((n) => { if (allTools[n]) tools[n] = allTools[n]; });

      /* 注意：AIStore 存的字段叫 key，agent 读的是 apiKey —— 这里对上，
         否则真实接口会因为没有 Authorization 头直接 401。 */
      const agentSettings = Object.assign({}, settings, {
        model: payload.model || settings.model,
        apiKey: settings.key,
        maxSteps: bud.steps,
        turnBudget: bud.budget,
        /* 回复上限跟着思考强度走：agent 用它算 max_tokens，
           原来固定 700 会把长回答截成半截 JSON */
        replyMax: bud.replyMax
      });

      const agent = AIAgent.createAgent({
        /* 有流式通道就走流式：推理过程边生成边推到思路行；
           没有（浏览器预览、旧运行时）就退回一次性请求，界面照常工作。 */
        transport: (req) => {
          if (req && req.onDelta && window.API.aiHttpStream) {
            const p = window.API.aiHttpStream(req, req.onDelta);
            if (p) return p;
          }
          return window.API.aiHttp(req);
        },
        streaming: !!(window.API && window.API.aiHttpStream && window.__TAURI__),
        tools,
        prompt: AIPrompt,
        settings: agentSettings
      });

      const ctx = Object.assign({}, ctxProvider() || {});
      if (payload.attachments && payload.attachments.length) {
        ctx.files = payload.attachments.slice(0, 10);
        ctx.selected = payload.attachments.slice(0, 3);
      }
      ctx.tools = Object.keys(tools);
      ctx.permission = permLabel(state.permission);
      ctx.thinking = state.thinking;

      startAnswer();
      let res;
      try {
        res = await agent.run({
          userText: q || T('看看这些文件：', 'Look at these files: ') + (payload.attachments || []).join(', '),
          ctx: ctx,
          history: state.history,
          token: state.token,
          onEvent: (ev) => {
            if (ev.type === 'step') {
              pushStep({
                tool: ev.tool,
                label: (AIPrompt.TOOLS[ev.tool] || {}).desc || ev.tool,
                ok: ev.ok,
                summary: ev.summary,
                ms: ev.ms,
                error: ev.error
              });
            } else if (ev.type === 'thought') {
              if (current && current.tl) current.tl.addThought(ev.text);
            } else if (ev.type === 'notice') {
              addNotice(ev.message, ev.level);
            }
          }
        });
      } catch (e) {
        res = {
          ok: false,
          degraded: true,
          answer: (e && e.message) || T('AI 调用失败', 'AI call failed'),
          evidence: [],
          suggest: [],
          followUps: [],
          trace: []
        };
      }

      finishAnswer(res);
      state.running = false;
      composer.setBusy(false, false);
      state.lastResult = res;
      if (res.usage) {
        state.usedTokens = (res.usage.prompt_tokens || 0) + (res.usage.completion_tokens || 0);
        composer.setUsage({
          used: state.usedTokens,
          budget: state.ctxWindow || ctxWindowOf(settings)
        });
      }

      state.history.push({ role: 'user', content: q });
      state.history.push({ role: 'assistant', content: res.answer || '' });
      if (state.history.length > 40) state.history = state.history.slice(-40);
      if (state.session) {
        state.session.messages.push({ role: 'user', content: q, at: Date.now() });
        state.session.messages.push({ role: 'assistant', content: res.answer || '', at: Date.now(), ok: res.ok });
        if (!state.session.title || state.session.title === '新会话') state.session.title = q.slice(0, 30);
        try { await AIStore.saveSession(state.session); } catch (e) { /* 落盘失败不打断对话 */ }
        notifySessions();
      }
      AIStore.logUsage({
        steps: res.usage ? res.usage.steps : 0,
        ms: res.usage ? res.usage.elapsed_ms : 0,
        prompt_tokens: res.usage ? res.usage.prompt_tokens : 0,
        completion_tokens: res.usage ? res.usage.completion_tokens : 0,
        ok: !!res.ok,
        degraded: !!res.degraded
      });
    }

    function retryLast() {
      if (!lastAsk || state.running) return;
      ask(lastAsk);
    }

    /* 会话列表变了（新建 / 落盘 / 载入）就让外面重画右侧的归档列表 */
    function notifySessions() {
      if (typeof options.onSessions === 'function') {
        try { options.onSessions(); } catch (e) { /* 外面的重画失败不该影响对话 */ }
      }
    }

    renderEmpty();
    composer.focus();
    AIStore.load().then((s) => {
      applyModels(s);
    }).catch(() => {});

    return {
      ask,
      retry: retryLast,
      composer,
      clear() {
        msgs.innerHTML = '';
        state.history = [];
        state.session = null;
        state.lastResult = null;
        renderEmpty();
        setEmpty(true);
      },
      loadSession(session) {
        msgs.innerHTML = '';
        state.session = session;
        state.history = [];
        (session.messages || []).forEach((m) => {
          if (m.role === 'user') addUser(m.content);
          else {
            /* 历史消息没有保留查证过程，所以不挂思路行（否则会出现「思考了 0.0s」） */
            startAnswer({ replay: true });
            finishAnswer({ ok: true, answer: m.content, evidence: [], suggest: [], followUps: [], trace: [] });
          }
          state.history.push({ role: m.role, content: m.content });
        });
        setEmpty(false);
        scrollEnd(true);
        notifySessions();
      },
      newSession() {
        msgs.innerHTML = '';
        state.session = {
          id: Date.now().toString(36),
          title: '新会话',
          created: Date.now(),
          messages: []
        };
        state.history = [];
        state.lastResult = null;
        state.token = { stopped: false };
        renderEmpty();
        setEmpty(true);
        notifySessions();
      },
      /* 删除后如果是当前会话，回到一个干净的新会话 */
      deleteSession(id) {
        if (state.session && state.session.id === id) {
          this.newSession();
        }
      },
      sessions() {
        return AIStore.listSessions();
      },
      get session() { return state.session; },
      focus() { composer.focus(); },
      setBusy(b) { state.running = b; composer.setBusy(b, false); },
      setModel(id) { state.model = id; composer.setModel(id); },
      setThinking(v) { state.thinking = v; composer.setThinking(v); },
      setPermission(p) { state.permission = p; composer.setPermission(p); },
      /* 页面/抽屉收起时必须调它：composer 里挂着推理强度画布的 ticker、
         菜单的 resize 监听和 motion 订阅，只清 DOM 会把它们留成常驻空转。 */
      destroy() { try { composer.destroy(); } catch (e) { /* 忽略 */ } }
    };
  }

  root.AIChat = { create };
})(typeof window !== 'undefined' ? window : globalThis);
