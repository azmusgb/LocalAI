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
const { createBambuddyControl, clearPlateMessage, plateClearRefusal } = require('../app/bambuddy-control');

test('clearPlate posts clear-plate and hms/clear with the control key, and reports each step', async () => {
  const calls = [];
  const control = createBambuddyControl({
    url: 'http://127.0.0.1:8000', key: 'bb_ctl', printer: 2,
    fetchImpl: async (u, o) => { calls.push([new URL(u).pathname, o.method, o.headers['X-API-Key']]); return { ok: !String(u).includes('hms'), status: 403 }; }
  });
  assert.deepEqual(await control.clearPlate(), { ok: true, plate: 'ok', errors: 'refused' });
  assert.deepEqual(calls, [['/api/v1/printers/2/clear-plate', 'POST', 'bb_ctl'], ['/api/v1/printers/2/hms/clear', 'POST', 'bb_ctl']]);
  assert.deepEqual(await createBambuddyControl({ url: 'off' }).clearPlate(), { ok: false, plate: 'off', errors: 'off' });
  const down = createBambuddyControl({ url: 'http://127.0.0.1:8000', fetchImpl: async () => { throw new Error('refused'); } });
  assert.equal((await down.clearPlate()).plate, 'no answer');
});

test('POST /api/display/printer/clear needs the display key and reaches Bambuddy', { timeout: 30000 }, async (t) => {
  const seen = [];
  let status = { connected: true, state: 'FINISH', awaiting_plate_clear: true }, holdClear = null;
  const bambuddy = http.createServer(async (req, res) => {
    seen.push([req.method, req.url, req.headers['x-api-key']]);
    if (req.method === 'GET') return res.end(JSON.stringify(status));
    if (holdClear && req.url.endsWith('/clear-plate')) await holdClear;
    res.end('{}');
  });
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
  const attention = await fetch(`${base}/api/attention`);
  assert.equal(attention.status, 200);
  assert.equal((await attention.json()).source, 'localai');
  assert.equal(seen.length, 0, 'own attention never contacts Bambuddy');
  const post = (headers = {}) => fetch(`${base}/api/display/printer/clear`, { method: 'POST', headers });
  assert.equal((await post()).status, 401);
  assert.equal((await post({ 'X-LocalAI-Display-Key': 'wsd_' + 'b'.repeat(48) })).status, 401);
  assert.equal(seen.length, 0, 'nothing reaches Bambuddy without the key');
  const r = await post({ 'X-LocalAI-Display-Key': key });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, plate: 'ok', errors: 'ok' });
  assert.deepEqual(seen, [['GET', '/api/v1/printers/1/status', 'bb_ctl'], ['POST', '/api/v1/printers/1/clear-plate', 'bb_ctl'], ['POST', '/api/v1/printers/1/hms/clear', 'bb_ctl']]);

  // Not waiting for a clear (printing, or a finished print whose plate was already cleared): 409, nothing posted.
  for (const s of [{ connected: true, state: 'RUNNING', awaiting_plate_clear: false }, { connected: true, state: 'FINISH', awaiting_plate_clear: false }, { connected: false, state: 'FINISH', awaiting_plate_clear: true }]) {
    status = s; seen.length = 0;
    const refused = await post({ 'X-LocalAI-Display-Key': key });
    assert.equal(refused.status, 409, JSON.stringify(s));
    assert.match((await refused.json()).error, /plate|printer/i);
    assert.deepEqual(seen.map(c => c[0]), ['GET'], 'a refused clear never posts to Bambuddy');
  }
  status = { connected: true, state: 'FAILED', awaiting_plate_clear: true };

  // Two overlapping requests: the second is refused and only one clear reaches Bambuddy.
  seen.length = 0;
  let release; holdClear = new Promise(r => { release = r; });
  const first = post({ 'X-LocalAI-Display-Key': key });
  while (!seen.some(c => c[1].endsWith('/clear-plate'))) await new Promise(r => setTimeout(r, 10));
  const second = await post({ 'X-LocalAI-Display-Key': key });
  assert.equal(second.status, 409);
  assert.deepEqual(await second.json(), { error: 'Already clearing' });
  release(); holdClear = null;
  assert.equal((await first).status, 200);
  assert.equal(seen.filter(c => c[1].endsWith('/clear-plate')).length, 1);
  // The guard is released afterwards.
  seen.length = 0;
  assert.equal((await post({ 'X-LocalAI-Display-Key': key })).status, 200);
});

test('status() reads Bambuddy and plateClearRefusal allows only a finished or failed print awaiting a clear', async () => {
  const body = { connected: true, state: 'finish', awaiting_plate_clear: true };
  const calls = [];
  const control = createBambuddyControl({ url: 'http://bambuddy.test', key: 'ctl', statusKey: 'rd', printer: 3, fetchImpl: async (u, o) => { calls.push([new URL(u).pathname, o.headers['X-API-Key'], !!o.signal]); return { ok: true, status: 200, json: async () => body }; } });
  assert.deepEqual(await control.status(), { ok: true, state: 'FINISH', awaitingPlateClear: true, connected: true });
  assert.deepEqual(calls, [['/api/v1/printers/3/status', 'rd', true]]);
  assert.equal(plateClearRefusal(await control.status()), null);
  assert.equal(plateClearRefusal({ ok: true, state: 'FAILED', awaitingPlateClear: true, connected: true }), null);
  for (const s of [{ ok: true, state: 'RUNNING', awaitingPlateClear: false, connected: true }, { ok: true, state: 'PAUSE', awaitingPlateClear: true, connected: true }, { ok: true, state: 'IDLE', awaitingPlateClear: false, connected: true }, { ok: true, state: 'FINISH', awaitingPlateClear: false, connected: true }, { ok: true, state: 'FINISH', awaitingPlateClear: true, connected: false }, { ok: false, reason: 'no answer' }, null]) {
    assert.equal(typeof plateClearRefusal(s), 'string', JSON.stringify(s));
  }
  assert.deepEqual(await createBambuddyControl({ url: 'off' }).status(), { ok: false, reason: 'off' });
  assert.deepEqual(await createBambuddyControl({ url: 'http://x.test', fetchImpl: async () => { throw new Error('t'); } }).status(), { ok: false, reason: 'no answer' });
  assert.deepEqual(await createBambuddyControl({ url: 'http://x.test', fetchImpl: async () => ({ ok: false, status: 403 }) }).status(), { ok: false, reason: 'refused' });
});


test('a failed plate action never clears the printer error list', async () => {
  for (const result of ['refused', 'no answer', 'HTTP 409']) {
    const calls = [];
    const control = createBambuddyControl({ url: 'http://bambuddy.test', fetchImpl: async url => {
      calls.push(new URL(url).pathname);
      if (result === 'no answer') throw new Error('timeout');
      return { ok: false, status: result === 'refused' ? 403 : 409 };
    } });
    assert.deepEqual(await control.clearPlate(), { ok: false, plate: result, errors: 'skipped' });
    assert.deepEqual(calls, ['/api/v1/printers/1/clear-plate']);
  }
});


test('printer feedback distinguishes confirmation, partial completion and failure without claiming physical verification', () => {
  assert.deepEqual(clearPlateMessage({ ok: true, errors: 'ok' }), {
    title: 'Plate confirmed', text: 'Bambuddy accepted the plate confirmation.', tone: 'ok'
  });
  assert.equal(clearPlateMessage({ ok: true, errors: 'refused' }).title, 'Check printer errors');
  assert.equal(clearPlateMessage({ ok: false, plate: 'no answer', errors: 'skipped' }).title, 'Plate not confirmed');
});
