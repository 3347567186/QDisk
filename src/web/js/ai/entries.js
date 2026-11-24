/* AI 助手 · 结果位置入口
   ------------------------------------------------------------
   问题：AI 说「打开 D:\Downloads 看看里面的大文件」，这句话既点不动，
   建议卡片上的按钮也只是换了个页面——用户点完还得自己一层层找。
   「给了方法却执行不了」比不给方法更糟。

   这一层只干一件事：把「这一轮真正碰过的位置」变成能点的入口，
   并且是全应用唯一一处「打开路径」的实现：

   · 目录 → 资源管理器；文件 → 系统默认程序
   · 可执行文件只定位、不运行（跟 open_path 工具的规矩一致）
   · 打不开就说真实原因（路径不存在 / 没权限），不静默失败
   · 右键：打开 / 在资源管理器中显示 / 复制路径 / 让助手再看看这里

   回答正文里的路径由 AIMd 渲染成 .md-path，点击也走这里的 open()，
   所以「点哪里」都是同一个行为，不会一处能开、一处不能。 */
(function (root) {
  'use strict';

  const UIx = root.UI;
  const API = root.API;
  const h = UIx.h;
  const T = UIx.T;

  /* 可执行文件不交给系统默认程序去跑：路径是模型给的，
     点一下就跑起来等于把「模型写的话」变成「用户执行的程序」。 */
  const EXEC_EXT = ['exe', 'msi', 'bat', 'cmd', 'ps1', 'scr', 'com', 'vbs', 'vbe',
    'js', 'jse', 'wsf', 'lnk', 'reg', 'hta'];

  const ARCHIVE_RE = /\.(?:tar\.(?:gz|bz2|xz|zst)|zip|rar|7z|tar|tgz|tbz2|txz|gz|bz2|xz|zst)$/i;

  function isExecPath(p) {
    const ext = extOf(p);
    return !!ext && EXEC_EXT.indexOf(ext) >= 0;
  }

  function isArchivePath(p) {
    return ARCHIVE_RE.test(stripSlash(String(p || '').trim()));
  }

  /* 百分比变量只能按已知目录猜：JS 读不到进程环境，Rust 那边也没必要为
     一个路径展开单开命令。这几个是标准位置，猜错也只是打不开而不是打错地方。 */
  let env = { home: '', data: '', exe: '' };
  let readyP = null;

  function ready() {
    if (readyP) return readyP;
    readyP = (async () => {
      try {
        const roots = await API.agentRoots();
        if (roots && roots.home) env.home = String(roots.home);
      } catch (e) { /* 拿不到就只做绝对路径 */ }
      try {
        const info = await API.appInfo();
        if (info) {
          env.data = String(info.data_dir || '');
          env.exe = String(info.exe_dir || '');
        }
      } catch (e) { /* 同上 */ }
      return env;
    })();
    return readyP;
  }

  function expand(p) {
    let s = String(p == null ? '' : p).trim();
    if (!s) return '';
    /* 去掉包裹的引号/反引号：模型常写成 "D:\x" 或 `D:\x` */
    s = s.replace(/^[`'"]+|[`'"]+$/g, '').trim();
    if (!/^%[^%]+%/.test(s)) return s;
    const home = env.home;
    const map = {
      '%USERPROFILE%': home,
      '%LOCALAPPDATA%': home ? home + '\\AppData\\Local' : '',
      '%APPDATA%': home ? home + '\\AppData\\Roaming' : '',
      '%TEMP%': home ? home + '\\AppData\\Local\\Temp' : '',
      '%TMP%': home ? home + '\\AppData\\Local\\Temp' : '',
      '%DSH_DATA%': env.data,
      '%APPDIR%': env.exe
    };
    return s.replace(/^%[^%]+%/, (m) => {
      const hit = map[m.toUpperCase()] || map[m] || '';
      return hit || m;
    });
  }

  /* 绝对路径：盘符 或 UNC。相对路径不认——认了就会在程序自己的目录里瞎开。 */
  function isAbs(p) {
    const s = String(p || '');
    return /^[A-Za-z]:[\\/]/.test(s) || /^\\\\[^\\]/.test(s);
  }

  function isPathLike(s) {
    const v = expand(s);
    return !!v && (isAbs(v) || /^%[^%]+%[\\/]/.test(String(s || '')));
  }

  function stripSlash(p) {
    let s = String(p || '');
    if (s.length > 3 && /[\\/]$/.test(s)) s = s.replace(/[\\/]+$/, '');
    return s;
  }

  function leafOf(p) {
    const t = stripSlash(p);
    const i = Math.max(t.lastIndexOf('\\'), t.lastIndexOf('/'));
    return i >= 0 ? t.slice(i + 1) : t;
  }

  function parentOf(p) {
    const t = stripSlash(p);
    if (!t) return '';
    if (/^[A-Za-z]:[\\/]?$/.test(t)) return '';
    /* UNC 共享根 \\server\share 没有可浏览父目录 */
    if (/^\\\\[^\\/]+[\\/][^\\/]+$/.test(t)) return '';
    const i = Math.max(t.lastIndexOf('\\'), t.lastIndexOf('/'));
    if (i <= 0) return '';
    const par = t.slice(0, i);
    /* 盘符根必须带尾反斜杠（C:\ 而非 C:），否则 Windows 当当前工作目录处理 */
    if (/^[A-Za-z]:$/.test(par)) return par + '\\';
    return par;
  }

  function extOf(p) {
    const n = leafOf(p);
    const i = n.lastIndexOf('.');
    return i > 0 ? n.slice(i + 1).toLowerCase() : '';
  }

  /* 目录还是文件：有可信来源就用来源的，没有才按「末段有没有扩展名」猜。
     猜错的代价只是「用默认程序打开一个目录」或反过来的失败提示。 */
  function kindOf(p, hint) {
    if (hint === 'dir' || hint === 'file') return hint;
    const n = leafOf(p);
    if (!n) return 'dir';
    return n.indexOf('.') > 0 ? 'file' : 'dir';
  }

  function entry(p, hint, src) {
    const path = stripSlash(expand(p));
    if (!path || !isAbs(path)) return null;
    const k = kindOf(path, hint);
    return { p: path, k: k, n: leafOf(path) || path, s: parentOf(path), src: src || 'tool' };
  }

  /* ---------------- 打开 ---------------- */

  function toastOf(e) {
    const msg = typeof e === 'string' ? e : (e && e.message) || '';
    return msg || T('打不开这个位置', 'Could not open this location');
  }

  /* 后端说「这个位置已经不在了：D:\x」时已经把路径写进句子里了，
     再补一遍会变成「…D:\x D:\x」。只有后端给的是「打不开：…」这类
     不带路径的短句，才把路径单独一行补上。 */
  function failToast(e, path) {
    const msg = toastOf(e);
    UIx.toast(msg.indexOf(path) >= 0 ? msg : msg + '\n' + path, 'warn', 4200);
  }

  async function expandAsync(raw) {
    const s = String(raw == null ? '' : raw).trim().replace(/^[`'"]+|[`'"]+$/g, '').trim();
    if (/^%[^%]+%/.test(s) && !env.home) {
      try { await ready(); } catch (_) {}
    }
    return stripSlash(expand(s));
  }

  /* 1.45 起：全链路真实探测 + 软件内优先路由。
     1) 所有本地路径优先走 Rust inspect_local_path 获取真实磁盘元数据（彻底废除 JS 靠「有没有 .」猜目录/文件）；
     2) 文件夹（含带点目录如 157.0.4341.60、OpenAI.Codex_...）→ 软件内 DirView 打开；
     3) 压缩包（.zip/.rar/.7z/.tar.* 等）→ 软件内压缩包页直接打开；
     4) 可执行文件（.exe/.msi 等）及普通文件 → 软件内 DirView 打开其父目录并自动翻页定位+高亮选中，
        绝不自动运行可执行文件，也绝不默认跳出系统文件管理器；
     5) 权限受限（WindowsApps 等）→ 自动回退到最近可读上级目录并展示权限横幅（支持管理员重启续跳）；
     6) 真正不存在 → 自动回退到最近存在的上级目录并明确提示，不再撞空页。 */
  async function resolveForJump(raw) {
    let path = await expandAsync(raw);
    if (!path) return '';
    if (API && typeof API.resolvePath === 'function') {
      try {
        const hit = await API.resolvePath(path);
        if (hit && typeof hit === 'string') return stripSlash(hit);
      } catch (e) { /* 非 Tauri / 测试环境静默降级 */ }
    }
    if (root.AIMd && typeof root.AIMd.cleanPath === 'function') {
      const cleaned = stripSlash(root.AIMd.cleanPath(path));
      if (cleaned && isAbs(cleaned)) return cleaned;
    }
    return path;
  }

  async function inspect(raw) {
    const expanded = await expandAsync(raw);
    if (!expanded) return { status: 'invalid', path: '', error: T('路径是空的', 'Path is empty') };
    if (API && typeof API.inspectPath === 'function') {
      try {
        const res = await API.inspectPath(expanded);
        if (res && typeof res === 'object' && res.status) {
          return res;
        }
      } catch (e) { /* 非 Tauri / 旧桩测试环境降级 */ }
    }
    const resolved = await resolveForJump(expanded);
    const k = kindOf(resolved);
    return {
      status: 'ok',
      path: resolved,
      exists: true,
      kind: k,
      readable: true,
      parent: parentOf(resolved),
      isExec: k === 'file' && isExecPath(resolved),
      isArchive: k === 'file' && isArchivePath(resolved),
      fallback: true
    };
  }

  async function resolvePaths(list) {
    const src = Array.isArray(list) ? list : [];
    const out = [];
    const seen = new Set();
    for (const raw of src) {
      if (!raw) continue;
      const p = await resolveForJump(String(raw));
      if (!p) continue;
      const key = p.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
    return out;
  }

  async function open(p, opts) {
    const o = opts || {};
    if (o.external) {
      return reveal(p);
    }
    const info = await inspect(p);
    if (!info || info.status === 'invalid' || !info.path) {
      failToast((info && info.error) || T('路径无效', 'Invalid path'), String(p || ''));
      return { ok: false, error: (info && info.error) || 'invalid' };
    }
    const path = stripSlash(info.path);
    const app = root.App;

    /* 权限受限（如 C:\Program Files\WindowsApps\...）：自动落到最近可读上级目录并高亮受限文件夹 */
    if (info.status === 'permission_denied') {
      const fbDir = stripSlash(info.nearestReadable || info.parent || '');
      if (app && typeof app.jump === 'function' && fbDir) {
        await app.jump('tools', {
          dir: fbDir,
          highlight: stripSlash(info.nearestReadableHighlight || path),
          paths: [path],
          action: 'browse',
          accessDenied: true,
          requestedPath: path
        });
        return { ok: true, inApp: true, accessDenied: true, fallbackDir: fbDir };
      }
      failToast(info.error || T('权限不足，需要管理员权限', 'Access denied; administrator required'), path);
      return { ok: false, accessDenied: true, error: info.error };
    }

    /* 目标缺失：若存在最近上级目录则自动在软件内打开并横幅提示，不再只给冷冰冰的空态 */
    if (info.status === 'not_found') {
      const fbDir = stripSlash(info.nearestExisting || '');
      if (app && typeof app.jump === 'function' && fbDir) {
        await app.jump('tools', {
          dir: fbDir,
          highlight: stripSlash(info.nearestExistingHighlight || ''),
          paths: [path],
          action: 'browse',
          missingTarget: path
        });
        UIx.toast(T('该位置已不存在，已为你定位到最近的上级目录', 'Location missing; opened nearest existing folder'), 'warn', 3600);
        return { ok: true, inApp: true, missingTarget: true, fallbackDir: fbDir };
      }
      failToast(info.error || T('这个位置已经不在了', 'This location no longer exists'), path);
      return { ok: false, notFound: true, error: info.error };
    }

    const kind = info.kind || kindOf(path, o.kind);
    const isArc = info.isArchive === true || (kind === 'file' && isArchivePath(path));
    const isExec = info.isExec === true || (kind === 'file' && isExecPath(path));

    /* 1. 压缩包：直达软件内「压缩包」页浏览 */
    if (isArc && !o.noArchive && !o.inDirView && app && typeof app.jump === 'function') {
      await app.jump('archive', { paths: [path] });
      return { ok: true, inApp: true, page: 'archive', path };
    }

    /* 2. 文件夹（含带点目录如 157.0.4341.60）：软件内 DirView 打开 */
    if (kind === 'dir' && app && typeof app.jump === 'function') {
      await app.jump('tools', { dir: path, paths: [path], action: 'browse' });
      return { ok: true, inApp: true, page: 'tools', path };
    }

    /* 3. 可执行文件与普通文件：软件内 DirView 打开父目录并自动翻页定位 + 高亮选中 */
    const targetDir = stripSlash(info.parent || parentOf(path));
    if (app && typeof app.jump === 'function' && targetDir) {
      await app.jump('tools', {
        dir: targetDir,
        highlight: path,
        paths: [path],
        action: 'browse',
        isExec: isExec,
        kind: 'file'
      });
      return { ok: true, inApp: true, page: 'tools', dir: targetDir, highlight: path, isExec };
    }

    /* 兜底（无 App 壳环境的极端情况）：可执行文件只定位不运行 */
    if (isExec) return reveal(path);
    return openSystemApp(path);
  }

  async function openSystemApp(p) {
    const path = await resolveForJump(p);
    if (!path) return { ok: false };
    if (isExecPath(path)) {
      UIx.toast(T('这是可执行文件，为防误运行不直接启动，请使用「系统文件管理器」查看',
        'Executable blocked from direct launch; reveal in Explorer instead'), 'warn', 3200);
      return { ok: false, blockedExec: true };
    }
    try {
      await API.openPath(path);
      return { ok: true };
    } catch (e) {
      failToast(e, path);
      return { ok: false, error: toastOf(e) };
    }
  }

  async function reveal(p) {
    const path = await resolveForJump(p);
    if (!path) return { ok: false };
    try {
      await API.reveal(path);
      return { ok: true, external: true };
    } catch (e) {
      failToast(e, path);
      return { ok: false, error: toastOf(e) };
    }
  }

  function copy(p) {
    UIx.copy(stripSlash(expand(p)));
  }

  /* 右键菜单：入口 chip 和正文里的 .md-path 共用一份 */
  function menu(evt, p, opts) {
    const path = stripSlash(expand(p));
    if (!path) return;
    const o = opts || {};
    const k = kindOf(path, o.kind);
    const isArc = isArchivePath(path);
    const items = [{ header: leafOf(path) || path }];
    items.push({
      label: isArc
        ? T('在软件「压缩包」中打开', 'Open in Archives')
        : (k === 'dir' ? T('在软件内浏览', 'Browse in app') : T('在软件内定位查看', 'Locate in app')),
      icon: isArc ? 'archive' : 'scan',
      action: () => { open(path); }
    });
    if (isArc) {
      items.push({
        label: T('在软件目录树中定位', 'Locate in folder view'),
        icon: 'folder',
        action: () => { open(path, { noArchive: true }); }
      });
    }
    if (k === 'dir') {
      items.push({
        label: T('在整理页处理', 'Organize this folder'),
        icon: 'organize',
        action: () => {
          const app = root.App;
          if (app && typeof app.jump === 'function') app.jump('organize', { paths: [path] });
          else location.hash = '#organize';
        }
      });
    } else if (!isExecPath(path)) {
      items.push({
        label: T('用系统默认程序打开', 'Open with default app'),
        icon: 'file',
        action: () => { openSystemApp(path); }
      });
    }
    items.push({
      label: T('在系统文件管理器中打开', 'Open in system file manager'),
      icon: 'external',
      action: () => { reveal(path); }
    });
    items.push({ label: T('复制路径', 'Copy path'), icon: 'copy', action: () => copy(path) });
    if (typeof o.onAsk === 'function') {
      items.push({ sep: true });
      items.push({ label: T('让助手看看这里', 'Ask the assistant about it'), icon: 'search', action: () => o.onAsk(path) });
    }
    UIx.menu(evt, items);
  }

  /* ---------------- 渲染 ---------------- */

  /* 一个位置 = 图标 + 名字 + 所在目录（名字左边已经写了，右边只补位置）。
     悬停给完整路径，右键给菜单，点击就是打开。 */
  /* 盘符根（D:\）的父目录就是它自己，再挂一个「· D:」只会让人以为弄错了 */
  function suffixOf(e) {
    if (!e.s) return '';
    const s = stripSlash(e.s);
    const n = stripSlash(e.n);
    if (s === n) return '';
    if (/^[A-Za-z]:$/.test(s) && /^[A-Za-z]:/.test(n)) return '';
    return e.s;
  }

  function chip(p, opts) {
    const o = opts || {};
    const e = entry(p, o.kind, o.src) || { p: p, k: 'file', n: String(p), s: '', src: 'suggest' };
    const suffix = suffixOf(e);
    const mainBtn = h('button', {
      class: 'ai-entry ' + (e.k === 'dir' ? 'is-dir' : 'is-file') + (o.compact ? ' compact' : ''),
      type: 'button',
      title: T('在软件内打开：', 'Open in app: ') + e.p,
      dataset: { path: e.p, kind: e.k }
    },
      UIx.icon(isArchivePath(e.p) ? 'archive' : (e.k === 'dir' ? 'folder' : 'file'), 14),
      h('span', { class: 'ai-entry-n' }, e.n),
      suffix ? h('span', { class: 'ai-entry-s' }, suffix) : null
    );
    mainBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      open(e.p);
    });
    const extTip = T('在系统文件管理器中打开', 'Open in system file manager');
    const extBtn = h('button', {
      class: 'ai-entry-ext' + (o.compact ? ' compact' : ''),
      type: 'button',
      title: extTip,
      'aria-label': extTip,
      dataset: { path: e.p }
    }, UIx.icon('external', 12));
    extBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      reveal(e.p);
    });
    const wrap = h('span', { class: 'ai-entry-wrap' + (o.compact ? ' compact' : ''), dataset: { path: e.p, kind: e.k } },
      mainBtn, extBtn);
    wrap.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      menu(ev, e.p, o);
    });
    return wrap;
  }

  /* 一条「结果位置」带：放在回答下面，用户读完话就能直接点到那个目录 */
  function bar(list, opts) {
    const o = opts || {};
    const items = (list || []).filter((x) => x && x.p);
    if (!items.length) return null;
    const wrap = h('div', { class: 'ai-entries' });
    wrap.appendChild(h('span', { class: 'ai-entries-label' },
      UIx.icon('folder', 13), h('span', {}, T('结果位置', 'Where the result is'))));
    const box = h('div', { class: 'ai-entries-list' });
    const MAX = Number(o.max) || 6;
    items.slice(0, MAX).forEach((it) => box.appendChild(chip(it.p, { kind: it.k, src: it.src, onAsk: o.onAsk })));
    wrap.appendChild(box);
    if (items.length > MAX) {
      const more = h('button', {
        class: 'ai-entry more',
        type: 'button',
        onclick: () => {
          items.slice(MAX).forEach((it) => box.appendChild(chip(it.p, { kind: it.k, src: it.src, onAsk: o.onAsk })));
          more.remove();
        }
      }, T('还有 ' + (items.length - MAX) + ' 个位置', '+' + (items.length - MAX) + ' more'));
      box.appendChild(more);
    }
    return wrap;
  }

  /* ---------------- 从一轮结果里收集位置 ----------------
     只收这一轮工具真的碰过的绝对路径：不猜、不编。
     顺序有意义——先生成建议要处理的，再是查过的目录，最后是个别文件。 */
  const DIR_ARG = { list_dir: 'dir', top_files: 'dir', empty_dirs: 'dir', organize_preview: null };
  const FILE_ARG = { read_file: 'path', open_path: 'path', archive_entries: 'path' };

  function collect(trace, suggest) {
    const out = [];
    const seen = new Set();
    const add = (p, kind, src) => {
      const e = entry(p, kind, src);
      if (!e) return;
      const k = e.p.toLowerCase();
      if (seen.has(k)) return;
      seen.add(k);
      out.push(e);
    };

    (suggest || []).forEach((s) => {
      (s && s.paths ? s.paths : []).slice(0, 5).forEach((p) => add(p, null, 'suggest'));
    });

    const steps = Array.isArray(trace) ? trace : [];
    /* 第一遍：目录（用户更想先看到「在哪个文件夹」） */
    steps.forEach((t) => {
      if (!t || t.ok === false) return;
      const a = t.args || {};
      const r = t.result || {};
      if (DIR_ARG[t.tool]) add(a[DIR_ARG[t.tool]], 'dir', t.tool);
      if (r.dir) add(r.dir, 'dir', t.tool);
      if (r.home) add(r.home, 'dir', t.tool);
    });
    /* 第二遍：文件与列表项 */
    steps.forEach((t) => {
      if (!t || t.ok === false) return;
      const a = t.args || {};
      const r = t.result || {};
      if (FILE_ARG[t.tool]) add(a[FILE_ARG[t.tool]], 'file', t.tool);
      if (Array.isArray(a.paths)) a.paths.slice(0, 3).forEach((p) => add(p, null, t.tool));
      if (Array.isArray(r.paths)) r.paths.slice(0, 4).forEach((p) => add(p, null, t.tool));
      if (Array.isArray(r.items)) {
        r.items.slice(0, 6).forEach((it) => {
          if (!it) return;
          if (typeof it === 'string') add(it, null, t.tool);
          else if (it.path) add(it.path, it.kind === 'dir' ? 'dir' : null, t.tool);
          else if (it.exe_path) add(it.exe_path, 'file', t.tool);
          else if (it.install_path) add(it.install_path, 'dir', t.tool);
          else if (it.dir && it.name) add(stripSlash(it.dir) + '\\' + it.name, 'file', t.tool);
          else if (it.dir) add(it.dir, 'dir', t.tool);
        });
      }
      if (Array.isArray(r.groups)) {
        r.groups.slice(0, 4).forEach((g) => {
          (g && g.paths ? g.paths : []).slice(0, 3).forEach((p) => add(p, null, t.tool));
        });
      }
    });
    return out.slice(0, 16);
  }

  /* 正文里出现的路径（AI 常把位置写在句子里）。AIMd 已经把它们渲染成
     .md-path；这个函数给「纯文本回放」用，复用 AIMd.splitPathTail 保持两条路完全一致。 */
  const RE_PATH = /(?:[A-Za-z]:[\\/]|\\\\[^\\\s<>'"&:])(?:(?![A-Za-z]:[\\/])[^\s<>"'`|?*:，。；：！？、（）【】「」『』《》〈〉—…·])*/g;

  function fromText(text) {
    const out = [];
    const seen = new Set();
    const clean = (s) => (root.AIMd && typeof root.AIMd.cleanPath === 'function')
      ? root.AIMd.cleanPath(s)
      : s.replace(/[.,;:!?)\]}]+$/, '');
    String(text || '').replace(RE_PATH, (m) => {
      const p = stripSlash(clean(m));
      if (!p || (!/^[A-Za-z]:[\\/]$/.test(p) && p.length < 4)) return m;
      const k = p.toLowerCase();
      if (!seen.has(k)) { seen.add(k); const e = entry(p, null, 'text'); if (e) out.push(e); }
      return m;
    });
    return out.slice(0, 8);
  }

  /* 消息区挂一次：正文里的 .md-path 与外链都由这里接管。
     外链不能靠 target="_blank"——WebView2 里没有窗口处理器，点了什么都不发生，
     这正是「跳过去什么用都没有」的另一种形态。 */
  function bind(scope, opts) {
    const o = opts || {};
    if (!scope || scope.__aiEntriesBound) return;
    scope.__aiEntriesBound = true;
    scope.addEventListener('click', (ev) => {
      const t = ev.target;
      if (!t || !t.closest) return;
      const extBtn = t.closest('.md-path-ext');
      if (extBtn) {
        ev.preventDefault();
        ev.stopPropagation();
        reveal(extBtn.getAttribute('data-path') || '');
        return;
      }
      const pathEl = t.closest('.md-path');
      if (pathEl) {
        ev.preventDefault();
        ev.stopPropagation();
        open(pathEl.getAttribute('data-path') || '');
        return;
      }
      const a = t.closest('a.md-link');
      if (a) {
        ev.preventDefault();
        ev.stopPropagation();
        const href = a.getAttribute('href') || '';
        if (/^https?:/i.test(href)) {
          /* 外部链接交给系统浏览器：应用内没有浏览器，开窗口只会得到一个白框 */
          API.openPath(href).catch((e) => UIx.toast(toastOf(e), 'warn'));
        } else if (href) {
          UIx.copy(href);
        }
        return;
      }
    });
    scope.addEventListener('contextmenu', (ev) => {
      const t = ev.target;
      if (!t || !t.closest) return;
      const pathEl = t.closest('.md-path, .md-path-ext');
      if (!pathEl) return;
      ev.preventDefault();
      ev.stopPropagation();
      menu(ev, pathEl.getAttribute('data-path') || '', o);
    });
  }

  root.AIEntries = {
    ready,
    expand,
    expandAsync,
    resolveForJump,
    resolvePaths,
    inspect,
    isPathLike,
    isAbs,
    isExecPath,
    isArchivePath,
    entry,
    leafOf,
    parentOf,
    kindOf,
    open,
    openSystemApp,
    reveal,
    copy,
    menu,
    chip,
    bar,
    collect,
    fromText,
    bind
  };
})(typeof window !== 'undefined' ? window : globalThis);
