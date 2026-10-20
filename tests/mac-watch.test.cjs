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
