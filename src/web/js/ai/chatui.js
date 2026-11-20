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
   *  步数硬上限来自设置里的防跑飞闸。
   *
   *  level 必须由调用方显式传进来。这里在模块作用域，读不到 create() 里的
   *  state —— 1.36.19 曾在这里直接写 state.thinking，结果每次提问都抛
   *  ReferenceError，ask() 卡在 running=true 上，表现为「发不出也停不了」。 */
  function policyFor(text, settings, level) {
    const s = settings || {};
    return Strength.resolve({
      level: level,
      text: text,
      temperature: (s.tempAuto === false && typeof s.temperature === 'number') ? s.temperature : null,
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
    readonly: ['list_dir', 'read_file', 'disk_roots', 'top_folders', 'top_indexed', 'last_organize', 'explain_rules'],
    standard: PROPOSE_TOOLS.concat(['list_dir', 'read_file', 'open_path', 'disk_roots', 'top_folders', 'top_files', 'top_indexed', 'empty_dirs', 'installed_apps', 'search_files', 'organize_preview', 'explain_rules', 'last_organize', 'clean_candidates', 'settings_read', 'search_roots']),
    deep: PROPOSE_TOOLS.concat(['list_dir', 'read_file', 'open_path', 'disk_roots', 'top_folders', 'top_files', 'top_indexed', 'empty_dirs', 'file_signals', 'installed_apps', 'search_files', 'organize_preview', 'explain_rules', 'last_organize', 'archive_entries', 'clean_candidates', 'settings_read', 'search_roots'])
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
    /* 两个入口（整页 / 右侧抽屉）现在共用同一个现场，上下文要跟着宿主换：
       整页给的是「页面 + 工具集」，抽屉给的是调用方此刻的目录上下文。
       以前这里是 const，attach 换宿主时就只能一直沿用第一个宿主的 ctx，
       抽屉里问「这个目录」会答成整页的上下文。 */
    let ctxProvider = options.ctx || (() => ({}));
    /* 同理：compact 是「宿主长什么样」的属性，不是现场自己的属性。
       抽屉窄、整页宽，换宿主时 shell 与输入框的紧凑类都要跟着换。 */
    let compact = !!options.compact;

    const scroller = h('div', { class: 'ai-scroll' });
    /* 消息容器以前是 const：切会话只能把里面的节点删掉，而正在跑的那一轮
       还在往被删掉的节点里写 —— 用户看到的就是「任务没了」。
       现在它是 let，永远指向当前可见会话的容器（activatePane 负责换）。 */
    let msgs = h('div', { class: 'ai-msgs' });
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

    /* ---------------- 会话分桶（pane） ----------------
       一个会话一个 pane：自己的状态、自己的消息容器、自己的回合刻度。
       切会话只换视图，正在跑的那一轮继续往它自己的 pane 里写。
       以前 newSession / loadSession 只做 resetTurns + msgs.innerHTML=''，
       在飞那一轮的节点被从文档里摘掉，用户看到的就是「任务没了」，
       结果还会落进已经换掉的那个会话对象里 —— bug1 就是这条链。 */
    const panes = new Map();
    /* 不可见的 pane 留在这个隐藏容器里，而不是被摘出文档：
       后台会话仍在写 DOM，节点一旦离开文档树，写出来的东西就再也看不见。 */
    const paneStore = h('div', { class: 'ai-panes' });
    paneStore.hidden = true;
    shell.appendChild(paneStore);
    /* detach 之后整个 shell 停靠在这个隐藏容器里（仍然在文档中）。
       为什么不直接 shell.remove()：后台那一轮还在往 pane.msgs 里写，
       节点一旦脱离文档，follow 的 ResizeObserver 会停止回调、滚动量恒为 0，
       写出来的内容也再没有人看得到——用户重开抽屉只能从历史里重读一遍。 */
    let parked = null;
    /* boot 只该跑一次：obtain 复用已有现场时再 boot 会把当前会话重放一遍，
       正在飞的那一轮的节点会被存档副本顶掉。 */
    let booted = false;
    /* 订阅者改成多播：以前 onSessions / onBusy 各只有一个回调，
       谁后 attach 谁就把前一个顶掉——整页在跑的时候抽屉一打开，
       整页左栏的「正在运行」就再也不刷新了。
       现在按宿主登记，attach 时整体换一批（同一时刻只有一个宿主在用，
       所以「清空重加」比「按宿主标记增删」更简单，也不会漏掉注销）。 */
    const sessionSubs = [];
    const busySubs = [];
    if (typeof options.onSessions === 'function') sessionSubs.push(options.onSessions);
    if (typeof options.onBusy === 'function') busySubs.push(options.onBusy);
    /* 当前可见的 pane：所有「看得见的界面」只认它（滚动、跟随、输入框忙态） */
    let activePane = null;
    /* destroy() 之后为 true。后台会话可能还在飞，它收尾时不该再去碰
       已经被拆掉的输入框 / 跟随器（那些对象已经 destroy，再调用就抛了）。 */
    let destroyed = false;
    /* 单飞闸门：同一时刻只允许一个请求在飞（不动 Rust 那边的全局 AI_CANCEL）。
       别的会话这时提交不静默丢、也不并行打断，进 queue 排队等它跑完。 */
    let inFlight = null;
    const queue = [];
    /* 切一次会话就多留一份 DOM，不回收就是一路涨内存。
       被回收的会话内容早就在 AIStore 里存着，切回来时按文件重建即可。 */
    const PANE_KEEP = 5;

    function makePane(id) {
      const pane = {
        id: id,
        state: newState(),
        msgs: h('div', { class: 'ai-msgs' }),
        turns: [],
        current: null,
        lastAsk: null,
        built: false
      };
      /* 右键菜单与「点路径就打开」必须绑在这个 pane 自己的容器上：
         只绑启动时那两个全局 msgs 的话，切过会话之后新容器里的路径就点不动了
         （entries.bind 内部按 scope.__aiEntriesBound 去重，重复绑不会叠加）。 */
      pane.msgs.addEventListener('contextmenu', onContextMenu);
      try { AIEntries.bind(pane.msgs, { onAsk: askAboutPath }); } catch (e) { /* 绑不上只少一个点击 */ }
      paneStore.appendChild(pane.msgs);
      panes.set(id, pane);
      return pane;
    }

    /* 这个 pane 是不是用户此刻正在看的那一个。activePane 还没设立
       （boot 之前、或调用方没走 newSession）时，谁在用 msgs 谁就是可见的，
       否则起手那几帧会把界面操作全当成「后台」跳过。
       destroy 之后没有任何东西是「可见」的：后台会话可能还在飞，
       它收尾时不该再去动已经拆掉的输入框与跟随器。 */
    function isVisible(pane) {
      if (destroyed) return false;
      if (!pane) return false;
      if (pane === activePane) return true;
      return !activePane && pane.msgs === msgs;
    }

    /* 模型 / 强度 / 权限是全局偏好，不是某个会话的私产：改了要落到每个 pane
       的 state 上。只写可见那一份的话，切回一个早就建好的会话时，它记着的
       还是启动时那套值 —— 「换了模型再点重试又用回旧模型」（bug2）就是这条
       在别人的会话里更隐蔽的版本。 */
    function eachPaneState(fn) {
      panes.forEach(function (p) { fn(p.state, p); });
      /* 还没建立任何 pane 时（boot 之前），只有那个占位 state 可写 */
      if (!activePane) fn(state, null);
    }

    /* 换视图：旧容器收回隐藏仓，新容器挂进滚动区；
       状态 / 回合刻度 / 跟随器全部换成这个 pane 的。
       界面永远只反映可见会话，后台会话的写入只碰它自己的 DOM。 */
    function activatePane(pane) {
      if (!pane) return;
      if (activePane && activePane !== pane) {
        if (activePane.msgs.parentNode) activePane.msgs.parentNode.removeChild(activePane.msgs);
        paneStore.appendChild(activePane.msgs);
      } else if (!activePane && msgs && msgs !== pane.msgs && msgs.parentNode) {
        /* 启动时那个占位容器不属于任何会话：第一次激活时把它摘掉，
           否则它会一直跟真正的内容并排留在滚动区里。 */
        msgs.parentNode.removeChild(msgs);
      }
      if (pane.msgs.parentNode) pane.msgs.parentNode.removeChild(pane.msgs);
      scroller.appendChild(pane.msgs);
      activePane = pane;
      state = pane.state;
      msgs = pane.msgs;
      turns = pane.turns;
      if (rail) rail.setTurns(pane.turns);
      rebuildFollow();
      setEmpty(!pane.msgs.children.length);
      toBottom.classList.remove('on');
      /* 输入框的「忙」跟着可见会话走：后台会话在跑不该锁住这里，
         可见会话在跑就得能停 —— 停止按钮停的永远是看得见的这一条。 */
      composer.setBusy(!!state.running, false);
      requestAnimationFrame(function () { paintActiveTurn(); });
      /* 可见会话变了，「运行中」高亮与「这是你正在看的那个」都得跟着变 */
      notifyBusy();
    }

    /* 跟随器盯的是「某个容器 + 某个滚动条」：换了会话就换了容器，
       复用旧实例等于让它盯一个已经不在视口里的节点。 */
    function rebuildFollow() {
      if (follow) { try { follow.destroy(); } catch (e) { /* 旧的收不掉也要换成新的 */ } }
      follow = root.AIFollow ? root.AIFollow.create({
        scroller: scroller,
        content: msgs,
        onChange: function (s) { toBottom.classList.toggle('on', !s.following); }
      }) : null;
      if (follow) follow.resume();
    }

    /* 别的会话在飞时提交：排队 + 在该会话里留一条看得见的提示。
       以前这里是静默 return，用户点了发送却什么都没发生（bug1 的另一半）。 */
    function enqueueTurn(pane, payload) {
      const node = h('div', { class: 'ai-notice info' },
        T('上一个会话还在跑，这条已排队，跑完自动发',
          'Another conversation is still running — queued, will send when it finishes'));
      pane.msgs.appendChild(node);
      scrollEnd(false, pane);
      queue.push({ pane: pane, payload: payload, node: node });
      notifyBusy();
    }

    /* 出队：一次只起一条，它收尾时再调回这里，天然串行 */
    function pumpQueue() {
      if (inFlight) return;
      while (queue.length) {
        const item = queue.shift();
        if (item.node && item.node.parentNode) item.node.remove();
        if (!item.pane || !panes.has(item.pane.id)) continue;   // 会话已经没了：这条不再有意义
        ask(item.payload, item.pane);
        notifyBusy();
        return;
      }
      notifyBusy();
    }

    /* 让出单飞位：清标记 + 立刻看队列 */
    function releaseFlight() {
      inFlight = null;
      pumpQueue();
      /* pumpQueue 里已经发过一次通知，这里再发一次是为了覆盖
         「队列空、单纯这一轮跑完」的常见情况（那时上面那条 return 走不到） */
      notifyBusy();
    }

    function prunePanes() {
      if (panes.size <= PANE_KEEP) return;
      panes.forEach(function (p, id) {
        if (panes.size <= PANE_KEEP) return;
        if (!id || p === activePane || p.state.running) return;
        if (inFlight && inFlight.pane === p) return;
        if (queue.some(function (q) { return q.pane === p; })) return;
        if (p.msgs.parentNode) p.msgs.parentNode.removeChild(p.msgs);
        panes.delete(id);
      });
    }

    /* 回合导航：一条刻度 = 一轮（用户一句话 + 它的回答）。窄窗或只有一轮时自己隐藏。 */
    let turns = [];
    const rail = root.AITurnRail ? root.AITurnRail.create({
      host: shell,
      onNavigate: function (i) { jumpToTurn(i); }
    }) : null;

    /* 视角跟随：贴底就跟，读者一往上翻就撒手，出现「回到底部」。
       必须 let：跟随器绑的是「某个容器 + 某个滚动条」，换会话就整个重建
       （见 rebuildFollow），继续复用旧实例等于让它盯一个不在视口里的节点。 */
    let follow = root.AIFollow ? root.AIFollow.create({
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

    /* 一个会话的全部私有状态。以前只有一份，切会话就把它整份覆盖掉，
       于是「跑完往哪儿写」取决于切没切走 —— 这是结果落错地方的一半原因。
       现在每个 pane 各持一份，在飞那一轮拿着自己的 st 一直写到底。 */
    function newState() {
      return {
        running: false,
        token: { stopped: false },
        session: null,
        history: [],
        lastResult: null,
        /* 老版本存的是 simple / medium / deep，迁到 off/low/medium/high，
           别让一次升级把用户选好的档位清成默认 */
        thinking: Strength.migrateLevel(ui.thinking),
        permission: ui.permission || 'standard',
        model: ui.model || ''
      };
    }

    /* 永远指向当前可见 pane 的 state：界面层（底栏、输入框、停止键）只读它 */
    let state = newState();

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
        /* 停止只停看得见的那个会话。后台会话在飞时这里不该被按到
           （输入框的忙态跟着可见会话走），万一按到也只作用于可见的那个，
           绝不能顺手把别人的任务停掉。 */
        const pane = activePane;
        if (!pane || !pane.state.running) return;
        const st = pane.state;
        st.token.stopped = true;
        /* 旗标只让环路在下一步前收手；在飞的这次请求要靠 onStop 立刻结束，
           Rust 侧 ai_cancel 再去断连接——两边都做，才不用等接口自己超时。 */
        try { if (typeof st.token.onStop === 'function') st.token.onStop(); } catch (e) { /* 收尾失败也要停 */ }
        try { if (window.API && window.API.aiCancel) window.API.aiCancel(); } catch (e) { /* 断连失败不影响界面 */ }
        composer.setBusy(true, true);
      },
      onThinkingChange: (v) => {
        /* 强度是全局偏好：每个 pane 的 state 都要跟上。
           只写可见那份的话，切到一个旧会话时它还记着启动时的档位，
           那一轮就会按旧档位跑（用户的感受是「我明明调高了，它没变」）。 */
        eachPaneState(function (st) { st.thinking = v; });
        rememberUi({ thinking: v });
      },
      onPermissionChange: (p) => {
        eachPaneState(function (st) { st.permission = p; });
        rememberUi({ permission: p });
      },
      onModelChange: (id) => {
        /* 换模型就换窗口：每个模型的上下文长度是各自的能力，不共用上一个的。
           端点没报过这个模型的值时，按模型名推断（1M / 200K / 128K…），不留空。 */
        const w = ctxWindowOf({ model: id });
        eachPaneState(function (st) {
          st.model = id;
          st.ctxWindow = w;
        });
        rememberUi({ model: id });
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

    /* 贴底只对「看得见的那个会话」有意义：后台会话的写入不该把视图拽下去。
       传了 pane 就是替某个 pane 判断，没传就当操作的是可见会话。 */
    function scrollEnd(force, pane) {
      if (pane && !isVisible(pane)) return;
      /* 贴底跟随交给 AIFollow 判断；这里只做「已经在底部」时的即时贴底 */
      if (follow) {
        if (follow.isFollowing() || force) follow.toBottom(force ? 'instant' : 'instant');
        return;
      }
      const gap = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      if (!force && gap > 80) return;
      scroller.scrollTop = scroller.scrollHeight;
    }

    /* 配置变了就同步胶囊与菜单：模型是单一真值，不在菜单里编造。
       模型是全局配置（不是每个会话各一份），但每一轮跑在哪个会话里就写哪个会话的
       state：后台会话没法去改用户此刻看到的胶囊，只把自己的取值记住等切回来。 */
    function applyModels(settings, pane) {
      const tgt = pane || activePane;
      const st = tgt ? tgt.state : state;
      const list = realModels(settings);
      /* destroy 之后输入框已经拆掉了：后台会话这时才收尾时不该再去碰它，
         否则 setModels 会去操作已经 destroy 掉的 morph 而抛错 */
      if (!destroyed) composer.setModels(list);
      if (list.length) {
        /* 上次在菜单里选的那个模型优先：它在清单里就沿用它，
           不在（端点换了、模型下线了）才退回设置里配的第一个。 */
        const want = ui.model && list.some(function (m) { return m.id === ui.model; }) ? ui.model : list[0].id;
        st.model = want;
        if (!destroyed && (!pane || isVisible(tgt))) composer.setModel(want);
      } else {
        st.model = '';
      }
      /* 上下文占用环的分母是模型真窗口，不是写死的 8000 */
      st.ctxWindow = ctxWindowOf(settings);
      /* 底栏只反映看得见的那个会话：后台会话的 token 不该跳到用户眼前 */
      if (!destroyed && (!pane || isVisible(tgt))) {
        composer.setUsage({ used: st.usedTokens || 0, budget: st.ctxWindow });
        /* 滑块刻度标的是「思考预算」，不是查证轮数：
           轮数是防守用的硬上限，写出来只会让人以为「少查几轮 = 更省钱」 */
        composer.setThinkBudgets(thinkBudgets(), st.ctxWindow);
      }
      return list;
    }

    /* 四档滑块的刻度文字：思考预算（token），0 就直说「不思考」 */
    function thinkBudgets() {
      return Strength.stops().map(function (s) {
        return {
          id: s.id,
          steps: s.steps,
          budget: s.think,
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

    function pendingCards(where) {
      syncCards(where);
    }

    /* 整页和抽屉共用一份队列，因此这里不能只往自己这边追加新卡：
       别的视图已经处理掉的，这边也要跟着换成「已执行 / 已取消」。
       卡片长在「提出它的那个会话」里：后台会话在飞时提出来的卡片
       不能插到用户正在看的另一个会话里（那是错位的上下文）。 */
    function syncCards(where) {
      if (!proposals) return;
      /* 卡片归谁：调用方点名最准；没点名时看「谁在飞」——单飞闸门保证同一时刻
         只有一个会话在跑，那么新提出来的卡片必然属于它。以前的兜底是 activePane，
         于是后台会话提出来的卡片会插进用户正在看的另一个会话里（上下文错位），
         而 onEvent 随后再调 pendingCards(pane) 时卡片已经在错的地方登记过了。 */
      const owner = inFlight && inFlight.pane && panes.has(inFlight.pane.id) ? inFlight.pane : null;
      const pane = where || owner || activePane || { msgs: msgs, turns: turns };
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
        const near = isVisible(pane)
          && (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 400);
        const node = proposalCard(p, pane);
        node._pane = pane;
        cardNodes.set(p.id, node);
        pane.msgs.appendChild(node);
        if (near) requestAnimationFrame(() => scrollEnd(true));
      });
      cardNodes.forEach((node, id) => {
        if (ids.has(id)) return;
        if (node.dataset.status === 'pending' && node._repaint) node._repaint();
      });
    }

    /* 换会话时只清这个会话上挂着的卡片映射：别的会话的卡片还在它自己的
       DOM 里，把整张表 clear 掉会让那些卡再也接不上后续状态变化。 */
    function clearCards(pane) {
      cardNodes.forEach(function (node, id) {
        if (!pane || node._pane === pane) cardNodes.delete(id);
      });
    }

    function proposalCard(p, pane) {
      const host = h('div', { class: 'ai-msg bot ai-prop' });
      /* 卡片记着自己长在哪个会话：点「执行 / 撤销」之后的提示、记录、重绘
         都必须落回那个会话，不能落到用户此刻在看的另一个会话里。 */
      host._pane = pane || activePane;
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
              if (!r.ok) addNotice(r.error || '撤销失败', 'warn', host._pane);
              else { markActUndone(p.action, host._pane); syncCards(host._pane); }
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
            addNotice(T('一项都没勾，什么也没做', 'nothing checked'), 'warn', host._pane);
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
            }, host._pane);
            paint();
            try {
              window.dispatchEvent(new CustomEvent('ai-action', { detail: { action: p.action, ok: true } }));
            } catch (e) { /* 页面没监听就算了 */ }
          } else {
            /* 失败原因要留在卡片上：过期、预算超了、路径被拦，都各有各的话 */
            addNotice(r.error || T('执行失败', 'Run failed'), 'warn', host._pane);
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

    /* 写进某个会话的消息区。所有「这一轮产出」都走这里：
       传 pane 就写那个 pane 自己的容器，不传就是可见会话。
       以前一律写全局 msgs，切走之后写进的是已经脱离文档的节点。 */
    function addUser(text, pane) {
      const tgt = pane || activePane;
      if (!tgt) return;
      if (isVisible(tgt)) setEmpty(false);
      /* 不挂「你」的标签：右侧浅底气泡本身已经说明了是谁在说 */
      const node = h('div', { class: 'ai-msg user' },
        h('div', { class: 'ai-msg-body' }, text)
      );
      tgt.msgs.appendChild(node);
      /* 每句话开一轮：导航条上一条刻度，跳转就落到这句话 */
      tgt.turns.push({ prompt: text, answer: '', userNode: node, answerNode: null });
      stamp(node, 'user', text);
      /* 刻度条只有一条：只在看得见那个会话变化时重画 */
      if (rail && isVisible(tgt)) rail.setTurns(tgt.turns);
      scrollEnd(true, tgt);
    }

    /* 在飞那一轮的活动对象。现在它自带 pane 与「那一轮的回合对象」：
       以前靠 turns[turns.length-1] 反查回合，一换会话就会指到别的会话的最后一轮。
       单飞闸门保证全局同时只有一个正在回答的轮次。 */
    let current = null;

    /* 清空回合：换会话/新会话时必须连刻度一起清，
       否则右边会留着上一段对话的刻度，悬停还能看到上一轮的提问。 */
    function resetTurns(pane) {
      const tgt = pane || activePane;
      if (!tgt) return;
      tgt.turns.length = 0;
      if (rail && isVisible(tgt)) rail.setTurns([]);
      if (isVisible(tgt)) {
        if (follow) follow.resume();
        if (toBottom) toBottom.classList.remove('on');
      }
    }

    /* 查证过程组（procs.js）：折叠时只有一行「执行 N 次思考，调用 M 次工具，记录 K 条」，
       展开是平铺的过程行；跑到一半摊开，落定折回一行，点一下可再摊开。
       口径照 dsh-claude-style 的 Process rows，颜色与字号用本项目的 token。 */
    function startAnswer(opts, pane) {
      const tgt = pane || activePane;
      if (!tgt) return null;
      const replay = !!(opts && opts.replay);
      /* 过程组的 onAppend 只在可见会话上滚动：后台会话不该把读的人拽到别处 */
      const pg = replay ? null : root.AIProcs.create({
        onAppend: function () { scrollEnd(false, tgt); }
      });
      if (pg) pg.open();
      const body = h('div', { class: 'ai-msg-body ai-answer' });
      const extra = h('div', { class: 'ai-extra' });
      const node = h('div', { class: 'ai-msg bot' },
        pg ? pg.el : null,
        body,
        extra
      );
      tgt.msgs.appendChild(node);
      scrollEnd(true, tgt);
      /* 回合对象直接存进来：不再反查 turns[turns.length-1]，
         否则切会话后这个回合就归别人了 */
      const turn = tgt.turns[tgt.turns.length - 1] || null;
      const c = { pane: tgt, turn: turn, node: node, pg: pg, body: body, extra: extra, steps: [], replay: replay, stopped: false };
      tgt.current = c;
      current = c;
      stamp(node, 'bot', '');
      if (turn) turn.answerNode = node;
      return c;
    }

    function pushStep(step, pane) {
      const c = pane ? pane.current : current;
      if (!c || !c.pg) return;
      c.steps.push(step);
      /* 思考原文已经由流式片段边收边挂在「思考」行上，这里只补工具行，
         不再把 ev.thought 重放一遍——否则同一段推理会出现两次。 */
      c.pg.addStep({
        tool: step.tool,
        label: step.label,
        args: step.args,
        summary: step.summary,
        error: step.error,
        ms: step.ms,
        ok: step.ok,
        result: step.result
      });
      scrollEnd(false, c.pane);
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

    /* 从回答里抠出 YAML 草稿：优先 ```yaml 围栏，其次唯一一个 ``` 围栏。
       只认「整段就是规则」的形状——多个围栏里挑含 rules: 的那个，
       挑不出来就返回空，宁可不给按钮也不塞半截规则进编辑器。 */
    function draftYaml(text) {
      const s = String(text || '');
      const blocks = [];
      const re = /```([A-Za-z0-9_+-]*)[^\n]*\n([\s\S]*?)```/g;
      let m;
      while ((m = re.exec(s))) {
        blocks.push({ lang: (m[1] || '').toLowerCase(), body: m[2] });
      }
      if (!blocks.length) {
        /* 模型偶尔不写围栏，直接给一段以 rules: 开头的正文 */
        const bare = s.match(/^\s*rules:\s*\n[\s\S]*$/m);
        return bare ? bare[0].trim() : '';
      }
      const yamlish = blocks.filter((b) => b.lang === 'yaml' || b.lang === 'yml');
      const pool = yamlish.length ? yamlish : blocks;
      const withRules = pool.filter((b) => /^\s*rules\s*:/m.test(b.body));
      const pick = withRules.length ? withRules[0] : (pool.length === 1 ? pool[0] : null);
      return pick ? pick.body.trim() : '';
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
       以前这些只在内存活 10 分钟，关掉就再也找不到「我当时清了什么」。
       记录属于会话，写的时候必须认 pane —— state 是「可见会话」这个游标，
       后台会话收尾时它早就指到别处了。 */
    function recordAct(entry, pane) {
      const tgt = pane || activePane;
      const st = tgt ? tgt.state : state;
      if (!st.session || !entry) return;
      const acts = st.session.acts || (st.session.acts = []);
      acts.push(entry);
      if (acts.length > 40) st.session.acts = acts.slice(-40);
      try { AIStore.saveSession(st.session); } catch (e) { /* 落盘失败不打断对话 */ }
      refreshActs(tgt);
    }

    function markActUndone(action, pane) {
      const tgt = pane || activePane;
      const st = tgt ? tgt.state : state;
      if (!st.session) return;
      const acts = st.session.acts || [];
      for (let i = acts.length - 1; i >= 0; i--) {
        if (!acts[i].undone && acts[i].action === action) {
          acts[i].undone = true;
          try { AIStore.saveSession(st.session); } catch (e) { /* 同上 */ }
          refreshActs(tgt);
          return;
        }
      }
    }

    /* 执行记录挂在会话末尾。执行/撤销后要就地刷新——否则「我刚清掉的东西」
       要等下次打开会话才看得到，等于又回到「找不回入口」。
       卡片可能来自后台会话：卡的每一处重绘都带着它自己的 pane。 */
    function refreshActs(pane) {
      const tgt = pane || activePane;
      if (!tgt || !tgt.state.session) return;
      const old = tgt.msgs.querySelector('.ai-acts');
      if (old) old.remove();
      const node = actsBar(tgt.state.session.acts);
      if (node) {
        tgt.msgs.appendChild(node);
        scrollEnd(false, tgt);
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

    /* 收尾一律认 pane：后台会话跑完之后 state 早就指向用户当前看的会话了，
       这里要是按 state / 全局 current 落笔，结果就会写进别人的会话。 */
    function finishAnswer(res, pane) {
      const tgt = pane || (current && current.pane) || activePane;
      if (!tgt) return;
      let c = tgt.current || null;
      if (!c) c = startAnswer(null, tgt);
      if (!c) return;
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

      /* 回答里带了规则草稿就给一个「填入规则编辑器」：
         草稿只进编辑器，不落盘、不执行——写盘这件事留给人按保存。
         规则页没开过时 AIRulesDraft 不存在，那就不给按钮，免得点了没反应。 */
      const yaml = draftYaml(res.answer || '');
      if (yaml && root.AIRulesDraft && root.AIRulesDraft.fill) {
        const draftBar = h('div', { class: 'ai-msg-bar' });
        draftBar.appendChild(h('button', {
          class: 'btn sm ghost',
          onclick: () => {
            if (!root.AIRulesDraft.fill(yaml)) return;
            /* 抽屉里点的：填完就把抽屉收掉，让用户直接看到编辑器；
               整页里点的：直接切到规则页。两条路都落不到「点了像没反应」。 */
            if (root.AIDrawer && root.AIDrawer.isOpen && root.AIDrawer.isOpen()) {
              root.AIDrawer.close();
            }
            navigateTo('rules');
          }
        }, UIx.icon('spark', 12), T('填入规则编辑器', 'Send to rule editor')));
        draftBar.appendChild(h('span', { class: 'small muted' },
          T('只填入，不保存、不执行', 'Loads only — no save, no run')));
        c.extra.appendChild(draftBar);
      }

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
      /* 停了不是废掉：断点已经在手，接着查比重新问一遍省一整轮。
         503 / 网络抖动的失败同样有断点（agent 现在一定给 checkpoint），
         不给「继续」的话用户只能把问题重打一遍，那就是「没有上下文记忆」。 */
      if (res.checkpoint && !res.replay) {
        bar.appendChild(h('button', {
          class: 'btn sm ghost',
          onclick: () => { continueTurn(tgt); }
        }, T('继续', 'Continue')));
      }
      /* 历史回放没有 lastAsk，「重试」会是个点不动的按钮——那种不如不给。
         额度用完（quota）也一样：点了必然失败，给按钮等于骗人。 */
      if (!res.replay && !res.quota) {
        bar.appendChild(h('button', {
          class: 'btn sm ghost',
          onclick: () => { retryLast(tgt); }
        }, T('重试', 'Retry')));
      }
      if (res.usage) {
        /* 这一轮实际用的强度与温度：放在正文外面（界面里），
           不写进回答正文——正文里塞元信息只会让答案变脏 */
        if (res.policy) {
          bar.appendChild(h('span', {
            class: 'ai-policy',
            title: T('强度管努力（思考预算 / 查证轮数），温度管随机性（由任务决定）', 'Level controls effort; temperature controls variety (chosen by task)')
          }, Strength.line(res.policy)));
        }
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
        const st = Strength.thinkEstimate(res.policy, u);
        if (st && st.tokens) {
          const text = (st.estimated ? T('约', '~') : '') + st.tokens + T(' 思考', ' thinking');
          parts.push(st.budget ? text + '/' + st.budget : text);
        }
        if (parts.length) bar.appendChild(h('span', { class: 'ai-usage', title: usageTitle(st) }, parts.join(' · ')));
      }
      /* 刻度条的悬停预览要读这一轮的答案和用量：答案本来只进 DOM，
         这里回存到回合对象上，预览就不必去扒正文节点。
         回合对象在这一轮开始时就已经绑在 c 上，不再反查「最后一个回合」
         ——后台会话收尾时，那边的最后一个回合可能已经是别的了。 */
      const closed = c.turn;
      if (closed) {
        closed.answer = res.answer || '';
        if (res.usage) {
          const bits = [];
          if (res.usage.elapsed_ms) bits.push((res.usage.elapsed_ms / 1000).toFixed(1) + 's');
          const used = (Number(res.usage.prompt_tokens) || 0) + (Number(res.usage.completion_tokens) || 0);
          if (used) bits.push(used >= 1000 ? (used / 1000).toFixed(1) + 'k' : String(used));
          closed.meta = bits.join(' · ');
        }
        if (rail && isVisible(tgt)) rail.setTurns(tgt.turns);
      }
      c.extra.appendChild(bar);

      const chips = followChips(res.followUps, (q) => ask({ text: q }, tgt));
      if (chips) c.extra.appendChild(chips);
      /* 执行记录永远待在会话最末：新回答进来后把它挪下来，不然读起来像
         「先记了账、才发生的事」。 */
      refreshActs(tgt);
      scrollEnd(false, tgt);
      tgt.current = null;
      if (current === c) current = null;
    }

    /* 提示行也认 pane：后台会话的「已排队」提示必须落在它自己的消息区里，
       否则用户在新会话里看到一句不属于这里的话。 */
    function addNotice(message, level, pane) {
      const tgt = pane || activePane;
      if (!tgt) return;
      let c = tgt.current || null;
      if (!c) c = startAnswer(null, tgt);
      if (!c) return;
      c.extra.appendChild(h('div', { class: 'ai-notice ' + (level || 'info') }, message));
      scrollEnd(false, tgt);
    }

    /* ---------------- 运行 ---------------- */

    /* 以前这里有一个全局 lastAsk：谁最后提交就记谁，切会话后再点「重试」
       会把上一个会话的问题发到当前会话里。现在它是每个 pane 自己的
       pane.lastAsk（见 makePane），这里不再保存任何全局副本。 */

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

    /* 兜底：askInner 里任何一处抛错，都不能把界面留在「正在回答」上。
       卡死的机制很简单——running 一旦为 true 就再也没人置回 false，
       输入框保持只读、发送键停在停止态，于是「发不出」也「停不了」。
       正常跑完的轮次在收尾时已经置回 false，这里只收拾半途死掉的。
       注意这里收拾的是「这一轮所属的那个会话」，不是用户此刻在看的会话：
       后台会话炸掉时不该把可见会话的输入框解锁，也不该把错误写进别人的消息区。 */
    async function ask(input, pane) {
      try {
        return await askInner(input, pane);
      } catch (e) {
        const tgt = pane || (current && current.pane) || activePane;
        const st = tgt ? tgt.state : state;
        const midFlight = st.running;
        st.running = false;
        if (!tgt || isVisible(tgt)) {
          try { composer.setBusy(false, false); } catch (e2) { /* 输入框没造好也不能再抛 */ }
        }
        if (midFlight) {
          try {
            finishAnswer({
              ok: false,
              degraded: true,
              answer: (e && e.message) || T('这一轮没能跑起来', 'This turn failed to start'),
              evidence: [],
              suggest: [],
              followUps: [],
              trace: []
            }, tgt);
          } catch (e3) { /* 收尾失败不再往上抛，免得盖住原始错误 */ }
        }
        /* 炸掉也要让出单飞位，否则队列里排着的那几条永远等不到。
           只在「占着单飞位的就是这一轮」时才让：万一抛在还没占位之前，
           这时候把别人的位置放掉会让两个请求同时跑。 */
        if (inFlight && tgt && inFlight.pane === tgt) releaseFlight();
        return null;
      }
    }

    /* 一轮对话。所有状态都认「这一轮属于哪个会话」：
       入口把 st / pane 钉死，函数体里不再碰全局 state / msgs / turns。
       这样切走之后这一轮继续往它自己的会话里写，结果落回它自己的存档。 */
    async function askInner(input, fromPane) {
      const payload = (input && typeof input === 'object') ? input : { text: String(input || '') };
      const q = String(payload.text || '').trim();
      const resume = payload.resume || null;
      /* 还没有任何会话（boot 还没跑完、或者它失败过）时先补一个：
         空状态里的示例问题此刻点下去，以前会落到一个不存在的 pane 上被静默丢掉。 */
      let pane = fromPane || activePane;
      if (!pane) {
        startNewSession();
        pane = activePane;
      }
      if (!pane) return;
      const st = pane.state;
      /* 同一会话重复提交没有意义（上一轮还在跑），保持老行为直接丢；
         但如果已经有别的会话在飞，这一次不能静默丢掉——塞进队列并给出提示，
         否则用户点了发送什么都没发生（bug1 的另一半）。 */
      if (!q && !(payload.attachments || []).length) return;
      if (inFlight) {
        if (inFlight.pane === pane || st.running) return;
        enqueueTurn(pane, payload);
        return;
      }
      /* 单飞位是空的但它自己还标着 running：说明上一轮死在了半路（收尾没走到）。
         这时候重复提交没有意义，直接丢——跟以前 `|| state.running` 的行为一致，
         只是现在按会话判断，不会因为别的会话在跑就把这一条也丢掉。 */
      if (st.running) return;
      st.running = true;
      /* 占住单飞位：谁在飞、飞在哪个会话，收尾时靠它判断要不要出队 */
      inFlight = { pane: pane, st: st };
      pane.lastAsk = payload;
      /* 一开跑就告诉左栏「这条进入运行中」：用户此刻可能正要切去别的会话，
         不给标记的话切过去之后就没有任何地方能看出它还在跑 */
      notifyBusy();

      st.thinking = payload.thinking || st.thinking;
      st.permission = payload.permission || st.permission;

      const shown = q || T('（已附加 ', '(attached ') + (payload.attachments || []).length + T(' 个路径）', ' paths)');
      /* 继续不是新问题：用户那条消息已经在断点里，再插一条会重复 */
      if (!resume) addUser(q ? shown : shown, pane);

      st.token = { stopped: false };
      /* 忙态只锁得住看得见的那个会话：后台会话在跑不该让当前输入框发不出话 */
      if (isVisible(pane)) composer.setBusy(true, false);

      const settings = await AIStore.load();
      applyModels(settings, pane);
      try { await ensureGuard(); } catch (e) { /* 闸门没配好也不挡住只读问答 */ }
      if (!AIStore.isConfigured(settings)) {
        st.running = false;
        if (isVisible(pane)) composer.setBusy(false, false);
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
        }, pane);
        releaseFlight();
        return;
      }

      /* 这一轮到底用哪个模型：入口 payload 只代表「点发送那一刻」的选择，
         用户可能随后在胶囊里换了模型。取当前选择优先，别再让旧 payload
         单方面把当前模型压回去（bug2：切模型后点重试又跑回老模型）。 */
      const wantModel = payload.model || st.model || settings.model;
      if (wantModel) {
        st.model = wantModel;
        /* 胶囊只在看得见的会话上刷新；后台会话记住自己的取值即可 */
        if (isVisible(pane)) composer.setModel(wantModel);
      }

      /* 这一轮的策略先算出来：档位决定努力，任务决定温度。
         温度用 null 表示「这家锁死了」，agent 见到 null 就不发 temperature */
      const policy2 = policyFor(q, settings, st.thinking);
      const bud = budgetFor(policy2, settings);
      const policy = proposals ? proposals.getPolicy() : { mode: 'off' };
      const canWrite = policy.mode !== 'off';
      const allowed = PERM_TOOLS[st.permission] || PERM_TOOLS.standard;
      const allTools = AITools.makeTools({
        API: window.API,
        proposals: proposals,
        navigate: navigateTo,
        /* 工具跑到一半要说话时用这个（例如「正在后台建索引，约几秒」）。
           没有它，建索引那几秒界面上什么都不动，看起来就像卡死了。 */
        say: (text) => addNotice(text, 'info', pane)
      });
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
        /* 这一轮真正要跑的模型：和上面 wantModel 是同一个值，
           否则界面胶囊显示新模型、请求却还发去老模型（bug2 的另一处） */
        model: wantModel || settings.model,
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
      st.policy = policy2;

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
      ctx.permission = permLabel(st.permission);
      /* 上下文行里说清「这一轮多努力、温度多少、任务是什么」：
         模型据此调自己的行为，用户不用在正文里读到这些元信息 */
      ctx.thinking = Strength.LEVELS[policy2.level].label[0];
      ctx.temperature = policy2.temperature;
      ctx.tempSrc = { manual: T('手填', 'manual'), task: T('任务', 'task'), level: T('档位', 'level'), locked: T('模型固定', 'fixed') }[policy2.tempSrc] || '';
      ctx.task = policy2.taskLabel ? policy2.taskLabel[0] : '';
      ctx.canWrite = !!(tools.propose_action);

      startAnswer(null, pane);
      let res;
      try {
        res = await agent.run({
          userText: q || T('看看这些文件：', 'Look at these files: ') + (payload.attachments || []).join(', '),
          ctx: ctx,
          history: st.history,
          token: st.token,
          resume: resume,
          onEvent: (ev) => {
            /* 过程行一律写这一轮自己的 pane：切走之后 current 可能已经指向
               用户新会话里的另一轮，靠它落笔就把 A 的过程写进 B 了 */
            const c = pane.current;
            if (ev.type === 'step') {
              /* 等待行的措辞跟着阶段走：同一条「还在跑」，
                 说「正在查证」比说「正在思考」更接近用户此刻看到的事 */
              if (c && c.pg) c.pg.setRunning(true, T('正在查证', 'Checking'));
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
              }, pane);
              /* 提案一落地就把卡片摆出来：用户不用等模型把话说完了才看到 */
              if (ev.tool === 'propose_action' && ev.ok) pendingCards(pane);
            } else if (ev.type === 'thought') {
              if (c && c.pg) {
                /* 推理原文先挂在「思考」行上；下一步工具会把它折进过程组 */
                c.pg.setRunning(true, T('正在推理', 'Reasoning'));
                c.pg.addThought(ev.text);
              }
            } else if (ev.type === 'notice') {
              addNotice(ev.message, ev.level, pane);
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
          trace: [],
          /* 额度用完这类错误：告诉用户「等多久/换什么」，别给点了必然失败的重试 */
          quota: !!(e && e.quota)
        };
      }

      /* 这段回答按哪档强度、什么温度跑的：随结果一起带进 finishAnswer，
         用量行才能说清「思考预算用了多少 / 一共给了多少」 */
      if (res && !res.policy) res.policy = policy2;
      finishAnswer(res, pane);
      st.running = false;
      if (isVisible(pane)) composer.setBusy(false, false);
      st.lastResult = res;
      /* 收尾立刻同步一次运行态：左栏的「运行中」标记要跟着消失，
         不然它会一直挂着，用户以为还在跑 */
      notifyBusy();
      if (res.usage) {
        st.usedTokens = (res.usage.prompt_tokens || 0) + (res.usage.completion_tokens || 0);
        /* 底栏的用量环只反映看得见的会话：后台会话跑完不该把用户眼前这个圈跳一下 */
        if (isVisible(pane)) {
          composer.setUsage({
            used: st.usedTokens,
            budget: st.ctxWindow || ctxWindowOf(settings)
          });
        }
      }

      /* 历史里必须保留「这一轮查了什么」：只存答案正文的话，
         用户下一句说「继续」「那个 D 盘的呢」，模型完全不知道自己刚才做过什么，
         只能从头瞎猜 —— 这正是用户抱怨的「没有上下文记忆」。
         trace 摘要（不含完整 result）足够它想起自己查过哪儿、哪儿失败了。 */
      st.history.push({ role: 'user', content: q });
      st.history.push({
        role: 'assistant',
        content: res.answer || '',
        trace: (res.trace || []).map((t) => ({
          tool: t.tool, label: t.label, ok: t.ok, summary: t.summary, error: t.error
        })),
        ok: res.ok,
        status: res.status || ''
      });
      if (st.history.length > 40) st.history = st.history.slice(-40);
      if (st.session) {
        st.session.messages.push({ role: 'user', content: q, at: Date.now() });
        /* 回答不是一段文字就完：查证过程、依据、建议、可点入口一起落盘，
           否则回到历史里只剩一句「打开 D:\… 看看」，入口全丢了。 */
        st.session.messages.push({
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
          usage: res.usage || null,
          /* 断点跟着消息一起落盘：关掉再打开，那一轮还能「继续」，
             而不是把用户的问题当成新的重来一遍 */
          checkpoint: res.checkpoint || null,
          /* 强度/温度也落盘：回看时能看到「这条答案当时是多努力、多稳」，
             否则历史里只剩一段文字，看不出它是在什么设定下给的 */
          policy: res.policy ? {
            level: res.policy.level,
            temperature: res.policy.temperature,
            tempSrc: res.policy.tempSrc,
            task: res.policy.task,
            think: res.policy.think
          } : null
        });
        if (!st.session.title || st.session.title === '新会话') st.session.title = q.slice(0, 30);
        try { await AIStore.saveSession(st.session); } catch (e) { /* 落盘失败不打断对话 */ }
        /* 记住「正在聊的这个会话」：下次进 AI 页直接接着聊，
           而不是每次都开一个空白新会话。后台会话跑完不该改这条记忆——
           用户此刻正在看的是另一个会话。 */
        if (isVisible(pane)) rememberUi({ lastSession: st.session.id });
        notifySessions();
      }
      AIStore.logUsage({
        steps: res.usage ? res.usage.steps : 0,
        ms: res.usage ? res.usage.elapsed_ms : 0,
        prompt_tokens: res.usage ? res.usage.prompt_tokens : 0,
        completion_tokens: res.usage ? res.usage.completion_tokens : 0,
        ok: !!res.ok,
        degraded: !!res.degraded,
        /* 光记 ok/steps 等于没记：60% 的失败在日志里全是同一个长相，
           查不出是限流、欠费、密钥不认还是模型名写错。这四项是判据。 */
        code: res.code || '',
        model: res.model || '',
        endpoint: res.endpoint || '',
        protocol: res.protocol || '',
        switched: res.switched ? (res.switched.host + '/' + res.switched.model) : '',
        exhausted: !!res.exhausted,
        stopped: !!res.stopped
      });
      /* 这一轮彻底收尾：让出单飞位，队列里排着的下一条这时才起跑。
         放在最末而不是 finishAnswer 里，是因为调用方还要读 res 落盘：
         提前出队会让下一轮立刻改写 st.lastResult / st.session。 */
      releaseFlight();
    }

    /* 重试：payload 里冻着「当初点发送那一刻」的模型名，
       直接用会把用户在胶囊里换过的新模型覆盖回老模型（bug2）。
       这里只拿 payload 当底稿，模型取当前选择。 */
    function retryLast(pane) {
      const tgt = pane || activePane;
      if (!tgt || !tgt.lastAsk) return;
      const st = tgt.state;
      if (st.running || (inFlight && inFlight.pane === tgt)) return;
      const p = Object.assign({}, tgt.lastAsk, { model: st.model || tgt.lastAsk.model });
      ask(p, tgt);
    }

    /* 从断点接着跑：不重发已经查过的工具，也不重复插用户消息。
       模型同样取当前选择，不沿用断点里那句旧 payload 的模型。 */
    function continueTurn(pane) {
      const tgt = pane || activePane;
      if (!tgt) return;
      const st = tgt.state;
      const res = st.lastResult;
      if (!res || !res.checkpoint) return;
      if (st.running || (inFlight && inFlight.pane === tgt)) return;
      const base = tgt.lastAsk || { text: '' };
      ask(Object.assign({}, base, {
        resume: res.checkpoint,
        model: st.model || base.model
      }), tgt);
    }

    /* 会话列表变了（新建 / 落盘 / 载入）就让外面重画右侧的归档列表。
       多播：整页与抽屉都要跟着刷新，而它们不会同时是「当前宿主」——
       换宿主时这里注册的仍是那一批（attach 负责整体替换）。 */
    function notifySessions() {
      sessionSubs.forEach(function (fn) {
        try { fn(); } catch (e) { /* 外面的重画失败不该影响对话 */ }
      });
    }

    /* 「谁在跑」变了就告诉外面。
       后台会话在跑的时候界面上原本一点痕迹都没有（切走就看不见了），
       用户只能凭空猜「刚才那条到底跑完没有」。这里把运行集合推给页面，
       由左栏 / 抽屉头部画成一排「运行中」，点一下就切回去看。 */
    function notifyBusy() {
      const snap = activity();
      busySubs.forEach(function (fn) {
        try { fn(snap); } catch (e) { /* 画不出来不该影响对话本身 */ }
      });
    }

    /* 运行态快照：给页面用的最小信息集（不把 DOM / state 漏出去）。
       queued 是这个会话自己排着几条，running 是它此刻有没有在飞。 */
    function activity() {
      const items = [];
      panes.forEach(function (p) {
        if (!p.id) return;
        const queued = queue.filter(function (q) { return q.pane === p; }).length;
        const running = !!(p.state && p.state.running);
        if (!running && !queued) return;
        const s = p.state && p.state.session;
        items.push({
          id: p.id,
          title: (s && s.title) || T('新会话', 'New chat'),
          running: running,
          queued: queued,
          visible: p === activePane
        });
      });
      /* 在飞的排前面，其余按排队量：一眼看到的该是真正在干活的那条 */
      items.sort(function (a, b) {
        if (a.running !== b.running) return a.running ? -1 : 1;
        return b.queued - a.queued;
      });
      return {
        items: items,
        active: activePane ? activePane.id : '',
        busy: !!inFlight
      };
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

      /* 空白处：只给「粘贴」和「全选对话」。
         这里不能直接读全局 msgs：右键可能是从某个 pane 的容器冒泡上来的，
         读全局会把「另一个会话的对话」复制出去。以事件实际落在哪个容器为准。 */
      const scope = t.closest('.ai-msgs') || msgs;
      UI.menu(e, [
        { label: T('粘贴到输入框', 'Paste into composer'), action: pasteIntoComposer },
        { label: T('复制整段对话', 'Copy transcript'), disabled: !scope.children.length,
          action: () => writeClipboard(Array.prototype.map.call(scope.children,
            (n) => ((n.dataset.role === 'user' ? '我：' : '助手：') + (n.dataset.text || textOf(n)))).join('\n\n')) }
      ]);
    }

    msgs.addEventListener('contextmenu', onContextMenu);
    /* 回答正文里的路径与链接统一由 AIEntries 接管：
       点路径 = 打开那个位置，点外链 = 交给系统浏览器（WebView2 里
       target="_blank" 没有窗口处理器，点了什么都不会发生）。
       这一份是给启动容器绑的；每个 pane 自己的容器在 makePane 里各绑一次。 */
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
        eachPaneState(function (st) { st.thinking = prefs.thinking; });
        composer.setThinking(prefs.thinking);
      }
      if (prefs.permission) {
        eachPaneState(function (st) { st.permission = prefs.permission; });
        composer.setPermission(prefs.permission);
      }
    }).catch(() => {});
    AIStore.load().then((s) => {
      applyModels(s);
    }).catch(() => {});

    /* 取某个会话的 pane：开过就复用。复用是这套机制的关键——
       切回一个还在后台跑的会话，要看到它已经写出来的内容，
       而不是把存档重放一遍（重放会把在飞的节点顶掉）。 */
    function paneForSession(session) {
      if (!session || !session.id) return null;
      const id = String(session.id);
      const had = panes.get(id);
      if (had) {
        /* 只在它还没有会话对象时补上：复用中的 pane 手里那份才是活的
           （在飞那一轮正往它里面追加消息），拿磁盘读回来的旧副本顶掉，
           下一次落盘就会把这轮刚问的那句话写没了。 */
        if (!had.state.session) had.state.session = session;
        return had;
      }
      const pane = makePane(id);
      pane.state.session = session;
      return pane;
    }

    /* 把一个会话的历史铺进它的 pane。只在「这个 pane 还没铺过」时调用：
       铺过之后再进来，DOM 里就是真实跑出来的内容，比存档更全（可能还在跑）。 */
    function replaySessionInto(pane, session) {
      if (!pane || !session) return;
      const st = pane.state;
      resetTurns(pane);
      pane.msgs.innerHTML = '';
      /* 卡片映射按会话清：别的会话的卡片还在它自己的 DOM 里，
         整表 clear 会让那些卡再也接不上后续状态变化。 */
      clearCards(pane);
      /* 会话里存过的提案不再重放成可点卡片：过期的东西点了只会失败。
         执行过的动作另有一条「执行记录」，那才是事后要回看的东西。 */
      if (proposals) proposals.newSession();
      st.session = session;
      st.history = [];
      pane.lastAsk = null;
      (session.messages || []).forEach(function (m) {
        if (m.role === 'user') {
          addUser(m.content, pane);
          st.history.push({ role: 'user', content: m.content });
          return;
        }
        const c = startAnswer({ replay: true }, pane);
        if (!c) return;
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
          policy: m.policy || null,
          status: m.status || '',
          counts: m.counts || null,
          /* 断点也要从文件里恢复：重启软件后点「继续」还能接着上次那一步查，
             否则中断就真的等于丢掉了 —— 用户看到的就是「它忘了自己做过什么」。 */
          checkpoint: m.checkpoint || null,
          interrupted: false
        }, pane);
        st.history.push({
          role: 'assistant',
          content: m.content,
          trace: m.trace || [],
          ok: m.ok,
          status: m.status || ''
        });
      });
      /* 最后一条回答的 checkpoint / 用量等要能撑起「继续」与「重试」：
         startAnswer/finishAnswer 已经把 st.lastResult 写过，这里只补「回放完了」 */
      pane.built = true;
      refreshActs(pane);
      setEmpty(!pane.msgs.children.length && isVisible(pane));
      prunePanes();
    }

    /* 造一个新的空会话并把它变成当前会话。切走不打断在飞的那一轮：
       旧 pane 连同它的任务一起留在 paneStore 里继续跑，结果落回它自己的会话。 */
    function startNewSession() {
      const session = {
        id: Date.now().toString(36),
        title: '新会话',
        created: Date.now(),
        messages: []
      };
      const pane = makePane(session.id);
      pane.state.session = session;
      pane.state.history = [];
      pane.state.lastResult = null;
      pane.state.token = { stopped: false };
      /* 新会话清空提案队列：上一个会话没确认的动作不能跨会话留着，
         否则「我上次好像点过什么」就成了猜谜。配额也从零开始。 */
      if (proposals) proposals.newSession();
      activatePane(pane);
      renderEmpty();
      setEmpty(true);
      prunePanes();
      notifySessions();
      return pane;
    }

    /* 换宿主时同步「紧凑」外观。
       shell 上的 compact 类由这里管；输入框那层是 composer.js 在 create 时
       一次性拼进 wrap 的类名（`dac` + `dac-compact`），它没有对外暴露
       setCompact，所以直接改 composer.el 的 classList —— composer.el 就是
       那个 .dac 外壳本身（composer.js 的 api.el = wrap），改它不会碰内部结构。 */
    function syncCompact() {
      shell.classList.toggle('compact', compact);
      try {
        if (composer && composer.el && composer.el.classList) {
          composer.el.classList.toggle('dac-compact', compact);
        }
      } catch (e) { /* 输入框已经拆掉时换宿主：少一个类不影响能用 */ }
    }

    /* 把界面挂到一个新宿主上。
       应用级只有一个现场（panes / queue / inFlight / 历史 / 运行态），
       整页和抽屉轮流「借用」同一份界面：谁需要就把 shell 搬进自己容器。
       两个实例的旧做法会让「单飞位」变成两份，而 Rust 侧的 AI_CANCEL
       是全局单一标志位（main.rs 的 static AI_CANCEL）——两条并行时点任意
       一个「停止」会互相打断。这是硬约束，所以现场必须唯一。 */
    function attach(rootEl, opts) {
      if (!rootEl) return;
      const o = opts || {};
      /* 上下文跟着宿主换：抽屉的「这个目录」和整页的「这一页」不是一回事 */
      if (typeof o.ctx === 'function') ctxProvider = o.ctx;
      compact = !!o.compact;
      syncCompact();
      /* 订阅者整体换一批：同一时刻只有一个宿主在用，
         清空重加比按宿主标记增删更简单，也不会漏掉注销（旧的抽屉回调
         继续收通知只会往已经 remove 掉的 DOM 上画）。 */
      sessionSubs.length = 0;
      busySubs.length = 0;
      if (typeof o.onSessions === 'function') sessionSubs.push(o.onSessions);
      if (typeof o.onBusy === 'function') busySubs.push(o.onBusy);
      /* 从停靠点（或上一个宿主）搬过来。先摘再挂：
         一个节点同时挂在两处是不可能的，不摘就是「静默不动」。 */
      if (shell.parentNode !== rootEl) {
        if (shell.parentNode) shell.parentNode.removeChild(shell);
        rootEl.appendChild(shell);
      }
      /* 停靠容器在 shell 搬走之后就是个空壳，留着只会一路堆在 body 上 */
      if (parked) {
        if (parked.parentNode) parked.parentNode.removeChild(parked);
        parked = null;
      }
      /* 重新挂上就复活：后台那一轮收尾时会问 isVisible，立过 destroyed 牌子
         它就不再往界面写了——抽屉关一次再打开，等于那一轮白跑。 */
      destroyed = false;
      /* 空状态文案按新宿主的宽度重画（compact 的示例问题只有两条） */
      renderEmpty();
      setEmpty(!(msgs && msgs.children.length));
      /* 跟随器盯的是「容器 + 滚动条」：shell 换过位置，旧的观测对象
         可能已经脱离文档，重建一次比修它便宜也可靠。 */
      rebuildFollow();
      /* 模型清单要跟着重拉一次：宿主的上下文可能换了端点（抽屉在别的页面打开） */
      Promise.resolve().then(function () { return AIStore.load(); }).then(function (s) {
        applyModels(s);
      }).catch(function () { /* 读不到就沿用上一份清单，不挡对话 */ });
      notifyBusy();
      notifySessions();
    }

    /* 把界面从宿主上摘下来，但现场一个字节都不清。
       抽屉关掉不等于这一轮结束：agent.run 没被打断，它收尾时还要往
       pane.msgs 里写。所以 shell 停靠到一个隐藏容器里（仍在文档中），
       而不是 remove() 掉——节点脱离文档后 follow 的 ResizeObserver 不再
       回调、写出来的内容也没人看得见，用户只能重开抽屉从历史里重读。
       以前这里走的是 destroy()：inFlight = null、queue 清空、panes 删 DOM，
       在飞那一轮回来时 pane 已经没了，界面接不回来。 */
    function detach() {
      if (parked && parked.parentNode) parked.parentNode.removeChild(parked);
      parked = h('div', { class: 'ai-parked' });
      parked.hidden = true;
      document.body.appendChild(parked);
      if (shell.parentNode) shell.parentNode.removeChild(shell);
      parked.appendChild(shell);
      /* 不动 destroyed / panes / queue / inFlight：后台继续跑，
         下一轮写入照样落进它自己的 pane。 */
    }

    return {
      ask,
      retry: retryLast,
      composer,
      /* 换宿主 / 摘界面：整页与抽屉共用同一个现场靠这两个 */
      attach: attach,
      detach: detach,
      /* 运行态快照：页面用它画「哪些会话还在跑」，点一下切回去看。
         返回的是拷贝，页面改它不会影响对话内部状态。 */
      activity: activity,
      /* 只清「看得见的那个会话」，别的会话连同它们还在跑的任务一起留着。
         抽屉关掉时才由 destroy() 统一收走。 */
      clear() {
        const tgt = activePane;
        if (tgt) {
          resetTurns(tgt);
          tgt.msgs.innerHTML = '';
          clearCards(tgt);
          tgt.state.history = [];
          tgt.state.session = null;
          tgt.state.lastResult = null;
          tgt.built = false;
        }
        if (proposals) proposals.newSession();
        renderEmpty();
        setEmpty(true);
      },
      /* 切会话 = 换视图，不打断在飞的任何东西。
         已经铺过内容的 pane 直接复用：上面可能正有一轮在写，
         重放存档会把在飞的节点顶掉（bug1 的另一半）。 */
      loadSession(session) {
        if (!session || !session.id) return;
        const pane = paneForSession(session);
        if (!pane) return;
        /* 新会话清空提案队列：过期的东西点了只会失败，
           执行过的动作另有一条「执行记录」，那才是事后要回看的东西。 */
        if (!pane.built) replaySessionInto(pane, session);
        if (proposals) proposals.newSession();
        activatePane(pane);
        if (pane.built) {
          refreshActs(pane);
          setEmpty(!pane.msgs.children.length);
          scrollEnd(true, pane);
        }
        notifySessions();
      },
      newSession() {
        startNewSession();
      },
      /* 删除后如果是当前会话，回到一个干净的新会话。
         被删的那个会话要是还在跑，任务照跑到底、结果照样落盘
         （存档文件删了也不会写回来），但界面上它已经没地方显示了。 */
      deleteSession(id) {
        const pane = id ? panes.get(String(id)) : null;
        if (pane && pane === activePane) {
          this.newSession();
        }
        if (pane && !pane.state.running) {
          if (pane.msgs.parentNode) pane.msgs.parentNode.removeChild(pane.msgs);
          panes.delete(String(id));
        }
      },
      /* 按 id 切到某个会话（不需要走磁盘）。
         正在跑的那个会话往往还没落盘——它要到这一轮结束才写文件，
         所以页面点「运行中」那条时只能按 id 找活着的 pane，读文件会读空。 */
      focusSession(id) {
        const pane = id ? panes.get(String(id)) : null;
        if (!pane) return false;
        activatePane(pane);
        return true;
      },
      sessions() {
        return AIStore.listSessions();
      },
      /* 挂载时叫它：恢复上次的界面偏好（强度 / 权限 / 模型）与上次那个会话。
         记忆是锦上添花——读失败或会话文件没了就按默认值继续，不报错。
         只跑一次：obtain 复用已有现场时，两个入口都会叫 boot，
         再跑一遍会把当前会话重放一次，正在飞的那一轮节点会被存档副本顶掉。 */
      async boot() {
        if (booted) return state.session;
        booted = true;
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
      /* 调用方（页面卸载前）用它把界面从「正在回答」摘出来。
         只作用于可见会话：后台会话的任务还在跑，把它标成不忙等于骗界面。 */
      setBusy(b) {
        if (activePane) activePane.state.running = !!b;
        else state.running = !!b;
        composer.setBusy(b, false);
      },
      /* 模型 / 强度 / 权限是全局偏好：每个 pane 都写一份。
         只写可见那份的话，切回一个旧会话时它还拿着启动时那套值，
         下一轮就按旧值跑（bug2 在跨会话场景下的同一个根因）。 */
      setModel(id) {
        eachPaneState(function (st) { st.model = id; });
        composer.setModel(id);
      },
      setThinking(v) {
        eachPaneState(function (st) { st.thinking = v; });
        composer.setThinking(v);
      },
      setPermission(p) {
        eachPaneState(function (st) { st.permission = p; });
        composer.setPermission(p);
      },
      /* 页面/抽屉收起时必须调它：composer 里挂着推理强度画布的 ticker、
         菜单的 resize 监听和 motion 订阅，只清 DOM 会把它们留成常驻空转。
         提案队列是全应用共用的，退订一定要做，否则关掉的抽屉还在重画。
         分桶的残留也要一并清：每个 pane 的 DOM、跟随器、单飞位与排队
         不跟着收掉，就会留下一批再也用不到却在跑的东西。 */
      destroy() {
        /* 先立牌子再拆东西：在飞那一轮收尾时会问 isVisible，
           立完牌子它就知道「界面已经没了」，不再去调那些 destroy 过的对象 */
        destroyed = true;
        try { if (unsubscribe) unsubscribe(); } catch (e) { /* 退订失败不影响收尾 */ }
        try { if (follow) follow.destroy(); } catch (e) { /* 跟随器收不掉也别拦着关 */ }
        follow = null;
        if (rail) { try { rail.destroy(); } catch (e) { /* 同上 */ } }
        /* 在飞的那一轮不再往界面写：这里只断它和 DOM 的联系，
           不去碰 Rust 的全局 AI_CANCEL（那是另一个会话也可能在用的） */
        inFlight = null;
        queue.length = 0;
        panes.forEach(function (p) {
          p.state.running = false;
          p.current = null;
          if (p.msgs.parentNode) p.msgs.parentNode.removeChild(p.msgs);
        });
        panes.clear();
        activePane = null;
        current = null;
        try { paneStore.innerHTML = ''; } catch (e) { /* 已经摘掉了 */ }
        try { composer.destroy(); } catch (e) { /* 忽略 */ }
      }
    };
  }

  /* 应用级唯一的对话现场：整页与右侧抽屉共用它。
     两个实例会让「单飞位」和 Rust 的全局 AI_CANCEL 对不上（见文件头注释）：
     抽屉在跑时打开整页再发一条会真并行两条 agent.run，而 main.rs 的
     static AI_CANCEL 只有一个标志位，点任意一个「停止」会互相打断。
     所以入口一律走 obtain()：第一个调用者创建，后面的只换宿主（attach）。 */
  let shared = null;

  function obtain(rootEl, opts) {
    if (!shared) shared = create(rootEl, opts);
    else shared.attach(rootEl, opts);
    return shared;
  }

  /* 摘界面但不销毁现场：应用真正退出时才需要 destroy（这次不做调用点）。
     保留 release 这个名字是给「当前没人用它」的调用方一个明确说法。 */
  function release() {
    if (shared) shared.detach();
  }

  root.AIChat = { create, obtain, release, scene: () => shared };
})(typeof window !== 'undefined' ? window : globalThis);
