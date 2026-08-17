# Docsify ドキュメントサイト - デプロイと使用方法

このリポジトリは、`docs` ディレクトリ配下の Markdown ファイルを Docsify で表示するためのドキュメントサイトです。  
`bin/app.py` スクリプトにより、サイドバーの自動生成・画像整理・Git コミットまで一括で行えます。

![](assets/2025-11-28-10-22-57.png)

---

## 目次

- [前提環境](#前提環境)
- [初回セットアップ（デプロイ）](#初回セットアップデプロイ)
- [基本的な使用方法](#基本的な使用方法)
- [app.py の機能詳細](#apppy-の機能詳細)
- [よく使うコマンド例](#よく使うコマンド例)
- [トラブルシューティング](#トラブルシューティング)

---

## 前提環境

以下の環境が必要です：

- **Python 3.x**（必須）
- **Node.js / npm**（推奨：Docsify CLI を使用する場合）
- **Git**（`--commit` オプションを使用する場合のみ）

> **注意**: Node.js がなくても、Python の簡易 HTTP サーバで起動できます。

---

## 初回セットアップ（デプロイ）

### 1. リポジトリのクローンまたはダウンロード

```bash
# 既にリポジトリがある場合はスキップ
cd chishiki
```

### 2. ディレクトリ構造の確認

以下の構造になっていることを確認してください：

```
DOC/
├── tools/              # プログラム
│   └── app.py          # メインスクリプト
├── docs/               # Docsify サイトのルート
│   ├── index.html      # Docsify 設定ファイル
│   ├── README.md       # ホームページ
│   ├── _sidebar.md     # サイドバー（自動生成）
│   ├── assets/         # 画像ファイル
│   └── ...             # その他の Markdown ファイル
└── README.md           # このファイル
```

### 3. 初回起動

```bash
python bin/app.py
```

初回実行時、`bin/app.py` は以下を自動実行します：

- `docs` 配下の Markdown ファイルを走査
- `_sidebar.md` を自動生成
- 各 Markdown ファイルの画像を `<basename>_assets/` に整理
- 検索インデックスを生成
- Docsify サーバを起動

### 4. ブラウザでアクセス

起動後、以下の URL でアクセスできます：

- **http://localhost:3000/**

---

## 基本的な使用方法

### 日常的な起動

ドキュメントを編集・追加した後、以下のコマンドでサイトを起動します：

```bash
python bin/app.py
```

このコマンドで以下が自動実行されます：

1. サイドバー（`_sidebar.md`）の再生成
2. 画像の整理（各 Markdown ごとに `<basename>_assets/` に配置）
3. 検索インデックスの更新
4. Docsify サーバの起動

> **補足**: ドキュメントディレクトリは既定で `docs/` を使用します。  
> 必要に応じて `--docs-dir` で指定できます（例: `python bin/app.py --docs-dir ./docs`）。

### ドキュメントの追加方法

1. `docs` 配下に Markdown ファイル（`.md`）を追加
2. ファイルの先頭に見出し（`# タイトル`）を記述
3. `python bin/app.py` を実行

サイドバーには、ディレクトリ構造に基づいて自動的に追加されます。

### 画像の追加方法

1. 画像ファイルを `docs/assets/` または各 Markdown と同じディレクトリに配置
2. Markdown 内で `![](assets/画像名.png)` のように記述
3. `python bin/app.py` を実行すると、画像が自動的に `<basename>_assets/` に整理されます

---

## `app.py` の機能詳細

### 自動実行される機能

`bin/app.py` を実行すると、常に以下が実行されます：

- **サイドバー生成**: `docs` 配下の Markdown から `_sidebar.md` を自動生成
- **画像整理**: 各 Markdown ファイルの画像を `<basename>_assets/` に整理
- **検索インデックス生成**: ローカル検索用のインデックスを更新
- **検索キャッシュリセット**: 検索結果のキャッシュをリセット

### オプション機能

#### 1. `--no-serve`: サーバを起動しない

サイドバーの生成のみを行い、サーバは起動しません。

```bash
python bin/app.py --no-serve
```

**用途**: コミット前にサイドバーだけ更新したい場合

---

#### 2. `--clean-assets` / `--clean`: 未使用画像の削除

`docs` 配下のすべての Markdown を走査し、参照されていない `assets/` 配下の画像を削除します。

```bash
# 未使用画像を削除してからサーバ起動
python bin/app.py --clean-assets

# 未使用画像を削除するだけ（サーバは起動しない）
python bin/app.py --clean-assets --no-serve
```

**判定方法**:
- Markdown 内の `![](assets/xxx.png)` などの画像記法を解析
- `assets/` 以下に存在するが、どの Markdown からも参照されていないファイルを削除
- HTTP(S) URL の画像は対象外

---

#### 3. `--commit` / `--submit`: Git コミット

処理完了後、カレントリポジトリ全体を Git にコミットします。

```bash
# サイドバー更新＋コミット（サーバは起動しない）
python bin/app.py --no-serve --commit

# 画像整理＋サイドバー更新＋コミット
python bin/app.py --clean-assets --no-serve --commit
```

**コミット内容**:
- `git add -A`
- `git commit --allow-empty -m "<timestamp>"`  
  （`<timestamp>` は `YYYYMMDD-HHMMSS` 形式）

**前提条件**: このディレクトリが Git 管理下であること

---

## よく使うコマンド例

| 用途 | コマンド |
|------|----------|
| **通常起動** | `python bin/app.py` |
| **サイドバー更新のみ** | `python bin/app.py --no-serve` |
| **未使用画像削除＋起動** | `python bin/app.py --clean-assets` |
| **未使用画像削除のみ** | `python bin/app.py --clean-assets --no-serve` |
| **更新＋コミット** | `python bin/app.py --no-serve --commit` |
| **画像整理＋更新＋コミット** | `python bin/app.py --clean-assets --no-serve --commit` |

> **注意**: オプションは順不同で指定できます（例：`python bin/app.py --commit --clean-assets --no-serve`）

---

## トラブルシューティング

### `npx: command not found` エラー

**原因**: Node.js / npm がインストールされていない、または PATH に含まれていない

**解決方法**:
```bash
# Node.js をインストール（例：Ubuntu/Debian）
sudo apt update
sudo apt install nodejs npm

# または、Docsify CLI をグローバルにインストール
npm install -g docsify-cli
```

> **注意**: Node.js がなくても、Python の簡易 HTTP サーバで起動できるため、このエラーは無視しても問題ありません。

---

### Git コミットでエラーが出る

**原因**: 
- このディレクトリが Git 管理下にない
- `git` コマンドが PATH にない

**解決方法**:
```bash
# Git リポジトリとして初期化（初回のみ）
git init

# Git がインストールされているか確認
which git
```

---

### サイドバーが更新されない

**原因**: `_sidebar.md` が手動で編集されている可能性

**解決方法**: `_sidebar.md` は自動生成されるため、手動で編集しないでください。  
`python bin/app.py` を実行すると、常に最新の状態に更新されます。

---

### 画像が表示されない

**原因**: 画像パスが正しくない、または画像ファイルが存在しない

**解決方法**:
1. Markdown 内の画像パスを確認（`![](assets/xxx.png)` など）
2. `python bin/app.py` を実行して画像を整理
3. ブラウザの開発者ツールで画像の読み込みエラーを確認

---

### 検索が機能しない

**原因**: 検索インデックスが生成されていない

**解決方法**: `python bin/app.py` を実行すると、検索インデックスが自動生成されます。  
`bin/build_search_index.py` が存在することを確認してください。

---

## 補足情報

### ディレクトリ構造について

- **`docs/`**: Docsify サイトのルートディレクトリ
- **`docs/_sidebar.md`**: サイドバー（自動生成、手動編集不可）
- **`docs/assets/`**: 共有画像ファイル
- **`<basename>_assets/`**: 各 Markdown ファイル専用の画像ディレクトリ（自動生成）

### 画像の整理について

`bin/app.py` は各 Markdown ファイルの画像を以下のように整理します：

- 元の画像: `docs/assets/画像.png`
- 整理後: `docs/個人メモ/基本情報_assets/画像.png`（Markdown が `基本情報.md` の場合）

これにより、各ドキュメントの画像が独立して管理されます。

---

この `README.md` と `bin/app.py` により、ドキュメントの編集から整理、コミットまでをワンコマンドで実行できます。
