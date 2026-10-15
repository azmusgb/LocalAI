(() => {
  'use strict';

  const state = { runs: [], selectedId: null, timer: 0, loading: false, drawerSig: '' };
  const ACTIVE = new Set(['queued', 'running', 'streaming', 'awaiting_approval']);

  function el(id) { return document.getElementById(id); }
  function active(run) { return ACTIVE.has(run?.status); }
  function safeDate(value) {
    const date = new Date(value || 0);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  function relativeTime(value) {
    const date = safeDate(value);
    if (!date) return '—';
    const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return date.toLocaleDateString();
  }
  function statusLabel(status) {
    return ({ queued: 'Queued', running: 'Running', streaming: 'Streaming', awaiting_approval: 'Awaiting approval', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled' })[status] || status || 'Unknown';
  }
  function statusTone(status) {
    if (status === 'completed') return 'complete';
    if (status === 'failed' || status === 'cancelled') return 'error';
    if (status === 'awaiting_approval') return 'waiting';
    return active({ status }) ? 'running' : '';
  }
  function outputText(value) {
    if (value === null || value === undefined || value === '') return '';
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value, null, 2); } catch { return String(value); }
  }
  function drawerSignature(run) {
    return run ? [run.id, run.status, run.updatedAt, run.progress, outputText(run.output).length, run.error || '', Array.isArray(run.events) ? run.events.length : 0].join('|') : '';
  }

  function installStyles() {
    if (el('localai-execution-runtime-styles')) return;
    const style = document.createElement('style');
    style.id = 'localai-execution-runtime-styles';
    style.textContent = `
      .run-summary-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px}
      .run-metric{border:1px solid var(--line);background:var(--panel2);border-radius:13px;padding:13px}
      .run-metric b{display:block;font-size:22px;letter-spacing:-.03em}.run-metric span{display:block;color:var(--muted);font-size:11px;margin-top:3px}
      .run-list{display:grid;gap:7px}.run-row{width:100%;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;text-align:left;border:1px solid var(--line);background:var(--panel2);color:var(--text);border-radius:12px;padding:11px 12px}
      .run-row:hover{border-color:var(--line2)}.run-row-main{min-width:0}.run-row-title{font-weight:680;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.run-row-meta{display:flex;gap:7px;flex-wrap:wrap;color:var(--muted);font-size:11px;margin-top:4px}.run-row-progress{height:3px;background:var(--panel3);border-radius:99px;overflow:hidden;margin-top:8px}.run-row-progress>span{display:block;height:100%;background:var(--accent);width:var(--progress)}
      .run-status{white-space:nowrap}.run-status.waiting{color:var(--warn)}
      .home-run-center{margin-top:12px;padding:15px 17px;box-shadow:none}.home-run-center .run-list{margin-top:10px}.home-run-center .run-row{padding:9px 10px}
      .run-drawer-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.56);z-index:180;display:none}.run-drawer-backdrop.show{display:block}.run-drawer{position:absolute;right:0;top:0;bottom:0;width:min(520px,100%);background:var(--shell);border-left:1px solid var(--line2);padding:18px;overflow:auto;box-shadow:-20px 0 60px rgba(0,0,0,.32)}
      .run-drawer-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.run-drawer-close{min-width:44px;min-height:44px}.run-drawer-title{font-size:20px;font-weight:750;overflow-wrap:anywhere}.run-drawer-sub{color:var(--muted);font-size:12px;margin-top:5px}.run-drawer-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}.run-detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:14px}.run-detail{border:1px solid var(--line);border-radius:11px;background:var(--panel);padding:10px}.run-detail span{display:block;color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.06em}.run-detail b{display:block;margin-top:3px;font-size:12px;overflow-wrap:anywhere}.run-section{margin-top:18px}.run-section h3{margin-bottom:8px}.run-output{white-space:pre-wrap;word-break:break-word;max-height:360px;overflow:auto;background:#090c10;border:1px solid var(--line);border-radius:11px;padding:11px;font:12px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--soft)}.run-timeline{display:grid;gap:0}.run-event{display:grid;grid-template-columns:16px minmax(0,1fr);gap:9px;padding:7px 0}.run-event-marker{width:8px;height:8px;border-radius:99px;background:var(--line2);margin-top:5px}.run-event:last-child .run-event-marker{background:var(--accent)}.run-event-detail{font-size:12px}.run-event-time{color:var(--muted);font-size:10px;margin-top:2px}.run-live-region{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
      @media(max-width:800px){.run-summary-grid{grid-template-columns:1fr 1fr}.run-drawer{padding:14px}.run-detail-grid{grid-template-columns:1fr 1fr}}
      @media(max-width:420px){.run-summary-grid,.run-detail-grid{grid-template-columns:1fr}.run-row{grid-template-columns:1fr}.run-status{justify-self:start}}
      @media(prefers-reduced-motion:reduce){.run-drawer-backdrop,.run-drawer{transition:none!important}}
    `;
    document.head.appendChild(style);
  }

  function activateRunsView() {
    const view = el('runs');
    if (!view) return;
    document.querySelectorAll('.view').forEach((item) => item.classList.toggle('active', item === view));
    document.querySelectorAll('.navbtn[data-view]').forEach((item) => item.classList.toggle('active', item.dataset.view === 'runs'));
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  function ensureSurface() {
    installStyles();
    const main = document.querySelector('main');
    if (!main) return;

    if (!el('runs')) {
      const section = document.createElement('section');
      section.id = 'runs';
      section.className = 'view';
      section.innerHTML = `
        <div class="topbar"><div><h1>Runs</h1><p class="sub">One execution history for AI, images, agents, automations, and engineering.</p></div><button id="runsRefresh" type="button" class="btn">Refresh</button></div>
        <div id="runMetrics" class="run-summary-grid"></div>
        <div class="card" style="margin-top:12px"><div class="section-head"><div><h2>Execution history</h2><p>Open a run for lifecycle events, output, errors, cancel, or retry when supported.</p></div></div><div id="runList" class="run-list"><div class="empty">Loading runs…</div></div></div>`;
      main.appendChild(section);
      el('runsRefresh')?.addEventListener('click', () => loadRuns(true));
    }

    if (!document.querySelector('.navbtn[data-view="runs"]')) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'navbtn';
      button.dataset.view = 'runs';
      button.innerHTML = '<span class="navicon">▶</span>Runs';
      button.addEventListener('click', () => { activateRunsView(); loadRuns(true); });
      const activityButton = document.querySelector('.navbtn[data-view="activity"]');
      if (activityButton?.parentElement) activityButton.parentElement.insertBefore(button, activityButton);
      else document.querySelector('nav')?.appendChild(button);
    }

    if (!el('homeRunCenter')) {
      const home = el('home');
      if (home) {
        const panel = document.createElement('section');
        panel.id = 'homeRunCenter';
        panel.className = 'card home-run-center';
        panel.innerHTML = '<div class="section-head"><div><h2>Runs</h2><p id="homeRunSummary">Checking current execution state…</p></div><button id="homeRunsOpen" type="button" class="btn">View runs</button></div><div id="homeRunList" class="run-list"></div>';
        const attention = el('truthAttention');
        if (attention?.parentNode === home) attention.insertAdjacentElement('afterend', panel);
        else home.prepend(panel);
        el('homeRunsOpen')?.addEventListener('click', () => { activateRunsView(); loadRuns(true); });
      }
    }

    if (!el('runDrawerBackdrop')) {
      const backdrop = document.createElement('div');
      backdrop.id = 'runDrawerBackdrop';
      backdrop.className = 'run-drawer-backdrop';
      backdrop.setAttribute('aria-hidden', 'true');
      backdrop.innerHTML = '<aside id="runDrawer" class="run-drawer" role="dialog" aria-modal="true" aria-labelledby="runDrawerTitle"></aside><div id="runLiveRegion" class="run-live-region" aria-live="polite"></div>';
      document.body.appendChild(backdrop);
      backdrop.addEventListener('click', (event) => { if (event.target === backdrop) closeDrawer(); });
    }
  }

  function makeRunRow(run) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'run-row';
    button.dataset.runId = run.id;
    button.addEventListener('click', () => openDrawer(run.id));

    const main = document.createElement('div');
    main.className = 'run-row-main';
    const title = document.createElement('div');
    title.className = 'run-row-title';
    title.textContent = run.title || 'Untitled run';
    const meta = document.createElement('div');
    meta.className = 'run-row-meta';
    [run.type || 'task', relativeTime(run.updatedAt || run.createdAt), run.source?.kind ? `source: ${run.source.kind}` : ''].filter(Boolean).forEach((text) => {
      const span = document.createElement('span'); span.textContent = text; meta.appendChild(span);
    });
    const progress = document.createElement('div');
    progress.className = 'run-row-progress';
    const fill = document.createElement('span');
    fill.style.setProperty('--progress', `${Math.max(0, Math.min(100, Number(run.progress) || 0))}%`);
    progress.appendChild(fill);
    main.append(title, meta, progress);

    const status = document.createElement('span');
    status.className = `statuschip run-status ${statusTone(run.status)}`;
    status.textContent = statusLabel(run.status);
    button.append(main, status);
    return button;
  }

  function render() {
    ensureSurface();
    const runs = state.runs;
    const activeRuns = runs.filter(active);
    const failed = runs.filter((run) => run.status === 'failed');
    const completed = runs.filter((run) => run.status === 'completed');
    const awaiting = runs.filter((run) => run.status === 'awaiting_approval');

    const metrics = el('runMetrics');
    if (metrics) {
      metrics.innerHTML = `<div class="run-metric"><b>${activeRuns.length}</b><span>Active</span></div><div class="run-metric"><b>${awaiting.length}</b><span>Awaiting approval</span></div><div class="run-metric"><b>${failed.length}</b><span>Failed in history</span></div><div class="run-metric"><b>${completed.length}</b><span>Completed in history</span></div>`;
    }

    const list = el('runList');
    if (list) {
      list.replaceChildren();
      if (!runs.length) list.innerHTML = '<div class="empty">No execution history yet.</div>';
      else runs.forEach((run) => list.appendChild(makeRunRow(run)));
    }

    const homeList = el('homeRunList');
    const homeSummary = el('homeRunSummary');
    if (homeList && homeSummary) {
      homeList.replaceChildren();
      homeSummary.textContent = activeRuns.length
        ? `${activeRuns.length} ${activeRuns.length === 1 ? 'run is' : 'runs are'} active now.`
        : 'Nothing is running right now. Recent executions are shown below.';
      const visible = activeRuns.length ? activeRuns.slice(0, 4) : runs.slice(0, 3);
      if (!visible.length) homeList.innerHTML = '<div class="empty">No runs yet.</div>';
      else visible.forEach((run) => homeList.appendChild(makeRunRow(run)));
    }

    if (state.selectedId && el('runDrawerBackdrop')?.classList.contains('show') && drawerSignature(runs.find((run) => run.id === state.selectedId)) !== state.drawerSig) renderDrawer(state.selectedId);
  }

  function renderDrawer(runId) {
    const run = state.runs.find((item) => item.id === runId);
    const drawer = el('runDrawer');
    if (!run || !drawer) return;
    state.drawerSig = drawerSignature(run);
    drawer.replaceChildren();

    const head = document.createElement('div');
    head.className = 'run-drawer-head';
    const copy = document.createElement('div');
    const title = document.createElement('div');
    title.id = 'runDrawerTitle';
    title.className = 'run-drawer-title';
    title.textContent = run.title || 'Untitled run';
    const sub = document.createElement('div');
    sub.className = 'run-drawer-sub';
    sub.textContent = `${run.type || 'task'} · ${statusLabel(run.status)} · updated ${relativeTime(run.updatedAt)}`;
    copy.append(title, sub);
    const close = document.createElement('button');
    close.type = 'button'; close.className = 'btn run-drawer-close'; close.textContent = 'Close'; close.addEventListener('click', closeDrawer);
    head.append(copy, close);
    drawer.appendChild(head);

    const actions = document.createElement('div');
    actions.className = 'run-drawer-actions';
    if (run.cancellable && active(run)) {
      const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn danger'; cancel.textContent = 'Cancel run'; cancel.addEventListener('click', () => cancelRun(run.id, cancel)); actions.appendChild(cancel);
    }
    if (run.retryable) {
      const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'btn primary'; retry.textContent = 'Retry'; retry.addEventListener('click', () => retryRun(run.id, retry)); actions.appendChild(retry);
    }
    if (actions.childElementCount) drawer.appendChild(actions);

    const details = document.createElement('div');
    details.className = 'run-detail-grid';
    const values = [
      ['Status', statusLabel(run.status)], ['Progress', `${Math.max(0, Math.min(100, Number(run.progress) || 0))}%`],
      ['Started', safeDate(run.startedAt)?.toLocaleString() || '—'], ['Finished', safeDate(run.finishedAt)?.toLocaleString() || '—'],
      ['Attempt', String(run.attempt || 1)], ['Retry of', run.retryOf || '—'], ['Run ID', run.id]
    ];
    values.forEach(([label, value]) => {
      const box = document.createElement('div'); box.className = 'run-detail';
      const key = document.createElement('span'); key.textContent = label;
      const text = document.createElement('b'); text.textContent = value;
      box.append(key, text); details.appendChild(box);
    });
    drawer.appendChild(details);

    if (run.summary) appendSection(drawer, 'Summary', run.summary);
    if (run.error) appendSection(drawer, 'Error', run.error);
    const output = outputText(run.output);
    if (output) appendSection(drawer, 'Output', output, true);

    if (Array.isArray(run.events) && run.events.length) {
      const section = document.createElement('section'); section.className = 'run-section';
      const heading = document.createElement('h3'); heading.textContent = 'Timeline'; section.appendChild(heading);
      const timeline = document.createElement('div'); timeline.className = 'run-timeline';
      run.events.forEach((event) => {
        const row = document.createElement('div'); row.className = 'run-event';
        const marker = document.createElement('span'); marker.className = 'run-event-marker';
        const text = document.createElement('div');
        const detail = document.createElement('div'); detail.className = 'run-event-detail'; detail.textContent = event.detail || statusLabel(event.status);
        const time = document.createElement('div'); time.className = 'run-event-time'; time.textContent = safeDate(event.at)?.toLocaleString() || '—';
        text.append(detail, time); row.append(marker, text); timeline.appendChild(row);
      });
      section.appendChild(timeline); drawer.appendChild(section);
    }
  }

  function appendSection(parent, headingText, content, code = false) {
    const section = document.createElement('section'); section.className = 'run-section';
    const heading = document.createElement('h3'); heading.textContent = headingText;
    const body = document.createElement(code ? 'pre' : 'div');
    if (code) body.className = 'run-output';
    else body.className = headingText === 'Error' ? 'status-error' : 'muted';
    body.textContent = content;
    section.append(heading, body); parent.appendChild(section);
  }

  function openDrawer(runId) {
    state.selectedId = runId;
    const backdrop = el('runDrawerBackdrop');
    if (!backdrop) return;
    renderDrawer(runId);
    backdrop.classList.add('show');
    backdrop.setAttribute('aria-hidden', 'false');
    el('runDrawer')?.querySelector('button')?.focus();
  }

  function closeDrawer() {
    const backdrop = el('runDrawerBackdrop');
    if (!backdrop) return;
    backdrop.classList.remove('show');
    backdrop.setAttribute('aria-hidden', 'true');
    state.selectedId = null;
    state.drawerSig = '';
  }

  async function post(path, body) {
    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  async function cancelRun(runId, button) {
    button.disabled = true; button.textContent = 'Cancelling…';
    try {
      await post('/api/runs/cancel', { id: runId });
      el('runLiveRegion').textContent = 'Run cancelled.';
      await loadRuns(true);
    } catch (error) {
      el('runLiveRegion').textContent = `Cancel failed: ${error.message}`;
      button.disabled = false; button.textContent = 'Cancel run';
    }
  }

  async function retryRun(runId, button) {
    button.disabled = true; button.textContent = 'Retrying…';
    try {
      await post('/api/runs/retry', { id: runId });
      el('runLiveRegion').textContent = 'Retry started.';
      closeDrawer();
      await loadRuns(true);
    } catch (error) {
      el('runLiveRegion').textContent = `Retry failed: ${error.message}`;
      button.disabled = false; button.textContent = 'Retry';
    }
  }

  function schedule() {
    if (state.timer) window.clearTimeout(state.timer);
    const delay = state.runs.some(active) ? 3000 : 15000;
    state.timer = window.setTimeout(() => { if (!document.hidden) loadRuns(false); else schedule(); }, delay);
  }

  async function loadRuns(force = false) {
    if (state.loading && !force) return;
    state.loading = true;
    try {
      const response = await fetch('/api/runs?limit=120', { cache: 'no-store', headers: { Accept: 'application/json' } });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      state.runs = Array.isArray(data.items) ? data.items : [];
      render();
    } catch (error) {
      const list = el('runList');
      if (list) { list.replaceChildren(); const box = document.createElement('div'); box.className = 'status-error'; box.textContent = `Execution history unavailable: ${error.message}`; list.appendChild(box); }
    } finally {
      state.loading = false;
      schedule();
    }
  }

  // Open a run from elsewhere (the Audit log links here). Accepts a ledger id or the id of the work that produced it.
  async function openRunBySource(id) {
    const match = () => state.runs.find((run) => run.id === id || run.source?.id === id || run.meta?.sourceId === id);
    if (!match()) await loadRuns(true);
    activateRunsView();
    const run = match();
    if (run) openDrawer(run.id);
    return Boolean(run);
  }
  window.LocalAIRuns = { open: openRunBySource };

  function init() {
    ensureSurface();
    loadRuns(true);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) loadRuns(true); }, { passive: true });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && el('runDrawerBackdrop')?.classList.contains('show')) closeDrawer(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
