'use strict';
// The Coordinator's answer, tidied before the owner reads it (app/mission-answer.js). The fixtures are real answers
// from the appliance (18 Oct 2026, qwen3:4b-instruct-32k), as the Coordinator wrote them, with the evidence the workers
// gathered: tests/fixtures/mission-answers.json.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { polishAnswer, plainText, dropNarration, fixContradictions, dropRepeatedGaps, dropTemplateLeaks, capLength, ANSWER_FORMAT, MAX_ANSWER_CHARS } = require('../app/mission-answer');
const { checkAbsenceClaims } = require('../app/mission-evidence');
const fixtures = require('./fixtures/mission-answers.json').missions;

const fixture = id => fixtures.find(f => f.id === id);
const polish = (f, maxChars) => polishAnswer(f.coordinatorAnswer, { evidenceRecords: f.evidenceRecords, ...(maxChars ? { maxChars } : {}) });
const EMOJI = /\p{Extended_Pictographic}/u;
// Live answer 1: meta-chatter opener, ✅ ⚠️ ❌ headers, replay "not present" next to loadReplay, repeated unknowns.
const look = fixture('mission-mvdzhp4p-e011d8');
// Live answer 2: opens with a timed-out follow-up, copies the prompt's "(lines X–Y of file)" placeholder.
const timedOut = fixture('mission-mvdv93rf-e1788a');
// Live answer 3: short and good.
const districts = fixture('mission-mvdep9un-b8e3d8');

test('the fixtures are the live answers this fixes', () => {
  assert.match(look.coordinatorAnswer, /^I have now received updated evidence from the UX Analyst's follow-up investigation\. Below is the revised and verified synthesis/);
  assert.match(look.coordinatorAnswer, /The replay component is \*\*not\*\* present/);
  assert.match(look.coordinatorAnswer, /`loadReplay`/);
  assert.ok(EMOJI.test(look.coordinatorAnswer));
  assert.match(timedOut.coordinatorAnswer, /^The request to investigate the presence of worker speech bubbles[^.]*timed out\./);
  assert.match(timedOut.coordinatorAnswer, /\(lines X–Y of file\)/);
});

test('meta-chatter before the answer goes; the answer starts with what was found', () => {
  const { answer, report } = polish(look);
  assert.doesNotMatch(answer, /I have now received|Below is the revised|Final Synthesis of Findings/);
  assert.match(answer, /^1\. Header and Primary Actions\n- The header displays "Agent World"/);
  assert.equal(report.narrationDropped, 4, 'two sentences, the title, and the closing "Final Note"');
  assert.doesNotMatch(answer, /Final Note/, 'the closing note claimed a search that never ran');

  const second = polish(timedOut).answer;
  assert.doesNotMatch(second, /timed out|This indicates that the tool failed/, 'the mission note already says a follow-up ran out of time');
  assert.match(second, /^Given that the original evidence/);
});

test('no emoji, Markdown headings, bold, rules or quote marks: Agent World shows the summary as plain text', () => {
  const { answer } = polish(look);
  assert.ok(!EMOJI.test(answer), 'no emoji');
  assert.doesNotMatch(answer, /^#|\*\*|^---|^>/m);
  assert.match(answer, /^Conclusion: The header and primary actions are implemented and aligned with design\.$/m, '"> ✅ **Conclusion**:" reads "Conclusion:"');
  assert.match(answer, /`\.awc__mapWrap`/, 'a class name keeps its double underscore');
  assert.equal(plainText('### **4. Replay**\n> ⚠️ **Partial**: x\n- ✅ done\n  - nested\n---\n© 2026 ™'), '4. Replay\nPartial: x\n- done\n  - nested\n© 2026 ™');
});

test('replay "is not present" next to loadReplay and toggleReplay becomes "present"', () => {
  const { answer, report } = polish(look);
  assert.doesNotMatch(answer, /replay component is not present/i);
  assert.match(answer, /^- Present, not missing: replay \(`loadReplay`, `recordReplayFrame`, `applyReplayFrame`\) \[E-eb1250c3cebd6684\]\.$/m);
  assert.deepEqual(report.contradictions.map(c => c.present[0]), ['loadReplay']);
  assert.match(answer, /contains functions like `loadReplay`/, 'the sentence that names them stays');
});

test('a claim is "present" only when every word of its subject is named in code', () => {
  const said = '- Worker walk cycle is not implemented.\n- The minimap is not present.\n- The city calls `drawWorker` and `drawMinimap` [E-1111111111111111].';
  const { text, fixed } = fixContradictions(said);
  assert.match(text, /^- Worker walk cycle is not implemented\.$/m, 'drawWorker is not a walk cycle');
  assert.match(text, /^- Present, not missing: minimap \(`drawMinimap`\) \[E-1111111111111111\]\.$/m);
  assert.equal(fixed.length, 1);
  // Code the workers read counts; a design doc's prose does not.
  const records = [{ id: 'E-2222222222222222', kind: 'source', source: 'app/public/ui.js#agent-world-city.js', excerpt: '  120 | function drawCrane(d,x,y){' },
    { id: 'E-3333333333333333', kind: 'source', source: 'docs/superpowers/specs/visuals.md', excerpt: 'fireworks are drawn by drawFireworks' }];
  const out = fixContradictions('Cranes are missing. Fireworks are missing.', { evidenceRecords: records });
  assert.equal(out.text, 'Present, not missing: crane (`drawCrane`) [E-2222222222222222]. Fireworks are missing.');
});

test('an absence claim beside a search that found lines for it gets a note', () => {
  const { answer, report } = polish(timedOut);
  assert.match(answer, /Worker walk cycle, face rotation, or job-specific animation → absent \(not seen in parts I read, lines 1727–1840 of app\/public\/ui\.js\) \[E-0599acb06910ce69\] \(but find_in_project found 140 lines for “worker animation” \[E-81700720c1faa9b2\]\)/);
  assert.equal(report.searchNotes.length, 2);
  assert.match(answer, /^- Crane movement or construction progress animation → absent/m, 'no search covers cranes');
});

test('the repeated "Remaining Unknowns" say each gap once', () => {
  const before = look.coordinatorAnswer, { answer, report } = polish(look, Infinity);
  const count = (text, re) => (text.match(re) || []).length;
  assert.equal(count(before, /Missing Evidence/g), 4);
  assert.equal(count(answer, /Missing Evidence/g), 0, 'each "❌ Missing Evidence:" restated a line above it');
  assert.doesNotMatch(answer, /The CSS does not include animation rules for workers/);
  assert.doesNotMatch(answer, /Visual elements \(workers, buildings, ground, labels\)/, 'the assessment restated them again');
  for (const kept of ['confirms worker animation or sprite variation', 'confirms labels or bubbles', 'confirms building details or shadows', 'confirms ground texture or detail'])
    assert.equal(count(answer, new RegExp(kept, 'g')), 1, kept);
  assert.equal(report.repeatsDropped, 6);
  // Different things that share a word are each kept.
  const list = 'Not checked:\n- Crane movement or construction progress animation → absent\n- Traffic vehicle movement or animation → absent';
  assert.equal(dropRepeatedGaps(list).text, list);
});

test('the caveat marks each unchecked claim where it stands and closes the answer, so nothing is read twice', () => {
  const { answer } = polish(look, Infinity);
  const checked = checkAbsenceClaims(answer, look.evidenceRecords.filter(r => r.kind === 'search'));
  assert.equal(checked.flagged.length, 4);
  assert.match(checked.answer, /^1\. Header and Primary Actions/, 'the answer leads');
  assert.match(checked.answer, /\n\nCaveat: 4 statements marked “not checked” say something is missing, but no worker searched the code for those things, so they may well exist\.$/);
  assert.match(checked.answer, /No evidence in the code or CSS confirms labels or bubbles exist or are positioned \(not checked\)\./);
  for (const sentence of checked.flagged) assert.equal(checked.answer.split(sentence.replace(/\.$/, '')).length - 1, 1, 'said once: ' + sentence);
});

test('placeholders copied from the prompts go', () => {
  assert.equal(dropTemplateLeaks('Bubbles are not seen in the parts I read (lines X–Y of file) [E-...].'), 'Bubbles are not seen in the parts I read.');
  assert.equal(dropTemplateLeaks('Not in any source [E-…]. Seen [E-1111111111111111].'), 'Not in any source. Seen [E-1111111111111111].');
  assert.doesNotMatch(polish(timedOut).answer, /X–Y|\[E-\.\.\.\]/);
});

test('a long answer is cut at a line, keeping the opening and its next steps', () => {
  const { answer, report } = polish(look);
  assert.ok(look.coordinatorAnswer.length > 6000);
  assert.ok(answer.length <= MAX_ANSWER_CHARS, String(answer.length));
  assert.equal(report.shortened, true);
  assert.match(answer, /\n\n\(Shortened\. Each worker’s full findings are under What each worker found\.\)\n\nRecommendations for Next Steps:\n1\. Implement a visible replay scrubber/);
  assert.match(answer, /^1\. Header and Primary Actions/);
  const short = capLength('a\nb', 100);
  assert.deepEqual(short, { text: 'a\nb', cut: false });
  const noTail = capLength(('word '.repeat(30) + '\n').repeat(20), 400).text;
  assert.ok(noTail.length <= 400 && noTail.endsWith('What each worker found.)'));
});

test('a good short answer passes through unchanged but for its Markdown', () => {
  const { answer, report } = polish(districts);
  assert.equal(answer, districts.coordinatorAnswer.split('\n').map(l => l.replace(/\s+$/, '')).join('\n'));
  assert.deepEqual([report.narrationDropped, report.contradictions.length, report.repeatsDropped, report.shortened], [0, 0, 0, false]);
});

test('narration is only dropped before the answer starts, and never the whole answer', () => {
  assert.equal(dropNarration('Here is the summary of findings:\n\n- Bubbles are drawn [E-1111111111111111].').text, '- Bubbles are drawn [E-1111111111111111].');
  assert.equal(dropNarration('Based on the specialist reports, the city has six districts [E-1111111111111111].').text, 'Based on the specialist reports, the city has six districts [E-1111111111111111].', 'a finding, not narration');
  assert.equal(dropNarration('The districts are listed.\n\nI have reviewed the code.').text, 'The districts are listed.\n\nI have reviewed the code.', 'later on it stays');
  assert.equal(polishAnswer('Below is the synthesis.').answer, 'Below is the synthesis.', 'all narration keeps the original rather than nothing');
  assert.equal(polishAnswer('').answer, '');
});

test('the Coordinator is asked for the same shape', () => {
  for (const rule of [/Start with the answer itself/, /Never describe your own process: no "I have received", "Below is"/, /no account of follow-ups or tool failures/, /no "#", no "\*\*" and no emoji/, /Say each thing once/, /never also call that thing missing/, /under "Not checked:"/, /At most about 400 words/])
    assert.match(ANSWER_FORMAT, rule);
  assert.ok(ANSWER_FORMAT.length < 1000, 'a few hundred tokens at most on a 12k context');
});
