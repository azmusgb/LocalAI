'use strict';
// Free US cloud models (Groq, Cerebras) over their OpenAI-compatible APIs: keys from the environment, never in errors;
// a rate limit parks the provider; failures are thrown for the coordinator to fall through to the next model.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { createCloudModels } = require('../app/cloud-models');

async function fake(t, handler) {
  const calls = [];
  const s = http.createServer((req, res) => { let raw = ''; req.on('data', c => raw += c); req.on('end', () => { calls.push({ url: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null }); handler(req, res); }); });
  s.listen(0, '127.0.0.1'); await once(s, 'listening');
  t.after(() => new Promise(r => { s.closeAllConnections(); s.close(r); }));
  return { url: `http://127.0.0.1:${s.address().port}`, calls };
}
const reply = (res, code, body, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };

test('keys come from the environment; status says which are set, never the key', () => {
  const c = createCloudModels({ env: { LOCALAI_GROQ_API_KEY: 'gsk_secret' } });
  assert.deepEqual(c.keys(), { groq: true, cerebras: false });
  assert.ok(!JSON.stringify(c.status()).includes('gsk_secret'));
});

test('a chat goes to the provider with the key and returns the answer', async t => {
  const f = await fake(t, (req, res) => reply(res, 200, { choices: [{ message: { content: 'Hello from Groq' } }], usage: { total_tokens: 12 } }));
  const c = createCloudModels({ env: { LOCALAI_GROQ_API_KEY: 'gsk_secret', LOCALAI_GROQ_URL: f.url } });
  const out = await c.chat({ provider: 'groq', model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(out.content, 'Hello from Groq');
  assert.equal(f.calls[0].url, '/chat/completions');
  assert.equal(f.calls[0].auth, 'Bearer gsk_secret');
  assert.equal(f.calls[0].body.model, 'llama-3.3-70b-versatile');
  assert.equal(c.status().groq.today, 1);
});

test('a rate limit parks the provider until retry-after, and the error never carries the key', async t => {
  const f = await fake(t, (req, res) => reply(res, 429, { error: { message: 'rate limited for gsk_secret' } }, { 'retry-after': '120' }));
  const c = createCloudModels({ env: { LOCALAI_GROQ_API_KEY: 'gsk_secret', LOCALAI_GROQ_URL: f.url } });
  await assert.rejects(c.chat({ provider: 'groq', model: 'm', messages: [] }), e => !String(e.message + e.stack).includes('gsk_secret') && /rate limit/i.test(e.message));
  const until = c.parked().groq;
  assert.ok(until > Date.now() + 100000 && until < Date.now() + 130000);
});

test('a server error or a timeout is thrown (the coordinator tries the next model)', async t => {
  const f = await fake(t, (req, res) => reply(res, 503, { error: 'down' }));
  const c = createCloudModels({ env: { LOCALAI_CEREBRAS_API_KEY: 'csk', LOCALAI_CEREBRAS_URL: f.url } });
  await assert.rejects(c.chat({ provider: 'cerebras', model: 'm', messages: [] }), /HTTP 503/);
  assert.equal(c.parked().cerebras, undefined);
  const slow = await fake(t, () => {});
  const d = createCloudModels({ env: { LOCALAI_CEREBRAS_API_KEY: 'csk', LOCALAI_CEREBRAS_URL: slow.url }, timeoutMs: 200 });
  await assert.rejects(d.chat({ provider: 'cerebras', model: 'm', messages: [] }), /timed out|TIMEOUT/i);
});

// The coordinator records each try's outcome (app/model-coordinator.js attempts) from the error's own mark.
test('each failure carries its outcome: timeout, rate limit with and without retry-after, malformed body, server error', async t => {
  const env = url => ({ LOCALAI_GROQ_API_KEY: 'gsk_secret', LOCALAI_GROQ_URL: url });
  const outcome = async (handler, opts = {}) => {
    const f = await fake(t, handler);
    const c = createCloudModels({ env: env(f.url), ...opts });
    let err = null;
    try { await c.chat({ provider: 'groq', model: 'm', messages: [] }); } catch (e) { err = e; }
    assert.ok(err, 'it threw');
    return err.outcome;
  };
  assert.equal(await outcome(() => {}, { timeoutMs: 200 }), 'timeout');
  assert.equal(await outcome((req, res) => reply(res, 429, {}, { 'retry-after': '30' })), 'rate_limited');
  assert.equal(await outcome((req, res) => reply(res, 429, {})), 'rate_limited');
  assert.equal(await outcome((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{not json'); }), 'error');
  assert.equal(await outcome((req, res) => reply(res, 503, { error: 'down' })), 'error');
  const off = createCloudModels({ env: { LOCALAI_GROQ_API_KEY: 'gsk_secret', LOCALAI_GROQ_URL: 'http://127.0.0.1:9' } });
  await assert.rejects(off.chat({ provider: 'groq', model: 'm', messages: [] }), e => e.outcome === 'error' && /unreachable/.test(e.message));
});

// Stop or a caller that goes away: the request ends at once, with the caller's reason, and is no provider failure.
test('a caller\'s abort ends the request at once and is not recorded as the provider failing', async t => {
  let closed = 0;
  const f = await fake(t, (req, res) => { res.on('close', () => closed++); });
  const c = createCloudModels({ env: { LOCALAI_GROQ_API_KEY: 'gsk_secret', LOCALAI_GROQ_URL: f.url } });
  const ac = new AbortController(), reason = new Error('Client disconnected');
  const asked = c.chat({ provider: 'groq', model: 'm', messages: [], signal: ac.signal });
  for (let i = 0; i < 100 && !f.calls.length; i++) await new Promise(r => setTimeout(r, 10));
  const t0 = Date.now();
  ac.abort(reason);
  await assert.rejects(asked, e => e === reason);
  assert.ok(Date.now() - t0 < 1000, `ended after ${Date.now() - t0} ms`);
  for (let i = 0; i < 100 && !closed; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(closed, 1, 'the provider saw the request end');
  assert.equal(c.status().groq.lastError, null);
  assert.equal(c.parked().groq, undefined);
});

test('no key: refused before any request', async () => {
  const c = createCloudModels({ env: {} });
  await assert.rejects(c.chat({ provider: 'groq', model: 'm', messages: [] }), /no key/i);
});
