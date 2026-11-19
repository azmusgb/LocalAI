'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawnAppServer } = require('./spawn-server.cjs');
const { kindOf } = require('../app/signin');

// Sign-in, report-only (app/signin.js): API requests through Caddy without a paired device or the Mac key are counted by
// caller and listed, never refused; the host itself, the routes pairing needs and pages are not counted.
const KEY = 'k'.repeat(64);
const JSONH = { 'Content-Type': 'application/json' };
const viaCaddy = (ip, ua, extra = {}) => ({ 'X-Forwarded-For': ip, 'X-Forwarded-Proto': 'https', 'User-Agent': ua, ...extra });
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1';

async function start(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-signin-'));
  fs.writeFileSync(path.join(dataDir, 'claude-chat-mac-key.sha256'), crypto.createHash('sha256').update(KEY).digest('hex'));
  const off = 'http://127.0.0.1:9';
  const { child, ready } = spawnAppServer({ env: { DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, OLLAMA_URL: off, SEARXNG_URL: off, COMFY_URL: off, N8N_URL: off, PROXY_URL: off, MAC_AI_HOME_URL: off, MAC_DSH_URL: off, GRIDCRAFT_URL: off } });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return ready;
}
async function pair(base) {
  const pr = await (await fetch(`${base}/api/claude/chat/pair-request`, { method: 'POST', headers: JSONH, body: '{}' })).json();
  await fetch(`${base}/api/claude/chat/pair/approve`, { method: 'POST', headers: { ...JSONH, 'X-LocalAI-Mac-Key': KEY }, body: JSON.stringify({ code: pr.code, name: 'Phone' }) });
  const sr = await fetch(`${base}/api/claude/chat/pair-status?id=${pr.id}`, { headers: { 'X-Forwarded-Proto': 'https' } });
  return sr.headers.get('set-cookie').split(';')[0];
}

test('requests without a device are counted by caller, never refused; the host, the Mac and paired devices are not', { timeout: 30000 }, async t => {
  const base = await start(t);
  const cookie = await pair(base);
  const r1 = await fetch(`${base}/api/runs?limit=1`, { headers: viaCaddy('10.0.0.37', IPHONE) });
  assert.equal(r1.status, 200, 'report only: nothing is refused');
  await fetch(`${base}/api/status`, { headers: viaCaddy('10.0.0.37', IPHONE) });
  await fetch(`${base}/api/glance`, { headers: viaCaddy('100.64.1.2', 'Shortcuts/2610 CFNetwork/3826 Darwin/24.0.0') });
  // Not counted: a paired device, the Mac key, the host's own port (no X-Forwarded-For), pairing routes, pages.
  await fetch(`${base}/api/runs?limit=1`, { headers: viaCaddy('10.0.0.40', IPHONE, { Cookie: cookie }) });
  await fetch(`${base}/api/claude/priorities`, { headers: viaCaddy('10.0.0.5', 'python-urllib/3.14', { 'X-LocalAI-Mac-Key': KEY }) });
  await fetch(`${base}/api/runs?limit=1`);
  await fetch(`${base}/api/claude/chat/whoami`, { headers: viaCaddy('10.0.0.41', IPHONE) });
  await fetch(`${base}/`, { headers: viaCaddy('10.0.0.42', IPHONE) });
  await fetch(`${base}/healthz`, { headers: viaCaddy('10.0.0.43', 'curl/8') });

  const report = await (await fetch(`${base}/api/signin/report`)).json();
  assert.equal(report.mode, 'report');
  assert.deepEqual(report.callers.map(c => [c.ip, c.kind, c.count, c.lastMethod, c.lastPath]).sort(), [
    ['10.0.0.37', 'iPhone', 2, 'GET', '/api/status'],
    ['100.64.1.2', 'Shortcuts', 1, 'GET', '/api/glance'],
  ]);
  assert.equal(JSON.stringify(report).includes('limit=1'), false, 'paths only, never query strings');

  assert.equal((await fetch(`${base}/api/signin/report/clear`, { method: 'POST', headers: JSONH, body: '{}' })).status, 200);
  assert.deepEqual((await (await fetch(`${base}/api/signin/report`)).json()).callers, []);
});

test('routes that run code, write files or approve changes refuse a caller without a device', { timeout: 30000 }, async t => {
  const base = await start(t);
  const cookie = await pair(base);
  const post = (route, headers, body = {}) => fetch(`${base}${route}`, { method: 'POST', headers: { ...JSONH, ...headers }, body: JSON.stringify(body) });
  const lan = viaCaddy('10.0.0.37', IPHONE);
  for (const [method, route] of [['POST', '/api/workbench/command'], ['POST', '/api/workbench/write'], ['GET', '/api/workbench/tree'],
    ['POST', '/api/computer/batch'], ['POST', '/api/browser/fetch'], ['POST', '/api/actions/http-check'], ['POST', '/api/engineering/run'],
    ['POST', '/api/agents/missions/start'], ['POST', '/api/gridcraft/upload'], ['POST', '/api/display/notify'], ['POST', '/api/notifications/update'], ['GET', '/api/changes'], ['POST', '/api/changes/approve'],
    ['POST', '/api/approvals/decide'], ['POST', '/api/notifications/system'], ['POST', '/api/signin/report/clear']]) {
    const r = method === 'GET' ? await fetch(`${base}${route}`, { headers: lan }) : await post(route, lan);
    assert.equal(r.status, 401, `${method} ${route} without a device`);
    assert.deepEqual(await r.json(), { error: 'Sign in on this device first: pair it under Improve › Claude Code.', signIn: true });
  }
  // The same request is let through for a paired device, the Mac key and the host itself; other routes stay report-only.
  assert.notEqual((await fetch(`${base}/api/workbench/tree`, { headers: viaCaddy('10.0.0.40', IPHONE, { Cookie: cookie }) })).status, 401);
  assert.notEqual((await fetch(`${base}/api/changes`, { headers: viaCaddy('10.0.0.5', 'python-urllib/3.14', { 'X-LocalAI-Mac-Key': KEY }) })).status, 401);
  assert.notEqual((await fetch(`${base}/api/changes`)).status, 401);
  assert.equal((await fetch(`${base}/api/runs?limit=1`, { headers: lan })).status, 200);
  const report = await (await fetch(`${base}/api/signin/report`)).json();
  assert.equal(report.mode, 'report');
  assert.ok(report.guarded.some(g => g.includes('workbench')));
  assert.ok(report.callers.some(c => c.ip === '10.0.0.37' && c.count >= 17), 'refused requests are still listed');
});

test('whoami renews a paired device cookie for all of Local AI; an unpaired one gets nothing', { timeout: 30000 }, async t => {
  const base = await start(t);
  const cookie = await pair(base);
  const r = await fetch(`${base}/api/claude/chat/whoami`, { headers: { Cookie: cookie, 'X-Forwarded-Proto': 'https' } });
  assert.deepEqual(await r.json(), { paired: true });
  assert.equal(r.headers.get('set-cookie'), `${cookie}; HttpOnly; SameSite=Lax; Path=/; Max-Age=15552000; Secure`);
  const none = await fetch(`${base}/api/claude/chat/whoami`, { headers: { Cookie: 'localai_chat_device=dev-000000000000.nope' } });
  assert.deepEqual(await none.json(), { paired: false });
  assert.equal(none.headers.get('set-cookie'), null);
});

test('callers are named by what they run on', () => {
  assert.equal(kindOf(IPHONE), 'iPhone');
  assert.equal(kindOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15'), 'Mac');
  assert.equal(kindOf('Shortcuts/2610 CFNetwork/3826 Darwin/24.0.0'), 'Shortcuts');
  assert.equal(kindOf('curl/8.7.1'), 'Script');
  assert.equal(kindOf(''), 'No browser');
});

test('the Workshop display key signs in the display feed, ask and image routes only', { timeout: 30000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-signin-display-'));
  const DKEY = 'wsd_' + 'a'.repeat(48);
  fs.writeFileSync(path.join(dataDir, 'workshop-display-key.sha256'), crypto.createHash('sha256').update(DKEY).digest('hex'));
  const off = 'http://127.0.0.1:9';
  const { child, ready } = spawnAppServer({ env: { DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, OLLAMA_URL: off, SEARXNG_URL: off, COMFY_URL: off, N8N_URL: off, PROXY_URL: off, MAC_AI_HOME_URL: off, MAC_DSH_URL: off, GRIDCRAFT_URL: off } });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = await ready;
  const display = (extra = {}) => viaCaddy('10.0.0.28', 'ESP32HTTPClient', extra);
  assert.equal((await fetch(`${base}/api/display/feed`, { headers: display({ 'X-LocalAI-Display-Key': DKEY }) })).status, 200);
  // The same key on another route is not signed in, and a wrong key on the feed isn't either.
  assert.equal((await fetch(`${base}/api/display/ask?q=health`, { headers: display({ 'X-LocalAI-Display-Key': DKEY }) })).status, 200);
  await fetch(`${base}/api/runs?limit=1`, { headers: display({ 'X-LocalAI-Display-Key': DKEY }) });
  await fetch(`${base}/api/display/feed`, { headers: display({ 'X-LocalAI-Display-Key': 'wsd_wrong' }) });
  const report = await (await fetch(`${base}/api/signin/report`)).json();
  assert.deepEqual(report.callers.map(c => [c.kind, c.count]), [['Workshop display', 2]]);
  assert.deepEqual(report.callers[0].lastPath, '/api/display/feed');
});

test('LOCALAI_SIGN_IN=required refuses every API route that is not open; report mode only the guarded ones', () => {
  const { createSignIn } = require('../app/signin');
  const storage = { readSetting: () => null, writeSetting: () => {} };
  const req = p => ({ headers: { 'x-forwarded-for': '10.0.0.37', 'user-agent': IPHONE }, method: 'GET', url: p });
  for (const [required, route, blocked] of [[false, '/api/runs', false], [false, '/api/workbench/tree', true], [true, '/api/runs', true],
    [true, '/healthz', false], [true, '/api/claude/chat/pair-request', false], [true, '/', false]]) {
    const s = createSignIn({ storage, signedIn: () => false, required });
    assert.equal(s.blocks(s.check(req(route), route), route, 'GET'), blocked, `${required ? 'required' : 'report'} ${route}`);
  }
  // Write-only guards: reading GridCraft workbooks or the display's alert settings stays report-only; changing them doesn't.
  const s0 = createSignIn({ storage, signedIn: () => false, required: false });
  for (const [method, route, blocked] of [['GET', '/api/display/alerts', false], ['POST', '/api/display/alerts', true],
    ['GET', '/api/gridcraft/workbooks', false], ['POST', '/api/gridcraft/cell', true], ['POST', '/api/agents/run', true]]) {
    assert.equal(s0.blocks(s0.check(req(route), route), route, method), blocked, `${method} ${route}`);
  }
  const s = createSignIn({ storage, signedIn: () => true, required: true });
  assert.equal(s.blocks(s.check(req('/api/workbench/tree'), '/api/workbench/tree'), '/api/workbench/tree', 'GET'), false);
});

test('only loopback and the network gateway count as the host; other containers must sign in', () => {
  const { createSignIn, defaultGateway } = require('../app/signin');
  const storage = { readSetting: () => null, writeSetting: () => {} };
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const routeFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'route-')), 'route');
  fs.writeFileSync(routeFile, 'Iface\tDestination\tGateway \tFlags\neth0\t00000000\t010014AC\t0003\neth0\t000014AC\t00000000\t0001\n');
  assert.equal(defaultGateway(routeFile), '172.20.0.1');
  const s = createSignIn({ storage, signedIn: () => false, hosts: new Set(['127.0.0.1', '::1', '172.20.0.1']) });
  const from = (addr, xff) => ({ headers: xff ? { 'x-forwarded-for': xff } : {}, socket: { remoteAddress: addr }, method: 'POST' });
  const route = '/api/workbench/command';
  assert.equal(s.check(from('172.20.0.1'), route), 'host', 'the Windows host through the published port');
  assert.equal(s.check(from('::ffff:127.0.0.1'), route), 'host', 'loopback');
  assert.equal(s.check(from('172.20.0.6'), route), 'refused', 'n8n on the same network');
  assert.equal(s.blocks(s.check(from('172.20.0.6'), route), route, 'POST'), true);
  assert.equal(s.check(from('172.20.0.1', '10.0.0.37'), route), 'refused', 'through Caddy is never the host');
});

test('sibling routes are guarded too: the display sign-in code, run control, deletes, memory and models', () => {
  const { guarded } = require('../app/signin');
  for (const p of ['/api/workshop/portal-code']) assert.equal(guarded(p, 'GET'), true, p);
  for (const p of ['/api/runs/retry', '/api/runs/cancel', '/api/runs/update', '/api/knowledge/delete', '/api/conversations/delete',
    '/api/memory/add', '/api/memory/update', '/api/memory/delete', '/api/models/pull', '/api/models/delete',
    '/api/lab/hex-tile/sync']) {
    assert.equal(guarded(p, 'POST'), true, p);
    assert.equal(guarded(p, 'GET'), false, `${p} reads stay report-only`);
  }
});

// The pairing hint names where pairing is: Claude Code is in the Improve area (view-registry.js), not "Build".
test('every pairing hint names Improve › Claude Code, the area the page list puts it in', () => {
  const reg = fs.readFileSync(path.join(__dirname, '..', 'app', 'public', 'view-registry.js'), 'utf8');
  assert.match(reg, /\{id:'claude',[^}]*domain:'improve'[^}]*label:'Claude Code'/);
  assert.match(reg, /\{id:'improve',label:'Improve'/);
  for (const f of ['server.js', 'public/answer-feedback.js', 'public/owner-facts.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'app', f), 'utf8');
    assert.doesNotMatch(src, /Build › Claude Code/, f);
    assert.match(src, /Improve › Claude Code/, f);
  }
});
