'use strict';

// Pi Hub's two merged reads (amendment A34, P1a): GET /api/contract/status and /api/contract/models.
// The merge (app/server/contract.js) with stubbed sources: every source up, each down singly, all down, a timeout.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createContract } = require('../app/server/contract');

const SERVICES = { overall: 'HEALTHY', services: [{ name: 'ollama', state: 'HEALTHY' }], serviceSummary: { core: 1, coreUnhealthy: 0 } };
const TAGS = { models: [{ name: 'test-model', digest: 'd1', size: 5 }, { name: 'other:7b' }] };
const PS = { models: [{ name: 'test-model', size_vram: 4 }] };
const boom = msg => () => { throw new Error(msg); };

// Each source is a stub a test can swap for one that throws or never answers.
function make({ stubs = {}, ollama = {}, timeouts = {}, clock } = {}) {
  const fetchWithTimeout = async (url) => {
    const path = new URL(url).pathname;
    const body = ollama[path] === undefined ? (path === '/api/tags' ? TAGS : PS) : ollama[path];
    if (body instanceof Error) throw body;
    if (typeof body === 'function') return body();
    return { ok: true, json: async () => body };
  };
  return createContract({
    now: clock,
    getStatus: async () => SERVICES,
    gridcraftHealthRead: async () => ({ ok: true, gridcraftConnected: true }),
    artcraftStatusRead: async () => ({ ok: true, installed: true, running: false, version: '1.0' }),
    workshopStatusRead: async () => ({ online: true, portalUrl: 'http://10.0.0.28', printer: null }),
    watchRead: () => ({ findings: [], display: null }),
    ollamaUrl: 'http://ollama.test', fetchWithTimeout, defaultModel: 'test-model', protectedModels: () => ['test-model'],
    pullsList: () => [], routingRead: () => ({ cloud: false, providers: [], table: [] }),
    timeouts, ...stubs
  });
}

const STATUS_SOURCES = ['services', 'gridcraft', 'artcraft', 'workshop', 'watch'];
const MODEL_SOURCES = ['installed', 'loaded', 'pulls', 'routing'];

function assertShape(r, names) {
  assert.deepEqual(Object.keys(r.sources).sort(), [...names].sort());
  assert.ok(!Number.isNaN(Date.parse(r.as_of)), 'as_of is an ISO timestamp');
  for (const s of Object.values(r.sources)) {
    assert.ok(['ok', 'failed', 'unknown'].includes(s.state));
    assert.ok(!Number.isNaN(Date.parse(s.checked_at)));
    assert.ok(Date.parse(r.as_of) >= Date.parse(s.checked_at), 'as_of is taken when the merge finished');
    if (s.state === 'ok') assert.equal(s.error, undefined);
    else assert.equal(typeof s.error, 'string');
    assert.equal(s.value, undefined, 'a source carries no data of its own');
  }
}

test('status: every source up', async () => {
  const r = await make().status();
  assertShape(r, STATUS_SOURCES);
  assert.ok(Object.values(r.sources).every(s => s.state === 'ok'));
  assert.equal(r.overall, 'HEALTHY');
  assert.equal(r.services.length, 1);
  assert.equal(r.serviceSummary.core, 1);
  assert.equal(r.gridcraft.gridcraftConnected, true);
  assert.equal(r.artcraft.installed, true);
  assert.equal(r.workshop.online, true);
  assert.deepEqual(r.watch.findings, []);
});

const DATA_KEYS = { services: ['overall', 'services', 'serviceSummary'], gridcraft: ['gridcraft'], artcraft: ['artcraft'], workshop: ['workshop'], watch: ['watch'] };
const DOWN = {
  services: { getStatus: boom('probe store unreadable') },
  gridcraft: { gridcraftHealthRead: boom('GridCraft bridge unavailable (ECONNREFUSED)') },
  artcraft: { artcraftStatusRead: boom('Windows computer bridge answered HTTP 500') },
  workshop: { workshopStatusRead: async () => ({ online: false, portalUrl: 'http://10.0.0.28' }) },
  watch: { watchRead: boom('watch store unreadable') }
};
for (const name of STATUS_SOURCES) {
  test(`status: ${name} down alone is failed with its error and null data; the others stay ok`, async () => {
    const r = await make({ stubs: DOWN[name] }).status();
    assertShape(r, STATUS_SOURCES);
    for (const n of STATUS_SOURCES) assert.equal(r.sources[n].state, n === name ? 'failed' : 'ok', n);
    assert.ok(r.sources[name].error.length > 0);
    for (const k of DATA_KEYS[name]) assert.equal(r[k], null, `${k} is null, not empty or healthy`);
  });
}

test('status: a Workshop display with no address set is unknown, not failed and not ok', async () => {
  const r = await make({ stubs: { workshopStatusRead: async () => ({ online: false, portalUrl: null }) } }).status();
  assert.equal(r.sources.workshop.state, 'unknown');
  assert.equal(r.workshop, null);
});

test('status: every source down', async () => {
  const r = await make({ stubs: Object.assign({}, ...Object.values(DOWN)) }).status();
  assertShape(r, STATUS_SOURCES);
  assert.ok(Object.values(r.sources).every(s => s.state === 'failed'));
  assert.equal(r.overall, null);
  assert.equal(r.services, null);
  assert.equal(r.serviceSummary, null);
});

test('status: a source that outlives its deadline is failed, and the others still answer', async () => {
  const never = () => new Promise(() => {});
  const started = Date.now();
  const r = await make({ stubs: { gridcraftHealthRead: never }, timeouts: { gridcraft: 40 } }).status();
  assert.ok(Date.now() - started < 2000);
  assert.equal(r.sources.gridcraft.state, 'failed');
  assert.match(r.sources.gridcraft.error, /did not answer within/);
  assert.equal(r.gridcraft, null);
  assert.equal(r.sources.services.state, 'ok');
});

test('models: every source up, with loaded folded in from Ollama', async () => {
  const r = await make().models();
  assertShape(r, MODEL_SOURCES);
  assert.ok(Object.values(r.sources).every(s => s.state === 'ok'));
  assert.deepEqual(r.installed.map(x => x.name), ['test-model', 'other:7b']);
  assert.deepEqual(r.loaded.map(x => x.name), ['test-model']);
  assert.equal(r.defaultInstalled, true);
  assert.equal(r.defaultLoaded, true);
  assert.deepEqual(r.pulls, []);
  assert.equal(r.routing.cloud, false);
  assert.equal(r.default, 'test-model');
  assert.deepEqual(r.protectedModels, ['test-model']);
});

test('models: an installed list that is really empty is ok and empty; a failed one is null', async () => {
  const empty = await make({ ollama: { '/api/tags': { models: [] } } }).models();
  assert.equal(empty.sources.installed.state, 'ok');
  assert.deepEqual(empty.installed, []);
  assert.equal(empty.defaultInstalled, false);
  const down = await make({ ollama: { '/api/tags': new Error('fetch failed') } }).models();
  assert.equal(down.sources.installed.state, 'failed');
  assert.equal(down.installed, null);
  assert.equal(down.defaultInstalled, null);
});

const MODEL_DOWN = {
  installed: { ollama: { '/api/tags': new Error('fetch failed') } },
  loaded: { ollama: { '/api/ps': new Error('fetch failed') } },
  pulls: { stubs: { pullsList: boom('pull list unreadable') } },
  routing: { stubs: { routingRead: boom('routing setting unreadable') } }
};
for (const name of MODEL_SOURCES) {
  test(`models: ${name} down alone is failed with null data; the others stay ok`, async () => {
    const r = await make(MODEL_DOWN[name]).models();
    assertShape(r, MODEL_SOURCES);
    for (const n of MODEL_SOURCES) assert.equal(r.sources[n].state, n === name ? 'failed' : 'ok', n);
    assert.equal(r[name], null);
  });
}

test('models: an Ollama HTTP error or a malformed body is failed, not an empty list', async () => {
  const bad = { ok: false, status: 500, json: async () => ({}) };
  const r = await make({ ollama: { '/api/tags': () => bad, '/api/ps': () => ({ ok: true, json: async () => { throw new SyntaxError('Unexpected token'); } }) } }).models();
  assert.equal(r.sources.installed.state, 'failed');
  assert.match(r.sources.installed.error, /HTTP 500/);
  assert.equal(r.sources.loaded.state, 'failed');
  assert.equal(r.installed, null);
  assert.equal(r.loaded, null);
});

test('models: every source down, and Ollama timing out', async () => {
  const r = await make({ ollama: { '/api/tags': new Error('fetch failed'), '/api/ps': new Error('fetch failed') }, stubs: { pullsList: boom('x'), routingRead: boom('y') } }).models();
  assertShape(r, MODEL_SOURCES);
  assert.ok(Object.values(r.sources).every(s => s.state === 'failed'));
  const slow = await make({ ollama: { '/api/tags': () => new Promise(() => {}) }, timeouts: { installed: 40 } }).models();
  assert.equal(slow.sources.installed.state, 'failed');
  assert.match(slow.sources.installed.error, /did not answer within/);
  assert.equal(slow.sources.loaded.state, 'ok');
});

test('a source error carries the cause code when the message is only "fetch failed"', async () => {
  const e = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  const r = await make({ ollama: { '/api/tags': e } }).models();
  assert.equal(r.sources.installed.error, 'fetch failed (ECONNREFUSED)');
});
