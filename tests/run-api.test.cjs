'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

// seed(storage) writes records (older legacy runs, say) before the server starts.
async function startServer(t, extraEnv = {}, seed = null) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-runs-'));
  if (seed) { const { Storage } = require('../app/storage'); const storage = new Storage({ dataDir }); seed(storage); storage.close?.(); }
  const ollamaCalls = []; // every /api/chat and /api/generate body Ollama received, in order
  const mock = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      if (req.url === '/api/chat' || req.url === '/api/generate') { try { ollamaCalls.push({ url: req.url, body: JSON.parse(raw) }); } catch {} }
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

  return { request, base, ollamaCalls };
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

// ComfyUI stops answering while it loads a big model (Z-Image's 12 GB on the owner's 6 GB GPU): a history check that
// times out is "not done yet", not a failed image. The first check here answers only after the 7 s per-check limit.
test('an image survives a ComfyUI that is too busy to answer one progress check', { timeout: 60000 }, async t => {
  let checks = 0;
  const comfy = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url.startsWith('/object_info/CheckpointLoaderSimple')) return res.end(JSON.stringify({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [['sd15.safetensors']] } } } }));
      if (req.url === '/prompt') return res.end(JSON.stringify({ prompt_id: 'p1' }));
      if (req.url.startsWith('/history/')) {
        const done = () => res.end(JSON.stringify({ p1: { status: { status_str: 'success' }, outputs: { 9: { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] } } } }));
        if (++checks === 1) return setTimeout(() => { if (!res.writableEnded) done(); }, 8000);
        return done();
      }
      res.end('{}');
    });
  });
  comfy.listen(0, '127.0.0.1');
  await once(comfy, 'listening');
  t.after(async () => { comfy.closeAllConnections(); await new Promise(resolve => comfy.close(resolve)); });
  const { request } = await startServer(t, { COMFY_URL: `http://127.0.0.1:${comfy.address().port}` });
  const made = await request('/api/images/generate', { prompt: 'a lighthouse' });
  assert.equal(made.response.status, 200, JSON.stringify(made.value));
  assert.ok(checks >= 2, 'it asked again after the slow check');
  const run = (await request(`/api/runs?limit=1&type=image`)).value.items[0];
  assert.equal(run.status, 'completed');
});

// A ComfyUI with Z-Image Turbo's three files: Best runs it, and the chat's capability snapshot names it.
test('Z-Image Turbo: Best engine, its graph, and the chat snapshot', { timeout: 60000 }, async t => {
  const queued = [];
  const lists = {
    CheckpointLoaderSimple: ['ckpt_name', ['sd15.safetensors']],
    UNETLoader: ['unet_name', ['z_image_turbo_bf16.safetensors']],
    CLIPLoader: ['clip_name', ['qwen_3_4b.safetensors', 'clip_l.safetensors']],
    VAELoader: ['vae_name', ['ae.safetensors']]
  };
  const comfy = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      const node = req.url.startsWith('/object_info/') ? req.url.slice('/object_info/'.length) : null;
      if (node && !lists[node]) { res.writeHead(404); return res.end('{}'); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (node) return res.end(JSON.stringify({ [node]: { input: { required: { [lists[node][0]]: [lists[node][1]] } } } }));
      if (req.url === '/prompt') { queued.push(JSON.parse(raw).prompt); return res.end(JSON.stringify({ prompt_id: 'z1' })); }
      if (req.url.startsWith('/history/')) return res.end(JSON.stringify({ z1: { status: { status_str: 'success' }, outputs: { 9: { images: [{ filename: 'z.png', subfolder: '', type: 'output' }] } } } }));
      res.end('{}');
    });
  });
  comfy.listen(0, '127.0.0.1');
  await once(comfy, 'listening');
  t.after(async () => { comfy.closeAllConnections(); await new Promise(resolve => comfy.close(resolve)); });
  const { request, ollamaCalls } = await startServer(t, { COMFY_URL: `http://127.0.0.1:${comfy.address().port}` });

  const models = await request('/api/images/models');
  const best = models.value.engines.find(x => x.id === 'best');
  assert.deepEqual([best.label, best.family, best.model, best.base], ['Best', 'zimage', 'Z-Image Turbo', 1024]);

  const made = await request('/api/images/generate', { prompt: 'a lighthouse at dusk', engine: 'best', style: 'photo', aspect: 'portrait' });
  assert.equal(made.response.status, 200, JSON.stringify(made.value));
  assert.deepEqual([made.value.family, made.value.width, made.value.height, made.value.steps, made.value.cfg], ['zimage', 832, 1216, 8, 1]);
  const g = queued[0];
  assert.equal(g[1].class_type, 'UNETLoader');
  assert.equal(g[13].class_type, 'ModelSamplingAuraFlow');
  assert.equal(g[7].inputs.sampler_name, 'res_multistep');
  assert.match(g[4].inputs.text, /^a lighthouse at dusk, professional photograph/);
  // The Photo style's "avoid" words go nowhere: cfg 1 would ignore them.
  assert.ok(!JSON.stringify(g).includes('cartoon'));

  await request('/api/chat', { messages: [{ role: 'user', content: 'Which image models do you have?' }] });
  const system = ollamaCalls.filter(c => c.url === '/api/chat').flatMap(c => c.body.messages || []).filter(m => m.role === 'system').map(m => m.content).join('\n');
  assert.match(system, /Best = Z-Image Turbo \(z_image_turbo_bf16\.safetensors, qwen_3_4b\.safetensors, ae\.safetensors\)/);
  assert.match(system, /Image models are not Ollama models/);
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

test('/api/access reports the Tailscale name only when it is a real host name', { timeout: 60000 }, async t => {
  for (const [value, want] of [['LocalAI-PC.tail1234.ts.net.', 'localai-pc.tail1234.ts.net'], ['localai.remote.invalid', ''], ['not a name', ''], ['', '']]) {
    const { request } = await startServer(t, { LOCALAI_REMOTE_NAME: value });
    const r = await request('/api/access');
    assert.equal(r.response.status, 200);
    assert.deepEqual(r.value, { remoteName: want }, value);
  }
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

test('mission runs investigate with tools and can be cancelled', { timeout: 60000 }, async t => {
  const chats = [];
  const slow = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'test-model' }] }));
      if (req.url !== '/api/chat') return res.end('{}');
      chats.push(JSON.parse(raw));
      const timer = setTimeout(() => res.end(JSON.stringify({ message: { role: 'assistant', content: 'Slow answer' } })), 20000);
      res.on('close', () => clearTimeout(timer));
    });
  });
  slow.listen(0, '127.0.0.1');
  await once(slow, 'listening');
  t.after(async () => { slow.closeAllConnections(); await new Promise(resolve => slow.close(resolve)); });
  const { request } = await startServer(t, { OLLAMA_URL: `http://127.0.0.1:${slow.address().port}` });
  const a = await request('/api/agents/missions/start', { goal: 'Review the code', agentIds: ['code_analyst'], async: true });
  assert.equal(a.response.status, 202, JSON.stringify(a.value));
  for (let i = 0; i < 100 && !chats.some(c => Array.isArray(c.tools)); i++) await new Promise(r => setTimeout(r, 50));
  const turn = chats.find(c => Array.isArray(c.tools));
  assert.ok(turn, 'the specialist turn reached the model with tools');
  assert.ok(turn.tools.some(x => x.function.name === 'read_project_file'));
  assert.ok(!turn.tools.some(x => x.function.name === 'search_web'), 'web search stays off unless asked for');
  assert.equal(turn.options.num_ctx, 32768);
  assert.equal((await request('/api/runs?id=' + a.value.runId)).value.item.cancellable, true);
  const cancel = await request('/api/runs/cancel', { id: a.value.runId });
  assert.equal(cancel.response.status, 200, JSON.stringify(cancel.value));
  const run = await waitRun(request, a.value.runId, r => r.status === 'cancelled');
  const missionId = run.meta.missionId;
  for (let i = 0; i < 100; i++) {
    const m = (await request('/api/agents/mission?id=' + missionId)).value?.mission;
    if (m && m.status !== 'running') { assert.equal(m.status, 'error'); return; }
    await new Promise(r => setTimeout(r, 50));
  }
  assert.fail('the mission kept running after its run was cancelled');
});

test('text-model calls use one 8192 context, stay warm, and take turns with images', { timeout: 60000 }, async t => {
  const order = [];
  const comfy = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url.startsWith('/object_info/CheckpointLoaderSimple')) return res.end(JSON.stringify({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [['sd15.safetensors']] } } } }));
      if (req.url === '/prompt') { order.push('comfy'); return res.end(JSON.stringify({ prompt_id: 'p1' })); }
      if (req.url.startsWith('/history/')) return res.end(JSON.stringify({ p1: { status: { status_str: 'success' }, outputs: { 9: { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] } } } }));
      res.end('{}');
    });
  });
  comfy.listen(0, '127.0.0.1');
  await once(comfy, 'listening');
  t.after(async () => { comfy.closeAllConnections(); await new Promise(resolve => comfy.close(resolve)); });
  const { request, base, ollamaCalls } = await startServer(t, { COMFY_URL: `http://127.0.0.1:${comfy.address().port}` });
  const waitFor = async (fn) => { for (let i = 0; i < 100 && !fn(); i++) await new Promise(r => setTimeout(r, 50)); };

  // Startup: exactly one background warm-up.
  await waitFor(() => ollamaCalls.some(c => c.url === '/api/generate'));
  assert.equal(ollamaCalls.filter(c => c.url === '/api/generate').length, 1);
  const warm = ollamaCalls.find(c => c.url === '/api/generate').body;
  assert.equal(warm.model, 'test-model');
  assert.equal(warm.keep_alive, '30m');
  assert.equal(warm.options.num_ctx, 8192);
  assert.equal(warm.options.num_predict, 1);
  ollamaCalls.length = 0;

  // A long conversation is trimmed to fit and uses the one context.
  const big = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i} ` + 'w'.repeat(9000) }));
  big.push({ role: 'user', content: 'final question' });
  const chat = await request('/api/chat', { messages: big });
  assert.equal(chat.response.status, 200);
  const chatCall = ollamaCalls.find(c => c.url === '/api/chat').body;
  assert.equal(chatCall.messages.at(-1).content, 'final question');
  assert.ok(chatCall.messages.map(m => m.content).join('').length / 3.5 <= 8192 - 1024);

  const stream = await fetch(`${base}/api/chat/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi stream' }] }) });
  await stream.text();
  const raw = (url, body) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.text());
  await raw('/api/glance/ask', { text: 'what is up glance' });
  await raw('/api/agents/run', { goal: 'agent goal here' });
  await raw('/api/changes/plan', { request: 'Change request for planner', target: 'self' }); // the mock's reply is not a patch plan; only the request matters

  // Every text-model request, on every path, shares the one context and keep-alive (the planner alone gets the large one).
  const chats = ollamaCalls.filter(c => c.url === '/api/chat').map(c => c.body);
  const has = text => chats.find(b => b.messages.some(m => String(m.content).includes(text)));
  assert.equal(chats.length, 5, 'chat, stream, glance, agent, planner');
  for (const [name, text, ctx] of [['chat', 'final question', 8192], ['stream', 'hi stream', 8192], ['glance', 'what is up glance', 8192], ['agent', 'agent goal here', 8192], ['planner', 'CHANGE REQUEST', 32768]]) {
    const b = has(text);
    assert.ok(b, `${name} request captured`);
    assert.equal(b.options.num_ctx, ctx, name);
    assert.equal(b.keep_alive, '30m', name);
  }
  const planner = has('CHANGE REQUEST');
  assert.ok(planner.messages.map(m => m.content).join('').length / 3.5 <= 32768 - 4096);

  const origPush = ollamaCalls.push.bind(ollamaCalls);
  ollamaCalls.push = (...a) => { if (a[0].url === '/api/generate') order.push(a[0].body.keep_alive === 0 ? 'unload' : 'warm'); return origPush(...a); };
  // An image request unloads the text model first, then warms it again afterwards.
  const generates = () => ollamaCalls.filter(c => c.url === '/api/generate');
  const before = generates().length;
  const img = await request('/api/images/generate', { prompt: 'a cat' });
  assert.equal(img.response.status, 200, JSON.stringify(img.value));
  await waitFor(() => generates().length >= before + 2);
  const after = generates().slice(before);
  assert.equal(after.length, 2);
  assert.equal(after[0].body.keep_alive, 0);
  assert.equal(after[1].body.keep_alive, '30m');
  assert.deepEqual(order, ['unload', 'comfy', 'warm']);
});

// Legacy runs (old missions, Change Local AI requests) live in their own stores, never in the ledger.
const OLD = '2020-01-01T00:00:00.000Z', OLDER = '2019-12-31T00:00:00.000Z';
const seedLegacy = s => {
  s.put('engineeringRuns', { id: 'eng-old', request: 'Add a dark mode toggle', target: 'self', status: 'completed', createdAt: OLD, updatedAt: OLD, steps: [] });
  s.put('agentRuns', { id: 'mission-old', goal: 'Summarise the inbox', status: 'complete', createdAt: OLDER, updatedAt: OLDER, plan: [] });
};

test('a legacy run older than the newest 120 still opens by id', { timeout: 120000 }, async t => {
  const { request } = await startServer(t, {}, seedLegacy);
  for (let i = 0; i < 130; i++) await request('/api/chat', { messages: [{ role: 'user', content: `q${i}` }], threadId: `th-${i}` });
  assert.ok(!(await request('/api/runs')).value.items.some(x => x.id === 'legacy-engineering:eng-old'), 'outside the newest 120');
  const r = await request('/api/runs?id=' + encodeURIComponent('legacy-engineering:eng-old'));
  assert.equal(r.response.status, 200, JSON.stringify(r.value));
  assert.equal(r.value.item.id, 'legacy-engineering:eng-old');
  assert.equal(r.value.item.card.kind, 'engineering');
  assert.equal((await request('/api/runs?id=' + encodeURIComponent('legacy-engineering:none'))).response.status, 404);
});

// Work's chips ask the server for one kind, so a kind the newest page holds none of is still reachable.
test('kind filters the threads timeline before before and limit', { timeout: 120000 }, async t => {
  const { request } = await startServer(t, {}, seedLegacy);
  const chats = [];
  for (let i = 0; i < 70; i++) chats.push((await request('/api/chat', { messages: [{ role: 'user', content: `q${i}` }], threadId: `th-${i}` })).value.runId);
  const missions = await request('/api/runs?threads=1&kind=missions&limit=60');
  assert.equal(missions.response.status, 200);
  assert.deepEqual(missions.value.items.map(x => x.id), ['legacy-agent:mission-old']);
  assert.deepEqual((await request('/api/runs?threads=1&kind=changes&limit=60')).value.items.map(x => x.id), ['legacy-engineering:eng-old']);
  assert.deepEqual((await request('/api/runs?threads=1&kind=images&limit=60')).value.items, []);
  const first = await request('/api/runs?threads=1&kind=chats&limit=60');
  assert.equal(first.value.items.length, 60);
  assert.ok(first.value.items.every(x => x.type === 'chat'));
  const rest = await request(`/api/runs?threads=1&kind=chats&limit=60&before=${encodeURIComponent(first.value.items[59].id)}`);
  assert.equal(rest.value.items.length, 10, 'the 10 older chats, not the mission or the change');
  assert.ok(rest.value.items.every(x => x.type === 'chat'));
  // before a chat, in Missions: the older mission
  const older = await request(`/api/runs?threads=1&kind=missions&limit=60&before=${encodeURIComponent(chats[0])}`);
  assert.deepEqual(older.value.items.map(x => x.id), ['legacy-agent:mission-old']);
  assert.deepEqual((await request(`/api/runs?threads=1&kind=missions&before=${encodeURIComponent('legacy-agent:mission-old')}`)).value.items, []);
  assert.equal((await request('/api/runs?threads=1&kind=all')).value.items.length, 72, 'all means no filter');
  assert.equal((await request('/api/runs?threads=1&kind=nonsense')).response.status, 400);
});

// Work › Missions showed "om the supplied source, …" for an older specialist run. A build that ran on the appliance
// around 14 Oct wrote each specialist and mission into the ledger itself (type 'specialist'/'mission', input {}, title =
// the goal). The stored goal was already missing "Fr" everywhere (mission, worker, ledger row): the request arrived that
// way, so the text can't be recovered. Listing must still show such a row's title whole, and a new mission keeps the
// start of its goal.
const GOAL = 'From the supplied source, identify one mission completion behavior. Cite the source file. Limit your answer to three bullets.';
const seedSpecialist = s => {
  const at = '2026-10-14T23:56:54.381Z';
  s.writeSetting('unified-run/run-1792022214381-8545b46', { id: 'run-1792022214381-8545b46', projectId: null, threadId: 'run-1792022214381-8545b46', pinned: false, type: 'specialist', title: GOAL, status: 'completed', progress: 100, createdAt: at, startedAt: at, updatedAt: at, finishedAt: at, summary: '', input: {}, output: '- one\n- two', error: null, artifactIds: [], source: { id: 'spec-mv8rra3x-77ea11', type: 'specialist' }, meta: { sourceId: 'spec-mv8rra3x-77ea11', missionId: 'mission-mv8rra37-318475', phase: 'complete' }, cancellable: false, retryRequest: null, attempt: 1, retryOf: null, events: [{ at, status: 'completed', detail: 'complete' }] });
  s.put('specialistRuns', { id: 'spec-mv8rra3x-77ea11', agentId: 'research_agent', goal: GOAL, status: 'complete', createdAt: at, updatedAt: at, ledgerId: 'run-1792022214381-8545b46' });
};
test('an older specialist run lists in Missions with its whole title', { timeout: 60000 }, async t => {
  const { request } = await startServer(t, {}, seedSpecialist);
  const rows = (await request('/api/runs?threads=1&kind=missions&limit=50')).value.items;
  const row = rows.find(x => x.id === 'run-1792022214381-8545b46');
  assert.ok(row, JSON.stringify(rows.map(x => x.id)));
  assert.equal(row.title, GOAL);
  assert.equal(row.card.title, GOAL);
  assert.equal(row.card.kind, 'agent');
  assert.equal((await request('/api/runs?id=run-1792022214381-8545b46')).value.item.card.title, GOAL);
  const a = await request('/api/agents/missions/start', { goal: GOAL, agentIds: ['code_analyst'], async: true });
  assert.equal(a.response.status, 202, JSON.stringify(a.value));
  const run = (await request('/api/runs?id=' + a.value.runId)).value.item;
  assert.ok(run.title.startsWith('From the supplied source, identify'), run.title);
  assert.equal(run.input.goal, GOAL);
  await waitRun(request, a.value.runId, r => r.status === 'completed' || r.status === 'failed');
});
