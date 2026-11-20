'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawnAppServer } = require('./spawn-server.cjs');

// A spawned server, with and without LOCALAI_RESEARCH=on. The real fetcher would reach the network, so the test pauses
// the intake before any source exists: a paused intake makes no network call, whatever the tick finds due. Paths: /api/research/state, /api/research/pause,
// /api/research/sources, /api/research/sources/update, /api/research/sources/fetch, /api/research/documents.
const JSONH = { 'Content-Type': 'application/json' };

async function start(t, research) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-research-api-'));
  const off = 'http://127.0.0.1:9';
  const { child, ready } = spawnAppServer({
    env: { DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, OLLAMA_URL: off, COMFY_URL: off, N8N_URL: off, PROXY_URL: off, SEARXNG_URL: off, MAC_AI_HOME_URL: off, MAC_DSH_URL: off, LOCALAI_PI_HUB_URL: 'off',
      ...(research ? { LOCALAI_RESEARCH: 'on' } : { LOCALAI_RESEARCH: '' }) }
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return ready;
}
const post = (base, route, body) => fetch(`${base}${route}`, { method: 'POST', headers: JSONH, body: JSON.stringify(body) });

test('without LOCALAI_RESEARCH the feature is off: state says so and writes are 409', { timeout: 30000 }, async t => {
  const base = await start(t, false);
  const state = await (await fetch(`${base}/api/research/state`)).json();
  assert.equal(state.enabled, false);
  const add = await post(base, '/api/research/sources', { name: 'Example', url: 'https://example.com/feed.atom' });
  assert.equal(add.status, 409); assert.deepEqual(await add.json(), { error: 'research is off' });
  assert.deepEqual(await (await fetch(`${base}/api/research/sources`)).json(), { enabled: false, sources: [] });
  assert.deepEqual(await (await fetch(`${base}/api/research/documents`)).json(), { enabled: false, documents: [] });
});

test('with LOCALAI_RESEARCH=on a source can be added, a private address is refused and the pause sticks', { timeout: 30000 }, async t => {
  const base = await start(t, true);
  const state = await (await fetch(`${base}/api/research/state`)).json();
  assert.equal(state.enabled, true); assert.equal(state.paused, false);
  assert.equal((await post(base, '/api/research/pause', { paused: true })).status, 200);
  const add = await post(base, '/api/research/sources', { name: 'Example', url: 'https://example.com/feed.atom' });
  assert.equal(add.status, 200);
  const { source } = await add.json();
  assert.equal(source.host, 'example.com');
  assert.equal((await post(base, '/api/research/sources', { name: 'LAN', url: 'https://10.0.0.80/feed' })).status, 400);
  const list = await (await fetch(`${base}/api/research/sources`)).json();
  assert.equal(list.sources.length, 1);
  assert.equal((await post(base, '/api/research/sources/update', { id: 'src-none', name: 'x' })).status, 404);
  assert.equal((await post(base, '/api/research/pause', { paused: true })).status, 200);
  assert.equal((await (await fetch(`${base}/api/research/state`)).json()).paused, true);
  // Paused: a fetch is refused before any network call.
  const f = await post(base, '/api/research/sources/fetch', { id: source.id });
  assert.equal(f.status, 409); assert.equal((await f.json()).code, 'paused');
  assert.deepEqual((await (await fetch(`${base}/api/research/documents`)).json()), { enabled: true, documents: [] });
});
