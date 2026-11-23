# TidyAssistant v1.43.15 — 整理助手正式版

> **[🌐 访问官方网站](https://3347567186.github.io/TidyAssistant/)** · **[⬇️ 安装版 (.exe, 20.6 MB)](https://github.com/3347567186/TidyAssistant/releases/download/v1.43.15/TidyAssistant_1.43.15_x64-setup.exe)** · **[📦 便携版 (.zip, 25.0 MB)](https://github.com/3347567186/TidyAssistant/releases/download/v1.43.15/TidyAssistant_1.43.15_x64-portable.zip)** · [English Notes](#english-release-notes)

---

## 本次重点更新（v1.43.15）

1. **彻底修复「切换 AI 权限模式后直接进入思考且无法暂停」**：解除 `setMode` 与空闲态 `addNotice` 对 `startAnswer` 的误调用；补齐权限档位菜单 `modeMorph` 的点外关闭、`Escape`、滚动、缩放与事件防冒泡。
2. **彻底根治「AI 对话停止失效与卡慢」**：Rust 层以单调取消代次 `AI_CANCEL_EPOCH` + `ACTIVE_AI_HANDLES` + RAII 守卫跨线程直接关闭 WinHTTP 句柄，将阻塞中断降至 **`0.31 ms`**；前端同步打断 429/5xx 退避睡眠、预备期抢占停止、即时落定打字动画并修复 `procs.js` 计时器泄漏。

## 本机实测数据（AMD Ryzen 9 5900HX 8C/16T · Windows 11 x64 · NVMe SSD）

| 实测项 | 测试条件 | 实测结果 |
|---|---|---|
| **AI 对话阻塞中断延迟** | 5 次挂起 `WinHttpReceiveResponse` 本地 Socket 实测 | **中位数 `0.31 ms`**（239–323 µs，告别 60–300 s 卡死） |
| **Rust ZIP 四档压缩速率** | 64 MB 混合集（75% JSON + 25% PNG） | 节约 **`21.2`** → 平衡 **`91.9`** → 高性能 **`304.3`** / 超线程 **`272.3 MB/s`**（最高 14.4×） |
| **1,000 文件整理与一键撤回** | 1,000 个混合下载文件（5 大分类） | 扫描 **`306.5 ms`** · 移动 **`1.79 s`** · 撤回 **`1.39 s`**（1000/1000 还原） |
| **10,001 文件索引与检索** | Rust `indexwalk` + SQLite FTS5（30 次检索） | 建库 **`68.4 ms`**（~14.6 万文件/秒）· 检索中位数 **`6.53 ms`** |
| **安装包与测试门禁** | `v1.43.15` 正式产物 | 主程序 **`5.56 MB`** · 安装包 **`20.56 MB`** · **362+ 项测试全绿 / 0 警告** |

![AI 助手运行时界面](https://raw.githubusercontent.com/3347567186/TidyAssistant/main/docs/assets/screenshots/01-ai-assistant.png)

| 智能文件整理（先预演可撤回） | Rust 多核零广告压缩包 |
|---|---|
| ![整理文件](https://raw.githubusercontent.com/3347567186/TidyAssistant/main/docs/assets/screenshots/02-organize.png) | ![压缩包](https://raw.githubusercontent.com/3347567186/TidyAssistant/main/docs/assets/screenshots/03-archive.png) |

- **旧版在线升级**：`v1.43.14` 用户直接在软件「设置 → 版本与在线更新」点「立即检查更新」即可 SHA-256 校验并一键升级。
- **完整文档与二次开发**：[官方网站](https://3347567186.github.io/TidyAssistant/) · [README.md](https://github.com/3347567186/TidyAssistant/blob/main/README.md) · [README.en.md](https://github.com/3347567186/TidyAssistant/blob/main/README.en.md)

---

<a id="english-release-notes"></a>

# English Release Notes — TidyAssistant v1.43.15

> **[🌐 Official Website](https://3347567186.github.io/TidyAssistant/?lang=en)** · **[⬇️ Installer (.exe, 20.6 MB)](https://github.com/3347567186/TidyAssistant/releases/download/v1.43.15/TidyAssistant_1.43.15_x64-setup.exe)** · **[📦 Portable (.zip, 25.0 MB)](https://github.com/3347567186/TidyAssistant/releases/download/v1.43.15/TidyAssistant_1.43.15_x64-portable.zip)**

- **Fixed phantom "Thinking" bubble on AI mode switch** (`Read-only / Confirm / Auto / Full Auto`) and wired outside-click / `Escape` / scroll dismissal for `modeMorph`.
- **Fixed slow / stuck AI Stop**: Cross-thread WinHTTP handle close (`AI_CANCEL_EPOCH` + RAII guard) aborts stalled requests in **`0.31 ms`** median (vs. 60–300 s hangs), paired with abortable JS retry backoffs, atomic lock release, and `procs.js` timer leak cleanup.
- **Measured Benchmarks (Ryzen 9 5900HX · Windows 11 x64 · NVMe SSD)**: AI stop **`0.31 ms`** · ZIP 4-tier create **`21.2 → 91.9 → 304.3 MB/s`** (14.4×) · 1,000-file organize **`1.79 s`** / Undo **`1.39 s`** · 10,001-file FTS5 index **`68.4 ms`** / query **`6.53 ms`** · `5.56 MB` shell exe · **362+ automated tests, 0 warnings**.

![TidyAssistant English Runtime UI](https://raw.githubusercontent.com/3347567186/TidyAssistant/main/docs/assets/screenshots/07-en-ai-ui.png)
