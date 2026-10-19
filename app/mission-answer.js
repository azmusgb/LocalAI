'use strict';
// The Coordinator's answer, tidied before the owner reads it. No model calls: plain string work on the answer and on
// the evidence the workers already gathered, so it costs nothing on the 6 GB GPU.
// Live (18 Oct), "Improve look feel and polish of agent world": the answer opened with "I have now received updated
// evidence from the UX Analyst's follow-up investigation. Below is the revised and verified synthesis…", used ✅ ⚠️ ❌
// headers and Markdown that Agent World shows as raw text (its summary is pre-wrap text, not rendered Markdown), said
// replay "is not present" and two lines later listed loadReplay and toggleReplay, and restated each "No evidence…"
// line two or three times under "Remaining Unknowns". Each step below fixes one of those, in this order:
//   plainText → dropNarration → fixContradictions → dropRepeatedGaps → dropTemplateLeaks → capLength
// and the absence caveat (mission-evidence.js checkAbsenceClaims) runs on the result.

// How the Coordinator is asked to write (both its tool-mode and its one-shot prompt). About 180 tokens.
const ANSWER_FORMAT = 'HOW TO WRITE THE ANSWER: Start with the answer itself in one to three sentences. Never describe your own process: no "I have received", "Below is", "Here is the synthesis", and no account of follow-ups or tool failures (the app reports those itself). Then give the supporting findings as short "- " bullets; end every bullet with the [E-...] IDs it rests on. Plain text only: a heading is a short line ending in ":" (for example "Findings:", "Not checked:", "Next steps:"), with no "#", no "**" and no emoji or symbols such as ✅ ⚠️ ❌. Say each thing once. If you name code for something (a function, file or line), never also call that thing missing. List things nobody checked once, a few words each, under "Not checked:". At most about 400 words.';

const MAX_ANSWER_CHARS = 3500;
const SHORTENED_NOTE = '(Shortened. Each worker’s full findings are under What each worker found.)';

const lower = s => String(s || '').toLowerCase();
const EVIDENCE_ID = /\[?E-[a-f0-9]{16}\]?/g;

// ---- plainText: Markdown and emoji as plain text ----------------------------------------------------------------------
// Pictographs and their joiners; ©, ® and ™ are pictographic in Unicode but ordinary text here.
const EMOJI = /(?![©®™])\p{Extended_Pictographic}|\u{FE0F}|\u{200D}|\u{20E3}/gu;
// Fenced code (```…```) is set aside before any pass and put back after, untouched: `**kwargs`, `x ** 2`, `# comment`
// and indentation are code, not Markdown. Backtick spans are set aside inside plainText (the later passes read their names).
const FENCE = /^([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\1?[ \t]*\2[ \t]*(?=\n|$)|(?![\s\S]))/gm;
const HELD = /\uE000(\d+)\uE001/g, HELD_LINE = /^\uE000\d+\uE001$/;
function holdFences(text) {
  const held = [];
  return { text: String(text || '').replace(/\r\n?/g, '\n').replace(FENCE, m => '\uE000' + (held.push(m) - 1) + '\uE001'), held };
}
const putBack = (text, held) => text.replace(HELD, (_, i) => held[i]);
const TABLE_ROW = /^\s*\|.*\|\s*$/;
function plainText(text) {
  const fences = holdFences(text), out = [];
  for (let line of fences.text.split('\n')) {
    if (HELD_LINE.test(line.trim()) || TABLE_ROW.test(line)) { out.push(line.replace(/\s+$/, '')); continue; }
    const spans = [];
    line = line.replace(/`[^`\n]+`/g, m => '\uE002' + (spans.push(m) - 1) + '\uE003');
    const indented = /^[ \t]+[-*•\d]/.test(line);
    if (/^\s*(?:-{3,}|\*{3,}|_{3,}|={3,})\s*$/.test(line)) continue; // horizontal rules
    line = line.replace(/^(\s*)>\s?/, '$1') // block quotes
      .replace(/^\s*#{1,6}\s+/, '') // headings become their words
      // __bold__ only between words: .awc__mapWrap is a class name.
      .replace(/\*\*(?=\S)([^*\n]+?)(?<=\S)\*\*/g, '$1').replace(/(?<!\w)__([^_\n]+?)__(?!\w)/g, '$1').replace(/(?<!\s)\*\*|\*\*(?!\s)/g, '')
      .replace(EMOJI, '');
    // What removing a symbol leaves behind: "- ✅ Done" → "- Done", "> ✅ Done" → "Done", "Header  and" → "Header and".
    line = line.replace(/^(\s*(?:[-*•]|\d+[.)]))[ \t]{2,}/, '$1 ').replace(/(\S)[ \t]{2,}/g, '$1 ').replace(/\s+$/, '');
    if (!indented) line = line.trimStart();
    out.push(line.replace(/\uE002(\d+)\uE003/g, (_, i) => spans[i]));
  }
  return putBack(out.join('\n').replace(/\n{3,}/g, '\n\n').trim(), fences.held);
}

// ---- dropNarration: the model talking about its process, before the answer starts -------------------------------------
const NARRATION = [
  /^(?:I|We)\s+(?:have\s+|now\s+|'ve\s+)*(?:now\s+)?(?:received|reviewed|gathered|analy[sz]ed|examined|completed|checked|looked|investigated|requested|asked|consolidated|synthesi[sz]ed|verified|compiled|combined|updated|revised)\b/i,
  /^(?:Below|Here)\s+(?:is|are)\b/i,
  /^(?:The|This)\s+(?:following\s+)?(?:is|are)\s+(?:the|a|my|an)\s+[^.]{0,60}\b(?:synthesis|summary|report|answer|analysis|assessment)\b/i,
  /^(?:Based on|After|Having|Now that|Following|With)\b[^.]{0,120}\b(?:follow-?ups?|investigations?|specialists?|outputs?|reports?)\b[^.]*(?:\bbelow\b|\bhere (?:is|are)\b|\bthe following\b|:)\s*$/i,
  // A follow-up or tool failure, which the mission's note already reports ("1 follow-up ran out of time").
  /^The\s+(?:requested\s+|follow-?up\s+)?(?:request|investigation|follow-?up|tool(?:\s+call)?|search)\b[^.]*\b(?:timed out|failed|time limit|tool-call limit|limit was reached|did not (?:finish|complete|return)|could not (?:be )?complete)/i,
  /^This\s+(?:indicates|means|suggests|shows)\s+that\s+the\s+(?:tool|request|investigation|search|follow-?up)\b/i,
];
// A heading that only names the document ("Final Synthesis of Findings"); Agent World already titles it Summary.
const TITLE_ONLY = /^(?:(?:final|revised|updated|verified|consolidated|mission|overall)\s+)*(?:synthesis|summary|report|answer)(?:\s+of\s+(?:the\s+)?(?:findings|evidence|results))?\s*:?\s*$/i;
// After "We verified", "I checked the logs and found": a claim if it says "that …" or has a verb of its own.
const CLAIM_AFTER = /^(?:[^.,;:]{0,80}?\s)?that\s+(\S[\s\S]*)$/i;
const HAS_VERB = /\b(?:is|are|was|were|isn['’]t|aren['’]t|wasn['’]t|weren['’]t|does|do|did|doesn['’]t|don['’]t|didn['’]t|has|have|had|hasn['’]t|haven['’]t|can|cannot|can['’]t|will|won['’]t|because|runs?|fails?|works?)\b/i;
// The sentence without its process clause, or '' when it is all process.
function withoutNarration(sentence) {
  const s = sentence.trim(), first = NARRATION[0].exec(s);
  if (!first) return NARRATION.some(re => re.test(s)) ? '' : s;
  const rest = s.slice(first[0].length), claim = CLAIM_AFTER.exec(rest);
  if (claim) return claim[1].charAt(0).toUpperCase() + claim[1].slice(1);
  return HAS_VERB.test(rest) ? s : '';
}
const splitSentences = text => String(text).split(/(?<=[.!?:])\s+(?=[*_"“([]*[A-Z0-9])/);
function dropNarration(text) {
  const paragraphs = String(text || '').split(/\n{2,}/);
  let dropped = 0;
  // Only the opening: narration later on is rarer and harder to tell from findings.
  for (let p = 0; p < paragraphs.length && p < 4; p++) {
    const para = paragraphs[p].trim();
    // A title, or the goal said back ("Mission: Improve look feel…").
    if (TITLE_ONLY.test(para) || /^(?:mission|goal)\s*:[^\n]*$/i.test(para)) { paragraphs[p] = ''; dropped++; continue; }
    if (para.includes('\n')) break; // a list or a block: the answer has started
    const sentences = splitSentences(para);
    let i = 0;
    while (i < sentences.length && !/E-[a-f0-9]{16}/.test(sentences[i]) && NARRATION.some(re => re.test(sentences[i].trim()))) {
      const kept = withoutNarration(sentences[i]);
      if (kept) { sentences[i] = kept; break; } // a claim stays, without "We verified that"
      dropped++;i++;
    }
    paragraphs[p] = sentences.slice(i).join(' ').trim();
    if (paragraphs[p]) break;
  }
  // A closing "Final status:" or "Final note:" restates the answer (live: one claimed a search that never ran).
  let end = paragraphs.length - 1;
  while (end > 0 && (!paragraphs[end].trim() || /^\s*final\s+(?:status|note|remark)s?\s*:/i.test(paragraphs[end]))) { if (paragraphs[end].trim()) dropped++; end--; }
  return { text: paragraphs.slice(0, end + 1).filter(p => p.trim()).join('\n\n'), dropped };
}

// ---- Words a claim is about ---------------------------------------------------------------------------------------------
// Words that say how something is missing, where it was looked for, or nothing in particular; what remains is the subject.
const FILLER = new Set(('a an the and or of for in on at to by with from into is are was were be been being it its this that these those there their '
  + 'no not nor any none never yet still also only just explicitly currently clearly directly fully actually '
  + 'evidence evident exist exists existing missing absent absence present presence implemented implementation implement lack lacks lacking '
  + 'seen see read parts part line lines file files code source sources excerpt excerpts supplied provided available visible shown show shows '
  + 'confirm confirms confirmed confirming verify verified unverified found find search searched mention mentioned mentions reference referenced '
  + 'include includes included contain contains contained have has had does do did support supported supports '
  + 'component components feature features function functions logic element elements section sections system ui css html javascript '
  + 'relevant related specific detail details such like e.g eg i.e ie etc which what where how whether either neither but however although '
  + 'design document documents doc docs spec specs page app application local appliance agent world rendering render renders based '
  + 'appear appears appearing indicate indicates indication sign signs trace any rules rule').split(' '));
// Plural to singular, enough to match "cranes" to drawCrane: replies → reply, cranes → crane (not "class" → "clas").
const stem = w => (w.length > 4 && w.endsWith('ies') ? w.slice(0, -3) + 'y' : w.length > 3 && /[^su]s$/.test(w) ? w.slice(0, -1) : w);
// File names, paths, evidence ids and line ranges say where, not what.
const stripLocations = s => String(s).replace(EVIDENCE_ID, ' ').replace(/`?[\w./#-]+\.(?:js|cjs|mjs|json|css|html|md|py|ps1|sh)(?:#[\w.-]+)?`?/gi, ' ')
  .replace(/\blines?\s+\d+\s*[–-]\s*\d+/gi, ' ');
function subjectWords(sentence) {
  const words = lower(stripLocations(sentence)).match(/[a-z][a-z0-9]*/g) || [];
  return [...new Set(words.filter(w => w.length > 2 && !FILLER.has(w)).map(stem))];
}
// Code names split into their words: loadReplay → load, replay; draw_crane → draw, crane.
const nameParts = name => name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s_$-]+/).map(w => stem(lower(w))).filter(Boolean);
// A code name: camelCase, snake_case or anything in backticks that looks like one (not a file name).
function codeNames(text) {
  const names = new Set();
  for (const m of String(text).matchAll(/`([A-Za-z_$][\w$]*(?:\(\))?)`/g)) names.add(m[1].replace(/\(\)$/, ''));
  for (const m of String(text).matchAll(/\b([a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+|[a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g)) names.add(m[1]);
  return [...names].filter(n => n.length >= 4 && nameParts(n).length >= 2);
}

// ---- fixContradictions: "X is not present" when the same answer, or the code the workers read, names X -------------------
// A statement that something is missing, unseen or absent.
const NEGATIVE = /\b(?:does(?:n['’]t| not) exist|do(?:n['’]t| not) exist|no evidence|lacks?(?: an?| any)? implementation|(?:is|are) missing|(?:is|are) not (?:yet )?(?:implemented|present|found|included|there|available)|not (?:yet )?implemented|(?:is|are) absent|not seen in (?:the )?parts|no (?:sign|trace|mention|code|implementation) (?:of|for))\b|[→:–]\s*absent\b/i;
const MAX_SUBJECT_WORDS = 4;
function fixContradictions(text, { evidenceRecords = [] } = {}) {
  const lines = String(text || '').split('\n');
  // Names in code the workers read (not prose: a design doc saying "a crane" is a wish, not an implementation).
  const fromEvidence = new Map();
  for (const r of evidenceRecords || []) {
    if (!r || r.kind === 'search' || /\.md(?:#|$)/i.test(String(r.source || ''))) continue;
    for (const n of codeNames(r.excerpt || '')) if (!fromEvidence.has(n)) fromEvidence.set(n, r.id);
  }
  const found = (evidenceRecords || []).filter(r => r && r.kind === 'search' && r.matches > 0 && r.query);
  const fixed = [], annotated = [];
  const out = lines.map((line, at) => {
    if (HELD_LINE.test(line.trim()) || TABLE_ROW.test(line)) return line;
    const parts = splitSentences(line);
    let changed = false;
    const rewritten = parts.map((sentence, si) => {
      if (!NEGATIVE.test(sentence)) return sentence;
      const subject = subjectWords(sentence);
      const searched = () => {
        // A search that found lines for every word of its query, all of which the claim uses, is worth a note beside it
        // (live: "worker walk cycle … absent" while find_in_project had found 140 lines for "worker animation").
        const low = lower(sentence), words = new Set(lower(stripLocations(sentence)).match(/[a-z][a-z0-9]*/g) || []);
        const hit = found.find(s => { const q = lower(s.query).split(/[\s|,;"'`]+/).filter(t => t.length >= 3); return q.length && q.every(t => words.has(t) || words.has(stem(t)) || low.includes(t)); });
        if (!hit || /find_in_project found/.test(sentence)) return sentence;
        annotated.push({ sentence: sentence.trim(), search: hit.id });
        const note = ' (but find_in_project found ' + hit.matches + ' line' + (hit.matches === 1 ? '' : 's') + ' for “' + hit.query + '” [' + hit.id + '])';
        changed = true;return /[.!?:]$/.test(sentence.trimEnd()) ? sentence.trimEnd().replace(/([.!?:])$/, note + '$1') : sentence.trimEnd() + note;
      };
      if (!subject.length || subject.length > MAX_SUBJECT_WORDS) return searched(); // too broad to call it contradicted
      // Names given elsewhere in the answer (any other line or sentence), with the evidence ids cited beside them.
      const others = [...lines.slice(0, at), ...lines.slice(at + 1), ...parts.filter((_, j) => j !== si)];
      const named = new Map();
      for (const o of others) { if (NEGATIVE.test(o)) continue; const ids = o.match(/E-[a-f0-9]{16}/g) || []; for (const n of codeNames(o)) if (!named.has(n)) named.set(n, ids[0] || ''); }
      for (const [n, id] of fromEvidence) if (!named.has(n)) named.set(n, id || '');
      // One name must cover every word of the subject: `undoStack` and `deleteRun` are not "undo for delete".
      const names = [...named.keys()].filter(n => subject.every(w => nameParts(n).includes(w))).slice(0, 3);
      if (!names.length) return searched();
      const ids = [...new Set(names.map(n => named.get(n)).filter(Boolean))].slice(0, 2);
      changed = true;fixed.push({ sentence: sentence.trim(), present: names });
      const lead = /^\s*(?:[-*•]|\d+[.)])\s+/.exec(sentence)?.[0] || '';
      return lead + 'Present, not missing: ' + subject.join(' ') + ' (' + names.map(n => '`' + n + '`').join(', ') + ')' + (ids.length ? ' [' + ids.join('] [') + ']' : '') + '.';
    });
    return changed ? rewritten.join(' ') : line;
  });
  return { text: out.join('\n'), fixed, annotated };
}

// ---- dropRepeatedGaps: the same "not checked" said again ---------------------------------------------------------------
const GAP = /\b(?:no evidence|missing evidence|not seen in (?:the )?parts|not (?:confirmed|verified|found|present|seen)|unverified|could not (?:be )?(?:confirmed|verified)|cannot (?:be )?(?:confirmed|verified)|does(?:n['’]t| not) (?:include|contain|show|mention|reference|exist)|do(?:n['’]t| not) exist|(?:is|are) missing|not (?:yet )?implemented|(?:is|are) absent)\b/i;
// Near-exact: every word of one is in the other, and they share at least half of the longer one's words.
function sameSubject(a, b) {
  const shared = a.filter(w => b.includes(w)).length, smaller = Math.min(a.length, b.length);
  return smaller > 0 && shared === smaller && shared / Math.max(a.length, b.length) >= 0.5;
}
function dropRepeatedGaps(text) {
  // Only a gap said again, near word for word. Two gaps under one heading can be two facts ("Security:" then CSRF, then
  // headers), so a shared heading is not a repeat.
  const said = [], dropped = [], out = [];
  for (const line of String(text || '').split('\n')) {
    if (HELD_LINE.test(line.trim()) || TABLE_ROW.test(line)) { out.push(line); continue; }
    const lead = /^\s*(?:[-*•]|\d+[.)])\s+/.exec(line)?.[0] || '';
    const sentences = splitSentences(line.slice(lead.length));
    const kept = sentences.filter(sentence => {
      if (!GAP.test(sentence)) return true;
      const words = subjectWords(sentence);
      if (said.some(prev => sameSubject(prev, words))) { dropped.push(sentence.trim()); return false; }
      said.push(words);return true;
    });
    const body = kept.join(' ').trim();
    // A line left with only a label ("Missing Evidence:", "Visual elements (workers, ground):") goes too.
    if (!body && line.trim()) continue;
    if (body && kept.length < sentences.length && /^[^.!?]{0,80}:$/.test(body)) continue;
    out.push(line.trim() ? lead + body : line);
  }
  return { text: out.join('\n').replace(/\n{3,}/g, '\n\n'), dropped };
}

// ---- dropTemplateLeaks: the prompts' own placeholders, copied word for word -------------------------------------------
function dropTemplateLeaks(text) {
  return String(text || '')
    .replace(/\s*\((?:lines?\s+)?X\s*[–-]\s*Y(?:\s+of\s+(?:the\s+)?file)?\)/g, '')
    .replace(/\s*\[E-(?:\.\.\.|…)\]/g, '')
    .replace(/,\s*\[E-(?:\.\.\.|…)(?=[,\]])/g, '');
}

// ---- capLength --------------------------------------------------------------------------------------------------------
// Over the limit, the opening stays and so does a closing "Next steps:"/"Recommendations:" section (up to a third of
// the room): the middle is what goes, at a line break.
const NEXT_STEPS = /^(?:\d+[.)]\s*)?(?:recommend\w*|next steps?|suggested (?:next )?steps?|what to do next)\b[^\n]{0,60}$/i;
function cutAt(text, room) {
  if (text.length <= room) return text;
  let at = text.lastIndexOf('\n', room);
  if (at < room / 2) { const sentence = text.slice(0, room).search(/[.!?][^.!?]*$/); at = sentence > room / 2 ? sentence + 1 : room; }
  return text.slice(0, at).trimEnd();
}
function capLength(text, max = MAX_ANSWER_CHARS) {
  text = String(text || '');
  if (text.length <= max) return { text, cut: false };
  const lines = text.split('\n');
  let tailAt = -1;
  for (let i = lines.length - 1; i > 0; i--) if (NEXT_STEPS.test(lines[i].trim())) { tailAt = i; break; }
  const room = max - SHORTENED_NOTE.length - 4;
  let tail = tailAt > 0 ? lines.slice(tailAt).join('\n').trim() : '';
  if (tail) tail = cutAt(tail, Math.floor(room / 3));
  const head = cutAt(tailAt > 0 ? lines.slice(0, tailAt).join('\n').trim() : text, room - tail.length);
  return { text: head + '\n\n' + SHORTENED_NOTE + (tail ? '\n\n' + tail : ''), cut: true };
}

// All of it. Returns the tidied answer and what changed, for the mission record.
function polishAnswer(answer, { evidenceRecords = [], maxChars = MAX_ANSWER_CHARS } = {}) {
  const original = String(answer || '');
  const fences = holdFences(plainText(original));
  let text = fences.text;
  const narration = dropNarration(text);text = narration.text;
  const contradictions = fixContradictions(text, { evidenceRecords });text = contradictions.text;
  const gaps = dropRepeatedGaps(text);text = gaps.text;
  text = putBack(dropTemplateLeaks(text).trim(), fences.held);
  // Nothing left (an answer that was all narration) keeps the original rather than showing nothing.
  if (!text) text = plainText(original) || original;
  const capped = capLength(text, maxChars);
  return { answer: capped.text, report: { narrationDropped: narration.dropped, contradictions: contradictions.fixed, searchNotes: contradictions.annotated, repeatsDropped: gaps.dropped.length, shortened: capped.cut, chars: { before: original.length, after: capped.text.length } } };
}

module.exports = { ANSWER_FORMAT, MAX_ANSWER_CHARS, polishAnswer, plainText, dropNarration, fixContradictions, dropRepeatedGaps, dropTemplateLeaks, capLength, codeNames, subjectWords };
