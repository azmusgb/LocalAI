'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

test('Inbox badge counts what needs the owner, not routine updates', { timeout: 30000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-notes-'));
  const reserve = http.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise(r => reserve.close(r));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.resolve(__dirname, '../app/server.js')], { env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), APP_VERSION: '1.18' }, stdio: 'ignore' });
  t.after(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } fs.rmSync(dataDir, { recursive: true, force: true }); });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }

  const post = (body) => fetch(base + '/api/notifications/system', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
  assert.equal((await post({ kind: 'deploy', title: 'Local AI updated to abc', meta: { outcome: 'deployed' } })).item.level, 'info');
  assert.equal((await post({ kind: 'backup', title: 'Backup finished', meta: { outcome: 'ok' } })).item.level, 'info');
  assert.equal((await post({ kind: 'deploy', title: 'Automatic update failed', meta: { outcome: 'failed' } })).item.level, 'attention');
  assert.equal((await post({ kind: 'monitor', title: 'Search is down' })).item.level, 'attention');
  assert.equal((await post({ kind: 'monitor', title: 'Search is down', meta: { outcome: 'down' } })).item.level, 'attention');
  const inbox = await (await fetch(base + '/api/notifications')).json();
  assert.equal(inbox.items.length, 5);
  assert.equal(inbox.unread, 3);
});
