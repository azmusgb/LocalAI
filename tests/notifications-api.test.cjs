'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawnAppServer } = require('./spawn-server.cjs');

test('Inbox badge counts what needs the owner, not routine updates', { timeout: 30000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-notes-'));
  const { child, ready } = spawnAppServer({ env: { DATA_DIR: dataDir, APP_VERSION: '1.18' } });
  t.after(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = await ready;

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
