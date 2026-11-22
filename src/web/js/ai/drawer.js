/* AI 助手 · 右侧抽屉
   ------------------------------------------------------------
   空间工具 / 整理预览这类「已经有一屏数据」的页面用抽屉，
   不打断用户当前操作；AI 页才是整页。
   抽屉与整页共用同一个 chatui，上下文由调用方给（当前目录、选中项）。

   头部按参考实现的排法：左手是「新对话 / 历史」，右手是「整页 / 关闭」，
   中间只留一句「贴着当前页问」。历史是一层可收起的列表，
   不再要求用户跳到整页才找得到上一次的对话。 */
(function (root) {
  'use strict';

  const UIx = root.UI;
  const h = UIx.h;
  const T = UIx.T;

  let current = null;

  function close() {
    if (!current) return;
    current.mask.classList.remove('in');
    current.panel.classList.remove('in');
    const c = current;
    current = null;
    if (c.onEsc) {
      document.removeEventListener('keydown', c.onEsc);
      c.onEsc = null;
    }
    if (c.chat && c.chat.setSuggestions) {
      try { c.chat.setSuggestions(null); } catch (e) { /* 清理建议失败不影响关闭 */ }
    }
    /* 轮询必须跟着抽屉一起停：抽屉关了没人看，再每 700ms 查一次
       只是白跑；而且回调里拿 current.chat 判断归属，关掉后也点不动。 */
    if (c.busyTimer) {
      clearInterval(c.busyTimer);
      c.busyTimer = 0;
    }
    setTimeout(() => {
      /* 先把「这个抽屉还占着界面吗」判掉，再动 DOM。
         180ms 的退场动画里完全可能已经发生了两件事：
         1. 用户重开抽屉 —— open() 里 obtain 已经把 shell 搬进新面板；
         2. 用户点了「整页」—— ai.js 挂载后 obtain 把 shell 搬进整页容器。
         两种情况下现场都不归这个抽屉管了，这时再 detach 就是把
         刚挂上的界面又摘走，表现是「打开抽屉却看不到内容」。
         判据用 DOM 归属（shell 还是不是本面板 body 的第一个子节点），
         因为现场是单例、比对象身份永远相等，判不出来。 */
      const shell = c.body ? c.body.firstElementChild : null;
      const mine = !!(shell && shell.parentNode === c.body);
      c.mask.remove();
      c.panel.remove();
      /* 抽屉关了不等于这一轮结束：现场要留着（后台继续跑），
         只把界面摘下来。真销毁由应用退出统一做。
         以前这里调的是 destroy()：inFlight 置空、queue 清空、panes 连 DOM
         一起删，于是抽屉里正在跑的那一轮虽然网络请求还在，收尾时 pane
         已经没了，界面接不回来，用户只能重开抽屉从历史里重看。 */
      if (mine && c.chat && c.chat.detach) {
        const scene = root.AIChat && root.AIChat.scene ? root.AIChat.scene() : null;
        /* 两道闸：既要「还是同一份现场」，也要「界面还挂在我这儿」 */
        if (scene === c.chat) {
          try { c.chat.detach(); } catch (e) { /* 摘不掉也不该拦住关抽屉 */ }
        }
      }
    }, 180);
  }

  function dayGroup(ms) {
    const d = new Date(ms || 0);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return 'today';
    if (now - d < 7 * 86400000) return 'week';
    return 'older';
  }

  function clock(ms) {
    const d = new Date(ms || 0);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }
    return (d.getMonth() + 1) + '/' + d.getDate();
  }

  function open(opts) {
    const options = opts || {};
    if (current) close();

    const mask = h('div', { class: 'ai-drawer-mask' });
    const body = h('div', { class: 'ai-drawer-body' });
    const histPanel = h('div', { class: 'ai-drawer-hist' });
    /* 「正在运行」条：整页左栏有 .ai-busy，抽屉以前完全没有，
       于是在抽屉里切到别的会话（或关掉再开）就再也看不见那条还在跑。
       放在头部之下、历史面板之上：它是常驻状态，不是可收起的列表。 */
    const busyBar = h('div', { class: 'ai-dw-busy', hidden: true });
    const histBtn = h('button', {
      class: 'btn ghost sm ai-dw-hist-btn',
      type: 'button',
      'aria-expanded': 'false',
      title: T('对话历史', 'Chat history')
    }, UIx.icon('clock'), h('span', { text: T('历史', 'History') }));
    const newBtn = h('button', {
      class: 'btn sm ai-dw-new',
      type: 'button',
      title: T('新建对话', 'New chat')
    }, UIx.icon('plus'), h('span', { text: T('新对话', 'New') }));

    const panel = h('div', { class: 'ai-drawer' },
      h('div', { class: 'ai-drawer-head' },
        newBtn,
        histBtn,
        h('div', { class: 'ai-dw-spacer' }),
        h('button', {
          class: 'btn sm ghost',
          title: T('在新页面打开', 'Open full page'),
          onclick: () => { close(); location.hash = '#ai'; }
        }, T('整页', 'Full')),
        h('button', {
          class: 'btn sm ghost',
          title: T('关闭', 'Close'),
          onclick: close
        }, UIx.icon('close'))
      ),
      /* 运行条紧跟头部：历史列表展开时是一层可滚的面板，
         把它放在历史后面会被挤到面板底部，用户正好在找「那条还在跑的」时看不见 */
      busyBar,
      histPanel,
      body
    );
    document.body.appendChild(mask);
    document.body.appendChild(panel);
    requestAnimationFrame(() => {
      mask.classList.add('in');
      panel.classList.add('in');
    });
    mask.addEventListener('click', close);
    const onEsc = function (e) {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onEsc);

    /* 历史列表的两个状态必须在 obtain 之前声明：
       attach 里会同步补发一次 notifySessions，而 onSessions 回调第一句就是
       把 histRows 置空 —— 声明写在 obtain 之后就是 TDZ，open() 直接抛错。 */
    let histOpen = false;
    let histRows = null;

    /* 抽屉头部的「正在运行」条。
       用 function 声明而不是 const：下面的 obtain 参数里会引用它，
       而函数声明会提升，写成 const 的话这里就是 TDZ 报错。
       跟 pages/ai.js 的 renderBusy 同构，但更窄：抽屉没有左栏，
       只留「标题 + 排队数」，点一下切回那条会话。 */
    let busyStamp = '';
    function renderBusyBar(snap) {
      const items = (snap && snap.items) || [];
      /* 先判「该不该显示」，再判「要不要重画」。
         这两件事以前混在同一个指纹早退里：空快照命中指纹就 return，
         于是「该藏起来」靠初始的 hidden 属性兜住，而「该显示」完全
         依赖那条推送能不能到 —— 推送一断，条就永远不出现。
         现在显示与否只看快照里有没有在跑的条目，重画才看指纹去重
         （通知很密，正在点的那个按钮不能被换掉）。 */
      if (!items.length) {
        busyBar.hidden = true;
        if (busyStamp !== '') {
          busyStamp = '';
          busyBar.innerHTML = '';
        }
        return;
      }
      const stamp = items.map((it) => it.id + ':' + (it.running ? 'r' : '') + it.queued + (it.visible ? 'v' : '')).join('|');
      if (stamp === busyStamp && !busyBar.hidden) return;
      busyStamp = stamp;
      busyBar.hidden = false;
      busyBar.innerHTML = '';
      /* 标题行：跟整页左栏的 .ai-busy-head 同构。
         加它不只是好看 —— 只画一行标题的按钮，用户看不出那是「正在运行」，
         会以为是个普通的历史条目。 */
      busyBar.appendChild(h('div', { class: 'ai-dw-busy-head' },
        h('span', { class: 'ai-busy-dot' }),
        h('span', { text: T('正在运行', 'Running') })
      ));
      items.forEach((it) => {
        const label = it.queued > 0
          ? T('+' + it.queued + ' 排队', '+' + it.queued + ' queued')
          : '';
        busyBar.appendChild(h('button', {
          class: 'ai-dw-busy-row',
          type: 'button',
          'data-active': it.visible ? '' : null,
          title: it.title + (label ? ' · ' + label : ''),
          onclick: () => {
            if (!chat) return;
            /* 在跑的会话还没落盘，只能按 id 找活着的那个 pane；
               找不到就退回读文件（跑完的会话一定有存档） */
            if (chat.focusSession && chat.focusSession(it.id)) {
              histRows = null;
              setHist(false);
              chat.focus();
              return;
            }
            AIStore.loadSession(it.id).then((s) => {
              if (!s) return;
              chat.loadSession(s);
              histRows = null;
              setHist(false);
            }).catch(() => {});
          }
        },
          h('span', { class: 'ai-dw-busy-title' }, it.title),
          label ? h('span', { class: 'ai-dw-busy-tag' }, label) : null
        ));
      });
    }

    /* 走 obtain 而不是 create：应用级只有一个对话现场，
       抽屉只是把它「挂」到自己容器上。各建一个实例会让单飞位变成两份，
       而 Rust 的 AI_CANCEL 是全局单一标志位，两条并行时互相打断。 */
    const chat = root.AIChat.obtain(body, {
      compact: true,
      ctx: options.ctx || (() => ({})),
      onBusy: (snap) => { renderBusyBar(snap); },
      onSessions: () => { histRows = null; if (histOpen) setHist(true); }
    });
    current = { mask, panel, body, chat, busyTimer: 0, onEsc };
    /* 主动拉一次：attach 里那次补发发生在 open() 把 current 赋上之前，
       而 renderBusyBar 的点击回调用 current.chat 判断「现场在不在」，
       那一次通知里点按钮会直接 return。这里在 current 就位后再拉一遍，
       画出的行才点得动。没有在跑的会话时 renderBusyBar 自己会藏起来。 */
    function pullBusy() {
      try {
        if (chat && chat.activity) renderBusyBar(chat.activity());
      } catch (e) { /* 拉不到就沿用上一次画出来的结果 */ }
    }
    pullBusy();
    /* 拉取式兜底：抽屉开着的时候每 700ms 自己查一次「谁在跑」。
       原来只靠 chatui 的推送（notifyBusy → onBusy），那条链路一旦在某处
       断掉（订阅被后一次 attach 整体替换、回调抛错被 try 吞掉），
       表现就是「明明在跑，抽屉顶上什么都没有」——而这条症状在真机上
       反复出现又定位不到断点。定时拉一次不依赖任何推送，代价是
       每 700ms 一次纯内存遍历（activity() 只读 Map，不碰磁盘）。 */
    if (current) current.busyTimer = setInterval(pullBusy, 700);

    /* ---- 历史列表：打开抽屉才读，读完缓存到下次打开 ---- */

    async function loadRows() {
      const items = await AIStore.listSessions();
      const rows = await Promise.all(items.slice(0, AIStore.MAX_SESSIONS || 20).map(async (it) => {
        let t = '';
        let stamp = (it.mtime || 0) * 1000;
        try {
          const s = await AIStore.loadSession(it.id);
          t = (s && s.title) || '';
          if (s && (s.updated || s.created)) stamp = Number(s.updated || s.created);
        } catch (e) { /* 坏文件就用文件时间兜底 */ }
        return { id: it.id, mtime: stamp, title: t || T('未命名会话', 'Untitled chat') };
      }));
      return rows.sort((a, b) => b.mtime - a.mtime);
    }

    function renderHist() {
      histPanel.innerHTML = '';
      if (!histRows) {
        histPanel.appendChild(h('div', { class: 'ai-dh-empty', text: T('读取中…', 'Loading…') }));
        return;
      }
      if (!histRows.length) {
        histPanel.appendChild(h('div', { class: 'ai-dh-empty', text: T('还没有归档会话', 'No archived chats yet') }));
        return;
      }
      const groups = [
        { id: 'today', label: T('今天', 'Today') },
        { id: 'week', label: T('近 7 天', 'Last 7 days') },
        { id: 'older', label: T('更早', 'Earlier') }
      ];
      groups.forEach((g) => {
        const list = histRows.filter((r) => dayGroup(r.mtime) === g.id);
        if (!list.length) return;
        histPanel.appendChild(h('div', { class: 'ai-dh-group', text: g.label }));
        list.forEach((r) => {
          const row = h('div', { class: 'ai-dh-row' },
            h('button', {
              class: 'ai-dh-open',
              type: 'button',
              title: r.title,
              onclick: async () => {
                try {
                  const s = await AIStore.loadSession(r.id);
                  if (!s) throw new Error(T('会话已损坏', 'Chat is corrupted'));
                  chat.loadSession(s);
                  setHist(false);
                } catch (e) {
                  UIx.toast(T('打不开这个会话：', 'Cannot open chat: ') + UI.errText(e), 'bad');
                }
              }
            },
              h('span', { class: 'ai-dh-title', text: r.title }),
              h('span', { class: 'ai-dh-time', text: clock(r.mtime) })
            ),
            h('button', {
              class: 'ai-dh-del',
              type: 'button',
              title: T('删除这条本地记录', 'Delete this local chat'),
              onclick: async (e) => {
                e.stopPropagation();
                const ok = await UIx.confirm({
                  title: T('删除归档会话', 'Delete chat'),
                  body: T('只删这条本地记录，不影响任何文件。', 'Removes this local record only, no files touched.'),
                  ok: T('删除', 'Delete'),
                  danger: true
                });
                if (!ok) return;
                try {
                  await AIStore.deleteSession(r.id);
                  chat.deleteSession(r.id);
                  histRows = histRows.filter((x) => x.id !== r.id);
                  renderHist();
                  UIx.toast(T('已删除', 'Deleted'), 'ok');
                } catch (err) {
                  UIx.toast(T('删除失败：', 'Delete failed: ') + UI.errText(err), 'bad');
                }
              }
            }, UIx.icon('trash'))
          );
          histPanel.appendChild(row);
        });
      });
    }

    function setHist(open) {
      histOpen = open;
      histPanel.classList.toggle('on', open);
      histBtn.classList.toggle('on', open);
      histBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open && !histRows) {
        renderHist();
        loadRows().then((rows) => {
          histRows = rows;
          if (histOpen) renderHist();
        }).catch(() => {
          histRows = [];
          if (histOpen) renderHist();
        });
      }
    }

    histBtn.addEventListener('click', () => setHist(!histOpen));
    newBtn.addEventListener('click', () => {
      chat.newSession();
      histRows = null;
      setHist(false);
      chat.focus();
    });

    /* 这里原来是 newSession()：每开一次抽屉就新建一个空会话，
       于是「关掉再打开」等于把刚才那一轮对话丢掉，抽屉里永远空空如也。
       用户说的「侧边对话栏没同步」有一半就是这个。
       改成 boot()：整页与抽屉共用同一个现场，boot 内部有 booted 闸门，
       重复调用不会重放当前会话；第一次打开时它会接上次的会话。
       真要开新的，头部「新对话」按钮还在。 */
    try {
      const r = chat.boot();
      if (r && typeof r.catch === 'function') r.catch(() => { /* 起不来也别拦住打开 */ });
    } catch (e) { /* 同上 */ }
    /* 入口不再直接把提示词发出去：转换成可点击的建议提示词，
       由用户决定是直接发送（点击）还是改完再问（右键填入输入框）。 */
    const initialSuggestions = [];
    const seenSug = new Set();
    const pushSug = (q) => {
      const s = String(q || '').trim();
      if (!s || seenSug.has(s)) return;
      seenSug.add(s);
      initialSuggestions.push(s);
    };
    if (options.question) pushSug(options.question);
    if (Array.isArray(options.suggestions)) options.suggestions.forEach(pushSug);
    if (chat.setSuggestions) {
      chat.setSuggestions(initialSuggestions, { contextual: true });
    }
    chat.focus();
    return chat;
  }

  function isOpen() {
    return !!current;
  }

  root.AIDrawer = { open, close, isOpen };
})(typeof window !== 'undefined' ? window : globalThis);
