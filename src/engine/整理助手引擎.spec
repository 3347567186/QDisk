# -*- mode: python ; coding: utf-8 -*-
"""引擎打包配置。

原则：只打「RPC 服务真正会走到」的东西。
- 界面半边（tkinter / pystray）已由 Tauri 外壳接管，引擎里那些函数不会被调用；
- pdfminer / docx2txt 在 tidy.py 与 organize 里都零引用；
- 注意：rich / exifread / pydantic / yaml / jinja2 / arrow / natsort / dateutil
  虽然 tidy.py 自己不 import，但 `import organize` 会立刻拉起它们（实测 sys.modules），
  排掉任何一个，rules.* 就会报「未集成 organize 引擎」。
- cryptography 只被 pypdf 用于「加密 PDF」这一种边缘情况，缺了会抛异常而不是崩，
  为了 18 MB 的体积不值得留。
"""
from PyInstaller.utils.hooks import collect_data_files, collect_submodules

datas = [('rules.json', '.'), ('icon.ico', '.')]
binaries = []
# pypdf/docx 是 tidy.py 顶部按需导入的，PyInstaller 静态分析抓不到，必须显式列。
hiddenimports = ['migrate_engine', 'pypdf', 'docx', 'docx.opc.parts.coreprops',
                 'send2trash', 'send2trash.win']
# 高级规则（rules.*）走 organize-tool。tidy.py 里是函数内 import，静态分析抓不到；
# action/filter 又是按名字动态注册的，必须整包收进去，否则运行期 No module named 'organize'。
# organize 依赖 pydantic（配置校验），所以上面 excludes 里不能再排掉 pydantic/pydantic_core。
hiddenimports += collect_submodules('organize')
# hashlib 的内置实现是在函数里 __import__ 的，PyInstaller 一个都找不到；
# 平时靠 _hashlib(OpenSSL) 顶着，一旦排掉 _hashlib 就必须显式带上这几个，
# 否则 hashlib.sha1 直接抛 ValueError（app_icon_png 会因此静默失效）。
hiddenimports += ['_sha1', '_sha256', '_sha512', '_md5', '_blake2']
# python-docx 需要一个默认模板才能新建文档
datas += collect_data_files('docx')

a = Analysis(
    ['tidy.py'],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # 界面半边：由外壳负责
        'tkinter', 'pystray', '_tkinter',
        # tidy.py 里零引用，且 organize 也不引用
        'pdfminer', 'docx2txt',
        # pypdf 的可选加密支持（体积 18 MB）
        'cryptography', 'cryptography.hazmat',
        'charset_normalizer',
        # 引擎全程不联网。实测跑完 27 个 RPC 方法，sys.modules 里没有
        # ssl / _ssl / http / socket —— 唯一沾边的是 urllib.parse，它不依赖 ssl。
        # 排掉 ssl 连带去掉 libssl(1.5 MB)；libcrypto 由 _hashlib 拖着，见下。
        # 注意不要顺手排 socket / select / asyncio：multiprocessing 的启动钩子
        # 会 import socket，排掉之后引擎连 ping 都起不来。
        'ssl', '_ssl',
        # hashlib 实际只用到 sha1 与 blake2b，两者是 python311.dll 里的内置模块
        # （sys.builtin_module_names 可见），不需要 OpenSSL 的 _hashlib（它拖着 libcrypto 7.6 MB）。
        # 代价：hashlib.pbkdf2_hmac / scrypt 不可用——引擎里没人调。
        '_hashlib',
        # 明显无关的科学栈
        # 注意：lxml 不能排——python-docx 靠它解析 XML，排掉之后 .docx 抽文本会静默返回空。
        # 但 lxml.objectify / lxml.html / pythonwin / win32ui 引擎零引用，可安全剥离（省 ~3.2 MB）
        'lxml.objectify', 'lxml.html', 'pythonwin', 'win32ui',
        'numpy', 'pythonnet', 'clr', 'pandas', 'matplotlib',
        'scipy', 'cv2', 'IPython', 'pytest', 'sqlalchemy', 'setuptools',
    ],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='整理助手引擎',
    debug=False,
    bootloader_ignore_signals=False,
    strip=True,
    upx=True,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=['icon.ico'],
)

# PIL 的插件是按需加载的二进制，excludes 管不住，单独筛一遍。
# 截图与图标已全面走 Windows 原生 Shell / GDI，不再需要 _imagingft / AVIF 等扩展；
# 保留 _imaging.pyd 供 pypdf 顶层 import 兼容，剥离其余零引用扩展（共减 ~5.4 MB）。
DROP_BIN = (
    '_avif', '_imagingcms', '_imagingmath', 'imageqt', '_imagingtk',
    '_imagingft', 'objectify', 'win32ui', '_difflib', 'html\\diff'
)
binaries_kept = [b for b in a.binaries if not any(k in b[0].lower() for k in DROP_BIN)]

coll = COLLECT(
    exe,
    binaries_kept,
    a.datas,
    strip=True,
    upx=True,
    upx_exclude=[],
    name='整理助手引擎',
)
