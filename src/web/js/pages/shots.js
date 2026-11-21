/* ============================================================
   清理截图页（第二轮 · 紧凑版）
   - 顶层 3 块：条件/操作卡、扫描目录（折叠）、结果卡
   - 页面不套滚动容器：#scroll 统一滚动；结果用分页（每页 200 条）而非内部滚动
   - 多目录：配置 shot_dirs，扫描时传 dirs；空配置 = 引擎默认目录
   - 网格/列表两种视图，点击打开自带「删除当前图片」的大图预览
   - 清理走 shots.clean {paths, confirm:true}，引擎负责移入回收站
   ============================================================ */
(function () {
  'use strict';
  const {
    h, T, icon, fmtBytes, fmtCount, fmtTime,
    toast, confirm, busy, skeleton, empty, section, modal, attachMenu, softIn
  } = UI;

  let PAGE_SIZE = 15;      // 每页条数：靠分页控制 DOM 规模，不再用 max-height
  const MAX_DAYS = 3650;
  const MAX_KB = 1024 * 1024;

  const errText = UI.errText;

  /* 本地路径 -> Tauri asset 地址；convertFileSrc 不可用时退回 file:// */
  function fileSrc(p) {
    try {
      const core = window.__TAURI__ && window.__TAURI__.core;
      if (core && typeof core.convertFileSrc === 'function') return core.convertFileSrc(p);
    } catch (e) { /* 忽略，走 file:// */ }
    return 'file:///' + String(p).replace(/\\/g, '/');
  }

  function clampInt(v, min, max) {
    const n = Math.floor(Number(v));
    if (!isFinite(n)) return min;
    return Math.min(max, Math.max(min, n));
  }

  /* 回到页面顶部（#scroll 是唯一滚动容器） */
  function scrollTop(smooth) {
    const sc = document.getElementById('scroll');
    if (sc) sc.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'auto' });
  }

  window.Pages = window.Pages || {};

  window.Pages.shots = {
    title: ['清理截图', 'Screenshots'],
    subtitle: ['扫描旧截图、预览后批量移入回收站', 'Find old screenshots, preview, then move them to the recycle bin'],

    async mount(root) {
      PAGE_SIZE = UI.pageSize();
      /* ---------- 状态 ---------- */
      const S = {
        items: [],
        cfgDirs: [],          // 配置里的目录（空 = 用引擎默认）
        effDirs: [],          // 引擎实际扫描的目录
        missing: [],
        suggest: [],          // 引擎默认目录里尚未加入的那些
        days: 7,
        minKb: 0,
        allImages: false,     // 包含所有图片（不只按截图命名）
        selected: new Set(),  // path 集合
        view: 'grid',
        sort: 'size',
        page: 1,
        loading: false,
        loaded: false,
        failed: false,
        lastPath: '',         // 最近播放/查看的文件
        lastKind: '',         // 'play' | 'view'
        kind: 'all'           // all | shot | image | video
      };
      const sizeMap = new Map();   // path -> size，供选中统计 / 菜单用

      /* ---------- 顶部：条件 + 操作 + 统计 ---------- */
      const daysInput = h('input', {
        class: 'input', type: 'number', min: '0', max: String(MAX_DAYS), step: '1',
        value: String(S.days), style: { width: '76px' },
        'aria-label': T('保留天数', 'Keep days'),
        onchange: (e) => {
          S.days = clampInt(e.target.value, 0, MAX_DAYS);
          e.target.value = String(S.days);
          saveOptions();
        }
      });
      const kbInput = h('input', {
        class: 'input', type: 'number', min: '0', max: String(MAX_KB), step: '1',
        value: String(S.minKb), style: { width: '84px' },
        'aria-label': T('最小体积 KB', 'Minimum size in KB'),
        onchange: (e) => {
          S.minKb = clampInt(e.target.value, 0, MAX_KB);
          e.target.value = String(S.minKb);
          saveOptions();
        }
      });

      const allImagesCb = h('input', {
        type: 'checkbox',
        'aria-label': T('包含所有图片', 'Include all images'),
        onchange: (e) => { S.allImages = !!e.target.checked; saveOptions(); doScan(false); }
      });
      const allImagesLabel = h('label', {
        class: 'small muted row',
        title: T('打开后目录里的所有图片/视频都会列出（含照片、表情包），清理前请逐项确认',
          'List every image/video in the folders, including photos and stickers; review before cleaning')
      }, allImagesCb, h('span', null, T('所有图片', 'All images')));

      const scanBtn = h('button', { class: 'btn primary', onclick: () => { doScan(false); } },
        icon('scan', 14), T('扫描', 'Scan'));
      const cleanBtn = h('button', {
        class: 'btn danger', disabled: true, onclick: () => { doCleanSelected(); }
      }, icon('trash', 14), T('清理选中', 'Clean selected'));
      const selAllBtn = h('button', { class: 'btn sm ghost', onclick: () => selectAll(true),
        title: T('只勾选截图；照片、视频请逐项手动选择', 'Selects screenshots only; pick photos and videos one by one') },
        icon('check', 13), T('全选', 'Select all'));
      const invertBtn = h('button', { class: 'btn sm ghost', onclick: () => invertSelection() },
        icon('more', 13), T('反选', 'Invert'));

      const gridBtn = h('button', { class: 'btn sm primary', onclick: () => setView('grid') },
        icon('shots', 13), T('网格', 'Grid'));
      const listBtn = h('button', { class: 'btn sm ghost', onclick: () => setView('list') },
        icon('file', 13), T('列表', 'List'));

      /* 类型筛选：全部 / 截图 / 图片 / 视频 */
      const kindBtns = {};
      const kindLabels = {
        all: T('全部', 'All'), shot: T('截图', 'Shots'),
        image: T('图片', 'Images'), video: T('视频', 'Videos')
      };
      const kindFilter = h('div', { class: 'shot-kinds' },
        ['all', 'shot', 'image', 'video'].map((k) => {
          const b = h('button', {
            class: 'btn sm ' + (S.kind === k ? 'primary' : 'ghost'),
            onclick: () => { S.kind = k; S.page = 1; syncKind(); render(); }
          }, h('span', { text: kindLabels[k] }));
          kindBtns[k] = b;
          return b;
        }));
      function syncKind() {
        Object.keys(kindBtns).forEach((k) => {
          kindBtns[k].className = 'btn sm ' + (S.kind === k ? 'primary' : 'ghost');
        });
      }

      const sortSelect = h('select', {
        class: 'select', style: { width: '108px' }, 'aria-label': T('排序方式', 'Sort by'),
        onchange: (e) => {
          S.sort = e.target.value;
          S.page = 1;
          render();
        }
      },
        h('option', { value: 'size' }, T('按大小', 'By size')),
        h('option', { value: 'time' }, T('按时间', 'By time')),
        h('option', { value: 'name' }, T('按名称', 'By name'))
      );

      const statCount = h('b', { class: 'shot-num' }, '0');
      const statSize = h('b', { class: 'shot-num' }, '0 B');
      const statSel = h('b', { class: 'shot-num' }, '0');

      const topCard = h('div', { class: 'card cmd-bar', style: { justifyContent: 'flex-start' } },
        h('div', { class: 'cmd-main', style: { width: '100%', justifyContent: 'flex-start' } },
          h('span', { class: 'small muted' }, T('保留天数', 'Keep days')),
          daysInput,
          h('span', { class: 'small muted' }, T('天以上', 'days +')),
          h('span', { class: 'small muted', style: { marginLeft: '6px' } }, T('最小体积', 'Min size')),
          kbInput,
          h('span', { class: 'small muted' }, 'KB'),
          allImagesLabel,
          h('span', { class: 'cmd-sep' }),
          scanBtn,
          cleanBtn
        )
      );

      /* ---------- 扫描目录（折叠） ---------- */
      const dirListBox = h('div', { class: 'dir-list' });
      const addDirBtn = h('button', { class: 'btn sm', onclick: () => { addDir(); } },
        icon('plus', 13), T('添加目录', 'Add folder'));
      const resetDirBtn = h('button', { class: 'btn sm ghost', onclick: () => { resetDirs(); } },
        icon('undo', 13), T('恢复默认', 'Use defaults'));
      const dirHint = h('span', { class: 'small muted' });
      const dirBody = h('div', { class: 'stack' },
        dirListBox,
        h('div', { class: 'row' },
          addDirBtn, resetDirBtn,
          h('span', { class: 'spacer' }),
          dirHint
        ),
        h('div', { class: 'small muted' },
          T('默认使用引擎内置的截图目录；添加后只扫描列表里的目录。',
            'By default the engine built-in screenshot folders are scanned; once you add folders, only those are scanned.'))
      );
      const dirSection = section(T('扫描目录', 'Scan folders'), dirBody, {
        open: false,
        id: 'shots-dirs',
        hint: T('多目录', 'Multiple folders')
      });

      /* ---------- 结果卡 ---------- */
      const bodyBox = h('div', { class: 'stack' });
      const cardHint = h('span', { class: 'hint' });
      const prevBtn = h('button', {
        class: 'pg-btn', type: 'button', title: T('上一页', 'Previous page'),
        'aria-label': T('上一页', 'Previous page'), disabled: true,
        onclick: () => { gotoPage(S.page - 1); }
      }, icon('chevron-left', 16));
      const nextBtn = h('button', {
        class: 'pg-btn', type: 'button', title: T('下一页', 'Next page'),
        'aria-label': T('下一页', 'Next page'), disabled: true,
        onclick: () => { gotoPage(S.page + 1); }
      }, icon('chevron-right', 16));
      /* 页码可以直接输入，回车或失焦跳转 */
      const pageInput = h('input', {
        class: 'input sm pg-input', type: 'text', inputmode: 'numeric',
        value: '1', 'aria-label': T('页码', 'Page number'),
        onkeydown: (e) => {
          if (e.key === 'Enter') { e.preventDefault(); jumpTo(pageInput.value); pageInput.blur(); }
        },
        onblur: () => { jumpTo(pageInput.value); }
      });
      const pageTotal = h('span', { class: 'small muted mono num' }, '1');
      const pageSum = h('span', { class: 'small muted' });
      const pagerInfo = h('span', { class: 'pg-wrap' },
        h('span', { class: 'small muted' }, T('第', 'Page')),
        pageInput,
        h('span', { class: 'small muted pg-slash' }, '/'),
        pageTotal,
        h('span', { class: 'small muted' }, T('页', '')),
        h('span', { class: 'pg-dot' }, '·'),
        pageSum
      );
      const pagerBar = h('div', { class: 'pager' }, prevBtn, pagerInfo, nextBtn);
      const pageHint = h('span', { class: 'small muted' }, T('每页', 'Per page'));
      const pager = h('div', { class: 'row pg-row' },
        pagerBar,
        h('span', { class: 'spacer' }),
        pageHint,
        UI.pageSizePick((n) => App.setPageSize(n))
      );

      /* 每页条数改了：就地重排当前结果，不重建页面（否则扫描结果会被清空） */
      App._onPageSize = () => {
        PAGE_SIZE = UI.pageSize();
        S.page = 1;
        render();
        resultCard.scrollIntoView({ block: 'start', behavior: 'smooth' });
      };
      const resultCard = h('div', { class: 'card stretch-card shot-card' },
        h('div', { class: 'shot-head' },
          h('div', { class: 'shot-title' },
            h('h2', null, T('预览', 'Preview')),
            h('div', { class: 'shot-summary' },
              statCount, h('span', { class: 'shot-unit' }, T('张', 'files')),
              h('span', { class: 'shot-dot' }),
              statSize,
              h('span', { class: 'shot-dot' }),
              h('span', { class: 'shot-key' }, T('已选', 'Selected')),
              statSel
            ),
            cardHint
          ),
          h('div', { class: 'shot-tools' },
            kindFilter,
            h('span', { class: 'shot-dot' }),
            selAllBtn,
            invertBtn,
            h('span', { class: 'shot-dot' }),
            gridBtn,
            listBtn,
            sortSelect
          )
        ),
        h('div', { class: 'shot-body' }, bodyBox),
        h('div', { class: 'shot-foot' }, pager)
      );

      root.appendChild(h('div', { class: 'stack page-fill' }, topCard, dirSection, resultCard));

      /* ---------- 右键菜单：有图 = 项菜单，空白 = 页面菜单 ---------- */
      attachMenu(bodyBox, (e) => {
        const el = e.target.closest('[data-path]');
        if (!el) return blankMenu();
        const p = el.dataset.path;
        const it = S.items.find((x) => x.path === p) || { path: p };
        return [
          { header: p },
          { label: T('预览', 'Preview'), icon: 'image', action: () => openViewer(p) },
          { label: T('定位文件', 'Reveal file'), icon: 'folder', action: () => revealPath(p) },
          { label: T('复制路径', 'Copy path'), icon: 'copy', action: () => copyText(p) },
          { sep: true },
          { label: T('删除该图', 'Delete image'), icon: 'trash', danger: true, action: () => { cleanPaths([p]); } }
        ];
      });

      function blankMenu() {
        return [
          { label: T('刷新', 'Refresh'), icon: 'refresh', action: () => { doScan(false); } },
          { label: T('全选', 'Select all'), icon: 'check', action: () => selectAll(true) },
          { label: T('反选', 'Invert'), icon: 'more', action: () => invertSelection() },
          { sep: true },
          { label: T('回到顶部', 'Back to top'), icon: 'undo', action: () => scrollTop(true) }
        ];
      }

      /* ---------- 选择 ---------- */
      function selectAll(on) {
        S.selected.clear();
        if (on) S.items.forEach((it) => { if (!S.allImages || it.shot) S.selected.add(it.path); });
        refreshSelection();
      }

      function invertSelection() {
        const next = new Set();
        S.items.forEach((it) => { if (!S.selected.has(it.path)) next.add(it.path); });
        S.selected = next;
        refreshSelection();
      }

      function selectedSize() {
        let n = 0;
        S.selected.forEach((p) => { n += sizeMap.get(p) || 0; });
        return n;
      }

      /* 勾选状态统一刷新：网格/列表的选中样式、顶部统计、清理按钮 */
      function refreshSelection() {
        bodyBox.querySelectorAll('[data-path]').forEach((el) => {
          const on = S.selected.has(el.dataset.path);
          el.classList.toggle('selected', on);
          const cb = el.querySelector('input.pick');
          if (cb) {
            cb.checked = on;
            cb.style.opacity = on ? '1' : (el.matches(':hover') ? '1' : '0');
          }
        });
        statSel.textContent = S.selected.size
          ? fmtCount(S.selected.size) + ' · ' + fmtBytes(selectedSize())
          : '0';
        // 顶部统计跟数据源一起刷新（曾漏掉这两行，导致网格已有图但统计显示 0）
        statCount.textContent = fmtCount(S.items.length);
        statSize.textContent = fmtBytes(sumSize());
        cleanBtn.disabled = S.selected.size === 0;
      }

      /* ---------- 网格 / 列表 ---------- */
      function sortedItems() {
        let arr = S.items.slice();
        if (S.kind === 'video') arr = arr.filter((it) => isVideoPath(it.path));
        else if (S.kind === 'image') arr = arr.filter((it) => it.shot === false && !isVideoPath(it.path));
        else if (S.kind === 'shot') {
          arr = arr.filter((it) => it.shot !== false && !isVideoPath(it.path) && !isCameraPhoto(it.path));
        }
        if (S.sort === 'time') arr.sort((a, b) => (Number(b.mtime) || 0) - (Number(a.mtime) || 0));
        else if (S.sort === 'name') arr.sort((a, b) => String(a.name || a.path).localeCompare(String(b.name || b.path)));
        else arr.sort((a, b) => (Number(b.size) || 0) - (Number(a.size) || 0));
        return arr;
      }

      /* 缩略图：加载失败换成矢量占位块，保持行高不跳 */
      function thumbNode(it) {
        const src = it.thumb ? fileSrc(it.thumb) : (it.kind === 'video' || isVideoPath(it.path) ? '' : fileSrc(it.path));
        const ph = () => {
          const box = h('div', {
            style: {
              height: '96px', display: 'grid', placeItems: 'center',
              color: 'var(--text-3)', background: 'var(--bg-subtle)'
            }
          }, icon(isVideoPath(it.path) ? 'play' : 'image', 26));
          return box;
        };
        if (!src) return ph();
        const img = h('img', { alt: '', src, loading: 'lazy', decoding: 'async' });
        img.addEventListener('error', async () => {
          // 扩展名与真实内容不符（相机格式改名成 .jpg 等）时，退回系统缩略图
          if (it._thumbTried) { img.replaceWith(ph()); return; }
          it._thumbTried = true;
          try {
            const r = await API.engine('shots.thumb', { path: it.path, size: 256 });
            if (r && r.path) { img.src = fileSrc(r.path); return; }
          } catch { /* ignore */ }
          img.replaceWith(ph());
        });
        return img;
      }

      function kindBadge(it) {
        const v = isVideoPath(it.path);
        if (v) {
          return h('span', { class: 'shot-kind' },
            icon('play', 11),
            h('span', { text: T('视频', 'Video') })
          );
        }
        if (!isCameraPhoto(it.path)) return null;
        return h('span', { class: 'shot-kind is-cam', title: T('相机照片', 'Camera photo') },
          icon('camera', 12)
        );
      }

      const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|avi|wmv|flv|ts|m2ts|3gp|mpg|mpeg)$/i;
      const CAMERA_EXT = /\.(tiff?|heic|heif|dng|cr2|cr3|nef|arw|raw|orf|rw2|raf|srw|pef)$/i;
      const CAMERA_NAME = /^(img|dsc|dscf|dscn|pxl|mvimg|gopr|dji|_mg|mvc)[-_ ]?\d/i;
      const CAMERA_DIR = /(^|[\\/])(dcim|camera roll|saved pictures|相机胶卷|相册)([\\/]|$)/i;
      const isVideoPath = (p) => VIDEO_EXT.test(String(p || ''));
      const isCameraPath = (p) => CAMERA_EXT.test(String(p || ''));
      // 相机照片 = 相机 RAW/HEIC 格式，或常见的 DCIM/IMG_/DSC_ 命名；普通截图不算
      const isCameraPhoto = (p) => {
        const s = String(p || '');
        if (!s || isVideoPath(s)) return false;
        if (isCameraPath(s)) return true;
        const name = s.split(/[\\/]/).pop() || '';
        return CAMERA_NAME.test(name) || CAMERA_DIR.test(s);
      };

      function markLast(path, kind) {
        S.lastPath = path || '';
        S.lastKind = kind || '';
        API.configSet({ shot_last_path: S.lastPath }).catch(() => {});
        refreshLastBadge();
      }

      function flagNode(path) {
        if (!S.lastPath || path !== S.lastPath) return null;
        const kind = S.lastKind || (isVideoPath(path) ? 'play' : 'view');
        return h('span', { class: 'shot-flag' },
          icon(kind === 'play' ? 'play' : 'image', 12),
          h('span', { text: kind === 'play' ? T('刚刚播放', 'Just played') : T('刚刚查看', 'Just viewed') })
        );
      }

      function refreshLastBadge() {
        document.querySelectorAll('.shot-flag').forEach((n) => n.remove());
        if (!S.lastPath) return;
        document.querySelectorAll('[data-path]').forEach((n) => {
          if (n.dataset.path !== S.lastPath) return;
          const b = flagNode(S.lastPath);
          if (b) n.appendChild(b);
        });
      }

      function pickNode(it) {
        const cb = h('input', {
          type: 'checkbox', class: 'pick',
          checked: S.selected.has(it.path),
          style: { width: '14px', height: '14px', margin: '0', accentColor: 'var(--accent)', opacity: S.selected.has(it.path) ? '1' : '0', cursor: 'pointer' },
          'aria-label': T('选择 ', 'Select ') + (it.name || it.path),
          onclick: (e) => e.stopPropagation(),
          onchange: (e) => {
            if (e.target.checked) S.selected.add(it.path);
            else S.selected.delete(it.path);
            refreshSelection();
          }
        });
        return cb;
      }

      function gridItem(it) {
        const sel = S.selected.has(it.path);
        const pick = pickNode(it);
        return h('div', {
          class: 'shot-item' + (sel ? ' selected' : ''),
          dataset: { path: it.path },
          tabindex: '0',
          title: (it.path || '') + '\n' + fmtBytes(it.size) + ' · ' + fmtTime(it.mtime),
          onclick: () => openViewer(it.path),
          onkeydown: (e) => {
            if (e.key === 'Enter') { e.preventDefault(); openViewer(it.path); }
          },
          onmouseenter: () => { pick.style.opacity = '1'; },
          onmouseleave: () => { pick.style.opacity = S.selected.has(it.path) ? '1' : '0'; },
          onfocusin: () => { pick.style.opacity = '1'; },
          onfocusout: () => { pick.style.opacity = S.selected.has(it.path) ? '1' : '0'; }
        },
          thumbNode(it),
          pick,
          kindBadge(it),
          flagNode(it.path),
          h('div', { class: 'meta' },
            h('div', { class: 'n' }, it.name || it.path),
            h('div', { class: 's' }, fmtBytes(it.size) + ' · ' + fmtTime(it.mtime) +
              (S.allImages && it.shot === false ? ' · ' + T('非截图', 'not a shot') : ''))
          )
        );
      }

      function listItem(it) {
        const sel = S.selected.has(it.path);
        const pick = pickNode(it);
        return h('div', {
          class: 'list-item' + (sel ? ' selected' : ''),
          dataset: { path: it.path },
          tabindex: '0',
          onclick: () => openViewer(it.path),
          onkeydown: (e) => {
            if (e.key === 'Enter') { e.preventDefault(); openViewer(it.path); }
          }
        },
          pick,
          h('img', {
            class: 'thumb', alt: '',
            src: it.thumb ? fileSrc(it.thumb) : fileSrc(it.path),
            loading: 'lazy',
            onerror: (e) => { e.target.style.visibility = 'hidden'; }
          }),
          h('div', { class: 'stack', style: { flex: '1', gap: '0', minWidth: '0' } },
            h('div', { class: 'shot-name' },
              h('div', { class: 'ellipsis', style: { fontSize: '12px' } }, it.name || it.path),
              kindBadge(it)
            ),
            flagNode(it.path),
            h('div', { class: 'small muted ellipsis' }, it.path)
          ),
          h('span', { class: 'mono' }, fmtBytes(it.size)),
          h('span', { class: 'small muted' }, fmtTime(it.mtime)),
          h('button', {
            class: 'btn icon sm ghost',
            title: T('定位文件', 'Reveal file'),
            'aria-label': T('定位文件', 'Reveal file'),
            onclick: (e) => { e.stopPropagation(); revealPath(it.path); }
          }, icon('folder', 13))
        );
      }

      function renderGrid(list) {
        const grid = h('div', { class: 'shot-grid' });
        list.forEach((it) => grid.appendChild(gridItem(it)));
        bodyBox.appendChild(grid);
      }

      function renderList(list) {
        const box = h('div', { class: 'list' });
        list.forEach((it) => box.appendChild(listItem(it)));
        bodyBox.appendChild(box);
      }

      /* ---------- 整页渲染 ---------- */
      function pagerIdle() {
        pageInput.disabled = true;
        pageInput.value = '';
        pageTotal.textContent = '—';
        pageSum.textContent = '';
        prevBtn.disabled = nextBtn.disabled = true;
      }

      function render() {
        bodyBox.innerHTML = '';
        const has = S.items.length > 0;
        pager.hidden = !has;
        if (pager.parentElement) pager.parentElement.hidden = !has;
        selAllBtn.disabled = invertBtn.disabled = !has;
        if (S.loading) {
          bodyBox.appendChild(skeleton(6, 'shots'));
          pagerIdle();
          cardHint.textContent = T('正在扫描…', 'Scanning…');
          return;
        }
        if (!S.loaded) {
          bodyBox.appendChild(empty(
            S.failed ? T('扫描失败', 'Scan failed') : T('尚未扫描', 'Not scanned yet'),
            S.failed
              ? T('调整条件后点「扫描」重试', 'Adjust the options and press Scan to retry')
              : T('点「扫描」查找超过保留天数的截图', 'Press Scan to find screenshots older than the keep window')
          ));
          pagerIdle();
          cardHint.textContent = '';
          return;
        }

        const list = sortedItems();
        cardHint.textContent = '';

        if (!list.length) {
          const sub = S.missing.length
            ? T('有 ' + fmtCount(S.missing.length) + ' 个目录不存在，可在「扫描目录」里移除',
              fmtCount(S.missing.length) + ' folders are missing; remove them under Scan folders')
            : T('可以调大保留天数或调小最小体积再扫描',
              'Increase the keep window or lower the minimum size and scan again');
          bodyBox.appendChild(empty(T('没有需要清理的截图', 'No screenshots to clean'), sub));
          pagerIdle();
          return;
        }

        const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
        S.page = Math.min(Math.max(1, S.page), pages);
        const start = (S.page - 1) * PAGE_SIZE;
        const slice = list.slice(start, start + PAGE_SIZE);

        if (S.view === 'list') renderList(slice);
        else renderGrid(slice);

        pageInput.disabled = false;
        if (document.activeElement !== pageInput) pageInput.value = String(S.page);
        pageTotal.textContent = String(pages);
        pageSum.textContent = T(
          '共 ' + fmtCount(list.length) + ' 张',
          fmtCount(list.length) + ' files'
        );
        prevBtn.disabled = S.page <= 1;
        nextBtn.disabled = S.page >= pages;

        refreshSelection();
        softIn(bodyBox);
      }

      /* 输入页码跳转：越界自动夹到 1..pages */
      function jumpTo(v) {
        if (!S.items.length) return;
        const pages = Math.max(1, Math.ceil(S.items.length / PAGE_SIZE));
        const n = clampInt(v, 1, pages);
        gotoPage(n);
        pageInput.value = String(S.page);
      }

      function gotoPage(p) {
        const pages = Math.max(1, Math.ceil(S.items.length / PAGE_SIZE));
        const next = Math.min(Math.max(1, p), pages);
        if (next === S.page) return;
        S.page = next;
        render();
        // 翻页后把结果卡顶部对齐视口，避免停在列表中间
        resultCard.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }

      function setView(v) {
        if (S.view === v) return;
        S.view = v;
        gridBtn.className = 'btn sm ' + (v === 'grid' ? 'primary' : 'ghost');
        listBtn.className = 'btn sm ' + (v === 'list' ? 'primary' : 'ghost');
        render();
      }

      /* ---------- 大图预览（复用 preview-* 样式，自带删除当前图） ---------- */
      const viewerThumbs = new Map();   // 相机格式/TIFF → 引擎生成的 PNG

      function openViewer(startPath) {
        if (isVideoPath(startPath)) {
          API.openPath(startPath)
            .then(() => markLast(startPath, 'play'))
            .catch((e) => toast(errText(e), 'error'));
          return;
        }
        if (isCameraPath(startPath) && !viewerThumbs.has(startPath)) {
          API.engine('shots.thumb', { path: startPath, size: 1280 })
            .then((r) => { if (r && r.path) viewerThumbs.set(startPath, r.path); })
            .catch(() => {})
            .finally(() => openViewerNow(startPath));
          return;
        }
        openViewerNow(startPath);
      }

      function openViewerNow(startPath) {
        const rootEl = document.getElementById('preview-root');
        if (!rootEl) return;
        let list = sortedItems();
        if (!list.length) return;
        let idx = list.findIndex((x) => x.path === startPath);
        if (idx < 0) idx = 0;
        markLast(list[idx].path, 'view');
        let zoom = 1;
        let panX = 0;
        let panY = 0;
        let viewW = 0;
        let viewH = 0;
        let drag = null;
        let frame = 0;
        let settle = 0;
        let swallowClick = false;

        const img = h('img', { alt: '', draggable: false });
        // transform 只由脚本逐帧写，别让 CSS 过渡插一脚
        img.style.transition = 'opacity var(--dur-2) var(--ease)';
        const placeholder = h('div', {
          style: { display: 'none', color: 'rgba(255,255,255,.55)', fontSize: '12px' }
        }, T('无法加载这张图片', 'This image could not be loaded'));
        const stage = h('div', { class: 'preview-stage' }, img, placeholder);
        const nameEl = h('div', { class: 'name' });
        const posEl = h('span', { class: 'mono' });
        const dots = h('div', { class: 'dots' });

        /* ---------- 缩放 + 拖动 ----------
           一帧只写一次 transform（rAF 合并），滚轮和拖动同时发生也不会各自重排；
           拖动期间不重建 DOM、不换 src，只有 GPU 合成。 */
        function measure() {
          const cs = getComputedStyle(stage);
          viewW = stage.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
          viewH = stage.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
        }

        // 图片边缘不越过视口：图比视口小时锁在中间
        function clampPan() {
          const halfW = (img.offsetWidth * zoom - viewW) / 2;
          const halfH = (img.offsetHeight * zoom - viewH) / 2;
          panX = halfW > 0 ? Math.min(halfW, Math.max(-halfW, panX)) : 0;
          panY = halfH > 0 ? Math.min(halfH, Math.max(-halfH, panY)) : 0;
        }

        function paint() {
          img.style.transform = 'translate3d(' + panX + 'px,' + panY + 'px,0) scale(' + zoom + ')';
        }

        function schedule() {
          if (frame) return;
          frame = requestAnimationFrame(() => {
            frame = 0;
            clampPan();
            paint();
          });
        }

        function applyNow() {
          if (frame) { cancelAnimationFrame(frame); frame = 0; }
          clampPan();
          paint();
        }

        function markZoomed() {
          const on = zoom > 1.001;
          stage.classList.toggle('zoomed', on);
          img.style.willChange = on || drag ? 'transform' : '';
        }

        function stopSettle() {
          if (settle) { cancelAnimationFrame(settle); settle = 0; }
        }

        // 以 (cx, cy) 为锚点缩放：光标下的那一点保持不动
        function zoomAt(next, cx, cy) {
          stopSettle();
          const z = Math.max(0.25, Math.min(4, next));
          if (Math.abs(z - zoom) < 0.0001) return;
          panX = cx - (cx - panX) * (z / zoom);
          panY = cy - (cy - panY) * (z / zoom);
          zoom = z;
          markZoomed();
          schedule();
        }

        function resetView(animate) {
          stopSettle();
          if (!animate) {
            zoom = 1;
            panX = 0;
            panY = 0;
            markZoomed();
            applyNow();
            return;
          }
          const z0 = zoom;
          const x0 = panX;
          const y0 = panY;
          const t0 = performance.now();
          const tick = (now) => {
            const k = Math.min(1, (now - t0) / 190);
            const e = 1 - Math.pow(1 - k, 3);
            zoom = z0 + (1 - z0) * e;
            panX = x0 * (1 - e);
            panY = y0 * (1 - e);
            paint();
            settle = k < 1 ? requestAnimationFrame(tick) : 0;
            if (!settle) { zoom = 1; panX = 0; panY = 0; markZoomed(); paint(); }
          };
          settle = requestAnimationFrame(tick);
        }

        const delBtn = h('button', {
          class: 'btn sm ghost danger',
          onclick: () => { delCurrent(); }
        }, icon('trash', 12), T('删除', 'Delete'));

        const mask = h('div', { class: 'preview-mask', style: { zIndex: '65' } },
          h('div', { class: 'preview-bar' },
            h('span', { class: 'name' }, T('截图预览', 'Screenshot preview')),
            nameEl,
            h('button', { class: 'btn sm ghost', title: T('放大', 'Zoom in'), onclick: () => zoomAt(zoom * 1.25, 0, 0) }, '＋'),
            h('button', { class: 'btn sm ghost', title: T('缩小', 'Zoom out'), onclick: () => zoomAt(zoom / 1.25, 0, 0) }, '－'),
            h('button', { class: 'btn sm ghost', onclick: () => resetView(true) }, T('原始', 'Reset')),
            delBtn,
            h('button', {
              class: 'btn sm ghost',
              onclick: () => { const it = list[idx]; if (it) revealPath(it.path); }
            }, T('定位', 'Reveal')),
            h('button', { class: 'btn sm ghost', onclick: () => close() }, T('关闭', 'Close'))
          ),
          stage,
          h('div', { class: 'preview-foot' },
            h('button', { class: 'btn sm ghost', onclick: () => step(-1) }, '‹'),
            posEl,
            dots,
            h('button', { class: 'btn sm ghost', onclick: () => step(1) }, '›')
          )
        );

        function render() {
          const it = list[idx];
          if (!it) return;
          nameEl.textContent = (it.name || it.path) + ' · ' + fmtBytes(it.size) + ' · ' + fmtTime(it.mtime);
          posEl.textContent = (idx + 1) + ' / ' + list.length;
          // 先挂回调再设 src，命中缓存时也能正确切换占位
          img.onload = () => {
            img.style.display = '';
            placeholder.style.display = 'none';
            measure();          // 图片解码后才量得到真实展示尺寸
            applyNow();
          };
          img.onerror = async () => {
            // 真实内容不是浏览器能解码的格式时，用系统缩略图兜底一次
            if (!it._viewerThumbTried) {
              it._viewerThumbTried = true;
              try {
                const r = await API.engine('shots.thumb', { path: it.path, size: 1280 });
                if (r && r.path) {
                  viewerThumbs.set(it.path, r.path);
                  if (list[idx] === it) render();
                  return;
                }
              } catch { /* ignore */ }
            }
            img.style.display = 'none';
            placeholder.style.display = 'block';
          };
          img.style.display = '';
          placeholder.style.display = 'none';
          img.src = fileSrc(viewerThumbs.get(it.path) || it.path);
          if (isCameraPath(it.path) && !viewerThumbs.has(it.path)) {
            API.engine('shots.thumb', { path: it.path, size: 1280 })
              .then((r) => {
                if (!r || !r.path) return;
                viewerThumbs.set(it.path, r.path);
                if (list[idx] === it) render();
              })
              .catch(() => {});
          }
          resetView(false);
          dots.innerHTML = '';
          if (list.length <= 40) {
            list.forEach((_, i) => dots.appendChild(h('button', {
              class: 'dotbtn' + (i === idx ? ' on' : ''),
              'aria-label': String(i + 1),
              onclick: () => { idx = i; render(); }
            })));
          }
        }

        function step(d) {
          idx = (idx + d + list.length) % list.length;
          render();
        }

        function close() {
          document.removeEventListener('keydown', onKey);
          stopSettle();
          if (frame) { cancelAnimationFrame(frame); frame = 0; }
          rootEl.innerHTML = '';
        }

        /* 删除当前图：确认 -> 引擎移入回收站 -> 原地显示下一张 */
        async function delCurrent() {
          const it = list[idx];
          if (!it) return;
          delBtn.disabled = true;
          const ok = await cleanPaths([it.path], { quiet: true });
          delBtn.disabled = false;
          if (!ok) return;
          list = sortedItems();
          if (!list.length) { close(); return; }
          idx = Math.min(idx, list.length - 1);
          render();
        }

        function onKey(e) {
          // 上层还有弹窗（删除确认等）时把按键让给它，Esc 只关最上面一层
          const mr = document.getElementById('modal-root');
          if (mr && mr.childElementCount) return;
          if (e.key === 'Escape') close();
          else if (e.key === 'ArrowLeft') step(-1);
          else if (e.key === 'ArrowRight') step(1);
          else if (e.key === '+' || e.key === '=') zoomAt(zoom * 1.25, 0, 0);
          else if (e.key === '-') zoomAt(zoom / 1.25, 0, 0);
        }

        // 只有点在图片外的黑色舞台才关闭；拖动结束后的那次 click 不算
        mask.addEventListener('click', (e) => {
          if (e.target !== stage) return;
          if (swallowClick) { swallowClick = false; return; }
          close();
        });

        stage.addEventListener('wheel', (e) => {
          e.preventDefault();
          const r = stage.getBoundingClientRect();
          // 乘法步进：高分屏/触控板的小 delta 也不会一次跳很多
          zoomAt(zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12),
            e.clientX - (r.left + r.width / 2),
            e.clientY - (r.top + r.height / 2));
        }, { passive: false });

        stage.addEventListener('pointerdown', (e) => {
          if (e.pointerType === 'mouse' && e.button !== 0) return;
          if (zoom <= 1.001) return;
          drag = { id: e.pointerId, x: e.clientX, y: e.clientY, ox: panX, oy: panY, moved: 0 };
          stage.classList.add('panning');
          img.style.willChange = 'transform';
          try { stage.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
          e.preventDefault();
        });

        stage.addEventListener('pointermove', (e) => {
          if (!drag || e.pointerId !== drag.id) return;
          const dx = e.clientX - drag.x;
          const dy = e.clientY - drag.y;
          drag.moved = Math.max(drag.moved, Math.abs(dx) + Math.abs(dy));
          panX = drag.ox + dx;
          panY = drag.oy + dy;
          schedule();
        });

        function endDrag(e) {
          if (!drag || (e && e.pointerId !== drag.id)) return;
          if (drag.moved > 4) swallowClick = true;
          drag = null;
          stage.classList.remove('panning');
          if (e) { try { stage.releasePointerCapture(e.pointerId); } catch (err) { /* 忽略 */ } }
          applyNow();
          markZoomed();
        }
        stage.addEventListener('pointerup', endDrag);
        stage.addEventListener('pointercancel', endDrag);

        // 双击：已放大则回中，否则在光标处放大到 2x
        img.addEventListener('dblclick', (e) => {
          e.preventDefault();
          if (zoom > 1.001) { resetView(true); return; }
          const r = stage.getBoundingClientRect();
          zoomAt(2, e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2));
        });

        document.addEventListener('keydown', onKey);
        rootEl.innerHTML = '';
        rootEl.appendChild(mask);
        render();
      }

      /* ---------- 配置 ---------- */
      async function saveDirs() {
        try {
          await API.configSet({ shot_dirs: S.cfgDirs.slice() });
        } catch (e) { toast(errText(e), 'error'); }
      }

      async function saveOptions() {
        try {
          await API.configSet({
            shot_days: clampInt(S.days, 0, MAX_DAYS),
            shot_min_kb: clampInt(S.minKb, 0, MAX_KB),
            shot_all_images: !!S.allImages,
            shot_dirs: S.cfgDirs.slice()
          });
        } catch (e) { toast(errText(e), 'error'); }
      }

      /* ---------- 目录增删 ---------- */
      function samePath(a, b) {
        return String(a).replace(/[\\/]+$/, '').toLowerCase() === String(b).replace(/[\\/]+$/, '').toLowerCase();
      }

      async function addDir() {
        let picked = null;
        try {
          picked = await API.pickFolder();
        } catch (e) { toast(errText(e), 'error'); return; }
        if (!picked) return;
        // 配置为空时，先把引擎当前使用的默认目录固化下来，再追加新目录
        const base = S.cfgDirs.length ? S.cfgDirs.slice() : S.effDirs.slice();
        if (base.some((d) => samePath(d, picked))) {
          toast(T('该目录已在列表里', 'Folder already in the list'), 'info');
          return;
        }
        S.cfgDirs = base.concat([picked]);
        await saveDirs();
        renderDirs();
        await doScan(false);
      }

      async function removeDir(p) {
        const base = S.cfgDirs.length ? S.cfgDirs.slice() : S.effDirs.slice();
        const next = base.filter((d) => !samePath(d, p));
        if (!next.length) {
          toast(T('至少保留一个目录；要回到默认目录请点「恢复默认」',
            'Keep at least one folder; press "Use defaults" to go back'), 'warn');
          return;
        }
        S.cfgDirs = next;
        await saveDirs();
        renderDirs();
        await doScan(false);
      }

      async function resetDirs() {
        S.cfgDirs = [];
        S.suggest = [];
        await saveDirs();
        renderDirs();
        await doScan(false);
      }

      async function addSuggestDirs() {
        if (!S.suggest.length) return;
        const have = new Set(S.cfgDirs.map((p) => String(p).toLowerCase()));
        S.suggest.forEach((p) => {
          if (!have.has(String(p).toLowerCase())) S.cfgDirs.push(p);
        });
        S.suggest = [];
        await saveDirs();
        renderDirs();
        await doScan(false);
      }

      function renderDirs() {
        dirListBox.innerHTML = '';
        const usingDefaults = S.cfgDirs.length === 0;
        const list = usingDefaults ? S.effDirs : S.cfgDirs;
        const missing = new Set(S.missing.map((p) => String(p).toLowerCase()));

        if (!list.length) {
          dirListBox.appendChild(h('div', { class: 'small muted' },
            T('当前使用引擎默认截图目录，扫描后会在这里列出实际目录。',
              'Using the engine default screenshot folders; the actual folders are listed here after scanning.')));
        } else {
          list.forEach((p) => {
            const gone = missing.has(String(p).toLowerCase());
            dirListBox.appendChild(h('div', { class: 'dir-row', title: p },
              icon('folder', 14),
              h('span', { class: 'p' }, p),
              gone ? h('span', { class: 'badge warn' }, T('不存在', 'Missing')) : null,
              usingDefaults ? h('span', { class: 'badge' }, T('默认', 'Default')) : null,
              h('button', {
                class: 'btn icon sm ghost',
                title: T('移除目录', 'Remove folder'),
                'aria-label': T('移除目录', 'Remove folder'),
                onclick: () => { removeDir(p); }
              }, icon('close', 13))
            ));
          });
        }
        dirHint.textContent = usingDefaults
          ? T('引擎默认 · ' + fmtCount(S.effDirs.length) + ' 个', 'Default · ' + fmtCount(S.effDirs.length))
          : T(fmtCount(S.cfgDirs.length) + ' 个自定义目录', fmtCount(S.cfgDirs.length) + ' custom folders');

        if (!usingDefaults && S.suggest.length) {
          dirListBox.appendChild(h('div', { class: 'row', style: { marginTop: '4px' } },
            h('span', { class: 'small muted' },
              T('还有 ' + fmtCount(S.suggest.length) + ' 个系统默认目录未加入，可能漏掉 Game Bar、相机胶卷、QQ/微信图片',
                fmtCount(S.suggest.length) + ' built-in folders are not in the list yet')),
            h('span', { class: 'spacer' }),
            h('button', { class: 'btn sm', onclick: () => { addSuggestDirs(); } },
              icon('plus', 12), T('补充', 'Add'))
          ));
        }
        resetDirBtn.disabled = usingDefaults;
      }

      /* ---------- 扫描 ---------- */
      async function doScan(silent) {
        if (S.loading) return;
        S.loading = true;
        S.loaded = false;
        S.failed = false;
        render();

        const days = clampInt(S.days, 0, MAX_DAYS);
        const minKb = clampInt(S.minKb, 0, MAX_KB);
        const params = { days: days, min_kb: minKb, all_images: !!S.allImages };
        // 只有配置了自定义目录才传 dirs；空数组交给引擎用默认目录
        if (S.cfgDirs.length) params.dirs = S.cfgDirs.slice();

        let res;
        try {
          if (silent) res = await API.engine('shots.scan', params);
          else res = await busy(() => API.engine('shots.scan', params), T('正在扫描截图…', 'Scanning screenshots…'), 'shots');
        } catch (e) {
          toast(errText(e), 'error');
          S.failed = true;
        } finally {
          S.loading = false;
          S.loaded = true;
        }

        if (!res) { render(); renderDirs(); return; }
        if (res.error) {
          toast(res.error, 'error');
          S.failed = true;
          render();
          renderDirs();
          return;
        }

        S.items = Array.isArray(res.items) ? res.items : [];
        S.effDirs = Array.isArray(res.dirs) ? res.dirs : [];
        S.missing = Array.isArray(res.missing) ? res.missing : [];
        S.suggest = Array.isArray(res.suggest) ? res.suggest : [];
        S.page = 1;

        sizeMap.clear();
        S.items.forEach((it) => sizeMap.set(it.path, Number(it.size) || 0));

        // 重扫后剔除已不存在的选中项
        const alive = new Set(S.items.map((it) => it.path));
        Array.from(S.selected).forEach((p) => { if (!alive.has(p)) S.selected.delete(p); });

        renderDirs();
        render();
        await saveOptions();
        if (!silent) {
          toast(T('扫描完成：' + fmtCount(S.items.length) + ' 张，共 ' + fmtBytes(sumSize()),
            'Scan finished: ' + fmtCount(S.items.length) + ' files, ' + fmtBytes(sumSize())), 'ok');
        }
      }

      function sumSize() {
        return S.items.reduce((n, it) => n + (Number(it.size) || 0), 0);
      }

      /* ---------- 清理 ---------- */
      /**
       * 清理一组路径。quiet = 不要 busy 遮罩（从预览层里调用时，遮罩会被压在下面）。
       * 返回 true 表示引擎执行成功（可能有部分失败）。
       */
      async function cleanPaths(paths, { quiet = false } = {}) {
        if (!paths || !paths.length) {
          toast(T('没有选中截图', 'Nothing selected'), 'warn');
          return false;
        }
        const size = paths.reduce((n, p) => n + (sizeMap.get(p) || 0), 0);

        let ok = false;
        try {
          ok = await confirm({
            title: T('清理截图', 'Clean screenshots'),
            body: T('把选中的 ' + fmtCount(paths.length) + ' 个文件（' + fmtBytes(size) + '）移入回收站？', 
              'Move the selected ' + fmtCount(paths.length) + ' file(s) (' + fmtBytes(size) + ') to the recycle bin?'),
            ok: T('移入回收站', 'Move to recycle bin'),
            danger: true
          });
        } catch (e) {
          toast(errText(e), 'error');
          return false;
        }
        if (!ok) return false;

        let res;
        try {
          const run = () => API.engine('shots.clean', { paths: paths, confirm: true, all_images: !!S.allImages });
          res = quiet ? await run() : await busy(run, T('正在移入回收站…', 'Moving to the recycle bin…'), 'shots');
        } catch (e) {
          toast(errText(e), 'error');
        }
        if (!res) return false;
        if (res.error) { toast(res.error, 'error'); return false; }

        const failed = Array.isArray(res.failed) ? res.failed : [];
        const failedSet = new Set(failed.map((f) => f && f.path).filter(Boolean));
        const doneSet = new Set(paths.filter((p) => !failedSet.has(p)));

        // 成功的从本地数据里剔除，避免再扫一次
        S.items = S.items.filter((it) => !doneSet.has(it.path));
        doneSet.forEach((p) => S.selected.delete(p));

        if (failed.length) showFailures(failed);

        const freed = Number(res.freed);
        toast(T(
          '已移入回收站 ' + fmtCount(doneSet.size) + ' 张' +
            (isFinite(freed) && freed > 0 ? '，释放 ' + fmtBytes(freed) : '') +
            (failed.length ? '，' + fmtCount(failed.length) + ' 张失败' : ''),
          'Moved ' + fmtCount(doneSet.size) + ' files to the recycle bin' +
            (isFinite(freed) && freed > 0 ? ', freed ' + fmtBytes(freed) : '') +
            (failed.length ? ', ' + fmtCount(failed.length) + ' failed' : '')
        ), failed.length ? 'warn' : 'ok');

        render();
        return true;
      }

      async function doCleanSelected() {
        if (!S.selected.size) {
          toast(T('先勾选要清理的截图', 'Select screenshots first'), 'warn');
          return;
        }
        await cleanPaths(Array.from(S.selected), { quiet: false });
      }

      /* 失败清单弹窗：内容可能很长，但弹窗自身会随内容撑高，不额外套滚动 */
      function showFailures(failed) {
        const rows = failed.slice(0, 300);
        const body = h('div', { class: 'list' },
          ...rows.map((f) => h('div', { class: 'list-item' },
            h('div', { class: 'stack', style: { gap: '0', minWidth: '0' } },
              h('div', { class: 'mono small ellipsis', title: f.path || '' }, f.path || '—'),
              f.why ? h('div', { class: 'small muted' }, f.why) : null
            )
          ))
        );
        modal({
          title: T('有 ' + fmtCount(failed.length) + ' 张没能清理', fmtCount(failed.length) + ' files were not cleaned'),
          body: body,
          wide: true,
          buttons: [{ id: 'ok', label: T('关闭', 'Close'), kind: 'primary' }]
        });
      }

      /* ---------- 小工具 ---------- */
      function revealPath(p) {
        API.reveal(p).catch((e) => toast(errText(e), 'error'));
      }

      const copyText = UI.copy;

      /* ---------- 初始化：先读配置，再静默扫描一次 ---------- */
      try {
        const cfg = await API.configGet();
        if (cfg) {
          if (Array.isArray(cfg.shot_dirs)) {
            S.cfgDirs = cfg.shot_dirs.filter((d) => typeof d === 'string' && d.trim());
          }
          if (cfg.shot_days !== undefined) S.days = clampInt(cfg.shot_days, 0, MAX_DAYS);
          if (cfg.shot_min_kb !== undefined) S.minKb = clampInt(cfg.shot_min_kb, 0, MAX_KB);
          if (cfg.shot_all_images !== undefined) S.allImages = !!cfg.shot_all_images;
          if (typeof cfg.shot_last_path === 'string') S.lastPath = cfg.shot_last_path;
        }
      } catch (e) {
        toast(errText(e), 'error');
      }
      daysInput.value = String(S.days);
      kbInput.value = String(S.minKb);
      allImagesCb.checked = !!S.allImages;
      renderDirs();
      render();
      await doScan(true);
    }
  };
})();
