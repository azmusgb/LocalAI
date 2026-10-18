'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// host/gridcraft-agent/gridcraft_answer.py on its own, and gridcraft_ai.run_agent_turn with a scripted model and a
// fake GridCraft (mcp and openai are stubbed, so neither needs to be installed).
const agentDir = path.resolve(__dirname, '../host/gridcraft-agent');
const python = ['python3', 'python'].find(cmd => spawnSync(cmd, ['--version']).status === 0);

function py(code, input) {
  const r = spawnSync(python, ['-I', '-c', code, agentDir], { input: JSON.stringify(input ?? null), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

const SALES = JSON.stringify({ is_error: false, content: [{ type: 'text', text: JSON.stringify({ sheet: 'Sales', range: 'D1:D4', values: [['Sales'], [1200], [3400.5], ['=D2*2']] }) }] });
const SUM = JSON.stringify({ is_error: false, content: [{ type: 'text', text: JSON.stringify({ formula: '=SUM(Sales!D2:D17)', value: 48250 }) }] });

test('the answer check keeps good answers, retries boilerplate once and then appends the values read', { skip: !python && 'no python' }, () => {
  const out = py(String.raw`
import asyncio, json, sys
sys.path.insert(0, sys.argv[1])
import gridcraft_answer as A
cases = json.loads(sys.stdin.read())
results = []
for case in cases:
    reads = A.Reads()
    for name, args, text in case['tools']:
        reads.add(name, args, text)
    reads.wrote = case.get('wrote', False)
    asked = []
    async def ask(prompt, replies=list(case.get('replies', []))):
        asked.append(prompt)
        if not replies: raise RuntimeError('no model')
        return replies.pop(0)
    answer = asyncio.run(A.check_answer(case['answer'], case['question'], reads, ask))
    results.append({'answer': answer, 'asked': asked})
print(json.dumps(results))
`, [
    // 0: the 17 Oct answer: boilerplate, values in the tool results. The retry states the number and is kept.
    { question: 'What is the total in the Sales column? Do not change anything.', tools: [['evaluate_formula', { formula: '=SUM(Sales!D2:D17)' }, SUM]],
      answer: 'I have now verified that the original request was fully addressed. The total in the Sales column has been identified.',
      replies: ['The total in the Sales column is 48,250.'] },
    // 1: the retry is still boilerplate: the values are appended to it.
    { question: 'What is the total in the Sales column?', tools: [['evaluate_formula', { formula: '=SUM(Sales!D2:D17)' }, SUM]],
      answer: 'The request has been completed.', replies: ['I have verified the total.'] },
    // 2: a good answer is unchanged and the model isn't asked again.
    { question: 'What is the total in the Sales column?', tools: [['evaluate_formula', { formula: '=SUM(Sales!D2:D17)' }, SUM]],
      answer: 'The Sales total is $48,250.00.' },
    // 3: a number the model added up itself counts, and so does rounding.
    { question: 'Average of Sales?', tools: [['read_range', { sheet: 'Sales', range: 'D1:D4' }, SALES]], answer: 'The average is 2300.25.' },
    { question: 'Second sale?', tools: [['read_range', { sheet: 'Sales', range: 'D1:D4' }, SALES]], answer: 'The second sale is about 3,401.' },
    // 5: no values read (inspect only), or a change request: nothing to check.
    { question: 'Summarize the workbook', tools: [['inspect_workbook', {}, SUM]], answer: 'Done.' },
    { question: 'Add a total', tools: [['read_range', { sheet: 'Sales', range: 'D1:D4' }, SALES]], wrote: true, answer: 'Added =SUM(D2:D17) in D18.' },
    // 7: the retry fails outright: the first answer keeps its text and gets the values. Sheet names and cell
    // references in the answer are not values; error results are not read.
    { question: 'What is in the Sales column?', tools: [['read_range', { sheet: 'Sales', range: 'D1:D4' }, SALES], ['get_cell', { cell: 'Z9' }, JSON.stringify({ is_error: true, content: [{ type: 'text', text: '99' }] })]],
      answer: 'The Sales column in D1:D17 was read.' },
  ]);

  assert.equal(out[0].asked.length, 1);
  assert.match(out[0].asked[0], /^Your answer must state the actual values you found\. From these tool results: evaluate_formula =SUM\(Sales!D2:D17\) → 48250, answer the question/);
  assert.equal(out[0].answer, 'The total in the Sales column is 48,250.');

  assert.equal(out[1].asked.length, 1, 'one retry only');
  assert.equal(out[1].answer, 'I have verified the total.\n\nValues read: evaluate_formula =SUM(Sales!D2:D17) → 48250');

  for (const i of [2, 3, 4, 5, 6]) assert.deepEqual(out[i].asked, [], `case ${i} is not retried`);
  assert.equal(out[2].answer, 'The Sales total is $48,250.00.');
  assert.equal(out[6].answer, 'Added =SUM(D2:D17) in D18.');

  assert.equal(out[7].asked.length, 1);
  assert.equal(out[7].answer, 'The Sales column in D1:D17 was read.\n\nValues read: read_range Sales!D1:D4 → Sales, 1200, 3400.5',
    'formula text is not a value; the failed get_cell adds nothing');
});

test('a request that read values and answered with boilerplate gets one more turn without tools', { skip: !python && 'no python' }, () => {
  const out = py(String.raw`
import asyncio, json, sys, types
sys.path.insert(0, sys.argv[1])
mcp = types.ModuleType('mcp'); mcp.Client = mcp.StdioServerParameters = object; sys.modules['mcp'] = mcp
openai = types.ModuleType('openai'); openai.AsyncOpenAI = object; sys.modules['openai'] = openai
import gridcraft_ai as G
from gridcraft_journal import Journal, allowed_tools
NS = types.SimpleNamespace

def reply(text=None, call=None):
    calls = [NS(id='c1', function=NS(name=call[0], arguments=json.dumps(call[1])))] if call else None
    return NS(choices=[NS(message=NS(content=text, tool_calls=calls))], usage=NS(prompt_tokens=100))

script = json.loads(sys.stdin.read())
requests = []
class Completions:
    async def create(self, **kw):
        requests.append({'tools': 'tools' in kw, 'last': kw['messages'][-1]['content'], 'count': len(kw['messages'])})
        step = script.pop(0)
        return reply(step.get('text'), step.get('call'))
llm = NS(chat=NS(completions=Completions()))

class Block:
    def __init__(self, text): self.text = text
    def model_dump(self, mode=None): return {'type': 'text', 'text': self.text}
gridcraft = []
async def call(name, args):
    gridcraft.append(name)
    return NS(is_error=False, structured_content=None, content=[Block(json.dumps({'value': 48250}))])

journal = Journal('read', call, allowed_tools('read', {'evaluate_formula', 'read_range'}))
history = [{'role': 'system', 'content': G.SYSTEM_PROMPT}]
models = {'current': 'm', 'long': None, 'long_at': 3500}
answer = asyncio.run(G.run_agent_turn(llm, journal, [], history, 'What is the total in the Sales column? Do not change anything.', models))
print(json.dumps({'answer': answer, 'requests': requests, 'gridcraft': gridcraft, 'last': history[-1]['content'], 'prompt': G.SYSTEM_PROMPT, 'core': sorted(G.CORE_TOOL_NAMES)}))
`, [
    { call: ['evaluate_formula', { formula: '=SUM(Sales!D2:D17)' }] },
    { text: 'I have now verified that the original request was fully addressed. The total in the Sales column has been identified.' },
    { text: 'The total in the Sales column is 48,250.' },
  ]);
  assert.equal(out.answer, 'The total in the Sales column is 48,250.');
  assert.deepEqual(out.gridcraft, ['evaluate_formula'], 'the retry calls no GridCraft tool');
  assert.deepEqual(out.requests.map(r => r.tools), [true, true, false], 'the retry is offered no tools');
  assert.equal(out.requests[2].count, 2, 'the retry sends the system prompt and one message');
  assert.match(out.requests[2].last, /^Question: What is the total in the Sales column\? Do not change anything\.\n\nYour answer must state the actual values you found\. From these tool results: evaluate_formula =SUM\(Sales!D2:D17\) → 48250/);
  assert.equal(out.last, out.answer, 'the history keeps the answer the owner saw');
  assert.match(out.prompt, /evaluate_formula\s+with a formula such as =SUM\(Sales!D2:D17\)/);
  assert.ok(out.core.includes('evaluate_formula'), 'Review and Apply requests can compute without writing too');
});
