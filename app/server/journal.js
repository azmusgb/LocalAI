'use strict';

// The journal's API (app/journal.js): GET /api/journal searches or lists what Local AI remembers; POST
// /api/journal/delete forgets one entry for good; POST /api/journal/ask answers a question about past work from it
// (app/journal-ask.js). ctx holds what this code uses from the rest of the server.
const { askHistory, runOutput, cleanQuestion, UNREADABLE, QUESTION_MAX } = require('../journal-ask');

// What a Past work request may carry: the question, and "Use a bigger model" (which changes nothing: it stays here).
const ASK_BODY_MAX = 4 * 1024;

function createJournalRoutes(ctx) {
  const { ANSWER_RESERVE, CHAT_MODEL_TIMEOUT_MS, MODEL, OLLAMA_URL, TEXT_KEEP_ALIVE, TEXT_NUM_CTX, coordinator, fitMessages, journal, json, modelFetchWithTimeout, readBody, runLedger, storageError } = ctx;
  async function apiJournal(req, res, urlObj) {
    try {
      const q = urlObj.searchParams;
      const sources = String(q.get('source') || '').split(',').map(s => s.trim()).filter(Boolean);
      return json(res, 200, journal.search({ q: q.get('q') || '', from: q.get('from'), to: q.get('to'), sources, limit: q.get('limit') || 50, before: q.get('before') }));
    } catch (e) { storageError(res, e, 400); }
  }
  async function apiJournalDelete(req, res) {
    try {
      const b = await readBody(req, 4 * 1024);
      return journal.remove(String(b.id || '')) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'No such entry' });
    } catch (e) { storageError(res, e, 400); }
  }

  // One turn of text on this PC's chat model: a system message and one user message, no tools, no earlier turns, no
  // cloud (amendment A28 D5). Resolves the answer's text; rejects on a timeout, an HTTP error or a reply without text.
  const localTurn = model => async ({ system, prompt }) => {
    const messages = fitMessages([{ role: 'system', content: system }, { role: 'user', content: prompt }], { numCtx: TEXT_NUM_CTX, reserve: ANSWER_RESERVE }).map(({ role, content }) => ({ role, content }));
    const r = await modelFetchWithTimeout(`${OLLAMA_URL}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: false, keep_alive: TEXT_KEEP_ALIVE, options: { num_ctx: TEXT_NUM_CTX } })
    }, CHAT_MODEL_TIMEOUT_MS);
    const raw = await r.text();
    if (!r.ok) throw new Error(`Intelligence service HTTP ${r.status}: ${raw.slice(0, 300)}`);
    let content;
    try { content = JSON.parse(raw)?.message?.content; } catch { content = undefined; }
    if (typeof content !== 'string') throw new Error('The local model sent a reply that could not be read.');
    return content;
  };

  // Past work: exactly one `prompt` run (meta.mode 'history'), answered by this PC's model whatever is asked for, and
  // never recorded back into the journal (app/journal-recorders.js). Throws a TypeError for an empty question, before
  // any run exists. Returns {run, done}: the run as created, and a promise that settles with the finished run (it never
  // rejects: a failure is the run's own state, with whatever entries were read kept in its output).
  function startPastWork({ question, bigger = false, voice = false } = {}) {
    const q = cleanQuestion(question);
    const route = coordinator.route({ kind: 'chat', text: q, journal: true, bigger: bigger === true, voice: voice === true, localModel: MODEL });
    const local = route.order.length === 1 && route.order[0].provider === 'ollama' ? route.order[0] : null;
    if (route.class !== 'private' || !local) throw new Error('Past work stays on this PC, and no local model was given.'); // the router's rule, held here too
    const used = { provider: 'ollama', model: local.model, class: route.class, why: route.why };
    const run = runLedger.create({
      type: 'prompt', title: q, input: { prompt: q }, eventDetail: 'Past work asked',
      meta: { mode: 'history', privacy: { class: route.class, why: route.why }, ...(voice === true ? { voice: true } : {}) }
    });
    const done = (async () => {
      let read = [], from = 'journal';
      try {
        runLedger.start(run.id, 'Reading past work');
        const out = await askHistory({ question: q, journal, chatOnce: localTurn(local.model), onEntries: (entries, where) => { read = entries; from = where; runLedger.update(run.id, { progress: 40 }, `Asking the local model about ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`); } });
        return runLedger.complete(run.id, { summary: out.answer.slice(0, 420), output: runOutput(out), meta: { route: used } });
      } catch (e) {
        const entries = Array.isArray(e?.entries) ? e.entries : read;
        // A journal that can't be read is said plainly; the reason stays in the server's log, not in the run.
        if (e?.code === 'history_unreadable') console.warn(`Past work: the journal could not be read: ${e.cause?.message || 'it is switched off'}`);
        runLedger.update(run.id, { output: runOutput({ answer: '', citations: [], entries, from: e?.from || from }) });
        return runLedger.fail(run.id, e?.code === 'history_unreadable' ? UNREADABLE : e);
      }
    })();
    return { run, done };
  }

  // POST /api/journal/ask {question, bigger?}: starts the run and answers with its id at once; the run view follows it.
  async function apiJournalAsk(req, res) {
    let b;
    try { b = await readBody(req, ASK_BODY_MAX); } catch (e) { return storageError(res, e, 400); }
    const question = typeof b?.question === 'string' ? b.question.trim() : '';
    if (!question) return json(res, 400, { error: 'Ask a question.' });
    if (question.length > QUESTION_MAX) return json(res, 400, { error: `Keep the question under ${QUESTION_MAX} characters.` });
    try {
      const { run } = startPastWork({ question, bigger: b.bigger === true });
      return json(res, 202, { runId: run.id, run });
    } catch (e) { storageError(res, e, 500); }
  }

  return { apiJournal, apiJournalAsk, apiJournalDelete, startPastWork };
}

module.exports = { createJournalRoutes };
