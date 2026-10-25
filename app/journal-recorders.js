'use strict';

// Recorders turn events Local AI already sees into journal entries (app/journal.js). Each builder is pure and
// returns null when there is nothing to record.

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const str = v => (typeof v === 'string' ? v.trim() : '');

// The readable result of a run: its own text, then the summary, then a bare outcome.
function runText(run) {
  const o = run?.output;
  let text = typeof o === 'string' ? o.trim() : '';
  if (!text && o && typeof o === 'object') text = str(o.text) || str(o.answer) || str(o.content);
  if (!text) text = str(run?.summary);
  if (!text && o && typeof o === 'object') text = str(o.outcome) || str(o.preview);
  const asked = str(run?.input?.prompt);
  if (asked && asked !== str(run?.title) && !text.includes(asked)) text = text ? `${text}\nAsked: ${asked}` : `Asked: ${asked}`;
  return text;
}

function runEntry(run) {
  if (!run || typeof run.id !== 'string' || !TERMINAL.has(run.status)) return null;
  const hidden = run.type === 'powershell' || run.meta?.powershell === true; // host commands: title only
  const body = hidden ? '' : run.status === 'failed' && !runText({ ...run, summary: '' }) ? str(run.error) : runText(run);
  return {
    at: run.finishedAt || run.updatedAt || run.createdAt, source: 'run', kind: String(run.type || 'task'), title: run.title,
    body, link: `#run/${run.id}`, ref: `run:${run.id}:${run.status}`, meta: { status: run.status, type: run.type }
  };
}

module.exports = { runEntry, runText };
