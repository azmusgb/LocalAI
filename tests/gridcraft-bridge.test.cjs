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

test('the bridge passes the mode, returns the journal, and runs workbook, keep, discard, workbooks, open and set_cell', { skip: !python && 'no python', timeout: 30000 }, async t => {
  const fs = require('node:fs');
  const os = require('node:os');
  const net = require('node:net');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gridcraft-bridge-'));
  // A stand-in agent and ops helper: they echo what they were given.
  fs.writeFileSync(path.join(dir, 'agent.py'), `import sys, json, time
mode = sys.argv[sys.argv.index('--mode') + 1]
if sys.argv[-1] == '--once=slow': time.sleep(1.5)
if sys.argv[-1] == '--once=steps':
    for line in ['[agent] model turn 1 ...', '[agent] tool call: read_range {"range": "Sales!A1:D4"}', '[agent] tool result: read_range -> {}',
                 '[agent] tool call: set_cell {"cell": "B7", "sheet": "Sales", "input": "5"}', '[agent] tool result: set_cell -> ERROR no such sheet']:
        print(line, flush=True); time.sleep(0.2)
    time.sleep(1)
print('[agent] model returned final text.'); print('answer for ' + mode)
print('[journal] ' + json.dumps({'mode': mode, 'edits': [], 'undoSteps': 0}), file=sys.stderr)
`);
  fs.writeFileSync(path.join(dir, 'gridcraft_ops.py'), `import sys, json, os
req = json.loads(sys.stdin.read() or '{}')
if sys.argv[1] == 'workbooks':
    print(json.dumps({'ok': True, 'op': 'workbooks', 'dir': os.environ.get('GRIDCRAFT_WORKBOOKS_DIR')}))
elif sys.argv[1] == 'discard' and req.get('undoTop') != ['Enter Cell']:
    print(json.dumps({'ok': False, 'status': 409, 'error': 'The workbook changed'}))
else:
    print(json.dumps({'ok': True, 'op': sys.argv[1], 'req': req}))
`);
  const control = net.createServer(s => s.end()).listen(0, '127.0.0.1');
  await once(control, 'listening');
  const port = await new Promise(res => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  const child = spawn(python, ['-I', bridge], { env: { ...process.env, GRIDCRAFT_BRIDGE_PORT: String(port), GRIDCRAFT_CONTROL_PORT: String(control.address().port), GRIDCRAFT_AGENT_PYTHON: spawnSync(python, ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).stdout.trim(), GRIDCRAFT_AGENT_SCRIPT: path.join(dir, 'agent.py'), GRIDCRAFT_AGENT_DIR: dir, GRIDCRAFT_WORKBOOK: path.join(dir, 'Books', 'Q.xlsx'), GRIDCRAFT_WORKBOOKS_DIR: '' } });
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

  const books = await (await fetch(base + '/workbooks')).json();
  assert.equal(books.op, 'workbooks');
  assert.equal(books.dir, path.join(dir, 'Books'), 'the folder is the one GRIDCRAFT_WORKBOOK is in');
  assert.deepEqual((await (await post('/open', { name: 'Budget.xlsx', path: 'C:/x' })).json()).req, { name: 'Budget.xlsx' }, 'only the name is passed on');
  const slow = post('/run', { prompt: 'slow', mode: 'read' });
  await new Promise(r => setTimeout(r, 400));
  const busy = await post('/open', { name: 'Budget.xlsx' });
  assert.equal(busy.status, 409);
  assert.equal((await busy.json()).error, 'GridCraft is busy with a request');
  const busyCell = await post('/cell', { sheet: 'Sales', cell: 'B2', input: '5' });
  assert.equal(busyCell.status, 409, 'a cell edit waits for no request');
  assert.match((await busyCell.json()).error, /busy with a request\. Change the cell when it finishes/);
  assert.equal((await slow).status, 200);
  // Progress: the steps of the running request, from the agent's log lines as they arrive.
  const stepping = post('/run', { prompt: 'steps', mode: 'review' });
  let live;
  for (let i = 0; i < 50; i++) { live = await (await fetch(base + '/progress')).json(); if (live.steps[1]?.failed) break; await new Promise(r => setTimeout(r, 100)); }
  assert.equal(live.running, true);
  assert.equal(live.turn, 1);
  assert.deepEqual(live.steps.map(x => [x.tool, x.text, !!x.failed]), [['read_range', 'Reading Sales!A1:D4', false], ['set_cell', 'Changing Sales!B7', true]]);
  assert.equal((await stepping).status, 200);
  const after = await (await fetch(base + '/progress')).json();
  assert.equal(after.running, false, 'not running once the request finished');
  assert.equal(after.steps.length, 2, "the last request's steps stay until the next starts");
  const cell = await (await post('/cell', { sheet: 'Sales', cell: 'B2', input: '=A1', prompt: 'x', path: 'C:/x' })).json();
  assert.deepEqual([cell.op, cell.req], ['set_cell', { sheet: 'Sales', cell: 'B2', input: '=A1' }], '/cell runs the set_cell op with only the sheet, cell and input');
  assert.equal((await fetch(base + '/cell', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' }, body: '{}' })).status, 403);
});

test('the workbook menu lists the GridCraft folder and opens only a bare file name in it', { skip: !python && 'no python' }, () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gridcraft-books-'));
  for (const f of ['Budget.xlsx', 'data.csv', 'Old.XLS', 'notes.txt', '~$Budget.xlsx']) fs.writeFileSync(path.join(dir, f), 'x');
  fs.mkdirSync(path.join(dir, 'Archive')); fs.writeFileSync(path.join(dir, 'Archive', 'Inner.xlsx'), 'x');
  fs.mkdirSync(path.join(dir, 'Folder.xlsx'));
  // Loads gridcraft_ops.py (it imports mcp only when it connects) and opens each name with a fake GridCraft.
  const code = `import asyncio, importlib.util, json, os, sys
sys.path.insert(0, os.path.dirname(sys.argv[1]))
spec = importlib.util.spec_from_file_location('ops', sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
calls = []
async def call(name, args):
    calls.append([name, args])
    return {}
out = {'list': asyncio.run(m.workbooks(None, {})), 'names': {}}
for name in json.loads(sys.stdin.read()):
    try:
        out['names'][str(name)] = asyncio.run(m.open_book(call, {'name': name}))
    except m.OpError as e:
        out['names'][str(name)] = e.status
out['calls'] = calls
print(json.dumps(out))`;
  const names = ['Budget.xlsx', 'data.csv', 'Old.XLS', '../Budget.xlsx', '..\\Budget.xlsx', 'Archive/Inner.xlsx', 'Archive\\Inner.xlsx', 'C:Budget.xlsx', '..', 'a..b.xlsx', 'notes.txt', 'Budget', 'Missing.xlsx', 'Folder.xlsx', '~$Budget.xlsx', '', null];
  try {
    const r = spawnSync(python, ['-I', '-c', code, path.resolve(__dirname, '../host/gridcraft-agent/gridcraft_ops.py')], { input: JSON.stringify(names), encoding: 'utf8', env: { ...process.env, GRIDCRAFT_WORKBOOKS_DIR: dir } });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.list.items.map(x => x.name), ['Budget.xlsx', 'data.csv', 'Old.XLS'], 'workbooks directly in the folder: no subfolders, lock files or other files');
    assert.deepEqual(Object.keys(out.list.items[0]).sort(), ['modified', 'name', 'size']);
    assert.equal(JSON.stringify(out.list).includes(dir), false, 'no host paths');
    assert.deepEqual(out.names, {
      'Budget.xlsx': { file: 'Budget.xlsx' }, 'data.csv': { file: 'data.csv' }, 'Old.XLS': { file: 'Old.XLS' },
      '../Budget.xlsx': 400, '..\\Budget.xlsx': 400, 'Archive/Inner.xlsx': 400, 'Archive\\Inner.xlsx': 400, 'C:Budget.xlsx': 400,
      '..': 400, 'a..b.xlsx': 400, 'notes.txt': 400, Budget: 400, 'Missing.xlsx': 404, 'Folder.xlsx': 404, '~$Budget.xlsx': 400, '': 400, None: 400,
    });
    assert.deepEqual(out.calls, ['Budget.xlsx', 'data.csv', 'Old.XLS'].map(n => ['open_workbook', { path: path.join(dir, n) }]), 'GridCraft is asked to open the file in the folder, and only for a good name');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the bridge task runs with normal rights, not elevated', () => {
  const fs = require('node:fs');
  const installer = fs.readFileSync(path.resolve(__dirname, '../deploy/Install-GridCraft-Bridge.ps1'), 'utf8');
  assert.match(installer, /New-ScheduledTaskPrincipal [^\n]*-RunLevel Limited/);
  assert.doesNotMatch(installer, /-RunLevel Highest/);
});
