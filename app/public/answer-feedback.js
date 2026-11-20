// Good answer / Not right under a finished answer (docs/superpowers/specs/2026-11-19-answer-feedback-design.md).
// run-bodies.js loads this the first time it draws a finished answer and calls LocalAIFeedback.mark(host, run) on every
// repaint: it adds the control once, on the line of the answer's "Answered on this PC" (it takes that line into its own
// row), and keeps it in step with the run's card. A verdict is saved on POST /api/runs/feedback; pressing the same one
// again clears it. A failed save says so and leaves the earlier verdict showing: it is never shown as saved.
(function () {
  'use strict';
  const saved = new Map();   // runId -> {verdict, note}: saved on this page, newer than a card fetched before the save
  let seq = 0;
  const ICON = {
    good: '<path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/>',
    bad: '<path d="M17 14V2"/><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z"/>'
  };
  const WORDS = { good: 'Good answer', bad: 'Not right' };
  const SAID = { good: 'Marked as a good answer.', bad: 'Marked as not right.', '': 'Rating cleared.' };
  const NOTE_MAX = 300;
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; };
  const say = m => window.LocalAIUI?.announce?.(m);

  const rateable = run => !!run && typeof run.id === 'string' && !run.id.startsWith('legacy-') && run.status === 'completed'
    && (run.type === 'chat' || run.type === 'research' || (run.type === 'prompt' && run.meta?.mode === 'history'));
  // What the page knows: a save made here, else the card's verdict. undefined = the server couldn't read it.
  function known(run) {
    if (saved.has(run.id)) return saved.get(run.id);
    const f = run.card?.feedback;
    if (f && f.unread) return undefined;
    return f && f.verdict ? { verdict: f.verdict, note: f.note || '' } : { verdict: '', note: '' };
  }

  async function post(id, verdict, note) {
    const r = await fetch('/api/runs/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ id, verdict: verdict || null, ...(verdict === 'bad' ? { note } : {}) }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || `HTTP ${r.status}`), { signIn: r.status === 401 && j.signIn === true });
    return j.feedback || null;
  }

  function build(run) {
    const id = 'answerNote' + (++seq);
    const row = el('div', 'answer-feedback'); row.dataset.runId = run.id;
    const pick = el('div', 'ui-chips answer-feedback__pick'); pick.setAttribute('role', 'group'); pick.setAttribute('aria-label', 'Rate this answer');
    const buttons = {};
    for (const v of ['good', 'bad']) {
      const b = el('button'); b.type = 'button'; b.dataset.verdict = v; b.setAttribute('aria-pressed', 'false');
      b.innerHTML = `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${ICON[v]}</svg>`;
      b.append(el('span', '', WORDS[v]));
      buttons[v] = b; pick.appendChild(b);
    }
    // Saving… is said in a live region as well as shown; saved and failed are said by the toast and the alert.
    const state = el('span', 'answer-feedback__state'); state.setAttribute('role', 'status');
    const form = el('form', 'answer-feedback__note'); form.noValidate = true; form.hidden = true;
    const label = el('label', '', 'What was wrong? (optional)'); label.htmlFor = id;
    const input = el('input', 'ui-field'); input.id = id; input.maxLength = NOTE_MAX; input.autocomplete = 'off';
    const save = el('button', 'ui-btn ui-btn--ghost', 'Save note'); save.type = 'submit';
    form.append(label, input, save);
    const fail = el('p', 'ui-notice ui-notice--bad answer-feedback__fail'); fail.setAttribute('role', 'alert'); fail.hidden = true;
    const unread = el('p', 'answer-feedback__state', "Couldn't read whether you rated this answer."); unread.hidden = true;
    row.append(pick, state, form, fail, unread);
    const st = row._feedback = { runId: run.id, verdict: '', note: '', busy: false, buttons, form, input, save, state, fail, unread };

    // Refused for sign-in: the shared words and Pair action (signin-report.js), not "Try again".
    const S = window.LocalAISignIn;
    const showFail = e => { fail.textContent = e?.signIn && S ? S.words('act') : "Couldn't save that. Try again."; if (e?.signIn && S) fail.insertAdjacentHTML('beforeend', ` ${S.pair}`); fail.hidden = false; };
    // Saving: the pressed state stays what it was until the server has it; the control says it is saving.
    const busy = (on, b) => { st.busy = on; for (const x of [buttons.good, buttons.bad, save]) { x.setAttribute('aria-disabled', String(on)); x.removeAttribute('aria-busy'); } if (on) b.setAttribute('aria-busy', 'true'); state.textContent = on ? 'Saving…' : ''; };
    for (const v of ['good', 'bad']) buttons[v].addEventListener('click', async () => {
      if (st.busy) return;
      const next = st.verdict === v ? '' : v;
      busy(true, buttons[v]); fail.hidden = true;
      try {
        const f = await post(st.runId, next, '');
        st.verdict = f?.verdict || ''; st.note = f?.note || '';
        saved.set(st.runId, { verdict: st.verdict, note: st.note });
        busy(false); paint(st); unread.hidden = true;
        // After Not right, an optional line for what was wrong; anything else closes it.
        form.hidden = st.verdict !== 'bad'; if (!form.hidden) input.value = st.note;
        say(SAID[st.verdict]);
      } catch (e) { busy(false); showFail(e); }
    });
    form.addEventListener('submit', async e => {
      e.preventDefault();
      if (st.busy) return;
      busy(true, save); fail.hidden = true;
      try {
        const f = await post(st.runId, 'bad', input.value.trim().slice(0, NOTE_MAX));
        st.verdict = f?.verdict || ''; st.note = f?.note || '';
        saved.set(st.runId, { verdict: st.verdict, note: st.note });
        busy(false); paint(st);
        form.hidden = true; buttons.bad.focus();
        say(st.note ? 'Saved what was wrong.' : 'Marked as not right, with no note.');
      } catch (err) { busy(false); showFail(err); }   // the typed note stays in the field
    });
    return row;
  }
  function paint(st) { for (const v of ['good', 'bad']) st.buttons[v].setAttribute('aria-pressed', String(st.verdict === v)); }

  // Keep a row in step with the run's card (another device may have rated it), unless it is saving or has a note open.
  function sync(row, run) {
    const st = row._feedback, k = known(run);
    if (st.busy || !st.form.hidden) return;
    st.unread.hidden = k !== undefined;
    const next = k || { verdict: '', note: '' };
    if (next.verdict !== st.verdict || next.note !== st.note) { st.verdict = next.verdict; st.note = next.note; paint(st); }
  }

  function mark(host, run) {
    if (!host) return;   // the body may not be on the page yet: run-bodies.js attaches it after drawing
    let row = host.querySelector(':scope > .answer-feedback');
    if (!rateable(run)) { if (row) { const rt = row.querySelector('.run-route'); if (rt) row.before(rt); row.remove(); } return; }
    if (row && row.dataset.runId !== run.id) { row.remove(); row = null; }
    if (!row) {
      row = build(run);
      const after = host.querySelector(':scope > .run-route'), sources = host.querySelector(':scope > .chat-turn__sources');
      if (after) after.before(row); else if (sources) sources.before(row); else host.appendChild(row);
    }
    // "Answered on this PC" sits on the same line, before the buttons (the chat body redraws it when it changes).
    const rt = host.querySelector(':scope > .run-route');
    if (rt) row.prepend(rt);
    sync(row, run);
    if (run.type === 'chat') suggestLine(host, run);
  }

  // "Local AI suggests remembering: …" under a chat answer: fact-suggestion-line.js, loaded the first time one is marked.
  let lq;
  function suggestLine(host, run) {
    const L = window.LocalAIFactLine; if (L) return L.mark(host, run);
    if (!lq) { lq = []; const s = document.createElement('script'); s.src = '/fact-suggestion-line.js'; s.onload = () => lq.splice(0).forEach(a => window.LocalAIFactLine.mark(...a)); s.onerror = () => { lq = null; }; document.head.append(s); }
    lq.push([host, run]);
  }

  window.LocalAIFeedback = { mark };
})();
