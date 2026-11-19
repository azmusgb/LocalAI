'use strict';

// Answer feedback (app/answer-feedback.js, app/server/answer-feedback.js): set, change and clear a verdict; the row keeps
// what was asked and how it was routed after the ledger drops the run; notes and questions are redacted; the summary
// counts by window; a store that can't be read is an error, never an empty summary; an older release still opens the db.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Storage } = require('../app/storage');
const { RunLedger } = require('../app/run-ledger');
const { createAnswerFeedback, answerRun } = require('../app/answer-feedback');
const { createAnswerFeedbackRoutes } = require('../app/server/answer-feedback');
const { runCard } = require('../app/run-cards');
const { guarded } = require('../app/signin');

const NOW = Date.parse('2026-11-19T12:00:00Z');
function open(now = () => NOW) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'answer-feedback-'));
  const storage = new Storage({ dataDir: dir });
  return { dir, storage, feedback: createAnswerFeedback({ db: storage.db, now }) };
}
const groq = { provider: 'groq', model: 'llama-3.3-70b-versatile', class: 'shareable', why: 'Not private: research about public topics' };
const local = { provider: 'ollama', model: 'qwen3:4b', class: 'private', why: 'House question' };
const answer = (over = {}) => ({ id: 'run-1', type: 'chat', status: 'completed', title: 'Which filament for a bracket?', input: { prompt: 'Which filament for a bracket?' }, meta: { route: local }, ...over });

test('a verdict is set, changed and cleared, one row per run', () => {
  const { feedback, storage } = open();
  const run = answer();
  const good = feedback.set(run, 'good');
  assert.deepEqual(good, { runId: 'run-1', verdict: 'good', note: '', at: new Date(NOW).toISOString() });
  const bad = feedback.set(run, 'bad', 'It suggested PLA for a hot car');
  assert.equal(bad.verdict, 'bad');
  assert.equal(bad.note, 'It suggested PLA for a hot car');
  assert.equal(storage.db.prepare('SELECT count(*) AS n FROM answer_feedback').get().n, 1);
  // Good keeps no note: a note says what was wrong.
  assert.equal(feedback.set(run, 'good', 'ignored').note, '');
  assert.equal(feedback.set(run, null), null);
  assert.equal(feedback.get('run-1'), null);
  assert.equal(storage.db.prepare('SELECT count(*) AS n FROM answer_feedback').get().n, 0);
  assert.throws(() => feedback.set(run, 'meh'), /verdict/);
  storage.close();
});

test('only finished chat, research and Past work answers can be rated', () => {
  assert.equal(answerRun(answer()), true);
  assert.equal(answerRun(answer({ type: 'research' })), true);
  assert.equal(answerRun(answer({ type: 'prompt', meta: { mode: 'history' } })), true);
  for (const run of [answer({ status: 'failed' }), answer({ status: 'cancelled' }), answer({ status: 'running' }), answer({ type: 'image' }),
    answer({ type: 'agent' }), answer({ type: 'engineering' }), answer({ type: 'prompt', meta: {} }), null]) assert.equal(answerRun(run), false, JSON.stringify(run));
  const { feedback, storage } = open();
  assert.throws(() => feedback.set(answer({ status: 'failed' }), 'good'), /finished answer/);
  storage.close();
});

test('the row keeps the question, model, provider and class after the ledger drops the run', () => {
  const { feedback, storage } = open();
  const ledger = new RunLedger({ storage, maxRuns: 20 });
  const first = ledger.create({ type: 'research', title: 'Best PETG dryer settings', input: { prompt: 'Best PETG dryer settings' } });
  ledger.complete(first.id, { output: { text: '65 °C for 4 hours.' }, meta: { route: groq } });
  feedback.set(ledger.get(first.id), 'bad', 'Too hot for my dryer');
  for (let i = 0; i < 25; i++) ledger.create({ type: 'chat', title: `Later ${i}` });
  assert.equal(ledger.get(first.id), null, 'the ledger dropped the rated run');
  const row = storage.db.prepare('SELECT * FROM answer_feedback WHERE run_id = ?').get(first.id);
  assert.deepEqual({ ...row }, { run_id: first.id, verdict: 'bad', note: 'Too hot for my dryer', at: new Date(NOW).toISOString(), kind: 'research', provider: 'groq', model: 'llama-3.3-70b-versatile', class: 'shareable', asked: 'Best PETG dryer settings' });
  const s = feedback.summary({ kept: id => !!ledger.get(id) });
  assert.deepEqual(s.days30.rows, [{ provider: 'groq', model: 'llama-3.3-70b-versatile', good: 0, bad: 1 }]);
  assert.equal(s.recent[0].kept, false);
  assert.equal(s.recent[0].asked, 'Best PETG dryer settings');
  storage.close();
});

test('a route without a class takes the class from the run\'s privacy; an older run without a route still rates', () => {
  const { feedback, storage } = open();
  feedback.set(answer({ id: 'run-a', meta: { route: { provider: 'ollama', model: 'm' }, privacy: { class: 'private' } } }), 'good');
  feedback.set(answer({ id: 'run-b', meta: {} }), 'good');
  const rows = storage.db.prepare('SELECT run_id, provider, model, class FROM answer_feedback ORDER BY run_id').all().map(r => ({ ...r }));
  assert.deepEqual(rows, [{ run_id: 'run-a', provider: 'ollama', model: 'm', class: 'private' }, { run_id: 'run-b', provider: '', model: '', class: '' }]);
  storage.close();
});

test('the note and the question are redacted, one line, and cut to 300 and 200 characters', () => {
  const { feedback, storage } = open();
  const secret = 'sk-' + 'a'.repeat(30);
  feedback.set(answer({ input: { prompt: `Why does OPENAI_API_KEY=${secret} fail?\nIt says 401` } }), 'bad', `It printed my token ${secret}\nand password: hunter2`);
  const row = storage.db.prepare('SELECT note, asked FROM answer_feedback').get();
  assert.equal(row.asked.includes(secret), false);
  assert.equal(row.note.includes(secret), false);
  assert.equal(row.note.includes('hunter2'), false);
  assert.match(row.asked, /OPENAI_API_KEY=\[redacted\] fail\? It says 401/);
  assert.equal(/\n/.test(row.note + row.asked), false);
  feedback.set(answer({ id: 'run-long', input: { prompt: 'q'.repeat(500) } }), 'bad', 'n'.repeat(500));
  const long = storage.db.prepare("SELECT note, asked FROM answer_feedback WHERE run_id = 'run-long'").get();
  assert.equal(long.note.length, 300);
  assert.equal(long.asked.length, 200);
  // A long secret that redacts to a few characters must not pull a second secret's fragment into the kept 200.
  const hex = 'f'.repeat(64);
  // The key is 223 characters and redacts to 10; the hex starts at character 380, so a cut at 400 leaves 20 of it.
  feedback.set(answer({ id: 'run-two', input: { prompt: `${'sk-' + 'b'.repeat(220)} ${'w'.repeat(155)} ${hex}` } }), 'bad');
  const two = storage.db.prepare("SELECT asked FROM answer_feedback WHERE run_id = 'run-two'").get();
  assert.equal(/f{8,}|b{8,}/.test(two.asked), false, two.asked);
  // A quoted secret split by a newline is still redacted (whitespace is collapsed before redacting).
  feedback.set(answer({ id: 'run-quoted', input: { prompt: 'password: "hunter2\nzebra" why?' } }), 'bad');
  const quoted = storage.db.prepare("SELECT asked FROM answer_feedback WHERE run_id = 'run-quoted'").get();
  assert.equal(/hunter2|zebra/.test(quoted.asked), false, quoted.asked);
  // Past the 20,000-character bound, a token cut in half is dropped, not kept as an unmatched fragment.
  // The key block is 19,960 characters and redacts to 10; the 64-character hex starts at 19,977, so the bound cuts it to 23.
  const pem = '-----BEGIN RSA PRIVATE KEY-----' + 'k'.repeat(19900) + '-----END RSA PRIVATE KEY-----';
  feedback.set(answer({ id: 'run-cap', input: { prompt: `${pem} ${'e'.repeat(15)} ${'c'.repeat(64)}` } }), 'bad');
  const cap = storage.db.prepare("SELECT asked FROM answer_feedback WHERE run_id = 'run-cap'").get();
  assert.equal(/c{4,}/.test(cap.asked), false, cap.asked);
  storage.close();
});

test('the summary counts by provider and model for 30 and 90 days, and lists the newest 20 not right', () => {
  let now = NOW - 60 * 86400000;
  const { feedback, storage } = open(() => now);
  feedback.set(answer({ id: 'run-old', meta: { route: groq } }), 'bad', 'Old');
  feedback.set(answer({ id: 'run-ancient', meta: { route: groq } }), 'good');
  storage.db.prepare("UPDATE answer_feedback SET at = ? WHERE run_id = 'run-ancient'").run(new Date(NOW - 120 * 86400000).toISOString());
  now = NOW;
  for (let i = 0; i < 3; i++) feedback.set(answer({ id: `run-g${i}` }), 'good');
  for (let i = 0; i < 22; i++) { now = NOW + i; feedback.set(answer({ id: `run-b${String(i).padStart(2, '0')}` }), 'bad', `Wrong ${i}`); }
  feedback.set(answer({ id: 'run-c', meta: { route: groq } }), 'good');
  const s = feedback.summary({ kept: id => id === 'run-b21' });
  assert.equal(s.total, 28);
  assert.deepEqual(s.days30.rows, [{ provider: 'ollama', model: 'qwen3:4b', good: 3, bad: 22 }, { provider: 'groq', model: 'llama-3.3-70b-versatile', good: 1, bad: 0 }]);
  assert.deepEqual([s.days30.good, s.days30.bad], [4, 22]);
  assert.deepEqual(s.days90.rows.find(r => r.provider === 'groq'), { provider: 'groq', model: 'llama-3.3-70b-versatile', good: 1, bad: 1 });
  assert.deepEqual([s.days90.good, s.days90.bad], [4, 23]);
  assert.equal(s.recent.length, 20);
  assert.equal(s.recent[0].runId, 'run-b21');
  assert.equal(s.recent[0].kept, true);
  assert.equal(s.recent[0].note, 'Wrong 21');
  assert.equal(s.recent[1].kept, false);
  storage.close();
});

test('an empty store is an empty summary with zero counts', () => {
  const { feedback, storage } = open();
  const s = feedback.summary();
  assert.equal(s.total, 0);
  assert.deepEqual(s.days30.rows, []);
  assert.deepEqual(s.recent, []);
  storage.close();
});

// A tiny json/readBody pair for the routes, the way server.js passes them.
function routes(answerFeedback, runs = {}) {
  const sent = [];
  const json = (res, status, body) => { sent.push({ status, body }); };
  const r = createAnswerFeedbackRoutes({ answerFeedback, json, readBody: async req => req.body, runLedger: { get: id => runs[id] || null } });
  return { sent, ...r };
}

test('a store that cannot be read answers 503 with an error, never an empty summary or zeros', async () => {
  const warn = console.warn; console.warn = () => {};
  try {
    const broken = createAnswerFeedback({ db: { exec() { throw new Error('database disk image is malformed'); }, prepare() { throw new Error('no'); } } });
    const r = routes(broken, { 'run-1': answer() });
    await r.apiFeedbackSummary({}, {});
    assert.equal(r.sent[0].status, 503);
    assert.match(r.sent[0].body.error, /Couldn't read/);
    assert.equal('days30' in r.sent[0].body, false);
    await r.apiFeedback({ body: { id: 'run-1', verdict: 'good' } }, {});
    assert.equal(r.sent[1].status, 503);

    // A store that opened but fails later (the database closed under it) is the same.
    const { feedback, storage } = open();
    storage.close();
    const r2 = routes(feedback, { 'run-1': answer() });
    await r2.apiFeedbackSummary({}, {});
    assert.equal(r2.sent[0].status, 503);
    assert.equal(runCard(answer(), { feedbackFor: () => { try { return feedback.get('run-1'); } catch { return { unread: true }; } } }).feedback.unread, true);
  } finally { console.warn = warn; }
});

test('POST /api/runs/feedback: 400 for a bad body, 404 for an unknown run, 409 for a run that is not a finished answer', async () => {
  const { feedback, storage } = open();
  const r = routes(feedback, { 'run-1': answer(), 'run-f': answer({ id: 'run-f', status: 'failed' }), 'run-i': answer({ id: 'run-i', type: 'image' }) });
  const call = async body => { await r.apiFeedback({ body }, {}); return r.sent.at(-1); };
  assert.equal((await call({ id: 'run-1', verdict: 'maybe' })).status, 400);
  assert.equal((await call({ verdict: 'good' })).status, 400);
  assert.equal((await call({ id: 'run-1', verdict: 'bad', note: 'x'.repeat(301) })).status, 400);
  assert.equal((await call({ id: 'run-1', verdict: 'bad', note: 5 })).status, 400);
  assert.equal((await call({ id: 'run-gone', verdict: 'good' })).status, 404);
  assert.equal((await call({ id: 'run-f', verdict: 'good' })).status, 409);
  assert.equal((await call({ id: 'run-i', verdict: 'good' })).status, 409);
  assert.equal((await call({ id: 'legacy-agent:abc', verdict: 'good' })).status, 409);
  const ok = await call({ id: 'run-1', verdict: 'bad', note: 'Wrong year' });
  assert.equal(ok.status, 200);
  assert.deepEqual({ verdict: ok.body.feedback.verdict, note: ok.body.feedback.note }, { verdict: 'bad', note: 'Wrong year' });
  assert.deepEqual((await call({ id: 'run-1', verdict: null })).body, { feedback: null });
  storage.close();
});

test('a run card carries its verdict; only answers do', () => {
  const lookup = { 'run-1': { runId: 'run-1', verdict: 'bad', note: 'Wrong', at: 'x' } };
  const feedbackFor = r => lookup[r.id] || null;
  assert.deepEqual(runCard(answer(), { feedbackFor }).feedback, { verdict: 'bad', note: 'Wrong' });
  assert.equal(runCard(answer({ id: 'run-2' }), { feedbackFor }).feedback, null);
  assert.equal('feedback' in runCard(answer({ type: 'image' }), { feedbackFor }), false);
  assert.equal('feedback' in runCard(answer()), false, 'no lookup, nothing said');
});

test('rating an answer is a guarded write; reading the summary is not', () => {
  assert.equal(guarded('/api/runs/feedback', 'POST'), true);
  assert.equal(guarded('/api/runs/feedback/summary', 'GET'), false);
});

test('an unchanged Storage still opens a database that has the answer_feedback table (rollback)', () => {
  const { dir, feedback, storage } = open();
  feedback.set(answer(), 'good');
  storage.close();
  const again = new Storage({ dataDir: dir });
  assert.equal(again.check(), true);
  assert.equal(again.status().schemaVersion, 1);
  assert.equal(again.db.prepare('SELECT count(*) AS n FROM answer_feedback').get().n, 1);
  again.close();
});
