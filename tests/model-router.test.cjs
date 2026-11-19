'use strict';
// The model coordinator (docs/superpowers/specs/2026-10-26-model-coordinator-design.md): local by default; free US
// cloud models (Groq, Cerebras) only for work that isn't private, only when the owner has switched cloud on.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const R = require('../app/model-router');

const KEYS = { groq: true, cerebras: true };
const base = { kind: 'research', text: 'What changed in Bambu X2D firmware 1.2?', cloud: true, keys: KEYS, localModel: 'qwen3:4b-instruct-32k' };
const providers = r => r.order.map(c => c.provider);

test('shareable research with cloud on: Groq, then Cerebras, then this PC', () => {
  const r = R.route(base);
  assert.equal(r.class, 'shareable');
  assert.deepEqual(providers(r), ['groq', 'cerebras', 'ollama']);
  assert.equal(r.order.at(-1).model, 'qwen3:4b-instruct-32k');
  assert.equal(r.order[0].model, 'openai/gpt-oss-120b');
});

test('code goes to the cloud coder first', () => {
  assert.equal(R.route({ ...base, kind: 'code' }).order[0].model, 'openai/gpt-oss-120b');
});

test('cloud off: everything on this PC', () => {
  assert.deepEqual(providers(R.route({ ...base, cloud: false })), ['ollama']);
});

test('plain chat stays on this PC unless "Use a bigger model"', () => {
  assert.deepEqual(providers(R.route({ ...base, kind: 'chat' })), ['ollama']);
  assert.deepEqual(providers(R.route({ ...base, kind: 'chat', bigger: true })), ['groq', 'cerebras', 'ollama']);
});

test('quick jobs and mission steps are always local', () => {
  for (const kind of ['quick', 'mission', 'anything-else']) assert.deepEqual(providers(R.route({ ...base, kind, bigger: true })), ['ollama'], kind);
});

test('private requests never get a cloud model', () => {
  const privates = [
    { voice: true }, { house: true }, { attachments: 1 }, { keepLocal: true },
    { text: 'What dose of ibuprofen with my blood pressure medication?' },
    { text: 'Summarise my therapy notes from last week' },
    { text: 'My bank account number is 12345678, check this statement' },
  ];
  for (const p of privates) {
    for (const kind of ['chat', 'research', 'plan', 'code']) {
      const r = R.route({ ...base, ...p, kind, bigger: true });
      assert.equal(r.class, 'private', JSON.stringify(p));
      assert.deepEqual(providers(r), ['ollama'], JSON.stringify(p) + kind);
      assert.ok(r.why, 'says why');
    }
  }
});

// Amendment A28 D5: a prompt that carries journal entries (Past work) is private whatever else is asked for.
test('journal text never gets a cloud model, with "Use a bigger model" on and cloud switched on', () => {
  assert.deepEqual(providers(R.route({ ...base, kind: 'chat', bigger: true })), ['groq', 'cerebras', 'ollama'], 'without the journal, this request would go out');
  for (const kind of ['chat', 'research', 'plan', 'code']) {
    const r = R.route({ ...base, kind, journal: true, bigger: true, text: 'Compare PETG and ASA for outdoor parts' });
    assert.equal(r.class, 'private', kind);
    assert.deepEqual(r.order, [{ provider: 'ollama', model: base.localModel }], kind);
    assert.equal(r.why, 'Your past work stays on this PC');
    assert.equal(R.stickyPrivate(r), true, 'and so does the rest of that conversation');
  }
});

test('a provider without a key, or parked after a rate limit, is skipped', () => {
  assert.deepEqual(providers(R.route({ ...base, keys: { cerebras: true } })), ['cerebras', 'ollama']);
  assert.deepEqual(providers(R.route({ ...base, parked: { groq: Date.now() + 60000 } })), ['cerebras', 'ollama']);
  assert.deepEqual(providers(R.route({ ...base, parked: { groq: Date.now() - 1 } })), ['groq', 'cerebras', 'ollama']);
  assert.deepEqual(providers(R.route({ ...base, keys: {} })), ['ollama']);
});

test('a model the owner picked by hand is used as it is, on this PC', () => {
  const r = R.route({ ...base, model: 'gemma3:4b' });
  assert.deepEqual(r.order, [{ provider: 'ollama', model: 'gemma3:4b' }]);
});

test('model names can be changed without code', () => {
  const r = R.route({ ...base, env: { LOCALAI_GROQ_REASONER: 'llama-4-scout', LOCALAI_CEREBRAS_REASONER: 'qwen-3-32b' } });
  assert.deepEqual(r.order.slice(0, 2).map(c => c.model), ['llama-4-scout', 'qwen-3-32b']);
});

test('the routing table names each kind and where it may run', () => {
  const t = R.table();
  assert.ok(t.find(x => x.kind === 'research' && x.cloud) && t.find(x => x.kind === 'quick' && !x.cloud));
});

// Steps 2 and 3: a caller's own reason to stay here; the Models page's words; "Answered by".
test('stay: a caller\'s reason keeps the work on this PC, with that reason', () => {
  for (const kind of ['research', 'plan', 'code']) {
    const r = R.route({ ...base, kind, stay: 'Your workspace files stay on this PC' });
    assert.deepEqual(providers(r), ['ollama']);
    assert.equal(r.class, 'private');
    assert.equal(r.why, 'Your workspace files stay on this PC');
  }
});

test('every routing table row says where that work runs, in plain words', () => {
  for (const row of R.table()) assert.ok(typeof row.where === 'string' && row.where.length > 10, row.kind);
  assert.match(R.table().find(x => x.kind === 'quick').where, /this PC/);
});

test('label: "Answered by <Model> · <Provider>" or "Answered on this PC"', () => {
  assert.equal(R.label({ provider: 'groq', model: 'llama-3.3-70b-versatile' }), 'Answered by Llama 3.3 70B · Groq');
  assert.equal(R.label({ provider: 'cerebras', model: 'llama-3.3-70b' }), 'Answered by Llama 3.3 70B · Cerebras');
  assert.equal(R.label({ provider: 'groq', model: 'openai/gpt-oss-120b' }), 'Answered by GPT-OSS 120B · Groq');
  assert.equal(R.label({ provider: 'groq', model: 'llama-4-scout' }), 'Answered by llama-4-scout · Groq');
  assert.equal(R.label({ provider: 'ollama', model: 'qwen3:4b' }), 'Answered on this PC');
  assert.equal(R.label(null), '');
  assert.equal(R.label({ provider: 'evil', model: 'x' }), '');
});

// Review of #402: a private reason that belongs to the request (not to its kind) holds for the rest of the conversation.
test('stickyPrivate: request reasons stick to a conversation, kind defaults and a picked model do not', () => {
  for (const p of [{ voice: true }, { house: true }, { attachments: 1 }, { keepLocal: true }, { text: 'my insulin dose' }, { stay: 'Requests with their own instructions stay on this PC' }])
    assert.equal(R.stickyPrivate(R.route({ ...base, kind: 'chat', bigger: true, ...p })), true, JSON.stringify(p));
  for (const r of [R.route({ ...base, kind: 'chat' }), R.route({ ...base, kind: 'quick' }), R.route({ ...base, model: 'gemma3:4b' }), R.route({ ...base, cloud: false }), R.route(base)])
    assert.equal(R.stickyPrivate(r), false, r.why);
  // Runs recorded before `sticky` existed (#398) are judged by their reason.
  assert.equal(R.stickyPrivate({ class: 'private', why: 'Voice and Siri stay on this PC' }), true);
  assert.equal(R.stickyPrivate({ class: 'private', why: 'Ask stays on this PC unless you choose a bigger model' }), false);
  assert.equal(R.stickyPrivate(null), false);
});
