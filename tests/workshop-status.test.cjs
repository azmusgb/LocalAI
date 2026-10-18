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
const FIELDS = ['online', 'board', 'panel', 'screen', 'touchscreenConfigured', 'portalUrl'];

// A stand-in for the display. mode: 'ok' answers HEALTH plus a field that must not pass through; 'hang' never answers.
async function fakeDevice() {
  const device = { seen: [], mode: 'ok' };
  device.server = http.createServer((req, res) => {
    device.seen.push({ method: req.method, url: req.url, headers: req.headers });
    if (device.mode === 'hang') return; // closed by closeAllConnections
    if (req.url !== '/hardware/health') { res.statusCode = 404; return res.end('{}'); }
    res.setHeader('Content-Type', 'application/json');
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
    online: true, board: 'Waveshare_ESP32-S3-Touch-LCD-3.5', panel: 'ST7796_320x480_FT6336', screen: 6, touchscreenConfigured: true, portalUrl: device.url
  });
  assert.deepEqual(Object.keys(status), FIELDS);
  assert.deepEqual(device.seen.map(x => `${x.method} ${x.url}`), ['GET /hardware/health']);
});

test('status: odd values from the display are cleaned, not passed through', async () => {
  const answer = body => async () => new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
  const odd = await workshop.workshopStatus({ url: 'http://10.0.0.124', fetchImpl: answer(JSON.stringify({ board: { html: '<b>' }, panel: 'x'.repeat(500) + '\u0000<', screen: '6', touchscreenConfigured: 'yes' })) });
  assert.deepEqual(odd, { online: true, board: null, panel: 'x'.repeat(80), screen: null, touchscreenConfigured: null, portalUrl: 'http://10.0.0.124' });
  for (const body of ['not json', '[1,2]', 'null', JSON.stringify({ board: 'b'.repeat(20000) })]) {
    const s = await workshop.workshopStatus({ url: 'http://10.0.0.124', fetchImpl: answer(body) });
    assert.equal(s.online, false, body.slice(0, 20));
  }
  const notOk = await workshop.workshopStatus({ url: 'http://10.0.0.124', fetchImpl: async () => new Response(JSON.stringify(HEALTH), { status: 500 }) });
  assert.equal(notOk.online, false);
  let called = false;
  const unset = await workshop.workshopStatus({ url: null, fetchImpl: async () => { called = true; } });
  assert.deepEqual(unset, { online: false, board: null, panel: null, screen: null, touchscreenConfigured: null, portalUrl: null });
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
    env: { DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, LOCALAI_WORKSHOP_URL: device.url, GRIDCRAFT_URL: off, OLLAMA_URL: off, SEARXNG_URL: off, COMFY_URL: off, N8N_URL: off, PROXY_URL: off, MAC_AI_HOME_URL: off, MAC_DSH_URL: off }
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
  assert.deepEqual(body, { online: true, board: HEALTH.board, panel: HEALTH.panel, screen: 6, touchscreenConfigured: true, portalUrl: device.url });
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
  assert.deepEqual(down, { online: false, board: null, panel: null, screen: null, touchscreenConfigured: null, portalUrl: device.url });
});

test('the card links to the display itself and asks only the appliance for status', () => {
  const ui = fs.readFileSync(path.resolve(__dirname, '../app/public/ui.js'), 'utf8');
  assert.ok(ui.includes("fetch('/api/workshop/status'"), 'status comes from the appliance');
  assert.ok(!ui.includes('10.0.0.124'), 'the address comes from the appliance (LOCALAI_WORKSHOP_URL), not the page');
  assert.ok(/target="_blank" rel="noopener noreferrer" data-integration-portal=/.test(ui), 'the portal opens in a new tab with no opener or referrer');
  const compose = fs.readFileSync(path.resolve(__dirname, '../deploy/stack/compose.yml'), 'utf8');
  assert.match(compose, /LOCALAI_WORKSHOP_URL: \$\{LOCALAI_WORKSHOP_URL:-\}/);
});
