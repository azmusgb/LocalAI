'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { spawnAppServer } = require('./spawn-server.cjs');

// Web research health: the status check asks SearXNG's /healthz, never runs a search of its own each time (that got
// the engines rate-limiting us), and turns DEGRADED when searches find nothing, naming the engines that did not answer.
async function fakeSearx(t, answer) {
  const hits = { healthz: 0, search: 0 };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/healthz') { hits.healthz++; res.end('OK'); return; }
    if (u.pathname === '/search') { hits.search++; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(answer())); return; }
    res.statusCode = 404; res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}`, hits };
}

async function start(t, searxUrl, env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-search-health-'));
  const off = 'http://127.0.0.1:9';
  const { child, ready } = spawnAppServer({ env: { DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, SEARXNG_URL: searxUrl, OLLAMA_URL: off, COMFY_URL: off, N8N_URL: off, PROXY_URL: off, MAC_AI_HOME_URL: off, MAC_DSH_URL: off, HEALTH_TICK_MS: '600000', ...env } });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = await ready;
  return async () => (await (await fetch(base + '/api/status')).json()).services.find(s => s.name === 'search');
}

async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 50)); }
}

test('search is DEGRADED when searches find nothing, and status checks run one test search, not one each', { timeout: 30000 }, async t => {
  const searx = await fakeSearx(t, () => ({ results: [], unresponsive_engines: [['google', 'too many requests'], ['brave', 'timeout']] }));
  const search = await start(t, searx.url);
  const degraded = await until(async () => { const s = await search(); return s.state === 'DEGRADED' && s; });
  assert.match(degraded.error, /Searches find nothing \(not answering: google, brave\)/);
  for (let i = 0; i < 5; i++) await search();
  assert.equal(searx.hits.search, 1, 'one test search, however often status is checked');
  assert.ok(searx.hits.healthz >= 6);
});

test('search stays HEALTHY when searches find results; the test search repeats only after SEARCH_CHECK_MS', { timeout: 30000 }, async t => {
  const searx = await fakeSearx(t, () => ({ results: [{ title: 'a', url: 'https://a.example', content: '' }], unresponsive_engines: [] }));
  const search = await start(t, searx.url, { SEARCH_CHECK_MS: '1500' });
  await search();
  await until(() => searx.hits.search === 1);
  assert.equal((await search()).state, 'HEALTHY');
  await new Promise(r => setTimeout(r, 1700));
  await search();
  await until(() => searx.hits.search === 2);
});
