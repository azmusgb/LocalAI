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

async function start(t, groqHandler) {
  const ollama = await server(t, (req, res) => {
    if (req.url === '/api/tags') return reply(res, 200, { models: [{ name: 'test-model' }] });
    if (req.url === '/api/ps') return reply(res, 200, { models: [] });
    reply(res, 200, { message: { content: 'Answered on this PC' } });
  });
  const groq = await server(t, groqHandler || ((req, res) => reply(res, 200, { choices: [{ message: { content: 'Answered by Groq' } }] })));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-route-'));
  const { child, ready } = spawnAppServer({ env: {
    DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, OLLAMA_URL: ollama.url, MODEL: 'test-model', SEARXNG_URL: 'http://127.0.0.1:9',
    COMFY_URL: 'http://127.0.0.1:9', N8N_URL: 'http://127.0.0.1:9', PROXY_URL: 'http://127.0.0.1:9',
    LOCALAI_GROQ_API_KEY: 'gsk_test_secret', LOCALAI_GROQ_URL: groq.url, LOCALAI_CEREBRAS_API_KEY: '',
  } });
  t.after(async () => { if (child.exitCode === null) { const d = once(child, 'exit'); child.kill('SIGTERM'); await d; } fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = await ready;
  const call = async (p, body, method) => {
    const r = await fetch(base + p, { method: method || (body ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, value: await r.json() };
  };
  const stream = async (p, body) => (await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).text();
  return { call, stream, ollama, groq };
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
