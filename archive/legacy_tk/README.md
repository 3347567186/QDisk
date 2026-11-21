# TidyAssistant 遗留 Tkinter 界面归档说明 (Legacy Tkinter GUI Archive)

## 1. 归档背景与原因

整理助手 (TidyAssistant) 最早基于 Python Tkinter + ttk 开发单体桌面 GUI。
在 **v1.40+** 版本中，项目完成了整体架构现代化演进，全面拥抱 **Tauri (Rust 宿主 + WebView2 + 现代化 Web 前端)** 架构：
- 前端交互、动效、多标签页、目录树浏览、实时搜索、AI 智能助手等全部由 Web 前端与 Rust 外壳提供。
- Python 引擎降级为纯净的无界面 RPC 后端 (`tidy.py --engine`) 以及无头 CLI / 计划任务执行器 (`run_cli`, `run_scheduled`)。
- 在打包脚本 `整理助手引擎.spec` 中，`excludes` 早已显式剔除了 `tkinter`、`_tkinter` 与 `pystray`。在正式发布的安装包与便携包中，Tkinter 模块根本未打包入二进制分发包中。
- 保留在 `src/engine/tidy.py` 中的 7,000 余行 Tkinter UI 代码与事件循环不仅在生产环境中不可达（Ghost Path），更严重污染了后端引擎的单一职责，增加了维护者认知负担与代码体积。

因此，自 **1.42.10** 起，将这部分历史 UI 代码永久归档于此。

---

## 2. 归档内容清单

`legacy_gui.py` 包含以下历史代码模块与实现：
1. **主界面与事件循环**:
   - `run_gui(prefill=None, tray_only=False)`: 包含 4,600+ 行完整的 Tkinter 主窗口构建、左侧分类树、右侧计划列表、监控轮询、规则配置、系统托盘管理等历史逻辑。
2. **辅助对话框与交互组件**:
   - `_ask_close_action(master)`: 退出/最小化到托盘询问对话框。
   - `_preview_file(master, path, siblings, ...)`: 基于 Tkinter Canvas 的图片/文本多格式预览窗口（支持滚轮缩放、上下翻页、平移与原地删除）。
   - `_rules_help(master)`: 规则配置语法帮助窗口。
3. **图像处理与缩略图辅助**:
   - `_fallback_icon`, `thumb_photo`, `rgb_to_photo`, `pil_photo`, `load_image_photo`, `shot_icon` 等针对 Tkinter `PhotoImage` 适配的缩略图生成与转换辅助函数。

---

## 3. 如何隔离与独立参考

若后续需要参考历史交互细节或复用特定的 Windows 平台底层算法（如 WIC 解码、GDI+、Shell 缩略图等）：
- **可复用的平台算法**：现代引擎已在 `src/engine/tidy.py` 中保留了生成 PNG 二进制数据供 Web 前端消费的接口（如 `_shell_thumb_png`, `shot_thumb_png`, `app_icon_png` 等），无需依赖 Tkinter。
- **运行历史 UI**：若在已安装完整 Python + Tkinter 的独立环境中调试历史界面，可将 `legacy_gui.py` 作为独立脚本运行或引入，但请注意其依赖 `src/engine/` 中的规则与配置函数。

---

## 4. 架构契约与边界

- **`src/engine/tidy.py` 的职责定义**：
  - 作为 RPC 引擎：通过标准输入输出处理 JSON-RPC 请求 (`--engine`)。
  - 作为命令行工具：执行无头整理 (`run_cli`)、定时任务 (`run_scheduled`)、截图清理 (`--clean-shots`)、缓存清理 (`--clean-cache`)、撤销 (`--undo`) 等。
  - `run_gui()` 在 `tidy.py` 中仅保留兼容 Stub，如被意外调用将输出标准错误提示并安全返回，不再拉起 Tkinter 主循环。
- **图形界面所有权**：
  - 100% 由 `src-tauri` (Rust) 与 `src/web/` (HTML5/CSS3/ESM) 全权掌控。
