# Goal: chishiki v2 前端 — 日式编辑部风知识库 UI（yomu 同款设计体系）

> 自包含任务书。执行代理不需要读任何聊天记录。仓库已就位：`/home/tetsuya/development/chishiki`（github.com/iamcheyan/chishiki, master）。

## 背景（30 秒读懂）

chishiki = 个人知识库（Markdown 文档树 + 阅读 + 编辑 + 截图直贴 + 全文搜索 + 图库）。
**后端已完成并实测通过**，你的任务是**从零写 `web/` 前端**（零依赖、零构建、纯 vanilla），用日式编辑部设计体系，部署到 82 机 :8850。

### 已有后端（勿改，直接调）

- `bin/app.py` — 服务器（静态托管 `web/` + docs 直出）。启动：`python3 bin/app.py`（默认 0.0.0.0:8850，docs=仓库 `docs/`）
- API 全表（JSON，均返回 `{"ok":bool,...}`）：
  - `GET /api/tree` → `{tree:[{type:dir|file,name,path,title,mtime,children}],docsRoot}`
  - `GET /api/doc?path=x.md` → `{path,content,mtime}`；`?rendered=1` → `{path,html,mtime}`（服务端渲染，含 Docsify `!>`/`?>` 容器降级、GFM 表格/任务列表、XSS 已转义）
  - `POST /api/doc/save` `{path,content}` → 原子写
  - `POST /api/doc/create` `{dir,name,title}` / `POST /api/doc/rename` `{path,name}` / `POST /api/doc/delete` `{path}`
  - `POST /api/image` multipart(`path`+`file`) → `{path,markdown:"![image](...)"}`（落 `<stem>_assets/`）
  - `GET /api/search-index` → `{entries:[{path,title,mtime,sections:[{title,id,level}],text}]}`
  - `GET /api/gallery?dir=` → `{images:[{name,url,size,mtime}]}`（扫 `_assets`/`assets`）
  - `GET /files/<docs相对路径>` — 图片等原文件直出（**渲染 HTML 里的相对图片路径要由前端重写为 `/files/<文档所在目录>/<src>`**）
  - `GET /api/meta` → `{docs,built}`
- 路径规则：侧栏 path 均为 docs 内相对 POSIX 路径；后端已防穿越。

### 测试内容（已在仓）

`docs/` 已有多文件夹层级测试文档（工作手册/技术笔记/会议记录/个人备忘 四目录），含表格/任务列表/Docsify `!>`/`?>`/代码块/日文长文。**不要动这些文档内容**；可在 `docs/个人备忘/` 下新增你自己的验收草稿，完成后删除。

## 设计体系（强制，来自 japanese-editorial-reader-ui skill，yomu 同源）

**表面定性：Library（左）+ Reader（右）+ 编辑是临时侵入层。**

### Token（CSS 变量，浅/深双主题，`html[data-theme]` 切换 + prefers-color-scheme 默认）

浅色（纸与墨）：
```
--bg:#F7F3EA; --bg-elev:#FCFAF4; --ink:#282521; --muted:#8D867C;
--rule:rgba(40,37,33,.12); --accent:#4A5568 (低饱和靛蓝); --sel:rgba(74,85,104,.14)
```
深色：
```
--bg:#141414; --bg-elev:#1B1A18; --ink:#D8D2C8; --muted:#858078;
--rule:rgba(216,210,200,.14); --accent:#7A8699; --sel:rgba(122,134,153,.22)
```
字体：正文 `"Hiragino Mincho ProN","Yu Mincho","Noto Serif JP",serif`；UI 控件/侧栏 `"Hiragino Sans","Yu Gothic UI",sans-serif`。**不引 webfont**。
圆角 ≤8px；阴影仅浮层（弹窗/抽屉）允许；**禁止卡片墙、粗黑线、黑标签块、渐变、玻璃拟态、emoji 图标**（图标=内联 SVG，stroke 1.5）。

### 布局

- **桌面 ≥1024**：三栏。左侧栏 280px（文档树+搜索入口+新建）；中间阅读列 max-width 720px 居中（padding 48px 40px）；**右侧大纲栏 ~200px（当前文档 h2/h3 目录导航，滚动 spy 高亮当前节，点击平滑滚动）**——用户明确要求"打开时右侧有文档目录导航"。编辑态：中栏变 编辑|预览 左右分屏。
- **移动 <768**：单列阅读；侧栏=左缘抽屉（遮罩+滑动）；大纲=顶部下拉面板（"目录"按钮）；编辑器全屏。
- 顶栏：极简（产品名 chishiki 竖排分隔+主题切换+保存状态指示），滚动出视口后浮现返回顶部。

### 组件（全部自绘，零原生控件）

- 对话框/confirm/prompt：居中卡片（Esc 取消/Enter 确认/遮罩点击关闭）
- 下拉：ypop 模式（trigger 按钮+fixed 菜单，<480px 降级底部 sheet）
- toast：底部浮出，2.5s 自动消失
- 焦点可见（outline 2px accent），键盘全程可用

### 功能（全做）

1. **文档树侧栏**：目录/文件图标区分、展开折叠（记忆 localStorage）、当前文档高亮（**激活态=下划线**，不是背景块）、文件 hover 显示操作（改名/删除/移动）；目录 hover 显示（新建文档/新建文件夹/+图库入口）；最近打开 5 篇 + 收藏（star，localStorage）。
2. **阅读**：调 `/api/doc?rendered=1` 插入 `.md-body`；图片 src 重写 `/files/...`；**图片查看器：点击图片→全屏遮罩 Lightbox（滚轮/双指缩放 1x-8x、拖拽平移、双击复位、←→ 切换本文档图片、Esc 关）**；代码块长行横向滚动；表格容器可横滚；链接外链新窗。
3. **搜索**：`Ctrl/Cmd+K` 或侧栏搜索框 → 居中面板（移动全屏）；加载 search-index 后纯前端查询：CJK 2-gram + 拉丁按词，AND 匹配，标题×5/章节×3/正文×1 打分；结果=文档分组（标题>章节锚点+`<mark>` 摘录），↑↓+Enter 跳转（含锚点滚动），120ms 防抖，空态一句话。
4. **编辑器**：`textarea`+预览分屏（同步滚动近似即可）或单编辑/单预览切换；工具栏（H1-H3/粗斜/列表/引用/代码/链接/图片按钮）作用于选区；**粘贴图片**（paste 事件 image/* → POST /api/image → 光标插入 md，上传中插 `![uploading…]` 占位，完成替换）；拖拽图片同链路；Ctrl/Cmd+S 保存；脏标记（标题栏圆点）；5s 草稿存 localStorage（键=文档路径，保存成功清除，重开提示恢复）；外部 mtime 变更检测（顶部细条提示 重读/保留）；状态栏（字数/行数/mtime）。
5. **图库**：侧栏目录操作里的"图库"→ 该目录全部 `_assets`/`assets` 图片网格（竖排瀑布或等高行，间距大、无卡片框，图片本身即视觉）；点击进 Lightbox（同上）；每张图 hover 显示：复制 md 引用 / 删除（confirm 对话框）；顶部统计（N 张/总大小）。
6. **空态**：无文档=一句引导+新建按钮；空文件夹=同。
7. **快捷键**：⌘K 搜索 / ⌘S 保存 / Esc 层层退出 / ⌘N 新建。

## 文件结构（照此组织）

```
web/index.html   web/app.css   web/js/app.js(引导+路由)
web/js/tree.js editor.js viewer.js(lightbox) search.js gallery.js ui.js(对话框/下拉/toast)
```
ES modules（`<script type="module">`），无打包。改 JS/CSS 必须给 `<script>/<link>` 加 `?v=` 版本（初始 v1，每次改动 +1）。

## 部署与验收（严格）

部署：写 `run.sh`（`exec python3 bin/app.py "$@"`）并建 systemd 单元 `~/.config/systemd/user/chishiki.service`（Restart=on-failure，ExecStart=仓库 run.sh，端口 8850），`systemctl --user enable --now chishiki`。82 机防火墙已放行局域网。

### 验收清单（全部满足才算完，逐条自证）

**A. 功能（CDP 或浏览器实测，截图/console 证据）**
1. 侧栏四目录树完整显示、展开折叠记忆生效（刷新后保持）
2. 打开任一多级文档 → 右侧大纲栏出现该文档 h2/h3，滚动 spy 高亮正确，点击跳转准
3. Docsify `!>`/`?>` 容器以 callout 样式渲染；表格/任务列表/代码块正常
4. 图片点击 → Lightbox 开；滚轮缩放到 3x 图像清晰；双击复位；Esc 关
5. ⌘K 搜索"手順"（日文）→ 结果含多文档+章节锚点；点击跳到对应节；`<mark>` 高亮
6. 新建文档（含日文标题）→ 出现在树上 → 编辑保存 → 重新打开内容在
7. 粘贴一张截图（CDP `Input.dispatchKeyEvent` 合成 paste 或拖拽模拟）→ md 里出现 `![image](xxx_assets/…)`，预览可见
8. 重命名带 `_assets` 的文档 → 图片引用不断（后端已处理，前端树刷新验证）
9. 删除 → 自绘 confirm → 树消失
10. 图库：打开某目录 → 网格显示其全部图片 → 复制 md 引用 → Lightbox 可删
11. 编辑器草稿：输入不保存 → 刷新 → 提示恢复 → 恢复成功
12. 主题切换浅/深 → 全部界面（含 Lightbox/搜索/对话框）双主题无破相

**B. 双端**
13. 390×844：抽屉侧栏/全屏搜索/全屏编辑器/底部安全区/无横向滚动
14. 1280×800 与 1920×1080：三栏比例正常、阅读列 720px 居中
15. 全部页面两主题截图存 `screenshots/`（桌面+移动各≥6张，git push）

**C. 质量（硬门槛，任一失败=未完成）**
16. console 零 error（全流程走查，CDP 收集 pageerror+console.error）
17. `grep -rE "\b(alert|confirm|prompt)\s*\("` web/ 零命中（原生控件禁令）
18. `node --check` 每个 js 通过；无 console.log 残留（搜索/上传日志除外）
19. 首屏（树+首页空态）≤1.5s（本机 curl 计时）；搜索索引 1MB 内加载 <300ms
20. Lighthouse 移动端 Accessibility ≥90（CDP 跑或手动清单：焦点可见/对比度/语义标题/alt）
21. 图片相对路径全部走 `/files/` 重写（查看任一文档 network 无 404 图片）

**D. 工程纪律**
22. 全部提交分批 push（UI壳一批/编辑器一批/搜索图库一批/打磨验收一批），中文 commit
23. `REFACTOR_PLAN.md` 末尾追加"v2 前端交付记录"一节：功能对照表+验收结果+截图引用
24. 完成后 systemd 服务 active、`curl http://127.0.0.1:8850/api/meta` 200

### 禁止
- 改 `bin/`（后端已冻结；发现 bug 记录到交付记录，不要动）
- 引入任何外部依赖/CDN/字体
- 动 `docs/` 测试文档内容
- 原生 alert/confirm/prompt/select/color input

## 参考
- 设计全文：`~/.hermes/skills/creative/japanese-editorial-reader-ui/SKILL.md`（执行前先读）
- yomu 成品参照：`~/development/yomu/`（css 变量组织/阅读排版/无框列表）
- 用户设计口味铁律：层级靠字号字重+留白，激活态用下划线；忌胶囊堆叠、元素贴挤、控件偏大
