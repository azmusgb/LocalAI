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

// Run telemetry on the records: each worker's usage, the coordinator's, and the mission total.
const { withTurnUsage } = require('../app/agent-runtime');
const evidenceId = messages => JSON.stringify(messages).match(/E-[a-f0-9]{16}/)[0];
const isCoordinator = messages => messages[0].content.startsWith('You are the mission coordinator');
function tooledFixture(t, runAgentTurn, extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-mission-'));
  const orchestrator = createOrchestrator({
    dataDir, ollamaUrl: 'http://unused.invalid', defaultModel: 'test-model',
    fetchWithTimeout: async () => ({ ok: true, json: async () => ({ models: [{ name: 'test-model' }] }) }),
    runLocalModel: async () => { throw new Error('Legacy model path must not run when runAgentTurn is configured'); },
    runAgentTurn, ...extra,
  });
  t.after(() => { orchestrator.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return orchestrator;
}

test('a mission keeps each worker\'s usage, the coordinator\'s, and their total', async t => {
  const orchestrator = tooledFixture(t, async ({ messages }) => withTurnUsage(
    { role: 'assistant', content: `${isCoordinator(messages) ? 'Synthesis' : 'Finding'} [${evidenceId(messages)}]` },
    isCoordinator(messages) ? { promptTokens: 300, outputTokens: 40 } : { promptTokens: 100, outputTokens: 20 }));
  const mission = await orchestrator.mission('Review implementation', '', ['code_analyst']);
  assert.equal(mission.status, 'complete', mission.error);
  const worker = mission.workers.find(w => w.id === 'code_analyst'), synthesis = mission.workers.find(w => w.id === 'synthesis');
  assert.deepEqual([worker.usage.turns, worker.usage.promptTokens, worker.usage.outputTokens], [1, 100, 20]);
  assert.deepEqual(mission.results[0].usage, worker.usage, 'the specialist run record holds the same summary');
  assert.deepEqual([synthesis.usage.turns, synthesis.usage.promptTokens, synthesis.usage.outputTokens], [1, 300, 40]);
  assert.deepEqual([mission.usage.turns, mission.usage.toolCalls, mission.usage.promptTokens, mission.usage.outputTokens], [2, 0, 400, 60]);
  assert.equal(mission.usage.peakContextChars, Math.max(worker.usage.peakContextChars, synthesis.usage.peakContextChars), 'a peak is the largest, not a sum');
  assert.deepEqual([mission.usage.counted, mission.usage.uncounted], [['code_analyst', 'synthesis'], []], 'every worker that ran is in the total');
  assert.equal('usage' in mission.workers.find(w => w.id === 'router'), false, 'the router runs no model');
  assert.deepEqual(orchestrator.getMission(mission.id).usage, mission.usage, 'reading the mission back shows it');
  assert.deepEqual(orchestrator.getMission(mission.id).workers.find(w => w.id === 'synthesis').usage, synthesis.usage);
  assert.deepEqual(orchestrator.runs()[0].usage, worker.usage);
  assert.ok(mission.toolEvents.some(e => e.type === 'model_turn_done' && e.workerId === 'code_analyst' && e.promptTokens === 100), 'the stream carries the per-turn numbers');
  assert.ok(mission.timeline.every(entry => entry.workers.every(w => !('usage' in w))), 'timeline entries stay small');
  // run_usage carries the summary to the record; it is not a step, so no stored event list holds it.
  const stored = orchestrator.getMission(mission.id);
  for (const list of [mission.toolEvents, stored.toolEvents, ...stored.results.map(r => r.toolEvents), ...orchestrator.runs().map(r => r.toolEvents)]) {
    assert.ok(list.length > 0);
    assert.ok(list.every(e => e.type !== 'run_usage'));
  }
});

test('one worker without token counts makes the mission\'s token total unknown', async t => {
  const orchestrator = tooledFixture(t, async ({ messages }) => {
    const message = { role: 'assistant', content: `Finding [${evidenceId(messages)}]` };
    return isCoordinator(messages) ? message : withTurnUsage(message, { promptTokens: 100, outputTokens: 20 });
  });
  const mission = await orchestrator.mission('Review implementation', '', ['code_analyst']);
  assert.equal(mission.status, 'complete', mission.error);
  assert.equal(mission.workers.find(w => w.id === 'code_analyst').usage.promptTokens, 100);
  assert.equal(mission.workers.find(w => w.id === 'synthesis').usage.promptTokens, null);
  assert.equal(mission.usage.promptTokens, null, 'not the 100 that was counted');
  assert.equal(mission.usage.outputTokens, null);
  assert.equal(mission.usage.turns, 2, 'what every worker counted is still a total');
  assert.deepEqual([mission.usage.counted, mission.usage.uncounted], [['code_analyst', 'synthesis'], []], 'a worker with one unread count is still a counted worker');
});

test('the single-prompt path records usage as unknown, not zero', async t => {
  const { orchestrator } = fixture(t);
  const mission = await orchestrator.mission('Review implementation', '', ['code_analyst']);
  assert.equal(mission.status, 'complete', mission.error);
  assert.equal(mission.results[0].usage, null);
  assert.equal(orchestrator.runs()[0].usage, null);
  assert.equal(mission.workers.find(w => w.id === 'code_analyst').usage, null);
  assert.equal(mission.workers.find(w => w.id === 'synthesis').usage, null);
  for (const key of ['turns', 'toolCalls', 'modelMs', 'promptTokens', 'outputTokens', 'peakContextChars']) assert.equal(mission.usage[key], null, key);
  assert.deepEqual([mission.usage.counted, mission.usage.uncounted], [[], ['code_analyst', 'synthesis']], 'workers ran and none was counted');
});

test('a specialist that stops keeps the usage of the turns it ran', async t => {
  const orchestrator = tooledFixture(t, async () => { throw new Error('model went away'); });
  const run = await orchestrator.specialist('code_analyst', 'Review implementation');
  assert.equal(run.status, 'error');
  assert.equal(run.usage.turns, 1);
  assert.equal(run.usage.promptTokens, null);
  assert.ok(Number.isSafeInteger(run.usage.modelMs));
  assert.deepEqual(orchestrator.runs()[0].usage, run.usage);
});

test('a worker whose fallback ran carries the usage of both attempts', async t => {
  const orchestrator = tooledFixture(t, async ({ messages }) => {
    if (messages[0].content.startsWith('Analyze supplied source precisely.')) throw new Error('Model rejected request');
    return withTurnUsage({ role: 'assistant', content: `Finding [${evidenceId(messages)}]` }, { promptTokens: 100, outputTokens: 20 });
  });
  const mission = await orchestrator.mission('Review implementation', '', ['code_analyst']);
  assert.equal(mission.status, 'complete', mission.error);
  const worker = mission.workers.find(w => w.id === 'code_analyst');
  assert.equal(worker.fallbackUsed, 'documentation');
  assert.equal(worker.usage.turns, 2, 'the failed attempt and the fallback');
  assert.equal(worker.usage.promptTokens, null, 'the failed attempt counted nothing, so the worker total is unknown');
  assert.equal(mission.usage.turns, 3);
  assert.equal(mission.usage.promptTokens, null);
  assert.deepEqual([mission.usage.counted, mission.usage.uncounted], [['code_analyst', 'synthesis'], []]);
});

// Every turn in these reports its tokens, so a total can only be unknown because of the path under test.
const counted = (message, promptTokens = 100) => withTurnUsage(message, { promptTokens, outputTokens: 10 });
const noTools = () => Object.assign(new Error('test-model does not support tool calling'), { code: 'MODEL_NO_TOOLS' });
function cloudCoordinator(chat) {
  const { createCoordinator } = require('../app/model-coordinator');
  const cloudModels = { keys: () => ({ groq: true }), parked: () => ({}), chat };
  return createCoordinator({ modelRouter: require('../app/model-router'), cloudModels, routingSetting: () => ({ cloud: true }), recordActivity: () => {}, env: {}, localModel: 'test-model' });
}

test('a cloud summary leaves the Coordinator\'s usage unknown, and the mission total says it left it out', async t => {
  const orchestrator = tooledFixture(t, async ({ messages }) => counted({ role: 'assistant', content: `Finding [${evidenceId(messages)}]` }),
    { coordinator: cloudCoordinator(async () => ({ content: 'Summary from Groq [app/server.js]' })) });
  const mission = await orchestrator.mission('Review the models page code', '', ['code_analyst']);
  assert.equal(mission.status, 'complete', mission.error);
  assert.equal(mission.route.provider, 'groq');
  const synthesis = mission.workers.find(w => w.id === 'synthesis');
  assert.equal('usage' in synthesis, true);
  assert.equal(synthesis.usage, null);
  assert.equal(mission.workers.find(w => w.id === 'code_analyst').usage.promptTokens, 100);
  const worker = mission.workers.find(w => w.id === 'code_analyst');
  assert.deepEqual([mission.usage.counted, mission.usage.uncounted], [['code_analyst'], ['synthesis']], 'the cloud\'s tokens were not counted, and the total says so');
  const { counted: _counted, uncounted: _uncounted, ...sums } = mission.usage;
  assert.deepEqual(sums, worker.usage, 'the total is the counted worker\'s usage, key for key');
  assert.deepEqual([mission.usage.turns, mission.usage.promptTokens, mission.usage.outputTokens], [1, 100, 10]);
  assert.deepEqual(orchestrator.getMission(mission.id).usage, mission.usage, 'reading the mission back shows it');
});

test('a cloud summary that was tried and failed still leaves the Coordinator\'s usage unknown', async t => {
  const orchestrator = tooledFixture(t, async ({ messages }) => counted({ role: 'assistant', content: `${isCoordinator(messages) ? 'Summary on this PC' : 'Finding'} [${evidenceId(messages)}]` }),
    { coordinator: cloudCoordinator(async () => { throw new Error('Groq: HTTP 503'); }) });
  const mission = await orchestrator.mission('Review the models page code', '', ['code_analyst']);
  assert.equal(mission.status, 'complete', mission.error);
  assert.match(mission.answer, /Summary on this PC/);
  assert.deepEqual(mission.route.attempts.map(a => [a.provider, a.outcome]), [['groq', 'error']]);
  assert.equal(mission.workers.find(w => w.id === 'synthesis').usage, null, 'the failed cloud call spent tokens nobody counted');
  assert.deepEqual([mission.usage.counted, mission.usage.uncounted], [['code_analyst'], ['synthesis']]);
  assert.deepEqual([mission.usage.promptTokens, mission.usage.outputTokens], [100, 10], 'the specialist alone: the Coordinator\'s local turn is not added to a total that leaves the Coordinator out');
  assert.ok(mission.toolEvents.some(e => e.type === 'model_turn_done' && e.workerId === 'synthesis' && e.promptTokens === 100), 'the local turn itself was counted');
});

test('a Coordinator that falls back to one prompt has unknown usage', async t => {
  const orchestrator = tooledFixture(t, async ({ messages }) => {
    if (isCoordinator(messages)) throw noTools();
    return counted({ role: 'assistant', content: `Finding [${evidenceId(messages)}]` });
  }, { runLocalModel: async () => 'Summary on this PC [app/server.js]' });
  const mission = await orchestrator.mission('Review implementation', '', ['code_analyst']);
  assert.equal(mission.status, 'complete', mission.error);
  assert.match(mission.toolFallback, /does not support tool calling/);
  assert.equal(mission.workers.find(w => w.id === 'synthesis').usage, null);
  assert.deepEqual([mission.usage.counted, mission.usage.uncounted], [['code_analyst'], ['synthesis']]);
  assert.deepEqual([mission.usage.turns, mission.usage.promptTokens], [1, 100], 'the specialist\'s, with the Coordinator named as left out');
});

test('a specialist that falls back to one prompt ends with usage unknown and no usage event stored', async t => {
  const orchestrator = tooledFixture(t, async () => { throw noTools(); }, { runLocalModel: async () => 'Grounded finding [app/server.js]' });
  const run = await orchestrator.specialist('code_analyst', 'Review implementation');
  assert.equal(run.status, 'complete', run.error);
  assert.match(run.toolFallback, /does not support tool calling/);
  assert.equal(run.usage, null);
  assert.ok(run.toolEvents.some(e => e.type === 'model_turn'), 'the tool run did start');
  assert.ok(run.toolEvents.every(e => e.type !== 'run_usage'), 'no event contradicts the record');
  assert.equal(orchestrator.runs()[0].usage, null);
  assert.ok(orchestrator.runs()[0].toolEvents.every(e => e.type !== 'run_usage'));
});

const askFollowup = { role: 'assistant', content: '', tool_calls: [{ function: { name: 'request_investigation', arguments: { agent_id: 'code_analyst', question: 'FOLLOWUP-Q' } } }] };

test('a follow-up that was cut off has unknown usage, and the mission total says it left it out', async t => {
  const orchestrator = tooledFixture(t, async ({ messages, signal }) => {
    if (JSON.stringify(messages).includes('FOLLOWUP-Q')) {
      if (!isCoordinator(messages)) return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      if (messages.at(-1).role === 'tool') return counted({ role: 'assistant', content: `Synthesis with gap [${evidenceId(messages)}]` });
    }
    return counted(isCoordinator(messages) ? { ...askFollowup } : { role: 'assistant', content: `Finding [${evidenceId(messages)}]` });
  }, { followupTimeoutMs: 50 });
  const mission = await orchestrator.mission('Review implementation', '', ['code_analyst']);
  assert.equal(mission.status, 'complete', mission.error);
  const followup = mission.workers.find(w => w.id === 'code_analyst-followup-1');
  assert.equal(followup.state, 'error');
  assert.equal('usage' in followup, true);
  assert.equal(followup.usage, null);
  assert.equal(mission.workers.find(w => w.id === 'synthesis').usage.promptTokens, 200, 'the Coordinator\'s own turns were counted');
  assert.deepEqual([mission.usage.counted, mission.usage.uncounted], [['code_analyst', 'synthesis'], ['code_analyst-followup-1']]);
  assert.equal(mission.usage.promptTokens, 300, 'worker 100, Coordinator 2 x 100; the cut-off follow-up is named, not added as 0');
  assert.equal(mission.usage.turns, 3);
});

test('a follow-up that finished adds its usage to the mission', async t => {
  const orchestrator = tooledFixture(t, async ({ messages }) => {
    if (!isCoordinator(messages)) return counted({ role: 'assistant', content: `Finding [${evidenceId(messages)}]` }, messages[1].content.includes('Goal:\nFOLLOWUP-Q') ? 7 : 100);
    return counted(messages.at(-1).role === 'tool' ? { role: 'assistant', content: `Synthesis [${evidenceId(messages)}]` } : { ...askFollowup });
  });
  const mission = await orchestrator.mission('Review implementation', '', ['code_analyst']);
  assert.equal(mission.status, 'complete', mission.error);
  const followup = mission.workers.find(w => w.id === 'code_analyst-followup-1');
  assert.equal(followup.state, 'complete', followup.error);
  // The follow-up takes two turns: its first answer cites an ID from the findings it was handed and is sent back once.
  assert.deepEqual([followup.usage.turns, followup.usage.promptTokens], [2, 14]);
  assert.equal(mission.usage.promptTokens, 314, 'worker 100, follow-up 2 x 7, Coordinator 2 x 100');
  assert.equal(mission.usage.turns, 5);
  assert.deepEqual([mission.usage.counted, mission.usage.uncounted], [['code_analyst', 'synthesis', 'code_analyst-followup-1'], []], 'everything that ran is in the total');
  assert.deepEqual(orchestrator.getMission(mission.id).workers.find(w => w.id === 'code_analyst-followup-1').usage, followup.usage);
});

test('a mission cancelled before any worker ran totals zeros and covers nothing', async t => {
  let turns = 0;
  const orchestrator = tooledFixture(t, async () => { turns += 1; return { role: 'assistant', content: 'unused' }; });
  const ended = await orchestrator.mission('Review implementation', '', ['code_analyst'], { signal: AbortSignal.abort(new Error('Cancelled by owner')) });
  assert.equal(turns, 0, 'no model was asked');
  assert.equal(ended.status, 'error');
  assert.match(ended.error, /Cancelled by owner/);
  const mission = orchestrator.getMission(ended.id);
  assert.ok(mission.workers.every(w => !('usage' in w)), 'no worker ran');
  assert.deepEqual([mission.usage.counted, mission.usage.uncounted], [[], []]);
  for (const key of ['turns', 'toolCalls', 'modelMs', 'promptTokens', 'outputTokens', 'peakContextChars']) assert.equal(mission.usage[key], 0, key);
});

test('a mission that stops after its only specialist failed lists the Coordinator in neither list', async t => {
  const orchestrator = tooledFixture(t, async () => { throw new Error('Model rejected request'); });
  const mission = await orchestrator.mission('Review implementation', '', ['code_analyst']);
  assert.equal(mission.status, 'needs_attention');
  assert.equal(mission.workers.find(w => w.id === 'synthesis').state, 'blocked');
  assert.ok(!mission.usage.counted.includes('synthesis') && !mission.usage.uncounted.includes('synthesis'), 'the Coordinator never started');
  assert.ok(!mission.usage.counted.includes('router') && !mission.usage.uncounted.includes('router'), 'the router runs no model');
  assert.deepEqual([...mission.usage.counted, ...mission.usage.uncounted], ['code_analyst']);
});
