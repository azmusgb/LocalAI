'use strict';
// The browser suites write to the server they test (Claude board findings and sessions, chats, settings). Pointed at
// the deployed appliance they left `ui-test` sessions and findings on the live board, so tests/run-browser.mjs first
// asks the target's /healthz and refuses a deployed release (it reports the releaseCommit the deploy's release.json
// sets; a checkout reports null) or a target it cannot read.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { execFile } = require('node:child_process');

const helper = () => import(path.join(__dirname, 'browser-target.mjs'));
const PROD = { status: 'ok', appliance: 'Local AI', version: '2.0.1580', releaseCommit: '12b2ce04df718b55fb535bcfef027a36f8aa3964' };
const LOCAL = { status: 'ok', appliance: 'Local AI', version: '2.0.0', releaseCommit: null };
const reply = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, text: async () => body });

test('a deployed release (releaseCommit set) is refused, naming the commit and the override', async () => {
  const { checkBrowserTarget, PRODUCTION_OVERRIDE } = await helper();
  const r = await checkBrowserTarget('http://127.0.0.1:3080', { fetch: reply(200, JSON.stringify(PROD)), env: {} });
  assert.equal(r.ok, false);
  assert.match(r.reason, /deployed release/);
  assert.match(r.reason, /12b2ce04df71/);
  assert.match(r.reason, new RegExp(PRODUCTION_OVERRIDE));
});

test('a checkout server (releaseCommit null) is allowed', async () => {
  const { checkBrowserTarget } = await helper();
  assert.deepEqual(await checkBrowserTarget('http://127.0.0.1:3183', { fetch: reply(200, JSON.stringify(LOCAL)), env: {} }), { ok: true });
});

test('an unreachable /healthz is refused with a clear message, not treated as safe', async () => {
  const { checkBrowserTarget } = await helper();
  const r = await checkBrowserTarget('http://127.0.0.1:9', { fetch: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:9'); }, env: {} });
  assert.equal(r.ok, false);
  assert.match(r.reason, /could not read http:\/\/127\.0\.0\.1:9\/healthz/);
  assert.match(r.reason, /ECONNREFUSED/);
  assert.match(r.reason, /throwaway server/);
});

test('a timeout, an error status, a malformed body and a non-Local AI answer are each refused', async () => {
  const { checkBrowserTarget } = await helper();
  const url = 'http://127.0.0.1:3183';
  const timeout = await checkBrowserTarget(url, { fetch: (_u, o) => new Promise((_r, reject) => o.signal.addEventListener('abort', () => reject(o.signal.reason))), env: {}, timeoutMs: 20 });
  assert.equal(timeout.ok, false); assert.match(timeout.reason, /could not read/);
  const status = await checkBrowserTarget(url, { fetch: reply(503, 'busy'), env: {} });
  assert.equal(status.ok, false); assert.match(status.reason, /HTTP 503/);
  const malformed = await checkBrowserTarget(url, { fetch: reply(200, '<html>'), env: {} });
  assert.equal(malformed.ok, false); assert.match(malformed.reason, /not JSON/);
  const other = await checkBrowserTarget(url, { fetch: reply(200, JSON.stringify({ status: 'ok' })), env: {} });
  assert.equal(other.ok, false); assert.match(other.reason, /not Local AI/);
  const noMarker = await checkBrowserTarget(url, { fetch: reply(200, JSON.stringify({ status: 'ok', appliance: 'Local AI' })), env: {} });
  assert.equal(noMarker.ok, false); assert.match(noMarker.reason, /releaseCommit/);
});

test('only the override named for the danger, set to exactly 1, lets a deployed release through', async () => {
  const { checkBrowserTarget, PRODUCTION_OVERRIDE } = await helper();
  assert.equal(PRODUCTION_OVERRIDE, 'LOCALAI_TESTS_WRITE_TO_PRODUCTION');
  const prod = { fetch: reply(200, JSON.stringify(PROD)) };
  assert.equal((await checkBrowserTarget('http://x', { ...prod, env: { [PRODUCTION_OVERRIDE]: 'yes' } })).ok, false);
  const r = await checkBrowserTarget('http://x', { ...prod, env: { [PRODUCTION_OVERRIDE]: '1' } });
  assert.equal(r.ok, true); assert.match(r.warning, /deployed release/);
  // The override never waives an unreadable target.
  assert.equal((await checkBrowserTarget('http://x', { fetch: async () => { throw new Error('down'); }, env: { [PRODUCTION_OVERRIDE]: '1' } })).ok, false);
});

function runBrowser(args, env) {
  return new Promise(resolve => execFile(process.execPath, [path.join(__dirname, 'run-browser.mjs'), ...args],
    { env: { ...process.env, LOCALAI_TESTS_WRITE_TO_PRODUCTION: '', ...env }, timeout: 20000 },
    (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr })));
}

test('run-browser.mjs exits non-zero before any suite runs when the target is a deployed release', async (t) => {
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(PROD)); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const r = await runBrowser(['claude-board-ui.mjs'], { LOCALAI_URL: `http://127.0.0.1:${server.address().port}` });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /deployed release/);
  assert.doesNotMatch(r.stdout, /=== claude-board-ui\.mjs/);
});

test('run-browser.mjs exits non-zero when the target cannot be read', async () => {
  const r = await runBrowser(['claude-board-ui.mjs'], { LOCALAI_URL: 'http://127.0.0.1:9' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /could not read http:\/\/127\.0\.0\.1:9\/healthz/);
  assert.doesNotMatch(r.stdout, /=== claude-board-ui\.mjs/);
});

test('run-browser.mjs --list and suites that start their own server do not need a target', async () => {
  assert.equal((await runBrowser(['--list'], { LOCALAI_URL: 'http://127.0.0.1:9' })).code, 0);
  // visual-ui.mjs starts its own server and ignores LOCALAI_URL; it is only listed here, not run.
  const { suitesNeedingTarget } = await helper();
  assert.deepEqual(suitesNeedingTarget(['visual-ui.mjs', 'claude-board-ui.mjs'], __dirname), ['claude-board-ui.mjs']);
});
