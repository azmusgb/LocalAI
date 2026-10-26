'use strict';

// The model coordinator (docs/superpowers/specs/2026-10-26-model-coordinator-design.md): which model answers a request.
// Local by default. Free US cloud models (Groq, then Cerebras) only for work that isn't private, only when the owner has
// switched cloud on, and always with this PC's model last, so a request never fails only because the cloud did.
// Pure: the caller passes what it knows (kind, text, switch, keys, parked providers); nothing here does I/O.

// Kinds of work, and whether each may ever leave the PC. `chat` only with "Use a bigger model" (bigger: true).
const KINDS = Object.freeze({
  quick: { cloud: false, label: 'Quick jobs: titles, intent, voice, image prompts' },
  chat: { cloud: 'bigger', label: 'Ask: on this PC unless you choose "Use a bigger model"' },
  research: { cloud: true, label: 'Research about public topics' },
  plan: { cloud: true, label: 'Change planning and mission summaries' },
  code: { cloud: true, label: "Code changes to Local AI's own code" },
  mission: { cloud: false, label: 'Mission steps' },
});

// The cloud models per role, in the order tried. Env overrides change a model without code.
const CLOUD = Object.freeze({
  reasoner: [['groq', 'LOCALAI_GROQ_REASONER', 'llama-3.3-70b-versatile'], ['cerebras', 'LOCALAI_CEREBRAS_REASONER', 'llama-3.3-70b']],
  coder: [['groq', 'LOCALAI_GROQ_CODER', 'openai/gpt-oss-120b'], ['cerebras', 'LOCALAI_CEREBRAS_CODER', 'gpt-oss-120b']],
});

// Words that make a request private whatever its kind: health, money, identity. The guard only ever moves work toward
// this PC; a false match costs a slower answer, a missed one would send something personal out.
const PERSONAL = /\b(medic(al|ine|ation)s?|dose|dosage|prescription|diagnos\w*|symptoms?|therapy|therapist|doctor|clinic|hospital|blood|pregnan\w*|mental health|anxiety|depression|weight loss|insulin|bank|account (number|no)|routing number|credit card|social security|ssn|passport|tax return|salary|password|my (address|phone number|birthday|date of birth))\b/i;

function personal(text) { return PERSONAL.test(String(text || '')); }

// route({kind, text, voice, house, attachments, keepLocal, bigger, model, cloud, keys, parked, env, localModel, now})
// → {class: 'private'|'shareable', why, order: [{provider, model}]}
function route(req = {}) {
  const local = { provider: 'ollama', model: req.model || req.localModel };
  if (req.model) return { class: 'private', why: 'You picked this model', order: [local] };
  const kind = Object.prototype.hasOwnProperty.call(KINDS, req.kind) ? req.kind : 'quick';
  const why = req.keepLocal ? 'You asked to keep it on this PC'
    : req.voice ? 'Voice and Siri stay on this PC'
    : req.house ? 'House questions stay on this PC'
    : req.attachments ? 'Files and photos stay on this PC'
    : personal(req.text) ? 'It looks personal (health, money or identity)'
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

// The read-only routing table for the Models page.
function table() {
  return Object.entries(KINDS).map(([kind, k]) => ({ kind, label: k.label, cloud: k.cloud !== false }));
}

module.exports = { route, table, personal, KINDS, CLOUD };
