'use strict';

// One time: Past work entries of runs whose prompt wrapped the owner's question in instructions (Pi Hub's House
// questions, 20-25 Oct 2026) were titled by the instructions' first words ("You are the voice of a family's home hub on
// a Raspberry Pi. Answer th…") or by the caller's label ("House question"), and their bodies quoted the whole prompt,
// facts and all. They are retitled by the question and their bodies keep the answer. Every other entry is left alone,
// and a second pass finds nothing to change. Synchronous: the reads happen first, then one transaction writes.

const { runEntry } = require('./journal-recorders');
const { titleFromText, wrappedQuestion } = require('./prompt-title');

const REPAIR_KEY = 'repair:journal-prompt-titles-v1';
const BODY_MAX = 4000; // app/journal.js: a body at this length was cut
const INSTRUCTIONS = /^you are\b/i; // how a prompt of instructions opens ("You are the voice of …")
const oneLine = t => String(t ?? '').replace(/\s+/g, ' ').trim();

// The entry's new {title, body}, or null to leave it as it is.
function fixFor(entry, runLedger) {
  const runId = (/^run:(.+):[a-z_]+$/.exec(entry.ref) || [])[1];
  let run = null;
  try { run = runId ? runLedger.get(runId) : null; } catch { run = null; }
  const prompt = typeof run?.input?.prompt === 'string' ? run.input.prompt : '';
  if (run && wrappedQuestion(prompt)) {
    // Only what the old recorder wrote: the run's own title.
    if (entry.title !== oneLine(run.title)) return null;
    const fresh = runEntry(run);
    return fresh ? { title: fresh.title, body: fresh.body } : null;
  }
  // The run kept a whole prompt that wraps no question: an ordinary run.
  if (run && prompt.length < BODY_MAX) return null;
  // No run, or its copy of the prompt was cut: read the entry's own copy ("<answer>\nAsked: <prompt>").
  // The recorder appended the prompt last, so it follows the last "Asked: " line; an answer may hold one of its own.
  const at = entry.body.startsWith('Asked: ') && !entry.body.includes('\nAsked: ') ? 0 : entry.body.lastIndexOf('\nAsked: ');
  if (at < 0) return null;
  const answer = entry.body.slice(0, at).trim(), asked = entry.body.slice(at + (at ? 8 : 7));
  const q = wrappedQuestion(asked);
  // Only an entry the old recorder named after the prompt or the "House question" label; a caller's own name stays.
  if (q && (entry.title === 'House question' || entry.title === titleFromText(asked))) {
    const title = titleFromText(q);
    return { title, body: q === title ? answer : (answer ? `${answer}\nAsked: ${q}` : `Asked: ${q}`) };
  }
  // The question was cut off with the body (it sits at the prompt's end). Named by the opening of instructions, the
  // entry takes its answer's first line instead; an ordinary long message is never cut this way, so it is left alone.
  const cut = entry.body.length >= BODY_MAX, first = answer.split('\n').find(l => l.trim()) || '';
  if (cut && first && INSTRUCTIONS.test(entry.title) && entry.title === titleFromText(asked)) return { title: titleFromText(first), body: answer };
  return null;
}

function repairPromptTitles({ storage, journal, runLedger, now = () => new Date().toISOString() }) {
  if (!journal || journal.disabled || storage.readSetting(REPAIR_KEY, null)) return { retitled: 0, skipped: true };
  const changes = [];
  for (const entry of journal.promptEntries()) {
    const next = fixFor(entry, runLedger);
    if (next) changes.push({ id: entry.id, ...next });
  }
  let retitled = 0;
  if (changes.length) storage.transaction(() => { for (const c of changes) if (journal.rewrite(c.id, c)) retitled++; });
  storage.writeSetting(REPAIR_KEY, { completedAt: now(), retitled });
  return { retitled };
}

module.exports = { repairPromptTitles, REPAIR_KEY };
