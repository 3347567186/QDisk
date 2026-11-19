/* 设置页：五个手风琴分组，一屏内完成外观、行为、默认值、定时与维护 */
(function () {
  'use strict';

  const { h, T, icon, section, toast, empty, skeleton, confirm, modal } = UI;

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
        openId: 'appearance'
      };

      // 设置页右键：数据目录 / 日志目录相关的最常用动作。
      // 页面本身没有列表，所以挂在整页容器上，空白处右键也能用。
      UI.attachMenu(root, () => {
        const dir = state.settings && state.settings.data_dir;
        return [
          {
            label: T('复制数据目录', 'Copy data folder'), icon: 'copy', disabled: !dir,
            action: () => {
              navigator.clipboard.writeText(dir).then(
                () => toast(T('已复制', 'Copied'), 'ok'),
                () => toast(T('复制失败', 'Copy failed'), 'error')
              );
            }
          },
          { label: T('打开数据目录', 'Open data folder'), icon: 'folder', disabled: !dir, action: () => dir && API.openPath(dir).catch(() => {}) },
          { label: T('打开日志目录', 'Open log folder'), icon: 'file', action: () => API.appInfo().then((a) => { if (a && a.log_dir) API.openPath(a.log_dir).catch(() => {}); }).catch(() => {}) }
        ];
      });

      const kvRow = (label, value) => [h('dt', { text: label }), h('dd', null, value)];

      /* 只读路径 + 打开按钮 */
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
            class: 'btn ghost sm icon',
            title: T('打开目录', 'Open folder'),
            'aria-label': T('打开目录', 'Open folder'),
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
        holder.appendChild(secMaintenance(holder));
        root.appendChild(holder);
        /* 刚拉完模型清单：这一帧画完再把弹窗弹出来，否则清单还没进 DOM */
        if (state.autoOpenModels) {
          state.autoOpenModels = false;
          const open = state.openModelReport;
          if (open) setTimeout(open, 0);
        }
      }

      const openOpt = (id) => ({ open: state.openId === id, id, accordion: null });

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
        const closeSelect = h('select', {
          class: 'select',
          id: 'set-close',
          /* 行标签是普通 div，不是 <label for>：这里显式给无障碍名字，
             否则读屏软件只念「组合框」 */
          'aria-label': T('关闭窗口时', 'When closing the window'),
          onchange: (e) => onCloseAction(e.target.value)
        }, CLOSE_ACTIONS.map((c) =>
          h('option', { value: c.value, selected: state.closeAction === c.value, text: T(c.zh, c.en) })
        ));

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
              T('随 Windows 登录自动运行整理助手', 'Launch the assistant after Windows sign-in')),
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
          const now = await API.setAutostart(want);
          state.autostart = !!now;
          toast(now ? T('已开启开机自启', 'Autostart enabled') : T('已关闭开机自启', 'Autostart disabled'), 'ok');
        } catch (e) {
          state.autostart = !want;
          toast(errText(e), 'error');
        }
        state.autostartBusy = false;
        paint();
      }

      async function onRunAsAdmin() {
        try {
          await API.runAsAdmin();
        } catch (e) {
          toast(errText(e), 'error');
        }
      }

      /* ---------- 整理默认值 ---------- */
      function dirtyKeys() {
        const s = state.settings;
        const o = state.original;
        if (!s || !o) return [];
        return ['data_dir', 'recursive_depth', 'conflict_policy', 'log_keep_days', 'default_recursive', 'default_content']
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
          const conflictSelect = h('select', {
            class: 'select',
            'aria-label': T('同名冲突', 'Name clashes'),
            onchange: (e) => { s.conflict_policy = e.target.value; paintHint(); }
          }, CONFLICTS.map((c) =>
            h('option', { value: c.value, selected: s.conflict_policy === c.value, text: T(c.zh, c.en) })
          ));

          body = h('div', { class: 'stack' },
            h('div', { class: 'set-card' },
              setRow(T('数据目录', 'Data folder'),
                h('div', { class: 'row' },
                  h('input', {
                    class: 'input grow mono', readonly: true, spellcheck: 'false',
                    value: s.data_dir || '—', title: s.data_dir || ''
                  }),
                  h('button', {
                    class: 'btn ghost sm icon', disabled: !s.data_dir,
                    title: T('打开目录', 'Open folder'), 'aria-label': T('打开目录', 'Open folder'),
                    onclick: () => reveal(s.data_dir)
                  }, icon('external', 14)),
                  h('button', { class: 'btn sm', onclick: pickDataDir }, icon('folder', 14),
                    h('span', { text: T('更改…', 'Change…') }))
                ),
                T('索引、缓存与 settings.json 所在位置；更改只迁移配置', 'Index, cache and settings.json; changing migrates the config only')),
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
                ))
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

        const motionSel = h('select', {
          class: 'input sm',
          onchange: () => { state.motion = motionSel.value; App.setMotion(motionSel.value); }
        }, [['full', T('完整', 'Full')], ['lite', T('精简', 'Lite')], ['off', T('关闭', 'Off')]]
          .map(([v, label]) => h('option', { value: v, selected: state.motion === v }, label)));

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

      async function pickDataDir() {
        if (!state.settings) return;
        try {
          const dir = await API.pickFolder(state.settings.data_dir || undefined);
          if (!dir || dir === state.settings.data_dir) return;
          state.settings.data_dir = dir;
          paint();
          toast(T('已选择新目录，保存后生效', 'New folder selected, save to apply'), 'info');
        } catch (e) {
          toast(errText(e), 'error');
        }
      }

      async function saveDefaults() {
        const s = state.settings;
        if (!s || state.saving) return;
        const dataDir = String(s.data_dir || '').trim();
        if (!dataDir) { toast(T('数据目录不能为空', 'The data folder cannot be empty'), 'warn'); return; }
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
        const patch = {
          data_dir: dataDir,
          recursive_depth: depth,
          conflict_policy: s.conflict_policy,
          log_keep_days: keep,
          default_recursive: !!s.default_recursive,
          default_content: !!s.default_content
        };
        const keys = Object.keys(patch).filter((k) => patch[k] !== state.original[k]);
        if (!keys.length) { toast(T('没有需要保存的更改', 'Nothing to save'), 'info'); return; }

        if (patch.data_dir !== state.original.data_dir) {
          const ok = await confirm({
            title: T('更改数据目录', 'Change the data folder'),
            body: T('设置与缓存会迁移到新目录，原目录中的文件不会自动搬走。继续？',
              'Settings and cache move to the new folder; existing files are not moved. Continue?'),
            ok: T('更改', 'Change')
          });
          if (!ok) return;
        }

        state.saving = true;
        paint();
        try {
          for (const key of keys) await API.engine('settings.set', { key, value: patch[key] });
          await loadSettings();
          toast(T('设置已保存', 'Settings saved'), 'ok');
        } catch (e) {
          toast(errText(e), 'error');
        }
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
        try {
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
        } catch (e) {
          toast(errText(e), 'error');
        }
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
        const provSelect = h('select', {
          class: 'input',
          onchange: (e) => {
            state.aiProv = e.target.value;
            const p = AIStore.PROVIDERS.find((x) => x.id === e.target.value);
            if (p && p.id !== 'custom') {
              // 换厂商就换默认地址与模型，但不动已填的密钥
              d.endpoint = p.endpoint; d.model = p.model; state.aiTest = null;
              paint();
            }
          }
        }, ...AIStore.PROVIDERS.map((p) => h('option', {
          value: p.id, text: T(p.zh, p.id), selected: p.id === prov
        })));

        /* 模型池：从 dsh-xdpool 的厂商清单里挑一家，直接把地址与模型名填好。
           只做选择器，不接管请求——请求仍走下面这套端点与 Key。 */
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
          paint();
          /* 已经有 Key：直接落盘，选完就能用；没 Key 则只填表单，提示补 Key 后保存 */
          if (d.key) {
            /* 让弹窗先关完再落盘：立刻重绘会把关闭动画和校验挤在一起 */
            setTimeout(() => { saveAi(); }, 0);
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
          const list = h('div', { class: 'pool-list' });
          const meta = h('span', { class: 'small muted' });
          const search = h('input', {
            class: 'input pool-search', spellcheck: 'false',
            placeholder: T('搜厂商、域名或模型名（可搜中文：百炼/智谱/火山）', 'Search provider, host or model (Chinese names work too)'),
            oninput: () => render(search.value),
            onkeydown: (e) => {
              if (e.key === 'Enter') {
                const first = AIPool.find(search.value)[0];
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

          function render(q) {
            const shown = AIPool.find(q);
            list.textContent = '';
            meta.textContent = T('匹配 ' + shown.length + ' 家', shown.length + ' providers');
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
              h('div', { class: 'pool-head' }, search, meta),
              list,
              h('div', { class: 'pool-source small muted', text: T(
                '清单来自 dsh-xdpool 2.7.5：' + AIPool.providers.length + ' 家厂商、' + AIPool.count() + ' 个模型；地址与模型名会直接填好，Key 仍需自己申请',
                'Catalog from dsh-xdpool 2.7.5: ' + AIPool.providers.length + ' providers, ' + AIPool.count() + ' models; endpoint and model are filled in, the key is still yours') })),
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
          AIStore.saveUi({ agent: next });
          paint();
        }

        const modeBtns = (window.AIProposals ? AIProposals.MODES : ['off', 'confirm', 'auto', 'full']).map((m) => h('button', {
          class: 'ai-mode' + (m === pol.mode ? ' on' : '') + (m !== 'off' ? ' armed' : ''),
          type: 'button',
          'aria-pressed': m === pol.mode ? 'true' : 'false',
          onclick: () => saveAgent({ mode: m })
        }, h('span', { text: { off: T('只读', 'Read-only'), confirm: T('确认', 'Confirm'), auto: T('自动', 'Auto'), full: T('放手', 'Full') }[m] })));

        const catBoxes = (window.AIProposals ? AIProposals.CATS : Object.keys(CAT_ZH)).map((c) => h('label', { class: 'check' },
          h('input', {
            type: 'checkbox',
            checked: !!(pol.cats && pol.cats[c]),
            disabled: pol.mode === 'off',
            onchange: (e) => {
              const cats = Object.assign({}, pol.cats, { [c]: e.target.checked });
              saveAgent({ cats });
            }
          }),
          h('span', { text: CAT_ZH[c] || c })));

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
              T('只保存在本机 app.json，不写日志、不随会话导出；请求直接发往上面这个地址', 'Stored only in local app.json; never logged or exported'))
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
                  h('label', { class: 'check', title: T('按任务自动选温度', 'Pick temperature by task') }, tempAutoCb, h('span', { text: T('自动', 'Auto') })),
                  tempIn)),
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
              h('div', { class: 'row wrap' },
                h('label', { class: 'check' }, enabledCb, h('span', { text: T('启用 AI 助手', 'Enable AI assistant') })),
                h('label', { class: 'check' }, jsonCb, h('span', { text: T('要求 JSON 模式', 'Request JSON mode') })))),
            setRow(T('档位', 'Mode'),
              h('div', { class: 'ai-modes' }, ...modeBtns),
              MODE_TIP[pol.mode] || ''),
            /* 能力范围 + 上限合成一行：都是「动手能到什么程度」，
               原来分成两行、各带一句说明，白掉将近 100px。 */
            setRow(T('范围与上限', 'Scope & limits'),
              h('div', { class: 'set-body' },
                h('div', { class: 'agent-cats' }, ...catBoxes),
                h('div', { class: 'set-sub' },
                  h('label', { text: T('每轮提案 / 每会话执行 / 单次项目', 'Per turn / per session / items') }),
                  h('div', { class: 'agent-limits' },
                    h('div', { class: 'field' }, numIn('maxOpsPerTurn', 1, 10, 2)),
                    h('div', { class: 'field' }, numIn('maxOpsPerSession', 1, 200, 30)),
                    h('div', { class: 'field' }, numIn('maxItems', 10, 20000, 200))
                  )
                )
              ),
              pol.mode === 'off'
                ? T('档位在「只读」时这些开关不生效', 'Inactive while the mode is read-only')
                : T('每次执行都写进 ai\\journal 审计日志；把档位切回「只读」，助手立刻失去动手能力', 'Every run is journalled under ai\\journal; switching back to read-only revokes everything'))
        );

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
          h('div', { class: 'action-bar' },
            testBadge,
            h('div', { class: 'spacer' }),
            h('button', {
              class: 'btn sm', disabled: state.aiTesting, onclick: testAi
            }, icon('play', 14), h('span', { text: state.aiTesting ? T('测试中…', 'Testing…') : T('测试连接', 'Test connection') })),
            h('button', {
              class: 'btn sm ghost', onclick: clearAiData
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

      function secMaintenance(holder) {
        const app = state.app;
        const eng = state.engine;
        const status = eng
          ? (eng.pid > 0
            ? h('span', { class: 'badge ok', text: T('运行中', 'Running') })
            : h('span', { class: 'badge warn', text: T('未启动', 'Not running') }))
          : h('span', { class: 'badge', text: T('未知', 'Unknown') });

        const body = h('div', { class: 'stack' },
          state.appError
            ? empty(T('应用信息读取失败', 'Could not read app info'), state.appError)
            /* 三个目录行各自带「打开」按钮（pathRow 里就有），
               原来工具栏又把同样三个按钮排了一遍，纯重复。 */
            : h('div', { class: 'set-card' },
              h('dl', { class: 'kv' },
                kvRow(T('版本', 'Version'), h('span', { class: 'mono', text: (app && app.version) || '—' })),
                kvRow(T('程序目录', 'Program folder'), pathRow(app && app.exe_dir)),
                kvRow(T('数据目录', 'Data folder'), pathRow(app && app.data_dir)),
                kvRow(T('日志目录', 'Log folder'), pathRow(app && app.log_dir)),
                kvRow(T('引擎状态', 'Engine'), h('div', { class: 'row' }, status,
                  h('span', { class: 'small muted', text: eng && eng.pid ? 'PID ' + eng.pid : '' }))),
                kvRow(T('权限', 'Privileges'), state.admin
                  ? h('span', { class: 'badge ok', text: T('管理员', 'Administrator') })
                  : h('span', { class: 'badge warn', text: T('普通权限', 'Standard user') }))
              )
            ),
          h('div', { class: 'action-bar' },
            h('span', { class: 'small muted', text: T('版本号同时写进 tauri.conf.json 与 Cargo.toml', 'The version is written to both tauri.conf.json and Cargo.toml') }),
            h('div', { class: 'spacer' }),
            h('button', { class: 'btn sm', onclick: refreshMaintenance }, icon('refresh', 14), h('span', { text: T('刷新', 'Refresh') }))
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

      async function refreshMaintenance() {
        await Promise.all([loadAbout(), loadAdmin()]);
        paint();
        toast(T('已刷新', 'Refreshed'), 'ok');
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
            default_content: !!(s && s.default_content)
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
          const dirty = ['data_dir', 'recursive_depth', 'conflict_policy', 'log_keep_days', 'default_recursive', 'default_content']
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

      active = { root, state, paint };
      bindNavGuard();
      paint();

      await Promise.all([loadConfig(), loadSettings(), loadAutostart(), loadSchedule(), loadAbout(), loadAdmin(), loadAi()]);
      state.loading = false;
      if (state.theme === 'system') await applySystemTheme();
      paint();
    }
  };
})();
