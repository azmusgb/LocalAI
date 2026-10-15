// Run bodies: what fills the body slot of a run view (#run/<id>) for each kind of run.
// This file holds the helpers every body shares (window.LocalAIRunBodies) and the chat / research body.
// Later bodies (images, missions) register the same way: LocalAIUI.registerRunBody(kind, mount).
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
    document.addEventListener('pointerdown', e => { if (e.target !== c.input) c.hadFocus = false; }, true);
    threads.set(threadId, c);
    return c;
  }
  const grow = c => { c.input.style.height = 'auto'; c.input.style.height = Math.min(c.input.scrollHeight, 140) + 'px'; };

  // Every run of the thread, oldest first, as turns: {key, prompt, answer, kind}. kind: '' | 'wait' | 'error' | 'live'.
  function turnsOf(c) {
    const runs = c.runs.some(r => r.id === c.run?.id) || !c.run ? c.runs : [...c.runs, c.run];
    const out = [], live = c.live;
    for (const r of sortRuns(runs)) {
      const prompt = r.input?.prompt || r.title || '';
      let answer = '', kind = '';
      const o = r.output, lv = live && live.runId === r.id ? live : null;
      if (o && o.truncated) answer = c.lib.get(r.artifactIds?.[0]) || o.preview || r.summary || '';
      else answer = typeof o === 'string' ? o : o?.text || '';
      if (!answer && lv) answer = lv.text;
      if (r.status === 'failed' && !answer) { answer = r.error || 'This answer could not be written.'; kind = 'error'; }
      else if (r.status === 'cancelled' && !answer) { answer = 'Stopped.'; kind = 'error'; }
      else if (!answer) { answer = 'Thinking…'; kind = 'wait'; }
      else if (lv?.streaming) kind = 'live';
      out.push({ key: r.id, prompt, answer, kind, sources: Array.isArray(o?.sources) ? o.sources : [] });
    }
    if (live && !(live.runId && runs.some(r => r.id === live.runId))) out.push({ key: 'live', prompt: live.prompt, answer: live.text || (live.err ? '' : 'Thinking…'), kind: live.err ? 'error' : live.text ? 'live' : 'wait', sources: [] });
    return out;
  }
  // The conversation so far as chat messages (answers that exist only), for a reply.
  const history = c => turnsOf(c).flatMap(t => [{ role: 'user', content: t.prompt }, ...(t.kind === '' || t.kind === 'live' ? [{ role: 'assistant', content: t.answer }] : [])]).filter(m => m.content);

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
        if (!n) { n = h('div'); n.dataset.key = key; c.nodes.set(key, n); }
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
      const need = c.runs.filter(r => r.output?.truncated && r.artifactIds?.[0] && !c.lib.has(r.artifactIds[0]) && !c.libTried.has(r.artifactIds[0]));
      if (need.length) {
        need.forEach(r => c.libTried.add(r.artifactIds[0]));
        try { const lib = await RB.json('/api/library'); for (const it of lib.items || []) if (it?.id && typeof it.response === 'string') c.lib.set(it.id, it.response); } catch {}
      }
      // A finished stream hands over to the ledger once the ledger has the run.
      if (c.live && !c.live.streaming && c.live.runId && c.runs.some(r => r.id === c.live.runId && r.output)) c.live = null;
    } catch {} finally { c.loading = false; schedule(c); }
  }

  function showError(c, message) { c.err.textContent = message || ''; c.err.hidden = !message; }
  function stop(c) { c.live?.controller.abort(); }
  async function sendReply(c) {
    if (c.live?.streaming) return;
    const text = c.input.value.trim(); if (!text) return;
    const messages = [...history(c), { role: 'user', content: text }].slice(-16);
    const live = c.live = { prompt: text, text: '', runId: '', streaming: true, err: '', controller: new AbortController() };
    c.input.value = ''; grow(c); showError(c, ''); paint(c);
    const sc = scroller(c); if (sc) sc.scrollTop = sc.scrollHeight;
    try {
      await core().streamChat({
        messages, webSearch: isWeb(c.run), model: c.run?.input?.model || undefined, threadId: c.threadId, signal: live.controller.signal,
        onMeta: d => { live.runId = d.runId || live.runId; },
        onToken: t => { live.text += t; schedule(c); }
      });
    } catch (e) {
      if (e.name !== 'AbortError') { live.err = e.message || 'The reply could not be sent.'; showError(c, live.err); if (!live.text && !live.runId) { c.input.value = text; c.live = null; } }
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
      const sc = scroller(c);
      // The view is rebuilt on each change: put the scroll back where the person had it (the end, for a new view).
      const place = () => { const d = scroller(c); if (!d) return; d.scrollTop = c.scroll.near || !sameRun ? d.scrollHeight : c.scroll.top; };
      const refocus = c.hadFocus;
      requestAnimationFrame(() => { place(); c.settled = true; if (refocus && c.root.isConnected) c.input.focus({ preventScroll: true }); });
      if (sc && !sc.dataset.chatScroll) { sc.dataset.chatScroll = '1'; sc.addEventListener('scroll', () => { const cur = [...threads.values()].find(x => x.root.isConnected); if (cur?.settled) cur.scroll = { top: sc.scrollTop, near: sc.scrollHeight - sc.scrollTop - sc.clientHeight < 120 }; }, { passive: true }); }
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
      } catch (e) {
        live.streaming = false;
        if (!resolved) { threads.delete(threadId); pending?.fail(e.message || 'Something went wrong.'); throw e; }
        if (e.name !== 'AbortError') live.err = e.message;
      } finally {
        live.streaming = false;
        if (resolved) { paint(c); loadThread(c); }
      }
    }
  };
})();
