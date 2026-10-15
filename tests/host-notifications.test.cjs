'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

test('host jobs can post deploy, backup and monitor events to the Inbox', { timeout: 30000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-hostnote-'));
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
