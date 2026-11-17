"""打包后的引擎冒烟：把 引擎\\整理助手引擎.exe 当 RPC 服务跑一遍。

用法（在仓库根目录）：
    python tools\\smoke_engine.py

为什么要有它：PyInstaller 裁包之后，"能启动"不等于"能用"。这个脚本按行发 JSON、
按行收 JSON，把每个页面的主查询都走一遍。任何一行 [FAIL] 都说明裁掉了不该裁的东西。

注意：只做只读调用；会改文件的调用一律带 confirm=false。
"""
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXE = os.path.join(ROOT, "引擎", "整理助手引擎.exe")

# (方法, 参数, 说明)
CASES = [
    ("ping", {}, "引擎握手"),
    ("settings.get", {}, "读配置"),
    ("scan", {"path": ROOT, "skip_recent": False}, "扫描文件"),
    ("scan", {"path": ROOT, "skip_recent": False, "use_content": True}, "扫描（含内容识别）"),
    ("organize", {"path": ROOT, "plan": [], "confirm": False}, "整理预演"),
    ("shots.scan", {"days": 0, "min_kb": 0}, "扫描截图"),
    ("cache.list", {}, "缓存分组"),
    ("apps.list", {}, "已安装程序"),
    ("search.index", {"roots": [], "reuse": True}, "索引状态"),
    ("search.query", {"q": "tidy", "limit": 5}, "搜索"),
    ("migrate.plan", {"sources": [os.path.join(ROOT, "docs")], "destination": os.path.join(ROOT, "docs")}, "迁移预演"),
    ("undo", {"path": ROOT}, "查询可撤销记录"),
]


def main():
    if not os.path.exists(EXE):
        print("找不到引擎：%s" % EXE)
        return 2

    proc = subprocess.Popen(
        [EXE, "--engine"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=ROOT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )

    ok = fail = 0
    try:
        for i, (method, params, label) in enumerate(CASES, 1):
            proc.stdin.write(json.dumps({"id": i, "method": method, "params": params}) + "\n")
            proc.stdin.flush()
            line = proc.stdout.readline()
            if not line:
                print("[FAIL] %-22s %s —— 引擎没有回话" % (method, label))
                fail += 1
                break
            resp = json.loads(line)
            if resp.get("ok"):
                data = resp.get("result")
                brief = json.dumps(data, ensure_ascii=False) if data is not None else ""
                if len(brief) > 96:
                    brief = brief[:96] + "…"
                print("[OK]   %-22s %s  %s" % (method, label, brief))
                ok += 1
            else:
                print("[FAIL] %-22s %s —— %s" % (method, label, resp.get("error")))
                fail += 1
    finally:
        try:
            proc.stdin.close()
        except Exception:
            pass
        try:
            proc.wait(timeout=15)
        except Exception:
            proc.kill()

    err = (proc.stderr.read() or "").strip()
    if err:
        print("\n--- stderr ---")
        print(err[:2000])

    print("\n通过 %d / 失败 %d" % (ok, fail))
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
