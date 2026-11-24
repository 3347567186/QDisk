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
  const EXEC_EXT = ['exe', 'msi', 'msix', 'appx', 'bat', 'cmd', 'com', 'scr', 'ps1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'jar', 'lnk', 'reg', 'hta'];
  const IMG_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif'];
  const TEXT_EXT = ['txt', 'log', 'md', 'json', 'yaml', 'yml', 'ini', 'cfg', 'conf', 'xml', 'csv', 'tsv', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'html', 'htm', 'css', 'scss', 'toml', 'sql', 'sh', 'env', 'gitignore'];
  const ARCHIVE_RE = /\.(?:tar\.(?:gz|bz2|xz|zst)|zip|rar|7z|tar|tgz|tbz2|txz|gz|bz2|xz|zst)$/i;

  function isImage(name) { return IMG_EXT.indexOf(extOf(name)) >= 0; }
  function isTextFile(name) { return TEXT_EXT.indexOf(extOf(name)) >= 0; }
  function isArchive(name) { return ARCHIVE_RE.test(String(name || '')); }
  function stemOf(name) {
    const s = String(name || '');
    const i = s.lastIndexOf('.');
    return i > 0 ? s.slice(0, i) : s;
  }

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

  /* 时间列窄，`toLocaleString()` 的结果（2026/11/20 17:05:54）在真机上折成两行。
     压成 MM-DD HH:mm，只有不是今年的才带年份。 */
  function fmtWhen(ts) {
    const n = Number(ts);
    if (!n) return '';
    const d = new Date(n * 1000);
    const pad = (v) => (v < 10 ? '0' + v : String(v));
    const md = pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    const hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
    return d.getFullYear() === new Date().getFullYear()
      ? md + ' ' + hm
      : d.getFullYear() + '-' + md;
  }

  function create(host, opts) {
    const o = opts || {};
    let dir = '';
    let items = [];
    let pageOffset = 0;
    let nextOffset = 0;
    let total = 0;
    let unfilteredTotal = 0;
    let dirsN = 0;
    let filesN = 0;
    let hasPrev = false;
    let truncated = false;
    let locatedIdx = -1;
    let busy = false;
    let busyAppend = false;
    let err = '';
    let alive = true;
    let hitPath = '';
    let focusedItem = null;        // { path, name, kind, size, ext }
    let notice = null;             // { accessDenied, requestedPath, missingTarget }
    let filterText = '';
    let filterTimer = 0;
    let reqSeq = 0;
    const rowOf = new Map();       // path(小写) → 行节点，highlight 用

    /* ---------- 骨架 ---------- */
    const upBtn = h('button', { class: 'btn ghost sm dv-icon dv-up-btn', type: 'button', title: T('上一层', 'Up one level'), 'aria-label': T('上一层', 'Up one level') }, icon('level-up', 14));
    const refreshBtn = h('button', { class: 'btn ghost sm dv-icon dv-refresh-btn', type: 'button', title: T('刷新', 'Refresh'), 'aria-label': T('刷新', 'Refresh') }, icon('refresh', 14));
    const pathIn = h('input', { class: 'input dv-path', type: 'text', spellcheck: 'false', placeholder: T('输入或粘贴一个文件夹路径', 'Type or paste a folder path') });
    const pickBtn = h('button', { class: 'btn sm', type: 'button' }, icon('folder', 14), T('选择', 'Browse'));
    const extDirBtn = h('button', {
      class: 'btn sm ghost dv-ext-btn',
      type: 'button',
      title: T('在系统文件管理器中打开当前目录或定位选中项', 'Open current folder or reveal selected item in Explorer')
    }, icon('external', 14), h('span', null, T('系统文件管理器', 'Explorer')));

    const filterIn = h('input', {
      class: 'input dv-filter',
      type: 'text',
      spellcheck: 'false',
      placeholder: T('在当前目录内筛选文件名（支持超 200 项全量过滤）…', 'Filter files in this folder…')
    });
    const filterClearBtn = h('button', {
      class: 'btn ghost sm dv-filter-clear',
      type: 'button',
      hidden: true,
      title: T('清空筛选', 'Clear filter'),
      'aria-label': T('清空筛选', 'Clear filter')
    }, icon('close', 12));
    const filterRow = h('div', { class: 'dv-filter-row' }, icon('search', 13), filterIn, filterClearBtn);

    const crumbBox = h('div', { class: 'dv-crumbs' });
    const noticeBox = h('div', { class: 'dv-notice', hidden: true });
    const focusBox = h('div', { class: 'dv-focus-bar', hidden: true });
    const metaBox = h('div', { class: 'dv-meta' });
    const prevBtn = h('button', { class: 'btn ghost sm dv-more', type: 'button', hidden: true }, T('加载前一批', 'Load previous'));
    const listBox = h('div', { class: 'dv-list' });
    const moreBtn = h('button', { class: 'btn ghost sm dv-more', type: 'button', hidden: true }, T('加载更多', 'Load more'));
    const stateBox = h('div', { class: 'dv-state', hidden: true });

    const bar = h('div', { class: 'dv-bar' }, upBtn, refreshBtn, pathIn, pickBtn, extDirBtn);
    const el = h('div', { class: 'dv' });
    el.appendChild(bar);
    el.appendChild(crumbBox);
    el.appendChild(filterRow);
    el.appendChild(noticeBox);
    el.appendChild(focusBox);
    el.appendChild(metaBox);
    el.appendChild(stateBox);
    el.appendChild(prevBtn);
    el.appendChild(listBox);
    el.appendChild(moreBtn);

    /* ---------- 辅助操作 ---------- */
    async function previewTextModal(path, name) {
      try {
        const text = await API.readText(path, 120000);
        const body = h('div', { class: 'stack' },
          h('div', { class: 'small muted mono ellipsis', title: path }, path),
          h('pre', { class: 'dv-text-pre' }, String(text == null ? '' : text))
        );
        UI.modal({
          title: name || T('文件内容预览', 'File preview'),
          wide: true,
          body: body,
          buttons: [
            { id: 'copy', label: T('复制内容', 'Copy text'), kind: 'ghost' },
            { id: 'reveal', label: T('系统文件管理器', 'Explorer'), kind: 'ghost' },
            { id: 'close', label: T('关闭', 'Close'), kind: 'primary' }
          ],
          onAction: (id) => {
            if (id === 'copy') { UI.copy(String(text == null ? '' : text)); return false; }
            if (id === 'reveal') { revealSafe(path); return false; }
            return true;
          }
        });
      } catch (e) {
        toast(errText(e), 'error');
      }
    }

    function revealSafe(p) {
      if (!p) return;
      if (root.AIEntries && typeof root.AIEntries.reveal === 'function') {
        root.AIEntries.reveal(p);
      } else {
        Promise.resolve(API.reveal(p)).catch((e) => toast(errText(e), 'error'));
      }
    }

    function openDefaultAppSafe(p) {
      if (!p) return;
      if (root.AIEntries && typeof root.AIEntries.openSystemApp === 'function') {
        root.AIEntries.openSystemApp(p);
        return;
      }
      if (isExec(p)) {
        toast(T('这是可执行文件，为防误运行仅支持定位，不直接启动', 'Executable blocked from direct launch'), 'warn');
        return;
      }
      Promise.resolve(API.openPath(p)).catch((e) => toast(errText(e), 'error'));
    }

    async function restartAsAdminFor(targetPath) {
      try {
        await API.configSet({
          pending_jump: {
            openPath: targetPath,
            ts: Date.now()
          }
        });
      } catch (_) {}
      try {
        await API.runAsAdmin();
      } catch (e) {
        toast(errText(e), 'error');
      }
    }

    /* ---------- 权限 / 缺失兜底横幅 ---------- */
    function paintNotice() {
      noticeBox.replaceChildren();
      if (!notice || (!notice.accessDenied && !notice.missingTarget)) {
        noticeBox.hidden = true;
        return;
      }
      noticeBox.hidden = false;
      if (notice.accessDenied) {
        const req = notice.requestedPath || dir;
        noticeBox.className = 'dv-notice is-warn';
        noticeBox.appendChild(h('div', { class: 'dv-notice-text' },
          icon('shield', 14),
          h('span', null, T(
            '受 Windows 系统权限保护，无法直接读取「' + req + '」，已自动打开最近可浏览的上级目录。',
            'Protected by Windows ACL: cannot list "' + req + '". Opened the nearest accessible parent folder.'
          ))));
        noticeBox.appendChild(h('div', { class: 'dv-notice-acts' },
          h('button', {
            class: 'btn sm primary',
            type: 'button',
            onclick: () => restartAsAdminFor(req)
          }, icon('shield', 13), T('以管理员身份重启并继续定位', 'Restart as admin & locate')),
          h('button', {
            class: 'btn sm ghost',
            type: 'button',
            onclick: () => revealSafe(req)
          }, icon('external', 13), T('尝试用系统文件管理器打开', 'Try in Explorer')),
          h('button', {
            class: 'btn sm ghost',
            type: 'button',
            onclick: () => { notice = null; paintNotice(); }
          }, T('收起', 'Dismiss'))
        ));
        return;
      }
      if (notice.missingTarget) {
        const miss = notice.missingTarget;
        noticeBox.className = 'dv-notice is-info';
        noticeBox.appendChild(h('div', { class: 'dv-notice-text' },
          icon('folder', 14),
          h('span', null, T(
            '目标位置已不存在：「' + miss + '」，已为你打开最近存在的上级目录。',
            'Target missing: "' + miss + '". Opened the nearest existing parent folder.'
          ))));
        noticeBox.appendChild(h('div', { class: 'dv-notice-acts' },
          h('button', {
            class: 'btn sm ghost',
            type: 'button',
            onclick: () => {
              if (root.AIEntries && root.AIEntries.open) root.AIEntries.open(miss);
              else load(null);
            }
          }, icon('refresh', 13), T('重新探测', 'Retry')),
          h('button', {
            class: 'btn sm ghost',
            type: 'button',
            onclick: () => { notice = null; paintNotice(); }
          }, T('收起', 'Dismiss'))
        ));
      }
    }

    /* ---------- 选中 / 高亮条目动作条 ---------- */
    function paintFocusBar() {
      focusBox.replaceChildren();
      if (!focusedItem || !focusedItem.path) {
        focusBox.hidden = true;
        return;
      }
      focusBox.hidden = false;
      const it = focusedItem;
      const isDir = it.kind === 'dir';
      const execFlag = !isDir && isExec(it.name);
      const arcFlag = !isDir && isArchive(it.name);
      const imgFlag = !isDir && isImage(it.name);
      const txtFlag = !isDir && isTextFile(it.name);

      const acts = [];
      if (isDir) {
        acts.push(h('button', {
          class: 'btn sm primary', type: 'button',
          onclick: () => setPath(it.path)
        }, icon('folder', 13), T('进入目录', 'Open folder')));
      } else if (arcFlag) {
        acts.push(h('button', {
          class: 'btn sm primary', type: 'button',
          onclick: () => root.App && root.App.jump && root.App.jump('archive', { paths: [it.path] })
        }, icon('archive', 13), T('在压缩包页打开', 'Open in Archives')));
      } else if (imgFlag && typeof UI.preview === 'function') {
        acts.push(h('button', {
          class: 'btn sm primary', type: 'button',
          onclick: () => UI.preview({ items: [{ path: it.path, name: it.name }], index: 0, title: it.name })
        }, icon('shots', 13), T('软件内预览', 'Preview')));
      } else if (txtFlag) {
        acts.push(h('button', {
          class: 'btn sm primary', type: 'button',
          onclick: () => previewTextModal(it.path, it.name)
        }, icon('file', 13), T('软件内查看', 'View text')));
      }
      if (execFlag) {
        acts.push(h('button', {
          class: 'btn sm', type: 'button',
          onclick: () => root.App && root.App.jump && root.App.jump('apps', { tab: 'procs', q: stemOf(it.name), paths: [it.path] })
        }, icon('apps', 13), T('在应用/进程中查看', 'Inspect in Apps')));
      } else if (!isDir) {
        acts.push(h('button', {
          class: 'btn sm ghost', type: 'button',
          onclick: () => openDefaultAppSafe(it.path)
        }, icon('file', 13), T('用默认程序打开', 'Default app')));
      }
      acts.push(h('button', {
        class: 'btn sm ghost', type: 'button',
        onclick: () => revealSafe(it.path)
      }, icon('external', 13), T('系统文件管理器', 'Explorer')));
      acts.push(h('button', {
        class: 'btn sm ghost', type: 'button',
        onclick: () => UI.copy(it.path)
      }, icon('copy', 13), T('复制路径', 'Copy')));

      focusBox.appendChild(h('div', { class: 'dv-focus-info' },
        icon(arcFlag ? 'archive' : (isDir ? 'folder' : 'file'), 14),
        h('span', { class: 'dv-focus-name ellipsis', title: it.path }, it.name),
        execFlag ? h('span', { class: 'badge warn' }, T('可执行文件 · 仅定位不运行', 'Executable · safe lock')) : null,
        h('span', { class: 'dv-focus-path mono small muted ellipsis', title: it.path }, it.path)
      ));
      focusBox.appendChild(h('div', { class: 'dv-focus-acts' }, ...acts));
    }

    /* ---------- 状态展示 ---------- */
    function paintMeta() {
      metaBox.replaceChildren();
      extDirBtn.disabled = !dir && !(focusedItem && focusedItem.path);
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
      if (filterText && unfilteredTotal > total) {
        metaBox.appendChild(h('span', { class: 'badge' },
          T('已筛选（原共 ' + fmtCount(unfilteredTotal) + ' 项）', 'Filtered from ' + fmtCount(unfilteredTotal))));
      }
      if (locatedIdx >= 0 && pageOffset > 0) {
        metaBox.appendChild(h('span', { class: 'badge ok' },
          T('已自动定位至第 ' + fmtCount(locatedIdx + 1) + ' 项', 'Located at #' + fmtCount(locatedIdx + 1))));
      }
      if (truncated || hasPrev) {
        const rangeEnd = pageOffset + items.length;
        metaBox.appendChild(h('span', { class: 'badge' },
          T('当前显示第 ' + fmtCount(pageOffset + 1) + '–' + fmtCount(rangeEnd) + ' / ' + fmtCount(total) + ' 项',
            'Showing ' + fmtCount(pageOffset + 1) + '–' + fmtCount(rangeEnd) + ' of ' + fmtCount(total))));
      }
      if ((busy || busyAppend) && items.length) {
        metaBox.appendChild(h('span', { class: 'small muted' }, T('读取中…', 'Loading…')));
      }
    }

    function paintState() {
      stateBox.replaceChildren();
      if (err) {
        stateBox.hidden = false;
        const isPerm = /权限不足|Access is denied|拒绝访问/i.test(err);
        stateBox.appendChild(h('div', { class: 'dv-err' },
          h('span', null, err),
          isPerm ? h('button', {
            class: 'btn sm primary', type: 'button',
            onclick: () => restartAsAdminFor(dir)
          }, icon('shield', 13), T('以管理员身份重启', 'Restart as admin')) : null,
          dir ? h('button', {
            class: 'btn ghost sm', type: 'button',
            onclick: () => revealSafe(dir)
          }, icon('external', 13), T('系统文件管理器', 'Explorer')) : null,
          h('button', { class: 'btn ghost sm', type: 'button', onclick: () => load(null) }, T('重试', 'Retry'))));
        return;
      }
      if (!dir) {
        stateBox.hidden = false;
        stateBox.appendChild(h('div', { class: 'dv-hint' },
          T('选一个文件夹，或直接点击 AI 回答 / 搜索结果中的任意链接即可在此定位查看。',
            'Pick a folder, or click any path in AI / Search results to inspect it here.')));
        return;
      }
      if (!busy && !items.length) {
        stateBox.hidden = false;
        stateBox.appendChild(h('div', { class: 'dv-hint' },
          filterText
            ? T('当前目录下没有匹配「' + filterText + '」的文件或文件夹', 'No items match "' + filterText + '" in this folder')
            : T('这个文件夹是空的', 'This folder is empty')));
        return;
      }
      stateBox.hidden = true;
    }

    /* ---------- 行 ---------- */
    function setFocused(item, rowEl) {
      focusedItem = item;
      listBox.querySelectorAll('.dv-row[data-sel]').forEach((n) => n.removeAttribute('data-sel'));
      if (rowEl) rowEl.setAttribute('data-sel', '');
      paintFocusBar();
      paintMeta();
    }

    function rowOfItem(it) {
      const name = it.name || '';
      const path = joinDir(dir, name);
      const isDir = it.kind === 'dir';
      const itemObj = { path, name, kind: isDir ? 'dir' : 'file', size: it.size || 0, ext: it.ext || '' };
      const row = h('div', {
        class: 'dv-row' + (isDir ? ' is-dir' : ' is-file'),
        tabindex: '0',
        dataset: { path: path.toLowerCase(), name: name }
      });
      row.appendChild(h('span', { class: 'dv-ico' }, icon(isArchive(name) && !isDir ? 'archive' : (isDir ? 'folder' : 'file'), 14)));
      row.appendChild(h('span', { class: 'dv-name ellipsis', title: path }, name));
      if (!isDir) {
        row.appendChild(h('span', { class: 'dv-ext muted small' }, it.ext ? '.' + it.ext : ''));
        row.appendChild(h('span', { class: 'dv-size num muted small' }, fmtBytes(it.size || 0)));
      }
      row.appendChild(h('span', { class: 'dv-time muted small num' },
        it.mtime ? fmtWhen(it.mtime) : ''));

      const openIt = () => {
        if (isDir) { setPath(path); return; }
        if (isArchive(name) && root.App && root.App.jump) {
          root.App.jump('archive', { paths: [path] });
          return;
        }
        if (isImage(name) && typeof UI.preview === 'function') {
          UI.preview({ items: [{ path, name }], index: 0, title: name });
          return;
        }
        if (isTextFile(name)) {
          previewTextModal(path, name);
          return;
        }
        if (isExec(name)) {
          setFocused(itemObj, row);
          toast(T('这是可执行文件，已留在软件内定位，如需去资源管理器请点「系统文件管理器」',
            'Executable located in app; use Explorer button if you need system folder'), 'info', 2800);
          return;
        }
        openDefaultAppSafe(path);
      };

      if (isDir) {
        row.addEventListener('click', openIt);
      } else {
        row.addEventListener('click', () => setFocused(itemObj, row));
        row.addEventListener('dblclick', openIt);
      }
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); openIt(); }
      });
      if (typeof attachMenu === 'function') {
        attachMenu(row, () => {
          const itemsMenu = [];
          if (isDir) {
            itemsMenu.push({ label: T('在软件内打开文件夹', 'Open folder in app'), icon: 'folder', action: () => setPath(path) });
          } else {
            if (isArchive(name)) {
              itemsMenu.push({ label: T('在软件「压缩包」中打开', 'Open in Archives'), icon: 'archive', action: () => root.App && root.App.jump && root.App.jump('archive', { paths: [path] }) });
            } else if (isImage(name) && typeof UI.preview === 'function') {
              itemsMenu.push({ label: T('软件内预览图片', 'Preview image'), icon: 'shots', action: () => UI.preview({ items: [{ path, name }], index: 0, title: name }) });
            } else if (isTextFile(name)) {
              itemsMenu.push({ label: T('软件内查看文本', 'View text in app'), icon: 'file', action: () => previewTextModal(path, name) });
            }
            if (!isExec(name)) {
              itemsMenu.push({ label: T('用系统默认程序打开', 'Open with default app'), icon: 'file', action: () => openDefaultAppSafe(path) });
            }
          }
          itemsMenu.push({ label: T('在系统文件管理器中打开', 'Open in system file manager'), icon: 'external', action: () => revealSafe(path) });
          itemsMenu.push({ label: T('复制完整路径', 'Copy full path'), icon: 'copy', action: () => UI.copy(path) });
          itemsMenu.push({ sep: true });
          itemsMenu.push({ label: T('问助手：这个能删吗', 'Ask: can I delete this'), icon: 'spark', action: () => { if (root.AIDrawer) root.AIDrawer.open({ title: T('问助手 · 这个文件', 'Ask · this file'), question: T('这个文件能删吗：', 'Can I delete ') + path }); } });
          return itemsMenu;
        });
      }
      rowOf.set(path.toLowerCase(), { row, item: itemObj });
      return row;
    }

    function paintList() {
      listBox.replaceChildren();
      rowOf.clear();
      items.forEach((it) => listBox.appendChild(rowOfItem(it)));
      prevBtn.hidden = !hasPrev;
      moreBtn.hidden = !truncated;
      if (hitPath) highlight(hitPath);
    }

    /* ---------- 读取 ---------- */
    function applyRes(res, mode) {
      const got = (res && res.items) || [];
      const resOffset = Number(res && res.offset) || 0;
      if (mode === 'append') {
        items = items.concat(got);
        nextOffset = resOffset + (Number(res && res.shown) || got.length);
      } else if (mode === 'prepend') {
        items = got.concat(items);
        pageOffset = resOffset;
      } else {
        items = got;
        pageOffset = resOffset;
        nextOffset = resOffset + (Number(res && res.shown) || got.length);
      }
      total = Number(res && res.total) || items.length;
      unfilteredTotal = Number(res && res.unfilteredTotal);
      if (!isFinite(unfilteredTotal)) unfilteredTotal = total;
      dirsN = Number(res && res.dirs);
      filesN = Number(res && res.files);
      if (!isFinite(dirsN)) dirsN = items.filter((x) => x.kind === 'dir').length;
      if (!isFinite(filesN)) filesN = items.filter((x) => x.kind !== 'dir').length;
      hasPrev = pageOffset > 0;
      truncated = !!(res && res.truncated) && (pageOffset + items.length < total);
      locatedIdx = (res && res.located && typeof res.locateIndex === 'number') ? res.locateIndex : -1;
    }

    function load(offset, loadOpts) {
      if (!alive) return Promise.resolve();
      const lo = loadOpts || {};
      const mode = lo.mode || (offset !== null && offset !== undefined && offset > 0 ? 'append' : 'fresh');
      if (mode !== 'fresh' && (busy || busyAppend)) return Promise.resolve();
      if (!dir) { paintMeta(); paintState(); return Promise.resolve(); }
      const mySeq = mode === 'fresh' ? ++reqSeq : reqSeq;
      if (mode === 'fresh') {
        busy = true;
        err = '';
        items = [];
        pageOffset = 0;
        nextOffset = 0;
        hasPrev = false;
        truncated = false;
        locatedIdx = -1;
        if (!lo.keepHit) { hitPath = ''; focusedItem = null; }
        paintFocusBar();
      } else {
        busyAppend = true;
      }
      paintMeta();
      paintState();
      if (mode === 'fresh') paintList();

      const reqOffset = mode === 'fresh' ? (offset === undefined ? null : offset) : offset;
      const apiOpts = {
        locate: mode === 'fresh' && lo.locate ? lo.locate : null,
        filter: filterText || null
      };
      return Promise.resolve()
        .then(() => API.listDir(dir, PAGE, reqOffset, apiOpts))
        .then((res) => {
          if (!alive || mySeq !== reqSeq) return;
          applyRes(res, mode);
        })
        .catch((e) => {
          if (!alive || mySeq !== reqSeq) return;
          err = errText(e);
        })
        .then(() => {
          if (!alive || mySeq !== reqSeq) return;
          busy = false;
          busyAppend = false;
          paintMeta();
          paintState();
          paintList();
          paintCrumbs();
          paintNotice();
          paintFocusBar();
          prevBtn.hidden = !hasPrev;
          moreBtn.hidden = !truncated;
        });
    }

    /* ---------- 面包屑 ---------- */
    function paintCrumbs() {
      crumbBox.replaceChildren();
      const list = crumbsOf(dir);
      if (!list.length) return;
      list.forEach((c, i) => {
        if (i) crumbBox.appendChild(h('span', { class: 'dv-crumb-sep' }, icon('chevron-right', 11)));
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
      if (!next) return Promise.resolve();
      dir = isDriveRoot(next) ? next.replace(/[\\/]+$/, '') + '\\' : next;
      pathIn.value = dir.replace(/\\+$/, isDriveRoot(dir) ? '\\' : '');
      hitPath = '';
      focusedItem = null;
      notice = null;
      filterText = '';
      filterIn.value = '';
      filterClearBtn.hidden = true;
      paintNotice();
      paintFocusBar();
      return load(0, { mode: 'fresh', keepHit: false });
    }

    function highlight(p) {
      const want = String(p || '').toLowerCase();
      if (!want) return false;
      const cleanWant = stripSlash(want);
      if (cleanWant === stripSlash(dir).toLowerCase()) {
        el.setAttribute('data-here', '');
        return true;
      }
      let found = rowOf.get(cleanWant);
      if (!found) {
        const base = String(p || '').split(/[\\/]/).filter(Boolean).pop();
        if (base) {
          const baseLow = base.toLowerCase();
          for (const entry of rowOf.values()) {
            if (entry.item && entry.item.name.toLowerCase() === baseLow) {
              found = entry;
              break;
            }
          }
        }
      }
      if (!found) return false;
      mark(found.row, found.item);
      return true;
    }

    function mark(row, item) {
      listBox.querySelectorAll('.dv-row[data-hit]').forEach((n) => n.removeAttribute('data-hit'));
      row.setAttribute('data-hit', '');
      if (item) {
        focusedItem = item;
        paintFocusBar();
        paintMeta();
      }
      try { row.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { if (row.scrollIntoView) row.scrollIntoView(); }
    }

    function showPath(p, hit, opts) {
      const next = stripSlash(String(p || '').trim());
      if (!next) return Promise.resolve();
      dir = isDriveRoot(next) ? next.replace(/[\\/]+$/, '') + '\\' : next;
      pathIn.value = dir.replace(/\\+$/, isDriveRoot(dir) ? '\\' : '');
      hitPath = hit ? String(hit) : '';
      focusedItem = null;
      notice = (opts && (opts.accessDenied || opts.missingTarget)) ? Object.assign({}, opts) : null;
      filterText = '';
      filterIn.value = '';
      filterClearBtn.hidden = true;
      paintNotice();
      paintFocusBar();
      return load(null, { mode: 'fresh', keepHit: true, locate: hitPath || null });
    }

    upBtn.addEventListener('click', () => {
      const up = parentOf(dir);
      if (up) setPath(up);
    });
    refreshBtn.addEventListener('click', () => load(null, { mode: 'fresh', keepHit: true, locate: hitPath || null }));
    extDirBtn.addEventListener('click', () => {
      const target = (focusedItem && focusedItem.path) || dir;
      if (!target) return;
      revealSafe(target);
    });
    prevBtn.addEventListener('click', () => {
      if (pageOffset <= 0) return;
      const start = Math.max(0, pageOffset - PAGE);
      load(start, { mode: 'prepend' });
    });
    moreBtn.addEventListener('click', () => load(nextOffset, { mode: 'append' }));
    pickBtn.addEventListener('click', () => {
      Promise.resolve(API.pickFolder(dir)).then((p) => { if (p) setPath(p); }).catch(() => {});
    });
    pathIn.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const v = pathIn.value.trim();
      if (!v) return;
      if (root.AIEntries && typeof root.AIEntries.open === 'function') {
        root.AIEntries.open(v);
      } else {
        setPath(v);
      }
    });
    filterIn.addEventListener('input', () => {
      const v = filterIn.value.trim();
      filterClearBtn.hidden = !v;
      if (filterTimer) clearTimeout(filterTimer);
      filterTimer = setTimeout(() => {
        filterTimer = 0;
        filterText = v;
        if (dir) load(0, { mode: 'fresh', keepHit: false });
      }, 180);
    });
    filterClearBtn.addEventListener('click', () => {
      if (filterTimer) { clearTimeout(filterTimer); filterTimer = 0; }
      filterIn.value = '';
      filterClearBtn.hidden = true;
      if (filterText) {
        filterText = '';
        if (dir) load(0, { mode: 'fresh', keepHit: false });
      }
      filterIn.focus();
    });

    /* 初始目录可以直接给；调用方也可以先建再看 setPath */
    if (o.dir) setPath(o.dir); else { paintMeta(); paintState(); }

    host.appendChild(el);

    return {
      el: el,
      getPath: function () { return dir; },
      getFocused: function () { return focusedItem ? Object.assign({}, focusedItem) : null; },
      setPath: setPath,
      showPath: showPath,
      refresh: function () { return load(null, { mode: 'fresh', keepHit: true, locate: hitPath || null }); },
      highlight: highlight,
      destroy: function () {
        alive = false;
        reqSeq++;
        if (filterTimer) { clearTimeout(filterTimer); filterTimer = 0; }
        rowOf.clear();
        try { el.remove(); } catch (e) {}
      }
    };
  }

  root.DirView = { create: create, parentOf: parentOf, joinDir: joinDir, crumbsOf: crumbsOf };
})(window);