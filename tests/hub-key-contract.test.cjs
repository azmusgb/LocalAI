'use strict';

// Pi Hub's key and the `pi-hub` consumer contract (amendment A34, P1a), against a real server: the six routes open with
// the hub key and only those; the contract reads answer 200 with a failed source named; a Mission starts, is followed and
// is cancelled with the key.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { spawnAppServer } = require('./spawn-server.cjs');

const KEY = 'hub_' + 'd'.repeat(40);
const DEAD = 'http://127.0.0.1:9';
const forwarded = { 'X-Forwarded-For': '10.0.0.50' }; // as if through Caddy, not the host itself
const H = { 'X-LocalAI-Hub-Key': KEY, ...forwarded };

async function start(t, { env = {}, ollama = DEAD } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-contract-'));
  const { child, ready } = spawnAppServer({ env: {
    DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, OLLAMA_URL: ollama, MODEL: 'test-model', SEARXNG_URL: DEAD, COMFY_URL: DEAD, N8N_URL: DEAD, PROXY_URL: DEAD, MAC_AI_HOME_URL: DEAD, MAC_DSH_URL: DEAD,
    LOCALAI_GRIDCRAFT_URL: DEAD, GRIDCRAFT_URL: DEAD, LOCALAI_HUB_KEY_SHA256: crypto.createHash('sha256').update(KEY).digest('hex'), ...env } });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = await ready;
  const call = async (method, p, headers = {}, body) => {
    const r = await fetch(base + p, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await r.text();
    let value = null; try { value = JSON.parse(text); } catch {}
    return { status: r.status, value };
  };
  return { base, call };
}

test('the contract reads answer 200 with Ollama and the bridges down, naming each failed source', { timeout: 40000 }, async t => {
  const { call } = await start(t);
  const models = await call('GET', '/api/contract/models', H);
  assert.equal(models.status, 200);
  assert.ok(!Number.isNaN(Date.parse(models.value.as_of)));
  assert.equal(models.value.contract_version, 1);
  assert.equal(models.value.sources.installed.state, 'failed');
  assert.equal(models.value.sources.loaded.state, 'failed');
  assert.equal(typeof models.value.sources.installed.error, 'string');
  assert.equal(models.value.installed, null);
  assert.equal(models.value.loaded, null);
  assert.equal(models.value.sources.pulls.state, 'ok');
  assert.equal(models.value.sources.routing.state, 'ok');
  // The page's own read is unchanged: still a 502 with its degraded body.
  const old = await call('GET', '/api/models');
  assert.equal(old.status, 502);
  assert.equal(old.value.available, false);
  assert.equal(old.value.sources, undefined);

  const status = await call('GET', '/api/contract/status', H);
  assert.equal(status.status, 200);
  assert.ok(!Number.isNaN(Date.parse(status.value.as_of)));
  assert.deepEqual(Object.keys(status.value.sources).sort(), ['artcraft', 'gridcraft', 'services', 'watch', 'workshop']);
  assert.equal(status.value.contract_version, 1);
  assert.equal(status.value.sources.services.state, 'ok');
  assert.equal(status.value.overall, 'DOWN');
  assert.equal(status.value.services.find(s => s.name === 'ollama').state, 'DOWN');
  assert.equal(status.value.sources.gridcraft.state, 'failed');
  assert.equal(status.value.gridcraft, null);
  assert.equal(status.value.sources.artcraft.state, 'failed');
  assert.notEqual(status.value.sources.workshop.state, 'ok');
  assert.equal(status.value.sources.watch.state, 'ok');
});

test('the contract reads answer 200 with Ollama up', { timeout: 40000 }, async t => {
  const ollama = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url === '/api/tags' ? { models: [{ name: 'test-model' }] } : { models: [{ name: 'test-model', size_vram: 1 }] }));
  });
  ollama.listen(0, '127.0.0.1'); await once(ollama, 'listening');
  t.after(async () => { ollama.closeAllConnections(); await new Promise(r => ollama.close(r)); });
  const { call } = await start(t, { ollama: `http://127.0.0.1:${ollama.address().port}` });
  const models = await call('GET', '/api/contract/models', H);
  assert.equal(models.status, 200);
  assert.ok(Object.values(models.value.sources).every(s => s.state === 'ok'));
  assert.equal(models.value.installed[0].name, 'test-model');
  assert.equal(models.value.loaded[0].name, 'test-model');
  assert.equal(models.value.defaultLoaded, true);
});

const ROUTES = [
  ['GET', '/api/contract/status'], ['GET', '/api/contract/models'], ['GET', '/api/runs'], ['GET', '/api/runs?id=run-nothing'],
  ['GET', '/api/agents/mission?id=mission-nothing'], ['POST', '/api/agents/missions/start', { goal: '' }], ['POST', '/api/runs/cancel', { id: 'run-nothing' }]
];

test('sign-in required: the six routes open with the hub key and are refused (401) without it or with a wrong one', { timeout: 40000 }, async t => {
  const { call } = await start(t, { env: { LOCALAI_SIGN_IN: 'required' } });
  for (const [method, p, body] of ROUTES) {
    assert.equal((await call(method, p, forwarded, body)).status, 401, `${method} ${p} without the key`);
    assert.equal((await call(method, p, { ...forwarded, 'X-LocalAI-Hub-Key': 'wrong' }, body)).status, 401, `${method} ${p} with a wrong key`);
    const ok = await call(method, p, H, body);
    assert.notEqual(ok.status, 401, `${method} ${p} with the key`);
  }
  // What the routes answer once signed in (the handlers' own statuses, unchanged).
  assert.equal((await call('POST', '/api/agents/missions/start', H, { goal: '' })).status, 400);
  assert.equal((await call('POST', '/api/runs/cancel', H, { id: 'run-nothing' })).status, 404);
  assert.equal((await call('GET', '/api/runs?id=run-nothing', H)).status, 404);
  assert.equal((await call('GET', '/api/agents/mission?id=mission-nothing', H)).status, 404);
  assert.equal((await call('GET', '/api/runs', H)).status, 200);
});

test('report mode: starting a Mission and cancelling a run need the key too (guarded writes), the reads stay as they were', { timeout: 40000 }, async t => {
  const { call } = await start(t);
  assert.equal((await call('POST', '/api/agents/missions/start', forwarded, { goal: 'x' })).status, 401);
  assert.equal((await call('POST', '/api/runs/cancel', forwarded, { id: 'run-nothing' })).status, 401);
  assert.equal((await call('POST', '/api/runs/cancel', H, { id: 'run-nothing' })).status, 404);
  assert.equal((await call('GET', '/api/runs', forwarded)).status, 200);
});

// `key: never`: routes that run code, write files, spend model time or change settings stay off the key, in both modes.
const NEVER = [
  ['POST', '/api/powershell/create', { title: 'x' }], ['POST', '/api/powershell/approve', {}], ['POST', '/api/runs/retry', { id: 'run-1' }],
  ['POST', '/api/runs/update', { id: 'run-1', pinned: true }], ['POST', '/api/runs/feedback', { id: 'run-1' }], ['POST', '/api/chat/stream', { messages: [] }],
  ['POST', '/api/models/pull', { name: 'x' }], ['POST', '/api/models/delete', { name: 'x' }], ['PUT', '/api/models/routing', { cloud: true }],
  ['POST', '/api/atlas/ask', { question: 'x' }], ['POST', '/api/atlas/goose', {}], ['POST', '/api/atlas/snapshot', {}],
  ['POST', '/api/agents/run', { goal: 'x' }], ['POST', '/api/agents/dispatch', { goal: 'x' }], ['POST', '/api/workbench/command', { command: 'ls' }],
  ['POST', '/api/computer/batch', {}], ['POST', '/api/repo/inspect', {}], ['POST', '/api/claude/chat/send', {}], ['GET', '/api/claude/board'],
  ['POST', '/api/changes/deploy-result', {}], ['POST', '/api/gridcraft/run', {}], ['POST', '/api/lab/sync', {}],
  // The six routes' own paths with another method are not opened either.
  ['POST', '/api/runs', {}], ['GET', '/api/runs/cancel'], ['GET', '/api/agents/missions/start'], ['POST', '/api/contract/status', {}], ['POST', '/api/agents/mission', {}]
];

test('key: never routes are refused (401) even with the hub key, in required mode', { timeout: 60000 }, async t => {
  const { call } = await start(t, { env: { LOCALAI_SIGN_IN: 'required' } });
  for (const [method, p, body] of NEVER) assert.equal((await call(method, p, H, body)).status, 401, `${method} ${p} with the hub key`);
});

test('key: never routes that the sign-in guard covers are refused with the hub key in report mode too', { timeout: 60000 }, async t => {
  const { call } = await start(t);
  // Report mode refuses only the routes the sign-in guard lists (the rest are open to everyone today, key or not).
  const guarded = NEVER.filter(([method, p]) => require('../app/signin').guarded(p, method) && !['/api/runs/cancel', '/api/agents/missions/start'].includes(p));
  assert.ok(guarded.length >= 15);
  for (const [method, p, body] of guarded) {
    const r = await call(method, p, H, body);
    assert.equal(r.status, 401, `${method} ${p} with the hub key`);
  }
});

test('the cross-site (403) and Host (421) checks still apply to a request that carries the hub key', { timeout: 40000 }, async t => {
  const { base, call } = await start(t, { env: { LOCALAI_SIGN_IN: 'required' } });
  const cross = await call('POST', '/api/runs/cancel', { ...H, 'Sec-Fetch-Site': 'cross-site' }, { id: 'run-nothing' });
  assert.equal(cross.status, 403);
  const origin = await call('POST', '/api/agents/missions/start', { ...H, Origin: 'https://evil.example' }, { goal: 'x' });
  assert.equal(origin.status, 403);
  const u = new URL(base);
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: '/api/contract/status', headers: { ...H, Host: 'evil.example.com' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(status, 421);
});

test('a Mission starts (202 {runId, threadId}), is followed by id, and cancels (200, then 409; unknown id 404), all with the hub key', { timeout: 60000 }, async t => {
  const chats = [];
  const slow = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'test-model' }] }));
      if (req.url !== '/api/chat') return res.end('{}');
      chats.push(raw);
      const timer = setTimeout(() => res.end(JSON.stringify({ message: { role: 'assistant', content: 'Slow answer' } })), 20000);
      res.on('close', () => clearTimeout(timer));
    });
  });
  slow.listen(0, '127.0.0.1'); await once(slow, 'listening');
  t.after(async () => { slow.closeAllConnections(); await new Promise(r => slow.close(r)); });
  const { call } = await start(t, { ollama: `http://127.0.0.1:${slow.address().port}`, env: { LOCALAI_SIGN_IN: 'required' } });

  const a = await call('POST', '/api/agents/missions/start', H, { goal: 'Review the code', agentIds: ['code_analyst'], async: true });
  assert.equal(a.status, 202, JSON.stringify(a.value));
  assert.equal(typeof a.value.runId, 'string');
  assert.equal(typeof a.value.threadId, 'string');
  for (let i = 0; i < 100 && !chats.length; i++) await new Promise(r => setTimeout(r, 50));

  const run = await call('GET', '/api/runs?id=' + a.value.runId, H);
  assert.equal(run.status, 200);
  for (const f of ['id', 'status', 'progress', 'events', 'cancellable', 'error', 'summary', 'meta']) assert.ok(f in run.value.item, `item.${f}`);
  assert.equal(run.value.item.cancellable, true);
  assert.ok(['queued', 'running', 'streaming'].includes(run.value.item.status));
  const list = await call('GET', '/api/runs', H);
  assert.ok(list.value.items.some(x => x.id === a.value.runId));
  const mission = await call('GET', '/api/agents/mission?id=' + run.value.item.meta.missionId, H);
  assert.equal(mission.status, 200);
  assert.ok(mission.value.mission && mission.value.mission.id);

  const cancel = await call('POST', '/api/runs/cancel', H, { id: a.value.runId });
  assert.equal(cancel.status, 200, JSON.stringify(cancel.value));
  assert.equal(cancel.value.item.status, 'cancelled');
  assert.equal((await call('POST', '/api/runs/cancel', H, { id: a.value.runId })).status, 409);
  assert.equal((await call('POST', '/api/runs/cancel', H, { id: 'run-nothing' })).status, 404);
});
