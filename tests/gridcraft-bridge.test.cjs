'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const bridge = path.resolve(__dirname, '../host/gridcraft-bridge.py');
const python = ['python3', 'python'].find(cmd => spawnSync(cmd, ['--version']).status === 0);

// Loads the bridge as a module (its server only starts under __main__) and runs failure_reason on each case.
function reasons(cases) {
  const code = `import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('bridge', sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps([m.failure_reason(o, e) for o, e in json.loads(sys.stdin.read())]))`;
  const r = spawnSync(python, ['-I', '-c', code, bridge], { input: JSON.stringify(cases), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('a failed GridCraft run says why', { skip: !python && 'no python' }, () => {
  const traceback = 'Traceback (most recent call last):\n  File "gridcraft_ai.py", line 9\nhttpx.ConnectError: [WinError 10061] connection refused\n';
  assert.deepEqual(reasons([
    ['[agent] thinking\n', traceback],
    ['[agent] step 1\nModel returned no tool call\n', ''],
    ['', 'RuntimeError: ' + 'x'.repeat(500)],
    ['', ''],
  ]), [
    'httpx.ConnectError: [WinError 10061] connection refused',
    'Model returned no tool call',
    ('RuntimeError: ' + 'x'.repeat(500)).slice(0, 300),
    '',
  ]);
});
