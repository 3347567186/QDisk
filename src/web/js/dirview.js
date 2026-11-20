/* 应用内目录浏览：在「空间工具」里一层层看文件夹，不用跳系统资源管理器。
   为什么要单独做一个：整理跑完之后文件被移进 01_安装包程序 这类分类子文件夹，
   而应用里没有任何地方能看见它们 —— 结果位置的入口只会调系统资源管理器，
   用户根本不知道东西去哪了，也不敢确认能不能删。

   这里只读，不提供任何删除/移动动作（除了右键「在资源管理器里显示」），
   删改全部留在各自的页面（空文件夹清理、整理文件）里做，
   免得看目录的地方顺手就能毁数据。 */
(function (root) {
  'use strict';
  const { h, T, icon, fmtBytes, fmtCount, toast, attachMenu } = UI;
  const errText = UI.errText;

  const PAGE = 200;                 // 与 Rust list_dir 的 cap 上限一致
  const EXEC_EXT = ['exe', 'msi', 'msix', 'appx', 'bat', 'cmd', 'com', 'scr', 'ps1', 'vbs', 'js', 'jar', 'lnk'];

  function stripSlash(p) {
    return String(p || '').replace(/[\\/]+$/, '');
  }

  function isDriveRoot(p) {
    return /^[A-Za-z]:\\?$/.test(String(p || ''));
  }

  function parentOf(p) {
    const s = stripSlash(p);
    if (!s || isDriveRoot(s)) return '';
    const cut = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
    if (cut <= 0) return '';
    const head = s.slice(0, cut);
    return /^[A-Za-z]:$/.test(head) ? head + '\\' : head;
  }

  function joinDir(base, name) {
    const b = stripSlash(base);
    if (!b) return name;
    const sep = b.indexOf('/') >= 0 && b.indexOf('\\') < 0 ? '/' : '\\';
    return b + sep + name;
  }

  function crumbsOf(p) {
    const s = String(p || '');
    const m = s.match(/^([A-Za-z]:)[\\/]?/);
    const out = [];
    let rest = s;
    if (m) { out.push({ name: m[1] + '\\', path: m[1] + '\\' }); rest = s.slice(m[0].length); }
    else if (/^\\\\/.test(s)) {
      /* UNC：\\主机\共享\... 前两段是根，单独作为第一颗面包屑 */
      const parts = s.replace(/^\\\\/, '').split(/[\\/]+/).filter(Boolean);
      if (parts.length) {
        out.push({ name: '\\\\' + parts[0], path: '\\\\' + parts[0] });
        if (parts.length > 1) out.push({ name: parts[1], path: '\\\\' + parts[0] + '\\' + parts[1] });
        rest = parts.slice(2).join('\\');
        if (rest) rest = '\\' + rest;
      }
    }
    rest.split(/[\\/]+/).filter(Boolean).forEach((seg) => {
      const prev = out.length ? stripSlash(out[out.length - 1].path) : '';
      out.push({ name: seg, path: prev ? prev + '\\' + seg : seg });
    });
    return out;
  }

  function extOf(name) {
    const s = String(name || '');
    const i = s.lastIndexOf('.');
    return i > 0 ? s.slice(i + 1).toLowerCase() : '';
  }

  function isExec(name) {
    return EXEC_EXT.indexOf(extOf(name)) >= 0;
  }

  function create(host, opts) {
    const o = opts || {};
    let dir = '';
    let items = [];
    let nextOffset = 0;
    let total = 0;
    let dirsN = 0;
    let filesN = 0;
    let truncated = false;
    let busy = false;
    let err = '';
    let alive = true;
    let hitPath = '';
    const rowOf = new Map();       // path(小写) → 行节点，highlight 用

    /* ---------- 骨架 ---------- */
    const upBtn = h('button', { class: 'btn ghost sm dv-icon', type: 'button', title: T('上一层', 'Up one level'), 'aria-label': T('上一层', 'Up one level') }, icon('chevron', 14));
    const refreshBtn = h('button', { class: 'btn ghost sm dv-icon', type: 'button', title: T('刷新', 'Refresh'), 'aria-label': T('刷新', 'Refresh') }, icon('refresh', 14));
    const pathIn = h('input', { class: 'input dv-path', type: 'text', spellcheck: 'false', placeholder: T('输入或粘贴一个文件夹路径', 'Type or paste a folder path') });
    const pickBtn = h('button', { class: 'btn sm', type: 'button' }, icon('folder', 14), T('选择', 'Browse'));
    const crumbBox = h('div', { class: 'dv-crumbs' });
    const metaBox = h('div', { class: 'dv-meta' });
    const listBox = h('div', { class: 'dv-list' });
    const moreBtn = h('button', { class: 'btn ghost sm dv-more', type: 'button', hidden: true }, T('加载更多', 'Load more'));
    const stateBox = h('div', { class: 'dv-state', hidden: true });

    const bar = h('div', { class: 'dv-bar' }, upBtn, refreshBtn, pathIn, pickBtn);
    const el = h('div', { class: 'dv' });
    el.appendChild(bar);
    el.appendChild(crumbBox);
    el.appendChild(metaBox);
    el.appendChild(stateBox);
    el.appendChild(listBox);
    el.appendChild(moreBtn);

    /* ---------- 状态展示 ---------- */
    function paintMeta() {
      metaBox.replaceChildren();
      if (busy && !items.length) {
        metaBox.appendChild(h('span', { class: 'small muted' }, T('正在读取目录…', 'Reading folder…')));
        return;
      }
      if (!dir) {
        metaBox.appendChild(h('span', { class: 'small muted' }, T('还没有选目录', 'No folder yet')));
        return;
      }
      metaBox.appendChild(h('span', { class: 'small muted' },
        T(fmtCount(dirsN) + ' 个文件夹 · ' + fmtCount(filesN) + ' 个文件 · 共 ' + fmtCount(total) + ' 项',
          fmtCount(dirsN) + ' folders · ' + fmtCount(filesN) + ' files · ' + fmtCount(total) + ' entries')));
      /* 一页只读 200 项。不把这件事说出来，用户翻不到第 201 项时
         会以为文件不存在 —— 之前 @ 候选就是这么骗了他一次。 */
      if (truncated) {
        metaBox.appendChild(h('span', { class: 'badge' },
          T('已显示 ' + fmtCount(items.length) + ' / ' + fmtCount(total) + ' 项',
            fmtCount(items.length) + ' of ' + fmtCount(total) + ' shown')));
      }
      if (busy && items.length) {
        metaBox.appendChild(h('span', { class: 'small muted' }, T('读取中…', 'Loading…')));
      }
    }

    function paintState() {
      stateBox.replaceChildren();
      if (err) {
        stateBox.hidden = false;
        stateBox.appendChild(h('div', { class: 'dv-err' },
          h('span', null, err),
          h('button', { class: 'btn ghost sm', type: 'button', onclick: () => load(0) }, T('重试', 'Retry'))));
        return;
      }
      if (!dir) {
        stateBox.hidden = false;
        stateBox.appendChild(h('div', { class: 'dv-hint' },
          T('选一个文件夹，或者从「结果位置」「大文件」点「在应用内看」直接进来。',
            'Pick a folder, or arrive here from a result chip.')));
        return;
      }
      if (!busy && !items.length) {
        stateBox.hidden = false;
        stateBox.appendChild(h('div', { class: 'dv-hint' }, T('这个文件夹是空的', 'This folder is empty')));
        return;
      }
      stateBox.hidden = true;
    }

    /* ---------- 行 ---------- */
    function rowOfItem(it) {
      const name = it.name || '';
      const path = joinDir(dir, name);
      const isDir = it.kind === 'dir';
      const row = h('div', {
        class: 'dv-row' + (isDir ? ' is-dir' : ' is-file'),
        tabindex: '0',
        dataset: { path: path.toLowerCase(), name: name }
      });
      row.appendChild(h('span', { class: 'dv-ico' }, icon(isDir ? 'folder' : 'file', 14)));
      row.appendChild(h('span', { class: 'dv-name ellipsis', title: path }, name));
      if (!isDir) {
        row.appendChild(h('span', { class: 'dv-ext muted small' }, it.ext ? '.' + it.ext : ''));
        row.appendChild(h('span', { class: 'dv-size num muted small' }, fmtBytes(it.size || 0)));
      }
      row.appendChild(h('span', { class: 'dv-time muted small num' },
        it.mtime ? new Date(Number(it.mtime) * 1000).toLocaleString() : ''));

      const openIt = () => {
        if (isDir) { setPath(path); return; }
        /* 可执行文件只定位不运行 —— 在目录浏览里顺手双击一个 setup.exe
           就真的装起来，这个后果没人愿意承担。 */
        if (isExec(name)) {
          API.reveal(path);
          toast(T('这是可执行文件，已定位但没有运行它', 'This is an executable; located but not run'), 'warn');
          return;
        }
        Promise.resolve(API.openPath(path)).catch((e) => toast(errText(e), 'error'));
      };
      row.addEventListener('dblclick', openIt);
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); openIt(); }
      });
      row.addEventListener('click', () => {
        listBox.querySelectorAll('.dv-row[data-sel]').forEach((n) => n.removeAttribute('data-sel'));
        row.setAttribute('data-sel', '');
      });
      if (typeof attachMenu === 'function') {
        attachMenu(row, () => [
          isDir
            ? { label: T('打开这个文件夹', 'Open folder'), icon: 'folder', action: () => setPath(path) }
            : { label: T('用默认程序打开', 'Open with default app'), icon: 'file', action: openIt },
          { label: T('在资源管理器里显示', 'Show in Explorer'), icon: 'external', action: () => API.reveal(path) },
          { label: T('复制完整路径', 'Copy full path'), icon: 'copy', action: () => { try { UI.copy(path); } catch (e) { toast(path); } } },
          { sep: true },
          { label: T('问助手：这个能删吗', 'Ask: can I delete this'), icon: 'spark', action: () => { if (root.AIDrawer) root.AIDrawer.open({ title: T('问助手 · 这个文件', 'Ask · this file'), question: T('这个文件能删吗：', 'Can I delete ') + path }); } }
        ]);
      }
      rowOf.set(path.toLowerCase(), row);
      return row;
    }

    function paintList() {
      listBox.replaceChildren();
      rowOf.clear();
      items.forEach((it) => listBox.appendChild(rowOfItem(it)));
      moreBtn.hidden = !truncated;
      if (hitPath) highlight(hitPath);
    }

    /* ---------- 读取 ---------- */
    function applyRes(res, append) {
      const got = (res && res.items) || [];
      items = append ? items.concat(got) : got;
      total = Number(res && res.total) || items.length;
      dirsN = Number(res && res.dirs);
      filesN = Number(res && res.files);
      if (!isFinite(dirsN)) dirsN = items.filter((x) => x.kind === 'dir').length;
      if (!isFinite(filesN)) filesN = items.filter((x) => x.kind !== 'dir').length;
      truncated = !!(res && res.truncated);
      nextOffset = (Number(res && res.offset) || 0) + (Number(res && res.shown) || got.length);
    }

    function load(offset) {
      if (!alive || busy) return;
      if (!dir) { paintMeta(); paintState(); return; }
      busy = true;
      err = '';
      if (!offset) { items = []; truncated = false; nextOffset = 0; hitPath = ''; }
      paintMeta();
      paintState();
      paintList();
      const at = offset || 0;
      Promise.resolve()
        .then(() => API.listDir(dir, PAGE, at))
        .then((res) => { applyRes(res, at > 0); })
        .catch((e) => { err = errText(e); })
        .then(() => {
          busy = false;
          if (!alive) return;
          paintMeta();
          paintState();
          paintList();
          paintCrumbs();
          moreBtn.hidden = !truncated;
        });
    }

    /* ---------- 面包屑 ---------- */
    function paintCrumbs() {
      crumbBox.replaceChildren();
      const list = crumbsOf(dir);
      if (!list.length) return;
      list.forEach((c, i) => {
        if (i) crumbBox.appendChild(h('span', { class: 'dv-crumb-sep' }, icon('chevron', 11)));
        crumbBox.appendChild(h('button', {
          class: 'dv-crumb' + (i === list.length - 1 ? ' is-here' : ''),
          type: 'button',
          title: c.path,
          onclick: () => setPath(c.path)
        }, c.name));
      });
    }

    /* ---------- 对外 ---------- */
    function setPath(p) {
      const next = stripSlash(String(p || '').trim());
      if (!next) return;
      dir = isDriveRoot(next) ? next.replace(/[\\/]+$/, '') + '\\' : next;
      pathIn.value = dir.replace(/\\+$/, isDriveRoot(dir) ? '\\' : '');
      hitPath = '';
      load(0);
    }

    function highlight(p) {
      const want = String(p || '').toLowerCase();
      if (!want) return;
      /* 目录本身就是当前路径时，标记「你就是这里」 */
      if (stripSlash(want) === stripSlash(dir).toLowerCase()) {
        el.setAttribute('data-here', '');
        return;
      }
      /* rowOf 的键是「小写完整路径」，所以查的时候也要小写 */
      const row = rowOf.get(stripSlash(want));
      if (!row) {
        /* 只给到目录一级、但当前列的是它的父目录时，把同名那一行点亮 */
        const base = String(p || '').split(/[\\/]/).filter(Boolean).pop();
        const loose = base ? rowOf.get(String(base).toLowerCase()) : null;
        if (loose) { mark(loose); return; }
        return;
      }
      mark(row);
    }

    function mark(row) {
      listBox.querySelectorAll('.dv-row[data-hit]').forEach((n) => n.removeAttribute('data-hit'));
      row.setAttribute('data-hit', '');
      try { row.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { row.scrollIntoView(); }
    }

    function showPath(p, hit) {
      setPath(p);
      if (hit) {
        hitPath = String(hit);
        /* 数据回来之后 paintList 会自己调 highlight */
      }
    }

    upBtn.addEventListener('click', () => {
      const up = parentOf(dir);
      if (up) setPath(up);
    });
    refreshBtn.addEventListener('click', () => load(0));
    moreBtn.addEventListener('click', () => load(nextOffset));
    pickBtn.addEventListener('click', () => {
      Promise.resolve(API.pickFolder(dir)).then((p) => { if (p) setPath(p); }).catch(() => {});
    });
    pathIn.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      setPath(pathIn.value);
    });

    /* 初始目录可以直接给；调用方也可以先建再看 setPath */
    if (o.dir) setPath(o.dir); else { paintMeta(); paintState(); }

    host.appendChild(el);

    return {
      el: el,
      getPath: function () { return dir; },
      setPath: setPath,
      showPath: showPath,
      refresh: function () { load(0); },
      highlight: highlight,
      destroy: function () {
        alive = false;
        rowOf.clear();
        try { el.remove(); } catch (e) {}
      }
    };
  }

  root.DirView = { create: create, parentOf: parentOf, joinDir: joinDir, crumbsOf: crumbsOf };
})(window);