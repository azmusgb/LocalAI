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
  for (const item of runs.value.items) { assert.ok(item.card.icon, item.id); assert.ok(item.card.view, item.id); }
  assert.equal(native.card.icon, 'compose');

  const detail = await request(`/api/runs?id=${encodeURIComponent(chat.value.runId)}`);
  assert.equal(detail.response.status, 200);
  assert.equal(detail.value.item.id, chat.value.runId);
  assert.equal(detail.value.item.card.kind, 'chat');
  assert.equal(detail.value.item.card.icon, 'compose');
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

test('before pages the timeline by creation time', { timeout: 120000 }, async t => {
  const { request } = await startServer(t);
  const ids = [];
  for (let i = 0; i < 70; i++) ids.push((await request('/api/chat', { messages: [{ role: 'user', content: `q${i}` }], threadId: `th-${i}` })).value.runId);
  const first = await request('/api/runs?threads=1&limit=60');
  assert.equal(first.value.items.length, 60);
  const last = first.value.items[59].id;
  const rest = await request(`/api/runs?threads=1&before=${encodeURIComponent(last)}&limit=60`);
  assert.equal(rest.response.status, 200);
  assert.equal(rest.value.items.length, 10);
  const newest = new Set(first.value.items.map(x => x.id));
  assert.ok(rest.value.items.every(x => !newest.has(x.id)));
  assert.equal((await request('/api/runs?before=../x')).response.status, 400);
  assert.equal((await request('/api/runs?before=run-0-none')).response.status, 404);
});

// Show more must neither lose nor repeat a thread: threads page by their latest run's (createdAt, id), newest first.
test('threads page once each by creation, even when an old run was updated late; turns counts the thread', { timeout: 120000 }, async t => {
  const { request } = await startServer(t);
  const msg = [{ role: 'user', content: 'hi' }];
  const made = [];
  for (let i = 0; i < 62; i++) made.push((await request('/api/chat', { messages: msg, threadId: i % 20 === 5 ? 'multi' : `th-${i}` })).value.runId);
  // the 60th thread by creation was updated last: by updatedAt it would jump to the top of page 1 and come back on page 2
  const boundary = made[3];
  await request('/api/runs/update', { id: boundary, pinned: true });
  const seen = [];
  let before = '';
  for (let page = 0; page < 5; page++) {
    const r = await request(`/api/runs?threads=1&limit=30${before ? `&before=${encodeURIComponent(before)}` : ''}`);
    assert.equal(r.response.status, 200);
    if (!r.value.items.length) break;
    seen.push(...r.value.items);
    before = r.value.items.at(-1).id;
  }
  const threads = seen.map(x => x.threadId || x.id);
  assert.equal(new Set(threads).size, threads.length, 'no thread on two pages');
  assert.equal(new Set(seen.map(x => x.id)).size, seen.length);
  const expected = new Set(made.map((_, i) => (i % 20 === 5 ? 'multi' : `th-${i}`)));
  assert.equal(threads.length, expected.size, 'every thread appears exactly once');
  const ordered = seen.map(x => x.createdAt + x.id);
  assert.deepEqual(ordered, [...ordered].sort().reverse(), 'newest created first');
  const multi = seen.find(x => x.threadId === 'multi');
  assert.equal(multi.turns, 3);
  assert.equal(multi.id, made[45]);
  assert.equal(seen.find(x => x.threadId === 'th-0').turns, 1);
});

test('before pages past the 500-run window to the oldest run', { timeout: 180000 }, async t => {
  const { request } = await startServer(t);
  const msg = [{ role: 'user', content: 'hi' }];
  const ids = [];
  // the ledger prunes unkept runs at 250, so pin each run: kept runs are never pruned
  for (let i = 0; i < 520; i++) { const id = (await request('/api/chat', { messages: msg, threadId: `w-${i}` })).value.runId; await request('/api/runs/update', { id, pinned: true }); ids.push(id); }
  const seen = [];
  let before = '';
  for (let page = 0; page < 12; page++) {
    const r = await request(`/api/runs?threads=1&limit=60${before ? `&before=${encodeURIComponent(before)}` : ''}`);
    if (!r.value.items.length) break;
    seen.push(...r.value.items.map(x => x.id));
    before = r.value.items.at(-1).id;
  }
  assert.equal(seen.length, 520);
  assert.ok(seen.includes(ids[0]), 'the oldest run is reachable');
});

// Task 7: a mission started with async:true is a run from the first moment.
async function waitRun(request, id, done) {
  for (let i = 0; i < 400; i++) {
    const r = (await request('/api/runs?id=' + encodeURIComponent(id))).value.item;
    if (r && done(r)) return r;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('run never reached the expected state');
}
test('async mission start returns 202 with a run, records the mission id and completes the run', { timeout: 60000 }, async t => {
  const { request } = await startServer(t);
  const a = await request('/api/agents/missions/start', { goal: 'Review the product quality', agentIds: ['code_analyst'], async: true });
  assert.equal(a.response.status, 202, JSON.stringify(a.value));
  assert.match(a.value.runId, /^run-/);
  assert.ok(a.value.threadId);
  const first = (await request('/api/runs?id=' + a.value.runId)).value.item;
  assert.equal(first.type, 'agent');
  assert.equal(first.title, 'Review the product quality');
  assert.equal(first.input.goal, 'Review the product quality');
  const run = await waitRun(request, a.value.runId, r => r.status === 'completed' || r.status === 'failed');
  assert.equal(run.status, 'completed', JSON.stringify(run));
  assert.match(run.meta.missionId, /^mission-/);
  assert.equal(run.output.missionId, run.meta.missionId);
  assert.equal(run.output.outcome, 'complete');
  assert.ok(run.summary);
  const list = (await request('/api/runs?type=agent')).value.items.find(x => x.id === run.id);
  assert.equal(list.card.preview.type, 'mission');
});
test('a mission that cannot run ends its run failed with an error', { timeout: 120000 }, async t => {
  const { request } = await startServer(t, { OLLAMA_URL: 'http://127.0.0.1:9' });
  const a = await request('/api/agents/missions/start', { goal: 'Review the code', agentIds: ['code_analyst'], async: true });
  assert.equal(a.response.status, 202, JSON.stringify(a.value));
  const run = await waitRun(request, a.value.runId, r => r.status === 'completed' || r.status === 'failed');
  assert.equal(run.status, 'failed', JSON.stringify(run));
  assert.ok(run.error);
});
test('mission start without async still answers with the mission', { timeout: 60000 }, async t => {
  const { request } = await startServer(t);
  const a = await request('/api/agents/missions/start', { goal: 'Review the product quality', agentIds: ['code_analyst'] });
  assert.equal(a.response.status, 200);
  assert.equal(a.value.mission.status, 'complete');
  assert.equal(a.value.runId, undefined);
});
