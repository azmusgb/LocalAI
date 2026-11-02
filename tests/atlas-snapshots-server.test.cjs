'use strict';

// System Atlas snapshots, server side (plan PR 2): list the snapshots and serve one by repository and commit, with
// nothing outside <snapshots>/<allowed repo>/<indexed commit>/graph.json ever opened.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { createAtlas } = require('../app/server/atlas');
const { guarded } = require('../app/signin');

const A = 'a'.repeat(40);
const B = 'ab' + 'c'.repeat(38);
const C = 'abd' + 'e'.repeat(37);

function store(rows, graphs = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-snapshots-'));
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ snapshots: rows }));
  for (const [key, body] of Object.entries(graphs)) {
    const [repo, commit] = key.split('@');
    fs.mkdirSync(path.join(dir, repo, commit), { recursive: true });
    fs.writeFileSync(path.join(dir, repo, commit, 'graph.json'), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return dir;
}

const g = (label) => ({ generatedAt: '2026-11-01T00:00:00Z', stats: { files: 1 }, domains: [], nodes: [{ id: label }], edges: [],
  snapshot: { repo: 'pi-hub', commit: A } });

function atlasWith(snapshotsPath, extra = {}) {
  const sent = [];
  const atlas = createAtlas({
    snapshotsPath,
    graphPath: path.join(os.tmpdir(), 'no-such-atlas', 'system-atlas.html'),
    json: (res, status, body) => sent.push({ status, body }),
    readBody: async () => ({}),
    fetchWithTimeout: async () => { throw new Error('offline'); },
    ...extra,
  });
  const get = async (url) => {
    const p = url.split('?')[0];
    await atlas.apiAtlas({ method: 'GET', url }, {}, p);
    return sent.at(-1);
  };
  return { atlas, get };
}

test('the list holds only allowed repositories and well-formed commits, newest first', async () => {
  const dir = store([
    { repo: 'pi-hub', commit: A, generatedAt: '2026-11-01T01:00:00Z' },
    { repo: 'pi-hub', commit: B, generatedAt: '2026-11-01T02:00:00Z' },
    { repo: 'secret-repo', commit: C, generatedAt: '2026-11-01T03:00:00Z' },
    { repo: 'print-lab', commit: '../../etc', generatedAt: '2026-11-01T04:00:00Z' },
  ]);
  const { get } = atlasWith(dir);
  const r = await get('/api/atlas/snapshots');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.repos, ['localai', 'pi-hub', 'print-lab']);
  assert.deepEqual(r.body.snapshots.map((s) => s.commit), [B, A]);
});

test('no index yet is an empty list, not an error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-empty-'));
  const r = await atlasWith(dir).get('/api/atlas/snapshots');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.snapshots, []);
});

test('a snapshot is served by repository and full or abbreviated commit', async () => {
  const dir = store([{ repo: 'pi-hub', commit: A }], { [`pi-hub@${A}`]: g('hub/app.py') });
  const { get } = atlasWith(dir);
  for (const commit of [A, A.slice(0, 7), A.toUpperCase().slice(0, 10)]) {
    const r = await get(`/api/atlas/graph?repo=PI-HUB&commit=${commit}`);
    assert.equal(r.status, 200, commit);
    assert.deepEqual(r.body.nodes, [{ id: 'hub/app.py' }]);
    assert.equal(r.body.snapshot.commit, A);
  }
});

test('bad or unknown requests get a clear status and never touch the disk outside the store', async () => {
  const dir = store([{ repo: 'pi-hub', commit: B }, { repo: 'pi-hub', commit: C }], { [`pi-hub@${B}`]: g('x') });
  const { get } = atlasWith(dir);
  const cases = [
    ['/api/atlas/graph?repo=pi-hub', 400, 'atlas_snapshot_query'],
    ['/api/atlas/graph?commit=abcdef1', 400, 'atlas_snapshot_query'],
    ['/api/atlas/graph?repo=pi-hub&commit=../../etc', 400, 'atlas_commit_invalid'],
    ['/api/atlas/graph?repo=pi-hub&commit=abc', 400, 'atlas_commit_invalid'],
    ['/api/atlas/graph?repo=../x&commit=abcdef1', 404, 'atlas_repo_unknown'],
    ['/api/atlas/graph?repo=netmon&commit=abcdef1', 404, 'atlas_repo_unknown'],
    ['/api/atlas/graph?repo=pi-hub&commit=1234567', 404, 'atlas_snapshot_missing'],
    ['/api/atlas/graph?repo=pi-hub&commit=ab', 400, 'atlas_commit_invalid'],
  ];
  for (const [url, status, code] of cases) {
    const r = await get(url);
    assert.equal(r.status, status, url);
    assert.equal(r.body.error.code, code, url);
  }
  // Two snapshots sharing their first seven characters: that abbreviation is ambiguous.
  const both = store([{ repo: 'pi-hub', commit: 'abcdef0' + '1'.repeat(33) }, { repo: 'pi-hub', commit: 'abcdef0' + '2'.repeat(33) }]);
  const r = await atlasWith(both).get('/api/atlas/graph?repo=pi-hub&commit=abcdef0');
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'atlas_commit_ambiguous');
  // An indexed commit whose file is missing or broken is a 503 that names the problem.
  const broken = await get(`/api/atlas/graph?repo=pi-hub&commit=${C}`);
  assert.equal(broken.status, 503);
  assert.equal(broken.body.error.code, 'atlas_snapshot_unavailable');
});

test('the allowed repositories come from LOCALAI_ATLAS_REPOS when set', async () => {
  const dir = store([{ repo: 'netmon', commit: A }], { [`netmon@${A}`]: g('n') });
  const { get } = atlasWith(dir, { repos: 'netmon' });
  assert.equal((await get(`/api/atlas/graph?repo=netmon&commit=${A}`)).status, 200);
  assert.equal((await get(`/api/atlas/graph?repo=pi-hub&commit=${A}`)).status, 404);
});

test('with no query the graph route serves the single graph as before', async () => {
  const dir = store([]);
  const r = await atlasWith(dir).get('/api/atlas/graph');
  assert.equal(r.status, 503);  // this test's single graph doesn't exist: the old behaviour, unchanged
  assert.equal(r.body.error.code, 'atlas_graph_unavailable');
});

test('reading snapshots needs no sign-in, and the container mounts them read-only', () => {
  assert.equal(guarded('/api/atlas/snapshots', 'GET'), false);
  const compose = fs.readFileSync(path.join(ROOT, 'deploy/stack/compose.yml'), 'utf8');
  assert.match(compose, /\.atlas\/snapshots:\/atlas-snapshots:ro/);
});
