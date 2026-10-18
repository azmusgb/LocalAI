'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { spawnAppServer } = require('./spawn-server.cjs');

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
      if (req.url === '/run') {
        const { mode } = JSON.parse(body);
        const journal = { mode, edits: mode === 'read' ? [] : [{ tool: 'set_cell', sheet: 'Sales', range: 'B2', before: [[1]], after: [[2]], afterValues: [[2]] }], changes: [], undoSteps: mode === 'read' ? 0 : 1, undoTop: ['Enter Cell'], saved: false };
        if (JSON.parse(body).prompt === 'fail') { res.statusCode = 500; return res.end(JSON.stringify({ ok: false, error: 'GridCraft agent failed', reason: 'boom', journal })); }
        return res.end(JSON.stringify({ ok: true, answer: 'done', durationSec: 0.1, journal, stdout: 'log' }));
      }
      if (/^\/workbook(\?|$)/.test(req.url)) return res.end(JSON.stringify({ ok: true, file: 'Q.xlsx', sheet: new URL(req.url, 'http://x').searchParams.get('sheet') }));
      if (req.url === '/workbooks') return res.end(JSON.stringify({ ok: true, items: [{ name: 'Budget.xlsx', size: 9, modified: '2026-10-17T10:00:00+00:00', path: 'C:\\Users\\someone\\Budget.xlsx' }, { name: '..\\evil.xlsx', size: 1 }] }));
      if (req.url === '/open') {
        if (JSON.parse(body).name === 'Gone.xlsx') { res.statusCode = 404; return res.end(JSON.stringify({ ok: false, error: 'Gone.xlsx is not in the GridCraft folder' })); }
        return res.end(JSON.stringify({ ok: true, file: JSON.parse(body).name }));
      }
      if (req.url === '/keep') return res.end(JSON.stringify({ ok: true, dirty: false }));
      if (req.url === '/discard') {
        if (JSON.parse(body).undoTop?.[0] !== 'Enter Cell') { res.statusCode = 409; return res.end(JSON.stringify({ ok: false, error: 'The workbook changed in GridCraft after this request' })); }
        return res.end(JSON.stringify({ ok: true, dirty: false }));
      }
      res.statusCode = 404; res.end('{}');
    });
  });
  bridge.listen(0, '127.0.0.1');
  await once(bridge, 'listening');

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-gridcraft-'));
  const off = 'http://127.0.0.1:9';
  const { child, ready } = spawnAppServer({
    env: { DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, GRIDCRAFT_URL: `http://127.0.0.1:${bridge.address().port}`, OLLAMA_URL: off, SEARXNG_URL: off, COMFY_URL: off, N8N_URL: off, PROXY_URL: off, MAC_AI_HOME_URL: off, MAC_DSH_URL: off }
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
    bridge.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = await ready;

  const health = await fetch(`${base}/api/gridcraft/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, gridcraftConnected: true, model: 'qwen3:4b-instruct' }, 'host paths are not passed through');

  const run = await fetch(`${base}/api/gridcraft/run`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ prompt: 'sum column B', extra: 'dropped' }) });
  assert.equal(run.status, 200);
  const first = await run.json();
  assert.equal(first.answer, 'done');
  assert.equal(first.run.status, 'review', 'a Review request that changed cells waits for the owner');
  assert.deepEqual(first.run.edits[0].after, [[2]]);
  assert.equal('stdout' in first, false, 'the agent log stays on the bridge');
  const forwarded = seen.find(x => x.url === '/run');
  assert.deepEqual(JSON.parse(forwarded.body), { prompt: 'sum column B', mode: 'review' }, 'only the prompt and mode are forwarded; Review is the default');
  assert.equal(forwarded.type, 'application/json');

  const crossSite = await fetch(`${base}/api/gridcraft/run`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' }, body: '{"prompt":"x"}' });
  assert.equal(crossSite.status, 403);
  const formPost = await fetch(`${base}/api/gridcraft/run`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"prompt":"x"}' });
  assert.equal(formPost.status, 415);
  const badMode = await fetch(`${base}/api/gridcraft/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"prompt":"x","mode":"root"}' });
  assert.equal(badMode.status, 400);
  assert.equal(seen.filter(x => x.url === '/run').length, 1, 'rejected requests never reach the bridge');

  const post = (p, body = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const read = await (await post('/api/gridcraft/run', { prompt: 'what is in B2', mode: 'read' })).json();
  assert.equal(read.run.status, 'done');
  const failed = await (await post('/api/gridcraft/run', { prompt: 'fail', mode: 'review' })).json();
  assert.equal(failed.ok, false);
  assert.equal(failed.run.status, 'review', 'a failed Review request that changed cells can still be discarded');
  assert.equal(failed.run.error, 'GridCraft agent failed: boom');

  const waiting = await post('/api/gridcraft/open', { name: 'Budget.xlsx' });
  assert.equal(waiting.status, 409, 'opening another workbook would strand the requests waiting for review');
  assert.match((await waiting.json()).error, /waiting for review/);
  assert.equal(seen.some(x => x.url === '/open'), false);

  const runs = (await (await fetch(`${base}/api/gridcraft/runs`)).json()).items;
  assert.deepEqual(runs.map(x => x.status), ['review', 'done', 'review'], 'newest first');
  const older = await post(`/api/gridcraft/runs/${first.run.id}/discard`);
  assert.equal(older.status, 409);
  assert.match((await older.json()).error, /Only the latest request/);
  const discard = await post(`/api/gridcraft/runs/${failed.run.id}/discard`);
  assert.equal(discard.status, 200);
  assert.deepEqual(JSON.parse(seen.find(x => x.url === '/discard').body), { steps: 1, undoTop: ['Enter Cell'] });
  assert.equal((await post(`/api/gridcraft/runs/${failed.run.id}/discard`)).status, 409, 'not twice');
  const keep = await (await post(`/api/gridcraft/runs/${first.run.id}/keep`)).json();
  assert.deepEqual(keep.runs, [first.run.id]);
  assert.deepEqual((await (await fetch(`${base}/api/gridcraft/runs`)).json()).items.map(x => x.status), ['discarded', 'done', 'kept']);
  assert.equal((await fetch(`${base}/api/gridcraft/runs/${first.run.id}/keep`, { method: 'POST', headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await post('/api/gridcraft/runs/gc-nope/keep')).status, 404);

  const books = await (await fetch(`${base}/api/gridcraft/workbooks`)).json();
  assert.deepEqual(books, { ok: true, items: [{ name: 'Budget.xlsx', size: 9, modified: '2026-10-17T10:00:00+00:00' }] }, 'names, sizes and dates only; never a path');
  const opened = await fetch(`${base}/api/gridcraft/open`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ name: 'Budget.xlsx', path: 'C:\\x' }) });
  assert.equal(opened.status, 200);
  assert.deepEqual(await opened.json(), { ok: true, file: 'Budget.xlsx' });
  assert.deepEqual(JSON.parse(seen.find(x => x.url === '/open').body), { name: 'Budget.xlsx' }, 'only the name is forwarded');
  for (const name of ['../Budget.xlsx', 'C:\\Users\\x\\Budget.xlsx', 'sub/Budget.xlsx', '..', 'notes.txt', '', 42]) {
    assert.equal((await post('/api/gridcraft/open', { name })).status, 400, `refuses ${JSON.stringify(name)}`);
  }
  const crossOpen = await fetch(`${base}/api/gridcraft/open`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' }, body: '{"name":"Budget.xlsx"}' });
  assert.equal(crossOpen.status, 403);
  assert.equal((await fetch(`${base}/api/gridcraft/open`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"name":"Budget.xlsx"}' })).status, 415);
  const gone = await post('/api/gridcraft/open', { name: 'Gone.xlsx' });
  assert.equal(gone.status, 404);
  assert.match((await gone.json()).error, /not in the GridCraft folder/);
  assert.equal(seen.filter(x => x.url === '/open').length, 2, 'refused names never reach the bridge');

  const wb = await (await fetch(`${base}/api/gridcraft/workbook?sheet=Sales&other=1`)).json();
  assert.deepEqual(wb, { ok: true, file: 'Q.xlsx', sheet: 'Sales' });
  assert.equal(seen.find(x => /^\/workbook(\?|$)/.test(x.url)).url, '/workbook?sheet=Sales', 'only sheet and range are forwarded');

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

test('a GridCraft request that takes longer than fetch allows still gets its answer; a time-out says so', { timeout: 60000 }, async t => {
  // undici (the global fetch) stops waiting for headers after 300 s whatever the caller's deadline, and the bridge
  // can take longer than that. The preload shortens that limit to 1 s; the bridge answers after 2.5 s.
  const preload = path.join(__dirname, 'short-undici-timeouts.cjs');
  const SLOW_MS = 2500;
  const bridge = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const reply = body => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };
      if (req.url === '/run') return setTimeout(() => reply({ ok: true, answer: 'slow but done', durationSec: 2.5, journal: { mode: 'read', edits: [], changes: [], undoSteps: 0 } }), SLOW_MS);
      if (req.url === '/workbooks') return setTimeout(() => reply({ ok: true, items: [{ name: 'Budget.xlsx', size: 9 }] }), SLOW_MS);
      if (req.url === '/health') return setTimeout(() => reply({ ok: true, gridcraftConnected: true }), 6000); // past the proxy's 4 s
      res.statusCode = 404; res.end('{}');
    });
  });
  bridge.listen(0, '127.0.0.1');
  await once(bridge, 'listening');
  const bridgeUrl = `http://127.0.0.1:${bridge.address().port}`;
  const env = { UNDICI_TIMEOUT_MS: '1000', NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require ${JSON.stringify(preload)}`.trim() };

  // The shortened limit is real: a plain fetch from a process with the preload gives up.
  const { execFile } = require('node:child_process');
  const plain = await new Promise(resolve => execFile(process.execPath, ['-e', `fetch(${JSON.stringify(bridgeUrl + '/run')}, { method: 'POST', body: '{}' }).then(() => console.log('answered'), e => console.log(e.message, e.cause?.code))`], { env: { ...process.env, ...env } }, (err, stdout) => resolve(stdout.trim())));
  assert.match(plain, /fetch failed UND_ERR_HEADERS_TIMEOUT/, 'the preload shortens the global fetch timeout');

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-gridcraft-slow-'));
  const off = 'http://127.0.0.1:9';
  const { child, ready } = spawnAppServer({
    env: { ...env, DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, GRIDCRAFT_URL: bridgeUrl, OLLAMA_URL: off, SEARXNG_URL: off, COMFY_URL: off, N8N_URL: off, PROXY_URL: off, MAC_AI_HOME_URL: off, MAC_DSH_URL: off }
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
    bridge.closeAllConnections(); bridge.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = await ready;
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  const [run, books] = await Promise.all([post('/api/gridcraft/run', { prompt: 'total column B', mode: 'read' }), fetch(`${base}/api/gridcraft/workbooks`)]);
  const ran = await run.json();
  assert.equal(run.status, 200, JSON.stringify(ran));
  assert.equal(ran.answer, 'slow but done', 'the proxy waited past the shortened fetch limit');
  assert.equal(ran.run.status, 'done');
  assert.equal(books.status, 200);
  assert.deepEqual((await books.json()).items.map(x => x.name), ['Budget.xlsx']);

  const health = await fetch(`${base}/api/gridcraft/health`);
  const late = await health.json();
  assert.equal(health.status, 504);
  assert.equal(late.error, 'GridCraft took too long to answer');
  assert.doesNotMatch(JSON.stringify(late), /fetch failed/);

  bridge.closeAllConnections(); bridge.close();
  await new Promise(r => setTimeout(r, 50));
  const down = await (await post('/api/gridcraft/run', { prompt: 'x', mode: 'read' })).json();
  assert.match(down.error, /^GridCraft bridge unavailable/);
  assert.doesNotMatch(down.error, /fetch failed|Ollama/);
});
