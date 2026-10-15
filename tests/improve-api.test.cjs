'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { Storage } = require('../app/storage');

const APP = path.resolve(__dirname, '../app');
const RELEASE = { commit: 'a'.repeat(40), version: '2.0.300', deployedAt: '2026-10-15T20:00:00.000Z' };

async function freePort() {
  const s = http.createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening');
  const port = s.address().port; await new Promise(r => s.close(r)); return port;
}

// Starts a server on its own data folder. `seed(storage)` runs first; `release` runs a copy of app/ with a release.json.
async function startServer(t, { seed, release } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-improve-'));
  if (seed) { const storage = new Storage({ dataDir }); seed(storage); storage.close?.(); }
  let appDir = APP;
  if (release) {
    appDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'localai-app-')), 'app');
    fs.cpSync(APP, appDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, 'release.json'), JSON.stringify(release));
  }
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(appDir, 'server.js')], {
    env: { ...process.env, DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, PORT: String(port), OLLAMA_URL: 'http://127.0.0.1:9' },
    stdio: 'ignore'
  });
  t.after(() => { child.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); if (release) fs.rmSync(path.dirname(appDir), { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) { try { if ((await fetch(base + '/healthz')).ok) return base; } catch {} await new Promise(r => setTimeout(r, 100)); }
  throw new Error('server did not start');
}
const post = (base, p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));
const board = async base => (await (await fetch(base + '/api/claude/board')).json());
const finding = async (base, id) => (await board(base)).findings?.find(f => f.id === id) || (await board(base)).items?.find(f => f.id === id);

test('a Claude re-report keeps the backlog fields and the owner\'s votes', { timeout: 30000 }, async t => {
  const base = await startServer(t, {
    seed: s => s.writeSetting('claude-finding/x1', { id: 'x1', sessionId: 's', title: 'Old', category: 'ux', severity: 'medium', status: 'approved', source: 'idea', changeId: 'c1', handedToClaude: true, votes: { up: 2, down: 0 }, priorityBoost: 0, createdAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-15T00:00:00Z' })
  });
  assert.equal((await post(base, '/api/claude/findings', { sessionId: 's', findings: [{ id: 'x1', title: 'New title' }] })).status, 201);
  const f = await finding(base, 'x1');
  assert.equal(f.title, 'New title');
  assert.deepEqual([f.source, f.changeId, f.handedToClaude, f.votes.up], ['idea', 'c1', true, 2]);
});

test('a finding cannot claim to be a signal or an idea through the board API', { timeout: 30000 }, async t => {
  const base = await startServer(t);
  await post(base, '/api/claude/findings', { sessionId: 's', findings: [{ id: 'x2', title: 'Sneaky', source: 'signal', changeId: 'c9', handedToClaude: true }] });
  const f = await finding(base, 'x2');
  assert.equal(f.source, undefined);
  assert.equal(f.changeId, undefined);
  assert.equal(f.handedToClaude, undefined);
});

test('two scans at once still promote a serious signal only once', { timeout: 60000 }, async t => {
  const base = await startServer(t, {
    seed: s => s.put('issues', { id: 'issue-hot', key: 'browser-runtime:boom', kind: 'browser-runtime', name: 'Boom', detail: 'stack', severity: 'high', status: 'open', occurrences: 1, createdAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-15T00:00:00Z', lastSeenAt: '2026-10-15T00:00:00Z', lastEventAt: '2026-10-15T00:00:00Z', changeId: null }, 0)
  });
  await Promise.all([post(base, '/api/issues/scan', {}), post(base, '/api/issues/scan', {})]);
  const all = (await board(base)).findings || (await board(base)).items;
  const promoted = all.filter(f => f.id === 'signal-issue-hot');
  assert.equal(promoted.length, 1);
  assert.deepEqual([promoted[0].source, promoted[0].status, promoted[0].severity], ['signal', 'proposed', 'high']);
});

test('start-up stamps shipped items with the deployed release', { timeout: 60000 }, async t => {
  const base = await startServer(t, {
    release: RELEASE,
    seed: s => s.writeSetting('claude-finding/x3', { id: 'x3', sessionId: 's', title: 'Shipped one', category: 'ux', severity: 'low', status: 'fixed', source: 'idea', shipped: { pending: true, at: '2026-10-15T19:00:00.000Z' }, votes: { up: 0, down: 0 }, priorityBoost: 0, createdAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-15T00:00:00Z' })
  });
  const f = await finding(base, 'x3');
  assert.deepEqual(f.shipped, { version: '2.0.300', commit: 'a'.repeat(40), at: '2026-10-15T19:00:00.000Z', pending: false });
});

test('/api/claude/priorities keeps its exact field list', { timeout: 30000 }, async t => {
  const base = await startServer(t);
  await post(base, '/api/claude/findings', { sessionId: 's', findings: [{ id: 'x4', title: 'Anything', severity: 'high' }] });
  const { items } = await (await fetch(base + '/api/claude/priorities')).json();
  // decisionNote is present only when set (an undefined value is dropped from the JSON), so it is optional here.
  const keys = Object.keys(items[0]).filter(k => k !== 'decisionNote').sort();
  assert.deepEqual(keys, ['category', 'file', 'fix', 'id', 'rank', 'score', 'severity', 'status', 'title', 'votes'].sort());
  assert.ok(Object.keys(items[0]).every(k => k !== 'source' && k !== 'stage' && k !== 'shipped'), 'no Improve fields leak into priorities');
});
