// Models › Cloud models: the owner's switch for the model coordinator, each cloud service's state and what runs where
// (docs/superpowers/specs/2026-10-26-model-coordinator-design.md), then how answers have landed (the owner's Good answer /
// Not right, docs/superpowers/specs/2026-11-19-answer-feedback-design.md). Loaded by ui.js the first time Models opens.
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
    box.innerHTML = `<div class="section-head"><div><h2 id="modelRoutingTitle">Cloud models</h2><p>Private things always stay on this PC: health, money, legal and family matters, identity, voice and Siri, House questions, your files and photos, and anything you mark "Keep on this PC".</p></div></div>
      <label class="home-check" for="modelCloudSwitch"><input type="checkbox" role="switch" id="modelCloudSwitch"${j.cloud ? ' checked' : ''}><span>Use cloud models for work that isn't private</span></label>
      <p id="modelCloudState" class="meta" role="status">${esc(stateText(j.cloud === true))}</p>
      <h3>Cloud services</h3>
      <ul id="modelRoutingProviders" class="model-routing-list">${providers.map(provider).join('')}</ul>
      <p class="meta">Keys live in stack.env on the PC. This page only shows whether one is set.</p>
      <h3>What runs where</h3>
      <table id="modelRoutingTable" class="model-routing-table"><thead><tr><th scope="col">Work</th><th scope="col">Where it runs</th></tr></thead><tbody>${(j.table || []).map(r => `<tr><td>${esc(r.label)}</td><td>${esc(r.where || (r.cloud ? 'A cloud model when it isn\'t private' : 'Always on this PC'))}</td></tr>`).join('')}</tbody></table>`;
    const sw = $('modelCloudSwitch');
    sw.addEventListener('change', () => save(sw));
    placeFeedback();
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
      placeFeedback();
    } finally { delete box.dataset.busy; }
  }

  // ---- How answers have landed (GET /api/runs/feedback/summary) ----
  // A section of its own on Models, right after the Cloud models card (heading and rows, no card): counts by model for 30
  // and 90 days, then the newest answers marked not right with the run they came from. Loading, empty and a failed read
  // come from LocalAIUI.loadInto; a failed read says so and never shows zeros.
  const fb = document.createElement('section');
  fb.id = 'answerFeedback'; fb.className = 'ui-cq ui-section'; fb.setAttribute('aria-labelledby', 'answerFeedbackTitle');
  fb.innerHTML = '<h2 id="answerFeedbackTitle">How answers have landed</h2><p class="ui-section__note">From the Good answer and Not right buttons under each answer. They are kept here and never sent to a model.</p><div id="answerFeedbackBody" class="ui-section"></div>';
  function placeFeedback() { const box = $('modelRouting'); if (box && box.nextElementSibling !== fb) box.after(fb); }
  const PROVIDERS = { ollama: 'On this PC', groq: 'Groq', cerebras: 'Cerebras' };
  const modelName = r => r.provider ? `${PROVIDERS[r.provider] || r.provider}${r.model ? ' · ' + r.model : ''}` : 'Not recorded';
  const when = iso => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? 'Time not recorded' : d.toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); };
  const share = r => `${Math.round(r.good / (r.good + r.bad) * 100)}%`;
  function counts(w, label) {
    if (!w.rows.length) return `<p class="meta">No answers rated in the ${esc(label.toLowerCase())}.</p>`;
    const th = (t, num) => `<th scope="col" role="columnheader"${num ? ' class="ui-table__num"' : ''}>${t}</th>`;
    const td = (t, l, num) => `<td role="cell" data-label="${l}"${num ? ' class="ui-table__num"' : ''}>${t}</td>`;
    return `<table class="ui-table ui-table--stack" role="table"><caption>${esc(label)}: ${w.good} good, ${w.bad} not right</caption>
      <thead role="rowgroup"><tr role="row">${th('Model')}${th('Good', 1)}${th('Not right', 1)}${th('Good share', 1)}</tr></thead>
      <tbody role="rowgroup">${w.rows.map(r => `<tr role="row">${td(esc(modelName(r)), 'Model')}${td(r.good, 'Good', 1)}${td(r.bad, 'Not right', 1)}${td(share(r), 'Good share', 1)}</tr>`).join('')}</tbody></table>`;
  }
  function recent(list) {
    if (!list.length) return '<p class="meta">No answers marked not right.</p>';
    return `<ul class="ui-rows" id="answerFeedbackRecent">${list.map(x => {
      const asked = esc(x.asked || 'Question not recorded');
      const bits = [x.note ? `"${x.note}"` : 'No note', when(x.at), modelName(x)];
      if (!x.kept) bits.push('this run is no longer kept');
      const inner = `<div><span class="ui-row__title">${asked}</span><span class="ui-row__detail">${esc(bits.join(' · '))}</span></div>`;
      // A kept run's whole row is the link to it, so the target is the row (44 px and up), not one line of text.
      return x.kept ? `<li><a class="ui-row" href="#run/${encodeURIComponent(x.runId)}">${inner}</a></li>` : `<li class="ui-row">${inner}</li>`;
    }).join('')}</ul>`;
  }
  function loadFeedback() {
    placeFeedback();
    const body = $('answerFeedbackBody'), U = window.LocalAIUI;
    if (!body || !U?.loadInto || fb.dataset.busy) return;
    fb.dataset.busy = '1';
    U.loadInto(body, async () => {
      const r = await fetch('/api/runs/feedback/summary', { cache: 'no-store', headers: { Accept: 'application/json' } });
      const j = await r.json().catch(() => null);
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      if (!j || typeof j.total !== 'number' || !j.days30 || !j.days90 || !Array.isArray(j.recent)) throw new Error('The server sent an unreadable reply.');
      return j;
    }, {
      what: 'how answers have landed', empty: 'No answers rated yet. Use the buttons under an answer.',
      render: (box, j) => {
        if (!j.total) return false;
        box.innerHTML = `${counts(j.days30, 'Last 30 days')}${counts(j.days90, 'Last 90 days')}<h3>Recent answers marked not right</h3>${recent(j.recent)}`;
      }
    }).catch(() => {}).finally(() => { delete fb.dataset.busy; });
  }

  // Every time Models opens, show the latest (usage and resting times change, and so do ratings).
  const section = $('models');
  if (section) new MutationObserver(() => { if (section.classList.contains('active')) { load(); loadFeedback(); } }).observe(section, { attributes: true, attributeFilter: ['class'] });
  load(); loadFeedback();
})();
