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
    const askMark = window.SteveAvatar
      ? window.SteveAvatar.el({ size: 24, variant: 'btn' })
      : icon('spark');
    const askBtn = h('button', { class: 'btn ghost', title: T('让助手解释这批文件能不能删', 'Ask the assistant about these files') },
      askMark, T('问助手', 'Ask AI'));
    askBtn.onclick = () => {
      if (window.SteveAvatar) {
        window.SteveAvatar.spin(askMark);
      }
      const list = bigItems || [];
      const total = list.reduce((s, x) => s + (x.size || 0), 0);
      window.AIDrawer.open({
        title: T('问助手 · 大文件', 'Ask AI · Large files'),
        ctx: () => ({
          page: '空间工具',
          dir: bigInput.value.trim(),
          count: list.length,
          size: list.length ? fmtBytes(total) : '',
          files: list.slice(0, 8).map((x) => x.name)
        })
      });
    };
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

    const bigSection = section(T('大文件排行', 'Largest files'),
      h('div', { class: 'stack' },
        h('div', { class: 'toolbar' }, bigInput, bigBrowse, bigBtn, sigBtn, askBtn),
        bigFilter,
        bigHint,
        bigList),
      { open: true, hint: T('只读，不删除任何东西', 'Read-only') }
    );

    /* ---------------- 空文件夹 ---------------- */
    const emptyInput = h('input', {
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
    const depthSeg = h('div', { class: 'seg' });
    const emptySel = h('button', { class: 'btn sm', disabled: true }, T('全选可删', 'Select all'));
    const emptyDel = h('button', { class: 'btn danger', disabled: true }, T('删除选中', 'Delete selected'));
    const emptyList = h('div', { class: 'tool-list' }, empty(
      T('还没有结果', 'No results yet'),
      T('扫描后勾选要删除的空文件夹，删除前会二次确认；重要目录会被标出且不能勾选',
        'Scan, tick the empty folders, then confirm; important folders are marked and locked')));
    const emptyHint = h('div', { class: 'muted small' }, '');
    let emptyDepth = 3;

    const emptySection = section(T('空文件夹清理', 'Empty folders'),
      h('div', { class: 'stack' },
        h('div', { class: 'toolbar' }, emptyInput, emptyBrowse, emptyBtn,
          h('span', { class: 'spacer' }), depthSeg, emptySel, emptyDel),
        emptyHint,
        emptyList),
      { open: false, hint: T('只删空目录，1–3 层内判断', 'Empty dirs only, 1–3 levels deep') }
    );

    const jumpBox = h('div', { class: 'ai-jump', hidden: true });

    /* ---------------- 文件夹浏览（应用内） ----------------
       整理跑完会把文件移进 01_安装包程序 这类分类子文件夹，而以前应用里
       没有任何地方能看见它们 —— 结果位置的入口只会拉起系统资源管理器。
       这一块就是那个缺口：只读、能一层层进去、能翻页、能被跳转命中。 */
    const dvHost = h('div', { class: 'stack' });
    const browseSection = section(
      '文件夹浏览',
      dvHost,
      { open: true, hint: '在应用内一层层看，不用跳资源管理器' }
    );
    let dv = null;
    function ensureDv() {
      if (dv || !window.DirView) return dv;
      dv = window.DirView.create(dvHost, {});
      return dv;
    }

    /* 一进页面就把浏览区建出来。
       以前只在「从结果位置跳过来」时才 ensureDv()，于是用户自己点开「空间工具」
       看到的是一个只有标题的空块（1.41.8 真机就是这样），得先跳一次才有内容。
       没有初始路径时 dirview 自己画一句「选一个文件夹」，不是白板。 */
    ensureDv();

    /* 没被跳转到具体目录时，退回上一次用过的那一个。
       用户刚在「整理文件」里扫过某个文件夹，接着点「空间工具」多半就是想知道
       东西去哪了 —— 让他重新选一次目录纯属白费一步。configGet 是异步的，
       回来时如果已经有人 setPath（跳转分支），就不覆盖。 */
    Promise.resolve()
      .then(() => API.configGet())
      .then((cfg) => {
        if (!dv || dv.getPath()) return;
        const last = String((cfg && (cfg.last_folder || cfg.lastFolder)) || '');
        if (last) dv.setPath(last);
      })
      .catch(() => {});

    root.appendChild(jumpBox);
    root.appendChild(browseSection);
    root.appendChild(bigSection);
    root.appendChild(emptySection);
    setActions();

    /* ---------------- 来自助手的跳转 ----------------
       AI 的「去工具页」以前只切页，什么也不带，用户过来看到的是一张空表。
       现在这份载荷里有它提到过的位置和它想干的事，规则只有一条：
       跳进来必须**看得见东西**——先把位置列出来，再把目录填进扫描框、立刻扫，
       扫完把助手提到的行标出来并滚到它。 */
    const stripSlash = (p) => String(p || '').replace(/[\\/]+$/, '');
    const parentOf = (p) => {
      const s = stripSlash(p);
      const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
      return i > 0 ? s.slice(0, i) : s;
    };
    const isFile = (p) => (window.AIEntries && window.AIEntries.kindOf
      ? window.AIEntries.kindOf(stripSlash(p)) === 'file'
      : /\.[A-Za-z0-9]{1,8}$/.test(stripSlash(p)));

    function openSection(sec) {
      if (!sec) return;
      const head = sec.querySelector('.section-head');
      if (head && head.getAttribute('aria-expanded') !== 'true') {
        head.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }
    }

    function closeSection(sec) {
      if (!sec) return;
      const head = sec.querySelector('.section-head');
      if (head && head.getAttribute('aria-expanded') === 'true') {
        head.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }
    }

    function paintJump(paths, why, dir) {
      const chipOf = (p) => (window.AIEntries && window.AIEntries.chip
        ? window.AIEntries.chip(p, { compact: true, src: 'jump' })
        : h('span', { class: 'ai-jump-path mono' }, p));
      const list = h('div', { class: 'ai-jump-list' }, ...paths.slice(0, 6).map(chipOf));
      if (paths.length > 6) {
        list.appendChild(h('span', { class: 'ai-jump-more' },
          T('还有 ' + (paths.length - 6) + ' 个位置', '+' + (paths.length - 6) + ' more')));
      }
      jumpBox.replaceChildren(
        h('div', { class: 'ai-jump-head' },
          icon('spark', 14),
          h('span', { class: 'ai-jump-title' }, T('助手提到的位置', 'Paths the assistant found')),
          h('span', { class: 'ai-jump-sub' }, why || '')),
        list,
        h('div', { class: 'ai-jump-bar' },
          dir ? h('span', { class: 'ai-jump-dir mono', title: dir }, dir) : null,
          h('button', {
            class: 'btn sm ghost',
            onclick: () => { jumpBox.hidden = true; }
          }, T('收起', 'Hide')))
      );
      jumpBox.hidden = false;
    }

    /* 命中判定：同一个路径，或者「AI 给的是目录、这一行在目录里」。
       后者很常见——助手说「最大的文件都在 release 目录」，带过来的是目录本身，
       要标出来的是它下面的那些文件。 */
    function hitSet(paths) {
      const list = paths.map((p) => normPath(p)).filter(Boolean);
      /* 点名了具体文件时只标那几个：把整个目录的行都点亮等于没说清楚是哪个 */
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
      const paths = ((data && data.paths) || [])
        .filter(Boolean).map((p) => stripSlash(String(p)));
      if (!paths.length) return;
      const want = String((data && data.action) || 'check');
      const files = paths.filter(isFile);
      const dirs = paths.filter((p) => !isFile(p));
      const dir = dirs[0] || parentOf(files[0]) || '';
      paintJump(paths, String((data && data.why) || ''), dir);

      /* 目录浏览：整理页的「去看结果」和右键「在应用内看」都走这里。
         要先开这一块再 setPath —— 藏在收起的 section 里 setPath 也能跑，
         但用户看不见，等于没发生。 */
      if (want === 'browse' || (data && data.dir)) {
        openSection(browseSection);
        const view = ensureDv();
        if (view) {
          const start = stripSlash(String((data && data.dir) || dir || ''));
          if (start) view.showPath(start, paths[0] || '');
        }
        if (browseSection.scrollIntoView) browseSection.scrollIntoView({ block: 'nearest' });
        return;
      }

      /* 空文件夹这一类去空目录那一块；其余都走大文件排行 */
      if (want === 'delete' && dirs.length && !files.length) {
        openSection(emptySection);
        /* 空目录这件事就在这一块里完成，大文件那块先收起，别让用户对着空表 */
        closeSection(bigSection);
        if (dir) emptyInput.value = dir;
        if (dir) {
          await scanEmpty();
          markEmpty(paths);
        }
        if (emptySection.scrollIntoView) emptySection.scrollIntoView({ block: 'nearest' });
        return;
      }
      if (dir) bigInput.value = dir;
      if (dir) {
        await scanBig();
        markBig(paths);
      } else {
        bigHint.textContent = T('助手给的是文件，选一个目录再扫', 'Pick a folder to scan');
      }
      if (bigSection.scrollIntoView) bigSection.scrollIntoView({ block: 'nearest' });
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

        const row = h('div', { class: 'tool-row', dataset: { path: it.path || '' } },
          h('span', { class: 'muted small', style: { width: '26px' } }, String(i + 1)),
          h('div', { class: 'grow' },
            h('div', { class: 'row' },
              h('span', { class: 'ellipsis', title: it.name }, it.name || ''),
              ...tags),
            h('div', { class: 'mono small muted ellipsis', title: sub }, sub),
            h('div', { class: 'small muted' }, risk.why)),
          h('span', { class: 'badge ' + risk.level, title: risk.why }, risk.text),
          h('span', { class: 'size small' }, fmtBytes(it.size))
        );
        attachMenu(row, [
          { header: it.name || '' },
          { label: T('打开所在文件夹', 'Open containing folder'), icon: 'folder',
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
        row.addEventListener('dblclick', () => {
          API.reveal(it.path).catch((e) => toast(errText(e), 'error'));
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
    let emptyItems = [];
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
          { label: T('打开所在文件夹', 'Open containing folder'), icon: 'folder',
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
