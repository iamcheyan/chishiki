#!/usr/bin/env env python3
# -*- coding: utf-8 -*-
"""chishiki v2 markdown 渲染器 — 零依赖, 覆盖 GFM 子集 + Docsify 旧语法兼容
目标: docs/ 里已有的 Docsify 文档原样可读(降级不报错)。
"""
import re

_RESC = None  # legacy placeholder


_SAFE_PROTO = ("http://", "https://", "mailto:", "#", "/")


def safe_url(u: str) -> str:
    """链接/图片协议白名单: 拒绝 javascript:/data:/vbscript: 等"""
    u = (u or "").strip()
    low = u.lower().replace("\t", "").replace("\n", "").replace("\r", "").replace(" ", "")
    if low.startswith(("javascript:", "data:", "vbscript:", "file:", "blob:")):
        return "#"
    if u.startswith(_SAFE_PROTO) or not re.match(r"^[a-z][a-z0-9+.-]*:", low):
        return u
    return "#"


_HTML_DENY = re.compile(
    r"<\s*/?\s*(script|iframe|object|embed|style|form|input|button|textarea|select|option|meta|link|base|svg|math)\b",
    re.I)


def _strip_dangerous_html(text: str) -> str:
    """块级 raw HTML 白名单过滤: 移除可执行/可交互标签(整对连内容)"""
    out = re.sub(
        r"<\s*(script|iframe|object|embed|style|form|svg|math)\b[^>]*>.*?<\s*/\s*\1\s*>",
        "", text, flags=re.I | re.S)
    out = _HTML_DENY.sub("<", out)          # 残余开/闭标签降级为文本
    return out


def esc(s: str) -> str:
    return esc_text(s)


def esc_text(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def esc_attr(s: str) -> str:
    return esc_text(s).replace('"', "&quot;")


_SLUG_CACHE: dict = {}


def slugify(text: str) -> str:
    s = _SLUG_CACHE.get(text)
    if s is None:
        s = re.sub(r"[^\w\s\-一-龥ぁ-んァ-ヶ]", "", text, flags=re.UNICODE).strip().lower()
        s = re.sub(r"\s+", "-", s) or "section"
        _SLUG_CACHE[text] = s
    return s


def _table_row(line: str) -> list:
    # strip leading/trailing pipe, split
    cells = line.strip().strip("|").split("|")
    return [c.strip() for c in cells]


def _is_table_sep(line: str) -> bool:
    return bool(re.match(r"^\s*\|?[\s:|-]+\|[\s:|-]*$", line)) and "-" in line


def render(md: str, doc_path: str = "") -> str:
    """md → HTML。doc_path 用于图片相对路径重写(前端再统一处理 /files 前缀)。"""
    lines = md.split("\n")
    out: list = []
    i = 0
    n = len(lines)
    in_list = None  # 'ul' | 'ol'
    in_quote = False
    # 任务列表连续性追踪
    task_open = False

    def close_list():
        nonlocal in_list, task_open
        if task_open:
            out.append("</ul>")
            task_open = False
        if in_list:
            out.append(f"</{in_list}>")
            in_list = None

    def close_quote():
        nonlocal in_quote
        if in_quote:
            out.append("</blockquote>")
            in_quote = False

    while i < n:
        line = lines[i]

        # --- 代码块 ``` / ~~~
        m = re.match(r"^(\s*)(```|~~~)\s*(\S*)", line)
        if m:
            close_list(); close_quote()
            fence = m.group(2)
            lang = m.group(3)
            code_lines = []
            i += 1
            while i < n and not re.match(r"^\s*" + fence, lines[i]):
                code_lines.append(lines[i])
                i += 1
            i += 1  # skip closing fence
            cls = f' class="lang-{esc_attr(lang)}"' if lang else ""
            out.append(f"<pre{cls}><code>{esc_text(chr(10).join(code_lines))}</code></pre>")
            continue

        # --- Docsify 提示容器 !> (important) --> blockquote.warning 降级
        if re.match(r"^\s*!>\s*", line):
            close_list(); close_quote()
            content = re.sub(r"^\s*!>\s?", "", line)
            buf = [content]
            i += 1
            while i < n and re.match(r"^\s*!>\s*", lines[i]):
                buf.append(re.sub(r"^\s*!>\s?", "", lines[i]))
                i += 1
            out.append(f'<blockquote class="callout callout-warn">{inline(chr(10).join(buf))}</blockquote>')
            continue
        # --- Docsify ?--> tip 降级
        if re.match(r"^\s*\?>\s*", line):
            close_list(); close_quote()
            content = re.sub(r"^\s*\?>\s?", "", line)
            buf = [content]
            i += 1
            while i < n and re.match(r"^\s*\?>\s*", lines[i]):
                buf.append(re.sub(r"^\s*\?>\s?", "", lines[i]))
                i += 1
            out.append(f'<blockquote class="callout callout-tip">{inline(chr(10).join(buf))}</blockquote>')
            continue

        # --- HTML 直通(单行块级) — Docsify 文档常见 <p align> 等, 保留原文
        if re.match(r"^\s*<[a-zA-Z][^>]*>", line) and not re.match(r"^\s*<(code|pre|span|b|i|em|strong|a|img)\b", line):
            close_list(); close_quote()
            html_lines = [line]
            tag_m = re.match(r"^\s*<([a-zA-Z][a-zA-Z0-9]*)", line)
            tag = tag_m.group(1) if tag_m else "div"
            if not re.search(f"</{tag}>", line):
                i += 1
                while i < n and not re.search(f"</{tag}>", lines[i]):
                    html_lines.append(lines[i])
                    i += 1
                if i < n:
                    html_lines.append(lines[i])
            i += 1
            out.append(_strip_dangerous_html(chr(10).join(html_lines)))
            continue

        # --- 标题
        m = re.match(r"^(#{1,6})\s+(.*?)\s*#*\s*$", line)
        if m:
            close_list(); close_quote()
            lvl = len(m.group(1))
            txt = m.group(2)
            sid = slugify(inline_plain(txt))
            out.append(f'<h{lvl} id="{esc_attr(sid)}">{inline(txt)}</h{lvl}>')
            i += 1
            continue

        # --- 分隔线
        if re.match(r"^\s*([-*_])\s*(\1\s*){2,}$", line):
            close_list(); close_quote()
            out.append("<hr>")
            i += 1
            continue

        # --- 表格
        if "|" in line and i + 1 < n and _is_table_sep(lines[i + 1]):
            close_list(); close_quote()
            head = _table_row(line)
            aligns = []
            for c in _table_row(lines[i + 1]):
                if c.startswith(":") and c.endswith(":"):
                    aligns.append("center")
                elif c.endswith(":"):
                    aligns.append("right")
                else:
                    aligns.append("left")
            i += 2
            body = []
            while i < n and "|" in lines[i] and lines[i].strip():
                body.append(_table_row(lines[i]))
                i += 1
            thead = "".join(f'<th style="text-align:{a}">{inline(c)}</th>' for c, a in zip(head, aligns))
            rows = "".join("<tr>" + "".join(f'<td style="text-align:{a}">{inline(c)}</td>' for c, a in zip(r, aligns)) + "</tr>" for r in body)
            out.append(f"<table><thead><tr>{thead}</tr></thead><tbody>{rows}</tbody></table>")
            continue

        # --- 引用块
        if re.match(r"^\s*>", line):
            if not in_quote:
                close_list()
                out.append("<blockquote>")
                in_quote = True
            out.append(inline(re.sub(r"^\s*>\s?", "", line)))
            i += 1
            continue
        close_quote()

        # --- 任务列表
        m = re.match(r"^\s*[-*]\s+\[( |x|X)\]\s+(.*)$", line)
        if m:
            if not task_open:
                close_list()
                out.append('<ul class="task-list">')
                task_open = True
            checked = " checked" if m.group(1).lower() == "x" else ""
            out.append(f'<li class="task-item"><span class="task-box{" on" if "checked" in checked else ""}" role="checkbox" aria-checked="{"true" if "checked" in checked else "false"}" aria-disabled="true"></span><span class="task-txt">{inline(m.group(2))}</span></li>')
            i += 1
            continue
        if task_open:
            out.append("</ul>")
            task_open = False

        # --- 无序/有序列表
        m = re.match(r"^(\s*)([-*+])\s+(.*)$", line)
        m2 = re.match(r"^(\s*)(\d+)[.)]\s+(.*)$", line)
        if m or m2:
            want = "ul" if m else "ol"
            if in_list != want:
                close_list()
                out.append(f"<{want}>")
                in_list = want
            content = (m or m2).group(3) if m else m2.group(3)
            # 嵌套简化: 两个空格以上缩进视为同级内容并入(避免复杂栈)
            out.append(f"<li>{inline(content)}</li>")
            i += 1
            continue
        close_list()

        # --- 空行
        if not line.strip():
            i += 1
            continue

        # --- 普通段落(合并到空行/块级为止)
        para = [line]
        i += 1
        while i < n and lines[i].strip() and not re.match(r"^(#{1,6}\s|>|\s*[-*+]\s|\s*\d+[.)]\s|\s*```|\s*~~~|\|.*\|\s*$|<hr|!\[|\?>|!>)", lines[i]):
            para.append(lines[i])
            i += 1
        out.append(f"<p>{inline(chr(10).join(para))}</p>")

    close_list(); close_quote()
    return "".join(out)


# ---------------- 行内 ----------------

def inline_plain(s: str) -> str:
    """标题 slug 用: 去行内标记。"""
    s = re.sub(r"`([^`]*)`", r"\1", s)
    s = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", s)
    s = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", s)
    s = re.sub(r"[*_~]+", "", s)
    return s.strip()


def inline(s: str) -> str:
    # 代码优先
    parts = re.split(r"(`[^`]*`)", s)
    out = []
    for p in parts:
        if p.startswith("`") and p.endswith("`") and len(p) > 1:
            out.append(f"<code>{esc_text(p[1:-1])}</code>")
        else:
            out.append(_inline_nocode(p))
    return "".join(out)


_PLACE = {i: ch for i, ch in enumerate("\x00\x01\x02\x03\x04\x05\x06\x07\x08")}


def _inline_nocode(s: str) -> str:
    """顺序安全: 先占位符保护用户文本(转义后), 再插入我们生成的标签。"""
    # 1) 提取图片/链接/URL → 占位符
    slots: list = []

    def stash(html: str) -> str:
        slots.append(html)
        return f"\x00{len(slots) - 1}\x00"

    def img_repl(m):
        alt = esc_attr(m.group(1))
        src = m.group(2)
        title = ""
        t = m.group(3)
        if t:
            title = f' title="{esc_attr(t)}"'
        return stash(f'<img src="{esc_attr(safe_url(src))}" alt="{alt}"{title} class="md-img" loading="lazy">')

    s = re.sub(r"!\[([^\]]*)\]\(([^)\s]+)(?:\s+\"([^\"]*)\")?\)", img_repl, s)

    def a_repl(m):
        txt = m.group(1)
        href = m.group(2)
        if re.match(r"^(\^|#)", href):
            return stash(f'<a href="{esc_attr(safe_url(href))}">{txt}</a>')
        ext = ' target="_blank" rel="noopener"' if re.match(r"^[a-z]+://", href) else ""
        return stash(f'<a href="{esc_attr(safe_url(href))}"{ext}>{txt}</a>')

    s = re.sub(r"\[([^\]]+)\]\(([^)\s]+)\)", a_repl, s)

    def url_repl(m):
        u = m.group(1)
        return stash(f'<a href="{esc_attr(u)}" target="_blank" rel="noopener">{esc_text(u)}</a>')

    s = re.sub(r"(?<![\"'>=\(\[])(https?://[^\s<)\]]+)", url_repl, s)

    # 2) 剩余纯文本先转义
    s = esc_text(s)

    # 3) 行内标记(在已转义文本上; 标记字符 * _ ~ 未被转义影响)
    s = re.sub(r"\*\*\*([^*]+)\*\*\*", r"<strong><em>\1</em></strong>", s)
    s = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"(?<!\w)\*([^*\n]+)\*(?!\w)", r"<em>\1</em>", s)
    s = re.sub(r"___([^_]+)___", r"<strong><em>\1</em></strong>", s)
    s = re.sub(r"__([^_]+)__", r"<strong>\1</strong>", s)
    s = re.sub(r"(?<!\w)_([^_\n]+)_(?!\w)", r"<em>\1</em>", s)
    s = re.sub(r"~~([^~]+)~~", r"<del>\1</del>", s)

    # 4) 还原占位符
    def unstash(m):
        return slots[int(m.group(1))]

    return re.sub(r"\x00(\d+)\x00", unstash, s)
