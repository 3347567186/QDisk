# -*- coding: utf-8 -*-
"""数据目录 / 配置文件位置的回归测试。

对应 2026-11-13 的修复：
  1. 设置页改数据目录时，点「否（不迁移）」会把整次保存丢掉，界面也没提示
     —— 表现就是「数据目录改不了」；
  2. 配置文件永远钉在最早的数据目录里，旧目录一删设置就丢；
  3. 迁移只搬 history/logs/卸载备份/cache，迁移任务、tray.log 留在旧目录；
  4. 数据目录不校验：盘符根、程序目录、文件路径都能「保存成功」。

跑法（在 07_代码配置 目录下）：
    python -m unittest test_settings_dir -v
"""
import io
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import tidy  # noqa: E402


class Base(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="tidy_settings_")
        self.addCleanup(self._cleanup)
        self._saved = (tidy.HERE, tidy._LEGACY_DATA, tidy._PORTABLE_DATA,
                       tidy.SETTINGS_DIR, tidy.SETTINGS_PATH,
                       tidy.DEFAULT_DATA, tidy.DATA_DIR_MISSING)
        tidy.HERE = self.root
        tidy._LEGACY_DATA = os.path.join(self.root, "local")
        tidy._PORTABLE_DATA = os.path.join(self.root, "数据")
        tidy.DEFAULT_DATA = tidy._PORTABLE_DATA
        tidy.SETTINGS_DIR, tidy.SETTINGS_PATH = tidy.settings_paths_for(
            tidy.DEFAULT_DATA)
        self._appdata = os.environ.get("APPDATA")

    def _cleanup(self):
        (tidy.HERE, tidy._LEGACY_DATA, tidy._PORTABLE_DATA,
         tidy.SETTINGS_DIR, tidy.SETTINGS_PATH,
         tidy.DEFAULT_DATA, tidy.DATA_DIR_MISSING) = self._saved
        if self._appdata is None:
            os.environ.pop("APPDATA", None)
        else:
            os.environ["APPDATA"] = self._appdata
        import shutil
        shutil.rmtree(self.root, ignore_errors=True)

    def mk(self, *parts):
        p = os.path.join(self.root, *parts)
        os.makedirs(p, exist_ok=True)
        return p

    def write(self, path, text="x"):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with io.open(path, "w", encoding="utf-8") as f:
            f.write(text)
        return path


class TestLocator(Base):
    def test_roundtrip_and_missing(self):
        data = self.mk("data")
        loc = tidy.write_data_locator(data)
        self.assertTrue(loc)
        self.assertEqual(tidy.read_data_locator(), (data, "ok"))
        # 目录没了 → missing，但记住原来的路径，启动提示用得到
        os.rmdir(data)
        self.assertEqual(tidy.read_data_locator(), (data, "missing"))

    def test_none_when_absent(self):
        self.assertEqual(tidy.read_data_locator(), (None, "none"))


class TestSettingsPath(Base):
    def test_settings_follows_data_dir(self):
        data = self.mk("data")
        sd, sp = tidy.settings_paths_for(data)
        self.assertEqual(os.path.normcase(sd),
                         os.path.normcase(os.path.join(data, "配置")))
        self.assertEqual(os.path.basename(sp), "settings.json")

    def test_unwritable_falls_back_to_appdata(self):
        appdata = self.mk("appdata")
        os.environ["APPDATA"] = appdata
        old = tidy._dir_writable
        tidy._dir_writable = lambda d: False
        try:
            sd, sp = tidy.settings_paths_for(self.mk("ro"))
        finally:
            tidy._dir_writable = old
        self.assertEqual(os.path.normcase(sd),
                         os.path.normcase(os.path.join(appdata, "整理助手")))
        self.assertTrue(sp.endswith("settings.json"))


class TestSaveSettings(Base):
    def test_save_moves_config_and_writes_locator(self):
        d1 = self.mk("d1")
        s = {"data_dir": d1, "cache_dir": ""}
        self.assertTrue(tidy.save_settings(s))
        p1 = os.path.join(d1, "配置", "settings.json")
        self.assertTrue(os.path.isfile(p1))
        with io.open(p1, encoding="utf-8-sig") as f:
            self.assertEqual(json.load(f)["data_dir"], d1)
        self.assertEqual(tidy.SETTINGS_PATH, p1)
        with io.open(os.path.join(self.root, "数据位置.json"),
                     encoding="utf-8-sig") as f:
            self.assertEqual(json.load(f)["data_dir"], d1)

        # 再改一次数据目录：配置跟着搬，旧配置留着当兜底
        d2 = self.mk("d2")
        s["data_dir"] = d2
        self.assertTrue(tidy.save_settings(s))
        p2 = os.path.join(d2, "配置", "settings.json")
        self.assertTrue(os.path.isfile(p2))
        self.assertEqual(tidy.SETTINGS_PATH, p2)
        self.assertTrue(os.path.isfile(p1))

    def test_load_drops_missing_data_dir(self):
        missing = os.path.join(self.root, "gone")
        sp = self.write(os.path.join(self.root, "s.json"),
                        json.dumps({"data_dir": missing, "cache_dir": ""}))
        tidy.SETTINGS_PATH = sp
        tidy.DATA_DIR_MISSING = False
        s = tidy.load_settings()
        self.assertEqual(s["data_dir"], tidy.DEFAULT_DATA)
        self.assertTrue(tidy.DATA_DIR_MISSING)


class TestCheckDataDir(Base):
    def test_rejects(self):
        self.assertIsNotNone(tidy.check_data_dir(""))
        self.assertIsNotNone(tidy.check_data_dir("D:\\"))
        self.assertIsNotNone(tidy.check_data_dir(tidy.HERE))
        f = self.write(os.path.join(self.root, "a.txt"))
        self.assertIsNotNone(tidy.check_data_dir(f))

    def test_rejects_inside_old(self):
        old = self.mk("old")
        self.assertIsNotNone(tidy.check_data_dir(os.path.join(old, "sub"), old))

    def test_accepts_new(self):
        self.assertIsNone(tidy.check_data_dir(self.mk("ok")))


class TestMigrateData(Base):
    def test_moves_whole_data_dir_except_config(self):
        old = self.mk("old")
        self.write(os.path.join(old, "history", "a.json"))
        self.write(os.path.join(old, "logs", "x.log"))
        self.write(os.path.join(old, "cache", "c.bin"))
        self.write(os.path.join(old, "迁移", "job1", "job.json"))
        self.write(os.path.join(old, "tray.log"))
        self.write(os.path.join(old, "配置", "settings.json"), "{}")
        new = os.path.join(self.root, "new")
        moved, failed = tidy.migrate_data(old, new)
        self.assertEqual(failed, [])
        self.assertTrue(moved)
        for rel in ("history/a.json", "logs/x.log", "cache/c.bin",
                    "迁移/job1/job.json", "tray.log"):
            self.assertTrue(os.path.isfile(os.path.join(new, rel)), rel)
        self.assertFalse(os.path.exists(os.path.join(old, "history")))
        # 配置不归数据迁移管，留在原地由 save_settings 搬
        self.assertTrue(os.path.isfile(os.path.join(old, "配置", "settings.json")))

    def test_merge_keeps_existing(self):
        old = self.mk("old")
        new = self.mk("new")
        self.write(os.path.join(old, "history", "a.json"))
        self.write(os.path.join(new, "history", "b.json"))
        moved, failed = tidy.migrate_data(old, new)
        self.assertTrue(os.path.isfile(os.path.join(new, "history", "b.json")))
        self.assertTrue(os.path.isfile(os.path.join(new, "history", "a.json")))

    def test_refuses_nested_target(self):
        old = self.mk("old")
        self.write(os.path.join(old, "history", "a.json"))
        moved, failed = tidy.migrate_data(old, os.path.join(old, "sub"))
        self.assertTrue(failed)
        self.assertEqual(moved, [])

    def test_same_dir(self):
        old = self.mk("same")
        self.assertTrue(tidy.migrate_data(old, old)[1])


if __name__ == "__main__":
    unittest.main(verbosity=2)
