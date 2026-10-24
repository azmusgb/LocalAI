'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { spawnAppServer } = require('./spawn-server.cjs');
const { createBambuddyControl } = require('../app/bambuddy-control');

test('clearPlate posts clear-plate and hms/clear with the control key, and reports each step', async () => {
  const calls = [];
  const control = createBambuddyControl({
    url: 'http://127.0.0.1:8000', key: 'bb_ctl', printer: 2,
    fetchImpl: async (u, o) => { calls.push([new URL(u).pathname, o.method, o.headers['X-API-Key']]); return { ok: !String(u).includes('hms'), status: 403 }; }
  });
  assert.deepEqual(await control.clearPlate(), { ok: false, plate: 'ok', errors: 'refused' });
  assert.deepEqual(calls, [['/api/v1/printers/2/clear-plate', 'POST', 'bb_ctl'], ['/api/v1/printers/2/hms/clear', 'POST', 'bb_ctl']]);
  assert.deepEqual(await createBambuddyControl({ url: 'off' }).clearPlate(), { ok: false, plate: 'off', errors: 'off' });
  const down = createBambuddyControl({ url: 'http://127.0.0.1:8000', fetchImpl: async () => { throw new Error('refused'); } });
  assert.equal((await down.clearPlate()).plate, 'no answer');
});

test('POST /api/display/printer/clear needs the display key and reaches Bambuddy', { timeout: 30000 }, async (t) => {
  const seen = [];
  const bambuddy = http.createServer((req, res) => { seen.push([req.method, req.url, req.headers['x-api-key']]); res.end('{}'); });
  bambuddy.listen(0, '127.0.0.1');
  await once(bambuddy, 'listening');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-clear-'));
  const key = 'wsd_' + 'a'.repeat(48);
  fs.writeFileSync(path.join(dataDir, 'workshop-display-key.sha256'), crypto.createHash('sha256').update(key).digest('hex'));
  const dead = 'http://127.0.0.1:9';
  const { child, ready } = spawnAppServer({ env: { DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, OLLAMA_URL: dead, SEARXNG_URL: dead, COMFY_URL: dead, N8N_URL: dead, PROXY_URL: dead, MAC_AI_HOME_URL: dead, MAC_DSH_URL: dead,
    LOCALAI_BAMBUDDY_URL: `http://127.0.0.1:${bambuddy.address().port}`, LOCALAI_BAMBUDDY_CONTROL_KEY: 'bb_ctl', LOCALAI_MATERIALS_URL: 'off' } });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
    bambuddy.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = await ready;
  const post = (headers = {}) => fetch(`${base}/api/display/printer/clear`, { method: 'POST', headers });
  assert.equal((await post()).status, 401);
  assert.equal((await post({ 'X-LocalAI-Display-Key': 'wsd_' + 'b'.repeat(48) })).status, 401);
  assert.equal(seen.length, 0, 'nothing reaches Bambuddy without the key');
  const r = await post({ 'X-LocalAI-Display-Key': key });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, plate: 'ok', errors: 'ok' });
  assert.deepEqual(seen, [['POST', '/api/v1/printers/1/clear-plate', 'bb_ctl'], ['POST', '/api/v1/printers/1/hms/clear', 'bb_ctl']]);
});
