# 页面模块契约（Tauri 正式版）

<!-- 底层开发者信息：白林 (Type) <3347567186@qq.com>（是个帅气的男孩；仅供二次开发与 AI 助手内部参考，UI 界面不展示开发者信息） -->

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

- `API.engine(method, params)` → Promise<any>，调用 Python 引擎 43 个 RPC 方法之一。
- `API.pickFolder(start?)`、`API.saveText(name, content)`、`API.reveal(path)`、`API.openPath(path)`。
- `API.configGet()` / `API.configSet(patch)`：应用配置（theme/lang/close_action/last_folder/scheduled）。
- `API.getAutostart()` / `API.setAutostart(bool)` / `API.scheduleSet(enabled,time,folder)` / `API.scheduleGet()`。
- `API.logList()` / `API.logRead(path)` / `API.logClear()` / `API.logLine(level,msg)`。
- `UI.h(tag, attrs, ...children)`：创建元素；attrs 支持 `class`、`text`、`html`、`onclick`、`dataset`、`style`。
- `UI.T(zh, en)`：按当前语言返回文案。
- `UI.fmtBytes(n)`、`UI.fmtCount(n)`、`UI.fmtTime(unixSec)`、`UI.fmtDateTime(isoString)`。
- `UI.toast(msg, kind)`：kind = info | ok | warn | error。
- `UI.confirm({title, body, ok, danger})` → Promise<bool>。
- `UI.busy(fn, label?, kind?)`：并发引用计数安全遮罩执行 `fn(ctrl)`，支持 `ctrl.setText`/`ctrl.setSub`/`ctrl.setProgress(0..100)` 与超时耗时感知，异常自动 toast 并返回 undefined。
- `UI.withButtonBusy(btn, busyLabel, fn)`：按钮级防重入禁用 + 迷你旋转图标等待态，结束必还原。
- `UI.progressModal({ title, initialText, initialSub, kind })`：不可误关的多阶段进度弹窗（用于数据目录统一迁移等持久化关键任务）。
- `API.dataDirMigratePreview(targetDir)` / `API.dataDirMigrate(targetDir)`：数据目录统一准入校验、一次性迁移与自动重启生效。
- `UI.skeleton(rows)`：骨架屏节点。
- `UI.empty(text, sub?)`：空态节点。
- `UI.card(title?, ...children)`：卡片容器。
- `UI.table({columns, rows, rowKey?})`：columns = [{key,label,width,align,render(row)}]。
- `UI.icon(name, size?)`：内置 SVG 图标（organize/shots/cache/search/rules/apps/migrate/log/settings/folder/file/refresh/play/trash/undo/close/check）。
- `UI.state`：`{ lang: 'zh-CN'|'en-US', theme: 'light'|'dark' }`。
- `UI.onLangChange(fn)`：语言切换时回调（一般不需要）。

## 第二轮改版与 1.43.0 三大布局骨架及全页生命周期契约（必须遵守）

### 布局与生命周期

- 页面内容由 `#scroll` 统一滚动，**页面自己不要再套内部全页嵌套滚动**（`.log-viewer-pre` 等局部代码/日志查看器除外），也不要写死像素高度。
- 页面排版必须归属以下三大标准骨架之一，禁止散装全宽堆叠或未登记临时类名：
  1. **骨架 I · 分段定高工作台**：`.wb-bar` + `.wb-tabs` + `.wb-tab` + `.wb-pane` + `.card.stretch-card`（如 `tools`、`apps`、`shots`、`cache`、`archive`、`search`）。
  2. **骨架 II · 双栏主从工作台**：`.split-wb` / `.split-wb.master-detail`（左栏编辑器/清单，右栏 `.log-viewer-pre`/预演面板；如 `rules`、`log`、`migrate`），窄屏 `<= 980px` 自动降级单列。
  3. **骨架 III · 紧凑流式配置工作台**：`.set-card` + `.set-row`（`settings`，已移除 `.set-nav-bar` 与设置页 AI 入口）。
- 全部业务页（不含 `ai` 整页对话与 `settings` 设置页）在 `mount(root)` 内按需调用 `UI.setActions()` 与面板内 `UI.askBtn({...})` 挂载 AI 副驾入口；`mount(root)` 必须返回 `unmount()` 并在其中清理定时器、`document` 监听、`App._onPageSize` 与 `UI.setActions()`；同时导出 `jump(payload)` 接收来自 AI / 页间跳转的上下文。

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

## 引擎方法速查（完整 37 个 RPC 方法）

| method | 参数 | 返回 / 说明 |
|---|---|---|
| `ping` | `{}` | `{ok: true, pong: ...}` 心跳检测 |
| `settings.get` | `{}` | 完整 settings 对象与路径 |
| `settings.set` | `{patch...}` | 局部更新 settings 并落盘 |
| `scan` | `{path, recursive?, content?, by_date?, exclude_exts?, exclude_dirs?}` | 扫描目录整理计划 `{plans, blocked, total, total_size, applied}` |
| `organize` | `{path, dry_run?, conflict?, by_date?, recursive?}` | 执行整理操作 `{moved, failed: [], total, history, blocked}` |
| `undo` | `{path?}` | 撤销上一次整理 `{restored, failed: [], history}` |
| `files.delete` | `{paths: [...]}` | 批量安全删除文件（送回收站）`{deleted, failed: []}` |
| `shots.scan` | `{dirs?, keep_days?, min_kb?}` | 截图目录扫描 `{items, total, total_size, dirs, missing}` |
| `shots.thumb` | `{path, size?, force?}` | 获取单张截图的高性能 PNG 缩略图（Base64 或缓存路径） |
| `shots.clean` | `{paths?: [...], items?: [...]}` | 清理选中的截图到回收站 |
| `cache.list` | `{}` | 扫描各类系统及应用缓存目录分组 `{groups: [...]}` |
| `cache.clean` | `{ids: [...]}` | 清理选中的缓存条目 `{freed, failed: []}` |
| `clean.auto` | `{}` | 一键安全自动清理（系统临时文件 + 过期缓存）`{freed, deleted_count, details}` |
| `apps.list` | `{refresh?}` | 枚举已安装应用程序列表 `{items: [...], total}` |
| `apps.icons` | `{sources: [...]}` | 批量提取/生成应用图标缓存 `{icons: {src: png_path}}` |
| `apps.uninstall` | `{name, version?, mode?}` | 调用应用卸载命令并返回执行状态 |
| `apps.registry` | `{name}` | 查询应用在注册表 Uninstall 中的原始键值信息 |
| `apps.delete_entry` | `{key}` | 删除无效/残留的卸载注册表项 |
| `apps.force_remove` | `{name}` | 强制移除软件记录与残留目录 |
| `apps.leftovers` | `{name, version?}` | 深度扫描软件卸载残留的磁盘目录与注册表项 `{name, dirs, regs, blocked}` |
| `apps.cleanup` | `{paths: [...]}` | 清理选中的残留目录与注册表 `{freed, failed}` |
| `startup.list` | `{refresh?}` | 扫描系统自启动项（注册表与启动目录），标记启用/失效状态 `{total, enabled_count, disabled_count, broken_count, items}` |
| `startup.toggle` | `{name, kind?, location?, file_path?, enable?}` | 安全切换自启动启用/禁用（写入 StartupApproved 或软重命名） `{ok, enabled, name, kind, location, file_path, new_file_path?}` |
| `startup.delete` | `{name, kind?, location?, file_path?}` | 清理自启动配置项或失效快捷方式（自动兼容 `.disabled` 快捷方式） `{ok, name, deleted}` |
| `process.list` | `{aggregate?, search?}` | `{items:[{name,clean_name,pids,process_count,threads,memory,exe_path,is_system}],total_count,raw_count,total_memory}` 毫秒级进程快照 |
| `process.close` | `{pid?, name?, force?}` | `{ok,was_running,closed,name,detail}` 协同释放占用文件的进程（严格正则校验与系统核心白名单保护） |
| `system.performance` | `{}` | `{timestamp,drives,disk_summary,disk_io,network_io,memory,cpu}` 系统磁盘、内存、I/O 与 CPU 实时负载快照 |
| `search.status` | `{}` | 查询索引服务整体状态、索引数量、覆盖目录及数据库信息 |
| `search.drives` | `{}` | 动态识别本机全部主要本地固定磁盘（跳过 U 盘/光驱/网络盘/subst 映射盘/恢复分区）并返回索引覆盖态 |
| `search.index` | `{roots?, ids?, reuse?, full?, all_main_drives?}` | 触发一次索引建立或增量扫描（支持逐盘复用健康库与 `all_main_drives` 全主要盘一键覆盖） |
| `search.query` | `{q, limit?, ids?}` | 关键词与完整路径实时搜索（支持未索引绝对路径磁盘直出精确命中 `{source:'direct'}`） `{items: [...], total, source, hint?}` |
| `search.top` | `{limit?, min_size?}` | 基于 SQLite 索引查询超大文件排行榜 `{items, total, source, roots}` |
| `search.folders` | `{depth?, limit?, min_size?, parent?, auto?, ids?}` | 目录空间占用聚合统计分析 `{items, total, bytes, source}` |
| `search.add` | `{paths: [...]}` | 向搜索索引库中添加监控根目录 |
| `search.remove` | `{ids: [...]}` | 从搜索索引库中移除指定根目录 |
| `search.selfcheck` | `{rebuild?}` | 索引数据库自检、坏块检测与自动修复重建 |
| `search.hot` | `{force?}` | 快速扫描热点目录（下载、桌面等）刷新增量索引 |
| `prune.run` | `{force?}` | 维护引擎本地历史、日志及缩略图缓存磁盘占用 |
| `rules.validate` | `{text? / path?}` | 校验整理规则 YAML/JSON 语法与安全性 |
| `rules.preview` | `{text? / path?, folder?, simulate?}` | 预演规则在目标目录上的匹配与归类动作 |
| `rules.run` | `{text? / path?, folder?, simulate?}` | 执行规则整理并返回执行报告 |
| `rules.explain` | `{path, folder?}` | 解释某个文件命中或被拦截的具体规则链路及原因 |
| `migrate.plan` | `{sources: [...], destination, mode?, conflict?}` | 分析搬家任务，构建迁移任务计划与冲突预检 |
| `migrate.apply` | `{sources, destination, mode?, conflict?, confirm, id?}` | 执行迁移或搬家操作，支持跨盘移动与进度记录 |

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

## 全部 12 页模块要点与 AI Agent 融合契约

> 所有改动须遵守 `docs\01-当前版\开发强约束与扩展规范手册.md`。AI 助手当前共开放 **26 个只读/导航工具**（`AIPrompt.TOOLS`）与 **25 个审批动作**（`AIRegistry`）。

- **ai**：整页对话（Linear 风格：13 px 正文、查证过程默认收起、只用一种强调色），`navigate` 支持全 12 页直达与别名跳转（`clean` / `screenshots` / `logs` / `processes` / `startup` / `overview` / `resources` / `footprint`）；V2 免费模型同源池扩展 + 单 slug 指数冷却 + HTTP 200 空回复换源；V3 本地 Ollama 确定性尾备。
- **organize**：选择文件夹/文件、三档预设（标准 / 全部文件 / 谨慎）、扫描预览、开始整理、撤销上次、导出 CSV、顶栏 `UI.askBtn`。
- **shots**：扫描截图目录、按大小/时间排序、类型筛选、勾选预览、清理到回收站、顶栏 `UI.askBtn`、支持 `jump({ days, kind, action })`。
- **cache**：`.card-title` 紧凑概览卡 + 分级（safe/caution/advanced）分组清理、顶栏 `UI.askBtn`、支持 `jump({ action: 'safe' | 'recommended' | 'scan' })`。
- **tools**：骨架 I 分段工作台（`.wb-bar` 切换「超大文件 / 空文件夹 / 目录浏览」）、顶栏焦距感知 `UI.askBtn`、支持 `jump({ tab, dir, action })`。
- **archive**：打开 / 解压 / 创建 / 预览压缩包、Esc 预览销毁清理、顶栏 `UI.askBtn`、支持 `jump({ paths })`。
- **search**：索引状态、多目录管理、关键词搜索、分页底栏、顶栏 `UI.askBtn`、支持 `jump({ q })`。
- **rules**：骨架 II 双栏工作台（`.split-wb`：左栏 YAML 编辑器、右栏校验 + 预演 + 运行报告）、顶栏 `UI.askBtn`、支持 `jump({ yaml, folder })` 与 `rules.draft` 提案写入。
- **apps**：已安装程序 / 开机自启（对接 `Run32` 与 `StartupFolder`、过滤 `desktop.ini`）/ 后台进程（`process.list`/`process.close` 整树终止 + 复生复核 + 轻盘自身进程树保护）/ 资源概览（`system.performance` PDH 物理磁盘 I/O + 物理网卡去重 + 4 KPI 卡），切页销毁 0 定时器与监听器泄漏，顶栏 `UI.askBtn`、支持 `jump({ tab, status, filter })`。
- **migrate**：合顶命令与目标目录条 + 平衡双栏（来源 vs 选项）、`planSlot`/`resultSlot` 局刷不丢输入焦点、顶栏 `UI.askBtn`、支持 `jump({ sources, destination })`。
- **log**：骨架 II 主从双栏（`.split-wb.master-detail` 文件清单 + `.log-viewer-pre` 尾部查看器 + 引擎诊断与操作历史双列）、顶栏 `UI.askBtn`、支持 `jump({ file })`。
- **settings**：骨架 III 7 个手风琴分组（含 AI 助手模型/端点/密钥/权限配置，移除顶部 `.set-nav-bar` 与设置页 AI 入口；在线更新支持 `API.updaterAutoUpdate` 一键切换至融合轻盘 Logo 的独立进度弹窗 `updater.html` 全自动静默升级并重启）、支持 `jump({ section })`。
