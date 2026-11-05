'use strict';

// Atlas redesign spec, PR 6: Ask sends a small packet about the selected module. The question comes first, then the
// module (what it uses, what uses it, its tests, its risk parts), then its neighbours ranked by distance and risk
// (graph-neighbour retrieval, LightRAG's local mode), then only the findings that name them. Repo-wide findings go in
// only when nothing is selected. The packet is compact JSON capped at 3,000 tokens (4,000 with nothing selected);
// the lowest-ranked items go first and the answer says what was left out. num_ctx is always sent, and a model whose
// configured context can't hold the prompt and a 1,000-token answer is refused with a model that can.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PY = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);

// A graph shaped like Local AI's: app/storage.js used by 40 modules, using 4, imported by 24 tests; each user has
// users of its own (the second hop); findings on the store, on a user, on a second-hop module and on an unrelated one.
const SETUP = `
import importlib.util, json, math
spec = importlib.util.spec_from_file_location('ai', ${JSON.stringify(path.join(ROOT, 'atlas_intelligence.py'))})
ai = importlib.util.module_from_spec(spec); spec.loader.exec_module(ai)
def node(i, domain='Core', risk=10, **more):
    return {'id': i, 'label': i.split('/')[-1], 'domain': domain, 'risk': risk, 'riskLevel': 'low', 'inbound': 0,
            'outbound': 0, 'degree': 0, 'testRefs': 0, 'changed': False, **more}
S = 'app/storage.js'
nodes = [node(S, 'Data', 34, riskParts={'reach': 30, 'out': 4, 'in': 18, 'tested': -18}, testRefs=24)]
edges = []
for k in range(4):
    nodes.append(node(f'app/lib/store-helper-number-{k}.js', risk=5)); edges.append({'source': S, 'target': f'app/lib/store-helper-number-{k}.js', 'kind': 'import'})
for k in range(40):
    u = f'app/server/feature-module-with-a-long-name-{k:02d}.js'
    nodes.append(node(u, 'API', risk=k)); edges.append({'source': u, 'target': S, 'kind': 'import'})
    for j in range(3):
        w = f'app/public/browser-script-calling-feature-{k:02d}-{j}.js'
        nodes.append(node(w, 'UI', risk=1)); edges.append({'source': w, 'target': u, 'kind': 'http'})
for k in range(24):
    t = f'tests/storage-{k}.test.cjs'; nodes.append(node(t, 'Tests')); edges.append({'source': t, 'target': S, 'kind': 'test'})
nodes.append(node('app/unrelated.js', risk=90))
graph = {'schemaVersion': 2, 'nodes': nodes, 'edges': edges, 'stats': {'files': len(nodes)},
         'highestRisk': [n for n in nodes if n['risk'] > 30], 'changedNodes': []}
def f(n, sev, rule='r'):
    return {'id': f'{rule}:{n}', 'rule': rule, 'severity': sev, 'node': n, 'title': f'{rule} on {n}', 'summary': 'x' * 80,
            'confidence': 0.9, 'evidence': ['e']}
findings = [f('app/unrelated.js', 'critical'), f(S, 'medium'), f('app/server/feature-module-with-a-long-name-39.js', 'high'),
            f('app/public/browser-script-calling-feature-39-0.js', 'low'), f('app/never-near.js', 'high', 'far')]
`;

function py(body) {
  const r = spawnSync(PY, ['-I', '-c', SETUP + body], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

test('with a module selected: it comes first, the packet is compact JSON and at most 3,000 tokens', { skip: !PY }, () => {
  const out = py(`
p = ai.build_ask_packet(graph, findings, 'Why is storage risky?', selected_node=S, root=None)
text = ai.packet_json(p['packet'])
print(json.dumps({'keys': list(p['packet']), 'first': p['packet']['selected']['id'], 'tokens': ai.estimate_tokens(text),
  'reported': p['tokens'], 'indented': '\\n' in text or ': ' in text, 'parts': p['packet']['selected'].get('riskParts'),
  'uses': len(p['packet']['selected']['uses']), 'usedBy': len(p['packet']['selected']['usedBy']),
  'tests': len(p['packet']['selected']['tests'])}))`);
  assert.equal(out.keys[0], 'selected');
  assert.equal(out.first, 'app/storage.js');
  assert.ok(out.tokens <= 3000, `${out.tokens} tokens`);
  assert.equal(out.reported, out.tokens);
  assert.equal(out.indented, false, 'compact JSON, no indentation');
  assert.deepEqual(out.parts, { reach: 30, out: 4, in: 18, tested: -18 });
  assert.equal(out.tests, 24, 'tests are listed apart from what uses it');
  assert.ok(out.usedBy >= 1 && out.uses === 4);
});

test('neighbours: direct ones before the second hop, riskiest first, and the lowest-ranked are left out first', { skip: !PY }, () => {
  const out = py(`
p = ai.build_ask_packet(graph, findings, 'Why is storage risky?', selected_node=S, root=None)
nb = p['packet'].get('neighbours', [])
print(json.dumps({'ids': [n['id'] for n in nb], 'hops': [n['hop'] for n in nb], 'risks': [n['risk'] for n in nb if n['hop'] == 1],
  'leftOut': p['leftOut']}))`);
  assert.ok(out.ids.length > 0);
  const firstTwo = out.hops.indexOf(2);
  assert.ok(firstTwo === -1 || out.hops.slice(firstTwo).every((h) => h === 2), 'no direct neighbour after a second-hop one');
  assert.deepEqual(out.risks, [...out.risks].sort((a, b) => b - a), 'direct neighbours riskiest first');
  assert.equal(out.ids[0], 'app/server/feature-module-with-a-long-name-39.js');
  assert.ok(out.leftOut.length > 0 && out.leftOut.every((s) => /^\d+ /.test(s)), `left out: ${out.leftOut}`);
});

test('findings: only those naming the module or a neighbour, the module\'s own first; no repo-wide lists', { skip: !PY }, () => {
  const out = py(`
p = ai.build_ask_packet(graph, findings, 'Why is storage risky?', selected_node=S, root=None)
print(json.dumps({'findings': [x['node'] for x in p['packet'].get('findings', [])], 'keys': list(p['packet'])}))`);
  assert.equal(out.findings[0], 'app/storage.js');
  assert.ok(out.findings.includes('app/server/feature-module-with-a-long-name-39.js'));
  assert.ok(!out.findings.includes('app/unrelated.js') && !out.findings.includes('app/never-near.js'));
  for (const k of ['topFindings', 'findingGroups', 'highestRisk', 'changedNodes']) assert.ok(!out.keys.includes(k), k);
});

test('with nothing selected: repo-wide findings, at most 4,000 tokens, what matches the question first', { skip: !PY }, () => {
  const out = py(`
p = ai.build_ask_packet(graph, findings, 'what about feature-module-with-a-long-name-07', root=None)
text = ai.packet_json(p['packet'])
print(json.dumps({'keys': list(p['packet']), 'tokens': ai.estimate_tokens(text),
  'match': [n['id'] for n in p['packet'].get('matchingNodes', [])][:1], 'top': [x['node'] for x in p['packet'].get('topFindings', [])][:1]}))`);
  assert.ok(out.tokens <= 4000, `${out.tokens} tokens`);
  assert.ok(!out.keys.includes('selected'));
  assert.equal(out.keys[0], 'matchingNodes');
  assert.deepEqual(out.match, ['app/server/feature-module-with-a-long-name-07.js']);
  assert.deepEqual(out.top, ['app/unrelated.js'], 'repo-wide findings, most severe first');
});

// Ollama stand-in: /api/tags lists the models, /api/show gives each one's configured num_ctx, /api/chat records the request.
const OLLAMA = `
sent = []
CTX = {'qwen3:4b-instruct-32k': 32768, 'qwen3:4b-instruct-8k': 8192, 'tiny-2k': 2048, 'qwen3:4b-instruct': None}
def fake(url, *, method='GET', payload=None, timeout=8.0):
    if url.endswith('/api/tags'): return {'models': [{'name': m} for m in CTX]}
    if url.endswith('/api/show'):
        c = CTX[payload['model']]
        return {'parameters': f'num_ctx                        {c}' if c else 'temperature 0.7', 'model_info': {'qwen3.context_length': 262144}}
    if url.endswith('/api/chat'): sent.append(payload); return {'message': {'content': 'ok'}}
    raise AssertionError(url)
ai.request_json = fake
def ask(model, node=S):
    try:
        r = ai.ask_ollama(graph=graph, findings=findings, question='Why is storage risky?', selected_node=node, requested_model=model, root=None)
        return {'ok': True, 'leftOut': r['leftOut'], 'ctx': sent[-1]['options'].get('num_ctx'), 'user': sent[-1]['messages'][1]['content']}
    except ai.AtlasError as e:
        return {'ok': False, 'code': e.code, 'message': str(e)}
`;

test('num_ctx is always sent: the model\'s own setting, else 8,192', { skip: !PY }, () => {
  const out = py(`${OLLAMA}
print(json.dumps([ask('qwen3:4b-instruct-32k'), ask('qwen3:4b-instruct-8k'), ask('qwen3:4b-instruct')]))`);
  assert.deepEqual(out.map((r) => r.ctx), [32768, 8192, 8192]);
  assert.ok(out[0].user.startsWith('QUESTION:\nWhy is storage risky?'), 'the question comes first');
  assert.match(out[0].user, /LEFT OUT TO FIT: \d+ /);
});

test('a model whose context cannot hold the prompt and an answer is refused, naming one that can', { skip: !PY }, () => {
  const out = py(`${OLLAMA}
print(json.dumps(ask('tiny-2k')))`);
  assert.equal(out.ok, false);
  assert.equal(out.code, 'ollama_context_too_small');
  assert.match(out.message, /tiny-2k/);
  assert.match(out.message, /qwen3:4b-instruct-8k/, 'suggests the smallest model that fits');
});

test("the page shows what was left out under the answer", () => {
  const src = require('node:fs').readFileSync(path.join(ROOT, 'app/public/architecture.js'), 'utf8');
  assert.match(src, /Left out to fit: /);
});
