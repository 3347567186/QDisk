/* 回合导航条：右侧一列短刻度，一条代表一个回合，点一下跳到那一轮。
 *
 * 刻度不是等高列表，而是「固定 10px 间距」的刻度尺：内容再多也不变形，
 * 高了就在框里滚。鼠标悬停才出预览（第一行提问、第二行回答开头），
 * 无文字标签；键盘是原生按钮，Tab 逐个走。
 */
(function (root) {
  'use strict';

  var PITCH = 10;        // 相邻刻度的固定间距
  var INSET = 6;         // 首尾留白
  var MIN_TURNS = 2;     // 少于两条不显示
  var NARROW = 900;      // 窄于此宽度隐藏

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function clip(s, n) {
    s = (s || '').replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  function create(opts) {
    var host = opts.host;                 // position:relative 的容器
    var onNavigate = opts.onNavigate || function () {};

    var nav = el('nav', 'ai-tnav');
    nav.setAttribute('aria-label', '轮次导航');
    var frame = el('div', 'ai-tnav-frame');
    var scroller = el('div', 'ai-tnav-scroll');
    var list = el('div', 'ai-tnav-list');
    var preview = el('div', 'ai-tnav-pop');
    preview.setAttribute('role', 'tooltip');
    preview.setAttribute('aria-hidden', 'true');

    scroller.appendChild(list);
    frame.appendChild(scroller);
    nav.appendChild(frame);
    nav.appendChild(preview);
    host.appendChild(nav);

    var turns = [];
    var active = -1;
    var hovering = -1;

    function paintMarks() {
      list.textContent = '';
      turns.forEach(function (t, i) {
        var b = el('button', 'ai-tnav-mark');
        b.type = 'button';
        b.setAttribute('aria-label', '跳转到第 ' + (i + 1) + ' 轮');
        if (i === active) b.setAttribute('aria-current', 'true');
        b.dataset.turn = String(i);
        b.style.top = (INSET + i * PITCH) + 'px';
        b.addEventListener('click', function () {
          /* 点完就收起预览：按钮拿到焦点后会触发 focus 预览，不主动收掉就会
             一直挂着一块「我上一轮问了什么」的浮层，看起来像是界面没关干净。 */
          hidePreview();
          onNavigate(i);
        });
        b.addEventListener('pointerenter', function () { showPreview(i); });
        b.addEventListener('focus', function (e) {
          /* 只有键盘聚焦才出预览；鼠标点出来的焦点不算 */
          if (e.target.matches && e.target.matches(':focus-visible')) showPreview(i);
        });
        b.addEventListener('pointerleave', hidePreview);
        b.addEventListener('blur', hidePreview);
        list.appendChild(b);
      });
      list.style.height = (INSET * 2 + Math.max(0, turns.length - 1) * PITCH + 10) + 'px';
      nav.hidden = turns.length < MIN_TURNS;
      refreshFades();
    }

    function marks() {
      return list.children;
    }

    function setActive(i) {
      if (i === active) return;
      active = i;
      var list2 = marks();
      for (var k = 0; k < list2.length; k++) {
        if (k === i) list2[k].setAttribute('aria-current', 'true');
        else list2[k].removeAttribute('aria-current');
      }
      centerActive();
      onChangePreview();
    }

    function centerActive() {
      if (active < 0 || hovering >= 0) return;
      var h = scroller.clientHeight;
      if (!h) return;
      var y = INSET + active * PITCH;
      var top = y - h / 2 + 6;
      var max = Math.max(0, list.offsetHeight - h);
      scroller.scrollTop = Math.max(0, Math.min(top, max));
      refreshFades();
    }

    function refreshFades() {
      var canUp = scroller.scrollTop > 1;
      var canDown = scroller.scrollTop < list.offsetHeight - scroller.clientHeight - 1;
      scroller.classList.toggle('fade-top', canUp);
      scroller.classList.toggle('fade-bottom', !!canDown);
    }

    function row(cls, text) {
      var r = el('div', 'ai-tnav-row');
      r.appendChild(el('span', 'ai-tnav-' + cls, text));
      r.appendChild(el('i', 'ai-tnav-tick'));
      return r;
    }

    function showPreview(i) {
      hovering = i;
      var t = turns[i];
      if (!t) return;
      preview.textContent = '';
      /* 统计单独一行压在卡顶（参考图里那串 +21 −1 的位置），
         两行正文因此能各占满整宽；行尾那一小截是刻度笔触。 */
      if (t.meta) preview.appendChild(el('div', 'ai-tnav-stat', t.meta));
      preview.appendChild(row('q', clip(t.prompt, 80) || ('第 ' + (i + 1) + ' 轮')));
      if (t.answer) preview.appendChild(row('a', clip(t.answer, 160)));
      var mark = marks()[i];
      /* 刻度是绝对定位在居中的列表里，offsetTop 只是列表内坐标；
         预览挂在 nav 上，得换成 nav 内的中心点，否则会飘到最上面。 */
      var mr = mark ? mark.getBoundingClientRect() : null;
      var nr = nav.getBoundingClientRect();
      var c = mr ? (mr.top - nr.top + mr.height / 2) : (INSET + i * PITCH);
      preview.style.setProperty('--rail-c', c + 'px');
      preview.classList.add('on');
      preview.setAttribute('aria-hidden', 'false');
    }

    function hidePreview() {
      hovering = -1;
      preview.classList.remove('on');
      preview.setAttribute('aria-hidden', 'true');
      if (preview.parentNode === nav) preview.style.removeProperty('--rail-c');
      centerActive();
    }

    function onChangePreview() { /* 预留：当前轮变化时可以同步预览 */ }

    scroller.addEventListener('scroll', refreshFades, { passive: true });

    var ro = typeof ResizeObserver === 'function'
      ? new ResizeObserver(function () { centerActive(); })
      : null;
    if (ro) ro.observe(nav);

    return {
      setTurns: function (list2) {
        /* 换了内容先把浮层收掉：刻度重画时预览若还挂着，会显示上一轮的问题 */
        hidePreview();
        turns = list2 || [];
        if (!turns.length) active = -1;
        else if (active >= turns.length) active = turns.length - 1;
        paintMarks();
        centerActive();
      },
      setActive: setActive,
      width: function () { return nav.getBoundingClientRect().width; },
      visible: function () { return !nav.hidden && window.innerWidth > NARROW; },
      destroy: function () {
        if (ro) ro.disconnect();
        if (nav.parentNode) nav.parentNode.removeChild(nav);
      }
    };
  }

  root.AITurnRail = { create: create };
  if (typeof module === 'object' && module.exports) module.exports = root.AITurnRail;
})(typeof self !== 'undefined' ? self : this);
