/* git.js — 版本面板: 未提交/文档历史/恢复旧版/提交 */
import { $, api, esc, toast, showdialog } from './ui.js?v=26';

export async function showGit() {
  const view = $('#view-git');
  view.hidden = false;
  const path = window.__gitDocPath || null;
  $('#git-doc-title').textContent = path ? path.split('/').pop() : null;
  $('#git-doc-title').hidden = !path;
  $('#git-body').innerHTML = '<p style="color:var(--muted-2)">Loading…</p>';
  let st, log;
  try {
    st = await api('/api/git/status');
    log = await api('/api/git/log', { query: path ? { path } : {} });
  } catch (e) {
    $('#git-body').innerHTML = `<p>Load failed: ${esc(e.message)}</p>`;
    return;
  }
  const dirtyList = st.files.length
    ? `<h2>Uncommitted changes <span class="hl-count">${st.dirty}</span></h2>
       <ul class="hl-list">${st.files.map(f => `<li><code>${esc(f)}</code></li>`).join('')}</ul>`
    : '<p style="color:var(--muted-2)">Committed · no changes ✓</p>';
  const logList = log.log.length
    ? `<h2>${path ? 'History for this document' : 'Recent commits'} <span class="hl-count">${log.log.length}</span></h2>
       <ul class="hl-list">${log.log.map(e => `
         <li class="git-log-row">
           <div><code>${esc(e.hash)}</code> <span class="hl-size">${esc(e.date)}</span></div>
           <div class="git-subject">${esc(e.subject)}</div>
           ${path ? `<button type="button" class="git-restore" data-h="${esc(e.hash)}">Restore this version</button>` : ''}
         </li>`).join('')}</ul>`
    : '<p style="color:var(--muted-2)">No history (is Git initialized?)</p>';
  $('#git-body').innerHTML = dirtyList + logList;
  $('#btn-git-commit').hidden = !st.dirty;

  // 恢复旧版
  view.querySelectorAll('.git-restore').forEach(b => {
    b.addEventListener('click', async () => {
      const h = b.dataset.h;
      const ok = await showdialog({
        title: 'Restore version',
        message: `Restore ${h}. Current unsaved changes will be lost.`,
        okText: 'Restore', danger: true,
      });
      if (!ok) return;
      try {
        await api('/api/git/restore', { method: 'POST', json: { path, hash: h } });
        toast('Restored');
        location.hash = '#/doc/' + encodeURIComponent(path);
      } catch (e) { toast('Failed: ' + e.message, 'err'); }
    });
  });
}

export function initGit() {
  const btn = document.getElementById('btn-git');
  btn?.addEventListener('click', () => {
    // 当前打开的文档 → 查它的历史; 否则全局
    import('./app.js?v=26').then(m => {
      window.__gitDocPath = m.currentDocPath ? m.currentDocPath() : null;
      location.hash = '#/git';
    });
  });
  const cb = document.getElementById('btn-git-commit');
  cb?.addEventListener('click', async () => {
    const msg = await showdialog({ title: 'Commit', message: 'Commit message', input: true, value: '', placeholder: 'chishiki: ...', okText: 'Commit', allowEmpty: true });
    if (msg === null) return;
    try {
      await api('/api/git/commit', { method: 'POST', json: { message: msg || '' } });
      toast('Committed');
      showGit();
    } catch (e) { toast('Failed: ' + e.message, 'err'); }
  });
}
