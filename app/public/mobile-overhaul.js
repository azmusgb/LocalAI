(() => {
  'use strict';

  const isPhone = () => window.matchMedia('(max-width: 760px)').matches;
  const TRUTH_REFRESH_MS = 30000;
  let truthRefreshTimer = 0;

  function navigate(view) {
    if (!view) return;
    if (typeof window.showView === 'function') {
      window.showView(view);
      return;
    }
    const button = [...document.querySelectorAll('.navbtn[data-view]')]
      .find((item) => item.dataset.view === view);
    if (button) button.click();
  }

  function loadIntegrationEnhancement() {
    if (!document.querySelector('link[data-localai-integration-v2]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = '/integration-hub-v2.css';
      link.dataset.localaiIntegrationV2 = 'true';
      document.head.appendChild(link);
    }

    if (!document.querySelector('script[data-localai-integration-v2]')) {
      const script = document.createElement('script');
      script.src = '/integration-hub-v2.js';
      script.defer = true;
      script.dataset.localaiIntegrationV2 = 'true';
      document.head.appendChild(script);
    }
  }

  function installMobileHeader() {
    const main = document.querySelector('main');
    if (!main || main.querySelector('.mobile-header')) return;

    main.id = main.id || 'main-content';

    if (!document.querySelector('.skip-link')) {
      const skip = document.createElement('a');
      skip.className = 'skip-link';
      skip.href = '#main-content';
      skip.textContent = 'Skip to content';
      document.body.prepend(skip);
    }

    const header = document.createElement('div');
    header.className = 'mobile-header';
    header.innerHTML = `
      <div class="mobile-brand" aria-label="Local AI">
        <span class="mobile-brand-mark" aria-hidden="true"></span>
        <span>
          <span class="mobile-brand-name">Local AI</span>
          <span class="mobile-brand-sub">Private Intelligence Hub</span>
        </span>
      </div>
      <button class="pill mobile-health-button" type="button" aria-label="Open system status">
        <span id="mobileHeaderDot" class="dot"></span>
        <span id="mobileHeaderState">Checking…</span>
      </button>`;

    main.prepend(header);
    header.querySelector('.mobile-health-button')?.addEventListener('click', () => navigate('status'));
  }

  function mirrorHealthState() {
    const sourceDot = document.getElementById('homeDot');
    const sourceState = document.getElementById('homeState');
    const targetDot = document.getElementById('mobileHeaderDot');
    const targetState = document.getElementById('mobileHeaderState');
    if (!sourceDot || !targetDot || !targetState) return;

    targetDot.className = sourceDot.className;
    targetState.textContent = sourceState?.textContent || 'Checking…';
  }

  function improveViewportBehavior() {
    document.querySelectorAll('input, textarea').forEach((input) => {
      input.addEventListener('focus', () => {
        if (!isPhone()) return;
        window.setTimeout(() => input.scrollIntoView({ block: 'center', behavior: 'smooth' }), 80);
      }, { passive: true });
    });

    document.addEventListener('click', (event) => {
      const navButton = event.target.closest?.('.navbtn');
      if (navButton && isPhone()) window.scrollTo({ top: 0, behavior: 'smooth' });
    }, { passive: true });
  }

  function installTruthLayerStyles() {
    if (document.getElementById('localai-truth-layer-styles')) return;
    const style = document.createElement('style');
    style.id = 'localai-truth-layer-styles';
    style.textContent = `
      .truth-attention{margin-top:12px;padding:15px 17px;box-shadow:none}
      .truth-attention[data-state="clear"]{background:linear-gradient(180deg,color-mix(in srgb,var(--panel) 94%,var(--good)),var(--panel))}
      .truth-attention[data-state="attention"]{border-color:color-mix(in srgb,var(--warn) 35%,var(--line))}
      .truth-attention-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
      .truth-attention-head h2{margin:0;font-size:16px}
      .truth-attention-head p{margin:3px 0 0;color:var(--muted);font-size:12px}
      .truth-attention-count{white-space:nowrap}
      .truth-attention-list{display:grid;gap:7px;margin-top:11px}
      .truth-attention-item{display:grid;grid-template-columns:8px minmax(0,1fr) auto;gap:10px;align-items:center;padding:10px 11px;border:1px solid var(--line);border-radius:11px;background:var(--panel2)}
      .truth-attention-marker{width:8px;height:8px;border-radius:999px;background:var(--muted)}
      .truth-attention-item[data-severity="critical"] .truth-attention-marker{background:var(--bad)}
      .truth-attention-item[data-severity="warning"] .truth-attention-marker{background:var(--warn)}
      .truth-attention-item[data-severity="info"] .truth-attention-marker{background:var(--accent)}
      .truth-attention-copy{min-width:0}
      .truth-attention-copy strong{display:block;font-size:12px}
      .truth-attention-copy span{display:block;color:var(--muted);font-size:11px;line-height:1.4;margin-top:2px}
      .truth-attention-action{min-height:36px;padding:7px 9px;font-size:11px}
      .truth-disabled{opacity:.48!important;cursor:not-allowed!important;transform:none!important}
      .truth-disabled:hover{transform:none!important}
      @media(max-width:720px){.truth-attention-item{grid-template-columns:8px minmax(0,1fr)}.truth-attention-action{grid-column:2;justify-self:start}.truth-attention{padding:13px}}
    `;
    document.head.appendChild(style);
  }

  function ensureAttentionSurface() {
    const existing = document.getElementById('truthAttention');
    if (existing) return existing;

    const home = document.getElementById('home');
    const capabilities = document.getElementById('homeCapabilities');
    if (!home) return null;

    const section = document.createElement('section');
    section.id = 'truthAttention';
    section.className = 'card truth-attention';
    section.dataset.state = 'clear';
    section.setAttribute('aria-labelledby', 'truthAttentionTitle');
    section.innerHTML = `
      <div class="truth-attention-head">
        <div>
          <h2 id="truthAttentionTitle">Attention</h2>
          <p id="truthAttentionSummary">Checking live capability state…</p>
        </div>
        <span id="truthAttentionCount" class="pill truth-attention-count">Checking</span>
      </div>
      <div id="truthAttentionList" class="truth-attention-list" aria-live="polite"></div>`;

    if (capabilities?.parentNode === home) capabilities.insertAdjacentElement('afterend', section);
    else home.prepend(section);
    return section;
  }

  function service(snapshot, name) {
    return (Array.isArray(snapshot?.services) ? snapshot.services : [])
      .find((item) => item?.name === name) || null;
  }

  function healthy(snapshot, name) {
    return service(snapshot, name)?.state === 'HEALTHY';
  }

  function setTruthAvailability(control, available, reason) {
    if (!control) return;
    if (!available) {
      control.disabled = true;
      control.classList.add('truth-disabled');
      control.dataset.truthDisabled = 'true';
      control.setAttribute('aria-disabled', 'true');
      if (reason) control.title = reason;
      return;
    }

    if (control.dataset.truthDisabled === 'true') {
      control.disabled = false;
      control.classList.remove('truth-disabled');
      delete control.dataset.truthDisabled;
      control.removeAttribute('aria-disabled');
      if (control.title?.startsWith('Unavailable:')) control.removeAttribute('title');
    }
  }

  function gateMode(name, available, reason) {
    document.querySelectorAll(`.quick[data-quick="${name}"], .mode[data-mode="${name}"]`)
      .forEach((control) => setTruthAvailability(control, available, `Unavailable: ${reason}`));
  }

  function applyCapabilityGates(snapshot) {
    const intelligenceReady = healthy(snapshot, 'ollama');
    const researchReady = intelligenceReady && healthy(snapshot, 'search');
    const createReady = healthy(snapshot, 'comfy') && snapshot?.images?.available === true;
    const automateReady = healthy(snapshot, 'n8n');

    gateMode('ask', intelligenceReady, 'local intelligence service is not healthy');
    gateMode('research', researchReady, !intelligenceReady
      ? 'local intelligence service is not healthy'
      : 'web research service is not healthy');
    gateMode('create', createReady, healthy(snapshot, 'comfy')
      ? 'no supported local image model is currently available'
      : 'image generation service is not healthy');
    gateMode('automate', automateReady, 'automation engine is not healthy');
    gateMode('engineering', intelligenceReady, 'local intelligence service is not healthy');

    const webSearch = document.getElementById('webSearch');
    if (webSearch) setTruthAvailability(webSearch, healthy(snapshot, 'search'), 'Unavailable: web research service is not healthy');
  }

  function attentionItems(snapshot) {
    const items = [];
    const services = Array.isArray(snapshot?.services) ? snapshot.services : [];

    services
      .filter((item) => item?.required !== false && item?.state !== 'HEALTHY')
      .forEach((item) => {
        items.push({
          severity: item.state === 'DOWN' ? 'critical' : 'warning',
          title: `${item.label || item.name || 'Core service'} is ${String(item.state || 'unavailable').toLowerCase()}`,
          detail: item.impact || 'A core capability is affected.',
          action: 'Open status',
          view: 'status'
        });
      });

    if (healthy(snapshot, 'comfy') && snapshot?.images?.available !== true) {
      items.push({
        severity: 'warning',
        title: 'No supported image model discovered',
        detail: 'Create is gated until a compatible local checkpoint is available.',
        action: 'Open Create',
        view: 'create'
      });
    }

    if (snapshot?.powershell?.configured === false) {
      items.push({
        severity: 'info',
        title: 'Host deployment bridge is not configured',
        detail: 'Engineering can plan changes, but host-level apply operations are unavailable.',
        action: 'Open PowerShell',
        view: 'powershell'
      });
    }

    if (Number(snapshot?.engineering?.awaitingApproval || 0) > 0) {
      const count = Number(snapshot.engineering.awaitingApproval);
      items.push({
        severity: 'info',
        title: `${count} engineering ${count === 1 ? 'run is' : 'runs are'} awaiting approval`,
        detail: 'Review the staged change before deployment.',
        action: 'Open approvals',
        view: 'approvals'
      });
    }

    if (Number(snapshot?.issues?.open || 0) > 0) {
      const count = Number(snapshot.issues.open);
      items.push({
        severity: 'warning',
        title: `${count} autonomous ${count === 1 ? 'issue is' : 'issues are'} open`,
        detail: 'Quality Intelligence has unresolved findings.',
        action: 'Open issues',
        view: 'issues'
      });
    }

    const rank = { critical: 0, warning: 1, info: 2 };
    return items.sort((a, b) => rank[a.severity] - rank[b.severity]);
  }

  function renderAttention(snapshot, loadError = null) {
    const surface = ensureAttentionSurface();
    const list = document.getElementById('truthAttentionList');
    const summary = document.getElementById('truthAttentionSummary');
    const count = document.getElementById('truthAttentionCount');
    if (!surface || !list || !summary || !count) return;

    list.replaceChildren();

    if (loadError) {
      surface.dataset.state = 'attention';
      summary.textContent = 'Live capability state could not be verified. Existing controls remain available.';
      count.textContent = 'State unavailable';
      const row = document.createElement('div');
      row.className = 'truth-attention-item';
      row.dataset.severity = 'critical';
      row.innerHTML = '<span class="truth-attention-marker" aria-hidden="true"></span><div class="truth-attention-copy"><strong>Capability registry unavailable</strong><span>Local AI could not verify the current runtime state. Open Status for diagnostics.</span></div>';
      const action = document.createElement('button');
      action.type = 'button';
      action.className = 'btn truth-attention-action';
      action.textContent = 'Open status';
      action.addEventListener('click', () => navigate('status'));
      row.appendChild(action);
      list.appendChild(row);
      return;
    }

    const items = attentionItems(snapshot);
    if (!items.length) {
      surface.dataset.state = 'clear';
      summary.textContent = 'No action is required. Core capabilities currently report ready.';
      count.textContent = 'Clear';
      return;
    }

    surface.dataset.state = 'attention';
    const critical = items.filter((item) => item.severity === 'critical').length;
    const warnings = items.filter((item) => item.severity === 'warning').length;
    summary.textContent = critical
      ? `${critical} critical ${critical === 1 ? 'item requires' : 'items require'} attention.`
      : `${warnings || items.length} ${warnings === 1 ? 'item needs' : 'items need'} review.`;
    count.textContent = `${items.length} ${items.length === 1 ? 'item' : 'items'}`;

    items.slice(0, 6).forEach((item) => {
      const row = document.createElement('div');
      row.className = 'truth-attention-item';
      row.dataset.severity = item.severity;

      const marker = document.createElement('span');
      marker.className = 'truth-attention-marker';
      marker.setAttribute('aria-hidden', 'true');

      const copy = document.createElement('div');
      copy.className = 'truth-attention-copy';
      const title = document.createElement('strong');
      title.textContent = item.title;
      const detail = document.createElement('span');
      detail.textContent = item.detail;
      copy.append(title, detail);

      const action = document.createElement('button');
      action.type = 'button';
      action.className = 'btn truth-attention-action';
      action.textContent = item.action;
      action.addEventListener('click', () => navigate(item.view));

      row.append(marker, copy, action);
      list.appendChild(row);
    });
  }

  async function refreshTruthLayer() {
    try {
      const response = await fetch('/api/capabilities', {
        method: 'GET',
        headers: { Accept: 'application/json' },
        cache: 'no-store'
      });
      if (!response.ok) throw new Error(`Capability registry returned HTTP ${response.status}`);
      const snapshot = await response.json();
      applyCapabilityGates(snapshot);
      renderAttention(snapshot);
      window.dispatchEvent(new CustomEvent('localai:truth-updated', { detail: snapshot }));
    } catch (error) {
      document.querySelectorAll('[data-truth-disabled="true"]').forEach((control) => {
        setTruthAvailability(control, true, '');
      });
      renderAttention(null, error);
    }
  }

  function installTruthLayer() {
    installTruthLayerStyles();
    ensureAttentionSurface();
    refreshTruthLayer();

    if (truthRefreshTimer) window.clearInterval(truthRefreshTimer);
    truthRefreshTimer = window.setInterval(() => {
      if (!document.hidden) refreshTruthLayer();
    }, TRUTH_REFRESH_MS);

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refreshTruthLayer();
    }, { passive: true });
  }

  function init() {
    loadIntegrationEnhancement();
    installMobileHeader();
    improveViewportBehavior();
    mirrorHealthState();
    installTruthLayer();

    const observer = new MutationObserver(mirrorHealthState);
    const state = document.getElementById('homeState');
    if (state) observer.observe(state, { childList: true, characterData: true, subtree: true });

    window.addEventListener('resize', mirrorHealthState, { passive: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
