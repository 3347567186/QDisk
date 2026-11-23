# -*- coding: utf-8 -*-
"""migrate_engine 的单元测试：跑 python -m unittest -v test_migrate_engine"""
import os
import shutil
import tempfile
import threading
import time
import unittest

import migrate_engine as M


class Base(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="dsh-mig-")
        self.src = os.path.join(self.root, "src")
        self.dst = os.path.join(self.root, "dst")
        self.jobs = os.path.join(self.root, "jobs")
        os.makedirs(self.src)
        os.makedirs(self.dst)

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def make(self, name, data=b"hello", sub=""):
        d = os.path.join(self.src, sub) if sub else self.src
        os.makedirs(d, exist_ok=True)
        p = os.path.join(d, name)
        with open(p, "wb") as f:
            f.write(data)
        return p

    def O(self, **kw):
        kw.setdefault("flatten", True)
        return M.Options(**kw)

    def run_plan(self, opts=None, sources=None):
        opts = opts or self.O()
        plan = M.build_plan(sources or [self.src], self.dst, opts)
        issues = M.preflight(plan)
        self.assertFalse([i for i in issues if i.level == "error"],
                         "预检不该有阻断项：%s" % [str(i) for i in issues])
        rep = M.execute(plan, self.jobs)
        return plan, rep

    def names(self, d):
        return sorted(os.listdir(d)) if os.path.isdir(d) else []


class TestMove(Base):
    def test_same_volume_is_atomic_and_undo(self):
        self.make("a.txt")
        self.make("b.txt", b"world")
        plan, rep = self.run_plan()
        self.assertEqual(rep.done, 2)
        self.assertEqual(rep.failed, 0)
        self.assertFalse(os.path.exists(self.src))
        self.assertEqual(self.names(self.dst), ["a.txt", "b.txt"])
        n, failed = M.undo_job(rep.job_id, self.jobs)
        self.assertEqual(failed, [])
        self.assertEqual(n, 2)
        self.assertEqual(self.names(self.src), ["a.txt", "b.txt"])

    def test_tree_structure(self):
        self.make("x.txt", b"1", sub="sub/deep")
        self.make("y.txt", b"2", sub="sub")
        plan, rep = self.run_plan()
        self.assertEqual(rep.done, 4)          # 2 files + 2 dirs
        self.assertEqual(self.names(os.path.join(self.dst, "sub")), ["deep", "y.txt"])
        self.assertTrue(os.path.isfile(os.path.join(self.dst, "sub", "deep", "x.txt")))

    def test_cross_volume_copy_path(self):
        self.make("big.bin", b"x" * 10000)
        src_file = os.path.join(self.src, "big.bin")
        before = os.stat(src_file).st_mtime_ns
        plan, rep = self.run_plan(self.O(force_copy=True))
        self.assertEqual(rep.done, 1)
        self.assertFalse(os.path.exists(src_file))
        dst_file = os.path.join(self.dst, "big.bin")
        self.assertEqual(os.path.getsize(dst_file), 10000)
        self.assertEqual(os.stat(dst_file).st_mtime_ns, before)   # 时间戳保留
        # 有哈希才有资格撤销时比对
        import sqlite3
        db = sqlite3.connect(os.path.join(self.jobs, rep.job_id, "journal.db"))
        digest = db.execute("SELECT digest FROM items WHERE kind='file'").fetchone()[0]
        db.close()
        self.assertTrue(digest)

    def test_copy_mode_keeps_source_and_undo_removes_copy(self):
        self.make("c.txt")
        plan, rep = self.run_plan(self.O(mode="copy"))
        self.assertTrue(os.path.exists(os.path.join(self.src, "c.txt")))
        self.assertTrue(os.path.exists(os.path.join(self.dst, "c.txt")))
        n, failed = M.undo_job(rep.job_id, self.jobs)
        self.assertEqual(failed, [])
        self.assertFalse(os.path.exists(os.path.join(self.dst, "c.txt")))
        self.assertTrue(os.path.exists(os.path.join(self.src, "c.txt")))


class TestConflict(Base):
    def test_flatten_into_existing_dest_is_not_renamed(self):
        """勾了「不套一层」时，目标已存在是前提不是冲突。

        回归：以前 flatten 也走 conflict=rename，于是整棵目录被搬进
        「dst (2)」，用户勾了不套一层，东西却没落到 dst 里。
        """
        self.make("a.txt")
        plan, rep = self.run_plan(self.O(conflict="rename"))
        self.assertEqual(rep.failed, 0, rep.failures)
        self.assertEqual(self.names(self.dst), ["a.txt"])
        self.assertFalse(os.path.exists(self.dst + " (2)"))

    def test_flatten_single_file_source_lands_inside_dest(self):
        """文件来源没有层可压平，必须落在 dest 里面，不能顶替 dest。"""
        solo = self.make("solo.txt")
        plan = M.build_plan([solo], self.dst, self.O())
        self.assertEqual([i.dst for i in plan.items],
                         [os.path.join(self.dst, "solo.txt")])

    def test_flatten_two_sources_same_name_both_kept(self):
        """多个来源压平到同一层，同名文件改名共存，不互相覆盖。"""
        b = os.path.join(self.root, "b")
        os.makedirs(b)
        self.make("same.txt", b"from-a")
        with open(os.path.join(b, "same.txt"), "wb") as f:
            f.write(b"from-b")
        plan, rep = self.run_plan(sources=[self.src, b])
        self.assertEqual(rep.failed, 0, rep.failures)
        self.assertEqual(self.names(self.dst), ["same (2).txt", "same.txt"])
        with open(os.path.join(self.dst, "same.txt"), "rb") as f:
            self.assertEqual(f.read(), b"from-a")
        with open(os.path.join(self.dst, "same (2).txt"), "rb") as f:
            self.assertEqual(f.read(), b"from-b")

    def test_rename(self):
        self.make("a.txt", b"new")
        with open(os.path.join(self.dst, "a.txt"), "wb") as f:
            f.write(b"old")
        plan, rep = self.run_plan(self.O(conflict="rename"))
        self.assertEqual(rep.done, 1)
        self.assertEqual(self.names(self.dst), ["a (2).txt", "a.txt"])
        with open(os.path.join(self.dst, "a.txt"), "rb") as f:
            self.assertEqual(f.read(), b"old")

    def test_skip_leaves_source(self):
        self.make("a.txt", b"new")
        with open(os.path.join(self.dst, "a.txt"), "wb") as f:
            f.write(b"old")
        plan, rep = self.run_plan(self.O(conflict="skip"))
        self.assertEqual(rep.skipped, 1)
        self.assertTrue(os.path.exists(os.path.join(self.src, "a.txt")))

    def test_overwrite_backs_up_and_undo_restores(self):
        self.make("a.txt", b"new")
        with open(os.path.join(self.dst, "a.txt"), "wb") as f:
            f.write(b"old")
        plan, rep = self.run_plan(self.O(conflict="overwrite"))
        self.assertEqual(rep.done, 1)
        with open(os.path.join(self.dst, "a.txt"), "rb") as f:
            self.assertEqual(f.read(), b"new")
        backups = []
        for base, _, files in os.walk(os.path.join(self.jobs, rep.job_id)):
            backups += [os.path.join(base, f) for f in files if ".bak-" in f]
        self.assertTrue(backups, "旧目标应被备份而不是删除")
        M.undo_job(rep.job_id, self.jobs)
        with open(os.path.join(self.dst, "a.txt"), "rb") as f:
            self.assertEqual(f.read(), b"old")


class TestLinks(Base):
    def _junction(self, link, target):
        os.makedirs(target, exist_ok=True)
        rc = os.system('cmd /c mklink /J "%s" "%s" >nul 2>nul' % (link, target))
        return rc == 0

    def test_junction_cross_volume_rebuilt(self):
        target = os.path.join(self.root, "real")
        os.makedirs(target)
        with open(os.path.join(target, "keep.txt"), "wb") as f:
            f.write(b"k")
        link = os.path.join(self.src, "link")
        if not self._junction(link, target):
            self.skipTest("无法创建 junction")
        plan, rep = self.run_plan(self.O(force_copy=True))
        self.assertEqual(rep.failed, 0, rep.failures)
        new_link = os.path.join(self.dst, "link")
        self.assertTrue(os.path.exists(new_link))
        self.assertTrue(M.is_junction(new_link))
        self.assertEqual(M.read_link(new_link).lower().rstrip("\\"),
                         target.lower().rstrip("\\"))

    def test_junction_same_volume_is_renamed_not_copied(self):
        target = os.path.join(self.root, "real2")
        os.makedirs(target)
        link = os.path.join(self.src, "link2")
        if not self._junction(link, target):
            self.skipTest("无法创建 junction")
        plan, rep = self.run_plan()
        self.assertEqual(rep.failed, 0, rep.failures)
        self.assertTrue(M.is_junction(os.path.join(self.dst, "link2")))


class TestSafety(Base):
    def test_nested_destination_blocked(self):
        self.make("a.txt")
        plan = M.build_plan([self.src], os.path.join(self.src, "inside"), self.O())
        issues = M.preflight(plan)
        self.assertTrue(any(i.code == "nested" for i in issues))

    def test_drive_root_blocked(self):
        drive_root = os.path.splitdrive(self.root)[0] + "\\"
        self.assertTrue(M._is_protected(drive_root))
        plan = M.Plan([drive_root], self.dst, self.O())
        issues = M.preflight(plan)
        self.assertTrue(any(i.code == "protected" for i in issues))

    def test_cancel_stops_early(self):
        for i in range(60):
            self.make("f%03d.txt" % i, b"z" * 2000)
        ev = threading.Event()
        seen = {"n": 0}

        def progress(done, total, msg=""):
            seen["n"] = done
            if done >= 3:
                ev.set()

        plan = M.build_plan([self.src], self.dst, self.O(workers=1))
        rep = M.execute(plan, self.jobs, progress=progress, cancel=ev)
        self.assertTrue(rep.cancelled)
        left = os.listdir(self.src)
        self.assertGreater(len(left), 0, "取消后不该把源删空")
        self.assertLess(rep.done, 60)

    def test_verify_detects_tampered_destination(self):
        self.make("v.txt", b"payload" * 100)
        plan, rep = self.run_plan()
        p = os.path.join(self.dst, "v.txt")
        with open(p, "ab") as f:
            f.write(b"tamper")
        checked, bad = M.verify_job(rep.job_id, self.jobs)
        self.assertEqual(bad and bad[0][0], p)

    def test_long_path(self):
        deep = self.src
        for i in range(12):
            deep = os.path.join(deep, "d%02d" % i)
        os.makedirs(deep)
        with open(os.path.join(deep, "deep.txt"), "wb") as f:
            f.write(b"deep")
        plan, rep = self.run_plan(self.O(force_copy=True))
        self.assertEqual(rep.failed, 0, rep.failures)
        self.assertTrue(os.path.exists(os.path.join(
            self.dst, "d00", "d01", "d02", "d03", "d04", "d05",
            "d06", "d07", "d08", "d09", "d10", "d11", "deep.txt")))

    def test_journal_lists_job(self):
        self.make("j.txt")
        plan, rep = self.run_plan()
        jobs = M.list_jobs(self.jobs)
        self.assertEqual(jobs[0]["job_id"], rep.job_id)
        self.assertEqual(jobs[0]["status"], "finished")

    def test_resume_after_cancel(self):
        import json
        for i in range(40):
            self.make("r%02d.txt" % i, b"x" * 2000)
        ev = threading.Event()

        def progress(done, total, msg=""):
            if done >= 5:
                ev.set()

        plan = M.build_plan([self.src], self.dst, self.O(workers=1))
        rep = M.execute(plan, self.jobs, progress=progress, cancel=ev)
        self.assertTrue(rep.cancelled)
        left = len(os.listdir(self.src))
        self.assertGreater(left, 0)

        with open(os.path.join(self.jobs, rep.job_id, "plan.json"), encoding="utf-8") as f:
            d = json.load(f)
        p2 = M.Plan(d["sources"], d["dest"], M.Options.from_dict(d["opts"]))
        p2.items = [M.Item.from_dict(x) for x in d["items"]]
        rep2 = M.execute(p2, self.jobs, job_id=rep.job_id, resume=True)
        self.assertEqual(rep2.failed, 0, rep2.failures)
        self.assertFalse(os.path.exists(self.src))
        self.assertEqual(len(os.listdir(self.dst)), 40)
        self.assertFalse([f for f in os.listdir(self.dst) if f.endswith(".tmp")])

    def test_make_junction_safe_against_cmd_injection_and_protected_dirs(self):
        # 1. 非法控制字符与引号必须直接拒绝
        for bad in ('a"b', "a\nb", "a\0b"):
            with self.assertRaises(OSError):
                M.make_junction(os.path.join(self.root, bad), self.dst)

        # 2. 含 cmd 元字符 & 的目录名不得触发命令注入，且能正常重建 junction
        marker = os.path.join(self.root, "pwned_marker.txt")
        tricky_target = os.path.join(self.root, "R&D_target")
        os.makedirs(tricky_target, exist_ok=True)
        with open(os.path.join(tricky_target, "ok.txt"), "w", encoding="utf-8") as f:
            f.write("safe")
        tricky_link = os.path.join(self.root, "R&D_link")
        M.make_junction(tricky_link, tricky_target)
        try:
            self.assertTrue(os.path.lexists(tricky_link))
            self.assertTrue(os.path.isfile(os.path.join(tricky_link, "ok.txt")))
            self.assertFalse(os.path.exists(marker))
            # 已占用的链接路径再次创建必须报错
            with self.assertRaises(OSError):
                M.make_junction(tricky_link, tricky_target)
        finally:
            try:
                os.rmdir(tricky_link)
            except OSError:
                pass

        # 3. 扩展后的受保护系统目录校验
        self.assertTrue(M._is_protected(r"C:\$Recycle.Bin"))
        self.assertTrue(M._is_protected(r"C:\Recovery\WindowsRE"))
        self.assertTrue(M._is_protected(r"C:\Boot"))
        startup = os.path.join(
            os.path.expanduser("~"), "AppData", "Roaming", "Microsoft",
            "Windows", "Start Menu", "Programs", "Startup"
        )
        self.assertTrue(M._is_protected(startup))


if __name__ == "__main__":
    unittest.main(verbosity=2)
