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
