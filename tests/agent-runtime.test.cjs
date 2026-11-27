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

// Run telemetry: what each model turn and tool call cost, and what the run cost in all. A token count the model
// did not report is unknown (null), never 0.
const { createOllamaTurn, createModelQueue, withTurnUsage } = require('../app/agent-runtime');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const USAGE_KEYS = ['turns', 'toolCalls', 'toolErrors', 'toolRefusals', 'compactions', 'compactedResults', 'toolResultChars', 'peakContextChars', 'modelMs', 'toolMs', 'promptTokens', 'outputTokens'];
const ollamaBody = (message, counters = {}) => ({ ok: true, body: [Buffer.from(JSON.stringify({ model: 'm', message, done: true, ...counters }))] });

test('ollama counters reach the run without entering the conversation', async () => {
  const record = evidenceRecord('fixture', 'fixture text');
  const lookup = tool('lookup', 'Lookup', {}, [], async () => ({ data: {}, evidence: [record] }));
  const sent = [], events = [];
  const counters = { prompt_eval_count: 120, eval_count: 30, total_duration: 2000000000, load_duration: 500000000, prompt_eval_duration: 1000000000, eval_duration: 400000000 };
  const turn = createOllamaTurn({ ollamaUrl: 'http://x', fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push(body.messages);
    return body.messages.at(-1).role === 'user'
      ? ollamaBody({ role: 'assistant', content: '', tool_calls: [{ function: { name: 'lookup', arguments: {} } }] }, counters)
      : ollamaBody({ role: 'assistant', content: `Done [${record.id}]` }, counters);
  } });
  const bare = await turn({ model: 'm', messages: [{ role: 'user', content: 'p' }], tools: [] });
  assert.deepEqual(Object.keys(bare), ['role', 'content', 'tool_calls'], 'the message itself gains no field');
  sent.length = 0;
  const result = await runAgentLoop({ model: 'm', system: 's', prompt: 'p', tools: [lookup], turn, onEvent: e => events.push(e) });
  assert.deepEqual(Object.keys(sent[1][2]).sort(), ['content', 'role', 'tool_calls'], 'the assistant message sent back carries no usage');
  assert.doesNotMatch(JSON.stringify(sent), /usage|promptTokens|prompt_eval_count|eval_duration/);
  assert.deepEqual(events.filter(e => e.type === 'model_turn'), [{ type: 'model_turn', turn: 1 }, { type: 'model_turn', turn: 2 }], 'the start event keeps its shape');
  const done = events.filter(e => e.type === 'model_turn_done');
  assert.equal(done.length, 2);
  assert.deepEqual(done.map(e => e.turn), [1, 2]);
  for (const [i, e] of done.entries()) {
    assert.equal(e.promptTokens, 120);
    assert.equal(e.outputTokens, 30);
    assert.equal(e.contextChars, JSON.stringify(sent[i]).length, 'the size of the messages sent');
    assert.ok(Number.isSafeInteger(e.durationMs) && e.durationMs >= 0);
    assert.deepEqual([e.modelTotalMs, e.modelLoadMs, e.promptEvalMs, e.evalMs], [2000, 500, 1000, 400]);
  }
  assert.equal(result.usage.promptTokens, 240);
  assert.equal(result.usage.outputTokens, 60);
  assert.equal(result.usage.turns, 2);
});

test('tool results carry their duration and size, and refused calls are marked', async () => {
  const record = evidenceRecord('fixture', 'fixture text');
  const slow = tool('slow', 'Slow', {}, [], async () => { await sleep(40); return { data: { text: 'x'.repeat(500) }, evidence: [record] }; });
  const broken = tool('broken', 'Broken', {}, [], async () => { throw new Error('boom'); });
  const call = name => ({ function: { name, arguments: {} } });
  const events = [];
  let toolMessages;
  const result = await runAgentLoop({
    model: 'm', system: 's', prompt: 'p', tools: [slow, broken], maxToolCalls: 2, onEvent: e => events.push(e),
    turn: async ({ messages }) => {
      if (messages.at(-1).role === 'user') return { role: 'assistant', content: '', tool_calls: [call('slow'), call('broken'), call('slow')] };
      toolMessages = messages.filter(m => m.role === 'tool');
      return { role: 'assistant', content: `Done [${record.id}]` };
    },
  });
  const results = events.filter(e => e.type === 'tool_result');
  assert.equal(results.length, 3);
  assert.deepEqual(results.map(e => e.resultChars), toolMessages.map(m => m.content.length), 'the size of the JSON put into the context');
  assert.ok(results[0].durationMs >= 35, `slow tool took ${results[0].durationMs} ms`);
  assert.ok(results.every(e => Number.isSafeInteger(e.durationMs) && e.durationMs >= 0));
  assert.deepEqual(results.map(e => e.refused === true), [false, false, true]);
  assert.deepEqual(results.map(e => e.ok), [true, false, false]);
  assert.equal(results[2].durationMs, 0, 'a refused call never ran');
  const u = result.usage;
  assert.deepEqual([u.toolCalls, u.toolErrors, u.toolRefusals], [2, 1, 1]);
  assert.equal(u.toolResultChars, toolMessages.reduce((n, m) => n + m.content.length, 0));
  assert.ok(u.toolMs >= 35 && u.toolMs === results.reduce((n, e) => n + e.durationMs, 0));
});

test('compacting older tool results is reported with how many were replaced', async () => {
  const record = evidenceRecord('fixture', 'fixture text');
  const big = tool('big', 'Big', {}, [], async () => ({ data: { text: 'x'.repeat(3000) }, evidence: [record] }));
  const events = [];
  let n = 0;
  const result = await runAgentLoop({
    model: 'm', system: 's', prompt: 'p', tools: [big], maxContextChars: 6000, onEvent: e => events.push(e),
    turn: async () => (++n <= 2 ? { role: 'assistant', content: '', tool_calls: [{ function: { name: 'big', arguments: {} } }] } : { role: 'assistant', content: `Done [${record.id}]` }),
  });
  const compacted = events.filter(e => e.type === 'context_compacted');
  assert.equal(compacted.length, 1);
  assert.equal(compacted[0].replaced, 1);
  assert.equal(compacted[0].turn, 2);
  assert.ok(Number.isSafeInteger(compacted[0].contextChars) && compacted[0].contextChars < 6000);
  assert.ok(events.findIndex(e => e.type === 'context_compacted') < events.findLastIndex(e => e.type === 'tool_result'), 'reported before the result that needed the room');
  assert.equal(result.usage.compactions, 1);
  assert.equal(result.usage.compactedResults, 1);
  const sentSizes = events.filter(e => e.type === 'model_turn_done').map(e => e.contextChars);
  assert.equal(result.usage.peakContextChars, Math.max(...sentSizes));
  assert.ok(result.usage.peakContextChars <= 6000);
});

test('a model turn\'s duration leaves out the wait for another worker\'s turn', async () => {
  const modelQueue = createModelQueue();
  const held = await modelQueue.acquire();
  setTimeout(held, 120);
  const events = [];
  const started = Date.now();
  const result = await runAgentLoop({ model: 'm', system: 's', prompt: 'p', modelQueue, onEvent: e => events.push(e), turn: async () => { await sleep(30); return { role: 'assistant', content: 'Answer' }; } });
  assert.ok(Date.now() - started >= 140, 'the run did wait');
  const done = events.find(e => e.type === 'model_turn_done');
  assert.ok(done.durationMs >= 25 && done.durationMs < 100, `turn took ${done.durationMs} ms`);
  assert.equal(result.usage.modelMs, done.durationMs);
});

test('the turn durations reported add up to the run\'s model time exactly', async t => {
  // A clock that moves on every reading: a duration read twice would give two different numbers.
  const realNow = Date.now;
  let ticks = 0;
  Date.now = () => realNow() + (ticks += 7);
  t.after(() => { Date.now = realNow; });
  const lookup = tool('lookup', 'Lookup', {}, [], async () => ({ data: {} }));
  const events = [];
  let n = 0;
  const result = await runAgentLoop({ model: 'm', system: 's', prompt: 'p', tools: [lookup], onEvent: e => events.push(e),
    turn: async () => (++n < 4 ? { role: 'assistant', content: '', tool_calls: [{ function: { name: 'lookup', arguments: {} } }] } : { role: 'assistant', content: 'Answer' }) });
  Date.now = realNow;
  const done = events.filter(e => e.type === 'model_turn_done');
  assert.equal(done.length, 4);
  assert.equal(result.usage.modelMs, done.reduce((sum, e) => sum + e.durationMs, 0));
  assert.equal(result.usage.toolMs, events.filter(e => e.type === 'tool_result').reduce((sum, e) => sum + e.durationMs, 0));
});

test('a turn that reports no token count is unknown, and one unknown turn makes the run total unknown', async () => {
  const run = async usages => {
    const events = [];
    let n = 0;
    const lookup = tool('lookup', 'Lookup', {}, [], async () => ({ data: {} }));
    const result = await runAgentLoop({
      model: 'm', system: 's', prompt: 'p', tools: [lookup], onEvent: e => events.push(e),
      turn: async () => {
        const usage = usages[n++];
        const message = n < usages.length ? { role: 'assistant', content: '', tool_calls: [{ function: { name: 'lookup', arguments: {} } }] } : { role: 'assistant', content: 'Answer' };
        return usage ? withTurnUsage(message, usage) : message;
      },
    });
    return { result, done: events.filter(e => e.type === 'model_turn_done') };
  };
  // No count at all: a custom turn that returns a bare message.
  const none = await run([null, null]);
  assert.deepEqual(none.done.map(e => [e.promptTokens, e.outputTokens]), [[null, null], [null, null]]);
  assert.equal(none.result.usage.promptTokens, null);
  assert.equal(none.result.usage.outputTokens, null);
  assert.equal(none.result.usage.turns, 2, 'what was counted is still counted');
  assert.deepEqual(Object.keys(none.result.usage), USAGE_KEYS);
  // Mixed: one turn counted, one not. The total is unknown, not the part that was counted.
  const mixed = await run([{ promptTokens: 100, outputTokens: 20 }, null]);
  assert.deepEqual(mixed.done.map(e => [e.promptTokens, e.outputTokens]), [[100, 20], [null, null]]);
  assert.equal(mixed.result.usage.promptTokens, null);
  assert.equal(mixed.result.usage.outputTokens, null);
  // Each count stands alone: the prompt count missing on one turn leaves the output total known.
  const half = await run([{ promptTokens: 100, outputTokens: 20 }, { outputTokens: 5 }]);
  assert.equal(half.result.usage.promptTokens, null);
  assert.equal(half.result.usage.outputTokens, 25);
  // Not a non-negative integer: unknown.
  for (const bad of [-1, 1.5, '12', NaN, null]) {
    const r = await run([{ promptTokens: bad, outputTokens: bad }]);
    assert.deepEqual([r.done[0].promptTokens, r.done[0].outputTokens], [null, null], String(bad));
    assert.equal(r.result.usage.promptTokens, null, String(bad));
  }
  // Every turn counted: a real total, and zero is a count.
  const all = await run([{ promptTokens: 100, outputTokens: 0 }, { promptTokens: 150, outputTokens: 7 }]);
  assert.equal(all.result.usage.promptTokens, 250);
  assert.equal(all.result.usage.outputTokens, 7);
});

test('an older Ollama that sends no counters leaves the token counts unknown', async () => {
  const events = [];
  const turn = createOllamaTurn({ ollamaUrl: 'http://x', fetchImpl: async () => ollamaBody({ role: 'assistant', content: 'Answer' }) });
  const result = await runAgentLoop({ model: 'm', system: 's', prompt: 'p', turn, onEvent: e => events.push(e) });
  const done = events.find(e => e.type === 'model_turn_done');
  assert.deepEqual([done.promptTokens, done.outputTokens, done.modelTotalMs, done.evalMs], [null, null, null, null]);
  assert.deepEqual([result.usage.promptTokens, result.usage.outputTokens], [null, null]);
});

test('a run that stops keeps its usage on error.partial and reports it as an event', async () => {
  const record = evidenceRecord('fixture', 'fixture text');
  const lookup = tool('lookup', 'Lookup', {}, [], async () => ({ data: {}, evidence: [record] }));
  const events = [];
  let n = 0;
  const error = await runAgentLoop({
    model: 'm', system: 's', prompt: 'p', tools: [lookup], onEvent: e => events.push(e),
    turn: async () => {
      if (++n === 1) return withTurnUsage({ role: 'assistant', content: 'Looking', tool_calls: [{ function: { name: 'lookup', arguments: {} } }] }, { promptTokens: 50, outputTokens: 5 });
      throw new Error('model went away');
    },
  }).then(() => null, e => e);
  assert.match(error.message, /model went away/);
  const u = error.partial.usage;
  assert.deepEqual(Object.keys(u), USAGE_KEYS);
  assert.deepEqual([u.turns, u.toolCalls, u.toolErrors, u.toolRefusals], [2, 1, 0, 0]);
  assert.equal(u.promptTokens, null, 'the turn that failed spent tokens nobody counted');
  assert.equal(u.outputTokens, null);
  assert.equal(events.at(-1).type, 'run_usage');
  assert.deepEqual(events.at(-1).usage, u);
  // A finished run reports the same summary it returns.
  const ok = [];
  const result = await runAgentLoop({ model: 'm', system: 's', prompt: 'p', onEvent: e => ok.push(e), turn: async () => ({ role: 'assistant', content: 'Answer' }) });
  assert.equal(ok.at(-1).type, 'run_usage');
  assert.deepEqual(ok.at(-1).usage, result.usage);
  assert.equal(ok.filter(e => e.type === 'run_usage').length, 1);
});

test('usage totals: nothing ran is zeros, an unknown run is unknown', () => {
  const { sumUsage } = require('../app/agent-runtime');
  const zeros = Object.fromEntries(USAGE_KEYS.map(key => [key, 0])), unknown = Object.fromEntries(USAGE_KEYS.map(key => [key, null]));
  assert.deepEqual(sumUsage([]), zeros, 'no run happened');
  assert.deepEqual(sumUsage([null]), unknown);
  assert.deepEqual(sumUsage([zeros, null]), unknown);
  assert.deepEqual(sumUsage([{ ...zeros, turns: 2, peakContextChars: 50 }, { ...zeros, turns: 1, peakContextChars: 90, promptTokens: null }]), { ...zeros, turns: 3, peakContextChars: 90, promptTokens: null });
});

test('a covered total sums the runs whose usage is known and names the ones it leaves out', () => {
  const { sumCountedUsage } = require('../app/agent-runtime');
  const zeros = Object.fromEntries(USAGE_KEYS.map(key => [key, 0])), unknown = Object.fromEntries(USAGE_KEYS.map(key => [key, null]));
  const a = { ...zeros, turns: 2, promptTokens: 100, peakContextChars: 50 }, b = { ...zeros, turns: 1, promptTokens: 7, peakContextChars: 90 };
  assert.deepEqual(sumCountedUsage([]), { ...zeros, counted: [], uncounted: [] }, 'no run happened');
  assert.deepEqual(sumCountedUsage([{ id: 'a', usage: a }, { id: 'b', usage: b }]), { ...zeros, turns: 3, promptTokens: 107, peakContextChars: 90, counted: ['a', 'b'], uncounted: [] });
  assert.deepEqual(sumCountedUsage([{ id: 'a', usage: a }, { id: 'cloud', usage: null }, { id: 'b', usage: b }]),
    { ...zeros, turns: 3, promptTokens: 107, peakContextChars: 90, counted: ['a', 'b'], uncounted: ['cloud'] }, 'the unknown run is named, not added as 0 and not hiding the rest');
  assert.deepEqual(sumCountedUsage([{ id: 'a', usage: a }, { id: 'b', usage: { ...b, promptTokens: null } }]),
    { ...zeros, turns: 3, promptTokens: null, peakContextChars: 90, counted: ['a', 'b'], uncounted: [] }, 'a count a counted run could not read stays unknown');
  assert.deepEqual(sumCountedUsage([{ id: 'x', usage: null }, { id: 'y', usage: undefined }, { id: 'z', usage: 'bad' }]),
    { ...unknown, counted: [], uncounted: ['x', 'y', 'z'] }, 'runs happened and none was counted: unknown, never zeros');
});
