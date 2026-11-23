/* 日志页：查看运行日志文件与引擎连接信息 */
(function () {
  'use strict';

  const { h, T, icon, card, toast, empty, busy, confirm, fmtBytes, fmtCount, fmtTime, skeleton, attachMenu, setActions } = UI;

  window.Pages = window.Pages || {};

  // 右键菜单里用到的两个小工具：把错误转成可读文本、复制到剪贴板。
  const errText = UI.errText;
  const copyText = UI.copy;
  let liveJump = null;

  window.Pages.log = {
    title: ['日志', 'Logs'],
    subtitle: ['查看运行日志与引擎连接信息', 'Read run logs and engine connection info'],

    async mount(root) {
      const state = {
        files: null,
        error: null,
        loading: true,
        selected: null,
        content: null,
        contentError: null,
        app: null,
        engine: null,
        engineError: null,
        history: null,
        historyError: null
      };

      let contentBox = null;
      let openToken = 0;

      const titleRow = (text, hint) => h('div', { class: 'card-title' },
        h('h2', null, text),
        hint ? h('div', { class: 'hint', text: hint }) : null
      );

      const kv = (label, value) => [h('dt', { text: label }), h('dd', null, value)];

      function pathCell(path) {
        return h('div', { class: 'row' },
          h('span', {
            class: 'mono ellipsis',
            title: path || '',
            style: { minWidth: 0, flex: 1 },
            text: path || '—'
          }),
          path ? h('button', {
            class: 'btn ghost sm icon',
            title: T('打开目录', 'Open folder'),
            'aria-label': T('打开目录', 'Open folder'),
            onclick: () => reveal(path)
          }, icon('external', 14)) : null
        );
      }

      function paint() {
        contentBox = null;
        root.textContent = '';
        root.appendChild(h('div', { class: 'split-wb master-detail' },
          h('div', { class: 'split-left' }, filesCard()),
          h('div', { class: 'split-right' }, contentCard())
        ));
        root.appendChild(h('div', { class: 'grid-2' },
          engineCard(),
          historyCard()
        ));
      }

      /* ---------- 操作历史（整理记录时间线） ----------
       * 数据来自引擎写的 history/*.json，由 Rust 的 history_list 读出来；
       * 这里只做展示，不提供“回滚”按钮——回滚走整理页的撤销。 */
      function historyCard() {
        const box = h('div', { class: 'card-body' });
        if (state.history === null && !state.historyError) {
          box.appendChild(skeleton(4, 'log'));
          loadHistory().then(() => { if (box.isConnected) renderHistory(box); });
        } else {
          renderHistory(box);
        }
        return h('div', { class: 'card' },
          h('div', { class: 'card-title' },
            h('h2', { text: T('操作历史', 'Activity history') }),
            h('span', { class: 'spacer' }),
            h('button', {
              class: 'btn ghost sm',
              onclick: async () => { state.history = null; state.historyError = null; paint(); }
            }, icon('refresh', 14), h('span', { text: T('刷新', 'Refresh') }))
          ),
          box
        );
      }

      async function loadHistory() {
        try {
          const list = await API.historyList();
          state.history = Array.isArray(list) ? list : [];
        } catch (e) {
          state.historyError = e;
        }
      }

      function renderHistory(box) {
        if (state.historyError) {
          box.replaceChildren(empty(T('读取操作历史失败', 'Could not read history'),
            errText(state.historyError)));
          return;
        }
        const list = state.history || [];
        if (!list.length) {
          box.replaceChildren(empty(T('还没有整理记录', 'No tidy runs yet'),
            T('在「整理文件」里执行一次整理后，这里会出现记录',
              'Run a tidy once and it will show up here')));
          return;
        }
        box.replaceChildren(h('div', { class: 'timeline' },
          list.slice(0, 20).map((it) => h('div', { class: 'tl-item' },
            h('span', { class: 'tl-dot' }),
            h('div', { class: 'tl-body' },
              h('div', { class: 'row' },
                h('span', { class: 'ellipsis', title: it.folder || '', text: it.folder || '—' }),
                h('span', { class: 'spacer' }),
                h('span', { class: 'tl-time', text: it.time || '' })
              ),
              h('div', { class: 'muted small' },
                T('移动 ' + fmtCount(it.moved || 0) + ' 个文件' +
                  (it.created ? '，新建 ' + fmtCount(it.created) + ' 个文件夹' : ''),
                  'Moved ' + fmtCount(it.moved || 0) +
                  (it.created ? ', created ' + fmtCount(it.created) + ' folder(s)' : '')))
            )
          ))
        ));
      }


      const askBtn = UI.askBtn({
        title: T('问助手 · 日志诊断', 'Ask AI · Log diagnostics'),
        question: T('请帮我读取最近的运行日志并排查异常或失败原因。', 'Read recent logs and diagnose any errors or failures.'),
        ctx: () => ({
          page: '日志',
          selected: state.selected ? state.selected.name : '',
          note: state.files ? T('共 ' + state.files.length + ' 个日志文件', state.files.length + ' log files') : ''
        })
      });

      async function copyLogContent(text) {
        const v = String(text == null ? '' : text);
        if (!v) return;
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(v);
          } else {
            const ta = h('textarea', { style: { position: 'fixed', opacity: '0', top: '0', left: '0' } });
            ta.value = v;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
          }
          toast(T('已复制日志内容', 'Log content copied'), 'ok');
        } catch (e) {
          toast(errText(e), 'error');
        }
      }

      /* ---------- 日志文件列表 ---------- */
      function filesCard() {
        let body;
        if (state.loading && state.files === null) {
          body = skeleton(5, 'log');
        } else if (state.error) {
          body = empty(T('日志列表读取失败', 'Could not read the log list'),
            h('button', { class: 'btn sm', onclick: refresh }, icon('refresh', 14), h('span', { text: T('重试', 'Retry') })));
        } else if (!state.files || !state.files.length) {
          body = empty(T('暂无日志文件', 'No log files'),
            T('运行一次整理后这里会出现日志', 'Logs appear here after the app runs'), 'log');
        } else {
          body = h('div', { class: 'log-file-scroll' }, h('div', { class: 'log-file-list' },
            state.files.map((f) => {
              const active = state.selected && state.selected.path === f.path;
              const row = h('button', {
                type: 'button',
                class: 'log-file-item' + (active ? ' is-active' : ''),
                'aria-current': active ? 'true' : null,
                onclick: () => openFile(f)
              },
                h('div', { class: 'log-file-top' },
                  icon('file', 13),
                  h('span', { class: 'log-file-name ellipsis', title: f.name, text: f.name })
                ),
                h('div', {
                  class: 'log-file-meta',
                  text: fmtBytes(f.size) + ' · ' + fmtTime(f.mtime)
                })
              );
              // 右键：查看 / 定位文件 / 复制文件名
              attachMenu(row, [
                { label: T('查看', 'View'), icon: 'file', action: () => openFile(f) },
                { label: T('在资源管理器中定位', 'Reveal in Explorer'), icon: 'external', action: () => API.reveal(f.path).catch((e) => toast(errText(e), 'error')) },
                { label: T('复制文件名', 'Copy file name'), icon: 'copy', action: () => copyText(f.name) }
              ]);
              return row;
            })
          ));
        }

        const total = state.files && state.files.length ? state.files.length : 0;
        const head = h('div', { class: 'log-pane-head' },
          h('div', { class: 'log-pane-head-main' },
            h('h2', { text: T('日志文件', 'Log files') }),
            total ? h('span', { class: 'log-count-pill', text: fmtCount(total) }) : null
          ),
          h('div', { class: 'log-pane-acts' },
            h('button', {
              type: 'button',
              class: 'btn ghost sm icon',
              disabled: state.loading,
              title: T('刷新日志列表', 'Refresh log list'),
              'aria-label': T('刷新日志列表', 'Refresh log list'),
              onclick: refresh
            }, icon('refresh', 13)),
            h('button', {
              type: 'button',
              class: 'btn ghost sm icon',
              title: T('打开日志目录', 'Open log folder'),
              'aria-label': T('打开日志目录', 'Open log folder'),
              onclick: openLogDir
            }, icon('folder', 13)),
            h('button', {
              type: 'button',
              class: 'btn ghost sm icon log-act-danger',
              disabled: state.loading || !total,
              title: T('清空所有日志', 'Clear all logs'),
              'aria-label': T('清空所有日志', 'Clear all logs'),
              onclick: clearLogs
            }, icon('trash', 13))
          )
        );

        return h('div', { class: 'card log-pane-card' },
          head,
          h('div', { class: 'log-pane-body' }, body)
        );
      }

      /* ---------- 日志内容 ---------- */
      function contentCard() {
        const body = [];
        const hasText = !!(state.selected && !state.contentError && state.content !== null && state.content.trim());
        if (!state.selected) {
          body.push(empty(T('选择一个日志文件', 'Select a log file'),
            T('点击左侧列表即可查看日志末尾内容', 'Select a file from the left list'), 'file'));
        } else if (state.contentError) {
          body.push(empty(T('日志读取失败', 'Could not read the log'), state.contentError));
        } else if (state.content === null) {
          body.push(skeleton(8, 'log'));
        } else if (!state.content.trim()) {
          body.push(empty(T('日志为空', 'This log is empty'), state.selected.name, 'file'));
        } else {
          body.push(h('div', { class: 'log-path-bar' },
            h('span', { class: 'mono ellipsis', title: state.selected.path, style: { minWidth: 0, flex: 1 }, text: state.selected.path }),
            h('span', { class: 'small muted', style: { flex: '0 0 auto' }, text: fmtBytes(state.selected.size) })
          ));
          body.push(h('pre', {
            class: 'log-viewer-pre',
            ref: (el) => { contentBox = el; },
            text: state.content
          }));
        }

        const head = h('div', { class: 'log-pane-head' },
          h('div', { class: 'log-pane-head-main' },
            h('h2', { text: T('日志内容', 'Log content') }),
            state.selected ? h('span', {
              class: 'log-sel-meta ellipsis',
              title: state.selected.name,
              text: state.selected.name + ' · ' + fmtBytes(state.selected.size)
            }) : null
          ),
          h('div', { class: 'log-pane-acts' },
            hasText ? h('button', {
              type: 'button',
              class: 'btn ghost sm',
              title: T('复制日志内容', 'Copy log content'),
              onclick: () => copyLogContent(state.content)
            }, icon('copy', 13), h('span', { text: T('复制', 'Copy') })) : null,
            state.selected ? h('button', {
              type: 'button',
              class: 'btn ghost sm icon',
              title: T('在资源管理器中定位', 'Reveal in Explorer'),
              'aria-label': T('在资源管理器中定位', 'Reveal in Explorer'),
              onclick: () => reveal(state.selected.path)
            }, icon('external', 13)) : null,
            askBtn
          )
        );

        return h('div', { class: 'card log-pane-card' },
          head,
          h('div', { class: 'log-pane-body' }, body)
        );
      }

      /* ---------- 引擎连接 ---------- */
      function engineCard() {
        const eng = state.engine;
        const logDir = (eng && eng.log_dir) || (state.app && state.app.log_dir) || '';
        const status = !eng
          ? h('span', { class: 'badge', text: '—' })
          : (eng.pid > 0
            ? h('span', { class: 'badge ok', text: T('运行中', 'Running') })
            : h('span', { class: 'badge warn', text: T('未启动', 'Not running') }));

        const nodes = []
          .concat(kv(T('状态', 'Status'), status))
          .concat(kv(T('引擎路径', 'Engine path'), pathCell(eng && eng.exe)))
          .concat(kv(T('进程号', 'PID'), h('span', { class: 'mono', text: eng && eng.pid ? String(eng.pid) : '—' })))
          .concat(kv(T('数据目录', 'Data folder'), pathCell((eng && eng.data_dir) || (state.app && state.app.data_dir))))
          .concat(kv(T('日志目录', 'Log folder'), pathCell(logDir)));

        return h('div', { class: 'card' },
          h('div', { class: 'card-title' },
            h('h2', { text: T('引擎连接', 'Engine') }),
            h('span', { class: 'spacer' }),
            h('button', {
              class: 'btn ghost sm',
              onclick: refreshEngine
            }, icon('refresh', 14), h('span', { text: T('刷新', 'Refresh') }))
          ),
          state.engineError ? empty(T('引擎信息读取失败', 'Could not read engine info'), state.engineError) : h('dl', { class: 'kv' }, nodes)
        );
      }

      /* ---------- 数据加载 ---------- */
      async function loadFiles() {
        state.error = null;
        try {
          const files = await API.logList();
          state.files = Array.isArray(files) ? files : [];
          if (state.selected && !state.files.some((f) => f.path === state.selected.path)) {
            state.selected = null;
            state.content = null;
            state.contentError = null;
          }
        } catch (e) {
          state.files = [];
          state.error = e && e.message ? e.message : String(e);
          toast(state.error, 'error');
        }
      }

      async function loadEngine() {
        state.engineError = null;
        try {
          state.engine = await API.engineInfo();
        } catch (e) {
          state.engineError = e && e.message ? e.message : String(e);
        }
      }

      async function loadAppInfo() {
        try {
          state.app = await API.appInfo();
        } catch (e) {
          state.app = null;
        }
      }

      async function refresh() {
        state.loading = true;
        paint();
        await busy(async () => {
          await loadFiles();
        }, T('正在刷新日志列表…', 'Refreshing logs…'), 'log');
        state.loading = false;
        paint();
      }

      async function refreshEngine() {
        await busy(async () => {
          await loadEngine();
        }, T('正在刷新引擎状态…', 'Refreshing engine status…'), 'log');
        paint();
      }

      /* ---------- 交互 ---------- */
      async function openFile(f) {
        const token = ++openToken;
        state.selected = f;
        state.content = null;
        state.contentError = null;
        paint();
        try {
          const text = await API.logRead(f.path);
          if (token !== openToken) return;
          state.content = typeof text === 'string' ? text : String(text == null ? '' : text);
        } catch (e) {
          if (token !== openToken) return;
          state.contentError = e && e.message ? e.message : String(e);
          toast(state.contentError, 'error');
        }
        paint();
        if (contentBox) contentBox.scrollTop = contentBox.scrollHeight;
      }

      async function clearLogs() {
        const ok = await confirm({
          title: T('清空日志', 'Clear logs'),
          body: T('将删除日志目录中的所有文件，此操作不可撤销。', 'This deletes every file in the log folder. It cannot be undone.'),
          ok: T('清空', 'Clear'),
          danger: true
        });
        if (!ok) return;
        await busy(async () => {
          await API.logClear();
          state.selected = null;
          state.content = null;
          state.contentError = null;
          await loadFiles();
          toast(T('日志已清空', 'Logs cleared'), 'ok');
        }, T('正在清空日志…', 'Clearing logs…'), 'log');
        paint();
      }

      async function openLogDir() {
        let dir = (state.app && state.app.log_dir) || (state.engine && state.engine.log_dir);
        if (!dir) {
          await loadAppInfo();
          dir = state.app && state.app.log_dir;
        }
        if (!dir) {
          toast(T('日志目录未知', 'Log folder is unknown'), 'error');
          return;
        }
        try {
          await API.reveal(dir);
        } catch (e) {
          toast(e && e.message ? e.message : String(e), 'error');
        }
      }

      async function reveal(path) {
        try {
          await API.reveal(path);
        } catch (e) {
          toast(e && e.message ? e.message : String(e), 'error');
        }
      }

      setActions();

      liveJump = async function (payload) {
        const target = String((payload && (payload.file || payload.name || payload.path)) || '').trim().toLowerCase();
        if (!target) return;
        if (!state.files) await loadFiles();
        const hit = (state.files || []).find((f) => f.name.toLowerCase().includes(target) || f.path.toLowerCase() === target);
        if (hit) await openFile(hit);
      };

      paint();
      await Promise.all([loadFiles(), loadEngine(), loadAppInfo()]);
      state.loading = false;
      paint();

      return function unmount() {
        openToken++;
        liveJump = null;
        const st = askBtn && askBtn.querySelector ? askBtn.querySelector('.steve') : null;
        if (st && st._steve && typeof st._steve.destroy === 'function') st._steve.destroy();
        setActions();
      };
    },

    jump(payload) { return liveJump ? liveJump(payload || {}) : undefined; }
  };
})();
