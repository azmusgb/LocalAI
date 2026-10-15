'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { makeTlsFixture, OPENSSL_MISSING } = require('./tls-fixture.cjs');

const CLI = path.resolve(__dirname, '../host/claude-chat/localai-chat');
let server, base, home, handler, calls = [];

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-cli-'));
  handler = (req, res) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, key: req.headers['x-localai-mac-key'], body: raw ? JSON.parse(raw) : null });
      const send = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.headers['x-localai-mac-key'] !== 'k1') return send(401, { error: 'Unauthorized' });
      if (req.url === '/api/claude/chat/pair/approve') return send(JSON.parse(raw).code === 'GOOD22' ? 200 : 404, { deviceId: 'dev-abcdef012345' });
      if (req.url === '/api/claude/chat/devices') return send(200, { items: [{ id: 'dev-abcdef012345', name: 'Phone', pairedAt: 1, lastSeenAt: 2, current: false }] });
      if (req.url === '/api/claude/chat/devices/revoke') return send(JSON.parse(raw).id === 'dev-abcdef012345' ? 200 : 404, { ok: true });
      send(404, {});
    });
  };
  server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(home, { recursive: true, force: true }); });

function run(args, env = {}) {
  return new Promise(resolve => {
    const c = spawn(CLI, args, { env: { ...process.env, LOCALAI_CHAT_HOME: home, LOCALAI_URL: base, ...env } });
    let out = '', err = '';
    c.stdout.on('data', d => out += d); c.stderr.on('data', d => err += d);
    c.on('close', code => resolve({ code, out, err }));
  });
}
const writeKey = k => fs.writeFileSync(path.join(home, 'mac.key'), k);

test('without a key: pair/devices fail with the installer hint; status reports it missing', async () => {
  fs.rmSync(path.join(home, 'mac.key'), { force: true });
  const p = await run(['pair', 'GOOD22']);
  assert.notEqual(p.code, 0); assert.match(p.err, /install\.sh/);
  const s = await run(['status']);
  assert.equal(s.code, 0); assert.match(s.out, /Mac key:\s+missing.*install\.sh/);
});

test('pair, devices and revoke call the right endpoints with the key', async () => {
  writeKey('k1\n');
  calls = [];
  const p = await run(['pair', 'GOOD22', 'My', 'Phone']);
  assert.equal(p.code, 0, p.err); assert.match(p.out, /dev-abcdef012345/);
  assert.deepEqual(calls[0], { method: 'POST', url: '/api/claude/chat/pair/approve', key: 'k1', body: { code: 'GOOD22', name: 'My Phone' } });
  const d = await run(['devices']);
  assert.equal(d.code, 0); assert.match(d.out, /dev-abcdef012345\s+Phone/);
  assert.equal(calls[1].method, 'GET'); assert.equal(calls[1].url, '/api/claude/chat/devices'); assert.equal(calls[1].key, 'k1');
  const r = await run(['revoke', 'dev-abcdef012345']);
  assert.equal(r.code, 0);
  assert.deepEqual(calls[2].body, { id: 'dev-abcdef012345' });
  assert.notEqual((await run(['pair', 'BAD222'])).code, 0);
  assert.notEqual((await run(['revoke', 'dev-000000000000'])).code, 0);
});

test('status reports reachability, key acceptance, and only live bridges; never prints the key', async () => {
  writeKey('k1');
  fs.mkdirSync(path.join(home, 'run'), { recursive: true });
  fs.writeFileSync(path.join(home, 'run', 'live-1.pid'), String(process.pid));
  fs.writeFileSync(path.join(home, 'run', 'live-1.last'), '2026-10-15T10:00:00.000Z');
  fs.writeFileSync(path.join(home, 'run', 'dead-1.pid'), '2147483646');
  let s = await run(['status']);
  assert.match(s.out, /Relay:\s+reachable/); assert.match(s.out, /Key:\s+accepted/);
  assert.match(s.out, /live-1.*2026-10-15T10:00:00/); assert.doesNotMatch(s.out, /dead-1/);
  assert.doesNotMatch(s.out + s.err, /k1/);
  writeKey('wrong');
  s = await run(['status']);
  assert.match(s.out, /Key:\s+rejected/);
  s = await run(['status'], { LOCALAI_URL: 'http://127.0.0.1:9' });
  assert.match(s.out, /Relay:\s+unreachable/);
});

test('HTTPS from config.json: works with the configured CA, and says clearly when the certificate is not trusted', async (t) => {
  const tls = makeTlsFixture();
  if (!tls) return t.skip(OPENSSL_MISSING);
  const secure = https.createServer({ key: tls.key, cert: tls.cert }, handler);
  secure.listen(0, '127.0.0.1');
  await once(secure, 'listening');
  const url = `https://127.0.0.1:${secure.address().port}`;
  const config = path.join(home, 'config.json');
  t.after(() => { secure.close(); fs.rmSync(config, { force: true }); tls.cleanup(); });
  writeKey('k1');
  const noEnv = { LOCALAI_URL: '', NODE_EXTRA_CA_CERTS: '' };

  fs.writeFileSync(config, JSON.stringify({ url, ca: tls.caPath }));
  let s = await run(['status'], noEnv);
  assert.match(s.out, new RegExp(`Relay:\\s+reachable \\(${url.replace(/[.]/g, '\\.')}\\)`));
  assert.match(s.out, /Key:\s+accepted/);
  assert.match(s.out, new RegExp(`CA:\\s+${tls.caPath.replace(/[.]/g, '\\.')}`));
  calls = [];
  const p = await run(['pair', 'GOOD22'], noEnv);
  assert.equal(p.code, 0, p.err);
  assert.equal(calls[0].url, '/api/claude/chat/pair/approve');

  fs.writeFileSync(config, JSON.stringify({ url, ca: tls.otherCaPath }));
  calls = [];
  s = await run(['status'], noEnv);
  assert.match(s.out, /Relay:\s+certificate not trusted/);
  assert.match(s.out, /install\.sh/);
  const bad = await run(['devices'], noEnv);
  assert.notEqual(bad.code, 0);
  assert.match(bad.err, /tls \S+: the certificate of https:\/\/127\.0\.0\.1:\d+ is not trusted \(CA: .*other\.crt\)/);
  assert.equal(calls.length, 0, 'the key was never sent');
});
