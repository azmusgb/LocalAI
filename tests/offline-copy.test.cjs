'use strict';
// app/public/offline-copy.js: the page tells the owner when it is a saved copy (the service worker answered from its
// cache because Local AI couldn't be reached), and replaces itself when Local AI runs a different build.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pub = path.resolve(__dirname, '../app/public');
const offline = require(path.join(pub, 'offline-copy.js'));
const sw = fs.readFileSync(path.join(pub, 'sw.js'), 'utf8');

test('relativeTime says how old a saved copy is in plain words', () => {
  const now = Date.parse('2026-10-16T12:00:00Z');
  const ago = ms => offline.relativeTime(new Date(now - ms).toISOString(), now);
  assert.equal(ago(5 * 1000), 'just now');
  assert.equal(ago(60 * 1000), '1 minute ago');
  assert.equal(ago(42 * 60 * 1000), '42 minutes ago');
  assert.equal(ago(60 * 60 * 1000), '1 hour ago');
  assert.equal(ago(5 * 60 * 60 * 1000), '5 hours ago');
  assert.equal(ago(26 * 60 * 60 * 1000), 'yesterday');
  assert.equal(ago(3 * 24 * 60 * 60 * 1000), '3 days ago');
  assert.equal(offline.relativeTime('', now), 'an earlier visit');
  assert.equal(offline.relativeTime('not a date', now), 'an earlier visit');
  // a clock that runs behind the server's Date header must not say "in 2 minutes"
  assert.equal(ago(-2 * 60 * 1000), 'just now');
});

test('buildDiffers compares the page build with what /healthz reports', () => {
  const page = { version: '2.0.431', releaseCommit: 'a'.repeat(40) };
  assert.equal(offline.buildDiffers(page, { version: '2.0.431', releaseCommit: 'a'.repeat(40) }), false);
  assert.equal(offline.buildDiffers(page, { version: '2.0.432', releaseCommit: 'a'.repeat(40) }), true);
  assert.equal(offline.buildDiffers(page, { version: '2.0.431', releaseCommit: 'b'.repeat(40) }), true);
  // a checkout has no release: null from /healthz and '' in the page are the same build
  assert.equal(offline.buildDiffers({ version: '2.0.0', releaseCommit: '' }, { version: '2.0.0', releaseCommit: null }), false);
  // a page that doesn't know its own build can't be compared, so it never reloads
  assert.equal(offline.buildDiffers(null, { version: '2.0.0' }), false);
  assert.equal(offline.buildDiffers({ version: '', releaseCommit: '' }, { version: '2.0.0' }), false);
  assert.equal(offline.buildDiffers(page, null), false);
  assert.equal(offline.buildDiffers(page, { status: 'ok' }), false);
});

test('buildKey names a build for the reload-once guard', () => {
  assert.equal(offline.buildKey({ version: '2.0.1', releaseCommit: 'abc' }), '2.0.1@abc');
  assert.equal(offline.buildKey({ version: '2.0.1', releaseCommit: null }), '2.0.1@');
});

test('the service worker marks a saved copy and the page loads the module that reads the mark', () => {
  assert.match(sw, /X-LocalAI-Offline-Copy/);
  assert.match(sw, /localai-offline-copy/);
  assert.match(sw, /'\/offline-copy\.js'/);
  assert.match(sw, /const CACHE='local-ai-shell-v1\.18-unified-runs[^']*-offline1[^']*'/);
});

test('only Local AI\'s own health payload counts as reachable (not a proxy 502 or a captive portal)', () => {
  const { isLocalAIHealth } = require('../app/public/offline-copy.js');
  assert.equal(isLocalAIHealth({ status: 'ok', appliance: 'Local AI', version: '2.0.400', releaseCommit: 'abc' }), true);
  assert.equal(isLocalAIHealth({ status: 'degraded', appliance: 'Local AI', version: '2.0.400' }), true, 'Local AI answering 503 is still reachable');
  assert.equal(isLocalAIHealth(null), false, 'no JSON (Caddy 502 page)');
  assert.equal(isLocalAIHealth({ ok: true }), false, 'some other JSON (captive portal)');
  assert.equal(isLocalAIHealth({ appliance: 'Local AI', version: '' }), false);
});

test('isUpdatingReply recognises the HTTPS front end saying Local AI is updating, and nothing else', () => {
  const body = { error: 'Local AI is updating', updating: true };
  assert.equal(offline.isUpdatingReply(503, body), true);
  assert.equal(offline.isUpdatingReply(502, body), true);
  assert.equal(offline.isUpdatingReply(200, body), false);
  assert.equal(offline.isUpdatingReply(500, { error: 'boom' }), false);
  assert.equal(offline.isUpdatingReply(503, { error: 'Ollama is down' }), false);
  assert.equal(offline.isUpdatingReply(502, null), false, 'a bare 502 could be a crash: not called an update');
});

test('otherAddresses offers the addresses that are not this page, Tailscale marked, https only', () => {
  const list = [{ label: 'Home Wi-Fi', url: 'https://10.0.0.21' }, { label: 'Anywhere (Tailscale)', url: 'https://bill-hpdesktop.tailfa018e.ts.net' }];
  assert.deepEqual(offline.otherAddresses(list, 'https://10.0.0.21'), [{ label: 'Anywhere (Tailscale)', url: 'https://bill-hpdesktop.tailfa018e.ts.net/', tailscale: true }]);
  assert.deepEqual(offline.otherAddresses(list, 'https://bill-hpdesktop.tailfa018e.ts.net'), [{ label: 'Home Wi-Fi', url: 'https://10.0.0.21/', tailscale: false }]);
  assert.equal(offline.otherAddresses(list, 'https://localai.home.arpa').length, 2);
  // nothing saved yet, or junk: nothing to offer, and never a script or plain-HTTP link
  assert.deepEqual(offline.otherAddresses(null, 'https://10.0.0.21'), []);
  assert.deepEqual(offline.otherAddresses([{ label: 'x', url: 'javascript:alert(1)' }, { label: 'y', url: 'http://10.0.0.21' }, { label: 'z' }, null], 'https://a'), []);
  // the same address twice is offered once
  assert.equal(offline.otherAddresses([list[1], list[1]], 'https://10.0.0.21').length, 1);
});

// Moving to the other address on its own (Home Wi-Fi can't be reached, Tailscale can, or the other way round).
const HOME = 'https://10.0.0.21', TS = 'https://bill-hpdesktop.tailfa018e.ts.net';
const LIST = [{ label: 'Home Wi-Fi', url: HOME }, { label: 'Anywhere (Tailscale)', url: TS }];

test('otherAddresses allows plain http only on this machine (a developer or test appliance)', () => {
  assert.deepEqual(offline.otherAddresses([{ label: 'Home Wi-Fi', url: 'http://127.0.0.1:3181' }], 'http://127.0.0.1:3180').map(a => a.url), ['http://127.0.0.1:3181/']);
  assert.deepEqual(offline.otherAddresses([{ label: 'Home Wi-Fi', url: 'http://localhost:3181' }], 'x').length, 1);
  assert.deepEqual(offline.otherAddresses([{ label: 'Home Wi-Fi', url: 'http://10.0.0.21' }, { label: 'x', url: 'http://127.0.0.1.evil.com' }], 'x'), []);
});

test('ownAddress finds this page in the list, and nothing for an address it does not list', () => {
  assert.equal(offline.ownAddress(LIST, HOME).label, 'Home Wi-Fi');
  assert.equal(offline.ownAddress(LIST, TS).tailscale, true);
  assert.equal(offline.ownAddress(LIST, 'https://localai.home.arpa'), null);
  assert.equal(offline.ownAddress(null, HOME), null);
});

test('autoSwitchAllowed: once per tab session, never after a cancel, never from an address it moved to', () => {
  assert.equal(offline.autoSwitchAllowed({ choice: '', arrivedFrom: '' }), true);
  assert.equal(offline.autoSwitchAllowed({ choice: 'cancelled', arrivedFrom: '' }), false);
  assert.equal(offline.autoSwitchAllowed({ choice: 'switched ' + TS, arrivedFrom: '' }), false, 'already moved once: back here means the other one failed too');
  assert.equal(offline.autoSwitchAllowed({ choice: '', arrivedFrom: HOME }), false, 'no bouncing back automatically');
});

test('pickReachable takes the first address that answered, in the list order', () => {
  const others = offline.otherAddresses([...LIST, { label: 'Office', url: 'https://office.example' }], 'https://localai.home.arpa');
  assert.equal(offline.pickReachable(others, [false, false, false]), null);
  assert.equal(offline.pickReachable(others, [false, true, true]).label, 'Anywhere (Tailscale)');
  assert.equal(offline.pickReachable(others, [true, true, false]).label, 'Home Wi-Fi');
  assert.equal(offline.pickReachable([], []), null);
  assert.equal(offline.pickReachable(others, undefined), null);
});

test('switchUrl keeps the page: path, query and hash', () => {
  const target = offline.otherAddresses(LIST, HOME)[0];
  assert.equal(offline.switchUrl(target, { pathname: '/', search: '', hash: '#claude' }), TS + '/#claude');
  assert.equal(offline.switchUrl(target, { pathname: '/index.html', search: '?a=1', hash: '#work/run-12' }), TS + '/index.html?a=1#work/run-12');
});

test('arrivedFrom: the address it was moved from, from the tab memory or a listed referrer only', () => {
  assert.equal(offline.arrivedFrom(HOME + '/', LIST, TS, ''), HOME);
  assert.equal(offline.arrivedFrom('', LIST, TS, HOME), HOME, 'remembered for the tab after a reload drops the referrer');
  assert.equal(offline.arrivedFrom('', LIST, TS, ''), '', 'opened directly: no offer to go back');
  assert.equal(offline.arrivedFrom('https://example.com/', LIST, TS, ''), '', 'a link from elsewhere is not a move');
  assert.equal(offline.arrivedFrom(TS + '/', LIST, TS, ''), '', 'its own address is not another one');
  assert.equal(offline.arrivedFrom('not a url', LIST, TS, 'https://gone.example'), '', 'a remembered address no longer listed is ignored');
});

test('switchNotice and backOffer say where in plain words, and nothing about pairing', () => {
  const [home, ts] = [offline.ownAddress(LIST, HOME), offline.ownAddress(LIST, TS)];
  assert.equal(offline.switchNotice(home, ts), "Home Wi-Fi isn't reachable. Switching to Tailscale…");
  assert.equal(offline.switchNotice(ts, home), "Anywhere (Tailscale) isn't reachable. Switching to Home Wi-Fi…");
  assert.equal(offline.switchNotice(null, ts), "This address isn't reachable. Switching to Tailscale…");
  assert.deepEqual(offline.backOffer(home), { text: 'Back on home Wi-Fi', link: 'open the home address' });
  assert.deepEqual(offline.backOffer(ts), { text: 'Tailscale answers again', link: 'open the Tailscale address' });
  for (const s of [offline.switchNotice(home, ts), offline.backOffer(home).text]) assert.doesNotMatch(s, /pair/i);
});
