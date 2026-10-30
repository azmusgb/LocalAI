'use strict';

// GET /api/world (app/world.js): Agent World's read-only summary of the models, the printer, Spreadsheets and the Workshop
// display. Every source cached (models 10 s, Spreadsheets 15 s, the display at most once a minute), one read at a time,
// an honest null for whatever is down, no secrets, and an ETag so a poll that changes nothing is a 304.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { spawnAppServer } = require('./spawn-server.cjs');
const { createWorld, cached, KIOSK_MS, MODELS_MS, SHEETS_MS, LEDGER_MS } = require('../app/world');
const workshop = require('../app/workshop');

const TOKEN = 'wsl_ABCDEFGHJKLMNPQRSTUVWXYZ23'; // synthetic, the status token's format
const PS = { models: [
  { name: 'qwen3:4b-instruct-32k', model: 'qwen3:4b-instruct-32k', size: 4187593113, size_vram: 4187593113, digest: 'd'.repeat(64), details: { family: 'qwen3' }, expires_at: '2026-10-19T12:00:00Z' },
  { name: 'nomic-embed-text:latest', size: 300 * 1024 * 1024, size_vram: 0 },
  { name: '<script>bad</script>', size: 1 }
] };
const LITE = { schema: 1, firmware: { version: '12.1.0', sourceCommit: 'a'.repeat(40) }, printers: [{ slot: 0, connection: 'online', activity: 'printing', freshness: 'fresh', ageSeconds: 3, progressPercent: 42, remainingMinutes: 65, error: null, name: 'X2D', ip: '10.0.0.50' }] };
const RUN = { id: 'run-1', type: 'chat', status: 'running', title: 'Plan the week', createdAt: '2026-10-27T10:00:00Z', updatedAt: '2026-10-27T10:00:01Z', meta: { token: TOKEN, url: 'http://10.0.0.5' } };
const SESSIONS = [
  { id: 'cc-a', title: 'Fix tests', state: 'working', lastEvent: 'Edit', at: '2026-10-27T10:00:00Z' },
  { id: 'cc-b', title: 'Review', state: 'waiting', lastEvent: 'Stop', at: '2026-10-27T09:59:00Z' }
];
const ok = body => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

// A world with stand-ins for every source, counting calls, on a clock the test moves.
function fakeWorld(over = {}) {
  const calls = { ps: 0, sheets: 0, kiosk: 0 }, clock = { t: 1e6 };
  const world = createWorld({
    ollamaUrl: 'http://ollama.test:11434',
    fetchImpl: async url => { calls.ps++; assert.equal(url, 'http://ollama.test:11434/api/ps'); return ok(PS); },
    modelQueue: () => ({ active: 1, waiting: 2 }),
    busy: () => ({ busy: true, active: [{ kind: 'mission', title: 'x' }, { kind: 'chat', title: 'y' }, { kind: 'mission', title: 'z' }] }),
    printer: { enabled: true, current: () => ({ state: 'printing', progress: 42, minutesLeft: 65, errorCode: null, access: 'ok', seenAt: new Date().toISOString() }), firmware: () => '12.1.0' },
    bridgeHealth: async () => { calls.sheets++; return { bridge: true, excel: true }; },
    gridcraftInFlight: () => 1,
    kioskUrl: () => 'http://10.0.0.124',
    kioskHealth: async url => { calls.kiosk++; assert.equal(url, 'http://10.0.0.124'); return { online: true, signIn: false, board: 'b', portalUrl: url }; },
    runs: () => [RUN],
    crews: () => SESSIONS,
    now: () => clock.t,
    ...over
  });
  return { world, calls, clock };
}

test('the summary: models, printer, sheets, kiosk and crews, small and in plain fields', async () => {
  const { world } = fakeWorld();
  const s = await world.summary();
  assert.deepEqual(s, {
    schema: 1,
    models: { loaded: [{ name: 'qwen3:4b-instruct-32k', sizeMb: 3994, vramMb: 3994 }, { name: 'nomic-embed-text:latest', sizeMb: 300, vramMb: 0 }], queue: { active: 1, waiting: 2 }, busy: { total: 3, kinds: { mission: 2, chat: 1 } } },
    printer: { setUp: true, access: 'ok', state: 'printing', progress: 42, minutesLeft: 65, errorCode: null },
    sheets: { bridge: true, excel: true, inFlight: 1 },
    kiosk: { setUp: true, online: true, signIn: true, firmware: '12.1.0' },
    street: s.street,
    crews: [{ id: 'cc-a', title: 'Fix tests', state: 'working', lastAction: 'Edit' }, { id: 'cc-b', title: 'Review', state: 'waiting', lastAction: 'Stop' }]
  });
  assert.equal(s.street.chat.running[0].id, 'run-1');
  // a busy appliance: six models with long names and many kinds of work still fits in about 3 KB
  const big = fakeWorld({
    fetchImpl: async () => ok({ models: Array.from({ length: 20 }, (_, i) => ({ name: `library/some-long-model-name-${i}:70b-instruct-q4_K_M`, size: 4e10, size_vram: 6e9 })) }),
    busy: () => ({ active: Array.from({ length: 200 }, (_, i) => ({ kind: `kind-${i % 30}-${'x'.repeat(60)}` })) })
  });
  const b = await big.world.summary();
  assert.equal(b.models.loaded.length, 6);
  assert.equal(Object.keys(b.models.busy.kinds).length, 8);
  assert.equal(b.models.busy.total, 200);
  assert.ok(JSON.stringify(b).length <= 3 * 1024, `${JSON.stringify(b).length} bytes`);
});

test('street comes from the ledger, read at most once per LEDGER_MS', async () => {
  assert.equal(LEDGER_MS, 5000);
  let n = 0;
  const { world, clock } = fakeWorld({ runs: () => { n++; return [RUN]; } });
  await world.summary(); const s = await world.summary();
  assert.equal(n, 1);
  assert.equal(s.street.chat.running[0].id, RUN.id);
  clock.t += LEDGER_MS; await world.summary();
  assert.equal(n, 2);
});

test('crews are read at most once per LEDGER_MS too', async () => {
  let n = 0;
  const { world, clock } = fakeWorld({ crews: () => { n++; return SESSIONS; } });
  await world.summary(); const s = await world.summary();
  assert.equal(n, 1);
  assert.equal(s.crews.length, 2);
  clock.t += LEDGER_MS; await world.summary();
  assert.equal(n, 2);
});

test('a flood: every building at its caps with 80-character titles and 6 crews stays within 17 KB', async () => {
  const types = ['chat', 'image', 'agent', 'engineering', 'spreadsheet', 'automation'];
  const at = new Date(1e6 - 60000).toISOString(), long = n => `${n}-${'w'.repeat(200)}`;
  const runs = [];
  for (const type of types) {
    for (let i = 0; i < 10; i++) {
      // ids as long as real ones: legacy-engineering:eng-mv8rra3x-77ea11 is 38 characters, a ledger id 25
      for (const status of ['running', 'queued', 'awaiting_approval', 'failed', 'completed']) runs.push({ id: `legacy-engineering:${type.slice(0, 4)}-${status.slice(0, 4)}-${i}-mv8rra3x`, type, status, title: long(`${type} ${status} ${i}`), meta: { label: long(`${type} ${status} ${i}`) }, createdAt: at, updatedAt: at, finishedAt: at });
    }
  }
  const crews = Array.from({ length: 10 }, (_, i) => ({ id: `0f6c2a1e-7b3d-4c59-9e21-5a8d3b7c${String(i).padStart(4, '0')}` /* a Claude session id */, title: 't'.repeat(200), state: 'working', lastEvent: 'e'.repeat(200) }));
  const { world } = fakeWorld({ runs: () => runs, crews: () => crews });
  const s = await world.summary();
  for (const k of Object.keys(s.street)) {
    const b = s.street[k];
    assert.deepEqual([b.running.length, b.needsYou.length, b.failedUnseen.length, b.recent.length], [3, 3, 3, 3], k);
    assert.ok([...b.running, ...b.recent].every(x => x.title.length === 80), k);
  }
  assert.equal(s.crews.length, 6);
  const size = JSON.stringify(s).length;
  assert.ok(size <= 17 * 1024, `${size} bytes`);
});

test('street is null when the ledger throws, and the rest still answers', async () => {
  const { world } = fakeWorld({ runs: () => { throw new Error('x'); } });
  const s = await world.summary();
  assert.equal(s.street, null);
  assert.equal(s.models.loaded.length, 2);
});

test('crews come from the board', async () => {
  assert.equal((await fakeWorld().world.summary()).crews.length, 2);
  assert.equal((await fakeWorld({ crews: () => null }).world.summary()).crews, null);
  assert.equal((await fakeWorld({ crews: () => { throw new Error('x'); } }).world.summary()).crews, null);
});

test('the answer has no address or secret in street or crews', async () => {
  const { world } = fakeWorld();
  const text = JSON.stringify(await world.summary());
  for (const secret of [TOKEN, 'wsl_', '10.0.0.5', 'http://']) assert.ok(!text.includes(secret), `the answer holds ${secret}`);
});

test('the display is asked at most once a minute, counted from when a request starts, however often the page polls', async () => {
  assert.equal(KIOSK_MS, 60000);
  const { world, calls, clock } = fakeWorld();
  for (let i = 0; i < 30; i++) { await world.summary(); clock.t += 1999; } // 30 polls over 59.97 s
  assert.equal(calls.kiosk, 1);
  clock.t += 30; await world.summary(); // 60 s after the first started
  assert.equal(calls.kiosk, 2);
  // a display that throws or never answers well is not asked again sooner
  const failing = fakeWorld({ kioskHealth: async () => { failing.calls.kiosk++; throw new Error('down'); } });
  for (let i = 0; i < 10; i++) { const s = await failing.world.summary(); assert.equal(s.kiosk.online, null); failing.clock.t += 5000; }
  assert.equal(failing.calls.kiosk, 1);
});

test('models are read at most every 10 s and Spreadsheets every 15 s', async () => {
  assert.equal(MODELS_MS, 10000); assert.equal(SHEETS_MS, 15000);
  const { world, calls, clock } = fakeWorld();
  for (let i = 0; i < 31; i++) { await world.summary(); clock.t += 1000; } // 0 .. 30 s
  assert.equal(calls.ps, 4, 'at 0, 10, 20 and 30 s');
  assert.equal(calls.sheets, 3, 'at 0, 15 and 30 s');
  assert.equal(calls.kiosk, 1);
});

test('single-flight: polls that arrive while a read is under way share it', async () => {
  let release, started = 0;
  const gate = new Promise(r => { release = r; });
  const { world, calls } = fakeWorld({ kioskHealth: async () => { started++; await gate; return { online: true, signIn: true }; } });
  const all = Promise.all(Array.from({ length: 8 }, () => world.summary()));
  await new Promise(r => setImmediate(r));
  assert.equal(started, 1);
  release();
  const answers = await all;
  assert.equal(started, 1);
  assert.equal(calls.ps, 1);
  assert.equal(calls.sheets, 1);
  assert.ok(answers.every(a => a.kiosk.online === true));
  // the helper itself: one read in flight, then the cached value
  let n = 0; const get = cached(async () => ++n, 1000, () => 0);
  assert.deepEqual(await Promise.all([get(), get(), get()]), [1, 1, 1]);
  assert.equal(await get(), 1);
});

test('every source down or not set up says null, never 0, [] or an old value', async () => {
  const down = fakeWorld({
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    modelQueue: () => { throw new Error('no queue'); },
    busy: () => { throw new Error('no store'); },
    printer: { enabled: true, current: () => ({ state: 'unknown', progress: null, minutesLeft: null, errorCode: null, access: 'offline', seenAt: null }), firmware: () => '12.1.0' },
    bridgeHealth: async () => ({ bridge: false, excel: null }),
    gridcraftInFlight: () => 0,
    kioskHealth: async () => ({ online: false, signIn: null }),
    runs: () => { throw new Error('no ledger'); },
    crews: () => null
  });
  assert.deepEqual(await down.world.summary(), {
    schema: 1,
    models: { loaded: null, queue: null, busy: null },
    printer: { setUp: true, access: 'offline', state: null, progress: null, minutesLeft: null, errorCode: null },
    sheets: { bridge: false, excel: null, inFlight: 0 },
    kiosk: { setUp: true, online: false, signIn: null, firmware: null },
    street: null,
    crews: null
  });
  // Ollama answering an error or something odd is also null
  for (const r of [new Response('{}', { status: 500 }), ok({ models: 'x' }), new Response('not json', { status: 200 })]) {
    const w = fakeWorld({ fetchImpl: async () => r });
    assert.equal((await w.world.summary()).models.loaded, null);
  }
  // a bridge that throws, the printer and the display not set up
  const unset = fakeWorld({ printer: { enabled: false, current: () => null, firmware: () => null }, bridgeHealth: async () => { throw new Error('x'); }, kioskUrl: () => null, kioskHealth: async () => { throw new Error('must not be asked'); } });
  const u = await unset.world.summary();
  assert.deepEqual(u.printer, { setUp: false, access: null, state: null, progress: null, minutesLeft: null, errorCode: null });
  assert.deepEqual(u.sheets, { bridge: null, excel: null, inFlight: 1 });
  assert.deepEqual(u.kiosk, { setUp: false, online: null, signIn: null, firmware: null });
  assert.equal(unset.calls.kiosk, 0);
  // a firmware version that isn't a plain short version is dropped
  for (const fw of ['12.1.0<script>', 'x'.repeat(25), '', 12]) {
    const w = fakeWorld({ printer: { enabled: true, current: () => ({ access: 'ok', state: 'idle' }), firmware: () => fw } });
    assert.equal((await w.world.summary()).kiosk.firmware, null, String(fw));
  }
});

test('ETag: a poll that changes nothing is a 304; a change is a new 200', async t => {
  let excel = true;
  const { world, clock } = fakeWorld({ bridgeHealth: async () => ({ bridge: true, excel }) });
  const server = http.createServer((req, res) => world.api(req, res));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(r => server.close(r)));
  const url = `http://127.0.0.1:${server.address().port}/api/world`;
  const first = await fetch(url);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'no-cache');
  assert.match(first.headers.get('content-type'), /application\/json/);
  const etag = first.headers.get('etag');
  assert.match(etag, /^"w-[\w-]{22}"$/);
  await first.json();
  clock.t += 20000; // every cache refreshed, nothing changed
  const same = await fetch(url, { headers: { 'If-None-Match': etag } });
  assert.equal(same.status, 304);
  assert.equal(same.headers.get('etag'), etag);
  assert.equal(await same.text(), '');
  const weak = await fetch(url, { headers: { 'If-None-Match': `"other", W/${etag}` } });
  assert.equal(weak.status, 304);
  excel = false; clock.t += 20000;
  const changed = await fetch(url, { headers: { 'If-None-Match': etag } });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.get('etag'), etag);
  assert.equal((await changed.json()).sheets.excel, false);
});

// A stand-in Workshop display (health, and status lite for TOKEN), Ollama and GridCraft bridge, each counting requests.
async function standIns() {
  const seen = { device: [], ollama: [], bridge: [] };
  const serve = (list, handler) => { const s = http.createServer((req, res) => { list.push(`${req.method} ${req.url}`); res.setHeader('Content-Type', 'application/json'); handler(req, res); }); s.listen(0, '127.0.0.1'); return s; };
  const device = serve(seen.device, (req, res) => {
    if (req.url === '/api/records') return res.end(JSON.stringify({ records: [{ id: 'printer', source: 'bambuddy', state: 'paused', as_of: Math.floor(Date.now() / 1000), stale: false, detail: { progress: 32, minutes_left: 12 } }] }));
    if (req.url === '/api/status/lite') return req.headers.authorization === `Bearer ${TOKEN}` ? res.end(JSON.stringify(LITE)) : (res.statusCode = 401, res.end('{}'));
    if (req.url === '/hardware/health') { res.statusCode = 401; return res.end('{"error":"sign in"}'); }
    res.statusCode = 404; res.end('{}');
  });
  const ollama = serve(seen.ollama, (req, res) => res.end(JSON.stringify(req.url === '/api/ps' ? PS : { models: [] })));
  const bridge = serve(seen.bridge, (req, res) => res.end(JSON.stringify(req.url === '/health' ? { ok: true, gridcraftConnected: false, workbookPath: 'C:\\Users\\owner\\secret.xlsx' } : { ok: false })));
  await Promise.all([device, ollama, bridge].map(s => once(s, 'listening')));
  const url = s => `http://127.0.0.1:${s.address().port}`;
  return { seen, urls: { device: url(device), ollama: url(ollama), bridge: url(bridge) }, close: () => Promise.all([device, ollama, bridge].map(s => { s.closeAllConnections(); return new Promise(r => s.close(r)); })) };
}

test('GET /api/world through the appliance: the display sees one health GET a minute, no secrets, sign-in report-only', { timeout: 30000 }, async t => {
  const fake = await standIns();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-world-'));
  const off = 'http://127.0.0.1:9';
  const { child, ready } = spawnAppServer({
    env: { DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, LOCALAI_PI_HUB_URL: fake.urls.device, LOCALAI_WORKSHOP_URL: fake.urls.device, LOCALAI_WORKSHOP_STATUS_TOKEN: TOKEN, LOCALAI_WORKSHOP_CODE_TOKEN: 'wsc_QRSTUVWXYZ23456789ABCDEFGH', GRIDCRAFT_URL: fake.urls.bridge, OLLAMA_URL: fake.urls.ollama, SEARXNG_URL: off, COMFY_URL: off, N8N_URL: off, PROXY_URL: off, MAC_AI_HOME_URL: off, MAC_DSH_URL: off }
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
    await fake.close().catch(() => {});
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = await ready;
  // the poller's first read of the printer happens at start
  for (let i = 0; i < 50 && !fake.seen.device.includes('GET /api/status/lite'); i++) await new Promise(r => setTimeout(r, 100));
  const healthGets = () => fake.seen.device.filter(x => x === 'GET /hardware/health').length;
  const before = fake.seen.device.length;

  const r = await fetch(`${base}/api/world`, { headers: { 'X-Forwarded-For': '10.0.0.77', 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' } });
  assert.equal(r.status, 200, 'report-only: a caller without sign-in still gets the answer');
  const text = await r.text(), body = JSON.parse(text);
  assert.deepEqual(Object.keys(body), ['schema', 'models', 'printer', 'sheets', 'kiosk', 'street', 'crews']);
  assert.deepEqual(body.models.loaded.map(m => m.name), ['qwen3:4b-instruct-32k', 'nomic-embed-text:latest']);
  assert.deepEqual(body.models.queue, { active: 0, waiting: 0 });
  assert.deepEqual(body.printer, { setUp: true, access: 'ok', state: 'paused', progress: 32, minutesLeft: 12, errorCode: null, source: 'bambuddy', via: 'pi-hub', seenAt: body.printer.seenAt });
  assert.ok(Number.isFinite(Date.parse(body.printer.seenAt)));
  assert.deepEqual(body.sheets, { bridge: true, excel: false, inFlight: 0 });
  assert.deepEqual(body.kiosk, { setUp: true, online: true, signIn: true, firmware: '12.1.0' });
  assert.deepEqual(Object.keys(body.street), ['chat', 'images', 'missions', 'garage', 'sheets', 'clock']);
  assert.deepEqual(body.crews, []);
  assert.ok(text.length <= 3 * 1024, `${text.length} bytes`);
  for (const secret of [TOKEN, 'wsc_', 'Bearer', 'a'.repeat(40), 'secret.xlsx', 'C:\\\\', fake.urls.device, fake.urls.ollama, fake.urls.bridge, '127.0.0.1', '10.0.0.50', 'X2D', 'd'.repeat(64)]) assert.ok(!text.includes(secret), `the answer holds ${secret}`);

  // polls in a burst and one after another: still one health GET, and the same ETag is a 304
  const etag = r.headers.get('etag');
  await Promise.all(Array.from({ length: 5 }, () => fetch(`${base}/api/world`).then(x => x.text())));
  const again = await fetch(`${base}/api/world`, { headers: { 'If-None-Match': etag } });
  assert.equal(again.status, 304);
  assert.equal(healthGets(), 1, 'one health GET for seven polls');
  assert.equal(fake.seen.device.filter(x => x === 'GET /api/records').length, 1, 'one household record fetch for seven polls');
  assert.deepEqual(fake.seen.device.slice(before).filter(x => !['GET /api/status/lite', 'GET /api/records'].includes(x)), ['GET /hardware/health'], 'nothing else is sent to the display');
  assert.equal(fake.seen.ollama.filter(x => x === 'GET /api/ps').length, 1);
  assert.equal(fake.seen.bridge.filter(x => x === 'GET /health').length, 1);

  // the request without sign-in is listed as one that would be refused (sign-in is report-only for now)
  const report = await (await fetch(`${base}/api/signin/report`)).json();
  assert.ok(report.callers.some(c => c.ip === '10.0.0.77' && c.lastPath === '/api/world'), JSON.stringify(report.callers));
  // read-only: nothing else answers there
  const post = await fetch(`${base}/api/world`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.notEqual(post.status, 200);
});

// Engineering, automation and spreadsheet runs live in their own stores, not the run ledger; Work and Home merge them in
// (app/server/runs.js unifiedRunItems), and so must Main Street, or the garage, the clock and the sheets office stay empty.
test('GET /api/world: Main Street shows engineering, automation and spreadsheet runs from their own stores', { timeout: 30000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-world-street-'));
  const at = new Date(Date.now() - 60000).toISOString(), done = new Date(Date.now() - 30000).toISOString();
  const { Storage } = require('../app/storage');
  const storage = new Storage({ dataDir });
  storage.put('engineeringRuns', { id: 'eng-1', request: 'Add a dark mode toggle', target: 'self', status: 'awaiting_approval', createdAt: at, updatedAt: at, steps: [] });
  storage.put('automationRuns', { id: 'auto-1', automationId: 'a1', name: 'Morning check', status: 'complete', startedAt: at, finishedAt: done, output: 'ok' });
  storage.writeSetting('gridcraft:run:gc-1', { id: 'gc-1', prompt: 'Total column B', status: 'review', createdAt: at, updatedAt: at });
  storage.close?.();
  const off = 'http://127.0.0.1:9';
  const { child, ready } = spawnAppServer({ env: { DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, OLLAMA_URL: off, GRIDCRAFT_URL: off, SEARXNG_URL: off, COMFY_URL: off, N8N_URL: off, PROXY_URL: off, MAC_AI_HOME_URL: off, MAC_DSH_URL: off } });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = await ready;
  const { street } = await (await fetch(`${base}/api/world`)).json();
  assert.deepEqual(street.garage.needsYou.map(x => x.id), ['legacy-engineering:eng-1'], JSON.stringify(street.garage));
  assert.equal(street.garage.needsYou[0].title, 'Add a dark mode toggle');
  assert.deepEqual(street.clock.recent.map(x => x.id), ['legacy-automation:auto-1'], JSON.stringify(street.clock));
  assert.deepEqual(street.sheets.needsYou.map(x => x.id), ['legacy-gridcraft:gc-1'], JSON.stringify(street.sheets)); // waiting for Keep or Discard
});

test('the poller keeps the firmware version from an ok answer only, and readPrinter adds it only when asked', async () => {
  let answer = LITE;
  const fetchImpl = async () => (typeof answer === 'number' ? new Response('{}', { status: answer }) : ok(answer));
  const p = workshop.createPrinterPoller({ url: 'http://10.0.0.124', token: TOKEN, fetchImpl });
  assert.equal(p.firmware(), null);
  await p.poll();
  assert.equal(p.firmware(), '12.1.0');
  assert.equal('firmware' in p.current(), false, 'the Services card and Home answers are unchanged');
  answer = { ...LITE, firmware: { version: '12.1.0; rm -rf' } }; await p.poll();
  assert.equal(p.firmware(), null);
  answer = LITE; await p.poll(); answer = 500; await p.poll();
  assert.equal(p.firmware(), '12.1.0', 'an error answer leaves the last version');
  assert.equal('firmware' in await workshop.readPrinter({ url: 'http://10.0.0.124', token: TOKEN, fetchImpl: async () => ok(LITE) }), false);
});


test('household printer authority wins over a disagreeing display and is never silently replaced', async () => {
  const authority = { setUp: true, access: 'ok', state: 'paused', progress: 32, minutesLeft: 10,
    errorCode: null, source: 'bambuddy', via: 'pi-hub', seenAt: '2026-10-28T12:00:00Z' };
  const w = fakeWorld({ printerRecord: async () => authority });
  assert.deepEqual((await w.world.summary()).printer, authority);
  for (const printerRecord of [async () => null, async () => { throw new Error('down'); }]) {
    const p = (await fakeWorld({ printerRecord }).world.summary()).printer;
    assert.equal(p.state, null); assert.equal(p.progress, null); assert.equal(p.access, 'offline');
    assert.equal(p.via, 'pi-hub');
  }
});
