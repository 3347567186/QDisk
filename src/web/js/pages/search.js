/* 搜索页：索引状态、目录管理、查询与分页结果 */
(function () {
  'use strict';

  const { h, T, icon, toast, empty, table, attachMenu, menu, skeleton, setActions } = UI;

  let PAGE_SIZE = 15;
  const STEP = 500;
  const MAX_LIMIT = 5000;

  const errText = UI.errText;

  let active = null;
  let liveJump = null;

  UI.onLangChange(() => {
    if (active && active.root.isConnected) active.paint();
  });

  const copyText = UI.copy;

  window.Pages = window.Pages || {};

  window.Pages.search = {
    title: ['搜索', 'Search'],
    subtitle: ['查找文件并定位到所在位置', 'Find files and reveal them in Explorer'],

    async mount(root) {
      PAGE_SIZE = UI.pageSize();
      const state = {
        backend: '',
        indexed: 0,
        dirs: 0,
        sizeBytes: 0,
        schema: 0,
        walker: '',
        elapsed: 0,
        entries: [],
        scope: [],
        indexDir: '',
        builtAt: '',
        indexPath: '',
        roots: [],
        query: '',
        lastQuery: '',
        seq: 0,
        items: [],
        limit: 1000,
        page: 0,
        source: '',
        hint: '',
        searched: false,
        searching: false,
        statusLoading: true,
        indexing: false,
        drives: [],
        excludedDrives: []
      };

      function paint() {
        root.textContent = '';
        root.appendChild(h('div', { class: 'stack page-fill' },
          indexCard(),
          searchBar(),
          resultsBlock()
        ));
        root.classList.add('page-fill');
      }

      /* ---------- 索引：清单、范围、详情都集中在这一处 ---------- */
      function statItem(k, v, cls) {
        return h('div', { class: 'stat' },
          h('div', { class: 'v' + (cls ? ' ' + cls : ''), text: v }),
          h('div', { class: 'k', text: k }));
      }

      // 32 ms 显示成 0.0s 没有信息量：一秒以下按毫秒显示
      function fmtSpan(ms) {
        if (!ms) return '—';
        return ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(1) + ' s';
      }

      function scopeIds() {
        // 空数组代表「全部索引」：默认搜索所有已建立的库
        return state.scope.slice();
      }

      function scopeLabel() {
        const n = state.entries.length;
        if (!n) return T('还没有添加索引目录', 'No folders yet');
        if (!state.scope.length) return T('搜索范围：全部', 'Scope: all') + ' ' + n + ' ' + T('个索引', 'indexes');
        return T('搜索范围：选中', 'Scope: selected') + ' ' + state.scope.length + ' / ' + n;
      }

      function indexCard() {
        const badge = state.statusLoading
          ? h('span', { class: 'badge', text: T('读取中…', 'Loading…') })
          : h('span', {
            class: 'badge ' + (state.backend === 'Everything' ? 'accent' : 'ok'),
            text: state.backend || T('未知', 'Unknown')
          });
        const hint = state.entries.length
          ? scopeLabel()
            + (state.elapsed ? ' · ' + T('上次用时', 'Last run') + ' ' + fmtSpan(state.elapsed) : '')
          : T('还没有索引目录', 'No folders yet');

        return UI.card(
          h('div', { class: 'card-title' },
            h('h2', null, T('索引', 'Index')),
            badge,
            h('div', { class: 'spacer' }),
            h('button', { class: 'btn sm', onclick: openIndexManager },
              icon('layers', 14), h('span', { text: T('管理索引', 'Manage') }))
          ),
          h('div', { class: 'stats inline' },
            statItem(T('文件', 'Files'), UI.fmtCount(state.indexed)),
            statItem(T('目录', 'Folders'), UI.fmtCount(state.dirs)),
            statItem(T('占用', 'Size'), UI.fmtBytes(state.sizeBytes)),
            statItem(T('建立时间', 'Built'), state.builtAt ? UI.fmtDateTime(state.builtAt) : '—', 'ts')
          ),
          h('div', { class: 'toolbar' },
            h('span', { class: 'small muted', text: hint }),
            h('div', { class: 'spacer' }),
            h('button', {
              class: 'btn sm primary',
              disabled: state.indexing,
              title: T('自动识别本机所有主要磁盘（如 C:\\、D:\\、E:\\）并一键全覆盖建立索引', 'Auto-detect all main local drives and build full-coverage index'),
              onclick: () => oneClickIndexAllDrives()
            }, icon('drive', 14), h('span', { text: T('一键建立索引', 'One-click index') })),
            h('button', {
              class: 'btn sm', disabled: !state.entries.length || state.indexing, onclick: () => buildIndex(false)
            }, icon('scan', 14), h('span', { text: T('建立索引', 'Index') })),
            h('button', {
              class: 'btn sm', disabled: !state.entries.length || state.indexing, onclick: () => buildIndex(true)
            }, icon('undo', 14), h('span', { text: T('重建索引', 'Rebuild') }))
          )
        );
      }

      /* ---------- 索引详情（弹窗） ---------- */
      function kv(k, v) {
        return h('div', { class: 'kv-pair' }, h('dt', null, k), h('dd', { class: 'mono', title: v, text: v }));
      }

      function stateBadge(r) {
        if (!r.exists) return h('span', { class: 'badge', text: T('待建立', 'Not built') });
        if (r.exists_root === false) return h('span', { class: 'badge danger', text: T('目录不存在', 'Missing') });
        if (r.why) return h('span', { class: 'badge warn', text: T('未完成', 'Partial') });
        return h('span', { class: 'badge ok', text: T('已建立', 'Built') });
      }

      function managerBody(host) {
        const parts = [];
        const rows = state.entries || [];

        // 刚建完索引时进程里有 walker；重启后进程里没有，就从条目里挑一个
        const walkerName = state.walker
          || ((rows.find((r) => r.walker) || {}).walker || '');
        parts.push(UI.section(T('概况', 'Overview'), h('dl', { class: 'kv' },
          kv(T('索引目录', 'Index folder'), state.indexDir || '—'),
          kv(T('索引数量', 'Indexes'), UI.fmtCount(rows.length) + ' ' + T('个', 'total')),
          kv(T('文件 / 目录', 'Files / folders'), UI.fmtCount(state.indexed) + ' / ' + UI.fmtCount(state.dirs)),
          kv(T('占用大小', 'Size'), UI.fmtBytes(state.sizeBytes)),
          kv(T('最近建立', 'Last built'), state.builtAt ? UI.fmtDateTime(state.builtAt) : '—'),
          kv(T('遍历器', 'Walker'), walkerName ? (walkerName === 'rust' ? 'indexwalk (Rust 多线程)' : 'Python scandir') : '—'),
          kv(T('格式版本', 'Schema'), state.schema ? 'v' + state.schema : '—')
        ), { open: true }));

        const cols = [
          {
            key: 'scope', label: T('搜索', 'Search'), width: '56px',
            render: (r) => h('input', {
              type: 'checkbox',
              checked: state.scope.includes(r.id),
              title: T('是否参与搜索（不勾选则搜全部）', 'Include in search'),
              onchange: (e) => { toggleScope(r.id, e.target.checked); }
            })
          },
          {
            key: 'root', label: T('索引目录', 'Folder'),
            render: (r) => h('span', { class: 'mono ellipsis', title: r.root, text: r.root })
          },
          { key: 'files', label: T('文件', 'Files'), width: '84px', align: 'right', render: (r) => UI.fmtCount(r.files || 0) },
          { key: 'dirs', label: T('目录', 'Folders'), width: '76px', align: 'right', render: (r) => UI.fmtCount(r.dirs || 0) },
          { key: 'size', label: T('占用', 'Size'), width: '88px', align: 'right', render: (r) => UI.fmtBytes(r.size_bytes || 0) },
          { key: 'built', label: T('建立时间', 'Built'), width: '130px', align: 'right', render: (r) => (r.built_at ? UI.fmtTime(r.built_at) : '—') },
          { key: 'state', label: T('状态', 'State'), width: '92px', render: (r) => stateBadge(r) },
          {
            key: 'ops', label: T('操作', 'Actions'), width: '76px',
            render: (r) => h('button', {
              class: 'btn icon sm danger',
              disabled: state.indexing,
              title: T('删除这个索引', 'Delete this index'),
              onclick: (e) => { e.stopPropagation(); deleteIndex(r, host); }
            }, icon('trash', 14))
          }
        ];

        const tbl = table({ columns: cols, rows, rowKey: (r) => r.id });
        tbl.querySelectorAll('tbody tr').forEach((tr, i) => {
          const row = rows[i];
          if (!row) return;
          tr.dataset.ctx = 'index';
          attachMenu(tr, [
            { label: T('在软件内浏览目录', 'Browse folder in app'), icon: 'scan', action: () => openInApp(row.root) },
            { label: T('在系统文件管理器中打开', 'Open in system file manager'), icon: 'external', action: () => reveal(row.root) },
            { label: T('复制路径', 'Copy path'), icon: 'copy', action: () => copyText(row.root) },
            { sep: true },
            { label: T('重建这个索引', 'Rebuild this index'), icon: 'scan', action: () => buildIndex(true, [row.id]) },
            { label: T('删除索引', 'Delete index'), icon: 'trash', danger: true, action: () => deleteIndex(row, host) }
          ]);
        });

        parts.push(UI.section(T('索引列表', 'Indexes') + (rows.length ? ' · ' + rows.length : ''),
          rows.length
            ? h('div', { class: 'stack' },
              h('div', { class: 'table-wrap' }, tbl),
              h('div', { class: 'note', text: T('勾选决定搜索范围；一个都不勾表示搜全部。删除只删索引文件，不动源目录里的文件。',
                'Checkboxes set the search scope; none checked means all. Deleting removes the index file only, never your files.') }))
            : h('div', { class: 'small muted', text: T('还没有索引，点击下方「一键建立索引」可自动识别并全覆盖电脑主要盘，或手动添加目录', 'No indexes yet — click One-click index to cover all main drives, or add a folder') }),
          { open: true }));

        parts.push(h('div', { class: 'toolbar' },
          h('button', {
            class: 'btn sm primary',
            disabled: state.indexing,
            title: T('自动识别电脑主要盘并一键全覆盖建立索引', 'Auto-detect main local drives and index all'),
            onclick: () => oneClickIndexAllDrives()
          }, icon('drive', 14), h('span', { text: T('一键建立索引', 'One-click index') })),
          h('button', {
            class: 'btn sm', disabled: state.indexing, onclick: () => addRoot(host)
          }, icon('plus', 14), h('span', { text: T('添加目录', 'Add folder') })),
          h('button', {
            class: 'btn sm', disabled: !state.scope.length || state.indexing, onclick: () => buildIndex(false, scopeIds())
          }, icon('scan', 14), h('span', { text: T('建立选中', 'Index checked') + (state.scope.length ? ' · ' + state.scope.length : '') })),
          h('button', {
            class: 'btn sm', disabled: !rows.length || state.indexing, onclick: () => buildIndex(true)
          }, icon('undo', 14), h('span', { text: T('全部重建', 'Rebuild all') })),
          h('div', { class: 'spacer' }),
          h('button', {
            class: 'btn sm', disabled: !state.indexDir, onclick: () => openInApp(state.indexDir)
          }, icon('scan', 14), h('span', { text: T('在软件内打开索引目录', 'Browse index folder') })),
          h('button', {
            class: 'btn sm ghost', disabled: !state.indexDir, onclick: () => reveal(state.indexDir)
          }, icon('external', 14), h('span', { text: T('系统文件管理器', 'Explorer') }))
        ));

        return parts;
      }

      async function openIndexManager() {
        if (manager && manager.modal && typeof manager.modal.close === 'function') {
          manager.modal.close();
        }
        const host = h('div', { class: 'stack' });
        const render = () => host.replaceChildren(...managerBody(host));
        render();
        const modalRef = UI.modal({
          title: T('索引详情', 'Index details'),
          wide: true,
          body: host,
          buttons: [{ id: 'close', label: T('关闭', 'Close'), kind: 'ghost' }],
          onClose: () => { if (manager && manager.modal === modalRef) manager = null; }
        });
        manager = { host, render, modal: modalRef };
      }

      let manager = null;

      function toggleScope(id, on) {
        const set = new Set(state.scope);
        if (on) set.add(id); else set.delete(id);
        state.scope = Array.from(set);
        try {
          localStorage.setItem('ta.index.scope', JSON.stringify(state.scope));
        } catch (e) { /* 记不住就算了，不影响搜索 */ }
        manager && manager.render();
        paint();
      }

      async function addRoot(host) {
        if (state.indexing) return;
        try {
          const dir = await API.pickFolder();
          if (!dir) return;
          if (state.entries.some((r) => (r.root || '').toLowerCase() === dir.toLowerCase())) {
            toast(T('该目录已在列表中', 'That folder is already listed'), 'warn');
            return;
          }
          await UI.busy(async () => {
            await API.engine('search.add', { roots: [dir] });
            await refreshStatus({ quiet: true });
          }, T('正在添加索引目录…', 'Adding indexed folder…'), 'search');
          manager && manager.render();
          paint();
          toast(T('已添加目录，点「建立索引」生效', 'Folder added — run Index to apply'), 'ok');
        } catch (e) {
          toast(errText(e), 'error');
        }
      }

      async function deleteIndex(row, host) {
        if (state.indexing) return;
        const ok = await UI.confirm({
          title: T('删除索引', 'Delete index'),
          body: T('只删除这个索引文件，源目录里的文件不受影响。', 'Only the index file is removed; your files stay untouched.')
            + '\n' + (row.root || ''),
          ok: T('删除', 'Delete'),
          danger: true
        });
        if (!ok) return;
        const removed = await UI.busy(async () => {
          await API.engine('search.remove', { ids: [row.id] });
          state.scope = state.scope.filter((id) => id !== row.id);
          await refreshStatus({ quiet: true });
          return true;
        }, T('正在删除索引文件…', 'Deleting index…'), 'search');
        if (removed) {
          manager && manager.render();
          paint();
          toast(T('索引已删除', 'Index deleted'), 'ok');
        }
      }

      /* ---------- 搜索栏 ---------- */
      function searchBar() {
        const input = h('input', {
          class: 'input grow',
          type: 'search',
          spellcheck: 'false',
          placeholder: T('输入文件名或关键字，回车搜索', 'Type a file name or keyword, press Enter'),
          value: state.query,
          oninput: (e) => { state.query = e.target.value; },
          onkeydown: (e) => {
            if (e.key === 'Enter') { e.preventDefault(); runSearch(); }
          }
        });

        const askBtn = UI.askBtn({
          title: T('问助手 · 文件搜索', 'Ask AI · Search'),
          question: T('帮我按关键词或索引状态查找目标文件，或者排查搜索/Everything 异常。', 'Help me search for files or diagnose search / Everything index status.'),
          ctx: () => ({
            page: '搜索',
            query: state.query || state.lastQuery,
            backend: state.backend,
            indexed: state.indexed,
            dirs: state.entries.map((e) => e.path)
          })
        });

        return h('div', { class: 'toolbar' },
          input,
          h('button', {
            class: 'btn primary',
            disabled: state.searching,
            onclick: () => runSearch()
          }, icon('search', 14), h('span', { text: state.searching ? T('搜索中…', 'Searching…') : T('搜索', 'Search') })),
          h('button', {
            class: 'btn',
            disabled: !state.searched,
            onclick: clearResults
          }, icon('close', 14), h('span', { text: T('清空', 'Clear') })),
          askBtn
        );
      }

      async function runSearch() {
        const q = String(state.query || '').trim();
        if (!q) {
          toast(T('请输入搜索关键字', 'Enter a keyword first'), 'warn');
          return;
        }
        if (state.searching) return; // 回车可以绕过按钮 disabled，这里挡重入
        const mySeq = ++state.seq;
        state.searching = true;
        state.limit = 1000;
        state.lastQuery = q;
        paint();
        try {
          const r = await API.engine('search.query', { q, limit: state.limit, ids: scopeIds() });
          if (mySeq !== state.seq) return;
          state.items = (r && r.items) || [];
          state.elapsed = (r && r.elapsed_ms) || 0;
          state.source = (r && r.source) || '';
          state.hint = (r && r.hint) || '';
          // Everything 模式是全局搜索，选了「搜索范围」也不会生效：说清楚，别让范围勾选骗人
          if (r && r.source === 'es' && scopeIds().length) {
            state.hint = T('Everything 模式下搜索范围不生效，结果包含范围外的文件',
              'Everything mode searches globally; the scope selection is ignored');
          }
          state.page = 0;
          state.searched = true;
          if (r && r.error) toast(r.error, 'error');
        } catch (e) {
          if (mySeq !== state.seq) return;
          state.items = [];
          state.searched = true;
          toast(errText(e), 'error');
        } finally {
          if (mySeq === state.seq) { state.searching = false; paint(); }
        }
      }

      function clearResults() {
        state.seq += 1; // 让在途查询的响应失效
        state.lastQuery = '';
        state.items = [];
        state.searched = false;
        state.page = 0;
        state.hint = '';
        state.elapsed = 0;
        paint();
      }

      async function loadMore() {
        if (state.searching || state.limit >= MAX_LIMIT) return;
        const next = Math.min(state.limit + STEP, MAX_LIMIT);
        const mySeq = state.seq;
        state.searching = true;
        paint();
        try {
          // 用「上一次真正执行的查询」而不是输入框里的实时文本，
          // 否则改了关键字还没回车时点加载更多，会混进另一组结果。
          const r = await API.engine('search.query', { q: state.lastQuery || '', limit: next, ids: scopeIds() });
          if (mySeq !== state.seq) return;
          const fresh = (r && r.items) || [];
          const seen = new Set(state.items.map((it) => it.path));
          const merged = state.items.slice();
          fresh.forEach((it) => { if (!seen.has(it.path)) { seen.add(it.path); merged.push(it); } });
          state.items = merged;
          state.limit = next;
          state.elapsed = (r && r.elapsed_ms) || 0;
          state.source = (r && r.source) || state.source;
          if (r && r.hint) state.hint = r.hint;
        } catch (e) {
          toast(errText(e), 'error');
        }
        state.searching = false;
        paint();
      }

      /* ---------- 结果 ---------- */
      function pageCount() {
        return Math.max(1, Math.ceil(state.items.length / PAGE_SIZE));
      }

      function resultsBlock() {
        let inner = null;
        let foot = null;
        let noteNode = null;
        let hintText = T('按文件名或关键字搜索', 'Search by name or keyword');

        if (state.searching && !state.items.length) {
          inner = UI.skeleton(8, 'search');
          hintText = T('正在搜索…', 'Searching…');
        } else if (!state.searched) {
          inner = UI.empty(
            T('还没有搜索', 'No search yet'),
            state.entries.length
              ? T('输入文件名或关键字按回车即可快速定位', 'Type a filename or keyword and press Enter')
              : T('点击上方「一键建立索引」自动覆盖本机主要盘，搜索更快', 'Click "One-click index" above to cover all main local drives for instant search')
          );
        } else if (!state.items.length) {
          inner = UI.empty(T('没有匹配的文件', 'No matching files'), state.hint || '');
          hintText = T('没有匹配', 'No matches');
        } else {
          const start = state.page * PAGE_SIZE;
          const slice = state.items.slice(start, start + PAGE_SIZE);

          const cols = [
            {
              key: 'name', label: T('名称', 'Name'),
              render: (r) => h('div', { class: 'name' }, icon(r.kind === 'dir' ? 'folder' : 'file', 14), h('span', { class: 'txt', text: r.name || '—' }))
            },
            {
              key: 'path', label: T('路径', 'Path'),
              render: (r) => h('span', { class: 'mono ellipsis', title: r.path || '', text: r.path || '—' })
            },
            { key: 'size', label: T('大小', 'Size'), width: '90px', align: 'right', render: (r) => r.kind === 'dir' ? T('文件夹', 'Folder') : UI.fmtBytes(r.size || 0) },
            { key: 'mtime', label: T('修改时间', 'Modified'), width: '140px', align: 'right', render: (r) => r.mtime ? UI.fmtTime(r.mtime) : '—' },
            {
              key: 'ops', label: T('操作', 'Actions'), width: '80px', align: 'right',
              render: (r) => h('div', { class: 'row', style: { justifyContent: 'flex-end', gap: '4px' } },
                h('button', {
                  type: 'button',
                  class: 'btn icon sm ghost',
                  title: T('在软件内定位查看', 'Locate in app'),
                  'aria-label': T('在软件内定位查看', 'Locate in app'),
                  onclick: (e) => { e.stopPropagation(); openInApp(r.path); }
                }, icon('scan', 13)),
                h('button', {
                  type: 'button',
                  class: 'btn icon sm ghost',
                  title: T('在系统文件管理器中打开', 'Open in system file manager'),
                  'aria-label': T('在系统文件管理器中打开', 'Open in system file manager'),
                  onclick: (e) => { e.stopPropagation(); reveal(r.path); }
                }, icon('external', 13))
              )
            }
          ];

          const body = table({ columns: cols, rows: slice, rowKey: (r) => r.path });

          body.querySelectorAll('tbody tr').forEach((tr, i) => {
            const row = slice[i];
            if (!row) return;
            tr.dataset.ctx = 'result';
            tr.addEventListener('click', (e) => {
              if (e.target && e.target.closest && e.target.closest('button')) return;
              openInApp(row.path);
            });
            const isExec = window.AIEntries && window.AIEntries.isExecPath && window.AIEntries.isExecPath(row.path);
            attachMenu(tr, [
              { label: T('在软件内定位查看', 'Locate in app'), icon: 'scan', action: () => openInApp(row.path) },
              { label: T('在系统文件管理器中打开', 'Open in system file manager'), icon: 'external', action: () => reveal(row.path) },
              !isExec && row.kind !== 'dir'
                ? { label: T('用系统默认程序打开', 'Open with default app'), icon: 'file', action: () => openFile(row.path) }
                : null,
              { sep: true },
              { label: T('复制路径', 'Copy path'), icon: 'copy', action: () => copyText(row.path) },
              { label: T('复制文件名', 'Copy file name'), icon: 'file', action: () => copyText(row.name) }
            ].filter(Boolean));
          });

          const sourceLabel = state.source === 'es'
            ? 'Everything'
            : (state.source === 'direct' ? T('本机路径直达', 'Direct path') : T('本地索引', 'Local index'));
          const pager = h('div', { class: 'action-bar' },
            h('span', {
              class: 'small muted',
              text: T('已加载', 'Loaded') + ' ' + UI.fmtCount(state.items.length) + ' · ' + state.elapsed + ' ms'
                + (state.source ? ' · ' + sourceLabel : '')
            }),
            h('div', { class: 'spacer' }),
            h('button', {
              class: 'btn sm', disabled: state.page <= 0, onclick: () => { state.page -= 1; paint(); }
            }, icon('chevron-left', 12), h('span', { text: T('上一页', 'Prev') })),
            h('span', { class: 'small', text: (state.page + 1) + ' / ' + pageCount() }),
            h('button', {
              class: 'btn sm',
              disabled: state.searching || (state.page + 1 >= pageCount() && state.items.length < state.limit),
              onclick: nextPage
            }, h('span', { text: T('下一页', 'Next') }), icon('chevron-right', 12)),
            state.items.length >= state.limit && state.limit < MAX_LIMIT
              ? h('button', { class: 'btn sm', onclick: loadMore, disabled: state.searching },
                h('span', { text: T('加载更多', 'Load more') }))
              : null,
            UI.pageSizePick((n) => App.setPageSize(n))
          );

          if (state.hint) noteNode = h('div', { class: 'note', text: state.hint });
          inner = h('div', { class: 'table-wrap' }, body);
          foot = pager;
          hintText = T('共 ', '') + UI.fmtCount(state.items.length) + T(' 条', ' results');
        }

        return h('div', { class: 'card stretch-card search-results' },
          h('div', { class: 'card-title' },
            h('h2', null, T('结果', 'Results')),
            h('span', { class: 'hint' }, hintText)
          ),
          h('div', { class: 'search-body' }, noteNode, inner),
          foot
        );
      }

      async function nextPage() {
        if (state.page + 1 < pageCount()) {
          state.page += 1;
          paint();
          return;
        }
        if (state.items.length < state.limit || state.limit >= MAX_LIMIT) return;
        const targetPage = state.page + 1;
        await loadMore();
        if (state.items.length > targetPage * PAGE_SIZE) {
          state.page = targetPage;
          paint();
        }
      }

      /* ---------- 右键：空白 ---------- */
      function bindBlankMenu() {
        attachMenu(root, (e) => {
          if (e.target && e.target.closest && e.target.closest('[data-ctx]')) return null;
          return [
            { label: T('清空结果', 'Clear results'), icon: 'close', disabled: !state.items.length, action: clearResults },
            { label: T('回到顶部', 'Back to top'), icon: 'undo', action: scrollTop },
            { sep: true },
            { label: T('刷新状态', 'Refresh status'), icon: 'refresh', action: refreshStatus }
          ];
        });
      }

      function scrollTop() {
        const host = document.getElementById('scroll');
        if (host) host.scrollTo({ top: 0, behavior: 'smooth' });
      }

      /* ---------- 数据加载 ---------- */
      async function refreshStatus(opts) {
        const quiet = !!(opts && opts.quiet);
        state.statusLoading = true;
        if (!quiet) paint();
        try {
          const st = await API.engine('search.status', {});
          state.backend = (st && st.backend) || '';
          state.indexed = Number(st && st.files) || 0;
          state.builtAt = st && st.built_at ? Number(st.built_at) * 1000 : '';
          state.indexDir = (st && st.index_dir) || '';
          state.entries = ((st && st.entries) || []).slice();
          state.roots = ((st && st.roots) || []).slice();
          state.dirs = Number(st && st.dirs) || 0;
          state.sizeBytes = Number(st && st.size_bytes) || 0;
          state.schema = Number(st && st.schema) || 0;
          state.walker = (st && st.walker) || '';
          state.elapsed = Number(st && st.elapsed_ms) || 0;
          // 清单变了就把选中的 id 收拢一次并回写持久化，避免删空后重启/重建时旧 localStorage 复活成局部范围
          const alive = new Set(state.entries.map((r) => r.id));
          const prunedScope = state.scope.filter((id) => alive.has(id));
          if (prunedScope.length !== state.scope.length) {
            state.scope = prunedScope;
            try {
              if (state.scope.length) localStorage.setItem('ta.index.scope', JSON.stringify(state.scope));
              else localStorage.removeItem('ta.index.scope');
            } catch (_) {}
          }
          state.statusLoading = false;
          if (!quiet) toast(T('状态已刷新', 'Status refreshed'), 'ok', 1600);
        } catch (e) {
          state.statusLoading = false;
          if (!quiet) toast(errText(e), 'error');
        }
        if (!quiet) paint();
      }

      async function detectMainDrives() {
        try {
          const res = await API.engine('search.drives', {});
          const drives = Array.isArray(res && res.drives) ? res.drives : [];
          const excluded = Array.isArray(res && res.excluded) ? res.excluded : [];
          state.drives = drives;
          state.excludedDrives = excluded;
          return { drives, excluded, allCovered: !!(res && res.all_covered), missing: (res && res.missing_roots) || [] };
        } catch (_) {
          // 降级：若旧引擎暂无 search.drives，尝试用 Rust agent_roots 兜底识别主要盘
          try {
            const ar = await API.agentRoots();
            const roots = (ar && Array.isArray(ar.roots) ? ar.roots : []).map((r) => ({
              root: String(r), letter: String(r).slice(0, 1).toUpperCase(),
              label: '', fs: '', total: 0, used: 0, free: 0,
              is_system: /^C:/i.test(String(r)), in_catalog: state.entries.some((e) => (e.root || '').toLowerCase() === String(r).toLowerCase()),
              built: state.entries.some((e) => (e.root || '').toLowerCase() === String(r).toLowerCase() && e.exists && !e.why && e.files > 0),
              files: 0
            }));
            state.drives = roots;
            state.excludedDrives = [];
            return { drives: roots, excluded: [], allCovered: roots.length > 0 && roots.every((d) => d.built), missing: roots.filter((d) => !d.built).map((d) => d.root) };
          } catch (e2) {
            throw e2;
          }
        }
      }

      let oneClickProbing = false;

      async function oneClickIndexAllDrives() {
        if (state.indexing || oneClickProbing) return;
        oneClickProbing = true;
        let probe = null;
        let go = false;
        let drives = [];
        let picked = new Set();
        let forceRebuild = false;
        try {
          try {
            probe = await detectMainDrives();
          } catch (e) {
            toast(errText(e), 'error');
            return;
          }
          drives = (probe && probe.drives) || [];
          const excluded = (probe && probe.excluded) || [];
          if (!drives.length) {
            toast(T('未识别到可用的本地固定磁盘', 'No local fixed drives detected'), 'warn');
            return;
          }

          picked = new Set(drives.map((d) => d.root));
          const allCovered = drives.every((d) => d.built);
          forceRebuild = allCovered;

          const body = h('div', { class: 'stack ix-oneclick-body' });
          const summaryLine = h('div', { class: 'small muted' }, allCovered
            ? T(`已识别本机全部 ${drives.length} 个主要磁盘，均已建立索引。你可以选择强制全部重建以同步最新变动。`,
              `All ${drives.length} main local drives are already indexed. You can force a full rebuild if needed.`)
            : T(`已自动识别本机 ${drives.length} 个主要固定磁盘（默认全选覆盖）；已健康建库的盘将自动复用，仅补建缺失盘。`,
              `Detected ${drives.length} main local drives (all selected by default); healthy indexes are reused automatically.`));
          body.appendChild(summaryLine);

          const driveListEl = h('div', { class: 'ix-drive-list' });
          drives.forEach((d) => {
            const cb = h('input', {
              type: 'checkbox',
              checked: true,
              onchange: (e) => {
                if (e.target.checked) picked.add(d.root);
                else picked.delete(d.root);
                syncOkBtn();
              }
            });
            const statusEl = d.built
              ? h('span', { class: 'badge ok' }, T('已建立', 'Built') + (d.files ? ' · ' + UI.fmtCount(d.files) : ''))
              : (d.in_catalog
                ? h('span', { class: 'badge warn' }, T('待建立', 'Pending'))
                : h('span', { class: 'badge accent' }, T('待添加', 'New')));
            const metaParts = [
              d.label || (d.is_system ? T('系统盘', 'System') : T('本地磁盘', 'Local Disk')),
              d.fs || '',
              d.total > 0 ? UI.fmtBytes(d.used || 0) + ' / ' + UI.fmtBytes(d.total) : ''
            ].filter(Boolean).join(' · ');

            const row = h('label', { class: 'ix-drive-row' },
              cb,
              icon('drive', 15),
              h('span', { class: 'ix-drive-root mono' }, d.root),
              d.is_system ? h('span', { class: 'badge' }, T('系统', 'Sys')) : null,
              h('span', { class: 'ix-drive-meta small muted ellipsis', title: metaParts }, metaParts),
              h('span', { class: 'spacer' }),
              statusEl
            );
            driveListEl.appendChild(row);
          });
          body.appendChild(driveListEl);

          const rebuildCheck = h('label', { class: 'check small' },
            h('input', {
              type: 'checkbox',
              checked: forceRebuild,
              onchange: (e) => { forceRebuild = !!e.target.checked; }
            }),
            h('span', null, T('强制重新扫描并覆盖已建立的索引（关闭则仅补建缺失/未建立的盘）',
              'Force rescan existing healthy indexes (unchecked = build missing only)'))
          );
          body.appendChild(rebuildCheck);

          if (state.scope.length) {
            body.appendChild(h('div', { class: 'note small muted' },
              T('当前勾选了局部搜索范围，完成一键全盘覆盖后将自动重置为「搜索全部索引」，确保新建立的主盘立即可搜。',
                'A partial search scope is currently active; it will be reset to All Indexes after one-click indexing so new drives are searchable immediately.')));
          }

          if (excluded.length) {
            const exText = excluded.map((x) => `${x.root}（${x.reason || T('非固定盘', 'Non-fixed')}）`).join('、');
            body.appendChild(h('div', { class: 'note small muted' },
              T('已自动排除非主要盘：', 'Automatically excluded: ') + exText));
          }

          let confirmModal = null;
          let okBtnEl = null;
          function syncOkBtn() {
            if (!okBtnEl) return;
            okBtnEl.disabled = picked.size === 0;
            okBtnEl.textContent = picked.size
              ? T(`开始建立索引（${picked.size} 个盘）`, `Index ${picked.size} drive(s)`)
              : T('请至少勾选一个磁盘', 'Select at least one drive');
          }

          go = await new Promise((resolve) => {
            let settled = false;
            confirmModal = UI.modal({
              title: T('一键建立索引 · 本机主要磁盘识别', 'One-click index · Main drives'),
              wide: true,
              body,
              buttons: [
                { id: 'cancel', label: T('取消', 'Cancel'), kind: 'ghost' },
                { id: 'ok', label: T(`开始建立索引（${picked.size} 个盘）`, `Index ${picked.size} drive(s)`), kind: 'primary' }
              ],
              onAction: (id) => {
                if (id === 'ok' && picked.size === 0) {
                  toast(T('请至少选择一个磁盘', 'Select at least one drive'), 'warn');
                  return false;
                }
                return true;
              },
              onClose: (v) => { if (!settled) { settled = true; resolve(v === 'ok'); } }
            });
            if (confirmModal && confirmModal.el) {
              const btns = confirmModal.el.querySelectorAll('.modal-foot .btn');
              okBtnEl = btns[btns.length - 1] || null;
              syncOkBtn();
            }
          });
        } finally {
          oneClickProbing = false;
        }
        if (!go || !picked.size) return;

        const targetRoots = drives.filter((d) => picked.has(d.root)).map((d) => d.root);
        state.indexing = true;
        if (active && active.root === root) {
          paint();
          manager && manager.render();
        }
        try {
          await UI.busy(async (ctrl) => {
            if (ctrl && typeof ctrl.setSub === 'function') {
              ctrl.setSub(T('正在全盘覆盖索引：', 'Indexing drives: ') + targetRoots.join(' · '));
            }
            const r = await API.engine('search.index', {
              roots: targetRoots,
              full: !!forceRebuild,
              reuse: !forceRebuild
            });
            const n = (r && r.indexed) || 0;
            const failed = (r && r.failed) || [];
            const hadNarrowScope = state.scope.length > 0;
            if (hadNarrowScope && !(r && r.error)) {
              state.scope = [];
              try { localStorage.removeItem('ta.index.scope'); } catch (_) {}
            }
            if (r && r.error) toast(r.error, 'error');
            else if (r && r.reused) toast(T(`主要盘（${targetRoots.join('、')}）索引均已是最新，无需重建`, `All selected drives (${targetRoots.join(', ')}) are already up to date`), 'info');
            else toast(
              T(`一键索引完成（${targetRoots.join('、')}），共 `, `Indexed (${targetRoots.join(', ')}): `)
              + UI.fmtCount(n) + T(' 个文件', ' files')
              + (failed.length ? ' · ' + failed.length + T(' 个失败', ' failed') : '')
              + (hadNarrowScope ? T(' · 已切换为搜索全部', ' · Scope reset to all') : '')
              + ' · ' + fmtSpan(r && r.elapsed_ms),
              failed.length ? 'warn' : 'ok',
              4500
            );
          }, T('正在一键建立全盘索引…', 'Building full-drive index…'), 'search');
        } catch (e) {
          toast(errText(e), 'error');
        } finally {
          state.indexing = false;
        }
        if (active && active.root === root) {
          await refreshStatus({ quiet: true });
          manager && manager.render();
          paint();
        }
      }

      async function buildIndex(rebuild, ids) {
        if (state.indexing) return;
        const target = (ids && ids.length) ? ids : null;
        if (!state.entries.length) {
          toast(T('请先添加搜索目录或使用「一键建立索引」', 'Add a folder or use One-click index first'), 'warn');
          return;
        }
        if (rebuild) {
          const ok = await UI.confirm({
            title: T('重建索引', 'Rebuild index'),
            body: T('会重新扫描并覆盖这些索引，文件多时需要一会儿。继续？',
              'These indexes are rescanned and replaced. This can take a while. Continue?'),
            ok: T('重建', 'Rebuild'),
            danger: true
          });
          if (!ok) return;
        }
        const payload = { full: !!rebuild, reuse: !rebuild };
        if (target) payload.ids = target;
        state.indexing = true;
        try {
          await UI.busy(async () => {
            const r = await API.engine('search.index', payload);
            const n = (r && r.indexed) || 0;
            const failed = (r && r.failed) || [];
            if (r && r.error) toast(r.error, 'error');
            else if (r && r.reused) toast(T('索引已是最新，无需重建', 'Indexes are up to date'), 'info');
            else toast(T('索引完成，共', 'Indexed') + ' ' + UI.fmtCount(n) + ' ' + T('个文件', 'files')
              + (failed.length ? ' · ' + failed.length + ' ' + T('个目录失败', 'failed') : '')
              + ' · ' + fmtSpan(r && r.elapsed_ms), 'ok');
          }, T('正在建立索引…', 'Building index…'), 'search');
        } catch (e) {
          toast(errText(e), 'error');
        } finally {
          state.indexing = false;
        }
        if (active && active.root === root) {
          await refreshStatus({ quiet: true });
          manager && manager.render();
          paint();
        }
      }

      async function openInApp(path) {
        if (!path) return;
        if (window.AIEntries && typeof window.AIEntries.open === 'function') {
          await window.AIEntries.open(path);
        } else {
          await reveal(path);
        }
      }

      async function reveal(path) {
        if (!path) return;
        try { await API.reveal(path); } catch (e) { toast(errText(e), 'error'); }
      }

      async function openFile(path) {
        if (!path) return;
        if (window.AIEntries && typeof window.AIEntries.openSystemApp === 'function') {
          await window.AIEntries.openSystemApp(path);
          return;
        }
        try { await API.openPath(path); } catch (e) { toast(errText(e), 'error'); }
      }

      active = { root, paint, state };

      try {
        const saved = JSON.parse(localStorage.getItem('ta.index.scope') || '[]');
        if (Array.isArray(saved)) state.scope = saved.filter((x) => typeof x === 'string');
      } catch (e) { state.scope = []; }

      liveJump = async function (payload) {
        const p = payload || {};
        let q = String(p.q || p.query || p.keyword || '').trim();
        if (!q && Array.isArray(p.paths) && p.paths.length) {
          q = String(p.paths[0] || '').trim();
        }
        if (q) {
          state.query = q;
          paint();
          await runSearch();
        }
      };

      setActions();

      bindBlankMenu();
      paint();
      await refreshStatus();

      return function unmount() {
        if (manager && manager.modal && typeof manager.modal.close === 'function') {
          manager.modal.close();
        }
        manager = null;
        liveJump = null;
        active = null;
        setActions();
      };
    },

    jump(payload) { return liveJump ? liveJump(payload || {}) : undefined; }
  };
})();
