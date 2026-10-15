'use strict';

// Browser error reports (/api/quality/client-event): opaque "Script error." is dropped, real errors are kept.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

async function freePort() {
  const s = http.createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening');
  const port = s.address().port; await new Promise(r => s.close(r)); return port;
}

async function startServer(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-glance-'));
  const chats = [];
  const mock = http.createServer((req, res) => {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'test-model' }] }));
      if (req.url === '/api/ps') return res.end(JSON.stringify({ models: [] }));
      if (req.url === '/api/chat') { try { chats.push(JSON.parse(body)); } catch {} }
      res.end(JSON.stringify({ message: { content: 'It is sunny.' } }));
    });
  });
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  let log = '';
  const child = spawn(process.execPath, [path.resolve(__dirname, '../app/server.js')], {
    env: { ...process.env, DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, PORT: String(port), OLLAMA_URL: `http://127.0.0.1:${mock.address().port}`, MODEL: 'test-model',
      COMFY_URL: 'http://127.0.0.1:9', N8N_URL: 'http://127.0.0.1:9', PROXY_URL: 'http://127.0.0.1:9', SEARXNG_URL: 'http://127.0.0.1:9', MAC_AI_HOME_URL: 'http://127.0.0.1:9', MAC_DSH_URL: 'http://127.0.0.1:9' }
  });
  child.stdout.on('data', c => log += c); child.stderr.on('data', c => log += c);
  t.after(async () => {
    if (child.exitCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
    mock.closeAllConnections(); await new Promise(r => mock.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error(log);
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch {}
    if (i === 79) throw new Error(`Server did not start: ${log}`);
    await new Promise(r => setTimeout(r, 50));
  }
  return { base, chats };
}

test('opaque script errors are ignored; real errors are stored with the browser that sent them', { timeout: 30000 }, async t => {
  const { base } = await startServer(t);
  const send = (body, ua = 'TestBrowser/1.0') => fetch(`${base}/api/quality/client-event`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': ua }, body: JSON.stringify(body) });
  const opaque = await send({ type: 'error', message: 'Script error.', source: '/', url: 'https://10.0.0.21/' });
  assert.equal(opaque.status, 202);
  assert.deepEqual(await opaque.json(), { ignored: true, reason: 'opaque script error' });
  const real = await send({ type: 'error', message: 'TypeError: x is undefined', source: '/ui.js', line: 12, stack: 'at f (/ui.js:12:3)', url: 'http://h/' });
  assert.equal(real.status, 201);
  assert.equal((await real.json()).item.userAgent, 'TestBrowser/1.0');
  // A "Script error." that does carry a location is still kept: it came from our own code.
  assert.equal((await send({ type: 'error', message: 'Script error.', source: '/ui.js', line: 40, url: 'http://h/' })).status, 201);
  const events = (await (await fetch(`${base}/api/quality`)).json()).events;
  assert.equal(events.filter(e => e.message === 'Script error.').length, 1);
  assert.ok(events.some(e => e.message === 'TypeError: x is undefined'));
});
