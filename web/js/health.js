/* health.js — 健康检查 + 孤儿图片清理 */
import { $, $$, api, esc, toast, showdialog } from './ui.js?v=9';

export async function showHealth() {
  const view = $('#view-health');
  view.hidden = false;
  $('#hl-body').innerHTML = '<p style="color:var(--muted-2)">確認中…</p>';
  $('#btn-clean-run').hidden = true;
  let d;
  try {
    d = await api('/api/health');
  } catch (e) {
    $('#hl-body').innerHTML = `<p>読み込み失敗: ${esc(e.message)}</p>`;
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
  $('#hl-summary').textContent = `ドキュメント ${d.docs} 篇 · ${
    allGreen ? '問題なし ✓' : `要対応: ${[n.broken && '文書リンク切れ', n.missing && '画像欠落', n.orphan && `孤立画像 ${n.orphan}`, n.empty && '空ディレクトリ', n.dup && 'タイトル重複'].filter(Boolean).join('・')}`
  }`;

  const sec = (title, items, fmt) => items.length ? `
    <h2>${title} <span class="hl-count">${items.length}</span></h2>
    <ul class="hl-list">${items.map(fmt).join('')}</ul>` : '';

  $('#hl-body').innerHTML = `
    ${sec('文書リンク切れ', d.broken_doc_links, x => `<li><code>${esc(x.doc)}</code> → ${esc(x.target)}</li>`)}
    ${sec('参照切れ画像', d.missing_images, x => `<li><code>${esc(x.doc)}</code> → ${esc(x.url)}</li>`)}
    ${sec('孤立画像（未参照）', d.orphan_images, x => `<li>${esc(x.path)} <span class="hl-size">${(x.size / 1024).toFixed(1)}KB</span></li>`)}
    ${sec('空アセットディレクトリ', d.empty_asset_dirs, x => `<li>${esc(x)}</li>`)}
    ${sec('タイトル重複', d.dup_titles, x => `<li>「${esc(x.title)}」<br><code>${esc(x.a)}</code> / <code>${esc(x.b)}</code></li>`)}
    ${allGreen ? '<p style="color:var(--muted-2)">すべて正常です。</p>' : ''}`;

  // 孤儿清理入口
  const dry = $('#btn-clean-dry'), run = $('#btn-clean-run');
  dry.hidden = !n.orphan && !n.empty;
  run.hidden = true;
  dry.onclick = async () => {
    const r = await api('/api/clean', { method: 'POST', json: { dry_run: true } });
    const ok = await showdialog({
      title: 'クリーンアップ',
      message: `孤立画像 ${r.candidates} 件と空ディレクトリを削除します。元に戻せません。`,
      okText: '削除実行', danger: true,
    });
    if (!ok) return;
    const r2 = await api('/api/clean', { method: 'POST', json: { dry_run: false } });
    toast(`${r2.deleted.length} 件削除しました`);
    showHealth();
  };
}
