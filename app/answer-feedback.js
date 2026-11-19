'use strict';

// Answer feedback (docs/superpowers/specs/2026-11-19-answer-feedback-design.md): the owner's "Good answer" or "Not
// right" on a finished answer, kept with what was asked, which model answered and how it was routed. One row per run,
// changed in place and deleted when cleared. The row copies the run's details, so it outlives the run when the ledger
// drops it. Like the journal's tables it is created IF NOT EXISTS without a schema version bump, so Safe Deploy's
// rollback to an older release still opens the database (an older app ignores the table).
// Feedback never reaches a model (amendment A28 D5): nothing here is read by a prompt, only by its routes.

const { redact } = require('./journal');

const NOTE_MAX = 300, ASKED_MAX = 200, RECENT = 20, DAY = 86400000;
const VERDICTS = new Set(['good', 'bad']);
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS answer_feedback (
    run_id TEXT PRIMARY KEY,
    verdict TEXT NOT NULL CHECK(verdict IN ('good','bad')),
    note TEXT NOT NULL DEFAULT '',
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    class TEXT NOT NULL,
    asked TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS answer_feedback_at ON answer_feedback(at);`;

// A run the owner can rate: a finished chat, research or Past work answer. Not a failed or cancelled run, an image, a
// mission or a change.
function answerRun(run) {
  if (!run || run.status !== 'completed') return false;
  if (run.type === 'chat' || run.type === 'research') return true;
  return run.type === 'prompt' && run.meta?.mode === 'history';
}

const oneLine = (text, max) => redact(String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max * 2)).slice(0, max);

function createAnswerFeedback({ db, now = Date.now }) {
  if (!db || typeof db.exec !== 'function') throw new TypeError('db is required');
  // Unlike the journal, a store that can't be opened is not quietly empty: every call throws, so a route answers with an
  // error and never with "no ratings".
  let failure = null;
  try { db.exec(SCHEMA); } catch (error) { failure = error; }
  const ready = () => { if (failure) throw failure; };
  const shape = row => row ? { runId: row.run_id, verdict: row.verdict, note: row.note, at: row.at } : null;

  function get(runId) {
    ready();
    return shape(db.prepare('SELECT run_id, verdict, note, at FROM answer_feedback WHERE run_id = ?').get(String(runId || '')));
  }

  // verdict 'good' | 'bad' sets or changes the row; null clears it. The run must be an answer (answerRun): the caller
  // says 404 or 409 first. Returns the feedback as stored, or null once cleared.
  function set(run, verdict, note = '') {
    ready();
    if (!answerRun(run)) throw new TypeError('Only a finished answer can be rated.');
    if (verdict === null) { db.prepare('DELETE FROM answer_feedback WHERE run_id = ?').run(run.id); return null; }
    if (!VERDICTS.has(verdict)) throw new TypeError('verdict must be good, bad or null');
    const route = run.meta?.route && typeof run.meta.route === 'object' ? run.meta.route : {};
    const cls = route.class || run.meta?.privacy?.class || '';
    const at = new Date(now()).toISOString();
    db.prepare(`INSERT INTO answer_feedback (run_id, verdict, note, at, kind, provider, model, class, asked) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(run_id) DO UPDATE SET verdict = excluded.verdict, note = excluded.note, at = excluded.at, kind = excluded.kind,
        provider = excluded.provider, model = excluded.model, class = excluded.class, asked = excluded.asked`)
      .run(run.id, verdict, verdict === 'bad' ? oneLine(note, NOTE_MAX) : '', at, String(run.type),
        String(route.provider || '').slice(0, 40), String(route.model || '').slice(0, 120), String(cls).slice(0, 20),
        oneLine(run.input?.prompt || run.title, ASKED_MAX));
    return get(run.id);
  }

  // Counts by provider and model for the last 30 and 90 days, and the newest "not right" rows. kept(runId) says whether
  // the run is still in the ledger, so the page can link to it or say it is no longer kept.
  function summary({ kept = () => false } = {}) {
    ready();
    const windowOf = days => {
      const since = new Date(now() - days * DAY).toISOString();
      const rows = db.prepare(`SELECT provider, model, SUM(verdict = 'good') AS good, SUM(verdict = 'bad') AS bad FROM answer_feedback
        WHERE at >= ? GROUP BY provider, model ORDER BY good + bad DESC, provider, model`).all(since)
        .map(r => ({ provider: r.provider, model: r.model, good: Number(r.good), bad: Number(r.bad) }));
      return { since, good: rows.reduce((n, r) => n + r.good, 0), bad: rows.reduce((n, r) => n + r.bad, 0), rows };
    };
    const recent = db.prepare(`SELECT run_id, at, kind, provider, model, note, asked FROM answer_feedback WHERE verdict = 'bad'
      ORDER BY at DESC, run_id DESC LIMIT ?`).all(RECENT)
      .map(r => ({ runId: r.run_id, at: r.at, kind: r.kind, provider: r.provider, model: r.model, note: r.note, asked: r.asked, kept: !!kept(r.run_id) }));
    const total = db.prepare('SELECT count(*) AS n FROM answer_feedback').get().n;
    return { total: Number(total), days30: windowOf(30), days90: windowOf(90), recent };
  }

  return { get, set, summary };
}

module.exports = { createAnswerFeedback, answerRun, NOTE_MAX, ASKED_MAX };
