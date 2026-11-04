'use strict';

// System Atlas scanner v2 (Atlas redesign spec, PR 1): graph.json schemaVersion 2, a typed `kind` on every edge
// (import, http, test), browser-to-route HTTP links for LocalAI, and `danglingHttp` for calls nothing serves.
// The tests drive quick_arch.py against a fixture repository: two browser scripts, two server modules, one dangling call.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PY = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);
const GIT = spawnSync('git', ['--version']).status === 0;

const FIXTURE = {
  'app/server.js': [
    "const items = require('./server/items');",
    "async function route(req, p) {",
    "  if (p === '/api/health') return ok();",
    "  if (p.startsWith('/api/items/')) return items.api(req, p);",
    "  if (['/api/reset', '/api/reboot'].includes(p)) return ok();",
    "  const m = p.match(/^\\/api\\/jobs\\/([\\w-]+)\\/(keep|drop)$/); if (m) return ok();",
    "  if (p.startsWith('/api/')) return notFound();",
    "}",
  ].join('\n'),
  'app/server/items.js': [
    "const table = new Map([",
    "  ['/api/items/table', '/internal/table'],",
    "]);",
    "function api(req, p) {",
    "  if (p === '/api/items/list') return [];",
    "  return fetch('/api/upstream/items');  // a call this server makes, not a route it serves",
    "}",
    "module.exports = { api };",
  ].join('\n'),
  'app/public/home.js': [
    "fetch('/api/health');",
    "fetch('/api/health?verbose=1');",
    "fetch(`/api/items/${id}?full=1`);",
    "fetch('/api/items/' + id);",
    "// fetch('/api/commented-out')",
  ].join('\n'),
  'app/public/work.js': [
    "const r = await api('/api/items/list');",
    "new EventSource('/api/missing/stream');",
    "fetch(`/api/jobs/${id}/keep`, { method: 'POST' });",
    "fetch('/api/reset', { method: 'POST' });",
    "fetch('/api/items/table');",
    "fetch(\"/api/jobs/${id}\");",
    "const API = '/api/items';",
    "fetch(`${API}/list`); fetch(API + '/' + id);",
  ].join('\n'),
  'tests/items.test.cjs': "const items = require('../app/server/items');\n",
};

function py(code) {
  const r = spawnSync(PY, ['-I', '-c', code], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

const LOAD = `
import importlib.util, json, os, pathlib, sys, tempfile
spec = importlib.util.spec_from_file_location('qa', ${JSON.stringify(path.join(ROOT, 'quick_arch.py'))})
qa = importlib.util.module_from_spec(spec); spec.loader.exec_module(qa)
tmp = pathlib.Path(tempfile.mkdtemp()).resolve(); qa.ROOT = tmp
def w(p, s=''):
    f = tmp / p; f.parent.mkdir(parents=True, exist_ok=True); f.write_text(s, encoding='utf-8')
for name, text in json.loads(${JSON.stringify(JSON.stringify(FIXTURE))}).items():
    w(name, text)
`;

function scan() {
  return py(`${LOAD}
print(json.dumps(qa.build_graph(qa.collect_files())))`);
}

const edge = (g, source, target, kind) => g.edges.find((e) => e.source === source && e.target === target && e.kind === kind);

test('the graph is schema version 2 and every edge carries a kind', { skip: !PY }, () => {
  const g = scan();
  assert.equal(g.schemaVersion, 2);
  assert.ok(g.edges.length > 0);
  for (const e of g.edges) assert.ok(['import', 'http', 'test'].includes(e.kind), `edge ${e.source} -> ${e.target} has kind ${e.kind}`);
  assert.ok(edge(g, 'app/server.js', 'app/server/items.js', 'import'));
  assert.ok(edge(g, 'tests/items.test.cjs', 'app/server/items.js', 'test'), 'an edge from the Tests domain is a test edge');
});

test('a browser module links to the server module owning the longest matching route', { skip: !PY }, () => {
  const g = scan();
  const http = g.edges.filter((e) => e.kind === 'http');
  const pairs = http.map((e) => `${e.source} -> ${e.target}`).sort();
  assert.deepEqual(pairs, [
    'app/public/home.js -> app/server.js',
    'app/public/work.js -> app/server.js',
    'app/public/work.js -> app/server/items.js',
  ]);
  const home = edge(g, 'app/public/home.js', 'app/server.js', 'http');
  assert.deepEqual(home.paths, ['/api/health', '/api/items/']);  // a query string is dropped, a dynamic tail keeps its prefix
  const work = edge(g, 'app/public/work.js', 'app/server/items.js', 'http');
  // The exact route in items.js beats the /api/items/ prefix in server.js; a constant API = '/api/items' is a base, so
  // `${API}/list` is read as /api/items/list and the bare base only says "starts with" (items.js extends it).
  assert.deepEqual(work.paths, ['/api/items', '/api/items/list', '/api/items/table']);  // a route-table row is a route
  const workServer = edge(g, 'app/public/work.js', 'app/server.js', 'http');
  assert.deepEqual(workServer.paths, ['/api/items/', '/api/jobs/', '/api/reset']);  // a list in .includes(p) and a regex route both count
});

test('a browser path nothing serves is a dangling finding, with no false positives', { skip: !PY }, () => {
  const g = scan();
  assert.deepEqual(g.danglingHttp, [{ source: 'app/public/work.js', path: '/api/missing/stream', line: 2 }]);
  // The catch-all p.startsWith('/api/'), a server's own outgoing call and a commented-out call are not routes or calls.
  assert.ok(!g.danglingHttp.some((d) => d.path === '/api/commented-out'));
  assert.equal(g.stats.danglingHttp, 1);
  assert.equal(g.stats.httpLinks, 3);
});

test('HTTP links do not change the scores: counts and risk come from import and test edges only', { skip: !PY }, () => {
  const g = scan();
  const items = g.nodes.find((n) => n.id === 'app/server/items.js');
  assert.equal(items.inbound, 2);  // server.js and the test; the browser's HTTP call is not an import
  const server = g.nodes.find((n) => n.id === 'app/server.js');
  assert.equal(server.inbound, 0);
  assert.equal(g.stats.relationships, g.edges.filter((e) => e.kind !== 'http').length);
});

test('the server routes the scanner found are listed with their owner', { skip: !PY }, () => {
  const g = scan();
  const byPath = Object.fromEntries(g.httpRoutes.map((r) => [r.path, r]));
  assert.equal(byPath['/api/health'].module, 'app/server.js');
  assert.equal(byPath['/api/items/'].match, 'prefix');
  assert.equal(byPath['/api/items/list'].module, 'app/server/items.js');
  assert.equal(byPath['/api/jobs/*/*'].match, 'pattern');
  assert.ok(!byPath['/api/'], 'the catch-all prefix would hide every dangling call');
  assert.ok(!byPath['/api/upstream/items'], 'a path a server calls is not a route it serves');
});

test('a repository with no browser or server modules gets schema 2 with no HTTP links', { skip: !PY }, () => {
  const out = py(`${LOAD}
import shutil
shutil.rmtree(tmp / 'app'); w('lib/a.py', 'import b\\n'); w('lib/b.py')
g = qa.build_graph(qa.collect_files())
print(json.dumps({'v': g['schemaVersion'], 'kinds': sorted({e['kind'] for e in g['edges']}), 'dangling': g['danglingHttp'], 'routes': g['httpRoutes']}))`);
  assert.equal(out.v, 2);
  assert.deepEqual(out.dangling, []);
  assert.deepEqual(out.routes, []);
});

test('snapshot mode writes the v2 graph.json from a clean copy of the commit', { skip: !PY || !GIT }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-v2-'));
  const repo = path.join(dir, 'repo');
  for (const [name, text] of Object.entries(FIXTURE)) {
    fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
    fs.writeFileSync(path.join(repo, name), text);
  }
  const git = (...a) => spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
  assert.equal(spawnSync('git', ['init', '-q', repo]).status, 0);
  git('add', '-A');
  assert.equal(git('commit', '-q', '-m', 'fixture').status, 0);
  const snaps = path.join(dir, 'snaps');
  const r = spawnSync(PY, ['-I', path.join(ROOT, 'quick_arch.py'), '--repo', 'fixture', '--git-dir', path.join(repo, '.git'), '--commit', 'HEAD'],
    { encoding: 'utf8', timeout: 60000, env: { ...process.env, ATLAS_SNAPSHOTS: snaps } });
  assert.equal(r.status, 0, r.stderr);
  const commit = git('rev-parse', 'HEAD').stdout.trim();
  const g = JSON.parse(fs.readFileSync(path.join(snaps, 'fixture', commit, 'graph.json'), 'utf8'));
  assert.equal(g.schemaVersion, 2);
  assert.equal(g.danglingHttp.length, 1);
  assert.equal(g.snapshot.repo, 'fixture');
  assert.ok(g.edges.every((e) => e.kind));
});
