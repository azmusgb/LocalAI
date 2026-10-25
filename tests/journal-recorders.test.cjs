'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Storage } = require('../app/storage');
const { createJournal } = require('../app/journal');
const { runEntry, runText } = require('../app/journal-recorders');

const run = (over = {}) => ({ id: 'run-1', type: 'chat', title: 'Which filament for a bracket?', status: 'completed', createdAt: '2026-10-22T18:00:00.000Z', finishedAt: '2026-10-22T18:01:00.000Z', summary: 'short', input: { prompt: 'Which filament for a bracket?' }, output: { text: 'PETG is a good choice.' }, error: null, meta: {}, ...over });

test('a completed run becomes one entry linking back to it', () => {
  assert.deepEqual(runEntry(run()), {
    at: '2026-10-22T18:01:00.000Z', source: 'run', kind: 'chat', title: 'Which filament for a bracket?',
    body: 'PETG is a good choice.', link: '#run/run-1', ref: 'run:run-1:completed', meta: { status: 'completed', type: 'chat' }
  });
});

test('failed runs keep the error; unfinished runs are not recorded', () => {
  assert.equal(runEntry(run({ status: 'failed', output: null, error: 'Model timed out' })).body, 'Model timed out');
  assert.equal(runEntry(run({ status: 'failed' })).ref, 'run:run-1:failed');
  for (const status of ['queued', 'running', 'streaming', 'awaiting_approval']) assert.equal(runEntry(run({ status })), null);
  assert.equal(runEntry(null), null);
});

test('PowerShell runs are recorded by title only', () => {
  assert.equal(runEntry(run({ type: 'powershell' })).body, '');
  assert.equal(runEntry(run({ meta: { powershell: true } })).body, '');
});

test('runText reads the result in order of preference', () => {
  assert.equal(runText({ output: 'plain' }), 'plain');
  assert.equal(runText({ output: { answer: 'A' } }), 'A');
  assert.equal(runText({ output: { outcome: 'complete' }, summary: 'Mission done' }), 'Mission done');
  assert.equal(runText({ output: { outcome: 'complete' } }), 'complete');
  assert.equal(runText({ output: null, summary: 'Created 2 images' }), 'Created 2 images');
  assert.equal(runText({ output: { images: [] }, summary: 'S', input: { prompt: 'a red fox' } }), 'S\nAsked: a red fox');
});

test('a run that completes twice is recorded once', () => {
  const storage = new Storage({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'journal-rec-')) });
  const journal = createJournal({ db: storage.db });
  journal.record(runEntry(run()));
  journal.record(runEntry(run({ output: { text: 'Rewritten answer' } })));
  assert.equal(journal.search({}).items.length, 1);
  assert.equal(journal.search({}).items[0].body, 'PETG is a good choice.');
  storage.close();
});
