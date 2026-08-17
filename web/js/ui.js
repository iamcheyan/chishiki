/* ui.js — 自绘控件: 对话框 / 下拉菜单 / toast / 图标 / api (零原生控件) */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ---------- 内联 SVG 图标 (stroke 1.5) ---------- */
const PATHS = {
  file: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5"/>',
  folder: '<path d="M3.5 6a1.5 1.5 0 0 1 1.5-1.5h4l2 2.5h8.5A1.5 1.5 0 0 1 20.5 8.5V18a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18z"/>',
  caret: '<path d="M9 5l7 7-7 7"/>',
  star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>',
  pencil: '<path d="M17 3.5l3.5 3.5L8 19.5 3.5 20.5 4.5 16z"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6.5 7l1 13h9l1-13M9 7V4h6v3"/>',
  move: '<path d="M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20"/>',
  image: '<rect x="3.5" y="5" width="17" height="14" rx="1.5"/><circle cx="9" cy="10" r="1.6"/><path d="M3.5 16.5l5-4.5 4 3.5 3.5-3 4.5 4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="1.5"/><path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  h: '<path d="M5 5v14M15 5v14M5 12h10"/>',
  dots: '<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
  bold: '<path d="M7 4h6a3.5 3.5 0 0 1 0 7H7zM7 11h7a3.5 3.5 0 0 1 0 7H7z"/>',
  italic: '<path d="M10 4h8M6 20h8M14.5 4l-5 16"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>',
  quote: '<path d="M5 15a4 4 0 0 1 4-8v4a4 4 0 0 1-4 4zM13 15a4 4 0 0 1 4-8v4a4 4 0 0 1-4 4z"/><path d="M9 19c4-1 7-4 7-8"/>',
  code: '<path d="M8 6l-5 6 5 6M16 6l5 6-5 6"/>',
  link: '<path d="M10 14a4 4 0 0 0 6 .5l3-3a4 4 0 0 0-5.7-5.7L11.5 7.6"/><path d="M14 10a4 4 0 0 0-6-.5l-3 3a4 4 0 0 0 5.7 5.7l1.8-1.8"/>',
};
export function icon(name, size = 16) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] || ''}</svg>`;
}

/* ---------- api ---------- */
export async function api(path, opts = {}) {
  let url = path;
  if (opts.query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query)) qs.set(k, v);
    url += (url.includes('?') ? '&' : '?') + qs.toString();
  }
  const init = { headers: {} };
  if (opts.method === 'POST' && opts.json !== undefined) {
    init.method = 'POST';
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.json);
  } else if (opts.method === 'POST' && opts.form) {
    init.method = 'POST';
    init.body = opts.form;
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw new Error('ネットワークエラー');
  }
  let data = null;
  try { data = await res.json(); } catch (e) { /* ignore */ }
  if (!res.ok || (data && data.ok === false)) {
    throw new Error((data && data.error) || `HTTP ${res.status}`);
  }
  return data;
}

/* ---------- toast ---------- */
const toastRoot = () => $('#toast-root');
export function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast' + (type === 'err' ? ' err' : '');
  el.textContent = msg;
  toastRoot().appendChild(el);
  setTimeout(() => { el.classList.add('out'); }, 2200);
  setTimeout(() => { el.remove(); }, 2600);
}

/* ---------- 对话框 (自绘 confirm/prompt) ---------- */
let activeDlg = null;
export function dialogOpen() { return !!activeDlg; }

/**
 * showdialog({title, message, input?, value?, placeholder?, okText, cancelText?, danger?, allowEmpty?})
 * → Promise<字符串|true|null>  input 模式返回输入值或 null; 按钮模式返回 true/null
 */
export function showdialog(o = {}) {
  return new Promise(resolve => {
    if (activeDlg) activeDlg._close(null);
    const prevFocus = document.activeElement;
    const scrim = document.createElement('div');
    scrim.className = 'dlg-scrim';
    const hasInput = !!o.input;
    scrim.innerHTML = `
      <div class="dlg" role="dialog" aria-modal="true" aria-label="${esc(o.title || '')}">
        <h3>${esc(o.title || '')}</h3>
        ${o.message ? `<p>${esc(o.message)}</p>` : ''}
        ${hasInput ? `<input type="text" value="${esc(o.value || '')}" placeholder="${esc(o.placeholder || '')}" spellcheck="false">` : ''}
        <div class="dlg-btns">
          <button type="button" class="dlg-cancel">${esc(o.cancelText || 'キャンセル')}</button>
          <button type="button" class="dlg-ok ${o.danger ? 'danger' : 'primary'}">${esc(o.okText || 'OK')}</button>
        </div>
      </div>`;
    const input = scrim.querySelector('input');
    const btnOk = scrim.querySelector('.dlg-ok');
    const btnCancel = scrim.querySelector('.dlg-cancel');

    function done(val) {
      if (!scrim.isConnected) return;
      scrim.remove();
      document.removeEventListener('keydown', onKey, true);
      activeDlg = null;
      if (prevFocus && prevFocus.isConnected) prevFocus.focus();
      resolve(val);
    }
    scrim._close = done;

    function okAction() {
      if (hasInput) {
        const v = input.value.trim();
        if (!v && !o.allowEmpty) { input.focus(); return; }
        done(v);
      } else done(true);
    }
    btnOk.addEventListener('click', okAction);
    btnCancel.addEventListener('click', () => done(null));
    scrim.addEventListener('pointerdown', e => { if (e.target === scrim) done(null); });

    function onKey(e) {
      if (!scrim.isConnected) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); }
      else if (e.key === 'Enter' && e.target === input) { e.preventDefault(); okAction(); }
      else if (e.key === 'Tab') {
        const f = [input, btnCancel, btnOk].filter(Boolean);
        const i = f.indexOf(document.activeElement);
        e.preventDefault();
        f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
      }
    }
    document.addEventListener('keydown', onKey, true);

    $('#dialog-root').appendChild(scrim);
    activeDlg = scrim;
    (hasInput ? input : btnOk).focus();
    if (hasInput) input.select();
  });
}

/* ---------- 下拉菜单 (ypop 模式) ---------- */
let activeMenu = null;
export function menuOpen() { return !!activeMenu; }

/**
 * menu(anchorEl, items) → Promise<value|null>
 * items: [{label, value, icon?, danger?, checked?}] | '-' 分隔线
 */
export function menu(anchor, items) {
  return new Promise(resolve => {
    closeMenus();
    const m = document.createElement('div');
    m.className = 'ypop-menu';
    m.setAttribute('role', 'menu');
    m.innerHTML = '<div class="ypop-sheet-handle" aria-hidden="true"></div>';
    for (const it of items) {
      if (it === '-') {
        const hr = document.createElement('div');
        hr.style.cssText = 'height:1px;background:var(--rule);margin:5px 8px;';
        m.appendChild(hr);
        continue;
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ypop-item' + (it.danger ? ' danger' : '');
      b.setAttribute('role', 'menuitem');
      b.innerHTML = `${it.icon ? icon(it.icon, 15) : ''}<span>${esc(it.label)}</span>${it.checked ? `<span class="chk">${icon('check', 14)}</span>` : ''}`;
      b.addEventListener('click', () => { closeMenus(); resolve(it.value); });
      m.appendChild(b);
    }
    function closeMenus() {
      if (activeMenu) { activeMenu.el.remove(); document.removeEventListener('pointerdown', onDoc, true); activeMenu = null; }
    }
    function onDoc(e) {
      if (!m.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) {
        closeMenus(); resolve(null);
      }
    }
    function onKey(e) {
      if (e.key === 'Escape' && activeMenu && activeMenu.el === m) {
        e.stopPropagation();
        closeMenus(); resolve(null);
      }
    }
    $('#menu-root').appendChild(m);
    activeMenu = { el: m };
    const r = anchor.getBoundingClientRect();
    const mw = m.offsetWidth, mh = m.offsetHeight;
    let x = r.right - mw;
    if (x < 8) x = Math.min(r.left, innerWidth - mw - 8);
    let y = r.bottom + 6;
    if (y + mh > innerHeight - 8) y = Math.max(8, r.top - mh - 6);
    m.style.left = Math.max(8, x) + 'px';
    m.style.top = y + 'px';
    document.addEventListener('pointerdown', onDoc, true);
    document.addEventListener('keydown', onKey, true);
    m._close = () => { closeMenus(); resolve(null); };
  });
}
export function closeMenuIfOpen() {
  if (activeMenu && activeMenu.el && activeMenu.el._close) activeMenu.el._close();
}

/* ---------- 剪贴板 ---------- */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none;';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      return true;
    } catch (e2) {
      return false;
    }
  }
}

/* ---------- 杂项 ---------- */
export function fmtTime(ts) {
  const d = new Date(ts * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}
/* 图片 src → /files/ 绝对地址 (相对=文档所在目录; /开头=docs 根) */
export function fileUrl(docPath, src) {
  if (/^(https?:|data:)/i.test(src)) return src;
  let rel = src.replace(/^\.?\//, '');
  if (src.startsWith('/')) rel = src.slice(1);
  else {
    const dir = docPath.includes('/') ? docPath.slice(0, docPath.lastIndexOf('/')) : '';
    rel = dir ? dir + '/' + rel : rel;
  }
  return '/files/' + rel.split('/').map(encodeURIComponent).join('/');
}
