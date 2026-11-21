'use strict';

// Promote, outcome and the daily cap, through the real server wiring (app/server.js), not an injected fake.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { Storage } = require('../app/storage');
const { createResearchStore } = require('../app/research/store');
const { createResearchRoutes } = require('../app/server/research');
const { guarded } = require('../app/signin');
const { spawnAppServer } = require('./spawn-server.cjs');

const QUOTE = 'async Lifespan state optimization';
function seedFindings(store, n) {
  const src = store.addSource({ name: 'FastAPI Releases', url: 'https://fastapi.tiangolo.com/release.xml' });
  store.saveEntries(src.id, [{ id: 'e1', title: 'FastAPI 0.165', text: `Adds ${QUOTE}.`, url: 'https://fastapi.tiangolo.com/0.165' }]);
  const doc = store.listDocuments({ sourceId: src.id })[0];
  return Array.from({ length: n }, (_, i) => store.addFinding({ documentId: doc.id, sourceId: src.id, claim: `Claim ${i}`, quote: QUOTE, targetProject: 'LocalAI', relevance: 'Direct' }));
}
const post = (base, p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));
const get = (base, p) => fetch(base + p).then(async r => ({ status: r.status, body: await r.json() }));

async function startServer(t, n) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-promote-'));
  const storage = new Storage({ dataDir });
  const ids = seedFindings(createResearchStore({ db: storage.db }), n).map(f => f.id);
  storage.close?.();
  const { child, ready } = spawnAppServer({ env: { DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, OLLAMA_URL: 'http://127.0.0.1:9', LOCALAI_RESEARCH: 'on' } });
  t.after(async () => { child.kill(); await new Promise(r => child.once('exit', r)); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { base: await ready, ids };
}

test('promote on the real server makes an Improve backlog item that quotes the finding between the untrusted markers', { timeout: 40000 }, async t => {
  const { base, ids } = await startServer(t, 1);
  const r = await post(base, '/api/research/findings/promote', { id: ids[0] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.changeId, 'an item id comes back');
  assert.equal(r.body.finding.status, 'promoted');
  assert.equal(r.body.finding.changeId, r.body.changeId);
  const { items } = (await get(base, '/api/improve/items')).body;
  const item = items.find(i => i.id === r.body.changeId);
  assert.ok(item, 'the item is on the Improve backlog');
  assert.equal(item.stage, 'backlog');
  assert.match(item.fix, /<<<UNTRUSTED_REQUEST\n[\s\S]*UNTRUSTED_REQUEST>>>/);
  const inside = item.fix.split('<<<UNTRUSTED_REQUEST\n')[1].split('\nUNTRUSTED_REQUEST>>>')[0];
  assert.ok(inside.includes(QUOTE), 'quote is inside the markers');
  assert.ok(inside.includes('https://fastapi.tiangolo.com/0.165'), 'source url is inside the markers');
  assert.ok(inside.includes('FastAPI Releases'), 'source name is inside the markers');
  assert.ok(!item.fix.replace(inside, '').includes(QUOTE), 'quote is not outside the markers');
});

test('promote fails closed when no backlog item can be made', async () => {
  const store = createResearchStore({ db: new DatabaseSync(':memory:') });
  const [f] = seedFindings(store, 1);
  const base = { intake: { state: () => ({ enabled: true }) }, store, json: (res, s, b) => { res.statusCode = s; res.body = b; }, readBody: async req => req.body, storageError: (res, e) => { res.statusCode = 500; res.body = { error: e.message }; } };
  for (const changes of [undefined, {}, { addResearchItem: () => { throw new Error('disk full'); } }, { addResearchItem: () => null }]) {
    const res = {};
    await createResearchRoutes({ ...base, changes }).apiResearchFindingPromote({ body: { id: f.id } }, res);
    assert.ok(res.statusCode >= 500, `status ${res.statusCode}`);
    assert.ok(res.body.error);
    assert.equal(store.getFinding(f.id).status, 'extracted');
    assert.equal(store.getFinding(f.id).changeId, '');
  }
});

test('/api/improve/outcome needs the sign-in guard like the other research routes', () => {
  assert.equal(guarded('/api/improve/outcome'), true);
  assert.equal(guarded('/api/research/findings'), true);
});

test('recording an outcome moves the finding to validated or refuted, and inconclusive leaves it', () => {
  const store = createResearchStore({ db: new DatabaseSync(':memory:') });
  const [a, b, c] = seedFindings(store, 3);
  store.recordOutcome({ findingId: a.id, metricName: 'm', beforeVal: 1, afterVal: 2, verdict: 'validated' });
  store.recordOutcome({ findingId: b.id, metricName: 'm', beforeVal: 1, afterVal: 2, verdict: 'refuted' });
  store.recordOutcome({ findingId: c.id, metricName: 'm', beforeVal: 1, afterVal: 2, verdict: 'inconclusive' });
  assert.equal(store.getFinding(a.id).status, 'validated');
  assert.equal(store.getFinding(b.id).status, 'refuted');
  assert.equal(store.getFinding(c.id).status, 'extracted');
  assert.throws(() => store.recordOutcome({ findingId: a.id, verdict: 'great' }), e => e.status === 400);
});

test('the inbox shows at most 10 new findings a day, with the counts, and dismissing does not release more', async () => {
  let clock = Date.parse('2026-11-20T15:00:00Z');
  const store = createResearchStore({ db: new DatabaseSync(':memory:'), now: () => clock, timeZone: 'UTC' });
  const all = seedFindings(store, 14);
  const routes = createResearchRoutes({ intake: { state: () => ({ enabled: true }) }, store, json: (res, s, b) => { res.statusCode = s; res.body = b; }, readBody: async () => ({}), storageError: (res, e) => { res.statusCode = 500; res.body = { error: e.message }; } });
  const list = async q => { const res = {}; await routes.apiResearchFindings({}, res, new URL('http://x/api/research/findings' + q)); return res.body; };
  let r = await list('?status=extracted');
  assert.equal(r.findings.length, 10);
  assert.deepEqual(r.counts, { newToday: 10, cap: 10, waiting: 4 });
  for (const f of r.findings) store.decideFinding(f.id, 'dismissed');
  r = await list('?status=extracted');
  assert.equal(r.findings.length, 0, 'the cap is for the day, not for the screen');
  assert.deepEqual(r.counts, { newToday: 10, cap: 10, waiting: 4 });
  clock = Date.parse('2026-11-21T15:00:00Z');
  r = await list('?status=extracted');
  assert.equal(r.findings.length, 4);
  assert.deepEqual(r.counts, { newToday: 4, cap: 10, waiting: 0 });
  assert.equal(all.length, 14);
});
