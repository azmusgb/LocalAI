// Run bodies: what fills the body slot of a run view (#run/<id>) for each kind of run.
// This file holds the helpers every body shares (window.LocalAIRunBodies) and the chat / research body.
// The image and change bodies live here too; later bodies (missions) register the same way: LocalAIUI.registerRunBody(kind, mount).
(function () {
  const RB = window.LocalAIRunBodies = window.LocalAIRunBodies || {};
  // h('div', 'cls', 'text') — a tiny element builder; text is always set as text, never as HTML.
  RB.h = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined && text !== null) n.textContent = text; return n; };
  // The run view rebuilds its body on every change to the run. mount() runs the previous body's cleanups first, then build(ctx);
  // ctx.onCleanup(fn) registers a timer / listener to undo when this body is replaced.
  let current = null;
  RB.mount = (slot, build) => {
    if (current) current.cleanups.splice(0).forEach(fn => { try { fn(); } catch {} });
    const ctx = current = { slot, cleanups: [], onCleanup: fn => ctx.cleanups.push(fn), alive: () => current === ctx && slot.isConnected };
    build(ctx);
    return ctx;
  };
  // Close the current body now (the run view is closing or being rebuilt): every cleanup runs, so borrowed nodes go home.
  RB.release = () => { if (current) { current.cleanups.splice(0).forEach(fn => { try { fn(); } catch {} }); current = null; } };
  // Move a page element (one the old page code reaches by id) into this body, and back to where it was when the body goes.
  RB.borrow = (ctx, node, into) => {
    if (!node) return;
    const mark = document.createComment('borrowed:' + (node.id || 'node')); node.replaceWith(mark); into.appendChild(node);
    ctx.onCleanup(() => { if (mark.isConnected) mark.replaceWith(node); else node.remove(); });
  };
  RB.json = async (url) => { const r = await fetch(url, { cache: 'no-store', headers: { Accept: 'application/json' } }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); return j; };
  // Phones: the on-screen keyboard shrinks the visual viewport but not always the layout one. Publish its height and top
  // so a docked body (the chat reply box) can follow it; CSS reads --run-vvh / --run-vvt and falls back to 100dvh.
  let vvBound = false;
  RB.followViewport = () => {
    const vv = window.visualViewport; if (!vv || vvBound) return; vvBound = true;
    const set = () => { const s = document.documentElement.style; s.setProperty('--run-vvh', Math.round(vv.height) + 'px'); s.setProperty('--run-vvt', Math.round(vv.offsetTop) + 'px'); };
    vv.addEventListener('resize', set); vv.addEventListener('scroll', set); set();
  };

  // ---- chat / research ----
  const h = RB.h;
  const threads = new Map();   // threadId -> controller: the live DOM, the loaded runs, and the stream in flight
  const core = () => window.LocalAIChatCore;
  const sortRuns = list => list.slice().sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || String(a.id).localeCompare(String(b.id)));
  const isWeb = run => run?.type === 'research' || run?.input?.webSearch === true;

  function controllerFor(threadId) {
    let c = threads.get(threadId);
    if (c) return c;
    c = { threadId, runs: [], lib: new Map(), libTried: new Set(), live: null, run: null, loading: false, hadFocus: false, scroll: { top: 0, near: true }, nodes: new Map(), frame: 0 };
    c.root = h('div', 'chat-body');
    c.turns = h('div', 'chat-body__turns'); c.turns.setAttribute('role', 'group'); c.turns.setAttribute('aria-label', 'Conversation');
    c.form = h('form', 'chat-body__reply'); c.form.noValidate = true;
    c.input = h('textarea'); c.input.id = 'runReply'; c.input.rows = 1; c.input.placeholder = 'Reply…'; c.input.setAttribute('aria-label', 'Reply'); c.input.enterKeyHint = 'send';
    c.send = h('button', 'btn-primary chat-body__send', 'Send'); c.send.id = 'runReplySend'; c.send.type = 'submit';
    c.err = h('div', 'chat-body__error'); c.err.setAttribute('role', 'alert'); c.err.hidden = true;
    c.form.append(c.input, c.send);
    c.root.append(c.turns, c.err, c.form);
    c.input.addEventListener('input', () => { grow(c); });
    c.input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!c.live?.streaming) sendReply(c); } });
    c.form.addEventListener('submit', e => { e.preventDefault(); if (c.live?.streaming) stop(c); else sendReply(c); });
    // The view is rebuilt under the person's fingers, and a removed element reports a blur: so focus is "kept" until they
    // clearly move it (a tap elsewhere, or Tab), and put back on the new box.
    c.input.addEventListener('focus', () => { c.hadFocus = true; });
    c.input.addEventListener('keydown', e => { if (e.key === 'Tab') c.hadFocus = false; });
    threads.set(threadId, c);
    return c;
  }
  document.addEventListener('pointerdown', e => { for (const c of threads.values()) if (e.target !== c.input) c.hadFocus = false; }, true);   // once, for every thread
  const grow = c => { c.input.style.height = 'auto'; c.input.style.height = Math.min(c.input.scrollHeight, 140) + 'px'; };

  // The ledger keeps a too-long output as {truncated, preview}, where preview is the output as JSON text cut short: its text if it still parses, else nothing (never the raw JSON).
  const previewText = p => { try { const v = JSON.parse(p); const t = typeof v === 'string' ? v : v?.text; return typeof t === 'string' ? t : ''; } catch { return ''; } };
  // Every run of the thread, oldest first, as turns: {key, prompt, answer, kind}. kind: '' | 'wait' | 'error' | 'live'.
  function turnsOf(c) {
    const runs = c.runs.some(r => r.id === c.run?.id) || !c.run ? c.runs : [...c.runs, c.run];
    const out = [], live = c.live;
    for (const r of sortRuns(runs)) {
      const prompt = r.input?.prompt || r.title || '';
      let answer = '', kind = '', lost = false;
      const o = r.output, lv = live && live.runId === r.id ? live : null;
      if (o && o.truncated) { answer = c.lib.get(r.id) || previewText(o.preview); if (!answer) { answer = 'This answer was too long to keep here.'; lost = true; } }
      else answer = typeof o === 'string' ? o : o?.text || '';
      if (!answer && lv) answer = lv.text;
      if (r.status === 'failed' && !answer) { answer = r.error || 'This answer could not be written.'; kind = 'error'; }
      else if (r.status === 'cancelled' && !answer) { answer = 'Stopped.'; kind = 'error'; }
      else if (!answer) { answer = 'Thinking…'; kind = 'wait'; }
      else if (lv?.streaming) kind = 'live';
      out.push({ key: r.id, prompt, answer, kind, lost, sources: Array.isArray(o?.sources) ? o.sources : [] });
    }
    if (live && !(live.runId && runs.some(r => r.id === live.runId))) out.push({ key: 'live', prompt: live.prompt, answer: live.text || (live.err ? '' : 'Thinking…'), kind: live.err ? 'error' : live.text ? 'live' : 'wait', sources: [] });
    return out;
  }
  // The conversation so far as chat messages (answers that exist only), for a reply. A lost answer (the placeholder) is not the model's words: leave it out.
  const history = c => turnsOf(c).flatMap(t => [{ role: 'user', content: t.prompt }, ...((t.kind === '' || t.kind === 'live') && !t.lost ? [{ role: 'assistant', content: t.answer }] : [])]).filter(m => m.content);

  const sourceLinks = sources => {
    const ul = h('ul', 'chat-turn__sources');
    for (const s of sources.slice(0, 8)) {
      const url = String(s?.url || s?.link || ''); if (!/^https?:\/\//i.test(url)) continue;
      const li = h('li'), a = h('a', '', String(s.title || url).slice(0, 120)); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; li.appendChild(a); ul.appendChild(li);
    }
    return ul.children.length ? ul : null;
  };
  function paint(c) {
    const list = turnsOf(c), keep = new Set(), rows = [];
    for (const t of list) {
      for (const [suffix, who] of [['u', 'user'], ['a', 'assistant']]) {
        const key = `${t.key}:${suffix}`; keep.add(key);
        let n = c.nodes.get(key);
        // Each turn is an article named for who spoke, so a screen reader says "You" or "Local AI" before the words.
        if (!n) { n = h('div'); n.dataset.key = key; n.setAttribute('role', 'article'); n.setAttribute('aria-label', who === 'user' ? 'You' : 'Local AI'); c.nodes.set(key, n); }
        const text = who === 'user' ? t.prompt : t.answer, cls = `chat-turn chat-turn--${who}${who === 'assistant' && t.kind ? ' chat-turn--' + t.kind : ''}`;
        if (n.className !== cls) n.className = cls;
        if (n.dataset.text !== text) { n.dataset.text = text; n.textContent = text; }
        if (who === 'assistant') { n.dataset.srcs = ''; const ul = t.sources.length ? sourceLinks(t.sources) : null; const sig = ul ? ul.textContent : ''; if (n.dataset.srcSig !== sig) { n.dataset.srcSig = sig; n.querySelector('.chat-turn__sources')?.remove(); if (ul) n.appendChild(ul); } }
        rows.push(n);
      }
    }
    for (const k of [...c.nodes.keys()]) if (!keep.has(k)) { c.nodes.get(k).remove(); c.nodes.delete(k); }
    rows.forEach((n, i) => { if (c.turns.children[i] !== n) c.turns.insertBefore(n, c.turns.children[i] || null); });
    const streaming = !!c.live?.streaming;
    if (c.send.textContent !== (streaming ? 'Stop' : 'Send')) c.send.textContent = streaming ? 'Stop' : 'Send';
    c.send.type = 'submit';
  }
  // Repaint at most once a frame; keep following the end of the thread only if the person is already there.
  function schedule(c) {
    if (c.frame) return;
    c.frame = requestAnimationFrame(() => {
      c.frame = 0;
      const sc = scroller(c), near = !sc || sc.scrollHeight - sc.scrollTop - sc.clientHeight < 120;
      paint(c);
      if (sc && near) sc.scrollTop = sc.scrollHeight;
    });
  }
  const scroller = c => c.root.closest('.run-drawer');

  async function loadThread(c) {
    if (c.loading) return; c.loading = true;
    try {
      const j = await RB.json(`/api/runs?threadId=${encodeURIComponent(c.threadId)}&limit=500`);
      c.runs = (Array.isArray(j.items) ? j.items : []).filter(r => r && r.id);
      const need = c.runs.filter(r => r.output?.truncated && !c.lib.has(r.id) && !c.libTried.has(r.id));
      if (need.length) {
        need.forEach(r => c.libTried.add(r.id));
        // An answer too long for the run is kept whole on the server (with the run, and in Library once kept), by run id.
        try { const j = await RB.json('/api/runs/answers?ids=' + need.slice(0, 100).map(r => encodeURIComponent(r.id)).join(',')); for (const [runId, t] of Object.entries(j.answers || {})) if (typeof t === 'string') c.lib.set(runId, t); } catch {}
      }
      // A finished stream hands over to the ledger once the ledger has the run.
      if (c.live && !c.live.streaming && c.live.runId && c.runs.some(r => r.id === c.live.runId && r.output)) c.live = null;
    } catch {} finally { c.loading = false; schedule(c); }
  }

  function showError(c, message, retryText) {
    c.err.replaceChildren(document.createTextNode(message || ''));
    if (message && retryText) { const b = h('button', 'btn-outline chat-body__retry', 'Retry'); b.type = 'button'; b.addEventListener('click', () => sendReply(c, retryText)); c.err.appendChild(b); }
    c.err.hidden = !message;
  }
  function stop(c) { c.live?.controller.abort(); }
  async function sendReply(c, again) {
    if (c.live?.streaming) return;
    const text = (again || c.input.value).trim(); if (!text) return;
    const messages = [...history(c), { role: 'user', content: text }].slice(-16);
    const live = c.live = { prompt: text, text: '', runId: '', streaming: true, err: '', controller: new AbortController() };
    if (!again) { c.input.value = ''; grow(c); } showError(c, ''); paint(c);
    const sc = scroller(c); if (sc) sc.scrollTop = sc.scrollHeight;
    try {
      await core().streamChat({
        messages, webSearch: isWeb(c.run), model: c.run?.input?.model || undefined, threadId: c.threadId, signal: live.controller.signal,
        onMeta: d => { live.runId = d.runId || live.runId; },
        onToken: t => { live.text += t; schedule(c); }
      });
    } catch (e) {
      if (e.name !== 'AbortError') {
        live.err = e.message || 'The reply could not be sent.';
        const unsent = !live.text && !live.runId;
        // A reply that never started goes back to the box, unless the person has typed something new meanwhile: then Retry offers it.
        if (unsent && !c.input.value.trim()) { c.input.value = text; grow(c); showError(c, `The reply could not be sent: ${live.err}`); }
        else showError(c, `The reply could not be sent: ${live.err}`, unsent ? text : '');
        if (unsent) c.live = null;
      }
    } finally {
      live.streaming = false; paint(c);
      if (c.live === live && !live.text && !live.runId) c.live = null;
      await loadThread(c);
      document.getElementById('runLiveRegion')?.replaceChildren(document.createTextNode(live.err ? 'The reply failed.' : 'Reply ready.'));
    }
  }

  function mountChat(run, slot) {
    const threadId = run.threadId || run.id;
    RB.followViewport();
    RB.mount(slot, ctx => {
      const c = controllerFor(threadId);
      const sameRun = c.run && c.run.id === run.id;
      c.run = run; c.runs = c.runs.map(r => r.id === run.id ? run : r);
      slot.classList.add('chat-body-slot');
      slot.appendChild(c.root);
      paint(c);
      // The view is rebuilt on each change: put the scroll back where the person had it (the end, for a new view).
      const place = () => { const d = scroller(c); if (!d) return; d.scrollTop = c.scroll.near || !sameRun ? d.scrollHeight : c.scroll.top; };
      const refocus = c.hadFocus;
      // The slot is attached to the drawer only after mount() returns, so the scroller is found a frame later.
      requestAnimationFrame(() => {
        const d = scroller(c);
        if (d && !d.dataset.chatScroll) { d.dataset.chatScroll = '1'; d.addEventListener('scroll', () => { const cur = [...threads.values()].find(x => x.root.isConnected); if (cur?.settled) cur.scroll = { top: d.scrollTop, near: d.scrollHeight - d.scrollTop - d.clientHeight < 120 }; }, { passive: true }); }
        place(); c.settled = true; if (refocus && c.root.isConnected) c.input.focus({ preventScroll: true });
      });
      c.settled = false;
      if (!sameRun) c.scroll = { top: 0, near: true };
      ctx.onCleanup(() => { if (c.frame) { cancelAnimationFrame(c.frame); c.frame = 0; } });
      loadThread(c);
    });
  }
  if (window.LocalAIUI?.registerRunBody) for (const kind of ['chat', 'research']) window.LocalAIUI.registerRunBody(kind, mountChat);

  // Home starts a chat here: a new thread, streamed into the run view. pending.resolve(runId) fires on the stream's meta
  // event, as soon as the run exists. A failure before that fails the pending view and throws so Home keeps the text.
  window.LocalAIChat = {
    async start(text, { research = false, pending, model } = {}) {
      const threadId = core().newThreadId(), c = controllerFor(threadId);
      const live = c.live = { prompt: text, text: '', runId: '', streaming: true, err: '', controller: new AbortController() };
      let resolved = false;
      const resolve = id => { if (id && !resolved) { resolved = true; live.runId = id; pending?.resolve(id); } };
      try {
        const r = await core().streamChat({
          messages: [{ role: 'user', content: text }], webSearch: !!research, model: model || undefined, threadId, signal: live.controller.signal,
          onMeta: d => resolve(d.runId), onToken: t => { live.text += t; schedule(c); }
        });
        resolve(r.runId);
        if (!resolved) throw new Error('The answer could not be started.');
      } catch (e) {
        live.streaming = false;
        if (!resolved) { threads.delete(threadId); pending?.fail(e.message || 'Something went wrong.'); throw e; }
        if (e.name !== 'AbortError') live.err = e.message;
      } finally {
        live.streaming = false;
        if (resolved) {
          paint(c); loadThread(c);
          // A screen reader hears nothing when the text stops growing: say the answer is ready (a failed start already said why; Stop says nothing new).
          if (!live.controller.signal.aborted) document.getElementById('runLiveRegion')?.replaceChildren(document.createTextNode(live.err ? 'The answer failed.' : 'Answer ready.'));
        }
      }
    }
  };

  // ---- images ----
  // The old Images page owns the stage, the editor and the requests; this body borrows its parts for the run view and gives them
  // back. window.LocalAIImages (app.js) paints a run's output into the stage and keeps Another version / Edit on the run's thread.
  const $ = id => document.getElementById(id);
  const imageRuns = run => (run.type || run.card?.kind) === 'image' && run.output?.images?.length;
  async function loadVersions(run, strip, ctx, pick) {
    let runs = [run];
    if (run.threadId) { try { const j = await RB.json(`/api/runs?threadId=${encodeURIComponent(run.threadId)}&limit=100`); runs = (j.items || []).filter(r => r && r.id && imageRuns(r)); } catch {} }
    if (!runs.some(r => r.id === run.id)) runs.push(run);
    runs.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || String(a.id).localeCompare(String(b.id)));
    if (!ctx.alive()) return;
    strip.replaceChildren(); strip.hidden = runs.length < 2;
    runs.forEach((r, i) => {
      const b = h('button', 'run-body-image__thumb'); b.type = 'button'; b.dataset.runId = r.id;
      b.setAttribute('aria-label', `Version ${i + 1} of ${runs.length}`); if (r.id === run.id) b.setAttribute('aria-current', 'true');
      const src = r.output?.images?.[0]?.imageUrl; if (src) { const im = h('img'); im.alt = ''; im.loading = 'lazy'; im.src = src; b.appendChild(im); }
      b.addEventListener('click', () => { if (r.id !== run.id) pick(r); });
      strip.appendChild(b);
    });
  }
  function mountImage(run, slot) {
    const I = window.LocalAIImages;
    if (!I || !$('imageShow')) { slot.textContent = 'This image can’t be shown here.'; return; }
    RB.mount(slot, ctx => {
      slot.classList.add('run-body-image');
      const strip = h('div', 'run-body-image__strip'); strip.hidden = true; strip.setAttribute('role', 'group'); strip.setAttribute('aria-label', 'Versions');
      const edit = h('div', 'run-body-image__edit');
      slot.append(h('div', 'run-body-image__main'), edit, strip);
      const main = slot.firstChild;
      for (const id of ['imageShow']) RB.borrow(ctx, $(id), main);
      for (const id of ['imageEditPanel', 'imagePromptLabel', 'imagePrompt', 'generateBtn']) RB.borrow(ctx, $(id), edit);
      const sync = () => { edit.hidden = !I.ui.edit; };
      I.ui.hosted = true; I.ui.onControls = sync; sync();
      ctx.onCleanup(() => { I.ui.hosted = false; if (I.ui.onControls === sync) I.ui.onControls = null; });
      // The nodes are in the page only once the run view attaches this slot, so paint a moment later.
      queueMicrotask(() => { if (ctx.alive()) { I.adopt(run); sync(); } });
      // A thumbnail routes (replace: no new history entry) to that version's run, so URL, title and rebuilds all agree.
      loadVersions(run, strip, ctx, r => window.LocalAIRouter?.go(`#run/${encodeURIComponent(r.id)}`, { replace: true }));
    });
  }
  if (window.LocalAIUI?.registerRunBody) window.LocalAIUI.registerRunBody('image', mountImage);

  // ---- changes (engineering runs) ----
  // The change this run produced, with Stage / Approve / Reject / Apply, drawn by app.js into the body. Until a change exists,
  // the run's own steps, refreshed every few seconds.
  function mountEngineering(run, slot) {
    const C = window.LocalAIChanges;
    if (!C) { slot.textContent = 'This change can’t be shown here.'; return; }
    RB.mount(slot, ctx => {
      slot.classList.add('run-body-change');
      const box = h('div', 'run-body-change__detail'); slot.appendChild(box);
      const showChange = id => { box.replaceChildren(); C.show(id, box); };
      const changeId = run.meta?.changeId || run.output?.changeId;
      if (changeId) { showChange(changeId); return; }
      const id = run.source?.id || String(run.id).replace(/^legacy-engineering:/, '');
      let sig = '', timer = 0;
      const tick = async () => {
        if (!ctx.alive()) return;
        try {
          const r = ((await RB.json('/api/engineering/runs')).items || []).find(x => x.id === id);
          if (!ctx.alive()) return;
          if (r?.finalChangeId) { showChange(r.finalChangeId); return; }
          const next = JSON.stringify(r?.steps || []) + (r?.status || '');
          if (next !== sig) { sig = next; C.steps(r || { steps: [] }, box); }
        } catch {}
        if (ctx.alive()) timer = setTimeout(tick, 3000);
      };
      ctx.onCleanup(() => clearTimeout(timer));
      box.appendChild(h('p', 'run-body-change__wait', 'Working on it…'));
      timer = setTimeout(tick, 0);   // the slot is attached once mount returns
    });
  }
  if (window.LocalAIUI?.registerRunBody) window.LocalAIUI.registerRunBody('engineering', mountEngineering);

  // ---- missions ----
  // The Missions page owns Agent World, the headline, the crew and the story; a mission run borrows them and gives them back.
  // Without a mission id (the first instant, or an older run) the run's output is shown as plain text.
  function mountMission(run, slot) {
    const id = run.meta?.missionId || run.output?.missionId, M = window.LocalAIMissions;
    const world = $('agentWorldCityMount');
    if (!id || !M || !world) {
      const text = run.output ? (typeof run.output === 'string' ? run.output : JSON.stringify(run.output, null, 2)) : '';
      RB.release(); slot.append(h('h3', '', 'Output'));
      if (text) slot.append(h('pre', 'run-output', text)); else slot.append(h('div', 'muted', run.status === 'running' || run.status === 'queued' ? 'The mission is getting started…' : 'No output.'));
      return;
    }
    RB.mount(slot, ctx => {
      slot.classList.add('run-body-mission');
      const top = h('div', 'run-body-mission__world'), strip = h('div', 'run-body-mission__strip'), crew = h('div', 'run-body-mission__crew'), line = h('div', 'run-body-mission__timeline');
      slot.append(top, strip, crew, line);
      RB.borrow(ctx, $('agentWorldCityMount'), top);
      RB.borrow(ctx, $('agentMissionHeadline')?.closest('.agent-mission-strip'), strip);
      RB.borrow(ctx, $('awcRoster')?.closest('.aw-crew'), crew);
      RB.borrow(ctx, $('agentTimeline'), line);
      // The nodes are in the page only once the run view attaches this slot, so select a moment later.
      slot.dataset.missionId = id; slot.dataset.status = run.status;
      queueMicrotask(() => { if (ctx.alive()) M.show(id, { alive: ctx.alive }); });
    });
  }
  // The same mission run, changed: Agent World stays mounted. The mission page's own live stream keeps headline and timeline current;
  // only when the run has just ended is the headline/progress synced once (no replay, so the live map isn't disturbed).
  function updateMission(run, slot) {
    const id = run.meta?.missionId || run.output?.missionId;
    if (!id || slot.dataset.missionId !== id) return false;
    if (slot.dataset.status !== run.status) { slot.dataset.status = run.status; window.LocalAIMissions?.show(id, { replay: false, alive: () => slot.isConnected }); }
    return true;
  }
  if (window.LocalAIUI?.registerRunBody) window.LocalAIUI.registerRunBody('agent', mountMission, { update: updateMission });
})();
