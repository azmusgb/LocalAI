// "Local AI suggests remembering: …" under a chat answer (docs/superpowers/specs/2026-11-19-owner-facts-design.md §2,
// D3). answer-feedback.js loads this the first time it marks a finished chat answer and calls
// LocalAIFactLine.mark(host, run) on every repaint. The line shows only while a suggestion made from that answer is
// waiting, at most one per answer, and links to Memory, where Save, Edit and No live with the list and its cap: one
// quiet link under an answer instead of a second row of buttons beside Good answer / Not right. Nothing is decided here.
// It is the answer's last line (after "Used 2 of your saved facts" and the notes line), and it is only added while that
// answer is the newest in the thread, so a suggestion that arrives late never pushes a later turn down.
// The suggestion job runs after the answer is sent (app/fact-suggestions.js), so a fresh answer checks again a few times
// for about a minute; an older one is read once with the rest (GET /api/facts/suggestions, kept 30 s).
(function () {
  'use strict';
  const FRESH_MS = 90e3, KEEP_MS = 30e3;
  const POLL = [2500, 6000, 12000, 25000, 45000, 70000];   // ms after the answer is drawn; the job's model call has 60 s
  let cache = null, inflight = null;
  const hosts = new Map();      // runId -> the answer's node, as last drawn
  const polling = new Set();    // runIds being checked again

  // -> {at, items} | {at, items: null, signIn}: a failed read is never an empty list.
  function read(again) {
    if (!again && cache && Date.now() - cache.at < KEEP_MS) return Promise.resolve(cache);
    if (inflight) return inflight;
    inflight = fetch('/api/facts/suggestions', { cache: 'no-store', headers: { Accept: 'application/json' } })
      .then(async r => {
        const j = await r.json().catch(() => null);
        return r.ok && j && Array.isArray(j.items) ? { at: Date.now(), items: j.items.filter(i => i && typeof i.text === 'string') } : { at: Date.now(), items: null, signIn: r.status === 401 };
      })
      .catch(() => ({ at: Date.now(), items: null, signIn: false }))
      .then(c => { cache = c; inflight = null; return c; });
    return inflight;
  }

  const finished = run => Date.parse(run.finishedAt || run.updatedAt || run.createdAt || '');
  const fresh = run => { const t = finished(run); return Number.isFinite(t) && Date.now() - t < FRESH_MS; };

  // The line for one answer. failedSays: a failed read is said (only under a fresh answer, where a suggestion may be
  // coming); elsewhere it shows nothing, and Memory says the read failed. A 401 means this device isn't paired: its own
  // chats make no suggestions, so there is nothing to say under them.
  // The newest answer in its thread: nothing (not even a reply being written) comes after it.
  const newest = host => { const all = host.parentElement ? host.parentElement.querySelectorAll(':scope > .chat-turn--assistant') : []; return all.length > 0 && all[all.length - 1] === host; };
  // Keep the line last: the chat body may append its own lines after it on a repaint. Moving it keeps its focus.
  const last = (host, line) => { if (host.lastElementChild === line) return; const f = line.contains(document.activeElement) && document.activeElement; host.append(line); if (f) f.focus({ preventScroll: true }); };
  function draw(host, runId, c, failedSays) {
    let line = host.querySelector(':scope > .fact-line');
    const it = c.items ? c.items.find(i => i.runId === runId) : null;
    const want = it ? 'item' : (!c.items && !c.signIn && failedSays ? 'fail' : '');
    if (!want) { line?.remove(); return; }
    if (!line && !newest(host)) return;
    const sig = it ? `item:${it.id}:${it.text}` : 'fail';
    if (line && line.dataset.sig === sig) { last(host, line); return; }
    const had = !!line && line.contains(document.activeElement);
    const p = document.createElement('p'), a = document.createElement('a');
    p.className = want === 'fail' ? 'fact-line ui-notice ui-notice--warn' : 'fact-line'; p.dataset.sig = sig;
    const words = document.createElement('span');
    words.textContent = it ? `Local AI suggests remembering: “${it.text}”` : "Couldn't check whether this answer suggested a fact to remember.";
    p.append(words, ' ');
    a.href = '#memory?review=suggestions'; a.textContent = it ? 'Review on Memory' : 'Open Memory'; p.append(a);
    if (line) line.remove();
    host.append(p);
    if (had) a.focus({ preventScroll: true });
  }

  function poll(runId, i = 0) {
    polling.add(runId);
    setTimeout(async () => {
      const host = hosts.get(runId);
      if (!host || !host.isConnected) { polling.delete(runId); return; }   // left the chat: a later mark starts again
      const c = await read(true);
      if (host.isConnected) draw(host, runId, c, true);
      const found = c.items && c.items.some(x => x.runId === runId);
      if (!found && i + 1 < POLL.length) poll(runId, i + 1);   // stops when found or after the last; a failed read tries again
    }, POLL[i] - (i ? POLL[i - 1] : 0));
  }

  function mark(host, run) {
    if (!host || !run || run.type !== 'chat' || run.status !== 'completed' || typeof run.id !== 'string') return;
    hosts.set(run.id, host);
    const isFresh = fresh(run);
    read(false).then(c => draw(host, run.id, c, isFresh));
    if (isFresh && !polling.has(run.id)) poll(run.id);
  }

  // Saved or declined on Memory: read again, and take the line off that answer.
  document.addEventListener('localai:fact-suggestions', () => {
    read(true).then(c => { for (const [id, host] of hosts) if (host.isConnected) draw(host, id, c, false); });
  });

  window.LocalAIFactLine = { mark };
})();
