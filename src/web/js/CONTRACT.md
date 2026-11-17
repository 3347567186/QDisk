# 页面模块契约（Tauri 正式版）

所有页面是独立文件，注册到 `window.Pages`，由 `app.js` 路由调用。**不要修改**除自己负责的
`web/js/pages/*.js` 以外的文件。

## 注册方式

```js
window.Pages = window.Pages || {};
window.Pages.shots = {
  title: ['清理截图', 'Screenshots'],   // [中文, English]
  async mount(root) {
    // root 是一个空的 <div class="page-body">，每次进入页面都会重建
    root.appendChild(h('div', { class: 'card' }, '...'));
  }
};
```

- `mount` 可重复调用，不需要手动清理（root 每次都是新的）。
- 所有异步调用都要 try/catch，失败用 `UI.toast(err.message, 'error')`。
- 长时间操作使用 `UI.busy(async () => { ... })`，它负责遮罩与异常提示。

## 可用全局

- `API.engine(method, params)` → Promise<any>，调用 Python 引擎 24 个 RPC 方法之一。
- `API.pickFolder(start?)`、`API.saveText(name, content)`、`API.reveal(path)`、`API.openPath(path)`。
- `API.configGet()` / `API.configSet(patch)`：应用配置（theme/lang/close_action/last_folder/scheduled）。
- `API.getAutostart()` / `API.setAutostart(bool)` / `API.scheduleSet(enabled,time,folder)` / `API.scheduleGet()`。
- `API.logList()` / `API.logRead(path)` / `API.logClear()` / `API.logLine(level,msg)`。
- `UI.h(tag, attrs, ...children)`：创建元素；attrs 支持 `class`、`text`、`html`、`onclick`、`dataset`、`style`。
- `UI.T(zh, en)`：按当前语言返回文案。
- `UI.fmtBytes(n)`、`UI.fmtCount(n)`、`UI.fmtTime(unixSec)`、`UI.fmtDateTime(isoString)`。
- `UI.toast(msg, kind)`：kind = info | ok | warn | error。
- `UI.confirm({title, body, ok, danger})` → Promise<bool>。
- `UI.busy(fn, label?)`：显示遮罩执行 fn，异常自动 toast 并返回 undefined。
- `UI.skeleton(rows)`：骨架屏节点。
- `UI.empty(text, sub?)`：空态节点。
- `UI.card(title?, ...children)`：卡片容器。
- `UI.table({columns, rows, rowKey?})`：columns = [{key,label,width,align,render(row)}]。
- `UI.icon(name, size?)`：内置 SVG 图标（organize/shots/cache/search/rules/apps/migrate/log/settings/folder/file/refresh/play/trash/undo/close/check）。
- `UI.state`：`{ lang: 'zh-CN'|'en-US', theme: 'light'|'dark' }`。
- `UI.onLangChange(fn)`：语言切换时回调（一般不需要）。

## 第二轮改版：布局 / 折叠 / 右键菜单（必须遵守）

### 布局

- 页面内容由 `#scroll` 统一滚动，**页面自己不要再套 overflow:auto**，也不要写死高度。
- 页面根 `page-body` 是 `flex column`，横向用 `.grid-2` / `.grid-3` / `.row`（自动换行，窄窗自动堆叠）。
- 宽度不要写死 px；用 `minmax(0,1fr)`、`flex:1`、`gap` 撑满可用区域。**禁止大片留白**。
- 每个页面最多 3 个顶层区块；超过就折叠进 `UI.section`。

### 折叠区块

```js
UI.section(T('扫描条件','Scan options'), bodyNode, { open: true, hint: T('...','...'), id: 'opts' });
```

- `open` 默认 false，重要区块才 true；用户点击标题展开/收起。
- 高频操作放顶层（不折叠），低频参数放 section 里。

### 右键菜单（每个页面必须有）

```js
UI.attachMenu(listNode, (e) => {
  const row = e.target.closest('[data-path]');
  if (!row) return [];
  const p = row.dataset.path;
  return [
    { header: p },
    { label: T('打开所在目录','Open folder'), icon: 'folder', action: () => API.reveal(p) },
    { label: T('复制路径','Copy path'), icon: 'copy', action: () => navigator.clipboard.writeText(p) },
    { sep: true },
    { label: T('删除','Delete'), icon: 'trash', danger: true, action: async () => { ... } },
  ];
});
```

- 菜单项：`{label, icon?, danger?, disabled?, action}`、`{sep:true}`、`{header:'文本'}`。
- 全局已拦截 `contextmenu`（输入框/文本域除外），系统右键菜单不会出现。
- 空白区域也要给菜单（至少「刷新」「全选」「回到顶部」）。

### 图片预览

```js
UI.preview({ items: [{ path, name, url? }], index, title: '截图' });
```

- 自带 ←/→、Esc、滚轮缩放、+/-、定位、底部缩略点。
- `url` 不给时内部用 `convertFileSrc(path)`；加载失败回退「打开文件」。

### 文本选择

- 全局 `user-select:none`，只有 `input/textarea/[contenteditable]` 可选中；需要可复制的展示文本用 `<code class="selectable">` 或内容用 `UI.modal`（其 body 允许选中）。

### 引擎方法速查

| method | 参数 | 返回 |
|---|---|---|
| `ping` | {} | `{ok:true,pong:...}` |
| `settings.get` | {} | `{data_dir,cache_dir,conflict_policy,recursive_depth,default_recursive,default_content,log_keep_days,close_action,tray_pin,settings_path}` |
| `settings.set` | part of above | 保存后的 settings |
| `scan` | `{path, recursive?, content?, by_date?, exclude_exts?, exclude_dirs?}` | `{plans:[{folder,groups:[{name,files:[{name,size,mtime}]}],blocked?}],blocked:[...],total,total_size,applied}` |
| `organize` | `{path, dry_run?, conflict?, by_date?, recursive?}` | `{moved,failed:[],total,history,blocked}` |
| `undo` | `{path}` | `{restored,failed:[],history}` |
| `files.delete` | `{paths:[...]}` | `{deleted,failed:[]}` |
| `shots.scan` | `{dry_run?, dirs?}` | `{items:[{path,name,size,mtime,thumb?}],total,total_size,dirs,missing}` |
| `shots.clean` | `{paths?/items?}` | 清理结果 |
| `cache.list` | `{}` | `{groups:[{name,level,items:[{path,label,size,exists,level,item_id,note}]}]}` |
| `cache.clean` | `{ids:[...]}` | `{freed,failed:[]}` |
| `apps.list` | `{}` | `{items:[{name,version,publisher,install_path,icon,uninstall}]}` |
| `apps.uninstall` | `{name}` | 结果 |
| `apps.leftovers` | `{names?}` | 残留列表 |
| `apps.cleanup` | `{paths:[...]}` | 清理结果 |
| `search.status` | {} | `{index_path,indexed,roots,built_at,backend}` |
| `search.index` | `{roots:[...],rebuild?}` | 索引结果 |
| `search.query` | `{q,limit?,offset?}` | `{items:[...],total}` |
| `rules.validate` | `{path}` | 校验结果 |
| `rules.preview` | `{path, dest?}` | 预览结果 |
| `rules.run` | `{path, dest?, dry_run?}` | 执行结果 |
| `migrate.plan` | `{sources:[...], target}` | 计划 |
| `migrate.apply` | `{sources,target,conflict?}` | 执行结果 |

参数名必须与上表一致（引擎对缺失参数会报「参数 xxx 必须是非空字符串」）。不确定返回结构时，
先用管道直接问引擎：

```powershell
$py='E:\AI\DeepSeekHarness多插件版\home\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe'
# 见 web/js/pages/_probe.py 模板，或直接参考 tidy.py 中 _engine_* 函数
```

## 视觉规范

- 白色为主、黑色为辅，强调色只用于关键操作；不使用 emoji；图标用 `UI.icon`。
- 圆角/间距/颜色一律用 `web/styles.css` 里的 CSS 变量（`--radius-*`、`--space-*`、`--text-*`、`--bg-*`）。
- 每个交互元素要有 hover / active / focus-visible 过渡；列表整体过渡，不逐行动画。
- 文案精简，中文与英文都要写（`UI.T('中文','English')`）。

## 页面要点（与 WPF 对齐）

- **organize**：选择文件夹、递归/按内容/按日期/冲突策略、扫描预览（分组可折叠、全选/反选/清空、跳过详情）、开始整理、撤销上次、导出 CSV、打开/定位文件。
- **shots**：扫描截图目录、按大小排序、勾选、预览（大图弹层）、清理到回收站、显示释放空间。
- **cache**：缓存分组、勾选、按等级标注 safe/caution/advanced、预计释放空间、清理、结果汇总。
- **search**：索引状态、选择索引根目录、建立/重建索引、关键词搜索、结果分页、定位文件。
- **rules**：规则文件（JSON）编辑、校验、预览、执行、执行报告。
- **apps**：已安装程序列表、搜索过滤、卸载、残留扫描、残留清理。
- **migrate**：源目录多选、目标目录、冲突策略、预演计划、执行、结果汇总。
- **log**：日志文件列表（Rust 侧 `app-*.log`）、内容查看、刷新、清空、打开日志目录。
- **settings**：主题、语言、关闭行为、数据目录、递归深度、冲突策略、日志保留、开机自启、定时整理、关于。
