# -*- coding: utf-8 -*-
"""
整理助手 — 就地分类收纳工具
--------------------------------
只把「散落在文件夹里的文件」按类型移入分类子文件夹。
不删除任何文件，不动已有子文件夹，不碰程序目录 / 代码工程 / 源码目录 / 系统目录。

命令行：  整理助手-命令行.exe <文件夹>               预演
          整理助手-命令行.exe <文件夹> --apply       执行
          整理助手-命令行.exe <文件夹> --undo        撤销上次
          整理助手-命令行.exe <文件夹> --recursive   递归子目录
          整理助手-命令行.exe <文件夹> --force       跳过程序/工程/源码拦截
          整理助手-命令行.exe <文件夹> --csv 路径    导出预演结果
          整理助手-命令行.exe <文件夹> --date        按 %Y/%m 分目录
          整理助手-命令行.exe <文件夹> --on-conflict skip|rename|overwrite
不加参数：  打开图形界面
"""
import array
import csv
import ctypes
import datetime
import io
import contextlib
import json
import math
import os
import queue
import re
import shutil
import stat
import subprocess
import sys
import threading
import time
import traceback
import hashlib
import struct
import zlib

# ── 数据迁移引擎（独立模块，缺失时界面降级，不影响其它功能）──
try:
    import migrate_engine as MIG
except Exception:                      # noqa: BLE001
    MIG = None

# ── 规则文件定位 ──
if getattr(sys, "frozen", False):
    HERE = os.path.dirname(sys.executable)
    BUNDLE_DIR = getattr(sys, "_MEIPASS", HERE)
else:
    HERE = os.path.dirname(os.path.abspath(__file__))
    BUNDLE_DIR = HERE

EXTERNAL_RULES = os.path.join(HERE, "rules.json")
BUNDLED_RULES = os.path.join(BUNDLE_DIR, "rules.json")


def resolve_rules():
    if os.path.exists(EXTERNAL_RULES):
        return EXTERNAL_RULES, "外部 rules.json"
    if os.path.exists(BUNDLED_RULES):
        return BUNDLED_RULES, "内置规则"
    return EXTERNAL_RULES, "缺失"


RULES_PATH, RULES_SOURCE = resolve_rules()

# ── 设置（便携模式：配置与数据跟 exe 放一起，目录不可写时退回用户目录）──
def _writable(d):
    try:
        os.makedirs(d, exist_ok=True)
        probe = os.path.join(d, ".wtest")
        with open(probe, "w") as f:
            f.write("x")
        os.remove(probe)
        return True
    except Exception:
        return False


_PORTABLE_DATA = os.path.join(HERE, "数据")
_LEGACY_DATA = os.path.join(os.environ.get("LOCALAPPDATA", HERE), "整理助手")
# 数据目录的「指针」文件：记录用户把数据搬到哪了（配置跟着数据走，详见 save_settings）
DATA_LOCATOR_NAME = "数据位置.json"


def _locator_candidates():
    """指针文件可能落在两处：exe 旁边（便携）、用户目录（程序目录不可写）。"""
    return [os.path.join(HERE, DATA_LOCATOR_NAME),
            os.path.join(_LEGACY_DATA, DATA_LOCATOR_NAME)]


def read_data_locator():
    """读数据目录指针。返回 (data_dir, 状态)。

    状态：
      "ok"      指针存在且目录还在
      "missing" 指针存在但目录不在了（盘没接 / 被删 / 被改名）
      "none"    没有指针（老版本，或从没改过数据目录）
    """
    for p in _locator_candidates():
        try:
            with open(p, encoding="utf-8-sig") as f:
                raw = (json.load(f) or {}).get("data_dir")
        except Exception:
            continue
        if not isinstance(raw, str) or not raw.strip():
            continue
        d = os.path.normpath(os.path.expandvars(raw.strip()))
        return (d, "ok") if os.path.isdir(d) else (d, "missing")
    return (None, "none")


def write_data_locator(d):
    """把数据目录写进指针文件；优先 exe 旁边，写不了退用户目录。失败返回空串。"""
    body = {"data_dir": os.path.normpath(d),
            "updated": time.strftime("%Y-%m-%d %H:%M:%S")}
    for p in _locator_candidates():
        try:
            os.makedirs(os.path.dirname(p), exist_ok=True)
            tmp = p + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(body, f, ensure_ascii=False, indent=1)
            os.replace(tmp, p)
            return p
        except Exception:
            continue
    return ""


def _dir_writable(d):
    """试写一个探针文件判断能不能写；不建正式文件，也不弹窗。"""
    try:
        os.makedirs(d, exist_ok=True)
        probe = os.path.join(d, ".wtest")
        with open(probe, "w") as f:
            f.write("x")
        os.remove(probe)
        return True
    except Exception:
        return False


def settings_paths_for(d):
    """数据目录 d 对应的 (配置目录, settings.json 路径)。

    配置放在 <数据目录>\配置 下 —— 数据目录搬到哪，配置跟到哪；
    数据目录不可写时退回 %APPDATA%\整理助手，保证设置永远存得下。
    """
    sd = os.path.join(d, "配置")
    if _dir_writable(sd):
        return sd, os.path.join(sd, "settings.json")
    fb = os.path.join(os.environ.get("APPDATA", HERE), "整理助手")
    return fb, os.path.join(fb, "settings.json")


_LOCATOR_SAID, _LOCATE_STATE = read_data_locator()
# 指针指向的目录没了：不当场改写指针，启动后提示用户，避免把用户的选择悄悄抹掉
LOCATOR_BROKEN = _LOCATE_STATE == "missing"
LOCATOR_DATA = _LOCATOR_SAID if _LOCATE_STATE == "ok" else None
DEFAULT_DATA = LOCATOR_DATA or (_PORTABLE_DATA if _writable(_PORTABLE_DATA) else _LEGACY_DATA)

SETTINGS_DIR, SETTINGS_PATH = settings_paths_for(DEFAULT_DATA)

DEFAULT_SETTINGS = {
    "data_dir": DEFAULT_DATA,
    "cache_dir": "",
    "conflict_policy": "rename",
    # 关窗行为：tray 最小化到托盘 / exit 直接退出 / ask 每次询问
    "close_action": "tray",
    "close_choice_made": False,
    "close_to_tray": True,          # 旧版本字段，保留兼容
    "tray_enabled": True,
    # 托盘图标位置：taskbar 固定在任务栏 / overflow 只放折叠区 / system 跟随系统
    "tray_pin": "taskbar",
    "default_recursive": False,
    "default_content": True,
    "recursive_depth": 3,
    "log_keep_days": 30,
    "everything_path": "",
    "index_roots": [],
    # ── 截图清理 ──
    "shot_dirs": [],
    "shot_keep_days": 7,
    "shot_min_kb": 0,
    "shot_all_images": False,
    "shot_auto": False,
    "shot_time": "23:30",
    "shot_to_trash": True,
    # ── 缓存清理 ──
    "cache_custom_dirs": [],
    "cache_auto": False,
    "cache_time": "23:40",
    "cache_to_trash": False,
    # ── 索引新鲜度 ──
    # 后台空闲时抽查索引、发现确实过期就重建。默认开：不开的话用户永远
    # 得手动点「重建索引」，而那正是他不想做的事。
    "index_rebuild_idle": True,
    # 索引占用上限（MB）。超了只保留最近用过的根，其余等用户手动重建。
    "index_max_mb": 2048,
    # 索引新鲜度档位：live（跟随热目录）/ check（启动 + 定时抽查）/ manual
    "index_freshness": "check",
}

# 启动时发现设置里的数据目录不在了（盘没接 / 被删），置 True，界面起来后提示一次
DATA_DIR_MISSING = False


def load_settings():
    s = dict(DEFAULT_SETTINGS)
    try:
        if os.path.exists(SETTINGS_PATH):
            with open(SETTINGS_PATH, encoding="utf-8-sig") as f:
                s.update(json.load(f) or {})
    except Exception:
        pass
    # 旧版本只有 close_to_tray 布尔值：映射成三态，别让老用户的设置丢掉
    if s.get("close_action") not in ("tray", "exit", "ask"):
        s["close_action"] = "tray" if s.get("close_to_tray", True) else "exit"
        # 老用户没做过这个选择，第一次关窗问一次（问完记 close_choice_made）
        s["close_choice_made"] = False
    if s.get("tray_pin") not in ("taskbar", "overflow", "system"):
        # 老版本没有这个键：默认放任务栏 —— 以前那版会强制钉住，
        # 结果用户找不到图标，以为程序没在后台跑
        s["tray_pin"] = "taskbar"
    # 数据目录被删了 / 移动硬盘没接：退回默认目录，不然启动后所有写入都失败
    global DATA_DIR_MISSING
    _dd = s.get("data_dir")
    if _dd and not os.path.isdir(_dd):
        s["data_dir"] = DEFAULT_DATA
        DATA_DIR_MISSING = True
    return s


def save_settings(s):
    """保存设置。配置跟着数据目录走：写到 <数据目录>\\配置，并更新指针文件。

    以前配置永远钉在「最早的那个数据目录」里，旧目录一删设置就丢，
    表现出来就是「数据目录改了、重启又变回去」。
    """
    global SETTINGS_DIR, SETTINGS_PATH
    try:
        d = os.path.normpath(s.get("data_dir") or DEFAULT_DATA)
        sd, sp = settings_paths_for(d)
        os.makedirs(sd, exist_ok=True)
        tmp = sp + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(s, f, ensure_ascii=False, indent=1)
        os.replace(tmp, sp)
        SETTINGS_DIR, SETTINGS_PATH = sd, sp
        write_data_locator(d)
        return True
    except Exception:
        return False


S = load_settings()


def data_dir():
    return S.get("data_dir") or DEFAULT_DATA


def cache_dir():
    d = S.get("cache_dir")
    if d:
        return d
    return os.path.join(data_dir(), "cache")


def hist_dir():
    return os.path.join(data_dir(), "history")


def log_dir():
    return os.path.join(data_dir(), "logs")


def backup_dir():
    return os.path.join(data_dir(), "卸载备份")


def mig_jobs_dir():
    """数据迁移页的任务目录；跟着数据目录走，别写死成启动时那份路径。"""
    return os.path.join(data_dir(), "迁移")


def check_data_dir(path, old=None):
    """数据目录准入判定。None = 可以用，否则返回拒绝原因。

    以前这里什么都不校验：填个盘符根、填成程序目录也能「保存成功」，
    然后历史/日志/缓存就散到不该去的地方。
    """
    if not path:
        return "数据目录不能为空"
    try:
        p = os.path.normpath(os.path.abspath(os.path.expandvars(path)))
    except Exception:
        return "路径不合法：%s" % path
    if is_drive_root(p):
        drive, _tail = os.path.splitdrive(p)
        return "%s\\ 是盘符根目录，数据目录不能直接放在根目录" % drive
    if os.path.isfile(p):
        return "这个路径是文件，不是目录：\n%s" % p
    if os.path.normcase(p) == os.path.normcase(os.path.abspath(HERE)):
        return "这是程序所在目录，数据不能直接放在程序目录里\n（可以放它的子目录，比如 数据\\）"
    if old:
        try:
            o = os.path.normcase(os.path.abspath(old))
            if os.path.normcase(p).startswith(o + os.sep):
                return "新数据目录不能放在旧数据目录里面：\n%s" % p
        except Exception:
            pass
    if not _dir_writable(p):
        return "这个目录不能写（权限不足或磁盘不可写）：\n%s" % p
    return None


MANIFEST_TXT = "_整理记录.txt"

FILE_ATTRIBUTE_SYSTEM = 0x4
FILE_ATTRIBUTE_REPARSE_POINT = 0x400


# ─────────────────────────── 规则 ───────────────────────────

class Rules:
    def __init__(self, d):
        self.ext_to_cat = {}
        for c in d["categories"]:
            for e in c["exts"]:
                self.ext_to_cat[e.lower()] = c["name"]
        self.cat_order = [c["name"] for c in d["categories"]]
        self.fallback = d.get("fallback", "15_其他")

        self.never_exts = {e.lower() for e in d.get("never_move_exts", [])}
        self.never_names = {n.lower() for n in d.get("never_move_names", [])}
        self.never_prefixes = tuple(p.lower() for p in d.get("never_move_prefixes", []))

        self.rt_exts = {e.lower() for e in d.get("program_runtime_exts", [])}
        self.sig_dirs = {x.lower() for x in d.get("program_signature_dirs", [])}
        self.sig_files = {x.lower() for x in d.get("program_signature_files", [])}
        self.rt_threshold = int(d.get("program_runtime_threshold", 3))

        # ── 程序目录保护：程序安装目录一律不动（不整理/不搬走/不合并/不清空）──
        self.protect_app_dirs = bool(d.get("protect_app_dirs", True))
        self.app_uninstallers = {x.lower() for x in d.get("app_dir_uninstallers", [])}
        self.app_markers = {x.lower() for x in d.get("app_dir_markers", [])}
        self.app_min_exe = int(d.get("app_dir_min_exe", 1))
        self.app_scan_max = int(d.get("app_dir_scan_max", 600))
        self.app_container_min = int(d.get("app_container_min", 2))
        self.app_uninstall_dirs = {x.lower() for x in d.get("app_dir_uninstall_dirs", [])}

        # ── 缓存清理保护 ──
        self.cache_forbid_roots = bool(d.get("cache_custom_forbid_drive_roots", True))
        self.cache_forbid_apps = bool(d.get("cache_custom_forbid_app_dirs", True))
        self.cache_custom_max_depth = int(d.get("cache_custom_max_depth", 6))
        self.cache_skip_apps = bool(d.get("cache_skip_app_subtrees", True))
        self.cache_keep_exts = {e.lower() for e in d.get("cache_never_delete_exts", [])}

        self.project_markers = {x.lower() for x in d.get("project_markers", [])}
        self.refuse_projects = bool(d.get("refuse_project_folders", True))

        self.source_exts = {e.lower() for e in d.get("source_file_exts", [])}
        self.source_threshold = int(d.get("source_threshold", 5))

        self.protected = [os.path.normcase(os.path.abspath(p)) for p in d.get("protected_paths", [])]
        self.protected_parts = [p.lower() for p in d.get("protected_name_parts", [])]
        self.refuse_drive_roots = bool(d.get("refuse_drive_roots", True))
        self.refuse_unc = bool(d.get("refuse_unc_paths", True))
        self.cloud = [x.lower() for x in d.get("refuse_cloud_syncs", [])]
        self.max_depth = int(d.get("max_path_depth", 8))
        self.max_len = int(d.get("max_path_length", 240))

        self.max_files = int(d.get("max_files_per_run", 2000))
        self.min_age = int(d.get("min_age_minutes", 10)) * 60
        self.min_files = int(d.get("min_files_to_organize", 3))

        self.allow = [os.path.normcase(os.path.abspath(p)) for p in d.get("allow_paths", [])]
        self.block = [os.path.normcase(os.path.abspath(p)) for p in d.get("block_paths", [])]

        self.prune_dirs = {x.lower() for x in d.get("recursive_prune_dirs", [])}
        self.drive_skip = {x.lower() for x in d.get("drive_root_skip", [])}
        self.rec_max_depth = int(d.get("recursive_max_depth", 3))
        self.cat_names = set(self.cat_order) | {self.fallback}

        self.conflict_policy = d.get("conflict_policy", "rename").lower()
        self.date_subfolder = d.get("date_subfolder", "") or ""

        cc = d.get("content_classify", {}) or {}
        self.content_enabled = bool(cc.get("enabled", False))
        self.content_exts = {e.lower() for e in cc.get("extensions", [])}
        self.content_max_bytes = int(cc.get("max_file_mb", 20)) * 1024 * 1024
        self.content_max_files = int(cc.get("max_files_per_run", 800))
        self.content_max_chars = int(cc.get("max_chars", 4000))
        self.content_min_score = int(cc.get("min_score", 4))
        self.content_rules = [
            (r["category"],
             {k.lower() for k in r.get("keywords", [])},
             {k.lower() for k in r.get("strong", [])})
            for r in cc.get("rules", [])
        ]
        for c, _, _ in self.content_rules:
            if c not in self.cat_order:
                self.cat_order.append(c)

        self.allow_drive_root_rec = bool(d.get("allow_drive_root_recursive", False))
        sch = d.get("schedule", {}) or {}
        self.task_name = sch.get("task_name", "整理助手_定时扫描")
        self.default_time = sch.get("default_time", "22:00")

    def category(self, name):
        return self.ext_to_cat.get(os.path.splitext(name)[1].lower(), self.fallback)


def load_rules():
    if not os.path.exists(RULES_PATH):
        raise SystemExit(f"找不到规则文件：{RULES_PATH}")
    with open(RULES_PATH, encoding="utf-8-sig") as f:
        return Rules(json.load(f))


# ─────────────────────────── 安全边界 ───────────────────────────

def norm(p):
    return os.path.normcase(os.path.abspath(p))


def check_target(folder, rules, allow_root=False):
    if folder.startswith("\\\\") and rules.refuse_unc:
        return "网络路径（\\\\server\\share）不支持整理"
    if not os.path.isdir(folder):
        return "文件夹不存在或不可访问"

    p = norm(folder)

    for b in rules.block:
        if p == b or p.startswith(b + os.sep):
            return "该路径在自定义黑名单 rules.json → block_paths 中"
    if rules.allow and not any(p == a or p.startswith(a + os.sep) for a in rules.allow):
        return "当前路径不在白名单 rules.json → allow_paths 中"

    for prot in rules.protected:
        if p == prot or p.startswith(prot + os.sep):
            return f"系统目录：{prot}"

    low = p.lower()
    # 补一个尾部分隔符，这样「路径本身就叫 AppData」也能命中 \appdata\ 规则
    low_cmp = low if low.endswith(os.sep) else low + os.sep
    for part in rules.protected_parts:
        if part.lower() in low_cmp:
            return "路径位于受保护区域：" + part.strip("\\")

    for c in rules.cloud:
        if c in low:
            return f"云同步目录（{c}）不整理，避免同步冲突"

    drive, tail = os.path.splitdrive(p)
    if rules.refuse_drive_roots and not tail.strip(os.sep):
        if not (allow_root and rules.allow_drive_root_rec):
            return f"{drive}\\ 是盘符根目录，请选它下面的具体文件夹"
        if drive.upper().startswith("C:"):
            return "C 盘根目录属于系统区域，不整理"

    depth = len([x for x in os.path.abspath(folder).split(os.sep) if x])
    if depth > rules.max_depth:
        return f"目录层级过深（{depth} 层），可能是程序安装目录"

    # 规则：程序安装目录一律不动（123网盘/BitComet/各种拓展 就是这么没的）
    hit, ev = looks_like_app_dir(folder, rules)
    if hit:
        return "这是程序安装目录（%s），按规则不动；要挪位置请用它自己的卸载/重装" \
               % "；".join(ev[:2])

    hit2, ev2 = looks_like_app_container(folder, rules)
    if hit2:
        return "这是软件总目录（%s），按规则不动；要整理请选下面的具体子目录" \
               % "；".join(ev2[:1])

    return None


def is_drive_root(path):
    drive, tail = os.path.splitdrive(os.path.abspath(path))
    return bool(drive) and not tail.strip(os.sep)


def detect_program_folder(entries, loose, rules):
    ev = []
    runtime = [e for e in loose if os.path.splitext(e.name)[1].lower() in rules.rt_exts]
    if len(runtime) >= rules.rt_threshold:
        ev.append(f"{len(runtime)} 个运行时文件（.dll/.pak/.dat 等）")
    subdirs = {e.name.lower() for e in entries if e.is_dir(follow_symlinks=False)}
    hit_dirs = subdirs & rules.sig_dirs
    if hit_dirs and runtime:
        ev.append("含程序子目录 " + "/".join(sorted(hit_dirs)))
    names = {e.name.lower() for e in loose} | subdirs
    hit_files = names & rules.sig_files
    if hit_files:
        ev.append("含程序特征文件 " + ", ".join(sorted(hit_files)[:3]))
    return bool(ev), ev


def looks_like_app_dir(folder, rules, limit=None):
    """判断一个目录第一层是否像「程序安装目录」。返回 (bool, [依据])。

    这是规则层最硬的一条：命中就整个目录不动——不整理、不搬走、
    不合并进别的目录、不清空。三条命中任一条就算：
      1. 有卸载器（unins000.exe / uninstall.exe …）——最硬的证据；
      2. 有 Electron / 游戏引擎特征文件（app.asar、icudtl.dat …）；
      3. 同时有可执行文件和 ≥3 个运行时文件（dll/pak/dat/bin…）。
    目录读不了返回 (False, [])，不因为权限问题误判成程序目录。
    """
    if not getattr(rules, "protect_app_dirs", True):
        return False, []
    try:
        with os.scandir(folder) as it:
            entries = []
            for e in it:
                entries.append(e)
                if len(entries) >= (limit or rules.app_scan_max):
                    break
    except OSError:
        return False, []

    names = {e.name.lower() for e in entries}
    files = [e for e in entries if not e.is_dir(follow_symlinks=False)]
    subdirs = {e.name.lower() for e in entries if e.is_dir(follow_symlinks=False)}
    exts = [os.path.splitext(e.name)[1].lower() for e in files]
    ev = []

    hit_un = names & rules.app_uninstallers
    if hit_un:
        ev.append("含卸载器 " + "/".join(sorted(hit_un)[:2]))
    # 残壳也认：只剩 uninstall\ 子目录的（上一轮被清空过的那批就是这样）
    hit_ud = subdirs & rules.app_uninstall_dirs
    if hit_ud:
        ev.append("含卸载目录 " + "/".join(sorted(hit_ud)[:2]))
    hit_mk = names & rules.app_markers
    if hit_mk:
        ev.append("含程序特征文件 " + "/".join(sorted(hit_mk)[:2]))
    n_exe = sum(1 for x in exts if x in (".exe", ".com", ".scr"))
    n_rt = sum(1 for x in exts if x in rules.rt_exts)
    if n_exe >= rules.app_min_exe and n_rt >= rules.rt_threshold:
        ev.append(f"含 {n_exe} 个可执行文件和 {n_rt} 个运行时文件")
    return bool(ev), ev


def looks_like_app_container(folder, rules, limit=200):
    """下面第一层里就有 ≥2 个程序安装目录 → 这是「软件总目录」，整目录不动。

    D:\\各种拓展 就是这么没的：里面 BitComet、BoosterX、dism++ 各占一层，
    目录本身没有任何程序特征，被当成普通目录一次清空，连回收站都没有。
    """
    if not getattr(rules, "protect_app_dirs", True):
        return False, []
    try:
        names = os.listdir(folder)[:limit]
    except OSError:
        return False, []
    hits = []
    for n in names:
        sub = os.path.join(folder, n)
        if os.path.isdir(sub) and not os.path.islink(sub):
            if looks_like_app_dir(sub, rules)[0]:
                hits.append(n)
                if len(hits) >= rules.app_container_min:
                    return True, ["下面有 %d 个程序安装目录：%s"
                                  % (len(hits), " / ".join(hits[:3]))]
    return False, []


def detect_project_folder(entries, rules):
    if not rules.refuse_projects:
        return False, []
    names = {e.name.lower() for e in entries}
    hits = names & rules.project_markers
    if hits:
        return True, ["检测到代码工程标志：" + ", ".join(sorted(hits)[:4])]
    return False, []


def detect_source_folder(loose, rules):
    """源码文件够多，判定为源码目录"""
    if rules.source_threshold <= 0:
        return False, []
    src = [e for e in loose if os.path.splitext(e.name)[1].lower() in rules.source_exts]
    if len(src) >= rules.source_threshold:
        sample = ", ".join(sorted({os.path.splitext(e.name)[1] for e in src})[:5])
        return True, [f"{len(src)} 个源码文件（{sample}）"]
    return False, []


# ─────────────────────── 按内容识别 ───────────────────────

# pypdf 解析畸形 PDF 时会往 stderr 刷大量警告，这里彻底静音
import logging as _logging
import warnings as _warnings

_logging.getLogger("pypdf").setLevel(_logging.CRITICAL)
_logging.getLogger("pypdf").propagate = False
_logging.getLogger("docx").setLevel(_logging.CRITICAL)
_warnings.filterwarnings("ignore")


def extract_text(path, ext, max_chars):
    """读文件正文。失败一律返回空串，绝不让异常影响整理。"""
    try:
        if ext == ".pdf":
            from pypdf import PdfReader
            reader = PdfReader(path, strict=False)
            buf, total = [], 0
            for page in reader.pages[:2]:
                t = page.extract_text() or ""
                buf.append(t)
                total += len(t)
                if total >= max_chars:
                    break
            return "".join(buf)[:max_chars]

        if ext == ".docx":
            import docx
            doc = docx.Document(path)
            buf = [p.text for p in doc.paragraphs]
            for table in doc.tables:
                for row in table.rows:
                    for cell in row.cells:
                        buf.append(cell.text)
                if sum(len(x) for x in buf) >= max_chars * 2:
                    break
            return "\n".join(buf)[:max_chars]

        if ext in (".txt", ".md"):
            with open(path, encoding="utf-8", errors="ignore") as f:
                return f.read(max_chars)
    except Exception:
        return ""
    return ""


def classify_content(text, rules):
    """强特征词 2 分、普通词 1 分，达到 min_score 才判定。返回类别名或 None。"""
    if not text:
        return None
    low = text.lower()
    best, best_score = None, 0
    for cat, keywords, strong in rules.content_rules:
        score = sum(2 for k in strong if k in low) + sum(1 for k in keywords if k in low)
        if score > best_score:
            best, best_score = cat, score
    if best and best_score >= rules.content_min_score:
        return best
    return None


# ─────────────────────────── 扫描 ───────────────────────────

class Plan:
    def __init__(self, folder):
        self.folder = folder
        self.by_cat = {}
        self.skipped = []
        self.error = None
        self.evidence = []
        self.over_limit = False
        self.blocked_kind = None    # program / project / source / None
        self.depth = 0
        self.content_scanned = 0
        self.content_hits = []
        # 引擎 scan 的新参数会落到 Plan 上，由 apply 按目录生效（默认 None = 老行为）
        self.date_fmt = None
        self.conflict = None

    @property
    def total(self):
        return sum(len(v) for v in self.by_cat.values())

    @property
    def total_size(self):
        return sum(s for v in self.by_cat.values() for _, s, _ in v)

    @property
    def skip_subtree(self):
        """被判定为程序/工程/源码 → 整个子树都不碰"""
        return self.blocked_kind in ("program", "project", "source", "app")

    def categories(self):
        return sorted(self.by_cat)


def scan(folder, rules, skip_recent=True, skip_shortcuts=True, force=False,
         use_content=None, allow_root=False, progress=None, *,
         by_date=False, conflict=None, exclude_exts=None, exclude_dirs=None):
    plan = Plan(folder)
    # by_date / conflict 是「执行期」参数：扫描阶段只记在 Plan 上，
    # 由 apply 决定最终目录与重名策略。by_date=False 时保持 rules.date_subfolder 原行为。
    if by_date:
        plan.date_fmt = "%Y/%m"
    if conflict:
        plan.conflict = conflict
    content_on = rules.content_enabled if use_content is None else use_content

    # 排除规则：后缀（.tmp / tmp / *.tmp 都接受）与目录名，大小写不敏感
    _exts = set()
    for _x in (exclude_exts or ()):
        _v = str(_x).strip().lower().lstrip("*")
        if not _v:
            continue
        _exts.add(_v if _v.startswith(".") else "." + _v)
    exclude_exts = _exts
    exclude_dirs = {str(x).strip().lower() for x in (exclude_dirs or ()) if str(x).strip()}

    reason = check_target(folder, rules, allow_root=allow_root)
    if reason:
        plan.error = reason
        return plan

    try:
        entries = [e for e in os.scandir(folder)]
    except OSError as ex:
        plan.error = f"无法读取目录：{ex}"
        return plan

    loose = []
    for e in entries:
        try:
            if e.is_file(follow_symlinks=False):
                loose.append(e)
        except OSError:
            continue

    is_prog, ev = detect_program_folder(entries, loose, rules)
    if is_prog and not force:
        plan.error, plan.evidence, plan.blocked_kind = "看起来是软件目录，已拒绝整理", ev, "program"
        return plan

    # 程序安装目录：硬规则，force 也不放行
    is_app, ev_app = looks_like_app_dir(folder, rules)
    if is_app:
        plan.error = "这是程序安装目录，按规则不动"
        plan.evidence, plan.blocked_kind = ev_app, "app"
        return plan

    is_box, ev_box = looks_like_app_container(folder, rules)
    if is_box:
        plan.error = "这是软件总目录，按规则不动"
        plan.evidence, plan.blocked_kind = ev_box, "app"
        return plan

    is_proj, ev2 = detect_project_folder(entries, rules)
    if is_proj and not force:
        plan.error, plan.evidence, plan.blocked_kind = "看起来是代码工程，已拒绝整理", ev2, "project"
        return plan

    is_src, ev3 = detect_source_folder(loose, rules)
    if is_src and not force:
        plan.error, plan.evidence, plan.blocked_kind = "看起来是源码目录，已拒绝整理", ev3, "source"
        return plan

    now = time.time()
    for e in loose:
        name = e.name
        low = name.lower()
        ext = os.path.splitext(low)[1]
        if ext in exclude_exts:
            plan.skipped.append((name, "排除的后缀"))
            continue

        if low in rules.never_names:
            plan.skipped.append((name, "系统文件")); continue
        if ext in rules.never_exts:
            plan.skipped.append((name, "快捷方式/锁文件")); continue
        if low.startswith(rules.never_prefixes):
            plan.skipped.append((name, "临时占位文件")); continue
        if low.startswith("_"):
            plan.skipped.append((name, "以 _ 开头的说明文件")); continue

        try:
            st = e.stat(follow_symlinks=False)
        except OSError:
            plan.skipped.append((name, "读不到属性")); continue

        attrs = getattr(st, "st_file_attributes", 0)
        if attrs & FILE_ATTRIBUTE_SYSTEM:
            plan.skipped.append((name, "系统属性")); continue
        if attrs & FILE_ATTRIBUTE_REPARSE_POINT:
            plan.skipped.append((name, "符号链接/联接点")); continue

        if skip_recent and (now - st.st_mtime) < rules.min_age:
            plan.skipped.append((name, "最近改动过，可能在用")); continue

        cat = rules.category(name)

        # 按内容识别（只对文档类，且限制大小与数量）
        if (content_on and ext in rules.content_exts
                and st.st_size <= rules.content_max_bytes
                and plan.content_scanned < rules.content_max_files):
            plan.content_scanned += 1
            text = extract_text(e.path, ext, rules.content_max_chars)
            hit = classify_content(text, rules)
            if hit:
                cat = hit
                plan.content_hits.append((name, hit))

        plan.by_cat.setdefault(cat, []).append((name, st.st_size, st.st_mtime))

    if plan.total < rules.min_files:
        plan.error = f"可整理文件不足 {rules.min_files} 个，没必要动"
        return plan

    if plan.total > rules.max_files:
        plan.error = f"文件太多（{plan.total} 个 > 上限 {rules.max_files}），为防止误操作已停止"
        plan.over_limit = True
        return plan

    return plan


def scan_tree(folder, rules, skip_recent=True, skip_shortcuts=True,
              force=False, max_depth=None, use_content=None, progress=None,
              *, by_date=False, conflict=None, exclude_exts=None,
              exclude_dirs=None):
    """递归扫描。每个子目录各自整理，绝不汇总到根。
    一旦某目录被判为程序/工程/源码，**整棵子树立刻放弃**，不再往下走。
    返回 (可整理的 Plan 列表, 被拦截的 Plan 列表)。"""
    limit = rules.rec_max_depth if max_depth is None else max_depth
    exclude_dirs = {str(x).strip().lower() for x in (exclude_dirs or ()) if str(x).strip()}
    plans, blocked = [], []
    _seen = [0]

    def walk(path, depth, allow_root=False):
        _seen[0] += 1
        if progress:
            try:
                progress(_seen[0], 0, "正在扫描 %d 个目录：%s"
                          % (_seen[0], os.path.basename(path) or path))
            except Exception:
                pass
        p = scan(path, rules, skip_recent, skip_shortcuts, force=force,
                 use_content=use_content, allow_root=allow_root,
                 by_date=by_date, conflict=conflict,
                 exclude_exts=exclude_exts, exclude_dirs=exclude_dirs)
        p.depth = depth

        if p.skip_subtree:                       # 整体退回，连子目录都不看
            blocked.append(p)
            return
        if p.by_cat:
            plans.append(p)
        elif p.error:
            blocked.append(p)

        if depth >= limit:
            return
        try:
            subs = [e for e in os.scandir(path) if e.is_dir(follow_symlinks=False)]
        except OSError:
            return

        for e in subs:
            low = e.name.lower()
            if low in exclude_dirs:
                p.skipped.append((e.name, "排除的目录"))
                continue
            if low in rules.prune_dirs or e.name in rules.cat_names:
                continue
            # 盘级扫描时，顶层再挡一道：程序/游戏/备份目录整个不碰
            if depth == 0 and is_drive_root(path) and low in rules.drive_skip:
                continue
            if e.name.startswith(("$", ".")) and low != ".minecraft":
                continue
            try:
                if e.stat(follow_symlinks=False).st_file_attributes & FILE_ATTRIBUTE_REPARSE_POINT:
                    continue
            except OSError:
                continue
            walk(e.path, depth + 1)

    walk(folder, 0, allow_root=(is_drive_root(folder) and rules.allow_drive_root_rec))
    return plans, blocked


def scan_files(paths, rules, skip_recent=True, force=False,
               use_content=None, progress=None, *, by_date=False, conflict=None,
               exclude_exts=None, exclude_dirs=None):
    """按显式文件清单扫描：只看点名的文件，不遍历目录。

    每个父目录各自生成一个 Plan —— apply 以 plan.folder + 文件名为准，
    所以一批文件可以来自多个目录。这里不看 min_files/max_files：
    用户已经逐个点名，数量多少都算「有意为之」。
    """
    _exts = set()
    for _x in (exclude_exts or ()):
        _v = str(_x).strip().lower().lstrip("*")
        if _v:
            _exts.add(_v if _v.startswith(".") else "." + _v)
    _dirs = {str(x).strip().lower() for x in (exclude_dirs or ()) if str(x).strip()}
    content_on = rules.content_enabled if use_content is None else use_content

    plans_by_parent = {}
    blocked = []
    now = time.time()
    for i, p in enumerate(paths):
        if progress:
            try:
                progress(i + 1, len(paths), "正在检查 %s" % os.path.basename(p))
            except Exception:
                pass
        if not os.path.isfile(p):
            bp = Plan(p)
            bp.error = "文件不存在或不是普通文件"
            blocked.append(bp)
            continue
        parent = os.path.dirname(p)
        if _dirs and any(part.lower() in _dirs
                         for part in parent.replace("/", os.sep).split(os.sep) if part):
            bp = Plan(p)
            bp.error = "所在目录被排除"
            blocked.append(bp)
            continue
        plan = plans_by_parent.get(parent)
        if plan is None:
            plan = Plan(parent)
            if by_date:
                plan.date_fmt = "%Y/%m"
            if conflict:
                plan.conflict = conflict
            plans_by_parent[parent] = plan

        name = os.path.basename(p)
        low = name.lower()
        ext = os.path.splitext(low)[1]
        if ext in _exts:
            plan.skipped.append((name, "排除的后缀")); continue
        if low in rules.never_names:
            plan.skipped.append((name, "系统文件")); continue
        if ext in rules.never_exts:
            plan.skipped.append((name, "快捷方式/锁文件")); continue
        if low.startswith(rules.never_prefixes):
            plan.skipped.append((name, "临时占位文件")); continue
        if low.startswith("_"):
            plan.skipped.append((name, "以 _ 开头的说明文件")); continue
        try:
            st = os.stat(p, follow_symlinks=False)
        except OSError:
            plan.skipped.append((name, "读不到属性")); continue
        attrs = getattr(st, "st_file_attributes", 0)
        if attrs & FILE_ATTRIBUTE_SYSTEM:
            plan.skipped.append((name, "系统属性")); continue
        if attrs & FILE_ATTRIBUTE_REPARSE_POINT:
            plan.skipped.append((name, "符号链接/联接点")); continue
        if skip_recent and (now - st.st_mtime) < rules.min_age:
            plan.skipped.append((name, "最近改动过，可能在用")); continue

        cat = rules.category(name)
        if (content_on and ext in rules.content_exts
                and st.st_size <= rules.content_max_bytes
                and plan.content_scanned < rules.content_max_files):
            plan.content_scanned += 1
            text = extract_text(p, ext, rules.content_max_chars)
            hit = classify_content(text, rules)
            if hit:
                cat = hit
                plan.content_hits.append((name, hit))
        plan.by_cat.setdefault(cat, []).append((name, st.st_size, st.st_mtime))

    # 只留真的有事可做的：有可整理文件，或者有被跳过的（用来解释「为什么是空的」）
    plans = [p for p in plans_by_parent.values() if p.by_cat or p.skipped]
    return plans, blocked


# ─────────────────────────── 执行 / 撤销 ───────────────────────────

def rename_dup(p):
    base, ext = os.path.splitext(p)
    i = 2
    while os.path.exists(f"{base} ({i}){ext}"):
        i += 1
    return f"{base} ({i}){ext}"


def backup_name(p):
    ts = datetime.datetime.now().strftime("%Y%m%d%H%M%S")
    base, ext = os.path.splitext(p)
    return f"{base}.bak-{ts}{ext}"


def resolve_dst(dst, policy):
    """返回最终目标路径；None 表示跳过"""
    if not os.path.exists(dst):
        return dst
    if policy == "skip":
        return None
    if policy == "overwrite":
        os.replace(dst, backup_name(dst))     # 旧文件改名备份，不删除
        return dst
    return rename_dup(dst)


def date_target(base_dir, date_fmt, mtime):
    if not date_fmt:
        return base_dir
    try:
        sub = datetime.datetime.fromtimestamp(mtime).strftime(date_fmt)
    except Exception:
        return base_dir
    parts = [p for p in sub.replace("\\", "/").split("/") if p]
    return os.path.join(base_dir, *parts) if parts else base_dir


def apply(plans, root, rules, policy=None, date_fmt=None, progress=None,
          dest_root=None):
    """把扫描结果落盘。

    dest_root 为空时按老行为「就地分类」（在 plan.folder 下建分类子目录）；
    给了 dest_root 就把文件移到 dest_root 下对应的分类子目录（跨盘也可以）。
    """
    if not isinstance(plans, (list, tuple)):
        plans = [plans]
    _explicit_date = date_fmt is not None
    date_fmt = rules.date_subfolder if date_fmt is None else date_fmt

    moved, failed, skipped_conflict = [], [], []
    created_dirs = []
    stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    _total = sum(len(v) for p in plans for v in p.by_cat.values())
    _done = [0]

    dest_root = os.path.normpath(dest_root) if dest_root else None

    for plan in plans:
        # 显式 policy / date_fmt 优先；否则用扫描参数记在 Plan 上的值；
        # 都没有时维持 rules 里的老行为。
        plan_policy = (policy or getattr(plan, "conflict", None)
                       or rules.conflict_policy or "rename").lower()
        plan_date = date_fmt if _explicit_date else (
            getattr(plan, "date_fmt", None) or date_fmt)
        for cat in plan.by_cat:
            cat_dir = os.path.join(dest_root or plan.folder, cat)
            for name, size, mt in plan.by_cat[cat]:
                _done[0] += 1
                if progress and (_done[0] % 20 == 0 or _done[0] == _total):
                    try:
                        progress(_done[0], _total, "正在整理 %d / %d：%s"
                                  % (_done[0], _total, name[:28]))
                    except Exception:
                        pass
                src = os.path.join(plan.folder, name)
                dst_dir = date_target(cat_dir, plan_date, mt)
                try:
                    if not os.path.exists(dst_dir):
                        created_dirs.append(dst_dir)
                    os.makedirs(dst_dir, exist_ok=True)
                except OSError as ex:
                    failed.append((name, str(ex)))
                    continue
                try:
                    dst = resolve_dst(os.path.join(dst_dir, name), plan_policy)
                except OSError as ex:
                    failed.append((name, f"处理重名失败 {ex}".split(":")[0]))
                    continue
                if dst is None:
                    skipped_conflict.append(name)
                    continue
                try:
                    shutil.move(src, dst)
                    moved.append((src, dst))
                except OSError as ex:
                    failed.append((name, str(ex).split(":")[0]))

    if not moved:
        return 0, failed, None

    for folder in {os.path.dirname(s) for s, _ in moved}:
        sub = [(s, d) for s, d in moved if os.path.dirname(s) == folder]
        try:
            with open(os.path.join(folder, MANIFEST_TXT), "a", encoding="utf-8-sig") as f:
                f.write(f"\n===== {datetime.datetime.now():%Y-%m-%d %H:%M} 整理 {len(sub)} 个文件 =====\n")
                for src, dst in sub:
                    f.write(f"{os.path.basename(src)}\t->\t{os.path.relpath(dst, folder)}\n")
        except OSError:
            pass

    os.makedirs(hist_dir(), exist_ok=True)
    safe = "".join(ch if ch.isalnum() else "_" for ch in os.path.basename(root))[:40]
    mf = os.path.join(hist_dir(), f"{stamp}_{safe}.json")
    with open(mf, "w", encoding="utf-8") as f:
        json.dump({"folder": root, "time": stamp,
                   "created_dirs": created_dirs,
                   "moves": [{"from": a, "to": b} for a, b in moved]},
                  f, ensure_ascii=False, indent=1)
    # 先让索引认账再返回：用户整理完立刻问「什么最占空间」，答案必须是整理后的
    index_touch([b for _a, b in moved] + [a for a, _b in moved])
    return len(moved), failed, mf


SRC_RULES = [
    ("微信", ("微信", "wechat", "weixin")),
    ("QQ", ("qq", "tencent files")),
    ("截图", ("屏幕截图", "screenshot", "snipaste", "截图")),
    ("手机相册", ("camera roll", "dcim", "pictures\\saved pictures")),
    ("浏览器下载", ("downloads", "下载")),
    ("邮件附件", ("outlook", "attachment", "附件")),
    ("工作文档", ("工作", "项目", "报告", "方案")),
]


def guess_source(path, name):
    """按「路径 + 文件名」猜来源，给「按来源分类」用。"""
    hay = (path + "\\" + name).lower()
    for label, keys in SRC_RULES:
        for k in keys:
            if k.lower() in hay:
                return label
    return "其他"


def regroup(plans, mode="type", rules=None):
    """把扫描结果换一种分类口径，返回新的 plans（不改原对象）。

    mode:
      type      按文件类型（默认，01_安装包程序 / 05_图片 …）
      date      按修改月份（2026-10）
      source    按来源（微信 / QQ / 截图 / 手机相册 / 浏览器下载 …）
      type_date 先类型再月份（05_图片/2026-10）
    """
    if mode in (None, "", "type"):
        return plans
    out = []
    for plan in plans:
        new_by_cat = {}
        for cat, items in plan.by_cat.items():
            for name, size, mt in items:
                if mode == "date":
                    key = datetime.datetime.fromtimestamp(mt).strftime("%Y-%m")
                elif mode == "source":
                    key = guess_source(plan.folder, name)
                else:  # type_date
                    key = cat + "/" + datetime.datetime.fromtimestamp(mt).strftime("%Y-%m")
                new_by_cat.setdefault(key, []).append((name, size, mt))
        clone = Plan(plan.folder)
        clone.by_cat = new_by_cat
        clone.error = plan.error
        clone.evidence = list(plan.evidence or [])
        clone.skipped = list(plan.skipped or [])
        out.append(clone)
    return out


def check_dest(dest, src_root=None):
    """目标目录的安全检查，返回 (ok, why)。"""
    if not dest:
        return False, "没有指定目标目录"
    dest = os.path.normpath(dest)
    try:
        os.makedirs(dest, exist_ok=True)
    except OSError as ex:
        return False, "无法创建目标目录：%s" % ex
    low = dest.lower().rstrip("\\")
    drive, rest = os.path.splitdrive(low)
    if rest in ("", "\\"):
        return False, "不能直接选盘符根目录"
    if low.startswith(("c:\\windows", "c:\\program files", "c:\\program files (x86)")):
        return False, "这是系统/程序目录，不能作为整理目标"
    if src_root and os.path.normcase(norm(dest)) == os.path.normcase(norm(src_root)):
        return False, "目标目录和源目录是同一个"
    if src_root and os.path.normcase(norm(src_root)).startswith(os.path.normcase(norm(dest)) + "\\"):
        pass          # 目标在上层没关系
    return True, ""


def undo(folder):
    if not os.path.isdir(hist_dir()):
        return 0, ["没有整理记录"]
    base = norm(folder)
    found = None
    for fn in sorted(os.listdir(hist_dir()), reverse=True):
        if not fn.endswith(".json"):
            continue
        p = os.path.join(hist_dir(), fn)
        try:
            d = json.load(open(p, encoding="utf-8"))
        except Exception:
            continue
        if norm(d.get("folder", "")) == base:
            found = (p, d)
            break
    if not found:
        # 多来源整理（paths 混选目录与文件）时 history.folder 是公共父目录，
        # 和界面传进来的单个目录对不上；退一步按「移动记录是否落在这个目录下」找。
        prefix = base + os.sep
        for fn in sorted(os.listdir(hist_dir()), reverse=True):
            if not fn.endswith(".json"):
                continue
            p = os.path.join(hist_dir(), fn)
            try:
                d = json.load(open(p, encoding="utf-8"))
            except Exception:
                continue
            if any(norm(str(mv.get("from", ""))).startswith(prefix)
                   for mv in (d.get("moves") or [])):
                found = (p, d)
                break
    if not found:
        return 0, ["这个文件夹没有整理记录"]
    p, d = found

    restored, failed = 0, []
    back = []
    for mv in reversed(d["moves"]):
        src, dst = mv["to"], mv["from"]
        if not os.path.exists(src):
            continue
        if os.path.exists(dst):
            failed.append((os.path.basename(dst), "原位置已有同名文件"))
            continue
        try:
            shutil.move(src, dst)
            restored += 1
            back.extend([src, dst])
        except OSError as ex:
            failed.append((os.path.basename(src), str(ex).split(":")[0]))

    for cp in d.get("created_dirs", []):
        if not os.path.isabs(cp):
            cp = os.path.join(folder, cp)
        if os.path.isdir(cp) and not os.listdir(cp):
            try:
                os.rmdir(cp)
                back.append(cp)
            except OSError:
                pass
    os.remove(p)
    # 撤销也是改磁盘：还原后的位置要立刻写回索引，否则搜索还指着分类夹里
    index_touch(back)
    return restored, failed


def human(n):
    for unit, div in (("GB", 1024 ** 3), ("MB", 1024 ** 2), ("KB", 1024)):
        if n >= div:
            return f"{n / div:.2f} {unit}"
    return f"{n} B"


# ─────────────────────────── 高级规则（集成 organize） ───────────────────────────

RULES_TEMPLATE = """# organize 规则（YAML）—— 语法见 https://organize.readthedocs.io/
# 注意：路径请用单引号或正斜杠；双引号里的反斜杠会被当成转义符而报错。
# 这里与内置分类互不冲突：先跑内置逻辑，再跑这些精细规则。
rules:
  - name: '下载里的 PDF 按年份归档'
    locations:
      - 'D:/下载'
    subfolders: true
    filters:
      - extension: pdf
    actions:
      - move: 'D:/下载/03_文档/{created.year}/'

  - name: '找出空目录（只报告，不删除）'
    locations: 'D:/下载'
    targets: dirs
    subfolders: true
    filters:
      - empty
    actions:
      - echo: '空目录 {path}'
"""


def organize_available():
    try:
        import organize  # noqa: F401
        return True
    except Exception:
        return False


def run_rules(config_text, simulate=True, tags=None, skip_tags=None,
              output=None, working_dir=None):
    """调用内置的 organize 引擎。返回 (输出文本, 是否成功)。

    output / working_dir 是给 --engine 用的：传入 JSONL 输出可以拿到结构化
    事件，working_dir 用来把规则里的相对路径锚到调用方指定的目录。
    默认值（None）保持界面与命令行的原有行为。
    """
    try:
        from organize import Config
    except Exception as ex:
        return f"未集成 organize 引擎：{ex}", False

    try:
        cfg = Config.from_string(config_text)
    except Exception as ex:
        return f"配置有误：{ex}", False

    buf = io.StringIO()
    ok = True
    kwargs = {}
    if output is not None:
        kwargs["output"] = output
    if working_dir is not None:
        kwargs["working_dir"] = working_dir
    try:
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
            cfg.execute(simulate=simulate,
                        tags=set(tags or []), skip_tags=set(skip_tags or []),
                        **kwargs)
    except Exception as ex:
        buf.write(f"\n执行出错：{ex}\n")
        ok = False
    return buf.getvalue(), ok


def check_rules(config_text):
    try:
        from organize import Config
        Config.from_string(config_text)
        return "配置校验通过", True
    except Exception as ex:
        return f"配置有误：{ex}", False


# ─────────────────────────── 卸载（参照 BCUninstaller 思路实现） ───────────────────────────

UNINSTALL_PATHS = [
    ("HKLM64", r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
    ("HKLM32", r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
    ("HKCU",   r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
]

# 这些目录/键永远不许删
SAFE_ROOT_DENY = {
    "windows", "system32", "syswow64", "program files", "program files (x86)",
    "programdata", "users", "appdata", "local", "roaming", "temp", "common files",
    "microsoft", "windows nt", "system", "system volume information",
}
SAFE_REG_DENY = {"microsoft", "windows", "classes", "policies", "wow6432node",
                 "clients", "registeredapplications", "wow6432node"}


def is_admin():
    try:
        import ctypes
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


def relaunch_as_admin():
    """以管理员身份重新启动自己"""
    try:
        import ctypes
        exe = sys.executable
        r = ctypes.windll.shell32.ShellExecuteW(None, "runas", exe, "", None, 1)
        return r > 32
    except Exception:
        return False


def _open_uninstall_key(hive_name, sub):
    import winreg
    hive = {"HKLM64": winreg.HKEY_LOCAL_MACHINE,
            "HKLM32": winreg.HKEY_LOCAL_MACHINE,
            "HKCU": winreg.HKEY_CURRENT_USER}[hive_name]
    flag = {"HKLM64": winreg.KEY_WOW64_64KEY,
            "HKLM32": winreg.KEY_WOW64_32KEY,
            "HKCU": 0}[hive_name]
    return winreg.OpenKey(hive, sub, 0, winreg.KEY_READ | flag)


def list_installed_apps(progress=None):
    """枚举已安装程序（对应 BCU-console 的 list）"""
    import winreg
    apps, seen = [], set()
    _idx = [0]
    for hive_name, sub in UNINSTALL_PATHS:
        try:
            with _open_uninstall_key(hive_name, sub) as key:
                count = winreg.QueryInfoKey(key)[0]
                for i in range(count):
                    _idx[0] += 1
                    if progress and _idx[0] % 25 == 0:
                        try:
                            progress(_idx[0], 0, "正在读取注册表：已找到 %d 个程序"
                                      % len(apps))
                        except Exception:
                            pass
                    try:
                        child = winreg.EnumKey(key, i)
                    except OSError:
                        continue
                    try:
                        with _open_uninstall_key(hive_name, sub + "\\" + child) as ck:
                            def g(n):
                                try:
                                    return winreg.QueryValueEx(ck, n)[0]
                                except OSError:
                                    return ""
                            name = str(g("DisplayName")).strip()
                            if not name:
                                continue
                            if str(g("SystemComponent")) == "1":
                                continue
                            if g("ParentKeyName"):
                                continue
                            ver = str(g("DisplayVersion")).strip()
                            key_id = (name.lower(), ver)
                            if key_id in seen:
                                continue
                            seen.add(key_id)
                            try:
                                size_kb = int(g("EstimatedSize") or 0)
                            except (ValueError, TypeError):
                                size_kb = 0
                            apps.append({
                                "name": name,
                                "version": ver,
                                "publisher": str(g("Publisher")).strip(),
                                "location": str(g("InstallLocation")).strip().strip('"'),
                                "uninstall": str(g("UninstallString")).strip(),
                                "quiet": str(g("QuietUninstallString")).strip(),
                                "url": str(g("URLInfoAbout")).strip(),
                                "size_kb": size_kb,
                                "hive": hive_name,
                                "key": sub + "\\" + child,
                                "icon": (_icon_from_value(str(g("DisplayIcon")))
                                         or _guess_icon(
                                             str(g("InstallLocation")).strip().strip('"'),
                                             str(g("UninstallString")).strip())),
                                "date": _reg_key_mtime(ck),
                            })
                    except OSError:
                        continue
        except OSError:
            continue
    apps.sort(key=lambda a: a["name"].lower())
    return apps


def _icon_from_value(raw):
    """DisplayIcon 可能是 "C:\\x\\a.exe,0" 或带引号，取真正的 exe/dll 路径"""
    if not raw:
        return ""
    p = raw.strip()
    if p.startswith('"'):
        p = p[1:].split('"', 1)[0]
    else:
        p = p.split(",")[0].strip()
    p = os.path.expandvars(p)
    if p.lower().endswith((".exe", ".ico", ".dll")) and os.path.exists(p):
        return p
    return ""


def _guess_icon(location, uninstall):
    """没有 DisplayIcon 时，从卸载命令或安装目录里猜一个可执行文件当图标"""
    for raw in (uninstall,):
        if not raw:
            continue
        s = raw.strip()
        if s.startswith('"'):
            s = s[1:].split('"', 1)[0]
        else:
            s = s.split(" /")[0].split(" -")[0].strip()
        s = os.path.expandvars(s)
        if s.lower().endswith(".exe") and os.path.exists(s):
            return s
    d = (location or "").strip().strip('"')
    if not d or not os.path.isdir(d):
        return ""
    try:
        best, best_sz = "", -1
        for name in os.listdir(d)[:400]:
            if not name.lower().endswith(".exe"):
                continue
            full = os.path.join(d, name)
            try:
                sz = os.path.getsize(full)
            except OSError:
                continue
            if sz > best_sz:
                best, best_sz = full, sz
        return best
    except OSError:
        return ""


def _reg_key_mtime(key):
    """注册表键的最后写入时间（Geek 的「安装时间」就是取这个）"""
    try:
        import winreg
        ft = winreg.QueryInfoKey(key)[2]
        if not ft:
            return 0.0
        return (ft - 116444736000000000) / 10000000.0
    except Exception:
        return 0.0


def remove_uninstall_entry(app):
    """只删注册表条目（Geek 的「删除条目」），不动磁盘文件"""
    import winreg
    hives = {"HKLM64": (winreg.HKEY_LOCAL_MACHINE, winreg.KEY_WOW64_64KEY),
             "HKLM32": (winreg.HKEY_LOCAL_MACHINE, winreg.KEY_WOW64_32KEY),
             "HKCU": (winreg.HKEY_CURRENT_USER, 0)}
    root, flag = hives.get(app.get("hive"), (None, 0))
    if root is None:
        raise RuntimeError("未知的注册表分支")
    parent, _, leaf = app["key"].rpartition("\\")
    with winreg.OpenKey(root, parent, 0,
                        winreg.KEY_SET_VALUE | flag) as k:
        winreg.DeleteKeyEx(k, leaf, flag, 0)


def open_regedit_at(app):
    """打开 regedit 并定位到该条目的 Uninstall 键"""
    import winreg
    hive_txt = {"HKLM64": "HKEY_LOCAL_MACHINE", "HKLM32": "HKEY_LOCAL_MACHINE",
                "HKCU": "HKEY_CURRENT_USER"}.get(app.get("hive"), "HKEY_LOCAL_MACHINE")
    path = "%s\\%s" % (hive_txt, app["key"])
    try:
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER,
                              r"Software\Microsoft\Windows\CurrentVersion"
                              r"\Applets\Regedit") as k:
            winreg.SetValueEx(k, "LastKey", 0, winreg.REG_SZ, path)
    except OSError:
        pass
    subprocess.Popen(["regedit.exe"])


def _safe_dir(p):
    """目录是否允许删除"""
    try:
        p = os.path.abspath(p)
    except Exception:
        return False
    if len(p) < 10:
        return False
    drive, tail = os.path.splitdrive(p)
    if not tail.strip("\\"):
        return False
    parts = [x.lower() for x in p.split("\\") if x]
    if len(parts) <= 2:
        return False
    last = parts[-1]
    if last in SAFE_ROOT_DENY:
        return False
    return True


def _safe_reg_key(hive_name, key_path):
    parts = [x.lower() for x in key_path.split("\\") if x]
    if len(parts) < 3:
        return False
    if parts[0] != "software":
        return False
    # 特例：只允许删「某个程序自己的 Uninstall 登记项」，不允许删 Uninstall 根
    uninst_root = ["software", "microsoft", "windows", "currentversion", "uninstall"]
    if parts[:5] == uninst_root and len(parts) > 5:
        return True
    # 以下这些位置一律不碰
    if parts[1].lower() in ("microsoft", "windows", "classes", "policies",
                            "registeredapplications", "clients"):
        return False
    if parts[-1].lower() in {"clsid", "system", "currentcontrolset", "services",
                             "run", "runonce"}:
        return False
    return True


def _norm(s):
    return re.sub(r"[\s\-_()（）\[\]·.]", "", (s or "").lower())


def scan_leftovers(app):
    """扫描残留：目录 + 注册表键（对应 BCU 的 junk cleanup）"""
    name = re.sub(r'[\\/:*?"<>|]', "", app["name"]).strip()
    norm_name = _norm(name)
    if len(norm_name) < 2:
        return [], []

    cand_dirs = []
    loc = app.get("location", "")
    if loc and os.path.isdir(loc):
        cand_dirs.append(loc)

    bases = [
        os.environ.get("ProgramFiles"),
        os.environ.get("ProgramFiles(x86)"),
        os.environ.get("ProgramData"),
        os.environ.get("LOCALAPPDATA"),
        os.environ.get("APPDATA"),
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs"),
    ]
    for base in bases:
        if not base or not os.path.isdir(base):
            continue
        try:
            for entry in os.scandir(base):
                if not entry.is_dir(follow_symlinks=False):
                    continue
                if _norm(entry.name) == norm_name:
                    cand_dirs.append(entry.path)
        except OSError:
            pass

    dirs = []
    for d in dict.fromkeys(cand_dirs):
        if _safe_dir(d):
            dirs.append(d)

    regs = []
    key_app = app.get("key", "")
    if key_app and _safe_reg_key(app.get("hive", ""), key_app):
        regs.append((app["hive"], key_app))

    import winreg
    for hive_name, hive in (("HKLM64", winreg.HKEY_LOCAL_MACHINE),
                            ("HKLM32", winreg.HKEY_LOCAL_MACHINE),
                            ("HKCU", winreg.HKEY_CURRENT_USER)):
        try:
            with winreg.OpenKey(hive, "SOFTWARE", 0, winreg.KEY_READ) as bk:
                n = winreg.QueryInfoKey(bk)[0]
                for i in range(n):
                    try:
                        sub = winreg.EnumKey(bk, i)
                    except OSError:
                        continue
                    if _norm(sub) == norm_name and _safe_reg_key(hive_name, "SOFTWARE\\" + sub):
                        regs.append((hive_name, "SOFTWARE\\" + sub))
        except OSError:
            pass

    return dirs, list(dict.fromkeys(regs))


def _hive_root(hive_name):
    import winreg
    return {"HKLM64": winreg.HKEY_LOCAL_MACHINE,
            "HKLM32": winreg.HKEY_LOCAL_MACHINE,
            "HKCU": winreg.HKEY_CURRENT_USER}[hive_name]


def _flag(hive_name):
    import winreg
    return {"HKLM64": winreg.KEY_WOW64_64KEY,
            "HKLM32": winreg.KEY_WOW64_32KEY,
            "HKCU": 0}[hive_name]


def export_reg_key(hive_name, key_path, out_file):
    """导出注册表备份（对应 BCU 的 export）"""
    hive_txt = {"HKLM64": "HKLM", "HKLM32": "HKLM", "HKCU": "HKCU"}[hive_name]
    try:
        r = subprocess.run(["reg", "export", f"{hive_txt}\\{key_path}", out_file, "/y"],
                           capture_output=True, text=True,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return r.returncode == 0 and os.path.exists(out_file)
    except Exception:
        return False


def delete_reg_tree(hive_name, key_path):
    import winreg

    def walk(h, path):
        try:
            with winreg.OpenKey(h, path, 0, winreg.KEY_READ | _flag(hive_name)) as k:
                n = winreg.QueryInfoKey(k)[0]
                kids = []
                for i in range(n):
                    try:
                        kids.append(winreg.EnumKey(k, i))
                    except OSError:
                        pass
        except OSError:
            return True
        for kid in kids:
            walk(h, path + "\\" + kid)
        try:
            winreg.DeleteKey(h, path)
            return True
        except OSError:
            return False

    return walk(_hive_root(hive_name), key_path)


def _delete_reg_tree(root, path, flag):
    """递归删除注册表子树（DeleteKeyEx + WOW64 flag）。

    返回 "" 表示删干净；否则返回能直接放进 failed 的中文原因。
    先删子键再删自己，免得 DeleteKeyEx 因为「还有子键」失败。
    引擎的 apps.cleanup 用它：根键与 flag 由调用方按 HKCU/HKLM64/HKLM32 给。
    """
    import winreg
    try:
        with winreg.OpenKey(root, path, 0, winreg.KEY_READ | flag) as key:
            count = winreg.QueryInfoKey(key)[0]
            kids = []
            for i in range(count):
                try:
                    kids.append(winreg.EnumKey(key, i))
                except OSError:
                    break
    except FileNotFoundError:
        return "注册表键不存在"
    except OSError as ex:
        return "打不开注册表键：%s" % ex
    for kid in kids:
        why = _delete_reg_tree(root, path + "\\" + kid, flag)
        if why:
            return why
    parent, _sep, leaf = path.rpartition("\\")
    if not parent or not leaf:
        return "注册表键路径不合法：%s" % path
    try:
        with winreg.OpenKey(root, parent, 0,
                            winreg.KEY_SET_VALUE | flag) as pk:
            winreg.DeleteKeyEx(pk, leaf, flag, 0)
    except OSError as ex:
        return "删除注册表键失败：%s" % ex
    return ""


def run_uninstaller(app, quiet=True):
    """运行程序自带的卸载器"""
    cmd = (app.get("quiet") or app.get("uninstall") or "").strip()
    if not cmd:
        return False, "该程序没有卸载命令，只能强制清理残留"
    try:
        subprocess.Popen(cmd, shell=True,
                         creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return True, cmd
    except Exception as ex:
        return False, str(ex)


def delete_paths(paths, progress=None):
    ok, fail = [], []
    total = len(paths) or 1
    for i, p in enumerate(paths, 1):
        if progress and (i % 3 == 0 or i == total):
            try:
                progress(i, total, "正在删除 %d/%d：%s"
                         % (i, total, os.path.basename(p)[:26]))
            except Exception:
                pass
        try:
            if os.path.isdir(p):
                shutil.rmtree(p)
            elif os.path.exists(p):
                os.remove(p)
            ok.append(p)
        except Exception as ex:
            fail.append((p, str(ex)))
    return ok, fail


# ─────────────────── 资源管理器里的删除 / 打开动作 ───────────────────

def _movefile_reboot(path):
    """登记为「重启后删除」（需要管理员权限，失败返回 False）。"""
    try:
        import ctypes
        MOVEFILE_DELAY_UNTIL_REBOOT = 0x4
        return bool(ctypes.windll.kernel32.MoveFileExW(
            str(path), None, MOVEFILE_DELAY_UNTIL_REBOOT))
    except Exception:
        return False


def _recycle_native(path):
    """用 Windows 自带的 SHFileOperationW 把单个路径丢进回收站（不依赖第三方包）。"""
    import ctypes
    from ctypes import wintypes

    class SHFILEOPSTRUCTW(ctypes.Structure):
        _fields_ = [
            ("hwnd", wintypes.HWND),
            ("wFunc", wintypes.UINT),
            ("pFrom", wintypes.LPCWSTR),
            ("pTo", wintypes.LPCWSTR),
            ("fFlags", ctypes.c_uint16),
            ("fAnyOperationsAborted", wintypes.BOOL),
            ("hNameMappings", ctypes.c_void_p),
            ("lpszProgressTitle", wintypes.LPCWSTR),
        ]

    FO_DELETE = 3
    flags = 0x0040 | 0x0010 | 0x0004 | 0x0400  # ALLOWUNDO | NOCONFIRMATION | SILENT | NOERRORUI
    raw = str(path)
    buf = ctypes.create_unicode_buffer(raw + "\0", len(raw) + 2)
    op = SHFILEOPSTRUCTW(None, FO_DELETE, ctypes.cast(buf, wintypes.LPCWSTR), None, flags, False, None, None)
    rc = ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op))
    if rc != 0:
        raise OSError(rc, "SHFileOperationW failed")
    if op.fAnyOperationsAborted:
        raise OSError(0, "aborted")


def trash_delete(paths):
    """移到回收站，可还原。优先 send2trash，缺失时用系统 SHFileOperationW。"""
    ok, fail = [], []
    try:
        from send2trash import send2trash
    except Exception:
        send2trash = None
    for p in paths:
        try:
            if send2trash:
                send2trash(p)
            else:
                _recycle_native(p)
            ok.append(p)
        except Exception as ex:
            fail.append((p, str(ex)))
    # 进了回收站的内容对「占多少空间」已经不算了，索引要同步摘掉
    if ok:
        index_touch(ok)
    return ok, fail


def hard_delete(paths):
    """强制删除：去只读 → 改名解毒 → 仍不行就登记重启删除。

    返回 (已删除, 失败列表, 已登记重启删除)。
    """
    ok, fail, pending = [], [], []
    for p in paths:
        if not os.path.exists(p):
            ok.append(p)
            continue
        err = None
        # 1. 直接删
        try:
            os.remove(p)
            ok.append(p)
            continue
        except OSError as ex:
            err = ex
        # 2. 去掉只读属性再删
        try:
            if os.path.isdir(p):
                for dp, _dns, fns in os.walk(p):
                    for n in fns:
                        try:
                            os.chmod(os.path.join(dp, n), stat.S_IWRITE)
                        except OSError:
                            pass
                shutil.rmtree(p)
            else:
                os.chmod(p, stat.S_IWRITE)
                os.remove(p)
            ok.append(p)
            continue
        except OSError as ex:
            err = ex
        # 3. 改名（被进程占用的文件通常允许改名，解锁后已无意义）
        try:
            tmp = "%s.del%d" % (p, int(time.time() * 1000) % 1000000)
            os.rename(p, tmp)
            try:
                os.remove(tmp)
            except OSError:
                pending.append(tmp)
            ok.append(p)
            continue
        except OSError as ex:
            err = ex
        # 4. 兜底：登记到重启后删除
        if _movefile_reboot(p):
            pending.append(p)
        else:
            fail.append((p, str(err)))
    if ok:
        index_touch(ok)
    if pending:
        index_touch(pending)
    return ok, fail, pending


# ─────────────────── 截图清理 ───────────────────

# 各家截图工具默认的命名规律（不区分大小写，只要求文件名命中其一）
SHOT_PATTERNS = [
    r"^屏幕截图", r"^屏幕剪辑", r"^截屏", r"^截图", r"^屏幕快照",
    r"^screenshot", r"^screen shot", r"^screenshot_", r"^snipaste",
    r"^qq截图", r"^qq浏览器截图", r"^qqimage",
    r"^微信截图", r"^微信截屏",
    r"^snap\d", r"^捕获", r"^capture", r"^snip_", r"^screencap",
    r"^image[ _-]?\d{4}", r"^sharex", r"^picpick",
    r"^greenshot", r"^gyazo", r"^bandicam", r"^obs", r"^nvidia",
    r"^clipboard", r"^未命名", r"^新建位图图像",
]
SHOT_RE = None

# 这些目录名下的图片一律当作截图/截屏（不管文件名）
SHOT_DIR_NAMES = {
    "screenshots", "screenshot", "屏幕截图", "截图", "截屏",
    "screen clips", "屏幕剪辑", "screencaptures", "captures", "capture", "捕获",
}
# 扫描深度：根目录 + 最多 3 层子目录（游戏截图常放 Pictures\游戏名\Screenshots）
SHOT_MAX_DEPTH = 3

# 只清图片/视频，绝不碰文档
# 截图清理的计划任务名
SHOT_TASK = "整理助手_清理截图"
CACHE_TASK = "整理助手_清理缓存"


# ── 计划任务工具 ──────────────────────────────────────────────
# 以前用 "成功" in out 判断 schtasks 是否成功，但中文 Windows 的 schtasks
# 输出是 GBK，我们却按 UTF-8 解码 —— 拿到的是一串乱码，于是「成功」永远匹配
# 不上：任务其实建好了，界面却弹「创建失败」，任务看着也不能用。
# 现在一律以返回码为准，输出只用来展示（先按 GBK 解，失败再退回 UTF-8）。

def _schtasks():
    """schtasks.exe 的绝对路径。

    打包成无控制台的 exe 后，PATH 有时拿不到 System32（尤其从快捷方式、
    开机自启拉起时），直接写 "schtasks" 会 FileNotFoundError，表现就是
    「任务明明建好了，界面却显示未设置」。
    """
    root = os.environ.get("SystemRoot") or os.environ.get("windir") or r"C:\Windows"
    p = os.path.join(root, "System32", "schtasks.exe")
    if os.path.isfile(p):
        return p
    p32 = os.path.join(root, "Sysnative", "schtasks.exe")
    return p32 if os.path.isfile(p32) else "schtasks"


def _run_hidden(args):
    """静默执行命令，返回 (返回码, 解码后的输出)。"""
    import subprocess
    try:
        r = subprocess.run(args, capture_output=True,
                           creationflags=getattr(subprocess,
                                                 "CREATE_NO_WINDOW", 0))
    except Exception as ex:
        return -1, str(ex)
    raw = (r.stdout or b"") + (r.stderr or b"")
    text = ""
    for enc in ("gbk", "utf-8"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    if not text:
        text = raw.decode("utf-8", "replace")
    return r.returncode, text.strip()


def task_query(name):
    """查计划任务，返回 (是否存在, 下次运行时间, 原文)。"""
    rc, txt = _run_hidden([_schtasks(), "/Query", "/TN", name, "/FO", "LIST"])
    nxt = ""
    for line in txt.splitlines():
        low = line.lower()
        if "下次运行时间" in line or "next run time" in low:
            nxt = line.split(":", 1)[-1].strip()
            break
    return (rc == 0), nxt, txt


def task_create(name, when, command):
    """建每日计划任务。成功/失败以返回码判定，成功后回查一次。"""
    rc, txt = _run_hidden([_schtasks(), "/Create", "/F", "/TN", name,
                           "/SC", "DAILY", "/ST", when, "/TR", command])
    if rc != 0:
        return False, txt or ("返回码 %d" % rc), ""
    ok, nxt, _ = task_query(name)
    if not ok:
        return False, "命令返回成功，但查不到这个任务", ""
    return True, "", nxt


def task_delete(name):
    rc, txt = _run_hidden([_schtasks(), "/Delete", "/F", "/TN", name])
    ok, _, _ = task_query(name)
    return (rc == 0 and not ok), txt


def task_run_now(command):
    """立刻按任务里的命令跑一次，用来验证配置真的能用。"""
    import subprocess
    try:
        r = subprocess.run(command, shell=True, capture_output=True,
                           creationflags=getattr(subprocess,
                                                 "CREATE_NO_WINDOW", 0))
        return r.returncode == 0, (r.returncode,
                                   (r.stdout or b"")[-400:].decode("utf-8",
                                                                   "replace"))
    except Exception as ex:
        return False, (-1, str(ex))


def check_when(text):
    """把 'H:MM' / 'HH:MM' 规范成 'HH:MM'，不合法返回空串。"""
    parts = (text or "").strip().replace("：", ":").split(":")
    if len(parts) != 2:
        return ""
    try:
        h, m = int(parts[0]), int(parts[1])
    except ValueError:
        return ""
    if not (0 <= h < 24 and 0 <= m < 60):
        return ""
    return "%02d:%02d" % (h, m)

SHOT_EXTS = {".png", ".jpg", ".jpeg", ".bmp", ".gif", ".webp", ".heic", ".tif", ".tiff",
             ".mp4", ".mov", ".mkv", ".avi"}


def _shot_re():
    global SHOT_RE
    if SHOT_RE is None:
        import re
        SHOT_RE = re.compile("|".join(SHOT_PATTERNS), re.IGNORECASE)
    return SHOT_RE


def _is_shot_file(path):
    """文件名命中截图规则，或所在目录名就是截图目录，才算截图。"""
    ext = os.path.splitext(path)[1].lower()
    if ext not in SHOT_EXTS:
        return False
    stem = os.path.splitext(os.path.basename(path))[0]
    if _shot_re().search(stem):
        return True
    parent = os.path.basename(os.path.dirname(path)).lower()
    return parent in SHOT_DIR_NAMES


def _known_folder(name):
    """从注册表读 Known Folder（含 OneDrive 重定向），失败返回 ""。"""
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                            r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders") as k:
            v, _ = winreg.QueryValueEx(k, name)
        return os.path.expandvars(v)
    except Exception:
        return ""


def shot_dirs_default():
    """没自定义时，用系统截图目录 + 桌面 + 下载（含 OneDrive 重定向）。"""
    home = os.path.expanduser("~")
    cand = [
        _known_folder("My Pictures"),
        os.path.join(home, "Pictures", "Screenshots"),
        os.path.join(home, "Pictures", "屏幕截图"),
        os.path.join(home, "Pictures"),
    ]
    for pic in (cand[0], os.path.join(home, "Pictures")):
        if pic:
            base = os.path.dirname(pic)
            cand += [
                os.path.join(pic, "Screenshots"),
                os.path.join(pic, "屏幕截图"),
                os.path.join(base, "OneDrive", "Pictures", "Screenshots"),
                os.path.join(base, "OneDrive", "Pictures", "屏幕截图"),
                os.path.join(base, "OneDrive", "图片", "Screenshots"),
                os.path.join(base, "OneDrive", "图片", "屏幕截图"),
            ]
    cand += [
        _known_folder("Desktop"),
        _known_folder("{374DE290-123F-4565-9164-39C4925E467B}"),
        os.path.join(home, "Desktop"),
        os.path.join(home, "Downloads"),
        os.path.join(home, "OneDrive", "Desktop"),
        os.path.join(home, "OneDrive", "Downloads"),
        # Xbox Game Bar / 录屏工具：Videos\Captures
        os.path.join(home, "Videos", "Captures"),
        os.path.join(_known_folder("My Video") or os.path.join(home, "Videos"), "Captures"),
        # 相机胶卷 / 保存的图片
        os.path.join(home, "Pictures", "Camera Roll"),
        os.path.join(home, "Pictures", "Saved Pictures"),
        os.path.join(home, "Pictures", "Saved Pictures", "Screenshots"),
        # 公共图片
        os.path.join(os.environ.get("PUBLIC") or "", "Pictures"),
        # QQ / 微信 的图片与截图目录（只按文件名命中，不碰聊天数据库）
        os.path.join(home, "Documents", "Tencent Files"),
        os.path.join(home, "Documents", "WeChat Files"),
        os.path.join(home, "Documents", "xwechat_files"),
        os.path.join(os.environ.get("OneDrive", ""), "Pictures"),
        os.path.join(os.environ.get("OneDrive", ""), "Pictures", "Screenshots"),
        os.path.join(os.environ.get("OneDrive", ""), "Pictures", "屏幕截图"),
        os.path.join(os.environ.get("OneDrive", ""), "Desktop"),
        os.path.join(os.environ.get("OneDrive", ""), "Downloads"),
    ]
    out = []
    for c in cand:
        if c and os.path.isabs(c) and os.path.isdir(c) and os.path.normcase(c) not in [os.path.normcase(x) for x in out]:
            out.append(c)
    return out


def find_screenshots(dirs=None, keep_days=7, min_kb=0, extra_roots=None, progress=None,
                     all_images=False):
    """返回 [(路径, 大小, 修改时间)]，只含超过保留天数的项。

    dirs 给定时只扫这些目录（含最多 3 层子目录）；否则用默认目录。
    all_images=True 时不再要求文件名像截图，目录里的所有图片/视频都算。
    """
    import time as _t
    dirs = [d for d in (dirs or shot_dirs_default()) if os.path.isdir(d)]
    cutoff = _t.time() - max(0, keep_days) * 86400
    lo = max(0, min_kb) * 1024
    seen = set()
    hits = []
    _n = 0
    # 防止把网盘/项目目录翻个底朝天：目录数与耗时都设上限
    started = _t.time()
    max_dirs = 40000
    max_seconds = 25.0
    for root_dir in dirs:
        for dp, dns, fns in os.walk(root_dir):
            _n += 1
            if _n > max_dirs or (_t.time() - started) > max_seconds:
                break
            if progress and _n % 8 == 0:
                try:
                    progress(_n, 0, "正在扫描截图：%s" % os.path.basename(dp))
                except Exception:
                    pass
            depth = os.path.relpath(dp, root_dir).count(os.sep)
            if depth >= SHOT_MAX_DEPTH:
                dns[:] = []
            dns[:] = [d for d in dns if d.lower() not in INDEX_SKIP and not d.startswith(".")]
            for n in fns:
                p = os.path.join(dp, n)
                if all_images:
                    if os.path.splitext(n)[1].lower() not in SHOT_EXTS:
                        continue
                elif not _is_shot_file(p):
                    continue
                k = os.path.normcase(p)
                if k in seen:
                    continue
                seen.add(k)
                try:
                    st = os.stat(p)
                except OSError:
                    continue
                if st.st_mtime > cutoff or st.st_size < lo:
                    continue
                hits.append((p, st.st_size, st.st_mtime))
    hits.sort(key=lambda x: -x[2])
    return hits


def clean_screenshots(dirs=None, keep_days=7, min_kb=0, to_trash=True, all_images=False):
    """删掉命中的截图，返回 (已删列表, 失败列表, 释放字节)。"""
    hits = find_screenshots(dirs, keep_days, min_kb, all_images=all_images)
    paths = [p for p, _, _ in hits]
    size = sum(s for _, s, _ in hits)
    if not paths:
        return [], [], 0
    ok, fail = (trash_delete(paths) if to_trash else delete_paths(paths))
    return ok, fail, size


# ─────────────────────────── 缓存清理 ───────────────────────────
#
# 设计参考 BleachBit（GPLv3，Python 实现，https://github.com/bleachbit/bleachbit）。
# 它的 CoreML 做法值得学的两点：
#   1. 每个清理项都带 warning 级别，默认只勾选最低级别；
#   2. 一条条写死路径 + 明确排除，绝不"扫到什么删什么"。
# 我们照此实现：只清理**已知的缓存位置**，不做全盘猜测。

# 安全级别：1=安全（删了只是下次重新生成）2=谨慎（会丢登录态/历史/预览）
#           3=高级（需要管理员，或会影响正在运行的程序）
def _steam_cache_paths():
    """Steam 不总装在 Program Files：先读注册表拿真实库位置，再补默认路径。"""
    roots = []
    try:
        import winreg
        for hive, key in ((winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam"),
                          (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Valve\Steam")):
            try:
                with winreg.OpenKey(hive, key) as k:
                    p = winreg.QueryValueEx(k, "SteamPath")[0]
                p = os.path.normpath(os.path.expandvars(str(p)))
                if p and p not in roots:
                    roots.append(p)
            except OSError:
                pass
    except Exception:
        pass
    out = []
    for r in roots:
        out.append(os.path.join(r, "steamapps", "downloading"))
        out.append(os.path.join(r, "appcache", "httpcache"))
    out += [r"%PROGRAMFILES(X86)%\Steam\steamapps\downloading",
            r"%PROGRAMFILES%\Steam\steamapps\downloading",
            r"%PROGRAMFILES(X86)%\Steam\appcache\httpcache"]
    return out


CACHE_ITEMS = [
    # ── 用户临时文件 ──
    dict(id="user_temp", name="用户临时文件", group="系统",
         level=1, admin=False, kind="contents",
         paths=[r"%TEMP%", r"%LOCALAPPDATA%\Temp"],
         note="程序运行时留下的临时文件，删掉不影响系统"),
    dict(id="crash_dumps", name="崩溃转储", group="系统",
         level=1, admin=False, kind="contents",
         paths=[r"%LOCALAPPDATA%\CrashDumps"],
         note="程序崩溃时生成的 dump 文件"),
    dict(id="wer_report", name="错误报告队列", group="系统",
         level=1, admin=False, kind="contents",
         paths=[r"%LOCALAPPDATA%\Microsoft\Windows\WER",
                r"%PROGRAMDATA%\Microsoft\Windows\WER\ReportQueue",
                r"%PROGRAMDATA%\Microsoft\Windows\WER\ReportArchive"],
         note="Windows 错误报告，删了不会再上传旧报告"),

    # ── 浏览器缓存（只碰 Cache，不碰书签/密码/Cookie）──
    dict(id="chrome_cache", name="Chrome 缓存", group="浏览器",
         level=1, admin=False, kind="contents",
         paths=[r"%LOCALAPPDATA%\Google\Chrome\User Data\*\Cache",
                r"%LOCALAPPDATA%\Google\Chrome\User Data\*\Code Cache",
                r"%LOCALAPPDATA%\Google\Chrome\User Data\*\GPUCache",
                r"%LOCALAPPDATA%\Google\Chrome\User Data\ShaderCache",
                r"%LOCALAPPDATA%\Google\Chrome\User Data\*\GrShaderCache",
                r"%LOCALAPPDATA%\Google\Chrome\User Data\*\DawnGraphiteCache",
                r"%LOCALAPPDATA%\Google\Chrome\User Data\*\DawnWebGPUCache",
                r"%LOCALAPPDATA%\Google\Chrome\User Data\*\Media Cache",
                r"%LOCALAPPDATA%\Google\Chrome\User Data\*\Service Worker\CacheStorage"],
         note="网页图片/脚本/媒体缓存，不含书签、密码、历史"),
    dict(id="edge_cache", name="Edge 缓存", group="浏览器",
         level=1, admin=False, kind="contents",
         paths=[r"%LOCALAPPDATA%\Microsoft\Edge\User Data\*\Cache",
                r"%LOCALAPPDATA%\Microsoft\Edge\User Data\*\Code Cache",
                r"%LOCALAPPDATA%\Microsoft\Edge\User Data\*\GPUCache",
                r"%LOCALAPPDATA%\Microsoft\Edge\User Data\*\GrShaderCache",
                r"%LOCALAPPDATA%\Microsoft\Edge\User Data\*\DawnGraphiteCache",
                r"%LOCALAPPDATA%\Microsoft\Edge\User Data\*\DawnWebGPUCache",
                r"%LOCALAPPDATA%\Microsoft\Edge\User Data\*\Media Cache",
                r"%LOCALAPPDATA%\Microsoft\Edge\User Data\*\Service Worker\CacheStorage"],
         note="同上"),
    dict(id="firefox_cache", name="Firefox 缓存", group="浏览器",
         level=1, admin=False, kind="contents",
         paths=[r"%LOCALAPPDATA%\Mozilla\Firefox\Profiles\*\cache2",
                r"%LOCALAPPDATA%\Mozilla\Firefox\Profiles\*\startupCache",
                r"%LOCALAPPDATA%\Mozilla\Firefox\Profiles\*\shader-cache"],
         note="同上"),
    dict(id="brave_cache", name="Brave 缓存", group="浏览器",
         level=1, admin=False, kind="contents",
         paths=[r"%LOCALAPPDATA%\BraveSoftware\Brave-Browser\User Data\*\Cache",
                r"%LOCALAPPDATA%\BraveSoftware\Brave-Browser\User Data\*\Code Cache",
                r"%LOCALAPPDATA%\BraveSoftware\Brave-Browser\User Data\*\GPUCache",
                r"%LOCALAPPDATA%\BraveSoftware\Brave-Browser\User Data\*\Service Worker\CacheStorage"],
         note="不存在时显示灰色未安装"),
    dict(id="vivaldi_cache", name="Vivaldi 缓存", group="浏览器",
         level=1, admin=False, kind="contents",
         paths=[r"%LOCALAPPDATA%\Vivaldi\User Data\*\Cache",
                r"%LOCALAPPDATA%\Vivaldi\User Data\*\Code Cache",
                r"%LOCALAPPDATA%\Vivaldi\User Data\*\GPUCache",
                r"%LOCALAPPDATA%\Vivaldi\User Data\*\Service Worker\CacheStorage"],
         note="不存在时显示灰色未安装"),
    dict(id="opera_cache", name="Opera 缓存", group="浏览器",
         level=1, admin=False, kind="contents",
         paths=[r"%APPDATA%\Opera Software\Opera Stable\Cache",
                r"%APPDATA%\Opera Software\Opera Stable\Code Cache",
                r"%APPDATA%\Opera Software\Opera Stable\GPUCache",
                r"%APPDATA%\Opera Software\Opera Stable\Service Worker\CacheStorage"],
         note="不存在时显示灰色未安装"),
    dict(id="browser_360_cache", name="360 浏览器缓存", group="浏览器",
         level=1, admin=False, kind="contents",
         paths=[r"%LOCALAPPDATA%\360Chrome\Chrome\User Data\*\Cache",
                r"%LOCALAPPDATA%\360Chrome\Chrome\User Data\*\Code Cache",
                r"%LOCALAPPDATA%\360Chrome\Chrome\User Data\*\GPUCache"],
         note="不存在时显示灰色未安装"),
    dict(id="qqbrowser_cache", name="QQ 浏览器缓存", group="浏览器",
         level=1, admin=False, kind="contents",
         paths=[r"%LOCALAPPDATA%\Tencent\QQBrowser\User Data\*\Cache",
                r"%LOCALAPPDATA%\Tencent\QQBrowser\User Data\*\Code Cache",
                r"%LOCALAPPDATA%\Tencent\QQBrowser\User Data\*\GPUCache"],
         note="不存在时显示灰色未安装"),
    dict(id="ie_cache", name="IE / 系统网页缓存", group="浏览器",
         level=1, admin=False, kind="contents",
         paths=[r"%LOCALAPPDATA%\Microsoft\Windows\INetCache"],
         note="系统组件和旧版程序用的网页缓存"),

    # ── 开发工具缓存 ──
    dict(id="pip_cache", name="pip 下载缓存", group="开发",
         level=1, admin=False, kind="contents",
         paths=[r"%LOCALAPPDATA%\pip\Cache"],
         note="pip 装过的包会重新下载"),
    dict(id="npm_cache", name="npm 缓存", group="开发",
         level=1, admin=False, kind="contents",
         paths=[r"%LOCALAPPDATA%\npm-cache", r"%APPDATA%\npm-cache"],
         note="npm 的包缓存"),
    dict(id="yarn_cache", name="Yarn 缓存", group="开发",
         level=1, admin=False, kind="contents",
         paths=[r"%LOCALAPPDATA%\Yarn\Cache", r"%LOCALAPPDATA%\Yarn\Berry\cache"],
         note="Yarn 的包缓存"),
    dict(id="nuget_cache", name="NuGet 缓存", group="开发",
         level=1, admin=False, kind="contents",
         paths=[r"%USERPROFILE%\.nuget\packages",
                r"%LOCALAPPDATA%\NuGet\v3-cache"],
         note=".NET 包缓存，项目重建时会重新下载"),
    dict(id="gradle_cache", name="Gradle 缓存", group="开发",
         level=2, admin=False, kind="contents",
         paths=[r"%USERPROFILE%\.gradle\caches"],
         note="Android/Java 构建缓存，删了首次构建会变慢"),
    dict(id="maven_cache", name="Maven 本地库", group="开发",
         level=2, admin=False, kind="contents",
         paths=[r"%USERPROFILE%\.m2\repository"],
         note="删了 Maven 项目要重新下载依赖"),
    dict(id="vscode_cache", name="VS Code 缓存", group="应用",
         level=1, admin=False, kind="contents",
         paths=[r"%APPDATA%\Code\Cache", r"%APPDATA%\Code\CachedData",
                r"%APPDATA%\Code\GPUCache", r"%APPDATA%\Code\logs",
                r"%APPDATA%\Code\Crashpad"],
         note="不含插件和设置"),

    # ── 常见应用缓存 ──
    dict(id="discord_cache", name="Discord 缓存", group="应用",
         level=1, admin=False, kind="contents",
         paths=[r"%APPDATA%\discord\Cache", r"%APPDATA%\discord\Code Cache",
                r"%APPDATA%\discord\GPUCache"],
         note="聊天记录保存在别处，不受影响"),
    dict(id="teams_cache", name="Teams 缓存", group="应用",
         level=1, admin=False, kind="contents",
         paths=[r"%APPDATA%\Microsoft\Teams\Cache",
                r"%APPDATA%\Microsoft\Teams\GPUCache"],
         note="重启 Teams 会重新登录同步"),
    dict(id="slack_cache", name="Slack 缓存", group="应用",
         level=1, admin=False, kind="contents",
         paths=[r"%APPDATA%\Slack\Cache", r"%APPDATA%\Slack\GPUCache"],
         note="同上"),
    dict(id="spotify_cache", name="Spotify 缓存", group="应用",
         level=1, admin=False, kind="contents",
         paths=[r"%LOCALAPPDATA%\Spotify\Storage",
                r"%LOCALAPPDATA%\Spotify\Data"],
         note="已下载的离线歌曲会被清掉，需重新下载"),
    dict(id="wechat_cache", name="微信缓存", group="应用",
         level=1, admin=False, kind="contents",
         paths=[r"%USERPROFILE%\Documents\WeChat Files\*\FileStorage\Cache",
                r"%USERPROFILE%\Documents\WeChat Files\*\FileStorage\CustomEmotion"],
         note="只清缓存目录，聊天记录和收到的文件不动"),
    dict(id="qq_cache", name="QQ 缓存", group="应用",
         level=1, admin=False, kind="contents",
         paths=[r"%USERPROFILE%\Documents\Tencent Files\*\FileRecv\Cache"],
         note="同上"),

    # ── 商店应用（UWP / Microsoft Store）──
    dict(id="uwp_localcache", name="商店应用本地缓存", group="商店应用",
         level=1, admin=False, kind="contents",
         paths=[r"%LOCALAPPDATA%\Packages\*\LocalCache",
                r"%LOCALAPPDATA%\Packages\*\TempState",
                r"%LOCALAPPDATA%\Packages\*\AC\Temp",
                r"%LOCALAPPDATA%\Packages\*\AC\INetCache",
                r"%LOCALAPPDATA%\Packages\*\AC\Microsoft\CryptnetUrlCache"],
         note="只删 LocalCache / TempState / AC 这些纯缓存目录",
         boundary="不动 LocalState（登录状态、设置、聊天记录）、"
                  "不动 RoamingState、不动已安装的程序本体"),
    dict(id="uwp_localstate", name="商店应用用户数据（默认不勾）", group="商店应用",
         level=3, admin=False, kind="contents",
         paths=[r"%LOCALAPPDATA%\Packages\*\LocalState"],
         note="这是应用自己的数据，删了等于把该应用重置",
         boundary="LocalState 里可能有你的记录/存档。仅在你确定要重置某个应用时才勾选"),
    dict(id="uwp_install_cache", name="商店应用安装缓存", group="商店应用",
         level=2, admin=False, kind="contents",
         paths=[r"%LOCALAPPDATA%\Packages\Microsoft.WindowsStore_*\LocalCache",
                r"%LOCALAPPDATA%\Packages\Microsoft.WindowsStore_*\TempState"],
         note="Store 自己的下载缓存"),

    # ── 桌面应用 / 显卡与系统组件缓存 ──
    dict(id="d3d_shader", name="DirectX 着色器缓存", group="桌面应用",
         level=1, admin=False, kind="contents",
         paths=[r"%LOCALAPPDATA%\D3DSCache",
                r"%LOCALAPPDATA%\Microsoft\DirectX\ShaderCache",
                r"%LOCALAPPDATA%\Microsoft\DirectX Shader Cache"],
         note="游戏/程序第一次运行会重建", boundary="只删着色器缓存，不动游戏存档"),
    dict(id="nvidia_shader", name="NVIDIA 着色器缓存", group="桌面应用",
         level=1, admin=False, kind="contents",
         paths=[r"%LOCALAPPDATA%\NVIDIA\DXCache",
                r"%LOCALAPPDATA%\NVIDIA\GLCache",
                r"%LOCALAPPDATA%\NVIDIA\ComputeCache"],
         note="首次进游戏会重新编译，略慢一次",
         boundary="不动 NVIDIA 驱动安装目录、不动 GeForce Experience 录屏"),
    dict(id="amd_shader", name="AMD 着色器缓存", group="桌面应用",
         level=1, admin=False, kind="contents",
         paths=[r"%LOCALAPPDATA%\AMD\DxCache", r"%LOCALAPPDATA%\AMD\DxcCache",
                r"%LOCALAPPDATA%\AMD\GLCache", r"%LOCALAPPDATA%\AMD\VkCache"],
         note="同上"),
    dict(id="intel_shader", name="Intel 显卡着色器缓存", group="桌面应用",
         level=1, admin=False, kind="contents",
         paths=[r"%LOCALAPPDATA%\Intel\ShaderCache"],
         note="同上"),
    dict(id="font_cache", name="字体缓存", group="桌面应用",
         level=1, admin=False, kind="contents",
         paths=[r"%LOCALAPPDATA%\Microsoft\Windows\FontCache",
                r"%LOCALAPPDATA%\FontCache"],
         note="删了字体会自动重建", boundary="不动 C:\\Windows\\Fonts 里的字体文件"),
    dict(id="office_cache", name="Office 缓存", group="桌面应用",
         level=1, admin=False, kind="contents",
         paths=[r"%LOCALAPPDATA%\Microsoft\Office\*\Cache",
                r"%LOCALAPPDATA%\Microsoft\Office\*\OfficeFileCache"],
         note="不影响已保存的文档",
         boundary="不动 .docx/.xlsx 本体、不动 OneDrive 同步目录"),
    dict(id="edge_webview_cache", name="WebView2 / 组件网页缓存", group="桌面应用",
         level=1, admin=False, kind="contents",
         paths=[r"%LOCALAPPDATA%\Microsoft\EdgeWebView\*\EBWebView\Default\Cache",
                r"%LOCALAPPDATA%\Microsoft\EdgeWebView\*\EBWebView\Default\Code Cache",
                r"%LOCALAPPDATA%\Microsoft\EdgeWebView\*\EBWebView\Default\GPUCache"],
         note="很多桌面程序内嵌网页都用它"),
    dict(id="vs_component_cache", name="Visual Studio 组件缓存", group="开发",
         level=1, admin=False, kind="contents",
         paths=[r"%LOCALAPPDATA%\Microsoft\VisualStudio\*\ComponentModelCache",
                r"%LOCALAPPDATA%\Microsoft\VSCommon\*\Cache"],
         note="不含项目和代码"),
    dict(id="jetbrains_cache", name="JetBrains 索引缓存", group="开发",
         level=2, admin=False, kind="contents",
         paths=[r"%LOCALAPPDATA%\JetBrains\*\caches",
                r"%LOCALAPPDATA%\JetBrains\*\tmp"],
         note="删了下次打开项目要重新建索引",
         boundary="不动配置、不动插件、不动你的项目文件"),
    dict(id="unity_cache", name="Unity 缓存", group="开发",
         level=2, admin=False, kind="contents",
         paths=[r"%LOCALAPPDATA%\Unity\cache",
                r"%LOCALAPPDATA%\Unity\Asset Store-5.x"],
         note="不含工程目录"),
    dict(id="adobe_media_cache", name="Adobe 媒体缓存", group="桌面应用",
         level=1, admin=False, kind="contents",
         paths=[r"%APPDATA%\Adobe\Common\Media Cache",
                r"%APPDATA%\Adobe\Common\Media Cache Files"],
         note="Pr/Ae 的预览缓存，工程文件不动"),
    dict(id="epic_webcache", name="Epic 启动器网页缓存", group="桌面应用",
         level=1, admin=False, kind="contents",
         paths=[r"%LOCALAPPDATA%\EpicGamesLauncher\Saved\webcache"],
         note="不含游戏本体和云存档"),
    dict(id="steam_download", name="Steam 下载缓存", group="桌面应用",
         level=2, admin=False, kind="contents",
         paths=_steam_cache_paths(),
         note="未下完的分片与启动器网页缓存，删了要重新下",
         boundary="只删 downloading / appcache\\httpcache，不动 steamapps\\common 里已装好的游戏"),
    dict(id="wegame_cache", name="WeGame 网页缓存", group="应用",
         level=2, admin=False, kind="contents",
         paths=[r"%APPDATA%\Tencent\WeGame\qbcore109\cache",
                r"%APPDATA%\Tencent\WeGame\qbcore91\cache"],
         note="WeGame 内置浏览器缓存，账号与游戏不动"),
    dict(id="wps_cache", name="WPS 缓存", group="应用",
         level=1, admin=False, kind="contents",
         paths=[r"%APPDATA%\kingsoft\office6\cache"],
         note="WPS 的预览与临时缓存，文档本体不动"),
    dict(id="wechat4_media", name="微信 4.x 媒体缓存", group="应用",
         level=2, admin=False, kind="contents",
         paths=[r"%APPDATA%\Tencent\xwechat\radium"],
         note="视频/图片缓存；聊天记录、收到的文件不在这个目录"),
    dict(id="wechat4_log", name="微信 4.x 日志", group="应用",
         level=1, admin=False, kind="contents",
         paths=[r"%APPDATA%\Tencent\xwechat\log"],
         note="运行日志，删了不影响聊天与登录"),
    dict(id="terminal_server_cache", name="远程桌面缓存", group="系统",
         level=1, admin=False, kind="contents",
         paths=[r"%LOCALAPPDATA%\Microsoft\Terminal Server Client\Cache"],
         note="远程桌面位图缓存，重新连接会重建"),
    dict(id="cargo_cache", name="Cargo 下载缓存", group="开发",
         level=1, admin=False, kind="contents",
         paths=[r"%USERPROFILE%\.cargo\registry\cache"],
         note="Rust 依赖压缩包，重新编译会重新下载"),
    dict(id="go_build_cache", name="Go 构建缓存", group="开发",
         level=1, admin=False, kind="contents",
         paths=[r"%LOCALAPPDATA%\go-build"],
         note="Go 编译缓存，删了首次编译变慢"),
    dict(id="pnpm_cache", name="pnpm 缓存", group="开发",
         level=1, admin=False, kind="contents",
         paths=[r"%LOCALAPPDATA%\pnpm\store", r"%LOCALAPPDATA%\pnpm-cache"],
         note="pnpm 全局包仓库缓存"),
    dict(id="composer_cache", name="Composer 缓存", group="开发",
         level=1, admin=False, kind="contents",
         paths=[r"%LOCALAPPDATA%\Composer\cache"],
         note="PHP 依赖缓存，安装时会重新下载"),
    dict(id="unreal_ddc", name="Unreal 派生数据缓存", group="开发",
         level=2, admin=False, kind="contents",
         paths=[r"%LOCALAPPDATA%\UnrealEngine\Common\DerivedDataCache",
                r"%LOCALAPPDATA%\UnrealEngine\Common\DerivedDataBackendGraph"],
         note="引擎着色器/派生数据缓存，删后首次打开项目会重建",
         boundary="只删 DDC，不动 .uproject 与引擎安装"),

    # ── 系统级（要管理员）──
    dict(id="system_temp", name="Windows SystemTemp", group="系统",
         level=3, admin=True, kind="contents",
         paths=[r"%WINDIR%\SystemTemp"],
         note="Win11 系统级临时目录，需要管理员"),
    dict(id="cbs_logs", name="组件安装日志（CBS）", group="系统",
         level=3, admin=True, kind="contents",
         paths=[r"%WINDIR%\Logs\CBS"],
         note="Windows 组件安装/更新日志，排查问题时才有用；需要管理员"),
    dict(id="win_temp", name="Windows 临时目录", group="系统",
         level=3, admin=True, kind="contents",
         paths=[r"%WINDIR%\Temp"],
         note="需要管理员；正在被占用的文件会自动跳过"),
    dict(id="win_update", name="Windows 更新下载缓存", group="系统",
         level=3, admin=True, kind="contents",
         paths=[r"%WINDIR%\SoftwareDistribution\Download"],
         note="已经装过的更新包，删了不会回滚已装更新"),
    dict(id="delivery_opt", name="传递优化缓存", group="系统",
         level=3, admin=True, kind="contents",
         paths=[r"%WINDIR%\SoftwareDistribution\DeliveryOptimization",
                r"%PROGRAMDATA%\Microsoft\Windows\DeliveryOptimization\Cache"],
         note="Windows 局域网更新分发缓存"),
    dict(id="thumbs", name="缩略图缓存", group="系统",
         level=2, admin=False, kind="files",
         paths=[r"%LOCALAPPDATA%\Microsoft\Windows\Explorer\thumbcache_*.db"],
         note="删了缩略图会重建；正在被资源管理器占用的会跳过"),
    dict(id="thumb_old", name="旧缩略图数据库", group="系统",
         level=2, admin=False, kind="files",
         paths=[r"%LOCALAPPDATA%\Microsoft\Windows\Explorer\iconcache_*.db"],
         note="图标缓存，删了自动重建"),
    dict(id="prefetch", name="预读取文件（Prefetch）", group="系统",
         level=3, admin=True, kind="contents",
         paths=[r"%WINDIR%\Prefetch"],
         note="删了程序首次启动会慢一点；需要管理员",
         boundary="只删 .pf 预读取记录，不动任何程序"),
    dict(id="recycle_bin", name="回收站", group="系统",
         level=2, admin=False, kind="recycle",
         paths=[],
         note="清空回收站 = 里面的文件彻底没了，慎用"),
]


def cache_custom_items():
    """把设置里的自定义缓存目录整理成缓存项（GUI 与 --engine 共用）。

    只保留真实存在的目录；准入校验留给清理环节的 check_cache_custom_dir，
    列表阶段不偷偷过滤，否则用户会以为自己的设置丢了。
    """
    out = []
    for p in (S.get("cache_custom_dirs") or []):
        if not isinstance(p, str) or not p.strip():
            continue
        d = os.path.normpath(os.path.abspath(
            os.path.expandvars(os.path.expanduser(p.strip()))))
        if not os.path.isdir(d):
            continue
        out.append(dict(id="custom:" + os.path.normcase(d),
                        name="自定义：" + (os.path.basename(d.rstrip("\\")) or d),
                        group="自定义", level=3, admin=False, kind="contents",
                        paths=[d], note="你自己添加的目录"))
    return out


# 任何情况下都不碰（路径里出现这些片段就拒绝）
CACHE_FORBIDDEN = [
    r"\windows\system32", r"\windows\syswow64", r"\windows\winsxs",
    r"\windows\system32\config", r"\windows\system32\drivers",
    r"\windows\servicing", r"\windows\assembly", r"\windows\boot",
    r"\windows\fonts", r"\windows\system32\catroot",
    r"\programdata\microsoft\crypto", r"\programdata\microsoft\windows\system32",
    r"\system volume information", r"\$recycle.bin\s-1-5-18",
    r"\users\all users",
]


def cache_path_forbidden(path):
    """判断这个路径是否属于绝对禁碰区。返回 (是否禁止, 原因)。"""
    p = os.path.normcase(os.path.normpath(os.path.abspath(path)))
    for pat in CACHE_FORBIDDEN:
        if p.endswith(pat) or (pat + os.sep) in (p + os.sep):
            return True, "系统关键目录"
    # 用户目录下的私人文件一律不碰
    home = os.path.normcase(os.path.expanduser("~"))
    for sub in ("documents", "desktop", "pictures", "videos", "music",
                "onedrive", ".ssh", ".git", "appdata\\roaming\\microsoft\\crypto"):
        full = os.path.join(home, sub)
        if p == full or p.startswith(full + os.sep):
            # 例外：明确列在 CACHE_ITEMS 里的缓存子目录
            return True, "个人文件目录"
    return False, ""


_APP_GUARD_RULES = []


def app_guard_rules():
    """不在 GUI 作用域里的调用（缓存清理、计划任务）用它拿规则，只读一次。"""
    if _APP_GUARD_RULES:
        return _APP_GUARD_RULES[0]
    try:
        r = load_rules()
    except Exception:
        r = None
    _APP_GUARD_RULES.append(r)
    return r


def check_cache_custom_dir(path, rules=None):
    """自定义缓存目录准入判定。None = 可以清理，否则返回拒绝原因。

    这条规则是拿真金白银换来的：曾经把 C:\\ 和 D:\\ 加成自定义缓存目录，
    一次定时清理删掉 254845 个文件 / 43.24 GB，D:\\App、D:\\Tool 下
    一堆软件目录只剩空壳（CapCut、bilibili、BandiZip、ATK HUB…）。
    """
    rules = rules or app_guard_rules()
    if rules is None:
        return "规则文件读不到，为安全起见不允许自定义缓存目录"
    if not os.path.isdir(path):
        return "目录不存在"
    p = os.path.abspath(path)
    if rules.cache_forbid_roots and is_drive_root(p):
        drive, _tail = os.path.splitdrive(p)
        return "%s\\ 是盘符根目录，绝对不能当缓存目录" % drive
    bad, why = cache_path_forbidden(p)
    if bad:
        return "属于「%s」，不在可清理范围内" % why
    depth = len([x for x in p.split(os.sep) if x])
    if depth > rules.cache_custom_max_depth:
        return f"目录层级过深（{depth} 层），不像是缓存目录"
    if rules.cache_forbid_apps:
        hit, ev = looks_like_app_dir(p, rules)
        if hit:
            return "这是程序安装目录（%s），不能清" % "；".join(ev[:2])
        # 它下面第一层就是程序目录 → 说明这是个「应用总目录」，也不能整清
        try:
            for name in os.listdir(p)[:200]:
                sub = os.path.join(p, name)
                if os.path.isdir(sub) and not os.path.islink(sub):
                    h2, ev2 = looks_like_app_dir(sub, rules)
                    if h2:
                        return ("该目录下面就是程序安装目录「%s」（%s），"
                                "不能把它当缓存目录整个清" % (name, "；".join(ev2[:1])))
        except OSError:
            pass
    return None


def _expand_cache_paths(pat):
    """把 %VAR% 和 * 展开成真实路径列表。"""
    import glob as _glob
    p = os.path.expandvars(pat)
    if "%" in p:          # 变量没展开，说明环境里没有
        return []
    if "*" in p or "?" in p:
        return [x for x in _glob.glob(p) if os.path.exists(x)]
    return [p] if os.path.exists(p) else []


FILE_ATTRIBUTE_REPARSE_POINT = 0x400


def _entry_is_link(e):
    """符号链接 / junction 都要跳过。

    坑：DirEntry.is_junction() 是 Python 3.12 才加的，3.11 上调用
    直接 AttributeError —— 整个缓存清理会崩在统计大小的这一步。
    这里退回 FILE_ATTRIBUTE_REPARSE_POINT 属性判断，3.11/3.12 都能用。
    """
    try:
        if e.is_symlink():
            return True
    except OSError:
        return False
    try:
        st = e.stat(follow_symlinks=False)
    except OSError:
        return False
    return bool(getattr(st, "st_file_attributes", 0) & FILE_ATTRIBUTE_REPARSE_POINT)


def _tree_size(path, limit_files=200000):
    """算目录/文件占用，跳过符号链接和重解析点。返回 (字节数, 文件数)。"""
    total = files = 0
    try:
        if os.path.isfile(path):
            return os.path.getsize(path), 1
        stack = [path]
        while stack:
            cur = stack.pop()
            try:
                with os.scandir(cur) as it:
                    for e in it:
                        try:
                            if _entry_is_link(e):
                                continue
                            if e.is_dir(follow_symlinks=False):
                                stack.append(e.path)
                            else:
                                total += e.stat(follow_symlinks=False).st_size
                                files += 1
                                if files >= limit_files:
                                    return total, files
                        except OSError:
                            continue
            except OSError:
                continue
    except OSError:
        pass
    return total, files


def scan_caches(only_ids=None, progress=None):
    """扫描内置缓存项，返回 [{item, paths, size, count, blocked}]。"""
    out = []
    todo = [it for it in CACHE_ITEMS
            if (not only_ids or it["id"] in only_ids) and it["kind"] != "recycle"]
    total = len(todo) or 1
    for idx, it in enumerate(todo, 1):
        if progress:
            try:
                progress(idx - 1, total, "正在统计 %s（%d/%d）"
                          % (it["name"], idx, total))
            except Exception:
                pass
        real = []
        for pat in it["paths"]:
            for p in _expand_cache_paths(pat):
                bad, why = cache_path_forbidden(p)
                if bad:
                    continue
                if p not in real:
                    real.append(p)
        size = count = 0
        for p in real:
            s, c = _tree_size(p)
            size += s
            count += c
        out.append(dict(item=it, paths=real, size=size, count=count))
    return out


def _fail_reason(ex):
    """把 OSError 翻成一句能看懂的原因，带 WinError 码。"""
    code = getattr(ex, "winerror", None) or getattr(ex, "errno", None)
    table = {
        2: "文件或路径不存在",
        3: "路径不存在",
        5: "拒绝访问（权限不够或只读）",
        32: "被其他程序占用（文件正开着）",
        33: "文件被区域锁锁定",
        145: "目录非空（里面还有删不掉的东西）",
        206: "路径太长",
        267: "路径无效",
        1392: "文件已损坏，无法读取",
    }
    what = table.get(code) or (getattr(ex, "strerror", None) or "").strip() or "未知错误"
    if code:
        return "%s（WinError %s）" % (what, code)
    return what


def _clear_readonly(path):
    """去掉只读属性。返回是否真的改过。"""
    try:
        import stat as _stat
        mode = os.stat(path).st_mode
        if not mode & _stat.S_IWRITE:
            os.chmod(path, mode | _stat.S_IWRITE)
            return True
    except OSError:
        pass
    return False


def _remove_file_stubborn(p):
    """删单个文件；只读就先去掉只读再试一次。返回 (成功, 原因)。"""
    try:
        os.remove(p)
        return True, ""
    except OSError as ex1:
        if _clear_readonly(p):
            try:
                os.remove(p)
                return True, ""
            except OSError as ex2:
                return False, _fail_reason(ex2)
        return False, _fail_reason(ex1)


def _rm_tree_reported(p):
    """整棵删目录；失败时逐个文件再试，回报到底哪几个删不掉、为什么。

    以前这里只有 shutil.rmtree + 一句「被占用或拒绝访问」，
    日志里「失败 73」查不出是哪些文件、什么原因，所以重写成能留下证据。
    返回 [(路径, 原因)]，空列表表示删干净了。
    """
    if not os.path.isdir(p):
        return []
    try:
        shutil.rmtree(p, ignore_errors=False)
        return []
    except OSError:
        pass
    stuck = []
    for base, dirs, files in os.walk(p, topdown=False):
        for fn in files:
            fp = os.path.join(base, fn)
            ok, why = _remove_file_stubborn(fp)
            if not ok:
                stuck.append((fp, why))
        for dn in dirs:
            try:
                os.rmdir(os.path.join(base, dn))
            except OSError:
                pass
    try:
        os.rmdir(p)
    except OSError:
        pass
    return stuck


def clean_cache_paths(real_paths, progress=None, rules=None, skipped=None):
    """清空这些目录里的内容（目录本身保留）。

    返回 (删除数, 失败列表, 释放字节)。失败列表每项是 (路径, 原因)，
    原因带 WinError 码；目录整棵删不掉时按「具体卡住的文件」逐条记。

    rules 不为空时启用程序目录保护：盘符根目录直接拒绝，程序安装目录
    整棵跳过，可执行文件/程序文件按扩展名保留，跳过的记进 skipped。
    """
    removed, failed, freed = 0, [], 0
    gone = []                    # 真删掉的路径，最后一次性写回索引
    rules = rules or app_guard_rules()
    protect = bool(rules and rules.cache_skip_apps)
    keep_exts = rules.cache_keep_exts if rules else set()
    _total = len(real_paths) or 1
    for _i, root in enumerate(real_paths, 1):
        if progress:
            try:
                progress(_i - 1, _total, "正在清理 %d/%d：%s"
                          % (_i, _total, os.path.basename(root) or root))
            except Exception:
                pass
        bad, why = cache_path_forbidden(root)
        if bad:
            failed.append((root, "已拒绝：" + why))
            continue
        if rules and rules.cache_forbid_roots and is_drive_root(root):
            failed.append((root, "已拒绝：盘符根目录不能作为缓存目录"))
            continue
        if rules and rules.cache_forbid_apps and looks_like_app_dir(root, rules)[0]:
            # 兜底：设置里可能还留着旧版本加进来的程序目录
            msg = "已拒绝：这是程序安装目录（%s）" % "；".join(
                looks_like_app_dir(root, rules)[1][:1])
            if skipped is not None:
                skipped.append((root, msg))
            else:
                failed.append((root, msg))
            continue
        if os.path.isfile(root):
            try:
                sz = os.path.getsize(root)
            except OSError:
                sz = 0
            ok, why = _remove_file_stubborn(root)
            if ok:
                removed += 1
                freed += sz
            else:
                failed.append((root, why))
            continue
        try:
            with os.scandir(root) as it:
                entries = [e.path for e in it]
        except OSError as ex:
            failed.append((root, _fail_reason(ex)))
            continue
        for p in entries:
            if protect and not os.path.islink(p):
                if os.path.isdir(p):
                    h_app, ev_app = looks_like_app_dir(p, rules)
                    if h_app:
                        if skipped is not None:
                            skipped.append((p, "程序安装目录：" + "；".join(ev_app[:1])))
                        continue
                elif os.path.splitext(p)[1].lower() in keep_exts:
                    if skipped is not None:
                        skipped.append((p, "可执行/程序文件，保留"))
                    continue
            if os.path.isdir(p) and not os.path.islink(p):
                s, c = _tree_size(p)
                stuck = _rm_tree_reported(p)
                if not stuck:
                    removed += c
                    freed += s
                    gone.append(p)
                    continue
                for fp, why in stuck:
                    failed.append((fp, why))
                # 部分删掉了：用「原体积减剩余」估算真实释放量
                s2, c2 = _tree_size(p)
                removed += max(0, c - c2)
                freed += max(0, s - s2)
                gone.append(p)
                continue
            try:
                sz = os.path.getsize(p)
            except OSError:
                sz = 0
            ok, why = _remove_file_stubborn(p)
            if ok:
                removed += 1
                freed += sz
                gone.append(p)
            else:
                failed.append((p, why))
    # 清缓存是最典型的「软件自己腾了空间」：不清索引，用户清完再问
    # 「什么最占空间」，看到的还是清之前那份账
    if gone:
        index_touch(gone)
    return removed, failed, freed


def empty_recycle_bin():
    """清空回收站（用 shell 接口，绕开删除权限问题）。"""
    try:
        import ctypes
        flags = 0x1 | 0x2 | 0x4          # NOCONFIRM | NOPROGRESS | NOSOUND
        r = ctypes.windll.shell32.SHEmptyRecycleBinW(None, None, flags)
        return r == 0, ""
    except Exception as ex:
        return False, str(ex)


def _fallback_icon(kind="img"):
    """没有缩略图时用的 16x16 小图标（纯 tk.PhotoImage 画，不依赖 PIL）。"""
    import tkinter as _tk
    img = _tk.PhotoImage(width=16, height=16)
    img.put("#ffffff", to=(0, 0, 16, 16))
    frame = "#9aa2ad"
    body = "#c9d0d8" if kind == "img" else "#c2cbd6"
    img.put(frame, to=(1, 2, 15, 3))
    img.put(frame, to=(1, 13, 15, 14))
    img.put(frame, to=(1, 2, 2, 14))
    img.put(frame, to=(14, 2, 15, 14))
    img.put(body, to=(2, 3, 14, 13))
    img.put("#f2f5f8", to=(3, 4, 13, 9))
    if kind == "img":
        img.put("#8fb6e0", to=(3, 4, 13, 7))          # 天空
        img.put("#7fbf8a", to=(4, 9, 8, 12))          # 山
        img.put("#5f9f6c", to=(7, 7, 13, 12))
        img.put("#f4c542", to=(10, 5, 12, 7))         # 太阳
    else:                                              # 视频：播放三角
        img.put("#8d99a8", to=(3, 4, 13, 12))
        for i in range(6):
            img.put("#ffffff", to=(6 + i, 6 - i // 2, 7 + i, 8 + i // 2))
    return img


_THUMB_CACHE = {}


# ── Windows 缩略图服务（不需要 PIL，能出 jpg/mp4/office/pdf 的缩略图）──
class _GUID(ctypes.Structure):
    _fields_ = [("Data1", ctypes.c_ulong), ("Data2", ctypes.c_ushort),
                ("Data3", ctypes.c_ushort), ("Data4", ctypes.c_ubyte * 8)]


class _SIZE(ctypes.Structure):
    _fields_ = [("cx", ctypes.c_long), ("cy", ctypes.c_long)]


_IID_ITEMFACTORY = _GUID(
    0xbcc18b79, 0xba16, 0x442f,
    (ctypes.c_ubyte * 8)(0x80, 0xc4, 0x8a, 0x59, 0xc3, 0x0c, 0x46, 0x3b))


# ── GDI+ 解码（不需要 PIL，支持 jpg/png/bmp/gif/tiff/webp 等系统有解码器的格式）──
class _GpRect(ctypes.Structure):
    _fields_ = [("X", ctypes.c_int), ("Y", ctypes.c_int),
                ("Width", ctypes.c_int), ("Height", ctypes.c_int)]


class _GpBitmapData(ctypes.Structure):
    _fields_ = [("width", ctypes.c_uint), ("height", ctypes.c_uint),
                ("stride", ctypes.c_int), ("pixel_format", ctypes.c_int),
                ("scan0", ctypes.c_void_p), ("reserved", ctypes.c_void_p)]


class _GpStartupInput(ctypes.Structure):
    _fields_ = [("GdiplusVersion", ctypes.c_uint),
                ("DebugEventCallback", ctypes.c_void_p),
                ("SuppressBackgroundThread", ctypes.c_int),
                ("SuppressExternalCodecs", ctypes.c_int)]


_GP_TOKEN = None
_GP_LOCK = threading.Lock()
_GP_READY = None


def _gdiplus():
    """初始化 GDI+ 并返回 (gdiplus, gdi32)；不可用时返回 (None, None)。"""
    global _GP_TOKEN, _GP_READY
    with _GP_LOCK:
        if _GP_READY is not None:
            return _GP_READY
        if os.name != "nt":
            _GP_READY = (None, None)
            return _GP_READY
        try:
            gp = ctypes.windll.gdiplus
            tok = ctypes.c_void_p()
            inp = _GpStartupInput(1, None, 0, 0)
            if gp.GdiplusStartup(ctypes.byref(tok), ctypes.byref(inp), None) != 0:
                _GP_READY = (None, None)
            else:
                _GP_TOKEN = tok
                _GP_READY = (gp, ctypes.windll.gdi32)
        except Exception:
            _GP_READY = (None, None)
        return _GP_READY


def gdiplus_decode(path, max_side=1024):
    """用 GDI+ 把图片解码成 (w, h, RGB bytes)，按 max_side 等比缩放。失败返回 None。"""
    gp, gdi32 = _gdiplus()
    if not gp:
        return None
    src = ctypes.c_void_p()
    dst = ctypes.c_void_p()
    gfx = ctypes.c_void_p()
    try:
        if gp.GdipCreateBitmapFromFile(ctypes.c_wchar_p(os.path.abspath(path)),
                                       ctypes.byref(src)) != 0 or not src:
            return None
        iw, ih = ctypes.c_uint(0), ctypes.c_uint(0)
        gp.GdipGetImageWidth(src, ctypes.byref(iw))
        gp.GdipGetImageHeight(src, ctypes.byref(ih))
        iw, ih = int(iw.value), int(ih.value)
        if iw <= 0 or ih <= 0:
            return None
        side = max(1, int(max_side))
        scale = min(1.0, float(side) / max(iw, ih))
        tw = max(1, int(round(iw * scale)))
        th = max(1, int(round(ih * scale)))

        PF_ARGB = 0x26200A
        if gp.GdipCreateBitmapFromScan0(tw, th, tw * 4, PF_ARGB, None,
                                        ctypes.byref(dst)) != 0 or not dst:
            return None
        if gp.GdipGetImageGraphicsContext(dst, ctypes.byref(gfx)) != 0 or not gfx:
            return None
        gp.GdipSetInterpolationMode(gfx, 7)      # HighQualityBicubic
        gp.GdipSetPixelOffsetMode(gfx, 2)        # HighQuality
        gp.GdipSetSmoothingMode(gfx, 2)
        gp.GdipDrawImageRectI(gfx, src, 0, 0, tw, th)
        gp.GdipDeleteGraphics(gfx)
        gfx = ctypes.c_void_p()

        bd = _GpBitmapData()
        rect = _GpRect(0, 0, tw, th)
        if gp.GdipBitmapLockBits(dst, ctypes.byref(rect), 1, PF_ARGB,
                                 ctypes.byref(bd)) != 0:
            return None
        try:
            stride = int(bd.stride)
            need = stride * th
            raw = ctypes.string_at(bd.scan0, need)
        finally:
            gp.GdipBitmapUnlockBits(dst, ctypes.byref(bd))

        if stride != tw * 4:
            raw = b"".join(raw[y * stride: y * stride + tw * 4]
                           for y in range(th))
        arr = array.array("B")
        arr.frombytes(raw)
        rgb = bytearray(tw * th * 3)
        rgb[0::3] = arr[2::4]
        rgb[1::3] = arr[1::4]
        rgb[2::3] = arr[0::4]
        return tw, th, bytes(rgb)
    except Exception:
        return None
    finally:
        for h in (gfx, dst, src):
            if h:
                try:
                    gp.GdipDisposeImage(h)
                except Exception:
                    pass


# ── WIC 原生解码（读 16/32 位 TIFF、CMYK 等 Pillow 也吃力的图）──
# 只做两件事：问尺寸、按原生格式取像素；取回后在 Python 里抽样缩小。
_WIC = {"ok": None, "fac": None}


class _WicGUID(ctypes.Structure):
    _fields_ = [("d1", ctypes.c_ulong), ("d2", ctypes.c_ushort),
                ("d3", ctypes.c_ushort), ("d4", ctypes.c_ubyte * 8)]


def _wg(hexs):
    a, b, c, d, e = hexs.split("-")
    return _WicGUID(int(a, 16), int(b, 16), int(c, 16),
                    (ctypes.c_ubyte * 8)(*bytes.fromhex(d + e)))


# PixelFormat GUID 尾部 -> (每像素字节, R偏移, G偏移, B偏移)，16 位格式取高字节
_WIC_FMT = {
    0x0907: (3, 0, 1, 2),        # 24bppRGB
    0x0908: (3, 2, 1, 0),        # 24bppBGR
    0x0909: (4, 2, 1, 0),        # 32bppBGR
    0x090a: (4, 2, 1, 0),        # 32bppBGRA
    0x090b: (4, 2, 1, 0),        # 32bppPBGRA
    0x090c: (6, 1, 3, 5),        # 48bppRGB（16 位取高字节）
    0x090d: (8, 1, 3, 5),        # 64bppRGBA（16 位取高字节）
    0x090e: (8, 2, 4, 6),        # 64bppPRGBA
}
_WIC_PF_PREFIX = 0x6FDDC324


def _vt_call(ptr, index, restype, argtypes, *args):
    v = ctypes.cast(ptr, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p)))
    return ctypes.WINFUNCTYPE(restype, ctypes.c_void_p, *argtypes)(
        v[0][index])(ptr, *args)


def _wic_factory():
    if _WIC["ok"] is not None:
        return _WIC["fac"]
    _WIC["ok"] = False
    if os.name != "nt":
        return None
    try:
        ole32 = ctypes.windll.ole32
        try:
            ole32.CoInitializeEx(None, 2)
        except Exception:
            pass
        fac = ctypes.c_void_p()
        hr = ole32.CoCreateInstance(
            ctypes.byref(_wg("cacaf262-9370-4615-a13b-9f5539da4c0a")), None, 1,
            ctypes.byref(_wg("ec5ec8a9-c395-4314-9c77-54d7a935ff70")),
            ctypes.byref(fac))
        if hr == 0 and fac:
            _WIC["fac"] = fac
            _WIC["ok"] = True
    except Exception:
        _WIC["ok"] = False
    return _WIC["fac"]


def _wic_open(path):
    """返回 (frame指针, 宽, 高, 格式信息) 或 None。"""
    fac = _wic_factory()
    if not fac:
        return None
    dec = ctypes.c_void_p()
    try:
        hr = _vt_call(fac, 3, ctypes.c_long,
                      [ctypes.c_wchar_p, ctypes.POINTER(_WicGUID),
                       ctypes.c_uint, ctypes.c_int,
                       ctypes.POINTER(ctypes.c_void_p)],
                      ctypes.c_wchar_p(os.path.abspath(path)), None,
                      0x80000000, 0, ctypes.byref(dec))
    except Exception:
        return None
    if hr != 0 or not dec:
        return None
    frame = ctypes.c_void_p()
    try:
        hr = _vt_call(dec, 13, ctypes.c_long,
                      [ctypes.c_uint, ctypes.POINTER(ctypes.c_void_p)],
                      0, ctypes.byref(frame))
    except Exception:
        hr = -1
    if hr != 0 or not frame:
        return None
    w, h = ctypes.c_uint(0), ctypes.c_uint(0)
    pf = _WicGUID()
    try:
        _vt_call(frame, 3, ctypes.c_long,
                 [ctypes.POINTER(ctypes.c_uint)] * 2,
                 ctypes.byref(w), ctypes.byref(h))
        _vt_call(frame, 4, ctypes.c_long, [ctypes.POINTER(_WicGUID)],
                 ctypes.byref(pf))
    except Exception:
        return None
    fmt_id = (pf.d4[6] << 8) | pf.d4[7]             # 尾部两字节，如 c9 0d
    info = _WIC_FMT.get(0x0900 | (fmt_id & 0xFF)) if (fmt_id >> 8) == 0xC9 else None
    return (frame, w.value, h.value, info)


def wic_size(path):
    """WIC 报的尺寸（不解码像素，很快）。"""
    got = _wic_open(path)
    return (got[1], got[2]) if got else None


def _wic_copy(frame, W, H, bpp):
    """按每像素 bpp 字节抓一帧原始像素，返回 bytes 或 None。"""
    stride = W * bpp
    n = stride * H
    if n > 320 * 1024 * 1024:
        return None
    buf = ctypes.create_string_buffer(n)
    try:
        hr = _vt_call(frame, 7, ctypes.c_long,
                      [ctypes.c_void_p, ctypes.c_uint, ctypes.c_uint,
                       ctypes.c_void_p], None, stride, n, buf)
    except Exception:
        return None
    if hr != 0:
        return None
    return buf.raw


def _wic_row_filled(raw, W, bpp):
    """抽中间一行，看最后 25% 是不是空白，判断这个 bpp 猜得对不对。"""
    H = len(raw) // (W * bpp)
    if H < 2:
        return True
    stride = W * bpp
    row = raw[(H // 2) * stride:(H // 2 + 1) * stride]
    tail = row[int(stride * 0.75):]
    return any(tail)


def wic_decode(path, max_side=900):
    """用 WIC 取像素（自动试 24/32/64 位），按步长抽到 max_side 以内。

    返回 (宽, 高, RGB 字节) 或 None。
    """
    got = _wic_open(path)
    if not got:
        return None
    frame, W, H, info = got
    if W <= 0 or H <= 0:
        return None
    # 解码器自报的格式优先，然后 24 位 RGB、32 位 BGRA、64 位 RGBA 依次试
    tries = []
    if info:
        bpp, ro, go, bo = info
        tries.append((bpp, (ro, go, bo), bpp >= 6))
    for cand in ((3, (0, 1, 2), False), (4, (2, 1, 0), False),
                 (8, (1, 3, 5), True)):
        if cand not in tries:
            tries.append(cand)
    raw = None
    pick = None
    for bpp, order, sixteen in tries:
        data = _wic_copy(frame, W, H, bpp)
        if data is None:
            continue
        if not _wic_row_filled(data, W, bpp):
            continue                    # 整行没填满，说明 bpp 猜大了
        raw, pick = data, (bpp, order, sixteen)
        break
    if raw is None:
        return None
    bpp, order, sixteen = pick
    stride = W * bpp
    step = max(1, int(round(max(W, H) / float(max_side))))
    ow = max(1, len(range(0, W, step)))
    oh = max(1, len(range(0, H, step)))
    inc = bpp * step
    off = tuple(o + 1 if sixteen else o for o in order)
    out = bytearray()
    for y in range(0, H, step):
        base = y * stride
        row = raw[base:base + stride]
        r = row[off[0]::inc][:ow]
        g = row[off[1]::inc][:ow]
        b = row[off[2]::inc][:ow]
        out += b"".join(bytes((rv, gv, bv)) for rv, gv, bv in zip(r, g, b))
    return ow, oh, bytes(out)


# ── Pillow 解码（兼容 TIFF / CMYK JPEG / EXIF 旋转 / WebP / HEIC 等）──
# 系统缩略图和 GDI+ 都认不出的格式，走这条路；没装 Pillow 时自动跳过。
try:
    from PIL import Image as _PILImage
except Exception:                                    # pragma: no cover
    _PILImage = None


def pillow_ready():
    return _PILImage is not None


def pil_decode(path, max_side=1024):
    """用 Pillow 解码任意常见图片，返回 (宽, 高, RGB 字节) 或 None。

    - 按 EXIF 方向摆正
    - 只对 JPEG 用 draft 预缩（其它格式先解码再缩，避免丢细节）
    - 输出最大边不超过 max_side
    """
    if _PILImage is None:
        return None
    try:
        im = _PILImage.open(path)
    except Exception:
        return None
    try:
        try:
            im.draft("RGB", (int(max_side), int(max_side)))
        except Exception:
            pass
        try:
            from PIL import ImageOps as _OPS
            im = _OPS.exif_transpose(im)
        except Exception:
            pass
        if getattr(im, "n_frames", 1) > 1:
            try:
                im.seek(0)
            except Exception:
                pass
        # 多 IFD 的 TIFF：优先挑面积最大的那一帧
        best = im
        try:
            best_size = im.size[0] * im.size[1]
            for i in range(1, getattr(im, "n_frames", 1)):
                im.seek(i)
                if im.size[0] * im.size[1] > best_size:
                    best, best_size = im, im.size[0] * im.size[1]
            if best is not im:
                im.seek(getattr(im, "n_frames", 1) - 1)
        except Exception:
            pass
        im = best
        try:
            im = im.convert("RGB")
        except Exception:
            return None
        w, h = im.size
        longest = max(w, h)
        if longest > max_side:
            k = float(max_side) / longest
            im = im.resize((max(1, int(w * k)), max(1, int(h * k))),
                           _PILImage.LANCZOS)
        im = im.convert("RGB")
        return im.size[0], im.size[1], im.tobytes()
    except Exception:
        return None
    finally:
        try:
            im.close()
        except Exception:
            pass


def pil_photo(path, max_side=1024, master=None):
    """Pillow 解码后直接转成 PhotoImage。"""
    got = pil_decode(path, max_side)
    if not got:
        return None
    return rgb_to_photo(got[0], got[1], got[2], master=master)


def _decode_best(path, max_side=1600):
    """挑一个解码结果：Pillow 快，但对某些 TIFF 只给 IFD0 缩略图。

    判据：文件 >4MB 却只解出 <900px，就去问 WIC 要一张更大的。
    """
    got = None
    try:
        got = pil_decode(path, max_side)
    except Exception:
        got = None
    if got and got[0] >= 32 and got[1] >= 16:
        try:
            big_file = os.path.getsize(path) > 4 * 1024 * 1024
        except OSError:
            big_file = False
        if big_file and max(got[0], got[1]) < 900:
            try:
                alt = wic_decode(path, max_side)
            except Exception:
                alt = None
            if alt and max(alt[0], alt[1]) > max(got[0], got[1]):
                return alt
        return got
    try:
        alt = wic_decode(path, max_side)
    except Exception:
        alt = None
    if alt and alt[0] >= 32 and alt[1] >= 16:
        return alt
    return got


def rgb_scaled_photo(w, h, rgb, side, master=None):
    """把已解码的 RGB 缩放到长边 side，返回 PhotoImage（预览窗缩放用）。

    有 Pillow 走双线性，没有就最近邻；都是内存操作，不重新读文件。
    """
    side = max(16, int(side))
    k = float(side) / max(1, max(w, h))
    nw, nh = max(1, int(round(w * k))), max(1, int(round(h * k)))
    if nw == w and nh == h:
        return rgb_to_photo(w, h, rgb, master=master)
    if _PILImage is not None:
        try:
            im = _PILImage.frombytes("RGB", (w, h), rgb)
            # 缩小时 LANCZOS（面积平均，纹理细的地方不糊也不出摩尔纹），
            # 放大时 BICUBIC（比双线性锐利一点，又不至于像 NEAREST 那样出马赛克）
            shrink = (nw <= w and nh <= h)
            rs = _PILImage.LANCZOS if shrink else _PILImage.BICUBIC
            im = im.resize((nw, nh), rs)
            return rgb_to_photo(nw, nh, im.tobytes(), master=master)
        except Exception:
            pass
    # 没 Pillow：按步长抽点（够用，且不会崩）
    sx = max(1, w // nw)
    sy = max(1, h // nh)
    out = bytearray()
    for y in range(0, h, sy):
        base = y * w * 3
        row = rgb[base:base + w * 3]
        r = row[0::3 * sx][:nw]
        g = row[1::3 * sx][:nw]
        b = row[2::3 * sx][:nw]
        out += b"".join(bytes((rv, gv, bv)) for rv, gv, bv in zip(r, g, b))
    return rgb_to_photo(nw, nh, bytes(out), master=master)


_IMG_MAGIC = (
    (b"\x89PNG", "png"), (b"\xff\xd8\xff", "jpg"), (b"GIF8", "gif"),
    (b"BM", "bmp"), (b"II*\x00", "tif"), (b"MM\x00*", "tif"),
    (b"II+\x00", "tif"), (b"MM\x00+", "tif"),
    (b"RIFF", "webp"), (b"\x00\x00\x01\x00", "ico"),
    (b"\x00\x00\x00\x0cJXL", "jxl"), (b"\xff\x0a", "jxl"),
)


def sniff_image(path):
    """看文件头判断真实格式，不信扩展名（.JPG 里装 TIFF 的见过）。"""
    try:
        with open(path, "rb") as f:
            head = f.read(32)
    except OSError:
        return None
    for magic, kind in _IMG_MAGIC:
        if head.startswith(magic):
            if kind == "webp" and head[8:12] != b"WEBP":
                continue
            return kind
    if head[4:12] in (b"ftypheic", b"ftypheix", b"ftypmif1", b"ftypavif",
                      b"ftypheim", b"ftypheis"):
        return "heif"
    return None



def rgb_to_photo(w, h, rgb, master=None):
    """把 RGB 字节变成 PhotoImage（写临时 PPM，比逐像素 put 快一个数量级）。"""
    import tkinter as _tk
    import tempfile
    fd, tmp = tempfile.mkstemp(suffix=".ppm")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(b"P6\n%d %d\n255\n" % (w, h))
            f.write(rgb)
        return _tk.PhotoImage(file=tmp, master=master)
    except Exception:
        return None
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass


def shell_thumb_rgb(path, size=256):
    """用 IShellItemImageFactory 取 (w, h, 32bpp 自上而下字节)；失败返回 None。"""
    if os.name != "nt":
        return None
    try:
        from ctypes import wintypes
        ole32 = ctypes.windll.ole32
        shell32 = ctypes.windll.shell32
        gdi32 = ctypes.windll.gdi32
        user32 = ctypes.windll.user32
    except Exception:
        return None
    try:
        ole32.CoInitialize(None)
    except Exception:
        pass

    pitem = ctypes.c_void_p()
    try:
        hr = shell32.SHCreateItemFromParsingName(
            ctypes.c_wchar_p(os.path.abspath(path)), None,
            ctypes.byref(_IID_ITEMFACTORY), ctypes.byref(pitem))
    except Exception:
        return None
    if hr != 0 or not pitem:
        return None
    try:
        # 手写 vtable：0 QueryInterface / 1 AddRef / 2 Release / 3 GetImage
        vtbl = ctypes.cast(
            ctypes.cast(pitem, ctypes.POINTER(ctypes.c_void_p))[0],
            ctypes.POINTER(ctypes.c_void_p))
        GetImage = ctypes.WINFUNCTYPE(
            ctypes.c_long, ctypes.c_void_p, _SIZE, ctypes.c_uint,
            ctypes.POINTER(wintypes.HBITMAP))(vtbl[3])
        hbmp = wintypes.HBITMAP()
        hr = GetImage(pitem, _SIZE(size, size), 0x4, ctypes.byref(hbmp))
        if hr != 0 or not hbmp:
            hr = GetImage(pitem, _SIZE(size, size), 0x0, ctypes.byref(hbmp))
            if hr != 0 or not hbmp:
                return None
        try:
            class _BITMAP(ctypes.Structure):
                _fields_ = [("bmType", ctypes.c_long), ("bmWidth", ctypes.c_long),
                            ("bmHeight", ctypes.c_long),
                            ("bmWidthBytes", ctypes.c_long),
                            ("bmPlanes", wintypes.WORD),
                            ("bmBitsPixel", wintypes.WORD),
                            ("bmBits", ctypes.c_void_p)]
            bm = _BITMAP()
            if not gdi32.GetObjectW(hbmp, ctypes.sizeof(_BITMAP),
                                    ctypes.byref(bm)):
                return None
            w, h = int(bm.bmWidth), int(bm.bmHeight)
            if w <= 0 or h <= 0 or w > 4096 or h > 4096:
                return None

            class _BIH(ctypes.Structure):
                _fields_ = [("biSize", wintypes.DWORD), ("biWidth", ctypes.c_long),
                            ("biHeight", ctypes.c_long),
                            ("biPlanes", wintypes.WORD),
                            ("biBitCount", wintypes.WORD),
                            ("biCompression", wintypes.DWORD),
                            ("biSizeImage", wintypes.DWORD),
                            ("biXPelsPerMeter", ctypes.c_long),
                            ("biYPelsPerMeter", ctypes.c_long),
                            ("biClrUsed", wintypes.DWORD),
                            ("biClrImportant", wintypes.DWORD)]

            class _BI(ctypes.Structure):
                _fields_ = [("bmiHeader", _BIH), ("bmiColors", wintypes.DWORD * 3)]

            bi = _BI()
            bi.bmiHeader.biSize = ctypes.sizeof(_BIH)
            bi.bmiHeader.biWidth = w
            bi.bmiHeader.biHeight = -h
            bi.bmiHeader.biPlanes = 1
            bi.bmiHeader.biBitCount = 32
            bi.bmiHeader.biCompression = 0
            buf = ctypes.create_string_buffer(w * h * 4)
            hdc = user32.GetDC(None)
            try:
                got = gdi32.GetDIBits(hdc, hbmp, 0, h, buf,
                                      ctypes.byref(bi), 0)
            finally:
                user32.ReleaseDC(None, hdc)
            if not got:
                return None
            return w, h, buf.raw
        finally:
            gdi32.DeleteObject(hbmp)
    except Exception:
        return None
    finally:
        try:
            Release = ctypes.WINFUNCTYPE(ctypes.c_ulong, ctypes.c_void_p)(vtbl[2])
            Release(pitem)
        except Exception:
            pass


def thumb_photo(path, size=256, master=None):
    """把系统缩略图转成 tk.PhotoImage；失败返回 None。"""
    import tkinter as _tk
    data = shell_thumb_rgb(path, size)
    if not data:
        return None
    w, h, raw = data
    img = _tk.PhotoImage(master=master, width=w, height=h)
    rows = []
    step = w * 4
    for y in range(h):
        off = y * step
        line = raw[off:off + step]
        cells = []
        for i in range(0, step, 4):
            b, g, r, a = line[i], line[i + 1], line[i + 2], line[i + 3]
            if a == 0:
                cells.append("#ffffff")
            elif a != 255:
                r = (r * a + 255 * (255 - a)) // 255
                g = (g * a + 255 * (255 - a)) // 255
                b = (b * a + 255 * (255 - a)) // 255
                cells.append("#%02x%02x%02x" % (r, g, b))
            else:
                cells.append("#%02x%02x%02x" % (r, g, b))
        rows.append("{" + " ".join(cells) + "}")
    img.put(" ".join(rows))
    return img


def shot_icon(path, box=26, limit=90):
    """优先返回真实缩略图（Tk 8.6 原生支持 PNG/GIF），失败就给通用图标。"""
    import tkinter as _tk
    key = os.path.normcase(path)
    if key in _THUMB_CACHE:
        return _THUMB_CACHE[key]
    if len(_THUMB_CACHE) >= limit:
        return None
    ic = None
    ext = os.path.splitext(path)[1].lower()
    if ext in (".png", ".gif"):
        try:
            img = _tk.PhotoImage(file=path)
            w, h = img.width(), img.height()
            k = max(1, int(round(max(w, h) / float(box))))
            if k > 1:
                img = img.subsample(k, k)
            ic = img
        except Exception:
            ic = None
    if ic is None:
        # jpg/webp/bmp/视频 交给系统缩略图（不用 PIL）
        try:
            ic = thumb_photo(path, box)
        except Exception:
            ic = None
    if ic is None:
        kind = "video" if ext in (".mp4", ".mov", ".mkv", ".avi") else "img"
        if kind not in _THUMB_CACHE:
            _THUMB_CACHE[kind] = _fallback_icon(kind)
        ic = _THUMB_CACHE[kind]
    _THUMB_CACHE[key] = ic
    return ic


_PREVIEW_CACHE = {}

# 能在列表里显示封面的类型（图片 + 视频）
MEDIA_EXT = {".png", ".jpg", ".jpeg", ".bmp", ".gif", ".webp", ".ico",
             ".tif", ".tiff", ".heic", ".mp4", ".mov", ".mkv", ".avi",
             ".webm", ".wmv", ".m4v", ".flv"}


def load_image_photo(path, max_side=520, master=None, allow_zoom=False):
    """把图片变成能直接显示的 PhotoImage。

    先让 Tk 自己解码（PNG/GIF 是原图像素，绝不会变成系统占位图标），
    不行再退到 Windows 缩略图（jpg/webp/bmp/视频）。

    allow_zoom=True 时，若目标尺寸比原图还大，会按整数倍放大（预览窗缩放用）。
    """
    import tkinter as _tk
    ext = os.path.splitext(path)[1].lower()
    key = (os.path.normcase(path), int(max_side), bool(allow_zoom))
    if key in _PREVIEW_CACHE:
        return _PREVIEW_CACHE[key]
    ph = None
    if ext in (".png", ".gif", ".ppm", ".pgm"):
        try:
            img = _tk.PhotoImage(file=path, master=master)
            cur = max(img.width(), img.height())
            k = max(1, int(math.ceil(cur / float(max_side))))
            if k > 1:
                img = img.subsample(k, k)
            elif allow_zoom and cur * 2 <= int(max_side):
                z = min(4, int(max_side) // max(1, cur))
                if z > 1:
                    img = img.zoom(z, z)
            ph = img
        except Exception:
            ph = None
    if ph is None:
        # Pillow 优先：TIFF、CMYK JPEG、EXIF 旋转都靠它
        got = None
        try:
            got = pil_decode(path, max_side)
        except Exception:
            got = None
        # Pillow 只读到了缩略图 IFD（文件很大但读出来很小）时，改用 WIC 原生解码
        try:
            small = (got is None
                     or (got[0] * got[1] < 1000000
                         and os.path.getsize(path) > 4 * 1024 * 1024))
        except OSError:
            small = got is None
        if small:
            try:
                w2 = wic_decode(path, max_side)
            except Exception:
                w2 = None
            if w2 and (got is None or w2[0] * w2[1] > got[0] * got[1]):
                got = w2
        if got:
            try:
                ph = rgb_to_photo(got[0], got[1], got[2], master=master)
            except Exception:
                ph = None
    if ph is None:
        try:
            ph = thumb_photo(path, max_side, master=master)
        except Exception:
            ph = None
    if len(_PREVIEW_CACHE) > 40:
        _PREVIEW_CACHE.clear()
    _PREVIEW_CACHE[key] = ph
    return ph


def reveal_in_explorer(path):
    """在资源管理器里选中这个文件/文件夹。"""
    from tkinter import messagebox
    try:
        p = os.path.normpath(path)
        if not os.path.exists(p):
            messagebox.showwarning("找不到了", "这个文件已经不在了：\n" + p)
            return
        subprocess.Popen('explorer /select,"%s"' % p, shell=False)
    except Exception as ex:
        messagebox.showerror("打开失败", str(ex))


def open_with_default(path):
    from tkinter import messagebox
    try:
        if not os.path.exists(path):
            messagebox.showwarning("找不到了", "这个文件已经不在了：\n" + path)
            return
        os.startfile(path)
    except Exception as ex:
        messagebox.showerror("打开失败", str(ex))


# ── 预览窗口：滚轮缩放 / 上一张下一张 / 拖动平移 / 删除 ──
IMG_EXT = {".png", ".jpg", ".jpeg", ".bmp", ".gif", ".webp", ".ico",
           ".tif", ".tiff"}
TXT_EXT = {".txt", ".md", ".log", ".csv", ".json", ".py", ".js", ".html",
           ".css", ".xml", ".yml", ".yaml", ".ini", ".bat", ".ps1"}

def _preview_file(master, path, siblings=None, *, delete_fn=None,
                 logger=None, on_refresh=None):
    """预览窗口：滚轮缩放、上一张/下一张、拖动平移、删除。

    master     : 父窗口（Tk 根或任意 Toplevel）
    delete_fn  : 删除函数，签名 delete_fn(paths, mode) -> (n, fail) | None
    logger     : 日志回调 logger(str)，缺省丢弃
    on_refresh : 删除后的刷新回调，缺省不刷新
    """
    # 延时导入：CLI 模式不加载 GUI 库，启动更快
    import tkinter as tk
    from tkinter import messagebox, ttk

    if delete_fn is None:
        raise ValueError("preview_file 需要 delete_fn")
    _log = logger or (lambda _m: None)
    if not os.path.exists(path):
        messagebox.showwarning("找不到了", "这个文件已经不在了：\n" + path)
        return

    # ── 可切换的兄弟文件（同一组） ──
    pool = []
    for p in (siblings or [path]):
        try:
            if p and p not in pool and os.path.isfile(p):
                pool.append(p)
        except OSError:
            continue
    if path in pool:
        start_i = pool.index(path)
    else:
        pool.insert(0, path)
        start_i = 0

    VIDEO_EXT = (".mp4", ".mov", ".mkv", ".avi", ".webm")
    ZOOM_MIN, ZOOM_MAX = 80, 2600
    st = {"i": start_i, "side": 0, "fit": 560, "photo": None, "job": None,
          "item": None, "mode": "fit", "drag": None, "is_img": False,
          "src": None, "src_side": 0}

    w = tk.Toplevel(master)
    w.title("预览")
    w.configure(bg="#ffffff")
    w.geometry("900x690")
    w.minsize(620, 460)
    w.transient(master)

    # ── 头部：文件名 + 元信息 ──
    head = tk.Frame(w, bg="#ffffff")
    head.pack(fill="x", padx=18, pady=(14, 6))
    name_var = tk.StringVar()
    tk.Label(head, textvariable=name_var, bg="#ffffff", fg="#111827",
             font=("Microsoft YaHei UI", 11, "bold"), anchor="w").pack(
                 side="left", fill="x", expand=True)
    chips = tk.Frame(head, bg="#ffffff")
    chips.pack(side="right")
    ext_var, size_var, time_var, cnt_var = (tk.StringVar() for _ in range(4))
    for var in (cnt_var, ext_var, size_var, time_var):
        tk.Label(chips, textvariable=var, bg="#eef2f7", fg="#4a5568",
                 font=("Microsoft YaHei UI", 8), padx=6, pady=1).pack(
                     side="right", padx=3)

    tk.Frame(w, bg="#e8eaee", height=1).pack(fill="x", padx=18)

    # ── 缩放条（只在图片/视频时显示） ──
    zbar = tk.Frame(w, bg="#ffffff")
    zvar = tk.StringVar(value="100%")

    def _zbtn(text, cmd, tip=None):
        b = tk.Button(zbar, text=text, command=cmd, relief="flat", bd=0,
                      padx=10, pady=2, cursor="hand2",
                      font=("Microsoft YaHei UI", 9),
                      bg="#eef2f7", fg="#374151",
                      activebackground="#e2e8f0", activeforeground="#111827")
        b.pack(side="left", padx=(0, 6))
        return b

    def _zoom_step(factor):
        st["mode"] = "manual"
        st["side"] = max(ZOOM_MIN, min(ZOOM_MAX,
                                    int(round(st["side"] * factor))))
        _queue_render()

    _zbtn("-", lambda: _zoom_step(1 / 1.2))
    tk.Label(zbar, textvariable=zvar, bg="#ffffff", fg="#4a5568", width=6,
             font=("Microsoft YaHei UI", 9)).pack(side="left")
    _zbtn("+", lambda: _zoom_step(1.2))
    _zbtn("适应窗口", lambda: _fit_reset())
    tk.Label(zbar, text="滚轮缩放 · 拖动平移 · ←/→ 切换图片 · Esc 关闭",
             bg="#ffffff", fg="#a8adb5",
             font=("Microsoft YaHei UI", 8)).pack(side="right")
    zbar.pack(fill="x", padx=18, pady=(6, 0))

    # ── 预览区 ──
    stage = tk.Frame(w, bg="#f6f7f9")
    stage.pack(fill="both", expand=True, padx=18, pady=12)
    cv = tk.Canvas(stage, bg="#f6f7f9", highlightthickness=0, bd=0)
    cv.pack(fill="both", expand=True)

    txt_wrap = tk.Frame(stage, bg="#ffffff")
    txt_sb = ttk.Scrollbar(txt_wrap, orient="vertical")
    txt_sb.pack(side="right", fill="y")
    txt_box = tk.Text(txt_wrap, wrap="none", font=("Consolas", 10),
                      bg="#ffffff", fg="#1f2933", relief="flat",
                      padx=12, pady=10, yscrollcommand=txt_sb.set)
    txt_box.pack(side="left", fill="both", expand=True)
    txt_sb.configure(command=txt_box.yview)

    other = tk.Frame(stage, bg="#f6f7f9")

    def _fit_side():
        cw = cv.winfo_width()
        ch = cv.winfo_height()
        if cw < 60 or ch < 60:
            cw, ch = 820, 520
        return max(120, min(cw, ch) - 18)

    def _update_zvar():
        fit = st["fit"] or 1
        zvar.set("%d%%" % max(1, int(round(st["side"] * 100.0 / fit))))

    def _render_img():
        st["job"] = None
        p = pool[st["i"]]
        # 只在第一次（或放大到需要更清晰时）解码，其余缩放都在内存里做，
        # 避免每一格滚轮都重读文件 —— 这就是以前"忽大忽小"的根源
        want = min(2400, max(1600, int(st["side"])))
        if st.get("src") is None or st.get("src_side", 0) < want:
            got_src = _decode_best(p, want)
            if got_src:
                st["src_side"] = max(got_src[0], got_src[1])
            st["src"] = got_src
        src = st.get("src")
        ph = None
        if src:
            try:
                ph = rgb_scaled_photo(src[0], src[1], src[2],
                                      int(st["side"]), master=master)
            except Exception:
                ph = None
        if not ph:
            ph = load_image_photo(p, st["side"], master=master,
                                  allow_zoom=True)
        if not ph:
            st["is_img"] = False
            cv.delete("all")
            cv.create_text(cv.winfo_width() // 2 or 400, 120,
                           text="这个文件读不出画面", fill="#8b9199",
                           font=("Microsoft YaHei UI", 9))
            return
        st["photo"] = ph
        st["is_img"] = True
        cv.delete("all")
        cx = (cv.winfo_width() or 820) // 2
        cy = (cv.winfo_height() or 520) // 2
        st["item"] = cv.create_image(cx, cy, image=ph, anchor="center")
        _update_zvar()

    def _queue_render(delay=80):
        if st["job"]:
            try:
                w.after_cancel(st["job"])
            except Exception:
                pass
        st["job"] = w.after(delay, _render_img)

    def _fit_reset():
        st["mode"] = "fit"
        st["side"] = _fit_side()
        _queue_render(10)

    def _on_configure(e):
        if e.widget is not cv:
            return
        if st["mode"] == "fit":
            st["side"] = _fit_side()
            _queue_render(120)
        else:
            _update_zvar()

    def _on_wheel(e):
        if not st["is_img"]:
            return "break"
        # 小步长 + 四舍五入，滚一格的变化是均匀的，不会忽大忽小
        step = 1.15 if e.delta > 0 else 1 / 1.15
        st["mode"] = "manual"
        st["side"] = max(ZOOM_MIN, min(ZOOM_MAX,
                                    int(round(st["side"] * step))))
        _update_zvar()
        _queue_render(45)
        return "break"

    def _on_press(e):
        st["drag"] = (e.x, e.y)
        cv.configure(cursor="fleur")

    def _on_drag(e):
        if not st["drag"] or st["item"] is None:
            return
        dx = e.x - st["drag"][0]
        dy = e.y - st["drag"][1]
        st["drag"] = (e.x, e.y)
        cv.move(st["item"], dx, dy)

    def _on_release(e):
        st["drag"] = None
        cv.configure(cursor="")

    cv.bind("<Configure>", _on_configure)
    cv.bind("<MouseWheel>", _on_wheel)
    cv.bind("<Button-1>", _on_press)
    cv.bind("<B1-Motion>", _on_drag)
    cv.bind("<ButtonRelease-1>", _on_release)

    # ── 底部操作区 ──
    tk.Frame(w, bg="#e8eaee", height=1).pack(fill="x", padx=18)
    bar = tk.Frame(w, bg="#ffffff")
    bar.pack(fill="x", padx=18, pady=12)
    path_var_l = tk.StringVar()
    path_lbl = tk.Label(bar, textvariable=path_var_l, bg="#ffffff",
                        fg="#9aa2ad", font=("Microsoft YaHei UI", 8),
                        anchor="w")

    def _btn(parent, text, cmd, primary=False, width=None):
        b = tk.Button(parent, text=text, command=cmd, relief="flat",
                      bd=0, padx=14, pady=5, cursor="hand2",
                      font=("Microsoft YaHei UI", 9),
                      bg="#2f6fdd" if primary else "#eef2f7",
                      fg="#ffffff" if primary else "#374151",
                      activebackground="#2a63c6" if primary else "#e2e8f0",
                      activeforeground="#ffffff" if primary else "#111827")
        if width:
            b.configure(width=width)
        b.pack(side="right", padx=(8, 0))
        return b

    def _del(permanent):
        p = pool[st["i"]]
        # 确认弹窗在删除实现里，这里不再问第二遍
        res = delete_fn([p], "permanent" if permanent else "trash")
        if res is None:              # 用户取消
            return
        n, fail = res
        if n:
            _log("[删除] 已删除 " + os.path.basename(p))
            try:
                pool.pop(st["i"])
            except Exception:
                pass
            if not pool:
                w.destroy()
            else:
                st["i"] = min(st["i"], len(pool) - 1)
                _show()
            if on_refresh:
                on_refresh()
        else:
            why = fail[0][1] if fail else "未知原因"
            messagebox.showwarning("删除失败", why)

    _btn(bar, "关闭", w.destroy)
    _btn(bar, "移到回收站", lambda: _del(False))
    _btn(bar, "永久删除", lambda: _del(True))
    _btn(bar, "打开位置", lambda: reveal_in_explorer(pool[st["i"]]))
    _btn(bar, "打开文件", lambda: open_with_default(pool[st["i"]]), primary=True)

    # 上一张 / 下一张
    nav = tk.Frame(bar, bg="#ffffff")
    nav.pack(side="left", padx=(10, 0))

    def _nav(step):
        if len(pool) < 2:
            return
        st["i"] = (st["i"] + step) % len(pool)
        _show()

    prev_b = tk.Button(nav, text="◀ 上一张", command=lambda: _nav(-1),
                       relief="flat", bd=0, padx=10, pady=3, cursor="hand2",
                       font=("Microsoft YaHei UI", 9), bg="#eef2f7", fg="#374151",
                       activebackground="#e2e8f0")
    prev_b.pack(side="left", padx=(0, 6))
    next_b = tk.Button(nav, text="下一张 ▶", command=lambda: _nav(1),
                       relief="flat", bd=0, padx=10, pady=3, cursor="hand2",
                       font=("Microsoft YaHei UI", 9), bg="#eef2f7", fg="#374151",
                       activebackground="#e2e8f0")
    next_b.pack(side="left")
    # 路径最后才 pack，否则它会把「上一张/下一张」和右侧按钮挤没
    path_lbl.pack(side="left", fill="x", expand=True, padx=(12, 12))

    def _short_path(p, keep=58):
        p = os.path.normpath(p)
        if len(p) <= keep:
            return p
        half = (keep - 3) // 2
        return p[:half] + "..." + p[-half:]

    def _show():
        p = pool[st["i"]]
        st["src"] = None          # 换图了，丢掉上一张的解码缓存
        st["src_side"] = 0
        w.title("预览 · " + os.path.basename(p))
        name_var.set(os.path.basename(p))
        path_var_l.set(_short_path(p))
        ext = os.path.splitext(p)[1].lower()
        try:
            s = os.stat(p)
            size_txt = human(s.st_size)
            time_txt = datetime.datetime.fromtimestamp(s.st_mtime).strftime(
                "%Y-%m-%d %H:%M")
        except OSError:
            size_txt, time_txt = "—", "—"
        ext_var.set(" %s " % (ext.replace(".", "").upper() or "文件"))
        size_var.set(" %s " % size_txt)
        time_var.set(" %s " % time_txt)
        cnt_var.set(" %d / %d " % (st["i"] + 1, len(pool)))
        able = len(pool) > 1
        for b in (prev_b, next_b):
            b.configure(state="normal" if able else "disabled",
                        fg="#374151" if able else "#c2c8d0")

        # 选哪种呈现
        for fr in (txt_wrap, other):
            fr.pack_forget()
        if ext in IMG_EXT or ext in VIDEO_EXT:
            cv.pack(fill="both", expand=True)
            if not zbar.winfo_manager():
                zbar.pack(fill="x", padx=18, pady=(6, 0), before=stage)
            st["mode"] = "fit"
            st["side"] = _fit_side()
            _queue_render(10)
        elif ext in TXT_EXT:
            cv.pack_forget()
            if zbar.winfo_manager():
                zbar.pack_forget()
            st["photo"] = None
            st["item"] = None
            st["is_img"] = False
            try:
                with open(p, "r", encoding="utf-8", errors="replace") as f:
                    head_txt = f.read(200000)
                txt_box.configure(state="normal")
                txt_box.delete("1.0", "end")
                txt_box.insert("1.0", head_txt)
                txt_box.configure(state="disabled")
                txt_box.yview_moveto(0)
                txt_wrap.pack(fill="both", expand=True)
            except Exception as ex:
                cv.pack(fill="both", expand=True)
                cv.delete("all")
                cv.create_text(400, 120, text="读不出来：" + str(ex),
                               fill="#b3261e",
                               font=("Microsoft YaHei UI", 9))
        else:
            cv.pack_forget()
            if zbar.winfo_manager():
                zbar.pack_forget()
            st["photo"] = None
            st["item"] = None
            st["is_img"] = False
            for ch in other.winfo_children():
                ch.destroy()
            big = _fallback_icon("video" if ext in VIDEO_EXT else "img")
            lab = tk.Label(other, image=big, bg="#f6f7f9")
            lab.image = big
            lab.pack(expand=True)
            tk.Label(other, text="这个类型没法直接预览，点「打开文件」用系统程序看",
                     bg="#f6f7f9", fg="#8b9199",
                     font=("Microsoft YaHei UI", 9)).pack(pady=(0, 8))
            other.pack(fill="both", expand=True)

    def _key(e):
        k = e.keysym
        if k in ("Left", "Prior"):
            _nav(-1)
            return "break"
        if k in ("Right", "Next"):
            _nav(1)
            return "break"
        if k in ("plus", "equal", "KP_Add"):
            if st["is_img"]:
                _zoom_step(1.2)
            return "break"
        if k in ("minus", "KP_Subtract"):
            if st["is_img"]:
                _zoom_step(1 / 1.2)
            return "break"
        if k in ("0", "KP_0"):
            _fit_reset()
            return "break"
        return None

    w.bind("<Escape>", lambda e: w.destroy())
    w.bind("<Key>", _key)
    # 文本预览时滚轮交给 Text 自己滚，别抢
    txt_box.bind("<MouseWheel>", lambda e: None)
    w.focus_set()
    try:
        _show()
    except Exception:
        import traceback
        _log("[预览] 出错：\n" + traceback.format_exc())
        w.deiconify()
    w.deiconify()
    w.lift()





def _rules_help(master):
    """高级规则的使用说明窗（纯展示）。"""
    import tkinter as tk
    from tkinter import ttk

    w = tk.Toplevel(master)
    w.title("高级规则 · 使用说明")
    w.configure(bg="#ffffff")
    w.geometry("820x640")
    w.minsize(620, 480)
    w.transient(master)
    tk.Label(w, text="高级规则怎么用", bg="#ffffff", fg="#111827",
             font=("Microsoft YaHei UI", 12, "bold"), anchor="w").pack(
                 fill="x", padx=20, pady=(16, 2))
    tk.Label(w, text="这里的规则跑在 organize 引擎上，和左边的内置分类互不影响。",
             bg="#ffffff", fg="#6b7280",
             font=("Microsoft YaHei UI", 9), anchor="w").pack(
                 fill="x", padx=20, pady=(0, 8))
    tk.Frame(w, bg="#e8eaee", height=1).pack(fill="x", padx=20)

    body = tk.Text(w, wrap="word", font=("Microsoft YaHei UI", 9),
                   bg="#ffffff", fg="#1f2933", relief="flat",
                   padx=20, pady=12, spacing1=2, spacing3=4)
    sb = ttk.Scrollbar(w, orient="vertical", command=body.yview)
    body.configure(yscrollcommand=sb.set)
    sb.pack(side="right", fill="y")
    body.pack(fill="both", expand=True)

    body.tag_configure("h", font=("Microsoft YaHei UI", 10, "bold"),
                       foreground="#111827", spacing1=10, spacing3=6)
    body.tag_configure("c", font=("Consolas", 9), background="#f5f7fa",
                       lmargin1=18, lmargin2=18, spacing1=6, spacing3=6)
    body.tag_configure("w", foreground="#b45309")

    def H(t):
        body.insert("end", t + "\n", "h")

    def P(t):
        body.insert("end", t + "\n")

    def C(t):
        body.insert("end", t + "\n", "c")

    def W(t):
        body.insert("end", t + "\n", "w")

    H("四个按钮是干什么的")
    P("载入配置…  从磁盘读一个 .yaml/.yml 文件，贴进下面的编辑框（不会立刻执行）")
    P("校验      只检查语法和字段对不对，不动任何文件。改完规则先点这个")
    P("预演      真的跑一遍，但把所有动作变成「只报告」——告诉你哪些文件会被怎么移动")
    P("执行      真的移动/复制/删除文件。会二次确认，而且**内置的「撤销上次」管不到这一步**")

    H("最小可用规则")
    C("rules:\n"
      "  - name: '下载里的 PDF 按年归档'\n"
      "    locations:\n"
      "      - 'D:/下载'\n"
      "    subfolders: true\n"
      "    filters:\n"
      "      - extension: pdf\n"
      "    actions:\n"
      "      - move: 'D:/下载/03_文档/{created.year}/'")

    H("常用字段")
    P("name       规则名，随便写，出现在日志里")
    P("locations  在哪些目录里找文件；字符串或列表都行")
    P("subfolders 是否进子目录，默认 false")
    P("targets    files / dirs / both，默认只处理文件")
    P("filters    过滤条件，可以写多条，全部满足才处理")
    P("actions    动作，可以写多步，按顺序执行")

    H("常用过滤器")
    P("extension: pdf        按扩展名（不带点）")
    P("name: '*.报告.*'      按文件名通配")
    P("size: 10mb..1gb       按大小范围，也可以只写 >10mb")
    P("created: 2026-01-01   按创建日期，支持 {} 占位")
    P("extension:                    空过滤器 = 什么都不匹配")

    H("常用动作")
    P("move: 'D:/归档/{name}'         移动（可改名）")
    P("copy: 'E:/备份/'              复制")
    P("trash: none                   删到回收站（高风险）")
    P("rename: '{name}.{extension}'  原地改名")
    P("echo: '{path}'                只打印，不动文件")

    H("模板占位符")
    P("{name} {extension} {path} {created.year} {created.month} "
      "{modified.year} {size}")

    H("两个容易踩的坑")
    W("① 路径里的反斜杠必须用正斜杠 / 或双反斜杠 \\\\；"
      "YAML 双引号里单个 \\ 会被当成转义符，直接报错。")
    W("② 缩进必须用空格，不能混 Tab；同一个列表项的子键要保持同一层级。")
    P("")
    P("写错了不要紧：先点「校验」，它会指出第几行第几列出错。")
    body.configure(state="disabled")

    bar = tk.Frame(w, bg="#ffffff")
    bar.pack(fill="x", padx=20, pady=12)
    tk.Button(bar, text="知道了", command=w.destroy, relief="flat",
              bd=0, padx=18, pady=6, cursor="hand2",
              font=("Microsoft YaHei UI", 9), bg="#2f6fdd", fg="#ffffff",
              activebackground="#2a63c6", activeforeground="#ffffff").pack(
                  side="right")
    w.bind("<Escape>", lambda e: w.destroy())

def write_report(mf, base_dir=None):
    """把这次整理的记录写成 markdown 报告，返回路径（失败返回 None）。

    mf 是 apply() 返回的历史 json；base_dir 用于报告落盘位置和「分类」推断。
    """
    if not mf or not os.path.exists(mf):
        return None
    try:
        data = json.load(open(mf, encoding="utf-8"))
    except Exception:
        return None
    moves = data.get("moves") or []
    if not moves:
        return None
    base = base_dir or data.get("folder") or ""
    stamp = data.get("time") or datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    out_dir = base if (base and os.path.isdir(base)) else data_dir()
    try:
        os.makedirs(out_dir, exist_ok=True)
    except OSError:
        out_dir = data_dir()
    path = os.path.join(out_dir, "整理报告_%s.md" % stamp)

    lines = ["# 整理报告", "",
             "- 时间：%s" % datetime.datetime.strptime(stamp, "%Y%m%d_%H%M%S")
             .strftime("%Y-%m-%d %H:%M:%S") if len(stamp) == 15 else "- 时间：%s" % stamp,
             "- 源目录：`%s`" % (data.get("folder") or ""),
             "- 文件数：**%d**" % len(moves), ""]
    if data.get("created_dirs"):
        lines.append("- 新建目录：%d 个" % len(data["created_dirs"]))
        lines.append("")

    groups = {}
    for mv in moves:
        src, dst = mv.get("from", ""), mv.get("to", "")
        rel = os.path.relpath(dst, base) if base else dst
        cat = rel.split(os.sep)[0] if os.sep in rel else "."
        groups.setdefault(cat, []).append((src, rel))
    for cat in sorted(groups):
        lines.append("## %s（%d 个）" % (cat, len(groups[cat])))
        lines.append("")
        lines.append("| 文件名 | 来自 | 去向 |")
        lines.append("| --- | --- | --- |")
        for src, rel in groups[cat][:500]:
            lines.append("| %s | `%s` | `%s` |"
                         % (os.path.basename(src), os.path.dirname(src), rel))
        lines.append("")
    if len(moves) > 500:
        lines.append("> 只列出前 500 条，完整记录见 `%s`" % mf)
    try:
        with open(path, "w", encoding="utf-8") as f:
            f.write("\n".join(lines))
    except OSError:
        return None
    return path


# ─────────────────────────── 开机自启 ───────────────────────────
AUTORUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
AUTORUN_NAME = "整理助手"
AUTOSTART_TASK = "整理助手_开机自启"


def autostart_cmd():
    """自启时用的命令行：直接进托盘，不弹主窗口。"""
    return _task_runner() + " --tray"


def _reg_get_autostart():
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, AUTORUN_KEY) as k:
            v, _ = winreg.QueryValueEx(k, AUTORUN_NAME)
            return v or ""
    except OSError:
        return ""


def _reg_set_autostart(on):
    import winreg
    try:
        with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, AUTORUN_KEY, 0,
                                winreg.KEY_SET_VALUE) as k:
            if on:
                winreg.SetValueEx(k, AUTORUN_NAME, 0, winreg.REG_SZ, autostart_cmd())
            else:
                try:
                    winreg.DeleteValue(k, AUTORUN_NAME)
                except FileNotFoundError:
                    pass
        return True, ""
    except OSError as ex:
        return False, str(ex)


def _schtasks_elevated(args):
    """用 UAC 提权跑一次 schtasks，成功返回 True。"""
    import ctypes
    try:
        cmd = subprocess.list2cmdline([_schtasks()] + args)
        rc = ctypes.windll.shell32.ShellExecuteW(None, "runas", "cmd.exe",
                                                 "/c " + cmd, None, 0)
        return int(rc) > 32
    except Exception:
        return False


def autostart_state():
    """off / normal（注册表 Run）/ strong（计划任务·最高权限）。"""
    ok_task, _, _ = task_query(AUTOSTART_TASK)
    if ok_task:
        return "strong"
    if _reg_get_autostart():
        return "normal"
    return "off"


def _task_delete_maybe_elevate():
    """删自启计划任务；普通权限删不掉就提权再删。True=已不存在。"""
    task_delete(AUTOSTART_TASK)
    ok, _, _ = task_query(AUTOSTART_TASK)
    if not ok:
        return True
    _schtasks_elevated(["/Delete", "/F", "/TN", AUTOSTART_TASK])
    for _ in range(10):
        time.sleep(0.4)
        ok, _, _ = task_query(AUTOSTART_TASK)
        if not ok:
            return True
    return False


def autostart_set(mode):
    """切换自启方式，返回 (ok, 说明)。"""
    ok_task, _, _ = task_query(AUTOSTART_TASK)
    if mode == "off":
        _reg_set_autostart(False)
        if ok_task and not _task_delete_maybe_elevate():
            return False, ("已清掉注册表自启，但删不掉「强力自启」的计划任务\n"
                           "（它是以管理员权限创建的，删除也要授权）。\n"
                           "再试一次并同意 UAC 即可。")
        return True, "已关闭开机自启"
    if mode == "normal":
        ok, err = _reg_set_autostart(True)
        if not ok:
            return False, "写注册表失败：" + err
        if ok_task and not _task_delete_maybe_elevate():
            return False, ("注册表自启已设好，但旧的「强力自启」任务没删掉，\n"
                           "两者会同时生效。请再试一次并同意 UAC。")
        return True, "已设为普通自启：登录后自动在托盘运行（普通权限）"
    if mode == "strong":
        _reg_set_autostart(False)
        args = ["/Create", "/F", "/TN", AUTOSTART_TASK,
                "/SC", "ONLOGON", "/RL", "HIGHEST", "/TR", autostart_cmd()]
        # 已经是管理员就直接建；不是就走一次 UAC 提权去建
        if is_admin():
            rc, txt = _run_hidden([_schtasks()] + args)
            if rc != 0:
                return False, (txt or ("返回码 %d" % rc))[:300]
        else:
            r = _schtasks_elevated(args)
            if not r:
                return False, ("创建强力自启需要一次管理员授权，刚才被取消了。\n"
                               "可以再试一次，或者先用「普通」自启。")
        # 提权后要等系统把任务登记完
        ok2 = False
        for _ in range(12):
            time.sleep(0.4)
            ok2, _, _ = task_query(AUTOSTART_TASK)
            if ok2:
                break
        if not ok2:
            return False, ("已请求提权，但查不到这个计划任务。\n"
                           "可能被安全软件拦截，请重试或改用「普通」自启。")
        return True, "已设为强力自启：登录后以管理员权限在托盘运行"
    return False, "未知的自启模式"


# ─────────────────────────── 系统托盘 ───────────────────────────
_tray = {"icon": None, "ok": False, "err": ""}


def tray_available():
    try:
        import pystray          # noqa: F401
        from PIL import Image   # noqa: F401
        return True, ""
    except Exception as ex:
        return False, str(ex)


def tray_start(title, icon_path, menu_spec):
    """把图标挂到托盘。menu_spec 是 [(类型, 标签, 回调)] 结构：

         ("item", "打开主窗口", fn)
         ("sep", None, None)
         ("auto", None, None)      ← 自动插入「开机自启」子菜单

    回调在托盘线程里执行，调用方要自己 root.after 切回主线程。
    """
    okp, err = tray_available()
    if not okp:
        _tray["err"] = "托盘组件不可用：" + err
        return False
    try:
        import pystray
        from PIL import Image
    except Exception as ex:
        _tray["err"] = str(ex)
        return False

    img = None
    try:
        if icon_path and os.path.exists(icon_path):
            img = Image.open(icon_path).convert("RGBA").resize((64, 64))
    except Exception:
        img = None
    if img is None:
        img = Image.new("RGBA", (64, 64), (47, 111, 221, 255))

    def _auto_menu():
        # 打开菜单时查一次就行；原来三项各查一遍，每开一次菜单起 3 次 schtasks
        st = autostart_state()
        return pystray.Menu(
            pystray.MenuItem("关闭", lambda i, it: menu_spec_auto("off"),
                             checked=lambda it, s=st: s == "off",
                             radio=True),
            pystray.MenuItem("普通（登录后在托盘运行）",
                             lambda i, it: menu_spec_auto("normal"),
                             checked=lambda it, s=st: s == "normal",
                             radio=True),
            pystray.MenuItem("强力（管理员权限运行）",
                             lambda i, it: menu_spec_auto("strong"),
                             checked=lambda it, s=st: s == "strong",
                             radio=True),
        )

    def menu_spec_auto(mode):
        for kind, label, fn in menu_spec:
            if kind == "auto_set":
                fn(mode)
                return

    items = []
    for kind, label, fn in menu_spec:
        if kind == "item":
            items.append(pystray.MenuItem(label, (lambda f: lambda i, it: f())(fn),
                                          default=(label == menu_spec[0][1])))
        elif kind == "sep":
            items.append(pystray.Menu.SEPARATOR)
        elif kind == "auto":
            items.append(pystray.MenuItem("开机自启", _auto_menu()))

    try:
        icon = pystray.Icon("tidy_helper", img, title, pystray.Menu(*items))
        _tray["icon"] = icon
        _tray["ok"] = True
        import threading
        threading.Thread(target=icon.run, daemon=True).start()
        return True
    except Exception as ex:
        _tray["err"] = str(ex)
        _tray["ok"] = False
        return False


def bind_wheel_deep(widget, handler):
    """给控件和它所有子孙绑滚轮。

    Tk 的事件不冒泡，鼠标停在哪个子控件上就只发给它，
    所以想「整块区域都能滚」只能逐个绑。
    """
    try:
        widget.bind("<MouseWheel>", handler, add="+")
        widget.bind("<Button-4>", handler, add="+")
        widget.bind("<Button-5>", handler, add="+")
    except Exception:
        pass
    try:
        kids = widget.winfo_children()
    except Exception:
        kids = []
    for k in kids:
        bind_wheel_deep(k, handler)


def fit_wraplength(container, label, min_width=240, pad=20,
                   delay=140, scheduler=None):
    """让 label 的 wraplength 跟着 container 宽度走，带防抖。

    返回可直接 bind 到 <Configure> 的回调。
    以前这逻辑在截图页/缓存页/搜索页各写了一份（三份几乎一样，各自
    还差一点：有的带防抖、有的没有、有的少变化判断）。
    """
    job = [None]
    host = scheduler or container

    def _do():
        job[0] = None
        try:
            want = max(min_width, container.winfo_width() - pad)
            if abs(int(label.cget("wraplength")) - want) > 8:
                label.configure(wraplength=want)
        except Exception:
            pass

    def handler(event=None):
        if job[0]:
            try:
                host.after_cancel(job[0])
            except Exception:
                pass
        job[0] = host.after(delay, _do)

    return handler


def tray_notify(msg, title=""):
    """弹一条气泡通知（走托盘图标）。没有托盘就静默返回 False。"""
    ic = _tray.get("icon")
    if not ic:
        return False
    try:
        ic.notify(msg, title or "整理助手")
        return True
    except Exception:
        return False


def _tray_icon_keys():
    """列出 NotifyIconSettings 里属于本程序的子键名（Win10 没这键就返回 []）。"""
    import winreg
    base = r"Control Panel\NotifyIconSettings"
    out = []
    try:
        target = os.path.normcase(sys.executable)
    except Exception:
        return out
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, base) as root:
            i = 0
            while True:
                try:
                    sub = winreg.EnumKey(root, i)
                except OSError:
                    break
                i += 1
                try:
                    with winreg.OpenKey(root, sub) as k:
                        exe, _ = winreg.QueryValueEx(k, "ExecutablePath")
                except OSError:
                    continue
                if os.path.normcase(exe) == target:
                    out.append(sub)
    except OSError:
        pass
    return out


def set_tray_promoted(flag):
    """把本程序的托盘图标固定到任务栏(True) / 交还给用户位置(False)。

    只在用户明确要求时调用 —— 上一版每次启动都强制置 1，
    结果用户把它拖进 ^ 折叠区后，下次启动又被系统拽回任务栏。
    """
    import winreg
    base = r"Control Panel\NotifyIconSettings"
    n = 0
    for sub in _tray_icon_keys():
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, base + "\\" + sub, 0,
                                winreg.KEY_SET_VALUE) as k:
                winreg.SetValueEx(k, "IsPromoted", 0, winreg.REG_DWORD,
                                  1 if flag else 0)
                n += 1
        except OSError:
            continue
    return n


def get_tray_promoted():
    """读回本程序托盘键的 IsPromoted 实际值：{键名: 0/1/None}。"""
    import winreg
    base = r"Control Panel\NotifyIconSettings"
    out = {}
    for sub in _tray_icon_keys():
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, base + "\\" + sub) as k:
                v, _ = winreg.QueryValueEx(k, "IsPromoted")
                out[sub] = int(v)
        except OSError:
            out[sub] = None
    return out


def apply_tray_pin(mode=None):
    """按设置摆放托盘图标的位置，并读回确认。

    返回 (写入次数, 仍不符合期望的键名列表)。

    - taskbar  : IsPromoted=1，图标固定在任务栏（默认，用户一眼能看到）
    - overflow : IsPromoted=0，只放在 ^ 折叠区里
    - system   : 一个键都不写，完全交给 Windows 和用户自己的拖动

    老版本每次启动都写 1，于是用户把图标拖进折叠区后下次启动又被拽回任务栏；
    现在位置是明确选项，「跟随系统」模式下用户拖到哪就一直在哪。
    """
    mode = mode or S.get("tray_pin", "taskbar")
    if mode not in ("taskbar", "overflow"):
        return 0, []
    want = 1 if mode == "taskbar" else 0
    n = set_tray_promoted(bool(want))
    states = get_tray_promoted()
    if not states:
        # 一个自己的托盘键都没找到（比如用别的解释器跑源码版），
        # 这时不能算「已经做对了」，否则 exe 那份永远改不了
        return n, []
    bad = [k for k, v in states.items() if v != want]
    return n, bad


def tray_stop():
    icon = _tray.get("icon")
    if icon is not None:
        try:
            icon.stop()
        except Exception:
            pass
    _tray["icon"] = None
    _tray["ok"] = False


# ─────────────────────────── 单实例 ───────────────────────────
# 两个用途：
#   互斥体 —— 同时只允许一个界面实例（不然几个托盘图标互相抢位置）
#   命名事件 —— 第二个实例点开时，把已经在跑的那个窗口叫到前面
MUTEX_NAME = "Local\\TidyHelper_MainInstance"
SHOW_EVENT = "Local\\TidyHelper_Show_Main"
_MUTEX = {"handle": None}
_K32 = {"lib": None}


def _kernel32():
    """显式声明签名：默认 c_int 返回值会把 64 位句柄截断。"""
    if _K32["lib"] is None:
        import ctypes
        k = ctypes.windll.kernel32
        k.CreateMutexW.restype = ctypes.c_void_p
        k.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_wchar_p]
        k.OpenMutexW.restype = ctypes.c_void_p
        k.OpenMutexW.argtypes = [ctypes.c_uint, ctypes.c_int, ctypes.c_wchar_p]
        k.CreateEventW.restype = ctypes.c_void_p
        k.CreateEventW.argtypes = [ctypes.c_void_p, ctypes.c_int,
                                   ctypes.c_int, ctypes.c_wchar_p]
        k.OpenEventW.restype = ctypes.c_void_p
        k.OpenEventW.argtypes = [ctypes.c_uint, ctypes.c_int, ctypes.c_wchar_p]
        k.WaitForSingleObject.restype = ctypes.c_uint
        k.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_uint]
        k.SetEvent.restype = ctypes.c_int
        k.SetEvent.argtypes = [ctypes.c_void_p]
        k.CloseHandle.restype = ctypes.c_int
        k.CloseHandle.argtypes = [ctypes.c_void_p]
        _K32["lib"] = k
    return _K32["lib"]


def _claim_single_instance():
    """只允许一个界面实例。已经有一个在跑就返回 False。"""
    try:
        k = _kernel32()
        # 先试打开：能打开说明已有实例，比读 GetLastError 可靠
        h = k.OpenMutexW(0x00100000, False, MUTEX_NAME)   # SYNCHRONIZE
        if h:
            k.CloseHandle(h)
            return False
        h = k.CreateMutexW(None, False, MUTEX_NAME)
        if not h:
            return True                                   # 建不了就别拦用户
        _MUTEX["handle"] = h                              # 持有到进程结束
        return True
    except Exception:
        return True


def _signal_show_existing():
    """通知已经在跑的那个实例：把窗口叫出来。"""
    try:
        k = _kernel32()
        ev = k.OpenEventW(0x0002, False, SHOW_EVENT)      # EVENT_MODIFY_STATE
        if not ev:
            return False
        k.SetEvent(ev)
        k.CloseHandle(ev)
        return True
    except Exception:
        return False


def start_show_listener(callback):
    """后台等命名事件；收到就回调（回调里自己 root.after 切主线程）。

    比 FindWindow + ShowWindow 稳：Tk 自己 withdraw 过的窗口
    被外部 ShowWindow 显示出来，Tk 内部状态还是「隐藏」的。
    """
    try:
        k = _kernel32()
        ev = k.CreateEventW(None, False, False, SHOW_EVENT)
        if not ev:
            return False
    except Exception:
        return False

    def loop():
        import threading
        while True:
            try:
                if k.WaitForSingleObject(ev, 500) == 0:
                    try:
                        callback()
                    except Exception:
                        pass
            except Exception:
                time.sleep(0.5)

    import threading
    threading.Thread(target=loop, daemon=True).start()
    return True


# ─────────────────────────── 数据迁移 ───────────────────────────

MIGRATE_SUBDIRS = ["history", "logs", "卸载备份", "cache"]
# 配置不参与数据迁移：settings.json 由 save_settings 自己放到新数据目录下
MIGRATE_SKIP = {"配置"}
INDEX_SKIP = {".git", ".svn", "node_modules", "__pycache__", "venv", ".venv",
              "site-packages", "windows", "winsxs", "system32", "$recycle.bin",
              "system volume information", "programdata"}


def _move_tree(src, dst, moved, failed):
    """把 src 的内容并进 dst。目标已有同名项就跳过并记失败，绝不覆盖。"""
    if not os.path.isdir(dst):
        try:
            shutil.move(src, dst)
            moved.append(dst)
        except Exception as ex:
            failed.append((src, str(ex)))
        return
    try:
        names = os.listdir(src)
    except OSError as ex:
        failed.append((src, str(ex)))
        return
    for name in names:
        s = os.path.join(src, name)
        t = os.path.join(dst, name)
        if os.path.exists(t):
            if os.path.isdir(s) and os.path.isdir(t):
                _move_tree(s, t, moved, failed)
                try:
                    os.rmdir(s)
                except OSError:
                    pass
                continue
            failed.append((s, "目标已有同名项，没覆盖：%s" % t))
            continue
        try:
            shutil.move(s, t)
            moved.append(t)
        except Exception as ex:
            failed.append((s, str(ex)))
    try:
        os.rmdir(src)
    except OSError:
        pass


def migrate_data(old, new, progress=None):
    """把旧数据目录里的东西整体搬到新目录。返回 (成功列表, 失败列表)。

    以前只搬 history/logs/卸载备份/cache 四个子目录，迁移页的「迁移」任务、
    tray.log、界面错误.log 这些零散文件全留在旧目录里，看起来像没搬干净。
    现在整棵搬，只有 配置 不搬（由 save_settings 负责）。
    """
    moved, failed = [], []
    if not old or not new:
        return moved, [("", "源或目标为空")]
    o = os.path.normcase(os.path.abspath(old))
    n = os.path.normcase(os.path.abspath(new))
    if o == n:
        return moved, [("", "源和目标是同一个目录")]
    if n.startswith(o + os.sep):
        return moved, [(new, "新目录不能在旧数据目录里面")]
    if o.startswith(n + os.sep):
        return moved, [(old, "旧数据目录不能在新目录里面")]
    try:
        os.makedirs(new, exist_ok=True)
    except OSError as ex:
        return moved, [(new, str(ex))]
    try:
        names = [x for x in os.listdir(old)]
    except OSError as ex:
        return moved, [(old, str(ex))]
    # 固定子目录先搬（体积大、耗时长），零散文件放最后
    names.sort(key=lambda x: 0 if x in MIGRATE_SUBDIRS else 1)
    total = len(names)
    for i, name in enumerate(names):
        if progress:
            try:
                progress(i, total, name)
            except Exception:
                pass
        if name in MIGRATE_SKIP:
            continue
        _move_tree(os.path.join(old, name), os.path.join(new, name), moved, failed)
    return moved, failed


# ─────────────────────────── 文件名索引与搜索 ───────────────────────────
#
# 表结构（schema 3）：目录去重 + 目录合计预聚合。
#
#   dirs (id, path, mtime, scanned_at, fresh, f0, n, size_sum, n_files)
#   files(dir_id, name, size, mtime)
#   meta (k, v)
#
# size_sum / n_files 是「这个目录里所有文件的字节总和 / 个数」，建库时一次
# 算好（见 _index_insert_dir）。问「什么最占空间」只需要扫 dirs 表，不用
# JOIN files 再 GROUP BY —— 实测 536 ms → 32 ms。
# scanned_at 是这次遍历该目录的时间，用来回答「数据多旧」。
# fresh 是历史遗留列（schema 2 起恒为 1、无人读取），保留只为旧库兼容。
#   dirs (id, path, mtime, fresh, f0, n)   一个目录只存一次路径
#   files(dir_id, name, size, mtime)       文件名 / 大小 / 修改时间
#   meta (k, v)                            根目录、建库时间、模式
#
# 路径字符串远长于文件名，一个目录平均十几个文件；实测 100 万条索引从
# 「每行存完整 path + name」的 97.8 MB 降到 40.7 MB，查询还快一点。
# files 的行按目录连续插入，dirs.f0/n 记下这段 rowid 区间，重建索引时整块
# 复制即可，既不用扫全表，也不用额外给 files(dir_id) 建索引。
#
# 遍历用 os.scandir 而不是 os.walk：DirEntry 自带 stat 信息，省掉逐文件的
# os.stat 系统调用，实测快 5.7–10.7 倍（4 千 → 3 万文件/秒以上）。
# 只复用「目录 mtime 没变」的子树 —— 目录里增删改名都会更新目录 mtime，
# 所以这一步是安全的；代价是复用到的文件不再刷新大小/时间（拿它们要列目录）。

# schema 3 把「每个目录合计多大」在建库时就写进 dirs.size_sum / dirs.n_files。
#
# 为什么：问「什么最占空间」走的是按目录聚合。schema 2 每次都要
# JOIN files 再 GROUP BY —— 实测 82 万文件 536 ms，而排行本身只需要 32 ms。
# 实测给 files(size) 或 files(dir_id) 建索引都**没用**（671→639→696 ms，
# 没有统计意义）：聚合必须扫完 files 的每一行，索引改变不了这一点。
# 把合计提前算好，查询退化成一次全表扫 dirs（3.9 万行）→ 32 ms，16 倍。
# 代价是库大 9.3 MB（58.6→67.9 MB），写一个目录多做一次 UPDATE（实测 0.2 ms）。
#
# dirs.scanned_at 记这次遍历该目录的时间，用来回答「数据多旧」，也是
# 后续增量校验的锚点。旧库（schema 2）不强制重建：查询时回退老 SQL，
# 只是慢，功能不缺。
INDEX_SCHEMA = 3
INDEX_SCHEMA_MIN = 2        # 还能读的最老版本，低于它才算不可用

_INDEX_PRAGMAS = (
    "journal_mode=OFF",
    "synchronous=OFF",
    "temp_store=MEMORY",
    "mmap_size=268435456",
    "cache_size=-65536",
)

# 最近一次建索引的统计，给 RPC 层回报进度用
_index_last_run = {}

# 清单是「读 → 改 → 写」三段，后台校验线程和主线程都可能走这条路。
# 不加锁的话，一次 index_add 和一次后台重建交错，后写的会把先写的覆盖掉，
# 表现成「刚加的目录过一会儿不见了」——最难查的那种偶发。锁只保护清单，
# 不保护建库（建库动的是各自独立的 .db，本来就不冲突）。
_IX_LOCK = threading.RLock()


def _index_open(path):
    """打开索引库并套上 pragma；库不存在或打不开返回 None。"""
    import sqlite3
    if not os.path.isfile(path):
        return None
    try:
        db = sqlite3.connect(path)
    except sqlite3.DatabaseError:
        return None
    for p in _INDEX_PRAGMAS:
        try:
            db.execute("PRAGMA " + p)
        except sqlite3.DatabaseError:
            pass
    return db


def _index_schema_version(db):
    try:
        return int(db.execute("PRAGMA user_version").fetchone()[0] or 0)
    except Exception:
        return 0


def _index_can_read(db):
    """这个库的结构还读得了吗：只要不低于 INDEX_SCHEMA_MIN 就凑合能用。

    刻意不要求等于 INDEX_SCHEMA：升级后旧库（schema 2）没有 size_sum 列，
    但 files/dirs 都在，回退老 SQL 一样能答，只是慢。为了多一列就逼用户
    重建几百万文件的索引，代价远大于收益。
    """
    v = _index_schema_version(db)
    return INDEX_SCHEMA_MIN <= v <= INDEX_SCHEMA


def _index_has_totals(db):
    """库里有 dirs.size_sum 吗（决定走快 SQL 还是回退聚合）。"""
    try:
        cols = {r[1] for r in db.execute("PRAGMA table_info(dirs)")}
    except Exception:
        return False
    return "size_sum" in cols





def _index_walker_exe():
    """找 Rust 遍历器 indexwalk.exe。

    打包后与引擎 exe 同目录（引擎\\indexwalk.exe）；开发时放在源码目录，
    或者用环境变量 TIDY_INDEXWALK 指定。找不到就返回 None，调用方回退到
    Python 遍历——功能不受影响，只是慢一些。
    """
    cands = []
    env = os.environ.get("TIDY_INDEXWALK")
    if env:
        cands.append(env)
    if getattr(sys, "frozen", False):
        cands.append(os.path.join(os.path.dirname(os.path.abspath(sys.executable)),
                                  "indexwalk.exe"))
    cands.append(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                              "indexwalk.exe"))
    for p in cands:
        if p and os.path.isfile(p):
            return p
    return None


def _index_insert_dir(db, path, mtime, files, total):
    """写一个目录块：目录行 + 它的文件行。返回新的文件累计数。

    size_sum / n_files 在这里就累好，查询时不用再 JOIN files 聚合。
    """
    size_sum = 0
    for _nm, sz, _mt in files:
        size_sum += sz or 0
    did = db.execute(
        "INSERT INTO dirs(path, mtime, scanned_at, fresh, f0, n, size_sum, n_files)"
        " VALUES(?,?,?,1,?,?,?,?)",
        (path, mtime, time.time(), total + 1, len(files), size_sum,
         len(files))).lastrowid
    if files:
        db.executemany(
            "INSERT INTO files(dir_id, name, size, mtime) VALUES(?,?,?,?)",
            ((did, nm, sz, mt) for nm, sz, mt in files))
    return total + len(files)


def _index_scan_rust(exe, root, db, state, progress):
    """用 Rust 遍历器走一棵树，边读边落库；返回这棵树新增的文件数。

    遍历器按行吐记录（D 目录 / F 文件 / E 错误），这里按目录块攒着写，
    保证每个目录的文件行一次 executemany 落盘。中途失败抛异常，外层用
    SAVEPOINT 回滚这棵树再退回 Python 遍历。
    """
    cur_path = None
    cur_mtime = 0.0
    pending = []
    total = state["files"]
    last_report = total
    started = total

    proc = subprocess.Popen(
        [exe, root], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        text=True, encoding="utf-8", errors="replace", bufsize=1024 * 1024,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    try:
        for raw in proc.stdout:
            line = raw.rstrip("\n")
            if not line:
                continue
            tag = line[0]
            if tag == "D":
                parts = line.split("\t", 2)
                if len(parts) < 3:
                    continue
                if cur_path is not None:
                    total = _index_insert_dir(db, cur_path, cur_mtime, pending, total)
                    state["dirs"] += 1
                    if progress and total - last_report >= 20000:
                        last_report = total
                        progress(total)
                cur_path, cur_mtime, pending = parts[2], float(parts[1]), []
            elif tag == "F":
                parts = line.split("\t", 3)
                if len(parts) == 4:
                    pending.append((parts[3], int(parts[1]), float(parts[2])))
            elif tag == "E":
                parts = line.split("\t", 2)
                state["errs"].append(
                    (parts[2] if len(parts) == 3 else root, "读取失败"))
        if cur_path is not None:
            total = _index_insert_dir(db, cur_path, cur_mtime, pending, total)
            state["dirs"] += 1
            if progress and total - last_report >= 20000:
                progress(total)
    finally:
        try:
            proc.stdout.close()
        except OSError:
            pass
        code = proc.wait()

    if code != 0:
        raise RuntimeError("indexwalk 退出码 %d" % code)
    state["files"] = total
    return total - started


def _index_scan_python(root, db, state, progress):
    """Python 兜底遍历：os.scandir + DirEntry.stat，逻辑与旧版一致。"""
    stack = [(root, os.stat(root).st_mtime)]
    total = state["files"]
    last_report = total
    while stack:
        cur, dmtime = stack.pop()
        files = []
        subs = []
        try:
            with os.scandir(cur) as it:
                for ent in it:
                    try:
                        if ent.is_dir(follow_symlinks=False):
                            low = ent.name.lower()
                            if low in INDEX_SKIP or ent.name.startswith("$"):
                                continue
                            subs.append((ent.path, ent.stat().st_mtime))
                        elif ent.is_file(follow_symlinks=False):
                            st = ent.stat()
                            files.append((ent.name, int(st.st_size),
                                          float(st.st_mtime)))
                    except OSError:
                        continue
        except OSError:
            state["errs"].append((cur, "读取失败"))
            continue

        total = _index_insert_dir(db, cur, dmtime, files, total)
        state["dirs"] += 1
        stack.extend(subs)
        if progress and total - last_report >= 20000:
            last_report = total
            progress(total)
    state["files"] = total


def _like_literal(text):
    r"""把用户输入转成 LIKE 的字面量：% _ \ 都加反斜杠转义。

    不转义的话，用户搜一个下划线等于搜「任意一个字符」，会把整个索引捞回来。
    """
    return text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


# ---------------------------------------------------------------- 索引目录
#
# 一个根目录一份索引库：cache\indexes\<id>.db，目录清单在 catalog.json。
# 多份库可以同时存在、可以单独删，搜索时并发查再合并。
# 之所以不是「一个库塞所有根目录」：删一个范围就得重建整库，而且搜索没法
# 按范围收窄；分库后删除只是删文件，范围筛选也只是少查几个库。

INDEX_DIRNAME = "indexes"


def index_dir():
    return os.path.join(cache_dir(), INDEX_DIRNAME)


def _ix_catalog_path():
    return os.path.join(index_dir(), "catalog.json")


def _ix_make_id(root):
    """根目录 → 稳定 id。同一个路径永远得到同一个 id，重建不会换文件名。"""
    import hashlib
    key = os.path.normcase(os.path.abspath(root)).encode("utf-8", "replace")
    return hashlib.sha1(key).hexdigest()[:12]


def _ix_normalize(item):
    """把清单里的一条补齐成完整结构，缺字段给默认值。"""
    root = str(item.get("root") or "")
    if not root:
        return None
    ident = str(item.get("id") or "") or _ix_make_id(root)
    return {
        "id": ident,
        "root": root,
        "db": str(item.get("db") or (ident + ".db")),
        "files": int(item.get("files") or 0),
        "dirs": int(item.get("dirs") or 0),
        "bytes": int(item.get("bytes") or 0),
        "built_at": int(item.get("built_at") or 0),
        "ms": int(item.get("ms") or 0),
        "walker": str(item.get("walker") or ""),
        "why": str(item.get("why") or ""),
        "schema": int(item.get("schema") or INDEX_SCHEMA),
    }


def _ix_load():
    """读索引清单。清单不存在时用 settings.index_roots 迁移出一份。"""
    items = []
    try:
        with open(_ix_catalog_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
        raw = data.get("items") if isinstance(data, dict) else data
        for it in raw or []:
            norm = _ix_normalize(it if isinstance(it, dict) else {})
            if norm:
                items.append(norm)
    except (OSError, ValueError):
        items = []

    if not items:
        # 首次运行 / 老版本升级：把设置里的范围搬成条目（还没建库，files=0）
        seen = set()
        for root in (S.get("index_roots") or []):
            root = str(root or "")
            if not root or not os.path.isdir(root):
                continue
            ident = _ix_make_id(root)
            if ident in seen:
                continue
            seen.add(ident)
            items.append(_ix_normalize({"root": root, "id": ident}))
        if items:
            _ix_save(items)
    return items


def _ix_save(items):
    """原子写清单：先写 .new 再 replace，写坏也只是丢清单不丢索引文件。"""
    os.makedirs(index_dir(), exist_ok=True)
    path = _ix_catalog_path()
    tmp = path + ".new"
    payload = {"version": 1, "items": items}
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)

def _ix_db_abspath(item):
    """条目对应的 .db 绝对路径。清单里只存文件名，避免移动缓存目录后失效。"""
    name = os.path.basename(str(item.get("db") or "")) or (item["id"] + ".db")
    return os.path.join(index_dir(), name)


def index_add(roots):
    """把若干根目录加进清单（已存在的不重复加），返回最新清单。"""
    with _IX_LOCK:
        items = _ix_load()
        have = {i["id"] for i in items}
        changed = False
        for root in roots or []:
            root = os.path.abspath(str(root or ""))
            if not root or not os.path.isdir(root):
                continue
            ident = _ix_make_id(root)
            if ident in have:
                continue
            items.append(_ix_normalize({"root": root, "id": ident}))
            have.add(ident)
            changed = True
        if changed:
            _ix_save(items)
        return items


def index_remove(ids):
    """删索引：先删库文件再删清单条目。返回真正删掉的 id 列表。"""
    want = set(str(i) for i in (ids or []))
    if not want:
        return []
    with _IX_LOCK:
        items = _ix_load()
        keep = []
        gone = []
        for it in items:
            if it["id"] not in want:
                keep.append(it)
                continue
            path = _ix_db_abspath(it)
            for suffix in ("", "-journal", "-wal", "-shm"):
                try:
                    os.remove(path + suffix)
                except OSError:
                    pass
            gone.append(it["id"])
        if gone:
            _ix_save(keep)
        return gone


def _ix_items_for_path(path):
    """找出覆盖这个路径的索引条目，返回 [(item, root)]，根最长（最具体）的在前。

    同一棵树可能同时被「D:\\」和「D:\\App」两条索引覆盖，此时只更新最具体
    的那条，避免同一份改动写两遍库。
    """
    path = os.path.abspath(str(path or ""))
    if not path:
        return []
    key = os.path.normcase(path)
    out = []
    for it in _ix_load():
        root = str(it.get("root") or "")
        if not root:
            continue
        try:
            rk = os.path.normcase(os.path.abspath(root)).rstrip("\\/")
        except (ValueError, OSError):
            continue
        if key == rk or key.startswith(rk + os.sep):
            out.append((it, root))
    out.sort(key=lambda pair: len(pair[1]), reverse=True)
    return out


def _ix_scan_direct(folder):
    """扫一个目录的直接内容；返回 [(name, size, mtime)] 和目录自身 mtime。

    只扫这一层，不递归 —— schema 3 的 size_sum 记的是「这个目录自己的文件」，
    跨目录的累加在查询期按前缀做，所以刷一层就足以让排行正确。
    """
    with os.scandir(folder) as it:
        entries = list(it)
    files = []
    for e in entries:
        try:
            if e.is_dir(follow_symlinks=False):
                continue
            info = e.stat(follow_symlinks=False)
            files.append((e.name, int(info.st_size or 0),
                          float(info.st_mtime or 0)))
        except OSError:
            # 单个文件读不到（被独占、刚被删）：跳过它，不要让整个刷新生效不了
            continue
    try:
        dir_mtime = float(os.stat(folder).st_mtime)
    except OSError:
        dir_mtime = 0.0
    return files, dir_mtime


def _ix_refresh_dir(db, folder):
    """把一个目录在索引里的记录换成当前磁盘事实。返回 True 表示改到了。

    目录还没进过索引（整理时刚建出来的分类夹就是这种）就补一行；已经有行就
    把它的文件块整体换掉。补新行时 f0 取「当前最大 rowid + 1」，保证
    dirs.f0/n 指向的区间仍然连续 —— _ix_query_one 的第二个分支靠这个区间
    直接取文件，区间断了就查不到整个目录。
    """
    folder = os.path.abspath(folder)
    if not os.path.isdir(folder):
        return False
    try:
        files, dir_mtime = _ix_scan_direct(folder)
    except OSError:
        return False
    size_sum = sum(sz for _n, sz, _m in files)
    now = time.time()

    row = db.execute("SELECT id FROM dirs WHERE path = ?", (folder,)).fetchone()
    if row is None:
        nxt = (db.execute(
            "SELECT COALESCE(MAX(rowid), 0) FROM files").fetchone()[0] or 0) + 1
        did = db.execute(
            "INSERT INTO dirs(path, mtime, scanned_at, fresh, f0, n, size_sum, n_files)"
            " VALUES(?,?,?,1,?,?,?,?)",
            (folder, dir_mtime, now, nxt, len(files), size_sum,
             len(files))).lastrowid
    else:
        did = row[0]
        # 先删旧文件块再重算 f0：删完 MAX(rowid) 可能变小，新块仍连续
        db.execute("DELETE FROM files WHERE dir_id = ?", (did,))
        nxt = (db.execute(
            "SELECT COALESCE(MAX(rowid), 0) FROM files").fetchone()[0] or 0) + 1
        db.execute(
            "UPDATE dirs SET mtime=?, scanned_at=?, f0=?, n=?, size_sum=?,"
            " n_files=? WHERE id=?",
            (dir_mtime, now, nxt, len(files), size_sum, len(files), did))
    if files:
        db.executemany(
            "INSERT INTO files(dir_id, name, size, mtime) VALUES(?,?,?,?)",
            ((did, nm, sz, mt) for nm, sz, mt in files))
    return True


def _ix_drop_subtree(db, folder):
    """目录被删掉之后，把它和它下面所有目录的索引行一起清掉。

    不清理的话，删掉一整棵目录树之后，「什么最占空间」还会继续报这棵树，
    用户点进去发现路径不存在 —— 这比没有答案更糟。
    """
    folder = os.path.abspath(folder)
    prefix = folder.rstrip("\\/") + os.sep
    rows = db.execute(
        "SELECT id FROM dirs WHERE path = ? OR path LIKE ? ESCAPE '\\'",
        (folder, _like_literal(prefix) + "%")).fetchall()
    for (did,) in rows:
        db.execute("DELETE FROM files WHERE dir_id = ?", (did,))
        db.execute("DELETE FROM dirs WHERE id = ?", (did,))
    return len(rows)


# 一次写穿最多刷多少个目录。整理 5000 个文件通常只涉及几十个目标目录，
# 去重之后远小于这个数；真超过说明动的范围太大，直接重建索引更划算。
_IX_TOUCH_MAX_DIRS = 4000


def index_touch(paths):
    """Tier 0 写穿：软件自己动了磁盘，立刻把索引改成新事实。

    为什么需要这个：索引是一份快照，而软件自己的整理 / 撤销 / 删除 / 清理
    每天都在改磁盘。不写穿的话，用户刚用软件整理完文件，同一个软件再去回答
    「什么最占空间」或者搜索，给出的还是整理之前的位置 —— 它连自己做过什么
    都不记得。这不是索引机制的缺陷，是没有把「自己也是改动源」这件事算进去。

    成本几乎为零：一次移动只涉及源目录和目标目录两个目录，各扫一层就够
    （schema 3 的 size_sum 是单目录粒度，聚合在查询期做）。去重之后，整理
    几百个文件往往只需要刷十几个目录，总共几十毫秒。

    paths 里每个元素是「刚被创建 / 移动 / 删除的那条路径」。函数自己判断它
    现在还在不在：还在就刷父目录，不在就顺手把那棵子树从索引里摘掉。

    失败一律吞掉：写穿是优化，不是业务的一部分。它出错绝不能连带让用户的
    整理操作失败 —— 那种取舍是拿数据正确性换缓存新鲜度，方向反了。
    """
    try:
        raw = [p for p in (paths or []) if isinstance(p, str) and p.strip()]
    except TypeError:
        return 0
    if not raw:
        return 0

    # 按「哪个库 + 哪个目录」去重：一次整理常把几十个文件搬进同一个分类夹
    plan = {}
    dropped = {}
    for p in raw:
        try:
            ap = os.path.abspath(p)
        except (ValueError, OSError):
            continue
        parent = os.path.dirname(ap.rstrip("\\/")) or ap
        owners = _ix_items_for_path(parent)
        if owners:
            item = owners[0][0]
            plan.setdefault(item["id"], (item, set()))[1].add(parent)
        if not os.path.exists(ap):
            owners2 = _ix_items_for_path(ap)
            if owners2:
                item2 = owners2[0][0]
                dropped.setdefault(item2["id"], (item2, set()))[1].add(ap)

    if sum(len(v[1]) for v in plan.values()) > _IX_TOUCH_MAX_DIRS:
        # 一次动了几千个目录：逐个刷不如等下一次重建，别在这里拖住用户。
        # 注意数的是「目录总数」不是「库的个数」—— plan 按库 id 分键，
        # 一台机器通常只有一两个库，拿 len(plan) 当判断条件永远不会触发。
        return 0

    touched = 0
    for ident, (item, dirs) in plan.items():
        db = None
        try:
            db = _index_open(_ix_db_abspath(item))
            if db is None or not _index_has_totals(db):
                # 老库（schema 2）没有 size_sum/n_files：等它重建时自然升级，
                # 这里硬写会报「没有那一列」
                continue
            with db:
                for folder in dirs:
                    if _ix_refresh_dir(db, folder):
                        touched += 1
                for folder in dropped.get(ident, (item, set()))[1]:
                    touched += _ix_drop_subtree(db, folder)
        except Exception:
            continue
        finally:
            if db is not None:
                try:
                    db.close()
                except Exception:
                    pass
    return touched


def _index_build_one(item, walker, progress):
    """建单个条目的库：写 staging 再 replace，失败的半成品不会污染旧库。"""
    import sqlite3
    target = _ix_db_abspath(item)
    staging = target + ".new"
    for suffix in ("", "-journal", "-wal", "-shm"):
        try:
            os.remove(staging + suffix)
        except OSError:
            pass

    state = {"files": 0, "dirs": 0, "errs": []}
    t0 = time.perf_counter()
    db = sqlite3.connect(staging)
    for p in _INDEX_PRAGMAS:
        try:
            db.execute("PRAGMA " + p)
        except sqlite3.DatabaseError:
            pass
    try:
        db.executescript(
            "CREATE TABLE dirs(id INTEGER PRIMARY KEY, path TEXT, mtime REAL,"
            " scanned_at REAL, fresh INTEGER, f0 INTEGER, n INTEGER,"
            " size_sum INTEGER NOT NULL DEFAULT 0,"
            " n_files INTEGER NOT NULL DEFAULT 0);"
            "CREATE TABLE files(dir_id INTEGER, name TEXT, size INTEGER, mtime REAL);"
            "CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT);"
            "PRAGMA user_version=%d;" % INDEX_SCHEMA)
        root = item["root"]
        why = ""
        if not os.path.isdir(root):
            why = "目录不存在"
        else:
            done = False
            if walker:
                db.execute("SAVEPOINT root")
                try:
                    _index_scan_rust(walker, root, db, state, progress)
                    db.execute("RELEASE root")
                    done = True
                except Exception:
                    db.execute("ROLLBACK TO root")
                    db.execute("RELEASE root")
                    state["files"], state["dirs"] = 0, 0
                    why = "遍历器失败，已回退"
            if not done:
                try:
                    _index_scan_python(root, db, state, progress)
                except OSError:
                    why = "读取失败"
        meta = {
            "roots": json.dumps([root], ensure_ascii=False),
            "built_at": str(int(time.time())),
            "mode": "full",
            "root_stats": json.dumps([{
                "root": root, "files": state["files"], "dirs": state["dirs"],
                "ms": int((time.perf_counter() - t0) * 1000),
                "ok": not why, "why": why}], ensure_ascii=False),
        }
        for k, v in meta.items():
            db.execute("INSERT OR REPLACE INTO meta(k,v) VALUES(?,?)", (k, v))
        db.commit()
    finally:
        db.close()

    try:
        os.replace(staging, target)
    except OSError:
        for suffix in ("", "-journal", "-wal", "-shm"):
            try:
                os.remove(staging + suffix)
            except OSError:
                pass
        raise RuntimeError("索引写入失败")

    try:
        size_bytes = os.path.getsize(target)
    except OSError:
        size_bytes = 0
    item.update({
        "files": state["files"], "dirs": state["dirs"], "bytes": int(size_bytes),
        "built_at": int(time.time()), "ms": int((time.perf_counter() - t0) * 1000),
        "walker": "rust" if walker else "python", "why": why,
        "schema": INDEX_SCHEMA,
    })
    return state["files"], state["errs"]


def build_index(roots=None, ids=None, progress=None, full=False):
    """建立/重建索引。返回 (文件总数, 错误列表)。

    每次都是全量重建：目录的 mtime 变化不会向上冒泡，靠它跳子树会漏掉深处
    新增的文件（实测过，会漏）。真正的增量要 USN 日志，那需要管理员权限。

    大部分时间花在遍历上（实测占 92%，写库只占 8%），所以遍历交给 Rust 的
    indexwalk.exe（多线程枚举，实测 52 万文件 22.9s → 2.6s），找不到就回退
    Python 的 os.scandir 实现。full 参数保留只为兼容调用方。
    """
    items = _ix_load()
    if ids:
        want = set(str(i) for i in ids)
        targets = [i for i in items if i["id"] in want]
    elif roots:
        items = index_add(roots)
        want = set(_ix_make_id(os.path.abspath(str(r))) for r in (roots or []))
        targets = [i for i in items if i["id"] in want]
    else:
        targets = list(items)

    os.makedirs(index_dir(), exist_ok=True)
    walker = _index_walker_exe()
    errs = []
    total_files = 0
    total_dirs = 0
    t_all = time.perf_counter()

    for item in targets:
        try:
            files, ierrs = _index_build_one(item, walker, progress)
        except Exception as exc:
            item["why"] = "建立失败：%s" % (exc,)
            item["files"] = 0
            item["dirs"] = 0
            files, ierrs = 0, [(item["root"], item["why"])]
            # 遍历器出过事就整体回退，后面的条目直接走 Python
            if "遍历器" in item["why"]:
                walker = None
        total_files += files
        total_dirs += int(item.get("dirs") or 0)
        errs.extend(ierrs)

    if targets:
        # 不直接写回 build 开始时那份清单：建库可能跑几十秒，这期间用户可能
        # 在搜索页加了别的目录。重新读一遍、只覆盖这次真正建过的条目，
        # 这样两边的改动都不会丢。
        with _IX_LOCK:
            fresh = _ix_load()
            by_id = {i["id"]: i for i in fresh}
            for item in targets:
                if item["id"] in by_id:
                    by_id[item["id"]].update(item)
                else:
                    fresh.append(item)
                    by_id[item["id"]] = item
            _ix_save(fresh)

    _index_last_run.clear()
    _index_last_run.update({
        "files": total_files,
        "dirs_listed": total_dirs,
        "dirs_copied": 0,
        "files_copied": 0,
        "mode": "full",
        "walker": "rust" if walker else "python",
        "elapsed_ms": int((time.perf_counter() - t_all) * 1000),
    })
    return total_files, errs


# ── Tier 3：校验式重建（后台，只在抽样证明索引确实烂了时才动） ──────────

# 抽查多少个目录。40 次 scandir 在几十毫秒量级，比全量重建 7 秒便宜两个数量级。
_IX_VERIFY_DIRS = 40
# 超过这些比例就认为索引真的烂了，值得重建
_IX_MISSING_MAX = 0.10      # 抽到的目录里超过 10% 已经不存在
_IX_DIRTY_MAX = 0.25        # 抽到的目录里超过 25% 的文件数与 mtime 对不上


def _ix_verify_one(item):
    """抽查一个索引库，判断它还值不值得信。

    为什么抽查目录而不是核对文件：全量核对等于把建索引再跑一遍，那样这个
    后台任务本身就变成了「扫盘伤磁盘」的来源，恰好是用户担心的事。目录级的
    两个信号已经够用 —— 目录没了、或者目录里的文件数/mtime 变了，都说明这份
    账本跟磁盘对不上了。

    返回 {ok, checked, missing, dirty, why}。任何异常都算「不知道」，返回 ok=True
    保守放过：后台任务不该因为自己读不懂就删掉用户的索引。
    """
    db = _index_open(_ix_db_abspath(item))
    if db is None:
        return {"ok": False, "checked": 0, "missing": 0, "dirty": 0,
                "why": "索引库不存在"}
    try:
        rows = db.execute(
            "SELECT path, mtime, n_files FROM dirs ORDER BY RANDOM() LIMIT ?",
            (_IX_VERIFY_DIRS,)).fetchall()
    except Exception:
        return {"ok": True, "checked": 0, "missing": 0, "dirty": 0,
                "why": "读不了目录表"}
    finally:
        try:
            db.close()
        except Exception:
            pass

    if not rows:
        return {"ok": False, "checked": 0, "missing": 0, "dirty": 0,
                "why": "索引是空的"}

    missing = 0
    dirty = 0
    for path, mtime, n_files in rows:
        try:
            st = os.stat(path)
        except OSError:
            missing += 1
            continue
        # mtime 变了就说明这个目录被改过；再数一遍文件数，确认不是只有时间戳变
        try:
            actual = sum(1 for e in os.scandir(path) if not e.is_dir())
        except OSError:
            missing += 1
            continue
        if actual != int(n_files or 0):
            dirty += 1
        elif abs(float(st.st_mtime) - float(mtime or 0)) > 1.0:
            dirty += 1

    checked = len(rows)
    miss_ratio = missing / float(checked)
    dirty_ratio = dirty / float(checked)
    ok = miss_ratio <= _IX_MISSING_MAX and dirty_ratio <= _IX_DIRTY_MAX
    why = ""
    if not ok:
        why = "抽查 %d 个目录：%d 个已不存在，%d 个内容已变" % (
            checked, missing, dirty)
    return {"ok": ok, "checked": checked, "missing": missing,
            "dirty": dirty, "why": why}


def index_selfcheck(rebuild=True, progress=None):
    """抽查所有索引库，把确实过期的那些重建掉。返回一份报告。

    这是「用户不用管」的那一层：他从不点「重建索引」，索引也一样会跟上磁盘。
    但它必须便宜 —— 抽查是几十毫秒，重建只在抽查判定过期时才发生，两者差
    三个数量级。不做无条件定时重建，因为那正是用户说的「扫盘次数多伤磁盘」。
    """
    report = {"checked": 0, "stale_items": [], "rebuilt": [], "failed": [],
              "elapsed_ms": 0}
    t0 = time.perf_counter()
    items = _ix_load()
    if not items:
        report["elapsed_ms"] = int((time.perf_counter() - t0) * 1000)
        return report

    stale_ids = []
    for item in items:
        if not os.path.isdir(item.get("root") or ""):
            # 盘没接 / 目录没了：不是过期，是离线，交给 index_stats 报告
            continue
        v = _ix_verify_one(item)
        report["checked"] += 1
        if not v.get("ok"):
            stale_ids.append(item["id"])
            report["stale_items"].append({"id": item["id"], "root": item.get("root"),
                                    "why": v.get("why") or ""})

    if rebuild and stale_ids:
        try:
            build_index(ids=stale_ids, progress=progress)
            report["rebuilt"] = list(stale_ids)
        except Exception as exc:
            report["failed"] = [{"ids": stale_ids, "why": str(exc)}]
    report["elapsed_ms"] = int((time.perf_counter() - t0) * 1000)
    return report


def _freshness_mode():
    """索引新鲜度档位。读设置失败一律当 check（最稳的那一档）。"""
    try:
        m = str(load_settings().get("index_freshness") or "check")
    except Exception:
        return "check"
    return m if m in ("live", "check", "manual") else "check"


def index_quota_ok():
    """索引总占用是否还在上限内。超了不删数据，只是不再主动扩范围。"""
    try:
        cap_mb = int(load_settings().get("index_max_mb") or 2048)
    except Exception:
        cap_mb = 2048
    if cap_mb <= 0:
        return True, 0, 0
    used = 0
    for item in _ix_load():
        try:
            used += int(item.get("bytes") or 0)
        except Exception:
            pass
    return used <= cap_mb * 1024 * 1024, used, cap_mb * 1024 * 1024


# 热目录多久重扫一次。实测五个热目录（桌面/文档/下载/图片/视频）全量重建
# 只要 300 毫秒左右、库总共 0.45 MB —— 这个数字决定了这里不需要文件监听器。
_HOT_SECS = {"live": 60, "check": 600}
# 保鲜重扫必须串行。查询路径（搜不到就补扫）和后台节拍线程都会进来，
# 两条路径同时跑会在同一个 *.db.new staging 上对撞。和 _IX_LOCK 分开：
# 那把锁保护的是清单 json，建库和清单本来就不冲突。
_HOT_LOCK = threading.RLock()

# 「没搜到就补扫一次热目录」的最小间隔。这是查询里唯一会扫盘的地方，
# 必须有个下限，否则用户每敲一个字搜一次，就是每秒三次扫盘。
_HOT_MIN_GAP = 15.0

# 查询里同步补扫的规模上限。实测五个热目录 4,426 个文件、300 毫秒；
# 到 3 万个文件就是两秒级，用户会感到「搜索卡了一下」。超过就交给后台。
_HOT_INLINE_MAX = 30000

def _hot_roots():
    """要「保鲜」的热目录：桌面/文档/下载/图片/视频。

    跳过已经被更大索引根覆盖的那些 —— 用户要是把整个 D: 索引了，热目录
    自然含在里面，单独再建一份只会重复占地方。
    """
    covered = []
    for item in _ix_load():
        r = item.get("root") or ""
        if r and os.path.isdir(r):
            covered.append(os.path.normcase(os.path.abspath(r)).rstrip("\\") + "\\")
    out = []
    for p in default_index_roots():
        key = os.path.normcase(os.path.abspath(p)).rstrip("\\") + "\\"
        if any(key.startswith(c) and key != c for c in covered):
            continue
        out.append(p)
    return out


def hot_refresh(force=False):
    """把热目录重扫一遍，让「刚下载的文件」尽快能搜到。

    为什么不写文件监听器（ReadDirectoryChangesW / USN 日志）：监听要常驻
    句柄、维护白名单、处理漏事件，换来的只是这两三百毫秒的窗口期。而定期
    重扫一次就是 300ms、0.45 MB —— 用 300ms 换掉一整套监听器，是明显划算
    的那一边。这是实测结论，不是估计。

    代价有个前提：热目录是「小」的。整盘 140 万文件要 7.5 秒，所以这里
    只说热目录，不碰整盘；整盘靠 index_selfcheck 的抽查重建。

    必须串行：查询路径（搜不到就补扫）和后台节拍线程都会调到这里，两条路径
    同时进来会在同一个 `*.db.new` 上对撞 —— 一个在写、另一个把 staging 删了
    重建，最后 replace 上去的可能是半个库。用一把独立的锁（不是 _IX_LOCK：
    那把锁保护的是清单 json，建库和清单本来就不冲突）把整个重扫挡住。
    """
    with _HOT_LOCK:
        return _hot_refresh_locked(force)


def _hot_refresh_locked(force):
    roots = _hot_roots()
    if not roots:
        return {"roots": [], "files": 0, "elapsed_ms": 0, "skipped": "没有可保鲜的热目录"}
    try:
        ok, used, cap = index_quota_ok()
        if not ok:
            # 超限就不再主动扩范围，但也不删用户已有的索引
            return {"roots": roots, "files": 0, "elapsed_ms": 0,
                    "skipped": "索引已占 %d MB，超过上限 %d MB"
                               % (used // 1048576, cap // 1048576)}
    except Exception:
        pass
    t0 = time.perf_counter()
    try:
        items = _ix_load()
        known_roots = {}
        for item in items:
            root = os.path.normcase(os.path.abspath(item.get("root") or ""))
            known_roots[root] = max(known_roots.get(root, 0),
                                    int(item.get("files") or 0))
        # 热目录也可能很大（有人把几十万个文件的目录当下载夹）。后台节拍
        # 不该在这种机器上每 10 分钟烧掉几秒 CPU，交给 index_selfcheck 的
        # 抽查更划算。用户自己点「立即刷新」不受这个限制。
        if not force:
            known = max([known_roots.get(os.path.normcase(os.path.abspath(p)), 0)
                         for p in roots] or [0])
            if known > _HOT_INLINE_MAX:
                return {"roots": roots, "files": 0, "elapsed_ms": 0,
                        "skipped": "热目录有 %d 个文件，超过同步重扫上限，"
                                   "交给后台抽查" % known}
        missing = [p for p in roots
                   if os.path.normcase(os.path.abspath(p)) not in known_roots]
        if missing:
            index_add(missing)
        files, errs = build_index(roots=roots)
        # 时间戳记在这里而不是调用方：查询补扫和后台节拍走的是同一个函数。
        _INDEX_WATCH["hot"] = time.time()
        return {"roots": roots, "files": files, "errs": list(errs or []),
                "elapsed_ms": int((time.perf_counter() - t0) * 1000)}
    except Exception as exc:
        return {"roots": roots, "files": 0, "elapsed_ms": 0, "error": str(exc)}


def _hot_maybe_stale():
    """这次「没搜到」值不值得先给热目录补扫一遍？

    判据不是「索引多久没更新」，而是「上一次补扫距今够不够久」。理由：按
    索引年龄判断有个必然的漏洞——文件恰好在重建之后、搜索之前下载下来，
    那一刻索引是最新的，于是这次搜索会搜不到，然后要等下一个周期。而按
    冷却时间判断，任何一次没搜到都会立刻补扫一次（300ms），只有「连续
    搜同一个不存在的名字」才会被 15 秒冷却挡掉重复劳动。

    manual 档不补扫：用户选「只手动」就是要自己掌握扫盘时机。
    """
    try:
        if _freshness_mode() == "manual":
            return False
        if not _hot_roots():
            return False
        # 热目录特别大的机器（比如下载夹里塞了 20 万个文件）不能在查询里
        # 同步重扫，那会把「搜一下」变成几十秒的卡顿。超过这个规模就交给
        # 后台线程，查询立刻返回空结果 + hint。
        known = 0
        hot = {os.path.normcase(os.path.abspath(p)) for p in _hot_roots()}
        for item in _ix_load():
            root = os.path.normcase(os.path.abspath(item.get("root") or ""))
            if root in hot:
                known = max(known, int(item.get("files") or 0))
        if known > _HOT_INLINE_MAX:
            return False
        # 冷却只针对「上一次因为没搜到而补扫」，不针对后台那次定期刷新。
        # 两者混用一个时间戳会出现这种事：后台刚刷过，用户三秒后下载了文件
        # 再搜，明明该补扫却被冷却挡住，等下一次搜索才命中。分开放就没有
        # 这个窗口，而防抖的效果不变。
        last = float(_INDEX_WATCH.get("miss") or 0)
        return (time.time() - last) >= _HOT_MIN_GAP
    except Exception:
        return False


# 后台校验线程的开关。引擎是单线程 RPC，重建要几十秒，只能放子线程；
# 而 sqlite 连接不能跨线程共享（check_same_thread=True），所以子线程里
# 一律自己 open、自己 close，绝不复用主线程的连接。
_INDEX_WATCH = {"started": False, "stop": False, "last": 0.0, "hot": 0.0,
                "miss": 0.0, "last_report": None, "last_hot": None,
                "busy": False}


def index_watch_tick(force=False):
    """后台校验的一拍：先给热目录保鲜，偶尔再抽查一次全库。

    两件事的节奏差着两个数量级，所以分开计时：
      - 热目录重扫：300ms 级，live 档 60 秒一次、check 档 10 分钟一次。
        这是「刚下载的文件多久能搜到」的答案。
      - 全库抽查：几秒到几十秒，6 小时一次。这是「索引有没有烂掉」的答案。

    没轮到时返回 None。
    """
    if _INDEX_WATCH["busy"]:
        return None
    try:
        if not load_settings().get("index_rebuild_idle", True):
            return None
    except Exception:
        pass
    mode = _freshness_mode()
    if mode == "manual" and not force:
        return None

    now = time.time()
    _INDEX_WATCH["busy"] = True
    try:
        out = {}
        hot_every = _HOT_SECS.get(mode, 600)
        if force or now - _INDEX_WATCH["hot"] >= hot_every:
            rep = hot_refresh()
            _INDEX_WATCH["hot"] = time.time()
            _INDEX_WATCH["last_hot"] = rep
            out["hot"] = rep

        if force or now - _INDEX_WATCH["last"] >= 6 * 3600:
            rep = index_selfcheck(rebuild=True)
            _INDEX_WATCH["last"] = time.time()
            _INDEX_WATCH["last_report"] = rep
            out["selfcheck"] = rep

        return out or None
    except Exception:
        return None
    finally:
        _INDEX_WATCH["busy"] = False


def start_index_watchdog():
    """启动后台校验线程。启动后先等 30 秒再第一次抽查，别和界面抢开机那几秒。

    线程每 30 秒醒一次，具体跑什么由 index_watch_tick 按各自的节奏决定
    （热目录 60 秒 / 全库 6 小时）。醒得比该做的勤不是问题：醒着的那次
    只读两个设置、比一次时间，成本可以忽略。
    """
    if _INDEX_WATCH["started"]:
        return False
    _INDEX_WATCH["started"] = True

    def loop():
        time.sleep(30)
        while not _INDEX_WATCH["stop"]:
            try:
                index_watch_tick()
            except Exception:
                pass
            for _ in range(3):
                if _INDEX_WATCH["stop"]:
                    return
                time.sleep(10)

    threading.Thread(target=loop, name="index-watchdog", daemon=True).start()
    return True



def _ix_query_one(db_path, kw, limit):
    """查单个库，返回 [(完整路径, 名字, 大小, 时间)]。"""
    db = _index_open(db_path)
    if db is None:
        return []
    try:
        if not _index_can_read(db):
            return []
        rows = db.execute(
            "SELECT d.path, f.name, f.size, f.mtime FROM files f "
            "JOIN dirs d ON d.id = f.dir_id "
            "WHERE f.name LIKE ? ESCAPE '\\' LIMIT ?",
            (kw, limit)).fetchall()
        if rows:
            return [(os.path.join(folder, name), name, size, mtime)
                    for folder, name, size, mtime in rows]
        out = []
        for dpath, f0, n in db.execute(
                "SELECT path, f0, n FROM dirs WHERE path LIKE ? ESCAPE '\\' LIMIT 40",
                (kw,)).fetchall():
            if not n:
                continue
            out.extend((dpath, name, size, mtime) for name, size, mtime in db.execute(
                "SELECT name, size, mtime FROM files "
                "WHERE rowid BETWEEN ? AND ? LIMIT ?",
                (f0, f0 + n - 1, limit - len(out))).fetchall())
            if len(out) >= limit:
                break
        return [(os.path.join(folder, name), name, size, mtime)
                for folder, name, size, mtime in out]
    except Exception:
        return []
    finally:
        db.close()


def search_index(keyword, limit=800, ids=None):
    """按文件名查索引：多个库并发查，合并去重后按「前缀命中优先」排序。

    ids 给定时只查这些索引；不给就查全部。返回 (完整路径, 名字, 大小, 时间)，
    路径一定是文件路径，上层直接打开 / 定位 / 复制即可。
    """
    keyword = (keyword or "").strip()
    if not keyword:
        return []
    limit = max(1, int(limit))
    kw = "%" + _like_literal(keyword) + "%"

    items = [i for i in _ix_load()
             if (not ids or i["id"] in set(ids)) and os.path.isfile(_ix_db_abspath(i))]
    if not items:
        return []

    paths = [_ix_db_abspath(i) for i in items]
    results = []
    # SQLite 的 LIKE 扫描跑在 C 里，多线程能真并行；线程数跟库数走，别开太多
    try:
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=min(8, len(paths))) as pool:
            for part in pool.map(lambda p: _ix_query_one(p, kw, limit), paths):
                results.extend(part)
    except Exception:
        for p in paths:
            results.extend(_ix_query_one(p, kw, limit))

    # 同一个文件可能被两个范围都覆盖：按路径去重
    seen = {}
    low_kw = keyword.lower()
    for path, name, size, mtime in results:
        key = os.path.normcase(path)
        if key not in seen:
            seen[key] = (path, name, size, mtime)

    def rank(row):
        name = row[1] or ""
        low = name.lower()
        return (0 if low.startswith(low_kw) else 1,
                0 if low_kw in low else 1,
                len(name),
                -(row[3] or 0))

    merged = sorted(seen.values(), key=rank)
    return merged[:limit]


def _ix_top_one(db_path, limit, min_size):
    """查单个库最大的几个文件，返回 [(完整路径, 名字, 大小, 时间)]。

    files 表本来就有 size 列（建库时一起写进去的），所以「谁最占空间」
    根本不需要重新遍历磁盘 —— 一条 ORDER BY 就够了。
    以前没有这条查询，模型问「什么最占空间」只能去 top_files 现扫，
    整盘 20 秒预算扫不完，于是答「只扫了前 20 秒」。

    索引是快照，磁盘会变：文件被删、被移走之后索引还留着它。所以这里对
    取出来的候选逐个验一下还在不在，不在了就丢掉、继续往后补。刻意多取
    4 倍再截断——只取 limit 条再过滤，一旦前排有几个失效就会少给答案。
    验 80 个路径的 stat 代价可以忽略（微秒级），换来「答案里不会出现
    已经不存在的文件」。
    """
    db = _index_open(db_path)
    if db is None:
        return []
    try:
        if not _index_can_read(db):
            return []
        want = max(1, int(limit))
        rows = db.execute(
            "SELECT d.path, f.name, f.size, f.mtime FROM files f "
            "JOIN dirs d ON d.id = f.dir_id "
            "WHERE f.size >= ? ORDER BY f.size DESC LIMIT ?",
            (int(min_size), want * 4)).fetchall()
    except Exception:
        return []
    finally:
        db.close()
    out = []
    for folder, name, size, mtime in rows:
        full = os.path.join(folder, name)
        if not os.path.exists(full):
            continue
        out.append((full, name, int(size or 0), mtime))
        if len(out) >= want:
            break
    return out


def search_index_top(limit=50, ids=None, min_size=0):
    """按体积取前 N 个文件：多库并发查，合并去重后按大小降序。

    返回 (完整路径, 名字, 大小, 时间)。索引里没有的东西它当然查不到，
    所以调用方要把「覆盖了哪些根目录」一并告诉用户，别让人以为这是整机统计。
    """
    limit = max(1, int(limit))
    min_size = max(0, int(min_size))
    items = [i for i in _ix_load()
             if (not ids or i["id"] in set(ids)) and os.path.isfile(_ix_db_abspath(i))]
    if not items:
        return []
    paths = [_ix_db_abspath(i) for i in items]
    results = []
    try:
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=min(8, len(paths))) as pool:
            for part in pool.map(lambda p: _ix_top_one(p, limit, min_size), paths):
                results.extend(part)
    except Exception:
        for p in paths:
            results.extend(_ix_top_one(p, limit, min_size))
    seen = {}
    for path, name, size, mtime in results:
        key = os.path.normcase(path)
        if key not in seen:
            seen[key] = (path, name, size, mtime)
    merged = sorted(seen.values(), key=lambda r: (-(r[2] or 0), os.path.normcase(r[0])))
    return merged[:limit]


def _folder_key(path, root, depth):
    """把一个目录路径归到「第 depth 层前缀」，用来做体积汇总。

    例：root=E:\\、depth=3 时
      E:\\SteamLibrary\\steamapps\\common\\PUBG\\TslGame  →  E:\\SteamLibrary\\steamapps\\common
    所有落在这个前缀下的目录都会汇总成同一项，于是得到的就是「common 这个目录多大」。

    刻意不用 os.path.relpath：它对 11 万个目录要解析、normpath、split 一堆，
    实测占掉大半个查询时间。这里做纯字符串切片就够，两边都是同一份索引里的
    规范路径。
    """
    if not root:
        return path
    r = root.rstrip("\\/")
    if len(path) <= len(r) or not path[:len(r)].lower() == r.lower():
        return path
    rest = path[len(r):].lstrip("\\/")
    if not rest:
        return r
    parts = rest.split("\\") if "\\" in rest else rest.split("/")
    parts = [p for p in parts if p and p != "."]
    if not parts:
        return r
    return r + "\\" + "\\".join(parts[:depth])


def _ix_folders_one(db_path, root, depth):
    """单个库里按目录前缀汇总体积，返回 {前缀: [字节, 文件数]}。

    为什么按目录而不按文件：人问「什么最占空间」想知道的是「哪个文件夹 / 哪个
    软件」，不是「哪个 .pak」。单个 pak 5.4 GB 对人没有意义，PUBG 占 60 GB 才有。

    schema 3 起 dirs 自带 size_sum / n_files，直接扫一遍 3.9 万行目录就行
    （实测 32 ms）。旧库（schema 2）没有这两列，回退 JOIN files 聚合
    （实测 536 ms）——慢 16 倍但答案一样，不值得为它逼用户重建索引。

    刻意**不**给 files 建索引：实测 files(size)、files(dir_id) 对这两个查询
    都没帮助（671→639→696 ms，全在噪声里），聚合本来就要扫完 files 每一行。
    """
    db = _index_open(db_path)
    if db is None:
        return {}
    try:
        if not _index_can_read(db):
            return {}
        if _index_has_totals(db):
            # n_files > 0 必须留着：schema 2 的 JOIN files 天然排除了空目录，
            # 直接读 dirs 会把空目录也带出来（实测 3.9 万目录里多出 9392 个），
            # 于是「下钻 Root」会多出一行体积为 0 的 Root 自己。
            rows = db.execute(
                "SELECT path, size_sum, n_files FROM dirs WHERE n_files > 0"
            ).fetchall()
        else:
            rows = db.execute(
                "SELECT d.path, SUM(f.size), COUNT(*) FROM files f "
                "JOIN dirs d ON d.id = f.dir_id GROUP BY d.id").fetchall()
    except Exception:
        return {}
    finally:
        db.close()
    out = {}
    for dir_path, size, files in rows:
        key = _folder_key(dir_path, root, depth)
        slot = out.get(key)
        if slot is None:
            slot = out[key] = [0, 0]
        slot[0] += int(size or 0)
        slot[1] += int(files or 0)
    return out


def search_index_folders(depth=3, limit=20, min_size=0, ids=None, parent=None):
    """按目录汇总体积，多库合并后降序返回 (目录路径, 字节, 文件数) 与总计。

    parent 给了就只汇总它下面的子目录（用来下钻：先看 common 多大，再看
    common 里哪个游戏最大）。
    """
    depth = max(1, min(int(depth), 6))
    limit = max(1, int(limit))
    min_size = max(0, int(min_size))
    want = set(ids) if ids else None
    items = [i for i in _ix_load()
             if (not want or i["id"] in want) and os.path.isfile(_ix_db_abspath(i))]
    merged = {}
    for it in items:
        one = _ix_folders_one(_ix_db_abspath(it), it["root"], depth)
        for key, (size, files) in one.items():
            slot = merged.get(os.path.normcase(key))
            if slot is None:
                slot = merged[os.path.normcase(key)] = [key, 0, 0]
            slot[1] += size
            slot[2] += files
    total = sum(v[1] for v in merged.values())
    rows = []
    pkey = os.path.normcase(parent.rstrip("\\/")) if parent else ""
    for key, size, files in merged.values():
        if size < min_size:
            continue
        if pkey:
            nk = os.path.normcase(key)
            if nk != pkey and not nk.startswith(pkey + os.sep):
                continue
        rows.append((key, size, files))
    rows.sort(key=lambda r: (-r[1], os.path.normcase(r[0])))
    return rows[:limit], total


def _fmt_age(sec):
    """把秒数说成人话：「12 分钟前」「3 小时前」「2 天前」。"""
    sec = max(0, int(sec))
    if sec < 60:
        return "刚刚"
    if sec < 3600:
        return "%d 分钟前" % (sec // 60)
    if sec < 86400:
        return "%d 小时前" % (sec // 3600)
    return "%d 天前" % (sec // 86400)


def index_age():
    """这份索引有多旧：返回 {age_sec, age_text, built_at, stale}。

    为什么要主动报年龄：索引是快照，答「什么最占空间」用的可能是半小时前
    的账本。旧不是错——CDN 的 Cache-Control、DNS 的 TTL 都允许旧数据存在，
    前提是**说出来**。让用户自己判断「这个答案可信到哪一步」，比假装实时
    然后被现实打脸要好。

    stale 的阈值取 10 分钟：短于它的过期数据对「哪个文件夹大」这类问题没有
    实质影响（体积变化的尺度是天/周），长于它才值得提醒。
    """
    items = _ix_load()
    if not items:
        return {"age_sec": 0, "age_text": "", "built_at": 0, "stale": False}
    built = max(int(i.get("built_at") or 0) for i in items)
    if not built:
        return {"age_sec": 0, "age_text": "", "built_at": 0, "stale": False}
    age = max(0, int(time.time()) - built)
    return {"age_sec": age, "age_text": _fmt_age(age),
            "built_at": built, "stale": age > 600}


def _engine_search_folders(params):
    """search.folders：按目录汇总体积，回答「什么最占空间」。

    和 search.top 的区别是聚合维度：search.top 给单个文件，人对「某个 .pak 5.4 GB」
    没有概念；这里按目录前缀汇总，得到的是「PUBG 这个目录 60 GB」，才是人能据此
    行动的信息。

    auto=True（默认）时，如果本地还没有索引，就当场建一次再回答 —— 用户不该为了
    问一句「什么最占空间」先自己理解「索引」这个概念。建索引要几秒，所以返回里带
    built 标记，前端据此提示。
    """
    depth = _engine_get(params, "depth", 3, int)
    if depth <= 0:
        raise EngineError("参数 depth 必须是正整数")
    limit = _engine_get(params, "limit", 20, int)
    if limit <= 0:
        raise EngineError("参数 limit 必须是正整数")
    limit = min(limit, 500)
    min_size = _engine_get(params, "min_size", 0, int)
    parent = params.get("parent")
    parent = str(parent).strip() if isinstance(parent, str) and parent.strip() else None
    auto = _engine_get(params, "auto", True, bool)
    ids = params.get("ids")
    ids = [str(i) for i in ids] if isinstance(ids, list) and ids else None

    t0 = time.perf_counter()
    built = False
    build_error = ""

    # 没索引就自己建一次：整盘（D:/E:）+ 常用用户目录，建完才算「整机统计」
    if auto and not ids and index_count() == 0:
        roots = full_disk_roots() + default_index_roots()
        seen, uniq = set(), []
        for r in roots:
            k = os.path.normcase(os.path.abspath(r))
            if k not in seen:
                seen.add(k)
                uniq.append(r)
        try:
            if uniq:
                index_add(uniq)
                build_index(roots=uniq, progress=_engine_progress)
                built = True
        except Exception as exc:
            build_error = "自动建索引失败：%s" % (exc,)

    rows, total = search_index_folders(depth=depth, limit=limit, min_size=min_size,
                                       ids=ids, parent=parent)
    st = index_stats()
    roots = [e.get("root") for e in st.get("entries") or [] if e.get("exists_root")]
    items = []
    for path, size, files in rows:
        items.append({
            "path": path,
            "name": os.path.basename(path.rstrip("\\/")) or path,
            "size": int(size),
            "files": int(files),
            # 占比让「60 GB 有多大」变得可比较，光给绝对数字人没尺度感
            "pct": round((size * 100.0 / total), 1) if total else 0.0,
        })
    result = {"items": items, "total": len(items), "source": "index",
              "roots": roots, "indexed": int(st.get("files") or 0),
              "depth": depth, "bytes": int(total), "built": built,
              "elapsed_ms": int((time.perf_counter() - t0) * 1000)}
    # 数据年龄一并交给上层：模型和 UI 都该知道这份答案是哪一刻的账本
    result.update(index_age())
    if build_error:
        result["error"] = build_error
    if not roots:
        result["hint"] = "本地还没有索引：先在「搜索」页添加目录并建立一次，之后这里就能直接按体积排"
    return result


def index_count():
    return sum(int(i.get("files") or 0) for i in _ix_load())


def index_stats():
    """索引总览：每条索引的体积 / 覆盖 / 状态，外加合计。"""
    items = _ix_load()
    entries = []
    total_files = 0
    total_dirs = 0
    total_bytes = 0
    latest = 0
    for it in items:
        path = _ix_db_abspath(it)
        exists_db = os.path.isfile(path)
        size_bytes = 0
        if exists_db:
            try:
                size_bytes = os.path.getsize(path)
            except OSError:
                size_bytes = 0
        else:
            # 库文件被删了：条目还在，标成待重建
            it["files"] = 0
            it["dirs"] = 0
            it["bytes"] = 0
        entry = dict(it)
        entry.update({
            "path": path,
            "exists": exists_db,
            "exists_root": os.path.isdir(it["root"]),
            "size_bytes": int(size_bytes),
        })
        entries.append(entry)
        total_files += int(it.get("files") or 0)
        total_dirs += int(it.get("dirs") or 0)
        total_bytes += int(entry["size_bytes"])
        latest = max(latest, int(it.get("built_at") or 0))

    out = {
        "backend": "本地索引",
        "entries": entries,
        "count": len(entries),
        "files": total_files,
        "dirs": total_dirs,
        "size_bytes": total_bytes,
        "built_at": latest,
        "schema": INDEX_SCHEMA,
        "dir": index_dir(),
    }
    out.update(_index_last_run)
    return out


def default_index_roots():
    """默认只索引几个用户目录——快、索引小。整盘索引是显式选项。

    加入 Pictures / Videos：用户最常见的「搜我的图片/视频」就落在这两个目录，
    只索引文稿类目录会让人以为搜索坏了。
    """
    roots = []
    home = os.environ.get("USERPROFILE", "")
    for sub in ("Desktop", "Documents", "Downloads", "Pictures", "Videos"):
        p = os.path.join(home, sub) if home else ""
        if p and os.path.isdir(p):
            roots.append(p)
    return roots



def full_disk_roots():
    """整盘索引：D / E。文件多、索引大，作为可选项。"""
    return [d for d in ("D:\\", "E:\\") if os.path.isdir(d)]


def find_everything():
    cand = [S.get("everything_path") or ""]
    for base in (os.environ.get("ProgramFiles"), os.environ.get("ProgramFiles(x86)"),
                 "D:\\App", "D:\\Tool", "E:\\APP"):
        if base:
            cand.append(os.path.join(base, "Everything", "Everything.exe"))
    for p in cand:
        if p and os.path.isfile(p):
            return p
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,
                            r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Everything",
                            0, winreg.KEY_READ) as k:
            loc = winreg.QueryValueEx(k, "InstallLocation")[0]
            p = os.path.join(loc, "Everything.exe")
            if os.path.isfile(p):
                return p
    except OSError:
        pass
    return ""


def open_everything_search(keyword):
    exe = find_everything()
    if not exe:
        return False
    try:
        subprocess.Popen([exe, "-search", keyword])
        return True
    except Exception:
        return False


def find_es():
    """Everything 的命令行版 es.exe（如果装了）"""
    cand = []
    ev = find_everything()
    if ev:
        cand.append(os.path.join(os.path.dirname(ev), "es.exe"))
    if S.get("es_path"):
        cand.append(S["es_path"])
    for p in cand:
        if p and os.path.isfile(p):
            return p
    try:
        import shutil as _sh
        p = _sh.which("es.exe")
        if p:
            return p
    except Exception:
        pass
    return ""


def es_search(keyword, limit=800):
    """用 es.exe 直接取 Everything 结果。返回列表或 None（不可用）"""
    exe = find_es()
    if not exe:
        return None
    try:
        r = subprocess.run([exe, "-n", str(limit), keyword],
                           capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=20,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if r.returncode != 0:
            return None
        rows = []
        for line in (r.stdout or "").splitlines():
            p = line.strip()
            if not p or not os.path.isabs(p):
                continue
            try:
                st = os.stat(p)
                rows.append((p, os.path.basename(p), st.st_size, st.st_mtime))
            except OSError:
                rows.append((p, os.path.basename(p), 0, 0))
        return rows
    except Exception:
        return None


# ─────────────────────────── 资源管理器右键菜单 ───────────────────────────

MENU_KEYS = [
    (r"Software\Classes\Directory\shell\整理助手", '"%1"'),
    (r"Software\Classes\Directory\Background\shell\整理助手", '"%V"'),
    (r"Software\Classes\Drive\shell\整理助手", '"%1"'),
]


def _reg_write(root, path, name, value):
    import winreg
    with winreg.CreateKeyEx(root, path, 0, winreg.KEY_WRITE) as k:
        winreg.SetValueEx(k, name, 0, winreg.REG_SZ, value)


def _reg_delete_tree(root, path):
    import winreg

    def walk(h, p):
        try:
            with winreg.OpenKey(h, p, 0, winreg.KEY_READ) as k:
                kids = []
                for i in range(winreg.QueryInfoKey(k)[0]):
                    try:
                        kids.append(winreg.EnumKey(k, i))
                    except OSError:
                        pass
        except OSError:
            return True
        for kid in kids:
            walk(h, p + "\\" + kid)
        try:
            winreg.DeleteKey(h, p)
            return True
        except OSError:
            return False

    return walk(root, path)


def explorer_menu_installed():
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, MENU_KEYS[0][0], 0, winreg.KEY_READ):
            return True
    except OSError:
        return False


def _console_free_exe():
    """返回一个启动时不会弹黑窗口的解释器/程序路径。

    - 已打包：sys.executable 就是 GUI 子系统的 exe，天然无控制台
    - 源码运行：python.exe 是控制台程序，会顶着黑窗口；优先换成同目录的 pythonw.exe
    """
    exe = sys.executable
    if not getattr(sys, "frozen", False):
        d, n = os.path.split(exe)
        if n.lower() in ("python.exe", "python_d.exe"):
            for cand in ("pythonw.exe", "pythonw_d.exe"):
                p = os.path.join(d, cand)
                if os.path.exists(p):
                    return p
    return exe


def _task_runner():
    """计划任务用的命令前缀（带引号）。

    打包后是 exe 本身；源码模式必须带上脚本路径，否则
    `pythonw.exe --clean-shots` 找不到脚本，返回码 2。
    """
    exe = _console_free_exe()
    if getattr(sys, "frozen", False):
        return '"%s"' % exe
    # 用本文件的真实路径，不能用 sys.argv[0]（被 import 时会指向调用方）
    script = os.path.abspath(__file__)
    return '"%s" "%s"' % (exe, script)


def install_explorer_menu():
    """只写 HKCU，不需要管理员；移除时能干净删掉"""
    import winreg
    runner = _console_free_exe()
    if getattr(sys, "frozen", False):
        cmd_prefix = f'"{runner}"'
        icon = f'"{runner}",0'
    else:
        # 源码模式：用 pythonw + 脚本，避免弹出黑色终端窗口
        cmd_prefix = f'"{runner}" "{os.path.abspath(__file__)}"'
        icon = f'"{runner}",0'
    for path, arg in MENU_KEYS:
        try:
            _reg_write(winreg.HKEY_CURRENT_USER, path, "", "用整理助手整理")
            _reg_write(winreg.HKEY_CURRENT_USER, path, "Icon", icon)
            _reg_write(winreg.HKEY_CURRENT_USER, path + r"\command", "",
                       f"{cmd_prefix} --gui {arg}")
        except OSError as ex:
            return False, f"{path}: {ex}"
    return True, "已添加资源管理器右键菜单"


def remove_explorer_menu():
    import winreg
    ok = True
    for path, _ in MENU_KEYS:
        if not _reg_delete_tree(winreg.HKEY_CURRENT_USER, path):
            ok = False
    return ok, "已移除右键菜单" if ok else "部分项删除失败"


# ─────────────────────────── 定时静默运行 ───────────────────────────

def run_scheduled(targets):
    """由 Windows 计划任务调用：无窗口、无交互，结果写日志。"""
    rules = load_rules()
    logdir = log_dir()
    os.makedirs(logdir, exist_ok=True)
    logp = os.path.join(logdir, f"scan_{datetime.datetime.now():%Y%m%d}.log")

    lines, total = [], 0
    for t in targets:
        if not os.path.isdir(t):
            lines.append(f"{datetime.datetime.now():%H:%M:%S} 跳过（不存在）: {t}")
            continue
        try:
            plans, blocked = scan_tree(t, rules)
            plans = [p for p in plans if p.by_cat]
            if plans:
                n, failed, _ = apply(plans, t, rules)
                total += n
                lines.append(f"{datetime.datetime.now():%H:%M:%S} {t}: 移动 {n} 个"
                             + (f"，失败 {len(failed)}" if failed else ""))
            else:
                lines.append(f"{datetime.datetime.now():%H:%M:%S} {t}: 无可整理文件"
                             f"（跳过 {len(blocked)} 个位置）")
        except Exception as ex:
            lines.append(f"{datetime.datetime.now():%H:%M:%S} {t}: 出错 {ex}")

    with open(logp, "a", encoding="utf-8-sig") as f:
        f.write("\n".join(lines) + "\n")
    return total, logp


# ─────────────────────────── 界面 ───────────────────────────

def prefill_dir(args):
    """命令行里给的第一个已存在目录（右键菜单会带上）。"""
    for a in args:
        if a and not a.startswith("--") and os.path.isdir(a):
            return a
    return None


def _ask_close_action(master):
    """问一次「点关闭按钮时怎么办」，返回 (choice, remember)。

    choice 是 "tray" 或 "exit"。按 Esc / 直接关掉这个窗，一律按「最小化到托盘」处理 ——
    误关一个询问窗，最坏是程序还留在后台；反过来就会把正在跑的任务连根拔掉。
    """
    import tkinter as tk
    from tkinter import ttk

    res = {"choice": "tray", "remember": True}
    w = tk.Toplevel(master)
    w.title("关闭方式")
    w.resizable(False, False)
    try:
        w.transient(master)
        w.attributes("-topmost", True)
    except Exception:
        pass

    body = ttk.Frame(w, padding=18)
    body.pack(fill="both", expand=True)
    ttk.Label(body, text="点关闭按钮时，希望怎么处理？",
              font=("Microsoft YaHei UI", 10, "bold")).pack(anchor="w")
    ttk.Label(body, foreground="#6b7280", justify="left",
              text="最小化到托盘：窗口消失，程序继续在后台跑，"
                   "托盘图标右键可以再打开或退出。\n"
                   "直接退出：结束程序，托盘图标一起消失。"
              ).pack(anchor="w", pady=(6, 12))

    remember = tk.BooleanVar(value=True)
    ttk.Checkbutton(body, text="记住我的选择（以后不再问，可在「设置」里改）",
                    variable=remember).pack(anchor="w", pady=(0, 14))

    row = ttk.Frame(body)
    row.pack(fill="x")

    def pick(choice):
        res["choice"] = choice
        res["remember"] = bool(remember.get())
        try:
            w.grab_release()
        except Exception:
            pass
        try:
            w.destroy()
        except Exception:
            pass

    btn_tray = ttk.Button(row, text="最小化到托盘",
                          command=lambda: pick("tray"))
    btn_tray.pack(side="left")
    ttk.Button(row, text="直接退出",
               command=lambda: pick("exit")).pack(side="left", padx=8)

    w.protocol("WM_DELETE_WINDOW", lambda: pick("tray"))
    w.bind("<Escape>", lambda e: pick("tray"))
    # 回车走安全的那个（托盘）：直接退出是不可逆的，不该是默认动作
    w.bind("<Return>", lambda e: pick("tray"))
    w.update_idletasks()
    # 居中到主窗
    try:
        px, py = master.winfo_rootx(), master.winfo_rooty()
        pw, ph = master.winfo_width(), master.winfo_height()
        ww, wh = w.winfo_width(), w.winfo_height()
        w.geometry("+%d+%d" % (px + max(0, (pw - ww) // 2),
                               py + max(0, (ph - wh) // 3)))
    except Exception:
        pass
    try:
        w.grab_set()
        w.focus_force()
        btn_tray.focus_set()
    except Exception:
        pass
    w.wait_window()
    return res["choice"], res["remember"]


def run_gui(prefill=None, tray_only=False):
    import tkinter as tk
    from tkinter import ttk, filedialog, messagebox, simpledialog

    rules = load_rules()
    state = {"plans": None, "blocked": [], "monitor_job": None, "monitoring": False,
             "rows": {}, "groups": {}}

    root = tk.Tk()
    root.title("整理助手")
    root.geometry("1100x760")
    root.minsize(920, 640)
    if tray_only:
        # 自启动：界面构造要几百毫秒，等到底再收会先闪一下窗口
        root.withdraw()

    try:
        ttk.Style().theme_use("vista")
    except tk.TclError:
        pass

    # ── 统一控件样式：标签页更宽松，表格表头更清楚 ──
    style = ttk.Style()
    FONT_UI = ("Microsoft YaHei UI", 9)
    SEL_BG, SEL_FG = "#dbe7fb", "#12314f"
    try:
        style.configure("TNotebook", background="#ffffff", borderwidth=0)
        style.configure("TNotebook.Tab", padding=(16, 7), font=FONT_UI)
        style.map("TNotebook.Tab",
                  background=[("selected", "#ffffff"), ("!selected", "#eceef1")],
                  foreground=[("selected", "#111827"), ("!selected", "#6b7280")])
        style.configure("Treeview", font=FONT_UI, rowheight=30,
                        background="#ffffff", fieldbackground="#ffffff",
                        foreground="#1f2933")
        # 选中行：浅蓝底 + 深色字，不再用系统那层深蓝
        style.map("Treeview",
                  background=[("selected", SEL_BG)],
                  foreground=[("selected", SEL_FG)])
        style.configure("Treeview.Heading", font=("Microsoft YaHei UI", 9, "bold"),
                        foreground="#374151", padding=(6, 5),
                        background="#f7f8fa", relief="flat")
        style.map("Treeview.Heading", background=[("active", "#eef2f8")])
        style.configure("TButton", font=FONT_UI, padding=(10, 4))
        style.configure("Accent.TButton", font=FONT_UI, padding=(12, 5))
        style.configure("TLabel", font=FONT_UI)
        style.configure("Hint.TLabel", foreground="#8b9199", font=FONT_UI)
        style.configure("Sep.TFrame", background="#e8eaee")
        style.configure("Card.TFrame", background="#ffffff")
        style.configure("TPanedwindow", background="#e8eaee")
    except tk.TclError:
        pass

    # ── 左侧导航 + 右侧内容区 ──
    NAV_BG, NAV_ACTIVE, NAV_HOVER = "#f5f6f8", "#e7f0fe", "#edeff2"
    UI_FONT = ("Microsoft YaHei UI", 9)
    shell = ttk.Frame(root)
    shell.pack(fill="both", expand=True)

    nav = tk.Frame(shell, width=178, bg=NAV_BG, highlightthickness=0)
    nav.pack(side="left", fill="y")
    nav.pack_propagate(False)

    body = ttk.Frame(shell)
    body.pack(side="left", fill="both", expand=True)
    body.grid_rowconfigure(0, weight=1)
    body.grid_columnconfigure(0, weight=1)

    # ══════════ 底部进度条（连接所有耗时操作）══════════
    ACCENT = "#2f6fdd"
    ACCENT_LT = "#7aa6f0"
    TRACK_BG = "#e9ecf1"

    class SmoothBar(tk.Canvas):
        """圆角、缓动、无闪烁的细进度条。

        - 不确定进度：一段柔光从左到右往复滑动（正弦缓动，两端减速）
        - 确定进度：目标值用指数缓动逼近，不会一格一格跳
        - 完成：走到 100% 后颜色淡出、整条收回
        """

        def __init__(self, master, **kw):
            kw.setdefault("height", 6)
            kw.setdefault("bg", "#ffffff")
            kw.setdefault("highlightthickness", 0)
            kw.setdefault("bd", 0)
            super().__init__(master, **kw)
            self._ratio = 0.0          # 实际绘制值
            self._target = 0.0
            self._indet = False
            self._phase = 0.0
            self._alpha = 0.0          # 0..1 淡入淡出
            self._fade_dir = 0
            self._job = None
            self._cw = 1
            self.bind("<Configure>", self._on_resize)

        def _on_resize(self, e):
            self._cw = max(1, e.width)
            self._draw()

        # ── 对外接口 ──
        def begin_indet(self):
            self._indet = True
            self._target = 0.0
            self._fade_dir = 1
            self._start()

        def set_ratio(self, r):
            self._indet = False
            self._target = max(0.0, min(1.0, float(r)))
            self._fade_dir = 1
            self._start()

        def finish(self):
            self._indet = False
            self._target = 1.0
            self._fade_dir = -1
            self._start()

        def reset(self):
            self._indet = False
            self._target = 0.0
            self._ratio = 0.0
            self._alpha = 0.0
            self._fade_dir = 0
            self._draw()

        def _start(self):
            if self._job is None:
                self._tick()

        def _tick(self):
            self._job = None
            alive = False
            # 淡入淡出
            if self._fade_dir > 0 and self._alpha < 1.0:
                self._alpha = min(1.0, self._alpha + 0.14)
                alive = True
            elif self._fade_dir < 0 and self._alpha > 0.0:
                self._alpha = max(0.0, self._alpha - 0.10)
                alive = True
                if self._alpha <= 0.0:
                    self._fade_dir = 0
            # 值缓动
            if self._indet:
                self._phase = (self._phase + 0.016) % 1.0
                alive = True
            else:
                d = self._target - self._ratio
                if abs(d) > 0.0015:
                    self._ratio += d * 0.18
                    alive = True
                else:
                    self._ratio = self._target
            self._draw()
            if alive:
                self._job = self.after(16, self._tick)

        def _draw(self):
            self.delete("all")
            w = self._cw
            h = int(self.cget("height"))
            if w < 4 or self._alpha <= 0.01:
                return
            def mix(c1, c2, t):
                a = tuple(int(c1[i:i + 2], 16) for i in (1, 3, 5))
                b = tuple(int(c2[i:i + 2], 16) for i in (1, 3, 5))
                return "#%02x%02x%02x" % tuple(
                    int(a[k] + (b[k] - a[k]) * t) for k in range(3))
            r = h / 2.0
            # 轨道
            self.create_line(r, r, w - r, r, fill=mix("#ffffff", TRACK_BG, self._alpha),
                             width=h, capstyle="round")
            if self._indet:
                seg = max(0.14, 90.0 / w)
                p = self._phase
                # 两端减速：sin 的 0..pi 映射，再整体往复
                sweep = 0.5 - 0.5 * math.cos(p * 2 * math.pi)
                x0 = int((w * (1 - seg)) * sweep)
                x1 = x0 + int(w * seg)
                self.create_line(max(r, x0 + r), r, min(w - r, x1 - r), r,
                                 fill=mix("#ffffff", ACCENT_LT, self._alpha),
                                 width=h, capstyle="round")
                mid = (x0 + x1) / 2.0
                self.create_line(max(r, x0 + r), r, min(w - r, mid), r,
                                 fill=mix("#ffffff", ACCENT, self._alpha),
                                 width=h, capstyle="round")
            else:
                fw = int(w * self._ratio)
                if fw > h:
                    self.create_line(r, r, fw - r, r,
                                     fill=mix("#ffffff", ACCENT, self._alpha),
                                     width=h, capstyle="round")
                    # 前沿柔光
                    if 0 < self._ratio < 0.995:
                        self.create_line(max(r, fw - r - 10), r, fw - r, r,
                                         fill=mix("#ffffff", ACCENT_LT, self._alpha),
                                         width=h, capstyle="round")

    status = tk.Frame(root, bg="#ffffff", height=34)
    status.pack(side="bottom", fill="x")
    status.pack_propagate(False)
    stat_lbl = tk.Label(status, text="就绪", bg="#ffffff", fg="#8b9199",
                        anchor="w", font=("Microsoft YaHei UI", 8))
    stat_lbl.pack(side="left", padx=(16, 6))
    stat_pct = tk.Label(status, text="", bg="#ffffff", fg=ACCENT,
                        anchor="e", font=("Microsoft YaHei UI", 8))
    stat_pct.pack(side="right", padx=(6, 16))
    bar_holder = tk.Frame(root, bg="#ffffff", height=8)
    bar_holder.pack(side="bottom", fill="x")
    bar_holder.pack_propagate(False)
    pbar = SmoothBar(bar_holder, height=6)
    pbar.pack(fill="x", padx=16, pady=1)

    def prog_begin(msg):
        stat_lbl.configure(text=msg, fg="#5b6472")
        stat_pct.configure(text="")
        pbar.begin_indet()

    def prog_set(ratio, msg=""):
        pbar.set_ratio(ratio)
        if msg:
            stat_lbl.configure(text=msg, fg="#5b6472")
        stat_pct.configure(text=("%d%%" % int(ratio * 100)) if ratio > 0.01 else "")

    def prog_done(msg="完成"):
        pbar.finish()
        stat_lbl.configure(text=msg, fg="#1f8a4c")
        stat_pct.configure(text="")
        root.after(900, lambda: (pbar.reset(),
                                 stat_lbl.configure(text="就绪", fg="#8b9199")))

    def prog_fail(msg):
        pbar.reset()
        stat_lbl.configure(text=msg, fg="#c2413a")

    _busy = {"n": 0}

    def run_task(label, work, on_done=None, on_error=None, min_ms=450):
        """把 work(report) 丢到线程跑，主线程动画不受影响。

        report(done, total, msg)：total=0 表示不确定进度。
        """
        _busy["n"] += 1
        t0 = time.time()
        prog_begin(label)
        q = queue.Queue()

        def report(done=0, total=0, msg=""):
            q.put(("p", done, total, msg))

        def runner():
            try:
                res = work(report)
                q.put(("ok", res))
            except Exception as ex:      # noqa: BLE001
                import traceback
                q.put(("err", "%s\n%s" % (ex, traceback.format_exc(limit=3))))

        def poll():
            try:
                while True:
                    m = q.get_nowait()
                    if m[0] == "p":
                        _, done, total, msg = m
                        if total > 1:
                            prog_set(min(0.99, done / float(total)), msg)
                    elif m[0] == "ok":
                        wait = max(0, min_ms - int((time.time() - t0) * 1000))
                        root.after(wait, lambda: _finish_ok(m[1]))
                        return
                    else:
                        _busy["n"] -= 1
                        prog_fail("出错了：%s" % str(m[1]).splitlines()[0][:60])
                        if on_error:
                            on_error(m[1])
                        return
            except queue.Empty:
                pass
            root.after(30, poll)

        def _finish_ok(res):
            _busy["n"] -= 1
            prog_done()
            if on_done:
                try:
                    on_done(res)
                except Exception as ex:  # noqa: BLE001
                    log("[界面] 渲染失败：%s" % ex)

        threading.Thread(target=runner, daemon=True).start()
        root.after(60, poll)

    pages, nav_rows = {}, {}

    # ── 矢量图标系统（重写，旧的绘图分支已全部移除）──
    # 每个图标是一组基本图元，坐标固定在 18x18 的画布空间里，
    # 渲染时按 size/18 缩放，所以同一套定义可以画 16/18/20/24 像素，
    # 也能在悬停时平滑插值颜色做动效。
    _ICON_PATHS = {
        # 文件夹
        "tidy": [
            ("poly", [2.6, 6.2, 6.6, 6.2, 8.3, 8.1, 15.4, 8.1,
                      15.4, 14.4, 2.6, 14.4], 1.6, True),
        ],
        # 相机（清理截图）
        "shots": [
            ("rect", 1.8, 5.3, 16.2, 14.6, 1.5),
            ("poly", [6.3, 5.3, 6.9, 3.4, 11.1, 3.4, 11.7, 5.3], 1.5, False),
            ("oval", 6.5, 7.5, 11.5, 12.5, 1.5),
        ],
        # 层叠圆柱（缓存）
        "cache": [
            ("oval", 2.6, 3.6, 15.4, 7.4, 1.4),
            ("line", 2.6, 5.5, 2.6, 12.5, 1.4),
            ("line", 15.4, 5.5, 15.4, 12.5, 1.4),
            ("oval", 2.6, 8.6, 15.4, 12.4, 1.4),
            ("oval", 2.6, 11.2, 15.4, 15.0, 1.4),
        ],
        # 文档 + 折角（高级规则）
        "rules": [
            ("poly", [4.2, 2.2, 11.6, 2.2, 14.2, 4.8, 14.2, 15.8, 4.2, 15.8],
             1.5, True),
            ("poly", [11.6, 2.2, 11.6, 4.8, 14.2, 4.8], 1.5, False),
            ("line", 6.2, 8.8, 12.2, 8.8, 1.3),
            ("line", 6.2, 11.6, 10.6, 11.6, 1.3),
        ],
        # 垃圾桶（卸载）
        "uninstall": [
            ("line", 2.8, 4.8, 15.2, 4.8, 1.5),
            ("line", 6.9, 2.4, 11.1, 2.4, 1.5),
            ("poly", [4.8, 4.8, 5.5, 15.4, 12.5, 15.4, 13.2, 4.8], 1.5, False),
            ("line", 7.6, 7.4, 7.6, 12.8, 1.2),
            ("line", 10.4, 7.4, 10.4, 12.8, 1.2),
        ],
        # 放大镜（搜索）
        "search": [
            ("oval", 2.6, 2.2, 12.0, 11.6, 1.6),
            ("line", 11.2, 10.8, 15.4, 15.2, 1.8),
        ],
        # 齿轮（设置）
        "settings": [
            ("oval", 3.4, 3.4, 14.6, 14.6, 1.5),
            ("oval", 6.9, 6.9, 11.1, 11.1, 1.3),
            ("line", 9.0, 0.8, 9.0, 3.4, 1.6),
            ("line", 9.0, 14.6, 9.0, 17.2, 1.6),
            ("line", 0.8, 9.0, 3.4, 9.0, 1.6),
            ("line", 14.6, 9.0, 17.2, 9.0, 1.6),
        ],
        # 回转箭头（撤销）
        "undo": [
            ("arc", 3.4, 4.4, 15.0, 15.0, 20, 300, 1.6),
            ("poly", [3.4, 2.6, 3.4, 7.6, 8.2, 7.6], 1.6, False),
        ],
        # 下行箭头 + 托盘（导出）
        "export": [
            ("line", 9.0, 2.4, 9.0, 11.4, 1.6),
            ("poly", [5.6, 8.2, 9.0, 11.8, 12.4, 8.2], 1.6, False),
            ("poly", [2.8, 12.6, 2.8, 15.4, 15.2, 15.4, 15.2, 12.6], 1.6, False),
        ],
        # 时钟（自动任务）
        "clock": [
            ("oval", 2.2, 2.2, 15.8, 15.8, 1.5),
            ("line", 9.0, 5.2, 9.0, 9.2, 1.6),
            ("line", 9.0, 9.2, 12.4, 11.0, 1.6),
        ],
        # 滑杆（选项）
        "sliders": [
            ("line", 2.2, 5.2, 15.8, 5.2, 1.3),
            ("line", 2.2, 9.0, 15.8, 9.0, 1.3),
            ("line", 2.2, 12.8, 15.8, 12.8, 1.3),
            ("dot", 6.4, 5.2, 1.9),
            ("dot", 11.6, 9.0, 1.9),
            ("dot", 7.6, 12.8, 1.9),
        ],
        # 向下箭头（全部展开）
        "expand": [
            ("line", 3.6, 2.8, 14.4, 2.8, 1.4),
            ("poly", [4.6, 7.2, 9.0, 12.4, 13.4, 7.2], 1.8, False),
        ],
        # 向上箭头（全部折叠）
        "collapse": [
            ("line", 3.6, 15.2, 14.4, 15.2, 1.4),
            ("poly", [4.6, 10.8, 9.0, 5.6, 13.4, 10.8], 1.8, False),
        ],
        # 眼睛（预览）
        "preview": [
            ("poly", [1.8, 9.0, 5.8, 4.8, 12.2, 4.8, 16.2, 9.0,
                      12.2, 13.2, 5.8, 13.2], 1.4, True),
            ("dot", 9.0, 9.0, 2.2),
        ],
        # 刷新
        "refresh": [
            ("arc", 3.2, 3.2, 14.8, 14.8, 40, 280, 1.6),
            ("poly", [13.2, 1.8, 15.4, 5.0, 11.6, 5.6], 1.6, False),
        ],
        # 文件夹（小，列表用）
        "folder": [
            ("poly", [2.4, 5.6, 6.4, 5.6, 8.0, 7.6, 15.6, 7.6,
                      15.6, 14.8, 2.4, 14.8], 1.5, True),
        ],
        # 文档（小，列表用）
        "file": [
            ("poly", [4.4, 2.0, 11.4, 2.0, 13.8, 4.4, 13.8, 16.0, 4.4, 16.0],
             1.5, True),
            ("poly", [11.4, 2.0, 11.4, 4.4, 13.8, 4.4], 1.5, False),
        ],
    }

    def _icon_draw(cv, kind, color, size, bg):
        cv.delete("all")
        prims = _ICON_PATHS.get(kind)
        if not prims:
            return
        k = size / 18.0
        for p in prims:
            t = p[0]
            if t == "line":
                x1, y1, x2, y2, w = p[1:]
                cv.create_line(x1 * k, y1 * k, x2 * k, y2 * k,
                               fill=color, width=w, capstyle="round")
            elif t == "poly":
                pts, w, close = p[1:]
                xy = []
                for i in range(0, len(pts), 2):
                    xy += [pts[i] * k, pts[i + 1] * k]
                if close and len(xy) >= 6:
                    cv.create_polygon(xy, outline=color, fill=bg or "",
                                      width=w, joinstyle="round")
                else:
                    cv.create_line(xy, fill=color, width=w,
                                   capstyle="round", joinstyle="round")
            elif t == "rect":
                x1, y1, x2, y2, w = p[1:]
                cv.create_rectangle(x1 * k, y1 * k, x2 * k, y2 * k,
                                    outline=color, width=w)
            elif t == "oval":
                x1, y1, x2, y2, w = p[1:]
                cv.create_oval(x1 * k, y1 * k, x2 * k, y2 * k,
                               outline=color, width=w)
            elif t == "arc":
                x1, y1, x2, y2, st, ex, w = p[1:]
                cv.create_arc(x1 * k, y1 * k, x2 * k, y2 * k,
                              start=st, extent=ex, style="arc",
                              outline=color, width=w)
            elif t == "dot":
                cx, cy, r = p[1:]
                cv.create_oval((cx - r) * k, (cy - r) * k,
                               (cx + r) * k, (cy + r) * k,
                               fill=bg or "", outline=color, width=1.4)

    def make_icon(parent, kind, color="#4a4f57", size=18, bg=None):
        c = tk.Canvas(parent, width=size, height=size, bg=bg or NAV_BG,
                      highlightthickness=0, bd=0)
        _icon_draw(c, kind, color, size, bg or NAV_BG)
        c._icon = (kind, color, size, bg or NAV_BG)
        return c

    def _lerp_color(a, b, t):
        try:
            a = a.lstrip("#")
            b = b.lstrip("#")
            ca = [int(a[i:i + 2], 16) for i in (0, 2, 4)]
            cb = [int(b[i:i + 2], 16) for i in (0, 2, 4)]
            return "#%02x%02x%02x" % tuple(
                int(ca[i] + (cb[i] - ca[i]) * t) for i in range(3))
        except Exception:
            return b if t > 0.5 else a

    _icon_timers = {}

    def icon_animate(cv, to_color, to_bg=None, steps=6, delay=22):
        """在两种颜色之间插值重绘，做出「呼吸」式的悬停过渡。"""
        key = id(cv)
        old = _icon_timers.pop(key, None)
        if old:
            try:
                root.after_cancel(old)
            except Exception:
                pass
        try:
            kind, color, size, bg = cv._icon
        except Exception:
            return
        to_bg = to_bg or bg

        def step(i):
            t = i / float(steps)
            col = _lerp_color(color, to_color, t)
            gbg = _lerp_color(bg, to_bg, t)
            try:
                cv.configure(bg=gbg)
                _icon_draw(cv, kind, col, size, gbg)
            except Exception:
                return
            if i < steps:
                _icon_timers[key] = root.after(delay, lambda: step(i + 1))
            else:
                cv._icon = (kind, to_color, size, to_bg)

        step(1)

    cur_page = {"name": "整理"}

    def show(name):
        cur_page["name"] = name
        # 只让当前页参与布局：7 个页面同时 grid 在一个格子里时，
        # 每次缩放都要给全部页面重新排布+重绘，这正是「全屏卡一下、
        # 中途还会出现白块/黑块」的原因。隐藏页直接 grid_remove。
        for k, f in pages.items():
            try:
                if k == name:
                    f.grid(row=0, column=0, sticky="nsew")
                else:
                    f.grid_remove()
            except Exception:
                pass
        paint()

    def paint():
        cur = cur_page["name"]
        for k, (fr, cv, lb) in nav_rows.items():
            on = (k == cur)
            bg = NAV_ACTIVE if on else NAV_BG
            fr.configure(bg=bg)
            cv.configure(bg=bg)
            lb.configure(bg=bg, fg="#0d59d0" if on else "#333")
            try:
                _kind, _col, _size, _bg = cv._icon
                want = "#0d59d0" if on else "#4a4f57"
                if _col != want:
                    _icon_draw(cv, _kind, want, _size, bg)
                    cv._icon = (_kind, want, _size, bg)
            except Exception:
                pass

    def add_nav(key, label, kind):
        fr = tk.Frame(nav, bg=NAV_BG, cursor="hand2")
        fr.pack(fill="x", padx=8, pady=1)
        cv = make_icon(fr, kind)
        cv.pack(side="left", padx=(10, 8), pady=9)
        lb = tk.Label(fr, text=label, bg=NAV_BG, fg="#333",
                      font=("Microsoft YaHei UI", 9), anchor="w")
        lb.pack(side="left", fill="x", expand=True)

        def on_enter(event=None, _fr=fr, _cv=cv, _lb=lb):
            for w in (_fr, _cv, _lb):
                w.configure(bg=NAV_HOVER)
            icon_animate(_cv, "#0d59d0", NAV_HOVER)

        for w in (fr, cv, lb):
            w.bind("<Button-1>", lambda e, n=key: show(n))
            w.bind("<Enter>", on_enter)
            w.bind("<Leave>", lambda e: paint())
        nav_rows[key] = (fr, cv, lb)

    def add_page(key):
        f = ttk.Frame(body)
        # 先不 grid，等 show() 的时候再决定谁上屏
        pages[key] = f
        return f

    page_tidy = add_page("整理")
    page_rules = add_page("规则")
    page_un = add_page("卸载")
    page_search = add_page("搜索")
    page_shots = add_page("截图")
    page_cache = add_page("缓存")
    page_settings = add_page("设置")
    page_migrate = add_page("迁移")

    tk.Label(nav, text="整理助手", bg=NAV_BG, fg="#111",
             font=("Microsoft YaHei UI", 11, "bold")).pack(pady=(16, 10))
    # 顺序按使用频率排（2026-10 调整）：每天都用的在上，配置类在下，
    # 「设置」永远最后一个，并用一条细线隔开。
    add_nav("整理", "整理文件", "tidy")
    add_nav("截图", "清理截图", "shots")
    add_nav("缓存", "清理缓存", "cache")
    add_nav("搜索", "搜索文件", "search")
    add_nav("卸载", "卸载程序", "uninstall")
    add_nav("迁移", "数据迁移", "folder")
    add_nav("规则", "高级规则", "rules")
    ttk.Separator(nav, orient="horizontal").pack(fill="x", padx=14, pady=(8, 2))
    add_nav("设置", "设置", "settings")

    # ── 统一的页面标题条 ──
    def page_header(parent, title, sub=""):
        box = ttk.Frame(parent)
        box.pack(fill="x", padx=14, pady=(12, 0))
        ttk.Label(box, text=title, foreground="#1b1f24",
                  font=("Microsoft YaHei UI", 11, "bold")).pack(anchor="w")
        if sub:
            ttk.Label(box, text=sub, foreground="#8b9199",
                      font=("Microsoft YaHei UI", 9)).pack(anchor="w", pady=(1, 0))
        ttk.Separator(parent, orient="horizontal").pack(fill="x", padx=14, pady=(6, 8))

    page_header(page_tidy, "整理文件",
                "选一个文件夹，先预览会怎么分，确认后再动手；随时可以撤销")
    page_header(page_shots, "清理截图",
                "按文件名特征找出旧截图，可管多个目录，支持定时自动清理")
    page_header(page_cache, "清理缓存",
                "只清理已知的缓存位置，系统关键目录与个人文件硬性排除"
                "　·　缓存会被程序立刻重建，属正常现象")
    page_header(page_rules, "高级规则",
                "用 organize 的 YAML 规则做更精细的整理，改动前先预演")
    page_header(page_un, "卸载程序",
                "列出已安装程序，支持普通卸载、强制删除与残留清理")
    page_header(page_search, "搜索文件",
                "本地文件名索引，没装 Everything 也能搜；装了会更快")
    page_header(page_settings, "设置",
                "数据与缓存位置、默认勾选项、资源管理器右键菜单")

    top = ttk.Frame(page_tidy)
    top.pack(fill="x", padx=14, pady=(0, 8))
    ttk.Label(top, text="文件夹：").pack(side="left")
    path_var = tk.StringVar()
    ttk.Entry(top, textvariable=path_var).pack(side="left", fill="x", expand=True, padx=6)

    def browse():
        d = filedialog.askdirectory(title="选择要整理的文件夹")
        if d:
            path_var.set(os.path.normpath(d))
            do_scan()

    def pick_dir(var):
        d = filedialog.askdirectory(title="选择目录")
        if d:
            var.set(os.path.normpath(d))

    ttk.Button(top, text="浏览…", command=browse).pack(side="left")

    # ── 整理去处 + 分类口径（两个下拉，替代原来散着的三四个按钮）──
    dest_mode = tk.StringVar(value="就地分类")
    dest_path = tk.StringVar(value="")
    group_var = tk.StringVar(value="按类型")
    GROUP_MAP = {"按类型": "type", "按日期": "date",
                 "按来源": "source", "类型+日期": "type_date"}

    mode_row = ttk.Frame(page_tidy)
    mode_row.pack(fill="x", padx=14, pady=(0, 6))
    ttk.Label(mode_row, text="整理到：").pack(side="left")
    dest_combo = ttk.Combobox(mode_row, textvariable=dest_mode, width=12,
                              state="readonly",
                              values=["就地分类", "移到指定目录"])
    dest_combo.pack(side="left", padx=(0, 4))
    dest_entry = ttk.Entry(mode_row, textvariable=dest_path, width=30)
    dest_btn = ttk.Button(mode_row, text="浏览…", width=7,
                          command=lambda: pick_dir(dest_path))
    ttk.Label(mode_row, text="分类方式：").pack(side="left", padx=(14, 4))
    group_combo = ttk.Combobox(mode_row, textvariable=group_var, width=11,
                               state="readonly",
                               values=["按类型", "按日期", "按来源", "类型+日期"])
    group_combo.pack(side="left")

    def _sync_dest_ui(*_):
        if dest_mode.get() == "移到指定目录":
            dest_entry.pack(side="left", padx=(8, 4))
            dest_btn.pack(side="left")
        else:
            dest_entry.pack_forget()
            dest_btn.pack_forget()
    dest_combo.bind("<<ComboboxSelected>>", _sync_dest_ui)
    group_combo.bind("<<ComboboxSelected>>",
                     lambda e: (_sync_dest_ui(), do_scan()))
    _sync_dest_ui()

    v_recent = tk.BooleanVar(value=True)
    v_short = tk.BooleanVar(value=True)
    v_force = tk.BooleanVar(value=False)
    v_rec = tk.BooleanVar(value=False)
    v_date = tk.BooleanVar(value=False)
    v_mon = tk.BooleanVar(value=False)
    v_content = tk.BooleanVar(value=rules.content_enabled)
    conflict_var = tk.StringVar(value=rules.conflict_policy)


    time_var = tk.StringVar(value=rules.default_time)
    sched_status = tk.StringVar(value="")
    sched_on = tk.BooleanVar(value=False)

    def refresh_schedule():
        ok, nxt, _ = task_query(rules.task_name)
        if ok:
            sched_status.set(f"已启用（下次 {nxt}）" if nxt else "已启用")
        else:
            sched_status.set("未设置")
        try:
            sched_on.set(bool(ok))
        except Exception:
            pass

    def _run_cmd(args):
        """兼容旧调用：只返回文本。"""
        return _run_hidden(args)[1]

    def make_schedule():
        folder = path_var.get().strip().strip('"')
        if not folder or not os.path.isdir(folder):
            messagebox.showinfo("提示", "先选一个存在的文件夹")
            return
        when = check_when(time_var.get())
        if not when:
            messagebox.showinfo("提示", "时间格式要写成 HH:MM，例如 22:00")
            return
        tr = '%s --scheduled "%s"' % (_task_runner(), folder)
        ok, err, nxt = task_create(rules.task_name, when, tr)
        if ok:
            log(f"[定时] 已创建：每天 {when} 自动扫描 {folder}"
                + (f"，下次 {nxt}" if nxt else ""))
            messagebox.showinfo(
                "已创建",
                f"每天 {when} 会自动扫描：\n{folder}\n\n"
                + (f"下次运行：{nxt}" if nxt else "")
                + "\n\n想立刻验证，点旁边的「立即试跑」。")
        else:
            messagebox.showerror(
                "创建失败",
                (err[:500] or "未知错误")
                + "\n\n常见原因：\n"
                "· 系统策略禁止创建任务（需要管理员）\n"
                "· 杀毒软件拦了 schtasks\n"
                "· 任务名被占用但删不掉")
        refresh_schedule()

    def test_schedule():
        folder = path_var.get().strip().strip('"')
        if not folder or not os.path.isdir(folder):
            messagebox.showinfo("提示", "先选一个存在的文件夹")
            return
        cmd = '%s --scheduled "%s"' % (_task_runner(), folder)
        ok, info = task_run_now(cmd)
        log("[定时] 试跑" + ("成功" if ok else "失败：") + str(info))
        if ok:
            messagebox.showinfo("试跑成功", "命令能正常执行。\n"
                                "任务到点会用同样的命令跑一次。")
        else:
            messagebox.showerror("试跑失败", str(info))

    def del_schedule():
        ok, err = task_delete(rules.task_name)
        if ok:
            log("[定时] 已删除计划任务")
        else:
            messagebox.showinfo("提示", (err[:300] or "没有找到计划任务"))
        refresh_schedule()

    # ── 选项面板（弹窗，主界面只留主要动作用）──
    def open_options():
        w = tk.Toplevel(root)
        w.title("选项")
        w.configure(bg="#fff")
        w.resizable(False, False)
        w.transient(root)
        body = ttk.Frame(w, padding=16)
        body.pack(fill="both", expand=True)

        def sec(title):
            ttk.Label(body, text=title, foreground="#888",
                      font=("Microsoft YaHei UI", 9)).pack(anchor="w", pady=(10, 2))
            f = ttk.Frame(body)
            f.pack(fill="x", anchor="w")
            return f

        f1 = sec("扫描范围")
        ttk.Checkbutton(f1, text=f"包含子文件夹（递归 {rules.rec_max_depth} 层）",
                        variable=v_rec, command=sync_summary).pack(anchor="w")
        ttk.Checkbutton(f1, text="按日期分目录（年/月）",
                        variable=v_date, command=sync_summary).pack(anchor="w")

        f2 = sec("跳过规则")
        ttk.Checkbutton(f2, text=f"跳过 {rules.min_age // 60} 分钟内改动过的"
                        if rules.min_age >= 60 else "跳过刚改动过的",
                        variable=v_recent, command=sync_summary).pack(anchor="w")
        ttk.Checkbutton(f2, text="跳过快捷方式（.lnk）",
                        variable=v_short, command=sync_summary).pack(anchor="w")
        ttk.Checkbutton(f2, text="按内容识别（读文档正文再判类别，较慢）",
                        variable=v_content, command=sync_summary).pack(anchor="w")
        ttk.Checkbutton(f2, text="强制整理（我确认这不是程序或工程目录）",
                        variable=v_force, command=sync_summary).pack(anchor="w")

        f3 = sec("重名冲突")
        rowf = ttk.Frame(f3)
        rowf.pack(anchor="w")
        ttk.Combobox(rowf, textvariable=conflict_var, width=12, state="readonly",
                     values=("rename", "skip", "overwrite")).pack(side="left")
        ttk.Label(rowf, text="rename 改名 / skip 跳过 / overwrite 覆盖",
                  foreground="#888").pack(side="left", padx=8)

        f4 = sec("自动化")
        ttk.Checkbutton(f4, text="监控模式：自动整理新出现的文件",
                        variable=v_mon, command=toggle_monitor).pack(anchor="w", pady=(0, 6))
        def toggle_schedule():
            if sched_on.get():
                make_schedule()
                if not task_query(rules.task_name)[0]:
                    sched_on.set(False)
            else:
                del_schedule()

        sf = ttk.Frame(f4)
        sf.pack(anchor="w")
        ttk.Checkbutton(sf, text="每天自动扫描", variable=sched_on,
                        command=toggle_schedule).pack(side="left")
        ttk.Entry(sf, textvariable=time_var, width=7).pack(side="left", padx=(10, 4))
        ttk.Button(sf, text="改时间", command=make_schedule).pack(side="left")
        ttk.Label(sf, textvariable=sched_status, foreground="#666").pack(side="left", padx=8)
        refresh_schedule()

        ttk.Separator(body).pack(fill="x", pady=(14, 10))
        ttk.Button(body, text="关闭", command=w.destroy).pack(anchor="e")
        w.update_idletasks()
        x = root.winfo_rootx() + (root.winfo_width() - w.winfo_width()) // 2
        y = root.winfo_rooty() + (root.winfo_height() - w.winfo_height()) // 3
        w.geometry(f"+{max(0, x)}+{max(0, y)}")
        w.grab_set()

    def sync_summary():
        parts = []
        if v_rec.get():
            parts.append(f"含子文件夹 {rules.rec_max_depth} 层")
        if v_date.get():
            parts.append("按日期分目录")
        if not v_recent.get():
            parts.append("不跳过新改动")
        if not v_short.get():
            parts.append("含快捷方式")
        if v_content.get():
            parts.append("内容识别")
        if v_force.get():
            parts.append("强制")
        if conflict_var.get() != "rename":
            parts.append(f"重名{conflict_var.get()}")
        opt_summary.set(" · ".join(parts) if parts else "默认规则")

    opt_summary = tk.StringVar(value="")
    sync_summary()

    bar = ttk.Frame(page_tidy)
    bar.pack(fill="x", padx=14, pady=(10, 2))
    info = tk.StringVar(value="先选文件夹")

    def log(msg):
        log_text.configure(state="normal")
        log_text.insert("end", msg + "\n")
        log_text.see("end")
        log_text.configure(state="disabled")

    def clear_log():
        log_text.configure(state="normal")
        log_text.delete("1.0", "end")
        log_text.configure(state="disabled")

    # 界面里任何回调出错都不要静默吞掉：写日志 + 存一份到数据目录
    def _report_cb_exception(exc, val, tb):
        import traceback
        detail = "".join(traceback.format_exception(exc, val, tb))
        try:
            log("界面操作出错：" + detail.strip().splitlines()[-1])
        except Exception:
            pass
        try:
            p = os.path.join(data_dir(), "界面错误.log")
            with open(p, "a", encoding="utf-8") as f:
                f.write(detail + "\n")
        except Exception:
            pass

    root.report_callback_exception = _report_cb_exception

    def render(plans):
        base = path_var.get().strip().strip('"')
        for i in tree.get_children():
            tree.delete(i)
        state["rows"] = {}
        state["groups"] = {}
        checked.clear()
        for p in plans:
            rel = os.path.relpath(p.folder, base) if base else p.folder
            rel = "." if rel == "." else rel
            for cat in p.categories():
                files = p.by_cat[cat]
                gid = tree.insert(
                    "", "end", text=f"{cat}  ({len(files)})",
                    values=(BOX_OFF, rel, len(files), human(sum(s for _, s, _ in files))),
                    open=False, tags=("grp",))
                state["groups"][gid] = [os.path.join(p.folder, f[0]) for f in files]
                # 组不太大时给图片/视频取一张小封面（大组跳过，免卡界面）
                show_thumb = len(files) <= 40
                for name, size, mtime in files:
                    full = os.path.join(p.folder, name)
                    ic = None
                    if show_thumb and os.path.splitext(name)[1].lower() in MEDIA_EXT:
                        try:
                            ic = shot_icon(full, box=18)
                        except Exception:
                            ic = None
                    cid = tree.insert(
                        gid, "end", text=name, image=ic or "",
                        values=(BOX_OFF, os.path.basename(p.folder), "", human(size)))
                    state["rows"][cid] = full
        refresh_sel()
        for i in skip_tree.get_children():
            skip_tree.delete(i)
        for p in plans:
            rel = os.path.relpath(p.folder, base) if base else p.folder
            for name, why in p.skipped:
                skip_tree.insert("", "end",
                                 values=(f"{rel}\\{name}" if rel != "." else name, why))
        total = sum(p.total for p in plans)
        size = sum(p.total_size for p in plans)
        skip = sum(len(p.skipped) for p in plans)
        info.set(f"{total} 个文件 / {human(size)}，跳过 {skip} 个")

    def gather(folder, force_new_files=False, progress=None):
        rec = v_rec.get()
        if rec:
            return scan_tree(folder, rules, v_recent.get(), v_short.get(),
                             force=v_force.get(), use_content=v_content.get(),
                             progress=progress)
        one = scan(folder, rules, v_recent.get(), v_short.get(),
                   force=v_force.get(), use_content=v_content.get(),
                   progress=progress)
        plans = [one] if one.by_cat else []
        blocked = [] if one.by_cat else ([one] if one.error else [])
        return plans, blocked

    def do_scan(silent=False):
        """silent=True：只刷新列表，不重置日志（批量删除后调用）。"""
        folder = path_var.get().strip().strip('"')
        if not folder:
            return
        if not silent:
            clear_log()
            log("扫描中…")
            prog_begin("正在扫描：%s" % folder)

        def work(rep):
            return gather(folder, progress=rep)

        def done(res):
            plans, blocked = res
            _scan_done(folder, plans, blocked)

        run_task("正在扫描：%s" % folder, work, done)

    def _scan_done(folder, plans, blocked):
        if plans:
            plans = regroup(plans, GROUP_MAP.get(group_var.get(), "type"), rules)
        state["plans"], state["blocked"] = plans, blocked
        try:
            hint_bar.pack_forget()
        except Exception:
            pass

        if not plans:
            for t in (tree, skip_tree):
                for i in t.get_children():
                    t.delete(i)
            info.set("已拦截")
            if blocked:
                p = blocked[0]
                log("[拦截] " + (p.error or ""))
                for e in p.evidence:
                    log("   依据：" + e)
                if p.skip_subtree:
                    log("   该目录及其全部子目录已整体放弃，不会动任何一个文件。")
                elif "代码工程" in (p.error or "") or "软件目录" in (p.error or ""):
                    log("   确认无误可勾选「强制整理」再扫描。")
            else:
                log("没有找到需要整理的文件。")
            return

        render(plans)
        # 新结果默认收起，把右上角「展开/折叠」按钮同步回「全部展开」
        state["all_open"] = False
        try:
            _apply_expand_ui()
        except Exception:
            pass
        log(f"扫描完成：{folder}")
        log(f"   规则来源：{RULES_SOURCE}   模式：{'递归' if v_rec.get() else '仅当层'}")
        for p in plans:
            rel = os.path.relpath(p.folder, folder)
            if rel != ".":
                log(f"   [{rel}]")
            for cat in p.categories():
                log(f"      {cat:<14} {len(p.by_cat[cat]):>4} 个")
        if blocked:
            log(f"   另有 {len(blocked)} 个位置被跳过（程序/工程/源码/文件不足）")

        # 只扫到很少时，提示子目录里还剩多少
        if not v_rec.get():
            sub_n = 0
            try:
                for e in os.scandir(folder):
                    if not e.is_dir(follow_symlinks=False):
                        continue
                    for dp, dns, fns in os.walk(e.path):
                        dns[:] = [d for d in dns if d.lower() not in INDEX_SKIP]
                        sub_n += len(fns)
                        if sub_n > 20000:
                            break
                    if sub_n > 20000:
                        break
            except OSError:
                sub_n = 0
            total = sum(p.total for p in plans)
            if sub_n >= max(5, total * 2):
                hint_txt.set(f"当前只扫到顶层 {total} 个文件，子目录里还有约 {sub_n} 个没扫。")
                hint_bar.pack(fill="x", padx=14, pady=(0, 6), before=nb)

                def _rec_scan():
                    v_rec.set(True)
                    sync_summary()
                    hint_bar.pack_forget()
                    do_scan()

                hint_btn.configure(command=_rec_scan)
                log("")
                log(f"提示：顶层只有 {total} 个文件，子目录里还有约 {sub_n} 个。")
                log("      点上方黄色提示条的按钮，或勾选「包含子文件夹」再扫描。")
        else:
            hint_bar.pack_forget()

    def do_apply(auto=False):
        plans = state["plans"]
        if not plans:
            if not auto:
                messagebox.showinfo("提示", "请先扫描，并确认有可整理的文件")
            return 0
        folder = path_var.get().strip().strip('"')
        total_n = sum(p.total for p in plans)

        # 去处：就地分类 or 移到指定目录（只问一次，文案按模式变）
        move_out = (dest_mode.get() == "移到指定目录")
        target = dest_path.get().strip().strip('"')
        if move_out:
            ok_dest, why_dest = check_dest(target, folder)
            if not ok_dest:
                messagebox.showinfo("目标目录有问题", why_dest)
                return 0
        if not auto:
            if move_out:
                msg = (f"会把 {total_n} 个文件移到：\n{target}\n\n"
                       f"分类方式：{group_var.get()}\n"
                       f"· 不会删除任何文件\n· 可以撤销\n\n继续？")
                title = "确认移动到别处"
            else:
                msg = (f"将在 {len(plans)} 个目录里移动 {total_n} 个文件到各自的分类文件夹。\n\n"
                       f"分类方式：{group_var.get()}\n"
                       f"· 不会删除任何文件\n· 不动已有子文件夹\n· 可以撤销\n\n继续？")
                title = "确认整理"
            if not messagebox.askyesno(title, msg):
                return 0

        def work(rep):
            return apply(plans, folder, rules,
                         policy=conflict_var.get(),
                         date_fmt="%Y/%m" if v_date.get() else "",
                         progress=rep,
                         dest_root=(target if move_out else None))

        def done(res):
            n, failed, mf = res
            log(f"[完成] 已移动 {n} 个文件"
                + (f" -> {target}" if move_out else "（就地分类）"))
            for name, why in failed[:8]:
                log(f"   失败 {name}  <- {why}")
            rep_path = write_report(mf, target if move_out else folder)
            if rep_path:
                log(f"[报告] {rep_path}")
            do_scan()
            if rep_path and not failed:
                if messagebox.askyesno(
                        "整理完成",
                        f"已整理 {n} 个文件。\n\n"
                        f"报告已保存：\n{rep_path}\n\n现在打开报告看看？"):
                    open_with_default(rep_path)

        run_task("正在整理 %d 个文件…" % total_n, work, done)
        return total_n

    def do_undo():
        folder = path_var.get().strip().strip('"')
        if not folder:
            return
        n, failed = undo(folder)
        log(f"[撤销] 已还原 {n} 个文件" if n else "没有可撤销的记录")
        for name, why in failed[:8]:
            log(f"   {name}  <- {why}")
        state["plans"] = None
        do_scan()

    def do_csv():
        plans = state["plans"]
        if not plans:
            messagebox.showinfo("提示", "先扫描")
            return
        base = path_var.get().strip().strip('"')
        p = filedialog.asksaveasfilename(defaultextension=".csv",
                                         filetypes=[("CSV", "*.csv")],
                                         initialfile="整理预览.csv")
        if not p:
            return
        with open(p, "w", encoding="utf-8-sig", newline="") as f:
            w = csv.writer(f)
            w.writerow(["位置", "分类", "文件名", "大小(字节)", "修改时间"])
            for plan in plans:
                rel = os.path.relpath(plan.folder, base)
                for cat in plan.categories():
                    for name, size, mt in plan.by_cat[cat]:
                        w.writerow([rel, cat, name, size,
                                    datetime.datetime.fromtimestamp(mt).strftime("%Y-%m-%d %H:%M")])
                for name, why in plan.skipped:
                    w.writerow([rel, "（跳过）", name, "", why])
        log(f"[导出] {p}")

    def do_report_last():
        """重新生成「上一次整理」的报告，方便回头确认文件去哪了。"""
        hd = hist_dir()
        files = []
        if os.path.isdir(hd):
            files = sorted([f for f in os.listdir(hd) if f.endswith(".json")],
                           reverse=True)
        if not files:
            messagebox.showinfo("提示", "还没有任何整理记录")
            return
        mf = os.path.join(hd, files[0])
        base = path_var.get().strip().strip('"') or None
        rep = write_report(mf, base)
        if not rep:
            messagebox.showinfo("提示", "这条记录里没有移动内容")
            return
        log(f"[报告] {rep}")
        if messagebox.askyesno("报告已生成", rep + "\n\n现在打开？"):
            open_with_default(rep)

    # ── 监控模式 ──
    def monitor_tick():
        if not state["monitoring"]:
            return
        folder = path_var.get().strip().strip('"')
        try:
            if folder and os.path.isdir(folder):
                old = rules.min_age
                rules.min_age = 60          # 监控时只处理稳定 1 分钟以上的新文件
                try:
                    plans, _ = gather(folder)
                finally:
                    rules.min_age = old
                fresh = [p for p in plans if p.by_cat]
                if fresh:
                    state["plans"] = fresh
                    n = do_apply(auto=True)
                    if n:
                        log(f"   [监控] 自动整理 {n} 个新文件")
        except Exception as ex:
            log(f"   [监控] 出错：{ex}")
        state["monitor_job"] = root.after(30000, monitor_tick)

    def toggle_monitor():
        folder = path_var.get().strip().strip('"')
        if v_mon.get():
            if not folder or not os.path.isdir(folder):
                messagebox.showinfo("提示", "先选一个文件夹再开监控")
                v_mon.set(False)
                return
            state["monitoring"] = True
            log(f"[监控] 已开启，每 30 秒检查 {folder}")
            state["monitor_job"] = root.after(30000, monitor_tick)
        else:
            state["monitoring"] = False
            if state["monitor_job"]:
                try:
                    root.after_cancel(state["monitor_job"])
                except Exception:
                    pass
                state["monitor_job"] = None
            log("[监控] 已停止")

    def toolbtn(parent, icon, text, cmd, ret_handles=False):
        f = tk.Frame(parent, bg="#f4f5f7", cursor="hand2",
                     highlightthickness=1, highlightbackground="#dcdfe4")
        ic = make_icon(f, icon, color="#4a4f57", size=15, bg="#f4f5f7")
        ic.pack(side="left", padx=(8, 3), pady=5)
        lb = tk.Label(f, text=text, bg="#f4f5f7", fg="#333", font=UI_FONT)
        lb.pack(side="left", padx=(0, 9))

        def enter(_):
            for x in (f, ic, lb):
                x.configure(bg="#e8ecf3")
            ic.configure(bg="#e8ecf3")

        def leave(_):
            for x in (f, ic, lb):
                x.configure(bg="#f4f5f7")
            ic.configure(bg="#f4f5f7")

        for w in (f, ic, lb):
            w.bind("<Button-1>", lambda e: cmd())
            w.bind("<Enter>", enter)
            w.bind("<Leave>", leave)
        f.pack(side="right", padx=(6, 0))
        if ret_handles:
            return f, ic, lb
        return f

    def menu_btn(parent, text, build, width=None, **kw):
        """点了弹菜单的按钮：build(menu) 负责往里加项。"""
        b = ttk.Button(parent, text=text, width=width, **kw)
        m = tk.Menu(b, tearoff=0)
        m.configure(font=UI_FONT)

        def pop():
            m.delete(0, "end")
            build(m)
            try:
                m.tk_popup(b.winfo_rootx(),
                           b.winfo_rooty() + b.winfo_height())
            finally:
                m.grab_release()

        b.configure(command=pop)
        return b

    def toolmenu(parent, icon, text, build):
        """和 toolbtn 同款外观，点了弹菜单。"""
        f, ic, lb = toolbtn(parent, icon, text, lambda: None, ret_handles=True)

        def pop(_e=None):
            m = tk.Menu(f, tearoff=0)
            m.configure(font=UI_FONT)
            build(m)
            try:
                m.tk_popup(f.winfo_rootx(),
                           f.winfo_rooty() + f.winfo_height())
            finally:
                m.grab_release()

        for w in (f, ic, lb):
            w.bind("<Button-1>", pop)
        return f

    ttk.Button(bar, text="扫描预览", command=do_scan).pack(side="left")
    ttk.Button(bar, text="开始整理", command=lambda: do_apply()).pack(side="left", padx=8)
    ttk.Label(bar, textvariable=info, foreground="#555").pack(side="left", padx=14)

    def _tidy_more(m):
        m.add_command(label="扫描选项…", command=open_options)
        m.add_separator()
        m.add_command(label="全部展开", command=lambda: toggle_expand(True))
        m.add_command(label="全部折叠", command=lambda: toggle_expand(False))
        m.add_separator()
        m.add_command(label="撤销上一次整理", command=do_undo)
        m.add_command(label="把预览导出为 CSV…", command=do_csv)
        m.add_command(label="重新生成整理报告…", command=do_report_last)

    toolmenu(bar, "sliders", "更多", _tidy_more)

    # 一个按钮兼顾展开/折叠：点一下展开，再点一下收起
    state["all_open"] = False

    def _draw_expand_icon(want_open):
        """在同一个 Canvas 上重画箭头方向。"""
        cv = exp_handles[1]
        cv.delete("all")
        s = int(cv["width"])
        color = "#4a4f57"
        if want_open:          # 已展开 → 显示向上（点它收起）
            cv.create_line(4, s - 7, s // 2, 5, s - 4, s - 7,
                           fill=color, width=1.8)
            cv.create_line(4, s - 3, s - 4, s - 3, fill=color, width=1.4)
        else:                  # 收起中 → 显示向下（点它展开）
            cv.create_line(4, 7, s // 2, s - 5, s - 4, 7,
                           fill=color, width=1.8)
            cv.create_line(4, 3, s - 4, 3, fill=color, width=1.4)

    def _apply_expand_ui():
        if exp_handles:
            exp_handles[2].configure(
                text="全部折叠" if state["all_open"] else "全部展开")
            _draw_expand_icon(state["all_open"])

    def toggle_expand(want=None):
        if want is None:
            want = not state["all_open"]
        expand_all(want)
        state["all_open"] = want
        _apply_expand_ui()

    exp_handles = None

    sub = ttk.Frame(page_tidy)
    sub.pack(fill="x", padx=14, pady=(0, 6))
    ttk.Label(sub, textvariable=opt_summary, foreground="#888",
              font=("Microsoft YaHei UI", 9)).pack(side="left")
    ttk.Label(sub, text="· 右键可预览 / 打开位置 / 删除，双击分类展开",
              foreground="#a8adb5",
              font=("Microsoft YaHei UI", 9)).pack(side="left", padx=8)

    # ── 提示条：顶层文件很少但子目录很多时，直接在界面上给一键处理 ──
    hint_bar = tk.Frame(page_tidy, bg="#fff8e6", highlightthickness=1,
                        highlightbackground="#f0d9a8")
    hint_txt = tk.StringVar(value="")
    tk.Label(hint_bar, textvariable=hint_txt, bg="#fff8e6", fg="#7a5200",
             font=UI_FONT, anchor="w").pack(side="left", padx=10, pady=7)
    hint_btn = tk.Button(hint_bar, text="包含子文件夹并重扫", bg="#f0d9a8",
                         fg="#5a3c00", relief="flat", cursor="hand2",
                         font=UI_FONT, padx=8, pady=2,
                         activebackground="#e6c98d")
    hint_btn.pack(side="right", padx=8, pady=5)

    nb = ttk.Notebook(page_tidy)
    nb.pack(fill="both", expand=True, padx=14, pady=(0, 8))

    f1 = ttk.Frame(nb)
    nb.add(f1, text="分类预览")

    # ── 批量操作栏 ──
    sel_info = tk.StringVar(value="未勾选")
    batch_bar = tk.Frame(f1, bg="#f7f8fa", highlightthickness=0)
    batch_bar.pack(fill="x", padx=4, pady=(4, 0))

    def _mini_text(txt, cmd, fg="#333"):
        lb = tk.Label(batch_bar, text=txt, bg="#f7f8fa", fg=fg, cursor="hand2",
                      font=UI_FONT, padx=6, pady=3)
        lb.pack(side="left")
        lb.bind("<Button-1>", lambda e: cmd())
        lb.bind("<Enter>", lambda e: lb.configure(fg="#0d59d0"))
        lb.bind("<Leave>", lambda e: lb.configure(fg=fg))
        return lb

    def batch_delete(to_trash=True, hard=False):
        paths = checked_paths()
        if not paths:
            messagebox.showinfo("没有勾选", "先在左侧「选」列打勾，或用 Ctrl/Shift 多选行。")
            return
        size = 0
        for p in paths:
            try:
                size += os.path.getsize(p)
            except OSError:
                pass
        label = "移到回收站" if to_trash else ("强制删除" if hard else "永久删除")
        if not messagebox.askyesno(
                f"批量{label}",
                f"将{label} {len(paths)} 个文件（{human(size)}）。\n"
                + ("回收站可以还原。" if to_trash else "⚠ 不进回收站，无法还原！")
                + "\n\n继续？"):
            return
        if to_trash:
            ok, fail = trash_delete(paths)
        elif hard:
            ok, fail, _pend = hard_delete(paths)
        else:
            ok, fail = delete_paths(paths)
        log(f"[批量{label}] 成功 {len(ok)} 个，失败 {len(fail)} 个")
        for p, why in fail[:5]:
            log(f"  失败 {os.path.basename(p)}  <- {why}")
        checked.clear()
        for iid in list(state.get("rows", {})):
            if tree.exists(iid):
                tree.set(iid, "sel", BOX_OFF)
        for gid in tree.get_children(""):
            tree.set(gid, "sel", BOX_OFF)
        refresh_sel()
        do_scan(silent=True)

    def batch_delete_folder():
        paths = checked_paths()
        if not paths:
            messagebox.showinfo("没有勾选", "先勾选文件，再批量删除它们所在的整个文件夹。")
            return
        dirs = []
        for p in paths:
            d = os.path.dirname(p)
            if os.path.normcase(d) not in [os.path.normcase(x) for x in dirs]:
                dirs.append(d)
        delete_folders(dirs)

    _mini_text("全选", lambda: check_all(True))
    _mini_text("反选", lambda: invert_check())
    _mini_text("清空", lambda: check_all(False))
    tk.Label(batch_bar, textvariable=sel_info, bg="#f7f8fa", fg="#666",
             font=UI_FONT).pack(side="left", padx=10)
    _mini_text("批量移到回收站", lambda: batch_delete(True), fg="#0a7f43")
    _mini_text("批量永久删除", lambda: batch_delete(False, False), fg="#b3261e")
    _mini_text("批量删除所在文件夹", batch_delete_folder, fg="#b3261e")

    tree = ttk.Treeview(f1, columns=("sel", "loc", "n", "size"), show="tree headings",
                        selectmode="extended")
    tree.heading("#0", text="分类 / 文件")
    tree.heading("sel", text="选")
    tree.heading("loc", text="位置")
    tree.heading("n", text="文件数")
    tree.heading("size", text="大小")
    tree.column("#0", width=310)
    tree.column("sel", width=56, anchor="center", stretch=False)
    tree.column("loc", width=190)
    tree.column("n", width=70, anchor="e")
    tree.column("size", width=100, anchor="e")
    tree.tag_configure("grp", font=("Microsoft YaHei UI", 9, "bold"))
    tree.pack(fill="both", expand=True, padx=4, pady=4)

    # ── 勾选状态 ──
    BOX_OFF, BOX_ON, BOX_HALF = "☐", "☑", "▣"
    checked = set()

    def _kids(iid):
        return list(tree.get_children(iid))

    def set_check(iid, on, cascade=True):
        tree.set(iid, "sel", BOX_ON if on else BOX_OFF)
        if on:
            checked.add(iid)
        else:
            checked.discard(iid)
        for sid in _kids(iid):
            set_check(sid, on, cascade=False)
            if on:
                checked.add(sid)
            else:
                checked.discard(sid)
        # 父节点跟着变成 全选/半选/未选
        parent = tree.parent(iid)
        if parent:
            kids = _kids(parent)
            n_on = sum(1 for k in kids if tree.set(k, "sel") == BOX_ON)
            if n_on == 0:
                tree.set(parent, "sel", BOX_OFF)
                checked.discard(parent)
            elif n_on == len(kids):
                tree.set(parent, "sel", BOX_ON)
                checked.add(parent)
            else:
                tree.set(parent, "sel", BOX_HALF)
                checked.discard(parent)
        refresh_sel()

    def refresh_sel():
        n = sum(1 for i in checked
                if tree.set(i, "sel") == BOX_ON and i in state.get("rows", {}))
        sel_info.set(f"已勾选 {n} 个文件" if n else "未勾选")

    def toggle_row(iid):
        on = tree.set(iid, "sel") != BOX_ON
        set_check(iid, on)

    def check_all(on=True):
        for gid in tree.get_children():
            set_check(gid, on)
        refresh_sel()

    def invert_check():
        for gid in tree.get_children():
            set_check(gid, tree.set(gid, "sel") != BOX_ON)
        refresh_sel()

    def checked_paths():
        out = []
        for iid in list(checked):
            p = state.get("rows", {}).get(iid)
            if p and tree.exists(iid):
                out.append(p)
        return out

    def expand_all(open_=True):
        for gid in tree.get_children():
            tree.item(gid, open=open_)

    # ── 右键菜单 / 双击展开 ──
    def row_paths(iid):
        if iid in state.get("rows", {}):
            return [state["rows"][iid]]
        return list(state.get("groups", {}).get(iid, []))


    def preview_file(path, siblings=None):
        """薄壳：把日志/删除/刷新能力注入模块级实现。"""
        return _preview_file(root, path, siblings,
                             delete_fn=tidy_delete, logger=log,
                             on_refresh=(lambda: do_scan() if state.get("plans") else None))
    def delete_folders(folders, to_trash=False):
        """整目录删除：先统计里面有多少文件、多大，再二次确认。"""
        from tkinter import messagebox
        folders = [f for f in folders if f and os.path.isdir(f)]
        if not folders:
            messagebox.showinfo("没有可删的文件夹", "这些文件所在的文件夹已经不存在了。")
            return
        # 安全边界：盘符根、系统目录、当前扫描根一律拒绝
        cur_root = path_var.get().strip().strip('"')
        safe, refused = [], []
        for d in folders:
            nd = os.path.normcase(os.path.abspath(d))
            if cur_root and nd == os.path.normcase(os.path.abspath(cur_root)):
                refused.append((d, "就是当前扫描的根目录"))
                continue
            why = check_target(d, rules, allow_root=False)
            if why:
                refused.append((d, why))
                continue
            safe.append(d)
        if not safe:
            messagebox.showwarning(
                "拒绝删除", "以下文件夹不允许删除：\n\n"
                + "\n".join(f"· {d}\n  {w}" for d, w in refused[:5]))
            return

        rows, total_files, total_size = [], 0, 0
        for d in safe:
            n, sz = 0, 0
            for dp, _dns, fns in os.walk(d):
                for n2 in fns:
                    n += 1
                    try:
                        sz += os.path.getsize(os.path.join(dp, n2))
                    except OSError:
                        pass
            rows.append((d, n, sz))
            total_files += n
            total_size += sz

        body = "\n".join(f"· {d}\n   {n} 个文件 / {human(sz)}" for d, n, sz in rows[:6])
        if len(rows) > 6:
            body += f"\n… 还有 {len(rows) - 6} 个文件夹"
        warn = ("\n\n⚠ 连同文件夹里的其他文件一起删除，不进回收站，无法还原！"
                if not to_trash else "\n\n会移入回收站，可以还原。")
        if not messagebox.askyesno(
                "删除整个文件夹",
                f"将删除 {len(rows)} 个文件夹，共 {total_files} 个文件 / {human(total_size)}：\n\n"
                + body + warn + "\n\n确定继续？"):
            return
        paths = [d for d, _, _ in rows]
        ok, fail = (trash_delete(paths) if to_trash else delete_paths(paths))
        log(f"[删文件夹] 成功 {len(ok)} 个，失败 {len(fail)} 个")
        for d, why in fail[:5]:
            log(f"   ✗ {d}：{why}")
        for d, why in refused[:5]:
            log(f"   跳过 {d}：{why}")
        do_scan()

    def tidy_delete(paths, mode):
        """返回 (成功数, 失败列表)；用户取消或没有输入时返回 None。"""
        if not paths:
            return None
        n = len(paths)
        sample = paths[0] + ("　…" if n > 1 else "")
        if mode == "trash":
            if not messagebox.askyesno(
                    "移到回收站",
                    f"把 {n} 个文件移到回收站？\n\n{sample}\n\n回收站里可以还原。"):
                return
            ok, fail = trash_delete(paths)
            pending = []
        elif mode == "permanent":
            if not messagebox.askyesno(
                    "永久删除 · 不可恢复",
                    f"彻底删除 {n} 个文件（不进回收站）？\n\n{sample}"):
                return
            ok, fail = delete_paths(paths)
            pending = []
        else:
            if not messagebox.askyesno(
                    "强制删除 · 不可恢复",
                    f"强制删除 {n} 个文件？\n\n{sample}\n\n"
                    "会先去掉只读属性；仍被占用的会改名后删除，"
                    "实在不行就登记到重启后删除。"):
                return
            ok, fail, pending = hard_delete(paths)
        msg = f"已删除 {len(ok)} 个"
        if pending:
            msg += f"，{len(pending)} 个已登记重启后删除"
        if fail:
            msg += f"，{len(fail)} 个失败"
        log(msg)
        for p, why in fail[:5]:
            log(f"   ✗ {os.path.basename(p)}：{why}")
        if ok or pending:
            do_scan()
        return len(ok), fail

    def on_tidy_menu(e):
        iid = tree.identify_row(e.y)
        if not iid:
            return
        tree.selection_set(iid)
        paths = row_paths(iid)
        is_file = iid in state.get("rows", {})
        m = tk.Menu(root, tearoff=0)
        if is_file:
            m.add_command(label="预览",
                          command=lambda: preview_file(paths[0], row_paths(
                              tree.parent(iid)) or paths))
            m.add_command(label="打开文件", command=lambda: open_with_default(paths[0]))
            m.add_command(label="打开所在位置", command=lambda: reveal_in_explorer(paths[0]))
        else:
            m.add_command(label=f"展开（{len(paths)} 个文件）",
                          command=lambda: tree.item(iid, open=True))
            m.add_command(label="折叠", command=lambda: tree.item(iid, open=False))
            m.add_separator()
            m.add_command(label="打开所在位置",
                          command=lambda: reveal_in_explorer(paths[0]) if paths else None)
        m.add_command(label="复制路径",
                      command=lambda: (root.clipboard_clear(),
                                       root.clipboard_append("\n".join(paths))))
        m.add_separator()
        label = "" if is_file else f"这一组 {len(paths)} 个文件 · "
        m.add_command(label=label + "移到回收站",
                      command=lambda: tidy_delete(paths, "trash"))
        m.add_command(label=label + "永久删除…",
                      command=lambda: tidy_delete(paths, "permanent"))
        m.add_command(label=label + "强制删除…",
                      command=lambda: tidy_delete(paths, "hard"))
        m.add_separator()
        # 整个文件夹删除
        folders = []
        for p in paths:
            d = os.path.dirname(p)
            if os.path.normcase(d) not in [os.path.normcase(x) for x in folders]:
                folders.append(d)
        flabel = "删除所在文件夹…" if len(folders) <= 1 else f"删除这 {len(folders)} 个文件夹…"
        m.add_command(label=flabel,
                      command=lambda: delete_folders(folders), foreground="#b3261e")
        if not is_file:
            m.add_separator()
            m.add_command(label="选中这一组全部文件",
                          command=lambda: (tree.selection_set(iid), tree.item(iid, open=True)))
        m.tk_popup(e.x_root, e.y_root)

    def on_tidy_double(e):
        iid = tree.identify_row(e.y)
        if not iid:
            return
        if iid in state.get("rows", {}):
            preview_file(state["rows"][iid], row_paths(tree.parent(iid)))
        else:
            tree.item(iid, open=not bool(tree.item(iid, "open")))

    tree.bind("<Button-3>", on_tidy_menu)
    tree.bind("<Double-1>", on_tidy_double)

    def on_tree_click(e):
        iid = tree.identify_row(e.y)
        if not iid:
            return None
        col = tree.identify_column(e.x)
        if col == "#1":                      # 点「选」整格 → 切换勾选
            toggle_row(iid)
            return "break"
        # 分组行：点这一行的任何位置都能展开/收起（不用去戳那个小三角）
        if iid in state["groups"]:
            tree.selection_set(iid)
            tree.item(iid, open=not bool(tree.item(iid, "open")))
            return "break"
        return None

    def on_tree_space(e):
        sel = tree.selection()
        if not sel:
            return "break"
        for iid in sel:
            toggle_row(iid)
        return "break"

    def on_tree_ctrl_a(e):
        check_all(True)
        return "break"

    tree.bind("<Button-1>", on_tree_click)
    tree.bind("<space>", on_tree_space)
    tree.bind("<Control-a>", on_tree_ctrl_a)
    tree.bind("<Control-A>", on_tree_ctrl_a)

    f2 = ttk.Frame(nb)
    nb.add(f2, text="跳过明细")
    skip_tree = ttk.Treeview(f2, columns=("name", "why"), show="headings")
    skip_tree.heading("name", text="文件名")
    skip_tree.heading("why", text="跳过原因")
    skip_tree.column("name", width=420)
    skip_tree.column("why", width=280)
    skip_tree.pack(fill="both", expand=True, padx=4, pady=4)

    # ── 高级规则（集成 organize 引擎）──
    f3 = page_rules
    f3.configure(padding=(0, 0))

    rt = ttk.Frame(f3)
    rt.pack(fill="x", padx=14, pady=(0, 6))

    rule_txt = tk.Text(f3, height=14, wrap="none", font=("Consolas", 9))
    rule_txt.insert("1.0", RULES_TEMPLATE)

    def rules_get():
        return rule_txt.get("1.0", "end")

    def rules_load():
        p = filedialog.askopenfilename(filetypes=[("YAML", "*.yaml *.yml"), ("全部", "*.*")])
        if not p:
            return
        try:
            with open(p, encoding="utf-8-sig") as f:
                text = f.read()
        except OSError as ex:
            messagebox.showerror("读取失败", str(ex))
            return
        rule_txt.delete("1.0", "end")
        rule_txt.insert("1.0", text)
        log(f"[规则] 已载入 {p}")

    def rules_check():
        msg, ok = check_rules(rules_get())
        log(("[规则] " if ok else "[规则] 失败：") + msg)

    def rules_sim():
        out, ok = run_rules(rules_get(), simulate=True)
        log("[规则·预演]")
        for line in out.rstrip().splitlines():
            log("  " + line)
        if not ok:
            log("  （执行中报错，详见上文）")

    def rules_run():
        if not organize_available():
            messagebox.showerror("不可用", "打包时未包含 organize 引擎")
            return
        if not messagebox.askyesno(
                "确认执行",
                "将按当前 YAML 规则真实移动文件。\n\n"
                "organize 的 move/copy/delete 等动作会直接生效，"
                "本工具的内置撤销不能回退它的操作。\n\n继续？"):
            return
        out, ok = run_rules(rules_get(), simulate=False)
        log("[规则·执行]")
        for line in out.rstrip().splitlines():
            log("  " + line)

    def rules_help():
        """薄壳：注入父窗口。"""
        return _rules_help(root)

    ttk.Button(rt, text="载入配置…", command=rules_load).pack(side="left")
    ttk.Button(rt, text="校验", command=rules_check).pack(side="left", padx=6)
    ttk.Button(rt, text="预演", command=rules_sim).pack(side="left")
    ttk.Button(rt, text="执行", command=rules_run).pack(side="left", padx=6)
    ttk.Button(rt, text="说明", command=rules_help).pack(side="left", padx=(10, 0))
    ttk.Label(rt, text="引擎：organize v3（MIT）" if organize_available()
              else "引擎：未打包", foreground="#777").pack(side="right")

    rule_txt.pack(fill="both", expand=True, padx=14, pady=(0, 4))

    # ══════════════════ 清理截图 ══════════════════
    page_shots = pages["截图"]
    shot_dirs_var = tk.StringVar(
        value=";".join(S.get("shot_dirs") or shot_dirs_default()))
    sp_top = ttk.Frame(page_shots)
    sp_top.pack(fill="x", padx=14, pady=(14, 6))
    ttk.Label(sp_top, text="要清理的目录：").pack(side="left")
    shot_dirs_sum = tk.StringVar(value="")
    ttk.Label(sp_top, textvariable=shot_dirs_sum,
              foreground="#555").pack(side="left", padx=4)
    ttk.Label(sp_top, text="（可同时管理多个目录）",
              foreground="#a8adb5",
              font=("Microsoft YaHei UI", 9)).pack(side="left")

    def shot_dirs_list():
        raw = [x.strip().strip('"') for x in shot_dirs_var.get().split(";") if x.strip()]
        return raw or shot_dirs_default()

    def refresh_shot_sum():
        ds = shot_dirs_list()
        exists = [d for d in ds if os.path.isdir(d)]
        shot_dirs_sum.set("%d 个目录（%d 个存在）" % (len(ds), len(exists)))

    def pick_shot_dir():
        d = filedialog.askdirectory(title="选择要清理截图的目录")
        if not d:
            return
        d = os.path.normpath(d)
        cur = shot_dirs_list()
        if os.path.normcase(d) not in [os.path.normcase(x) for x in cur]:
            cur.append(d)
        shot_dirs_var.set(";".join(cur))
        S["shot_dirs"] = shot_dirs_list()
        save_settings(S)
        refresh_shot_sum()
        shot_dir_win_refresh()
        log("[截图] 已添加目录：%s" % d)

    def reset_shot_dirs():
        shot_dirs_var.set(";".join(shot_dirs_default()))
        S["shot_dirs"] = shot_dirs_list()
        save_settings(S)
        refresh_shot_sum()
        shot_dir_win_refresh()
        log("[截图] 已恢复默认目录（图片\\Screenshots、桌面、下载）")

    ttk.Button(sp_top, text="目录…", command=lambda: shot_dir_manager()
               ).pack(side="left", padx=(10, 4))
    ttk.Button(sp_top, text="用默认目录", command=reset_shot_dirs).pack(side="left")

    # ── 多目录管理窗口 ──
    dir_win = {"w": None}
    dir_tree = {"t": None}

    def shot_dir_win_refresh():
        t = dir_tree.get("t")
        if not t or not t.winfo_exists():
            return
        for i in t.get_children():
            t.delete(i)
        for i, d in enumerate(shot_dirs_list()):
            ok = os.path.isdir(d)
            n = ""
            if ok:
                try:
                    n = str(sum(1 for _e in os.scandir(d) if _e.is_file()))
                    n += " 个文件"
                except OSError:
                    n = "无法读取"
            t.insert("", "end", iid=str(i), values=(
                "☑", d, "存在" if ok else "不存在", n))

    def shot_dir_manager():
        if dir_win["w"] and dir_win["w"].winfo_exists():
            dir_win["w"].deiconify()
            dir_win["w"].lift()
            shot_dir_win_refresh()
            return
        w = tk.Toplevel(root)
        w.title("管理截图目录")
        w.geometry("760x420")
        w.minsize(660, 380)
        w.transient(root)
        dir_win["w"] = w
        # 底部按钮先 pack 到 bottom 占住高度；否则上面 expand 的表格会把它
        # 挤成几个像素，按钮文字被切掉一半
        bt = ttk.Frame(w)
        bt.pack(side="bottom", fill="x", padx=12, pady=(6, 10))
        ttk.Label(w, text="这些目录会一起扫描；取消勾选的暂时跳过。",
                  foreground="#666").pack(anchor="w", padx=12, pady=(10, 4))
        wrap = ttk.Frame(w)
        wrap.pack(fill="both", expand=True, padx=12)
        t = ttk.Treeview(wrap, columns=("sel", "path", "st", "n"),
                         show="headings", height=8)
        for c, txt, wd, an in (("sel", "启用", 56, "center"),
                               ("path", "目录", 430, "w"),
                               ("st", "状态", 90, "center"),
                               ("n", "概览", 120, "w")):
            t.heading(c, text=txt)
            t.column(c, width=wd, anchor=an)
        t.pack(side="left", fill="both", expand=True)
        sb = ttk.Scrollbar(wrap, orient="vertical", command=t.yview)
        t.configure(yscrollcommand=sb.set)
        sb.pack(side="left", fill="y")
        dir_tree["t"] = t
        t.tag_configure("off", foreground="#b0b4bb")

        def toggle(e):
            if t.identify_column(e.x) != "#1":
                return
            iid = t.identify_row(e.y)
            if not iid:
                return
            on = t.set(iid, "sel") != "☑"
            t.set(iid, "sel", "☑" if on else "☐")
            path = t.set(iid, "path")
            cur = shot_dirs_list()
            if on:
                if all(os.path.normcase(x) != os.path.normcase(path) for x in cur):
                    cur.append(path)
            else:
                cur = [x for x in cur if os.path.normcase(x) != os.path.normcase(path)]
            shot_dirs_var.set(";".join(cur))
            S["shot_dirs"] = shot_dirs_list()
            save_settings(S)
            refresh_shot_sum()
            return "break"

        t.bind("<Button-1>", toggle)

        ttk.Button(bt, text="添加目录…", command=pick_shot_dir).pack(side="left")
        ttk.Button(bt, text="恢复默认", command=reset_shot_dirs).pack(side="left", padx=6)

        def rm_selected():
            sel = t.selection()
            if not sel:
                messagebox.showinfo("提示", "先在列表里选中要移除的目录")
                return
            drop = {os.path.normcase(t.set(i, "path")) for i in sel}
            keep = [x for x in shot_dirs_list()
                    if os.path.normcase(x) not in drop]
            shot_dirs_var.set(";".join(keep))
            S["shot_dirs"] = shot_dirs_list()
            save_settings(S)
            refresh_shot_sum()
            shot_dir_win_refresh()

        ttk.Button(bt, text="移除选中", command=rm_selected).pack(side="left")
        ttk.Button(bt, text="关闭", command=w.destroy).pack(side="right")
        shot_dir_win_refresh()

    refresh_shot_sum()

    sp_opts = ttk.Frame(page_shots)
    sp_opts.pack(fill="x", padx=14, pady=(0, 6))
    ttk.Label(sp_opts, text="保留最近").pack(side="left")
    keep_var = tk.StringVar(value=str(S.get("shot_keep_days", 7)))
    ttk.Spinbox(sp_opts, from_=0, to=3650, textvariable=keep_var,
                width=6).pack(side="left", padx=4)
    ttk.Label(sp_opts, text="天的截图，更早的才清理").pack(side="left")

    ttk.Label(sp_opts, text="   小于").pack(side="left")
    minkb_var = tk.StringVar(value=str(S.get("shot_min_kb", 0)))
    ttk.Spinbox(sp_opts, from_=0, to=1048576, textvariable=minkb_var,
                width=7).pack(side="left", padx=4)
    ttk.Label(sp_opts, text="KB 的忽略（0=不限）").pack(side="left")

    trash_var = tk.BooleanVar(value=bool(S.get("shot_to_trash", True)))
    ttk.Checkbutton(sp_opts, text="移入回收站（可还原）",
                    variable=trash_var).pack(side="left", padx=(16, 0))

    sp_bar = ttk.Frame(page_shots)
    sp_bar.pack(fill="x", padx=14, pady=(0, 6))
    shot_info = tk.StringVar(value="还没扫描")
    shot_checked = set()
    shot_rows = {}

    def shot_dirs_now():
        raw = [x.strip().strip('"') for x in shot_dirs_var.get().split(";") if x.strip()]
        return raw or shot_dirs_default()

    def do_shot_scan(silent=False):
        try:
            keep = max(0, int(keep_var.get()))
        except ValueError:
            keep = 7
        try:
            mk = max(0, int(minkb_var.get()))
        except ValueError:
            mk = 0
        dirs = shot_dirs_now()
        bad = [d for d in dirs if not os.path.isdir(d)]
        if bad:
            log("[截图] 跳过不存在的目录：" + "；".join(bad[:4]))

        def work(rep):
            return find_screenshots(dirs, keep, mk, progress=rep)

        def done(hits):
            for i in shot_tree.get_children():
                shot_tree.delete(i)
            shot_checked.clear()
            shot_rows.clear()
            _THUMB_CACHE.clear()
            total = 0
            for p, sz, mt in hits:
                ic = shot_icon(p)
                iid = shot_tree.insert("", "end", text=" " + os.path.basename(p),
                                       image=ic, tags=("row",),
                                       values=("☐", os.path.dirname(p), human(sz),
                                               datetime.datetime.fromtimestamp(mt)
                                               .strftime("%Y-%m-%d %H:%M")))
                shot_rows[iid] = p
                total += sz
            if hits:
                shot_info.set(f"{len(hits)} 张截图 / {human(total)}，保留最近 {keep} 天")
                log(f"[截图] 扫到 {len(hits)} 张（{human(total)}）")
            else:
                # 扫到 0 张时要说清到底为什么，否则用户会以为功能坏了
                try:
                    all_shots = find_screenshots(keep_days=0)
                except Exception:
                    all_shots = []
                n_all = len(all_shots)
                if n_all:
                    shot_info.set(f"{n_all} 张截图全部在最近 {keep} 天内，按设置不清理")
                    if not silent:
                        log(f"[截图] 命名的截图共 {n_all} 张，但都在最近 {keep} 天内，"
                            f"按当前设置不列入清理。")
                        log("       想清理就把「保留最近」改小（填 0 表示不过滤），再点扫描。")
                else:
                    shot_info.set("这些目录里没有符合截图命名特征的文件")
                    if not silent:
                        log("[截图] 没有命中：按文件名特征（屏幕截图 / Screenshot / Snipaste / "
                            "微信截图 / QQ截图 …）没找到图片。")
                        log("       普通照片不会被当成截图；要加别的目录点右侧「目录…」。")

        run_task("正在扫描截图…", work, done)

    def shot_check_all(on=True):
        for iid in shot_rows:
            if shot_tree.exists(iid):
                shot_tree.set(iid, "sel", "☑" if on else "☐")
                (shot_checked.add if on else shot_checked.discard)(iid)
        shot_refresh()

    def shot_refresh():
        n = len([i for i in shot_checked if shot_tree.exists(i)])
        shot_sel.set(f"已选 {n} 张" if n else "未选")
        for iid in shot_rows:
            if shot_tree.exists(iid):
                shot_tree.item(iid, tags=("sel_on",) if iid in shot_checked else ("row",))

    shot_sel = tk.StringVar(value="未选")

    def do_shot_clean(only_checked=False):
        if only_checked:
            paths = [shot_rows[i] for i in shot_checked if i in shot_rows]
        else:
            paths = list(shot_rows.values())
        if not paths:
            messagebox.showinfo("没有可清理的", "先点「扫描」看看有哪些截图。")
            return
        size = 0
        for p in paths:
            try:
                size += os.path.getsize(p)
            except OSError:
                pass
        where = "移入回收站" if trash_var.get() else "永久删除"
        if not messagebox.askyesno(
                "清理截图",
                f"将{where} {len(paths)} 张截图（{human(size)}）。\n"
                + ("\n回收站可以还原。" if trash_var.get() else "\n⚠ 无法还原！")
                + "\n\n继续？"):
            return
        def work(rep):
            rep(0, 0, "正在删除 %d 张截图…" % len(paths))
            if trash_var.get():
                return trash_delete(paths)
            return delete_paths(paths, progress=rep)

        def done(res):
            ok, fail = res
            log(f"[截图] 已清理 {len(ok)} 张，释放 {human(size)}，失败 {len(fail)}")
            S["shot_dirs"] = shot_dirs_now()
            S["shot_keep_days"] = max(0, int(keep_var.get() or 7))
            S["shot_min_kb"] = max(0, int(minkb_var.get() or 0))
            S["shot_to_trash"] = trash_var.get()
            save_settings(S)
            do_shot_scan(silent=True)

        run_task("正在清理截图…", work, done)

    def shot_toggle(iid):
        on = shot_tree.set(iid, "sel") != "☑"
        shot_tree.set(iid, "sel", "☑" if on else "☐")
        (shot_checked.add if on else shot_checked.discard)(iid)
        shot_refresh()

    ttk.Button(sp_bar, text="扫描", command=do_shot_scan).pack(side="left")

    def _shot_clean_menu(m):
        n = len([i for i in shot_checked if shot_tree.exists(i)])
        m.add_command(label="清理选中的 %d 张…" % n,
                      command=lambda: do_shot_clean(True))
        m.add_command(label="清理全部（更早的）…",
                      command=lambda: do_shot_clean(False))
        m.add_separator()
        m.add_command(label="按当前设置试跑一次", command=test_shot_task)

    menu_btn(sp_bar, "清理 ▾", _shot_clean_menu).pack(side="left", padx=8)

    def _shot_sel_menu(m):
        m.add_command(label="全选", command=lambda: shot_check_all(True))
        m.add_command(label="反选",
                      command=lambda: [shot_toggle(i) for i in list(shot_rows)])
        m.add_command(label="清空", command=lambda: shot_check_all(False))

    menu_btn(sp_bar, "选择 ▾", _shot_sel_menu).pack(side="left")
    ttk.Label(sp_bar, textvariable=shot_info, foreground="#555").pack(side="left", padx=14)
    ttk.Label(sp_bar, textvariable=shot_sel, foreground="#777").pack(side="right")

    sp_note = ttk.Frame(page_shots)
    sp_note.pack(fill="x", padx=14, pady=(0, 6))
    sp_note_lbl = ttk.Label(
        sp_note, foreground="#a8adb5", font=("Microsoft YaHei UI", 9),
        text="按文件名特征识别（屏幕截图 / Screenshot / Snipaste / 微信截图 / QQ截图 等），"
             "只清图片和录屏，不碰文档。点「选」列或双击整行即可勾选；右键有更多操作。")
    sp_note_lbl.pack(anchor="w")

    _note_fit = fit_wraplength(sp_note, sp_note_lbl, 260, 20, 140, page_shots)

    sp_note.bind("<Configure>", _note_fit)

    shot_tree = ttk.Treeview(page_shots, columns=("sel", "dir", "size", "time"),
                             show="tree headings", selectmode="extended")
    shot_tree.heading("#0", text="文件名")
    shot_tree.heading("sel", text="选")
    shot_tree.heading("dir", text="所在目录")
    shot_tree.heading("size", text="大小")
    shot_tree.heading("time", text="修改时间")
    shot_tree.column("#0", width=270)
    shot_tree.column("sel", width=56, minwidth=56, anchor="center", stretch=False)
    shot_tree.column("dir", width=300)
    shot_tree.column("size", width=80, anchor="e")
    shot_tree.column("time", width=130, anchor="e")
    shot_tree.tag_configure("row", font=("Microsoft YaHei UI", 9))
    shot_tree.tag_configure("sel_on", font=("Microsoft YaHei UI", 9, "bold"),
                            foreground="#0d59d0")
    shot_tree.pack(fill="both", expand=True, padx=14, pady=(0, 6))

    def on_shot_click(e):
        if shot_tree.identify_column(e.x) != "#1":
            return
        iid = shot_tree.identify_row(e.y)
        if iid:
            shot_toggle(iid)
            return "break"

    def on_shot_dbl(e):
        iid = shot_tree.identify_row(e.y)
        if iid in shot_rows:
            shot_toggle(iid)
            return "break"

    def shot_menu(e):
        iid = shot_tree.identify_row(e.y)
        if iid not in shot_rows:
            return
        shot_tree.selection_set(iid)
        p = shot_rows[iid]
        m = tk.Menu(root, tearoff=0)
        m.add_command(label="预览",
                      command=lambda: preview_file(
                          p, [shot_rows[k] for k in shot_tree.get_children("")]))
        m.add_command(label="打开位置", command=lambda: reveal_in_explorer(p))
        m.add_separator()
        m.add_command(label="勾选 / 取消勾选",
                      command=lambda: shot_toggle(iid))
        m.add_command(label="只清理这一张…",
                      command=lambda: (shot_checked.clear(),
                                       shot_checked.add(iid),
                                       do_shot_clean(True)))
        m.add_command(label="删除这一张（回收站）",
                      command=lambda: (trash_delete([p]),
                                       log("[截图] 已删除 %s" % os.path.basename(p)),
                                       do_shot_scan(silent=True)))
        m.add_separator()
        m.add_command(label="全选", command=lambda: shot_check_all(True))
        m.add_command(label="反选", command=lambda: [shot_toggle(i) for i in shot_rows])
        m.tk_popup(e.x_root, e.y_root)

    shot_tree.bind("<Button-1>", on_shot_click)
    shot_tree.bind("<Double-1>", on_shot_dbl)
    shot_tree.bind("<Button-3>", shot_menu)

    # ── 定时自动清理 ──
    sp_sched = ttk.Frame(page_shots)
    sp_sched.pack(fill="x", padx=14, pady=(0, 12))
    # 让「每天自动清理」一行固定在表格上方，窗口变矮也不会被挤掉
    sp_sched.pack_configure(before=shot_tree)
    auto_var = tk.BooleanVar(value=bool(S.get("shot_auto", False)))
    shot_time_var = tk.StringVar(value=S.get("shot_time", "23:30"))
    shot_task_status = tk.StringVar(value="")
    shot_on = tk.BooleanVar(value=False)

    def refresh_shot_task():
        ok, nxt, _ = task_query(SHOT_TASK)
        if ok:
            shot_task_status.set(f"已启用（下次 {nxt}）" if nxt else "已启用")
            shot_on.set(True)
        else:
            shot_task_status.set("未设置")
            shot_on.set(False)

    def make_shot_task():
        when = check_when(shot_time_var.get())
        if not when:
            messagebox.showinfo("提示", "时间格式要写成 HH:MM，例如 23:30")
            return
        shot_time_var.set(when)
        save_shot_settings()
        tr = '%s --clean-shots' % _task_runner()
        ok, err, nxt = task_create(SHOT_TASK, when, tr)
        if ok:
            log(f"[截图] 已创建计划任务：每天 {when} 自动清理")
            auto_var.set(True)
            save_shot_settings()
            messagebox.showinfo("已创建",
                                f"每天 {when} 自动清理截图。\n\n"
                                + (f"下次运行：{nxt}" if nxt else "")
                                + "\n\n想立刻验证就点「立即试跑」。")
        else:
            messagebox.showerror("创建失败",
                                 (err[:500] or "未知错误")
                                 + "\n\n任务没建成。先点「立即试跑」确认"
                                   "清理命令本身能跑，再看是不是系统策略挡了。")
        refresh_shot_task()

    def test_shot_task():
        if not messagebox.askyesno(
                "立即试跑",
                "会按当前设置（保留 %s 天、忽略小于 %s KB）真的清理一次截图。\n"
                % (keep_var.get(), minkb_var.get())
                + ("文件进回收站，可以还原。" if trash_var.get()
                   else "⚠ 永久删除，无法还原！")
                + "\n\n继续？"):
            return
        save_shot_settings()
        cmd = '%s --clean-shots' % _task_runner()
        ok, info = task_run_now(cmd)
        log("[截图] 试跑" + ("成功" if ok else "失败：") + str(info))
        do_shot_scan(silent=True)
        if ok:
            messagebox.showinfo("试跑成功", "清理命令执行完了，列表已刷新。")
        else:
            messagebox.showerror("试跑失败", str(info))

    def del_shot_task():
        ok, err = task_delete(SHOT_TASK)
        if ok:
            log("[截图] 已删除清理计划任务")
            auto_var.set(False)
            save_shot_settings()
        else:
            messagebox.showinfo("提示", (err[:300] or "没有找到计划任务"))
        refresh_shot_task()

    def save_shot_settings():
        S["shot_dirs"] = shot_dirs_now()
        try:
            S["shot_keep_days"] = max(0, int(keep_var.get()))
        except ValueError:
            S["shot_keep_days"] = 7
        try:
            S["shot_min_kb"] = max(0, int(minkb_var.get()))
        except ValueError:
            S["shot_min_kb"] = 0
        S["shot_to_trash"] = trash_var.get()
        S["shot_auto"] = auto_var.get()
        S["shot_time"] = shot_time_var.get().strip()
        save_settings(S)

    def toggle_shot_task():
        if shot_on.get():
            make_shot_task()
            if not task_query(SHOT_TASK)[0]:
                shot_on.set(False)
        else:
            del_shot_task()

    ttk.Checkbutton(sp_sched, text="每天自动清理", variable=shot_on,
                    command=toggle_shot_task).pack(side="left")
    ttk.Entry(sp_sched, textvariable=shot_time_var,
              width=8).pack(side="left", padx=(10, 4))
    ttk.Button(sp_sched, text="改时间", command=make_shot_task).pack(side="left")
    ttk.Label(sp_sched, textvariable=shot_task_status, foreground="#666").pack(side="left", padx=8)
    ttk.Button(sp_sched, text="保存设置", command=lambda: (
        save_shot_settings(), log("[截图] 设置已保存"))).pack(side="right")

    # ══════════════════ 清理缓存 ══════════════════
    f5 = page_cache
    f5.configure(padding=(0, 0))

    cc_bar = ttk.Frame(f5)
    cc_bar.pack(fill="x", padx=14, pady=(10, 4))
    cc_info = tk.StringVar(value="还没扫描")
    cc_checked = set()
    cc_rows = {}

    cc_note_row = ttk.Frame(f5)
    cc_note_row.pack(fill="x", padx=14, pady=(0, 6))
    cc_note_lbl = ttk.Label(
        cc_note_row,
        text="只清理下面这些「已知缓存位置」。系统关键目录、程序安装目录、"
             "个人文档一律不碰；删不掉的（被占用）会自动跳过。",
        foreground="#a8adb5", font=("Microsoft YaHei UI", 9))
    cc_note_lbl.pack(anchor="w")

    _cc_note_fit = fit_wraplength(cc_note_row, cc_note_lbl, 260, 20)

    cc_note_row.bind("<Configure>", _cc_note_fit)

    # 没管理员权限时給一个明确的提权入口（系统级缓存要它）
    cc_admin_row = tk.Frame(f5, bg="#fff8e6", highlightthickness=1,
                            highlightbackground="#f2dfae")
    cc_admin_var = tk.StringVar()

    def _cc_admin_hint():
        if is_admin():
            cc_admin_var.set("管理员权限：已获得，可以清理系统级缓存")
        else:
            cc_admin_var.set("当前不是管理员，「系统」级的几项会失败"
                             "（Windows\\Temp、更新缓存等）")

    if not is_admin():
        cc_admin_row.pack(fill="x", padx=14, pady=(0, 6))
        tk.Label(cc_admin_row, textvariable=cc_admin_var, bg="#fff8e6",
                 fg="#8a6d1f", font=("Microsoft YaHei UI", 9),
                 anchor="w").pack(side="left", padx=10, pady=6)

        def _elevate_from_cache():
            if messagebox.askyesno(
                    "以管理员身份重启",
                    "会关闭当前窗口，并以管理员权限重新打开整理助手。\n"
                    "继续吗？"):
                relaunch_as_admin()
                root.destroy()

        ttk.Button(cc_admin_row, text="获取管理员权限",
                   command=_elevate_from_cache).pack(side="right",
                                                     padx=10, pady=4)
    _cc_admin_hint()

    cc_wrap = ttk.Frame(f5)
    cc_wrap.pack(fill="both", expand=True, padx=14, pady=(0, 4))

    cc_tree = ttk.Treeview(cc_wrap,
                           columns=("sel", "name", "group", "size", "n", "level", "path"),
                           show="headings", selectmode="extended", height=14)
    for col, txt, w, anchor in (
            ("sel", "选", 56, "center"), ("name", "名称", 190, "w"),
            ("group", "分类", 70, "center"), ("size", "大小", 90, "e"),
            ("n", "文件数", 80, "e"), ("level", "级别", 90, "center"),
            ("path", "路径", 420, "w")):
        cc_tree.heading(col, text=txt)
        cc_tree.column(col, width=w, anchor=anchor,
                       stretch=(col == "path"))
    cc_tree.tag_configure("L1", foreground="#1a7f37")
    cc_tree.tag_configure("L2", foreground="#b26a00")
    cc_tree.tag_configure("L3", foreground="#c0392b")
    cc_tree.tag_configure("empty", foreground="#b0b4bb")
    cc_vsb = ttk.Scrollbar(cc_wrap, orient="vertical", command=cc_tree.yview)
    cc_tree.configure(yscrollcommand=cc_vsb.set)
    cc_tree.pack(side="left", fill="both", expand=True)
    cc_vsb.pack(side="left", fill="y")

    # 边界说明：选中哪一项就说明「删什么、不动什么」
    cc_bound_var = tk.StringVar(
        value="选中一行可看它的清理边界：只删缓存子目录，不动你的数据。")
    cc_bound = tk.Label(f5, textvariable=cc_bound_var, anchor="w", justify="left",
                        bg="#f7f9fc", fg="#4a5568", padx=10, pady=6,
                        font=("Microsoft YaHei UI", 9), wraplength=1000)
    cc_bound.pack(fill="x", padx=14, pady=(0, 6))

    def cc_show_bound(*_):
        sel = cc_tree.selection()
        if not sel or sel[0] not in cc_rows:
            cc_bound_var.set("选中一行可看它的清理边界："
                             "只删缓存子目录，不动你的数据。")
            return
        row = cc_rows[sel[0]]
        it = row["item"]
        parts = ["【%s】级别：%s" % (it["name"], LEVEL_TEXT.get(it["level"], "?"))]
        if it.get("boundary"):
            parts.append("边界：" + it["boundary"])
        else:
            parts.append("边界：只删下列路径里的内容，同目录的其他文件不动")
        if it.get("note"):
            parts.append("说明：" + it["note"])
        cc_bound_var.set("　｜　".join(parts))

    cc_tree.bind("<<TreeviewSelect>>", cc_show_bound)

    def cc_on_click(e):
        """整格点选：点「选」这一列任意位置就切换勾选。"""
        iid = cc_tree.identify_row(e.y)
        if not iid or iid not in cc_rows:
            return None
        if cc_tree.identify_column(e.x) == "#1":
            cc_toggle(iid)
            return "break"
        return None

    cc_tree.bind("<Button-1>", cc_on_click)

    LEVEL_TEXT = {1: "安全", 2: "谨慎", 3: "高级"}

    def cc_custom_items():
        # 逻辑移到模块级 cache_custom_items()，--engine 也要用同一份
        return cache_custom_items()

    def cc_all_items():
        return CACHE_ITEMS + cc_custom_items()

    def cc_refresh_info():
        n = len([i for i in cc_checked if i in cc_rows])
        sel_size = sum(cc_rows[i]["size"] for i in cc_checked if i in cc_rows)
        total = sum(r["size"] for r in cc_rows.values())
        if n:
            cc_info.set("共 %s｜已勾选 %d 项 %s" % (human(total), n, human(sel_size)))
        elif cc_rows:
            cc_info.set("共 %s｜勾选后点「清理选中」" % human(total))
        elif S.get("_cc_scanned"):
            # 扫过了但一条都没命中，别显示成「还没扫描」
            cc_info.set("没扫到可清理的缓存（目录不存在或权限不足）")
        else:
            cc_info.set("还没扫描")

    def cc_toggle(iid, force=None):
        on = (iid not in cc_checked) if force is None else force
        cc_tree.set(iid, "sel", "☑" if on else "☐")
        (cc_checked.add if on else cc_checked.discard)(iid)
        cc_refresh_info()

    def cc_check_all(on=True):
        for iid in cc_rows:
            cc_toggle(iid, on)

    def cc_scan():
        cc_info.set("扫描中…")
        cc_checked.clear()
        for i in cc_tree.get_children():
            cc_tree.delete(i)
        cc_rows.clear()
        log("[缓存] 开始扫描…")
        items = [it for it in cc_all_items() if it["kind"] != "recycle"]

        def work(rep):
            res = []
            total = len(items) or 1
            for k, it in enumerate(items, 1):
                rep(k - 1, total, "正在统计 %s（%d/%d）" % (it["name"], k, total))
                real = []
                for pat in it["paths"]:
                    for p in _expand_cache_paths(pat):
                        bad, _why = cache_path_forbidden(p)
                        if bad:
                            continue
                        if p not in real:
                            real.append(p)
                size = count = 0
                for p in real:
                    s, c = _tree_size(p)
                    size += s
                    count += c
                res.append((it, real, size, count))
            return res

        run_task("正在扫描缓存…", work, cc_fill)

    def cc_fill(res):
        for it, real, size, count in sorted(res, key=lambda x: -x[2]):
            iid = cc_tree.insert("", "end", values=(
                "☐", it["name"], it.get("group", ""), human(size),
                ("%d" % count) if count else "—",
                LEVEL_TEXT.get(it["level"], "?"),
                "; ".join(real)[:300] if real else "（本机没有）"),
                tags=("L%d" % it["level"],) if real else ("empty",))
            cc_rows[iid] = dict(item=it, paths=real, size=size, count=count)
        S["_cc_scanned"] = True
        cc_refresh_info()
        log("[缓存] 扫描完成，共 %d 项" % len(cc_rows))
        if not cc_rows:
            log("       一条都没扫到：相关目录可能不存在，或当前权限读不到。")
            log("       点右上「获取管理员权限」重启后再扫一次。")

    def cc_clean(only_safe=False):
        if only_safe:
            targets = [i for i in cc_rows.keys()
                       if cc_rows[i]["paths"] and cc_rows[i]["item"]["level"] == 1]
        else:
            targets = [i for i in cc_checked if i in cc_rows]
            targets = [i for i in targets if cc_rows[i]["paths"]]
        if not targets:
            messagebox.showinfo("没有可清理的",
                                "先点「扫描缓存」，再勾选要清理的项。\n"
                                "或者直接点「清理推荐」——只清「安全」级别的项。")
            return
        size = sum(cc_rows[i]["size"] for i in targets)
        lines = []
        need_admin = False
        recycle = False
        for i in targets:
            it = cc_rows[i]["item"]
            if it["admin"] and not is_admin():
                need_admin = True
            if it["kind"] == "recycle":
                recycle = True
            lines.append("· %s  %s" % (it["name"], human(cc_rows[i]["size"])))
        msg = ("将清理 %d 项，预计释放 %s：\n\n%s\n"
               % (len(targets), human(size), "\n".join(lines[:14])))
        if len(lines) > 14:
            msg += "\n… 另有 %d 项" % (len(lines) - 14)
        if need_admin:
            msg += "\n\n⚠ 有项目需要管理员权限，未提权时会失败。"
        if recycle:
            msg += "\n⚠ 回收站会被清空，里面的文件将无法恢复。"
        msg += "\n\n缓存删掉后程序会自动重建，一般不影响使用。继续？"
        if not messagebox.askyesno("清理缓存", msg):
            return
        def work(rep):
            total_n = total_s = 0
            fails = []
            for k, i in enumerate(targets, 1):
                it = cc_rows[i]["item"]
                rep(k - 1, len(targets), "正在清理 %s（%d/%d）"
                    % (it["name"], k, len(targets)))
                if it["kind"] == "recycle":
                    ok, err = empty_recycle_bin()
                    if not ok:
                        fails.append(("回收站", err or "清空失败"))
                    else:
                        total_n += 1
                    continue
                n, f, s = clean_cache_paths(cc_rows[i]["paths"])
                total_n += n
                total_s += s
                fails.extend(f)
            return total_n, total_s, fails

        def done(res):
            total_n, total_s, fails = res
            log("[缓存] 已删 %d 个文件，释放 %s，失败 %d 项"
                % (total_n, human(total_s), len(fails)))
            if fails:
                for p, why in fails[:12]:
                    log("    跳过 %s：%s" % (p, why))
            cc_scan()
            _left_n = sum(r["size"] for r in cc_rows.values())
            if _left_n > 0:
                log("    清理后重新扫描：还剩 %d 项 / %s。"
                    % (len(cc_rows), human(_left_n)))
                log("    注意：浏览器、微信、Office 这类程序会**立刻重建**缓存；"
                    "想让它们真正降下来，先把对应程序退干净再清一次。")

        run_task("正在清理缓存…", work, done)

    def cc_menu(e):
        iid = cc_tree.identify_row(e.y)
        if not iid or iid not in cc_rows:
            return
        cc_tree.selection_set(iid)
        m = tk.Menu(root, tearoff=0)
        info = cc_rows[iid]
        m.add_command(label="打开第一个位置",
                      command=lambda: reveal_in_explorer(
                          info["paths"][0]) if info["paths"] else
                      messagebox.showinfo("提示", "本机没有这个目录"))
        m.add_command(label="复制路径", command=lambda: (
            root.clipboard_clear(),
            root.clipboard_append("; ".join(info["paths"])),
            log("[缓存] 路径已复制")))
        m.add_separator()
        m.add_command(label="只清理这一项…",
                      command=lambda: (cc_checked.clear(),
                                       cc_checked.add(iid),
                                       cc_clean()))
        if info["item"].get("id", "").startswith("custom:"):
            m.add_command(label="从列表移除（不删文件）",
                          command=lambda: cc_remove_custom(info["item"]["paths"][0]))
        m.tk_popup(e.x_root, e.y_root)

    def cc_remove_custom(path):
        cur = [p for p in (S.get("cache_custom_dirs") or [])
               if os.path.normcase(p) != os.path.normcase(path)]
        S["cache_custom_dirs"] = cur
        save_settings(S)
        cc_scan()

    def cc_add_custom():
        d = filedialog.askdirectory(title="添加要清理的缓存目录")
        if not d:
            return
        d = os.path.normpath(d)
        bad, why = cache_path_forbidden(d)
        if bad:
            messagebox.showwarning("这个目录不能清",
                                   "它属于「%s」，不在可清理范围内。\n%s" % (why, d))
            return
        # 程序目录保护：盘符根目录、程序安装目录、程序目录的父目录一律不许加
        why_app = check_cache_custom_dir(d)
        if why_app:
            messagebox.showwarning("这个目录不能当缓存目录",
                                   "%s\n\n%s\n\n"
                                   "加进去会被一次性清空，软件目录不会自动重建。"
                                   % (why_app, d))
            return
        cur = list(S.get("cache_custom_dirs") or [])
        if all(os.path.normcase(x) != os.path.normcase(d) for x in cur):
            cur.append(d)
            S["cache_custom_dirs"] = cur
            save_settings(S)
            log("[缓存] 已添加自定义目录：%s" % d)
        cc_scan()

    ttk.Button(cc_bar, text="扫描缓存", command=cc_scan).pack(side="left")

    def _cc_clean_menu(m):
        n = len([i for i in cc_checked if i in cc_rows])
        m.add_command(label="清理推荐（安全项）…",
                      command=lambda: cc_clean(True))
        m.add_command(label="清理选中的 %d 项…" % n,
                      command=lambda: cc_clean(False))
        m.add_separator()
        m.add_command(label="按任务设置试跑一次", command=test_cc_task)

    menu_btn(cc_bar, "清理 ▾", _cc_clean_menu).pack(side="left", padx=8)

    def _cc_sel_menu(m):
        m.add_command(label="全选", command=lambda: cc_check_all(True))
        m.add_command(label="反选",
                      command=lambda: [cc_toggle(i) for i in list(cc_rows)])
        m.add_command(label="清空", command=lambda: cc_check_all(False))
        m.add_separator()
        m.add_command(label="添加自定义目录…", command=cc_add_custom)

    menu_btn(cc_bar, "选择 ▾", _cc_sel_menu).pack(side="left")
    ttk.Label(cc_bar, textvariable=cc_info, foreground="#555").pack(side="right")

    cc_tree.bind("<Button-3>", cc_menu)
    cc_tree.bind("<Double-1>", lambda e: (
        cc_toggle(cc_tree.identify_row(e.y))
        if cc_tree.identify_row(e.y) in cc_rows else None))
    cc_tree.bind("<space>", lambda e: [cc_toggle(i) for i in
                                       cc_tree.selection() if i in cc_rows] and "break")

    # ── 每天自动清理缓存 ──
    cc_sched = ttk.Frame(f5)
    cc_sched.pack(fill="x", padx=14, pady=(6, 0))
    cc_time_var = tk.StringVar(value=S.get("cache_time", "23:40"))
    cc_task_status = tk.StringVar(value="")
    cc_on = tk.BooleanVar(value=False)

    def refresh_cc_task():
        ok, nxt, _ = task_query(CACHE_TASK)
        if ok:
            cc_task_status.set("已启用（下次 %s）" % nxt if nxt else "已启用")
            cc_on.set(True)
        else:
            cc_task_status.set("未设置")
            cc_on.set(False)

    def make_cc_task():
        when = check_when(cc_time_var.get())
        if not when:
            messagebox.showinfo("提示", "时间格式要写成 HH:MM，例如 23:40")
            return
        cc_time_var.set(when)
        S["cache_time"] = when
        save_settings(S)
        tr = '%s --clean-cache' % _task_runner()
        ok, err, nxt = task_create(CACHE_TASK, when, tr)
        if ok:
            log("[缓存] 已创建计划任务：每天 %s 自动清理（只清「安全」级别）"
                % when)
            messagebox.showinfo("已创建",
                                "每天 %s 自动清理缓存里的「安全」项。\n\n"
                                % when
                                + (f"下次运行：{nxt}" if nxt else "")
                                + "\n\n注意：计划任务以当前用户身份运行，"
                                  "「系统」级（Windows\\Temp 等）仍需管理员，"
                                  "被跳过的项会记在日志里。")
        else:
            messagebox.showerror("创建失败",
                                 (err[:500] or "未知错误")
                                 + "\n\n先点「立即试跑」确认清理命令本身能跑。")
        refresh_cc_task()

    def test_cc_task():
        if not messagebox.askyesno(
                "立即试跑",
                "会按「安全」级别真的清一次缓存（不动个人文件）。\n\n继续？"):
            return
        cmd = '%s --clean-cache' % _task_runner()
        ok, info = task_run_now(cmd)
        log("[缓存] 试跑" + ("成功" if ok else "失败：") + str(info))
        cc_scan()
        if ok:
            messagebox.showinfo("试跑成功", "清理命令执行完了，列表已刷新。")
        else:
            messagebox.showerror("试跑失败", str(info))

    def del_cc_task():
        ok, err = task_delete(CACHE_TASK)
        if ok:
            log("[缓存] 已删除清理计划任务")
        else:
            messagebox.showinfo("提示", (err[:300] or "没有找到计划任务"))
        refresh_cc_task()

    def toggle_cc_task():
        if cc_on.get():
            make_cc_task()
            if not task_query(CACHE_TASK)[0]:
                cc_on.set(False)
        else:
            del_cc_task()

    ttk.Checkbutton(cc_sched, text="每天自动清理缓存", variable=cc_on,
                    command=toggle_cc_task).pack(side="left")
    ttk.Entry(cc_sched, textvariable=cc_time_var,
              width=8).pack(side="left", padx=(10, 4))
    ttk.Button(cc_sched, text="改时间", command=make_cc_task).pack(side="left")
    ttk.Label(cc_sched, textvariable=cc_task_status,
              foreground="#666").pack(side="left", padx=8)
    ttk.Label(cc_sched, text="（定时任务只清「安全」级别，不碰谨慎/高级项）",
              foreground="#a8adb5", font=("Microsoft YaHei UI", 9)).pack(side="left")

    cc_log = ttk.Frame(f5)
    cc_log.pack(fill="x", padx=14, pady=(0, 12))

    # ── 卸载（参照 BCUninstaller）──
    f4 = page_un
    f4.configure(padding=(0, 0))

    ut = ttk.Frame(f4)
    ut.pack(fill="x", padx=14, pady=(0, 6))
    search_var = tk.StringVar()

    app_tree = ttk.Treeview(f4, columns=("pub", "ver", "size", "date", "loc"),
                            show="tree headings", height=12, selectmode="browse")
    app_tree.heading("#0", text="名称", command=lambda: sort_apps("name"))
    app_tree.column("#0", width=270, anchor="w")
    for col, txt, w in (("pub", "发布者", 150), ("ver", "版本", 90),
                        ("size", "大小", 90), ("date", "安装时间", 100),
                        ("loc", "安装位置", 300)):
        app_tree.heading(col, text=txt, command=lambda c=col: sort_apps(c))
        app_tree.column(col, width=w,
                        anchor="w" if col in ("pub", "loc") else "e")
    vsb = ttk.Scrollbar(f4, orient="vertical", command=app_tree.yview)
    app_tree.configure(yscrollcommand=vsb.set)
    app_tree.pack(side="left", fill="both", expand=True, padx=(14, 0), pady=(0, 4))
    vsb.pack(side="left", fill="y", pady=(0, 4))

    _icon_cache = {}       # exe 路径 -> PhotoImage（界面线程里建）
    _icon_rgb = {}         # exe 路径 -> (w,h,bytes)（工作线程里取）
    _sort = {"key": "name", "desc": False}

    def _app_photo(icon_path):
        """把工作线程取好的 RGB 转成 Tk 图片；没有就返回 None"""
        if not icon_path:
            return None
        if icon_path in _icon_cache:
            return _icon_cache[icon_path]
        rgb = _icon_rgb.get(icon_path)
        if not rgb:
            return None
        try:
            w, h, raw = rgb
            img = tk.PhotoImage(master=root, width=w, height=h)
            step = w * 4
            rows = []
            for y in range(h):
                off = y * step
                line = raw[off:off + step]
                cells = []
                for i in range(0, step, 4):
                    b, g, r, a = line[i], line[i + 1], line[i + 2], line[i + 3]
                    if a == 0:
                        cells.append("")
                    else:
                        cells.append("#%02x%02x%02x" % (r, g, b))
                rows.append("{%s}" % " ".join(cells))
            img.put(" ".join(rows))
            _icon_cache[icon_path] = img
            return img
        except Exception:
            _icon_cache[icon_path] = None
            return None

    def _fmt_date(ts):
        if not ts:
            return ""
        try:
            return datetime.datetime.fromtimestamp(ts).strftime("%Y-%m-%d")
        except Exception:
            return ""

    def _app_rows():
        """按当前搜索词与排序状态，返回要显示的 (app, size_text, date_text)"""
        kw = search_var.get().strip().lower()
        rows = []
        for a in state.get("apps", []):
            if kw and kw not in a["name"].lower() \
                    and kw not in a["publisher"].lower():
                continue
            rows.append(a)
        key = _sort["key"]

        def sk(a):
            if key == "name":
                return a["name"].lower()
            if key == "pub":
                return a["publisher"].lower()
            if key == "ver":
                return a["version"].lower()
            if key == "size":
                return a["size_kb"]
            if key == "date":
                return a["date"]
            return a["location"].lower()

        try:
            rows.sort(key=sk, reverse=_sort["desc"])
        except Exception:
            pass
        return rows

    def fill_apps():
        for i in app_tree.get_children():
            app_tree.delete(i)
        rows = _app_rows()
        total_kb = 0
        for idx, a in enumerate(rows):
            size_txt = f"{a['size_kb']/1024:.1f} MB" if a["size_kb"] else ""
            total_kb += a["size_kb"] or 0
            app_tree.insert(
                "", "end", text=" " + a["name"], tags=(str(idx),),
                image=_app_photo(a.get("icon")) or "",
                values=(a["publisher"], a["version"], size_txt,
                        _fmt_date(a.get("date")), a["location"]))
        state["app_rows"] = rows
        app_stat_var.set(
            "%d 个程序 · 合计 %.1f GB%s" % (
                len(rows), total_kb / 1024.0 / 1024.0,
                "" if is_admin() else " · 以普通权限运行"))
        return len(rows)

    def sort_apps(col):
        if _sort["key"] == col:
            _sort["desc"] = not _sort["desc"]
        else:
            _sort["key"], _sort["desc"] = col, False
        headers = {"name": "名称", "pub": "发布者", "ver": "版本",
                   "size": "大小", "date": "安装时间", "loc": "安装位置"}
        for k, label in headers.items():
            mark = ""
            if k == _sort["key"]:
                mark = " ▾" if _sort["desc"] else " ▴"
            if k == "name":
                app_tree.heading("#0", text=label + mark)
            else:
                app_tree.heading(k, text=label + mark)
        fill_apps()

    def refresh_apps():
        def work(rep):
            apps = list_installed_apps(progress=rep)
            # 图标在工作线程里取好（快，单个约 8ms），界面线程只负责转成图片
            rep(0, 0, "正在读取程序图标…")
            got = {}
            for a in apps:
                p = a.get("icon")
                if p and p not in got:
                    try:
                        got[p] = shell_thumb_rgb(p, 20)
                    except Exception:
                        got[p] = None
            return apps, got

        def done(res):
            apps, icons = res
            state["apps"] = apps
            _icon_cache.clear()
            _icon_rgb.clear()
            for k, v in icons.items():
                if v and len(k) < 260:
                    _icon_rgb[k] = v
            n = fill_apps()
            log(f"[卸载] 已列出 {n} / {len(apps)} 个程序")

        run_task("正在枚举已安装程序…", work, done, min_ms=600)

    def selected_app():
        sel = app_tree.selection()
        if not sel:
            messagebox.showinfo("提示", "先在列表里选一个程序")
            return None
        tags = app_tree.item(sel[0], "tags") or []
        rows = state.get("app_rows") or []
        try:
            return rows[int(tags[0])]
        except Exception:
            return None

    def do_normal_uninstall():
        app = selected_app()
        if not app:
            return
        if not app["uninstall"]:
            messagebox.showinfo("提示", "这个程序没有登记卸载命令，只能走「强制卸载」")
            return
        if not messagebox.askyesno("普通卸载",
                                   f"调用程序自带的卸载程序卸载：\n\n{app['name']}\n\n"
                                   f"命令：{app['uninstall'][:120]}\n\n会弹出该程序自己的卸载向导。"):
            return
        ok, info = run_uninstaller(app, quiet=False)
        log(f"[卸载] {'已启动' if ok else '启动失败'}：{app['name']}")
        if not ok:
            log(f"    {info}")

    def do_force_uninstall():
        app = selected_app()
        if not app:
            return
        warn = ("这一步会：\n"
                "1) 先调用程序自带卸载器（如果有）\n"
                "2) 扫描安装目录、AppData、注册表里的残留\n"
                "3) 备份注册表后删除\n\n"
                "删除不可恢复。确定要继续吗？")
        if not messagebox.askyesno("强制卸载 — 危险操作", f"{app['name']}\n\n{warn}"):
            return

        if app["uninstall"]:
            ok, info = run_uninstaller(app, quiet=True)
            log(f"[卸载] 已调用自带卸载器：{app['name']}")
            time.sleep(3)

        try:
            dirs, regs = scan_leftovers(app)
        except Exception as ex:
            log(f"[卸载] 残留扫描失败：{ex}")
            return

        if not dirs and not regs:
            log(f"[卸载] {app['name']}：没有发现残留")
            messagebox.showinfo("完成", "没有发现残留文件或注册表项。")
            return

        lines = [f"文件/目录（{len(dirs)}）："] + [f"  {d}" for d in dirs[:15]]
        if len(dirs) > 15:
            lines.append(f"  … 还有 {len(dirs)-15} 个")
        lines += [f"\n注册表项（{len(regs)}）："] + [f"  {h}\\{k}" for h, k in regs[:15]]
        if len(regs) > 15:
            lines.append(f"  … 还有 {len(regs)-15} 个")
        lines.append("\n\n确认删除请在下个对话框输入：删除")

        if not messagebox.askyesno("发现残留", "\n".join(lines) + "\n\n继续？"):
            return

        typed = simpledialog.askstring("最后确认", "输入「删除」两个字才会真正执行：",
                                       parent=None)
        if (typed or "").strip() != "删除":
            log("[卸载] 已取消（确认文字不匹配）")
            return

        # 备份注册表
        bdir = backup_dir()
        os.makedirs(bdir, exist_ok=True)
        stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        safe = "".join(c if c.isalnum() else "_" for c in app["name"])[:30]
        bkfile = os.path.join(bdir, f"{safe}_{stamp}.reg")
        exported = []
        for i, (h, k) in enumerate(regs):
            tmp = os.path.join(bdir, f"{safe}_{stamp}_{i}.reg")
            if export_reg_key(h, k, tmp):
                exported.append(tmp)
                try:
                    with open(tmp, encoding="utf-16", errors="ignore") as f:
                        txt = f.read()
                    with open(bkfile, "a", encoding="utf-16") as out:
                        out.write(txt)
                    os.remove(tmp)
                except OSError:
                    pass
        log(f"[卸载] 注册表已备份：{bkfile}")

        okd, faild = delete_paths(dirs)
        for p in okd:
            log(f"  已删除目录 {p}")
        for p, why in faild:
            log(f"  删除失败 {p}  <- {why}")

        for h, k in regs:
            if delete_reg_tree(h, k):
                log(f"  已删除注册表 {h}\\{k}")
            else:
                log(f"  删除注册表失败 {h}\\{k}（可能需要管理员）")

        log(f"[卸载] {app['name']} 清理完成")
        refresh_apps()

    # ── 右键菜单（参照 Geek Uninstaller）──
    def open_install_dir():
        app = selected_app()
        if not app:
            return
        d = app.get("location") or ""
        if not d or not os.path.isdir(d):
            messagebox.showinfo("提示", "这个程序没有记录有效的安装目录")
            return
        os.startfile(d)

    def open_regedit():
        app = selected_app()
        if not app:
            return
        import winreg
        hive = {"HKLM64": winreg.HKEY_LOCAL_MACHINE, "HKLM32": winreg.HKEY_LOCAL_MACHINE,
                "HKCU": winreg.HKEY_CURRENT_USER}[app["hive"]]
        try:
            with winreg.OpenKey(hive, app["key"], 0, winreg.KEY_READ):
                pass
        except OSError:
            pass
        # 用 regedit 打开到该键
        subprocess.Popen(["regedit", "/m", app["key"]] if False else ["regedit"])
        log(f"[注册表] {app['hive']}\\{app['key']}（已打开 regedit，请按此路径导航）")
        messagebox.showinfo("注册表位置",
                            f"{app['hive']}\\{app['key']}\n\n路径已复制到日志。")

    def delete_reg_only():
        app = selected_app()
        if not app:
            return
        dirs, regs = scan_leftovers(app)
        if not regs:
            messagebox.showinfo("提示", "没有找到可删除的注册表项")
            return
        txt = "\n".join(f"{h}\\{k}" for h, k in regs)
        if not messagebox.askyesno("只删注册表条目",
                                   f"{app['name']}\n\n将删除：\n{txt}\n\n"
                                   f"（不删文件）继续？"):
            return
        if (simpledialog.askstring("确认", "输入「删除」执行：") or "").strip() != "删除":
            return
        bdir = backup_dir()
        os.makedirs(bdir, exist_ok=True)
        stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        for i, (h, k) in enumerate(regs):
            safe = "".join(c if c.isalnum() else "_" for c in app["name"])[:30]
            export_reg_key(h, k, os.path.join(bdir, f"{safe}_{stamp}_{i}.reg"))
            if delete_reg_tree(h, k):
                log(f"  已删除 {h}\\{k}")
            else:
                log(f"  失败 {h}\\{k}（需管理员）")
        refresh_apps()

    def delete_files_only():
        app = selected_app()
        if not app:
            return
        dirs, regs = scan_leftovers(app)
        if not dirs:
            messagebox.showinfo("提示", "没有找到残留目录")
            return
        txt = "\n".join(dirs[:20])
        if not messagebox.askyesno("只删残留文件",
                                   f"{app['name']}\n\n将删除这些目录：\n{txt}\n\n"
                                   f"（不动注册表）继续？"):
            return
        if (simpledialog.askstring("确认", "输入「删除」执行：") or "").strip() != "删除":
            return
        ok, fail = delete_paths(dirs)
        for p in ok:
            log(f"  已删除 {p}")
        for p, why in fail:
            log(f"  失败 {p}  <- {why}")

    def backup_app_data():
        app = selected_app()
        if not app:
            return
        dirs, regs = scan_leftovers(app)
        if not dirs and not regs:
            messagebox.showinfo("提示", "没找到这个程序的数据")
            return
        dst_root = filedialog.askdirectory(title="把该程序的数据备份到哪里")
        if not dst_root:
            return
        safe = "".join(c if c.isalnum() else "_" for c in app["name"])[:40]
        stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        target = os.path.join(dst_root, f"{safe}_{stamp}")
        os.makedirs(target, exist_ok=True)
        n = 0
        for d in dirs:
            try:
                base = os.path.basename(d.rstrip("\\"))
                shutil.copytree(d, os.path.join(target, base), dirs_exist_ok=True)
                n += 1
            except Exception as ex:
                log(f"  复制失败 {d}  <- {ex}")
        for i, (h, k) in enumerate(regs):
            export_reg_key(h, k, os.path.join(target, f"registry_{i}.reg"))
        log(f"[备份] {app['name']} → {target}（{n} 个目录 + {len(regs)} 个注册表项）")
        messagebox.showinfo("完成", f"已备份到：\n{target}")

    def search_app():
        app = selected_app()
        if not app:
            return
        if open_everything_search(app["name"]):
            log(f"[Everything] 已搜索：{app['name']}")
        else:
            messagebox.showinfo("提示", "没有找到 Everything，可在「设置」里指定它的路径")

    def copy_app_info():
        app = selected_app()
        if not app:
            return
        text = (f"{app['name']}\n{app['version']}\n{app['publisher']}\n"
                f"{app['location']}\n{app['uninstall']}")
        root.clipboard_clear()
        root.clipboard_append(text)
        log(f"[复制] {app['name']} 的信息已复制")

    app_menu = tk.Menu(root, tearoff=0)
    app_menu.add_command(label="卸载(U)", command=do_normal_uninstall)
    app_menu.add_command(label="强制删除并清理残留(F)", command=do_force_uninstall)
    app_menu.add_separator()
    app_menu.add_command(label="仅删除注册表条目", command=delete_reg_only)
    app_menu.add_command(label="仅删除残留文件", command=delete_files_only)
    app_menu.add_separator()
    app_menu.add_command(label="打开安装文件夹", command=open_install_dir)
    app_menu.add_command(label="查看注册表位置", command=open_regedit)
    app_menu.add_separator()
    app_menu.add_command(label="备份该程序数据到…", command=backup_app_data)
    app_menu.add_command(label="用 Everything 搜索", command=search_app)
    app_menu.add_command(label="复制程序信息", command=copy_app_info)
    app_menu.add_command(label="在浏览器搜索该程序", command=lambda: (
        __import__("webbrowser").open_new_tab(
            "https://www.bing.com/search?q=" +
            __import__("urllib.parse", fromlist=["quote"]).quote(
                (selected_app() or {}).get("name", "")))))
    app_menu.add_command(label="打开程序所在 exe 位置", command=lambda: (
        (lambda a: subprocess.Popen(
            ["explorer", "/select,", os.path.normpath(a["icon"])])
         if a and a.get("icon") and os.path.exists(a["icon"])
         else messagebox.showinfo("提示", "这个程序没有记录可定位的 exe"))
        (selected_app())))

    def on_app_right_click(e):
        row = app_tree.identify_row(e.y)
        if row:
            app_tree.selection_set(row)
            try:
                app_menu.tk_popup(e.x_root, e.y_root)
            finally:
                app_menu.grab_release()

    app_tree.bind("<Button-3>", on_app_right_click)
    app_tree.bind("<Double-1>", lambda e: do_normal_uninstall())

    ttk.Button(ut, text="刷新列表", command=refresh_apps).pack(side="left")
    ttk.Label(ut, text="搜索：").pack(side="left", padx=(12, 2))
    se = ttk.Entry(ut, textvariable=search_var, width=18)
    se.pack(side="left")
    se.bind("<Return>", lambda e: fill_apps())
    se.bind("<KeyRelease>", lambda e: fill_apps())
    ttk.Button(ut, text="普通卸载", command=do_normal_uninstall).pack(side="left", padx=(16, 4))
    ttk.Button(ut, text="强制卸载（清理残留）", command=do_force_uninstall).pack(side="left")
    def _un_more(m):
        m.add_command(label="把程序列表导出为 CSV…",
                      command=lambda: do_export_apps())
        m.add_separator()
        m.add_command(label="以管理员身份重启",
                      command=lambda: relaunch_as_admin())

    menu_btn(ut, "更多 ▾", _un_more).pack(side="left", padx=(6, 0))

    def do_export_apps():
        rows = state.get("app_rows") or []
        if not rows:
            messagebox.showinfo("提示", "列表还是空的，先刷新一次")
            return
        path = filedialog.asksaveasfilename(
            title="导出程序列表", defaultextension=".csv",
            initialfile="已安装程序_%s.csv" %
                        datetime.datetime.now().strftime("%Y%m%d"),
            filetypes=[("CSV 表格", "*.csv")])
        if not path:
            return
        try:
            with open(path, "w", encoding="utf-8-sig", newline="") as f:
                w = csv.writer(f)
                w.writerow(["名称", "发布者", "版本", "大小(MB)", "安装时间", "安装位置"])
                for a in rows:
                    w.writerow([a["name"], a["publisher"], a["version"],
                                "%.1f" % (a["size_kb"] / 1024.0) if a["size_kb"] else "",
                                _fmt_date(a.get("date")), a["location"]])
            log(f"[卸载] 已导出 {len(rows)} 条到 {path}")
            messagebox.showinfo("导出完成", f"已保存：\n{path}")
        except OSError as ex:
            messagebox.showerror("导出失败", str(ex))

    # 没管理员权限时，橙色提示旁边直接给按钮（不藏到表格下面）
    if not is_admin():
        def _elevate_uninstall():
            if messagebox.askyesno(
                    "以管理员身份重启",
                    "会关闭当前窗口，并以管理员权限重新打开整理助手。\n"
                    "这样才能清理 Program Files 和 HKLM 注册表残留。\n\n继续吗？"):
                if relaunch_as_admin():
                    root.destroy()
                else:
                    messagebox.showwarning("提权失败", "用户取消了 UAC 授权。")

        ttk.Button(ut, text="获取管理员权限",
                   command=_elevate_uninstall).pack(side="right")
        ttk.Label(ut, text="普通权限", foreground="#a06000").pack(
            side="right", padx=(0, 8))
    else:
        ttk.Label(ut, text="管理员权限", foreground="#2f855a").pack(side="right")

    ub = ttk.Frame(f4)
    ub.pack(fill="x", padx=14, pady=(0, 6))
    app_stat_var = tk.StringVar(value="")
    ttk.Label(ub, textvariable=app_stat_var, foreground="#6b7280").pack(side="left")
    ttk.Label(ub, foreground="#b0b5bd",
              text="右键更多操作 · 双击卸载 · 点列头排序").pack(side="right")

    ub = ttk.Frame(f4)
    ub.pack(fill="x", padx=4, pady=(0, 4))
    ttk.Label(ub, foreground="#8b9199",
              text="右键单击程序可打开更多操作；强制卸载会先导出 .reg 备份，可回滚"
              ).pack(side="left", padx=10)

    # ── 搜索（自建索引 + Everything）──
    f5 = page_search
    f5.configure(padding=(0, 0))

    st1 = ttk.Frame(f5)
    st1.pack(fill="x", padx=14, pady=(10, 2))
    q_var = tk.StringVar()
    idx_var = tk.StringVar(value="")
    hit_var = tk.StringVar(value="输入关键字后回车")

    def refresh_idx_status():
        try:
            es = find_es()
            backend = "Everything" if es else "本地索引"
            idx_var.set(f"后端：{backend}    已索引 {index_count():,} 个文件    "
                        f"索引缓存：{cache_dir()}")
        except Exception:
            idx_var.set("索引：读取失败")

    def do_search(event=None):
        kw = q_var.get().strip()
        if not kw:
            hit_var.set("先输入要搜的文件名，比如 报告 或 .pdf")
            return
        for i in res_tree.get_children():
            res_tree.delete(i)
        hit_var.set("搜索中…")
        root.update_idletasks()
        rows, src = None, ""
        try:
            rows = es_search(kw, limit=800)
            if rows is not None:
                src = "Everything"
        except Exception:
            rows = None
        if rows is None:
            if index_count() == 0:
                if not messagebox.askyesno(
                        "还没有索引",
                        "这台机器上没找到 es.exe，本地索引也还是空的。\n\n"
                        "是否立即为常用位置建立索引？\n"
                        "（桌面、文档、下载）\n\n"
                        "首次会比较慢，之后搜索是毫秒级。"):
                    hit_var.set("本地索引是空的，先建索引才能搜")
                    return
                roots = default_index_roots()
                S["index_roots"] = roots
                save_settings(S)
                if "sync_roots" in state:
                    state["sync_roots"]()
                rebuild_index()
                return
            try:
                rows = search_index(kw, limit=800)
                src = "本地索引"
            except Exception as ex:
                hit_var.set("搜索出错：" + str(ex))
                return
        n = 0
        for path, name, size, mtime in rows:
            when = (datetime.datetime.fromtimestamp(mtime).strftime("%Y-%m-%d")
                    if mtime else "")
            res_tree.insert("", "end", values=(
                name, os.path.dirname(path), human(size), when),
                tags=(path,))
            n += 1
        hit_var.set(f"找到 {n} 个结果（{src}）" if n
                    else f"没有匹配「{kw}」的文件（{src}）")

    def rebuild_index():
        roots = S.get("index_roots") or []
        if not roots:
            messagebox.showinfo("提示", "先到「设置」里添加要索引的目录")
            return
        log(f"[索引] 开始建立，共 {len(roots)} 个根目录…")

        def work(rep):
            def cb(count):
                rep(0, 0, "已索引 %s 个文件…" % format(count, ","))
            return build_index(roots, progress=cb)

        def done(res):
            n, errs = res
            log(f"[索引] 完成：{n} 个文件")
            refresh_idx_status()

        run_task("正在建立索引…", work, done)

    def _res_path(iid=None):
        sel = (iid,) if iid else res_tree.selection()
        if not sel:
            return None
        v = res_tree.item(sel[0], "values")
        if len(v) < 2:
            return None
        return os.path.join(v[1], v[0])

    def open_result():
        p = _res_path()
        if p and os.path.exists(p):
            os.startfile(p)
        elif p:
            messagebox.showinfo("找不到", "这个文件已经不在了：\n" + p)

    def open_result_dir():
        p = _res_path()
        if not p:
            return
        if os.path.exists(p):
            subprocess.Popen(["explorer", "/select,", os.path.normpath(p)])
        elif os.path.isdir(os.path.dirname(p)):
            os.startfile(os.path.dirname(p))

    def copy_result_path():
        p = _res_path()
        if p:
            root.clipboard_clear()
            root.clipboard_append(p)
            hit_var.set("路径已复制：" + p)

    res_tree = ttk.Treeview(f5, columns=("name", "dir", "size", "date"),
                            show="headings", selectmode="browse")
    for col, txt, w in (("name", "文件名", 260), ("dir", "所在目录", 420),
                        ("size", "大小", 80), ("date", "修改日期", 90)):
        res_tree.heading(col, text=txt)
        res_tree.column(col, width=w, anchor="w" if col in ("name", "dir") else "e")
    rsb = ttk.Scrollbar(f5, orient="vertical", command=res_tree.yview)
    res_tree.configure(yscrollcommand=rsb.set)
    rsb.pack(side="right", fill="y", pady=(4, 10), padx=(0, 10))
    res_tree.pack(fill="both", expand=True, padx=(14, 0), pady=(4, 0))
    res_tree.bind("<Double-1>", lambda e: open_result())
    res_tree.bind("<Return>", lambda e: open_result())

    res_menu = tk.Menu(root, tearoff=0)
    res_menu.add_command(label="打开文件", command=open_result)
    res_menu.add_command(label="打开所在位置", command=open_result_dir)
    res_menu.add_separator()
    res_menu.add_command(label="复制完整路径", command=copy_result_path)

    def on_res_right_click(e):
        iid = res_tree.identify_row(e.y)
        if not iid:
            return
        res_tree.selection_set(iid)
        res_menu.tk_popup(e.x_root, e.y_root)
        res_menu.grab_release()

    res_tree.bind("<Button-3>", on_res_right_click)

    ttk.Button(st1, text="搜索", command=do_search).pack(side="left")
    qe = ttk.Entry(st1, textvariable=q_var, width=34)
    qe.pack(side="left", padx=6)
    qe.bind("<Return>", do_search)
    ttk.Button(st1, text="用 Everything 搜索",
               command=lambda: (open_everything_search(q_var.get().strip())
                                or messagebox.showinfo("提示", "没找到 Everything"))).pack(side="left")
    ttk.Button(st1, text="重建索引", command=rebuild_index).pack(side="left", padx=(6, 0))
    ttk.Label(st1, textvariable=hit_var, foreground="#4b5563").pack(side="right")

    srow2 = ttk.Frame(f5)
    srow2.pack(fill="x", padx=14, pady=(0, 2))

    idx_lbl = ttk.Label(srow2, textvariable=idx_var, foreground="#8b9199")
    idx_lbl.pack(anchor="w")
    srow2.bind("<Configure>", fit_wraplength(srow2, idx_lbl, 240, 40))

    ttk.Label(f5, text="双击直接打开文件 · 右键可打开位置 / 复制路径",
              foreground="#a8adb5").pack(anchor="w", padx=14, pady=(0, 8))

    # ── 设置 ──
    f6 = page_settings
    f6.configure(padding=(0, 0))

    # 设置页内容比窗口高，套一层可滚动容器，底部卡片才够得着
    _PAGE_BG = "#f5f6f8"
    _sc = tk.Canvas(f6, highlightthickness=0, bd=0, bg=_PAGE_BG)
    _sv = ttk.Scrollbar(f6, orient="vertical", command=_sc.yview)
    _sc.configure(yscrollcommand=_sv.set)
    _sv.pack(side="right", fill="y")
    _sc.pack(side="left", fill="both", expand=True)
    sf = tk.Frame(_sc, bg=_PAGE_BG)        # 用 tk.Frame 才能自己定背景，消除滚动残影
    _win = _sc.create_window((0, 0), window=sf, anchor="nw")

    def _sync_scroll(_e=None):
        """内容没超出窗口就不给滚：贴顶、藏滚动条；超出了才允许滚。"""
        try:
            _sc.update_idletasks()
            need = sf.winfo_reqheight()
            view = _sc.winfo_height()
            wide = _sc.winfo_width()
            if view <= 1 or wide <= 1:
                return
            if need <= view:
                _sc.configure(scrollregion=(0, 0, wide, view))
                _sc.yview_moveto(0)
                if _sv.winfo_ismapped():
                    _sv.pack_forget()
            else:
                _sc.configure(scrollregion=(0, 0, wide, need))
                if not _sv.winfo_ismapped():
                    _sv.pack(side="right", fill="y", before=_sc)
        except Exception:
            pass

    sf.bind("<Configure>", lambda e: _sync_scroll())
    _sc.bind("<Configure>",
             lambda e: (_sc.itemconfigure(_win, width=e.width), _sync_scroll()))

    def _set_page_bg(w):
        """把设置页里 ttk 容器的底色也统一，否则滚动时露白边。"""
        for k in w.winfo_children():
            if isinstance(k, tk.Frame):
                try:
                    k.configure(bg=_PAGE_BG)
                except Exception:
                    pass
            _set_page_bg(k)

    def _wheel(e):
        # Windows 上 delta 是 120 的倍数；Linux 走 Button-4/5
        if getattr(e, "num", None) == 4:
            step = -1
        elif getattr(e, "num", None) == 5:
            step = 1
        else:
            step = -1 if getattr(e, "delta", 0) > 0 else 1
        try:
            if sf.winfo_reqheight() <= _sc.winfo_height():
                return "break"              # 内容装得下，不滚
            _sc.yview_scroll(step * 3, "units")
            _sc.update_idletasks()          # 立刻重绘，避免拖影
        except Exception:
            pass
        return "break"

    def _bind_this_page():
        bind_wheel_deep(sf, _wheel)
        bind_wheel_deep(_sc, _wheel)

    # ── 可折叠分组（设置页统一用它排版） ──
    def card(parent, title, opened=True, hint=""):
        """返回 (外壳, 内容区)；标题行点一下收起/展开。"""
        wrap = tk.Frame(parent, bg="#ffffff", highlightthickness=1,
                        highlightbackground="#e6e8ec")
        head = tk.Frame(wrap, bg="#ffffff", cursor="hand2")
        head.pack(fill="x")
        cv = tk.Canvas(head, width=14, height=14, bg="#ffffff",
                       highlightthickness=0)
        cv.pack(side="left", padx=(10, 4), pady=8)
        lb = tk.Label(head, text=title, bg="#ffffff", fg="#1f2933",
                      font=("Microsoft YaHei UI", 9, "bold"), anchor="w")
        lb.pack(side="left")
        if hint:
            tk.Label(head, text=hint, bg="#ffffff", fg="#a8adb5",
                     font=("Microsoft YaHei UI", 8)).pack(side="left", padx=8)
        body = tk.Frame(wrap, bg="#ffffff")
        st = {"open": opened}

        def paint():
            cv.delete("all")
            o = st["open"]
            cv.create_polygon(4, 5, 10, 5, 7, 9, fill="#8b9199", outline="")
            if not o:
                cv.delete("all")
                cv.create_polygon(5, 4, 5, 10, 9, 7, fill="#8b9199", outline="")

        def toggle(_e=None):
            if st["open"]:
                body.pack_forget()
            else:
                body.pack(fill="x", padx=2, pady=(0, 8))
            st["open"] = not st["open"]
            paint()
            # 收起/展开后立刻重排重绘，否则下面那块会短暂残留旧像素（拖影）
            try:
                wrap.update_idletasks()
                _sync_scroll()
            except Exception:
                pass

        for w in (head, cv, lb):
            w.bind("<Button-1>", toggle)
        if opened:
            body.pack(fill="x", padx=2, pady=(0, 8))
        paint()
        wrap.pack(fill="x", padx=8, pady=(0, 8))
        return wrap, body

    def row(parent, r, label, widget, extra=None):
        ttk.Label(parent, text=label, width=16, anchor="w").grid(
            row=r, column=0, sticky="w", pady=3, padx=(14, 0))
        widget.grid(row=r, column=1, sticky="we", padx=6, pady=3)
        if extra is not None:
            extra.grid(row=r, column=2, padx=(2, 10), pady=3)

    data_var = tk.StringVar(value=data_dir())
    cache_var = tk.StringVar(value=S.get("cache_dir", ""))
    cfg_var = tk.StringVar(value="配置文件：%s" % SETTINGS_PATH)
    ev_var = tk.StringVar(value=S.get("everything_path", ""))
    conflict_s_var = tk.StringVar(value=S.get("conflict_policy", "rename"))
    depth_var = tk.StringVar(value=str(S.get("recursive_depth", 3)))
    logkeep_var = tk.StringVar(value=str(S.get("log_keep_days", 30)))
    rec_var = tk.BooleanVar(value=bool(S.get("default_recursive", False)))
    content_var = tk.BooleanVar(value=bool(S.get("default_content", True)))

    # ① 目录位置
    _c1, sf1 = card(sf, "目录位置", False, "数据、缓存、外部工具")
    sf1.columnconfigure(1, weight=1)
    de = ttk.Entry(sf1, textvariable=data_var)
    row(sf1, 0, "数据目录", de,
        ttk.Button(sf1, text="浏览…", command=lambda: pick_dir(data_var)))
    ce = ttk.Entry(sf1, textvariable=cache_var)
    row(sf1, 1, "缓存目录", ce,
        ttk.Button(sf1, text="浏览…", command=lambda: pick_dir(cache_var)))
    ee = ttk.Entry(sf1, textvariable=ev_var)
    row(sf1, 2, "Everything 路径", ee,
        ttk.Button(sf1, text="自动检测",
                   command=lambda: (ev_var.set(find_everything()),
                                    log("[设置] 已检测 Everything"))
                   if find_everything()
                   else messagebox.showinfo("提示", "没有检测到 Everything")))
    ttk.Label(sf1, foreground="#8b9199", wraplength=560, justify="left",
              text="改完点「保存设置」立即生效；旧数据可以一起搬过去，"
                   "选「否」也只是不搬，设置照样保存。配置文件跟着数据目录走。"
              ).grid(row=3, column=0, columnspan=3, sticky="w",
                     padx=(14, 10), pady=(2, 6))

    # ② 默认行为
    _c2, sf2 = card(sf, "默认行为", False, "新建扫描时的默认勾选与策略")
    sf2.columnconfigure(1, weight=1)
    ttk.Combobox(sf2, textvariable=conflict_s_var, state="readonly", width=14,
                 values=("rename", "skip", "overwrite")).grid(
        row=0, column=1, sticky="w", padx=6, pady=3)
    ttk.Label(sf2, text="默认重名策略", width=16, anchor="w").grid(
        row=0, column=0, sticky="w", padx=(14, 0))
    ttk.Spinbox(sf2, from_=1, to=4, textvariable=depth_var, width=6).grid(
        row=1, column=1, sticky="w", padx=6, pady=3)
    ttk.Label(sf2, text="递归深度", width=16, anchor="w").grid(
        row=1, column=0, sticky="w", padx=(14, 0))
    ttk.Spinbox(sf2, from_=1, to=365, textvariable=logkeep_var, width=6).grid(
        row=2, column=1, sticky="w", padx=6, pady=3)
    ttk.Label(sf2, text="日志保留天数", width=16, anchor="w").grid(
        row=2, column=0, sticky="w", padx=(14, 0))
    ttk.Checkbutton(sf2, text="默认勾选「包含子文件夹」",
                    variable=rec_var).grid(row=3, column=1, sticky="w", padx=6)
    ttk.Checkbutton(sf2, text="默认勾选「按内容识别」",
                    variable=content_var).grid(row=4, column=1, sticky="w", padx=6)

    # ③ 索引目录
    _c3, sf3 = card(sf, "索引目录", False, "搜索页使用")
    sf3.columnconfigure(1, weight=1)
    roots_box = tk.Listbox(sf3, height=5, selectmode="extended",
                           relief="flat", highlightthickness=1,
                           highlightbackground="#e6e8ec")
    roots_box.grid(row=0, column=1, sticky="we", padx=6, pady=(4, 2), columnspan=2)
    ttk.Label(sf3, text="索引目录", width=16, anchor="nw").grid(
        row=0, column=0, sticky="nw", padx=(14, 0), pady=(6, 0))
    for p in S.get("index_roots", []):
        roots_box.insert("end", p)

    def sync_roots():
        roots_box.delete(0, "end")
        for p in S.get("index_roots", []):
            roots_box.insert("end", p)

    state["sync_roots"] = sync_roots

    def add_root():
        d = filedialog.askdirectory(title="选择要索引的目录")
        if d:
            roots_box.insert("end", os.path.normpath(d))

    def del_root():
        for i in reversed(roots_box.curselection()):
            roots_box.delete(i)

    def quick_roots():
        roots = default_index_roots()
        roots_box.delete(0, "end")
        for p in roots:
            roots_box.insert("end", p)
        S["index_roots"] = roots
        save_settings(S)
        log(f"[索引] 已填入 {len(roots)} 个用户目录，开始建立…")
        rebuild_index()

    def full_roots():
        if not messagebox.askyesno(
                "整盘索引",
                "整盘（D / E）大约 130 万个文件。\n"
                "实测：约 3 分钟建库，索引库 200 MB 左右，单次搜索 0.2–0.5 秒。\n\n"
                "建议先在「常用位置」用着，确有需要再整盘。继续？"):
            return
        roots = full_disk_roots()
        roots_box.delete(0, "end")
        for p in roots:
            roots_box.insert("end", p)
        S["index_roots"] = roots
        save_settings(S)
        log(f"[索引] 整盘索引开始：{roots}")
        rebuild_index()

    rb = ttk.Frame(sf3)
    rb.grid(row=1, column=1, sticky="w", padx=6, pady=(0, 6), columnspan=2)
    ttk.Button(rb, text="索引常用位置", command=quick_roots).pack(side="left")
    ttk.Button(rb, text="整盘索引", command=full_roots).pack(side="left", padx=6)
    ttk.Button(rb, text="添加目录", command=add_root).pack(side="left")
    ttk.Button(rb, text="移除", command=del_root).pack(side="left", padx=6)
    ttk.Button(rb, text="重建索引", command=rebuild_index).pack(side="left")

    def save_all():
        old_data = data_dir()
        _raw = data_var.get().strip()
        new_data = os.path.normpath(os.path.expandvars(_raw)) if _raw else DEFAULT_DATA
        why = check_data_dir(new_data, old_data)
        if why:
            messagebox.showwarning("数据目录不可用", why)
            data_var.set(old_data)
            return
        _old_cache = S.get("cache_dir") or ""
        _craw = cache_var.get().strip()
        new_cache = os.path.normpath(os.path.expandvars(_craw)) if _craw else ""
        if new_cache:
            why = check_data_dir(new_cache, None)
            if why:
                # 缓存目录和「自定义缓存目录」走同一套准入：盘符根、程序目录、文件都不行
                messagebox.showwarning("缓存目录不可用", why)
                cache_var.set(_old_cache)
                return
        S["cache_dir"] = new_cache
        S["everything_path"] = ev_var.get().strip()
        S["conflict_policy"] = conflict_s_var.get()
        try:
            S["recursive_depth"] = max(1, min(4, int(depth_var.get())))
        except ValueError:
            S["recursive_depth"] = 3
        try:
            S["log_keep_days"] = max(1, int(logkeep_var.get()))
        except ValueError:
            S["log_keep_days"] = 30
        S["default_recursive"] = rec_var.get()
        S["default_content"] = content_var.get()
        S["index_roots"] = list(roots_box.get(0, "end"))
        try:
            _act = close_action_var.get()
            if _act in ("tray", "exit", "ask"):
                S["close_action"] = _act
                S["close_choice_made"] = True
                S["close_to_tray"] = (_act == "tray")   # 兼容老版本
        except Exception:
            pass
        try:
            _tp = tray_pin_var.get()
            if _tp in ("taskbar", "overflow", "system"):
                S["tray_pin"] = _tp
        except Exception:
            pass

        changed = os.path.normcase(os.path.abspath(old_data)) != \
            os.path.normcase(os.path.abspath(new_data))
        S["data_dir"] = new_data
        # ① 先把设置落盘：点「保存」就一定生效。迁移旧数据是另一件事，单独问，
        #    以前把「是否迁移」和「是否保存」绑在一起，点「否」整次保存直接丢掉，
        #    界面上也没提示 —— 这就是「目录改不了」的主因。
        if not save_settings(S):
            S["data_dir"] = old_data
            messagebox.showerror("保存失败", "写不进：\n%s" % SETTINGS_PATH)
            return
        data_var.set(S["data_dir"])
        try:
            cfg_var.set("配置文件：%s" % SETTINGS_PATH)
        except Exception:
            pass
        log(f"[设置] 已保存到 {SETTINGS_PATH}")
        refresh_idx_status()
        try:
            # 托盘位置立即生效（等图标在托盘里注册好，稍等一下再写）
            root.after(800, lambda: apply_tray_pin(S.get("tray_pin")))
        except Exception:
            pass
        if not changed:
            return

        log(f"[设置] 数据目录已改：{old_data} -> {new_data}")
        # ② 再单独问要不要搬旧数据；不搬也照样生效
        if not messagebox.askyesno(
                "迁移数据",
                f"数据目录已改到\n{new_data}\n\n"
                f"要把原来的历史记录、日志、卸载备份、缓存一起搬过去吗？\n\n"
                f"选「否」设置也会生效，旧文件留在\n{old_data}\n（不会自动删除）"):
            log(f"[设置] 没搬旧数据，旧目录原样留在 {old_data}")
            return

        def _mig_work(report):
            return migrate_data(old_data, new_data, report)

        def _mig_done(res):
            moved, failed = res
            log(f"[迁移] 已搬 {len(moved)} 项到 {new_data}")
            for p, why2 in failed[:20]:
                log(f"[迁移] 失败 {p}  <- {why2}")
            if failed:
                messagebox.showwarning(
                    "迁移未全部完成",
                    "搬过去 %d 项，%d 项没搬成（详情见「整理文件」页日志）。\n\n"
                    "没搬成的东西还在旧目录里：\n%s" % (len(moved), len(failed), failed[0][0]))
            else:
                log(f"[迁移] 迁移完成，旧目录可以自己删：{old_data}")

        run_task("正在迁移数据…", _mig_work, on_done=_mig_done)

    def restore_defaults():
        if not messagebox.askyesno("恢复默认", "把除数据目录外的设置恢复默认？（不会迁移或删除文件）"):
            return
        for k, v in DEFAULT_SETTINGS.items():
            if k != "data_dir":
                S[k] = v
        data_var.set(S["data_dir"])
        cache_var.set(S.get("cache_dir", ""))
        ev_var.set("")
        conflict_s_var.set(S["conflict_policy"])
        depth_var.set(str(S["recursive_depth"]))
        logkeep_var.set(str(S["log_keep_days"]))
        rec_var.set(S["default_recursive"])
        content_var.set(S["default_content"])
        roots_box.delete(0, "end")
        save_settings(S)
        log("[设置] 已恢复默认")

    # ── 资源管理器右键菜单 ──
    _c4, em = card(sf, "资源管理器右键菜单", False, "选中文件夹后右键调用")
    em_status = tk.StringVar()

    def refresh_menu_status():
        em_status.set("状态：已安装" if explorer_menu_installed() else "状态：未安装")

    def do_install_menu():
        ok, msg = install_explorer_menu()
        log(f"[右键菜单] {msg}")
        if not ok:
            messagebox.showerror("安装失败", msg)
        refresh_menu_status()

    def do_remove_menu():
        ok, msg = remove_explorer_menu()
        log(f"[右键菜单] {msg}")
        if not ok:
            messagebox.showwarning("移除不完整", msg)
        refresh_menu_status()

    ttk.Label(em, text="资源管理器右键菜单", width=18, anchor="w").pack(side="left")
    ttk.Button(em, text="安装", command=do_install_menu).pack(side="left")
    ttk.Button(em, text="移除", command=do_remove_menu).pack(side="left", padx=6)
    ttk.Label(em, textvariable=em_status, foreground="#6b7280").pack(
        side="left", padx=8)
    ttk.Label(em, foreground="#b0b5bd",
              text="写入 HKCU\\Software\\Classes，不需要管理员权限").pack(
                  side="right", padx=(6, 12))

    # ── 开机自启 + 系统托盘 ──
    _c5, am = card(sf, "开机自启与后台运行", False,
                   "登录后自动在托盘待命，右键托盘图标可操作")
    auto_var = tk.StringVar(value=autostart_state())
    auto_status = tk.StringVar()

    def refresh_auto_ui():
        st = autostart_state()
        try:
            auto_var.set(st)
        except Exception:
            pass
        auto_status.set({"off": "当前：未开启",
                         "normal": "当前：普通自启（登录后在托盘运行）",
                         "strong": "当前：强力自启（以管理员权限运行）"
                         }.get(st, st))

    def pick_auto(mode):
        ok, msg = autostart_set(mode)
        log("[开机自启] " + msg)
        refresh_auto_ui()
        if not ok:
            messagebox.showinfo("没能开启强力自启", msg)

    arow = ttk.Frame(am)
    arow.pack(fill="x", pady=2)
    ttk.Label(arow, text="开机自启", width=18, anchor="w").pack(side="left")
    for _txt, _mode in (("关闭", "off"), ("普通", "normal"), ("强力", "strong")):
        ttk.Radiobutton(arow, text=_txt, value=_mode, variable=auto_var,
                        command=(lambda m=_mode: pick_auto(m))
                        ).pack(side="left", padx=(0, 12))
    ttk.Label(am, textvariable=auto_status, foreground="#6b7280").pack(
        anchor="w", pady=(4, 2))

    ttk.Label(am, foreground="#9aa0a8",
              text="普通：登录后自动在托盘运行，普通权限，删 Windows\\Temp 这类会失败。\n"
                   "强力：用计划任务以最高权限运行，能清系统级缓存；勾选时会弹一次管理员授权。"
              ).pack(anchor="w", pady=(0, 6))

    _act0 = S.get("close_action")
    if _act0 not in ("tray", "exit", "ask"):
        _act0 = "tray" if S.get("close_to_tray", True) else "exit"
    close_action_var = tk.StringVar(value=_act0)
    _ca = ttk.Frame(am)
    _ca.pack(anchor="w", pady=(4, 2))
    ttk.Label(_ca, text="点关闭按钮时：").pack(side="left")
    for _txt, _val in (("最小化到托盘", "tray"),
                       ("直接退出", "exit"),
                       ("每次询问", "ask")):
        ttk.Radiobutton(_ca, text=_txt, value=_val,
                        variable=close_action_var).pack(side="left", padx=(0, 14))
    ttk.Label(am, foreground="#6b7280",
              text="托盘模式：窗口消失、程序继续在后台运行，托盘图标右键可再打开或退出。"
              ).pack(anchor="w", pady=(0, 6))

    _tp0 = S.get("tray_pin")
    if _tp0 not in ("taskbar", "overflow", "system"):
        _tp0 = "taskbar"
    tray_pin_var = tk.StringVar(value=_tp0)
    _tp = ttk.Frame(am)
    _tp.pack(anchor="w", pady=(2, 2))
    ttk.Label(_tp, text="托盘图标位置：").pack(side="left")
    for _txt, _val in (("始终显示在任务栏", "taskbar"),
                       ("只放在折叠区里", "overflow"),
                       ("跟随系统（我拖到哪就一直在哪）", "system")):
        ttk.Radiobutton(_tp, text=_txt, value=_val,
                        variable=tray_pin_var).pack(side="left", padx=(0, 14))
    ttk.Label(am, foreground="#6b7280",
              text="选「跟随系统」后，图标位置完全由你拖动决定，程序不再回写。"
              ).pack(anchor="w", pady=(0, 6))

    refresh_auto_ui()

    def open_data_dir():
        d = data_dir()
        try:
            os.makedirs(d, exist_ok=True)
            os.startfile(d)
        except Exception as ex:
            messagebox.showerror("打不开数据目录", "%s\n%s" % (d, ex))

    # 保存栏放最下面
    sbtn = ttk.Frame(sf)
    sbtn.pack(fill="x", padx=8, pady=(4, 6))
    ttk.Button(sbtn, text="保存设置", command=save_all).pack(side="left")
    ttk.Button(sbtn, text="恢复默认", command=restore_defaults).pack(side="left", padx=8)
    ttk.Button(sbtn, text="打开数据目录",
               command=open_data_dir).pack(side="left")

    ttk.Label(sf, foreground="#999", textvariable=cfg_var
              ).pack(anchor="w", padx=10, pady=(0, 8))

    # 设置页盖完了，再统一底色、绑滚轮（子控件建完才绑得到）
    try:
        _set_page_bg(sf)
        _bind_this_page()
        _sync_scroll()
        root.after(120, _sync_scroll)
    except Exception:
        pass

    ttk.Label(page_tidy, text="日志", foreground="#555").pack(anchor="w", padx=14)
    log_text = tk.Text(page_tidy, height=7, wrap="word", state="disabled",
                       background="#fbfbfb", relief="flat")
    log_text.pack(fill="both", expand=True, padx=14, pady=(0, 12))

    # ══════════════════ 数据迁移 ══════════════════
    fm = page_migrate
    page_header(fm, "数据迁移",
                "把文件、文件夹、应用数据整棵搬到新位置：先预演，再执行；可校验、可回滚")

    _mig = {"sources": [], "plan": None, "opts": None, "job": "",
            "cancel": None, "report": None}
    # 迁移任务目录跟着数据目录走（见 mig_jobs_dir），不要在启动时写死
    _MIG_CONF = {"重名自动改名": "rename", "跳过已存在": "skip",
                 "覆盖（旧的进备份）": "overwrite", "合并目录": "merge"}
    _MIG_VER = {"自动（小文件全量哈希）": "auto", "全量哈希": "hash",
                "只比对大小": "size", "不校验（最快）": "none"}

    _mig_cfg = S.get("migrate") or {}
    _mig_count = tk.StringVar(value="来源 0 项")
    _mig_summary = tk.StringVar(value="还没有预演")
    _mig_issue = tk.StringVar(value="")
    _mig_dest = tk.StringVar(value=_mig_cfg.get("dest", ""))

    src_bar = ttk.Frame(fm)
    src_bar.pack(fill="x", padx=14, pady=(2, 2))
    ttk.Button(src_bar, text="添加文件夹",
               command=lambda: _mig_add("dir")).pack(side="left")
    ttk.Button(src_bar, text="添加文件",
               command=lambda: _mig_add("file")).pack(side="left", padx=6)
    ttk.Button(src_bar, text="移除选中",
               command=lambda: _mig_remove()).pack(side="left")
    ttk.Button(src_bar, text="清空",
               command=lambda: _mig_clear()).pack(side="left", padx=6)
    ttk.Label(src_bar, textvariable=_mig_count,
              foreground="#8b9199").pack(side="left", padx=(14, 0))

    src_wrap = ttk.Frame(fm)
    src_wrap.pack(fill="x", padx=14, pady=(2, 6))
    src_tree = ttk.Treeview(src_wrap, columns=("path", "kind", "size"),
                            show="headings", height=4, selectmode="extended")
    for col, txt, w, anchor in (("path", "来源", 430, "w"),
                                ("kind", "类型", 62, "center"),
                                ("size", "大小", 80, "e")):
        src_tree.heading(col, text=txt)
        src_tree.column(col, width=w, anchor=anchor, stretch=(col == "path"))
    src_vsb = ttk.Scrollbar(src_wrap, orient="vertical", command=src_tree.yview)
    src_tree.configure(yscrollcommand=src_vsb.set)
    src_tree.pack(side="left", fill="x", expand=True)
    src_vsb.pack(side="left", fill="y")

    dst_row = ttk.Frame(fm)
    dst_row.pack(fill="x", padx=14, pady=(0, 4))
    ttk.Label(dst_row, text="目标目录").pack(side="left")
    dst_entry = ttk.Entry(dst_row, textvariable=_mig_dest)
    dst_entry.pack(side="left", fill="x", expand=True, padx=8)
    ttk.Button(dst_row, text="浏览…",
               command=lambda: _mig_pick_dest()).pack(side="left")

    opt_row = ttk.Frame(fm)
    opt_row.pack(fill="x", padx=14, pady=(0, 4))
    _mig_mode = tk.StringVar(value=_mig_cfg.get("mode", "移动"))
    _mig_keep = tk.BooleanVar(value=bool(_mig_cfg.get("keep", False)))
    _mig_trash = tk.BooleanVar(value=bool(_mig_cfg.get("trash", False)))
    try:
        _mig_workers = tk.IntVar(value=max(1, min(8, int(_mig_cfg.get("workers", 4)))))
    except Exception:
        _mig_workers = tk.IntVar(value=4)
    ttk.Label(opt_row, text="方式").pack(side="left")
    ttk.Combobox(opt_row, textvariable=_mig_mode, width=6, state="readonly",
                 values=("移动", "复制")).pack(side="left", padx=(4, 12))
    ttk.Label(opt_row, text="重名").pack(side="left")
    _cf = _mig_cfg.get("conflict_label", "重名自动改名")
    _mig_conf = tk.StringVar(value=_cf if _cf in _MIG_CONF else "重名自动改名")
    ttk.Combobox(opt_row, textvariable=_mig_conf, width=14, state="readonly",
                 values=tuple(_MIG_CONF)).pack(side="left", padx=(4, 12))
    ttk.Label(opt_row, text="校验").pack(side="left")
    _vf = _mig_cfg.get("verify_label", "自动（小文件全量哈希）")
    _mig_ver = tk.StringVar(value=_vf if _vf in _MIG_VER else "自动（小文件全量哈希）")
    ttk.Combobox(opt_row, textvariable=_mig_ver, width=18, state="readonly",
                 values=tuple(_MIG_VER)).pack(side="left", padx=(4, 12))
    ttk.Checkbutton(opt_row, text="保留来源文件夹名（多套一层）",
                    variable=_mig_keep).pack(side="left", padx=(0, 12))
    ttk.Checkbutton(opt_row, text="删源进回收站",
                    variable=_mig_trash).pack(side="left")

    act_row = ttk.Frame(fm)
    act_row.pack(fill="x", padx=14, pady=(2, 2))
    ttk.Button(act_row, text="预演", command=lambda: _mig_build()).pack(side="left")
    ttk.Button(act_row, text="开始迁移",
               command=lambda: _mig_build("run")).pack(side="left", padx=6)
    ttk.Button(act_row, text="取消",
               command=lambda: _mig_cancel()).pack(side="left")
    ttk.Button(act_row, text="撤销上次",
               command=lambda: _mig_undo()).pack(side="left", padx=6)
    ttk.Button(act_row, text="任务历史",
               command=lambda: _mig_history()).pack(side="left")
    ttk.Button(act_row, text="导出报告",
               command=lambda: _mig_export()).pack(side="left", padx=6)
    ttk.Label(act_row, text="并发").pack(side="left", padx=(16, 2))
    ttk.Spinbox(act_row, from_=1, to=8, width=3,
                textvariable=_mig_workers).pack(side="left")
    ttk.Label(act_row, textvariable=_mig_summary,
              foreground="#6b7280").pack(side="left", padx=(16, 0))

    prev_wrap = ttk.Frame(fm)
    prev_wrap.pack(fill="both", expand=True, padx=14, pady=(2, 4))
    prev_tree = ttk.Treeview(prev_wrap,
                             columns=("src", "dst", "kind", "size", "state"),
                             show="headings", height=10)
    for col, txt, w, anchor in (("src", "来源", 250, "w"), ("dst", "目标", 280, "w"),
                                ("kind", "类型", 50, "center"),
                                ("size", "大小", 74, "e"),
                                ("state", "状态", 66, "center")):
        prev_tree.heading(col, text=txt)
        prev_tree.column(col, width=w, anchor=anchor,
                         stretch=(col in ("src", "dst")))
    prev_tree.tag_configure("failed", foreground="#c0392b")
    prev_tree.tag_configure("skip", foreground="#b0b4bb")
    prev_vsb = ttk.Scrollbar(prev_wrap, orient="vertical", command=prev_tree.yview)
    prev_tree.configure(yscrollcommand=prev_vsb.set)
    prev_tree.pack(side="left", fill="both", expand=True)
    prev_vsb.pack(side="left", fill="y")

    ttk.Label(fm, textvariable=_mig_issue, foreground="#c0392b",
              wraplength=1000, justify="left").pack(fill="x", padx=14, pady=(0, 6))

    def _mig_kind(p):
        try:
            if MIG and MIG.is_reparse(p):
                return "链接"
        except Exception:
            pass
        return "文件夹" if os.path.isdir(p) else "文件"

    def _mig_size(p):
        try:
            if os.path.isdir(p):
                return "—"
            return human(os.path.getsize(p))
        except OSError:
            return "—"

    def _mig_refresh():
        src_tree.delete(*src_tree.get_children())
        for p in _mig["sources"]:
            src_tree.insert("", "end", values=(p, _mig_kind(p), _mig_size(p)))
        _mig_count.set("来源 %d 项" % len(_mig["sources"]))

    def _mig_add(kind):
        if kind == "dir":
            p = filedialog.askdirectory(title="选择要迁移的文件夹")
            if p:
                p = os.path.normpath(p)
                if p not in _mig["sources"]:
                    _mig["sources"].append(p)
        else:
            ps = filedialog.askopenfilenames(title="选择要迁移的文件")
            for p in ps or ():
                p = os.path.normpath(p)
                if p not in _mig["sources"]:
                    _mig["sources"].append(p)
        _mig_refresh()

    def _mig_remove():
        idxs = sorted((src_tree.index(i) for i in src_tree.selection()), reverse=True)
        for i in idxs:
            if 0 <= i < len(_mig["sources"]):
                _mig["sources"].pop(i)
        _mig_refresh()

    def _mig_clear():
        _mig["sources"] = []
        _mig["plan"] = None
        prev_tree.delete(*prev_tree.get_children())
        _mig_refresh()
        _mig_summary.set("还没有预演")
        _mig_issue.set("")

    def _mig_pick_dest():
        p = filedialog.askdirectory(title="选择目标目录")
        if p:
            _mig_dest.set(os.path.normpath(p))

    def _mig_opts():
        return MIG.Options(
            mode="copy" if _mig_mode.get() == "复制" else "move",
            conflict=_MIG_CONF.get(_mig_conf.get(), "rename"),
            verify=_MIG_VER.get(_mig_ver.get(), "auto"),
            workers=int(_mig_workers.get() or 4),
            delete_mode="trash" if _mig_trash.get() else "delete",
            flatten=not _mig_keep.get())

    def _mig_fill(plan, issues):
        prev_tree.delete(*prev_tree.get_children())
        for i, it in enumerate(plan.items[:3000]):
            kind = {"file": "文件", "dir": "目录", "link": "链接"}.get(it.kind, it.kind)
            prev_tree.insert("", "end", iid=str(i),
                             values=(it.src, it.dst or "（跳过）", kind,
                                     human(it.size), "待执行"))
        errs = [i for i in issues if i.level == "error"]
        warns = [i for i in issues if i.level == "warn"]
        if errs:
            _mig_issue.set("阻断 %d 项：%s" % (
                len(errs), "；".join(str(e) for e in errs[:3])))
        elif warns:
            _mig_issue.set("提醒 %d 项：%s" % (
                len(warns), "；".join(str(w) for w in warns[:2])))
        else:
            _mig_issue.set("")
        _mig_summary.set("%d 个文件，%d 个目录，合计 %s" % (
            plan.n_files, plan.n_dirs, human(plan.bytes)))

    def _mig_build(then=None):
        if MIG is None:
            messagebox.showerror("组件缺失", "migrate_engine.py 不在程序目录，迁移功能不可用。")
            return
        if not _mig["sources"]:
            messagebox.showinfo("先选来源", "添加要迁移的文件或文件夹。")
            return
        dest = _mig_dest.get().strip().strip('"')
        if not dest:
            messagebox.showinfo("先选目标", "选择一个目标目录。")
            return
        opts = _mig_opts()
        _mig_save_cfg()

        def work(report):
            report(1, 10, "扫描来源…")
            plan = MIG.build_plan(list(_mig["sources"]), dest, opts)
            report(8, 10, "预检…")
            return plan, MIG.preflight(plan)

        def done(res):
            plan, issues = res
            _mig["plan"] = plan
            _mig["opts"] = opts
            _mig_fill(plan, issues)
            errs = [i for i in issues if i.level == "error"]
            if errs:
                messagebox.showwarning("有阻断项，没有执行", "\n".join(
                    str(i) for i in errs[:6]))
                return
            if then == "run":
                _mig_execute(plan, opts)

        run_task("正在扫描…", work, done)

    def _mig_execute(plan, opts):
        msg = "即将%s %d 个文件（%s）到：\n%s\n\n目标已存在时按「%s」处理。" % (
            "复制" if opts.mode == "copy" else "移动",
            plan.n_files, human(plan.bytes), plan.dest, _mig_conf.get())
        if not messagebox.askyesno("确认执行", msg):
            return
        ev = threading.Event()
        _mig["cancel"] = ev
        _mig_issue.set("")

        def work(report):
            return MIG.execute(plan, mig_jobs_dir(), progress=report, cancel=ev)

        def done(rep):
            _mig["report"] = rep
            _mig["job"] = rep.job_id
            for i, it in enumerate(plan.items[:3000]):
                try:
                    state = {"done": "完成", "failed": "失败",
                             "skipped": "跳过"}.get(it.state, "待执行")
                    prev_tree.set(str(i), "state", state)
                    if it.state == "failed":
                        prev_tree.item(str(i), tags=("failed",))
                    elif it.state == "skipped":
                        prev_tree.item(str(i), tags=("skip",))
                except Exception:
                    pass
            _mig_summary.set("完成 %d，跳过 %d，失败 %d，共 %s，用时 %.1fs" % (
                rep.done, rep.skipped, rep.failed, human(rep.bytes),
                rep.ended - rep.started))
            if rep.cancelled:
                messagebox.showinfo("已取消", "迁移停在安全位置：已完成的都已校验落盘，"
                                              "源文件要么还在，要么目标已完整。")
            elif rep.failed:
                messagebox.showwarning("有失败项", "\n".join(
                    "%s ← %s" % (os.path.basename(f["src"]), f["error"])
                    for f in rep.failures[:6]))
            if rep.failed == 0 and not rep.cancelled:
                _mig_refresh()

        run_task("正在迁移…", work, done)

    def _mig_cancel():
        ev = _mig.get("cancel")
        if ev is not None:
            ev.set()
            _mig_issue.set("正在取消，处理完当前文件就停…")

    def _mig_undo():
        if MIG is None:
            return
        job = _mig.get("job") or ""
        if not job:
            jobs = MIG.list_jobs(mig_jobs_dir())
            job = jobs[0]["job_id"] if jobs else ""
        if not job:
            messagebox.showinfo("没有可撤销的任务", "这个界面还没有执行过迁移。")
            return
        if not messagebox.askyesno("撤销迁移",
                                   "把任务 %s 搬到目标的东西全部搬回原处？\n"
                                   "目标位置已被改过的文件会被跳过并列出。" % job):
            return

        def work(report):
            return MIG.undo_job(job, mig_jobs_dir(), progress=report)

        def done(res):
            n, failed = res
            _mig_summary.set("已回滚 %d 项，跳过 %d 项" % (n, len(failed)))
            if failed:
                messagebox.showwarning("部分没有回滚", "\n".join(
                    "%s ← %s" % (os.path.basename(p), why) for p, why in failed[:6]))
            _mig_refresh()

        run_task("正在回滚…", work, done)

    def _mig_save_cfg():
        S["migrate"] = {
            "mode": _mig_mode.get(),
            "conflict_label": _mig_conf.get(),
            "verify_label": _mig_ver.get(),
            "keep": bool(_mig_keep.get()),
            "trash": bool(_mig_trash.get()),
            "workers": int(_mig_workers.get() or 4),
            "dest": _mig_dest.get().strip(),
        }
        save_settings(S)

    def _mig_jobs():
        if MIG is None:
            return []
        try:
            return MIG.list_jobs(mig_jobs_dir())
        except Exception:
            return []

    _MIG_STATE = {"finished": "完成", "cancelled": "已取消",
                  "undone": "已回滚", "running": "中断"}

    def _mig_history():
        """任务历史：挑任意一次回滚或复核，不用记任务号。"""
        if MIG is None:
            messagebox.showerror("组件缺失", "migrate_engine.py 不在程序目录。")
            return
        win = tk.Toplevel(root)
        win.title("迁移任务历史")
        win.geometry("860x440")
        win.transient(root)
        ttk.Label(win, foreground="#8b9199",
                  text="每次迁移都有一条日志。回滚只动这次任务自己搬过的东西；"
                       "复核会重新比对目标文件的大小与哈希。").pack(
            anchor="w", padx=12, pady=(10, 6))
        wrap = ttk.Frame(win)
        wrap.pack(fill="both", expand=True, padx=12)
        tv = ttk.Treeview(wrap, columns=("time", "mode", "dest", "result",
                                         "status", "job"), show="headings")
        for col, txt, w, anchor in (("time", "时间", 150, "w"),
                                    ("mode", "方式", 50, "center"),
                                    ("dest", "目标", 250, "w"),
                                    ("result", "结果", 110, "center"),
                                    ("status", "状态", 80, "center"),
                                    ("job", "任务号", 190, "w")):
            tv.heading(col, text=txt)
            tv.column(col, width=w, anchor=anchor,
                      stretch=(col == "dest"))
        vsb = ttk.Scrollbar(wrap, orient="vertical", command=tv.yview)
        tv.configure(yscrollcommand=vsb.set)
        tv.pack(side="left", fill="both", expand=True)
        vsb.pack(side="left", fill="y")

        valid = {}

        def fill():
            tv.delete(*tv.get_children())
            valid.clear()
            rows = _mig_jobs()
            for j in rows:
                valid[j["job_id"]] = True
                tv.insert("", "end", iid=j["job_id"], values=(
                    j.get("started", ""), "复制" if j.get("mode") == "copy" else "移动",
                    j.get("dest", ""), "完成 %s / 失败 %s" % (j.get("done", 0),
                                                             j.get("failed", 0)),
                    _MIG_STATE.get(j.get("status", ""), j.get("status", "")),
                    j.get("job_id", "")))
            if not rows:
                tv.insert("", "end", values=("还没有任务", "", "", "", "", ""))

        def picked():
            sel = tv.selection()
            return sel[0] if sel and sel[0] in valid else ""

        def act_undo():
            job = picked()
            if not job:
                return
            if not messagebox.askyesno("回滚", "把任务 %s 搬走的东西全部搬回原处？\n"
                                              "目标已被改过的文件会跳过并列出。" % job):
                return

            def work(report):
                return MIG.undo_job(job, mig_jobs_dir(), progress=report)

            def done(res):
                n, failed = res
                fill()
                _mig_summary.set("已回滚 %d 项，跳过 %d 项" % (n, len(failed)))
                if failed:
                    messagebox.showwarning("部分没有回滚", "\n".join(
                        "%s ← %s" % (os.path.basename(p), why)
                        for p, why in failed[:6]))
                else:
                    messagebox.showinfo("回滚完成", "已回滚 %d 项。" % n)
            run_task("正在回滚…", work, done)

        def act_verify():
            job = picked()
            if not job:
                return

            def work(report):
                return MIG.verify_job(job, mig_jobs_dir(), progress=report)

            def done(res):
                checked, bad = res
                if bad:
                    messagebox.showwarning(
                        "复核发现异常",
                        "检查 %d 项，异常 %d 项：\n%s" % (
                            checked, len(bad),
                            "\n".join("%s ← %s" % (p, why) for p, why in bad[:8])))
                else:
                    messagebox.showinfo("复核通过", "检查 %d 项，全部一致。" % checked)
            run_task("正在复核…", work, done)

        def act_open():
            job = picked()
            d = os.path.join(mig_jobs_dir(), job) if job else mig_jobs_dir()
            if os.path.isdir(d):
                os.startfile(d)

        btns = ttk.Frame(win)
        btns.pack(fill="x", padx=12, pady=8)
        ttk.Button(btns, text="回滚选中", command=act_undo).pack(side="left")
        ttk.Button(btns, text="复核选中", command=act_verify).pack(side="left", padx=6)
        ttk.Button(btns, text="打开任务目录", command=act_open).pack(side="left")
        ttk.Button(btns, text="关闭", command=win.destroy).pack(side="right")
        fill()

    def _mig_export():
        rep = _mig.get("report")
        if not rep:
            messagebox.showinfo("没有报告", "先执行一次迁移再导出。")
            return
        p = filedialog.asksaveasfilename(
            title="导出迁移报告", defaultextension=".json",
            filetypes=[("JSON", "*.json"), ("CSV", "*.csv")],
            initialfile="迁移报告-%s.json" % rep.job_id)
        if not p:
            return
        try:
            if p.lower().endswith(".csv"):
                import csv as _csv
                with open(p, "w", newline="", encoding="utf-8-sig") as f:
                    w = _csv.writer(f)
                    w.writerow(["来源", "目标", "错误"])
                    for it in (_mig["plan"].items if _mig["plan"] else []):
                        w.writerow([it.src, it.dst, it.error])
            else:
                with open(p, "w", encoding="utf-8") as f:
                    json.dump(rep.to_dict(), f, ensure_ascii=False, indent=1)
            log("[迁移] 报告已导出：%s" % p)
        except OSError as ex:
            messagebox.showerror("导出失败", str(ex))

    show("整理")
    if prefill and os.path.isdir(prefill):
        path_var.set(os.path.normpath(prefill))
        root.after(150, do_scan)

    # 环境变量指定启动页：0 整理 / 1 截图 / 2 缓存 / 3 规则 / 4 卸载 / 5 搜索 / 6 设置 / 7 迁移
    _pagemap = {"0": "整理", "1": "截图", "2": "缓存", "3": "规则",
                "4": "卸载", "5": "搜索", "6": "设置", "7": "迁移"}
    _want = _pagemap.get(os.environ.get("TIDY_TAB", "").strip())
    if _want:
        def _go():
            show(_want)
            if _want == "卸载":
                refresh_apps()
            elif _want == "搜索":
                refresh_idx_status()
            elif _want == "缓存":
                cc_scan()
            elif _want == "截图":
                do_shot_scan(silent=True)
        root.after(400, _go)

    # 调试钩子：TIDY_OPEN=dirs|help 直接打开目录管理/规则说明窗；
    #           TIDY_PREVIEW=<文件> 直接开预览
    _open = os.environ.get("TIDY_OPEN", "").strip()
    if _open == "dirs":
        root.after(600, shot_dir_manager)
    elif _open == "help":
        root.after(600, rules_help)
    _pv = os.environ.get("TIDY_PREVIEW", "").strip()
    if _pv and os.path.isfile(_pv):
        _sib = []
        try:
            _dd = os.path.dirname(_pv)
            _sib = [os.path.join(_dd, n) for n in os.listdir(_dd)
                    if os.path.splitext(n)[1].lower() in MEDIA_EXT]
        except OSError:
            _sib = [_pv]

        def _go_pv():
            try:
                preview_file(_pv, siblings=_sib)
            except Exception:
                import traceback
                traceback.print_exc()
                raise
        root.after(700, _go_pv)

    # 窗口拉伸/最大化时内容要立刻重排，否则边缘会留下旧像素（拖影）
    _rs = {"w": 0, "h": 0, "t": 0.0}

    def _on_resize(e):
        if e.widget is not root:
            return
        if (e.width, e.height) == (_rs["w"], _rs["h"]):
            return
        _rs["w"], _rs["h"] = e.width, e.height
        now = time.time()
        if now - _rs["t"] < 0.08:
            return
        _rs["t"] = now
        try:
            root.after_idle(root.update_idletasks)
        except Exception:
            pass

    try:
        root.bind("<Configure>", _on_resize, add="+")
    except Exception:
        pass

    root.after(300, refresh_schedule)
    root.after(500, refresh_shot_task)
    root.after(700, refresh_cc_task)

    # 定时回查一次：任务被系统策略删掉、或用户手动删了，界面能自己跟上
    def _poll_tasks():
        try:
            refresh_shot_task()
            refresh_cc_task()
        except Exception:
            pass
        root.after(30000, _poll_tasks)

    root.after(900, _poll_tasks)

    # 数据目录失联时提示一次：磁盘没接、目录被删/被改名。别静默回默认目录，
    # 否则用户看到的是「历史都没了」，还以为程序把数据弄丢了。
    def _warn_missing_data():
        if DATA_DIR_MISSING or LOCATOR_BROKEN:
            where = _LOCATOR_SAID if LOCATOR_BROKEN else DEFAULT_DATA
            messagebox.showwarning(
                "数据目录找不到",
                "上次用的数据目录不在了：\n%s\n\n"
                "可能是磁盘/移动硬盘没接，或目录被删、被改名。\n"
                "程序先用默认目录：%s\n\n"
                "把盘接上或目录恢复后重启程序即可；"
                "也可以到「设置 → 目录位置」重新指定。" % (where, data_dir()))

    if DATA_DIR_MISSING or LOCATOR_BROKEN:
        root.after(1200, _warn_missing_data)

    # ── 系统托盘 + 关窗行为 ──
    def _to_ui(fn):
        try:
            root.after(0, fn)
        except Exception:
            pass

    def _show_main():
        try:
            root.deiconify()
            root.state("normal")
            root.lift()
            root.focus_force()
        except Exception:
            pass

    # 第二个实例会用命名事件「敲门」。事件在后台线程里收到，
    # 但 Tk 不是线程安全的（跨线程 root.after 会抛
    # RuntimeError: main thread is not in main loop），
    # 所以线程里只插旗，由主线程的定时器来收旗。
    _pending_show = {"v": False}

    def _poll_show():
        try:
            if _pending_show["v"]:
                _pending_show["v"] = False
                _show_main()
        except Exception:
            pass
        try:
            root.after(400, _poll_show)
        except Exception:
            pass

    def _quit_all():
        tray_stop()
        try:
            root.destroy()
        except Exception:
            sys.exit(0)

    def _tray_go(page, action):
        def run():
            _show_main()
            try:
                show(page)
            except Exception:
                pass
            try:
                action()
            except Exception as ex:
                log("[托盘] %s" % ex)
        return run

    def _tray_auto(mode):
        def run():
            ok, msg = autostart_set(mode)
            log("[开机自启] " + msg)
            try:
                refresh_auto_ui()
            except Exception:
                pass
            if not ok:
                messagebox.showinfo("没能开启强力自启", msg)
        _to_ui(run)

    def _res(name):
        base = getattr(sys, "_MEIPASS",
                       os.path.dirname(os.path.abspath(__file__)))
        p = os.path.join(base, name)
        if not os.path.exists(p):
            # 打包时忘了 --add-data 的话，退回 exe 旁边找，别默默用兜底蓝方块
            alt = os.path.join(HERE, name)
            if os.path.exists(alt):
                return alt
        return p

    def _close_action_now():
        """当前生效的关窗动作：tray / exit / ask。"""
        a = S.get("close_action")
        if a not in ("tray", "exit", "ask"):
            a = "tray" if S.get("close_to_tray", True) else "exit"
        return a

    def on_close():
        tray_ready = bool(_tray.get("ok"))
        if not tray_ready:
            # 没有托盘图标，藏起来就叫不回来了 —— 直接退
            try:
                log("[托盘] 没有托盘图标可用，关闭即退出")
            except Exception:
                pass
            _quit_all()
            return
        act = _close_action_now()
        if act == "ask" or not S.get("close_choice_made"):
            choice, remember = _ask_close_action(root)
            act = choice
            if remember:
                S["close_action"] = choice
                S["close_choice_made"] = True
                S["close_to_tray"] = (choice == "tray")
                try:
                    save_settings(S)
                except Exception:
                    pass
                try:
                    close_action_var.set(choice)
                except Exception:
                    pass
        keep = (act == "tray")
        if keep:
            root.withdraw()
            try:
                log("[托盘] 已最小化到托盘，右键托盘图标可以再打开或退出。")
            except Exception:
                pass
            # 头一次收进托盘提醒一下图标在哪，之后就不再烦人
            try:
                if not S.get("tray_hint_shown"):
                    tray_notify("我还在后台跑着。\n"
                                "图标在右下角任务栏托盘里（收在 ^ 里的话点开就有），"
                                "右键呼出菜单。", "整理助手")
                    S["tray_hint_shown"] = True
                    save_settings(S)
            except Exception:
                pass
        else:
            _quit_all()

    tray_ok = False
    if S.get("tray_enabled", True):
        spec = [
            ("item", "打开主窗口", lambda: _to_ui(_show_main)),
            ("sep", None, None),
            ("item", "扫描要整理的文件夹",
             lambda: _to_ui(_tray_go("整理", do_scan))),
            ("item", "清理截图（先扫描）",
             lambda: _to_ui(_tray_go("截图", do_shot_scan))),
            ("item", "清理缓存（先扫描）",
             lambda: _to_ui(_tray_go("缓存", cc_scan))),
            ("sep", None, None),
            ("auto", None, None),
            ("sep", None, None),
            ("item", "退出", lambda: _to_ui(_quit_all)),
            ("auto_set", None, _tray_auto),
        ]
        tray_ok = tray_start("整理助手", _res("icon.ico"), spec)

        def _place(attempt=1):
            # 托盘图标放哪由设置决定：taskbar 固定任务栏、overflow 只放折叠区、
            # system 完全交给 Windows 与用户拖动（拖到哪就一直待在哪）。
            # 推迟到 3 秒：等 pystray 的图标真正注册进托盘，否则 Explorer
            # 会在注册时把它自己的默认值再写回来。
            mode = S.get("tray_pin", "taskbar")
            try:
                wrote, bad = apply_tray_pin(mode)
            except Exception as ex:
                wrote, bad = 0, ["?%r" % (ex,)]
            try:
                with open(os.path.join(data_dir(), "tray.log"), "a",
                          encoding="utf-8") as _f:
                    _f.write("%s tray_pin mode=%s try=%d wrote=%s bad=%s\n"
                             % (datetime.datetime.now().strftime("%H:%M:%S"),
                                mode, attempt, wrote, bad))
            except Exception:
                pass
            if bad and attempt < 3:
                root.after(1500, lambda: _place(attempt + 1))

        if tray_ok:
            root.after(3000, _place)
        try:
            with open(os.path.join(data_dir(), "tray.log"), "a",
                      encoding="utf-8") as _f:
                _f.write("%s tray_ok=%s err=%s icon=%s\n"
                         % (datetime.datetime.now().strftime("%H:%M:%S"),
                            tray_ok, _tray.get("err", ""), _tray.get("icon")))
        except Exception:
            pass
        if not tray_ok:
            try:
                log("[托盘] 图标没能启动：" + _tray.get("err", ""))
            except Exception:
                pass

    # 第二个实例点开时会发这个事件：自启时把藏着的窗口叫出来，
    # 平时就把已经在跑的窗口提到前面（单实例闸挡住了重复进程）
    start_show_listener(lambda: _pending_show.__setitem__("v", True))
    root.after(400, _poll_show)

    root.protocol("WM_DELETE_WINDOW", on_close)
    if tray_only and not tray_ok:
        # 托盘没起来，藏着的窗口就再也叫不出来了 —— 退回到显示窗口
        try:
            root.deiconify()
            log("[托盘] 自启模式没能建起托盘图标，改为直接显示窗口")
        except Exception:
            pass

    root.mainloop()


# ─────────────────────────── 命令行 ───────────────────────────

def run_cli(folder):
    rules = load_rules()

    # --rules <yaml>：走 organize 引擎
    if "--rules" in sys.argv:
        i = sys.argv.index("--rules")
        cfg_path = sys.argv[i + 1] if len(sys.argv) > i + 1 else ""
        if not cfg_path or not os.path.exists(cfg_path):
            print("[X] 找不到规则文件")
            return 1
        with open(cfg_path, encoding="utf-8-sig") as f:
            text = f.read()
        simulate = "--apply" not in sys.argv
        print(f"[organize] {'预演' if simulate else '执行'}：{cfg_path}\n")
        out, ok = run_rules(text, simulate=simulate)
        print(out)
        return 0 if ok else 1

    if "--undo" in sys.argv:
        if not folder:
            # 没给文件夹就用最近一条整理记录
            try:
                for fn in sorted(os.listdir(hist_dir()), reverse=True):
                    if fn.endswith(".json"):
                        folder = json.load(
                            open(os.path.join(hist_dir(), fn),
                                 encoding="utf-8")).get("folder", "")
                        break
            except Exception:
                folder = ""
        n, failed = undo(folder)
        print(f"[OK] 已还原 {n} 个文件" if n else "没有可撤销的记录")
        for name, why in failed[:10]:
            print(f"  {name}  <- {why}")
        return 0

    force = "--force" in sys.argv
    recursive = "--recursive" in sys.argv
    date_fmt = "%Y/%m" if "--date" in sys.argv else ""
    use_content = None
    if "--no-content" in sys.argv:
        use_content = False
    elif "--content" in sys.argv:
        use_content = True
    policy = rules.conflict_policy
    if "--on-conflict" in sys.argv:
        i = sys.argv.index("--on-conflict")
        if len(sys.argv) > i + 1 and sys.argv[i + 1] in ("rename", "skip", "overwrite"):
            policy = sys.argv[i + 1]

    if recursive:
        plans, blocked = scan_tree(folder, rules, force=force, use_content=use_content)
    else:
        one = scan(folder, rules, force=force, use_content=use_content)
        plans = [one] if one.by_cat else []
        blocked = [] if one.by_cat else ([one] if one.error else [])

    if not plans:
        if blocked:
            print("[X]", blocked[0].error)
            for e in blocked[0].evidence:
                print("   依据：" + e)
            if blocked[0].skip_subtree:
                print("   该目录及其全部子目录已整体放弃。")
        else:
            print("没有找到需要整理的文件。")
        return 1

    total = sum(p.total for p in plans)
    size = sum(p.total_size for p in plans)
    print(f"\n目录：{folder}")
    print(f"规则：{RULES_SOURCE}   模式：{'递归' if recursive else '仅当层'}"
          f"   重名策略：{policy}" + (f"   按 {date_fmt} 分目录" if date_fmt else "")
          + ("   按内容识别" if (rules.content_enabled if use_content is None else use_content) else ""))
    print(f"共 {total} 个文件，{human(size)}，涉及 {len(plans)} 个目录\n")

    hits = []
    for p in plans:
        rel = os.path.relpath(p.folder, folder)
        if rel != ".":
            print(f"  [{rel}]")
        for cat in p.categories():
            files = p.by_cat[cat]
            print(f"    {cat:<15}{len(files):>5} 个  {human(sum(s for _, s, _ in files)):>10}")
            for name, _, _ in files[:2]:
                print(f"          · {name}")
            if len(files) > 2:
                print(f"          … 还有 {len(files) - 2} 个")
        hits.extend(p.content_hits)

    if hits:
        print(f"\n按内容改归类的 {len(hits)} 个：")
        for name, cat in hits[:10]:
            print(f"  {name}  ->  {cat}")

    skipped = sum(len(p.skipped) for p in plans)
    if skipped:
        print(f"\n跳过 {skipped} 个（快捷方式 / 系统文件 / 最近改动 / 路径过长等）")
    if blocked:
        print(f"另有 {len(blocked)} 个位置被整体跳过（程序/工程/源码/文件不足）：")
        for p in blocked[:10]:
            print(f"  {os.path.relpath(p.folder, folder)}  <- {p.error}")

    if "--csv" in sys.argv:
        i = sys.argv.index("--csv")
        out = sys.argv[i + 1] if len(sys.argv) > i + 1 else "整理预览.csv"
        with open(out, "w", encoding="utf-8-sig", newline="") as f:
            w = csv.writer(f)
            w.writerow(["位置", "分类", "文件名", "大小(字节)", "修改时间"])
            for p in plans:
                rel = os.path.relpath(p.folder, folder)
                for cat in p.categories():
                    for name, sz, mt in p.by_cat[cat]:
                        w.writerow([rel, cat, name, sz,
                                    datetime.datetime.fromtimestamp(mt).strftime("%Y-%m-%d %H:%M")])
        print(f"\n预览已导出：{out}")

    if "--apply" in sys.argv:
        n, failed, _ = apply(plans, folder, rules, policy=policy, date_fmt=date_fmt)
        print(f"\n[完成] 已移动 {n} 个文件")
        for name, why in failed[:10]:
            print(f"  失败 {name}  <- {why}")
        return 0

    print("\n这是预演，未做任何改动。加 --apply 执行，--undo 撤销。")
    return 0


def hide_console():
    if not getattr(sys, "frozen", False):
        return
    try:
        import ctypes
        ctypes.windll.kernel32.FreeConsole()
    except Exception:
        pass
    try:
        sys.stdout = open(os.devnull, "w", encoding="utf-8")
        sys.stderr = open(os.devnull, "w", encoding="utf-8")
    except Exception:
        pass


def console_is_ours():
    try:
        import ctypes
        arr = (ctypes.c_uint * 8)()
        return ctypes.windll.kernel32.GetConsoleProcessList(arr, 8) <= 1
    except Exception:
        return False


def detect_gui_build():
    """判断当前是不是「GUI 子系统」的界面版。
    直接读自身 PE 头的 Subsystem 字段（2=GUI，3=控制台），比 sys.stdout 可靠。"""
    if not getattr(sys, "frozen", False):
        return False
    try:
        import struct
        with open(sys.executable, "rb") as f:
            head = f.read(4096)
        pe = struct.unpack_from("<I", head, 0x3C)[0]
        sub = struct.unpack_from("<H", head, pe + 0x5C)[0]
        return sub == 2
    except Exception:
        return sys.stdout is None


def run_clean_cache():
    """计划任务入口：只清「安全」级别的缓存，静默执行。"""
    removed = freed = 0
    fails = []
    skipped = []
    refused = []
    rules = app_guard_rules()
    for it in CACHE_ITEMS:
        if it["level"] != 1 or it["kind"] == "recycle":
            continue
        real = []
        for pat in it["paths"]:
            for p in _expand_cache_paths(pat):
                bad, _why = cache_path_forbidden(p)
                if not bad and p not in real:
                    real.append(p)
        if not real:
            continue
        n, f, s = clean_cache_paths(real, rules=rules, skipped=skipped)
        removed += n
        freed += s
        fails.extend(f)
    for d in (S.get("cache_custom_dirs") or []):
        # 自定义目录必须先过准入判定：盘符根、程序目录、程序目录的父目录全部拒绝
        why_bad = check_cache_custom_dir(d, rules)
        if why_bad:
            refused.append((d, why_bad))
            continue
        n, f, s = clean_cache_paths([d], rules=rules, skipped=skipped)
        removed += n
        freed += s
        fails.extend(f)
    try:
        os.makedirs(data_dir(), exist_ok=True)
        p = os.path.join(data_dir(), "缓存清理.log")
        with open(p, "a", encoding="utf-8") as f:
            f.write("%s  删除 %d 个文件，释放 %s，失败 %d\n"
                    % (datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                       removed, human(freed), len(fails)))
            # 失败明细：以前只记个数，查不出所以然；现在记路径 + WinError
            for _path, _why in fails[:40]:
                f.write("    ! %s  <- %s\n" % (_path, _why))
            if len(fails) > 40:
                f.write("    …… 另有 %d 条未列出\n" % (len(fails) - 40))
            # 被拒绝的自定义缓存目录、被跳过的程序目录，都要留痕
            for _path, _why in refused:
                f.write("    x 拒绝自定义目录 %s  <- %s\n" % (_path, _why))
            if skipped:
                f.write("    - 跳过 %d 项程序文件/目录（规则：程序目录一律不动）\n"
                        % len(skipped))
                for _path, _why in skipped[:20]:
                    f.write("       . %s  <- %s\n" % (_path, _why))
    except Exception:
        pass
    return 0


def run_clean_shots():
    """计划任务入口：按设置静默清理截图，不弹任何窗口。"""
    dirs = S.get("shot_dirs") or shot_dirs_default()
    keep = S.get("shot_keep_days", 7)
    mk = S.get("shot_min_kb", 0)
    to_trash = S.get("shot_to_trash", True)
    hits = find_screenshots(dirs, keep, mk)
    ok, fail, size = ([], [], 0)
    if hits:
        ok, fail, size = clean_screenshots(dirs, keep, mk, to_trash)
    try:
        os.makedirs(data_dir(), exist_ok=True)
        p = os.path.join(data_dir(), "截图清理.log")
        with open(p, "a", encoding="utf-8") as f:
            f.write("%s  删除 %d 张，释放 %s，失败 %d\n"
                    % (datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                       len(ok), human(size), len(fail)))
    except Exception:
        pass
    return 0


# ──────────────────── 无 GUI 引擎（JSON Lines RPC）────────────────────
# 原生客户端用 stdin/stdout 逐行 JSON 调用；只复用现有 scan/scan_tree/apply，
# 不复制业务逻辑。约定：stdout 每行恰好一个响应，日志与异常全部走 stderr。

class EngineError(Exception):
    """可以直接回给客户端的可读错误（参数错 / 未知方法等）。"""


_ENGINE_RULES = None


def _engine_err_text(ex):
    """把异常翻译成中文可读的 error 文本。"""
    if isinstance(ex, EngineError):
        return str(ex)
    if isinstance(ex, SystemExit):
        return "引擎初始化失败：%s" % (getattr(ex, "code", "") or "")
    return "内部错误：%s" % (str(ex) or ex.__class__.__name__)


def _engine_rules():
    """惰性加载规则：规则文件缺失时 ping / settings.get 仍然可用。"""
    global _ENGINE_RULES
    if _ENGINE_RULES is None:
        try:
            _ENGINE_RULES = load_rules()
        except SystemExit as ex:
            raise EngineError(_engine_err_text(ex))
    return _ENGINE_RULES


def _engine_progress(*_args, **_kwargs):
    """进度回调：stdout 只允许出 JSON，所以引擎模式把进度吞掉。"""
    return None


def _engine_plan_json(plan):
    """Plan → 客户端可反序列化的 dict（字段固定，方便 WPF 绑定）。"""
    groups = []
    for cat in sorted(plan.by_cat):
        files = plan.by_cat[cat]
        groups.append({
            "cat": cat,
            "count": len(files),
            "size": sum(s for _, s, _ in files),
            "files": [{"name": n, "size": int(s), "mtime": float(mt)}
                      for n, s, mt in files],
        })
    return {
        "folder": plan.folder,
        "depth": int(getattr(plan, "depth", 0) or 0),
        "error": plan.error,
        "blocked_kind": plan.blocked_kind,
        "evidence": list(plan.evidence or []),
        "skipped": [{"name": n, "reason": r} for n, r in (plan.skipped or [])],
        "groups": groups,
    }


def _engine_str_list(params, name):
    """取可选字符串数组参数；给了非数组或含非字符串就报错。"""
    if name not in params or params[name] is None:
        return None
    v = params[name]
    if not isinstance(v, list) or any(not isinstance(x, str) for x in v):
        raise EngineError("参数 %s 必须是字符串数组或 null" % name)
    v = [x.strip() for x in v if x.strip()]
    return v or None


def _engine_get(params, name, default, kind):
    """取可选参数；给了但类型不对就报可读错误。"""
    if name not in params or params[name] is None:
        return default
    v = params[name]
    if not isinstance(v, kind):
        raise EngineError("参数 %s 类型不对" % name)
    return v


def _engine_folder(params):
    """校验并规范化 path 参数。"""
    v = params.get("path")
    if not isinstance(v, str) or not v.strip():
        raise EngineError("参数 path 必须是非空字符串")
    return os.path.abspath(os.path.expandvars(os.path.expanduser(v.strip())))


def _engine_paths(params):
    """取可选的 paths 数组（目录或文件混合）。没给就返回空列表。"""
    raw = params.get("paths")
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise EngineError("参数 paths 必须是字符串数组")
    out = []
    for x in raw:
        if not isinstance(x, str):
            raise EngineError("参数 paths 必须是字符串数组")
        v = x.strip()
        if v:
            out.append(os.path.abspath(os.path.expandvars(os.path.expanduser(v))))
    if len(out) > 500:
        raise EngineError("一次最多 500 个来源")
    return out


def _paths_root(paths):
    """多来源时给 history / 撤销用的根路径：取公共父目录，取不到就用第一个。"""
    if not paths:
        return ""
    if len(paths) == 1:
        p = paths[0]
        return p if os.path.isdir(p) else (os.path.dirname(p) or p)
    dirs = [p if os.path.isdir(p) else os.path.dirname(p) for p in paths]
    try:
        root = os.path.commonpath(dirs)
    except ValueError:              # 跨盘
        return dirs[0]
    return root or dirs[0]


def _dedupe_plans(plans):
    """同一个文件被多个来源点到（目录里点了一次、又把文件本身加进来）时只保留一次。

    按 (目录, 文件名) 归一化去重，先出现的计划优先（目录计划排在文件计划前面）。
    被去重掉的计划如果没有别的文件、也没有跳过记录，就整个丢掉。
    """
    seen = set()
    out = []
    for p in plans:
        folder = os.path.normcase(os.path.abspath(p.folder or ""))
        for cat in list(p.by_cat):
            kept = []
            for name, size, mt in p.by_cat[cat]:
                key = (folder, name.lower())
                if key in seen:
                    continue
                seen.add(key)
                kept.append((name, size, mt))
            if kept:
                p.by_cat[cat] = kept
            else:
                del p.by_cat[cat]
        if p.by_cat or p.skipped or p.error:
            out.append(p)
    return out


def _engine_scan_plans(params):
    """按协议参数扫描一次，返回 (folder, rules, plans, blocked, applied)。

    path 与 paths 二选一：path 只扫一个目录；paths 可以混着给目录和文件。
    """
    paths = _engine_paths(params)
    folder = "" if paths else _engine_folder(params)
    recursive = _engine_get(params, "recursive", True, bool)
    skip_recent = _engine_get(params, "skip_recent", True, bool)
    skip_shortcuts = _engine_get(params, "skip_shortcuts", True, bool)
    force = _engine_get(params, "force", False, bool)
    by_date = _engine_get(params, "by_date", False, bool)
    allow_root = _engine_get(params, "allow_root", False, bool)
    conflict = params.get("conflict")
    if conflict is not None:
        if not isinstance(conflict, str) or conflict.strip().lower() not in (
                "rename", "skip", "overwrite"):
            raise EngineError("参数 conflict 只能是 rename / skip / overwrite")
        conflict = conflict.strip().lower()
    use_content = params.get("use_content")
    if use_content is not None and not isinstance(use_content, bool):
        raise EngineError("参数 use_content 必须是布尔值或 null")
    exclude_exts = _engine_str_list(params, "exclude_exts")
    exclude_dirs = _engine_str_list(params, "exclude_dirs")
    min_age = params.get("min_age_minutes")
    if min_age is not None:
        if isinstance(min_age, bool) or not isinstance(min_age, (int, float)):
            raise EngineError("参数 min_age_minutes 必须是数字或 null")
        if min_age < 0 or min_age > 1440:
            raise EngineError("参数 min_age_minutes 必须在 0~1440 之间")

    rules = _engine_rules()
    if min_age is not None:
        # Rules 是进程内缓存对象，改之前先浅拷贝，避免影响后续请求
        import copy as _copy
        rules = _copy.copy(rules)
        rules.min_age = int(round(float(min_age) * 60))

    if paths:
        plans, blocked = [], []
        dirs = [p for p in paths if os.path.isdir(p)]
        files = [p for p in paths if os.path.isfile(p)]
        for d in dirs:
            if recursive:
                ps, bl = scan_tree(d, rules, skip_recent=skip_recent,
                                   skip_shortcuts=skip_shortcuts, force=force,
                                   use_content=use_content,
                                   progress=_engine_progress,
                                   by_date=by_date, conflict=conflict,
                                   exclude_exts=exclude_exts,
                                   exclude_dirs=exclude_dirs)
            else:
                one = scan(d, rules, skip_recent=skip_recent,
                           skip_shortcuts=skip_shortcuts, force=force,
                           use_content=use_content, allow_root=allow_root,
                           progress=_engine_progress,
                           by_date=by_date, conflict=conflict,
                           exclude_exts=exclude_exts, exclude_dirs=exclude_dirs)
                ps, bl = ([one], []) if one.by_cat else ([], ([one] if one.error else []))
            plans += ps
            blocked += bl
        if files:
            ps, bl = scan_files(files, rules, skip_recent=skip_recent, force=force,
                                use_content=use_content, progress=_engine_progress,
                                by_date=by_date, conflict=conflict,
                                exclude_exts=exclude_exts, exclude_dirs=exclude_dirs)
            plans += ps
            blocked += bl
        plans = _dedupe_plans(plans)
        for p in paths:
            if p not in dirs and p not in files:
                bp = Plan(p)
                bp.error = "路径不存在或无法读取"
                blocked.append(bp)
        folder = _paths_root(paths)
    elif recursive:
        plans, blocked = scan_tree(folder, rules, skip_recent=skip_recent,
                                   skip_shortcuts=skip_shortcuts, force=force,
                                   use_content=use_content,
                                   progress=_engine_progress,
                                   by_date=by_date, conflict=conflict,
                                   exclude_exts=exclude_exts,
                                   exclude_dirs=exclude_dirs)
    else:
        one = scan(folder, rules, skip_recent=skip_recent,
                   skip_shortcuts=skip_shortcuts, force=force,
                   use_content=use_content, allow_root=allow_root,
                   progress=_engine_progress,
                   by_date=by_date, conflict=conflict,
                   exclude_exts=exclude_exts, exclude_dirs=exclude_dirs)
        if one.by_cat:
            plans, blocked = [one], []
        else:
            plans, blocked = [], ([one] if one.error else [])
    applied = {"skip_shortcuts": skip_shortcuts, "force": force,
               "by_date": by_date, "conflict": conflict,
               "min_age_minutes": min_age,
               "paths": paths,
               "exclude_exts": exclude_exts or [],
               "exclude_dirs": exclude_dirs or []}
    return folder, rules, plans, blocked, applied


def _engine_scan(params):
    """scan 方法：只返回预演结果，绝不移动文件。"""
    _folder, _rules, plans, blocked, applied = _engine_scan_plans(params)
    return {
        "plans": [_engine_plan_json(p) for p in plans],
        "blocked": [_engine_plan_json(p) for p in blocked],
        "total": sum(p.total for p in plans),
        "total_size": sum(p.total_size for p in plans),
        "applied": applied,
    }


def _engine_organize(params):
    """organize 方法：confirm=false 只预演；confirm=true 才真正移动。"""
    confirm = _engine_get(params, "confirm", False, bool)
    policy = params.get("policy")
    if policy is not None:
        if not isinstance(policy, str) or policy.strip().lower() not in (
                "rename", "skip", "overwrite"):
            raise EngineError("参数 policy 只能是 rename / skip / overwrite")
        policy = policy.strip().lower()
    date_fmt = params.get("date_fmt")
    if date_fmt is not None and not isinstance(date_fmt, str):
        raise EngineError("参数 date_fmt 必须是字符串或 null")
    dest_root = params.get("dest_root")
    if dest_root is not None:
        if not isinstance(dest_root, str) or not dest_root.strip():
            raise EngineError("参数 dest_root 必须是非空字符串或 null")
        dest_root = os.path.abspath(os.path.expandvars(
            os.path.expanduser(dest_root.strip())))

    folder, rules, plans, blocked, _applied = _engine_scan_plans(params)
    total = sum(p.total for p in plans)
    total_size = sum(p.total_size for p in plans)

    if not confirm:                     # 预演：只回计划，不碰磁盘
        return {"dry_run": True,
                "plans": [_engine_plan_json(p) for p in plans],
                "total": total, "total_size": total_size}

    eligible = [p for p in plans if not p.error and p.by_cat]  # 被拦的目录 / 空计划不参与执行
    blocked_out = [{"folder": p.folder, "error": p.error or "已跳过"}
                   for p in list(blocked) + [p for p in plans if p.error]]
    moved, failed, hist = 0, [], None
    if eligible:
        moved, failed, hist = apply(eligible, folder, rules, policy=policy,
                                    date_fmt=date_fmt,
                                    progress=_engine_progress,
                                    dest_root=dest_root)
    return {"dry_run": False,
            "moved": int(moved),
            "failed": [{"name": n, "why": w} for n, w in (failed or [])],
            "history": hist,
            "total": total,
            "blocked": blocked_out}


def _engine_undo(params):
    """undo 方法：撤销该文件夹最近一次整理，直接复用业务 undo()。

    注意业务 undo() 的失败列表有两种形状：整理出错时是 (文件名, 原因) 元组，
    「没有整理记录」这类业务提示是纯字符串，这里统一转成 {name, why}。
    """
    folder = _engine_folder(params)
    if not os.path.exists(folder):
        raise EngineError("路径不存在：%s" % folder)
    if not os.path.isdir(folder):
        raise EngineError("路径不是目录：%s" % folder)

    restored, failed = undo(folder)
    items = []
    for item in failed or []:
        if isinstance(item, (tuple, list)) and len(item) >= 2:
            items.append({"name": str(item[0]), "why": str(item[1])})
        else:
            # 业务提示（这个文件夹没有整理记录 / 没有整理记录）不是协议错误
            items.append({"name": "", "why": str(item)})
    return {"restored": int(restored), "failed": items, "folder": folder}


_FILES_DELETE_ROOTS = None


def _files_delete_key(p):
    """删除判定用的规范路径（大小写不敏感、无尾分隔符）。"""
    return os.path.normcase(os.path.normpath(os.path.abspath(p)))


def _files_delete_system_roots():
    """返回 (整棵子树禁止删除的根, 只禁止删除目录本身的根)。

    · Windows / Program Files / ProgramData：整棵树都不允许删；
    · Users 根、每个用户配置目录、桌面/文档/图片/下载 根目录：只挡目录本身，
      其下的文件仍允许删（比如桌面上的单个文件）。
    """
    global _FILES_DELETE_ROOTS
    if _FILES_DELETE_ROOTS is not None:
        return _FILES_DELETE_ROOTS

    tree, self_only = set(), set()

    def add(bucket, p):
        if not p:
            return
        try:
            bucket.add(_files_delete_key(p))
        except Exception:
            pass

    drive = (os.environ.get("SystemDrive") or "C:").strip().rstrip("\\/") or "C:"
    add(tree, os.environ.get("SystemRoot"))
    add(tree, os.environ.get("WINDIR"))
    add(tree, os.path.join(drive, "Windows"))
    for var, name in (("ProgramFiles", "Program Files"),
                      ("ProgramFiles(x86)", "Program Files (x86)"),
                      ("ProgramData", "ProgramData")):
        add(tree, os.environ.get(var))
        add(tree, os.path.join(drive, name))

    users = os.path.join(drive, "Users")
    add(self_only, users)
    # 单个用户配置目录本身也不允许删；其下文件按「桌面/文档…」规则判断
    try:
        with os.scandir(users) as it:
            for e in it:
                try:
                    if e.is_dir(follow_symlinks=False):
                        add(self_only, e.path)
                except OSError:
                    continue
    except OSError:
        pass

    bases = [os.environ.get("USERPROFILE"),
             os.environ.get("OneDrive"),
             os.environ.get("OneDriveConsumer"),
             os.environ.get("OneDriveCommercial")]
    user = os.environ.get("USERNAME")
    if user:
        bases.append(os.path.join(users, user))
    shells = ("Desktop", "Documents", "Pictures", "Downloads",
              "桌面", "文档", "图片", "下载")
    for base in bases:
        if not base:
            continue
        for name in shells:
            add(self_only, os.path.join(base, name))

    _FILES_DELETE_ROOTS = (tree, self_only)
    return _FILES_DELETE_ROOTS


def _files_delete_guard_why(p):
    """files.delete 的单路径安全判定；None = 可以删，否则返回拒绝原因。"""
    try:
        key = _files_delete_key(p)
    except Exception:
        return "路径不合法"
    if is_drive_root(key):
        drive, _tail = os.path.splitdrive(key)
        return "%s\\ 是盘符根目录，不能删除" % drive

    # 引擎自己的数据目录：本身和其下内容都不能删，也不能删它的上级
    data_key = _files_delete_key(data_dir())
    if key == data_key or key.startswith(data_key + os.sep):
        return "这是整理助手自己的数据目录（或其内容），不能删除"
    if data_key.startswith(key + os.sep):
        return "删除它会连整理助手的数据目录一起删掉，已拒绝"

    tree, self_only = _files_delete_system_roots()
    for root in tree:
        if key == root or key.startswith(root + os.sep):
            return "系统目录不允许删除"
    if key in self_only:
        return "系统目录不允许删除"
    return None


def _engine_files_delete(params):
    """files.delete：预演 / 移入回收站 / 永久删除。

    confirm=false 只回规范化后的绝对路径，不碰磁盘；confirm=true 时逐项过安全
    判定，被拒绝的进 failed，不影响其它项。删除动作复用 trash_delete /
    hard_delete，不在这里重写删除逻辑。
    """
    paths = _engine_path_list(params, "paths")
    mode = params.get("mode", "trash")
    if mode is None:
        mode = "trash"
    if not isinstance(mode, str) or mode.strip().lower() not in (
            "trash", "permanent"):
        raise EngineError("参数 mode 只能是 trash / permanent")
    mode = mode.strip().lower()
    confirm = _engine_get(params, "confirm", False, bool)

    if not confirm:
        # 预演也要给足信息：每一项多大、为什么会被拒。AI 的审批卡片直接
        # 用这份结果，界面上的「共 X 项 / Y GB」就是这个和，不另算一遍。
        # 目录体积用 _tree_size 但限制文件数——预演不能因为一个 20 万文件的
        # 目录卡住整个引擎（引擎是单线程的，卡住等于整机界面停摆）。
        items = []
        failed = []
        total = 0
        for p in paths:
            why = _files_delete_guard_why(p)
            exists = os.path.exists(p)
            if not why and not exists:
                why = "路径不存在"
            size = None
            files = 0
            partial = False
            if not why:
                try:
                    size, files = _tree_size(p, 20000)
                    total += size
                    if os.path.isdir(p) and files >= 20000:
                        partial = True
                except OSError:
                    size = None
            if why:
                failed.append({"target": p, "why": why})
            items.append({"path": p, "size": size, "files": files,
                          "exists": exists, "why": why,
                          "partial": partial})
        return {"dry_run": True, "paths": paths, "mode": mode,
                "items": items, "failed": failed,
                "total_size": total, "count": len(paths) - len(failed)}

    deleted, failed, todo = [], [], []
    for p in paths:
        why = _files_delete_guard_why(p)
        if not why and not os.path.exists(p):
            why = "路径不存在"
        if why:
            failed.append({"target": p, "why": why})
            continue
        todo.append(p)

    if todo:
        pending = []
        if mode == "trash":
            ok, bad = trash_delete(todo)
        else:
            ok, bad, pending = hard_delete(todo)
        deleted.extend(ok)
        for t, w in bad or []:
            failed.append({"target": t, "why": str(w) or "删除失败"})
        for t in pending or []:
            failed.append({"target": t,
                           "why": "文件被占用，已登记重启后删除"})

    return {"dry_run": False, "mode": mode, "deleted": deleted,
            "failed": failed, "count": len(deleted)}


def _engine_settings():
    """settings.get：现读磁盘配置，保证与界面里改过的值一致。"""
    s = load_settings()
    dd = s.get("data_dir") or DEFAULT_DATA
    return {
        "data_dir": dd,
        "cache_dir": s.get("cache_dir") or os.path.join(dd, "cache"),
        "conflict_policy": s.get("conflict_policy"),
        "recursive_depth": s.get("recursive_depth"),
        "default_recursive": bool(s.get("default_recursive")),
        "default_content": bool(s.get("default_content")),
        "log_keep_days": s.get("log_keep_days"),
        "close_action": s.get("close_action"),
        "tray_pin": s.get("tray_pin"),
        # 索引新鲜度三键：能写就必须能读回来。少一个，设置页重新加载后
        # 控件会退回默认值 —— 用户改过的东西看着像没保存。
        "index_freshness": s.get("index_freshness") or "check",
        "index_max_mb": int(s.get("index_max_mb") or 2048),
        "index_rebuild_idle": bool(s.get("index_rebuild_idle", True)),
        "settings_path": SETTINGS_PATH,
    }


def _engine_ping():
    """ping：探活与自描述，客户端启动时先打一发。"""
    return {
        "engine": "tidy",
        "pid": os.getpid(),
        "data_dir": data_dir(),
        "settings_path": SETTINGS_PATH,
        "python": sys.version.split()[0],
    }


# ── --engine：截图 / 缓存 / 程序 / 搜索 相关方法 ──────────────────────
#
# 这些方法只做「参数校验 + 调用既有业务函数 + 转成客户端要的结构」，
# 删除/统计/枚举的规则全部留在上面的业务函数里，别在这里复制一份。

_CACHE_LEVEL_JSON = {1: "safe", 2: "caution", 3: "advanced"}
_CACHE_LEVEL_RANK = {"safe": 1, "caution": 2, "advanced": 3}


def _engine_path_list(params, name, required=True):
    """取路径数组参数：展开成绝对路径；缺失/类型不对都抛 EngineError。"""
    raw = params.get(name)
    if raw is None:
        if required:
            raise EngineError("参数 %s 必须是非空数组" % name)
        return None
    if not isinstance(raw, list) or not raw:
        raise EngineError("参数 %s 必须是非空数组" % name)
    out = []
    for item in raw:
        if not isinstance(item, str) or not item.strip():
            raise EngineError("参数 %s 里的每一项都必须是非空字符串" % name)
        p = os.path.expanduser(os.path.expandvars(item.strip()))
        out.append(os.path.normpath(os.path.abspath(p)))
    return out


def _engine_cache_groups(include_custom=True):
    """把缓存清单整理成 [{name, level, items}]，并返回总占用。"""
    items = list(CACHE_ITEMS)
    if include_custom:
        items.extend(cache_custom_items())
    groups = {}
    order = []
    for it in items:
        if it.get("kind") == "recycle":
            continue                  # 回收站不是目录，缓存页不列
        gname = it.get("group") or "其他"
        level = _CACHE_LEVEL_JSON.get(int(it.get("level") or 1), "safe")
        if gname not in groups:
            groups[gname] = {"name": gname, "level": "safe", "items": []}
            order.append(gname)
        g = groups[gname]
        if _CACHE_LEVEL_RANK[level] > _CACHE_LEVEL_RANK[g["level"]]:
            g["level"] = level        # 组级别取组内最高风险，偏保守
        real = []
        for pat in (it.get("paths") or []):
            for p in _expand_cache_paths(pat):
                if cache_path_forbidden(p)[0]:
                    continue
                if p not in real:
                    real.append(p)
        if not real:
            # 本机没有这个目录也返回一条 exists=false 的记录，客户端好显示「不存在」
            pat = (it.get("paths") or [""])[0]
            g["items"].append({
                "path": os.path.expandvars(pat), "label": it.get("name") or "",
                "size": 0, "exists": False, "level": level,
                "item_id": it.get("id") or "", "note": it.get("note") or "",
            })
            continue
        for p in real:
            size, _count = _tree_size(p)
            label = it.get("name") or os.path.basename(p)
            if len(real) > 1:
                # 同一项展开成多个目录时加后缀，否则列表里全是重名
                suffix = os.path.basename(p) if os.path.isfile(p) else (
                    os.path.basename(os.path.dirname(p)) or os.path.basename(p))
                label = "%s（%s）" % (label, suffix)
            g["items"].append({
                "path": p, "label": label, "size": int(size), "exists": True,
                "level": level, "item_id": it.get("id") or "",
                "note": it.get("note") or "",
            })
    out, total = [], 0
    for gname in order:
        g = groups[gname]
        g["items"].sort(key=lambda x: (-x["size"], x["label"]))
        total += sum(i["size"] for i in g["items"])
        out.append(g)
    return out, int(total)


# ── 视频 / 相机格式缩略图：走 Windows Shell 缩略图，缓存成 PNG ──────────
VIDEO_EXTS = {".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".wmv",
              ".flv", ".ts", ".m2ts", ".3gp", ".mpg", ".mpeg"}
CAMERA_EXTS = {".tif", ".tiff", ".heic", ".heif", ".dng", ".cr2", ".cr3",
               ".nef", ".arw", ".raw", ".orf", ".rw2", ".raf", ".srw", ".pef"}


class _GUID(ctypes.Structure):
    _fields_ = [("Data1", ctypes.c_ulong), ("Data2", ctypes.c_ushort),
                ("Data3", ctypes.c_ushort), ("Data4", ctypes.c_ubyte * 8)]


_IID_IShellItemImageFactory = _GUID(
    0xBCC18B79, 0xBA16, 0x442F,
    (ctypes.c_ubyte * 8)(0x80, 0xC4, 0x8A, 0x59, 0xC3, 0x0C, 0x46, 0x3B))


class _SIZE_T(ctypes.Structure):
    _fields_ = [("cx", ctypes.c_long), ("cy", ctypes.c_long)]


def _hbitmap_to_png(hbm):
    """HBITMAP（32bpp）-> PNG 字节；失败返回 b\"\"。"""
    try:
        _icon_api_init()
        user32 = ctypes.windll.user32
        gdi32 = ctypes.windll.gdi32

        class BITMAP(ctypes.Structure):
            _fields_ = [("bmType", ctypes.c_long), ("bmWidth", ctypes.c_long),
                        ("bmHeight", ctypes.c_long), ("bmWidthBytes", ctypes.c_long),
                        ("bmPlanes", ctypes.c_ushort), ("bmBitsPixel", ctypes.c_ushort),
                        ("bmBits", ctypes.c_void_p)]

        class BIH(ctypes.Structure):
            _fields_ = [("biSize", ctypes.c_uint), ("biWidth", ctypes.c_long),
                        ("biHeight", ctypes.c_long), ("biPlanes", ctypes.c_ushort),
                        ("biBitCount", ctypes.c_ushort), ("biCompression", ctypes.c_uint),
                        ("biSizeImage", ctypes.c_uint), ("biXPelsPerMeter", ctypes.c_long),
                        ("biYPelsPerMeter", ctypes.c_long), ("biClrUsed", ctypes.c_uint),
                        ("biClrImportant", ctypes.c_uint)]

        bm = BITMAP()
        if not gdi32.GetObjectW(hbm, ctypes.sizeof(bm), ctypes.byref(bm)):
            return b""
        w, h = int(bm.bmWidth), int(bm.bmHeight)
        if w <= 0 or h <= 0:
            return b""
        bi = BIH()
        bi.biSize = ctypes.sizeof(BIH)
        bi.biWidth = w
        bi.biHeight = -h
        bi.biPlanes = 1
        bi.biBitCount = 32
        buf = ctypes.create_string_buffer(w * h * 4)
        hdc = user32.GetDC(None)
        try:
            ok = gdi32.GetDIBits(hdc, hbm, 0, h, buf, ctypes.byref(bi), 0)
        finally:
            user32.ReleaseDC(None, hdc)
        if not ok:
            return b""
        bgra = buf.raw
        rgba = bytearray(len(bgra))
        rgba[0::4] = bgra[2::4]
        rgba[1::4] = bgra[1::4]
        rgba[2::4] = bgra[0::4]
        rgba[3::4] = bgra[3::4]
        if not any(rgba[3::4]):
            rgba[3::4] = b"\xff" * (w * h)
        return _rgba_to_png(w, h, bytes(rgba))
    except Exception:
        return b""


def _shell_thumb_png(path, size=256):
    """用 IShellItemImageFactory 取系统缩略图（视频/HEIC/TIFF/RAW 都覆盖）。"""
    try:
        ole32 = ctypes.windll.ole32
        shell32 = ctypes.windll.shell32
        try:
            ole32.CoInitialize(None)
        except Exception:
            pass
        shell32.SHCreateItemFromParsingName.argtypes = [
            ctypes.c_wchar_p, ctypes.c_void_p, ctypes.POINTER(_GUID),
            ctypes.POINTER(ctypes.c_void_p)]
        shell32.SHCreateItemFromParsingName.restype = ctypes.c_long
        item = ctypes.c_void_p()
        hr = shell32.SHCreateItemFromParsingName(
            ctypes.c_wchar_p(path), None,
            ctypes.byref(_IID_IShellItemImageFactory), ctypes.byref(item))
        if hr != 0 or not item:
            return b""
        try:
            vtbl = ctypes.cast(item, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
            get_image = ctypes.WINFUNCTYPE(
                ctypes.c_long, ctypes.c_void_p, _SIZE_T, ctypes.c_int,
                ctypes.POINTER(ctypes.c_void_p))(vtbl[3])
            # 0x8 = SIIGBF_THUMBNAILONLY：优先要真实画面；没有缩略图再退回图标
            for flags in (0x8, 0):
                hbm = ctypes.c_void_p()
                hr = get_image(item, _SIZE_T(size, size), flags, ctypes.byref(hbm))
                if hr != 0 or not hbm:
                    continue
                try:
                    png = _hbitmap_to_png(hbm)
                finally:
                    ctypes.windll.gdi32.DeleteObject(hbm)
                if png:
                    return png
            return b""
        finally:
            release = ctypes.WINFUNCTYPE(ctypes.c_ulong, ctypes.c_void_p)(vtbl[2])
            release(item)
    except Exception:
        return b""


def shot_thumb_png(src, size=256, force=False):
    """视频/相机格式 -> 缓存 PNG 路径；非目标类型或失败返回空串。"""
    try:
        if not src or not os.path.isfile(src):
            return ""
        ext = os.path.splitext(src)[1].lower()
        if not force and ext not in VIDEO_EXTS and ext not in CAMERA_EXTS:
            return ""
        st = os.stat(src)
        key = "%s|%d|%d|%d" % (os.path.normcase(os.path.abspath(src)),
                               int(st.st_size), int(st.st_mtime), int(size))
        name = hashlib.sha1(key.encode("utf-8", "ignore")).hexdigest() + ".png"
        folder = os.path.join(data_dir(), "thumbs")
        os.makedirs(folder, exist_ok=True)
        out = os.path.join(folder, name)
        if os.path.isfile(out) and os.path.getsize(out) > 0:
            return out
        png = _shell_thumb_png(src, size)
        if not png:
            return ""
        tmp = out + ".tmp"
        with open(tmp, "wb") as f:
            f.write(png)
        os.replace(tmp, out)
        return out
    except Exception:
        return ""


def _engine_shots_thumb(params):
    """shots.thumb：按需生成视频/相机格式的预览图（默认 1280px）。"""
    path = _engine_get(params, "path", "", str)
    size = _engine_get(params, "size", 1280, int)
    if size not in (256, 512, 1280):
        size = 1280
    out = shot_thumb_png(path, size, force=True)
    return {"path": out or "", "exists": bool(out)}


def _engine_shots_scan(params):
    """shots.scan：列出超过保留天数的截图（只列，不删）。"""
    days = _engine_get(params, "days", S.get("shot_keep_days", 7), int)
    min_kb = _engine_get(params, "min_kb", S.get("shot_min_kb", 0), int)
    all_images = _engine_get(params, "all_images", S.get("shot_all_images", False), bool)
    if days < 0:
        raise EngineError("参数 days 不能是负数")
    if min_kb < 0:
        raise EngineError("参数 min_kb 不能是负数")
    dirs = _engine_path_list(params, "dirs", required=False)
    explicit = dirs is not None
    if dirs is None:
        dirs = [os.path.normpath(d) for d in
                (S.get("shot_dirs") or shot_dirs_default())]
    hits = find_screenshots(dirs, days, min_kb, progress=_engine_progress,
                            all_images=all_images)
    items = []
    for p, size, mtime in hits:
        parent = os.path.dirname(p)
        items.append({
            "path": p,
            "name": os.path.basename(p),
            "size": int(size),
            # 客户端按「Unix 秒」解析 mtime，这里必须给整数，不能给浮点
            "mtime": int(mtime),
            "group": os.path.basename(parent) or parent,
            # 是否“截图”：all_images 下用来把照片/视频和截图区分开，只有截图进默认清理
            "shot": bool(_is_shot_file(p)),
            # 视频与相机格式没有浏览器可解码的封面，走系统缩略图并缓存
            "thumb": (shot_thumb_png(p, 256)
                      if os.path.splitext(p)[1].lower() in (VIDEO_EXTS | CAMERA_EXTS)
                      else ""),
        })
    suggest = []
    if explicit:
        nd = [os.path.normcase(os.path.normpath(x)) for x in dirs]
        for d in shot_dirs_default():
            key = os.path.normcase(os.path.normpath(d))
            if not any(key == x or key.startswith(x + os.sep) for x in nd):
                suggest.append(d)
    return {
        "items": items,
        "total": len(items),
        "total_size": sum(i["size"] for i in items),
        "dirs": dirs,
        "all_images": all_images,
        "suggest": suggest,
        "missing": [d for d in dirs if not os.path.isdir(d)],
    }


def _engine_shots_clean(params):
    """shots.clean：预演或移入回收站；绝不永久删除。"""
    paths = _engine_path_list(params, "paths", required=True)
    confirm = _engine_get(params, "confirm", False, bool)
    all_images = _engine_get(params, "all_images", S.get("shot_all_images", False), bool)
    todo, failed, seen = [], [], set()
    for p in paths:
        key = os.path.normcase(p)
        if key in seen:
            continue
        seen.add(key)
        if not os.path.isfile(p):
            failed.append({"path": p, "why": "文件不存在"})
            continue
        if all_images:
            if os.path.splitext(p)[1].lower() not in SHOT_EXTS:
                failed.append({"path": p, "why": "不是图片/视频文件"})
                continue
        elif not _is_shot_file(p):
            failed.append({"path": p, "why": "不是截图文件（不在截图命名/目录规则内）"})
            continue
        todo.append(p)
    size = 0
    for p in todo:
        try:
            size += os.path.getsize(p)
        except OSError:
            pass
    if not confirm:
        return {"dry_run": True, "deleted": 0, "failed": failed,
                "moved_to_trash": True, "would_delete": len(todo),
                "would_free": size}
    ok, fail = trash_delete(todo)     # 复用 GUI 同一套「移到回收站」逻辑
    return {
        "dry_run": False,
        "deleted": len(ok),
        "failed": failed + [{"path": p, "why": why} for p, why in fail],
        "moved_to_trash": True,
        "freed": size,
    }


def _engine_cache_list(params):
    """cache.list：按现有缓存清单分组列出，带真实路径与单项体积。"""
    include_custom = _engine_get(params, "include_custom", True, bool)
    groups, total = _engine_cache_groups(include_custom)
    return {"groups": groups, "total_size": total}


def _engine_clean_auto(params):
    """clean.auto：按计划静默清理安全级缓存与过期截图（供 --auto-clean 调用）。"""
    confirm = _engine_get(params, "confirm", True, bool)
    do_cache = _engine_get(params, "cache", True, bool)
    do_shots = _engine_get(params, "screenshots", True, bool)
    days = _engine_get(params, "days", S.get("shot_keep_days", 30), int)
    out = {"cache": None, "shots": None}
    if do_cache:
        groups, _ = _engine_cache_groups(True)
        paths = []
        for g in groups:
            for it in g.get("items", []):
                lv = it.get("level")
                safe = (lv == 1) or (str(lv).lower() in ("safe", "1"))
                if not (safe and it.get("exists")):
                    continue
                for p in (it.get("paths") or ([it["path"]] if it.get("path") else [])):
                    if p:
                        paths.append(p)
        if paths:
            out["cache"] = _engine_cache_clean({"paths": paths, "confirm": confirm})
        else:
            out["cache"] = {"dry_run": not confirm, "cleaned": 0, "skipped": 0,
                            "failed": [], "freed": 0, "would_clean": 0, "would_free": 0}
    if do_shots:
        scan = _engine_shots_scan({"days": days, "min_kb": 0, "all_images": False})
        items = scan.get("items", [])
        paths = [it.get("path") for it in items if it.get("path")]
        if paths:
            out["shots"] = _engine_shots_clean({"paths": paths, "confirm": confirm})
        else:
            out["shots"] = {"deleted": 0, "failed": [], "moved_to_trash": True, "freed": 0}
    return out


def _engine_cache_clean(params):
    """cache.clean：预演或清理缓存目录内容（目录本身保留）。"""
    paths = _engine_path_list(params, "paths", required=True)
    confirm = _engine_get(params, "confirm", False, bool)
    prune_empty = _engine_get(params, "prune_empty", False, bool)
    todo, failed, seen = [], [], set()
    for p in paths:
        key = os.path.normcase(p)
        if key in seen:
            continue
        seen.add(key)
        bad, why = cache_path_forbidden(p)
        if bad:
            failed.append({"path": p, "why": "已拒绝：" + why})
            continue
        if is_drive_root(p):
            failed.append({"path": p, "why": "已拒绝：盘符根目录不能作为缓存目录"})
            continue
        if not os.path.exists(p):
            failed.append({"path": p, "why": "路径不存在"})
            continue
        todo.append(p)
    if not confirm:
        would = 0
        for p in todo:
            would += _tree_size(p)[0]
        return {"dry_run": True, "cleaned": 0, "skipped": 0, "failed": failed,
                "freed": 0, "would_clean": len(todo), "would_free": int(would)}
    if not todo:
        return {"dry_run": False, "cleaned": 0, "skipped": 0,
                "failed": failed, "freed": 0}
    skipped = []
    removed, fails, freed = clean_cache_paths(
        todo, progress=_engine_progress, rules=app_guard_rules(),
        skipped=skipped)
    for p, why in fails:
        failed.append({"path": p, "why": why})
    pruned = 0
    if prune_empty:
        for root in todo:
            for dp, dns, fns in os.walk(root, topdown=False):
                if os.path.normcase(dp) == os.path.normcase(root):
                    continue
                try:
                    if not os.listdir(dp):
                        os.rmdir(dp)
                        pruned += 1
                except OSError:
                    pass
    return {"dry_run": False, "cleaned": int(removed), "skipped": len(skipped),
            "failed": failed, "freed": int(freed), "pruned_dirs": pruned,
            "skipped_items": [{"path": p, "why": why} for p, why in skipped]}


# ── 应用图标：把 exe/dll 内嵌图标抽成 PNG 缓存 ────────────────────────
# 背景：exe/dll 直接交给 <img> 会让 WebView 资产协议把整个文件读出来再解码，
# 单个大程序就是几百 MB。这里只抽 48px 图标写 PNG，前端加载几 KB 的图。
_ICON_SRC_EXTS = (".exe", ".dll", ".cpl", ".scr", ".ocx")
_ICON_PX = 48
_ICON_API_READY = False


def _icon_api_init():
    """给 Win32 调用声明参数类型，64 位下句柄不会被截断。"""
    global _ICON_API_READY
    if _ICON_API_READY:
        return
    user32 = ctypes.windll.user32
    shell32 = ctypes.windll.shell32
    gdi32 = ctypes.windll.gdi32
    user32.PrivateExtractIconsW.argtypes = [
        ctypes.c_wchar_p, ctypes.c_int, ctypes.c_int, ctypes.c_int,
        ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p, ctypes.c_uint, ctypes.c_uint]
    user32.PrivateExtractIconsW.restype = ctypes.c_uint
    shell32.ExtractIconW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_uint]
    shell32.ExtractIconW.restype = ctypes.c_void_p
    user32.GetIconInfo.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    user32.GetIconInfo.restype = ctypes.c_int
    user32.GetDC.argtypes = [ctypes.c_void_p]
    user32.GetDC.restype = ctypes.c_void_p
    user32.ReleaseDC.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    user32.DestroyIcon.argtypes = [ctypes.c_void_p]
    gdi32.GetObjectW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p]
    gdi32.GetDIBits.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint,
                                ctypes.c_uint, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint]
    gdi32.DeleteObject.argtypes = [ctypes.c_void_p]
    _ICON_API_READY = True


def _png_chunk(tag, data):
    return (struct.pack(">I", len(data)) + tag + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))


def _rgba_to_png(w, h, rgba):
    raw = bytearray()
    stride = w * 4
    for y in range(h):
        raw.append(0)
        raw += rgba[y * stride:(y + 1) * stride]
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + _png_chunk(b"IHDR", ihdr)
            + _png_chunk(b"IDAT", zlib.compress(bytes(raw), 6))
            + _png_chunk(b"IEND", b""))


def _hicon_to_png(hicon):
    """HICON -> PNG 字节；失败返回 b""。"""
    try:
        _icon_api_init()
        user32 = ctypes.windll.user32
        gdi32 = ctypes.windll.gdi32

        class ICONINFO(ctypes.Structure):
            _fields_ = [("fIcon", ctypes.c_int), ("xHotspot", ctypes.c_uint),
                        ("yHotspot", ctypes.c_uint), ("hbmMask", ctypes.c_void_p),
                        ("hbmColor", ctypes.c_void_p)]

        class BITMAP(ctypes.Structure):
            _fields_ = [("bmType", ctypes.c_long), ("bmWidth", ctypes.c_long),
                        ("bmHeight", ctypes.c_long), ("bmWidthBytes", ctypes.c_long),
                        ("bmPlanes", ctypes.c_ushort), ("bmBitsPixel", ctypes.c_ushort),
                        ("bmBits", ctypes.c_void_p)]

        class BIH(ctypes.Structure):
            _fields_ = [("biSize", ctypes.c_uint), ("biWidth", ctypes.c_long),
                        ("biHeight", ctypes.c_long), ("biPlanes", ctypes.c_ushort),
                        ("biBitCount", ctypes.c_ushort), ("biCompression", ctypes.c_uint),
                        ("biSizeImage", ctypes.c_uint), ("biXPelsPerMeter", ctypes.c_long),
                        ("biYPelsPerMeter", ctypes.c_long), ("biClrUsed", ctypes.c_uint),
                        ("biClrImportant", ctypes.c_uint)]

        ii = ICONINFO()
        if not user32.GetIconInfo(hicon, ctypes.byref(ii)):
            return b""
        try:
            bm = BITMAP()
            gdi32.GetObjectW(ii.hbmColor, ctypes.sizeof(bm), ctypes.byref(bm))
            w, h = int(bm.bmWidth), int(bm.bmHeight)
            if w <= 0 or h <= 0:
                return b""
            bi = BIH()
            bi.biSize = ctypes.sizeof(BIH)
            bi.biWidth = w
            bi.biHeight = -h          # 负数 = 自上而下，省得再翻转
            bi.biPlanes = 1
            bi.biBitCount = 32
            buf = ctypes.create_string_buffer(w * h * 4)
            hdc = user32.GetDC(None)
            try:
                ok = gdi32.GetDIBits(hdc, ii.hbmColor, 0, h, buf, ctypes.byref(bi), 0)
            finally:
                user32.ReleaseDC(None, hdc)
            if not ok:
                return b""
            bgra = buf.raw
            rgba = bytearray(len(bgra))
            rgba[0::4] = bgra[2::4]
            rgba[1::4] = bgra[1::4]
            rgba[2::4] = bgra[0::4]
            rgba[3::4] = bgra[3::4]
            if not any(rgba[3::4]):   # 没有 alpha 通道就按不透明处理
                rgba[3::4] = b"\xff" * (w * h)
            return _rgba_to_png(w, h, bytes(rgba))
        finally:
            if ii.hbmColor:
                gdi32.DeleteObject(ii.hbmColor)
            if ii.hbmMask:
                gdi32.DeleteObject(ii.hbmMask)
    except Exception:
        return b""


def _extract_icon_png(path, size=_ICON_PX):
    try:
        _icon_api_init()
        user32 = ctypes.windll.user32
        shell32 = ctypes.windll.shell32
        hicon = ctypes.c_void_p()
        got = user32.PrivateExtractIconsW(path, 0, size, size,
                                          ctypes.byref(hicon), None, 1, 0)
        if got and hicon.value:
            try:
                return _hicon_to_png(hicon)
            finally:
                user32.DestroyIcon(hicon)
        h = shell32.ExtractIconW(None, path, 0)
        if h and h != 1:
            try:
                return _hicon_to_png(h)
            finally:
                user32.DestroyIcon(h)
    except Exception:
        return b""
    return b""


def _icon_cache_path(src, size=_ICON_PX):
    """(缓存文件, src 是否值得取图标)；只算路径，不碰磁盘内容。"""
    if not src:
        return "", False
    if os.path.splitext(src)[1].lower() not in _ICON_SRC_EXTS:
        return "", False
    try:
        st = os.stat(src)
    except OSError:
        return "", False
    key = "%s|%d|%d|%d" % (os.path.normcase(os.path.abspath(src)),
                           st.st_size, int(st.st_mtime), size)
    digest = hashlib.sha1(key.encode("utf-8", "ignore")).hexdigest()
    return os.path.join(data_dir(), "icons", digest + ".png"), True


def app_icon_cached(src, size=_ICON_PX):
    """只返回已经取过的图标；没有就返回空串。列表页用它保速度。"""
    out, ok = _icon_cache_path(src, size)
    if not ok:
        return ""
    try:
        if os.path.isfile(out) and os.path.getsize(out) > 0:
            return out
    except OSError:
        pass
    return ""


def app_icon_png(src, size=_ICON_PX):
    """exe/dll 图标 -> 缓存 PNG 路径；失败或非目标类型返回空串。"""
    try:
        out, ok = _icon_cache_path(src, size)
        if not ok:
            return ""
        if os.path.isfile(out) and os.path.getsize(out) > 0:
            return out
        out_dir = os.path.dirname(out)
        png = _extract_icon_png(src, size)
        if not png:
            return ""
        os.makedirs(out_dir, exist_ok=True)
        tmp = out + ".tmp"
        with open(tmp, "wb") as f:
            f.write(png)
        os.replace(tmp, out)
        return out
    except Exception:
        return ""


def _engine_apps_list(params):
    """apps.list：复用注册表枚举，返回已安装程序。

    这里只读「已经取过的图标」，不现场提取：首次加载 190+ 个程序时逐个抠图标
    会把引擎的 RPC 串行队列堵住十几秒，界面就一直转圈。缺图标的行由
    前端按页调 apps.icons 补齐（那一步才真的抽图标）。
    """
    _engine_get(params, "refresh", False, bool)   # 目前不缓存，保留该参数位
    apps = list_installed_apps(progress=_engine_progress)
    items = []
    for a in apps:
        _src_icon = a.get("icon") or ""
        _png_icon = app_icon_cached(_src_icon) if _src_icon else ""
        items.append({
            "name": a.get("name") or "",
            "version": a.get("version") or "",
            "publisher": a.get("publisher") or "",
            "install_path": a.get("location") or "",
            "icon": _png_icon,
            "icon_src": _src_icon,
            "uninstall": bool(a.get("uninstall")),
            # 以下字段供「完整右键菜单」使用：卸载命令、注册表位置、官网、占用
            "uninstall_cmd": a.get("uninstall") or "",
            "quiet_cmd": a.get("quiet") or "",
            "hive": a.get("hive") or "",
            "key": a.get("key") or "",
            "url": a.get("url") or "",
            "size_kb": int(a.get("size_kb") or 0),
        })
    return {"items": items, "total": len(items)}


def _engine_apps_icons(params):
    """apps.icons：按批提取图标，返回 {源路径: PNG 路径}。

    一次最多 60 个，避免单条 RPC 占住引擎太久；取过的会走磁盘缓存。
    """
    srcs = params.get("sources")
    if not isinstance(srcs, list) or not srcs:
        raise EngineError("参数 sources 必须是非空数组")
    if len(srcs) > 60:
        raise EngineError("参数 sources 一次最多 60 个")
    icons = {}
    for s in srcs:
        if not isinstance(s, str) or not s.strip():
            continue
        png = app_icon_png(s.strip())
        if png:
            icons[s.strip()] = png
    return {"icons": icons}


_ENGINE_HIVES = ("HKCU", "HKLM64", "HKLM32")


def _engine_find_app(params):
    """按 name（+ 可选 version）精确匹配已安装程序；匹配不到就报可读错误。

    version 为空 = 不比版本（同名多条时取枚举到的第一条）。
    """
    name = params.get("name")
    if not isinstance(name, str) or not name.strip():
        raise EngineError("参数 name 必须是非空字符串")
    name = name.strip()
    version = params.get("version")
    if version is not None and not isinstance(version, str):
        raise EngineError("参数 version 必须是字符串")
    version = (version or "").strip()
    for app in list_installed_apps(progress=_engine_progress):
        if (app.get("name") or "").strip() != name:
            continue
        if version and (app.get("version") or "").strip() != version:
            continue
        return app
    raise EngineError("找不到程序：%s" % name)


def _engine_uninstall_command(app, mode="auto"):
    """卸载命令：auto 交互优先（能看到卸载器），quiet 静默优先。"""
    quiet = (app.get("quiet") or "").strip()
    plain = (app.get("uninstall") or "").strip()
    if mode == "quiet":
        return quiet or plain
    return plain or quiet


def _spawn_detached(cmd):
    """把一条完整命令行交给系统执行，不阻塞、不弹控制台、不污染 RPC 流。

    做法：先把命令行解析成 argv（shlex），再用 shell=False 启动。
    这样既不会像旧实现那样「整串当成 exe 路径」导致点了没反应，
    也不会把参数交给 shell 解释（去掉注入面）。
    只有解析不出可执行文件、或需要提权（WinError 740）时，
    才退回 ShellExecute 的 runas 动词弹 UAC。
    """
    import shlex
    import shutil

    cmd = (cmd or "").strip()
    if not cmd:
        raise EngineError("卸载命令为空")

    try:
        argv = [a.strip('"') for a in shlex.split(cmd, posix=False)]
    except ValueError:
        argv = []
    argv = [a for a in argv if a != ""]

    flags = (getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
             | getattr(subprocess, "DETACHED_PROCESS", 0)
             | getattr(subprocess, "CREATE_NO_WINDOW", 0))

    exe = argv[0] if argv else ""
    resolved = ""
    if exe:
        if os.path.isabs(exe) and os.path.exists(exe):
            resolved = exe
        else:
            resolved = shutil.which(exe) or ""

    # 解析出了真实可执行文件：直接 CreateProcess，参数原样传，不经 shell
    if resolved:
        try:
            subprocess.Popen([resolved] + argv[1:], shell=False, creationflags=flags,
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL)
            return True
        except Exception as ex:
            if getattr(ex, "winerror", None) != 740:
                raise EngineError("卸载器启动失败：%s" % ex)

    # 需要提权或解析不出 exe：交给 shell 的 runas 动词（会弹 UAC）
    try:
        import ctypes
        rc = ctypes.windll.shell32.ShellExecuteW(None, "runas", "cmd.exe",
                                                 "/c " + cmd, None, 1)
        if int(rc) > 32:
            return True
        if int(rc) == 5:
            raise EngineError("需要管理员权限，UAC 提权被取消")
        raise EngineError("卸载器启动失败（ShellExecute 返回 %s）" % rc)
    except EngineError:
        raise
    except Exception as ex:
        raise EngineError("卸载器启动失败：%s" % ex)
def _engine_apps_uninstall(params):
    """apps.uninstall：启动程序自带卸载器，不等它结束；confirm=false 只回计划。"""
    app = _engine_find_app(params)
    confirm = _engine_get(params, "confirm", True, bool)
    mode = _engine_get(params, "mode", "auto", str)
    if mode not in ("auto", "interactive", "quiet"):
        mode = "auto"
    cmd = _engine_uninstall_command(app, mode)
    if not cmd:
        raise EngineError("这个程序没有自带卸载器")
    name = app.get("name") or ""
    if not confirm:
        return {"dry_run": True, "name": name, "command": cmd, "mode": mode}
    started = _spawn_detached(cmd)
    return {"name": name, "command": cmd, "mode": mode,
            "started": bool(started)}


# ---------- 完整右键菜单需要的能力：注册表条目 / 删除条目 / 强制删除 ----------

def _reg_hive(name):
    import winreg
    return {"HKLM64": (winreg.HKEY_LOCAL_MACHINE, winreg.KEY_WOW64_64KEY),
            "HKLM32": (winreg.HKEY_LOCAL_MACHINE, winreg.KEY_WOW64_32KEY),
            "HKCU": (winreg.HKEY_CURRENT_USER, 0)}[name]


def _open_reg(hive_name, sub, write=False):
    import winreg
    hive, flag = _reg_hive(hive_name)
    access = (winreg.KEY_READ | flag)
    if write:
        access = (winreg.KEY_READ | winreg.KEY_WRITE | flag)
    return winreg.OpenKey(hive, sub, 0, access)


def _reg_delete_tree(hive_name, sub):
    """递归删除注册表键（先删子键再删自己），返回删除的键数。"""
    import winreg
    hive, flag = _reg_hive(hive_name)
    removed = 0
    try:
        with winreg.OpenKey(hive, sub, 0, winreg.KEY_READ | flag) as k:
            subs = []
            i = 0
            while True:
                try:
                    subs.append(winreg.EnumKey(k, i))
                except OSError:
                    break
                i += 1
    except OSError:
        return 0
    for child in subs:
        removed += _reg_delete_tree(hive_name, sub + "\\" + child)
    try:
        parent, leaf = sub.rsplit("\\", 1)
        with winreg.OpenKey(hive, parent, 0, winreg.KEY_ALL_ACCESS | flag) as p:
            winreg.DeleteKey(p, leaf)
        removed += 1
    except OSError:
        pass
    return removed


def _engine_apps_registry(params):
    """apps.registry：列出一个程序卸载项下的全部注册表值。"""
    app = _engine_find_app(params)
    hive = app.get("hive") or ""
    key = app.get("key") or ""
    if not hive or not key:
        raise EngineError("这个程序没有可读的注册表卸载项")
    vals = []
    try:
        import winreg
        with _open_reg(hive, key) as k:
            i = 0
            while True:
                try:
                    name, data, typ = winreg.EnumValue(k, i)
                except OSError:
                    break
                i += 1
                if isinstance(data, bytes):
                    try:
                        data = data.decode("utf-16-le", "ignore").strip("\x00")
                    except Exception:
                        data = repr(data)
                vals.append({"name": name or "(默认)", "type": int(typ),
                             "value": str(data)})
    except OSError as ex:
        raise EngineError("读取注册表失败：%s" % ex)
    return {"name": app.get("name") or "", "hive": hive, "key": key,
            "values": vals}


def _engine_apps_delete_entry(params):
    """apps.delete_entry：只删注册表卸载项（程序文件不动）。"""
    app = _engine_find_app(params)
    confirm = _engine_get(params, "confirm", True, bool)
    hive = app.get("hive") or ""
    key = app.get("key") or ""
    if not confirm:
        return {"dry_run": True, "name": app.get("name") or "",
                "hive": hive, "key": key}
    removed = _reg_delete_tree(hive, key)
    if not removed:
        raise EngineError("删除注册表项失败（可能需要管理员权限）")
    return {"name": app.get("name") or "", "hive": hive, "key": key,
            "removed_keys": removed}


def _engine_apps_force_remove(params):
    """apps.force_remove：删安装目录 + 注册表卸载项（「强制删除」）。"""
    import shutil
    app = _engine_find_app(params)
    confirm = _engine_get(params, "confirm", True, bool)
    name = app.get("name") or ""
    dirs = []
    loc = (app.get("location") or "").strip()
    if loc:
        dirs.append(os.path.normpath(loc))
    for d in (params.get("dirs") or []):
        if isinstance(d, str) and d.strip():
            p = os.path.normpath(d.strip())
            if p not in dirs:
                dirs.append(p)
    if not dirs and not app.get("key"):
        raise EngineError("没有可删除的安装目录或注册表项")
    if not confirm:
        return {"dry_run": True, "name": name, "dirs": dirs,
                "hive": app.get("hive") or "", "key": app.get("key") or ""}
    failed = []
    for d in dirs:
        # 安全闸：盘符根目录、系统目录、用户主目录一律不动
        low = d.lower().rstrip("\\")
        if (len(low) <= 3 or low in (os.environ.get("SystemRoot", "").lower(),
                                     os.environ.get("USERPROFILE", "").lower())):
            failed.append({"path": d, "why": "受保护路径"})
            continue
        if not os.path.exists(d):
            continue
        try:
            shutil.rmtree(d)
        except Exception as ex:
            failed.append({"path": d, "why": str(ex)})
    removed_keys = _reg_delete_tree(app.get("hive") or "", app.get("key") or "") \
        if app.get("key") else 0
    return {"name": name, "dirs": dirs, "failed": failed,
            "removed_keys": removed_keys}



def _engine_app_leftovers(app):
    """跑一次 scan_leftovers，把异常翻成可读错误；返回 (dirs, regs)。"""
    try:
        dirs, regs = scan_leftovers(app)
    except Exception as ex:
        raise EngineError("扫描残留失败：%s"
                          % (str(ex) or ex.__class__.__name__))
    return ([str(d) for d in dirs],
            [(str(h), str(k)) for h, k in regs])


def _engine_apps_leftovers(params):
    """apps.leftovers：只列出残留目录与注册表键，不删任何东西。"""
    app = _engine_find_app(params)
    dirs, regs = _engine_app_leftovers(app)
    return {"name": app.get("name") or "", "dirs": dirs,
            "regs": [{"hive": h, "key": k} for h, k in regs],
            "blocked": []}


def _engine_cleanup_dirs(params, fallback):
    """清理计划里的目录：显式给了就规范化去重，没给就用扫描结果。"""
    if params.get("dirs") is None:
        return list(fallback)
    raw = params.get("dirs")
    if not isinstance(raw, list):
        raise EngineError("参数 dirs 必须是字符串数组")
    out, seen = [], set()
    for item in raw:
        if not isinstance(item, str) or not item.strip():
            raise EngineError("参数 dirs 里的每一项都必须是非空字符串")
        p = os.path.normpath(os.path.abspath(os.path.expandvars(
            os.path.expanduser(item.strip()))))
        mark = os.path.normcase(p)
        if mark in seen:
            continue
        seen.add(mark)
        out.append(p)
    return out


def _engine_cleanup_regs(params, fallback):
    """清理计划里的注册表项：接受 {hive,key} 或 "HIVE\\键路径" 两种写法。"""
    if params.get("regs") is None:
        return list(fallback)
    raw = params.get("regs")
    if not isinstance(raw, list):
        raise EngineError("参数 regs 必须是数组")
    out, seen = [], set()
    for item in raw:
        if isinstance(item, dict):
            hive = item.get("hive")
            key = item.get("key")
            if not isinstance(hive, str) or not isinstance(key, str):
                raise EngineError("参数 regs 里的每一项都要有 hive 与 key")
        elif isinstance(item, str):
            hive, _sep, key = item.strip().partition("\\")
        else:
            raise EngineError("参数 regs 里的每一项必须是对象或字符串")
        hive = hive.strip().upper()
        key = key.strip().strip("\\")
        if hive not in _ENGINE_HIVES:
            raise EngineError(
                "参数 regs 里的注册表分支只能是 HKCU / HKLM64 / HKLM32")
        if not key:
            raise EngineError("参数 regs 里的注册表键路径不能为空")
        mark = (hive, os.path.normcase(key))
        if mark in seen:
            continue
        seen.add(mark)
        out.append((hive, key))
    return out


def _engine_backup_root(name):
    """<数据目录>\\卸载备份\\<程序名>_<时间戳>[_2]：程序名里的非法字符先去掉。

    时间戳只到秒，同一秒里连清两次同名程序会撞车；撞上就往后顺延编号，
    绝不覆盖上一次的备份（备份被覆盖等于把回滚的唯一凭据丢了）。
    """
    safe = re.sub(r'[\\/:*?"<>|]', "", name).strip() or "程序"
    base = os.path.join(backup_dir(),
                        "%s_%s" % (safe, time.strftime("%Y%m%d_%H%M%S")))
    out, n = base, 1
    while os.path.exists(out):
        n += 1
        out = "%s_%d" % (base, n)
    return out


def _engine_dir_reject_why(p):
    """给 _safe_dir 的 False 补一句人能看懂的原因（判定与 _safe_dir 一致）。"""
    try:
        ap = os.path.abspath(p)
    except Exception:
        return "已拒绝：路径不合法"
    drive, tail = os.path.splitdrive(ap)
    if not tail.strip("\\"):
        return "已拒绝：%s\\ 是盘符根目录，不能删" % drive
    parts = [x for x in ap.split("\\") if x]
    if len(ap) < 10:
        return "已拒绝：路径太短（%s），疑似系统目录，不能删" % ap
    if len(parts) <= 2:
        return "已拒绝：这是分区顶层目录，不能删"
    if parts[-1].lower() in SAFE_ROOT_DENY:
        return "已拒绝：%s 是系统关键目录，不能删" % parts[-1]
    return "已拒绝：这个目录不在允许删除的范围"


def _engine_apps_cleanup(params):
    """apps.cleanup：先导出注册表备份，再删目录、再删键；每步都重新过安全规则。

    confirm=false 只回计划（零副作用）；confirm=true 才动盘/动注册表，
    被安全规则拒绝或导出失败的项一律进 failed，绝不静默跳过。
    """
    app = _engine_find_app(params)
    confirm = _engine_get(params, "confirm", False, bool)
    scan_dirs, scan_regs = [], []
    if params.get("dirs") is None or params.get("regs") is None:
        scan_dirs, scan_regs = _engine_app_leftovers(app)
    dirs = _engine_cleanup_dirs(params, scan_dirs)
    regs = _engine_cleanup_regs(params, scan_regs)
    name = app.get("name") or ""
    backup = _engine_backup_root(name)
    if not confirm:
        return {"dry_run": True, "name": name, "dirs": dirs,
                "regs": [{"hive": h, "key": k} for h, k in regs],
                "backup_dir": backup}

    removed_dirs, removed_regs, failed = [], [], []
    # a. 注册表先留备份。键先过一遍安全规则：不该删的连导出都不做
    #    （导出 HKCU\SOFTWARE\Microsoft\Windows 这种键又慢又没意义）。
    rejected = set()
    for hive, key in regs:
        if not _safe_reg_key(hive, key):
            rejected.add((hive, key))
            failed.append({"target": "%s\\%s" % (hive, key),
                           "why": "已拒绝：这个注册表键不在允许删除的范围"})
    todo_regs = [(h, k) for h, k in regs if (h, k) not in rejected]
    export_ok = {}
    if todo_regs:
        try:
            os.makedirs(backup, exist_ok=True)
        except OSError as ex:
            failed.append({"target": backup,
                           "why": "建不了备份目录：%s" % ex})
        for i, (hive, key) in enumerate(todo_regs, 1):
            out = os.path.join(backup, "%d.reg" % i)
            export_ok[(hive, key)] = bool(export_reg_key(hive, key, out))
            if not export_ok[(hive, key)]:
                # 没有备份就不删：宁可这个键留着，也不做不可回滚的删除
                failed.append({"target": "%s\\%s" % (hive, key),
                               "why": "注册表导出失败，已跳过不删"})
    # b. 删目录：逐项重新校验 _safe_dir
    for p in dirs:
        if not _safe_dir(p):
            failed.append({"target": p, "why": _engine_dir_reject_why(p)})
            continue
        if not os.path.isdir(p):
            failed.append({"target": p, "why": "目录不存在"})
            continue
        try:
            shutil.rmtree(p, ignore_errors=False)
        except OSError as ex:
            failed.append({"target": p, "why": "删除失败：%s" % ex})
            continue
        removed_dirs.append(p)
    # c. 删注册表：删除前再校验一次，HKCU/HKLM64/HKLM32 各用自己的根键与 flag
    for hive, key in regs:
        if (hive, key) in rejected or not export_ok.get((hive, key)):
            continue                     # 已记过 failed，不再动
        target = "%s\\%s" % (hive, key)
        if not _safe_reg_key(hive, key):
            failed.append({"target": target,
                           "why": "已拒绝：这个注册表键不在允许删除的范围"})
            continue
        why = _delete_reg_tree(_hive_root(hive), key, _flag(hive))
        if why:
            failed.append({"target": target, "why": why})
        else:
            removed_regs.append({"hive": hive, "key": key})
    return {"dry_run": False, "name": name, "backup_dir": backup,
            "removed_dirs": removed_dirs, "removed_regs": removed_regs,
            "failed": failed}


def _engine_index_meta_path():
    return os.path.join(cache_dir(), "fileindex.json")


def _engine_index_meta():
    try:
        with open(_engine_index_meta_path(), encoding="utf-8-sig") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _engine_paths_same(a, b):
    def key(xs):
        return sorted(os.path.normcase(os.path.normpath(str(x)))
                      for x in (xs or []) if isinstance(x, str) and x.strip())
    return key(a) == key(b)


def _engine_search_selfcheck(params):
    """search.selfcheck：抽查索引，判定过期的就重建，返回报告。

    给设置页的「立即校验」按钮用，也给启动时那一拍用。不传 rebuild 时默认
    真的重建——用户点这个按钮就是想让它修好，不是想看一份报告。
    """
    rebuild = params.get("rebuild", True)
    if not isinstance(rebuild, bool):
        rebuild = True
    rep = index_selfcheck(rebuild=rebuild, progress=_engine_progress)
    rep["rebuild"] = rebuild
    rep.update(index_age())
    ok, used, cap = index_quota_ok()
    rep["quota"] = {"ok": ok, "used_bytes": used, "cap_bytes": cap}
    rep["freshness"] = _freshness_mode()
    return rep


def _engine_search_hot(params):
    """search.hot：立刻给热目录保鲜一次，返回扫了哪些根、多少文件、多久。

    给设置页的「立即刷新」按钮用。平时不需要点 —— 后台线程每 60 秒做一次，
    搜索没命中时也会顺手补一次。留这个入口是为了「用户就是想确认一下」的
    时候有个东西可按，而不是只能等。
    """
    rep = hot_refresh(force=True)
    out = dict(rep)
    out.update(index_age())
    return out


def _engine_search_status(params):
    """search.status：所有索引的清单、体积、覆盖与合计。"""
    st = index_stats()
    entries = []
    covered = []
    for it in st.get("entries") or []:
        files = int(it.get("files") or 0)
        dirs = int(it.get("dirs") or 0)
        ms = int(it.get("ms") or 0)
        why = str(it.get("why") or "")
        exists = bool(it.get("exists"))
        entries.append({
            "id": it.get("id") or "",
            "root": it.get("root") or "",
            "path": it.get("path") or "",
            "files": files,
            "dirs": dirs,
            "size_bytes": int(it.get("size_bytes") or 0),
            "built_at": int(it.get("built_at") or 0),
            "ms": ms,
            "walker": it.get("walker") or "",
            "why": why,
            "exists": exists,
            "exists_root": bool(it.get("exists_root")),
        })
        covered.append({
            "root": it.get("root") or "",
            "files": files,
            "dirs": dirs,
            "ms": ms,
            # 库在、根目录还在、建库没报错，才算「已覆盖」
            "ok": bool(exists and it.get("exists_root") and not why),
            "why": why,
            "exists": bool(it.get("exists_root")),
        })
    return {
        "index_dir": st.get("dir") or index_dir(),
        "entries": entries,
        "count": len(entries),
        "indexed": int(st.get("files") or 0),
        "files": int(st.get("files") or 0),
        "dirs": int(st.get("dirs") or 0),
        "size_bytes": int(st.get("size_bytes") or 0),
        "built_at": int(st.get("built_at") or 0),
        "schema": INDEX_SCHEMA,
        "walker": st.get("walker") or "",
        "elapsed_ms": int(st.get("elapsed_ms") or 0),
        "roots": [e["root"] for e in entries],
        "covered": covered,
        "backend": "Everything" if find_es() else "本地索引",
    }


def _engine_search_add(params):
    """search.add：把目录加进索引清单（只登记，不建库）。"""
    roots = params.get("roots")
    if isinstance(roots, str):
        roots = [roots]
    if not isinstance(roots, list) or not roots:
        raise EngineError("参数 roots 必须是非空数组")
    clean = [str(r) for r in roots if isinstance(r, str) and r.strip()]
    if not clean:
        raise EngineError("参数 roots 里没有有效路径")
    items = index_add(clean)
    return {"count": len(items), "roots": [i["root"] for i in items],
            "added": len([r for r in clean if os.path.isdir(r)])}


def _engine_search_remove(params):
    """search.remove：删索引（库文件 + 清单条目），不动源目录里的任何文件。"""
    ids = params.get("ids")
    if isinstance(ids, str):
        ids = [ids]
    if not isinstance(ids, list) or not ids:
        raise EngineError("参数 ids 必须是非空数组")
    gone = index_remove([str(i) for i in ids])
    st = index_stats()
    return {"removed": gone, "count": int(st.get("count") or 0),
            "indexed": int(st.get("files") or 0)}


def _uniq_failed(items):
    """失败清单按路径去重：同一个目录可能既在 roots 里缺失、又被清单判缺失。"""
    out, seen = [], set()
    for it in items:
        key = os.path.normcase(str(it.get("path") or ""))
        if key in seen:
            continue
        seen.add(key)
        out.append(it)
    return out


def _engine_search_index(params):
    """search.index：建立/重建索引。

    ids 指定就只重建这几条；roots 指定就先把目录登记进清单再重建；都不给就全部重建。
    """
    roots = params.get("roots")
    if isinstance(roots, str):
        roots = [roots]
    roots = [str(r) for r in roots] if isinstance(roots, list) else []
    ids = [str(i) for i in params.get("ids")] if isinstance(params.get("ids"), list) else []
    reuse = _engine_get(params, "reuse", True, bool)
    full = _engine_get(params, "full", False, bool)
    t0 = time.perf_counter()

    items = _ix_load()
    if roots:
        items = index_add(roots)
        want = set(_ix_make_id(os.path.abspath(r)) for r in roots)
    elif ids:
        want = set(ids)
    else:
        want = set(i["id"] for i in items)

    failed = [{"path": r, "why": "目录不存在"} for r in roots if not os.path.isdir(r)]
    targets = []
    for it in items:
        if it["id"] not in want:
            continue
        if os.path.isdir(it["root"]):
            targets.append(it)
        else:
            failed.append({"path": it["root"], "why": "目录不存在"})

    if not items:
        return {"indexed": 0, "reused": False, "entries": 0,
                "elapsed_ms": int((time.perf_counter() - t0) * 1000),
                "failed": _uniq_failed(failed), "error": "还没有添加索引目录"}
    if not targets:
        return {"indexed": int(index_count()), "reused": False, "entries": 0,
                "elapsed_ms": int((time.perf_counter() - t0) * 1000),
                "failed": _uniq_failed(failed), "error": "选中的目录都不存在，没有重建索引"}

    # 库都在、都有条数、又不是强制全量，就别白跑一遍
    if reuse and not full and all(
            os.path.isfile(_ix_db_abspath(i)) and int(i.get("files") or 0) > 0
            for i in targets):
        return {"indexed": int(index_count()), "reused": True,
                "entries": len(targets), "elapsed_ms": 0, "failed": _uniq_failed(failed),
                "walker": "", "index_dir": index_dir()}

    n, errs = build_index(ids=[i["id"] for i in targets], progress=_engine_progress)
    failed.extend({"path": str(p), "why": why} for p, why in errs)
    st = index_stats()
    run = dict(_index_last_run)
    return {"indexed": int(st.get("files") or 0), "built": int(n),
            "entries": len(targets), "reused": False, "failed": _uniq_failed(failed),
            "elapsed_ms": int((time.perf_counter() - t0) * 1000),
            "walker": run.get("walker", ""), "index_dir": index_dir(),
            "dirs": int(st.get("dirs") or 0)}


def _engine_search_query(params):
    """search.query：优先 Everything（es.exe），否则并发查本地索引再合并。"""
    q = params.get("q")
    if not isinstance(q, str) or not q.strip():
        raise EngineError("参数 q 必须是非空字符串")
    q = q.strip()
    limit = _engine_get(params, "limit", 200, int)
    if limit <= 0:
        raise EngineError("参数 limit 必须是正整数")
    limit = min(limit, 5000)
    ids = params.get("ids")
    ids = [str(i) for i in ids] if isinstance(ids, list) and ids else None
    t0 = time.perf_counter()
    rows = es_search(q, limit)
    source = "es"
    if rows is None:                  # 没有 es.exe 或调用失败 → 退回本地索引
        source = "index"
        rows = search_index(q, limit, ids=ids)
        # 一条都没搜到，而用户又刚下载了东西 —— 这几乎一定是索引还没跟上，
        # 不是「本机没有这个文件」。热目录重扫一次只要 300 毫秒，直接补上再查
        # 一遍，比让用户看着空结果自己猜「是不是要重建索引」好得多。
        # 只查一次，不循环；重扫后仍然没有，那就是真的没有。
        if not rows and _hot_maybe_stale():
            _INDEX_WATCH["miss"] = time.time()
            hot_refresh()
            rows = search_index(q, limit, ids=ids)
            if rows:
                source = "index"
    items = [{"name": name or os.path.basename(path), "path": path,
              "size": int(size or 0), "mtime": int(mtime or 0)}
             for path, name, size, mtime in rows]
    result = {"items": items, "total": len(items), "source": source,
              "elapsed_ms": int((time.perf_counter() - t0) * 1000)}
    if source == "index" and not items and index_count() == 0:
        result["hint"] = "本地还没有索引，可以先添加目录并建立一次"
    return result


def _engine_search_top(params):
    """search.top：按体积取前 N 个文件，直接查索引，不遍历磁盘。

    和 top_files 的区别：top_files 是「现扫一个目录」，扫不完就只能给部分结果；
    这里读的是索引里已经记下的 size 列，毫秒级、覆盖所有已索引的根目录。
    索引没建的时候给一条明确的 hint，别让模型以为「本机没有大文件」。
    """
    limit = _engine_get(params, "limit", 50, int)
    if limit <= 0:
        raise EngineError("参数 limit 必须是正整数")
    limit = min(limit, 2000)
    min_size = _engine_get(params, "min_size", 0, int)
    ids = params.get("ids")
    ids = [str(i) for i in ids] if isinstance(ids, list) and ids else None
    t0 = time.perf_counter()
    rows = search_index_top(limit, ids=ids, min_size=min_size)
    items = [{"name": name or os.path.basename(path), "path": path,
              "size": int(size or 0), "mtime": int(mtime or 0)}
             for path, name, size, mtime in rows]
    st = index_stats()
    roots = [e.get("root") for e in st.get("entries") or [] if e.get("exists_root")]
    result = {"items": items, "total": len(items), "source": "index",
              "roots": roots, "indexed": int(st.get("files") or 0),
              "elapsed_ms": int((time.perf_counter() - t0) * 1000)}
    result.update(index_age())
    if not roots:
        result["hint"] = "本地还没有索引：先在「搜索」页添加目录并建立一次，之后这里就能直接按体积排"
    return result

# ── --engine：设置写入 / 规则 / 迁移 相关方法 ─────────────────────────
#
# 同样只做「参数校验 + 复用既有业务函数 + 转结构」，写盘/删除/搬移的规则
# 全部留在 save_settings / run_rules / migrate_engine 里。

_ENGINE_SETTINGS_TYPES = {
    "data_dir": str,
    "cache_dir": str,
    "everything_path": str,
    "conflict_policy": str,
    "close_action": str,
    "tray_pin": str,
    "shot_time": str,
    "cache_time": str,
    "default_recursive": bool,
    "default_content": bool,
    "shot_auto": bool,
    "shot_to_trash": bool,
    "cache_auto": bool,
    "cache_to_trash": bool,
    "tray_enabled": bool,
    "close_to_tray": bool,
    "recursive_depth": int,
    "log_keep_days": int,
    "shot_keep_days": int,
    "shot_min_kb": int,
    "index_roots": list,
    "shot_dirs": list,
    "cache_custom_dirs": list,
    "index_freshness": str,
    "index_max_mb": int,
    "index_rebuild_idle": bool,
}
_ENGINE_SETTINGS_CHOICES = {
    "conflict_policy": ("rename", "skip", "overwrite"),
    "close_action": ("tray", "exit", "ask"),
    "tray_pin": ("taskbar", "overflow", "system"),
    "index_freshness": ("live", "check", "manual"),
}
_ENGINE_SETTINGS_RANGES = {
    "recursive_depth": (1, 4),
    "log_keep_days": (1, 3650),
    "shot_keep_days": (0, 36500),
    "shot_min_kb": (0, 10 * 1024 * 1024),
    # 0 表示不限制（index_quota_ok 里就是这么判的），所以下界是 0 而不是 1
    "index_max_mb": (0, 65536),
}


def _engine_time_text(value):
    """shot_time / cache_time 只接受 HH:MM（计划任务按这个字符串跑）。"""
    return bool(re.match(r"^([01]?\d|2[0-3]):[0-5]\d$", value))


def _engine_settings_value(key, value):
    """校验并规范化 settings.set 的 value。"""
    want = _ENGINE_SETTINGS_TYPES[key]
    if want is bool:
        if not isinstance(value, bool):
            raise EngineError("参数 value 必须是布尔值（true / false）")
        return value
    if want is int:
        if isinstance(value, bool) or not isinstance(value, int):
            raise EngineError("参数 value 必须是整数")
        lo, hi = _ENGINE_SETTINGS_RANGES.get(key, (None, None))
        if lo is not None and not (lo <= value <= hi):
            raise EngineError("参数 value 超出范围：%s 只能是 %d–%d"
                              % (key, lo, hi))
        return value
    if want is list:
        if not isinstance(value, list):
            raise EngineError("参数 value 必须是字符串数组")
        out, seen = [], set()
        for item in value:
            if not isinstance(item, str) or not item.strip():
                raise EngineError("参数 value 里的每一项都必须是非空字符串")
            p = os.path.normpath(os.path.abspath(os.path.expandvars(
                os.path.expanduser(item.strip()))))
            mark = os.path.normcase(p)
            if mark in seen:
                continue
            seen.add(mark)
            out.append(p)
        return out
    # 字符串项
    if not isinstance(value, str):
        raise EngineError("参数 value 必须是字符串")
    s = value.strip()
    if key == "data_dir":
        if not s:
            raise EngineError("数据目录不能为空")
    elif key == "cache_dir" and not s:
        return ""                       # 空字符串 = 用数据目录下的默认缓存目录
    if key in ("data_dir", "cache_dir", "everything_path"):
        if key == "everything_path":
            return s
        return os.path.normpath(os.path.abspath(os.path.expandvars(
            os.path.expanduser(s))))
    if key in _ENGINE_SETTINGS_CHOICES:
        low = s.lower()
        if low not in _ENGINE_SETTINGS_CHOICES[key]:
            raise EngineError("参数 value 只能是 %s"
                              % " / ".join(_ENGINE_SETTINGS_CHOICES[key]))
        return low
    if key in ("shot_time", "cache_time"):
        if not _engine_time_text(s):
            raise EngineError("参数 value 必须是 HH:MM 格式的时间")
        return s
    return s


def _engine_settings_set(params):
    """settings.set：只写白名单键；改 data_dir 只搬配置，不搬数据。"""
    global DATA_DIR_MISSING
    key = params.get("key")
    if not isinstance(key, str) or not key.strip():
        raise EngineError("参数 key 必须是非空字符串")
    key = key.strip()
    if key not in _ENGINE_SETTINGS_TYPES:
        raise EngineError("不支持的设置项：%s" % key)
    if "value" not in params:
        raise EngineError("缺少参数 value")
    value = _engine_settings_value(key, params["value"])

    s = load_settings()
    old_data = os.path.normpath(os.path.abspath(s.get("data_dir") or DEFAULT_DATA))
    data_changed = False
    if key == "data_dir":
        why = check_data_dir(value, old_data)
        if why:
            raise EngineError(why.replace("\n", " "))
        data_changed = os.path.normcase(value) != os.path.normcase(old_data)
    elif key == "cache_dir" and value:
        why = check_data_dir(value, None)
        if why:
            raise EngineError(why.replace("\n", " "))
    elif key == "cache_custom_dirs":
        for p in value:
            why = check_cache_custom_dir(p)
            if why:
                raise EngineError("自定义缓存目录不可用：%s（%s）" % (why, p))

    s[key] = value
    if not save_settings(s):
        raise EngineError("设置保存失败：写不进 %s" % SETTINGS_PATH)
    # 引擎进程里 S 是模块级缓存，写完立刻对齐，后面的方法才不会用旧路径
    S.clear()
    S.update(load_settings())
    if key == "data_dir":
        DATA_DIR_MISSING = False
    res = {"key": key, "value": S.get(key), "settings_path": SETTINGS_PATH,
           "data_dir": data_dir()}
    if key == "data_dir":
        res["migrated_settings"] = bool(data_changed)
    return res


def _engine_file_text(params, name="path"):
    """取一个必填的文件路径并读出文本（UTF-8 BOM 兼容，与界面一致）。"""
    raw = params.get(name)
    if not isinstance(raw, str) or not raw.strip():
        raise EngineError("参数 %s 必须是非空字符串" % name)
    p = os.path.normpath(os.path.abspath(os.path.expandvars(
        os.path.expanduser(raw.strip()))))
    if not os.path.isfile(p):
        raise EngineError("文件不存在或不是文件：%s" % p)
    try:
        with open(p, encoding="utf-8-sig") as f:
            return p, f.read()
    except OSError as ex:
        raise EngineError("读不了文件：%s（%s）" % (p, ex))


def _engine_folder_dir(params, name="folder"):
    """取一个必填的目录参数（规则执行的工作目录）。"""
    raw = params.get(name)
    if not isinstance(raw, str) or not raw.strip():
        raise EngineError("参数 %s 必须是非空字符串" % name)
    p = os.path.normpath(os.path.abspath(os.path.expandvars(
        os.path.expanduser(raw.strip()))))
    if not os.path.isdir(p):
        raise EngineError("参数 %s 必须是已存在的目录：%s" % (name, p))
    return p


def _engine_rules_events(text):
    """从 run_rules 的输出里捞出 organize 的 JSON 事件行（其余行留作错误信息）。"""
    events, plain = [], []
    for line in (text or "").splitlines():
        line = line.strip()
        if not line:
            continue
        if line.startswith("{"):
            try:
                ev = json.loads(line)
            except Exception:
                plain.append(line)
                continue
            if isinstance(ev, dict) and ev.get("type"):
                events.append(ev)
                continue
        plain.append(line)
    return events, plain


def _engine_rules_execute(text, folder, simulate):
    """跑一遍 YAML 规则并拿回 JSONL 事件；结束后把工作目录还回去。"""
    try:
        from organize.output import JSONL
    except Exception as ex:
        raise EngineError("未集成 organize 引擎：%s" % ex)
    cwd = os.getcwd()
    try:
        # auto_confirm：engine 的 stdin 是 RPC 通道，绝不能让 organize 的
        # 交互确认去读它；确认语义由 RPC 的 confirm 参数承担。
        out, ok = run_rules(text, simulate=simulate,
                            output=JSONL(auto_confirm=True),
                            working_dir=folder)
    finally:
        try:
            os.chdir(cwd)
        except Exception:
            pass
    if not ok:
        raise EngineError((out or "规则执行失败").strip()[:2000])
    return _engine_rules_events(out)[0]


def _engine_rules_text(params):
    """取要校验/预演的 YAML 文本：优先用请求里直接给的 text，其次读 path。

    编辑器里的草稿还没存盘时，以前必须先存一个文件才能校验——用户点了
    「校验」却弹出「先保存」，这是把内部实现漏到了界面上。现在两条路都行。
    """
    raw = params.get("text")
    if isinstance(raw, str) and raw.strip():
        return "(未保存的草稿)", raw
    return _engine_file_text(params)


def _engine_rules_validate(params):
    """rules.validate：只校验 YAML，不执行任何动作。"""
    _p, text = _engine_rules_text(params)
    msg, ok = check_rules(text)
    rule_count = 0
    if ok:
        try:
            from organize import Config
            rule_count = len(Config.from_string(text).rules)
        except Exception as ex:
            ok = False
            msg = "配置有误：%s" % ex
    errors = []
    if not ok:
        line = 0
        m = re.search(r"line\s+(\d+)", msg or "")
        if m:
            try:
                line = int(m.group(1))
            except Exception:
                line = 0
        errors.append({"line": line, "message": msg or "配置有误"})
    return {"ok": bool(ok), "errors": errors, "warnings": [],
            "rule_count": int(rule_count), "message": msg}


def _engine_rules_preview(params):
    """rules.preview：只算出会移动什么，不落盘。"""
    _p, text = _engine_rules_text(params)
    folder = _engine_folder_dir(params)
    events = _engine_rules_execute(text, folder, simulate=True)
    moves, skipped = [], 0
    for ev in events:
        if ev.get("type") != "MSG":
            continue
        sender = str(ev.get("sender") or "")
        msg = str(ev.get("msg") or "")
        level = str(ev.get("level") or "info")
        src = str(ev.get("path") or "")
        if sender in ("move", "copy", "rename"):
            dst = ""
            for sep in (" to ", " into "):
                if sep in msg:
                    dst = msg.split(sep, 1)[1].strip()
                    break
            if dst and not os.path.isabs(dst) and src:
                # rename 的 msg 只有新文件名，补回所在目录
                dst = os.path.join(os.path.dirname(src), dst)
            moves.append({"src": src, "dst": dst, "reason": msg})
        elif sender == "conflict" and "Skip" in msg:
            skipped += 1
        elif level == "error":
            skipped += 1
    return {"moves": moves, "total": len(moves), "skipped": int(skipped)}


def _engine_rules_run(params):
    """rules.run：confirm=false 只预演；true 才真正执行 organize 规则。"""
    _p, text = _engine_file_text(params)
    folder = _engine_folder_dir(params)
    confirm = _engine_get(params, "confirm", False, bool)
    events = _engine_rules_execute(text, folder, simulate=not confirm)
    failed, report = [], None
    for ev in events:
        if ev.get("type") == "REPORT":
            report = ev
        elif ev.get("type") == "MSG" and str(ev.get("level") or "") == "error":
            failed.append({"src": str(ev.get("path") or ""),
                           "why": str(ev.get("msg") or "执行失败")})
    if report is not None:
        moved = int(report.get("success_count") or 0)
        total = moved + int(report.get("error_count") or 0)
    else:
        moved = len([e for e in events if e.get("type") == "MSG"
                     and str(e.get("sender") or "") in ("move", "copy", "rename")])
        total = moved
    return {"dry_run": not confirm, "moved": int(moved),
            "failed": failed, "total": int(total)}


def _engine_migrate_build_plan(params):
    """migrate.plan / migrate.apply 共用的「校验参数 + 规划 + 预检」。"""
    if MIG is None:
        raise EngineError("迁移组件缺失：migrate_engine.py 不在程序目录")
    sources = _engine_path_list(params, "sources")
    raw_dest = params.get("destination")
    if not isinstance(raw_dest, str) or not raw_dest.strip():
        raise EngineError("参数 destination 必须是非空字符串")
    dest = os.path.normpath(os.path.abspath(os.path.expandvars(
        os.path.expanduser(raw_dest.strip()))))
    if os.path.exists(dest) and not os.path.isdir(dest):
        raise EngineError("参数 destination 是文件，不是目录：%s" % dest)
    if is_drive_root(dest):
        raise EngineError("参数 destination 不能是盘符根目录：%s" % dest)
    mode = _engine_get(params, "mode", "move", str).strip().lower()
    if mode not in ("move", "copy"):
        raise EngineError("参数 mode 只能是 move / copy")
    conflict = _engine_get(params, "conflict", "rename", str).strip().lower()
    if conflict not in ("rename", "skip", "overwrite"):
        raise EngineError("参数 conflict 只能是 rename / skip / overwrite")
    opts = MIG.Options(mode=mode, conflict=conflict)
    plan = MIG.build_plan(sources, dest, opts)
    issues = MIG.preflight(plan)
    return plan, issues


_MIGRATE_ARCHIVE_EXTS = {
    ".zip", ".7z", ".rar", ".tar", ".gz", ".tgz", ".bz2", ".tbz2",
    ".xz", ".txz", ".zst", ".cab", ".iso", ".001",
}


def _migrate_kind(path):
    """来源类型：目录 / 压缩包 / 单个文件，前端按这个显示图标与类型。"""
    try:
        if os.path.isdir(path):
            return "dir"
    except OSError:
        pass
    if os.path.splitext(path)[1].lower() in _MIGRATE_ARCHIVE_EXTS:
        return "archive"
    return "file"


def _engine_migrate_jobs(plan):
    """按来源把 plan.items 汇总成客户端要的逐来源任务行。"""
    jobs = []
    for src in plan.sources:
        key = os.path.normcase(src)
        prefix = key + os.sep
        items = [i for i in plan.items
                 if os.path.normcase(i.src) == key
                 or os.path.normcase(i.src).startswith(prefix)]
        plain = os.path.join(plan.dest, os.path.basename(src.rstrip("\\/")))
        root = next((i for i in items if os.path.normcase(i.src) == key), None)
        target = str(getattr(root, "dst", "") or plain) if root else plain
        jobs.append({
            "source": src,
            "target": target,
            "name": os.path.basename(src.rstrip("\\/")),
            "kind": _migrate_kind(src),
            "size": int(sum(int(i.size or 0) for i in items
                            if i.kind == "file")),
            "items": len(items),
            "conflict": target != plain or os.path.exists(plain),
            "action": str(getattr(root, "action", "") or ""),
        })
    return jobs


def _engine_migrate_blocked(issues):
    return [{"source": str(i.path or ""), "why": str(i.msg or "")}
            for i in issues if i.level == "error"]


def _engine_migrate_plan(params):
    """migrate.plan：只读规划，不建目录、不动文件。"""
    plan, issues = _engine_migrate_build_plan(params)
    return {"jobs": _engine_migrate_jobs(plan),
            "total_size": int(plan.bytes),
            "blocked": _engine_migrate_blocked(issues),
            "total_files": int(plan.n_files),
            "cross_volume": bool(plan.cross_volume)}


def _engine_migrate_apply(params):
    """migrate.apply：confirm=false 只回计划；true 才执行并留任务现场。"""
    plan, issues = _engine_migrate_build_plan(params)
    confirm = _engine_get(params, "confirm", False, bool)
    job_id = params.get("id")
    if job_id is not None:
        if not isinstance(job_id, str):
            raise EngineError("参数 id 必须是字符串或 null")
        job_id = job_id.strip() or None      # 空字符串按「没传」处理
        if job_id is not None and (
                job_id in (".", "..") or len(job_id) > 80
                or any(c in job_id for c in '\\/:*?"<>|')):
            raise EngineError("参数 id 不能含路径分隔符，最长 80 个字符")
    jobs = _engine_migrate_jobs(plan)
    blocked = _engine_migrate_blocked(issues)
    result = {"dry_run": True, "job_id": "", "moved": 0, "failed": [],
              "report_path": "", "total_size": int(plan.bytes),
              "jobs": jobs, "blocked": blocked}
    if not confirm:
        return result
    if blocked:
        # 与命令行一致的「存在阻断项，未执行」，但协议层仍是正常响应
        result["refused"] = True
        result["error"] = "存在阻断项，未执行迁移"
        result["failed"] = [{"source": b["source"], "why": b["why"]}
                            for b in blocked]
        return result

    rep = MIG.execute(plan, mig_jobs_dir(), job_id=job_id or None)
    report_path = os.path.join(rep.job_dir, "report.json")
    try:
        payload = rep.to_dict()
        payload["plan"] = plan.summary()
        payload["issues"] = [{"level": i.level, "code": i.code,
                              "msg": i.msg, "path": i.path}
                             for i in issues]
        tmp = report_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=1)
        os.replace(tmp, report_path)
    except Exception:
        report_path = ""                # 报告写不了不影响迁移结果本身
    return {"dry_run": False, "job_id": rep.job_id, "moved": int(rep.done),
            "failed": [{"source": str(f.get("src") or ""),
                        "why": str(f.get("error") or "")}
                       for f in (rep.failures or [])],
            "report_path": report_path, "total_size": int(plan.bytes),
            "skipped": int(rep.skipped), "cancelled": bool(rep.cancelled),
            "job_dir": rep.job_dir, "jobs": jobs, "blocked": []}


_SKIP_LEGEND = [
    ("排除的后缀", "你在扫描选项里填了「排除后缀」，这类文件不参与整理"),
    ("系统文件", "Windows 的系统文件（desktop.ini、thumbs.db 之类），动了会影响系统"),
    ("快捷方式/锁文件", "快捷方式与 Office/软件锁文件，移动后会失效"),
    ("临时占位文件", "下载中的 .part/.crdownload/.tmp 之类，还在写"),
    ("以 _ 开头的说明文件", "以 _ 开头的说明/占位文件，按约定保留在原处"),
    ("读不到属性", "没有读取权限，或文件正被独占"),
    ("系统属性", "带系统属性的文件，安全规则不动"),
    ("符号链接/联接点", "是链接而不是实体文件，移动链接会打断指向"),
    ("最近改动过，可能在用", "修改时间在「跳过最近」的分钟数以内，怕你还在用"),
    ("排除的目录", "你在「排除目录」里写了这个目录名"),
]


def _engine_rules_explain(params):
    """rules.explain：解释「为什么这样分」「为什么被跳过」。

    模型不许凭常识猜分类，界面上也不该出现「大概是因为扩展名吧」这种话。
    分类规则、被跳过的原因、永不移动的名单都从当前 rules.json 里读出来，
    答案和引擎真正执行时的判断是同一份数据。
    """
    rules = _engine_rules()

    # 分类 → 扩展名（反查 ext_to_cat）
    cat_exts = {}
    for ext, cat in rules.ext_to_cat.items():
        cat_exts.setdefault(cat, []).append(ext)
    for cat in cat_exts:
        cat_exts[cat].sort()

    want_cat = _engine_get(params, "cat", "", str).strip()
    want_name = _engine_get(params, "name", "", str).strip()

    out = {
        "fallback": rules.fallback,
        "cat_order": list(rules.cat_order),
        "never": {
            "exts": sorted(rules.never_exts)[:80],
            "names": sorted(rules.never_names)[:80],
            "prefixes": list(rules.never_prefixes)[:40],
        },
        "skip_reasons": [{"reason": r, "why": w} for r, w in _SKIP_LEGEND],
        "content": {
            "enabled": bool(rules.content_enabled),
            "min_score": int(rules.content_min_score),
            "exts": sorted(rules.content_exts)[:60],
            "rules": [{"cat": c, "keywords": len(k), "strong": len(s)}
                      for c, k, s in rules.content_rules][:40],
        },
    }

    if want_cat:
        exts = cat_exts.get(want_cat, [])
        out["category"] = {
            "cat": want_cat,
            "exts": exts[:120],
            "ext_count": len(exts),
            "is_fallback": want_cat == rules.fallback,
        }
        if not exts and want_cat != rules.fallback:
            out["category"]["note"] = "这个分类没有登记扩展名，只有内容识别会分到它"
    else:
        cats = []
        for cat in rules.cat_order:
            exts = cat_exts.get(cat, [])
            cats.append({"cat": cat, "ext_count": len(exts), "exts": exts[:24]})
        out["categories"] = cats

    if want_name:
        cat = rules.category(want_name)
        ext = os.path.splitext(want_name)[1].lower()
        out["matched"] = {
            "name": want_name,
            "ext": ext,
            "cat": cat,
            "why": ("扩展名 " + ext + " 登记在「" + cat + "」下") if ext in rules.ext_to_cat
                   else ("扩展名 " + (ext or "（无）") + " 没有登记，落到兜底分类「" + cat + "」"),
        }

    return out


_ENGINE_METHODS = {
    "ping": lambda _params: _engine_ping(),
    "settings.get": lambda _params: _engine_settings(),
    "scan": _engine_scan,
    "organize": _engine_organize,
    "undo": _engine_undo,
    "files.delete": _engine_files_delete,
    "shots.scan": _engine_shots_scan,
    "shots.thumb": _engine_shots_thumb,
    "shots.clean": _engine_shots_clean,
    "cache.list": _engine_cache_list,
    "cache.clean": _engine_cache_clean,
    "clean.auto": _engine_clean_auto,
    "apps.list": _engine_apps_list,
    "apps.icons": _engine_apps_icons,
    "apps.uninstall": _engine_apps_uninstall,
    "apps.registry": _engine_apps_registry,
    "apps.delete_entry": _engine_apps_delete_entry,
    "apps.force_remove": _engine_apps_force_remove,
    "apps.leftovers": _engine_apps_leftovers,
    "apps.cleanup": _engine_apps_cleanup,
    "search.status": _engine_search_status,
    "search.index": _engine_search_index,
    "search.query": _engine_search_query,
    "search.top": _engine_search_top,
    "search.folders": _engine_search_folders,
    "search.add": _engine_search_add,
    "search.remove": _engine_search_remove,
    "search.selfcheck": _engine_search_selfcheck,
    "search.hot": _engine_search_hot,
    "settings.set": _engine_settings_set,
    "rules.validate": _engine_rules_validate,
    "rules.preview": _engine_rules_preview,
    "rules.run": _engine_rules_run,
    "rules.explain": _engine_rules_explain,
    "migrate.plan": _engine_migrate_plan,
    "migrate.apply": _engine_migrate_apply,
}


def _engine_dispatch(req):
    """分发一条已解析的请求；不合法就抛 EngineError。"""
    if not isinstance(req, dict):
        raise EngineError("请求必须是 JSON 对象")
    method = req.get("method")
    params = req.get("params")
    if params is None:
        params = {}
    if not isinstance(params, dict):
        raise EngineError("params 必须是 JSON 对象")
    fn = _ENGINE_METHODS.get(method) if isinstance(method, str) else None
    if fn is None:
        raise EngineError("未知方法：%s" % (method,))
    return fn(params)


def run_engine():
    """--engine：无 GUI 的 JSON Lines RPC 循环，stdin 关闭时退出。"""
    if sys.stdin is None or sys.stdout is None:   # 无控制台的窗口版 exe 没法做 RPC
        try:
            sys.stderr.write("--engine 需要可用的标准输入/输出通道\n")
        except Exception:
            pass
        return 1
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    # 空闲自动退出：外壳会按需重新拉起（冷启动约 0.2 秒），
    # 避免用户只是开着窗口时白占一份 26MB 的 Python 进程。
    _idle = [time.time()]
    _busy = [False]
    _idle_secs = 600

    def _idle_watch():
        while True:
            time.sleep(20)
            if not _busy[0] and time.time() - _idle[0] >= _idle_secs:
                os._exit(0)

    threading.Thread(target=_idle_watch, name='engine-idle', daemon=True).start()
    # 后台抽查索引：只在空闲时跑，抽样几十毫秒，判定过期才重建。
    # 启动它意味着「用户什么都不用做，索引也会跟上磁盘」。
    try:
        if _freshness_mode() != "manual":
            start_index_watchdog()
    except Exception:
        pass

    while True:
        line = sys.stdin.readline()
        if not line:                     # stdin 关闭 → 正常退出
            break
        _idle[0] = time.time()
        line = line.strip()
        if not line:
            continue
        rid = None
        _busy[0] = True
        try:
            req = json.loads(line)
            if isinstance(req, dict):
                rid = req.get("id")
            result = _engine_dispatch(req)
            resp = {"id": rid, "ok": True, "result": result}
        except (Exception, SystemExit) as ex:
            resp = {"id": rid, "ok": False, "error": _engine_err_text(ex)}
            try:
                if isinstance(ex, EngineError):
                    sys.stderr.write("[engine] %s\n" % resp["error"])
                else:
                    traceback.print_exc(file=sys.stderr)
            except Exception:
                pass
        try:
            sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
            sys.stdout.flush()
        except Exception:                # stdout 断了（客户端退出）→ 收工
            break
        finally:
            _busy[0] = False
            _idle[0] = time.time()
    return 0


def main():
    if "--engine" in sys.argv:
        return run_engine()

    argv = sys.argv[1:]

    # ── 静默操作：两种版本都要能执行，先处理 ──
    if "--install-menu" in argv:
        install_explorer_menu()
        return
    if "--remove-menu" in argv:
        remove_explorer_menu()
        return
    if "--clean-shots" in argv:
        hide_console()
        run_clean_shots()
        return
    if "--clean-cache" in argv:
        hide_console()
        run_clean_cache()
        return
    if "--migrate" in argv:
        if MIG is None:
            print("迁移组件缺失：migrate_engine.py 不在程序目录")
            return
        sys.exit(MIG.main([a for a in argv if a != "--migrate"]))
    if "--shots" in argv:
        # 只列不清，用来检查规则命中情况
        _dirs = S.get("shot_dirs") or shot_dirs_default()
        _hits = find_screenshots(_dirs, S.get("shot_keep_days", 7),
                                 S.get("shot_min_kb", 0))
        total = sum(h[1] for h in _hits)
        print("截图清理设置：保留最近 %s 天，忽略小于 %s KB"
              % (S.get("shot_keep_days", 7), S.get("shot_min_kb", 0)))
        print("扫描目录：%s" % "；".join(_dirs))
        print("命中 %d 张，共 %s" % (len(_hits), human(total)))
        for _p, _sz, _mt in _hits[:200]:
            print("  %s  (%s)" % (_p, human(_sz)))
        if len(_hits) > 200:
            print("  …… 另有 %d 张" % (len(_hits) - 200))
        print("\n这是预演，未删任何文件。要执行清理运行 --clean-shots。")
        return

    if "--undo" in argv:
        # 撤销要在「无参数就开界面」之前处理，否则 exe 不给文件夹时会直接弹界面
        _folder = next((a for a in argv if not a.startswith("--")), "")
        if not _folder:
            try:
                for fn in sorted(os.listdir(hist_dir()), reverse=True):
                    if fn.endswith(".json"):
                        _folder = json.load(
                            open(os.path.join(hist_dir(), fn),
                                 encoding="utf-8")).get("folder", "")
                        break
            except Exception:
                _folder = ""
        n, failed = undo(_folder)
        try:
            print(f"[OK] 已还原 {n} 个文件" if n else "没有可撤销的记录："
                  f"{failed[0][1] if failed else '没有整理记录'}")
            for name, why in failed[:10]:
                print(f"  {name}  <- {why}")
        except Exception:
            pass
        return

    is_gui_build = detect_gui_build()

    if not is_gui_build:
        for s in (sys.stdout, sys.stderr):
            try:
                s.reconfigure(encoding="utf-8", errors="replace")
            except Exception:
                pass

    args = [a for a in argv if not a.startswith("--")]
    for flag in ("--csv", "--on-conflict"):
        if flag in sys.argv:
            i = sys.argv.index(flag)
            if len(sys.argv) > i + 1:
                args = [a for a in args if a != sys.argv[i + 1]]

    if is_gui_build:
        if "--scheduled" in argv:
            run_scheduled(args or [os.getcwd()])
            return
        if "--tray" in argv:
            # 自启用：直接进托盘，全程不显示窗口
            if not _claim_single_instance():
                return                      # 已经有一个在跑，静默退出
            if prefill_dir(args):
                run_gui(prefill=prefill_dir(args), tray_only=False)
            else:
                run_gui(prefill=None, tray_only=True)
            return
        if not _claim_single_instance():
            _signal_show_existing()         # 再点一次 = 把窗口叫出来
            return
        run_gui(prefill=args[0] if args and os.path.isdir(args[0]) else None)
        return

    if "--tray" in argv:
        hide_console()
        if not _claim_single_instance():
            return
        run_gui(prefill=None, tray_only=True)
        return

    if "--gui" in argv:
        hide_console()
        if not _claim_single_instance():
            _signal_show_existing()
            return
        run_gui(prefill=args[0] if args else None)
        return

    if not args:
        hide_console()
        if not _claim_single_instance():
            _signal_show_existing()
            return
        run_gui()
        return

    pause_needed = console_is_ours()
    try:
        code = run_cli(args[0])
    finally:
        if pause_needed:
            try:
                input("\n按回车键关闭…")
            except Exception:
                pass
    sys.exit(code)


if __name__ == "__main__":
    main()






