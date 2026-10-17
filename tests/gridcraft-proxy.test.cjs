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
      if (req.url === '/workbook') return res.end(JSON.stringify({ ok: true, title: 'Sales', file: 'C:\\Users\\someone\\Sales.xlsx', dirty: true, activeSheet: 'Q1', path: 'C:\\Users\\someone\\Sales.xlsx', sheets: [{ name: 'Q1', usedRange: 'A1:C3', cells: 9, extra: 'C:\\x' }] }));
      if (req.url === '/workbooks') return res.end(JSON.stringify({ ok: true, folder: 'C:\\Users\\someone\\Documents\\GridCraft', workbooks: [{ name: 'Sales.xlsx', size: 10, modified: 1700000000 }] }));
      if (req.url.startsWith('/range')) return res.end(JSON.stringify({ ok: true, range: 'A1:B2', rows: [[1, 'a'], [null, { error: '#DIV/0!', where: 'C:\\x' }]], truncated: true }));
      if (req.url === '/open') { res.statusCode = JSON.parse(body).name === 'busy.xlsx' ? 409 : 200; return res.end(JSON.stringify(res.statusCode === 409 ? { ok: false, error: 'GridCraft is busy with a request' } : { ok: true, name: JSON.parse(body).name })); }
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

  // System › Spreadsheets' workbook view: read-only reads, and /open by file name only.
  const book = await (await fetch(`${base}/api/gridcraft/workbook`)).json();
  assert.deepEqual(book, { ok: true, title: 'Sales', file: 'Sales.xlsx', dirty: true, activeSheet: 'Q1', sheets: [{ name: 'Q1', usedRange: 'A1:C3', cells: 9 }] });
  const books = await (await fetch(`${base}/api/gridcraft/workbooks`)).json();
  assert.deepEqual(books, { ok: true, workbooks: [{ name: 'Sales.xlsx', size: 10, modified: 1700000000 }] }, 'no host folder path');
  const range = await fetch(`${base}/api/gridcraft/range?sheet=Q%201&range=a1:c3&path=C:/x`);
  assert.equal(range.status, 200);
  assert.deepEqual(await range.json(), { ok: true, range: 'A1:B2', rows: [[1, 'a'], [null, { error: '#DIV/0!' }]], truncated: true });
  assert.equal(seen.find(x => x.url.startsWith('/range')).url, '/range?sheet=Q+1&range=A1%3AC3', 'only sheet and range are forwarded');
  for (const q of ['range=A1:B2;rm', 'range=Sheet1!A1', 'range=A1:B', `sheet=${'x'.repeat(101)}`]) {
    assert.equal((await fetch(`${base}/api/gridcraft/range?${q}`)).status, 400, q);
  }
  assert.equal(seen.filter(x => x.url.startsWith('/range')).length, 1, 'invalid reads never reach the bridge');
  const post = (body, headers = {}) => fetch(`${base}/api/gridcraft/open`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...headers }, body: JSON.stringify(body) });
  const opened = await post({ name: 'Sales.xlsx', path: 'C:\\Windows' });
  assert.equal(opened.status, 200);
  assert.deepEqual(JSON.parse(seen.find(x => x.url === '/open').body), { name: 'Sales.xlsx' }, 'only the name is forwarded');
  assert.equal((await post({ name: 'busy.xlsx' })).status, 409, 'bridge status passes through');
  for (const name of ['..\\x.xlsx', 'C:\\x.xlsx', 'a/b.xlsx', '', 42]) assert.equal((await post({ name })).status, 400, String(name));
  assert.equal((await post({ name: 'Sales.xlsx' }, { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await post({ name: 'Sales.xlsx' }, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal(seen.filter(x => x.url === '/open').length, 2, 'rejected opens never reach the bridge');

  bridge.close();
  await new Promise(r => setTimeout(r, 50));
  const down = await fetch(`${base}/api/gridcraft/health`);
  assert.equal(down.status, 502);
  assert.equal((await down.json()).ok, false);
});

test('Spreadsheets and the Services card use the appliance route; the old page sends you to Spreadsheets', () => {
  const pub = path.resolve(__dirname, '../app/public');
  const page = fs.readFileSync(path.join(pub, 'spreadsheets.js'), 'utf8');
  assert.match(page, /API='\/api\/gridcraft'/);
  assert.doesNotMatch(page, /8787/);
  const hub = fs.readFileSync(path.join(pub, 'ui.js'), 'utf8');
  assert.match(hub, /fetch\('\/api\/gridcraft\/health'/);
  assert.match(hub, /view: 'spreadsheets', label: 'Open Spreadsheets'/);
  assert.match(fs.readFileSync(path.join(pub, 'gridcraft.html'), 'utf8'), /url=\/#spreadsheets/);
});
