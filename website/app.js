(function () {
  'use strict';

  const STORAGE_SCHEME = 'ta-site-scheme';
  const STORAGE_LANG = 'ta-site-lang';
  const LATEST_URL = 'https://github.com/3347567186/TidyAssistant/releases/latest/download/latest.json';

  const COPY = {
    zh: {
      brand: '轻盘',
      'nav.bench': '实测数据',
      'nav.play': '交互体验',
      'nav.features': '核心亮点',
      'nav.arch': '自研与开发',
      'nav.download': '下载安装',
      'nav.get': '立即下载',
      'hero.badge': 'Windows 10/11 x64 · MIT 开源 · 零广告',
      'hero.title': '不弹广告、不靠黑盒、<br>每一步都能撤回的 <span class="title-accent">Windows 轻盘工具</span>',
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
      'mq.m1': 'WinHTTP 真断连',
      'mq.m2': 'Rust 多核 ZIP 打包',
      'mq.m3': '高性能档热缓存解压',
      'mq.m4': '万级文件 FTS5 检索',
      'mq.m5': '1,000 文件一键撤回',
      'mq.m6': '纯原生零打包前端',
      'mq.m7': '双形态在线更新强制校验',
      'mq.m8': '零广告 · 零遥测 · 开源可审',
      'mq.pause': '暂停滚动',
      'mq.play': '恢复滚动',
      'bench.eyebrow': 'REAL BENCHMARKS · 实测而非宣传',
      'bench.title': '不靠口号，用本机实测数据说话',
      'bench.desc': '以下所有指标均在 AMD Ryzen 9 5900HX（8 核 16 线程）· Windows 11 x64 · NVMe SSD · 轻盘 QDisk 上实机跑测取得，源码仓库可直接复现。',
      'bench.k1Title': 'AI 对话阻塞停止中位数',
      'bench.k1Meta': '5 次挂起 Socket 实测（239–323 µs），跨线程直接关闭 WinHTTP 句柄，告别 60–300s 卡死。',
      'bench.k2Title': 'Rust 多核 ZIP 压缩峰值',
      'bench.k2Meta': '64 MB 混合集（75% JSON + 25% PNG）实测，相对节约档（21.2 MB/s）提速 14.4 倍。',
      'bench.k3Title': '10,001 文件 FTS5 检索中位数',
      'bench.k3Meta': 'Rust indexwalk 建库仅 68.4 ms（约 14.6 万文件/秒），30 次检索 P95 仅 7.23 ms。',
      'bench.k4Title': '1,000 文件全量一键撤回',
      'bench.k4Meta': '扫描预演 306.5 ms · 整理移动 1.79 s · 一键撤回 1,000/1,000 零损还原。',
      'bench.chartTitle': '压缩内核四档动态性能阶梯实测（64 MB 混合集）',
      'bench.modeCreate': 'ZIP 压缩',
      'bench.modeExtract': 'ZIP 解压',
      'bench.mSaver': '节约 · 1 线程 · 35%/25% 占空',
      'bench.mBal': '平衡 · 6 线程 · 65%/50% 占空',
      'bench.mPerf': '高性能 · 10 线程 · 85%/75% 占空',
      'bench.mHyper': '超线程 · 16 线程 · 100% 满核零限速',
      'bench.chartNote': '* 注：64 MB 极短任务下 16 线程建池开销略高于 10 线程；GB 级大文件场景下超线程档位零限速吃满全部逻辑核心。点击右上角可切换查看同集解压实测。',
      'bench.chartNoteExtract': '* 注：同 64 MB 混合集（含 Windows 页缓存）实测解压吞吐，高性能档达 3,844.1 MB/s（4.5× 节约档），支持分块级真暂停与单槽原子撤回。',
      'bench.tableTitle': '工程体积、响应与测试门禁实测',
      'bench.r1': '原生外壳体积 (tidy-assistant.exe)',
      'bench.r2': '安装包 / 便携包体积',
      'bench.r3': '零框架前端源码（0 node_modules）',
      'bench.r4': '本地引擎冷启动 / 热态 RPC 往返',
      'bench.r5': '1,000 文件扫描预演 / 整理 / 撤回',
      'bench.r6': '10,001 文件索引建库 / 检索中位数',
      'bench.r7': 'Python / Rust / JS 自动化测试门禁',
      'play.eyebrow': 'INTERACTIVE SANDBOX · 亲手试一试',
      'play.title': '把安全闸门、0.31 ms 瞬停与路径洁净，先在这里点一遍',
      'play.desc': '无需下载即可体验轻盘 QDisk 最核心的三项工程护栏：四档 AI 权限闸门、跨线程 WinHTTP 秒级断连，以及 v1.43.16 全新升级的中文粘连路径精准识别。',
      'play.gTitle': '四档可控权限闸门模拟',
      'play.mRead': '只读',
      'play.mConfirm': '确认',
      'play.mAuto': '自动',
      'play.mFull': '放手',
      'play.opMove': '可撤回整理 / 移动',
      'play.opTrash': '移入回收站清理',
      'play.opPerm': '不可逆删除 / 卸载',
      'play.sTitle': '0.31 ms 真停止 + 路径防汉字粘连',
      'play.btnRun': '模拟阻塞推理',
      'play.btnStop': '立即停止',
      'play.pathLabel': 'v1.43.16 路径切分实效（粘连汉字自动剥离，绝不丢失正文与目标）：',
      'feat.eyebrow': 'FOUR CORE PILLARS · 只讲硬核重点',
      'feat.title': '把最常用的四件麻烦事，做到零焦虑',
      'feat.p1Title': '可审计本地 AI 助手：透明查证 + 0.31ms 真停止',
      'feat.p1Desc': '自带密钥直连 DeepSeek / OpenAI / Ollama 等任意兼容端点。每一步推理原文、本地工具调用与毫秒耗时全部展开可查；体积、路径自动同源核对且智能切分粘连汉字；所有写/删动作走四档权限审批卡片，点停止 0.31ms 底层断连不烧 Token。',
      'feat.p1L1': '只读 / 确认 / 自动 / 放手四档可控权限',
      'feat.p1L2': '双端路径防汉字粘连 + 真实磁盘存在性兜底',
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
      'arch.l1t': '零框架前端 (WebView2)',
      'arch.l1m': '2.03 MB 原生 JS/CSS · 0 node_modules · App.registerPage',
      'arch.l2t': 'Rust 原生外壳 (Tauri v2)',
      'arch.l2m': '5.56 MB · 多核压缩 / WinHTTP 0.31ms 断连 / 更新器',
      'arch.l3t': '本地引擎 + indexwalk',
      'arch.l3m': 'Dry-Run / Undo / SQLite FTS5 / 146k 文件/秒遍历',
      'arch.selfTitle': '核心自研模块',
      'arch.s1': '4 档动态 WorkPacer、分块暂停取消、防逃逸与单槽撤回',
      'arch.s2': 'AI_CANCEL_EPOCH + RAII 句柄表，0.31ms 跨线程中止',
      'arch.s3': 'installer / portable 双形态、仓库锁仓与失败自动回滚',
      'arch.s4': 'Tools/JSON 自动降级、路径防粘连与四档审批提案卡',
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
      'dl.title': '选择适合你的轻盘 QDisk，30 秒上手',
      'dl.desc': '全部配置、整理规则与撤回记录独立保存在 <code>%LOCALAPPDATA%\\整理助手数据</code>，从旧版升级或重装永不覆盖个人数据。',
      'dl.rec': '推荐 · 日常主力',
      'dl.exeTitle': 'Windows 安装版 (NSIS x64)',
      'dl.exeDesc': '标准一键安装，配备全新轻盘 QDisk 高清图标、开始菜单快捷方式与干净卸载；后续在设置页一键校验 SHA-256 升级。',
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
      brand: 'QDisk',
      'nav.bench': 'Benchmarks',
      'nav.play': 'Playground',
      'nav.features': 'Highlights',
      'nav.arch': 'Architecture',
      'nav.download': 'Download',
      'nav.get': 'Download',
      'hero.badge': 'Windows 10/11 x64 · MIT Open Source · Zero Ads',
      'hero.title': 'Ad-free, local-first Windows utility<br>with <span class="title-accent">Dry-Run &amp; Undo</span> on every step.',
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
      'mq.m1': 'WinHTTP Instant Abort',
      'mq.m2': 'Multi-Core Rust ZIP',
      'mq.m3': 'Warm-Cache ZIP Extract',
      'mq.m4': 'FTS5 Lookup (10k Files)',
      'mq.m5': '1,000-File One-Click Undo',
      'mq.m6': 'Zero-Bundler Frontend',
      'mq.m7': 'SHA-256 Verified Updater',
      'mq.m8': 'Zero Ads · Zero Telemetry',
      'mq.pause': 'Pause',
      'mq.play': 'Play',
      'bench.eyebrow': 'REAL BENCHMARKS · MEASURED, NOT ESTIMATED',
      'bench.title': 'Measured on real hardware, reproducible from source',
      'bench.desc': 'Every metric below was measured on AMD Ryzen 9 5900HX (8C/16T) · Windows 11 x64 · NVMe SSD running QDisk.',
      'bench.k1Title': 'Median AI Stop Latency',
      'bench.k1Meta': '5 trials aborting a stalled WinHttpReceiveResponse socket (239–323 µs) via cross-thread handle close vs 60–300s hangs.',
      'bench.k2Title': 'Peak Multi-Core ZIP Create',
      'bench.k2Meta': '64 MB mixed workload (75% JSON + 25% PNG) — 14.4× faster than Saver tier (21.2 MB/s).',
      'bench.k3Title': 'FTS5 Search over 10,001 Files',
      'bench.k3Meta': 'Rust indexwalk builds the index in 68.4 ms (~146k files/s); P95 query latency across 30 runs is 7.23 ms.',
      'bench.k4Title': 'Full Undo of 1,000 Moved Files',
      'bench.k4Meta': '306.5 ms Dry-Run scan · 1.79 s organize · 1.39 s lossless 1,000/1,000 one-click restore.',
      'bench.chartTitle': '4-Tier Adaptive Archive Throughput (64 MB Mixed Set)',
      'bench.modeCreate': 'ZIP Create',
      'bench.modeExtract': 'ZIP Extract',
      'bench.mSaver': 'Saver · 1 thread · 35%/25% duty',
      'bench.mBal': 'Balanced · 6 threads · 65%/50% duty',
      'bench.mPerf': 'Performance · 10 threads · 85%/75% duty',
      'bench.mHyper': 'Hyper · 16 threads · 100% unthrottled',
      'bench.chartNote': '* On a tiny 64 MB burst, 16-thread pool init slightly trails 10 threads; on multi-GB archives Hyper saturates all cores unthrottled. Toggle Extract above to inspect warm-cache speeds.',
      'bench.chartNoteExtract': '* Same 64 MB mixed dataset (warm Windows page cache): Performance reaches 3,844.1 MB/s (4.5× Saver) with chunk-level pause and single-slot atomic Undo.',
      'bench.tableTitle': 'Footprint, Latency & Quality Gate',
      'bench.r1': 'Native Shell Binary (tidy-assistant.exe)',
      'bench.r2': 'NSIS Installer / Portable ZIP',
      'bench.r3': 'Zero-Framework Frontend (0 node_modules)',
      'bench.r4': 'Engine Cold Boot / Warm RPC Roundtrip',
      'bench.r5': '1,000-File Dry-Run / Move / Undo',
      'bench.r6': '10,001-File Index Build / Median Query',
      'bench.r7': 'Python / Rust / JS Automated Gate',
      'play.eyebrow': 'INTERACTIVE SANDBOX · TRY IT LIVE',
      'play.title': 'Test the 4-tier gate, 0.31 ms stop & path hygiene right here',
      'play.desc': 'Preview QDisk’s three signature safety guardrails without installing anything: interactive AI permissions, cross-thread WinHTTP abort, and v1.43.16 glued-CJK path hygiene.',
      'play.gTitle': '4-Tier AI Permission Gate Simulator',
      'play.mRead': 'Read-only',
      'play.mConfirm': 'Confirm',
      'play.mAuto': 'Auto',
      'play.mFull': 'Full Auto',
      'play.opMove': 'Reversible organize / move',
      'play.opTrash': 'Recycle Bin cleanup',
      'play.opPerm': 'Irreversible delete / uninstall',
      'play.sTitle': '0.31 ms Native Stop + Path Link Hygiene',
      'play.btnRun': 'Simulate Stall',
      'play.btnStop': 'Stop Now',
      'play.pathLabel': 'v1.43.16 glued-CJK path splitting (zero broken targets, zero dropped prose):',
      'feat.eyebrow': 'FOUR CORE PILLARS · FOCUSED ON WHAT MATTERS',
      'feat.title': 'Four everyday headaches, engineered for zero fear',
      'feat.p1Title': 'Auditable Local AI Assistant: Verified Tools + 0.31 ms Stop',
      'feat.p1Desc': 'Bring your own OpenAI-compatible API key or local Ollama. Expandable reasoning and tool latency logs, anti-hallucination size/path cross-checks with glued-CJK path splitting, 4-tier approval cards, and 0.31 ms WinHTTP abort.',
      'feat.p1L1': '4 permission tiers: Read-only / Confirm / Auto / Full Auto',
      'feat.p1L2': 'Dual-layer path hygiene + disk-verified fallback',
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
      'arch.l1t': 'Zero-Framework UI (WebView2)',
      'arch.l1m': '2.03 MB native JS/CSS · 0 node_modules · App.registerPage',
      'arch.l2t': 'Rust Native Shell (Tauri v2)',
      'arch.l2m': '5.56 MB · Multi-core archive / 0.31ms abort / Updater',
      'arch.l3t': 'Local Engine + indexwalk',
      'arch.l3m': 'Dry-Run / Undo / SQLite FTS5 / 146k files/s walker',
      'arch.selfTitle': 'Built In-House',
      'arch.s1': '4-tier adaptive WorkPacer, chunk pause/cancel, traversal guards & single-slot Undo',
      'arch.s2': 'AI_CANCEL_EPOCH + RAII handle table for 0.31 ms cross-thread abort',
      'arch.s3': 'Dual Installer/Portable updater, repo-scoped URL lock & auto-rollback launcher',
      'arch.s4': 'Tools/JSON fallback, glued-CJK path guard & 4-tier approval cards',
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
      'dl.title': 'Pick your QDisk distribution and start in 30 seconds',
      'dl.desc': 'Configs, rules, and undo journals live in <code>%LOCALAPPDATA%\\整理助手数据</code> — preserved across upgrades and reinstalls.',
      'dl.rec': 'Recommended · Daily Use',
      'dl.exeTitle': 'Windows Installer (NSIS x64)',
      'dl.exeDesc': 'Standard installer with the new QDisk squircle icon, Start Menu shortcuts, and clean uninstall. Future updates verify SHA-256 in one click.',
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

  const BENCH_DATA = {
    create: [
      { val: '21.2 MB/s · 3,025.6 ms', scale: 0.07 },
      { val: '91.9 MB/s · 696.3 ms (4.3×)', scale: 0.302 },
      { val: '304.3 MB/s · 210.3 ms (14.4×)', scale: 1 },
      { val: '272.3 MB/s · 235.1 ms (12.8×)', scale: 0.895 }
    ],
    extract: [
      { val: '852.6 MB/s · 75.1 ms', scale: 0.222 },
      { val: '2,998.6 MB/s · 21.3 ms (3.5×)', scale: 0.78 },
      { val: '3,844.1 MB/s · 16.7 ms (4.5×)', scale: 1 },
      { val: '2,661.5 MB/s · 24.1 ms (3.1×)', scale: 0.692 }
    ]
  };

  const GATE_MODES = {
    readonly: {
      zh: {
        badge: '绝对只读',
        rule: '写工具已移除 · 零落盘风险',
        desc: '只保留扫描、统计与只读排查工具。AI 可以帮你找出 C 盘占用与安全清理清单，但底层物理上不存在任何能改动文件的写入通道。',
        move: '物理禁用', trash: '物理禁用', perm: '物理禁用'
      },
      en: {
        badge: 'Strictly Read-Only',
        rule: 'Write tools removed · Zero disk mutations',
        desc: 'Only scan, audit, and read-only tools are exposed. AI diagnoses disk usage and builds plans with zero write channels available.',
        move: 'Disabled', trash: 'Disabled', perm: 'Disabled'
      }
    },
    confirm: {
      zh: {
        badge: '需人工确认（默认）',
        rule: 'propose_action → 审批提案卡片',
        desc: 'AI 提出清理 C:\\Windows\\Temp（1.42 GB）时，先渲染只读预演与目标明细，必须由你亲手点击「确认执行」才真正落盘。',
        move: '审批卡片', trash: '审批卡片', perm: '强制手点'
      },
      en: {
        badge: 'Confirm Every Write (Default)',
        rule: 'propose_action → Approval card',
        desc: 'When AI proposes cleaning C:\\Windows\\Temp (1.42 GB), it renders a Dry-Run preview card and waits for your explicit click.',
        move: 'Approval card', trash: 'Approval card', perm: 'Explicit click'
      }
    },
    auto: {
      zh: {
        badge: '可撤回自动执行',
        rule: '可撤回动作 3 秒倒计时 · 随时中止',
        desc: '带完整 Undo 清单的目录整理/归类会在 3 秒缓冲后自动执行，全程可一键撤回；涉及回收站删除与卸载仍强制走审批卡片。',
        move: '3s 缓冲自动', trash: '审批卡片', perm: '强制手点'
      },
      en: {
        badge: 'Auto Reversible Moves',
        rule: '3s cancel window · Full Undo journal',
        desc: 'Reversible file organization executes after a 3-second cancel countdown with full Undo logs; deletions and uninstalls still ask first.',
        move: 'Auto (3s cancel)', trash: 'Approval card', perm: 'Explicit click'
      }
    },
    full: {
      zh: {
        badge: '放手模式（守住不可逆底线）',
        rule: '回收站级自动 · 永久删/卸载仍锁死',
        desc: '可撤回整理与可恢复的回收站级清理自动放行，提高批量治理效率；但永久删除与程序卸载依然硬性要求你亲自确认。',
        move: '自动执行', trash: '自动（进回收站）', perm: '仍强制手点'
      },
      en: {
        badge: 'Full Auto (Irreversible Guarded)',
        rule: 'Recycle Bin auto · Permanent ops locked',
        desc: 'Reversible moves and recoverable Recycle Bin cleanups run automatically; irreversible deletes and uninstalls still require manual confirmation.',
        move: 'Auto', trash: 'Auto (Recycle Bin)', perm: 'Still locked'
      }
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
  let curGate = 'confirm';
  let curBenchMode = 'create';
  let marqueePaused = false;

  function renderGate() {
    const cfg = (GATE_MODES[curGate] || GATE_MODES.confirm)[curLang];
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('gate-badge', cfg.badge);
    set('gate-rule', cfg.rule);
    set('gate-desc', cfg.desc);
    set('gm-move', cfg.move);
    set('gm-trash', cfg.trash);
    set('gm-perm', cfg.perm);
  }

  function renderBenchMode(mode) {
    curBenchMode = mode === 'extract' ? 'extract' : 'create';
    document.querySelectorAll('[data-bench-mode]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.benchMode === curBenchMode);
    });
    const rows = BENCH_DATA[curBenchMode];
    rows.forEach((row, i) => {
      const vEl = document.getElementById('bm-val-' + i);
      const bEl = document.getElementById('bm-bar-' + i);
      if (vEl) vEl.textContent = row.val;
      if (bEl) bEl.style.setProperty('--scale', String(row.scale));
    });
    const note = document.getElementById('bench-mode-note');
    if (note) {
      note.textContent = COPY[curLang][curBenchMode === 'extract' ? 'bench.chartNoteExtract' : 'bench.chartNote'];
    }
  }

  function updateStageCaption(tab) {
    const cap = document.getElementById('stage-caption');
    if (!cap || !tab) return;
    cap.textContent = curLang === 'en' ? (tab.dataset.capEn || '') : (tab.dataset.capZh || '');
  }

  function applyLang(lang) {
    curLang = lang === 'en' ? 'en' : 'zh';
    document.documentElement.lang = curLang === 'en' ? 'en' : 'zh-CN';
    const dict = COPY[curLang];
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.dataset.i18n;
      if (!Object.prototype.hasOwnProperty.call(dict, key)) return;
      const val = dict[key];
      if (val.includes('<br>') || val.includes('<code>') || val.includes('<span')) el.innerHTML = val;
      else el.textContent = val;
    });
    if (langLabel) langLabel.textContent = curLang === 'en' ? '中文' : 'EN';
    if (aiImg) {
      aiImg.src = curLang === 'en'
        ? 'assets/screenshots/07-en-ai-ui.png'
        : 'assets/screenshots/01-ai-assistant.png';
    }
    const mqBtn = document.getElementById('marquee-toggle');
    if (mqBtn) mqBtn.textContent = dict[marqueePaused ? 'mq.play' : 'mq.pause'];
    const winTitle = document.getElementById('win-chrome-title');
    if (winTitle) {
      const ver = (document.getElementById('hero-ver-text')?.textContent || 'v1.43.16').trim();
      winTitle.textContent = curLang === 'en' ? `QDisk ${ver} — Windows 11 x64` : `轻盘 QDisk ${ver} — Windows 11 x64`;
    }
    const activeTab = document.querySelector('.stage-tabs [role="tab"][aria-selected="true"]');
    updateStageCaption(activeTab);
    renderGate();
    renderBenchMode(curBenchMode);
    try { localStorage.setItem(STORAGE_LANG, curLang); } catch (e) {}
  }

  applyLang(curLang);
  if (langBtn) {
    langBtn.addEventListener('click', () => applyLang(curLang === 'zh' ? 'en' : 'zh'));
  }

  /* ---- Accessible Showcase Tabs ---- */
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
    updateStageCaption(nextTab);
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

  /* ---- Marquee WCAG 2.2.2 Pause / Play Control ---- */
  const mqBtn = document.getElementById('marquee-toggle');
  const mqView = document.getElementById('marquee-viewport');
  if (mqBtn && mqView) {
    mqBtn.addEventListener('click', () => {
      marqueePaused = !marqueePaused;
      mqView.classList.toggle('is-paused', marqueePaused);
      mqBtn.textContent = COPY[curLang][marqueePaused ? 'mq.play' : 'mq.pause'];
    });
  }

  /* ---- Benchmark Mode Switcher (Create vs Extract) ---- */
  document.querySelectorAll('[data-bench-mode]').forEach((btn) => {
    btn.addEventListener('click', () => renderBenchMode(btn.dataset.benchMode));
  });

  /* ---- Interactive Permission Gate Simulator ---- */
  document.querySelectorAll('[data-gate]').forEach((btn) => {
    btn.addEventListener('click', () => {
      curGate = btn.dataset.gate;
      document.querySelectorAll('[data-gate]').forEach((b) => b.classList.toggle('active', b === btn));
      renderGate();
    });
  });

  /* ---- Interactive 0.31 ms WinHTTP Abort Simulator ---- */
  const simStart = document.getElementById('sim-start');
  const simStop = document.getElementById('sim-stop');
  const simState = document.getElementById('sim-state');
  const simLog = document.getElementById('sim-log');
  let simTimer = null;
  let simStartTs = 0;
  let simEpoch = 42;

  if (simStart && simStop && simState && simLog) {
    simStart.addEventListener('click', () => {
      if (simTimer) clearInterval(simTimer);
      simEpoch += 1;
      simStartTs = performance.now();
      simStart.disabled = true;
      simStop.disabled = false;
      simState.textContent = curLang === 'en'
        ? 'Blocked in WinHttpReceiveResponse…'
        : '推理连接挂起中（WinHttpReceiveResponse 阻塞）…';
      const tick = () => {
        const sec = ((performance.now() - simStartTs) / 1000).toFixed(1);
        simLog.innerHTML =
          `<div>$ epoch=${simEpoch} · waiting upstream stream (${sec}s)…</div>` +
          `<div>$ active_handles = [0x00007FF9A1C0] · press Stop to abort</div>`;
      };
      tick();
      simTimer = setInterval(tick, 120);
    });

    simStop.addEventListener('click', () => {
      if (!simTimer) return;
      clearInterval(simTimer);
      simTimer = null;
      const t0 = performance.now();
      simEpoch += 1;
      const elapsed = Math.max(0.24, Math.min(0.39, (performance.now() - t0) + 0.31)).toFixed(2);
      simStart.disabled = false;
      simStop.disabled = true;
      simState.textContent = curLang === 'en'
        ? `Aborted cleanly in ${elapsed} ms`
        : `已瞬间断开 · 底层实测耗时 ${elapsed} ms`;
      simLog.innerHTML =
        `<div><span class="acc-txt">⚡ ai_cancel()</span> → AI_CANCEL_EPOCH=${simEpoch} → WinHttpCloseHandle()</div>` +
        `<div><span class="ok-txt">✓ OK</span> · socket aborted in <strong>${elapsed} ms</strong> · active_handles = 0 (zero leak)</div>`;
    });
  }

  /* ---- Pointer-Tracking Spotlight Glow (compositor-safe, fine pointer only) ---- */
  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const finePointer = window.matchMedia('(pointer: fine)').matches;
  if (!prefersReduced && finePointer) {
    document.querySelectorAll('.spotlight-card').forEach((card) => {
      let raf = 0;
      card.addEventListener('pointermove', (e) => {
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          const r = card.getBoundingClientRect();
          card.style.setProperty('--mx', (e.clientX - r.left).toFixed(1) + 'px');
          card.style.setProperty('--my', (e.clientY - r.top).toFixed(1) + 'px');
        });
      });
    });
  }

  /* ---- KPI Smooth Count-Up (skips animation under reduced motion) ---- */
  if (!prefersReduced && 'IntersectionObserver' in window) {
    const kpiObs = new IntersectionObserver((entries, obs) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const el = entry.target;
        obs.unobserve(el);
        const end = parseFloat(el.dataset.val || '0');
        const dec = parseInt(el.dataset.dec || '1', 10);
        const dur = 680;
        const t0 = performance.now();
        const step = (now) => {
          const p = Math.min(1, (now - t0) / dur);
          const eased = 1 - Math.pow(1 - p, 3);
          el.textContent = (end * eased).toFixed(dec);
          if (p < 1) requestAnimationFrame(step);
          else el.textContent = end.toFixed(dec);
        };
        requestAnimationFrame(step);
      });
    }, { threshold: 0.4 });
    document.querySelectorAll('.count-up').forEach((el) => kpiObs.observe(el));
  }

  /* ---- Scroll Progress Fallback + Floating Quick-Dock + Active Section Spy ---- */
  const progressEl = document.getElementById('scroll-progress');
  const headerEl = document.getElementById('site-header');
  const dockEl = document.getElementById('quick-dock');
  const backTopBtn = document.getElementById('back-to-top');
  const nativeScrollTimeline = CSS.supports && CSS.supports('(animation-timeline: scroll()) and (animation-range: 0% 100%)');

  function onScroll() {
    const y = window.scrollY || 0;
    if (!nativeScrollTimeline && progressEl) {
      const scrollable = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
      progressEl.style.transform = `scaleX(${Math.min(1, y / scrollable)})`;
    }
    if (headerEl) headerEl.classList.toggle('scrolled', y > 24);
    if (dockEl) dockEl.classList.toggle('is-visible', y > 480);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  if (backTopBtn) {
    backTopBtn.addEventListener('click', () => {
      window.scrollTo({ top: 0, behavior: prefersReduced ? 'auto' : 'smooth' });
    });
  }

  if ('IntersectionObserver' in window) {
    const sections = ['benchmarks', 'playground', 'highlights', 'architecture', 'download']
      .map((id) => document.getElementById(id))
      .filter(Boolean);
    const navLinks = Array.from(document.querySelectorAll('[data-section]'));
    const secObs = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const id = entry.target.id;
        navLinks.forEach((a) => a.classList.toggle('is-active', a.dataset.section === id));
      });
    }, { rootMargin: '-35% 0px -55% 0px', threshold: 0 });
    sections.forEach((s) => secObs.observe(s));
  }

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
      setTxt('bench-ver-pill', ver);
      setTxt('dl-exe-ver', ver);
      setTxt('dl-zip-ver', ver);
      setTxt('win-chrome-title', `轻盘 QDisk ${ver} — Windows 11 x64`);
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
    .catch(() => { /* Static fallback for v1.43.16 already rendered */ });
})();
