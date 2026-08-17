/* viewer.js — 阅读渲染(图片重写/表格包裹) + 大纲滚动spy + Lightbox */
import { $, $$, esc, api, fileUrl, icon, fmtTime } from './ui.js?v=15';

export const state = { currentPath: null, pendingAnchor: null };

/* ---------- Lightbox ---------- */
const lb = {
  images: [], idx: 0, scale: 1, tx: 0, ty: 0,
  onDelete: null, el: null, img: null, stage: null, count: null, delBtn: null,
  pointers: new Map(), pinchDist: 0, dragId: null, lastX: 0, lastY: 0,
  moved: false};

function lbShow() {
  const im = lb.images[lb.idx];
  if (!im) return;
  lb.scale = 1; lb.tx = 0; lb.ty = 0;
  applyTransform();
  lb.img.style.opacity = '0';
  const pre = new Image();
  pre.onload = pre.onerror = () => { lb.img.src = im.url; lb.img.alt = im.alt || im.name || ''; lb.img.style.opacity = '1'; };
  pre.src = im.url;
  lb.count.textContent = `${lb.idx + 1} / ${lb.images.length}`;
  lb.delBtn.hidden = !lb.onDelete;
}
function applyTransform() {
  lb.img.style.transform = `translate(${lb.tx}px,${lb.ty}px) scale(${lb.scale})`;
}
function zoomAt(factor) {
  const prev = lb.scale;
  lb.scale = Math.min(8, Math.max(1, prev * factor));
  if (lb.scale === 1) { lb.tx = 0; lb.ty = 0; }
  else {
    const k = lb.scale / prev;
    lb.tx *= k; lb.ty *= k;
  }
  applyTransform();
}
function lbNav(d) {
  if (!lb.images.length) return;
  lb.idx = (lb.idx + d + lb.images.length) % lb.images.length;
  lbShow();
}

export function lightboxOpen(images, idx, opts = {}) {
  lb.images = images; lb.idx = idx || 0;
  lb.onDelete = opts.onDelete || null;
  if (!lb.el) {
    lb.el = $('#lightbox');
    lb.img = $('#lb-img');
    lb.stage = $('#lb-stage');
    lb.count = $('#lb-count');
    lb.delBtn = $('#lb-delete');
    $('#lb-close').addEventListener('click', lightboxClose);
    $('#lb-prev').addEventListener('click', () => lbNav(-1));
    $('#lb-next').addEventListener('click', () => lbNav(1));
    lb.delBtn.addEventListener('click', () => { if (lb.onDelete) lb.onDelete(lb.images[lb.idx]); });

    lb.stage.addEventListener('wheel', e => {
      e.preventDefault();
      zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX, e.clientY);
    }, { passive: false });
    lb.img.addEventListener('dblclick', () => { lb.scale = 1; lb.tx = 0; lb.ty = 0; applyTransform(); });
    /* 拖拽平移 */
    lb.stage.addEventListener('pointerdown', e => {
      if (e.isPrimary === false) return;
      if (lb.pointers.size >= 1 && lb.pointers.has(e.pointerId)) return;
      lb.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (lb.pointers.size === 1 && lb.scale > 1) {
        lb.dragId = e.pointerId; lb.lastX = e.clientX; lb.lastY = e.clientY;
        lb.stage.setPointerCapture(e.pointerId);
      } else if (lb.pointers.size === 2) {
        lb.dragId = null;
        const [a, b] = [...lb.pointers.values()];
        lb.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      }
    });
    lb.stage.addEventListener('pointermove', e => {
      if (!lb.pointers.has(e.pointerId)) return;
      lb.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (lb.pointers.size === 2) {
        const [a, b] = [...lb.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (lb.pinchDist > 0) zoomAt(d / lb.pinchDist, (a.x + b.x) / 2, (a.y + b.y) / 2);
        lb.pinchDist = d;
      } else if (e.pointerId === lb.dragId && lb.scale > 1) {
        lb.tx += e.clientX - lb.lastX; lb.ty += e.clientY - lb.lastY;
        lb.lastX = e.clientX; lb.lastY = e.clientY;
        applyTransform();
      }
    });
    const up = e => {
      lb.pointers.delete(e.pointerId);
      if (lb.pointers.size < 2) lb.pinchDist = 0;
      if (e.pointerId === lb.dragId) lb.dragId = null;
    };
    lb.stage.addEventListener('pointerup', up);
    lb.stage.addEventListener('pointercancel', up);
    /* 点击空白关闭: 目标是 stage 本身(非图片/按钮), 且没有拖动过 */
    lb.stage.addEventListener('click', e => {
      if (e.target !== lb.stage) return;
      if (lb.dragId !== null) return;                  // 刚拖完
      if (lb.moved) { lb.moved = false; return; }      // 本轮 pointer 有位移
      lightboxClose();
    });
    lb.stage.addEventListener('pointerdown', e => {
      if (e.target === lb.stage) lb._downPt = { x: e.clientX, y: e.clientY };
    }, true);
    lb.stage.addEventListener('pointerup', e => {
      if (lb._downPt) {
        const d = Math.hypot(e.clientX - lb._downPt.x, e.clientY - lb._downPt.y);
        lb.moved = d > 6;
        lb._downPt = null;
      }
    }, true);
    /* 单指轻扫切换 (scale=1 时) */
    let swipeX = null, swipeY = null;
    lb.stage.addEventListener('touchstart', e => {
      if (e.touches.length === 1) { swipeX = e.touches[0].clientX; swipeY = e.touches[0].clientY; }
    }, { passive: true });
    lb.stage.addEventListener('touchend', e => {
      if (swipeX === null || lb.scale > 1) { swipeX = null; return; }
      const t = e.changedTouches[0];
      const dx = t.clientX - swipeX, dy = t.clientY - swipeY;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) lbNav(dx < 0 ? 1 : -1);
      swipeX = null;
    }, { passive: true });
  }
  lb.el.hidden = false;
  document.body.style.overflow = 'hidden';
  $('#lb-close').focus();
  lbShow();
}
export function lightboxClose() {
  if (!lb.el) return;
  lb.el.hidden = true;
  document.body.style.overflow = '';
}
export function lightboxIsOpen() { return lb.el && !lb.el.hidden; }

/* ---------- 文档渲染 ---------- */
export async function showDoc(path, anchor) {
  state.currentPath = path;
  state.pendingAnchor = anchor || null;
  const main = $('#main');
  main.scrollTop = 0;
  const data = await api('/api/doc', { query: { path, rendered: 1 } });
  if (state.currentPath !== path) return;

  const body = $('#md-body');
  body.innerHTML = data.html;
  /* 阅读位置恢复 */
  const saved = readScroll(path);
  if (!anchor && saved > 0) main.scrollTop = saved;

  /* 标题栏信息 */
  const h1 = body.querySelector('h1');
  $('#doc-title').textContent = (h1 ? h1.textContent : path.split('/').pop().replace(/\.md$/, '')) || path;
  $('#doc-path').textContent = path;
  $('#doc-mtime').textContent = fmtTime(data.mtime);
  document.dispatchEvent(new CustomEvent('chishiki:doc-loaded'));

  /* 图片: src 重写 + 点击进 lightbox */
  const imgs = $$('img', body);
  const lbImages = [];
  imgs.forEach(im => {
    const raw = im.getAttribute('src') || '';
    im.src = fileUrl(path, raw);
    if (!im.alt) im.alt = im.getAttribute('title') || '画像';
    lbImages.push({ url: im.src, alt: im.alt, name: raw.split('/').pop() });
  });
  /* 代码块: 快速复制按钮(右上角, hover 显现, 自绘无原生) */
  $$('pre', body).forEach(pre => {
    pre.style.position = 'relative';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pre-copy';
    btn.textContent = 'コピー';
    btn.setAttribute('aria-label', 'コードをコピー');
    btn.addEventListener('click', async () => {
      const code = pre.querySelector('code');
      const text = (code || pre).textContent;
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = '✓ コピー済み';
        btn.classList.add('copied');
      } catch (e) {
        // 剪贴板不可用(非安全上下文): textarea 兜底
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); ta.remove();
        btn.textContent = '✓ コピー済み';
        btn.classList.add('copied');
      }
      setTimeout(() => { btn.textContent = 'コピー'; btn.classList.remove('copied'); }, 1600);
    });
    pre.appendChild(btn);
  });

  imgs.forEach((im, i) => {
    im.addEventListener('click', () => lightboxOpen(lbImages, i));
    im.setAttribute('tabindex', '0');
    im.setAttribute('role', 'button');
    im.setAttribute('aria-label', '画像を拡大');
    im.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); lightboxOpen(lbImages, i); } });
  });

  /* 表格包裹可横滚 */
  $$('table', body).forEach(t => {
    if (t.parentElement.classList.contains('table-wrap')) return;
    const w = document.createElement('div');
    w.className = 'table-wrap';
    t.replaceWith(w);
    w.appendChild(t);
  });

  buildOutline(body);
  if (state.pendingAnchor) {
    const target = body.querySelector(`[id="${CSS.escape(state.pendingAnchor)}"]`);
    if (target) setTimeout(() => target.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
    state.pendingAnchor = null;
  }
}

/* ---------- 大纲 + 滚动 spy ---------- */
let spyHeadings = [];
let spyLinks = [];

export function buildOutline(body) {
  const nav = $('#outline-nav');
  const heads = $$('h2, h3', body);
  nav.innerHTML = '';
  spyHeadings = heads;
  spyLinks = [];
  if (!heads.length) { $('#outline').hidden = true; return; }
  heads.forEach(h => {
    const a = document.createElement('a');
    a.href = 'javascript:void 0';
    a.textContent = h.textContent;
    a.className = h.tagName === 'H3' ? 'l3' : '';
    a.addEventListener('click', e => {
      e.preventDefault();
      h.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    nav.appendChild(a);
    spyLinks.push(a);
  });
  $('#outline').hidden = false;
}

export function hideOutline() {
  $('#outline').hidden = true;
  spyHeadings = []; spyLinks = [];
}

let spyTick = false;
export function spyScroll() {
  if (spyTick) return;
  spyTick = true;
  requestAnimationFrame(() => {
    spyTick = false;
    if (!spyHeadings.length) return;
    const main = $('#main');
    const line = main.getBoundingClientRect().top + 160;
    let cur = -1;
    for (let i = 0; i < spyHeadings.length; i++) {
      if (spyHeadings[i].getBoundingClientRect().top <= line) cur = i;
    }
    spyLinks.forEach((a, i) => a.classList.toggle('cur', i === cur));
  });
}


/* ---------- 阅读位置记忆 ---------- */
const SCROLL_KEY = 'chishiki:scroll';
function readScroll(path) {
  try { return (JSON.parse(localStorage.getItem(SCROLL_KEY) || '{}')[path]) || 0; } catch (e) { return 0; }
}
let _scrollTimer = null;
export function watchScroll(getPath) {
  const main = document.getElementById('main');
  main.addEventListener('scroll', () => {
    if (_scrollTimer) return;
    _scrollTimer = setTimeout(() => {
      _scrollTimer = null;
      const p = getPath();
      if (!p || !main.scrollTop) return;
      try {
        const m = JSON.parse(localStorage.getItem(SCROLL_KEY) || '{}');
        m[p] = main.scrollTop;
        const keys = Object.keys(m);
        if (keys.length > 200) delete m[keys[0]];   // 容量保护
        localStorage.setItem(SCROLL_KEY, JSON.stringify(m));
      } catch (e) { /* noop */ }
    }, 400);
  }, { passive: true });
}
