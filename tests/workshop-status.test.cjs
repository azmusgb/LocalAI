'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnAppServer } = require('./spawn-server.cjs');
const { once } = require('node:events');
const workshop = require('../app/workshop');

// What the real display answered on GET /hardware/health (firmware of October 2026), extra fields and all.
const HEALTH = {
  board: 'Waveshare_ESP32-S3-Touch-LCD-3.5', panel: 'ST7796_320x480_FT6336', variant: 'ws_lcd_350', width: 480, height: 320,
  rotation: 1, screen: 6, buttonType: 3, touchscreenConfigured: true, pressCount: 0, wifiConnected: true, rssi: -55,
  freeHeap: 188184, minFreeHeap: 163160, psramSize: 8385751, freePsram: 8326979, uptimeMs: 146714, printerConfigured: true,
  printerConnected: true, dualNozzle: true, hasAuxFanRight: true, hasExhaustFan: true, lastUpdateMs: 146014
};
const FIELDS = ['online', 'board', 'panel', 'screen', 'touchscreenConfigured', 'signIn', 'portalUrl'];
const TOKEN = 'wsl_ABCDEFGHJKLMNPQRSTUVWXYZ23'; // synthetic, in the firmware's format

// What GET /api/status/lite answers (docs/status-lite-token-12-1-0.md in the firmware repo), plus fields that must not pass.
const LITE = {
  schema: 1, firmware: { version: '12.1.0', sourceCommit: 'a'.repeat(40) },
  printers: [{ slot: 0, connection: 'online', activity: 'printing', freshness: 'fresh', ageSeconds: 3, progressPercent: 42, remainingMinutes: 70, error: null, name: 'X2D', ip: '10.0.0.50' }]
};

// A stand-in for the display. health: 'ok' answers HEALTH plus fields that must not pass through, 'signin' answers 401
// (firmware 12.0.1 and later), 'hang' never answers. lite: the status-lite answer, or a number to answer that status.
async function fakeDevice() {
  const device = { seen: [], mode: 'ok', lite: LITE };
  device.server = http.createServer((req, res) => {
    device.seen.push({ method: req.method, url: req.url, headers: req.headers });
    if (device.mode === 'hang') return; // closed by closeAllConnections
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url === '/api/status/lite') {
      if (typeof device.lite === 'number') { res.statusCode = device.lite; return res.end('{}'); }
      if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.statusCode = 401; res.setHeader('WWW-Authenticate', 'Bearer'); return res.end('{"error":"unauthorized"}'); }
      return res.end(JSON.stringify(device.lite));
    }
    if (req.url !== '/hardware/health') { res.statusCode = 404; return res.end('{}'); }
    if (device.mode === 'signin') { res.statusCode = 401; return res.end('{"error":"sign in"}'); }
    res.end(JSON.stringify({ ...HEALTH, accessCode: '123456', sessionToken: 'secret' }));
  });
  device.server.listen(0, '127.0.0.1');
  await once(device.server, 'listening');
  device.url = `http://127.0.0.1:${device.server.address().port}`;
  device.close = () => { device.server.closeAllConnections(); return new Promise(r => device.server.close(r)); };
  return device;
}

test('LOCALAI_WORKSHOP_URL: an http(s) address on the home network, else not set up', () => {
  assert.equal(workshop.portalUrl(undefined), 'http://10.0.0.124', 'unset uses the default');
  assert.equal(workshop.portalUrl(''), 'http://10.0.0.124', 'empty (compose passes ${LOCALAI_WORKSHOP_URL:-}) uses the default');
  for (const [raw, want] of [
    ['http://10.0.0.124', 'http://10.0.0.124'], ['http://10.0.0.124/', 'http://10.0.0.124'], ['  https://192.168.1.50:8443 ', 'https://192.168.1.50:8443'],
    ['http://172.20.0.9', 'http://172.20.0.9'], ['http://bambuhelper.local', 'http://bambuhelper.local'], ['http://BambuHelper.LOCAL', 'http://bambuhelper.local'],
    ['http://127.0.0.1:9', 'http://127.0.0.1:9']
  ]) assert.equal(workshop.portalUrl(raw), want, raw);
  for (const raw of [
    'http://8.8.8.8', 'http://example.com', 'https://bambuhelper.local.example.com', 'http://172.32.0.1', 'http://100.100.1.1',
    'ftp://10.0.0.124', 'javascript:alert(1)', 'file:///etc/passwd', 'http://user:pw@10.0.0.124', 'http://10.0.0.124/hardware/health',
    'http://10.0.0.124/?x=1', 'http://10.0.0.124/#x', 'http://[::1]', 'http://localhost', 'not a url', 'http://.local'
  ]) assert.equal(workshop.portalUrl(raw), null, raw);
});

test('status: online keeps only the card fields; extra fields from the display are dropped', async t => {
  const device = await fakeDevice();
  t.after(device.close);
  const status = await workshop.workshopStatus({ url: device.url });
  assert.deepEqual(status, {
    online: true, board: 'Waveshare_ESP32-S3-Touch-LCD-3.5', panel: 'ST7796_320x480_FT6336', screen: 6, touchscreenConfigured: true, signIn: false, portalUrl: device.url
  });
  assert.deepEqual(Object.keys(status), FIELDS);
  assert.deepEqual(device.seen.map(x => `${x.method} ${x.url}`), ['GET /hardware/health']);
});

test('status: odd values from the display are cleaned, not passed through', async () => {
  const answer = body => async () => new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
  const odd = await workshop.workshopStatus({ url: 'http://10.0.0.124', fetchImpl: answer(JSON.stringify({ board: { html: '<b>' }, panel: 'x'.repeat(500) + '\u0000<', screen: '6', touchscreenConfigured: 'yes' })) });
  assert.deepEqual(odd, { online: true, board: null, panel: 'x'.repeat(80), screen: null, touchscreenConfigured: null, signIn: false, portalUrl: 'http://10.0.0.124' });
  for (const body of ['not json', '[1,2]', 'null', JSON.stringify({ board: 'b'.repeat(20000) })]) {
    const s = await workshop.workshopStatus({ url: 'http://10.0.0.124', fetchImpl: answer(body) });
    assert.equal(s.online, false, body.slice(0, 20));
  }
  const notOk = await workshop.workshopStatus({ url: 'http://10.0.0.124', fetchImpl: async () => new Response(JSON.stringify(HEALTH), { status: 500 }) });
  assert.equal(notOk.online, false);
  let called = false;
  const unset = await workshop.workshopStatus({ url: null, fetchImpl: async () => { called = true; } });
  assert.deepEqual(unset, { online: false, board: null, panel: null, screen: null, touchscreenConfigured: null, signIn: null, portalUrl: null });
  assert.equal(called, false, 'an address that is not on the home network is never fetched');
});

test('status: a display that never answers is offline after the time limit', async t => {
  const device = await fakeDevice();
  device.mode = 'hang';
  t.after(device.close);
  const started = Date.now();
  const status = await workshop.workshopStatus({ url: device.url, timeoutMs: 300 });
  assert.equal(status.online, false);
  assert.ok(Date.now() - started < 2000, 'gave up at the time limit');
  assert.equal(workshop.TIMEOUT_MS, 4000);
});

test('GET /api/workshop/status through the appliance: online, extra fields dropped, timeout, offline; nothing else is routed', { timeout: 30000 }, async t => {
  const device = await fakeDevice();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-workshop-'));
  const off = 'http://127.0.0.1:9';
  const { child, ready } = spawnAppServer({
    env: { DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, LOCALAI_WORKSHOP_URL: device.url, LOCALAI_WORKSHOP_STATUS_TOKEN: '', GRIDCRAFT_URL: off, OLLAMA_URL: off, SEARXNG_URL: off, COMFY_URL: off, N8N_URL: off, PROXY_URL: off, MAC_AI_HOME_URL: off, MAC_DSH_URL: off }
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
    await device.close().catch(() => {});
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = await ready;

  const online = await fetch(`${base}/api/workshop/status`, { headers: { Cookie: 'portal_session=abc', Authorization: 'Bearer x' } });
  assert.equal(online.status, 200);
  const body = await online.json();
  assert.deepEqual(body, { online: true, board: HEALTH.board, panel: HEALTH.panel, screen: 6, touchscreenConfigured: true, signIn: false, portalUrl: device.url, printer: null });
  assert.deepEqual(device.seen.map(x => `${x.method} ${x.url}`), ['GET /hardware/health']);
  assert.equal(device.seen[0].headers.cookie, undefined, 'nothing from the request reaches the display');
  assert.equal(device.seen[0].headers.authorization, undefined);

  // Only the one read-only route: nothing under /api/workshop/ reaches the display.
  for (const [method, p] of [['POST', '/api/workshop/status'], ['GET', '/api/workshop/hardware/health'], ['GET', '/api/workshop/'], ['POST', '/api/workshop/control']]) {
    const r = await fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
    if (method === 'POST') assert.notEqual(r.status, 200, `${method} ${p}`);
    assert.doesNotMatch(await r.text(), /Waveshare|ST7796/, `${method} ${p}`); // an unknown GET gets the app page, never the display's answer
  }
  assert.equal(device.seen.length, 1);

  device.mode = 'hang';
  const started = Date.now();
  const slow = await fetch(`${base}/api/workshop/status`);
  assert.equal(slow.status, 200);
  assert.equal((await slow.json()).online, false);
  const took = Date.now() - started;
  assert.ok(took >= 3500 && took < 8000, `gave up at about 4 s (took ${took} ms)`);

  await device.close();
  const down = await (await fetch(`${base}/api/workshop/status`)).json();
  assert.deepEqual(down, { online: false, board: null, panel: null, screen: null, touchscreenConfigured: null, signIn: null, portalUrl: device.url, printer: null });
});

test('the card links to the display itself and asks only the appliance for status', () => {
  const ui = fs.readFileSync(path.resolve(__dirname, '../app/public/ui.js'), 'utf8');
  assert.ok(ui.includes("fetch('/api/workshop/status'"), 'status comes from the appliance');
  assert.ok(!ui.includes('10.0.0.124'), 'the address comes from the appliance (LOCALAI_WORKSHOP_URL), not the page');
  assert.ok(/target="_blank" rel="noopener noreferrer" data-integration-portal=/.test(ui), 'the portal opens in a new tab with no opener or referrer');
  const compose = fs.readFileSync(path.resolve(__dirname, '../deploy/stack/compose.yml'), 'utf8');
  assert.match(compose, /LOCALAI_WORKSHOP_URL: \$\{LOCALAI_WORKSHOP_URL:-\}/);
});

test('status: a 401 from the health route means up with its own sign-in, not offline', async t => {
  const device = await fakeDevice();
  device.mode = 'signin';
  t.after(device.close);
  const status = await workshop.workshopStatus({ url: device.url });
  assert.deepEqual(status, { online: true, board: null, panel: null, screen: null, touchscreenConfigured: null, signIn: true, portalUrl: device.url });
  for (const code of [403, 500, 302]) {
    const s = await workshop.workshopStatus({ url: device.url, fetchImpl: async () => new Response('{}', { status: code }) });
    assert.deepEqual([s.online, s.signIn], [false, null], `HTTP ${code} is not a sign-in`);
  }
  const refused = await workshop.workshopStatus({ url: 'http://127.0.0.1:9' });
  assert.deepEqual([refused.online, refused.signIn], [false, null], 'nothing listening is offline');
});

test('printer summary: only the allowed words, and nothing stale shown as current', () => {
  const one = p => workshop.printerSummary({ printers: [{ slot: 0, connection: 'online', freshness: 'fresh', ageSeconds: 1, error: null, ...p }] });
  const S = (state, progress = null, minutesLeft = null, errorCode = null) => ({ state, progress, minutesLeft, errorCode });
  assert.deepEqual(one({ activity: 'printing', progressPercent: 42, remainingMinutes: 70 }), S('printing', 42, 70));
  assert.deepEqual(one({ activity: 'preparing', progressPercent: null, remainingMinutes: null }), S('printing'));
  assert.deepEqual(one({ activity: 'paused', progressPercent: 42, remainingMinutes: 70 }), S('paused', 42, 70));
  assert.deepEqual(one({ activity: 'idle', progressPercent: 42 }), S('idle'), 'idle has no progress');
  assert.deepEqual(one({ activity: 'finished', progressPercent: 100 }), S('idle'));
  assert.deepEqual(one({ activity: 'error', error: { code: '0300_400C', text: 'Nozzle clog <b>', canceled: false } }), S('error', null, null, '0300_400C'));
  assert.deepEqual(one({ activity: 'paused', progressPercent: 40, error: { code: '0300_400C', text: null, canceled: false } }), S('error', null, null, '0300_400C'));
  assert.deepEqual(one({ activity: 'idle', error: { code: '0300_400C', text: null, canceled: true } }), S('idle'), 'a canceled print is not an error');
  assert.deepEqual(one({ activity: 'error', error: { code: '<script>', canceled: false } }), S('error'), 'an odd code is dropped');
  assert.deepEqual(one({ activity: 'printing', progressPercent: 420, remainingMinutes: -3 }), S('printing'), 'out-of-range numbers are dropped');
  assert.deepEqual(one({ activity: 'printing', progressPercent: '42' }), S('printing'));
  assert.deepEqual(one({ activity: 'launching' }), S('unknown'));
  assert.deepEqual(one({ activity: 'printing', progressPercent: 42, freshness: 'stale' }), S('unknown'));
  assert.deepEqual(one({ activity: 'printing', progressPercent: 42, connection: 'offline' }), S('unknown'));
  for (const d of [null, {}, { printers: [] }, { printers: 'x' }, { printers: [null, 3] }]) assert.deepEqual(workshop.printerSummary(d), S('unknown'));
});

test('printer: reads /api/status/lite with the Bearer token; 401, 404, 429, odd answers and timeouts say so plainly', async t => {
  const device = await fakeDevice();
  t.after(device.close);
  const ok = await workshop.readPrinter({ url: device.url, token: TOKEN });
  assert.deepEqual(ok, { state: 'printing', progress: 42, minutesLeft: 70, errorCode: null, access: 'ok' });
  assert.deepEqual(device.seen.map(x => `${x.method} ${x.url}`), ['GET /api/status/lite']);
  assert.equal(device.seen[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(device.seen[0].headers['x-bambuhelper-client'], undefined, 'never the portal shortcut header');
  assert.equal((await workshop.readPrinter({ url: device.url, token: 'wsl_WRONG' })).access, 'refused');
  for (const [code, access] of [[404, 'unsupported'], [429, 'busy'], [500, 'offline'], [302, 'offline']]) {
    device.lite = code;
    const r = await workshop.readPrinter({ url: device.url, token: TOKEN });
    assert.deepEqual(r, { state: 'unknown', progress: null, minutesLeft: null, errorCode: null, access }, `HTTP ${code}`);
  }
  device.lite = { printers: [{ ...LITE.printers[0], pad: 'x'.repeat(20000) }] };
  assert.equal((await workshop.readPrinter({ url: device.url, token: TOKEN })).access, 'offline', 'an oversized answer is refused');
  device.mode = 'hang';
  const started = Date.now();
  assert.equal((await workshop.readPrinter({ url: device.url, token: TOKEN, timeoutMs: 300 })).access, 'offline');
  assert.ok(Date.now() - started < 2000, 'gave up at the time limit');
  assert.ok(device.seen.every(x => x.method === 'GET' && [workshop.HEALTH_PATH, workshop.LITE_PATH].includes(x.url)), 'only the two GET routes');
});

test('printer poller: 30 s while answering, backs off to 5 min while not, keeps a 429 at the normal pace; no token, no requests', async () => {
  let answer = 'ok';
  const calls = [];
  const fetchImpl = async (url, opts, timeoutMs) => {
    calls.push({ url, method: opts.method, timeoutMs });
    if (answer === 'down') throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.124:80'), { code: 'ECONNREFUSED' });
    if (answer === 429) return new Response('{}', { status: 429 });
    return new Response(JSON.stringify(LITE), { status: 200 });
  };
  const poller = workshop.createPrinterPoller({ url: 'http://10.0.0.124', token: TOKEN, fetchImpl, now: () => Date.parse('2026-10-18T12:00:00Z') });
  assert.equal(poller.enabled, true);
  assert.deepEqual(poller.current(), { state: 'unknown', progress: null, minutesLeft: null, errorCode: null, access: 'offline', seenAt: null }, 'nothing known before the first read');
  assert.equal(await poller.poll(), 30000);
  assert.deepEqual(poller.current(), { state: 'printing', progress: 42, minutesLeft: 70, errorCode: null, access: 'ok', seenAt: '2026-10-18T12:00:00.000Z' });
  answer = 429;
  assert.equal(await poller.poll(), 30000);
  assert.equal(poller.current().state, 'printing', 'a 429 keeps the last answer');
  answer = 'down';
  const waits = [];
  for (let i = 0; i < 6; i++) waits.push(await poller.poll());
  assert.deepEqual(waits, [60000, 120000, 240000, 300000, 300000, 300000]);
  assert.deepEqual(poller.current(), { state: 'unknown', progress: null, minutesLeft: null, errorCode: null, access: 'offline', seenAt: '2026-10-18T12:00:00.000Z' }, 'the last progress is not shown as current');
  answer = 'ok';
  assert.equal(await poller.poll(), 30000, 'back to 30 s once it answers');
  assert.ok(calls.every(c => c.method === 'GET' && c.url === 'http://10.0.0.124/api/status/lite' && c.timeoutMs === 4000));
  assert.equal(workshop.POLL_MS, 30000);

  for (const token of [undefined, '', '   ']) {
    let called = false;
    const off = workshop.createPrinterPoller({ url: 'http://10.0.0.124', token, fetchImpl: async () => { called = true; } });
    assert.equal(off.enabled, false);
    assert.equal(off.current(), null);
    off.start();
    assert.equal(await off.poll(), null);
    off.stop();
    assert.equal(called, false, 'no token, no requests');
  }
  const offsite = workshop.createPrinterPoller({ url: workshop.portalUrl('http://8.8.8.8'), token: TOKEN });
  assert.equal(offsite.enabled, false, 'never sends the token to an address off the home network');
});

test('GET /api/workshop/status with a token: printer summary, sign-in from the token, Home part from cache, token never leaves the server', { timeout: 30000 }, async t => {
  const device = await fakeDevice();
  device.mode = 'signin';
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-workshop-'));
  const off = 'http://127.0.0.1:9';
  const { child, ready } = spawnAppServer({
    env: { DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, LOCALAI_WORKSHOP_URL: device.url, LOCALAI_WORKSHOP_STATUS_TOKEN: TOKEN, GRIDCRAFT_URL: off, OLLAMA_URL: off, SEARXNG_URL: off, COMFY_URL: off, N8N_URL: off, PROXY_URL: off, MAC_AI_HOME_URL: off, MAC_DSH_URL: off }
  });
  let log = '';
  child.stdout.on('data', b => { log += b; });
  child.stderr.on('data', b => { log += b; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
    await device.close().catch(() => {});
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = await ready;
  const answers = [];
  const get = async p => { const r = await fetch(`${base}${p}`); const text = await r.text(); answers.push(text); return { status: r.status, body: JSON.parse(text) }; };

  // The poller reads once at start.
  for (let i = 0; i < 50 && !device.seen.some(x => x.url === '/api/status/lite'); i++) await new Promise(r => setTimeout(r, 100));
  const printer = { state: 'printing', progress: 42, minutesLeft: 70, errorCode: null, access: 'ok' };
  const full = await get('/api/workshop/status');
  assert.equal(full.status, 200);
  assert.deepEqual({ ...full.body, printer: { ...full.body.printer, seenAt: null } }, { online: true, board: null, panel: null, screen: null, touchscreenConfigured: null, signIn: true, portalUrl: device.url, printer: { ...printer, seenAt: null } });
  assert.match(full.body.printer.seenAt, /^\d{4}-\d\d-\d\dT/);

  const before = device.seen.length;
  const part = await get('/api/workshop/status?part=printer');
  assert.deepEqual(Object.keys(part.body), ['printer']);
  assert.equal(part.body.printer.state, 'printing');
  assert.equal(device.seen.length, before, "Home's part answers from the last read and sends the display nothing");

  // A display on the old firmware: health answers without a sign-in, and the token route is not there (404).
  device.mode = 'ok';
  device.lite = 404;
  const health = await get('/api/workshop/status');
  assert.equal(health.body.signIn, true, 'the poller has not read again yet: the token still worked moments ago');

  // Every request the display saw was a GET to one of the two routes, the token only on the lite route.
  assert.ok(device.seen.length >= 3);
  for (const x of device.seen) {
    assert.equal(x.method, 'GET');
    assert.ok([workshop.HEALTH_PATH, workshop.LITE_PATH].includes(x.url), x.url);
    assert.equal(x.headers['x-bambuhelper-client'], undefined);
    assert.equal(x.headers.authorization, x.url === workshop.LITE_PATH ? `Bearer ${TOKEN}` : undefined);
  }
  for (const p of ['/api/status', '/api/capabilities', '/api/activity', '/healthz']) answers.push(await (await fetch(`${base}${p}`)).text());
  for (const text of answers) assert.ok(!text.includes(TOKEN) && !text.includes(TOKEN.slice(4)), 'the token never reaches an answer');
  const data = fs.readdirSync(dataDir, { recursive: true }).map(f => path.join(dataDir, f)).filter(f => fs.statSync(f).isFile());
  for (const f of data) assert.ok(!fs.readFileSync(f).includes(TOKEN.slice(4)), `the token is not stored (${path.relative(dataDir, f)})`);
  assert.ok(!log.includes(TOKEN.slice(4)), 'the token is never logged');
});

test('the token stays out of child processes, the repo and the browser', () => {
  const server = require('./server-source.cjs').serverSource(); // server.js and app/server/*.js
  const secret = new RegExp(/const SECRET_ENV=\/(.+?)\/i;/.exec(server)[1], 'i');
  assert.ok(secret.test('LOCALAI_WORKSHOP_STATUS_TOKEN'), 'childEnv drops it');
  const compose = fs.readFileSync(path.resolve(__dirname, '../deploy/stack/compose.yml'), 'utf8');
  assert.match(compose, /LOCALAI_WORKSHOP_STATUS_TOKEN: \$\{LOCALAI_WORKSHOP_STATUS_TOKEN:-\}/);
  assert.match(fs.readFileSync(path.resolve(__dirname, '../deploy/stack/stack.env.example'), 'utf8'), /^LOCALAI_WORKSHOP_STATUS_TOKEN=$/m);
  assert.match(fs.readFileSync(path.resolve(__dirname, '../deploy/stack/Export-LocalAI-StackEnv.ps1'), 'utf8'), /'LOCALAI_WORKSHOP_STATUS_TOKEN' \}\)/, 'optional in the export');
  const workshopSrc = fs.readFileSync(path.resolve(__dirname, '../app/workshop.js'), 'utf8');
  assert.doesNotMatch(workshopSrc, /console\.|method: '(POST|PUT|PATCH|DELETE)'|X-BambuHelper-Client/i, 'no logging, only GET, no portal shortcut header');
  for (const f of ['ui.js', 'home.js']) assert.doesNotMatch(fs.readFileSync(path.resolve(__dirname, `../app/public/${f}`), 'utf8'), /status\/lite|STATUS_TOKEN|Bearer/, f);
});
