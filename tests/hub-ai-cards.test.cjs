'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { once } = require('node:events');
const { spawnAppServer } = require('./spawn-server.cjs');
const { buildFeed, aiCards } = require('../app/display-feed');

test('aiCards keeps only AI kinds and turns needs into approvals', () => {
  const feed = buildFeed({
    needs: { count: 2, speech: 'Needs you: two approvals.' },
    piNeeds: { count: 1, items: [{ id: 'x', title: 'Spool', tone: 'warn' }] },
    lab: [{ id: 'lab-1', title: 'Lab · E-021', text: 'Printing', tone: 'busy' }],
    watch: [{ id: 'w1', title: 'Disk filling', severity: 'high', since: Date.now() }],
    running: [{ id: 'r1', title: 'Render', startedAt: new Date().toISOString() }],
    done: [{ id: 'd1', title: 'Summary', status: 'completed', finishedAt: new Date().toISOString() }],
    weather: 'Sunny', images: [{ title: 'Cat', imageUrl: '/api/images/view?filename=a.png', at: 5 }],
    disk: { label: 'C:', totalBytes: 1e12, freeBytes: 5e11 },
    pi: { issues: [{ what: 'Fan', tone: 'bad' }], playing: [{ title: 'Movie', state: 'playing' }] },
    materials: { summary: { low: 1, loaded: 1, spools: 3, unknown: 0 } }
  });
  feed.messages = [{ seq: 1, text: 'hi' }];
  const ai = aiCards(feed);
  assert.deepEqual(Object.keys(ai).sort(), ['approvals', 'at', 'cards', 'images', 'messages', 'v']);
  assert.equal(ai.v, 2);
  assert.deepEqual([...new Set(ai.cards.map(c => c.kind))].sort(), ['disk', 'done', 'image', 'running', 'watch']);
  assert.equal(ai.approvals.count, 2);
  assert.equal(ai.approvals.speech, feed.cards.find(c => c.kind === 'needs').text);
  assert.equal(ai.images.length, 1);
  assert.deepEqual(ai.messages, feed.messages);
  assert.equal(ai.needs, undefined);
  assert.equal(aiCards({ at: 'x', cards: [] }).approvals.count, 0);
});

test('the hub key opens ai-cards, approvals, decide, ask and images/view and nothing else', { timeout: 30000 }, async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-hub-'));
  const key = 'hub_' + 'c'.repeat(40);
  const dead = 'http://127.0.0.1:9';
  const { child, ready } = spawnAppServer({ env: { DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, OLLAMA_URL: dead, SEARXNG_URL: dead, COMFY_URL: dead, N8N_URL: dead, PROXY_URL: dead, MAC_AI_HOME_URL: dead, MAC_DSH_URL: dead,
    LOCALAI_HUB_KEY_SHA256: crypto.createHash('sha256').update(key).digest('hex'), LOCALAI_SIGN_IN: 'required' } });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = await ready;
  const get = (p, h = {}, m = 'GET') => fetch(base + p, { method: m, headers: h });
  const H = { 'X-LocalAI-Hub-Key': key };
  const forwarded = { 'X-Forwarded-For': '10.0.0.50' }; // as if through Caddy, not the host itself

  assert.equal((await get('/api/display/ai-cards')).status, 401);
  assert.equal((await get('/api/display/ai-cards', { 'X-LocalAI-Hub-Key': 'wrong' })).status, 401);
  assert.equal((await get('/api/display/ai-cards', { ...forwarded, 'X-LocalAI-Display-Key': key })).status, 401);
  const ok = await get('/api/display/ai-cards', { ...forwarded, ...H });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.v, 2);
  assert.equal(typeof body.approvals.count, 'number');
  assert.ok(Array.isArray(body.cards));
  assert.ok(body.cards.every(c => ['watch', 'running', 'done', 'image', 'disk'].includes(c.kind)));

  assert.equal((await get('/api/display/approvals', { ...forwarded, ...H })).status, 200);
  assert.equal((await get('/api/display/approvals', forwarded)).status, 401);
  assert.notEqual((await get('/api/display/approvals/decide', { ...forwarded, ...H }, 'POST')).status, 401);
  assert.equal((await get('/api/display/approvals/decide', forwarded, 'POST')).status, 401);
  assert.equal((await get('/api/display/ask?q=running', { ...forwarded, ...H })).status, 200);
  assert.equal((await get('/api/display/ask?q=running', forwarded)).status, 401);
  assert.notEqual((await get('/api/images/view?filename=a.png', { ...forwarded, ...H })).status, 401);
  assert.equal((await get('/api/images/view?filename=a.png', forwarded)).status, 401);
  // Nothing else: not the changes API, not the display's feed or heartbeat.
  for (const [p, m] of [['/api/changes', 'GET'], ['/api/display/feed', 'GET'], ['/api/display/heartbeat', 'POST'], ['/api/display/printer/clear', 'POST']]) {
    assert.equal((await get(p, { ...forwarded, ...H }, m)).status, 401, p);
  }
});

test('an empty LOCALAI_HUB_KEY_SHA256 refuses every key', () => {
  const saved = process.env.LOCALAI_HUB_KEY_SHA256;
  try {
    const hubKey = require('../app/hub-key');
    process.env.LOCALAI_HUB_KEY_SHA256 = '';
    assert.equal(hubKey.authorized({ headers: { 'x-localai-hub-key': '' } }), false);
    assert.equal(hubKey.authorized({ headers: { 'x-localai-hub-key': 'k' } }), false);
    process.env.LOCALAI_HUB_KEY_SHA256 = crypto.createHash('sha256').update('k').digest('hex');
    assert.equal(hubKey.authorized({ headers: { 'x-localai-hub-key': 'k' } }), true);
    assert.equal(hubKey.authorized({ headers: { 'x-localai-hub-key': 'j' } }), false);
  } finally { if (saved === undefined) delete process.env.LOCALAI_HUB_KEY_SHA256; else process.env.LOCALAI_HUB_KEY_SHA256 = saved; }
});

test('ai-cards never calls Pi Hub, Bambuddy or the lab camera (it has a 3 s budget)', { timeout: 30000 }, async (t) => {
  const hits = [];
  const fake = http.createServer((req, res) => { hits.push(req.url); res.end('{}'); });
  fake.listen(0, '127.0.0.1');
  await once(fake, 'listening');
  const fakeUrl = `http://127.0.0.1:${fake.address().port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-hub-fast-'));
  const key = 'hub_' + 'd'.repeat(40);
  const dead = 'http://127.0.0.1:9';
  const { child, ready } = spawnAppServer({ env: { DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, OLLAMA_URL: dead, SEARXNG_URL: dead, COMFY_URL: dead, N8N_URL: dead, PROXY_URL: dead, MAC_AI_HOME_URL: dead, MAC_DSH_URL: dead,
    LOCALAI_PI_HUB_URL: fakeUrl, LOCALAI_MATERIALS_URL: fakeUrl, LOCALAI_BAMBUDDY_URL: fakeUrl, LOCALAI_LAB_CAMERA_URL: fakeUrl,
    LOCALAI_HUB_KEY_SHA256: crypto.createHash('sha256').update(key).digest('hex') } });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
    fake.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = await ready;
  hits.length = 0; // start-up may probe; only the route's own calls count
  const r = await fetch(`${base}/api/display/ai-cards`, { headers: { 'X-LocalAI-Hub-Key': key } });
  assert.equal(r.status, 200);
  assert.deepEqual(hits, [], 'ai-cards must not reach Pi Hub, Bambuddy or the camera');
});
