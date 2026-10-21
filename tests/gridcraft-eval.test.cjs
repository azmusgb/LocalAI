'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// host/gridcraft-agent/gridcraft_eval.py: how a task's result is scored (mcp and openai stood in; they run on the host).
const agentDir = path.resolve(__dirname, '../host/gridcraft-agent');
const python = ['python3', 'python'].find(cmd => spawnSync(cmd, ['--version']).status === 0);

const CODE = String.raw`
import json, sys, types
sys.path.insert(0, sys.argv[1])
sys.modules['mcp'] = types.SimpleNamespace(Client=None, StdioServerParameters=None)
sys.modules['openai'] = types.SimpleNamespace(AsyncOpenAI=None)
import gridcraft_eval as E
T = {t['id']: t for t in json.load(open(E.TASKS, encoding='utf-8'))['tasks']}
none = {'undoSteps': 0, 'changes': [], 'saved': False}
out = {
  'sum ok': E.check(T['sum-q1'], 'The Q1 total is $304,820.', {}, {}, none),
  'sum wrong': E.check(T['sum-q1'], 'I have verified the total.', {}, {}, none),
  'growth pct': E.check(T['west-growth'], 'West grew 25.2% from Q1 to Q4.', {}, {}, none),
  'growth frac': E.check(T['west-growth'], 'Growth was 0.25.', {}, {}, none),
  'best': E.check(T['best-region'], 'Online, with 362,100.', {}, {}, none),
  'cells ok': E.check(T['north-q1'], '', {'Sales!C5': 50000.0, 'Sales!G5': 219220}, {}, {'undoSteps': 1, 'changes': []}),
  'cells wrong': E.check(T['north-q1'], '', {'Sales!C5': 48200.0, 'Sales!G5': 216080}, {}, {'undoSteps': 1, 'changes': []}),
  'formula missing': E.check(T['q1-total-formula'], '', {'Sales!B20': 'q1 total ', 'Sales!C20': 304820}, {'Sales!C20': 304820}, none),
  'cleared': E.check(T['clear-c17'], '', {'Sales!C17': ''}, {}, none),
  'bold': E.check(T['bold-header'], '', {}, {}, {'changes': [{'summary': 'Formatted B4:I4: bold'}]}),
  'read changed': E.check(T['north-q4'], '61870', {}, {}, {'undoSteps': 1, 'changes': []}),
  'review saved': E.check(T['review-south-q3'], '', {'Sales!E6': 43000}, {}, {'saved': True, 'changes': []}),
  'ids': len(T), 'kinds': sorted({t['kind'] for t in T.values()}),
}
print(json.dumps(out))
`;

test('eval tasks are scored on the numbers stated and the cells left behind', { skip: !python && 'no python' }, () => {
  const r = spawnSync(python, ['-I', '-c', CODE, agentDir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout);
  assert.deepEqual(o['sum ok'], []);
  assert.deepEqual(o['sum wrong'], ['answer lacks 304820']);
  assert.deepEqual(o['growth pct'], []);
  assert.deepEqual(o['growth frac'], [], 'a fraction written to fewer decimals still counts');
  assert.deepEqual(o.best, []);
  assert.deepEqual(o['cells ok'], []);
  assert.deepEqual(o['cells wrong'], ['Sales!C5 is 48200.0, not 50000', 'Sales!G5 is 216080, not 219220']);
  assert.deepEqual(o['formula missing'], ['Sales!C20 holds no formula'], 'text compares without case or spaces; a typed number is not a formula');
  assert.deepEqual(o.cleared, []);
  assert.deepEqual(o.bold, []);
  assert.deepEqual(o['read changed'], ['a read-only request changed the workbook']);
  assert.deepEqual(o['review saved'], ['a Review request saved']);
  assert.equal(o.ids, 20);
  assert.deepEqual(o.kinds, ['change', 'read']);
  const ids = JSON.parse(fs.readFileSync(path.join(agentDir, 'eval/tasks.json'), 'utf8')).tasks.map(t => t.id);
  assert.equal(new Set(ids).size, ids.length, 'task ids are unique');
});
