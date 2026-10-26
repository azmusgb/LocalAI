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

test('no key: refused before any request', async () => {
  const c = createCloudModels({ env: {} });
  await assert.rejects(c.chat({ provider: 'groq', model: 'm', messages: [] }), /no key/i);
});
