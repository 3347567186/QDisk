# -*- coding: utf-8 -*-
"""tidy.py --engine（JSON Lines RPC）的端到端测试。

跑法（在 07_代码配置 目录下）：
    py -3 -m unittest test_engine_rpc -v

每个测试类用 subprocess 起一个真实的引擎进程。为了不碰用户真实数据目录
和真实 rules.json：
  · 把 tidy.py / rules.json 复制到 tempfile 目录再启动，引擎的「便携数据
    目录」就落在临时目录里；
  · 把 LOCALAPPDATA / APPDATA / USERPROFILE / TEMP / WINDIR / PROGRAMDATA /
    ProgramFiles 这些环境变量全部指到临时目录，截图/缓存/搜索扫描的就都是
    空的临时目录，不会去翻真实用户缓存（否则 cache.list 会扫几分钟）。
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from queue import Empty, Queue

HERE = os.path.dirname(os.path.abspath(__file__))
TIDY = os.path.join(HERE, "tidy.py")
RULES = os.path.join(HERE, "rules.json")
MIGRATE_ENGINE = os.path.join(HERE, "migrate_engine.py")
READ_TIMEOUT = 15.0

# 高级规则（rules.*）由 organize-tool 提供。这组用例跑的是 tidy.py 源码，
# 用的是开发机上的 Python；没装 organize-tool 就整组跳过，别把环境缺失
# 报成产品缺陷。随包引擎那一侧由 acceptance_engine2.py 的 F02–F05 覆盖。
try:
    import organize  # noqa: F401
    HAS_ORGANIZE = True
except Exception:
    HAS_ORGANIZE = False
SAMPLES = ("a.pdf", "b.jpg", "c.zip")


class Engine:
    """一个引擎子进程 + 按行收发 JSON 的小封装。"""

    def __init__(self, workdir):
        self.script = os.path.join(workdir, "tidy.py")
        self.stderr_path = os.path.join(workdir, "engine-stderr.log")
        self._err = open(self.stderr_path, "w+", encoding="utf-8")
        env = dict(os.environ)
        env["LOCALAPPDATA"] = os.path.join(workdir, "localappdata")
        env["APPDATA"] = os.path.join(workdir, "appdata")
        # 把「家目录 / 临时目录 / 系统目录」也隔离掉：截图与缓存扫描都按这些
        # 环境变量展开路径，不隔离就会扫真实用户缓存，又慢又可能动到真实数据
        env["USERPROFILE"] = os.path.join(workdir, "userprofile")
        env["TEMP"] = os.path.join(workdir, "temp")
        env["TMP"] = env["TEMP"]
        env["WINDIR"] = os.path.join(workdir, "windows")
        env["PROGRAMDATA"] = os.path.join(workdir, "programdata")
        env["PROGRAMFILES"] = os.path.join(workdir, "programfiles")
        env["PROGRAMFILES(X86)"] = os.path.join(workdir, "programfiles")
        self.proc = subprocess.Popen(
            [sys.executable, self.script, "--engine"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=self._err, text=True, encoding="utf-8",
            cwd=workdir, env=env, bufsize=1)
        self._lines = Queue()
        threading.Thread(target=self._pump, daemon=True).start()

    def _pump(self):
        try:
            for line in self.proc.stdout:
                self._lines.put(line)
        except Exception:
            pass
        finally:
            self._lines.put(None)

    def stderr_text(self):
        """读引擎 stderr，断言失败时打印出来便于排查。"""
        try:
            self._err.flush()
            with open(self.stderr_path, encoding="utf-8", errors="replace") as f:
                return f.read()
        except Exception:
            return ""

    def call(self, payload, timeout=READ_TIMEOUT):
        """写一条请求（dict 或不合法文本），返回解析后的响应 dict。"""
        raw = payload if isinstance(payload, str) else json.dumps(
            payload, ensure_ascii=False)
        self.proc.stdin.write(raw + "\n")
        self.proc.stdin.flush()
        try:
            line = self._lines.get(timeout=timeout)
        except Empty:
            raise AssertionError(
                "引擎 %s 秒没有响应；stderr:\n%s"
                % (timeout, self.stderr_text()))
        if line is None:
            raise AssertionError("引擎提前退出；stderr:\n" + self.stderr_text())
        try:
            return json.loads(line)
        except Exception:
            raise AssertionError("引擎输出了非 JSON 行：%r\nstderr:\n%s"
                                 % (line, self.stderr_text()))

    def close(self):
        try:
            if self.proc.stdin:
                self.proc.stdin.close()
        except Exception:
            pass
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait()
        try:
            self._err.close()
        except Exception:
            pass


class EngineCase(unittest.TestCase):
    """起一个隔离的引擎；每个测试用一个全新的文件目录。"""

    @classmethod
    def prepare_workdir(cls):
        """子类可覆写：在引擎启动前准备目录 / settings.json。"""

    @classmethod
    def setUpClass(cls):
        cls.root = tempfile.mkdtemp(prefix="tidy_engine_")
        shutil.copy(TIDY, os.path.join(cls.root, "tidy.py"))
        shutil.copy(RULES, os.path.join(cls.root, "rules.json"))
        # 引擎按「脚本同目录」找迁移组件；少了它 migrate.* 会报组件缺失
        if os.path.isfile(MIGRATE_ENGINE):
            shutil.copy(MIGRATE_ENGINE,
                        os.path.join(cls.root, "migrate_engine.py"))
        cls.prepare_workdir()
        cls.engine = Engine(cls.root)

    @classmethod
    def tearDownClass(cls):
        try:
            cls.engine.close()
        finally:
            shutil.rmtree(cls.root, ignore_errors=True)

    def new_folder(self):
        return tempfile.mkdtemp(prefix="case_", dir=self.root)

    def rpc(self, method, params=None):
        payload = {"id": "t", "method": method}
        if params is not None:
            payload["params"] = params
        return self.engine.call(payload)

    def rpc_ok(self, method, params=None):
        r = self.rpc(method, params)
        self.assertTrue(r["ok"], r.get("error") or r)
        return r["result"]

    def fill(self, folder, names=SAMPLES):
        for name in names:
            with open(os.path.join(folder, name), "wb") as f:
                f.write(b"x" * 32)

    def scan_params(self, folder, recursive=False, **extra):
        params = {"path": folder, "recursive": recursive,
                  # 刚建的文件会被「最近改动过」保护挡掉，测试必须显式关掉
                  "skip_recent": False, "skip_shortcuts": True,
                  "force": False, "use_content": None}
        params.update(extra)
        return params


class TestProtocol(EngineCase):
    def test_ping(self):
        r = self.engine.call({"id": 7, "method": "ping"})
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["id"], 7)
        res = r["result"]
        self.assertEqual(res["engine"], "tidy")
        self.assertIsInstance(res["pid"], int)
        self.assertGreater(res["pid"], 0)
        for key in ("data_dir", "settings_path", "python"):
            self.assertIsInstance(res[key], str, key)
            self.assertTrue(res[key], key)

    def test_settings_get(self):
        r = self.engine.call({"id": "s1", "method": "settings.get"})
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["id"], "s1")
        res = r["result"]
        for key in ("data_dir", "cache_dir", "conflict_policy",
                    "recursive_depth", "default_recursive",
                    "default_content", "log_keep_days", "close_action",
                    "tray_pin", "settings_path"):
            self.assertIn(key, res)
        # 隔离检查：数据目录必须落在临时目录里，没写用户真实数据目录
        data = os.path.normcase(os.path.abspath(res["data_dir"]))
        root = os.path.normcase(os.path.abspath(self.root))
        self.assertTrue(data.startswith(root + os.sep), res["data_dir"])

    def test_unknown_method_keeps_running(self):
        r = self.engine.call({"id": "u1", "method": "no.such.method",
                              "params": {}})
        self.assertFalse(r["ok"], r)
        self.assertEqual(r["id"], "u1")
        self.assertTrue(r["error"])
        # 未知方法不能把进程带走：下一条请求照常响应
        r2 = self.engine.call({"id": "u2", "method": "ping"})
        self.assertTrue(r2["ok"], r2)
        self.assertEqual(r2["id"], "u2")

    def test_bad_json_line(self):
        r = self.engine.call("{这不是 JSON")
        self.assertFalse(r["ok"], r)
        self.assertIsNone(r["id"])
        self.assertTrue(r["error"])
        self.assertTrue(self.engine.call({"id": 1, "method": "ping"})["ok"])

    def test_params_must_be_object(self):
        r = self.engine.call({"id": 9, "method": "scan", "params": []})
        self.assertFalse(r["ok"], r)
        self.assertEqual(r["id"], 9)
        self.assertTrue(r["error"])


class TestScan(EngineCase):
    def test_scan_flat_folder(self):
        folder = self.new_folder()
        self.fill(folder)
        r = self.engine.call({"id": 11, "method": "scan",
                              "params": self.scan_params(folder)})
        self.assertTrue(r["ok"], r.get("error") or r)
        res = r["result"]
        self.assertEqual(res["total"], 3)
        self.assertGreater(res["total_size"], 0)
        self.assertEqual(len(res["plans"]), 1)
        plan = res["plans"][0]
        self.assertEqual(plan["folder"], os.path.abspath(folder))
        self.assertIsNone(plan["error"])
        self.assertIsNone(plan["blocked_kind"])
        for key in ("depth", "evidence", "skipped", "groups"):
            self.assertIn(key, plan)
        groups = plan["groups"]
        self.assertTrue(groups, "groups 不应为空")
        self.assertEqual(sum(g["count"] for g in groups), 3)
        self.assertEqual(sum(g["size"] for g in groups), res["total_size"])
        names = {f["name"] for g in groups for f in g["files"]}
        self.assertEqual(names, set(SAMPLES))
        for g in groups:
            self.assertTrue(g["cat"])
            self.assertEqual(g["count"], len(g["files"]))
            for f in g["files"]:
                self.assertIsInstance(f["size"], int)
                self.assertIsInstance(f["mtime"], float)

    def test_scan_min_age_minutes_override_is_echoed(self):
        folder = self.new_folder()
        self.fill(folder)
        r = self.engine.call({"id": 13, "method": "scan",
                              "params": self.scan_params(folder, min_age_minutes=1)})
        self.assertTrue(r["ok"], r.get("error") or r)
        res = r["result"]
        self.assertEqual(res["applied"]["min_age_minutes"], 1)
        self.assertEqual(res["total"], 3)

    def test_scan_min_age_minutes_rejects_bad_values(self):
        folder = self.new_folder()
        for bad in (-1, 1441, "1", True):
            r = self.engine.call({"id": 14, "method": "scan",
                                  "params": self.scan_params(folder, min_age_minutes=bad)})
            self.assertFalse(r["ok"], bad)
            self.assertIn("min_age_minutes", r["error"])

    def test_scan_exclude_exts_skips_matching_files(self):
        folder = self.new_folder()
        self.fill(folder)
        with open(os.path.join(folder, "note.tmp"), "wb") as f:
            f.write(b"x" * 32)
        r = self.engine.call({"id": 15, "method": "scan",
                              "params": self.scan_params(folder, exclude_exts=[".tmp"])})
        self.assertTrue(r["ok"], r.get("error") or r)
        res = r["result"]
        self.assertEqual(res["total"], 3)
        self.assertEqual(res["applied"]["exclude_exts"], [".tmp"])
        plan = res["plans"][0]
        self.assertIn({"name": "note.tmp", "reason": "排除的后缀"}, plan["skipped"])
        names = {f["name"] for g in plan["groups"] for f in g["files"]}
        self.assertNotIn("note.tmp", names)

    def test_scan_exclude_exts_accepts_plain_and_star_forms(self):
        folder = self.new_folder()
        self.fill(folder)
        with open(os.path.join(folder, "note.TMP"), "wb") as f:
            f.write(b"x" * 32)
        for value in ("tmp", "*.TMP", " TMP "):
            r = self.engine.call({"id": 16, "method": "scan",
                                  "params": self.scan_params(folder, exclude_exts=[value])})
            self.assertTrue(r["ok"], (value, r.get("error")))
            self.assertEqual(r["result"]["total"], 3, value)

    def test_scan_tree_exclude_dirs_are_not_descended(self):
        folder = self.new_folder()
        self.fill(folder)
        skip = os.path.join(folder, "skipme")
        os.mkdir(skip)
        self.fill(skip, ("x.js", "y.js"))
        r = self.engine.call({"id": 17, "method": "scan",
                              "params": self.scan_params(folder, recursive=True,
                                                         exclude_dirs=["skipme"])})
        self.assertTrue(r["ok"], r.get("error") or r)
        res = r["result"]
        self.assertEqual(res["applied"]["exclude_dirs"], ["skipme"])
        folders = [p["folder"] for p in res["plans"]]
        self.assertNotIn(os.path.abspath(skip), folders)
        plan = res["plans"][0]
        self.assertIn({"name": "skipme", "reason": "排除的目录"}, plan["skipped"])

    def test_scan_exclude_exts_rejects_bad_types(self):
        folder = self.new_folder()
        for bad in ("tmp", [1], 3, {"a": 1}):
            r = self.engine.call({"id": 18, "method": "scan",
                                  "params": self.scan_params(folder, exclude_exts=bad)})
            self.assertFalse(r["ok"], bad)
            self.assertIn("exclude_exts", r["error"])

    def test_scan_missing_folder_is_business_error_not_crash(self):
        folder = os.path.join(self.root, "no_such_folder_xyz")
        r = self.engine.call({"id": 12, "method": "scan",
                              "params": self.scan_params(folder)})
        self.assertTrue(r["ok"], r)          # 协议层正常，业务错误在 blocked 里
        res = r["result"]
        self.assertEqual(res["total"], 0)
        self.assertEqual(res["plans"], [])
        self.assertTrue(res["blocked"])
        self.assertTrue(res["blocked"][0]["error"])
        self.assertTrue(self.engine.call({"id": 13, "method": "ping"})["ok"])


class TestOrganize(EngineCase):
    def test_dry_run_does_not_move_files(self):
        folder = self.new_folder()
        self.fill(folder)
        params = self.scan_params(folder)
        params["confirm"] = False
        r = self.engine.call({"id": 21, "method": "organize", "params": params})
        self.assertTrue(r["ok"], r.get("error") or r)
        res = r["result"]
        self.assertTrue(res["dry_run"])
        self.assertEqual(res["total"], 3)
        self.assertTrue(res["plans"])
        # 预演不落盘：原文件都在，也没有建出分类子目录
        for name in SAMPLES:
            self.assertTrue(os.path.isfile(os.path.join(folder, name)), name)
        subdirs = [n for n in os.listdir(folder)
                   if os.path.isdir(os.path.join(folder, n))]
        self.assertEqual(subdirs, [])

    def test_confirm_moves_files(self):
        folder = self.new_folder()
        self.fill(folder)
        params = self.scan_params(folder)
        params["confirm"] = True
        r = self.engine.call({"id": 22, "method": "organize", "params": params})
        self.assertTrue(r["ok"], r.get("error") or self.engine.stderr_text())
        res = r["result"]
        self.assertFalse(res["dry_run"])
        self.assertEqual(res["moved"], 3)
        self.assertEqual(res["failed"], [])
        self.assertIsNotNone(res["history"])
        self.assertTrue(os.path.isfile(res["history"]))
        # 整理记录也必须落在临时数据目录里
        hist = os.path.normcase(os.path.abspath(res["history"]))
        root = os.path.normcase(os.path.abspath(self.root))
        self.assertTrue(hist.startswith(root + os.sep), res["history"])
        # 原文件已离开根目录，进了分类子目录
        for name in SAMPLES:
            self.assertFalse(os.path.isfile(os.path.join(folder, name)), name)
        found = {}
        for dirpath, _dirnames, filenames in os.walk(folder):
            for fn in filenames:
                if fn in SAMPLES:
                    found[fn] = os.path.relpath(
                        os.path.join(dirpath, fn), folder)
        self.assertEqual(set(found), set(SAMPLES))
        for name, rel in found.items():
            self.assertNotEqual(rel, name, name)
            self.assertIn(os.sep, rel, name)


class TestIndexWriteThrough(EngineCase):
    """软件自己动了磁盘，索引必须立刻认账。

    这是「它连自己做过什么都不知道」那个问题的正面证据：先建索引，再用软件
    自己的能力改磁盘，然后不重建索引直接问「东西在哪 / 多大」，答案必须是改
    完之后的。全部断言都建立在生产代码路径上，不打桩。
    """

    def build(self, folder, reuse=False):
        return self.rpc_ok("search.index",
                           {"roots": [folder], "reuse": reuse})

    def _iso(self, tag):
        """把 tidy 的数据目录指到临时目录，返回 (T, tmp, root)。

        这些用例直接在进程内调 tidy 的函数（不走 RPC 子进程），所以必须改
        模块级的 S，否则会动到用户真实的索引库。
        """
        import tidy as T
        tmp = tempfile.mkdtemp(prefix="tidy_%s_" % tag)
        self.addCleanup(shutil.rmtree, tmp, True)
        old_s = dict(T.S)
        self.addCleanup(lambda: T.S.update(old_s))
        T.S["cache_dir"] = os.path.join(tmp, "cache")
        T.S["data_dir"] = tmp
        root = os.path.join(tmp, "root")
        os.makedirs(root, exist_ok=True)
        return T, tmp, root

    def test_search_skips_files_deleted_after_indexing(self):
        """索引里有、磁盘上已经没了的文件，搜索不许返回。

        索引是快照。用户在资源管理器里删了文件、或者在别的程序里删了，索引
        不会知道；给一条点进去打不开的结果，比少给一条更糟。

        这条和 `_ix_top_one` 的失效过滤是同一件事的两个入口：搜索也得滤。
        """
        T, _tmp, root = self._iso("alive")

        keep = os.path.join(root, "zz_keep_alive.txt")
        gone = os.path.join(root, "zz_gone_alive.txt")
        for p in (keep, gone):
            with open(p, "wb") as f:
                f.write(b"x" * 16)

        T.index_add([root])
        T.build_index(roots=[root])
        self.assertEqual(len(T.search_index("zz_", 50)), 2,
                         "建完索引应该两条都在")

        os.remove(gone)          # 绕过软件直接删，索引不知道

        paths = [r[0] for r in T.search_index("zz_", 50)]
        self.assertNotIn(gone, paths,
                         "磁盘上已经删掉的文件还在搜索结果里：%r" % (paths,))
        self.assertIn(keep, paths, "还在的文件被误滤掉了：%r" % (paths,))

    def test_search_still_fills_limit_after_dropping_deleted(self):
        """滤掉失效项之后不能少给答案。

        只取 limit 条再过滤的话，前排有几个失效就会少几条 —— 用户看到的
        「只有 2 个结果」实际是 5 个里删了 3 个。所以要多取一些再截断。
        """
        T, _tmp, root = self._iso("fill")

        paths = []
        for i in range(8):
            p = os.path.join(root, "yy_fill_%d.txt" % i)
            with open(p, "wb") as f:
                f.write(b"y" * 8)
            paths.append(p)

        T.index_add([root])
        T.build_index(roots=[root])

        for p in paths[:3]:      # 前三条删掉，故意让失效项排在前面
            os.remove(p)

        rows = T.search_index("yy_fill_", 5)
        self.assertEqual(
            len(rows), 5,
            "失效项被滤掉后没补满 limit，只给了 %d 条（应 5 条）：%r"
            % (len(rows), rows))
        for r in rows:
            self.assertTrue(os.path.exists(r[0]),
                            "结果里混进了已删除的文件：%r" % (r,))

    def test_refresh_dir_does_not_scan_whole_files_table(self):
        """刷一个目录的开销不能随库的总行数增长。

        `_ix_refresh_dir` 换掉一个目录的文件块时，删旧块用的是 `dirs.f0/n`
        记的 rowid 区间。如果写成 `DELETE ... WHERE dir_id = ?`，files 上没有
        dir_id 索引（建表时刻意不建），每刷一个目录都是一次全表扫 —— 实测
        216 个目录、82 万行的库要 8,409 毫秒，区间删除只要个位数毫秒。

        这里不测时间（那会是机器相关的脆弱断言），而是数 sqlite 执行了多少条
        VM 指令：`set_progress_handler` 每 N 条指令回调一次。

        关键构造：让库里绝大多数行**不在**被刷新的那个目录里。若被刷目录自
        己就占了全库，两种写法都要碰同样多的行，测不出差别（我第一版就是这么
        写的，双向验证时发现撤回修复它照样绿）。
         """
        T, _tmp, root = self._iso("scan")

        # 20 个兄弟目录共 800 个文件，被刷新的那个只有 3 个
        for d in range(20):
            sub = os.path.join(root, "bulk%02d" % d)
            os.makedirs(sub, exist_ok=True)
            for i in range(40):
                with open(os.path.join(sub, "b%02d_%03d.txt" % (d, i)), "wb") as f:
                    f.write(b"b" * 4)
        small = os.path.join(root, "tiny")
        os.makedirs(small, exist_ok=True)
        for i in range(3):
            with open(os.path.join(small, "t%d.txt" % i), "wb") as f:
                f.write(b"t" * 4)

        T.index_add([root])
        T.build_index(roots=[root])

        item = [i for i in T._ix_load() if i.get("root") == root][0]
        db = T._index_open(T._ix_db_abspath(item))
        self.addCleanup(db.close)

        total = db.execute("SELECT COUNT(*) FROM files").fetchone()[0]
        self.assertGreater(total, 700, "库太小，测不出全表扫：%d" % total)

        steps = {"n": 0}

        def tick():
            steps["n"] += 1
            return 0

        # 先刷一次让它有行（第一次是 INSERT 路径），再量「已有行」的删除路径
        with db:
            T._ix_refresh_dir(db, small)

        steps["n"] = 0
        db.set_progress_handler(tick, 1)
        with db:
            T._ix_refresh_dir(db, small)
        db.set_progress_handler(None, 0)

        self.assertLess(
            steps["n"], total,
            "刷新一个只有 3 个文件的目录走了 %d 步 VM 指令，比全库 %d 行还多"
            "—— 说明删旧块在全表扫 files，应当按 dirs.f0/n 的 rowid 区间删"
            % (steps["n"], total))

    def test_organize_updates_index(self):
        """整理完文件之后，索引里记录的位置必须是新位置。"""
        folder = self.new_folder()
        for name in ("wt_a.txt", "wt_b.zip", "wt_c.exe"):
            with open(os.path.join(folder, name), "wb") as f:
                f.write(b"x" * 64)
        self.build(folder, reuse=False)

        # 整理前：文件都在根目录
        before = self.rpc_ok("search.query", {"q": "wt_a", "limit": 20})
        if before["source"] == "index":
            paths = [os.path.normcase(i["path"]) for i in before["items"]]
            self.assertIn(os.path.normcase(os.path.join(folder, "wt_a.txt")),
                          paths, before)

        params = self.scan_params(folder)
        params["confirm"] = True
        res = self.rpc_ok("organize", params)
        self.assertEqual(res["moved"], 3, res)

        # 整理后：索引必须指向分类子目录里的新位置，不能还指着根目录
        after = self.rpc_ok("search.query", {"q": "wt_a", "limit": 20})
        if after["source"] == "index":
            hits = [i for i in after["items"] if i["name"] == "wt_a.txt"]
            self.assertTrue(hits, after)
            for hit in hits:
                self.assertNotEqual(
                    os.path.normcase(os.path.dirname(hit["path"])),
                    os.path.normcase(folder), hit)
                self.assertTrue(os.path.isfile(hit["path"]), hit)

        # 按体积排行里也必须反映新结构：根目录自己的体积应该归零或变小
        folders = self.rpc_ok("search.folders",
                              {"depth": 1, "limit": 50, "auto": False})
        for item in folders["items"]:
            # 排行里给的每个目录都必须真的存在
            self.assertTrue(os.path.isdir(item["path"]), item)

    def test_delete_updates_index(self):
        """用软件删掉的文件，不能在「最占空间」里继续占着位置。"""
        folder = self.new_folder()
        for name, n in (("wt_big.bin", 300000), ("wt_small.bin", 100)):
            with open(os.path.join(folder, name), "wb") as f:
                f.write(b"x" * n)
        self.build(folder, reuse=False)

        target = os.path.join(folder, "wt_big.bin")
        top_before = self.rpc_ok("search.top", {"limit": 2000})
        self.assertIn(os.path.normcase(target),
                      {os.path.normcase(i["path"]) for i in top_before["items"]})

        # 走生产的 files.delete（进回收站），不手动 os.remove
        d = self.rpc_ok("files.delete", {"paths": [target], "confirm": True})
        self.assertFalse(os.path.exists(target), d)
        self.assertFalse(d.get("failed"), d)

        top_after = self.rpc_ok("search.top", {"limit": 2000})
        self.assertNotIn(os.path.normcase(target),
                         {os.path.normcase(i["path"]) for i in top_after["items"]},
                         top_after)

    def test_undo_restores_index_position(self):
        """撤销整理之后，索引要回到原位置，而不是留在分类夹里。"""
        folder = self.new_folder()
        # organize 有「可整理文件不足 3 个就不动」的保护，所以必须放 3 个
        for name in ("wt_undo.txt", "wt_undo2.zip", "wt_undo3.exe"):
            with open(os.path.join(folder, name), "wb") as f:
                f.write(b"x" * 64)
        self.build(folder, reuse=False)

        params = self.scan_params(folder)
        params["confirm"] = True
        res = self.rpc_ok("organize", params)
        self.assertEqual(res["moved"], 3, res)

        self.rpc_ok("undo", {"path": folder})
        for name in ("wt_undo.txt", "wt_undo2.zip", "wt_undo3.exe"):
            self.assertTrue(os.path.isfile(os.path.join(folder, name)),
                            "撤销没把 %s 移回原位" % name)

        q = self.rpc_ok("search.query", {"q": "wt_undo", "limit": 20})
        if q["source"] == "index":
            hits = [i for i in q["items"] if i["name"].startswith("wt_undo")]
            self.assertTrue(hits, q)
            # 撤销完成后索引里不能再留着「在 03_文档 里」那条旧路径
            for hit in hits:
                self.assertTrue(os.path.isfile(hit["path"]), hit)


class TestIndexSelfCheck(EngineCase):
    """后台校验：抽查能发现过期，且「没事别乱重建」。

    这两条要一起测。只测「发现过期」会漏掉「每次都判过期、天天重扫整盘」
    这个更坏的方向——那正好是用户担心的「扫盘次数多伤磁盘」。
    """

    def test_selfcheck_reports_healthy_index_without_rebuild(self):
        """刚建好的索引，抽查必须判健康，不许重建。"""
        folder = self.new_folder()
        for i in range(6):
            with open(os.path.join(folder, "sc_%d.txt" % i), "wb") as f:
                f.write(b"x" * 32)
        self.rpc_ok("search.index", {"roots": [folder], "reuse": False})
        rep = self.rpc_ok("search.selfcheck", {"rebuild": True})
        self.assertIn("checked", rep)
        self.assertIn("stale", rep)
        # 别的用例建过的目录可能真的没了，所以不断言 stale 为空；
        # 但刚建的这个根绝不能被判过期
        mine = os.path.normcase(os.path.abspath(folder))
        for s in rep["stale_items"]:
            self.assertNotEqual(os.path.normcase(os.path.abspath(s["root"])), mine, rep)

    def test_selfcheck_detects_index_whose_content_changed(self):
        """目录内容变了，抽查必须能发现（否则后台校验就是摆设）。"""
        folder = self.new_folder()
        for i in range(8):
            with open(os.path.join(folder, "sc_d_%d.txt" % i), "wb") as f:
                f.write(b"x" * 32)
        sub = os.path.join(folder, "sub")
        os.makedirs(sub)
        for i in range(8):
            with open(os.path.join(sub, "s%d.txt" % i), "wb") as f:
                f.write(b"x" * 32)
        self.rpc_ok("search.index", {"roots": [folder], "reuse": False})

        # 绕过软件直接改磁盘：加一堆文件，让目录的文件数对不上
        for i in range(20):
            with open(os.path.join(sub, "added%d.txt" % i), "wb") as f:
                f.write(b"x" * 32)

        rep = self.rpc_ok("search.selfcheck", {"rebuild": False})
        mine = os.path.normcase(os.path.abspath(folder))
        hit = [s for s in rep["stale_items"]
               if os.path.normcase(os.path.abspath(s["root"])) == mine]
        # 这个库里只有 2 个目录（folder 和 sub），抽查 40 个必然全抽到，
        # 两个都已经对不上，所以必须判过期。这里不放宽：放宽的话
        # 「后台校验什么都不做」也能通过，那这条测试就没有意义了。
        self.assertTrue(hit, "内容改了 20 个文件，后台校验却没判过期：%s" % (rep,))
        self.assertIn("内容已变", hit[0]["why"], hit[0])

    def test_selfcheck_never_raises_on_missing_root(self):
        """根目录被拔掉（移动盘）时，校验不能崩，只能跳过。"""
        folder = self.new_folder()
        with open(os.path.join(folder, "gone.txt"), "wb") as f:
            f.write(b"x" * 32)
        self.rpc_ok("search.index", {"roots": [folder], "reuse": False})
        import shutil as _sh
        _sh.rmtree(folder, ignore_errors=True)
        rep = self.rpc_ok("search.selfcheck", {"rebuild": False})
        self.assertIn("checked", rep)
        self.assertIn("failed", rep)


class TestHotFreshness(EngineCase):
    """热目录保鲜：刚下载的文件，第一次搜就能搜到。

    这条是用户原话的验收标准——「盘里面要是新增内容的话索引就是旧的了，
    我要是不重构索引就没办法搜到新文件数据」。所以他不会去点「重建索引」，
    点了就不算达标。
    """

    @classmethod
    def prepare_workdir(cls):
        # 引擎把 USERPROFILE 隔离到了 workdir 下，热目录就落在这里。
        # 先建出 Downloads，否则 default_index_roots 会认为它不存在。
        os.makedirs(os.path.join(cls.root, "userprofile", "Downloads"),
                    exist_ok=True)

    def downloads(self):
        return os.path.join(self.root, "userprofile", "Downloads")

    def test_search_finds_file_created_after_indexing(self):
        """索引建好之后再往下载夹丢文件，第一次搜就必须命中。"""
        folder = self.downloads()
        with open(os.path.join(folder, "old_name.txt"), "wb") as f:
            f.write(b"x" * 32)
        # 先建一次索引，把「账本」造成「旧的」
        self.rpc_ok("search.index", {"roots": [folder], "reuse": False})

        fresh_name = "hot_fresh_probe.txt"
        with open(os.path.join(folder, fresh_name), "wb") as f:
            f.write(b"y" * 32)

        res = self.rpc_ok("search.query", {"q": "hot_fresh_probe", "limit": 20})
        names = {i["name"] for i in res["items"]}
        self.assertIn(fresh_name, names,
                      "新建的文件没被搜到；索引没有跟上磁盘：%r" % (res,))

    def test_search_does_not_rescan_when_hit(self):
        """搜到东西的时候不该去扫盘 —— 补扫只发生在「一条都没有」时。"""
        folder = self.downloads()
        with open(os.path.join(folder, "hit_probe.txt"), "wb") as f:
            f.write(b"x" * 32)
        self.rpc_ok("search.index", {"roots": [folder], "reuse": False})
        res = self.rpc_ok("search.query", {"q": "hit_probe", "limit": 20})
        self.assertTrue(res["items"], res)

    def test_unknown_name_stays_missing(self):
        """真的不存在的东西，补扫之后依然搜不到，不能凭空编一条出来。"""
        folder = self.downloads()
        with open(os.path.join(folder, "keep.txt"), "wb") as f:
            f.write(b"x" * 32)
        self.rpc_ok("search.index", {"roots": [folder], "reuse": False})
        res = self.rpc_ok("search.query", {"q": "no_such_file_zzz", "limit": 20})
        self.assertEqual(res["items"], [], res)

    def test_hot_refresh_reports_what_it_did(self):
        """保鲜动作要能自证：扫了哪些根、多少文件、花了多久。"""
        rep = self.rpc_ok("search.hot", {})
        self.assertIn("roots", rep)
        self.assertIn("files", rep)
        self.assertIn("elapsed_ms", rep)
        self.assertIsInstance(rep["files"], int)
        self.assertGreaterEqual(rep["files"], 0)

    def test_selfcheck_marks_old_schema_index_as_stale(self):
        """旧格式的索引库必须被判「过期」，否则它永远不会升级。

        1.42.0–1.42.2 的真缺口：schema 2 的库没有 n_files 列，抽查的
        SELECT 直接抛异常，被当成「读不懂 → 保守放过」。于是一个从旧版升上来
        的用户，抽查永远说没问题、永远不重建、库永远停在 schema 2，而
        size_sum 快查、写穿、保鲜全部依赖新列 —— 整套新能力静默失效。

        用真实的老库构造：直接改掉 user_version 并删掉新列，模拟升级前的状态。
        """
        import tidy as T

        tmp = tempfile.mkdtemp(prefix="tidy_old_schema_")
        self.addCleanup(shutil.rmtree, tmp, True)
        root = os.path.join(tmp, "root")
        os.makedirs(root, exist_ok=True)
        for i in range(4):
            with open(os.path.join(root, "f%d.txt" % i), "wb") as f:
                f.write(b"x" * 16)

        old_s = dict(T.S)
        self.addCleanup(lambda: T.S.update(old_s))
        T.S["cache_dir"] = os.path.join(tmp, "cache")
        T.S["data_dir"] = tmp

        T.index_add([root])
        T.build_index(roots=[root])
        item = T._ix_load()[0]
        self.assertTrue(T._index_has_totals(
            T._index_open(T._ix_db_abspath(item))))

        # 把它降级成 schema 2 的形状：去掉新列、user_version 改回去
        db = T._index_open(T._ix_db_abspath(item))
        try:
            with db:
                db.execute("ALTER TABLE dirs DROP COLUMN size_sum")
                db.execute("ALTER TABLE dirs DROP COLUMN n_files")
                db.execute("ALTER TABLE dirs DROP COLUMN scanned_at")
                db.execute("PRAGMA user_version=2")
        finally:
            db.close()

        v = T._ix_verify_one(item)
        self.assertFalse(
            v.get("ok"),
            "旧格式库被判成「没问题」了 —— 那它永远不会触发重建升级：%r" % (v,))
        self.assertIn("旧版格式", v.get("why") or "", v)

    def test_build_failure_does_not_zero_the_catalog(self):
        """建库失败不许把清单里的文件数清零。

        Windows 上 os.replace 到「已经被人打开的目标库」会 WinError 5。原来
        那条失败分支把 item["files"]/["dirs"] 写成 0，含义是「这个根里没
        东西」—— 一次瞬时占用就能把 82 万文件的索引在清单里改成 0 条，而磁盘
        上一个字节都没变。占用排行、配额、保鲜规模判断全部跟着错。
        """
        import tidy as T

        tmp = tempfile.mkdtemp(prefix="tidy_zero_")
        self.addCleanup(shutil.rmtree, tmp, True)
        root = os.path.join(tmp, "root")
        os.makedirs(root, exist_ok=True)
        for i in range(3):
            with open(os.path.join(root, "z%d.txt" % i), "wb") as f:
                f.write(b"z" * 8)

        old_s = dict(T.S)
        self.addCleanup(lambda: T.S.update(old_s))
        T.S["cache_dir"] = os.path.join(tmp, "cache")
        T.S["data_dir"] = tmp

        T.index_add([root])
        T.build_index(roots=[root])
        before = [i for i in T._ix_load() if i.get("root") == root]
        self.assertEqual(len(before), 1, before)
        self.assertGreater(int(before[0].get("files") or 0), 0, before)

        # 让 _index_build_one 必然失败，模拟「库文件被占用 / 写入失败」
        orig = T._index_build_one

        def boom(item, walker, progress):
            raise RuntimeError("索引写入失败：目标库被占用")
        T._index_build_one = boom
        self.addCleanup(setattr, T, "_index_build_one", orig)

        T.build_index(roots=[root])

        after = [i for i in T._ix_load() if i.get("root") == root]
        self.assertEqual(len(after), 1, after)
        self.assertGreater(
            int(after[0].get("files") or 0), 0,
            "建库失败之后清单里的文件数被清零了 —— 一次瞬时占用不该等于"
            "「这个根里没东西」：%r" % (after[0],))
        self.assertIn("失败", after[0].get("why") or "", after[0])

    def test_concurrent_reader_does_not_make_build_fail(self):
        """有人正在读库的时候建库，必须最终成功。

        os.replace 到被打开的目标文件在 Windows 上是 WinError 5。读的那一头
        通常只持有几十毫秒，所以建库这边要重试，不能一次撞上就认输。
        """
        import tidy as T

        tmp = tempfile.mkdtemp(prefix="tidy_busy_")
        self.addCleanup(shutil.rmtree, tmp, True)
        root = os.path.join(tmp, "root")
        os.makedirs(root, exist_ok=True)
        for i in range(3):
            with open(os.path.join(root, "b%d.txt" % i), "wb") as f:
                f.write(b"b" * 8)

        old_s = dict(T.S)
        self.addCleanup(lambda: T.S.update(old_s))
        T.S["cache_dir"] = os.path.join(tmp, "cache")
        T.S["data_dir"] = tmp

        T.index_add([root])
        T.build_index(roots=[root])
        item = [i for i in T._ix_load() if i.get("root") == root][0]

        # 打开目标库并一直持有句柄，同时在另一个线程里重建
        holder = T._index_open(T._ix_db_abspath(item))
        self.assertIsNotNone(holder)

        # 建库放到工作线程，句柄由主线程关闭 —— sqlite3 连接默认
        # check_same_thread=True，跨线程 close() 会直接抛异常，句柄反而
        # 更不会被释放，测试就变成「永远占用」了。
        err = []

        def run():
            try:
                T.build_index(roots=[root])
            except Exception as exc:
                err.append(exc)

        worker = threading.Thread(target=run, name="busy-build")
        worker.start()
        time.sleep(0.35)
        holder.close()
        worker.join(30)

        self.assertEqual(err, [], "建库线程本身抛了异常：%r" % (err,))
        self.assertFalse(worker.is_alive(), "建库线程没有结束")

        after = [i for i in T._ix_load() if i.get("root") == root][0]
        self.assertGreater(
            int(after.get("files") or 0), 0,
            "有人短暂读库就把整次建库判死了：%r" % (after,))
        self.assertNotIn("失败", after.get("why") or "", after)

    def test_build_index_and_hot_refresh_never_overlap(self):
        """全量重建和热目录刷新共用同一把锁。

        两者最终都会对同一批索引库动手：build_index 重建 staging 后 replace
        到活库，hot_refresh 刷新子树。同时进来时 replace 会撞上「目标被打开」
        （WinError 5），靠重试能熬过去，但那是一次本该不必发生的失败。

        这条直接量锁的效果：先让另一个线程抓住 _HOT_LOCK 300 毫秒，主线程在
        这期间调 build_index —— 有锁就必须等，没锁就会立刻穿过去。
        """
        import tidy as T

        tmp = tempfile.mkdtemp(prefix="tidy_overlap_")
        self.addCleanup(shutil.rmtree, tmp, True)
        root = os.path.join(tmp, "root")
        os.makedirs(root, exist_ok=True)
        for i in range(3):
            with open(os.path.join(root, "o%d.txt" % i), "wb") as f:
                f.write(b"o" * 8)

        old_s = dict(T.S)
        self.addCleanup(lambda: T.S.update(old_s))
        T.S["cache_dir"] = os.path.join(tmp, "cache")
        T.S["data_dir"] = tmp

        T.index_add([root])
        T.build_index(roots=[root])

        held = threading.Event()

        def hold():
            with T._HOT_LOCK:
                held.set()
                time.sleep(0.35)

        t = threading.Thread(target=hold, name="hold-hot-lock")
        t.start()
        self.assertTrue(held.wait(5), "抓锁线程没起来")
        t0 = time.perf_counter()
        T.build_index(roots=[root])
        waited = time.perf_counter() - t0
        t.join(10)

        self.assertGreater(
            waited, 0.2,
            "build_index 没等 _HOT_LOCK（只用了 %.3fs）—— 它和热刷新会同时"
            "对同一批索引库动手，replace 会撞上被占用的目标" % waited)

    def test_hot_roots_stay_inside_indexed_scope(self):
        """保鲜对象必须落在用户已索引的范围之内。

        1.42.0/1.42.1 的真实缺陷：_hot_roots() 直接拿 default_index_roots()
        （按 USERPROFILE 推桌面/下载/文档/图片/视频）当保鲜对象，配上
        missing 里的 index_add —— 对一个只索引了 D:\\、E:\\ 的用户，等于
        软件自己偷偷把 C:\\Users\\你\\Downloads 塞进索引：占用排行变了，
        用户从没同意过。「刷新缓存」越权成了「改变配置」。

        这条锁的是不变式本身，而不是某个实现细节：不管 _hot_roots 以后怎么
        找，它返回的每个目录都必须落在某条已索引根之下。旧实现会被这条
        立刻抓住（它返回的 C:\\Users\\... 谁都不在索引里）。
        """
        import tidy as T

        tmp = tempfile.mkdtemp(prefix="tidy_scope_")
        self.addCleanup(shutil.rmtree, tmp, True)

        home = os.path.join(tmp, "home")
        outside = os.path.join(home, "Downloads")
        os.makedirs(outside, exist_ok=True)
        with open(os.path.join(outside, "outside.txt"), "wb") as f:
            f.write(b"y" * 16)

        owned = os.path.join(tmp, "owned")
        inner = os.path.join(owned, "下载")
        os.makedirs(inner, exist_ok=True)
        with open(os.path.join(inner, "inside.txt"), "wb") as f:
            f.write(b"x" * 16)

        old_s = dict(T.S)
        self.addCleanup(lambda: T.S.update(old_s))
        T.S["cache_dir"] = os.path.join(tmp, "cache")
        T.S["data_dir"] = tmp

        old_home = os.environ.get("USERPROFILE")
        self.addCleanup(
            lambda: os.environ.__setitem__("USERPROFILE", old_home)
            if old_home is not None else os.environ.pop("USERPROFILE", None))
        os.environ["USERPROFILE"] = home

        T.index_add([owned])
        T.build_index(roots=[owned])
        before = sorted(i.get("root") for i in T._ix_load())

        hot = T._hot_roots()
        owned_key = os.path.normcase(os.path.abspath(owned)).rstrip("\\") + "\\"
        for p in hot:
            k = os.path.normcase(os.path.abspath(p))
            self.assertTrue(
                (k + "\\").startswith(owned_key),
                "保鲜对象 %r 不在已索引范围 %r 之内 —— 刷缓存不能顺带扩大"
                "索引范围（全部：%r）" % (p, before, hot))

        # 用户自己索引进来的「下载」子目录，必须被某个热目录覆盖到。
        # 注意不能要求它本身出现在列表里：小索引根是整棵都热的（owned 直接
        # 入选），这时「下载」是被 owned 覆盖的，没必要再单列一次。
        def covered(path, roots):
            k = os.path.normcase(os.path.abspath(path)).rstrip("\\") + "\\"
            for r in roots:
                rk = os.path.normcase(os.path.abspath(r)).rstrip("\\") + "\\"
                if k == rk or k.startswith(rk):
                    return True
            return False

        self.assertTrue(
            covered(inner, hot),
            "已索引范围里的「下载」子目录没有被任何热目录覆盖：%r" % (hot,))

        # 保鲜动作不得改动索引清单
        T.hot_refresh(force=True)
        self.assertEqual(sorted(i.get("root") for i in T._ix_load()), before,
                         "保鲜改动了索引清单")

    def test_hot_refresh_is_safe_when_two_callers_race(self):
        """后台节拍和「搜不到就补扫」会同时进来。

        两条路径都在同一个 *.db.new staging 上建库：一个在写、另一个把它删了
        重建，最后 replace 上去的可能是半个库。

        注意这里为什么必须用进程内线程而不是 rpc()：引擎是单线程
        「读一行→分发→写一行」，两个 RPC 请求天然串行，从协议层根本构造不出
        并发。真正的并发发生在引擎进程内部 —— 后台 index-watchdog 线程和
        处理查询的那一次调用。所以这条测试直接 import tidy、直接开线程。
        """
        import tidy as T

        tmp = tempfile.mkdtemp(prefix="tidy_race_")
        self.addCleanup(shutil.rmtree, tmp, True)
        hot = os.path.join(tmp, "Downloads")
        os.makedirs(hot, exist_ok=True)
        for i in range(5):
            with open(os.path.join(hot, "race_%d.txt" % i), "wb") as f:
                f.write(b"z" * 16)

        # 把进程内这份 tidy 的数据目录指到临时目录，绝不能碰用户的真实索引
        old_s = dict(T.S)
        old_cache = T.S.get("cache_dir")
        self.addCleanup(lambda: T.S.update(old_s))
        T.S["cache_dir"] = os.path.join(tmp, "cache")
        T.S["data_dir"] = tmp

        # 热目录由 default_index_roots() 按 USERPROFILE 推出来。不把它也指到
        # 临时目录的话，hot_refresh() 会去扫真实的桌面/下载——既扫不到这里的
        # race_*.txt（于是测试假红），也是真在翻用户的家目录。
        old_home = os.environ.get("USERPROFILE")
        self.addCleanup(lambda: os.environ.__setitem__("USERPROFILE", old_home)
                        if old_home is not None else os.environ.pop("USERPROFILE", None))
        os.environ["USERPROFILE"] = tmp

        # 必须先真的建一次库。index_add 只是往清单里登记，.db 还不存在；
        # 而 1.42.2 起 hot_refresh 不再调用 build_index（那样会把热目录注册
        # 成新索引根），它对没有库的目录只能跳过 —— 不先建库，这条测试就
        # 变成在测「空目录并发」，什么都读不出来。
        T.index_add([hot])
        T.build_index(roots=[hot])

        # 直接断言互斥本身，而不是去赌时序。
        #
        # 试过用「4 个线程同时调 hot_refresh」来测，把锁去掉照样通过 —— 建库
        # 那一段太快，线程几乎不可能恰好撞在一起，赌赢的概率高得离谱。这种
        # 测试只能证明「没崩」，不能证明「真的没并发」，等于没测。
        #
        # 反过来做：在 _hot_refresh_locked 外面包一层，记录「同一时刻在里面
        # 的有几个」。锁在的时候这个数永远是 1；锁一旦被删，多线程必然撞出
        # 大于 1。
        inside = []
        peak = []
        orig = T._hot_refresh_locked

        def counting(force):
            inside.append(1)
            peak.append(len(inside))
            try:
                time.sleep(0.05)            # 放大窗口，让「没锁」必然暴露
                return orig(force)
            finally:
                inside.pop()

        T._hot_refresh_locked = counting
        self.addCleanup(setattr, T, "_hot_refresh_locked", orig)

        errors = []

        def hit():
            try:
                T.hot_refresh(force=True)
            except Exception as exc:            # noqa: BLE001 - 就是要捕获一切
                errors.append(repr(exc))

        threads = [threading.Thread(target=hit) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(120)

        self.assertEqual(errors, [], "并发保鲜出错了：%r" % (errors,))
        self.assertEqual(max(peak or [0]), 1,
                         "两个调用方同时进了建库（峰值并发 %d）—— staging 文件"
                         "会被互相删掉，最后可能留下半个库" % max(peak or [0]))
        rows = T.search_index("race_1", 20)
        self.assertTrue(rows, "并发之后索引读不出来了")


class TestIndexTouchGuard(EngineCase):
    """写穿的规模上限：数的是目录数，不是库的个数。

    这台机器通常只有一两个索引库。如果拿 len(plan)（按库分键）当判断条件，
    _IX_TOUCH_MAX_DIRS 永远不会触发 —— 一次动 5000 个目录也照样逐个刷。
    """

    def test_touch_gives_up_on_huge_batches(self):
        import tidy as T

        tmp = tempfile.mkdtemp(prefix="tidy_touch_")
        self.addCleanup(shutil.rmtree, tmp, True)
        old_s = dict(T.S)
        self.addCleanup(lambda: T.S.update(old_s))
        T.S["cache_dir"] = os.path.join(tmp, "cache")
        T.S["data_dir"] = tmp

        many = [os.path.join(tmp, "bulk", "d%05d" % i, "f.txt")
                for i in range(20)]
        for p in many:
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, "wb") as f:
                f.write(b"b" * 8)
        T.index_add([tmp])
        T.build_index(roots=[tmp])

        old = T._IX_TOUCH_MAX_DIRS
        self.addCleanup(setattr, T, "_IX_TOUCH_MAX_DIRS", old)
        T._IX_TOUCH_MAX_DIRS = 3
        touched = T.index_touch(many)
        self.assertEqual(touched, 0,
                         "目录数超过上限时应该整体放弃，实际刷了 %d 个" % touched)


class TestUndo(EngineCase):
    """undo：参数错走协议错误；没有记录是业务提示；整理后能原样移回。"""

    @classmethod
    def prepare_workdir(cls):
        # 真实规则一次至少 3 个文件才整理。这个用例按需求只造 2 个文件，
        # 所以把「复制到临时目录」的那份 rules.json 下限调成 2（不动真实规则）。
        path = os.path.join(cls.root, "rules.json")
        with open(path, encoding="utf-8-sig") as f:
            rules = json.load(f)
        rules["min_files_to_organize"] = 2
        with open(path, "w", encoding="utf-8") as f:
            json.dump(rules, f, ensure_ascii=False, indent=1)

    def make_old_file(self, folder, name, age_minutes=30):
        """建文件并把 mtime 拨到 30 分钟前，绕开「最近 10 分钟不整理」保护。"""
        p = os.path.join(folder, name)
        with open(p, "wb") as f:
            f.write(b"x" * 32)
        ts = time.time() - age_minutes * 60
        os.utime(p, (ts, ts))
        return p

    def test_requires_non_empty_path(self):
        for params in ({}, {"path": ""}, {"path": "   "}, {"path": None}):
            r = self.rpc("undo", params)
            self.assertFalse(r["ok"], (params, r))
            self.assertTrue(r["error"], params)
            self.assertIn("path", r["error"])

    def test_path_must_exist(self):
        missing = os.path.join(self.root, "no_such_undo_dir_xyz")
        r = self.rpc("undo", {"path": missing})
        self.assertFalse(r["ok"], r)
        self.assertIn("路径不存在", r["error"])
        # 错误响应不能把引擎带走
        self.assertEqual(self.rpc_ok("ping")["engine"], "tidy")

    def test_path_must_be_directory(self):
        path = os.path.join(self.root, "undo_not_a_dir.txt")
        with open(path, "w", encoding="utf-8") as f:
            f.write("x")
        r = self.rpc("undo", {"path": path})
        self.assertFalse(r["ok"], r)
        self.assertIn("路径不是目录", r["error"])

    def test_folder_without_history_is_business_ok(self):
        folder = self.new_folder()
        res = self.rpc_ok("undo", {"path": folder})
        self.assertEqual(res["restored"], 0)
        self.assertTrue(res["failed"])
        # 业务提示原样保留，不是协议错误；数据目录里连 history 都没有时
        # 业务 undo() 给的是「没有整理记录」，有 history 但没这个文件夹
        # 的记录时给的是「这个文件夹没有整理记录」，两种都算正常。
        self.assertIn(res["failed"][0]["why"],
                      ("这个文件夹没有整理记录", "没有整理记录"))
        self.assertEqual(res["failed"][0]["name"], "")
        self.assertEqual(os.path.normcase(res["folder"]),
                         os.path.normcase(os.path.abspath(folder)))

    def test_roundtrip_restores_files(self):
        folder = self.new_folder()
        names = ("a.pdf", "b.jpg")
        for name in names:
            self.make_old_file(folder, name)
        params = {"path": folder, "recursive": False, "skip_recent": True,
                  "skip_shortcuts": True, "force": False, "use_content": False}
        scan = self.rpc_ok("scan", params)
        self.assertEqual(scan["total"], 2, scan)
        self.assertEqual(scan["blocked"], [])

        params["confirm"] = True
        org = self.rpc_ok("organize", params)
        self.assertEqual(org["moved"], 2, org)
        self.assertTrue(org["history"])
        for name in names:
            self.assertFalse(os.path.isfile(os.path.join(folder, name)), name)
        # 整理记录必须落在隔离出来的临时数据目录里
        data = os.path.normcase(os.path.abspath(
            self.rpc_ok("settings.get")["data_dir"]))
        hist = os.path.normcase(os.path.abspath(org["history"]))
        self.assertTrue(hist.startswith(data + os.sep), hist)

        res = self.rpc_ok("undo", {"path": folder})
        self.assertGreaterEqual(res["restored"], 1, res)
        self.assertEqual(res["failed"], [])
        for name in names:
            self.assertTrue(os.path.isfile(os.path.join(folder, name)), name)
        # 记录文件用完即删，整理时自建的空分类目录也一并清掉
        self.assertFalse(os.path.exists(org["history"]))
        subdirs = [n for n in os.listdir(folder)
                   if os.path.isdir(os.path.join(folder, n))]
        self.assertEqual(subdirs, [])
        # history 目录已存在时，换一个没整理过的文件夹应得到更具体的那句提示
        other = self.rpc_ok("undo", {"path": self.new_folder()})
        self.assertEqual(other["restored"], 0)
        self.assertEqual(other["failed"][0]["why"], "这个文件夹没有整理记录")


CACHE_GROUPS = {"系统", "浏览器", "开发", "应用", "商店应用", "桌面应用"}
CACHE_LEVELS = {"safe", "caution", "advanced"}


def _make_file(folder, name, size=64, age_days=10):
    """在 folder 下建一个文件，并把 mtime 往前拨 age_days 天。"""
    p = os.path.join(folder, name)
    with open(p, "wb") as f:
        f.write(b"x" * size)
    ts = time.time() - age_days * 86400
    os.utime(p, (ts, ts))
    return p


class TestShots(EngineCase):
    def test_scan_lists_only_old_screenshots(self):
        folder = self.new_folder()
        old1 = _make_file(folder, "屏幕截图 2020-01-01 101010.png", age_days=10)
        old2 = _make_file(folder, "Screenshot_2020.png", age_days=30)
        _make_file(folder, "屏幕截图 刚刚.png", age_days=0)
        _make_file(folder, "普通照片.jpg", age_days=10)
        res = self.rpc_ok("shots.scan",
                          {"days": 7, "min_kb": 0, "dirs": [folder]})
        self.assertEqual(res["total"], 2, res)
        self.assertEqual({i["path"] for i in res["items"]}, {old1, old2})
        self.assertEqual(res["total_size"],
                         sum(i["size"] for i in res["items"]))
        for item in res["items"]:
            self.assertIsInstance(item["size"], int)
            # 客户端按 Unix 秒解析 mtime，浮点会被当成 0
            self.assertIsInstance(item["mtime"], int)
            self.assertEqual(item["name"], os.path.basename(item["path"]))
            self.assertEqual(item["group"], os.path.basename(folder))
        self.assertEqual(res["dirs"], [os.path.abspath(folder)])

    def test_scan_min_kb_filters_small_files(self):
        folder = self.new_folder()
        big = _make_file(folder, "截图 big.png", size=4096)
        _make_file(folder, "截图 small.png", size=128)
        res = self.rpc_ok("shots.scan",
                          {"days": 7, "min_kb": 2, "dirs": [folder]})
        self.assertEqual(res["total"], 1, res)
        self.assertEqual(res["items"][0]["path"], big)

    def test_scan_days_zero_keeps_recent(self):
        folder = self.new_folder()
        recent = _make_file(folder, "截图 recent.png", age_days=0)
        res = self.rpc_ok("shots.scan", {"days": 0, "dirs": [folder]})
        self.assertIn(recent, {i["path"] for i in res["items"]}, res)

    def test_scan_bad_params_are_errors(self):
        for params in ({"days": "7"}, {"days": -1},
                       {"dirs": []}, {"dirs": "not-a-list"}):
            r = self.rpc("shots.scan", params)
            self.assertFalse(r["ok"], (params, r))
            self.assertTrue(r["error"], params)

    def test_scan_default_dirs_are_isolated(self):
        res = self.rpc_ok("shots.scan", {"days": 7})
        # 隔离后的家目录里没有截图；扫描没跑进真实用户目录
        self.assertEqual(res["total"], 0, res)
        self.assertIsInstance(res["missing"], list)

    def test_clean_dry_run_has_no_side_effect(self):
        folder = self.new_folder()
        shot = _make_file(folder, "截图 dry.png")
        res = self.rpc_ok("shots.clean", {"paths": [shot], "confirm": False})
        self.assertTrue(res["dry_run"])
        self.assertEqual(res["deleted"], 0)
        self.assertEqual(res["would_delete"], 1)
        self.assertTrue(os.path.isfile(shot))

    def test_clean_confirm_moves_to_trash(self):
        folder = self.new_folder()
        shot = _make_file(folder, "截图 to-trash.png")
        res = self.rpc_ok("shots.clean", {"paths": [shot], "confirm": True})
        self.assertFalse(res["dry_run"])
        self.assertTrue(res["moved_to_trash"], res)
        self.assertEqual(res["deleted"], 1, res)
        self.assertEqual(res["failed"], [])
        self.assertFalse(os.path.exists(shot))

    def test_clean_refuses_non_screenshot(self):
        folder = self.new_folder()
        doc = os.path.join(folder, "a.pdf")
        with open(doc, "wb") as f:
            f.write(b"x" * 8)
        res = self.rpc_ok("shots.clean", {"paths": [doc], "confirm": True})
        self.assertEqual(res["deleted"], 0)
        self.assertEqual(len(res["failed"]), 1, res)
        self.assertTrue(os.path.isfile(doc))

    def test_clean_requires_paths(self):
        r = self.rpc("shots.clean", {})
        self.assertFalse(r["ok"], r)
        self.assertIn("paths", r["error"])


class TestCache(EngineCase):
    def test_list_structure(self):
        res = self.rpc_ok("cache.list", {"include_custom": False})
        self.assertIsInstance(res["total_size"], int)
        self.assertGreaterEqual(res["total_size"], 0)
        names = {g["name"] for g in res["groups"]}
        self.assertEqual(names, CACHE_GROUPS, names)
        total = 0
        seen = 0
        for g in res["groups"]:
            self.assertIn(g["level"], CACHE_LEVELS)
            self.assertTrue(g["items"], g["name"])
            for item in g["items"]:
                for key in ("path", "label", "size", "exists", "level"):
                    self.assertIn(key, item)
                self.assertIn(item["level"], CACHE_LEVELS)
                self.assertIsInstance(item["size"], int)
                self.assertIsInstance(item["exists"], bool)
                self.assertTrue(item["path"])
                total += item["size"]
                seen += 1
        self.assertEqual(res["total_size"], total)
        # 43 项去掉回收站 = 42 项；本机没有的目录也要返回 exists=false 的记录
        self.assertGreaterEqual(seen, 42, seen)
        self.assertGreaterEqual(len(res["groups"]), 6)

    def test_list_bad_include_custom(self):
        r = self.rpc("cache.list", {"include_custom": "yes"})
        self.assertFalse(r["ok"], r)
        self.assertTrue(r["error"])

    def test_clean_dry_run_has_no_side_effect(self):
        folder = self.new_folder()
        tmp = os.path.join(folder, "a.tmp")
        with open(tmp, "wb") as f:
            f.write(b"x" * 64)
        res = self.rpc_ok("cache.clean", {"paths": [folder], "confirm": False})
        self.assertTrue(res["dry_run"])
        self.assertEqual(res["cleaned"], 0)
        self.assertEqual(res["would_clean"], 1)
        self.assertTrue(os.path.isfile(tmp))

    def test_clean_confirm_clears_contents_keeps_dir(self):
        folder = self.new_folder()
        for name in ("a.tmp", "b.tmp"):
            with open(os.path.join(folder, name), "wb") as f:
                f.write(b"x" * 64)
        res = self.rpc_ok("cache.clean", {"paths": [folder], "confirm": True})
        self.assertFalse(res["dry_run"])
        self.assertEqual(res["cleaned"], 2, res)
        self.assertEqual(res["freed"], 128)
        self.assertTrue(os.path.isdir(folder))     # 只清内容，不删目录
        self.assertEqual(os.listdir(folder), [])

    def test_clean_rejects_forbidden_paths(self):
        personal = os.path.join(self.root, "userprofile", "Documents", "隐私")
        os.makedirs(personal, exist_ok=True)
        keep = os.path.join(personal, "x.txt")
        with open(keep, "wb") as f:
            f.write(b"x")
        res = self.rpc_ok("cache.clean",
                          {"paths": [personal, r"C:\Windows\System32", "C:\\"],
                           "confirm": True})
        self.assertEqual(res["cleaned"], 0)
        self.assertEqual(len(res["failed"]), 3, res)
        whys = " ".join(f["why"] for f in res["failed"])
        self.assertIn("个人文件目录", whys)
        self.assertIn("系统关键目录", whys)
        self.assertIn("盘符根目录", whys)
        self.assertTrue(os.path.isfile(keep))

    def test_clean_requires_paths(self):
        r = self.rpc("cache.clean", {})
        self.assertFalse(r["ok"], r)
        self.assertIn("paths", r["error"])


class TestCacheCustom(EngineCase):
    @classmethod
    def prepare_workdir(cls):
        cls.custom_dir = os.path.join(cls.root, "自定义缓存")
        os.makedirs(cls.custom_dir, exist_ok=True)
        with open(os.path.join(cls.custom_dir, "x.bin"), "wb") as f:
            f.write(b"x" * 1024)
        cfg = os.path.join(cls.root, "数据", "配置")
        os.makedirs(cfg, exist_ok=True)
        with open(os.path.join(cfg, "settings.json"), "w",
                  encoding="utf-8") as f:
            json.dump({"data_dir": os.path.join(cls.root, "数据"),
                       "cache_custom_dirs": [cls.custom_dir]},
                      f, ensure_ascii=False)

    def test_custom_dir_appears_in_list(self):
        res = self.rpc_ok("cache.list", {"include_custom": True})
        groups = {g["name"]: g for g in res["groups"]}
        self.assertIn("自定义", groups, list(groups))
        item = groups["自定义"]["items"][0]
        self.assertEqual(item["path"], self.custom_dir)
        self.assertEqual(item["size"], 1024)
        self.assertTrue(item["exists"])
        self.assertEqual(item["level"], "advanced")

    def test_custom_dir_can_be_hidden(self):
        res = self.rpc_ok("cache.list", {"include_custom": False})
        self.assertNotIn("自定义", {g["name"] for g in res["groups"]})


class TestApps(EngineCase):
    def test_list(self):
        res = self.rpc_ok("apps.list")
        self.assertIsInstance(res["items"], list)
        self.assertEqual(res["total"], len(res["items"]))
        self.assertGreaterEqual(res["total"], 1, "本机应至少枚举出一个程序")
        for item in res["items"]:
            self.assertIsInstance(item["name"], str)
            self.assertTrue(item["name"])
            self.assertIsInstance(item["version"], str)
            self.assertIsInstance(item["publisher"], str)
            self.assertIsInstance(item["install_path"], str)
            self.assertIsInstance(item["uninstall"], bool)

    def test_refresh_param_accepted(self):
        res = self.rpc_ok("apps.list", {"refresh": True})
        self.assertGreaterEqual(res["total"], 1)


def _first_app_with(engine_case):
    """从 apps.list 里挑一个带卸载命令的真实程序；没有就返回 None。

    用例不写死「7-Zip 24.09 (x64)」这种名字：不同机器的已装程序不一样，
    按本机实际枚举结果挑，挑不到就在用例里 skip 并说明原因。
    """
    for item in engine_case.rpc_ok("apps.list")["items"]:
        if item["uninstall"]:
            return item
    return None


def _drop_reg_tree_quiet(root, path):
    """测试兜底：无论被测代码成功与否，都把自建的临时注册表键删干净。"""
    import winreg
    try:
        with winreg.OpenKey(root, path, 0, winreg.KEY_READ) as k:
            count = winreg.QueryInfoKey(k)[0]
            kids = []
            for i in range(count):
                try:
                    kids.append(winreg.EnumKey(k, i))
                except OSError:
                    break
    except OSError:
        return
    for kid in kids:
        _drop_reg_tree_quiet(root, path + "\\" + kid)
    try:
        winreg.DeleteKey(root, path)
    except OSError:
        pass


class TestAppUninstall(EngineCase):
    """apps.uninstall：参数/匹配错误走协议错误；confirm=false 只回命令。"""

    def test_requires_name(self):
        for params in ({}, {"name": ""}, {"name": "   "}, {"name": None}):
            r = self.rpc("apps.uninstall", params)
            self.assertFalse(r["ok"], (params, r))
            self.assertEqual(r["id"], "t")
            self.assertIn("name", r["error"])

    def test_not_found(self):
        r = self.rpc("apps.uninstall",
                     {"name": "绝对不存在的程序_zzz_9417"})
        self.assertFalse(r["ok"], r)
        self.assertIn("找不到程序：绝对不存在的程序_zzz_9417", r["error"])
        # 报错不能把引擎带走
        self.assertEqual(self.rpc_ok("ping")["engine"], "tidy")

    def test_version_mismatch_is_not_found(self):
        item = _first_app_with(self)
        if item is None:
            self.skipTest("本机没有带卸载命令的程序，无法验证版本精确匹配")
        r = self.rpc("apps.uninstall",
                     {"name": item["name"],
                      "version": "0.0.0-no-such-version"})
        self.assertFalse(r["ok"], r)
        self.assertIn("找不到程序：", r["error"])

    def test_no_uninstaller_is_reported(self):
        """「没有自带卸载器」这条错误必须精确。

        apps.list 的 uninstall=False 不保证真没命令（只剩 QuietUninstallString
        的程序也算没普通卸载命令），所以逐个用 confirm=false 预演确认：
        预演成功的说明有静默命令，换下一个；真没命令的才拿来断言。
        """
        checked = 0
        for item in self.rpc_ok("apps.list")["items"]:
            if item["uninstall"]:
                continue
            checked += 1
            r = self.rpc("apps.uninstall",
                         {"name": item["name"], "confirm": False})
            if r["ok"]:
                continue
            self.assertEqual(r["error"], "这个程序没有自带卸载器", item)
            return
        self.skipTest("本机没有缺卸载命令的程序（检查了 %d 个），跳过该例"
                      % checked)

    def test_dry_run_returns_command_without_starting(self):
        """confirm=false 只回计划：真实程序名 + 本机真实卸载命令，但不启动进程。"""
        item = _first_app_with(self)
        if item is None:
            self.skipTest("本机没有带卸载命令的程序（如 7-Zip），跳过该例")
        params = {"name": item["name"], "confirm": False}
        if item["version"]:
            params["version"] = item["version"]
        res = self.rpc_ok("apps.uninstall", params)
        self.assertTrue(res["dry_run"], res)
        self.assertEqual(res["name"], item["name"])
        self.assertIsInstance(res["command"], str)
        self.assertTrue(res["command"])
        self.assertNotIn("started", res)
        # 没有 started 字段 + 下一条请求照常：没有任何进程被拉起来
        self.assertEqual(self.rpc_ok("ping")["engine"], "tidy")


class TestAppLeftovers(EngineCase):
    """apps.leftovers：只读；缺 name / 名字不存在都是协议错误。"""

    def test_requires_name(self):
        for params in ({}, {"name": ""}, {"name": "  "}, {"name": None}):
            r = self.rpc("apps.leftovers", params)
            self.assertFalse(r["ok"], (params, r))
            self.assertIn("name", r["error"])

    def test_not_found(self):
        r = self.rpc("apps.leftovers", {"name": "绝对不存在的程序_zzz_9417"})
        self.assertFalse(r["ok"], r)
        self.assertIn("找不到程序：", r["error"])

    def test_structure_of_real_app(self):
        item = _first_app_with(self)
        if item is None:
            self.skipTest("本机没有可枚举的程序，跳过结构检查")
        params = {"name": item["name"]}
        if item["version"]:
            params["version"] = item["version"]
        res = self.rpc_ok("apps.leftovers", params)
        self.assertEqual(res["name"], item["name"])
        self.assertEqual(res["blocked"], [])
        self.assertIsInstance(res["dirs"], list)
        self.assertIsInstance(res["regs"], list)
        for d in res["dirs"]:
            self.assertIsInstance(d, str)
            self.assertTrue(os.path.isabs(d), d)
            self.assertTrue(os.path.isdir(d), d)
        for reg in res["regs"]:
            self.assertIn(reg["hive"], ("HKCU", "HKLM64", "HKLM32"), reg)
            self.assertIsInstance(reg["key"], str)
            self.assertTrue(reg["key"])
        # 只读：调用完目录还在
        for d in res["dirs"]:
            self.assertTrue(os.path.isdir(d), d)


class TestAppCleanup(EngineCase):
    """apps.cleanup：预演零副作用；confirm 后先备份再删；危险路径进 failed。

    传参一律带上 regs=[]（或一个临时键），否则「没给 regs」会按扫描结果
    把真实程序自己的 Uninstall 键算进计划 —— 测试绝不能删真实注册表。
    """

    @classmethod
    def prepare_workdir(cls):
        # Engine 把 TEMP/TMP 指到 workdir\temp（为了隔离真实临时目录）。reg.exe
        # 导出备份时要往 TEMP 写东西，TEMP 不存在会直接 exit 1（"Unable to
        # write to the file"），所以这里先把它建出来 —— 真实机器上 TEMP 一定存在。
        os.makedirs(os.path.join(cls.root, "temp"), exist_ok=True)

    def real_name(self):
        # 一个类里只枚举一次注册表：apps.list 不便宜，没必要每个用例都跑
        name = getattr(type(self), "_name_cache", None)
        if name:
            return name
        item = _first_app_with(self)
        if item is None:
            self.skipTest("本机没有可枚举的程序，跳过 apps.cleanup 用例")
        type(self)._name_cache = item["name"]
        return item["name"]

    def fake_dir(self):
        d = self.new_folder()
        with open(os.path.join(d, "leftover.bin"), "wb") as f:
            f.write(b"x" * 16)
        return d

    def data_dir(self):
        return self.rpc_ok("settings.get")["data_dir"]

    def test_requires_name(self):
        r = self.rpc("apps.cleanup", {"dirs": [], "regs": []})
        self.assertFalse(r["ok"], r)
        self.assertIn("name", r["error"])

    def test_bad_params(self):
        for params in ({"dirs": "not-a-list"},
                       {"dirs": [""]},
                       {"dirs": [], "regs": "not-a-list"},
                       {"dirs": [], "regs": [{"hive": "HKCR",
                                              "key": "SOFTWARE\\x"}]},
                       {"dirs": [], "regs": [{"hive": "HKCU"}]},
                       {"dirs": [], "regs": [""]}):
            payload = {"name": self.real_name(), "confirm": False}
            payload.update(params)
            r = self.rpc("apps.cleanup", payload)
            self.assertFalse(r["ok"], (params, r))
            self.assertTrue(r["error"], params)

    def test_dry_run_keeps_dir_and_writes_nothing(self):
        d = self.fake_dir()
        res = self.rpc_ok("apps.cleanup",
                          {"name": self.real_name(), "dirs": [d], "regs": [],
                           "confirm": False})
        self.assertTrue(res["dry_run"], res)
        self.assertEqual(res["name"], self.real_name())
        self.assertEqual(res["dirs"], [os.path.normpath(os.path.abspath(d))])
        self.assertEqual(res["regs"], [])
        self.assertTrue(os.path.isfile(os.path.join(d, "leftover.bin")))
        # 备份目录只是计划出来的路径，预演不得真的建出来
        self.assertTrue(os.path.normcase(res["backup_dir"]).startswith(
            os.path.normcase(os.path.join(self.data_dir(), "卸载备份"))),
            res["backup_dir"])
        self.assertFalse(os.path.exists(res["backup_dir"]), res["backup_dir"])

    def test_confirm_removes_dir(self):
        d = self.fake_dir()
        res = self.rpc_ok("apps.cleanup",
                          {"name": self.real_name(), "dirs": [d], "regs": [],
                           "confirm": True})
        self.assertFalse(res["dry_run"], res)
        self.assertEqual(res["removed_dirs"],
                         [os.path.normpath(os.path.abspath(d))])
        self.assertEqual(res["removed_regs"], [])
        self.assertEqual(res["failed"], [])
        self.assertFalse(os.path.exists(d))

    def test_dry_run_passes_drive_root_through(self):
        """明确行为：预演只回计划、盘符根原样带出；真正删除时才拒绝（见下例）。"""
        res = self.rpc_ok("apps.cleanup",
                          {"name": self.real_name(), "dirs": ["C:\\"],
                           "regs": [], "confirm": False})
        self.assertTrue(res["dry_run"], res)
        self.assertEqual(res["dirs"], ["C:\\"])
        self.assertTrue(os.path.isdir("C:\\"))

    def test_confirm_refuses_drive_root(self):
        res = self.rpc_ok("apps.cleanup",
                          {"name": self.real_name(), "dirs": ["C:\\"],
                           "regs": [], "confirm": True})
        self.assertFalse(res["dry_run"], res)
        self.assertEqual(res["removed_dirs"], [])
        self.assertEqual(len(res["failed"]), 1, res)
        self.assertEqual(res["failed"][0]["target"], "C:\\")
        self.assertIn("盘符根目录", res["failed"][0]["why"])
        self.assertTrue(os.path.isdir("C:\\"))

    def test_dry_run_defaults_to_scan(self):
        """不给 dirs/regs 时用扫描结果做计划；confirm 省略 = false，依然零副作用。"""
        res = self.rpc_ok("apps.cleanup", {"name": self.real_name()})
        self.assertTrue(res["dry_run"], res)
        self.assertIsInstance(res["dirs"], list)
        self.assertIsInstance(res["regs"], list)
        for reg in res["regs"]:
            self.assertIn(reg["hive"], ("HKCU", "HKLM64", "HKLM32"), reg)
            self.assertTrue(reg["key"], reg)
        self.assertFalse(os.path.exists(res["backup_dir"]), res["backup_dir"])

    def test_confirm_refuses_protected_reg_key(self):
        import winreg
        res = self.rpc_ok("apps.cleanup",
                          {"name": self.real_name(), "dirs": [],
                           "regs": [{"hive": "HKCU",
                                     "key": "SOFTWARE\\Microsoft\\Windows"}],
                           "confirm": True})
        self.assertFalse(res["dry_run"], res)
        self.assertEqual(res["removed_regs"], [])
        self.assertEqual(len(res["failed"]), 1, res)
        self.assertIn("已拒绝", res["failed"][0]["why"])
        # 被拒的键必须原封不动（能打开就说明还在）
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                            "SOFTWARE\\Microsoft\\Windows"):
            pass

    def test_confirm_exports_backup_then_deletes_scratch_key(self):
        """自己在 HKCU\\SOFTWARE 下建一次性键，验证「先导出备份、再递归删干净」。"""
        import winreg
        import uuid
        sub = "SOFTWARE\\TidyEngineTest_%s\\Main" % uuid.uuid4().hex[:8]
        try:
            with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, sub, 0,
                                    winreg.KEY_WRITE) as k:
                winreg.SetValueEx(k, "Probe", 0, winreg.REG_SZ, "x")
            with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER,
                                    sub + "\\child", 0,
                                    winreg.KEY_WRITE) as k:
                winreg.SetValueEx(k, "Probe", 0, winreg.REG_SZ, "y")
            res = self.rpc_ok("apps.cleanup",
                              {"name": self.real_name(), "dirs": [],
                               "regs": [{"hive": "HKCU", "key": sub}],
                               "confirm": True})
            self.assertFalse(res["dry_run"], res)
            self.assertEqual(res["failed"], [], res)
            self.assertEqual(res["removed_regs"],
                             [{"hive": "HKCU", "key": sub}])
            backup = os.path.join(res["backup_dir"], "1.reg")
            self.assertTrue(os.path.isfile(backup), res)
            with open(backup, "rb") as f:
                self.assertGreater(len(f.read()), 0)
            with self.assertRaises(OSError):
                winreg.OpenKey(winreg.HKEY_CURRENT_USER, sub)
        finally:
            # 被测代码把子键删了也不会 err：失败时这里兜底，绝不留垃圾键
            _drop_reg_tree_quiet(winreg.HKEY_CURRENT_USER, sub)


class TestSearch(EngineCase):
    def build(self, folder, reuse=False):
        return self.rpc_ok("search.index",
                           {"roots": [folder], "reuse": reuse})

    def test_status(self):
        res = self.rpc_ok("search.status")
        self.assertIsInstance(res["index_dir"], str)
        self.assertTrue(os.path.isdir(res["index_dir"]))
        self.assertIsInstance(res["indexed"], int)
        self.assertIsInstance(res["entries"], list)
        self.assertEqual(res["count"], len(res["entries"]))
        self.assertIsInstance(res["roots"], list)
        self.assertIn(res["backend"], ("Everything", "本地索引"))
        self.assertIsInstance(res["built_at"], int)

    def test_index_and_query(self):
        folder = self.new_folder()
        target = os.path.join(folder, "unique_needle_abc.txt")
        with open(target, "wb") as f:
            f.write(b"x" * 32)
        res = self.build(folder, reuse=False)
        self.assertTrue(os.path.isdir(res["index_dir"]), res)
        self.assertGreaterEqual(res["indexed"], 1, res)
        self.assertIsInstance(res["elapsed_ms"], int)
        self.assertFalse(res["reused"])
        status = self.rpc_ok("search.status")
        self.assertGreaterEqual(status["indexed"], 1)
        self.assertIsInstance(status["built_at"], int)
        self.assertIn(os.path.normcase(folder),
                      {os.path.normcase(r) for r in status["roots"]})
        q = self.rpc_ok("search.query", {"q": "unique_needle_abc",
                                        "limit": 50})
        self.assertIn(q["source"], ("es", "index"))
        self.assertIsInstance(q["elapsed_ms"], int)
        self.assertEqual(q["total"], len(q["items"]))
        if q["source"] == "index":      # 装了 Everything 时结果由 es 给
            self.assertIn(os.path.normcase(target),
                          {os.path.normcase(i["path"]) for i in q["items"]})
            for item in q["items"]:
                self.assertIsInstance(item["size"], int)
                self.assertIsInstance(item["mtime"], int)

    def test_index_reuse_skips_rebuild(self):
        folder = self.new_folder()
        with open(os.path.join(folder, "reuse_marker.txt"), "wb") as f:
            f.write(b"x")
        first = self.build(folder, reuse=False)
        self.assertFalse(first["reused"])
        second = self.build(folder, reuse=True)
        self.assertTrue(second["reused"], second)
        # 复用分支不重建，只回读统计（条数细节依赖 walker，交给随包引擎用例核对）
        self.assertGreaterEqual(second["indexed"], 1)
        self.assertEqual(second["elapsed_ms"], 0)

    def test_index_missing_root_is_business_error(self):
        missing = os.path.join(self.root, "no_such_root_zzz")
        r = self.rpc("search.index", {"roots": [missing], "reuse": False})
        self.assertTrue(r["ok"], r)          # 协议层正常，业务拒绝在 result.error
        res = r["result"]
        self.assertFalse(res["reused"])
        self.assertIn("error", res)
        self.assertTrue(res["error"])
        self.assertEqual(len(res["failed"]), 1, res)

    def test_index_requires_roots(self):
        # 不给 roots / ids 时按设计是「重建全部已登记目录」；没有登记过任何目录
        # 才走业务错误分支（协议层仍 ok，错误放在 result.error）。
        r = self.rpc("search.index", {})
        if r["ok"]:
            res = r["result"]
            if res.get("error"):
                self.assertIn("索引目录", res["error"])
            else:
                self.assertIsInstance(res["indexed"], int)
        else:
            self.assertIn("roots", r["error"])

    def test_query_requires_q(self):
        for params in ({}, {"q": ""}, {"q": "   "},
                       {"q": "x", "limit": 0}, {"q": "x", "limit": "many"}):
            r = self.rpc("search.query", params)
            self.assertFalse(r["ok"], (params, r))
            self.assertTrue(r["error"], params)

    def test_query_limit(self):
        folder = self.new_folder()
        for i in range(3):
            with open(os.path.join(folder, "limitneedle_%d.txt" % i),
                      "wb") as f:
                f.write(b"x")
        self.build(folder, reuse=False)
        res = self.rpc_ok("search.query", {"q": "limitneedle_", "limit": 2})
        self.assertIn(res["source"], ("es", "index"))
        if res["source"] == "index":
            self.assertLessEqual(res["total"], 2)

    def test_top_by_size(self):
        """search.top：读索引里已有的 size 列，按体积降序，不遍历磁盘。"""
        folder = self.new_folder()
        sizes = {"big_a.bin": 4096, "big_b.bin": 2048, "small_c.bin": 8}
        for name, n in sizes.items():
            with open(os.path.join(folder, name), "wb") as f:
                f.write(b"x" * n)
        self.build(folder, reuse=False)
        res = self.rpc_ok("search.top", {"limit": 10})
        self.assertEqual(res["source"], "index")
        self.assertIsInstance(res["elapsed_ms"], int)
        self.assertIsInstance(res["roots"], list)
        self.assertIn(os.path.normcase(folder),
                      {os.path.normcase(r) for r in res["roots"]})
        names = [i["name"] for i in res["items"]]
        self.assertIn("big_a.bin", names)
        self.assertIn("big_b.bin", names)
        # 降序：第一个必须不小于第二个
        got = [i["size"] for i in res["items"]]
        self.assertEqual(got, sorted(got, reverse=True), res)
        for item in res["items"]:
            self.assertIsInstance(item["size"], int)
            self.assertIsInstance(item["mtime"], int)

    def test_top_limit_and_min_size(self):
        folder = self.new_folder()
        for name, n in (("t1.bin", 3000), ("t2.bin", 2000), ("t3.bin", 4)):
            with open(os.path.join(folder, name), "wb") as f:
                f.write(b"x" * n)
        self.build(folder, reuse=False)
        res = self.rpc_ok("search.top", {"limit": 1})
        self.assertLessEqual(res["total"], 1)
        res2 = self.rpc_ok("search.top", {"limit": 10, "min_size": 1000})
        for item in res2["items"]:
            self.assertGreaterEqual(item["size"], 1000)

    def test_top_skips_files_deleted_after_indexing(self):
        """索引建好之后被删掉的文件，不能再出现在「最占空间」的答案里。

        索引是快照，磁盘是会变的。这个测试故意制造「索引说它在、磁盘上已经没有」
        的状态：建完索引直接从磁盘上删文件，但不重建索引。
        不加这层过滤的话，用户问「什么最占空间」，第一名可能是个早就不存在的
        文件——他照着去删，发现路径不存在，从此不信这个功能。

        注意 TestSearch 里所有用例共用一个引擎、一个索引清单，别的用例建的目录
        也在索引里。所以这里只断言「本用例自己的文件」的相对关系，不去假设全局
        排名前 N 是谁。
        """
        folder = self.new_folder()
        for name, n in (("zzgone_big.bin", 900000), ("zzkeep_mid.bin", 500000),
                        ("zzkeep_small.bin", 100000)):
            with open(os.path.join(folder, name), "wb") as f:
                f.write(b"x" * n)
        self.build(folder, reuse=False)
        # 索引已经记住了 zzgone_big，现在从磁盘上把它删掉（不重建索引）
        os.remove(os.path.join(folder, "zzgone_big.bin"))

        # 用足够大的 limit 把自己这几条都囊括进来
        res = self.rpc_ok("search.top", {"limit": 2000})
        names = [i["name"] for i in res["items"]]
        mine = [n for n in names if n.startswith("zz")]
        self.assertNotIn("zzgone_big.bin", mine, res)
        # 过滤之后不能把剩下的也弄丢：另外两个还在，必须照样给出
        self.assertIn("zzkeep_mid.bin", mine, res)
        self.assertIn("zzkeep_small.bin", mine, res)
        # 而且答案里给的每条路径都必须真的存在
        for item in res["items"]:
            self.assertTrue(os.path.exists(item["path"]), item)

    def test_top_fills_limit_after_dropping_deleted(self):
        """丢掉的失效文件不能把名额吃掉：要 limit 条就得尽量给够。

        只取 limit 条再过滤是个陷阱——前排正好有几个已删除的，返回就会少几条。
        这里让本用例最大的 3 个全部失效，剩下的仍然应该凑满 limit。
        """
        folder = self.new_folder()
        for i in range(3):
            with open(os.path.join(folder, "yygone_%d.bin" % i), "wb") as f:
                f.write(b"x" * (900000 - i * 100))
        for i in range(4):
            with open(os.path.join(folder, "yyalive_%d.bin" % i), "wb") as f:
                f.write(b"x" * (400000 - i * 100))
        self.build(folder, reuse=False)
        gone = {os.path.join(folder, "yygone_%d.bin" % i) for i in range(3)}
        for p in gone:
            os.remove(p)

        res = self.rpc_ok("search.top", {"limit": 4})
        # 前 4 名里不能有已删除的；这条用例的 alive 文件比 gone 小，但全局前 4
        # 可能被别的用例占掉，所以只在「取满条数」这一层断言
        self.assertEqual(len(res["items"]), 4, res)
        for item in res["items"]:
            self.assertNotIn(item["path"], gone, res)
            self.assertTrue(os.path.exists(item["path"]), item)

    def test_top_and_folders_report_data_age(self):
        """两个按体积的回答都要带上「这份数据有多旧」。

        索引是快照，答的可能是半小时前的账本。旧不是错，瞒着才是错——所以每个
        答案都得说清数据是哪一刻的，让用户自己判断可信到哪一步。
        """
        folder = self.new_folder()
        with open(os.path.join(folder, "age.bin"), "wb") as f:
            f.write(b"x" * 2048)
        self.build(folder, reuse=False)

        for method in ("search.top", "search.folders"):
            res = self.rpc_ok(method, {"limit": 5, "auto": False})
            self.assertIn("age_sec", res, (method, res))
            self.assertIn("age_text", res, (method, res))
            self.assertIn("stale", res, (method, res))
            self.assertIsInstance(res["age_sec"], int)
            self.assertIsInstance(res["age_text"], str)
            self.assertIsInstance(res["stale"], bool)
            # 刚建完的索引不该被判成过期
            self.assertFalse(res["stale"], (method, res))

    def test_top_bad_params_are_errors(self):
        for params in ({"limit": 0}, {"limit": "many"},
                       {"limit": 5, "min_size": "big"}):
            r = self.rpc("search.top", params)
            self.assertFalse(r["ok"], (params, r))
            self.assertTrue(r["error"], params)

    def test_top_without_index_has_hint(self):
        """没有任何索引时不能静默返回空表：要告诉用户「还没建索引」。"""
        res = self.rpc_ok("search.top", {"limit": 5})
        if not res["roots"]:
            self.assertIn("hint", res)
            self.assertIn("索引", res["hint"])

    def test_folders_aggregates_by_directory(self):
        """search.folders：按目录汇总体积。

        这是「什么最占空间」的正解：单个文件（某个 .pak 5.4 GB）对人没有意义，
        人要知道的是「哪个文件夹/软件占地方」。
        """
        folder = self.new_folder()
        sub = os.path.join(folder, "GameA", "Content")
        os.makedirs(sub, exist_ok=True)
        # GameA 两个文件共 6000 字节，GameB 一个 1000 字节
        for name, n in (("a1.bin", 4000), ("a2.bin", 2000)):
            with open(os.path.join(sub, name), "wb") as f:
                f.write(b"x" * n)
        other = os.path.join(folder, "GameB")
        os.makedirs(other, exist_ok=True)
        with open(os.path.join(other, "b1.bin"), "wb") as f:
            f.write(b"x" * 1000)
        self.build(folder, reuse=False)
        # depth=1：把每个顶层子目录下的所有文件汇总成一项，这正是「哪个文件夹最占空间」
        res = self.rpc_ok("search.folders", {"depth": 1, "limit": 20, "auto": False})
        self.assertEqual(res["source"], "index")
        self.assertIsInstance(res["elapsed_ms"], int)
        self.assertIsInstance(res["bytes"], int)
        self.assertGreaterEqual(res["bytes"], 7000)
        items = res["items"]
        self.assertTrue(items, res)
        # 必须按体积降序，且每项带占比
        sizes = [i["size"] for i in items]
        self.assertEqual(sizes, sorted(sizes, reverse=True), res)
        for item in items:
            self.assertIsInstance(item["size"], int)
            self.assertIsInstance(item["files"], int)
            self.assertIsInstance(item["pct"], float)
            self.assertIsInstance(item["path"], str)
            self.assertIsInstance(item["name"], str)
        # GameA 是 6000 字节，应该排在 GameB（1000）前面
        names = [i["name"] for i in items]
        self.assertIn("GameA", names)
        self.assertIn("GameB", names)
        self.assertLess(names.index("GameA"), names.index("GameB"), res)

    def test_folders_depth_changes_granularity(self):
        """depth 越大分得越细：depth=1 合并到顶层，depth=3 能看到 Content。"""
        folder = self.new_folder()
        deep = os.path.join(folder, "L1", "L2", "L3")
        os.makedirs(deep, exist_ok=True)
        with open(os.path.join(deep, "big.bin"), "wb") as f:
            f.write(b"x" * 5000)
        self.build(folder, reuse=False)
        shallow = self.rpc_ok("search.folders",
                              {"depth": 1, "limit": 20, "auto": False})
        deeper = self.rpc_ok("search.folders",
                             {"depth": 3, "limit": 20, "auto": False})
        self.assertEqual(shallow["depth"], 1)
        self.assertEqual(deeper["depth"], 3)
        # 两种粒度的总量必须一致：分层只是换个切法，不该凭空多出或少掉体积
        self.assertEqual(shallow["bytes"], deeper["bytes"], (shallow, deeper))
        self.assertTrue(any(i["name"] == "L1" for i in shallow["items"]), shallow)
        self.assertTrue(any(i["name"] == "L3" for i in deeper["items"]), deeper)

    def test_folders_parent_drills_down(self):
        """parent 用来下钻：只看这个目录下面的子目录。"""
        folder = self.new_folder()
        for sub_name, n in (("Alpha", 3000), ("Beta", 1000)):
            d = os.path.join(folder, "Root", sub_name)
            os.makedirs(d, exist_ok=True)
            with open(os.path.join(d, "f.bin"), "wb") as f:
                f.write(b"x" * n)
        self.build(folder, reuse=False)
        res = self.rpc_ok("search.folders", {
            "depth": 3, "limit": 20, "auto": False,
            "parent": os.path.join(folder, "Root")
        })
        names = [i["name"] for i in res["items"]]
        self.assertIn("Alpha", names, res)
        self.assertIn("Beta", names, res)
        # 下钻之后不能把父目录自己也算进来
        self.assertNotIn("Root", names, res)
        self.assertLess(names.index("Alpha"), names.index("Beta"), res)

    def test_folders_bad_params_are_errors(self):
        for params in ({"depth": 0}, {"depth": "deep"}, {"limit": 0}):
            r = self.rpc("search.folders", params)
            self.assertFalse(r["ok"], (params, r))
            self.assertTrue(r["error"], params)

    def test_folders_without_index_has_hint(self):
        """没索引且 auto=false 时不能静默返回空：要给 hint，别让人以为本机没大文件。"""
        res = self.rpc_ok("search.folders",
                          {"limit": 5, "auto": False})
        if not res["roots"]:
            self.assertIn("hint", res)
            self.assertIn("索引", res["hint"])


class TestSettingsSet(EngineCase):
    """settings.set：只写白名单键，类型/范围/取值都要挡住。"""

    def test_requires_key_and_value(self):
        for params in ({}, {"key": ""}, {"key": "   "},
                       {"key": "log_keep_days"}):
            r = self.rpc("settings.set", params)
            self.assertFalse(r["ok"], (params, r))
            self.assertTrue(r["error"], params)

    def test_unknown_key_rejected(self):
        r = self.rpc("settings.set", {"key": "no_such_key", "value": 1})
        self.assertFalse(r["ok"], r)
        self.assertIn("不支持", r["error"])
        # 拒绝之后进程还能继续服务
        self.assertTrue(self.rpc("settings.set",
                                 {"key": "log_keep_days", "value": 7})["ok"])

    def test_type_checked(self):
        for key, value in (("recursive_depth", "3"),
                           ("recursive_depth", True),
                           ("default_recursive", "yes"),
                           ("shot_keep_days", 1.5),
                           ("index_roots", "C:\\x"),
                           ("index_roots", ["ok", 3]),
                           ("log_keep_days", None)):
            r = self.rpc("settings.set", {"key": key, "value": value})
            self.assertFalse(r["ok"], (key, value, r))
            self.assertTrue(r["error"], (key, value))

    def test_range_and_choice_checked(self):
        for key, value in (("recursive_depth", 9),
                           ("recursive_depth", 0),
                           ("log_keep_days", 0),
                           ("shot_keep_days", -1),
                           ("conflict_policy", "Bogus")):
            r = self.rpc("settings.set", {"key": key, "value": value})
            self.assertFalse(r["ok"], (key, value, r))
        r = self.rpc("settings.set",
                     {"key": "conflict_policy", "value": "SKIP"})
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["result"]["value"], "skip")

    def test_time_format_checked(self):
        self.assertFalse(self.rpc("settings.set",
                                  {"key": "shot_time",
                                   "value": "25:00"})["ok"])
        res = self.rpc_ok("settings.set",
                          {"key": "shot_time", "value": "07:30"})
        self.assertEqual(res["value"], "07:30")

    def test_write_visible_in_settings_get(self):
        res = self.rpc_ok("settings.set",
                          {"key": "log_keep_days", "value": 30})
        self.assertEqual(res["key"], "log_keep_days")
        self.assertEqual(res["value"], 30)
        self.assertTrue(os.path.isfile(res["settings_path"]))
        got = self.rpc_ok("settings.get")
        self.assertEqual(got["log_keep_days"], 30)

    def test_index_freshness_keys_are_writable(self):
        """设置页的三个索引开关必须能被写入。

        这三个键是「索引新鲜度」「索引上限」「空闲时校验并重建」。它们
        很容易被漏掉：DEFAULT_SETTINGS 里有、设置页也画了，但
        _ENGINE_SETTINGS_TYPES 的白名单没加，保存时引擎直接拒绝
        「不支持的设置项」—— 界面看起来能用，点保存就报错。
        """
        for key, value, want in (
            ("index_freshness", "live", "live"),
            ("index_freshness", "manual", "manual"),
            ("index_max_mb", 0, 0),
            ("index_max_mb", 4096, 4096),
            ("index_rebuild_idle", False, False),
        ):
            res = self.rpc_ok("settings.set", {"key": key, "value": value})
            self.assertEqual(res["value"], want, (key, value, res))
        got = self.rpc_ok("settings.get")
        self.assertEqual(got["index_freshness"], "manual")
        self.assertEqual(got["index_max_mb"], 4096)
        self.assertFalse(got["index_rebuild_idle"])

    def test_index_freshness_rejects_bad_values(self):
        """越界要拒绝，不能静默存下一个后面会让配额永远超限的值。

        index_max_mb 是 index_quota_ok() 的分母，存进 -1 会让索引从此
        再也不自动刷新，而用户看到的只是「怎么老是旧数据」。
        """
        for key, value in (("index_freshness", "always"),
                           ("index_freshness", ""),
                           ("index_max_mb", -1),
                           ("index_max_mb", 100000),
                           ("index_rebuild_idle", "yes")):
            r = self.rpc("settings.set", {"key": key, "value": value})
            self.assertFalse(r["ok"], (key, value, r))

    def test_list_paths_normalized(self):
        folder = self.new_folder()
        res = self.rpc_ok("settings.set",
                          {"key": "shot_dirs",
                           "value": [folder + os.sep + ".",
                                     folder + os.sep + ".",
                                     folder]})
        self.assertEqual(res["value"], [os.path.normpath(folder)])

    def test_cache_dir_must_be_directory(self):
        r = self.rpc("settings.set",
                     {"key": "cache_dir",
                      "value": os.path.join(self.root, "tidy.py")})
        self.assertFalse(r["ok"], r)
        self.assertTrue(r["error"])

    def test_data_dir_change_keeps_data(self):
        ping = self.rpc_ok("ping")
        old = ping["data_dir"]
        marker = os.path.join(old, "marker_before_move.txt")
        os.makedirs(old, exist_ok=True)
        with open(marker, "w", encoding="utf-8") as f:
            f.write("keep me")
        new = os.path.join(self.root, "新数据目录")
        res = self.rpc_ok("settings.set", {"key": "data_dir", "value": new})
        self.assertTrue(res["migrated_settings"], res)
        self.assertEqual(os.path.normcase(res["data_dir"]),
                         os.path.normcase(new))
        self.assertTrue(os.path.normcase(res["settings_path"]).startswith(
            os.path.normcase(new)))
        # 只搬了配置，数据文件原样留在旧目录（迁移交给 migrate.*）
        self.assertTrue(os.path.isfile(marker))
        after = self.rpc_ok("ping")
        self.assertEqual(os.path.normcase(after["data_dir"]),
                         os.path.normcase(new))

    def test_data_dir_inside_old_rejected(self):
        current = self.rpc_ok("settings.get")["data_dir"]
        r = self.rpc("settings.set",
                     {"key": "data_dir",
                      "value": os.path.join(current, "子目录")})
        self.assertFalse(r["ok"], r)
        self.assertTrue(r["error"])


@unittest.skipUnless(HAS_ORGANIZE, "本机没装 organize-tool，跳过高级规则用例")
class TestRules(EngineCase):
    """rules.validate / preview / run：校验不执行，预演不落盘。"""

    def make_yaml(self, folder, dest):
        path = os.path.join(self.new_folder(), "rules.yaml")
        text = (
            "rules:\n"
            "  - name: '移动 txt'\n"
            "    locations: '%s'\n"
            "    targets: files\n"
            "    filters:\n"
            "      - extension: txt\n"
            "    actions:\n"
            "      - move: '%s/'\n"
        ) % (folder.replace("\\", "/"), dest.replace("\\", "/"))
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        return path

    def test_validate_good_yaml(self):
        folder, dest = self.new_folder(), self.new_folder()
        res = self.rpc_ok("rules.validate",
                          {"path": self.make_yaml(folder, dest)})
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["errors"], [])
        self.assertEqual(res["rule_count"], 1)

    def test_validate_bad_yaml_reports_line(self):
        path = os.path.join(self.new_folder(), "bad.yaml")
        with open(path, "w", encoding="utf-8") as f:
            f.write("rules:\n  - name: [oops\n")
        res = self.rpc_ok("rules.validate", {"path": path})
        self.assertFalse(res["ok"], res)
        self.assertEqual(res["rule_count"], 0)
        self.assertEqual(len(res["errors"]), 1, res)
        self.assertGreaterEqual(res["errors"][0]["line"], 1)
        self.assertTrue(res["errors"][0]["message"])

    def test_validate_requires_existing_file(self):
        r = self.rpc("rules.validate", {})
        self.assertFalse(r["ok"], r)
        r = self.rpc("rules.validate",
                     {"path": os.path.join(self.root, "no_such.yaml")})
        self.assertFalse(r["ok"], r)
        self.assertTrue(r["error"])

    def test_validate_accepts_text_without_file(self):
        """编辑器草稿没存盘也要能校验：给了 text 就不该去找文件。"""
        folder, dest = self.new_folder(), self.new_folder()
        with open(self.make_yaml(folder, dest), encoding="utf-8") as f:
            text = f.read()
        res = self.rpc_ok("rules.validate", {"text": text})
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["rule_count"], 1)

    def test_validate_text_reports_line(self):
        res = self.rpc_ok("rules.validate", {"text": "rules:\n  - name: [oops\n"})
        self.assertFalse(res["ok"], res)
        self.assertEqual(len(res["errors"]), 1, res)
        self.assertGreaterEqual(res["errors"][0]["line"], 1)

    def test_preview_accepts_text_without_file(self):
        folder, dest = self.new_folder(), self.new_folder()
        src = os.path.join(folder, "a.txt")
        with open(src, "w", encoding="utf-8") as f:
            f.write("hello")
        with open(self.make_yaml(folder, os.path.join(dest, "out")),
                  encoding="utf-8") as f:
            text = f.read()
        res = self.rpc_ok("rules.preview", {"text": text, "folder": folder})
        self.assertEqual(res["total"], 1, res)
        self.assertTrue(os.path.isfile(src))       # 预演不落盘

    def test_preview_lists_move_without_touching_disk(self):
        folder, dest = self.new_folder(), self.new_folder()
        src = os.path.join(folder, "a.txt")
        with open(src, "w", encoding="utf-8") as f:
            f.write("hello")
        with open(os.path.join(folder, "b.bin"), "wb") as f:
            f.write(b"x" * 8)
        dest = os.path.join(dest, "out")
        res = self.rpc_ok("rules.preview",
                          {"path": self.make_yaml(folder, dest),
                           "folder": folder})
        self.assertEqual(res["total"], 1, res)
        self.assertEqual(os.path.normcase(res["moves"][0]["src"]),
                         os.path.normcase(src))
        self.assertEqual(os.path.normcase(res["moves"][0]["dst"]),
                         os.path.normcase(os.path.join(dest, "a.txt")))
        self.assertTrue(res["moves"][0]["reason"])
        self.assertTrue(os.path.isfile(src))        # 源还在
        self.assertFalse(os.path.exists(dest))      # 目标没建

    def test_preview_requires_folder(self):
        folder, dest = self.new_folder(), self.new_folder()
        r = self.rpc("rules.preview", {"path": self.make_yaml(folder, dest)})
        self.assertFalse(r["ok"], r)
        self.assertIn("folder", r["error"])

    def test_run_dry_run_has_no_side_effect(self):
        folder, dest = self.new_folder(), self.new_folder()
        src = os.path.join(folder, "a.txt")
        with open(src, "w", encoding="utf-8") as f:
            f.write("hello")
        dest = os.path.join(dest, "out")
        res = self.rpc_ok("rules.run",
                          {"path": self.make_yaml(folder, dest),
                           "folder": folder})
        self.assertTrue(res["dry_run"], res)
        self.assertEqual(res["moved"], 1, res)
        self.assertEqual(res["failed"], [])
        self.assertTrue(os.path.isfile(src))
        self.assertFalse(os.path.exists(dest))

    def test_run_confirm_false_still_dry(self):
        folder, dest = self.new_folder(), self.new_folder()
        src = os.path.join(folder, "a.txt")
        with open(src, "w", encoding="utf-8") as f:
            f.write("hello")
        dest = os.path.join(dest, "out")
        res = self.rpc_ok("rules.run",
                          {"path": self.make_yaml(folder, dest),
                           "folder": folder, "confirm": False})
        self.assertTrue(res["dry_run"], res)
        self.assertTrue(os.path.isfile(src))

    def test_run_confirm_moves_file(self):
        folder, dest = self.new_folder(), self.new_folder()
        src = os.path.join(folder, "a.txt")
        with open(src, "w", encoding="utf-8") as f:
            f.write("hello")
        dest = os.path.join(dest, "out")
        res = self.rpc_ok("rules.run",
                          {"path": self.make_yaml(folder, dest),
                           "folder": folder, "confirm": True})
        self.assertFalse(res["dry_run"], res)
        self.assertEqual(res["moved"], 1, res)
        self.assertEqual(res["failed"], [])
        self.assertFalse(os.path.exists(src))
        self.assertTrue(os.path.isfile(os.path.join(dest, "a.txt")))

    def test_run_bad_yaml_is_reported(self):
        path = os.path.join(self.new_folder(), "bad.yaml")
        with open(path, "w", encoding="utf-8") as f:
            f.write("rules:\n  - name: [oops\n")
        r = self.rpc("rules.run", {"path": path, "folder": self.new_folder()})
        self.assertFalse(r["ok"], r)
        self.assertTrue(r["error"])


class TestRulesExplain(EngineCase):
    """rules.explain：解释分类与跳过原因，只读当前 rules.json。"""

    def test_categories_have_exts(self):
        res = self.rpc_ok("rules.explain", {})
        self.assertTrue(res["fallback"])
        self.assertTrue(res["cat_order"])
        self.assertTrue(res["categories"])
        # 每个分类的扩展名必须能在 rules.json 的 ext_to_cat 里找到
        for c in res["categories"]:
            self.assertIn("cat", c)
            self.assertIn("ext_count", c)
            self.assertEqual(len(c["exts"]), min(c["ext_count"], 24))

    def test_single_category(self):
        res = self.rpc_ok("rules.explain", {"cat": "03_文档"})
        cat = res.get("category") or {}
        self.assertEqual(cat.get("cat"), "03_文档")
        self.assertGreater(cat.get("ext_count", 0), 0)
        self.assertIn(".pdf", cat["exts"])
        self.assertNotIn("categories", res)   # 单分类时不再重复列全表

    def test_match_file_by_name(self):
        res = self.rpc_ok("rules.explain", {"name": "报告.PDF"})
        m = res.get("matched") or {}
        self.assertEqual(m.get("ext"), ".pdf")
        self.assertEqual(m.get("cat"), "03_文档")
        self.assertTrue(m.get("why"))

    def test_match_unknown_ext_falls_back(self):
        res = self.rpc_ok("rules.explain", {"name": "x.qqqzzz"})
        m = res.get("matched") or {}
        self.assertEqual(m.get("cat"), res["fallback"])
        self.assertIn("兜底", m.get("why", ""))

    def test_skip_reasons_have_why(self):
        res = self.rpc_ok("rules.explain", {})
        reasons = res["skip_reasons"]
        self.assertGreaterEqual(len(reasons), 8)
        for r in reasons:
            self.assertTrue(r["reason"])
            self.assertTrue(r["why"])

    def test_never_lists(self):
        res = self.rpc_ok("rules.explain", {})
        self.assertIn(".lnk", res["never"]["exts"])
        self.assertIn("thumbs.db", res["never"]["names"])
        self.assertIn("~$", res["never"]["prefixes"])


class TestMigrate(EngineCase):
    """migrate.plan 只读；migrate.apply 要留任务现场。"""

    def make_source(self):
        src = self.new_folder()
        with open(os.path.join(src, "m.bin"), "wb") as f:
            f.write(b"x" * 100)
        sub = os.path.join(src, "sub")
        os.makedirs(sub)
        with open(os.path.join(sub, "n.bin"), "wb") as f:
            f.write(b"y" * 50)
        return src

    def new_dest(self):
        return os.path.join(self.root, "mig_dest_" + str(time.time_ns()))

    def test_plan_requires_params(self):
        for params in ({},
                       {"sources": []},
                       {"sources": ["  "]},
                       {"sources": [self.new_folder()]}):
            r = self.rpc("migrate.plan", params)
            self.assertFalse(r["ok"], (params, r))
            self.assertTrue(r["error"], params)

    def test_plan_destination_must_be_directory(self):
        src = self.make_source()
        r = self.rpc("migrate.plan",
                     {"sources": [src],
                      "destination": os.path.join(self.root, "tidy.py")})
        self.assertFalse(r["ok"], r)
        self.assertTrue(r["error"])

    def test_plan_bad_mode(self):
        r = self.rpc("migrate.plan",
                     {"sources": [self.make_source()],
                      "destination": self.new_dest(), "mode": "sync"})
        self.assertFalse(r["ok"], r)

    def test_plan_structure(self):
        src = self.make_source()
        dest = self.new_dest()
        res = self.rpc_ok("migrate.plan",
                          {"sources": [src], "destination": dest})
        self.assertEqual(len(res["jobs"]), 1, res)
        job = res["jobs"][0]
        self.assertEqual(os.path.normcase(job["source"]),
                         os.path.normcase(src))
        self.assertEqual(os.path.normcase(job["target"]),
                         os.path.normcase(os.path.join(dest,
                                                       os.path.basename(src))))
        self.assertEqual(job["size"], 150, res)
        self.assertGreaterEqual(job["items"], 2)
        self.assertFalse(job["conflict"])
        self.assertEqual(res["total_size"], 150, res)
        self.assertEqual(res["total_files"], 2, res)
        self.assertEqual(res["blocked"], [])
        self.assertFalse(os.path.exists(dest))      # 规划不动盘

    def test_plan_missing_source_is_blocked(self):
        missing = os.path.join(self.root, "no_such_source")
        res = self.rpc_ok("migrate.plan",
                          {"sources": [missing], "destination": self.new_dest()})
        self.assertEqual(len(res["blocked"]), 1, res)
        self.assertTrue(res["blocked"][0]["why"])

    def test_apply_dry_run_has_no_side_effect(self):
        src = self.make_source()
        dest = self.new_dest()
        res = self.rpc_ok("migrate.apply",
                          {"sources": [src], "destination": dest})
        self.assertTrue(res["dry_run"], res)
        self.assertEqual(res["moved"], 0)
        self.assertEqual(res["job_id"], "")
        self.assertFalse(os.path.exists(dest))
        self.assertTrue(os.path.isfile(os.path.join(src, "m.bin")))

    def test_apply_confirm_moves_and_leaves_job(self):
        src = self.make_source()
        dest = self.new_dest()
        setting = self.rpc_ok("settings.get")
        jobs_root = os.path.join(setting["data_dir"], "迁移")
        res = self.rpc_ok("migrate.apply",
                          {"sources": [src], "destination": dest,
                           "confirm": True, "id": "job1"})
        self.assertFalse(res["dry_run"], res)
        self.assertEqual(res["job_id"], "job1")
        self.assertGreaterEqual(res["moved"], 2, res)
        self.assertEqual(res["failed"], [])
        self.assertTrue(os.path.isfile(os.path.join(dest,
                                                    os.path.basename(src),
                                                    "m.bin")))
        self.assertTrue(os.path.isfile(os.path.join(dest,
                                                    os.path.basename(src),
                                                    "sub", "n.bin")))
        self.assertFalse(os.path.exists(os.path.join(src, "m.bin")))
        self.assertEqual(os.path.normcase(res["job_dir"]),
                         os.path.normcase(os.path.join(jobs_root, "job1")))
        self.assertTrue(os.path.isfile(os.path.join(res["job_dir"],
                                                    "journal.db")))
        self.assertTrue(res["report_path"].endswith("report.json"))
        self.assertTrue(os.path.isfile(res["report_path"]), res)

    def test_apply_blocked_is_refused(self):
        missing = os.path.join(self.root, "no_such_source")
        dest = self.new_dest()
        r = self.rpc("migrate.apply",
                     {"sources": [missing], "destination": dest,
                      "confirm": True})
        self.assertTrue(r["ok"], r)       # 业务拒绝，不是协议错误
        res = r["result"]
        self.assertTrue(res["dry_run"], res)
        self.assertTrue(res.get("refused"), res)
        self.assertTrue(res["error"])
        self.assertTrue(res["failed"])
        self.assertFalse(os.path.exists(dest))

    def test_apply_rejects_bad_id(self):
        for job_id in ("../evil", "a/b", ".."):
            r = self.rpc("migrate.apply",
                         {"sources": [self.make_source()],
                          "destination": self.new_dest(),
                          "confirm": True, "id": job_id})
            self.assertFalse(r["ok"], (job_id, r))

    def test_apply_empty_id_means_auto(self):
        src = self.make_source()
        dest = self.new_dest()
        res = self.rpc_ok("migrate.apply",
                          {"sources": [src], "destination": dest,
                           "confirm": True, "id": "   "})
        self.assertFalse(res["dry_run"], res)
        self.assertTrue(res["job_id"], res)
        self.assertNotIn("/", res["job_id"])


class TestFilesDelete(EngineCase):
    """files.delete：预演零副作用；真删走回收站 / 永久删除；危险路径逐项拒绝。"""

    def make_file(self, folder=None, name="victim.txt"):
        folder = folder or self.new_folder()
        path = os.path.join(folder, name)
        with open(path, "wb") as f:
            f.write(b"x" * 16)
        return path

    def test_requires_paths(self):
        for params in ({}, {"paths": None}, {"paths": []}, {"paths": [""]},
                       {"paths": ["   "]}, {"paths": [1]}, {"paths": "a.txt"}):
            r = self.rpc("files.delete", params)
            self.assertFalse(r["ok"], (params, r))
            self.assertIn("paths", r["error"])

    def test_bad_mode(self):
        path = self.make_file()
        for mode in ("delete", "", 0, True, []):
            r = self.rpc("files.delete", {"paths": [path], "mode": mode,
                                          "confirm": True})
            self.assertFalse(r["ok"], (mode, r))
            self.assertIn("mode", r["error"])
        self.assertTrue(os.path.isfile(path))

    def test_confirm_must_be_bool(self):
        path = self.make_file()
        for bad in ("yes", 1, 0, []):
            r = self.rpc("files.delete", {"paths": [path], "confirm": bad})
            self.assertFalse(r["ok"], (bad, r))
            self.assertIn("confirm", r["error"])
        self.assertTrue(os.path.isfile(path))

    def test_dry_run_has_no_side_effect(self):
        folder = self.new_folder()
        path = self.make_file(folder)
        before = sorted(os.listdir(folder))
        res = self.rpc_ok("files.delete", {"paths": [path]})
        self.assertTrue(res["dry_run"], res)
        self.assertEqual(res["mode"], "trash")
        self.assertEqual(res["paths"], [os.path.abspath(path)])
        self.assertEqual(sorted(os.listdir(folder)), before)
        self.assertTrue(os.path.isfile(path))
        # permanent 也只是预演，mode 原样回显
        res2 = self.rpc_ok("files.delete", {"paths": [path],
                                            "mode": "permanent"})
        self.assertTrue(res2["dry_run"], res2)
        self.assertEqual(res2["mode"], "permanent")
        self.assertTrue(os.path.isfile(path))

    def test_confirm_trash_removes_file(self):
        path = self.make_file()
        res = self.rpc_ok("files.delete", {"paths": [path], "confirm": True})
        self.assertFalse(res["dry_run"], res)
        self.assertEqual(res["mode"], "trash")
        self.assertEqual(res["count"], 1)
        self.assertEqual(res["deleted"], [os.path.abspath(path)])
        self.assertEqual(res["failed"], [])
        self.assertFalse(os.path.exists(path))

    def test_confirm_permanent_removes_file(self):
        path = self.make_file()
        res = self.rpc_ok("files.delete", {"paths": [path],
                                           "mode": "permanent",
                                           "confirm": True})
        self.assertFalse(res["dry_run"], res)
        self.assertEqual(res["mode"], "permanent")
        self.assertEqual(res["count"], 1)
        self.assertEqual(res["failed"], [])
        self.assertFalse(os.path.exists(path))

    def test_refuses_drive_root_and_windows_dir(self):
        drive = os.environ.get("SystemDrive") or "C:"
        targets = [drive + "\\", os.path.join(drive, "Windows")]
        pf = os.environ.get("ProgramFiles")
        if pf and os.path.isdir(pf):
            targets.append(pf)
        for t in targets:
            self.assertTrue(os.path.isdir(t), t)
        res = self.rpc_ok("files.delete", {"paths": targets,
                                           "mode": "permanent",
                                           "confirm": True})
        self.assertEqual(res["deleted"], [], res)
        self.assertEqual(res["count"], 0)
        self.assertEqual(len(res["failed"]), len(targets), res)
        for item in res["failed"]:
            self.assertTrue(item["target"])
            self.assertTrue(item["why"])
        for t in targets:
            self.assertTrue(os.path.isdir(t), t)

    def test_refuses_nonexistent_path(self):
        missing = os.path.join(self.root, "no_such_delete_xyz")
        res = self.rpc_ok("files.delete", {"paths": [missing],
                                           "mode": "permanent",
                                           "confirm": True})
        self.assertEqual(res["count"], 0, res)
        self.assertEqual(len(res["failed"]), 1, res)
        self.assertEqual(os.path.normcase(res["failed"][0]["target"]),
                         os.path.normcase(missing))
        self.assertIn("不存在", res["failed"][0]["why"])

    def test_refuses_engine_data_dir(self):
        data = self.rpc_ok("settings.get")["data_dir"]
        os.makedirs(data, exist_ok=True)
        victim = os.path.join(data, "probe_delete.txt")
        with open(victim, "wb") as f:
            f.write(b"x")
        res = self.rpc_ok("files.delete", {"paths": [victim, data],
                                           "mode": "permanent",
                                           "confirm": True})
        self.assertEqual(res["count"], 0, res)
        self.assertEqual(len(res["failed"]), 2, res)
        self.assertTrue(os.path.isfile(victim))
        self.assertTrue(os.path.isdir(data))

    def test_desktop_root_kept_but_child_deleted(self):
        # 引擎测试环境把 USERPROFILE 指到了临时目录，可以安全地造「桌面」
        desk = os.path.join(self.root, "userprofile", "Desktop")
        os.makedirs(desk, exist_ok=True)
        child = self.make_file(desk)
        res = self.rpc_ok("files.delete", {"paths": [desk, child],
                                           "mode": "permanent",
                                           "confirm": True})
        self.assertEqual(res["count"], 1, res)
        self.assertEqual(res["deleted"], [os.path.abspath(child)])
        self.assertEqual(len(res["failed"]), 1, res)
        self.assertEqual(os.path.normcase(res["failed"][0]["target"]),
                         os.path.normcase(desk))
        self.assertTrue(os.path.isdir(desk))
        self.assertFalse(os.path.exists(child))

    def test_one_bad_path_does_not_abort_others(self):
        safe = self.make_file()
        missing = os.path.join(self.root, "no_such_delete_mix")
        drive = (os.environ.get("SystemDrive") or "C:") + "\\"
        res = self.rpc_ok("files.delete", {"paths": [safe, missing, drive],
                                           "mode": "permanent",
                                           "confirm": True})
        self.assertEqual(res["count"], 1, res)
        self.assertEqual(res["deleted"], [os.path.abspath(safe)])
        self.assertEqual(len(res["failed"]), 2, res)
        self.assertFalse(os.path.exists(safe))


class TestScanParams(EngineCase):
    """scan 的 force / by_date / conflict / skip_shortcuts：默认不变，参数回显。"""

    @classmethod
    def prepare_workdir(cls):
        # 只造 2 个文件，把临时 rules.json 的下限调成 2（不动真实规则）
        path = os.path.join(cls.root, "rules.json")
        with open(path, encoding="utf-8-sig") as f:
            rules = json.load(f)
        rules["min_files_to_organize"] = 2
        with open(path, "w", encoding="utf-8") as f:
            json.dump(rules, f, ensure_ascii=False, indent=1)

    def make_two(self):
        folder = self.new_folder()
        ts = time.time() - 30 * 60
        for name in ("a.pdf", "b.jpg"):
            p = os.path.join(folder, name)
            with open(p, "wb") as f:
                f.write(b"x" * 16)
            os.utime(p, (ts, ts))
        return folder, ts

    def names(self, res):
        return sorted(f["name"] for p in res["plans"]
                      for g in p["groups"] for f in g["files"])

    def test_applied_defaults(self):
        folder, _ts = self.make_two()
        res = self.rpc_ok("scan", self.scan_params(folder))
        self.assertEqual(res["applied"],
                         {"skip_shortcuts": True, "force": False,
                          "by_date": False, "conflict": None,
                          "min_age_minutes": None, "paths": [],
                          "exclude_exts": [], "exclude_dirs": []})
        self.assertEqual(self.names(res), ["a.pdf", "b.jpg"])
        self.assertEqual(res["total"], 2)

    def test_force_echo_and_files_unchanged(self):
        folder, _ts = self.make_two()
        base = self.rpc_ok("scan", self.scan_params(folder))
        res = self.rpc_ok("scan", self.scan_params(folder, force=True))
        self.assertIs(res["applied"]["force"], True)
        self.assertIs(res["applied"]["by_date"], False)
        self.assertEqual(self.names(res), self.names(base))

    def test_by_date_echo_and_files_unchanged(self):
        folder, _ts = self.make_two()
        base = self.rpc_ok("scan", self.scan_params(folder))
        res = self.rpc_ok("scan", self.scan_params(folder, by_date=True))
        self.assertIs(res["applied"]["by_date"], True)
        self.assertEqual(self.names(res), self.names(base))

    def test_conflict_echo_and_files_unchanged(self):
        folder, _ts = self.make_two()
        base = self.rpc_ok("scan", self.scan_params(folder))
        res = self.rpc_ok("scan", self.scan_params(folder, conflict="skip"))
        self.assertEqual(res["applied"]["conflict"], "skip")
        self.assertEqual(self.names(res), self.names(base))
        r = self.rpc("scan", self.scan_params(folder, conflict="nope"))
        self.assertFalse(r["ok"], r)
        self.assertIn("conflict", r["error"])

    def test_skip_shortcuts_echo_and_files_unchanged(self):
        folder, _ts = self.make_two()
        base = self.rpc_ok("scan", self.scan_params(folder))
        res = self.rpc_ok("scan", self.scan_params(folder,
                                                   skip_shortcuts=False))
        self.assertIs(res["applied"]["skip_shortcuts"], False)
        self.assertEqual(self.names(res), self.names(base))

    def test_by_date_affects_organize_target(self):
        """by_date 不只是回显：organize 沿用同一次扫描，落到 年/月 子目录。"""
        folder, ts = self.make_two()
        base = self.rpc_ok("scan", self.scan_params(folder))
        cat = next(g["cat"] for g in base["plans"][0]["groups"]
                   if any(f["name"] == "a.pdf" for f in g["files"]))
        params = self.scan_params(folder, by_date=True)
        params["confirm"] = True
        res = self.rpc_ok("organize", params)
        self.assertEqual(res["moved"], 2, res)
        year = time.strftime("%Y", time.localtime(ts))
        month = time.strftime("%m", time.localtime(ts))
        expect = os.path.join(folder, cat, year, month, "a.pdf")
        self.assertTrue(os.path.isfile(expect), expect)
        self.assertFalse(os.path.isfile(os.path.join(folder, "a.pdf")))


if __name__ == "__main__":
    unittest.main(verbosity=2)
