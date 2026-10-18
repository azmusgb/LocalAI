// Missions wait for the model: no hidden 5-minute limit on model calls (model-http.js), one model turn at a time
// across workers (agent-runtime.js createModelQueue), and a first-turn evidence budget (mission-evidence.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { modelFetch, modelFetchWithTimeout } = require('../app/model-http');
const { createOllamaTurn, createModelQueue, runAgentLoop } = require('../app/agent-runtime');
const { fitEvidence, evidenceTokenBudget } = require('../app/mission-evidence');
const words = require('../app/public/agent-world-words');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const answer = content => JSON.stringify({ message: { role: 'assistant', content } });

async function serve(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  return `http://127.0.0.1:${server.address().port}`;
}

// Ollama sends nothing, not even headers, until it has read the whole prompt. Node's own fetch stops waiting after
// 300 s (undici headersTimeout); modelFetch waits exactly as long as its caller allows. Scaled down here: headers
// after 1.2 s, then a 1.2 s silence mid-body.
const slowModel = (headerMs, gapMs) => (req, res) => {
  req.resume();
  req.on('end', async () => {
    await sleep(headerMs);
    if (res.destroyed) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const body = answer('Waited answer');
    res.write(body.slice(0, 10));
    await sleep(gapMs);
    if (!res.destroyed) res.end(body.slice(10));
  });
};

test('a model call waits past a late first byte and a silent body, as long as the caller allows', { timeout: 20000 }, async t => {
  const url = await serve(t, slowModel(1200, 1200));
  const started = Date.now();
  const r = await modelFetchWithTimeout(url + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, 6000);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).message.content, 'Waited answer');
  assert.ok(Date.now() - started >= 2300, 'it really waited for both delays');
});

test('the caller’s deadline is the only limit, and its timeout reads as a busy computer', { timeout: 20000 }, async t => {
  const url = await serve(t, slowModel(1500, 0));
  const started = Date.now();
  const error = await modelFetchWithTimeout(url + '/api/chat', { method: 'POST', body: '{}' }, 400).then(() => null, e => e);
  assert.ok(error, 'the short deadline stopped the call');
  assert.ok(Date.now() - started < 1400, 'stopped at the deadline, not when the server answered');
  assert.equal(error.code, 'MODEL_TIMEOUT');
  assert.equal(words.errorWords(error.code, error.message), 'the model took too long to start answering (the computer was busy)');

  // A caller's own abort wins, with the caller's reason.
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error('Run cancelled')), 200);
  await assert.rejects(modelFetch(url + '/api/chat', { method: 'POST', body: '{}', signal: controller.signal }), /Run cancelled/);
});

test('a deadline that ends mid-body stops the read', { timeout: 20000 }, async t => {
  const url = await serve(t, slowModel(0, 2000));
  const r = await modelFetchWithTimeout(url + '/api/chat', { method: 'POST', body: '{}' }, 500);
  await assert.rejects(r.text(), e => e.code === 'MODEL_TIMEOUT');
});

test('a refused connection says Ollama wasn’t answering, never "fetch failed"', async () => {
  const probe = net.createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(r => probe.close(r));
  const error = await modelFetch(`http://127.0.0.1:${port}/api/chat`, { method: 'POST', body: '{}' }).then(() => null, e => e);
  assert.equal(error.code, 'MODEL_UNREACHABLE');
  assert.match(error.message, /ECONNREFUSED/, 'keeps the code, so the transient-retry check still matches');
  assert.doesNotMatch(error.message, /fetch failed/);
  assert.equal(words.errorWords(error.code, error.message), 'Ollama wasn’t answering');
});

test('agent turns use modelFetch by default, so a slow first byte doesn’t end the mission', { timeout: 20000 }, async t => {
  let seen;
  const url = await serve(t, (req, res) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', async () => { seen = JSON.parse(raw); await sleep(1200); res.writeHead(200); res.end(answer('Slow but here')); });
  });
  const turn = createOllamaTurn({ ollamaUrl: url, numCtx: 12288 });
  const result = await runAgentLoop({ model: 'test-model', system: 'S', prompt: 'P', turn, timeoutMs: 5000 });
  assert.equal(result.answer, 'Slow but here');
  assert.equal(seen.options.num_ctx, 12288);
  assert.equal(seen.stream, false);
});

// A fake Ollama that, like the real one on the 6 GB GPU, works on one request at a time.
function serialModel(workMs) {
  let chain = Promise.resolve();
  const log = [];
  const handler = (req, res) => {
    req.resume();
    req.on('end', () => {
      chain = chain.then(async () => {
        if (res.destroyed) return; // a client that gave up no longer holds the model
        log.push('start');
        await sleep(workMs);
        if (!res.destroyed) { res.writeHead(200); res.end(answer('Done')); }
      });
    });
  };
  return { handler, log };
}

async function twoWorkers(url, modelQueue, timeoutMs) {
  const turn = createOllamaTurn({ ollamaUrl: url });
  const events = [];
  const run = name => runAgentLoop({ model: 'm', system: 'S', prompt: name, turn, timeoutMs, modelQueue, onEvent: e => events.push({ name, ...e }) });
  const results = await Promise.allSettled([run('a'), run('b')]);
  return { results, events };
}

test('two workers on one model: in parallel the second times out, through the queue both finish', { timeout: 20000 }, async t => {
  const fake = serialModel(600);
  const url = await serve(t, fake.handler);
  // Each turn takes 600 ms of model time; each worker allows 1000 ms.
  const parallel = await twoWorkers(url, null, 1000);
  assert.deepEqual(parallel.results.map(r => r.status), ['fulfilled', 'rejected'], 'the second worker spent its time waiting inside the model');
  assert.equal(parallel.results[1].reason.code, 'AGENT_TIMEOUT');
  await sleep(700); // let the fake finish the abandoned request

  const queued = await twoWorkers(url, createModelQueue({ concurrency: 1 }), 1000);
  assert.deepEqual(queued.results.map(r => r.status), ['fulfilled', 'fulfilled'], 'waiting in the queue doesn’t spend a worker’s time');
  assert.ok(queued.events.some(e => e.name === 'b' && e.type === 'model_queue' && e.ahead === 1), 'the waiting worker says it is waiting');
});

test('the model queue lets one turn through at a time and drops a cancelled wait', async () => {
  const queue = createModelQueue();
  const first = await queue.acquire();
  const controller = new AbortController();
  const cancelled = queue.acquire(controller.signal);
  const third = queue.acquire();
  assert.equal(queue.waiting, 2);
  controller.abort(new Error('stop'));
  await assert.rejects(cancelled, /stop/);
  assert.equal(queue.waiting, 1);
  first();
  first(); // releasing twice is harmless
  const release = await third;
  assert.equal(queue.active, 1);
  release();
  assert.equal(queue.active, 0);
});

test('older tool results give way before a run hits its context limit', async () => {
  const big = 'x'.repeat(4000);
  let turns = 0;
  const reader = { name: 'read', definition: { type: 'function', function: { name: 'read' } }, execute: async () => ({ data: big }) };
  const turn = async ({ messages }) => {
    turns++;
    assert.ok(JSON.stringify(messages).length <= 9000, 'every turn fits the context');
    if (turns <= 3) return { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read', arguments: {} } }] };
    return { role: 'assistant', content: 'Read it all' };
  };
  const result = await runAgentLoop({ model: 'm', system: 'S', prompt: 'P', turn, tools: [reader], maxContextChars: 9000 });
  assert.equal(result.answer, 'Read it all');
  assert.equal(turns, 4);
});

test('first-turn evidence keeps the most relevant sources whole and cuts the rest to the budget', () => {
  const blocks = ['A'.repeat(1000), 'B'.repeat(1000), 'C'.repeat(3000), 'D'.repeat(100)];
  const fit = fitEvidence(blocks, 3000);
  assert.equal(fit.kept, 3);
  assert.equal(fit.blocks[0], blocks[0]);
  assert.equal(fit.blocks[1], blocks[1]);
  assert.match(fit.blocks[2], /^C+ …$/, 'the third source is cut, not dropped');
  assert.ok(fit.blocks.join('\n\n').length <= 3000);
  assert.equal(fit.chars, fit.blocks.join('\n\n').length);
  assert.ok(!fit.blocks.some(b => b.startsWith('D')), 'less relevant sources after the cut wait for the tools');
  // Too little room left to be worth reading: stop at the whole sources.
  assert.equal(fitEvidence(['A'.repeat(2500), 'B'.repeat(5000)], 3000).kept, 1);
  // The budget: 6000 tokens by default, configurable, never more than the mission context leaves room for.
  assert.equal(evidenceTokenBudget(undefined, 12288), 6000);
  assert.equal(evidenceTokenBudget(3000, 12288), 3000);
  assert.equal(evidenceTokenBudget(20000, 12288), 12288 - 5000);
  assert.equal(evidenceTokenBudget(6000, 8192), 8192 - 5000);
});

test('a mission worker’s first prompt fits the evidence budget', async t => {
  const createOrchestrator = require('../app/agent-orchestrator');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-budget-'));
  const prompts = [];
  const orchestrator = createOrchestrator({
    dataDir, ollamaUrl: 'http://unused.invalid', defaultModel: 'test-model',
    fetchWithTimeout: async () => ({ ok: true, json: async () => ({ models: [{ name: 'test-model' }] }) }),
    runLocalModel: async () => { throw new Error('unused'); },
    evidenceTokens: 2000, numCtx: 12288,
    runAgentTurn: async ({ messages }) => {
      prompts.push(messages[1].content);
      const id = JSON.stringify(messages).match(/E-[a-f0-9]{16}/)?.[0] || '';
      return { role: 'assistant', content: 'Finding ' + (id ? '[' + id + ']' : '') };
    },
  });
  t.after(() => { orchestrator.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const run = await orchestrator.specialist('ux_analyst', 'Improve look feel and polish of agent world', '', 'test-model');
  assert.equal(run.status, 'complete', run.error);
  const evidence = prompts[0].split('Authoritative project evidence:\n')[1].split('\n\nInvestigate missing facts')[0];
  assert.ok(evidence.length <= 2000 * 4, `opening evidence is ${evidence.length} chars`);
  assert.ok(run.openingEvidence.sources >= 1 && run.openingEvidence.sources < run.openingEvidence.of, JSON.stringify(run.openingEvidence));
  assert.equal(run.openingEvidence.budgetChars, 8000);
});
