'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { Storage } = require('../app/storage');
const { createResearchStore } = require('../app/research/store');

let T = Date.parse('2026-11-19T15:00:00Z');
const MIN = 60000;
function open() {
  const storage = new Storage({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'research-')) });
  return { storage, store: createResearchStore({ db: storage.db, now: () => T, timeZone: 'America/New_York' }) };
}
const src = (store, over = {}) => store.addSource({ name: 'SQLite', url: 'https://example.com/feed.atom', ...over });
const e = (id, title = 'T', text = 'body') => ({ id, url: 'https://example.com/' + id, title, text, published: '2026-11-18T10:00:00.000Z' });
const iso = ms => new Date(ms).toISOString();
const count = (storage, table) => storage.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;

test('addSource returns an active source with defaults', () => {
  T = Date.parse('2026-11-19T15:00:00Z');
  const { store } = open();
  const s = src(store);
  assert.match(s.id, /^src-[0-9a-f]{12}$/);
  assert.equal(s.status, 'active');
  assert.equal(s.host, 'example.com');
  assert.equal(s.scheduleMinutes, 360);
  assert.equal(s.failures, 0);
  assert.equal(s.documents, 0);
  assert.equal(s.nextDueAt, '');
});

test('addSource rejects bad input with 400 and a duplicate URL with 409', () => {
  const { store } = open();
  for (const over of [{ name: '' }, { url: 'http://example.com/f' }, { url: 'https://10.0.0.80/f' }, { kind: 'page' },
    { trust: 'gospel' }, { scheduleMinutes: 59 }, { scheduleMinutes: 10081 }]) {
    assert.throws(() => src(store, over), err => err.status === 400, JSON.stringify(over));
  }
  src(store);
  assert.throws(() => src(store), err => err.status === 409);
});

test('saveEntries adds, then ignores unchanged entries', () => {
  const { storage, store } = open();
  const s = src(store);
  assert.deepEqual(store.saveEntries(s.id, [e('a'), e('b')]), { added: 2, revised: 0 });
  assert.deepEqual(store.saveEntries(s.id, [e('a'), e('b')]), { added: 0, revised: 0 });
  assert.equal(count(storage, 'research_documents'), 2);
});

test('a changed entry becomes a new revision and listDocuments shows only the latest', () => {
  const { store } = open();
  const s = src(store);
  store.saveEntries(s.id, [e('a'), e('b')]);
  assert.deepEqual(store.saveEntries(s.id, [e('a', 'T', 'changed')]), { added: 0, revised: 1 });
  const docs = store.listDocuments({ sourceId: s.id });
  assert.equal(docs.length, 2);
  const a = docs.find(d => d.ref === `${s.id}:a`);
  assert.equal(a.revision, 2);
  assert.equal(a.text, 'changed');
});

test('saved text is redacted and clamped', () => {
  const { store } = open();
  const s = src(store);
  const key = 'sk-ant-abcdefghijklmnopqrstuvwxyz0123456789';
  store.saveEntries(s.id, [e('k', 'T', `token ${key} end`), e('t', 'x'.repeat(400)), e('l', 'T', 'y'.repeat(30000))]);
  const docs = store.listDocuments({ sourceId: s.id });
  const by = id => docs.find(d => d.ref === `${s.id}:${id}`);
  assert.ok(!by('k').text.includes(key));
  assert.equal(by('t').title.length, 300);
  assert.equal(by('l').text.length, 20000);
});

test('listDocuments searches with FTS and survives hostile queries', () => {
  const { store } = open();
  const s = src(store);
  store.saveEntries(s.id, [e('a'), e('b')]);
  store.saveEntries(s.id, [e('a', 'T', 'changed')]);
  const hits = store.listDocuments({ q: 'changed' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].revision, 2);
  assert.deepEqual(store.listDocuments({ q: 'nomatch' }), []);
  assert.deepEqual(store.listDocuments({ q: '"' }), []);
});

test('a successful fetch schedules the next one', () => {
  T = Date.parse('2026-11-19T15:00:00Z');
  const { store } = open();
  const s = src(store);
  const r = store.recordFetch(s.id, { ok: true, status: 200, added: 2 });
  assert.equal(r.failures, 0);
  assert.equal(r.lastOkAt, iso(T));
  assert.equal(r.nextDueAt, iso(T + 360 * MIN));
  assert.deepEqual(store.dueSources(10), []);
  T += 361 * MIN;
  assert.equal(store.dueSources(10).length, 1);
});

test('failures back off, never move lastOkAt, and quarantine at five', () => {
  T = Date.parse('2026-11-19T15:00:00Z');
  const { store } = open();
  const s = src(store);
  const okAt = iso(T);
  store.recordFetch(s.id, { ok: true, status: 200 });
  T += 400 * MIN;
  const fail = () => store.recordFetch(s.id, { ok: false, reason: 'HTTP 503', code: 'http_status' });
  let r = fail();
  assert.equal(r.failures, 1);
  assert.equal(r.lastError, 'HTTP 503');
  assert.equal(r.nextDueAt, iso(T + 720 * MIN));
  assert.equal(r.lastOkAt, okAt);
  fail(); fail();
  r = fail();
  assert.equal(r.nextDueAt, iso(T + 1440 * MIN));
  assert.equal(r.status, 'active');
  r = fail();
  assert.equal(r.status, 'quarantined');
  assert.equal(r.lastOkAt, okAt);
  T += 100 * 24 * 60 * MIN;
  assert.deepEqual(store.dueSources(10), []);
});

test('setting a quarantined source active clears failures and the due time', () => {
  const { store } = open();
  const s = src(store);
  for (let i = 0; i < 5; i++) store.recordFetch(s.id, { ok: false, reason: 'x', code: 'c' });
  assert.equal(store.getSource(s.id).status, 'quarantined');
  const r = store.updateSource(s.id, { status: 'active' });
  assert.equal(r.status, 'active');
  assert.equal(r.failures, 0);
  assert.equal(r.nextDueAt, '');
  assert.throws(() => store.updateSource(s.id, { status: 'quarantined' }), err => err.status === 400);
  assert.equal(store.updateSource('src-nope', { name: 'x' }), null);
});

test('changing the URL updates the host and keeps saved documents', () => {
  const { store } = open();
  const s = src(store);
  store.saveEntries(s.id, [e('a')]);
  const r = store.updateSource(s.id, { url: 'https://other.example.org/feed' });
  assert.equal(r.host, 'other.example.org');
  assert.equal(store.listDocuments({ sourceId: s.id })[0].url, 'https://example.com/a');
});

test('retention keeps 2,000 documents (and their FTS rows) and 50 fetch rows', () => {
  const { storage, store } = open();
  const s = src(store);
  const title = i => `docq${String(i).padStart(5, '0')}`;
  const all = Array.from({ length: 2005 }, (_, i) => e('e' + i, title(i), 'body'));
  store.saveEntries(s.id, all.slice(0, 1000));
  store.saveEntries(s.id, all.slice(1000));
  assert.equal(count(storage, 'research_documents'), 2000);
  for (let i = 0; i < 5; i++) assert.deepEqual(store.listDocuments({ q: title(i) }), []);
  assert.equal(store.listDocuments({ q: title(2004) }).length, 1);
  T = Date.parse('2026-11-19T15:00:00Z');
  for (let i = 0; i < 30; i++) store.recordFetch(s.id, { ok: true, status: 200 });
  T += 24 * 60 * MIN; // rows of today are never trimmed, so spread the 60 over two days
  for (let i = 0; i < 30; i++) store.recordFetch(s.id, { ok: true, status: 200 });
  assert.equal(count(storage, 'research_fetches'), 50);
  assert.equal(store.listFetches(s.id, 500).length, 50);
});

test('fetchesToday counts only the current local day', () => {
  T = Date.parse('2026-11-19T15:00:00Z');
  const { store } = open();
  const s = src(store);
  store.recordFetch(s.id, { ok: true, status: 200 });
  store.recordFetch(s.id, { ok: true, status: 200 });
  T += 24 * 60 * MIN;
  store.recordFetch(s.id, { ok: true, status: 200 });
  assert.equal(store.fetchesToday(), 1);
});

test('meta stores strings and reports missing keys as null', () => {
  const { store } = open();
  store.setMeta('paused', '1');
  assert.equal(store.getMeta('paused'), '1');
  assert.equal(store.getMeta('missing'), null);
});

test('a second store on the same database sees the same sources', () => {
  const { storage, store } = open();
  const s = src(store);
  const again = createResearchStore({ db: storage.db, now: () => T, timeZone: 'America/New_York' });
  assert.deepEqual(again.listSources().map(x => x.id), [s.id]);
});

test('the daily fetch count survives trimming', () => {
  T = Date.parse('2026-11-19T15:00:00Z');
  const { storage, store } = open();
  const s = src(store);
  for (let i = 0; i < 60; i++) store.recordFetch(s.id, { ok: true, status: 200 });
  assert.equal(store.fetchesToday(), 60);
  T += 24 * 60 * MIN;
  store.recordFetch(s.id, { ok: true, status: 200 });
  assert.equal(storage.db.prepare('SELECT count(*) AS n FROM research_fetches WHERE source_id = ?').get(s.id).n, 50);
  assert.equal(store.fetchesToday(), 1);
});

test('leaving quarantine through paused still resets failures and the due time', () => {
  const { store } = open();
  const s = src(store);
  for (let i = 0; i < 5; i++) store.recordFetch(s.id, { ok: false, reason: 'x', code: 'c' });
  let r = store.updateSource(s.id, { status: 'paused' });
  assert.equal(r.status, 'paused');
  assert.equal(r.failures, 5);
  r = store.updateSource(s.id, { status: 'active' });
  assert.equal(r.status, 'active');
  assert.equal(r.failures, 0);
  assert.equal(r.nextDueAt, '');
  const q = src(store, { url: 'https://example.com/other.atom' });
  for (let i = 0; i < 5; i++) store.recordFetch(q.id, { ok: false, reason: 'x', code: 'c' });
  assert.equal(store.updateSource(q.id, { status: 'retired' }).failures, 5);
});

test('listDocuments pages with a cursor and an unknown cursor gives nothing', () => {
  const { store } = open();
  const s = src(store);
  store.saveEntries(s.id, Array.from({ length: 5 }, (_, i) => e('p' + i)));
  const one = store.listDocuments({ sourceId: s.id, limit: 3 });
  const two = store.listDocuments({ sourceId: s.id, limit: 3, before: one[2].id });
  assert.deepEqual(one.map(d => d.ref.split(':')[1]), ['p4', 'p3', 'p2']);
  assert.deepEqual(two.map(d => d.ref.split(':')[1]), ['p1', 'p0']);
  assert.deepEqual(store.listDocuments({ sourceId: s.id, before: 'doc-000000000000' }), []);
});

test('search does not match a superseded revision', () => {
  const { store } = open();
  const s = src(store);
  store.saveEntries(s.id, [e('a', 'T', 'oldwording')]);
  store.saveEntries(s.id, [e('a', 'T', 'newwording')]);
  assert.deepEqual(store.listDocuments({ q: 'oldwording' }), []);
  assert.equal(store.listDocuments({ q: 'newwording' }).length, 1);
});

test('the same id twice in one batch', () => {
  const { storage, store } = open();
  const s = src(store);
  assert.deepEqual(store.saveEntries(s.id, [e('a'), e('a')]), { added: 1, revised: 0 });
  assert.deepEqual(store.saveEntries(s.id, [e('b', 'T', 'one'), e('b', 'T', 'two')]), { added: 1, revised: 1 });
  assert.equal(count(storage, 'research_documents'), 3);
});

test('a throw part-way through saveEntries leaves nothing from the batch', () => {
  const { storage, store } = open();
  const s = src(store);
  const bad = { id: 'bad', url: 'https://example.com/bad', get title() { throw new Error('boom'); }, text: 'x', published: '' };
  assert.throws(() => store.saveEntries(s.id, [e('a'), e('b'), bad]), /boom/);
  assert.equal(count(storage, 'research_documents'), 0);
  assert.equal(store.listDocuments({ q: 'body' }).length, 0);
  assert.deepEqual(store.saveEntries(s.id, [e('a')]), { added: 1, revised: 0 });
});

test('listDocuments clamps the limit to 1..200', () => {
  const { store } = open();
  const s = src(store);
  store.saveEntries(s.id, Array.from({ length: 250 }, (_, i) => e('l' + i)));
  assert.equal(store.listDocuments({ limit: 0 }).length, 1);
  assert.equal(store.listDocuments({ limit: 999 }).length, 200);
});

test('a failed fetch leaves documents and lastOkAt alone', () => {
  T = Date.parse('2026-11-19T15:00:00Z');
  const { storage, store } = open();
  const s = src(store);
  store.saveEntries(s.id, [e('a'), e('b')]);
  const ok = store.recordFetch(s.id, { ok: true, status: 200 });
  T += 400 * MIN;
  const r = store.recordFetch(s.id, { ok: false, reason: 'boom', code: 'net' });
  assert.equal(count(storage, 'research_documents'), 2);
  assert.equal(r.lastOkAt, ok.lastOkAt);
  assert.equal(r.documents, 2);
});

test('fetch code and document published are clamped to 40 characters', () => {
  const { store } = open();
  const s = src(store);
  store.recordFetch(s.id, { ok: false, reason: 'x', code: 'c'.repeat(100) });
  assert.equal(store.listFetches(s.id)[0].code.length, 40);
  store.saveEntries(s.id, [{ ...e('a'), published: 'p'.repeat(100) }]);
  assert.equal(store.listDocuments({ sourceId: s.id })[0].published.length, 40);
});
