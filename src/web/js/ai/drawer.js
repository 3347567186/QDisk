/* AI 助手 · 右侧抽屉
   ------------------------------------------------------------
   空间工具 / 整理预览这类「已经有一屏数据」的页面用抽屉，
   不打断用户当前操作；AI 页才是整页。
   抽屉与整页共用同一个 chatui，上下文由调用方给（当前目录、选中项）。 */
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

  function open(opts) {
    const options = opts || {};
    if (current) close();
    const title = options.title || T('问 AI', 'Ask AI');

    const mask = h('div', { class: 'ai-drawer-mask' });
    const body = h('div', { class: 'ai-drawer-body' });
    const panel = h('div', { class: 'ai-drawer' },
      h('div', { class: 'ai-drawer-head' },
        window.SteveAvatar ? window.SteveAvatar.el({ size: 18, variant: 'drawer' }) : UIx.icon('spark'),
        h('div', { class: 'ai-drawer-title' }, title),
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
