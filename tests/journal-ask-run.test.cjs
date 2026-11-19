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
const { OPEN, CLOSE, UNREADABLE, NOTHING, NO_PRINT_READER } = require('../app/journal-ask');
const { createPiHub } = require('../app/pi-hub');

function setup(t, { reply = { message: { content: 'You asked about PETG [1].' } }, status = 200, raw = null, fail = null, prints = undefined } = {}) {
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
  const routes = createJournalRoutes({ ANSWER_RESERVE: 1024, CHAT_MODEL_TIMEOUT_MS: 1000, MODEL: 'qwen3:4b', OLLAMA_URL: 'http://ollama.test', TEXT_KEEP_ALIVE: '30m', TEXT_NUM_CTX: 8192, coordinator, fitMessages, journal, json: () => {}, modelFetchWithTimeout, prints, readBody: async () => ({}), runLedger, storageError: () => {} });
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

// A29: a print question reads Pi Hub's print list through the server's reader (app/pi-hub.js) at ask time.
const hubPrints = (body, status = 200) => createPiHub({ url: 'http://pi.test', timeoutMs: 30, fetchImpl: async () => ({ ok: status === 200, status, json: async () => body }) }).prints;
const now = Date.now() / 1000;
const printList = { as_of: now, prints_available: true, prints: [
  { id: 812, name: 'RIFT tile 10in', status: 'completed', word: 'Finished', started: now - 9000, ended: now - 1000, seconds: 8000, grams: 41.2, error: null },
  { id: 811, name: 'cable_clip', status: 'failed', word: 'Failed', started: now - 20000, ended: now - 19000, seconds: 1000, grams: 2, error: 'Filament ran out' },
  { id: 810, name: 'hinge_test', status: 'cancelled', word: 'Cancelled', started: now - 30000, ended: now - 29500, seconds: 500, grams: 0.4, error: null }
] };

test('a print question with "Use a bigger model" and cloud on: Pi Hub\'s list goes to this PC\'s model inside the marked block, cited to Workshop, and nothing is journaled', async t => {
  const { journal, routes, sent, cloudCalls, storage } = setup(t, { prints: hubPrints(printList), reply: { message: { content: 'RIFT tile 10in finished [1].' } } });
  const count = () => storage.db.prepare('SELECT count(*) AS n FROM journal').get().n;
  const before = count();
  const finished = await routes.startPastWork({ question: 'did my last print finish', bigger: true }).done;
  assert.equal(finished.status, 'completed');
  assert.deepEqual(finished.meta.route, { provider: 'ollama', model: 'qwen3:4b', class: 'private', why: 'Your past work stays on this PC' });
  assert.equal(cloudCalls.length, 0, 'no cloud model was asked');
  assert.equal(sent.length, 1); assert.equal(sent[0].body.model, 'qwen3:4b'); assert.equal(sent[0].body.tools, undefined);
  const user = sent[0].body.messages[1].content, inside = user.slice(user.indexOf(OPEN), user.indexOf(CLOSE));
  for (const name of ['RIFT tile 10in · Finished', 'cable_clip · Failed', 'hinge_test · Cancelled', 'Reason given: Filament ran out']) assert.ok(inside.includes(name), `${name} inside the block`);
  assert.equal(finished.output.from, 'prints');
  assert.deepEqual(finished.output.citations.map(c => [c.id, c.link]), [['print-812', 'hub:workshop']]);
  assert.deepEqual(finished.output.entries.map(e => e.link), ['hub:workshop', 'hub:workshop', 'hub:workshop']);
  assert.equal(count(), before, 'nothing about prints reached the journal (A28 D2)');
  for (const q of ['RIFT', 'cable_clip', 'hinge_test']) assert.equal(journal.search({ q }).items.length, 0, q);
});

test('a print question when Bambuddy or Pi Hub is down, or Pi Hub is off here: the run completes saying which, with no model call', async t => {
  const cases = [
    [hubPrints({ as_of: now, prints_available: false, prints: [] }), "Bambuddy isn't answering, so I can't say what was printed.", "Bambuddy isn't answering"],
    [hubPrints({ error: 'boom' }, 500), "Pi Hub isn't answering, so I can't say what was printed.", "Pi Hub isn't answering"],
    [createPiHub({ url: 'off', fetchImpl: () => assert.fail('off') }).prints, NO_PRINT_READER, "Pi Hub's print list can't be read from here"]
  ];
  for (const [prints, text, unread] of cases) {
    const { routes, sent, storage } = setup(t, { prints });
    const finished = await routes.startPastWork({ question: 'did my last print finish' }).done;
    assert.equal(finished.status, 'completed', text);
    assert.equal(finished.output.text, text);
    assert.equal(finished.output.unread, unread);
    assert.equal(finished.output.from, 'prints');
    assert.equal(sent.length, 0, 'no model claim about prints');
    assert.equal(storage.db.prepare('SELECT count(*) AS n FROM journal').get().n, 0);
  }
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
  // Past work reads prints through Pi Hub's reader (A29), handed only to the journal routes.
  assert.deepEqual(given('prints'), ['journal']);
  assert.match(server, /createJournalRoutes\(\{[^\n]*\bprints: piHub\.prints\b/);
  // The voice and approval recorders get a writer that can only add an entry (app/journal-recorders.js).
  assert.deepEqual(given('journalWriter'), ['notifications', 'powershell', 'voice']);
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
