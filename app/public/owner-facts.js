// Projects › Memory › About you and the house: the owner's short list of lasting facts
// (docs/superpowers/specs/2026-11-19-owner-facts-design.md, PR 1). Loaded by ui.js the first time Memory opens; the
// section is in index.html (#ownerFacts). Facts are shared memory notes in the 'owner' category, read with GET
// /api/memory and changed through /api/memory/add|update|delete, which enforce the rules (app/owner-facts.js).
// Each shared note in the list below that fits gets "Make this a fact"; nothing else about those notes changes.
// Suggested by Local AI (PR 2, spec §2, D3): facts the quick local job proposed after a chat (GET /api/facts/suggestions),
// each with Save, Edit and No (POST /api/facts/suggestions/decide), inside the folded group; folded, the count line says
// how many wait. Nothing is saved until the owner chooses Save; No is remembered by the server. A failed read says so; it
// is never shown as "no suggestions". The saved facts never wait on this read.
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
  // Suggestions: 'loading' | 'ready' | 'error' | 'signin' (the routes are owner-only; this device isn't paired).
  // fail: id -> message. busy: the id being saved or declined.
  const sg = { state: 'loading', error: '', items: [], editing: '', fail: {}, busy: '', seq: 0 };
  // The suggestions routes answer a status the shared fetch helper doesn't pass on (401 sign in, 409 full).
  async function ask(url, opt) {
    let r;
    try { r = await fetch(url, { cache: 'no-store', ...opt, headers: { Accept: 'application/json', ...(opt && opt.headers) } }); }
    catch { throw Object.assign(new Error("Local AI didn't answer."), { status: 0 }); }
    const j = await r.json().catch(() => null);
    if (!r.ok || !j) throw Object.assign(new Error((j && typeof j.error === 'string' && one(j.error)) || `Local AI answered ${r.status}.`), { status: r.status, signIn: r.status === 401 });
    return j;
  }
  // A reason as one sentence: capitalised, with its full stop.
  const end = t => { const u = t.charAt(0).toUpperCase() + t.slice(1); return /[.!?]$/.test(u) ? u : u + '.'; };
  // The chat's "Local AI suggests remembering" line (fact-suggestion-line.js) reads the list again when it changes here.
  const changed = () => document.dispatchEvent(new CustomEvent('localai:fact-suggestions'));
  const isFact = n => n && n.category === CATEGORY && !n.projectId;
  const when = n => { const v = Date.parse(n && n.createdAt); return Number.isNaN(v) ? 0 : v; };

  async function load() {
    const seq = ++s.seq;
    if (s.state !== 'ready') { s.state = 'loading'; paint(); }
    const more = loadSuggestions();
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
    paint(); decorate(); review();
    return more;
  }
  // The suggestions, read beside the facts (load starts this first) and drawn when they come.
  async function loadSuggestions() {
    const seq = ++sg.seq;
    try {
      const j = await ask('/api/facts/suggestions');
      if (!Array.isArray(j.items)) throw new Error("Couldn't read your suggested facts.");
      if (seq !== sg.seq) return;
      sg.items = j.items.filter(i => i && typeof i.id === 'string' && typeof i.text === 'string'); sg.state = 'ready'; sg.error = '';
    } catch (e) {
      if (seq !== sg.seq) return;
      sg.state = e.signIn ? 'signin' : 'error'; sg.items = []; sg.error = end(e.status >= 400 ? one(e.message) : "Couldn't read your suggested facts: Local AI didn't answer");
    }
    if (!sg.items.some(i => i.id === sg.editing)) sg.editing = '';
    if (s.state === 'ready' && !sg.busy) paint();
    review();
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

  // One suggestion. Full: Save and Edit stay, disabled, with the reason beside them; No still works.
  function suggestRow(it, i, full) {
    const tid = `ownerSuggest${i}`, why = full ? `<p class="owner-facts__rule" id="${tid}Why">Your list is full (${MAX_FACTS} of ${MAX_FACTS}). Delete a fact to save this one.</p>` : '';
    const off = full ? ' disabled' : '', err = sg.fail[it.id] ? `<p class="ui-notice ui-notice--bad owner-facts__error" role="alert">${esc(sg.fail[it.id])}</p>` : '';
    if (sg.editing === it.id) {
      return `<li class="ui-row owner-fact owner-fact--edit" data-suggest-id="${esc(it.id)}"><form class="owner-facts__form" data-suggest-form novalidate>
        <label class="visually-hidden" for="ownerSuggestEdit">Edit this suggested fact</label>
        <input id="ownerSuggestEdit" class="ui-field" maxlength="${MAX_LENGTH}" autocomplete="off" value="${esc(it.text)}" aria-describedby="${full ? tid + 'Why' : 'ownerSuggestNote'}">
        <button type="submit" class="ui-btn ui-btn--primary"${off}>Save fact</button><button type="button" class="ui-btn ui-btn--ghost" data-suggest-cancel>Cancel</button>${why}${err}</form></li>`;
    }
    const by = `${tid}${full ? ` ${tid}Why` : ''}`;
    return `<li class="ui-row ui-row--lamp owner-fact" data-suggest-id="${esc(it.id)}"><span class="owner-fact__text" id="${tid}">${esc(it.text)}</span>
      <span class="owner-fact__actions"><button type="button" class="ui-btn" data-suggest-save aria-describedby="${by}"${off}>Save</button><button type="button" class="ui-btn ui-btn--ghost" data-suggest-edit aria-describedby="${by}"${off}>Edit</button><button type="button" class="ui-btn ui-btn--ghost" data-suggest-no aria-describedby="${tid}">No</button></span>${why}${err}</li>`;
  }
  // Suggested by Local AI, first in the unfolded group: what needs a decision comes before the saved list. Loading and
  // none: nothing. A failed read is a warning drawn with the page (no alert), with Try again.
  function suggestions(full) {
    if (sg.state === 'signin') return `<div class="owner-facts__suggest"><p class="owner-facts__rule" id="ownerSuggestState" data-signin-words="see">${window.LocalAISignIn?.words('see') || ''}</p>${window.LocalAISignIn?.pair || ''}</div>`;
    if (sg.state === 'error') return `<div class="owner-facts__suggest"><p class="ui-notice ui-notice--warn" id="ownerSuggestState">${esc(sg.error)}</p><button type="button" class="ui-btn" id="ownerSuggestRetry">Try again</button></div>`;
    if (!sg.items.length) return '';
    return `<div class="owner-facts__suggest"><h3 id="ownerSuggestTitle">Suggested by Local AI</h3><p class="owner-facts__rule" id="ownerSuggestNote">From chats answered on this PC. Nothing is saved until you choose Save.</p>
      <ul class="ui-rows" id="ownerSuggestList" aria-labelledby="ownerSuggestTitle">${sg.items.map((it, i) => suggestRow(it, i, full)).join('')}</ul>
      <p class="visually-hidden" role="status" id="ownerSuggestLive"></p></div>`;
  }
  // The count line names what waits: "· 2 suggestions", or, while folded, that they couldn't be read (open, the warning
  // in the group says it, so it isn't said twice). expand() keeps it in step without a redraw.
  const plural = k => `${k} suggestion${k === 1 ? '' : 's'}`;
  const suggestText = () => (sg.state === 'error' ? (s.expanded ? '' : " · suggestions couldn't be read") : sg.items.length ? ` · ${plural(sg.items.length)}` : '');
  const suggestCount = () => `<span id="ownerSuggestCount">${suggestText()}</span>`;

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
    // The same for a suggestion being edited, and a focused suggestion button keeps focus through the redraw.
    const se = $('ownerSuggestEdit'), sdraft = se && se.closest('[data-suggest-id]')?.dataset.suggestId === sg.editing ? { v: se.value, f: document.activeElement === se } : null;
    const a = document.activeElement, sid = a && a.closest && a.closest('#ownerSuggestList [data-suggest-id]')?.dataset.suggestId;
    const ctl = sid && ['data-suggest-save', 'data-suggest-edit', 'data-suggest-no'].find(k => a.hasAttribute(k));
    const sugs = suggestions(full);
    // Folded: one line (how many, that a full list is full, where they are used) and one button. Unfolded: the list,
    // Show all and Add, with the rule, or why Add is off, under it. With no facts the open group needs no Hide button.
    body.innerHTML = `<div class="owner-facts__head">${n
        ? `<p class="owner-facts__count"><span id="ownerFactsCount">${n} of ${MAX_FACTS}</span> facts${full ? ', the most you can keep' : ''} · used only in answers from this PC${suggestCount()}</p>`
        : `<p class="owner-facts__count" id="ownerFactsEmpty">No facts yet, like your printer or the units you prefer. ${USED}${suggestCount()}</p>`}
        <button type="button" class="ui-btn owner-facts__toggle" id="ownerFactsToggle" aria-controls="ownerFactsPanel" aria-expanded="${s.expanded}"${!n && s.expanded ? ' hidden' : ''}>${toggleWords(n)}</button></div>
      <div class="owner-facts__panel" id="ownerFactsPanel"${s.expanded ? '' : ' hidden'}>
      ${sugs}${sg.items.length || sg.state === 'error' ? `<h3 id="ownerFactsSavedTitle">Saved facts</h3>${n ? '' : '<p class="owner-facts__rule">None yet: save a suggestion or add one below.</p>'}` : ''}
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
    if (sdraft && $('ownerSuggestEdit')) { const t = $('ownerSuggestEdit'); t.value = sdraft.v; if (sdraft.f) t.focus(); }
    if (ctl && !body.contains(a)) { const b = [...body.querySelectorAll('#ownerSuggestList [data-suggest-id]')].find(x => x.dataset.suggestId === sid)?.querySelector(`[${ctl}]`); if (b && !b.disabled) b.focus({ preventScroll: true }); }
  }

  // Folded, the toggle names what waits too: "Show facts and 2 suggestions", "Show 1 suggestion".
  const toggleWords = n => { const k = sg.items.length; return s.expanded ? 'Hide facts' : n ? (k ? `Show facts and ${plural(k)}` : 'Show facts') : k ? `Show ${plural(k)}` : 'Add a fact'; };
  // Unfold or fold the group in place: no redraw, so a half-typed fact or edit stays as it was.
  function expand(on) {
    s.expanded = on;
    try { sessionStorage.setItem(EXPANDED_KEY, on ? '1' : '0'); } catch { /* storage off: this page view only */ }
    const panel = $('ownerFactsPanel'), t = $('ownerFactsToggle');
    if (panel) panel.hidden = !on;
    if (t) { t.setAttribute('aria-expanded', String(on)); t.textContent = toggleWords(s.facts.length); t.hidden = on && !s.facts.length; }
    const c = $('ownerSuggestCount'); if (c) c.textContent = suggestText();
  }
  // Where opening the group puts focus: the first waiting suggestion's Save (or its heading when Save is off), else Add.
  function focusOpened() {
    const save = document.querySelector('#ownerSuggestList [data-suggest-save]:not([disabled])'), title = $('ownerSuggestTitle');
    if (save) return save.focus();
    if (title) { title.tabIndex = -1; return title.focus(); }
    $('ownerFactText')?.focus();
  }
  // "Review on Memory" under a chat answer links to #memory?review=suggestions: once the suggestions are read, the group
  // opens and focus goes to them, so the suggestion isn't hidden in a folded group.
  const reviewWanted = () => /^#memory\?(?:[^#]*&)?review=suggestions(?:&|$)/.test(location.hash);
  function review() {
    if (!s.review || s.state !== 'ready' || sg.state === 'loading') return;
    s.review = false;
    if (!s.expanded) expand(true);
    if (sg.items.length) focusOpened(); else ($('ownerSuggestState') || $('ownerFactsToggle'))?.scrollIntoView?.({ block: 'nearest' });
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

  // Focus a suggestion's control after a redraw; with none left, Add (or the line saying the list is full).
  const focusSuggest = (id, opts = {}) => {
    if (!s.expanded) expand(true);
    const add = $('ownerFactText');
    ui().refocus?.(id, { within: '#ownerSuggestList', key: 'suggestId', fallback: add && !add.disabled ? add : $('ownerFactsRule'), ...opts });
  };

  // Save (as suggested, or the owner's edit) or No. While it is sent, the pressed button keeps focus and says what it is
  // doing (and the live line says it too); the row's other controls wait. A failure keeps the row and what was typed,
  // and says the server's reason once, with the way out.
  async function decide(li, btn, action) {
    const id = li && li.dataset.suggestId, it = sg.items.find(x => x.id === id); if (!it || sg.busy) return;
    const input = li.querySelector('#ownerSuggestEdit'), text = input ? one(input.value) : undefined;
    delete sg.fail[id]; li.querySelector('.owner-facts__error')?.remove();
    const fail = m => { sg.fail[id] = m; const p = document.createElement('p'); p.className = 'ui-notice ui-notice--bad owner-facts__error'; p.setAttribute('role', 'alert'); p.textContent = m; (li.querySelector('form') || li).append(p); };
    if (input && !text) { input.setAttribute('aria-invalid', 'true'); fail('Write the fact first, or choose Cancel.'); input.focus(); return; }
    const live = $('ownerSuggestLive'), words = action === 'no' ? 'Declining…' : 'Saving…';
    const others = [...li.querySelectorAll('button')].filter(b => b !== btn), was = others.map(b => b.disabled);
    sg.busy = id; others.forEach(b => { b.disabled = true; });
    if (input) { input.readOnly = true; input.removeAttribute('aria-invalid'); }
    const label = btn.textContent; btn.textContent = words; btn.setAttribute('aria-disabled', 'true'); btn.setAttribute('aria-busy', 'true');
    if (live) live.textContent = words;
    const settle = () => { sg.busy = ''; btn.textContent = label; btn.removeAttribute('aria-disabled'); btn.removeAttribute('aria-busy'); others.forEach((b, i) => { b.disabled = was[i]; }); if (input) input.readOnly = false; if (live) live.textContent = ''; };
    try {
      const j = await ask('/api/facts/suggestions/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, action, ...(input ? { text } : {}) }) });
      sg.busy = '';
      const at = sg.items.indexOf(it), next = sg.items[at + 1]?.id || '', prev = sg.items[at - 1]?.id || '';
      sg.items = sg.items.filter(x => x !== it); if (sg.editing === id) sg.editing = '';
      const fact = j.state === 'saved' && j.fact && typeof j.fact.id === 'string' ? { ...j.fact, projectId: '', category: CATEGORY } : null;
      if (fact) { s.facts.push(fact); if (s.facts.length > SHOWN) s.open = true; }
      paint(); decorate(); changed();
      if (fact) { said('Saved the fact'); focusRow(fact.id, { control: '[data-fact-edit]' }); }
      else { said("Local AI won't suggest that again"); focusSuggest('', { next, prev, control: '[data-suggest-no]' }); }
    } catch (e) {
      settle();
      const again = ` Choose ${action === 'no' ? 'No' : input ? 'Save fact' : 'Save'} to try again.`;
      fail(e.signIn ? window.LocalAISignIn?.words('act') || one(e.message) : e.status >= 500 || !e.status ? end(one(e.message)) + again : end(one(e.message)));
      (input || btn).focus();
    }
  }

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
      else if (form.matches('[data-suggest-form]')) { const b = form.querySelector('button[type="submit"]'); if (!b.disabled) decide(form.closest('[data-suggest-id]'), b, 'save'); }
    });
    sec.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b || b.disabled) return;
      const li = b.closest('[data-fact-id]');
      const si = b.closest('[data-suggest-id]');
      if (b.id === 'ownerFactsRetry') load();
      else if (b.id === 'ownerSuggestRetry') { b.textContent = 'Reading…'; loadSuggestions().then(() => { const r = $('ownerSuggestRetry'); if (r) r.focus(); else focusSuggest(sg.items[0]?.id || '', { control: '[data-suggest-save]', fallback: $('ownerFactsToggle') }); }); }
      else if (b.matches('[data-suggest-save]')) decide(si, b, 'save');
      else if (b.matches('[data-suggest-no]')) decide(si, b, 'no');
      else if (b.matches('[data-suggest-edit]')) { sg.editing = si.dataset.suggestId; delete sg.fail[sg.editing]; paint(); const t = $('ownerSuggestEdit'); t.focus(); t.setSelectionRange(t.value.length, t.value.length); }
      else if (b.matches('[data-suggest-cancel]')) { const id = sg.editing; sg.editing = ''; delete sg.fail[id]; paint(); focusSuggest(id, { control: '[data-suggest-edit]' }); }
      // Opened with no saved facts the toggle hides, so focus moves on: to a waiting suggestion first, else Add.
      else if (b.id === 'ownerFactsToggle') { const n = s.facts.length, on = !s.expanded; expand(on); if (on && (!n || sg.items.length)) focusOpened(); }
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
      if (e.key === 'Escape' && e.target.id === 'ownerSuggestEdit' && !sg.busy) { e.preventDefault(); sec.querySelector('[data-suggest-cancel]').click(); }
    });
    const list = $('memoryList');
    if (list) {
      list.addEventListener('click', e => { const b = e.target.closest('[data-mem-fact]'); if (b && !b.disabled) promote(b); });
      new MutationObserver(decorate).observe(list, { childList: true });
    }
    // Opening Memory again reads the list again (a fact may have changed on another device).
    const page = $('memory');
    if (page) { let on = page.classList.contains('active'); new MutationObserver(() => { const now = page.classList.contains('active'); if (now && !on && !s.editing && !sg.editing && !sg.busy) load(); on = now; }).observe(page, { attributes: true, attributeFilter: ['class'] }); }
  }

  s.review = reviewWanted();
  addEventListener('hashchange', () => { if (reviewWanted()) { s.review = true; setTimeout(review, 0); } });   // after the router shows Memory
  wire(); load();
  window.LocalAIOwnerFacts = { reload: load };
})();
