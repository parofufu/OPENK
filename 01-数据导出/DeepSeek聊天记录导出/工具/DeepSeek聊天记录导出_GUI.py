#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
DeepSeek 聊天记录导出 · 图形版（零依赖，单文件）

把程序放在导出包所在目录的同级目录，双击运行（管理员权限启动）。

操作：
  1. 自动扫描同级目录下的 chat_session_index.json
  2. 输入关键词 → 回车或点右侧“搜索”
  3. 列表中单击 = 预选；按住 Ctrl 再单击 = 多选
  4. 底部选择格式，点“确定”开始导出

导出结果为 Markdown（含附件）与可选 JSON，便于人工或大模型核对数据可靠性。
"""

import ctypes
import json
import os
import re
import shutil
import sys
import threading
import tkinter as tk
from collections import Counter
from datetime import datetime
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

APP_VERSION = "1.0"
SUPPORTED_FORMAT_VERSION = 3
FORMAT_OPTIONS = ["Markdown（推荐）", "Markdown + JSON", "仅 JSON"]
SKIP_DIRS = {".git", "__pycache__", "build", "dist", ".screenshots", "配图", "exported", "attachments"}


# ---------------------------------------------------------------------------
# 通用工具
# ---------------------------------------------------------------------------

def app_base_dir() -> Path:
    """exe 或脚本所在目录"""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def now_text() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def iso_to_local(iso: str) -> str:
    if not iso:
        return ""
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone().strftime("%Y-%m-%d %H:%M:%S")
    except ValueError:
        return iso


def parse_iso(iso: str):
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None


def safe_name(text: str, fallback: str) -> str:
    cleaned = "".join(c for c in text if c not in r'\/:*?"<>|').strip()
    return (cleaned or fallback)[:60]


def human_size(num) -> str:
    try:
        num = int(num)
    except (TypeError, ValueError):
        return "?"
    if num < 1024:
        return f"{num} B"
    if num < 1024 * 1024:
        return f"{num / 1024:.1f} KB"
    return f"{num / 1024 / 1024:.1f} MB"


def load_json(path: Path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def rel_text(path: Path, base: Path) -> str:
    try:
        return str(path.relative_to(base))
    except ValueError:
        return str(path)


# ---------------------------------------------------------------------------
# 数据发现与解析
# ---------------------------------------------------------------------------

def find_data_dirs(base: Path) -> list:
    """在 base 下最多 3 层查找解压后的导出目录（含 chat_session_index.json）"""
    hits = []
    base = base.resolve()
    for root, dirs, files in os.walk(base):
        root_path = Path(root)
        depth = 0 if root_path == base else len(root_path.relative_to(base).parts)
        if depth > 3:
            dirs[:] = []
            continue
        if "chat_session_index.json" in files:
            hits.append(root_path)
            dirs[:] = []
            continue
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith("导出结果")]
    hits.sort(key=lambda p: (p / "chat_session_index.json").stat().st_size, reverse=True)
    return hits


def load_index(data_dir: Path) -> list:
    path = data_dir / "chat_session_index.json"
    if not path.exists():
        return []
    data = load_json(path)
    return data if isinstance(data, list) else []


def manifest_version(data_dir: Path):
    path = data_dir / "manifest.json"
    if not path.exists():
        return None
    try:
        return load_json(path).get("export_format_version")
    except (json.JSONDecodeError, OSError):
        return None


def analyze_session(session: dict, data_dir: Path) -> dict:
    """统计结构特征，供人工/大模型判断数据完整性"""
    counts = Counter()
    msg_count = len(session.get("messages", []))
    attachments = not_packaged = missing = null_opens = inversions = 0
    prev_dt = None

    for msg in session.get("messages", []):
        dt = parse_iso(msg.get("inserted_at", ""))
        if dt and prev_dt and dt < prev_dt:
            inversions += 1
        if dt:
            prev_dt = dt
        for frag in msg.get("fragments", []):
            ftype = frag.get("type", "UNKNOWN")
            counts[ftype] += 1
            if ftype == "TOOL_OPEN" and not frag.get("url"):
                null_opens += 1
            for f in frag.get("files", []) or []:
                attachments += 1
                if not f.get("export_path"):
                    not_packaged += 1
                elif not (data_dir / f.get("export_path")).exists():
                    missing += 1

    return {
        "messages": msg_count,
        "fragments": sum(counts.values()),
        "counts": dict(counts),
        "attachments": attachments,
        "not_packaged": not_packaged,
        "missing": missing,
        "inversions": inversions,
        "null_opens": null_opens,
    }


# ---------------------------------------------------------------------------
# 渲染与导出
# ---------------------------------------------------------------------------

def copy_attachments(session: dict, data_dir: Path, attach_dir: Path) -> dict:
    """复制附件，返回 export_path → 目标文件名 / None(缺失)"""
    mapping = {}
    for msg in session.get("messages", []):
        for frag in msg.get("fragments", []):
            if frag.get("type") != "FILE":
                continue
            for f in frag.get("files", []) or []:
                rel = f.get("export_path") or ""
                src = data_dir / rel
                if not rel or not src.exists():
                    mapping[rel] = None
                    continue
                attach_dir.mkdir(parents=True, exist_ok=True)
                dest = attach_dir / src.name
                if not dest.exists():
                    shutil.copy2(src, dest)
                mapping[rel] = src.name
    return mapping


def render_markdown(session: dict, data_dir: Path, stats: dict, copies: dict,
                    exported_at: str, source_label: str) -> str:
    title = session.get("title", "未命名会话")
    lines = [
        f"# {title}",
        "",
        f"> **数据来源**：`{source_label}`  ",
        f"> **会话 ID**：`{session.get('id')}` · **导出时间**：{exported_at}  ",
        f"> **消息** {stats['messages']} 条 · **片段** {stats['fragments']} 个 · "
        f"**附件** {stats['attachments']} 个（未打包 {stats['not_packaged']} / 缺失 {stats['missing']}）  ",
        f"> **时间倒挂** {stats['inversions']} 处 · **空网页记录** {stats['null_opens']} 条 · "
        f"**创建** {iso_to_local(session.get('inserted_at', ''))} · "
        f"**更新** {iso_to_local(session.get('updated_at', ''))}",
        "",
        "## 片段构成",
        "",
        "| 类型 | 数量 |",
        "|---|---|",
    ]
    for ftype, num in sorted(stats["counts"].items()):
        lines.append(f"| `{ftype}` | {num} |")
    lines += ["", "## 对话", ""]

    for msg in session.get("messages", []):
        role = msg.get("role")
        who = "🧑 用户" if role == "USER" else "🤖 AI"
        frag_count = len(msg.get("fragments", []))
        tokens = msg.get("accumulated_token_usage")
        meta = f"msg {msg.get('id')} · {iso_to_local(msg.get('inserted_at', ''))} · {frag_count} 片段"
        if tokens:
            meta += f" · {tokens} tokens"
        lines += [f"## {who}", f"*{meta}*", ""]

        for frag in msg.get("fragments", []):
            ftype = frag.get("type")

            if ftype in ("REQUEST", "RESPONSE"):
                lines += [frag.get("content", ""), ""]

            elif ftype == "THINK":
                try:
                    elapsed = f"{float(frag.get('elapsed_secs')):.2f}s"
                except (TypeError, ValueError):
                    elapsed = "?"
                lines += [
                    "<details>",
                    f"<summary>🤔 思考链（耗时 {elapsed}）</summary>",
                    "",
                    frag.get("content", ""),
                    "",
                    "</details>",
                    "",
                ]

            elif ftype == "FILE":
                for f in frag.get("files", []) or []:
                    rel = f.get("export_path")
                    name = f.get("file_name", Path(rel or "").name)
                    size = human_size(f.get("file_size"))
                    if not rel:
                        # 非图片附件只保留元数据，原文件不随导出包提供
                        kind = "图片" if f.get("is_image") else "非图片"
                        lines += [f"📎 **附件（导出包未包含原文件）**：`{name}` · {size} · {kind}", ""]
                        continue
                    target = copies.get(rel)
                    if target:
                        if f.get("is_image"):
                            lines += [f"![{name}](attachments/{target})", ""]
                        else:
                            lines += [f"📎 **附件**：[{name}](attachments/{target})（{size}）", ""]
                    else:
                        lines += [f"📎 **附件缺失**：`{name}` → `{rel}`", ""]

            elif ftype == "TOOL_SEARCH":
                results = frag.get("results", []) or []
                lines += [
                    "<details>",
                    f"<summary>🔍 联网搜索（{len(frag.get('queries', []) or [])} 条 query / {len(results)} 条结果）</summary>",
                    "",
                ]
                for q in frag.get("queries", []) or []:
                    lines.append(f"- 查询：`{q}`")
                if frag.get("queries"):
                    lines.append("")
                for r in results:
                    lines.append(f"- [{r.get('title') or '(无标题)'}]({r.get('url', '')}) — {r.get('site_name', '')}")
                lines += ["", "</details>", ""]

            elif ftype == "TOOL_OPEN":
                url = frag.get("url")
                if url:
                    lines += [f"🔗 打开网页：[{frag.get('title') or '(无标题)'}]({url})", ""]
                else:
                    lines += ["🔗 打开网页失败（url 为 null）", ""]

            else:
                content = frag.get("content")
                if isinstance(content, str) and content.strip():
                    lines += [f"_【{ftype}】_ {content}", ""]
                else:
                    lines += [f"```json\n{json.dumps(frag, ensure_ascii=False, indent=2)}\n```", ""]

        lines += ["---", ""]

    return "\n".join(lines)


def export_one(session_path: Path, data_dir: Path, out_dir: Path,
               do_md: bool, do_json: bool) -> dict:
    session = load_json(session_path)
    stats = analyze_session(session, data_dir)
    title = session.get("title", "未命名会话")
    folder = out_dir / f"{session.get('id', '')[:8]}_{safe_name(title, '会话')}"
    if folder.exists():
        folder = out_dir / f"{folder.name}_{datetime.now().strftime('%H%M%S')}"
    folder.mkdir(parents=True, exist_ok=True)

    copies = copy_attachments(session, data_dir, folder / "attachments") if do_md else {}
    if do_md:
        md = render_markdown(
            session, data_dir, stats, copies, now_text(),
            rel_text(data_dir, app_base_dir()),
        )
        (folder / f"{safe_name(title, '会话')}.md").write_text(md, encoding="utf-8")
    if do_json:
        (folder / "session.json").write_text(
            json.dumps(session, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    return {
        "id": session.get("id"),
        "title": title,
        "folder": folder,
        "stats": stats,
    }


def write_summary(data_dir: Path, total_index: int, exported: list,
                  out_dir: Path, format_label: str) -> Path:
    version = manifest_version(data_dir)
    lines = [
        "# 导出汇总",
        "",
        f"- **数据目录**：`{data_dir}`",
        f"- **数据格式版本**：`{version}`（本程序按版本 {SUPPORTED_FORMAT_VERSION} 实现）",
        f"- **索引会话总数**：{total_index}",
        f"- **本次导出**：{len(exported)}",
        f"- **导出格式**：{format_label}",
        f"- **导出时间**：{now_text()}",
        f"- **工具版本**：v{APP_VERSION}",
        "",
        "## 会话清单",
        "",
        "| # | 标题 | 会话 ID | 消息 | 片段 | 附件 | 未打包 | 缺失 | 时间倒挂 | 空网页 |",
        "|---|---|---|---|---|---|---|---|---|---|",
    ]
    for i, item in enumerate(exported, 1):
        s = item["stats"]
        title = str(item["title"]).replace("|", "\\|")
        lines.append(
            f"| {i} | {title} | `{item['id']}` | {s['messages']} | {s['fragments']} | "
            f"{s['attachments']} | {s['not_packaged']} | {s['missing']} | {s['inversions']} | {s['null_opens']} |"
        )
    lines += [
        "",
        "## 自检说明",
        "",
        "- **未打包附件**：`export_path` 为 `null`。实测导出包只携带图片，非图片附件（docx/pdf/txt 等）仅保留文件名、大小等元数据。",
        "- **缺失附件**：`export_path` 有值但文件不存在，属于真正的缺失。",
        "- **时间倒挂**：相邻消息的 `inserted_at` 逆序（样本中常见 4 毫秒），说明不能按时间排序。",
        "- **空网页**：`TOOL_OPEN` 的 `url` 为 `null`，代表一次抓取失败。",
        "- 以上均为结构特征，供人工或大模型核对导出完整性，不代表内容真实性。",
        "",
        f"导出目录：`{out_dir}`",
    ]
    path = out_dir / "_导出汇总.md"
    path.write_text("\n".join(lines), encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# GUI
# ---------------------------------------------------------------------------

class ExportApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.base_dir = app_base_dir()
        self.dataset_map = {}
        self.index = []
        self.index_cache = {}
        self.selected_ids = set()
        self.exporting = False

        self.title(f"DeepSeek 聊天记录导出 v{APP_VERSION}")
        self.geometry("1160x780")
        self.minsize(900, 620)
        self._init_style()
        self._build_ui()
        self._load_datasets()

    def _init_style(self):
        try:
            style = ttk.Style(self)
            if "vista" in style.theme_names():
                style.theme_use("vista")
        except tk.TclError:
            pass
        default_font = ("Microsoft YaHei UI", 10)
        self.option_add("*Font", default_font)
        ttk.Style(self).configure("Treeview", rowheight=28)
        ttk.Style(self).configure("Title.TLabel", font=("Microsoft YaHei UI", 16, "bold"))
        ttk.Style(self).configure("Hint.TLabel", foreground="#7a8394")
        ttk.Style(self).configure("Count.TLabel", foreground="#1f57c3")

    def _build_ui(self):
        pad = {"padx": 16, "pady": 6}

        header = ttk.Frame(self)
        header.pack(fill="x", **pad)
        ttk.Label(header, text="DeepSeek 聊天记录导出", style="Title.TLabel").pack(side="left")
        self.admin_label = ttk.Label(header, text="", style="Hint.TLabel")
        self.admin_label.pack(side="right")

        dataset_row = ttk.Frame(self)
        dataset_row.pack(fill="x", **pad)
        ttk.Label(dataset_row, text="数据目录").pack(side="left")
        self.dataset_combo = ttk.Combobox(dataset_row, state="readonly", width=72)
        self.dataset_combo.pack(side="left", padx=8)
        self.dataset_combo.bind("<<ComboboxSelected>>", self._on_dataset_change)
        ttk.Button(dataset_row, text="浏览…", command=self._browse_dataset).pack(side="left")
        self.dataset_info = ttk.Label(dataset_row, text="", style="Hint.TLabel")
        self.dataset_info.pack(side="left", padx=12)

        search_row = ttk.Frame(self)
        search_row.pack(fill="x", **pad)
        ttk.Label(search_row, text="关键词").pack(side="left")
        self.search_var = tk.StringVar()
        self.search_entry = ttk.Entry(search_row, textvariable=self.search_var, font=("Microsoft YaHei UI", 11))
        self.search_entry.pack(side="left", fill="x", expand=True, padx=8)
        self.search_entry.bind("<Return>", lambda _e: self._do_search())
        self.search_btn = ttk.Button(search_row, text="⏎ 搜索", command=self._do_search)
        self.search_btn.pack(side="left")

        list_frame = ttk.Frame(self)
        list_frame.pack(fill="both", expand=True, padx=16, pady=(6, 0))
        columns = ("title", "messages", "updated")
        self.tree = ttk.Treeview(list_frame, columns=columns, show="headings", selectmode="extended")
        self.tree.heading("title", text="会话标题")
        self.tree.heading("messages", text="消息数")
        self.tree.heading("updated", text="最后更新")
        self.tree.column("title", width=720, stretch=True)
        self.tree.column("messages", width=90, anchor="center", stretch=False)
        self.tree.column("updated", width=180, anchor="center", stretch=False)
        vsb = ttk.Scrollbar(list_frame, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=vsb.set)
        self.tree.pack(side="left", fill="both", expand=True)
        vsb.pack(side="right", fill="y")
        self.tree.bind("<<TreeviewSelect>>", self._on_select)

        hint = ttk.Label(self, text="单击 = 预选　·　按住 Ctrl 再单击 = 多选　·　可跨关键词保留已选项",
                         style="Hint.TLabel")
        hint.pack(fill="x", padx=16, pady=(4, 0))

        action = ttk.Frame(self)
        action.pack(fill="x", padx=16, pady=(6, 4))
        self.count_label = ttk.Label(action, text="已选 0 个", style="Count.TLabel")
        self.count_label.pack(side="left")
        self.confirm_btn = ttk.Button(action, text="确定", command=self._on_confirm)
        self.confirm_btn.pack(side="right", padx=(8, 0))
        self.format_combo = ttk.Combobox(action, state="readonly", values=FORMAT_OPTIONS, width=22)
        self.format_combo.current(0)
        self.format_combo.pack(side="right")

        status = ttk.Frame(self)
        status.pack(fill="x", padx=16, pady=(0, 10))
        self.status_label = ttk.Label(status, text="就绪", style="Hint.TLabel")
        self.status_label.pack(side="left")
        self.progress = ttk.Progressbar(status, mode="determinate")
        self.progress.pack(side="right", fill="x", expand=True, padx=(12, 0))

    # ---- 数据集 ----
    def _load_datasets(self):
        dirs = find_data_dirs(self.base_dir)
        self.dataset_map = {}
        for d in dirs:
            count = len(self._cached_index(d))
            label = f"{rel_text(d, self.base_dir)}  ( {count} 会话 )"
            self.dataset_map[label] = d
        if not self.dataset_map:
            self.dataset_combo["values"] = []
            self.dataset_info.config(text="未找到导出包，请点“浏览…”")
            self._update_admin_label()
            return
        values = list(self.dataset_map)
        self.dataset_combo["values"] = values
        self.dataset_combo.current(0)
        self._update_admin_label()
        self._on_dataset_change()

    def _cached_index(self, path: Path) -> list:
        if path not in self.index_cache:
            self.index_cache[path] = load_index(path)
        return self.index_cache[path]

    def _current_dataset(self):
        label = self.dataset_combo.get()
        return self.dataset_map.get(label)

    def _on_dataset_change(self, _event=None):
        data_dir = self._current_dataset()
        if not data_dir:
            return
        self.index = self._cached_index(data_dir)
        self.dataset_info.config(text=f"共 {len(self.index)} 个会话")
        version = manifest_version(data_dir)
        if version != SUPPORTED_FORMAT_VERSION:
            self.status_label.config(text=f"警告：数据格式版本为 {version}，本程序按版本 3 实现")
        self.selected_ids.clear()
        self._do_search()

    def _browse_dataset(self):
        chosen = filedialog.askdirectory(title="选择解压后的 deepseek_data 目录", initialdir=str(self.base_dir))
        if not chosen:
            return
        path = Path(chosen)
        if not (path / "chat_session_index.json").exists():
            messagebox.showwarning("目录不匹配", "该目录下没有 chat_session_index.json，请选择解压后的根目录。")
            return
        label = f"{rel_text(path, self.base_dir)}  ( {len(self._cached_index(path))} 会话 )"
        self.dataset_map[label] = path
        self.dataset_combo["values"] = list(self.dataset_map)
        self.dataset_combo.set(label)
        self._on_dataset_change()

    # ---- 搜索与选择 ----
    def _do_search(self):
        if self.exporting:
            return
        keyword = self.search_var.get().strip().lower()
        self.tree.delete(*self.tree.get_children())
        shown = 0
        for entry in self.index:
            title = str(entry.get("title", ""))
            if keyword and keyword not in title.lower():
                continue
            iid = str(entry.get("id"))
            self.tree.insert("", "end", iid=iid, values=(
                title,
                entry.get("message_count", "?"),
                iso_to_local(entry.get("updated_at", "")),
            ))
            shown += 1
        visible = [iid for iid in self.selected_ids if self.tree.exists(iid)]
        if visible:
            self.tree.selection_set(visible)
        self.status_label.config(text=f"关键词“{keyword or '（全部）'}”命中 {shown} 个会话")
        self._update_count()

    def _on_select(self, _event=None):
        self.selected_ids = set(self.tree.selection())
        self._update_count()

    def _update_count(self):
        self.count_label.config(text=f"已选 {len(self.selected_ids)} 个")

    # ---- 导出 ----
    def _on_confirm(self):
        if self.exporting:
            return
        selected = list(self.tree.selection())
        if not selected:
            messagebox.showinfo("尚未选择", "请先在列表中单击预选，按住 Ctrl 再单击可多选。")
            return
        data_dir = self._current_dataset()
        if not data_dir:
            messagebox.showwarning("缺少数据目录", "请先选择导出包目录。")
            return
        format_label = self.format_combo.get()
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        out_dir = self.base_dir / f"导出结果_{stamp}"
        try:
            out_dir.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            messagebox.showerror("无法创建目录", f"{out_dir}\n{exc}")
            return

        self.exporting = True
        self.confirm_btn.config(state="disabled")
        self.search_btn.config(state="disabled")
        self.search_entry.config(state="disabled")
        self.progress.config(maximum=len(selected), value=0)
        self.status_label.config(text=f"准备导出 {len(selected)} 个会话…")

        threading.Thread(
            target=self._export_worker,
            args=(selected, data_dir, out_dir, format_label),
            daemon=True,
        ).start()

    def _export_worker(self, selected, data_dir, out_dir, format_label):
        do_md = format_label != "仅 JSON"
        do_json = format_label != "Markdown（推荐）"
        exported = []
        errors = []
        sessions_dir = data_dir / "chat_sessions"

        for i, session_id in enumerate(selected, 1):
            path = sessions_dir / f"{session_id}.json"
            self.after(0, lambda i=i, sid=session_id: self.status_label.config(
                text=f"正在导出 {i}/{len(selected)}：{sid[:8]}"))
            try:
                if not path.exists():
                    errors.append(f"{session_id}：找不到 {path.name}")
                else:
                    exported.append(export_one(path, data_dir, out_dir, do_md, do_json))
            except Exception as exc:  # 单个会话失败不中断整体
                errors.append(f"{session_id}：{exc}")
            self.after(0, lambda i=i: self.progress.config(value=i))

        summary_path = None
        try:
            summary_path = write_summary(data_dir, len(self.index), exported, out_dir, format_label)
        except Exception as exc:
            errors.append(f"汇总写入失败：{exc}")

        self.after(0, self._export_done, out_dir, exported, errors, summary_path)

    def _export_done(self, out_dir, exported, errors, summary_path):
        self.exporting = False
        self.confirm_btn.config(state="normal")
        self.search_btn.config(state="normal")
        self.search_entry.config(state="normal")
        self.status_label.config(text=f"完成：成功 {len(exported)} 个，失败 {len(errors)} 个")
        message = f"已导出 {len(exported)} 个会话\n目录：{out_dir}"
        if summary_path:
            message += f"\n汇总：{summary_path.name}"
        if errors:
            message += "\n\n失败项：\n" + "\n".join(errors[:8])
        messagebox.showinfo("导出完成", message)
        try:
            os.startfile(out_dir)
        except OSError:
            pass

    # ---- 其他 ----
    def _update_admin_label(self):
        try:
            is_admin = bool(ctypes.windll.shell32.IsUserAnAdmin())
        except Exception:
            is_admin = False
        if is_admin:
            self.admin_label.config(text="管理员模式", foreground="#1f8a5b")
        else:
            self.admin_label.config(text="普通权限（建议右键以管理员身份运行）", foreground="#c2410c")


def enable_dpi_awareness():
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(1)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# 自检模式（开发用，不打开 GUI）
# ---------------------------------------------------------------------------

def selftest(data_dir: Path, keyword: str):
    index = load_index(data_dir)
    matched = [e for e in index if keyword.lower() in str(e.get("title", "")).lower()]
    out_dir = app_base_dir() / f"_自检导出_{datetime.now().strftime('%H%M%S')}"
    out_dir.mkdir(parents=True, exist_ok=True)
    exported = []
    for entry in matched:
        sid = entry.get("id")
        path = data_dir / "chat_sessions" / f"{sid}.json"
        if path.exists():
            exported.append(export_one(path, data_dir, out_dir, True, True))
    write_summary(data_dir, len(index), exported, out_dir, "Markdown + JSON")
    print(f"data_dir={data_dir}")
    print(f"total={len(index)} matched={len(matched)} exported={len(exported)}")
    print(f"out={out_dir}")


def main():
    if "--selftest" in sys.argv:
        args = [a for a in sys.argv[1:] if not a.startswith("--")]
        if len(args) >= 2:
            selftest(Path(args[0]), args[1])
            return
    enable_dpi_awareness()
    app = ExportApp()
    app.mainloop()


if __name__ == "__main__":
    main()
