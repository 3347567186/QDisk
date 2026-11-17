# 打包与发布

## 命令

在 `D:\Tool\整理助手\07_代码配置\` 下执行（`py -3` 才是装了 PyInstaller 的那个解释器）：

```
py -3 -m PyInstaller --noconfirm --onedir --windowed --name "整理助手" ^
  --hidden-import pypdf --hidden-import docx ^
  --hidden-import pystray --hidden-import pystray._win32 ^
  --collect-data docx --collect-all organize ^
  --collect-all pydantic_core --collect-all pdfminer ^
  --collect-all rich --collect-all docx2txt --collect-all exifread ^
  --icon icon.ico --add-data "rules.json;." --add-data "icon.ico;." tidy.py
```

产物是 `dist\整理助手\` 文件夹：`整理助手.exe` 约 **13.1 MB** + `_internal\` 依赖目录
（`rules.json`、`icon.ico` 也打在里面）。发布时压缩整个文件夹，
zip 里是 `整理助手_b4_便携版\整理助手.exe` 这种一层目录结构，不是裸 exe。

`--onefile` 是 2026-10-30 之前的做法，产物是单个 exe，约 49.5 MB。它在本项目目录下会报
`Could not create temporary directory!`，已停用，来龙去脉见「已知环境坑」。

## 每个参数为什么在

| 参数 | 原因 |
|---|---|
| `--onedir` | 当前用法。产物是文件夹（exe + `_internal\`）：启动不用先解压到临时目录，比 onefile 快，也能在 `D:\Tool\整理助手` 下直接跑 |
| `--onefile`（历史） | 2026-10-30 之前用它做单文件，约 49.5 MB。在本项目目录会报 `Could not create temporary directory!`，已换成 onedir |
| `--windowed` | 不要黑色控制台窗口 |
| `--name "整理助手"` | exe 名，也是任务栏/托盘显示名 |
| `--hidden-import pypdf` `docx` | `extract_text` 里按需 import 的 PDF/docx 解析 |
| `--hidden-import pystray` `pystray._win32` | 托盘是**延迟导入**，静态分析看不到，漏了 `tray_available()` 永远假 |
| `--collect-data docx` | python-docx 的模板文件，漏了读 docx 会崩 |
| `--collect-all organize` | 高级规则页内嵌的 organize 引擎（MIT） |
| `--collect-all pydantic_core` `pdfminer` `rich` `docx2txt` `exifread` | 这几个是 organize 的传递依赖，全收省事 |
| `--icon icon.ico` | 设 exe 自己的图标（资源管理器/任务栏显示的） |
| `--add-data "rules.json;."` | 内置规则打进 exe；旁边放 `rules.json` 仍会优先用外部的 |
| `--add-data "icon.ico;."` | 把图标文件也打进包。少了这条，`_res("icon.ico")` 在 `_MEIPASS`（onedir 里是 `_internal\`）里找不到文件，托盘会退回画一个蓝方块 |

## 几条必须知道的

**入口文件必须叫 `tidy.py`**。叫 `organize.py` 会把同名的 `organize` 包遮蔽掉，
`from organize import Config` 导入到自己，报 `cannot import name 'Config' from 'organize'`。

**`migrate_engine.py` 必须和 `tidy.py` 同级**。PyInstaller 顺着 `import migrate_engine`
自动收进 exe，不用额外参数。删掉它 exe 仍能构建，但迁移页会提示「组件缺失」。

**onedir 的 exe 离不开 `_internal\`**。发布、拷贝、替换发布文件夹时都是整个
`dist\整理助手\` 一起动，只拷 exe 打不开。`数据位置.json` 写在 exe 旁边、跟着文件夹走，
但不进发布包。

**打包解释器固定 3.14.6**（PyInstaller 6.22.3）。3.11 能跑源码，但产物和测试环境不一致，
出问题难复现。

**`build/`、`dist/`、生成的 `.spec`** 都是中间产物，发布后可以删。

## 发布流程

```bash
cd "D:/Tool/整理助手/07_代码配置"

# 1. 语法 + 回归
py -3 -m py_compile tidy.py
py -3 -m unittest test_settings_dir test_app_guard test_migrate_engine

# 2. 备份旧发布文件夹（带上时间戳，出事能退；第一次发没有就跳过）
mv ../发布/整理助手_b4_便携版 ../发布/整理助手_b4_便携版.bak-$(date +%Y%m%d-%H%M)

# 3. 打包
py -3 -m PyInstaller --noconfirm --onedir --windowed --name "整理助手" ...

# 4. 用整个文件夹替换发布内容
rm -rf ../发布/整理助手_b4_便携版
cp -r dist/整理助手 ../发布/整理助手_b4_便携版

# 5. 清中间产物
rm -rf build dist 整理助手.spec __pycache__
```

第 4 步之后必须验证，不能省。源码跑通不等于包跑通：托盘（延迟导入）、
`migrate_engine`（同级文件）、`rules.json` 与 `icon.ico`（add-data）、`_internal\`
里缺文件，这几处都只在打包后才暴露。

验证方式：把 `发布\整理助手_b4_便携版\` 整个拷到工作区外的空目录（本机是
`D:\Tool\apprun\`），再把 `_test_exe.py`、`_test_exe_close.py` 放到 exe 同一层跑
—— 这两个脚本按自己所在目录找 `整理助手.exe`。跑完把脚本删掉，别带进发布包。
onedir 在工作区里也能启动，但交付前按工作区外那份实测。

## 已知环境坑：onefile 解压临时目录报错（已用 onedir 规避）

onefile 启动时要先把自身解压到一个临时目录。2026-10-30 夜里在 `D:\Tool\整理助手\`
遇到过：任何 onefile exe 放进这个目录都报

```
[PYI-xxxxx:ERROR] Could not create temporary directory!
```

同一份二进制（md5 一致）放到 `D:\Tool\整理助手2\`、`D:\Tool\测试\`、`C:\Temp\` 都能跑；
把这个目录里的**旧版本** exe 放回去也一样失败；用计划任务启动同样失败。

已排除：磁盘空间、路径含中文、`TEMP` 指向、`--runtime-tmpdir` 指定可写目录、文件 ACL 差异、
杀毒软件（实时保护本身是关的）。目录被 DSH 的沙箱加过 ACL（`S-1-4-*` 授权 +
`Everyone` 拒绝删除子项），但去掉 deny 后仍然失败，已还原。根因没定位到，
判断是这台机器的目录环境问题，和代码无关。

结论（2026-10-30 起）：

- 发布形态改成 `--onedir`，启动时不再解压到临时目录，这道坑绕开了。
  当前 onedir 版在 `D:\Tool\整理助手\` 下能直接跑
- onedir 还顺带更快：不用每次启动先解压；exe 本身也小很多（13.1 MB 对 49.5 MB），
  代价是旁边多一个 `_internal\` 目录，必须一起分发
- 给用户的运行副本仍放在工作区外（本机是 `D:\Tool\apprun\`），自带 `数据\` 目录 ——
  这是交付习惯，不是启动必需

再遇到时的处理顺序：

1. 先确认是不是目录问题：把整个 `dist\整理助手\` 拷到 `D:\Tool\<临时目录>\` 试，
   能跑就说明是目录环境
2. 保持 onedir 构建，不要退回 `--onefile`
3. 交付验证按「发布流程」里说的，在工作区外那份上做

## 回滚

| 想退什么 | 怎么退 |
|---|---|
| exe | onedir 是整个文件夹：把 `整理助手_b4_便携版.bak-<时间戳>\` 改回 `整理助手_b4_便携版\`。2026-10-30 之前的 onefile 单文件备份（`整理助手.exe.bak-20261030-1212`，49.5 MB）还能用，但在本项目目录下起不来，得放到工作区外 |
| 源码 | 项目里有一串 `tidy.py.bak*` 快照，按时间挑一个覆盖回去 |
| 只是某个行为 | 看 `变更记录.md` 里对应版本的「改法」，通常是几行，手工反向改 |

当前保留的源码快照：

```
tidy.py.bak4-before-tray-cache-fix   349036 字节   托盘/缓存修复之前
tidy.py.bak5-before-unpin-verify     托盘钉子改「可验证」之前
tidy.py.bak6-before-close-choice     关窗三态之前（324663 字节）
tidy.py.bak7-before-traypin          托盘位置三态之前
```

## 开机自启

计划任务 `整理助手_开机自启`，动作是 `"D:\Tool\整理助手\整理助手.exe" --tray`，
强模式（HIGHEST），登录时不弹窗。设置页「开机自启与后台运行」可以开关它，
也可以在「任务计划程序」里手工看。

自启走的是 `--tray` 分支：先 `withdraw()` 再建控件，全程不显窗；
托盘起不来会兜底显窗并写 `数据\tray.log`，不会留下叫不出来的进程。

## 交付物：两个 zip

发布包放在项目里的 `发布\` 目录，每次发版重新生成，别手工拷。

| 包 | 内容 | 给谁 |
|---|---|---|
| `整理助手_b4_便携版_20261113.zip` | 解压后是一个 `整理助手_b4_便携版\` 文件夹：`整理助手.exe`、`_internal\`、`icon.ico`、`rules.json`、`说明.md`、`第三方许可.txt`、`首次使用.txt` | 只想用的人。解压即用，不安装、不写注册表 |
| `整理助手_b4_源码与开发文档_20261113.zip` | 根目录 `整理助手_b4_源码与开发文档\`：`tidy.py`、`migrate_engine.py`、`test_app_guard.py`、`test_migrate_engine.py`、`test_settings_dir.py`、`rules.json`、`icon.ico`、`说明.md`、`第三方许可.txt`、`开发文档\` | 要改代码或查实现的人 |

`数据\` 不进包，首次运行自动生成；`数据位置.json` 也不进包，它记的是本机数据目录的
绝对路径，只在当前这台机器上有意义。换机器想带走历史，把旧机器上的整个数据目录拷过去，
再在设置里把数据目录指过去（程序会问要不要迁移）。`tidy.py.bak*` 和各种 `_probe_*.py`
也不进包 —— 那是本机快照和一次性脚本。

### 怎么生成

1. 确认 `dist\整理助手\` 是刚打出来的那份：`整理助手.exe` 约 13.1 MB、时间戳是刚才，
   别拿上一次的 `dist`
2. 便携版：把 `dist\整理助手\` 整个 copy 成 `整理助手_b4_便携版\`（exe 和 `_internal\`
   必须一起），再补 `说明.md`、`首次使用.txt`；`icon.ico`、`rules.json` 已经在里面
3. 源码包：按上表清单 copy 到 `整理助手_b4_源码与开发文档\`，`开发文档\` 整个 copytree
4. 用 `zipfile.ZipFile(..., "w", ZIP_DEFLATED)` 打包，压的是外层文件夹，
   所以 zip 里先是一层 `整理助手_b4_便携版\`，再是 `整理助手.exe` 与 `_internal\`
5. 解压到工作区外的空目录实测：窗口能出来、旁边自动生成 `数据\`、
   `数据\tray.log` 出现 `tray_pin mode=... wrote=1 bad=[]`、关窗后进程还在但窗口消失；
   再点一次「保存设置」、迁移选「否」，确认设置生效
6. 删掉解压出来的临时目录，只留两个 zip

第 5 步不能省：发布包要在工作区外解压实测，工作区里那份只算冒烟。
onedir 虽然能在工作区跑，交付前仍按工作区外那份验证。

## 交付物清单（目录视角）

```
整理助手.exe          13.1 MB，必须和 _internal\ 一起分发
_internal\            依赖目录，缺了 exe 起不来
rules.json            可选，放旁边就覆盖内置规则
icon.ico              图标，和 rules.json 同层
说明.md               用户手册
第三方许可.txt        organize / pypdf / python-docx 等的许可证
开发文档\             给看代码的人
数据位置.json         首次运行 / 改数据目录后生成，不进包
发布\                 两个 zip，发版产物
```
