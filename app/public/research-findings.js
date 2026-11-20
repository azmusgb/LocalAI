// Research Findings UI faceplate (on-demand loaded module)
// Zero additions to core ui.js / app.js bundles. Uses pure appliance-ui CSS classes.

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
    <div class="research-finding-card ui-card ${idx === 0 ? 'is-selected' : ''}" data-id="${f.id}">
      <div class="ui-row ui-row--between">
        <div class="ui-row">
          <span class="ui-badge">${f.targetProject}</span>
          <span class="ui-badge ui-badge--subtle">Value: ${f.value || 'High'}</span>
          <span class="ui-badge ui-badge--subtle">Readiness: ${f.readiness || 'Ready'}</span>
        </div>
        <span class="ui-muted">${f.relevance}</span>
      </div>
      <h4>${f.claim}</h4>
      <blockquote class="ui-quote">
        "${f.quote}"
      </blockquote>
      <div class="ui-row ui-row--end ui-actions">
        <button class="ui-btn ui-btn--subtle ui-btn--sm" data-action="dismiss" data-id="${f.id}">Dismiss</button>
        <button class="ui-btn ui-btn--subtle ui-btn--sm" data-action="keep" data-id="${f.id}">Keep</button>
        <button class="ui-btn ui-btn--primary ui-btn--sm" data-action="promote" data-id="${f.id}">Promote to Improve</button>
      </div>
    </div>
  `).join('');

  container.innerHTML = `
    <div class="research-findings-view ui-stack">
      <div class="ui-row ui-row--between">
        <h3 class="ui-title">Research Findings (${findings.length} active)</h3>
        <span class="ui-muted">Daily cap: 10 per day</span>
      </div>
      <div class="research-findings-list ui-stack">
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
