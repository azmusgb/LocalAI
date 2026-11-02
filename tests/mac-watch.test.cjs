'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, execFile } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'host', 'mac-watch', 'watch.py');
const python = (() => { for (const p of ['/opt/homebrew/bin/python3', '/usr/bin/python3', 'python3']) { try { execFileSync(p, ['-c', 'pass']); return p; } catch {} } return null; })();

function home() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-watch-'));
  fs.mkdirSync(path.join(dir, '.claude', 'localai-chat'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'localai-chat', 'mac.key'), 'secret-key');
  return dir;
}
// Async, so the test's own HTTP server keeps answering while the script runs.
const run = (dir, url) => new Promise((resolve) => {
  execFile(python, ['-I', SCRIPT], { env: { HOME: dir, PATH: process.env.PATH, LOCALAI_URL: url, MAC_WATCH_PRINT_NOTICES: '1' }, encoding: 'utf8', timeout: 30000 },
    (error, stdout, stderr) => resolve({ status: error ? error.code ?? 1 : 0, stdout, stderr }));
});

test('posts the disk and bridge to /api/watch/heartbeat with the Mac key', { skip: !python, timeout: 30000 }, async (t) => {
  const seen = [];
  const server = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { seen.push({ url: req.url, key: req.headers['x-localai-mac-key'], body: JSON.parse(b) }); res.end('{"ok":true}'); }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const dir = home();
  const out = await run(dir, `http://127.0.0.1:${server.address().port}`);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, '/api/watch/heartbeat');
  assert.equal(seen[0].key, 'secret-key');
  assert.ok(seen[0].body.disk.totalBytes > 0);
  assert.equal(typeof seen[0].body.bridge.installed, 'boolean');
  assert.ok(!out.stdout.includes('secret-key'), 'never prints the key');
});

test('three missed runs show one "isn\'t answering" notice, then one "back" notice', { skip: !python, timeout: 60000 }, async () => {
  const dir = home();
  const dead = 'http://127.0.0.1:9';
  const outs = [];
  for (let i = 0; i < 4; i++) outs.push((await run(dir, dead)).stdout);
  assert.deepEqual(outs.map((o) => o.includes("Local AI isn't answering")), [false, false, true, false]);
  const server = http.createServer((req, res) => { req.resume(); req.on('end', () => res.end('{}')); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const back = await run(dir, `http://127.0.0.1:${server.address().port}`);
  server.close();
  assert.match(back.stdout, /Local AI is back/);
});

test('a 5xx from a live proxy counts as a miss; a 4xx counts as answered', { skip: !python, timeout: 60000 }, async () => {
  let code = 502;
  const server = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.statusCode = code; res.end('{}'); }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const dir = home();
    const outs = [];
    for (let i = 0; i < 3; i++) outs.push(await run(dir, url));
    assert.deepEqual(outs.map((o) => o.stdout.includes("Local AI isn't answering")), [false, false, true]);
    assert.match(outs[0].stderr, /HTTP 502/);
    code = 401;
    const answered = await run(dir, url);
    assert.match(answered.stdout, /Local AI is back/);
    assert.match(answered.stderr, /HTTP 401/);
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'Library', 'Application Support', 'LocalAI', 'mac-watch.json'), 'utf8'));
    assert.equal(state.misses, 0);
  } finally { server.close(); }
});

test('a missing CA file for an https URL is reported on stderr', { skip: !python, timeout: 30000 }, async () => {
  const dir = home();
  const out = await run(dir, 'https://127.0.0.1:9');
  assert.match(out.stderr, /CA file not found/);
  assert.equal(out.status, 0);
});

test('an osascript failure or timeout still saves state', { skip: !python, timeout: 60000 }, async () => {
  const dir = home();
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'osascript'), '#!/bin/sh\nexit 3\n', { mode: 0o755 });
  // Real notifications (no MAC_WATCH_PRINT_NOTICES), with the failing osascript first on PATH.
  const env = { HOME: dir, PATH: `${bin}:${process.env.PATH}`, LOCALAI_URL: 'http://127.0.0.1:9' };
  const last = [];
  for (let i = 0; i < 3; i++) last[0] = await new Promise((resolve) => execFile(python, ['-I', SCRIPT], { env, encoding: 'utf8', timeout: 30000 }, (error, stdout, stderr) => resolve({ status: error ? error.code ?? 1 : 0, stderr })));
  assert.equal(last[0].status, 0);
  assert.match(last[0].stderr, /notification failed/);
  const stateFile = path.join(dir, 'Library', 'Application Support', 'LocalAI', 'mac-watch.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(state.misses, 3);
  assert.equal(state.notified, true);
});

// Release reports (platform step 3): installers queue them, each run sends them to Pi Hub with the mac deploy key.
const DEPLOY_KEY = 'd'.repeat(64);
const A = 'a'.repeat(40), B = 'b'.repeat(40);
function keychain(dir, key = DEPLOY_KEY) {  // a stand-in for macOS `security`, so the test never reads the real Keychain
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'security'), key ? `#!/bin/sh\necho ${key}\n` : '#!/bin/sh\nexit 44\n', { mode: 0o755 });
  return bin;
}
const runWith = (dir, url, args = [], extra = {}) => new Promise((resolve) => {
  execFile(python, ['-I', SCRIPT, ...args], {
    env: { HOME: dir, PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`, LOCALAI_URL: url, PI_HUB_URL: url, MAC_WATCH_PRINT_NOTICES: '1', ...extra },
    encoding: 'utf8', timeout: 30000,
  }, (error, stdout, stderr) => resolve({ status: error ? error.code ?? 1 : 0, stdout, stderr }));
});
const outboxOf = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'localai-chat', 'release-outbox.json'), 'utf8')); } catch { return []; } };
async function hubServer(t, statuses) {
  const got = [];
  const server = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c));
    req.on('end', () => {
      if (req.url.startsWith('/api/releases/')) {
        got.push({ url: req.url, key: req.headers['x-hub-deploy-key'], body: JSON.parse(b) });
        res.statusCode = statuses.length ? statuses.shift() : 200;
      }
      res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return { got, url: `http://127.0.0.1:${server.address().port}` };
}

test('--queue-release adds an installer report; a bad commit queues nothing', { skip: !python, timeout: 30000 }, async () => {
  const dir = home();
  assert.equal((await runWith(dir, 'http://127.0.0.1:9', ['--queue-release', 'mac-watch', A, '1'])).status, 0);
  const [r] = outboxOf(dir);
  assert.deepEqual([r.target, r.commit, r.result, r.mechanism, r.dirty, r.message],
    ['mac-watch', A, 'deployed', 'mac-install', true, 'installed from uncommitted changes']);
  assert.match(r.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00$/);
  const bad = await runWith(dir, 'http://127.0.0.1:9', ['--queue-release', 'x2d-bridge-mac', 'nope', '0']);
  assert.equal(bad.status, 1);
  assert.equal((await runWith(dir, 'http://127.0.0.1:9', ['--queue-release', 'pi-hub', A, '0'])).status, 1);
  assert.equal(outboxOf(dir).length, 1);
});

test('test_outbox_flush_drops_on_201: sent oldest first with the deploy key, then the outbox is empty', { skip: !python, timeout: 30000 }, async (t) => {
  const dir = home(); keychain(dir);
  const hub = await hubServer(t, [201, 201]);
  await runWith(dir, hub.url, ['--queue-release', 'mac-watch', A, '0']);
  await runWith(dir, hub.url, ['--queue-release', 'x2d-bridge-mac', B, '0']);
  const out = await runWith(dir, hub.url);
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(hub.got.map((g) => [g.url, g.body.commit]), [['/api/releases/mac-watch', A], ['/api/releases/x2d-bridge-mac', B]]);
  assert.equal(hub.got[0].key, DEPLOY_KEY);
  assert.ok(!('target' in hub.got[0].body));
  assert.deepEqual(outboxOf(dir), []);
  assert.ok(!(out.stdout + out.stderr).includes(DEPLOY_KEY), 'never prints the key');
});

test('test_outbox_flush_keeps_on_error: a 5xx or no answer keeps that report and the rest', { skip: !python, timeout: 60000 }, async (t) => {
  const dir = home(); keychain(dir);
  const hub = await hubServer(t, [503]);
  await runWith(dir, hub.url, ['--queue-release', 'mac-watch', A, '0']);
  await runWith(dir, hub.url, ['--queue-release', 'x2d-bridge-mac', B, '0']);
  await runWith(dir, hub.url);
  assert.equal(hub.got.length, 1, 'stops at the first report Pi Hub did not take');
  assert.deepEqual(outboxOf(dir).map((r) => r.commit), [A, B]);
  await runWith(dir, hub.url, [], { PI_HUB_URL: 'http://127.0.0.1:9' });
  assert.deepEqual(outboxOf(dir).map((r) => r.commit), [A, B]);
  await runWith(dir, hub.url);
  assert.deepEqual(outboxOf(dir), []);
});

test('a report Pi Hub refuses as invalid (400) is dropped; with no key yet, nothing is sent', { skip: !python, timeout: 60000 }, async (t) => {
  const dir = home(); keychain(dir, '');
  const hub = await hubServer(t, [400]);
  await runWith(dir, hub.url, ['--queue-release', 'mac-watch', A, '0']);
  const waiting = await runWith(dir, hub.url);
  assert.match(waiting.stderr, /no deploy key in the Keychain yet; 1 release report/);
  assert.equal(hub.got.length, 0);
  keychain(dir);
  await runWith(dir, hub.url);
  assert.equal(hub.got.length, 1);
  assert.deepEqual(outboxOf(dir), []);
});

test('install.sh queues its report before the first run', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'host', 'mac-watch', 'install.sh'), 'utf8');
  assert.match(src, /--queue-release mac-watch/);
  assert.ok(src.indexOf('--queue-release') < src.indexOf('launchctl bootstrap'));
});
