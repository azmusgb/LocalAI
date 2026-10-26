'use strict';
// The coordinator end to end: with cloud off nothing leaves the PC; with it on, shareable research goes to Groq and
// says so on the run; private work stays local; a failing cloud falls back to this PC.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { spawnAppServer } = require('./spawn-server.cjs');

async function server(t, handler) {
  const calls = [];
  const s = http.createServer((req, res) => { let raw = ''; req.on('data', c => raw += c); req.on('end', () => { calls.push({ url: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null }); handler(req, res); }); });
  s.listen(0, '127.0.0.1'); await once(s, 'listening');
  t.after(() => new Promise(r => { s.closeAllConnections(); s.close(r); }));
  return { url: `http://127.0.0.1:${s.address().port}`, calls };
}
const reply = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

async function start(t, groqHandler, { env = {}, local = 'Answered on this PC', seed } = {}) {
  const ollama = await server(t, (req, res) => {
    if (req.url === '/api/tags') return reply(res, 200, { models: [{ name: 'test-model' }] });
    if (req.url === '/api/ps') return reply(res, 200, { models: [] });
    reply(res, 200, { message: { content: local }, done: true });
  });
  const groq = await server(t, groqHandler || ((req, res) => reply(res, 200, { choices: [{ message: { content: 'Answered by Groq' } }] })));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-route-'));
  if (seed) { const { Storage } = require('../app/storage'); const st = new Storage({ dataDir }); seed(st); st.close?.(); }
  const { child, ready } = spawnAppServer({ env: {
    DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, OLLAMA_URL: ollama.url, MODEL: 'test-model', SEARXNG_URL: 'http://127.0.0.1:9',
    COMFY_URL: 'http://127.0.0.1:9', N8N_URL: 'http://127.0.0.1:9', PROXY_URL: 'http://127.0.0.1:9',
    LOCALAI_GROQ_API_KEY: 'gsk_test_secret', LOCALAI_GROQ_URL: groq.url, LOCALAI_CEREBRAS_API_KEY: '', ...env,
  } });
  t.after(async () => { if (child.exitCode === null) { const d = once(child, 'exit'); child.kill('SIGTERM'); await d; } fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = await ready;
  const call = async (p, body, method) => {
    const r = await fetch(base + p, { method: method || (body ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, value: await r.json() };
  };
  const stream = async (p, body) => (await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).text();
  return { call, stream, ollama, groq, base };
}
const research = q => ({ messages: [{ role: 'user', content: q }], webSearch: false, bigger: true });

test('cloud is off until switched on: nothing reaches Groq', async t => {
  const { call, groq } = await start(t);
  const r = await call('/api/chat', research('Compare PETG and ASA for outdoor parts'));
  assert.equal(r.value.message.content, 'Answered on this PC');
  assert.equal(r.value.route.provider, 'ollama');
  assert.equal(groq.calls.length, 0);
  const s = await call('/api/models/routing');
  assert.equal(s.value.cloud, false);
  assert.equal(s.value.providers.groq.key, true);
  assert.ok(!JSON.stringify(s.value).includes('gsk_test_secret'));
});

test('switched on: a shareable request goes to Groq and the run says so', async t => {
  const { call, groq } = await start(t);
  assert.equal((await call('/api/models/routing', { cloud: true }, 'PUT')).value.cloud, true);
  const r = await call('/api/chat', research('Compare PETG and ASA for outdoor parts'));
  assert.equal(r.value.message.content, 'Answered by Groq');
  assert.deepEqual([r.value.route.provider, r.value.route.model], ['groq', 'llama-3.3-70b-versatile']);
  assert.equal(groq.calls[0].auth, 'Bearer gsk_test_secret');
  const run = (await call(`/api/runs?id=${encodeURIComponent(r.value.runId)}`)).value.item;
  assert.equal(run.meta.route.provider, 'groq');
});

test('switched on: private work still stays on this PC', async t => {
  const { call, groq } = await start(t);
  await call('/api/models/routing', { cloud: true }, 'PUT');
  for (const body of [research('What dose of ibuprofen is safe with my blood pressure medication?'),
    { ...research('What is on tonight'), title: 'House question' }, { ...research('Weather now'), voice: true },
    { messages: [{ role: 'user', content: 'Plan the garden' }] }]) {
    const r = await call('/api/chat', body);
    assert.equal(r.value.route.provider, 'ollama', JSON.stringify(body).slice(0, 60));
  }
  assert.equal(groq.calls.length, 0);
});

test('a failing cloud falls back to this PC', async t => {
  const { call } = await start(t, (req, res) => reply(res, 503, { error: 'down' }));
  await call('/api/models/routing', { cloud: true }, 'PUT');
  const r = await call('/api/chat', research('Compare PETG and ASA'));
  assert.equal(r.value.message.content, 'Answered on this PC');
  assert.equal(r.value.route.provider, 'ollama');
});

test('streaming chat: a cloud answer arrives whole, with the route in the meta event', async t => {
  const { call, stream } = await start(t);
  await call('/api/models/routing', { cloud: true }, 'PUT');
  const sse = await stream('/api/chat/stream', research('Compare PETG and ASA for outdoor parts'));
  assert.match(sse, /event: meta\ndata: \{[^\n]*"route":\{"provider":"groq"/);
  assert.match(sse, /event: token\ndata: \{"text":"Answered by Groq"\}/);
  assert.match(sse, /event: done/);
});

// Security review of #398: the guard reads everything that would be sent, and the cloud never gets the appliance's
// own details (the capability snapshot, addresses).
test('an earlier personal turn keeps the whole conversation on this PC', async t => {
  const { call, groq } = await start(t);
  await call('/api/models/routing', { cloud: true }, 'PUT');
  const r = await call('/api/chat', { bigger: true, messages: [
    { role: 'user', content: 'I take lisinopril for my blood pressure.' }, { role: 'assistant', content: 'Noted.' },
    { role: 'user', content: 'Which outdoor sports suit me?' }] });
  assert.equal(r.value.route.provider, 'ollama');
  assert.equal(groq.calls.length, 0);
});

test('questions about Local AI itself stay on this PC', async t => {
  const { call, groq } = await start(t);
  await call('/api/models/routing', { cloud: true }, 'PUT');
  const r = await call('/api/chat', research('What models does Local AI have installed?'));
  assert.equal(r.value.route.provider, 'ollama');
  assert.equal(groq.calls.length, 0);
});

test('the cloud gets the conversation, not the appliance snapshot', async t => {
  const { call, groq } = await start(t);
  await call('/api/models/routing', { cloud: true }, 'PUT');
  await call('/api/chat', research('Compare PETG and ASA for outdoor parts'));
  const sent = JSON.stringify(groq.calls[0].body.messages);
  assert.ok(!sent.includes('RUNTIME CAPABILITY SNAPSHOT'), sent.slice(0, 300));
});

test('an earlier turn about Local AI keeps the follow-up on this PC', async t => {
  const { call, groq } = await start(t);
  await call('/api/models/routing', { cloud: true }, 'PUT');
  const r = await call('/api/chat', { bigger: true, messages: [
    { role: 'user', content: 'What models does Local AI have installed?' }, { role: 'assistant', content: 'qwen3 and gemma3, on 10.0.0.21.' },
    { role: 'user', content: 'Compare those to Llama 3.3 70B for writing.' }] });
  assert.equal(r.value.route.provider, 'ollama');
  assert.equal(groq.calls.length, 0);
});

// Step 2: the change planner. Change requests plan as kind `plan`, engineering runs as `code`; only Local AI's own code
// may go out, without secret-looking files, redacted; the cloud failing or off means this PC's planner as before.
const PLAN = (summary) => JSON.stringify({ summary, notes: '', files: [{ path: 'public/app.js', operations: [{ type: 'append', content: '// planned' }] }] });
function selfRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-self-'));
  fs.mkdirSync(path.join(dir, 'public'));
  fs.writeFileSync(path.join(dir, 'public', 'models.js'), '// models page\nfunction modelsPage(){ return fetch("http://10.0.0.21/api/models") }\n');
  fs.writeFileSync(path.join(dir, 'stack.env'), 'LOCALAI_MODELS_TOKEN=models-page-secret-value\n');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function planner(t, groqHandler, seed) {
  const root = selfRoot(t);
  const s = await start(t, groqHandler || ((req, res) => reply(res, 200, { choices: [{ message: { content: PLAN('Planned in the cloud') } }] })),
    { env: { SELF_APP_ROOT: root }, local: PLAN('Planned on this PC'), seed });
  return s;
}

test('planner, cloud off: no cloud request, planned on this PC, and the change says so', async t => {
  const { call, groq } = await planner(t);
  const r = await call('/api/changes/plan', { request: 'Make the models page clearer', target: 'self' });
  assert.equal(r.status, 201, JSON.stringify(r.value));
  assert.equal(r.value.item.summary, 'Planned on this PC');
  assert.equal(r.value.item.route.provider, 'ollama');
  assert.equal(groq.calls.length, 0);
});

test('planner, cloud on: Local AI\'s own code is planned in the cloud, without secret files or addresses', async t => {
  const { call, groq } = await planner(t);
  await call('/api/models/routing', { cloud: true }, 'PUT');
  const r = await call('/api/changes/plan', { request: 'Make the models page clearer', target: 'self' });
  assert.equal(r.value.item.summary, 'Planned in the cloud');
  assert.deepEqual([r.value.item.route.provider, r.value.item.route.model], ['groq', 'llama-3.3-70b-versatile']);
  const sent = JSON.stringify(groq.calls[0].body.messages);
  assert.match(sent, /models page/);
  for (const bad of ['models-page-secret-value', 'stack.env', '10.0.0.21', 'gsk_test_secret']) assert.ok(!sent.includes(bad), bad);
});

test('planner, cloud on: an engineering run writes code with the cloud coder', async t => {
  const { call, groq } = await planner(t);
  await call('/api/models/routing', { cloud: true }, 'PUT');
  const r = await call('/api/engineering/start', { request: 'Make the models page clearer', target: 'self', root: 'app', maxAttempts: 1 });
  assert.equal(r.status < 300, true, JSON.stringify(r.value));
  for (let i = 0; i < 50 && !groq.calls.length; i++) await new Promise(res => setTimeout(res, 100));
  assert.equal(groq.calls[0]?.body.model, 'openai/gpt-oss-120b');
});

test('planner, cloud on: workspace projects, secrets and personal words stay on this PC', async t => {
  const { call, groq } = await planner(t);
  await call('/api/models/routing', { cloud: true }, 'PUT');
  const ws = await call('/api/changes/plan', { request: 'Make the models page clearer', target: 'workspace', root: '' });
  assert.equal(ws.value.item.route.provider, 'ollama');
  assert.match(ws.value.item.route.why, /workspace/i);
  const secret = await call('/api/changes/plan', { request: 'Rotate the Groq API key on the models page', target: 'self' });
  assert.equal(secret.value.item.route.provider, 'ollama');
  const personal = await call('/api/changes/plan', { request: 'Show my blood pressure medication on the models page', target: 'self' });
  assert.equal(personal.value.item.route.provider, 'ollama');
  assert.equal(groq.calls.length, 0);
});

test('planner, cloud on but failing: planned on this PC', async t => {
  const { call } = await planner(t, (req, res) => reply(res, 503, { error: 'down' }));
  await call('/api/models/routing', { cloud: true }, 'PUT');
  const r = await call('/api/changes/plan', { request: 'Make the models page clearer', target: 'self' });
  assert.equal(r.value.item.summary, 'Planned on this PC');
  assert.equal(r.value.item.route.provider, 'ollama');
});

// Security review: only plans whose whole input is what the owner typed plus Local AI's own code may go out. A health
// check's issue (runtime detail: paths, logs, host names), an Improve item Local AI or Claude wrote, and an engineering
// retry carrying error output all stay here.
test('planner, cloud on: a health-check issue is planned on this PC', async t => {
  const { call, groq } = await planner(t, null, s => s.put('issues', { id: 'iss-1', name: 'Models page slow', severity: 'medium', detail: 'GET /api/models took 9 s on models page at /data/runs.db', status: 'open', createdAt: '2026-10-26T00:00:00Z', updatedAt: '2026-10-26T00:00:00Z' }, 0));
  await call('/api/models/routing', { cloud: true }, 'PUT');
  const r = await call('/api/issues/prepare-change', { id: 'iss-1' });
  assert.equal(r.status, 201, JSON.stringify(r.value));
  assert.equal(r.value.item.route.provider, 'ollama');
  assert.equal(groq.calls.length, 0);
});

test('planner, cloud on: an Improve item Claude wrote is planned on this PC; the owner\'s own idea may go out', async t => {
  const { call, groq } = await planner(t);
  await call('/api/models/routing', { cloud: true }, 'PUT');
  await call('/api/claude/findings', { sessionId: 's1', findings: [{ id: 'f-models', title: 'Models page clarity', category: 'ux', severity: 'low', summary: 'The models page is unclear', status: 'approved' }] });
  const claude = await call('/api/improve/item', { id: 'f-models', action: 'start' });
  assert.equal(claude.status, 200, JSON.stringify(claude.value));
  assert.equal(groq.calls.length, 0);
  const idea = await call('/api/improve/idea', { text: 'Make the models page clearer', start: true });
  assert.equal(idea.value.change?.route?.provider, 'groq', JSON.stringify(idea.value));
});

test('planner, cloud on: an engineering request that carries the conversation stays on this PC', async t => {
  const { call, groq } = await planner(t);
  await call('/api/models/routing', { cloud: true }, 'PUT');
  const request = 'Continue and implement this Local AI self-change: the models page\n\nThe user\'s continuation command is: do it\n\nRECENT CONVERSATION CONTEXT:\nassistant: Local AI runs qwen3 on the models page';
  const r = await call('/api/engineering/start', { request, target: 'self', root: 'app', maxAttempts: 1 });
  assert.ok(r.status < 300, JSON.stringify(r.value));
  for (let i = 0; i < 30; i++) { const runs = (await call('/api/engineering/runs')).value; if (JSON.stringify(runs).includes('planned')) break; await new Promise(res => setTimeout(res, 100)); }
  assert.equal(groq.calls.length, 0);
});

// Step 3: the switch is a guarded write. Another device that isn't signed in can't turn cloud models on.
test('the cloud switch: another device that is not signed in is refused; reading it is fine and carries no key', async t => {
  const { guarded } = require('../app/signin');
  assert.equal(guarded('/api/models/routing', 'PUT'), true);
  assert.equal(guarded('/api/models/routing', 'GET'), false);
  const { call, base } = await start(t);
  const r = await fetch(base + '/api/models/routing', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.0.0.37' }, body: JSON.stringify({ cloud: true }) });
  assert.equal(r.status, 401);
  const read = (await call('/api/models/routing')).value;
  assert.equal(read.cloud, false);
  assert.ok(Array.isArray(read.table) && read.table.every(x => x.where));
  assert.ok(!JSON.stringify(read).includes('gsk_test_secret'));
});
