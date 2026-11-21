/* AI 助手 · 11 个只读工具（1.25.0 起含全盘读文件与打开）
   ------------------------------------------------------------
   设计约束（方案 §4、§10）：
   · 这张表里没有任何写操作。模型的 tool 名不在表里 → 直接拒绝，
     永远到不了引擎，所以「不删文件」是结构性的，不是提示词承诺。
   · 唯一有副作用的是 open_path：它只用系统默认程序「打开」，
     不运行可执行文件（见 EXEC_EXT），也不改文件内容。
   · 每个工具都返回已经剪裁过的小对象：单条结果上限 CAP 字符（≈400 token）。
   · 每个工具 8 秒超时；失败把可读原因抛给 agent，由 agent 回给模型换参数。 */
(function (root) {
  'use strict';

  const CAP = 1100;          // 单条工具结果字符上限
  const TIMEOUT = 8000;      // 单工具超时（查一个已知位置的，够用）
  /* 整盘/整目录遍历单独一档。D:\ 上 20 万个文件只是开头，
     8 秒根本走不完，以前就是被这一档掐死的。
     Rust 侧自带 20 秒预算并会提前收手返回部分结果，
     这里留一点余量，别让 JS 抢先判死刑。 */
  const SCAN_TIMEOUT = 25000;

  /* 不自动运行的程序类型：打开 .exe/.lnk 等于让模型替你双击任意文件。
     要让 agent 看这些文件的内容，用 read_file；要看签名，用 file_signals。 */
  const EXEC_EXT = ['exe', 'msi', 'bat', 'cmd', 'ps1', 'scr', 'com', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'lnk', 'reg', 'hta'];

  const fmtBytes = (n) => {
    const v = Number(n) || 0;
    if (v < 1024) return v + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let i = -1;
    let x = v;
    do { x /= 1024; i += 1; } while (x >= 1024 && i < units.length - 1);
    /* 一律保留一位小数，不按大小改精度。
       曾经写成「大于 10 就不留小数」，结果 17807225851 显示成「17 GB」，
       模型答「16.6 GB」——数字其实没错，但同源校验按 2% 容差算不过，
       真数据被当成编的，答案尾部挂了「体积数字没核对上」的警告。 */
    return x.toFixed(1) + ' ' + units[i];
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

  /* ---------------- 路径 → 「这是什么、能不能清」 ----------------
     用户实测的原话是「他就发个链接给我，什么都感觉用不上」。
     光给路径和体积没用：`E:\SteamLibrary\steamapps\common` 是什么、能不能删，
     用户心里没有底。这个判断工具比模型可靠 —— 模型只能看路径字符串猜，
     而路径模式是确定的，写成规则表命中率更高，也不会编。

     规则只写「有把握的」：没命中就返回空，让模型自己判断，
     宁可不说，也不能给一条错的处理建议（删错东西是不可逆的）。

     risk 三档是硬结论，不是形容词：
       safe    —— 删了程序会自己重建，直接说能删
       careful —— 能清，但必须走正确入口（微信要进设置里清、游戏要用平台卸载）
       keep    —— 别动，删了会丢数据或坏系统
     有 risk 就不允许模型自己改口说「都可以清理」—— 实测它真的会这么写。 */
  const PATH_RULES = [
    { re: /[\\/]steamapps[\\/]common([\\/]|$)/i, risk: 'careful', what: 'Steam 游戏库（已装的游戏本体）',
      clean: '不能直接删，删了要重新下几十 GB；不玩就在 Steam 里卸载' },
    { re: /[\\/](SteamLibrary|Epic ?Games|GOG ?Games)([\\/]|$)/i, risk: 'careful', what: '游戏安装目录',
      clean: '不能直接删，用对应平台的卸载功能' },
    { re: /[\\/]\.minecraft([\\/]|$)/i, risk: 'careful', what: 'Minecraft 游戏与存档',
      clean: 'versions 里不玩的旧版本、mods 里不用的模组可以删；saves 是存档，删了进度就没了' },
    { re: /[\\/](Wechatdate|WeChat ?Files|xwechat_files)([\\/]|$)/i, risk: 'careful', what: '微信聊天记录与缓存',
      clean: '要在微信「设置 → 存储空间 → 管理」里清，不能直接删目录（会丢聊天记录）' },
    { re: /手机备份|[\\/](iPhone|iTunes|MobileSync)([\\/]|$)/i, risk: 'careful', what: '手机备份',
      clean: '旧手机的备份基本没用，但要在 iTunes/访达里删，不能直接删目录' },
    { re: /[\\/](Downloads|下载)([\\/]|$)/i, risk: 'safe', what: '下载目录',
      clean: '装完的安装包、看过的压缩包可以删，过一眼再动手' },
    { re: /[\\/]node_modules([\\/]|$)/i, risk: 'safe', what: 'Node 依赖（可重装）',
      clean: '可以删，删了在项目里跑一次 npm install 就回来' },
    { re: /[\\/](target|dist|build|obj|__pycache__|\.next)([\\/]|$)/i, risk: 'safe', what: '编译产物',
      clean: '可以删，重新编译就有，不影响源码' },
    { re: /[\\/](AppData[\\/]Local[\\/]Temp|Windows[\\/]Temp|临时|Temp)([\\/]|$)/i, risk: 'safe', what: '临时文件',
      clean: '可以删，程序会自己重建' },
    { re: /[\\/](Cache|caches|缓存|GPUCache|Code ?Cache)([\\/]|$)/i, risk: 'safe', what: '缓存',
      clean: '可以删，下次运行会重建，第一次会慢一点' },
    { re: /[\\/](pagefile\.sys|hiberfil\.sys|swapfile\.sys)/i, risk: 'keep', what: 'Windows 系统文件',
      clean: '不能删，删了系统会出问题；只能在系统设置里调大小' },
    { re: /[\\/]Windows([\\/]|$)/i, risk: 'keep', what: 'Windows 系统目录',
      clean: '不能删，删了系统就起不来了' },
    { re: /[\\/](Program ?Files|ProgramData)([\\/]|$)/i, risk: 'keep', what: '已安装程序',
      clean: '不能直接删，要卸载就从「设置 → 应用」里卸载' },
    { re: /[\\/](Videos|视频|Movies)([\\/]|$)/i, risk: 'keep', what: '视频',
      clean: '多半是你要留的素材，自己看过再决定' },
    { re: /[\\/](Pictures|图片|Photos)([\\/]|$)/i, risk: 'keep', what: '图片',
      clean: '多半要留，自己看过再决定' },
    { re: /[\\/](Documents|文档)([\\/]|$)/i, risk: 'keep', what: '文档目录',
      clean: '不要整体删，里面有你的工作文件' }
  ];

  /** 认出来的话返回 {what, clean, risk}，认不出来返回 null（宁可不说也不瞎猜） */
  const whatOf = (fullPath) => {
    const p = String(fullPath || '').replace(/\//g, '\\');
    for (let i = 0; i < PATH_RULES.length; i += 1) {
      if (PATH_RULES[i].re.test(p)) {
        return { what: PATH_RULES[i].what, clean: PATH_RULES[i].clean, risk: PATH_RULES[i].risk };
      }
    }
    return null;
  };

  /* 分页：结果被剪裁不再等于数据丢了。
     offset 跳过前几项，next_offset 指向下一页；模型按它续取即可。
     fit() 可能再砍掉几条，所以裁剪之后要把 next_offset 收回实际条数，保证不漏项。
     cap 可以按工具给：CAP=1100 对「15 个目录 + 每项说明」太小，
     实测会把目录列表压到只剩 2 条，模型只看得到两条，答案自然薄。 */
  function pageFit(base, list, off, want, cap) {
    const from = Math.min(Math.max(0, Math.floor(off) || 0), list.length);
    const items = list.slice(from, from + want);
    const obj = Object.assign({}, base, { items });
    if (from > 0) obj.offset = from;
    if (from + items.length < list.length) obj.next_offset = from + items.length;
    const out = fit(obj, cap || CAP);
    if (out && Array.isArray(out.items)) {
      /* fit 也会砍条目：按「真正返回了几条」定下一页，模型才不会跳过中间几条 */
      const next = from + out.items.length;
      if (next < list.length) out.next_offset = next;
      else delete out.next_offset;
    }
    return out;
  }

  /* 构建工具表：deps = { API, proposals, navigate }，测试时可塞假的 */
  function makeTools(deps) {
    const API = deps.API;
    const proposals = deps.proposals;
    /* 工具执行期间往界面上报一句话。建索引要几秒，不报进度用户会以为卡死；
       deps.say 没给（自检脚本里）就静默丢弃，不能让提示变成必需依赖。 */
    const say = typeof deps.say === 'function' ? deps.say : () => {};

    const table = {
      list_dir: {
        label: '列目录',
        run: async (args) => {
          const dir = needDir(args);
          const want = Math.min(Math.max(Number(args.limit) || 100, 1), 200);
          const off = Math.max(0, Math.floor(Number(args.offset) || 0));
          const r = await withTimeout(API.listDir(dir, Math.min(off + want, 200)), TIMEOUT, '列目录');
          const items = (r.items || []).map((it) => ({
            name: it.name,
            kind: it.kind === 'dir' ? 'dir' : 'file',
            size: it.kind === 'dir' ? undefined : fmtBytes(it.size),
            age: fmtAge(it.mtime)
          }));
          return pageFit({ dir: r.dir, total: r.total, truncated: r.truncated }, items, off, want);
        },
        summary: (args, r) => `列目录 ${args.dir} · ${r.total} 项`
      },

      /* 全盘可读：任意绝对路径的文本文件，分段读（next_offset 续读同一文件） */
      read_file: {
        label: '读文件',
        run: async (args) => {
          const path = String((args && args.path) || '').trim();
          if (!path) throw new Error('缺少参数 path（文件完整路径）');
          const off = Math.max(0, Math.floor(Number(args.offset) || 0));
          const want = Math.min(Math.max(Number(args.chars) || 700, 100), 900);
          const r = await withTimeout(API.fileRead(path, off, want), TIMEOUT, '读取文件');
          if (r && r.kind === 'binary') {
            return { path: r.path || path, size: fmtBytes(r.size), kind: 'binary', note: '二进制文件，不读内容（要看签名用 file_signals）' };
          }
          return fit({
            path: r.path || path,
            size: fmtBytes(r.size),
            encoding: r.encoding,
            text: r.text || '',
            eof: r.eof === true,
            next_offset: r.next_offset == null ? undefined : r.next_offset
          }, CAP);
        },
        summary: (args, r) => `读文件 ${args.path} · ${r.kind === 'binary' ? '二进制' : (r.text || '').length + ' 字'}`
      },

      /* 打开：目录→资源管理器，文件→系统默认程序；可执行文件一律不运行 */
      open_path: {
        label: '打开',
        run: async (args) => {
          const path = String((args && args.path) || '').trim();
          if (!path) throw new Error('缺少参数 path（要打开的完整路径）');
          const ext = (path.split('.').pop() || '').toLowerCase();
          if (EXEC_EXT.indexOf(ext) >= 0) {
            throw new Error('不自动运行程序（.' + ext + '）。要看内容用 read_file，要看签名用 file_signals');
          }
          await withTimeout(API.openPath(path), TIMEOUT, '打开');
          return { path, opened: true };
        },
        summary: (args) => `打开 ${args.path}`
      },

      /* 磁盘根：给「全盘」一个起点，省掉模型猜盘符 */
      disk_roots: {
        label: '磁盘',
        run: async () => {
          const r = await withTimeout(API.agentRoots(), TIMEOUT, '枚举磁盘');
          return fit({ roots: (r && r.roots) || [], home: (r && r.home) || '' }, CAP);
        },
        summary: (args, r) => `磁盘 ${r.roots.length} 个`
      },

      top_files: {
        label: '大文件排行',
        run: async (args) => {
          const dir = needDir(args);
          const want = Math.min(Math.max(Number(args.limit) || 20, 1), 50);
          const off = Math.max(0, Math.floor(Number(args.offset) || 0));
          // 整盘遍历由 Rust 侧限时（默认 20 秒），这里必须比它宽，
          // 否则又变成「Rust 还在老实数、JS 先把它掐了」，什么也拿不到。
          const r = await withTimeout(API.topFiles(dir, Math.min(off + want, 50)), SCAN_TIMEOUT, '大文件排行');
          const raw = (r && r.items) || (Array.isArray(r) ? r : []) || [];
          const items = raw.map((it) => ({
            name: it.name,
            size: fmtBytes(it.size),
            bytes: Number(it.size) || 0,
            dir: it.dir || '',
            age: fmtAge(it.mtime)
          }));
          const base = { dir, count: items.length };
          // 部分结果必须自报家门：否则模型会拿「扫了 12 万项的一部分」
          // 当成整盘结论，正是用户说的「随便给一个数据」。
          if (r && r.partial === true) {
            base.partial = true;
            base.scanned = r.scanned;
            base.note = `只扫了 ${r.scanned} 项就到了 ${Math.round((r.budget_ms || 20000) / 1000)} 秒上限，这是部分结果，不是整盘统计`;
          } else if (r && typeof r.scanned === 'number') {
            base.scanned = r.scanned;
          }
          return pageFit(base, items, off, want);
        },
        summary: (args, r) => `大文件排行 ${args.dir} · ${r.count} 个${r.partial ? '（部分）' : ''}`
      },

      /* 「什么最占空间」的正解：按目录汇总体积。
         单个文件（某个 .pak 5.4 GB）对人没有意义，人要知道的是「哪个文件夹/软件」。
         索引没建时引擎会自己建一次（auto），这里只把 built 标出来让界面提示。 */
      top_folders: {
        label: '目录体积排行',
        run: async (args) => {
          const want = Math.min(Math.max(Number(args.limit) || 15, 1), 50);
          const depth = Math.min(Math.max(Number(args.depth) || 3, 1), 6);
          const minSize = Math.max(0, Math.floor(Number(args.min_size) || 0));
          const parent = String(args.parent || '').trim();
          const body = { limit: want, depth, min_size: minSize, auto: args.auto !== false };
          if (parent) body.parent = parent;
          /* 先看有没有索引，没有就先报一句「正在建」，别让用户对着转圈猜 */
          if (body.auto) {
            try {
              const st = await API.engine('search.status', {});
              if (!(Number(st && st.files) > 0)) say('本地还没有索引，正在后台建一次（约几秒，之后就不用再建了）');
            } catch (e) { /* 状态查不到就照常跑，引擎自己会处理 */ }
          }
          const r = await withTimeout(API.engine('search.folders', body), 60000, '目录体积排行');
          const items = ((r && r.items) || []).map((it) => {
            const row = {
              path: it.path,
              name: it.name,
              size: fmtBytes(it.size),
              bytes: Number(it.size) || 0,
              files: Number(it.files) || 0,
              pct: Number(it.pct) || 0
            };
            /* 直接告诉模型「这是什么、能不能清」，别让它对着路径字符串猜。
               没认出来就不加这几个字段，模型会按「不确定」处理。 */
            const w = whatOf(it.path);
            if (w) { row.what = w.what; row.clean = w.clean; row.risk = w.risk; }
            return row;
          });
          const base = {
            count: items.length,
            bytes: fmtBytes(r && r.bytes),
            depth,
            parent: parent || '',
            roots: (r && r.roots) || [],
            indexed: (r && r.indexed) || 0,
            built: !!(r && r.built),
            hint: (r && r.hint) || '',
            error: (r && r.error) || ''
          };
          /* 这份账本是快照，不是实时读数。旧不是错 —— CDN 的 max-age、
             DNS 的 TTL 都允许旧数据存在，前提是说出来。模型拿到 age_text
             必须转述给用户，否则用户会以为「此刻」磁盘就是这样。
             超过 10 分钟（引擎侧 stale=true）时额外给一句硬话。 */
          if (r && r.age_text) {
            base.data_age = r.age_text;
            if (r.stale) base.data_age_note = '索引是' + r.age_text + '建的，这段时间里磁盘可能变了；需要最新结果就重新扫一次';
          }
          /* 按风险分好组，把「能清多少」直接算出来给模型。
             不这么做的话，实测模型会把「Steam 游戏库」和「缓存」并列成
             「这些文件都可以进行清理」—— 用户照做就删掉几十 GB 的游戏本体。
             分组是确定的算术，不该交给模型自由发挥。 */
          const groups = { safe: [], careful: [], keep: [], unknown: [] };
          items.forEach((row) => {
            const g = groups[row.risk] || groups.unknown;
            g.push(row.path);
          });
          const sumOf = (list) => list.reduce((n, p) => {
            const hit = items.find((x) => x.path === p);
            return n + (hit ? hit.bytes : 0);
          }, 0);
          base.groups = {
            safe: { count: groups.safe.length, bytes: fmtBytes(sumOf(groups.safe)), paths: groups.safe.slice(0, 6) },
            careful: { count: groups.careful.length, bytes: fmtBytes(sumOf(groups.careful)), paths: groups.careful.slice(0, 6) },
            keep: { count: groups.keep.length, bytes: fmtBytes(sumOf(groups.keep)), paths: groups.keep.slice(0, 6) },
            unknown: { count: groups.unknown.length, paths: groups.unknown.slice(0, 6) }
          };
          if (base.built) base.note = '本地还没有索引，刚刚自动建了一次（几秒），现在是整机统计';
          if (!base.roots.length) base.note = '本地索引还没建起来，这个结果不能当整机统计';

          /* 直接排好三段式草稿和可点建议。
             为什么不让模型自己排：实测四轮，每修好一处就弄坏另一处 ——
             把「工具箱」这种程序目录列成可删、把微信同时放进「能清」和「要小心」、
             把比赛 ppt 说成「在微信设置中清理」。分组和数字是确定的算术，
             交给一个便宜的 flash 模型自由发挥，答案就永远在几种错法之间摇摆。 */
          const byPath = {};
          items.forEach((row) => { byPath[row.path] = row; });
          /* 同一个 what 出现两次时（两个都叫「下载目录」）人分不清是哪个，
             补上路径最后一段，让它变成「下载目录（SW2026）」 */
          const nameOf = (p) => {
            const row = byPath[p] || {};
            let label = row.what || row.name || p;
            if (row.what) {
              const same = items.filter((x) => x.what === row.what);
              if (same.length > 1) {
                const leaf = String(p).split(/[\\/]/).filter(Boolean).pop() || '';
                if (leaf && leaf !== row.what) label = row.what + '（' + leaf + '）';
              }
            }
            return label;
          };
          const lines = [];
          /* 每条路径只出现一次。上一版把「最占空间的三个目录」和
             「要小心处理的」各写一遍，Steam/手机备份/Minecraft 在答案里
             重复出现两次 —— 用户原话是「格式总规总矩、废话多」。 */
          const used = {};
          const top3 = items.slice(0, 3);
          if (top3.length) {
            lines.push('最占空间的三个目录：');
            top3.forEach((row) => {
              used[row.path] = 1;
              const risk = row.risk === 'safe' ? '可以直接删'
                : row.risk === 'careful' ? ('要小心：' + (row.clean || '不能直接删'))
                  : row.risk === 'keep' ? '别动'
                    : '没认出来，删之前先确认';
              lines.push('· ' + nameOf(row.path) + '，' + row.size +
                (row.pct ? '（占 ' + row.pct + '%）' : '') + ' — ' + row.path + '（' + risk + '）');
            });
          }
          const restOf = (list) => list.filter((p) => !used[p]);
          const safeRest = restOf(groups.safe);
          const careRest = restOf(groups.careful);
          const unkRest = restOf(groups.unknown);
          if (safeRest.length) {
            lines.push('');
            lines.push('能直接清的（共 ' + fmtBytes(sumOf(safeRest)) + '）：');
            safeRest.slice(0, 6).forEach((p) => {
              const row = byPath[p] || {};
              lines.push('· ' + nameOf(p) + '，' + (row.size || '') + ' — ' + p + (row.clean ? '。' + row.clean : ''));
            });
          } else if (groups.safe.length) {
            /* safe 的条目正好都在 top3 里：上面已经标了「可以直接删」，
               这里只指过去，不再重复列一遍路径。 */
            lines.push('');
            lines.push('能直接清的：就是上面标了「可以直接删」的那几个。');
          } else {
            lines.push('');
            lines.push('能直接清的：这一屏里没有。');
          }
          if (careRest.length) {
            lines.push('');
            lines.push('要小心处理的（共 ' + fmtBytes(sumOf(careRest)) + '）：');
            careRest.slice(0, 4).forEach((p) => {
              const row = byPath[p] || {};
              lines.push('· ' + nameOf(p) + '，' + (row.size || '') + ' — ' + (row.clean || '不能直接删'));
            });
          } else if (groups.careful.length) {
            lines.push('');
            lines.push('要小心处理的：就是上面那几个，不能直接删目录。');
          }
          if (unkRest.length) {
            const show = unkRest.slice(0, 4);
            lines.push('');
            /* 数字必须是「下面真正列出来的条数」：上一版写 groups.unknown.length，
               于是出现「没认出来的（7 个）」后面只跟 4 条，自己跟自己打架。 */
            lines.push('没认出来的（' + show.length + ' 个，看起来像程序或项目目录，删之前先确认）：');
            show.forEach((p) => {
              const row = byPath[p] || {};
              lines.push('· ' + p + (row.size ? '，' + row.size : ''));
            });
          }

          /* 建议项也在这里算好：safe 给 delete，careful 给 check。
             unknown 和 keep 一律不进 suggest —— 用户点一下就删的东西不能靠猜。
             注意这里用 groups 全量、不用 restOf：建议按钮是独立的一块 UI，
             和答案正文不重复；而正文去重后如果 safe 恰好全在 top3 里，
             restOf 会是空的，按钮就跟着没了 —— 用户反而更没得点。 */
          const sug = [];
          if (groups.safe.length) {
            sug.push({
              action: 'delete',
              paths: groups.safe.slice(0, 6),
              why: '可以直接删，共 ' + fmtBytes(sumOf(groups.safe)) + '：' +
                groups.safe.slice(0, 3).map(nameOf).join('、')
            });
          }
          if (groups.careful.length) {
            sug.push({
              action: 'check',
              paths: groups.careful.slice(0, 6),
              why: '占得多但要小心清：' +
                groups.careful.slice(0, 2).map((p) => {
                  const row = byPath[p] || {};
                  return nameOf(p) + '（' + (row.clean || '不能直接删') + '）';
                }).join('；')
            });
          }

          /* 目录排行给更大的 cap：1100 会把 15 条压到 2 条，
             模型只看到两个目录，答案自然只有两句。
             2600 还是不够（15 条 × 约 190 字符 ≈ 2900），实测砍到 11 条，
             而模型看到 items 只有 11 条就只讲 3 个。给 6000，让 want 自己控数量。 */
          const out = pageFit(base, items, 0, want, 6000);
          /* suggest_items 必须挂在 fit 之后：fit 会从尾部砍数组，
             挂在里面会被砍成 1 条（实测只剩 delete 那条，careful 组直接消失）。 */
          if (out && typeof out === 'object') {
            out.draft = lines.join('\n');
            if (sug.length) out.suggest_items = sug;
            /* count 按「模型真正看得到的条数」重算，别让它说「一共 15 个」却只讲 11 个。
               注意：这里只改数字，不要加解释性的 note —— 实测加一句
               「只列出最大的 11 个（一共 15 个）」之后，模型反而只肯讲 3 个目录。 */
            if (Array.isArray(out.items) && out.count !== out.items.length) {
              out.found = out.count;
              out.count = out.items.length;
            }
          }
          return out;
        },
        summary: (args, r) => `目录体积排行 · ${r.count} 个${r.built ? '（刚建索引）' : ''}`
      },

      /* 和 top_files 的分工：
         top_files 现扫一个目录，扫不完只能给部分结果；
         这里读本地索引里已经存下的 size 列，毫秒级、覆盖所有已索引根目录。
         只用于「某个目录里哪个文件最大」，回答「什么最占空间」要用 top_folders。 */
      top_indexed: {
        label: '索引排行',
        run: async (args) => {
          const want = Math.min(Math.max(Number(args.limit) || 20, 1), 50);
          const off = Math.max(0, Math.floor(Number(args.offset) || 0));
          const minSize = Math.max(0, Math.floor(Number(args.min_size) || 0));
          const r = await withTimeout(
            API.engine('search.top', { limit: Math.min(off + want, 50), min_size: minSize }),
            TIMEOUT, '索引排行');
          const items = ((r && r.items) || []).map((it) => ({
            name: it.name,
            path: it.path,
            size: fmtBytes(it.size),
            bytes: Number(it.size) || 0,
            age: fmtAge(it.mtime)
          }));
          const base = {
            count: items.length,
            total: r.total,
            /* 覆盖范围必须回给模型：索引只覆盖登记过的目录，
               不写出来它就会把「索引里的前几名」说成「整机最占空间」。 */
            roots: r.roots || [],
            indexed: r.indexed || 0,
            hint: r.hint || ''
          };
          if (!(r.roots || []).length) {
            base.note = '本地索引还没建，这个结果不能当整机统计；需要的话先去「搜索」页建立一次索引';
          }
          /* 同 top_folders：快照要自报年龄，否则模型会把「半小时前」说成「现在」。 */
          if (r && r.age_text) {
            base.data_age = r.age_text;
            if (r.stale) base.data_age_note = '索引是' + r.age_text + '建的，这段时间里磁盘可能变了；需要最新结果就重新扫一次';
          }
          return pageFit(base, items, off, want);
        },
        summary: (args, r) => `索引排行 · ${r.count} 个${(r.roots || []).length ? '' : '（无索引）'}`
      },

      empty_dirs: {
        label: '空文件夹',
        run: async (args) => {
          const dir = needDir(args);
          const depth = Math.min(Math.max(Number(args.depth) || 2, 1), 3);
          const r = await withTimeout(API.scanEmptyDirs(dir, 500, depth), SCAN_TIMEOUT, '空文件夹扫描');
          const list = (r && r.items) || (Array.isArray(r) ? r : []) || [];
          const items = list.map((it) => ({
            path: (it && it.path) || it,
            depth: it && it.depth,
            kind: it && it.kind === 'protected' ? 'protected' : 'empty',
            why: (it && it.why) || ''
          }));
          const empty = items.filter((i) => i.kind === 'empty').length;
          const want = Math.min(Math.max(Number(args.limit) || 30, 1), 100);
          const off = Math.max(0, Math.floor(Number(args.offset) || 0));
          const base = { dir, depth, empty, protected: items.length - empty };
          if (r && r.partial === true) {
            base.partial = true;
            base.scanned = r.scanned;
            base.note = `只扫了 ${r.scanned} 个目录就到了时间上限，可能有空文件夹没被扫到`;
          }
          return pageFit(base, items, off, want);
        },
        summary: (args, r) => `空文件夹 ${args.dir} · 可删 ${r.empty} / 受保护 ${r.protected}${r.partial ? '（部分）' : ''}`
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
          const want = 20;
          const off = Math.max(0, Math.floor(Number(args.offset) || 0));
          return pageFit({ total: all.length, matched: hit.length, filter }, hit, off, want);
        },
        summary: (args, r) => `已安装程序 · 匹配 ${r.matched}/${r.total}`
      },

      search_files: {
        label: '搜索文件',
        run: async (args) => {
          const q = String((args && args.q) || '').trim();
          if (!q) throw new Error('缺少参数 q（要搜索的文件名关键词）');
          const want = 20;
          const off = Math.max(0, Math.floor(Number(args.offset) || 0));
          const r = await withTimeout(API.engine('search.query', { q, limit: Math.min(off + want, 50) }), TIMEOUT, '搜索文件');
          const items = ((r && r.items) || []).map((it) => ({
            name: it.name,
            path: it.path,
            size: fmtBytes(it.size),
            age: fmtAge(it.mtime)
          }));
          return pageFit({ q, total: r.total, source: r.source, hint: r.hint || '' }, items, off, want);
        },
        summary: (args, r) => `搜索「${args.q}」· ${r.total} 条`
      },

      organize_preview: {
        label: '整理预演',
        run: async (args) => {
          const raw = (args && (args.paths || args.path || args.dir)) || [];
          const paths = (Array.isArray(raw) ? raw : [raw]).filter((p) => typeof p === 'string' && p.trim());
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
          const blockedList = Array.isArray(r && r.blocked) ? r.blocked : [];
          const groups = [];
          let skipped = [];
          const blockedItems = [];

          for (const b of blockedList) {
            blockedItems.push({ folder: b.folder, reason: b.error || '受保护或无法访问' });
          }

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
            blocked: blockedList.length,
            blocked_folders: blockedItems,
            total_size: fmtBytes(r.total_size || 0),
            groups,
            skipped: skipped.slice(0, 12),
            skipped_total: skipped.length
          }, CAP);
        },
        summary: (args, r) => '整理预演 · ' + r.total + ' 个文件 / ' + (r.groups ? r.groups.length : 0) + ' 个类别' + (r.blocked ? ' (' + r.blocked + ' 处受阻)' : '')
      },

      /* 分类与跳过的「为什么」：规则来自引擎当前的 rules.json，
         不是模型凭常识猜。解释分类、解释某个文件为什么落到那一类、
         解释某条跳过原因到底是什么意思，都走这一个工具。 */
      explain_rules: {
        label: '分类规则',
        run: async (args) => {
          const params = {};
          const cat = String((args && args.cat) || '').trim();
          const name = String((args && args.name) || '').trim();
          if (cat) params.cat = cat;
          if (name) params.name = name;
          const r = await withTimeout(API.engine('rules.explain', params), TIMEOUT, '读取分类规则');
          const out = {
            fallback: r.fallback,
            cat_order: r.cat_order || [],
            never: r.never || {},
            skip_reasons: (r.skip_reasons || []).map((x) => x.reason + '：' + x.why),
            content: r.content || {}
          };
          if (r.category) out.category = r.category;
          else {
            out.categories = (r.categories || []).map((c) => ({
              cat: c.cat, count: c.ext_count, exts: (c.exts || []).join(' ')
            }));
          }
          if (r.matched) out.matched = r.matched;
          return fit(out, CAP);
        },
        summary: (args, r) => '分类规则' + (r.matched ? ' · ' + r.matched.name + ' → ' + r.matched.cat : '') +
          (r.category ? ' · ' + r.category.cat : '')
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
      },

      /* ------------------------------------------------ 动作：提议 / 撤回 */
      /* 这是模型唯一能「动手」的入口，而它动手的方式只是「递一个提案」。
         真正执行在 proposals.commit()，那个函数不在工具表里，模型调不到。 */
      propose_action: {
        label: '提议动作',
        run: async (args) => {
          if (!proposals) throw new Error('动作通道没有接上（内部错误）');
          const action = String((args && args.action) || '').trim();
          if (!action) throw new Error('缺少参数 action（动作名，见动作目录）');
          const r = await proposals.propose({
            action,
            args: (args && args.args) || {},
            reason: String((args && args.reason) || '')
          });
          if (!r.ok) throw new Error(r.error);
          const p = r.proposal;
          return fit({
            ok: true,
            proposal_id: p.id,
            status: r.auto ? 'countdown' : 'waiting_user',
            action: p.action,
            label: p.label,
            count: p.card.count,
            size: fmtBytes(p.card.bytes),
            risk: p.risk,
            reversible: p.reversible,
            summary: p.card.summary,
            note: r.auto
              ? '卡片已出现，3 秒后自动执行。用户在倒计时里点「取消」就会停下。'
              : '卡片已放到界面等用户点确认。现在不要说「已经完成」，只能说「已提交，等你确认」。'
          }, CAP);
        },
        summary: (args, r) => `提议 ${args.action} · ${r.count} 项`
      },

      list_proposals: {
        label: '待确认提案',
        run: async () => {
          if (!proposals) return { count: 0, items: [] };
          const list = proposals.list().map((p) => ({
            id: p.id,
            action: p.action,
            summary: p.card.summary,
            count: p.card.count,
            exe_in: Math.max(0, Math.round((p.expires - Date.now()) / 1000)) + 's'
          }));
          return fit({ count: list.length, items: list }, CAP);
        },
        summary: (args, r) => `待确认 ${r.count} 个`
      },

      cancel_proposal: {
        label: '撤回提案',
        run: async (args) => {
          if (!proposals) throw new Error('动作通道没有接上');
          const r = await proposals.cancel(String((args && args.id) || ''));
          if (!r.ok) throw new Error(r.error);
          return { ok: true, id: args.id };
        },
        summary: (args) => `撤回 ${args.id}`
      },

      /* 让模型能主动把用户带到某个页面（只切页面，不改任何东西） */
      navigate: {
        label: '跳转页面',
        run: async (args) => {
          const page = String((args && args.page) || '').trim();
          const okPages = ['organize', 'tools', 'search', 'apps', 'archive', 'clean', 'settings', 'ai'];
          if (okPages.indexOf(page) < 0) throw new Error('page 只能是 ' + okPages.join(' / '));
          const payload = (args && args.payload) || args || {};
          if (typeof deps.navigate === 'function') deps.navigate(page, payload);
          else if (root.App && typeof root.App.jump === 'function') root.App.jump(page, payload);
          else location.hash = '#' + page;
          return { page, opened: true };
        },
        summary: (args) => `跳转 ${args.page}`
      },

      /* ---------------------------------------------------- 只为动手做准备 */
      archive_entries: {
        label: '压缩包内容',
        run: async (args) => {
          const path = String((args && args.path) || '').trim();
          if (!path) throw new Error('缺少参数 path（压缩包完整路径）');
          const want = Math.min(Math.max(Number(args.limit) || 30, 1), 100);
          const off = Math.max(0, Math.floor(Number(args.offset) || 0));
          const info = await withTimeout(API.archiveOpen(path, args.password || null), 25000, '读取压缩包');
          const entries = ((info && info.entries) || []).map((e) => ({
            name: e.name,
            dir: e.dir === true,
            size: e.dir ? undefined : fmtBytes(e.size)
          }));
          return pageFit({
            path,
            format: info && info.format,
            encrypted: !!(info && info.encrypted),
            total_size: fmtBytes(info && info.totalSize),
            count: entries.length
          }, entries, off, want);
        },
        summary: (args, r) => `压缩包 ${args.path} · ${r.count} 项`
      },

      /* 清理类动作需要真实路径作为参数；这个工具给出「清什么」的候选 */
      clean_candidates: {
        label: '清理候选',
        run: async (args) => {
          const kind = String((args && args.kind) || 'cache').trim().toLowerCase();
          if (kind === 'shots') {
            const days = Math.min(Math.max(Number(args.days) || 30, 1), 3650);
            const r = await withTimeout(API.engine('shots.scan', { days }), 20000, '扫描截图');
            const items = ((r && r.items) || []).map((it) => ({
              path: it.path,
              size: fmtBytes(it.size),
              age: fmtAge(it.mtime),
              shot: it.shot === true
            }));
            return pageFit({ kind, days, total: items.length, size: fmtBytes(r && r.size) }, items, 0, 25);
          }
          const r = await withTimeout(API.engine('cache.list', { include_custom: true }), 15000, '读取缓存清单');
          const out = [];
          for (const g of (r && r.groups) || []) {
            const its = (g.items || []).filter((it) => it.exists !== false);
            if (!its.length) continue;
            const paths = [];
            for (const it of its) {
              for (const p of (it.paths || (it.path ? [it.path] : []))) paths.push(p);
            }
            out.push({
              group: g.name || g.title || g.key || '',
              level: its[0] && its[0].level,
              paths: paths.slice(0, 6),
              count: paths.length,
              size: fmtBytes(its.reduce((n, it) => n + (Number(it.size) || 0), 0))
            });
          }
          return fit({ kind, total_size: fmtBytes(r && r.total_size), groups: out.slice(0, 8) }, CAP);
        },
        summary: (args, r) => `清理候选 ${args.kind || 'cache'} · ${(r.groups || []).length} 组`
      },

      settings_read: {
        label: '读设置',
        run: async () => {
          const r = await withTimeout(API.engine('settings.get', {}), TIMEOUT, '读取设置');
          const keep = ['conflict_policy', 'recursive_depth', 'default_recursive', 'default_content',
            'log_keep_days', 'shot_keep_days', 'shot_min_kb', 'shot_auto', 'cache_auto',
            'shot_to_trash', 'cache_to_trash', 'tray_enabled', 'close_to_tray', 'close_action'];
          const out = {};
          for (const k of keep) if (r && r[k] !== undefined) out[k] = r[k];
          const auto = await withTimeout(API.getAutostart().catch(() => null), TIMEOUT, '读开机启动').catch(() => null);
          const sch = await withTimeout(API.scheduleGet().catch(() => null), TIMEOUT, '读定时任务').catch(() => null);
          return fit({
            settings: out,
            autostart: auto,
            schedule: sch ? { enabled: sch.enabled, time: sch.time, days: sch.days, cache: sch.cache, screenshots: sch.screenshots, exists: sch.exists } : null
          }, CAP);
        },
        summary: (args, r) => '设置 ' + Object.keys(r.settings || {}).length + ' 项'
      },

      search_roots: {
        label: '索引清单',
        run: async () => {
          const r = await withTimeout(API.engine('search.status', {}), TIMEOUT, '读取索引');
          const items = ((r && r.entries) || []).slice(0, 8).map((it) => ({
            root: it.root || it.path,
            files: it.files,
            ok: !it.why && it.exists !== false,
            why: it.why || ''
          }));
          return fit({ count: (r && r.count) || items.length, indexed: r && r.indexed, items }, CAP);
        },
        summary: (args, r) => `索引 ${r.count} 个目录`
      }
    };

    return table;
  }

  const API = { makeTools, fit, fmtBytes, fmtAge, CAP, TIMEOUT };
  root.AITools = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
