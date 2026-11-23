// Improve › Research: a read-only view of GET /api/research/state (app/server/research.js): whether the intake is on, paused
// or off, its sources, the reader, the model budget and the six measures (design 2026-11-19-knowledge-loop, 11.8).
// Loaded by ui.js the first time Research opens. No write actions here. A read that fails, or a part the server marks
// unreadable, says so in words: it is never drawn as zero, empty or off.
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const V = window.LocalAIViews, U = window.LocalAIUI;
  const NR = 'Not reported';
  const isNum = v => typeof v === 'number' && Number.isFinite(v);
  const num = v => isNum(v) ? v.toLocaleString() : NR;
  const when = iso => { const d = iso ? new Date(iso) : null; return !d ? 'Not yet' : Number.isNaN(d.getTime()) ? 'Time not recorded' : d.toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); };
  const words = c => { const t = String(c || '').replace(/_/g, ' '); return t ? t[0].toUpperCase() + t.slice(1) : 'Unknown'; };
  const cap = t => { const x = String(t || ''); return x ? x[0].toUpperCase() + x.slice(1) : x; };
  const chip = (tone, text) => `<span class="ui-chip${tone ? ` ui-chip--${tone}` : ''}">${esc(text)}</span>`;
  const bad = html => `<p class="ui-notice ui-notice--bad" role="alert">${html}</p>`;
  const row = (title, value, detail) => `<li class="ui-row ui-row--lamp"><span><span class="ui-row__title">${esc(title)}</span>${detail ? `<span class="ui-row__detail">${esc(detail)}</span>` : ''}</span><span class="ui-row__value">${esc(value)}</span></li>`;
  const section = (id, title, note, body) => `<section id="${id}" class="ui-section" aria-labelledby="${id}Title"><h2 id="${id}Title">${title}</h2>${note ? `<p class="ui-section__note">${note}</p>` : ''}${body}</section>`;
  const th = (t, n) => `<th scope="col" role="columnheader"${n ? ' class="ui-table__num"' : ''}>${t}</th>`;
  const td = (t, l, n) => `<td role="cell" data-label="${l}"${n ? ' class="ui-table__num"' : ''}>${t}</td>`;
  const table = (cap, heads, rows) => `<table class="ui-table ui-table--stack" role="table"><caption>${cap}</caption><thead role="rowgroup"><tr role="row">${heads.join('')}</tr></thead><tbody role="rowgroup">${rows.join('')}</tbody></table>`;

  const CAPS = { 'day.calls': 'Model calls today', 'day.chars': 'Characters sent to a model today', 'week.calls': 'Model calls this week', 'week.chars': 'Characters sent to a model this week',
    'repo.day.calls': 'Calls about one repository today', 'tier2.day.calls': 'Claude calls today', 'tier2.day.chars': 'Characters sent to Claude today' };
  const MEASURES = [['costPerValidatedImprovement', 'Cost per validated finding'], ['modelCallsAvoided', 'Model calls avoided'], ['defectDetection', 'Defect detection'],
    ['recommendationPrecision', 'Recommendation precision'], ['regressionEscapes', 'Regression escapes'], ['investigationEfficiency', 'Investigation efficiency']];
  const LAST_TONE = { finding: 'ok', no_finding: 'ok', idle: 'ok', out_of_scope: 'ok', error: 'bad', failed: 'bad', model_failed: 'warn', budget_exhausted: 'warn', held: 'warn', daily_cap: 'warn', busy: 'warn' };

  function budget(b) {
    if (!b || typeof b !== 'object' || b.unreadable !== false || !Array.isArray(b.caps)) return bad(`Couldn't read the model budget${b?.reason ? ` (${esc(b.reason)})` : ''}. Its limits and use are not shown, and none is assumed to be zero.`);
    if (!b.caps.length) return '<p class="meta">No limits are set.</p>';
    return table('Model budget: used, limit and when each resets', [th('Limit'), th('Used', 1), th('Allowed', 1), th('Resets')], b.caps.map(c => {
      const limit = isNum(c.limit) ? (c.limit === 0 ? 'None allowed' : num(c.limit)) : NR;
      return `<tr role="row">${td(esc(CAPS[c.name] || c.name), 'Limit')}${td(num(c.used), 'Used', 1)}${td(limit, 'Allowed', 1)}${td(esc(when(c.resetsAt)), 'Resets')}</tr>`;
    }));
  }

  function measureValue(m) {
    if (m.noData) return 'No data';
    if (!isNum(m.value)) return NR;
    return /\bper\b/.test(m.unit || '') ? m.value.toFixed(1) : `${Math.round(m.value * 100)}%`;
  }
  function measures(m) {
    if (!m || typeof m !== 'object' || m.unreadable !== false || !m.measures || typeof m.measures !== 'object') return bad(`Couldn't read the measures${m?.reason ? ` (${esc(m.reason)})` : ''}. None is shown as zero.`);
    return table('The six measures, worked out from what is stored', [th('Measure'), th('Value', 1), th('What it is')], MEASURES.map(([k, name]) => {
      const x = m.measures[k];
      if (!x || typeof x !== 'object') return `<tr role="row">${td(name, 'Measure')}${td('Not reported', 'Value', 1)}${td('The server did not send this measure.', 'What it is')}</tr>`;
      const basis = x.noData ? cap(x.note || 'Nothing to measure yet.') : `${isNum(x.num) && isNum(x.den) ? `${num(x.num)} of ${num(x.den)}` : ''}${x.unit ? ` ${x.unit}` : ''}${x.note ? `. ${cap(x.note)}` : ''}`.trim();
      return `<tr role="row">${td(name, 'Measure')}${td(esc(measureValue(x)), 'Value', 1)}${td(esc(basis), 'What it is')}</tr>`;
    }));
  }

  function reader(r) {
    if (!r || typeof r !== 'object') return bad("Couldn't read the reader's state.");
    const last = r.last && typeof r.last === 'object' ? r.last : null, c = r.counts && typeof r.counts === 'object' ? r.counts : {};
    const status = r.unreadable ? chip('unknown', "Can't read") : r.enabled ? chip('ok', r.running ? 'Reading now' : 'On') : chip('', 'Off');
    const detail = [last?.documentId && `Document ${last.documentId}`, r.unreadable ? '' : `Cursor: ${r.cursor === undefined || r.cursor === null ? NR : typeof r.cursor === 'object' ? JSON.stringify(r.cursor) : r.cursor}`, last?.holdUntil && `Held until ${when(last.holdUntil)}`].filter(Boolean).join(' · ');
    return `${r.unreadable ? bad("The reader's place in the documents couldn't be read, so how far it has read is not shown.") : ''}
      <ul class="ui-rows" id="researchReader">
        <li class="ui-row ui-row--lamp"><span><span class="ui-row__title">Reader</span><span class="ui-row__detail">Reads stored documents with the model on this PC. It never fetches anything.</span></span>${status}</li>
        <li class="ui-row ui-row--lamp"><span><span class="ui-row__title">Last result</span><span class="ui-row__detail">${esc(cap(last?.reason) || 'Not reported')}${last?.at ? ` · ${esc(when(last.at))}` : ''}</span></span>${last?.code ? chip(LAST_TONE[last.code] || '', words(last.code)) : chip('unknown', NR)}</li>
        ${row('Documents read', num(c.read))}${row('Findings stored', num(c.findings))}${row('Judged not relevant', num(c.notRelevant))}${row('Quote not in document', num(c.quoteRejected))}${row('Answer was not JSON', num(c.unparsable))}${row('Too little text', num(c.tooThin))}${row('Source paused or retired', num(c.sourceInactive))}${row('Out of scope', num(c.outOfScope))}${row('Failed', num(c.failed))}${row('Findings allowed each day', num(r.dailyFindings))}
      </ul>
      <details class="ui-disclosure"><summary class="ui-disclosure__summary">Details</summary><div class="ui-disclosure__body"><p class="research-mono">${esc(detail || 'Nothing more to report.')}</p><p class="research-mono">${esc(last?.code ? `Result code: ${last.code}` : '')}${r.lastTickAt ? esc(` · Last run ${when(r.lastTickAt)}`) : ''}</p></div></details>`;
  }

  function paint(box, s) {
    const on = s.enabled === true, paused = s.paused === true;
    const word = !on ? 'Off' : paused ? 'Paused' : 'On';
    const lamp = !on ? chip('', 'Off') : paused ? chip('warn', 'Paused') : chip('ok', 'On');
    const so = s.sources || {};
    const caption = !on ? 'Research is off on this appliance. Nothing is fetched or read.'
      : `${paused ? 'Paused: nothing is fetched until it is resumed. ' : ''}Fetched ${num(s.fetchesToday)} of ${num(s.dailyFetches)} allowed today. Last check: ${when(s.lastTickAt)}${s.lastTickSkipped ? `, stopped early (${words(s.lastTickSkipped).toLowerCase()})` : ''}.`;
    const reading = (l, k) => `<div><dt>${l}</dt><dd>${num(so[k])}</dd></div>`;
    box.innerHTML = `${s.error ? bad(esc(`${s.error}.`)) : ''}
      <section id="researchPlate" class="ui-faceplate" aria-labelledby="researchPlateName"><div class="ui-faceplate__main">
        <p class="ui-faceplate__nameplate"><span id="researchPlateName">Research intake</span>${lamp}</p>
        <p class="ui-readout">${word}</p><p class="ui-faceplate__caption">${esc(caption)}</p>
        <dl class="ui-faceplate__readings">${reading('Active sources', 'active')}${reading('Paused sources', 'paused')}${reading('Quarantined', 'quarantined')}${reading('Retired', 'retired')}</dl></div></section>
      ${section('researchReaderSec', 'Reader', 'Findings come from the reader. Sources and findings are listed here as counts; this page changes nothing.', reader(s.reader))}
      ${section('researchBudget', 'Model budget', 'What the reader may spend on model calls. A limit of none allowed means no call is made.', budget(s.budget))}
      ${section('researchMeasures', 'Measures', 'Worked out from stored rows, never reported by a model. "No data" means there is nothing to measure yet, not 0%.', measures(s.measures))}`;
  }

  async function read() {
    const j = await U.fetchJson('/api/research/state', { cache: 'no-store', headers: { Accept: 'application/json' } });
    if (typeof j.enabled !== 'boolean' || !j.sources || typeof j.sources !== 'object' || typeof j.budget !== 'object' || typeof j.reader !== 'object' || typeof j.measures !== 'object') throw new Error('The server sent an unreadable reply.');
    return j;
  }

  const root = $('research');
  if (!root || !V || !U?.loadInto) return;
  root.innerHTML = `<div class="ui-page__head"><h1 class="ui-page__title">${esc(V.label('research'))}</h1><p class="ui-page__purpose">${esc(V.description('research'))}</p></div><div id="researchBody" class="ui-section"></div><p id="researchSources" class="ui-sources"></p>`;
  let busy = false;
  async function load() {
    const body = $('researchBody');
    if (busy || !body || body.contains(document.activeElement)) return;
    busy = true;
    try { await U.loadInto(body, read, { what: 'research', render: paint }); U.sources('researchSources', 'Research', 'ok', `Read ${when(new Date().toISOString())}`); }
    catch { U.sources('researchSources', 'Research', 'bad'); }
    finally { busy = false; }
  }
  new MutationObserver(() => { if (root.classList.contains('active')) load(); }).observe(root, { attributes: true, attributeFilter: ['class'] });
  load();
})();
