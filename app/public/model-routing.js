// Models › Cloud models: the owner's switch for the model coordinator, each cloud service's state and what runs where
// (docs/superpowers/specs/2026-10-26-model-coordinator-design.md). Loaded by ui.js the first time Models opens.
// GET /api/models/routing never carries a key, only whether one is set; PUT is a guarded write (app/signin.js).
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const time = iso => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
  const stateText = on => on ? 'On: work that isn\'t private may use Groq or Cerebras. Everything else stays on this PC.' : 'Off: everything runs on this PC.';

  function provider(p) {
    const bits = [`Used today: ${Number(p.today) || 0}`];
    if (p.parkedUntil) bits.push(`Resting until ${time(p.parkedUntil)} (it hit its free limit)`);
    if (p.lastError?.message) bits.push(`Last problem: ${p.lastError.message}`);
    return `<li class="model-routing-row"><b>${esc(p.name)}</b> <span class="badge badge--${p.key ? 'good' : 'neutral'}">${p.key ? 'Key set' : 'No key'}</span><span class="meta">${esc(bits.join(' · '))}</span></li>`;
  }

  function paint(box, j) {
    const providers = Object.values(j.providers || {});
    box.innerHTML = `<div class="section-head"><div><h2 id="modelRoutingTitle">Cloud models</h2><p>Private things always stay on this PC: health, money, voice and Siri, House questions, your files and photos, and anything you mark "Keep on this PC".</p></div></div>
      <label class="home-check" for="modelCloudSwitch"><input type="checkbox" role="switch" id="modelCloudSwitch"${j.cloud ? ' checked' : ''}><span>Use cloud models for work that isn't private</span></label>
      <p id="modelCloudState" class="meta" role="status">${esc(stateText(j.cloud === true))}</p>
      <h3>Cloud services</h3>
      <ul id="modelRoutingProviders" class="model-routing-list">${providers.map(provider).join('')}</ul>
      <p class="meta">Keys live in stack.env on the PC. This page only shows whether one is set.</p>
      <h3>What runs where</h3>
      <table id="modelRoutingTable" class="model-routing-table"><thead><tr><th scope="col">Work</th><th scope="col">Where it runs</th></tr></thead><tbody>${(j.table || []).map(r => `<tr><td>${esc(r.label)}</td><td>${esc(r.where || (r.cloud ? 'A cloud model when it isn\'t private' : 'Always on this PC'))}</td></tr>`).join('')}</tbody></table>`;
    const sw = $('modelCloudSwitch');
    sw.addEventListener('change', () => save(sw));
  }

  async function save(sw) {
    const want = sw.checked, state = $('modelCloudState');
    sw.disabled = true; state.textContent = want ? 'Switching cloud models on…' : 'Switching cloud models off…';
    try {
      const r = await fetch('/api/models/routing', { method: 'PUT', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ cloud: want }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? 'This device needs to be signed in to change it.' : j.error || `HTTP ${r.status}`);
      paint($('modelRouting'), j);
      $('modelCloudSwitch')?.focus();
    } catch (e) {
      sw.checked = !want; sw.disabled = false;
      state.textContent = `Not changed: ${e.message}`;
    }
  }

  async function load() {
    const box = $('modelRouting');
    if (!box || box.dataset.busy) return;
    box.dataset.busy = '1';
    try {
      const r = await fetch('/api/models/routing', { cache: 'no-store', headers: { Accept: 'application/json' } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      if (!box.contains(document.activeElement)) paint(box, j);
    } catch (e) {
      box.innerHTML = `<h2>Cloud models</h2><p class="meta" role="alert">Couldn't load the cloud model settings (${esc(e.message)}).</p>`;
    } finally { delete box.dataset.busy; }
  }

  // Every time Models opens, show the latest (usage and resting times change).
  const section = $('models');
  if (section) new MutationObserver(() => { if (section.classList.contains('active')) load(); }).observe(section, { attributes: true, attributeFilter: ['class'] });
  load();
})();
