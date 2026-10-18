// Live (18 Oct): the only specialist spent its 8 turns reading app/public/ui.js in pieces, two reads were refused as
// too large for the room left, and it never wrote anything; the Coordinator was then blocked and there was no answer.
// Now the last turn is for writing (no tools), a read fits the room left, and partial findings still reach the
// Coordinator. The model here is a fake Ollama over HTTP, driven through createOllamaTurn like the real one.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { createOllamaTurn, runAgentLoop, FINAL_TURN_PROMPT } = require('../app/agent-runtime');
const { createResearchTools, evidenceRecord } = require('../app/agent-tools');
const createOrchestrator = require('../app/agent-orchestrator');
const words = require('../app/public/agent-world-words');

// A fake /api/chat: `reply(body)` gets the parsed request and returns the assistant message.
async function fakeOllama(t, reply) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      const body = JSON.parse(raw);
      requests.push(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: { role: 'assistant', content: '', ...reply(body) } }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-final-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'public'));
  const lines = Array.from({ length: 400 }, (_, i) => `function part${i + 1}(){ return 'agent world polish line ${i + 1} ${'x'.repeat(60)}'; }`);
  fs.writeFileSync(path.join(root, 'public', 'ui.js'), lines.join('\n'));
  return root;
}

const readCall = (start, count = 120) => ({ tool_calls: [{ function: { name: 'read_project_file', arguments: { path: 'app/public/ui.js', start_line: start, max_lines: count } } }] });
const lastUser = body => [...body.messages].reverse().find(m => m.role === 'user')?.content || '';

test('a worker that keeps reading gets a last turn without tools, and its write-up is kept', async t => {
  const root = project(t);
  let reads = 0;
  const fake = await fakeOllama(t, body => {
    if (body.tools.length) return readCall(1 + 10 * reads++, 10);
    // The writing turn: cites the file it read by name, with no evidence ID.
    return { content: 'Findings: app/public/ui.js lines 1–30 define part1–part30; the polish lives there.' };
  });
  const events = [];
  const result = await runAgentLoop({
    model: 'test-model', system: 'S', prompt: 'Improve look and feel', turn: createOllamaTurn({ ollamaUrl: fake.url }),
    tools: createResearchTools({ projectRoot: root }), evidence: [evidenceRecord('app/public/ui.js', 'opening excerpt', { kind: 'source', title: 'app/public/ui.js' })],
    maxTurns: 4, onEvent: e => events.push(e),
  });
  assert.equal(fake.requests.length, 4);
  assert.deepEqual(fake.requests.map(r => r.tools.length > 0), [true, true, true, false], 'only the last turn has no tools');
  assert.equal(lastUser(fake.requests[3]), FINAL_TURN_PROMPT);
  assert.match(FINAL_TURN_PROMPT, /^Stop reading\. Write your findings now from what you have read, citing the files and lines you saw/);
  assert.match(result.answer, /^Findings: app\/public\/ui\.js/);
  assert.equal(result.finalTurn, true);
  assert.deepEqual(result.citedFiles, ['app/public/ui.js'], 'the shorter spelling of the same file is not listed twice');
  assert.equal(result.unsupported, undefined, 'naming the file it read counts as support');
  assert.ok(events.some(e => e.type === 'model_turn' && e.final));
});

test('a last-turn answer that cites nothing is kept, marked unsupported', async t => {
  const fake = await fakeOllama(t, body => body.tools.length ? readCall(1, 5) : { content: 'It could look nicer.' });
  const root = project(t);
  const result = await runAgentLoop({
    model: 'm', system: 'S', prompt: 'P', turn: createOllamaTurn({ ollamaUrl: fake.url }), tools: createResearchTools({ projectRoot: root }),
    evidence: [evidenceRecord('fixture', 'text')], maxTurns: 2,
  });
  assert.equal(result.answer, 'It could look nicer.');
  assert.equal(result.unsupported, true);
  assert.equal(result.confidence, 'low');
  assert.match(result.citationWarning, /does not cite/);
});

test('a close deadline also makes the next turn the writing turn', async t => {
  const fake = await fakeOllama(t, body => body.tools.length ? readCall(1, 5) : { content: 'Written early' });
  const result = await runAgentLoop({
    model: 'm', system: 'S', prompt: 'P', turn: createOllamaTurn({ ollamaUrl: fake.url }), tools: createResearchTools({ projectRoot: project(t) }),
    timeoutMs: 5000, finalTurnReserveMs: 5000,
  });
  assert.equal(result.answer, 'Written early');
  assert.equal(fake.requests[0].tools.length, 0);
});

test('a read too large for the room left returns the largest piece that fits, with a note', async t => {
  const root = project(t);
  const read = createResearchTools({ projectRoot: root }).find(x => x.name === 'read_project_file');
  const whole = await read.execute({ path: 'public/ui.js', start_line: 11, max_lines: 120 });
  assert.equal(whole.data.endLine, 130);
  assert.equal(whole.data.fitted, undefined);
  const fitted = await read.execute({ path: 'public/ui.js', start_line: 11, max_lines: 120 }, { maxChars: 3000 });
  assert.ok(JSON.stringify({ ok: true, ...fitted }).length <= 3000);
  assert.equal(fitted.data.startLine, 11);
  assert.ok(fitted.data.endLine > 11 && fitted.data.endLine < 130, `ended at ${fitted.data.endLine}`);
  assert.equal(fitted.data.fitted, true);
  assert.equal(fitted.data.note, `Showing lines 11–${fitted.data.endLine} of the 11–130 you asked for, to fit the room left; ask for the next part from line ${fitted.data.endLine + 1}`);
  assert.match(fitted.data.content, /^function part11\(\)/);
  assert.match(fitted.evidence[0].source, new RegExp(`#L11-L${fitted.data.endLine}$`));

  // In a run: the read that would have been refused comes back fitted, so no turn is spent asking again.
  const fake = await fakeOllama(t, body => body.messages.some(m => m.role === 'tool') ? { content: 'Done [' + JSON.stringify(body.messages).match(/E-[a-f0-9]{16}/)[0] + ']' } : readCall(1, 120));
  const events = [];
  const result = await runAgentLoop({ model: 'm', system: 'S', prompt: 'P', turn: createOllamaTurn({ ollamaUrl: fake.url }), tools: [read], maxContextChars: 8000, onEvent: e => events.push(e) });
  const toolResult = events.find(e => e.type === 'tool_result');
  assert.equal(toolResult.ok, true, toolResult.error);
  assert.equal(toolResult.data.fitted, true);
  assert.match(toolResult.data.note, /^Showing lines 1–\d+ of the 1–120 you asked for/);
  assert.match(result.answer, /^Done/);
  assert.equal(fake.requests.length, 2);
  assert.match(fake.requests[1].messages.find(m => m.role === 'tool').content, /"fitted":true/, 'the writing turn still sees the piece it read');
});

function missionFixture(t, reply, extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-final-mission-'));
  return fakeOllama(t, reply).then(fake => {
    const orchestrator = createOrchestrator({
      dataDir, ollamaUrl: fake.url, defaultModel: 'test-model', projectRoot: project(t),
      fetchWithTimeout: async () => ({ ok: true, json: async () => ({ models: [{ name: 'test-model' }] }) }),
      runLocalModel: async () => { throw new Error('unused'); },
      runAgentTurn: createOllamaTurn({ ollamaUrl: fake.url }), agentLimits: { maxTurns: 3 }, ...extra,
    });
    t.after(() => { orchestrator.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
    return { orchestrator, fake };
  });
}
const isCoordinator = body => body.messages[0].content.startsWith('You are the mission coordinator');

test('a specialist that stops with notes still lets the Coordinator answer; the mission completes with a note', async t => {
  let coordinatorPrompt = '';
  const { orchestrator } = await missionFixture(t, body => {
    if (isCoordinator(body)) {
      coordinatorPrompt = body.messages[1].content;
      return { content: 'Summary from the partial notes [' + coordinatorPrompt.match(/E-[a-f0-9]{16}/)[0] + ']; the UX review is incomplete.' };
    }
    // The specialist reads, says what it is looking at, and then writes nothing on its last turn.
    if (body.tools.length) return { content: 'Looking at the worker sprites first.', ...readCall(5, 10) };
    return { content: '' };
  });
  const mission = await orchestrator.mission('Improve look feel and polish of agent world', '', ['ux_analyst']);
  assert.equal(mission.status, 'complete', mission.error);
  assert.match(mission.answer, /^Summary from the partial notes/);
  const result = mission.results.find(r => r.agentId === 'ux_analyst');
  assert.equal(result.status, 'error');
  assert.equal(result.errorCode, 'AGENT_TURN_LIMIT');
  assert.equal(result.partial, true);
  assert.match(result.notes, /Looking at the worker sprites first\./);
  assert.match(result.notes, /ui\.js lines 5–14 \[E-[a-f0-9]{16}\]/);
  assert.match(coordinatorPrompt, /Some specialist work is partial or missing/);
  assert.match(coordinatorPrompt, /## UX Analyst \(partial findings: stopped before writing up\)\nLooking at the worker sprites/);
  const ux = mission.workers.find(w => w.id === 'ux_analyst');
  assert.equal(ux.state, 'complete');
  assert.equal(ux.partial, true);
  assert.equal(mission.workers.find(w => w.id === 'synthesis').state, 'complete');
  assert.equal(mission.note, 'UX Analyst finished with partial findings');
  assert.equal(words.workerStep(ux, mission), 'Finished with partial findings');
  assert.match(words.statusSentence(mission).text, /^Done .*· 3 workers · UX Analyst finished with partial findings$/);
  assert.equal(mission.timeline.at(-1).type, 'mission-complete');
  assert.ok(mission.timeline.some(e => e.workers.some(w => w.id === 'ux_analyst' && w.partial)));
});

test('an unsupported write-up is kept and marked partial; with nothing at all the mission needs you', async t => {
  const { orchestrator } = await missionFixture(t, body => {
    if (isCoordinator(body)) return { content: 'Summary [' + body.messages[1].content.match(/E-[a-f0-9]{16}/)[0] + ']' };
    return { content: 'It could look nicer.' };
  });
  const mission = await orchestrator.mission('Improve look feel and polish of agent world', '', ['ux_analyst']);
  assert.equal(mission.status, 'complete', mission.error);
  const result = mission.results[0];
  assert.equal(result.status, 'complete');
  assert.equal(result.partial, true);
  assert.equal(result.answer, 'It could look nicer.');
  assert.equal(mission.note, 'UX Analyst finished with partial findings');

  // A specialist that stops before reading or writing anything leaves the Coordinator nothing: the mission needs you.
  const empty = await missionFixture(t, body => isCoordinator(body) ? { content: 'unused' } : { content: '' });
  const stuck = await empty.orchestrator.mission('Improve look feel and polish of agent world', '', ['ux_analyst']);
  assert.equal(stuck.status, 'needs_attention');
  assert.equal(stuck.workers.find(w => w.id === 'synthesis').state, 'blocked');
});

test('the words: partial findings read as finished, and an old turn-limit error never shows raw', () => {
  const raw = 'Agent turn limit reached without a supported final answer';
  assert.equal(words.errorWords('AGENT_TURN_LIMIT', raw), 'ran out of steps before writing up');
  assert.equal(words.errorWords('', raw), 'ran out of steps before writing up');
  const t0 = '2026-10-18T10:00:00.000Z', t1 = '2026-10-18T10:03:00.000Z';
  const ux = { id: 'ux_analyst', name: 'UX Analyst', state: 'error', error: raw, errorCode: 'AGENT_TURN_LIMIT', dependsOn: ['router'] };
  const old = { status: 'needs_attention', error: 'Mission stopped after specialist failure', createdAt: t0, updatedAt: t1,
    workers: [{ id: 'router', name: 'Mission Router', state: 'complete' }, ux, { id: 'synthesis', name: 'Coordinator', state: 'blocked', dependsOn: ['ux_analyst'] }],
    results: [{ agentId: 'ux_analyst', status: 'error', error: raw, errorCode: 'AGENT_TURN_LIMIT' }] };
  assert.equal(words.workerStep(ux, old), 'Stopped: ran out of steps before writing up');
  const everything = JSON.stringify([words.statusSentence(old), words.storyEvents(old), words.summaryWhy(old), words.changeSentence(ux, old)]);
  assert.doesNotMatch(everything, /turn limit/i);

  const partial = { ...ux, state: 'complete', partial: true };
  const done = { ...old, status: 'complete', answer: 'Summary', workers: [old.workers[0], partial, { ...old.workers[2], state: 'complete' }] };
  assert.equal(words.workerStep(partial, done), 'Finished with partial findings');
  assert.equal(words.changeSentence(partial, done), 'UX Analyst finished with partial findings');
  assert.deepEqual(words.stateBadge('partial'), { label: 'Partly done', tone: 'neutral' });
  assert.equal(words.missionNote(done), 'UX Analyst finished with partial findings');
  assert.equal(words.statusSentence(done).tone, 'done');
  assert.match(words.statusSentence(done).text, /^Done in 3 min · 3 workers · UX Analyst finished with partial findings$/);
  // A worker that stopped outright in a mission that still finished is part of its note, not "Needs you".
  const stoppedButDone = { ...done, workers: [old.workers[0], ux, { id: 'code_analyst', name: 'Code Analyst', state: 'complete' }, { ...old.workers[2], state: 'complete' }] };
  assert.equal(words.statusSentence(stoppedButDone).tone, 'done');
  assert.equal(words.missionNote(stoppedButDone), 'UX Analyst stopped: ran out of steps before writing up');
});
