<div align="center">

# 整理助手 · TidyAssistant

**本地优先、零广告、每步高危动作均可预演与一键撤回的 Windows 文件整理、多核压缩、空间维护与可审计 AI 助手**

[![Official Website](https://img.shields.io/badge/%E5%AE%98%E6%96%B9%E7%BD%91%E7%AB%99-Live%20Site-c84b28?style=for-the-badge)](https://3347567186.github.io/TidyAssistant/)
[![Download Installer](https://img.shields.io/badge/%E4%B8%8B%E8%BD%BD%E5%AE%89%E8%A3%85%E7%89%88-v1.43.15%20(20.6%20MB)-161614?style=for-the-badge)](https://github.com/3347567186/TidyAssistant/releases/download/v1.43.15/TidyAssistant_1.43.15_x64-setup.exe)
[![Download Portable](https://img.shields.io/badge/%E4%B8%8B%E8%BD%BD%E4%BE%BF%E6%90%BA%E7%89%88-ZIP%20(25.0%20MB)-0969da?style=for-the-badge)](https://github.com/3347567186/TidyAssistant/releases/download/v1.43.15/TidyAssistant_1.43.15_x64-portable.zip)

[![Latest Release](https://img.shields.io/github/v/release/3347567186/TidyAssistant?color=2ea043&label=%E6%9C%80%E6%96%B0%E7%89%88%E6%9C%AC)](https://github.com/3347567186/TidyAssistant/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Windows-10%2F11%20x64-0078D6)](#四安装部署与下载)
[![Tests](https://img.shields.io/badge/Tests-362%2B%20Passing%20%7C%200%20Warnings-15803d)](#一不靠吹嘘本机功能实测数据)

**简体中文** | [English](README.en.md)

**[🌐 访问官方网站](https://3347567186.github.io/TidyAssistant/)** · **[⬇️ 下载安装版 (.exe)](https://github.com/3347567186/TidyAssistant/releases/download/v1.43.15/TidyAssistant_1.43.15_x64-setup.exe)** · **[📦 下载便携版 (.zip)](https://github.com/3347567186/TidyAssistant/releases/download/v1.43.15/TidyAssistant_1.43.15_x64-portable.zip)** · **[📋 全部版本与校验](https://github.com/3347567186/TidyAssistant/releases/latest)**

</div>

---

## 一、不靠吹嘘：本机功能实测数据

> **测试环境**：AMD Ryzen 9 5900HX（8 核 16 线程）· Windows 11 x64 · NVMe SSD · TidyAssistant `v1.43.15`（全部为本机实跑采集，非估算值）。

### 1. 核心性能与响应实测

| 实测场景 | 测试样本与条件 | 实测结果 | 对比/说明 |
|---|---|---|---|
| **AI 对话阻塞真停止** (`ai_cancel`) | 本地 `TcpListener` 模拟挂起 `WinHttpReceiveResponse`（5 次实测） | **中位数 `0.31 ms`**（239–323 µs） | 跨线程直接关闭 WinHTTP 请求句柄，告别 60–300 s 超时卡死 |
| **1,000 文件整理预演 / 执行 / 撤回** | 1,000 个真实混合下载文件（10 扩展名，5 大分类） | 扫描 **`306.5 ms`** · 移动 **`1.79 s`** · 撤回 **`1.39 s`** | `1000/1000` 精准移动，`1000/1000` 一键原路还原，失败 0 |
| **10,001 文件索引与模糊检索** | 50 子目录 × 200 文件 + 目标 PDF（30 次 FTS5 查询） | 建库 **`68.4 ms`**（~14.6 万文件/秒）· 检索中位数 **`6.53 ms`** | Rust `indexwalk` + SQLite FTS5，P95 检索延迟 `7.23 ms` |
| **引擎冷启动 & JSON-RPC 往返** | `tidy.py --engine` 进程冷启 + 20 次热态 `ping` | 冷启含首包 **`224.4 ms`** · 热态往返 **`0.10 ms`** | 长驻引擎零重复冷启开销 |
| **软件体积极致控制** | `v1.43.15` 正式 Release 产物 | 主程序 **`5.56 MB`** · 安装包 **`20.56 MB`** · 便携包 **`24.99 MB`** | 前端零框架总源码仅 `2.03 MB`（0 `node_modules`） |
| **全栈自动化测试门禁** | `build.ps1` 每次发包强制执行 | **362+ 项测试全绿** · Release **`0` 警告** | Python 234 项 + Rust 56 项 + JS 7 套（含 72 项 AI 黄金集 & 12 页 0 泄漏） |

### 2. Rust 多核压缩内核四档动态性能实测（64 MB 混合集：75% JSON + 25% PNG，32 文件）

| 性能档位 | 动态分配线程 (16T 机型) | CPU / I/O 占空比 | 压缩耗时 & 速率 | 相对节约档提速 | 解压吞吐（含系统页缓存） |
|---|---|---|---|---|---|
| **节约 (`saver`)** | `1` 线程 | `35% / 25%` | `3,025.6 ms` · **`21.2 MB/s`** | `1.0×` | `852.6 MB/s` |
| **平衡 (`balanced`)** | `6` 线程 | `65% / 50%` | `696.3 ms` · **`91.9 MB/s`** | **`4.3×`** | `2,998.6 MB/s` |
| **高性能 (`performance`)** | `10` 线程 | `85% / 75%` | `210.3 ms` · **`304.3 MB/s`** | **`14.4×`** | **`3,844.1 MB/s`** |
| **超线程 (`hyper`)** | `16` 线程 | `100% / 100%` | `235.1 ms` · **`272.3 MB/s`** \* | **`12.8×`** | `2,661.5 MB/s` |

> \* **实测说明**：64 MB 短任务中 16 线程建池开销略高于 10 线程；在 GB 级大体积归档下，`hyper` 档零节流跑满全部逻辑核与大文件分块并行优势更显著。

---

## 二、4 个最硬核的功能重点（图文直览）

> 更多交互展示请访问 **[官方网站](https://3347567186.github.io/TidyAssistant/)**。

### 1. 可审计本地 AI 助手：透明查证 + 0.31 ms 真停止 + 审批闸门

![AI 助手运行时界面](docs/assets/screenshots/01-ai-assistant.png)

- **过程完全透明**：推理原文、本地调用的工具名、参数与耗时（`14ms / 68ms`）全部可展开核查，并自动做**体积与路径同源反幻觉校验**。
- **四档可控权限**：`只读` / `确认`（写动作全变审批卡片，勾选才执行）/ `自动`（可撤销动作 3 秒可停）/ `放手`（永久删除仍需输入确认词）。
- **真正秒停**：Rust 层 `AI_CANCEL_EPOCH` + `ACTIVE_AI_HANDLES` 跨线程直关 WinHTTP 句柄（实测 `0.31 ms`），前端同步打断 429/5xx 退避睡眠，绝不白烧 Token。

### 2. 先预演再落盘的智能整理 + 1.39 秒全量一键撤回

![整理文件预览界面](docs/assets/screenshots/02-organize.png)

- **先看再动**：扫描即预演分类结果与跳过原因，底层自动拦截代码仓库、系统目录与 `.crdownload` 下载中临时文件。
- **自定义规则 & 零损撤回**：支持 YAML 自定义规则（可一键导入 AI 生成草稿）；1,000 文件 1.79 s 整理完毕，不满意 **1.39 s 全部原路还原**。

### 3. 四档并发零广告压缩包内核（7 大格式 + 真暂停取消 + 同名并存与撤回）

![压缩包管理器界面](docs/assets/screenshots/03-archive.png)

- 支持 **ZIP / 7Z / RAR / TAR / TAR.GZ / BZ2 / XZ** 浏览、双击内置预览、解压与创建；按本机核数动态阶梯调速，分块级响应暂停与取消。
- 同名冲突弹窗可选「直接覆盖」或「二者并存（自动重命名）」，内置**单槽原子撤回**（恢复被覆盖旧文件，同时防止多份大包备份撑爆硬盘），硬拦截 ZIP Slip、符号链接逃逸与 32 GiB 压缩炸弹。

### 4. 分级安全清理、大文件签名溯源与事务级跨盘迁移

| 分级缓存清理（安全 / 谨慎分层） | 大文件排行 + 数字签名厂商识别 |
|---|---|
| ![安全缓存清理](docs/assets/screenshots/04-cache.png) | ![大文件与签名识别](docs/assets/screenshots/05-space-tools.png) |

- **缓存清理**：只自动勾选可安全重建的浏览器/系统/构建缓存，硬闸门保护系统目录、`.git`/`.ssh` 与个人文档。
- **空间工具与迁移**：大文件直读 Authenticode 数字签名与发行商；跨盘迁移采用「预演空间 → 复制 → 哈希校验 → 事务日志 → 原子替换」，平时零管理员权限运行，仅操作受保护路径时按需提权。

---

## 三、自研核心 vs 开源技术栈

| 分类 | 核心内容 |
|---|---|
| **核心自研** | **Rust 并发压缩内核**（`archive/`：4 档 `WorkPacer`、分块暂停取消、防逃逸、单槽撤回、`ArchiveCodec` 注册表）；**零新增依赖在线更新引擎**（`updater.rs`：安装版/便携版双形态、仓库锁仓、失败自动回滚）；**0.31 ms WinHTTP 真断连网关**（`main.rs`）；**本地 AI Agent & 审批闸门**（`web/js/ai/`：协议自动降级、反幻觉、四档权限）；**零框架 12 页桌面 UI**；**Python 事务整理/迁移引擎 + Rust 遍历器 `indexwalk`** |
| **开源组件** | **Tauri v2** + `tauri-plugin-single-instance`、**Rust Crates**（`windows-sys`, `zip`, `sevenz-rust2`, `lzma-rust2`, `flate2`/`zlib-rs`, `bzip2`, `tar`, `sha2`, `walkdir`, `rfd`, `libloading`）、**Python 3.11 + SQLite FTS5**、按需官方下载并双校 SHA-256 的 `UnRAR64.dll`（完整许可见 [THIRD_PARTY.md](THIRD_PARTY.md)） |

---

## 四、安装、部署与下载

- **🌐 官方网站**：https://3347567186.github.io/TidyAssistant/
- **⬇️ 安装版（推荐，20.6 MB）**：[TidyAssistant_1.43.15_x64-setup.exe](https://github.com/3347567186/TidyAssistant/releases/download/v1.43.15/TidyAssistant_1.43.15_x64-setup.exe)
- **📦 便携版（免安装，25.0 MB）**：[TidyAssistant_1.43.15_x64-portable.zip](https://github.com/3347567186/TidyAssistant/releases/download/v1.43.15/TidyAssistant_1.43.15_x64-portable.zip)（解压至纯英文路径即用）
- **🔐 校验与历史版本**：[GitHub Releases](https://github.com/3347567186/TidyAssistant/releases/latest) · [SHA256SUMS.txt](https://github.com/3347567186/TidyAssistant/releases/download/v1.43.15/SHA256SUMS.txt)

> 支持 **Windows 10 / 11 (x64)**；所有配置、规则与撤回记录独立保存在 `%LOCALAPPDATA%\整理助手数据`，内置官方 GitHub Releases 零配置在线更新（自动核验 SHA-256，便携版失败自动回滚）。私有化/内网部署详见 [发包与在线更新指南](docs/01-当前版/发包与在线更新指南.md)。

---

## 五、二次开发与 4 大预留扩展接口

### 环境与本地运行

需 Windows x64 + Rust 1.80+ + Python 3.11+ + Node.js 20+ + PowerShell 7 (`pwsh`) + NSIS 3.x：

```powershell
git clone https://github.com/3347567186/TidyAssistant.git && cd TidyAssistant

# 3 秒跑完前端离线自测（零打包构建步骤，改完即测）
node src/web/js/ai/scope.selftest.mjs
node src/web/js/ai/agent.selftest.mjs
node src/web/js/ai/pages.selftest.mjs

# Python 引擎单测（234 项） & Rust 核心单测（56 项）
python -m unittest discover -s src/engine/tests -v
cargo test --release --manifest-path src/src-tauri/Cargo.toml

# 全量测试门禁 + 编译打包安装包、便携包与 latest.json
pwsh -NoProfile -ExecutionPolicy Bypass -File .\build.ps1 -Bump patch
```

### 四层标准扩展点（免改核心代码）

| 扩展层 | 入口文件 | 注册方式 |
|---|---|---|
| **前端新页面 & 钩子** | `src/web/js/app.js` | `App.registerPage(id, { zh, en, icon, mount })` / `App.onHook(event, fn)` |
| **AI 助手新动作** | `src/web/js/ai/registry.js` | `AIRegistry.register(name, { label, risk, schema, run })`（自动接入审批闸门） |
| **Python 引擎新 RPC** | `src/engine/tidy.py` | `tidy.register_engine_method("custom.op", handler, meta={...})` |
| **Rust 压缩新格式** | `src/src-tauri/src/archive/registry.rs` | 实现 `ArchiveCodec` trait 并注册，自动通过 `archive_capabilities` 暴露给前端 |

---

欢迎提交 [Issue](https://github.com/3347567186/TidyAssistant/issues) 或 PR · 本项目基于 **[MIT License](LICENSE)** 开源。
