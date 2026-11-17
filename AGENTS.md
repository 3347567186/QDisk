# 整理助手 · 工作区说明（会话必读）

这个目录 `D:\Tools\TidyAssistant` 是整理助手**唯一**的源码树 + 运行副本。
2026-11-15 由旧工作区 `D:\Tool\整理助手` 合并而来，旧目录已彻底删除。

## 先认路，别改错地方

| 路径 | 是什么 |
|---|---|
| `tidy-assistant.exe` | 运行副本（构建产物，别手改） |
| `WebView2Loader.dll` | WebView2 加载器，和 exe 同目录 |
| `引擎\` | 随包 Python 引擎：`整理助手引擎.exe` + `_internal\` + `数据位置.json` |
| `src\src-tauri\` | Rust 外壳（窗口、托盘、命令面、引擎进程管理） |
| `src\web\` | 前端 9 页（原生 JS，无打包步骤） |
| `src\engine\` | Python 引擎源码 `tidy.py` 等 |
| `docs\` | 开发文档，`01-当前版` 有效、`02-历史-旧版` 只作参考 |
| `release\` | NSIS 安装包 |
| `tools\cargo-tauri.exe` | 打包用 Tauri CLI（全局没有 `cargo tauri`） |

**不存在第二个源码目录。** 要改软件就改这里，改完必须按下面的命令重新构建 + 覆盖 `tidy-assistant.exe`，否则你改的和用户跑的不是同一个东西。

## 两条硬约束（违反就构建失败或启动失败）

1. **整条路径必须是 ASCII**：`D:\Tools\TidyAssistant\src\src-tauri` 可以，任何一级目录带中文都会让 GNU 工具链链接失败；exe 所在目录带中文会让 WebView2 初始化失败（0x800700AA）。不要再建 junction 绕中文路径——现在路径本来就是 ASCII。
2. **运行时目录必须可写**：`main.rs` 启动时往 `引擎\数据位置.json` 写数据目录；把 `引擎\` 放到只读位置会导致引擎写入失败。

## 硬性规定：每次改动都要有版本号（不可协商）

1. **改了代码、配置或文档，就必须递增版本号**，不区分大小改。版本号只来自 `src\src-tauri\tauri.conf.json` 与 `Cargo.toml`，且两者必须一致，用 `-Bump` 同步写入，不要手改。当前版本线 **2026-11-15 起从 `1.0.0` 重新起算**，旧的 2.x 编号已作废。
2. **按用户可感知的程度选版本位**：
   - `major`：架构换代、数据格式不兼容（用户要重新学怎么用）
   - `minor`：新增功能、新增页面、新增配置项（用户能看出「多了东西」）
   - `patch`：修 bug、性能优化、无行为变化的内部重构、纯文档
3. **`release\` 只保留最新版与上一版**（各类型各两份），更旧的由 `build.ps1` 自动删除。要长期留存就放 `release\archive\`。
4. 禁止同一版本号对应两份不同二进制；禁止改完不重新构建就说「已更新」。

完整规范（含判断口径与发布流程）：`docs\01-当前版\版本管理与发布规范.md`。

## 构建（在仓库根目录执行）

```powershell
.\build.ps1                    # 重建 exe，覆盖根目录的 tidy-assistant.exe
.\build.ps1 -Bump patch        # 先递增版本号（patch|minor|major），再重建
.\build.ps1 -Bump minor -Bundle -Portable   # 出安装包 + 便携包（自动清理旧版本）
.\build.ps1 -Engine            # 只重建 Python 引擎
.\build.ps1 -Status            # 只看状态：版本 / 锁 / 编译进程 / release / 一致性
.\build.ps1 -Bundle -Portable  # 用当前版本出安装包 + 便携包
```

首次构建约 2 分钟（增量十几秒）。构建中间目录固定在 `D:\Builds\`（纯 ASCII）——**不要**把 target 放进 `%TEMP%`，这台机器的 DSH 临时目录带中文，`dlltool` 会直接失败。

### 构建必须走 build.ps1（2026-11-18 起强制）

**禁止绕过 build.ps1 直接调 `cargo-tauri build` / `cargo build`**，也禁止在别的目录里另写一份构建脚本。原因：直接调 cargo 不取构建锁、不改版本号、不留源码快照，一次并发就能让产物和源码对不上。

`build.ps1` 现在自带构建管理（`tools\build-manager.ps1`），每次构建会：

1. 取锁 `D:\Builds\.locks\tidyassistant.build.lock`，拿不到就退出（不会排队、不会互相覆盖）；同时检测是否有别的会话用旧方式在编译，发现就拒绝启动。
2. 在锁内递增/写入版本号（`tauri.conf.json` 与 `Cargo.toml` 一起改）。
3. 构建前把整棵源码树（含其他会话未提交的改动）提交成 git 快照，并打 `build-<版本>` 标签 —— 任何一次产物都追得回它对应的源码。
4. 构建后自检：配置版本、`Cargo.toml` 版本、exe 内嵌版本、安装包文件名必须一致，不一致直接判失败。
5. 追加一条记录到 `D:\Builds\tidyassistant-builds.jsonl` 和 `.build\builds.jsonl`（版本、模式、git SHA、产物哈希、耗时、成败）。

两个会话同时构建会出现 A 改版本号、B 用旧版本号覆盖、产物名与二进制对不上（2026-11-15 实际发生过）。看到 `cargo`/`rustc`/`cargo-tauri` 进程在跑就先等，或者只改不构建。

完整机制、冲突处理、回滚方法：`docs\01-当前版\构建管理.md`。

## 用户数据

`%LOCALAPPDATA%\整理助手数据`（配置、日志、WebView2 缓存、整理历史）。删程序目录不影响数据。

## 文档

- 现行文档（版本规范、变更记录、压缩包、UI、契约、打包）：`docs\01-当前版\`
- 构建与发布的完整说明：`docs\01-当前版\打包与发布.md`
- 前端与 Rust 的命令契约：`docs\01-当前版\前端页面契约.md`
- 旧资料（pywebview / WPF b5 / 1.0.0 阶段报告与截图）：`docs\02-历史-旧版\`，不要照它写新代码
