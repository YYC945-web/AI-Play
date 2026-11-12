#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
题库浮窗搜索工具 v2.0
- 始终置顶的悬浮窗口
- 粘贴题目文字即时搜索
- 显示匹配题目及答案
- 支持模糊匹配和关键词高亮
"""

import tkinter as tk
from tkinter import ttk
import os
import re
import sys
from pathlib import Path

# ==================== 界面配置 ====================
import traceback
import datetime

def _log_error(msg):
    try:
        log_path = Path(__file__).parent / "题库搜索_错误.log"
        with open(log_path, "a", encoding="utf-8") as lf:
            lf.write(f"[{datetime.datetime.now()}] {msg}\n")
    except:
        pass

WINDOW_WIDTH = 520
WINDOW_HEIGHT = 550
# Fallback font stack for Windows
_FONT_FAMILY = "Microsoft YaHei UI"
try:
    import tkinter.font as tkfont
    test_root = tk.Tk()
    test_root.withdraw()
    avail = list(tkfont.families())
    test_root.destroy()
    if _FONT_FAMILY not in avail:
        _FONT_FAMILY = "Segoe UI" if "Segoe UI" in avail else "TkDefaultFont"
except:
    _FONT_FAMILY = "TkDefaultFont"

FONT = (_FONT_FAMILY, 10)
FONT_SM = (_FONT_FAMILY, 9)
FONT_BOLD = (_FONT_FAMILY, 10, "bold")
FONT_TITLE = (_FONT_FAMILY, 11, "bold")

BG = "#1e1e2e"
FG = "#cdd6f4"
ENTRY_BG = "#313244"
CARD_BG1 = "#1a1a2e"
CARD_BG2 = "#222239"
ACCENT = "#cba6f7"
ANSWER_BG = "#a6e3a1"
HIGHLIGHT_KW = "#f9e2af"


class QuestionBank:
    """题库管理 + 搜索"""

    def __init__(self, folder):
        self.folder = Path(folder)
        self.questions = []
        self._load()

    def _load(self):
        """载入所有 txt 题库"""
        self.questions = []
        for fpath in sorted(self.folder.glob("通信*.txt")):
            try:
                with open(fpath, encoding="utf-8") as fh:
                    raw = fh.read()
            except Exception:
                continue

            source = fpath.stem.replace("通信系统综合设计", "")
            blocks = self._split(raw)

            for blk in blocks:
                blk = blk.strip()
                if len(blk) < 8:
                    continue

                qtype = ("判断题" if "判断题" in blk[:30] else
                         "单选题" if "单选题" in blk[:30] else
                         "简答题" if ("简答" in blk[:30] or "问答" in blk[:30]) else "题目")

                # 提取答案
                ans = self._extract_answer(blk)

                self.questions.append({
                    "source": source,
                    "type": qtype,
                    "text": blk,
                    "answer": ans,
                })

    @staticmethod
    def _split(text):
        """智能分割题目 - 处理带编号和不带编号的混合情况"""
        # 按题目头切分："1.【单选题】"  "【判断题】"(无编号) 等
        # 题目头 = 可选数字前缀 + 【xxx题】
        combined_pattern = r'\n(?=(?:\d+[\.\、】]\s*)?【[^】]+题】)'
        parts = re.split(combined_pattern, text)
        parts = [p.strip() for p in parts if len(p.strip()) > 8]

        if len(parts) >= 3:
            return parts

        # 兜底：不要求前面的换行
        parts = re.split(r'(?=(?:\d+[\.\、】]\s*)?【[^】]+题】)', text)
        parts = [p.strip() for p in parts if len(p.strip()) > 8]
        if len(parts) >= 3:
            return parts

        # 最后兜底
        return [text]

    @staticmethod
    def _extract_answer(text):
        """提取答案字母/对错"""
        # 答案：X
        m = re.search(r'答案[：:]\s*([A-D对错])', text)
        if m:
            return m.group(1)
        # （X）格式 - 通常在题目末尾或选项之前
        m = re.search(r'[（(]([A-D对错])[）)]', text)
        if m:
            return m.group(1)
        return None

    def search(self, query, top_n=15):
        """搜索并返回排序结果"""
        query = query.strip()
        if not query:
            return []

        scored = []
        for q in self.questions:
            s = self._score(query, q["text"])
            if s > 0:
                scored.append({**q, "score": s})

        scored.sort(key=lambda x: x["score"], reverse=True)
        return scored[:top_n]

    def _score(self, query, text):
        """匹配打分"""
        s = 0
        ql = query.lower()
        tl = text.lower()

        # 完整包含
        if ql in tl:
            s += 100

        # 去除标点后包含
        q_clean = re.sub(r'[^\w一-鿿]', '', ql)
        t_clean = re.sub(r'[^\w一-鿿]', '', tl)
        if len(q_clean) >= 2 and q_clean in t_clean:
            s += 80

        # 关键词匹配
        kw_cn = re.findall(r'[一-鿿]{2,}', query)
        kw_en = re.findall(r'[A-Za-z0-9]{2,}', query)
        keywords = kw_cn + kw_en

        if keywords:
            hit = sum(1 for k in keywords if k.lower() in tl)
            s += int(hit / len(keywords) * 60)

        # 开头匹配（用户可能输入题目的开头）
        first_line = text.strip().split('\n')[0]
        if len(query) >= 4 and query[:4] in first_line:
            s += 30

        return s


# ==================== UI ====================

class App:
    def __init__(self):
        try:
            self.bank = QuestionBank(Path(__file__).parent)
        except Exception as e:
            _log_error(f"Bank load failed: {e}\n{traceback.format_exc()}")
            raise

        self.root = tk.Tk()
        self.root.title("题库搜索")
        self.root.geometry(f"{WINDOW_WIDTH}x{WINDOW_HEIGHT}")
        self.root.minsize(380, 320)
        self.root.attributes("-topmost", True)
        self.root.configure(bg=BG)

        self._drag = {"x": 0, "y": 0}
        self._tray_win = None
        try:
            self._build()
        except Exception as e:
            _log_error(f"UI build failed: {e}\n{traceback.format_exc()}")
            raise

        # 快捷键
        self.root.bind("<Control-f>", lambda e: self._focus_search())
        self.root.bind("<Escape>", lambda e: self._hide())
        self.root.bind("<Control-q>", lambda e: self._quit())
        self.root.protocol("WM_DELETE_WINDOW", self._hide)

        _log_error("App initialized successfully")

    # ---- 界面布局 ----
    def _build(self):
        # 标题栏
        bar = tk.Frame(self.root, bg=ACCENT, height=34)
        bar.pack(fill=tk.X)
        bar.pack_propagate(False)

        lbl = tk.Label(bar, text="📋 题库浮窗搜索", font=FONT_TITLE,
                       bg=ACCENT, fg="#1e1e2e")
        lbl.pack(side=tk.LEFT, padx=12, pady=4)

        for txt, cmd in [("—", self._hide), ("✕", self._quit)]:
            b = tk.Button(bar, text=txt, command=cmd, bg=ACCENT, fg="#1e1e2e",
                          bd=0, font=("Microsoft YaHei UI", 13, "bold"),
                          cursor="hand2", activebackground="#b4a0e0")
            b.pack(side=tk.RIGHT, padx=4, pady=4)

        for w in (bar, lbl):
            w.bind("<Button-1>", self._drag_start)
            w.bind("<B1-Motion>", self._drag_move)

        # 搜索区
        sf = tk.Frame(self.root, bg=BG)
        sf.pack(fill=tk.X, padx=10, pady=(10, 0))

        row = tk.Frame(sf, bg=BG)
        row.pack(fill=tk.X)

        tk.Label(row, text="🔍", font=("Microsoft YaHei UI", 13), bg=BG, fg=FG).pack(side=tk.LEFT, padx=(0, 6))

        self.entry = tk.Entry(row, font=FONT, bg=ENTRY_BG, fg=FG,
                              insertbackground=FG, relief=tk.FLAT, bd=1)
        self.entry.pack(side=tk.LEFT, fill=tk.X, expand=True)
        self.entry.focus_set()

        tk.Button(row, text="搜索", command=self._search, bg="#45475a", fg=FG,
                  bd=0, font=FONT_SM, cursor="hand2",
                  activebackground=ACCENT, activeforeground="#1e1e2e"
                  ).pack(side=tk.LEFT, padx=(6, 0))

        tk.Label(sf, text="粘贴题目或关键词 → 自动搜索 | 双击结果可复制 | Esc 最小化",
                 font=("Microsoft YaHei UI", 8), bg=BG, fg="#6c7086"
                 ).pack(anchor=tk.W, pady=(4, 0))

        # 状态
        self.status = tk.Label(self.root, text=f"题库共 {len(self.bank.questions)} 题",
                               font=("Microsoft YaHei UI", 8), bg=BG, fg="#6c7086")
        self.status.pack(anchor=tk.W, padx=12, pady=(4, 0))

        # 结果区
        rf = tk.Frame(self.root, bg=BG)
        rf.pack(fill=tk.BOTH, expand=True, padx=10, pady=(4, 10))

        self.canvas = tk.Canvas(rf, bg=CARD_BG1, highlightthickness=0, bd=0)
        sb = tk.Scrollbar(rf, orient=tk.VERTICAL, command=self.canvas.yview)
        self.content = tk.Frame(self.canvas, bg=CARD_BG1)

        self.content.bind("<Configure>",
                          lambda e: self.canvas.configure(scrollregion=self.canvas.bbox("all")))
        self._cw = self.canvas.create_window((0, 0), window=self.content, anchor=tk.NW)

        def _resize(e):
            self.canvas.itemconfig(self._cw, width=e.width)
        self.canvas.bind("<Configure>", _resize)
        self.canvas.bind_all("<MouseWheel>",
                             lambda e: self.canvas.yview_scroll(int(-e.delta / 120), "units"))

        self.canvas.configure(yscrollcommand=sb.set)
        self.canvas.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        sb.pack(side=tk.RIGHT, fill=tk.Y)

        # 底部
        bf = tk.Frame(self.root, bg=BG)
        bf.pack(fill=tk.X, padx=10, pady=(0, 8))

        for txt, cmd in [("清空", self._clear), ("显示全部", self._show_all)]:
            tk.Button(bf, text=txt, command=cmd, bg="#45475a", fg=FG,
                      bd=0, font=FONT_SM, cursor="hand2",
                      activebackground=ACCENT).pack(side=tk.LEFT, padx=(0, 6))

        tk.Label(bf, text="v2.0", font=("Microsoft YaHei UI", 7),
                 bg=BG, fg="#585b70").pack(side=tk.RIGHT)

        # 绑定
        self.entry.bind("<KeyRelease>", lambda e: self._search())
        self.entry.bind("<Return>", lambda e: self._search())
        self.entry.bind("<Control-v>", lambda e: self.root.after(100, self._search))
        self.entry.bind("<Button-3>", self._right_paste)

    # ---- 搜索逻辑 ----
    def _search(self):
        q = self.entry.get().strip()
        self._clear_results()

        if not q:
            self.status.config(text=f"题库共 {len(self.bank.questions)} 题")
            return

        results = self.bank.search(q)
        self._show(results, q)

    def _show_all(self):
        self.entry.delete(0, tk.END)
        self._show(self.bank.questions, "全部题目")

    def _clear(self):
        self.entry.delete(0, tk.END)
        self._clear_results()
        self.status.config(text=f"题库共 {len(self.bank.questions)} 题")

    def _clear_results(self):
        for w in self.content.winfo_children():
            w.destroy()

    def _show(self, results, desc=""):
        self._clear_results()

        if not results:
            tk.Label(self.content, text="😕 未找到匹配\n\n试试：减少关键词 / 用核心词汇 / 粘贴完整题目",
                     font=FONT, bg=CARD_BG1, fg="#6c7086", justify=tk.LEFT
                     ).pack(padx=20, pady=30, anchor=tk.W)
            self.status.config(text=f"无结果 | 共 {len(self.bank.questions)} 题")
            return

        desc_short = desc[:30] + ("..." if len(desc) > 30 else "")
        self.status.config(text=f"「{desc_short}」→ {len(results)} 个结果 | 共 {len(self.bank.questions)} 题")

        for i, q in enumerate(results):
            self._card(q, i)

    def _card(self, q, idx):
        """单条结果卡片"""
        bg = CARD_BG2 if idx % 2 else CARD_BG1
        card = tk.Frame(self.content, bg=bg)
        card.pack(fill=tk.X, padx=2, pady=1)

        # 顶栏
        hdr = tk.Frame(card, bg=bg)
        hdr.pack(fill=tk.X, padx=10, pady=(6, 0))

        # 题型标签
        tc = {"单选题": "#89b4fa", "判断题": "#f9e2af", "简答题": "#a6e3a1", "题目": "#cba6f7"}
        tk.Label(hdr, text=q["type"], font=("Microsoft YaHei UI", 8, "bold"),
                 bg=tc.get(q["type"], "#cba6f7"), fg="#1e1e2e", padx=6, pady=1
                 ).pack(side=tk.LEFT)

        # 来源
        tk.Label(hdr, text=f" {q['source']}", font=("Microsoft YaHei UI", 8),
                 bg=bg, fg="#6c7086").pack(side=tk.LEFT, padx=(6, 0))

        # 答案
        if q["answer"]:
            af = tk.Frame(hdr, bg=ANSWER_BG)
            af.pack(side=tk.RIGHT)
            tk.Label(af, text=f" 答案: {q['answer']} ",
                     font=("Microsoft YaHei UI", 11, "bold"),
                     bg=ANSWER_BG, fg="#1e1e2e", padx=8).pack()

        # 题目正文
        tf = tk.Frame(card, bg=bg)
        tf.pack(fill=tk.X, padx=10, pady=(4, 8))

        text_w = tk.Text(tf, font=FONT_SM, bg=bg, fg=FG, wrap=tk.WORD,
                         height=min(10, max(2, q["text"].count('\n') + 1)),
                         bd=0, padx=0, pady=0, cursor="arrow")
        text_w.pack(fill=tk.X, expand=True)
        text_w.insert("1.0", q["text"])

        # 高亮答案
        if q["answer"]:
            a = q["answer"]
            for pat in [f'（{a}）', f'({a})', f'答案：{a}', f'答案:{a}']:
                pos = "1.0"
                while True:
                    pos = text_w.search(pat, pos, tk.END)
                    if not pos:
                        break
                    text_w.tag_add("ans", pos, f"{pos}+{len(pat)}c")
                    pos = f"{pos}+1c"

        # 高亮关键词
        query = self.entry.get().strip()
        if query:
            kws = re.findall(r'[一-鿿]{2,}', query) + re.findall(r'[A-Za-z0-9]{2,}', query)
            if not kws:
                kws = [query]
            for kw in kws[:8]:
                if len(kw) < 2:
                    continue
                pos = "1.0"
                while True:
                    pos = text_w.search(kw, pos, tk.END, nocase=True)
                    if not pos:
                        break
                    text_w.tag_add("kw", pos, f"{pos}+{len(kw)}c")
                    pos = f"{pos}+1c"

        text_w.tag_config("ans", background="#1e3a1e", foreground=ANSWER_BG,
                          font=("Microsoft YaHei UI", 9, "bold"))
        text_w.tag_config("kw", background="#3a3a1e", foreground=HIGHLIGHT_KW)
        text_w.config(state=tk.DISABLED)

        # 双击可选
        def _on_dbl(e, tw=text_w):
            tw.config(state=tk.NORMAL)
            tw.focus_set()
        text_w.bind("<Double-1>", _on_dbl)
        text_w.bind("<FocusOut>", lambda e, tw=text_w: tw.config(state=tk.DISABLED))

    # ---- 窗口操作 ----
    def _drag_start(self, e):
        self._drag["x"], self._drag["y"] = e.x, e.y

    def _drag_move(self, e):
        x = self.root.winfo_x() + e.x - self._drag["x"]
        y = self.root.winfo_y() + e.y - self._drag["y"]
        self.root.geometry(f"+{x}+{y}")

    def _focus_search(self):
        self.root.deiconify()
        self.root.lift()
        self.entry.focus_set()

    def _hide(self):
        self.root.withdraw()
        self._show_tray()

    def _show_tray(self):
        if self._tray_win:
            return
        tw = tk.Toplevel(self.root)
        tw.overrideredirect(True)
        tw.attributes("-topmost", True)
        tw.configure(bg=ACCENT)
        sw = self.root.winfo_screenwidth()
        sh = self.root.winfo_screenheight()
        tw.geometry(f"160x36+{sw-170}+{sh-76}")

        tk.Button(tw, text="📋 展开题库搜索",
                  command=lambda: self._restore(tw),
                  bg=ACCENT, fg="#1e1e2e", bd=0, font=FONT_SM, cursor="hand2"
                  ).pack(fill=tk.BOTH, expand=True, padx=2, pady=2)
        self._tray_win = tw

    def _restore(self, tw):
        tw.destroy()
        self._tray_win = None
        self.root.deiconify()
        self.root.lift()
        self.entry.focus_set()

    def _right_paste(self, e):
        try:
            txt = self.root.clipboard_get()
            self.entry.delete(0, tk.END)
            self.entry.insert(0, txt)
            self._search()
        except Exception:
            pass

    def _quit(self):
        if self._tray_win:
            self._tray_win.destroy()
        self.root.destroy()

    def run(self):
        try:
            self.root.update_idletasks()
            sw = self.root.winfo_screenwidth()
            sh = self.root.winfo_screenheight()
            x = max(0, sw - WINDOW_WIDTH - 40)
            y = max(0, (sh - WINDOW_HEIGHT) // 2)
            self.root.geometry(f"{WINDOW_WIDTH}x{WINDOW_HEIGHT}+{x}+{y}")
            self.root.deiconify()
            self.root.lift()
            self.root.focus_force()
            self.entry.focus_set()
            _log_error(f"Window shown at {x},{y} / screen {sw}x{sh}")
            self.root.mainloop()
        except Exception as e:
            _log_error(f"Run crashed: {e}\n{traceback.format_exc()}")
            raise


if __name__ == "__main__":
    App().run()
