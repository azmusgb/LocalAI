'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Storage } = require('../app/storage');
const { RunLedger } = require('../app/run-ledger');
const { createJournal } = require('../app/journal');
const { importAll, IMPORT_KEY } = require('../app/journal-import');

function seeded() {
  const storage = new Storage({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'journal-imp-')) });
  const runLedger = new RunLedger({ storage });
  const a = runLedger.create({ type: 'image', title: 'A red fox', input: { prompt: 'A red fox' } });
  runLedger.complete(a.id, { summary: 'Created an image' });
  const b = runLedger.create({ type: 'chat', title: 'Best PETG temp?' });
  runLedger.complete(b.id, { output: { text: '240 °C' } });
  const live = runLedger.create({ type: 'chat', title: 'Still running' });
  runLedger.start(live.id);
  storage.put('conversations', { id: 'chat-1', title: 'Filament', createdAt: '2026-10-10T10:00:00.000Z', messages: [
    { role: 'user', content: 'How dry should PLA be?' }, { role: 'assistant', content: 'Dry it at 45 °C.' },
    { role: 'user', content: 'And PETG?' }, { role: 'assistant', content: '65 °C for 4 hours.' }] });
  storage.put('library', { id: 'lib-1', kind: 'research', title: 'Spool dryers', summary: 'Three dryers compared', createdAt: '2026-10-11T10:00:00.000Z' });
  storage.put('approvals', { id: 'ap-1', title: 'Restart ComfyUI', status: 'approved', createdAt: '2026-10-12T10:00:00.000Z', updatedAt: '2026-10-12T10:05:00.000Z' });
  storage.put('approvals', { id: 'ap-2', title: 'Pending one', status: 'pending', createdAt: '2026-10-12T10:00:00.000Z' });
  storage.put('changes', { id: 'chg-1', title: 'Bigger buttons', summary: 'Touch targets 44 px', status: 'applied', appliedAt: '2026-10-13T10:00:00.000Z' });
  storage.put('activity', { id: 'act-1', type: 'display', title: 'Workshop display paired', detail: 'A new key', at: '2026-10-14T10:00:00.000Z' });
  storage.put('activity', { id: 'act-2', type: 'image', title: 'Created an image', detail: 'dup of a run', at: '2026-10-14T10:00:00.000Z' });
  const journal = createJournal({ db: storage.db });
  return { storage, runLedger, journal, a };
}

test('imports past work once, skipping unfinished runs and duplicate activity', async () => {
  const { storage, runLedger, journal, a } = seeded();
  const first = await importAll({ storage, journal, runLedger });
  assert.deepEqual(first, { added: 8, done: true });
  const kinds = journal.search({ limit: 200 }).items.map(x => `${x.source}:${x.kind}`).sort();
  assert.deepEqual(kinds, ['activity:display', 'approval:approved', 'change:applied', 'chat:chat', 'chat:chat', 'library:research', 'run:chat', 'run:image']);
  assert.equal(journal.search({ q: 'PETG hours' }).items[0].body, '65 °C for 4 hours.');
  assert.equal(journal.search({ q: 'fox' }).items[0].link, `#run/${a.id}`);
  assert.equal(storage.readSetting(IMPORT_KEY, null).done, true);
  assert.deepEqual(await importAll({ storage, journal, runLedger }), { added: 0, done: true });
  storage.close();
});

test('resumes at the stage it reached, and never brings back a deleted entry', async () => {
  const { storage, runLedger, journal } = seeded();
  storage.writeSetting(IMPORT_KEY, { done: false, stage: 'library', offset: 0 });
  assert.equal((await importAll({ storage, journal, runLedger })).added, 4); // library, approval, change, activity
  storage.writeSetting(IMPORT_KEY, { done: false, stage: 'library', offset: 0 });
  const lib = journal.search({ q: 'dryers' }).items[0];
  journal.remove(lib.id);
  assert.equal((await importAll({ storage, journal, runLedger })).added, 0);
  assert.equal(journal.search({ q: 'dryers' }).items.length, 0);
  storage.close();
});

test('pages through large collections, pausing between batches', async () => {
  const { storage, runLedger, journal } = seeded();
  for (let i = 0; i < 5; i++) storage.put('library', { id: `lib-x${i}`, kind: 'note', title: `Note ${i}`, createdAt: '2026-10-01T00:00:00.000Z' });
  let pauses = 0;
  const r = await importAll({ storage, journal, runLedger, batch: 2, pause: async () => { pauses++; } });
  assert.equal(r.added, 13);
  assert.ok(pauses >= 6);
  storage.close();
});

test('a chat that a run already recorded is not imported twice', async () => {
  const { storage, runLedger, journal } = seeded();
  const r = runLedger.create({ type: 'chat', title: 'How dry should PLA be?' });
  runLedger.complete(r.id, { output: { text: 'Dry it at 45 °C.' } });
  const conv = storage.get('conversations', 'chat-1');
  conv.messages[0].createdAt = runLedger.get(r.id).finishedAt;
  storage.put('conversations', conv);
  await importAll({ storage, journal, runLedger });
  assert.equal(journal.search({ q: 'PLA dry' }).items.length, 1);
  storage.close();
});

test('a big chat history never blocks the server for long', async () => {
  const { storage, runLedger, journal } = seeded();
  for (let i = 0; i < 250; i++) { const r = runLedger.create({ type: 'chat', title: `Run question ${i}` }); runLedger.complete(r.id, { output: { text: 'x'.repeat(2000) } }); }
  const now = new Date().toISOString();
  for (let c = 0; c < 100; c++) {
    const messages = [];
    for (let i = 0; i < 50; i++) messages.push({ role: 'user', content: `Chat ${c} turn ${i}`, createdAt: now }, { role: 'assistant', content: 'y'.repeat(500) });
    storage.put('conversations', { id: `big-${c}`, title: `Big ${c}`, createdAt: now, messages });
  }
  let last = Date.now(), worst = 0;
  await importAll({ storage, journal, runLedger, pause: async () => { worst = Math.max(worst, Date.now() - last); await new Promise(r => setImmediate(r)); last = Date.now(); } });
  assert.ok(worst < 400, `blocked ${worst} ms`);
  assert.equal(journal.search({ q: 'turn', limit: 200 }).items.length, 200);
  storage.close();
});

test('a short run title does not hide unrelated chats', async () => {
  const { storage, runLedger, journal } = seeded();
  const r = runLedger.create({ type: 'chat', title: 'hi' });
  runLedger.complete(r.id, { output: { text: 'hello' } });
  const conv = storage.get('conversations', 'chat-1');
  conv.messages[0].content = 'hi there, how dry should PLA be?';
  conv.messages[0].createdAt = runLedger.get(r.id).finishedAt;
  storage.put('conversations', conv);
  await importAll({ storage, journal, runLedger });
  assert.equal(journal.search({ q: 'PLA dry' }).items.length, 1);
  storage.close();
});
