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

    /* 界面偏好（推理强度 / 权限 / 选中的模型 / 上次的会话）跟接口配置分两处存：
       这里先按上次记下的值起来，读到磁盘之前不改用户已经做过的选择。
       合并写盘：拖强度滑块、点权限不会每动一下就落一次文件。 */
    const ui = Object.assign({}, (AIStore.UI_DEFAULTS || {}), options.ui || {});
    let uiTimer = 0;

    function rememberUi(patch) {
      Object.assign(ui, patch || {});
      if (uiTimer) clearTimeout(uiTimer);
      uiTimer = setTimeout(function () {
        uiTimer = 0;
        try {
          Promise.resolve(AIStore.saveUi(ui)).catch(function () { /* 记不住不该挡住对话 */ });
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
      disabled: false,
      dir: () => {
        const c = ctxProvider() || {};
        return c.dir || c.path || '';
      },
      usage: { used: 0, budget: 8000 },
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
        /* 换模型就换窗口：每个模型的上下文长度是各自的能力，不共用上一个的 */
        state.model = id;
        rememberUi({ model: id });
        const w = Number((state.settings && state.settings.modelCtx && state.settings.modelCtx[id]) || 0);
        if (w) {
          state.ctxWindow = w;
          composer.setUsage({ used: state.usedTokens || 0, budget: w });
          composer.setThinkBudgets(thinkBudgets({ ctxWindow: w }), w);
        }
      }
    });
    shell.appendChild(composer.el);

    /* 底栏：左边一句人话说明当前边界，右边四个档位直接点。
       档位是危险开关，必须一眼看得见、一下能改回来，不能埋进设置页深处。 */
    const footText = h('span', { class: 'ai-foot-text' });
    const modeBar = h('div', { class: 'ai-modes' });
    const foot = h('div', { class: 'ai-foot' }, UIx.icon('shield'), footText, modeBar);
    shell.appendChild(foot);

    function paintFoot() {
      const mode = proposals ? proposals.getPolicy().mode : 'off';
      const m = MODE_LABEL[mode] || MODE_LABEL.off;
      foot.classList.toggle('armed', mode !== 'off');
      footText.textContent = T('助手权限：' + m[0] + ' · ' + m[1], 'Assistant: ' + m[0] + ' · ' + m[1]);
      modeBar.innerHTML = '';
      Object.keys(MODE_LABEL).forEach((k) => {
        modeBar.appendChild(h('button', {
          class: 'ai-mode' + (k === mode ? ' on' : '') + (k === 'full' ? ' danger' : ''),
          type: 'button',
          title: T(MODE_LABEL[k][1], MODE_LABEL[k][1]),
          onclick: () => setMode(k)
        }, T(MODE_LABEL[k][0], MODE_LABEL[k][0])));
      });
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
        const node = proposalCard(p);
        cardNodes.set(p.id, node);
        msgs.appendChild(node);
        scrollEnd(false);
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
              else syncCards();
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
      msgs.appendChild(h('div', { class: 'ai-msg user' },
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
      /* 过程卡里那颗 loader 换成 Claude 的三颗点（glyph:'dots'，见 thoughtline.js）；
         落定后三点停住、转成二级灰，标题行换成「思考 N 段 · 调用 N 次工具」 */
      const tl = replay ? null : root.AIThoughtLine.create({
        label: T('正在思考…', 'Thinking…'),
        glyph: 'dots',
        collapsible: true,
        collapseOnSettle: true,
        showTimer: true,
        copyLabel: T('复制思考过程', 'Copy reasoning'),
        thoughtLabel: T('思考', 'Thinking'),
        /* 思考正文不再内滚，长出来就把对话滚到底 */
        onAppend: () => scrollEnd(),
        speak: (sec) => T(sec.toFixed(1) + ' 秒', sec.toFixed(1) + ' seconds')
      });
      const body = h('div', { class: 'ai-msg-body ai-answer' });
      const extra = h('div', { class: 'ai-extra' });
      const node = h('div', { class: 'ai-msg bot' },
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

    /* 落定后的那句话：把「想了多少、查了什么」压成一句，时间由计时器接在后面 */
    function doneLabelFor(steps, res, thoughts) {
      const n = steps.length;
      const t = thoughts || 0;
      if (res.stopped) return T('已停止', 'Stopped');
      if (!res.ok) return n ? T(`查了 ${n} 项 · 未完成`, `Checked ${n} · unfinished`) : T('查证失败', 'Failed');
      const parts = [];
      if (t) parts.push(T(`思考 ${t} 段`, `Thought ${t}×`));
      if (n) parts.push(T(`调用 ${n} 次工具`, `${n} tool calls`));
      return parts.length ? parts.join(' · ') : T('思考了', 'Thought');
    }

    function finishAnswer(res) {
      if (!current) startAnswer();
      const c = current;
      if (c.tl) c.tl.settle({ doneLabel: doneLabelFor(c.steps, res, c.tl.thoughts) });
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
      /* 停了不是废掉：断点已经在手，接着查比重新问一遍省一整轮 */
      if (res.interrupted && res.checkpoint) {
        bar.appendChild(h('button', {
          class: 'btn sm ghost',
          onclick: () => { continueTurn(); }
        }, T('继续', 'Continue')));
      }
      bar.appendChild(h('button', {
        class: 'btn sm ghost',
        onclick: () => { retryLast(); }
      }, T('重试', 'Retry')));
      if (res.usage) {
        /* 右下角只留三样：思考时长、这轮 token 用量、缓存命中率。
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
        if (parts.length) bar.appendChild(h('span', { class: 'ai-usage', title: T('缓存命中率 = 命中缓存的提示 token / 本步提示 token', 'Cache hit rate = cached prompt tokens / prompt tokens') }, parts.join(' · ')));
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

      const bud = budgetFor(state.thinking, settings);
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
      ctx.thinking = state.thinking;
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
              pushStep({
                tool: ev.tool,
                label: (AIPrompt.TOOLS[ev.tool] || {}).desc || ev.tool,
                ok: ev.ok,
                summary: ev.summary,
                ms: ev.ms,
                error: ev.error
              });
              /* 提案一落地就把卡片摆出来：用户不用等模型把话说完了才看到 */
              if (ev.tool === 'propose_action' && ev.ok) pendingCards();
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
