# Python 標準ライブラリメモ

## http.server

`ThreadingHTTPServer` で並列処理。ハンドラは `SimpleHTTPRequestHandler` を継承して `do_GET`/`do_POST` をオーバーライド。

```python
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")
```

## pathlib

- `rglob("*.md")` 再帰検索
- `Path.read_text(encoding="utf-8")` 読み書き
- `os.replace()` 原子性のあるリネーム（tmp 書き込み→replace が定石）

?> `datetime.now().strftime("%Y-%m-%d-%H-%M-%S")` はファイル名に安全な形式。

## 正規表現の落とし穴

- `re.match` は先頭一致のみ。全検索は `re.search`
- 文字クラス内の `-` は位置に注意 `[a-z-]`
- Unicode の範囲 `[一-龥]` は CJK 統合漢字（基本部分のみ）
