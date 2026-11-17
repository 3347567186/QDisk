/* 搜索页：索引状态、目录管理、查询与分页结果 */
(function () {
  'use strict';

  const { h, T, icon, toast, empty, table, attachMenu, menu, skeleton } = UI;

  let PAGE_SIZE = 15;
  const STEP = 500;
  const MAX_LIMIT = 5000;

  const errText = UI.errText;

  let active = null;

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
        elapsed: 0,
        source: '',
        hint: '',
        searched: false,
        searching: false,
        statusLoading: true
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
          h('div', { class: 'k', text: k }),
          h('div', { class: 'v' + (cls ? ' ' + cls : ''), text: v }));
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
              class: 'btn sm', disabled: !state.entries.length, onclick: () => buildIndex(false)
            }, icon('scan', 14), h('span', { text: T('建立索引', 'Index') })),
            h('button', {
              class: 'btn sm', disabled: !state.entries.length, onclick: () => buildIndex(true)
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
            { label: T('打开目录', 'Open folder'), icon: 'external', action: () => reveal(row.root) },
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
            : h('div', { class: 'small muted', text: T('还没有索引，先添加一个目录', 'No indexes yet — add a folder first') }),
          { open: true }));

        parts.push(h('div', { class: 'toolbar' },
          h('button', {
            class: 'btn sm', onclick: () => addRoot(host)
          }, icon('plus', 14), h('span', { text: T('添加目录', 'Add folder') })),
          h('button', {
            class: 'btn sm', disabled: !state.scope.length, onclick: () => buildIndex(false, scopeIds())
          }, icon('scan', 14), h('span', { text: T('建立选中', 'Index checked') + (state.scope.length ? ' · ' + state.scope.length : '') })),
          h('button', {
            class: 'btn sm', disabled: !rows.length, onclick: () => buildIndex(true)
          }, icon('undo', 14), h('span', { text: T('全部重建', 'Rebuild all') })),
          h('div', { class: 'spacer' }),
          h('button', {
            class: 'btn sm', disabled: !state.indexDir, onclick: () => reveal(state.indexDir)
          }, icon('external', 14), h('span', { text: T('打开索引目录', 'Show index folder') }))
        ));

        return parts;
      }

      async function openIndexManager() {
        const host = h('div', { class: 'stack' });
        const render = () => host.replaceChildren(...managerBody(host));
        render();
        UI.modal({
          title: T('索引详情', 'Index details'),
          wide: true,
          body: host,
          buttons: [{ id: 'close', label: T('关闭', 'Close'), kind: 'ghost' }]
        });
        manager = { host, render };
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
        try {
          const dir = await API.pickFolder();
          if (!dir) return;
          if (state.entries.some((r) => (r.root || '').toLowerCase() === dir.toLowerCase())) {
            toast(T('该目录已在列表中', 'That folder is already listed'), 'warn');
            return;
          }
          await API.engine('search.add', { roots: [dir] });
          await refreshStatus({ quiet: true });
          manager && manager.render();
          paint();
          toast(T('已添加目录，点「建立索引」生效', 'Folder added — run Index to apply'), 'ok');
        } catch (e) {
          toast(errText(e), 'error');
        }
      }

      async function deleteIndex(row, host) {
        const ok = await UI.confirm({
          title: T('删除索引', 'Delete index'),
          body: T('只删除这个索引文件，源目录里的文件不受影响。', 'Only the index file is removed; your files stay untouched.')
            + '\n' + (row.root || ''),
          ok: T('删除', 'Delete'),
          danger: true
        });
        if (!ok) return;
        try {
          await API.engine('search.remove', { ids: [row.id] });
          state.scope = state.scope.filter((id) => id !== row.id);
          await refreshStatus({ quiet: true });
          manager && manager.render();
          paint();
          toast(T('索引已删除', 'Index deleted'), 'ok');
        } catch (e) {
          toast(errText(e), 'error');
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
          }, icon('close', 14), h('span', { text: T('清空', 'Clear') }))
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
          inner = UI.empty(T('还没有搜索', 'No search yet'), T('添加目录并建立索引后搜索更快', 'Add folders and build the index for faster results'));
        } else if (!state.items.length) {
          inner = UI.empty(T('没有匹配的文件', 'No matching files'), state.hint || '');
          hintText = T('没有匹配', 'No matches');
        } else {
          const start = state.page * PAGE_SIZE;
          const slice = state.items.slice(start, start + PAGE_SIZE);

          const cols = [
            {
              key: 'name', label: T('名称', 'Name'),
              render: (r) => h('div', { class: 'name' }, icon('file', 14), h('span', { class: 'txt', text: r.name || '—' }))
            },
            {
              key: 'path', label: T('路径', 'Path'),
              render: (r) => h('span', { class: 'mono ellipsis', title: r.path || '', text: r.path || '—' })
            },
            { key: 'size', label: T('大小', 'Size'), width: '90px', align: 'right', render: (r) => UI.fmtBytes(r.size || 0) },
            { key: 'mtime', label: T('修改时间', 'Modified'), width: '140px', align: 'right', render: (r) => r.mtime ? UI.fmtTime(r.mtime) : '—' }
          ];

          const body = table({ columns: cols, rows: slice, rowKey: (r) => r.path });

          body.querySelectorAll('tbody tr').forEach((tr, i) => {
            const row = slice[i];
            if (!row) return;
            tr.dataset.ctx = 'result';
            tr.addEventListener('click', () => reveal(row.path));
            tr.addEventListener('dblclick', () => openFile(row.path));
            attachMenu(tr, [
              { label: T('打开文件', 'Open file'), icon: 'external', action: () => openFile(row.path) },
              { label: T('打开所在目录', 'Show in folder'), icon: 'folder', action: () => reveal(row.path) },
              { sep: true },
              { label: T('复制路径', 'Copy path'), icon: 'copy', action: () => copyText(row.path) },
              { label: T('复制文件名', 'Copy file name'), icon: 'file', action: () => copyText(row.name) }
            ]);
          });

          const pager = h('div', { class: 'action-bar' },
            h('span', {
              class: 'small muted',
              text: T('已加载', 'Loaded') + ' ' + UI.fmtCount(state.items.length) + ' · ' + state.elapsed + ' ms'
                + (state.source ? ' · ' + (state.source === 'es' ? 'Everything' : T('本地索引', 'Local index')) : '')
            }),
            h('div', { class: 'spacer' }),
            h('button', {
              class: 'btn sm', disabled: state.page <= 0, onclick: () => { state.page -= 1; paint(); }
            }, icon('undo', 12), h('span', { text: T('上一页', 'Prev') })),
            h('span', { class: 'small', text: (state.page + 1) + ' / ' + pageCount() }),
            h('button', {
              class: 'btn sm',
              disabled: state.searching || (state.page + 1 >= pageCount() && state.items.length < state.limit),
              onclick: nextPage
            }, h('span', { text: T('下一页', 'Next') }), icon('play', 12)),
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
          // 清单变了就把选中的 id 收拢一次，避免留着一堆已经不存在的 id
          const alive = new Set(state.entries.map((r) => r.id));
          state.scope = state.scope.filter((id) => alive.has(id));
          state.statusLoading = false;
          if (!quiet) toast(T('状态已刷新', 'Status refreshed'), 'ok', 1600);
        } catch (e) {
          state.statusLoading = false;
          if (!quiet) toast(errText(e), 'error');
        }
        if (!quiet) paint();
      }

      async function buildIndex(rebuild, ids) {
        const target = (ids && ids.length) ? ids : null;
        if (!state.entries.length) {
          toast(T('请先添加搜索目录', 'Add a folder first'), 'warn');
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
          }, T('正在建立索引…', 'Building index…'));
        } catch (e) {
          toast(errText(e), 'error');
        }
        await refreshStatus({ quiet: true });
        manager && manager.render();
        paint();
      }

      async function reveal(path) {
        if (!path) return;
        try { await API.reveal(path); } catch (e) { toast(errText(e), 'error'); }
      }

      async function openFile(path) {
        if (!path) return;
        try { await API.openPath(path); } catch (e) { toast(errText(e), 'error'); }
      }

      active = { root, paint, state };

      try {
        const saved = JSON.parse(localStorage.getItem('ta.index.scope') || '[]');
        if (Array.isArray(saved)) state.scope = saved.filter((x) => typeof x === 'string');
      } catch (e) { state.scope = []; }

      bindBlankMenu();
      paint();
      await refreshStatus();
    }
  };
})();
