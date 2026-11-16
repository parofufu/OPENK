#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
DeepSeek 聊天记录导出 · 大模型/命令行版（无界面，跨平台，仅标准库）

用途
----
与图形版功能等效：扫描导出包、按标题关键词检索、导出 Markdown + 附件（可选 JSON），
并生成一份带结构自检指标的《_导出汇总.md》。适合没有图形环境、或由大模型代为操作的场景。

不依赖 tkinter，也不使用任何 Windows 专有组件或驱动库；Windows / Linux / macOS 均可运行。

大模型操作提示（可直接复制给模型）
----------------------------------
1. 先运行：python DeepSeek聊天记录导出_大模型版.py --scan
   得到所有可用数据目录；若有多个，选择“索引会话数”最大的，或按用户指定。
2. 再运行：--data-dir "<目录>" --keyword "关键词" --list
   确认命中数量与完整标题；需要精确选择时改用 --id "<会话ID>"（可重复）。
3. 最后运行：--export --keyword "关键词" --format md
   需要限定输出位置时加 --output "<目录>"；需要机器可读结果时加 --json。
4. 不要猜测会话 ID；以 --list 或 --scan 的输出为准。
5. 若结果为“未打包附件”，说明原文件不随导出包提供（DeepSeek 只打包图片），不要重复尝试。

常用命令
--------
  python <本文件> --scan
  python <本文件> --keyword "哲学" --list
  python <本文件> --keyword "哲学" --export
  python <本文件> --id "<会话ID>" --export --format md+json --output ./导出结果
  python <本文件> --prompt

导出格式
--------
  md        Markdown + attachments（默认，推荐）
  md+json   Markdown + 原始 session.json
  json      仅 session.json

退出码：0 成功；2 参数或数据错误。
"""

import argparse
import json
import os
import shutil
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path

APP_VERSION = "1.0"
SUPPORTED_FORMAT_VERSION = 3
SKIP_DIRS = {".git", "__pycache__", "build", "dist", ".screenshots", "配图", "exported", "attachments"}
FORMAT_LABELS = {
    "md": "Markdown（推荐）",
    "md+json": "Markdown + JSON",
    "json": "仅 JSON",
}

PROMPT_TEXT = """你是本机上的导出助手，负责把 DeepSeek 导出包转成可读文档。

可用命令（在脚本所在目录执行）：
  python {script} --scan
      列出同级目录下所有可用数据目录及会话数。

  python {script} --keyword "关键词" --list
      按会话标题模糊匹配，输出命中会话的完整标题、ID、消息数与更新时间。

  python {script} --keyword "关键词" --export --format md
      导出全部命中会话；只想导出部分，请先 --list 再用 --id 精确指定。

规则：
1. 只用 --scan/--list 的真实输出决定目录与 ID，不要猜测。
2. 关键词匹配的是会话“标题”，不是正文。
3. 导出结果为 Markdown + attachments（可选 session.json），并在输出目录生成 _导出汇总.md。
4. 汇总与正文中的“未打包附件”表示原文件不在导出包内（通常是非图片附件），
   不是程序错误，不要重复重试或声称已恢复。
5. 需要结构化结果给上游程序时，追加 --json。
"""


# ---------------------------------------------------------------------------
# 基础工具
# ---------------------------------------------------------------------------

def script_dir() -> Path:
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
# 数据发现
# ---------------------------------------------------------------------------

def find_data_dirs(base: Path) -> list:
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
                elif not (data_dir / f["export_path"]).exists():
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
# 渲染与导出（与图形版输出保持一致）
# ---------------------------------------------------------------------------

def copy_attachments(session: dict, data_dir: Path, attach_dir: Path) -> dict:
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
            session, data_dir, stats, copies, now_text(), rel_text(data_dir, script_dir())
        )
        (folder / f"{safe_name(title, '会话')}.md").write_text(md, encoding="utf-8")
    if do_json:
        (folder / "session.json").write_text(
            json.dumps(session, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    return {"id": session.get("id"), "title": title, "folder": folder, "stats": stats}


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
# 命令行
# ---------------------------------------------------------------------------

def resolve_dataset(cli_dir: str, base: Path) -> Path:
    if cli_dir:
        path = Path(cli_dir).expanduser().resolve()
        if not (path / "chat_session_index.json").exists():
            raise SystemExit(f"目录中没有 chat_session_index.json：{path}")
        return path
    dirs = find_data_dirs(base)
    if not dirs:
        raise SystemExit(f"在 {base} 及其子目录（3 层内）没有找到导出包，请用 --data-dir 指定。")
    return dirs[0]


def select_sessions(index: list, keywords: list, ids: list, all_flag: bool) -> list:
    if ids:
        wanted = {x.strip() for x in ids}
        known = {str(e.get("id")) for e in index}
        unknown = wanted - known
        if unknown:
            raise SystemExit("索引中不存在的会话 ID：" + ", ".join(sorted(unknown)))
        return [e for e in index if str(e.get("id")) in wanted]
    if keywords:
        lowered = [k.lower() for k in keywords]
        return [e for e in index if any(k in str(e.get("title", "")).lower() for k in lowered)]
    if all_flag:
        return list(index)
    return []


def print_scan(dirs: list, as_json: bool):
    rows = []
    for d in dirs:
        count = len(load_index(d))
        rows.append({"path": str(d), "sessions": count, "version": manifest_version(d)})
    if as_json:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
        return
    print(f"找到 {len(rows)} 个数据目录：")
    for r in rows:
        print(f"  - {r['path']}")
        print(f"      会话 {r['sessions']} · 格式版本 {r['version']}")


def print_list(items: list, as_json: bool):
    if as_json:
        payload = [{
            "id": e.get("id"),
            "title": e.get("title"),
            "message_count": e.get("message_count"),
            "updated_at": e.get("updated_at"),
        } for e in items]
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return
    print(f"命中 {len(items)} 个会话：")
    for i, e in enumerate(items, 1):
        print(f"  {i:3d}. {e.get('title')}")
        print(f"       {e.get('id')}  ·  {e.get('message_count')} 条消息  ·  {iso_to_local(e.get('updated_at', ''))}")


def main():
    parser = argparse.ArgumentParser(
        description="DeepSeek 聊天记录导出（无界面、跨平台、仅标准库）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=PROMPT_TEXT.format(script=Path(__file__).name),
    )
    parser.add_argument("--data-dir", help="解压后的 deepseek_data 目录；省略则自动扫描同级目录")
    parser.add_argument("--scan", action="store_true", help="列出所有可用数据目录")
    parser.add_argument("--list", action="store_true", help="按关键词列出命中的会话，不导出")
    parser.add_argument("--export", action="store_true", help="执行导出")
    parser.add_argument("--keyword", action="append", default=[], help="标题关键词（可重复）")
    parser.add_argument("--id", action="append", default=[], help="按会话 ID 精确导出（可重复）")
    parser.add_argument("--all", action="store_true", help="不做关键词过滤，导出全部会话（谨慎）")
    parser.add_argument("--format", default="md", choices=list(FORMAT_LABELS), help="md / md+json / json")
    parser.add_argument("--output", help="输出目录；默认在脚本同级创建 导出结果_时间戳")
    parser.add_argument("--limit", type=int, help="最多导出多少条（用于抽样）")
    parser.add_argument("--json", action="store_true", help="以 JSON 输出结果，便于程序调用")
    parser.add_argument("--prompt", action="store_true", help="打印给大模型看的操作提示")
    args = parser.parse_args()

    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        except (OSError, ValueError):
            pass

    if args.prompt:
        print(PROMPT_TEXT.format(script=Path(__file__).name))
        return

    base = script_dir()
    dirs = find_data_dirs(base)

    if args.scan:
        print_scan(dirs, args.json)
        return

    if not any([args.list, args.export, args.keyword, args.id, args.all]):
        print(PROMPT_TEXT.format(script=Path(__file__).name))
        print("---")
        print_scan(dirs, as_json=False)
        return

    data_dir = resolve_dataset(args.data_dir, base)
    version = manifest_version(data_dir)
    index = load_index(data_dir)
    items = select_sessions(index, args.keyword, args.id, args.all)

    if not items:
        raise SystemExit("没有匹配的会话：请用 --keyword 或 --id 指定（可先用 --scan / --list 查看）。")

    if args.limit:
        items = items[: args.limit]

    if args.list:
        print_list(items, args.json)
        return

    if not args.export:
        print_list(items, args.json)
        print("\n以上为匹配结果。确认无误后，把 --list 改为 --export 即可导出。")
        return

    out_dir = Path(args.output).expanduser().resolve() if args.output else \
        base / f"导出结果_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
    out_dir.mkdir(parents=True, exist_ok=True)

    label = FORMAT_LABELS[args.format]
    do_md = args.format != "json"
    do_json = args.format != "md"
    exported, errors = [], []
    sessions_dir = data_dir / "chat_sessions"
    progress = (lambda *a, **k: print(*a, file=sys.stderr, **k)) if args.json else print

    progress(f"数据目录：{data_dir}")
    progress(f"格式版本：{version}（本程序按版本 {SUPPORTED_FORMAT_VERSION} 实现）")
    progress(f"命中会话：{len(items)}")
    progress(f"导出格式：{label}")
    progress(f"输出目录：{out_dir}")

    for i, entry in enumerate(items, 1):
        sid = str(entry.get("id"))
        path = sessions_dir / f"{sid}.json"
        progress(f"  [{i}/{len(items)}] {entry.get('title')} ...", end="", flush=True)
        if not path.exists():
            progress(" 找不到会话文件，已跳过")
            errors.append({"id": sid, "reason": "session file missing"})
            continue
        try:
            exported.append(export_one(path, data_dir, out_dir, do_md, do_json))
            progress(" 完成")
        except Exception as exc:
            progress(f" 失败：{exc}")
            errors.append({"id": sid, "reason": str(exc)})

    summary_path = write_summary(data_dir, len(index), exported, out_dir, label)

    report = {
        "data_dir": str(data_dir),
        "out_dir": str(out_dir),
        "format": label,
        "matched": len(items),
        "exported": [
            {"id": e["id"], "title": e["title"], "folder": str(e["folder"]), "stats": e["stats"]}
            for e in exported
        ],
        "errors": errors,
        "summary": str(summary_path),
    }

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(f"\n完成：成功 {len(exported)}，失败 {len(errors)}")
        print(f"汇总：{summary_path}")


if __name__ == "__main__":
    main()
