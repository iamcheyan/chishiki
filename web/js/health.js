/* health.js — 健康检查 + 孤儿图片清理 */
import { $, $$, api, esc, toast, showdialog } from './ui.js?v=26';

export async function showHealth() {
  const view = $('#view-health');
  view.hidden = false;
  $('#hl-body').innerHTML = '<p style="color:var(--muted-2)">Checking…</p>';
  $('#btn-clean-run').hidden = true;
  let d;
  try {
    d = await api('/api/health');
  } catch (e) {
    $('#hl-body').innerHTML = `<p>Load failed: ${esc(e.message)}</p>`;
    return;
  }
  const n = {
    broken: d.broken_doc_links.length,
    missing: d.missing_images.length,
    orphan: d.orphan_images.length,
    empty: d.empty_asset_dirs.length,
    dup: d.dup_titles.length,
  };
  const allGreen = !n.broken && !n.missing && !n.orphan && !n.empty && !n.dup;
  $('#hl-summary').textContent = `Documents: ${d.docs} · ${
    allGreen ? 'No problems ✓' : `Needs attention: ${[n.broken && 'Broken document links', n.missing && 'Missing images', n.orphan && `Unused images ${n.orphan}`, n.empty && 'Empty directories', n.dup && 'Duplicate titles'].filter(Boolean).join('・')}`
  }`;

  const sec = (title, items, fmt) => items.length ? `
    <h2>${title} <span class="hl-count">${items.length}</span></h2>
    <ul class="hl-list">${items.map(fmt).join('')}</ul>` : '';

  $('#hl-body').innerHTML = `
    ${sec('Broken document links', d.broken_doc_links, x => `<li><code>${esc(x.doc)}</code> → ${esc(x.target)}</li>`)}
    ${sec('Broken image references', d.missing_images, x => `<li><code>${esc(x.doc)}</code> → ${esc(x.url)}</li>`)}
    ${sec('Unused images (not referenced)', d.orphan_images, x => `<li>${esc(x.path)} <span class="hl-size">${(x.size / 1024).toFixed(1)}KB</span></li>`)}
    ${sec('Empty asset folders', d.empty_asset_dirs, x => `<li>${esc(x)}</li>`)}
    ${sec('Duplicate titles', d.dup_titles, x => `<li>「${esc(x.title)}」<br><code>${esc(x.a)}</code> / <code>${esc(x.b)}</code></li>`)}
    ${allGreen ? '<p style="color:var(--muted-2)">Everything is healthy.</p>' : ''}`;

  // 孤儿清理入口
  const dry = $('#btn-clean-dry'), run = $('#btn-clean-run');
  dry.hidden = !n.orphan && !n.empty;
  run.hidden = true;
  dry.onclick = async () => {
    const r = await api('/api/clean', { method: 'POST', json: { dry_run: true } });
    const parts = [];
    if (r.candidates) parts.push(`Unused images: ${r.candidates}`);
    if (n.empty) parts.push(`Empty directories: ${n.empty}`);
    const ok = await showdialog({
      title: 'Cleanup',
      message: `Delete ${parts.join(' and ')}. This cannot be undone.`,
      okText: 'Run delete', danger: true,
    });
    if (!ok) return;
    const r2 = await api('/api/clean', { method: 'POST', json: { dry_run: false } });
    toast(`${r2.deleted.length} item(s) deleted`);
    showHealth();
  };
}
