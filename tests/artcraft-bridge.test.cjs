'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// ArtCraft's status and open routes in the GridCraft bridge (host/gridcraft-bridge.py), loaded as a module.
const bridge = path.resolve(__dirname, '../host/gridcraft-bridge.py');
const python = ['python3', 'python'].find(cmd => spawnSync(cmd, ['--version']).status === 0);

test('ArtCraft: the bridge reports installed and running, and opens only its fixed exe', { skip: !python && 'no python' }, () => {
  const fs = require('node:fs'), os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artcraft-'));
  const exe = path.join(dir, 'artcraft.exe');
  // Process checks and launches are replaced, so nothing real runs: each case says whether ArtCraft is running.
  const code = `import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('bridge', sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
launched = []
m.subprocess.Popen = lambda args, **kw: launched.append(args)
out = []
for running in json.loads(sys.stdin.read()):
    m.process_running = lambda name, r=running: r
    out.append([m.artcraft_status(), list(m.open_artcraft())])
print(json.dumps({'out': out, 'launched': launched}))`;
  const run = cases => {
    const r = spawnSync(python, ['-I', '-c', code, bridge], { input: JSON.stringify(cases), encoding: 'utf8', env: { ...process.env, ARTCRAFT_EXE: exe } });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  try {
    const missing = run([false]);
    assert.deepEqual(missing.out[0][0], { ok: true, installed: false, running: false, version: null });
    assert.equal(missing.out[0][1][0], 404);
    assert.deepEqual(missing.launched, []);

    fs.writeFileSync(exe, 'x');
    const { out, launched } = run([false, true]);
    for (const [status] of out) assert.deepEqual(Object.keys(status).sort(), ['installed', 'ok', 'running', 'version']);
    assert.equal(out[0][0].installed, true);
    assert.equal(out[0][0].running, false);
    assert.deepEqual(out[0][1], [200, { ok: true, alreadyRunning: false }]);
    assert.equal(out[1][0].running, true);
    assert.deepEqual(out[1][1], [200, { ok: true, alreadyRunning: true }]);
    assert.deepEqual(launched, [[exe]], 'launched once, the configured exe with no arguments');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
