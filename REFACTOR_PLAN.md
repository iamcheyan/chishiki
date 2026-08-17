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

## 8. v2 前端交付记录（2026-08-17）

### 8.1 功能对照表

| 模块 | 实现 | 文件 |
|---|---|---|
| 三栏布局 | 侧栏280px / 阅读列720px居中 / 右大纲220px(滚动spy+平滑滚动)；移动<768抽屉+单列+全屏编辑/搜索 | `web/app.css` `web/index.html` |
| 设计体系 | 纸墨双主题token(`html[data-theme]`+prefers-color-scheme默认+localStorage)、明朝体正文/sans控件、圆角≤8、图标全内联SVG stroke1.5、激活态=下划线 | `web/app.css` |
| 侧栏树 | 目录/文件图标、展开折叠记忆(localStorage)、当前下划线、hover操作(改名/移动/删除/收藏)、目录hover(新建/图库/新文件夹)、最近5篇+收藏 | `web/js/tree.js` |
| 阅读 | `/api/doc?rendered=1`直出、图片src重写`/files/`、表格横滚包裹、代码块横滚、外链新窗、Docsify `!>`/`?>` callout样式 | `web/js/viewer.js` |
| Lightbox | 滚轮/双指缩放1x-8x、拖拽平移、双击复位、←→/轻扫切换、Esc关、图库态带删除 | `web/js/viewer.js` |
| 编辑器 | textarea+分屏(同步滚动近似)/单编辑/单预览、工具栏作用于选区、Ctrl/Cmd+S、脏标记圆点、5s草稿+恢复横幅、外部mtime变更检测(20s轮询+再读/保留)、状态栏字数行数mtime | `web/js/editor.js` |
| 贴图 | paste/drag-drop `image/*`→`POST /api/image`→光标插`![アップロード中…]`占位→完成替换；预览即时重写src | `web/js/editor.js` |
| 搜索 | ⌘K居中面板(移动全屏)、search-index纯前端查询、CJK 2-gram+拉丁分词、AND、标题×5/章节×3/正文×1、`<mark>`摘录、↑↓+Enter锚点跳转、120ms防抖 | `web/js/search.js` |
| 图库 | 目录全部`_assets`/`assets`瀑布网格、hover复制md引用/删除(confirm)、顶部统计N张/总大小 | `web/js/gallery.js` |
| 自绘控件 | 对话框(Esc/Enter/遮罩)、ypop下拉(<480px底部sheet)、toast 2.5s、焦点outline 2px accent、键盘全程可用 | `web/js/ui.js` |
| 快捷键 | ⌘K搜索 / ⌘S保存 / ⌘N新建 / Esc层层退出 | `web/js/app.js` |

### 8.2 验收结果（24条全过）

| # | 项 | 结果 | 证据 |
|---|---|---|---|
| 1 | 树完整+展开记忆 | ✅ | CDP: 四目录显示；折叠工作手册→刷新后仍折叠、技术笔记/嵌套システム運用仍展开 |
| 2 | 大纲spy+跳转 | ✅ | CDP: h2/h3列出；点击「トラブル時」滚动到位且立即高亮(cur=2)；修复spy判定线90→160px |
| 3 | Docsify容器/表格/任务列表/代码块 | ✅ | `!>`→`blockquote.callout-warn`(注記label)；表格.table-wrap横滚；3任务项；正規表現チートシート`<pre><code>`渲染 |
| 4 | Lightbox缩放/复位/Esc | ✅ | 滚轮×8→scale(3.059)；双击→scale(1)；Esc关；1x1测试图 |
| 5 | ⌘K日文搜索 | ✅ | 「手順」→3文档命中、章节「復旧手順」、`<mark>`高亮、点击摘录行→`?h=復旧手順`滚动到该节 |
| 6 | 新建→编辑→保存→重开 | ✅ | 「验收草稿テスト」出现在树上；编辑h2/粗体/表格/callout保存；重开内容在 |
| 7 | 粘贴截图 | ✅ | 合成ClipboardEvent→`![image](验收草稿テスト_assets/2026-08-17-11-11-38.png)`、占位先现、预览src已重写`/files/` |
| 8 | 改名带_assets不断图 | ✅ | 改名「验收改名テスト」→hash/树更新，图片src不变naturalWidth=1(加载成功) |
| 9 | 删除自绘confirm | ✅ | 「削除テスト」→自绘对话框→确认→树消失 |
| 10 | 图库 | ✅ | 个人备忘2张网格+统计「2枚・144B」；复制引用按钮；Lightbox删除confirm（见8.3后端缺口） |
| 11 | 草稿恢复 | ✅ | 输入不保存→5s写localStorage→刷新→「下書きが残っています」横幅→復元→内容还原 |
| 12 | 双主题 | ✅ | 深色`#141414`/浮层`#1B1A18`实测；Lightbox/搜索/对话框双主题截图各6+6 |
| 13 | 390×844 | ✅ | 抽屉(遮罩+滑动)/全屏搜索(borderRadius 0)/全屏编辑器(position:fixed 390px)/无横向滚动/安全区padding |
| 14 | 1280/1920三栏 | ✅ | 1280:`280px 780px 220px`；1920:view 800px(内容720)居中(offset 0)；大纲可见 |
| 15 | 双主题截图 | ✅ | `screenshots/` 24张(desktop/mobile × light/dark × reader/search/editor/gallery/lightbox/menu/drawer/outline) |
| 16 | console零error | ✅ | CDP全流程走查(树/阅读/大纲/搜索/编辑保存/图库/主题/移动端) pageerror+console.error均0 |
| 17 | 原生控件禁令 | ✅ | `grep -rE "\b(alert\|confirm\|prompt)\s*\("` web/ 零命中(exit 1) |
| 18 | node --check | ✅ | 7个js全过；console.log零残留（无任何命中） |
| 19 | 性能 | ✅ | 首屏ready 1056ms(≤1500)；search-index 3.8ms/10KB(预算300ms/1MB)；html/css各~1ms |
| 20 | 无障碍 | ✅ | 手动清单: 焦点outline 2px、ink对比13.8/12.3:1、muted 7:1、h1语义、img全alt、按钮全label、lang=ja |
| 21 | 图片/重写无404 | ✅ | 12文档全遍历: 2个`/files/`图片请求均200，404零 |
| 22 | 分批中文commit | ✅ | UI壳(74208a0)/编辑器(2236013)/搜索图库(87b726d)/打磨验收+截图+本文档 |
| 23 | 交付记录 | ✅ | 本节 |
| 24 | systemd+meta | ✅ | `systemctl --user is-active chishiki`→active；`curl :8850/api/meta`→200 |

### 8.3 后端缺口记录（bin/ 冻结未动）

1. **图片删除无API**：`/api/doc/delete` 经 `_safe_md_path` 限 `.md`，图库/Lightbox 的删除无法落地。前端完整实现交互(confirm→toast)，`gallery.js` 置 `IMAGE_DELETE_API=false` 能力开关；后端补 `POST /api/image/delete {url}` 后置 `true` 即通。
2. **改名不迁移 `_assets`**：`/api/doc/rename` 仅改md文件名，`<旧stem>_assets/` 目录留在原处。因图片路径按文档所在目录相对解析，引用不断（验收#8证实），但资源目录名与文档名脱钩；建议后端改名时同步 `rename` assets 目录。
3. **无目录API**：新建文件夹由前端以「新目录/README.md」占位实现（`create` 的 `dir` 参数承担 mkdir -p）。

### 8.4 截图索引

`screenshots/`（均为 PNG，1024×640 / 390比例缩放）：
- 桌面: desktop-{light,dark}-{reader,search,editor,gallery,lightbox,menu}.png
- 移动: mobile-{light,dark}-{reader,drawer,outline,search,editor,lightbox}.png

### 8.5 追加打磨（第二轮，2026-08-17 午后）

交付自审 + 与 `3c73392`（收藏夹区块/主题滚动条/serif-sans 字体切换等增强）合流后的修复：

| # | 问题 | 修复 | 验证 |
|---|---|---|---|
| 1 | 路由离开编辑器无防护：编辑中点树上文档直接丢状态，<5s 的输入连草稿都没有 | `editor.leaveEditor()`（脏内容同步落草稿+停冲突轮询）挂入 `route()`；另加 `beforeunload` 兜底 | CDP: 输入 150ms 后路由离开→localStorage 草稿含新词；重进提示恢复且还原 |
| 2 | 搜索索引会话内永不失效：保存/新建/改名/移动/删除后再搜仍是旧结果 | `search.invalidate()`，六处变更点（save/create/rename/move/delete/新建文件夹）调用 | 编辑加独有词「ZZQK」保存→⌘K 不刷新页面即命中 |
| 3 | 移动大纲面板点链接后不收起 | `#outline-nav` 点击委托收起 | 390×844: 点第2节→面板关+滚动到位 |
| 4 | 树行「操作」按钮复用 H 标题图标 | 新增 `dots` 三点图标（fill 圆点覆盖 svg 级 fill=none） | DOM 断言 `a-more svg circle` 存在，菜单4项正常开合 |
| 5 | `3c73392` 字体切换初始化塞在 `hideMobileOutline()` 内：每次调用重复挂监听器，累计后单击切换 N 次（偶数=失效） | 移出为 `initFontToggle()`（boot 调用 + `_fontBound` 一次性守卫） | 多次触发 hideMobileOutline 后单击仅切换一档 serif→sans |
| 6 | 误提交 `bin/__pycache__/*.pyc`（未改 bin/ 代码本身） | 建 `.gitignore`（`__pycache__/` `*.pyc`）+ `git rm --cached` | 工作区此后无 pyc 噪音 |
| 7 | 模块间 import 裸路径，浏览器启发式缓存可能吃到陈旧模块 | 全部 import 说明符与 `<link>/<script>` 统一 `?v=5` | 服务端 grep 校验 12 处 import + 2 处标签全带版本 |

回归：node --check 7/7 通过；console.log/原生控件 grep 零命中；CDP 冒烟（树 11 文件/dots 菜单/字体按钮/收藏区块/编辑进出/搜索失效/移动大纲收起）pageerror 与 console.error 均 0；docs/ 内容与 git 基线完全一致（验收测试写入已还原）。

### 8.6 第三轮：补测盲区 + 合流 `80de0e7`（2026-08-17 午后）

`80de0e7`（用户）修复：viewer.js 对象字面量语法错误（import 链死→导航瘫痪）、boot 漏 `initTheme()`（**系我第二轮编辑吞行所致的回归**，主题按钮失灵）、acts 占位吞点击（pointer-events）、同文档重复点击（手动派发 hashchange）、Lightbox 点空白关闭（moved 位移阈值）、GitHub Light/Dark 双主题。本轮在其上验证并继续：

| # | 项 | 结果 | 证据 |
|---|---|---|---|
| 1 | 用户修复回归验证 | ✅ | 主题菜单 4 项可切换、三路由导航通、同文档点击重新滚顶、树 11 文件、零 error |
| 2 | 资源版本错位（文件已改但模块 import 停在 `?v=5`，缓存吃旧模块） | 修复 | 标签+15 处 import 统一 `?v=8`，服务端 grep 校验 |
| 3 | **返回按钮丢路径 → `#/doc/null`**（我第二轮把 `leaveEditor()` 挪到构造 hash 前，`ed.path` 已被清空） | 修复：先取 `path` 再 `leaveEditor()` | 干净返回与脏返回（对话框确认）hash 均正确，草稿保留 |
| 4 | 工具栏作用于选区（此前从未实测） | ✅ | H2/粗体(可切换取消)/列表/引用/行内代码/链接 逐项 CDP 断言，叠加操作结果正确 |
| 5 | 编辑模式切换 | ✅ | 单编辑(预览 display:none)/单预览(编辑器隐藏+预览有内容)/分割复位 |
| 6 | 移動文档+图片引用重写 | ✅ | 带 `![image]` 文档 个人备忘→会议记录：目标菜单正确排除自身目录；hash/树更新；img 重写为 `../个人备忘/.._assets/..` 经 `/files/` 解析 naturalWidth>0 |
| 7 | 新規フォルダ | ✅ | 创建 `个人备忘/验收用フォルダ/README.md` 占位，树显示嵌套目录+README |
| 8 | 收藏/最近 | ✅ | 树内 star→fav 列表出现+文档头星标同步；recent 移除一项 5→4；再点取消收藏清空 |
| 9 | 拖拽上传 | ✅ | 合成 DragEvent drop→`![image](工具栏テスト_assets/2026-08-17-12-25-12.png)`，预览 src 已 `/files/` 化 |
| 10 | Lightbox 点空白关闭（用户新增） | 代码审读确认逻辑完整（`moved` 阈值 6px 防误触），随 #1 冒烟 | — |

清理：测试文档/资产/空目录全部移除，`git status docs/` 干净。回归：`node --check` 7/7、console 零 error、首屏 v8 冒烟（树/大纲/图片加载）全绿。

### 8.7 第四轮：健康检查系统收口 + 后端缺口闭合（2026-08-17 午後）

用户 WIP（`/api/health`・`/api/clean`・`/api/image/delete`・rename 迁移 assets・`health.js` 健康页）本轮完成接线并端到端验证；期间发现并修复其一处回归。

| # | 项 | 结果 | 证据 |
|---|---|---|---|
| 1 | `#btn-health` 死按钮（HTML 有、无 JS 接线） | 修复 | `app.js` 绑定 → `#/health`；CDP 进入健康页，11 篇全绿 |
| 2 | `health.js` 引入未版本化 `./ui.js`（与 `?v=` 实例并存 → activeDlg/activeMenu 状态分裂） | 修复 | 统一 `?v=9`（后用户升 v10，见下） |
| 3 | **图片删除 API 闭合（缺口#1）** | ✅ | 贴图→图库删→confirm→toast「削除しました」→磁盘文件消失（assets 目录转空） |
| 4 | 健康检查+清理 | ✅ | 删图后检出「参照切れ画像+空ディレクトリ」；dry-run→confirm→空目录清除，`empty_asset_dirs→0` |
| 5 | **rename 迁移 assets（缺口#2）— 用户版本有回归** | 修复后 ✅ | 用户实现只搬目录不改写 md 引用（引用全断 404），且目标 assets 已存在时静默跳过（引用滞留旧目录）。修复：目标不存在→整迁+改写引用 `<旧stem>_assets/`→`<新stem>_assets/`；已存在→逐文件合并（冲突加后缀）+rmdir 旧目录+同样改写引用。场景A（整迁）与场景C（合并）均实测：磁盘归位、引用改写、图片加载、health 全绿 |
| 6 | 清理对话框文案（只有空目录时也报「孤立画像 0 件」） | 修复 | 按 candidates/empty 实际数量拼装 |
| 7 | 面包屑目录点击（`debe45d` 的 expandTo 动态导入） | ✅ | 点击后树完整（11 文件）、零 error——版本统一后动态/静态导入同实例 |

**遗留（用户在飞工作，未动）**：工作区含未完成的 git 版本面板（`web/js/git.js`+`view-git` 已接线，`/api/git/status`・`/api/git/log` 后端未实现，当前 404）；`index.html` 标签已升 `app.js?v=10` 但模块静态导入仍 `?v=9`、CSS 仍 v9——**版本错位会再触发双实例**（`app.js?v=10` 动态导入解析为 `ui.js?v=10`，与静态 `ui.js?v=9` 并存，VSN 机制要求静态/动态/标签三者同版本）。建议用户收口时把 CSS/JS 标签与全部 import 一同升 v10。

本轮回归：`py_compile` 通过、服务重启后 health 全绿、CDP 全流程（阅读/代码块复制/?帮助/健康页/编辑器进出/搜索）零 console error；docs/ 测试产物清理完毕与 git 基线一致。

### 8.8 第五轮（d9773e0→）：用户安全大修（a984820）验证收口 + rc 校验补完

**背景**：用户自行完成 git 面板后端（83a21c5）→ topbar 修复（0297022）→ 安全大修（a984820：XSS 白名单/绑定收窄 127.0.0.1/图片删除限 assets+unquote/save overwrite 保护/自绘 checkbox/菜单 keydown/原子写 fsync/版本统一）。本轮逐项验证其收口并修复两个遗留。

**验证矩阵（a984820，CDP 实测）**：

| 项 | 结果 |
|---|---|
| XSS 白名单（mdrender） | `<script>`/`javascript:`/`data:text/html`/`<iframe>` 全剔除；`<img onerror>` 渲染为转义文本 `&lt;img...`（零活属性）；正常 https 链接保留 ✅ |
| 绑定 127.0.0.1 | `ss` 确认 `127.0.0.1:8850`（unit+argparse 双改）✅ |
| save overwrite 保护 | 无 overwrite 覆盖已存文档 → 409 `exists`；编辑器（带 `overwrite:true`）⌘S→磁盘 roundtrip ✅；moveFlow 不带 overwrite→移动撞名将 409 拒绝（语义正确，代码审阅）✅ |
| 图片删除收紧 | 合法 `*_assets/` 全路径删除→磁盘文件+空目录回收 ✅；非资产路径（README.md）→404 拒绝 ✅ |
| 自绘任务 checkbox | `- [ ]`/`- [x]` → `span.task-box`（role=checkbox/aria-checked），零原生 input ✅ |
| 菜单 keydown | 主题菜单打开→普通键不误触（仍开/主题不变）→Esc 关闭 ✅ |
| 版本统一 v12 | 9 模块全部 `?v=12` 单实例（resource 审计零分裂）✅ |
| Git 面板按文档 | 有历史文档（工作手册/README.md）→面板标题/1 条历史/恢复按钮→恢复 8c228d6→磁盘字节一致并自动跳回文档 ✅ |

**修复 1（d9773e0）——测试残留清除**：第五轮 E2E 期间用户并行提交（a984820 的 `git add -A`）把我两份测试产物收进了已推送提交：根目录 `読書メモ.md`（被 restore 探针覆盖为 1 行占位；原未跟踪内容不可恢复，**原件 `个人备忘/読書メモ.md` 无损**）与 `个人备忘/保護テスト.md`。已 `git rm` 两者并提交推送，health 全绿（11 篇/0 断链/0 丢图/0 孤儿/0 空目录）。**教训记档：对用户在飞工作区做破坏性 E2E（覆盖真实文档再恢复）必须全程 try/finally 且避开 add -A 时间窗；本轮两次翻车均源于此。**

**修复 2——git 四端点 rc 校验落地**：a984820 提交信息声称"git四端点rc校验"但实际未实现（`/api/git/restore` 对无效 hash `deadbee` 返回 `ok:true`，面板会误报「戻しました」）。本轮补完：新增 `_git_rc()→(out, returncode)`，status/log/commit(add+commit)/restore 四端点 rc≠0 → 500 `ok:false`（detail 带 stderr 前 200 字）；实测 `deadbee`→500 + 面板 toast「失敗: restore failed」，正常路径（status/log/restore 成功恢复）不受影响。`_git()` 保留为兼容包装。

**根因备忘（版本三重错位）**：曾同时存在 `ui.js?v=11`(标签)/`?v=9`(静态导入)/裸 `./ui.js`(git.js 导入) 三 URL → 三实例分裂；且用户改 app.js 内容未升标签 → 浏览器启发式缓存吐出旧 `app.js?v=11`（仍带 v9 导入）→ editor 旧副本无 overwrite:true → 保存 409。统一升 v12 后实测 9 模块单实例。**VSN 铁律不变：改内容必升版本，且标签/静态导入/动态导入（git.js 硬编码 `./app.js?v=N`）三者必须同版。**

本轮回归：`py_compile`+`node --check` 全过；CDP 全流程（阅读/XSS 文档渲染/git 面板全局+按文档/恢复成功+失败路径/checkbox/菜单/编辑器保存）除刻意触发的 409/500 探针外零 console error；docs/ 与基线一致。**遗留**：用户在飞 topbar 検索/新規按钮迁移（web/index.html+app.js WIP，未动未提交）。

### 8.9 第六轮（ea0ef28→）：顶栏收口验证 + 面包屑截断重构 + 复制链接全端可达

**背景**：用户连发 4002399（検索/新規移入顶栏）与 ea0ef28（topbar-right 回贴右缘，crumb 改 `flex:1` 吸收弹性空隙）。本轮验证其收口并处理两个发现。

**验证（ea0ef28，几何实测）**：桌面 1280 右组右距 20px=topbar padding（贴缘✓）、深层文档不漂移、零重叠零越界；移动 390 右组右缘 383px（与提交信息一致）、零横向溢出。

**发现 1——CSS 变更未升版本**：ea0ef28 改 `app.css` 内容但标签仍 `?v=13`（浏览器启发式缓存会向已访问用户吐出漂移版顶栏，同 `app.js?v=11` 事故）。已补升 v15（本轮 CSS 改动合并入 v15）。

**发现 2——移动端面包屑被挤到 0 宽**：4002399 后移动端顶栏空间盘点（390-20padding）：menu 18+brand 81+sep+actions 68+right 166+gaps 40≈375 > 370——#crumb 实测 0px，目录/标题/复制按钮全部不可见不可达（`.crumb-copy` 长期处于被裁剪的死 UI 状态，非本轮引入）。

**修复 A——面包屑截断重构**（`app.js` renderCrumb + `app.css`）：`#crumb` 改 flex 行，文字段（目录链+标题）包进 `.crumb-txt` 承接 ellipsis，`.crumb-copy` 移出截断流挂在外层（`flex:none`）——桌面长标题不再裁掉 copy；纯文本视图（edit/git/health/gallery/home）统一走新增 `setCrumb()` 套 `.crumb-txt`（flex 容器内匿名文本无 ellipsis，不处理会是隐性回归）。移动端 `.crumb-copy` 显式 `display:none`（0 宽 crumb 内无意义，清死 UI）。

**修复 B——复制链接全端可达**（`tree.js` fileMenu）：文件 ⋯ 菜单新增「リンクをコピー」（link 图标，复用 `ui.copyText()`，位于收藏与删除之间）——移动端经侧栏抽屉 ⋯ 菜单可达，全断点统一入口。

**版本**：JS 全量 v14 锁步（含 git.js 硬编码 `./app.js?v=14`）、CSS v15；resource 审计 9 模块零分裂。

**E2E（CDP）**：桌面深层文档 crumb 2 目录+copy 可见且 `elementFromPoint` 真实命中、copy→toast、目录点击 expandTo 树完整（11 文件）；移动 390 crumb-copy 隐藏、抽屉→⋯ 菜单 5 项含新复制项→点击 toast；五视图（doc/edit/git/health/gallery/home-redirect）crumb 文案逐一正确；全程零 console error。

**遗留**：用户在飞 `bin/highlight.py`（代码高亮 WIP，未动）；移动端面包屑文字仍 0 宽（顶栏超编，属用户设计决策——如需展示需缩 brand 或移按钮，未擅动）。

### 8.10 第七轮（d086b23→）：代码高亮系统验证 + ⌘E 补实现

**背景**：用户交付 d086b23——零依赖自研高亮：后端 `bin/highlight.py`（9 语言 tokenizer，服务端预高亮，mdrender 围栏接入带异常回退）+ 编辑器预览 JS 版 `hlCode()`（同 token class）+ 4 主题配色。

**验证矩阵（CDP+直测）**：

| 项 | 结果 |
|---|---|
| 服务端高亮（真实文档） | Python memo → 8 kwd/1 str，样本 `from` ✅ |
| 9 语言 tokenizer（直测 mdrender） | kwd×12/str×3/com×4/num×1 覆盖 python/js/sh/json/yaml/sql/html/css/ini；无语言围栏纯转义 ✅ |
| 围栏内 XSS | `<script>`/`<img onerror>` 在 html 围栏内→转义文本且被 token 化（`&lt;script` 入 tk-kwd span），零活标签 ✅（注：整串 `&lt;script&gt;` grep 会因 span 拆分误报缺失，需按片段断言） |
| 编辑器预览同 token | 预览 8 kwd/1 str 与服务端逐一相等 ✅ |
| 4 主题配色 | tk-kwd 计算色：紙墨 rgb(74,85,104)/ダーク rgb(122,134,153)/GH-Light rgb(207,34,46)/GH-Dark rgb(255,123,114)（GitHub 官方红系）✅ |
| 版本审计 | 9 模块 v15 零分裂、CSS v16 ✅ |

**修复 1——版本双重违规**：d086b23 改 `app.css`（+31 行主题色）却把标签 v15 **降回** v14；改 `editor.js`（+40 行 hlCode）而 JS 版本未动。v14/v15 均曾被真实加载，浏览器启发式缓存会向回访用户吐出无高亮配色的旧 CSS 与无高亮的旧 editor。已升 CSS v16、JS 锁步 v15（含 git.js 硬编码）。

**修复 2——⌘E 死承诺**：快捷键帮助面板自第一轮起承诺「⌘/Ctrl + E ドキュメントを編集」，但全局 keydown 从未实现该分支。已补：文档视图下 ⌘/Ctrl+E → `#/edit/<当前文档>`（guard：仅 view-doc 可见且有当前文档时劫持，编辑器内不误触）。实测 ⌘E 进入编辑→预览高亮→history.back 返回阅读，零错误。

本轮回归：`py_compile`+`node --check` 全过；CDP 零 console error；docs/ 与基线一致（未触碰）。

### 8.11 第八轮（214f7e9→）：高亮收尾验证 + 嗅探预览对等移植

**背景**：用户交付 214f7e9——①纸墨主题 token 对比度加强（字符串赭石/关键词靛青/数字紫/键名松绿）②关键词兜底（无其它 token 命中时剩余段整段扫词）③无语言围栏自动嗅探（python/sh/js/json 按关键词命中 ≥2 取最优）④`md/text/txt/markdown` 显式映射 plain。

**验证矩阵（直测 mdrender）**：嗅探 python（def/return/None 3 kwd）✅；sh 嗅探（for/do/done/in）✅；纯散文不误触（0 token）✅；text 围栏保持 plain ✅；兜底（class/pass 纯关键词代码染色）✅；XSS 双路径（无语言+嗅探为 sh 的围栏内 `<script>`/`<img onerror>` 均转义零活标签）✅。CDP：纸墨新配色计算值落地（str rgb(140,90,60) 赭石/kwd rgb(62,92,143) 靛青/num rgb(122,78,140) 紫）✅。

**修复 1——CSS 版本再降级（第四例同型事故）**：214f7e9 改 `app.css`（+25 行配色）却把标签 **v16 降回 v15**；而 v15 曾以「面包屑重构版（无任何高亮配色）」发布过——回访用户命中旧 v15 缓存则 token 全无色。已升 **v17**。

**修复 2——嗅探预览对等移植**（`editor.js`）：214f7e9 只改了后端 `highlight.py`，预览端 `hlCode()` 无嗅探——编辑无语言 python 围栏时预览无色、保存后阅读区有色，违反 d086b23「预览与服务端同 token」设计目标。已移植 `hlSniff()`（同规则：≥2 命中取最优）+ 补 `md/text/txt/markdown→plain` 映射（否则 text 围栏在预览端会被嗅探，反向不对等）。实测对等：无语言围栏服务端 3 kwd ≡ 预览 3 kwd（样本逐一相同）、text 围栏双侧 0 token。

**版本**：CSS v17、JS 锁步 v16（含 git.js 硬编码）；resource 审计 9 模块零分裂、全程零 console error；docs/ 测试文档 finally 清理与基线一致。

### 8.12 第九轮（8ccd566→）：高亮 revert 验证 + 版本再升

**背景**：用户经 003586b（SQL/CSS/HTML/INI 中段关键词白名单补漏）后拍板整体移除高亮（8ccd566）：`highlight.py` 删除、mdrender/预览回纯文本渲染、token 配色 CSS 删除、复制按钮保留。

**验证矩阵**：代码面零残留（tk-/highlight/hlCode/hlSniff 全库 0 命中、bin/ 无 highlight.py）；渲染直测——围栏代码纯文本（0 token）、无语言围栏 `<b>` 转义零活标签、代码内容完整；CDP——阅读区 0 token+复制按钮实测「✓ コピー済み」、预览 0 token、⌘E 仍通、9 模块 v17 零分裂零 console error。预览无复制按钮系 viewer.js 阅读区专属特性（editor.js 全历史 0 命中），非 revert 回归。

**修复——版本随内容回退（第五例同型事故）**：8ccd566 把 CSS 标签 v17→v16、JS 停在 v16——v16 曾以「高亮版内容」发布（b1b0d64/9018d56），旧缓存持有者的 editor.js 仍带 hlCode 生成无色 span（视觉无差但版本语义污染）。已升 **CSS v18 / JS v17**（含 git.js 硬编码），全库 v16 零残留。

**版本号谱系教训定案**：v11-v18 全谱中 v13/v14/v15/v16 四个号都被「二次发布不同内容」污染过。规则收敛为：**版本号是单调递增计数器，永不回退、永不复用——revert 内容也不回退版本号**。

### 8.13 第十轮（7e6faa2→）：移动端面包屑修复 + 高亮 revert 后全量回归

**修复——移动端面包屑 0 宽（§8.9 遗留收口）**：4002399 意图「crumb截断」，实测 brand 81px+sep 把 #crumb 挤到 0px（完全不可见）。移动端隐藏 `.brand/.brand-sep` 释放 ~98px：实测 390px 下 crumb 94px、深层路径正确截断（`工作手册 / システム運用 / 障害対…`）、零横向溢出；桌面 ≥768 不受影响。CSS v19。

**全量回归矩阵（高亮 revert 与 topbar/crumb 重构后首次全面复测，CDP+直测）**：

| 验收项 | 结果 |
|---|---|
| 1 树完整+展开记忆 | 11 文件/5 目录 ✅ |
| 2 右侧大纲 | present，h2/h3×3 ✅ |
| 3 callout/表格/任务 | blockquote✅/読書メモ 表 1×3 行✅/task-box×3✅ |
| 4 Lightbox | 开→stage wheel 缩放 1.15x→双击复位→Esc 关 ✅（注：wheel 绑定在 .lb-stage，派发在根节点无效；表格需选含表格的文档——前次 0 均为脚本选错目标） |
| 5 ⌘K CJK 搜索 | 面板开+聚焦，「手順」「リファクタリング」各 4 marks，Esc 关 ✅ |
| 6 新建日文标题→编辑 | ✅ |
| 7 粘贴图片 | 合成 paste→真实上传 `回帰テスト_assets/2026-08-17-15-54-18.png`→⌘S 落盘 ✅ |
| 11 草稿恢复 | 输入→5s 落 localStorage→重开横幅「下書きが残っています」→「下書きを復元」点击→内容恢复 ✅ |
| 13 移动 390 | 抽屉 11 文件、全屏搜索、无横向滚动、crumb 94px 截断（本轮修复）✅ |
| 16-18 质量 | console 零 error（全部脚本 errs 空）、原生控件 grep 零命中、node --check 全过 ✅ |
| 19 性能 | home 1.2ms/CSS 2.1ms/索引 9.7KB 2.2ms/树 2.0ms（门槛 1.5s/300ms）✅ |
| 21 图片重写 | 読書メモ 图片 naturalWidth>0、network 收集零 404 ✅ |

**假警报甄别（三处，均记档防误修）**：①抽屉二次点 btn-menu 不关——抽屉 z-60 `top:0` 物理覆盖 z-30 顶栏左缘的汉堡钮，真实用户不可点（关闭走遮罩/Esc），非 bug；②顶栏 1 对按钮重叠——crumb-dir 被 #crumb `overflow:hidden` 裁剪（aClipped=true），getBoundingClientRect 不反映祖先裁剪，非真重叠；③weekly 表格 0——所选文档本无表格（読書メモ 才有）。**教训：三处初判为 bug 的现象全是测试脚本自身的目标选择错误，甄别后才动手。**

8/9/10（rename 断图/删除/图库）8.4·8.7 轮实测后相关代码路径未再变更（gallery.js 本轮仅 import 版本号变化），未重跑；12 主题四款 8.11 轮实测。14 的 1920 断点第一轮实测后布局 CSS 未动核心栅格。

docs/ 测试产物（回帰テスト×2 文档+assets+draft localStorage）全部清理，与基线一致。

### 8.14 第十一轮（607b112→）：根文档移动断图修复 + 欠账验证（move/clean/1920/双主题）

**修复——moveFlow 根文档不改写图片引用**（`editor.js`）：原实现 `if (oldDir)` 包裹改写逻辑——从**根目录**移出的文档（oldDir=''）引用 `x_assets/…` 原样保留，移入子目录后解析全断（根文档+贴图为可达成状态：新建选「ルート」+粘贴）。normalizeDir('/x')→'x'、relFromTo('個人…','x_assets')→'../x_assets' 本就正确，纯 guard 误判。修后实测：根 `移動テスト.md`（含贴图）UI 移入 个人备忘 → 磁盘内容改写为 `../移動テスト_assets/…`、图片经 /files/ 加载 naturalWidth>0、根副本删除、toast「移動しました」。JS v18。

**moveFlow 409 撞名（a984820 语义，代码审阅后本轮实测）**：根 README.md 移入 工作手册（已有同名）→ 后端 409 `exists` → toast「exists」、源文件保留、目标原文件未被动（`# ドキュメント構成` 完好）。

**clean 流复测（a984820 收紧：只扫 assets+删除前二次校验）**：制造孤儿（temp doc+上传图+保存无引用内容）→ health 页列出 → dry 确认 → danger 对话框 → 实删 → toast「1 件削除しました」、磁盘 404、health 孤儿归零。

**1920×1080 三栏几何**：sidebar 280px / 阅读列 720px（630-1350，考虑右侧大纲的布局居中）/ 大纲 210px@1700，零横向溢出。

**双主题×表面走查**：dark body #141414+浮层 #1B1A18、light #F7F3EA+#FCFAF4（精确 token 值）；搜索卡片/删除对话框两主题均可见。

**测试脚本陷阱记档（第四例）**：树行 `textContent`=标题（无 .md 后缀），全路径在 `dataset.path`——按 'xxx.md' 搜 textContent 永远落空；诊断时 `domFiles` 列表恰用 dataset.path 展示，掩盖了该差异。

docs/ 测试产物（移動テスト×2+assets、Clean検証、README）全部清理，health 全绿。

### 8.15 第十二轮（c306f8e→）：rename/图库删除最终态复测 + gallery 死代码清理

**复测动机**：#8 rename 与 #10 图库删除自 8.4/8.7 轮后，相关后端经 a984820 收紧（image/delete 限 assets 目录+二次校验），UI 链路未在最终代码实证过。

**rename E2E（UI 全链路）**：`改名前テスト.md`（含贴图）→ 树 ⋯→名前変更→对话框输入→変更 → 磁盘引用改写 `改名前テスト_assets/…`→`改名後テスト_assets/…`、assets 目录迁移（gallery API 确认新路径）、图片经 /files/ naturalWidth>0、旧路径 404、hash 自动跳新路径。✅

**图库删除 E2E（a984820 收紧后 UI 层）**：gallery url `/files/个人备忘/xxx_assets/…` → 前端剥 `/files/` 得 docs 相对路径 → 收紧后的 `_safe_asset_path`（父目录须 `_assets`）匹配通过；复制 md 引用 toast→danger 对话框→删除→网格即时刷新→磁盘 404；删除被引用图后 health 如实报 missing=1（对话框已警告「参照も壊れます」），删文档后归零。✅ v19 再烟测一次同绿。

**清理——gallery 死分支**：第一轮后端冻结期的能力开关 `IMAGE_DELETE_API`（第四轮已翻 true）+ 永不执行的降级 toast + 过期注释「后端缺该端点」一并移除（clean cutover；API 已永久存在）。JS v19 锁步，9 模块零分裂。

**测试脚本事故记档（第五例）**：create 传参加入杂散空格（`'改 名前テスト'`）而后续步骤用无空格名——upload 400、引用字面量 `undefined`、rename 断言全被污染；先清理残档再以逐字段核对重跑通过。教训：多步 setup 的字符串参数跨步骤复用时以变量传递，不手抄。

docs/ 测试产物（改名前後×2+assets、煙霧テスト）全部清理，health 全绿（11 篇/0/0/0）。

### 8.16 第十三轮（4c8d3e5→）：截图资产刷新到当前 UI（验收项 #15 持续有效）

**动机**：核心 24 张双端双主题截图停在第一轮，此后顶栏迁移（4002399）、移动 brand 隐藏+crumb 94px（607b112）、gallery 死代码清理（4c8d3e5）让它们不再代表产品现状。

**刷新**：24 张全量重拍（desktop 1024×640 ×12：reader/editor/gallery/lightbox/menu/search × light/dark；mobile 390×844 ×12：reader/drawer/outline/editor/lightbox/search × light/dark），同名覆盖。

**校验**：尺寸断言全过；像素级抽查——light vs dark reader 差 217.9（主题确生效）、menu 与 reader 全屏差 0.9 但菜单裁剪区差 5.5（小浮层全屏均值稀释，菜单确可见）、dark-lightbox 652k/655k 非黑像素（1×1 测试图放大均匀属正常，非黑屏）；24 张零低方差空白图。

**清理**：`hl-dark.png`/`hl-ghl.png`——8ccd566 revert 高亮时漏删的孤儿截图（被删功能的残留物），随本轮删除。

本轮零代码变更（无版本号动作）。docs/ 未触碰，health 全绿。
