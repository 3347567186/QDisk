(function () {
  'use strict';

  const STORAGE_SCHEME = 'ta-site-scheme';
  const STORAGE_LANG = 'ta-site-lang';
  const LATEST_URL = 'https://github.com/3347567186/TidyAssistant/releases/latest/download/latest.json';

  const COPY = {
    zh: {
      brand: '整理助手',
      'nav.bench': '实测数据',
      'nav.features': '核心亮点',
      'nav.arch': '自研与开发',
      'nav.download': '下载安装',
      'nav.get': '立即下载',
      'hero.badge': 'Windows 10/11 x64 · MIT 开源 · 零广告',
      'hero.title': '不弹广告、不靠黑盒、<br>每一步都能撤回的 Windows 桌面整理工具',
      'hero.sub': '将智能文件整理、Rust 四档并发压缩内核、分级 C 盘清理与可审计本地 AI 助手装进 20.6 MB 原生桌面客户端。所有高危操作先预演再落盘，全部数据留在本机。',
      'hero.dlExe': '下载安装版',
      'hero.dlZip': '便携免安装版',
      'hero.viewCode': '查看 GitHub 源码',
      'hero.trust1': '✓ 5.56 MB 原生主程序',
      'hero.trust2': '✓ 0.31 ms 对话真停止',
      'hero.trust3': '✓ SHA-256 强制校验更新',
      'hero.trust4': '✓ 362+ 项自动化测试 0 警告',
      'tabs.ai': 'AI 助手',
      'tabs.org': '智能整理',
      'tabs.arc': '高速压缩',
      'tabs.cache': '安全清理',
      'tabs.tools': '大文件溯源',
      'bench.eyebrow': 'REAL BENCHMARKS · 实测而非宣传',
      'bench.title': '不靠口号，用本机实测数据说话',
      'bench.desc': '以下所有指标均在 AMD Ryzen 9 5900HX（8 核 16 线程）· Windows 11 x64 · NVMe SSD · TidyAssistant v1.43.15 上实机跑测取得，源码仓库可直接复现。',
      'bench.k1Title': 'AI 对话阻塞停止中位数',
      'bench.k1Meta': '5 次挂起 Socket 实测（239–323 µs），跨线程直接关闭 WinHTTP 句柄，告别 60–300s 卡死。',
      'bench.k2Title': 'Rust 多核 ZIP 压缩峰值',
      'bench.k2Meta': '64 MB 混合集（75% JSON + 25% PNG）实测，相对节约档（21.2 MB/s）提速 14.4 倍。',
      'bench.k3Title': '10,001 文件 FTS5 检索中位数',
      'bench.k3Meta': 'Rust indexwalk 建库仅 68.4 ms（约 14.6 万文件/秒），30 次检索 P95 仅 7.23 ms。',
      'bench.k4Title': '1,000 文件全量一键撤回',
      'bench.k4Meta': '扫描预演 306.5 ms · 整理移动 1.79 s · 一键撤回 1,000/1,000 零损还原。',
      'bench.chartTitle': '压缩内核四档动态性能阶梯实测（64 MB 混合集）',
      'bench.mSaver': '节约 · 1 线程 · 35%/25% 占空',
      'bench.mBal': '平衡 · 6 线程 · 65%/50% 占空',
      'bench.mPerf': '高性能 · 10 线程 · 85%/75% 占空',
      'bench.mHyper': '超线程 · 16 线程 · 100% 满核零限速',
      'bench.chartNote': '* 注：64 MB 极短任务下 16 线程建池开销略高于 10 线程；GB 级大文件场景下超线程档位零限速吃满全部逻辑核心。同集解压（含页缓存）达 852.6 → 2,998.6 → 3,844.1 MB/s。',
      'bench.tableTitle': '工程体积、响应与测试门禁实测',
      'bench.r1': '原生外壳体积 (tidy-assistant.exe)',
      'bench.r2': '安装包 / 便携包体积',
      'bench.r3': '零框架前端源码（0 node_modules）',
      'bench.r4': '本地引擎冷启动 / 热态 RPC 往返',
      'bench.r5': '1,000 文件扫描预演 / 整理 / 撤回',
      'bench.r6': '10,001 文件索引建库 / 检索中位数',
      'bench.r7': 'Python / Rust / JS 自动化测试门禁',
      'feat.eyebrow': 'FOUR CORE PILLARS · 只讲硬核重点',
      'feat.title': '把最常用的四件麻烦事，做到零焦虑',
      'feat.p1Title': '可审计本地 AI 助手：透明查证 + 0.31ms 真停止',
      'feat.p1Desc': '自带密钥直连 DeepSeek / OpenAI / Ollama 等任意兼容端点。每一步推理原文、本地工具调用与毫秒耗时全部展开可查；体积和路径自动同源核对防幻觉；所有写/删动作走四档权限审批卡片，点停止 0.31ms 底层断连不烧 Token。',
      'feat.p1L1': '只读 / 确认 / 自动 / 放手四档可控权限',
      'feat.p1L2': '多备用端点自动容灾 + 断点续跑',
      'feat.p2Title': '先预演再落盘的智能整理 + 一键精准撤回',
      'feat.p2Desc': '扫描即预演，先看分类清单与跳过原因再执行。底层自动保护代码仓库（检测源码/配置自动拦截）、系统目录与下载中临时文件；1,000 文件 1.79 秒归位，不满意 1.39 秒原路撤回。',
      'feat.p2L1': '支持自定义 YAML 规则与 AI 草稿一键导入',
      'feat.p2L2': '每次整理独立留痕，随时一键还原',
      'feat.p3Title': 'Rust 多核零广告压缩包内核',
      'feat.p3Desc': '原生支持 ZIP / 7Z / RAR / TAR / TAR.GZ / BZ2 / XZ 浏览、双击内置预览、解压与打包。按本机 CPU 核数动态阶梯调速，支持分块级真暂停/秒取消、同名覆盖或并存重命名，以及单槽原子撤回。',
      'feat.p3L1': '防 ZIP Slip、符号链接逃逸与 32 GiB 压缩炸弹',
      'feat.p3L2': '单槽撤回机制防止大文件备份占用爆炸',
      'feat.p4Title': 'C 盘安全清理、大文件签名溯源与事务迁移',
      'feat.p4Desc': '缓存按「安全可重建 / 谨慎复核」分层标注，绝不误删聊天记录与文档；大文件直读数字签名与发行商；跨盘数据迁移带哈希校验与事务日志，按需提权、平时零特权运行。',
      'feat.p4L1': '68.4 ms 建 1 万文件索引，6.53 ms 极速模糊检索',
      'feat.p4L2': '孤立残留排查、开机自启与定时静默清理',
      'arch.eyebrow': 'ARCHITECTURE & EXTENSIBILITY · 自研底座与二次开发',
      'arch.title': '自研了什么、用了什么开源组件、如何二次开发',
      'arch.desc': '拒绝套壳拼凑：三层清晰分层、零前端打包依赖，并在四层均预留标准注册表，新增页面、AI 工具、RPC 命令或压缩格式都无需魔改核心代码。',
      'arch.selfTitle': '核心自研模块',
      'arch.s1': '4 档动态 WorkPacer、分块暂停取消、防逃逸与单槽撤回',
      'arch.s2': 'AI_CANCEL_EPOCH + RAII 句柄表，0.31ms 跨线程中止',
      'arch.s3': 'installer / portable 双形态、仓库锁仓与失败自动回滚',
      'arch.s4': 'Tools/JSON 自动降级、数字路径反幻觉与审批提案卡',
      'arch.s5': 'Dry-Run / 一键撤回 / SQLite FTS5 / Rust 高速遍历',
      'arch.ossTitle': '使用的开源技术栈',
      'arch.o1': '原生 WebView2 外壳、托盘、单实例与 IPC Channel',
      'arch.o2': 'WinHTTP TLS、ShellExecuteW、线程优先级与 SHA-256',
      'arch.o3': 'zip / sevenz-rust2 / lzma-rust2 / flate2(zlib-rs) / bzip2 / tar',
      'arch.o4': '规则引擎、缓存分析与全文索引（单文件封装）',
      'arch.o5': '不随包分发，首次打开 RAR 时双重 SHA-256 校验提取',
      'arch.devTitle': '3 条命令开始二次开发与全量门禁验证',
      'arch.devSub': '预留 4 大官方扩展口：<code>App.registerPage</code> · <code>AIRegistry.register</code> · <code>tidy.register_engine_method</code> · Rust <code>ArchiveCodec</code>',
      'arch.copy': '复制命令',
      'arch.copied': '已复制 ✓',
      'dl.eyebrow': 'DOWNLOAD & VERIFY · 立即获取',
      'dl.title': '选择适合你的版本，30 秒上手',
      'dl.desc': '全部配置、整理规则与撤回记录独立保存在 <code>%LOCALAPPDATA%\\整理助手数据</code>，升级或重装永不覆盖个人数据。',
      'dl.rec': '推荐 · 日常主力',
      'dl.exeTitle': 'Windows 安装版 (NSIS x64)',
      'dl.exeDesc': '标准一键安装，带开始菜单快捷方式与干净卸载；后续在软件设置页一键校验 SHA-256 覆盖升级。',
      'dl.exeBtn': '下载安装版 (.exe)',
      'dl.port': '免安装 · U 盘随身',
      'dl.zipTitle': 'Windows 便携版 (Portable ZIP)',
      'dl.zipDesc': '解压至纯英文目录即可直接运行；软件内更新自动备份旧版并原子替换，异常自动回滚零损坏。',
      'dl.zipBtn': '下载便携版 (.zip)',
      'dl.allReleases': '全部历史版本 (GitHub Releases)',
      'dl.thirdParty': '第三方许可声明',
      'foot.note': '开源于 MIT 协议 · 本地优先、零遥测、零广告'
    },
    en: {
      brand: 'TidyAssistant',
      'nav.bench': 'Benchmarks',
      'nav.features': 'Highlights',
      'nav.arch': 'Architecture',
      'nav.download': 'Download',
      'nav.get': 'Download',
      'hero.badge': 'Windows 10/11 x64 · MIT Open Source · Zero Ads',
      'hero.title': 'Ad-free, local-first Windows utility<br>with Dry-Run & Undo on every step.',
      'hero.sub': 'Smart file organization, a 4-tier multi-core Rust archive kernel, risk-tiered C: drive cleanup, and an auditable local AI assistant — packed into a 20.6 MB native app. Everything stays on your machine.',
      'hero.dlExe': 'Download Installer',
      'hero.dlZip': 'Portable ZIP',
      'hero.viewCode': 'View on GitHub',
      'hero.trust1': '✓ 5.56 MB Native Binary',
      'hero.trust2': '✓ 0.31 ms Instant AI Stop',
      'hero.trust3': '✓ SHA-256 Verified Updates',
      'hero.trust4': '✓ 362+ Automated Tests · 0 Warnings',
      'tabs.ai': 'AI Assistant',
      'tabs.org': 'Organizer',
      'tabs.arc': 'Archives',
      'tabs.cache': 'Cache Cleaner',
      'tabs.tools': 'Space Tools',
      'bench.eyebrow': 'REAL BENCHMARKS · MEASURED, NOT ESTIMATED',
      'bench.title': 'Measured on real hardware, reproducible from source',
      'bench.desc': 'Every metric below was measured on AMD Ryzen 9 5900HX (8C/16T) · Windows 11 x64 · NVMe SSD running TidyAssistant v1.43.15.',
      'bench.k1Title': 'Median AI Stop Latency',
      'bench.k1Meta': '5 trials aborting a stalled WinHttpReceiveResponse socket (239–323 µs) via cross-thread handle close vs 60–300s hangs.',
      'bench.k2Title': 'Peak Multi-Core ZIP Create',
      'bench.k2Meta': '64 MB mixed workload (75% JSON + 25% PNG) — 14.4× faster than Saver tier (21.2 MB/s).',
      'bench.k3Title': 'FTS5 Search over 10,001 Files',
      'bench.k3Meta': 'Rust indexwalk builds the index in 68.4 ms (~146k files/s); P95 query latency across 30 runs is 7.23 ms.',
      'bench.k4Title': 'Full Undo of 1,000 Moved Files',
      'bench.k4Meta': '306.5 ms Dry-Run scan · 1.79 s organize · 1.39 s lossless 1,000/1,000 one-click restore.',
      'bench.chartTitle': '4-Tier Adaptive Archive Throughput (64 MB Mixed Set)',
      'bench.mSaver': 'Saver · 1 thread · 35%/25% duty',
      'bench.mBal': 'Balanced · 6 threads · 65%/50% duty',
      'bench.mPerf': 'Performance · 10 threads · 85%/75% duty',
      'bench.mHyper': 'Hyper · 16 threads · 100% unthrottled',
      'bench.chartNote': '* On a tiny 64 MB burst, 16-thread pool init slightly trails 10 threads; on multi-GB archives Hyper saturates all cores unthrottled. Warm-cache extraction reaches 852.6 → 2,998.6 → 3,844.1 MB/s.',
      'bench.tableTitle': 'Footprint, Latency & Quality Gate',
      'bench.r1': 'Native Shell Binary (tidy-assistant.exe)',
      'bench.r2': 'NSIS Installer / Portable ZIP',
      'bench.r3': 'Zero-Framework Frontend (0 node_modules)',
      'bench.r4': 'Engine Cold Boot / Warm RPC Roundtrip',
      'bench.r5': '1,000-File Dry-Run / Move / Undo',
      'bench.r6': '10,001-File Index Build / Median Query',
      'bench.r7': 'Python / Rust / JS Automated Gate',
      'feat.eyebrow': 'FOUR CORE PILLARS · FOCUSED ON WHAT MATTERS',
      'feat.title': 'Four everyday headaches, engineered for zero fear',
      'feat.p1Title': 'Auditable Local AI Assistant: Verified Tools + 0.31 ms Stop',
      'feat.p1Desc': 'Bring your own OpenAI-compatible API key or local Ollama. Expandable reasoning and tool latency logs, anti-hallucination size/path cross-checks, 4-tier approval cards for writes, and 0.31 ms native WinHTTP abort.',
      'feat.p1L1': '4 permission tiers: Read-only / Confirm / Auto / Full Auto',
      'feat.p1L2': 'Multi-endpoint failover + resumable checkpoints',
      'feat.p2Title': 'Dry-Run File Organizer + Lossless One-Click Undo',
      'feat.p2Desc': 'Always previews categories and skipped items first. Automatically protects source-code repos, system paths, and active downloads; moves 1,000 files in 1.79 s and restores every file in 1.39 s.',
      'feat.p2L1': 'Custom YAML rules + direct import from AI drafts',
      'feat.p2L2': 'Per-run history manifests for instant rollback',
      'feat.p3Title': 'Multi-Core Ad-Free Rust Archive Kernel',
      'feat.p3Desc': 'Supports ZIP / 7Z / RAR / TAR / TAR.GZ / BZ2 / XZ browsing, built-in preview, extraction, and creation. Dynamic CPU-core tiering, chunk-level pause/cancel, overwrite-or-coexist conflict prompts, and single-slot atomic Undo.',
      'feat.p3L1': 'Blocks ZIP Slip, symlink escapes & 32 GiB zip bombs',
      'feat.p3L2': 'Single-slot Undo prevents backup disk bloat',
      'feat.p4Title': 'Safe C: Drive Cleanup, Signature Audit & Transactional Migrate',
      'feat.p4Desc': 'Separates rebuildable safe caches from cautious items so personal chats and docs are never touched; inspects Authenticode publishers on large files; hash-verified cross-drive migration runs with zero ambient elevation.',
      'feat.p4L1': '68.4 ms indexing for 10k files · 6.53 ms FTS5 lookup',
      'feat.p4L2': 'Orphan leftover sweep, startup control & scheduled cleanup',
      'arch.eyebrow': 'ARCHITECTURE & EXTENSIBILITY',
      'arch.title': 'What we built in-house, what OSS we use, and how to extend it',
      'arch.desc': 'Clean 3-layer architecture with zero frontend bundler overhead and four built-in extension registries — extend pages, AI actions, RPC commands, or archive codecs without patching core files.',
      'arch.selfTitle': 'Built In-House',
      'arch.s1': '4-tier adaptive WorkPacer, chunk pause/cancel, traversal guards & single-slot Undo',
      'arch.s2': 'AI_CANCEL_EPOCH + RAII handle table for 0.31 ms cross-thread abort',
      'arch.s3': 'Dual Installer/Portable updater, repo-scoped URL lock & auto-rollback launcher',
      'arch.s4': 'Tools/JSON fallback, anti-hallucination verifier & approval cards',
      'arch.s5': 'Dry-Run / Undo organizer, SQLite FTS5 & Rust indexwalk',
      'arch.ossTitle': 'Open-Source Stack',
      'arch.o1': 'Native WebView2 shell, tray, single-instance lock & IPC Channels',
      'arch.o2': 'WinHTTP TLS, ShellExecuteW, thread priority & SHA-256',
      'arch.o3': 'zip / sevenz-rust2 / lzma-rust2 / flate2(zlib-rs) / bzip2 / tar',
      'arch.o4': 'Rule engine, cache inventory & full-text search (single binary)',
      'arch.o5': 'Not bundled — fetched on demand with double SHA-256 verification',
      'arch.devTitle': 'Start extending & running the full test gate in 3 commands',
      'arch.devSub': '4 extension APIs: <code>App.registerPage</code> · <code>AIRegistry.register</code> · <code>tidy.register_engine_method</code> · Rust <code>ArchiveCodec</code>',
      'arch.copy': 'Copy',
      'arch.copied': 'Copied ✓',
      'dl.eyebrow': 'DOWNLOAD & VERIFY',
      'dl.title': 'Pick your distribution and start in 30 seconds',
      'dl.desc': 'Configs, rules, and undo journals live in <code>%LOCALAPPDATA%\\整理助手数据</code> — preserved across upgrades and reinstalls.',
      'dl.rec': 'Recommended · Daily Use',
      'dl.exeTitle': 'Windows Installer (NSIS x64)',
      'dl.exeDesc': 'Standard installer with Start Menu shortcuts and clean uninstall. Future updates verify SHA-256 and upgrade in one click.',
      'dl.exeBtn': 'Download Installer (.exe)',
      'dl.port': 'Zero-Install · USB Ready',
      'dl.zipTitle': 'Windows Portable (ZIP)',
      'dl.zipDesc': 'Extract to an ASCII folder and run directly. Built-in updater backs up, swaps atomically, and auto-rolls back on error.',
      'dl.zipBtn': 'Download Portable (.zip)',
      'dl.allReleases': 'All Releases on GitHub',
      'dl.thirdParty': 'Third-Party Notices',
      'foot.note': 'MIT Licensed · Local-First · Zero Telemetry · Zero Ads'
    }
  };

  /* ---- Two-state dark mode toggle (per modern-web-guidance dark-mode-toggle) ---- */
  const metaScheme = document.querySelector('meta[name="color-scheme"]');
  const themeBtn = document.getElementById('theme-toggle');

  function osScheme() {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function renderedScheme() {
    const c = metaScheme ? metaScheme.content : 'light dark';
    return (c === 'light' || c === 'dark') ? c : osScheme();
  }
  function applySchemeMeta(val) {
    if (metaScheme) metaScheme.content = (val === 'light' || val === 'dark') ? val : 'light dark';
  }

  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      const target = renderedScheme() === 'dark' ? 'light' : 'dark';
      try {
        if (target === osScheme()) {
          localStorage.removeItem(STORAGE_SCHEME);
          applySchemeMeta('light dark');
        } else {
          localStorage.setItem(STORAGE_SCHEME, target);
          applySchemeMeta(target);
        }
      } catch (e) {
        applySchemeMeta(target);
      }
    });
  }

  window.addEventListener('storage', (ev) => {
    if (ev.key === STORAGE_SCHEME) {
      applySchemeMeta(ev.newValue || 'light dark');
    }
  });

  /* ---- Language switcher (ZH / EN) ---- */
  const langBtn = document.getElementById('lang-toggle');
  const langLabel = document.getElementById('lang-label');
  const aiImg = document.getElementById('img-ai');

  function detectLang() {
    const qs = new URLSearchParams(location.search).get('lang');
    if (qs === 'en' || qs === 'zh') return qs;
    try {
      const stored = localStorage.getItem(STORAGE_LANG);
      if (stored === 'en' || stored === 'zh') return stored;
    } catch (e) {}
    return /^zh/i.test(navigator.language || '') ? 'zh' : 'en';
  }

  let curLang = detectLang();

  function applyLang(lang) {
    curLang = lang === 'en' ? 'en' : 'zh';
    document.documentElement.lang = curLang === 'en' ? 'en' : 'zh-CN';
    const dict = COPY[curLang];
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.dataset.i18n;
      if (!Object.prototype.hasOwnProperty.call(dict, key)) return;
      const val = dict[key];
      if (val.includes('<br>') || val.includes('<code>')) el.innerHTML = val;
      else el.textContent = val;
    });
    if (langLabel) langLabel.textContent = curLang === 'en' ? '中文' : 'EN';
    if (aiImg) {
      aiImg.src = curLang === 'en'
        ? 'assets/screenshots/07-en-ai-ui.png'
        : 'assets/screenshots/01-ai-assistant.png';
    }
    try { localStorage.setItem(STORAGE_LANG, curLang); } catch (e) {}
  }

  applyLang(curLang);
  if (langBtn) {
    langBtn.addEventListener('click', () => applyLang(curLang === 'zh' ? 'en' : 'zh'));
  }

  /* ---- Accessible Showcase Tabs (selection follows focus + beforematch) ---- */
  const tablist = document.querySelector('.stage-tabs');
  const tabs = tablist ? Array.from(tablist.querySelectorAll('[role="tab"]')) : [];
  const panels = tabs.map((t) => document.getElementById(t.dataset.panel)).filter(Boolean);

  function selectTab(nextTab, moveFocus) {
    tabs.forEach((tab) => {
      const on = tab === nextTab;
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      tab.tabIndex = on ? 0 : -1;
      const panel = document.getElementById(tab.dataset.panel);
      if (panel) {
        if (on) {
          panel.removeAttribute('hidden');
          panel.tabIndex = 0;
        } else {
          panel.setAttribute('hidden', 'until-found');
          panel.removeAttribute('tabindex');
        }
      }
    });
    nextTab.scrollIntoView({ block: 'nearest', inline: 'nearest', container: 'nearest' });
    if (moveFocus) nextTab.focus();
  }

  tabs.forEach((tab, idx) => {
    tab.addEventListener('click', () => selectTab(tab, false));
    tab.addEventListener('keydown', (e) => {
      let next = -1;
      if (e.key === 'ArrowRight') next = (idx + 1) % tabs.length;
      else if (e.key === 'ArrowLeft') next = (idx - 1 + tabs.length) % tabs.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = tabs.length - 1;
      if (next >= 0) {
        e.preventDefault();
        selectTab(tabs[next], true);
      }
    });
  });

  panels.forEach((panel) => {
    panel.addEventListener('beforematch', () => {
      const tab = tabs.find((t) => t.dataset.panel === panel.id);
      if (tab) selectTab(tab, false);
    });
  });

  /* ---- Copy Dev Commands ---- */
  const copyBtn = document.getElementById('copy-dev-cmd');
  const cmdEl = document.getElementById('dev-cmd-text');
  if (copyBtn && cmdEl) {
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(cmdEl.textContent || '');
        copyBtn.textContent = COPY[curLang]['arch.copied'];
        setTimeout(() => { copyBtn.textContent = COPY[curLang]['arch.copy']; }, 1800);
      } catch (e) {}
    });
  }

  /* ---- Auto-hydrate latest release metadata from GitHub latest.json (graceful static fallback) ---- */
  function fmtMiB(bytes) {
    const n = Number(bytes) || 0;
    return n > 0 ? (n / (1024 * 1024)).toFixed(1) + ' MB' : '';
  }

  fetch(LATEST_URL, { mode: 'cors' })
    .then((r) => (r.ok ? r.json() : null))
    .then((m) => {
      if (!m || !m.version) return;
      const ver = 'v' + String(m.version).replace(/^v/i, '');
      const setTxt = (id, v) => { const el = document.getElementById(id); if (el && v) el.textContent = v; };
      const setHref = (id, u) => { const el = document.getElementById(id); if (el && u) el.href = u; };

      setTxt('hero-ver-text', ver);
      setTxt('dl-exe-ver', ver);
      setTxt('dl-zip-ver', ver);
      if (m.installer && m.installer.url) {
        const sz = fmtMiB(m.installer.size);
        setHref('hero-dl-installer', m.installer.url);
        setHref('dl-btn-exe', m.installer.url);
        setTxt('hero-exe-size', sz);
        setTxt('dl-exe-name', m.installer.file + (sz ? ' · ' + sz : ''));
      }
      if (m.portable && m.portable.url) {
        const sz = fmtMiB(m.portable.size);
        setHref('hero-dl-portable', m.portable.url);
        setHref('dl-btn-zip', m.portable.url);
        setTxt('hero-zip-size', sz);
        setTxt('dl-zip-name', m.portable.file + (sz ? ' · ' + sz : ''));
      }
      setHref('dl-sha-link', `https://github.com/3347567186/TidyAssistant/releases/download/${ver}/SHA256SUMS.txt`);
    })
    .catch(() => { /* Static fallback for v1.43.15 already rendered */ });
})();
