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

test('GridCraft is reached through the appliance, not directly from the browser', { timeout: 30000 }, async t => {
  // A stand-in for host/gridcraft-bridge.py that records what the appliance forwards.
  const seen = [];
  const bridge = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, origin: req.headers.origin, type: req.headers['content-type'], body });
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/health') return res.end(JSON.stringify({ ok: true, gridcraftConnected: true, model: 'qwen3:4b-instruct', workbook: 'C:\\Users\\someone\\Book.xlsx' }));
      if (req.url === '/run') return res.end(JSON.stringify({ ok: true, answer: 'done', durationSec: 0.1 }));
      res.statusCode = 404; res.end('{}');
    });
  });
  bridge.listen(0, '127.0.0.1');
  await once(bridge, 'listening');

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-gridcraft-'));
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

  const health = await fetch(`${base}/api/gridcraft/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, gridcraftConnected: true, model: 'qwen3:4b-instruct' }, 'host paths are not passed through');

  const run = await fetch(`${base}/api/gridcraft/run`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ prompt: 'sum column B', extra: 'dropped' }) });
  assert.equal(run.status, 200);
  assert.equal((await run.json()).answer, 'done');
  const forwarded = seen.find(x => x.url === '/run');
  assert.deepEqual(JSON.parse(forwarded.body), { prompt: 'sum column B' }, 'only the prompt is forwarded');
  assert.equal(forwarded.type, 'application/json');

  const crossSite = await fetch(`${base}/api/gridcraft/run`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' }, body: '{"prompt":"x"}' });
  assert.equal(crossSite.status, 403);
  const formPost = await fetch(`${base}/api/gridcraft/run`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"prompt":"x"}' });
  assert.equal(formPost.status, 415);
  assert.equal(seen.filter(x => x.url === '/run').length, 1, 'rejected requests never reach the bridge');

  bridge.close();
  await new Promise(r => setTimeout(r, 50));
  const down = await fetch(`${base}/api/gridcraft/health`);
  assert.equal(down.status, 502);
  assert.equal((await down.json()).ok, false);
});

test('the GridCraft page and Integrations card use the appliance route', () => {
  const pub = path.resolve(__dirname, '../app/public');
  const page = fs.readFileSync(path.join(pub, 'gridcraft.js'), 'utf8');
  assert.match(page, /const BRIDGE = '\/api\/gridcraft'/);
  assert.doesNotMatch(page, /8787/);
  const hub = fs.readFileSync(path.join(pub, 'integration-hub-v2.js'), 'utf8');
  assert.match(hub, /fetch\('\/api\/gridcraft\/health'/);
  assert.match(hub, /url: '\/gridcraft\.html'/);
});
