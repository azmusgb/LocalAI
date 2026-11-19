'use strict';

// A Past work ask as the server runs it (app/server/journal.js startPastWork): exactly one `prompt` run with
// meta.mode 'history', sent to this PC's model with no tools, through the real coordinator with cloud switched on and
// "Use a bigger model" asked for (amendment A28 D5). The model is a fake HTTP answer.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Storage } = require('../app/storage');
const { createJournal } = require('../app/journal');
const { RunLedger } = require('../app/run-ledger');
const { runEntry } = require('../app/journal-recorders');
const modelRouter = require('../app/model-router');
const { createCoordinator } = require('../app/model-coordinator');
const { fitMessages } = require('../app/text-context');
const { createJournalRoutes } = require('../app/server/journal');
const { OPEN, CLOSE, UNREADABLE, NOTHING } = require('../app/journal-ask');

function setup(t, { reply = { message: { content: 'You asked about PETG [1].' } }, status = 200, raw = null, fail = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-ask-run-'));
  const storage = new Storage({ dataDir: dir });
  const journal = createJournal({ db: storage.db });
  // The server's own wiring: a finished run is recorded unless the recorder skips it.
  const runLedger = new RunLedger({ storage, onTransition: run => { const e = runEntry(run); if (e) journal.record(e); } });
  t.after(() => { storage.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const cloudCalls = [];
  // Cloud switched on, with keys for both providers: anything shareable would go out.
  const coordinator = createCoordinator({ modelRouter, routingSetting: () => ({ cloud: true }), localModel: 'qwen3:4b', cloudModels: { keys: () => ({ groq: true, cerebras: true }), parked: () => ({}), chat: async (...a) => { cloudCalls.push(a); return { content: 'cloud' }; } } });
  const sent = [];
  const modelFetchWithTimeout = async (url, opts) => {
    sent.push({ url, body: JSON.parse(opts.body) });
    if (fail) throw fail;
    return new Response(raw ?? JSON.stringify(reply), { status });
  };
  const routes = createJournalRoutes({ ANSWER_RESERVE: 1024, CHAT_MODEL_TIMEOUT_MS: 1000, MODEL: 'qwen3:4b', OLLAMA_URL: 'http://ollama.test', TEXT_KEEP_ALIVE: '30m', TEXT_NUM_CTX: 8192, coordinator, fitMessages, journal, json: () => {}, modelFetchWithTimeout, readBody: async () => ({}), runLedger, storageError: () => {} });
  return { storage, journal, runLedger, routes, sent, cloudCalls };
}
const seed = journal => journal.record({ at: new Date(Date.now() - 3600e3).toISOString(), source: 'run', kind: 'chat', title: 'Which filament for a PETG bracket?', body: 'PETG handles heat.', link: '#run/run-old', ref: 'run:run-old:completed' });

test('one prompt run, mode history, on this PC with "Use a bigger model" and cloud on: no tools, no other run', async t => {
  const { journal, runLedger, routes, sent, cloudCalls } = setup(t);
  seed(journal);
  const before = runLedger.list({ all: true }).length;
  const { run, done } = routes.startPastWork({ question: 'what did I ask about PETG', bigger: true });
  assert.equal(run.type, 'prompt');
  assert.equal(run.meta.mode, 'history');
  const finished = await done;
  assert.equal(runLedger.list({ all: true }).length, before + 1, 'exactly one run');
  assert.equal(finished.status, 'completed');
  assert.deepEqual(finished.meta.privacy, { class: 'private', why: 'Your past work stays on this PC' });
  assert.deepEqual(finished.meta.route, { provider: 'ollama', model: 'qwen3:4b', class: 'private', why: 'Your past work stays on this PC' });
  assert.equal(cloudCalls.length, 0, 'no cloud model was asked');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'http://ollama.test/api/chat');
  assert.equal(sent[0].body.model, 'qwen3:4b');
  assert.equal(sent[0].body.tools, undefined, 'no tools');
  assert.deepEqual(sent[0].body.messages.map(m => m.role), ['system', 'user'], 'one turn');
  assert.ok(sent[0].body.messages[1].content.startsWith(OPEN) && sent[0].body.messages[1].content.includes(CLOSE));
  assert.equal(finished.output.text, 'You asked about PETG [1].');
  assert.deepEqual(finished.output.citations.map(c => c.link), ['#run/run-old']);
  assert.equal(finished.output.entries.length, 1);
  assert.equal(journal.search({ q: 'PETG' }).items.length, 1, 'the answer was not recorded back into the journal');
});

test('nothing found: the run completes with the fixed answer and no model call', async t => {
  const { routes, sent } = setup(t);
  const finished = await routes.startPastWork({ question: 'when did I buy a zeppelin' }).done;
  assert.equal(finished.status, 'completed');
  assert.equal(finished.output.text, NOTHING);
  assert.deepEqual(finished.output.entries, []);
  assert.equal(sent.length, 0);
});

test('the model failing, timing out or answering garbage fails the run with the entries kept', async t => {
  const cases = [
    [{ fail: Object.assign(new Error('The model took longer than 180 s (request timed out)'), { code: 'MODEL_TIMEOUT' }) }, 'The local model took too long to answer. Try again when the PC is less busy.'],
    [{ fail: Object.assign(new Error('Ollama wasn’t answering at 127.0.0.1:9 (ECONNREFUSED)'), { code: 'MODEL_UNREACHABLE' }) }, "The local model isn't answering, so there is no answer yet. Check Intelligence on Assistant status, then try again."],
    [{ status: 500, raw: 'boom' }, 'The local model reported an error instead of an answer. Try again.'],
    [{ raw: '<html>' }, "The local model's reply was empty or could not be read. Try again."],
    [{ reply: { message: {} } }, "The local model's reply was empty or could not be read. Try again."]
  ];
  for (const [over, words] of cases) {
    const { journal, routes } = setup(t, over);
    seed(journal);
    const finished = await routes.startPastWork({ question: 'what did I ask about PETG' }).done;
    assert.equal(finished.status, 'failed', JSON.stringify(over));
    assert.equal(finished.error, words, 'plain words; the detail is in the server log');
    assert.equal(finished.retryable, true, 'Retry asks again');
    assert.equal(finished.output.entries.length, 1, 'what was read is still shown');
    assert.equal(finished.output.entries[0].title, 'Which filament for a PETG bracket?');
  }
});

test('a journal that cannot be read fails the run plainly, never as "nothing found"', async t => {
  const { routes, journal, sent } = setup(t);
  journal.search = () => { throw new Error('SQLITE_CORRUPT'); };
  const finished = await routes.startPastWork({ question: 'what did I ask about PETG' }).done;
  assert.equal(finished.status, 'failed');
  assert.equal(finished.error, UNREADABLE);
  assert.notEqual(finished.output?.text, NOTHING);
  assert.equal(sent.length, 0);
  journal.disabled = true; journal.search = () => ({ items: [], next: null });
  const off = await routes.startPastWork({ question: 'what did I ask about PETG' }).done;
  assert.equal(off.error, UNREADABLE);
});

test('an empty question starts no run', t => {
  const { routes, runLedger } = setup(t);
  for (const question of ['', '   ', null, 42]) assert.throws(() => routes.startPastWork({ question }), /question/i);
  assert.equal(runLedger.list({ all: true }).length, 0);
});

// A28 D5 rule 4: no journal text goes into a run that has tools (missions, agents, changes, automations). The journal
// and Past work reach only the journal routes and voice; no tool-running module reads the journal.
test('the journal is handed only to the journal routes, and Past work only to voice (A28 D5)', () => {
  const server = fs.readFileSync(path.join(__dirname, '../app/server.js'), 'utf8');
  const wiring = [...server.matchAll(/require\('\.\/server\/([a-z-]+)'\)\.create[A-Za-z]+\(\{([^\n]*)\}\)/g)].map(m => ({ file: m[1], names: m[2] }));
  const given = name => wiring.filter(w => new RegExp(`(?:^|[,{\\s])${name}(?=[,}\\s:])`).test(w.names)).map(w => w.file).sort();
  assert.deepEqual(given('journal'), ['journal']);
  assert.deepEqual(given('startPastWork'), ['voice']);
  // The voice and approval recorders get a writer that can only add an entry (app/journal-recorders.js).
  assert.deepEqual(given('journalWriter'), ['notifications', 'voice']);
  assert.match(server, /const journalWriter = Object\.freeze\(\{ record: entry => journal\.record\(entry\) \}\);/);
  for (const file of ['server/agents.js', 'server/changes.js', 'server/automations.js', 'server/chat.js', 'agent-runtime.js', 'agent-orchestrator.js', 'agent-tools.js', 'mission-answer.js', 'mission-evidence.js']) {
    const source = fs.readFileSync(path.join(__dirname, '../app', file), 'utf8');
    assert.doesNotMatch(source, /require\([^)]*journal|startPastWork|askHistory/, `${file} reads no journal`);
  }
});

// GET /api/journal?ids=: which listed entries still exist. A journal that can't be read is an error, never an empty list
// (an empty list would draw every entry as deleted).
test('?ids=: present ids come back; a disabled journal is 503 and a database error is an error, never empty', t => {
  const { journal } = setup(t);
  journal.record({ at: new Date().toISOString(), source: 'run', kind: 'chat', title: 'Kept', ref: 'run:kept:completed' });
  const kept = journal.search({}).items[0].id;
  const call = j => {
    const out = {};
    const routes = createJournalRoutes({ journal: j, json: (res, status, body) => Object.assign(out, { status, body }), storageError: (res, e, status) => Object.assign(out, { status, body: { error: e.message } }) });
    routes.apiJournal({}, {}, new URL(`http://x/api/journal?ids=${kept},j-gone`));
    return out;
  };
  assert.deepEqual(call(journal), { status: 200, body: { items: [journal.get(kept)] } });
  const disabled = call({ ...journal, disabled: true, get: () => null });
  assert.equal(disabled.status, 503); assert.equal(disabled.body.error, "Couldn't read your past work.");
  const broken = call({ ...journal, get: () => { throw new Error('SQLITE_CORRUPT: database disk image is malformed'); } });
  assert.ok(broken.status >= 400, `status ${broken.status}`); assert.equal(broken.body.items, undefined, 'no list at all');
});
