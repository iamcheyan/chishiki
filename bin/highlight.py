"""轻量语法高亮 tokenizer — 零依赖, 服务端预高亮(与主题解耦, 颜色由 CSS token 决定)
覆盖: python/js/ts/bash/json/yaml/sql/html/xml/css/ini/toml + 无语言纯文本只做链接/数字可选
输出: <span class="tk-xxx"> 包裹的已转义 HTML
"""
import re

_TK = {
    "py": "python", "python": "python", "py3": "python",
    "js": "js", "javascript": "js", "mjs": "js", "jsx": "js",
    "ts": "js", "typescript": "js", "tsx": "js",
    "bash": "sh", "sh": "sh", "shell": "sh", "zsh": "sh", "console": "sh",
    "json": "json",
    "yaml": "yaml", "yml": "yaml",
    "sql": "sql",
    "html": "html", "xml": "html", "svg": "html",
    "css": "css",
    "ini": "ini", "toml": "ini", "conf": "ini", "cfg": "ini",
}

_KW = {
    "python": {"def","class","return","if","elif","else","for","while","try","except","finally",
               "with","as","import","from","pass","break","continue","lambda","yield","global",
               "nonlocal","assert","raise","del","in","is","not","and","or","None","True","False",
               "async","await","self","match","case"},
    "js": {"function","return","if","else","for","while","do","switch","case","default","break",
           "continue","new","delete","typeof","instanceof","in","of","var","let","const","class",
           "extends","super","this","import","from","export","default","try","catch","finally",
           "throw","yield","async","await","static","get","set","null","undefined","true","false","void"},
    "sh": {"if","then","else","elif","fi","for","while","do","done","case","esac","function",
           "in","select","until","return","break","continue","local","export","readonly","declare",
           "set","unset","shift","exit","trap","source","alias"},
    "sql": {"SELECT","FROM","WHERE","INSERT","INTO","VALUES","UPDATE","SET","DELETE","CREATE",
            "TABLE","ALTER","DROP","INDEX","VIEW","JOIN","LEFT","RIGHT","INNER","OUTER","ON",
            "AS","AND","OR","NOT","NULL","IS","IN","LIKE","BETWEEN","ORDER","BY","GROUP","LIMIT",
            "OFFSET","UNION","ALL","DISTINCT","COUNT","SUM","AVG","MIN","MAX","PRIMARY","KEY",
            "FOREIGN","REFERENCES","DEFAULT","CASCADE","EXISTS","CASE","WHEN","THEN","END"},
    "json": {"true","false","null"},
    "yaml": {"true","false","null","yes","no","on","off"},
    "css": set(),
    "html": set(),
    "ini": set(),
}

# 通用 token 正则(顺序重要: 注释→字符串→数字→关键词/标识符→标点)
def _tokens_for_lang(lang):
    if lang in ("python",):
        return [
            ("tk-com", re.compile(r"#[^\n]*")),
            ("tk-str", re.compile(r"(?:[fFrRbB]{0,2})(\"\"\"[\s\S]*?\"\"\"|'''[\s\S]*?'''|\"[^\n\"\\\\]*\"|'[^ \n'\\\\]*')")),
            ("tk-dec", re.compile(r"@\w+")),
            ("tk-num", re.compile(r"\b\d+(?:\.\d+)?\b")),
        ]
    if lang in ("js",):
        return [
            ("tk-com", re.compile(r"//[^\n]*|/\*[\s\S]*?\*/")),
            ("tk-str", re.compile(r"(?:`[^`]*`|\"[^\"\n]*\"|'[^'\n]*')")),
            ("tk-num", re.compile(r"\b\d+(?:\.\d+)?\b")),
            ("tk-kwd", re.compile(r"\b(?:const|let|var|function|return|if|else|for|while|class|extends|new|import|export|from|default|async|await|try|catch|throw|typeof|instanceof|delete|void|yield|static|super|this)\b")),
        ]
    if lang == "sh":
        return [
            ("tk-com", re.compile(r"#[^\n]*")),
            ("tk-str", re.compile(r"(?:\"[^\"\n]*\"|'[^'\n]*')")),
            ("tk-num", re.compile(r"\$\w+|\$\{[^}]*\}")),   # 变量用 num 色系
            ("tk-kwd", re.compile(r"^\s*(?:if|then|else|elif|fi|for|while|do|done|case|esac|function|return|local|export|source|set)\b", re.M)),
        ]
    if lang == "json":
        return [
            ("tk-key", re.compile(r"\"[^\"\n]*\"(?=\s*:)")),
            ("tk-str", re.compile(r"\"[^\"\n]*\"")),
            ("tk-num", re.compile(r"\b-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?\b|\\b(?:true|false|null)\\b")),
        ]
    if lang == "yaml":
        return [
            ("tk-com", re.compile(r"#[^\n]*")),
            ("tk-key", re.compile(r"^\s*[\w.-]+(?=\s*:)", re.M)),
            ("tk-num", re.compile(r"\b\d+(?:\.\d+)?\b")),
        ]
    if lang == "sql":
        return [
            ("tk-com", re.compile(r"--[^\n]*|/\*[\s\S]*?\*/")),
            ("tk-str", re.compile(r"'[^'\n]*'")),
            ("tk-num", re.compile(r"\b\d+(?:\.\d+)?\b")),
        ]
    if lang == "css":
        return [
            ("tk-com", re.compile(r"/\*[\s\S]*?\*/")),
            ("tk-str", re.compile(r"(?:\"[^\"\n]*\"|'[^'\n]*')")),
            ("tk-kwd", re.compile(r"[.#][\w-]+|@[\w-]+")),
            ("tk-num", re.compile(r"#[0-9a-fA-F]{3,8}\b|\b\d+(?:\.\d+)?(?:px|em|rem|vh|vw|s|ms|%)?")),
        ]
    if lang == "html":
        return [
            ("tk-com", re.compile(r"<!--[\s\S]*?-->")),
            ("tk-str", re.compile(r"(?:\"[^\"\n]*\"|'[^'\n]*)")),
            ("tk-kwd", re.compile(r"</?[\w-]+|/>|>")),
        ]
    if lang == "ini":
        return [
            ("tk-com", re.compile(r"[#;][^\n]*")),
            ("tk-sec", re.compile(r"^\s*\[[^\]]*\]", re.M)),
            ("tk-key", re.compile(r"^\s*[\w.-]+(?=\s*=)", re.M)),
            ("tk-num", re.compile(r"\b\d+(?:\.\d+)?\b")),
        ]
    return None


_ESC = [(r"&", "&amp;"), (r"<", "&lt;"), (r">", "&gt;")]


def _esc(s: str) -> str:
    for a, b in _ESC:
        s = s.replace(a, b)
    return s


def _kw_span(lang, word):
    kws = _KW.get(lang, set())
    if lang == "sql":
        return word.upper() in kws or word in kws
    return word in kws


def highlight(code: str, lang_raw: str) -> str:
    """返回已转义+高亮的 HTML(纯 span, 无原生标签)"""
    lang = _TK.get((lang_raw or "").lower())
    if not lang:
        return _esc(code)
    toks = _tokens_for_lang(lang)
    if not toks:
        return _esc(code)

    # 合并扫描: 逐位置找最早命中的 token
    out = []
    i = 0
    n = len(code)
    while i < n:
        best = None  # (start, end, cls, m)
        for cls, rx in toks:
            m = rx.search(code, i)
            if m and m.start() == i:
                best = (m.start(), m.end(), cls)
                break
            if m and (best is None or m.start() < best[0]):
                best = (m.start(), m.end(), cls)
        if best is None:
            out.append(_esc(code[i]))
            i += 1
            continue
        start, end, cls = best
        # 普通文本段: 标识符里挑关键词
        if start > i:
            seg = code[i:start]
            if lang in ("python", "js", "sh", "json", "yaml") and _KW.get(lang):
                for w in re.finditer(r"\b[A-Za-z_][A-Za-z0-9_]*\b", seg):
                    if _kw_span(lang, w.group(0)):
                        s0, s1 = w.span()
                        seg = seg[:s0] + seg[s0:s1] + seg[s1:]  # 占位, 后续统一处理
                # 简化: 关键词直接包裹(对已 esc 的 seg 逐词处理)
                words = re.split(r"(\b[A-Za-z_][A-Za-z0-9_]*\b)", _esc(seg))
                buf = []
                for w in words:
                    if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", w) and _kw_span(lang, w):
                        buf.append(f'<span class="tk-kwd">{w}</span>')
                    else:
                        buf.append(w)
                out.append("".join(buf))
            else:
                out.append(_esc(seg))
        out.append(f'<span class="{cls}">{_esc(code[start:end])}</span>')
        i = end
    return "".join(out)
