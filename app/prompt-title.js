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
// paragraph that starts "Question:" after other text counts, so an ordinary message is never cut.
function wrappedQuestion(prompt) {
  if (typeof prompt !== 'string') return null;
  const m = prompt.replace(/\r\n?/g, '\n').match(/\S[\s\S]*?\n[ \t]*\n[ \t]*question:[ \t]*([^\n]*\S)[ \t]*\s*$/i);
  const q = m ? m[1].trim() : '';
  return q && !/^question:/i.test(q) ? q : null;
}

module.exports = { titleFromText, wrappedQuestion };
