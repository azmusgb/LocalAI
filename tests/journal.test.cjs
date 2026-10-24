'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Storage } = require('../app/storage');
const { createJournal, redact, ftsQuery } = require('../app/journal');

const NOW = Date.parse('2026-10-23T15:00:00Z'); // a Friday, 11:00 in New York
function open(now = () => NOW) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-'));
  const storage = new Storage({ dataDir: dir });
  const journal = createJournal({ db: storage.db, now, timeZone: 'America/New_York' });
  return { dir, storage, journal };
}
const entry = (over = {}) => ({ at: '2026-10-22T18:00:00.000Z', source: 'run', kind: 'chat', title: 'A question', body: '', ref: 'run:x:completed', ...over });

test('record stores once per ref', () => {
  const { journal, storage } = open();
  const first = journal.record(entry({ body: 'PETG bracket' }));
  assert.match(first.id, /^j-/);
  assert.equal(journal.record(entry({ body: 'again' })), null);
  assert.equal(storage.db.prepare('SELECT count(*) AS n FROM journal').get().n, 1);
  assert.equal(journal.get(first.id).day, '2026-10-22');
  storage.close();
});

test('search matches words and their forms, newest first on equal matches', () => {
  const { journal, storage } = open();
  journal.record(entry({ ref: 'a', at: '2026-10-01T12:00:00.000Z', body: 'Printed a PETG bracket' }));
  journal.record(entry({ ref: 'b', at: '2026-10-20T12:00:00.000Z', body: 'Printed a PETG bracket' }));
  journal.record(entry({ ref: 'c', body: 'Nothing to see' }));
  const { items } = journal.search({ q: 'brackets' });
  assert.deepEqual(items.map(x => x.at.slice(0, 10)), ['2026-10-20', '2026-10-01']);
  storage.close();
});

test('search treats FTS syntax as plain words', () => {
  const { journal, storage } = open();
  journal.record(entry({ body: 'near the star' }));
  for (const q of ['"NEAR( * -x: (', 'star"', 'AND OR NOT', '***', '']) {
    assert.doesNotThrow(() => journal.search({ q }), q);
  }
  assert.equal(journal.search({ q: 'NEAR(star' }).items.length, 1);
  storage.close();
});

test('without a query, search lists by time with a cursor', () => {
  const { journal, storage } = open();
  for (let i = 0; i < 5; i++) journal.record(entry({ ref: `r${i}`, at: `2026-10-2${i}T12:00:00.000Z` }));
  const page = journal.search({ limit: 2 });
  assert.deepEqual(page.items.map(x => x.day), ['2026-10-24', '2026-10-23']);
  const next = journal.search({ limit: 2, before: page.next });
  assert.deepEqual(next.items.map(x => x.day), ['2026-10-22', '2026-10-21']);
  assert.deepEqual(journal.search({ sources: ['print'] }).items, []);
  storage.close();
});

test('remove deletes and keeps a tombstone', () => {
  const { journal, storage } = open();
  const { id } = journal.record(entry({ body: 'secret plans' }));
  assert.equal(journal.remove(id), true);
  assert.equal(journal.remove(id), false);
  assert.equal(journal.search({ q: 'plans' }).items.length, 0);
  assert.equal(journal.record(entry({ body: 'secret plans' })), null);
  storage.close();
});

test('redact hides secrets, and record redacts and cuts to size', () => {
  const hex = 'a'.repeat(40);
  const out = redact(`token=abc123 and ${hex} Bearer xyz.987 -----BEGIN OPENSSH PRIVATE KEY-----\nzzz\n-----END OPENSSH PRIVATE KEY-----`);
  assert.doesNotMatch(out, /abc123|aaaaaaaaaa|xyz\.987|zzz/);
  assert.ok(out.split('[redacted]').length - 1 >= 4);
  const { journal, storage } = open();
  const { id } = journal.record(entry({ title: 'x'.repeat(300), body: `password: hunter2 ${'y'.repeat(5000)}` }));
  const item = journal.get(id);
  assert.equal(item.title.length, 200);
  assert.equal(item.body.length, 4000);
  assert.doesNotMatch(item.body, /hunter2/);
  storage.close();
});

test('redact covers JSON, prefixed names and well-known token shapes', () => {
  const cases = [
    '{"apiKey": "s3cr3tvalue"}', "{'client_secret':'s3cr3tvalue'}", 'OPENAI_API_KEY=s3cr3tvalue', 'X-Auth-Token: s3cr3tvalue',
    'ghp_s3cr3tvalue0123456789', 'sk-s3cr3tvalue0123456789', 'xoxb-1234-s3cr3tvalue', 'AKIAS3CR3TVALUE12345',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.s3cr3tvalue_sig'
  ];
  for (const c of cases) assert.doesNotMatch(redact(c), /s3cr3tvalue|S3CR3TVALUE/, c);
  assert.equal(redact('the key to a good print is a clean bed'), 'the key to a good print is a clean bed');
});

test('redact stays fast on long input', () => {
  const t = Date.now();
  redact('x'.repeat(200000));
  redact('a-'.repeat(100000));
  assert.ok(Date.now() - t < 300, `took ${Date.now() - t} ms`);
});

test('ftsQuery quotes words and prefixes the last', () => {
  assert.equal(ftsQuery('What did I print, brack'), '"print" "brack"*');
  assert.equal(ftsQuery('the a of'), '');
});

test('date words become a window in the local time zone', () => {
  const { journal, storage } = open();
  const w = journal.window('what did I print yesterday');
  assert.equal(w.from, '2026-10-22T04:00:00.000Z');
  assert.equal(w.to, '2026-10-23T04:00:00.000Z');
  assert.equal(w.rest, 'what did I print');
  assert.equal(journal.window('anything today').from, '2026-10-23T04:00:00.000Z');
  const week = journal.window('films last week');
  assert.equal(week.from, '2026-10-12T04:00:00.000Z'); // Monday 12 Oct
  assert.equal(week.to, '2026-10-19T04:00:00.000Z');
  const sat = journal.window('what did I watch on Saturday');
  assert.equal(sat.from, '2026-10-17T04:00:00.000Z');
  assert.equal(sat.rest, 'what did I watch');
  assert.equal(journal.window('prints in October').from, '2026-10-01T04:00:00.000Z');
  assert.equal(journal.window('prints in October').to, '2026-11-01T04:00:00.000Z');
  assert.equal(journal.window('this month').from, '2026-10-01T04:00:00.000Z');
  assert.deepEqual(journal.window('plain words'), { from: null, to: null, rest: 'plain words' });
  storage.close();
});

test('an unchanged Storage still opens a database that has journal tables (rollback)', () => {
  const { dir, journal, storage } = open();
  journal.record(entry());
  storage.close();
  const again = new Storage({ dataDir: dir });
  assert.equal(again.check(), true);
  assert.equal(again.status().schemaVersion, 1);
  again.close();
});
