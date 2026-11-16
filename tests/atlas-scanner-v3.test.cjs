'use strict';

// System Atlas scanner v3 (spec 2026-11-07-atlas-across-repos-design.md, PR 2):
// graph.json schemaVersion 3, outgoing `calls` on every node across JavaScript, Python, and shell,
// and backward compatibility loading schema 2 graphs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PY = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);

function runScan(files, repo = null) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-v3-')));
  try {
    for (const [relPath, content] of Object.entries(files)) {
      const full = path.join(dir, relPath);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(ROOT)})
import quick_arch as qa
qa.ROOT = qa.Path(${JSON.stringify(dir)}).resolve()
qa.SNAPSHOT = ${repo ? `{'repo': ${JSON.stringify(repo)}, 'commit': 'a' * 40, 'committedAt': None, 'changedSince': None, 'gitDir': None}` : 'None'}
files = qa.collect_files()
graph = qa.build_graph(files)
print(json.dumps(graph))
`;
    const res = spawnSync(PY, ['-c', script], { encoding: 'utf8' });
    if (res.status !== 0) throw new Error(res.stderr || res.stdout);
    return JSON.parse(res.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the graph is schema version 3 and nodes carry outgoing /api/ calls', () => {
  const files = {
    'app/server/hub.js': [
      "const url = new URL('/api/records', hubUrl);",
      "const other = fetch('/api/now/poster/1.jpg');",
      "// const fake = fetch('/api/commented');",
      "module.exports = {};",
    ].join('\n'),
    'src/client.py': [
      "import urllib.request",
      "hub_url = 'http://10.0.0.80'",
      "req = urllib.request.Request(f'{hub_url}/api/records')",
      "def get_needs():",
      "    return urllib.request.Request('/api/needs')",
      "# req2 = urllib.request.Request('/api/ignored')",
    ].join('\n'),
  };

  const g = runScan(files);
  assert.equal(g.schemaVersion, 3);

  const jsNode = g.nodes.find((n) => n.id === 'app/server/hub.js');
  assert.ok(jsNode, 'hub.js node exists');
  assert.deepEqual(
    jsNode.calls.map((c) => c.path),
    ['/api/records', '/api/now/poster/1.jpg']
  );
  assert.equal(jsNode.calls[0].line, 1);
  assert.equal(jsNode.calls[1].line, 2);

  const pyNode = g.nodes.find((n) => n.id === 'src/client.py');
  assert.ok(pyNode, 'client.py node exists');
  assert.deepEqual(
    pyNode.calls.map((c) => c.path),
    ['/api/records', '/api/needs']
  );
  assert.equal(pyNode.calls[0].line, 3);
  assert.equal(pyNode.calls[1].line, 5);
});

test('nodes without calls have an empty calls list', () => {
  const files = {
    'app/pure.js': 'module.exports = 42;\n',
    'lib/util.py': 'def foo(): pass\n',
  };
  const g = runScan(files);
  assert.equal(g.schemaVersion, 3);
  for (const n of g.nodes) {
    assert.deepEqual(n.calls, []);
  }
});

test('smart display profile: .py and .js are mapped, firmware sources go to skipped', () => {
  const g = runScan({
    'app.js': "module.exports = {};\n",
    'apply_x.py': "def f():\n    return 1\n",
    'src/main.cpp': 'int main() { return 0; }\n',
    'include/a.h': '#pragma once\n',
    'sketch/s.ino': 'void setup() {}\n',
  }, 'bambuhelper-smart-display');
  assert.deepEqual(g.nodes.map((n) => n.path).sort(), ['app.js', 'apply_x.py']);
  assert.deepEqual(g.skipped, [
    { path: 'include/a.h', reason: 'firmware source, not parsed' },
    { path: 'sketch/s.ino', reason: 'firmware source, not parsed' },
    { path: 'src/main.cpp', reason: 'firmware source, not parsed' },
  ]);
});

test('other repos keep every file mapped and carry an empty skipped list', () => {
  const g = runScan({ 'a.js': 'module.exports = {};\n', 'src/main.cpp': 'int main() {}\n' });
  assert.deepEqual(g.skipped, []);
  assert.deepEqual(g.nodes.map((n) => n.path), ['a.js']);
  const pi = runScan({ 'a.js': 'module.exports = {};\n', 'src/main.cpp': 'int main() {}\n' }, 'pi-hub');
  assert.deepEqual(pi.skipped, []);
});
