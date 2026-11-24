/* ============================================================
   清理缓存页（第二轮 · 紧凑版）
   - 顶层 3 块：统计/操作卡、选项（折叠）、分组列表卡
   - 分组用 UI.section 手风琴，默认全部折叠；展开时按需填充，每组内分页 200 条
   - 页面不设内部滚动：表格随 #scroll 一起滚，不用 max-height/overflow
   - 清理 = cache.clean {paths, confirm:true, prune_empty}
   ============================================================ */
(function () {
  'use strict';
  const {
    h, T, icon, fmtBytes, fmtCount,
    toast, confirm, busy, skeleton, empty, section, modal, attachMenu, softIn, setActions
  } = UI;

  let PAGE_SIZE = 15;      // 每个分组每页条数（跟随设置里的全局每页条数）
  const errText = UI.errText;

  /* 引擎 level -> 徽章样式与文案 */
  const LEVELS = {
    safe: { cls: 'ok', zh: '安全', en: 'Safe' },
    caution: { cls: 'warn', zh: '谨慎', en: 'Caution' },
    advanced: { cls: 'danger', zh: '高级', en: 'Advanced' }
  };
  const levelMeta = (lv) => LEVELS[lv] || LEVELS.caution;

  function levelBadge(lv) {
    const m = levelMeta(lv);
    return h('span', { class: 'badge ' + m.cls }, T(m.zh, m.en));
  }

  function scrollTop(smooth) {
    const sc = document.getElementById('scroll');
    if (sc) sc.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'auto' });
  }

  /* 全局跨挂载持久化内存缓存：切页 0ms 瞬间还原，杜绝重复全盘扫描与闪骨架屏 */
  const GlobalCachePageCache = {
    groups: null,
    lastScanTime: 0,
    includeCustom: true,
    pruneEmpty: false
  };

  let liveJump = null;

  window.Pages = window.Pages || {};

  window.Pages.cache = {
    title: ['清理缓存', 'Caches'],
    subtitle: ['按危险等级列出缓存目录，确认后清空内容', 'List cache folders by risk level, then clear their contents'],

    async mount(root) {
      PAGE_SIZE = UI.pageSize();
      const hasCache = !!(GlobalCachePageCache.groups && GlobalCachePageCache.groups.length);
      /* ---------- 状态 ---------- */
      const S = {
        groups: GlobalCachePageCache.groups ? GlobalCachePageCache.groups.slice() : [],
        includeCustom: GlobalCachePageCache.includeCustom !== undefined ? GlobalCachePageCache.includeCustom : true,
        pruneEmpty: !!GlobalCachePageCache.pruneEmpty,
        selected: new Set(),     // path 集合
        loading: false,
        loaded: hasCache,
        failed: false
      };
      const refs = new Map();    // 分组名 -> { sec, body, group, page, filled, cb }

      /* ---------- 顶部统计 + 操作 ---------- */
      const statGroups = h('div', { class: 'v' }, '0');
      const statItems = h('div', { class: 'v' }, '0');
      const statSize = h('div', { class: 'v' }, '0 B');
      const statSel = h('div', { class: 'v' }, '0');
      const statSelK = h('div', { class: 'k' }, T('已选', 'Selected'));

      const reloadBtn = h('button', { class: 'btn sm', onclick: () => { doLoad(true); } },
        icon('refresh', 13), T('重新读取', 'Reload'));
      const recBtn = h('button', {
        class: 'btn sm primary', disabled: true, onclick: () => { doCleanRecommended(); }
      }, icon('shield', 13), T('清理推荐', 'Clean recommended'));
      const cleanBtn = h('button', {
        class: 'btn sm danger', disabled: true, onclick: () => { doCleanSelected(); }
      }, icon('trash', 13), T('清理选中', 'Clean selected'));
      const collapseLabel = h('span', null, T('全部展开', 'Expand all'));
      const collapseBtn = h('button', {
        class: 'btn sm ghost', disabled: true, onclick: () => toggleAll()
      }, icon('chevrons-down', 13), collapseLabel);

      const askBtn = UI.askBtn({
        title: T('问助手 · 清理缓存', 'Ask AI · Caches'),
        question: T('帮我看看当前扫描到的缓存分组，哪些可以安全清理？', 'Review the scanned cache groups and tell me which ones are safe to clean.'),
        ctx: () => ({ page: '清理缓存', groups: S.groups.length, selected: S.selected.size })
      });

      const topCard = h('div', { class: 'card' },
        h('div', { class: 'card-title' },
          h('h2', null, T('缓存概览', 'Cache overview')),
          h('span', { class: 'spacer' }),
          reloadBtn, recBtn, cleanBtn, collapseBtn, askBtn
        ),
        h('div', { class: 'stats inline' },
          h('div', { class: 'stat' }, statGroups, h('div', { class: 'k' }, T('分组', 'Groups'))),
          h('div', { class: 'stat' }, statItems, h('div', { class: 'k' }, T('可清理项', 'Items'))),
          h('div', { class: 'stat' }, statSize, h('div', { class: 'k' }, T('可释放', 'Reclaimable'))),
          h('div', { class: 'stat' }, statSel, statSelK)
        )
      );

      /* ---------- 选项（折叠） ---------- */
      const chkCustom = h('input', {
        type: 'checkbox', checked: S.includeCustom,
        onchange: (e) => {
          // 正在读取时 doLoad 会被 S.loading 挡掉，勾选就白翻了：直接回弹
          if (S.loading) { e.target.checked = !e.target.checked; S.includeCustom = !!e.target.checked; return; }
          S.includeCustom = !!e.target.checked;
          doLoad(true);
        }
      });
      const chkPrune = h('input', {
        type: 'checkbox', checked: S.pruneEmpty,
        onchange: (e) => { S.pruneEmpty = !!e.target.checked; }
      });
      const safeBtn = h('button', {
        class: 'btn sm ghost', disabled: true, onclick: () => selectSafe()
      }, icon('shield', 13), T('只选安全级', 'Safe only'));

      const optBody = h('div', { class: 'stack' },
        h('div', { class: 'toolbar' },
          h('label', { class: 'check' }, chkCustom, h('span', null, T('包含自定义目录', 'Include custom folders'))),
          h('label', { class: 'check' }, chkPrune, h('span', null, T('清理后删除空目录', 'Remove empty folders after cleaning'))),
          h('span', { class: 'spacer' }),
          safeBtn
        )
      );
      const optSection = section(T('选项', 'Options'), optBody, {
        open: false,
        id: 'cache-opts',
        icon: 'shield'
      });

      /* ---------- 分组列表 ---------- */
      const groupsBox = h('div', { class: 'stack' });
      const groupsBody = h('div', { class: 'cache-body' }, groupsBox);
      const listCard = h('div', { class: 'card stretch-card cache-list-card' },
        h('div', { class: 'card-title' },
          h('h2', null, T('缓存分组', 'Cache groups'))
        ),
        groupsBody
      );

      root.appendChild(h('div', { class: 'stack page-fill' }, topCard, optSection, listCard));
      root.classList.add('page-fill');

      /* ---------- 右键菜单：分组头 > 条目 > 空白 ---------- */
      attachMenu(groupsBox, (e) => {
        const head = e.target.closest('.section-head');
        if (head) {
          const sec = head.closest('.section');
          return groupMenu(sec ? sec.dataset.group : '');
        }
        const row = e.target.closest('[data-path]');
        if (row) return itemMenu(row.dataset.path);
        return blankMenu();
      });

      function blankMenu() {
        return [
          { label: T('刷新', 'Refresh'), icon: 'refresh', action: () => { doLoad(true); } },
          { label: T('全选', 'Select all'), icon: 'check', action: () => selectAll(true) },
          { label: T('全不选', 'Clear selection'), icon: 'close', action: () => selectAll(false) },
          { sep: true },
          { label: T('回到顶部', 'Back to top'), icon: 'undo', action: () => scrollTop(true) }
        ];
      }

      function groupMenu(name) {
        const g = S.groups.find((x) => x.name === name);
        const list = (g && Array.isArray(g.items) ? g.items : []).filter((it) => it.exists !== false);
        const size = list.reduce((n, it) => n + (Number(it.size) || 0), 0);
        return [
          { header: name || T('分组', 'Group') },
          { label: T('选中本组', 'Select group'), icon: 'check', disabled: !list.length, action: () => selectGroup(name, true) },
          { label: T('取消本组', 'Deselect group'), icon: 'close', disabled: !list.length, action: () => selectGroup(name, false) },
          { sep: true },
          {
            label: T('清理本组', 'Clean group') + (list.length ? ' · ' + fmtBytes(size) : ''),
            icon: 'trash', danger: true, disabled: !list.length,
            action: () => { doCleanGroup(name); }
          }
        ];
      }

      function itemMenu(path) {
        const it = findItem(path);
        const gone = !it || it.exists === false;
        return [
          { header: path },
          { label: T('在软件内定位', 'Locate in app'), icon: 'scan', disabled: gone, action: () => openInApp(path) },
          { label: T('在系统文件管理器中打开', 'Open in system file manager'), icon: 'external', disabled: gone, action: () => revealPath(path) },
          { label: T('复制路径', 'Copy path'), icon: 'copy', action: () => copyText(path) },
          { sep: true },
          { label: T('删除此目录', 'Clean this folder'), icon: 'trash', danger: true, disabled: gone, action: () => { doCleanItem(path); } }
        ];
      }

      /* ---------- 数据小工具 ---------- */
      function allItems() {
        const out = [];
        S.groups.forEach((g) => (g.items || []).forEach((it) => out.push(it)));
        return out;
      }
      const existingItems = () => allItems().filter((it) => it.exists !== false);

      function findItem(path) {
        for (const g of S.groups) {
          const hit = (g.items || []).find((it) => it.path === path);
          if (hit) return hit;
        }
        return null;
      }

      function selectedSize() {
        let n = 0;
        allItems().forEach((it) => { if (S.selected.has(it.path)) n += Number(it.size) || 0; });
        return n;
      }

      /* ---------- 选择 ---------- */
      function selectAll(on) {
        S.selected.clear();
        if (on) existingItems().forEach((it) => S.selected.add(it.path));
        syncSelection();
      }

      function selectSafe() {
        S.selected.clear();
        existingItems().forEach((it) => { if (it.level === 'safe') S.selected.add(it.path); });
        syncSelection();
      }

      function selectGroup(name, on) {
        const g = S.groups.find((x) => x.name === name);
        const list = g && Array.isArray(g.items) ? g.items : [];
        list.forEach((it) => {
          if (it.exists === false) return;
          if (on) S.selected.add(it.path);
          else S.selected.delete(it.path);
        });
        syncSelection();
      }

      /* ---------- 统计 + 勾选同步 ---------- */
      function recomputeSize() {
        return existingItems().reduce((n, it) => n + (Number(it.size) || 0), 0);
      }

      function syncSelection() {
        // 分组头的三态勾选
        refs.forEach((ref) => {
          const list = (ref.group.items || []).filter((it) => it.exists !== false);
          const sel = list.filter((it) => S.selected.has(it.path)).length;
          ref.cb.checked = list.length > 0 && sel === list.length;
          ref.cb.indeterminate = sel > 0 && sel < list.length;
          ref.cb.disabled = list.length === 0;
        });

        // 已渲染的表格行
        groupsBox.querySelectorAll('[data-path]').forEach((row) => {
          const on = S.selected.has(row.dataset.path);
          row.classList.toggle('selected', on);
          const cb = row.querySelector('input.pick');
          if (cb) cb.checked = on;
        });

        const n = S.selected.size;
        statGroups.textContent = fmtCount(S.groups.length);
        statItems.textContent = fmtCount(existingItems().length);
        statSize.textContent = fmtBytes(recomputeSize());
        statSel.textContent = fmtCount(n);
        statSelK.textContent = n
          ? T('已选 · ' + fmtBytes(selectedSize()), 'Selected · ' + fmtBytes(selectedSize()))
          : T('已选', 'Selected');

        cleanBtn.disabled = n === 0;
        safeBtn.disabled = !existingItems().some((it) => it.level === 'safe');
        recBtn.disabled = !existingItems().some((it) => it.level === 'safe');
        collapseBtn.disabled = !S.groups.length;
      }

      /* ---------- 条目行 ---------- */
      function rowNode(item) {
        const exists = item.exists !== false;
        const cb = h('input', {
          type: 'checkbox', class: 'pick',
          checked: S.selected.has(item.path),
          disabled: !exists,
          'aria-label': T('选择 ', 'Select ') + (item.label || item.path),
          onclick: (e) => e.stopPropagation(),
          onchange: (e) => {
            if (e.target.checked) S.selected.add(item.path);
            else S.selected.delete(item.path);
            syncSelection();
          }
        });

        return h('tr', {
          dataset: { path: item.path },
          class: S.selected.has(item.path) ? 'selected' : '',
          title: item.path,
          onclick: (e) => {
            if (e.target.closest('button') || e.target.tagName === 'INPUT') return;
            if (!exists) return;
            if (S.selected.has(item.path)) S.selected.delete(item.path);
            else S.selected.add(item.path);
            syncSelection();
          }
        },
          h('td', { style: { width: '30px' } }, cb),
          h('td', null,
            h('div', { class: 'name' },
              icon('folder', 13),
              h('span', { class: 'txt' }, item.label || item.path)
            ),
            item.note ? h('div', { class: 'small muted ellipsis' }, item.note) : null,
            !exists ? h('span', { class: 'badge warn', style: { marginTop: '2px' } }, T('不存在', 'Missing')) : null
          ),
          h('td', { class: 'num' }, exists ? fmtBytes(item.size) : '—'),
          h('td', null, levelBadge(item.level)),
          h('td', { class: 'num', style: { width: '92px' } },
            h('div', { class: 'row', style: { justifyContent: 'flex-end', gap: '4px' } },
              h('button', {
                type: 'button',
                class: 'btn icon sm ghost',
                title: T('在软件内定位', 'Locate in app'),
                'aria-label': T('在软件内定位', 'Locate in app'),
                disabled: !exists,
                onclick: (e) => { e.stopPropagation(); openInApp(item.path); }
              }, icon('scan', 13)),
              h('button', {
                type: 'button',
                class: 'btn icon sm ghost',
                title: T('在系统文件管理器中打开', 'Open in system file manager'),
                'aria-label': T('在系统文件管理器中打开', 'Open in system file manager'),
                disabled: !exists,
                onclick: (e) => { e.stopPropagation(); revealPath(item.path); }
              }, icon('external', 13))
            )
          )
        );
      }

      /* ---------- 分组内容（懒渲染 + 分页） ---------- */
      function renderGroupBody(name) {
        const ref = refs.get(name);
        if (!ref) return;
        const items = ref.group.items || [];
        const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
        ref.page = Math.min(Math.max(1, ref.page), pages);
        const start = (ref.page - 1) * PAGE_SIZE;
        const slice = items.slice(start, start + PAGE_SIZE);

        ref.body.innerHTML = '';

        if (!items.length) {
          ref.body.appendChild(h('div', { class: 'small muted', style: { padding: '6px 2px' } },
            T('本组没有条目', 'This group has no items')));
          syncSelection();
          return;
        }

        const tbody = h('tbody');
        slice.forEach((it) => tbody.appendChild(rowNode(it)));

        const tbl = h('table', { class: 'table dense' },
          h('colgroup', null,
            h('col', { style: { width: '32px' } }),
            h('col', null),
            h('col', { style: { width: '90px' } }),
            h('col', { style: { width: '72px' } }),
            h('col', { style: { width: '82px' } })
          ),
          h('thead', null, h('tr', null,
            h('th', null, ''),
            h('th', null, T('名称', 'Name')),
            h('th', { class: 'num' }, T('大小', 'Size')),
            h('th', null, T('等级', 'Level')),
            h('th', { class: 'num' }, '')
          )),
          tbody
        );
        tbl.style.tableLayout = 'fixed';
        ref.body.appendChild(tbl);

        // 分页条：翻页只重画本组，不碰其它组
        const prev = h('button', {
          class: 'btn sm ghost', disabled: ref.page <= 1,
          onclick: () => { ref.page -= 1; renderGroupBody(name); }
        }, '‹', T('上一页', 'Prev'));
        const next = h('button', {
          class: 'btn sm ghost', disabled: ref.page >= pages,
          onclick: () => { ref.page += 1; renderGroupBody(name); }
        }, T('下一页', 'Next'), '›');
        ref.body.appendChild(h('div', { class: 'row', style: { marginTop: '6px' } },
          prev,
          h('span', { class: 'small muted mono' },
            T('第 ' + ref.page + ' / ' + pages + ' 页 · 共 ' + fmtCount(items.length) + ' 项',
              'Page ' + ref.page + ' / ' + pages + ' · ' + fmtCount(items.length) + ' items')),
          next,
          h('span', { class: 'spacer' }),
          h('span', { class: 'small muted' }, T('每页', 'Per page')),
          UI.pageSizePick((n) => App.setPageSize(n))
        ));

        syncSelection();
      }

      function fillGroup(name) {
        const ref = refs.get(name);
        if (!ref || ref.filled) return;
        ref.filled = true;
        renderGroupBody(name);
      }

      /* ---------- 分组节点 ---------- */
      function buildGroup(group, idx) {
        const body = h('div', { class: 'stack' });
        const sec = section(group.name, body, {
          open: false,
          id: 'cache-grp-' + idx,
          icon: 'layers',
          onToggle: (next) => {
            if (next) fillGroup(group.name);
            syncCollapseBtn();
          }
        });
        sec.dataset.group = group.name;

        const list = (group.items || []).filter((it) => it.exists !== false);
        const size = list.reduce((n, it) => n + (Number(it.size) || 0), 0);
        const cb = h('input', {
          type: 'checkbox',
          'aria-label': T('选中本组', 'Select group'),
          onchange: (e) => selectGroup(group.name, !!e.target.checked),
          onclick: (e) => e.stopPropagation()
        });
        const cbWrap = h('label', {
          class: 'check',
          title: T('选中本组', 'Select group'),
          onclick: (e) => e.stopPropagation()
        }, cb);

        // UI.section 头部只有标题与 hint，这里补上 数量 / 大小 / 等级 / 全选
        const head = sec.querySelector('.section-head');
        if (head) {
          head.appendChild(h('span', { class: 'small muted mono' },
            T(fmtCount(list.length) + ' 项', fmtCount(list.length) + ' items')));
          head.appendChild(h('span', { class: 'small muted mono' }, fmtBytes(size)));
          head.appendChild(levelBadge(group.level));
          head.appendChild(cbWrap);
        }

        refs.set(group.name, { sec, body, group, cb, page: 1, filled: false });
        return sec;
      }

      function anyOpen() {
        let open = false;
        refs.forEach((ref) => { if (ref.sec.classList.contains('open')) open = true; });
        return open;
      }
      function expandAll() {
        refs.forEach((ref) => { if (!ref.sec.classList.contains('open')) ref.sec._toggle(true); });
      }
      function collapseAll() {
        refs.forEach((ref) => {
          if (ref.sec.classList.contains('open')) ref.sec._toggle(false);
        });
      }
      function toggleAll() {
        if (anyOpen()) collapseAll(); else expandAll();
        syncCollapseBtn();
      }
      function syncCollapseBtn() {
        if (!refs.size) { collapseBtn.disabled = true; return; }
        collapseBtn.disabled = false;
        const open = anyOpen();
        collapseLabel.textContent = open ? T('全部收起', 'Collapse all') : T('全部展开', 'Expand all');
        collapseBtn.classList.toggle('up', open);
      }

      /* ---------- 整体渲染 ---------- */
      function render() {
        groupsBox.innerHTML = '';
        refs.clear();

        if (S.loading) {
          groupsBox.appendChild(skeleton(8, 'cache'));
          statGroups.textContent = '—';
          statItems.textContent = '—';
          statSize.textContent = '—';
          statSel.textContent = '0';
          cleanBtn.disabled = recBtn.disabled = safeBtn.disabled = collapseBtn.disabled = true;
          return;
        }

        if (!S.loaded) {
          groupsBox.appendChild(empty(T('尚未读取', 'Not loaded yet'), T('正在准备缓存清单', 'Preparing the cache list')));
          return;
        }

        if (S.failed) {
          groupsBox.appendChild(empty(T('读取缓存失败', 'Failed to read caches'),
            T('点「重新读取」再试一次', 'Press Reload to try again')));
          return;
        }

        if (!S.groups.length) {
          groupsBox.appendChild(empty(T('没有可清理的缓存', 'No caches to clean'),
            T('当前系统上没有发现已知的缓存目录', 'No known cache folders were found on this system')));
          syncSelection();
          return;
        }

        S.groups.forEach((g, i) => groupsBox.appendChild(buildGroup(g, i)));
        softIn(groupsBox);
        // 默认全部折叠，展开时再按需填充，避免一次渲染几百行
        syncCollapseBtn();
        syncSelection();
      }

      /* ---------- 读取 ---------- */
      async function doLoad(withOverlay, silent = false) {
        if (S.loading) return;
        const isBackgroundCheck = silent && S.loaded && S.groups.length > 0;
        if (!isBackgroundCheck) {
          S.loading = true;
          S.loaded = false;
          S.failed = false;
          S.selected.clear();
          render();
        }

        let res;
        try {
          const params = { include_custom: !!S.includeCustom };
          res = withOverlay
            ? await busy(() => API.engine('cache.list', params), T('正在读取缓存目录…', 'Reading cache folders…'), 'cache')
            : await API.engine('cache.list', params);
        } catch (e) {
          if (!isBackgroundCheck) {
            toast(errText(e), 'error');
            S.failed = true;
          }
        } finally {
          if (!isBackgroundCheck) {
            S.loading = false;
            S.loaded = true;
          }
        }

        if (!res) { if (!isBackgroundCheck) render(); return; }
        if (res.error) {
          if (!isBackgroundCheck) {
            toast(res.error, 'error');
            S.failed = true;
            render();
          }
          return;
        }

        const newGroups = (Array.isArray(res.groups) ? res.groups : []).map((g) => ({
          name: g.name || T('其他', 'Other'),
          level: g.level || 'caution',
          items: Array.isArray(g.items) ? g.items : []
        }));

        GlobalCachePageCache.lastScanTime = Date.now();
        GlobalCachePageCache.includeCustom = S.includeCustom;
        GlobalCachePageCache.pruneEmpty = S.pruneEmpty;

        if (isBackgroundCheck) {
          const oldTotal = S.groups.reduce((sum, g) => sum + g.items.length, 0);
          const newTotal = newGroups.reduce((sum, g) => sum + g.items.length, 0);
          const oldBytes = S.groups.reduce((sum, g) => sum + g.items.reduce((s, it) => s + (Number(it.size) || 0), 0), 0);
          const newBytes = newGroups.reduce((sum, g) => sum + g.items.reduce((s, it) => s + (Number(it.size) || 0), 0), 0);
          // 若总项数与总字节数没有变化，保持原视图不闪烁
          if (oldTotal === newTotal && oldBytes === newBytes) return;
        }

        S.groups = newGroups;
        GlobalCachePageCache.groups = newGroups;
        render();
      }

      /* ---------- 清理 ---------- */
      function confirmBody(paths) {
        const size = paths.reduce((n, p) => {
          const it = findItem(p);
          return n + (it ? Number(it.size) || 0 : 0);
        }, 0);
        return T(
          '清理 ' + fmtCount(paths.length) + ' 项（预计释放 ' + fmtBytes(size) + '）？只清内容不删目录' +
            (S.pruneEmpty ? '，并删除清理后变空的子目录' : '') + '。',
          'Clean ' + fmtCount(paths.length) + ' items (about ' + fmtBytes(size) + ' to free)? Only contents are cleared' +
            (S.pruneEmpty ? ', and subfolders left empty are removed' : '') + '.'
        );
      }

      async function cleanPaths(paths, { quiet = false } = {}) {
        if (!paths || !paths.length) {
          toast(T('没有选中项', 'Nothing selected'), 'warn');
          return false;
        }

        let ok = false;
        try {
          ok = await confirm({
            title: T('清理缓存', 'Clean caches'),
            body: confirmBody(paths),
            ok: T('清理', 'Clean'),
            danger: true
          });
        } catch (e) {
          toast(errText(e), 'error');
          return false;
        }
        if (!ok) return false;

        let res;
        try {
          const run = () => API.engine('cache.clean', {
            paths: paths,
            confirm: true,
            prune_empty: !!S.pruneEmpty
          });
          res = quiet ? await run() : await busy(run, T('正在清理缓存…', 'Cleaning caches…'), 'cache');
        } catch (e) {
          toast(errText(e), 'error');
        }
        if (!res) return false;
        if (res.error) { toast(res.error, 'error'); return false; }

        const cleaned = Number(res.cleaned) || 0;
        const freed = Number(res.freed) || 0;
        const pruned = Number(res.pruned_dirs) || 0;
        const skipped = Number(res.skipped) || 0;
        const failed = Array.isArray(res.failed) ? res.failed : [];

        if (!failed.length) {
          toast(T(
            '已清理 ' + fmtCount(cleaned) + ' 项，释放 ' + fmtBytes(freed) +
              (pruned ? '，删除空目录 ' + fmtCount(pruned) + ' 个' : '') +
              (skipped ? '，跳过 ' + fmtCount(skipped) + ' 项' : ''),
            'Cleaned ' + fmtCount(cleaned) + ' items, freed ' + fmtBytes(freed) +
              (pruned ? ', removed ' + fmtCount(pruned) + ' empty folders' : '') +
              (skipped ? ', skipped ' + fmtCount(skipped) : '')
          ), 'ok');
        } else {
          // 清空底角 toast 浮层，彻底杜绝通知卡片与弹窗操作按钮在右下角重叠遮挡
          const toastBox = document.getElementById('toasts');
          if (toastBox) toastBox.innerHTML = '';
          showFailures(failed, { cleaned, freed, pruned, skipped });
        }
        return true;
      }

      async function doCleanSelected() {
        if (!S.selected.size) { toast(T('先勾选要清理的项', 'Select items first'), 'warn'); return; }
        const ok = await cleanPaths(Array.from(S.selected));
        if (ok) await doLoad(false);   // 让引擎返回最新的目录大小
      }

      async function doCleanRecommended() {
        const list = existingItems().filter((it) => it.level === 'safe');
        if (!list.length) { toast(T('没有可推荐清理的安全级缓存', 'No safe-level caches to clean'), 'warn'); return; }
        const ok = await cleanPaths(list.map((it) => it.path));
        if (ok) await doLoad(false);
      }

      async function doCleanGroup(name) {
        const g = S.groups.find((x) => x.name === name);
        const list = (g && Array.isArray(g.items) ? g.items : []).filter((it) => it.exists !== false);
        if (!list.length) { toast(T('本组没有可清理的条目', 'Nothing to clean in this group'), 'warn'); return; }
        const ok = await cleanPaths(list.map((it) => it.path));
        if (ok) await doLoad(false);
      }

      async function doCleanItem(path) {
        const it = findItem(path);
        if (!it || it.exists === false) return;
        const ok = await cleanPaths([path]);
        if (ok) await doLoad(false);
      }

      /* 失败清单弹窗（最多 300 条，智能归类占用源并给出清晰引导） */
      function showFailures(failed, summary) {
        if (!failed || !failed.length) return;

        // 识别占用源与可协同释放的应用
        const appSet = new Set();
        let lockedCount = 0;
        let hasEdge = false;
        let hasChrome = false;
        let hasWeChat = false;
        let hasSystem = false;

        failed.forEach((f) => {
          const p = String(f.path || '').toLowerCase();
          const w = String(f.why || '');
          const isLock = /winerror 32|占用|开着|lock/i.test(w);
          if (isLock) {
            lockedCount += 1;
            if (p.includes('\\microsoft\\edge\\') || p.includes('msedge')) {
              appSet.add(T('Edge 浏览器', 'Microsoft Edge'));
              hasEdge = true;
            } else if (p.includes('\\google\\chrome\\') || p.includes('chrome')) {
              appSet.add(T('Chrome 浏览器', 'Google Chrome'));
              hasChrome = true;
            } else if (p.includes('\\tencent\\xwechat\\') || p.includes('\\wechat\\')) {
              appSet.add(T('微信', 'WeChat'));
              hasWeChat = true;
            } else if (p.includes('\\nvidia\\dxcache\\') || p.includes('d3dscache')) {
              appSet.add(T('NVIDIA 显卡驱动', 'NVIDIA Driver'));
              hasSystem = true;
            } else if (p.includes('startmenuexperiencehost') || p.includes('startmenu')) {
              appSet.add(T('Windows 开始菜单', 'Start Menu'));
              hasSystem = true;
            } else {
              appSet.add(T('系统或后台软件', 'Background app'));
            }
          }
        });

        const appNames = Array.from(appSet);
        let tipText = '';
        if (lockedCount > 0) {
          tipText = T(
            '检测到 ' + fmtCount(lockedCount) + ' 项缓存正被正在运行的程序使用（' +
              (appNames.length ? '如 ' + appNames.slice(0, 3).join('、') + (appNames.length > 3 ? ' 等' : '') : '系统后台') +
              '）。这是 Windows 正常的文件保护机制。',
            fmtCount(lockedCount) + ' item(s) are locked by active apps (' +
              (appNames.length ? appNames.slice(0, 3).join(', ') : 'system') +
              '). Windows file lock protection is active.'
          );
          if (hasWeChat) {
            tipText += ' ' + T('微信包含本地数据库，建议在右下角托盘手动退出微信以防聊天数据损坏。', 'WeChat locks active databases; exit it manually in tray.');
          }
          if (hasSystem) {
            tipText += ' ' + T('显卡驱动与开始菜单由系统内核锁定，系统重启或空闲时会自动释放，无需强行关闭。', 'Driver & Start Menu caches are safely managed by OS.');
          }
        }

        function cleanWhy(why) {
          if (!why) return '';
          let s = String(why);
          if (/winerror 32/i.test(s)) {
            s = T('程序正在运行并使用该文件 (WinError 32)', 'In use by running process (WinError 32)');
          } else if (/winerror 5/i.test(s)) {
            s = T('需要管理员权限 (WinError 5)', 'Access denied (WinError 5)');
          }
          return s;
        }

        let dlg = null;

        // 可协同退出的操作按钮列表
        const closeActions = [];
        if (hasEdge) {
          closeActions.push({ proc: 'msedge', labelZh: '优雅退出 Edge 并重试清理', labelEn: 'Close Edge & Retry', pat: /msedge|microsoft\\edge/i });
        }
        if (hasChrome) {
          closeActions.push({ proc: 'chrome', labelZh: '优雅退出 Chrome 并重试清理', labelEn: 'Close Chrome & Retry', pat: /chrome|google\\chrome/i });
        }

        const actionBtns = closeActions.length ? h('div', {
          class: 'row wrap',
          style: { gap: '8px', marginTop: '8px' }
        }, ...closeActions.map((act) => {
          const origLabel = T(act.labelZh, act.labelEn);
          const b = h('button', {
            class: 'btn primary sm',
            type: 'button',
            onclick: async () => {
              b.disabled = true;
              const toRetry = failed
                .filter((f) => act.pat.test(String(f.path || '')))
                .map((f) => f.path);
              if (dlg && typeof dlg.close === 'function') dlg.close();
              const closeRes = await busy(async (ctrl) => {
                ctrl && ctrl.setProgress(35);
                ctrl && ctrl.setSub(T('正在等待进程落盘并释放文件占用…', 'Waiting for process to exit and release file locks…'));
                return await API.engine('process.close', { name: act.proc });
              }, T('正在优雅退出浏览器…', 'Gracefully closing browser…'), 'cache');
              if (!closeRes) {
                b.disabled = false;
                b.textContent = origLabel;
                return;
              }
              if (closeRes.warning) {
                toast(closeRes.warning, 'warn');
                b.disabled = false;
                b.textContent = origLabel;
                return;
              }
              let forceClose = false;
              if (closeRes.still_running) {
                forceClose = await confirm({
                  title: T('检测到后台驻留进程', 'Background processes still running'),
                  body: T(
                    '浏览器仍有后台驻留进程未完全退出，是否强制结束以释放缓存文件锁？',
                    'Background browser processes are still running. Force close them to release cache locks?'
                  ),
                  ok: T('强制关闭并继续清理', 'Force close & retry'),
                  danger: true
                });
              }
              await busy(async (ctrl) => {
                if (forceClose) {
                  ctrl && ctrl.setText(T('正在强制结束残留进程…', 'Force closing remaining processes…'));
                  ctrl && ctrl.setProgress(25);
                  await API.engine('process.close', { name: act.proc, force: true });
                }
                ctrl && ctrl.setText(T('正在重新清理被占用的缓存…', 'Retrying cache cleanup…'));
                ctrl && ctrl.setProgress(60);
                ctrl && ctrl.setSub(T('共 ' + toRetry.length + ' 个缓存项', toRetry.length + ' item(s)'));
                if (toRetry.length) {
                  await cleanPaths(toRetry, true);
                }
                ctrl && ctrl.setText(T('正在刷新缓存扫描结果…', 'Refreshing scan results…'));
                ctrl && ctrl.setProgress(90);
                await doLoad(false);
                ctrl && ctrl.setProgress(100);
              }, T('正在重试清理缓存…', 'Retrying cache cleanup…'), 'cache');
              b.disabled = false;
              b.textContent = origLabel;
            }
          }, icon('check', 13), h('span', null, origLabel));
          return b;
        })) : null;

        const noticeBox = tipText ? h('div', {
          class: 'card',
          style: {
            padding: '10px 12px',
            marginBottom: '10px',
            background: 'var(--surface-2)',
            border: '1px solid var(--line)',
            fontSize: 'var(--fs-small)',
            color: 'var(--text-2)',
            lineHeight: '1.5'
          }
        },
          h('div', null, h('strong', { style: { color: 'var(--text-1)' } }, T('💡 处理建议：', '💡 Note: ')), tipText),
          actionBtns
        ) : null;

        const listWrap = h('div', {
          class: 'list',
          style: { maxHeight: '48vh', overflowY: 'auto', paddingRight: '4px' }
        },
          ...failed.slice(0, 300).map((f) => h('div', { class: 'list-item' },
            h('div', { class: 'stack', style: { gap: '2px', minWidth: '0' } },
              h('div', { class: 'mono small ellipsis', title: f.path || '' }, f.path || '—'),
              f.why ? h('div', { class: 'small muted' }, cleanWhy(f.why)) : null
            )
          ))
        );

        const summaryBar = summary ? h('div', {
          style: {
            padding: '9px 12px',
            marginBottom: '10px',
            borderRadius: 'var(--radius)',
            background: 'var(--surface-2)',
            border: '1px solid var(--line)',
            fontSize: 'var(--fs-small)',
            color: 'var(--text-1)'
          }
        }, T(
          '已清理 ' + fmtCount(summary.cleaned || 0) + ' 项，释放 ' + fmtBytes(summary.freed || 0) +
            '（' + fmtCount(failed.length) + ' 项因程序占用或系统保护跳过）',
          'Cleaned ' + fmtCount(summary.cleaned || 0) + ' items, freed ' + fmtBytes(summary.freed || 0) +
            ' (' + fmtCount(failed.length) + ' items locked by active apps)'
        )) : null;

        const body = h('div', { class: 'stack', style: { gap: '0' } }, summaryBar, noticeBox, listWrap);

        dlg = modal({
          title: T('有 ' + fmtCount(failed.length) + ' 项没有清理成功', fmtCount(failed.length) + ' items were not cleaned'),
          body: body,
          wide: true,
          buttons: [{ id: 'ok', label: T('我知道了', 'Got it'), kind: 'primary' }]
        });
      }

      /* ---------- 小工具 ---------- */
      function openInApp(p) {
        if (!p) return;
        if (window.AIEntries && typeof window.AIEntries.open === 'function') window.AIEntries.open(p);
        else revealPath(p);
      }

      function revealPath(p) {
        API.reveal(p).catch((e) => toast(errText(e), 'error'));
      }

      const copyText = UI.copy;

      /* ---------- 初始化 ---------- */
      /* 每页条数改了：就地重排各分组，不重建页面 */
      App._onPageSize = () => {
        PAGE_SIZE = UI.pageSize();
        render();
      };
      setActions();

      liveJump = function (payload) {
        const p = payload || {};
        if (p.action === 'safe') selectSafe();
        else if (p.action === 'recommended') doCleanRecommended();
        else if (p.action === 'scan' || p.reload) doLoad(true);
      };

      render();
      const timeSinceLast = Date.now() - GlobalCachePageCache.lastScanTime;
      // 关键优化：有缓存时 0ms 瞬间还原；只有冷启动或距离上次读取超 60 秒才在后台静默探查
      if (!hasCache) {
        await doLoad(false);
      } else if (timeSinceLast >= 60000) {
        doLoad(false, true).catch(() => {});
      }

      return function unmount() {
        liveJump = null;
        if (window.App) window.App._onPageSize = null;
        setActions();
      };
    },

    jump(payload) { return liveJump ? liveJump(payload || {}) : undefined; }
  };
})();
