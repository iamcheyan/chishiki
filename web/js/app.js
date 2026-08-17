/* app.js — 引导 + hash 路由 + 主题 + 快捷键 + 抽屉/大纲/返回顶部 */
import { $, $$, menu } from './ui.js?v=8';
import * as tree from './tree.js?v=8';
import * as viewer from './viewer.js?v=8';
import * as editor from './editor.js?v=8';
import * as search from './search.js?v=8';
import * as gallery from './gallery.js?v=8';

/* ---------- 主题 ---------- */
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('chishiki:theme', t); } catch (e) { /* noop */ }
  const dark = t === 'dark' || t === 'github-dark';
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  const mc = $('meta[name="theme-color"]');
  const colors = { 'light': '#F7F3EA', 'dark': '#141414', 'github-light': '#ffffff', 'github-dark': '#0d1117' };
  if (mc) mc.content = colors[t] || '#F7F3EA';
}
function currentTheme() {
  const t = document.documentElement.dataset.theme;
  if (t === 'dark' || t === 'github-dark') return 'dark';
  return 'light';
}
function initTheme() {
  const saved = localStorage.getItem('chishiki:theme');
  if (saved === 'github-light' || saved === 'github-dark') applyTheme(saved);
  else applyTheme(currentTheme());
  $('#btn-theme').addEventListener('click', e => {
    const cur = document.documentElement.dataset.theme || 'light';
    menu(e.currentTarget, [
      { label: 'ライト（紙と墨）', value: 'light', checked: cur === 'light' },
      { label: 'ダーク', value: 'dark', checked: cur === 'dark' },
      { label: 'GitHub Light', value: 'github-light', checked: cur === 'github-light' },
      { label: 'GitHub Dark', value: 'github-dark', checked: cur === 'github-dark' },
    ]).then(v => { if (v) applyTheme(v); });
  });
}

/* ---------- 视图切换 ---------- */
const VIEWS = ['view-home', 'view-doc', 'view-editor', 'view-gallery'];
function showView(name) {
  for (const id of VIEWS) $('#' + id).hidden = id !== name;
  if (name !== 'view-doc') viewer.hideOutline(), hideMobileOutline();
  closeDrawer();
}

/* ---------- 路由 ---------- */
function parseHash() {
  const h = location.hash || '#/';
  const [pathPart, queryPart] = h.slice(1).split('?');
  const params = new URLSearchParams(queryPart || '');
  const seg = pathPart.split('/'); // ['', 'doc', rest...]
  const kind = seg[1] || '';
  const rest = seg.slice(2).join('/');
  return { kind, rest, params };
}

async function route() {
  const { kind, rest, params } = parseHash();
  // 离开编辑器: 脏内容同步落草稿, 停冲突轮询
  if (!$('#view-editor').hidden && kind !== 'edit') editor.leaveEditor();
  if (kind === 'doc' && rest) {
    const path = decodeURIComponent(rest);
    const anchor = params.get('h') || null;
    showView('view-doc');
    viewer.state.currentPath = path;
    tree.setCurrent(path);
    tree.pushRecent(path);
    renderCrumb(path);
    updateStarBtn(path);
    try {
      await viewer.showDoc(path, anchor);
    } catch (e) {
      $('#md-body').innerHTML = `<p>読み込み失敗: ${e.message}</p>`;
    }
  } else if (kind === 'edit' && rest) {
    const path = decodeURIComponent(rest);
    showView('view-editor');
    $('#crumb').textContent = path + ' — 編集';
    tree.setCurrent(path);
    try {
      await editor.openEditor(path);
      editor.startConflictWatch();
    } catch (e) {
      location.hash = '#/doc/' + encodeURIComponent(path);
    }
  } else if (kind === 'gallery') {
    const dir = rest ? decodeURIComponent(rest) : '';
    showView('view-gallery');
    $('#crumb').textContent = dir ? dir + ' — ギャラリー' : 'ギャラリー';
    tree.setCurrent(null);
    await gallery.showGallery(dir);
  } else {
    showView('view-home');
    viewer.state.currentPath = null;
    tree.setCurrent(null);
    $('#crumb').textContent = '';
    // 有文档时首页默认打开第一篇
    const first = firstDoc(tree.treeState.data);
    if (first) { location.hash = '#/doc/' + encodeURIComponent(first); return; }
  }
}

function firstDoc(nodes) {
  for (const n of nodes || []) {
    if (n.type === 'file') return n.path;
    const f = firstDoc(n.children);
    if (f) return f;
  }
  return null;
}

/* ---------- 收藏星标 ---------- */
function updateStarBtn(path) {
  const btn = $('#btn-star');
  btn.classList.toggle('on', !!path && tree.isStarred(path));
  btn.setAttribute('aria-pressed', btn.classList.contains('on') ? 'true' : 'false');
}
document.addEventListener('chishiki:star', () => updateStarBtn(viewer.state.currentPath));

/* ---------- 编辑按钮 ---------- */
$('#btn-edit').addEventListener('click', () => {
  if (viewer.state.currentPath) location.hash = '#/edit/' + encodeURIComponent(viewer.state.currentPath);
});
$('#btn-star').addEventListener('click', () => {
  if (viewer.state.currentPath) tree.toggleStar(viewer.state.currentPath);
});
$('#btn-home-new').addEventListener('click', () => editor.newDocFlow(undefined));

/* ---------- 抽屉(移动) ---------- */
function openDrawer() {
  $('#sidebar').classList.add('open');
  const bd = $('#drawer-backdrop');
  bd.hidden = false;
}
function closeDrawer() {
  $('#sidebar').classList.remove('open');
  $('#drawer-backdrop').hidden = true;
}
$('#btn-menu').addEventListener('click', openDrawer);
$('#drawer-backdrop').addEventListener('click', closeDrawer);

/* ---------- 移动大纲面板 ---------- */
let mobileOutlineOpen = false;
function hideMobileOutline() {
  mobileOutlineOpen = false;
  $('#outline').removeAttribute('mobile-panel');
  $('#btn-outline').setAttribute('aria-expanded', 'false');
}
/* 字体档位切换: serif(默认明朝体)/sans(黑体) — 初始化只做一次 */
function initFontToggle() {
  const btn = $('#btn-font');
  if (!btn || btn._fontBound) return;
  btn._fontBound = true;
  btn.textContent = 'あ';
  btn.addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-font') || 'serif';
    const next = cur === 'serif' ? 'sans' : 'serif';
    document.documentElement.setAttribute('data-font', next);
    localStorage.setItem('chishiki-font', next);
  });
}
if (localStorage.getItem('chishiki-font') === 'sans') document.documentElement.setAttribute('data-font', 'sans');
$('#btn-outline').addEventListener('click', () => {
  mobileOutlineOpen = !mobileOutlineOpen;
  if (mobileOutlineOpen) {
    $('#outline').setAttribute('mobile-panel', '');
    $('#outline').hidden = false;
  } else hideMobileOutline();
  $('#btn-outline').setAttribute('aria-expanded', String(mobileOutlineOpen));
});

// 面板内点链接 → 跳转后收起
$('#outline-nav').addEventListener('click', e => {
  if (mobileOutlineOpen && e.target.closest('a')) hideMobileOutline();
});

/* ---------- 返回顶部 ---------- */
const main = $('#main');
main.addEventListener('scroll', () => {
  $('#back-top').hidden = main.scrollTop < 600;
  viewer.spyScroll();
}, { passive: true });
$('#back-top').addEventListener('click', () => main.scrollTo({ top: 0, behavior: 'smooth' }));

/* ---------- 锚点事件(同文档搜索跳转) ---------- */
document.addEventListener('chishiki:anchor', e => {
  const id = e.detail;
  if (!id) return;
  const el = $('#md-body').querySelector(`[id="${CSS.escape(id)}"]`);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

/* ---------- 搜索入口 ---------- */
$('#btn-search-open').addEventListener('click', () => search.open());
$('#btn-newdoc').addEventListener('click', () => editor.newDocFlow(undefined));

/* ---------- 快捷键 ---------- */
document.addEventListener('keydown', e => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    if (search.isOpen()) search.close(); else search.open();
  } else if (mod && (e.key === 's' || e.key === 'S')) {
    if (!$('#view-editor').hidden) { e.preventDefault(); editor.save(); }
  } else if (mod && (e.key === 'n' || e.key === 'N')) {
    e.preventDefault();
    editor.newDocFlow(undefined);
  } else if (e.key === 'Escape') {
    if (viewer.lightboxIsOpen()) return; // lightbox 自行处理
    if (!$('#search-panel').hidden) { search.close(); return; }
    if (mobileOutlineOpen) { hideMobileOutline(); return; }
    if ($('#sidebar').classList.contains('open')) { closeDrawer(); return; }
  }
});

/* ---------- Lightbox Esc ---------- */
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || !viewer.lightboxIsOpen()) return;
  viewer.lightboxClose();
});
document.addEventListener('keydown', e => {
  if (!viewer.lightboxIsOpen()) return;
  if (e.key === 'ArrowLeft') document.getElementById('lb-prev').click();
  if (e.key === 'ArrowRight') document.getElementById('lb-next').click();
});

/* ---------- 响应式辅助类 ---------- */
function syncResponsive() {
  const mobile = innerWidth < 768;
  $('#btn-menu').hidden = !mobile;
  $('#btn-outline').hidden = !mobile;
  if (!mobile) hideMobileOutline();
}
addEventListener('resize', syncResponsive);

/* ---------- boot ---------- */
async function boot() {
  initTheme();
  initFontToggle();
  search.init();
  editor.initFileInput();
  syncResponsive();
  await tree.refresh().catch(() => {});
  addEventListener('hashchange', route);
  viewer.watchScroll(() => viewer.state.currentPath);
  await route();
  // 空闲时预载搜索索引
  setTimeout(() => search.loadIndex().catch(() => {}), 1200);
}
boot();


/* ---------- 面包屑: 目录可点 + 复制链接 ---------- */
function renderCrumb(path) {
  const el = document.getElementById('crumb');
  el.textContent = '';
  const parts = path.split('/');
  parts.forEach((seg, i) => {
    if (i) el.appendChild(document.createTextNode(' / '));
    if (i === parts.length - 1) {
      el.appendChild(document.createTextNode(seg));
      const cp = document.createElement('button');
      cp.type = 'button';
      cp.className = 'crumb-copy';
      cp.setAttribute('aria-label', 'リンクをコピー');
      cp.title = 'リンクをコピー';
      cp.addEventListener('click', async () => {
        const url = location.origin + '/#/doc/' + encodeURIComponent(path);
        try { await navigator.clipboard.writeText(url); }
        catch (e) {
          const ta = document.createElement('textarea');
          ta.value = url; document.body.appendChild(ta); ta.select();
          document.execCommand('copy'); ta.remove();
        }
        import('./ui.js').then(m => m.toast('リンクをコピーしました'));
      });
      el.appendChild(cp);
    } else {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'crumb-dir';
      b.textContent = seg;
      b.addEventListener('click', () => {
        // 展开并滚到该目录
        import('./tree.js').then(m => m.expandTo && m.expandTo(parts.slice(0, i + 1).join('/')));
      });
      el.appendChild(b);
    }
  });
}

/* ---------- 快捷键帮助面板(? 呼出) ---------- */
const SHORTCUTS = [
  ['⌘/Ctrl + K', '全文検索'],
  ['⌘/Ctrl + E', 'ドキュメントを編集'],
  ['⌘/Ctrl + S', '保存（エディタ）'],
  ['Esc', '検索・ダイアログを閉じる'],
  ['?', 'このヘルプ'],
];
export function toggleShortcutHelp() {
  let el = document.getElementById('shortcut-help');
  if (el) { el.hidden = !el.hidden; return; }
  el = document.createElement('div');
  el.id = 'shortcut-help';
  el.className = 'scrim';
  el.addEventListener('click', e => { if (e.target === el) el.hidden = true; });
  const card = document.createElement('div');
  card.className = 'sc-help';
  card.innerHTML = '<h2>キーボードショートカット</h2>' +
    SHORTCUTS.map(([k, v]) => `<div class="sc-row"><kbd>${k}</kbd><span>${v}</span></div>`).join('') +
    '<button type="button" class="sc-close">閉じる</button>';
  card.querySelector('.sc-close').addEventListener('click', () => { el.hidden = true; });
  el.appendChild(card);
  document.body.appendChild(el);
}
document.addEventListener('keydown', e => {
  if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    e.preventDefault();
    toggleShortcutHelp();
  }
});
