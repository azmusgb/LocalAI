'use strict';

// A chat turn ends when its caller is done with it (app/server/chat.js): Stop, or a caller that goes away (Pi Hub's
// House question gives up after 90 s), aborts the cloud call and this PC's model at once and the run is cancelled, not
// completed. A streamed turn's stall limit (CHAT_MODEL_TIMEOUT_MS) covers the cloud call too, and a cloud call that
// never answers falls through to this PC as a timeout. Models are stubs that never answer unless the test says so; the
// coordinator, router and ledger are the real ones, behind a real HTTP server.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { Storage } = require('../app/storage');
const { RunLedger } = require('../app/run-ledger');
const modelRouter = require('../app/model-router');
const { createCoordinator } = require('../app/model-coordinator');
const { createCloudModels } = require('../app/cloud-models');
const { fitMessages } = require('../app/text-context');
const { createChat } = require('../app/server/chat');
const { createRuns } = require('../app/server/runs');

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 2000) { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(10); } return fn(); }

// A model call that never answers; it notes when it started and when its signal ended it.
function hanging() {
  const log = { started: [], aborted: [], signals: [] };
  log.call = signal => new Promise((_, reject) => {
    log.started.push(Date.now()); log.signals.push(signal || null);
    signal?.addEventListener('abort', () => { log.aborted.push(Date.now()); reject(signal.reason); }, { once: true });
  });
  return log;
}

async function setup(t, { cloud = true, cloudModels, local, timeoutMs = 60000 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-cancel-'));
  const storage = new Storage({ dataDir: dir });
  const runLedger = new RunLedger({ storage });
  const activity = [];
  const coordinator = createCoordinator({ modelRouter, routingSetting: () => ({ cloud }), localModel: 'qwen3:4b', env: {}, recordActivity: (...a) => activity.push(a), cloudModels });
  const localCalls = [];
  const modelFetch = (url, opts = {}) => { localCalls.push(opts); return local ? local(opts) : Promise.resolve(new Response(JSON.stringify({ message: { content: 'From this PC' } }), { status: 200 })); };
  const projectStore = () => [];
  const sanitizeMessages = list => (Array.isArray(list) ? list : []).filter(m => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string').map(m => ({ role: m.role, content: m.content }));
  const { createChatExecution } = createRuns({ MODEL: 'qwen3:4b', cleanRunId: v => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(v) ? v : null), projectStore, runLedger, sanitizeMessages, titleFromText: (s, d) => String(s || d).slice(0, 60) });
  const json = (res, code, body) => { if (res.destroyed || res.headersSent) return; res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const readBody = req => new Promise((resolve, reject) => { let raw = ''; req.on('data', c => raw += c); req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch (e) { reject(e); } }); });
  const activeRunControllers = new Map();
  const chat = createChat({
    ANSWER_RESERVE: 1024, CHAT_MODEL_TIMEOUT_MS: timeoutMs, MODEL: 'qwen3:4b', OLLAMA_URL: 'http://ollama.test', coordinator, TEXT_KEEP_ALIVE: '30m', TEXT_NUM_CTX: 8192,
    aboutApplianceBlock: () => '', accessAddresses: () => [], activeRunControllers, capabilityPrompt: () => '', createChatExecution, fitMessages,
    getCapabilitiesSnapshot: async () => ({}), isAboutLocalAi: () => false, json, keepLongAnswer: () => {}, modelFetch, modelFetchWithTimeout: (url, opts) => modelFetch(url, opts),
    projectNotes: () => [], projectStore, readBody, recordActivity: (...a) => activity.push(a), recordTurnArtifact: () => null,
    runLedger, sanitizeMessages, searxSearch: async () => [], selfChange: { isSelfChange: () => false }, storageError: (res, e, code) => json(res, code, { error: e.message }),
    voiceFacts: () => '', voiceTimeZone: () => 'UTC', factSuggestions: { afterChat: () => {} }
  });
  const server = http.createServer((req, res) => (req.url === '/api/chat' ? chat.apiChat(req, res, 'host') : chat.apiChatStream(req, res, 'host')));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const clients = [];
  t.after(async () => {
    for (const c of clients) c.abort();
    server.closeAllConnections(); await new Promise(r => server.close(r));
    storage.close(); fs.rmSync(dir, { recursive: true, force: true });
  });
  // A request that keeps reading until the server ends it; abort() goes away like a closed tab or Pi Hub giving up.
  const send = (p, body) => {
    const ac = new AbortController(); clients.push(ac);
    const out = { text: '', status: 0, ended: false, abort: () => ac.abort() };
    out.done = fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal })
      .then(async r => { out.status = r.status; const reader = r.body.getReader(), dec = new TextDecoder(); for (;;) { const { value, done } = await reader.read(); if (done) break; out.text += dec.decode(value, { stream: true }); } })
      .catch(() => {}).finally(() => { out.ended = true; });
    return out;
  };
  const onlyRun = () => runLedger.list({ all: true })[0] || null;
  return { send, runLedger, activeRunControllers, localCalls, activity, onlyRun };
}
const research = q => ({ messages: [{ role: 'user', content: q }], bigger: true });
const cloudStub = log => ({ keys: () => ({ groq: true, cerebras: true }), parked: () => ({}), chat: ({ signal }) => log.call(signal) });

test('stream: Stop during a cloud call aborts it at once, asks nothing else, and the run is cancelled', async t => {
  const cloud = hanging();
  const env = await setup(t, { cloudModels: cloudStub(cloud) });
  const s = env.send('/api/chat/stream', research('Compare PETG and ASA for outdoor parts'));
  assert.ok(await until(() => cloud.started.length === 1), 'the cloud call started');
  const run = env.onlyRun();
  // What /api/runs/cancel does (app/server/runs.js apiRunCancel).
  env.runLedger.cancel(run.id, 'Cancelled by user'); env.activeRunControllers.get(run.id).abort();
  const t0 = Date.now();
  assert.ok(await until(() => cloud.aborted.length === 1, 1000), 'the cloud call was aborted');
  assert.ok(cloud.aborted[0] - t0 < 1000);
  assert.ok(await until(() => s.ended, 1000), 'the stream ended');
  assert.match(s.text, /event: cancelled/);
  assert.equal(cloud.started.length, 1, 'the second cloud model is not asked');
  assert.equal(env.localCalls.length, 0, "this PC's model is not asked");
  assert.equal(env.runLedger.get(run.id).status, 'cancelled');
});

test('stream: a closed connection during a cloud call aborts it at once and the run is cancelled', async t => {
  const cloud = hanging();
  const env = await setup(t, { cloudModels: cloudStub(cloud) });
  const s = env.send('/api/chat/stream', research('Compare PETG and ASA for outdoor parts'));
  assert.ok(await until(() => cloud.started.length === 1), 'the cloud call started');
  s.abort();
  assert.ok(await until(() => cloud.aborted.length === 1, 1000), 'the cloud call was aborted');
  assert.equal(env.localCalls.length, 0);
  assert.equal((await until(() => env.onlyRun()?.status === 'cancelled' && env.onlyRun())).status, 'cancelled');
});

test('stream: the stall limit covers the cloud call; the stream ends with a stall error and the run fails', async t => {
  const cloud = hanging();
  const env = await setup(t, { cloudModels: cloudStub(cloud), timeoutMs: 300 });
  const t0 = Date.now();
  const s = env.send('/api/chat/stream', research('Compare PETG and ASA for outdoor parts'));
  assert.ok(await until(() => s.ended, 3000), 'the stream ended on its own');
  assert.ok(Date.now() - t0 < 2000, `ended after ${Date.now() - t0} ms`);
  const err = /event: error\ndata: (.*)\n/.exec(s.text);
  assert.ok(err, s.text);
  const data = JSON.parse(err[1]);
  assert.equal(data.stalled, true);
  assert.match(data.error, /^No reply after \d+ s$/);
  assert.equal(cloud.aborted.length, 1, 'the cloud call was aborted');
  assert.equal(env.localCalls.length, 0);
  assert.equal(env.onlyRun().status, 'failed');
});

test('a cloud model that never answers times out and this PC answers; the timeout is in the Activity log', async t => {
  const never = http.createServer(() => {}); never.listen(0, '127.0.0.1'); await once(never, 'listening');
  t.after(() => { never.closeAllConnections(); return new Promise(r => never.close(r)); });
  const cloudModels = createCloudModels({ env: { LOCALAI_GROQ_API_KEY: 'gsk_test_key', LOCALAI_GROQ_URL: `http://127.0.0.1:${never.address().port}` }, timeoutMs: 200 });
  const env = await setup(t, { cloudModels });
  const t0 = Date.now();
  const s = env.send('/api/chat', research('Compare PETG and ASA for outdoor parts'));
  await s.done;
  assert.ok(Date.now() - t0 < 3000, `answered after ${Date.now() - t0} ms`);
  const out = JSON.parse(s.text);
  assert.equal(out.message.content, 'From this PC');
  assert.equal(out.route.provider, 'ollama');
  assert.ok(env.activity.some(a => a[1] === 'Cloud model unavailable' && /Groq: timed out/.test(a[2])), JSON.stringify(env.activity));
});

test('/api/chat: a caller that goes away aborts the cloud call and the run is cancelled', async t => {
  const cloud = hanging();
  const env = await setup(t, { cloudModels: cloudStub(cloud) });
  const s = env.send('/api/chat', research('Compare PETG and ASA for outdoor parts'));
  assert.ok(await until(() => cloud.started.length === 1), 'the cloud call started');
  assert.ok(cloud.signals[0], 'the cloud call got a signal');
  s.abort();
  assert.ok(await until(() => cloud.aborted.length === 1, 1000), 'the cloud call was aborted');
  assert.equal(cloud.started.length, 1, 'the second cloud model is not asked');
  assert.equal(env.localCalls.length, 0, "this PC's model is not asked");
  const run = await until(() => env.onlyRun()?.status === 'cancelled' && env.onlyRun(), 1000);
  assert.equal(run && run.status, 'cancelled', JSON.stringify(env.onlyRun()?.status));
  assert.match(run.error, /disconnected/i);
});

test("/api/chat: a caller that goes away aborts this PC's model; an answer that arrives anyway is not recorded", async t => {
  const local = { aborted: 0 };
  const env = await setup(t, {
    cloud: false, cloudModels: cloudStub(hanging()),
    // Answers after 400 ms whatever happens, as a model that ignored the abort would.
    local: opts => new Promise((resolve, reject) => {
      opts.signal?.addEventListener('abort', () => { local.aborted++; reject(opts.signal.reason); }, { once: true });
      setTimeout(() => resolve(new Response(JSON.stringify({ message: { content: 'Too late' } }), { status: 200 })), 400);
    }),
  });
  const s = env.send('/api/chat', { messages: [{ role: 'user', content: 'Plan the garden' }] });
  assert.ok(await until(() => env.localCalls.length === 1), "this PC's model was asked");
  assert.ok(env.localCalls[0].signal, "this PC's model got a signal");
  s.abort();
  assert.ok(await until(() => local.aborted === 1, 1000), "this PC's model was aborted");
  await sleep(600);
  const run = env.onlyRun();
  assert.equal(run.status, 'cancelled');
  assert.equal(run.output, null);
});
