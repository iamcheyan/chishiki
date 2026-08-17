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
