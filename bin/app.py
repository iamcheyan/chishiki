#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
chishiki v2 — 个人知识库服务器
纯标准库。API + 静态前端(web/) + docs 直出。
"""
import argparse
import errno
import json
import mimetypes
import os
import re
import subprocess
import shutil
import sys
import time
from datetime import datetime
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from typing import Optional, Dict, List
from urllib.parse import parse_qs, unquote, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mdrender import render as md_render  # noqa: E402

BASE = Path(__file__).resolve().parent
ROOT = BASE.parent
WEB_DIR = ROOT / "web"

# ---------------- 安全工具 ----------------

def _safe_doc_path(docs_dir: Path, raw: str, must_exist: bool = False) -> Optional[Path]:
    """解析 docs 内的相对路径; 防穿越; 只允许 .md(文件场景)。"""
    if not raw:
        return None
    rel = unquote(raw).strip().lstrip("/")
    if not rel or rel.startswith("."):
        return None
    target = (docs_dir / rel).resolve()
    try:
        target.relative_to(docs_dir.resolve())
    except ValueError:
        return None
    if must_exist and not target.exists():
        return None
    return target


def _safe_md_path(docs_dir: Path, raw: str, must_exist: bool = False) -> Optional[Path]:
    p = _safe_doc_path(docs_dir, raw, must_exist)
    if p is None or p.suffix.lower() != ".md":
        return None
    return p


def _atomic_write(path: Path, text: str) -> None:
    import uuid
    tmp = path.with_name(path.name + ".tmp-" + str(os.getpid()) + "-" + uuid.uuid4().hex[:8])
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


# ---------------- 树 / 索引 ----------------

def extract_title(md: Path) -> str:
    try:
        with md.open("r", encoding="utf-8") as f:
            for line in f:
                s = line.lstrip("\ufeff").strip()
                if s.startswith("#"):
                    return s.lstrip("#").strip() or md.stem
    except OSError:
        pass
    return md.stem


def build_tree(docs_dir: Path) -> List[dict]:
    """扁平目录树: [{type:dir|file, name, path, title, mtime, children}]"""
    def walk(d: Path) -> List[dict]:
        out = []
        try:
            entries = sorted(d.iterdir(), key=lambda p: (p.is_file(), p.name.lower()))
        except OSError:
            return out
        for e in entries:
            if e.name.startswith(".") or e.name.endswith("_assets"):
                continue
            rel = e.relative_to(docs_dir).as_posix()
            if e.is_dir():
                out.append({"type": "dir", "name": e.name, "path": rel,
                            "children": walk(e)})
            elif e.suffix.lower() == ".md":
                st = e.stat()
                out.append({"type": "file", "name": e.stem, "path": rel,
                            "title": extract_title(e), "mtime": int(st.st_mtime)})
        return out
    return walk(docs_dir)


RE_CODE_BLOCK = re.compile(r"```[\s\S]*?```")
RE_INLINE_CODE = re.compile(r"`[^`]*`")
RE_IMG = re.compile(r"!\[[^\]]*\]\([^)]+\)")
RE_LINK = re.compile(r"\[([^\]]*)\]\([^)]+\)")
RE_HTML = re.compile(r"<[^>]+>")
RE_SYNTAX = re.compile(r"[#>*\-]{1,3}\s*")
RE_WS = re.compile(r"\s+")
RE_HEADING = re.compile(r"^(#{1,6})\s+(.*)$")


def _slugify(text: str) -> str:
    s = re.sub(r"[^\w\s\-一-龥ぁ-んァ-ヶ]", "", text, flags=re.UNICODE).strip().lower()
    return re.sub(r"\s+", "-", s)


def strip_markdown(text: str) -> str:
    text = RE_CODE_BLOCK.sub(" ", text)
    text = RE_INLINE_CODE.sub(" ", text)
    text = RE_IMG.sub(" ", text)
    text = RE_LINK.sub(r"\g<1>", text)
    text = RE_HTML.sub(" ", text)
    text = RE_SYNTAX.sub(" ", text)
    return RE_WS.sub(" ", text).strip()


def build_search_index(docs_dir: Path) -> List[dict]:
    entries = []
    for md in sorted(docs_dir.rglob("*.md")):
        if md.name.startswith("_") or "/_assets/" in str(md):
            continue
        rel = md.relative_to(docs_dir).as_posix()
        try:
            raw = md.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        sections = []
        for line in raw.splitlines():
            m = RE_HEADING.match(line.strip())
            if not m:
                continue
            t = m.group(2).strip()
            if not t:
                continue
            slug = _slugify(t)
            sections.append({"title": t, "id": slug, "level": len(m.group(1))})
        entries.append({
            "path": rel,
            "title": extract_title(md),
            "mtime": int(md.stat().st_mtime),
            "sections": sections,
            "text": strip_markdown(raw)[:120000],
        })
    return entries


# ---------------- 传统维护功能(对等保留) ----------------

def normalize_assets_per_doc(docs_dir: Path) -> int:
    img_pat = re.compile(r"!\[[^\]]*\]\(([^)]+)\)")
    changed = 0
    for md in docs_dir.rglob("*.md"):
        if md.name.startswith("_"):
            continue
        try:
            text = md.read_text(encoding="utf-8")
        except OSError:
            continue
        parent, base = md.parent, md.stem
        dest_dir = parent / f"{base}_assets"

        def repl(m):
            nonlocal changed
            ps = m.group(1).strip()
            if not ps or re.match(r"^[a-zA-Z]+://", ps) or ps.startswith("data:"):
                return m.group(0)
            abs_path = (docs_dir / ps.lstrip("/")).resolve() if ps.startswith("/") else (parent / ps).resolve()
            if not abs_path.is_file():
                return m.group(0)
            try:
                if str(abs_path.relative_to(parent)).startswith(f"{base}_assets/"):
                    return m.group(0)
            except ValueError:
                pass
            dest_dir.mkdir(exist_ok=True)
            dest = dest_dir / abs_path.name
            if abs_path != dest and not dest.exists():
                shutil.copy2(abs_path, dest)
            changed += 1
            return m.group(0).replace(ps, dest.relative_to(parent).as_posix())

        new_text = img_pat.sub(repl, text)
        if new_text != text:
            _atomic_write(md, new_text)
    return changed


def clean_unused_assets(docs_dir: Path) -> int:
    assets_dir = docs_dir / "assets"
    if not assets_dir.is_dir():
        return 0
    used = set()
    img_pat = re.compile(r"!\[[^\]]*\]\(([^)]+)\)")
    for md in docs_dir.rglob("*.md"):
        try:
            text = md.read_text(encoding="utf-8")
        except OSError:
            continue
        for ps in img_pat.findall(text):
            ps = ps.strip()
            if not ps or re.match(r"^[a-z]+://", ps):
                continue
            t = (docs_dir / ps.lstrip("./")).resolve()
            if t.is_file():
                used.add(t)
    removed = 0
    for f in assets_dir.rglob("*"):
        if f.is_file() and f not in used:
            f.unlink()
            removed += 1
    return removed


# ---------------- HTTP Handler ----------------

class Handler(SimpleHTTPRequestHandler):
    docs_dir: Path = None
    index_cache = {"ts": 0.0, "data": None}

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(WEB_DIR), **kw)

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (datetime.now().strftime("%H:%M:%S"), fmt % args))

    # --- 基础设施 ---
    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _body_json(self) -> Optional[dict]:
        try:
            n = int(self.headers.get("Content-Length", "0"))
            if n > 25 * 1024 * 1024:
                return None
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
            return None

    def _get_index(self):
        now = time.time()
        c = Handler.index_cache
        if c["data"] is None or now - c["ts"] > 3.0:
            c["data"] = build_search_index(self.docs_dir)
            c["ts"] = now
        return c["data"]

    def _refresh(self):
        Handler.index_cache["ts"] = 0.0

    # --- GET ---
    def do_GET(self):
        p = urlparse(self.path)
        if p.path == "/api/tree":
            return self._json(200, {"ok": True, "tree": build_tree(self.docs_dir),
                                    "docsRoot": "docs"})
        if p.path == "/api/doc":
            q = parse_qs(p.query)
            md = _safe_md_path(self.docs_dir, (q.get("path") or [""])[0], must_exist=True)
            if md is None:
                return self._json(404, {"ok": False, "error": "not found"})
            try:
                rel = md.relative_to(self.docs_dir).as_posix()
                raw = md.read_text(encoding="utf-8")
                if (q.get("rendered") or [""])[0] == "1":
                    html = md_render(raw, rel)
                    return self._json(200, {"ok": True, "path": rel, "html": html,
                                            "mtime": int(md.stat().st_mtime)})
                return self._json(200, {"ok": True, "path": rel, "content": raw,
                                        "mtime": int(md.stat().st_mtime)})
            except OSError:
                return self._json(500, {"ok": False, "error": "read failed"})
        if p.path == "/api/search-index":
            body = json.dumps({"ok": True, "entries": self._get_index()},
                              ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        if p.path == "/api/gallery":
            q = parse_qs(p.query)
            rel = (q.get("dir") or [""])[0]
            base = _safe_doc_path(self.docs_dir, rel) if rel else self.docs_dir
            if base is None:
                return self._json(400, {"ok": False, "error": "invalid dir"})
            imgs = []
            if base.is_file() and base.suffix.lower() == ".md":
                asset_dir = base.parent / f"{base.stem}_assets"
                if asset_dir.is_dir():
                    for f in sorted(asset_dir.iterdir(), key=lambda x: x.stat().st_mtime, reverse=True):
                        if f.suffix.lower() in (".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"):
                            imgs.append({"name": f.name,
                                         "url": "/files/" + f.relative_to(self.docs_dir).as_posix(),
                                         "size": f.stat().st_size,
                                         "mtime": int(f.stat().st_mtime)})
            else:
                for d in [base] + [x for x in base.rglob("*_assets")] + [base / "assets"]:
                    if not d.is_dir():
                        continue
                    for f in sorted(d.iterdir(), key=lambda x: x.stat().st_mtime, reverse=True):
                        if f.suffix.lower() in (".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"):
                            imgs.append({"name": f.name,
                                         "url": "/files/" + f.relative_to(self.docs_dir).as_posix(),
                                         "size": f.stat().st_size,
                                         "mtime": int(f.stat().st_mtime)})
            seen = set(); uniq = []
            for im in imgs:
                if im["url"] not in seen:
                    seen.add(im["url"]); uniq.append(im)
            return self._json(200, {"ok": True, "dir": rel, "images": uniq[:500]})
        if p.path == "/api/health":
            return self._json(200, {"ok": True, **_health_report(self.docs_dir)})

        if p.path == "/api/git/status":
            out = _git(self.docs_dir, "status", "--porcelain")
            files = [l[3:] for l in out.splitlines() if l.strip()]
            return self._json(200, {"ok": True, "dirty": len(files), "files": files[:100]})

        if p.path == "/api/git/log":
            q = parse_qs(p.query)
            path = (q.get("path") or [""])[0]
            args = ["log", "--pretty=format:%h|%ad|%s", "--date=format:%Y-%m-%d %H:%M", "-n", "10"]
            if path:
                md = _safe_md_path(self.docs_dir, path)
                if md is None:
                    return self._json(404, {"ok": False, "error": "not found"})
                args += ["--", md.relative_to(self.docs_dir).as_posix()]
            out = _git(self.docs_dir, *args)
            entries = []
            for l in out.splitlines():
                parts = l.split("|", 2)
                if len(parts) == 3:
                    entries.append({"hash": parts[0], "date": parts[1], "subject": parts[2]})
            return self._json(200, {"ok": True, "log": entries})

        if p.path == "/api/meta":
            n = len([m for m in self.docs_dir.rglob("*.md") if not m.name.startswith("_")])
            return self._json(200, {"ok": True, "docs": n,
                                    "built": datetime.now().strftime("%Y-%m-%d %H:%M")})
        if p.path.startswith("/files/"):
            rel = unquote(p.path[len("/files/"):])
            target = _safe_doc_path(self.docs_dir, rel, must_exist=True)
            if target is None:
                return self._json(404, {"ok": False, "error": "not found"})
            ct, _ = mimetypes.guess_type(str(target))
            try:
                data = target.read_bytes()
            except OSError:
                return self._json(500, {"ok": False, "error": "read failed"})
            self.send_response(200)
            self.send_header("Content-Type", ct or "application/octet-stream")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "max-age=300")
            self.end_headers()
            self.wfile.write(data)
            return
        super().do_GET()

    # --- POST ---
    def do_POST(self):
        p = urlparse(self.path)
        d = self.docs_dir

        if p.path == "/api/doc/save":
            payload = self._body_json()
            if payload is None:
                return self._json(400, {"ok": False, "error": "bad json"})
            md = _safe_md_path(d, str(payload.get("path", "")))
            content = payload.get("content")
            if md is None or not isinstance(content, str):
                return self._json(400, {"ok": False, "error": "invalid"})
            # overwrite 保护: 显式 overwrite=true 才允许覆盖已存在文档(编辑器保存传true; 移动到同名路径会被拒)
            if md.exists() and payload.get("overwrite") is not True:
                return self._json(409, {"ok": False, "error": "exists"})
            try:
                md.parent.mkdir(parents=True, exist_ok=True)
                _atomic_write(md, content)
            except OSError:
                return self._json(500, {"ok": False, "error": "write failed"})
            self._refresh()
            return self._json(200, {"ok": True, "path": md.relative_to(d).as_posix()})

        if p.path == "/api/doc/create":
            payload = self._body_json()
            if payload is None:
                return self._json(400, {"ok": False, "error": "bad json"})
            rel = str(payload.get("path", "")).strip()
            if not rel or "/" in rel or rel.startswith("."):
                return self._json(400, {"ok": False, "error": "invalid name"})
            parent_rel = str(payload.get("dir", "")).strip()
            base = _safe_doc_path(d, parent_rel) if parent_rel else d
            if base is None:
                return self._json(400, {"ok": False, "error": "invalid dir"})
            md = base / f"{rel}.md" if not rel.endswith(".md") else base / rel
            if md.exists():
                return self._json(409, {"ok": False, "error": "exists"})
            try:
                md.parent.mkdir(parents=True, exist_ok=True)
                title = str(payload.get("title") or rel)
                _atomic_write(md, f"# {title}\n\n")
            except OSError:
                return self._json(500, {"ok": False, "error": "write failed"})
            self._refresh()
            return self._json(200, {"ok": True, "path": md.relative_to(d).as_posix()})

        if p.path == "/api/doc/rename":
            payload = self._body_json()
            if payload is None:
                return self._json(400, {"ok": False, "error": "bad json"})
            src = _safe_md_path(d, str(payload.get("path", "")), must_exist=True)
            newname = str(payload.get("name", "")).strip()
            if src is None or not newname or "/" in newname or newname.startswith("."):
                return self._json(400, {"ok": False, "error": "invalid"})
            dst = src.with_name(newname if newname.endswith(".md") else newname + ".md")
            if dst.exists():
                return self._json(409, {"ok": False, "error": "exists"})
            try:
                src.rename(dst)
                # 迁移 <stem>_assets: 目标不存在→整目录改名; 已存在→逐文件合并(时间戳名冲突罕见, 冲突则加后缀)
                old_assets = src.parent / f"{src.stem}_assets"
                new_assets = dst.parent / f"{dst.stem}_assets"
                migrated = False
                if old_assets.is_dir():
                    if not new_assets.exists():
                        old_assets.rename(new_assets)
                        migrated = True
                    else:
                        for f in old_assets.iterdir():
                            target = new_assets / f.name
                            if target.exists():
                                target = new_assets / (f.stem + "-" + dst.stem + f.suffix)
                            f.rename(target)
                        migrated = True
                        try:
                            if not any(old_assets.iterdir()):
                                old_assets.rmdir()
                        except OSError:
                            pass
                if migrated:
                    # 同步改写 md 内引用, 否则目录搬走引用全断
                    try:
                        text = dst.read_text(encoding="utf-8")
                        new_text = text.replace(f"{src.stem}_assets/", f"{dst.stem}_assets/")
                        if new_text != text:
                            _atomic_write(dst, new_text)
                    except (OSError, UnicodeDecodeError):
                        pass  # 引用改写失败不阻断改名
            except OSError:
                return self._json(500, {"ok": False, "error": "rename failed"})
            return self._json(200, {"ok": True, "path": dst.relative_to(d).as_posix()})

        if p.path == "/api/doc/delete":
            payload = self._body_json()
            if payload is None:
                return self._json(400, {"ok": False, "error": "bad json"})
            md = _safe_md_path(d, str(payload.get("path", "")), must_exist=True)
            if md is None:
                return self._json(404, {"ok": False, "error": "not found"})
            try:
                md.unlink()
                assets = md.parent / f"{md.stem}_assets"
                if assets.is_dir() and not any(assets.iterdir()):
                    assets.rmdir()
            except OSError:
                return self._json(500, {"ok": False, "error": "delete failed"})
            self._refresh()
            return self._json(200, {"ok": True})

        if p.path == "/api/image":
            return self._upload_image()

        if p.path == "/api/image/delete":
            payload = self._body_json()
            if payload is None:
                return self._json(400, {"ok": False, "error": "bad json"})
            img = _safe_asset_path(d, str(payload.get("url", "")), must_exist=True)
            if img is None:
                return self._json(404, {"ok": False, "error": "not found"})
            try:
                img.unlink()
            except OSError:
                return self._json(500, {"ok": False, "error": "delete failed"})
            self._refresh()
            return self._json(200, {"ok": True})


        if p.path == "/api/clean":
            # 清理孤儿图片(未被任何 md 引用的图片文件), dry_run 默认 true
            payload = self._body_json() or {}
            dry = bool(payload.get("dry_run", True))
            report = _health_report(d)
            deleted = []
            if not dry:
                for item in report["orphan_images"]:
                    img = _safe_asset_path(d, item["path"], must_exist=True)
                    if img is None:
                        continue          # 删除前二次校验失败 → 跳过
                    try:
                        img.unlink()
                        deleted.append(item["path"])
                    except OSError:
                        pass
                # 清掉空 assets 目录
                for ad in report["empty_asset_dirs"]:
                    try:
                        (d / ad).rmdir()
                    except OSError:
                        pass
                self._refresh()
            return self._json(200, {"ok": True, "dry_run": dry,
                                    "candidates": len(report["orphan_images"]),
                                    "deleted": deleted})

        if p.path == "/api/git/commit":
            payload = self._body_json() or {}
            msg = str(payload.get("message") or "").strip() or f"chishiki: update {time.strftime('%Y-%m-%d %H:%M')}"
            if len(msg) > 200:
                return self._json(400, {"ok": False, "error": "message too long"})
            _git(self.docs_dir, "add", "-A")
            out = _git(self.docs_dir, "commit", "-m", msg)
            return self._json(200, {"ok": True, "result": out.strip()[:500]})

        if p.path == "/api/git/restore":
            payload = self._body_json()
            if payload is None:
                return self._json(400, {"ok": False, "error": "bad json"})
            md = _safe_md_path(self.docs_dir, str(payload.get("path", "")), must_exist=False)
            h = str(payload.get("hash", "")).strip()
            if md is None or not re.fullmatch(r"[0-9a-f]{6,40}", h):
                return self._json(400, {"ok": False, "error": "invalid"})
            out = _git(self.docs_dir, "checkout", h, "--", md.relative_to(self.docs_dir).as_posix())
            return self._json(200, {"ok": True, "result": out.strip()[:300]})

        return self._json(404, {"ok": False, "error": "not found"})

    def _upload_image(self):
        ct = self.headers.get("Content-Type", "")
        m = re.search(r'boundary="?([^";]+)"?', ct)
        if not m:
            return self._json(400, {"ok": False, "error": "multipart required"})
        boundary = m.group(1).encode()
        n = int(self.headers.get("Content-Length", "0"))
        if n > 25 * 1024 * 1024:
            return self._json(413, {"ok": False, "error": "too large"})
        body = self.rfile.read(n)

        fields: Dict[str, str] = {}
        file_data = b""
        file_ct = ""
        for raw in body.split(b"--" + boundary):
            part = raw.strip()
            if not part or part == b"--" or b"\r\n\r\n" not in part:
                continue
            head, data = part.split(b"\r\n\r\n", 1)
            data = data.rstrip(b"\r\n")
            disp = b""
            for line in head.split(b"\r\n"):
                if line.lower().startswith(b"content-disposition"):
                    disp = line
            nm = re.search(rb'name="([^"]+)"', disp)
            if not nm:
                continue
            fn = re.search(rb'filename="([^"]*)"', disp)
            if fn is not None:
                file_data = data
                for line in head.split(b"\r\n"):
                    if line.lower().startswith(b"content-type:"):
                        file_ct = line.split(b":", 1)[1].decode("latin1").strip()
            else:
                fields[nm.group(1).decode()] = data.decode("utf-8", "ignore")

        md = _safe_md_path(self.docs_dir, fields.get("path", ""), must_exist=True)
        if md is None or not file_data:
            return self._json(400, {"ok": False, "error": "need valid path + file"})

        ext = mimetypes.guess_extension(file_ct or "") or ".png"
        if ext == ".jpe":
            ext = ".jpg"
        dest_dir = md.parent / f"{md.stem}_assets"
        dest_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y-%m-%d-%H-%M-%S")
        idx = 0
        while True:
            suffix = f"-{idx:02d}" if idx else ""
            dest = dest_dir / f"{stamp}{suffix}{ext}"
            if not dest.exists():
                break
            idx += 1
        try:
            dest.write_bytes(file_data)
        except OSError:
            return self._json(500, {"ok": False, "error": "write failed"})
        rel = dest.relative_to(md.parent).as_posix()
        return self._json(200, {"ok": True, "path": rel, "markdown": f"![image]({rel})"})


def _safe_asset_path(root: Path, url: str, must_exist: bool = False) -> Path | None:
    """图片删除: 校验 url(相对 docs 的资源路径, 限图片后缀+必须位于 *_assets/assets 目录, 防穿越)"""
    from urllib.parse import unquote
    url = unquote((url or "").strip().lstrip("/"))
    if not url or ".." in url.split("/"):
        return None
    # 必须位于资产目录内(父目录名以 _assets 结尾或名为 assets)
    parts = url.split("/")
    if len(parts) < 2 or not (parts[-2].endswith("_assets") or parts[-2] == "assets"):
        return None
    p = (root / url)
    try:
        p = p.resolve()
        p.relative_to(root.resolve())
    except (ValueError, OSError):
        return None
    if p.suffix.lower() not in {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"}:
        return None
    if must_exist and not p.is_file():
        return None
    return p


_RE_MD_LINK = re.compile(r"!\[[^\]]*\]\(([^)\s]+)")
_RE_HTML_IMG = re.compile(r'<img\b[^>]*\bsrc=["\']([^"\']+)["\']', re.I)


def _health_report(d: Path) -> dict:
    """健康检查: 断链文档/丢失图片/孤儿图片/空目录/重复标题"""
    docs = list(d.rglob("*.md"))
    referenced: set[str] = set()          # 被引用的图片(相对文档目录)
    broken_docs, missing_images, dup_titles = [], [], []
    seen_titles: dict[str, str] = {}
    for md in docs:
        rel = md.relative_to(d).as_posix()
        try:
            text = md.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        # 文档内链 [x](y.md) 断链
        for m in re.finditer(r"\[[^\]]*\]\(([^)#\s]+\.md)\)", text):
            target = m.group(1)
            tp = (md.parent / target).resolve()
            try:
                tp.relative_to(d.resolve())
            except ValueError:
                continue
            if not tp.exists():
                broken_docs.append({"doc": rel, "target": target})
        # 图片引用(Markdown 语法 + HTML <img>, URL 解码, 跳过远程/data)
        for rex in (_RE_MD_LINK, _RE_HTML_IMG):
            for m in rex.finditer(text):
                raw = m.group(1)
                if raw.startswith(("http://", "https://", "data:", "//")):
                    continue
                raw_dec = unquote(raw)
                ip = (md.parent / raw_dec).resolve()
                try:
                    ip.relative_to(d.resolve())
                except ValueError:
                    continue
                referenced.add(ip.as_posix())
                if not ip.exists():
                    missing_images.append({"doc": rel, "url": raw_dec})
        h1 = re.search(r"^# (.+)$", text, re.M)
        if h1:
            t = h1.group(1).strip()
            if t in seen_titles:
                dup_titles.append({"title": t, "a": seen_titles[t], "b": rel})
            else:
                seen_titles[t] = rel
    # 孤儿图片: 仅扫描 *_assets/assets 目录(不碰文档旁散图), 且 svg 一律不算孤儿(可执行内容不删)
    orphan_images = []
    empty_dirs = []
    for ad in d.rglob("*"):
        if not (ad.is_dir() and (ad.name.endswith("_assets") or ad.name == "assets")):
            continue
        if not any(ad.iterdir()):
            empty_dirs.append(ad.relative_to(d).as_posix())
            continue
        for img in ad.iterdir():
            if not img.is_file():
                continue
            if img.suffix.lower() in {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}:
                if img.resolve().as_posix() not in referenced:
                    stat = img.stat()
                    orphan_images.append({"path": img.relative_to(d).as_posix(), "size": stat.st_size})
    return {
        "docs": len(docs),
        "broken_doc_links": broken_docs,
        "missing_images": missing_images,
        "orphan_images": orphan_images,
        "empty_asset_dirs": empty_dirs,
        "dup_titles": dup_titles,
    }


def _git(docs_dir: Path, *args: str) -> str:
    """安全执行 git 只读/指定命令(超时10s)"""
    try:
        r = subprocess.run(["git", *args], cwd=str(docs_dir), capture_output=True,
                           text=True, timeout=10)
        return (r.stdout or "") + (("\n[stderr] " + r.stderr) if r.returncode else "")
    except (OSError, subprocess.TimeoutExpired) as e:
        return f"[error] {e}"


def run_server(docs_dir: Path, host: str, port: int) -> None:
    Handler.docs_dir = docs_dir
    handler = Handler
    for p in (port, port + 1, 3000, 3001, 8000):
        try:
            with ThreadingHTTPServer((host, p), handler) as httpd:
                print(f"chishiki v2 → http://{host}:{p}/  (docs: {docs_dir})")
                httpd.serve_forever()
            return
        except OSError as e:
            if e.errno in (errno.EADDRINUSE, 98):
                continue
            raise
    raise RuntimeError("no available port")


def main():
    ap = argparse.ArgumentParser(description="chishiki v2 — personal knowledge base")
    ap.add_argument("--docs-dir", default=str(ROOT / "docs"))
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8850)
    ap.add_argument("--normalize-assets", action="store_true", default=True)
    ap.add_argument("--no-normalize", dest="normalize_assets", action="store_false")
    ap.add_argument("--clean-assets", action="store_true")
    ap.add_argument("--commit", action="store_true")
    ap.add_argument("--no-serve", action="store_true")
    args = ap.parse_args()

    docs_dir = Path(args.docs_dir).expanduser().resolve()
    docs_dir.mkdir(parents=True, exist_ok=True)

    if args.normalize_assets:
        n = normalize_assets_per_doc(docs_dir)
        if n:
            print(f"assets normalized: {n} refs")
    if args.clean_assets:
        print(f"unused assets removed: {clean_unused_assets(docs_dir)}")

    if args.commit:
        ts = datetime.now().strftime("%Y%m%d-%H%M%S")
        subprocess.run(["git", "add", "-A"], cwd=str(ROOT), check=False)
        subprocess.run(["git", "commit", "--allow-empty", "-m", ts], cwd=str(ROOT), check=False)

    if args.no_serve:
        print("done (--no-serve)")
        return
    run_server(docs_dir, args.host, args.port)


if __name__ == "__main__":
    main()
