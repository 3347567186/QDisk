/* AI 助手 · 动作注册表
   ------------------------------------------------------------
   模型能「提议」的所有操作都在这张表里。表外的动作不存在，
   所以「AI 不会跑任意命令」是结构性的。

   每个动作分两段：
   · plan(args)  只读预演，用引擎自己的 dry-run 拿真实数字（数量/大小/被拒项）
   · run(args)   真正执行，只在用户点了审批按钮之后由 proposals.js 调用

   风险分级（决定哪一档权限能自动放行）：
     1 = 可逆、影响小（整理、解压、建包、索引、设置）
     2 = 进回收站 / 删注册表项 / 移动（能找回，但麻烦）
     3 = 不可逆（永久删除、硬清缓存、卸载、强制删除、残留清理、清日志）

   能力分类用于「哪些类别允许 AI 动手」的开关：organize/files/archive/clean/apps/search/settings。 */
(function (root) {
  'use strict';

  const GB = 1024 * 1024 * 1024;
  const LIMIT_ITEMS = 200;     // 单次动作条目上限
  const LIMIT_BYTES = 4 * GB;  // 单次动作字节上限

  const fmtBytes = (n) => {
    const v = Number(n) || 0;
    if (v < 1024) return v + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let i = -1;
    let x = v;
    do { x /= 1024; i += 1; } while (x >= 1024 && i < units.length - 1);
    return (x >= 10 ? x.toFixed(0) : x.toFixed(1)) + ' ' + units[i];
  };

  const base = (p) => {
    const s = String(p || '');
    const i = s.lastIndexOf('\\');
    return i >= 0 ? s.slice(i + 1) : s;
  };

  const SETTING_LABEL = {
    conflict_policy: '同名文件处理',
    close_action: '关闭按钮行为',
    tray_pin: '托盘图钉',
    shot_time: '截图清理时间',
    cache_time: '缓存清理时间',
    default_recursive: '默认递归',
    default_content: '默认含内容',
    shot_auto: '截图自动清理',
    shot_to_trash: '截图清理走回收站',
    cache_auto: '缓存自动清理',
    cache_to_trash: '缓存清理走回收站',
    tray_enabled: '启用托盘',
    close_to_tray: '关闭到托盘',
    recursive_depth: '递归深度',
    log_keep_days: '日志保留天数',
    shot_keep_days: '截图保留天数',
    shot_min_kb: '截图最小体积(KB)'
  };

  /* 参数绑定：拒绝未知键、强制类型、长度上限。
     模型的参数错误在这里变成一句能看懂的话，它会自己换参数重试。 */
  function bind(schema, raw) {
    const a = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
    const keys = Object.keys(schema);
    for (const k of Object.keys(a)) {
      if (!schema[k]) throw new Error('不认识参数 ' + k + '（可用：' + keys.join('、') + '）');
    }
    const out = {};
    for (const k of keys) {
      const s = schema[k];
      const v = a[k];
      if (v === undefined || v === null || v === '') {
        if (s.req) throw new Error('缺少参数 ' + k + (s.hint ? '（' + s.hint + '）' : ''));
        if (s.def !== undefined) out[k] = s.def;
        continue;
      }
      if (s.type === 'paths') {
        const arr = Array.isArray(v) ? v : [v];
        const list = arr.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
        if (!list.length) throw new Error(k + ' 需要至少一个完整路径');
        if (list.length > (s.max || LIMIT_ITEMS)) {
          throw new Error(k + ' 一次最多 ' + (s.max || LIMIT_ITEMS) + ' 个，这次给了 ' + list.length + ' 个');
        }
        out[k] = list;
      } else if (s.type === 'string') {
        if (typeof v !== 'string') throw new Error(k + ' 需要字符串');
        const t = v.trim();
        if (!t) throw new Error(k + ' 不能为空');
        if (s.maxLen && t.length > s.maxLen) throw new Error(k + ' 太长（上限 ' + s.maxLen + ' 字）');
        out[k] = t;
      } else if (s.type === 'bool') {
        out[k] = v === true || v === 'true';
      } else if (s.type === 'int') {
        const n = Math.floor(Number(v));
        if (!isFinite(n)) throw new Error(k + ' 需要整数');
        if (s.min != null && n < s.min) throw new Error(k + ' 不能小于 ' + s.min);
        if (s.max != null && n > s.max) throw new Error(k + ' 不能大于 ' + s.max);
        out[k] = n;
      } else if (s.type === 'enum') {
        const t = String(v).trim().toLowerCase();
        if (s.values.indexOf(t) < 0) throw new Error(k + ' 只能是 ' + s.values.join(' / '));
        out[k] = t;
      } else if (s.type === 'json') {
        out[k] = v;
      }
    }
    return out;
  }

  function create(deps) {
    const API = deps.API;
    const E = (m, p) => API.engine(m, p || {});

    /* 统一把「被引擎拒绝的项」变成卡片上的红色条目 */
    const failItems = (failed, key) => (failed || []).slice(0, 6).map((f) => ({
      t: base(f[key] || f.path || f.target || f.source || ''),
      s: String(f.why || '被拒绝'),
      d: true
    }));

    const sum = (arr, f) => arr.reduce((n, x) => n + (Number(f(x)) || 0), 0);

    /* ---------------------------------------------------------------- 整理 */
    const organizeApply = {
      id: 'organize.apply',
      cat: 'organize',
      label: '按类型整理',
      desc: '把目录里的文件按类型移进分类子目录（可撤销）',
      risk: 1,
      reversible: true,
      undoKind: 'undo',
      schema: {
        paths: { type: 'paths', req: true, max: 50, hint: '要整理的目录或文件完整路径' },
        recursive: { type: 'bool', def: true },
        policy: { type: 'enum', values: ['rename', 'skip', 'overwrite'], def: 'rename' },
        dest_root: { type: 'string', maxLen: 260 },
        date_fmt: { type: 'string', maxLen: 40 }
      },
      async plan(p) {
        const rawPaths = p.paths || p.path;
        const paths = (Array.isArray(rawPaths) ? rawPaths : [rawPaths]).filter((x) => typeof x === 'string' && x.trim());
        const r = await E('scan', {
          paths: paths, recursive: p.recursive, skip_recent: false, skip_shortcuts: true
        });
        const plans = (r && r.plans) || [];
        const blockedList = Array.isArray(r && r.blocked) ? r.blocked : [];
        const items = [];
        const cats = {};
        for (const b of blockedList) {
          items.push({ t: base(b.folder) || b.folder, s: '无法整理：' + (b.error || '受保护'), d: true });
        }
        for (const pl of plans) {
          if (pl.error) {
            items.push({ t: base(pl.folder), s: '跳过：' + pl.error, d: true });
            continue;
          }
          for (const g of pl.groups || []) {
            cats[g.cat] = (cats[g.cat] || 0) + (Number(g.count) || 0);
          }
          const n = sum(pl.groups || [], (g) => g.count);
          if (n) items.push({ t: base(pl.folder), s: n + ' 个文件' });
        }
        const catLine = Object.keys(cats).slice(0, 8).map((c) => c + ' ' + cats[c]).join(' · ');
        const plans2 = { paths: paths, total: r.total || 0, total_size: r.total_size || 0, blocked: blockedList.length };
        const warnings = [];
        if (blockedList.length) {
          warnings.push('有 ' + blockedList.length + ' 个路径受保护无法整理：' + blockedList.map((b) => (b.folder + ' (' + (b.error || '受限') + ')')).join('；'));
        }
        return {
          title: '按类型整理',
          summary: r.total
            ? ('把 ' + r.total + ' 个文件（' + fmtBytes(r.total_size) + '）移进分类文件夹' + (catLine ? '：' + catLine : ''))
            : (blockedList.length ? '目标路径受保护或不可整理' : '没有发现需要整理的文件'),
          items: items.slice(0, 8),
          count: Number(r.total) || 0,
          bytes: Number(r.total_size) || 0,
          warnings: warnings,
          params: plans2,
          note: blockedList.length && !r.total
            ? blockedList.map((b) => b.folder + '：' + b.error).join('；')
            : (p.policy === 'overwrite' ? '同名文件会被覆盖' : (p.policy === 'skip' ? '同名文件会跳过' : '同名文件自动改名'))
        };
      },
      async run(p) {
        const r = await E('organize', {
          paths: p.paths,
          recursive: p.recursive,
          policy: p.policy,
          dest_root: p.dest_root || null,
          date_fmt: p.date_fmt || null,
          confirm: true
        });
        const folders = ((r && r.history) || []).map((h) => h.folder).filter(Boolean);
        return {
          result: { moved: r.moved || 0, failed: (r.failed || []).length, folders },
          undo: folders.length ? { kind: 'undo', folders, label: '撤销整理' } : null,
          message: '已移动 ' + (r.moved || 0) + ' 个文件'
        };
      }
    };

    /* ---------------------------------------------------------------- 删除 */
    const filesDelete = {
      id: 'files.delete',
      cat: 'files',
      label: '删除文件',
      desc: '删除指定的文件或文件夹（默认进回收站）',
      risk: 2,
      reversible: true,
      undoKind: 'recycle',
      schema: {
        paths: { type: 'paths', req: true, max: LIMIT_ITEMS, hint: '要删除的完整路径' },
        mode: { type: 'enum', values: ['trash', 'permanent'], def: 'trash' }
      },
      async plan(p) {
        const mode = p.mode;
        const r = await E('files.delete', { paths: p.paths, mode, confirm: false });
        const failed = (r && r.failed) || [];
        const total = p.paths.length;
        const okCount = r && r.count != null ? Number(r.count) : (total - failed.length);
        const bytes = Number(r && r.total_size) || 0;
        /* 引擎预演现在逐项给 size/why/partial：卡片上直接写「多大、为什么被拒」，
           不再只列个路径让用户自己猜 */
        const rows = (r && Array.isArray(r.items) && r.items.length) ? r.items.slice(0, 8).map((x) => {
          const s = String(x.path || '');
          const i = s.lastIndexOf('\\');
          return {
            t: base(s),
            s: i > 2 ? s.slice(0, i) : '',
            d: false,
            size: x.size,
            why: x.why || '',
            partial: !!x.partial
          };
        }).map((x) => ({
          t: x.t,
          s: x.s + (x.size ? ' · ' + fmtBytes(x.size) + (x.partial ? '+' : '') : '') +
            (x.why ? ' · ' + x.why : ''),
          d: !!x.why
        })) : ((r && r.paths) || p.paths).slice(0, 8).map((x) => {
          const s = String(x);
          const i = s.lastIndexOf('\\');
          return { t: base(s), s: i > 2 ? s.slice(0, i) : '' };
        });
        const list = rows;
        return {
          title: mode === 'permanent' ? '永久删除' : '删除到回收站',
          /* 同一个动作两种命运：进回收站能捞回来（风险 2），永久删除捞不回来（风险 3）。
             风险值决定「放手」档会不会自动执行，所以必须按参数分开报。 */
          riskNow: mode === 'permanent' ? 3 : 2,
          reversibleNow: mode !== 'permanent',
          summary: (mode === 'permanent' ? '永久删除 ' : '把 ') + okCount + ' 项' +
            (bytes ? '（' + fmtBytes(bytes) + '）' : '') + (mode === 'permanent' ? '' : ' 移入回收站'),
          items: list.concat(failItems(failed, 'target')),
          count: okCount,
          bytes,
          warnings: failed.length ? ['有 ' + failed.length + ' 项会被拒绝（见下方红色条目）'] : [],
          params: { paths: p.paths, mode },
          note: mode === 'permanent' ? '永久删除不可撤销，不进回收站' : '可以从回收站还原'
        };
      },
      async run(p) {
        const r = await E('files.delete', { paths: p.paths, mode: p.mode, confirm: true });
        return {
          result: { deleted: r.count || 0, failed: (r.failed || []).length, mode: p.mode },
          undo: p.mode === 'trash' ? { kind: 'recycle', label: '打开回收站' } : null,
          message: (p.mode === 'trash' ? '已把 ' : '已永久删除 ') + (r.count || 0) + ' 项'
        };
      }
    };

    const filesEmpty = {
      id: 'files.remove_empty',
      cat: 'files',
      label: '删空文件夹',
      desc: '删除确认没有内容的文件夹（不可撤销）',
      risk: 2,
      reversible: false,
      undoKind: 'none',
      schema: { paths: { type: 'paths', req: true, max: 100, hint: '空文件夹完整路径' } },
      async plan(p) {
        const items = [];
        const empties = [];
        for (const dir of p.paths.slice(0, 40)) {
          const why = root.AIGuard ? root.AIGuard.denyWhy(dir) : '';
          if (why) { items.push({ t: base(dir), s: why, d: true }); continue; }
          try {
            const r = await API.listDir(dir, 5);
            const n = (r && (r.total != null ? r.total : (r.items || []).length)) || 0;
            if (n > 0) { items.push({ t: base(dir), s: '里面还有 ' + n + ' 项，不是空的', d: true }); continue; }
            empties.push(dir);
            items.push({ t: base(dir), s: dir });
          } catch (e) {
            items.push({ t: base(dir), s: '读不到：' + (e.message || e), d: true });
          }
        }
        return {
          title: '删除空文件夹',
          summary: '删除 ' + empties.length + ' 个空文件夹',
          items,
          count: empties.length,
          bytes: 0,
          warnings: empties.length ? ['删除空文件夹不进回收站，删了就没了'] : [],
          params: { paths: empties },
          note: '只删确认没有内容的文件夹'
        };
      },
      async run(p) {
        const r = await API.removeEmptyDirs(p.paths);
        return {
          result: { removed: (r && r.removed || []).length, failed: (r && r.failed || []).length },
          undo: null,
          message: '已删除 ' + ((r && r.removed || []).length) + ' 个空文件夹'
        };
      }
    };

    /* -------------------------------------------------------------- 压缩包 */
    const archiveExtract = {
      id: 'archive.extract',
      cat: 'archive',
      label: '解压',
      desc: '把压缩包解压到指定目录',
      risk: 1,
      reversible: true,
      undoKind: 'trash-dir',
      schema: {
        path: { type: 'string', req: true, maxLen: 260, hint: '压缩包完整路径' },
        out_dir: { type: 'string', maxLen: 260, hint: '解压到的目录，省略则用压缩包同名的目录' },
        password: { type: 'string', maxLen: 120 },
        overwrite: { type: 'bool', def: false }
      },
      async plan(p) {
        const info = await API.archiveOpen(p.path);
        const out = p.out_dir || p.path.replace(/\.[^.\\]+$/, '');
        const why = root.AIGuard ? root.AIGuard.denyWhy(out) : '';
        if (why) throw new Error('解压目录不可用：' + why);
        const entries = (info && info.entries) || [];
        const files = entries.filter((e) => !e.dir).length;
        const warnings = [];
        if (info && info.encrypted && !p.password) warnings.push('这个压缩包有密码，没有密码会失败');
        if (info && info.needsRar && !info.rar_ready) warnings.push('需要 UnRAR 组件，当前还没就绪');
        return {
          title: '解压',
          summary: '把 ' + files + ' 个文件（' + fmtBytes(info && info.totalSize) + '）解压到 ' + out,
          items: entries.slice(0, 6).map((e) => ({ t: e.name, s: fmtBytes(e.size) })),
          count: files,
          bytes: Number(info && info.totalSize) || 0,
          warnings,
          params: Object.assign({}, p, { out_dir: out }),
          note: '解压会新建文件；如果目录本来不存在，撤销时把整个目录移入回收站'
        };
      },
      async run(p) {
        const out = p.out_dir || p.path.replace(/\.[^.\\]+$/, '');
        const r = await API.archiveExtract(p.path, out, null, p.password || null, p.overwrite === true, null);
        return {
          result: { files: (r && r.files) || 0, bytes: (r && r.bytes) || 0, out },
          undo: { kind: 'trash-path', path: out, label: '移除解压出的目录' },
          message: '已解压 ' + ((r && r.files) || 0) + ' 个文件到 ' + out
        };
      }
    };

    const archiveCreate = {
      id: 'archive.create',
      cat: 'archive',
      label: '压缩',
      desc: '把文件或目录打包成 zip / 7z / tar',
      risk: 1,
      reversible: true,
      undoKind: 'trash-file',
      schema: {
        sources: { type: 'paths', req: true, max: 100, hint: '要打包的文件或目录' },
        dest: { type: 'string', req: true, maxLen: 260, hint: '输出压缩包完整路径' },
        format: { type: 'enum', values: ['zip', '7z', 'tar'], def: 'zip' },
        password: { type: 'string', maxLen: 120 }
      },
      async plan(p) {
        const why = root.AIGuard ? root.AIGuard.denyWhy(p.dest) : '';
        if (why) throw new Error('输出位置不可用：' + why);
        if (!/\.[^.\\]+$/.test(base(p.dest))) throw new Error('dest 需要带扩展名（如 .zip）');
        return {
          title: '压缩',
          summary: '把 ' + p.sources.length + ' 项打包成 ' + base(p.dest) + '（' + p.format + '）',
          items: p.sources.slice(0, 8).map((s) => ({ t: base(s), s: s })),
          count: p.sources.length,
          bytes: 0,
          warnings: [],
          params: p,
          note: '打包时才统计大小；同名压缩包会被覆盖'
        };
      },
      async run(p) {
        const r = await API.archiveCreate(p.sources, p.dest, p.format, 'add', p.password || null);
        return {
          result: { dest: p.dest, bytes: (r && r.bytes) || 0 },
          undo: { kind: 'trash-file', path: p.dest, label: '删除这个压缩包' },
          message: '已生成 ' + base(p.dest)
        };
      }
    };

    /* ---------------------------------------------------------------- 清理 */
    const cleanCache = {
      id: 'clean.cache',
      cat: 'clean',
      label: '清缓存',
      desc: '清空缓存目录里的内容（目录本身保留，不可撤销）',
      risk: 3,
      reversible: false,
      undoKind: 'none',
      schema: { paths: { type: 'paths', req: true, max: 100, hint: '缓存目录完整路径' } },
      async plan(p) {
        const r = await E('cache.clean', { paths: p.paths, confirm: false });
        const failed = (r && r.failed) || [];
        return {
          title: '清理缓存',
          summary: '清掉 ' + (r.would_clean || 0) + ' 个目录里的内容，预计释放 ' + fmtBytes(r.would_free) + '（目录本身保留）',
          items: p.paths.slice(0, 6).map((x) => ({ t: base(x), s: x })).concat(failItems(failed, 'path')),
          count: Number(r.would_clean) || 0,
          bytes: Number(r.would_free) || 0,
          warnings: ['缓存清掉就没了，不进回收站'].concat(failed.length ? ['有 ' + failed.length + ' 个目录会被拒绝'] : []),
          params: p,
          note: '只清内容，不删目录'
        };
      },
      async run(p) {
        const r = await E('cache.clean', { paths: p.paths, confirm: true });
        return {
          result: { cleaned: r.cleaned || 0, freed: r.freed || 0 },
          undo: null,
          message: '已释放 ' + fmtBytes(r.freed)
        };
      }
    };

    const cleanShots = {
      id: 'clean.shots',
      cat: 'clean',
      label: '清截图',
      desc: '把符合保留规则的截图移入回收站',
      risk: 2,
      reversible: true,
      undoKind: 'recycle',
      schema: {
        paths: { type: 'paths', req: true, max: LIMIT_ITEMS, hint: '截图目录完整路径' },
        all_images: { type: 'bool', def: false }
      },
      async plan(p) {
        const r = await E('shots.clean', { paths: p.paths, confirm: false, all_images: p.all_images });
        const failed = (r && r.failed) || [];
        return {
          title: '清理截图',
          summary: '把 ' + (r.would_delete || 0) + ' 张截图移入回收站，释放 ' + fmtBytes(r.would_free),
          items: p.paths.slice(0, 6).map((x) => ({ t: base(x), s: x })).concat(failItems(failed, 'path')),
          count: Number(r.would_delete) || 0,
          bytes: Number(r.would_free) || 0,
          warnings: failed.length ? ['有 ' + failed.length + ' 个目录会被拒绝'] : [],
          params: p,
          note: '进回收站，可以还原'
        };
      },
      async run(p) {
        const r = await E('shots.clean', { paths: p.paths, confirm: true, all_images: p.all_images });
        return {
          result: { deleted: r.deleted || 0, freed: r.freed || 0 },
          undo: { kind: 'recycle', label: '打开回收站' },
          message: '已移入回收站 ' + (r.deleted || 0) + ' 张'
        };
      }
    };

    /* ------------------------------------------------------------ 已装程序 */
    const findApp = async (name) => {
      const r = await E('apps.list', {});
      const all = (r && r.items) || [];
      const q = String(name || '').trim().toLowerCase();
      if (!q) throw new Error('缺少应用名');
      let hit = all.filter((it) => String(it.name || '').toLowerCase() === q);
      if (hit.length !== 1) {
        const like = all.filter((it) => String(it.name || '').toLowerCase().indexOf(q) >= 0);
        if (like.length === 1) hit = like;
        else if (like.length > 1) {
          throw new Error('「' + name + '」匹配到多个程序，请给更完整的名字：' +
            like.slice(0, 6).map((x) => x.name).join('、'));
        } else {
          throw new Error('没找到叫「' + name + '」的已安装程序');
        }
      }
      return hit[0];
    };

    const appsUninstall = {
      id: 'apps.uninstall',
      cat: 'apps',
      label: '卸载程序',
      desc: '启动程序自带的卸载器（卸载过程由那个程序自己控制）',
      risk: 3,
      reversible: false,
      undoKind: 'none',
      schema: {
        name: { type: 'string', req: true, maxLen: 120, hint: '已安装程序的名字' },
        mode: { type: 'enum', values: ['auto', 'interactive', 'quiet'], def: 'auto' }
      },
      async plan(p) {
        const app = await findApp(p.name);
        const r = await E('apps.uninstall', { name: app.name, mode: p.mode, confirm: false });
        return {
          title: '卸载「' + app.name + '」',
          summary: '会启动它自带的卸载器：' + (r.command || ''),
          items: [{ t: app.name, s: app.install_path || app.location || '' }],
          count: 1,
          bytes: 0,
          warnings: ['卸载由那个程序自己执行，可能需要你在弹出的窗口里点下一步', '卸载不可撤销'],
          params: { name: app.name, mode: p.mode },
          note: 'AI 只负责启动卸载器，删不删由那个程序决定'
        };
      },
      async run(p) {
        const r = await E('apps.uninstall', { name: p.name, mode: p.mode, confirm: true });
        return {
          result: { name: r.name, started: r.started },
          undo: null,
          message: (r.started ? '已启动「' : '没能启动「') + r.name + '」的卸载器'
        };
      }
    };

    const appsDeleteEntry = {
      id: 'apps.delete_entry',
      cat: 'apps',
      label: '删注册表项',
      desc: '只删「已安装程序」列表里的注册表卸载项，不删程序文件',
      risk: 2,
      reversible: false,
      undoKind: 'none',
      schema: { name: { type: 'string', req: true, maxLen: 120 } },
      async plan(p) {
        const app = await findApp(p.name);
        const r = await E('apps.delete_entry', { name: app.name, confirm: false });
        return {
          title: '从已安装列表移除「' + app.name + '」',
          summary: '只删注册表卸载项，程序文件不动',
          items: [{ t: r.hive || '', s: r.key || '' }],
          count: 1,
          bytes: 0,
          warnings: ['删了就不好恢复；想连文件一起删用「强制删除」'],
          params: { name: app.name },
          note: '适合卸载失败后残留的列表项'
        };
      },
      async run(p) {
        const r = await E('apps.delete_entry', { name: p.name, confirm: true });
        return { result: { keys: r.removed_keys || 0 }, undo: null, message: '已删掉注册表项' };
      }
    };

    const appsForceRemove = {
      id: 'apps.force_remove',
      cat: 'apps',
      label: '强制删除',
      desc: '删安装目录 + 注册表卸载项（不可撤销）',
      risk: 3,
      reversible: false,
      undoKind: 'none',
      schema: { name: { type: 'string', req: true, maxLen: 120 } },
      async plan(p) {
        const app = await findApp(p.name);
        const r = await E('apps.force_remove', { name: app.name, confirm: false });
        const dirs = r.dirs || [];
        return {
          title: '强制删除「' + app.name + '」',
          summary: '删掉安装目录和注册表卸载项，不走那个程序的卸载器',
          items: dirs.slice(0, 6).map((d) => ({ t: base(d), s: d, d: true })),
          count: dirs.length + (r.key ? 1 : 0),
          bytes: 0,
          warnings: ['不进回收站，删了就没了', '如果这个程序还在运行，部分文件可能删不掉'],
          params: { name: app.name },
          note: '用于卸载器坏掉或找不到的程序'
        };
      },
      async run(p) {
        const r = await E('apps.force_remove', { name: p.name, confirm: true });
        return { result: { removed: (r.removed || []).length, failed: (r.failed || []).length }, undo: null, message: '已删除' };
      }
    };

    const appsCleanup = {
      id: 'apps.cleanup',
      cat: 'apps',
      label: '清残留',
      desc: '清掉扫描出的残留目录与注册表键（先自动备份注册表）',
      risk: 3,
      reversible: false,
      undoKind: 'none',
      schema: { name: { type: 'string', req: true, maxLen: 120 } },
      async plan(p) {
        const app = await findApp(p.name);
        const r = await E('apps.cleanup', { name: app.name, confirm: false });
        const dirs = r.dirs || [];
        const regs = r.regs || [];
        return {
          title: '清理「' + app.name + '」的残留',
          summary: '删 ' + dirs.length + ' 个残留目录、' + regs.length + ' 个注册表键',
          items: dirs.slice(0, 4).map((d) => ({ t: base(d), s: d, d: true }))
            .concat(regs.slice(0, 4).map((k) => ({ t: k.key, s: k.hive, d: true }))),
          count: dirs.length + regs.length,
          bytes: 0,
          warnings: ['注册表会先导出备份到：' + (r.backup_dir || '数据目录'), '删掉的文件不进回收站'],
          params: { name: app.name },
          note: '有备份，但恢复要靠手工导入 .reg'
        };
      },
      async run(p) {
        const r = await E('apps.cleanup', { name: p.name, confirm: true });
        return {
          result: { dirs: (r.removed_dirs || []).length, regs: (r.removed_regs || []).length, failed: (r.failed || []).length },
          undo: null,
          message: '已清理残留'
        };
      }
    };

    const appsRemoveStore = {
      id: 'apps.remove_store',
      cat: 'apps',
      label: '卸载商店应用',
      desc: '卸载当前用户的 Microsoft Store 应用（不可撤销）',
      risk: 3,
      reversible: false,
      undoKind: 'none',
      schema: { name: { type: 'string', req: true, maxLen: 160 } },
      async plan(p) {
        const list = (await API.storeApps()) || [];
        const q = String(p.name || '').trim().toLowerCase();
        const exact = list.filter((it) => String(it.name || '').toLowerCase() === q ||
          String(it.package || '').toLowerCase() === q);
        const hit = exact.length === 1 ? exact
          : list.filter((it) => String(it.name || '').toLowerCase().indexOf(q) >= 0);
        if (hit.length !== 1) {
          throw new Error(hit.length > 1
            ? '匹配到多个应用：' + hit.slice(0, 6).map((x) => x.name).join('、')
            : '没找到这个商店应用（名字要用列表里的完整名）');
        }
        const it = hit[0];
        return {
          title: '卸载商店应用「' + it.name + '」',
          summary: '从当前用户移除 ' + it.name + '（' + (it.version || '') + '）',
          items: [{ t: it.name, s: it.publisher || '', d: true }],
          count: 1,
          bytes: 0,
          warnings: ['不可撤销，需要去商店重新安装'],
          params: { name: it.name, package: it.package },
          note: '只影响当前用户'
        };
      },
      async run(p) {
        await API.removeStoreApp(p.package, true);
        return { result: { name: p.name }, undo: null, message: '已卸载 ' + p.name };
      }
    };

    /* ------------------------------------------------------------ 自启动项 */
    const findStartup = async (name) => {
      const r = await E('startup.list', {});
      const all = (r && r.items) || [];
      const q = String(name || '').trim().toLowerCase();
      if (!q) throw new Error('缺少自启动项名称');
      let hit = all.filter((it) => String(it.name || '').toLowerCase() === q);
      if (hit.length !== 1) {
        const like = all.filter((it) => String(it.name || '').toLowerCase().indexOf(q) >= 0);
        if (like.length === 1) hit = like;
        else if (like.length > 1) {
          throw new Error('「' + name + '」匹配到多个自启动项，请给更完整的名字：' +
            like.slice(0, 6).map((x) => x.name).join('、'));
        } else {
          throw new Error('没找到叫「' + name + '」的自启动项');
        }
      }
      return hit[0];
    };

    const startupToggle = {
      id: 'startup.toggle',
      cat: 'apps',
      label: '自启动开关',
      desc: '安全启用或禁用开机自启动项（注册表或启动文件夹快捷方式，可逆）',
      risk: 1,
      reversible: true,
      undoKind: 'none',
      schema: {
        name: { type: 'string', req: true, maxLen: 120, hint: '自启动项名称' },
        enabled: { type: 'bool', req: false, def: false }
      },
      async plan(p) {
        const item = await findStartup(p.name);
        const targetEnabled = p.enabled !== undefined ? !!p.enabled : !item.enabled;
        const actZh = targetEnabled ? '启用' : '禁用';
        return {
          title: `${actZh}自启动项「${item.name}」`,
          summary: `${actZh}开机自动启动：${item.command || item.location || ''}`,
          items: [{ t: item.name, s: item.location || (item.source_type === 'folder' ? item.file_path : item.hive) }],
          count: 1,
          bytes: 0,
          warnings: targetEnabled ? ['启用后该程序将在每次开机登录时自动启动'] : ['禁用后程序不再随开机自启，但可随时重新开启'],
          params: {
            name: item.name,
            enabled: targetEnabled,
            source_type: item.source_type,
            hive: item.hive,
            file_path: item.file_path
          },
          note: '修改自启动配置，不影响软件正常使用'
        };
      },
      async run(p) {
        let name = p && p.name;
        let sourceType = p && p.source_type;
        let hive = p && p.hive;
        let filePath = p && p.file_path;
        let enabled = p && p.enabled;
        if (!sourceType) {
          const item = await findStartup(name);
          name = item.name;
          sourceType = item.source_type;
          hive = item.hive;
          filePath = item.file_path;
          if (enabled === undefined) enabled = !item.enabled;
        }
        const r = await E('startup.toggle', {
          name: name,
          enabled: !!enabled,
          source_type: sourceType,
          hive: hive,
          file_path: filePath
        });
        return {
          result: { name: r.name, enabled: r.enabled, new_file_path: r.new_file_path },
          undo: null,
          message: `已${r.enabled ? '启用' : '禁用'}自启动项「${r.name}」`
        };
      }
    };

    const startupDelete = {
      id: 'startup.delete',
      cat: 'apps',
      label: '删除自启动项',
      desc: '彻底从开机启动配置中移除指定项（注册表或启动快捷方式，不删软件本体）',
      risk: 2,
      reversible: false,
      undoKind: 'none',
      schema: {
        name: { type: 'string', req: true, maxLen: 120, hint: '自启动项名称' }
      },
      async plan(p) {
        const item = await findStartup(p.name);
        return {
          title: `删除自启动项「${item.name}」`,
          summary: `从系统启动配置中彻底移除【${item.name}】`,
          items: [{ t: item.name, s: item.command || item.location || item.file_path || '' }],
          count: 1,
          bytes: 0,
          warnings: ['仅删除开机自启动配置与快捷方式，不会卸载或删除软件本身'],
          params: {
            name: item.name,
            source_type: item.source_type,
            hive: item.hive,
            key: item.key,
            file_path: item.file_path
          },
          note: '适合清理失效的启动残留或彻底移除不希望开机运行的项'
        };
      },
      async run(p) {
        let name = p && p.name;
        let sourceType = p && p.source_type;
        let hive = p && p.hive;
        let key = p && p.key;
        let filePath = p && p.file_path;
        if (!sourceType) {
          const item = await findStartup(name);
          name = item.name;
          sourceType = item.source_type;
          hive = item.hive;
          key = item.key;
          filePath = item.file_path;
        }
        const r = await E('startup.delete', {
          name: name,
          source_type: sourceType,
          hive: hive,
          key: key,
          file_path: filePath
        });
        return {
          result: { name: r.name, deleted: r.deleted },
          undo: null,
          message: `已删除自启动配置「${r.name}」`
        };
      }
    };

    /* -------------------------------------------------------------- 搜索索引 */
    const searchRebuild = {
      id: 'search.rebuild',
      cat: 'search',
      label: '重建索引',
      desc: '重建文件名搜索索引（耗时取决于目录大小）',
      risk: 1,
      reversible: true,
      undoKind: 'none',
      schema: {
        roots: { type: 'paths', max: 20, hint: '要建索引的目录；省略则重建已有索引' },
        full: { type: 'bool', def: false }
      },
      async plan(p) {
        const st = await E('search.status', {});
        const entries = (st && st.entries) || [];
        const items = entries.slice(0, 6).map((it) => ({
          t: it.root || it.path || '',
          s: (it.files != null ? it.files + ' 个文件' : '') + (it.why ? ' · ' + it.why : '')
        }));
        const roots = p.roots || entries.map((it) => it.root || it.path).filter(Boolean);
        return {
          title: '重建搜索索引',
          summary: '重建 ' + roots.length + ' 个目录的索引' + (p.full ? '（完整重建）' : '（增量）'),
          items,
          count: roots.length,
          bytes: 0,
          warnings: [],
          params: { roots, full: p.full },
          note: '只影响搜索结果，不动任何文件'
        };
      },
      async run(p) {
        const r = await E('search.index', { roots: p.roots || [], full: p.full, reuse: !p.full });
        if (r && r.error) throw new Error(r.error);
        return {
          result: { indexed: r.indexed || 0, entries: r.entries || 0 },
          undo: null,
          message: '索引已更新，收录 ' + (r.indexed || 0) + ' 个文件'
        };
      }
    };

    /* -------------------------------------------------------------- 规则文件 */
    const rulesRun = {
      id: 'rules.run',
      cat: 'organize',
      label: '执行规则',
      desc: '按规则文件（YAML）对一个目录执行整理规则',
      risk: 2,
      reversible: false,
      undoKind: 'none',
      schema: {
        path: { type: 'string', req: true, maxLen: 260, hint: '规则文件完整路径' },
        folder: { type: 'string', req: true, maxLen: 260, hint: '要整理的目录' }
      },
      async plan(p) {
        const why = root.AIGuard ? root.AIGuard.denyWhy(p.folder) : '';
        if (why) throw new Error('目标目录不可用：' + why);
        const r = await E('rules.run', { path: p.path, folder: p.folder, confirm: false });
        return {
          title: '执行整理规则',
          summary: '规则会移动 ' + (r.moved || 0) + ' 个文件（预演结果）',
          items: [{ t: base(p.path), s: p.folder }].concat(failItems(r.failed, 'src')),
          count: Number(r.moved) || 0,
          bytes: 0,
          warnings: ['规则执行不写撤销记录；要撤销先看「整理」页的历史'],
          params: p,
          note: '预演数字来自模拟执行'
        };
      },
      async run(p) {
        const r = await E('rules.run', { path: p.path, folder: p.folder, confirm: true });
        return {
          result: { moved: r.moved || 0, failed: (r.failed || []).length },
          undo: null,
          message: '规则已执行，移动 ' + (r.moved || 0) + ' 个文件'
        };
      }
    };

    /* ---------------------------------------------------------------- 迁移 */
    const migrateRun = {
      id: 'migrate.run',
      cat: 'files',
      label: '迁移',
      desc: '把目录迁移到另一个盘（移动或复制）',
      risk: 2,
      reversible: false,
      undoKind: 'none',
      schema: {
        sources: { type: 'paths', req: true, max: 50, hint: '要迁移的目录' },
        destination: { type: 'string', req: true, maxLen: 260, hint: '迁移到哪个目录' },
        mode: { type: 'enum', values: ['move', 'copy'], def: 'move' },
        conflict: { type: 'enum', values: ['rename', 'skip', 'overwrite'], def: 'rename' }
      },
      async plan(p) {
        for (const s of p.sources) {
          const why = root.AIGuard ? root.AIGuard.denyWhy(s) : '';
          if (why) throw new Error('源目录不可用：' + why);
        }
        const dw = root.AIGuard ? root.AIGuard.denyWhy(p.destination) : '';
        if (dw) throw new Error('目标位置不可用：' + dw);
        const r = await E('migrate.plan', {
          sources: p.sources, destination: p.destination, mode: p.mode, conflict: p.conflict
        });
        const blocked = r.blocked || [];
        if (blocked.length) {
          throw new Error('有 ' + blocked.length + ' 项无法迁移：' +
            blocked.slice(0, 3).map((b) => (b.source || '') + '（' + b.why + '）').join('；'));
        }
        const jobs = (r.jobs || []).slice(0, 6);
        return {
          title: p.mode === 'copy' ? '复制到新位置' : '移动到新位置',
          /* 迁移动的是整棵目录树，还可能跨盘复制后删源：一律按最高风险处理，
             只有用户点确认才执行，任何档位都不自动跑。 */
          riskNow: 3,
          reversibleNow: p.mode === 'copy',
          summary: (p.mode === 'copy' ? '复制 ' : '移动 ') + (r.total_files || 0) + ' 个文件（' +
            fmtBytes(r.total_size) + '）到 ' + p.destination,
          items: jobs.map((j) => ({ t: base(j.source || j.from || ''), s: j.destination || j.to || '' })),
          count: Number(r.total_files) || 0,
          bytes: Number(r.total_size) || 0,
          warnings: (r.cross_volume ? ['跨盘迁移会先复制再删除源文件，中途中断会留下两份'] : [])
            .concat(p.conflict === 'overwrite' ? ['同名文件会被覆盖'] : []),
          params: p,
          note: p.mode === 'move' ? '移动后源目录里的文件就没了' : '复制不动源文件'
        };
      },
      async run(p) {
        const r = await E('migrate.apply', {
          sources: p.sources, destination: p.destination, mode: p.mode,
          conflict: p.conflict, confirm: true
        });
        if (r && r.refused) throw new Error(r.error || '存在阻断项，未执行迁移');
        return {
          result: { moved: r.moved || 0, failed: (r.failed || []).length, job_id: r.job_id || '' },
          undo: null,
          message: '已' + (p.mode === 'copy' ? '复制 ' : '移动 ') + (r.moved || 0) + ' 个文件'
        };
      }
    };

    /* ---------------------------------------------------------------- 设置 */
    const settingsSet = {
      id: 'settings.set',
      cat: 'settings',
      label: '改设置',
      desc: '修改整理助手的设置项（不含路径类设置）',
      risk: 1,
      reversible: true,
      undoKind: 'setting',
      schema: {
        key: { type: 'enum', values: Object.keys(SETTING_LABEL), req: true },
        value: { type: 'json', req: true }
      },
      async plan(p) {
        const s = await E('settings.get', {});
        const old = s[p.key];
        if (String(old) === String(p.value)) throw new Error('这个设置本来就是 ' + String(old) + '，不用改');
        return {
          title: '修改设置：' + SETTING_LABEL[p.key],
          summary: SETTING_LABEL[p.key] + '：' + String(old) + ' → ' + String(p.value),
          items: [],
          count: 1,
          bytes: 0,
          warnings: [],
          params: p,
          note: '改的是配置，不动文件'
        };
      },
      async run(p) {
        const s0 = await E('settings.get', {});
        const old = s0[p.key];
        await E('settings.set', { key: p.key, value: p.value });
        return {
          result: { key: p.key, value: p.value },
          undo: { kind: 'setting', key: p.key, old, label: '改回 ' + String(old) },
          message: '已把「' + SETTING_LABEL[p.key] + '」改为 ' + String(p.value)
        };
      }
    };

    const autostartSet = {
      id: 'autostart.set',
      cat: 'settings',
      label: '开机启动',
      desc: '打开或关闭开机自动启动',
      risk: 1,
      reversible: true,
      undoKind: 'autostart',
      schema: { enabled: { type: 'bool', req: true } },
      async plan(p) {
        const now = await API.getAutostart();
        if (!!now === p.enabled) throw new Error('开机启动本来就是' + (now ? '开' : '关') + '的');
        return {
          title: p.enabled ? '打开开机启动' : '关闭开机启动',
          summary: '开机启动：' + (now ? '开' : '关') + ' → ' + (p.enabled ? '开' : '关'),
          items: [], count: 1, bytes: 0, warnings: [], params: p,
          note: '只改注册表 Run 项'
        };
      },
      async run(p) {
        const now = await API.getAutostart();
        await API.setAutostart(p.enabled);
        return {
          result: { enabled: p.enabled },
          undo: { kind: 'autostart', enabled: !!now, label: '改回' + (now ? '开' : '关') },
          message: '已' + (p.enabled ? '打开' : '关闭') + '开机启动'
        };
      }
    };

    const scheduleSet = {
      id: 'schedule.set',
      cat: 'settings',
      label: '定时清理',
      desc: '设置定时清理任务（时间、星期、是否清缓存/截图）',
      risk: 1,
      reversible: true,
      undoKind: 'schedule',
      schema: {
        enabled: { type: 'bool', def: true },
        time: { type: 'string', maxLen: 5 },
        days: { type: 'json' },
        cache: { type: 'bool' },
        screenshots: { type: 'bool' }
      },
      async plan(p) {
        const now = (await API.scheduleGet()) || {};
        const next = {
          enabled: p.enabled,
          time: p.time || now.time || '03:00',
          days: Array.isArray(p.days) ? p.days : (now.days || []),
          cache: p.cache === undefined ? !!now.cache : p.cache,
          screenshots: p.screenshots === undefined ? !!now.screenshots : p.screenshots
        };
        if (!/^\d{1,2}:\d{2}$/.test(next.time)) throw new Error('time 要写成 03:00 这种形式');
        return {
          title: '设置定时清理',
          summary: (next.enabled ? '启用' : '停用') + ' 每天 ' + next.time +
            ' · ' + (next.cache ? '清缓存 ' : '') + (next.screenshots ? '清截图' : ''),
          items: [],
          count: 1, bytes: 0, warnings: [], params: next,
          note: '写入 Windows 计划任务'
        };
      },
      async run(p) {
        const now = (await API.scheduleGet()) || {};
        await API.scheduleSet(p.enabled, p.time, p.days, p.cache, p.screenshots);
        return {
          result: { enabled: p.enabled, time: p.time },
          undo: { kind: 'schedule', prev: now, label: '恢复原来的定时设置' },
          message: '定时清理已更新'
        };
      }
    };

    const logsClear = {
      id: 'logs.clear',
      cat: 'clean',
      label: '清日志',
      desc: '清空整理助手自己的运行日志（不可撤销）',
      risk: 2,
      reversible: false,
      undoKind: 'none',
      schema: { all: { type: 'bool', def: true } },
      async plan() {
        const list = (await API.logList()) || [];
        const bytes = list.reduce((n, x) => n + (Number(x.size) || 0), 0);
        return {
          title: '清空运行日志',
          summary: '删除 ' + list.length + ' 个日志文件（' + fmtBytes(bytes) + '）',
          items: list.slice(0, 6).map((x) => ({ t: x.name, s: fmtBytes(x.size) })),
          count: list.length,
          bytes,
          warnings: ['日志删了就没了，出问题时没法回溯'],
          params: {},
          note: '只动程序自己的日志目录'
        };
      },
      async run() {
        await API.logClear();
        return { result: { cleared: true }, undo: null, message: '日志已清空' };
      }
    };

    /* ---------------------------------------------------------------- 进程管理 */
    const processClose = {
      id: 'process.close',
      cat: 'apps',
      label: '结束进程',
      desc: '关闭或终止指定后台进程以释放文件占用或系统资源',
      risk: 2,
      reversible: false,
      undoKind: 'none',
      schema: {
        pid: { type: 'int', min: 1, hint: '进程 PID' },
        name: { type: 'string', maxLen: 120, hint: '进程名称，例如 wechat.exe' },
        force: { type: 'bool', def: false }
      },
      async plan(p) {
        if (!p.pid && !p.name) throw new Error('pid 或 name 至少需要提供一个');
        return {
          title: (p.force ? '强制结束进程' : '关闭进程'),
          summary: (p.name || ('PID ' + p.pid)) + (p.pid && p.name ? ' (PID ' + p.pid + ')' : ''),
          items: [{ t: p.name || ('PID ' + p.pid), s: p.force ? '强制终止' : '优雅关闭' }],
          count: 1,
          bytes: 0,
          warnings: ['未保存的文档可能丢失；受系统保护的核心进程会被拒绝'],
          params: p,
          note: '系统关键进程受底层白名单保护'
        };
      },
      async run(p) {
        const r = await E('process.close', { pid: p.pid || 0, name: p.name || '', force: !!p.force });
        if (r && r.error) throw new Error(r.error);
        return {
          result: r || { closed: true },
          undo: null,
          message: '已请求关闭进程 ' + (p.name || p.pid)
        };
      }
    };

    /* ------------------------------------------------------------ 一键安全自动清理 */
    const cleanAuto = {
      id: 'clean.auto',
      cat: 'clean',
      label: '一键安全清理',
      desc: '按设定自动清理安全级系统缓存与过期截图（不碰高级或谨慎目录）',
      risk: 2,
      reversible: false,
      undoKind: 'none',
      schema: {
        cache: { type: 'bool', def: true },
        screenshots: { type: 'bool', def: true },
        days: { type: 'int', min: 1, max: 3650, def: 30 }
      },
      async plan(p) {
        if (!p.cache && !p.screenshots) throw new Error('cache 与 screenshots 不能同时为 false');
        let count = 0;
        let bytes = 0;
        const items = [];
        if (p.cache) {
          const r = await E('cache.list', { include_custom: true });
          for (const g of (r && r.groups) || []) {
            for (const it of g.items || []) {
              const lv = String(it.level || '').toLowerCase();
              if ((lv === 'safe' || lv === '1') && it.exists !== false) {
                const sz = Number(it.size) || 0;
                bytes += sz;
                count += 1;
                if (items.length < 4) items.push({ t: g.name || g.key || '安全缓存', s: fmtBytes(sz) });
              }
            }
          }
        }
        if (p.screenshots) {
          const s = await E('shots.scan', { days: p.days });
          const sc = ((s && s.items) || []).length;
          const sb = Number(s && s.size) || 0;
          count += sc;
          bytes += sb;
          if (sc) items.push({ t: p.days + ' 天前旧截图 (' + sc + ' 项)', s: fmtBytes(sb) });
        }
        return {
          title: '一键自动清理（安全级）',
          summary: '共约 ' + count + ' 项，预计释放 ' + fmtBytes(bytes),
          items,
          count,
          bytes,
          warnings: p.screenshots ? ['旧截图将按设置移入回收站，安全缓存将被清空'] : ['安全级缓存目录内容将被清空'],
          params: p,
          note: '仅作用于安全级缓存与旧截图，系统路径受硬黑名单保护'
        };
      },
      async run(p) {
        const r = await E('clean.auto', { confirm: true, cache: !!p.cache, screenshots: !!p.screenshots, days: p.days });
        if (r && r.error) throw new Error(r.error);
        return {
          result: r || { ok: true },
          undo: null,
          message: '安全自动清理已完成'
        };
      }
    };

    /* ------------------------------------------------------------ 搜索诊断与自检 */
    const searchSelfcheck = {
      id: 'search.selfcheck',
      cat: 'search',
      label: '搜索自检与修复',
      desc: '抽查搜索索引与 Everything 状态，若过期则自动修复重建',
      risk: 1,
      reversible: true,
      undoKind: 'none',
      schema: { rebuild: { type: 'bool', def: true } },
      async plan(p) {
        const st = await E('search.status', {});
        const entries = (st && st.entries) || [];
        return {
          title: '搜索索引自检',
          summary: '检查 ' + entries.length + ' 个已索引目录（当前引擎：' + ((st && st.backend) || '本地索引') + '）',
          items: entries.slice(0, 5).map((it) => ({ t: it.root || it.path || '', s: (it.files || 0) + ' 项' })),
          count: Math.max(1, entries.length),
          bytes: 0,
          warnings: [],
          params: p,
          note: '仅更新本地搜索索引状态，不动磁盘文件'
        };
      },
      async run(p) {
        const r = await E('search.selfcheck', { rebuild: !!p.rebuild });
        return {
          result: r || { ok: true },
          undo: null,
          message: '搜索索引自检完成'
        };
      }
    };

    /* ------------------------------------------------------------ 规则草稿写入编辑器 */
    const rulesDraft = {
      id: 'rules.draft',
      cat: 'organize',
      label: '写入规则编辑器',
      desc: '验证起草的 organize YAML 并写入「高级规则」编辑器（不自动写盘）',
      risk: 1,
      reversible: true,
      undoKind: 'none',
      schema: {
        yaml: { type: 'string', req: true, maxLen: 20000, hint: '完整的 organize YAML 规则文本' },
        folder: { type: 'string', maxLen: 260, hint: '可选目标目录' }
      },
      async plan(p) {
        const val = await E('rules.validate', { text: p.yaml });
        if (!val || !val.ok) {
          throw new Error('规则语法未通过校验：' + ((val && val.message) || '请检查缩进与字段'));
        }
        return {
          title: '写入高级规则编辑器',
          summary: '通过校验（共 ' + (val.rule_count || 0) + ' 条规则），确认后跳转到规则页填入',
          items: [{ t: (val.rule_count || 0) + ' 条 YAML 规则', s: p.folder || '需进入页面选择目标目录' }],
          count: Math.max(1, val.rule_count || 1),
          bytes: p.yaml.length,
          warnings: [],
          params: p,
          note: '仅填入前端编辑器，需人工核对并手动保存或执行'
        };
      },
      async run(p) {
        if (root.AIRulesDraft && typeof root.AIRulesDraft.fill === 'function') {
          root.AIRulesDraft.fill(p.yaml);
        }
        if (root.App && typeof root.App.jump === 'function') {
          root.App.jump('rules', { yaml: p.yaml, folder: p.folder || '' });
        }
        return {
          result: { filled: true, length: p.yaml.length },
          undo: null,
          message: '规则已写入「高级规则」编辑器并打开对应页面'
        };
      }
    };

    const table = {
      'organize.apply': organizeApply,
      'files.delete': filesDelete,
      'files.remove_empty': filesEmpty,
      'archive.extract': archiveExtract,
      'archive.create': archiveCreate,
      'clean.cache': cleanCache,
      'clean.shots': cleanShots,
      'clean.auto': cleanAuto,
      'apps.uninstall': appsUninstall,
      'apps.delete_entry': appsDeleteEntry,
      'apps.force_remove': appsForceRemove,
      'apps.cleanup': appsCleanup,
      'apps.remove_store': appsRemoveStore,
      'startup.toggle': startupToggle,
      'startup.delete': startupDelete,
      'process.close': processClose,
      'search.rebuild': searchRebuild,
      'search.selfcheck': searchSelfcheck,
      'rules.run': rulesRun,
      'rules.draft': rulesDraft,
      'migrate.run': migrateRun,
      'settings.set': settingsSet,
      'autostart.set': autostartSet,
      'schedule.set': scheduleSet,
      'logs.clear': logsClear
    };

    /* 撤销：只做「低风险的还原动作」，不假装什么都能撤销 */
    async function applyUndo(u) {
      if (!u || !u.kind || u.kind === 'none') return { ok: false, message: '这个操作没有自动撤销' };
      if (u.kind === 'undo') {
        const out = [];
        for (const folder of u.folders || []) {
          try {
            const r = await E('undo', { path: folder });
            out.push((r && r.restored) || 0);
          } catch (e) {
            return { ok: false, message: '撤销失败：' + (e.message || e) };
          }
        }
        return { ok: true, message: '已撤销整理，还原 ' + sum(out, (x) => x) + ' 个文件' };
      }
      if (u.kind === 'recycle') {
        await API.openPath('shell:RecycleBinFolder');
        return { ok: true, message: '已打开回收站，可以在里面还原' };
      }
      if (u.kind === 'trash-path' || u.kind === 'trash-file') {
        const r = await E('files.delete', { paths: [u.path], mode: 'trash', confirm: true });
        if ((r.failed || []).length) {
          return { ok: false, message: '没能移除：' + ((r.failed[0] || {}).why || '') };
        }
        return { ok: true, message: '已把 ' + base(u.path) + ' 移入回收站' };
      }
      if (u.kind === 'setting') {
        await E('settings.set', { key: u.key, value: u.old });
        return { ok: true, message: '已改回 ' + String(u.old) };
      }
      if (u.kind === 'autostart') {
        await API.setAutostart(!!u.enabled);
        return { ok: true, message: '开机启动已改回' };
      }
      if (u.kind === 'schedule') {
        const p = u.prev || {};
        await API.scheduleSet(!!p.enabled, p.time || '03:00', p.days || [], !!p.cache, !!p.screenshots);
        return { ok: true, message: '定时设置已恢复' };
      }
      return { ok: false, message: '这个操作没有自动撤销' };
    }

    /* 给系统提示词用的动作目录：一行一个，紧凑 */
    function catalog() {
      return Object.keys(table).map((id) => {
        const a = table[id];
        const args = Object.keys(a.schema).map((k) => a.schema[k].req ? k : k + '?').join(', ');
        return id + ' | ' + a.desc + ' | ' + args + ' | 风险' + a.risk;
      }).join('\n');
    }

    return {
      get: (id) => table[id] || null,
      ids: Object.keys(table),
      list: () => Object.keys(table).map((id) => ({
        id, cat: table[id].cat, label: table[id].label, risk: table[id].risk
      })),
      catalog,
      bind,
      applyUndo,
      SETTING_LABEL,
      limits: { items: LIMIT_ITEMS, bytes: LIMIT_BYTES }
    };
  }

  const API = { create, bind, fmtBytes, LIMIT_ITEMS, LIMIT_BYTES };
  root.AIRegistry = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
