'use strict';

// System Atlas hardening (review of 31 Oct 2026): sign-in for the routes that run a model or write files, the
// container reaching the host service without lifting the loopback rule, a graph that survives a rebuild, a scan that
// says when it is partial, and import resolution that doesn't drop or invent edges.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const { guarded } = require('../app/signin');
const { createAtlas, normalizeAtlasBaseUrl } = require('../app/server/atlas');

test('asking a model and writing a Goose brief need a signed-in device; reading the graph does not', () => {
  assert.equal(guarded('/api/atlas/ask', 'POST'), true);
  assert.equal(guarded('/api/atlas/goose', 'POST'), true);
  assert.equal(guarded('/api/atlas/graph', 'GET'), false);
  assert.equal(guarded('/api/atlas/summary', 'GET'), false);
});

test('the container may reach the host service by host.docker.internal without allowing any remote host', () => {
  assert.equal(normalizeAtlasBaseUrl('http://host.docker.internal:8765'), 'http://host.docker.internal:8765');
  assert.throws(() => normalizeAtlasBaseUrl('http://10.0.0.21:8765'), /loopback/);
  const compose = fs.readFileSync(path.join(ROOT, 'deploy/stack/compose.yml'), 'utf8');
  assert.doesNotMatch(compose, /LOCALAI_ATLAS_ALLOW_REMOTE:\s*\$\{LOCALAI_ATLAS_ALLOW_REMOTE:-1\}/);
  // A folder mount: a rebuilt graph replaces the file, which a single-file bind mount would never see.
  assert.match(compose, /\.atlas\/graph:\/atlas-graph:ro/);
});

function atlasWith(graphPath) {
  const sent = [];
  const atlas = createAtlas({
    graphPath,
    json: (res, status, body) => sent.push({ status, body }),
    readBody: async () => ({}),
    fetchWithTimeout: async () => { throw new Error('offline'); },
  });
  return { atlas, sent };
}

test('a graph that is mid-rewrite keeps serving the last good copy, marked stale', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-'));
  const file = path.join(dir, 'system-atlas.html');
  fs.writeFileSync(file, '<script>const DATA = {"nodes":[{"id":"a"}],"edges":[]};</script>');
  const { atlas, sent } = atlasWith(file);
  await atlas.apiAtlas({ method: 'GET', url: '/api/atlas/graph' }, {}, '/api/atlas/graph');
  assert.equal(sent[0].status, 200);
  fs.writeFileSync(file, '<script>const DATA = {"nodes":[{"id":');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(file, later, later);
  await atlas.apiAtlas({ method: 'GET', url: '/api/atlas/graph' }, {}, '/api/atlas/graph');
  assert.equal(sent[1].status, 200);
  assert.equal(sent[1].body.nodes[0].id, 'a');
  assert.equal(sent[1].body.stale, true);
});

test('a missing graph is a 503 that names the problem, not a crash', async () => {
  const { atlas, sent } = atlasWith(path.join(os.tmpdir(), 'no-such-atlas', 'system-atlas.html'));
  await atlas.apiAtlas({ method: 'GET', url: '/api/atlas/graph' }, {}, '/api/atlas/graph');
  assert.equal(sent[0].status, 503);
});

test('domain boxes on the map open with the keyboard, like file nodes', () => {
  const js = fs.readFileSync(path.join(ROOT, 'app/public/architecture.js'), 'utf8');
  assert.match(js, /closest\('\[data-atlas-domain\]'\)[\s\S]{0,200}keydown|keydown[\s\S]{0,400}data-atlas-domain/);
  assert.match(js, /ArrowRight/);  // the lens tabs move with the arrow keys
});

// --- Python engines --------------------------------------------------------------------------------------------
const PY = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);

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
`;

test('the scan skips .atlas backups and other tool folders, and says when it stopped early', { skip: !PY }, () => {
  const out = py(`${LOAD}
w('app/a.js'); w('.atlas/integration-backups/1/app/server.js'); w('.claude/x.js'); w('node_modules/m/i.js')
files = [qa.rel(f) for f in qa.collect_files()]
qa.MAX_FILES = 1; w('app/b.js'); qa.collect_files()
print(json.dumps({'files': files, 'truncated': qa.SCAN['truncated']}))`);
  assert.deepEqual(out.files, ['app/a.js']);
  assert.equal(out.truncated, true);
});

test('import resolution: dotted JS names, Python submodules and bare relative imports', { skip: !PY }, () => {
  const out = py(`${LOAD}
w('app/foo.service.js'); w('app/main.js', "import x from './foo.service';")
w('pkg/__init__.py'); w('pkg/sub.py'); w('pkg/app.py'); w('pkg/x.py')
w('use.py', 'from pkg import sub\\n'); w('pkg/rel.py', 'from . import x\\n')
known = set(qa.collect_files())
js = [qa.rel(p) for p in qa.parse_javascript(tmp/'app/main.js', known)]
use = sorted(qa.rel(p) for p in qa.parse_python(tmp/'use.py', known))
rel_ = sorted(qa.rel(p) for p in qa.parse_python(tmp/'pkg/rel.py', known))
print(json.dumps({'js': js, 'use': use, 'rel': rel_}))`);
  assert.deepEqual(out.js, ['app/foo.service.js']);
  assert.deepEqual(out.use, ['pkg/__init__.py', 'pkg/sub.py']);
  assert.deepEqual(out.rel, ['pkg/__init__.py', 'pkg/x.py']);  // never the unrelated pkg.py / app.py sibling
});

test('a git failure is reported, not shown as "nothing changed"', { skip: !PY }, () => {
  const out = py(`${LOAD}
qa.changed_files()
print(json.dumps({'gitError': qa.SCAN['gitError']}))`);
  assert.ok(out.gitError, 'a folder that is not a git repo must report gitError');
});

test('the graph is written atomically and cannot close its own <script>', { skip: !PY }, () => {
  const out = py(`${LOAD}
target = tmp / 'out' / 'system-atlas.html'
qa.write_output(target, qa.build_html({'nodes': [{'id': 'a</script><b>'}], 'edges': []}))
s = target.read_text(encoding='utf-8')
print(json.dumps({'closes': s.count('</script>'), 'leftovers': [p.name for p in target.parent.iterdir() if p != target]}))`);
  assert.deepEqual(out.leftovers, []);
  const html = fs.readFileSync(path.join(ROOT, 'quick_arch.py'), 'utf8');
  assert.ok(out.closes <= (html.match(/<\/script>/g) || []).length);  // only the page's own tags
});

test('a stalled Ollama read is an AtlasError, so the summary degrades instead of failing', { skip: !PY }, () => {
  const out = py(`
import importlib.util, json, socket, urllib.request
spec = importlib.util.spec_from_file_location('ai', ${JSON.stringify(path.join(ROOT, 'atlas_intelligence.py'))})
ai = importlib.util.module_from_spec(spec); spec.loader.exec_module(ai)
def boom(*a, **k): raise socket.timeout('timed out')
ai.urlopen = boom
try:
    ai.request_json('http://127.0.0.1:9/api/tags', timeout=1); kind = 'none'
except ai.AtlasError: kind = 'AtlasError'
except Exception as e: kind = type(e).__name__
print(json.dumps({'kind': kind}))`);
  assert.equal(out.kind, 'AtlasError');
});

test('the Python service refuses rebinding hosts, foreign origins, non-JSON posts and posts without the token', { skip: !PY }, () => {
  const out = py(`
import importlib.util, json, os, threading, urllib.request, urllib.error
os.environ['ATLAS_TOKEN'] = 'secret-for-test'
spec = importlib.util.spec_from_file_location('ai', ${JSON.stringify(path.join(ROOT, 'atlas_intelligence.py'))})
ai = importlib.util.module_from_spec(spec); spec.loader.exec_module(ai)
srv = ai.ThreadingHTTPServer(('127.0.0.1', 0), ai.AtlasHandler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
base = f'http://127.0.0.1:{srv.server_address[1]}'
def call(path, method='GET', headers=None, body=None):
    req = urllib.request.Request(base + path, data=body, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=5) as r: return r.status
    except urllib.error.HTTPError as e: return e.code
res = {
  'rebind': call('/health', headers={'Host': 'evil.example:8765'}),
  'foreignOrigin': call('/health', headers={'Origin': 'https://evil.example'}),
  'textPlain': call('/api/atlas/goose', 'POST', {'Content-Type': 'text/plain'}, b'{}'),
  'noToken': call('/api/atlas/goose', 'POST', {'Content-Type': 'application/json'}, b'{}'),
}
srv.shutdown()
print(json.dumps(res))`);
  assert.deepEqual(out, { rebind: 403, foreignOrigin: 403, textPlain: 415, noToken: 401 });
});
