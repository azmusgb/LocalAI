'use strict';
// Owner facts (docs/superpowers/specs/2026-11-19-owner-facts-design.md): a short list of lasting facts about the owner
// and the house, kept as notes in the `memory` store with projectId '' and category 'owner'. These are the rules the
// server's memory routes enforce, and that the prompt stage reuses to fit the facts into a character budget.
// Pure: no store, no clock; callers pass the notes in.

const CATEGORY = 'owner';
const MAX_FACTS = 30;
const MAX_LENGTH = 200;
const BUDGET = 800;          // characters of facts a prompt carries (spec §3)

const isFact = n => !!n && typeof n === 'object' && n.category === CATEGORY && (n.projectId || '') === '';

// One line: line breaks and runs of spaces become one space, ends trimmed.
function normalise(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

// The key two facts are compared by: case, punctuation and spacing don't count.
function sameKey(text) {
  return normalise(text).toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, '').replace(/\s+/g, ' ').trim();
}

// -> {ok:true, text} with the text as it is stored, or {ok:false, error} in the owner's words.
function check(text) {
  if (typeof text !== 'string') return { ok: false, error: 'Write the fact as text.' };
  const t = normalise(text);
  if (!t) return { ok: false, error: 'Write the fact first.' };
  if (t.length > MAX_LENGTH) return { ok: false, error: `A fact is one sentence of up to ${MAX_LENGTH} characters; this one has ${t.length}.` };
  return { ok: true, text: t };
}

// The facts among any notes, newest first (createdAt, then the order given).
function facts(notes) {
  const list = (Array.isArray(notes) ? notes : []).filter(isFact);
  const at = n => { const v = Date.parse(n.createdAt); return Number.isNaN(v) ? 0 : v; };
  return list.map((n, i) => [n, i]).sort((a, b) => at(b[0]) - at(a[0]) || a[1] - b[1]).map(([n]) => n);
}

// Whether text may join the list. exceptId: the note being edited or made a fact (it doesn't count against itself).
// -> {ok:true, text} | {ok:false, error, full?, duplicate?}
function canSave(notes, text, exceptId = '') {
  const c = check(text);
  if (!c.ok) return c;
  const others = facts(notes).filter(n => n.id !== exceptId);
  const key = sameKey(c.text);
  if (others.some(n => sameKey(n.text) === key)) return { ok: false, duplicate: true, error: 'That fact is already on your list.' };
  const editing = exceptId && facts(notes).some(n => n.id === exceptId);
  if (!editing && others.length >= MAX_FACTS) return { ok: false, full: true, error: fullMessage() };
  return c;
}

function fullMessage() {
  return `Your list is full: ${MAX_FACTS} of ${MAX_FACTS}. Delete or edit a fact to make room; nothing is removed for you.`;
}

// The facts that fit in `budget` characters, each costing its length plus `overhead` (the line's bullet and break).
// Older facts keep their place: when the list is too long, the newest go first. A fact too long for what is left is
// left out and a shorter, newer one may still fit. -> {kept, left} (kept oldest first; left newest first).
function select(notes, budget = BUDGET, overhead = 3) {
  const room = Number.isFinite(budget) && budget > 0 ? budget : 0;
  const pad = Number.isFinite(overhead) && overhead >= 0 ? overhead : 0;
  const oldestFirst = facts(notes).reverse();
  const kept = [], left = [];
  let used = 0;
  for (const n of oldestFirst) {
    const cost = String(n.text || '').length + pad;
    if (used + cost <= room) { kept.push(n); used += cost; } else left.push(n);
  }
  return { kept, left: left.reverse(), used };
}

module.exports = { CATEGORY, MAX_FACTS, MAX_LENGTH, BUDGET, isFact, normalise, sameKey, check, facts, canSave, fullMessage, select };
