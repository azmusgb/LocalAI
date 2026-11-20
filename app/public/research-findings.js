// Research Findings UI faceplate (on-demand loaded module)
// Zero additions to core ui.js / app.js bundles.

export function renderResearchFindings(container, { findings = [], onPromote, onKeep, onDismiss }) {
  if (!container) return;

  if (findings.length === 0) {
    container.innerHTML = `
      <div class="ui-empty">
        <p class="ui-empty__title">No new findings today</p>
        <p class="ui-empty__desc">When Local AI's scheduled intake reads new release feeds or advisories, atomic findings will appear here for triage.</p>
      </div>
    `;
    return;
  }

  const listHtml = findings.map((f, idx) => `
    <div class="research-finding-card ui-faceplate ${idx === 0 ? 'is-selected' : ''}" data-id="${f.id}" style="margin-bottom: var(--space-s, 12px); padding: 12px; border: 1px solid var(--border-subtle, #e0e0e0); border-radius: 8px;">
      <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px;">
        <span class="ui-badge" style="font-size: 0.75rem; text-transform: uppercase; font-weight: 600;">${f.targetProject}</span>
        <span style="font-size: 0.8rem; color: var(--text-muted, #666);">${f.relevance}</span>
      </div>
      <h4 style="margin: 0 0 8px 0; font-size: 0.95rem;">${f.claim}</h4>
      <blockquote style="margin: 0 0 12px 0; padding: 6px 10px; background: var(--bg-muted, #f7f7f7); border-left: 3px solid var(--accent, #0066cc); font-size: 0.85rem; font-style: italic;">
        "${f.quote}"
      </blockquote>
      <div style="display: flex; gap: 8px; justify-content: flex-end;">
        <button class="ui-btn ui-btn--subtle ui-btn--sm" data-action="dismiss" data-id="${f.id}">Dismiss</button>
        <button class="ui-btn ui-btn--subtle ui-btn--sm" data-action="keep" data-id="${f.id}">Keep</button>
        <button class="ui-btn ui-btn--primary ui-btn--sm" data-action="promote" data-id="${f.id}">Promote to Improve</button>
      </div>
    </div>
  `).join('');

  container.innerHTML = `
    <div class="research-findings-view" style="max-width: 800px; margin: 0 auto;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
        <h3 style="margin: 0;">Research Findings (${findings.length} active)</h3>
        <span style="font-size: 0.85rem; color: var(--text-muted, #666);">Daily cap: 10 per day</span>
      </div>
      <div class="research-findings-list">
        ${listHtml}
      </div>
    </div>
  `;

  // Attach event delegations
  container.querySelectorAll('button[data-action]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const action = e.currentTarget.getAttribute('data-action');
      const id = e.currentTarget.getAttribute('data-id');
      if (action === 'promote' && typeof onPromote === 'function') onPromote(id);
      if (action === 'keep' && typeof onKeep === 'function') onKeep(id);
      if (action === 'dismiss' && typeof onDismiss === 'function') onDismiss(id);
    });
  });
}
