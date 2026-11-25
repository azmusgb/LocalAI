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

function setup({ hub = HUB, fail = false, hubUrl = 'http://hub.test', cache, snaps = SNAPSHOTS } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-systems-'));
  const cachePath = cache === null ? null : path.join(dir, 'atlas-systems.json');
  if (cache) fs.writeFileSync(cachePath, JSON.stringify(cache));
  const calls = [];
  const systems = createSystems({
    hubUrl, cachePath, now: () => Date.parse('2026-11-05T00:00:00Z'),
    snapshots: { list: () => snaps },
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
  assert.deepEqual(pi.repos, [{ repo: 'pi-hub', label: 'Pi Hub', liveCommit: A, snapshot: { commit: A, generatedAt: '2026-11-04T23:10:00Z' }, atLive: true,
    freshness: { live: A, scanned: A, behind: null, scanAgeSeconds: 3000, state: 'current' } }]);
  assert.deepEqual(pc.repos, [{ repo: 'localai', label: 'Local AI', liveCommit: C, snapshot: { commit: B, generatedAt: '2026-10-31T12:00:00Z' }, atLive: false,
    freshness: { live: C, scanned: B, behind: null, scanAgeSeconds: 388800, state: 'behind' } }]);
  assert.deepEqual(off.repos, []);
  assert.equal(pi.targets.find((t) => t.id === 'netmon').atlas, null, 'netmon is not mapped');
});

test('a repository Atlas keeps but has no snapshot of says so', async () => {
  const hub = structuredClone(HUB);
  hub.hosts[2].targets = [{ id: 'print-lab', label: 'Print lab', repo: 'azmusgb/print-lab', atlas: 'print-lab', state: 'unknown', commit: null }];
  const { body } = await setup({ hub }).systems.read();
  assert.deepEqual(body.hosts[2].repos, [{ repo: 'print-lab', label: 'Print lab', liveCommit: null, snapshot: null, atLive: false,
    freshness: { live: null, scanned: null, behind: null, scanAgeSeconds: null, state: 'no snapshot' } }]);
});

const fresh = async (target, rows) => {
  const hub = structuredClone(HUB);
  hub.hosts[2].targets = [{ id: 'pi-hub', label: 'Pi Hub', repo: 'azmusgb/pi-hub', atlas: 'pi-hub', state: 'live', deployed_at: null, ...target }];
  const { body } = await setup({ hub, snaps: { repos: ['pi-hub'], snapshots: rows } }).systems.read();
  return body.hosts[2].repos[0].freshness;
};

test('freshness: a map at the live commit is current', async () => {
  assert.deepEqual(await fresh({ commit: A }, [{ repo: 'pi-hub', commit: A, generatedAt: '2026-11-04T00:00:00Z' }]),
    { live: A, scanned: A, behind: null, scanAgeSeconds: 86400, state: 'current' });
});

test('freshness: a map older than the live commit is behind, and the count stays null without a distance', async () => {
  const f = await fresh({ commit: C }, [{ repo: 'pi-hub', commit: A, generatedAt: '2026-11-01T00:00:00Z' }]);
  assert.equal(f.state, 'behind');
  assert.equal(f.behind, null);
  assert.equal(f.live, C);
  assert.equal(f.scanned, A);
});

test('freshness: an older ref scanned after the deploy is behind, never newer', async () => {
  const f = await fresh({ commit: C, deployed_at: '2026-11-01T00:00:00Z' }, [{ repo: 'pi-hub', commit: B, generatedAt: '2026-11-04T00:00:00Z' }]);
  assert.equal(f.state, 'behind');
  assert.equal(f.behind, null);
  assert.equal(f.scanned, B);
});

test('freshness: a map of the live commit exists but the newest differs, still behind and never ahead', async () => {
  const f = await fresh({ commit: A }, [{ repo: 'pi-hub', commit: B, generatedAt: '2026-11-04T00:00:00Z' },
    { repo: 'pi-hub', commit: A, generatedAt: '2026-11-01T00:00:00Z' }]);
  assert.equal(f.state, 'behind');
  assert.equal(f.behind, null);
  assert.equal(f.scanned, B);
  const { body } = await setup({ hub: (() => { const h = structuredClone(HUB); h.hosts[2].targets = [{ id: 'pi-hub', label: 'Pi Hub', atlas: 'pi-hub', state: 'live', commit: A }]; return h; })(),
    snaps: { repos: ['pi-hub'], snapshots: [{ repo: 'pi-hub', commit: B, generatedAt: '2026-11-04T00:00:00Z' }, { repo: 'pi-hub', commit: A, generatedAt: '2026-11-01T00:00:00Z' }] } }).systems.read();
  assert.equal(body.hosts[2].repos[0].atLive, true, 'the page says a map of the running release exists');
});

test('freshness: a missing or odd deployed_at changes nothing', async () => {
  const rows = [{ repo: 'pi-hub', commit: B, generatedAt: '2026-11-04T00:00:00Z' }];
  const a = await fresh({ commit: C, deployed_at: null }, rows);
  const b = await fresh({ commit: C, deployed_at: '2030-01-01T00:00:00Z' }, rows);
  assert.deepEqual(a, b);
  assert.equal(a.state, 'behind');
});

test('freshness: a positive count on the row is passed through, a bad one is not', async () => {
  assert.equal((await fresh({ commit: C }, [{ repo: 'pi-hub', commit: B, behind: 3, generatedAt: '2026-11-04T00:00:00Z' }])).behind, 3);
  assert.equal((await fresh({ commit: C }, [{ repo: 'pi-hub', commit: B, behind: -3, generatedAt: '2026-11-04T00:00:00Z' }])).behind, null);
});

test('freshness: a repository with no release record says no release', async () => {
  const f = await fresh({ commit: null }, [{ repo: 'pi-hub', commit: A, generatedAt: '2026-11-04T00:00:00Z' }]);
  assert.deepEqual(f, { live: null, scanned: A, behind: null, scanAgeSeconds: 86400, state: 'no release' });
});

test('freshness: no snapshot says so and has no scan age', async () => {
  assert.deepEqual(await fresh({ commit: A }, []), { live: A, scanned: null, behind: null, scanAgeSeconds: null, state: 'no snapshot' });
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

test('invalid source timestamps do not discard a valid live host list', async () => {
  for (const as_of of [1e100, -1, null, true, {}, 'not a date']) {
    const { body, status } = await setup({ hub: { ...HUB, as_of } }).systems.read();
    assert.equal(status, 200);
    assert.equal(body.source, 'live');
    assert.equal(body.hubAsOf, null);
    assert.equal(body.hosts.length, HUB.hosts.length);
  }
});
