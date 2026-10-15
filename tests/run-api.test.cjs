'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

async function startServer(t, extraEnv = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-runs-'));
  const mock = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'test-model' }] }));
      if (req.url === '/api/ps') return res.end(JSON.stringify({ models: [] }));
      res.end(JSON.stringify({ message: { content: 'Run API result' } }));
    });
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  const mockUrl = `http://127.0.0.1:${mock.address().port}`;

  const reserve = http.createServer();
  reserve.listen(0, '127.0.0.1');
  await once(reserve, 'listening');
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  let diagnostics = '';
  const child = spawn(process.execPath, [path.resolve(__dirname, '../app/server.js')], {
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(port),
      OLLAMA_URL: mockUrl,
      MODEL: 'test-model',
      SELF_APP_ROOT: path.resolve(__dirname, '../app'),
      WORKSPACE_ROOT: dataDir,
      COMFY_URL: 'http://127.0.0.1:9',
      N8N_URL: 'http://127.0.0.1:9',
      PROXY_URL: 'http://127.0.0.1:9',
      SEARXNG_URL: 'http://127.0.0.1:9',
      MAC_AI_HOME_URL: 'http://127.0.0.1:9',
      MAC_DSH_URL: 'http://127.0.0.1:9',
      ...extraEnv
    }
  });
  child.stdout.on('data', chunk => diagnostics += chunk);
  child.stderr.on('data', chunk => diagnostics += chunk);

  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const done = once(child, 'exit');
    child.kill('SIGTERM');
    await done;
  };
  t.after(async () => {
    await stop();
    mock.closeAllConnections();
    await new Promise(resolve => mock.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) throw new Error(diagnostics);
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch {}
    if (attempt === 79) throw new Error(`Server did not start: ${diagnostics}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  const request = async (url, body) => {
    const response = await fetch(base + url, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const value = await response.json();
    return { response, value };
  };

  return { request, base };
}

test('unified run API exposes native chat plus legacy execution history and retry lineage', { timeout: 30000 }, async t => {
  const { request } = await startServer(t);

  const empty = await request('/api/runs?limit=20');
  assert.equal(empty.response.status, 200);
  assert.deepEqual(empty.value.items, []);

  const chat = await request('/api/chat', { messages: [{ role: 'user', content: 'Create a durable run' }] });
  assert.equal(chat.response.status, 200);
  assert.ok(chat.value.runId);

  const agent = await request('/api/agents/run', { goal: 'Legacy adapter check' });
  assert.equal(agent.response.status, 200);
  assert.equal(agent.value.run.status, 'complete');
  const legacyAgentId = `legacy-agent:${agent.value.run.id}`;

  const runs = await request('/api/runs?limit=20');
  assert.equal(runs.response.status, 200);
  const native = runs.value.items.find(item => item.id === chat.value.runId);
  assert.equal(native.status, 'completed');
  assert.equal(native.type, 'chat');
  assert.equal(native.output.text, 'Run API result');
  assert.equal(native.attempt, 1);
  assert.equal(native.retryOf, null);
  assert.ok(runs.value.items.some(item => item.id === legacyAgentId && item.status === 'completed'));

  const detail = await request(`/api/runs?id=${encodeURIComponent(chat.value.runId)}`);
  assert.equal(detail.response.status, 200);
  assert.equal(detail.value.item.id, chat.value.runId);
  assert.ok(detail.value.item.events.some(event => event.status === 'completed'));

  const nativeRetry = await request('/api/runs/retry', { id: chat.value.runId });
  assert.equal(nativeRetry.response.status, 200);
  assert.ok(nativeRetry.value.runId);
  assert.equal(nativeRetry.value.replayedFrom, chat.value.runId);
  assert.equal(nativeRetry.value.attempt, 2);
  const nativeRetryDetail = await request(`/api/runs?id=${encodeURIComponent(nativeRetry.value.runId)}`);
  assert.equal(nativeRetryDetail.response.status, 200);
  assert.equal(nativeRetryDetail.value.item.attempt, 2);
  assert.equal(nativeRetryDetail.value.item.retryOf, chat.value.runId);
  assert.ok(nativeRetryDetail.value.item.events.some(event => /Retried from/.test(event.detail)));

  const legacyRetry = await request('/api/runs/retry', { id: legacyAgentId });
  assert.equal(legacyRetry.response.status, 200);
  assert.match(legacyRetry.value.runId, /^legacy-agent:/);
  assert.equal(legacyRetry.value.replayedFrom, legacyAgentId);
  assert.equal(legacyRetry.value.attempt, 2);
  const legacyRetryDetail = await request(`/api/runs?id=${encodeURIComponent(legacyRetry.value.runId)}`);
  assert.equal(legacyRetryDetail.response.status, 200);
  assert.equal(legacyRetryDetail.value.item.attempt, 2);
  assert.equal(legacyRetryDetail.value.item.retryOf, legacyAgentId);

  const cancelFinished = await request('/api/runs/cancel', { id: chat.value.runId });
  assert.equal(cancelFinished.response.status, 409);

  const missingRetry = await request('/api/runs/retry', { id: 'missing-run' });
  assert.equal(missingRetry.response.status, 409);
});

test('runs can be pinned and filed', { timeout: 30000 }, async t => {
  const { request } = await startServer(t);
  const project = await request('/api/projects/create', { name: 'Filing' });
  assert.equal(project.response.status, 201);
  const pid = project.value.item.id;
  const a = await request('/api/chat', { messages: [{ role: 'user', content: 'one' }] });
  await request('/api/chat', { messages: [{ role: 'user', content: 'two' }] });
  const upd = await request('/api/runs/update', { id: a.value.runId, pinned: true, projectId: pid });
  assert.equal(upd.response.status, 200);
  assert.equal(upd.value.item.pinned, true);
  assert.equal(upd.value.item.projectId, pid);
  const filed = await request(`/api/runs?projectId=${encodeURIComponent(pid)}`);
  assert.deepEqual(filed.value.items.map(x => x.id), [a.value.runId]);
  const unfiled = await request('/api/runs/update', { id: a.value.runId, projectId: null });
  assert.equal(unfiled.value.item.projectId, null);
  assert.equal(unfiled.value.item.pinned, true);
  assert.equal((await request(`/api/runs?projectId=${encodeURIComponent(pid)}`)).value.items.length, 0);
});

test('update rejects unknown project, bad ids and legacy runs', { timeout: 30000 }, async t => {
  const { request } = await startServer(t);
  const a = await request('/api/chat', { messages: [{ role: 'user', content: 'one' }] });
  assert.equal((await request('/api/runs/update', { id: a.value.runId, projectId: 'prj-missing' })).response.status, 404);
  assert.equal((await request('/api/runs/update', { id: a.value.runId, projectId: 'bad id!' })).response.status, 400);
  assert.equal((await request('/api/runs/update', { id: '../../x', pinned: true })).response.status, 400);
  assert.equal((await request('/api/runs/update', { id: 'run-nope', pinned: true })).response.status, 404);
  const agent = await request('/api/agents/run', { goal: 'Legacy' });
  const legacy = await request('/api/runs/update', { id: `legacy-agent:${agent.value.run.id}`, pinned: true });
  assert.equal(legacy.response.status, 409);
  assert.equal(legacy.value.error, 'This run is managed by its own page and cannot be filed yet');
});

test('chat turns share a thread', { timeout: 30000 }, async t => {
  const { request } = await startServer(t);
  const msg = [{ role: 'user', content: 'hi' }];
  await request('/api/chat', { messages: msg, threadId: 'th-1' });
  await request('/api/chat', { messages: msg, threadId: 'th-1' });
  const bad = await request('/api/chat', { messages: msg, threadId: 'bad id!' });
  const all = await request('/api/runs?threadId=th-1');
  assert.equal(all.value.items.length, 2);
  const collapsed = await request('/api/runs?threads=1');
  assert.equal(collapsed.value.items.filter(x => x.threadId === 'th-1').length, 1);
  const own = await request(`/api/runs?id=${encodeURIComponent(bad.value.runId)}`);
  assert.equal(own.value.item.threadId, bad.value.runId);
});

test('filters apply before the limit', { timeout: 60000 }, async t => {
  const { request } = await startServer(t);
  const project = await request('/api/projects/create', { name: 'Old' });
  const pid = project.value.item.id;
  const msg = [{ role: 'user', content: 'hi' }];
  const first = await request('/api/chat', { messages: msg });
  for (let i = 0; i < 7; i++) await request('/api/chat', { messages: msg });
  await request('/api/runs/update', { id: first.value.runId, projectId: pid });
  const limited = await request(`/api/runs?projectId=${encodeURIComponent(pid)}&limit=5`);
  assert.deepEqual(limited.value.items.map(x => x.id), [first.value.runId]);
  assert.equal((await request('/api/runs?limit=5')).value.items.length, 5);
});

test('image runs share a thread', { timeout: 60000 }, async t => {
  const comfy = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url.startsWith('/object_info/CheckpointLoaderSimple')) return res.end(JSON.stringify({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [['sd15.safetensors']] } } } }));
      if (req.url === '/prompt') return res.end(JSON.stringify({ prompt_id: 'p1' }));
      if (req.url.startsWith('/history/')) return res.end(JSON.stringify({ p1: { status: { status_str: 'success' }, outputs: { 9: { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] } } } }));
      res.end('{}');
    });
  });
  comfy.listen(0, '127.0.0.1');
  await once(comfy, 'listening');
  t.after(async () => { comfy.closeAllConnections(); await new Promise(resolve => comfy.close(resolve)); });
  const { request } = await startServer(t, { COMFY_URL: `http://127.0.0.1:${comfy.address().port}` });
  const a = await request('/api/images/generate', { prompt: 'a cat', threadId: 'img-th' });
  assert.equal(a.response.status, 200, JSON.stringify(a.value));
  assert.equal(a.value.threadId, 'img-th');
  const b = await request('/api/images/generate', { prompt: 'a cat again', threadId: 'img-th' });
  assert.equal(b.response.status, 200);
  const imgs = await request('/api/runs?threadId=img-th&type=image');
  assert.equal(imgs.value.items.length, 2);
  assert.equal((await request('/api/runs?threads=1&type=image')).value.items.length, 1);
});
