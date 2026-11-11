'use strict';

// What runs where (Atlas redesign spec, PR 4; decision 2): GET /api/atlas/systems reads Pi Hub's /api/systems (its list
// of hosts, with the status and release records' states), adds each repository's newest snapshot, and keeps the last good
// copy so the strip still draws, with that copy's age, when the Pi can't be reached.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSystems } = require('../app/server/atlas-systems');

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
const HUB = {
  as_of: 1793834000.5,
  hosts: [
    { id: 'pi', label: 'Raspberry Pi', runs: 'Always on',
      services: [{ id: 'hub', label: "The hub's sources", state: 'ok', severity: 'ok', headline: 'All sources answer', stale: false }],
      targets: [{ id: 'pi-hub', label: 'Pi Hub', repo: 'azmusgb/pi-hub', atlas: 'pi-hub', state: 'live', commit: A, deployed_at: '2026-11-04T18:00:00-05:00', version: null },
        { id: 'netmon', label: 'netmon', repo: 'azmusgb/netmon', atlas: null, state: 'live', commit: B, deployed_at: null, version: null }] },
    { id: 'pc', label: 'Windows PC', runs: 'May sleep', services: [],
      targets: [{ id: 'localai', label: 'Local AI', repo: 'azmusgb/LocalAI', atlas: 'localai', state: 'live', commit: C, deployed_at: null, version: '2.0.1250' }] },
    { id: 'offsite', label: 'Off-site', runs: 'Google Drive, nightly', services: [], targets: [] },
  ],
};
const SNAPSHOTS = { repos: ['localai', 'pi-hub', 'print-lab'], snapshots: [
  { repo: 'pi-hub', commit: A, generatedAt: '2026-11-04T23:10:00Z' },
  { repo: 'localai', commit: B, generatedAt: '2026-10-31T12:00:00Z' },
] };

function setup({ hub = HUB, fail = false, hubUrl = 'http://hub.test', cache } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-systems-'));
  const cachePath = cache === null ? null : path.join(dir, 'atlas-systems.json');
  if (cache) fs.writeFileSync(cachePath, JSON.stringify(cache));
  const calls = [];
  const systems = createSystems({
    hubUrl, cachePath, now: () => Date.parse('2026-11-05T00:00:00Z'),
    snapshots: { list: () => SNAPSHOTS },
    fetchWithTimeout: async (url, opts, ms) => {
      calls.push({ url, ms });
      if (fail) throw new Error('connect ECONNREFUSED 10.0.0.80:80');
      return { ok: true, status: 200, json: async () => hub };
    },
  });
  return { systems, calls, cachePath };
}

test('it reads Pi Hub over the machine path and keeps the hosts in its order', async () => {
  const { systems, calls } = setup();
  const r = await systems.read();
  assert.equal(r.status, 200);
  assert.equal(calls[0].url, 'http://hub.test/api/systems');
  assert.ok(calls[0].ms <= 8000);
  assert.deepEqual(r.body.hosts.map((h) => h.id), ['pi', 'pc', 'offsite']);
  assert.equal(r.body.source, 'live');
  assert.equal(r.body.hubAsOf, '2026-11-04T23:13:20.500Z');
});

test('a mapped repository says its newest snapshot and whether that is the live commit', async () => {
  const { body } = await setup().systems.read();
  const [pi, pc, off] = body.hosts;
  assert.deepEqual(pi.repos, [{ repo: 'pi-hub', label: 'Pi Hub', liveCommit: A, snapshot: { commit: A, generatedAt: '2026-11-04T23:10:00Z' }, atLive: true }]);
  assert.deepEqual(pc.repos, [{ repo: 'localai', label: 'Local AI', liveCommit: C, snapshot: { commit: B, generatedAt: '2026-10-31T12:00:00Z' }, atLive: false }]);
  assert.deepEqual(off.repos, []);
  assert.equal(pi.targets.find((t) => t.id === 'netmon').atlas, null, 'netmon is not mapped');
});

test('a repository Atlas keeps but has no snapshot of says so', async () => {
  const hub = structuredClone(HUB);
  hub.hosts[2].targets = [{ id: 'print-lab', label: 'Print lab', repo: 'azmusgb/print-lab', atlas: 'print-lab', state: 'unknown', commit: null }];
  const { body } = await setup({ hub }).systems.read();
  assert.deepEqual(body.hosts[2].repos, [{ repo: 'print-lab', label: 'Print lab', liveCommit: null, snapshot: null, atLive: false }]);
});

test('when the Pi cannot be reached the last good copy is served, with its age and why', async () => {
  const first = setup();
  await first.systems.read();
  const saved = JSON.parse(fs.readFileSync(first.cachePath, 'utf8'));
  const { systems } = setup({ fail: true, cache: saved });
  const r = await systems.read();
  assert.equal(r.status, 200);
  assert.equal(r.body.source, 'cache');
  assert.equal(r.body.fetchedAt, '2026-11-05T00:00:00.000Z');
  assert.match(r.body.error, /Pi Hub could not be reached/);
  assert.deepEqual(r.body.hosts.map((h) => h.id), ['pi', 'pc', 'offsite']);
  assert.equal(r.body.hosts[1].repos[0].snapshot.commit, B, 'snapshots are read fresh, not from the copy');
});

test('with no Pi and no copy it says what failed', async () => {
  const r = await setup({ fail: true }).systems.read();
  assert.equal(r.status, 503);
  assert.equal(r.body.error.code, 'atlas_systems_unavailable');
  assert.match(r.body.error.message, /Pi Hub could not be reached/);
  const off = await setup({ hubUrl: 'off', cache: null }).systems.read();
  assert.equal(off.status, 503);
  assert.match(off.body.error.message, /not configured/);
});

test('an answer that is not a list of hosts is not trusted, and never replaces the copy', async () => {
  const first = setup();
  await first.systems.read();
  const saved = fs.readFileSync(first.cachePath, 'utf8');
  const bad = setup({ hub: { hosts: 'nope' }, cache: JSON.parse(saved) });
  const r = await bad.systems.read();
  assert.equal(r.body.source, 'cache');
  assert.match(r.body.error, /not a list of hosts/);
  assert.equal(fs.readFileSync(bad.cachePath, 'utf8'), saved);
});

test('odd fields are dropped or bounded: no unknown keys, no long strings, no bad commits', async () => {
  const hub = { hosts: [{ id: 'pi', label: 'x'.repeat(500), runs: 'Always on', extra: 'secret',
    services: [null, { id: 'hub', label: 'Hub', state: 'ok', severity: 'ok', headline: 'y'.repeat(900), detail: { token: 't' } }],
    targets: [{ id: 'pi-hub', label: 'Pi Hub', atlas: '../../etc', state: 'live', commit: 'not-a-commit' }] }] };
  const { body } = await setup({ hub }).systems.read();
  const [pi] = body.hosts;
  assert.equal(pi.extra, undefined);
  assert.ok(pi.label.length <= 80);
  assert.equal(pi.services.length, 1);
  assert.equal(pi.services[0].detail, undefined);
  assert.ok(pi.services[0].headline.length <= 200);
  assert.equal(pi.targets[0].commit, null);
  assert.equal(pi.targets[0].atlas, null, 'only repositories Atlas keeps are named');
  assert.deepEqual(pi.repos, []);
});

test('the route is served by the Atlas facade', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'server', 'atlas.js'), 'utf8');
  assert.match(src, /p === '\/api\/atlas\/systems'/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'app', 'server.js'), 'utf8'), /atlas-systems\.json/);
});
