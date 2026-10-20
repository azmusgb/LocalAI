'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// host/gridcraft-agent/gridcraft_ai.py with stand-ins for its mcp and openai imports (not installed off the host):
// the request's time limit around model calls, and the save an Apply request gets when the model didn't save.
const agentDir = path.resolve(__dirname, '../host/gridcraft-agent');
const python = ['python3', 'python'].find(cmd => spawnSync(cmd, ['--version']).status === 0);

const CODE = String.raw`
import asyncio, json, sys, time, types
sys.path.insert(0, sys.argv[1])
sys.modules['mcp'] = types.SimpleNamespace(Client=None, StdioServerParameters=None)
sys.modules['openai'] = types.SimpleNamespace(AsyncOpenAI=None)
import gridcraft_ai as A
import gridcraft_journal as J

class Result:
    def __init__(self, data): self.is_error = False; self.content = [types.SimpleNamespace(text=json.dumps(data))]

async def answer(after):
    await asyncio.sleep(after); return 'answered'

async def limits():
    out = {}
    out['none'] = await A.model_call({'deadline': None}, answer(0))
    out['in time'] = await A.model_call({'deadline': time.monotonic() + 5}, answer(0.01))
    for label, deadline, after in [('slow', 0.1, 5), ('past', -1, 0)]:
        started = time.monotonic()
        try: await A.model_call({'deadline': time.monotonic() + deadline}, answer(after)); out[label] = 'answered'
        except A.TimeLimit as e: out[label] = [str(e), round(time.monotonic() - started, 1)]
    return out

async def saves():
    out = {}
    for label, mode, writes, saved in [('apply changed', 'apply', True, False), ('apply saved', 'apply', True, True), ('apply read', 'apply', False, False), ('review', 'review', True, False)]:
        calls = []
        async def call(name, args):
            calls.append(name)
            return Result({'undo': [], 'sheets': []} if name == 'inspect_workbook' else {'ok': True})
        j = J.Journal(mode, call, J.allowed_tools(mode, {'set_cell', 'save_workbook', 'inspect_workbook'}))
        if writes: await j.call('set_cell', {'cell': 'B2', 'input': '1'})
        if saved: await j.call('save_workbook', {})
        await A.save_applied(j)
        out[label] = [calls.count('save_workbook'), j.saved]
    return out

asks = {q: A.looks_like_action_request(q) for q in ['Calculate the total of column D', 'What is the total of Sales?', 'How many rows have a sale?',
        'Add a Total row under the sales', 'Can you add a total row?', 'Make a chart of sales', 'Sort the table by date', 'Which region sold the most?']}
both = json.dumps({'is_error': False, 'structured_content': {'values': [[1, 2]]}, 'content': [{'type': 'text', 'text': json.dumps({'values': [[1, 2]]})}]})
text_only = json.dumps({'is_error': False, 'content': [{'type': 'text', 'text': 'x' * 7000}]})
cut = A.model_text(text_only)
texts = {'both': json.loads(A.model_text(both)), 'short': A.model_text('plain') , 'cut_len': len(cut), 'cut_tail': cut[-120:]}
print(json.dumps({'limits': asyncio.run(limits()), 'saves': asyncio.run(saves()), 'asks': asks, 'texts': texts}))
`;

test('model calls stop at the request time limit, and Apply saves what the model changed but left unsaved', { skip: !python && 'no python' }, () => {
  const r = spawnSync(python, ['-I', '-c', CODE, agentDir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const { limits, saves } = JSON.parse(r.stdout);
  assert.equal(limits.none, 'answered');
  assert.equal(limits['in time'], 'answered');
  assert.deepEqual(limits.slow, ["Stopped at the request's time limit while the model was still answering.", 0.1]);
  assert.deepEqual(limits.past, ["Stopped at the request's time limit.", 0]);
  assert.deepEqual(saves, { 'apply changed': [1, true], 'apply saved': [1, true], 'apply read': [0, false], review: [0, false] });
});

test('questions skip the change check, and tool results reach the model once and cut to size', { skip: !python && 'no python' }, () => {
  const r = spawnSync(python, ['-I', '-c', CODE, agentDir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const { asks, texts } = JSON.parse(r.stdout);
  assert.deepEqual(asks, {
    'Calculate the total of column D': false, 'What is the total of Sales?': false, 'How many rows have a sale?': false,
    'Add a Total row under the sales': true, 'Can you add a total row?': true, 'Make a chart of sales': true,
    'Sort the table by date': true, 'Which region sold the most?': false,
  });
  assert.deepEqual(texts.both, { is_error: false, structured_content: { values: [[1, 2]] } }, 'one copy of the data');
  assert.equal(texts.short, 'plain');
  assert.ok(texts.cut_len < 6200, String(texts.cut_len));
  assert.match(texts.cut_tail, /\[cut: \d+ more characters\. Read a smaller range/);
});
