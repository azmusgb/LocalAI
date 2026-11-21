'use strict';

// The Tier 1 reader job (amendment A31 phase 2, A32 D4; design section 11.3). On a tick it reads at most one new or
// revised stored document with the local model and no tools, and stores at most one finding whose quote appears
// word for word in the document (reader.js). It never fetches: documents come from the store, which intake fills.
//
// Order of every tick, each step before the next and none after a refusal:
//   switch on and not paused -> nothing interactive waiting -> daily findings cap -> next document after the cursor
//   -> a registered, active topic for the document's source -> the topic's budget (budget.js) -> the model call.
// A refusal leaves the cursor where it is, so the document stays queued and is read when the cap resets; intake keeps
// collecting meanwhile. Only a document that was actually read (a finding, or a valid "nothing here") moves the cursor,
// plus a document no topic covers (not read, counted) and a document that failed three times (counted, shown).

const { buildReaderPrompt, validateFindingOutput } = require('./reader');

const SYSTEM = 'You are a careful research analyst. You have no tools. Answer with one JSON object and nothing else.';
const CURSOR = 'reader.cursor';
const FAIL_LIMIT = 3, HOLD_MS = 15 * 60 * 1000;

// The model's answer as an object, or null when it is not one JSON object (fences and surrounding talk are tolerated).
function parseAnswer(text) {
  const s = String(text ?? '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { const v = JSON.parse(s.slice(a, b + 1)); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; }
}

function createReaderJob({ store, topics, budget, runModel, busy = () => ({ busy: false }), enabled = false, log = () => {},
  now = Date.now, dailyFindings = 10, timeoutMs = 120000 } = {}) {
  if (!store || !topics || !budget || typeof runModel !== 'function') throw new Error('store, topics, budget and runModel are required');
  const isEnabled = () => (typeof enabled === 'function' ? !!enabled() : !!enabled);
  const isPaused = () => store.getMeta('paused') === '1';
  const safeLog = (...a) => { try { log(...a); } catch { /* logging must not break a tick */ } };

  let running = false, lastTickAt = 0, last = { code: 'none', reason: 'has not run' };
  let holdUntil = 0, failing = { seq: 0, count: 0 };
  const counts = { read: 0, findings: 0, outOfScope: 0, failed: 0 };

  const result = (code, reason, extra = {}) => { last = { code, reason, at: new Date(now()).toISOString(), ...extra }; return last; };

  function cursor() {
    const raw = store.getMeta(CURSOR);
    if (raw === null) return 0;
    if (!/^\d{1,15}$/.test(raw)) throw new Error('reader cursor is not a number');
    return Number(raw);
  }
  const advance = seq => store.setMeta(CURSOR, String(seq));

  // Active topics whose name matches one of the source's topic labels, in creation order.
  function topicsFor(source) {
    const wanted = new Set((source?.topics || []).map(t => String(t).trim().toLowerCase()).filter(Boolean));
    return topics.listTopics().filter(t => t.status === 'active' && wanted.has(String(t.name).trim().toLowerCase()));
  }

  async function tick() {
    if (running) return result('busy', 'the previous read is still running');
    running = true; lastTickAt = now();
    try {
      if (!isEnabled()) return result('off', 'the reader is off');
      if (isPaused()) return result('paused', 'research is paused');
      if (now() < holdUntil) return result('held', 'waiting after a failed read', { holdUntil: new Date(holdUntil).toISOString() });
      let b; try { b = busy(); } catch { return result('busy', 'could not tell whether the model is in use'); }
      if (b && b.busy) return result('busy', 'something interactive is using the model');
      if (store.countFindingsToday() >= dailyFindings) return result('daily_cap', 'the daily findings limit is reached');

      const seqBefore = cursor();
      const doc = store.nextDocumentAfter(seqBefore);
      if (!doc) return result('idle', 'nothing new to read');
      const source = store.getSource(doc.sourceId);
      const candidates = topicsFor(source);
      if (!candidates.length) { counts.outOfScope++; advance(doc.seq); return result('out_of_scope', 'no active topic covers this source', { documentId: doc.id }); }

      const prompt = buildReaderPrompt(doc);
      let reserved = null, refusal = null;
      for (const t of candidates) {
        const r = budget.reserve({ topicId: t.id, tier: 1, chars: prompt.length + SYSTEM.length });
        if (r.ok) { reserved = t; break; }
        refusal = r;
        if (r.code === 'budget_unreadable') break; // the counters are failing: do not try another topic
      }
      if (!reserved) {
        if (refusal.code === 'budget_unreadable') return result('error', refusal.reason, { budget: refusal.code });
        return result('budget_exhausted', refusal.reason, { cap: refusal.cap, resetsAt: refusal.resetsAt, queued: true, documentId: doc.id });
      }

      let answer;
      try { answer = await runModel(prompt, SYSTEM, timeoutMs); }
      catch (e) {
        failing = failing.seq === doc.seq ? { seq: doc.seq, count: failing.count + 1 } : { seq: doc.seq, count: 1 };
        safeLog('research reader: model call failed', e && e.message);
        if (failing.count >= FAIL_LIMIT) { counts.failed++; advance(doc.seq); failing = { seq: 0, count: 0 }; return result('failed', 'the model failed three times on this document; it was skipped', { documentId: doc.id }); }
        holdUntil = now() + HOLD_MS;
        return result('model_failed', 'the model call failed; will retry', { documentId: doc.id });
      }
      failing = { seq: 0, count: 0 };

      counts.read++;
      const finding = validateFindingOutput(doc, parseAnswer(answer));
      if (finding) {
        store.addFinding({ documentId: doc.id, sourceId: doc.sourceId, claim: finding.claim, quote: finding.quote, targetProject: finding.targetProject, relevance: finding.relevance });
        counts.findings++;
      }
      advance(doc.seq);
      return result(finding ? 'finding' : 'no_finding', finding ? 'one finding stored' : 'nothing relevant, or the quote was not in the document', { documentId: doc.id, topicId: reserved.id });
    } catch (e) {
      safeLog('research reader: tick failed', e && e.message);
      return result('error', 'the reader could not read its state');
    } finally { running = false; }
  }

  // For the state route. A cursor that cannot be read is `unreadable`, never "caught up".
  function state() {
    try {
      const c = cursor();
      return { enabled: isEnabled(), unreadable: false, running, cursor: c, lastTickAt: lastTickAt ? new Date(lastTickAt).toISOString() : '', last, counts: { ...counts }, dailyFindings };
    } catch {
      return { enabled: isEnabled(), unreadable: true, running, last, counts: { ...counts }, dailyFindings };
    }
  }

  return { tick, state };
}

module.exports = { createReaderJob, parseAnswer };
