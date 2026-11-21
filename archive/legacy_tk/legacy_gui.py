# -*- coding: utf-8 -*-
"""TidyAssistant 历史 Tkinter 界面实现归档。
自 v1.42.10 起从 src/engine/tidy.py 分离归档。
现代主界面完全由 Tauri (Rust + WebView2 + Web) 负责，此文件仅供历史参考与算法审阅。
"""
import os
import sys
import json
import time
import shutil
import subprocess
import threading
import tkinter as tk
from tkinter import ttk, filedialog, messagebox, simpledialog


# ─── 预览与帮助组件 ───

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


# ─── 主窗口与关闭对话框 ───

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

