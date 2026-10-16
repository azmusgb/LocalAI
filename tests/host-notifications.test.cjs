'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

async function startServer(t, seed) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-hostnote-'));
  if (seed) { const { Storage } = require('../app/storage'); const storage = new Storage({ dataDir }); seed(storage); storage.close?.(); }
  const reserve = http.createServer();
  reserve.listen(0, '127.0.0.1');
  await once(reserve, 'listening');
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  let diagnostics = '';
  const child = spawn(process.execPath, [path.resolve(__dirname, '../app/server.js')], {
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), WORKSPACE_ROOT: dataDir, OLLAMA_URL: 'http://127.0.0.1:9', SEARXNG_URL: 'http://127.0.0.1:9', COMFY_URL: 'http://127.0.0.1:9', N8N_URL: 'http://127.0.0.1:9', PROXY_URL: 'http://127.0.0.1:9', MAC_AI_HOME_URL: 'http://127.0.0.1:9', MAC_DSH_URL: 'http://127.0.0.1:9' }
  });
  child.stdout.on('data', c => diagnostics += c);
  child.stderr.on('data', c => diagnostics += c);
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) throw new Error(diagnostics);
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch {}
    if (attempt === 79) throw new Error(`Server did not start: ${diagnostics}`);
    await new Promise(r => setTimeout(r, 100));
  }
  return base;
}

test('host jobs can post deploy, backup and monitor events to the Inbox', { timeout: 30000 }, async t => {
  const base = await startServer(t);
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let r = await post('/api/notifications/system', { kind: 'deploy', title: 'Local AI updated to abc123', detail: 'Fix things', meta: { commit: 'abc123', outcome: 'deployed' } });
  assert.equal(r.status, 201);
  const item = (await r.json()).item;
  assert.equal(item.kind, 'deploy');
  assert.equal(item.meta.source, 'host');
  assert.equal(item.meta.outcome, 'deployed');
  assert.equal((await post('/api/notifications/system', { kind: 'chat', title: 'x' })).status, 400, 'unknown kinds are rejected');
  assert.equal((await post('/api/notifications/system', { kind: 'backup', title: '  ' })).status, 400, 'a title is required');
  const inbox = await (await fetch(`${base}/api/notifications`)).json();
  assert.ok((inbox.items || []).some(n => n.title === 'Local AI updated to abc123'), 'shows in the Inbox');
});

const post = (base, p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('a failed update shows its real cause, without Windows PowerShell\'s RemoteException filler lines', { timeout: 30000 }, async t => {
  const base = await startServer(t);
  const detail = 'The previous release is still running. System.Management.Automation.RemoteException\nSystem.Management.Automation.RemoteException\nCandidate tests failed: 2 of 40 suites';
  const item = (await (await post(base, '/api/notifications/system', { kind: 'deploy', title: 'Automatic update failed', detail, meta: { outcome: 'failed' } })).json()).item;
  assert.equal(item.detail, 'The previous release is still running.\nCandidate tests failed: 2 of 40 suites');
});

test('a successful update resolves earlier failed-update alerts, so the Inbox stops counting them', { timeout: 30000 }, async t => {
  const base = await startServer(t);
  await post(base, '/api/notifications/system', { kind: 'deploy', title: 'Automatic update failed', detail: 'x', meta: { outcome: 'failed', commit: 'f8e1bf0' } });
  await post(base, '/api/notifications/system', { kind: 'backup', title: 'Backup failed', detail: 'disk full', meta: { outcome: 'failed' } });
  let inbox = await (await fetch(`${base}/api/notifications`)).json();
  assert.equal(inbox.unread, 2);
  await post(base, '/api/notifications/system', { kind: 'deploy', title: 'Local AI updated to 2.0.390', detail: 'y', meta: { outcome: 'deployed' } });
  inbox = await (await fetch(`${base}/api/notifications`)).json();
  const failed = inbox.items.find(n => n.title === 'Automatic update failed');
  assert.equal(failed.resolved, true);
  assert.match(failed.meta.resolvedBy || '', /2\.0\.390/);
  assert.equal(inbox.items.find(n => n.title === 'Backup failed').resolved, false, 'other kinds are left alone');
  assert.equal(inbox.unread, 1);
});

test('a host notice stored before the clean-up is cleaned when the Inbox lists it', { timeout: 30000 }, async t => {
  const base = await startServer(t, s => s.put('notifications', { id: 'note-old', kind: 'deploy', level: 'attention', title: 'Automatic update to f8e1bf048432 failed', detail: 'The previous release is still running. System.Management.Automation.RemoteException System.Management.Automation.RemoteException', createdAt: '2026-10-15T21:00:00.000Z', read: false, resolved: false, meta: { source: 'host', outcome: 'failed' } }, 0));
  const inbox = await (await fetch(`${base}/api/notifications`)).json();
  assert.equal(inbox.items.find(n => n.id === 'note-old').detail, 'The previous release is still running.');
});
