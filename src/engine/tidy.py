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
    # ── 本地数据保留（只留最新，否则体积会一直长）──
    "prune_enabled": True,
    "prune_history_keep": 50,       # 整理历史留几份（撤销靠最近那条）
    "prune_thumbs_mb": 256,         # 缩略图总量上限（MB），0 = 不限制
    "prune_backup_keep": 3,         # 卸载备份留几份
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


# ---------------------------------------------------------------- 数据保留
# 用户原话：「索引库只保留最新版，不要有备份，包括其他的有较大缓存的功能
# 都做保留最新版数据，不然体积爆炸」。
#
# 先纠正一个前提：索引库本来就不留备份。_index_build_one 先写 <id>.db.new，
# 建完 os.replace 原子换上去，成功路径上没有第二份副本。实测数据目录里
# cache\indexes 只有两个 .db 和一份 catalog.json，没有 .new / -wal / -shm
# 残留。所以 101.9 MB 不是冗余，是 141 万文件的真实数据。
#
# 真正会无上限长的是另外五处：
#   history\      每整理一次写一条 json（撤销靠它），从来没有删过
#   logs\         app-<日期>.log（Rust 写）与 scan-<日期>.log（引擎写）
#   thumbs\       按内容哈希存缩略图，命中就复用，没有淘汰
#   卸载备份\      每次卸载导出注册表 + 拷一份程序数据，撞名只顺延编号
#   *.bak-<时间>  整理选「覆盖」时旧文件改名留下，迁移也会留
#
# 统一按「只留最新 N 份」处理，不按天。按天删在「一天整理两百次」和
# 「三个月整理一次」两种用法下体积差两个数量级；按份数才是真的封顶。

_PRUNE_DEFAULT = {
    "prune_enabled": True,
    "prune_history_keep": 50,     # 整理历史：撤销要用最近的那条，留 50 条够回溯很久
    "prune_thumbs_mb": 256,       # 缩略图：0 表示不限制
    "prune_backup_keep": 3,       # 卸载备份：每个程序留最近 3 次
    "prune_jobs_keep": 5,         # 迁移任务：每个任务都带一份 backup\，留最近 5 次
}

# 日志另有一套：设置里本来就有 log_keep_days（界面能改、能存、能读回来），
# 但全项目没有一处用它删过文件 —— 是个只存不用的键。这里让它真正生效，
# 而不是再并排加一个「保留几份」，那种并存才是最难查的。
_PRUNE_LOG_HARD_MAX = 60          # 无论多少天，文件数也不许超过这个


def _prune_logs_keep():
    """日志保留：先按 log_keep_days 算天数，再按份数封顶，两者取更严的。"""
    try:
        days = int(S.get("log_keep_days", 30))
    except (TypeError, ValueError):
        days = 30
    return max(1, min(days, 3650))


def _prune_cfg():
    """把设置里的保留策略读成干净的类型；坏值回默认，不让它炸掉整个清理。"""
    out = {}
    for key, default in _PRUNE_DEFAULT.items():
        raw = S.get(key, default)
        try:
            out[key] = bool(raw) if isinstance(default, bool) else int(raw)
        except (TypeError, ValueError):
            out[key] = default
    if out["prune_history_keep"] < 0:
        out["prune_history_keep"] = _PRUNE_DEFAULT["prune_history_keep"]
    if out["prune_thumbs_mb"] < 0:
        out["prune_thumbs_mb"] = 0
    if out["prune_backup_keep"] < 0:
        out["prune_backup_keep"] = 0
    if out["prune_jobs_keep"] < 0:
        out["prune_jobs_keep"] = 0
    return out


def _prune_stat(p):
    try:
        st = os.stat(p)
        return st.st_mtime, st.st_size
    except OSError:
        return 0.0, 0


def _prune_keep_newest(folder, keep, pattern=None, dirs_only=False, protect=None):
    """只留最新的 keep 份，返回 (删掉几个, 释放多少字节)。

    最新的判据是 mtime，不是文件名：日志和历史都是「_<时间戳>」结尾，
    但重名顺延的后缀会让字典序和时间序在跨天时错位，用 mtime 更稳。

    protect 是个回调：给它路径，返回 True 就跳过不删。用来保护「还在跑」
    的东西（比如状态还是 pending 的迁移任务）—— 那些不是旧数据，是活数据。

    删不掉的（被占用、权限）直接跳过，不抛异常 —— 清理是维护动作，
    不该因为一个文件删不掉就把整次整理/保存搞失败。
    """
    if keep < 0 or not os.path.isdir(folder):
        return 0, 0
    rows = []
    try:
        with os.scandir(folder) as it:
            for e in it:
                try:
                    if dirs_only and not e.is_dir():
                        continue
                    if not dirs_only and not e.is_file():
                        continue
                    if pattern and not re.search(pattern, e.name):
                        continue
                    mt, size = _prune_stat(e.path)
                    rows.append((mt, e.path, size))
                except OSError:
                    continue
    except OSError:
        return 0, 0
    rows.sort(key=lambda r: r[0], reverse=True)
    gone = freed = 0
    for _mt, path, size in rows[max(0, keep):]:
        if protect is not None:
            try:
                if protect(path):
                    continue
            except Exception:
                continue
        try:
            if os.path.isdir(path):
                shutil.rmtree(path)
            else:
                os.remove(path)
            gone += 1
            freed += size
        except OSError:
            continue
    return gone, freed


def _mig_job_busy(job_path):
    r"""迁移任务是不是还在跑。读 journal.db 的 status，pending 就不许删。

    读不出来（没有 journal.db、库坏了、被占用）返回 False —— 那说明它不像
    一个活任务；留着也不会被撤销用上，删掉才是对的。

    这条路径上必然是「整理助手数据\迁移\<job>\journal.db」这种带中文的路径，
    所以这里用普通 connect 而不是 file:...?mode=ro 的 URI（URI 形式带非 ASCII
    会连不上，于是每个任务都被判成「不忙」，正在跑的那个照样被清掉）。
    """
    try:
        import sqlite3          # 顶层没有模块级导入，这里必须自带
        db_path = os.path.join(job_path, "journal.db")
        if not os.path.isfile(db_path):
            return False
        db = sqlite3.connect(db_path)
        try:
            row = db.execute("SELECT v FROM meta WHERE k='status'").fetchone()
        finally:
            db.close()
        return (row[0] if row else "") == "pending"
    except Exception:
        return False


def _prune_bak_siblings(path):
    """同一个原文件只留最新一份 .bak-<时间戳>，返回删掉几个。

    这些 .bak 是我们自己在「覆盖」和「迁移」时留下的，属于同一个原文件的
    旧副本。留着三份八个版本没有意义 —— 要的就是「只保留最新版」。
    只在同一目录、同一主名、且严格匹配我们自己生成的命名时才动，
    绝不按通配符扫用户目录。

    path 既可以是刚生成的那个 .bak（resolve_dst 的用法），也可以是原文件
    （批量收的时候按原文件找）。所以判据是「这组 .bak 里按 mtime 最新那份
    留下」，不是「除了 path 之外都删」—— 后者在传原文件时会把三份新备份
    一起删光，那正好把用户刚被覆盖的文件扔掉。
    """
    folder = os.path.dirname(path) or "."
    base, ext = os.path.splitext(os.path.basename(path))
    pat = r"^%s\.bak-\d{8,14}" % re.escape(base)
    ext_re = re.escape(ext) + "$" if ext else "$"
    rows = []
    try:
        with os.scandir(folder) as it:
            for e in it:
                try:
                    if not e.is_file():
                        continue
                    if not re.search(pat + ext_re, e.name):
                        continue
                    rows.append((e.stat().st_mtime, e.path))
                except OSError:
                    continue
    except OSError:
        return 0
    if len(rows) <= 1:
        return 0
    rows.sort(key=lambda r: r[0], reverse=True)
    gone = 0
    for _mt, p in rows[1:]:
        try:
            os.remove(p)
            gone += 1
        except OSError:
            continue
    return gone


def prune_data_dir(dry_run=False):
    """把几处会无上限长的本地数据收成「只留最新」。

    dry_run=True 只报不删（设置页预览用）。返回每个目标的
    {files, bytes, kept, note}，方便界面上说清「清理了什么」。
    """
    cfg = _prune_cfg()
    report = {"enabled": cfg["prune_enabled"], "dry_run": bool(dry_run),
              "items": {}, "files": 0, "bytes": 0}
    if not cfg["prune_enabled"]:
        report["note"] = "数据保留已关闭，什么都没动"
        return report

    def one(name, folder, keep, pattern=None, dirs_only=False, note="", protect=None):
        if dry_run:
            # 预演：只数会被删的份数，不碰磁盘
            rows = []
            if os.path.isdir(folder):
                try:
                    with os.scandir(folder) as it:
                        for e in it:
                            if dirs_only and not e.is_dir():
                                continue
                            if not dirs_only and not e.is_file():
                                continue
                            if pattern and not re.search(pattern, e.name):
                                continue
                            mt, size = _prune_stat(e.path)
                            rows.append((mt, e.path, size))
                except OSError:
                    pass
            rows.sort(key=lambda r: r[0], reverse=True)
            tail = rows[max(0, keep):]
            if protect is not None:
                kept = []
                for _m, p, s in tail:
                    try:
                        if protect(p):
                            continue
                    except Exception:
                        continue
                    kept.append(s)
                tail = [(0, "", s) for s in kept]
            gone, freed = len(tail), sum(s for _m, _p, s in tail)
        else:
            gone, freed = _prune_keep_newest(folder, keep, pattern, dirs_only, protect)
        report["items"][name] = {"files": gone, "bytes": freed,
                                 "kept": keep, "path": folder, "note": note}
        report["files"] += gone
        report["bytes"] += freed

    one("history", hist_dir(), cfg["prune_history_keep"], r"\.json$",
        note="整理历史，撤销靠最近那条")
    one("logs", log_dir(), min(_prune_logs_keep(), _PRUNE_LOG_HARD_MAX), r"\.log$",
        note="按天写的运行日志（受 log_keep_days 控制，最多 %d 份）" % _PRUNE_LOG_HARD_MAX)
    one("backup", backup_dir(), cfg["prune_backup_keep"], dirs_only=True,
        note="卸载程序前的注册表与数据备份")
    # 迁移任务目录：每个任务一个子目录，里面是 journal.db 加一份 backup\（被覆盖
    # 的旧目标都挪在那儿）。任务本身只在撤销时要，但 backup\ 会一直占着体积，
    # 所以这里按「任务数」封顶，最旧的整套一起清。
    #
    # 必须护住正在跑的那个：它 mtime 也许不是最新（大任务跑很久），按 mtime
    # 排序完全可能把它排到末尾删掉 —— 那等于把用户正在搬的文件的操作记录
    # 扔了，撤销和续跑都没了。状态还是 pending 的一律不碰。
    one("migrate", mig_jobs_dir(), cfg["prune_jobs_keep"], dirs_only=True,
        note="迁移任务与它的备份区（已完成的）", protect=_mig_job_busy)

    # 缩略图按总体积封顶，超了就从最旧的开始删到上限以内。
    cap = cfg["prune_thumbs_mb"] * 1024 * 1024
    folder = os.path.join(data_dir(), "thumbs")
    t_files = t_bytes = 0
    if cap > 0 and os.path.isdir(folder):
        rows = []
        try:
            with os.scandir(folder) as it:
                for e in it:
                    if not e.is_file():
                        continue
                    mt, size = _prune_stat(e.path)
                    rows.append((mt, e.path, size))
        except OSError:
            rows = []
        total = sum(r[2] for r in rows)
        if total > cap:
            rows.sort(key=lambda r: r[0])          # 最旧的先删
            for _mt, path, size in rows:
                if total <= cap:
                    break
                if dry_run:
                    t_files += 1
                    t_bytes += size
                    total -= size
                    continue
                try:
                    os.remove(path)
                    t_files += 1
                    t_bytes += size
                    total -= size
                except OSError:
                    continue
    report["items"]["thumbs"] = {"files": t_files, "bytes": t_bytes,
                                 "kept": cfg["prune_thumbs_mb"],
                                 "path": folder, "note": "缩略图缓存，超上限按最旧淘汰"}
    report["files"] += t_files
    report["bytes"] += t_bytes

    # WebView2 的旧数据目录：正常情况下一份就够（主进程把
    # WEBVIEW2_USER_DATA_FOLDER 固定指到 <data>\webview）。带 .bak- 的那些
    # 是改了数据目录或者手工改名时留下的整份副本，一份十几 MB 却永远不会
    # 再被打开。只在「正主还在」时清 —— 正主不在说明这份可能就是唯一的数据，
    # 那时候删它就是删用户的书签和登录态。
    live = os.path.join(data_dir(), "webview")
    w_files = w_bytes = 0
    if os.path.isdir(live):
        try:
            with os.scandir(data_dir()) as it:
                for e in it:
                    if not e.is_dir():
                        continue
                    if not re.search(r"^webview\.bak-\d", e.name, re.I):
                        continue
                    size = 0
                    for r, _ds, fs in os.walk(e.path):
                        for f in fs:
                            try:
                                size += os.path.getsize(os.path.join(r, f))
                            except OSError:
                                pass
                    if dry_run:
                        w_files += 1
                        w_bytes += size
                        continue
                    try:
                        shutil.rmtree(e.path)
                        w_files += 1
                        w_bytes += size
                    except OSError:
                        continue
        except OSError:
            pass
    report["items"]["webview_bak"] = {"files": w_files, "bytes": w_bytes, "kept": 1,
                                      "path": data_dir(),
                                      "note": "WebView2 旧数据目录，正主在线才清"}
    report["files"] += w_files
    report["bytes"] += w_bytes

    ix_files, ix_bytes, ix_kept = _ix_prune_orphan_files(dry_run=dry_run)
    report["items"]["index"] = {"files": ix_files, "bytes": ix_bytes, "kept": ix_kept,
                                "path": index_dir(),
                                "note": "搜索索引库，只保留当前有效目录的最新版本"}
    report["files"] += ix_files
    report["bytes"] += ix_bytes
    return report


# 保留策略不需要每次写文件都跑一遍：这些目录的规模变化是「每天几条」的量级。
# 一小时至多扫一次，扫的是几十个文件名的 stat，成本可以忽略；但省掉的是
# 每次整理都去 scandir 四个目录。
_PRUNE_LAST = {"at": 0.0}
_PRUNE_EVERY = 3600.0


def prune_maybe(force=False):
    """节流版的 prune_data_dir：写点顺手调它，不阻塞主流程。

    任何异常都吞掉 —— 清理失败不该让用户的整理/截图/卸载失败。
    """
    now = time.time()
    if not force and now - _PRUNE_LAST["at"] < _PRUNE_EVERY:
        return None
    _PRUNE_LAST["at"] = now
    try:
        return prune_data_dir()
    except Exception:
        return None


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


_APP_DIR_CACHE = {}


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
        norm_key = (os.path.normcase(os.path.abspath(folder)), id(rules), limit)
        if norm_key in _APP_DIR_CACHE:
            return _APP_DIR_CACHE[norm_key]
        if len(_APP_DIR_CACHE) > 4096:
            _APP_DIR_CACHE.clear()
    except Exception:
        norm_key = None

    try:
        with os.scandir(folder) as it:
            entries = []
            for e in it:
                entries.append(e)
                if len(entries) >= (limit or rules.app_scan_max):
                    break
    except OSError:
        if norm_key is not None:
            _APP_DIR_CACHE[norm_key] = (False, [])
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
    res = (bool(ev), ev)
    if norm_key is not None:
        _APP_DIR_CACHE[norm_key] = res
    return res


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


_PDF_READER = None  # None: 未检测, False: 不可用, class: 可用
_DOCX_MODULE = None  # None: 未检测, False: 不可用, module: 可用


def _get_pdf_reader():
    global _PDF_READER
    if _PDF_READER is None:
        try:
            from pypdf import PdfReader
            _PDF_READER = PdfReader
        except Exception:
            _PDF_READER = False
    return _PDF_READER


def _get_docx_module():
    global _DOCX_MODULE
    if _DOCX_MODULE is None:
        try:
            import docx
            _DOCX_MODULE = docx
        except Exception:
            _DOCX_MODULE = False
    return _DOCX_MODULE


def extract_text(path, ext, max_chars):
    """读文件正文。失败一律返回空串，绝不让异常影响整理。"""
    try:
        if ext == ".pdf":
            PdfReader = _get_pdf_reader()
            if not PdfReader:
                return ""
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
            docx = _get_docx_module()
            if not docx:
                return ""
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
    _APP_DIR_CACHE.clear()
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
        bak = backup_name(dst)
        os.replace(dst, bak)     # 旧文件改名备份，不删除
        # 同一个原文件只留这一份 .bak：之前几次「覆盖」留下的旧副本一起收掉。
        # 用户原话是「只保留最新版」，而三份八个版本的 .bak 谁也说不清哪个是哪个。
        _prune_bak_siblings(bak)
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
    # 整理是历史记录增长最快的来源（每整理一次一条），顺手按保留策略收一次。
    # 节流到一小时一次，正常使用下这里绝大多数时候什么都不做。
    prune_maybe()
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
                            raw_idate = str(g("InstallDate") or "").strip()
                            idate = ""
                            if len(raw_idate) == 8 and raw_idate.isdigit():
                                idate = f"{raw_idate[:4]}-{raw_idate[4:6]}-{raw_idate[6:]}"
                            elif raw_idate:
                                idate = raw_idate
                            mtime = _reg_key_mtime(ck)
                            if not idate and mtime > 0:
                                try:
                                    import datetime
                                    idate = datetime.date.fromtimestamp(mtime).isoformat()
                                except Exception:
                                    idate = ""
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
                                "date": mtime,
                                "install_date": idate,
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
    if len(parts) < 2:
        return False
    if parts[0] != "software":
        return False
    # 特例：只允许删「某个程序自己的 Uninstall 登记项」，不允许删 Uninstall 根
    uninst_root = ["software", "microsoft", "windows", "currentversion", "uninstall"]
    if parts[:5] == uninst_root and len(parts) > 5:
        return True
    # 以下这些系统/通用厂商根键在顶层或受保护分支一律不碰
    if parts[1] in ("microsoft", "windows", "classes", "policies",
                    "registeredapplications", "clients", "wow6432node"):
        return False
    if len(parts) == 2 and parts[1] in (
        "google", "mozilla", "adobe", "oracle", "intel", "amd", "nvidia",
        "realtek", "valve", "python", "jetbrains", "gnu", "odbc",
        "tencent", "alibaba", "netease", "baidu", "bytedance", "kingsoft",
        "360safe", "qihoo", "apple", "steam",
    ):
        return False
    if parts[-1] in {"clsid", "system", "currentcontrolset", "services",
                     "run", "runonce"}:
        return False
    return True


_APP_LEFTOVER_ALIASES = {
    "鲁大师": ("ludashi", "computerz", "360ludashi"),
    "ludashi": ("鲁大师", "computerz", "360ludashi"),
    "微信": ("wechat", "weixin"),
    "wechat": ("微信", "weixin"),
    "weixin": ("微信", "wechat"),
    "企业微信": ("wxwork", "wecom"),
    "qq": ("qq", "qqnt"),
    "钉钉": ("dingtalk", "dingding"),
    "飞书": ("feishu", "lark"),
    "网易云音乐": ("cloudmusic",),
    "百度网盘": ("baidunetdisk",),
    "迅雷": ("thunder", "xunlei"),
    "搜狗输入法": ("sogouinput", "sogou"),
    "搜狗高速浏览器": ("sogouexplorer",),
    "火绒": ("huorong", "sysdiag"),
    "火绒安全软件": ("huorong", "sysdiag"),
    "向日葵": ("sunlogin", "sunloginclient", "oray"),
    "向日葵远程控制": ("sunlogin", "sunloginclient"),
    "剪映": ("jianyingpro", "capcut"),
    "wps": ("wpsoffice",),
    "wpsoffice": ("wps", "kingsoft"),
    "bandizip": ("bandizip", "bandisoft"),
    "potplayer": ("potplayer", "daum"),
    "7zip": ("7zip", "7-zip"),
    "豆包": ("doubao",),
    "元宝": ("yuanbao",),
}

_GENERIC_FOLDER_STOP = frozenset({
    "bin", "app", "apps", "client", "program", "programs", "programfiles",
    "windows", "system32", "data", "common", "files", "setup", "install",
    "release", "dist", "x64", "x86", "temp", "tmp", "user", "users",
})

_VER_SUFFIX_RE = re.compile(
    r"(?:\s*\((?:x86|x64|64-?bit|32-?bit|64位|32位|en-?us|zh-?cn|简体中文)\)"
    r"|\s*\[(?:x86|x64|64-?bit|32-?bit)\]"
    r"|\s+[-_vV]?\d+(?:\.\d+)+(?:[-._a-zA-Z0-9]*)?"
    r"|\s+(?:x64|x86|64-?bit|32-?bit|64位|32位))+$",
    re.IGNORECASE,
)


def _norm(s):
    return re.sub(r"[\s\-_()（）\[\]·.]", "", (s or "").lower())


def _app_leftover_tokens(app):
    """提取用于残留匹配的规范化标识集合与厂商二级目录标识。"""
    raw = re.sub(r'[\\/:*?"<>|]', "", app.get("name") or "").strip()
    tokens = set()
    raw_norm = _norm(raw)
    if len(raw_norm) >= 2 and raw_norm not in _GENERIC_FOLDER_STOP:
        tokens.add(raw_norm)
    stem = _VER_SUFFIX_RE.sub("", raw).strip()
    stem_norm = _norm(stem)
    if len(stem_norm) >= 3 and stem_norm not in _GENERIC_FOLDER_STOP:
        tokens.add(stem_norm)
    loc = (app.get("location") or "").strip()
    if loc:
        leaf = _norm(os.path.basename(os.path.normpath(loc)))
        if len(leaf) >= 3 and leaf not in _GENERIC_FOLDER_STOP:
            tokens.add(leaf)
    for key in list(tokens):
        for alias in _APP_LEFTOVER_ALIASES.get(key, ()):
            na = _norm(alias)
            if len(na) >= 2:
                tokens.add(na)
    vendor_tokens = set()
    pub = _norm(app.get("publisher") or "")
    if len(pub) >= 3 and pub not in _GENERIC_FOLDER_STOP:
        vendor_tokens.add(pub)
    for vt in ("tencent", "kingsoft", "netease", "baidu", "bytedance", "oray",
               "bandisoft", "daum", "360", "qihoo"):
        if vt in tokens:
            vendor_tokens.add(vt)
    return tokens, vendor_tokens


def scan_leftovers(app):
    """扫描残留：目录 + 注册表键（兼容已卸载/孤立残留、中英文别名与版本号变体）"""
    tokens, vendor_tokens = _app_leftover_tokens(app)
    if not tokens:
        return [], []

    cand_dirs = []
    loc = (app.get("location") or "").strip()
    if loc and os.path.isdir(loc):
        cand_dirs.append(loc)

    user_profile = os.environ.get("USERPROFILE", "")
    local_low = os.path.join(user_profile, "AppData", "LocalLow") if user_profile else ""
    bases = [
        os.environ.get("ProgramFiles"),
        os.environ.get("ProgramFiles(x86)"),
        os.environ.get("ProgramData"),
        os.environ.get("LOCALAPPDATA"),
        os.environ.get("APPDATA"),
        local_low,
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs"),
    ]
    for base in bases:
        if not base or not os.path.isdir(base):
            continue
        try:
            for entry in os.scandir(base):
                if not entry.is_dir(follow_symlinks=False):
                    continue
                ne = _norm(entry.name)
                if ne in tokens:
                    cand_dirs.append(entry.path)
                elif ne in vendor_tokens:
                    try:
                        for sub in os.scandir(entry.path):
                            if sub.is_dir(follow_symlinks=False) and _norm(sub.name) in tokens:
                                cand_dirs.append(sub.path)
                    except OSError:
                        pass
        except OSError:
            pass

    dirs = []
    for d in dict.fromkeys(cand_dirs):
        if _safe_dir(d):
            dirs.append(d)

    import winreg
    regs = []
    key_app = (app.get("key") or "").strip()
    hive_app = (app.get("hive") or "").strip()
    if key_app and hive_app and _safe_reg_key(hive_app, key_app):
        try:
            with winreg.OpenKey(_hive_root(hive_app), key_app, 0,
                                winreg.KEY_READ | _flag(hive_app)):
                regs.append((hive_app, key_app))
        except OSError:
            pass

    for hive_name in ("HKLM64", "HKLM32", "HKCU"):
        hive = _hive_root(hive_name)
        flag = _flag(hive_name)
        try:
            with winreg.OpenKey(hive, "SOFTWARE", 0, winreg.KEY_READ | flag) as bk:
                n = winreg.QueryInfoKey(bk)[0]
                for i in range(n):
                    try:
                        sub = winreg.EnumKey(bk, i)
                    except OSError:
                        continue
                    ns = _norm(sub)
                    full = "SOFTWARE\\" + sub
                    if ns in tokens and _safe_reg_key(hive_name, full):
                        regs.append((hive_name, full))
                    elif ns in vendor_tokens:
                        try:
                            with winreg.OpenKey(bk, sub, 0, winreg.KEY_READ | flag) as vk:
                                vn = winreg.QueryInfoKey(vk)[0]
                                for j in range(vn):
                                    try:
                                        vsub = winreg.EnumKey(vk, j)
                                    except OSError:
                                        continue
                                    vfull = full + "\\" + vsub
                                    if _norm(vsub) in tokens and _safe_reg_key(hive_name, vfull):
                                        regs.append((hive_name, vfull))
                        except OSError:
                            pass
        except OSError:
            pass
        # 排查遗留在 Uninstall 下的孤立子键
        uninst = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall"
        try:
            with winreg.OpenKey(hive, uninst, 0, winreg.KEY_READ | flag) as uk:
                n = winreg.QueryInfoKey(uk)[0]
                for i in range(n):
                    try:
                        sub = winreg.EnumKey(uk, i)
                    except OSError:
                        continue
                    if _norm(sub) in tokens or _norm(_VER_SUFFIX_RE.sub("", sub)) in tokens:
                        ufull = uninst + "\\" + sub
                        if _safe_reg_key(hive_name, ufull):
                            regs.append((hive_name, ufull))
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
        # 删旧文件块必须走 rowid 区间，不能 `DELETE ... WHERE dir_id = ?`：
        # files 表上**故意没有** dir_id 索引（见建表处注释，一个目录的文件
        # 是连续插入的，dirs.f0/n 记着这段行号区间），所以按 dir_id 删就是
        # 全表扫。实测 E:\下载 216 个目录、82 万行的库，逐目录全表扫要 8,409
        # 毫秒；换成 rowid 区间后是个位数毫秒。
        blk = db.execute(
            "SELECT f0, n FROM dirs WHERE id = ?", (did,)).fetchone()
        if blk and blk[1]:
            db.execute("DELETE FROM files WHERE rowid BETWEEN ? AND ?",
                       (int(blk[0]), int(blk[0]) + int(blk[1]) - 1))
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


def _ix_refresh_subtree(db, folder):
    """把一个已经在索引里的目录子树，按磁盘现值重扫一遍（不新增索引根）。

    为什么要单独有这么一个函数，而不是直接 build_index(roots=[folder])：
    build_index 的 roots 分支会先 index_add(folder) 把它**登记成一个新的
    索引根**。对「整盘 D:\\ 已索引」的用户，刷新 D:\\下载 时那样一来索引
    清单里就多了一条 D:\\下载 —— 范围被悄悄改了，占用排行也跟着变，而
    用户从没同意过。保鲜必须只改库里的行，不改清单。

    做法：整棵走一遍（热目录都很小，实测 D:\\下载 6 个目录 30 个文件
    22 毫秒、E:\\下载 216 个目录 2741 个文件 34 毫秒），把扫到的目录逐个
    upsert；再把库里「在 folder 这个前缀下、但磁盘上已经没有」的目录行清掉
    —— 只做前一半的话，删掉的文件夹会永远留在排行里。

    返回 (目录数, 文件数)。
    """
    folder = os.path.abspath(str(folder or ""))
    if not folder or not os.path.isdir(folder):
        return 0, 0
    prefix = folder.rstrip("\\/") + os.sep
    seen_dirs = []
    stack = [folder]
    while stack:
        cur = stack.pop()
        try:
            with os.scandir(cur) as it:
                entries = list(it)
        except OSError:
            # 权限不够 / 刚被删：跳过这一层，别让整棵刷新失败
            continue
        seen_dirs.append(cur)
        try:
            _ix_refresh_dir(db, cur)
        except Exception:
            pass
        for e in entries:
            try:
                if not e.is_dir(follow_symlinks=False):
                    continue
                # 和建库时同一套跳过规则，否则刷新会把建库特意跳过的
                # node_modules / .git 之类又塞回索引里
                if e.name.lower() in INDEX_SKIP or e.name.startswith("$"):
                    continue
            except OSError:
                continue
            stack.append(e.path)
    # 清掉磁盘上已经不存在的旧目录行
    try:
        rows = db.execute(
            "SELECT path FROM dirs WHERE path = ? OR path LIKE ? ESCAPE '\\'",
            (folder, _like_literal(prefix) + "%")).fetchall()
    except Exception:
        rows = []
    seen_keys = {os.path.normcase(p) for p in seen_dirs}
    for (path,) in rows:
        if os.path.normcase(path) not in seen_keys:
            try:
                db.execute("DELETE FROM files WHERE dir_id IN"
                           " (SELECT id FROM dirs WHERE path = ?)", (path,))
                db.execute("DELETE FROM dirs WHERE path = ?", (path,))
            except Exception:
                continue
    total = 0
    try:
        total = int(db.execute(
            "SELECT COALESCE(SUM(n_files), 0) FROM dirs WHERE path = ? OR"
            " path LIKE ? ESCAPE '\\'",
            (folder, _like_literal(prefix) + "%")).fetchone()[0] or 0)
    except Exception:
        total = 0
    return len(seen_dirs), total


def _ix_sync_item_totals(item_id, db):
    """原地刷完索引库后，把最新的 files/dirs/bytes/built_at 同步回 meta 与 catalog.json。"""
    now_ts = int(time.time())
    try:
        row = db.execute(
            "SELECT COUNT(*), COALESCE(SUM(n_files), 0) FROM dirs").fetchone()
        d_cnt = int((row[0] if row else 0) or 0)
        f_cnt = int((row[1] if row else 0) or 0)
        with db:
            db.execute("INSERT OR REPLACE INTO meta(k,v) VALUES('built_at', ?)",
                       (str(now_ts),))
    except Exception:
        return
    with _IX_LOCK:
        items = _ix_load()
        changed = False
        for it in items:
            if it.get("id") != item_id:
                continue
            try:
                b = os.path.getsize(_ix_db_abspath(it))
            except OSError:
                b = int(it.get("bytes") or 0)
            it.update({
                "files": f_cnt,
                "dirs": d_cnt,
                "bytes": int(b),
                "built_at": now_ts,
                "why": "",
            })
            changed = True
        if changed:
            _ix_save(items)


def _ix_find_dirty_subtrees(db, root, skip_norm=None, max_dirs=25):
    """浅层发现根目录及直系子目录的新增/变更/删除（即使不在下载夹内也能静默覆写最新索引）。"""
    root = os.path.abspath(str(root or ""))
    if not root or not os.path.isdir(root):
        return 0, 0
    skip_set = set(skip_norm or ())
    touched_dirs = 0
    try:
        with os.scandir(root) as it:
            entries = list(it)
    except OSError:
        return 0, 0

    # 1) 检查根目录直属文件是否变化
    direct_files = 0
    disk_subs = {}
    for e in entries:
        try:
            if e.is_dir(follow_symlinks=False):
                if e.name.lower() in INDEX_SKIP or e.name.startswith("$"):
                    continue
                ap = os.path.abspath(e.path)
                st = e.stat(follow_symlinks=False)
                disk_subs[os.path.normcase(ap)] = (ap, float(st.st_mtime or 0))
            else:
                direct_files += 1
        except OSError:
            continue

    try:
        r_stat = float(os.stat(root).st_mtime or 0)
        r_row = db.execute(
            "SELECT mtime, n_files FROM dirs WHERE path = ?", (root,)).fetchone()
        if (r_row is None or int(r_row[1] or 0) != direct_files
                or abs(float(r_row[0] or 0) - r_stat) > 1.0):
            if _ix_refresh_dir(db, root):
                touched_dirs += 1
    except Exception:
        pass

    # 2) 比对深度 1 子目录：新增未收录、mtime 变更、已删除
    prefix = root.rstrip("\\/") + os.sep
    try:
        db_rows = db.execute(
            "SELECT path, mtime FROM dirs WHERE path LIKE ? ESCAPE '\\'"
            " AND path NOT LIKE ? ESCAPE '\\'",
            (_like_literal(prefix) + "%", _like_literal(prefix) + "%\\\\%")
        ).fetchall()
    except Exception:
        db_rows = []
    db_subs = {}
    for p, mt in db_rows:
        db_subs[os.path.normcase(os.path.abspath(p))] = (p, float(mt or 0))

    for k, (old_p, _mt) in db_subs.items():
        if k not in disk_subs and not os.path.isdir(old_p):
            touched_dirs += _ix_drop_subtree(db, old_p)

    dirty = []
    for k, (ap, mt) in disk_subs.items():
        if k in skip_set:
            continue
        old = db_subs.get(k)
        if old is None or abs(mt - old[1]) > 1.0:
            dirty.append((mt, ap))

    dirty.sort(key=lambda x: x[0], reverse=True)
    for _mt, ap in dirty[:max(1, int(max_dirs or 25))]:
        d, _f = _ix_refresh_subtree(db, ap)
        touched_dirs += d

    total_files = 0
    try:
        total_files = int(db.execute(
            "SELECT COALESCE(SUM(n_files), 0) FROM dirs").fetchone()[0] or 0)
    except Exception:
        pass
    return touched_dirs, total_files


def _ix_prune_orphan_files(dry_run=False):
    """清理过期/孤儿索引库与半成品 staging，仅保留每个有效索引根的最新版 .db。"""
    d = index_dir()
    if not os.path.isdir(d):
        return 0, 0, 0
    locked = _HOT_LOCK.acquire(blocking=False)
    try:
        with _IX_LOCK:
            items = _ix_load()
            best = {}
            order = []
            for it in items:
                try:
                    k = os.path.normcase(os.path.abspath(it.get("root") or ""))
                except (OSError, ValueError):
                    continue
                if not k:
                    continue
                score = (int(it.get("built_at") or 0), int(it.get("files") or 0))
                if k not in best:
                    best[k] = (score, it)
                    order.append(k)
                elif score >= best[k][0]:
                    best[k] = (score, it)
            dedup = [best[k][1] for k in order]
            if not dry_run and len(dedup) != len(items):
                _ix_save(dedup)
            active = {os.path.basename(_ix_db_abspath(it)).lower() for it in dedup}
            keep_names = active | {"catalog.json"}
            # 已激活主库的伴随 WAL/SHM 也放行，免得把正在用的库事务拆坏
            for name in list(active):
                keep_names.update({name + "-wal", name + "-shm", name + "-journal"})

        gone = 0
        freed = 0
        try:
            with os.scandir(d) as it:
                for e in it:
                    if not e.is_file(follow_symlinks=False):
                        continue
                    ln = e.name.lower()
                    if ln in keep_names:
                        continue
                    # 后台热路径未拿到锁时不碰正在写入的 .new 文件
                    if not locked and ln.endswith(".new"):
                        continue
                    if not (ln.endswith(".db") or ".db." in ln or ln.endswith(("-wal", "-shm", "-journal"))):
                        continue
                    try:
                        sz = int(e.stat(follow_symlinks=False).st_size or 0)
                    except OSError:
                        sz = 0
                    if not dry_run:
                        try:
                            os.remove(e.path)
                        except OSError:
                            continue
                    gone += 1
                    freed += sz
        except OSError:
            pass
        return gone, freed, len(dedup)
    finally:
        if locked:
            _HOT_LOCK.release()


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
            if touched:
                _ix_sync_item_totals(item["id"], db)
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
    except OSError as exc:
        # Windows 上 os.replace 到「已经被人打开的目标文件」会失败：WinError 5
        # 拒绝访问。实测确认过：另一个连接还开着 target.db 时，replace 抛
        # PermissionError。
        #
        # 读的那一头通常只持有几十毫秒（一次查询、一次抽查），所以先重试几次
        # 再认输 —— 让一次瞬时读取把整次建库判死，是最不合算的失败。
        for delay in (0.05, 0.1, 0.2, 0.4, 0.8, 1.2):
            time.sleep(delay)
            try:
                os.replace(staging, target)
                break
            except OSError as exc2:
                exc = exc2
        else:
            for suffix in ("", "-journal", "-wal", "-shm"):
                try:
                    os.remove(staging + suffix)
                except OSError:
                    pass
            raise RuntimeError("索引写入失败：目标库被占用（%s）" % (exc,))

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

    整段拿 _HOT_LOCK：它和 hot_refresh 写的是同一批 *.db staging 文件。后台
    watchdog 线程可能在做 hot_refresh（只刷子树），主线程同时在跑这里的全量
    重建 —— 两边都会对同一个 `<id>.db.new` 动手，一个正在写、另一个把它删了
    重建，最后 replace 上去的就是半个库。_HOT_LOCK 是 RLock，hot_refresh 里
    再调进来也不会死锁。
    """
    with _HOT_LOCK:
        return _build_index_locked(roots, ids, progress, full)


def _build_index_locked(roots, ids, progress, full):
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
            # 建库失败时不能把 files/dirs 清零。原来这里写 0，含义是「这个根
            # 里没东西」—— 那会让占用排行、保鲜规模判断、配额统计全部当真。
            # 一次被占用的库文件（WinError 5）就能把用户 82 万文件的索引在
            # 清单里改成 0 条，而磁盘上一个字节都没变。
            #
            # 失败就是「这次没建成」，旧的记数保持原样；why 里说清原因。
            item["why"] = "建立失败：%s" % (exc,)
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
        _ix_prune_orphan_files(dry_run=False)
        _INDEX_WATCH["miss"] = 0.0
        _INDEX_WATCH["hot"] = time.time()

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
    # 旧格式库必须先判「过期」，否则升级路径永远不触发。
    #
    # 这里是 1.42.0–1.42.2 的一个真缺口：schema 2 的库没有 n_files 列，
    # 下面那条 SELECT 会抛异常，然后被当成「读不了 → 保守放过」。结果就是
    # 老用户升级到 1.42.x 之后，抽查永远说「没问题」、永远不重建、库永远停在
    # schema 2 —— 于是 size_sum 快查用不了、写穿跳过、保鲜也跳过，整套新
    # 能力**静默失效**，而界面上一切正常。
    #
    # 「读不懂」和「没问题」是两件事。读不懂要修（重建一次就升级了），
    # 不能当成没事。
    try:
        can_fast = _index_has_totals(db)
    except Exception:
        can_fast = False
    if not can_fast:
        try:
            ver = _index_schema_version(db)
        except Exception:
            ver = 0
        try:
            db.close()
        except Exception:
            pass
        return {"ok": False, "checked": 0, "missing": 0, "dirty": 0,
                "why": "索引是旧版格式（schema %d），重建一次即可升级" % ver}
    try:
        rows = db.execute(
            "SELECT path, mtime, n_files FROM dirs ORDER BY RANDOM() LIMIT ?",
            (_IX_VERIFY_DIRS,)).fetchall()
        root_dir = os.path.abspath(str(item.get("root") or ""))
        prefix = root_dir.rstrip("\\/") + os.sep
        top_db_rows = db.execute(
            "SELECT path FROM dirs WHERE path LIKE ? ESCAPE '\\'"
            " AND path NOT LIKE ? ESCAPE '\\'",
            (_like_literal(prefix) + "%", _like_literal(prefix) + "%\\\\%")
        ).fetchall()
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

    # 抽查根目录直属一级子目录：新增未录入的子目录也必须立即判过期，避免被随机采样稀释漏检
    new_top = 0
    try:
        if os.path.isdir(root_dir):
            db_top = {os.path.normcase(os.path.abspath(p)) for (p,) in top_db_rows}
            for e in os.scandir(root_dir):
                try:
                    if not e.is_dir(follow_symlinks=False):
                        continue
                    if e.name.lower() in INDEX_SKIP or e.name.startswith("$"):
                        continue
                    if os.path.normcase(os.path.abspath(e.path)) not in db_top:
                        new_top += 1
                        dirty += 1
                except OSError:
                    continue
    except OSError:
        pass

    checked = len(rows) + new_top
    miss_ratio = missing / float(checked)
    dirty_ratio = dirty / float(checked)
    ok = (new_top == 0) and miss_ratio <= _IX_MISSING_MAX and dirty_ratio <= _IX_DIRTY_MAX
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
    else:
        _ix_prune_orphan_files(dry_run=False)
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

# 名字像「新文件落脚点」的目录。用来在**已索引的根底下**找下载夹/桌面。
_DOWNLOADISH = ("下载", "downloads", "download", "dl", "desktop", "桌面", "迅雷下载")

# 小索引根本身就算「热」：文件数在这个量级以下，整棵刷新也就几百毫秒，
# 没必要再去猜它的哪个子目录是热点。实测整盘 D:\ 有 59.5 万文件、E:\ 82.2 万，
# 远超这个线，不会被误当成热目录。
_HOT_SMALL_ROOT = 20000


def _hot_roots():
    """要「保鲜」的目录 = 用户当前索引范围**之内**、新文件最可能落下的那几个。

    这里有一条必须讲清楚的边界：保鲜只能刷新「已经在索引范围内的东西」，
    绝不能顺手把范围扩大。旧版（1.42.0/1.42.1）把 default_index_roots()
    直接当成保鲜对象，还在 missing 里 index_add 进去 —— 对一个只索引了
    D:\\ 和 E:\\ 的用户，那等于软件自己偷偷往索引里塞了 C:\\Users\\你\\Downloads：
    索引范围变了，占用排行榜也跟着变，而用户从没同意过。这是「保鲜」越权
    成了「扩张」，方向错了。

    正确的找法是反过来：在用户已经索引的根下面，找名字像下载/桌面的直接
    子目录。用户把盘索引了，就扫 D:\\下载、E:\\下载；只索引了用户目录，
    就扫那边的下载桌面。两种情况都只碰范围内。

    ── 为什么不去掉「找下载夹」这一步、直接靠 mtime 差异判断哪些目录变了 ──
    实测过：D:\\ 上 75,932 个目录逐个 os.stat 要 12,029 毫秒，完全不能放进
    查询路径。浅层（深度 ≤2）只有 622 个、50 毫秒，可信噪比太低（新文件
    多半落在更深处）。而按名字定位下载夹几乎不要钱：D:\\ 顶层 21 个条目、
    E:\\ 顶层 19 个条目，两次 scandir 就找完了。
    """
    items = _ix_load()
    roots = []
    for it in items:
        r = str(it.get("root") or "")
        if r and os.path.isdir(r):
            roots.append(os.path.abspath(r))
    if not roots:
        return []
    out = []
    seen = set()

    def add(p):
        try:
            k = os.path.normcase(os.path.abspath(p))
        except (ValueError, OSError):
            return
        if k in seen:
            return
        if not os.path.isdir(p):
            return
        seen.add(k)
        out.append(p)

    # 一、小索引根：整棵就是热的（用户自己加的某个小文件夹、测试目录）。
    for it in items:
        r = str(it.get("root") or "")
        if not r:
            continue
        try:
            if int(it.get("files") or 0) <= _HOT_SMALL_ROOT:
                add(r)
        except (TypeError, ValueError):
            continue

    # 二、大索引根（整盘）：在它下面找「下载 / 桌面」这类新文件落脚点。
    for it in items:
        r = str(it.get("root") or "")
        if not r:
            continue
        try:
            big = int(it.get("files") or 0) > _HOT_SMALL_ROOT
        except (TypeError, ValueError):
            big = False
        if not big:
            continue
        try:
            with os.scandir(os.path.abspath(r)) as scan:
                for e in scan:
                    try:
                        if not e.is_dir(follow_symlinks=False):
                            continue
                    except OSError:
                        continue
                    if e.name.lower() in _DOWNLOADISH:
                        add(e.path)
        except OSError:
            continue

    # 三、默认索引根（桌面/文档/下载/图片/视频）如果本来就落在某条索引范围
    # 里，它们自己就是落脚点，直接收进来（不新增范围，只是确认它在范围里）。
    for p in default_index_roots():
        try:
            kp = os.path.normcase(os.path.abspath(p))
        except (ValueError, OSError):
            continue
        for r in roots:
            try:
                rk = os.path.normcase(os.path.abspath(r)).rstrip("\\/")
            except (ValueError, OSError):
                continue
            if kp == rk or kp.startswith(rk + os.sep):
                add(p)
                break
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
    t0 = time.perf_counter()
    try:
        ok, used, cap = index_quota_ok()
        if not ok:
            # 超限就不再主动扩范围，但也不删用户已有的索引
            return {"roots": roots, "files": 0, "elapsed_ms": 0,
                    "skipped": "索引已占 %d MB，超过上限 %d MB"
                               % (used // 1048576, cap // 1048576)}
    except Exception:
        pass
    try:
        items = _ix_load()
        if not items:
            return {"roots": [], "files": 0, "elapsed_ms": 0,
                    "skipped": "还没有建过索引，等一次正常建库"}
        known_roots = {}
        for item in items:
            root = os.path.normcase(os.path.abspath(item.get("root") or ""))
            known_roots[root] = max(known_roots.get(root, 0),
                                    int(item.get("files") or 0))
        skip_hot_deep = False
        if not force and roots:
            known = max([known_roots.get(os.path.normcase(os.path.abspath(p)), 0)
                         for p in roots] or [0])
            if known > _HOT_INLINE_MAX:
                skip_hot_deep = True

        # 只刷新「已经在索引范围内」的目录与浅层变动子树，绝不 index_add 新根。
        hot_by_item = {}
        valid_hot = []
        if not skip_hot_deep:
            for p in roots:
                owners = _ix_items_for_path(p)
                if not owners:
                    continue
                valid_hot.append(p)
                hot_by_item.setdefault(owners[0][0]["id"], []).append(p)

        total_dirs = 0
        total_files = 0
        errs = []
        touched_roots = list(valid_hot)
        for item in items:
            root_path = str(item.get("root") or "")
            if not root_path or not os.path.isdir(root_path):
                continue
            db = None
            try:
                db = _index_open(_ix_db_abspath(item))
                if db is None or not _index_has_totals(db):
                    continue
                item_hots = hot_by_item.get(item["id"], [])
                skip_set = {os.path.normcase(os.path.abspath(hp)) for hp in item_hots}
                changed = False
                with db:
                    for hp in item_hots:
                        d, f = _ix_refresh_subtree(db, hp)
                        total_dirs += d
                        total_files += f
                        changed = True
                    d2, f2 = _ix_find_dirty_subtrees(db, root_path, skip_norm=skip_set)
                    if d2 > 0:
                        total_dirs += d2
                        total_files = max(total_files, f2)
                        changed = True
                        if root_path not in touched_roots:
                            touched_roots.append(root_path)
                if changed:
                    _ix_sync_item_totals(item["id"], db)
            except Exception as exc:
                errs.append((root_path, str(exc)))
            finally:
                try:
                    if db is not None:
                        db.close()
                except Exception:
                    pass
        _INDEX_WATCH["hot"] = time.time()
        return {"roots": touched_roots, "files": total_files, "dirs": total_dirs,
                "errs": errs,
                "elapsed_ms": int((time.perf_counter() - t0) * 1000)}
    except Exception as exc:
        return {"roots": roots, "files": 0, "elapsed_ms": 0, "error": str(exc)}


def _hot_maybe_stale():
    """这次「没搜到」值不值得先给已索引目录静默补扫一次？"""
    try:
        if _freshness_mode() == "manual":
            return False
        items = _ix_load()
        if not items:
            return False
        last = float(_INDEX_WATCH.get("miss") or 0)
        if (time.time() - last) >= _HOT_MIN_GAP:
            return True
        # 冷却期内但磁盘根目录/热目录 mtime 明显晚于上次刷盘时刻（O(1) stat），仍放行补扫
        hot_at = float(_INDEX_WATCH.get("hot") or 0)
        if hot_at > 0:
            for hp in _hot_roots():
                try:
                    if os.stat(hp).st_mtime > hot_at:
                        return True
                except OSError:
                    pass
            for it in items:
                rp = str(it.get("root") or "")
                if rp:
                    try:
                        if os.stat(rp).st_mtime > hot_at:
                            return True
                    except OSError:
                        pass
        return False
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
    """查单个库，返回 [(完整路径, 名字, 大小, 时间)]。

    和 `_ix_top_one` 一样会滤掉「索引里有、磁盘上已经没了」的条目：索引是
    快照，用户可能在别的程序里删了文件，甚至就是在搜索框里刚删完又来搜。
    给一条点进去打不开的结果，比少给一条更糟。

    代价是每个命中都要 stat 一次。命中数受 limit 限制（默认 200，最多
    5000），实测 200 条以内可以忽略；真搜到几千条时用户也不会一条条看。
    """
    db = _index_open(db_path)
    if db is None:
        return []
    try:
        if not _index_can_read(db):
            return []
        # 刻意多取一些再过滤：只取 limit 条的话，前排若有几条失效就会少给答案
        want = max(1, int(limit))
        take = want * 2

        def alive(rows):
            out = []
            for folder, name, size, mtime in rows:
                full = os.path.join(folder, name)
                try:
                    if not os.path.exists(full):
                        continue
                except OSError:
                    continue
                out.append((full, name, size, mtime))
                if len(out) >= want:
                    break
            return out

        rows = db.execute(
            "SELECT d.path, f.name, f.size, f.mtime FROM files f "
            "JOIN dirs d ON d.id = f.dir_id "
            "WHERE f.name LIKE ? ESCAPE '\\' LIMIT ?",
            (kw, take)).fetchall()
        if rows:
            return alive(rows)
        out = []
        for dpath, f0, n in db.execute(
                "SELECT path, f0, n FROM dirs WHERE path LIKE ? ESCAPE '\\' LIMIT 40",
                (kw,)).fetchall():
            if not n:
                continue
            out.extend((dpath, name, size, mtime) for name, size, mtime in db.execute(
                "SELECT name, size, mtime FROM files "
                "WHERE rowid BETWEEN ? AND ? LIMIT ?",
                (f0, f0 + n - 1, take - len(out))).fetchall())
            if len(out) >= take:
                break
        return alive(out)
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

def run_gui(prefill=None, tray_only=False):
    """已归档的旧版 Tkinter 界面。
    GUI 已在 1.40+ 完全迁移至 Tauri (Rust + WebView2 + 前端架构)。
    历史源码已归档至 archive/legacy_tk/legacy_gui.py。
    """
    sys.stderr.write(
        "[提示] Tkinter 图形界面已归档并分离 (参见 archive/legacy_tk/)。\n"
        "如需图形界面，请启动 TidyAssistant 主程序 (tidy-assistant.exe)。\n"
        "若需要无界面后台模式，请使用命令行参数 (如 --engine, --scheduled, --clean-shots 等)。\n"
    )
    if not tray_only:
        try:
            import tkinter as tk
            from tkinter import messagebox
            root = tk.Tk()
            root.withdraw()
            messagebox.showinfo(
                "整理助手",
                "Tkinter 图形界面已归档。\n请启动主程序 tidy-assistant.exe 使用全新界面。"
            )
            root.destroy()
        except Exception:
            pass
    return 0


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
    def __init__(self, message, code=None):
        super().__init__(message)
        self.code = code


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
    """organize 方法：confirm=false 只预演；confirm=true（或显式 dry_run=false）才真正移动。"""
    if "confirm" in params and params["confirm"] is not None:
        confirm = _engine_get(params, "confirm", False, bool)
    elif "dry_run" in params and params["dry_run"] is not None:
        confirm = not _engine_get(params, "dry_run", True, bool)
    else:
        confirm = False
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
        "prune_enabled": bool(s.get("prune_enabled", True)),
        "prune_history_keep": int(s.get("prune_history_keep", 50) or 0),
        "prune_thumbs_mb": int(s.get("prune_thumbs_mb", 256) or 0),
        "prune_backup_keep": int(s.get("prune_backup_keep", 3) or 0),
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
            "date": float(a.get("date") or 0.0),
            "install_date": str(a.get("install_date") or ""),
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


def _engine_find_app_or_orphan(params):
    """先按已安装程序匹配；找不到时构造孤立程序描述，支持卸载后/孤立残留扫描。"""
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
        return app, False
    return {
        "name": name,
        "version": version,
        "location": str(params.get("location") or params.get("path") or "").strip(),
        "publisher": str(params.get("publisher") or "").strip(),
        "hive": str(params.get("hive") or "").strip(),
        "key": str(params.get("key") or "").strip(),
    }, True


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
    """apps.leftovers：只列出残留目录与注册表键（支持已卸载或孤立程序），不删任何东西。"""
    app, is_orphan = _engine_find_app_or_orphan(params)
    dirs, regs = _engine_app_leftovers(app)
    return {"name": app.get("name") or "", "orphan": is_orphan, "dirs": dirs,
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

    支持已安装程序与已卸载/孤立残留清理。
    confirm=false 只回计划（零副作用）；confirm=true 才动盘/动注册表，
    被安全规则拒绝或导出失败的项一律进 failed，绝不静默跳过。
    """
    app, _is_orphan = _engine_find_app_or_orphan(params)
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


# ---------- 自启动管理与进程释放助手 ----------

def _parse_cmd_exe(cmd):
    """从自启动命令行中解析出主执行文件绝对路径。"""
    if not cmd or not isinstance(cmd, str):
        return ""
    s = cmd.strip()
    if s.startswith('"'):
        end = s.find('"', 1)
        if end != -1:
            p = s[1:end].strip()
            return os.path.expandvars(p)
        return os.path.expandvars(s.strip('"'))
    if os.path.isfile(s):
        return os.path.expandvars(s)
    tokens = s.split()
    cand = ""
    for t in tokens:
        cand = (cand + " " + t).strip() if cand else t
        exp = os.path.expandvars(cand)
        if os.path.isfile(exp):
            return exp
    return os.path.expandvars(tokens[0]) if tokens else s


def _resolve_lnk_target(lnk_path):
    """解析 .lnk 快捷方式目标文件路径。"""
    try:
        import win32com.client
        sh = win32com.client.Dispatch("WScript.Shell")
        sc = sh.CreateShortcut(lnk_path)
        if sc.TargetPath:
            return sc.TargetPath
    except Exception:
        pass
    try:
        with open(lnk_path, "rb") as f:
            content = f.read()
        import re
        m = re.findall(rb"[a-zA-Z]:\\[a-zA-Z0-9_ \\.-]+\.[eE][xX][eE]", content)
        if m:
            return m[-1].decode("ascii", "ignore")
    except Exception:
        pass
    return ""


def _engine_startup_list(params):
    """startup.list：扫描全系统自启动项（注册表 + 启动文件夹），标识启用状态与失效项。"""
    import winreg
    items = []
    
    # 1. 注册表自启动
    reg_targets = [
        ("HKCU", r"Software\Microsoft\Windows\CurrentVersion\Run", "当前用户注册表"),
        ("HKLM64", r"Software\Microsoft\Windows\CurrentVersion\Run", "系统注册表 (64位)"),
        ("HKLM32", r"Software\Microsoft\Windows\CurrentVersion\Run", "系统注册表 (32位)"),
    ]
    for hive_name, sub, loc_desc in reg_targets:
        try:
            with _open_reg(hive_name, sub, write=False) as k:
                # 读取 StartupApproved
                approved_map = {}
                try:
                    with _open_reg(hive_name, r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run", write=False) as ak:
                        cnt = winreg.QueryInfoKey(ak)[1]
                        for i in range(cnt):
                            an, ad, _ = winreg.EnumValue(ak, i)
                            approved_map[an] = ad
                except OSError:
                    pass

                val_cnt = winreg.QueryInfoKey(k)[1]
                for i in range(val_cnt):
                    n, v, _ = winreg.EnumValue(k, i)
                    v_str = str(v)
                    exe_path = _parse_cmd_exe(v_str)
                    exists = bool(exe_path and os.path.exists(exe_path))
                    appr = approved_map.get(n)
                    is_disabled = bool(appr and len(appr) > 0 and (appr[0] % 2 == 1))
                    
                    status = "broken" if not exists else ("disabled" if is_disabled else "enabled")
                    scope = "user" if hive_name == "HKCU" else "system"
                    icon_src = exe_path if exists else ""
                    icon = app_icon_cached(icon_src) if icon_src else ""
                    items.append({
                        "id": "%s_%s" % (hive_name, n),
                        "name": n,
                        "command": v_str,
                        "exe_path": exe_path,
                        "exists": exists,
                        "enabled": not is_disabled,
                        "status": status,
                        "location": loc_desc,
                        "scope": scope,
                        "source_type": "registry",
                        "hive": hive_name,
                        "key": sub,
                        "file_path": "",
                        "icon_src": icon_src,
                        "icon": icon
                    })
        except OSError:
            pass

    # 2. 启动文件夹自启动
    folder_targets = [
        (os.path.expandvars(r"%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"), "用户启动目录"),
        (os.path.expandvars(r"%ProgramData%\Microsoft\Windows\Start Menu\Programs\Startup"), "系统启动目录")
    ]
    for folder, loc_desc in folder_targets:
        if not os.path.isdir(folder):
            continue
        try:
            for fname in os.listdir(folder):
                full = os.path.join(folder, fname)
                if not os.path.isfile(full):
                    continue
                name, ext = os.path.splitext(fname)
                is_disabled = False
                if fname.lower().endswith(".disabled"):
                    is_disabled = True
                    name, _ = os.path.splitext(name)
                
                exe_target = full
                if ext.lower() == ".lnk" or fname.lower().endswith(".lnk.disabled"):
                    resolved = _resolve_lnk_target(full)
                    if resolved:
                        exe_target = resolved

                exists = bool(exe_target and os.path.exists(exe_target))
                status = "broken" if not exists else ("disabled" if is_disabled else "enabled")
                scope = "user" if "appdata" in folder.lower() else "system"
                icon_src = exe_target if exists else ""
                icon = app_icon_cached(icon_src) if icon_src else ""
                items.append({
                    "id": "folder_%s" % fname,
                    "name": name,
                    "command": full,
                    "exe_path": exe_target,
                    "exists": exists,
                    "enabled": not is_disabled,
                    "status": status,
                    "location": loc_desc,
                    "scope": scope,
                    "source_type": "folder",
                    "hive": "",
                    "key": "",
                    "file_path": full,
                    "icon_src": icon_src,
                    "icon": icon
                })
        except OSError:
            pass

    # 统计汇总
    enabled_cnt = sum(1 for it in items if it["enabled"] and it["exists"])
    disabled_cnt = sum(1 for it in items if not it["enabled"])
    broken_cnt = sum(1 for it in items if not it["exists"])
    return {
        "total": len(items),
        "enabled_count": enabled_cnt,
        "disabled_count": disabled_cnt,
        "broken_count": broken_cnt,
        "items": items
    }


def _engine_startup_toggle(params):
    """startup.toggle：安全切换自启动项的启用/禁用状态。"""
    name = _engine_get(params, "name", "", str)
    if not name.strip():
        raise EngineError("参数 name 不能为空")
    source_type = _engine_get(params, "source_type", "registry", str)
    enabled = _engine_get(params, "enabled", True, bool)
    new_file_path = ""

    if source_type == "registry":
        hive_name = _engine_get(params, "hive", "HKCU", str)
        if hive_name not in ("HKCU", "HKLM64", "HKLM32"):
            hive_name = "HKCU"
        import winreg
        hive, flag = _reg_hive(hive_name)
        approved_sub = r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run"
        try:
            with winreg.CreateKeyEx(hive, approved_sub, 0, winreg.KEY_SET_VALUE | flag) as k:
                if enabled:
                    winreg.SetValueEx(k, name, 0, winreg.REG_BINARY, b"\x02\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00")
                else:
                    winreg.SetValueEx(k, name, 0, winreg.REG_BINARY, b"\x03\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00")
        except OSError as ex:
            if getattr(ex, "winerror", 0) == 5 or getattr(ex, "errno", 0) == 13:
                raise EngineError("修改系统级 (HKLM) 注册表自启动项状态需要管理员权限", code="admin_required")
            raise EngineError("修改自启动状态失败（可能需要管理员权限）：%s" % ex)
    elif source_type == "folder":
        file_path = _engine_get(params, "file_path", "", str)
        if not file_path or not os.path.exists(file_path):
            raise EngineError("快捷方式文件不存在：%s" % file_path)
        try:
            import stat
            new_file_path = file_path
            if enabled:
                if file_path.lower().endswith(".disabled"):
                    new_file_path = file_path[:-9]
                    if os.path.exists(new_file_path) and os.path.abspath(new_file_path) != os.path.abspath(file_path):
                        try:
                            os.chmod(new_file_path, stat.S_IWRITE)
                            os.remove(new_file_path)
                        except OSError:
                            pass
                    try:
                        os.chmod(file_path, stat.S_IWRITE)
                    except OSError:
                        pass
                    os.replace(file_path, new_file_path)
            else:
                if not file_path.lower().endswith(".disabled"):
                    new_file_path = file_path + ".disabled"
                    if os.path.exists(new_file_path) and os.path.abspath(new_file_path) != os.path.abspath(file_path):
                        try:
                            os.chmod(new_file_path, stat.S_IWRITE)
                            os.remove(new_file_path)
                        except OSError:
                            pass
                    try:
                        os.chmod(file_path, stat.S_IWRITE)
                    except OSError:
                        pass
                    os.replace(file_path, new_file_path)
        except OSError as ex:
            if getattr(ex, "winerror", 0) == 5 or getattr(ex, "errno", 0) == 13:
                raise EngineError("修改系统启动目录快捷方式需要管理员权限", code="admin_required")
            raise EngineError("重命名启动项失败：%s" % ex)
    else:
        raise EngineError("未知的启动项类型：%s" % source_type)

    res = {"ok": True, "name": name, "enabled": enabled}
    if source_type == "folder":
        res["new_file_path"] = new_file_path
    return res


def _engine_startup_delete(params):
    """startup.delete：安全清理自启动项（注册表键或启动快捷方式）。"""
    name = _engine_get(params, "name", "", str)
    if not name.strip():
        raise EngineError("参数 name 不能为空")
    source_type = _engine_get(params, "source_type", "registry", str)

    if source_type == "registry":
        hive_name = _engine_get(params, "hive", "HKCU", str)
        key_sub = _engine_get(params, "key", r"Software\Microsoft\Windows\CurrentVersion\Run", str)
        import winreg
        hive, flag = _reg_hive(hive_name)
        try:
            with winreg.OpenKey(hive, key_sub, 0, winreg.KEY_SET_VALUE | flag) as k:
                winreg.DeleteValue(k, name)
        except OSError as ex:
            if getattr(ex, "winerror", 0) == 5 or getattr(ex, "errno", 0) == 13:
                raise EngineError("删除系统级 (HKLM) 注册表自启动项需要管理员权限", code="admin_required")
            raise EngineError("删除自启动注册表项失败：%s" % ex)
        try:
            with winreg.OpenKey(hive, r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run", 0, winreg.KEY_SET_VALUE | flag) as ak:
                winreg.DeleteValue(ak, name)
        except OSError:
            pass
    elif source_type == "folder":
        file_path = _engine_get(params, "file_path", "", str)
        if not file_path:
            raise EngineError("缺少启动项快捷方式文件路径")
        target_path = file_path
        if not os.path.exists(target_path):
            if not target_path.lower().endswith(".disabled") and os.path.exists(target_path + ".disabled"):
                target_path = target_path + ".disabled"
            elif target_path.lower().endswith(".disabled") and os.path.exists(target_path[:-9]):
                target_path = target_path[:-9]
        if not os.path.exists(target_path):
            raise EngineError("快捷方式文件不存在：%s" % file_path)
        try:
            import stat
            try:
                os.chmod(target_path, stat.S_IWRITE)
            except OSError:
                pass
            os.remove(target_path)
        except OSError as ex:
            if getattr(ex, "winerror", 0) == 5 or getattr(ex, "errno", 0) == 13:
                raise EngineError("删除系统启动目录快捷方式需要管理员权限", code="admin_required")
            raise EngineError("删除启动项快捷方式失败：%s" % ex)
    else:
        raise EngineError("未知的启动项类型：%s" % source_type)

    return {"ok": True, "name": name, "deleted": True}


if os.name == "nt":
    import ctypes
    from ctypes import wintypes

    TH32CS_SNAPPROCESS = 0x00000002
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    PROCESS_QUERY_INFORMATION = 0x0400
    PROCESS_VM_READ = 0x0010

    class _PE32W(ctypes.Structure):
        _fields_ = [
            ("dwSize", wintypes.DWORD),
            ("cntUsage", wintypes.DWORD),
            ("th32ProcessID", wintypes.DWORD),
            ("th32DefaultHeapID", ctypes.c_size_t),
            ("th32ModuleID", wintypes.DWORD),
            ("cntThreads", wintypes.DWORD),
            ("th32ParentProcessID", wintypes.DWORD),
            ("pcPriClassBase", wintypes.LONG),
            ("dwFlags", wintypes.DWORD),
            ("szExeFile", wintypes.WCHAR * 260)
        ]

    class _PROCESS_MEMORY_COUNTERS(ctypes.Structure):
        _fields_ = [
            ("cb", wintypes.DWORD),
            ("PageFaultCount", wintypes.DWORD),
            ("PeakWorkingSetSize", ctypes.c_size_t),
            ("WorkingSetSize", ctypes.c_size_t),
            ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
            ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
            ("PagefileUsage", ctypes.c_size_t),
            ("PeakPagefileUsage", ctypes.c_size_t),
        ]

    try:
        _k32_proc = ctypes.windll.kernel32
        _k32_proc.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
        _k32_proc.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
        _k32_proc.CloseHandle.argtypes = [wintypes.HANDLE]
        _k32_proc.CloseHandle.restype = wintypes.BOOL
        _k32_proc.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(_PE32W)]
        _k32_proc.Process32FirstW.restype = wintypes.BOOL
        _k32_proc.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(_PE32W)]
        _k32_proc.Process32NextW.restype = wintypes.BOOL
        _k32_proc.OpenProcess.restype = wintypes.HANDLE
        _k32_proc.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        _k32_proc.QueryFullProcessImageNameW.restype = wintypes.BOOL
        _k32_proc.QueryFullProcessImageNameW.argtypes = [
            wintypes.HANDLE,
            wintypes.DWORD,
            wintypes.LPWSTR,
            ctypes.POINTER(wintypes.DWORD),
        ]
    except Exception:
        _k32_proc = None

    try:
        _psapi_proc = ctypes.windll.psapi
        _psapi_proc.GetProcessMemoryInfo.restype = wintypes.BOOL
        _psapi_proc.GetProcessMemoryInfo.argtypes = [
            wintypes.HANDLE,
            ctypes.POINTER(_PROCESS_MEMORY_COUNTERS),
            wintypes.DWORD,
        ]
    except Exception:
        _psapi_proc = None
else:
    _PE32W = None
    _PROCESS_MEMORY_COUNTERS = None
    _k32_proc = None
    _psapi_proc = None


def _engine_process_is_running(proc_name):
    """判断指定名称的进程当前是否正在运行（纯 ctypes 工具快照，微秒级极速，不占主线程）。"""
    if os.name != "nt" or not _k32_proc or not _PE32W:
        return False

    target = proc_name.lower()
    if not target.endswith(".exe"):
        target += ".exe"

    try:
        h_snap = _k32_proc.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
        if not h_snap or h_snap == -1 or h_snap == (1 << (8 * ctypes.sizeof(wintypes.HANDLE))) - 1:
            return False
        pe = _PE32W()
        pe.dwSize = ctypes.sizeof(_PE32W)
        found = False
        try:
            if _k32_proc.Process32FirstW(h_snap, ctypes.byref(pe)):
                while True:
                    if pe.szExeFile.lower() == target:
                        found = True
                        break
                    if not _k32_proc.Process32NextW(h_snap, ctypes.byref(pe)):
                        break
        finally:
            _k32_proc.CloseHandle(h_snap)
        return found
    except Exception:
        return False


def _engine_process_close(params):
    """process.close：安全协同释放占用文件的进程（优雅通知 + 系统核心白名单保护）。"""
    pid = _engine_get(params, "pid", 0, int)
    name = _engine_get(params, "name", "", str).strip()

    if not pid and not name:
        raise EngineError("参数 pid 或 name 至少需要提供一个")

    import re
    if name and not re.match(r"^[a-zA-Z0-9_\-\.]+$", name):
        raise EngineError("非法进程名，只允许包含字母、数字、下划线、连字符和点")

    force = _engine_get(params, "force", False, bool)
    confirm_sensitive = _engine_get(params, "confirm_sensitive", False, bool)

    clean = name.lower()
    if clean.endswith(".exe"):
        clean = clean[:-4]

    # 绝对系统关键进程白名单（红线）
    _SYS_PROTECTED = {
        "explorer", "dwm", "csrss", "lsass", "services", "smss", "svchost",
        "startmenuexperiencehost", "tidyassistant", "整理助手", "python", "conhost",
        "runtimebroker", "taskmgr", "system", "idle", "winlogon", "sihost", "fontdrvhost"
    }

    if pid and pid <= 4:
        raise EngineError("【PID %d】是系统保留特权进程，禁止关闭" % pid)

    if clean and clean in _SYS_PROTECTED:
        raise EngineError("【%s】是 Windows 核心受保护组件，禁止关闭以防桌面崩溃" % name)

    # 敏感数据应用（如微信）
    _SENSITIVE_APPS = {"xwechat", "wechat", "qq"}
    if clean in _SENSITIVE_APPS and not confirm_sensitive:
        return {
            "ok": False,
            "need_confirm": True,
            "warning": "【%s】包含本地数据库文件，强行关闭可能导致未保存聊天记录损坏，建议在软件内退出" % name
        }

    import subprocess, time

    if pid:
        # 按 PID 关闭单进程
        try:
            subprocess.run(["taskkill", "/PID", str(pid)], capture_output=True, text=True, timeout=5)
        except Exception:
            pass

        if force:
            try:
                subprocess.run(["taskkill", "/F", "/PID", str(pid)], capture_output=True, text=True, timeout=5)
            except Exception:
                pass
        return {"ok": True, "pid": pid, "name": name or str(pid), "closed": True}

    # 按名称关闭
    was_running = _engine_process_is_running(clean + ".exe")
    if not was_running:
        return {"ok": True, "name": clean, "was_running": False, "closed": False}

    # 1. 尝试优雅通知退出（taskkill 不加 /F 发送 WM_CLOSE）
    try:
        subprocess.run(["taskkill", "/IM", "%s.exe" % clean], capture_output=True, text=True, timeout=5)
    except Exception:
        pass

    # 非阻塞短轮询等待退出（最多 300ms，每次 50ms）
    still_running = True
    for _ in range(6):
        time.sleep(0.05)
        if not _engine_process_is_running(clean + ".exe"):
            still_running = False
            break

    # 2. 若配置了 force 且仍在运行，再尝试强制终止
    if still_running and force:
        try:
            subprocess.run(["taskkill", "/F", "/IM", "%s.exe" % clean], capture_output=True, text=True, timeout=5)
        except Exception:
            pass
        for _ in range(2):
            time.sleep(0.05)
            if not _engine_process_is_running(clean + ".exe"):
                still_running = False
                break

    closed = not _engine_process_is_running(clean + ".exe")
    return {"ok": True, "name": clean, "was_running": was_running, "closed": closed}


def _engine_process_list(params=None):
    """process.list：毫秒级快照系统当前运行进程（通过 Win32 Toolhelp32Snapshot + psapi，不产生静默轮询）。"""
    if params is None:
        params = {}
    aggregate = _engine_get(params, "aggregate", True, bool)
    search = _engine_get(params, "search", "", str).strip().lower()

    if os.name != "nt" or not _k32_proc or not _PE32W:
        return {"items": [], "total_count": 0, "total_memory": 0, "raw_count": 0}

    _SYS_PROTECTED = {
        "explorer", "dwm", "csrss", "lsass", "services", "smss", "svchost",
        "startmenuexperiencehost", "tidyassistant", "整理助手", "python", "conhost",
        "runtimebroker", "taskmgr", "system", "idle", "winlogon", "sihost", "fontdrvhost"
    }

    hSnap = _k32_proc.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if not hSnap or hSnap == -1 or hSnap == (1 << (8 * ctypes.sizeof(wintypes.HANDLE))) - 1:
        return {"items": [], "total_count": 0, "total_memory": 0, "raw_count": 0}

    pe = _PE32W()
    pe.dwSize = ctypes.sizeof(_PE32W)

    raw_procs = []
    total_memory = 0

    try:
        if _k32_proc.Process32FirstW(hSnap, ctypes.byref(pe)):
            while True:
                pid = int(pe.th32ProcessID)
                name = str(pe.szExeFile)
                threads = int(pe.cntThreads)
                mem_size = 0
                exe_path = ""

                # 获取物理内存工作集
                if _psapi_proc:
                    hProcMem = _k32_proc.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
                    if hProcMem:
                        try:
                            mem = _PROCESS_MEMORY_COUNTERS()
                            mem.cb = ctypes.sizeof(_PROCESS_MEMORY_COUNTERS)
                            if _psapi_proc.GetProcessMemoryInfo(hProcMem, ctypes.byref(mem), mem.cb):
                                mem_size = int(mem.WorkingSetSize)
                        except Exception:
                            pass
                        finally:
                            _k32_proc.CloseHandle(hProcMem)

                # 获取可执行文件路径
                hProcPath = _k32_proc.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
                if hProcPath:
                    try:
                        buf = ctypes.create_unicode_buffer(1024)
                        size = wintypes.DWORD(1024)
                        if _k32_proc.QueryFullProcessImageNameW(hProcPath, 0, buf, ctypes.byref(size)):
                            exe_path = str(buf.value)
                    except Exception:
                        pass
                    finally:
                        _k32_proc.CloseHandle(hProcPath)

                clean = name.lower()
                if clean.endswith(".exe"):
                    clean = clean[:-4]
                is_system = clean in _SYS_PROTECTED or pid <= 4

                icon_src = exe_path if exe_path else ""
                icon = app_icon_cached(icon_src) if icon_src else ""

                total_memory += mem_size
                raw_procs.append({
                    "pid": pid,
                    "name": name,
                    "clean_name": clean,
                    "threads": threads,
                    "memory": mem_size,
                    "exe_path": exe_path,
                    "icon_src": icon_src,
                    "icon": icon,
                    "is_system": is_system
                })
                if not _k32_proc.Process32NextW(hSnap, ctypes.byref(pe)):
                    break
    finally:
        _k32_proc.CloseHandle(hSnap)

    if aggregate:
        grouped = {}
        for p in raw_procs:
            key = p["clean_name"]
            if key not in grouped:
                grouped[key] = {
                    "name": p["name"],
                    "clean_name": p["clean_name"],
                    "pids": [p["pid"]],
                    "process_count": 1,
                    "threads": p["threads"],
                    "memory": p["memory"],
                    "exe_path": p["exe_path"],
                    "icon_src": p["icon_src"],
                    "icon": p["icon"],
                    "is_system": p["is_system"]
                }
            else:
                g = grouped[key]
                g["pids"].append(p["pid"])
                g["process_count"] += 1
                g["threads"] += p["threads"]
                g["memory"] += p["memory"]
                if not g["exe_path"] and p["exe_path"]:
                    g["exe_path"] = p["exe_path"]
                    g["icon_src"] = p["icon_src"]
                    g["icon"] = p["icon"]
        items = list(grouped.values())
    else:
        items = raw_procs

    if search:
        items = [it for it in items if search in it["name"].lower() or search in (it.get("exe_path") or "").lower()]

    items.sort(key=lambda x: x["memory"], reverse=True)

    return {
        "items": items,
        "total_count": len(items),
        "raw_count": len(raw_procs),
        "total_memory": total_memory
    }


_SYS_PERF_PREV = [None]


def _engine_system_performance(params=None):
    """system.performance：高能效快照全盘分区容量、物理内存状态与瞬时 CPU 负载（0 闲置持续负载）。"""
    import shutil
    import ctypes
    from ctypes import wintypes

    drives = []
    total_disk_bytes = 0
    free_disk_bytes = 0
    used_disk_bytes = 0

    if os.name == "nt":
        for d in range(65, 91):
            drive_letter = chr(d) + ":\\"
            try:
                dtype = ctypes.windll.kernel32.GetDriveTypeW(drive_letter)
                if dtype in (0, 1, 5):
                    continue
                if not os.path.exists(drive_letter):
                    continue
                du = shutil.disk_usage(drive_letter)
                if du.total <= 0:
                    continue
                drives.append({
                    "drive": drive_letter,
                    "letter": chr(d),
                    "total": int(du.total),
                    "used": int(du.used),
                    "free": int(du.free),
                    "percent": round(du.used / du.total * 100, 1) if du.total else 0.0,
                    "is_system": chr(d).upper() == os.environ.get("SystemDrive", "C:")[0].upper()
                })
                total_disk_bytes += int(du.total)
                used_disk_bytes += int(du.used)
                free_disk_bytes += int(du.free)
            except OSError:
                continue

        class _MEMORYSTATUSEX(ctypes.Structure):
            _fields_ = [
                ("dwLength", wintypes.DWORD),
                ("dwMemoryLoad", wintypes.DWORD),
                ("ullTotalPhys", ctypes.c_uint64),
                ("ullAvailPhys", ctypes.c_uint64),
                ("ullTotalPageFile", ctypes.c_uint64),
                ("ullAvailPageFile", ctypes.c_uint64),
                ("ullTotalVirtual", ctypes.c_uint64),
                ("ullAvailVirtual", ctypes.c_uint64),
                ("ullAvailExtendedVirtual", ctypes.c_uint64)
            ]

        mem_stat = _MEMORYSTATUSEX()
        mem_stat.dwLength = ctypes.sizeof(_MEMORYSTATUSEX)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(mem_stat)):
            mem_total = int(mem_stat.ullTotalPhys)
            mem_avail = int(mem_stat.ullAvailPhys)
            mem_used = max(0, mem_total - mem_avail)
            mem_load = int(mem_stat.dwMemoryLoad)
        else:
            mem_total = mem_avail = mem_used = mem_load = 0

        def _get_times():
            idle = wintypes.FILETIME()
            kern = wintypes.FILETIME()
            user = wintypes.FILETIME()
            if ctypes.windll.kernel32.GetSystemTimes(ctypes.byref(idle), ctypes.byref(kern), ctypes.byref(user)):
                return (
                    (idle.dwHighDateTime << 32) | idle.dwLowDateTime,
                    (kern.dwHighDateTime << 32) | kern.dwLowDateTime,
                    (user.dwHighDateTime << 32) | user.dwLowDateTime,
                    time.perf_counter()
                )
            return (0, 0, 0, time.perf_counter())

        # 磁盘 I/O 字节快照 (NtQuerySystemInformation)
        def _read_disk_transfer():
            try:
                buf = (ctypes.c_byte * 312)()
                if ctypes.windll.ntdll.NtQuerySystemInformation(2, ctypes.byref(buf), 312, None) == 0:
                    import struct
                    _, r_b, w_b, _ = struct.unpack_from('<qqqq', buf, 0)
                    return int(r_b), int(w_b)
            except Exception:
                pass
            return 0, 0

        # 网络 I/O 字节快照 (GetIfTable2)
        class _MIB_IF_ROW2(ctypes.Structure):
            _fields_ = [
                ('InterfaceLuid', ctypes.c_uint64),
                ('InterfaceIndex', wintypes.DWORD),
                ('InterfaceGuid', ctypes.c_byte * 16),
                ('Alias', wintypes.WCHAR * 257),
                ('Description', wintypes.WCHAR * 257),
                ('PhysicalAddressLength', wintypes.DWORD),
                ('PhysicalAddress', ctypes.c_byte * 32),
                ('PermanentPhysicalAddress', ctypes.c_byte * 32),
                ('Mtu', wintypes.DWORD),
                ('Type', wintypes.DWORD),
                ('TunnelType', wintypes.DWORD),
                ('MediaType', wintypes.DWORD),
                ('PhysicalMediumType', wintypes.DWORD),
                ('AccessType', wintypes.DWORD),
                ('DirectionType', wintypes.DWORD),
                ('InterfaceAndOperStatusFlags', ctypes.c_byte),
                ('OperStatus', wintypes.DWORD),
                ('AdminStatus', wintypes.DWORD),
                ('MediaConnectState', wintypes.DWORD),
                ('NetworkGuid', ctypes.c_byte * 16),
                ('ConnectionType', wintypes.DWORD),
                ('TransmitLinkSpeed', ctypes.c_uint64),
                ('ReceiveLinkSpeed', ctypes.c_uint64),
                ('InOctets', ctypes.c_uint64),
                ('InUcastPkts', ctypes.c_uint64),
                ('InNUcastPkts', ctypes.c_uint64),
                ('InDiscards', ctypes.c_uint64),
                ('InErrors', ctypes.c_uint64),
                ('InUnknownProtos', ctypes.c_uint64),
                ('InUcastOctets', ctypes.c_uint64),
                ('InMulticastOctets', ctypes.c_uint64),
                ('InBroadcastOctets', ctypes.c_uint64),
                ('OutOctets', ctypes.c_uint64),
                ('OutUcastPkts', ctypes.c_uint64),
                ('OutNUcastPkts', ctypes.c_uint64),
                ('OutDiscards', ctypes.c_uint64),
                ('OutErrors', ctypes.c_uint64),
                ('OutUcastOctets', ctypes.c_uint64),
                ('OutMulticastOctets', ctypes.c_uint64),
                ('OutBroadcastOctets', ctypes.c_uint64),
                ('OutQLen', ctypes.c_uint64),
            ]

        class _MIB_IF_TABLE2(ctypes.Structure):
            _fields_ = [
                ('NumEntries', wintypes.ULONG),
                ('Table', _MIB_IF_ROW2 * 1)
            ]

        def _read_network_transfer():
            try:
                pTable = ctypes.POINTER(_MIB_IF_TABLE2)()
                if ctypes.windll.iphlpapi.GetIfTable2(ctypes.byref(pTable)) == 0:
                    table = pTable.contents
                    num = table.NumEntries
                    rows = ctypes.cast(ctypes.byref(table.Table), ctypes.POINTER(_MIB_IF_ROW2 * num)).contents
                    in_b = sum(r.InOctets for r in rows if r.OperStatus == 1 and r.Type != 24)
                    out_b = sum(r.OutOctets for r in rows if r.OperStatus == 1 and r.Type != 24)
                    ctypes.windll.iphlpapi.FreeMibTable(pTable)
                    return int(in_b), int(out_b)
            except Exception:
                pass
            return 0, 0

        now_times = _get_times()
        disk_r, disk_w = _read_disk_transfer()
        net_in, net_out = _read_network_transfer()

        cpu_pct = 0.0
        disk_r_bps = 0
        disk_w_bps = 0
        net_in_bps = 0
        net_out_bps = 0

        prev = _SYS_PERF_PREV[0]
        if prev and (now_times[3] - prev[3]) < 5.0 and (now_times[3] - prev[3]) >= 0.05:
            dt = now_times[3] - prev[3]
            idle_delta = now_times[0] - prev[0]
            kern_delta = now_times[1] - prev[1]
            user_delta = now_times[2] - prev[2]
            total_delta = kern_delta + user_delta
            if total_delta > 0:
                cpu_pct = round(max(0.0, min(100.0, (1.0 - idle_delta / total_delta) * 100.0)), 1)
            if len(prev) >= 8 and dt > 0:
                disk_r_bps = max(0, int((disk_r - prev[4]) / dt))
                disk_w_bps = max(0, int((disk_w - prev[5]) / dt))
                net_in_bps = max(0, int((net_in - prev[6]) / dt))
                net_out_bps = max(0, int((net_out - prev[7]) / dt))
        else:
            time.sleep(0.04)
            t2 = _get_times()
            d2_r, d2_w = _read_disk_transfer()
            n2_in, n2_out = _read_network_transfer()
            dt = t2[3] - now_times[3]
            idle_delta = t2[0] - now_times[0]
            kern_delta = t2[1] - now_times[1]
            user_delta = t2[2] - now_times[2]
            total_delta = kern_delta + user_delta
            if total_delta > 0:
                cpu_pct = round(max(0.0, min(100.0, (1.0 - idle_delta / total_delta) * 100.0)), 1)
            if dt > 0:
                disk_r_bps = max(0, int((d2_r - disk_r) / dt))
                disk_w_bps = max(0, int((d2_w - disk_w) / dt))
                net_in_bps = max(0, int((n2_in - net_in) / dt))
                net_out_bps = max(0, int((n2_out - net_out) / dt))
            now_times = t2
            disk_r, disk_w = d2_r, d2_w
            net_in, net_out = n2_in, n2_out

        _SYS_PERF_PREV[0] = (now_times[0], now_times[1], now_times[2], now_times[3], disk_r, disk_w, net_in, net_out)
        cpu_cores = os.cpu_count() or 1
    else:
        mem_total = mem_avail = mem_used = mem_load = 0
        cpu_pct = 0.0
        cpu_cores = 1
        disk_r_bps = disk_w_bps = net_in_bps = net_out_bps = 0

    return {
        "timestamp": int(time.time() * 1000),
        "drives": drives,
        "disk_summary": {
            "total": total_disk_bytes,
            "used": used_disk_bytes,
            "free": free_disk_bytes,
            "percent": round(used_disk_bytes / total_disk_bytes * 100, 1) if total_disk_bytes else 0.0
        },
        "disk_io": {
            "read_bps": disk_r_bps,
            "write_bps": disk_w_bps,
            "total_bps": disk_r_bps + disk_w_bps
        },
        "network_io": {
            "in_bps": net_in_bps,
            "out_bps": net_out_bps,
            "total_bps": net_in_bps + net_out_bps
        },
        "memory": {
            "total": mem_total,
            "available": mem_avail,
            "used": mem_used,
            "percent": mem_load
        },
        "cpu": {
            "percent": cpu_pct,
            "cores": cpu_cores
        }
    }


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


def _engine_prune(params):
    """prune.run：把本地数据按「只留最新」收一遍，返回删了什么。

    默认真删；dry_run=true 只报数字，给设置页预览用。

    为什么不复用 cache.clean：那套是清「系统里的缓存」（其他软件的缓存目录），
    走的是 CACHE_FORBIDDEN 白名单与回收站。这里清的是**我们自己**在数据目录
    里攒下的历史/日志/缩略图，路径全部来自 data_dir()/cache_dir()，不该走
    用户的回收站 —— 那些东西进回收站只会变成另一种垃圾。
    """
    dry = bool(params.get("dry_run")) if isinstance(params, dict) else False
    rep = prune_data_dir(dry_run=dry)
    if not dry:
        _PRUNE_LAST["at"] = time.time()      # 手动跑过，别忘了节流时间戳
    return rep


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

    # 库都在、都有条数、抽查通过、又不是强制全量，才跳过重建
    if reuse and not full and all(
            os.path.isfile(_ix_db_abspath(i)) and int(i.get("files") or 0) > 0
            and _ix_verify_one(i).get("ok")
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
    "prune_enabled": bool,
    "prune_history_keep": int,
    "prune_thumbs_mb": int,
    "prune_backup_keep": int,
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
    # 0 是合法的「不限制 / 一份都不留」之外的边界：history 留 0 份等于
    # 把撤销能力关掉，仍允许（有人就是不要历史），但不接受负数。
    "prune_history_keep": (0, 10000),
    "prune_thumbs_mb": (0, 65536),
    "prune_backup_keep": (0, 1000),
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
    "startup.list": _engine_startup_list,
    "startup.toggle": _engine_startup_toggle,
    "startup.delete": _engine_startup_delete,
    "process.close": _engine_process_close,
    "process.list": _engine_process_list,
    "system.performance": _engine_system_performance,
    "search.status": _engine_search_status,
    "search.index": _engine_search_index,
    "search.query": _engine_search_query,
    "search.top": _engine_search_top,
    "search.folders": _engine_search_folders,
    "search.add": _engine_search_add,
    "search.remove": _engine_search_remove,
    "search.selfcheck": _engine_search_selfcheck,
    "search.hot": _engine_search_hot,
    "prune.run": _engine_prune,
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
    # 启动时先按「只留最新」收一遍本地数据。放在线程里做，不挡第一条 RPC：
    # 用户开软件不该等一次磁盘清理。挂在这里而不是只在整理后跑，是因为
    # 「从来不整理、只是天天开软件的搜索」这种用法根本不会触发 apply()，
    # 而历史/日志/缩略图照样在长。
    try:
        threading.Thread(target=prune_maybe, kwargs={"force": True},
                         name='engine-prune', daemon=True).start()
    except Exception:
        pass
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
            if getattr(ex, "code", None):
                resp["code"] = ex.code
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
            run_gui(prefill=args[0] if args and os.path.isdir(args[0]) else None, tray_only=True)
            return
        run_gui(prefill=args[0] if args and os.path.isdir(args[0]) else None)
        return

    if "--tray" in argv:
        hide_console()
        run_gui(prefill=None, tray_only=True)
        return

    if "--gui" in argv or not args:
        hide_console()
        run_gui(prefill=args[0] if args else None)
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






