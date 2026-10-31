const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const createOrchestrator = require('../app/agent-orchestrator');
const { runAgentLoop } = require('../app/agent-runtime');
const { tool, evidenceRecord, createResearchTools } = require('../app/agent-tools');
const words = require('../app/public/agent-world-words');

const evidenceId = messages => JSON.stringify(messages).match(/E-[a-f0-9]{16}/)[0];
const isCoordinator = messages => messages[0].content.startsWith('You are the mission coordinator');
const untilAborted = signal => new Promise((resolve, reject) => {
  signal.throwIfAborted();
  signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});

function fixture(t, runAgentTurn, extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-runtime-'));
  const orchestrator = createOrchestrator({
    dataDir, ollamaUrl: 'http://unused.invalid', defaultModel: 'test-model',
    fetchWithTimeout: async () => ({ ok: true, json: async () => ({ models: [{ name: 'test-model' }] }) }),
    runLocalModel: async () => { throw new Error('Legacy model path must not run when runAgentTurn is configured'); },
    runAgentTurn, ...extra,
  });
  t.after(() => { orchestrator.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return orchestrator;
}

test('tool calls beyond the limit are refused without failing the run', async () => {
  const record = evidenceRecord('fixture', 'fixture text');
  let executed = 0;
  const lookup = tool('lookup', 'Lookup', {}, [], async () => { executed++; return { data: {}, evidence: [record] }; });
  const call = { function: { name: 'lookup', arguments: {} } };
  const result = await runAgentLoop({
    model: 'm', system: 's', prompt: 'p', tools: [lookup], maxToolCalls: 1,
    turn: async ({ messages }) => messages.at(-1).role === 'user'
      ? { role: 'assistant', content: '', tool_calls: [call, call] }
      : { role: 'assistant', content: `Done [${record.id}]` },
  });
  assert.equal(executed, 1);
  assert.equal(result.toolCalls, 1);
  assert.match(result.answer, /Done/);
});

test('mission cancellation reaches the coordinator', async t => {
  const controller = new AbortController();
  const orchestrator = fixture(t, async ({ messages, signal }) => {
    if (!isCoordinator(messages)) return { role: 'assistant', content: `Finding [${evidenceId(messages)}]` };
    setImmediate(() => controller.abort(new Error('Mission cancelled')));
    return untilAborted(signal);
  });
  const mission = await orchestrator.mission('Review implementation', '', ['code_analyst'], { signal: controller.signal });
  assert.equal(mission.status, 'error');
  assert.match(mission.error, /Mission cancelled/);
});

// Live (17 Oct): the coordinator wrote its answer, two optional follow-ups ran out of time, and the mission read
// "needs attention" and showed as stopped. With an answer the mission is done and says what didn't finish.
test('a slow follow-up is cut off, synthesis still finishes and the mission completes with a note', async t => {
  const orchestrator = fixture(t, async ({ messages, signal }) => {
    if (JSON.stringify(messages).includes('FOLLOWUP-Q')) {
      if (!isCoordinator(messages)) return untilAborted(signal);
      if (messages.at(-1).role === 'tool') return { role: 'assistant', content: `Synthesis with gap [${evidenceId(messages)}]` };
    }
    if (isCoordinator(messages)) {
      return { role: 'assistant', content: '', tool_calls: [{ function: { name: 'request_investigation', arguments: { agent_id: 'code_analyst', question: 'FOLLOWUP-Q' } } }] };
    }
    return { role: 'assistant', content: `Finding [${evidenceId(messages)}]` };
  }, { followupTimeoutMs: 50 });
  const mission = await orchestrator.mission('Review implementation', '', ['code_analyst']);
  assert.equal(mission.status, 'complete');
  assert.equal(mission.error, undefined);
  assert.equal(mission.note, '1 follow-up ran out of time');
  assert.match(mission.answer, /Synthesis with gap/);
  assert.equal(mission.workers.find(w => w.id === 'synthesis').state, 'complete');
  // The follow-up keeps its own stopped state, so Agent World's crew row still shows it.
  assert.equal(mission.followups[0].status, 'error');
  assert.equal(mission.workers.find(w => w.id === 'code_analyst-followup-1').state, 'error');
  assert.equal(mission.timeline.at(-1).type, 'mission-complete');
  assert.match(words.statusSentence(mission).text, /^Done in .* · 3 workers · 1 follow-up ran out of time$/);
});

test('a follow-up that ran out of time and no answer: the mission needs you', async t => {
  const orchestrator = fixture(t, async ({ messages, signal }) => {
    if (JSON.stringify(messages).includes('FOLLOWUP-Q')) {
      if (!isCoordinator(messages)) return untilAborted(signal);
      // The coordinator gives up after the follow-up: no answer, no tool call.
      if (messages.at(-1).role === 'tool') return { role: 'assistant', content: '' };
    }
    if (isCoordinator(messages)) {
      return { role: 'assistant', content: '', tool_calls: [{ function: { name: 'request_investigation', arguments: { agent_id: 'code_analyst', question: 'FOLLOWUP-Q' } } }] };
    }
    return { role: 'assistant', content: `Finding [${evidenceId(messages)}]` };
  }, { followupTimeoutMs: 50 });
  const mission = await orchestrator.mission('Review implementation', '', ['code_analyst']);
  assert.equal(mission.status, 'needs_attention');
  assert.ok(!mission.answer);
  assert.match(mission.error, /^No answer: .*\(1 follow-up ran out of time\)$/);
  assert.equal(mission.workers.find(w => w.id === 'synthesis').state, 'error');
  assert.equal(mission.results.find(r => r.agentId === 'code_analyst').status, 'complete', 'the specialists’ work is kept');
  assert.ok(mission.workers.every(w => !['running', 'pending'].includes(w.state)));
  assert.equal(mission.timeline.at(-1).type, 'mission-attention');
  assert.match(words.statusSentence(mission).text, /^Needs you · .* · Coordinator stopped/);
});

test('specialists see only the selected project\'s knowledge', async t => {
  const knowledgeStore = () => [
    { id: 'mine', projectId: 'p1', chunks: ['review notes about routing'] },
    { id: 'loose', projectId: '', chunks: ['review notes nobody filed'] },
  ];
  const prompts = [];
  const orchestrator = fixture(t, async ({ messages }) => {
    prompts.push(messages[1].content);
    return { role: 'assistant', content: `Finding [${evidenceId(messages)}]` };
  }, { knowledgeStore, knowledgeScore: (query, text) => (text.includes('review') ? 1 : 0) });
  await orchestrator.specialist('code_analyst', 'review routing', 'p1');
  await orchestrator.specialist('code_analyst', 'review routing', '');
  assert.match(prompts[0], /knowledge:mine#chunk-0/);
  assert.doesNotMatch(prompts[0], /knowledge:loose/);
  assert.doesNotMatch(prompts[1], /knowledge:(mine|loose)/);
});

test('cloud models are not offered to missions', async t => {
  const orchestrator = fixture(t, async () => ({ role: 'assistant', content: 'unused' }), {
    fetchWithTimeout: async () => ({ ok: true, json: async () => ({ models: [{ name: 'gpt-oss:120b-cloud' }, { name: 'remote', remote_model: 'x' }, { name: 'qwen3:8b' }] }) }),
  });
  assert.deepEqual((await orchestrator.models()).map(m => m.name), ['qwen3:8b']);
});

test('the file tool reads only permitted files inside the project root', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-tools-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'server.js'), 'line one\nline two\n');
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'data', 'state.json'), '{}');
  fs.symlinkSync(
    path.join(os.tmpdir()),
    path.join(root, 'escape'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const read = createResearchTools({ projectRoot: root }).find(x => x.name === 'read_project_file');
  const ok = await read.execute({ path: 'server.js', start_line: 2, max_lines: 1 });
  assert.equal(ok.data.content, 'line two');
  assert.match(ok.evidence[0].id, /^E-[a-f0-9]{16}$/);
  for (const bad of ['../outside.js', '/etc/passwd.txt', 'data/state.json', '.env.json', 'escape/x.js', 'server.exe']) {
    await assert.rejects(read.execute({ path: bad }), /Only permitted|ENOENT/, bad);
  }
  assert.equal(createResearchTools({ projectRoot: root, searxSearch: async () => [] }).some(x => x.name === 'search_web'), false);
});

test('an answer that still lacks citations after one revision is kept and flagged', async () => {
  const record = evidenceRecord('fixture', 'fixture text');
  let turns = 0;
  const result = await runAgentLoop({
    model: 'm', system: 's', prompt: 'p', evidence: [record],
    turn: async () => { turns++; return { role: 'assistant', content: 'Uncited claim [E-0000000000000000]' }; },
  });
  assert.equal(turns, 2);
  assert.match(result.answer, /Uncited claim/);
  assert.deepEqual(result.citations, []);
  assert.match(result.citationWarning, /unknown evidence IDs: E-0000000000000000/);
});

test('ollama turns use the configured context and keep-alive', async () => {
  const { createOllamaTurn } = require('../app/agent-runtime');
  let sent;
  const turn = createOllamaTurn({ ollamaUrl: 'http://x', numCtx: 8192, keepAlive: '30m', fetchImpl: async (url, init) => {
    sent = JSON.parse(init.body);
    return { ok: true, body: [Buffer.from(JSON.stringify({ message: { role: 'assistant', content: 'hi' } }))] };
  } });
  assert.equal((await turn({ model: 'qwen3:8b', messages: [], tools: [] })).content, 'hi');
  assert.equal(sent.options.num_ctx, 8192);
  assert.equal(sent.keep_alive, '30m');
  await assert.rejects(turn({ model: 'gpt-oss:120b-cloud', messages: [], tools: [] }), /locally installed/);
});

test('a model without tool support falls back to one grounded prompt', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-runtime-'));
  const legacy = [];
  const { createOllamaTurn } = require('../app/agent-runtime');
  const orchestrator = createOrchestrator({
    dataDir, ollamaUrl: 'http://unused.invalid', defaultModel: 'llama3:8b',
    fetchWithTimeout: async () => ({ ok: true, json: async () => ({ models: [{ name: 'llama3:8b' }] }) }),
    runLocalModel: async (prompt, system) => { legacy.push(system); return 'Grounded finding [app/server.js]'; },
    runAgentTurn: createOllamaTurn({ ollamaUrl: 'http://x', fetchImpl: async () => ({ ok: false, status: 400, text: async () => '{"error":"registry.ollama.ai/library/llama3:8b does not support tools"}' }) }),
  });
  t.after(() => { orchestrator.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const mission = await orchestrator.mission('Review implementation', '', ['code_analyst']);
  assert.equal(mission.status, 'complete', mission.error);
  assert.equal(legacy.length, 2, 'specialist and coordinator both used the single-prompt path');
  assert.match(mission.results[0].toolFallback, /does not support tool calling/);
  assert.match(mission.toolFallback, /does not support tool calling/);
});
