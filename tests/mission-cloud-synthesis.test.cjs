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
  assert.deepEqual([m.route.provider, m.route.model, m.route.class], ['groq', 'llama-3.3-70b-versatile', 'shareable']);
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
  assert.equal(project.route.provider, 'ollama'); assert.match(project.route.why, /project/i);
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
