'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

async function freePort() {
  const s = http.createServer();
  s.listen(0, '127.0.0.1');
  await once(s, 'listening');
  const port = s.address().port;
  await new Promise(resolve => s.close(resolve));
  return port;
}

test('Services › ArtCraft: status and open go through the appliance, which forwards nothing from the request', { timeout: 30000 }, async t => {
  // A stand-in for host/gridcraft-bridge.py's /artcraft routes.
  const seen = [];
  let running = false;
  const bridge = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, type: req.headers['content-type'], body });
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/artcraft') return res.end(JSON.stringify({ ok: true, installed: true, running, version: '0.41.0', path: 'C:\\Users\\someone\\AppData\\Local\\ArtCraft\\artcraft.exe' }));
      if (req.url === '/artcraft/open' && req.method === 'POST') { const already = running; running = true; return res.end(JSON.stringify({ ok: true, alreadyRunning: already })); }
      res.statusCode = 404; res.end('{}');
    });
  });
  bridge.listen(0, '127.0.0.1');
  await once(bridge, 'listening');

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-artcraft-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let diagnostics = '';
  const off = 'http://127.0.0.1:9';
  const child = spawn(process.execPath, [path.resolve(__dirname, '../app/server.js')], {
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), WORKSPACE_ROOT: dataDir, GRIDCRAFT_URL: `http://127.0.0.1:${bridge.address().port}`, OLLAMA_URL: off, SEARXNG_URL: off, COMFY_URL: off, N8N_URL: off, PROXY_URL: off, MAC_AI_HOME_URL: off, MAC_DSH_URL: off }
  });
  child.stdout.on('data', c => diagnostics += c);
  child.stderr.on('data', c => diagnostics += c);
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
    bridge.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) throw new Error(diagnostics);
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch {}
    if (attempt === 79) throw new Error(`Server did not start: ${diagnostics}`);
    await new Promise(r => setTimeout(r, 100));
  }

  const status = await fetch(`${base}/api/artcraft/status`);
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { ok: true, installed: true, running: false, version: '0.41.0' }, 'no host path');

  const post = (headers = {}, body = '{"exe":"C:\\\\Windows\\\\System32\\\\cmd.exe","args":["/c","x"]}') =>
    fetch(`${base}/api/artcraft/open`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...headers }, body });
  const first = await post();
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { ok: true, alreadyRunning: false });
  assert.deepEqual(await (await post()).json(), { ok: true, alreadyRunning: true });
  const forwarded = seen.filter(x => x.url === '/artcraft/open');
  assert.equal(forwarded.length, 2);
  assert.equal(forwarded[0].body, '{}', 'nothing from the request reaches the bridge');
  assert.equal(forwarded[0].type, 'application/json');

  assert.equal((await post({ Origin: 'http://evil.example' })).status, 403);
  assert.equal((await post({ 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await post({ 'Content-Type': 'text/plain' })).status, 415);
  await fetch(`${base}/api/artcraft/open`); // a GET is not a way to open it
  assert.equal(seen.filter(x => x.url === '/artcraft/open').length, 2, 'rejected requests never reach the bridge');

  bridge.close();
  await new Promise(r => setTimeout(r, 50));
  const down = await fetch(`${base}/api/artcraft/status`);
  assert.equal(down.status, 502);
  assert.equal((await down.json()).ok, false);
});

test('the Services card asks the appliance, not the bridge, and has no free-form launch', () => {
  const ui = fs.readFileSync(path.resolve(__dirname, '../app/public/ui.js'), 'utf8');
  assert.match(ui, /fetch\('\/api\/artcraft\/status'/);
  assert.match(ui, /url: '\/api\/artcraft\/open', label: 'Open on the Windows computer'/);
  assert.doesNotMatch(ui, /8787/);
  const bridge = fs.readFileSync(path.resolve(__dirname, '../host/gridcraft-bridge.py'), 'utf8');
  assert.match(bridge, /subprocess\.Popen\(\[str\(ARTCRAFT_EXE\)\], cwd=/, 'only the fixed exe, with no arguments');
});
