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
  assert.deepEqual([out.used.provider, out.used.model, out.used.class], ['groq', 'openai/gpt-oss-120b', 'shareable']);
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
    + 'file C:\\LocalAI\\stack\\stack.env and /Users/bill/secret.txt and /data/runs.db, host 10.0.0.81, 192.168.1.5, 100.101.102.103, me@example.com; keep app/public/ui.js';
  await c.run(c.route({ kind: 'plan', text: 'plan it' }), [{ role: 'user', content: text }], { kind: 'plan' });
  const out = calls[0].messages[0].content;
  for (const bad of ['gsk_live', 'tok-0123', 'abc.def', 'ghp_', 'C:\\LocalAI', '/Users/bill', '/data/runs', '10.0.0.81', '192.168', '100.101', 'me@example']) assert.ok(!out.includes(bad), `${bad} in ${out}`);
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

// A route records what happened, not only what was planned: the model that answered, why when that differs from the
// plan, and a bounded list of what was tried (provider, model, outcome, ms; never the text or a key).
const timedOut = () => Object.assign(new Error('Groq: timed out'), { outcome: 'timeout' });
const busy = () => Object.assign(new Error('Cerebras: rate limit reached, resting until 3:00:00 PM'), { outcome: 'rate_limited' });
const checkAttempt = (a, provider, outcome) => {
  assert.deepEqual(Object.keys(a).sort(), ['model', 'ms', 'outcome', 'provider']);
  assert.equal(a.provider, provider); assert.equal(a.outcome, outcome);
  assert.ok(Number.isFinite(a.ms) && a.ms >= 0, String(a.ms));
};

test('attempts: the cloud answers first try; the route keeps the plan\'s why and lists one answered attempt', async () => {
  const { c } = setup();
  const r = c.route({ kind: 'plan', text: 'x' }), tried = [];
  const out = await c.run(r, msgs, { kind: 'plan', attempts: tried });
  assert.equal(out.used.why, r.why);
  assert.equal(out.used.attempts.length, 1);
  checkAttempt(out.used.attempts[0], 'groq', 'answered');
  assert.equal(out.used.attempts[0].model, 'openai/gpt-oss-120b');
  assert.deepEqual(tried, out.used.attempts);
});

test('attempts: the first cloud model times out, the second answers, and the why says so', async () => {
  let n = 0;
  const { c } = setup({ answer: () => (n++ === 0 ? timedOut() : { content: 'Cerebras answer' }) });
  const out = await c.run(c.route({ kind: 'plan', text: 'x' }), msgs, { kind: 'plan' });
  assert.equal(out.used.provider, 'cerebras');
  assert.equal(out.used.why, 'Groq timed out, so Cerebras answered');
  checkAttempt(out.used.attempts[0], 'groq', 'timeout');
  checkAttempt(out.used.attempts[1], 'cerebras', 'answered');
});

test('attempts: every cloud model fails, this PC answers, and the route says what was tried', async () => {
  let n = 0;
  const { c } = setup({ answer: () => (n++ === 0 ? timedOut() : busy()) });
  const r = c.route({ kind: 'research', text: 'Compare PETG and ASA' }), tried = [];
  assert.equal(await c.run(r, msgs, { kind: 'research', attempts: tried }), null);
  const used = c.local(r, 'local-model', tried);
  assert.deepEqual([used.provider, used.model, used.class], ['ollama', 'local-model', 'shareable']);
  assert.equal(used.why, "Cloud models didn't answer (Groq: timed out; Cerebras: busy), so this PC answered");
  assert.equal(used.attempts.length, 2);
  checkAttempt(used.attempts[0], 'groq', 'timeout');
  checkAttempt(used.attempts[1], 'cerebras', 'rate_limited');
  assert.ok(!JSON.stringify(used).includes('Models page'), 'no prompt text');
});

test('attempts: an error without an outcome is classified from its words; an empty answer is an error', async () => {
  const words = [new Error('Groq: timed out'), new Error('Cerebras: HTTP 503')];
  const { c } = setup({ answer: () => words.shift() });
  const tried = [];
  await c.run(c.route({ kind: 'plan', text: 'x' }), msgs, { kind: 'plan', attempts: tried });
  assert.deepEqual(tried.map(a => a.outcome), ['timeout', 'error']);
  const { c: c2 } = setup({ answer: () => ({ content: '' }) });
  const tried2 = [];
  assert.equal(await c2.run(c2.route({ kind: 'plan', text: 'x' }), msgs, { kind: 'plan', attempts: tried2 }), null);
  assert.deepEqual(tried2.map(a => a.outcome), ['error', 'error']);
  assert.match(c2.local(c2.route({ kind: 'plan', text: 'x' }), 'q', tried2).why, /Groq: failed; Cerebras: failed/);
});

test('attempts: a local-only plan tries nothing and records the route exactly as before', async () => {
  const { c, calls } = setup({ cloud: false });
  const r = c.route({ kind: 'plan', text: 'x' }), tried = [];
  assert.equal(await c.run(r, msgs, { kind: 'plan', attempts: tried }), null);
  assert.deepEqual(tried, []);
  assert.deepEqual(c.local(r, 'qwen', tried), { provider: 'ollama', model: 'qwen', class: r.class, why: r.why });
  assert.equal(calls.length, 0);
});

test('attempts: the list is capped', () => {
  const { c } = setup();
  const r = c.route({ kind: 'plan', text: 'x' });
  const many = Array.from({ length: 9 }, () => ({ provider: 'groq', model: 'm', outcome: 'timeout', ms: 1 }));
  assert.equal(c.local(r, 'q', many).attempts.length, 5);
});

// Stop, or a caller that goes away: run() passes its signal to each cloud call, and an abort ends it there: no next
// cloud model, no fall-through to this PC.
test('an abort during a cloud call ends run() with the reason and tries nothing else', async () => {
  const calls = [];
  const cloudModels = {
    keys: () => ({ groq: true, cerebras: true }), parked: () => ({}),
    chat: req => { calls.push(req); return new Promise((_, reject) => req.signal?.addEventListener('abort', () => reject(req.signal.reason), { once: true })); },
  };
  const c = createCoordinator({ modelRouter, cloudModels, routingSetting: () => ({ cloud: true }), env: {} });
  const ac = new AbortController(), reason = new Error('Cancelled by user');
  const ran = c.run(c.route({ kind: 'plan', text: 'x' }), msgs, { kind: 'plan', signal: ac.signal });
  await new Promise(r => setTimeout(r, 20));
  ac.abort(reason);
  const outcome = await Promise.race([ran.then(() => 'returned', e => e), new Promise(r => setTimeout(() => r('still waiting'), 500))]);
  assert.equal(outcome, reason);
  assert.equal(calls.length, 1, 'the next cloud model is not asked');
  assert.ok(calls[0].signal, 'the call got the signal');
  await assert.rejects(c.run(c.route({ kind: 'plan', text: 'x' }), msgs, { kind: 'plan', signal: ac.signal }), e => e === reason);
  assert.equal(calls.length, 1, 'an already-aborted run asks no one');
});

// A Stop is never listed as a failed cloud try: the route a run records names only what the cloud did.
test('attempts: a Stop during a cloud call is not recorded; the try before it still is', async () => {
  let n = 0;
  const cloudModels = {
    keys: () => ({ groq: true, cerebras: true }), parked: () => ({}),
    chat: req => (n++ === 0
      ? Promise.reject(Object.assign(new Error('Groq: timed out'), { outcome: 'timeout' }))
      : new Promise((_, reject) => req.signal?.addEventListener('abort', () => reject(req.signal.reason), { once: true }))),
  };
  const c = createCoordinator({ modelRouter, cloudModels, routingSetting: () => ({ cloud: true }), env: {} });
  const ac = new AbortController(), tried = [];
  const ran = c.run(c.route({ kind: 'plan', text: 'x' }), msgs, { kind: 'plan', signal: ac.signal, attempts: tried });
  await new Promise(r => setTimeout(r, 20));
  ac.abort(new Error('Cancelled by user'));
  await assert.rejects(ran, /Cancelled by user/);
  assert.deepEqual(tried.map(a => [a.provider, a.outcome]), [['groq', 'timeout']], 'only the timeout, not the Stop');
  const before = new AbortController(); before.abort(new Error('Client disconnected'));
  const none = [];
  await assert.rejects(c.run(c.route({ kind: 'plan', text: 'x' }), msgs, { kind: 'plan', signal: before.signal, attempts: none }), /Client disconnected/);
  assert.deepEqual(none, []);
});
