/* AI 助手页（导航第 1 组「助手」）
   ------------------------------------------------------------
   1.23.6 起改成「左侧归档栏 + 右侧对话」的两栏：
   左边固定一列放「新对话」和归档会话（按 今天 / 近 7 天 / 更早 分组），
   右边是对话本体，输入框钉在列底、消息区自己滚。
   参照的是 DeepSeek Harness 的会话侧栏：新建在顶、列表居中、设置沉底，
   当前会话高亮，悬停才露删除，避免每行常驻一堆图标。 */
(function () {
  const { h, T, toast, icon } = UI;

  const App = {
    title: ['AI 助手', 'Assistant'],
    subtitle: ['问文件与空间的事，它真的会去查', 'Ask about files and space — it actually checks'],

    mount(root) {
      let chat = null;
      let activeId = null;
      let listToken = 0;

      /* ---------- 左栏 ---------- */
      const railList = h('div', { class: 'ai-rail-list' });
      const newBtn = h('button', {
        class: 'ai-new',
        type: 'button',
        onclick: () => {
          chat.newSession();
          activeId = chat.session ? chat.session.id : null;
          paintActive();
          chat.focus();
        }
      }, icon('plus'), h('span', {}, T('新对话', 'New chat')));

      /* 收起/展开左栏：状态记在 localStorage，下次进来还是上次的样子。
         收起后开关不会消失，而是挪到对话区左上角的留白里（那里永远不会压住内容）。 */
      const RAIL_KEY = 'ai.rail.closed';
      const railToggle = h('button', {
        class: 'ai-rail-toggle',
        type: 'button',
        title: T('收起归档栏（Ctrl+B）', 'Collapse archive (Ctrl+B)'),
        'aria-label': T('收起归档栏', 'Collapse archive'),
        'aria-expanded': 'true',
        onclick: () => setRail(true, true)
      }, icon('chevron-left'));

      const rail = h('aside', { class: 'ai-rail' },
        h('div', { class: 'ai-rail-top' }, newBtn, railToggle),
        railList
      );

      /* ---------- 右栏 ---------- */
      const chatRoot = h('div', { class: 'ai-page-chat' });
      const mainToggle = h('button', {
        class: 'ai-main-toggle',
        type: 'button',
        title: T('展开归档栏（Ctrl+B）', 'Show archive (Ctrl+B)'),
        'aria-label': T('展开归档栏', 'Show archive'),
        'aria-expanded': 'false',
        onclick: () => setRail(false, true)
      }, icon('chevron-right'));
      const main = h('div', { class: 'ai-main' }, mainToggle, chatRoot);
      const page = h('div', { class: 'page-fill ai-page' }, rail, main);

      function setRail(closed, focus) {
        page.dataset.rail = closed ? 'closed' : 'open';
        railClosed = !!closed;
        railToggle.setAttribute('aria-expanded', String(!closed));
        mainToggle.setAttribute('aria-expanded', String(!closed));
        try { localStorage.setItem(RAIL_KEY, closed ? '1' : '0'); } catch (e) { /* 隐私模式忽略 */ }
        /* 同一份偏好也记进 app.json：换 WebView 缓存、重装后仍然记得收起状态 */
        try { Promise.resolve(AIStore.saveUi({ railClosed: !!closed })).catch(() => {}); } catch (e) { /* 记不住不影响收起 */ }
        if (focus) (closed ? mainToggle : railToggle).focus();
      }

      let railClosed = false;
      try { railClosed = localStorage.getItem(RAIL_KEY) === '1'; } catch (e) { /* 忽略 */ }
      setRail(railClosed, false);
      /* localStorage 只是首屏的即时线索，权威值在 app.json 的 ai_ui 里 */
      AIStore.loadUi().then((u) => {
        if (typeof u.railClosed === 'boolean' && u.railClosed !== railClosed) setRail(u.railClosed, false);
      }).catch(() => {});

      function onKey(e) {
        if (e.key !== 'b' && e.key !== 'B') return;
        if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
        e.preventDefault();
        setRail(page.dataset.rail !== 'closed', true);
      }
      document.addEventListener('keydown', onKey);

      /* 路由器已经给了一个 .page-body，这里不再套第二层——
         多一层会让「定高」的 :has() 选择器对不上，消息一多就把整页撑高。 */
      root.appendChild(page);

      function paintActive() {
        railList.querySelectorAll('.ai-sess').forEach((n) => {
          if (n.dataset.id === activeId) n.setAttribute('data-active', '');
          else n.removeAttribute('data-active');
        });
      }

      function dayGroup(ms) {
        const d = new Date(ms);
        const now = new Date();
        const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        if (d.getTime() >= startToday) return 'today';
        if (d.getTime() >= startToday - 6 * 86400000) return 'week';
        return 'older';
      }

      function timeLabel(ms) {
        const d = new Date(ms);
        const now = new Date();
        const sameDay = d.toDateString() === now.toDateString();
        if (sameDay) return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
        if (d.getFullYear() === now.getFullYear()) return (d.getMonth() + 1) + '/' + d.getDate();
        return d.getFullYear() + '/' + (d.getMonth() + 1);
      }

      /* 列表要标题，而 listSessions 只给文件名和 mtime —— 逐个读会话头。
         20 个以内是本地上限（store 的 MAX_SESSIONS），读完一次就够。 */
      async function loadList() {
        let items = [];
        try {
          items = await AIStore.listSessions();
        } catch (e) {
          railList.innerHTML = '';
          railList.appendChild(h('div', { class: 'ai-rail-empty' },
            T('读不到归档：', 'Cannot read archive: ') + UI.errText(e)));
          return;
        }
        const rows = await Promise.all(items.slice(0, AIStore.MAX_SESSIONS || 20).map(async (it) => {
          let title = '';
          let stamp = (it.mtime || 0) * 1000;
          try {
            const s = await AIStore.loadSession(it.id);
            title = (s && s.title) || '';
            /* 归档按「最后一次活动」排序：会话里记的 updated/created 比文件时间可靠
               （复制、备份、同步都会改文件时间，却不会改内容里的时间） */
            if (s && (s.updated || s.created)) stamp = Number(s.updated || s.created);
          } catch (e) { /* 坏文件就用文件时间兜底 */ }
          return { id: it.id, mtime: stamp, title: title || T('未命名会话', 'Untitled chat') };
        }));
        return rows;
      }

      async function renderList() {
        const token = ++listToken;
        const rows = await loadList();
        if (!rows || token !== listToken) return;
        railList.innerHTML = '';
        if (!rows.length) {
          railList.appendChild(h('div', { class: 'ai-rail-empty' }, T('还没有归档会话', 'No archived chats yet')));
          return;
        }
        const groups = [
          { id: 'today', label: T('今天', 'Today') },
          { id: 'week', label: T('近 7 天', 'Last 7 days') },
          { id: 'older', label: T('更早', 'Earlier') }
        ];
        groups.forEach((g) => {
          const inGroup = rows.filter((r) => dayGroup(r.mtime) === g.id);
          if (!inGroup.length) return;
          railList.appendChild(h('div', { class: 'ai-rail-group' }, g.label));
          inGroup.forEach((r) => {
            const row = h('div', { class: 'ai-sess', 'data-id': r.id },
              h('button', {
                class: 'ai-sess-open',
                type: 'button',
                title: r.title,
                onclick: async () => {
                  try {
                    const s = await AIStore.loadSession(r.id);
                    if (!s) throw new Error(T('会话已损坏', 'Chat is corrupted'));
                    chat.loadSession(s);
                    activeId = s.id;
                    paintActive();
                  } catch (e) {
                    toast(T('打开失败：', 'Open failed: ') + UI.errText(e), 'error');
                  }
                }
              },
                h('span', { class: 'ai-sess-title' }, r.title),
                h('span', { class: 'ai-sess-time' }, timeLabel(r.mtime))
              ),
              h('button', {
                class: 'ai-sess-del',
                type: 'button',
                title: T('删除这条归档', 'Delete this chat'),
                onclick: async (e) => {
                  e.stopPropagation();
                  const ok = await UI.confirm({
                    title: T('删除归档会话', 'Delete chat'),
                    body: T('只删这条本地记录，不影响任何文件。', 'Removes this local record only, no files touched.'),
                    ok: T('删除', 'Delete'),
                    danger: true
                  });
                  if (!ok) return;
                  try {
                    await AIStore.deleteSession(r.id);
                    chat.deleteSession(r.id);
                    if (activeId === r.id) activeId = chat.session ? chat.session.id : null;
                    await renderList();
                  } catch (err) {
                    toast(T('删除失败：', 'Delete failed: ') + UI.errText(err), 'error');
                  }
                }
              }, icon('trash'))
            );
            railList.appendChild(row);
          });
        });
        paintActive();
      }

      chat = AIChat.create(chatRoot, {
        ctx: () => ({ page: 'ai', tools: AIPrompt.PAGE_TOOLS.ai }),
        /* 新会话落盘 / 载入后刷新左栏，标题与排序跟着变 */
        onSessions: () => { renderList(); }
      });
      /* 上次的强度 / 权限 / 模型 / 会话都从 ai_ui 恢复；
         读完再点亮左栏高亮，避免先亮一个再跳一个 */
      chat.boot().then(() => {
        activeId = chat.session ? chat.session.id : null;
        paintActive();
      }).catch(() => {
        activeId = chat.session ? chat.session.id : null;
        paintActive();
      });
      chat.focus();
      /* 先让页面画出来，再读归档（20 个文件头，别挡首屏） */
      requestAnimationFrame(() => { renderList(); });

      return function unmount() {
        listToken++;
        document.removeEventListener('keydown', onKey);
        try { AIDrawer.close(); } catch { /* 忽略 */ }
        if (chat) {
          try { chat.setBusy(false); } catch { /* 忽略 */ }
          try { chat.destroy(); } catch { /* 忽略 */ }
          chat = null;
        }
      };
    }
  };

  window.Pages = window.Pages || {};
  window.Pages.ai = App;
})();
