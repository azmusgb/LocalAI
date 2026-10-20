'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { buildFeed, jpegUrl } = require('../app/display-feed');
const { spawnAppServer } = require('./spawn-server.cjs');

test('nothing to report is one All clear card', () => {
  const f = buildFeed({ needs: { count: 0, speech: 'Nothing needs you right now.' } });
  assert.deepEqual(f.cards.map((c) => [c.kind, c.title, c.tone]), [['needs', 'All clear', 'ok']]);
});

test('needs, watchdog findings, running work, weather and the latest image become cards in that order', () => {
  const f = buildFeed({
    needs: { count: 2, speech: 'Needs you: 1 approval and 1 failed run. One run is in progress.' },
    watch: [{ severity: 'high', title: 'Mac disk is 97% full' }, { severity: 'medium', title: 'b' }, { severity: 'medium', title: 'c' }],
    running: [{ title: 'Research NAS drives' }, { title: 'x' }],
    weather: '72° and sunny.',
    image: { title: 'A red fox', imageUrl: '/api/images/view?filename=a.png&preview=jpeg%3B80' }
  });
  assert.deepEqual(f.cards.map((c) => c.kind), ['needs', 'watch', 'watch', 'running', 'weather', 'image']);
  assert.equal(f.cards[0].text, '1 approval and 1 failed run.');
  assert.equal(f.cards[1].tone, 'attention');
  assert.equal(f.cards[3].text, 'Research NAS drives · 1 more');
});

test('text is cut to what fits a 480x320 card', () => {
  const f = buildFeed({ needs: { count: 0 }, running: [{ title: 'x'.repeat(300) }] });
  const c = f.cards.find((k) => k.kind === 'running');
  assert.equal([...c.text].length, 90);
  assert.ok(c.text.endsWith('…'));
});

test('image links ask ComfyUI for a JPEG; anything else is refused', () => {
  assert.equal(jpegUrl('/api/images/view?filename=a.png&subfolder=&type=output'), '/api/images/view?filename=a.png&subfolder=&type=output&preview=jpeg%3B80');
  assert.equal(jpegUrl('https://evil.example/x.png'), null);
  assert.equal(jpegUrl(null), null);
});

test('GET /api/display/feed answers cards with no model and no setup', { timeout: 30000 }, async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-feed-'));
  const dead = 'http://127.0.0.1:9';
  const { child, ready } = spawnAppServer({ env: { DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, OLLAMA_URL: dead, SEARXNG_URL: dead, COMFY_URL: dead, N8N_URL: dead, PROXY_URL: dead, MAC_AI_HOME_URL: dead, MAC_DSH_URL: dead } });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = await ready;
  const r = await fetch(`${base}/api/display/feed`);
  assert.equal(r.status, 200);
  const feed = await r.json();
  assert.ok(Date.parse(feed.at));
  assert.equal(feed.cards[0].kind, 'needs');
  for (const c of feed.cards) { assert.ok([...c.title].length <= 24); assert.ok([...c.text].length <= 90); }
});

test('GET /api/display/ask answers the three fixed questions, and refuses others', { timeout: 30000 }, async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-ask-'));
  const dead = 'http://127.0.0.1:9';
  const { child, ready } = spawnAppServer({ env: { DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, OLLAMA_URL: dead, SEARXNG_URL: dead, COMFY_URL: dead, N8N_URL: dead, PROXY_URL: dead, MAC_AI_HOME_URL: dead, MAC_DSH_URL: dead } });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = await ready;
  for (const q of ['needs', 'running', 'health']) {
    const r = await fetch(`${base}/api/display/ask?q=${q}`);
    assert.equal(r.status, 200, q);
    const j = await r.json();
    assert.equal(j.question, q);
    assert.ok(j.answer.length > 5 && [...j.answer].length <= 200, q);
  }
  assert.equal((await (await fetch(`${base}/api/display/ask?q=running`)).json()).answer, 'Nothing is running right now.');
  assert.equal((await fetch(`${base}/api/display/ask?q=delete-everything`)).status, 400);
});
