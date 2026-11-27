<div align="center">

<img src="docs/assets/logo.svg" width="76" height="76" alt="轻盘 QDisk Logo" />

# 轻盘 QDisk

Windows 桌面文件整理、磁盘清理与压缩包管理工具。纯本地运行、无广告、MIT 开源，修改文件前先预览，支持撤销。

[![Official Website](https://img.shields.io/badge/%E5%AE%98%E7%BD%91-Live%20Site-d44b24?style=flat-square)](https://bireo.github.io/QDisk/)
[![Latest Release](https://img.shields.io/github/v/release/Bireo/QDisk?style=flat-square&color=2ea043&label=%E6%9C%80%E6%96%B0%E7%89%88%E6%9C%AC)](https://github.com/Bireo/QDisk/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](LICENSE)
[![Platform](https://img.shields.io/badge/Windows-10%2F11%20x64-0078D6?style=flat-square)](#下载与安装)

**简体中文** | [English](README.en.md)

<br />

<a href="https://bireo.github.io/QDisk/">
  <img src="docs/assets/social-preview.png" alt="轻盘 QDisk 界面预览" width="100%" />
</a>

</div>

---

## 实机演示

https://github.com/user-attachments/assets/5f6b97b1-588c-4c9b-a246-e84c9946924a

<p align="center"><sub>1080p 实机录屏（含浅色 / 深色主题），也可在 <a href="https://bireo.github.io/QDisk/#film">官网按章节查看</a> 或下载 <a href="https://github.com/Bireo/QDisk/releases/download/v1.46.2/qdisk-promo.mp4">MP4 原片 (8.5 MB)</a></sub></p>

---

## 主要功能

完整界面大图与交互演示可查看 [官网](https://bireo.github.io/QDisk/)，下面是几个常用场景的实际界面。

### 1. 文件整理（先预演，可撤销）

扫描下载目录或任意文件夹时，先列出每个文件的目标分类和跳过原因，不提前改动磁盘。底层默认跳过代码仓库、系统目录和未下载完的临时文件。

实际测试中，1,000 个混合文件归类耗时约 `1.79 s`，如果不满意可以直接点撤销，约 `1.39 s` 按原路径还原。除内置规则外，也支持自定义 YAML 规则。

![文件整理预演界面](docs/assets/screenshots/02-organize.png)

### 2. 本地 AI 磁盘排查

内置的 AI 助手只调用本机扫描工具获取真实目录占用，调用参数和耗时都可以展开查看。涉及删除或清理的操作会生成勾选确认卡片，必须手动确认后才会执行。

点击对话里的路径链接时，默认在软件内高亮定位（旁边提供打开系统资源管理器按钮），不会直接运行 `.exe` 文件。访问 `WindowsApps` 等受限目录时支持按需提权定位；停止生成会直接关闭底层 WinHTTP 连接（实测约 `0.31 ms` 中断）。

![本地 AI 助手界面](docs/assets/screenshots/01-ai-assistant.png)

### 3. 压缩包浏览、解压与打包

支持 **ZIP / 7Z / RAR / TAR / TAR.GZ / BZ2 / XZ** 格式的内容预览、解压和创建，无弹窗广告。

提供 4 档并发限速，解压大包时可随时暂停或取消。遇到同名文件可选择覆盖或保留两者（自动改名），被覆盖的文件保留单次撤销恢复，解压过程会拦截路径穿越和异常体积压缩包。

![压缩包管理界面](docs/assets/screenshots/03-archive.png)

### 4. 缓存清理、大文件排查与跨盘迁移

| 分级缓存清理 | 大文件排行与数字签名查看 |
|---|---|
| ![分层缓存清理](docs/assets/screenshots/04-cache.png) | ![大文件与数字签名](docs/assets/screenshots/05-space-tools.png) |

- **分级缓存清理**：默认只勾选浏览器、系统临时文件和构建缓存等可重建内容，聊天记录、个人文档、系统目录及 `.git` / `.ssh` 默认受保护。
- **大文件定位**：按体积排序大文件，对可执行文件读取 Authenticode 数字签名以识别发布厂商。
- **跨盘迁移**：迁移前先检查目标盘空间，按「复制 → 校验哈希 → 记录事务日志 → 替换」流程执行，日常运行无需管理员权限，仅在涉及受保护目录时请求提权。

---

## 下载与安装

支持 **Windows 10 / 11 (x64)**。

- **官网**：https://bireo.github.io/QDisk/
- **安装版（约 20.7 MB）**：在 [GitHub Releases](https://github.com/Bireo/QDisk/releases/latest) 下载 `QDisk_*_x64-setup.exe`
- **便携版（约 25.1 MB）**：在同一页面下载 `QDisk_*_x64-portable.zip`，解压后双击 `tidy-assistant.exe` 运行
- **校验与更新**：每个版本附带 `SHA256SUMS.txt`；软件内置基于 GitHub Releases 的自动更新，安装前核验 SHA-256，便携版替换失败会自动回滚。

配置文件、自定义规则和撤销记录独立存放在 `%LOCALAPPDATA%\整理助手数据`，重装或升级不会覆盖个人数据。

如果有遇到误判或希望加入保护白名单的目录，欢迎在 [Discussions](https://github.com/Bireo/QDisk/discussions) 或 [Issues](https://github.com/Bireo/QDisk/issues) 反馈。

---

## 性能数据与本地构建

<details>
<summary>实测性能数据（本机实测，无估算）</summary>

测试环境：AMD Ryzen 9 5900HX (8C/16T) · Windows 11 x64 · NVMe SSD。

| 测试项 | 样本条件 | 实测结果 | 备注 |
|---|---|---|---|
| AI 阻塞中断 (`ai_cancel`) | 本地 `TcpListener` 挂起 `WinHttpReceiveResponse`（5 次） | 中位数 `0.31 ms`（239–323 µs） | 跨线程关闭 WinHTTP 句柄 |
| 1,000 文件整理与撤销 | 1,000 个混合文件（10 扩展名，5 分类） | 扫描 `306.5 ms` · 移动 `1.79 s` · 撤销 `1.39 s` | `1000/1000` 完整移动与还原 |
| 10,001 文件索引与检索 | 50 子目录 × 200 文件 + 目标 PDF（30 次 FTS5 查询） | 建库 `68.4 ms` · 检索中位数 `6.53 ms` | Rust `indexwalk` + SQLite FTS5，P95 `7.23 ms` |
| 引擎冷启与 RPC 往返 | `tidy.py --engine` 冷启 + 20 次热态 `ping` | 冷启 `224.4 ms` · 往返 `0.10 ms` | 常驻进程通信 |
| 产物大小 | Release 正式包 | 主程序 `5.56 MB` · 安装包 `20.7 MB` · 便携包 `25.1 MB` | 原生 JS 前端约 `2.0 MB`（无 `node_modules`） |
| 自动化测试 | `build.ps1` 构建前执行 | 370+ 项通过，Release 0 警告 | Python 237 + Rust 62 + 前端/官网自测 |

#### Rust 压缩模块四档并发测试（64 MB 混合集：75% JSON + 25% PNG，32 文件）

| 档位 | 线程数 (16T) | CPU / I/O 占空比 | 压缩耗时与速率 | 相对节约档 | 解压吞吐（含页缓存） |
|---|---|---|---|---|---|
| 节约 (`saver`) | `1` | `35% / 25%` | `3,025.6 ms` · `21.2 MB/s` | `1.0×` | `852.6 MB/s` |
| 平衡 (`balanced`) | `6` | `65% / 50%` | `696.3 ms` · `91.9 MB/s` | `4.3×` | `2,998.6 MB/s` |
| 高性能 (`performance`) | `10` | `85% / 75%` | `210.3 ms` · `304.3 MB/s` | `14.4×` | `3,844.1 MB/s` |
| 超线程 (`hyper`) | `16` | `100% / 100%` | `235.1 ms` · `272.3 MB/s` \* | `12.8×` | `2,661.5 MB/s` |

> \* 64 MB 属于短任务，16 线程建池开销略高于 10 线程；处理 GB 级压缩包时 `hyper` 档更明显。

</details>

<details>
<summary>技术栈、本地编译与扩展接口</summary>

#### 技术构成

- **主壳与核心模块**：Tauri v2 + Rust（`archive/` 并发压缩、`updater.rs` 在线更新、`main.rs` WinHTTP 网关与文件定位、`indexwalk` 目录遍历）
- **文件引擎**：Python 3.11 + SQLite FTS5
- **界面**：原生 HTML / CSS / ES Module，无前端构建打包依赖
- **第三方组件**：`tauri-plugin-single-instance`、`windows-sys`、`zip`、`sevenz-rust2`、`lzma-rust2`、`flate2`/`zlib-rs`、`bzip2`、`tar`、`sha2`、`walkdir`、`rfd`、`libloading`，以及按需下载并校验 SHA-256 的官方 `UnRAR64.dll`（详见 [THIRD_PARTY.md](THIRD_PARTY.md)）

#### 本地开发与构建

环境要求：Windows x64、Rust 1.80+、Python 3.11+、Node.js 20+、PowerShell 7 (`pwsh`)、NSIS 3.x。

```powershell
git clone https://github.com/Bireo/QDisk.git
cd QDisk

# 前端与官网自测
node src/web/js/ai/md.selftest.mjs
node src/web/js/ai/pages.selftest.mjs
node src/web/js/ai/website.selftest.mjs

# Python 与 Rust 单元测试
python -m unittest discover -s src/engine -p "test_*.py" -v
cargo test --release --manifest-path src/src-tauri/Cargo.toml

# 完整测试 + 打包安装版、便携版和 latest.json
pwsh -NoProfile -ExecutionPolicy Bypass -File .\build.ps1 -Bump patch
```

#### 扩展点

| 扩展层 | 文件位置 | 注册方法 |
|---|---|---|
| 前端页面与钩子 | `src/web/js/app.js` | `App.registerPage(id, { zh, en, icon, mount })` / `App.onHook(event, fn)` |
| AI 工具动作 | `src/web/js/ai/registry.js` | `AIRegistry.register(name, { label, risk, schema, run })` |
| Python 引擎 RPC | `src/engine/tidy.py` | `tidy.register_engine_method("custom.op", handler, meta={...})` |
| Rust 压缩格式 | `src/src-tauri/src/archive/registry.rs` | 实现 `ArchiveCodec` trait 并注册 |

私有化/自建更新源说明见 [发包与在线更新指南](docs/01-当前版/发包与在线更新指南.md)。

</details>

---

本项目基于 [MIT License](LICENSE) 开源。欢迎提交 [Issue](https://github.com/Bireo/QDisk/issues)、[Discussions](https://github.com/Bireo/QDisk/discussions) 或 PR。

---

## 赞赏支持

软件免费开源且无广告。如果它平时帮到了你，可以随心请作者喝杯咖啡，或者在右上角点个 Star。

<div align="center">
  <table>
    <tr>
      <td align="center" width="240">
        <img src="website/assets/sponsor/wechat.jpg" width="190" alt="微信赞赏码" /><br />
        <sub>微信支付</sub>
      </td>
      <td align="center" width="240">
        <img src="website/assets/sponsor/alipay.jpg" width="190" alt="支付宝赞赏码" /><br />
        <sub>支付宝</sub>
      </td>
    </tr>
  </table>
</div>
