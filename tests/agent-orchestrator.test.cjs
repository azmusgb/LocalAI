const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const createOrchestrator = require('../app/agent-orchestrator');

function fixture(t, respond = () => 'Grounded finding [app/server.js]') {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-mission-'));
  const calls = [];
  const orchestrator = createOrchestrator({
    dataDir, ollamaUrl: 'http://unused.invalid', defaultModel: 'test-model',
    fetchWithTimeout: async () => ({ ok: true, json: async () => ({ models: [{ name: 'test-model' }] }) }),
    runLocalModel: async (prompt, system) => {
      calls.push({ prompt, system });
      return respond(prompt, system);
    },
  });
  t.after(() => { orchestrator.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const events = [];
  orchestrator.events.on('mission', mission => events.push(structuredClone(mission)));
  return { orchestrator, calls, events };
}

test('mission completes dependencies before synthesis and persists its result', async t => {
  const { orchestrator, calls, events } = fixture(t);
  const mission = await orchestrator.mission('Review code and test coverage', '', ['code_analyst', 'test_engineer']);
  assert.equal(mission.status, 'complete');
  assert.ok(mission.workers.every(worker => worker.state === 'complete'));
  assert.equal(calls.length, 3);
  assert.match(calls[1].prompt, /DEPENDENCY RESULT: Code Analyst/);
  assert.match(calls[1].prompt, /Grounded finding \[app\/server.js\]/);
  assert.match(calls[2].prompt, /Specialist outputs:/);
  assert.equal(events[0].timeline.at(-1).type, 'mission-start');
  assert.equal(events.at(-1).timeline.at(-1).type, 'mission-complete');
  const duringAnalysis = events.find(event => event.workers.some(w => w.id === 'code_analyst' && w.state === 'running'));
  assert.equal(duringAnalysis.workers.find(w => w.id === 'test_engineer').state, 'pending');
  assert.deepEqual(orchestrator.missions()[0], JSON.parse(JSON.stringify(mission)));
  assert.ok(orchestrator.runs().every(run => run.status === 'complete'));
});

test('failed prerequisite blocks downstream execution and synthesis', async t => {
  const { orchestrator, calls } = fixture(t, () => { throw new Error('Model rejected request'); });
  const mission = await orchestrator.mission('Review implementation', '', ['code_analyst', 'test_engineer']);
  assert.equal(mission.status, 'needs_attention');
  assert.equal(mission.workers.find(w => w.id === 'code_analyst').state, 'error');
  assert.equal(mission.workers.find(w => w.id === 'test_engineer').state, 'blocked');
  assert.equal(mission.workers.find(w => w.id === 'synthesis').state, 'blocked');
  assert.ok(calls.every(call => !/rigorous test engineer|mission coordinator/.test(call.system)));
  assert.equal(orchestrator.missions()[0].status, 'needs_attention');
});

test('successful fallback unblocks dependents and preserves execution attribution', async t => {
  const { orchestrator, calls } = fixture(t, (prompt, system) => {
    if (system.startsWith('Analyze supplied source precisely.')) throw new Error('Model rejected request');
    return 'Recovered evidence [app/server.js]';
  });
  const mission = await orchestrator.mission('Review implementation', '', ['code_analyst', 'test_engineer']);
  assert.equal(mission.status, 'complete');
  const result = mission.results.find(r => r.agentId === 'code_analyst');
  assert.equal(result.fallbackFor, 'code_analyst');
  assert.equal(result.executedBy, 'documentation');
  assert.equal(mission.workers.find(w => w.id === 'code_analyst').fallbackUsed, 'documentation');
  const downstream = calls.find(call => call.system.includes('rigorous test engineer'));
  assert.match(downstream.prompt, /Recovered evidence/);
  assert.match(downstream.prompt, /fallback for Code Analyst/);
  assert.ok(mission.timeline.some(event => event.type === 'fallback'));
  assert.deepEqual(orchestrator.missions()[0], JSON.parse(JSON.stringify(mission)));
});

test('parallel specialists retain completed run history', async t => {
  const { orchestrator } = fixture(t, async () => {
    await new Promise(resolve => setImmediate(resolve));
    return 'Independent finding';
  });
  const mission = await orchestrator.mission('Review design and research', '', ['ux_analyst', 'research_agent']);
  assert.equal(mission.status, 'complete');
  const runs = orchestrator.runs();
  assert.equal(runs.length, 2);
  assert.ok(runs.every(run => run.status === 'complete'), 'both parallel results must persist as complete');
});

test('concurrent missions retain both results and completed histories', async t => {
  const { orchestrator } = fixture(t, async () => {
    await new Promise(resolve => setImmediate(resolve));
    return 'Concurrent result';
  });
  const missions = await Promise.all([
    orchestrator.mission('Review design', '', ['ux_analyst']),
    orchestrator.mission('Research evidence', '', ['research_agent']),
  ]);
  assert.ok(missions.every(mission => mission.status === 'complete'));
  const stored = orchestrator.missions();
  assert.equal(stored.length, 2);
  for (const mission of missions) {
    assert.deepEqual(stored.find(row => row.id === mission.id), JSON.parse(JSON.stringify(mission)));
  }
  assert.equal(orchestrator.runs().length, 2);
  assert.ok(orchestrator.runs().every(run => run.status === 'complete'));
});


test('a fallback that throws keeps sibling results and leaves no worker running', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-mission-'));
  let inventoryCalls = 0;
  const orchestrator = createOrchestrator({
    dataDir, ollamaUrl: 'http://unused.invalid', defaultModel: 'test-model',
    fetchWithTimeout: async () => {
      if (++inventoryCalls > 1) throw new Error('fetch failed');
      return { ok: true, json: async () => ({ models: [{ name: 'test-model' }] }) };
    },
    runLocalModel: async (prompt, system) => {
      if (system.startsWith('Analyze supplied source precisely.')) throw new Error('Model rejected request');
      return 'Research finding';
    },
  });
  t.after(() => { orchestrator.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const mission = await orchestrator.mission('Review implementation and research sources', '', ['code_analyst', 'research_agent']);
  assert.equal(mission.status, 'needs_attention');
  assert.equal(mission.results.find(r => r.agentId === 'research_agent').status, 'complete');
  assert.equal(mission.workers.find(w => w.id === 'code_analyst').state, 'error');
  assert.ok(mission.workers.every(w => !['running', 'pending'].includes(w.state)));
  assert.ok(mission.timeline.some(e => e.type === 'fallback' && /failed/.test(e.detail)));
});

// A coordinator that fails leaves no answer: the mission needs you (cancelling it is still an error).
test('a coordinator failure settles every worker and needs you', async t => {
  const { orchestrator } = fixture(t, (prompt, system) => {
    if (system.includes('mission coordinator')) throw new Error('Model rejected request');
    return 'Finding [app/server.js]';
  });
  const mission = await orchestrator.mission('Review design', '', ['ux_analyst']);
  assert.equal(mission.status, 'needs_attention');
  assert.equal(mission.error, 'No answer: Model rejected request');
  assert.equal(mission.workers.find(w => w.id === 'synthesis').state, 'error');
  assert.ok(orchestrator.missions()[0].workers.every(w => !['running', 'pending'].includes(w.state)));
});

test('missions and runs left running by a restart are closed out and stop counting as workload', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-mission-'));
  const { Storage } = require('../app/storage');
  const seed = new Storage({ dataDir });
  for (const n of [1, 2]) {
    seed.upsert('missions', { id: `mission-stale-${n}`, goal: 'old', status: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      workers: [{ id: 'code_analyst', state: 'running' }, { id: 'synthesis', state: 'pending' }], timeline: [] });
  }
  seed.upsert('specialistRuns', { id: 'spec-stale', agentId: 'code_analyst', status: 'running', plan: [{ name: 'Execute specialist', state: 'running' }] });
  seed.close();
  const orchestrator = createOrchestrator({
    dataDir, ollamaUrl: 'http://unused.invalid', defaultModel: 'test-model',
    fetchWithTimeout: async () => ({ ok: true, json: async () => ({ models: [{ name: 'test-model' }] }) }),
    runLocalModel: async () => 'ok',
  });
  t.after(() => { orchestrator.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  for (const m of orchestrator.missions()) {
    assert.equal(m.status, 'error');
    assert.match(m.error, /restarted/);
    assert.deepEqual(m.workers.map(w => w.state), ['error', 'blocked']);
  }
  assert.equal(orchestrator.runs()[0].errorCode, 'INTERRUPTED');
  const routing = await orchestrator.dispatch('analyze code architecture and modules');
  assert.ok(routing.selectedAgentIds.includes('code_analyst'));
});

test('manual dispatch rejects unknown or infrastructure agents', async t => {
  const { orchestrator, calls } = fixture(t);
  await assert.rejects(orchestrator.mission('anything', '', ['nope']), err => err.statusCode === 400 && /nope/.test(err.message));
  await assert.rejects(orchestrator.dispatch('anything', ['model_router']), /model_router/);
  assert.equal(calls.length, 0);
});

test('routing terms match at word starts only', async t => {
  const { orchestrator } = fixture(t);
  const suite = await orchestrator.dispatch('build a test suite for the ledger');
  assert.ok(suite.selectedAgentIds.includes('test_engineer'));
  assert.ok(!suite.selectedAgentIds.includes('ux_analyst'), 'ui must not match inside build/suite');
  const rapid = await orchestrator.dispatch('rapid prototype tests');
  assert.ok(!rapid.selectedAgentIds.includes('documentation'), 'api must not match inside rapid');
  const ui = await orchestrator.dispatch('review the ui layout');
  assert.ok(ui.selectedAgentIds.includes('ux_analyst'));
});

test('fetchWithTimeout timeouts are reported as model timeouts', async t => {
  const { orchestrator } = fixture(t, () => { throw new Error('Request timed out'); });
  const run = await orchestrator.specialist('research_agent', 'Research sources');
  assert.equal(run.errorCode, 'MODEL_TIMEOUT');
});
