# -*- coding: utf-8 -*-
"""整理助手 · 数据迁移引擎
=========================================
把文件、文件夹、应用数据目录、压缩包整棵搬到另一个位置，只做「搬」这一件事，
但把这件事做到可预演、可校验、可续跑、可回滚。

设计原则（每一条都对应一类真实事故）
------------------------------------
1. 计划与执行分离：先扫描出完整清单 + 预检，再动手；默认只预演。
2. 同卷移动用 os.rename：原子、瞬时，不复制任何字节。
   跨卷才走复制；跨卷「复制 + 删除」是唯一会丢数据的路径，所以它被拆成
   「复制到临时名 → fsync → 校验 → 原子改名 → 最后才删源」。
3. 全程写事务日志（SQLite WAL）。删源之前一定先落「已发布」状态，
   崩溃后重跑能接着做完，不会出现「源没了、目标也没有」。
4. 不跟随、不穿越 junction / 符号链接。跨卷时按原样重建链接，重建不了就报错，
   绝不悄悄展开成一份拷贝。
5. 目标已存在时默认不覆盖：改名 / 跳过 / 备份后覆盖 / 合并，四选一，显式声明。
6. 预检覆盖：空间、同卷判定、目录嵌套、长路径、保留名、链接、被占用文件、
   大小写重名。任何 error 级问题在执行前拦下。

对外接口
--------
    opts = Options(mode="move", conflict="rename", verify="auto")
    plan = build_plan([r"D:\下载"], r"E:\归档", opts)
    issues = preflight(plan)
    report = execute(plan, jobs_dir=r"D:\整理助手\数据\迁移", progress=cb, cancel=ev)

    undo_job(job_id, jobs_dir)      # 整体回滚
    verify_job(job_id, jobs_dir)    # 复核已迁移的文件

命令行
------
    python migrate_engine.py --to E:\\归档 D:\\下载
    python migrate_engine.py --to E:\\归档 --apply D:\\下载
    python migrate_engine.py --undo 20261028-101500-ab12cd
    python migrate_engine.py --list
"""
from __future__ import annotations

import ctypes
import ctypes.wintypes as wt
import hashlib
import json
import os
import shutil
import sqlite3
import stat
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

CHUNK = 4 * 1024 * 1024
HASH_LIMIT = 128 * 1024 * 1024      # auto 模式下超过这个大小改用抽样校验
SAMPLE = 1024 * 1024
LONG_PATH_AT = 240
FILE_ATTRIBUTE_REPARSE_POINT = 0x400
FILE_ATTRIBUTE_READONLY = 0x1

ST_PENDING = "pending"
ST_DONE = "done"
ST_FAILED = "failed"
ST_SKIPPED = "skipped"

IS_WIN = os.name == "nt"


# ─────────────────────────── 基础工具 ───────────────────────────

def human(n):
    n = float(n or 0)
    for unit, div in (("TB", 1024 ** 4), ("GB", 1024 ** 3), ("MB", 1024 ** 2), ("KB", 1024)):
        if n >= div:
            return "%.2f %s" % (n / div, unit)
    return "%d B" % n


def lp(path):
    """需要时加 \\\\?\\ 前缀，绕开 260 字符上限。"""
    if not IS_WIN:
        return path
    p = os.path.abspath(path)
    if p.startswith("\\\\?\\"):
        return p
    if len(p) < LONG_PATH_AT:
        return p
    if p.startswith("\\\\"):
        return "\\\\?\\UNC\\" + p[2:]
    return "\\\\?\\" + p


def volume_of(path):
    """文件所在卷的标识。同卷返回相同值；Windows 上 st_dev 就是卷序列号。

    用 lstat：junction 要按「链接自己所在的卷」算，不能跟到目标去，
    否则会把跨卷链接误判成同卷，rename 时报 WinError 17。
    """
    p = os.path.abspath(path)
    while p and not os.path.lexists(p):
        parent = os.path.dirname(p)
        if parent == p:
            break
        p = parent
    try:
        return os.lstat(p).st_dev
    except OSError:
        try:
            return os.stat(p).st_dev
        except OSError:
            drive = os.path.splitdrive(os.path.abspath(path))[0].upper()
            return drive or path


def is_reparse(path):
    try:
        st = os.lstat(lp(path))
    except OSError:
        return False
    return bool(getattr(st, "st_file_attributes", 0) & FILE_ATTRIBUTE_REPARSE_POINT)


def is_junction(path):
    """junction 不是符号链接，os.path.islink 对它返回 False。"""
    if not is_reparse(path) or os.path.islink(path):
        return False
    if not IS_WIN:
        return False
    try:
        return os.path.isdir(path) or True
    except OSError:
        return False


def read_link(path):
    try:
        t = os.readlink(lp(path))
    except OSError:
        return ""
    if t.startswith("\\\\?\\"):
        t = t[4:]
    return t


def make_junction(link, target):
    """junction 不需要管理员权限，是最稳的跨卷链接重建方式。"""
    if os.path.exists(link):
        raise OSError("链接位置已被占用：%s" % link)
    rc = os.system('cmd /c mklink /J "%s" "%s" >nul 2>nul' % (link, target))
    if rc != 0 or not os.path.exists(link):
        raise OSError("重建 junction 失败：%s -> %s" % (link, target))


def free_bytes(path):
    try:
        return shutil.disk_usage(path).free
    except OSError:
        return 0


def same_volume(a, b):
    return volume_of(a) == volume_of(b)


def _unique(dst, is_dir):
    base, ext = os.path.splitext(dst)
    i = 2
    while True:
        cand = ("%s (%d)%s" % (base, i, ext)) if not is_dir else ("%s (%d)" % (dst, i))
        if not os.path.exists(lp(cand)):
            return cand
        i += 1


def digest_file(path, limit=None, sample=False):
    """blake2b-128。limit/sample 用于超大文件的抽样校验。"""
    h = hashlib.blake2b(digest_size=16)
    size = os.path.getsize(lp(path))
    with open(lp(path), "rb", buffering=0) as f:
        if sample and size > 3 * SAMPLE:
            h.update(f.read(SAMPLE))
            f.seek(size - SAMPLE)
            h.update(f.read(SAMPLE))
        else:
            while True:
                buf = f.read(CHUNK)
                if not buf:
                    break
                h.update(buf)
    return h.hexdigest()


def _copy_attrs(src, dst):
    try:
        shutil.copystat(lp(src), lp(dst), follow_symlinks=False)
    except OSError:
        pass
    try:                                   # copystat 不带 ns 精度，补一次
        st = os.stat(lp(src))
        os.utime(lp(dst), ns=(st.st_atime_ns, st.st_mtime_ns))
    except OSError:
        pass


def _force_rm(path):
    try:
        os.chmod(lp(path), stat.S_IWRITE)
    except OSError:
        pass
    try:
        os.remove(lp(path))
    except OSError:
        pass


# ─────────────────────────── 选项与结果 ───────────────────────────

class Options(object):
    """一条迁移任务的全部可调项。"""

    def __init__(self, mode="move", conflict="rename", verify="auto",
                 follow_links=False, delete_mode="delete", workers=4,
                 preserve=True, force_copy=False, skip_recent_min=0,
                 allow_root=False, flatten=False):
        self.mode = mode if mode in ("move", "copy") else "move"
        self.conflict = conflict if conflict in (
            "rename", "skip", "overwrite", "merge", "newer") else "rename"
        self.verify = verify if verify in ("auto", "hash", "size", "none") else "auto"
        self.follow_links = bool(follow_links)
        self.delete_mode = delete_mode if delete_mode in ("delete", "trash") else "delete"
        self.workers = max(1, min(16, int(workers or 4)))
        self.preserve = bool(preserve)
        self.force_copy = bool(force_copy)     # 测试用：强制走复制分支
        self.skip_recent_min = int(skip_recent_min or 0)
        self.allow_root = bool(allow_root)
        self.flatten = bool(flatten)           # True：把来源内容倒进目标，不多套一层

    def to_dict(self):
        return dict(self.__dict__)

    @classmethod
    def from_dict(cls, d):
        o = cls()
        for k, v in (d or {}).items():
            if hasattr(o, k):
                setattr(o, k, v)
        return o


class Item(object):
    __slots__ = ("iid", "src", "dst", "kind", "size", "mtime_ns",
                 "action", "state", "error", "backup", "digest", "volume_same")

    def __init__(self, src, dst, kind, size=0, mtime_ns=0, action="move",
                 state=ST_PENDING, backup=""):
        self.iid = 0
        self.src = src
        self.dst = dst
        self.kind = kind            # file / dir / link
        self.size = size
        self.mtime_ns = mtime_ns
        self.action = action        # move / copy / skip / merge
        self.state = state
        self.error = ""
        self.backup = backup
        self.digest = ""
        self.volume_same = None

    def to_dict(self):
        return {k: getattr(self, k) for k in self.__slots__}

    @classmethod
    def from_dict(cls, d):
        it = cls(d["src"], d["dst"], d["kind"])
        for k in cls.__slots__:
            if k in d:
                setattr(it, k, d[k])
        return it


class Plan(object):
    def __init__(self, sources, dest, opts):
        self.sources = sources
        self.dest = dest
        self.opts = opts
        self.items = []
        self.n_files = 0
        self.n_dirs = 0
        self.n_links = 0
        self.bytes = 0
        self.cross_volume = False
        self.issues = []

    def summary(self):
        return {"sources": self.sources, "dest": self.dest,
                "files": self.n_files, "dirs": self.n_dirs,
                "links": self.n_links, "bytes": self.bytes,
                "cross_volume": self.cross_volume,
                "mode": self.opts.mode, "conflict": self.opts.conflict}

    def to_dict(self):
        return {"sources": self.sources, "dest": self.dest,
                "opts": self.opts.to_dict(), "summary": self.summary(),
                "items": [i.to_dict() for i in self.items]}


class Issue(object):
    def __init__(self, level, code, msg, path=""):
        self.level = level          # error / warn
        self.code = code
        self.msg = msg
        self.path = path

    def __str__(self):
        return "[%s] %s%s" % (self.level, self.msg, ("  " + self.path) if self.path else "")


# ─────────────────────────── 计划 ───────────────────────────

SYSTEM_DIRS = ("windows", "program files", "program files (x86)", "programdata",
               "$recycle.bin", "system volume information", "recovery")


# ── 程序安装目录保护 ──────────────────────────────────────────────
# 有过这样的事故：D:\App\123网盘\123pan 被整体合并进 D:\App\百度网盘\，
# 原目录只剩一个空壳，开始菜单快捷方式和卸载注册表全部指向不存在的路径。
# 所以「程序目录」要有一个统一判定，迁移引擎命中就整目录拒搬，
# 不接受 allow_root 之类的绕过开关。
APP_DIR_UNINSTALLERS = {
    "unins000.exe", "unins001.exe", "unins002.exe", "uninstall.exe",
    "uninst.exe", "uninst000.exe", "unins000.dat", "uninstall.dat",
}
APP_DIR_MARKERS = {
    "app.asar", "chrome_100_percent.pak", "chrome_200_percent.pak",
    "icudtl.dat", "resources.pak", "snapshot_blob.bin",
    "v8_context_snapshot.bin", "steam_api64.dll", "unityplayer.dll",
    "portable.ini", "squirrel.exe",
}
APP_DIR_RUNTIME_EXTS = {
    ".dll", ".pak", ".dat", ".bin", ".node", ".asar", ".so", ".dylib",
    ".pdb", ".lib", ".sys", ".ocx", ".exe",
}
APP_DIR_EXE_EXTS = {".exe", ".com", ".scr"}
APP_DIR_MIN_RUNTIME = 3
APP_DIR_SCAN_MAX = 600
APP_CONTAINER_MIN = 2
PROTECT_APP_DIRS = True


def looks_like_app_dir(path, limit=APP_DIR_SCAN_MAX):
    """目录第一层是否像「程序安装目录」。返回 (bool, 依据说明)。

    三条命中任一条就算：
      1. 有卸载器（unins000.exe / uninstall.exe…）——最硬的证据；
      2. 有 Electron / 游戏引擎特征文件（app.asar、icudtl.dat…）；
      3. 同时有 exe 和 ≥3 个运行时文件（dll/pak/dat/bin…）。
    目录读不了就返回 (False, "")，不因权限问题误判成程序目录。
    """
    if not PROTECT_APP_DIRS:
        return False, ""
    try:
        if not os.path.isdir(lp(path)):
            return False, ""
        with os.scandir(lp(path)) as it:
            entries = []
            for e in it:
                entries.append(e)
                if len(entries) >= limit:
                    break
    except OSError:
        return False, ""
    names = {e.name.lower() for e in entries}
    files = [e for e in entries if not e.is_dir(follow_symlinks=False)]
    exts = [os.path.splitext(e.name)[1].lower() for e in files]
    hit_un = names & APP_DIR_UNINSTALLERS
    if hit_un:
        return True, "含卸载器 " + "/".join(sorted(hit_un)[:2])
    hit_mk = names & APP_DIR_MARKERS
    if hit_mk:
        return True, "含程序特征文件 " + "/".join(sorted(hit_mk)[:2])
    subdirs = {e.name.lower() for e in entries if e.is_dir(follow_symlinks=False)}
    hit_ud = subdirs & APP_DIR_UNINSTALL_DIRS
    if hit_ud:
        return True, "含卸载目录 " + "/".join(sorted(hit_ud)[:2])
    n_exe = sum(1 for x in exts if x in APP_DIR_EXE_EXTS)
    n_rt = sum(1 for x in exts if x in APP_DIR_RUNTIME_EXTS)
    if n_exe >= 1 and n_rt >= APP_DIR_MIN_RUNTIME:
        return True, "含 %d 个可执行文件和 %d 个运行时文件" % (n_exe, n_rt)
    return False, ""


APP_DIR_UNINSTALL_DIRS = {"uninstall", "uninstaller", "unins000", "卸载"}


def looks_like_app_container(path, limit=200):
    """下面第一层就有 ≥2 个程序目录 → 「软件总目录」（各种拓展那种）。

    这种目录本身没有任何程序特征，被当成普通目录一清就整个没了。
    """
    if not PROTECT_APP_DIRS:
        return False, []
    try:
        if not os.path.isdir(lp(path)):
            return False, []
        names = os.listdir(lp(path))[:limit]
    except OSError:
        return False, []
    hits = []
    for n in names:
        sub = os.path.join(lp(path), n)
        if os.path.isdir(sub) and not os.path.islink(sub):
            if looks_like_app_dir(sub)[0]:
                hits.append(n)
                if len(hits) >= APP_CONTAINER_MIN:
                    return True, ["下面有 %d 个程序安装目录：%s"
                                  % (len(hits), " / ".join(hits[:3]))]
    return False, []


def _is_protected(path):
    """这些位置不做迁移源：整盘、系统目录、用户目录根。"""
    p = os.path.abspath(path)
    drive, tail = os.path.splitdrive(p)
    if not tail.strip("\\/"):
        return "整盘根目录"
    low = p.lower().rstrip("\\")
    win = os.environ.get("WINDIR", r"C:\Windows").lower().rstrip("\\")
    if low == win or low.startswith(win + "\\"):
        return "Windows 目录"
    for name in ("program files", "program files (x86)", "programdata"):
        base = os.path.join(drive + "\\", name)
        if low == base.lower() or low.startswith(base.lower() + "\\"):
            return "系统程序目录"
    profile = os.path.expanduser("~").lower().rstrip("\\")
    if low == profile:
        return "用户目录根"
    return ""


def build_plan(sources, dest, opts):
    """扫描来源，生成逐项清单。此时不改动任何文件。"""
    dest = os.path.abspath(dest)
    plan = Plan([os.path.abspath(s) for s in sources], dest, opts)
    seen = set()

    for src in plan.sources:
        if not os.path.exists(lp(src)):
            plan.issues.append(Issue("error", "missing", "来源不存在", src))
            continue
        base = dest if opts.flatten else os.path.join(
            dest, os.path.basename(src.rstrip("\\/")))
        plan.cross_volume = not same_volume(src, dest)
        _walk(plan, src, base, opts, seen, depth=0)

    plan.n_files = sum(1 for i in plan.items if i.kind == "file")
    plan.n_dirs = sum(1 for i in plan.items if i.kind == "dir")
    plan.n_links = sum(1 for i in plan.items if i.kind == "link")
    plan.bytes = sum(i.size for i in plan.items if i.kind == "file")
    plan.cross_volume = any(i.volume_same is False for i in plan.items)
    return plan


def _walk(plan, src, dst, opts, seen, depth):
    opts_ = plan.opts
    try:
        st = os.lstat(lp(src))
    except OSError as ex:
        plan.issues.append(Issue("error", "stat", "读取失败：%s" % ex, src))
        return

    if is_reparse(src):
        it = Item(src, dst, "link", 0, st.st_mtime_ns, opts_.mode)
        it.volume_same = same_volume(src, dst)
        plan.items.append(it)
        return

    if stat.S_ISDIR(st.st_mode):
        is_root = depth == 0
        if is_root and os.path.exists(lp(dst)):
            # 顶层同名：按用户选的冲突策略处理。
            # 以前一律 merge，导致「搬过去只看到里面的内容、外面那层没建」。
            policy = opts_.conflict
            if policy == "skip":
                it = Item(src, dst, "dir", 0, st.st_mtime_ns, "skip")
                it.volume_same = same_volume(src, dst)
                it.error = "目标已存在，按“跳过”处理"
                plan.items.append(it)
                return
            if policy == "rename":
                dst = _unique(dst, True)
        dst_exists_dir = os.path.isdir(lp(dst)) and not is_reparse(dst)
        if not dst_exists_dir:
            it = Item(src, dst, "dir", 0, st.st_mtime_ns, opts_.mode)
            it.volume_same = same_volume(src, dst)
            plan.items.append(it)
        else:
            it = Item(src, dst, "dir", 0, st.st_mtime_ns, "merge")
            it.volume_same = same_volume(src, dst)
            plan.items.append(it)
        try:
            entries = sorted(os.scandir(src), key=lambda e: e.name.lower())
        except OSError as ex:
            plan.issues.append(Issue("warn", "scandir", "目录读不了：%s" % ex, src))
            return
        for e in entries:
            _walk(plan, e.path, os.path.join(dst, e.name), opts, seen, depth + 1)
        return

    # 普通文件
    dst, action, backup = _resolve_conflict(dst, st, opts)
    if dst is None:
        it = Item(src, "", "file", st.st_size, st.st_mtime_ns, "skip")
        plan.items.append(it)
        return
    key = os.path.normcase(dst)
    if key in seen:
        plan.issues.append(Issue("warn", "dup-dst", "计划内目标重复，已改名", dst))
        dst = _unique(dst, False)
        key = os.path.normcase(dst)
    seen.add(key)
    it = Item(src, dst, "file", st.st_size, st.st_mtime_ns, action, backup=backup)
    it.volume_same = same_volume(src, dst)
    if opts.skip_recent_min:
        age = time.time() - st.st_mtime
        if age < opts.skip_recent_min * 60:
            it.action = "skip"
            it.error = "最近 %d 分钟内有改动" % opts.skip_recent_min
    plan.items.append(it)


def _resolve_conflict(dst, st, opts):
    """返回 (最终目标, 动作, 备份路径)。dst 为 None 表示跳过。"""
    if not os.path.exists(lp(dst)):
        return dst, opts.mode, ""
    policy = opts.conflict
    if policy == "skip":
        return None, "skip", ""
    if policy == "newer":
        try:
            if os.path.getmtime(lp(dst)) >= st.st_mtime:
                return None, "skip", ""
        except OSError:
            pass
        return _unique(dst, False), opts.mode, ""
    if policy == "overwrite":
        return dst, opts.mode, dst       # 执行时把旧目标挪进备份区
    if policy == "merge" and os.path.isdir(lp(dst)) and stat.S_ISDIR(st.st_mode):
        return dst, "merge", ""
    return _unique(dst, False), opts.mode, ""


# ─────────────────────────── 预检 ───────────────────────────

class _RM_UNIQUE_PROCESS(ctypes.Structure):
    _fields_ = [("dwProcessId", wt.DWORD), ("ProcessStartTime", wt.FILETIME)]


class _RM_PROCESS_INFO(ctypes.Structure):
    _fields_ = [("Process", _RM_UNIQUE_PROCESS),
                ("strAppName", wt.WCHAR * 256),
                ("strServiceShortName", wt.WCHAR * 64),
                ("ApplicationType", ctypes.c_int),
                ("AppStatus", wt.ULONG),
                ("TSSessionId", wt.DWORD),
                ("bRestartable", wt.BOOL)]


def locked_by(paths):
    """用 Restart Manager 查「谁占着这些文件」，返回 [(路径, 进程名)]。

    和资源管理器删文件时的提示同源，比自己尝试独占打开更准。
    """
    if not IS_WIN or not paths:
        return []
    try:
        rstrtmgr = ctypes.WinDLL("rstrtmgr")
    except OSError:
        return []
    RmStartSession = rstrtmgr.RmStartSession
    RmStartSession.argtypes = [ctypes.POINTER(wt.DWORD), wt.DWORD, wt.LPWSTR]
    RmRegisterResources = rstrtmgr.RmRegisterResources
    RmRegisterResources.argtypes = [wt.DWORD, wt.UINT, ctypes.POINTER(wt.LPCWSTR),
                                    wt.UINT, ctypes.c_void_p, wt.UINT, ctypes.c_void_p]
    RmGetList = rstrtmgr.RmGetList
    RmGetList.argtypes = [wt.DWORD, ctypes.POINTER(wt.UINT), ctypes.POINTER(wt.UINT),
                          ctypes.POINTER(_RM_PROCESS_INFO), ctypes.POINTER(wt.DWORD)]
    RmEndSession = rstrtmgr.RmEndSession
    RmEndSession.argtypes = [wt.DWORD]

    session = wt.DWORD()
    key = ctypes.create_unicode_buffer(64)
    if RmStartSession(ctypes.byref(session), 0, key) != 0:
        return []
    out = []
    try:
        arr = (wt.LPCWSTR * len(paths))(*paths)
        if RmRegisterResources(session, len(paths), arr, 0, None, 0, None) != 0:
            return []
        need = wt.UINT(0)
        have = wt.UINT(0)
        reasons = wt.DWORD(0)
        buf = (_RM_PROCESS_INFO * 1)()
        rc = RmGetList(session, ctypes.byref(need), ctypes.byref(have), buf,
                       ctypes.byref(reasons))
        if rc == 234:                       # ERROR_MORE_DATA
            have = wt.UINT(need.value)
            buf = (_RM_PROCESS_INFO * max(1, need.value))()
            rc = RmGetList(session, ctypes.byref(need), ctypes.byref(have), buf,
                           ctypes.byref(reasons))
        if rc == 0:
            names = {}
            for i in range(have.value):
                info = buf[i]
                names.setdefault(info.Process.dwProcessId, info.strAppName or "?")
            out = [("", "、".join(sorted(set(names.values()))))] if names else []
    except Exception:
        return []
    finally:
        try:
            RmEndSession(session)
        except Exception:
            pass
    return out


def preflight(plan):
    """执行前把所有能预见的坑一次性摆出来。"""
    opts = plan.opts
    issues = list(plan.issues)
    dest = plan.dest

    for src in plan.sources:
        why = _is_protected(src)
        if why and not opts.allow_root:
            issues.append(Issue("error", "protected", "不允许迁移：%s" % why, src))
        # 程序安装目录：硬拒绝，allow_root 也不放行
        hit, ev = looks_like_app_dir(src)
        if hit:
            issues.append(Issue("error", "app-dir",
                                "来源是程序安装目录（%s），不搬动；"
                                "要换位置请用它自己的卸载/重装" % ev, src))
        else:
            hit_box, ev_box = looks_like_app_container(src)
            if hit_box:
                issues.append(Issue("warn", "app-container",
                                    "来源是软件总目录（%s）：可以整体移动，"
                                    "但子软件的开始菜单快捷方式会失效，建议逐个迁移"
                                    % (ev_box[0] if ev_box else ""), src))

    if looks_like_app_dir(dest)[0] or looks_like_app_container(dest)[0]:
        why_d = (looks_like_app_dir(dest)[1] or looks_like_app_container(dest)[1] or [""])[0]
        issues.append(Issue("error", "dest-app-dir",
                            "目标是程序安装目录/软件总目录（%s），不许往里搬"
                            % why_d, dest))

    for i in plan.items:
        if i.kind == "dir" and i.action == "merge" and looks_like_app_dir(i.dst)[0]:
            issues.append(Issue("error", "merge-into-app",
                                "会把目录合并进程序安装目录（%s），拒绝"
                                % looks_like_app_dir(i.dst)[1], i.dst))
            break

    if os.path.exists(lp(dest)) and not os.path.isdir(dest):
        issues.append(Issue("error", "dest-file", "目标是一个文件，不是目录", dest))
    parent = dest if os.path.isdir(dest) else os.path.dirname(dest)
    while parent and not os.path.exists(parent):
        parent = os.path.dirname(parent)
    if parent and not os.access(parent, os.W_OK):
        issues.append(Issue("error", "dest-denied", "目标位置不可写", dest))

    for src in plan.sources:
        a, b = os.path.normcase(os.path.abspath(src)), os.path.normcase(dest)
        if b == a or b.startswith(a + os.sep):
            issues.append(Issue("error", "nested", "目标在来源内部，会自己搬自己", src))
        if a.startswith(b + os.sep):
            issues.append(Issue("error", "nested", "来源在目标内部", src))

    copy_bytes = sum(i.size for i in plan.items if i.kind == "file"
                     and (opts.mode == "copy" or not i.volume_same))
    if copy_bytes:
        need = int(copy_bytes * 1.02) + 64 * 1024 * 1024
        avail = free_bytes(dest if os.path.isdir(dest) else parent or dest)
        if avail and avail < need:
            issues.append(Issue("error", "space",
                                "目标盘剩余 %s，需要约 %s" % (human(avail), human(need)),
                                dest))

    links = [i for i in plan.items if i.kind == "link"]
    bad_links = [i for i in links if (not i.volume_same and not opts.follow_links
                                      and not os.path.isdir(i.src))]
    if bad_links:
        issues.append(Issue("error", "link",
                            "%d 个链接跨卷且无法按原样重建（目标不是目录）" % len(bad_links),
                            bad_links[0].src))

    longs = [i for i in plan.items if len(i.dst) >= LONG_PATH_AT]
    if longs:
        issues.append(Issue("warn", "longpath",
                            "%d 个目标路径超过 %d 字符，已自动加 \\\\?\\ 前缀"
                            % (len(longs), LONG_PATH_AT), longs[0].dst))

    reserved = set()
    for i in plan.items:
        name = os.path.basename(i.dst.rstrip("\\/"))
        if name.upper().split(".")[0] in ("CON", "PRN", "AUX", "NUL") or \
                any(name.upper().startswith(p) for p in ("COM1", "LPT1")):
            reserved.add(i.dst)
    if reserved:
        issues.append(Issue("error", "reserved",
                            "%d 个文件名是 Windows 保留名" % len(reserved),
                            sorted(reserved)[0]))

    files = [i.src for i in plan.items if i.kind == "file" and i.action != "skip"]
    if files and len(files) <= 3000:
        holders = locked_by(files)
        if holders:
            issues.append(Issue("warn", "locked",
                                "有文件正被占用：%s" % holders[0][1], files[0]))
    return issues


# ─────────────────────────── 日志 ───────────────────────────

class Journal(object):
    """SQLite 事务日志。每条状态变更先落盘，再动文件。"""

    SCHEMA = """
    CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS items(
        iid INTEGER PRIMARY KEY, src TEXT, dst TEXT, kind TEXT, size INTEGER,
        mtime_ns INTEGER, action TEXT, state TEXT, error TEXT, backup TEXT,
        digest TEXT, volume_same INTEGER);
    """

    def __init__(self, path):
        self.lock = threading.Lock()
        self.dir = os.path.dirname(os.path.abspath(path))
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=NORMAL")
        self.db.executescript(self.SCHEMA)
        self.db.commit()
        self.pending = []

    def meta_set(self, k, v):
        with self.lock:
            self.db.execute("INSERT OR REPLACE INTO meta VALUES(?,?)", (k, str(v)))
            self.db.commit()

    def meta_get(self, k, default=""):
        row = self.db.execute("SELECT v FROM meta WHERE k=?", (k,)).fetchone()
        return row[0] if row else default

    def add_items(self, items):
        with self.lock:
            self.db.executemany(
                "INSERT INTO items VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                [(i.iid, i.src, i.dst, i.kind, i.size, i.mtime_ns, i.action,
                  i.state, i.error, i.backup, i.digest,
                  1 if i.volume_same else 0) for i in items])
            self.db.commit()

    def update(self, it, flush=False):
        with self.lock:
            self.pending.append((it.state, it.error, it.backup, it.digest, it.iid))
            if flush or len(self.pending) >= 50:
                self._flush_locked()

    def _flush_locked(self):
        if self.pending:
            self.db.executemany(
                "UPDATE items SET state=?, error=?, backup=?, digest=? WHERE iid=?",
                self.pending)
            self.db.commit()
            self.pending = []

    def flush(self):
        with self.lock:
            self._flush_locked()

    def items(self):
        self.flush()
        rows = self.db.execute("SELECT * FROM items ORDER BY iid").fetchall()
        keys = ("iid", "src", "dst", "kind", "size", "mtime_ns", "action",
                "state", "error", "backup", "digest", "volume_same")
        return [dict(zip(keys, r)) for r in rows]

    def close(self):
        try:
            self.flush()
            self.db.close()
        except Exception:
            pass


# ─────────────────────────── 执行 ───────────────────────────

class Cancelled(Exception):
    pass


class Report(object):
    def __init__(self, job_id, job_dir):
        self.job_id = job_id
        self.job_dir = job_dir
        self.done = 0
        self.skipped = 0
        self.failed = 0
        self.bytes = 0
        self.failures = []
        self.cancelled = False
        self.started = time.time()
        self.ended = 0.0

    def to_dict(self):
        return {"job_id": self.job_id, "job_dir": self.job_dir,
                "done": self.done, "skipped": self.skipped, "failed": self.failed,
                "bytes": self.bytes, "cancelled": self.cancelled,
                "seconds": round((self.ended or time.time()) - self.started, 2),
                "failures": self.failures[:200]}


def execute(plan, jobs_dir, progress=None, cancel=None, job_id=None, resume=False):
    """按计划执行。返回 Report。cancel 是 threading.Event。"""
    os.makedirs(jobs_dir, exist_ok=True)
    job_id = job_id or (time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6])
    job_dir = os.path.join(jobs_dir, job_id)
    os.makedirs(job_dir, exist_ok=True)

    if not resume:
        with open(os.path.join(job_dir, "plan.json"), "w", encoding="utf-8") as f:
            json.dump(plan.to_dict(), f, ensure_ascii=False, indent=1)

    j = Journal(os.path.join(job_dir, "journal.db"))
    j.meta_set("job_id", job_id)
    j.meta_set("mode", plan.opts.mode)
    j.meta_set("dest", plan.dest)
    j.meta_set("sources", json.dumps(plan.sources, ensure_ascii=False))
    j.meta_set("status", "running")
    j.meta_set("started", time.strftime("%Y-%m-%d %H:%M:%S"))

    if resume:
        rows = j.items()
        plan.items = [Item.from_dict({k: v for k, v in r.items()}) for r in rows]
        for it in plan.items:
            it.volume_same = bool(it.volume_same)
    else:
        for n, it in enumerate(plan.items, 1):
            it.iid = n
        j.add_items(plan.items)

    rep = Report(job_id, job_dir)
    total = len(plan.items)
    done_count = [0]
    last = [0.0]
    stop = cancel or threading.Event()

    def tick(msg=""):
        if not progress:
            return
        now = time.time()
        if total <= 2000 or now - last[0] > 0.12 or done_count[0] >= total:
            last[0] = now
            try:
                progress(done_count[0], total, msg)
            except Exception:
                pass

    def work(it):
        if stop.is_set():
            raise Cancelled()
        try:
            _process_item(it, plan, j, stop)
            return it
        except Cancelled:
            raise
        except Exception as ex:            # noqa: BLE001
            it.state = ST_FAILED
            it.error = str(ex).replace("\n", " ")[:300]
            j.update(it)
            return it

    try:
        dirs = [i for i in plan.items if i.kind == "dir"]
        for it in dirs:
            if stop.is_set():
                raise Cancelled()
            _make_dir(it, j)
            done_count[0] += 1
            if it.state == ST_DONE:
                rep.done += 1
            tick("建立目录 %d/%d" % (done_count[0], total))
        j.flush()

        rest = [i for i in plan.items if i.kind != "dir" and i.action != "skip"
                and i.state not in (ST_DONE, ST_SKIPPED)]

        for it in plan.items:
            if it.kind != "dir" and (it.action == "skip" or it.state == ST_SKIPPED):
                rep.skipped += 1
                done_count[0] += 1

        if plan.opts.workers <= 1 or len(rest) <= 1:
            for it in rest:
                if stop.is_set():
                    raise Cancelled()
                work(it)
                _account(it, rep)
                done_count[0] += 1
                tick("迁移 %d/%d：%s" % (done_count[0], total, os.path.basename(it.src)[:36]))
        else:
            with ThreadPoolExecutor(max_workers=plan.opts.workers) as pool:
                futures = {pool.submit(work, it): it for it in rest}
                for fut in futures:
                    it = futures[fut]
                    try:
                        fut.result()
                    except Cancelled:
                        raise
                    _account(it, rep)
                    done_count[0] += 1
                    tick("迁移 %d/%d：%s" % (done_count[0], total,
                                             os.path.basename(it.src)[:36]))
    except Cancelled:
        rep.cancelled = True
    finally:
        j.flush()
        if plan.opts.mode == "move" and not rep.cancelled:
            _cleanup_source(plan)
        rep.ended = time.time()
        j.meta_set("status", "cancelled" if rep.cancelled else "finished")
        j.meta_set("ended", time.strftime("%Y-%m-%d %H:%M:%S"))
        j.meta_set("report", json.dumps(rep.to_dict(), ensure_ascii=False))
        j.close()

    return rep


def _account(it, rep):
    if it.state == ST_DONE:
        rep.done += 1
        rep.bytes += it.size
    elif it.state == ST_SKIPPED:
        rep.skipped += 1
    elif it.state == ST_FAILED:
        rep.failed += 1
        rep.failures.append({"src": it.src, "dst": it.dst, "error": it.error})


def _make_dir(it, j):
    if it.action == "merge":
        return
    try:
        if not os.path.isdir(lp(it.dst)):
            os.makedirs(lp(it.dst), exist_ok=True)
        it.state = ST_DONE
    except OSError as ex:
        it.state = ST_FAILED
        it.error = "建目录失败：%s" % ex
    j.update(it)


def _process_item(it, plan, j, stop):
    opts = plan.opts
    if it.action == "skip":
        it.state = ST_SKIPPED
        j.update(it)
        return
    if it.state in (ST_DONE, ST_SKIPPED):
        return

    dst_parent = os.path.dirname(it.dst)
    if dst_parent and not os.path.isdir(lp(dst_parent)):
        os.makedirs(lp(dst_parent), exist_ok=True)

    if it.backup:
        _backup_existing(it, j)

    if it.kind == "link":
        _move_link(it, plan, j)
        return

    atomic = (opts.mode == "move" and not opts.force_copy
              and same_volume(it.src, it.dst) and not opts.follow_links)
    if atomic:
        try:
            os.rename(lp(it.src), lp(it.dst))
            it.state = ST_DONE
            j.update(it, flush=True)
            return
        except OSError as ex:
            # 跨卷判断失误、目标被占用等，退回复制路径
            if os.path.exists(lp(it.dst)):
                it.state = ST_FAILED
                it.error = str(ex)
                j.update(it)
                return

    _copy_item(it, plan, j, stop)


def _backup_existing(it, j):
    """overwrite 策略：旧目标先挪进备份区，不删除。"""
    src = it.backup
    if not src or os.path.normcase(src) != os.path.normcase(it.dst):
        return                          # 已经备份过
    if not os.path.exists(lp(src)):
        it.backup = ""
        return
    bak_dir = os.path.join(j.dir, "backup")
    os.makedirs(bak_dir, exist_ok=True)
    name = os.path.basename(it.dst) + ".bak-" + time.strftime("%H%M%S")
    target = os.path.join(bak_dir, name)
    i = 2
    while os.path.exists(lp(target)):
        target = os.path.join(bak_dir, "%s.bak-%s-%d" % (os.path.basename(it.dst),
                                                         time.strftime("%H%M%S"), i))
        i += 1
    shutil.move(lp(src), lp(target))
    it.backup = target
    j.update(it, flush=True)


def _copy_item(it, plan, j, stop):
    opts = plan.opts
    tmp = it.dst + ".~mig-" + str(it.iid) + ".tmp"
    if os.path.exists(lp(tmp)):
        _force_rm(tmp)

    use_hash = opts.verify == "hash" or (opts.verify == "auto" and it.size <= HASH_LIMIT)
    sample = opts.verify == "auto" and it.size > HASH_LIMIT
    h = hashlib.blake2b(digest_size=16)
    written = 0

    try:
        with open(lp(it.src), "rb", buffering=0) as fi:
            with open(lp(tmp), "wb", buffering=0) as fo:
                while True:
                    if stop.is_set():
                        raise Cancelled()
                    buf = fi.read(CHUNK)
                    if not buf:
                        break
                    fo.write(buf)
                    written += len(buf)
                    if use_hash or sample:
                        h.update(buf)
                fo.flush()
                os.fsync(fo.fileno())
        st_before = os.stat(lp(it.src))
        _copy_attrs(it.src, tmp)
        st_after = os.stat(lp(it.src))
        if (st_before.st_size, st_before.st_mtime_ns) != (st_after.st_size, st_after.st_mtime_ns):
            raise OSError("源文件在复制过程中被修改，已放弃这一项")

        if opts.verify != "none":
            if os.path.getsize(lp(tmp)) != it.size:
                raise OSError("复制后大小不一致（%d != %d）"
                              % (os.path.getsize(lp(tmp)), it.size))
        if use_hash:
            src_digest = h.hexdigest()          # 复制时顺带算的源哈希
            dst_digest = digest_file(tmp)       # 回读目标再算一遍
            if src_digest != dst_digest:
                raise OSError("校验不一致：目标文件已删除，源文件未动")
            it.digest = src_digest
        elif sample:
            s_digest = digest_file(it.src, sample=True)
            d_digest = digest_file(tmp, sample=True)
            if s_digest != d_digest:
                raise OSError("抽样校验不一致：目标文件已删除，源文件未动")
            it.digest = "sample:" + s_digest

        if os.path.exists(lp(it.dst)):
            if opts.conflict == "skip":
                _force_rm(tmp)
                it.state = ST_SKIPPED
                return
            if opts.conflict == "overwrite" and not it.backup:
                _backup_existing(it, j)
            elif not it.backup:
                it.dst = _unique(it.dst, False)

        os.replace(lp(tmp), lp(it.dst))
        it.state = ST_DONE
        j.update(it, flush=True)          # 先落「已发布」，再删源
    except Exception:
        _force_rm(tmp)
        raise

    if opts.mode == "move" and plan.opts.mode == "move":
        _remove_source(it, plan, j)


def _remove_source(it, plan, j):
    src = it.src
    if not os.path.exists(lp(src)):
        return
    try:
        if plan.opts.delete_mode == "trash" and IS_WIN:
            to_trash([src])
        else:
            os.remove(lp(src))
    except OSError as ex:
        # 目标已经完整落地，源删不掉只是留了个副本：记为警告而不是失败
        it.error = "已迁移，但源文件删除失败：%s" % ex
        j.update(it, flush=True)


def _move_link(it, plan, j):
    """链接按原样搬：同卷直接改名，跨卷重建 junction。"""
    opts = plan.opts
    if opts.mode == "move" and not opts.force_copy and same_volume(it.src, it.dst):
        os.rename(lp(it.src), lp(it.dst))
        it.state = ST_DONE
        j.update(it, flush=True)
        return

    target = read_link(it.src)
    if not target:
        raise OSError("读不出链接指向：%s" % it.src)
    if os.path.isdir(it.src) and not os.path.islink(it.src):
        make_junction(it.dst, target)
    else:
        if not opts.follow_links:
            raise OSError("符号链接跨卷无法安全重建（%s）" % target)
        # 显式允许时才展开
        if os.path.isdir(it.src):
            shutil.copytree(lp(it.src), lp(it.dst), symlinks=False)
        else:
            shutil.copy2(lp(it.src), lp(it.dst))
    it.state = ST_DONE
    j.update(it, flush=True)
    if opts.mode == "move":
        try:
            if os.path.isdir(it.src) and not os.path.islink(it.src):
                os.rmdir(lp(it.src))
            else:
                os.remove(lp(it.src))
        except OSError:
            pass


def _cleanup_source(plan):
    """移动模式收尾：自底向上删掉已经空了的源目录。"""
    for root in plan.sources:
        if not os.path.isdir(root) or is_reparse(root):
            continue
        for dirpath, dirnames, filenames in os.walk(root, topdown=False):
            if is_reparse(dirpath):
                continue
            try:
                if not os.listdir(dirpath):
                    os.rmdir(dirpath)
            except OSError:
                pass


def to_trash(paths):
    """删除到回收站（可被用户还原）。"""
    if not IS_WIN:
        for p in paths:
            os.remove(p)
        return
    class SHFILEOPSTRUCTW(ctypes.Structure):
        _fields_ = [("hwnd", wt.HWND), ("wFunc", wt.UINT), ("pFrom", wt.LPCWSTR),
                    ("pTo", wt.LPCWSTR), ("fFlags", ctypes.c_ushort),
                    ("fAnyOperationsAborted", wt.BOOL), ("hNameMappings", ctypes.c_void_p),
                    ("lpszProgressTitle", wt.LPCWSTR)]

    buf = ("\0".join(paths) + "\0\0")
    op = SHFILEOPSTRUCTW()
    op.hwnd = None
    op.wFunc = 3                        # FO_DELETE
    op.pFrom = buf
    op.pTo = None
    op.fFlags = 0x40 | 0x10 | 0x4 | 0x400   # ALLOWUNDO | NOCONFIRMATION | SILENT | NOERRORUI
    shell32 = ctypes.WinDLL("shell32", use_last_error=True)
    shell32.SHFileOperationW.argtypes = [ctypes.POINTER(SHFILEOPSTRUCTW)]
    rc = shell32.SHFileOperationW(ctypes.byref(op))
    if rc != 0:
        raise OSError("移到回收站失败（错误码 %d）" % rc)


# ─────────────────────────── 撤销与复核 ───────────────────────────

def job_dir_of(jobs_dir, job_id):
    return os.path.join(jobs_dir, job_id)


def list_jobs(jobs_dir):
    if not os.path.isdir(jobs_dir):
        return []
    out = []
    for name in sorted(os.listdir(jobs_dir), reverse=True):
        p = os.path.join(jobs_dir, name, "journal.db")
        if not os.path.exists(p):
            continue
        try:
            db = sqlite3.connect(p)
            meta = dict(db.execute("SELECT k,v FROM meta").fetchall())
            rep = json.loads(meta.get("report") or "{}")
            db.close()
        except Exception:
            continue
        out.append({"job_id": name, "status": meta.get("status", "?"),
                    "started": meta.get("started", ""), "ended": meta.get("ended", ""),
                    "mode": meta.get("mode", ""), "dest": meta.get("dest", ""),
                    "done": rep.get("done", 0), "failed": rep.get("failed", 0)})
    return out


def undo_job(job_id, jobs_dir, progress=None, cancel=None):
    """把一次迁移整体退回。默认保守：目标位置已被改过就停下并报告。"""
    jd = job_dir_of(jobs_dir, job_id)
    plan_path = os.path.join(jd, "plan.json")
    jp = os.path.join(jd, "journal.db")
    if not os.path.exists(jp):
        raise FileNotFoundError("找不到任务：%s" % job_id)
    with open(plan_path, encoding="utf-8") as f:
        plan_d = json.load(f)
    opts = Options.from_dict(plan_d.get("opts") or {})
    j = Journal(jp)
    rows = j.items()
    done = [r for r in rows if r["state"] == ST_DONE]
    restored, failed = 0, []
    stop = cancel or threading.Event()
    total = len(done)

    for n, r in enumerate(reversed(done), 1):
        if stop.is_set():
            break
        if progress:
            try:
                progress(n, total, "回滚 %d/%d" % (n, total))
            except Exception:
                pass
        it = Item.from_dict({k: v for k, v in r.items()})
        it.volume_same = bool(it.volume_same)
        try:
            if it.kind == "dir":
                if opts.mode == "move" and not os.path.isdir(lp(it.src)):
                    os.makedirs(lp(it.src), exist_ok=True)
                    restored += 1
                continue
            if not os.path.exists(lp(it.dst)):
                continue
            if opts.mode == "copy":
                if not _digest_ok(it.dst, r.get("digest", "")):
                    failed.append((it.dst, "文件内容已变化，不敢删"))
                    continue
                _force_rm(it.dst)
                if it.backup and os.path.exists(lp(it.backup)):
                    os.replace(lp(it.backup), lp(it.dst))
                restored += 1
                continue
            if os.path.exists(lp(it.src)):
                failed.append((it.src, "原位置已被占用"))
                continue
            os.makedirs(os.path.dirname(lp(it.src)), exist_ok=True)
            _safe_move(it.dst, it.src)
            if it.backup and os.path.exists(lp(it.backup)):
                os.replace(lp(it.backup), lp(it.dst))
            restored += 1
        except OSError as ex:
            failed.append((it.src, str(ex)))

    for r in rows:
        if r.get("backup") and os.path.exists(lp(r["backup"])):
            try:
                if not os.path.exists(lp(r["dst"])):
                    os.replace(lp(r["backup"]), lp(r["dst"]))
            except OSError:
                pass

    # 清掉迁移时在目标侧建出来、现在已经空了的目录
    for r in sorted([x for x in rows if x["kind"] == "dir"],
                    key=lambda x: len(x["dst"]), reverse=True):
        try:
            if os.path.isdir(lp(r["dst"])) and not os.listdir(lp(r["dst"])):
                os.rmdir(lp(r["dst"]))
        except OSError:
            pass

    j.meta_set("status", "undone")
    j.close()
    return restored, failed


def _safe_move(src, dst):
    """回滚用：同卷直接改名，跨卷复制校验后再删，和正向迁移同一套纪律。"""
    if os.path.islink(src) or is_junction(src):
        target = read_link(src)
        if same_volume(src, dst) or not target:
            os.rename(lp(src), lp(dst))
        else:
            make_junction(dst, target)
            if os.path.isdir(src) and not os.path.islink(src):
                os.rmdir(lp(src))
            else:
                os.remove(lp(src))
        return

    if same_volume(src, dst):
        os.rename(lp(src), lp(dst))
        return

    tmp = dst + ".~undo.tmp"
    if os.path.exists(lp(tmp)):
        _force_rm(tmp)
    size = os.path.getsize(lp(src))
    try:
        with open(lp(src), "rb", buffering=0) as fi, open(lp(tmp), "wb", buffering=0) as fo:
            while True:
                buf = fi.read(CHUNK)
                if not buf:
                    break
                fo.write(buf)
            fo.flush()
            os.fsync(fo.fileno())
        _copy_attrs(src, tmp)
        if os.path.getsize(lp(tmp)) != size:
            raise OSError("回滚复制后大小不一致")
        if os.path.isdir(lp(src)):
            shutil.rmtree(lp(src))
        else:
            os.remove(lp(src))
        os.replace(lp(tmp), lp(dst))
    except Exception:
        _force_rm(tmp)
        raise


def _digest_ok(path, digest):
    if not digest:
        return True
    try:
        if digest.startswith("sample:"):
            return digest_file(path, sample=True) == digest[7:]
        return digest_file(path) == digest
    except OSError:
        return False


def verify_job(job_id, jobs_dir, progress=None):
    """复核：目标文件还在不在、大小与哈希对不对得上。"""
    jd = job_dir_of(jobs_dir, job_id)
    jp = os.path.join(jd, "journal.db")
    if not os.path.exists(jp):
        raise FileNotFoundError("找不到任务：%s" % job_id)
    j = Journal(jp)
    rows = [r for r in j.items() if r["state"] == ST_DONE and r["kind"] == "file"]
    bad, checked = [], 0
    for n, r in enumerate(rows, 1):
        if progress:
            try:
                progress(n, len(rows), "复核 %d/%d" % (n, len(rows)))
            except Exception:
                pass
        p = r["dst"]
        if not os.path.exists(lp(p)):
            bad.append((p, "目标不存在"))
            continue
        if os.path.getsize(lp(p)) != r["size"]:
            bad.append((p, "大小不符"))
            continue
        if r.get("digest") and not _digest_ok(p, r["digest"]):
            bad.append((p, "哈希不符"))
            continue
        checked += 1
    j.close()
    return checked, bad


# ─────────────────────────── 命令行 ───────────────────────────

def _default_jobs_dir():
    base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
    return os.path.join(base, "整理助手", "迁移")


def _parse(argv):
    """把 --to X 这种带值参数、纯开关、位置参数分开。"""
    takes = {"--to", "--conflict", "--verify", "--workers", "--jobs",
             "--undo", "--resume"}
    vals, flags, pos = {}, set(), []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a.startswith("--") and "=" in a:
            k, v = a.split("=", 1)
            vals[k] = v
            i += 1
        elif a in takes:
            vals[a] = argv[i + 1] if i + 1 < len(argv) else ""
            i += 2
        elif a.startswith("--"):
            flags.add(a)
            i += 1
        else:
            pos.append(a)
            i += 1
    return vals, flags, pos


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    vals, flags, pos = _parse(argv)
    jobs_dir = vals.get("--jobs") or _default_jobs_dir()

    if "--list" in flags:
        for j in list_jobs(jobs_dir):
            print("%s  %-5s  done=%-5s fail=%-4s  %s"
                  % (j["job_id"], j["mode"], j["done"], j["failed"], j["dest"]))
        return 0

    if vals.get("--undo"):
        n, failed = undo_job(vals["--undo"], jobs_dir, progress=_cli_progress)
        print("\n已回滚 %d 项" % n)
        for p, why in failed[:20]:
            print("  跳过 %s  %s" % (p, why))
        return 0 if not failed else 1

    if vals.get("--resume"):
        jid = vals["--resume"]
        jd = os.path.join(jobs_dir, jid)
        with open(os.path.join(jd, "plan.json"), encoding="utf-8") as f:
            d = json.load(f)
        plan = Plan(d["sources"], d["dest"], Options.from_dict(d["opts"]))
        plan.items = [Item.from_dict(x) for x in d["items"]]
        plan.bytes = sum(i.size for i in plan.items if i.kind == "file")
        plan.cross_volume = any(i.volume_same is False for i in plan.items)
        rep = execute(plan, jobs_dir, progress=_cli_progress, job_id=jid, resume=True)
        print("\n续跑完成 %d，失败 %d" % (rep.done, rep.failed))
        return 0 if rep.failed == 0 else 1

    dest = vals.get("--to")
    sources = pos
    if not dest or not sources:
        print(__doc__)
        return 2

    try:
        workers = int(vals.get("--workers") or 4)
    except ValueError:
        workers = 4
    opts = Options(
        mode="copy" if "--copy" in flags else "move",
        conflict=vals.get("--conflict") or "rename",
        verify=vals.get("--verify") or "auto",
        workers=workers,
        delete_mode="trash" if "--trash" in flags else "delete",
        follow_links="--follow-links" in flags,
    )
    plan = build_plan(sources, dest, opts)
    issues = preflight(plan)
    print("文件 %d，目录 %d，链接 %d，合计 %s；%s"
          % (plan.n_files, plan.n_dirs, plan.n_links, human(plan.bytes),
             "跨卷" if plan.cross_volume else "同卷"))
    for i in issues:
        print(" ", i)
    if any(i.level == "error" for i in issues):
        print("存在阻断项，未执行。")
        return 1
    if "--apply" not in flags:
        print("\n这是预演。确认无误后加 --apply 执行。")
        return 0

    rep = execute(plan, jobs_dir, progress=_cli_progress)
    print("\n完成 %d，跳过 %d，失败 %d，共 %s，用时 %.1fs"
          % (rep.done, rep.skipped, rep.failed, human(rep.bytes),
             rep.ended - rep.started))
    for f in rep.failures[:20]:
        print("  ! %s  %s" % (f["src"], f["error"]))
    print("任务号：%s（回滚：--undo %s）" % (rep.job_id, rep.job_id))
    return 0 if rep.failed == 0 else 1


def _cli_progress(done, total, msg=""):
    if total:
        sys.stdout.write("\r%5.1f%%  %s" % (done * 100.0 / total, msg[:60]))
        sys.stdout.write(" " * 12)
        sys.stdout.flush()


if __name__ == "__main__":
    sys.exit(main())
