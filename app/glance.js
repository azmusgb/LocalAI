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

module.exports = { healthSummary, needsYouSummary };
