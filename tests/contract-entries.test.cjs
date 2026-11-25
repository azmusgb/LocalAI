'use strict';

// The `pi-hub` consumer entries of app/atlas/contracts.json (amendment A34, P1a): what Pi Hub may rely on from Local AI.
// A breaking change (a documented field removed from a reply, a route dropped from the hub-key allow-list) fails here.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createContract } = require('../app/server/contract');

const contracts = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'app', 'atlas', 'contracts.json'), 'utf8'));
const mine = contracts.filter(c => c.consumers.some(x => x.repo === 'pi-hub') && c.provider.repo === 'localai');
const byRoute = (method, p) => mine.find(c => c.provider.method === method && c.provider.path === p);
const SIX = [['GET', '/api/contract/status'], ['GET', '/api/contract/models'], ['POST', '/api/agents/missions/start'], ['GET', '/api/runs'], ['POST', '/api/runs/cancel'], ['GET', '/api/agents/mission']];

test('each of the six routes has a pi-hub consumer entry with its key, cache and reply fields', () => {
  assert.equal(mine.length, 6);
  for (const [method, p] of SIX) {
    const c = byRoute(method, p);
    assert.ok(c, `${method} ${p} is declared`);
    assert.deepEqual(c.consumers, [{ repo: 'pi-hub', module: 'hub/assistant_api.py' }]);
    assert.equal(c.key, 'hub', `${p} is on the hub key`);
    assert.ok(c.request && typeof c.request === 'object');
    assert.ok(Array.isArray(c.response.fields) && c.response.fields.length > 0);
  }
  assert.equal(byRoute('GET', '/api/contract/status').cache, 'owner');
  assert.equal(byRoute('GET', '/api/contract/models').cache, 'owner');
  for (const [method, p] of SIX.slice(2)) assert.equal(byRoute(method, p).cache, 'none', `${p} is never cached`);
});

test('no route that stays off the hub key is declared for pi-hub', () => {
  const paths = mine.map(c => c.provider.path);
  for (const never of ['/api/runs/retry', '/api/runs/update', '/api/runs/feedback', '/api/agents/run', '/api/chat/stream', '/api/models/pull', '/api/powershell/create', '/api/atlas/ask']) assert.ok(!paths.includes(never), never);
});

function reads() {
  const c = createContract({
    getStatus: async () => ({ overall: 'HEALTHY', services: [], serviceSummary: {} }), gridcraftHealthRead: async () => ({}), artcraftStatusRead: async () => ({}),
    workshopStatusRead: async () => ({ online: true, portalUrl: 'http://x' }), watchRead: () => ({}), ollamaUrl: 'http://o.test', defaultModel: 'm', protectedModels: () => [],
    pullsList: () => [], routingRead: () => ({}), fetchWithTimeout: async () => ({ ok: true, json: async () => ({ models: [] }) })
  });
  return { 'GET /api/contract/status': c.status(), 'GET /api/contract/models': c.models() };
}

test('a documented field removed from a contract read fails; so does a source dropped from it', async () => {
  const out = reads();
  for (const [key, pending] of Object.entries(out)) {
    const [method, p] = key.split(' ');
    const entry = byRoute(method, p), reply = await pending;
    for (const f of entry.response.fields) assert.ok(f in reply, `${p} no longer carries ${f}`);
    assert.deepEqual(Object.keys(reply.sources).sort(), [...entry.response.sources].sort(), `${p} sources`);
    // And a field the code adds is documented, so the entry is the whole contract.
    assert.deepEqual(Object.keys(reply).sort(), [...entry.response.fields].sort(), `${p} fields are exactly the documented ones`);
  }
});

test('the breaking-change check itself catches a removed field', async () => {
  const entry = byRoute('GET', '/api/contract/models');
  const reply = { ...(await reads()['GET /api/contract/models']) };
  delete reply.loaded;
  assert.ok(entry.response.fields.some(f => !(f in reply)), 'a reply without "loaded" is flagged');
});

test('the hub-key allow-list in server.js carries the six routes by method and path, and no other route opens on the hub key alone', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'server.js'), 'utf8');
  const block = src.slice(src.indexOf('routeKeys: {'), src.indexOf('} });', src.indexOf('routeKeys: {')));
  for (const [method, p] of SIX) assert.match(block, new RegExp(`'${p}': req => req\\.method === '${method}' && hubKey\\.authorized\\(req\\)`), `${method} ${p}`);
  const hubOnly = [...block.matchAll(/'(\/api\/[^']+)': req => (?:req\.method === '[A-Z]+' && )?hubKey\.authorized\(req\)/g)].map(m => m[1]);
  assert.deepEqual(hubOnly.sort(), ['/api/agents/mission', '/api/agents/missions/start', '/api/attention', '/api/chat', '/api/contract/models', '/api/contract/status', '/api/display/ai-cards', '/api/lab/projects', '/api/runs', '/api/runs/cancel', '/api/world'].sort());
});
