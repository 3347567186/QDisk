/* 设置页：五个手风琴分组，一屏内完成外观、行为、默认值、定时与维护 */
(function () {
  'use strict';

  const { h, T, icon, section, toast, empty, skeleton, confirm, modal, setActions, busy, withButtonBusy, progressModal } = UI;

  const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  const THEMES = [
    { value: 'light', zh: '浅色', en: 'Light' },
    { value: 'dark', zh: '深色', en: 'Dark' },
    { value: 'system', zh: '跟随系统', en: 'System' }
  ];
  const LANGS = [
    { value: 'zh-CN', zh: '中文', en: '中文' },
    { value: 'en-US', zh: 'English', en: 'English' }
  ];
  const CLOSE_ACTIONS = [
    { value: 'tray', zh: '最小化到托盘', en: 'Minimize to tray' },
    { value: 'quit', zh: '直接退出', en: 'Quit' }
  ];
  const CONFLICTS = [
    { value: 'rename', zh: '重命名', en: 'Rename' },
    { value: 'skip', zh: '跳过', en: 'Skip' },
    { value: 'overwrite', zh: '覆盖', en: 'Overwrite' }
  ];

  const normTheme = (v) => (v === 'dark' || v === 'system' ? v : 'light');
  const normLang = (v) => (v === 'en-US' ? 'en-US' : 'zh-CN');
  const normClose = (v) => (v === 'quit' ? 'quit' : 'tray');
  const errText = UI.errText;
  const js = (e) => (e && e.message ? e.message : String(e));
  /* 窗口大小的短标签：1M / 200K / 131K。模型名旁边只放这一格，不写 token 长串 */
  const ctxLabel = (n) => {
    const v = Math.max(0, Math.round(Number(n) || 0));
    if (!v) return '';
    if (v >= 1048576) return (v / 1048576).toFixed(v % 1048576 ? 1 : 0) + 'M';
    return Math.round(v / 1024) + 'K';
  };

  /* 当前挂载的页面；语言切换时按它重绘 */
  let active = null;
  let guardBound = false;
  let liveJump = null;

  UI.onLangChange(() => {
    if (active && active.root.isConnected) active.paint();
  });

  if (media && media.addEventListener) {
    media.addEventListener('change', () => {
      if (!active || !active.state || active.state.theme !== 'system') return;
      applySystemTheme();
    });
  }

  /* 跟随系统：把偏好记为 system，同时按系统深浅色应用主题 */
  async function applySystemTheme() {
    if (!media) return;
    try {
      await App.setTheme(media.matches ? 'dark' : 'light');
      App.cfg = Object.assign({}, App.cfg || {}, { theme: 'system' });
      await API.configSet({ theme: 'system' });
    } catch (e) {
      /* 主题已在本地应用，持久化失败不打断 */
    }
  }

  window.Pages = window.Pages || {};

  window.Pages.settings = {
    title: ['设置', 'Settings'],
    subtitle: ['外观、默认行为、定时与维护', 'Appearance, defaults, schedule and maintenance'],

    async mount(root) {
      const cfg = App.cfg || {};
      const state = {
        theme: normTheme(cfg.theme),
        lang: normLang(cfg.lang),
        closeAction: normClose(cfg.close_action),
        agentDraft: null,
        autostart: false,
        autostartBusy: false,
        loading: true,
        settings: null,
        original: null,
        settingsError: null,
        saving: false,
        schedule: { enabled: false, time: '03:00', days: 30, cache: true, screenshots: true },
        scheduleExists: false,
        scheduleBusy: false,
        app: null,
        appError: null,
        engine: null,
        engineError: null,
        admin: false,
        mode: (cfg.power_mode || 'balanced'),
        motion: (cfg.motion || 'full'),
        gpu: (cfg.gpu_accel !== false),
        ai: null,
        aiDraft: null,
        aiProv: 'deepseek',
        aiBusy: false,
        aiTesting: false,
        aiTest: null,
        aiModelsBusy: false,
        aiModelsErr: null,
        /* 拉完模型后要自动弹出的清单窗口：paint 里读一次就清掉，
           避免每次重绘都再弹一遍 */
        autoOpenModels: false,
        openModelReport: null,
        /* 清单弹窗的句柄。放在 state 上而不是闭包里：paint() 会把
           secAssistant 整块重建，闭包变量留不住，弹窗就再也关不掉了。 */
        modelModal: null,
        aiKeyShown: false,
        /* 在线更新状态：完全独立，内置官方 GitHub Releases 源，不暴露任何网址输入框 */
        updStatus: null,
        updChannel: 'stable',
        updAutoCheck: true,
        updChecking: false,
        updCheck: (App && App._pendingUpdate) || null,
        updError: null,
        updDownloading: false,
        updCancelling: false,
        updInstalling: false,
        updProg: null,
        updProgDom: null,
        updCheckProg: null,
        updCheckDom: null,
        dataMigrating: false,
        openId: 'appearance'
      };

      /* 右键「粘贴」的落点：设置页里最近聚焦过的那个输入框。
         右键菜单弹出时不抢焦点，所以没有「当前输入框」可问，只能靠 focusin
         记一个最近的；页面重绘后旧节点会失效，用时再判一次 isConnected。
         适用场景就是本页最常见的动作：从服务商控制台复制 Key / 地址 / 模型名。 */
      let lastField = null;
      root.addEventListener('focusin', (e) => {
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && !t.disabled && !t.readOnly) lastField = t;
      });

      function pasteIntoField() {
        const field = lastField && lastField.isConnected ? lastField : null;
        if (!field) {
          toast(T('先点一下要粘贴的输入框', 'Click the field to paste into first'));
          return;
        }
        if (!navigator.clipboard || !navigator.clipboard.readText) {
          field.focus();
          toast(T('请按 Ctrl+V 粘贴', 'Press Ctrl+V to paste'));
          return;
        }
        navigator.clipboard.readText().then((txt) => {
          if (!txt) { field.focus(); return; }
          const start = typeof field.selectionStart === 'number' ? field.selectionStart : field.value.length;
          const end = typeof field.selectionEnd === 'number' ? field.selectionEnd : field.value.length;
          field.setRangeText(txt, start, end, 'end');
          /* 本页输入框都靠 oninput 同步草稿，直接改 value 不触发，得自己派发一次 */
          field.dispatchEvent(new Event('input', { bubbles: true }));
          field.focus();
        }).catch(() => {
          field.focus();
          toast(T('读不到剪贴板，请按 Ctrl+V', 'Clipboard blocked, press Ctrl+V'));
        });
      }

      /* 输入框里的剪切/复制/粘贴：不用 document.execCommand（WebView2 里时灵时不灵，
         而且改值不派发 input）。统一走「读选区 → 改 setRangeText → 补发 input」，
         和 pasteIntoField 同一套动作，本页所有输入框的 oninput 都能收到。 */
      function fieldEdit(field, op) {
        if (!field) return;
        const start = typeof field.selectionStart === 'number' ? field.selectionStart : field.value.length;
        const end = typeof field.selectionEnd === 'number' ? field.selectionEnd : field.value.length;
        const picked = field.value.slice(start, end);
        const write = (txt) => {
          field.setRangeText(txt, start, end, 'end');
          field.dispatchEvent(new Event('input', { bubbles: true }));
          field.focus();
        };
        if (op === 'selectAll') { field.focus(); field.select(); return; }
        if (op === 'copy') {
          if (!picked) return;
          navigator.clipboard.writeText(picked).then(
            () => toast(T('已复制', 'Copied'), 'ok'),
            () => toast(T('复制失败', 'Copy failed'), 'error')
          );
          return;
        }
        if (op === 'cut') {
          if (!picked) return;
          navigator.clipboard.writeText(picked).then(
            () => write(''),
            () => toast(T('复制失败', 'Copy failed'), 'error')
          );
          return;
        }
        if (op === 'paste') pasteIntoField();
      }

      // 设置页右键：数据目录 / 日志目录相关的最常用动作。
      // 页面本身没有列表，所以挂在整页容器上，空白处右键也能用。
      UI.attachMenu(root, (e) => {
        const t = e.target;
        const field = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && !t.disabled && !t.readOnly
          ? t : null;
        /* 输入框内右键给文本编辑那一套：这里的原生菜单只有一个「粘贴」，
           而剪贴板读写在 WebView 里本来就受控，索性自己给全。 */
        if (field) {
          lastField = field;
          const hasSel = field.selectionStart !== field.selectionEnd;
          return [
            { label: T('剪切', 'Cut'), icon: 'scissors', disabled: !hasSel, action: () => fieldEdit(field, 'cut') },
            { label: T('复制', 'Copy'), icon: 'copy', disabled: !hasSel, action: () => fieldEdit(field, 'copy') },
            { label: T('粘贴', 'Paste'), icon: 'paste', action: () => fieldEdit(field, 'paste') },
            { sep: true },
            { label: T('全选', 'Select all'), action: () => fieldEdit(field, 'selectAll') }
          ];
        }
        const dir = state.settings && state.settings.data_dir;
        return [
          {
            label: T('粘贴到输入框', 'Paste into field'),
            icon: 'paste',
            disabled: !(lastField && lastField.isConnected),
            action: pasteIntoField
          },
          { sep: true },
          {
            label: T('复制数据目录', 'Copy data folder'), icon: 'copy', disabled: !dir,
            action: () => {
              navigator.clipboard.writeText(dir).then(
                () => toast(T('已复制', 'Copied'), 'ok'),
                () => toast(T('复制失败', 'Copy failed'), 'error')
              );
            }
          },
          { label: T('在软件内打开数据目录', 'Browse data folder in app'), icon: 'scan', disabled: !dir, action: () => dir && openInApp(dir) },
          { label: T('在系统文件管理器中打开数据目录', 'Open data folder in Explorer'), icon: 'external', disabled: !dir, action: () => dir && reveal(dir) },
          { label: T('在软件内打开日志目录', 'Browse log folder in app'), icon: 'file', action: () => API.appInfo().then((a) => { if (a && a.log_dir) openInApp(a.log_dir); }).catch(() => {}) }
        ];
      });

      const kvRow = (label, value) => [h('dt', { text: label }), h('dd', null, value)];

      function openInApp(path) {
        if (!path) return;
        if (window.AIEntries && typeof window.AIEntries.open === 'function') window.AIEntries.open(path);
        else reveal(path);
      }

      /* 只读路径 + 双入口按钮（优先软件内打开，同时保留系统文件管理器） */
      function pathRow(path, onOpen) {
        return h('div', { class: 'row' },
          h('input', {
            class: 'input grow mono',
            readonly: true,
            spellcheck: 'false',
            value: path || '—',
            title: path || ''
          }),
          h('button', {
            type: 'button',
            class: 'btn ghost sm icon',
            title: T('在软件内打开目录', 'Browse folder in app'),
            'aria-label': T('在软件内打开目录', 'Browse folder in app'),
            disabled: !path,
            onclick: () => (typeof onOpen === 'function' ? onOpen(path) : openInApp(path))
          }, icon('scan', 14)),
          h('button', {
            type: 'button',
            class: 'btn ghost sm icon',
            title: T('在系统文件管理器中打开', 'Open in system file manager'),
            'aria-label': T('在系统文件管理器中打开', 'Open in system file manager'),
            disabled: !path,
            onclick: () => reveal(path)
          }, icon('external', 14))
        );
      }

      /* 一张卡、若干行、行间 0.5px 细线：分组标题只在卡内出现一次，
         不再「每条一块」——那样十几项会散成十几张卡，扫读成本高。
         放在模块作用域：七个区块都用它，塞进某个区块函数里别的区块就够不着。 */
      const setRow = (label, node, desc, tail) => h('div', { class: 'set-row' },
        h('div', { class: 'set-label', text: label }),
        h('div', { class: 'set-body' },
          node,
          desc ? h('div', { class: 'desc', text: desc, title: desc }) : null,
          tail || null)
      );
      const setCap = (text, tail) => h('div', { class: 'set-cap' },
        h('span', { class: 'set-cap-text', text }),
        tail || null);

      /* ---------- 顶层 ---------- */
      function paint() {
        root.textContent = '';
        /* 每次重绘都换一批闭包：旧的开窗函数指向上一份草稿，先清掉，
           免得自动弹窗调到已经不存在的 DOM 上 */
        state.openModelReport = null;
        /* 弹窗挂在 #modal-root，不随 root 重绘消失：不清掉就会留下一层
           指着旧 DOM 的窗口。close 是幂等的，重复调用安全。 */
        const staleModal = state.modelModal;
        state.modelModal = null;
        if (staleModal) { try { staleModal.close(); } catch (e) { /* 已经关了 */ } }
        const holder = h('div', { class: 'stack' });
        holder.appendChild(secAppearance(holder));
        holder.appendChild(secBehavior(holder));
        holder.appendChild(secDefaults(holder));
        holder.appendChild(secPerformance(holder));
        holder.appendChild(secSchedule(holder));
        holder.appendChild(secAssistant(holder));
        holder.appendChild(secUpdater(holder));
        holder.appendChild(secMaintenance(holder));
        root.appendChild(holder);
        /* 刚拉完模型清单：这一帧画完再把弹窗弹出来，否则清单还没进 DOM */
        if (state.autoOpenModels) {
          state.autoOpenModels = false;
          const open = state.openModelReport;
          if (open) setTimeout(open, 0);
        }
      }

      function secAppearance(holder) {
        /* 两行就够：主题一组单选、语言一组单选。原来用 .grid-2 + .field，
           每组各占半屏宽、说明各占一行，读起来像两篇文章。 */
        const body = h('div', { class: 'set-card' },
          setRow(T('主题', 'Theme'),
            h('div', { class: 'row wrap' }, THEMES.map((t) =>
              h('label', { class: 'check' },
                h('input', {
                  type: 'radio',
                  name: 'set-theme',
                  checked: state.theme === t.value,
                  onchange: () => onTheme(t.value)
                }),
                h('span', { text: T(t.zh, t.en) })
              )
            )),
            T('跟随系统会读取 Windows 的深浅色设置', 'System follows the Windows color mode')),
          setRow(T('界面语言', 'Language'),
            h('div', { class: 'row wrap' }, LANGS.map((l) =>
              h('label', { class: 'check' },
                h('input', {
                  type: 'radio',
                  name: 'set-lang',
                  checked: state.lang === l.value,
                  onchange: () => onLang(l.value)
                }),
                h('span', { text: T(l.zh, l.en) })
              )
            )),
            T('切换后界面文案立即更新', 'The interface switches immediately'))
        );
        return section(T('外观与语言', 'Appearance & language'), body, {
          open: state.openId === 'appearance',
          hint: T('主题与语言', 'Theme and language'),
          id: 'appearance',
          accordion: holder,
          onToggle: (open) => { if (open) state.openId = 'appearance'; }
        });
      }

      async function onTheme(value) {
        if (value === state.theme) return;
        state.theme = value;
        try {
          if (value === 'system') await applySystemTheme();
          else await App.setTheme(value);
          if (value !== 'system') {
            App.cfg = Object.assign({}, App.cfg || {}, { theme: value });
            await API.configSet({ theme: value });
          }
          toast(T('外观已更新', 'Appearance updated'), 'ok');
        } catch (e) {
          toast(errText(e), 'error');
        }
        paint();
      }

      async function onLang(value) {
        if (value === state.lang) return;
        state.lang = value;
        try {
          await App.setLang(value);
          toast(T('界面语言已切换', 'Language switched'), 'ok');
        } catch (e) {
          toast(errText(e), 'error');
        }
      }

      function secBehavior(holder) {
        const closeSelect = UI.customSelect({
          options: CLOSE_ACTIONS.map((c) => ({ value: c.value, label: T(c.zh, c.en) })),
          value: state.closeAction,
          title: T('关闭窗口时', 'When closing the window'),
          onChange: (v) => onCloseAction(v)
        });

        const body = h('div', { class: 'stack' },
          h('div', { class: 'set-card' },
            setRow(T('关闭窗口时', 'On close'), closeSelect,
              T('最小化到托盘后可从托盘图标重新打开', 'Reopen it from the tray icon')),
            setRow(T('启动', 'Startup'),
              h('label', { class: 'check' },
                h('input', {
                  type: 'checkbox',
                  checked: state.autostart,
                  disabled: state.autostartBusy,
                  onchange: (e) => onAutostart(e.target.checked)
                }),
                h('span', { text: T('开机自动启动', 'Start with Windows') })
              ),
              T('随 Windows 登录自动运行轻盘', 'Launch QDisk after Windows sign-in')),
            setRow(T('权限', 'Privileges'),
              h('div', { class: 'row wrap' },
                state.admin
                  ? h('span', { class: 'badge ok', text: T('管理员', 'Administrator') })
                  : h('span', { class: 'badge warn', text: T('普通权限', 'Standard user') }),
                h('button', {
                  class: 'btn sm',
                  disabled: state.admin,
                  onclick: onRunAsAdmin
                }, icon('shield', 14), h('span', { text: T('以管理员身份重启', 'Restart as administrator') }))),
              T('整理受保护目录时需要管理员权限', 'Administrator rights are needed for protected folders'))
          ),
          h('div', { class: 'note', text: T('单实例运行：再次启动会激活已打开的窗口，不会产生第二个进程。',
            'Single instance: launching again focuses the open window instead of starting a second process.') })
        );

        return section(T('行为与启动', 'Behavior & startup'), body, {
          open: state.openId === 'behavior',
          hint: T('关闭、自启、权限', 'Close, startup, rights'),
          id: 'behavior',
          accordion: holder,
          onToggle: (open) => { if (open) state.openId = 'behavior'; }
        });
      }

      async function onCloseAction(value) {
        const prev = state.closeAction;
        state.closeAction = value;
        try {
          await API.configSet({ close_action: value });
          App.cfg = Object.assign({}, App.cfg || {}, { close_action: value });
          toast(T('已保存', 'Saved'), 'ok');
        } catch (e) {
          state.closeAction = prev;
          toast(errText(e), 'error');
        }
        paint();
      }

      async function onAutostart(want) {
        state.autostartBusy = true;
        paint();
        try {
          const now = await busy(
            () => API.setAutostart(want),
            want ? T('正在开启开机自启…', 'Enabling autostart…') : T('正在关闭开机自启…', 'Disabling autostart…'),
            'settings'
          );
          if (typeof now === 'boolean') {
            state.autostart = !!now;
            toast(now ? T('已开启开机自启', 'Autostart enabled') : T('已关闭开机自启', 'Autostart disabled'), 'ok');
          } else {
            state.autostart = !want;
          }
        } catch (e) {
          state.autostart = !want;
          toast(errText(e), 'error');
        }
        state.autostartBusy = false;
        paint();
      }

      async function onRunAsAdmin() {
        await busy(async () => {
          await API.runAsAdmin();
        }, T('正在请求管理员权限并重启…', 'Requesting admin rights and restarting…'), 'settings');
      }

      /* ---------- 整理默认值 ---------- */
      function dirtyKeys() {
        const s = state.settings;
        const o = state.original;
        if (!s || !o) return [];
        return ['recursive_depth', 'conflict_policy', 'log_keep_days', 'default_recursive', 'default_content',
          'index_freshness', 'index_max_mb', 'index_rebuild_idle',
          'prune_enabled', 'prune_history_keep', 'prune_thumbs_mb', 'prune_backup_keep']
          .filter((k) => s[k] !== o[k]);
      }

      function secDefaults(holder) {
        let body;
        if (state.loading && !state.settings && !state.settingsError) {
          body = skeleton(5, 'settings');
        } else if (!state.settings) {
          body = h('div', { class: 'stack' },
            empty(T('引擎设置读取失败', 'Could not read engine settings'), state.settingsError || ''),
            h('div', { class: 'toolbar' },
              h('button', { class: 'btn sm', onclick: retrySettings }, icon('refresh', 14), h('span', { text: T('重试', 'Retry') }))
            )
          );
        } else {
          const s = state.settings;
          const depthInput = h('input', {
            class: 'input', type: 'number', min: '1', max: '4', step: '1',
            value: String(s.recursive_depth),
            oninput: (e) => { s.recursive_depth = Number(e.target.value); paintHint(); }
          });
          const keepInput = h('input', {
            class: 'input', type: 'number', min: '1', max: '3650', step: '1',
            value: String(s.log_keep_days),
            oninput: (e) => { s.log_keep_days = Number(e.target.value); paintHint(); }
          });
          const conflictSelect = UI.customSelect({
            options: CONFLICTS.map((c) => ({ value: c.value, label: T(c.zh, c.en) })),
            value: s.conflict_policy,
            title: T('同名冲突', 'Name clashes'),
            onChange: (v) => { s.conflict_policy = v; paintHint(); }
          });

          /* 索引新鲜度：三个档位对应「多久扫一次热目录」。
             用户原话是「最好可以可控不然扫磁盘次数多会伤磁盘」——
             所以这里给的不是一个开关，而是三档明确的扫盘频率。 */
          const freshSel = UI.customSelect({
            options: [
              { value: 'live', label: T('实时（每分钟扫一次热目录）', 'Live (rescan hot folders every minute)') },
              { value: 'check', label: T('按需（每 10 分钟，默认）', 'On demand (every 10 min, default)') },
              { value: 'manual', label: T('只手动（不自动扫盘）', 'Manual only (never scans by itself)') }
            ],
            value: s.index_freshness,
            title: T('索引新鲜度', 'Index freshness'),
            onChange: (v) => { s.index_freshness = v; paintHint(); }
          });

          const capInput = h('input', {
            class: 'input', type: 'number', min: '0', max: '65536', step: '128',
            value: String(s.index_max_mb),
            oninput: (e) => { s.index_max_mb = Number(e.target.value); paintHint(); }
          });

          const idleCb = h('input', {
            type: 'checkbox', checked: !!s.index_rebuild_idle,
            onchange: (e) => { s.index_rebuild_idle = e.target.checked; paintHint(); }
          });

          /* 本地数据保留的四个控件。数字键都允许 0：
             历史留 0 份 = 关掉撤销能力（有人就是不要），缩略图 0 = 不限制，
             备份 0 = 卸载前不留（危险但明确）。语义各异，所以 hint 里写清。 */
          const histKeepInput = h('input', {
            class: 'input', type: 'number', min: '0', max: '10000', step: '10',
            value: String(s.prune_history_keep),
            oninput: (e) => { s.prune_history_keep = Number(e.target.value); paintHint(); }
          });
          const thumbCapInput = h('input', {
            class: 'input', type: 'number', min: '0', max: '65536', step: '64',
            value: String(s.prune_thumbs_mb),
            oninput: (e) => { s.prune_thumbs_mb = Number(e.target.value); paintHint(); }
          });
          const bakKeepInput = h('input', {
            class: 'input', type: 'number', min: '0', max: '1000', step: '1',
            value: String(s.prune_backup_keep),
            oninput: (e) => { s.prune_backup_keep = Number(e.target.value); paintHint(); }
          });
          const pruneEnabledCb = h('input', {
            type: 'checkbox', checked: s.prune_enabled !== false,
            onchange: (e) => { s.prune_enabled = e.target.checked; paintHint(); }
          });
          /* 预演：只报数字不删。真删的入口不放在设置页 ——
             用户要的是「不再长」，不是「再给他一个清理按钮」。 */
          async function previewPrune(ev) {
            const btn = ev && ev.currentTarget;
            const run = async () => {
              try {
                const r = await API.engine('prune.run', { dry_run: true });
                const mb = ((r && r.bytes) || 0) / 1048576;
                const n = (r && r.files) || 0;
                toast(n ? ('现在能清 ' + n + ' 项，约 ' + mb.toFixed(1) + ' MB；这些会在下次启动或整理后自动收掉')
                        : '没有可清的东西，本地数据已经是最新状态');
              } catch (e) {
                toast('预览失败：' + errText(e), 'error');
              }
            };
            if (btn && typeof withButtonBusy === 'function') {
              await withButtonBusy(btn, T('预演中…', 'Previewing…'), run);
            } else {
              await busy(run, T('正在预演本地数据清理…', 'Previewing cleanup…'), 'settings');
            }
          }

          const unifiedDataDir = (state.app && state.app.data_dir) || s.data_dir || '';
          body = h('div', { class: 'stack' },
            h('div', { class: 'set-card' },
              setRow(T('数据目录', 'Data folder'),
                h('div', { class: 'row' },
                  h('input', {
                    class: 'input grow mono', readonly: true, spellcheck: 'false',
                    value: unifiedDataDir || '—', title: unifiedDataDir || ''
                  }),
                  h('button', {
                    type: 'button',
                    class: 'btn ghost sm icon', disabled: !unifiedDataDir,
                    title: T('在软件内打开目录', 'Browse folder in app'), 'aria-label': T('在软件内打开目录', 'Browse folder in app'),
                    onclick: () => openInApp(unifiedDataDir)
                  }, icon('scan', 14)),
                  h('button', {
                    type: 'button',
                    class: 'btn ghost sm icon', disabled: !unifiedDataDir,
                    title: T('在系统文件管理器中打开', 'Open in system file manager'), 'aria-label': T('在系统文件管理器中打开', 'Open in system file manager'),
                    onclick: () => reveal(unifiedDataDir)
                  }, icon('external', 14)),
                  h('button', {
                    class: 'btn sm',
                    disabled: state.dataMigrating,
                    onclick: pickDataDir
                  }, icon('folder', 14),
                    h('span', { text: state.dataMigrating ? T('迁移中…', 'Migrating…') : T('更改并迁移…', 'Change & migrate…') }))
                ),
                T('配置、AI 会话、整理历史与日志统一存放于此；更改后一次性迁移核心数据、在新目录自动重建缓存与索引并自动重启生效',
                  'Unified folder for config, AI chats, history and logs; changing migrates data, rebuilds cache/index in the new folder and restarts automatically')),
              /* 三个短字段并一行，与 AI 区块的「参数」行同一套密度 */
              setRow(T('整理规则', 'Tidy rules'),
                h('div', { class: 'set-tri' },
                  h('div', { class: 'field' },
                    h('label', { text: T('递归深度', 'Recursive depth') }),
                    depthInput),
                  h('div', { class: 'field' },
                    h('label', { text: T('同名冲突', 'Name clashes') }),
                    conflictSelect),
                  h('div', { class: 'field' },
                    h('label', { text: T('日志保留', 'Log retention') }),
                    keepInput)
                ),
                T('递归 1–4 层 · 冲突默认改名 · 日志 1–3650 天', 'Depth 1-4 · clashes rename by default · logs kept 1-3650 days')),
              setRow(T('默认行为', 'Defaults'),
                h('div', { class: 'row wrap' },
                  h('label', { class: 'check' },
                    h('input', {
                      type: 'checkbox', checked: s.default_recursive,
                      onchange: (e) => { s.default_recursive = e.target.checked; paintHint(); }
                    }),
                    h('span', { text: T('默认递归子目录', 'Recurse into subfolders by default') })
                  ),
                  h('label', { class: 'check' },
                    h('input', {
                      type: 'checkbox', checked: s.default_content,
                      onchange: (e) => { s.default_content = e.target.checked; paintHint(); }
                    }),
                    h('span', { text: T('按内容识别文件类型', 'Identify file types by content') })
                  )
                )),
              /* 索引新鲜度三档：不给开关给频率。用户要的是「可控」，
                 一个「自动/手动」的复选框无法表达「多久扫一次」。 */
              setRow(T('索引新鲜度', 'Index freshness'),
                h('div', { class: 'set-tri' },
                  h('div', { class: 'field' },
                    h('label', { text: T('自动扫描', 'Auto scan') }),
                    freshSel),
                  h('div', { class: 'field' },
                    h('label', { text: T('索引上限 (MB)', 'Index cap (MB)') }),
                    capInput),
                  h('div', { class: 'field' },
                    h('label', { text: T('后台维护', 'Background') }),
                    h('label', { class: 'check' },
                      idleCb,
                      h('span', { text: T('空闲时校验并重建', 'Verify and rebuild when idle') })
                    )
                  )
                ),
                h('div', { class: 'row', style: 'gap:8px;align-items:center;margin-top:6px' },
                  h('button', {
                    class: 'btn ghost sm', type: 'button',
                    onclick: async () => {
                      await busy(async (ctrl) => {
                        ctrl && ctrl.setSub(T('正在检查并修复异常索引库…', 'Verifying and rebuilding index databases…'));
                        const r = await API.engine('search.selfcheck', { rebuild: true });
                        const n = (r && r.rebuilt && r.rebuilt.length) || 0;
                        toast(T('自检完成，重建 ' + n + ' 项', 'Selfcheck done, rebuilt ' + n + ' items'), 'ok');
                      }, T('正在自检索引，请稍候…', 'Checking index…'), 'search');
                    }
                  }, icon('shield', 13), h('span', { text: T('索引自检与修复', 'Index selfcheck') })),
                  h('button', {
                    class: 'btn ghost sm', type: 'button',
                    onclick: async () => {
                      await busy(async (ctrl) => {
                        ctrl && ctrl.setSub(T('正在扫描桌面/文档/下载等常用目录…', 'Scanning desktop, documents and downloads…'));
                        await API.engine('search.hot', { force: true });
                        toast(T('热目录已刷新', 'Hot folders refreshed'), 'ok');
                      }, T('正在刷新热目录索引…', 'Refreshing hot index…'), 'search');
                    }
                  }, icon('refresh', 13), h('span', { text: T('刷新热目录', 'Refresh hot folders') }))
                ),
                T('热目录（桌面/文档/下载等）重扫一次约 0.3 秒 · 上限填 0 表示不限制 · 软件自己整理或删除的文件会立即同步，不靠这里的扫描',
                  'Hot folders take about 0.3 s to rescan · 0 means no cap · files the app moves or deletes sync instantly without waiting for a scan')),
              /* 本地数据保留：用户原话是「都做保留最新版数据，不然体积爆炸」。
                 这里不设「目录清理」那样的扫描按钮 —— 它清的是软件自己在数据
                 目录里攒的东西，路径固定、体量小，给一份份数的上限就够了。 */
              setRow(T('本地数据保留', 'Local data retention'),
              h('div', { class: 'set-tri' },
                h('div', { class: 'field' },
                  h('label', { text: T('整理历史', 'History') }),
                  histKeepInput),
                h('div', { class: 'field' },
                  h('label', { text: T('缩略图上限 (MB)', 'Thumbs cap (MB)') }),
                  thumbCapInput),
                h('div', { class: 'field' },
                  h('label', { text: T('卸载备份', 'App backups') }),
                  bakKeepInput)
                ),
              h('div', { class: 'row', style: 'gap:8px;align-items:center' },
                h('label', { class: 'check' },
                  pruneEnabledCb,
                  h('span', { text: T('只保留最新版，不让历史无限增长', 'Keep only the newest, never grow unbounded') })
                ),
                h('button', {
                  class: 'btn ghost sm', type: 'button',
                  onclick: previewPrune
                }, icon('search', 14), h('span', { text: T('清理预演', 'Preview') }))
              )
            )
            ),
            h('div', { class: 'action-bar' },
              h('span', { class: 'small muted', text: T('改动只写入引擎设置，不影响已有文件', 'Changes only affect engine settings') }),
              h('div', { class: 'spacer' }),
              h('button', {
                class: 'btn primary',
                disabled: state.saving || !dirtyKeys().length,
                onclick: saveDefaults
              }, icon('check'), h('span', { text: state.saving ? T('保存中…', 'Saving…') : T('保存', 'Save') }))
            )
          );
        }
        return section(T('整理默认值', 'Tidy defaults'), body, {
          open: state.openId === 'defaults',
          hint: dirtyKeys().length ? T('有未保存的修改', 'Unsaved changes') : T('磁盘与整理策略', 'Disk and tidy policy'),
          id: 'defaults',
          accordion: holder,
          onToggle: (open) => { if (open) state.openId = 'defaults'; }
        });
      }

      /* 性能：运行模式、动画强度与 GPU（都走 App 的运行时开关，改完即生效） */
      function secPerformance(holder) {
        const modes = [
          { id: 'balanced', name: T('均衡', 'Balanced'), desc: T('完整动画；窗口隐藏 2 分钟后释放引擎，内存回落', 'Full motion; frees the engine 2 min after hiding') },
          { id: 'silent', name: T('静默', 'Silent'), desc: T('精简动画；隐藏 20 秒后释放引擎并停止轮询，占用最低', 'Lite motion; frees the engine 20 s after hiding') },
          { id: 'turbo', name: T('高性能', 'Turbo'), desc: T('完整动画；始终保留引擎，切页与扫描最快', 'Full motion; keeps the engine for fastest responses') }
        ];
        const chips = modes.map((m) => h('button', {
          class: 'btn sm' + (state.mode === m.id ? ' primary' : ''),
          onclick: async () => {
            state.mode = m.id;
            await App.setPowerMode(m.id);
            state.motion = (App.cfg && App.cfg.motion) || (m.id === 'silent' ? 'lite' : 'full');
            paint();
          }
        }, h('span', { text: m.name })));

        const motionSel = UI.customSelect({
          options: [
            { value: 'full', label: T('完整', 'Full') },
            { value: 'lite', label: T('精简', 'Lite') },
            { value: 'off', label: T('关闭', 'Off') }
          ],
          value: state.motion,
          className: 'sm',
          title: T('动效强度', 'Motion'),
          onChange: (v) => { state.motion = v; App.setMotion(v); }
        });

        const gpuCb = h('input', {
          type: 'checkbox',
          checked: !!state.gpu,
          onchange: async () => {
            state.gpu = !!gpuCb.checked;
            App.cfg = Object.assign({}, App.cfg || {}, { gpu_accel: state.gpu });
            try { await API.configSet({ gpu_accel: state.gpu }); } catch { /* ignore */ }
            toast(T('GPU 设置已保存，重启软件后生效', 'Saved. Restart the app to apply.'), 'ok');
          }
        });

        const active = modes.find((m) => m.id === state.mode) || modes[0];
        const body = h('div', { class: 'stack' },
          h('div', { class: 'set-card' },
            setRow(T('运行模式', 'Power mode'),
              h('div', { class: 'row wrap' }, ...chips),
              active.desc),
            setRow(T('动画强度', 'Motion'), motionSel,
              T('静默模式自动使用精简动画；「关闭」让所有过渡立即完成', 'Silent uses lite automatically; Off makes every transition instant')),
            setRow(T('GPU 加速', 'GPU'),
              h('label', { class: 'check' }, gpuCb, h('span', { text: T('启用 GPU 加速', 'Use GPU acceleration') })),
              T('关闭可降低显存与内存占用，重启后生效', 'Lower GPU and memory use. Restart to apply.'))
          ),
          h('div', { class: 'desc', text: T('窗口隐藏或最小化后自动进入静默：暂停引擎轮询、按模式释放引擎进程；再次打开会立即恢复', 'Hiding or minimizing enters idle: polling pauses and the engine is released by mode; it resumes instantly when shown again') })
        );

        return section(T('性能', 'Performance'), body, {
          open: state.openId === 'performance',
          hint: T('运行模式与图形', 'Power and graphics'),
          id: 'performance',
          accordion: holder,
          onToggle: (open) => { if (open) state.openId = 'performance'; }
        });
      }

      /* 仅更新当前区块的 hint，避免整页重绘丢失输入焦点 */
      function paintHint() {
        const sec = root.querySelector('[data-section="defaults"]');
        if (!sec) return;
        const hint = sec.querySelector('.section-head .hint');
        if (hint) hint.textContent = dirtyKeys().length ? T('有未保存的修改', 'Unsaved changes') : T('磁盘与整理策略', 'Disk and tidy policy');
        const btn = sec.querySelector('.action-bar .btn.primary');
        if (btn) btn.disabled = state.saving || !dirtyKeys().length;
      }

      async function retrySettings() {
        state.loading = true;
        state.settingsError = null;
        paint();
        await loadSettings();
        state.loading = false;
        paint();
      }

      let activeMigModal = null;

      async function pickDataDir() {
        if (state.dataMigrating) return;
        const curDir = (state.app && state.app.data_dir) || (state.settings && state.settings.data_dir) || '';
        try {
          const dir = await API.pickFolder(curDir || undefined);
          if (!dir) return;
          if (curDir && dir.toLowerCase() === curDir.toLowerCase()) {
            toast(T('新目录与当前数据目录相同', 'Same as the current data folder'), 'info');
            return;
          }
          if (typeof API.dataDirMigratePreview !== 'function' || typeof API.dataDirMigrate !== 'function') {
            toast(T('当前环境不支持统一数据迁移', 'Unified data migration is unavailable here'), 'warn');
            return;
          }
          const preview = await busy(
            () => API.dataDirMigratePreview(dir),
            T('正在校验目标目录与磁盘空间…', 'Validating target folder and disk space…'),
            'migrate'
          );
          if (!preview) return;
          const sizeTxt = fmtSize(preview.totalBytes || 0);
          const freeTxt = preview.freeBytes ? fmtSize(preview.freeBytes) : '';
          const ok = await confirm({
            title: T('统一迁移数据目录并重启', 'Migrate data folder & restart'),
            body: T(
              `原目录：${preview.oldDir}\n新目录：${preview.newDir}\n\n` +
              `将一次性迁移 ${preview.fileCount || 0} 个核心文件（约 ${sizeTxt}，包含配置、AI 会话、整理历史、日志与工具组件）` +
              (freeTxt ? `；目标盘剩余空间 ${freeTxt}。` : '。') +
              '\n\n运行缓存与索引会在重启后于新目录自动重建，全程显示进度并在完成后自动重启软件。继续？',
              `From: ${preview.oldDir}\nTo: ${preview.newDir}\n\n` +
              `Will migrate ${preview.fileCount || 0} core files (${sizeTxt}). Cache and indexes will be rebuilt automatically in the new folder, and the app will restart automatically. Continue?`
            ),
            ok: T('开始迁移并重启', 'Migrate & restart')
          });
          if (!ok) return;

          state.dataMigrating = true;
          paint();
          activeMigModal = progressModal({
            title: T('正在统一迁移数据目录', 'Migrating data folder'),
            initialText: T('正在准备迁移…', 'Preparing migration…'),
            initialSub: T('请勿关闭软件，完成后将自动重启并在新目录重建运行文件', 'Please keep the app open; it will restart automatically when done'),
            kind: 'migrate'
          });
          try {
            const res = await API.dataDirMigrate(dir);
            if (activeMigModal) {
              activeMigModal.update({
                text: T('迁移完成，正在自动重启软件…', 'Migration complete, restarting…'),
                sub: T(`新目录：${(res && res.newDir) || dir}`, `New folder: ${(res && res.newDir) || dir}`),
                percent: 100
              });
            }
          } catch (err) {
            state.dataMigrating = false;
            if (activeMigModal) {
              activeMigModal.setError(errText(err));
              activeMigModal = null;
            }
            toast(errText(err), 'error');
            paint();
          }
        } catch (e) {
          toast(errText(e), 'error');
        }
      }

      async function saveDefaults() {
        const s = state.settings;
        if (!s || state.saving) return;
        const depth = Number(s.recursive_depth);
        if (!Number.isInteger(depth) || depth < 1 || depth > 4) {
          toast(T('递归深度需为 1 到 4 的整数', 'Recursive depth must be an integer from 1 to 4'), 'warn');
          return;
        }
        const keep = Number(s.log_keep_days);
        if (!Number.isInteger(keep) || keep < 1 || keep > 3650) {
          toast(T('日志保留天数需为 1 到 3650 的整数', 'Log retention must be an integer from 1 to 3650'), 'warn');
          return;
        }
        const maxMb = Number(s.index_max_mb);
        /* 0 是合法的「不限制」，但负数和小数不是：超限判断靠它做分母，
           写成 -1 会让 index_quota_ok() 永远返回超限，索引从此再也不刷新。 */
        if (!Number.isInteger(maxMb) || maxMb < 0 || maxMb > 65536) {
          toast(T('索引上限需为 0 到 65536 的整数（0 表示不限制）', 'Index cap must be an integer from 0 to 65536 (0 means no limit)'), 'warn');
          return;
        }
        const patch = {
          recursive_depth: depth,
          conflict_policy: s.conflict_policy,
          log_keep_days: keep,
          default_recursive: !!s.default_recursive,
          default_content: !!s.default_content,
          index_freshness: s.index_freshness,
          index_max_mb: Number(s.index_max_mb),
          index_rebuild_idle: !!s.index_rebuild_idle,
          prune_enabled: s.prune_enabled !== false,
          prune_history_keep: Number(s.prune_history_keep),
          prune_thumbs_mb: Number(s.prune_thumbs_mb),
          prune_backup_keep: Number(s.prune_backup_keep)
        };
        const keys = Object.keys(patch).filter((k) => patch[k] !== state.original[k]);
        if (!keys.length) { toast(T('没有需要保存的更改', 'Nothing to save'), 'info'); return; }

        state.saving = true;
        paint();
        await busy(async (ctrl) => {
          for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            ctrl && ctrl.setProgress(Math.round(((i + 1) / keys.length) * 90));
            await API.engine('settings.set', { key, value: patch[key] });
          }
          await loadSettings();
          ctrl && ctrl.setProgress(100);
          toast(T('设置已保存', 'Settings saved'), 'ok');
        }, T('正在保存设置…', 'Saving settings…'), 'settings');
        state.saving = false;
        paint();
      }

      /* ---------- 定时清理（缓存 + 截图，替代原定时整理） ---------- */
      function secSchedule(holder) {
        const sc = state.schedule;
        const timeInput = h('input', {
          class: 'input', type: 'time', value: sc.time || '03:00',
          oninput: (e) => { sc.time = e.target.value; }
        });
        const daysInput = h('input', {
          class: 'input', type: 'number', min: '1', max: '3650', value: String(sc.days || 30),
          oninput: (e) => { sc.days = Math.max(1, Number(e.target.value) || 30); }
        });
        const cacheCb = h('input', {
          type: 'checkbox', checked: sc.cache !== false,
          onchange: (e) => { sc.cache = e.target.checked; }
        });
        const shotsCb = h('input', {
          type: 'checkbox', checked: sc.screenshots !== false,
          onchange: (e) => { sc.screenshots = e.target.checked; }
        });

        const body = h('div', { class: 'stack' },
          h('div', { class: 'set-card' },
            setRow(T('运行时间', 'Run time'), timeInput,
              T('每天执行一次，使用 Windows 计划任务；关闭应用后也会运行', 'Runs daily through a Windows scheduled task, even when the app is closed')),
            setRow(T('截图保留', 'Screenshots'), daysInput,
              T('只清理早于这个天数的截图；缓存不受影响', 'Only screenshots older than this are removed; cache is unaffected')),
            setRow(T('清理范围', 'What to clean'),
              h('div', { class: 'row wrap' },
                h('label', { class: 'check' }, cacheCb,
                  h('span', { text: T('清理缓存（仅安全项）', 'Clean cache (safe items only)') })),
                h('label', { class: 'check' }, shotsCb,
                  h('span', { text: T('清理截图', 'Clean screenshots') }))
              ),
              T('删除内容会进回收站，可在回收站还原；谨慎/高级项不会被自动清理', 'Removed items go to the Recycle Bin. Caution/advanced items are never auto-cleaned.'))
          ),
          h('div', { class: 'action-bar' },
            h('label', { class: 'check' },
              h('input', {
                type: 'checkbox', checked: !!sc.enabled,
                onchange: (e) => { sc.enabled = e.target.checked; }
              }),
              h('span', { text: T('启用定时清理', 'Enable scheduled clean') })
            ),
            h('span', {
              class: 'badge ' + (state.scheduleExists ? 'ok' : ''),
              text: state.scheduleExists ? T('计划任务已创建', 'Task created') : T('计划任务未创建', 'No task')
            }),
            h('div', { class: 'spacer' }),
            h('button', {
              class: 'btn primary', disabled: state.scheduleBusy,
              onclick: saveSchedule
            }, icon('play', 14), h('span', { text: state.scheduleBusy ? T('应用中…', 'Applying…') : T('立即应用', 'Apply now') }))
          )
        );

        return section(T('定时清理', 'Scheduled clean'), body, {
          open: state.openId === 'schedule',
          hint: state.scheduleExists ? T('已创建', 'Created') : T('未创建', 'Not created'),
          id: 'schedule',
          accordion: holder,
          onToggle: (open) => { if (open) state.openId = 'schedule'; }
        });
      }

      async function saveSchedule() {
        if (state.scheduleBusy) return;
        const sc = state.schedule;
        const time = String(sc.time || '03:00').trim();
        const days = Math.max(1, Number(sc.days) || 30);
        const cache = sc.cache !== false;
        const screenshots = sc.screenshots !== false;
        if (!/^\d{2}:\d{2}$/.test(time)) { toast(T('时间格式应为 HH:MM', 'Use HH:MM for the time'), 'warn'); return; }
        if (sc.enabled && !cache && !screenshots) { toast(T('请至少选择缓存或截图中的一项', 'Pick cache or screenshots first'), 'warn'); return; }

        state.scheduleBusy = true;
        paint();
        await busy(async () => {
          await API.scheduleSet(!!sc.enabled, time, days, cache, screenshots);
          const fresh = await API.scheduleGet().catch(() => null);
          if (fresh) {
            state.scheduleExists = !!fresh.exists;
            state.schedule = {
              enabled: !!fresh.exists,
              time: fresh.time || time,
              days: Number(fresh.days) || days,
              cache: fresh.cache !== false,
              screenshots: fresh.screenshots !== false
            };
          } else {
            state.scheduleExists = !!sc.enabled;
          }
          toast(state.scheduleExists
            ? T('定时清理已启用', 'Scheduled clean enabled')
            : T('定时清理已关闭', 'Scheduled clean disabled'), 'ok');
        }, T('正在配置 Windows 计划任务…', 'Applying Windows scheduled task…'), 'settings');
        state.scheduleBusy = false;
        paint();
      }

      /* ---------- 数据与维护 ---------- */
      /* ---------- AI 助手（模型配置） ---------- */
      function secAssistant(holder) {
        const d = state.aiDraft;
        if (!d) {
          return section(T('AI 助手', 'AI assistant'), skeleton(2), {
            open: state.openId === 'assistant',
            hint: T('读取中', 'Loading'),
            id: 'assistant', accordion: holder,
            onToggle: (open) => { if (open) state.openId = 'assistant'; }
          });
        }

        const prov = state.aiProv || 'deepseek';
        const provSelect = UI.customSelect({
          options: AIStore.PROVIDERS.map((p) => ({ value: p.id, label: T(p.zh, p.id) })),
          value: prov,
          title: T('服务商', 'Provider'),
          onChange: (val) => {
            state.aiProv = val;
            const p = AIStore.PROVIDERS.find((x) => x.id === val);
            if (p && p.id !== 'custom') {
              /* 换厂商就换默认地址与模型。
                 密钥这里有个坑：以前是「一律不动已填的密钥」，
                 结果从智谱切到 DeepSeek，表单里还留着智谱的 Key，
                 点保存就把两个不相干的东西焊在一起了（请求 401 才暴露）。
                 现在的规则是：这家有记过的 Key 就带出来，没有就清空 ——
                 空着至少是「明显还没配」，比「看着像配好了其实不对」好排查。 */
              d.endpoint = p.endpoint; d.model = p.model; state.aiTest = null;
              const mem = AIStore.recallProvider ? AIStore.recallProvider(p.endpoint) : null;
              if (mem) {
                if (mem.key) d.key = mem.key;
                if (mem.model) d.model = mem.model;
              } else {
                d.key = '';
              }
              paint();
            }
          }
        });

        /* 模型池：从 dsh-xdpool 的厂商清单里挑一家，直接把地址与模型名填好。
           只做选择器，不接管请求——请求仍走下面这套端点与 Key。

           这里同时把「这家的 Key」带出来：池子里的 60+ 家厂商，用户往往是
           先看中模型再回头找 Key，来回切几次就得重粘几次。
           有记忆就顺手填上，没有就只清空（不清空的话会拿上一家的 Key 去打新地址）。 */
        function applyPool(p, m) {
          d.endpoint = p.endpoint;
          d.model = m[0];
          /* 厂商不再是内置那几家：切到「自定义」，避免下拉框显示成别人 */
          state.aiProv = 'custom';
          state.aiTest = null;
          if (m[2] && !d.ctxFixed) {
            const w = Math.round(Number(m[2]));
            if (w >= 2000 && w <= 4000000) d.ctxWindow = w;
          }
          /* 同一家如果记过 Key 和上次用的模型，一并带出来 */
          const mem = AIStore.recallProvider ? AIStore.recallProvider(p.endpoint) : null;
          if (mem && mem.key) d.key = mem.key;
          else if (!mem) d.key = '';
          paint();
          /* 已经有 Key：直接落盘，选完就能用；没 Key 则只填表单，提示补 Key 后保存；本地模型无需 Key */
          if (d.key) {
            /* 让弹窗先关完再落盘：立刻重绘会把关闭动画和校验挤在一起 */
            setTimeout(() => { saveAi(); }, 0);
          } else if (p.local) {
            toast(T('已填入 ' + p.name + ' · ' + m[0] + '（本地端点无需 Key，确保本机已运行服务）', 'Filled ' + p.name + ' · ' + m[0] + ' (No key needed; ensure service is running)'), 'ok');
          } else {
            toast(T('已填入 ' + p.name + ' · ' + m[0] + '；填好 Key 再点保存', 'Filled ' + p.name + ' · ' + m[0] + '; add a key, then save'), 'ok');
          }
        }

        function openPool() {
          if (!window.AIPool) {
            toast(T('模型池数据没加载', 'Model pool data is missing'), 'error');
            return;
          }
          let m0 = null;
          let expandedId = '';
          let freeOnly = false;
          const list = h('div', { class: 'pool-list' });
          const meta = h('span', { class: 'small muted' });
          const search = h('input', {
            class: 'input pool-search', spellcheck: 'false',
            placeholder: T('搜厂商、域名或模型名（可搜中文：百炼/智谱/火山）', 'Search provider, host or model (Chinese names work too)'),
            oninput: () => render(search.value),
            onkeydown: (e) => {
              if (e.key === 'Enter') {
                const first = AIPool.find(search.value, { freeOnly })[0];
                if (!first || !first.models.length) return;
                if (first.models.length === 1) { m0.close(); applyPool(first, first.models[0]); }
                else { expandedId = first.id; render(search.value); }
              } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                const btn = list.querySelector('.pool-row');
                if (btn) btn.focus();
              }
            }
          });

          const freeFilterBtn = h('button', {
            class: 'btn sm ghost pool-filter-btn', type: 'button',
            title: T('只看有免费额度或本地的模型厂商', 'Show only providers with free tier or local endpoints'),
            onclick: () => {
              freeOnly = !freeOnly;
              freeFilterBtn.className = 'btn sm ' + (freeOnly ? 'primary' : 'ghost') + ' pool-filter-btn';
              freeFilterBtn.textContent = freeOnly ? T('★ 仅免费/本地', '★ Free/Local') : T('☆ 免费/本地筛选', '☆ Free/Local');
              render(search.value);
            }
          }, T('☆ 免费/本地筛选', '☆ Free/Local'));

          function render(q) {
            const shown = AIPool.find(q, { freeOnly });
            list.textContent = '';
            const freeSuffix = freeOnly ? T('（免费/本地）', ' (Free/Local)') : '';
            meta.textContent = T('匹配 ' + shown.length + ' 家' + freeSuffix, shown.length + ' providers' + freeSuffix);
            if (!shown.length) {
              list.appendChild(h('div', { class: 'pool-empty', text: T('没有匹配的厂商或模型', 'No provider or model matches') }));
              return;
            }
            shown.forEach((p) => {
              const open = p.id === expandedId;
              /* 行本身是按钮语义，但里面还要放「申请 Key」的外链图标；
                 按钮里套按钮是非法结构，所以改成 role=button 的 div。 */
              const pick = () => {
                if (p.models.length === 1) { m0.close(); applyPool(p, p.models[0]); return; }
                expandedId = open ? '' : p.id;
                render(search.value);
              };
              list.appendChild(h('div', {
                class: 'pool-row' + (open ? ' open' : ''), role: 'button', tabindex: '0',
                onclick: pick,
                onkeydown: (e) => {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
                }
              },
                p.zh ? h('span', { class: 'pool-zh', text: p.zh }) : null,
                h('span', { class: 'pool-name', text: p.name }),
                p.free ? h('span', { class: 'pool-tag free', text: T('免费额度', 'Free') }) : null,
                p.local ? h('span', { class: 'pool-tag', text: T('本地', 'Local') }) : null,
                h('span', { class: 'pool-host mono', text: AIPool.hostOf(p.endpoint) }),
                p.keyUrl ? h('button', {
                  class: 'pool-key', type: 'button',
                  title: T('去申请 / 查看这家厂商的 Key', 'Get or view this provider’s API key'),
                  'aria-label': T('去申请 ' + p.name + ' 的 Key', 'Get ' + p.name + ' API key'),
                  onclick: (e) => {
                    e.stopPropagation();
                    API.openPath(p.keyUrl).catch((err) => toast(err && err.message ? err.message : String(err), 'error'));
                  }
                }, icon('external', 13)) : null,
                h('span', { class: 'pool-count', text: String(p.models.length) })
              ));
              if (!open) return;
              list.appendChild(h('div', { class: 'pool-models' },
                p.note ? h('div', { class: 'pool-note', text: p.note }) : null,
                h('div', { class: 'pool-chips' }, ...p.models.map((m) => h('button', {
                  class: 'pool-chip', type: 'button', title: p.endpoint,
                  onclick: () => { m0.close(); applyPool(p, m); }
                }, h('span', { class: 'pool-chip-name', text: m[1] || m[0] }),
                   h('span', { class: 'pool-chip-id mono', text: m[0] }))))
              ));
            });
          }

          m0 = UI.modal({
            title: T('从模型池选择', 'Choose from the model pool'),
            wide: true,
            body: h('div', { class: 'pool' },
              h('div', { class: 'pool-head' }, search, freeFilterBtn, meta),
              list,
              h('div', { class: 'pool-source small muted', text: T(
                '清单收录 ' + AIPool.providers.length + ' 家厂商、' + AIPool.count() + ' 个模型（含 ' + AIPool.freeCount() + ' 家免费/本地源）；首选 OpenRouter 自动路由、智谱免费版或本地 Ollama',
                'Catalog contains ' + AIPool.providers.length + ' providers, ' + AIPool.count() + ' models (' + AIPool.freeCount() + ' free/local); OpenRouter auto-router, Zhipu free tier, or local Ollama recommended') })),
            buttons: [{ id: 'close', label: T('关闭', 'Close') }]
          });
          render('');
          search.focus();
        }

        const poolBtn = h('button', {
          class: 'btn ghost sm pool-btn', type: 'button',
          title: T('从模型池挑厂商和模型', 'Pick a provider and model from the pool'),
          onclick: openPool
        }, icon('layers', 14), h('span', { text: T('模型池', 'Model pool') }));
        const provBox = h('div', { class: 'row pool-pick' }, provSelect, poolBtn);

        const endpointIn = h('input', {
          class: 'input mono', spellcheck: 'false', value: d.endpoint || '',
          placeholder: 'https://api.deepseek.com/v1/chat/completions',
          oninput: (e) => { d.endpoint = e.target.value.trim(); state.aiTest = null; },
          /* 从控制台复制的是 base URL（…/v1）：失焦时补全，免得保存后 404 */
          onblur: (e) => {
            const v = normEndpoint(e.target.value);
            if (v && v !== e.target.value) {
              e.target.value = v;
              d.endpoint = v;
              toast(T('地址已补全 /chat/completions', 'Endpoint completed with /chat/completions'), 'ok');
            }
          }
        });

        const keyIn = h('input', {
          class: 'input mono', spellcheck: 'false', type: state.aiKeyShown ? 'text' : 'password',
          value: d.key || '', placeholder: T('粘贴 API Key', 'Paste API key'),
          oninput: (e) => { d.key = e.target.value.trim(); state.aiTest = null; }
        });

        const modelIn = h('input', {
          class: 'input mono', spellcheck: 'false', value: d.model || '',
          placeholder: 'deepseek-chat',
          oninput: (e) => { d.model = e.target.value.trim(); state.aiTest = null; }
        });

        const modelList = Array.isArray(d.models) ? d.models : [];
        const fetchBtn = h('button', {
          class: 'btn ghost sm',
          type: 'button',
          disabled: state.aiModelsBusy,
          title: T('向接口地址请求 /models，拉回这个 Key 能用的模型', 'Ask the endpoint for /models and list what this key can use'),
          onclick: fetchModels
        }, icon('refresh', 14),
        h('span', { text: state.aiModelsBusy ? T('获取中…', 'Fetching…') : T('获取模型', 'Fetch models') }));

        /* 端点一次报几十个模型时，把整列塞在设置页里会把后面的选项全推到屏外，
           而且那一大块平时根本用不到。改成「一行摘要 + 独立弹窗」：
           摘要只说几个模型、当前选的是哪个；点开才是完整清单。 */
        const modelReport = modelList.length
          ? h('div', { class: 'ai-report' },
            h('button', {
              class: 'ai-report-open', type: 'button',
              title: T('打开端点报告的模型清单', 'Open the model list from the endpoint'),
              onclick: () => openModelReport()
            },
              icon('layers', 14),
              h('span', { class: 'ai-report-text', text: T('端点报告 ' + modelList.length + ' 个可用模型', modelList.length + ' models from the endpoint') }),
              h('span', { class: 'ai-report-cur', text: d.model || '' }),
              h('span', { class: 'ai-report-chev' }, icon('chevron', 12))
            ),
            h('button', {
              class: 'btn ghost sm', type: 'button',
              title: T('清空这份清单', 'Clear this list'),
              onclick: () => { d.models = []; d.modelCtx = {}; state.aiModelsErr = null; paint(); }
            }, h('span', { text: T('清空', 'Clear') }))
          )
          : null;

        /* 清单弹窗：按厂商分组、每组可折叠、顶部可按关键词筛。
           分组是为了把「65 个」切成几段扫读；折叠是为了不看的那几段不占视线。
           选中的模型直接写回草稿，关掉弹窗后设置页已经跟着更新。 */
        function closeModelReport() {
          const m = state.modelModal;
          state.modelModal = null;
          if (m) { try { m.close(); } catch (e) { /* 已经关掉了 */ } }
        }
        function openModelReport() {
          const list = Array.isArray(d.models) ? d.models : [];
          if (!list.length) return;
          const ctxMap = (d.modelCtx && typeof d.modelCtx === 'object') ? d.modelCtx : {};
          let query = '';

          const listBox = h('div', { class: 'ai-report-list' });
          const filterIn = h('input', {
            class: 'input ai-report-filter', type: 'text', spellcheck: 'false',
            placeholder: T('筛选模型…', 'Filter models…'),
            'aria-label': T('筛选模型', 'Filter models'),
            oninput: (e) => { query = e.target.value; renderList(); }
          });

          const FAMILIES = [
            { id: 'gemini', label: 'Gemini / Gemma', re: /gemini|gemma/i },
            { id: 'openai', label: 'OpenAI', re: /(^|\/)gpt-|^o[1-4](?:-|$)|chatgpt/i },
            { id: 'claude', label: 'Claude', re: /claude/i },
            { id: 'deepseek', label: 'DeepSeek', re: /deepseek/i },
            { id: 'qwen', label: 'Qwen / 通义', re: /qwen|tongyi|qwq/i },
            { id: 'glm', label: 'GLM', re: /glm|chatglm/i },
            { id: 'kimi', label: 'Kimi', re: /kimi|moonshot/i },
            { id: 'llama', label: 'Llama / Mistral', re: /llama|mistral|mixtral|phi-|yi-/i }
          ];
          const OTHER = { id: 'other', label: T('其他', 'Other'), re: null };
          function familyOf(id) {
            for (let i = 0; i < FAMILIES.length; i += 1) {
              if (FAMILIES[i].re.test(String(id))) return FAMILIES[i];
            }
            return OTHER;
          }

          function modelRow(id) {
            const w = Number(ctxMap[id] || 0) || AIStore.inferCtx(id) || 0;
            return h('button', {
              class: 'ai-model-item', type: 'button',
              'data-active': id === d.model ? '1' : null,
              title: id,
              onclick: () => {
                d.model = id;
                /* 换模型就跟着换窗口：端点报过就用报的值；没报过就按模型名推断，
                   推断不出才落到 1M 默认。绝不沿用上一个模型的窗口。 */
                d.ctxWindow = w || AIStore.FALLBACK_CTX;
                state.aiTest = null;
                closeModelReport();
                paint();
              }
            }, h('span', { class: 'ai-model-name', text: id }),
              w ? h('span', { class: 'ai-model-ctx', text: ctxLabel(w) }) : null,
              id === d.model ? icon('check', 12) : null);
          }

          function renderList() {
            listBox.textContent = '';
            const q = query.trim().toLowerCase();
            const hit = list.filter((id) => !q || String(id).toLowerCase().indexOf(q) >= 0);
            if (!hit.length) {
              listBox.appendChild(h('div', { class: 'ai-report-miss', text: T('没有匹配的模型', 'No matching model') }));
              return;
            }
            const buckets = new Map();
            hit.forEach((id) => {
              const f = familyOf(id);
              if (!buckets.has(f.id)) buckets.set(f.id, { label: f.label, ids: [] });
              buckets.get(f.id).ids.push(id);
            });
            /* 顺序固定：按 FAMILIES 的次序排，认不出的归到最后 */
            FAMILIES.map((f) => f.id).concat(['other']).forEach((key) => {
              const b = buckets.get(key);
              if (!b) return;
              listBox.appendChild(section(b.label,
                h('div', { class: 'ai-report-group' }, ...b.ids.map(modelRow)), {
                  /* 搜索时全展开（结果本来就不多），没搜时只展开当前模型所在的那组 */
                  open: !!q || b.ids.indexOf(d.model) >= 0,
                  hint: String(b.ids.length)
                }));
            });
          }

          renderList();
          state.modelModal = modal({
            title: T('端点报告 ' + list.length + ' 个可用模型', list.length + ' models from the endpoint'),
            wide: true,
            body: h('div', { class: 'ai-report-body' }, filterIn, listBox),
            buttons: [
              { id: 'clear', label: T('清空清单', 'Clear list'), kind: 'ghost' },
              { id: 'close', label: T('关闭', 'Close'), kind: 'primary' }
            ],
            onAction: (id) => {
              if (id !== 'clear') return;
              d.models = [];
              d.modelCtx = {};
              state.aiModelsErr = null;
              paint();
            },
            onClose: () => { state.modelModal = null; }
          });
        }
        /* fetchModels 在 mount 作用域，拿到最新的打开函数只能走 state 上的钩子 */
        state.openModelReport = openModelReport;

        /* 温度有「自动」这一档：自动 = 按任务决定（查文件 0.1、算数字 0、
           写文案 0.85）。手填才用输入框里的数字。以前这里只有一个数字，
           等于让用户替所有任务选一个风险值——查文件偏发散、写文案偏死板。 */
        const tempAutoCb = h('input', {
          type: 'checkbox', checked: d.tempAuto !== false,
          onchange: (e) => { d.tempAuto = e.target.checked; paint(); }
        });

        const tempIn = h('input', {
          class: 'input', type: 'number', min: '0', max: '2', step: '0.1',
          value: String(d.temperature),
          disabled: d.tempAuto !== false,
          oninput: (e) => { d.temperature = Math.min(2, Math.max(0, Number(e.target.value) || 0)); }
        });

        const enabledCb = h('input', {
          type: 'checkbox', checked: d.enabled !== false,
          onchange: (e) => { d.enabled = e.target.checked; }
        });
        const jsonCb = h('input', {
          type: 'checkbox', checked: d.jsonMode !== false,
          onchange: (e) => { d.jsonMode = e.target.checked; }
        });

        const modelCtxMap = (d.modelCtx && typeof d.modelCtx === 'object') ? d.modelCtx : {};
        const reported = Number(modelCtxMap[d.model] || 0);
        const guessed = AIStore.inferCtx(d.model) || 0;
        const winNow = Number(d.ctxWindow) || guessed || AIStore.FALLBACK_CTX;
        const winSrc = reported
          ? T('端点上报', 'From endpoint')
          : (guessed ? T('按模型名推断', 'Inferred from model') : T('未上报，按默认 1M', 'Not reported; 1M default'));

        const ctxIn = h('input', {
          class: 'input ai-ctx-in', type: 'number', min: '2000', max: '4000000', step: '1024',
          value: String(winNow),
          oninput: (e) => {
            const n = Math.round(Number(e.target.value) || 0);
            if (n >= 2000 && n <= 4000000) d.ctxWindow = n;
          }
        });

        const test = state.aiTest;
        const testBadge = state.aiTesting
          ? h('span', { class: 'badge', text: T('测试中…', 'Testing…') })
          : (test
            ? (test.ok
              ? (test.warn
                ? h('span', { class: 'badge warn', text: T('连通，但格式不合规', 'Connected, format mismatch') })
                : h('span', { class: 'badge ok', text: T('连接正常', 'Connected') + ' · ' + test.ms + ' ms' }))
              : h('span', { class: 'badge warn', text: T('连接失败', 'Failed') }))
            : (AIStore.isConfigured(d)
              ? h('span', { class: 'badge', text: T('已填写，未测试', 'Set, untested') })
              : h('span', { class: 'badge warn', text: T('未配置', 'Not configured') })));

        /* ---- 能动手到什么程度（默认关闭） ---- */
        const pol = state.agentDraft
          || (window.AIProposals ? AIProposals.defaultPolicy() : { mode: 'off', cats: {} });
        const MODE_TIP = {
          off: T('助手只有只读工具，任何能改文件的能力都不发给模型', 'Read-only: nothing that could change files is offered to the model'),
          confirm: T('每个动作先变成一张卡片，你点了「执行」才真的动', 'Every action becomes a card; nothing runs until you click'),
          auto: T('整理、解压这类能撤销的直接执行，卡片上留 3 秒停止', 'Reversible actions run after a 3-second stop window'),
          full: T('连删除到回收站也自动；撤不回来的仍然要你点一下', 'Even recycle-bin deletes run; irreversible ones still need a click')
        };
        const CAT_ZH = { organize: '整理', files: '文件', archive: '压缩包', clean: '清理', apps: '程序', search: '索引', settings: '设置' };

        function saveAgent(patch) {
          const base = state.agentDraft || pol;
          const next = window.AIProposals
            ? AIProposals.normalizePolicy(Object.assign({}, base, patch))
            : Object.assign({}, base, patch);
          state.agentDraft = next;
          /* 这一栏不进「保存」，改一下立刻生效：它是权限开关，不该有「改了没保存」的中间态 */
          Promise.resolve(AIStore.saveUi({ agent: next })).catch((e) => toast(errText(e), 'error'));
          paint();
        }

        const modeBtns = (window.AIProposals ? AIProposals.MODES : ['off', 'confirm', 'auto', 'full']).map((m) => h('button', {
          class: 'ai-mode' + (m === pol.mode ? ' on' : '') + (m !== 'off' ? ' armed' : '') + (m === 'full' ? ' danger' : ''),
          type: 'button',
          'aria-pressed': m === pol.mode ? 'true' : 'false',
          onclick: () => saveAgent({ mode: m })
        }, h('span', { text: { off: T('只读', 'Read-only'), confirm: T('确认', 'Confirm'), auto: T('自动', 'Auto'), full: T('放手', 'Full') }[m] })));

        const catBoxes = (window.AIProposals ? AIProposals.CATS : Object.keys(CAT_ZH)).map((c) => {
          const isChecked = !!(pol.cats && pol.cats[c]);
          const isDisabled = pol.mode === 'off';
          return h('label', {
            class: 'check agent-cat-chip' + (isChecked ? ' is-on' : '') + (isDisabled ? ' is-disabled' : '')
          },
            h('input', {
              type: 'checkbox',
              checked: isChecked,
              disabled: isDisabled,
              onchange: (e) => {
                const cats = Object.assign({}, pol.cats, { [c]: e.target.checked });
                saveAgent({ cats });
              }
            }),
            h('span', { text: CAT_ZH[c] || c }));
        });

        const numIn = (key, lo, hi, def) => h('input', {
          class: 'input', type: 'number', min: String(lo), max: String(hi), value: String(pol[key] || def),
          onchange: (e) => saveAgent({ [key]: Math.max(lo, Math.min(hi, Number(e.target.value) || def)) })
        });

        const agentBadge = h('span', {
          class: 'badge' + (pol.mode === 'off' ? '' : (pol.mode === 'full' ? ' warn' : ' ok')),
          text: pol.mode === 'off' ? T('只读', 'Read-only') : T('已开启', 'Enabled')
        });

        /* 三张卡、两栏摆：左「连接」右「模型」，下面通栏「行为与权限」。
           原来是一条 15 行的长单列，AI 区块自己就超过一屏，滚到下面
           就找不到上面改过的字段。分组依据是「改一处会不会牵连另一处」：
           连接与模型是同一件事的两面，行为与权限是另一件事。 */
        /* 「已记住的厂商」：把 providerKeys 里存过的东西摊开来给用户看。
           为什么要这块界面，而不是让记忆在后台默默生效：
             1. 用户得知道「我上次填的 Key 还在」，否则每次都要怀疑一遍；
             2. 记忆会过期（换机器、注销、Key 被吊销），得能一条条删；
             3. 一键切回去比「记住上一个选的是谁」有用得多 —— 常年在
                两三家之间来回切的用户，这一步能省掉「翻地址、粘贴、保存」。
           故意不显示完整 Key：这块界面会被截图，掩码就够了。 */
        function providerMemoryBox() {
          const rows = (AIStore.listProviders ? AIStore.listProviders() : []);
          if (!rows.length) {
            return h('div', { class: 'small muted', text: T(
              '保存过一次后，这里会记住各家的 Key 与上次用的模型，切回来时自动带出',
              'After the first save, each provider keeps its key and last model here and is restored when you switch back') });
          }
          return h('div', { class: 'stack' }, ...rows.map((it) => {
            const usable = !!it.endpoint;
            return h('div', { class: 'row' },
              h('div', { class: 'stack', style: 'flex:1' },
                h('span', { class: 'mono', text: it.host }),
                h('span', { class: 'small muted', text: (it.model ? it.model + ' · ' : '') + (it.masked || T('无 Key', 'no key')) })),
              h('button', {
                class: 'btn ghost sm', type: 'button',
                disabled: !usable,
                title: usable
                  ? T('切回这一家的地址、模型与 Key', 'Switch back to this provider’s endpoint, model and key')
                  : T('这条只记了模型，没有可用的地址', 'This entry has no endpoint recorded'),
                onclick: () => {
                  if (!usable) return;
                  d.endpoint = it.endpoint;
                  if (it.model) d.model = it.model;
                  if (it.key) d.key = it.key;
                  state.aiProv = 'custom';
                  state.aiTest = null;
                  paint();
                  toast(T('已切回 ' + it.host, 'Switched to ' + it.host), 'ok');
                }
              }, icon('undo', 13), h('span', { text: T('切回', 'Use') })),
              h('button', {
                class: 'btn ghost sm', type: 'button',
                title: T('忘掉这一家的记录', 'Forget this provider'),
                onclick: async () => {
                  try {
                    await AIStore.forgetProvider(it.host);
                    toast(T('已忘掉 ' + it.host, 'Forgot ' + it.host), 'ok');
                    paint();
                  } catch (e) { toast(errText(e), 'error'); }
                }
              }, icon('trash', 13))
            );
          }));
        }

        const cardConn = h('div', { class: 'set-card' },
            setCap(T('连接', 'Connection'), h('span', { class: 'set-cap-tail', text: AIStore.isConfigured(d) ? T('已配置', 'Configured') : T('未配置', 'Not configured') })),
            setRow(T('服务商', 'Provider'), provBox),
            setRow(T('接口地址', 'Endpoint'), endpointIn,
              T('OpenAI 兼容的 /chat/completions 地址；本地 Ollama 可用 127.0.0.1', 'Any OpenAI-compatible /chat/completions URL; local Ollama works too')),
            setRow(T('API Key', 'API key'),
              h('div', { class: 'row' },
                keyIn,
                h('button', {
                  class: 'btn ghost sm', title: state.aiKeyShown ? T('隐藏', 'Hide') : T('显示', 'Show'),
                  onclick: () => { state.aiKeyShown = !state.aiKeyShown; paint(); }
                }, h('span', { text: state.aiKeyShown ? T('隐藏', 'Hide') : T('显示', 'Show') }))
              ),
              T('只保存在本机 app.json，不写日志、不随会话导出；请求直接发往上面这个地址', 'Stored only in local app.json; never logged or exported')),
            setRow(T('已记住的厂商', 'Saved providers'), providerMemoryBox(),
              T('按接口域名记住，切回时自动填好地址、模型和 Key', 'Keyed by endpoint host; switching back restores endpoint, model and key'))
        );

        const cardModel = h('div', { class: 'set-card' },
            setCap(T('模型', 'Model'), h('span', { class: 'set-cap-tail', text: winSrc })),
            setRow(T('模型名', 'Model'),
              h('div', { class: 'row' }, modelIn, fetchBtn),
              T('填接口文档里的模型名，也可以点「获取模型」让端点自己报', 'Type a model name, or let the endpoint list them'),
              h('div', null,
                state.aiModelsErr ? h('div', { class: 'small', style: 'color:var(--danger)', text: state.aiModelsErr }) : null,
                modelReport))
        );
        /* 备用端点：主端点限流/欠费/模型下线时按顺序往后切。
           放在「模型」这张卡里而不是单开一张：它和主模型是同一件事的两级 ——
           「用哪个模型答」的完整答案包含「主的不行时用哪个」。
           上限 5 条，与 store.js normalize 的截断一致，改一处要同时改两处。 */
        const fbList = () => (Array.isArray(d.fallbacks) ? d.fallbacks : []);
        const fbRowOf = (item, idx) => h('div', { class: 'row' },
          h('input', {
            class: 'input mono', spellcheck: 'false', value: item.endpoint || '',
            placeholder: T('备用接口地址', 'Fallback endpoint'),
            'aria-label': T('备用接口地址', 'Fallback endpoint'),
            oninput: (e) => { item.endpoint = e.target.value.trim(); state.aiTest = null; },
            /* 和主地址一样：控制台复制来的是 base URL，失焦补全免得保存后 404 */
            onblur: (e) => {
              const v = normEndpoint(e.target.value);
              if (v && v !== e.target.value) { e.target.value = v; item.endpoint = v; }
            }
          }),
          h('input', {
            class: 'input mono', spellcheck: 'false', value: item.model || '',
            placeholder: T('模型名', 'Model'),
            'aria-label': T('备用模型名', 'Fallback model'),
            oninput: (e) => { item.model = e.target.value.trim(); state.aiTest = null; }
          }),
          h('button', {
            class: 'btn ghost sm', type: 'button',
            title: T('移除这一条', 'Remove this entry'),
            onclick: () => {
              const l = fbList().slice();
              l.splice(idx, 1);
              d.fallbacks = l;
              paint();
            }
          }, icon('trash', 14))
        );

        const fbBox = h('div', { class: 'stack' },
          ...fbList().map(fbRowOf),
          fbList().length < 5
            ? h('button', {
              class: 'btn ghost sm', type: 'button',
              onclick: () => {
                /* 只加空行、不落盘：没填完的空白条目在保存时会被 normalize 丢掉 */
                d.fallbacks = fbList().concat([{ endpoint: '', model: '' }]);
                paint();
              }
            }, icon('plus', 14), h('span', { text: T('添加备用模型', 'Add fallback model') }))
            : h('div', { class: 'small muted', text: T('最多 5 个', 'Up to 5') })
        );

        cardModel.appendChild(setRow(T('备用模型', 'Fallbacks'), fbBox,
          T('主端点限流、欠费或模型下线时，按顺序自动往后切，答案顶部会写明切到了哪个。留空表示不切换',
            'When the primary is rate-limited, out of credit or gone, these are tried in order; the answer states which one answered')));

        /* 三个数字字段并一行：窗口 / 温度 / 轮数都是短值，
           各占一整行会白掉三行高度。说明文字各自压进 title。 */
        cardModel.appendChild(h('div', { class: 'set-row' },
          h('div', { class: 'set-label', text: T('参数', 'Params') }),
          h('div', { class: 'set-body' },
            h('div', { class: 'set-tri' },
              h('div', { class: 'field' },
                h('label', {
                  title: reported
                    ? T('读自端点 /models 的 max context length；历史超过窗口 50% 起按需裁剪，85% 压成摘要，不会失忆', 'Read from the endpoint; history is trimmed past 50% of the window and summarized at 85%')
                    : T('端点没有报告这个值：按模型名推断，推断不出按 1M。历史超过窗口 50% 起自动裁剪，85% 压成摘要', 'Not reported; inferred from the model name, else 1M. History is trimmed past 50% and summarized at 85%'),
                  text: T('上下文窗口', 'Context')
                }),
                ctxIn),
              h('div', { class: 'field' },
                h('label', {
                  title: d.tempAuto !== false
                    ? T('自动：查文件 0.1 · 算数字 0 · 写文案 0.85。温度管「答案有多发散」，与思考强度无关', 'Auto: 0.1 for files, 0 for math, 0.85 for writing. Temperature controls variety, not effort')
                    : T('手填值对所有任务生效；推理模型会锁死温度，那时这个数字不发送', 'Applies to every task; reasoning models lock temperature and this value is not sent'),
                  text: T('温度', 'Temp')
                }),
                h('div', { class: 'row wrap' },
                  tempIn,
                  h('label', { class: 'check', title: T('按任务自动选温度', 'Pick temperature by task') }, tempAutoCb, h('span', { text: T('自动', 'Auto') })))),
              h('div', { class: 'field' },
                h('label', {
                  title: T('这是防一路跑飞的安全闸，不是强度；超了会先给结论，不会无限查。与强度档位取小：关 6 / 低 8 / 中 10 / 高 14', 'A safety cap, not effort; it stops with a conclusion instead of looping. Capped by level: off 6 / low 8 / medium 10 / high 14'),
                  text: T('查证轮数', 'Steps')
                }),
                h('input', {
                  class: 'input', type: 'number', min: '1', max: '30', step: '1',
                  value: String(d.maxSteps),
                  onchange: (e) => {
                    const n = Math.max(1, Math.min(30, Math.round(Number(e.target.value) || 12)));
                    d.maxSteps = n;
                    AIStore.save({ maxSteps: n });
                    paint();
                  }
                }))
            )
          )
        ));

        const cardAct = h('div', { class: 'set-card' },
            setCap(T('行为与权限', 'Behaviour & permissions'), agentBadge),
            setRow(T('开关', 'Switches'),
              h('div', { class: 'ai-switch-row' },
                h('label', { class: 'check' }, enabledCb, h('span', { text: T('启用 AI 助手', 'Enable AI assistant') })),
                h('label', { class: 'check' }, jsonCb, h('span', { text: T('要求 JSON 模式', 'Request JSON mode') })))),
            setRow(T('档位', 'Mode'),
              h('div', { class: 'ai-modes' }, ...modeBtns),
              MODE_TIP[pol.mode] || ''),
            setRow(T('允许范围', 'Scope'),
              h('div', { class: 'agent-cats' }, ...catBoxes),
              pol.mode === 'off' ? T('档位在「只读」时这些开关不生效', 'Inactive while the mode is read-only') : ''),
            setRow(T('安全上限', 'Safety limits'),
              h('div', { class: 'agent-limits' },
                h('div', { class: 'field' },
                  h('label', { text: T('每轮提案', 'Per turn') }),
                  numIn('maxOpsPerTurn', 1, 10, 2)),
                h('div', { class: 'field' },
                  h('label', { text: T('每会话执行', 'Per session') }),
                  numIn('maxOpsPerSession', 1, 200, 30)),
                h('div', { class: 'field' },
                  h('label', { text: T('单次项目', 'Max items') }),
                  numIn('maxItems', 10, 20000, 200))
              ),
              T('每次执行均写入 ai\\journal 审计日志；切回「只读」立刻停止动手权限',
                'Every action is logged to ai\\journal; switching to read-only revokes write access'))
        );

        const ollamaCb = h('input', {
          type: 'checkbox',
          checked: d.ollamaFallback === true,
          onchange: (e) => { d.ollamaFallback = e.target.checked; paint(); }
        });
        const ollamaModelIn = h('input', {
          class: 'input mono ai-ollama-in',
          placeholder: 'qwen2.5:7b',
          value: String(d.ollamaModel || ''),
          oninput: (e) => { d.ollamaModel = e.target.value.trim(); }
        });
        cardModel.appendChild(setRow(T('本机兜底', 'Local fallback'),
          h('div', { class: 'ai-ollama-row' },
            h('label', { class: 'check' }, ollamaCb,
              h('span', { text: T('云端不可用时切换 Ollama', 'Fallback to Ollama if offline') })),
            ollamaModelIn
          ),
          T('需本机已运行 Ollama（127.0.0.1:11434）；留空默认 qwen2.5:7b',
            'Requires local Ollama at 127.0.0.1:11434; empty defaults to qwen2.5:7b')));

        const nowMs = Date.now();
        const capsObj = (d.caps && typeof d.caps === 'object') ? d.caps : {};
        const capKeys = Object.keys(capsObj);
        const cooledKeys = capKeys.filter((k) => (Number(capsObj[k] && capsObj[k].cooldownUntil) || 0) > nowMs);
        const capStatusBadge = cooledKeys.length > 0
          ? h('span', { class: 'badge warn', text: T(`${cooledKeys.length} 个端点冷却中`, `${cooledKeys.length} cooled down`) })
          : (capKeys.length > 0
            ? h('span', { class: 'badge ok', text: T(`已学习 ${capKeys.length} 个端点特性`, `${capKeys.length} learned`) })
            : h('span', { class: 'badge', text: T('暂无学习缓存', 'No cached caps') }));
        const capResetBtn = h('button', {
          class: 'btn sm',
          type: 'button',
          disabled: capKeys.length === 0,
          onclick: async () => {
            if (!capKeys.length) return;
            try {
              let nextCaps = {};
              if (cooledKeys.length > 0) {
                nextCaps = Object.assign({}, capsObj);
                cooledKeys.forEach((k) => {
                  nextCaps[k] = Object.assign({}, nextCaps[k], { cooldownUntil: 0, consecutiveFail: 0 });
                });
              }
              const saved = await AIStore.save({ caps: nextCaps });
              d.caps = saved.caps || {};
              if (state.ai) state.ai.caps = d.caps;
              toast(cooledKeys.length > 0
                ? T('已解除所有端点冷却', 'Cooldown cleared')
                : T('已清空端点学习缓存', 'Capability cache cleared'), 'ok');
              paint();
            } catch (err) {
              toast(errText(err), 'error');
            }
          }
        }, icon('refresh', 12), h('span', {
          text: cooledKeys.length > 0
            ? T(`解除冷却 (${cooledKeys.length})`, `Clear cooldown (${cooledKeys.length})`)
            : T(`重置缓存 (${capKeys.length})`, `Reset cache (${capKeys.length})`)
        }));
        cardConn.appendChild(setRow(T('节点健康', 'Health & caps'),
          h('div', { class: 'row wrap', style: 'gap: 8px; align-items: center;' }, capStatusBadge, capResetBtn),
          T('自动记住端点流式/工具支持与限流冷却期；重连异常时可手动重置',
            'Remembers stream/tool capability & rate-limit cooldowns; reset when troubleshooting')));

        const body = h('div', { class: 'stack set-stack' },
          h('div', { class: 'set-cols' }, cardConn, cardModel),
          cardAct,
          test && !test.ok
            ? h('div', { class: 'small', style: 'color:var(--danger)', text: test.msg })
            : null,
          test && test.ok && test.warn
            ? h('div', { class: 'small', style: 'color:var(--warn)', text: test.warn })
            : null,
          test && test.ok && test.note
            ? h('div', { class: 'small muted', text: test.note })
            : null,
          test && test.ok && test.hint
            ? h('div', { class: 'small muted', text: test.hint })
            : null,
          h('div', { class: 'action-bar ai-set-bar' },
            testBadge,
            h('div', { class: 'spacer' }),
            h('button', {
              class: 'btn sm', disabled: state.aiTesting, onclick: testAi
            }, icon('play', 14), h('span', { text: state.aiTesting ? T('测试中…', 'Testing…') : T('测试连接', 'Test connection') })),
            h('button', {
              class: 'btn sm ghost ai-set-danger', onclick: clearAiData
            }, icon('trash', 14), h('span', { text: T('清空对话记录', 'Clear chats') })),
            h('button', {
              class: 'btn primary sm', disabled: state.aiBusy, onclick: saveAi
            }, h('span', { text: state.aiBusy ? T('保存中…', 'Saving…') : T('保存', 'Save') }))
          )
        );

        return section(T('AI 助手', 'AI assistant'), body, {
          open: state.openId === 'assistant',
          hint: AIStore.isConfigured(d) ? T('已配置', 'Configured') : T('未配置', 'Not configured'),
          id: 'assistant',
          accordion: holder,
          onToggle: (open) => { if (open) state.openId = 'assistant'; }
        });
      }

      async function loadAi() {
        try {
          const s = await AIStore.load(true);
          state.ai = s;
          state.aiDraft = Object.assign({}, s);
          /* 动手开关存的是 ai_ui.agent（界面偏好），不是 AI 配置本身：
             它跟「哪个模型」无关，换模型不该把权限一起重置 */
          try {
            const ui = await AIStore.loadUi();
            state.agentDraft = window.AIProposals
              ? AIProposals.normalizePolicy(ui && ui.agent)
              : null;
          } catch (e2) {
            state.agentDraft = null;
          }
          const p = AIStore.PROVIDERS.find((x) => x.id !== 'custom' && x.endpoint === s.endpoint);
          state.aiProv = p ? p.id : 'custom';
        } catch (e) {
          state.ai = null;
          state.aiDraft = null;
        }
      }

      /* 百炼、硅基流动这些控制台给的是 base URL（…/v1 或 …/compatible-mode/v1），
         原样发请求会 404；保存/测试前统一补成 …/chat/completions。
         注意：saveAi/testAi 在模块作用域，这个函数必须同层，放进 secAssistant 里会 ReferenceError。 */
      function normEndpoint(u) {
        if (window.AIStore && AIStore.normEndpoint) return AIStore.normEndpoint(u);
        return String(u || '').trim();
      }

      async function saveAi() {
        const d = state.aiDraft || state.ai;
        if (state.aiBusy || !d) return;
        if (!d.endpoint) return toast(T('请先填接口地址', 'Fill the endpoint first'), 'error');
        const rawEndpoint = d.endpoint;
        d.endpoint = normEndpoint(d.endpoint);
        const endpointFixed = d.endpoint !== rawEndpoint;
        if (!/^https?:\/\//i.test(d.endpoint)) return toast(T('接口地址要以 http:// 或 https:// 开头', 'Endpoint must start with http:// or https://'), 'error');
        if (!d.model) return toast(T('请先填模型名', 'Fill the model name first'), 'error');
        state.aiBusy = true;
        try {
          paint();
          const prev = state.ai || {};
          const changed = prev.endpoint !== d.endpoint || prev.model !== d.model;
          const next = await AIStore.save(d);
          /* 换了端点或模型就是换了对象：旧的学习结论（不认 JSON、要等 118 秒）
             不能继承，删掉让它重新学，否则新模型会背着上一任的毛病跑 */
          if (changed && next && next.caps && window.AIAgent && AIAgent.capKeyOf) {
            const key = AIAgent.capKeyOf(d.endpoint, d.model);
            if (next.caps[key]) {
              const kept = Object.assign({}, next.caps);
              delete kept[key];
              const cleaned = await AIStore.save({ caps: kept });
              state.ai = cleaned;
              state.aiDraft = Object.assign({}, cleaned);
              state.aiTest = null;
              state.aiBusy = false;
              toast(T('AI 设置已保存（新模型会重新探测能力）', 'AI settings saved (capabilities will be re-learned)'), 'ok');
              return;
            }
          }
          state.ai = next;
          state.aiDraft = Object.assign({}, next);
          /* 保存成功就把「这家的 Key + 这次选的模型」记下来。
             不 await、失败也不打断：记忆是便利功能，丢了顶多下次重粘一遍，
             不能因为它把「已保存」这条反馈拖慢或弄成报错。 */
          if (AIStore.rememberProvider) {
            AIStore.rememberProvider({ endpoint: next.endpoint, key: next.key, model: next.model })
              .then(() => { try { paint(); } catch (e) { /* 重绘失败不影响已保存 */ } })
              .catch(() => {});
          }
          toast(endpointFixed
            ? T('AI 设置已保存（地址已补全 /chat/completions）', 'AI settings saved (endpoint completed)')
            : T('AI 设置已保存', 'AI settings saved'), 'ok');
        } catch (e) {
          toast(errText(e), 'error');
        } finally {
          state.aiBusy = false;
          /* 渲染一旦抛错，不能让 busy 卡在 true，否则保存/测试按钮从此点不动 */
          try { paint(); } catch (e) { state.aiBusy = false; }
        }
      }

      /* 分两步：① 最小请求确认连通；② 带 response_format 要一次 JSON。
         只做①的话，模型不认 JSON 约定也显示「连接正常」，
         用户到对话页才撞上「输出格式不对」，等于测试骗了自己。 */
      async function testAi() {
        const d = state.aiDraft || state.ai;
        if (state.aiTesting || !d) return;
        if (!d.endpoint || !d.model) return toast(T('先填接口地址与模型名', 'Fill endpoint and model first'), 'error');
        d.endpoint = normEndpoint(d.endpoint);
        state.aiTesting = true; state.aiTest = null;
        try { paint(); } catch (e) { state.aiTesting = false; }
        const t0 = Date.now();
        const send = (body) => API.aiHttp({
          url: d.endpoint,
          headers: d.key ? { Authorization: 'Bearer ' + d.key } : {},
          body: JSON.stringify(Object.assign({ model: d.model, stream: false }, body)),
          /* 推理模型实测单轮可到 70–120s，20s 会把它误判成连不通 */
          timeoutMs: 180000
        });
        try {
          const res = await send({ messages: [{ role: 'user', content: 'ping' }], max_tokens: 8 });
          const ms = (res && res.elapsed_ms) || (Date.now() - t0);
          if (!res || res.status !== 200) {
            const detail = String((res && res.body) || '').slice(0, 200);
            state.aiTest = { ok: false, ms, msg: 'HTTP ' + (res && res.status) + (detail ? '：' + detail : '') };
          } else {
            let payload = null;
            try { payload = JSON.parse(String(res.body || '')); } catch (e) { payload = null; }
            const choice = payload && payload.choices && payload.choices[0];
            const content = (choice && choice.message && choice.message.content) || '';
            if (!payload || !choice) {
              state.aiTest = { ok: false, ms, msg: T('返回里没有 choices，可能地址不对', 'Response has no choices; check the URL') };
            } else {
              const probe = await jsonProbe(send);
              await learnCaps(probe.caps);
              state.aiTest = {
                ok: true, ms,
                warn: probe.warn,
                note: probe.note,
                hint: String(content).trim().slice(0, 80) || T('（返回为空内容，但连接是通的）', '(empty reply, but the connection works)')
              };
            }
          }
        } catch (e) {
          state.aiTest = { ok: false, msg: errText(e) };
        } finally {
          state.aiTesting = false;
          /* 同上：渲染抛错也要把「测试中」解锁 */
          try { paint(); } catch (e) { state.aiTesting = false; }
        }
      }

      /** 按对话时同样的要求试一次 JSON 输出；不合规就返回一句人话提示 */
      async function jsonProbe(send) {
        const messages = [
          { role: 'system', content: '只输出一个 JSON 对象，其它什么都不要：{"ok":true}' },
          { role: 'user', content: 'reply' }
        ];
        const contentOf = (res) => {
          let payload = null;
          try { payload = JSON.parse(String((res && res.body) || '')); } catch (e) { return ''; }
          const ch = payload && payload.choices && payload.choices[0];
          return String((ch && ch.message && ch.message.content) || '')
            .trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
        };
        /* 顺手把这个模型的能力学下来（对话页复用同一套判定）：
           认不认 response_format、要不要给思考留余量、实测多慢。
           这样「测试连接」不再只是显示一个绿点，而是真的把坑先探掉。 */
        const caps = {};
        const t0 = Date.now();
        let calls = 0;
        try {
          calls += 1;
          let res = await send({ messages, max_tokens: 800, response_format: { type: 'json_object' } });
          let formatted = true;
          /* 有的兼容端点不认 response_format，去掉再试一次，并把「不认」记住 */
          if (!res || res.status !== 200) {
            formatted = false;
            caps.jsonMode = false;
            calls += 1;
            res = await send({ messages, max_tokens: 800 });
          }
          let text = (res && res.status === 200) ? contentOf(res) : '';
          /* 推理模型先把预算花在 reasoning_content 上：给小了就只有思考没有正文 */
          if (!text && res && res.status === 200) {
            caps.reasoning = true;
            caps.maxTokens = 1600;
            calls += 1;
            res = await send({
              messages,
              max_tokens: 1600,
              response_format: formatted ? { type: 'json_object' } : undefined
            });
            if (res && res.status === 200) text = contentOf(res);
          }
          const totalMs = Date.now() - t0;
          caps.latencyMs = Math.max(1000, Math.round(totalMs / Math.max(1, calls)));
          const secs = Math.round(totalMs / 1000);
          const slow = secs > 25
            ? T('；实测这个模型每次要 ' + secs + ' 秒，对话会明显慢', '; it took ' + secs + 's, so replies will be slow')
            : '';
          const learned = describeCaps(caps);
          if (!text) {
            return {
              warn: T('端点只回了空内容：它把预算全花在思考上了，换 glm-4.5-flash / deepseek-chat 这类非推理模型最省事' + slow,
                'Empty content only; switch to a non-reasoning model' + slow),
              note: learned,
              caps
            };
          }
          if (text.indexOf('{') >= 0) {
            return { warn: slow ? T('格式没问题' + slow, 'Format OK' + slow) : '', note: learned, caps };
          }
          caps.noJson = true;
          return {
            warn: T('这个模型不按 JSON 输出（它回的是「' + text.slice(0, 20) + '…」）。对话时会自动按普通文本处理，不再报格式错' + slow,
              'This model ignores the JSON contract; chats will fall back to plain text' + slow),
            note: describeCaps(caps),
            caps
          };
        } catch (e) {
          return { warn: '', note: '', caps: Object.keys(caps).length ? caps : null };
        }
      }

      /** 把学到的能力说成人话，让用户知道下次会怎么发请求 */
      function describeCaps(caps) {
        const bits = [];
        if (caps.jsonMode === false) bits.push(T('不支持强制 JSON 模式', 'no forced JSON mode'));
        if (caps.reasoning) bits.push(T('会先思考，预算已加大', 'thinks first, budget raised'));
        if (caps.noJson) bits.push(T('不守 JSON 约定，按普通文本回答', 'ignores JSON, answers as text'));
        if (caps.maxTokens) bits.push(T('单次上限 ' + caps.maxTokens + ' tokens', 'max_tokens ' + caps.maxTokens));
        if (bits.length) bits.push(T('每轮约 ' + Math.round((caps.latencyMs || 0) / 1000) + ' 秒', '~' + Math.round((caps.latencyMs || 0) / 1000) + 's per turn'));
        return bits.length ? T('已记住这个模型的能力：', 'Learned for this model: ') + bits.join('、') : '';
      }

      /** 能力记忆落在 ai.caps 里（键=主机|模型），对话页读到就直接照做。
       *  这里整体替换而不是合并：重测一次就是「重新认识这个模型」，
       *  模型升级后旧结论（比如以前不认 JSON）要能被推翻。 */
      async function learnCaps(caps) {
        const d = state.aiDraft;
        if (!caps || !d || !window.AIAgent || !AIAgent.capKeyOf) return;
        try {
          const key = AIAgent.capKeyOf(d.endpoint, d.model);
          const cur = await AIStore.load(true);
          const all = Object.assign({}, cur.caps || {});
          all[key] = Object.assign({}, caps, { updatedAt: Date.now() });
          await AIStore.save({ caps: all });
        } catch (e) { /* 记住能力失败不影响保存 */ }
      }

      /* 把 /chat/completions 地址换成同源的 /models */
      function modelsUrl(endpoint) {
        const u = String(endpoint || '').trim().replace(/\/+$/, '');
        if (!u) return '';
        if (/\/chat\/completions$/i.test(u)) return u.replace(/\/chat\/completions$/i, '/models');
        if (/\/completions$/i.test(u)) return u.replace(/\/completions$/i, '/models');
        if (/\/models$/i.test(u)) return u;
        return u + '/models';
      }

      /* 端点怎么报窗口的都有：OpenAI 兼容看 context_length，vLLM 用 max_model_len，
         llama.cpp 用 n_ctx_train，还有 context_window / max_context_length 几种写法。
         都没报、但名字带 8k/32k/128k 的（如 moonshot-v1-8k）按名字推，推不出就返回 0
         —— 返回 0 才是「没读到」，界面上会照实写，不拿默认值冒充。 */
      function ctxOfModel(it) {
        const keys = ['context_length', 'max_model_len', 'context_window', 'max_context_length',
          'n_ctx_train', 'context', 'max_input_tokens'];
        for (const k of keys) {
          const v = Number(it && it[k]);
          if (Number.isFinite(v) && v >= 1000 && v <= 2000000) return Math.round(v);
        }
        const id = String((it && (it.id || it.name || it.model)) || '');
        const m = id.match(/(?:^|[-_:])(\d{1,3})k\b/i);
        if (m) {
          const n = Number(m[1]);
          if (n >= 2 && n <= 1000) return n * 1024;
        }
        return 0;
      }

      function parseModels(payload) {
        const arr = Array.isArray(payload && payload.data) ? payload.data
          : (Array.isArray(payload && payload.models) ? payload.models : []);
        const list = [];
        const ctx = {};
        arr.forEach((it) => {
          const id = typeof it === 'string'
            ? it.trim()
            : String((it && (it.id || it.name || it.model)) || '').trim();
          if (!id || id.length > 120 || list.indexOf(id) >= 0) return;
          list.push(id);
          const w = ctxOfModel(it);
          if (w) ctx[id] = w;
        });
        return { list: list, ctx: ctx };
      }

      /* 拉端点自己的模型清单：GET /models。只认 200 + 能解析出列表，
         失败就把原因原样写在字段下面，不静默退回假数据。 */
      async function fetchModels() {
        const d = state.aiDraft;
        if (state.aiModelsBusy || !d) return;
        if (!d.endpoint) return toast(T('请先填接口地址', 'Fill the endpoint first'), 'error');
        const url = modelsUrl(d.endpoint);
        state.aiModelsBusy = true; state.aiModelsErr = null; paint();
        try {
          const res = await API.aiHttp({
            url,
            method: 'GET',
            headers: d.key ? { Authorization: 'Bearer ' + d.key } : {},
            body: '',
            timeoutMs: 15000
          });
          if (!res || res.status !== 200) {
            const detail = String((res && res.body) || '').replace(/\s+/g, ' ').slice(0, 160);
            state.aiModelsErr = 'HTTP ' + (res && res.status) + (detail ? '：' + detail : '') +
              T('（有些服务商不提供 /models）', ' (/models may be unsupported)');
            return;
          }
          let payload = null;
          try { payload = JSON.parse(String(res.body || '')); } catch (e) { payload = null; }
          const got = parseModels(payload);
          if (!got.list.length) {
            state.aiModelsErr = T('返回里没有模型列表：', 'No model list in the response: ') +
              String((res && res.body) || '').replace(/\s+/g, ' ').slice(0, 120);
            return;
          }
          d.models = got.list;
          d.modelCtx = got.ctx;
          if (!d.model || got.list.indexOf(d.model) < 0) d.model = got.list[0];
          if (got.ctx[d.model]) d.ctxWindow = got.ctx[d.model];
          const known = Object.keys(got.ctx).length;
          toast(T('已获取 ' + got.list.length + ' 个模型' + (known ? '，' + known + ' 个带窗口信息' : ''),
            got.list.length + ' models fetched'), 'ok');
          /* 拉完直接把清单弹出来：不然用户只看到一个 toast，
             还得自己去点那一行才知道拿到了什么 */
          state.autoOpenModels = true;
        } catch (e) {
          state.aiModelsErr = errText(e);
        } finally {
          state.aiModelsBusy = false; paint();
        }
      }

      async function clearAiData() {
        const ok = await confirm({
          title: T('清空对话记录', 'Clear chats'),
          body: T('会删除本机保存的全部 AI 会话与用量记录，设置项保留。此操作不可撤销。', 'Deletes all saved AI sessions and usage records on this machine. Settings stay. This cannot be undone.'),
          ok: T('清空', 'Clear'), danger: true
        });
        if (!ok) return;
        try {
          await AIStore.clearAll();
          toast(T('对话记录已清空', 'Chats cleared'), 'ok');
        } catch (e) {
          toast(errText(e), 'error');
        }
      }

      /* ---------- 版本与在线更新 ---------- */
      function fmtSize(n) {
        if (UI && typeof UI.fmtBytes === 'function') return UI.fmtBytes(Number(n) || 0);
        const v = Number(n) || 0;
        if (v >= 1048576) return (v / 1048576).toFixed(1) + ' MB';
        if (v >= 1024) return (v / 1024).toFixed(1) + ' KB';
        return v + ' B';
      }

      function syncUpdaterProgressDom() {
        const dom = state.updProgDom;
        if (!dom || !dom.wrap) return;
        const p = state.updProg;
        const show = !!(state.updDownloading || (p && (p.phase === 'downloading' || p.phase === 'verifying')));
        dom.wrap.hidden = !show;
        if (!show) return;
        const pct = Math.max(0, Math.min(100, Number(p && p.percent) || 0));
        dom.fill.style.width = pct + '%';
        if (state.updCancelling) {
          dom.meta.textContent = T('正在取消下载并清理临时文件…', 'Cancelling download and cleaning up…');
        } else if (p && p.phase === 'verifying') {
          dom.meta.textContent = T('正在校验 SHA-256 完整性与文件头…', 'Verifying SHA-256 integrity…');
        } else {
          const dl = fmtSize(p && p.downloaded);
          const tot = (p && p.total > 0) ? fmtSize(p.total) : T('计算中', '…');
          const spd = (p && p.speedBps > 0) ? ' · ' + fmtSize(p.speedBps) + '/s' : '';
          dom.meta.textContent = `${pct}% · ${dl} / ${tot}${spd}`;
        }
        dom.cancelBtn.disabled = !!state.updCancelling;
        dom.cancelBtn.textContent = state.updCancelling ? T('取消中…', 'Cancelling…') : T('取消下载', 'Cancel');
      }

      function secUpdater(holder) {
        const st = state.updStatus;
        const curVer = (st && st.currentVersion) || (state.app && state.app.version) || '—';
        const kind = (st && st.installKind) || 'portable';
        const kindLabel = kind === 'installer' ? T('安装版 (NSIS)', 'Installer (NSIS)') : T('便携版 (ZIP)', 'Portable (ZIP)');
        const chk = state.updCheck;
        const staged = (chk && chk.staged) || (st && st.staged) || null;
        const hasNew = !!(chk && chk.hasUpdate);
        const cacheBytes = Number(st && st.cacheBytes) || 0;

        /* 持久化下载进度区域：收到高频 updater-progress 只就地改样式/文案，不重建取消按钮 */
        const progFill = h('div', { class: 'upd-prog-fill', style: 'width: 0%' });
        const progMeta = h('span', { class: 'small muted upd-prog-meta', text: '' });
        const cancelBtn = h('button', {
          type: 'button',
          class: 'btn sm ghost',
          text: T('取消下载', 'Cancel'),
          onclick: cancelUpdateDownload
        });
        const progWrap = h('div', { class: 'upd-prog', hidden: !state.updDownloading },
          h('div', { class: 'upd-prog-bar' }, progFill),
          h('div', { class: 'row upd-prog-row' }, progMeta, h('div', { class: 'spacer' }), cancelBtn)
        );
        state.updProgDom = { wrap: progWrap, fill: progFill, meta: progMeta, cancelBtn };
        syncUpdaterProgressDom();

        const chkFill = h('div', { class: 'mig-progress-fill', style: 'width: ' + ((state.updCheckProg && state.updCheckProg.percent) || 12) + '%' });
        const chkText = h('span', {
          class: 'small',
          style: { color: 'var(--text-1)', flex: '1 1 auto' },
          text: (state.updCheckProg && state.updCheckProg.stage) || T('正在连接官方更新源…', 'Connecting to official update server…')
        });
        const chkPct = h('span', {
          class: 'small mono',
          style: { color: 'var(--accent)', fontWeight: '600' },
          text: ((state.updCheckProg && state.updCheckProg.percent) || 12) + '%'
        });
        const chkWrap = h('div', { class: 'upd-check-bar', hidden: !state.updChecking },
          h('div', { class: 'row', style: { gap: '8px', alignItems: 'center' } },
            h('span', { class: 'btn-spin', style: { color: 'var(--accent)' }, 'aria-hidden': 'true' }),
            chkText,
            chkPct
          ),
          h('div', { class: 'mig-progress-track' }, chkFill)
        );
        state.updCheckDom = { wrap: chkWrap, fill: chkFill, text: chkText, pct: chkPct };

        const releasesPage = (st && st.releasesPage) || 'https://github.com/3347567186/QDisk/releases';

        function fmtReleaseDate(raw) {
          if (!raw) return '';
          const m = String(raw).match(/^(\d{4}-\d{2}-\d{2})/);
          return m ? m[1] : String(raw).slice(0, 10);
        }

        function extractReleaseSummary(rawNotes) {
          if (!rawNotes) return '';
          const lines = String(rawNotes).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
          for (const line of lines) {
            const clean = line
              .replace(/^#+\s*/, '')
              .replace(/^\d+\.\d+\.\d+[^—–-]*[—–-]+\s*/, '')
              .replace(/^[-*]\s+/, '')
              .replace(/\*\*([^*]+)\*\*/g, '$1')
              .replace(/`([^`]+)`/g, '$1')
              .trim();
            if (clean) return clean;
          }
          return '';
        }

        function kindBadgeInfo(kind) {
          if (kind === 'major') return { cls: 'badge accent', text: T('大版本', 'Major') };
          if (kind === 'minor') return { cls: 'badge accent', text: T('功能更新', 'Feature') };
          if (kind === 'patch') return { cls: 'badge', text: T('优化修复', 'Fix') };
          if (kind === 'legacy') return { cls: 'badge', text: T('早期版本', 'Legacy') };
          return { cls: 'badge', text: T('版本', 'Release') };
        }

        function formatVersionTag(ver) {
          const s = String(ver || '').trim();
          if (!s) return '—';
          return /^[vVaAbB]/.test(s) ? s : 'v' + s;
        }

        function closeActiveChangelogDialog() {
          if (state.changelogClose) {
            const fn = state.changelogClose;
            state.changelogClose = null;
            try { fn(); } catch (_) {}
          }
        }

        function openChangelogModal(focusOpts) {
          const fo = focusOpts || {};
          closeActiveChangelogDialog();

          const modalRoot = document.getElementById('modal-root') || document.body;
          const dialog = document.createElement('dialog');
          dialog.className = 'cl-dialog';
          dialog.setAttribute('closedby', 'any');
          dialog.setAttribute('aria-labelledby', 'cl-dialog-title');

          let entries = [];
          let selectedId = '';
          let userPicked = false;
          let filterQuery = '';
          let filterKind = 'all'; // all | minor | patch | legacy
          let loading = true;
          let syncing = false;
          let remoteSynced = false;
          let closed = false;
          let loadSeq = 0;

          const updateCtx = fo.ver ? {
            ver: String(fo.ver),
            pubDate: fo.pubDate || '',
            pkgKind: fo.pkgKind || kind,
            pkgSize: Number(fo.pkgSize) || 0,
            pkgSha: fo.pkgSha || '',
            notes: fo.notes || '',
            isReady: !!fo.isReady,
            stagedPath: fo.stagedPath || ''
          } : ((chk && chk.hasUpdate) ? {
            ver: String(chk.latestVersion || ''),
            pubDate: chk.pubDate || '',
            pkgKind: (staged && staged.packageKind) || chk.packageKind || kind,
            pkgSize: Number((staged && staged.size) || chk.size || 0),
            pkgSha: (staged && staged.sha256) || chk.sha256 || '',
            notes: chk.notes || '',
            isReady: !!(staged && staged.version === chk.latestVersion),
            stagedPath: (staged && staged.path) || ''
          } : null);

          function buildSyntheticUpdateEntry() {
            if (!updateCtx || !updateCtx.ver) return null;
            return {
              id: updateCtx.ver.toLowerCase(),
              version: updateCtx.ver,
              kind: 'minor',
              title: extractReleaseSummary(updateCtx.notes) || T('新版本可用', 'New release available'),
              summary: extractReleaseSummary(updateCtx.notes),
              body: updateCtx.notes || T('暂无详细更新说明', 'No release notes provided'),
              date: fmtReleaseDate(updateCtx.pubDate),
              isCurrent: updateCtx.ver === curVer,
              isUpdate: true,
              isPrerelease: !!(chk && chk.isPrerelease),
              source: 'remote',
              url: `${releasesPage}/tag/v${updateCtx.ver}`
            };
          }

          function mergeEntries(rawList) {
            const list = Array.isArray(rawList) ? rawList.map((x) => Object.assign({}, x)) : [];
            const upd = buildSyntheticUpdateEntry();
            if (upd) {
              const hitIdx = list.findIndex((x) => String(x.version || '').toLowerCase() === upd.version.toLowerCase());
              if (hitIdx >= 0) {
                list[hitIdx] = Object.assign({}, list[hitIdx], {
                  isUpdate: true,
                  date: upd.date || list[hitIdx].date || '',
                  body: upd.body || list[hitIdx].body || ''
                });
              } else {
                list.unshift(upd);
              }
            }
            if (!list.length) {
              list.push({
                id: String(curVer || 'current').toLowerCase(),
                version: String(curVer || '—'),
                kind: 'minor',
                title: T('当前运行版本', 'Current installed version'),
                summary: T('当前版本更新记录', 'Current version notes'),
                body: T('暂无可展示的离线更新日志，可点击右上角「同步线上」或前往 GitHub 发布页查看。',
                  'No offline release notes available. Click Sync or open GitHub Releases.'),
                date: '',
                isCurrent: true,
                isUpdate: false,
                source: 'local',
                url: releasesPage
              });
            }
            return list;
          }

          function filteredEntries() {
            const q = String(filterQuery || '').trim().toLowerCase();
            return entries.filter((it) => {
              if (filterKind !== 'all') {
                if (filterKind === 'minor' && it.kind !== 'minor' && it.kind !== 'major') return false;
                if (filterKind === 'patch' && it.kind !== 'patch') return false;
                if (filterKind === 'legacy' && it.kind !== 'legacy') return false;
              }
              if (!q) return true;
              const hay = [it.version, it.title, it.summary, it.date, it.body].join('\n').toLowerCase();
              return hay.includes(q);
            });
          }

          const titleCountEl = h('span', { class: 'badge' }, '');
          const syncBtn = h('button', {
            type: 'button',
            class: 'btn ghost sm',
            title: T('从官方 GitHub Releases 同步最新发版日期与远端日志', 'Sync release dates & latest notes from GitHub'),
            onclick: () => loadChangelog(true)
          }, icon('refresh', 13), h('span', { text: T('同步线上', 'Sync') }));
          const curJumpBtn = h('button', {
            type: 'button',
            class: 'btn ghost sm',
            onclick: () => {
              userPicked = true;
              filterQuery = '';
              filterKind = 'all';
              searchInput.value = '';
              searchClearBtn.hidden = true;
              const hit = entries.find((x) => x.isCurrent || x.version === curVer) || entries[0];
              if (hit) selectedId = hit.id;
              renderAll(true);
            }
          }, h('span', { text: T('当前版本', 'Current') }));
          const closeIconBtn = h('button', {
            type: 'button',
            class: 'btn ghost icon sm',
            title: T('关闭', 'Close'),
            'aria-label': T('关闭', 'Close'),
            onclick: () => closeDialog()
          }, icon('close', 14));

          const headEl = h('header', { class: 'cl-head' },
            h('div', { class: 'cl-head-left' },
              h('h1', { id: 'cl-dialog-title', class: 'cl-title' }, T('更新日志', 'Changelog')),
              titleCountEl,
              h('span', { class: 'badge ok mono' }, T('当前 ', 'Now ') + formatVersionTag(curVer))
            ),
            h('div', { class: 'cl-head-right' },
              curJumpBtn,
              syncBtn,
              h('button', {
                type: 'button',
                class: 'btn ghost sm',
                onclick: () => openExternalUrl(releasesPage)
              }, icon('external', 13), h('span', { text: 'GitHub' })),
              closeIconBtn
            )
          );

          const searchInput = h('input', {
            type: 'search',
            class: 'input cl-search-input',
            autofocus: true,
            spellcheck: 'false',
            placeholder: T('筛选版本号或关键词…', 'Filter version or keyword…'),
            'aria-label': T('筛选版本号或关键词', 'Filter version or keyword'),
            oninput: (e) => {
              filterQuery = e.target.value || '';
              searchClearBtn.hidden = !filterQuery;
              renderAll(false);
            }
          });
          const searchClearBtn = h('button', {
            type: 'button',
            class: 'btn ghost icon sm cl-search-clear',
            hidden: true,
            title: T('清空筛选', 'Clear'),
            'aria-label': T('清空筛选', 'Clear'),
            onclick: () => {
              filterQuery = '';
              searchInput.value = '';
              searchClearBtn.hidden = true;
              renderAll(false);
              searchInput.focus();
            }
          }, icon('close', 12));

          const filterTabsEl = h('div', { class: 'cl-filter-tabs', role: 'tablist' });
          const listEl = h('div', { class: 'cl-list', role: 'listbox', 'aria-label': T('历史版本列表', 'Version history') });
          const sidebarEl = h('aside', { class: 'cl-sidebar' },
            h('div', { class: 'cl-search-wrap' }, icon('search', 13), searchInput, searchClearBtn),
            filterTabsEl,
            listEl
          );

          const detailEl = h('section', { class: 'cl-detail', 'aria-live': 'polite' });
          const mainEl = h('div', { class: 'cl-main' }, sidebarEl, detailEl);

          const footInfoEl = h('span', { class: 'small muted' }, '');
          const prevVerBtn = h('button', {
            type: 'button',
            class: 'btn ghost sm',
            onclick: () => stepSelected(-1)
          }, icon('chevron-left', 12), h('span', { text: T('更新一版', 'Newer') }));
          const nextVerBtn = h('button', {
            type: 'button',
            class: 'btn ghost sm',
            onclick: () => stepSelected(1)
          }, h('span', { text: T('更早一版', 'Older') }), icon('chevron-right', 12));
          const closeBtn = h('button', {
            type: 'button',
            class: 'btn sm primary',
            onclick: () => closeDialog()
          }, T('关闭', 'Close'));

          const footEl = h('footer', { class: 'cl-foot' },
            footInfoEl,
            h('div', { class: 'spacer' }),
            prevVerBtn,
            nextVerBtn,
            closeBtn
          );

          dialog.appendChild(h('div', { class: 'cl-shell' }, headEl, mainEl, footEl));

          function stepSelected(delta) {
            const vis = filteredEntries();
            if (!vis.length) return;
            const idx = Math.max(0, vis.findIndex((x) => x.id === selectedId));
            const nextIdx = Math.max(0, Math.min(vis.length - 1, idx + delta));
            if (vis[nextIdx] && vis[nextIdx].id !== selectedId) {
              userPicked = true;
              selectedId = vis[nextIdx].id;
              renderAll(true);
            }
          }

          const onListKey = (e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); stepSelected(1); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); stepSelected(-1); }
          };
          listEl.addEventListener('keydown', onListKey);

          function renderFilterTabs() {
            const defs = [
              { k: 'all', zh: '全部', en: 'All' },
              { k: 'minor', zh: '功能', en: 'Feature' },
              { k: 'patch', zh: '修复', en: 'Fix' },
              { k: 'legacy', zh: '早期', en: 'Legacy' }
            ];
            filterTabsEl.replaceChildren(...defs.map((d) => h('button', {
              type: 'button',
              role: 'tab',
              'aria-selected': filterKind === d.k ? 'true' : 'false',
              class: 'cl-ftab' + (filterKind === d.k ? ' active' : ''),
              onclick: () => { filterKind = d.k; renderAll(false); }
            }, T(d.zh, d.en))));
          }

          function renderDetail(item, visIndex, visTotal) {
            detailEl.replaceChildren();
            if (loading && !entries.length) {
              detailEl.appendChild(skeleton(6, 'log'));
              return;
            }
            if (!item) {
              detailEl.appendChild(empty(
                T('没有匹配的历史版本', 'No matching versions'),
                T('换个版本号或关键词试试', 'Try another version or keyword'),
                'search'
              ));
              return;
            }
            const kb = kindBadgeInfo(item.kind);
            const verTag = formatVersionTag(item.version);
            const isUpdItem = !!(updateCtx && item.version.toLowerCase() === updateCtx.ver.toLowerCase());
            const metaBits = [
              item.date || '',
              isUpdItem && updateCtx.pkgSize > 0 ? fmtSize(updateCtx.pkgSize) : '',
              isUpdItem ? (updateCtx.pkgKind === 'installer' ? T('安装版', 'Installer') : T('便携版', 'Portable')) : ''
            ].filter(Boolean).join(' · ');

            const headerBadges = [
              h('span', { class: kb.cls }, kb.text),
              item.isUpdate ? h('span', { class: 'badge ok' }, T('发现新版本', 'New release')) : null,
              item.isCurrent ? h('span', { class: 'badge ok' }, T('当前运行', 'Installed')) : null,
              item.isPrerelease ? h('span', { class: 'badge warn' }, T('预发布', 'Prerelease')) : null
            ].filter(Boolean);

            const copyTextBody = `# ${verTag}${item.title ? ' — ' + item.title : ''}\n\n${item.body || ''}`.trim();

            const detailHead = h('div', { class: 'cl-detail-head' },
              h('div', { class: 'row wrap', style: { gap: '8px', alignItems: 'center' } },
                h('h2', { class: 'cl-ver-heading mono' }, T(`${verTag} 更新日志`, `${verTag} Release Notes`)),
                ...headerBadges,
                h('div', { class: 'spacer' }),
                h('button', {
                  type: 'button',
                  class: 'btn ghost sm',
                  onclick: () => UI.copy(copyTextBody, T('已复制本版更新日志', 'Release notes copied'))
                }, icon('copy', 13), h('span', { text: T('复制', 'Copy') })),
                item.url ? h('button', {
                  type: 'button',
                  class: 'btn ghost sm',
                  onclick: () => openExternalUrl(item.url)
                }, icon('external', 13), h('span', { text: T('发布页', 'Tag') })) : null
              ),
              item.title ? h('div', { class: 'cl-ver-sub' }, item.title) : null,
              metaBits ? h('div', { class: 'small muted' }, metaBits) : null
            );

            const updBanner = isUpdItem ? h('div', { class: 'cl-upd-bar' },
              h('div', { class: 'row wrap', style: { gap: '8px', alignItems: 'center' } },
                updateCtx.isReady
                  ? h('button', {
                    type: 'button',
                    class: 'btn primary sm',
                    disabled: state.updInstalling || state.updDownloading,
                    onclick: () => { closeDialog(); installStagedUpdate(updateCtx.ver, updateCtx.pkgKind); }
                  }, icon('refresh', 13), h('span', { text: T('立即重启并安装更新', 'Restart & install') }))
                  : h('button', {
                    type: 'button',
                    class: 'btn primary sm',
                    disabled: state.updDownloading || state.updChecking,
                    onclick: () => { closeDialog(); startUpdateDownload(); }
                  }, icon('download', 13), h('span', { text: T('下载更新包', 'Download update') })),
                updateCtx.isReady && updateCtx.stagedPath
                  ? h('button', {
                    type: 'button',
                    class: 'btn ghost sm',
                    onclick: () => reveal(updateCtx.stagedPath)
                  }, icon('folder', 13), h('span', { text: T('打开安装包目录', 'Show in folder') }))
                  : null,
                !updateCtx.isReady
                  ? h('button', {
                    type: 'button',
                    class: 'btn ghost sm',
                    disabled: state.updDownloading,
                    onclick: async () => { closeDialog(); await skipUpdateVersion(updateCtx.ver); }
                  }, h('span', { text: T('跳过此版本', 'Skip this version') }))
                  : null
              ),
              updateCtx.pkgSha ? h('details', { class: 'upd-details' },
                h('summary', { class: 'small muted', text: T('SHA-256 校验信息', 'SHA-256 checksum') }),
                h('div', { class: 'upd-details-body' },
                  h('div', { class: 'row', style: { gap: '8px', alignItems: 'center' } },
                    h('span', { class: 'small muted mono upd-sha', text: 'SHA-256: ' + updateCtx.pkgSha }),
                    h('button', {
                      type: 'button',
                      class: 'btn ghost sm',
                      onclick: () => UI.copy(updateCtx.pkgSha, T('已复制 SHA-256', 'SHA-256 copied'))
                    }, h('span', { text: T('复制', 'Copy') }))
                  )
                )
              ) : null
            ) : null;

            const notesEl = h('div', {
              class: 'upd-log-md',
              onclick: (e) => {
                const a = e && e.target && e.target.closest ? e.target.closest('a[href]') : null;
                if (!a) return;
                const href = a.getAttribute('href') || '';
                if (/^https?:\/\//i.test(href)) {
                  e.preventDefault();
                  openExternalUrl(href);
                } else {
                  e.preventDefault();
                }
              }
            });
            if (window.AIMd && typeof window.AIMd.render === 'function' && item.body) {
              const rendered = window.AIMd.render(String(item.body));
              if (typeof UI.safeSetHtml === 'function') UI.safeSetHtml(notesEl, rendered);
              else notesEl.innerHTML = rendered;
            } else {
              notesEl.textContent = item.body || T('该版本暂无详细变更记录', 'No detailed release notes for this version');
            }

            const viewer = h('div', { class: 'upd-log-viewer cl-log-viewer' }, notesEl);
            detailEl.appendChild(detailHead);
            if (updBanner) detailEl.appendChild(updBanner);
            detailEl.appendChild(viewer);
            if (viewer.scrollTop) viewer.scrollTop = 0;

            footInfoEl.textContent = T(
              `第 ${visIndex + 1} / ${visTotal} 版` + (remoteSynced ? ' · 已同步线上发布' : ' · 本地完整历史记录'),
              `#${visIndex + 1} of ${visTotal}` + (remoteSynced ? ' · Synced with GitHub' : ' · Local history')
            );
          }

          function renderAll(scrollSelected) {
            renderFilterTabs();
            titleCountEl.textContent = T(`共 ${entries.length} 个版本`, `${entries.length} releases`);
            const vis = filteredEntries();
            if (vis.length && !vis.some((x) => x.id === selectedId)) {
              selectedId = vis[0].id;
            }
            const hadListFocus = typeof document !== 'undefined'
              && typeof listEl.contains === 'function'
              && !!document.activeElement
              && listEl.contains(document.activeElement);
            let activeBtnToFocus = null;
            listEl.replaceChildren();
            if (loading && !entries.length) {
              listEl.appendChild(skeleton(6, 'log'));
            } else if (!vis.length) {
              listEl.appendChild(h('div', { class: 'small muted', style: { padding: '14px 8px', textAlign: 'center' } },
                T('无匹配版本', 'No matches')));
            } else {
              vis.forEach((it) => {
                const isSel = it.id === selectedId;
                const rowBtn = h('button', {
                  type: 'button',
                  role: 'option',
                  'aria-selected': isSel ? 'true' : 'false',
                  class: 'cl-item' + (isSel ? ' active' : ''),
                  onclick: () => {
                    userPicked = true;
                    selectedId = it.id;
                    renderAll(false);
                  }
                },
                  h('div', { class: 'cl-item-top' },
                    h('span', { class: 'cl-item-ver mono' }, formatVersionTag(it.version)),
                    it.isUpdate ? h('span', { class: 'cl-dot is-new', title: T('新版本', 'New') }) : null,
                    it.isCurrent ? h('span', { class: 'badge ok cl-mini-badge' }, T('当前', 'Now'))
                      : (it.isUpdate ? h('span', { class: 'badge accent cl-mini-badge' }, T('新版', 'New')) : null),
                    h('span', { class: 'spacer' }),
                    it.date ? h('span', { class: 'cl-item-date mono' }, it.date) : null
                  ),
                  h('div', { class: 'cl-item-sub ellipsis', title: it.title || it.summary || '' },
                    it.title || it.summary || T('查看更新说明', 'View notes'))
                );
                listEl.appendChild(rowBtn);
                if (isSel) {
                  activeBtnToFocus = rowBtn;
                  if (scrollSelected && typeof rowBtn.scrollIntoView === 'function') {
                    rowBtn.scrollIntoView({ block: 'nearest' });
                  }
                }
              });
            }
            // 键盘上下切换重建列表后必须将焦点还给新选中项，防止第二次按方向键失焦失效
            if (hadListFocus && activeBtnToFocus && typeof activeBtnToFocus.focus === 'function') {
              try { activeBtnToFocus.focus({ preventScroll: true }); } catch (_) { activeBtnToFocus.focus(); }
            }

            const curIdx = vis.findIndex((x) => x.id === selectedId);
            const activeItem = curIdx >= 0 ? vis[curIdx] : null;
            prevVerBtn.disabled = curIdx <= 0;
            nextVerBtn.disabled = curIdx < 0 || curIdx >= vis.length - 1;
            renderDetail(activeItem, curIdx >= 0 ? curIdx : 0, vis.length);
          }

          async function loadChangelog(includeRemote) {
            const mySeq = ++loadSeq;
            if (includeRemote) {
              if (syncing) return;
              syncing = true;
              syncBtn.disabled = true;
            } else {
              loading = true;
              renderAll(false);
            }
            try {
              let raw = [];
              if (API && typeof API.updaterChangelog === 'function') {
                const res = await API.updaterChangelog(!!includeRemote);
                if (closed || mySeq !== loadSeq) return;
                raw = (res && Array.isArray(res.entries)) ? res.entries : [];
                if (includeRemote) {
                  remoteSynced = !!(res && res.remoteSynced);
                  if (remoteSynced) {
                    toast(T('已同步线上历史版本信息', 'Synced release history from GitHub'), 'ok');
                  } else if (res && res.remoteError) {
                    toast(T('线上同步失败，已保留离线完整记录：', 'Online sync failed; showing local history: ') + res.remoteError, 'warn');
                  }
                }
              }
              entries = mergeEntries(raw);
              if (!userPicked || !entries.some((x) => x.id === selectedId)) {
                const wantVer = fo.ver ? String(fo.ver).toLowerCase() : '';
                const hit = (wantVer && entries.find((x) => x.version.toLowerCase() === wantVer))
                  || entries.find((x) => x.isUpdate)
                  || entries.find((x) => x.isCurrent || x.version === curVer)
                  || entries[0];
                selectedId = hit ? hit.id : '';
              }
            } catch (e) {
              if (closed || mySeq !== loadSeq) return;
              entries = mergeEntries([]);
              selectedId = entries[0] ? entries[0].id : '';
              if (includeRemote) toast(errText(e), 'warn');
            } finally {
              if (!closed && mySeq === loadSeq) {
                loading = false;
                syncing = false;
                syncBtn.disabled = false;
                renderAll(true);
              }
            }
          }

          let unregModal = null;
          let pressedOutside = false;
          const isOutside = (e) => {
            if (typeof dialog.getBoundingClientRect !== 'function') return false;
            const r = dialog.getBoundingClientRect();
            return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
          };
          const needLightDismissFallback = typeof HTMLDialogElement === 'undefined' || !('closedBy' in HTMLDialogElement.prototype);
          const onPointerDown = (e) => { pressedOutside = isOutside(e); };
          const onPointerUp = (e) => { if (pressedOutside && isOutside(e)) closeDialog(); pressedOutside = false; };
          if (needLightDismissFallback) {
            dialog.addEventListener('pointerdown', onPointerDown);
            dialog.addEventListener('pointerup', onPointerUp);
          }

          function cleanupDialog() {
            if (closed) return;
            closed = true;
            if (state.changelogClose === closeDialog) state.changelogClose = null;
            if (unregModal) { unregModal(); unregModal = null; }
            try { dialog.returnValue = ''; } catch (_) {}
            listEl.removeEventListener('keydown', onListKey);
            if (needLightDismissFallback) {
              dialog.removeEventListener('pointerdown', onPointerDown);
              dialog.removeEventListener('pointerup', onPointerUp);
            }
            dialog.removeEventListener('close', cleanupDialog);
            try { dialog.remove(); } catch (_) {}
          }

          function closeDialog() {
            if (closed) return;
            if (typeof dialog.close === 'function' && dialog.open) {
              try { dialog.close(); } catch (_) { cleanupDialog(); }
            } else {
              cleanupDialog();
            }
          }

          dialog.addEventListener('close', cleanupDialog);
          state.changelogClose = closeDialog;
          if (typeof UI.registerModalClose === 'function') {
            unregModal = UI.registerModalClose(closeDialog);
          }

          modalRoot.appendChild(dialog);
          if (typeof dialog.showModal === 'function') {
            try {
              dialog.showModal();
            } catch (_) {
              dialog.setAttribute('open', '');
              dialog.classList.add('cl-dialog-fallback');
            }
          } else {
            dialog.setAttribute('open', '');
            dialog.classList.add('cl-dialog-fallback');
          }

          // 若已传入新版本内容，先同步首帧绘制，再异步补齐全部历史版本列表（无闪烁且兼容同步检测）
          entries = mergeEntries([]);
          if (fo.ver) {
            const hit = entries.find((x) => x.version.toLowerCase() === String(fo.ver).toLowerCase());
            if (hit) selectedId = hit.id;
          } else if (entries[0]) {
            selectedId = entries[0].id;
          }
          renderAll(false);
          loadChangelog(false);
        }

        const resultCard = (() => {
          if (state.updError) {
            return h('div', { class: 'upd-box warn' },
              h('div', { class: 'upd-box-title', text: T('检查或下载失败', 'Update failed') }),
              h('div', { class: 'small muted', text: state.updError })
            );
          }
          if (!chk && !staged) return null;
          if (chk && !hasNew && !staged) {
            return h('div', { class: 'upd-box ok' },
              h('div', { class: 'upd-box-title', text: T('当前已是最新版本', 'You are up to date') }),
              h('div', {
                class: 'small muted',
                text: T(`当前版本 v${chk.currentVersion}，远端最新 v${chk.latestVersion}`, `Current v${chk.currentVersion}, latest v${chk.latestVersion}`)
              })
            );
          }
          const targetVer = (chk && chk.latestVersion) || (staged && staged.version) || '';
          const pkgKind = (staged && staged.packageKind) || (chk && chk.packageKind) || kind;
          const pkgSize = (staged && staged.size) || (chk && chk.size) || 0;
          const pkgSha = (staged && staged.sha256) || (chk && chk.sha256) || '';
          const isReady = !!(staged && staged.version === targetVer);
          const summaryLine = extractReleaseSummary(chk && chk.notes);
          const dateLabel = fmtReleaseDate(chk && chk.pubDate);
          return h('div', { class: 'upd-box accent' },
            h('div', { class: 'row wrap upd-box-head' },
              h('span', { class: 'badge ok', text: isReady ? T('更新已就绪', 'Ready to install') : T('发现新版本', 'New release') }),
              h('strong', { class: 'mono', text: 'v' + targetVer }),
              dateLabel ? h('span', { class: 'small muted', text: dateLabel }) : null,
              pkgSize > 0 ? h('span', { class: 'small muted', text: fmtSize(pkgSize) }) : null,
              h('span', { class: 'badge', text: pkgKind === 'installer' ? T('安装包', 'Installer') : T('便携包', 'Portable') })
            ),
            summaryLine ? h('div', { class: 'upd-summary', text: summaryLine }) : null,
            h('div', { class: 'row wrap upd-acts' },
              isReady
                ? h('button', {
                  type: 'button',
                  class: 'btn primary sm',
                  disabled: state.updInstalling || state.updDownloading,
                  onclick: () => installStagedUpdate(targetVer, pkgKind)
                }, icon('refresh', 14), h('span', {
                  text: state.updInstalling ? T('正在准备安装…', 'Preparing…') : T('立即重启并安装更新', 'Restart & install update')
                }))
                : h('button', {
                  type: 'button',
                  class: 'btn primary sm',
                  disabled: state.updDownloading || state.updChecking,
                  onclick: startUpdateDownload
                }, icon('download', 14), h('span', {
                  text: state.updDownloading ? T('下载中…', 'Downloading…') : T('下载更新包', 'Download update')
                })),
              h('button', {
                type: 'button',
                class: 'btn ghost sm',
                onclick: () => openChangelogModal({
                  ver: targetVer,
                  pubDate: chk && chk.pubDate,
                  pkgKind,
                  pkgSize,
                  pkgSha,
                  notes: chk && chk.notes,
                  isReady,
                  stagedPath: staged && staged.path
                })
              }, icon('log', 13), h('span', { text: T('查看更新日志', 'Release notes') }))
            )
          );
        })();

        const body = h('div', { class: 'stack' },
          h('div', { class: 'set-card' },
            h('dl', { class: 'kv' },
              kvRow(T('当前版本', 'Current version'), h('div', { class: 'row wrap' },
                h('span', { class: 'mono', text: 'v' + curVer }),
                h('span', { class: 'badge', text: kindLabel })
              )),
              kvRow(T('上次检查', 'Last checked'), h('span', {
                class: 'small muted',
                text: (st && st.config && st.config.lastCheckAt) || T('从未检查', 'Never')
              }))
            )
          ),
          h('div', { class: 'set-card' },
            setRow(T('更新通道', 'Channel'),
              h('div', { class: 'row wrap' },
                [
                  { value: 'stable', zh: '稳定版（推荐）', en: 'Stable (recommended)' },
                  { value: 'beta', zh: '测试版（含预发布）', en: 'Beta (prereleases)' }
                ].map((ch) => h('label', { class: 'check' },
                  h('input', {
                    type: 'radio',
                    name: 'set-upd-channel',
                    checked: state.updChannel === ch.value,
                    onchange: () => onUpdaterChannel(ch.value)
                  }),
                  h('span', { text: T(ch.zh, ch.en) })
                ))
              )
            ),
            setRow(T('启动时静默检查', 'Auto-check on launch'),
              h('label', { class: 'check' },
                h('input', {
                  type: 'checkbox',
                  checked: !!state.updAutoCheck,
                  onchange: (e) => onUpdaterAutoCheck(e.target.checked)
                }),
                h('span', { text: T('后台自动检查官方新版本，不阻塞启动', 'Checks for official updates silently in the background') })
              )
            )
          ),
          chkWrap,
          progWrap,
          resultCard,
          h('div', { class: 'action-bar' },
            h('div', { class: 'row wrap', style: { gap: '8px', alignItems: 'center' } },
              h('span', {
                class: 'small muted',
                text: cacheBytes > 0
                  ? T('本地更新缓存：', 'Update cache: ') + fmtSize(cacheBytes)
                  : T('自动校验 SHA-256，安全无损升级', 'SHA-256 verified safe upgrades')
              }),
              cacheBytes > 0
                ? h('button', {
                  type: 'button',
                  class: 'upd-link-btn',
                  disabled: state.updDownloading || state.updInstalling,
                  onclick: (ev) => clearUpdaterCache(ev && ev.currentTarget)
                }, T('清理缓存', 'Clear'))
                : null
            ),
            h('div', { class: 'spacer' }),
            h('button', {
              type: 'button',
              class: 'btn sm',
              onclick: () => openChangelogModal()
            }, icon('log', 14), h('span', { text: T('查看更新日志', 'Changelog') })),
            h('button', {
              type: 'button',
              class: 'btn sm primary',
              disabled: state.updChecking || state.updDownloading,
              onclick: checkForUpdates
            }, state.updChecking ? h('span', { class: 'btn-spin', 'aria-hidden': 'true' }) : icon('refresh', 14), h('span', {
              text: state.updChecking ? T('检查中…', 'Checking…') : T('立即检查更新', 'Check for updates')
            }))
          )
        );

        return section(T('版本与在线更新', 'Version & updates'), body, {
          open: state.openId === 'updater',
          hint: hasNew
            ? T('有新版本 v' + chk.latestVersion, 'Update v' + chk.latestVersion)
            : T('v' + curVer + ' · 检查与升级', 'v' + curVer + ' · Updates'),
          id: 'updater',
          accordion: holder,
          onToggle: (open) => { if (open) state.openId = 'updater'; }
        });
      }

      async function loadUpdater() {
        if (typeof API.updaterStatus !== 'function') return;
        try {
          const st = await API.updaterStatus();
          state.updStatus = st;
          state.updDownloading = !!(st && st.busy);
          if (st && st.config) {
            state.updChannel = st.config.channel === 'beta' ? 'beta' : 'stable';
            state.updAutoCheck = st.config.autoCheck !== false;
          }
        } catch (e) { /* 离线或测试环境无此命令时静默忽略 */ }
      }

      async function openExternalUrl(url) {
        if (!url) return;
        try { await API.openPath(url); } catch (e) { toast(errText(e), 'error'); }
      }

      function clearSettingsUpdateDot() {
        const navBtn = document.querySelector && document.querySelector('.nav-item[data-id="settings"]');
        if (navBtn && navBtn.classList) navBtn.classList.remove('has-update');
      }

      async function onUpdaterChannel(channel) {
        state.updChannel = channel;
        try {
          await API.updaterConfigSet({ channel });
          await loadUpdater();
          toast(T('更新通道已切换', 'Update channel saved'), 'ok');
        } catch (e) {
          toast(errText(e), 'error');
        }
        paint();
      }

      async function onUpdaterAutoCheck(enabled) {
        state.updAutoCheck = !!enabled;
        try {
          await API.updaterConfigSet({ autoCheck: state.updAutoCheck });
        } catch (e) {
          toast(errText(e), 'error');
        }
      }

      function syncUpdaterCheckDom() {
        const d = state.updCheckDom;
        if (!d) return;
        d.wrap.hidden = !state.updChecking;
        const p = state.updCheckProg;
        if (!p) return;
        if (typeof p.stage === 'string' && p.stage) d.text.textContent = p.stage;
        if (typeof p.percent === 'number') {
          const v = Math.max(0, Math.min(100, Math.round(p.percent)));
          d.pct.textContent = v + '%';
          d.fill.style.width = v + '%';
        }
      }

      async function checkForUpdates() {
        if (state.updChecking || state.updDownloading) return;
        state.updChecking = true;
        state.updError = null;
        state.updCheckProg = { stage: T('正在连接官方更新源…', 'Connecting to official update server…'), percent: 10 };
        paint();
        try {
          const res = await API.updaterCheck(state.updChannel);
          state.updCheck = res;
          if (App) App._pendingUpdate = (res && res.hasUpdate) ? res : null;
          await loadUpdater();
          if (res && res.hasUpdate) {
            toast(T('发现新版本 v' + res.latestVersion, 'New version v' + res.latestVersion + ' available'), 'ok');
          } else {
            clearSettingsUpdateDot();
            toast(T('当前已是最新版本', 'Already up to date'), 'ok');
          }
        } catch (e) {
          state.updError = errText(e);
          toast(state.updError, 'error');
        } finally {
          state.updChecking = false;
          state.updCheckProg = null;
          paint();
        }
      }

      async function startUpdateDownload() {
        const chk = state.updCheck;
        if (!chk || !chk.hasUpdate || state.updDownloading) return;
        state.updDownloading = true;
        state.updCancelling = false;
        state.updError = null;
        state.updProg = { phase: 'downloading', downloaded: 0, total: chk.size || 0, speedBps: 0, percent: 0 };
        paint();
        try {
          const staged = await API.updaterDownload({
            url: chk.downloadUrl,
            sha256: chk.sha256,
            size: chk.size,
            version: chk.latestVersion,
            fileName: chk.fileName,
            packageKind: chk.packageKind
          });
          state.updCheck = Object.assign({}, chk, { staged });
          await loadUpdater();
          toast(T('更新包下载并校验通过，随时可点击安装', 'Update verified and ready to install'), 'ok');
        } catch (e) {
          const msg = errText(e);
          if (!/取消/.test(msg)) {
            state.updError = msg;
            toast(msg, 'error');
          } else {
            toast(T('已取消更新下载', 'Update download cancelled'), 'info');
          }
        } finally {
          state.updDownloading = false;
          state.updCancelling = false;
          state.updProg = null;
          paint();
        }
      }

      async function cancelUpdateDownload() {
        if (!state.updDownloading || state.updCancelling) return;
        state.updCancelling = true;
        syncUpdaterProgressDom();
        try { await API.updaterCancel(); } catch (e) { /* ignore */ }
      }

      async function skipUpdateVersion(ver) {
        try {
          await API.updaterConfigSet({ ignoredVersion: ver });
          if (state.updCheck) state.updCheck = Object.assign({}, state.updCheck, { isIgnored: true });
          if (App) App._pendingUpdate = null;
          clearSettingsUpdateDot();
          toast(T(`已跳过 v${ver}，后续不会主动提醒此版本`, `Skipped v${ver}`), 'ok');
          await loadUpdater();
          paint();
        } catch (e) {
          toast(errText(e), 'error');
        }
      }

      async function clearUpdaterCache(btn) {
        const run = async () => {
          try {
            await API.updaterClearCache();
            if (state.updCheck) state.updCheck = Object.assign({}, state.updCheck, { staged: null });
            await loadUpdater();
            toast(T('更新缓存已清理', 'Update cache cleared'), 'ok');
            paint();
          } catch (e) {
            toast(errText(e), 'error');
          }
        };
        if (btn && typeof withButtonBusy === 'function') {
          await withButtonBusy(btn, T('清理中…', 'Clearing…'), run);
        } else {
          await busy(run, T('正在清理更新缓存…', 'Clearing update cache…'), 'settings');
        }
      }

      async function installStagedUpdate(ver, pkgKind) {
        if (state.updInstalling) return;
        const ok = await confirm({
          title: T(`安装更新 v${ver}`, `Install update v${ver}`),
          body: pkgKind === 'portable'
            ? T('应用将立即退出，自动备份当前便携版程序并替换为新版本（你的配置、历史与数据目录会完整保留），完成后自动重启。',
              'The app will close, back up current binaries, swap in the new portable build (preserving all user data), and restart.')
            : T('应用将立即退出并启动新版安装程序完成覆盖升级（你的配置、历史与数据目录会完整保留）。',
              'The app will close and launch the new installer (preserving all user data).'),
          ok: T('立即重启更新', 'Restart & update')
        });
        if (!ok) return;
        state.updInstalling = true;
        paint();
        try {
          await API.updaterInstall(false);
          toast(T('正在退出并启动更新…', 'Restarting to install update…'), 'ok');
        } catch (e) {
          state.updInstalling = false;
          state.updError = errText(e);
          toast(state.updError, 'error');
          paint();
        }
      }

      function secMaintenance(holder) {
        const app = state.app;
        const eng = state.engine;
        const status = eng
          ? (eng.pid > 0
            ? h('span', { class: 'badge ok', text: T('运行中', 'Running') })
            : h('span', { class: 'badge warn', text: T('未启动', 'Not running') }))
          : h('span', { class: 'badge', text: T('未知', 'Unknown') });

        const dataDirPath = (app && app.data_dir) || (state.settings && state.settings.data_dir) || '';
        const dataDirRow = h('div', { class: 'row' },
          h('input', {
            class: 'input grow mono', readonly: true, spellcheck: 'false',
            value: dataDirPath || '—', title: dataDirPath || ''
          }),
          h('button', {
            type: 'button',
            class: 'btn ghost sm icon', disabled: !dataDirPath,
            title: T('在软件内打开目录', 'Browse folder in app'), 'aria-label': T('在软件内打开目录', 'Browse folder in app'),
            onclick: () => openInApp(dataDirPath)
          }, icon('scan', 14)),
          h('button', {
            type: 'button',
            class: 'btn ghost sm icon', disabled: !dataDirPath,
            title: T('在系统文件管理器中打开', 'Open in system file manager'), 'aria-label': T('在系统文件管理器中打开', 'Open in system file manager'),
            onclick: () => reveal(dataDirPath)
          }, icon('external', 14)),
          h('button', {
            class: 'btn sm',
            disabled: state.dataMigrating,
            onclick: pickDataDir
          }, icon('folder', 14),
            h('span', { text: state.dataMigrating ? T('迁移中…', 'Migrating…') : T('更改并迁移…', 'Change & migrate…') }))
        );

        const body = h('div', { class: 'stack' },
          state.appError
            ? empty(T('应用信息读取失败', 'Could not read app info'), state.appError)
            : h('div', { class: 'set-card' },
              h('dl', { class: 'kv' },
                kvRow(T('版本', 'Version'), h('span', { class: 'mono', text: (app && app.version) || '—' })),
                kvRow(T('程序目录', 'Program folder'), pathRow(app && app.exe_dir)),
                kvRow(T('数据目录', 'Data folder'), dataDirRow),
                kvRow(T('日志目录', 'Log folder'), h('div', { class: 'stack', style: { gap: '4px' } },
                  pathRow(app && app.log_dir),
                  h('span', { class: 'small muted', text: T('日志、缓存与索引统一存放在数据目录下，更改数据目录时会自动整体迁移并重建', 'Logs, cache and indexes live inside the data folder and follow it automatically') })
                )),
                kvRow(T('引擎状态', 'Engine'), h('div', { class: 'row' }, status,
                  h('span', { class: 'small muted', text: eng && eng.pid ? 'PID ' + eng.pid : '' }))),
                kvRow(T('权限', 'Privileges'), state.admin
                  ? h('span', { class: 'badge ok', text: T('管理员', 'Administrator') })
                  : h('span', { class: 'badge warn', text: T('普通权限', 'Standard user') }))
              )
            ),
          h('div', { class: 'action-bar' },
            h('span', { class: 'small muted', text: T('数据目录与日志目录全局统一；更改后自动一次性迁移并重启生效', 'Data and log folders stay unified; changing migrates and restarts automatically') }),
            h('div', { class: 'spacer' }),
            h('button', { class: 'btn sm', onclick: (ev) => refreshMaintenance(ev && ev.currentTarget) }, icon('refresh', 14), h('span', { text: T('刷新', 'Refresh') }))
          ),
          state.engineError ? h('div', { class: 'small muted', text: state.engineError }) : null
        );

        return section(T('数据与维护', 'Data & maintenance'), body, {
          open: state.openId === 'maintenance',
          hint: T('目录与引擎', 'Folders and engine'),
          id: 'maintenance',
          accordion: holder,
          onToggle: (open) => { if (open) state.openId = 'maintenance'; }
        });
      }

      async function refreshMaintenance(btn) {
        const run = async () => {
          await Promise.all([loadAbout(), loadAdmin(), loadSettings()]);
          paint();
          toast(T('已刷新', 'Refreshed'), 'ok');
        };
        if (btn && typeof withButtonBusy === 'function') {
          await withButtonBusy(btn, T('刷新中…', 'Refreshing…'), run);
        } else {
          await busy(run, T('正在刷新运行状态…', 'Refreshing status…'), 'settings');
        }
      }

      /* ---------- 数据加载 ---------- */
      async function loadConfig() {
        try {
          const fresh = await API.configGet();
          state.theme = normTheme(fresh.theme);
          state.lang = normLang(fresh.lang);
          state.closeAction = normClose(fresh.close_action);
        } catch (e) { /* 保留 App.cfg */ }
      }

      async function loadSettings() {
        state.settingsError = null;
        try {
          const s = await API.engine('settings.get', {});
          const value = {
            data_dir: String((s && s.data_dir) || ''),
            recursive_depth: Number(s && s.recursive_depth) || 1,
            conflict_policy: (s && s.conflict_policy) || 'rename',
            log_keep_days: Number(s && s.log_keep_days) || 30,
            default_recursive: !!(s && s.default_recursive),
            default_content: !!(s && s.default_content),
            index_freshness: (s && s.index_freshness) || 'check',
            index_max_mb: Number(s && s.index_max_mb) || 2048,
            index_rebuild_idle: s && s.index_rebuild_idle !== undefined ? !!s.index_rebuild_idle : true,
            prune_enabled: s && s.prune_enabled !== undefined ? !!s.prune_enabled : true,
            prune_history_keep: s && s.prune_history_keep !== undefined ? Number(s.prune_history_keep) : 50,
            prune_thumbs_mb: s && s.prune_thumbs_mb !== undefined ? Number(s.prune_thumbs_mb) : 256,
            prune_backup_keep: s && s.prune_backup_keep !== undefined ? Number(s.prune_backup_keep) : 3
          };
          state.settings = value;
          state.original = Object.assign({}, value);
        } catch (e) {
          state.settings = null;
          state.original = null;
          state.settingsError = errText(e);
          toast(state.settingsError, 'error');
        }
      }

      async function loadAutostart() {
        try { state.autostart = !!(await API.getAutostart()); } catch (e) { state.autostart = false; }
      }

      async function loadSchedule() {
        try {
          const sc = await API.scheduleGet();
          state.scheduleExists = !!(sc && sc.exists);
          state.schedule = {
            enabled: state.scheduleExists,
            time: (sc && sc.time) || '03:00',
            days: Number(sc && sc.days) || 30,
            cache: !(sc && sc.cache === false),
            screenshots: !(sc && sc.screenshots === false)
          };
        } catch (e) { state.scheduleExists = false; }
      }

      async function loadAbout() {
        try { state.app = await API.appInfo(); } catch (e) { state.appError = errText(e); }
        try { state.engine = await API.engineInfo(); } catch (e) { state.engineError = errText(e); }
      }

      async function loadAdmin() {
        try { state.admin = !!(await API.isAdmin()); } catch (e) { state.admin = false; }
      }

      async function reveal(path) {
        if (!path) return;
        try { await API.reveal(path); } catch (e) { toast(errText(e), 'error'); }
      }

      /* 未保存修改时拦截侧栏跳转 */
      function bindNavGuard() {
        if (guardBound) return;
        guardBound = true;
        document.addEventListener('click', (e) => {
          if (!active || !active.root.isConnected) return;
          const nav = e.target && e.target.closest ? e.target.closest('.nav-item') : null;
          if (!nav) return;
          const id = nav.dataset ? nav.dataset.id : '';
          if (!id || id === 'settings') return;
          const st = active.state;
          if (!st || !st.settings || !st.original) return;
          const dirty = ['recursive_depth', 'conflict_policy', 'log_keep_days', 'default_recursive', 'default_content']
            .some((k) => st.settings[k] !== st.original[k]);
          if (!dirty) return;
          e.preventDefault();
          e.stopPropagation();
          confirm({
            title: T('有未保存的修改', 'Unsaved changes'),
            body: T('离开设置页会丢失尚未保存的整理默认值，仍要离开吗？', 'Leaving will discard unsaved tidy defaults. Leave anyway?'),
            ok: T('离开', 'Leave'),
            danger: true
          }).then((ok) => { if (ok) window.navigate(id); });
        }, true);
      }

      setActions();

      liveJump = function (payload) {
        const sec = payload && (payload.section || payload.tab || payload.id);
        if (!sec) return;
        state.openId = String(sec);
        paint();
        const node = root.querySelector('[data-section="' + state.openId + '"]');
        if (node && node.scrollIntoView) node.scrollIntoView({ block: 'start', behavior: 'smooth' });
      };

      active = { root, state, paint };
      bindNavGuard();
      paint();

      let unlistenUpd = null;
      let unlistenUpdCheck = null;
      let unlistenDataMig = null;
      try {
        if (window.__TAURI__ && window.__TAURI__.event && typeof window.__TAURI__.event.listen === 'function') {
          unlistenUpd = await window.__TAURI__.event.listen('updater-progress', (ev) => {
            if (!active || active.root !== root) return;
            const p = (ev && ev.payload) || null;
            if (!p) return;
            state.updProg = p;
            syncUpdaterProgressDom();
          });
          unlistenUpdCheck = await window.__TAURI__.event.listen('updater-check-progress', (ev) => {
            if (!active || active.root !== root) return;
            const p = (ev && ev.payload) || null;
            if (!p) return;
            state.updCheckProg = p;
            syncUpdaterCheckDom();
          });
          unlistenDataMig = await window.__TAURI__.event.listen('data-dir-migrate-progress', (ev) => {
            if (!active || active.root !== root) return;
            const p = (ev && ev.payload) || null;
            if (!p || !activeMigModal) return;
            activeMigModal.update({
              text: p.detail || T('正在迁移数据…', 'Migrating data…'),
              sub: p.current ? T('当前处理：' + p.current, 'Current: ' + p.current)
                : T('请勿关闭软件，完成后将自动重启生效', 'Please keep the app open until finished'),
              percent: typeof p.percent === 'number' ? p.percent : undefined
            });
          });
        }
      } catch (e) { /* 非 Tauri 环境跳过事件监听 */ }

      await Promise.all([loadConfig(), loadSettings(), loadAutostart(), loadSchedule(), loadAbout(), loadAdmin(), loadAi(), loadUpdater()]);
      state.loading = false;
      if (state.theme === 'system') await applySystemTheme();
      paint();

      return function unmount() {
        if (unlistenUpd) { try { unlistenUpd(); } catch (e) { /* ignore */ } unlistenUpd = null; }
        if (unlistenUpdCheck) { try { unlistenUpdCheck(); } catch (e) { /* ignore */ } unlistenUpdCheck = null; }
        if (unlistenDataMig) { try { unlistenDataMig(); } catch (e) { /* ignore */ } unlistenDataMig = null; }
        if (activeMigModal) { try { activeMigModal.close(); } catch (e) { /* ignore */ } activeMigModal = null; }
        if (state.changelogClose) { try { state.changelogClose(); } catch (e) { /* ignore */ } state.changelogClose = null; }
        state.updProgDom = null;
        state.updCheckDom = null;
        liveJump = null;
        active = null;
        setActions();
      };
    },

    jump(payload) { return liveJump ? liveJump(payload || {}) : undefined; }
  };
})();
