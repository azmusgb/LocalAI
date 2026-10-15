(() => {
  'use strict';

  // Claude board: live progress of Claude Code sessions plus a ranked, votable board of the findings they report.
  const POLL_MS = 4000;
  const SEVERITIES = ['high', 'medium', 'low'];
  const OPEN = new Set(['proposed', 'approved', 'in_progress']);
  const DECISIONS = [['approved', 'Approve'], ['in_progress', 'Start'], ['deferred', 'Defer'], ['rejected', 'Reject'], ['fixed', 'Mark fixed']];
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  const view = { data: null, session: '', statusFilter: 'open', category: '', severity: '', timer: 0, busy: false, openIds: new Set() };
  const $ = (id) => document.getElementById(id);

  function ago(iso) {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (!Number.isFinite(s)) return '';
    if (s < 60) return `${Math.round(s)}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  }

  async function api(url, body) {
    const r = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
    let j = {};
    try { j = await r.json(); } catch {}
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }

  async function load() {
    if (view.busy) return;
    view.busy = true;
    try {
      view.data = await api(`/api/claude/board${view.session ? `?session=${encodeURIComponent(view.session)}` : ''}`);
      $('claudeLive').className = 'claude-live on';
      $('claudeLive').textContent = 'live';
      render();
    } catch (e) {
      $('claudeLive').className = 'claude-live off';
      $('claudeLive').textContent = 'offline';
      $('claudeFindings').innerHTML = `<div class="empty">Claude board unavailable: ${esc(e.message)}</div>`;
    } finally { view.busy = false; }
  }

  function render() {
    const d = view.data;
    renderSessions(d.sessions);
    renderProgress(d.summary, d.statuses);
    renderTimeline(d.events);
    renderMatrix(d.summary.byCategory);
    renderFindings(d.findings, d.statuses);
  }

  function renderSessions(sessions) {
    const sel = $('claudeSession');
    const opts = ['<option value="">All sessions</option>', ...sessions.map((s) => `<option value="${esc(s.id)}"${s.id === view.session ? ' selected' : ''}>${esc(s.title)} · ${esc(ago(s.updatedAt))}</option>`)];
    const html = opts.join('');
    if (sel.dataset.html !== html) { sel.innerHTML = html; sel.dataset.html = html; }
  }

  function renderProgress(summary, statuses) {
    const total = summary.total || 0;
    const order = ['fixed', 'in_progress', 'approved', 'proposed', 'deferred', 'rejected'];
    const bar = total ? order.map((k) => {
      const n = summary.byStatus[k] || 0;
      return n ? `<span class="seg st-${k}" style="flex:${n}" title="${esc(statuses[k])}: ${n}"></span>` : '';
    }).join('') : '<span class="seg empty-seg" style="flex:1"></span>';
    const fixed = summary.byStatus.fixed || 0;
    const open = order.filter((k) => OPEN.has(k)).reduce((n, k) => n + (summary.byStatus[k] || 0), 0);
    $('claudeProgress').innerHTML = `
      <div class="claude-progress-head"><strong>${fixed} of ${total} findings fixed</strong><span>${open} open · ${summary.byStatus.deferred || 0} deferred · ${summary.byStatus.rejected || 0} rejected</span></div>
      <div class="claude-bar">${bar}</div>
      <div class="claude-legend">${order.map((k) => `<span><i class="dot st-${k}"></i>${esc(statuses[k])} ${summary.byStatus[k] || 0}</span>`).join('')}</div>`;
  }

  function renderTimeline(events) {
    const box = $('claudeTimeline');
    if (!events.length) { box.innerHTML = '<div class="empty">No Claude activity reported yet.</div>'; return; }
    box.innerHTML = events.slice(0, 80).map((e) => `
      <div class="claude-event ev-${esc(e.status)} kind-${esc(e.kind)}">
        <i class="dot"></i>
        <div class="claude-event-body">
          <div class="claude-event-title">${e.phase ? `<span class="claude-phase">${esc(e.phase)}</span>` : ''}${esc(e.title)}</div>
          ${e.detail ? `<div class="claude-event-detail">${esc(e.detail)}</div>` : ''}
        </div>
        <span class="claude-event-time" title="${esc(e.at)}">${esc(e.tool || '')} ${esc(ago(e.at))}</span>
      </div>`).join('');
  }

  function renderMatrix(byCategory) {
    const cats = Object.entries(byCategory).sort((a, b) => b[1].open - a[1].open || b[1].total - a[1].total);
    const max = Math.max(1, ...cats.flatMap(([, c]) => SEVERITIES.map((s) => c[s])));
    if (!cats.length) { $('claudeMatrix').innerHTML = '<div class="empty">No findings yet.</div>'; return; }
    $('claudeMatrix').innerHTML = `<table class="claude-matrix"><thead><tr><th>Category</th>${SEVERITIES.map((s) => `<th>${s}</th>`).join('')}<th>Open</th></tr></thead><tbody>${cats.map(([cat, c]) => `
      <tr class="${view.category === cat ? 'selected' : ''}">
        <th><button type="button" data-claude-cat="${esc(cat)}">${esc(cat)}</button></th>
        ${SEVERITIES.map((s) => `<td><button type="button" class="heat sev-${s}${view.category === cat && view.severity === s ? ' selected' : ''}" style="--heat:${c[s] / max}" data-claude-cat="${esc(cat)}" data-claude-sev="${s}" ${c[s] ? '' : 'disabled'}>${c[s] || ''}</button></td>`).join('')}
        <td class="open-count">${c.open}</td>
      </tr>`).join('')}</tbody></table>`;
  }

  function visible(findings) {
    return findings.filter((f) => (view.statusFilter === 'all' || (view.statusFilter === 'open' ? OPEN.has(f.status) : f.status === view.statusFilter))
      && (!view.category || f.category === view.category) && (!view.severity || f.severity === view.severity));
  }

  function renderFindings(findings, statuses) {
    const filters = [['open', 'Open'], ['all', 'All'], ...Object.entries(statuses)];
    $('claudeFilters').innerHTML = filters.map(([k, label]) => `<button type="button" class="chip${view.statusFilter === k ? ' active' : ''}" data-claude-status="${esc(k)}">${esc(label)}</button>`).join('')
      + (view.category ? `<button type="button" class="chip clear" data-claude-clear>${esc(view.category)}${view.severity ? ` · ${esc(view.severity)}` : ''} ✕</button>` : '');
    const list = visible(findings);
    const top = Math.max(1, ...findings.map((f) => f.score));
    $('claudeFindingCount').textContent = `${list.length} shown`;
    if (!list.length) { $('claudeFindings').innerHTML = '<div class="empty">Nothing matches these filters.</div>'; return; }
    $('claudeFindings').innerHTML = list.map((f) => `
      <article class="claude-finding st-${esc(f.status)}" data-id="${esc(f.id)}">
        <div class="claude-rank"><b>#${f.rank}</b><span class="claude-score" title="Score: severity + 6×net votes + decision">${f.score}</span>
          <span class="claude-score-bar"><i style="width:${Math.max(4, Math.round(Math.max(0, f.score) / top * 100))}%"></i></span></div>
        <div class="claude-finding-main">
          <div class="claude-finding-title">${esc(f.title)}</div>
          <div class="claude-chips">
            <span class="chip sev-${esc(f.severity)}">${esc(f.severity)}</span><span class="chip">${esc(f.category)}</span>
            <span class="chip status st-${esc(f.status)}">${esc(statuses[f.status] || f.status)}</span>
            ${f.pr ? `<span class="chip">${esc(f.pr)}</span>` : ''}${f.file ? `<span class="chip file">${esc(f.file)}</span>` : ''}
          </div>
          <details${view.openIds.has(f.id) ? ' open' : ''} data-claude-details="${esc(f.id)}"><summary>Details</summary>
            ${f.summary ? `<p>${esc(f.summary)}</p>` : ''}${f.scenario ? `<p><b>Failure scenario</b> ${esc(f.scenario)}</p>` : ''}${f.fix ? `<p><b>Fix</b> ${esc(f.fix)}</p>` : ''}
            ${f.decisionNote ? `<p><b>Your note</b> ${esc(f.decisionNote)}</p>` : ''}
          </details>
        </div>
        <div class="claude-vote">
          <button type="button" class="btn" data-claude-vote="1" aria-label="Raise priority">▲</button>
          <span title="${f.votes.up} up · ${f.votes.down} down">${f.votes.up - f.votes.down}</span>
          <button type="button" class="btn" data-claude-vote="-1" aria-label="Lower priority">▼</button>
        </div>
        <div class="claude-decide">${DECISIONS.filter(([k]) => k !== f.status).map(([k, label]) => `<button type="button" class="btn small" data-claude-decision="${k}">${label}</button>`).join('')}</div>
      </article>`).join('');
  }

  async function act(fn) {
    try { await fn(); await load(); } catch (e) { (window.toast || alert)(e.message); }
  }

  function bind() {
    $('claudeRefresh').addEventListener('click', load);
    $('claudeSession').addEventListener('change', (e) => { view.session = e.target.value; load(); });
    $('claude').addEventListener('toggle', (e) => {
      const id = e.target.dataset?.claudeDetails;
      if (id) e.target.open ? view.openIds.add(id) : view.openIds.delete(id);
    }, true);
    $('claude').addEventListener('click', (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.dataset.claudeStatus) { view.statusFilter = t.dataset.claudeStatus; render(); return; }
      if (t.hasAttribute('data-claude-clear')) { view.category = ''; view.severity = ''; render(); return; }
      if (t.dataset.claudeCat) {
        const same = view.category === t.dataset.claudeCat && view.severity === (t.dataset.claudeSev || '');
        view.category = same ? '' : t.dataset.claudeCat;
        view.severity = same ? '' : (t.dataset.claudeSev || '');
        render();
        return;
      }
      const id = t.closest('.claude-finding')?.dataset.id;
      if (!id) return;
      if (t.dataset.claudeVote) act(() => api('/api/claude/findings/vote', { id, delta: Number(t.dataset.claudeVote) }));
      if (t.dataset.claudeDecision) act(() => api('/api/claude/findings/decision', { id, status: t.dataset.claudeDecision }));
    });
  }

  // Poll only while the view is on screen and the tab is visible.
  function syncPolling() {
    const active = $('claude')?.classList.contains('active') && document.visibilityState === 'visible';
    if (active && !view.timer) { load(); view.timer = setInterval(load, POLL_MS); }
    if (!active && view.timer) { clearInterval(view.timer); view.timer = 0; }
  }

  function init() {
    const section = $('claude');
    if (!section) return;
    bind();
    new MutationObserver(syncPolling).observe(section, { attributes: true, attributeFilter: ['class'] });
    document.addEventListener('visibilitychange', syncPolling);
    syncPolling();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
