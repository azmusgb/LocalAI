'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { Storage } = require('../app/storage');
const { createResearchStore } = require('../app/research/store');
const { createIntake } = require('../app/research/intake');

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Example releases</title>
 <entry><id>tag:example.com,2026:v2</id><title>v2.0</title><link href="/releases/v2"/>
  <updated>2026-11-18T10:00:00Z</updated><content type="html">&lt;p&gt;Adds fts5.&lt;/p&gt;</content></entry>
 <entry><id>tag:example.com,2026:v1</id><title>v1.9</title><link href="https://example.com/releases/v1.9"/>
  <updated>2026-10-01T00:00:00Z</updated><summary>Fixes.</summary></entry>
</feed>`;
const MIN = 60000, HOUR = 60 * MIN;
let T = Date.parse('2026-11-19T15:00:00Z');

function setup(opts = {}, script = () => ({ ok: true, status: 200, body: ATOM, etag: '"e1"', lastModified: 'LM1', finalUrl: 'https://example.com/feed.atom', bytes: ATOM.length })) {
  T = Date.parse('2026-11-19T15:00:00Z');
  const storage = new Storage({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'intake-')) });
  const store = createResearchStore({ db: storage.db, now: () => T, timeZone: 'America/New_York' });
  const calls = [];
  const ctl = { script };
  const fetcher = { fetchText: async (url, o) => { calls.push({ url, o }); return ctl.script(url, calls.length); } };
  const intake = createIntake({ store, fetcher, enabled: true, now: () => T, ...opts });
  return { storage, store, calls, ctl, fetcher, intake };
}
const add = (store, n = 0, over = {}) => store.addSource({ name: `S${n}`, url: `https://example.com/feed${n}.atom`, ...over });
const docs = (store, id) => store.listDocuments({ sourceId: id });

test('off: no fetcher call ever', async () => {
  const { store, calls, intake } = setup({ enabled: false });
  const s = add(store);
  assert.deepEqual(await intake.tick(), { ran: 0, skipped: 'off' });
  const r = await intake.fetchSource(s.id);
  assert.equal(r.ok, false); assert.equal(r.code, 'off');
  assert.equal(calls.length, 0);
  assert.equal(intake.state().enabled, false);
});

test('paused: no calls, and the pause survives a new intake', async () => {
  const { store, calls, intake, fetcher } = setup();
  add(store);
  intake.setPaused(true);
  assert.deepEqual(await intake.tick(), { ran: 0, skipped: 'paused' });
  assert.equal((await intake.fetchSource(store.listSources()[0].id)).code, 'paused');
  assert.equal(calls.length, 0);
  assert.equal(createIntake({ store, fetcher, enabled: true }).state().paused, true);
  intake.setPaused(false);
  assert.equal(intake.state().paused, false);
});

test('happy path stores documents and sends etag and lastModified next time', async () => {
  const { store, calls, intake } = setup();
  const s = add(store);
  assert.deepEqual(await intake.tick(), { ran: 1, skipped: '' });
  assert.equal(docs(store, s.id).length, 2);
  assert.notEqual(store.getSource(s.id).lastOkAt, '');
  assert.deepEqual(calls[0].o.allowHosts, ['example.com']);
  T += 7 * HOUR;
  assert.deepEqual(await intake.tick(), { ran: 1, skipped: '' });
  assert.equal(calls[1].o.etag, '"e1"'); assert.equal(calls[1].o.lastModified, 'LM1');
  assert.deepEqual(calls[1].o.allowHosts, ['example.com']);
  assert.notEqual(intake.state().lastTickAt, '');
});

test('304 is a success that adds nothing', async () => {
  const { store, ctl, intake } = setup();
  const s = add(store);
  await intake.tick();
  T += 7 * HOUR;
  ctl.script = () => ({ ok: true, status: 304, notModified: true, finalUrl: s.url });
  assert.deepEqual(await intake.fetchSource(s.id), { ok: true, added: 0, revised: 0, notModified: true });
  assert.equal(store.getSource(s.id).failures, 0);
  assert.equal(docs(store, s.id).length, 2);
  const row = store.listFetches(s.id)[0];
  assert.equal(row.ok, true); assert.equal(row.added, 0);
});

test('a failed fetch keeps what was there', async () => {
  const { store, ctl, intake } = setup();
  const s = add(store);
  await intake.tick();
  const good = store.getSource(s.id).lastOkAt;
  T += 7 * HOUR;
  ctl.script = () => ({ ok: false, reason: 'HTTP 503', code: 'http_status' });
  await intake.tick();
  const now = store.getSource(s.id);
  assert.equal(docs(store, s.id).length, 2);
  assert.equal(now.lastOkAt, good); assert.equal(now.lastError, 'HTTP 503'); assert.equal(now.failures, 1);
});

test('not a feed is a failure', async () => {
  const { store, intake } = setup({}, () => ({ ok: true, status: 200, body: '<html>502</html>', finalUrl: 'https://example.com/feed.atom', bytes: 16 }));
  const s = add(store);
  await intake.tick();
  const row = store.listFetches(s.id)[0];
  assert.equal(row.ok, false); assert.equal(row.code, 'not_a_feed'); assert.equal(row.reason, 'not a feed');
  assert.equal(docs(store, s.id).length, 0);
  assert.equal(store.getSource(s.id).failures, 1);
});

test('a throwing fetcher is an internal failure and the next source still runs', async () => {
  const { store, ctl, intake, calls } = setup();
  const a = add(store, 1), b = add(store, 2);
  ctl.script = (url, n) => { if (n === 1) throw new Error('boom'); return { ok: true, status: 200, body: ATOM, finalUrl: url, bytes: 1 }; };
  assert.deepEqual(await intake.tick(), { ran: 2, skipped: '' });
  assert.equal(calls.length, 2);
  assert.equal(store.listFetches(a.id)[0].code, 'internal');
  assert.equal(store.getSource(a.id).failures, 1);
  assert.equal(docs(store, b.id).length, 2);
});

// Seven sources, all due, with nextDueAt staggered so source 0 has been due longest.
function seven(ctx) {
  const ids = [];
  for (let i = 0; i < 7; i++) {
    const s = add(ctx.store, i); ids.push(s.id);
    ctx.storage.db.prepare('UPDATE research_sources SET next_due_at = ? WHERE id = ?').run(new Date(T - (100 - i) * MIN).toISOString(), s.id);
  }
  return ids;
}
const called = calls => calls.map(c => Number(/feed(\d)/.exec(c.url)[1]));

test('per-tick cap and order after sleep', async () => {
  const ctx = setup();
  seven(ctx);
  assert.deepEqual(await ctx.intake.tick(), { ran: 3, skipped: '' });
  assert.deepEqual(called(ctx.calls), [0, 1, 2]);
  assert.equal((await ctx.intake.tick()).ran, 3);
  assert.deepEqual(called(ctx.calls), [0, 1, 2, 3, 4, 5]);
  assert.equal((await ctx.intake.tick()).ran, 1);
  assert.deepEqual(called(ctx.calls), [0, 1, 2, 3, 4, 5, 6]);
});

test('daily cap, and a new local day runs again', async () => {
  const ctx = setup({ dailyFetches: 4 });
  seven(ctx);
  assert.equal((await ctx.intake.tick()).ran, 3);
  assert.equal((await ctx.intake.tick()).ran, 1);
  assert.deepEqual(await ctx.intake.tick(), { ran: 0, skipped: 'daily_cap' });
  assert.equal(ctx.calls.length, 4);
  assert.equal((await ctx.intake.fetchSource(ctx.store.listSources()[6].id)).code, 'daily_cap');
  T += 24 * HOUR;
  assert.ok((await ctx.intake.tick()).ran > 0);
});

test('ticks never overlap', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const ctx = setup({}, async () => { await gate; return { ok: false, reason: 'HTTP 503', code: 'http_status' }; });
  const s = add(ctx.store);
  const first = ctx.intake.tick();
  assert.deepEqual(await ctx.intake.tick(), { ran: 0, skipped: 'busy' });
  const r = await ctx.intake.fetchSource(s.id);
  assert.equal(r.ok, false); assert.equal(r.code, 'busy');
  assert.equal(ctx.intake.state().running, true);
  release();
  assert.deepEqual(await first, { ran: 1, skipped: '' });
  assert.equal(ctx.intake.state().running, false);
});

test('five failures quarantine a source and it is never called again', async () => {
  const ctx = setup({}, () => ({ ok: false, reason: 'HTTP 500', code: 'http_status' }));
  const s = add(ctx.store);
  for (let i = 0; i < 5; i++) { assert.equal((await ctx.intake.tick()).ran, 1); T += 25 * HOUR; }
  assert.equal(ctx.store.getSource(s.id).status, 'quarantined');
  assert.deepEqual(await ctx.intake.tick(), { ran: 0, skipped: '' });
  assert.equal(ctx.calls.length, 5);
  const r = await ctx.intake.fetchSource(s.id);
  assert.equal(r.ok, false); assert.equal(r.code, 'not_active');
  assert.equal(ctx.intake.state().sources.quarantined, 1);
});

test('a changed URL host is the only host allowed', async () => {
  const ctx = setup();
  const s = add(ctx.store);
  ctx.store.updateSource(s.id, { url: 'https://new.example.org/feed' });
  await ctx.intake.tick();
  assert.deepEqual(ctx.calls[0].o.allowHosts, ['new.example.org']);
});

test('pausing between sources stops the tick', async () => {
  const ctx = setup();
  ctx.ctl.script = url => { if (ctx.calls.length === 1) ctx.intake.setPaused(true); return { ok: true, status: 200, body: ATOM, finalUrl: url, bytes: 1 }; };
  for (let i = 0; i < 3; i++) add(ctx.store, i);
  assert.deepEqual(await ctx.intake.tick(), { ran: 1, skipped: 'paused' });
  assert.equal(ctx.calls.length, 1);
});

// ---- fix round 1: unrecorded fetches and unreadable state ----
const MSG_UNREAD = 'research state could not be read', MSG_UNRECORDED = 'the last fetch could not be recorded';
function withStore(ctx, over, opts = {}) {
  const store = { ...ctx.store, ...over };
  return createIntake({ store, fetcher: ctx.fetcher, enabled: true, now: () => T, ...opts });
}
const boom = () => { throw new Error('disk full'); };

test('recordFetch throwing stops the tick after one call, then holds for 15 minutes', async () => {
  const ctx = setup();
  for (let i = 0; i < 3; i++) add(ctx.store, i);
  const logs = [];
  const intake = withStore(ctx, { recordFetch: boom }, { log: (...a) => logs.push(a.join(' ')) });
  assert.deepEqual(await intake.tick(), { ran: 1, skipped: 'error' });
  assert.equal(ctx.calls.length, 1);
  assert.ok(logs.some(l => /disk full/.test(l)));
  assert.equal(intake.state().error, MSG_UNRECORDED);
  assert.deepEqual(await intake.tick(), { ran: 0, skipped: 'error' });
  const r = await intake.fetchSource(ctx.store.listSources()[1].id);
  assert.deepEqual(r, { ok: false, code: 'error', reason: MSG_UNRECORDED });
  assert.equal(ctx.calls.length, 1);
  T += 15 * MIN;
  assert.equal(intake.state().error, '');
  assert.deepEqual(await intake.tick(), { ran: 1, skipped: 'error' });
  assert.equal(ctx.calls.length, 2);
});

test('a success whose record fails is not reported as ok', async () => {
  const ctx = setup();
  const s = add(ctx.store);
  const intake = withStore(ctx, { recordFetch: boom });
  const r = await intake.fetchSource(s.id);
  assert.deepEqual(r, { ok: false, code: 'record_failed', reason: 'could not record the fetch' });
  assert.equal(ctx.calls.length, 1);
});

test('unrecorded calls count toward the daily cap', async () => {
  const ctx = setup();
  const s = add(ctx.store);
  const intake = withStore(ctx, { recordFetch: boom }, { dailyFetches: 2 });
  assert.equal((await intake.fetchSource(s.id)).code, 'record_failed'); T += 15 * MIN;
  assert.equal((await intake.fetchSource(s.id)).code, 'record_failed'); T += 15 * MIN;
  assert.equal(intake.state().fetchesToday, 2);
  assert.equal((await intake.fetchSource(s.id)).code, 'daily_cap');
  assert.deepEqual(await intake.tick(), { ran: 0, skipped: 'daily_cap' });
  assert.equal(ctx.calls.length, 2);
});

test('an enabled() that throws does nothing and says so', async () => {
  const ctx = setup();
  const s = add(ctx.store);
  const intake = withStore(ctx, {}, { enabled: boom });
  assert.deepEqual(await intake.tick(), { ran: 0, skipped: 'error' });
  assert.deepEqual(await intake.fetchSource(s.id), { ok: false, code: 'error', reason: MSG_UNREAD });
  const st = intake.state();
  assert.equal(st.enabled, false); assert.equal(st.paused, true); assert.equal(st.error, MSG_UNREAD);
  assert.equal(ctx.calls.length, 0);
});

test('an unreadable pause flag does nothing and says so', async () => {
  const ctx = setup();
  const s = add(ctx.store);
  const intake = withStore(ctx, { getMeta: boom });
  assert.deepEqual(await intake.tick(), { ran: 0, skipped: 'error' });
  assert.equal((await intake.fetchSource(s.id)).code, 'error');
  assert.equal(intake.state().error, MSG_UNREAD);
  assert.equal(ctx.calls.length, 0);
});

test('a store throw in dueSources or fetchesToday gives skipped error and releases the flag', async () => {
  const ctx = setup();
  const s = add(ctx.store);
  for (const over of [{ dueSources: boom }, { fetchesToday: boom }]) {
    const intake = withStore(ctx, over);
    assert.deepEqual(await intake.tick(), { ran: 0, skipped: 'error' });
    assert.equal(intake.state().running, false);
  }
  const intake = withStore(ctx, { getSource: boom });
  const r = await intake.fetchSource(s.id);
  assert.equal(r.ok, false); assert.equal(r.code, 'error');
  assert.notEqual((await intake.fetchSource(s.id)).code, 'busy');
  const intake2 = withStore(ctx, { dueSources: boom });
  await intake2.tick();
  assert.notEqual((await intake2.tick()).skipped, 'busy');
  assert.equal(ctx.calls.length, 0);
});

test('enabled() flipping to false between sources stops the tick', async () => {
  const ctx = setup();
  for (let i = 0; i < 3; i++) add(ctx.store, i);
  const intake = withStore(ctx, {}, { enabled: () => ctx.calls.length < 1 });
  assert.deepEqual(await intake.tick(), { ran: 1, skipped: 'off' });
  assert.equal(ctx.calls.length, 1);
});

test('state counts sources by status', async () => {
  const ctx = setup();
  const a = add(ctx.store, 1), b = add(ctx.store, 2), c = add(ctx.store, 3); add(ctx.store, 4);
  ctx.store.updateSource(a.id, { status: 'paused' });
  ctx.store.updateSource(b.id, { status: 'retired' });
  ctx.storage.db.prepare("UPDATE research_sources SET status = 'quarantined' WHERE id = ?").run(c.id);
  assert.deepEqual(ctx.intake.state().sources, { active: 1, paused: 1, quarantined: 1, retired: 1 });
  assert.equal(ctx.intake.state().error, '');
});

test('state reports why the last tick stopped, and whether the state was readable', async () => {
  const ctx = setup();
  assert.equal(ctx.intake.state().lastTickSkipped, ''); assert.equal(ctx.intake.state().unreadable, false);
  const intake = withStore(ctx, { dueSources: boom });
  await intake.tick();
  assert.equal(intake.state().lastTickSkipped, 'error');
  ctx.intake.setPaused(true);
  await ctx.intake.tick();
  assert.equal(ctx.intake.state().lastTickSkipped, 'paused');
  const broken = withStore(ctx, { listSources: boom });
  assert.equal(broken.state().unreadable, true);
});

test('a URL edited while its fetch is in flight: nothing is saved, the new URL stays due, no validators', async () => {
  const ctx = setup();
  const s = add(ctx.store);
  ctx.ctl.script = () => { ctx.store.updateSource(s.id, { url: 'https://example.com/moved.atom' }); return { ok: true, status: 200, body: ATOM, etag: '"e1"', lastModified: 'LM1', finalUrl: 'x', bytes: ATOM.length }; };
  await ctx.intake.tick();
  assert.equal(docs(ctx.store, s.id).length, 0);
  const after = ctx.store.getSource(s.id);
  assert.equal(after.etag, ''); assert.equal(after.lastModified, ''); assert.equal(after.nextDueAt, ''); assert.equal(after.lastOkAt, '');
  assert.equal(ctx.store.fetchesToday(), 1);
  assert.equal(ctx.store.dueSources(5).length, 1);
});

test('after a URL moves from host A to host B, a redirect back to A is refused', async () => {
  const { createFetcher } = require('../app/research/fetcher');
  const ctx = setup();
  const s = add(ctx.store);
  const moved = ctx.store.updateSource(s.id, { url: 'https://new.example.org/feed' });
  const seen = [];
  const transport = (options, onResponse) => {
    seen.push(options.host);
    const { EventEmitter } = require('node:events');
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = () => setImmediate(() => { const res = new EventEmitter(); res.statusCode = 302; res.headers = { location: 'https://example.com/feed0.atom' }; onResponse(res); });
    return req;
  };
  const fetcher = createFetcher({ lookup: async () => [{ address: '93.184.216.34', family: 4 }], transport });
  const r = await fetcher.fetchText(moved.url, { allowHosts: [moved.host] });
  assert.equal(r.ok, false); assert.equal(r.code, 'host_not_allowed');
  assert.deepEqual(seen, ['new.example.org']);
});
