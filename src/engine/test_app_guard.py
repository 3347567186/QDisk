# -*- coding: utf-8 -*-
"""程序安装目录保护的回归测试。

对应一条硬规则：程序目录一律不动——不整理、不搬走、不合并、不清空。
规则来自两次真实事故：
  1. D:\\App\\123网盘\\123pan 被整体合并进 D:\\App\\百度网盘\\，
     原目录只剩空壳，开始菜单快捷方式和卸载注册表全部失效；
  2. 缓存清理把 C:\\ 和 D:\\ 当自定义缓存目录，一次删掉
     254845 个文件 / 43.24 GB，D:\\App、D:\\Tool 下一堆软件只剩空壳。

跑法（在 07_代码配置 目录下）：
    python -m unittest test_app_guard -v
"""
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import migrate_engine as M


def mk(path, files=(), dirs=()):
    os.makedirs(path, exist_ok=True)
    for d in dirs:
        os.makedirs(os.path.join(path, d), exist_ok=True)
    for f in files:
        with open(os.path.join(path, f), "wb") as fh:
            fh.write(b"x")


class Sandbox(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="appguard_")
        self.app = os.path.join(self.tmp, "123pan")
        mk(self.app, ["123pan.exe", "uninst.exe"])
        self.docs = os.path.join(self.tmp, "docs")
        mk(self.docs, ["a.txt", "b.docx"])
        self.dest = os.path.join(self.tmp, "dest")
        os.makedirs(self.dest, exist_ok=True)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)


class TestDetect(Sandbox):
    def test_uninstaller_is_app(self):
        hit, why = M.looks_like_app_dir(self.app)
        self.assertTrue(hit)
        self.assertIn("卸载器", why)

    def test_electron_marker_is_app(self):
        p = os.path.join(self.tmp, "code")
        mk(p, ["app.asar", "Code.exe"])
        self.assertTrue(M.looks_like_app_dir(p)[0])

    def test_exe_plus_runtime_is_app(self):
        p = os.path.join(self.tmp, "tool")
        mk(p, ["a.exe", "1.dll", "2.dll", "3.pak"])
        self.assertTrue(M.looks_like_app_dir(p)[0])

    def test_single_exe_is_not_app(self):
        p = os.path.join(self.tmp, "junk")
        mk(p, ["setup.exe", "note.txt"])
        self.assertFalse(M.looks_like_app_dir(p)[0])

    def test_plain_folder_is_not_app(self):
        self.assertFalse(M.looks_like_app_dir(self.docs)[0])

    def test_missing_folder_is_not_app(self):
        self.assertFalse(M.looks_like_app_dir(os.path.join(self.tmp, "nope"))[0])


class TestPlan(Sandbox):
    def codes(self, plan):
        return {i.code for i in M.preflight(plan)}

    def test_source_app_dir_refused(self):
        plan = M.build_plan([self.app], self.dest, M.Options())
        self.assertIn("app-dir", self.codes(plan))

    def test_source_app_dir_refused_even_with_allow_root(self):
        plan = M.build_plan([self.app], self.dest, M.Options(allow_root=True))
        self.assertIn("app-dir", self.codes(plan))

    def test_dest_app_dir_refused(self):
        plan = M.build_plan([self.docs], self.app, M.Options())
        self.assertIn("dest-app-dir", self.codes(plan))

    def test_merge_into_app_dir_refused(self):
        # 把 docs 搬到 dest，而 dest\docs 已经是个程序目录 → 合并即拆散
        inner = os.path.join(self.dest, "docs")
        mk(inner, ["x.exe", "unins000.exe"])
        plan = M.build_plan([self.docs], self.dest, M.Options(conflict="merge"))
        codes = self.codes(plan)
        self.assertTrue({"merge-into-app", "dest-app-dir"} & codes, codes)

    def test_normal_plan_still_passes(self):
        plan = M.build_plan([self.docs], self.dest, M.Options())
        self.assertNotIn("app-dir", self.codes(plan))


class TestContainer(Sandbox):
    """D:\\各种拓展 这种「软件总目录」：本身没有程序特征，但下面全是程序目录。"""

    def _box(self, name="各种拓展"):
        box = os.path.join(self.tmp, name)
        mk(os.path.join(box, "bitcomet"), ["BitComet.exe", "unins000.exe"])
        mk(os.path.join(box, "boosterx"), ["BoosterX.exe", "1.dll", "2.dll", "3.pak"])
        return box

    def test_container_detected(self):
        box = self._box()
        hit, ev = M.looks_like_app_container(box)
        self.assertTrue(hit, ev)

    def test_one_app_is_not_container(self):
        box = os.path.join(self.tmp, "one")
        mk(os.path.join(box, "only"), ["Only.exe", "unins000.exe"])
        self.assertFalse(M.looks_like_app_container(box)[0])

    def test_plain_folder_is_not_container(self):
        self.assertFalse(M.looks_like_app_container(self.docs)[0])


class TestTidyRules(Sandbox):
    """tidy.py 侧的规则：整理入口 + 缓存清理入口都要拦住程序目录。"""

    @classmethod
    def setUpClass(cls):
        try:
            import tidy
        except Exception as ex:            # tkinter 等环境缺失时跳过
            raise unittest.SkipTest("tidy.py 导入失败：%s" % ex)
        cls.tidy = tidy
        cls.rules = tidy.load_rules()

    def test_rules_parsed(self):
        r = self.rules
        self.assertTrue(r.protect_app_dirs)
        self.assertIn(".dll", r.rt_exts)
        self.assertIn("unins000.exe", r.app_uninstallers)
        self.assertTrue(r.cache_forbid_roots)
        self.assertIn(".exe", r.cache_keep_exts)

    def test_check_target_refuses_app_dir(self):
        why = self.tidy.check_target(self.app, self.rules)
        self.assertTrue(why and "程序安装目录" in why, why)

    def test_check_target_refuses_plain_dir(self):
        self.assertIsNone(self.tidy.check_target(self.docs, self.rules))

    def test_check_target_refuses_container(self):
        box = os.path.join(self.tmp, "总目录")
        mk(os.path.join(box, "a"), ["a.exe", "unins000.exe"])
        mk(os.path.join(box, "b"), ["b.exe", "unins000.exe"])
        why = self.tidy.check_target(box, self.rules)
        self.assertTrue(why and "软件总目录" in why, why)

    def test_check_target_refuses_half_wrecked_shell(self):
        """上一轮被清空的残壳：只剩 uninstall\\ 子目录的也要认出来。"""
        shell = os.path.join(self.tmp, "Kuaijiasu")
        mk(shell, ["manifest.json", "a.dll", "b.dll", "c.dll"],
           dirs=[os.path.join("uninstall")])
        why = self.tidy.check_target(shell, self.rules)
        self.assertTrue(why and "程序安装目录" in why, why)

    def test_scan_refuses_app_dir(self):
        plan = self.tidy.scan(self.app, self.rules, use_content=False)
        self.assertTrue(plan.error and "程序安装目录" in plan.error, plan.error)

    def test_cache_custom_refuses_drive_root(self):
        why = self.tidy.check_cache_custom_dir("C:\\", self.rules)
        self.assertTrue(why and "盘符根目录" in why, why)

    def test_cache_custom_refuses_parent_of_app(self):
        why = self.tidy.check_cache_custom_dir(self.tmp, self.rules)
        self.assertTrue(why and "程序安装目录" in why, why)

    def test_cache_custom_refuses_deep_dir(self):
        why = self.tidy.check_cache_custom_dir(self.docs, self.rules)
        self.assertTrue(why and "层级过深" in why, why)

    def test_cache_custom_allows_plain_dir(self):
        import copy
        r = copy.copy(self.rules)
        r.cache_custom_max_depth = 30          # 临时目录天生很深，放宽层级再看
        self.assertIsNone(self.tidy.check_cache_custom_dir(self.docs, r))

    def test_clean_skips_app_dir(self):
        """把程序目录当缓存目录清，必须一个文件都不删。"""
        skipped = []
        n, fails, freed = self.tidy.clean_cache_paths(
            [self.app], rules=self.rules, skipped=skipped)
        self.assertTrue(os.path.exists(os.path.join(self.app, "123pan.exe")))
        self.assertTrue(skipped, "应当记录被跳过的程序目录")
        self.assertEqual(n, 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
