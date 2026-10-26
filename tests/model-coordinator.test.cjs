'use strict';
// The coordinator's runner (app/model-coordinator.js): with cloud off no cloud request is ever made; what goes out is
// redacted; failures fall through to this PC; the Activity log says where work went, never what it said.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const modelRouter = require('../app/model-router');
const { createCoordinator, redact, secretish, cloudSafePath } = require('../app/model-coordinator');

function setup({ cloud = true, answer = () => ({ content: 'From the cloud' }), keys = { groq: true, cerebras: true }, env = {} } = {}) {
  const calls = [], activity = [];
  const cloudModels = {
    keys: () => keys, parked: () => ({}),
    chat: async (req) => { calls.push(req); const a = answer(req); if (a instanceof Error) throw a; return { ...a, provider: req.provider, model: req.model }; },
  };
  const c = createCoordinator({ modelRouter, cloudModels, routingSetting: () => ({ cloud }), recordActivity: (...a) => activity.push(a), env, localModel: 'local-model' });
  return { c, calls, activity };
}
const msgs = [{ role: 'user', content: 'Plan a change to the Models page' }];

test('cloud off: the route is this PC and run() makes no cloud request at all', async () => {
  const { c, calls } = setup({ cloud: false });
  const r = c.route({ kind: 'plan', text: 'Plan a change to the Models page' });
  assert.deepEqual(r.order.map(x => x.provider), ['ollama']);
  assert.equal(await c.run(r, msgs, { kind: 'plan' }), null);
  assert.equal(calls.length, 0);
});

test('cloud on: the first cloud model answers, and says where it ran', async () => {
  const { c, calls, activity } = setup();
  const r = c.route({ kind: 'plan', text: 'Plan a change to the Models page' });
  const out = await c.run(r, msgs, { kind: 'plan' });
  assert.equal(out.content, 'From the cloud');
  assert.deepEqual([out.used.provider, out.used.model, out.used.class], ['groq', 'llama-3.3-70b-versatile', 'shareable']);
  assert.equal(calls.length, 1);
  // One Activity line per cloud call: provider, model, kind and size, never the text.
  const sent = activity.find(a => a[1] === 'Sent to a cloud model');
  assert.ok(sent, JSON.stringify(activity));
  assert.equal(sent[3].provider, 'groq'); assert.equal(sent[3].kind, 'plan'); assert.ok(sent[3].chars > 0);
  assert.ok(!JSON.stringify(activity).includes('Models page'));
});

test('a failing cloud model falls through to the next, then to null (this PC)', async () => {
  let n = 0;
  const { c, calls } = setup({ answer: () => (n++ === 0 ? new Error('Groq: HTTP 503') : { content: 'Cerebras answer' }) });
  const out = await c.run(c.route({ kind: 'plan', text: 'x' }), msgs, { kind: 'plan' });
  assert.equal(out.used.provider, 'cerebras');
  const { c: c2 } = setup({ answer: () => new Error('down') });
  assert.equal(await c2.run(c2.route({ kind: 'plan', text: 'x' }), msgs, { kind: 'plan' }), null);
  assert.equal(calls.length, 2);
});

test('private work never reaches the cloud, even when run() is called', async () => {
  const { c, calls } = setup();
  for (const req of [{ text: 'my insulin dose' }, { text: 'x', stay: 'Your workspace files stay on this PC' }, { text: 'x', keepLocal: true }]) {
    const r = c.route({ kind: 'plan', ...req });
    assert.equal(r.class, 'private');
    assert.equal(await c.run(r, msgs, { kind: 'plan' }), null);
  }
  assert.equal(calls.length, 0);
});

test('what goes out is redacted: keys, secret env values, bearer tokens, absolute paths, private addresses, emails', async () => {
  const env = { LOCALAI_GROQ_API_KEY: 'gsk_live_abcdefghijk', SOME_TOKEN: 'tok-0123456789', PATH: '/usr/bin' };
  const { c, calls } = setup({ env });
  const text = 'key gsk_live_abcdefghijk and tok-0123456789, Authorization: Bearer abc.def.ghi, ghp_ABCDEFGHIJKLMNOP1234, '
    + 'file C:\\LocalAI\\stack\\stack.env and /Users/bill/secret.txt and /data/runs.db, host 10.0.0.21, 192.168.1.5, 100.101.102.103, me@example.com; keep app/public/ui.js';
  await c.run(c.route({ kind: 'plan', text: 'plan it' }), [{ role: 'user', content: text }], { kind: 'plan' });
  const out = calls[0].messages[0].content;
  for (const bad of ['gsk_live', 'tok-0123', 'abc.def', 'ghp_', 'C:\\LocalAI', '/Users/bill', '/data/runs', '10.0.0.21', '192.168', '100.101', 'me@example']) assert.ok(!out.includes(bad), `${bad} in ${out}`);
  assert.ok(out.includes('app/public/ui.js'), 'repo-relative paths stay');
  assert.equal(redact('plain words stay'), 'plain words stay');
});

test('secretish: asking about Local AI\'s own keys, tokens, passwords or config', () => {
  for (const t of ['Rotate the Groq API key', 'show me stack.env', 'change the admin password', 'where is the approval key', 'print the environment variables', 'update the TLS certificate', 'what tokens does the display use'])
    assert.ok(secretish(t), t);
  for (const t of ['Make the Models page clearer', 'Add a Retry button to failed runs', 'Compare PETG and ASA'])
    assert.ok(!secretish(t), t);
});

test('cloudSafePath: secret-looking files never go out', () => {
  for (const p of ['.env', 'deploy/stack/stack.env', 'stack.env.example', 'certs/localai-ca.crt', 'keys/server.key', 'id_rsa', 'config/secrets.json', 'tokens.txt', 'approval-key.txt', 'credentials.yml', 'a/b/private.pem'])
    assert.equal(cloudSafePath(p), false, p);
  for (const p of ['app/public/ui.js', 'app/server/chat.js', 'docs/USER-GUIDE.md', 'app/route-keys.js'])
    assert.equal(cloudSafePath(p), true, p);
});

test('local(): the record for an answer from this PC', () => {
  const { c } = setup({ cloud: false });
  const r = c.route({ kind: 'plan', text: 'x' });
  assert.deepEqual(c.local(r, 'qwen'), { provider: 'ollama', model: 'qwen', class: r.class, why: r.why });
});

// Review of #402: more redaction; the Activity line comes before the send and a logging failure never resends.
test('redaction also covers home paths, UNC shares, home.arpa and tailnet names, IPv6 local addresses and extra secrets', () => {
  const out = redact('see ~/notes/plan.md and \\\\nas\\share\\x.txt, pihub.home.arpa, mac.tail1234.ts.net, fd12:3456:789a::1, fe80::1 and approval-value-xyz', { }, ['approval-value-xyz']);
  for (const bad of ['~/notes', 'nas\\share', 'pihub.home.arpa', 'tail1234.ts.net', 'fd12:3456', 'fe80::1', 'approval-value-xyz']) assert.ok(!out.includes(bad), `${bad} in ${out}`);
});

test('the Activity line is written before each cloud call, failures included; a logging error never sends to the next provider', async () => {
  const { c, calls, activity } = setup({ answer: () => new Error('Groq: timed out') });
  await c.run(c.route({ kind: 'plan', text: 'x' }), msgs, { kind: 'plan' });
  assert.equal(activity.filter(a => a[1] === 'Sent to a cloud model').length, 2);
  const calls2 = [];
  const cloudModels = { keys: () => ({ groq: true, cerebras: true }), parked: () => ({}), chat: async req => { calls2.push(req); return { content: 'ok' }; } };
  const c2 = createCoordinator({ modelRouter, cloudModels, routingSetting: () => ({ cloud: true }), recordActivity: () => { throw new Error('log full'); }, env: {} });
  const out = await c2.run(c2.route({ kind: 'plan', text: 'x' }), msgs, { kind: 'plan' });
  assert.equal(out.used.provider, 'groq');
  assert.equal(calls2.length, 1);
  void calls;
});
