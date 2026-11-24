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
    subtitle: ['通用、整理策略、定时清理、AI 助手与版本数据', 'General, tidy defaults, schedule, AI and updates'],

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
        moreOpen: { defaults: false, aiAdv: false, aiPerm: null },
        openId: 'general'
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

      function openInApp(path) {
        if (!path) return;
        if (window.AIEntries && typeof window.AIEntries.open === 'function') window.AIEntries.open(path);
        else reveal(path);
      }

      /* 统一极简设置原语：与「版本」卡片同一套设计语言（左标题 + 右控件、分段胶囊、轻量开关、按需折叠抽屉） */
      const setRow = (label, node, desc, tail) => h('div', { class: 'set-row' },
        h('div', { class: 'set-label', text: label }),
        h('div', { class: 'set-body' },
          node,
          desc ? h('div', { class: 'desc', text: desc, title: desc }) : null,
          tail || null)
      );
      const setLine = (label, ctrl, desc) => h('div', { class: 'set-line' },
        h('div', { class: 'set-line-info' },
          h('span', { class: 'set-line-title', text: label }),
          desc ? h('span', { class: 'set-line-desc', text: desc, title: desc }) : null
        ),
        h('div', { class: 'set-line-ctrl' }, ctrl)
      );
      const setSeg = (options, activeVal, onSelect, opts) => {
        const o = opts || {};
        return h('div', {
          class: 'set-seg' + (o.className ? ' ' + o.className : ''),
          role: 'radiogroup',
          'aria-label': o.label || ''
        }, ...options.map((item) => {
          const isOn = item.value === activeVal;
          return h('button', {
            type: 'button',
            role: 'radio',
            'aria-checked': isOn ? 'true' : 'false',
            class: 'set-seg-btn' + (isOn ? ' active' : '') + (item.danger ? ' is-danger' : ''),
            title: item.tip || '',
            disabled: !!(o.disabled || item.disabled),
            onclick: () => { if (!isOn && typeof onSelect === 'function') onSelect(item.value); }
          }, item.label);
        }));
      };
      const setSwitch = (checked, onChange, opts) => {
        const o = opts || {};
        const input = h('input', {
          type: 'checkbox',
          role: 'switch',
          class: 'set-switch-in',
          checked: !!checked,
          disabled: !!o.disabled,
          'aria-label': o.ariaLabel || o.label || '',
          onchange: (e) => { if (typeof onChange === 'function') onChange(!!e.target.checked, e); }
        });
        return h('label', {
          class: 'set-switch' + (o.disabled ? ' is-disabled' : ''),
          title: o.title || ''
        },
          o.label ? h('span', { class: 'set-switch-text', text: o.label }) : null,
          input,
          h('span', { class: 'set-switch-track', 'aria-hidden': 'true' })
        );
      };
      const setMore = (title, content, opts) => {
        const o = opts || {};
        const det = h('details', {
          class: 'set-more' + (o.className ? ' ' + o.className : ''),
          open: o.open ? '' : false,
          ontoggle: (e) => { if (typeof o.onToggle === 'function') o.onToggle(!!e.target.open); }
        },
          h('summary', { class: 'set-more-sum' },
            h('span', { class: 'set-more-title', text: title }),
            o.badge ? h('span', { class: 'set-more-meta', text: o.badge }) : null
          ),
          h('div', { class: 'set-more-body' }, content)
        );
        return det;
      };

      /* ---------- 顶层（精简为 5 组极简卡片区块，消除重复设置） ---------- */
      function paint() {
        root.textContent = '';
        state.openModelReport = null;
        const staleModal = state.modelModal;
        state.modelModal = null;
        if (staleModal) { try { staleModal.close(); } catch (e) { /* 已经关了 */ } }
        const holder = h('div', { class: 'stack set-page-stack' });
        holder.appendChild(secGeneral(holder));
        holder.appendChild(secDefaults(holder));
        holder.appendChild(secSchedule(holder));
        holder.appendChild(secAssistant(holder));
        holder.appendChild(secUpdater(holder));
        root.appendChild(holder);
        if (state.autoOpenModels) {
          state.autoOpenModels = false;
          const open = state.openModelReport;
          if (open) setTimeout(open, 0);
        }
      }

      /* ---------- 1. 通用（融合原外观与语言、行为与启动、性能三块） ---------- */
      function secGeneral(holder) {
        const modes = [
          { value: 'balanced', label: T('均衡', 'Balanced'), tip: T('完整动画，隐藏 2 分钟后释放引擎', 'Full motion; releases engine 2 min after hiding') },
          { value: 'silent', label: T('静默', 'Silent'), tip: T('精简动画，隐藏 20 秒后释放引擎并停轮询', 'Lite motion; releases engine after 20 s') },
          { value: 'turbo', label: T('高性能', 'Turbo'), tip: T('常驻引擎，切页与扫描响应最快', 'Keeps engine warm for instant responses') }
        ];
        const activeMode = modes.find((m) => m.value === state.mode) || modes[0];

        const cardBasic = h('div', { class: 'set-card' },
          setLine(T('主题', 'Theme'),
            setSeg(
              THEMES.map((t) => ({ value: t.value, label: T(t.zh, t.en) })),
              state.theme,
              (v) => onTheme(v),
              { label: T('主题', 'Theme') }
            )
          ),
          setLine(T('界面语言', 'Language'),
            setSeg(
              LANGS.map((l) => ({ value: l.value, label: T(l.zh, l.en) })),
              state.lang,
              (v) => onLang(v),
              { label: T('界面语言', 'Language') }
            )
          ),
          setLine(T('关闭窗口时', 'On close'),
            setSeg(
              CLOSE_ACTIONS.map((c) => ({ value: c.value, label: T(c.zh, c.en) })),
              state.closeAction,
              (v) => onCloseAction(v),
              { label: T('关闭窗口时', 'On close') }
            )
          ),
          setLine(T('开机自动启动', 'Start with Windows'),
            setSwitch(state.autostart, (v) => onAutostart(v), {
              disabled: state.autostartBusy,
              ariaLabel: T('开机自动启动', 'Start with Windows')
            })
          ),
          setLine(T('运行权限', 'Privileges'),
            h('div', { class: 'set-inline-group' },
              h('span', {
                class: 'set-pill ' + (state.admin ? 'is-ok' : 'is-warn'),
                text: state.admin ? T('管理员', 'Administrator') : T('普通权限', 'Standard user')
              }),
              !state.admin
                ? h('button', {
                  type: 'button',
                  class: 'set-outline-btn',
                  onclick: onRunAsAdmin
                }, icon('shield', 14), h('span', { text: T('以管理员重启', 'Restart as admin') }))
                : null
            ),
            !state.admin ? T('清理系统级目录或管理受保护启动项时需要管理员权限', 'Needed for protected folders or system items') : ''
          )
        );

        const cardPerf = h('div', { class: 'set-card' },
          setLine(T('运行模式', 'Power mode'),
            setSeg(modes, state.mode, async (v) => {
              state.mode = v;
              await App.setPowerMode(v);
              state.motion = (App.cfg && App.cfg.motion) || (v === 'silent' ? 'lite' : 'full');
              paint();
            }, { label: T('运行模式', 'Power mode') }),
            activeMode.tip
          ),
          setLine(T('动画强度', 'Motion'),
            setSeg([
              { value: 'full', label: T('完整', 'Full') },
              { value: 'lite', label: T('精简', 'Lite') },
              { value: 'off', label: T('关闭', 'Off') }
            ], state.motion, (v) => {
              state.motion = v;
              App.setMotion(v);
              paint();
            }, { label: T('动画强度', 'Motion') })
          ),
          setLine(T('GPU 硬件加速', 'GPU acceleration'),
            setSwitch(!!state.gpu, async (checked) => {
              state.gpu = checked;
              App.cfg = Object.assign({}, App.cfg || {}, { gpu_accel: state.gpu });
              try { await API.configSet({ gpu_accel: state.gpu }); } catch { /* ignore */ }
              toast(T('GPU 设置已保存，重启软件后生效', 'Saved. Restart the app to apply.'), 'ok');
            }, { ariaLabel: T('GPU 硬件加速', 'GPU acceleration') }),
            T('关闭可降低显存占用，重启后生效', 'Lower GPU memory usage; takes effect after restart')
          )
        );

        const themeName = (THEMES.find((t) => t.value === state.theme) || THEMES[0]);
        return section(T('通用', 'General'), h('div', { class: 'stack' }, cardBasic, cardPerf), {
          open: state.openId === 'general',
          hint: T(themeName.zh, themeName.en) + ' · ' + activeMode.label,
          id: 'general',
          accordion: holder,
          onToggle: (open) => { if (open) state.openId = 'general'; }
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
          body = skeleton(4, 'settings');
        } else if (!state.settings) {
          body = h('div', { class: 'stack' },
            empty(T('引擎设置读取失败', 'Could not read engine settings'), state.settingsError || ''),
            h('div', { class: 'toolbar' },
              h('button', { class: 'set-outline-btn', type: 'button', onclick: retrySettings },
                icon('refresh', 14), h('span', { text: T('重试', 'Retry') }))
            )
          );
        } else {
          const s = state.settings;
          const depthInput = h('input', {
            class: 'input set-num-in', type: 'number', min: '1', max: '4', step: '1',
            'aria-label': T('递归深度', 'Recursive depth'),
            value: String(s.recursive_depth),
            oninput: (e) => { s.recursive_depth = Number(e.target.value); paintHint(); }
          });
          const keepInput = h('input', {
            class: 'input', type: 'number', min: '1', max: '3650', step: '1',
            value: String(s.log_keep_days),
            oninput: (e) => { s.log_keep_days = Number(e.target.value); paintHint(); }
          });
          const capInput = h('input', {
            class: 'input set-num-md', type: 'number', min: '0', max: '65536', step: '128',
            value: String(s.index_max_mb),
            oninput: (e) => { s.index_max_mb = Number(e.target.value); paintHint(); }
          });
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

          const freshOpts = [
            { value: 'live', label: T('实时', 'Live'), tip: T('每分钟扫一次热目录', 'Rescan hot folders every minute') },
            { value: 'check', label: T('按需', 'On demand'), tip: T('每 10 分钟检查热目录（默认）', 'Check every 10 min (default)') },
            { value: 'manual', label: T('手动', 'Manual'), tip: T('不自动后台扫盘', 'Never auto-scan in background') }
          ];
          const activeFresh = freshOpts.find((x) => x.value === s.index_freshness) || freshOpts[1];
          const dirtyCount = dirtyKeys().length;

          const advContent = h('div', { class: 'set-more-inner' },
            setLine(T('索引上限 (MB)', 'Index cap (MB)'),
              h('div', { class: 'set-inline-group' },
                capInput,
                setSwitch(!!s.index_rebuild_idle, (v) => { s.index_rebuild_idle = v; paintHint(); }, {
                  label: T('空闲校验重建', 'Idle rebuild')
                })
              ),
              T('0 表示不限制；软件自身整理或删除的文件会即时同步', '0 means unlimited; in-app moves/deletes sync instantly')
            ),
            setLine(T('自动精简本地数据', 'Auto-prune local data'),
              h('div', { class: 'set-inline-group' },
                h('button', {
                  type: 'button',
                  class: 'set-text-btn',
                  onclick: previewPrune
                }, T('清理预演', 'Preview')),
                setSwitch(s.prune_enabled !== false, (v) => { s.prune_enabled = v; paintHint(); }, {
                  ariaLabel: T('自动精简本地数据', 'Auto-prune local data')
                })
              ),
              T('只保留最新数据，防止历史记录与缩略图缓存无限增长', 'Keep recent history and thumbs bounded automatically')
            ),
            h('div', { class: 'set-more-grid-wrap' },
              h('div', { class: 'set-quad' },
                h('div', { class: 'field' }, h('label', { text: T('日志保留 (天)', 'Log days') }), keepInput),
                h('div', { class: 'field' }, h('label', { text: T('整理历史 (份)', 'History keep') }), histKeepInput),
                h('div', { class: 'field' }, h('label', { text: T('缩略图 (MB)', 'Thumbs MB') }), thumbCapInput),
                h('div', { class: 'field' }, h('label', { text: T('卸载备份 (份)', 'Backups') }), bakKeepInput)
              )
            )
          );

          body = h('div', { class: 'stack' },
            h('div', { class: 'set-card' },
              setLine(T('同名冲突', 'Name clashes'),
                setSeg(
                  CONFLICTS.map((c) => ({ value: c.value, label: T(c.zh, c.en) })),
                  s.conflict_policy,
                  (v) => { s.conflict_policy = v; paint(); },
                  { label: T('同名冲突', 'Name clashes') }
                )
              ),
              setLine(T('默认递归子目录', 'Recurse subfolders'),
                h('div', { class: 'set-inline-group' },
                  h('span', { class: 'small muted', text: T('深度', 'Depth') }),
                  depthInput,
                  setSwitch(!!s.default_recursive, (v) => { s.default_recursive = v; paintHint(); }, {
                    ariaLabel: T('默认递归子目录', 'Recurse subfolders')
                  })
                ),
                T('深度范围 1–4 层，可在整理页随时临时调整', 'Depth 1–4; can be overridden per scan')
              ),
              setLine(T('按内容识别文件类型', 'Detect type by content'),
                setSwitch(!!s.default_content, (v) => { s.default_content = v; paintHint(); }, {
                  ariaLabel: T('按内容识别文件类型', 'Detect type by content')
                }),
                T('识别无扩展名或改错后缀的文件头，略微增加扫描耗时', 'Inspect file headers when extensions are missing or wrong')
              ),
              setLine(T('索引刷新', 'Index refresh'),
                h('div', { class: 'set-inline-group' },
                  setSeg(freshOpts, s.index_freshness, (v) => { s.index_freshness = v; paint(); }, {
                    label: T('索引刷新', 'Index refresh')
                  }),
                  h('button', {
                    type: 'button',
                    class: 'set-text-btn',
                    onclick: async () => {
                      await busy(async (ctrl) => {
                        ctrl && ctrl.setSub(T('正在扫描桌面/文档/下载等常用目录…', 'Scanning desktop, documents and downloads…'));
                        await API.engine('search.hot', { force: true });
                        toast(T('热目录已刷新', 'Hot folders refreshed'), 'ok');
                      }, T('正在刷新热目录索引…', 'Refreshing hot index…'), 'search');
                    }
                  }, T('刷新热目录', 'Refresh hot')),
                  h('button', {
                    type: 'button',
                    class: 'set-text-btn',
                    onclick: async () => {
                      await busy(async (ctrl) => {
                        ctrl && ctrl.setSub(T('正在检查并修复异常索引库…', 'Verifying and rebuilding index databases…'));
                        const r = await API.engine('search.selfcheck', { rebuild: true });
                        const n = (r && r.rebuilt && r.rebuilt.length) || 0;
                        toast(T('自检完成，重建 ' + n + ' 项', 'Selfcheck done, rebuilt ' + n + ' items'), 'ok');
                      }, T('正在自检索引，请稍候…', 'Checking index…'), 'search');
                    }
                  }, T('自检修复', 'Selfcheck'))
                ),
                activeFresh.tip
              ),
              setMore(T('高级配额与数据保留', 'Advanced quotas & retention'), advContent, {
                open: !!state.moreOpen.defaults,
                onToggle: (open) => { state.moreOpen.defaults = open; }
              })
            ),
            h('div', { class: 'action-bar set-foot-bar' },
              h('span', {
                class: 'small muted set-dirty-note',
                text: dirtyCount
                  ? T(`有 ${dirtyCount} 项待保存更改`, `${dirtyCount} unsaved change(s)`)
                  : T('改动仅写入引擎策略，不影响已有文件', 'Only updates engine defaults; existing files are untouched')
              }),
              h('div', { class: 'spacer' }),
              h('button', {
                type: 'button',
                class: 'btn primary sm',
                disabled: state.saving || !dirtyCount,
                onclick: saveDefaults
              }, h('span', { text: state.saving ? T('保存中…', 'Saving…') : T('保存', 'Save') }))
            )
          );
        }
        return section(T('整理与索引', 'Tidy & index'), body, {
          open: state.openId === 'defaults',
          hint: dirtyKeys().length ? T('有未保存修改', 'Unsaved changes') : T('冲突、扫描与索引', 'Clashes, scan & index'),
          id: 'defaults',
          accordion: holder,
          onToggle: (open) => { if (open) state.openId = 'defaults'; }
        });
      }

      /* 仅更新当前区块的 hint 与保存态，避免整页重绘丢失输入焦点 */
      function paintHint() {
        const sec = root.querySelector('[data-section="defaults"]');
        if (!sec) return;
        const n = dirtyKeys().length;
        const hint = sec.querySelector('.section-head .hint');
        if (hint) hint.textContent = n ? T('有未保存修改', 'Unsaved changes') : T('冲突、扫描与索引', 'Clashes, scan & index');
        const note = sec.querySelector('.set-dirty-note');
        if (note) {
          note.textContent = n
            ? T(`有 ${n} 项待保存更改`, `${n} unsaved change(s)`)
            : T('改动仅写入引擎策略，不影响已有文件', 'Only updates engine defaults; existing files are untouched');
        }
        const btn = sec.querySelector('.action-bar .btn.primary');
        if (btn) btn.disabled = state.saving || !n;
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
        if (!Number.isInteger(maxMb) || maxMb < 0 || maxMb > 65536) {
          toast(T('索引上限需为 0 到 65536 的整数（0 表示不限制）', 'Index cap must be an integer from 0 to 65536 (0 means no limit)'), 'warn');
          return;
        }
        const histKeep = Number(s.prune_history_keep);
        if (!Number.isInteger(histKeep) || histKeep < 0 || histKeep > 10000) {
          toast(T('整理历史保留份数需为 0 到 10000 的整数', 'History retention must be an integer from 0 to 10000'), 'warn');
          return;
        }
        const thumbsMb = Number(s.prune_thumbs_mb);
        if (!Number.isInteger(thumbsMb) || thumbsMb < 0 || thumbsMb > 65536) {
          toast(T('缩略图上限需为 0 到 65536 的整数', 'Thumbs cap must be an integer from 0 to 65536'), 'warn');
          return;
        }
        const bakKeep = Number(s.prune_backup_keep);
        if (!Number.isInteger(bakKeep) || bakKeep < 0 || bakKeep > 1000) {
          toast(T('卸载备份保留份数需为 0 到 1000 的整数', 'Backup retention must be an integer from 0 to 1000'), 'warn');
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

      /* ---------- 3. 定时清理（极简单卡融合） ---------- */
      function secSchedule(holder) {
        const sc = state.schedule;
        const timeInput = h('input', {
          class: 'input set-time-in', type: 'time', value: sc.time || '03:00',
          'aria-label': T('执行时间', 'Run time'),
          oninput: (e) => { sc.time = e.target.value; }
        });
        const daysInput = h('input', {
          class: 'input set-num-in', type: 'number', min: '1', max: '3650', value: String(sc.days || 30),
          'aria-label': T('截图保留天数', 'Screenshot keep days'),
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

        const body = h('div', { class: 'set-card' },
          setLine(T('每日定时清理', 'Daily scheduled clean'),
            h('div', { class: 'set-inline-group' },
              h('span', {
                class: 'set-pill ' + (state.scheduleExists ? 'is-ok' : ''),
                text: state.scheduleExists ? T('已启用', 'Active') : T('未启用', 'Off')
              }),
              setSwitch(!!sc.enabled, (v) => { sc.enabled = v; }, {
                ariaLabel: T('启用定时清理', 'Enable scheduled clean')
              }),
              h('button', {
                type: 'button',
                class: 'set-outline-btn',
                disabled: state.scheduleBusy,
                onclick: saveSchedule
              }, h('span', { text: state.scheduleBusy ? T('应用中…', 'Applying…') : T('应用', 'Apply') }))
            ),
            T('通过 Windows 计划任务每日运行，关闭软件也会执行', 'Runs daily via Windows Task Scheduler even when closed')
          ),
          setLine(T('执行时间', 'Run time'), timeInput),
          setLine(T('清理范围', 'Scope'),
            h('div', { class: 'set-inline-group' },
              h('label', { class: 'check' }, cacheCb, h('span', { text: T('安全缓存', 'Safe cache') })),
              h('label', { class: 'check' }, shotsCb, h('span', { text: T('早于', 'Screenshots >') })),
              daysInput,
              h('span', { class: 'small muted', text: T('天的截图', 'days') })
            ),
            T('删除内容进入回收站可随时还原；谨慎/高级项不会自动清理', 'Items move to Recycle Bin; caution/advanced items are never auto-cleaned')
          )
        );

        return section(T('定时清理', 'Scheduled clean'), body, {
          open: state.openId === 'schedule',
          hint: state.scheduleExists ? T('每日 ' + (sc.time || '03:00'), 'Daily ' + (sc.time || '03:00')) : T('未启用', 'Off'),
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
          ? h('span', { class: 'set-pill', text: T('测试中…', 'Testing…') })
          : (test
            ? (test.ok
              ? (test.warn
                ? h('span', { class: 'set-pill is-warn', text: T('连通但格式异常', 'Format mismatch') })
                : h('span', { class: 'set-pill is-ok', text: T('连接正常', 'Connected') + ' · ' + test.ms + ' ms' }))
              : h('span', { class: 'set-pill is-warn', text: T('连接失败', 'Failed') }))
            : (AIStore.isConfigured(d)
              ? h('span', { class: 'set-pill', text: T('已配置', 'Configured') })
              : h('span', { class: 'set-pill is-warn', text: T('未配置', 'Not configured') })));

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
          if (patch && Object.prototype.hasOwnProperty.call(patch, 'mode') && patch.mode !== base.mode) {
            state.moreOpen.aiPerm = next.mode !== 'off';
          }
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
          class: 'set-pill' + (pol.mode === 'off' ? '' : (pol.mode === 'full' ? ' is-warn' : ' is-ok')),
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
        const savedProviders = (AIStore.listProviders ? AIStore.listProviders() : []);
        const savedProviderStrip = savedProviders.length
          ? h('div', { class: 'ai-saved-chips' }, ...savedProviders.map((it) => {
            const usable = !!it.endpoint;
            return h('span', { class: 'ai-saved-chip' },
              h('button', {
                type: 'button',
                class: 'ai-saved-use',
                disabled: !usable,
                title: usable
                  ? T(`切回 ${it.host}（${it.model || '默认模型'} · ${it.masked || '无 Key'}）`,
                    `Switch to ${it.host} (${it.model || 'default'} · ${it.masked || 'no key'})`)
                  : T('无可用地址', 'No endpoint saved'),
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
              }, h('span', { class: 'mono', text: it.host })),
              h('button', {
                type: 'button',
                class: 'ai-saved-del',
                title: T('忘掉这一家的记录', 'Forget this provider'),
                'aria-label': T('忘掉 ' + it.host, 'Forget ' + it.host),
                onclick: async () => {
                  try {
                    await AIStore.forgetProvider(it.host);
                    toast(T('已忘掉 ' + it.host, 'Forgot ' + it.host), 'ok');
                    paint();
                  } catch (e) { toast(errText(e), 'error'); }
                }
              }, icon('close', 11))
            );
          }))
          : null;

        const fbList = () => (Array.isArray(d.fallbacks) ? d.fallbacks : []);
        const fbRowOf = (item, idx) => h('div', { class: 'row' },
          h('input', {
            class: 'input mono', spellcheck: 'false', value: item.endpoint || '',
            placeholder: T('备用接口地址', 'Fallback endpoint'),
            'aria-label': T('备用接口地址', 'Fallback endpoint'),
            oninput: (e) => { item.endpoint = e.target.value.trim(); state.aiTest = null; },
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
                d.fallbacks = fbList().concat([{ endpoint: '', model: '' }]);
                paint();
              }
            }, icon('plus', 14), h('span', { text: T('添加备用模型', 'Add fallback model') }))
            : h('div', { class: 'small muted', text: T('最多 5 个', 'Up to 5') })
        );

        const ollamaModelIn = h('input', {
          class: 'input mono ai-ollama-in',
          placeholder: 'qwen2.5:7b',
          value: String(d.ollamaModel || ''),
          oninput: (e) => { d.ollamaModel = e.target.value.trim(); }
        });

        const nowMs = Date.now();
        const capsObj = (d.caps && typeof d.caps === 'object') ? d.caps : {};
        const capKeys = Object.keys(capsObj);
        const cooledKeys = capKeys.filter((k) => (Number(capsObj[k] && capsObj[k].cooldownUntil) || 0) > nowMs);
        const capStatusBadge = cooledKeys.length > 0
          ? h('span', { class: 'set-pill is-warn', text: T(`${cooledKeys.length} 个冷却中`, `${cooledKeys.length} cooled`) })
          : (capKeys.length > 0
            ? h('span', { class: 'set-pill is-ok', text: T(`已学习 ${capKeys.length} 个端点`, `${capKeys.length} learned`) })
            : h('span', { class: 'set-pill', text: T('暂无缓存', 'Empty') }));
        const capResetBtn = h('button', {
          class: 'set-text-btn',
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
        }, cooledKeys.length > 0
          ? T(`解除冷却 (${cooledKeys.length})`, `Clear cooldown (${cooledKeys.length})`)
          : T(`重置缓存 (${capKeys.length})`, `Reset cache (${capKeys.length})`));

        const aiTopRow = h('div', { class: 'upd-main-row ai-set-bar' },
          h('div', { class: 'set-inline-group' },
            h('span', { class: 'upd-row-label', text: T('AI 助手', 'AI assistant') }),
            testBadge
          ),
          h('div', { class: 'upd-row-right' },
            setSwitch(d.enabled !== false, (v) => { d.enabled = v; }, {
              label: T('启用', 'Enable')
            }),
            h('button', {
              type: 'button',
              class: 'set-outline-btn',
              disabled: state.aiTesting,
              onclick: testAi
            }, icon('play', 13), h('span', { text: state.aiTesting ? T('测试中…', 'Testing…') : T('测试连接', 'Test') })),
            h('button', {
              type: 'button',
              class: 'btn primary sm',
              disabled: state.aiBusy,
              onclick: saveAi
            }, h('span', { text: state.aiBusy ? T('保存中…', 'Saving…') : T('保存', 'Save') }))
          )
        );

        const aiConnCard = h('div', { class: 'set-card' },
          aiTopRow,
          setRow(T('服务商', 'Provider'), provBox, null, savedProviderStrip),
          setRow(T('接口地址', 'Endpoint'), endpointIn,
            T('OpenAI 兼容 /chat/completions 地址，支持本机 Ollama', 'OpenAI-compatible /chat/completions URL (local Ollama supported)')),
          setRow(T('API Key', 'API key'),
            h('div', { class: 'row' },
              keyIn,
              h('button', {
                type: 'button',
                class: 'set-text-btn',
                title: state.aiKeyShown ? T('隐藏', 'Hide') : T('显示', 'Show'),
                onclick: () => { state.aiKeyShown = !state.aiKeyShown; paint(); }
              }, state.aiKeyShown ? T('隐藏', 'Hide') : T('显示', 'Show'))
            ),
            T('仅保存在本机 app.json，不写日志、不随导出泄露', 'Stored locally in app.json only; never logged or exported')),
          setRow(T('模型', 'Model'),
            h('div', { class: 'row' }, modelIn, fetchBtn),
            null,
            h('div', null,
              state.aiModelsErr ? h('div', { class: 'small', style: 'color:var(--danger);margin-top:4px', text: state.aiModelsErr }) : null,
              modelReport))
        );

        const permOpen = state.moreOpen.aiPerm !== null ? !!state.moreOpen.aiPerm : (pol.mode !== 'off');
        const aiPermCard = h('div', { class: 'set-card' },
          setLine(T('动手权限', 'Action mode'),
            h('div', { class: 'set-inline-group' },
              agentBadge,
              h('div', { class: 'ai-modes' }, ...modeBtns)
            ),
            MODE_TIP[pol.mode] || ''
          ),
          setMore(T('允许范围与安全上限', 'Allowed scope & safety limits'),
            h('div', { class: 'set-more-inner' },
              setRow(T('允许范围', 'Scope'),
                h('div', { class: 'agent-cats' }, ...catBoxes),
                pol.mode === 'off' ? T('当前为「只读」档位，切换到确认/自动/放手后生效', 'Inactive while in Read-only mode') : ''),
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
                T('每次执行均记入 ai\\journal 审计日志', 'Every execution is recorded in ai\\journal'))
            ), {
              open: permOpen,
              onToggle: (open) => { state.moreOpen.aiPerm = open; }
            })
        );

        const aiAdvCard = h('div', { class: 'set-card' },
          setMore(T('高级模型参数与维护', 'Advanced model params & maintenance'),
            h('div', { class: 'set-more-inner' },
              setRow(T('参数', 'Params'),
                h('div', { class: 'set-tri' },
                  h('div', { class: 'field' },
                    h('label', {
                      title: reported
                        ? T('读自端点 /models 的 max context length；历史超 50% 裁剪、85% 摘要', 'Read from endpoint /models; trims at 50% and summarizes at 85%')
                        : T('按模型名推断或默认 1M；历史超 50% 裁剪、85% 摘要', 'Inferred from model or 1M default'),
                      text: T('上下文窗口', 'Context')
                    }),
                    ctxIn),
                  h('div', { class: 'field' },
                    h('label', {
                      title: d.tempAuto !== false
                        ? T('自动：查文件 0.1 · 算数字 0 · 写文案 0.85', 'Auto: 0.1 files · 0 math · 0.85 writing')
                        : T('手填值对所有非推理任务生效', 'Manual temperature for non-reasoning tasks'),
                      text: T('温度', 'Temp')
                    }),
                    h('div', { class: 'row wrap' },
                      tempIn,
                      h('label', { class: 'check', title: T('按任务自动选温度', 'Pick temperature by task') }, tempAutoCb, h('span', { text: T('自动', 'Auto') })))),
                  h('div', { class: 'field' },
                    h('label', {
                      title: T('防死循环安全闸，与强度档位取小', 'Safety step cap'),
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
                ),
                winSrc
              ),
              setLine(T('要求 JSON 模式', 'Request JSON mode'),
                setSwitch(d.jsonMode !== false, (v) => { d.jsonMode = v; }, {
                  ariaLabel: T('要求 JSON 模式', 'Request JSON mode')
                })
              ),
              setRow(T('本机兜底', 'Local fallback'),
                h('div', { class: 'ai-ollama-row' },
                  setSwitch(d.ollamaFallback === true, (v) => { d.ollamaFallback = v; paint(); }, {
                    label: T('云端不可用时切 Ollama', 'Fallback to Ollama')
                  }),
                  ollamaModelIn
                ),
                T('需本机已运行 Ollama（127.0.0.1:11434）；留空默认 qwen2.5:7b',
                  'Requires local Ollama at 127.0.0.1:11434; empty defaults to qwen2.5:7b')),
              setRow(T('备用模型', 'Fallbacks'), fbBox,
                T('主端点限流或不可用时按顺序切换（最多 5 条）', 'Tried in order if primary fails (up to 5)')),
              setLine(T('节点健康与对话数据', 'Health & chat history'),
                h('div', { class: 'set-inline-group' },
                  capStatusBadge,
                  capResetBtn,
                  h('button', {
                    type: 'button',
                    class: 'set-text-btn ai-set-danger',
                    onclick: clearAiData
                  }, T('清空对话记录', 'Clear chats'))
                )
              )
            ), {
              open: !!state.moreOpen.aiAdv,
              onToggle: (open) => { state.moreOpen.aiAdv = open; },
              badge: winSrc
            })
        );

        const body = h('div', { class: 'stack set-stack' },
          aiConnCard,
          test && !test.ok
            ? h('div', { class: 'upd-box warn' }, h('div', { class: 'small', style: 'color:var(--danger)', text: test.msg }))
            : null,
          test && test.ok && (test.warn || test.note || test.hint)
            ? h('div', { class: 'upd-box ' + (test.warn ? 'warn' : 'ok') },
              test.warn ? h('div', { class: 'small', style: 'color:var(--warn)', text: test.warn }) : null,
              test.note ? h('div', { class: 'small muted', text: test.note }) : null,
              test.hint ? h('div', { class: 'small muted', text: test.hint }) : null)
            : null,
          aiPermCard,
          aiAdvCard
        );

        return section(T('AI 助手', 'AI assistant'), body, {
          open: state.openId === 'assistant',
          hint: AIStore.isConfigured(d) ? (d.model || T('已配置', 'Configured')) : T('未配置', 'Not configured'),
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

        function formatVersionTag(ver) {
          const s = String(ver || '').trim();
          if (!s) return '—';
          return /^[vVaAbB]/.test(s) ? s : 'v' + s;
        }

        function extractChangelogBullets(item) {
          const rawBody = String((item && item.body) || '');
          const lines = rawBody.split(/\r?\n/);
          const out = [];
          let inFence = false;
          for (let i = 0; i < lines.length; i++) {
            const rawLine = lines[i];
            const trimmed = rawLine.trim();
            if (trimmed.startsWith('```')) {
              inFence = !inFence;
              continue;
            }
            if (inFence || !trimmed) continue;
            if (/^[-*_]{3,}$/.test(trimmed)) continue;
            if (/^\|[\s:|-]+\|$/.test(trimmed)) continue;
            if (/^#{1,2}\s+/.test(trimmed)) continue;
            if (/^#{3,6}\s+/.test(trimmed)) {
              const heading = trimmed.replace(/^#{3,6}\s+/, '').trim();
              if (!heading) continue;
              // 若紧跟子列表，则跳过纯分组标题，让具体条目直接呈现在红点列表中
              let hasFollowingBullet = false;
              for (let j = i + 1; j < lines.length; j++) {
                const nt = lines[j].trim();
                if (!nt) continue;
                if (/^([-*+]|\d+[.)])\s+/.test(nt)) hasFollowingBullet = true;
                break;
              }
              if (!hasFollowingBullet) out.push(heading);
              continue;
            }
            const bulletMatch = rawLine.match(/^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/);
            if (bulletMatch) {
              const indent = bulletMatch[1].length;
              const content = bulletMatch[2].trim();
              if (!content) continue;
              // 若为「总括短语：」且下一行是更深缩进的子条目，跳过空壳父标题避免割裂
              if (/[：:]$/.test(content)) {
                let hasSub = false;
                for (let j = i + 1; j < lines.length; j++) {
                  const nl = lines[j];
                  if (!nl.trim()) continue;
                  const subM = nl.match(/^(\s*)(?:[-*+]|\d+[.)])\s+/);
                  if (subM && subM[1].length > indent) hasSub = true;
                  break;
                }
                if (hasSub) continue;
              }
              out.push(content);
              continue;
            }
            if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
              const cells = trimmed.slice(1, -1).split('|').map((c) => c.trim()).filter(Boolean);
              if (cells.length >= 2) out.push(cells.join('：'));
              continue;
            }
            out.push(trimmed);
          }
          if (!out.length) {
            const fallback = String((item && (item.title || item.summary)) || '').trim();
            if (fallback) out.push(fallback);
            else out.push(T('常规功能优化与稳定性修复', 'General improvements and bug fixes'));
          }
          return out;
        }

        function renderInlineBulletText(text) {
          const frag = document.createDocumentFragment ? document.createDocumentFragment() : h('span');
          const src = String(text || '');
          const re = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))/g;
          let last = 0;
          let m;
          while ((m = re.exec(src)) !== null) {
            if (m.index > last) {
              frag.appendChild(document.createTextNode(src.slice(last, m.index)));
            }
            if (m[2] !== undefined) {
              frag.appendChild(h('strong', null, m[2]));
            } else if (m[3] !== undefined) {
              frag.appendChild(h('code', { class: 'cl-code' }, m[3]));
            } else if (m[4] !== undefined && m[5] !== undefined) {
              const href = m[5];
              frag.appendChild(h('a', {
                href,
                class: 'cl-link',
                onclick: (e) => {
                  e.preventDefault();
                  openExternalUrl(href);
                }
              }, m[4]));
            }
            last = re.lastIndex;
          }
          if (last < src.length) {
            frag.appendChild(document.createTextNode(src.slice(last)));
          }
          return frag;
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
          let loading = true;
          let syncing = false;
          let remoteSynced = false;
          let closed = false;
          let loadSeq = 0;
          const expandedCards = new Set();

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
                body: T('暂无可展示的离线更新记录，可点击右上角「同步线上」获取最新发布内容。',
                  'No offline release notes available. Click Sync to fetch from GitHub.'),
                date: '',
                isCurrent: true,
                isUpdate: false,
                source: 'local',
                url: releasesPage
              });
            }
            return list;
          }

          const syncBtn = h('button', {
            type: 'button',
            class: 'cl-sync-btn',
            title: T('同步线上最新发布内容与日期', 'Sync latest release notes from GitHub'),
            onclick: () => loadChangelog(true)
          }, icon('refresh', 13), h('span', { text: T('同步线上', 'Sync') }));

          const closeIconBtn = h('button', {
            type: 'button',
            class: 'cl-close-x',
            title: T('关闭', 'Close'),
            'aria-label': T('关闭', 'Close'),
            onclick: () => closeDialog()
          }, icon('close', 16));

          const headEl = h('header', { class: 'cl-head' },
            h('h1', { id: 'cl-dialog-title', class: 'cl-title' }, T('更新内容', "What's New")),
            h('div', { class: 'cl-head-right' }, syncBtn, closeIconBtn)
          );

          const feedEl = h('div', { class: 'cl-feed', 'aria-live': 'polite' });
          const footInfoEl = h('span', { class: 'cl-foot-hint small muted' }, '');
          const okBtn = h('button', {
            type: 'button',
            class: 'cl-ok-btn',
            autofocus: true,
            onclick: () => closeDialog()
          }, T('知道了', 'Got it'));

          const footEl = h('footer', { class: 'cl-foot' },
            footInfoEl,
            h('div', { class: 'spacer' }),
            okBtn
          );

          dialog.appendChild(h('div', { class: 'cl-shell' }, headEl, feedEl, footEl));

          function renderCard(item) {
            const verTag = formatVersionTag(item.version);
            const isCur = !!(item.isCurrent || (curVer && item.version === curVer));
            const isUpdItem = !!(updateCtx && item.version.toLowerCase() === updateCtx.ver.toLowerCase());
            const bullets = extractChangelogBullets(item);
            const collapseLimit = 6;
            const isExpanded = expandedCards.has(item.id) || bullets.length <= collapseLimit;
            const visibleBullets = isExpanded ? bullets : bullets.slice(0, collapseLimit);

            const cardHead = h('div', { class: 'cl-card-head' },
              h('div', { class: 'cl-card-title-row' },
                h('span', { class: 'cl-card-ver mono' }, verTag),
                isCur ? h('span', { class: 'cl-card-pill' }, T('当前版本', 'Current')) : null,
                item.isUpdate ? h('span', { class: 'cl-card-pill is-new' }, T('新版本', 'New')) : null,
                item.isPrerelease ? h('span', { class: 'cl-card-pill is-beta' }, T('测试版', 'Beta')) : null
              ),
              item.date ? h('span', { class: 'cl-card-date mono' }, item.date) : null
            );

            const updActions = isUpdItem ? h('div', { class: 'cl-card-upd' },
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
                }, h('span', { text: T('跳过此版本', 'Skip') }))
                : null
            ) : null;

            const ul = h('ul', { class: 'cl-card-list' },
              ...visibleBullets.map((line) => h('li', { class: 'cl-bullet' },
                h('span', { class: 'cl-bullet-dot', 'aria-hidden': 'true' }),
                h('span', { class: 'cl-bullet-text' }, renderInlineBulletText(line))
              ))
            );

            const moreBtn = bullets.length > collapseLimit ? h('button', {
              type: 'button',
              class: 'cl-more-btn',
              onclick: () => {
                if (expandedCards.has(item.id)) expandedCards.delete(item.id);
                else expandedCards.add(item.id);
                renderAll();
              }
            }, isExpanded
              ? T('收起部分内容', 'Show less')
              : T(`展开其余 ${bullets.length - collapseLimit} 条`, `Show ${bullets.length - collapseLimit} more`)) : null;

            return h('article', {
              class: 'cl-card' + (isCur ? ' is-current' : '') + (item.isUpdate ? ' is-update' : '')
            }, cardHead, updActions, ul, moreBtn);
          }

          function renderAll() {
            feedEl.replaceChildren();
            if (loading && !entries.length) {
              feedEl.appendChild(skeleton(5, 'log'));
            } else {
              entries.forEach((it) => feedEl.appendChild(renderCard(it)));
            }
            const syncSpan = syncBtn.querySelector && syncBtn.querySelector('span');
            if (syncSpan) {
              syncSpan.textContent = syncing ? T('同步中…', 'Syncing…') : T('同步线上', 'Sync');
            }
            footInfoEl.textContent = remoteSynced
              ? T('已同步线上发布记录', 'Synced with GitHub Releases')
              : '';
          }

          async function loadChangelog(includeRemote) {
            const mySeq = ++loadSeq;
            if (includeRemote) {
              if (syncing) return;
              syncing = true;
              syncBtn.disabled = true;
              renderAll();
            } else {
              loading = true;
              renderAll();
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
            } catch (e) {
              if (closed || mySeq !== loadSeq) return;
              entries = mergeEntries([]);
              if (includeRemote) toast(errText(e), 'warn');
            } finally {
              if (!closed && mySeq === loadSeq) {
                loading = false;
                syncing = false;
                syncBtn.disabled = false;
                renderAll();
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
          const onPointerDown = (e) => { pressedOutside = e.target === dialog && isOutside(e); };
          const onDialogClick = (e) => {
            if (e.target !== dialog) { pressedOutside = false; return; }
            if (pressedOutside && isOutside(e)) closeDialog();
            pressedOutside = false;
          };
          if (needLightDismissFallback) {
            dialog.addEventListener('pointerdown', onPointerDown);
            dialog.addEventListener('click', onDialogClick);
          }

          function cleanupDialog() {
            if (closed) return;
            closed = true;
            if (state.changelogClose === closeDialog) state.changelogClose = null;
            if (unregModal) { unregModal(); unregModal = null; }
            try { dialog.returnValue = ''; } catch (_) {}
            if (needLightDismissFallback) {
              dialog.removeEventListener('pointerdown', onPointerDown);
              dialog.removeEventListener('click', onDialogClick);
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

          entries = mergeEntries([]);
          renderAll();
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
              }, h('span', { text: T('更新内容', "What's New") }))
            )
          );
        })();

        const lastCheckAt = (st && st.config && st.config.lastCheckAt) || '';
        const verTooltip = [
          kindLabel,
          lastCheckAt ? T('上次检查：', 'Last checked: ') + lastCheckAt : ''
        ].filter(Boolean).join(' · ');

        const channelSeg = h('div', {
          class: 'upd-seg',
          role: 'radiogroup',
          'aria-label': T('更新通道', 'Update channel')
        },
          ...[
            { value: 'stable', zh: '稳定版', en: 'Stable', tip: T('正式发布版（推荐）', 'Stable releases (recommended)') },
            { value: 'beta', zh: '测试版', en: 'Beta', tip: T('包含预发布体验版', 'Includes prereleases') }
          ].map((ch) => {
            const active = state.updChannel === ch.value;
            return h('button', {
              type: 'button',
              role: 'radio',
              'aria-checked': active ? 'true' : 'false',
              class: 'upd-seg-btn' + (active ? ' active' : ''),
              title: ch.tip,
              disabled: state.updDownloading || state.updInstalling,
              onclick: () => { if (!active) onUpdaterChannel(ch.value); }
            }, T(ch.zh, ch.en));
          })
        );

        const body = h('div', { class: 'stack' },
          h('div', { class: 'set-card upd-card' },
            h('div', { class: 'upd-main-row' },
              h('span', { class: 'upd-row-label', text: T('版本', 'Version') }),
              h('div', { class: 'upd-row-right' },
                h('span', {
                  class: 'upd-ver-pill mono',
                  title: verTooltip,
                  text: formatVersionTag(curVer)
                }),
                channelSeg,
                h('button', {
                  type: 'button',
                  class: 'upd-check-btn',
                  disabled: state.updChecking || state.updDownloading,
                  onclick: checkForUpdates
                },
                  state.updChecking
                    ? h('span', { class: 'btn-spin', 'aria-hidden': 'true' })
                    : icon('refresh', 14),
                  h('span', { text: state.updChecking ? T('检查中…', 'Checking…') : T('检查更新', 'Check for updates') })
                ),
                h('button', {
                  type: 'button',
                  class: 'upd-notes-btn',
                  onclick: () => openChangelogModal()
                }, T('更新内容', "What's New"))
              )
            ),
            h('div', { class: 'upd-sub-row' },
              setSwitch(!!state.updAutoCheck, (v) => onUpdaterAutoCheck(v), {
                label: T('启动时自动检查更新', 'Check for updates on launch')
              }),
              h('div', { class: 'upd-sub-meta' },
                cacheBytes > 0
                  ? h('span', { class: 'small muted', text: T('已缓存 ', 'Cache ') + fmtSize(cacheBytes) })
                  : h('span', {
                    class: 'small muted',
                    text: lastCheckAt ? T('上次检查 ', 'Checked ') + lastCheckAt : kindLabel
                  }),
                cacheBytes > 0
                  ? h('button', {
                    type: 'button',
                    class: 'upd-link-btn',
                    disabled: state.updDownloading || state.updInstalling,
                    onclick: (ev) => clearUpdaterCache(ev && ev.currentTarget)
                  }, T('清理', 'Clear'))
                  : null
              )
            )
          ),
          chkWrap,
          progWrap,
          resultCard,
          (() => {
            const app = state.app;
            const eng = state.engine;
            const dataDirPath = (app && app.data_dir) || (state.settings && state.settings.data_dir) || '';
            const exeDirPath = (app && app.exe_dir) || '';
            const engPill = eng
              ? (eng.pid > 0
                ? h('span', { class: 'set-pill is-ok', text: T('引擎运行中', 'Engine running') + ' · PID ' + eng.pid })
                : h('span', { class: 'set-pill is-warn', text: T('引擎未启动', 'Engine stopped') }))
              : h('span', { class: 'set-pill', text: T('引擎状态未知', 'Engine unknown') });

            return state.appError
              ? empty(T('应用信息读取失败', 'Could not read app info'), state.appError)
              : h('div', { class: 'set-card' },
                setRow(T('数据目录', 'Data folder'),
                  h('div', { class: 'row' },
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
                      type: 'button',
                      class: 'set-outline-btn',
                      disabled: state.dataMigrating,
                      onclick: pickDataDir
                    }, icon('folder', 13), h('span', { text: state.dataMigrating ? T('迁移中…', 'Migrating…') : T('更改并迁移…', 'Migrate…') }))
                  ),
                  T('配置、AI 会话、整理历史、缓存与日志统一存放于此；更改后自动整体迁移并重启',
                    'Config, AI chats, history, cache and logs live here; changing migrates and restarts automatically')
                ),
                setLine(T('运行状态', 'Runtime'),
                  h('div', { class: 'set-inline-group' },
                    engPill,
                    exeDirPath
                      ? h('button', {
                        type: 'button',
                        class: 'set-text-btn',
                        title: exeDirPath,
                        onclick: () => reveal(exeDirPath)
                      }, T('程序目录', 'App folder'))
                      : null,
                    h('button', {
                      type: 'button',
                      class: 'set-text-btn',
                      onclick: (ev) => refreshMaintenance(ev && ev.currentTarget)
                    }, T('刷新', 'Refresh'))
                  ),
                  state.engineError || ''
                )
              );
          })()
        );

        return section(T('版本与数据', 'Version & data'), body, {
          open: state.openId === 'updater',
          hint: hasNew
            ? T('有新版本 v' + chk.latestVersion, 'Update v' + chk.latestVersion)
            : T('v' + curVer + ' · 更新与存储', 'v' + curVer + ' · Updates & data'),
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
        const changed = state.updChannel !== channel;
        state.updChannel = channel;
        if (changed && !state.updDownloading) {
          state.updCheck = null;
          state.updError = null;
        }
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
          const dirty = ['recursive_depth', 'conflict_policy', 'log_keep_days', 'default_recursive', 'default_content',
            'index_freshness', 'index_max_mb', 'index_rebuild_idle',
            'prune_enabled', 'prune_history_keep', 'prune_thumbs_mb', 'prune_backup_keep']
            .some((k) => st.settings[k] !== st.original[k]);
          if (!dirty) return;
          e.preventDefault();
          e.stopPropagation();
          confirm({
            title: T('有未保存的修改', 'Unsaved changes'),
            body: T('离开设置页会丢失尚未保存的整理与索引设置，仍要离开吗？', 'Leaving will discard unsaved tidy & index settings. Leave anyway?'),
            ok: T('离开', 'Leave'),
            danger: true
          }).then((ok) => { if (ok) window.navigate(id); });
        }, true);
      }

      setActions();

      const SECTION_ALIAS = {
        appearance: 'general',
        behavior: 'general',
        performance: 'general',
        maintenance: 'updater'
      };
      liveJump = function (payload) {
        const raw = payload && (payload.section || payload.tab || payload.id);
        if (!raw) return;
        const key = String(raw);
        state.openId = SECTION_ALIAS[key] || key;
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
