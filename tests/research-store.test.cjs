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
  for (let i = 0; i < 60; i++) store.recordFetch(s.id, { ok: true, status: 200 });
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
