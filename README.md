# 整理助手

把散落一地的文件按类型就地收进分类子文件夹的小工具，同时内置压缩包浏览、解压与创建。
Tauri（Rust + WebView2）外壳，整理逻辑在随包的 Python 引擎里，压缩核心在 Rust 进程内。

- 运行副本：本目录 `tidy-assistant.exe`
- 源码：`src\`（`src-tauri` Rust 外壳 / `web` 前端 / `engine` Python 引擎）
- 文档：`docs\01-当前版\`
- 安装包：`release\TidyAssistant_<版本>_x64-setup.exe`
- 用户数据：`%LOCALAPPDATA%\整理助手数据`
- 版本号：见 `src\src-tauri\tauri.conf.json`；管理规则见 `docs\01-当前版\版本管理与发布规范.md`

## 直接运行

双击 `tidy-assistant.exe`。整个目录可搬到任意**纯英文路径**下，路径含中文 WebView2 起不来。

## 压缩包

侧栏「压缩包」页支持：

- **查看**：ZIP/ZIPX、7Z、RAR/RAR5、TAR、TAR.GZ/TGZ、TAR.BZ2/TBZ2、TAR.XZ/TXZ、
  GZ、BZ2、XZ；目录内浏览、名称筛选、排序、右键解压选中、双击预览。
- **预览**：文本（2 MiB 上限）、二进制十六进制（4 MiB）、图片、PDF、音频、视频。
- **解压**：选中条目或全部；覆盖策略支持覆盖/跳过/自动改名；拒绝路径穿越、
  绝对路径、盘符、UNC、NTFS ADS 与设备保留名。
- **创建**：ZIP（Deflate-6、可选 AES-256）、7Z（LZMA2、可选 AES-256）、TAR、TAR.GZ。
- **四档性能模式**：节约（1 线程）、平衡（2 线程）、高性能（4 线程）、超线程（8 线程）。
  仅影响 7Z，ZIP/TAR 固定单线程以控制内存。

RAR 读取使用 RARLAB 官方 UnRAR64.dll。该 DLL 不随安装包分发，首次打开 RAR 时
自动下载并校验 SHA-256；网络不可用或校验失败时只禁用 RAR，不影响其他格式。
许可与校验值见 `THIRD_PARTY.md`。

## 重新构建

```powershell
.\build.ps1                    # 重建 exe
.\build.ps1 -Bump patch        # 版本号 +1 后重建（修 bug 用 patch，新功能用 minor）
.\build.ps1 -Bundle -Portable  # 出安装包 + 便携包，自动只留最新与上一版
.\build.ps1 -Engine            # 只重建 Python 引擎
```

依赖：`gnu-d` Rust 工具链、`D:\Tool\binutils\mingw64`、`py -V:Astral\CPython3.11.15` +
PyInstaller 6.22.3。细节见 `docs\01-当前版\打包与发布.md`。

## 目录

```
TidyAssistant\
├── tidy-assistant.exe
├── WebView2Loader.dll
├── 引擎\                    运行用引擎（exe + _internal）
├── src\
│   ├── src-tauri\           Rust 外壳 + 压缩核心
│   ├── web\                 前端 10 页
│   └── engine\              Python 引擎源码
├── docs\                    01-当前版 / 02-历史-旧版
├── release\                 安装包
├── tools\                   cargo-tauri.exe
├── build.ps1
└── AGENTS.md                给 AI 会话的指路说明
```
