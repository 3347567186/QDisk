/* 设置页：五个手风琴分组，一屏内完成外观、行为、默认值、定时与维护 */
(function () {
  'use strict';

  const { h, T, icon, section, toast, empty, skeleton, confirm } = UI;

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

      /* ---------- 顶层 ---------- */
      function paint() {
        root.textContent = '';
        const holder = h('div', { class: 'stack' });
        holder.appendChild(secAppearance(holder));
        holder.appendChild(secBehavior(holder));
        holder.appendChild(secDefaults(holder));
        holder.appendChild(secPerformance(holder));
        holder.appendChild(secSchedule(holder));
        holder.appendChild(secAssistant(holder));
        holder.appendChild(secMaintenance(holder));
        root.appendChild(holder);
      }

      const openOpt = (id) => ({ open: state.openId === id, id, accordion: null });

      function secAppearance(holder) {
        const body = h('div', { class: 'grid-2' },
          h('div', { class: 'field' },
            h('label', { text: T('主题', 'Theme') }),
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
            h('div', { class: 'desc', text: T('跟随系统会读取 Windows 的深浅色设置', 'System follows the Windows color mode') })
          ),
          h('div', { class: 'field' },
            h('label', { text: T('界面语言', 'Language') }),
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
            h('div', { class: 'desc', text: T('切换后界面文案立即更新', 'The interface switches immediately') })
          )
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
          onchange: (e) => onCloseAction(e.target.value)
        }, CLOSE_ACTIONS.map((c) =>
          h('option', { value: c.value, selected: state.closeAction === c.value, text: T(c.zh, c.en) })
        ));

        const body = h('div', { class: 'stack' },
          h('div', { class: 'grid-2' },
            h('div', { class: 'field' },
              h('label', { for: 'set-close', text: T('关闭窗口时', 'When closing the window') }),
              closeSelect,
              h('div', { class: 'desc', text: T('最小化到托盘后可从托盘图标重新打开', 'Reopen it from the tray icon') })
            ),
            h('div', { class: 'field' },
              h('label', { text: T('启动', 'Startup') }),
              h('label', { class: 'check' },
                h('input', {
                  type: 'checkbox',
                  checked: state.autostart,
                  disabled: state.autostartBusy,
                  onchange: (e) => onAutostart(e.target.checked)
                }),
                h('span', { text: T('开机自动启动', 'Start with Windows') })
              ),
              h('div', { class: 'desc', text: T('随 Windows 登录自动运行整理助手', 'Launch the assistant after Windows sign-in') })
            )
          ),
          h('div', { class: 'note', text: T('单实例运行：再次启动会激活已打开的窗口，不会产生第二个进程。',
            'Single instance: launching again focuses the open window instead of starting a second process.') }),
          h('div', { class: 'row' },
            h('span', { class: 'small muted', text: T('权限', 'Privileges') }),
            state.admin
              ? h('span', { class: 'badge ok', text: T('管理员', 'Administrator') })
              : h('span', { class: 'badge warn', text: T('普通权限', 'Standard user') }),
            h('button', {
              class: 'btn sm',
              disabled: state.admin,
              onclick: onRunAsAdmin
            }, icon('shield', 14), h('span', { text: T('以管理员身份重启', 'Restart as administrator') })),
            h('span', { class: 'small muted', text: T('整理受保护目录时需要管理员权限', 'Administrator rights are needed for protected folders') })
          )
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
            onchange: (e) => { s.conflict_policy = e.target.value; paintHint(); }
          }, CONFLICTS.map((c) =>
            h('option', { value: c.value, selected: s.conflict_policy === c.value, text: T(c.zh, c.en) })
          ));

          body = h('div', { class: 'stack' },
            h('div', { class: 'field' },
              h('label', { text: T('数据目录', 'Data folder') }),
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
              h('div', { class: 'desc', text: T('索引、缓存与 settings.json 所在位置；更改只迁移配置', 'Index, cache and settings.json; changing migrates the config only') })
            ),
            h('div', { class: 'grid-3' },
              h('div', { class: 'field' },
                h('label', { text: T('递归深度', 'Recursive depth') }),
                depthInput,
                h('div', { class: 'desc', text: T('1 到 4 层', '1 to 4 levels') })
              ),
              h('div', { class: 'field' },
                h('label', { text: T('同名冲突', 'Name clashes') }),
                conflictSelect,
                h('div', { class: 'desc', text: T('整理文件时的默认策略', 'Default tidy policy') })
              ),
              h('div', { class: 'field' },
                h('label', { text: T('日志保留天数', 'Log retention') }),
                keepInput,
                h('div', { class: 'desc', text: T('1 到 3650 天', '1 to 3650 days') })
              )
            ),
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
          h('div', { class: 'field' },
            h('label', { text: T('运行模式', 'Power mode') }),
            h('div', { class: 'row wrap' }, ...chips),
            h('div', { class: 'desc', text: active.desc })
          ),
          h('div', { class: 'grid-2' },
            h('div', { class: 'field' },
              h('label', { text: T('动画强度', 'Motion') }),
              motionSel,
              h('div', { class: 'desc', text: T('静默模式自动使用精简动画；「关闭」让所有过渡立即完成', 'Silent uses lite automatically; Off makes every transition instant') })
            ),
            h('div', { class: 'field' },
              h('label', { class: 'check' }, gpuCb, h('span', { text: T('GPU 加速', 'GPU acceleration') })),
              h('div', { class: 'desc', text: T('关闭可降低显存与内存占用，重启后生效', 'Lower GPU and memory use. Restart to apply.') })
            )
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
          h('div', { class: 'grid-2' },
            h('div', { class: 'field' },
              h('label', { text: T('运行时间', 'Run time') }),
              timeInput,
              h('div', { class: 'desc', text: T('每天执行一次，使用 Windows 计划任务；关闭应用后也会运行', 'Runs daily through a Windows scheduled task, even when the app is closed') })
            ),
            h('div', { class: 'field' },
              h('label', { text: T('截图保留天数', 'Keep screenshots for') }),
              daysInput,
              h('div', { class: 'desc', text: T('只清理早于这个天数的截图；缓存不受影响', 'Only screenshots older than this are removed; cache is unaffected') })
            )
          ),
          h('div', { class: 'row wrap' },
            h('label', { class: 'check' }, cacheCb,
              h('span', { text: T('清理缓存（仅安全项）', 'Clean cache (safe items only)') })),
            h('label', { class: 'check' }, shotsCb,
              h('span', { text: T('清理截图', 'Clean screenshots') }))
          ),
          h('div', { class: 'desc', text: T('删除内容会进回收站，可在回收站还原；谨慎/高级项不会被自动清理', 'Removed items go to the Recycle Bin. Caution/advanced items are never auto-cleaned.') }),
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
        const provBox = h('select', {
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

        const endpointIn = h('input', {
          class: 'input mono', spellcheck: 'false', value: d.endpoint || '',
          placeholder: 'https://api.deepseek.com/v1/chat/completions',
          oninput: (e) => { d.endpoint = e.target.value.trim(); state.aiTest = null; }
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

        const modelPicker = modelList.length
          ? h('div', { class: 'ai-models' },
            h('div', { class: 'ai-models-head' },
              h('span', { text: T('端点报告 ' + modelList.length + ' 个可用模型', modelList.length + ' models from the endpoint') }),
              h('div', { class: 'spacer' }),
              h('button', {
                class: 'btn ghost sm', type: 'button',
                onclick: () => { d.models = []; state.aiModelsErr = null; paint(); }
              }, h('span', { text: T('清空', 'Clear') }))
            ),
            h('div', { class: 'ai-models-list' }, ...modelList.map((id) => h('button', {
              class: 'ai-model-item',
              type: 'button',
              'data-active': id === d.model ? '1' : null,
              title: id,
              onclick: () => {
                d.model = id;
                /* 换模型就跟着换窗口：端点报过就用报的值，没报就退回默认，不沿用上一个模型的 */
                const w = Number((d.modelCtx || {})[id] || 0);
                d.ctxWindow = w || AIStore.FALLBACK_CTX;
                state.aiTest = null;
                paint();
              }
            }, h('span', { class: 'ai-model-name', text: id }),
              Number((d.modelCtx || {})[id] || 0)
                ? h('span', { class: 'ai-model-ctx', text: Math.round((d.modelCtx[id]) / 1024) + 'K' })
                : null,
              id === d.model ? icon('check', 12) : null)))
          )
          : null;

        const tempIn = h('input', {
          class: 'input', type: 'number', min: '0', max: '2', step: '0.1',
          value: String(d.temperature),
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
        const winNow = Number(d.ctxWindow) || AIStore.FALLBACK_CTX;
        const winSrc = reported
          ? T('端点上报', 'From endpoint')
          : (Number(d.ctxWindow) ? T('推断/手填', 'Inferred') : T('未上报，按默认', 'Not reported'));

        const ctxIn = h('input', {
          class: 'input ai-ctx-in', type: 'number', min: '2000', max: '2000000', step: '1024',
          value: String(winNow),
          oninput: (e) => {
            const n = Math.round(Number(e.target.value) || 0);
            if (n >= 2000 && n <= 2000000) d.ctxWindow = n;
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

        const body = h('div', { class: 'stack' },
          h('div', { class: 'grid-2' },
            h('div', { class: 'field' },
              h('label', { text: T('服务商', 'Provider') }), provBox
            ),
            h('div', { class: 'field' },
              h('label', { text: T('模型', 'Model') }),
              h('div', { class: 'row' }, modelIn, fetchBtn),
              h('div', { class: 'desc', text: T('填接口文档里的模型名，也可以点「获取模型」让端点自己报', 'Type a model name, or let the endpoint list them') }),
              state.aiModelsErr
                ? h('div', { class: 'small', style: 'color:var(--danger)', text: state.aiModelsErr })
                : null,
              modelPicker
            )
          ),
          h('div', { class: 'field' },
            h('label', { text: T('接口地址', 'Endpoint') }), endpointIn,
            h('div', { class: 'desc', text: T('OpenAI 兼容的 /chat/completions 地址；本地 Ollama 可用 127.0.0.1', 'Any OpenAI-compatible /chat/completions URL; local Ollama works too') })
          ),
          h('div', { class: 'field' },
            h('label', { text: T('API Key', 'API key') }),
            h('div', { class: 'row' },
              keyIn,
              h('button', {
                class: 'btn ghost sm', title: state.aiKeyShown ? T('隐藏', 'Hide') : T('显示', 'Show'),
                onclick: () => { state.aiKeyShown = !state.aiKeyShown; paint(); }
              }, h('span', { text: state.aiKeyShown ? T('隐藏', 'Hide') : T('显示', 'Show') }))
            ),
            h('div', { class: 'desc', text: T('只保存在本机 app.json，不写日志、不随会话导出；请求直接发往上面这个地址', 'Stored only in local app.json; never logged or exported. Requests go straight to the URL above.') })
          ),
          h('div', { class: 'grid-2' },
            h('div', { class: 'field' },
              h('label', { text: T('温度', 'Temperature') }), tempIn,
              h('div', { class: 'desc', text: T('越低越稳，助手类任务建议 0–0.3', 'Lower is steadier; 0–0.3 suits assistant tasks') })
            ),
            h('div', { class: 'field' },
              h('label', { text: T('每次最多查证轮数', 'Max tool steps') }),
              h('div', { class: 'row' },
                h('span', { class: 'badge', text: String(d.maxSteps) + T(' 步', ' steps') }),
                h('span', { class: 'small muted', text: T('超预算时会先给结论，不会无限查', 'Stops with a conclusion instead of looping') })
              )
            )
          ),
          h('div', { class: 'field' },
            h('label', { text: T('上下文窗口', 'Context window') }),
            h('div', { class: 'row' },
              ctxIn,
              h('span', { class: 'badge' + (reported ? ' ok' : ''), text: winSrc })
            ),
            h('div', { class: 'desc', text: reported
              ? T('读自端点 /models 的 max context length；对话预算按窗口的 25% / 50% / 75% 分配', 'Read from the endpoint model list; turns use 25/50/75% of it')
              : T('端点没有报告这个值，先按默认 32K 处理，可以手动改；点「获取模型」会尝试读真实值', 'Not reported by the endpoint; default 32K applies until you fetch models') })
          ),
          h('div', { class: 'row wrap' },
            h('label', { class: 'check' }, enabledCb, h('span', { text: T('启用 AI 助手', 'Enable AI assistant') })),
            h('label', { class: 'check' }, jsonCb, h('span', { text: T('要求 JSON 模式', 'Request JSON mode') }))
          ),
          test && !test.ok
            ? h('div', { class: 'small', style: 'color:var(--danger)', text: test.msg })
            : null,
          test && test.ok && test.warn
            ? h('div', { class: 'small', style: 'color:var(--warn)', text: test.warn })
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
          const p = AIStore.PROVIDERS.find((x) => x.id !== 'custom' && x.endpoint === s.endpoint);
          state.aiProv = p ? p.id : 'custom';
        } catch (e) {
          state.ai = null;
          state.aiDraft = null;
        }
      }

      async function saveAi() {
        const d = state.aiDraft;
        if (state.aiBusy || !d) return;
        if (!d.endpoint) return toast(T('请先填接口地址', 'Fill the endpoint first'), 'error');
        if (!/^https?:\/\//i.test(d.endpoint)) return toast(T('接口地址要以 http:// 或 https:// 开头', 'Endpoint must start with http:// or https://'), 'error');
        if (!d.model) return toast(T('请先填模型名', 'Fill the model name first'), 'error');
        state.aiBusy = true; paint();
        try {
          const next = await AIStore.save(d);
          state.ai = next;
          state.aiDraft = Object.assign({}, next);
          toast(T('AI 设置已保存', 'AI settings saved'), 'ok');
        } catch (e) {
          toast(errText(e), 'error');
        } finally {
          state.aiBusy = false; paint();
        }
      }

      /* 分两步：① 最小请求确认连通；② 带 response_format 要一次 JSON。
         只做①的话，模型不认 JSON 约定也显示「连接正常」，
         用户到对话页才撞上「输出格式不对」，等于测试骗了自己。 */
      async function testAi() {
        const d = state.aiDraft;
        if (state.aiTesting || !d) return;
        if (!d.endpoint || !d.model) return toast(T('先填接口地址与模型名', 'Fill endpoint and model first'), 'error');
        state.aiTesting = true; state.aiTest = null; paint();
        const t0 = Date.now();
        const send = (body) => API.aiHttp({
          url: d.endpoint,
          headers: d.key ? { Authorization: 'Bearer ' + d.key } : {},
          body: JSON.stringify(Object.assign({ model: d.model, stream: false }, body)),
          /* 推理模型实测单轮可到 70s+，20s 会把它误判成连不通 */
          timeoutMs: 90000
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
              state.aiTest = {
                ok: true, ms,
                warn: await jsonProbe(send),
                hint: String(content).trim().slice(0, 80) || T('（返回为空内容，但连接是通的）', '(empty reply, but the connection works)')
              };
            }
          }
        } catch (e) {
          state.aiTest = { ok: false, msg: errText(e) };
        } finally {
          state.aiTesting = false; paint();
        }
      }

      /** 按对话时同样的要求试一次 JSON 输出；不合规就返回一句人话提示 */
      async function jsonProbe(send) {
        const messages = [
          { role: 'system', content: '只输出一个 JSON 对象，其它什么都不要：{"ok":true}' },
          { role: 'user', content: 'reply' }
        ];
        try {
          let res = await send({ messages, max_tokens: 60, response_format: { type: 'json_object' } });
          /* 有的兼容端点不认 response_format，去掉再试一次，别误报 */
          if (!res || res.status !== 200) res = await send({ messages, max_tokens: 60 });
          if (!res || res.status !== 200) return '';
          let payload = null;
          try { payload = JSON.parse(String(res.body || '')); } catch (e) { return ''; }
          const ch = payload && payload.choices && payload.choices[0];
          const text = String((ch && ch.message && ch.message.content) || '')
            .trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
          if (!text) {
            return T('端点这次返回了空内容（推理模型可能把话放在 reasoning_content，或 max_tokens 给小了），对话会不稳定',
              'Empty content this time; replies may be unstable');
          }
          if (text.indexOf('{') >= 0) return '';
          return T('这个模型不按 JSON 输出（它回的是「' + text.slice(0, 20) + '…」），对话会反复报「输出格式不对」。建议换 deepseek-chat、glm-4.5 这类，或者先关掉下面的「要求 JSON 模式」再试',
            'This model ignores the JSON contract, so chats will keep failing. Switch models, or turn off "Request JSON mode"');
        } catch (e) {
          return '';
        }
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
            : h('dl', { class: 'kv' },
              kvRow(T('版本', 'Version'), h('span', { class: 'mono', text: (app && app.version) || '—' })),
              kvRow(T('程序目录', 'Program folder'), pathRow(app && app.exe_dir)),
              kvRow(T('数据目录', 'Data folder'), pathRow(app && app.data_dir)),
              kvRow(T('日志目录', 'Log folder'), pathRow(app && app.log_dir)),
              kvRow(T('引擎状态', 'Engine'), h('div', { class: 'row' }, status,
                h('span', { class: 'small muted', text: eng && eng.pid ? 'PID ' + eng.pid : '' }))),
              kvRow(T('权限', 'Privileges'), state.admin
                ? h('span', { class: 'badge ok', text: T('管理员', 'Administrator') })
                : h('span', { class: 'badge warn', text: T('普通权限', 'Standard user') }))
            ),
          h('div', { class: 'toolbar' },
            app && app.exe_dir ? h('button', { class: 'btn sm', onclick: () => reveal(app.exe_dir) }, icon('folder', 14), h('span', { text: T('打开程序目录', 'Open program folder') })) : null,
            app && app.data_dir ? h('button', { class: 'btn sm', onclick: () => reveal(app.data_dir) }, icon('folder', 14), h('span', { text: T('打开数据目录', 'Open data folder') })) : null,
            app && app.log_dir ? h('button', { class: 'btn sm', onclick: () => reveal(app.log_dir) }, icon('folder', 14), h('span', { text: T('打开日志目录', 'Open log folder') })) : null,
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
