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
  assert.equal(r.why, 'You picked this model');
  assert.equal(R.stickyPrivate(r), false);
});

test('a picked model keeps a reason from the request, so it stays sticky for the conversation', () => {
  for (const [extra, why] of [
    [{ stay: 'Project notes stay on this PC' }, 'Project notes stay on this PC'],
    [{ voice: true }, 'Voice and Siri stay on this PC'],
    [{ attachments: true }, 'Files and photos stay on this PC'],
    [{ text: 'what dose of insulin' }, 'It looks personal (health, money or identity)'],
  ]) {
    const r = R.route({ ...base, model: 'gemma3:4b', ...extra });
    assert.deepEqual(r.order, [{ provider: 'ollama', model: 'gemma3:4b' }]);
    assert.equal(r.why, why);
    assert.equal(R.stickyPrivate(r), true, why);
  }
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

// Owner carry-forward: the personal words missed common health, money, legal, family and identity words, so a request
// like "refinance my mortgage" could go out. Each prompt below must stay on this PC with the personal reason, in every
// kind that could otherwise reach a cloud model.
const PERSONAL_WHY = 'It looks personal (health, money or identity)';
const NEW_PERSONAL = [
  // Money
  'Should I refinance the loan on my car?', 'Compare my mortgage offers', 'How fast can I pay off this debt?',
  'Pay down my debts first or save?', 'Is my car insurance too high?', 'When can I draw my pension?',
  'Move my 401k to a new job', 'How much is in my 401(k) after the match?', 'Roth IRA or traditional for me?',
  'My paycheck was short this week', 'Read my pay stub and check the deductions', 'Why did my credit score drop?',
  'Dispute an error on my credit report', 'Here is my IBAN for the transfer', 'I forgot my PIN code',
  'Change my PIN for the debit card', 'Check this invoice from the plumber', 'Can I afford it on my income?',
  'Help me fill in my W-2', 'When will my tax refund arrive?', 'Should I file for bankruptcy?',
  // Health
  'Recovery time after knee surgery', 'My dad has cancer, what questions should we ask?', 'Is this a peanut allergy?',
  'My allergies are bad this spring', 'Which pills can I take together?', 'A rash on my arm that itches',
  'Sharp pain in my lower back', 'Best painkillers for a migraine', 'Ankle injury from running, what now?',
  'Is a fever of 101 dangerous?', 'Managing type 2 diabetes with diet', 'My asthma inhaler is running out',
  'Is my cholesterol too high?', 'When is my next vaccine due?', 'Signs of an infection after a cut',
  'Book a dentist for next week', 'I had a panic attack at work', 'Living with ADHD as an adult',
  // Legal
  'Do I need a lawyer for this?', 'Find an attorney near me', 'Should I file a lawsuit against them?',
  'We are getting a divorce', 'Shared custody schedule for two kids', 'Update my will after the move',
  'Write a living will', 'Last will and testament template for me', 'Start my estate plan',
  'How long does probate take?', 'My court date is next Tuesday', 'Get a restraining order',
  // Identity and family
  "Renew my driver's license", 'Renew my drivers license online', 'Copy of my birth certificate',
  'What is my date of birth on file?', 'Send it to my home address', 'Gift ideas for my wife',
  'My husband snores', 'Screen time rules for my kids', 'My daughter is starting school',
];

test('personal words: health, money, legal, family and identity requests stay on this PC', () => {
  for (const text of NEW_PERSONAL) {
    assert.equal(R.personal(text), true, text);
    for (const kind of ['chat', 'research', 'plan', 'code']) {
      const r = R.route({ ...base, kind, bigger: true, text });
      assert.equal(r.class, 'private', `${kind}: ${text}`);
      assert.equal(r.why, PERSONAL_WHY, `${kind}: ${text}`);
      assert.deepEqual(providers(r), ['ollama'], `${kind}: ${text}`);
    }
  }
});

// The words are whole words, and the words too common to mean anything on their own ("will", "pin", "pain point")
// only count in a personal phrase. These ordinary prompts still reach a cloud model when the owner allows it.
const ORDINARY = [
  'Fix the pain point in the onboarding flow', 'List the top pain-points from the survey',
  'Pin the dependency version in package.json', 'Which GPIO pin drives the fan?', 'Pin this tab',
  'What will the weather be like in Phoenix?', 'Will this compile on Node 22?', 'Free will in philosophy',
  'Explain mutex locks in Rust', 'Write a function to sort an array', 'Pillow sizes for a queen bed',
  'How does a suspension bridge carry load?', 'Calm down irate customers in support replies',
  'A rasher of bacon in grams', 'Spiralize the zucchini', 'Compare PETG and ASA for outdoor parts',
  'Tune the retraction on the X2D', 'Painting tips for PLA prints', 'Explain the Ideal gas law',
];

test('personal words: ordinary prompts are not personal and may still use a cloud model', () => {
  for (const text of ORDINARY) {
    assert.equal(R.personal(text), false, text);
    const r = R.route({ ...base, text });
    assert.equal(r.class, 'shareable', text);
    assert.deepEqual(providers(r), ['groq', 'cerebras', 'ollama'], text);
  }
});

// Accepted false positives: the guard can't tell these from the personal sense, and a false match only costs a slower
// answer on this PC. Kept here so a later change to them is a decision, not an accident.
test('personal words: accepted false positives stay on this PC', () => {
  for (const text of ['Picnic on the bank of the river', 'Who is the attorney general?', 'Chain of custody for evidence'])
    assert.equal(R.personal(text), true, text);
});
