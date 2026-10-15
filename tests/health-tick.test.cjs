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

async function listen(handler) { const s = http.createServer(handler); s.listen(0, '127.0.0.1'); await once(s, 'listening'); return s; }
async function freePort() { const s = await listen(() => {}); const p = s.address().port; await new Promise(r => s.close(r)); return p; }

test('an outage reaches the phone without any page open', { timeout: 30000 }, async t => {
  // Every core service, faked by one server that answers 200 until it is closed.
  const services = await listen((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); });
  const svc = `http://127.0.0.1:${services.address().port}`;
  const pushes = [];
  const pushService = await listen((req, res) => { req.resume(); req.on('end', () => { pushes.push(Date.now()); res.writeHead(201); res.end(); }); });
  const host = `127.0.0.1:${pushService.address().port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-tick-'));
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.resolve(__dirname, '../app/server.js')], { stdio: 'ignore', env: {
    ...process.env, DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, PORT: String(port), PUSH_TEST_ENDPOINT_HOST: host,
    OLLAMA_URL: svc, COMFY_URL: svc, N8N_URL: svc, PROXY_URL: svc, SEARXNG_URL: svc, MAC_AI_HOME_URL: '', MAC_DSH_URL: '',
    HEALTH_SETTLE_MS: '0', HEALTH_TICK_MS: '300', TZ: 'UTC'
  } });
  t.after(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } services.close(); pushService.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const { device } = await (await post('/api/push/subscribe', { subscription: { endpoint: `http://${host}/phone`, keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } }, name: 'iPhone' })).json();
  await post('/api/push/devices/update', { id: device.id, quiet: { on: false } });

  await new Promise(r => setTimeout(r, 1200)); // a few healthy ticks
  assert.equal(pushes.length, 0, 'no push while healthy');
  services.closeAllConnections(); await new Promise(r => services.close(r));
  for (let i = 0; i < 60 && !pushes.length; i++) await new Promise(r => setTimeout(r, 200));
  assert.ok(pushes.length >= 1, 'a Down push arrived with no page open');
});
