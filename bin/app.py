# -*- coding: utf-8 -*-
"""
docs フォルダ内の Markdown(.md) から Docsify 用の `_sidebar.md` を生成し、
その後 Docsify サーバ（または簡易 HTTP サーバ）を起動するスクリプト。

あわせて、オプション指定により未使用の画像ファイル(assets 配下)のクリーンアップや
git へのコミットも行える。

使い方:
    python tools/app.py                            # _sidebar.md を生成してサーバを起動
    python tools/app.py --no-serve                 # _sidebar.md の生成だけ行う
    python tools/app.py --clean-assets             # 未使用画像を削除してから通常処理を実施
    python tools/app.py --clean-assets --no-serve  # 未使用画像削除 + サーバ起動なし
    python tools/app.py --commit --no-serve        # 生成後に git へコミット（メッセージはタイムスタンプ）
    python tools/app.py --docs-dir ./docs          # ドキュメントディレクトリを指定
"""

import subprocess
import sys
import time
import re
import shutil
import os
import json
import mimetypes
import errno
from datetime import datetime
from pathlib import Path
from typing import Optional, List, Dict, Set
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import parse_qs, unquote, urlparse


def _extract_docs_dir_arg(argv: List[str]) -> Optional[str]:
    for i, arg in enumerate(argv):
        if arg == "--docs-dir":
            if i + 1 < len(argv):
                return argv[i + 1]
            raise ValueError("--docs-dir の指定にはパスが必要です。")
        if arg.startswith("--docs-dir="):
            return arg.split("=", 1)[1]
    return None


def resolve_docs_dir(argv: List[str], base_dir: Path) -> Path:
    """
    ドキュメントディレクトリを解決する。
    優先順位: CLI(--docs-dir) > 環境変数(DOCS_DIR) > ../docs
    存在しなければ空ディレクトリを作成する。
    """
    cli_dir = _extract_docs_dir_arg(argv)
    env_dir = os.environ.get("DOCS_DIR")

    if cli_dir:
        docs_dir = Path(cli_dir).expanduser()
    elif env_dir:
        docs_dir = Path(env_dir).expanduser()
    else:
        docs_dir = base_dir.parent / "docs"

    if not docs_dir.is_absolute():
        docs_dir = (Path.cwd() / docs_dir).resolve()

    if docs_dir.exists() and not docs_dir.is_dir():
        raise NotADirectoryError(f"docs ディレクトリがファイルです: {docs_dir}")

    docs_dir.mkdir(parents=True, exist_ok=True)
    return docs_dir


def extract_title(md_path: Path) -> Optional[str]:
    """
    Markdown ファイルの先頭から見出し行 (# 〜) を探し、
    最初に見つかったものをタイトルとして返す。
    見つからなければ None。
    """
    try:
        with md_path.open("r", encoding="utf-8") as f:
            for line in f:
                # BOM を含んでいる可能性があるので、先に削除してから判定する
                stripped = line.lstrip("\ufeff").strip()
                if stripped.startswith("#"):
                    # 先頭の # をすべて取り除き、残りをタイトルにする
                    return stripped.lstrip("#").strip()
    except OSError:
        return None
    return None


def collect_markdown_files(docs_dir: Path) -> List[Path]:
    """
    サイドバーに掲載する Markdown ファイル一覧を取得する。
    - docs 配下を再帰的に探索
    - _sidebar.md は除外
    """
    md_files: List[Path] = []
    for md in docs_dir.rglob("*.md"):
        name = md.name

        if name == "_sidebar.md":
            continue

        md_files.append(md)

    # docs からの相対パスでソート（ディレクトリ構造順）
    md_files.sort(key=lambda p: p.relative_to(docs_dir).as_posix())
    return md_files


def build_tree(docs_dir: Path, md_files: List[Path]) -> Dict[str, Dict]:
    """
    ファイルパスのリストからディレクトリ構造を表すツリーを構築する。
    ツリーの各ノードは以下のような辞書:
        {
            "__files__": [Path, ...],
            "subdir_name": { ... 子ノード ... },
        }
    """
    root: Dict[str, Dict] = {"__files__": []}

    for md in md_files:
        rel = md.relative_to(docs_dir)
        parts = rel.parts  # ("subdir", "file.md") など

        node = root
        # 最後の要素（ファイル名）以外はディレクトリとして扱う
        for dir_name in parts[:-1]:
            node = node.setdefault(dir_name, {"__files__": []})
        node.setdefault("__files__", []).append(md)

    return root


def render_tree(
    node: Dict[str, Dict],
    docs_dir: Path,
    lines: List[str],
    indent: int = 1,
    current_dir: Optional[Path] = None,
) -> None:
    """
    ツリー構造を Docsify のサイドバー用 Markdown に変換する。

    - ディレクトリに README.md がある場合は、
      ディレクトリ名の行を README.md へのリンクとして表示し、
      その README.md 自体は子要素として重複表示しない。
    """
    if current_dir is None:
        current_dir = docs_dir

    # まずカレントディレクトリ直下のファイルを出力
    files = sorted(node.get("__files__", []), key=lambda p: p.name)

    for md in files:
        title = extract_title(md) or md.stem
        rel_path = md.relative_to(docs_dir).as_posix()
        lines.append(f"{'  ' * indent}* [{title}]({rel_path})")

    # 次にサブディレクトリを名前順に出力
    for name in sorted(k for k in node.keys() if k != "__files__"):
        child = node[name]
        dir_path = current_dir / name

        # ディレクトリ名をそのままグループ見出しとして出力し、
        # その直下の .md とサブディレクトリを列挙する。
        lines.append(f"{'  ' * indent}* {name}")
        render_tree(child, docs_dir, lines, indent + 1, dir_path)


def generate_sidebar(docs_dir: Path) -> Path:
    """
    docs 内のディレクトリ構造に基づいて Docsify 用の _sidebar.md を生成する。
    - ディレクトリ名がそのままグループ名になる
    - 各 .md ファイルは先頭の見出し(# ...) またはファイル名をリンク名として使用
    - 新しいフォルダ／ファイルを追加すれば、そのままサイドバーに反映される
    """
    md_files = collect_markdown_files(docs_dir)

    # ディレクトリ構造のツリーを構築
    tree = build_tree(docs_dir, md_files)

    lines: List[str] = []
    lines.append("* ドキュメント目次")

    # ルート（docs）配下の構造をそのままサイドバーに反映
    render_tree(tree, docs_dir, lines, indent=1, current_dir=docs_dir)

    sidebar_path = docs_dir / "_sidebar.md"
    sidebar_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return sidebar_path


def _render_dir_structure(
    base_dir: Path, current_dir: Path, lines: List[str], indent: int = 0
) -> None:
    """
    base_dir からの相対パスで、current_dir 以下の構造を Markdown の箇条書きとして出力する。
    Excel などのファイルもリンクとして出力する。
    """
    # current_dir 配下（直下のみ）のエントリを名前順に列挙
    entries = sorted(current_dir.iterdir(), key=lambda p: p.name)
    for entry in entries:
        rel = entry.relative_to(base_dir).as_posix()
        prefix = "  " * indent
        if entry.is_dir():
            # ディレクトリは末尾に / をつけてリンク
            lines.append(f"{prefix}- [{entry.name}/]({rel}/)")
            _render_dir_structure(base_dir, entry, lines, indent + 1)
        else:
            # ファイルはそのままリンク（Excel などもリンク可能）
            lines.append(f"{prefix}- [{entry.name}]({rel})")


def ensure_readme_for_directories(docs_dir: Path) -> None:
    """
    docs/手順書 配下の各ディレクトリについて、
    そのディレクトリ直下に .md ファイルが 1 つも無い場合、
    README.md を自動生成する。

    README にはフォルダ構成と各ファイル・サブディレクトリへのリンクを書き出す。
    """
    base = docs_dir / "手順書"
    if not base.is_dir():
        return

    # 手順書直下のディレクトリ（＝各標準手順書フォルダ）のみを対象にする。
    target_dirs = [d for d in base.iterdir() if d.is_dir()]

    for d in target_dirs:
        # すでに README.md があればスキップ
        readme_path = d / "README.md"
        if readme_path.exists():
            continue

        # ディレクトリ直下に .md が 1 つでもあればスキップ
        has_md = any(
            child.is_file() and child.suffix.lower() == ".md"
            for child in d.iterdir()
        )
        if has_md:
            continue

        # README.md を生成
        title = d.name
        lines: List[str] = []
        lines.append(f"# {title}")
        lines.append("")
        lines.append("このフォルダの構成とリンク")
        lines.append("")

        _render_dir_structure(d, d, lines, indent=0)

        readme_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def bump_search_namespace(docs_dir: Path) -> None:
    """
    Docsify の検索プラグインは localStorage にキャッシュを持つ。
    `namespace` を変えると別キーとして再作成されるため、
    ここで index.html 内の namespace を毎回更新し、
    実質「毎回キャッシュを作り直す」挙動にする。
    """
    index_path = docs_dir / "index.html"
    if not index_path.is_file():
        return

    try:
        text = index_path.read_text(encoding="utf-8")
    except OSError:
        return

    new_ns = f"namespace: 'kaku-{int(time.time())}',"

    # すでに namespace がある場合は置き換え
    if "namespace:" in text:
        updated = re.sub(r"namespace:\s*'[^']*',", new_ns, text)
    else:
        # 無い場合は search 設定内の noData 行の直後に挿入
        marker = "noData: '一致なし',"
        if marker in text:
            updated = text.replace(marker, marker + f"\n          {new_ns}")
        else:
            updated = text

    if updated != text:
        try:
            index_path.write_text(updated, encoding="utf-8")
        except OSError:
            pass


def update_sidebar_timestamp(docs_dir: Path) -> None:
    """
    index.html 内の .sidebar > h1::after の content を
    現在の日時に更新する。
    形式: "Last updated: YYYY-MM-DD HH:MM"
    """
    index_path = docs_dir / "index.html"
    if not index_path.is_file():
        return

    try:
        text = index_path.read_text(encoding="utf-8")
    except OSError:
        return

    # 現在の日時を取得（形式: YYYY-MM-DD HH:MM）
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    new_content = f'content: "Last updated: {now}";'

    # 小さな <style> タグ内の .sidebar > h1::after の content を置き換え
    # パターン: .sidebar > h1::after { content: "任意の文字列"; }
    after_pattern = r'(\.sidebar > h1::after\s*\{[^}]*?)(content:\s*"[^"]*";)([^}]*\})'

    def replace_content(match):
        before = match.group(1)
        after_block = match.group(3)
        return before + new_content + after_block

    updated = re.sub(after_pattern, replace_content, text, flags=re.DOTALL)

    if updated != text:
        try:
            index_path.write_text(updated, encoding="utf-8")
            print(f"サイドバーの最終更新日時を更新しました: {now}")
        except OSError as e:
            print(f"サイドバーの最終更新日時更新に失敗しました: {e}")


def build_local_search_index(docs_dir: Path) -> None:
    """
    ローカル検索用のインデックスを生成する。
    tools/build_search_index.py を呼び出すだけのラッパー。
    """
    script = Path(__file__).resolve().parent / "build_search_index.py"
    if not script.is_file():
        print(f"検索インデックス生成スクリプトが見つかりません: {script}")
        return

    try:
        subprocess.run(
            [sys.executable, str(script), "--docs-dir", str(docs_dir)],
            cwd=str(Path.cwd()),
            check=True,
        )
        print("検索インデックスを更新しました。")
    except subprocess.CalledProcessError as e:
        print(f"検索インデックス生成に失敗しました: {e}")


def clean_unused_assets(docs_dir: Path) -> None:
    """
    docs_dir 配下の .md ファイルを走査し、Markdown から参照されていない
    assets 配下の画像ファイルを削除する。
    """
    assets_dir = docs_dir / "assets"
    if not assets_dir.is_dir():
        print(f"assets ディレクトリが見つからないため、クリーンアップをスキップします: {assets_dir}")
        return

    # すべての .md から画像パスを収集する
    used_files: Set[Path] = set()
    img_pattern = re.compile(r"!\[[^\]]*\]\(([^)]+)\)")

    for md in docs_dir.rglob("*.md"):
        try:
            text = md.read_text(encoding="utf-8")
        except OSError:
            continue

        for path_str in img_pattern.findall(text):
            path_str = path_str.strip()
            if not path_str:
                continue
            # URL(https:// 等) はスキップ
            if re.match(r"^[a-z]+://", path_str):
                continue

            # ./assets/... のような表記を正規化
            normalized = path_str.lstrip("./")
            if not normalized.startswith("assets/"):
                # assets 直下以外の画像はこのクリーンアップ対象外
                continue

            target = (docs_dir / normalized).resolve()
            try:
                # assets 配下のファイルのみ対象にする
                if target.is_file() and str(target).startswith(str(assets_dir.resolve())):
                    used_files.add(target)
            except OSError:
                continue

    # assets 配下の全ファイルと比較し、未使用のものを削除
    removed = 0
    for f in assets_dir.rglob("*"):
        if not f.is_file():
            continue
        if f not in used_files:
            rel = f.relative_to(docs_dir)
            print(f"未使用の画像を削除します: {rel}")
            try:
                f.unlink()
                removed += 1
            except OSError as e:
                print(f"  削除に失敗しました: {f} ({e})")

    print(f"画像クリーンアップ完了。削除ファイル数: {removed}")


def normalize_assets_per_doc(docs_dir: Path) -> None:
    """
    各 Markdown ファイルが参照している画像を、
    その Markdown と同じディレクトリ配下の `<basename>_assets/` にコピーし、
    パスもそちらを指すように書き換える。

    例:
        docs/個人メモ/基本情報.md
        → 画像は docs/個人メモ/基本情報_assets/ 配下へコピー
        → Markdown 内のパスは `基本情報_assets/xxx.png` のような相対パスに更新

    既に `<basename>_assets/` にある画像は再コピーしない。
    HTTP(S) や data URL、存在しないファイルへの参照はそのまま。
    """
    img_pattern = re.compile(r"!\[[^\]]*\]\(([^)]+)\)")

    for md in docs_dir.rglob("*.md"):
        # _sidebar.md などは対象外
        if md.name == "_sidebar.md":
            continue

        try:
            text = md.read_text(encoding="utf-8")
        except OSError:
            continue

        parent = md.parent
        base = md.stem
        dest_dir = parent / f"{base}_assets"

        changed = False

        def replace_match(match: re.Match) -> str:
            nonlocal changed
            path_str = match.group(1).strip()

            # 空・外部 URL・data URL はそのまま
            if not path_str:
                return match.group(0)
            if re.match(r"^[a-zA-Z]+://", path_str):
                return match.group(0)
            if path_str.startswith("data:"):
                return match.group(0)

            # 実ファイルパスへ解決
            if path_str.startswith("/"):
                # サイトルート（docs）からのパスとみなす
                abs_path = (docs_dir / path_str.lstrip("/")).resolve()
            else:
                abs_path = (parent / path_str).resolve()

            if not abs_path.is_file():
                return match.group(0)

            # すでに <basename>_assets 配下ならそのまま
            try:
                rel_to_parent = abs_path.relative_to(parent)
                if str(rel_to_parent).startswith(f"{base}_assets/"):
                    return match.group(0)
            except ValueError:
                # parent より外の場合はそのまま扱う
                pass

            dest_dir.mkdir(exist_ok=True)
            dest_file = dest_dir / abs_path.name

            if abs_path != dest_file:
                if not dest_file.exists():
                    try:
                        shutil.copy2(abs_path, dest_file)
                    except OSError:
                        return match.group(0)

            # Markdown から見た相対パスに置き換え
            new_rel = dest_file.relative_to(parent).as_posix()
            changed = True
            return match.group(0).replace(path_str, new_rel)

        new_text = img_pattern.sub(replace_match, text)
        if changed and new_text != text:
            try:
                md.write_text(new_text, encoding="utf-8")
                rel = md.relative_to(docs_dir)
                print(f"画像パスを整理しました: {rel} -> {base}_assets/")
            except OSError as e:
                print(f"Markdown 更新に失敗しました: {md} ({e})")


def git_commit_all(base_dir: Path, message: Optional[str] = None) -> None:
    """
    作業ディレクトリ全体を git にコミットする。
    - git add -A
    - git commit --allow-empty -m "<timestamp>"
    """
    if message is None:
        ts = datetime.now().strftime("%Y%m%d-%H%M%S")
        message = ts

    print("git へコミットを実行します...")
    try:
        subprocess.run(["git", "add", "-A"], cwd=str(base_dir), check=True)
        subprocess.run(
            ["git", "commit", "--allow-empty", "-m", message],
            cwd=str(base_dir),
            check=True,
        )
        print(f"git commit 完了: {message}")
    except FileNotFoundError:
        print("git コマンドが見つかりません。コミットは実行されませんでした。")
    except subprocess.CalledProcessError as e:
        print(f"git commit に失敗しました: {e}")


def _resolve_markdown_path(docs_dir: Path, raw_path: str) -> Optional[Path]:
    if not raw_path:
        return None

    rel = unquote(raw_path).strip().lstrip("/")
    if not rel.lower().endswith(".md"):
        return None

    target = (docs_dir / rel).resolve()
    try:
        target.relative_to(docs_dir.resolve())
    except ValueError:
        return None
    return target


def _guess_extension(content_type: str) -> str:
    ext = mimetypes.guess_extension(content_type or "") or ".png"
    if ext == ".jpe":
        return ".jpg"
    return ext


def _parse_multipart_form_data(content_type: str, body: bytes) -> dict:
    """
    `multipart/form-data` の最小実装パーサ。
    返却形式:
    {
      "fields": {"path": "..."},
      "files": {"file": {"filename": "...", "content_type": "...", "data": b"..."}}
    }
    """
    match = re.search(r'boundary="?([^";]+)"?', content_type or "")
    if not match:
        return {"fields": {}, "files": {}}

    boundary = match.group(1).encode("utf-8")
    delimiter = b"--" + boundary
    fields: Dict[str, str] = {}
    files: Dict[str, dict] = {}

    for raw_part in body.split(delimiter):
        part = raw_part.strip()
        if not part or part == b"--":
            continue

        if b"\r\n\r\n" not in part:
            continue

        header_block, data_block = part.split(b"\r\n\r\n", 1)
        data = data_block.rstrip(b"\r\n")

        headers: Dict[str, str] = {}
        for line in header_block.split(b"\r\n"):
            if b":" not in line:
                continue
            k, v = line.split(b":", 1)
            headers[k.decode("latin1").strip().lower()] = v.decode("latin1").strip()

        disposition = headers.get("content-disposition", "")
        name_match = re.search(r'name="([^"]+)"', disposition)
        if not name_match:
            continue
        field_name = name_match.group(1)

        filename_match = re.search(r'filename="([^"]*)"', disposition)
        if filename_match is not None:
            files[field_name] = {
                "filename": filename_match.group(1),
                "content_type": headers.get("content-type", "application/octet-stream"),
                "data": data,
            }
        else:
            fields[field_name] = data.decode("utf-8", errors="ignore")

    return {"fields": fields, "files": files}


def _build_handler(docs_dir: Path):
    def refresh_generated_artifacts() -> list:
        """
        Markdown 变更后，刷新依赖目录结构/内容的派生文件。
        失败时返回错误列表，不在这里抛异常，避免影响主流程可用性。
        """
        errors = []
        try:
            update_sidebar_timestamp(docs_dir)
        except Exception as e:  # pragma: no cover - defensive
            errors.append(f"timestamp update failed: {e}")
        try:
            generate_sidebar(docs_dir)
        except Exception as e:  # pragma: no cover - defensive
            errors.append(f"sidebar generation failed: {e}")
        try:
            build_local_search_index(docs_dir)
        except Exception as e:  # pragma: no cover - defensive
            errors.append(f"search index build failed: {e}")
        return errors

    class DocsHandler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(docs_dir), **kwargs)

        def end_headers(self) -> None:
            # Disable browser caching so normal reload (Ctrl+R) reflects latest docs.
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
            super().end_headers()

        def _send_json(self, code: int, payload: dict) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802
            parsed = urlparse(self.path)
            if parsed.path == "/__api/markdown":
                query = parse_qs(parsed.query)
                raw_path = (query.get("path") or [""])[0]
                md_path = _resolve_markdown_path(docs_dir, raw_path)
                if md_path is None:
                    self._send_json(400, {"ok": False, "error": "invalid path"})
                    return
                if not md_path.is_file():
                    self._send_json(404, {"ok": False, "error": "not found"})
                    return
                try:
                    content = md_path.read_text(encoding="utf-8")
                except OSError:
                    self._send_json(500, {"ok": False, "error": "failed to read file"})
                    return
                self._send_json(
                    200,
                    {
                        "ok": True,
                        "path": md_path.relative_to(docs_dir).as_posix(),
                        "content": content,
                    },
                )
                return
            super().do_GET()

        def do_POST(self) -> None:  # noqa: N802
            parsed = urlparse(self.path)

            if parsed.path == "/__api/save-markdown":
                content_length = int(self.headers.get("Content-Length", "0"))
                raw_body = self.rfile.read(content_length)
                try:
                    payload = json.loads(raw_body.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    self._send_json(400, {"ok": False, "error": "invalid json"})
                    return

                raw_path = str(payload.get("path", ""))
                content = payload.get("content")
                if not isinstance(content, str):
                    self._send_json(400, {"ok": False, "error": "content must be string"})
                    return

                md_path = _resolve_markdown_path(docs_dir, raw_path)
                if md_path is None:
                    self._send_json(400, {"ok": False, "error": "invalid path"})
                    return

                try:
                    md_path.parent.mkdir(parents=True, exist_ok=True)
                except OSError:
                    self._send_json(500, {"ok": False, "error": "failed to prepare directory"})
                    return

                try:
                    md_path.write_text(content, encoding="utf-8")
                except OSError:
                    self._send_json(500, {"ok": False, "error": "failed to save file"})
                    return

                refresh_errors = refresh_generated_artifacts()
                self._send_json(
                    200,
                    {
                        "ok": True,
                        "path": md_path.relative_to(docs_dir).as_posix(),
                        "refreshed": len(refresh_errors) == 0,
                        "refresh_errors": refresh_errors,
                    },
                )
                return

            if parsed.path == "/__api/delete-markdown":
                content_length = int(self.headers.get("Content-Length", "0"))
                raw_body = self.rfile.read(content_length)
                try:
                    payload = json.loads(raw_body.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    self._send_json(400, {"ok": False, "error": "invalid json"})
                    return

                raw_path = str(payload.get("path", ""))
                md_path = _resolve_markdown_path(docs_dir, raw_path)
                if md_path is None:
                    self._send_json(400, {"ok": False, "error": "invalid path"})
                    return

                if not md_path.exists() or not md_path.is_file():
                    self._send_json(404, {"ok": False, "error": "not found"})
                    return

                try:
                    md_path.unlink()
                except OSError:
                    self._send_json(500, {"ok": False, "error": "failed to delete file"})
                    return

                refresh_errors = refresh_generated_artifacts()
                self._send_json(
                    200,
                    {
                        "ok": True,
                        "path": md_path.relative_to(docs_dir).as_posix(),
                        "refreshed": len(refresh_errors) == 0,
                        "refresh_errors": refresh_errors,
                    },
                )
                return

            if parsed.path == "/__api/upload-image":
                content_type = self.headers.get("Content-Type", "")
                if "multipart/form-data" not in content_type:
                    self._send_json(400, {"ok": False, "error": "multipart required"})
                    return

                content_length = int(self.headers.get("Content-Length", "0"))
                raw_body = self.rfile.read(content_length)
                parsed_form = _parse_multipart_form_data(content_type, raw_body)
                raw_path = parsed_form["fields"].get("path", "")
                file_item = parsed_form["files"].get("file")
                md_path = _resolve_markdown_path(docs_dir, raw_path)
                if md_path is None or not md_path.exists():
                    self._send_json(400, {"ok": False, "error": "invalid markdown path"})
                    return
                if file_item is None or not file_item.get("data"):
                    self._send_json(400, {"ok": False, "error": "file is required"})
                    return

                ext = _guess_extension(file_item.get("content_type", ""))
                asset_dir = md_path.parent / f"{md_path.stem}_assets"
                asset_dir.mkdir(parents=True, exist_ok=True)

                stamp = datetime.now().strftime("%Y-%m-%d-%H-%M-%S")
                index = 0
                while True:
                    suffix = f"-{index:02d}" if index else ""
                    file_name = f"{stamp}{suffix}{ext}"
                    dest = asset_dir / file_name
                    if not dest.exists():
                        break
                    index += 1

                try:
                    with dest.open("wb") as out:
                        out.write(file_item["data"])
                except OSError:
                    self._send_json(500, {"ok": False, "error": "failed to write image"})
                    return

                rel_md_path = dest.relative_to(md_path.parent).as_posix()
                self._send_json(
                    200,
                    {
                        "ok": True,
                        "path": rel_md_path,
                        "markdown": f"![image]({rel_md_path})",
                    },
                )
                return

            self._send_json(404, {"ok": False, "error": "not found"})

    return DocsHandler


def start_docsify_server(docs_dir: Path) -> None:
    """
    docs_dir を配信する HTTP サーバを起動する。
    Docsify の静的配信に加えて、Markdown 編集 API を提供する。
    """
    candidate_ports = [3000, 3001, 5173, 8000]
    host = "127.0.0.1"
    handler_cls = _build_handler(docs_dir)
    last_error: Optional[Exception] = None

    for port in candidate_ports:
        try:
            print(f"Docs サーバを起動します: http://localhost:{port}/ （Ctrl+C で停止）")
            with ThreadingHTTPServer((host, port), handler_cls) as httpd:
                httpd.serve_forever()
            return
        except PermissionError as e:
            last_error = e
            print(f"ポート {port} へのバインドが拒否されました: {e}")
            continue
        except OSError as e:
            last_error = e
            if e.errno in (errno.EADDRINUSE, 10048):
                print(f"ポート {port} は使用中です。次のポートを試します。")
                continue
            raise

    raise RuntimeError(
        "利用可能なポートが見つかりませんでした。"
        f" 最後のエラー: {last_error}"
    )


def main(argv: Optional[list] = None) -> None:
    if argv is None:
        argv = sys.argv[1:]

    serve = "--no-serve" not in argv
    clean_assets_flag = ("--clean-assets" in argv) or ("--clean" in argv)
    commit_flag = ("--commit" in argv) or ("--submit" in argv)

    base_dir = Path(__file__).resolve().parent
    docs_dir = resolve_docs_dir(argv, base_dir)
    repo_dir = base_dir.parent

    # 手順書配下のディレクトリに README.md を自動生成
    ensure_readme_for_directories(docs_dir)

    # Docsify 検索の namespace を毎回更新して、検索キャッシュを実質リセット
    bump_search_namespace(docs_dir)

    # サイドバーの最終更新日時を更新
    update_sidebar_timestamp(docs_dir)

    # 各 Markdown ごとに画像を `<basename>_assets/` へ整理（常に実行）
    print("Markdown ごとの画像整理を実行します (--normalize-assets: default)...")
    normalize_assets_per_doc(docs_dir)

    if clean_assets_flag:
        clean_unused_assets(docs_dir)

    # ディレクトリ構成とタイトル設定から常に _sidebar.md を再生成する
    sidebar_path = generate_sidebar(docs_dir)
    print(f"_sidebar.md を生成しました: {sidebar_path}")

    # ローカル検索インデックスを生成
    build_local_search_index(docs_dir)

    if commit_flag:
        git_commit_all(repo_dir)

    if serve:
        start_docsify_server(docs_dir)
    else:
        print("サーバ起動は行いません (--no-serve 指定)。")


if __name__ == "__main__":
    main()
