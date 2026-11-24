/* 空间工具：大文件排行 + 空文件夹清理
 * 全部走 Rust 侧命令（top_files / file_signals / scan_empty_dirs / remove_empty_dirs），
 * 不经过 Python 引擎。大文件的「属于哪个软件」用引擎 apps.list 的安装路径做前缀匹配，
 * 「是否危险」用版本信息 + Authenticode 签名判断；空文件夹只在 1–3 层内判断并标出重要目录。 */
(function () {
  'use strict';

  const { h, T, icon, fmtBytes, fmtCount, toast, busy, skeleton, empty, section,
    attachMenu, confirm, setActions } = UI;

  const errText = UI.errText;

  /* 从 AI 回答里的「去工具页」跳进来时执行的接收器。
     页面没挂载过时是 null，mount() 里会把它指到本次挂载的 applyJump。 */
  let liveJump = null;

  /* 扩展名 → 类别。用来看「这是什么文件」，不参与删除判断。 */
  const CATS = [
    { key: 'installer', label: ['安装包', 'Installer'], exts: ['msi', 'msix', 'appx', 'iso', 'img', 'dmg', 'pkg', 'deb', 'rpm'], tone: 'accent' },
    { key: 'archive', label: ['压缩包', 'Archive'], exts: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'zst', 'cab'], tone: '' },
    { key: 'video', label: ['视频', 'Video'], exts: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'ts', 'rmvb'], tone: '' },
    { key: 'image', label: ['图片', 'Image'], exts: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'tif', 'tiff', 'heic', 'raw', 'psd'], tone: '' },
    { key: 'audio', label: ['音频', 'Audio'], exts: ['mp3', 'flac', 'wav', 'aac', 'ogg', 'm4a', 'wma', 'ape'], tone: '' },
    { key: 'doc', label: ['文档', 'Document'], exts: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv', 'epub'], tone: '' },
    { key: 'disk', label: ['磁盘镜像', 'Disk image'], exts: ['vhd', 'vhdx', 'vmdk', 'qcow2', 'ova', 'ovf', 'bak', 'dmp'], tone: 'warn' },
    { key: 'code', label: ['程序文件', 'Program file'], exts: ['exe', 'dll', 'sys', 'so', 'dylib', 'node', 'py', 'js', 'jar'], tone: 'warn' },
    { key: 'data', label: ['数据/缓存', 'Data/cache'], exts: ['db', 'sqlite', 'log', 'tmp', 'cache', 'dat', 'bin', 'pak', 'vpk', 'dat'], tone: 'warn' }
  ];

  function catOf(ext) {
    const e = String(ext || '').toLowerCase();
    for (const c of CATS) if (c.exts.includes(e)) return c;
    return null;
  }

  /* 风险判断：只看「能不能放心删」，不替代杀毒。
   * 依据：文件类型、所在目录、是否可执行、签名结果、修改时间。 */
  function riskOf(it) {
    const p = String(it.path || '').toLowerCase();
    const cat = catOf(it.ext);
    const inSystem = /\\windows\\|\\program files|\\programdata\\/.test(p);
    const inDownloads = /\\downloads\\|\\下载\\/.test(p);
    const ageDays = it.mtime ? (Date.now() / 1000 - Number(it.mtime)) / 86400 : 0;

    if (cat && cat.key === 'code') {
      const signed = it.sig === 'Valid' || it.sig === 'Present' || !!it.signer;
      if (signed) {
        const who = it.company || (it.signer || '').replace(/^CN=/, '').split(',')[0] || '';
        return {
          level: 'ok',
          text: who ? T('已签名', 'Signed') : T('系统/软件自带', 'Signed binary'),
          why: T('有数字签名' + (who ? '，发布者：' + who : '，属于已知发布者'), 'Signed' + (who ? ' by ' + who : ''))
        };
      }
      const unsigned = !it.sig || ['unknown', 'notsigned', 'unknownerror', ''].includes(String(it.sig).toLowerCase());
      if (it.sig && !unsigned) {
        return { level: 'warn', text: T('签名异常', 'Bad signature'), why: T('签名状态：' + it.sig, 'Signature status: ' + it.sig) };
      }
      if (inSystem) {
        return { level: 'ok', text: T('系统目录', 'System folder'), why: T('位于系统或程序目录，删前先确认', 'Inside a system or program folder') };
      }
      if (inDownloads) {
        return { level: 'warn', text: T('下载的可执行文件', 'Downloaded binary'), why: T('从下载目录来的可执行文件且没有签名，确认来源再删', 'Unsigned binary from a download folder') };
      }
      return { level: 'danger', text: T('来源不明', 'Unknown origin'), why: T('可执行文件且没读到签名，可能来自下载或破解包', 'Executable without a readable signature') };
    }
    if (cat && cat.key === 'installer') {
      return inDownloads
        ? { level: 'warn', text: T('下载的安装包', 'Downloaded installer'), why: T('装完通常可以删；删前确认不再需要重装', 'Usually safe to delete after installing') }
        : { level: 'ok', text: T('安装包', 'Installer'), why: T('安装包本体，不是运行中的程序', 'Installer file, not a running program') };
    }
    if (cat && cat.key === 'disk') {
      return { level: 'warn', text: T('备份/镜像', 'Backup/image'), why: T('可能是备份或崩溃转储，删前确认没有还原需求', 'May be a backup or crash dump') };
    }
    if (cat && cat.key === 'data') {
      return { level: 'warn', text: T('数据或缓存', 'Data/cache'), why: T('可能是程序的数据文件，确认对应软件已不再使用', 'Could still be in use by an app') };
    }
    if (inSystem) {
      return { level: 'warn', text: T('系统目录内', 'Inside system folder'), why: T('删除可能影响已安装的软件', 'Deleting may affect installed software') };
    }
    if (ageDays > 180) {
      return { level: 'ok', text: T('长期未改', 'Untouched'), why: T('超过半年没修改过，通常是旧文件', 'Not modified for over half a year') };
    }
    return { level: 'ok', text: T('普通文件', 'Regular file'), why: T('文档/媒体类，删除只影响这份内容', 'Document or media file') };
  }

  function normPath(p) {
    return String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  }

  /* 用已安装程序的安装路径反查「这文件属于哪个软件」。 */
  function buildOwners(apps) {
    const list = [];
    for (const a of apps || []) {
      const loc = normPath(a.location || a.install_location || a.path || '');
      if (!loc || loc.length < 4) continue;
      list.push({ loc, name: a.name || a.display_name || '' });
    }
    list.sort((a, b) => b.loc.length - a.loc.length);
    return (file) => {
      const f = normPath(file);
      for (const o of list) if (f === o.loc || f.startsWith(o.loc + '\\')) return o.name;
      return '';
    };
  }

  async function mount(root) {
    root.classList.add('stack');

    let emptyInput = null;
    let emptyItems = [];

    /* ---------------- 大文件 ---------------- */
    const bigInput = h('input', {
      class: 'input grow', type: 'text', spellcheck: 'false',
      placeholder: T('要扫描的目录，例如 D:\\', 'Folder to scan, e.g. D:\\')
    });
    const bigBtn = h('button', { class: 'btn primary' }, T('扫描大文件', 'Find large files'));
    const bigBrowse = h('button', { class: 'btn', title: T('选择文件夹', 'Choose folder') },
      icon('folder'), T('浏览', 'Browse'));
    const sigBtn = h('button', { class: 'btn', disabled: true, title: T('读取版本信息与数字签名，判断来源', 'Read version info and signatures') },
      T('深度分析', 'Analyze origin'));
    let lastActiveSection = 'big';
    bigInput.addEventListener('focus', () => { lastActiveSection = 'big'; });
    bigBtn.addEventListener('click', () => { lastActiveSection = 'big'; });

    /* 页面级常驻【问助手】入口（置顶于窗口右上角，永不随视图切换而消失） */
    const topAskBtn = UI.askBtn({
      title: T('让助手分析空间占用、大文件与空文件夹', 'Ask AI about space, large files and empty folders'),
      ctx: () => {
        if (lastActiveSection === 'empty') {
          return {
            page: '空间工具',
            tool: '空文件夹清理',
            dir: emptyInput ? emptyInput.value.trim() : '',
            count: emptyItems.length,
            note: emptyItems.length ? ('已扫描出 ' + emptyItems.length + ' 个空文件夹') : ''
          };
        }
        if (lastActiveSection === 'browse' && dv && dv.getPath()) {
          return {
            page: '空间工具',
            tool: '文件夹浏览',
            dir: dv.getPath()
          };
        }
        const list = bigItems || [];
        const total = list.reduce((s, x) => s + (x.size || 0), 0);
        return {
          page: '空间工具',
          tool: '大文件排行',
          dir: bigInput.value.trim() || (emptyInput ? emptyInput.value.trim() : ''),
          count: list.length,
          size: list.length ? fmtBytes(total) : '',
          files: list.slice(0, 8).map((x) => x.name)
        };
      }
    });

    bigBrowse.onclick = async () => {
      const d = await API.pickFolder();
      if (d) { bigInput.value = d; bigInput.focus(); }
    };

    const bigFilter = h('div', { class: 'seg', style: { flexWrap: 'wrap' } });
    const bigList = h('div', { class: 'tool-list' }, empty(
      T('还没有结果', 'No results yet'),
      T('选一个目录后点击「扫描大文件」，会列出最大的 50 个文件，并标出类型、来源软件和风险',
        'Pick a folder to list the 50 largest files with type, owner and risk')));
    const bigHint = h('div', { class: 'muted small' }, '');

    const bigCard = h('div', { class: 'card stretch-card' },
      h('div', { class: 'card-title' },
        h('h2', null, T('大文件排行', 'Largest files'))
      ),
      h('div', { class: 'toolbar' }, bigInput, bigBrowse, bigBtn, sigBtn),
      bigFilter,
      bigHint,
      bigList
    );

    /* ---------------- 空文件夹 ---------------- */
    emptyInput = h('input', {
      class: 'input grow', type: 'text', spellcheck: 'false',
      placeholder: T('要扫描的目录，例如 D:\\工具', 'Folder to scan, e.g. D:\\tools')
    });
    const emptyBtn = h('button', { class: 'btn primary' }, T('扫描空文件夹', 'Find empty folders'));
    const emptyBrowse = h('button', { class: 'btn', title: T('选择文件夹', 'Choose folder') },
      icon('folder'), T('浏览', 'Browse'));
    emptyBrowse.onclick = async () => {
      const d = await API.pickFolder();
      if (d) { emptyInput.value = d; emptyInput.focus(); }
    };
    emptyInput.addEventListener('focus', () => { lastActiveSection = 'empty'; });
    emptyBtn.addEventListener('click', () => { lastActiveSection = 'empty'; });
    const depthSeg = h('div', { class: 'seg' });
    const emptySel = h('button', { class: 'btn sm', disabled: true }, T('全选可删', 'Select all'));
    const emptyDel = h('button', { class: 'btn danger', disabled: true }, T('删除选中', 'Delete selected'));
    const emptyList = h('div', { class: 'tool-list' }, empty(
      T('还没有结果', 'No results yet'),
      T('扫描后勾选要删除的空文件夹，删除前会二次确认；重要目录会被标出且不能勾选',
        'Scan, tick the empty folders, then confirm; important folders are marked and locked')));
    const emptyHint = h('div', { class: 'muted small' }, '');
    let emptyDepth = 3;

    const emptyCard = h('div', { class: 'card stretch-card' },
      h('div', { class: 'card-title' },
        h('h2', null, T('空文件夹清理', 'Empty folders'))
      ),
      h('div', { class: 'toolbar' }, emptyInput, emptyBrowse, emptyBtn,
        h('span', { class: 'spacer' }), depthSeg, emptySel, emptyDel),
      emptyHint,
      emptyList
    );

    const jumpBox = h('div', { class: 'ai-jump', hidden: true });

    /* ---------------- 文件夹浏览（应用内） ---------------- */
    const dvHost = h('div', { class: 'stack' });
    const browseCard = h('div', { class: 'card stretch-card' },
      h('div', { class: 'card-title' },
        h('h2', null, T('文件夹浏览', 'Folder view'))
      ),
      dvHost
    );
    let dv = null;
    let jumpClaimed = false;
    function ensureDv() {
      if (dv || !window.DirView) return dv;
      dv = window.DirView.create(dvHost, {});
      return dv;
    }

    ensureDv();
    /* 不再在挂载时自动加载 config.last_folder：
       旧版会自动把整理页遗留的临时目录打开在「文件夹浏览」里，导致用户关不掉也总看到旧目录；
       现在仅响应用户主动选目录或显式 jump 定位。 */

    /* ---------------- 骨架 I：三分段定高工作台 ---------------- */
    const tabBig = h('button', { class: 'wb-tab active', type: 'button', onclick: () => switchToolTab('big') },
      icon('scan', 14), h('span', null, T('大文件排行', 'Largest files')));
    const tabEmpty = h('button', { class: 'wb-tab', type: 'button', onclick: () => switchToolTab('empty') },
      icon('folder', 14), h('span', null, T('空文件夹清理', 'Empty folders')));
    const tabBrowse = h('button', { class: 'wb-tab', type: 'button', onclick: () => switchToolTab('browse') },
      icon('layers', 14), h('span', null, T('文件夹浏览', 'Folder view')));
    const wbBar = h('div', { class: 'wb-bar' },
      h('div', { class: 'wb-tabs', role: 'tablist' }, tabBig, tabEmpty, tabBrowse),
      h('span', { class: 'spacer' }),
      topAskBtn
    );

    const paneBig = h('div', { class: 'wb-pane' }, bigCard);
    const paneEmpty = h('div', { class: 'wb-pane', hidden: true }, emptyCard);
    const paneBrowse = h('div', { class: 'wb-pane', hidden: true }, browseCard);

    function switchToolTab(tab) {
      const target = (tab === 'empty' || tab === 'browse') ? tab : 'big';
      lastActiveSection = target;
      tabBig.classList.toggle('active', target === 'big');
      tabEmpty.classList.toggle('active', target === 'empty');
      tabBrowse.classList.toggle('active', target === 'browse');
      paneBig.hidden = target !== 'big';
      paneEmpty.hidden = target !== 'empty';
      paneBrowse.hidden = target !== 'browse';
    }

    root.classList.add('page-fill');
    root.appendChild(wbBar);
    root.appendChild(jumpBox);
    root.appendChild(paneBig);
    root.appendChild(paneEmpty);
    root.appendChild(paneBrowse);
    setActions();

    /* ---------------- 来自助手的跳转 ---------------- */
    const stripSlash = (p) => {
      const s = String(p || '');
      return (s.length > 3 && /[\\/]$/.test(s)) ? s.replace(/[\\/]+$/, '') : s;
    };
    const parentOf = (p) => {
      if (window.AIEntries && typeof window.AIEntries.parentOf === 'function') {
        return window.AIEntries.parentOf(p);
      }
      const s = stripSlash(p);
      if (!s || /^[A-Za-z]:[\\/]?$/.test(s)) return '';
      const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
      if (i <= 0) return '';
      const par = s.slice(0, i);
      return /^[A-Za-z]:$/.test(par) ? par + '\\' : par;
    };
    const isFile = (p) => (window.AIEntries && window.AIEntries.kindOf
      ? window.AIEntries.kindOf(stripSlash(p)) === 'file'
      : /\.[A-Za-z0-9]{1,8}$/.test(stripSlash(p)));

    function paintJump(paths, why, dir, hitTarget) {
      const chipOf = (p) => (window.AIEntries && window.AIEntries.chip
        ? window.AIEntries.chip(p, { compact: true, src: 'jump' })
        : h('span', { class: 'ai-jump-path mono' }, p));
      const list = h('div', { class: 'ai-jump-list' }, ...paths.slice(0, 6).map(chipOf));
      if (paths.length > 6) {
        list.appendChild(h('span', { class: 'ai-jump-more' },
          T('还有 ' + (paths.length - 6) + ' 个位置', '+' + (paths.length - 6) + ' more')));
      }
      const primary = hitTarget || paths[0] || dir || '';
      jumpBox.replaceChildren(
        h('div', { class: 'ai-jump-head' },
          icon('spark', 14),
          h('span', { class: 'ai-jump-title' }, T('助手提到的位置', 'Paths the assistant found')),
          h('span', { class: 'ai-jump-sub' }, why || '')),
        list,
        h('div', { class: 'ai-jump-bar' },
          dir ? h('span', { class: 'ai-jump-dir mono', title: dir }, dir) : null,
          dir ? h('button', {
            class: 'btn sm ghost',
            type: 'button',
            onclick: () => {
              switchToolTab('browse');
              const view = ensureDv();
              if (view) view.showPath(dir, primary);
            }
          }, icon('scan', 13), h('span', {}, T('在目录树中浏览', 'Browse in tree'))) : null,
          primary ? h('button', {
            class: 'btn sm ghost',
            type: 'button',
            onclick: () => {
              if (window.AIEntries && window.AIEntries.reveal) window.AIEntries.reveal(primary);
              else API.reveal(primary).catch((e) => toast(errText(e), 'error'));
            }
          }, icon('external', 13), h('span', {}, T('系统文件管理器', 'Explorer'))) : null,
          h('button', {
            class: 'btn sm ghost',
            type: 'button',
            onclick: () => { jumpBox.hidden = true; }
          }, T('收起', 'Hide')))
      );
      jumpBox.hidden = false;
    }

    function hitSet(paths) {
      const list = paths.map((p) => normPath(p)).filter(Boolean);
      const named = list.some((x) => paths.some((p) => normPath(p) === x && isFile(p)));
      return (rowPath) => {
        const p = normPath(rowPath || '');
        if (!p) return false;
        if (list.includes(p)) return true;
        if (named) return false;
        return list.some((x) => p.startsWith(x + '\\'));
      };
    }

    function markBig(paths) {
      const hit = hitSet(paths);
      let first = null;
      bigList.querySelectorAll('.tool-row').forEach((row) => {
        if (!hit(row.dataset.path)) return;
        row.classList.add('ai-hit');
        if (!row.querySelector('.ai-hit-tag')) {
          const nameRow = row.querySelector('.row');
          if (nameRow) nameRow.appendChild(h('span', { class: 'tag store ai-hit-tag' }, T('助手提到', 'From AI')));
        }
        if (!first) first = row;
      });
      if (first && first.scrollIntoView) first.scrollIntoView({ block: 'nearest' });
    }

    function markEmpty(paths) {
      const hit = hitSet(paths);
      let first = null;
      emptyList.querySelectorAll('.tool-row').forEach((row) => {
        if (!hit(row.dataset.path)) return;
        row.classList.add('ai-hit');
        if (!first) first = row;
      });
      if (first && first.scrollIntoView) first.scrollIntoView({ block: 'nearest' });
    }

    async function applyJump(data) {
      const d = data || {};
      const paths = (d.paths || [])
        .filter(Boolean).map((p) => stripSlash(String(p)));
      if (!paths.length && !d.dir && !d.tab) return;
      jumpClaimed = true;
      const want = String(d.tab || d.action || 'check');
      if (!paths.length && d.tab && !d.dir) {
        switchToolTab(d.tab);
        return;
      }

      /* 优先信任来自真实文件系统探测的 d.dir / d.kind，避免把带点目录误判为文件 */
      let dir = stripSlash(String(d.dir || ''));
      if (!dir && paths.length) {
        if (d.kind === 'dir') {
          dir = paths[0];
        } else if (d.kind === 'file') {
          dir = parentOf(paths[0]);
        } else if (window.AIEntries && typeof window.AIEntries.inspect === 'function') {
          try {
            const info = await window.AIEntries.inspect(paths[0]);
            if (info && info.status === 'ok') {
              dir = stripSlash(info.kind === 'dir' ? info.path : (info.parent || parentOf(info.path)));
            } else if (info && info.status === 'permission_denied') {
              dir = stripSlash(info.nearestReadable || info.parent || '');
            } else if (info && info.status === 'not_found') {
              dir = stripSlash(info.nearestExisting || '');
            }
          } catch (_) {}
        }
      }
      if (!dir && paths.length) {
        const files = paths.filter(isFile);
        const dirs = paths.filter((p) => !isFile(p));
        dir = dirs[0] || parentOf(files[0]) || '';
      }

      const hitTarget = stripSlash(String(d.highlight || paths[0] || ''));
      const whyStr = String(d.why || '');
      if (paths.length) paintJump(paths, whyStr, dir, hitTarget);

      if (want === 'browse' || (d.dir && want !== 'empty' && want !== 'big')) {
        switchToolTab('browse');
        const view = ensureDv();
        if (view) {
          const start = stripSlash(String(d.dir || dir || ''));
          if (start) {
            await view.showPath(start, hitTarget, {
              accessDenied: !!d.accessDenied,
              requestedPath: d.requestedPath || paths[0] || '',
              missingTarget: d.missingTarget || ''
            });
          }
        }
        return;
      }

      /* 红队修复 RT-05：只有显式指定 empty 或明确提及空文件夹时才走「空文件夹清理」，
         严禁把「可以直接删的 10.4 GB 下载目录」误路由成空文件夹扫描导致显示「没有空文件夹」。 */
      const isEmptyIntent = want === 'empty'
        || (want === 'delete' && /空文件夹|空目录|empty\s*(?:dir|folder)/i.test(whyStr));
      if (isEmptyIntent) {
        switchToolTab('empty');
        if (dir) emptyInput.value = dir;
        if (dir) {
          await scanEmpty();
          markEmpty(paths);
        }
        return;
      }

      switchToolTab('big');
      if (dir) bigInput.value = dir;
      if (dir) {
        await scanBig();
        markBig(paths);
      } else {
        bigHint.textContent = T('助手给的是文件，选一个目录再扫', 'Pick a folder to scan');
      }
    }

    /* ---------------- 大文件逻辑 ---------------- */
    let bigItems = [];
    let bigBusy = false;
    let bigFilterKey = 'all';
    let owners = () => '';

    const FILTERS = [
      { key: 'all', label: ['全部', 'All'] },
      { key: 'installer', label: ['安装包', 'Installers'] },
      { key: 'media', label: ['媒体', 'Media'], keys: ['video', 'image', 'audio'] },
      { key: 'archive', label: ['压缩包', 'Archives'] },
      { key: 'code', label: ['程序文件', 'Programs'] },
      { key: 'risky', label: ['需确认', 'Check first'] }
    ];

    function renderFilter() {
      bigFilter.replaceChildren(...FILTERS.map((f) => {
        const chip = h('button', { class: 'chip' + (bigFilterKey === f.key ? ' active' : '') }, T(f.label[0], f.label[1]));
        chip.onclick = () => { bigFilterKey = f.key; renderFilter(); renderBig(); };
        return chip;
      }));
    }

    function visibleItems() {
      if (bigFilterKey === 'all') return bigItems;
      const f = FILTERS.find((x) => x.key === bigFilterKey);
      if (bigFilterKey === 'risky') return bigItems.filter((it) => {
        const r = riskOf(it).level;
        return r === 'danger' || r === 'warn';
      });
      if (f && f.keys) {
        return bigItems.filter((it) => {
          const c = catOf(it.ext);
          return c && f.keys.includes(c.key);
        });
      }
      return bigItems.filter((it) => {
        const c = catOf(it.ext);
        return c && c.key === bigFilterKey;
      });
    }

    async function scanBig() {
      const dir = bigInput.value.trim();
      if (!dir) { toast(T('先填一个目录', 'Enter a folder first'), 'warn'); return; }
      if (bigBusy) return;
      bigBusy = true;
      bigBtn.disabled = true;
      sigBtn.disabled = true;
      bigList.replaceChildren(skeleton(6, 'scan'));
      bigHint.textContent = T('正在扫描…', 'Scanning…');
      try {
        const res = await API.topFiles(dir, 50);
        // Rust 现在返回 {dir,items,scanned,partial,…}；旧版是裸数组。
        const list = (res && res.items) || (Array.isArray(res) ? res : []);
        bigItems = (Array.isArray(list) ? list : []).map((it) => Object.assign({}, it));
        bigFilterKey = 'all';
        renderFilter();
        // 来源软件：拿安装清单做前缀匹配，失败不影响主流程
        try {
          const res2 = await API.engine('apps.list', {});
          const apps = Array.isArray(res2) ? res2 : (res2 && (res2.apps || res2.items)) || [];
          owners = buildOwners(apps);
        } catch (_) { owners = () => ''; }
        renderBig();
        // 部分结果不能装作是全盘结论
        if (res && res.partial === true) {
          bigHint.textContent = T(
            '已扫 ' + (res.scanned || 0) + ' 项，达到时间上限，下面只是部分结果',
            'Scanned ' + (res.scanned || 0) + ' items before the time limit — partial results only'
          );
        }
      } catch (e) {
        bigItems = [];
        bigHint.textContent = '';
        bigList.replaceChildren(empty(T('扫描失败', 'Scan failed'), errText(e)));
        toast(errText(e), 'error');
      } finally {
        bigBusy = false;
        bigBtn.disabled = false;
        sigBtn.disabled = bigItems.length === 0;
      }
    }

    async function analyze() {
      if (!bigItems.length || bigBusy) return;
      const targets = bigItems.slice(0, 40).map((it) => it.path);
      sigBtn.disabled = true;
      bigHint.textContent = T('正在读取 ' + targets.length + ' 个文件的版本信息与签名…', 'Reading version info and signatures…');
      try {
        const res = await API.fileSignals(targets);
        const items = (res && res.items) || [];
        const byPath = new Map();
        for (const s of items) byPath.set(normPath(s.path), s);
        let got = 0;
        for (const it of bigItems) {
          const s = byPath.get(normPath(it.path));
          if (!s) continue;
          got += 1;
          it.sig = s.sig || 'Unknown';
          it.company = s.company || '';
          it.product = s.product || '';
          it.signer = s.signer || '';
          it.desc = s.desc || '';
        }
        renderBig();
        toast(got ? T('已读取 ' + got + ' 个文件的签名与来源', 'Read signatures for ' + got + ' files')
          : T('没有读到签名信息', 'No signature info'), got ? 'ok' : 'warn');
      } catch (e) {
        toast(errText(e), 'error');
        renderBig();
      } finally {
        sigBtn.disabled = bigItems.length === 0;
      }
    }

    function renderBig() {
      sigBtn.disabled = bigItems.length === 0;
      if (!bigItems.length) {
        bigHint.textContent = '';
        bigList.replaceChildren(empty(T('没有找到文件', 'No files found'), ''));
        return;
      }
      const items = visibleItems();
      const total = items.reduce((s, it) => s + (Number(it.size) || 0), 0);
      const risky = items.filter((it) => riskOf(it).level !== 'ok').length;

      const rows = items.map((it, i) => {
        const cat = catOf(it.ext);
        const risk = riskOf(it);
        const owner = owners(it.path);
        const sub = [owner, dirOf(it.path)].filter(Boolean).join(' · ');
        const tags = [];
        if (cat) tags.push(h('span', { class: 'tag' + (cat.tone === 'accent' ? ' store' : '') }, T(cat.label[0], cat.label[1])));
        if (it.company) tags.push(h('span', { class: 'tag' }, it.company));

        const viewBtn = h('button', {
          type: 'button',
          class: 'btn icon ghost sm tool-view-btn',
          title: T('查看文件内容', 'View file content'),
          'aria-label': T('查看文件内容', 'View file content'),
          onclick: (e) => {
            e.stopPropagation();
            if (typeof UI.previewFile === 'function') UI.previewFile(it.path, { name: it.name });
          }
        }, icon('file', 13));

        const row = h('div', { class: 'tool-row', dataset: { path: it.path || '' }, title: T('双击查看文件内容', 'Double-click to view file content') },
          h('span', { class: 'muted small', style: { width: '26px' } }, String(i + 1)),
          h('div', { class: 'grow' },
            h('div', { class: 'row' },
              h('span', { class: 'ellipsis', title: it.name }, it.name || ''),
              ...tags),
            h('div', { class: 'mono small muted ellipsis', title: sub }, sub),
            h('div', { class: 'small muted' }, risk.why)),
          viewBtn,
          h('span', { class: 'badge ' + risk.level, title: risk.why }, risk.text),
          h('span', { class: 'size small' }, fmtBytes(it.size))
        );
        attachMenu(row, [
          { header: it.name || '' },
          { label: T('查看文件内容', 'View file content'), icon: 'file',
            action: () => {
              if (typeof UI.previewFile === 'function') UI.previewFile(it.path, { name: it.name });
            } },
          { label: T('在软件目录树中定位', 'Locate in folder view'), icon: 'scan',
            action: () => {
              switchToolTab('browse');
              const view = ensureDv();
              const d = parentOf(it.path) || dirOf(it.path);
              if (view && d) view.showPath(d, it.path);
            } },
          { label: T('在系统文件管理器中打开', 'Open in system file manager'), icon: 'external',
            action: () => API.reveal(it.path).catch((e) => toast(errText(e), 'error')) },
          { label: T('复制完整路径', 'Copy full path'), icon: 'copy', action: () => copy(it.path) },
          { label: T('复制文件名', 'Copy file name'), icon: 'copy', action: () => copy(it.name) },
          { sep: true },
          { label: T('只分析这一个文件', 'Analyze this file only'), icon: 'search',
            action: async () => {
              try {
                const r = await API.fileSignals([it.path]);
                const s = (r && r.items && r.items[0]) || {};
                await confirm({
                  title: it.name || '',
                  body: T(
                    '公司：' + (s.company || '未知') + '\n产品：' + (s.product || '未知') +
                    '\n签名：' + (s.sig || '未知') + (s.signer ? '\n签名者：' + s.signer : '') +
                    '\n大小：' + fmtBytes(it.size) + '\n路径：' + it.path,
                    'Company: ' + (s.company || 'unknown') + '\nProduct: ' + (s.product || 'unknown') +
                    '\nSignature: ' + (s.sig || 'unknown') + (s.signer ? '\nSigner: ' + s.signer : '') +
                    '\nSize: ' + fmtBytes(it.size) + '\nPath: ' + it.path),
                  ok: T('关闭', 'Close'),
                  cancel: false
                });
              } catch (e) { toast(errText(e), 'error'); }
            } }
        ]);
        row.addEventListener('dblclick', (e) => {
          if (e.target && e.target.closest && e.target.closest('button')) return;
          if (typeof UI.previewFile === 'function') {
            UI.previewFile(it.path, { name: it.name });
          } else if (window.AIEntries && typeof window.AIEntries.open === 'function') {
            window.AIEntries.open(it.path);
          } else {
            switchToolTab('browse');
            const view = ensureDv();
            const d = parentOf(it.path) || dirOf(it.path);
            if (view && d) view.showPath(d, it.path);
          }
        });
        return row;
      });

      bigHint.textContent = T(
        '显示 ' + fmtCount(items.length) + ' / ' + fmtCount(bigItems.length) + ' 个，合计 ' + fmtBytes(total) +
        (risky ? '；其中 ' + risky + ' 个需要先确认再删' : '；都可以按普通文件处理'),
        'Showing ' + fmtCount(items.length) + ' of ' + fmtCount(bigItems.length) + ', ' + fmtBytes(total) +
        (risky ? '; ' + risky + ' need a check first' : ''));
      bigList.replaceChildren(...rows);
    }

    bigBtn.addEventListener('click', scanBig);
    sigBtn.addEventListener('click', analyze);
    bigInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') scanBig(); });
    renderFilter();

    /* ---------------- 空文件夹逻辑 ---------------- */
    emptyItems = [];
    const emptyChecked = new Set();
    let emptyBusy = false;

    for (const d of [1, 2, 3]) {
      const chip = h('button', { class: 'chip' + (emptyDepth === d ? ' active' : '') }, d + T(' 层', ' levels'));
      chip.onclick = () => {
        emptyDepth = d;
        for (const c of Array.from(depthSeg.children)) c.classList.toggle('active', c === chip);
        if (emptyInput.value.trim()) scanEmpty();
      };
      depthSeg.appendChild(chip);
    }

    async function scanEmpty() {
      const dir = emptyInput.value.trim();
      if (!dir) { toast(T('先填一个目录', 'Enter a folder first'), 'warn'); return; }
      if (emptyBusy) return;
      emptyBusy = true;
      emptyBtn.disabled = true;
      emptyList.replaceChildren(skeleton(6, 'scan'));
      emptyHint.textContent = T('正在扫描…', 'Scanning…');
      try {
        const res = await API.scanEmptyDirs(dir, 2000, emptyDepth);
        // Rust 现在返回 {dir,items,depth,scanned,partial,…}；旧版是裸数组。
        const list = (res && res.items) || (Array.isArray(res) ? res : []);
        emptyItems = (Array.isArray(list) ? list : []).map((x) => (typeof x === 'string'
          ? { path: x, depth: 0, kind: 'empty', why: '', rel: x }
          : x));
        emptyChecked.clear();
        const deletable = emptyItems.filter((x) => x.kind !== 'protected').length;
        const locked = emptyItems.length - deletable;
        const partialNote = res && res.partial === true
          ? T('，已达时间上限只扫了一部分', ', time limit hit — partial scan')
          : '';
        emptyHint.textContent = emptyItems.length
          ? T('找到 ' + fmtCount(deletable) + ' 个可删空文件夹' + (locked ? '，' + locked + ' 个重要目录不删' : '') +
              '（扫描深度 ' + emptyDepth + ' 层' + partialNote + '）',
              fmtCount(deletable) + ' empty folders' + (locked ? ', ' + locked + ' protected' : '') +
              ' (depth ' + emptyDepth + partialNote + ')')
          : T('没有空文件夹', 'No empty folders');
        renderEmpty();
      } catch (e) {
        emptyItems = [];
        emptyChecked.clear();
        refreshEmptyBtn();
        emptyHint.textContent = '';
        emptyList.replaceChildren(empty(T('扫描失败', 'Scan failed'), errText(e)));
        toast(errText(e), 'error');
      } finally {
        emptyBusy = false;
        emptyBtn.disabled = false;
      }
    }

    function refreshEmptyBtn() {
      const n = emptyChecked.size;
      const deletable = emptyItems.filter((x) => x.kind !== 'protected');
      emptyDel.disabled = n === 0;
      emptySel.disabled = deletable.length === 0;
      emptySel.textContent = (n && n === deletable.length)
        ? T('取消全选', 'Clear selection')
        : T('全选可删', 'Select all');
      emptyDel.textContent = n
        ? T('删除选中（' + n + '）', 'Delete selected (' + n + ')')
        : T('删除选中', 'Delete selected');
    }

    function renderEmpty() {
      if (!emptyItems.length) {
        emptyList.replaceChildren(empty(T('没有空文件夹', 'No empty folders'),
          T('换个目录或调大扫描层数再试', 'Try another folder or a deeper level')));
        refreshEmptyBtn();
        return;
      }
      const rows = emptyItems.map((it) => {
        const locked = it.kind === 'protected';
        const cb = h('input', { class: 'check', type: 'checkbox', disabled: locked });
        cb.checked = emptyChecked.has(it.path);
        cb.addEventListener('change', () => {
          if (cb.checked) emptyChecked.add(it.path); else emptyChecked.delete(it.path);
          refreshEmptyBtn();
        });
        const row = h('div', { class: 'tool-row', dataset: { path: it.path || '' } },
          cb,
          h('div', { class: 'grow' },
            h('div', { class: 'mono small ellipsis', title: it.path }, it.path),
            locked
              ? h('div', { class: 'small muted' }, T('重要目录：', 'Protected: ') + (it.why || ''))
              : h('div', { class: 'small muted' }, T('第 ' + (it.depth || 0) + ' 层，没有任何文件或子目录',
                  'Level ' + (it.depth || 0) + ', no files or subfolders'))),
          h('span', { class: 'badge ' + (locked ? 'warn' : 'ok') },
            locked ? T('不删', 'Keep') : T('可删', 'Empty'))
        );
        if (!locked) {
          row.addEventListener('click', (e) => {
            if (e.target === cb) return;
            cb.checked = !cb.checked;
            cb.dispatchEvent(new Event('change'));
          });
        }
        attachMenu(row, [
          { header: it.path },
          { label: T('在软件目录树中查看', 'View in folder tree'), icon: 'scan',
            action: () => {
              switchToolTab('browse');
              const view = ensureDv();
              const d = parentOf(it.path) || it.path;
              if (view && d) view.showPath(d, it.path);
            } },
          { label: T('在系统文件管理器中打开', 'Open in system file manager'), icon: 'external',
            action: () => API.reveal(it.path).catch((e) => toast(errText(e), 'error')) },
          { label: T('复制路径', 'Copy path'), icon: 'copy', action: () => copy(it.path) },
          { sep: true },
          { label: T('从列表中移除', 'Remove from list'), icon: 'close',
            action: () => {
              emptyItems = emptyItems.filter((x) => x !== it);
              emptyChecked.delete(it.path);
              renderEmpty();
            } }
        ]);
        return row;
      });
      emptyList.replaceChildren(...rows);
      refreshEmptyBtn();
    }

    emptySel.onclick = () => {
      const deletable = emptyItems.filter((x) => x.kind !== 'protected');
      if (emptyChecked.size === deletable.length) emptyChecked.clear();
      else for (const it of deletable) emptyChecked.add(it.path);
      renderEmpty();
    };

    async function deleteEmpty() {
      const paths = Array.from(emptyChecked);
      if (!paths.length) return;
      const yes = await confirm({
        title: T('删除空文件夹', 'Delete empty folders'),
        body: T('将删除 ' + paths.length + ' 个空文件夹（只删空目录，不影响文件）。',
          'Delete ' + paths.length + ' empty folders. Only empty directories are removed.'),
        ok: T('删除', 'Delete'),
        danger: true
      });
      if (!yes) return;
      const res = await busy(() => API.removeEmptyDirs(paths), T('正在删除…', 'Deleting…'), 'scan');
      if (!res) return;
      const removed = Number(res && res.removed) || 0;
      const failed = (res && res.failed) || [];
      toast(T('已删除 ' + removed + ' 个空文件夹' +
        (failed.length ? '，' + failed.length + ' 个失败' : ''),
        'Deleted ' + removed + (failed.length ? ', ' + failed.length + ' failed' : '')),
        failed.length ? 'warn' : 'ok');
      await scanEmpty();
    }

    emptyBtn.addEventListener('click', scanEmpty);
    emptyDel.addEventListener('click', deleteEmpty);
    emptyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') scanEmpty(); });

    liveJump = applyJump;

    return function unmount() {
      /* 页面卸载后跳转接收器必须失效，否则 AI 的跳转会把结果写进已经拆掉的 DOM */
      liveJump = null;
      /* 目录浏览持有 DOM 与行索引，不拆会随切页次数累积 */
      if (dv) { try { dv.destroy(); } catch (e) { /* 拆不掉也让页面先走 */ } dv = null; }
      setActions();
    };
  }

  function dirOf(p) {
    const s = String(p || '');
    const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
    return i > 0 ? s.slice(0, i) : s;
  }

  function copy(text) {
    const s = String(text || '');
    const done = () => toast(T('已复制', 'Copied'), 'ok');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(s).then(done).catch(() => fallbackCopy(s, done));
    } else {
      fallbackCopy(s, done);
    }
  }

  function fallbackCopy(s, done) {
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (_) { /* ignore */ }
    ta.remove();
  }

  window.Pages = window.Pages || {};
  window.Pages.tools = {
    title: ['空间工具', 'Space tools'],
    subtitle: ['大文件来源与风险、空文件夹清理', 'Large files with origin and risk, empty folders'],
    mount,
    /* AI 回答里的「去工具页」落到这里：带路径进来就要看得见东西 */
    jump(payload) { return liveJump ? liveJump(payload || {}) : undefined; }
  };
})();
