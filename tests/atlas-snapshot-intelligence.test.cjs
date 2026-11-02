'use strict';

// System Atlas intelligence on a snapshot (plan PR 5): summary, findings, node, Ask and Goose take an optional repo
// and commit. The app matches both against its snapshot list and forwards only the listed repository and full commit;
// the service reads that snapshot's graph.json and answers from a clean copy of its commit, never a working tree.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const { createAtlas } = require('../app/server/atlas');
const PY = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);
const GIT = spawnSync('git', ['--version']).status === 0;

const A = 'a'.repeat(40);
const B = 'ab' + 'c'.repeat(38);
const C = 'ab' + 'd'.repeat(38);

function store(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-scope-'));
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ snapshots: rows }));
  return dir;
}

// The app's proxy with a recording upstream: each call returns what reached the service, or the app's own answer.
function proxyWith(body = {}) {
  const sent = [];
  const calls = [];
  const atlas = createAtlas({
    snapshotsPath: store([
      { repo: 'pi-hub', commit: A, generatedAt: '2026-11-01T01:00:00Z' },
      { repo: 'print-lab', commit: B, generatedAt: '2026-11-01T02:00:00Z' },
      { repo: 'print-lab', commit: C, generatedAt: '2026-11-01T03:00:00Z' },
    ]),
    graphPath: path.join(os.tmpdir(), 'no-such-atlas', 'system-atlas.html'),
    json: (res, status, payload) => sent.push({ status, payload }),
    readBody: async () => body,
    fetchWithTimeout: async (url, options, timeoutMs) => {
      calls.push({ url: new URL(url), body: options.body ? JSON.parse(options.body) : null, timeoutMs });
      return { status: 200, text: async () => '{"ok":true}' };
    },
  });
  const call = async (method, url) => {
    await atlas.apiAtlas({ method, url }, {}, url.split('?')[0]);
    return { reply: sent.at(-1), upstream: calls.at(-1), calls: calls.length };
  };
  return call;
}

test('a GET names the snapshot by its full commit, after the app matched it against the list', async () => {
  const call = proxyWith();
  const r = await call('GET', '/api/atlas/node?path=hub%2Fapp.py&repo=Pi-Hub&commit=aaaaaaa');
  assert.equal(r.reply.status, 200);
  assert.equal(r.upstream.url.pathname, '/api/atlas/node');
  assert.equal(r.upstream.url.searchParams.get('path'), 'hub/app.py');
  assert.equal(r.upstream.url.searchParams.get('repo'), 'pi-hub');
  assert.equal(r.upstream.url.searchParams.get('commit'), A);
  assert.equal(r.upstream.timeoutMs, 60000);

  const latest = await call('GET', '/api/atlas/summary');
  assert.equal(latest.upstream.url.search, '');
  assert.equal(latest.upstream.timeoutMs, 10000);
});

test('an unknown, half-given, ambiguous or unlisted snapshot never reaches the service', async () => {
  const call = proxyWith();
  const cases = [
    ['/api/atlas/summary?repo=netmon&commit=aaaaaaa', 404, 'atlas_repo_unknown'],
    ['/api/atlas/findings?repo=pi-hub', 400, 'atlas_snapshot_query'],
    ['/api/atlas/findings?commit=aaaaaaa', 400, 'atlas_snapshot_query'],
    ['/api/atlas/summary?repo=pi-hub&commit=..%2F..%2Fetc', 400, 'atlas_commit_invalid'],
    ['/api/atlas/summary?repo=print-lab&commit=abcdddd', 404, 'atlas_snapshot_missing'],
    ['/api/atlas/summary?repo=print-lab&commit=ab' + 'c'.repeat(4) + 'd', 404, 'atlas_snapshot_missing'],
  ];
  for (const [url, status, code] of cases) {
    const r = await call('GET', url);
    assert.equal(r.calls, 0, url);
    assert.equal(r.reply.status, status, url);
    assert.equal(r.reply.payload.error.code, code, url);
  }
  const ambiguous = await call('GET', '/api/atlas/summary?repo=print-lab&commit=' + 'ab' + 'c'.repeat(5));
  assert.equal(ambiguous.reply.status, 200);  // a unique abbreviation is fine
  assert.equal(ambiguous.upstream.url.searchParams.get('commit'), B);
});

test('a POST carries the full commit in its body, and an unscoped one carries neither field', async () => {
  const scoped = await proxyWith({ question: 'why?', repo: 'pi-hub', commit: 'aaaaaaaa' })('POST', '/api/atlas/goose');
  assert.deepEqual(scoped.upstream.body, { question: 'why?', repo: 'pi-hub', commit: A });
  assert.equal(scoped.upstream.timeoutMs, 60000);
  const ask = await proxyWith({ question: 'why?', repo: 'pi-hub', commit: 'aaaaaaa' })('POST', '/api/atlas/ask');
  assert.equal(ask.upstream.timeoutMs, 315000);
  const plain = await proxyWith({ question: 'why?', repo: '', commit: '' })('POST', '/api/atlas/ask');
  assert.deepEqual(plain.upstream.body, { question: 'why?' });
  const refused = await proxyWith({ question: 'why?', repo: 'pi-hub', commit: 'f'.repeat(40) })('POST', '/api/atlas/ask');
  assert.equal(refused.calls, 0);
  assert.equal(refused.reply.status, 404);
  const odd = await proxyWith(['not', 'an', 'object'])('POST', '/api/atlas/ask');
  assert.deepEqual(odd.upstream.body, {});
});

function sh(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

// A repository whose only test runs a script by name (no import): that evidence needs the test file's text.
function fixture() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-src-'));
  sh(work, 'init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(work, 'hub'));
  fs.mkdirSync(path.join(work, 'tests'));
  fs.writeFileSync(path.join(work, 'hub', 'backup_runner.py'), 'X = 1\n');
  fs.writeFileSync(path.join(work, 'tests', 'test_backup.py'), 'subprocess.run(["python", "hub/backup_runner.py"])\n');
  sh(work, 'add', '-A'); sh(work, 'commit', '-q', '-m', 'one');
  const commit = sh(work, 'rev-parse', 'HEAD');
  const mirrors = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-mirrors-'));
  sh(mirrors, 'clone', '-q', '--mirror', work, path.join(mirrors, 'pi-hub.git'));
  const snapshots = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-snaps-'));
  const graph = {
    generatedAt: '2026-11-01T00:00:00Z', stats: { files: 2 }, domains: [], edges: [],
    nodes: [
      { id: 'hub/backup_runner.py', label: 'backup_runner.py', domain: 'Hub', risk: 40, fanIn: 0, fanOut: 0, testRefs: 0 },
      { id: 'tests/test_backup.py', label: 'test_backup.py', domain: 'Tests', risk: 0, fanIn: 0, fanOut: 0, testRefs: 0 },
    ],
    snapshot: { repo: 'pi-hub', commit },
  };
  fs.mkdirSync(path.join(snapshots, 'pi-hub', commit), { recursive: true });
  fs.writeFileSync(path.join(snapshots, 'pi-hub', commit, 'graph.json'), JSON.stringify(graph));
  return { work, commit, mirrors, snapshots, trees: fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-trees-')) };
}

function py(code) {
  const r = spawnSync(PY, ['-I', '-c', `
import json, sys, pathlib
sys.path.insert(0, ${JSON.stringify(ROOT)})
import atlas_intelligence as m
${code}`], { encoding: 'utf8', timeout: 120000 });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

test('the service reads the snapshot graph and a clean copy of its commit, never the deploy checkout', { skip: !PY || !GIT }, () => {
  const f = fixture();
  const out = py(`
trees = m.SnapshotTrees(trees=pathlib.Path(${JSON.stringify(f.trees)}), mirrors=pathlib.Path(${JSON.stringify(f.mirrors)}))
state = m.AtlasState(m.ATLAS_HTML, snapshots=pathlib.Path(${JSON.stringify(f.snapshots)}), trees=trees)
graph, findings, root, scope = state.for_snapshot('pi-hub', ${JSON.stringify(f.commit)})
details = m.get_node_details(graph, findings, 'hub/backup_runner.py', root)
none = m.get_node_details(graph, findings, 'hub/backup_runner.py', None)
m.INVESTIGATION_DIR = m.ROOT / '.atlas' / 'investigations-pr5-test'
brief = m.build_goose_brief(graph=graph, findings=findings, question='q', root=root, scope=scope)
(m.ROOT / brief['briefPath']).unlink()
m.INVESTIGATION_DIR.rmdir()
codes = []
for repo, commit in [('pi-hub', 'aaaaaaa'), ('../pi-hub', ${JSON.stringify(f.commit)}), ('pi-hub', 'f' * 40)]:
    try: state.for_snapshot(repo, commit); codes.append('accepted')
    except m.AtlasError as e: codes.append([e.code, e.status])
print(json.dumps({'root': str(root), 'scope': scope, 'files': sorted(p.name for p in root.rglob('*.py')),
  'evidence': details['node'].get('testEvidence'), 'noSource': none['node'].get('testEvidence'),
  'prompt': brief['prompt'][:400], 'codes': codes, 'sameRoot': str(m.ROOT) in str(root)}))`);
  assert.deepEqual(out.scope, { repo: 'pi-hub', commit: f.commit, source: 'available' });
  assert.equal(out.root, path.join(f.trees, 'pi-hub', f.commit));
  assert.equal(out.sameRoot, false);
  assert.deepEqual(out.files, ['backup_runner.py', 'test_backup.py']);
  assert.ok(out.evidence.length >= 1, 'the test that runs the script by name counts once its text is read');
  assert.deepEqual(out.noSource, []);
  assert.match(out.prompt, new RegExp(`pi-hub repository at commit ${f.commit}`));
  assert.match(out.prompt, /clean copy at `.*atlas-trees-/);
  assert.deepEqual(out.codes, [['atlas_snapshot_query', 400], ['atlas_snapshot_query', 400], ['atlas_snapshot_missing', 404]]);
});

test('without a mirror the snapshot still answers from its graph, and says why its source is missing', { skip: !PY || !GIT }, () => {
  const f = fixture();
  const out = py(`
trees = m.SnapshotTrees(trees=pathlib.Path(${JSON.stringify(f.trees)}), mirrors=pathlib.Path(${JSON.stringify(f.trees)}) / 'none')
state = m.AtlasState(m.ATLAS_HTML, snapshots=pathlib.Path(${JSON.stringify(f.snapshots)}), trees=trees)
graph, findings, root, scope = state.for_snapshot('pi-hub', ${JSON.stringify(f.commit)})
print(json.dumps({'root': root, 'scope': scope, 'nodes': len(graph['nodes']), 'findings': isinstance(findings, list)}))`);
  assert.equal(out.root, null);
  assert.equal(out.scope.source, 'unavailable');
  assert.match(out.scope.reason, /no mirror of pi-hub/);
  assert.equal(out.nodes, 2);
  assert.equal(out.findings, true);
});

test('clean copies are kept for the newest three snapshots used', { skip: !PY || !GIT }, () => {
  const f = fixture();
  const commits = [f.commit];
  for (let i = 0; i < 3; i += 1) {
    fs.writeFileSync(path.join(f.work, 'hub', `m${i}.py`), 'Y = 1\n');
    sh(f.work, 'add', '-A'); sh(f.work, 'commit', '-q', '-m', `c${i}`);
    commits.push(sh(f.work, 'rev-parse', 'HEAD'));
  }
  sh(path.join(f.mirrors, 'pi-hub.git'), 'fetch', '-q', 'origin');
  const out = py(`
import time
trees = m.SnapshotTrees(trees=pathlib.Path(${JSON.stringify(f.trees)}), mirrors=pathlib.Path(${JSON.stringify(f.mirrors)}))
for c in ${JSON.stringify(commits)}:
    root, reason = trees.get('pi-hub', c); assert root, reason; time.sleep(0.02)
print(json.dumps(sorted(p.name for p in (pathlib.Path(${JSON.stringify(f.trees)}) / 'pi-hub').iterdir())))`);
  assert.deepEqual(out, commits.slice(1).sort());
});
