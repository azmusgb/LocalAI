'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { Readable } = require('node:stream');
const { Storage } = require('../app/storage');
const { createResearchStore } = require('../app/research/store');
const { createIntake } = require('../app/research/intake');
const { createTopicManager } = require('../app/research/topics');
const { createBudget } = require('../app/research/budget');
const { createResearchRoutes } = require('../app/server/research');
const { json, readBody, storageError } = require('../app/server/http');

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

// The seven routes (each is guarded in app/signin.js): GET /api/research/state, POST /api/research/pause,
// GET /api/research/sources, POST /api/research/sources, POST /api/research/sources/update,
// POST /api/research/sources/fetch, GET /api/research/documents.
const ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>T</title>
 <entry><id>tag:example.com,2026:a</id><title>Alpha release</title><link href="https://example.com/a"/><updated>2026-11-18T10:00:00Z</updated><summary>Adds things.</summary></entry></feed>`;
const T = Date.parse('2026-11-19T15:00:00Z');

function setup({ enabled = true, script, withBudget = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-routes-'));
  dirs.push(dir);
  const storage = new Storage({ dataDir: dir });
  const store = createResearchStore({ db: storage.db, now: () => T, timeZone: 'UTC' });
  const calls = [];
  const fetcher = { fetchText: async url => { calls.push(url); return script ? script(url) : { ok: true, status: 200, body: ATOM, finalUrl: url, bytes: ATOM.length }; } };
  const intake = createIntake({ store, fetcher, enabled, now: () => T });
  const topics = createTopicManager({ db: storage.db, now: () => T });
  const budget = withBudget ? createBudget({ db: storage.db, store, topics, now: () => T, timeZone: 'UTC' }) : undefined;
  const routes = createResearchRoutes({ budget, intake, json, readBody, store, storageError, topics });
  return { store, intake, routes, calls, storage, topics };
}
const reqOf = body => Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]), { method: 'POST', headers: {} });
function call(handler, body, url = 'http://x/') {
  return new Promise((resolve, reject) => {
    const res = { writeHead(status) { this.status = status; }, end(text) { resolve({ status: this.status, body: text ? JSON.parse(text) : null }); } };
    Promise.resolve(handler(reqOf(body), res, new URL(url))).catch(reject);
  });
}
const FEED = 'https://example.com/feed.atom';

test('GET /api/research/state answers intake.state()', async () => {
  const { routes, intake } = setup();
  const r = await call(routes.apiResearchState);
  assert.equal(r.status, 200); const { budget, reader, ...rest } = r.body; assert.deepEqual(rest, intake.state()); assert.equal(r.body.enabled, true);
  assert.equal(budget.unreadable, true, 'no budget configured is shown as unreadable, never as nothing used');
  assert.equal(reader.unreadable, true, 'no reader configured is shown as unreadable, never as idle');
});

test('POST /api/research/pause sets and clears the pause; a non-boolean is 400', async () => {
  const { routes } = setup();
  const on = await call(routes.apiResearchPause, { paused: true });
  assert.equal(on.status, 200); assert.equal(on.body.paused, true);
  assert.equal((await call(routes.apiResearchPause, { paused: false })).body.paused, false);
  assert.equal((await call(routes.apiResearchPause, { paused: 'yes' })).status, 400);
  assert.equal((await call(routes.apiResearchPause, {})).status, 400);
});

test('POST /api/research/sources adds; GET /api/research/sources lists; a private address is 400 and stores nothing', async () => {
  const { routes, store } = setup();
  const added = await call(routes.apiResearchSourceAdd, { name: 'Example', url: FEED, topics: ['x'] });
  assert.equal(added.status, 200); assert.equal(added.body.source.name, 'Example');
  const bad = await call(routes.apiResearchSourceAdd, { name: 'x', url: 'https://10.0.0.80/f' });
  assert.equal(bad.status, 400); assert.ok(bad.body.error);
  assert.equal(store.listSources().length, 1);
  assert.equal((await call(routes.apiResearchSourceAdd, { name: 'Again', url: FEED })).status, 409);
  const list = await call(routes.apiResearchSources);
  assert.equal(list.status, 200); assert.equal(list.body.enabled, true); assert.equal(list.body.sources.length, 1);
});

test('POST /api/research/sources/update changes a source; an unknown id is 404; a bad value is 400', async () => {
  const { routes } = setup();
  const { body: { source } } = await call(routes.apiResearchSourceAdd, { name: 'Example', url: FEED });
  const ok = await call(routes.apiResearchSourceUpdate, { id: source.id, name: 'Renamed', status: 'paused' });
  assert.equal(ok.status, 200); assert.equal(ok.body.source.name, 'Renamed'); assert.equal(ok.body.source.status, 'paused');
  const none = await call(routes.apiResearchSourceUpdate, { id: 'src-none', name: 'x' });
  assert.equal(none.status, 404); assert.deepEqual(none.body, { error: 'No such source' });
  assert.equal((await call(routes.apiResearchSourceUpdate, { id: source.id, scheduleMinutes: 5 })).status, 400);
});

test('POST /api/research/sources/fetch stores entries; GET /api/research/documents lists them', async () => {
  const { routes, calls } = setup();
  const { body: { source } } = await call(routes.apiResearchSourceAdd, { name: 'Example', url: FEED });
  const f = await call(routes.apiResearchSourceFetch, { id: source.id });
  assert.equal(f.status, 200); assert.equal(f.body.ok, true); assert.equal(f.body.added, 1); assert.equal(calls.length, 1);
  const d = await call(routes.apiResearchDocuments, undefined, 'http://x/api/research/documents?source=' + source.id);
  assert.equal(d.status, 200); assert.equal(d.body.enabled, true); assert.equal(d.body.documents.length, 1);
  assert.equal((await call(routes.apiResearchDocuments, undefined, 'http://x/?q=alpha&limit=5')).body.documents.length, 1);
  assert.equal((await call(routes.apiResearchDocuments, undefined, 'http://x/?q=zzzz')).body.documents.length, 0);
});

test('fetch outcomes map to statuses: paused 409, unknown 404, not active 409, feed failure 502', async () => {
  const { routes, intake } = setup({ script: () => ({ ok: false, reason: 'timed out', code: 'timeout' }) });
  const { body: { source } } = await call(routes.apiResearchSourceAdd, { name: 'Example', url: FEED });
  const bad = await call(routes.apiResearchSourceFetch, { id: source.id });
  assert.equal(bad.status, 502); assert.equal(bad.body.code, 'timeout');
  assert.equal((await call(routes.apiResearchSourceFetch, { id: 'src-none' })).status, 404);
  await call(routes.apiResearchSourceUpdate, { id: source.id, status: 'paused' });
  const idle = await call(routes.apiResearchSourceFetch, { id: source.id });
  assert.equal(idle.status, 409); assert.equal(idle.body.code, 'not_active');
  intake.setPaused(true);
  const p = await call(routes.apiResearchSourceFetch, { id: source.id });
  assert.equal(p.status, 409); assert.equal(p.body.code, 'paused');
});

test('feature off: GETs answer 200 enabled:false with empty lists, POSTs 409, and nothing is fetched', async () => {
  const { routes, store, calls } = setup({ enabled: false });
  const s = store.addSource({ name: 'Example', url: FEED });
  assert.equal((await call(routes.apiResearchState)).body.enabled, false);
  const src = await call(routes.apiResearchSources);
  assert.equal(src.status, 200); assert.deepEqual(src.body, { enabled: false, sources: [] });
  const docs = await call(routes.apiResearchDocuments, undefined, 'http://x/');
  assert.equal(docs.status, 200); assert.deepEqual(docs.body, { enabled: false, documents: [] });
  for (const [h, b] of [[routes.apiResearchPause, { paused: true }], [routes.apiResearchSourceAdd, { name: 'n', url: 'https://example.org/f' }],
    [routes.apiResearchSourceUpdate, { id: s.id, name: 'x' }], [routes.apiResearchSourceFetch, { id: s.id }]]) {
    const r = await call(h, b);
    assert.equal(r.status, 409); assert.deepEqual(r.body, { error: 'research is off' });
  }
  assert.equal(calls.length, 0); assert.equal(store.listSources().length, 1); assert.equal(store.getSource(s.id).name, 'Example');
});

test('an approved field in a request body changes nothing', async () => {
  const { routes } = setup();
  const plain = await call(routes.apiResearchSourceAdd, { name: 'A', url: FEED });
  const withApproved = await call(routes.apiResearchSourceAdd, { name: 'B', url: 'https://example.com/other.atom', approved: true });
  assert.equal(withApproved.status, 200); assert.equal('approved' in withApproved.body.source, false);
  assert.deepEqual(Object.keys(withApproved.body.source), Object.keys(plain.body.source));
  const upd = await call(routes.apiResearchSourceUpdate, { id: plain.body.source.id, approved: true });
  assert.equal(upd.status, 200); assert.equal('approved' in upd.body.source, false);
  assert.equal((await call(routes.apiResearchPause, { paused: true, approved: true })).status, 200);
});

test('a store that throws is an error status, never an empty list', async () => {
  const { routes, store } = setup();
  store.listSources = () => { throw new Error('database is locked'); };
  const r = await call(routes.apiResearchSources);
  assert.equal(r.status, 503); assert.equal('sources' in r.body, false); assert.match(r.body.error, /could not be read/);
  const s = await call(routes.apiResearchState);
  assert.equal(s.status, 503); assert.equal('enabled' in s.body, false, 'an unreadable state is not shown as off');
  assert.equal((await call(routes.apiResearchSourceAdd, { name: 'n', url: 'https://example.org/f' })).status, 503);
  const { routes: r2, store: st2 } = setup();
  st2.listDocuments = () => { throw new Error('disk I/O error'); };
  const d = await call(r2.apiResearchDocuments, undefined, 'http://x/');
  assert.equal(d.status, 500); assert.equal('documents' in d.body, false);
});

const POSTS = [['apiResearchPause', { paused: true }], ['apiResearchSourceAdd', { name: 'n', url: 'https://example.org/f' }],
  ['apiResearchSourceUpdate', { id: 'x' }], ['apiResearchSourceFetch', { id: 'x' }]];

test('a body that is not valid JSON is 400 on every POST route; too large stays 413', async () => {
  const { routes } = setup();
  for (const [name] of POSTS) {
    const r = await call(routes[name], '{"name": ');
    assert.equal(r.status, 400, name); assert.ok(r.body.error, name);
  }
  const big = await call(routes.apiResearchPause, JSON.stringify({ paused: true, pad: 'x'.repeat(20 * 1024) }));
  assert.equal(big.status, 413);
});

test('feature off: a malformed body on a POST is still 409 research is off', async () => {
  const { routes, calls } = setup({ enabled: false });
  for (const [name] of POSTS) {
    const r = await call(routes[name], '{"name": ');
    assert.equal(r.status, 409, name); assert.deepEqual(r.body, { error: 'research is off' }, name);
  }
  assert.equal(calls.length, 0);
});

test('a document cursor that no longer exists is 410 cursor expired', async () => {
  const { routes } = setup();
  const r = await call(routes.apiResearchDocuments, undefined, 'http://x/?before=doc-gone');
  assert.equal(r.status, 410); assert.deepEqual(r.body, { error: 'cursor expired' });
});

test('fetch codes error and record_failed are 503; a feed failure stays 502', async () => {
  const { routes, store, intake } = setup();
  const { body: { source } } = await call(routes.apiResearchSourceAdd, { name: 'Example', url: FEED });
  // record_failed: the store refuses to write the fetch row.
  const real = store.recordFetch;
  store.recordFetch = () => { throw new Error('database is locked'); };
  const rec = await call(routes.apiResearchSourceFetch, { id: source.id });
  assert.equal(rec.status, 503); assert.equal(rec.body.code, 'record_failed');
  store.recordFetch = real;
  // error: the source lookup throws inside fetchSource (the intake still reads state fine).
  const { routes: r2, store: s2 } = setup();
  const { body: { source: src2 } } = await call(r2.apiResearchSourceAdd, { name: 'Example', url: FEED });
  s2.getSource = () => { throw new Error('disk I/O error'); };
  const err = await call(r2.apiResearchSourceFetch, { id: src2.id });
  assert.equal(err.status, 503); assert.equal(err.body.code, 'error');
  assert.equal(intake.state().unreadable, false);
});

test('an unreadable state is flagged by unreadable:true and answered 503 by the flag, not by wording', async () => {
  const { routes, intake, store } = setup();
  store.listSources = () => { throw new Error('boom'); };
  assert.equal(intake.state().unreadable, true);
  const r = await call(routes.apiResearchState);
  assert.equal(r.status, 503);
});

test('GET /api/research/state carries every model budget cap; a failed read is unreadable, not zero used', async () => {
  const { routes, storage, topics } = setup({ withBudget: true });
  let r = await call(routes.apiResearchState);
  assert.equal(r.status, 200); assert.equal(r.body.budget.unreadable, false);
  const day = r.body.budget.caps.find(c => c.name === 'day.calls');
  assert.deepEqual([day.limit, day.used], [20, 0]); assert.ok(Date.parse(day.resetsAt) > T);
  storage.db.exec('DROP TABLE research_events');
  r = await call(routes.apiResearchState);
  assert.equal(r.status, 200); assert.equal(r.body.budget.unreadable, true); assert.deepEqual(r.body.budget.caps, []);
  void topics;
});
