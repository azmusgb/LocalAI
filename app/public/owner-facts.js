// Projects › Memory › About you and the house: the owner's short list of lasting facts
// (docs/superpowers/specs/2026-11-19-owner-facts-design.md, PR 1). Loaded by ui.js the first time Memory opens; the
// section is in index.html (#ownerFacts). Facts are shared memory notes in the 'owner' category, read with GET
// /api/memory and changed through /api/memory/add|update|delete, which enforce the rules (app/owner-facts.js).
// Each shared note in the list below that fits gets "Make this a fact"; nothing else about those notes changes.
(function () {
  'use strict';
  // The same limits as app/owner-facts.js (tests/owner-facts.test.cjs keeps them equal).
  const MAX_FACTS = 30, MAX_LENGTH = 200, CATEGORY = 'owner';
  const FULL = `Full: ${MAX_FACTS} of ${MAX_FACTS}. Delete or edit a fact to add another.`;
  const USED = 'Used only in answers from this PC.';
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const one = t => String(t ?? '').replace(/\s+/g, ' ').trim();
  const ui = () => window.LocalAIUI || {};
  const getJson = (url, opt) => (ui().fetchJson ? ui().fetchJson(url, opt) : fetch(url, opt).then(async r => { const j = await r.json().catch(() => null); if (!r.ok || !j) throw new Error((j && j.error) || `HTTP ${r.status}`); return j; }));
  const post = (url, body) => getJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const said = m => (ui().toast ? ui().toast(m) : null);
  const reason = e => one(e && e.message || e).replace(/\.$/, '') || 'no answer';

  // 'loading' | 'ready' | 'error'. facts: oldest first, so a new one lands beside Add. shared: notes that may become one.
  // open: the list shows every fact; closed, the first SHOWN (oldest) and "Show all N facts".
  // expanded: the group shows its list and Add; folded, only its count line, so Memory's notes stay on the first screen.
  // It holds for the tab's session, so a redraw or coming back to Memory doesn't snap it shut.
  const EXPANDED_KEY = 'localai.ownerFacts.expanded';
  const s = { state: 'loading', error: '', facts: [], shared: [], editing: '', seq: 0, open: false, expanded: false };
  try { s.expanded = sessionStorage.getItem(EXPANDED_KEY) === '1'; } catch { /* storage off: start folded */ }
  const SHOWN = 5;
  const isFact = n => n && n.category === CATEGORY && !n.projectId;
  const when = n => { const v = Date.parse(n && n.createdAt); return Number.isNaN(v) ? 0 : v; };

  async function load() {
    const seq = ++s.seq;
    if (s.state !== 'ready') { s.state = 'loading'; paint(); }
    try {
      const j = await getJson('/api/memory', { cache: 'no-store' });
      if (!Array.isArray(j.items)) throw new Error('The server sent an unreadable reply');
      if (seq !== s.seq) return;
      s.facts = j.items.filter(isFact).sort((a, b) => when(a) - when(b));
      s.shared = j.items.filter(n => n && !n.projectId && n.category !== CATEGORY && typeof n.text === 'string');
      s.state = 'ready'; s.error = '';
    } catch (e) {
      if (seq !== s.seq) return;
      s.state = 'error'; s.error = reason(e);
    }
    paint(); decorate();
  }

  function row(f, i) {
    const tid = `ownerFact${i}`;
    if (s.editing === f.id) {
      return `<li class="ui-row owner-fact owner-fact--edit" data-fact-id="${esc(f.id)}"><form class="owner-facts__form" data-fact-form novalidate>
        <label class="visually-hidden" for="ownerFactEdit">Edit this fact</label>
        <input id="ownerFactEdit" class="ui-field" maxlength="${MAX_LENGTH}" autocomplete="off" value="${esc(f.text)}" aria-describedby="ownerFactsRule">
        <button type="submit" class="ui-btn ui-btn--primary">Save fact</button><button type="button" class="ui-btn ui-btn--ghost" data-fact-cancel>Cancel</button>
        <p class="ui-notice ui-notice--bad owner-facts__error" role="alert" hidden></p></form></li>`;
    }
    return `<li class="ui-row ui-row--lamp owner-fact" data-fact-id="${esc(f.id)}"${i >= SHOWN && !s.open ? ' hidden' : ''}><span class="owner-fact__text" id="${tid}">${esc(f.text)}</span>
      <span class="owner-fact__actions"><button type="button" class="ui-btn ui-btn--ghost" data-fact-edit aria-describedby="${tid}">Edit</button><button type="button" class="ui-btn ui-btn--ghost" data-fact-delete aria-describedby="${tid}">Delete</button></span></li>`;
  }

  function paint() {
    const body = $('ownerFactsBody'); if (!body) return;
    body.removeAttribute('data-load-failed');
    body.setAttribute('aria-busy', String(s.state === 'loading'));
    if (s.state === 'loading') {
      body.innerHTML = '<p class="visually-hidden" role="status">Loading your facts…</p><span class="ui-skeleton owner-facts__wait" aria-hidden="true"></span><span class="ui-skeleton owner-facts__wait" aria-hidden="true"></span>';
      return;
    }
    if (s.state === 'error') {
      // Never "No facts yet": the list wasn't read, so nobody knows what is on it, and Add waits for it too.
      body.innerHTML = `<p class="ui-notice ui-notice--bad" role="alert" id="ownerFactsError">Couldn't read your saved facts: ${esc(s.error)}.</p><button type="button" class="ui-btn" id="ownerFactsRetry">Try again</button>`;
      return;
    }
    const n = s.facts.length, full = n >= MAX_FACTS, more = n > SHOWN;
    if (!more) s.open = false;
    const rule = `<p class="owner-facts__rule" id="ownerFactsRule">${full ? FULL : `One sentence, up to ${MAX_LENGTH} characters.`}</p>`;
    // A redraw (Edit, Show all, a save) keeps a half-typed new fact, and its focus if it had it.
    const addWas = $('ownerFactText'), keep = addWas ? { v: addWas.value, f: document.activeElement === addWas } : null;
    // A redraw while a fact is being edited (Show all / Show the first 5) keeps what was typed there.
    const ed = $('ownerFactEdit'), draft = ed && ed.closest('[data-fact-id]')?.dataset.factId === s.editing ? { v: ed.value, f: document.activeElement === ed } : null;
    // Folded: one line (how many, that a full list is full, where they are used) and one button. Unfolded: the list,
    // Show all and Add, with the rule, or why Add is off, under it. With no facts the open group needs no Hide button.
    body.innerHTML = `<div class="owner-facts__head">${n
        ? `<p class="owner-facts__count"><span id="ownerFactsCount">${n} of ${MAX_FACTS}</span> facts${full ? ', the most you can keep' : ''} · used only in answers from this PC</p>`
        : `<p class="owner-facts__count" id="ownerFactsEmpty">No facts yet, like your printer or the units you prefer. ${USED}</p>`}
        <button type="button" class="ui-btn owner-facts__toggle" id="ownerFactsToggle" aria-controls="ownerFactsPanel" aria-expanded="${s.expanded}"${!n && s.expanded ? ' hidden' : ''}>${toggleWords(n)}</button></div>
      <div class="owner-facts__panel" id="ownerFactsPanel"${s.expanded ? '' : ' hidden'}>
      ${n ? `<ul class="ui-rows" id="ownerFactsList">${s.facts.map(row).join('')}</ul>` : ''}
      ${more ? `<button type="button" class="ui-btn ui-btn--ghost" id="ownerFactsMore" aria-controls="ownerFactsList" aria-expanded="${s.open}">${s.open ? `Show the first ${SHOWN}` : `Show all ${n} facts`}</button>` : ''}
      <form class="owner-facts__form" id="ownerFactsAdd" novalidate>
        <label class="owner-facts__label" for="ownerFactText">Add a fact</label>
        <input id="ownerFactText" class="ui-field" maxlength="${MAX_LENGTH}" autocomplete="off" aria-describedby="ownerFactsRule"${full ? ' disabled' : ''}>
        <button type="submit" class="ui-btn" id="ownerFactAddBtn" aria-describedby="ownerFactsRule"${full ? ' disabled' : ''}>Add fact</button>
        ${rule}
        <p class="ui-notice ui-notice--bad owner-facts__error" id="ownerFactsAddError" role="alert" hidden></p>
      </form></div>`;
    if (keep && keep.v && !full) { const t = $('ownerFactText'); t.value = keep.v; if (keep.f) t.focus(); }
    else if (keep && keep.f && !full) $('ownerFactText').focus();
    if (draft && $('ownerFactEdit')) { const t = $('ownerFactEdit'); t.value = draft.v; if (draft.f) t.focus(); }
  }

  const toggleWords = n => (s.expanded ? 'Hide facts' : n ? 'Show facts' : 'Add a fact');
  // Unfold or fold the group in place: no redraw, so a half-typed fact or edit stays as it was.
  function expand(on) {
    s.expanded = on;
    try { sessionStorage.setItem(EXPANDED_KEY, on ? '1' : '0'); } catch { /* storage off: this page view only */ }
    const panel = $('ownerFactsPanel'), t = $('ownerFactsToggle');
    if (panel) panel.hidden = !on;
    if (t) { t.setAttribute('aria-expanded', String(on)); t.textContent = toggleWords(s.facts.length); t.hidden = on && !s.facts.length; }
  }

  // The lowest point of the window nothing fixed covers: the top of the phone's tab bar, or of a toast that is showing.
  function bottomEdge() {
    let b = innerHeight;
    for (const el of [$('uxMobileNav'), $('toast')]) {
      if (!el || (el.id === 'toast' && !el.classList.contains('show')) || getComputedStyle(el).position !== 'fixed') continue;
      const r = el.getBoundingClientRect();
      if (r.height > 0 && r.top > 0 && r.top < b) b = r.top;
    }
    return b;
  }

  const failIn = (form, text) => { const p = form.querySelector('.owner-facts__error'); p.textContent = text; p.hidden = false; };
  const busy = (btn, on, words) => { if (on) { btn.dataset.words = btn.textContent; btn.textContent = words; } else if (btn.dataset.words) { btn.textContent = btn.dataset.words; delete btn.dataset.words; } btn.disabled = on; };
  // Focus a fact's control after a redraw; a row past the first SHOWN opens the list first. The fallback is the element
  // itself: refocus looks a selector up inside the list, which is gone once the last fact is.
  const focusRow = (id, opts = {}) => {
    const r = ui().refocus; if (!r) return;
    const want = [id, opts.next, opts.prev].find(x => x && s.facts.some(f => f.id === x));
    if (!s.expanded) expand(true);   // focus never lands in a folded group
    if (want && !s.open && s.facts.findIndex(f => f.id === want) >= SHOWN) { s.open = true; paint(); }
    const add = $('ownerFactText');
    r(id, { within: '#ownerFactsList', key: 'factId', fallback: add && !add.disabled ? add : $('ownerFactsRule'), ...opts });
  };

  async function add(form) {
    const input = $('ownerFactText'), btn = $('ownerFactAddBtn'), text = one(input.value);
    form.querySelector('.owner-facts__error').hidden = true;
    if (!text) { input.setAttribute('aria-invalid', 'true'); failIn(form, 'Write the fact first.'); input.focus(); return; }
    input.removeAttribute('aria-invalid'); input.readOnly = true; busy(btn, true, 'Adding…');
    try {
      const j = await post('/api/memory/add', { projectId: '', category: CATEGORY, text });
      // The new fact lands at the end, beside Add: a collapsed list opens so it shows.
      input.value = ''; s.facts.push(j.item); if (s.facts.length > SHOWN) s.open = true; paint(); decorate(); said('Added the fact'); $('ownerFactText')?.focus();
      if (s.facts.length >= MAX_FACTS) focusRow(j.item.id);
    } catch (e) {
      input.readOnly = false; busy(btn, false); failIn(form, `Couldn't add this fact: ${reason(e)}.`); input.focus();
    }
  }

  async function save(form, id) {
    const input = form.querySelector('input'), btn = form.querySelector('button[type="submit"]'), text = one(input.value);
    form.querySelector('.owner-facts__error').hidden = true;
    if (!text) { input.setAttribute('aria-invalid', 'true'); failIn(form, 'Write the fact first, or Delete it.'); input.focus(); return; }
    input.readOnly = true; busy(btn, true, 'Saving…'); form.querySelector('[data-fact-cancel]').disabled = true;
    try {
      const j = await post('/api/memory/update', { id, category: CATEGORY, text });
      const i = s.facts.findIndex(f => f.id === id); if (i >= 0) s.facts[i] = j.item;
      s.editing = ''; paint(); said('Saved the fact'); focusRow(id, { control: '[data-fact-edit]' });
    } catch (e) {
      input.readOnly = false; busy(btn, false); form.querySelector('[data-fact-cancel]').disabled = false;
      failIn(form, `Couldn't save this fact: ${reason(e)}.`); input.focus();
    }
  }

  async function remove(li, btn) {
    const id = li.dataset.factId, f = s.facts.find(x => x.id === id); if (!f) return;
    const ask = ui().ask; if (!ask) return;
    const q = await ask({ title: 'Delete this fact?', effect: `"${f.text}" comes off your list for good.`, confirmLabel: 'Delete', tone: 'danger' });
    if (!q.ok) return;
    li.querySelector('.owner-facts__error')?.remove();
    busy(btn, true, 'Deleting…');
    const at = s.facts.indexOf(f), next = s.facts[at + 1]?.id || '', prev = s.facts[at - 1]?.id || '';
    try {
      await post('/api/memory/delete', { id });
      s.facts = s.facts.filter(x => x.id !== id); paint(); said('Deleted the fact'); focusRow('', { next, prev, control: '[data-fact-delete]' });
      decorate();
    } catch (e) {
      busy(btn, false);
      const p = document.createElement('p'); p.className = 'ui-notice ui-notice--bad owner-facts__error'; p.setAttribute('role', 'alert');
      p.textContent = `Couldn't delete this fact: ${reason(e)}.`; li.append(p); btn.focus();
    }
  }

  // "Make this a fact" on each shared note in Memory's list (#memoryList, drawn by app.js) that is short enough.
  function decorate() {
    const list = $('memoryList'); if (!list || s.state !== 'ready') return;
    const ok = new Map(s.shared.filter(n => one(n.text).length && one(n.text).length <= MAX_LENGTH).map(n => [n.id, n]));
    const full = s.facts.length >= MAX_FACTS;
    list.querySelectorAll('[data-mem-del]').forEach(del => {
      const id = del.getAttribute('data-mem-del'), bar = del.parentElement, has = bar.querySelector('[data-mem-fact]');
      if (!ok.has(id)) { if (has) has.remove(); return; }
      const b = has || document.createElement('button');
      if (!has) { b.type = 'button'; b.className = 'btn-outline'; b.dataset.memFact = id; b.textContent = 'Make this a fact'; bar.insertBefore(b, del); }
      // Full: the button stays, disabled, and names the reason (the line beside Add says it on screen).
      if (b.dataset.words) return;   // a request is in flight
      b.disabled = full;
      if (full) b.setAttribute('aria-describedby', 'ownerFactsRule'); else b.removeAttribute('aria-describedby');
    });
  }

  async function promote(btn) {
    const id = btn.dataset.memFact, card = btn.closest('.memory-card') || btn.parentElement;
    card.querySelector('.owner-facts__error')?.remove();
    busy(btn, true, 'Making it a fact…');
    try {
      const j = await post('/api/memory/update', { id, category: CATEGORY });
      s.shared = s.shared.filter(n => n.id !== id); s.facts.push(j.item); paint(); decorate(); said('Made it a fact');
      const pick = $('memoryProject'); if (pick) pick.dispatchEvent(new Event('change'));   // app.js redraws the notes without it
      focusRow(id, { control: '[data-fact-edit]', highlight: false });
    } catch (e) {
      busy(btn, false);
      const p = document.createElement('p'); p.className = 'ui-notice ui-notice--bad owner-facts__error'; p.setAttribute('role', 'alert');
      p.textContent = `Couldn't make it a fact: ${reason(e)}.`; card.append(p); btn.focus();
    }
  }

  function wire() {
    const sec = $('ownerFacts'); if (!sec || sec.dataset.wired) return;
    sec.dataset.wired = '1';
    sec.addEventListener('submit', e => {
      const form = e.target; e.preventDefault();
      if (form.id === 'ownerFactsAdd') add(form);
      else if (form.matches('[data-fact-form]')) save(form, form.closest('[data-fact-id]').dataset.factId);
    });
    sec.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b || b.disabled) return;
      const li = b.closest('[data-fact-id]');
      if (b.id === 'ownerFactsRetry') load();
      else if (b.id === 'ownerFactsToggle') { const n = s.facts.length, on = !s.expanded; expand(on); if (on && !n) $('ownerFactText')?.focus(); }
      else if (b.id === 'ownerFactsMore') { s.open = !s.open; paint(); $('ownerFactsMore')?.focus(); }
      else if (b.matches('[data-fact-edit]')) { s.editing = li.dataset.factId; paint(); const t = $('ownerFactEdit'); t.focus(); t.setSelectionRange(t.value.length, t.value.length); }
      else if (b.matches('[data-fact-cancel]')) { const id = s.editing; s.editing = ''; paint(); focusRow(id, { control: '[data-fact-edit]' }); }
      else if (b.matches('[data-fact-delete]')) remove(li, b);
    });
    // A focused control brings its whole row into view (on a phone the fact's text sits above its buttons, and the
    // browser and refocus scroll only the control): clear of the sticky head (the row's scroll margin) and above what is
    // fixed at the bottom, the phone's tab bar and a showing toast. The kit has no token for the tab bar's height, so it
    // is measured, as ui.js does for Agent World.
    sec.addEventListener('focusin', e => {
      const li = e.target.closest('.owner-fact'); if (!li) return;
      const cs = getComputedStyle(li), r = li.getBoundingClientRect(), head = parseFloat(cs.scrollMarginTop) || 0;
      const gap = (parseFloat(cs.getPropertyValue('--ui-s-3')) || 0) * (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);
      const foot = bottomEdge() - gap;
      if (r.top < head || r.height > foot - head) li.scrollIntoView({ block: 'start' });
      else if (r.bottom > foot) window.scrollBy({ top: r.bottom - foot, behavior: 'instant' });
    });
    sec.addEventListener('keydown', e => {
      if (e.key === 'Escape' && e.target.id === 'ownerFactEdit') { e.preventDefault(); sec.querySelector('[data-fact-cancel]').click(); }
    });
    const list = $('memoryList');
    if (list) {
      list.addEventListener('click', e => { const b = e.target.closest('[data-mem-fact]'); if (b && !b.disabled) promote(b); });
      new MutationObserver(decorate).observe(list, { childList: true });
    }
    // Opening Memory again reads the list again (a fact may have changed on another device).
    const page = $('memory');
    if (page) { let on = page.classList.contains('active'); new MutationObserver(() => { const now = page.classList.contains('active'); if (now && !on && !s.editing) load(); on = now; }).observe(page, { attributes: true, attributeFilter: ['class'] }); }
  }

  wire(); load();
  window.LocalAIOwnerFacts = { reload: load };
})();
