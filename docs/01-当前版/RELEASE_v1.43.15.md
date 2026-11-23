# TidyAssistant v1.43.15 — 整理助手正式版

> **简体中文** | [Jump to English Release Notes](#english-release-notes) · [完整中文文档 (README.md)](https://github.com/3347567186/TidyAssistant/blob/main/README.md) · [English Documentation (README.en.md)](https://github.com/3347567186/TidyAssistant/blob/main/README.en.md)

---

## 本次版本重点更新（v1.43.15）

### 1. 彻底修复「切换 AI 权限模式后直接进入思考且无法暂停」
- **根因修复**：解除 `setMode` 与空闲态 `addNotice` 对 `startAnswer` 的误调用，切换 `只读 / 确认 / 自动 / 放手` 仅更新策略并弹出轻提示，彻底杜绝凭空生成永久转圈的虚假「正在思考」气泡。
- **交互完善**：补齐权限档位气泡菜单（`modeMorph`）的点击外部、`Escape` 键、滚动、窗口缩放及 `closeMenu()` 关闭链路，并阻断菜单项点击冒泡。

### 2. 彻底根治「AI 对话暂停/停止失效与卡慢（原最长卡满 60–300 秒）」
- **Rust 底层 `<1 ms` 真断连**：以单调递增取消代次 `AI_CANCEL_EPOCH` + 在飞句柄表 `ACTIVE_AI_HANDLES` + RAII 守卫 `AiRequestGuard` 替代全局单布尔；点击「停止」时跨线程直接关闭 WinHTTP 请求句柄，强制中止阻塞中的 `WinHttpSendRequest` / `WinHttpReceiveResponse` / `WinHttpQueryDataAvailable` / `WinHttpReadData`，不再白烧 Token。
- **前端全链路 0ms 响应**：429/5xx 退避睡眠支持毫秒级中断；`AIStore.load` / `ensureGuard` 预备窗口可提前抢占停止；停止键即时终止打字动画并忽略滞后 SSE 事件；同步原子释放 `running` 与单飞锁（停止后紧接重发不再被静默吞掉）；修复 `AIProcs` 每轮计时器泄漏。
- **对抗验证**：新增 Rust 真实本地 `TcpListener` 阻断单测（毫秒级中断 + 零句柄泄漏）及前端 `G69` / `回归 13` 全链路自动化回归，Python 234 项 + JS 7 套自测 + Rust 56 项单测全绿、Release 0 警告。

---

## 界面运行时功能一览（图文介绍）

### 本地优先 AI 助手（透明查证过程组 + 四档权限 + `<1ms` 停止）
![AI 助手运行时界面](https://raw.githubusercontent.com/3347567186/TidyAssistant/main/docs/assets/screenshots/01-ai-assistant.png)
- 展开可见每步推理原文、调用工具与毫秒耗时；体积与路径自动反幻觉核对；写/删动作必须经审批提案卡确认，支持任意 OpenAI 兼容端点与本机 Ollama。

### 智能文件整理（Dry-Run 预览 + 自定义 YAML 规则 + 一键撤回）
![整理文件运行时界面](https://raw.githubusercontent.com/3347567186/TidyAssistant/main/docs/assets/screenshots/02-organize.png)
- 扫描即预演，自动跳过下载中临时文件与系统目录；整理不满意可一键原路还原。

### 高速零广告压缩包工具（7 大格式 + 四档性能 + 暂停/取消/冲突并存/撤回）
![压缩包管理器运行时界面](https://raw.githubusercontent.com/3347567186/TidyAssistant/main/docs/assets/screenshots/03-archive.png)
- 支持 ZIP / 7Z / RAR / TAR / TAR.GZ / BZ2 / XZ 浏览、内置预览、四档按核数阶梯调速（节约/平衡/高性能/超线程）、实时暂停取消、同名覆盖/并存与单槽安全撤回。

### 分级安全缓存清理 & 大文件签名溯源 & 应用自启管理
| 安全缓存清理 | 空间工具（大文件 + 签名溯源） |
|---|---|
| ![缓存清理](https://raw.githubusercontent.com/3347567186/TidyAssistant/main/docs/assets/screenshots/04-cache.png) | ![空间工具](https://raw.githubusercontent.com/3347567186/TidyAssistant/main/docs/assets/screenshots/05-space-tools.png) |

| 应用与自启（按需提权） | 零配置内置在线更新（SHA-256 + 自动回滚） |
|---|---|
| ![应用与自启](https://raw.githubusercontent.com/3347567186/TidyAssistant/main/docs/assets/screenshots/08-apps-overview.png) | ![设置与在线更新](https://raw.githubusercontent.com/3347567186/TidyAssistant/main/docs/assets/screenshots/06-settings-updater.png) |

---

## 自研核心与开源技术栈

| 分类 | 内容 |
|---|---|
| **核心自研** | Rust 并发分块压缩内核与 4 档 `WorkPacer`、零新增依赖双形态在线更新引擎（`updater.rs` + 便携版回滚引导器）、`AI_CANCEL_EPOCH` + RAII `<1ms` WinHTTP 网关、本地优先 AI Agent 与反幻觉/审批闸门、零框架 12 页原生桌面 UI、事务级跨盘迁移与回滚引擎、Rust 高速遍历器 `indexwalk`、四大插件扩展注册表 |
| **开源组件** | Tauri v2、Rust (`windows-sys`, `zip`, `sevenz-rust2`, `lzma-rust2`, `flate2`/`zlib-rs`, `bzip2`, `tar`, `sha2`, `rfd`, `libloading`)、Python 3.11 + SQLite FTS5、按需官方下载 `UnRAR64.dll`（详见 [THIRD_PARTY.md](https://github.com/3347567186/TidyAssistant/blob/main/THIRD_PARTY.md)） |

---

## 下载、安装与升级指南

| 版本形态 | 下载文件 | 安装与升级方式 |
|---|---|---|
| **安装版（推荐）** | `TidyAssistant_1.43.15_x64-setup.exe` | 双击安装；后续在「设置 → 版本与在线更新」一键校验并覆盖升级 |
| **便携版（免安装）** | `TidyAssistant_1.43.15_x64-portable.zip` | 解压到纯英文目录（如 `D:\Apps\TidyAssistant`）双击 `tidy-assistant.exe`；支持应用内原子替换与失败自动回滚 |
| **校验清单** | `SHA256SUMS.txt` / `latest.json` | 用于人工核对哈希及客户端自动检查更新 |

- **已安装旧版（v1.43.14）用户**：打开软件 →「设置 → 版本与在线更新」→ 点击「立即检查更新」即可直接在线升级到 `v1.43.15`。
- **数据安全**：用户配置、规则与历史记录独立保存在 `%LOCALAPPDATA%\整理助手数据`，升级不会覆盖。
- **二次开发与自定义扩展**：查看 [README.md 第五节](https://github.com/3347567186/TidyAssistant/blob/main/README.md#%E4%BA%94%E6%80%8E%E4%B9%88%E8%BF%9B%E8%A1%8C%E4%BA%8C%E6%AC%A1%E5%BC%80%E5%8F%91)（含 `App.registerPage`、`AIRegistry.register`、Python RPC `@register_method`、Rust `ArchiveCodec` 四大扩展接口示例）。

---

<a id="english-release-notes"></a>

# English Release Notes — TidyAssistant v1.43.15

**TidyAssistant** is a local-first, zero-ad Windows 10/11 (x64) desktop suite combining safe file organization, a high-speed multi-core archive manager, risk-tiered disk cleanup, transactional cross-drive migration, and an auditable AI assistant — built with **Tauri v2 (Rust) + Python 3.11 + Zero-Framework Vanilla JS**, with full **English & Simplified Chinese** UI support.

![TidyAssistant English Runtime UI](https://raw.githubusercontent.com/3347567186/TidyAssistant/main/docs/assets/screenshots/07-en-ai-ui.png)

## What's New in v1.43.15

1. **Fixed Phantom "Thinking" Bubble on Permission Mode Switch**:
   - Switching AI permission tiers (`Read-only / Confirm / Auto / Full Auto`) no longer invokes `startAnswer()` via idle `addNotice()`, eliminating the permanently spinning bot bubble that could not be paused or stopped.
   - Wired `modeMorph` popover into outside-click, `Escape`, scroll, resize, and `closeMenu()` handlers with proper event propagation guards.
2. **Fixed Slow / Broken AI Conversation Stop (`<1 ms` Real WinHTTP Abort)**:
   - Replaced the single `AtomicBool` cancel flag in Rust (`main.rs`) with a monotonic `AI_CANCEL_EPOCH` + `ACTIVE_AI_HANDLES` table + RAII `AiRequestGuard`. Clicking **Stop** immediately closes in-flight WinHTTP request handles across threads outside the mutex, aborting blocked `WinHttpSendRequest` / `WinHttpReceiveResponse` / `WinHttpReadData` calls in **`<1 ms`** instead of hanging 60–300s.
   - Made JS 429/5xx backoff sleeps immediately abortable, closed the pre-agent `AIStore.load` / `ensureGuard` stop window, stopped typewriter animations on Stop, ignored late SSE events after cancellation, synchronized `running` & single-flight lock release (preventing dropped follow-up submits), and fixed a per-turn 1s `setInterval` leak in `procs.js`.
   - Verified with a real local `TcpListener` WinHTTP abort test in Rust (`56/56` passing), `G69` + `Regression 13` in JS (`300+` automated tests passing), and `0` compiler warnings.

## Architecture: In-House vs. Open-Source

- **Built In-House**: Multi-core Rust archive kernel with 4-tier CPU-adaptive `WorkPacer` & single-slot atomic Undo; zero-extra-dep dual-mode online updater (`updater.rs` + Portable auto-rollback launcher); `<1 ms` abortable WinHTTP AI gateway; local-first AI agent orchestration with anti-hallucination verification & 4-tier approval cards; zero-framework 12-page desktop UI; transactional cross-drive migrator; Rust fast walker (`indexwalk`); and 4 plugin extension registries.
- **Open-Source Stack**: Tauri v2, Rust (`windows-sys`, `zip`, `sevenz-rust2`, `lzma-rust2`, `flate2`/`zlib-rs`, `bzip2`, `tar`, `sha2`, `rfd`, `libloading`), Python 3.11 + SQLite FTS5, and on-demand official `UnRAR64.dll` (see [THIRD_PARTY.md](https://github.com/3347567186/TidyAssistant/blob/main/THIRD_PARTY.md)).

## Install, Upgrade & Secondary Development

- **NSIS Installer (Recommended)**: Download `TidyAssistant_1.43.15_x64-setup.exe` and run.
- **Portable ZIP**: Download `TidyAssistant_1.43.15_x64-portable.zip`, extract to an ASCII path (e.g. `D:\Apps\TidyAssistant`), and run `tidy-assistant.exe`.
- **Upgrading from v1.43.14**: Open **Settings → Version & Updates → Check for Updates** to upgrade directly inside the app with SHA-256 verification.
- **Secondary Development & Custom Extensions**: See the complete guide in **[README.en.md](https://github.com/3347567186/TidyAssistant/blob/main/README.en.md#5-secondary-development--customization)** (covering `App.registerPage`, `AIRegistry.register`, Python `@register_method`, Rust `ArchiveCodec`, and local build/test commands).
