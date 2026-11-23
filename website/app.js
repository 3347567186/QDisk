/* 轻盘 QDisk Official Website Controller
   - Two-state color-scheme toggle + cross-tab storage sync (dark-mode-toggle)
   - Bilingual ZH/EN switcher synced with URL query & localStorage
   - Accessible keyboard-navigable showcase tabs
   - Interactive ZIP Create / Extract benchmark dataset toggle
   - Bidirectional scroll animation fallback ONLY when CSS Scroll-Driven Animations are unsupported
   - Live release metadata hydration from https://github.com/3347567186/QDisk */

(function () {
  'use strict';

  const REPO_SLUG = '3347567186/QDisk';
  const STORAGE_SCHEME = 'qdisk-site-scheme';
  const STORAGE_LANG = 'qdisk-site-lang';
  const LATEST_URL = `https://github.com/${REPO_SLUG}/releases/latest/download/latest.json`;

  const COPY = {
    zh: {
      brand: '轻盘',
      'nav.showcase': '核心体验',
      'nav.bench': '实测数据',
      'nav.download': '下载获取',
      'nav.get': '立即下载',
      'hero.badge': 'Win10/11 · MIT 开源 · 零广告',
      'hero.title': '零广告、不靠黑盒<br>每一步都能撤回的 <span class="title-accent">Windows 轻盘</span>',
      'hero.sub': '将智能整理、Rust 四档多核压缩、分级安全清理与可审计本地 AI 助手凝进 20.6 MB 原生客户端。高危操作先预演再落盘，全部数据留在本机。',
      'hero.dlExe': '下载安装版',
      'hero.dlZip': '便携免安装版',
      'tabs.ai': 'AI 助手',
      'tabs.org': '智能整理',
      'tabs.arc': '高速压缩',
      'tabs.cache': '安全清理',
      'story.eyebrow': 'CRAFTED FOR CLARITY · 核心体验',
      'story.title': '把四件高频麻烦事，做到透明且零焦虑',
      'story.s1Title': '可审计本地 AI 助手',
      'story.s1Desc': '直连 DeepSeek / OpenAI / Ollama 任意兼容端点。每一次思考原文、工具参数与毫秒耗时完整可查；所有写入与删除均转为四档权限审批卡片，点停止即在底层跨线程直关 WinHTTP 句柄。',
      'story.s1Proof': 'WinHTTP 阻塞真停止中位数 · 路径防粘连双端兜底',
      'story.s2Title': '先预演再落盘的智能整理',
      'story.s2Desc': '扫描即渲染分类预演与跳过原因，底层自动拦截代码仓库、系统目录与下载中临时文件。支持 YAML 自定义规则并一键导入 AI 草稿，每次归档独立留痕、随时一键原路撤回。',
      'story.s2Proof': '1,000 文件全量零损一键撤回 · 整理仅 1.79 s',
      'story.s3Title': 'Rust 多核零广告压缩内核',
      'story.s3Desc': '原生支持 ZIP / 7Z / RAR / TAR / TAR.GZ / BZ2 / XZ 浏览、内置预览与解压创建。按本机核数四档动态调速，支持分块级真暂停、同名并存重命名与单槽原子撤回，硬防 ZIP Slip 与压缩炸弹。',
      'story.s3Proof': '高性能档多核 ZIP 压缩峰值 · 相对节约档提速 14.4×',
      'story.s4Title': '分级安全清理与签名溯源',
      'story.s4Desc': '缓存严格区分为「安全可重建」与「谨慎复核」，绝不误碰聊天记录与个人文档。大文件排行直读 Authenticode 数字签名与发行商，跨盘数据迁移带哈希校验与事务日志，按需提权。',
      'story.s4Proof': '10,001 文件 FTS5 模糊检索中位数 · 68.4 ms 建库',
      'bench.eyebrow': 'REAL BENCHMARKS · 实测而非宣传',
      'bench.title': '每一组数字，都在本机真实跑测取得',
      'bench.desc': 'Ryzen 9 5900HX（8 核 16 线程）· Win11 x64 · NVMe SSD 实机跑测，源码可直接复现。',
      'bench.chartTitle': '压缩内核四档动态性能阶梯',
      'bench.modeCreate': 'ZIP 压缩',
      'bench.modeExtract': 'ZIP 解压',
      'bench.mSaver': '节约 · 1 线程',
      'bench.mBal': '平衡 · 6 线程',
      'bench.mPerf': '高性能 · 10 线程',
      'bench.mHyper': '超线程 · 16 线程',
      'bench.chartNote': '* 64 MB 极短任务下 16 线程建池开销略高于 10 线程；GB 级归档下超线程档位零限速吃满全部逻辑核。',
      'bench.chartNoteExtract': '* 实测同套 64 MB 归档解压吞吐（含系统页缓存）：高性能档实测达 3,844.1 MB/s，较节约档提速 4.5×。',
      'bench.s1Title': '原生 Rust 外壳体积',
      'bench.s1Meta': '零框架前端总源码 2.03 MB · 0 node_modules',
      'bench.s2Title': 'AI 阻塞停止中位数',
      'bench.s2Meta': '跨线程关闭 WinHTTP 句柄，告别超时卡死',
      'bench.s3Title': '万级文件模糊检索',
      'bench.s3Meta': 'Rust indexwalk 68.4 ms 建库（~14.6 万/秒）',
      'bench.s4Title': '自动化测试门禁全绿',
      'bench.s4Meta': 'Python + Rust + JS 三栈验证 · Release 0 警告',
      'dl.eyebrow': 'GET QDISK · 立即获取',
      'dl.title': '选择适合你的版本，30 秒上手',
      'dl.desc': '配置与撤回记录独立保存在 <code>%LOCALAPPDATA%\\整理助手数据</code>，升级重装零损保留。',
      'dl.rec': '推荐 · 日常主力',
      'dl.port': '免安装 · U 盘随身',
      'dl.exeTitle': 'Windows 安装版 (NSIS x64)',
      'dl.exeDesc': '一键标准安装，完整桌面与开始菜单图标、干净卸载，软件内自动核验 SHA-256 静默升级。',
      'dl.exeBtn': '下载安装版 (.exe)',
      'dl.zipTitle': 'Windows 便携版 (Portable ZIP)',
      'dl.zipDesc': '解压至纯英文目录即可运行；内置更新器自动备份旧版并原子替换，异常自动回滚。',
      'dl.zipBtn': '下载便携版 (.zip)',
      'dev.summary': '开发者说明：三层架构、扩展接口与源码构建命令',
      'dev.l1': '零框架 WebView2 前端',
      'dev.l2': 'Rust 原生外壳 (Tauri v2)',
      'dev.l3': '本地引擎 + indexwalk',
      'dev.copy': '复制命令',
      'dev.copied': '已复制',
      'foot.note': 'MIT 开源 · 本地优先、零遥测、零广告'
    },
    en: {
      brand: 'QDisk',
      'nav.showcase': 'Features',
      'nav.bench': 'Benchmarks',
      'nav.download': 'Download',
      'nav.get': 'Download',
      'hero.badge': 'Win10/11 x64 · MIT Open Source · Zero Ads',
      'hero.title': 'Zero ads, zero black boxes.<br>The undoable <span class="title-accent">Windows utility</span>.',
      'hero.sub': 'Dry-Run file organization, a 4-tier multi-core Rust archiver, risk-tiered cleanup, and an auditable local AI assistant in one 20.6 MB native app. Every risky action previews first.',
      'hero.dlExe': 'Download Installer',
      'hero.dlZip': 'Portable ZIP',
      'tabs.ai': 'AI Assistant',
      'tabs.org': 'Organizer',
      'tabs.arc': 'Archiver',
      'tabs.cache': 'Safe Cleaner',
      'story.eyebrow': 'CRAFTED FOR CLARITY',
      'story.title': 'Four daily disk headaches, solved with total transparency',
      'story.s1Title': 'Auditable Local-First AI Assistant',
      'story.s1Desc': 'Connect DeepSeek, OpenAI, or Ollama directly with your own key. Inspect raw reasoning, tool calls, and exact latency; every write becomes a 4-tier approval card, and clicking Stop closes the WinHTTP socket cross-thread.',
      'story.s1Proof': 'Median WinHTTP socket abort · Dual-layer path link hygiene',
      'story.s2Title': 'Dry-Run Organizer with Instant Undo',
      'story.s2Desc': 'Every scan previews destinations and skipped items before touching disk, automatically shielding Git repositories, system folders, and active downloads. Supports custom YAML rules and one-click lossless rollback.',
      'story.s2Proof': 'Full 1,000-file lossless Undo · 1.79 s organize runtime',
      'story.s3Title': 'Multi-Core Ad-Free Rust Archiver',
      'story.s3Desc': 'Native ZIP, 7Z, RAR, TAR, TAR.GZ, BZ2, and XZ browsing, inline preview, extraction, and creation. Scales dynamically across CPU cores with chunk-level pause, rename-on-conflict, single-slot Undo, and ZIP Slip guards.',
      'story.s3Proof': 'Peak multi-core ZIP creation · 14.4× faster than Saver tier',
      'story.s4Title': 'Risk-Tiered Cleanup & Signature Audit',
      'story.s4Desc': 'Cleanly separates rebuildable caches from cautious items so personal chats and documents stay untouched. Inspect Authenticode publishers on large files and run hash-verified cross-drive migrations with on-demand UAC.',
      'story.s4Proof': 'Median FTS5 search across 10,001 files · 68.4 ms indexing',
      'bench.eyebrow': 'REAL BENCHMARKS',
      'bench.title': 'Every figure measured on bare metal',
      'bench.desc': 'Measured on AMD Ryzen 9 5900HX (8C/16T) · Windows 11 x64 · NVMe SSD. Reproducible directly from source.',
      'bench.chartTitle': '4-Tier Adaptive Rust Archive Speed',
      'bench.modeCreate': 'ZIP Create',
      'bench.modeExtract': 'ZIP Extract',
      'bench.mSaver': 'Saver · 1 thread',
      'bench.mBal': 'Balanced · 6 threads',
      'bench.mPerf': 'Performance · 10 threads',
      'bench.mHyper': 'Hyper · 16 threads',
      'bench.chartNote': '* On a short 64 MB burst, 16-thread pool setup trails 10 threads; on multi-GB archives Hyper saturates all logical cores unthrottled.',
      'bench.chartNoteExtract': '* Same 64 MB archive warm-cache extraction throughput: Performance tier reaches 3,844.1 MB/s (4.5× vs. Saver).',
      'bench.s1Title': 'Native Rust Shell Binary',
      'bench.s1Meta': '2.03 MB zero-framework UI · 0 node_modules',
      'bench.s2Title': 'Median AI Socket Abort',
      'bench.s2Meta': 'Cross-thread WinHTTP close, zero 60–300 s hangs',
      'bench.s3Title': '10k-File FTS5 Search',
      'bench.s3Meta': 'Rust indexwalk builds index in 68.4 ms (~146k/s)',
      'bench.s4Title': 'Automated Quality Gate',
      'bench.s4Meta': 'Python + Rust + JS test suites · 0 Release warnings',
      'dl.eyebrow': 'GET QDISK',
      'dl.title': 'Pick your package, up and running in 30 seconds',
      'dl.desc': 'Settings, rules, and undo journals stay safely isolated in <code>%LOCALAPPDATA%\\整理助手数据</code> across upgrades.',
      'dl.rec': 'Recommended · Daily Driver',
      'dl.port': 'Zero-Install · Portable',
      'dl.exeTitle': 'Windows Installer (NSIS x64)',
      'dl.exeDesc': 'Standard one-click installer with full icons, clean uninstall, and built-in SHA-256 verified updates.',
      'dl.exeBtn': 'Download Installer (.exe)',
      'dl.zipTitle': 'Windows Portable (ZIP)',
      'dl.zipDesc': 'Extract to any ASCII directory and run directly. Built-in updater backs up and rolls back atomically on failure.',
      'dl.zipBtn': 'Download Portable (.zip)',
      'dev.summary': 'For developers: 3-layer architecture, extension hooks & build commands',
      'dev.l1': 'Zero-Framework WebView2 UI',
      'dev.l2': 'Native Rust Shell (Tauri v2)',
      'dev.l3': 'Local Engine + indexwalk',
      'dev.copy': 'Copy',
      'dev.copied': 'Copied',
      'foot.note': 'MIT Licensed · Local-first, zero telemetry, zero ads'
    }
  };

  const BENCH_DATA = {
    create: [
      { val: '21.2 MB/s · 3,025.6 ms', scale: 0.07 },
      { val: '91.9 MB/s · 696.3 ms (4.3×)', scale: 0.302 },
      { val: '304.3 MB/s · 210.3 ms (14.4×)', scale: 1.0 },
      { val: '272.3 MB/s · 235.1 ms (12.8×)', scale: 0.895 }
    ],
    extract: [
      { val: '852.6 MB/s · 75.1 ms', scale: 0.222 },
      { val: '2,998.6 MB/s · 21.3 ms (3.5×)', scale: 0.78 },
      { val: '3,844.1 MB/s · 16.7 ms (4.5×)', scale: 1.0 },
      { val: '2,661.5 MB/s · 24.0 ms (3.1×)', scale: 0.692 }
    ]
  };

  let curLang = 'zh';
  let curBenchMode = 'create';

  /* ---- Two-State Color Scheme Toggle (modern-web-guidance: dark-mode-toggle) ---- */
  const metaScheme = document.querySelector('meta[name="color-scheme"]');
  const themeBtn = document.getElementById('theme-toggle');

  function osScheme() {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function renderedScheme() {
    const c = metaScheme ? metaScheme.content : 'light dark';
    return c === 'light' || c === 'dark' ? c : osScheme();
  }
  function applySchemeMeta(val) {
    if (metaScheme) metaScheme.content = val === 'light' || val === 'dark' ? val : 'light dark';
  }

  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      const target = renderedScheme() === 'dark' ? 'light' : 'dark';
      if (target === osScheme()) {
        try { localStorage.removeItem(STORAGE_SCHEME); } catch (e) {}
        applySchemeMeta('light dark');
      } else {
        try { localStorage.setItem(STORAGE_SCHEME, target); } catch (e) {}
        applySchemeMeta(target);
      }
    });
  }
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_SCHEME) applySchemeMeta(e.newValue);
  });

  /* ---- Bilingual ZH/EN Switcher ---- */
  const langBtn = document.getElementById('lang-toggle');
  const langLabel = document.getElementById('lang-label');
  const aiImg = document.getElementById('img-ai');
  const storyAiImg = document.getElementById('story-img-ai');

  function detectLang() {
    const qs = new URLSearchParams(location.search).get('lang');
    if (qs === 'en' || qs === 'zh') return qs;
    try {
      const stored = localStorage.getItem(STORAGE_LANG);
      if (stored === 'en' || stored === 'zh') return stored;
    } catch (e) {}
    return navigator.language && navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
  }

  function renderBenchMode(mode) {
    curBenchMode = mode === 'extract' ? 'extract' : 'create';
    document.querySelectorAll('[data-bench-mode]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.benchMode === curBenchMode);
    });
    const rows = BENCH_DATA[curBenchMode];
    rows.forEach((r, i) => {
      const vEl = document.getElementById('bm-val-' + i);
      const bEl = document.getElementById('bm-bar-' + i);
      if (vEl) vEl.textContent = r.val;
      if (bEl) bEl.style.setProperty('--scale', String(r.scale));
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
      const val = dict[el.dataset.i18n];
      if (typeof val !== 'string') return;
      if (val.includes('<')) el.innerHTML = val;
      else el.textContent = val;
    });

    if (langLabel) langLabel.textContent = curLang === 'en' ? '中文' : 'EN';
    const aiShot = curLang === 'en' ? 'assets/screenshots/07-en-ai-ui.png' : 'assets/screenshots/01-ai-assistant.png';
    if (aiImg) aiImg.src = aiShot;
    if (storyAiImg) storyAiImg.src = aiShot;

    const winTitle = document.getElementById('win-chrome-title');
    if (winTitle) {
      const ver = (document.getElementById('hero-ver-text')?.textContent || 'v1.43.17').trim();
      winTitle.textContent = curLang === 'en' ? `QDisk ${ver}` : `轻盘 QDisk ${ver}`;
    }
    const activeTab = document.querySelector('.stage-tabs [role="tab"][aria-selected="true"]');
    updateStageCaption(activeTab);
    renderBenchMode(curBenchMode);

    document.title = curLang === 'en'
      ? 'QDisk — Local-First, Zero-Ad, Undoable Windows Disk Utility'
      : '轻盘 QDisk — 本地优先、零广告、可撤回的 Windows 桌面整理工具';
    try { localStorage.setItem(STORAGE_LANG, curLang); } catch (e) {}
  }

  applyLang(detectLang());
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

  /* ---- Benchmark Dataset Switch ---- */
  document.querySelectorAll('[data-bench-mode]').forEach((btn) => {
    btn.addEventListener('click', () => renderBenchMode(btn.dataset.benchMode));
  });

  /* ---- KPI Smooth Count-Up (respects reduced motion) ---- */
  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!prefersReduced && 'IntersectionObserver' in window) {
    const kpiObs = new IntersectionObserver((entries, obs) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const el = entry.target;
        obs.unobserve(el);
        const end = parseFloat(el.dataset.val || '0');
        const dec = parseInt(el.dataset.dec || '1', 10);
        const dur = 640;
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
    }, { threshold: 0.35 });
    document.querySelectorAll('.count-up').forEach((el) => kpiObs.observe(el));
  }

  /* ---- Sticky Header State + Active Section Spy ---- */
  const headerEl = document.getElementById('site-header');
  const progressEl = document.getElementById('scroll-progress');
  const hasNativeScroll = CSS.supports && CSS.supports('(animation-timeline: scroll()) and (animation-range: 0% 100%)');
  const hasNativeView = CSS.supports && CSS.supports('(animation-timeline: view()) and (animation-range: entry)');

  function syncChromeOnScroll() {
    const y = window.scrollY || 0;
    if (headerEl) headerEl.classList.toggle('scrolled', y > 20);
    if (!hasNativeScroll && progressEl) {
      const scrollable = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
      progressEl.style.transform = `scaleX(${Math.min(1, y / scrollable)})`;
    }
  }
  window.addEventListener('scroll', syncChromeOnScroll, { passive: true });
  syncChromeOnScroll();

  if ('IntersectionObserver' in window) {
    const sections = ['showcase', 'benchmarks', 'download']
      .map((id) => document.getElementById(id))
      .filter(Boolean);
    const navLinks = Array.from(document.querySelectorAll('.site-nav [data-section]'));
    const secObs = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const id = entry.target.id;
        navLinks.forEach((a) => a.classList.toggle('is-active', a.dataset.section === id));
      });
    }, { rootMargin: '-32% 0px -56% 0px', threshold: 0 });
    sections.forEach((s) => secObs.observe(s));
  }

  /* ---- Bidirectional Scroll Fallback (ONLY when native CSS Scroll-Driven Animations are unavailable) ---- */
  if (!hasNativeView && !prefersReduced) {
    document.documentElement.classList.add('sda-fallback');
    const heroCopy = document.querySelector('[data-scroll-hero="copy"]');
    const stageFrame = document.getElementById('stage-frame');
    const stories = Array.from(document.querySelectorAll('[data-scroll-story]'));
    const reveals = Array.from(document.querySelectorAll('.scroll-reveal, .scroll-card'));
    const endReveals = Array.from(document.querySelectorAll('.scroll-reveal-end'));

    const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
    const lerp = (a, b, t) => a + (b - a) * t;
    let rafId = 0;

    function coverRatio(rect, vh) {
      return clamp((vh - rect.top) / (vh + rect.height), 0, 1);
    }

    function updateFallbackMotion() {
      rafId = 0;
      const vh = window.innerHeight || 800;
      const y = window.scrollY || 0;

      if (heroCopy) {
        const t = clamp((y - 40) / 480, 0, 1);
        heroCopy.style.transform = `translateY(${(-42 * t).toFixed(1)}px) scale(${lerp(1, 0.96, t).toFixed(4)})`;
        heroCopy.style.opacity = lerp(1, 0.18, t).toFixed(3);
      }
      if (stageFrame) {
        const t = clamp(y / 420, 0, 1);
        stageFrame.style.transform = `rotateX(${lerp(7, 0, t).toFixed(2)}deg) scale(${lerp(0.95, 1, t).toFixed(4)}) translateY(${lerp(18, 0, t).toFixed(1)}px)`;
      }

      stories.forEach((band) => {
        const p = coverRatio(band.getBoundingClientRect(), vh);
        const copy = band.querySelector('.story-copy');
        const vis = band.querySelector('.story-visual');
        const inset = band.querySelector('.media-inset');

        const enterT = clamp(p / 0.28, 0, 1);
        const exitT = clamp((p - 0.74) / 0.26, 0, 1);
        const op = p < 0.28 ? enterT : (p > 0.74 ? lerp(1, 0.25, exitT) : 1);

        if (copy) {
          const cy = p < 0.28 ? lerp(58, 0, enterT) : (p > 0.74 ? lerp(0, -40, exitT) : 0);
          copy.style.opacity = op.toFixed(3);
          copy.style.transform = `translateY(${cy.toFixed(1)}px)`;
        }
        if (vis) {
          const vy = p < 0.3 ? lerp(80, 0, clamp(p / 0.3, 0, 1)) : (p > 0.72 ? lerp(0, -32, clamp((p - 0.72) / 0.28, 0, 1)) : 0);
          const vs = p < 0.3 ? lerp(0.92, 1, clamp(p / 0.3, 0, 1)) : (p > 0.72 ? lerp(1, 0.96, clamp((p - 0.72) / 0.28, 0, 1)) : 1);
          vis.style.opacity = Math.max(0.08, op).toFixed(3);
          vis.style.transform = `translateY(${vy.toFixed(1)}px) scale(${vs.toFixed(4)})`;
        }
        if (inset) {
          inset.style.transform = `translateY(${lerp(42, -30, p).toFixed(1)}px)`;
        }
      });

      reveals.forEach((el) => {
        const p = coverRatio(el.getBoundingClientRect(), vh);
        const enterT = clamp(p / 0.26, 0, 1);
        const exitT = clamp((p - 0.78) / 0.22, 0, 1);
        const op = p < 0.26 ? enterT : (p > 0.78 ? lerp(1, 0.3, exitT) : 1);
        const dy = p < 0.26 ? lerp(42, 0, enterT) : (p > 0.78 ? lerp(0, -24, exitT) : 0);
        const sc = p < 0.26 ? lerp(0.95, 1, enterT) : (p > 0.78 ? lerp(1, 0.97, exitT) : 1);
        el.style.opacity = op.toFixed(3);
        el.style.transform = `translateY(${dy.toFixed(1)}px) scale(${sc.toFixed(4)})`;
      });

      endReveals.forEach((el) => {
        const rect = el.getBoundingClientRect();
        const enterT = clamp((vh - rect.top) / Math.max(220, rect.height * 0.75), 0, 1);
        el.style.opacity = enterT.toFixed(3);
        el.style.transform = `translateY(${lerp(44, 0, enterT).toFixed(1)}px) scale(${lerp(0.96, 1, enterT).toFixed(4)})`;
      });
    }

    const requestTick = () => {
      if (!rafId) rafId = requestAnimationFrame(updateFallbackMotion);
    };
    window.addEventListener('scroll', requestTick, { passive: true });
    window.addEventListener('resize', requestTick, { passive: true });
    updateFallbackMotion();
  }

  /* ---- Copy Dev Commands ---- */
  const copyBtn = document.getElementById('copy-dev-cmd');
  const cmdEl = document.getElementById('dev-cmd-text');
  if (copyBtn && cmdEl) {
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(cmdEl.textContent || '');
        copyBtn.textContent = COPY[curLang]['dev.copied'];
        setTimeout(() => { copyBtn.textContent = COPY[curLang]['dev.copy']; }, 1800);
      } catch (e) {}
    });
  }

  /* ---- Auto-Hydrate Latest Release Metadata from GitHub latest.json ---- */
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
      setTxt('win-chrome-title', curLang === 'en' ? `QDisk ${ver}` : `轻盘 QDisk ${ver}`);
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
      setHref('dl-sha-link', `https://github.com/${REPO_SLUG}/releases/download/${ver}/SHA256SUMS.txt`);
    })
    .catch(() => { /* Static v1.43.17 fallback already rendered */ });
})();
