'use strict';

// Names for runs and Past work entries. Pure: no state, no I/O.

// A title from free text: one line, at most 72 characters (69 and "…" when cut).
function titleFromText(value, fallback = 'Untitled') {
  const clean = String(value || '').replace(/\s+/g, ' ').trim();
  if (!clean) return fallback;
  return clean.length <= 72 ? clean : `${clean.slice(0, 69).trim()}…`;
}

// The owner's question inside a prompt that wraps it in instructions, else null. A caller such as Pi Hub's House
// question sends one user message: "You are … Answer …\n\nFacts:\n…\n\nQuestion: <what was asked>". Only a last
// paragraph of one line that starts "Question:", after other text, counts, so an ordinary message is never cut.
// Linear time: only the prompt's tail is read, split into lines, and the one pattern is anchored to a trimmed line.
const QUESTION_TAIL = 4000;
function wrappedQuestion(prompt) {
  if (typeof prompt !== 'string') return null;
  const lines = prompt.slice(-QUESTION_TAIL).replace(/\r\n?/g, '\n').split('\n').map(l => l.trim());
  let end = lines.length - 1;
  while (end >= 0 && !lines[end]) end--; // trailing blank lines
  if (end < 2 || lines[end - 1]) return null; // the question line must follow a blank line
  if (!lines.slice(0, end - 1).some(Boolean)) return null; // with other text before it
  const m = /^question:[ \t]*(\S.*)$/is.exec(lines[end]);
  const q = m ? m[1] : '';
  return q && !/^question:/i.test(q) ? q : null;
}

module.exports = { titleFromText, wrappedQuestion };
