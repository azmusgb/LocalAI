'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { createWatchdog, evaluate, measureDisks, cleanHeartbeat, LIMITS } = require('../app/watchdog');
const { spawnAppServer } = require('./spawn-server.cjs');

const T0 = Date.parse('2026-10-19T18:00:00Z');
const GB = 1e9;
const memStorage = () => { const m = new Map(); return { readSetting: (k, d) => (m.has(k) ? m.get(k) : d), writeSetting: (k, v) => m.set(k, v) }; };
const statfsOf = (map) => (p) => { if (!map[p]) throw new Error('ENOENT'); return { bsize: 1, blocks: map[p].total, bavail: map[p].free }; };

test('a quiet Mac is listed but never pushed (it sleeps every night)', () => {
  const f = evaluate({ now: T0, mac: { at: new Date(T0 - 20 * 60e3).toISOString() }, timeZone: 'UTC' });
  assert.equal(f.length, 1);
  assert.equal(f[0].id, 'mac-silent');
  assert.equal(f[0].push, null);
  assert.match(f[0].detail, /5:40 PM/);
});

test('a full Mac disk and a stopped camera bridge are found from a fresh heartbeat', () => {
  const mac = { at: new Date(T0 - 60e3).toISOString(), disk: { freeBytes: 13 * GB, totalBytes: 460 * GB }, bridge: { installed: true, running: false } };
  const ids = evaluate({ now: T0, mac }).map((f) => f.id);
  assert.deepEqual(ids, ['mac-disk', 'camera-bridge']);
  const disk = evaluate({ now: T0, mac }).find((f) => f.id === 'mac-disk');
  assert.equal(disk.title, 'Mac disk is 97% full');
  assert.equal(disk.severity, 'high');
  assert.equal(disk.push, 'needs-you');
});

test('a healthy Mac, roomy disk and a bridge that is not installed find nothing', () => {
  const mac = { at: new Date(T0).toISOString(), disk: { freeBytes: 200 * GB, totalBytes: 460 * GB }, bridge: { installed: false, running: false } };
  assert.deepEqual(evaluate({ now: T0, mac }), []);
});

test('the display is offline only after the limit, and a printer error is listed without a push (Pi Hub is the one sender)', () => {
  const recent = { access: 'offline', seenAt: new Date(T0 - 5 * 60e3).toISOString() };
  assert.deepEqual(evaluate({ now: T0, printer: recent }), []);
  const long = { access: 'offline', seenAt: new Date(T0 - 11 * 60e3).toISOString() };
  assert.equal(evaluate({ now: T0, printer: long })[0].id, 'display-offline');
  const err = evaluate({ now: T0, printer: { access: 'ok', state: 'error', errorCode: '0700_8010', seenAt: new Date(T0).toISOString() } })[0];
  assert.equal(err.push, null);
  assert.match(err.detail, /0700_8010/);
});

test('bind mounts of one drive count once', () => {
  const disks = measureDisks([{ path: '/a', name: 'a' }, { path: '/b', name: 'b' }, { path: '/missing', name: 'm' }], statfsOf({ '/a': { total: 500, free: 100 }, '/b': { total: 500, free: 100 } }));
  assert.equal(disks.length, 1);
  assert.equal(disks[0].name, 'a');
});

test('heartbeats keep only known, well-formed fields', () => {
  const b = cleanHeartbeat({ name: 'x'.repeat(80), disk: { freeBytes: '5', totalBytes: 10 }, bridge: { installed: 'yes', running: true }, evil: 1 }, 'now');
  assert.equal(b.name.length, 40);
  assert.deepEqual(b.disk, { freeBytes: 5, totalBytes: 10 });
  assert.deepEqual(b.bridge, { installed: false, running: true, frameAgeMs: null });
  assert.equal(b.evil, undefined);
});

test('a problem notifies once after it settles, and leaves the list when it clears', () => {
  let t = T0;
  const sent = [];
  const disks = { '/c': { total: 100 * GB, free: 3 * GB } };
  const wd = createWatchdog({ storage: memStorage(), notify: (e) => sent.push(e), now: () => t, hostPaths: [{ path: '/c', name: 'windows', label: 'Windows' }], statfs: statfsOf(disks) });
  wd.tick();
  assert.equal(sent.length, 0, 'not before it settles');
  assert.deepEqual(wd.list(), []);
  t += LIMITS.settleMs;
  wd.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, 'Windows disk is 97% full');
  assert.equal(sent[0].kind, 'needs-you');
  t += 60e3;
  wd.tick();
  assert.equal(sent.length, 1, 'only once');
  assert.equal(wd.list().length, 1);
  disks['/c'].free = 60 * GB;
  t += 60e3;
  wd.tick();
  assert.deepEqual(wd.list(), []);
  assert.equal(sent.length, 1, 'no push when it clears');
});

test('a print that ends on its own sends nothing: Pi Hub already sends Print finished (step 5, D2)', () => {
  let t = T0, printer = { access: 'ok', state: 'printing', seenAt: new Date(T0).toISOString() };
  const sent = [];
  const wd = createWatchdog({ storage: memStorage(), notify: (e) => sent.push(e), now: () => t, printer: () => printer, statfs: statfsOf({}) });
  wd.tick();
  printer = { ...printer, state: 'ended' };
  t += 30e3;
  wd.tick();
  wd.tick();
  assert.deepEqual(sent, []);
});

test('POST /api/watch/heartbeat needs the Mac key; GET /api/watch shows the Mac', { timeout: 30000 }, async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-watch-'));
  const key = 'k'.repeat(64);
  fs.writeFileSync(path.join(dataDir, 'claude-chat-mac-key.sha256'), require('node:crypto').createHash('sha256').update(key).digest('hex'));
  const dead = 'http://127.0.0.1:9';
  const { child, ready } = spawnAppServer({ env: { DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, OLLAMA_URL: dead, SEARXNG_URL: dead, COMFY_URL: dead, N8N_URL: dead, PROXY_URL: dead, MAC_AI_HOME_URL: dead, MAC_DSH_URL: dead } });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = await ready;
  const beat = { name: 'Test Mac', disk: { freeBytes: 13 * GB, totalBytes: 460 * GB }, bridge: { installed: true, running: true } };
  const post = (headers) => fetch(`${base}/api/watch/heartbeat`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(beat) });
  assert.equal((await post({})).status, 401);
  assert.equal((await post({ 'X-LocalAI-Mac-Key': 'wrong' })).status, 401);
  assert.equal((await post({ 'X-LocalAI-Mac-Key': key })).status, 200);
  const summary = await (await fetch(`${base}/api/watch`)).json();
  assert.equal(summary.mac.name, 'Test Mac');
  assert.equal(summary.mac.disk.freeBytes, 13 * GB);
  assert.ok(Array.isArray(summary.findings));
  assert.ok(Array.isArray(summary.hostDisks));
});
