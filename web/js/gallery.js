/* gallery.js — 目录图库: 瀑布网格 / 复制 md 引用 / Lightbox(含删除) */
import { $, $$, esc, api, icon, showdialog, toast, copyText, fmtSize } from './ui.js?v=8';
import { lightboxOpen } from './viewer.js?v=8';

/* 图片删除能力开关: 后端补 /api/image/delete 后置 true (当前后端冻结, 缺该端点) */
const IMAGE_DELETE_API = false;

export async function showGallery(dir) {
  const view = $('#view-gallery');
  view.hidden = false;
  $('#g-grid').innerHTML = '';
  $('#g-empty').hidden = true;
  $('#g-title').textContent = dir ? `ギャラリー — ${dir}` : 'ギャラリー';
  let data;
  try {
    data = await api('/api/gallery', { query: { dir } });
  } catch (e) {
    $('#g-stats').textContent = e.message;
    return;
  }
  const imgs = data.images || [];
  const total = imgs.reduce((s, x) => s + (x.size || 0), 0);
  $('#g-stats').textContent = imgs.length ? `${imgs.length} 枚・${fmtSize(total)}` : '';
  if (!imgs.length) { $('#g-empty').hidden = false; return; }

  const grid = $('#g-grid');
  imgs.forEach((im, i) => {
    const item = document.createElement('div');
    item.className = 'g-item';
    item.innerHTML = `
      <img src="${esc(im.url)}" alt="${esc(im.name)}" loading="lazy" tabindex="0" role="button" aria-label="${esc(im.name)} を拡大">
      <div class="g-acts">
        <button type="button" class="ga-copy" title="Markdown 引用をコピー" aria-label="Markdown 引用をコピー">${icon('copy', 15)}</button>
        <button type="button" class="ga-del danger" title="削除" aria-label="削除">${icon('trash', 15)}</button>
      </div>`;
    item.querySelector('.ga-copy').addEventListener('click', () => {
      // docs 根相对路径（leading slash = docs root, 与 fileUrl 解析一致）
      const rel = im.url.replace(/^\/files\//, '/');
      copyText(`![image](${rel})`).then(ok => toast(ok ? 'Markdown 引用をコピーしました' : 'コピー失敗', ok ? '' : 'err'));
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
    title: '画像を削除',
    message: `${im.name} を削除します。ドキュメント内の参照も壊れます。`,
    okText: '削除', danger: true,
  });
  if (!ok) return;
  if (!IMAGE_DELETE_API) {
    // 后端冻结期缺图片删除端点(/api/doc/delete 限 .md)。
    // 后端补 POST /api/image/delete {url} 后将 IMAGE_DELETE_API 置 true 即通。
    toast('画像削除は後端 API 未実装のため利用できません（交付記録に記載）', 'err');
    return;
  }
  try {
    await api('/api/image/delete', { method: 'POST', json: { url: im.url } });
    toast('削除しました');
    const dir = ($('#g-title').textContent || '').replace(/^ギャラリー — /, '');
    showGallery(dir);
  } catch (e) {
    toast('削除できません: ' + e.message, 'err');
  }
}
