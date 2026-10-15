'use strict';

// Changes to Local AI itself ship as a pull request: approving one hands its Improve item to Claude instead of
// queueing it for a host updater that doesn't exist.
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

async function freePort() {
  const s = http.createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening');
  const port = s.address().port; await new Promise(r => s.close(r)); return port;
}

// Starts a server on its own data folder. `seed(storage)` runs first; `release` runs a copy of app/ with a release.json.
async function startServer(t, { seed, release, ollama } = {}) {
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
    env: { ...process.env, DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, PORT: String(port), OLLAMA_URL: ollama || 'http://127.0.0.1:9' },
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

const change = (id, status, extra = {}) => ({ id, target: 'self', root: 'app', request: `Make ${id} better\nmore`, summary: 'Proposed change', files: [{ path: 'public/x.js' }], status, createdAt: '2026-10-15T00:00:00.000Z', updatedAt: '2026-10-15T00:00:00.000Z', ...extra });
const getChange = async (base, id) => (await (await fetch(base + '/api/changes')).json()).items.find(c => c.id === id);
const findingFor = async (base, changeId) => { const b = await (await fetch(base + '/api/claude/board')).json(); return (b.findings || b.items || []).find(f => f.changeId === changeId); };
const handedNotices = async base => (await (await fetch(base + '/api/notifications')).json()).items.filter(n => n.title === 'Handed to Claude to ship').length;

test('approving a self change hands it to Claude to ship as a pull request', { timeout: 30000 }, async t => {
  const base = await startServer(t, { seed: s => {
    s.put('changes', change('chg-a', 'approved'), 0);
    s.writeSetting('claude-finding/idea-a', { id: 'idea-a', sessionId: 'owner', title: 'Make it better', category: 'idea', severity: 'medium', status: 'approved', source: 'idea', changeId: 'chg-a', votes: { up: 0, down: 0 }, priorityBoost: 0, createdAt: '2026-10-15T00:00:00.000Z' });
  } });
  const r = await post(base, '/api/changes/request-apply', { id: 'chg-a' });
  assert.equal(r.status, 200);
  assert.equal(r.body.shipVia, 'pr');
  assert.equal(r.body.improveItemId, 'idea-a');
  const c = await getChange(base, 'chg-a');
  assert.equal(c.status, 'approved', 'no longer apply_requested');
  assert.equal(c.shipVia, 'pr');
  const f = await findingFor(base, 'chg-a');
  assert.equal(f.handedToClaude, true);
  assert.match(f.fix, /chg-a/);
  assert.match(f.fix, /\/api\/changes\/deploy-result/);
  // A second request changes nothing and doesn't notify again.
  assert.equal((await post(base, '/api/changes/request-apply', { id: 'chg-a' })).status, 200);
  assert.equal(await handedNotices(base), 1);
  // The session reports the deploy; Improve moves the item to Shipped.
  assert.equal((await post(base, '/api/changes/deploy-result', { id: 'chg-a', status: 'applied' })).status, 200);
  const shipped = (await (await fetch(base + '/api/claude/board')).json());
  const item = (shipped.findings || shipped.items).find(x => x.id === 'idea-a');
  assert.equal(item.status, 'fixed');
});

test('an approved self change with no Improve item gets one, titled from its request', { timeout: 30000 }, async t => {
  const base = await startServer(t, { seed: s => s.put('changes', change('chg-b', 'approved'), 0) });
  const r = await post(base, '/api/changes/request-apply', { id: 'chg-b' });
  assert.equal(r.body.improveItemId, 'idea-change-chg-b');
  const f = await findingFor(base, 'chg-b');
  assert.equal(f.title, 'Make chg-b better');
  assert.equal(f.handedToClaude, true);
});

test('changes left waiting for the old host updater are handed over at start-up', { timeout: 30000 }, async t => {
  const base = await startServer(t, { seed: s => s.put('changes', change('chg-q', 'apply_requested'), 0) });
  const c = await getChange(base, 'chg-q');
  assert.equal(c.status, 'approved');
  assert.equal(c.shipVia, 'pr');
  assert.equal((await findingFor(base, 'chg-q')).handedToClaude, true);
});
