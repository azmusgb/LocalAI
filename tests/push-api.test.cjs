'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

async function freePort() {
  const s = http.createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening');
  const p = s.address().port; await new Promise(r => s.close(r)); return p;
}

// A fake push service: records requests and answers with whatever status the test sets per path.
async function fakePushService() {
  const hits = [], statusFor = new Map();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c)).on('end', () => {
      hits.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(statusFor.get(req.url) || 201); res.end();
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { server, hits, statusFor, host: `127.0.0.1:${server.address().port}` };
}

function subscription(fake, name) {
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  return { endpoint: `http://${fake.host}/${name}`, keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } };
}

test('push API: key, subscribe, test, removal and same-origin', { timeout: 30000 }, async t => {
  const fake = await fakePushService();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-push-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.resolve(__dirname, '../app/server.js')], { env: { ...process.env, DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, PORT: String(port), PUSH_TEST_ENDPOINT_HOST: fake.host }, stdio: 'ignore' });
  t.after(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } fake.server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

  await t.test('key is stable', async () => {
    const a = await (await fetch(base + '/api/push/key')).json(), b = await (await fetch(base + '/api/push/key')).json();
    assert.equal(a.publicKey, b.publicKey);
    assert.match(a.publicKey, /^[A-Za-z0-9_-]{87}$/);
  });

  const phone = subscription(fake, 'phone');
  await t.test('subscribe is idempotent per endpoint', async () => {
    const one = await (await post('/api/push/subscribe', { subscription: phone, name: 'iPhone' })).json();
    const two = await (await post('/api/push/subscribe', { subscription: phone, name: 'iPhone' })).json();
    assert.equal(one.device.id, two.device.id);
    assert.equal(one.device.name, 'iPhone');
    assert.deepEqual(one.device.kinds, ['needs-you', 'failed', 'service', 'finished', 'answer']);
    assert.deepEqual(one.device.quiet, { on: true, start: '22:00', end: '07:00' });
    assert.equal(one.device.keys, undefined);
  });

  await t.test('subscribe rejects a non-push endpoint', async () => {
    const r = await post('/api/push/subscribe', { subscription: { ...phone, endpoint: 'https://evil.com/x' }, name: 'x' });
    assert.equal(r.status, 400);
  });

  await t.test('test sends to the fake push service', async () => {
    const r = await (await post('/api/push/test', {})).json();
    assert.deepEqual(r, { sent: 1, removed: 0, failed: 0, error: null });
    const hit = fake.hits.at(-1);
    assert.equal(hit.path, '/phone');
    assert.equal(hit.headers['content-encoding'], 'aes128gcm');
    assert.match(hit.headers.authorization, /^vapid t=/);
  });

  await t.test('a refused send is reported as refused, with the reason', async () => {
    fake.statusFor.set('/phone', 403);
    assert.deepEqual(await (await post('/api/push/test', {})).json(), { sent: 0, removed: 0, failed: 1, error: 'HTTP 403' });
  });

  await t.test('410 removes the device', async () => {
    fake.statusFor.set('/phone', 410);
    assert.deepEqual(await (await post('/api/push/test', {})).json(), { sent: 0, removed: 1, failed: 0, error: null });
    assert.deepEqual(await (await post('/api/push/test', {})).json(), { sent: 0, removed: 0, failed: 0, error: null });
  });

  await t.test('cross-site subscribe is refused', async () => {
    const r = await post('/api/push/subscribe', { subscription: subscription(fake, 'other'), name: 'x' }, { Origin: 'http://evil.example' });
    assert.equal(r.status, 403);
  });
});
