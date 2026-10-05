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

