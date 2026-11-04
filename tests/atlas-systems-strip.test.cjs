'use strict';

// The Systems strip on Architecture (Atlas redesign spec, PR 4): one card per host, its services in one line, and its
// repositories as "mapped · <commit> · <age>" or "no snapshot yet". The pure parts are tested here; tests/atlas-map-ui.mjs
// drives the strip in a browser.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const strip = require('../app/public/atlas-systems.js');
const NOW = Date.parse('2026-11-05T00:00:00Z');
const A = 'a'.repeat(40), B = 'b'.repeat(40);
const svc = (id, label, state, severity, extra = {}) => ({ id, label, state, severity, headline: '', stale: false, ...extra });

test('a host with every service fine says so in one calm line', () => {
  assert.deepEqual(strip.hostHealth({ services: [svc('hub', 'Hub', 'ok', 'ok'), svc('pi', 'Raspberry Pi', 'ok', 'ok')] }),
    { text: '2 services · all fine', tone: 'ok' });
  assert.deepEqual(strip.hostHealth({ services: [svc('backups', 'Backups', 'ok', 'ok')] }), { text: '1 service · fine', tone: 'ok' });
  assert.deepEqual(strip.hostHealth({ services: [] }), { text: '', tone: '' });
});

test('services that need a look are named, a problem outranks attention, and info is fine', () => {
  const h = { services: [svc('hub', 'Hub', 'ok', 'ok'), svc('adguard', 'Ad blocking', 'paused', 'attention'),
    svc('plex', 'Movies', 'playing', 'info'), svc('pc', 'Windows PC', 'off', 'problem')] };
  assert.deepEqual(strip.hostHealth(h), { text: '2 of 4 need a look: Windows PC (off), Ad blocking (paused)', tone: 'error' });
});

test('a stale or unknown reading is not called fine', () => {
  const h = { services: [svc('hub', 'Hub', 'ok', 'ok', { stale: true }), svc('pi', 'Raspberry Pi', 'unknown', 'attention')] };
  assert.deepEqual(strip.hostHealth(h), { text: '2 of 2 need a look: Raspberry Pi (unknown), Hub (old reading)', tone: 'warn' });
});

test('a repository reads mapped with its commit and age, or no snapshot yet', () => {
  assert.equal(strip.repoLine({ snapshot: null, liveCommit: A, atLive: false }, NOW), 'no snapshot yet');
  assert.equal(strip.repoLine({ snapshot: { commit: A, generatedAt: '2026-11-04T23:00:00Z' }, liveCommit: A, atLive: true }, NOW),
    'mapped · aaaaaaa · today');
  assert.equal(strip.repoLine({ snapshot: { commit: B, generatedAt: '2026-10-31T12:00:00Z' }, liveCommit: A, atLive: false }, NOW),
    'mapped · bbbbbbb · 4 days old · live is aaaaaaa');
  assert.equal(strip.repoLine({ snapshot: { commit: B, generatedAt: null }, liveCommit: null, atLive: false }, NOW), 'mapped · bbbbbbb');
});

test('choosing a repository opens its newest snapshot; Local AI opens the latest scan', () => {
  assert.equal(strip.commitFor({ repo: 'localai', snapshot: { commit: B } }), '');
  assert.equal(strip.commitFor({ repo: 'pi-hub', snapshot: { commit: A } }), A);
  assert.equal(strip.commitFor({ repo: 'print-lab', snapshot: null }), '');
});

test('the note says where the list came from and, for a kept copy, how old it is and why', () => {
  assert.deepEqual(strip.sourceNote({ source: 'live', fetchedAt: '2026-11-04T23:59:30Z' }, NOW), { text: 'From Pi Hub, just now.', tone: '' });
  assert.deepEqual(strip.sourceNote({ source: 'cache', fetchedAt: '2026-11-04T22:00:00Z', error: 'Pi Hub could not be reached (timeout).' }, NOW),
    { text: 'Pi Hub could not be reached (timeout). Showing its list from 2 hours ago.', tone: 'warn' });
  assert.deepEqual(strip.sourceNote({ error: { message: 'Pi Hub could not be reached (refused).' } }, NOW),
    { text: 'Pi Hub could not be reached (refused). The map below still works.', tone: 'error' });
});

test('the page loads the strip before the map, it has its own region, and the service worker keeps it', () => {
  const pub = path.join(__dirname, '..', 'app', 'public');
  const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
  assert.ok(html.indexOf('src="/atlas-systems.js"') > 0 && html.indexOf('src="/atlas-systems.js"') < html.indexOf('src="/architecture.js"'));
  assert.match(html, /<section id="atlasSystems"[^>]*aria-labelledby="atlasSystemsTitle"/);
  assert.match(fs.readFileSync(path.join(pub, 'sw.js'), 'utf8'), /'\/atlas-systems\.js'/);
  const arch = fs.readFileSync(path.join(pub, 'architecture.js'), 'utf8');
  assert.match(arch, /atlas:choose/);
  assert.match(arch, /atlas:source/);
});
