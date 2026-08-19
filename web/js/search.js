/* search.js — ⌘K 搜索: CJK 2-gram + 拉丁分词, AND 匹配, 标题×5/章节×3/正文×1 */
import { $, $$, esc, api } from './ui.js?v=22';

let index = null;
let loadingPromise = null;
let debounceTimer = null;
let activeIdx = -1;
let flatItems = [];

export function loadIndex(force = false) {
  if (index && !force) return Promise.resolve(index);
  if (loadingPromise && !force) return loadingPromise;
  loadingPromise = api('/api/search-index').then(d => {
    index = d.entries;
    loadingPromise = null;
    return index;
  }).catch(e => { loadingPromise = null; throw e; });
  return loadingPromise;
}

/* 文档变更(保存/新建/改名/移动/删除)后调用: 下次打开面板重新拉取 */
export function invalidate() {
  index = null;
}

/* ---------- 分词 ---------- */
export function tokenize(q) {
  const terms = [];
  const cjk = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\u3005]+/g;
  let last = 0, m;
  const pushLatin = s => {
    for (const w of s.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) || []) terms.push(w);
  };
  while ((m = cjk.exec(q))) {
    pushLatin(q.slice(last, m.index));
    const run = m[0];
    if (run.length === 1) terms.push(run);
    else for (let i = 0; i < run.length - 1; i++) terms.push(run.slice(i, i + 2));
    last = m.index + run.length;
  }
  pushLatin(q.slice(last));
  return [...new Set(terms)];
}

/* ---------- 查询 ---------- */
function entryScore(e, terms, now) {
  const title = (e.title || '').toLowerCase();
  const text = e.text.toLowerCase();
  let score = 0;
  const hits = [];
  for (const t of terms) {
    let s = 0;
    let ti = title.indexOf(t);
    if (ti >= 0) { s += 5; hits.push({ at: 'title', i: ti }); }
    for (const sec of e.sections) {
      const si = sec.title.toLowerCase().indexOf(t);
      if (si >= 0) { s += 3; }
    }
    let bi = text.indexOf(t);
    let freq = 0;
    while (bi >= 0 && freq < 100) { freq++; bi = text.indexOf(t, bi + t.length); }
    if (!freq && ti < 0 && !e.sections.some(x => x.title.toLowerCase().includes(t))) return null; // AND
    s += freq;
    score += s;
  }
  if (now - e.mtime * 1000 < 7 * 86400 * 1000) score += 0.5;
  return { score, hits };
}

/* 命中位置 → 所属章节 */
function sectionFor(e, pos) {
  if (!e.sections || !e.sections.length) return null;
  const text = e.text.toLowerCase();
  let cur = null;
  for (const s of e.sections) {
    const si = text.indexOf(s.title.toLowerCase(), cur ? cur._end : 0);
    if (si < 0) continue;
    s._end = si + s.title.length;
    if (si <= pos) cur = s;
    else break;
  }
  return cur;
}

export function query(q, limit = 20) {
  if (!index) return [];
  const terms = tokenize(q);
  if (!terms.length) return [];
  const now = Date.now();
  const scored = [];
  for (const e of index) {
    const r = entryScore(e, terms, now);
    if (r) scored.push({ e, score: r.score });
  }
  scored.sort((a, b) => b.score - a.score || (b.e.mtime || 0) - (a.e.mtime || 0));
  const out = [];
  for (const { e } of scored.slice(0, limit)) {
    // 摘录: 第一个命中的 term 在正文的位置
    let pos = -1, anchor = null;
    for (const t of terms) {
      const i = e.text.toLowerCase().indexOf(t);
      if (i >= 0) { pos = i; break; }
    }
    if (pos < 0) {
      const tHit = terms.find(t => (e.title || '').toLowerCase().includes(t));
      if (tHit) pos = (e.title || '').toLowerCase().indexOf(tHit);
    }
    if (pos >= 0) anchor = sectionFor(e, pos) ? sectionFor(e, pos).id : null;
    const from = Math.max(0, pos - 24);
    const raw = e.text.slice(from, pos + 60);
    const marked = esc(raw).replace(
      new RegExp(`(${terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi'),
      '<mark>$1</mark>');
    out.push({
      path: e.path, title: e.title || e.path,
      anchor, excerpt: (from > 0 ? '…' : '') + marked + (pos + 60 < e.text.length ? '…' : ''),
    });
  }
  return out;
}

/* ---------- UI ---------- */
export function isOpen() { return !$('#search-panel').hidden; }

export function open() {
  const panel = $('#search-panel');
  panel.hidden = false;
  const input = $('#search-input');
  input.value = '';
  renderResults(null);
  input.focus();
  loadIndex().catch(() => {});
}

export function close() {
  $('#search-panel').hidden = true;
  activeIdx = -1;
}

function renderResults(results) {
  const box = $('#search-results');
  flatItems = [];
  activeIdx = -1;
  if (results === null) {
    box.innerHTML = '<div class="sr-empty">キーワードで全文検索します（⌘K）</div>';
    return;
  }
  if (!results.length) {
    box.innerHTML = '<div class="sr-empty">一致するドキュメントが見つかりませんでした。</div>';
    return;
  }
  box.innerHTML = '';
  for (const r of results) {
    const g = document.createElement('div');
    g.className = 'sr-group';
    const doc = document.createElement('button');
    doc.type = 'button';
    doc.className = 'sr-doc';
    doc.innerHTML = `<span class="t">${esc(r.title)}</span><span class="p">${esc(r.path)}</span>`;
    const go = () => gotoDoc(r, null);
    doc.addEventListener('click', go);
    g.appendChild(doc);
    flatItems.push({ el: doc, go });
    if (r.excerpt) {
      const line = document.createElement('button');
      line.type = 'button';
      line.className = 'sr-line';
      const sec = r.anchor ? `<span class="sec">${esc(secTitle(index, r.path, r.anchor))}</span>` : '';
      line.innerHTML = `${sec}${r.excerpt}`;
      const goLine = () => gotoDoc(r, r.anchor);
      line.addEventListener('click', goLine);
      g.appendChild(line);
      flatItems.push({ el: line, go: goLine });
    }
    box.appendChild(g);
  }
}

function secTitle(idx, path, anchor) {
  const e = (idx || []).find(x => x.path === path);
  const s = e && e.sections.find(x => x.id === anchor);
  return s ? s.title : '';
}

function gotoDoc(r, anchor) {
  close();
  const hash = '#/doc/' + encodeURIComponent(r.path) + (anchor ? '?h=' + encodeURIComponent(anchor) : '');
  if (location.hash === hash) {
    // 已在该文档: 直接滚动
    document.dispatchEvent(new CustomEvent('chishiki:anchor', { detail: anchor }));
  } else {
    location.hash = hash;
  }
}

export function init() {
  const input = $('#search-input');
  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const q = input.value.trim();
      if (!q) { renderResults(null); return; }
      loadIndex().then(() => renderResults(query(q))).catch(() => renderResults([]));
    }, 120);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!flatItems.length) return;
      const d = e.key === 'ArrowDown' ? 1 : -1;
      activeIdx = (activeIdx + d + flatItems.length) % flatItems.length;
      flatItems.forEach((it, i) => it.el.classList.toggle('active', i === activeIdx));
      flatItems[activeIdx].el.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const it = flatItems[activeIdx] || flatItems[0];
      if (it) it.go();
    }
  });
  $('#search-panel').addEventListener('pointerdown', e => {
    if (e.target === $('#search-panel')) close();
  });
}
