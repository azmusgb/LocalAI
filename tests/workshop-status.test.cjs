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
const CODE_TOKEN = 'wsc_QRSTUVWXYZ23456789ABCDEFGH'; // synthetic, the code token's format
const CODE = 'QWZ7RT4XKP'; // the portal sign-in code the stand-in display answers

// What GET /api/status/lite answers (docs/status-lite-token-12-1-0.md in the firmware repo), plus fields that must not pass.
const LITE = {
  schema: 1, firmware: { version: '12.1.0', sourceCommit: 'a'.repeat(40) },
  printers: [{ slot: 0, connection: 'online', activity: 'printing', freshness: 'fresh', ageSeconds: 3, progressPercent: 42, remainingMinutes: 70, error: null, name: 'X2D', ip: '10.0.0.50' }]
};

// A stand-in for the display. health: 'ok' answers HEALTH plus fields that must not pass through, 'signin' answers 401
// (firmware 12.0.1 and later), 'hang' never answers. lite: the status-lite answer, or a number to answer that status.
// portalCode: the portal-code answer for CODE_TOKEN, or a number to answer that status (404: firmware without the route).
async function fakeDevice() {
  const device = { seen: [], mode: 'ok', lite: LITE, portalCode: { code: CODE, bootId: 7 } };
  device.server = http.createServer((req, res) => {
    device.seen.push({ method: req.method, url: req.url, headers: req.headers });
    if (device.mode === 'hang') return; // closed by closeAllConnections
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url === '/api/status/lite') {
      if (typeof device.lite === 'number') { res.statusCode = device.lite; return res.end('{}'); }
      if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.statusCode = 401; res.setHeader('WWW-Authenticate', 'Bearer'); return res.end('{"error":"unauthorized"}'); }
      return res.end(JSON.stringify(device.lite));
    }
    if (req.method === 'GET' && req.url === '/api/portal-code') {
      res.setHeader('Cache-Control', 'no-store');
      if (typeof device.portalCode === 'number') { res.statusCode = device.portalCode; return res.end('{}'); }
      if (req.headers.authorization !== `Bearer ${CODE_TOKEN}`) { res.statusCode = 401; res.setHeader('WWW-Authenticate', 'Bearer'); return res.end('{"error":"unauthorized"}'); }
      return res.end(JSON.stringify(device.portalCode));
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
  assert.deepEqual(body, { online: true, board: HEALTH.board, panel: HEALTH.panel, screen: 6, touchscreenConfigured: true, signIn: false, portalUrl: device.url, printer: null, codeAccess: false, camera: { available: false, reason: 'offline', endpoint: '/api/workshop/camera' } });
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

  // No code token: Show sign-in code says it isn't set up, and the display is not asked.
  const unset = await fetch(`${base}/api/workshop/portal-code`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(unset.status, 409);
  assert.equal(unset.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await unset.json(), { reason: 'not_set_up', error: workshop.CODE_WORDS.not_set_up });
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
  assert.deepEqual(down, { online: false, board: null, panel: null, screen: null, touchscreenConfigured: null, signIn: null, portalUrl: device.url, printer: null, codeAccess: false, camera: { available: false, reason: 'offline', endpoint: '/api/workshop/camera' } });
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
  assert.deepEqual(one({ activity: 'error', error: { code: '0700_8010', text: 'Nozzle clog <b>', canceled: false } }), S('error', null, null, '0700_8010'));
  assert.deepEqual(one({ activity: 'paused', progressPercent: 40, error: { code: '0700_8010', text: null, canceled: false } }), S('error', null, null, '0700_8010'));
  assert.deepEqual(one({ activity: 'idle', error: { code: '0300_400C', text: null, canceled: true } }), S('idle'), 'a canceled print is not an error');
  // A print stopped on purpose (Bambu's cancel codes) is cancelled, not an error, whether or not the display flags it.
  assert.deepEqual(one({ activity: 'error', error: { code: '0300-400C', text: null, canceled: false } }), S('cancelled'), 'the live answer after a deliberate stop');
  assert.deepEqual(one({ activity: 'error', error: { code: '0300_400C', text: 'The task was canceled.', canceled: false } }), S('cancelled'));
  assert.deepEqual(one({ activity: 'error', error: { code: '0500_400E', text: null, canceled: false } }), S('cancelled'), "the other cancel code");
  assert.deepEqual(one({ activity: 'error', error: { code: '0300_400D', text: null, canceled: true } }), S('cancelled'), "the display's own cancel flag");
  assert.deepEqual(one({ activity: 'printing', progressPercent: 3, error: { code: '0300-400C', canceled: false } }), S('printing', 3), 'a new print after a stop is printing');
  assert.deepEqual(one({ activity: 'error', error: { code: '0300-4002', text: null, canceled: false } }), S('error', null, null, '0300-4002'), 'a real fault stays an error');
  assert.deepEqual(one({ activity: 'error', error: { code: '0700_8010', text: null, canceled: false } }), S('error', null, null, '0700_8010'));
  assert.deepEqual(one({ activity: 'error', error: null }), S('ended'), 'FAILED without a code may be a stop or a fault: said neutrally, not as a cancel');
  assert.deepEqual(one({ activity: 'error', error: { code: null, text: null, canceled: true } }), S('cancelled'), 'the display flag alone still makes it a stop');
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
  assert.equal(poller.current().state, 'printing', 'one 429 keeps the last answer');
  assert.equal(await poller.poll(), 30000, 'still the normal pace');
  assert.deepEqual(poller.current(), { state: 'unknown', progress: null, minutesLeft: null, errorCode: null, access: 'busy', seenAt: '2026-10-18T12:00:00.000Z' }, 'a second 429 in a row makes it unknown');
  answer = 'ok';
  await poller.poll();
  answer = 429;
  await poller.poll();
  assert.equal(poller.current().state, 'printing', 'a good answer starts the count again');
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

test('printer poller: an answer older than 2 minutes is unknown (stale), whatever the polls did', async () => {
  let clock = Date.parse('2026-10-18T12:00:00Z'), answer = 'ok';
  const fetchImpl = async () => (answer === 429 ? new Response('{}', { status: 429 }) : new Response(JSON.stringify(LITE), { status: 200 }));
  const poller = workshop.createPrinterPoller({ url: 'http://10.0.0.124', token: TOKEN, fetchImpl, now: () => clock });
  await poller.poll();
  assert.equal(poller.current().state, 'printing');
  clock += workshop.STALE_MS;
  assert.equal(poller.current().state, 'printing', 'exactly 2 minutes is still current');
  clock += 1;
  assert.deepEqual(poller.current(), { state: 'unknown', progress: null, minutesLeft: null, errorCode: null, access: 'stale', seenAt: '2026-10-18T12:00:00.000Z' });
  answer = 429;
  await poller.poll();
  assert.equal(poller.current().access, 'stale', 'one 429 does not bring an old answer back');
  answer = 'ok';
  await poller.poll();
  assert.deepEqual([poller.current().state, poller.current().access], ['printing', 'ok'], 'a fresh answer is current again');
  assert.equal(workshop.STALE_MS, 120000);
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
  assert.deepEqual({ ...full.body, printer: { ...full.body.printer, seenAt: null } }, { online: true, board: null, panel: null, screen: null, touchscreenConfigured: null, signIn: true, portalUrl: device.url, printer: { ...printer, seenAt: null }, codeAccess: false, camera: { available: false, reason: 'offline', endpoint: '/api/workshop/camera' } });
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
  assert.match(fs.readFileSync(path.resolve(__dirname, '../deploy/stack/Export-LocalAI-StackEnv.ps1'), 'utf8'), /'LOCALAI_WORKSHOP_STATUS_TOKEN', 'LOCALAI_WORKSHOP_CODE_TOKEN'(, '[A-Z_]+')* \}\)/, 'optional in the export');
  const workshopSrc = fs.readFileSync(path.resolve(__dirname, '../app/workshop.js'), 'utf8');
  assert.doesNotMatch(workshopSrc, /console\.|method: '(POST|PUT|PATCH|DELETE)'|X-BambuHelper-Client/i, 'no logging, only GET, no portal shortcut header');
  for (const f of ['ui.js', 'home.js']) assert.doesNotMatch(fs.readFileSync(path.resolve(__dirname, `../app/public/${f}`), 'utf8'), /status\/lite|STATUS_TOKEN|Bearer/, f);
});

// Pi Hub's key for phone notices (platform step 5, app/hub-notify.js): a TOKEN name, so every secret filter catches it.
test('the Pi Hub token stays out of child processes and the repo, and is optional', () => {
  const server = require('./server-source.cjs').serverSource();
  const secret = new RegExp(/const SECRET_ENV=\/(.+?)\/i;/.exec(server)[1], 'i');
  assert.ok(secret.test('LOCALAI_PI_HUB_TOKEN'), 'childEnv drops it');
  assert.match(fs.readFileSync(path.resolve(__dirname, '../app/model-coordinator.js'), 'utf8'), /const SECRET_ENV = \/TOKEN\|/, 'the coordinator redacts it');
  assert.match(fs.readFileSync(path.resolve(__dirname, '../deploy/stack/compose.yml'), 'utf8'), /LOCALAI_PI_HUB_TOKEN: \$\{LOCALAI_PI_HUB_TOKEN:-\}/);
  assert.match(fs.readFileSync(path.resolve(__dirname, '../deploy/stack/stack.env.example'), 'utf8'), /^LOCALAI_PI_HUB_TOKEN=$/m);
  assert.match(fs.readFileSync(path.resolve(__dirname, '../deploy/stack/Export-LocalAI-StackEnv.ps1'), 'utf8'), /'LOCALAI_PI_HUB_TOKEN' \}\)/, 'optional in the export');
});


test('portal code: reads /api/portal-code with the code token; 401, 404, 429, odd answers and timeouts say so plainly', async t => {
  const device = await fakeDevice();
  t.after(device.close);
  assert.deepEqual(await workshop.readPortalCode({ url: device.url, token: CODE_TOKEN }), { access: 'ok', code: CODE }, 'only the code; bootId is dropped');
  assert.deepEqual(device.seen.map(x => `${x.method} ${x.url}`), ['GET /api/portal-code']);
  assert.equal(device.seen[0].headers.authorization, `Bearer ${CODE_TOKEN}`);
  assert.equal(device.seen[0].headers['x-bambuhelper-client'], undefined, 'never the portal shortcut header');
  assert.deepEqual(await workshop.readPortalCode({ url: device.url, token: TOKEN }), { access: 'refused' }, 'the status token does not open it');
  for (const [code, access] of [[401, 'refused'], [404, 'unsupported'], [429, 'busy'], [500, 'offline'], [302, 'offline']]) {
    device.portalCode = code;
    assert.deepEqual(await workshop.readPortalCode({ url: device.url, token: CODE_TOKEN }), { access }, `HTTP ${code}`);
  }
  for (const odd of [{ code: 'abc' }, { code: '<script>xx' }, { code: 42 }, {}, { code: 'A'.repeat(20000) }]) {
    device.portalCode = odd;
    assert.deepEqual(await workshop.readPortalCode({ url: device.url, token: CODE_TOKEN }), { access: 'offline' }, JSON.stringify(odd).slice(0, 30));
  }
  device.portalCode = { code: ' qwz7rt4xkp ' };
  assert.deepEqual(await workshop.readPortalCode({ url: device.url, token: CODE_TOKEN }), { access: 'ok', code: CODE }, 'case and spaces are tidied');
  device.mode = 'hang';
  const started = Date.now();
  assert.deepEqual(await workshop.readPortalCode({ url: device.url, token: CODE_TOKEN, timeoutMs: 300 }), { access: 'offline' });
  assert.ok(Date.now() - started < 2000, 'gave up at the time limit');
  assert.ok(device.seen.every(x => x.method === 'GET' && x.url === workshop.CODE_PATH));

  let called = false;
  const spy = async () => { called = true; };
  for (const token of [undefined, '', '  ']) assert.deepEqual(await workshop.readPortalCode({ url: device.url, token, fetchImpl: spy }), { access: 'not_set_up' });
  assert.deepEqual(await workshop.readPortalCode({ url: workshop.portalUrl('http://8.8.8.8'), token: CODE_TOKEN, fetchImpl: spy }), { access: 'not_set_up' }, 'never sent off the home network');
  assert.equal(called, false);
  assert.equal(workshop.codeToken(' wsc_x '), 'wsc_x');
  assert.equal(workshop.codeToken(undefined), '');
});

test('portal code gate: one request in flight, at most one every 5 s, a hold of minutes after 401 or 429', async () => {
  let clock = 0, answers = [], reads = 0, release = null;
  const read = () => { reads++; const a = answers.shift() || { access: 'ok', code: 'ABCDEFGHJK' }; return release ? new Promise(r => { const go = release; release = null; go(() => r(a)); }) : Promise.resolve(a); };
  const gate = workshop.createPortalCodeGate({ read, now: () => clock });
  const url = 'http://10.0.0.124';
  // Three callers while the first request is out: one read, one answer for all.
  let open; release = go => { open = go; };
  const three = [gate({ url }), gate({ url }), gate({ url })];
  await new Promise(r => setImmediate(r));
  open();
  assert.deepEqual(await Promise.all(three), [0, 1, 2].map(() => ({ access: 'ok', code: 'ABCDEFGHJK' })));
  assert.equal(reads, 1);
  clock = 4999;
  assert.equal((await gate({ url })).code, 'ABCDEFGHJK');
  assert.equal(reads, 1, 'served from memory inside the 5 s window');
  clock = 5000;
  answers = [{ access: 'offline' }];
  assert.deepEqual(await gate({ url }), { access: 'offline' });
  assert.equal(reads, 2, 'a new request once the window ends');
  clock = 6000;
  assert.deepEqual(await gate({ url }), { access: 'offline' }, 'a failure is not retried inside the window either');
  assert.equal(reads, 2);
  for (const [access, hold] of [['busy', workshop.CODE_BUSY_HOLD_MS], ['refused', workshop.CODE_REFUSED_HOLD_MS]]) {
    clock += 5000;
    answers = [{ access }];
    const before = reads;
    assert.deepEqual(await gate({ url }), { access, retryAfterMs: hold });
    clock += hold - 1;
    assert.deepEqual(await gate({ url }), { access, retryAfterMs: 1 }, `held after ${access}`);
    assert.equal(reads, before + 1);
    clock += 1;
    assert.equal((await gate({ url })).access, 'ok', `asks again when the hold after ${access} ends`);
    assert.equal(reads, before + 2);
  }
  assert.ok(workshop.CODE_BUSY_HOLD_MS >= 60000 && workshop.CODE_REFUSED_HOLD_MS >= 60000, 'holds last minutes');
  assert.equal(workshop.CODE_GAP_MS, 5000);
  const broken = workshop.createPortalCodeGate({ read: () => { throw new Error('boom'); }, now: () => 0 });
  assert.deepEqual(await broken({ url }), { access: 'offline' }, 'never throws');
});

test('POST /api/workshop/portal-code: same-origin only, every answer plainly, no-store, audited without the code; code and token never logged or stored', { timeout: 30000 }, async t => {
  const device = await fakeDevice();
  device.mode = 'signin';
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-workshop-'));
  const off = 'http://127.0.0.1:9';
  // The server's clock, moved by the test (LOCALAI_TEST_NOW_FILE), so the 5 s gap and the holds need no waiting.
  const clockFile = path.join(dataDir, 'test-now'), T0 = Date.parse('2026-10-19T12:00:00Z');
  const at = ms => fs.writeFileSync(clockFile, String(T0 + ms));
  at(0);
  const { child, ready } = spawnAppServer({
    env: { DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, LOCALAI_TEST_NOW_FILE: clockFile, LOCALAI_WORKSHOP_URL: device.url, LOCALAI_WORKSHOP_STATUS_TOKEN: '', LOCALAI_WORKSHOP_CODE_TOKEN: CODE_TOKEN, GRIDCRAFT_URL: off, OLLAMA_URL: off, SEARXNG_URL: off, COMFY_URL: off, N8N_URL: off, PROXY_URL: off, MAC_AI_HOME_URL: off, MAC_DSH_URL: off }
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
  const gets = [];
  const codeAsks = () => device.seen.filter(x => x.url === workshop.CODE_PATH).length;
  const ask = (headers = {}, body = '{}') => fetch(`${base}/api/workshop/portal-code`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, 'Sec-Fetch-Site': 'same-origin', ...headers }, body });

  const status = await fetch(`${base}/api/workshop/status`);
  const statusText = await status.text();
  gets.push(statusText);
  assert.equal(JSON.parse(statusText).codeAccess, true, 'the card offers the button');

  // Same-origin: another site, a sandboxed frame, or a form post without JSON gets nothing, and the display isn't asked.
  for (const [headers, want] of [[{ Origin: 'http://evil.example' }, 403], [{ 'Sec-Fetch-Site': 'cross-site' }, 403], [{ Origin: 'null' }, 403], [{ 'Content-Type': 'text/plain' }, 415]]) {
    const r = await ask(headers);
    assert.equal(r.status, want, JSON.stringify(headers));
    assert.doesNotMatch(await r.text(), new RegExp(CODE));
  }
  assert.equal(codeAsks(), 0, 'refused requests never reach the display');

  // GET never answers the code (an unknown GET is the app page).
  const get = await fetch(`${base}/api/workshop/portal-code`);
  gets.push(await get.text());
  assert.equal(codeAsks(), 0, 'a GET never asks the display');

  const ok = await ask({ Cookie: 'portal_session=abc', Authorization: 'Bearer x' });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await ok.json(), { code: CODE, address: device.url });
  const sent = device.seen.filter(x => x.url === workshop.CODE_PATH);
  assert.equal(sent.length, 1, 'one tap, one request');
  assert.equal(sent[0].method, 'GET');
  assert.equal(sent[0].headers.authorization, `Bearer ${CODE_TOKEN}`, 'the code token, never what the browser sent');
  assert.equal(sent[0].headers.cookie, undefined);

  // Inside 5 s the same code is served again from memory; the display is not asked.
  at(1000);
  const again = await ask();
  assert.equal(again.status, 200);
  assert.equal(again.headers.get('cache-control'), 'no-store');
  assert.equal((await again.json()).code, CODE);
  assert.equal(codeAsks(), 1, 'at most one display request every 5 s');

  // Taps that arrive together share one request.
  at(6000);
  const together = await Promise.all([ask(), ask(), ask()]);
  assert.deepEqual(await Promise.all(together.map(r => r.json())), [0, 1, 2].map(() => ({ code: CODE, address: device.url })));
  assert.equal(codeAsks(), 2, 'one request in flight, its answer shared');
  let shown = 5; // the first, the one from memory and the three together

  let clock = 6000;
  for (const [code, status, reason] of [[404, 502, 'unsupported'], [500, 504, 'offline']]) {
    device.portalCode = code;
    at(clock += 6000);
    const r = await ask();
    assert.equal(r.status, status, `display HTTP ${code}`);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await r.json(), { reason, error: workshop.CODE_WORDS[reason] });
  }
  assert.equal(codeAsks(), 4);

  // A 429 (the display's own limit) or a 401 (the key revoked) holds every request back for minutes.
  for (const [code, status, reason, holdMs] of [[429, 503, 'busy', workshop.CODE_BUSY_HOLD_MS], [401, 502, 'refused', workshop.CODE_REFUSED_HOLD_MS]]) {
    device.portalCode = code;
    at(clock += 6000);
    const before = codeAsks();
    const r = await ask();
    assert.equal(r.status, status, `display HTTP ${code}`);
    assert.equal(r.headers.get('retry-after'), String(holdMs / 1000));
    assert.deepEqual(await r.json(), { reason, error: workshop.CODE_WORDS[reason] });
    device.portalCode = { code: CODE, bootId: 7 };
    at(clock += holdMs - 60000);
    const held = await ask();
    assert.equal(held.status, status, 'still held a minute before the end');
    assert.equal(held.headers.get('retry-after'), '60');
    assert.equal(codeAsks(), before + 1, `nothing sent to the display during the hold after ${code}`);
    at(clock += 60000);
    const after = await ask();
    assert.equal(after.status, 200, `asks again once the hold after ${code} ends`);
    shown++;
    assert.equal(codeAsks(), before + 2);
  }

  at(clock += 6000);
  await device.close();
  const down = await ask();
  assert.equal(down.status, 504);
  assert.equal((await down.json()).reason, 'offline');

  const activity = await (await fetch(`${base}/api/activity`)).text();
  gets.push(activity);
  const listed = JSON.parse(activity);
  const items = Array.isArray(listed) ? listed : listed.items || listed.activity || [];
  assert.equal(items.filter(x => x.title === 'Workshop sign-in code shown').length, shown, 'one audit entry per code shown, none for refusals');
  for (const p of ['/api/workshop/status', '/api/status', '/api/capabilities', '/healthz']) gets.push(await (await fetch(`${base}${p}`)).text());
  for (const text of gets) {
    assert.ok(!text.includes(CODE), 'the code never reaches a GET answer or the audit log');
    assert.ok(!text.includes(CODE_TOKEN.slice(4)), 'the token never reaches an answer');
  }
  const data = fs.readdirSync(dataDir, { recursive: true }).map(f => path.join(dataDir, f)).filter(f => fs.statSync(f).isFile());
  assert.ok(data.length > 0);
  for (const f of data) {
    const bytes = fs.readFileSync(f);
    assert.ok(!bytes.includes(CODE), `the code is not stored (${path.relative(dataDir, f)})`);
    assert.ok(!bytes.includes(CODE_TOKEN.slice(4)), `the token is not stored (${path.relative(dataDir, f)})`);
  }
  assert.ok(!log.includes(CODE), 'the code is never logged');
  assert.ok(!log.includes(CODE_TOKEN.slice(4)), 'the token is never logged');
});

test('the code token stays out of child processes, the repo and the browser; the code stays out of storage and caches', () => {
  const server = require('./server-source.cjs').serverSource();
  const secret = new RegExp(/const SECRET_ENV=\/(.+?)\/i;/.exec(server)[1], 'i');
  assert.ok(secret.test('LOCALAI_WORKSHOP_CODE_TOKEN'), 'childEnv drops it');
  const compose = fs.readFileSync(path.resolve(__dirname, '../deploy/stack/compose.yml'), 'utf8');
  assert.match(compose, /LOCALAI_WORKSHOP_CODE_TOKEN: \$\{LOCALAI_WORKSHOP_CODE_TOKEN:-\}/);
  assert.match(fs.readFileSync(path.resolve(__dirname, '../deploy/stack/stack.env.example'), 'utf8'), /^LOCALAI_WORKSHOP_CODE_TOKEN=$/m);
  assert.match(fs.readFileSync(path.resolve(__dirname, '../deploy/stack/Export-LocalAI-StackEnv.ps1'), 'utf8'), /LOCALAI_WORKSHOP_CODE_TOKEN = \$app\['LOCALAI_WORKSHOP_CODE_TOKEN'\]/);
  const ui = fs.readFileSync(path.resolve(__dirname, '../app/public/ui.js'), 'utf8');
  assert.doesNotMatch(ui, /CODE_TOKEN|wsc_|Bearer/, 'the page never sees the token');
  const from = ui.indexOf('// Workshop display › Show sign-in code');
  const block = ui.slice(from, ui.indexOf("document.addEventListener('visibilitychange'", from));
  assert.ok(block.length > 500);
  assert.doesNotMatch(block, /localStorage|sessionStorage|indexedDB|history\.|location\.|caches\./, 'the code is never stored or put in the address');
  assert.match(block, /fetch\('\/api\/workshop\/portal-code', \{ method: 'POST', cache: 'no-store'/);
  const sw = fs.readFileSync(path.resolve(__dirname, '../app/public/sw.js'), 'utf8');
  assert.match(sw, /if\(req\.method!=='GET'\)return;/, 'the service worker leaves POSTs alone');
  assert.match(sw, /url\.pathname\.startsWith\('\/api\/'\)\)return;/, 'and never caches /api/');
});


test('camera health sources can be isolated from household hardware', async () => {
  assert.deepEqual(await workshop.cameraStatus({ sources: [], fetchImpl: async () => assert.fail('camera probe') }),
    { available: false, source: null, reason: 'offline' });
});

test('status: one log line when the display stops or starts answering, with why it failed', async () => {
  const url = 'http://10.0.0.199';
  const lines = [];
  let now = 1_000_000;
  const ok = async () => new Response(JSON.stringify(HEALTH), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const timeout = async () => { throw Object.assign(new Error('took too long'), { code: 'MODEL_TIMEOUT' }); };
  const look = fetchImpl => workshop.workshopStatus({ url, fetchImpl, log: l => lines.push(l), clock: () => now });
  await look(ok); // the baseline: nothing logged
  await look(ok);
  now += 60_000; await look(timeout);
  now += 60_000; await look(timeout);
  now += 120_000; await look(ok);
  assert.deepEqual(lines, ['Workshop display: not answering (timeout)', 'Workshop display: answering again after 3 min (0 ms)']);
});

test('status: failure reasons name the network error', () => {
  const err = code => Object.assign(new Error('x'), { cause: { code } });
  assert.equal(workshop.failureReason(Object.assign(new Error('x'), { code: 'MODEL_TIMEOUT' })), 'timeout');
  assert.equal(workshop.failureReason(err('ECONNREFUSED')), 'refused');
  assert.equal(workshop.failureReason(err('EHOSTUNREACH')), 'unreachable (EHOSTUNREACH)');
  assert.equal(workshop.failureReason(err('ECONNRESET')), 'reset');
  assert.equal(workshop.failureReason(new SyntaxError('bad')), 'bad answer');
  assert.equal(workshop.failureReason(new Error('odd')), 'failed');
});
