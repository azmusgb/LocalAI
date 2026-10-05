(() => {
  'use strict';

  const q = (selector, root = document) => root.querySelector(selector);
  const qa = (selector, root = document) => [...root.querySelectorAll(selector)];

  const INTEGRATIONS = [
    {
      id: 'n8n', name: 'n8n', tier: 'native', decision: 'Native owner', source: 'n8n',
      summary: 'Primary workflow automation engine. Keep orchestration here instead of adding Bardeen, Coze, or another parallel automation runtime.',
      guidance: "After adding credentials, community nodes, or public webhooks, run n8n's official security audit and review any risky-node findings.",
      actions: [
        { type: 'view', view: 'automations', label: 'Open automations' },
        { type: 'url', url: 'https://docs.n8n.io/hosting/securing/security-audit/', label: 'Security audit docs' }
      ]
    },
    {
      id: 'comfyui', name: 'ComfyUI', tier: 'native', decision: 'Native media owner', source: 'comfy',
      summary: 'Primary local generative-media backend. Image, video, and avatar workflows should extend this service rather than create another media stack.',
      guidance: 'For automated workflows, prefer custom nodes that work in ComfyUI API mode. Nodes that require direct client/server communication may not be callable from Local AI.',
      actions: [
        { type: 'view', view: 'create', label: 'Open Create' },
        { type: 'url', url: 'https://docs.comfy.org/custom-nodes/overview', label: 'Custom-node guidance' }
      ]
    },
    {
      id: 'svd', name: 'Stable Video Diffusion', tier: 'extend', decision: 'Verify before enabling',
      summary: 'Treat SVD as a ComfyUI model/workflow capability, not a standalone integration. Do not present it as installed until the runtime exposes the required model and nodes.',
      guidance: 'Capability state is intentionally “not verified” until backend discovery is added.',
      actions: [{ type: 'view', view: 'create', label: 'Inspect Create' }]
    },
    {
      id: 'sadtalker', name: 'SadTalker', tier: 'extend', decision: 'Defer / verify first',
      summary: 'Keep talking-head generation modular and behind ComfyUI. Add it only when avatar output is a real workflow requirement and the node path is API-compatible.',
      guidance: 'Avoid installing custom nodes solely because they appear in a tool list; verify maintenance, runtime fit, and API behavior first.',
      actions: [{ type: 'view', view: 'create', label: 'Inspect Create' }]
    },
    {
      id: 'penpot', name: 'Penpot', tier: 'bridge', decision: 'Self-host + MCP',
      summary: 'Best design-system bridge from the reviewed tools. Penpot supports self-hosting and an MCP workflow for design inspection, asset export, design-to-code, and design updates.',
      guidance: 'Prefer a self-hosted Penpot instance. Treat an MCP key like a secret: never embed it in browser-visible configuration, source, screenshots, or logs.',
      actions: [
        { type: 'url', url: 'https://help.penpot.app/technical-guide/getting-started/', label: 'Self-host guide' },
        { type: 'url', url: 'https://help.penpot.app/mcp/', label: 'MCP guide' }
      ]
    },
    {
      id: 'obsidian', name: 'Obsidian', tier: 'bridge', decision: 'Local vault bridge',
      summary: 'Use Obsidian as a local Markdown source for Projects and Knowledge, not as a replacement for Local AI memory or project state.',
      guidance: 'The eventual bridge should mount or select a vault folder, ingest supported files, record source paths, and remain read-only by default.',
      actions: [{ type: 'view', view: 'projects', label: 'Open Projects' }]
    },
    {
      id: 'huggingface', name: 'Hugging Face', tier: 'bridge', decision: 'Model registry only',
      summary: 'Use Hugging Face for model discovery and acquisition. Keep Local AI as the chat/orchestration surface so history, routing, privacy, and capability state stay coherent.',
      guidance: 'Do not auto-install a model merely because it appears in search; compatibility, license, size, and local resource fit should be explicit gates.',
      actions: [{ type: 'url', url: 'https://huggingface.co/models', label: 'Browse models' }]
    },
    {
      id: 'photopea', name: 'Photopea', tier: 'utility', decision: 'Manual external editor',
      summary: 'Useful for occasional browser-based touch-up after local generation, but it should remain outside the appliance runtime and persistence model.',
      guidance: 'Opening Photopea crosses the local appliance boundary; do not silently upload Local AI artifacts.',
      actions: [{ type: 'url', url: 'https://www.photopea.com/', label: 'Open Photopea' }]
    },
    {
      id: 'languagetool', name: 'LanguageTool', tier: 'utility', decision: 'Optional deterministic QA',
      summary: 'Useful when you need a deterministic grammar/style pass. Ordinary writing remains with local models, so LanguageTool should be opt-in rather than a default dependency.',
      guidance: 'Prefer a local/self-hosted service if this becomes part of an automated workflow.',
      actions: [{ type: 'url', url: 'https://languagetool.org/', label: 'LanguageTool' }]
    }
  ];

  const ALTERNATIVES = [
    ['Gemini / Nano Banana / ImageFX / Google Flow', 'Cloud creative stack', 'Skip as core', 'Duplicates local model and ComfyUI capabilities and weakens the local-first boundary. Add a cloud adapter only for a concrete quality gap.'],
    ['DALL·E 3', 'Cloud image generation', 'Skip as core', 'Keep ComfyUI as the default media backend and expose cloud providers only as explicit opt-in fallbacks.'],
    ['Hugging Chat / Hugging Face Chat', 'Cloud chat frontend', 'Skip', 'Local AI already provides the chat/orchestration layer. Hugging Face is more valuable here as a model registry.'],
    ['Meta AI / You.com', 'Cloud assistants/search', 'Skip', 'They duplicate Ask/Research and would fragment history, routing, privacy, and capability state.'],
    ['LMArena / Chatbot Arena', 'Model comparison', 'Reference only', 'Useful for external model evaluation, but not an appliance runtime dependency.'],
    ['Coze / Bardeen', 'Cloud automation/agents', 'Skip', 'n8n plus Local AI agents already cover this space with better control and local deployment.'],
    ['Pixlr X / Lovart', 'Design/image tools', 'Skip', 'Photopea plus Penpot provides a simpler editor/design pair with less overlap.'],
    ['Laxis', 'Meeting notes', 'Skip for now', 'Meeting capture is outside the current Local AI core and would add a narrow cloud workflow.'],
    ['Google Slides', 'Presentations', 'Defer', 'Prefer a future artifact/export capability rather than coupling the appliance to one office suite.'],
    ['10Web', 'Website builder', 'Skip', 'Local AI engineering/workbench features are a better fit for code-backed site work.'],
    ['Icons8', 'Asset library', 'Reference only', 'Useful content source, not an integration. Keep it outside the runtime dependency graph.']
  ];

  function tierBadge(tier) {
    const labels = { native: 'Native', extend: 'Local extension', bridge: 'Bridge', utility: 'Utility' };
    return `<span class="ux-int-tier ${tier}">${labels[tier] || tier}</span>`;
  }

  function navigate(view) {
    const button = q(`.navbtn[data-view="${CSS.escape(view)}"]`);
    if (button) {
      button.click();
      return;
    }
    const target = q(`#${CSS.escape(view)}`);
    if (!target) return;
    qa('.view').forEach(item => item.classList.toggle('active', item === target));
  }

  function actionHtml(item, action) {
    if (action.type === 'url') {
      return `<a class="btn ux-int-action" data-external="true" href="${action.url}" target="_blank" rel="noopener noreferrer" aria-label="${action.label} for ${item.name} (opens external site)">${action.label} ↗</a>`;
    }
    return `<button class="btn ux-int-action" type="button" data-integration-view="${action.view}">${action.label}</button>`;
  }

  function renderCards() {
    const holder = q('#uxIntegrationCardsV2');
    if (!holder) return;
    holder.innerHTML = INTEGRATIONS.map(item => {
      const actions = item.actions.map(action => actionHtml(item, action)).join('');
      const live = item.source
        ? `<span class="ux-int-live" data-integration-source-v2="${item.source}"><span class="dot"></span> Checking</span>`
        : '<span class="ux-int-live neutral"><span class="dot"></span> Not verified</span>';
      return `<article class="ux-int-card" data-tier="${item.tier}" aria-labelledby="ux-int-v2-${item.id}">
        <div class="ux-int-card-head"><div><div class="ux-int-name" id="ux-int-v2-${item.id}">${item.name}</div><div class="ux-int-decision">${item.decision}</div></div>${tierBadge(item.tier)}</div>
        <p>${item.summary}</p>
        <div class="ux-int-guidance">${item.guidance}</div>
        <div class="ux-int-card-foot">${live}<div class="ux-int-actions">${actions}</div></div>
      </article>`;
    }).join('');
    qa('[data-integration-view]', holder).forEach(button => button.addEventListener('click', () => navigate(button.dataset.integrationView)));
  }

  function renderAlternatives() {
    const holder = q('#uxIntegrationAlternativesV2');
    if (!holder) return;
    holder.innerHTML = ALTERNATIVES.map(([name, type, decision, reason]) =>
      `<div class="ux-int-row"><div><strong>${name}</strong><span>${type}</span></div><div class="ux-int-row-decision">${decision}</div><p>${reason}</p></div>`
    ).join('');
  }

  function updateService(source, service) {
    const element = q(`[data-integration-source-v2="${source}"]`);
    if (!element) return;
    const state = service?.state || 'UNKNOWN';
    const optional = service?.displayState === 'OPTIONAL_OFFLINE';
    element.className = `ux-int-live ${String(state).toLowerCase()}`;
    const label = optional ? 'Optional offline' : state === 'HEALTHY' ? 'Healthy' : state === 'DOWN' ? 'Down' : state === 'DEGRADED' ? 'Degraded' : 'Status unavailable';
    element.innerHTML = `<span class="dot ${optional ? '' : state}"></span> ${label}`;
  }

  function setBusy(busy) {
    const button = q('#uxIntegrationRefreshV2');
    if (!button) return;
    button.disabled = busy;
    button.setAttribute('aria-busy', String(busy));
    button.textContent = busy ? 'Checking…' : 'Refresh status';
  }

  async function loadStatus() {
    if (loadStatus.pending) return loadStatus.pending;
    const task = (async () => {
      const summary = q('#uxIntegrationStatusSummaryV2');
      const checked = q('#uxIntegrationLastCheckedV2');
      if (summary) summary.textContent = 'Checking local services…';
      if (checked) checked.textContent = '';
      setBusy(true);
      try {
        const results = await Promise.allSettled([
          fetch('/api/status', { cache: 'no-store' }),
          fetch('/api/capabilities', { cache: 'no-store' })
        ]);
        let status = null;
        let capabilities = null;
        if (results[0].status === 'fulfilled' && results[0].value.ok) status = await results[0].value.json();
        if (results[1].status === 'fulfilled' && results[1].value.ok) capabilities = await results[1].value.json();

        const services = Array.isArray(status?.services) ? status.services : [];
        updateService('n8n', services.find(service => service.name === 'n8n'));
        updateService('comfy', services.find(service => service.name === 'comfy'));

        if (status) {
          const healthy = services.filter(service => ['n8n', 'comfy'].includes(service.name) && service.state === 'HEALTHY').length;
          q('#uxIntegrationNativeCountV2').textContent = `${healthy}/2`;
          summary.textContent = healthy === 2 ? 'Core local integrations are healthy.' : healthy === 1 ? 'One core local integration needs attention.' : 'Core local integration health needs attention.';
        } else {
          q('#uxIntegrationNativeCountV2').textContent = '—';
          summary.textContent = 'Live service status is unavailable; integration recommendations are unchanged.';
        }

        q('#uxIntegrationMediaStateV2').textContent = capabilities
          ? capabilities?.images?.available === true ? 'Ready' : 'No supported model'
          : 'Status only';
        checked.textContent = `Checked ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
      } catch {
        if (summary) summary.textContent = 'Could not read live integration status.';
        if (checked) checked.textContent = 'Status request failed';
      } finally {
        setBusy(false);
      }
    })();
    loadStatus.pending = task;
    try { return await task; }
    finally { loadStatus.pending = null; }
  }

  function mount() {
    const section = q('#integrations');
    if (!section || section.dataset.integrationV2 === 'true') return Boolean(section);
    section.dataset.integrationV2 = 'true';
    section.innerHTML = `
      <div class="topbar"><div><h1>Integrations</h1><p class="sub">A local-first integration policy grounded in the reviewed tools and the current appliance architecture. Native services stay authoritative; bridges are explicit; cloud fallbacks remain opt-in.</p></div><button class="btn" type="button" id="uxIntegrationRefreshV2" aria-busy="false">Refresh status</button></div>
      <div class="ux-int-hero ux-int-v2"><div><span class="eyebrow">Recommended architecture</span><h2>Extend the capabilities Local AI already owns instead of collecting parallel AI apps.</h2><p id="uxIntegrationStatusSummaryV2" role="status" aria-live="polite">Checking local services…</p><span id="uxIntegrationLastCheckedV2" class="ux-int-checked"></span></div><div class="ux-int-metrics"><div><b id="uxIntegrationNativeCountV2">—</b><span>native services healthy</span></div><div><b id="uxIntegrationMediaStateV2">—</b><span>local media capability</span></div><div><b>Explicit</b><span>external trust crossings</span></div></div></div>
      <div class="section-head ux-int-section-head"><div><h2>Implement / keep</h2><p>Recommended components and the guardrails that keep them from fragmenting Local AI.</p></div></div><div id="uxIntegrationCardsV2" class="ux-int-grid"></div>
      <div class="card ux-int-policy"><div><div class="eyebrow">Integration rules</div><h2>What gets into the core</h2></div><div class="ux-int-policy-grid"><div><strong>1. Native before cloud</strong><span>Ollama, n8n and ComfyUI remain the default execution path.</span></div><div><strong>2. One owner per capability</strong><span>Do not add another primary chat, automation, or media surface that fragments state.</span></div><div><strong>3. Bridges must create durable value</strong><span>Penpot and Obsidian should exchange inspectable artifacts or source context, not merely open another tab.</span></div><div><strong>4. Cloud is an explicit fallback</strong><span>Credentials and uploads require deliberate user action after a measured local capability gap is documented.</span></div></div></div>
      <div class="card ux-int-research"><div><div class="eyebrow">Research-backed safeguards</div><h2>Operational requirements</h2></div><div class="ux-int-research-grid"><div><strong>n8n security audit</strong><span>Use the official audit after adding credentials, community nodes, or public webhooks; it checks credential, database, filesystem, node, and instance risks.</span><a data-external="true" href="https://docs.n8n.io/hosting/securing/security-audit/" target="_blank" rel="noopener noreferrer" aria-label="n8n security audit official guidance (opens external site)">Official guidance ↗</a></div><div><strong>ComfyUI API compatibility</strong><span>Custom nodes that require direct client/server communication may not be usable through API-mode automation. Verify this before making a node part of a Local AI workflow.</span><a data-external="true" href="https://docs.comfy.org/custom-nodes/overview" target="_blank" rel="noopener noreferrer" aria-label="ComfyUI custom-node model guidance (opens external site)">Custom-node model ↗</a></div><div><strong>Penpot self-host + MCP</strong><span>Penpot can run on your own server and exposes an MCP workflow for design-to-code/design-to-design work. MCP keys are secrets and stay out of client code.</span><a data-external="true" href="https://help.penpot.app/mcp/" target="_blank" rel="noopener noreferrer" aria-label="Penpot MCP guidance (opens external site)">Penpot MCP ↗</a></div></div></div>
      <div class="card ux-int-next"><div><div class="eyebrow">Implementation order</div><h2>Next technical steps</h2></div><div class="ux-int-next-grid"><div><b>Shipped</b><strong>Live n8n / ComfyUI health</strong><span>Uses the appliance status and capability endpoints already present.</span></div><div><b>Next</b><strong>ComfyUI capability discovery</strong><span>Detect video/avatar model and node readiness before SVD or SadTalker can show as available.</span></div><div><b>Next</b><strong>Obsidian vault ingestion</strong><span>Mount/select a local vault and ingest supported source files into Project Knowledge with source provenance.</span></div><div><b>Opt-in</b><strong>Penpot MCP bridge</strong><span>Connect a self-hosted Penpot design workspace without exposing MCP credentials to the browser.</span></div></div></div>
      <details class="ux-int-reviewed"><summary>Reviewed alternatives <span>${ALTERNATIVES.length} tools/groups intentionally kept out of the core</span></summary><div class="section-head ux-int-section-head"><div><h2>Reviewed, not integrated</h2><p>Useful independently in some cases, but not justified as Local AI runtime dependencies today.</p></div></div><div id="uxIntegrationAlternativesV2" class="ux-int-table"></div></details>`;

    renderCards();
    renderAlternatives();
    q('#uxIntegrationRefreshV2')?.addEventListener('click', loadStatus);
    loadStatus();

    const observer = new MutationObserver(() => {
      if (section.classList.contains('active')) window.setTimeout(loadStatus, 75);
    });
    observer.observe(section, { attributes: true, attributeFilter: ['class'] });
    return true;
  }

  function init() {
    if (mount()) return;
    const observer = new MutationObserver(() => {
      if (mount()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
