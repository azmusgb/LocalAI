'use strict';

// Short spoken summaries for Siri Shortcuts on an iPhone or Apple Watch ("What needs me?", "Is Local AI OK?").
// Pure: the server gathers the counts, this turns them into one or two sentences that read well aloud.

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function list(parts) {
  if (parts.length <= 1) return parts[0] || '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function sentence(text) {
  const t = String(text || '').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) + (/[.!?]$/.test(t) ? '' : '.') : '';
}

// services: [{ label, required, state }] as in the capability snapshot.
function healthSummary({ services = [], version = '' } = {}) {
  const core = services.filter(s => s && s.required !== false);
  const down = core.filter(s => s.state !== 'HEALTHY').map(s => s.label || s.name || 'A service');
  const ok = down.length === 0;
  let speech;
  if (!core.length) speech = 'Local AI is running, but its services could not be checked.';
  else if (ok) speech = `Local AI${version ? ` ${version}` : ''} is running and all ${core.length} core services are up.`;
  else if (down.length === core.length) speech = 'Local AI is running, but none of its core services are answering.';
  else speech = `${sentence(`${list(down)} ${down.length === 1 ? 'is' : 'are'} down`)} Everything else is up.`;
  return { ok, down, total: core.length, speech };
}

// counts: approvals pending, unfinished change requests, Claude findings waiting for a decision,
// runs failed in the last day, runs in progress.
function needsYouSummary({ approvals = 0, changes = 0, findings = 0, failedToday = 0, running = 0 } = {}, health = null) {
  const items = [];
  if (approvals) items.push({ kind: 'approvals', count: approvals, text: plural(approvals, 'approval') });
  if (changes) items.push({ kind: 'changes', count: changes, text: plural(changes, 'unfinished change request') });
  if (findings) items.push({ kind: 'findings', count: findings, text: plural(findings, 'Claude finding') + ' to decide' });
  const sentences = [];
  sentences.push(items.length ? `Needs you: ${list(items.map(i => i.text))}.` : 'Nothing needs you right now.');
  if (failedToday) sentences.push(sentence(`${plural(failedToday, 'run')} failed today`));
  if (running) sentences.push(sentence(`${plural(running, 'run')} ${running === 1 ? 'is' : 'are'} in progress`));
  if (health && !health.ok) sentences.push(health.speech);
  return { count: items.reduce((n, i) => n + i.count, 0), items, speech: sentences.join(' ') };
}

const NUMBER_WORDS = ['No', 'One', 'Two', 'Three'];

// data: { approvals, changes, findings, failedRuns, downServices } as arrays of { title } (or { label } for services).
// Returns the things that need the owner, by name, in the order they are spoken.
// Titles are often whole requests or model summaries; read aloud, the first sentence and at most ten words is enough.
function spokenTitle(text) {
  const first = String(text || '').split('\n').map(l => l.trim()).find(Boolean) || '';
  const sentence = first.split(/(?<=[.!?])\s+/)[0].replace(/[.!?]+$/, '').trim();
  const words = sentence.split(/\s+/).filter(Boolean);
  const kept = words.length > 10 ? words.slice(0, 10) : words;
  // A cut title shouldn't end on "the", "to", "of"…
  if (words.length > 10) while (kept.length > 1 && /^(the|a|an|to|of|and|or|by|for|with|in|on|at|from|that)$/i.test(kept[kept.length - 1])) kept.pop();
  return kept.join(' ').replace(/[,;:]+$/, '');
}
// A failed chat, research question or image is named by what it was, not by its prompt.
// Several of one kind are counted ("3 chat questions failed"), not repeated.
const FAILED_KIND = { chat: ['a chat question', 'chat questions'], research: ['a research question', 'research questions'], image: ['an image', 'images'] };

function needsYouItems({ approvals = [], changes = [], findings = [], failedRuns = [], downServices = [] } = {}) {
  const name = x => spokenTitle(x?.title || x?.label || x?.name || '');
  const out = [];
  const add = (kind, rows) => { for (const r of rows) { const title = name(r); if (title) out.push({ kind, title }); } };
  add('approval', approvals); add('change', changes); add('finding', findings);
  const generic = new Map();
  for (const r of failedRuns) {
    if (FAILED_KIND[r?.type]) generic.set(r.type, (generic.get(r.type) || 0) + 1);
    else { const title = name(r); if (title) out.push({ kind: 'failed', title }); }
  }
  for (const [type, n] of generic) out.push({ kind: 'failed', title: n === 1 ? FAILED_KIND[type][0] : `${n} ${FAILED_KIND[type][1]}`, generic: true });
  add('down', downServices);
  return out;
}

function itemPhrase(item) {
  if (item.kind === 'failed') return item.generic ? `${item.title} failed` : `the ${item.title} failed`;
  if (item.kind === 'down') return `${item.title} is down`;
  return item.title;
}

// "Two things need you: Fix the login bug, and the Weekly report mission failed." Names up to three.
function needsYouSentence(items = []) {
  if (!items.length) return 'Nothing needs you right now.';
  const shown = items.slice(0, 3).map(itemPhrase);
  const joined = shown.length === 1 ? shown[0]
    : shown.length === 2 ? `${shown[0]} and ${shown[1]}`
    : `${shown.slice(0, -1).join(', ')}, and ${shown[shown.length - 1]}`;
  if (items.length > 3) return `${items.length} things need you, including ${joined}.`;
  const lead = items.length === 1 ? 'One thing needs you' : `${NUMBER_WORDS[items.length]} things need you`;
  return `${lead}: ${joined}.`;
}

module.exports = { healthSummary, needsYouSummary, needsYouItems, needsYouSentence };
