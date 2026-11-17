# 整理助手：Windows 原生框架迁移方案与功能映射

> 配套：`UI重设计_设计规范.md`、`UI重设计_逐页方案.md`。
> 本文覆盖：框架选型、目标架构、进程与 IPC、关键实现、打包发布、迁移阶段、功能映射总表、风险、待补充项。
> 文中标「待确认」的项见第 10 节；第 1 节的选型是推荐值，改动会影响后续工期与部署方式。

---

## 1 框架选型

### 1.1 候选对比

| 维度 | WPF（.NET 8） | WinUI 3（Windows App SDK） | Win32 / C++ |
|---|---|---|---|
| 是否 Windows 原生 | 是，系统控件与标准窗口行为 | 是，Fluent 设计语言最新 | 最彻底 |
| 本机可立即构建 | 是（.NET SDK 10.0.202，可目标 net8.0-windows；Windows SDK 10.0.26100 已装） | 需引入 Windows App SDK NuGet 与 MSIX/未打包部署，本机无缓存 | 需完整 C++ 工具链与自绘控件 |
| 控件丰富度 | 高（ListView/DataGrid/TreeView/ContextMenu/StatusBar 齐全） | 高，但 ListView 细节与 WPF 不同 | 低，全部自绘 |
| 大列表性能 | 虚拟化成熟，10 万行可流畅 | 成熟 | 需自己实现 |
| 视觉现代度 | 传统 Win32 观感，可定制到接近 Fluent | 原生 Mica/圆角/Fluent | 取决于实现 |
| 托盘/注册表/计划任务 | 全部可直接做（P/Invoke 或 WinForms 互操作） | 需额外包 | 直接 |
| 部署 | self-contained 文件夹发布，无需装运行时 | 需 Windows App SDK 运行时或自包含 | 单 exe，但体积大 |
| 交付速度 | 最快（本机零依赖） | 慢（依赖拉取与打包调试） | 最慢 |

### 1.2 推荐：WPF on .NET 8（x64，self-contained）

理由：

1. 目标明确是「工具型、快捷、简洁、高效」，不是要最新 Fluent 视觉；WPF 能准确实现本设计（32px 行高、系统控件、键盘优先），且交互行为与 Windows 桌面用户预期一致。
2. 本机已具备 SDK 与 Windows SDK，可当天开始实现；WinUI 3 需要拉 NuGet、处理 WinAppSDK 运行时与打包，前期成本高。
3. 大列表（搜索 128 万文件、缓存 43 项、文件预览上千行）依赖成熟虚拟化，WPF 的 `VirtualizingStackPanel + Recycling` 足够。
4. 托盘、注册表、计划任务、单实例、文件夹选择器都有稳定做法（见第 4 节）。
5. 后续若要把视觉升级为 Fluent/Mica，可局部替换窗口边框与主题资源，不必推翻结构。

若你选 WinUI 3：整体布局、组件与键盘设计不变，需要替换的只有窗口外壳、控件样式与部署方式；工期预计 +30%~50%，主要花在 Windows App SDK 打包与控件行为差异上。

---

## 2 目标架构

### 2.1 推荐架构：WPF 前端 + 现有 Python 引擎（进程内桥接，不重写业务）

```
┌──────────────────────────── 整理助手.exe（WPF, .NET 8）────────────────────────────┐
│  Views（8 页） · ViewModels · DesignTokens（资源字典） · Services                   │
│  ├─ EngineClient   命名管道 JSON-RPC（请求/响应/进度/取消）                          │
│  ├─ SettingsService  读写 settings.json（与现格式一致）                               │
│  ├─ ShellService   托盘、单实例、资源管理器菜单、计划任务、开机自启                    │
│  └─ DialogService  确认/迁移/卸载五道确认                                             │
└───────────────────────────────────────┬─────────────────────────────────────────────┘
                                        │ 命名管道（本机，UTF-8，一行一条 JSON）
┌───────────────────────────────────────┴─────────────────────────────────────────────┐
│ 引擎进程 引擎\整理助手引擎.exe（PyInstaller 打包的 tidy.py 入口，--engine 模式）       │
│  复用现有 tidy.py：scan / scan_tree / apply / undo / 截图 / 缓存 / 规则 / 卸载        │
│  / 搜索索引 / 迁移 / 设置 / 校验；migrate_engine.py 原样保留                          │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

为什么保留 Python 引擎：现版本 9800 行业务逻辑（分类规则、20 类内容识别、软件/代码/源码目录判定、76 个不下钻目录、卸载黑名单、缓存 43 项边界、迁移回滚、搜索索引）都经过实测与事故复盘；全部重写会成为「功能不删」验收的最大风险。前端换原生框架 + 引擎保持现状，是唯一能在合理周期内做到功能零缺失的路径。

### 2.2 备选架构（若确认「必须纯原生单栈」）

全 C# 重写：按现有模块逐个移植（建议顺序：设置/数据目录 → 扫描+分类 → 整理+撤销 → 搜索索引 → 缓存 → 截图 → 迁移 → 卸载 → 高级规则）。风险与工期：至少 2~3 倍，且需要重建 54 例测试与 GUI 回归；本方案不推荐，仅在明确要求时启用。

### 2.3 引擎桥接的接口面（按现有函数一一对应）

| RPC 方法 | 对应现函数 | 返回 |
|---|---|---|
| `settings.get` / `settings.save` | load_settings / save_settings | 设置对象 / 是否成功 |
| `dir.validate` | check_data_dir | null 或中文原因 |
| `locator.read` / `locator.write` | read_data_locator / write_data_locator | 路径与状态 |
| `scan.preview` | scan / scan_tree | 分组树 + 文件项（进度事件） |
| `organize.apply` | apply | 结果计数 + 历史文件路径 |
| `organize.undo` | undo | 撤销结果 |
| `preview.export` | 现 CSV 导出逻辑 | 文件路径 |
| `shots.scan` / `shots.clean` | 截图扫描/清理 | 项列表 / 删除结果 |
| `cache.scan` / `cache.clean` | 缓存扫描/清理 | 43 项与级别 / 清理结果 |
| `rules.load` / `rules.check` / `rules.run` | run_rules / check_rules | 校验或执行结果 |
| `apps.list` / `apps.uninstall` / `apps.force` | list_installed_apps / 卸载流程 | 程序列表 / 结果 |
| `apps.registry` / `apps.backup` / `apps.export` | 上述辅助函数 | 路径 |
| `index.build` / `index.search` / `index.status` | 搜索索引 | 进度 / 结果 / 统计 |
| `migrate.preview` / `migrate.run` / `migrate.undo` / `migrate.history` | 迁移引擎 | 计划 / 进度 / 结果 |
| `shell.open` / `shell.reveal` | os.startfile / explorer | — |
| `task.create` / `task.delete` / `task.status` | schtasks 封装 | 状态 |

进度事件格式：`{"type":"progress","id":7,"done":1204,"total":1940,"msg":"正在移动"}`；取消：`{"type":"cancel","id":7}`；引擎在安全点检查取消，回传 `cancelled`。

---

## 3 进程与可靠性

| 主题 | 方案 |
|---|---|
| 启动 | 主进程先起；首次调用引擎时才启动引擎进程（约 1~2 秒冷启动，期间状态栏显示「正在准备引擎…」） |
| 通信 | `NamedPipeServerStream`（WPF）+ `NamedPipeClientStream`（引擎）；JSON Lines，UTF-8，单请求单响应，进度为独立行 |
| 超时 | 连接 10 s；单请求默认 30 s，长任务由进度事件续期；超时提示可重试 |
| 崩溃 | 引擎退出时 WPF 探活并提示「引擎已退出，正在重启」；自动重启 1 次，仍失败则引导「查看日志」 |
| 单实例 | 全局互斥量 `Global\整理助手`；第二次启动把参数（`--path` / `--page`）转发给已运行实例后退出 |
| 日志 | 引擎日志沿用现有位置与格式；WPF 日志写 `数据\logs\ui-YYYYMMDD.log`；两处都可在「查看日志」打开 |
| 权限 | 需要管理员的操作（卸载 HKLM、清理 Program Files、系统缓存项）由引擎在提权进程中执行；WPF 通过「以管理员身份重启」启动整体提权实例 |
| 退出 | 有运行中任务时提示；`--tray` 启动时静默进托盘 |

---

## 4 关键实现要点（WPF 侧）

| 能力 | 实现 |
|---|---|
| 系统文件夹选择 | `Microsoft.Win32.OpenFolderDialog`（.NET 8 提供），不用旧 `FolderBrowserDialog` |
| 大列表 | `ListView + GridView`，`VirtualizingPanel.IsVirtualizing=True`、`VirtualizationMode=Recycling`、`ScrollUnit=Pixel`；分组用 `CollectionViewSource` 或扁平化数据 |
| 表格排序 | `ICollectionView.SortDescriptions`；列头箭头用模板 |
| 主题与强调色 | `SystemParameters.WindowGlassColor` / `SystemParameters.HighContrast`；强调色取 `SystemParameters` 不可用时用注册表 `HKCU\Software\Microsoft\Windows\DWM\ColorizationColor` 的保守回退 `#0067C0` |
| 字体 | `Segoe UI Variable`（Windows 11）/ `Segoe UI`（Windows 10）回退链；等宽 `Cascadia Mono`→`Consolas` |
| 托盘 | `System.Windows.Forms.NotifyIcon`（WPF 项目引用 WinForms，零第三方依赖，避免新增许可风险）；菜单用 `ContextMenuStrip` |
| 资源管理器菜单 | 写 `HKCU\Software\Classes\{Directory,Folder,Drive}\shell\整理助手`，命令 `"整理助手.exe" --path "%1"`；与现版本键位一致 |
| 计划任务 | 用 `schtasks /Create /TN 整理助手_清理截图 ...` 保持任务名与现版本一致；查询用 `/Query /FO LIST` |
| 开机自启 | 沿用现三档（计划任务 `整理助手_开机自启` + 参数 `--tray`）；强模式带 `/RL HIGHEST` |
| 关窗询问 | 自定义模态窗口（三选一 + 记住）；回车/Esc/× 均按最小化到托盘 |
| 拖放 | 窗口级 `AllowDrop`；拖入文件夹 = 填充路径并提示扫描，拖入文件 = 数据迁移来源 |
| 高 DPI | 每显示器 DPI 感知（WPF 默认 `PerMonitorV2`，manifest 声明） |
| 崩溃兜底 | `AppDomain.UnhandledException` 与 `DispatcherUnhandledException` 写日志 + 对话框「复制错误信息」 |
| 设置迁移 | 直接读写现 `settings.json` 与 `数据位置.json`，字段名不变；旧版 Tkinter 与新 WPF 可互读（迁移期兼容） |
| 历史兼容 | 整理历史 JSON、迁移任务目录、索引库、日志目录路径全部沿用 |
| 安全 | 所有破坏性操作由引擎执行并重复一次黑名单校验；WPF 不自行拼路径删文件 |
| 加载策略 | 单例 `LoadingPolicy`（300 ms 显示阈值、120 ms 骨架延迟、1 s 补充说明、8 s 取消/重试）；所有加载组件读同一组常量，不散写魔法值。详见 `UI重设计_加载占位与反馈规范.md` |
| 加载组件实现 | Page Loader = `Grid` 遮罩 + `Ring` 弧动画；Skeleton = `Rectangle` 占位 + 真实尺寸绑定；Shimmer = `LinearGradientBrush` 的 `TranslateTransform` 动画（停用即停）；Spinner/Progress/Circular = `Path` + `DoubleAnimation`；Button Loader = `ContentPresenter` 内切换模板并锁定 `Width` |
| 三态动画 | 每页 `VisualStateManager` 定义 `Loading / Ready / Empty / Error` 四态；进入/切换/退出各一组 `Storyboard`；`SystemParameters.ClientAreaAnimation=false` 时统一切到纯淡入 |
| 防跳动 | 骨架与真实控件共用 `Grid` 列宽和行高常量；列表数据到达前后滚动锚点不重算（`ScrollViewer` 位置保留） |
| 反馈回执 | 每次保存/执行 300 ms 内必须有可见回执（行尾「已保存」/按钮成功态/状态栏短消息）；WPF 用 `DispatcherTimer` 统一驱动 |

---

## 5 工程结构与打包

```
D:\Tool\整理助手\
├─ 07_代码配置\            ← 现有 Python 引擎源码（不动业务逻辑，仅加 --engine 入口与 RPC 层）
├─ 09_原生客户端\          ← 新增
│  ├─ 整理助手.sln
│  ├─ 整理助手.App\        ← WPF 主程序（Views / ViewModels / Services / Themes）
│  ├─ 整理助手.EngineBridge\ ← 管道客户端、消息模型、进度与取消
│  └─ 整理助手.Tests\      ← ViewModel 单测 + 桥接契约测试
├─ 发布\
│  └─ 整理助手_b5_原生版_YYYYMMDD\
│     ├─ 整理助手.exe
│     ├─ _internal\        ← 引擎（PyInstaller onedir：tidy.py + 依赖）
│     ├─ 说明.md / 首次使用.txt / 第三方许可.txt / rules.json / icon.ico
│     └─ 数据\（首次运行生成）
└─ 开发文档\
```

发布方式：
- `dotnet publish -c Release -r win-x64 --self-contained true` 生成 WPF 文件夹（约 60~80 MB，无需用户装 .NET）；
- 引擎沿用现有 PyInstaller onedir（约 13 MB + `_internal`），与 WPF 目录同层；
- 整体压 zip，解压即用；`数据\` 不进包，首次运行生成；
- 版本号与构建时间写进程序集信息与「关于」对话框。

兼容性目标（待确认）：Windows 10 1809 及以上、Windows 11；x64。

---

## 6 迁移阶段与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 | 工程骨架、设计令牌、外壳（左栏/命令栏/状态栏）、8 页导航占位、单实例、日志 | 可启动、可切页、尺寸记忆、200% DPI 正常 |
| P1 | 引擎桥接 + 设置读写 + 数据目录（校验/迁移/指针/缺失告警）+ 选项浮层 | 设置页全量可用；数据目录改/存/否/是/告警与现版本行为一致（用现 4 条 GUI 用例验收） |
| P2 | 整理文件页（扫描/预览树/勾选/批量/删除/撤销/导出/监控/定时） | 与现版本同目录、同规则下扫描结果逐项一致；撤销可用；CSV 可导出 |
| P3 | 清理截图 + 清理缓存（含目录管理、自定义目录、定时任务） | 识别规则、43 项清单与级别、边界文案、清理结果与现版本一致 |
| P4 | 搜索文件（索引/搜索/重建/整盘/es.exe 优先）+ 数据迁移页 | 索引数量级与耗时同现版本；迁移预演/执行/取消/续跑/回滚全部通过 |
| P5 | 高级规则 + 卸载程序（含五道确认与黑名单） | 与现版本行为等价；18 条安全用例逻辑不变 |
| P6 | 托盘、右键菜单、开机自启、计划任务、打包与实测 | 三处系统集成往返验证与现版本一致；工作区外解压跑通；zip 交付 |

每阶段结束：`dotnet build` 无警告、单测通过、按阶段验收表逐条勾选、旧版仍可回退。

---

## 7 功能映射总表

> 「现实现」= tidy.py 内对应函数/页面；「新落点」= 本文档页号；「实现方式」= RPC 方法或 WPF 本地能力。所有行默认语义不变。

| # | 现有功能 | 现实现 | 新落点 | 实现方式 |
|---|---|---|---|---|
| 1 | 选择/输入文件夹 | pick_dir + Entry | 页1 路径行 | OpenFolderDialog + 拖放 |
| 2 | 扫描预览（分类树） | scan / scan_tree | 页1 主列表 | scan.preview |
| 3 | 包含子文件夹 + 递归深度 | 选项 + rules | 页1 选项浮层 | scan.preview 参数 |
| 4 | 跳过 10 分钟内 / 快捷方式 | 选项 | 页1 选项 | scan.preview 参数 |
| 5 | 按内容识别（20 类） | classify_content | 页1 选项 | engines 内部不变 |
| 6 | 强制整理（绕过程序/工程拦截） | 选项 | 页1 选项（带风险说明） | scan.preview 参数 |
| 7 | 按日期分目录 | date_target | 页1 选项 | organize.apply 参数 |
| 8 | 重名策略三选一 | resolve_dst | 页1 选项 / 页8 | 参数 |
| 9 | 开始整理 | apply | 页1 SplitButton | organize.apply |
| 10 | 撤销上次 | undo | 页1 更多 / 命令面板 | organize.undo |
| 11 | 导出预览 CSV | 现导出 | 页1 更多 | preview.export |
| 12 | 勾选（单个/整组/全选/反选/清空） | 现表格 | 页1 列表 | WPF 选择模型 |
| 13 | 批量移到回收站 / 永久删除 | 现按钮 | 页1 浮出条 | shots? 否 → organize 删除 RPC |
| 14 | 批量删除所在文件夹 | 现按钮 | 页1 浮出条 | 删除 RPC（含硬性拒绝） |
| 15 | 单文件删除三档 | 右键 | 页1 右键 | 同上 |
| 16 | 预览（图片/文本/属性） | 现预览 | 页1 侧抽屉 | shell.preview |
| 17 | 打开文件 / 打开位置 / 复制路径 | 右键 | 页1 右键 | shell.open/reveal |
| 18 | 扫描偏少提示条 | 现提示 | 页1 InfoBar | 本地判断 + 重扫 |
| 19 | 监控模式（30 秒） | 后台线程 | 页1 选项 | 引擎事件或定时 RPC |
| 20 | 每天自动扫描任务 | schtasks | 页1 选项 / 页9.4 | task.* |
| 21 | 清理截图：识别规则 15 前缀 | shots 扫描 | 页2 | shots.scan |
| 22 | 截图目录管理（启用/状态/概览） | 现对话框 | 页2 管理目录 | shots.config RPC |
| 23 | 保留天数 / 最小 KB / 回收站 | 现参数 | 页2 参数行 | 参数 |
| 24 | 扫描 / 清理选中 / 全部清理 | 现按钮 | 页2 | shots.clean |
| 25 | 单张清理（确认/不确认） | 右键 | 页2 右键 | shots.clean |
| 26 | 截图每日定时 | schtasks | 页2 底部 / 9.4 | task.* |
| 27 | 清理缓存：43 项 / 6 组 / 三级 | cache 扫描 | 页3 | cache.scan |
| 28 | 清理推荐（仅安全级） | 现按钮 | 页3 SplitButton | cache.clean |
| 29 | 清理选中 / 单行清理 | 现按钮/右键 | 页3 | cache.clean |
| 30 | 添加自定义缓存目录（准入校验） | cc_add_custom | 页3 | dir.validate + cache.config |
| 31 | 缓存边界说明 | CACHE_FORBIDDEN | 页3 底部固定区 | cache.scan 返回文案 |
| 32 | 缓存每日定时 + 日志 | schtasks | 页3 / 9.4 | task.* + cache.log |
| 33 | 高级规则编辑/校验/预演/执行 | run_rules | 页4 | rules.* |
| 34 | 载入 YAML / 模板 / 引号提示 | 现编辑器 | 页4 | 本地 + rules.load |
| 35 | 卸载：列表/搜索/普通卸载 | list_installed_apps | 页5 | apps.* |
| 36 | 强制卸载（扫残留+删） | 现流程 | 页5 | apps.force |
| 37 | 五道确认 + .reg 备份 | 现对话框 | 页5 清单窗口 | apps.backup |
| 38 | 右键 9 项 | 现菜单 | 页5 右键 | apps.* / shell.* |
| 39 | 安全黑名单 / 18 条用例逻辑 | _safe_dir 等 | 页5（引擎内不变） | 引擎 |
| 40 | 管理员状态 / 提权重启 | is_admin | 状态栏 + 命令栏 | 本地 |
| 41 | 搜索：本地索引 | SQLite | 页6 | index.* |
| 42 | 建索引 / 重建 / 整盘 D/E | 现按钮 | 页6 索引下拉 | index.build |
| 43 | 文件名优先 + 完整路径回退 | 现查询 | 页6 | index.search |
| 44 | es.exe 优先 | 现探测 | 页6 徽标 | index.search |
| 45 | 双击打开所在文件夹 | 现行为 | 页6 | shell.reveal |
| 46 | 设置：数据目录/缓存/Everything | 现设置页 | 页7 | settings.* / dir.validate |
| 47 | 默认重名策略/递归/日志天数 | 现设置页 | 页7 | settings.save |
| 48 | 默认包含子文件夹/按内容识别 | 现设置页 | 页7 | settings.save |
| 49 | 索引目录管理 | 现设置页 | 页7 | index.config |
| 50 | 右键菜单安装/移除 | HKCU | 页7 | ShellService |
| 51 | 关闭行为三选一 + 记住 | 现逻辑 | 页7 + 9.2 | 本地 |
| 52 | 托盘位置三选一 | 注册表 IsPromoted | 页7 | ShellService |
| 53 | 开机自启三档 | 计划任务 | 页7 | ShellService |
| 54 | 恢复默认 / 打开数据目录 | 现按钮 | 页7 | settings.* / shell.open |
| 55 | 迁移：添加来源/目标/选项 | 现页面 | 页8 | migrate.preview |
| 56 | 预演/校验/并发/回收站 | 现页面 | 页8 | migrate.run |
| 57 | 取消/断点续跑/任务历史 | 现逻辑 | 页8 | migrate.* |
| 58 | 撤销上次（整体回滚） | 现按钮 | 页8 | migrate.undo |
| 59 | 导出报告 | 现按钮 | 页8 | migrate.report |
| 60 | 命令行 `--migrate` | argparse | 保留 | 引擎入口 |
| 61 | 托盘菜单 6 项 | pystray | 9.1 | NotifyIcon |
| 62 | 数据目录缺失告警 | DATA_DIR_MISSING | 9.5 | 启动检查 |
| 63 | 单实例 / 右键带路径启动 | 现逻辑 | 2.3 / 9.3 | 互斥量 + 参数转发 |

---

## 8 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 引擎冷启动 1~2 s | 首次扫描前等待 | 启动即预热（空闲时异步起引擎）；状态栏提示 |
| IPC 序列化开销（上千文件） | 预览卡顿 | 批量分页传输（每 200 项一帧）+ 列表虚拟化；只传必要字段 |
| WPF 传统观感与「重设计」预期不符 | 用户觉得不够现代 | 用间距/字号/中性色做出清爽感；若坚持 Fluent，改 WinUI 3（见 1.2） |
| 全量重写功能回归 | 功能不删验收失败 | 不重写引擎；前端逐页替换、旧版保留可回退 |
| 卸载/删除类操作跨进程失败 | 数据风险 | 所有破坏性操作只在引擎执行，WPF 不直接删；保留黑名单与五道确认 |
| 提权实例与普通实例冲突 | 双进程/数据竞争 | 单实例互斥量按提权级分域；提权实例接管后普通实例退出 |
| 计划任务名冲突 | 用户已有任务被覆盖 | 沿用现任务名，创建前查询并提示「已存在，是否覆盖」 |
| 高 DPI/多显示器 | 布局错位 | PerMonitorV2 manifest + 全 DIP；在 100/150/200% 三档验收 |
| .NET 运行时缺失 | 打不开 | self-contained 发布，不依赖用户安装 |
| 杀软误报（自解压/双进程） | 分发受阻 | 不做自解压；onedir + 双 exe 结构，签名证书（待确认是否有证书） |

---

## 9 测试与验收

- 单测：ViewModel 逻辑、设置序列化、桥接协议（模拟引擎）、数据目录校验用例（移植现 13 例）。
- 契约测试：每个 RPC 方法与引擎真实进程跑一遍，固定样例目录比对结果。
- 回归：现 54 例 Python 测试保持不变，作为引擎回归门禁。
- 手工验收：按第 6 节阶段验收表 + `UI重设计_逐页方案.md` 每页「功能落点」逐条勾选。
- 系统集成验收：右键菜单往返、托盘菜单、三档自启、三个计划任务、数据目录改/存/迁移/缺失告警。
- 加载验收：300 ms 内完成的操作不出现 loading、骨架替换零跳动、8 s 出现取消/重试、按钮加载态不可重复提交、关闭系统动画后功能不受影响（清单见 `UI重设计_加载占位与反馈规范.md` 第 8 节）。
- 兼容验收：旧数据目录（b3/b4 产生）直接可用；旧 settings.json 字段缺失时取默认值。

---

## 10 待补充项（按任务书边界要求列出）

| # | 待确认 | 缺它的影响 | 当前默认（按此推进） |
|---|---|---|---|
| 1 | 框架是否确认 WPF(.NET 8)；或改 WinUI 3 | 决定工程结构与部署方式，影响工期 30%~50% | WPF |
| 2 | 业务是否保留 Python 引擎；或全 C# 重写 | 决定是否需要逐模块移植与重建回归 | 保留引擎，前端原生 |
| 3 | 目标系统：Win10 1809+ 还是仅 Win11 | 影响字体（Segoe UI Variable）、圆角/Mica、.NET 版本 | Win10 1809+ |
| 4 | 深色主题是否需要 | 需要多一套颜色令牌与主题切换验收 | 首版只做浅色，跟随系统强调色；深色后续加 |
| 5 | 是否接受设置页「即时保存」替代「保存设置」按钮 | 交互变化；用户习惯 | 即时保存；数据目录仍显式确认 |
| 6 | 是否保留「选项弹窗」还是把它并入设置页 | 影响主页面操作步数 | 保留选项浮层（主页面不变脏） |
| 7 | 托盘实现是否允许引入第三方包（Hardcodet） | 影响依赖与许可登记 | 用 WinForms NotifyIcon，零新增第三方 |
| 8 | 是否需要安装包（MSI/Inno）还是继续绿色 zip | 影响发布流程与「便携」定位 | 继续绿色 zip（onedir 文件夹） |
| 9 | 是否需要代码签名证书 | 影响杀软误报与分发体验 | 暂不签名 |
| 10 | 软件名称与图标是否沿用「整理助手」/icon.ico | 影响品牌与资源 | 沿用 |
| 11 | 是否需要旧版（b3/b4）自动升级/数据接管向导 | 影响首次启动体验 | 首版直接读旧数据目录与 settings，不写升级器 |
| 12 | 触屏/平板模式是否需要放大命中区 | 影响行高与按钮尺寸 | 桌面鼠标优先；触屏后续 |
| 13 | 多语言（是否要英文界面） | 影响资源抽取方式 | 中文单语 |
| 14 | b4 修复版是否先发布（数据目录修复已完成） | 影响用户当前可用版本 | 建议先发 b4，再进原生版 |
| 15 | 交付节奏：逐页替换还是一步到位 | 影响可回退性与验收方式 | 逐页迁移，每阶段可运行 |

---

## 11 假设声明（本方案的取舍）

1. 现版本功能以 `03_文档\说明.md` 与源码为准；文档未提到的界面元素（如「关于」）标为补充项，不算现有功能。
2. 保留全部删除/卸载能力与其确认流程；仅调整位置与呈现，不降低闸门数量与文案强度。
3. 数据目录/缓存目录修复（2026-11-13，b4）是现有功能的一部分，新框架必须同样支持：配置跟随数据目录、`数据位置.json` 指针、启动缺失告警、保存与迁移解耦。
4. 设计文本中「新增」的能力仅限：导出程序列表、关于对话框、预览侧抽屉、命令面板、搜索历史；这些均为可选增强，不影响现有功能对照；若不需要可在实现时去掉。
5. 工期估算为相对量级（P0~P6 约 6~9 周，单人全职），实际以确认第 10 节后重排。
