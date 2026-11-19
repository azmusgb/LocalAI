'use strict';

// Owner-fact suggestions end to end, on a real server with a fake Ollama: a chat answered on this PC leads to one
// pending suggestion (without delaying the answer), Save writes the fact, "No" is remembered, a cloud-answered turn
// gives none, and the routes are refused to a caller without a device.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { spawnAppServer } = require('./spawn-server.cjs');
const crypto = require('node:crypto');
const { OPEN } = require('../app/fact-suggestions');

// The Mac key (to approve a pairing) and Pi Hub's key, as tests/signin-report.test.cjs sets them up.
const MAC_KEY = 'k'.repeat(64), HUB_KEY = 'h'.repeat(40);
const sha = v => crypto.createHash('sha256').update(v).digest('hex');
// Through Caddy from another device: not the host itself.
const AWAY = { 'X-Forwarded-For': '10.0.0.50', 'X-Forwarded-Proto': 'https', 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148 Safari/604.1' };

const FACT = 'You print mostly PLA on a Bambu X2D.';
const QUESTION = 'I print mostly PLA on my Bambu X2D. What nozzle temperature should I use?';

async function fake(t, handler) {
  const calls = [];
  const s = http.createServer((req, res) => { let raw = ''; req.on('data', c => raw += c); req.on('end', () => { const body = raw ? JSON.parse(raw) : null; calls.push({ url: req.url, body }); handler(req, res, body); }); });
  s.listen(0, '127.0.0.1'); await once(s, 'listening');
  t.after(() => new Promise(r => { s.closeAllConnections(); s.close(r); }));
  return { url: `http://127.0.0.1:${s.address().port}`, calls };
}
const reply = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const isSuggestion = body => Array.isArray(body?.messages) && body.messages.some(m => String(m.content || '').startsWith(OPEN));

async function start(t, { suggestion = FACT } = {}) {
  const ollama = await fake(t, (req, res, body) => {
    if (req.url === '/api/tags') return reply(res, 200, { models: [{ name: 'test-model' }] });
    if (req.url === '/api/ps') return reply(res, 200, { models: [] });
    if (isSuggestion(body)) return reply(res, 200, { message: { content: suggestion }, done: true });
    if (body?.stream) { res.writeHead(200, { 'Content-Type': 'application/x-ndjson' }); res.end(JSON.stringify({ message: { content: 'Try 215 °C.' } }) + '\n' + JSON.stringify({ done: true }) + '\n'); return; }
    reply(res, 200, { message: { content: 'Try 215 °C.' }, done: true });
  });
  const groq = await fake(t, (req, res) => reply(res, 200, { choices: [{ message: { content: 'Answered by Groq' } }] }));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-facts-'));
  fs.writeFileSync(path.join(dataDir, 'claude-chat-mac-key.sha256'), sha(MAC_KEY));
  const { child, ready } = spawnAppServer({ env: {
    DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, OLLAMA_URL: ollama.url, MODEL: 'test-model', SEARXNG_URL: 'http://127.0.0.1:9',
    COMFY_URL: 'http://127.0.0.1:9', N8N_URL: 'http://127.0.0.1:9', PROXY_URL: 'http://127.0.0.1:9',
    LOCALAI_GROQ_API_KEY: 'gsk_test_secret', LOCALAI_GROQ_URL: groq.url, LOCALAI_CEREBRAS_API_KEY: '',
    LOCALAI_FACT_SUGGESTIONS: 'on', LOCALAI_HUB_KEY_SHA256: sha(HUB_KEY),
  } });
  t.after(async () => { if (child.exitCode === null) { const d = once(child, 'exit'); child.kill('SIGTERM'); await d; } fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = await ready;
  const call = async (p, body, headers = {}) => {
    const r = await fetch(base + p, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, value: await r.json() };
  };
  const pendingSoon = async (want = 1) => {
    for (let i = 0; i < 60; i++) { const r = await call('/api/facts/suggestions'); if (r.status !== 200 || r.value.items.length >= want) return r; await new Promise(res => setTimeout(res, 100)); }
    return call('/api/facts/suggestions');
  };
  return { call, pendingSoon, ollama, groq, base };
}

test('a local chat answer leads to one pending suggestion; Save writes the fact; nothing is saved before', async t => {
  const { call, pendingSoon, ollama } = await start(t);
  const r = await call('/api/chat', { messages: [{ role: 'user', content: QUESTION }] });
  assert.equal(r.status, 200);
  assert.equal(r.value.message.content, 'Try 215 °C.');
  assert.equal(ollama.calls.filter(c => isSuggestion(c.body)).length, 0, 'the answer came back before the job asked anything');
  const p = await pendingSoon();
  assert.equal(p.status, 200);
  assert.deepEqual(p.value.items.map(i => i.text), [FACT]);
  assert.equal(p.value.items[0].runId, r.value.runId);
  assert.equal(p.value.items[0].caller, 'host', 'the host itself asked');
  const ask = ollama.calls.find(c => isSuggestion(c.body));
  assert.equal(ask.body.model, 'test-model');
  assert.equal(ask.body.tools, undefined, 'no tools');
  let mem = await call('/api/memory');
  assert.equal(mem.value.items.length, 0, 'nothing saved before the owner says so');
  const d = await call('/api/facts/suggestions/decide', { id: p.value.items[0].id, action: 'save' });
  assert.equal(d.status, 200, JSON.stringify(d.value));
  mem = await call('/api/memory');
  assert.deepEqual(mem.value.items.map(m => [m.text, m.category, m.projectId]), [[FACT, 'owner', '']]);
  assert.deepEqual((await call('/api/facts/suggestions')).value.items, []);
  // The same fact again is a duplicate: no new suggestion.
  await call('/api/chat', { messages: [{ role: 'user', content: QUESTION }] });
  await new Promise(res => setTimeout(res, 2500));
  assert.deepEqual((await call('/api/facts/suggestions')).value.items, []);
});

test('the streamed chat schedules it too, and "No" is remembered', async t => {
  const { call, pendingSoon, base } = await start(t);
  const text = await (await fetch(`${base}/api/chat/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: QUESTION }] }) })).text();
  assert.match(text, /event: done/);
  const p = await pendingSoon();
  assert.deepEqual(p.value.items.map(i => i.text), [FACT]);
  const d = await call('/api/facts/suggestions/decide', { id: p.value.items[0].id, action: 'no' });
  assert.equal(d.status, 200);
  assert.equal(d.value.state, 'declined');
  await call('/api/chat', { messages: [{ role: 'user', content: QUESTION }] });
  await new Promise(res => setTimeout(res, 2500));
  assert.deepEqual((await call('/api/facts/suggestions')).value.items, [], 'the same fact is not proposed again');
  assert.equal((await call('/api/memory')).value.items.length, 0);
});

test('a cloud-answered turn and a "Keep on this PC" turn give no suggestion and ask no model', async t => {
  const { call, ollama, groq, base } = await start(t);
  const on = await fetch(`${base}/api/models/routing`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cloud: true }) });
  assert.equal(on.status, 200);
  const r = await call('/api/chat', { messages: [{ role: 'user', content: QUESTION }], bigger: true });
  assert.equal(r.value.route.provider, 'groq');
  assert.equal(groq.calls.length, 1);
  await call('/api/chat', { messages: [{ role: 'user', content: QUESTION }], keepLocal: true });
  await new Promise(res => setTimeout(res, 2500));
  assert.equal(ollama.calls.filter(c => isSuggestion(c.body)).length, 0);
  assert.deepEqual((await call('/api/facts/suggestions')).value.items, []);
});

test('a caller without a device is refused both routes (owner-only)', async t => {
  const { call } = await start(t);
  // Through Caddy (X-Forwarded-For): not the host itself, and not paired.
  const away = { 'X-Forwarded-For': '10.0.0.50' };
  const g = await call('/api/facts/suggestions', null, away);
  assert.equal(g.status, 401);
  assert.equal(g.value.items, undefined);
  const d = await call('/api/facts/suggestions/decide', { id: 'fs-1', action: 'save' }, away);
  assert.equal(d.status, 401);
});

async function pair(base) {
  const JSONH = { 'Content-Type': 'application/json' };
  const pr = await (await fetch(`${base}/api/claude/chat/pair-request`, { method: 'POST', headers: JSONH, body: '{}' })).json();
  await fetch(`${base}/api/claude/chat/pair/approve`, { method: 'POST', headers: { ...JSONH, 'X-LocalAI-Mac-Key': MAC_KEY }, body: JSON.stringify({ code: pr.code, name: 'Phone' }) });
  const sr = await fetch(`${base}/api/claude/chat/pair-status?id=${pr.id}`, { headers: { 'X-Forwarded-Proto': 'https' } });
  return sr.headers.get('set-cookie').split(';')[0];
}

test('who asked: a paired device and the host get a suggestion, recorded on it; a caller sign-in only reported does not', async t => {
  const { call, pendingSoon, ollama, base } = await start(t);
  // Report-only sign-in (the default): an unpaired phone may chat, but it is not the owner.
  const unsigned = await call('/api/chat', { messages: [{ role: 'user', content: QUESTION }] }, AWAY);
  assert.equal(unsigned.status, 200, 'report mode still answers');
  const streamed = await (await fetch(`${base}/api/chat/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...AWAY }, body: JSON.stringify({ messages: [{ role: 'user', content: QUESTION }] }) })).text();
  assert.match(streamed, /event: done/);
  // Pi Hub's key opens /api/chat for Pi Hub, which is not the owner either.
  const hub = await call('/api/chat', { messages: [{ role: 'user', content: QUESTION }] }, { ...AWAY, 'X-LocalAI-Hub-Key': HUB_KEY });
  assert.equal(hub.status, 200);
  await new Promise(res => setTimeout(res, 2500));
  assert.equal(ollama.calls.filter(c => isSuggestion(c.body)).length, 0, 'no job for an unknown caller or a route key');
  assert.deepEqual((await call('/api/facts/suggestions')).value.items, []);
  // A paired device, through Caddy.
  const cookie = await pair(base);
  const owner = await call('/api/chat', { messages: [{ role: 'user', content: QUESTION }] }, { ...AWAY, Cookie: cookie });
  assert.equal(owner.status, 200);
  const p = await pendingSoon();
  assert.deepEqual(p.value.items.map(i => [i.text, i.caller]), [[FACT, 'signed-in']]);
  // The device reads its list too; the host's own request is the first test's case.
  const mine = await call('/api/facts/suggestions', null, { ...AWAY, Cookie: cookie });
  assert.equal(mine.status, 200);
  assert.equal(mine.value.items.length, 1);
});
