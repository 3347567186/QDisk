/* AI 助手 · 8 个只读工具
   ------------------------------------------------------------
   设计约束（方案 §4、§10）：
   · 这张表里没有任何写操作。模型的 tool 名不在表里 → 直接拒绝，
     永远到不了引擎，所以「不删文件」是结构性的，不是提示词承诺。
   · 每个工具都返回已经剪裁过的小对象：单条结果上限 CAP 字符（≈400 token）。
   · 每个工具 8 秒超时；失败把可读原因抛给 agent，由 agent 回给模型换参数。 */
(function (root) {
  'use strict';

  const CAP = 1100;          // 单条工具结果字符上限
  const TIMEOUT = 8000;      // 单工具超时

  const fmtBytes = (n) => {
    const v = Number(n) || 0;
    if (v < 1024) return v + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let i = -1;
    let x = v;
    do { x /= 1024; i += 1; } while (x >= 1024 && i < units.length - 1);
    return (x >= 10 ? x.toFixed(0) : x.toFixed(1)) + ' ' + units[i];
  };

  const fmtAge = (mtime) => {
    const sec = Number(mtime) || 0;
    if (!sec) return '';
    const days = Math.floor((Date.now() / 1000 - sec) / 86400);
    if (days <= 0) return '今天';
    if (days < 30) return days + ' 天前';
    if (days < 365) return Math.floor(days / 30) + ' 个月前';
    return Math.floor(days / 365) + ' 年前';
  };

  const withTimeout = (p, ms, label) => new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error(label + ' 超过 ' + Math.round(ms / 1000) + ' 秒没有返回'));
    }, ms);
    Promise.resolve(p).then((v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    }, (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(e);
    });
  });

  /* 逐项裁剪到 CAP：优先砍数组尾部的条目，保留结构与计数 */
  function fit(obj, cap) {
    let text = JSON.stringify(obj);
    if (text.length <= cap) return obj;
    const clone = JSON.parse(text);
    const arrays = [];
    const walk = (v, key) => {
      if (Array.isArray(v)) {
        if (v.length > 1) arrays.push({ holder: v, key });
        v.forEach((x) => walk(x, key));
      } else if (v && typeof v === 'object') {
        Object.keys(v).forEach((k) => walk(v[k], k));
      }
    };
    walk(clone, '');
    for (const a of arrays) {
      while (a.holder.length > 1 && JSON.stringify(clone).length > cap) {
        a.holder.pop();
      }
      if (JSON.stringify(clone).length <= cap) break;
    }
    clone.truncated = true;
    text = JSON.stringify(clone);
    if (text.length > cap) return { truncated: true, note: '结果过大，已截断', preview: text.slice(0, Math.max(80, cap - 80)) };
    return clone;
  }

  const needDir = (args) => {
    const d = String((args && args.dir) || '').trim();
    if (!d) throw new Error('缺少参数 dir（目录完整路径）');
    return d;
  };

  /* 构建工具表：deps = { API }，测试时可塞假的 */
  function makeTools(deps) {
    const API = deps.API;

    const table = {
      list_dir: {
        label: '列目录',
        run: async (args) => {
          const dir = needDir(args);
          const limit = Math.min(Math.max(Number(args.limit) || 100, 1), 200);
          const r = await withTimeout(API.listDir(dir, limit), TIMEOUT, '列目录');
          const items = (r.items || []).map((it) => ({
            name: it.name,
            kind: it.kind === 'dir' ? 'dir' : 'file',
            size: it.kind === 'dir' ? undefined : fmtBytes(it.size),
            age: fmtAge(it.mtime)
          }));
          return fit({ dir: r.dir, total: r.total, truncated: r.truncated, items }, CAP);
        },
        summary: (args, r) => `列目录 ${args.dir} · ${r.total} 项`
      },

      top_files: {
        label: '大文件排行',
        run: async (args) => {
          const dir = needDir(args);
          const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 50);
          const r = await withTimeout(API.topFiles(dir, limit), TIMEOUT, '大文件排行');
          const items = (r || []).map((it) => ({
            name: it.name,
            size: fmtBytes(it.size),
            bytes: Number(it.size) || 0,
            dir: it.dir || '',
            age: fmtAge(it.mtime)
          }));
          return fit({ dir, count: items.length, items }, CAP);
        },
        summary: (args, r) => `大文件排行 ${args.dir} · ${r.count} 个`
      },

      empty_dirs: {
        label: '空文件夹',
        run: async (args) => {
          const dir = needDir(args);
          const depth = Math.min(Math.max(Number(args.depth) || 2, 1), 3);
          const r = await withTimeout(API.scanEmptyDirs(dir, 500, depth), TIMEOUT, '空文件夹扫描');
          const list = (r && r.items) || r || [];
          const items = list.map((it) => ({
            path: it.path || it,
            depth: it.depth,
            kind: it.kind === 'protected' ? 'protected' : 'empty',
            why: it.why || ''
          }));
          const empty = items.filter((i) => i.kind === 'empty').length;
          return fit({ dir, depth, empty, protected: items.length - empty, items }, CAP);
        },
        summary: (args, r) => `空文件夹 ${args.dir} · 可删 ${r.empty} / 受保护 ${r.protected}`
      },

      file_signals: {
        label: '文件签名',
        run: async (args) => {
          const paths = Array.isArray(args && args.paths) ? args.paths.filter((p) => typeof p === 'string') : [];
          if (!paths.length) throw new Error('缺少参数 paths（文件完整路径数组）');
          if (paths.length > 20) throw new Error('paths 一次最多 20 个');
          const r = await withTimeout(API.fileSignals(paths), 25000, '读取文件签名');
          const items = ((r && r.items) || []).map((it) => ({
            path: it.path,
            company: it.company || '',
            product: it.product || '',
            desc: it.desc || '',
            signed: it.signed === true,
            signer: it.signer || '',
            version: it.version || ''
          }));
          return fit({ count: items.length, items }, CAP);
        },
        summary: (args, r) => `文件签名 · ${r.count} 个`
      },

      installed_apps: {
        label: '已安装程序',
        run: async (args) => {
          const filter = String((args && args.filter) || '').trim().toLowerCase();
          const r = await withTimeout(API.engine('apps.list', {}), TIMEOUT, '读取已安装程序');
          const all = ((r && r.items) || []).map((it) => ({
            name: it.name || '',
            path: it.install_path || ''
          })).filter((it) => it.name);
          const hit = filter
            ? all.filter((it) => it.name.toLowerCase().includes(filter) || it.path.toLowerCase().includes(filter))
            : all;
          const items = hit.slice(0, 20);
          return fit({ total: all.length, matched: hit.length, filter, items }, CAP);
        },
        summary: (args, r) => `已安装程序 · 匹配 ${r.matched}/${r.total}`
      },

      search_files: {
        label: '搜索文件',
        run: async (args) => {
          const q = String((args && args.q) || '').trim();
          if (!q) throw new Error('缺少参数 q（要搜索的文件名关键词）');
          const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 20);
          const r = await withTimeout(API.engine('search.query', { q, limit }), TIMEOUT, '搜索文件');
          const items = ((r && r.items) || []).map((it) => ({
            name: it.name,
            path: it.path,
            size: fmtBytes(it.size),
            age: fmtAge(it.mtime)
          }));
          return fit({ q, total: r.total, source: r.source, hint: r.hint || '', items }, CAP);
        },
        summary: (args, r) => `搜索「${args.q}」· ${r.total} 条`
      },

      organize_preview: {
        label: '整理预演',
        run: async (args) => {
          const paths = Array.isArray(args && args.paths) ? args.paths.filter((p) => typeof p === 'string') : [];
          if (!paths.length) throw new Error('缺少参数 paths（要整理的目录或文件路径数组）');
          if (paths.length > 50) throw new Error('paths 一次最多 50 个');
          const params = {
            paths,
            recursive: args.recursive !== false,
            skip_recent: false,
            skip_shortcuts: true
          };
          const r = await withTimeout(API.engine('scan', params), 20000, '整理预演');
          const plans = (r && r.plans) || [];
          const groups = [];
          let skipped = [];
          for (const p of plans) {
            if (p.error) {
              skipped.push({ name: p.folder, reason: p.error });
              continue;
            }
            for (const g of p.groups || []) {
              groups.push({ cat: g.cat, count: g.count, size: fmtBytes(g.size) });
            }
            for (const s of p.skipped || []) skipped.push({ name: s.name, reason: s.reason });
          }
          return fit({
            total: r.total || 0,
            blocked: r.blocked || 0,
            total_size: fmtBytes(r.total_size || 0),
            groups,
            skipped: skipped.slice(0, 12),
            skipped_total: skipped.length
          }, CAP);
        },
        summary: (args, r) => `整理预演 · ${r.total} 个文件 / ${r.groups.length} 个类别`
      },

      last_organize: {
        label: '上次整理',
        run: async () => {
          const r = await withTimeout(API.historyList(), TIMEOUT, '读取整理记录');
          const list = (r || []).slice(0, 5).map((it) => ({
            time: it.time,
            folder: it.folder,
            moved: it.moved,
            created: it.created
          }));
          return fit({ count: (r || []).length, items: list }, CAP);
        },
        summary: (args, r) => `上次整理 · 共 ${r.count} 条记录`
      }
    };

    return table;
  }

  const API = { makeTools, fit, fmtBytes, fmtAge, CAP, TIMEOUT };
  root.AITools = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
