'use strict';

// Answer feedback's API (app/answer-feedback.js): POST /api/runs/feedback rates one answer (a guarded write,
// app/signin.js), GET /api/runs/feedback/summary is what Models shows. A store that can't be read is an error
// response, never an empty summary. ctx holds what this code uses from the rest of the server.
const { answerRun, NOTE_MAX } = require('../answer-feedback');

function createAnswerFeedbackRoutes(ctx) {
  const { answerFeedback, json, readBody, runLedger } = ctx;
  const unreadable = (res, e) => {
    console.warn(`Answer feedback: the store could not be used: ${e?.message || e}`);
    json(res, 503, { error: "Couldn't read or save answer ratings right now." });
  };

  // {id, verdict: 'good'|'bad'|null, note?} -> {feedback}. 404 for an unknown run, 409 for a run that isn't a finished
  // answer (an older store's run, a failed or cancelled one, an image, a mission or a change).
  async function apiFeedback(req, res) {
    let b;
    try { b = await readBody(req, 4 * 1024); } catch (e) { return json(res, 400, { error: e?.message || 'Invalid request' }); }
    const id = typeof b?.id === 'string' ? b.id : '';
    if (!id) return json(res, 400, { error: 'Say which run.' });
    if (!(b.verdict === null || b.verdict === 'good' || b.verdict === 'bad')) return json(res, 400, { error: 'verdict must be "good", "bad" or null' });
    if (b.note !== undefined && b.note !== null && typeof b.note !== 'string') return json(res, 400, { error: 'note must be text' });
    if (typeof b.note === 'string' && b.note.length > NOTE_MAX) return json(res, 400, { error: `Keep the note under ${NOTE_MAX} characters.` });
    if (id.startsWith('legacy-')) return json(res, 409, { error: 'Only answers can be rated.' });
    const run = runLedger.get(id);
    if (!run) return json(res, 404, { error: 'Run not found' });
    if (!answerRun(run)) return json(res, 409, { error: run.status === 'completed' ? 'Only answers can be rated.' : 'Only a finished answer can be rated.' });
    try { return json(res, 200, { feedback: answerFeedback.set(run, b.verdict, b.note || '') }); }
    catch (e) { return unreadable(res, e); }
  }

  async function apiFeedbackSummary(req, res) {
    try { return json(res, 200, answerFeedback.summary({ kept: runId => !!runLedger.get(runId) })); }
    catch (e) { return unreadable(res, e); }
  }

  return { apiFeedback, apiFeedbackSummary };
}

module.exports = { createAnswerFeedbackRoutes };
