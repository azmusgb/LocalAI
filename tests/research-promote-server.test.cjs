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
  // The claim is page text too: only inside the markers, never in the title or summary an agent reads as plain text.
  assert.ok(inside.includes('Claim 0'), 'claim is inside the markers');
  assert.equal(item.title, `Research finding ${ids[0]}`);
  for (const k of Object.keys(item)) if (k !== 'fix') assert.ok(!JSON.stringify(item[k]).includes('Claim 0'), `claim leaked into ${k}`);
  assert.ok(!item.fix.replace(inside, '').includes('Claim 0'), 'claim is not outside the markers');
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
  for (const f of [a, b, c]) store.decideFinding(f.id, 'promoted');
  store.recordOutcome({ findingId: a.id, metricName: 'm', beforeVal: 1, afterVal: 2, verdict: 'validated' });
  store.recordOutcome({ findingId: b.id, metricName: 'm', beforeVal: 1, afterVal: 2, verdict: 'refuted' });
  store.recordOutcome({ findingId: c.id, metricName: 'm', beforeVal: 1, afterVal: 2, verdict: 'inconclusive' });
  assert.equal(store.getFinding(a.id).status, 'validated');
  assert.equal(store.getFinding(b.id).status, 'refuted');
  assert.equal(store.getFinding(c.id).status, 'promoted', 'inconclusive leaves it as the owner decided it');
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

test('the inbox returns the released findings even when more than 100 are waiting', async () => {
  const store = createResearchStore({ db: new DatabaseSync(':memory:'), now: () => Date.parse('2026-11-20T15:00:00Z'), timeZone: 'UTC' });
  seedFindings(store, 150);
  const routes = createResearchRoutes({ intake: { state: () => ({ enabled: true }) }, store, json: (res, s, b) => { res.statusCode = s; res.body = b; }, readBody: async () => ({}), storageError: (res, e) => { res.statusCode = 500; res.body = { error: e.message }; } });
  const res = {};
  await routes.apiResearchFindings({}, res, new URL('http://x/api/research/findings?status=extracted'));
  assert.equal(res.body.findings.length, 10);
  assert.deepEqual(res.body.counts, { newToday: 10, cap: 10, waiting: 140 });
  assert.deepEqual(res.body.findings.map(f => f.claim).sort(), Array.from({ length: 10 }, (_, i) => `Claim ${i}`).sort());
});

// Review of #614: the five defects, each pinned.
const routesFor = (store, changes) => createResearchRoutes({ intake: { state: () => ({ enabled: true }) }, store, changes, json: (res, s, b) => { res.statusCode = s; res.body = b; }, readBody: async req => req.body, storageError: (res, e) => { res.statusCode = 500; res.body = { error: e.message }; } });

test('the unfiltered list shows the day\'s new findings before decided ones', async () => {
  const store = createResearchStore({ db: new DatabaseSync(':memory:'), now: () => Date.parse('2026-11-20T15:00:00Z'), timeZone: 'UTC' });
  const all = seedFindings(store, 15);
  for (const f of all.slice(0, 12)) store.decideFinding(f.id, 'kept');
  const res = {};
  await routesFor(store).apiResearchFindings({}, res, new URL('http://x/api/research/findings'));
  const fresh = res.body.findings.filter(f => f.status === 'extracted');
  assert.equal(fresh.length, 3, 'all 3 released findings are in the first page');
  assert.equal(res.body.counts.newToday, 3);
});

test('an outcome needs a decided finding: extracted or dismissed is refused and left as it was', () => {
  const store = createResearchStore({ db: new DatabaseSync(':memory:') });
  const [a, b] = seedFindings(store, 2);
  store.decideFinding(b.id, 'dismissed');
  for (const f of [a, b]) {
    const before = store.getFinding(f.id).status;
    assert.throws(() => store.recordOutcome({ findingId: f.id, metricName: 'm', verdict: 'validated' }), e => e.status === 409);
    assert.equal(store.getFinding(f.id).status, before);
    assert.equal(store.listOutcomes(f.id).length, 0);
  }
});

test('an outcome keeps the finding linked to its backlog item; the outcome row holds its own change', () => {
  const store = createResearchStore({ db: new DatabaseSync(':memory:') });
  const [f] = seedFindings(store, 1);
  store.decideFinding(f.id, 'promoted', { changeId: 'research-' + f.id });
  store.recordOutcome({ findingId: f.id, changeId: 'chg-789', metricName: 'm', verdict: 'validated' });
  assert.equal(store.getFinding(f.id).changeId, 'research-' + f.id);
  assert.equal(store.getFinding(f.id).status, 'validated');
  assert.equal(store.listOutcomes(f.id)[0].changeId, 'chg-789');
});

test('promote refuses a finding that is already promoted, dismissed or has a verdict, and makes no item', async () => {
  const store = createResearchStore({ db: new DatabaseSync(':memory:') });
  const [p, d, v] = seedFindings(store, 3);
  store.decideFinding(p.id, 'promoted', { changeId: 'research-' + p.id });
  store.decideFinding(d.id, 'dismissed');
  store.decideFinding(v.id, 'promoted', { changeId: 'research-' + v.id });
  store.recordOutcome({ findingId: v.id, metricName: 'm', verdict: 'refuted' });
  let made = 0;
  const routes = routesFor(store, { addResearchItem: () => ({ id: `item-${++made}` }) });
  for (const f of [p, d, v]) {
    const before = store.getFinding(f.id);
    const res = {};
    await routes.apiResearchFindingPromote({ body: { id: f.id } }, res);
    assert.equal(res.statusCode, 409, JSON.stringify(res.body));
    assert.deepEqual(store.getFinding(f.id), before);
  }
  assert.equal(made, 0, 'no backlog item was made');
});

// Follow-ups to the #614 review: the four findings left open there.
test('promoting again after its backlog item was rejected is refused, not answered with the closed item', { timeout: 40000 }, async t => {
  const { base, ids } = await startServer(t, 1);
  const first = await post(base, '/api/research/findings/promote', { id: ids[0] });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const rej = await post(base, '/api/improve/item', { id: first.body.changeId, action: 'reject' });
  assert.equal(rej.status, 200, JSON.stringify(rej.body));
  const kept = await post(base, '/api/research/findings/decide', { id: ids[0], status: 'kept' });
  assert.equal(kept.status, 200, JSON.stringify(kept.body));
  const again = await post(base, '/api/research/findings/promote', { id: ids[0] });
  assert.equal(again.status, 409, JSON.stringify(again.body));
  assert.match(again.body.error, /rejected/);
  const { body: { finding } } = { body: { finding: (await get(base, '/api/research/findings?status=kept')).body.findings.find(f => f.id === ids[0]) } };
  assert.equal(finding.status, 'kept', 'the finding is left as it was');
});

test('reading kept or dismissed findings does not use up the day\'s inbox release', async () => {
  const store = createResearchStore({ db: new DatabaseSync(':memory:'), now: () => Date.parse('2026-11-20T15:00:00Z'), timeZone: 'UTC' });
  seedFindings(store, 3);
  const routes = routesFor(store);
  const res = {};
  await routes.apiResearchFindings({}, res, new URL('http://x/api/research/findings?status=kept'));
  assert.equal(res.statusCode ?? 200, 200);
  assert.equal(res.body.counts, undefined, 'no inbox counts for a list that is not the inbox');
  assert.equal(store.getMeta('inbox_released'), null, 'nothing was released by reading kept findings');
});

test('the promoted item keeps the whole evidence quote even with a long claim and long sources', () => {
  const { researchItem } = require('../app/improve');
  const quote = 'q'.repeat(400);
  const longUrl = 'https://example.com/' + 'p'.repeat(280);
  const item = researchItem({ id: 'fnd_1', claim: 'c'.repeat(900), quote, targetProject: 'LocalAI', relevance: 'Direct' },
    [{ name: 'Feed', url: longUrl }, { name: 'Doc', url: longUrl }], '', '2026-11-21T00:00:00Z');
  assert.ok(item.fix.includes(quote), 'the quote is whole inside the markers');
});
