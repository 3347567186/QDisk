/* UI 基础工具：DOM 构造、格式化、提示、弹窗、右键菜单、图片预览、图标 */
(function () {
  const state = { lang: 'zh-CN', theme: 'light', pageSize: 15 };
  const PAGE_SIZES = [15, 30, 60, 100, 200];

  function pageSize() {
    return PAGE_SIZES.includes(Number(state.pageSize)) ? Number(state.pageSize) : 15;
  }

  /* 列表页通用的「每页条数」选择器：使用自定义胶囊下拉组件，支持 (onChange) 与 (current, sizes, onChange) 重载 */
  function pageSizePick(arg1, arg2, arg3) {
    let cur = pageSize();
    let sizes = PAGE_SIZES;
    let onChange = null;

    if (typeof arg1 === 'function') {
      onChange = arg1;
    } else if (typeof arg3 === 'function') {
      cur = Number(arg1) || cur;
      sizes = Array.isArray(arg2) ? arg2 : sizes;
      onChange = arg3;
    } else if (typeof arg2 === 'function') {
      if (typeof arg1 === 'number') cur = arg1;
      else if (Array.isArray(arg1)) sizes = arg1;
      onChange = arg2;
    }

    const sel = customSelect({
      options: sizes.map((n) => ({ value: String(n), label: T(n + ' 条', n + ' rows') })),
      value: String(cur),
      alignUp: false,
      className: 'sm',
      title: T('每页条数', 'Rows per page'),
      onChange: (val) => {
        const n = Number(val) || 15;
        state.pageSize = n;
        if (window.UI && window.UI.state) window.UI.state.pageSize = n;
        try { onChange && onChange(n); } catch { /* ignore */ }
      }
    });
    return sel;
  }

  const langHandlers = new Set();

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs && typeof attrs === 'object' && !(attrs instanceof Node) && !Array.isArray(attrs)) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'html') el.innerHTML = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'value') el.value = v;
        else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
        else if (k === 'ref' && typeof v === 'function') v(el);
        else el.setAttribute(k, v);
      }
    } else if (attrs !== null && attrs !== undefined) {
      children.unshift(attrs);
    }
    const push = (c) => {
      if (c === null || c === undefined || c === false) return;
      if (Array.isArray(c)) return c.forEach(push);
      el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    };
    children.forEach(push);
    return el;
  }

  const T = (zh, en) => (state.lang === 'en-US' ? en : zh);

  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = n / 1024, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + ' ' + units[i];
  }
  const fmtSize = fmtBytes;
  const fmtCount = (n) => (Number(n) || 0).toLocaleString(state.lang === 'en-US' ? 'en-US' : 'zh-CN');
  function fmtTime(sec) {
    if (!sec) return '—';
    const d = new Date(sec * 1000);
    return d.toLocaleString(state.lang === 'en-US' ? 'en-US' : 'zh-CN', { hour12: false });
  }
  function fmtDateTime(s) {
    if (!s) return '—';
    const d = new Date(s);
    return isNaN(d) ? String(s) : d.toLocaleString(state.lang === 'en-US' ? 'en-US' : 'zh-CN', { hour12: false });
  }

  function toast(msg, kind = 'info', ms = 3200) {
    const box = document.getElementById('toasts');
    if (!box) return;
    const IC = { ok: 'check', error: 'alert', warn: 'alert', info: 'info' };
    const node = h('div', { class: 'toast ' + kind },
      h('span', { class: 'bar' }),
      h('span', { class: 'ic' }, icon(IC[kind] || 'info', 15)),
      h('div', null, String(msg))
    );
    node.style.setProperty('--toast-ms', ms + 'ms');
    box.appendChild(node);
    setTimeout(() => {
      node.classList.add('out');
      setTimeout(() => node.remove(), 200);
    }, ms);
  }

  /* ---------- 通用弹窗 ---------- */
  function modal({ title, body, buttons, wide = false, onClose, onAction }) {
    const mask = h('div', { class: 'modal-mask', onclick: (e) => { if (e.target === mask) close(null); } });
    const bodyEl = h('div', { class: 'modal-body' },
      body instanceof Node ? body : (body ? h('p', null, body) : null));
    const box = h('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true' },
      title ? h('h3', null, title) : null,
      bodyEl,
      h('div', { class: 'modal-foot' },
        ...(buttons || [{ id: 'ok', label: T('确定', 'OK'), kind: 'primary' }]).map((b) =>
          h('button', {
            class: 'btn ' + (b.kind || 'ghost'),
            // onAction 返回 false 时拦下这次关闭，用于「校验没通过就别关」。
            onclick: () => { if (onAction && onAction(b.id) === false) return; close(b.id); }
          }, b.label)
        )
      )
    );
    mask.appendChild(box);
    document.getElementById('modal-root').appendChild(mask);
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      // 只关最上面那一层：嵌套确认框时 Esc 不该穿透到下层
      const root = document.getElementById('modal-root');
      if (root && root.lastElementChild && root.lastElementChild !== mask) return;
      close(null);
    };
    document.addEventListener('keydown', onKey);
    // 按住 Enter 的重复事件会连点焦点按钮：确认框默认焦点在「取消」，
    // 这里再把 repeat 事件挡掉，避免一次长按触发第二次破坏性操作。
    const onRepeat = (e) => {
      if (e.key === 'Enter' && e.repeat) { e.preventDefault(); e.stopPropagation(); }
    };
    document.addEventListener('keydown', onRepeat, true);
    let closed = false;
    function close(v) {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('keydown', onRepeat, true);
      mask.classList.add('closing');
      box.classList.add('closing');
      setTimeout(() => mask.remove(), 190);
      onClose && onClose(v);
    }
    const first = box.querySelector('.btn'); first && first.focus();
    return { el: box, close };
  }

  function confirmBox({ title, body, ok = T('确定', 'OK'), cancel = T('取消', 'Cancel'), danger = false }) {
    return new Promise((resolve) => {
      let settled = false;
      const m = modal({
        title: title || T('确认操作', 'Confirm'),
        body: body || '',
        buttons: [
          { id: 'cancel', label: cancel, kind: 'ghost' },
          { id: 'ok', label: ok, kind: danger ? 'danger' : 'primary' }
        ],
        onClose: (v) => { if (!settled) { settled = true; resolve(v === 'ok'); } }
      });
      // 破坏性确认默认焦点给「取消」，普通确认给「确定」：
      // 长按回车不会把一次操作变成两次（delete 类按钮只该被主动点击触发）。
      const btns = m.el.querySelectorAll('.modal-foot .btn');
      (danger ? btns[0] : btns[1] || btns[0]).focus();
    });
  }

  async function busy(fn, label, kind) {
    const overlay = document.getElementById('overlay');
    const text = document.getElementById('overlay-text');
    const ic = document.getElementById('overlay-ic');
    const msg = label || T('正在处理…', 'Working…');
    if (text) text.textContent = msg;
    if (ic) {
      const k = LOADERS[kind] ? kind : 'spin';
      ic.className = 'ldr ldr-' + k;
      ic.innerHTML = LOADERS[k];
    }
    if (overlay) overlay.hidden = false;
    const started = performance.now();
    try {
      return await fn();
    } catch (err) {
      toast(err && err.message ? err.message : String(err), 'error');
      return undefined;
    } finally {
      // 太快返回时留一帧给动画，避免遮罩一闪而过（人眼读不到反馈）
      const left = 220 - (performance.now() - started);
      if (left > 0) await new Promise((r) => setTimeout(r, left));
      if (overlay) overlay.hidden = true;
    }
  }

  /**
   * 加载图标：每个功能一个会动的 SVG（24 网格、1.6 描边、currentColor）。
   * 动画全在 styles.css 的 .ldr-* 里，这里只给结构，方便复用与降级。
   */
  const LOADERS = {
    spin: '<svg viewBox="0 0 24 24"><circle class="track" cx="12" cy="12" r="8.5"/><g class="rot"><path class="ink arc" d="M12 3.5a8.5 8.5 0 0 1 8.5 8.5"/></g></svg>',
    scan: '<svg viewBox="0 0 24 24"><rect class="track" x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path class="ink beam" d="M5.2 12h13.6"/></svg>',
    cache: '<svg viewBox="0 0 24 24"><g class="stack"><path class="ink" d="M12 3.2 20 7.4l-8 4.2-8-4.2 8-4.2Z"/><path class="ink" d="m4.4 12 7.6 4 7.6-4"/><path class="ink" d="m4.4 16.8 7.6 4 7.6-4"/></g></svg>',
    apps: '<svg viewBox="0 0 24 24"><rect class="ink tile" x="3.6" y="3.6" width="7" height="7" rx="1.8"/><rect class="ink tile" x="13.4" y="3.6" width="7" height="7" rx="1.8"/><rect class="ink tile" x="3.6" y="13.4" width="7" height="7" rx="1.8"/><rect class="ink tile" x="13.4" y="13.4" width="7" height="7" rx="1.8"/></svg>',
    shots: '<svg viewBox="0 0 24 24"><rect class="track" x="3.5" y="5" width="17" height="14" rx="2"/><circle class="ink" cx="8.4" cy="9.6" r="1.4"/><path class="ink draw" d="m4.8 17.2 4.8-5.2 3.4 3.6 2.4-2.4 3.8 4"/></svg>',
    search: '<svg viewBox="0 0 24 24"><g class="lens"><circle class="ink ring" cx="10.8" cy="10.8" r="6.2"/><path class="ink" d="m15.4 15.4 4.6 4.6"/></g></svg>',
    rules: '<svg viewBox="0 0 24 24"><rect class="track" x="4.5" y="3" width="15" height="18" rx="2.2"/><path class="ink line" d="M8 8h8"/><path class="ink line" d="M8 12h8"/><path class="ink line" d="M8 16h5"/></svg>',
    migrate: '<svg viewBox="0 0 24 24"><rect class="ink gate" x="2.8" y="7" width="5" height="10" rx="1.6"/><rect class="ink gate" x="16.2" y="7" width="5" height="10" rx="1.6"/><path class="ink arrow" d="M9.6 12h5m-2.2-2.2L14.6 12l-2.2 2.2"/></svg>',
    log: '<svg viewBox="0 0 24 24"><path class="ink line" d="M4.5 6.5h15"/><path class="ink line" d="M4.5 11.5h11"/><path class="ink line" d="M4.5 16.5h7"/><path class="ink caret" d="M14.2 19.6h4.3"/></svg>',
    settings: '<svg viewBox="0 0 24 24"><g class="gear"><circle class="ink" cx="12" cy="12" r="3.2"/><path class="ink" d="M12 2.8v2.2M12 19v2.2M4.6 12H2.4M21.6 12h-2.2M6.7 6.7 5.1 5.1M18.9 18.9l-1.6-1.6M6.7 17.3l-1.6 1.6M18.9 5.1l-1.6 1.6"/></g><circle class="core" cx="12" cy="12" r="1.1" fill="currentColor"/></svg>'
  };

  function loader(kind = 'spin') {
    const k = LOADERS[kind] ? kind : 'spin';
    return h('span', { class: 'ldr ldr-' + k, html: LOADERS[k], 'aria-hidden': 'true' });
  }

  /**
   * 内容加载占位：会动的功能图标 + 骨架条。
   * rows 只影响高度（锁定 96–260px），不随数据量膨胀；kind 决定用哪个动画图标。
   */
  const skeleton = (rows = 6, kind = 'spin') => h('div', { class: 'loading-block' },
    loader(kind),
    h('div', { class: 'skeleton' },
      ...Array.from({ length: Math.min(rows, 6) }, (_, i) =>
        h('div', { class: 'bar', style: { width: [92, 76, 84, 66, 88, 72][i % 6] + '%' } }))));

  const empty = (text, sub, ic = 'layers') => h('div', { class: 'empty' },
    ic ? h('div', { class: 'empty-ic' }, icon(ic, 24)) : null,
    h('div', { class: 'big' }, text),
    sub ? h('div', null, sub) : null
  );

  /**
   * 局部刷新：容器里的内容已经换掉了，只让新内容轻轻落定 110ms。
   * 不位移、不闪白、不动滚动条——页内刷新不该像整页重开。
   * 调用方负责先填好内容，再调 softIn(container)。
   */
  const softIn = (el) => {
    if (!el) return;
    el.classList.remove('soft-in');
    void el.offsetWidth;      // 强制回流，让动画能重播
    el.classList.add('soft-in');
  };

  const card = (title, ...children) => {
    const childrenArr = title instanceof Node || Array.isArray(title) ? [title, ...children] : children;
    const head = (typeof title === 'string')
      ? h('div', { class: 'card-title' }, h('h2', null, title))
      : null;
    return h('div', { class: 'card' }, head, ...childrenArr);
  };

  /**
   * 可折叠区块（手风琴）。
   * - open: 初始是否展开
   * - accordion: 传入父容器时，展开本块会自动收起同级其它块（一次只开一个）
   * 过渡由 CSS 的 grid-template-rows 0fr→1fr 完成，内容高度变化也不会跳。
   */
  function section(title, body, { open = false, hint, id, onToggle, accordion, icon: ic } = {}) {
    const sec = h('div', {
      class: 'section' + (open ? ' open' : ''),
      dataset: id ? { section: id } : null
    });
    const head = h('div', {
      class: 'section-head',
      role: 'button',
      tabindex: '0',
      'aria-expanded': open ? 'true' : 'false',
      onclick: () => toggle(),
      onkeydown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      }
    },
      h('span', { class: 'caret', html: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>' }),
      ic ? h('span', { class: 'sec-ic' }, icon(ic, 15)) : null,
      h('h3', null, title),
      hint ? h('span', { class: 'hint' }, hint) : null
    );
    // 内层是动画载体：外层控制高度，内层控制内边距与淡入
    const inner = h('div', { class: 'section-inner' }, body);
    const bodyEl = h('div', { class: 'section-body' }, inner);
    sec.appendChild(head);
    sec.appendChild(bodyEl);

    function toggle(force) {
      const next = force === undefined ? !sec.classList.contains('open') : !!force;
      // 手风琴模式：先收起同级其它块，视觉上像“交接”
      if (next && accordion) {
        Array.from(accordion.children).forEach((el) => {
          if (el !== sec && el.classList && el.classList.contains('section') && el.classList.contains('open')) {
            el.classList.remove('open');
            const h2 = el.querySelector('.section-head');
            if (h2) h2.setAttribute('aria-expanded', 'false');
          }
        });
      }
      sec.classList.toggle('open', next);
      head.setAttribute('aria-expanded', next ? 'true' : 'false');
      onToggle && onToggle(next);
    }
    sec._toggle = toggle;
    return sec;
  }

  function table({ columns, rows, rowKey, className = '' }) {
    const head = h('thead', null, h('tr', null,
      ...columns.map((c) => h('th', {
        class: (c.align === 'right' ? 'num' : '') + (c.className ? ' ' + c.className : ''),
        style: c.width ? { width: c.width } : null
      }, c.label || c.title || ''))
    ));
    const body = h('tbody', null,
      ...rows.map((row, i) => h('tr', { dataset: { key: rowKey ? rowKey(row, i) : i } },
        ...columns.map((c) => {
          const v = c.render ? c.render(row, i) : row[c.key];
          return h('td', {
            class: (c.align === 'right' ? 'num' : '') + (c.className ? ' ' + c.className : '')
          }, v === undefined || v === null ? '' : v);
        })
      ))
    );
    return h('table', { class: 'table' + (className ? ' ' + className : '') }, head, body);
  }

  /* ---------- 右键菜单 ---------- */
  let activeMenu = null;
  function closeMenu() {
    if (activeMenu) { activeMenu.remove(); activeMenu = null; }
  }
  /**
   * 在鼠标位置弹出菜单。
   * items: [{label, icon?, danger?, disabled?, action?} | {sep:true} | {header:'文本'}]
   */
  function menu(evt, items) {
    if (evt && evt.preventDefault) evt.preventDefault();
    closeMenu();
    if (!items || !items.length) return;
    const box = h('div', { class: 'ctx-menu', role: 'menu' });
    items.forEach((it) => {
      if (!it) return;
      if (it.sep) { box.appendChild(h('div', { class: 'sep' })); return; }
      if (it.header) { box.appendChild(h('div', { class: 'label' }, it.header)); return; }
      box.appendChild(h('div', {
        class: 'item' + (it.danger ? ' danger' : '') + (it.disabled ? ' disabled' : ''),
        role: 'menuitem',
        onclick: (e) => { e.stopPropagation(); closeMenu(); it.action && it.action(); }
      }, it.icon ? icon(it.icon, 14) : null, h('span', null, it.label)));
    });
    document.getElementById('ctx-root').appendChild(box);
    const r = box.getBoundingClientRect();
    let x = evt ? evt.clientX : 40;
    let y = evt ? evt.clientY : 40;
    if (x + r.width > window.innerWidth - 8) x = Math.max(8, window.innerWidth - r.width - 8);
    if (y + r.height > window.innerHeight - 8) y = Math.max(8, window.innerHeight - r.height - 8);
    box.style.left = x + 'px';
    box.style.top = y + 'px';
    // 从点击点长出来：把 transform-origin 定在鼠标实际位置，缩放进场才有方向感
    const px = evt ? evt.clientX : x;
    const py = evt ? evt.clientY : y;
    box.style.transformOrigin =
      Math.max(0, Math.min(r.width, px - x)) + 'px ' + Math.max(0, Math.min(r.height, py - y)) + 'px';
    activeMenu = box;
  }

  /**
   * 给元素绑定右键菜单。items 可以是数组或 (evt)=>数组 的函数。
   * 默认阻止系统菜单：只有输入框/文本域保留系统菜单（复制粘贴需要）。
   */
  function attachMenu(el, items) {
    el.addEventListener('contextmenu', (e) => {
      const list = typeof items === 'function' ? items(e) : items;
      if (!list || !list.length) return;
      menu(e, list);
    });
  }

  /* 全局：屏蔽系统右键（输入类除外），点击/滚动/失焦时收起菜单 */
  document.addEventListener('contextmenu', (e) => {
    const t = e.target;
    const allowNative = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if (allowNative) return;
    e.preventDefault();
  }, true);
  document.addEventListener('click', closeMenu, true);
  document.addEventListener('scroll', closeMenu, true);
  window.addEventListener('blur', closeMenu);

  /* ---------- 图片预览 ---------- */
  let activePreviewClose = null;

  function closePreview() {
    if (activePreviewClose) { const f = activePreviewClose; activePreviewClose = null; f(); }
  }

  function preview({ items, index = 0, title }) {
    const list = (items || []).filter(Boolean);
    if (!list.length) return;
    let idx = Math.max(0, Math.min(index, list.length - 1));
    let zoom = 1;
    const root = document.getElementById('preview-root');
    root.innerHTML = '';

    const img = h('img', { alt: '' });
    const nameEl = h('div', { class: 'name' });
    const posEl = h('span', { class: 'mono' });
    const stage = h('div', { class: 'preview-stage' }, img);
    const dots = h('div', { class: 'dots' });

    function render() {
      const it = list[idx];
      img.src = it.src || it.url || '';
      img.style.transform = `scale(${zoom})`;
      img.onerror = () => { img.style.opacity = '.25'; };
      img.onload = () => { img.style.opacity = '1'; };
      nameEl.textContent = it.name || it.path || '';
      posEl.textContent = (idx + 1) + ' / ' + list.length;
      dots.innerHTML = '';
      if (list.length <= 40) {
        list.forEach((_, i) => dots.appendChild(h('button', {
          class: 'dotbtn' + (i === idx ? ' on' : ''),
          onclick: () => { idx = i; zoom = 1; render(); }
        })));
      }
    }
    function step(d) { idx = (idx + d + list.length) % list.length; zoom = 1; render(); }
    function close() {
      document.removeEventListener('keydown', onKey);
      root.innerHTML = '';
      if (activePreviewClose === close) activePreviewClose = null;
    }
    activePreviewClose = close;

    const mask = h('div', { class: 'preview-mask' },
      h('div', { class: 'preview-bar' },
        h('span', { class: 'name' }, title || ''),
        nameEl,
        h('button', { class: 'btn sm ghost', onclick: () => { zoom = Math.min(4, zoom + .25); render(); } }, '＋'),
        h('button', { class: 'btn sm ghost', onclick: () => { zoom = Math.max(.25, zoom - .25); render(); } }, '－'),
        h('button', { class: 'btn sm ghost', onclick: () => { zoom = 1; render(); } }, T('原始', 'Reset')),
        h('button', { class: 'btn sm ghost', onclick: () => { const it = list[idx]; it.path && API.reveal(it.path).catch(() => {}); } }, T('定位', 'Reveal')),
        h('button', { class: 'btn sm ghost', onclick: close }, T('关闭', 'Close'))
      ),
      stage,
      h('div', { class: 'preview-foot' },
        h('button', { class: 'btn sm ghost', onclick: () => step(-1) }, '‹'),
        posEl,
        dots,
        h('button', { class: 'btn sm ghost', onclick: () => step(1) }, '›')
      )
    );
    mask.addEventListener('click', (e) => { if (e.target === mask || e.target === stage) close(); });
    stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      zoom = Math.max(.25, Math.min(4, zoom + (e.deltaY < 0 ? .15 : -.15)));
      render();
    }, { passive: false });

    function onKey(e) {
      // 上层还有弹窗时，Esc / 方向键交给弹窗，别把预览一起关掉
      const mr = document.getElementById('modal-root');
      if (mr && mr.childElementCount) return;
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowLeft') step(-1);
      else if (e.key === 'ArrowRight') step(1);
      else if (e.key === '+' || e.key === '=') { zoom = Math.min(4, zoom + .25); render(); }
      else if (e.key === '-') { zoom = Math.max(.25, zoom - .25); render(); }
    }
    document.addEventListener('keydown', onKey);
    root.appendChild(mask);
    render();
  }

  const ICONS = {
    organize: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M8 12h8M8 15h5"/>',
    shots: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m4 17 4.5-4.5L13 17"/>',
    cache: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>',
    search: '<circle cx="11" cy="11" r="6"/><path d="m20 20-3.6-3.6"/>',
    rules: '<path d="M4 5h16M4 12h10M4 19h7"/><path d="m16 16 2 2 3-3"/>',
    apps: '<rect x="3" y="4" width="7" height="7" rx="1.5"/><rect x="14" y="4" width="7" height="7" rx="1.5"/><rect x="3" y="15" width="7" height="7" rx="1.5"/><rect x="14" y="15" width="7" height="7" rx="1.5"/>',
    migrate: '<path d="M4 8h11"/><path d="m12 5 3 3-3 3"/><path d="M20 16H9"/><path d="m12 13-3 3 3 3"/>',
    log: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5"/><path d="M9 13h7M9 17h5"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    archive: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/><path d="M12 8h3M12 12h3M12 16h3"/>',
    file: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 4v5h-5"/>',
    play: '<path d="M7 4l13 8-13 8z"/>',
    trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>',
    undo: '<path d="M9 7 4 12l5 5"/><path d="M4 12h10a6 6 0 0 1 6 6v1"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    check: '<path d="m4 12 5 5L20 6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    scan: '<path d="M4 8V5a1 1 0 0 1 1-1h3M20 8V5a1 1 0 0 0-1-1h-3M4 16v3a1 1 0 0 0 1 1h3M20 16v3a1 1 0 0 1-1 1h-3"/><path d="M8 12h8"/>',
    export: '<path d="M12 3v11"/><path d="m8 10 4 4 4-4"/><path d="M5 19h14"/>',
    external: '<path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m4 18 5-5 4 4 3-3 4 4"/>',
    camera: '<path d="M4 8a2 2 0 0 1 2-2h2l1.5-2h5L16 6h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><circle cx="12" cy="12.5" r="3.2"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
    paste: '<path d="M9 4H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2"/><rect x="9" y="2.5" width="6" height="4" rx="1.2"/>',
    scissors: '<circle cx="6" cy="6" r="2.4"/><circle cx="6" cy="18" r="2.4"/><path d="M20 4 8.6 15.4"/><path d="M8.6 8.6 20 20"/>',
    shield: '<path d="M12 3 5 6v6c0 4.4 3 7.6 7 9 4-1.4 7-4.6 7-9V6z"/><path d="m9 12 2 2 4-4"/>',
    more: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
    'chevrons-down': '<path d="m6 9 6 6 6-6"/><path d="m6 5 6 6 6-6"/>',
    'chevrons-up': '<path d="m6 15 6-6 6 6"/><path d="m6 19 6-6 6 6"/>',
    'chevron-left': '<path d="m14.5 6-6 6 6 6"/>',
    'chevron-right': '<path d="m9.5 6 6 6-6 6"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5 9-5z"/><path d="m3 12 9 5 9-5"/><path d="m3 16 9 5 9-5"/>',
    spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4"/><path d="m6.3 6.3 2.8 2.8M14.9 14.9l2.8 2.8M17.7 6.3l-2.8 2.8M9.1 14.9l-2.8 2.8"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><circle cx="12" cy="8" r=".9" fill="currentColor" stroke="none"/>',
    alert: '<path d="M12 4 2.8 20h18.4z"/><path d="M12 10v4"/><circle cx="12" cy="17" r=".9" fill="currentColor" stroke="none"/>',
    drive: '<rect x="3" y="5" width="18" height="7" rx="2"/><rect x="3" y="12" width="18" height="7" rx="2"/><path d="M7 8.5h.01M7 15.5h.01"/>',
    broom: '<path d="m14 4 6 6"/><path d="M13 9 5 17l-2 4 4-2 8-8z"/><path d="m9 13 2 2"/>',
    chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    filter: '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>',
    sort: '<path d="M8 5v14"/><path d="m4 15 4 4 4-4"/><path d="M16 19V5"/><path d="m12 9 4-4 4 4"/>',
    paperclip: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
    send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    'chevron-down': '<path d="m6 9 6 6 6-6"/>',
    'chevron-up': '<path d="m18 15-6-6-6 6"/>',
    'arrow-up': '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
    'level-up': '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11"/>',
    feather: '<path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z"/><path d="M16 8 2 22"/><path d="M17.5 15H9"/>',
    bulb: '<path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/>',
    brain: '<path d="M12 5a3 3 0 0 0-3 3v1a3 3 0 0 0 0 6v1a3 3 0 0 0 3 3"/><path d="M12 5a3 3 0 0 1 3 3v1a3 3 0 0 1 0 6v1a3 3 0 0 1-3 3"/><path d="M12 5v15"/>'
  };
  function icon(name, size = 16) {
    const path = ICONS[name] || ICONS.file;
    const wrap = document.createElement('span');
    wrap.className = 'ic ic-box';
    wrap.style.display = 'inline-flex';
    wrap.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" class="ic-svg ic-${name}" aria-hidden="true">${path}</svg>`;
    return wrap.firstChild;
  }

  function setActions(...nodes) {
    const box = document.getElementById('top-actions');
    if (!box) return;
    box.innerHTML = '';
    nodes.flat().forEach((n) => n && box.appendChild(n instanceof Node ? n : document.createTextNode(String(n))));
  }

  function onLangChange(fn) { langHandlers.add(fn); }
  function setLang(lang) {
    state.lang = lang === 'en-US' ? 'en-US' : 'zh-CN';
    document.documentElement.lang = state.lang;
    const I18N = {
      'app.name': ['整理助手', 'Tidy Assistant'],
      'app.slogan': ['按类型收纳，一步到位', 'Sorted by type, in one pass'],
      'status.connecting': ['正在连接引擎…', 'Connecting engine…']
    };
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const v = I18N[el.dataset.i18n];
      if (v) el.textContent = T(v[0], v[1]);
    });
    langHandlers.forEach((f) => { try { f(state.lang); } catch (e) { console.error(e); } });
  }

  /* 共享小工具：错误取文案、复制到剪贴板并提示。
     原来每个页面各写一份，这里收口，页面只留别名。 */
  function errText(e) {
    return e && e.message ? e.message : String(e);
  }

  async function copy(text) {
    const v = String(text === null || text === undefined ? '' : text);
    if (!v) return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(v);
      } else {
        // 无剪贴板 API 时用临时输入框兜底
        const ta = h('textarea', { style: { position: 'fixed', opacity: '0', top: '0', left: '0' } });
        ta.value = v;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      toast(T('已复制：', 'Copied: ') + v, 'ok');
    } catch (e) {
      toast(errText(e), 'error');
    }
  }

  /* ---------- 自定义圆角胶囊下拉框（替换原生 select，自适应防溢出翻转） ---------- */
  function customSelect({ options = [], value = '', onChange, alignUp, className = '', title = '' }) {
    let opts = options.map((it) => (typeof it === 'object' && it !== null ? it : { value: String(it), label: String(it) }));
    let curVal = value !== undefined && value !== null ? String(value) : (opts[0] ? opts[0].value : '');

    const labelSpan = h('span', { class: 'custom-select-label' });
    const arrowSpan = h('span', { class: 'custom-select-arrow', html: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>' });
    const trigger = h('button', {
      type: 'button',
      class: 'custom-select-trigger',
      'aria-haspopup': 'listbox',
      'aria-expanded': 'false',
      title: title || ''
    }, labelSpan, arrowSpan);

    const menuEl = h('div', { class: 'custom-select-menu', role: 'listbox' });
    const wrap = h('div', { class: 'custom-select ' + className }, trigger, menuEl);

    function updateLabel() {
      const match = opts.find((o) => String(o.value) === String(curVal));
      labelSpan.textContent = match ? match.label : curVal;
      Array.from(menuEl.children).forEach((child) => {
        child.classList.toggle('selected', child.dataset.value === String(curVal));
      });
    }

    function renderMenu() {
      menuEl.innerHTML = '';
      opts.forEach((o) => {
        const item = h('div', {
          class: 'custom-select-item' + (String(o.value) === String(curVal) ? ' selected' : ''),
          dataset: { value: String(o.value) },
          role: 'option',
          onclick: (e) => {
            e.stopPropagation();
            setValue(o.value, true);
            closeMenu();
          }
        }, h('span', null, o.label));
        menuEl.appendChild(item);
      });
      updateLabel();
    }

    function setValue(val, emitChange) {
      const s = String(val);
      if (s === curVal && !emitChange) return;
      curVal = s;
      updateLabel();
      if (emitChange && onChange) {
        try { onChange(curVal); } catch (err) { console.error(err); }
      }
    }

    function openMenu() {
      // 判定向上弹出还是向下弹出：默认向下展开；当下方空间不足且上方空间更宽敞时自适应翻转
      const rect = trigger.getBoundingClientRect();
      const menuHeight = 180;
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      let needUp = false;
      if (alignUp === true) {
        needUp = true;
      } else if (alignUp === false) {
        needUp = false;
      } else {
        needUp = (spaceBelow < menuHeight && spaceAbove > spaceBelow);
      }
      wrap.classList.toggle('open-up', !!needUp);

      // 水平防裁切自适应：若靠近视口右侧边缘，靠右对齐展开
      const spaceRight = window.innerWidth - rect.left;
      const needRight = (spaceRight < 120 && rect.right > 120);
      wrap.classList.toggle('align-right', !!needRight);

      wrap.classList.add('open');
      trigger.setAttribute('aria-expanded', 'true');
    }

    function closeMenu() {
      wrap.classList.remove('open');
      trigger.setAttribute('aria-expanded', 'false');
    }

    trigger.onclick = (e) => {
      e.stopPropagation();
      if (wrap.classList.contains('open')) closeMenu();
      else {
        // 先关掉页面其它自定义下拉
        document.querySelectorAll('.custom-select.open').forEach((el) => { if (el !== wrap) el.classList.remove('open'); });
        openMenu();
      }
    };

    wrap.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closeMenu(); }
    });

    renderMenu();

    Object.defineProperty(wrap, 'value', {
      get() { return curVal; },
      set(v) { setValue(v, false); }
    });
    wrap.setOptions = (newOpts) => {
      opts = newOpts.map((it) => (typeof it === 'object' && it !== null ? it : { value: String(it), label: String(it) }));
      renderMenu();
    };
    wrap.setValue = (v) => setValue(v, false);

    return wrap;
  }

  // 全局点击收起自定义 select
  document.addEventListener('click', () => {
    document.querySelectorAll('.custom-select.open').forEach((el) => el.classList.remove('open'));
  });

  /* ---------- 全局深色精致胶囊 Tooltip ---------- */
  let tooltipInited = false;
  function initGlobalTooltip() {
    if (tooltipInited) return;
    tooltipInited = true;

    const tip = h('div', { id: 'global-tooltip', class: 'global-tooltip-pill', 'aria-hidden': 'true' });
    document.body.appendChild(tip);

    let activeEl = null;
    let timer = null;

    function hide() {
      if (timer) { clearTimeout(timer); timer = null; }
      activeEl = null;
      tip.classList.remove('on');
    }

    function show(el, text) {
      if (!text || !el || !document.body.contains(el)) { hide(); return; }
      activeEl = el;
      tip.textContent = text;
      tip.classList.remove('on');

      // 计算位置：居中对齐，优先在上方，上方放不下放下方
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;

      const tipW = tip.offsetWidth || 120;
      const tipH = tip.offsetHeight || 26;

      let left = rect.left + rect.width / 2 - tipW / 2;
      left = Math.max(8, Math.min(window.innerWidth - tipW - 8, left));

      let top = rect.top - tipH - 6;
      if (top < 6) {
        top = rect.bottom + 6; // 翻到下方
      }

      tip.style.left = Math.round(left) + 'px';
      tip.style.top = Math.round(top) + 'px';
      tip.classList.add('on');
    }

    const NOISE_PREFIX = /^(只看|切换到|切换|查看|点击|显示|选择|打开|show\s+|switch\s+to\s+|view\s+|select\s+|click\s+to\s+)/i;

    function shouldDisplayTip(host, text) {
      if (!text) return false;
      if (host.hasAttribute('data-no-tip')) return false;
      if (host.hasAttribute('data-tip')) return true;

      const inner = (host.innerText || host.textContent || '').trim();
      if (!inner) {
        return true; // 纯图标或无文本：展示以消除不确定性
      }

      // 物理截断检查：长路径或文本被省略号截断时，必须完整展示
      if (host.scrollWidth > host.clientWidth + 1) {
        return true;
      }

      const cleanTip = text.replace(NOISE_PREFIX, '').trim().toLowerCase();
      const cleanInner = inner.toLowerCase();

      // 零信息增量判定：剔除动词噪音后与控件文字相同，坚决不显示
      if (cleanTip === cleanInner || text.trim().toLowerCase() === cleanInner) {
        return false;
      }

      // 增量文本显著较长（附带业务约束、不可逆后果或操作说明）：放行
      if (text.length > inner.length + 4) {
        return true;
      }

      return true;
    }

    document.addEventListener('pointerover', (e) => {
      const t = e.target;
      if (!t || !(t instanceof Element)) return;
      // 排除输入框、富文本、下拉框以及 tooltip 自身
      if (t.id === 'global-tooltip' || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return;

      const host = t.closest('[title], [data-tip], [data-global-tip]');
      if (!host) { hide(); return; }

      // 提取文字并抹除原生 title（防止操作系统黑色方块遮挡）
      // 同时保全无障碍：若无显式 aria-label，则自动镜像注入，保证屏幕阅读器正常播报
      if (host.hasAttribute('title')) {
        const raw = host.getAttribute('title');
        if (raw) {
          host.dataset.globalTip = raw;
          if (!host.hasAttribute('aria-label')) {
            host.setAttribute('aria-label', raw);
          }
        }
        host.removeAttribute('title');
      }

      const text = host.dataset.globalTip || host.dataset.tip;
      if (!text) { hide(); return; }

      // 第一性原理信息增量过滤
      if (!shouldDisplayTip(host, text)) {
        hide();
        return;
      }

      if (activeEl === host) return;
      if (timer) clearTimeout(timer);

      // 人机工程延时 220ms，与 --dur-3 动效节奏一致，避免快速划过时视觉闪烁
      timer = setTimeout(() => show(host, text), 220);
    }, true);

    document.addEventListener('pointerout', (e) => {
      const rel = e.relatedTarget;
      if (activeEl && (!rel || !activeEl.contains(rel))) {
        hide();
      }
    }, true);

    document.addEventListener('click', hide, true);
    document.addEventListener('scroll', hide, true);
    window.addEventListener('blur', hide);
  }

  window.UI = {
    h, T, fmtBytes, fmtSize: fmtBytes, fmtCount, fmtTime, fmtDateTime, toast, confirm: confirmBox, busy,
    skeleton, loader, softIn, empty, card, section, table, icon, state, setActions, setLang, onLangChange,
    menu, attachMenu, closeMenu, modal, preview, closePreview,
    pageSize, pageSizePick, PAGE_SIZES,
    errText, copy,
    customSelect, initGlobalTooltip
  };
})();
