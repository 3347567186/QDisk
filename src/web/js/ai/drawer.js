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
    setTimeout(() => {
      c.mask.remove();
      c.panel.remove();
      /* 抽屉关了就等于这个聊天实例结束：ticker / 监听 / 订阅要一起收掉。
         只 clear() 会留下一个永不停止的推理强度画布（每帧一次，看不见）。 */
      if (c.chat) {
        if (c.chat.destroy) c.chat.destroy();
        else c.chat.clear();
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
    const title = options.title || T('问 AI', 'Ask AI');

    const mask = h('div', { class: 'ai-drawer-mask' });
    const body = h('div', { class: 'ai-drawer-body' });
    const histPanel = h('div', { class: 'ai-drawer-hist' });
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
        h('div', { class: 'ai-drawer-title' },
          h('span', { class: 'ai-dw-title', text: title }),
          h('span', { class: 'ai-dw-sub', text: T('贴着当前页问', 'About this page') })
        ),
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
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') {
        close();
        document.removeEventListener('keydown', esc);
      }
    });

    const chat = root.AIChat.create(body, {
      compact: true,
      ctx: options.ctx || (() => ({}))
    });
    current = { mask, panel, chat };

    /* ---- 历史列表：打开抽屉才读，读完缓存到下次打开 ---- */
    let histOpen = false;
    let histRows = null;

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

    chat.newSession();
    if (options.question) {
      setTimeout(() => chat.ask(options.question), 120);
    } else {
      chat.focus();
    }
    return chat;
  }

  function isOpen() {
    return !!current;
  }

  root.AIDrawer = { open, close, isOpen };
})(typeof window !== 'undefined' ? window : globalThis);
