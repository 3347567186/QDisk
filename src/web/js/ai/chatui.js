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
  /* 结果位置入口：打开/定位/复制路径的唯一实现。index.html 里必须排在
     本文件之前，否则下面所有 AIEntries.* 都会在运行期才炸。 */
  const AIEntries = root.AIEntries;

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

  /* 推理强度管「愿意花多少努力」：思考预算、查证轮数、回复长度。
     它不切分上下文——以前写成 deep 就吃掉窗口 75%，等于「想得深就必须记得少」，
     而窗口是模型能力，不是思考旋钮。现在历史预算统一按窗口的 70%（见 agent.js），
     档位只差思考预算、MAX_STEPS 与回复长度，定义在 strength.js。 */
  const Strength = root.AIStrength;

  /** 用量那一行的悬停说明：把每个数字是什么讲清，
   *  并明确「思考 token 是真值还是估算」——估算不许冒充精确。 */
  function usageTitle(st) {
    const bits = [
      T('缓存命中率 = 命中缓存的提示 token / 提示 token', 'Cache hit = cached prompt tokens / prompt tokens'),
      T('思考预算 = 这一档最多允许模型思考多少 token', 'Thinking budget = tokens allowed for this level')
    ];
    if (st && st.estimated) bits.push(T('这次的思考量是估算：模型没有上报', 'Estimated: the model did not report reasoning tokens'));
    return bits.join('\n');
  }


  /** 这一轮的策略：档位来自滑块（努力），温度来自设置（空 = 按任务自动），
   *  步数硬上限来自设置里的防跑飞闸。 */
  function policyFor(text, settings) {
    const s = settings || {};
    return Strength.resolve({
      level: state.thinking,
      text: text,
      temperature: s.temperature === null || s.temperature === undefined ? null : s.temperature,
      endpoint: s.endpoint,
      model: s.model,
      jsonMode: s.jsonMode,
      stepCap: s.stepCap
    });
  }

  /* 权限档位决定「这一轮允许模型看见哪些工具」。
     1.28 起多了一组提案工具（propose_action / list_proposals / cancel_proposal / navigate）：
     它们只生成待确认的卡片，不执行任何动作。真正的执行是 proposals.commit，
     只有用户点按钮才会被调用，模型手里没有这个函数，也没有工具能间接调到它。
     只读档仍然一个提案工具都不给——那是用户明确选的「只看不动」。 */
  const PROPOSE_TOOLS = ['propose_action', 'list_proposals', 'cancel_proposal', 'navigate'];

  const PERM_TOOLS = {
    readonly: ['list_dir', 'read_file', 'disk_roots', 'last_organize'],
    standard: PROPOSE_TOOLS.concat(['list_dir', 'read_file', 'open_path', 'disk_roots', 'top_files', 'empty_dirs', 'installed_apps', 'search_files', 'organize_preview', 'last_organize', 'clean_candidates', 'settings_read', 'search_roots']),
    deep: PROPOSE_TOOLS.concat(['list_dir', 'read_file', 'open_path', 'disk_roots', 'top_files', 'empty_dirs', 'file_signals', 'installed_apps', 'search_files', 'organize_preview', 'last_organize', 'archive_entries', 'clean_candidates', 'settings_read', 'search_roots'])
  };

  /* 动手档位：off 完全不提，confirm 每次点，auto 可撤销的小动作倒计时自动执行，
     full 连删到回收站这类也自动（不可撤销的仍然要输确认词）。
     默认 off —— 装完不认识你，就不该替你动手。 */
  const MODE_LABEL = {
    off: ['只读', '只查不改：没有任何能改文件的工具'],
    confirm: ['确认', '每个动作都变成卡片，你点了才执行'],
    auto: ['自动', '整理/解压这类可撤销的自动执行，3 秒内可停'],
    full: ['放手', '删到回收站这类也自动；撤不回来的仍要点一下']
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

  /* 依据行：点开看原始结果；顺手给一个「去这个地方」的入口。
     以前这里只能看 JSON，看完还得自己照着路径去资源管理器里找。 */
  function evPath(hit) {
    if (!hit) return '';
    const a = hit.args || {};
    const r = hit.result || {};
    const cand = [a.dir, a.path, (a.paths || [])[0], r.dir, r.path, r.home, (r.paths || [])[0]];
    for (const c of cand) if (c && typeof c === 'string') return c;
    return '';
  }

  function evidenceRow(list, trace) {
    if (!list || !list.length) return null;
    const box = h('div', { class: 'ai-ev' });
    list.forEach((ev) => {
      const hit = (trace || []).find((t) => t.tool === ev.tool);
      const detail = h('div', { class: 'ai-ev-detail', hidden: true },
        hit ? h('pre', { class: 'ai-ev-pre' }, JSON.stringify(hit.result, null, 2)) : h('div', {}, T('没有保留原始结果', 'No raw result'))
      );
      const chipRow = h('div', { class: 'ai-ev-row' });
      const btn = h('button', {
        class: 'ai-ev-chip',
        onclick: () => { detail.hidden = !detail.hidden; }
      }, UIx.icon('file'), h('span', {}, ev.tool));
      chipRow.appendChild(btn);
      const p = evPath(hit);
      if (p) {
        chipRow.appendChild(h('button', {
          class: 'ai-ev-open',
          title: p,
          onclick: (e) => { e.stopPropagation(); AIEntries.open(p); }
        }, UIx.icon('folder')));
      }
      box.appendChild(chipRow);
      box.appendChild(detail);
    });
    const wrap = h('div', { class: 'ai-ev-wrap' },
      h('span', { class: 'ai-ev-label' }, T('依据', 'Evidence')),
      box
    );
    return wrap;
  }

  /* 「去工具页」必须带上这一条的路径：只切页等于让用户看一张空表。
     载荷交给 App.jump，目标页在挂载时取走（见 app.js 的 App.takeJump）。 */
  function jumpToPage(page, s) {
    const paths = ((s && s.paths) || []).filter(Boolean).map(String);
    const payload = { paths: paths, action: (s && s.action) || 'check', why: (s && s.why) || '' };
    if (root.App && typeof root.App.jump === 'function') { root.App.jump(page, payload); return; }
    location.hash = '#' + page;
  }

  /* 建议卡片：路径不再是死文字，主按钮直接打开第一个位置。
     「跳页面」降级成次级按钮——它以前是主按钮，用户点完发现还在原地。 */
  function suggestCards(list) {
    if (!list || !list.length) return null;
    const wrap = h('div', { class: 'ai-suggest' });
    list.forEach((s) => {
      if (!s.paths || !s.paths.length) return;
      const page = ACTION_PAGE[s.action] || 'tools';
      const label = ACTION_LABEL[s.action] || ACTION_LABEL.check;
      const body = h('div', { class: 'ai-card-body' });
      s.paths.slice(0, 5).forEach((p) => {
        body.appendChild(AIEntries.chip(p, { compact: true, src: 'suggest' }));
      });
      if (s.paths.length > 5) {
        body.appendChild(h('div', { class: 'ai-card-more' }, T('还有 ', 'and ') + (s.paths.length - 5) + T(' 项', ' more')));
      }
      const first = s.paths[0];
      const btns = h('div', { class: 'ai-card-bar' },
        h('button', {
          class: 'btn sm',
          onclick: () => { AIEntries.open(first); }
        }, UIx.icon('folder', 14), T(label[0], label[1])),
        h('button', {
          class: 'btn sm ghost',
          onclick: () => { jumpToPage(page, s); }
        }, T('在' + (PAGE_LABEL[page] || PAGE_LABEL.tools)[0] + '里查看',
             'Open in ' + (PAGE_LABEL[page] || PAGE_LABEL.tools)[1])),
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

    /* 右下角的「回到底部」：只因读者自己往上翻而出现，贴底后消失 */
    const toBottom = h('button', {
      class: 'ai-tobottom',
      type: 'button',
      'aria-label': T('回到底部', 'Back to bottom'),
      title: T('回到底部', 'Back to bottom')
    }, UIx.icon('chevron'));
    toBottom.addEventListener('click', function () {
      if (follow) follow.resume();
    });

    const shell = h('div', { class: 'ai-shell' + (compact ? ' compact' : '') }, scroller, toBottom);
    rootEl.appendChild(shell);

    /* 回合导航：一条刻度 = 一轮（用户一句话 + 它的回答）。窄窗或只有一轮时自己隐藏。 */
    const turns = [];
    const rail = root.AITurnRail ? root.AITurnRail.create({
      host: shell,
      onNavigate: function (i) { jumpToTurn(i); }
    }) : null;

    /* 视角跟随：贴底就跟，读者一往上翻就撒手，出现「回到底部」 */
    const follow = root.AIFollow ? root.AIFollow.create({
      scroller: scroller,
      content: msgs,
      onChange: function (s) { toBottom.classList.toggle('on', !s.following); }
    }) : null;

    function jumpToTurn(i) {
      const t = turns[i];
      if (!t || !t.userNode) return;
      if (follow) follow.reveal(t.userNode, 24);
      rail && rail.setActive(i);
      /* 跳转后按新位置重算「当前轮」，别停在旧的高亮上 */
      requestAnimationFrame(function () { paintActiveTurn(); });
    }

    /* 当前读到第几轮：判读线在视口顶往下 96px（最多 20% 视口高） */
    function currentTurnIndex() {
      if (!turns.length) return -1;
      if (follow && follow.isFollowing()) return turns.length - 1;
      const line = scroller.scrollTop + Math.min(96, scroller.clientHeight * 0.2);
      let idx = 0;
      for (let i = 0; i < turns.length; i++) {
        const n = turns[i].userNode;
        if (n && n.offsetTop <= line) idx = i;
      }
      return idx;
    }

    let activeTurn = -1;
    function paintActiveTurn() {
      const i = currentTurnIndex();
      if (i === activeTurn) return;
      activeTurn = i;
      rail && rail.setActive(i);
    }

    scroller.addEventListener('scroll', function () {
      if (rail) requestAnimationFrame(paintActiveTurn);
    }, { passive: true });

    /* 界面偏好（推理强度 / 权限 / 选中的模型 / 上次的会话）跟接口配置分两处存：
       这里先按上次记下的值起来，读到磁盘之前不改用户已经做过的选择。
       合并写盘：拖强度滑块、点权限不会每动一下就落一次文件。 */
    const ui = Object.assign({}, (AIStore.UI_DEFAULTS || {}), options.ui || {});
    let uiTimer = 0;
    /* 只把「这次真的改过」的字段写回去。整份 ui 写回会把别处（设置页、
       另一个会话）刚存的 agent 档位盖成默认值——1.30.0 的档位一重启就丢，
       就是因为这里每次都把整个快照落盘。 */
    const uiPending = {};

    function rememberUi(patch) {
      Object.assign(ui, patch || {});
      Object.assign(uiPending, patch || {});
      if (uiTimer) clearTimeout(uiTimer);
      uiTimer = setTimeout(function () {
        uiTimer = 0;
        const out = Object.assign({}, uiPending);
        Object.keys(uiPending).forEach(function (k) { delete uiPending[k]; });
        try {
          Promise.resolve(AIStore.saveUi(out)).catch(function () { /* 记不住不该挡住对话 */ });
        } catch (e) { /* 同上 */ }
      }, 400);
    }

    /* 动作层：registry 是 19 个动作的定义（每个都带自己的预演与执行体），
       proposals 是待确认队列 + 预算 + 审计日志。两者都不交给模型——
       模型只能通过 tools.js 的 propose_action 提一张卡片出来，
       真正执行是 proposals.commit，只由卡片上的按钮调用。 */
    const actions = (root.AIRegistry && window.API) ? root.AIRegistry.create({ API: window.API }) : null;
    /* 全应用共用一份提案队列：整页和抽屉是两个 chat 实例，
       各建各的会出现「这边执行完了，那边还挂着执行按钮」。 */
    const proposals = (root.AIProposals && actions)
      ? (root.AIProposals.shared
        ? root.AIProposals.shared({ API: window.API, store: AIStore, actions: actions, policy: ui.agent })
        : root.AIProposals.create({ API: window.API, store: AIStore, actions: actions, policy: ui.agent }))
      : null;
    if (actions && AIPrompt.setCatalog) {
      /* 动作目录是稳定前缀的一部分：同一版本内一个字节都不变，缓存照样命中 */
      try { AIPrompt.setCatalog(actions.catalog()); } catch (e) { /* 目录拼不出来就少一段说明 */ }
    }

    let guardReady = null;
    /* 路径闸门要知道三件事才能判：用户主目录、程序自己的目录、数据目录。
       三个都由 Rust 报真值，不在前端猜；拿到之后配置一次就够。 */
    function ensureGuard() {
      if (!root.AIGuard) return Promise.resolve(null);
      if (guardReady) return guardReady;
      guardReady = (async () => {
        let info = {};
        let roots = {};
        try { info = await window.API.appInfo(); } catch (e) { info = {}; }
        try { roots = await window.API.agentRoots(); } catch (e) { roots = {}; }
        root.AIGuard.configure({
          home: roots.home || '',
          appDir: info.exe_dir || '',
          dataDir: info.data_dir || '',
          roots: roots.roots || []
        });
        return root.AIGuard;
      })();
      return guardReady;
    }

    let state = {
      running: false,
      token: { stopped: false },
      session: null,
      history: [],
      lastResult: null,
      thinking: ui.thinking || 'medium',
      permission: ui.permission || 'standard',
      model: ui.model || ''
    };

    /* 输入框：模型菜单与推理强度都在它里面，这里只接回调 */
    const composer = root.AIComposer.create(shell, {
      compact: compact,
      models: options.models || [],
      model: options.model || state.model,
      thinking: state.thinking,
      permission: state.permission,
      mode: proposals ? proposals.getPolicy().mode : 'off',
      disabled: false,
      dir: () => {
        const c = ctxProvider() || {};
        return c.dir || c.path || '';
      },
      usage: { used: 0, budget: 0 },
      onSubmit: (payload) => { ask(payload); },
      onStop: () => {
        state.token.stopped = true;
        /* 旗标只让环路在下一步前收手；在飞的这次请求要靠 onStop 立刻结束，
           Rust 侧 ai_cancel 再去断连接——两边都做，才不用等接口自己超时。 */
        try { if (typeof state.token.onStop === 'function') state.token.onStop(); } catch (e) { /* 收尾失败也要停 */ }
        try { if (window.API && window.API.aiCancel) window.API.aiCancel(); } catch (e) { /* 断连失败不影响界面 */ }
        composer.setBusy(true, true);
      },
      onThinkingChange: (v) => {
        state.thinking = v;
        rememberUi({ thinking: v });
      },
      onPermissionChange: (p) => {
        state.permission = p;
        rememberUi({ permission: p });
      },
      onModelChange: (id) => {
        /* 换模型就换窗口：每个模型的上下文长度是各自的能力，不共用上一个的。
           端点没报过这个模型的值时，按模型名推断（1M / 200K / 128K…），不留空。 */
        state.model = id;
        rememberUi({ model: id });
        const w = ctxWindowOf(Object.assign({}, state.settings, { model: id }));
        state.ctxWindow = w;
        composer.setUsage({ used: state.usedTokens || 0, budget: w });
        composer.setThinkBudgets(thinkBudgets(), w);
      },
      /* 档位就在输入框那排「标准」旁边：改完立刻落盘，底栏那句话跟着变 */
      onModeChange: (k) => { setMode(k); }
    });
    shell.appendChild(composer.el);

    /* 底栏只留一句人话：档位本体已经挪到输入框那排，
       底栏再说一遍就是重复，但「现在允许到哪一档」必须还有一处常驻说明。 */
    const footText = h('span', { class: 'ai-foot-text' });
    const foot = h('div', { class: 'ai-foot' }, UIx.icon('shield'), footText);
    shell.appendChild(foot);

    function paintFoot() {
      const mode = proposals ? proposals.getPolicy().mode : 'off';
      const m = MODE_LABEL[mode] || MODE_LABEL.off;
      foot.classList.toggle('armed', mode !== 'off');
      footText.textContent = T('助手权限：' + m[0] + ' · ' + m[1], 'Assistant: ' + m[0] + ' · ' + m[1]);
      if (composer && composer.setMode) composer.setMode(mode);
    }

    function setMode(k) {
      if (!proposals) return;
      const p = Object.assign({}, proposals.getPolicy(), { mode: k });
      proposals.setPolicy(p);
      rememberUi({ agent: p });
      paintFoot();
      if (k === 'full') {
        addNotice(T('「放手」已打开：能撤销的动作直接执行，永久删除仍要输入确认词。',
          'Full auto on: reversible actions run at once; permanent deletes still need the word.'), 'warn');
      } else if (k !== 'off') {
        addNotice(T('已允许 AI 动手（' + (MODE_LABEL[k] || MODE_LABEL.off)[0] + '）。每个动作都会先变成一张卡片。',
          'AI is allowed to act (' + k + '). Every action arrives as a card first.'), 'info');
      }
    }

    paintFoot();

    /* navigate 工具只做一件事：切页面。走 hash 路由，跟点侧栏是同一条路，
       不会绕过页面自己的初始化，也不会把当前页面弄成半截状态。 */
    function navigateTo(page) {
      const p = String(page || '').trim();
      if (!p) return { ok: false, error: '没给页面名' };
      try { location.hash = '#' + p; } catch (e) { return { ok: false, error: '切不过去' }; }
      return { ok: true, page: p };
    }

    function scrollEnd(force) {
      /* 贴底跟随交给 AIFollow 判断；这里只做「已经在底部」时的即时贴底 */
      if (follow) {
        if (follow.isFollowing() || force) follow.toBottom(force ? 'instant' : 'instant');
        return;
      }
      const gap = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      if (!force && gap > 80) return;
      scroller.scrollTop = scroller.scrollHeight;
    }

    /* 配置变了就同步胶囊与菜单：模型是单一真值，不在菜单里编造 */
    function applyModels(settings) {
      const list = realModels(settings);
      composer.setModels(list);
      if (list.length) {
        /* 上次在菜单里选的那个模型优先：它在清单里就沿用它，
           不在（端点换了、模型下线了）才退回设置里配的第一个。 */
        const want = ui.model && list.some(function (m) { return m.id === ui.model; }) ? ui.model : list[0].id;
        state.model = want;
        composer.setModel(want);
      } else {
        state.model = '';
      }
      /* 上下文占用环的分母是模型真窗口，不是写死的 8000 */
      state.ctxWindow = ctxWindowOf(settings);
      composer.setUsage({ used: state.usedTokens || 0, budget: state.ctxWindow });
      /* 滑块刻度标的是「思考预算」，不是查证轮数：
         轮数是防守用的硬上限，写出来只会让人以为「少查几轮 = 更省钱」 */
      composer.setThinkBudgets(thinkBudgets(), state.ctxWindow);
      return list;
    }

    /* 四档滑块的刻度文字：思考预算（token），0 就直说「不思考」 */
    function thinkBudgets() {
      return Strength.stops().map(function (s) {
        return {
          id: s.id,
          steps: s.steps,
          label: s.think ? (s.think >= 1000 ? (s.think / 1000).toFixed(1) + 'K' : String(s.think)) : T('不思考', 'off')
        };
      });
    }

    /* 模型窗口：按「这个模型」优先——设置里每个模型各存一份端点实测值，
       全局 ctxWindow 只是兜底；都没报过就按模型名推，推不出按 1M。
       绝不把「上一个模型的窗口」套到新模型上。 */
    function ctxWindowOf(settings) {
      const s = settings || {};
      const model = String(s.model || '');
      const per = model && s.modelCtx ? Number(s.modelCtx[model]) : 0;
      const cands = [per, Number(s.ctxWindow)];
      for (let i = 0; i < cands.length; i += 1) {
        const n = cands[i];
        if (Number.isFinite(n) && n >= 2000 && n <= 4000000) return Math.round(n);
      }
      const guess = (AIStore && AIStore.inferCtx && AIStore.inferCtx(model)) || 0;
      if (guess) return guess;
      return (AIStore && AIStore.FALLBACK_CTX) || 1000000;
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

    /* ---------------- 提案卡片 ----------------
       模型提的每一件事都长在这里：看得见数量、体积、风险、能不能撤销，
       才谈得上「要不要点」。执行按钮是唯一的执行入口。 */
    /* ---------------- 提案卡片 ----------------
       模型提的每一件事都长在这里：看得见数量、体积、风险、能不能撤销，
       才谈得上「要不要点」。执行按钮是唯一的执行入口。

       一张卡可以只执行其中几条（批量确认）：勾选的行由用户决定，
       勾完会用引擎再预演一次，卡片上的「N 项 / 多大」跟着真实数字走。 */
    const cardNodes = new Map();
    const CONFIRM_WORD = () => T('删除', 'delete');
    const PICK_SHOW_MAX = 10;

    function fmtSize(n) {
      const v = Number(n) || 0;
      if (v < 1024) return v + ' B';
      const u = ['KB', 'MB', 'GB', 'TB'];
      let i = -1;
      let x = v;
      do { x /= 1024; i += 1; } while (x >= 1024 && i < u.length - 1);
      return (x >= 100 ? x.toFixed(0) : x.toFixed(1)) + ' ' + u[i];
    }

    function leafOf(s) {
      const t = String(s || '');
      const i = Math.max(t.lastIndexOf('\\'), t.lastIndexOf('/'));
      return i >= 0 ? t.slice(i + 1) : t;
    }

    /* 勾选行里名字已经在左边，右边再整条路径就是同一个名字写两遍：
       只留所在目录，用户对「在哪个文件夹」更敏感。 */
    function dirOf(s) {
      const t = String(s || '');
      const i = Math.max(t.lastIndexOf('\\'), t.lastIndexOf('/'));
      return i > 0 ? t.slice(0, i) : '';
    }

    function pendingCards() {
      syncCards();
    }

    /* 整页和抽屉共用一份队列，因此这里不能只往自己这边追加新卡：
       别的视图已经处理掉的，这边也要跟着换成「已执行 / 已取消」。 */
    function syncCards() {
      if (!proposals) return;
      const live = proposals.list();
      const ids = new Set(live.map((x) => x.id));
      live.forEach((p) => {
        const had = cardNodes.get(p.id);
        if (had) {
          if (had._repaint && had.dataset.status !== p.status) had._repaint();
          return;
        }
        /* 卡片是「现在就要你处理」的东西：追加前只要用户没翻到很远的历史里，
           就把视图钉到卡片底部。scrollEnd(false) 的 80px 判据在这里不够用——
           一张卡动辄两百多像素高，追加完 gap 已经超了，尾巴（勾选区下半 +
           执行/取消）会停在输入框下面点不到。 */
        const near = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 400;
        const node = proposalCard(p);
        cardNodes.set(p.id, node);
        msgs.appendChild(node);
        if (near) requestAnimationFrame(() => scrollEnd(true));
      });
      cardNodes.forEach((node, id) => {
        if (ids.has(id)) return;
        if (node.dataset.status === 'pending' && node._repaint) node._repaint();
      });
    }

    function proposalCard(p) {
      const host = h('div', { class: 'ai-msg bot ai-prop' });
      host._repaint = paint;
      paint();
      return host;

      function paint() {
        const c = p.card || {};
        const risk = Number(c.risk || p.risk || 1);
        host.innerHTML = '';
        host.dataset.status = p.status || 'pending';
        host.className = 'ai-msg bot ai-prop r' + risk;

        host.appendChild(h('div', { class: 'ai-prop-head' },
          h('span', { class: 'ai-prop-title' }, c.title || p.label || p.action),
          h('span', { class: 'ai-chip' + (risk >= 3 ? ' danger' : risk === 2 ? ' warn' : '') },
            T('风险 ' + risk, 'risk ' + risk)),
          h('span', { class: 'ai-chip' + (c.reversible ? ' ok' : ' danger') },
            T(c.reversible ? '可撤销' : '不可撤销', c.reversible ? 'undoable' : 'no undo'))));

        if (p.why) host.appendChild(h('div', { class: 'ai-prop-why' }, T('理由：', 'Why: ') + p.why));

        const sumLine = h('div', { class: 'ai-prop-sum' });
        const sumText = h('span', { class: 'ai-prop-sum-text' }, c.summary || '');
        const live = h('span', { class: 'ai-prop-live' });
        sumLine.appendChild(sumText);
        sumLine.appendChild(live);
        host.appendChild(sumLine);

        /* 可勾选：动作里有「能放多条路径」的列，且提案还活着。
           能勾的时候不再单列一份同样的清单——同一批文件写两遍，用户得读两遍才敢点。 */
        const picks = Array.isArray(p.picks) ? p.picks : [];
        const pickable = p.status === 'pending' && !!p.pickKey && picks.length > 1;
        if (pickable && !(p._sel instanceof Set)) p._sel = new Set(picks);

        const items = Array.isArray(c.items) ? c.items : [];
        if (items.length && !pickable) {
          const box = h('div', { class: 'ai-prop-items' });
          items.slice(0, 6).forEach((it) => {
            box.appendChild(h('div', { class: 'ai-prop-item' },
              h('span', { class: 'ai-prop-item-t' }, it.t || ''),
              it.s ? h('span', { class: 'ai-prop-item-s' }, it.s) : null,
              it.d ? h('span', { class: 'ai-prop-item-d' }, it.d) : null));
          });
          if (items.length > 6) {
            box.appendChild(h('div', { class: 'ai-prop-more' }, T('还有 ' + (items.length - 6) + ' 项', '+' + (items.length - 6) + ' more')));
          }
          host.appendChild(box);
        }

        let goBtn = null;
        let timer = 0;
        let armed = !p.needsWord;
        let pickDebounce = 0;

        function stopCountdown() {
          if (timer) { clearInterval(timer); timer = 0; }
        }

        function selList() { return picks.filter((x) => p._sel.has(x)); }

        /* 勾了哪些就先算哪些：数量与体积都来自引擎真预演，不是拿整批去比例拆分 */
        function reprice() {
          const chosen = selList();
          if (!chosen.length) {
            live.textContent = T('一项都没选', 'nothing selected');
            if (goBtn) goBtn.disabled = true;
            return;
          }
          if (chosen.length === picks.length) {
            live.textContent = '';
            if (goBtn) goBtn.disabled = !armed;
            return;
          }
          live.textContent = T('已选 ' + chosen.length + ' / ' + picks.length + '，统计中…',
            chosen.length + '/' + picks.length + ' selected, counting…');
          if (goBtn) goBtn.disabled = true;
          if (pickDebounce) clearTimeout(pickDebounce);
          pickDebounce = setTimeout(async () => {
            pickDebounce = 0;
            let r = null;
            try { r = await proposals.preview(p.id, chosen); } catch (e) { r = null; }
            if (!r || !r.ok) {
              live.textContent = T('已选 ' + chosen.length + ' / ' + picks.length, chosen.length + '/' + picks.length);
              if (goBtn) goBtn.disabled = !armed;
              return;
            }
            if (r.empty) {
              live.textContent = T('这几项已经没有可执行的内容', 'nothing left to run');
              if (goBtn) goBtn.disabled = true;
              return;
            }
            live.textContent = T('已选 ' + r.count + ' 项 · ' + fmtSize(r.bytes), r.count + ' items · ' + fmtSize(r.bytes));
            if (goBtn) goBtn.disabled = !armed;
          }, 260);
        }

        if (pickable) {
          const pickBox = h('div', { class: 'ai-prop-pickbox' });
          const all = h('button', { class: 'ai-prop-mini', type: 'button' }, T('全选', 'All'));
          all.addEventListener('click', () => {
            picks.forEach((x) => p._sel.add(x));
            stopCountdown();
            paint();
          });
          const none = h('button', { class: 'ai-prop-mini', type: 'button' }, T('清空', 'None'));
          none.addEventListener('click', () => {
            p._sel.clear();
            stopCountdown();
            paint();
          });
          pickBox.appendChild(h('div', { class: 'ai-prop-picks-head' },
            h('span', { class: 'ai-prop-picks-title' }, T('勾选要执行的项', 'Pick what to run')),
            h('span', { class: 'ai-prop-picks-acts' }, all, none)));
          const list = h('div', { class: 'ai-prop-picks' });
          picks.slice(0, PICK_SHOW_MAX).forEach((path) => {
            const on = p._sel.has(path);
            const cb = h('input', { type: 'checkbox', class: 'ai-prop-cb' });
            cb.checked = on;
            const row = h('label', { class: 'ai-prop-pick' + (on ? ' on' : ' off') },
              cb,
              h('span', { class: 'ai-prop-pick-name' }, leafOf(path)),
              h('span', { class: 'ai-prop-pick-path' }, dirOf(path)));
            cb.addEventListener('change', () => {
              if (cb.checked) p._sel.add(path); else p._sel.delete(path);
              row.classList.toggle('on', cb.checked);
              row.classList.toggle('off', !cb.checked);
              /* 手动改过勾选就别再自动跑：用户正在挑东西 */
              stopCountdown();
              reprice();
            });
            list.appendChild(row);
          });
          pickBox.appendChild(list);
          if (picks.length > PICK_SHOW_MAX) {
            pickBox.appendChild(h('div', { class: 'ai-prop-more' },
              T('另有 ' + (picks.length - PICK_SHOW_MAX) + ' 项未列出，默认包含；点「清空」可全部取消',
                '+' + (picks.length - PICK_SHOW_MAX) + ' not listed, included by default')));
          }
          host.appendChild(pickBox);
        }

        const warns = Array.isArray(c.warnings) ? c.warnings : [];
        if (warns.length) {
          const w = h('div', { class: 'ai-prop-warn' });
          warns.slice(0, 4).forEach((s) => w.appendChild(h('div', {}, '· ' + s)));
          host.appendChild(w);
        }
        if (c.note) host.appendChild(h('div', { class: 'ai-prop-note' }, c.note));

        const bar = h('div', { class: 'ai-prop-bar' });
        host.appendChild(bar);

        if (p.status === 'done') {
          bar.appendChild(h('span', { class: 'ai-prop-done' }, T('已执行：', 'Done: ') + (p.message || '')));
          if (p.undo) {
            const ub = h('button', { class: 'ai-prop-btn', type: 'button' }, T('撤销', 'Undo'));
            ub.addEventListener('click', async () => {
              ub.disabled = true;
              const r = await proposals.undo(p.id);
              ub.textContent = r.ok ? T('已撤销', 'Undone') : T('撤销失败', 'Undo failed');
              if (!r.ok) addNotice(r.error || '撤销失败', 'warn');
              else { markActUndone(p.action); syncCards(); }
            });
            bar.appendChild(ub);
          }
          return;
        }

        if (p.status !== 'pending') {
          bar.appendChild(h('span', { class: 'ai-prop-done' },
            T('已处理：' + (p.status || ''), 'Handled: ' + (p.status || ''))));
          return;
        }

        goBtn = h('button', { class: 'ai-prop-btn primary', type: 'button', disabled: !armed },
          T('执行', 'Run'));
        const no = h('button', { class: 'ai-prop-btn', type: 'button' }, T('取消', 'Cancel'));

        if (p.needsWord) {
          const inp = h('input', {
            class: 'ai-prop-word',
            type: 'text',
            placeholder: T('输入「' + CONFIRM_WORD() + '」确认', 'type "' + CONFIRM_WORD() + '" to confirm'),
            oninput: () => {
              armed = inp.value.trim() === CONFIRM_WORD();
              goBtn.disabled = !armed || (pickable && !selList().length);
            }
          });
          bar.appendChild(inp);
        }

        goBtn.addEventListener('click', async () => {
          stopCountdown();
          goBtn.disabled = true;
          no.disabled = true;
          goBtn.textContent = T('执行中…', 'Running…');
          const pickedPaths = pickable ? selList() : undefined;
          if (pickable && !pickedPaths.length) {
            addNotice(T('一项都没勾，什么也没做', 'nothing checked'), 'warn');
            paint();
            return;
          }
          const r = await proposals.commit(p.id, { approvedBy: 'user', paths: pickedPaths });
          if (r.ok) {
            p.status = 'done';
            p.message = r.message;
            p.undo = (r.proposal && r.proposal.undo) || null;
            recordAct({
              at: Date.now(),
              action: p.action,
              ok: true,
              summary: String(r.message || ''),
              paths: (pickedPaths && pickedPaths.length ? pickedPaths : picks).slice(0, 8),
              undoable: !!p.undo
            });
            paint();
            try {
              window.dispatchEvent(new CustomEvent('ai-action', { detail: { action: p.action, ok: true } }));
            } catch (e) { /* 页面没监听就算了 */ }
          } else {
            /* 失败原因要留在卡片上：过期、预算超了、路径被拦，都各有各的话 */
            addNotice(r.error || T('执行失败', 'Run failed'), 'warn');
            p.status = 'failed';
            paint();
            bar.appendChild(h('span', { class: 'ai-prop-done' }, r.error || ''));
          }
        });

        no.addEventListener('click', async () => {
          stopCountdown();
          goBtn.disabled = true;
          no.disabled = true;
          await proposals.deny(p.id, '用户取消');
          p.status = 'denied';
          paint();
        });

        bar.appendChild(goBtn);
        bar.appendChild(no);

        if (pickable && p._sel.size !== picks.length) reprice();

        /* 自动档：可撤销的小动作先给你 3 秒，看得见、随时能停。
           有勾选项的卡不自动跑——用户正在挑，倒计时会把他挑到一半的东西执行掉。 */
        if (!p.needsWord && !pickable && p.status === 'pending' && proposals.getPolicy().mode === 'auto') {
          const left = h('span', { class: 'ai-prop-count' }, '3');
          const stop = h('button', { class: 'ai-prop-btn', type: 'button' }, T('停止', 'Stop'));
          stop.addEventListener('click', async () => {
            stopCountdown();
            await proposals.deny(p.id, '用户停止倒计时');
            p.status = 'denied';
            paint();
          });
          bar.appendChild(h('span', { class: 'ai-prop-count-wrap' }, T('自动执行 ', 'auto in ') + '3s'));
          bar.appendChild(stop);
          let n = 3;
          timer = setInterval(() => {
            n -= 1;
            left.textContent = String(n);
            if (n <= 0) {
              stopCountdown();
              goBtn.click();
            }
          }, 1000);
        }
      }
    }

    /* 撤销之后卡片上的按钮要换掉：只重画状态变过的那些，别把整屏卡片推倒重来 */
    function pendingCardsRefresh() {
      syncCards();
    }

    /* 队列是全应用一份：谁执行、谁取消、谁过期，所有打开的视图都要跟着换状态 */
    const unsubscribe = (proposals && proposals.subscribe)
      ? proposals.subscribe(() => { try { pendingCardsRefresh(); } catch (e) { /* 画挂了不该影响执行 */ } })
      : null;

    function addUser(text) {
      setEmpty(false);
      /* 不挂「你」的标签：右侧浅底气泡本身已经说明了是谁在说 */
      const node = h('div', { class: 'ai-msg user' },
        h('div', { class: 'ai-msg-body' }, text)
      );
      msgs.appendChild(node);
      /* 每句话开一轮：导航条上一条刻度，跳转就落到这句话 */
      turns.push({ prompt: text, answer: '', userNode: node, answerNode: null });
      stamp(node, 'user', text);
      if (rail) rail.setTurns(turns);
      scrollEnd(true);
    }

    let current = null;

    /* 清空回合：换会话/新会话时必须连刻度一起清，
       否则右边会留着上一段对话的刻度，悬停还能看到上一轮的提问。 */
    function resetTurns() {
      turns.length = 0;
      if (rail) rail.setTurns([]);
      if (follow) follow.resume();
      if (toBottom) toBottom.classList.remove('on');
    }

    /* 查证过程组（procs.js）：折叠时只有一行「执行 N 次思考，调用 M 次工具，记录 K 条」，
       展开是平铺的过程行；跑到一半摊开，落定折回一行，点一下可再摊开。
       口径照 dsh-claude-style 的 Process rows，颜色与字号用本项目的 token。 */
    function startAnswer(opts) {
      const replay = !!(opts && opts.replay);
      const pg = replay ? null : root.AIProcs.create({ onAppend: () => scrollEnd() });
      if (pg) pg.open();
      const body = h('div', { class: 'ai-msg-body ai-answer' });
      const extra = h('div', { class: 'ai-extra' });
      const node = h('div', { class: 'ai-msg bot' },
        pg ? pg.el : null,
        body,
        extra
      );
      msgs.appendChild(node);
      scrollEnd(true);
      current = { node, pg, body, extra, steps: [], replay, stopped: false };
      stamp(node, 'bot', '');
      const turn = turns[turns.length - 1];
      if (turn) turn.answerNode = node;
      return current;
    }

    function pushStep(step) {
      if (!current || !current.pg) return;
      current.steps.push(step);
      /* 思考原文已经由流式片段边收边挂在「思考」行上，这里只补工具行，
         不再把 ev.thought 重放一遍——否则同一段推理会出现两次。 */
      current.pg.addStep({
        tool: step.tool,
        label: step.label,
        args: step.args,
        summary: step.summary,
        error: step.error,
        ms: step.ms,
        ok: step.ok,
        result: step.result
      });
      scrollEnd();
    }

    /* 回答正文：有 Markdown 结构就渲染，没有就原样显示。
       模型偶尔会输出 <b> 之类的标签，AIMd 一律转义，所以这里不会引入
       新的注入面；AIMd 不可用时退回纯文本，功能不受影响。 */
    function paintAnswer(body, text) {
      const md = root.AIMd;
      if (md && md.hasMarkup && md.hasMarkup(text)) {
        body.classList.add('md');
        body.innerHTML = md.render(text);
      } else {
        body.classList.remove('md');
        body.textContent = text;
      }
    }

    /* 右键「让助手看看这里」：把路径填进输入框而不是直接发出去，
       用户可以补一句想干什么（清掉 / 分类 / 看看有多大）再发。 */
    function askAboutPath(p) {
      composer.insertText(T('看看 ', 'Look at ') + p + T(' 里有什么可以清的', ' and tell me what can be cleaned up'));
      composer.focus();
    }

    /* 历史里的查证过程：和当轮长得一样——一行计数，展开是过程行。
       只读，不再执行任何东西；回看的价值是「当时凭什么这么说」。
       旧会话的 trace 没有 label/thought 也能渲染：退回工具名，没有思考就不出思考行。 */
    function replayTrace(trace, saved) {
      const steps = (Array.isArray(trace) ? trace : [])
        .filter((t) => t && (t.tool || t.summary));
      if (!steps.length) return null;
      const keep = saved || {};
      const procs = root.AIProcs.create({ onAppend: function () {} });
      steps.forEach((t) => {
        if (t.thought) procs.addThought(String(t.thought));
        procs.addStep({
          tool: t.tool,
          label: t.label,
          args: t.args,
          ok: t.ok,
          ms: t.ms,
          summary: t.summary,
          error: (t.ok === false) ? (t.error || T('失败', 'failed')) : '',
          result: t.result
        });
      });
      /* 老会话没有 counts：退回「按 trace 数出来的工具数」，
         至少不会凭空写出「执行 0 次思考」 */
      const c = keep.counts || {};
      procs.settle({
        thoughts: Number(c.thoughts) || 0,
        tools: Number(c.tools) || procs.counts.tools,
        records: Number(c.records) || 0,
        label: keep.status === 'stopped' ? T('已停止', 'Stopped')
          : (keep.status === 'unfinished' ? T('查证未完成', 'Unfinished') : '')
      });
      procs.close();
      return procs.el;
    }

    /* 执行记录：这个会话里真正动过手的动作（已执行 / 已撤销）。
       以前这些只在内存活 10 分钟，关掉就再也找不到「我当时清了什么」。 */
    function recordAct(entry) {
      if (!state.session || !entry) return;
      const acts = state.session.acts || (state.session.acts = []);
      acts.push(entry);
      if (acts.length > 40) state.session.acts = acts.slice(-40);
      try { AIStore.saveSession(state.session); } catch (e) { /* 落盘失败不打断对话 */ }
      refreshActs();
    }

    function markActUndone(action) {
      if (!state.session) return;
      const acts = state.session.acts || [];
      for (let i = acts.length - 1; i >= 0; i--) {
        if (!acts[i].undone && acts[i].action === action) {
          acts[i].undone = true;
          try { AIStore.saveSession(state.session); } catch (e) { /* 同上 */ }
          refreshActs();
          return;
        }
      }
    }

    /* 执行记录挂在会话末尾。执行/撤销后要就地刷新——否则「我刚清掉的东西」
       要等下次打开会话才看得到，等于又回到「找不回入口」。 */
    function refreshActs() {
      if (!state.session) return;
      const old = msgs.querySelector('.ai-acts');
      if (old) old.remove();
      const node = actsBar(state.session.acts);
      if (node) {
        msgs.appendChild(node);
        scrollEnd();
      }
    }

    function actsBar(acts) {
      const list = (Array.isArray(acts) ? acts : []).filter((a) => a && a.action);
      if (!list.length) return null;
      const wrap = h('div', { class: 'ai-acts' });
      wrap.appendChild(h('div', { class: 'ai-acts-head' },
        UIx.icon('shield', 13),
        h('span', {}, T('这个会话执行过的操作', 'Actions in this session')),
        h('span', { class: 'ai-acts-n' }, String(list.length))));
      list.forEach((a) => {
        const row = h('div', { class: 'ai-acts-row' + (a.undone ? ' undone' : '') });
        row.appendChild(h('span', { class: 'ai-acts-act' }, String(a.action)));
        row.appendChild(h('span', { class: 'ai-acts-sum' },
          String(a.summary || a.message || (a.ok === false ? T('失败', 'failed') : '')),
          a.undone ? T(' · 已撤销', ' · undone') : ''));
        if (a.at) {
          const d = new Date(Number(a.at) || a.at);
          row.appendChild(h('span', { class: 'ai-acts-at' },
            String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')));
        }
        if (a.paths && a.paths.length) {
          const box = h('div', { class: 'ai-acts-paths' });
          a.paths.slice(0, 3).forEach((p) => box.appendChild(AIEntries.chip(p, { compact: true })));
          row.appendChild(box);
        }
        wrap.appendChild(row);
      });
      return wrap;
    }

    function finishAnswer(res) {
      if (!current) startAnswer();
      const c = current;
      /* 过程组落定：计数定格、等待行收掉、折回一行。
         停止与失败也用同一行计数——「想到哪、查到哪」本身就是信息。 */
      if (c.pg) {
        c.pg.setRecords((res.evidence || []).length);
        c.pg.settle({
          thoughts: c.pg.counts.thoughts,
          tools: c.pg.counts.tools,
          label: res.stopped
            ? T('已停止', 'Stopped')
            : (!res.ok ? T('查证未完成', 'Unfinished') : '')
        });
        /* 回放时 trace 里只有工具，没有「想了几次、记了几条」。
           这两个数落盘放着，历史里的那一行才和当时一模一样 */
        res.counts = { thoughts: c.pg.counts.thoughts, tools: c.pg.counts.tools, records: (res.evidence || []).length };
      /* 状态词也要跟着落盘：回放时「· 已停止 / · 查证未完成」得能从文件里读回来 */
      res.status = res.stopped ? 'stopped' : (!res.ok ? 'unfinished' : '');
        res.status = res.stopped ? 'stopped' : (!res.ok ? 'unfinished' : '');
      }
      paintAnswer(c.body, res.answer || '');
      /* 右键「复制这段」「引用这段」拿的是这条消息的正文，落定后补上 */
      c.node.dataset.text = String(res.answer || '');
      if (res.degraded && !res.ok) c.body.classList.add('degraded');
      if (res.stopped) c.body.classList.add('degraded');

      const ev = evidenceRow(res.evidence, res.trace);
      if (ev) c.extra.appendChild(ev);
      /* 压缩过就在界面上说一声：用户有权知道「助手这一轮看到的是删节版」，
         而不是事后疑惑「明明说过的它怎么不记得」 */
      if (res.compressed && res.compressed !== 'none') {
        c.extra.appendChild(h('div', { class: 'ai-compressed' },
          UIx.icon('layers', 12),
          h('span', {}, T('更早的对话已自动压缩，保留路径与结论', 'Earlier turns were compressed to fit the window'))));
      }
      const cards = suggestCards(res.suggest);
      if (cards) c.extra.appendChild(cards);

      /* 这一轮真正碰过的位置：整条答完就能直接点到那个目录，
         而不是读完一句「打开 D:\Downloads 看看」然后自己去翻。 */
      res.entries = (res.entries && res.entries.length)
        ? res.entries
        : AIEntries.collect(res.trace, res.suggest);
      const loc = AIEntries.bar(res.entries, { onAsk: askAboutPath });
      if (loc) c.extra.appendChild(loc);

      const bar = h('div', { class: 'ai-msg-bar' });
      bar.appendChild(h('button', {
        class: 'btn sm ghost',
        onclick: () => { UIx.copy(res.answer || ''); }
      }, T('复制', 'Copy')));
      /* 停了不是废掉：断点已经在手，接着查比重新问一遍省一整轮 */
      if (res.interrupted && res.checkpoint) {
        bar.appendChild(h('button', {
          class: 'btn sm ghost',
          onclick: () => { continueTurn(); }
        }, T('继续', 'Continue')));
      }
      /* 历史回放没有 lastAsk，「重试」会是个点不动的按钮——那种不如不给 */
      if (!res.replay) {
        bar.appendChild(h('button', {
          class: 'btn sm ghost',
          onclick: () => { retryLast(); }
        }, T('重试', 'Retry')));
      }
      if (res.usage) {
        /* 右下角只留几样：思考时长、这轮 token、缓存命中率、思考预算用量。
           命中率只给百分比，写「命中率」三个字反而要多读一遍。 */
        const u = res.usage;
        const parts = [];
        if (u.elapsed_ms) parts.push((u.elapsed_ms / 1000).toFixed(1) + 's');
        const tokens = (Number(u.prompt_tokens) || 0) + (Number(u.completion_tokens) || 0);
        if (tokens) parts.push(tokens >= 1000 ? (tokens / 1000).toFixed(1) + 'k token' : tokens + ' token');
        /* 服务端没给这个字段就整段省略：显示 0% 等于替它宣称「没命中」 */
        if (u.prompt_cache_hit_tokens !== undefined && Number(u.prompt_tokens) > 0) {
          const hit = Number(u.prompt_cache_hit_tokens) || 0;
          parts.push(Math.round((hit / Number(u.prompt_tokens)) * 100) + '%');
        }
        /* 思考预算：真值标「思考」，服务端没上报就标「约」，绝不用 0 冒充精确 */
        const st = Strength.thinkEstimate(state.policy, u);
        if (st && st.tokens) {
          const text = (st.estimated ? T('约', '~') : '') + st.tokens + T(' 思考', ' thinking');
          parts.push(st.budget ? text + '/' + st.budget : text);
        }
        if (parts.length) bar.appendChild(h('span', { class: 'ai-usage', title: usageTitle(st) }, parts.join(' · ')));
      }
      /* 刻度条的悬停预览要读这一轮的答案和用量：答案本来只进 DOM，
         这里回存到回合对象上，预览就不必去扒正文节点。 */
      const closed = turns[turns.length - 1];
      if (closed) {
        closed.answer = res.answer || '';
        if (res.usage) {
          const bits = [];
          if (res.usage.elapsed_ms) bits.push((res.usage.elapsed_ms / 1000).toFixed(1) + 's');
          const used = (Number(res.usage.prompt_tokens) || 0) + (Number(res.usage.completion_tokens) || 0);
          if (used) bits.push(used >= 1000 ? (used / 1000).toFixed(1) + 'k' : String(used));
          closed.meta = bits.join(' · ');
        }
        if (rail) rail.setTurns(turns);
      }
      c.extra.appendChild(bar);

      const chips = followChips(res.followUps, (q) => ask({ text: q }));
      if (chips) c.extra.appendChild(chips);
      /* 执行记录永远待在会话最末：新回答进来后把它挪下来，不然读起来像
         「先记了账、才发生的事」。 */
      refreshActs();
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

    function budgetFor(policy, settings) {
      /* 档位只管「多努力」：思考预算、查几轮、答案多长。上下文窗口是模型能力，
         原样交给 agent，压缩阈值由它在窗口的 50/70/85% 处自动踩——
         想得深不该记得少。步数再和设置里的硬上限取小，防一路跑飞。 */
      const cap = Number(settings.maxSteps) || 0;
      return {
        steps: cap > 0 ? Math.min(policy.steps, cap) : policy.steps,
        window: ctxWindowOf(settings),
        replyMax: policy.replyMax
      };
    }

    async function ask(input) {
      const payload = (input && typeof input === 'object') ? input : { text: String(input || '') };
      const q = String(payload.text || '').trim();
      const resume = payload.resume || null;
      if ((!q && !(payload.attachments || []).length) || state.running) return;
      lastAsk = payload;

      state.thinking = payload.thinking || state.thinking;
      state.permission = payload.permission || state.permission;

      const shown = q || T('（已附加 ', '(attached ') + (payload.attachments || []).length + T(' 个路径）', ' paths)');
      /* 继续不是新问题：用户那条消息已经在断点里，再插一条会重复 */
      if (!resume) addUser(q ? shown : shown);

      state.running = true;
      state.token = { stopped: false };
      composer.setBusy(true, false);

      const settings = await AIStore.load();
      applyModels(settings);
      try { await ensureGuard(); } catch (e) { /* 闸门没配好也不挡住只读问答 */ }
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

      /* 这一轮的策略先算出来：档位决定努力，任务决定温度。
         温度用 null 表示「这家锁死了」，agent 见到 null 就不发 temperature */
      const policy2 = policyFor(q, settings);
      const bud = budgetFor(policy2, settings);
      const policy = proposals ? proposals.getPolicy() : { mode: 'off' };
      const canWrite = policy.mode !== 'off';
      const allowed = PERM_TOOLS[state.permission] || PERM_TOOLS.standard;
      const allTools = AITools.makeTools({ API: window.API, proposals: proposals, navigate: navigateTo });
      const tools = {};
      allowed.forEach((n) => {
        /* 关掉动手之后提案工具也一起收起来：模型看不见，就不会提一张注定被拒的卡片 */
        if (!canWrite && PROPOSE_TOOLS.indexOf(n) >= 0) return;
        if (allTools[n]) tools[n] = allTools[n];
      });
      if (proposals) proposals.startTurn();

      /* 注意：AIStore 存的字段叫 key，agent 读的是 apiKey —— 这里对上，
         否则真实接口会因为没有 Authorization 头直接 401。 */
      const agentSettings = Object.assign({}, settings, {
        model: payload.model || settings.model,
        apiKey: settings.key,
        maxSteps: bud.steps,
        /* 窗口原样传下去：agent 按它的 50/70/85% 自动压缩，
           不再由「深度档位」乘一个比例——那是两件事 */
        ctxWindow: bud.window,
        turnBudget: 0,
        /* 温度与强度原生字段都由 strength 算：
           温度 = 手填 > 任务默认 > 档位兜底；锁温模型的 null 表示「不发」 */
        temperature: policy2.temperature,
        extraBody: policy2.extra,
        /* 回复上限跟着思考强度走：agent 用它算 max_tokens，
           原来固定 700 会把长回答截成半截 JSON */
        replyMax: bud.replyMax
      });
      state.policy = policy2;

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
        /* 这个端点+模型学到的新习惯（不认 response_format、要等多久、会不会思考）
           落回设置里，下次直接按它发请求，不用每轮重新试错 */
        learn: (capKey, caps) => {
          const all = Object.assign({}, settings.caps || {});
          all[capKey] = Object.assign({}, caps, { updatedAt: Date.now() });
          settings.caps = all;
          try { Promise.resolve(AIStore.save({ caps: all })).catch(() => {}); } catch (e) { /* 记不住不影响这一轮 */ }
        },
        settings: agentSettings
      });

      const ctx = Object.assign({}, ctxProvider() || {});
      if (payload.attachments && payload.attachments.length) {
        ctx.files = payload.attachments.slice(0, 10);
        ctx.selected = payload.attachments.slice(0, 3);
      }
      ctx.tools = Object.keys(tools);
      ctx.permission = permLabel(state.permission);
      /* 上下文行里说清「这一轮多努力、温度多少、任务是什么」：
         模型据此调自己的行为，用户不用在正文里读到这些元信息 */
      ctx.thinking = Strength.LEVELS[policy2.level].label[0];
      ctx.temperature = policy2.temperature;
      ctx.tempSrc = { manual: T('手填', 'manual'), task: T('任务', 'task'), level: T('档位', 'level'), locked: T('模型固定', 'fixed') }[policy2.tempSrc] || '';
      ctx.task = policy2.taskLabel ? policy2.taskLabel[0] : '';
      ctx.canWrite = !!(tools.propose_action);

      startAnswer();
      let res;
      try {
        res = await agent.run({
          userText: q || T('看看这些文件：', 'Look at these files: ') + (payload.attachments || []).join(', '),
          ctx: ctx,
          history: state.history,
          token: state.token,
          resume: resume,
          onEvent: (ev) => {
            if (ev.type === 'step') {
              /* 等待行的措辞跟着阶段走：同一条「还在跑」，
                 说「正在查证」比说「正在思考」更接近用户此刻看到的事 */
              if (current && current.pg) current.pg.setRunning(true, T('正在查证', 'Checking'));
              pushStep({
                tool: ev.tool,
                /* 行标签用工具自己的短名（磁盘 / 空文件夹 / 读文件），
                    不再拿 prompt 里那句给模型看的长描述——那句子是给模型读的，
                    摊在过程行里就是一大团 */
                label: ev.label || (tools[ev.tool] || {}).label || ev.tool,
                args: ev.args,
                ok: ev.ok,
                summary: ev.summary,
                ms: ev.ms,
                thought: ev.thought,
                result: ev.result,
                error: ev.error
              });
              /* 提案一落地就把卡片摆出来：用户不用等模型把话说完了才看到 */
              if (ev.tool === 'propose_action' && ev.ok) pendingCards();
            } else if (ev.type === 'thought') {
              if (current && current.pg) {
                /* 推理原文先挂在「思考」行上；下一步工具会把它折进过程组 */
                current.pg.setRunning(true, T('正在推理', 'Reasoning'));
                current.pg.addThought(ev.text);
              }
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
        /* 回答不是一段文字就完：查证过程、依据、建议、可点入口一起落盘，
           否则回到历史里只剩一句「打开 D:\… 看看」，入口全丢了。 */
        state.session.messages.push({
          role: 'assistant',
          content: res.answer || '',
          at: Date.now(),
          ok: res.ok,
          trace: res.trace || [],
          evidence: res.evidence || [],
          suggest: res.suggest || [],
          entries: res.entries || [],
          followUps: res.followUps || [],
          compressed: res.compressed || 'none',
          counts: res.counts || null,
          status: res.status || '',
          usage: res.usage || null
        });
        if (!state.session.title || state.session.title === '新会话') state.session.title = q.slice(0, 30);
        try { await AIStore.saveSession(state.session); } catch (e) { /* 落盘失败不打断对话 */ }
        /* 记住「正在聊的这个会话」：下次进 AI 页直接接着聊，
           而不是每次都开一个空白新会话。 */
        rememberUi({ lastSession: state.session.id });
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

    /* 从断点接着跑：不重发已经查过的工具，也不重复插用户消息 */
    function continueTurn() {
      const res = state.lastResult;
      if (!res || !res.checkpoint || state.running) return;
      const base = lastAsk || { text: '' };
      ask(Object.assign({}, base, { resume: res.checkpoint }));
    }

    /* 会话列表变了（新建 / 落盘 / 载入）就让外面重画右侧的归档列表 */
    function notifySessions() {
      if (typeof options.onSessions === 'function') {
        try { options.onSessions(); } catch (e) { /* 外面的重画失败不该影响对话 */ }
      }
    }

    /* ---------- 右键菜单 ----------
       菜单本身用软件自带的 UI.menu（跟文件列表同一个面板），
       这里只负责：这次点在哪、能引用哪一段、复制什么。 */
    function stamp(node, role, text) {
      if (!node) return;
      node.dataset.role = role;
      node.dataset.time = new Date().toTimeString().slice(0, 5);
      node.dataset.text = String(text == null ? '' : text);
    }

    function selectionText() {
      try {
        const s = window.getSelection ? String(window.getSelection()) : '';
        return s.trim();
      } catch (e) { return ''; }
    }

    function writeClipboard(text) {
      if (!text) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(() => UIx.copy(text));
      } else UIx.copy(text);
    }

    function pasteIntoComposer() {
      if (!navigator.clipboard || !navigator.clipboard.readText) {
        composer.focus();
        UIx.toast(T('请按 Ctrl+V 粘贴', 'Press Ctrl+V to paste'));
        return;
      }
      navigator.clipboard.readText().then((t) => {
        if (t) composer.insertText(t);
        else composer.focus();
      }).catch(() => {
        composer.focus();
        UIx.toast(T('读不到剪贴板，请按 Ctrl+V', 'Clipboard blocked, press Ctrl+V'));
      });
    }

    /* 一段节点的纯文本：回答取正文，思考块去掉按钮与时间戳 */
    function textOf(el) {
      if (!el) return '';
      const body = el.querySelector('.ai-msg-body');
      return (body ? body.innerText : el.innerText || '').trim();
    }

    function onContextMenu(e) {
      const t = e.target;
      if (!t || !t.closest) return;
      /* 输入框里也走自家菜单：系统那份会带一堆「拼写检查」之类没用的项 */
      const inComposer = t.closest('.dac-field, textarea.dac-input');
      if (inComposer) {
        const sel = selectionText();
        UI.menu(e, [
          { header: T('输入框', 'Composer') },
          { label: T('剪切', 'Cut'), disabled: !sel, action: () => writeClipboard(composer.clipboard('cut')) },
          { label: T('复制', 'Copy'), disabled: !sel, action: () => writeClipboard(composer.clipboard('copy')) },
          { label: T('粘贴', 'Paste'), action: pasteIntoComposer },
          { sep: true },
          { label: T('全选', 'Select all'), action: () => composer.clipboard('selectAll') },
          { label: T('清空', 'Clear'), disabled: !composer.getValue(), action: () => composer.setValue('') }
        ]);
        return;
      }

      const sel = selectionText();
      const row = t.closest('.pg-row');
      const grp = t.closest('.pg');
      const msg = t.closest('.ai-msg');

      /* 思考行：折叠的是这一段的原文，引用/复制就该拿原文 */
      if (row && row.classList.contains('pg-think')) {
        const box = row.nextElementSibling;
        const src = box ? (box.querySelector('.pg-thought') || box) : null;
        const words = src ? textOf(src) : '';
        UI.menu(e, [
          { header: T('思考过程', 'Reasoning') },
          { label: T('引用这段思考', 'Quote reasoning'), disabled: !words,
            action: () => composer.insertQuote(words, { role: 'bot' }) },
          { label: T('复制', 'Copy'), disabled: !words, action: () => writeClipboard(words) },
          { sep: true },
          { label: row.getAttribute('aria-expanded') === 'true' ? T('收起原文', 'Collapse') : T('展开原文', 'Show reasoning'),
            action: () => row.click() }
        ]);
        return;
      }

      /* 过程行：引用/复制的是这一行自己的内容（参数、摘要、原始返回值） */
      if (row) {
        const label = (row.querySelector('.pg-label') || {}).textContent || '';
        const detail = (row.querySelector('.pg-detail') || {}).textContent || '';
        const out = row.nextElementSibling;
        const raw = out ? textOf(out) : '';
        const payload = [label, detail].filter(Boolean).join(' · ');
        UI.menu(e, [
          { header: T('这一步', 'This step') },
          { label: T('引用结果', 'Quote result'), action: () => composer.insertQuote(raw || payload, { role: 'bot' }) },
          { label: T('复制', 'Copy'), action: () => writeClipboard(raw || payload) },
          { sep: true },
          { label: row.getAttribute('aria-expanded') === 'true' ? T('收起', 'Collapse') : T('展开原始结果', 'Show raw result'), action: () => row.click() }
        ]);
        return;
      }
      /* 组头：整组折叠/展开；旁边的等待行不算「思考块」，不给思考菜单 */
      if (grp && !msg) {
        UI.menu(e, [
          { header: T('查证过程', 'Process') },
          { label: grp.hasAttribute('data-open') ? T('收起过程', 'Collapse') : T('展开过程', 'Expand'),
            action: () => { const hd = grp.querySelector('.pg-head'); if (hd) hd.click(); } },
          { label: T('复制过程', 'Copy process'), action: () => writeClipboard(textOf(grp)) }
        ]);
        return;
      }

      /* 某条消息：选中了文字就只引用选中那段，否则引用整条 */
      if (msg) {
        const role = msg.dataset.role || 'bot';
        const body = textOf(msg);
        const payload = sel || body;
        const short = payload.length > 800 ? payload.slice(0, 800) + '…' : payload;
        UI.menu(e, [
          { header: role === 'user' ? T('你问的', 'You asked') : T('助手的回答', 'Assistant') },
          { label: sel ? T('引用选中的话', 'Quote selection') : T('引用这段对话', 'Quote this turn'),
            disabled: !payload, action: () => composer.insertQuote(short, { role: role, time: msg.dataset.time }) },
          { label: sel ? T('复制选中的话', 'Copy selection') : T('复制这段', 'Copy this'),
            disabled: !payload, action: () => writeClipboard(payload) },
          { label: T('复制全文', 'Copy whole message'), disabled: !body, action: () => writeClipboard(body) },
          { sep: true },
          { label: T('粘贴到输入框', 'Paste into composer'), action: pasteIntoComposer }
        ]);
        return;
      }

      /* 空白处：只给「粘贴」和「全选对话」 */
      UI.menu(e, [
        { label: T('粘贴到输入框', 'Paste into composer'), action: pasteIntoComposer },
        { label: T('复制整段对话', 'Copy transcript'), disabled: !msgs.children.length,
          action: () => writeClipboard(Array.prototype.map.call(msgs.children,
            (n) => ((n.dataset.role === 'user' ? '我：' : '助手：') + (n.dataset.text || textOf(n)))).join('\n\n')) }
      ]);
    }

    msgs.addEventListener('contextmenu', onContextMenu);
    /* 回答正文里的路径与链接统一由 AIEntries 接管：
       点路径 = 打开那个位置，点外链 = 交给系统浏览器（WebView2 里
       target="_blank" 没有窗口处理器，点了什么都不会发生）。 */
    AIEntries.bind(msgs, { onAsk: askAboutPath });
    /* 输入框自己也要绑：它不在消息区里，而且 ui.js 对输入类不拦系统菜单，
       不绑的话这里是浏览器原生那份（带拼写检查），跟别处不一致 */
    if (composer && composer.input) composer.input.addEventListener('contextmenu', onContextMenu);

    renderEmpty();
    composer.focus();
    /* 谁创建聊天就自动套上上次的强度与权限（抽屉里的临时会话也一致），
       不必等调用方记得传。模型由 applyModels 按 ui.model 落地。 */
    AIStore.loadUi().then((prefs) => {
      if (!prefs) return;
      Object.assign(ui, prefs);
      if (prefs.thinking) {
        state.thinking = prefs.thinking;
        composer.setThinking(prefs.thinking);
      }
      if (prefs.permission) {
        state.permission = prefs.permission;
        composer.setPermission(prefs.permission);
      }
    }).catch(() => {});
    AIStore.load().then((s) => {
      applyModels(s);
    }).catch(() => {});

    return {
      ask,
      retry: retryLast,
      composer,
      clear() {
        resetTurns();
        msgs.innerHTML = '';
        cardNodes.clear();
        if (proposals) proposals.newSession();
        state.history = [];
        state.session = null;
        state.lastResult = null;
        renderEmpty();
        setEmpty(true);
      },
      loadSession(session) {
        resetTurns();
        msgs.innerHTML = '';
        cardNodes.clear();
        /* 会话里存过的提案不再重放成可点卡片：过期的东西点了只会失败。
           执行过的动作另有一条「执行记录」，那才是事后要回看的东西。 */
        if (proposals) proposals.newSession();
        state.session = session;
        state.history = [];
        lastAsk = null;
        (session.messages || []).forEach((m) => {
          if (m.role === 'user') {
            addUser(m.content);
            state.history.push({ role: 'user', content: m.content });
            return;
          }
          const c = startAnswer({ replay: true });
          /* 老会话只有一段文字，新会话带着查证过程与入口一起回来。
             后者直接重放，前者从正文里认路径，两种都能点到位置。 */
          const entries = (m.entries && m.entries.length)
            ? m.entries
            : AIEntries.fromText(m.content);
          const steps = replayTrace(m.trace, m);
          if (steps) c.node.insertBefore(steps, c.body);
          finishAnswer({
            ok: m.ok !== false,
            replay: true,
            answer: m.content,
            evidence: m.evidence || [],
            suggest: m.suggest || [],
            followUps: [],
            trace: m.trace || [],
            entries: entries,
            compressed: m.compressed || 'none',
            usage: m.usage || null,
            interrupted: false
          });
          state.history.push({ role: 'assistant', content: m.content });
        });
        refreshActs();
        setEmpty(false);
        scrollEnd(true);
        notifySessions();
      },
      newSession() {
        resetTurns();
        msgs.innerHTML = '';
        /* 新会话清空提案队列：上一个会话没确认的动作不能跨会话留着，
           否则「我上次好像点过什么」就成了猜谜。配额也从零开始。 */
        cardNodes.clear();
        if (proposals) proposals.newSession();
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
      /* 挂载时叫它：恢复上次的界面偏好（强度 / 权限 / 模型）与上次那个会话。
         记忆是锦上添花——读失败或会话文件没了就按默认值继续，不报错。 */
      async boot() {
        /* 先把闸门的三个真值拿到手：万一用户一进来就让你动手，
           配置还没到的话路径检查会漏判 */
        try { await ensureGuard(); } catch (e) { /* 拿不到就让每次提议自己去查 */ }
        let prefs = null;
        try { prefs = await AIStore.loadUi(); } catch (e) { prefs = null; }
        if (prefs) {
          Object.assign(ui, prefs);
          this.setThinking(prefs.thinking);
          this.setPermission(prefs.permission);
          if (prefs.model) this.setModel(prefs.model);
          if (prefs.agent && proposals) proposals.setPolicy(prefs.agent);
          paintFoot();
        }
        if (ui.lastSession) {
          try {
            const s = await AIStore.loadSession(ui.lastSession);
            if (s) {
              this.loadSession(s);
              return s;
            }
          } catch (e) { /* 坏文件当作没有 */ }
          rememberUi({ lastSession: '' });
        }
        this.newSession();
        return state.session;
      },
      get session() { return state.session; },
      focus() { composer.focus(); },
      setBusy(b) { state.running = b; composer.setBusy(b, false); },
      setModel(id) { state.model = id; composer.setModel(id); },
      setThinking(v) { state.thinking = v; composer.setThinking(v); },
      setPermission(p) { state.permission = p; composer.setPermission(p); },
      /* 页面/抽屉收起时必须调它：composer 里挂着推理强度画布的 ticker、
         菜单的 resize 监听和 motion 订阅，只清 DOM 会把它们留成常驻空转。
         提案队列是全应用共用的，退订一定要做，否则关掉的抽屉还在重画。 */
      destroy() {
        try { if (unsubscribe) unsubscribe(); } catch (e) { /* 退订失败不影响收尾 */ }
        try { composer.destroy(); } catch (e) { /* 忽略 */ }
      }
    };
  }

  root.AIChat = { create };
})(typeof window !== 'undefined' ? window : globalThis);
