/* AI 助手 · 写入闸门（路径层）
   ------------------------------------------------------------
   这一层只做一件事：判断「这个路径能不能被 AI 发起的动作碰到」。

   它不替代引擎自己的闸门（files.delete 的 _files_delete_guard_why、
   cache.clean 的 cache_path_forbidden、remove_empty_dirs 的 empty_dir_denied）。
   引擎那一层是第二道，这一层是第三道，两边都过才算通过：
   历史上出过「界面加了一个新入口，忘了过 guard」的事故，所以宁可重复。

   规则分四类：
   1. 形状：必须是 X:\ 开头的绝对路径，不允许 ..、不允许 UNC/设备路径
   2. 系统：系统盘的系统目录、Program Files、ProgramData、回收站、恢复分区
   3. 自己：程序目录、用户数据目录（只放行 cache 子树与 ai 目录之外的读写）
   4. 敏感：.git / .ssh / .gnupg 等目录段，pagefile 等系统文件

   全部为纯函数，配置通过 configure() 注入，便于离线自测。 */
(function (root) {
  'use strict';

  const cfg = {
    home: '',
    sysDrive: 'C:',
    appDir: '',
    dataDir: '',
    roots: []
  };

  const SEG_DENY = ['.git', '.ssh', '.gnupg', '.aws', '.kube', '.docker', '.azure'];
  const NAME_DENY = ['pagefile.sys', 'hiberfil.sys', 'swapfile.sys', 'bootmgr',
    'bootmgr.efi', 'ntldr', 'boot.ini', 'ntuser.dat', 'ntuser.ini'];

  const PERSONAL = ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Videos', 'Music', 'OneDrive'];

  function norm(raw) {
    let s = String(raw || '').trim();
    if (!s) return '';
    /* 环境变量先落地：模型偶尔会给 %USERPROFILE%\Desktop 这种写法 */
    s = s.replace(/%([A-Za-z_]+)%/g, (m, name) => {
      const k = String(name).toUpperCase();
      if (k === 'USERPROFILE' && cfg.home) return cfg.home;
      if (k === 'LOCALAPPDATA' && cfg.home) return cfg.home + '\\AppData\\Local';
      if (k === 'APPDATA' && cfg.home) return cfg.home + '\\AppData\\Roaming';
      if (k === 'TEMP' && cfg.home) return cfg.home + '\\AppData\\Local\\Temp';
      if (k === 'SYSTEMDRIVE') return cfg.sysDrive;
      return m;
    });
    s = s.replace(/\//g, '\\');
    if (/^[A-Za-z]:$/.test(s)) s += '\\';
    /* 设备路径与网络路径一律不处理：解引用、符号链接、远程共享都超出本工具的边界 */
    if (/^\\\\[?.]\\/.test(s)) return '';
    if (/^\\\\/.test(s)) return '';
    if (!/^[A-Za-z]:\\/.test(s)) return '';
    const parts = s.split('\\');
    const drive = String(parts.shift() || '').toUpperCase();
    const out = [];
    for (const seg of parts) {
      if (!seg || seg === '.') continue;
      if (seg === '..') {
        if (!out.length) return '';
        out.pop();
        continue;
      }
      out.push(seg);
    }
    return drive + '\\' + out.join('\\');
  }

  const low = (p) => String(p || '').toLowerCase();

  function isUnder(child, parent) {
    const c = low(child);
    const p = low(parent).replace(/\\+$/, '');
    if (!c || !p) return false;
    return c === p || c.indexOf(p + '\\') === 0;
  }

  function configure(opt) {
    const o = opt || {};
    if (typeof o.home === 'string' && /^[A-Za-z]:\\/.test(o.home)) cfg.home = norm(o.home);
    if (typeof o.appDir === 'string') cfg.appDir = norm(o.appDir);
    if (typeof o.dataDir === 'string') cfg.dataDir = norm(o.dataDir);
    if (Array.isArray(o.roots)) cfg.roots = o.roots.map(norm).filter(Boolean);
    if (cfg.home) cfg.sysDrive = cfg.home.slice(0, 2).toUpperCase();
    else if (o.sysDrive) cfg.sysDrive = String(o.sysDrive).toUpperCase();
    return config();
  }

  function config() {
    return { home: cfg.home, sysDrive: cfg.sysDrive, appDir: cfg.appDir, dataDir: cfg.dataDir };
  }

  /* 返回拒绝原因；空串表示通过。opts.allowApp/opts.allowData 用于极少数
     明确要动程序目录或数据目录的动作（目前没有动作会打开它们）。 */
  function denyWhy(raw, opts) {
    const o = opts || {};
    const p = norm(raw);
    if (!p) return '需要 X:\\ 开头的完整路径（不接受相对路径、..、网络路径）';

    const segs = p.split('\\').slice(1);
    for (const seg of segs) {
      if (SEG_DENY.indexOf(low(seg)) >= 0) return '这是版本库或凭据目录（' + seg + '），不能由 AI 改动';
    }
    const base = segs.length ? segs[segs.length - 1] : '';
    if (NAME_DENY.indexOf(low(base)) >= 0) return '系统关键文件（' + base + '）不能由 AI 改动';

    /* 盘符根：整盘、整分区都不能作为一个动作的对象 */
    if (/^[A-Z]:\\$/.test(p)) return '盘符根目录不能整体操作';

    const sys = cfg.sysDrive || 'C:';
    const systemDirs = [
      sys + '\\Windows',
      sys + '\\Program Files',
      sys + '\\Program Files (x86)',
      sys + '\\ProgramData',
      sys + '\\$Recycle.Bin',
      sys + '\\System Volume Information',
      sys + '\\Recovery',
      sys + '\\Boot',
      sys + '\\PerfLogs'
    ];
    for (const d of systemDirs) {
      if (isUnder(p, d)) return '系统目录（' + d + '）不能由 AI 改动';
    }

    if (cfg.appDir && !o.allowApp && isUnder(p, cfg.appDir)) {
      return '这是整理助手自己的程序目录，AI 不能改动它';
    }

    if (cfg.dataDir && isUnder(p, cfg.dataDir)) {
      /* 数据目录里只有两处例外：缓存子树（清理缓存是正常功能）与
         ai 目录之外的会话文件。ai 目录（日志、提案、会话）永远不碰。 */
      if (isUnder(p, cfg.dataDir + '\\ai')) return '这是 AI 自己的数据目录，不能由 AI 改动';
      const cacheOk = isUnder(p, cfg.dataDir + '\\cache');
      if (!cacheOk && !o.allowData) return '这是整理助手的数据目录（配置、历史），不能由 AI 整目录改动';
    }

    if (cfg.home) {
      if (low(p) === low(cfg.home)) return '不能对用户主目录本身执行这个动作';
      for (const d of PERSONAL) {
        if (low(p) === low(cfg.home + '\\' + d)) {
          return '不能对「' + d + '」目录本身执行这个动作（里面的文件可以单独处理）';
        }
      }
      const startup = cfg.home + '\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup';
      if (isUnder(p, startup)) return '开机启动目录只能通过「开机启动」开关调整，不能直接改文件';
    }

    return '';
  }

  /* 批量检查：返回 {ok, bad:[{path, why}]}。任何一个不过就整批不过——
     模型看到的错误里带路径与原因，它可以换一条路径重试。 */
  function check(list, opts) {
    const arr = Array.isArray(list) ? list : [];
    const bad = [];
    const seen = new Set();
    for (const raw of arr) {
      const p = norm(raw);
      const why = denyWhy(raw, opts);
      if (why) {
        bad.push({ path: String(raw || ''), why });
        continue;
      }
      if (seen.has(low(p))) {
        bad.push({ path: p, why: '同一个路径在清单里出现了两次' });
        continue;
      }
      seen.add(low(p));
    }
    return { ok: bad.length === 0, bad };
  }

  const API = { configure, config, norm, denyWhy, check, isUnder, PERSONAL, SEG_DENY };
  root.AIGuard = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
