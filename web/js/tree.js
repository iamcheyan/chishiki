/* tree.js — 侧栏文档树: 展开/折叠记忆, 当前下划线, hover 操作, 最近+收藏 */
const VSN = (import.meta.url.match(/\?v=\d+/) || [''])[0];
import { $, $$, esc, api, icon, showdialog, menu, toast, fmtTime } from './ui.js?v=9';
import { invalidate as invalidateSearch } from './search.js?v=9';

const LS_EXPANDED = 'chishiki:expanded';
const LS_RECENT = 'chishiki:recent';
const LS_STAR = 'chishiki:star';

export const treeState = {
  data: null,          // /api/tree 原始数据
  byPath: new Map(),   // path -> node
  current: null,       // 当前打开文档 path
};

function lsGet(k, def) { try { return JSON.parse(localStorage.getItem(k)) ?? def; } catch (e) { return def; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 忽略 */ } }

function expandedSet() { return new Set(lsGet(LS_EXPANDED, null) || defaultExpanded()); }
function defaultExpanded() {
  // 默认展开顶层目录
  const dirs = [];
  walk(treeState.data, n => { if (n.type === 'dir' && !n.path.includes('/')) dirs.push(n.path); });
  return dirs;
}
function walk(nodes, fn) {
  for (const n of nodes || []) { fn(n); if (n.children) walk(n.children, fn); }
}

export async function refresh() {
  const data = await api('/api/tree');
  treeState.data = data.tree;
  treeState.byPath = new Map();
  walk(treeState.data, n => treeState.byPath.set(n.path, n));
  render();
  return data;
}

export function setCurrent(path) {
  treeState.current = path;
  $$('.tree .file').forEach(el => el.classList.toggle('cur', el.dataset.path === path));
  // 自动展开父级
  if (path) {
    const ex = expandedSet();
    let dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    while (dir) { ex.add(dir); dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : ''; }
    lsSet(LS_EXPANDED, [...ex]);
    render();
  }
}

/* ---------- 渲染 ---------- */
export function render() {
  const root = $('#tree');
  root.innerHTML = '';
  if (!treeState.data || !treeState.data.length) {
    root.innerHTML = '<div style="padding:6px 20px;font-size:12.5px;color:var(--muted-2);font-family:var(--font-sans)">（ドキュメントがありません）</div>';
    return;
  }
  const ex = expandedSet();
  root.appendChild(buildUl(treeState.data, ex, 0));
  renderSideList($('#recent-list'), $('#recent-sec'), recent(), true);
  renderSideList($('#fav-list'), $('#fav-sec'), stars(), 'fav');
}

function buildUl(nodes, ex, depth) {
  const ul = document.createElement('ul');
  if (depth > 0) ul.className = 'kids';
  for (const n of nodes) ul.appendChild(n.type === 'dir' ? buildDir(n, ex, depth) : buildFile(n));
  return ul;
}

function buildDir(n, ex, depth) {
  const li = document.createElement('li');
  li.className = 'dir' + (ex.has(n.path) ? ' open' : '') + (n.children && n.children.length ? '' : ' empty');
  li.dataset.path = n.path;
  const open = ex.has(n.path);
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `
    <button type="button" class="caret" aria-label="${open ? '閉じる' : '開く'}" aria-expanded="${open}">${icon('caret', 12)}</button>
    <span class="ic">${icon('folder', 15)}</span>
    <span class="label">${esc(n.name)}</span>
    <span class="acts">
      <button type="button" class="a-newdoc" aria-label="新規ドキュメント" title="新規ドキュメント">${icon('plus', 13)}</button>
      <button type="button" class="a-gallery" aria-label="ギャラリー" title="ギャラリー">${icon('image', 13)}</button>
      <button type="button" class="a-newdir" aria-label="新規フォルダ" title="新規フォルダ">${icon('folder', 13)}</button>
    </span>`;
  row.querySelector('.caret').addEventListener('click', () => toggleDir(n.path));
  row.querySelector('.label').addEventListener('click', () => toggleDir(n.path));
  row.querySelector('.ic').addEventListener('click', () => toggleDir(n.path));
  row.querySelector('.a-newdoc').addEventListener('click', () => {
    import('./editor.js' + VSN).then(m => m.newDocFlow(n.path));
  });
  row.querySelector('.a-newdir').addEventListener('click', () => newDirFlow(n.path));
  row.querySelector('.a-gallery').addEventListener('click', () => {
    location.hash = '#/gallery/' + encodeURIComponent(n.path);
  });
  li.appendChild(row);
  if (n.children && n.children.length) li.appendChild(buildUl(n.children, ex, depth + 1));
  return li;
}

/* 展开到指定目录并滚动定位(面包屑用) */
export function expandTo(dirPath) {
  const ex = expandedSet();
  let cur = '';
  for (const seg of dirPath.split('/')) {
    cur = cur ? cur + '/' + seg : seg;
    ex.add(cur);
  }
  lsSet(LS_EXPANDED, [...ex]);
  render();
  requestAnimationFrame(() => {
    const li = document.querySelector(`.tree [data-path="${CSS.escape(dirPath)}"]`);
    if (li) li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
}

function toggleDir(path) {
  const ex = expandedSet();
  if (ex.has(path)) ex.delete(path); else ex.add(path);
  lsSet(LS_EXPANDED, [...ex]);
  render();
}

function buildFile(n) {
  const li = document.createElement('li');
  li.className = 'file' + (n.path === treeState.current ? ' cur' : '');
  li.dataset.path = n.path;
  const starred = stars().includes(n.path);
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `
    <span class="caret-sp" style="width:20px;flex:none"></span>
    <button type="button" class="open-doc" style="display:flex;align-items:center;gap:6px;flex:1;min-width:0;text-align:left">
      <span class="ic">${icon('file', 15)}</span>
      <span class="label">${esc(n.title || n.name)}</span>
    </button>
    <span class="acts">
      <button type="button" class="a-star ${starred ? 'star-on' : ''}" aria-label="お気に入り" title="お気に入り">${icon('star', 13)}</button>
      <button type="button" class="a-more" aria-label="操作" title="操作">${icon('dots', 13)}</button>
    </span>`;
  row.querySelector('.open-doc').addEventListener('click', () => {
    const target = '#/doc/' + encodeURIComponent(n.path);
    if (location.hash === target) {
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    } else {
      location.hash = target;
    }
  });
  row.querySelector('.a-star').addEventListener('click', () => toggleStar(n.path));
  row.querySelector('.a-more').addEventListener('click', e => {
    fileMenu(e.currentTarget, n);
  });
  li.appendChild(row);
  return li;
}

function fileMenu(anchor, n) {
  const starred = stars().includes(n.path);
  menu(anchor, [
    { label: '名前変更', value: 'rename', icon: 'pencil' },
    { label: '移動', value: 'move', icon: 'move' },
    { label: starred ? 'お気に入り解除' : 'お気に入り', value: 'star', icon: 'star' },
    '-',
    { label: '削除', value: 'del', icon: 'trash', danger: true },
  ]).then(v => {
    if (!v) return;
    import('./editor.js' + VSN).then(m => {
      if (v === 'rename') m.renameFlow(n);
      else if (v === 'move') m.moveFlow(n);
      else if (v === 'del') m.deleteFlow(n);
      else if (v === 'star') toggleStar(n.path);
    });
  });
}

/* ---------- 收藏 ---------- */
export function stars() { return lsGet(LS_STAR, []); }
export function isStarred(path) { return stars().includes(path); }
export function toggleStar(path) {
  let s = stars();
  s = s.includes(path) ? s.filter(x => x !== path) : [path, ...s];
  lsSet(LS_STAR, s);
  render();
  document.dispatchEvent(new CustomEvent('chishiki:star', { detail: path }));
}

/* ---------- 最近 ---------- */
export function recent() { return lsGet(LS_RECENT, []); }
export function pushRecent(path) {
  let r = [path, ...recent().filter(x => x !== path)].slice(0, 5);
  lsSet(LS_RECENT, r);
  renderSideList($('#recent-list'), $('#recent-sec'), r, true);
}

function renderSideList(ul, sec, paths, removable) {
  ul.innerHTML = '';
  sec.hidden = !paths.length;
  for (const p of paths) {
    const node = treeState.byPath.get(p);
    const li = document.createElement('li');
    li.innerHTML = `
      <button type="button" class="${p === treeState.current ? 'cur' : ''}">
        <span class="t">${esc(node ? (node.title || node.name) : p.split('/').pop())}</span>
        ${removable ? `<span class="x" role="button" aria-label="削除">${icon('close', 11)}</span>` : ''}
      </button>`;
    li.querySelector('button').addEventListener('click', e => {
      if (e.target.closest('.x')) {
        if (removable === true) {           // 最近列表: 移除记录
          lsSet(LS_RECENT, recent().filter(x => x !== p));
          renderSideList(ul, sec, recent().filter(x => x !== p), true);
        } else {                            // 收藏列表: 取消收藏
          toggleStar(p);
          renderSide();
        }
        return;
      }
      location.hash = '#/doc/' + encodeURIComponent(p);
    });
    ul.appendChild(li);
  }
}

/* ---------- 收藏管理 ---------- */
let favManageMode = false;
function setupFavManage() {
  const btn = document.getElementById('fav-manage');
  if (!btn) return;
  btn.addEventListener('click', () => {
    favManageMode = !favManageMode;
    btn.textContent = favManageMode ? '完了' : '管理';
    document.getElementById('fav-list')?.classList.toggle('manage', favManageMode);
  });
}
setupFavManage();

/* ---------- 新建文件夹 ---------- */
async function newDirFlow(dirPath) {
  const name = await showdialog({
    title: '新規フォルダ',
    message: `${dirPath} の下に作成します。`,
    input: true, placeholder: 'フォルダ名', okText: '作成',
  });
  if (!name) return;
  // 后端无目录 API: 在新目录创建 README.md 占位 (create 的 dir 参数承担 mkdir parents)
  try {
    const dir = dirPath ? dirPath + '/' + name : name;
    await api('/api/doc/create', { method: 'POST', json: { dir, path: 'README', title: name } });
    toast('フォルダを作成しました');
    invalidateSearch();
    await refresh();
  } catch (e) {
    toast(e.message, 'err');
  }
}

/* 供外部查询标题 */
export function titleOf(path) {
  const n = treeState.byPath.get(path);
  return n ? (n.title || n.name) : path.split('/').pop().replace(/\.md$/, '');
}
