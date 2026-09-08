/* gallery.js — 目录图库: 瀑布网格 / 复制 md Quote / Lightbox(含删除) */
import { $, $$, esc, api, icon, showdialog, toast, copyText, fmtSize } from './ui.js?v=26';
import { lightboxOpen } from './viewer.js?v=26';


export async function showGallery(dir) {
  const view = $('#view-gallery');
  view.hidden = false;
  $('#g-grid').innerHTML = '';
  $('#g-empty').hidden = true;
  $('#g-title').textContent = dir ? `Gallery — ${dir}` : 'Gallery';
  let data;
  try {
    data = await api('/api/gallery', { query: { dir } });
  } catch (e) {
    $('#g-stats').textContent = e.message;
    return;
  }
  const imgs = data.images || [];
  const total = imgs.reduce((s, x) => s + (x.size || 0), 0);
  $('#g-stats').textContent = imgs.length ? `${imgs.length} images · ${fmtSize(total)}` : '';
  if (!imgs.length) { $('#g-empty').hidden = false; return; }

  const grid = $('#g-grid');
  imgs.forEach((im, i) => {
    const item = document.createElement('div');
    item.className = 'g-item';
    item.innerHTML = `
      <img src="${esc(im.url)}" alt="${esc(im.name)}" loading="lazy" tabindex="0" role="button" aria-label="Open ${esc(im.name)}">
      <div class="g-acts">
        <button type="button" class="ga-copy" title="Copy Markdown link" aria-label="Copy Markdown link">${icon('copy', 15)}</button>
        <button type="button" class="ga-del danger" title="Delete" aria-label="Delete">${icon('trash', 15)}</button>
      </div>`;
    item.querySelector('.ga-copy').addEventListener('click', () => {
      // docs 根相对路径（leading slash = docs root, 与 fileUrl 解析一致）
      const rel = im.url.replace(/^\/files\//, '/');
      copyText(`![image](${rel})`).then(ok => toast(ok ? 'Markdown link copied' : 'Copy failed', ok ? '' : 'err'));
    });
    item.querySelector('.ga-del').addEventListener('click', () => delImage(im, imgs));
    const open = () => lightboxOpen(imgs, i, { onDelete: im2 => delImage(im2, imgs, true) });
    item.querySelector('img').addEventListener('click', open);
    item.querySelector('img').addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
    grid.appendChild(item);
  });
}

async function delImage(im, imgs, fromLightbox = false) {
  const ok = await showdialog({
    title: 'Delete image',
    message: `Delete “${im.name}”. Document references will break.`,
    okText: 'Delete', danger: true,
  });
  if (!ok) return;
  try {
    const relPath = im.url.replace(/^\/files\//, '');   // /files/x → x (docs 相对)
    await api('/api/image/delete', { method: 'POST', json: { url: relPath } });
    toast('Deleted');
    const dir = ($('#g-title').textContent || '').replace(/^Gallery — /, '');
    showGallery(dir);
  } catch (e) {
    toast('Cannot delete: ' + e.message, 'err');
  }
}
