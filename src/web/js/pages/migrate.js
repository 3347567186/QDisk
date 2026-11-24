/* 数据迁移页：把文件搬到新的数据目录，先预演再执行 */
(function () {
  'use strict';

  const { h, T, icon, card, table, toast, empty, busy, confirm, fmtBytes, fmtCount, attachMenu, setActions } = UI;

  // 右键菜单用：复制文本到剪贴板。
  const copyText = UI.copy;
  let liveJump = null;

  const CONFLICTS = [
    { value: 'rename', zh: '重命名', en: 'Rename' },
    { value: 'skip', zh: '跳过', en: 'Skip' },
    { value: 'overwrite', zh: '覆盖', en: 'Overwrite' }
  ];
  const MODES = [
    { value: 'move', zh: '移动', en: 'Move' },
    { value: 'copy', zh: '复制', en: 'Copy' }
  ];

  const labelOf = (list, value) => {
    const hit = list.find((x) => x.value === value);
    return hit ? T(hit.zh, hit.en) : value;
  };

  /* 来源类型：压缩包 / 文件夹 / 单文件。文件夹没有扩展名，先按名字猜，
     真正的类型由预演结果里的 job.kind 覆盖。 */
  const ARCHIVE_RE = /\.(zip|7z|rar|tar|gz|tgz|bz2|tbz2|xz|txz|zst|cab|iso|001)$/i;
  const kindOf = (p) => {
    const s = String(p || '');
    const name = s.split(/[\\/]/).pop() || '';
    if (ARCHIVE_RE.test(name)) return 'archive';
    return /\.[a-z0-9]{1,8}$/i.test(name) ? 'file' : 'dir';
  };
  const KIND_TEXT = {
    dir: ['文件夹', 'Folder'],
    archive: ['压缩包', 'Archive'],
    file: ['文件', 'File']
  };
  const kindLabel = (k) => T((KIND_TEXT[k] || KIND_TEXT.file)[0], (KIND_TEXT[k] || KIND_TEXT.file)[1]);
  const kindIcon = (k) => icon(k === 'dir' ? 'folder' : (k === 'archive' ? 'archive' : 'file'));

  window.Pages = window.Pages || {};

  window.Pages.migrate = {
    title: ['数据迁移', 'Migrate'],
    subtitle: ['把文件搬到新的数据目录，先预演再执行', 'Move files to a new folder, plan before applying'],

    async mount(root) {
      const state = {
        sources: [],
        destination: '',
        mode: 'move',
        conflict: 'rename',
        plan: null,
        result: null,
        running: false
      };

      const titleRow = (text, hint) => h('div', { class: 'card-title' },
        h('h2', null, text),
        hint ? h('div', { class: 'hint', text: hint }) : null
      );

      const stat = (value, key) => h('div', { class: 'stat' },
        h('div', { class: 'v', text: value }),
        h('div', { class: 'k', text: key })
      );

      const planSlot = h('div', { class: 'stack' });
      const resultSlot = h('div', { class: 'stack' });

      function renderOutputs() {
        planSlot.replaceChildren(state.plan ? planCard() : '');
        resultSlot.replaceChildren(state.result ? resultCard() : '');
      }

      function paint() {
        root.textContent = '';
        root.appendChild(actionCard());
        root.appendChild(h('div', { class: 'migrate-grid' },
          h('div', { class: 'migrate-col' }, sourcesCard()),
          h('div', { class: 'migrate-col' }, optionsCard())
        ));
        renderOutputs();
        root.appendChild(planSlot);
        root.appendChild(resultSlot);
      }

      /* ---------- 顶部动作 + 目标目录 ---------- */
      function actionCard() {
        const askBtn = UI.askBtn({
          title: T('问助手 · 数据迁移', 'Ask AI · Migrate'),
          question: T('帮我检查这批迁移来源和目标目录，预演看有没有冲突或跨盘风险。', 'Review these migration sources and destination and preview conflicts or cross-volume risks.'),
          ctx: () => ({
            page: '数据迁移',
            sources: state.sources.slice(0, 8),
            destination: state.destination.trim(),
            note: T(state.sources.length + ' 个来源 · ' + state.mode, state.sources.length + ' sources · ' + state.mode)
          })
        });
        return card(
          h('div', { class: 'toolbar' },
            h('span', { class: 'spacer' }),
            h('button', {
              class: 'btn', disabled: state.running, onclick: doPlan
            }, icon('scan'), h('span', { text: T('预演计划', 'Plan') })),
            h('button', {
              class: 'btn primary', disabled: state.running, onclick: doApply
            }, icon('play'), h('span', { text: T('执行迁移', 'Run') })),
            askBtn
          ),
          h('div', { class: 'row' },
            h('span', { class: 'small muted', style: { minWidth: '58px' }, text: T('目标目录', 'Destination') }),
            h('input', {
              class: 'input grow mono',
              spellcheck: 'false',
              value: state.destination,
              placeholder: T('例如 D:\\资料（不能是盘符根目录）', 'e.g. D:\\Data (drive roots not allowed)'),
              oninput: (e) => {
                state.destination = e.target.value;
                // 目标变了，上一份预演就作废：只更新底部预演卡，不重绘整页丢焦点
                if (state.plan) { state.plan = null; renderOutputs(); }
              }
            }),
            h('button', {
              class: 'btn',
              disabled: state.running,
              onclick: browseTarget
            }, icon('folder'), h('span', { text: T('浏览…', 'Browse…') }))
          )
        );
      }

      /* ---------- 来源列表 ---------- */
      function sourcesCard() {
        const list = state.sources.length
          ? h('div', { class: 'list' }, state.sources.map((dir) =>
            attachMenu(h('div', { class: 'list-item' },
              kindIcon(kindOf(dir)),
              h('span', { class: 'badge sm', text: kindLabel(kindOf(dir)) }),
              h('span', { class: 'ellipsis spacer', title: dir, text: dir }),
              h('button', {
                class: 'btn ghost sm icon',
                title: T('移除', 'Remove'),
                'aria-label': T('移除', 'Remove'),
                disabled: state.running,
                onclick: () => {
                  state.sources = state.sources.filter((s) => s !== dir);
                  state.plan = null;
                  paint();
                }
              }, icon('close', 14))
            ), [
              { label: T('在软件内定位', 'Locate in app'), icon: 'scan', action: () => openInApp(dir) },
              { label: T('在系统文件管理器中打开', 'Open in system file manager'), icon: 'external', action: () => revealPath(dir) },
              { label: T('复制路径', 'Copy path'), icon: 'copy', action: () => copyText(dir) },
              { sep: true },
              {
                label: T('移除此来源', 'Remove source'), icon: 'close', danger: true,
                action: () => { state.sources = state.sources.filter((s) => s !== dir); state.plan = null; paint(); }
              }
            ])
          ))
          : empty(T('还没有添加来源', 'No sources yet'),
            T('可添加文件夹、压缩包或单个文件，支持多项', 'Add folders, archives or single files; multiple items are fine'));

        return card(
          titleRow(T('来源', 'Sources'), T('共 {n} 项', '{n} total').replace('{n}', fmtCount(state.sources.length))),
          h('div', { class: 'toolbar' },
            h('button', {
              class: 'btn',
              disabled: state.running,
              onclick: addSource
            }, icon('plus'), h('span', { text: T('添加文件夹', 'Add folder') })),
            h('button', {
              class: 'btn',
              disabled: state.running,
              onclick: addFiles
            }, icon('file'), h('span', { text: T('添加文件', 'Add files') })),
            h('button', {
              class: 'btn ghost sm',
              disabled: state.running || state.sources.length === 0,
              onclick: () => { state.sources = []; state.plan = null; paint(); }
            }, h('span', { text: T('清空', 'Clear') }))
          ),
          list
        );
      }

      async function addSource() {
        try {
          const dir = await API.pickFolder(state.destination.trim() || undefined);
          if (!dir) return;
          pushSources([dir]);
        } catch (e) {
          toast(e && e.message ? e.message : String(e), 'error');
        }
      }

      /* 压缩包、单个文件也能当来源：它们不展开，整份搬到目标目录。 */
      async function addFiles() {
        try {
          const picked = await API.pickFiles();
          if (!picked || !picked.length) return;
          pushSources(picked);
        } catch (e) {
          toast(e && e.message ? e.message : String(e), 'error');
        }
      }

      function pushSources(paths) {
        const added = [];
        paths.forEach((p) => {
          if (p && !state.sources.includes(p)) { state.sources.push(p); added.push(p); }
        });
        if (!added.length) {
          toast(T('这些项目已经在列表里', 'Those items are already listed'), 'warn');
          return;
        }
        state.plan = null;
        paint();
      }

      async function browseTarget() {
        try {
          const dir = await API.pickFolder(state.destination.trim() || undefined);
          if (!dir) return;
          state.destination = dir;
          state.plan = null;
          paint();
        } catch (e) {
          toast(e && e.message ? e.message : String(e), 'error');
        }
      }

      /* ---------- 选项 ---------- */
      function optionsCard() {
        const modeRow = h('div', { class: 'row' }, MODES.map((m) =>
          h('label', { class: 'check' },
            h('input', {
              type: 'radio',
              name: 'migrate-mode',
              checked: state.mode === m.value,
              onchange: () => { state.mode = m.value; state.plan = null; paint(); }
            }),
            h('span', { text: T(m.zh, m.en) })
          )
        ));

        const conflictSelect = UI.customSelect({
          options: CONFLICTS.map((c) => ({ value: c.value, label: T(c.zh, c.en) })),
          value: state.conflict,
          onChange: (v) => { state.conflict = v; state.plan = null; paint(); }
        });

        return card(
          titleRow(T('迁移选项', 'Options'), null),
          h('div', { class: 'grid-2' },
            h('div', { class: 'field' },
              h('label', { text: T('处理方式', 'Mode') }),
              modeRow,
              h('div', { class: 'desc', text: T('移动会删除原位置的文件，复制会保留原文件', 'Move deletes the originals, copy keeps them') })
            ),
            h('div', { class: 'field' },
              h('label', { text: T('同名冲突', 'Name clashes') }),
              conflictSelect,
              h('div', { class: 'desc', text: T('目标位置已有同名项时的处理方式；同名文件夹默认改名共存，不会并进旧文件夹',
                'What to do when the name already exists; a clashing folder is renamed, not merged into the old one') })
            )
          )
        );
      }

      function checkInputs() {
        if (!state.sources.length) {
          toast(T('请先添加来源', 'Add a source first'), 'warn');
          return false;
        }
        if (!state.destination.trim()) {
          toast(T('请先选择目标目录', 'Choose a destination first'), 'warn');
          return false;
        }
        return true;
      }

      function planParams() {
        const destination = state.destination.trim();
        return {
          sources: state.sources.slice(),
          destination,
          target: destination,
          mode: state.mode,
          conflict: state.conflict
        };
      }

      /* ---------- 预演 ---------- */
      async function doPlan() {
        if (!checkInputs()) return;
        state.running = true;
        paint();
        const res = await busy(
          () => API.engine('migrate.plan', planParams()),
          T('正在预演迁移计划…', 'Planning migration…'), 'migrate'
        );
        state.running = false;
        if (res) {
          state.plan = res;
          state.result = null;
          const blocked = (res.blocked || []).length;
          toast(blocked
            ? T('预演完成，有 {n} 个来源被阻断', 'Plan ready, {n} source(s) blocked').replace('{n}', fmtCount(blocked))
            : T('预演完成', 'Plan ready'), blocked ? 'warn' : 'ok');
        }
        paint();
      }

      /* ---------- 执行 ---------- */
      async function doApply() {
        if (!checkInputs()) return;
        const destination = state.destination.trim();
        const ok = await confirm({
          title: T('确认执行迁移', 'Run migration'),
          body: T(
            '将把 ' + fmtCount(state.sources.length) + ' 个来源' + (state.mode === 'move' ? '移动' : '复制') +
            '到 ' + destination + '，同名项按“' + labelOf(CONFLICTS, state.conflict) + '”处理。失败的项目会保留在原位置，不会自动回滚。',
            'This will ' + (state.mode === 'move' ? 'move' : 'copy') + ' ' + fmtCount(state.sources.length) +
            ' source(s) to ' + destination + '. Failed items stay in place; there is no automatic rollback.'
          ),
          ok: T('开始迁移', 'Start'),
          danger: true
        });
        if (!ok) return;

        state.running = true;
        paint();
        const res = await busy(
          () => API.engine('migrate.apply', Object.assign(planParams(), { confirm: true })),
          T('正在迁移，请勿关闭窗口…', 'Migrating, keep this window open…'), 'migrate'
        );
        state.running = false;
        if (res) {
          if (res.refused) {
            state.result = res;
            state.plan = null;
            toast(res.error || T('存在阻断项，未执行迁移', 'Blocked, nothing was moved'), 'warn');
          } else if (res.cancelled) {
            toast(T('迁移已取消', 'Migration cancelled'), 'warn');
          } else {
            state.result = res;
            state.plan = null;
            state.sources = [];
            const failed = (res.failed || []).length;
            toast(failed
              ? T('迁移完成，{n} 个来源失败', 'Finished, {n} source(s) failed').replace('{n}', fmtCount(failed))
              : T('迁移完成', 'Migration complete'), failed ? 'warn' : 'ok');
          }
        }
        paint();
      }

      /* ---------- 预演结果 ---------- */
      function planCard() {
        const plan = state.plan;
        const jobs = plan.jobs || [];
        const blocked = plan.blocked || [];
        const clashCount = jobs.filter((j) => j.conflict).length;

        const parts = [
          titleRow(T('预演结果', 'Plan'),
            T('{n} 个来源 · {f} 个文件', '{n} source(s) · {f} files')
              .replace('{n}', fmtCount(jobs.length))
              .replace('{f}', fmtCount(plan.total_files || 0))),
          h('div', { class: 'stats' },
            stat(fmtCount(plan.total_files || 0), T('文件数', 'Files')),
            stat(fmtBytes(plan.total_size || 0), T('总大小', 'Total size')),
            stat(fmtCount(clashCount), T('同名冲突', 'Clashes')),
            stat(fmtCount(blocked.length), T('阻断项', 'Blocked'))
          )
        ];

        if (plan.cross_volume) {
          parts.push(h('div', { class: 'row' },
            h('span', { class: 'badge warn', text: T('跨磁盘', 'Cross volume') }),
            h('span', { class: 'small muted', text: T('跨磁盘迁移会先复制再删除，耗时更长', 'Cross-volume moves copy then delete, which takes longer') })
          ));
        }

        if (jobs.length) {
          parts.push(h('div', { class: 'table-wrap' }, table({
            columns: [
              { key: 'source', label: T('来源', 'Source'), render: (r) => h('span', { class: 'ellipsis', title: r.source, text: r.source }) },
              { key: 'kind', label: T('类型', 'Type'), width: '84px', render: (r) => h('span', { class: 'badge sm', text: kindLabel(r.kind || kindOf(r.source)) }) },
              { key: 'target', label: T('迁移到', 'Destination'), render: (r) => h('span', { class: 'ellipsis muted', title: r.target, text: r.target }) },
              { key: 'items', label: T('条目', 'Items'), align: 'right', width: '72px', render: (r) => fmtCount(r.items) },
              { key: 'size', label: T('大小', 'Size'), align: 'right', width: '92px', render: (r) => fmtBytes(r.size) },
              { key: 'conflict', label: T('冲突', 'Clash'), width: '80px', render: (r) => r.conflict
                ? h('span', { class: 'badge warn', text: T('同名', 'Exists') })
                : h('span', { class: 'badge ok', text: T('无', 'None') }) }
            ],
            rows: jobs
          })));
        }

        if (blocked.length) {
          parts.push(h('div', { class: 'stack' },
            h('div', { class: 'small', text: T('以下来源被阻断，执行时会被跳过：', 'These sources are blocked and will be skipped:') }),
            h('div', { class: 'table-wrap' }, table({
              columns: [
                { key: 'source', label: T('来源', 'Source'), render: (r) => h('span', { class: 'ellipsis', title: r.source, text: r.source }) },
                { key: 'why', label: T('原因', 'Reason'), render: (r) => h('span', { class: 'small muted', text: r.why }) }
              ],
              rows: blocked
            }))
          ));
        }

        return card(...parts);
      }

      /* ---------- 执行结果 ---------- */
      function resultCard() {
        const res = state.result;
        const failed = res.failed || [];

        if (res.refused) {
          return card(
            titleRow(T('未执行', 'Not started'), null),
            empty(res.error || T('存在阻断项，未执行迁移', 'Blocked, nothing was moved')),
            failed.length ? failedTable(failed) : null
          );
        }

        const parts = [
          titleRow(T('迁移结果', 'Result'),
            res.job_id ? T('任务 {id}', 'Job {id}').replace('{id}', res.job_id) : null),
          h('div', { class: 'stats' },
            stat(fmtCount(res.moved || 0), T('成功', 'Moved')),
            stat(fmtCount(failed.length), T('失败', 'Failed')),
            stat(fmtCount(res.skipped || 0), T('跳过', 'Skipped')),
            stat(fmtBytes(res.total_size || 0), T('总大小', 'Total size'))
          ),
          h('div', { class: 'toolbar' },
            h('button', { class: 'btn', onclick: openTarget }, icon('folder'), h('span', { text: T('打开目标目录', 'Open destination') })),
            res.report_path
              ? h('button', { class: 'btn ghost', onclick: () => revealPath(res.report_path) }, icon('external'), h('span', { text: T('打开报告', 'Open report') }))
              : null
          )
        ];

        if (res.report_path) {
          parts.push(h('div', { class: 'row' },
            h('span', { class: 'small muted', text: T('报告', 'Report') }),
            h('span', { class: 'mono ellipsis', title: res.report_path, style: { minWidth: 0, flex: 1 }, text: res.report_path })
          ));
        }

        if (failed.length) parts.push(failedTable(failed));

        return card(...parts);
      }

      function failedTable(failed) {
        return h('div', { class: 'stack' },
          h('div', { class: 'small', text: T('失败明细：', 'Failures:') }),
          h('div', { class: 'table-wrap' }, table({
            columns: [
              { key: 'source', label: T('来源', 'Source'), render: (r) => h('span', { class: 'ellipsis', title: r.source, text: r.source }) },
              { key: 'why', label: T('原因', 'Reason'), render: (r) => h('span', { class: 'small muted', text: r.why }) }
            ],
            rows: failed
          }))
        );
      }

      function openInApp(path) {
        if (!path) return;
        if (window.AIEntries && typeof window.AIEntries.open === 'function') window.AIEntries.open(path);
        else revealPath(path);
      }

      async function revealPath(path) {
        try { await API.reveal(path); } catch (e) { toast(e && e.message ? e.message : String(e), 'error'); }
      }

      async function openTarget() {
        const dir = (state.result && state.result.destination) || state.destination.trim();
        if (!dir) return;
        if (window.AIEntries && typeof window.AIEntries.open === 'function') {
          await window.AIEntries.open(dir);
          return;
        }
        try { await API.openPath(dir); } catch (e) { toast(e && e.message ? e.message : String(e), 'error'); }
      }

      setActions();

      liveJump = function (payload) {
        const p = payload || {};
        const srcs = Array.isArray(p.sources) ? p.sources : (Array.isArray(p.paths) ? p.paths : []);
        srcs.filter(Boolean).map(String).forEach((s) => {
          if (!state.sources.includes(s)) state.sources.push(s);
        });
        if (p.destination || p.target) state.destination = String(p.destination || p.target).trim();
        state.plan = null;
        paint();
      };

      paint();

      return function unmount() {
        liveJump = null;
        setActions();
      };
    },

    jump(payload) { return liveJump ? liveJump(payload || {}) : undefined; }
  };
})();
