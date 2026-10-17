'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');

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

test('the journal line is read from stderr and is never the failure reason', { skip: !python && 'no python' }, () => {
  const code = `import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('bridge', sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
err = 'RuntimeError: Stopped after 12 tool rounds\\n[journal] {"mode": "review", "undoSteps": 2}\\n'
print(json.dumps([m.parse_journal(err), m.failure_reason('', err), m.parse_journal('no journal'), m.without_journal(err)]))`;
  const r = spawnSync(python, ['-I', '-c', code, bridge], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), [{ mode: 'review', undoSteps: 2 }, 'RuntimeError: Stopped after 12 tool rounds', null, 'RuntimeError: Stopped after 12 tool rounds']);
});

test('the bridge passes the mode, returns the journal, and runs workbook, keep and discard', { skip: !python && 'no python', timeout: 30000 }, async t => {
  const fs = require('node:fs');
  const os = require('node:os');
  const net = require('node:net');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gridcraft-bridge-'));
  // A stand-in agent and ops helper: they echo what they were given.
  fs.writeFileSync(path.join(dir, 'agent.py'), `import sys, json
mode = sys.argv[sys.argv.index('--mode') + 1]
print('[agent] model returned final text.'); print('answer for ' + mode)
print('[journal] ' + json.dumps({'mode': mode, 'edits': [], 'undoSteps': 0}), file=sys.stderr)
`);
  fs.writeFileSync(path.join(dir, 'gridcraft_ops.py'), `import sys, json
req = json.loads(sys.stdin.read() or '{}')
if sys.argv[1] == 'discard' and req.get('undoTop') != ['Enter Cell']:
    print(json.dumps({'ok': False, 'status': 409, 'error': 'The workbook changed'}))
else:
    print(json.dumps({'ok': True, 'op': sys.argv[1], 'req': req}))
`);
  const control = net.createServer(s => s.end()).listen(0, '127.0.0.1');
  await once(control, 'listening');
  const port = await new Promise(res => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  const child = spawn(python, ['-I', bridge], { env: { ...process.env, GRIDCRAFT_BRIDGE_PORT: String(port), GRIDCRAFT_CONTROL_PORT: String(control.address().port), GRIDCRAFT_AGENT_PYTHON: spawnSync(python, ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).stdout.trim(), GRIDCRAFT_AGENT_SCRIPT: path.join(dir, 'agent.py'), GRIDCRAFT_AGENT_DIR: dir } });
  let log = ''; child.stderr.on('data', c => log += c); child.stdout.on('data', c => log += c);
  t.after(() => { child.kill(); control.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) { try { await fetch(base + '/health'); break; } catch { if (i > 100) throw new Error(log); await new Promise(r => setTimeout(r, 100)); } }
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  const review = await (await post('/run', { prompt: 'add a total', mode: 'review' })).json();
  assert.equal(review.answer, 'answer for review');
  assert.deepEqual(review.journal, { mode: 'review', edits: [], undoSteps: 0 });
  assert.equal((await (await post('/run', { prompt: 'x' })).json()).mode, 'apply', 'an older appliance that sends no mode gets the old behavior');
  assert.equal((await post('/run', { prompt: 'x', mode: 'admin' })).status, 400);

  const wb = await (await fetch(base + '/workbook?sheet=Sales&range=A1:C3&path=C:/x')).json();
  assert.deepEqual(wb, { ok: true, op: 'workbook', req: { sheet: 'Sales', range: 'A1:C3' } }, 'only sheet and range are passed on');
  assert.deepEqual((await (await post('/keep', { anything: 1 })).json()).req, {});
  const ok = await post('/discard', { steps: 2, undoTop: ['Enter Cell'], extra: 1 });
  assert.deepEqual((await ok.json()).req, { steps: 2, undoTop: ['Enter Cell'] });
  const conflict = await post('/discard', { steps: 2, undoTop: ['Bold'] });
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { ok: false, error: 'The workbook changed' });
});
