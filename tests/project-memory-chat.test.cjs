'use strict';

// A chat turn in a project, as the server runs it (app/server/chat.js chatOnce): the project's notes reach this PC's
// model in their marked block, the run is private (cloud switched on, keys present, "Use a bigger model" asked for),
// the conversation stays private, and the run keeps which notes it used. The model is a fake HTTP answer; the
// coordinator, ledger and storage are the real ones.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Storage } = require('../app/storage');
const { RunLedger } = require('../app/run-ledger');
const modelRouter = require('../app/model-router');
const { createCoordinator } = require('../app/model-coordinator');
const { fitMessages } = require('../app/text-context');
const { createChat } = require('../app/server/chat');
const { createRuns } = require('../app/server/runs');
const { runCard } = require('../app/run-cards');
const PM = require('../app/project-memory');

const PROJECT = { id: 'prj_rift', name: 'RIFT tiles', createdAt: '2026-11-01T00:00:00.000Z' };

function setup(t, { notes = null, projects = null, search = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-memory-chat-'));
  const storage = new Storage({ dataDir: dir });
  t.after(() => { storage.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const runLedger = new RunLedger({ storage });
  for (const p of [PROJECT, { id: 'prj_quiet', name: 'Quiet', notesInChat: false }]) storage.upsert('projects', p);
  for (const n of [
    { id: 'mem_layer', projectId: 'prj_rift', category: 'decision', text: 'Layer height is 0.2 mm', pinned: true, createdAt: '2026-11-02T00:00:00.000Z' },
    { id: 'mem_petg', projectId: 'prj_rift', category: 'note', text: 'Tiles are PETG', pinned: false, createdAt: '2026-11-03T00:00:00.000Z' },
    { id: 'mem_quiet', projectId: 'prj_quiet', category: 'note', text: 'Quiet note', pinned: false, createdAt: '2026-11-03T00:00:00.000Z' },
  ]) storage.upsert('memory', n);
  const cloudCalls = [];
  const coordinator = createCoordinator({ modelRouter, routingSetting: () => ({ cloud: true }), localModel: 'qwen3:4b', cloudModels: { keys: () => ({ groq: true, cerebras: true }), parked: () => ({}), chat: async a => { cloudCalls.push(a); return { content: 'From the cloud' }; } } });
  const sent = [];
  const modelFetchWithTimeout = async (url, opts) => { sent.push({ url, body: JSON.parse(opts.body) }); return new Response(JSON.stringify({ message: { content: 'It is 0.2 mm.' } }), { status: 200 }); };
  const projectStore = projects || (() => storage.list('projects'));
  const searches = [];
  // The real createChatExecution (app/server/runs.js), with what it reads.
  const sanitizeMessages = list => (Array.isArray(list) ? list : []).filter(m => m && ['user', 'assistant', 'system'].includes(m.role) && typeof m.content === 'string').map(m => ({ role: m.role, content: m.content }));
  const { createChatExecution } = createRuns({ MODEL: 'qwen3:4b', cleanRunId: v => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(v) ? v : null), projectStore, runLedger, sanitizeMessages, titleFromText: (s, d) => String(s || d).slice(0, 60) });
  const chat = createChat({
    ANSWER_RESERVE: 1024, CHAT_MODEL_TIMEOUT_MS: 1000, MODEL: 'qwen3:4b', OLLAMA_URL: 'http://ollama.test', coordinator, TEXT_KEEP_ALIVE: '30m', TEXT_NUM_CTX: 8192,
    aboutApplianceBlock: () => '', accessAddresses: () => [], activeRunControllers: new Map(), capabilityPrompt: () => '', createChatExecution, fitMessages,
    getCapabilitiesSnapshot: async () => ({}), isAboutLocalAi: () => false, json: () => {}, keepLongAnswer: () => {}, modelFetch: modelFetchWithTimeout, modelFetchWithTimeout,
    projectNotes: notes || (id => storage.list('memory', { projectId: id })), projectStore, readBody: async () => ({}), recordActivity: () => {}, recordTurnArtifact: () => null,
    runLedger, sanitizeMessages, searxSearch: async q => { searches.push(q); return search; }, selfChange: { isSelfChange: () => false }, storageError: () => {},
    voiceFacts: () => '', voiceTimeZone: () => 'UTC'
  });
  return { storage, runLedger, chat, sent, cloudCalls, searches };
}
const ask = (content, extra = {}) => ({ messages: [{ role: 'user', content }], bigger: true, ...extra });
const hasBlock = messages => messages.some(m => m.content.includes(PM.OPEN));

// A first turn, then the owner files it under the project (POST /api/runs/update does runLedger.file).
async function filedThread(env, projectId = 'prj_rift') {
  const first = await env.chat.chatOnce(ask('Compare PETG and ASA for outdoor parts'));
  env.runLedger.file(first.runId, { projectId });
  return first;
}

test('an unfiled first turn gets no notes and is routed as before (cloud with "Use a bigger model")', async t => {
  const env = setup(t);
  const out = await env.chat.chatOnce(ask('Compare PETG and ASA for outdoor parts'));
  assert.equal(out.route.provider, 'groq');
  assert.equal(env.cloudCalls.length, 1);
  assert.ok(!hasBlock(env.cloudCalls[0].messages));
  const run = env.runLedger.get(out.runId);
  assert.equal(run.meta.memoryNotes, undefined);
  assert.equal(runCard(run).memory, null);
});

test('a turn in a filed thread: the notes reach this PC in the block, private with "Use a bigger model", and the run keeps the ids', async t => {
  const env = setup(t);
  const first = await filedThread(env);
  const out = await env.chat.chatOnce({ ...ask('What layer height did we settle on?'), threadId: first.runId, messages: [{ role: 'user', content: 'Compare PETG and ASA for outdoor parts' }, { role: 'assistant', content: 'From the cloud' }, { role: 'user', content: 'What layer height did we settle on?' }] });
  assert.equal(env.cloudCalls.length, 1, 'only the unfiled first turn went to the cloud');
  assert.deepEqual(out.route, { provider: 'ollama', model: 'qwen3:4b', class: 'private', why: PM.STAY });
  assert.equal(env.sent.length, 1);
  const msgs = env.sent[0].body.messages;
  assert.equal(env.sent[0].body.tools, undefined, 'no tools');
  assert.equal(msgs[0].role, 'system');
  assert.equal(msgs[1].role, 'system');
  assert.ok(msgs[1].content.includes(PM.OPEN) && msgs[1].content.includes(PM.CLOSE));
  const block = msgs[1].content.slice(msgs[1].content.indexOf(`${PM.OPEN}\n`));
  assert.ok(block.indexOf('Layer height is 0.2 mm') < block.indexOf('Tiles are PETG'), 'pinned first');
  assert.ok(!msgs[1].content.includes('Quiet note'), "another project's notes stay out");
  assert.equal(msgs.at(-1).content, 'What layer height did we settle on?');
  const run = env.runLedger.get(out.runId);
  assert.deepEqual(run.meta.memoryNotes, ['mem_layer', 'mem_petg']);
  assert.deepEqual(run.meta.memoryProject, { id: 'prj_rift', name: 'RIFT tiles' });
  assert.deepEqual(run.meta.privacy, { class: 'private', why: PM.STAY });
  assert.equal(modelRouter.stickyPrivate(run.meta.privacy), true, 'the reason holds for the conversation');
  const card = runCard(run);
  assert.equal(card.route.text, 'Answered on this PC');
  assert.equal(card.route.why, PM.STAY);
  assert.deepEqual(card.memory, { text: 'Used 2 notes from RIFT tiles', projectId: 'prj_rift', count: 2, unread: false });
});

test('sticky: after the chat is unfiled, its next turn still stays on this PC (but carries no notes)', async t => {
  const env = setup(t);
  const first = await filedThread(env);
  const second = await env.chat.chatOnce({ ...ask('What layer height?'), threadId: first.runId });
  assert.equal(second.route.why, PM.STAY);
  env.runLedger.file(first.runId, { projectId: null });
  const third = await env.chat.chatOnce({ ...ask('And the infill?'), threadId: first.runId });
  assert.equal(third.route.provider, 'ollama');
  assert.equal(third.route.class, 'private');
  assert.equal(third.route.why, 'This conversation was kept on this PC');
  assert.equal(env.cloudCalls.length, 1, 'still only the first turn');
  assert.ok(!hasBlock(env.sent.at(-1).body.messages));
  assert.equal(env.runLedger.get(third.runId).meta.memoryNotes, undefined);
});

test('a request that carries projectId gets the notes on its first turn and is filed under the project', async t => {
  const env = setup(t);
  const out = await env.chat.chatOnce(ask('What layer height did we settle on?', { projectId: 'prj_rift' }));
  assert.equal(out.route.why, PM.STAY);
  assert.ok(hasBlock(env.sent[0].body.messages));
  const run = env.runLedger.get(out.runId);
  assert.equal(run.projectId, 'prj_rift');
  assert.equal(env.runLedger.getInternal(out.runId).retryRequest.body.projectId, 'prj_rift', 'a retry asks for the same notes');
  // A projectId that names no project files nothing and sends nothing.
  const other = await env.chat.chatOnce(ask('Compare PETG and ASA', { projectId: 'prj_nope' }));
  assert.equal(env.runLedger.get(other.runId).projectId, null);
  assert.equal(other.route.provider, 'groq');
});

test('the switch off: no block, and the turn is routed as it would be without this feature', async t => {
  const env = setup(t);
  const first = await filedThread(env, 'prj_quiet');
  const out = await env.chat.chatOnce({ ...ask('Compare PETG and ASA for outdoor parts'), threadId: first.runId });
  assert.equal(out.route.provider, 'groq');
  assert.equal(env.cloudCalls.length, 2);
  for (const call of env.cloudCalls) assert.ok(!hasBlock(call.messages) && !call.messages.some(m => m.content.includes('Quiet note')));
  assert.equal(env.runLedger.get(out.runId).meta.memoryNotes, undefined);
  assert.equal(runCard(env.runLedger.get(out.runId)).memory, null);
});

test('a project with no notes: no block, routed as without this feature', async t => {
  const env = setup(t, { notes: () => [] });
  const first = await filedThread(env);
  const out = await env.chat.chatOnce({ ...ask('Compare PETG and ASA for outdoor parts'), threadId: first.runId });
  assert.equal(out.route.provider, 'groq');
  assert.equal(runCard(env.runLedger.get(out.runId)).memory, null);
});

test('the notes store cannot be read: answered without notes, and the run says so (never as "no notes")', async t => {
  const env = setup(t, { notes: () => { throw new Error('database is locked'); } });
  const first = await filedThread(env);
  const out = await env.chat.chatOnce({ ...ask('What layer height?'), threadId: first.runId });
  assert.ok(out.message.content, 'the turn is still answered');
  const run = env.runLedger.get(out.runId);
  assert.equal(run.status, 'completed');
  assert.equal(run.meta.memoryUnread, true);
  assert.equal(run.meta.memoryNotes, undefined);
  for (const call of env.cloudCalls) assert.ok(!hasBlock(call.messages));
  for (const s of env.sent) assert.ok(!hasBlock(s.body.messages));
  assert.deepEqual(runCard(run).memory, { text: "Couldn't read this project's notes", projectId: 'prj_rift', count: 0, unread: true });
});

test('research in a project: the web search is the question only; the answer is written on this PC with the notes', async t => {
  const env = setup(t, { search: [{ title: 'PETG guide', content: 'Use 0.2 mm', url: 'https://example.test/petg' }] });
  const out = await env.chat.chatOnce(ask('best PETG layer height', { projectId: 'prj_rift', webSearch: true }));
  assert.deepEqual(env.searches, ['best PETG layer height']);
  assert.equal(out.route.provider, 'ollama');
  assert.equal(out.route.why, PM.STAY);
  assert.equal(env.cloudCalls.length, 0);
  const msgs = env.sent[0].body.messages;
  assert.ok(msgs[1].content.includes(PM.OPEN), 'notes come right after the system prompt');
  assert.ok(msgs[2].content.includes('PETG guide'), 'then the sources');
});
