'use strict';
// Step 2 of the model coordinator: a mission's Coordinator summary (synthesis) routes as kind `plan`. Workers stay on
// this PC. Cloud off = no cloud request (a spy proves it); project missions, voice missions, goals about Local AI's
// secrets and anything personal stay here; a failing cloud falls back to the Coordinator on this PC.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const createOrchestrator = require('../app/agent-orchestrator');
const modelRouter = require('../app/model-router');
const { createCoordinator } = require('../app/model-coordinator');

function fixture(t, { cloud = true, cloudAnswer = () => ({ content: 'Summary from Groq [app/server.js]' }), worker = () => 'Grounded finding [app/server.js]' } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-mission-cloud-'));
  const local = [], sent = [];
  const cloudModels = {
    keys: () => ({ groq: true }), parked: () => ({}),
    chat: async req => { sent.push(req); const a = cloudAnswer(req); if (a instanceof Error) throw a; return a; },
  };
  const coordinator = createCoordinator({ modelRouter, cloudModels, routingSetting: () => ({ cloud }), recordActivity: () => {}, env: {}, localModel: 'test-model' });
  const orchestrator = createOrchestrator({
    dataDir, ollamaUrl: 'http://unused.invalid', defaultModel: 'test-model', coordinator,
    knowledgeStore: () => [{ id: 'k1', projectId: 'p1', chunks: ['Kitchen plans'] }], knowledgeScore: () => 1,
    fetchWithTimeout: async () => ({ ok: true, json: async () => ({ models: [{ name: 'test-model' }] }) }),
    runLocalModel: async (prompt, system) => { local.push({ prompt, system }); return /mission coordinator/.test(system) ? 'Summary on this PC [app/server.js]' : worker(prompt, system); },
  });
  t.after(() => { orchestrator.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { orchestrator, local, sent };
}
const coordinatorCalls = local => local.filter(c => /mission coordinator/.test(c.system));

test('cloud off: no cloud request at all; the Coordinator runs on this PC and the mission says so', async t => {
  const { orchestrator, local, sent } = fixture(t, { cloud: false });
  const m = await orchestrator.mission('Review the models page code', '', ['code_analyst']);
  assert.equal(m.status, 'complete');
  assert.equal(sent.length, 0);
  assert.equal(coordinatorCalls(local).length, 1);
  assert.equal(m.route.provider, 'ollama');
});

test('cloud on: the summary comes from Groq; the workers still ran on this PC', async t => {
  const { orchestrator, local, sent } = fixture(t);
  const m = await orchestrator.mission('Review the models page code', '', ['code_analyst']);
  assert.equal(m.status, 'complete');
  assert.match(m.answer, /Summary from Groq/);
  assert.deepEqual([m.route.provider, m.route.model, m.route.class], ['groq', 'openai/gpt-oss-120b', 'shareable']);
  assert.equal(coordinatorCalls(local).length, 0);
  assert.ok(local.length >= 1, 'the worker ran locally');
  // The cloud got the goal and the findings, no tool list or evidence index.
  const body = JSON.stringify(sent[0].messages);
  assert.match(body, /Grounded finding/);
  assert.ok(!/request_investigation|Available evidence/.test(body), body.slice(0, 300));
});

test('cloud on: project missions, voice missions, secrets and personal findings stay on this PC', async t => {
  const { orchestrator, sent } = fixture(t, { worker: p => /reminder/.test(p) ? 'They take blood pressure medication [app/server.js]' : 'Grounded finding [app/server.js]' });
  const project = await orchestrator.mission('Review the kitchen plans', 'p1', ['code_analyst']);
  assert.equal(project.route.provider, 'ollama'); assert.match(project.route.why, /documents/i);
  const voice = await orchestrator.mission('Review the models page code', '', ['code_analyst'], { voice: true });
  assert.equal(voice.route.provider, 'ollama');
  const secret = await orchestrator.mission('Where is the Groq API key stored', '', ['code_analyst']);
  assert.equal(secret.route.provider, 'ollama');
  const personal = await orchestrator.mission('Check the reminder code', '', ['code_analyst']);
  assert.equal(personal.route.provider, 'ollama');
  assert.equal(sent.length, 0);
});

test('cloud on but failing: the Coordinator on this PC writes the summary', async t => {
  const { orchestrator, local } = fixture(t, { cloudAnswer: () => new Error('Groq: HTTP 503') });
  const m = await orchestrator.mission('Review the models page code', '', ['code_analyst']);
  assert.equal(m.status, 'complete');
  assert.match(m.answer, /Summary on this PC/);
  assert.equal(m.route.provider, 'ollama');
  assert.equal(coordinatorCalls(local).length, 1);
});

// Security review: the summary may go out only when everything the workers read is known to be public (web results,
// Local AI's own code) and nothing in their findings looks secret or personal. Default local.
function tooled(t, { tool, args, finding = 'Found it', projectRoot } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-mission-tools-'));
  const sent = [];
  const cloudModels = { keys: () => ({ groq: true }), parked: () => ({}), chat: async req => { sent.push(req); return { content: 'Summary from Groq' }; } };
  const coordinator = createCoordinator({ modelRouter, cloudModels, routingSetting: () => ({ cloud: true }), recordActivity: () => {}, env: {}, localModel: 'test-model' });
  const runAgentTurn = async ({ messages }) => {
    if (/mission coordinator/.test(messages[0].content)) return { role: 'assistant', content: 'Summary on this PC' };
    const result = [...messages].reverse().find(m => m.role === 'tool');
    if (!result) return { role: 'assistant', content: '', tool_calls: [{ function: { name: tool, arguments: args } }] };
    const id = (result.content.match(/E-[a-f0-9]{16}/) || [])[0];
    return { role: 'assistant', content: `${finding} [${id}]` };
  };
  const orchestrator = createOrchestrator({
    dataDir, ollamaUrl: 'http://unused.invalid', defaultModel: 'test-model', coordinator, runAgentTurn, ...(projectRoot ? { projectRoot } : {}),
    knowledgeStore: () => [{ id: 'k-unfiled', projectId: '', name: 'Kitchen notes', chunks: ['kitchen renovation budget notes'] }],
    searxSearch: async () => [{ url: 'https://example.com/petg', title: 'PETG vs ASA', content: 'ASA resists UV better than PETG.' }],
    fetchWithTimeout: async () => ({ ok: true, json: async () => ({ models: [{ name: 'test-model' }] }) }),
    runLocalModel: async () => 'Summary on this PC',
  });
  t.after(() => { orchestrator.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { orchestrator, sent };
}

test('a mission without a project whose worker read your documents makes no cloud call', async t => {
  const { orchestrator, sent } = tooled(t, { tool: 'search_project_knowledge', args: { query: 'kitchen' } });
  const m = await orchestrator.mission('Review the kitchen notes', '', ['code_analyst']);
  assert.equal(m.status, 'complete', m.error);
  assert.ok(m.results[0].evidenceRecords.some(r => r.kind === 'knowledge'), 'the worker read a document');
  assert.equal(sent.length, 0);
  assert.equal(m.route.provider, 'ollama');
  assert.match(m.route.why, /documents or files/);
});

test('a worker finding that holds a secret-looking string makes no cloud call', async t => {
  const { orchestrator, sent } = tooled(t, { tool: 'search_web', args: { query: 'PETG ASA' }, finding: 'The header was Authorization: Bearer gsk_abcdefghijklmnop' });
  const m = await orchestrator.mission('Compare PETG and ASA for outdoor parts', '', ['code_analyst'], { allowWeb: true });
  assert.equal(sent.length, 0);
  assert.equal(m.route.provider, 'ollama');
});

test('a mission that read only the web and Local AI\'s own code may be summarised in the cloud', async t => {
  const { orchestrator, sent } = tooled(t, { tool: 'search_web', args: { query: 'PETG ASA' }, finding: 'ASA resists UV better' });
  const m = await orchestrator.mission('Compare PETG and ASA for outdoor parts', '', ['code_analyst'], { allowWeb: true });
  assert.equal(m.status, 'complete', m.error);
  assert.equal(sent.length, 1);
  assert.equal(m.route.provider, 'groq');
});

// Security review: a search is judged by every file it matched, not by its (possibly cut) excerpt, and searches never
// read files whose names say they hold a secret.
function searchRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-search-'));
  fs.mkdirSync(path.join(root, 'public'));
  fs.writeFileSync(path.join(root, 'public', 'zebra.js'), Array.from({ length: 60 }, (_, i) => `const zebraStripe${i} = 'zebra stripe number ${i} for the page';`).join('\n'));
  fs.writeFileSync(path.join(root, 'zz-api-key.txt'), 'zebra gsk_live_abcdefghijklmnop');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('find_in_project skips secret files and records every file it matched', async t => {
  const { createResearchTools } = require('../app/agent-tools');
  const tools = createResearchTools({ projectRoot: searchRoot(t) });
  const find = tools.find(x => x.name === 'find_in_project');
  const out = await find.execute({ query: 'zebra' }, {});
  const rec = out.evidence[0];
  assert.deepEqual(rec.files, ['app/public/zebra.js']);
  assert.ok(!JSON.stringify(out).includes('gsk_live'));
});

test('a search whose excerpt was cut, or that has no file list, keeps the summary on this PC', async t => {
  const { orchestrator, sent } = tooled(t, { tool: 'find_in_project', args: { query: 'zebra' }, finding: 'Zebra stripes found', projectRoot: searchRoot(t) });
  const m = await orchestrator.mission('Review the zebra page', '', ['code_analyst']);
  assert.equal(m.status, 'complete', m.error);
  assert.ok(m.results[0].evidenceRecords.some(r => r.kind === 'search' && r.excerptTruncated), 'the excerpt was cut');
  assert.equal(sent.length, 0);
  assert.equal(m.route.provider, 'ollama');
});
