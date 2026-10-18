'use strict';
// A mission may name the workers' model (developer tools): every specialist and follow-up uses it, the coordinator
// keeps normal routing, and an uninstalled name is refused with the installed names.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const createOrchestrator = require('../app/agent-orchestrator');

const DEFAULT = 'qwen3:4b-instruct-32k', CODER = 'qwen2.5-coder:7b-16k';
const evidenceId = messages => JSON.stringify(messages).match(/E-[a-f0-9]{16}/)[0];
const isCoordinator = messages => messages[0].content.startsWith('You are the mission coordinator');

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-wmodel-'));
  const turns = [];
  const orchestrator = createOrchestrator({
    dataDir, ollamaUrl: 'http://unused.invalid', defaultModel: DEFAULT,
    fetchWithTimeout: async () => ({ ok: true, json: async () => ({ models: [{ name: DEFAULT }, { name: CODER }] }) }),
    runLocalModel: async () => { throw new Error('legacy path must not run'); },
    runAgentTurn: async ({ model, messages }) => {
      const coordinator = isCoordinator(messages), followup = JSON.stringify(messages).includes('FOLLOWUP-Q');
      turns.push({ model, role: coordinator ? 'coordinator' : followup ? 'followup' : 'worker' });
      if (coordinator && messages.at(-1).role === 'tool') return { role: 'assistant', content: `Synthesis [${evidenceId(messages)}]` };
      if (coordinator) return { role: 'assistant', content: '', tool_calls: [{ function: { name: 'request_investigation', arguments: { agent_id: 'code_analyst', question: 'FOLLOWUP-Q' } } }] };
      return { role: 'assistant', content: `Finding [${evidenceId(messages)}]` };
    },
  });
  t.after(() => { orchestrator.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { orchestrator, turns };
}

test('a mission workers\' model runs every specialist and follow-up, not the coordinator', async t => {
  const { orchestrator, turns } = fixture(t);
  const mission = await orchestrator.mission('Review the code', '', ['code_analyst', 'test_engineer'], { workerModel: CODER });
  assert.equal(mission.status, 'complete', mission.error);
  assert.equal(mission.routing.workerModel, CODER);
  assert.ok(mission.routing.workers.every(w => w.model === CODER));
  assert.ok(turns.some(x => x.role === 'followup'), 'a follow-up ran');
  for (const x of turns) assert.equal(x.model, x.role === 'coordinator' ? DEFAULT : CODER, x.role);
  assert.equal(mission.coordinatorModel, DEFAULT);
  assert.equal(mission.workers.find(w => w.id === 'code_analyst-followup-1').model, CODER);
});

test('without a workers\' model routing is unchanged', async t => {
  const { orchestrator, turns } = fixture(t);
  const mission = await orchestrator.mission('Review the code', '', ['code_analyst']);
  assert.equal(mission.status, 'complete', mission.error);
  assert.equal(mission.routing.workerModel, undefined);
  assert.ok(turns.every(x => x.model === DEFAULT));
  const plain = await orchestrator.dispatch('Review the code', ['code_analyst']);
  assert.equal(plain.workers[0].model, DEFAULT);
  assert.equal(plain.workerModel, undefined);
});

test('an uninstalled workers\' model is refused with the installed names', async t => {
  const { orchestrator, turns } = fixture(t);
  const err = await orchestrator.checkWorkerModel('qwen2.5-coder:7b').catch(e => e);
  assert.equal(err.statusCode, 400);
  assert.equal(err.code, 'UNKNOWN_MODEL');
  assert.deepEqual(err.installed, [DEFAULT, CODER]);
  assert.match(err.message, /qwen2\.5-coder:7b-16k/);
  await assert.rejects(orchestrator.dispatch('Review the code', ['code_analyst'], { workerModel: 'nope' }), /Unknown model/);
  await assert.rejects(orchestrator.mission('Review the code', '', ['code_analyst'], { workerModel: 'nope' }), /Unknown model/);
  assert.equal(turns.length, 0);
  assert.equal(await orchestrator.checkWorkerModel(CODER), CODER);
});
