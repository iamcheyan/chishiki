/* editor.js — 编辑器: textarea+分屏预览 / 工具栏 / 贴图上传 / 草稿 / Save / 冲突检测 / 文档Actions */
import { $, $$, esc, api, icon, showdialog, menu, toast, fmtTime, fileUrl } from './ui.js?v=26';
import * as tree from './tree.js?v=26';
import * as search from './search.js?v=26';

const DRAFT_PREFIX = 'chishiki:draft:';

const ed = {
  path: null, baseContent: '', baseMtime: 0,
  dirty: false, saving: false, conflict: false,
  timer: null, draftTimer: null, pollTimer: null,
  els: null,
};

/* ================= 本地 Markdown 渲染 (预览用, 与后端口径一致) ================= */

function slug(s) {
  return s.replace(/[^\w\s\-一-龥ぁ-んァ-ヶ]/g, '').trim().toLowerCase().replace(/\s+/g, '-');
}
function escText(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escAttr(s) { return escText(s).replace(/"/g, '&quot;'); }

function inlineMd(s, docPath) {
  const slots = [];
  const stash = h => { slots.push(h); return `\x00${slots.length - 1}\x00`; };
  // 行内代码优先
  const codeParts = s.split(/(`[^`]*`)/);
  s = codeParts.map(p => {
    if (p.length > 1 && p.startsWith('`') && p.endsWith('`')) return stash(`<code>${p[1] === '`' ? '' : escText(p.slice(1, -1))}</code>`);
    return p;
  }).join('');
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (m, alt, src, title) =>
    stash(`<img src="${escAttr(fileUrl(docPath, src))}" alt="${escAttr(alt || 'Image')}"${title ? ` title="${escAttr(title)}"` : ''} class="md-img" loading="lazy">`));
  // 链接
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, txt, href) => {
    const ext = /^[a-z]+:\/\//.test(href) ? ' target="_blank" rel="noopener"' : '';
    return stash(`<a href="${escAttr(href)}"${ext}>${escText(txt)}</a>`);
  });
  // 裸 URL
  s = s.replace(/(?<!["'>=([])(https?:\/\/[^\s<)\]]+)/g, u =>
    stash(`<a href="${escAttr(u)}" target="_blank" rel="noopener">${escText(u)}</a>`));
  s = escText(s);
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, '<em>$1</em>');
  s = s.replace(/___([^_]+)___/g, '<strong><em>$1</em></strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, '<em>$1</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return s.replace(/\x00(\d+)\x00/g, (m, i) => slots[+i]);
}

function inlinePlain(s) {
  return s.replace(/`([^`]*)`/g, '$1').replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_~]+/g, '').trim();
}


export function renderPreview(md, docPath) {
  const lines = md.split('\n');
  const out = [];
  let i = 0, n = lines.length;
  let inList = null, taskOpen = false, inQuote = false;
  const closeList = () => { if (taskOpen) { out.push('</ul>'); taskOpen = false; } if (inList) { out.push(`</${inList}>`); inList = null; } };
  const closeQuote = () => { if (inQuote) { out.push('</blockquote>'); inQuote = false; } };
  const isSep = l => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(l) && l.includes('-');

  while (i < n) {
    const line = lines[i];
    let m;
    if ((m = line.match(/^\s*(```|~~~)\s*(\S*)/))) {
      closeList(); closeQuote();
      const fence = m[1]; const buf = [];
      i++;
      while (i < n && !lines[i].match(new RegExp('^\\s*' + fence))) { buf.push(lines[i]); i++; }
      i++;
      out.push(`<pre><code>${escText(buf.join('\n'))}</code></pre>`);
      continue;
    }
    if (/^\s*!>\s*/.test(line)) {
      closeList(); closeQuote();
      const buf = [line.replace(/^\s*!>\s?/, '')];
      i++;
      while (i < n && /^\s*!>\s*/.test(lines[i])) { buf.push(lines[i].replace(/^\s*!>\s?/, '')); i++; }
      out.push(`<blockquote class="callout callout-warn">${inlineMd(buf.join('\n'), docPath)}</blockquote>`);
      continue;
    }
    if (/^\s*\?>\s*/.test(line)) {
      closeList(); closeQuote();
      const buf = [line.replace(/^\s*\?>\s?/, '')];
      i++;
      while (i < n && /^\s*\?>\s*/.test(lines[i])) { buf.push(lines[i].replace(/^\s*\?>\s?/, '')); i++; }
      out.push(`<blockquote class="callout callout-tip">${inlineMd(buf.join('\n'), docPath)}</blockquote>`);
      continue;
    }
    if ((m = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/))) {
      closeList(); closeQuote();
      const lvl = m[1].length;
      out.push(`<h${lvl} id="${escAttr(slug(inlinePlain(m[2])))}">${inlineMd(m[2], docPath)}</h${lvl}>`);
      i++; continue;
    }
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) { closeList(); closeQuote(); out.push('<hr>'); i++; continue; }
    if (line.includes('|') && i + 1 < n && isSep(lines[i + 1])) {
      closeList(); closeQuote();
      const row = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const head = row(line);
      const aligns = row(lines[i + 1]).map(c =>
        c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left');
      i += 2;
      const rows = [];
      while (i < n && lines[i].includes('|') && lines[i].trim()) { rows.push(row(lines[i])); i++; }
      const th = head.map((c, j) => `<th style="text-align:${aligns[j] || 'left'}">${inlineMd(c, docPath)}</th>`).join('');
      const tb = rows.map(r => '<tr>' + r.map((c, j) =>
        `<td style="text-align:${aligns[j] || 'left'}">${inlineMd(c, docPath)}</td>`).join('') + '</tr>').join('');
      out.push(`<table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table>`);
      continue;
    }
    if (/^\s*>/.test(line)) {
      if (!inQuote) { closeList(); out.push('<blockquote>'); inQuote = true; }
      out.push(inlineMd(line.replace(/^\s*>\s?/, ''), docPath));
      i++; continue;
    }
    closeQuote();
    if ((m = line.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/))) {
      if (!taskOpen) { closeList(); out.push('<ul class="task-list">'); taskOpen = true; }
      const chk = m[1].toLowerCase() === 'x' ? ' checked' : '';
      out.push(`<li class="task-item"><label><input type="checkbox"${chk} disabled>${inlineMd(m[2], docPath)}</label></li>`);
      i++; continue;
    }
    if (taskOpen) { out.push('</ul>'); taskOpen = false; }
    if ((m = line.match(/^\s*[-*+]\s+(.*)$/)) || (m = line.match(/^\s*(\d+)[.)]\s+(.*)$/))) {
      const content = m[1] !== undefined && line.match(/^\s*[-*+]\s+/) ? m[1] : m[2];
      const want = /^\s*[-*+]\s+/.test(line) ? 'ul' : 'ol';
      if (inList !== want) { closeList(); out.push(`<${want}>`); inList = want; }
      out.push(`<li>${inlineMd(content, docPath)}</li>`);
      i++; continue;
    }
    closeList();
    if (!line.trim()) { i++; continue; }
    const para = [line]; i++;
    while (i < n && lines[i].trim() && !/^(#{1,6}\s|>|\s*[-*+]\s|\s*\d+[.)]\s|```|~~~|\|.*\|\s*$|!\[|\?>|!>)/.test(lines[i])) {
      para.push(lines[i]); i++;
    }
    out.push(`<p>${inlineMd(para.join('\n'), docPath)}</p>`);
  }
  closeList(); closeQuote();
  return out.join('');
}

/* ================= 编辑器 ================= */

export async function openEditor(path) {
  const data = await api('/api/doc', { query: { path } });
  const view = $('#view-editor');
  view.innerHTML = `
    <div class="ed-banner" id="ed-banner" hidden></div>
    <div class="ed-head">
      <button type="button" class="icon-btn ed-back" aria-label="Back">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>
      </button>
      <span class="ed-title">${esc(tree.titleOf(path))}<span class="dirty-dot" title="Unsaved"></span></span>
      <div class="seg" role="group" aria-label="View mode">
        <button type="button" data-mode="edit">Edit</button>
        <button type="button" data-mode="split" class="on">Split</button>
        <button type="button" data-mode="prev">Preview</button>
      </div>
    </div>
    <div class="ed-toolbar" role="toolbar" aria-label="Formatting"></div>
    <div class="ed-split">
      <div class="ed-edit"><textarea id="ed-textarea" spellcheck="false" aria-label="Markdown source"></textarea></div>
      <div class="ed-prev"><div class="md-body" id="ed-preview" aria-label="Preview"></div></div>
    </div>
    <div class="ed-status">
      <span id="ed-count"></span><span id="ed-mtime"></span>
      <span class="grow"></span>
      <button type="button" class="ed-save-btn">Save <kbd>⌘S</kbd></button>
    </div>`;
  ed.els = {
    view, banner: $('#ed-banner', view), ta: $('#ed-textarea', view), prev: $('#ed-preview', view),
    split: $('.ed-split', view), count: $('#ed-count', view), mtime: $('#ed-mtime', view),
    saveBtn: $('.ed-save-btn', view),
  };
  ed.path = path;
  ed.baseContent = data.content;
  ed.baseMtime = data.mtime;
  ed.dirty = false; ed.conflict = false;
  ed.els.ta.value = data.content;
  buildToolbar();
  updateStatus();
  renderPrev();
  bindEvents();

  // 草稿检测
  const draft = getDraft(path);
  if (draft && draft.content !== data.content) showBanner('draft', draft);
}

function getDraft(path) {
  try {
    const raw = localStorage.getItem(DRAFT_PREFIX + path);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
function clearDraft(path) { try { localStorage.removeItem(DRAFT_PREFIX + path); } catch (e) { /* noop */ } }

function showBanner(kind, draft) {
  const b = ed.els.banner;
  b.hidden = false;
  if (kind === 'draft') {
    b.className = 'ed-banner conflict-bar';
    b.innerHTML = `<span class="msg">A draft is available（${esc(fmtTime(draft.ts))}）</span>
      <button type="button" class="b-restore">Restore draft</button>
      <button type="button" class="b-discard">Discard</button>`;
    b.querySelector('.b-restore').addEventListener('click', () => {
      ed.els.ta.value = draft.content;
      b.hidden = true;
      markDirty(); renderPrev(); updateStatus();
      toast('Draft restored');
    });
    b.querySelector('.b-discard').addEventListener('click', () => {
      clearDraft(ed.path); b.hidden = true;
    });
  } else if (kind === 'conflict') {
    b.className = 'ed-banner conflict-bar';
    b.innerHTML = `<span class="msg">This document was updated elsewhere</span>
      <button type="button" class="b-reload">Reload</button>
      <button type="button" class="b-keep">Keep current version</button>`;
    b.querySelector('.b-reload').addEventListener('click', async () => {
      if (ed.dirty) {
        const ok = await showdialog({ title: 'Reload', message: 'Unsaved changes will be lost. Continue?', okText: 'Discard and reload', danger: true });
        if (!ok) return;
      }
      const data = await api('/api/doc', { query: { path: ed.path } });
      ed.baseContent = data.content; ed.baseMtime = data.mtime;
      ed.els.ta.value = data.content;
      setDirty(false); renderPrev(); updateStatus();
      b.hidden = true; ed.conflict = false;
    });
    b.querySelector('.b-keep').addEventListener('click', () => {
      // 基准更新为服务端 mtime, 下次Save直接覆盖
      api('/api/doc', { query: { path: ed.path } }).then(d => { ed.baseMtime = d.mtime; }).catch(() => {});
      b.hidden = true; ed.conflict = false;
    });
  }
}

/* ---------- 工具栏 ---------- */
function buildToolbar() {
  const bar = $('.ed-toolbar', ed.els.view);
  const btn = (name, label, title) =>
    `<button type="button" class="tb" data-cmd="${name}" title="${title}" aria-label="${title}">${label}</button>`;
  bar.innerHTML = [
    btn('h1', 'H1', 'Heading 1'), btn('h2', 'H2', 'Heading 2'), btn('h3', 'H3', 'Heading 3'),
    '<span class="sep"></span>',
    btn('bold', icon('bold', 15), 'Bold'),
    btn('italic', icon('italic', 15), 'Italic'),
    '<span class="sep"></span>',
    btn('ul', icon('list', 15), 'List'),
    btn('quote', icon('quote', 15), 'Quote'),
    btn('code', icon('code', 15), 'Code'),
    '<span class="sep"></span>',
    btn('link', icon('link', 15), 'Link'),
    btn('image', icon('image', 15), 'Image'),
  ].join('');
  bar.addEventListener('click', e => {
    const b = e.target.closest('.tb');
    if (b) doCmd(b.dataset.cmd);
  });
}

function doCmd(cmd) {
  const ta = ed.els.ta;
  const v = ta.value;
  let s = ta.selectionStart, epos = ta.selectionEnd;
  const sel = v.slice(s, epos);
  const setVal = (text, selStart, selEnd) => {
    ta.value = text;
    ta.focus();
    ta.setSelectionRange(selStart, selEnd === undefined ? selStart : selEnd);
    markDirty(); renderPrev(); updateStatus();
  };
  const lineStart = v.lastIndexOf('\n', s - 1) + 1;
  const lineEnd = v.indexOf('\n', epos) === -1 ? v.length : v.indexOf('\n', epos);

  if (cmd === 'bold' || cmd === 'italic' || cmd === 'code') {
    const mark = cmd === 'bold' ? '**' : cmd === 'italic' ? '*' : '`';
    if (v.slice(s - mark.length, s) === mark && v.slice(epos, epos + mark.length) === mark) {
      // 切换取消
      setVal(v.slice(0, s - mark.length) + sel + v.slice(epos + mark.length), s - mark.length, epos - mark.length);
    } else {
      const inner = sel || (cmd === 'code' ? 'code' : cmd === 'bold' ? 'Bold' : 'Italic');
      setVal(v.slice(0, s) + mark + inner + mark + v.slice(epos), s + mark.length, s + mark.length + inner.length);
    }
  } else if (cmd === 'h1' || cmd === 'h2' || cmd === 'h3') {
    const hash = '#'.repeat(+cmd[1]) + ' ';
    const line = v.slice(lineStart, lineEnd);
    const stripped = line.replace(/^#{1,6}\s+/, '');
    const already = line.startsWith(hash);
    const nl = (already ? stripped : hash + stripped);
    setVal(v.slice(0, lineStart) + nl + v.slice(lineEnd), lineStart, lineStart + nl.length);
  } else if (cmd === 'ul' || cmd === 'quote') {
    const pre = cmd === 'ul' ? '- ' : '> ';
    const seg = v.slice(lineStart, lineEnd);
    const lines = seg.split('\n').map(l => l.startsWith(pre) ? l.slice(pre.length) : pre + l);
    const nl = lines.join('\n');
    setVal(v.slice(0, lineStart) + nl + v.slice(lineEnd), lineStart, lineStart + nl.length);
  } else if (cmd === 'link') {
    const inner = sel || 'Link';
    setVal(v.slice(0, s) + `[${inner}](url)` + v.slice(epos), s + 1 + inner.length + 3, s + 1 + inner.length + 6);
  } else if (cmd === 'image') {
    $('#file-input').dataset.target = ed.path;
    $('#file-input').click();
  }
}

/* ---------- 预览 / 状态 ---------- */
let prevTimer = null;
function renderPrev() {
  clearTimeout(prevTimer);
  prevTimer = setTimeout(() => {
    if (!ed.els) return;
    ed.els.prev.innerHTML = renderPreview(ed.els.ta.value, ed.path);
    $$('table', ed.els.prev).forEach(t => {
      const w = document.createElement('div');
      w.className = 'table-wrap';
      t.replaceWith(w); w.appendChild(t);
    });
  }, 180);
}

function updateStatus() {
  const v = ed.els.ta.value;
  const chars = [...v.replace(/\s/g, '')].length;
  const lines = v.split('\n').length;
  ed.els.count.textContent = `${chars}  chars · ${lines}  lines`;
  ed.els.mtime.textContent = ed.dirty ? 'Unsaved' : fmtTime(ed.baseMtime);
  ed.els.view.classList.toggle('dirty', ed.dirty);
  setSaveState(ed.dirty ? 'dirty' : 'saved', ed.dirty ? 'Unsaved' : 'Saved');
}

function setDirty(d) {
  ed.dirty = d;
  ed.els.view.classList.toggle('dirty', d);
  updateStatus();
}
function markDirty() {
  if (!ed.dirty) setDirty(true);
  else updateStatus();
  renderPrev();
  // 5s 草稿
  clearTimeout(ed.draftTimer);
  ed.draftTimer = setTimeout(() => {
    if (ed.dirty && ed.els) {
      try { localStorage.setItem(DRAFT_PREFIX + ed.path, JSON.stringify({ content: ed.els.ta.value, ts: Date.now() / 1000 })); } catch (err) { /* 满 */ }
    }
  }, 5000);
}

/* ---------- 事件 ---------- */
function bindEvents() {
  const ta = ed.els.ta;
  ta.addEventListener('input', markDirty);
  ta.addEventListener('keydown', e => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = ta.selectionStart;
      ta.setRangeText('  ', s, ta.selectionEnd, 'end');
      markDirty();
    }
  });
  // 同步滚动(近似)
  ta.addEventListener('scroll', () => {
    if (ta.scrollHeight - ta.clientHeight <= 4) return;
    const r = ta.scrollTop / (ta.scrollHeight - ta.clientHeight);
    ed.els.prev.scrollTop = r * (ed.els.prev.scrollHeight - ed.els.prev.clientHeight);
  });
  // 粘贴图片
  ta.addEventListener('paste', onPaste);
  // 拖拽图片
  ['dragenter', 'dragover'].forEach(ev => ta.addEventListener(ev, e => {
    if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); ta.classList.add('ed-drop-active'); }
  }));
  ['dragleave', 'drop'].forEach(ev => ta.addEventListener(ev, () => ta.classList.remove('ed-drop-active')));
  ta.addEventListener('drop', e => {
    const files = [...(e.dataTransfer ? e.dataTransfer.files : [])].filter(f => f.type.startsWith('image/'));
    if (files.length) {
      e.preventDefault();
      files.forEach(f => uploadImage(f));
    }
  });
  ed.els.saveBtn.addEventListener('click', save);
  $('.ed-back', ed.els.view).addEventListener('click', backToRead);
  $$('.seg button', ed.els.view).forEach(b => b.addEventListener('click', () => {
    $$('.seg button', ed.els.view).forEach(x => x.classList.toggle('on', x === b));
    const mode = b.dataset.mode;
    ed.els.split.className = 'ed-split' + (mode === 'edit' ? ' single-edit' : mode === 'prev' ? ' single-prev' : '');
    if (mode === 'prev') renderPrev();
  }));
}

async function onPaste(e) {
  const items = e.clipboardData ? [...e.clipboardData.items] : [];
  const images = items.filter(it => it.kind === 'file' && it.type.startsWith('image/')).map(it => it.getAsFile()).filter(Boolean);
  if (!images.length) return;
  e.preventDefault();
  for (const f of images) await uploadImage(f);
}

/* ---------- 图片上传 ---------- */
async function uploadImage(file) {
  const ta = ed.els.ta;
  const ph = '![Uploading…]';
  insertAtCursor(ph);
  const fd = new FormData();
  fd.append('path', ed.path);
  fd.append('file', file, file.name || 'image.png');
  try {
    const data = await api('/api/image', { method: 'POST', form: fd });
    replaceText(ph, data.markdown);
    toast('Image uploaded');
  } catch (err) {
    replaceText(ph, '');
    toast('Upload failed: ' + err.message, 'err');
  }
}
function insertAtCursor(text) {
  const ta = ed.els.ta;
  const s = ta.selectionStart, e = ta.selectionEnd;
  ta.setRangeText(text, s, e, 'end');
  ta.dispatchEvent(new Event('input'));
}
function replaceText(from, to) {
  const ta = ed.els.ta;
  const idx = ta.value.indexOf(from);
  if (idx === -1) { if (to) insertAtCursor(to); return; }
  ta.setRangeText(to, idx, idx + from.length, 'end');
  ta.dispatchEvent(new Event('input'));
}

/* 文件选择上传 (工具栏图片按钮) */
export function initFileInput() {
  const inp = $('#file-input');
  inp.addEventListener('change', () => {
    const files = [...inp.files].filter(f => f.type.startsWith('image/'));
    inp.value = '';
    if (!files.length || !ed.els) return;
    files.forEach(f => uploadImage(f));
  });
}
export async function save() {
  if (!ed.path || ed.saving || !ed.dirty) return;
  ed.saving = true;
  setSaveState('saving', 'Saving…');
  try {
    const data = await api('/api/doc/save', { method: 'POST', json: { path: ed.path, content: ed.els.ta.value, overwrite: true } });
    ed.baseMtime = Math.floor(Date.now() / 1000);
    ed.dirty = false;
    clearDraft(ed.path);
    updateStatus();
    setSaveState('saved', 'Saved');
    toast('Saved');
    search.invalidate();
    tree.refresh();
    return data;
  } catch (e) {
    setSaveState('dirty', 'Unsaved');
    toast('SaveFailed: ' + e.message, 'err');
    throw e;
  } finally {
    ed.saving = false;
  }
}

function setSaveState(cls, label) {
  const el = $('#save-state');
  el.className = 'save-state ' + cls;
  $('.label', el).textContent = label;
}

/* ---------- 退出 ---------- */
export async function backToRead() {
  if (ed.dirty) {
    const v = await showdialog({ title: 'Unsaved changes', message: 'Close without saving? The draft will be kept.', okText: 'Close' });
    if (!v) return;
  }
  const path = ed.path;
  leaveEditor();
  location.hash = '#/doc/' + encodeURIComponent(path);
}
/* 路由离开编辑器: 脏内容同步落草稿, 停定时器 (DOM 留给下次 openEditor 重建) */
export function leaveEditor() {
  if (ed.els && ed.dirty && ed.path) {
    try { localStorage.setItem(DRAFT_PREFIX + ed.path, JSON.stringify({ content: ed.els.ta.value, ts: Date.now() / 1000 })); } catch (e) { /* 满 */ }
  }
  clearTimeout(ed.draftTimer);
  clearInterval(ed.pollTimer);
  ed.conflict = false;
  if (ed.els) ed.els.view.innerHTML = '';
  ed.path = null; ed.els = null;
}
function teardown() {
  leaveEditor();
}
addEventListener('beforeunload', () => {
  if (ed.els && ed.dirty && ed.path) {
    try { localStorage.setItem(DRAFT_PREFIX + ed.path, JSON.stringify({ content: ed.els.ta.value, ts: Date.now() / 1000 })); } catch (e) { /* 满 */ }
  }
});

/* ---------- 外部变更轮询 ---------- */
export function startConflictWatch() {
  clearInterval(ed.pollTimer);
  ed.pollTimer = setInterval(async () => {
    if (!ed.path || ed.saving || ed.conflict) return;
    try {
      const d = await api('/api/doc', { query: { path: ed.path } });
      if (d.mtime > ed.baseMtime && d.content !== ed.els.ta.value && !ed.conflict) {
        // 服务器内容 != 我们基准(被外部改写)
        if (d.content !== ed.baseContent) {
          ed.conflict = true;
          showBanner('conflict');
        } else {
          ed.baseMtime = d.mtime;
        }
      }
    } catch (e) { /* 文档可能被删 */ }
  }, 20000);
}

/* ================= 文档Actions流 ================= */

export async function newDocFlow(dirPath) {
  let dir = dirPath;
  if (dir === undefined) {
    // 根部新建: 选择目录
    const dirs = [];
    const walk = nodes => { for (const nd of nodes || []) { if (nd.type === 'dir') { dirs.push(nd.path); walk(nd.children); } } };
    walk(tree.treeState.data);
    const items = [{ label: '（Root）', value: '' }, ...dirs.map(d => ({ label: d, value: d }))];
    dir = await menu($('#btn-newdoc-top'), items);
    if (dir === null) return;
  }
  const name = await showdialog({
    title: 'New document',
    message: dir ? `${dir} Create in` : 'Create in Root.',
    input: true, placeholder: 'Title', okText: 'Create',
  });
  if (!name) return;
  try {
    await api('/api/doc/create', { method: 'POST', json: { dir: dir || '', path: name, title: name } });
    toast('Created');
    search.invalidate();
    await tree.refresh();
    location.hash = '#/doc/' + encodeURIComponent((dir ? dir + '/' : '') + name + (name.endsWith('.md') ? '' : '.md'));
  } catch (e) {
    toast(e.message, 'err');
  }
}

export async function renameFlow(node) {
  const cur = node.name.replace(/\.md$/, '');
  const name = await showdialog({
    title: 'Rename', message: node.path, input: true, value: cur, okText: 'Change',
  });
  if (!name || name === cur) return;
  try {
    const d = await api('/api/doc/rename', { method: 'POST', json: { path: node.path, name } });
    search.invalidate();
    await tree.refresh();
    if (tree.treeState.current === node.path) location.hash = '#/doc/' + encodeURIComponent(d.path);
  } catch (e) { toast(e.message, 'err'); }
}

export async function moveFlow(node) {
  const dirs = [];
  const walk = nodes => { for (const nd of nodes || []) { if (nd.type === 'dir' && nd.path !== dirname(node.path)) { dirs.push(nd.path); walk(nd.children); } } };
  walk(tree.treeState.data);
  const items = [{ label: '（Root）', value: '' }, ...dirs.map(d => ({ label: d, value: d }))];
  const dest = await menu($('.tree .file.cur .a-more') || $('#btn-newdoc-top'), items);
  if (dest === null) return;
  try {
    const src = await api('/api/doc', { query: { path: node.path } });
    // 图片相对路径改写: 从旧目录相对 → 新目录相对
    const oldDir = dirname(node.path);
    const fname = node.path.split('/').pop();
    let content = src.content;
    content = content.replace(/(!\[[^\]]*\]\()([^)\s]+)(\))/g, (m, a, src2, z) => {
      if (/^(https?:|data:|\/)/i.test(src2)) return m;
      // 根文档(oldDir='')移出同样需要改写: normalizeDir('/x')→'x', relFromTo(dest,'x_assets')→'../x_assets'
      const absDir = normalizeDir(oldDir + '/' + (src2.startsWith('./') ? src2.slice(2) : src2));
      const rel = relFromTo(dest, absDir);
      return a + rel + z;
    });
    await api('/api/doc/save', { method: 'POST', json: { path: (dest ? dest + '/' : '') + fname, content } });
    await api('/api/doc/delete', { method: 'POST', json: { path: node.path } });
    toast('Moved');
    search.invalidate();
    await tree.refresh();
    if (tree.treeState.current === node.path) location.hash = '#/doc/' + encodeURIComponent((dest ? dest + '/' : '') + fname);
  } catch (e) { toast(e.message, 'err'); }
}
function dirname(p) { return p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''; }
function normalizeDir(p) {
  const parts = [];
  for (const seg of p.split('/')) {
    if (seg === '..') parts.pop(); else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}
function relFromTo(fromDir, toDir) {
  if (fromDir === toDir) return '';
  const f = fromDir ? fromDir.split('/') : [];
  const t = toDir.split('/');
  let i = 0;
  while (i < f.length && i < t.length && f[i] === t[i]) i++;
  const ups = f.slice(i).map(() => '..');
  return [...ups, ...t.slice(i)].join('/');
}

export async function deleteFlow(node) {
  const ok = await showdialog({
    title: 'Delete', message: `Delete “${node.title || node.name}”.This cannot be undone.`, okText: 'Delete', danger: true,
  });
  if (!ok) return;
  try {
    await api('/api/doc/delete', { method: 'POST', json: { path: node.path } });
    toast('Deleted');
    search.invalidate();
    await tree.refresh();
    if (tree.treeState.current === node.path) location.hash = '#/';
  } catch (e) { toast(e.message, 'err'); }
}

