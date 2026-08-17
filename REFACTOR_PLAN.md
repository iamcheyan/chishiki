# chishiki v2 重构方案

> 2026-08-17 · 基于 master@3e4c6aa 实读代码（app.py 887L / build_search_index.py 148L）。
> 原则：功能对等优先、纯标准库后端、零构建静态前端、自绘控件、深浅双主题、双端验收。

## 0. 一句话定位

个人知识库 = **目录树浏览 + Markdown 阅读/编辑 + 截图直贴 + 全文搜索**，本地单用户，零依赖可跑。

## 1. 原版功能对等清单（不可丢）

| # | 原版行为（app.py 实测） | v2 实现 |
|---|---|---|
| 1 | 目录树→`_sidebar.md`，标题取首个 `#`，无则文件名 | 前端 `/api/tree` 实时渲染侧栏（服务端仍生成 sidebar 作兼容产物，v2.1 移除） |
| 2 | md 读取/保存/删除 API | `/api/doc*`（路径穿越防护保留，写限 .md） |
| 4 | 图片上传→`<stem>_assets/` + 时间戳命名 + 返回 md 片段 | 同逻辑保留，接口改名 `/api/image` |
| 5 | 启动时把各 md 引用的图片归拢到 `<stem>_assets/` 并改写路径 | 保留 `--normalize-assets`（默认开） |
| 6 | `--clean-assets` 删未引用图 | 保留 |
| 7 | 全文搜索索引（标题/正文/章节锚点） | 重做（§4） |
| 8 | 搜索缓存穿透（namespace bump） | 随搜索重做消亡，不再需要 |
| 9 | `--commit` git add -A + 时间戳提交 | 保留，另加保存时可选自动 commit（默认关） |
| 10 | 端口回落 3000/3001/5173/8000 | 保留 + `--port/--host` 显式参数（默认 127.0.0.1） |
| 11 | 手順書子目录无 md 时自动生成 README 索引 | 保留（启动时） |
| 12 | 侧栏 Last updated 时间戳 | 保留（挪进 /api/meta，前端渲染） |

**放弃项**（明确）：Docsify 运行时及其 CDN 依赖、docsify 搜索插件、namespace hack。

## 2. 新增能力（本次重点）

### 2.1 Markdown 编辑器重做
- **CodeMirror 5 vendored**（`codemirror.min.js` + markdown mode，约 350KB，MIT，提交进仓；不用 CDN，离线可用）。CM6 需构建链，列为 v3 升级项。
- 三态视图：编辑 / 分屏（默认，同步滚动）/ 预览；`Ctrl/Cmd+S` 保存，脏标记红点，Esc 退预览。
- 工具栏：H1-H3、粗斜、列表、引用、行内/块代码、链接、图片（隐藏 file input + 样式按钮，合规）、表格。全部作用于选区。
- **草稿**：编辑中每 5s 存 localStorage（按文件路径键），保存成功即清；重开提示恢复草稿（自绘对话框，非 confirm）。
- 状态栏：字数 / 行数 / mtime / 保存状态。
- 日文 IME 安全：CM5 成熟；实测 composition 不断字。
- 新建/重命名/删除：自绘 prompt/confirm（见 §5 控件）。

### 2.2 截图直贴（核心新功能）
- 编辑器 `paste` 事件 → `clipboardData.items` 里的 `image/*` blob → 直接 POST `/api/image` → 在**光标处**插入 `![image](<stem>_assets/2026-08-17-10-30-00.png)`。
- 拖拽图片文件到编辑器 = 同链路。
- 上传中光标处先插占位 `![uploading…]`，完成替换为真链接；失败红 toast（自绘），占位转删除。
- 预览区即时可见（把相对 src 重写到 `/files/<doc目录>/<src>`）。
- 文件名时间戳冲突递增 `-01`（原版逻辑保留）。

### 2.3 搜索重做
- **索引 v2**（Python 生成 `search-index.json`）：`[{path, title, mtime, sections:[{title,slug,level}], text}]`——text 为平文化全文（保留原 strip_markdown 思路）。
- **查询**：CJK 连续段做 2-gram 拆词，拉丁按词；全部 term 命中才进结果（AND）。
- **打分**：标题命中×5 > 章节标题×3 > 正文×1；词频加成；mtime 七日内 +0.5 微调。
- **UI**：`Ctrl/Cmd+K` 呼出居中遮罩（移动端全屏 sheet）；输入即搜（120ms 防抖）；结果按文档分组，每条=文档名 > 章节锚点 + 命中摘录（`<mark>` 高亮）；↑↓ 选择、Enter 跳转（文档+锚点）、Esc 关闭；空态一句话。
- 性能预算：2k 篇/3MB 文本，单次全扫 < 50ms（纯前端 JS，无倒排必要）；超 5MB 再引入 bigram 倒排（预留接口）。

## 3. 架构

```
chishiki/
├── bin/app.py              # 服务器+API（保留改造）
├── bin/build_search_index.py  # → 产 search-index.json（v2 格式）
├── web/                    # 前端（全新，零构建静态文件）
│   ├── index.html
│   ├── app.css
│   └── js/{app,tree,editor,preview,search,paste,ui}.js
│       └── vendor/{codemirror.min.js, markdown.js, marked.min.js}
├── docs/                   # 内容（不动，gitignore 可选）
└── run.sh                  # python3 bin/app.py "$@"
```

### API v2（全部 JSON；旧 /__api/* 保留一个版本期作兼容）

| 端点 | 说明 |
|---|---|
| GET `/api/tree` | md 树：路径/标题/mtime |
| GET `/api/doc?path=` | 读原文 |
| POST `/api/doc/save` | 原子写（tmp+rename，原版直写是隐患）+ 重建索引 |
| POST `/api/doc/create` / `rename` / `delete` | 目录内 .md 操作 |
| POST `/api/image` | multipart → `<stem>_assets/`，返回 `{path, markdown}` |
| GET `/api/search-index` | JSON 索引（ETag=mtime） |
| GET `/api/meta` | lastBuild/文档数 |
| GET `/files/*` | docs 原文件直出（预览图片用） |

防护：路径穿越校验保留并加测试；写 API 限 .md；body 上限 25MB；默认绑定 127.0.0.1。

## 4. UI 设计（引用 skill：japanese-editorial-reader-ui + custom-drawn-web-controls）

**表面定性：Reader + Library 混合——左侧书架（目录树），右侧连续文档。编辑态是临时侵入层，不是常驻 chrome。**

- Token（纸与墨）：亮 `#F7F3EA / #282521 / #8D867C`，暗 `#141414 / #D8D2C8 / #858078`；单一低饱和靛蓝 accent；细分隔线 `rgba(ink,.12)`；圆角小（4-8px）；无卡片墙——层级靠字号字重+留白，激活项用下划线（用户口味铁律）。
- 字体：正文日文系统衬线栈（Hiragino Mincho/Noto Serif CJK JP），UI 控件 sans。不引 webfont。
- **桌面 ≥1024**：三栏=侧栏 280px（树+搜索入口+Last updated）｜阅读列 max 720px｜右缘 180px 大纲（当前文档标题导航，可收）。编辑态：阅读列裂成 编辑|预览 分屏。
- **移动 390×844**：单列阅读；侧栏变抽屉（左缘滑出+遮罩）；⌘K 搜索变全屏；编辑器全屏+顶栏（返回/保存/视图切换）；底部安全区 padding。
- **控件全部自绘**（ypop 模式，复用 yomu 验证过的实现思路）：删除确认=居中卡片对话框；新建/重命名=自绘 prompt；主题切换=自绘下拉；toast=底部浮层。**零原生 alert/confirm/prompt/select**。
- 空态：无文档=一句引导+新建按钮；搜索空=一句话。

## 5. 阶段划分（每阶段=1 个可验收 goal）

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 清理 | 删 bin/3、docs/README.md 占位、写 .gitignore、README 重写 | 仓干净 |
| P1 后端 | API v2 + 原子写 + tree/meta + 旧 API 兼容 + `--selftest`（路径穿越/边界单测） | selftest 全绿 + curl 全通 |
| P2 前端壳 | 布局/token/主题/侧栏树/文档阅读（marked 渲染+图片路径重写）/移动抽屉 | 双端截图+console 0 错 |
| P3 编辑器 | CM5 集成/分屏/工具栏/草稿/保存流/新建·重命名·删除（自绘对话框） | 旧 docs 目录实测编辑回写 |
| P4 贴图 | paste+dragdrop 全链路/占位替换/toast | CDP 合成 ClipboardEvent 实测+手机实测 |
| P5 搜索 | 索引 v2+⌘K UI+高亮跳转 | 2-gram 日文查询命中+<100ms |
| P6 打磨 | 无障碍焦点/键盘地图/暗色全量走查/性能/验收报告 | 390/768/1280/1920×双主题全过 |

**总验收（放行标准）**：①对等清单 12 条逐条过 ②截图直贴→保存→重开可见 ≤2s ③搜索跳转锚点准 ④双端双主题 console 0 错 ⑤原生控件扫描 0 命中 ⑥`py_compile`+`node --check`+selftest 全绿。

## 6. 风险与对策

- **CM5 体积/停维**：vendored 350KB 可接受；IME 成熟度 > 新潮；v3 再评估 CM6。
- **索引随保存全量重建**：个人规模（<2k 篇）<1s，接受；预留增量接口。
- **已有文档的 Docsify 专属语法**（`?:` 提示容器等）：marked 渲染降级为普通引用，不报错；不迁移内容。
- **粘贴非图片**（Excel/富文本）：只取 `image/*`，文本粘贴走 CM 默认，互不干扰。
- **并发写**：单用户本地场景 + 原子写兜底；多标签页草稿键按 path 隔离。

## 7. 待确认（开工前问一次）

1. 82 机部署吗？是则占端口 **8850**（工具舰队顺延），默认回落链保留。
2. `docs/` 内容要不要进 git（原版 --commit 会提交内容）？默认：工具仓不含内容，内容目录 `--docs-dir` 指向，`.gitignore docs/`。
3. 编辑器字体字号有无个人偏好（默认 15px/1.9 行高衬线）。
