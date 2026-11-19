'use strict';

// The voice, approval and display-approval handlers write their journal entries (app/journal-recorders.js), and a
// journal that fails never breaks them: the answer is still spoken, the decision still saved, and nothing is recorded.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Storage } = require('../app/storage');
const { createJournal } = require('../app/journal');
const voice = require('../app/voice');
const { createVoice } = require('../app/server/voice');
const { createNotifications } = require('../app/server/notifications');

const fresh = t => {
  const storage = new Storage({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'journal-wire-')) });
  t.after(() => storage.close());
  return { storage, journal: createJournal({ db: storage.db }) };
};
const broken = () => { const calls = []; return { calls, record(e) { calls.push(e); throw new Error('disk I/O error'); } }; };
const reply = () => { const out = {}; return { out, res: {}, json: (res, status, body) => Object.assign(out, { status, body }), text: (res, status, value) => Object.assign(out, { status, body: value }) }; };

// Only what these handlers touch; anything else they reach for fails the test loudly.
function voiceCtx({ journal, approvals = [], chatOnce, startPastWork }) {
  const r = reply();
  const store = { items: approvals };
  const ctx = {
    APPROVALS_STORE: 'approvals', voice, journalWriter: journal, clockNow: () => Date.parse('2026-11-19T15:04:00.000Z'), text: r.text, json: r.json,
    readBody: async req => req.body, voiceFacts: () => 'Today is Thursday, November 19, 2026. It is 3:04 in the afternoon.',
    chatOnce: chatOnce || (async () => { throw new Error('no model in this test'); }), startPastWork,
    storage: { readSetting: () => null }, approvalStore: () => store.items, saveStore: (name, items) => { store.items = items; },
    recordActivity: () => {}, nowIso: () => '2026-11-19T15:04:00.000Z', storageError: (res, e) => { throw e; }
  };
  return { ...r, store, api: createVoice(ctx) };
}
const ask = async (v, q) => { await v.api.apiGlanceAsk({ method: 'GET' }, v.res, new URL(`http://localhost/api/glance/ask?q=${encodeURIComponent(q)}`)); return v.out; };

test('a spoken answer with no run is journaled once as a voice entry', async t => {
  const { journal } = fresh(t);
  const v = voiceCtx({ journal });
  const out = await ask(v, 'what time is it');
  assert.equal(out.status, 200);
  assert.match(out.body, /3:04 in the afternoon/);
  const items = journal.search({ sources: ['voice'] }).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'time');
  assert.equal(items[0].title, 'what time is it');
  assert.equal(items[0].body, out.body, 'the answer as spoken');
});

test('a voice answer a run gave is left to the run recorder, not written twice', async t => {
  const { journal } = fresh(t);
  const v = voiceCtx({ journal, chatOnce: async () => ({ runId: 'run-7', message: { content: 'It is a journal mode.' } }) });
  assert.equal(voice.classify('explain WAL mode').intent, 'chat');
  const out = await ask(v, 'explain WAL mode');
  assert.equal(out.body, 'It is a journal mode.');
  assert.equal(journal.search({}).items.length, 0);
});

test('a Past work voice answer records nothing (A28 D5)', async t => {
  const { journal } = fresh(t);
  const startPastWork = () => ({ run: { id: 'run-h' }, done: Promise.resolve({ status: 'completed', output: { text: 'You asked about PETG [1].' } }) });
  const v = voiceCtx({ journal, startPastWork });
  assert.equal(voice.classify('what did I ask about yesterday').intent, 'history');
  const out = await ask(v, 'what did I ask about yesterday');
  assert.equal(out.status, 200);
  assert.equal(out.body, 'You asked about PETG.');
  assert.equal(journal.search({}).items.length, 0);
});

test('voice still answers when the journal fails, and nothing reads as recorded', async t => {
  const j = broken();
  const v = voiceCtx({ journal: j });
  const out = await ask(v, 'what time is it');
  assert.equal(out.status, 200);
  assert.match(out.body, /3:04 in the afternoon/);
  assert.equal(j.calls.length, 1, 'it was tried');
});

const pending = (over = {}) => ({ id: 'appr-1', title: 'Agent action approval', detail: 'Tidy the downloads folder', risk: 'low', status: 'pending', createdAt: '2026-11-19T14:00:00.000Z', updatedAt: '2026-11-19T14:00:00.000Z', meta: {}, ...over });

function approvalsCtx({ journal, approvals }) {
  const r = reply();
  const store = { items: approvals };
  const api = createNotifications({
    APPROVALS_STORE: 'approvals', NOTIFICATIONS_STORE: 'notifications', journalWriter: journal, json: r.json, readBody: async req => req.body,
    requireFeature: () => true, objectStore: () => store.items, saveStore: (name, items) => { store.items = items; },
    recordActivity: () => {}, nowIso: () => '2026-11-19T15:04:00.000Z', storageError: (res, e) => { throw e; },
    changeStore: () => [], decideChange: () => { throw new Error('no change in this test'); }
  });
  return { ...r, store, api };
}
const decide = async (a, body) => { await a.api.apiApprovalDecide({ body }, a.res); return a.out; };

test('an approval decided in the app is journaled once, however often it is decided', async t => {
  const { journal } = fresh(t);
  const a = approvalsCtx({ journal, approvals: [pending()] });
  assert.equal((await decide(a, { id: 'appr-1', decision: 'approved' })).status, 200);
  assert.equal((await decide(a, { id: 'appr-1', decision: 'approved' })).status, 200);
  const items = journal.search({ sources: ['approval'] }).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'approved');
  assert.equal(items[0].title, 'Agent action approval');
  assert.match(items[0].body, /^Approved in Local AI\.\nTidy the downloads folder$/);
});

test('an approval is still decided when the journal fails', async t => {
  const j = broken();
  const a = approvalsCtx({ journal: j, approvals: [pending()] });
  const out = await decide(a, { id: 'appr-1', decision: 'rejected' });
  assert.equal(out.status, 200);
  assert.equal(out.body.item.status, 'rejected');
  assert.equal(a.store.items[0].status, 'rejected', 'saved');
  assert.equal(j.calls.length, 1);
});

test('an approval decided on the Workshop display is journaled as the display\'s', async t => {
  const { journal } = fresh(t);
  const v = voiceCtx({ journal, approvals: [pending()] });
  await v.api.apiDisplayApprovalDecide({ body: { id: 'appr-1', decision: 'approved' } }, v.res);
  assert.equal(v.out.status, 200);
  const items = journal.search({ sources: ['approval'] }).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].body, 'Approved on the Workshop display.\nTidy the downloads folder');
});

test('the display still decides when the journal fails', async t => {
  const j = broken();
  const v = voiceCtx({ journal: j, approvals: [pending()] });
  await v.api.apiDisplayApprovalDecide({ body: { id: 'appr-1', decision: 'approved' } }, v.res);
  assert.equal(v.out.status, 200);
  assert.equal(v.store.items[0].status, 'approved');
  assert.equal(j.calls.length, 1);
});
