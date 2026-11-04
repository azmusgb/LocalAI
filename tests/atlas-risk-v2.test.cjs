'use strict';

// System Atlas risk, rebuilt (Atlas redesign spec, PR 2). Risk is made of reach (how many production modules depend on
// a module, directly or not), fan-out and fan-in, and each test that imports the module lowers it. The score ships with
// its parts (`riskParts: {reach, out, in, tested}`), so the page can say why. Tests can only lower risk.
// Also from draft #482: numeric strings in a graph read as numbers, and Ask checks the question before it loads a snapshot.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PY = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);

function py(code) {
  const r = spawnSync(PY, ['-I', '-c', code], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

const LOAD = (name, file) => `
import importlib.util, json, pathlib, sys, tempfile
sys.path.insert(0, ${JSON.stringify(ROOT)})
spec = importlib.util.spec_from_file_location(${JSON.stringify(name)}, ${JSON.stringify(path.join(ROOT, file))})
qa = importlib.util.module_from_spec(spec); spec.loader.exec_module(qa)
`;

// c.js uses b.js, b.js uses a.js; one test imports a.js and another imports c.js.
const FIXTURE = {
  'app/a.js': 'module.exports = 1;\n',
  'app/b.js': "require('./a');\n",
  'app/c.js': "require('./b');\n",
  'tests/a.test.cjs': "require('../app/a');\n",
  'tests/c.test.cjs': "require('../app/c');\n",
};

test('adding a test that imports a module never raises its risk, and each one lowers it', { skip: !PY }, () => {
  const out = py(`${LOAD('qa', 'quick_arch.py')}
rows = []
for reach in (0, 1, 3, 10, 40):
    for inbound in (0, 1, 5, 20):
        for outbound in (0, 2, 10, 68):
            scores = [qa.risk_score(reach=reach, inbound=inbound, outbound=outbound, test_refs=t)["risk"] for t in range(0, 30)]
            rows.append(scores)
print(json.dumps(rows))`);
  for (const scores of out) {
    for (let t = 1; t < scores.length; t += 1) assert.ok(scores[t] <= scores[t - 1], `a test raised risk: ${scores}`);
    if (scores[0] >= 10) assert.ok(scores[1] < scores[0], `the first test did not lower risk: ${scores}`);
  }
});

test('each node carries its reach and the parts its risk is made of', { skip: !PY }, () => {
  const g = py(`${LOAD('qa', 'quick_arch.py')}
tmp = pathlib.Path(tempfile.mkdtemp()).resolve(); qa.ROOT = tmp
for name, text in json.loads(${JSON.stringify(JSON.stringify(FIXTURE))}).items():
    f = tmp / name; f.parent.mkdir(parents=True, exist_ok=True); f.write_text(text, encoding='utf-8')
print(json.dumps(qa.build_graph(qa.collect_files())))`);
  const node = (id) => g.nodes.find((n) => n.id === id);
  const a = node('app/a.js');
  assert.equal(a.reach, 2, 'b.js directly and c.js through b.js');
  assert.equal(a.testRefs, 1);
  assert.equal(a.inbound, 2, 'inbound still counts every importer, the test included');
  for (const n of g.nodes.filter((x) => x.domain !== 'Tests')) {
    const p = n.riskParts;
    assert.deepEqual(Object.keys(p).sort(), ['in', 'out', 'reach', 'tested']);
    assert.ok(p.reach >= 0 && p.out >= 0 && p.in >= 0 && p.tested <= 0, JSON.stringify(p));
    assert.equal(n.risk, Math.min(100, p.reach + p.out + p.in) + p.tested, `${n.id} risk is its parts`);
  }
  assert.ok(a.riskParts.tested < 0, 'the test that imports a.js lowers its risk');
  assert.equal(node('app/b.js').riskParts.tested, 0);
  assert.equal(node('app/c.js').reach, 0);
});

test('on this repository, server.js stays critical and storage.js drops below high', { skip: !PY }, () => {
  const out = py(`${LOAD('qa', 'quick_arch.py')}
g = qa.build_graph(qa.collect_files())
print(json.dumps({n['id']: [n['risk'], n['riskLevel'], n['testRefs']] for n in g['nodes'] if n['id'] in ('app/server.js', 'app/storage.js')}))`);
  assert.equal(out['app/server.js'][1], 'critical', JSON.stringify(out));
  assert.equal(out['app/server.js'][2], 0);
  assert.ok(['low', 'medium'].includes(out['app/storage.js'][1]), JSON.stringify(out));
  assert.ok(out['app/storage.js'][2] >= 20, 'storage.js is among the most tested modules');
});

test('numbers in a graph read the same whether they arrive as numbers or as strings', { skip: !PY }, () => {
  const out = py(`${LOAD('atlas_intelligence', 'atlas_intelligence.py')}
print(json.dumps([qa._as_int('85.5'), qa._as_int(85.0), qa._as_int('42'), qa._as_int(None, 10), qa._as_int('x', 5),
  qa._as_int(' 7 '), qa._as_int(True)]))`);
  assert.deepEqual(out, [85, 85, 42, 10, 5, 7, 0]);
});

test('Ask refuses an empty question before it loads the snapshot', { skip: !PY }, () => {
  const none = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-none-'));
  const out = py(`${LOAD('atlas_intelligence', 'atlas_intelligence.py')}
import threading, urllib.request, urllib.error
qa.ATLAS_TOKEN = 'secret-for-test'
srv = qa.ThreadingHTTPServer(('127.0.0.1', 0), qa.AtlasHandler)
srv.atlas_state = qa.AtlasState(qa.ATLAS_HTML, snapshots=pathlib.Path(${JSON.stringify(none)}))
threading.Thread(target=srv.serve_forever, daemon=True).start()
base = f'http://127.0.0.1:{srv.server_address[1]}'
def post(p, body):
    req = urllib.request.Request(base + p, data=json.dumps(body).encode(), method='POST',
        headers={'Content-Type': 'application/json', 'X-Atlas-Token': 'secret-for-test'})
    try:
        with urllib.request.urlopen(req, timeout=5) as r: return [r.status, None]
    except urllib.error.HTTPError as e: return [e.code, (json.loads(e.read() or b'{}').get('error') or {}).get('code')]
snap = {'repo': 'pi-hub', 'commit': 'a' * 40}
res = {'empty': post('/api/atlas/ask', {**snap, 'question': '  '}),
       'long': post('/api/atlas/goose', {**snap, 'question': 'x' * (qa.MAX_QUESTION_CHARS + 1)}),
       'asked': post('/api/atlas/ask', {**snap, 'question': 'why?'}),
       'unknown': post('/api/atlas/nope', {**snap, 'question': 'why?'})}
srv.shutdown()
print(json.dumps(res))`);
  assert.deepEqual(out.empty, [400, 'question_required']);
  assert.deepEqual(out.long, [400, 'question_too_long']);
  assert.deepEqual(out.asked, [404, 'atlas_snapshot_missing'], 'a real question still reaches the snapshot');
  assert.equal(out.unknown[0], 404);
});
