'use strict';

// The model coordinator (docs/superpowers/specs/2026-10-26-model-coordinator-design.md): which model answers a request.
// Local by default. Free US cloud models (Groq, then Cerebras) only for work that isn't private, only when the owner has
// switched cloud on, and always with this PC's model last, so a request never fails only because the cloud did.
// Pure: the caller passes what it knows (kind, text, switch, keys, parked providers); nothing here does I/O.

// Kinds of work, and whether each may ever leave the PC. `chat` only with "Use a bigger model" (bigger: true).
const KINDS = Object.freeze({
  quick: { cloud: false, label: 'Quick jobs: titles, intent, voice, image prompts', where: 'Always on this PC' },
  chat: { cloud: 'bigger', label: 'Ask: on this PC unless you choose "Use a bigger model"', where: 'On this PC, unless you tap "Use a bigger model" and it isn\'t private' },
  research: { cloud: true, label: 'Research about public topics', where: 'A cloud model when it isn\'t private, else this PC' },
  plan: { cloud: true, label: 'Change planning and mission summaries', where: "A cloud model for Local AI's own code when it isn't private, else this PC" },
  code: { cloud: true, label: "Code changes to Local AI's own code", where: "A cloud code model for Local AI's own code when it isn't private, else this PC" },
  mission: { cloud: false, label: 'Mission steps', where: 'Always on this PC' },
});

// The cloud models per role, in the order tried. Env overrides change a model without code.
const CLOUD = Object.freeze({
  reasoner: [['groq', 'LOCALAI_GROQ_REASONER', 'openai/gpt-oss-120b'], ['cerebras', 'LOCALAI_CEREBRAS_REASONER', 'llama-3.3-70b']],
  coder: [['groq', 'LOCALAI_GROQ_CODER', 'openai/gpt-oss-120b'], ['cerebras', 'LOCALAI_CEREBRAS_CODER', 'gpt-oss-120b']],
});

// Words that make a request private whatever its kind: health, money, legal, family, identity. The guard only ever moves
// work toward this PC; a false match costs a slower answer, a missed one would send something personal out. So it leans
// inclusive ("bank of the river", "attorney general", "loan calculator" match), but a word too common to mean anything
// alone counts only in a personal phrase: "will" (my will, living will), "PIN" (PIN code, my PIN), "pain" (not "pain
// point"), "debt" (not "tech debt"). Words that mostly mean code or business work (pill, income, invoice) are left out.
const PERSONAL_WORDS = [
  // Health
  'medic(al|ine|ation)s?', 'dose', 'dosage', 'prescriptions?', 'diagnos\\w*', 'symptoms?', 'therapy', 'therapist', 'doctor',
  'clinic', 'hospital', 'blood', 'pregnan\\w*', 'mental health', 'anxiety', 'depression', 'weight loss', 'insulin',
  'surger(y|ies)', 'surgeon', 'cancer', 'tumou?rs?', 'allerg(y|ies|ic)', 'rash(es)?', 'pain(?![\\s-]*points?\\b)',
  'painkillers?', 'injur(y|ies|ed)', 'fever', 'diabet\\w*', 'asthma', 'cholesterol', 'vaccin\\w*', 'infection',
  'migraines?', 'dentist', 'panic attacks?', 'adhd',
  // Money
  'bank', 'account (number|no)', 'routing number', 'credit (card|score|report)', 'iban', 'pin (code|number)', 'my pin',
  'loans?', 'mortgages?', '(?<!\\btech(nical)?[\\s-]+)debts?', 'bankrupt\\w*', 'insurance', 'pensions?', '401k', 'iras?',
  'paychecks?', 'pay ?stubs?', 'payslips?', 'salary', 'tax (return|refund)s?', 'w-?2',
  // Legal
  'lawyers?', 'attorneys?', 'lawsuits?', 'divorc\\w*', 'custody', 'my will', 'living will', 'will and testament',
  'estate plan\\w*', 'probate', 'court (date|case|hearing)s?', 'restraining order',
  // Identity and family
  'social security', 'ssn', 'passport', 'driver\'?s licen[cs]e', 'birth certificate', 'date of birth', 'home address',
  'password', 'my (address|phone number|birthday|wife|husband|partner|kids?|children|son|daughter)',
];
// "401(k)" ends in ")", which a trailing \b can't follow, so it is its own alternative.
const PERSONAL = new RegExp(`\\b(${PERSONAL_WORDS.join('|')})\\b|\\b401\\(k\\)`, 'i');

function personal(text) { return PERSONAL.test(String(text || '')); }

// route({kind, text, voice, house, journal, attachments, keepLocal, stay, bigger, model, cloud, keys, parked, env, localModel, now})
// journal: the prompt carries journal entries (Past work). Stored text never reaches a cloud model (amendment A28 D5).
// → {class: 'private'|'shareable', why, order: [{provider, model}]}
function route(req = {}) {
  const local = { provider: 'ollama', model: req.model || req.localModel };
  // Reasons from the request itself. They win over "You picked this model" so they stay sticky for the conversation
  // (stickyPrivate below) even when a model was picked by hand.
  const asked = req.keepLocal ? 'You asked to keep it on this PC'
    : req.voice ? 'Voice and Siri stay on this PC'
    : req.house ? 'House questions stay on this PC'
    : req.journal ? 'Your past work stays on this PC'
    : req.attachments ? 'Files and photos stay on this PC'
    : typeof req.stay === 'string' && req.stay ? req.stay
    : personal(req.text) ? 'It looks personal (health, money, legal, family or identity)'
    : null;
  if (req.model) return { class: 'private', why: asked || 'You picked this model', order: [local] };
  const kind = Object.prototype.hasOwnProperty.call(KINDS, req.kind) ? req.kind : 'quick';
  const why = asked ? asked
    : KINDS[kind].cloud === false ? 'This kind of work stays on this PC'
    : KINDS[kind].cloud === 'bigger' && !req.bigger ? 'Ask stays on this PC unless you choose a bigger model'
    : null;
  if (why) return { class: 'private', why, order: [local] };
  if (!req.cloud) return { class: 'shareable', why: 'Cloud models are switched off', order: [local] };
  const now = req.now ?? Date.now(), env = req.env || {}, keys = req.keys || {}, parked = req.parked || {};
  const cloud = CLOUD[kind === 'code' ? 'coder' : 'reasoner']
    .filter(([provider]) => keys[provider] && !(parked[provider] > now))
    .map(([provider, envName, model]) => ({ provider, model: env[envName] || model }));
  return { class: 'shareable', why: cloud.length ? `Not private: ${KINDS[kind].label.toLowerCase()}` : 'No cloud model available right now', order: [...cloud, local] };
}

// Reasons that come from the request itself (voice, House, files, "Keep on this PC", personal words, a caller's own
// reason) hold for the rest of its conversation: a follow-up doesn't resend those markers. A kind's default ("Ask stays
// on this PC unless …"), a model picked by hand, cloud switched off or unavailable don't.
const NOT_STICKY = new Set(['You picked this model', 'This kind of work stays on this PC', 'Ask stays on this PC unless you choose a bigger model']);
function stickyPrivate(r) {
  return !!r && typeof r === 'object' && r.class === 'private' && typeof r.why === 'string' && r.why !== '' && !NOT_STICKY.has(r.why);
}

// The read-only routing table for the Models page.
function table() {
  return Object.entries(KINDS).map(([kind, k]) => ({ kind, label: k.label, where: k.where, cloud: k.cloud !== false }));
}

// Where an answer came from, for run cards and pages: "Answered by GPT-OSS 120B · Groq" or "Answered on this PC".
const PROVIDER_NAMES = Object.freeze({ groq: 'Groq', cerebras: 'Cerebras' });
const MODEL_NAMES = [[/^llama-3\.3-70b(-versatile)?$/, 'Llama 3.3 70B'], [/^(openai\/)?gpt-oss-120b$/, 'GPT-OSS 120B']];
function label(used) {
  if (!used || typeof used !== 'object') return '';
  if (used.provider === 'ollama') return 'Answered on this PC';
  const provider = Object.prototype.hasOwnProperty.call(PROVIDER_NAMES, used.provider) ? PROVIDER_NAMES[used.provider] : '';
  if (!provider) return '';
  const model = String(used.model || '').slice(0, 60), named = MODEL_NAMES.find(([re]) => re.test(model));
  return `Answered by ${named ? named[1] : model || 'a cloud model'} · ${provider}`;
}

module.exports = { route, table, label, personal, stickyPrivate, KINDS, CLOUD };
