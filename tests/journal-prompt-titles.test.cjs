'use strict';

// A caller that wraps the owner's question in instructions ("You are … Answer …\n\nFacts: …\n\nQuestion: …", Pi Hub's
// House questions) once named the run and its Past work entry after the instructions: 74 entries titled "You are the
// voice of a family's home hub on a Raspberry Pi. Answer th…". The title is the question; a system message never names
// anything; and the one-time repair retitles entries already stored that way.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Storage } = require('../app/storage');
const { RunLedger } = require('../app/run-ledger');
const { createJournal } = require('../app/journal');
const { createRuns } = require('../app/server/runs');
const { runEntry } = require('../app/journal-recorders');
const { titleFromText } = require('../app/prompt-title');

const INSTRUCTIONS = "You are the voice of a family's home hub on a Raspberry Pi. Answer the question in one to three short, plain sentences, using only the facts below. If the facts don't say, answer that the hub doesn't know.";
const wrapped = q => `${INSTRUCTIONS}\n\nFacts:\nMovies drive: offline since 09:12.\nPlex playback: Nothing playing right now.\n\nQuestion: ${q}`;
const QUESTION = 'Why is the movies drive not working?';
const ANSWER = 'The movies drive is not working and has dropped out since 09:12.';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-prompt-titles-'));
  const storage = new Storage({ dataDir: dir });
  t.after(() => { storage.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const runLedger = new RunLedger({ storage });
  // The real sanitizer keeps user and assistant turns; this one lets system messages through too, so a system message
  // reaching the title would show.
  const sanitizeMessages = list => (Array.isArray(list) ? list : []).filter(m => m && ['user', 'assistant', 'system'].includes(m.role) && typeof m.content === 'string').map(m => ({ role: m.role, content: m.content }));
  const { createChatExecution } = createRuns({ MODEL: 'qwen3:4b', cleanRunId: v => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(v) ? v : null), projectStore: () => [], runLedger, sanitizeMessages, titleFromText });
  return { storage, runLedger, createChatExecution, journal: createJournal({ db: storage.db }) };
}

test('a chat run is named by the question, not the instructions wrapped around it or a system message', t => {
  const { createChatExecution } = setup(t);
  assert.equal(createChatExecution({ messages: [{ role: 'user', content: wrapped(QUESTION) }] }, false).title, QUESTION);
  assert.equal(createChatExecution({ messages: [{ role: 'system', content: INSTRUCTIONS }, { role: 'user', content: QUESTION }] }, false).title, QUESTION);
  // A label the caller gives still names the run in Work ("House question").
  assert.equal(createChatExecution({ messages: [{ role: 'user', content: wrapped(QUESTION) }], title: 'House question' }, false).title, 'House question');
  // An ordinary message, even one that starts "You are", is its own title.
  assert.equal(createChatExecution({ messages: [{ role: 'user', content: 'You are great. What is PETG?' }] }, false).title, 'You are great. What is PETG?');
});

test('a Past work entry is titled by the question, and its body does not repeat the instructions', () => {
  const base = { id: 'run-1', type: 'chat', status: 'completed', finishedAt: '2026-10-22T18:01:00.000Z', input: { prompt: wrapped(QUESTION) }, output: { text: ANSWER }, meta: {} };
  for (const title of [titleFromText(wrapped(QUESTION)), 'House question']) {
    const entry = runEntry({ ...base, title });
    assert.equal(entry.title, QUESTION, `run titled "${title}"`);
    assert.equal(entry.body, ANSWER);
  }
  // A long question is cut like any title.
  const long = 'Why '.repeat(40) + 'is it down?';
  assert.equal(runEntry({ ...base, title: 'House question', input: { prompt: wrapped(long) } }).title, titleFromText(long));
});

test('wrappedQuestion finds only a question that ends a prompt after other text', () => {
  const { wrappedQuestion } = require('../app/prompt-title');
  assert.equal(wrappedQuestion(wrapped(QUESTION)), QUESTION);
  assert.equal(wrappedQuestion(`Context here.\r\n\r\nquestion:   ${QUESTION}  `), QUESTION);
  for (const plain of [QUESTION, `Question: ${QUESTION}`, 'Question:\n\nQuestion:', `${INSTRUCTIONS}\n\nQuestion: ${QUESTION}\n\nThanks`, '', null, undefined, 42])
    assert.equal(wrappedQuestion(plain), null, JSON.stringify(plain));
});

test('wrappedQuestion takes linear time on long and pathological prompts', () => {
  const { wrappedQuestion } = require('../app/prompt-title');
  const inputs = ['\n \n'.repeat(17000), ' '.repeat(50000), `x${'\n \t\n'.repeat(12000)}question:${' '.repeat(20000)}`,
    `${'Facts. '.repeat(8000)}\n\n${'\n'.repeat(20000)}Question:${' \t'.repeat(10000)}`, `x\n\n${'question: '.repeat(5000)}`];
  for (const input of inputs) {
    const t = process.hrtime.bigint();
    wrappedQuestion(input);
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    assert.ok(ms < 50, `${input.length} characters took ${ms.toFixed(1)} ms`);
  }
  // A question still counts after a long prompt (Pi Hub's facts run to thousands of characters).
  assert.equal(wrappedQuestion(`${INSTRUCTIONS}\n\nFacts:\n${'Movies drive: off.\n'.repeat(2000)}\nQuestion: ${QUESTION}`), QUESTION);
});

// ---- the one-time repair of stored entries ----
const { repairPromptTitles, REPAIR_KEY } = require('../app/journal-repair');

function oldRun(runLedger, { prompt, title, answer = ANSWER }) {
  const r = runLedger.create({ type: 'chat', title, input: { prompt: prompt.slice(0, 4000) } });
  runLedger.complete(r.id, { output: { text: answer } });
  return runLedger.get(r.id);
}
// What the journal stored before the fix: the run's title, and the answer with "Asked: <whole prompt>".
const oldEntry = (run, over = {}) => ({ at: run.finishedAt, source: 'run', kind: 'chat', title: run.title, body: `${run.output.text}\nAsked: ${run.input.prompt}`, link: `#run/${run.id}`, ref: `run:${run.id}:completed`, meta: { status: 'completed', type: 'chat' }, ...over });
const byRef = (journal, ref) => journal.search({ limit: 200 }).items.find(x => x.link === `#run/${ref}`);

test('the repair retitles entries named after a wrapping prompt, leaves the rest alone and is safe to re-run', t => {
  const { storage, runLedger, journal } = setup(t);
  const wrappedRun = oldRun(runLedger, { prompt: wrapped(QUESTION), title: titleFromText(wrapped(QUESTION)) });
  const labelled = oldRun(runLedger, { prompt: wrapped('Is the printer busy?'), title: 'House question', answer: 'No, it is idle.' });
  const plain = oldRun(runLedger, { prompt: 'Which filament for a bracket?', title: 'Which filament for a bracket?', answer: 'PETG.' });
  const youAre = oldRun(runLedger, { prompt: 'You are a pirate. Tell me a joke about sails, with a long setup and a short punchline please', title: titleFromText('You are a pirate. Tell me a joke about sails, with a long setup and a short punchline please'), answer: 'Arr.' });
  for (const r of [wrappedRun, labelled, youAre]) journal.record(oldEntry(r));
  journal.record(runEntry(plain));
  journal.record({ at: '2026-10-20T10:00:00.000Z', source: 'chat', kind: 'chat', title: INSTRUCTIONS, body: 'kept as typed', ref: 'chat:c1:0' });
  const before = journal.search({ limit: 200 }).items;

  assert.deepEqual(repairPromptTitles({ storage, journal, runLedger }), { retitled: 2 });
  const fixed = byRef(journal, wrappedRun.id);
  assert.equal(fixed.title, QUESTION);
  assert.equal(fixed.body, ANSWER);
  assert.equal(fixed.id, before.find(x => x.link === `#run/${wrappedRun.id}`).id, 'same entry, same id');
  assert.equal(byRef(journal, labelled.id).title, 'Is the printer busy?');
  // Search finds the question and no longer finds the instructions.
  assert.equal(journal.search({ q: 'movies drive' }).items[0].id, fixed.id);
  assert.deepEqual(journal.search({ q: 'voice of a family' }).items.map(x => x.source), ['chat']);
  // Untouched: an ordinary run, a run whose own message starts "You are", and a chat entry.
  for (const r of [plain, youAre]) assert.deepEqual(byRef(journal, r.id), before.find(x => x.link === `#run/${r.id}`));
  assert.equal(journal.search({ sources: ['chat'] }).items[0].title, INSTRUCTIONS.slice(0, 200)); // titles are capped at 200
  assert.equal(storage.readSetting(REPAIR_KEY, null).retitled, 2);

  // Done once; and a forced second pass finds nothing left to change.
  assert.deepEqual(repairPromptTitles({ storage, journal, runLedger }), { retitled: 0, skipped: true });
  storage.deleteSetting(REPAIR_KEY);
  const after = journal.search({ limit: 200 }).items;
  assert.deepEqual(repairPromptTitles({ storage, journal, runLedger }), { retitled: 0 });
  assert.deepEqual(journal.search({ limit: 200 }).items, after);
});

test('with the run gone, the repair reads the question from the entry, else uses the answer\'s first line', t => {
  const { storage, runLedger, journal } = setup(t);
  const fake = (id, title, body) => ({ at: '2026-10-21T10:00:00.000Z', source: 'run', kind: 'chat', title, body, link: `#run/${id}`, ref: `run:${id}:completed`, meta: {} });
  // The run was pruned, but the entry still holds "Asked: <prompt>" with the question in it.
  journal.record(fake('run-gone-1', titleFromText(wrapped(QUESTION)), `${ANSWER}\nAsked: ${wrapped(QUESTION)}`));
  // The run was pruned and the entry's copy of the prompt was cut before the question (the body is capped).
  journal.record(fake('run-gone-2', titleFromText(INSTRUCTIONS), `The hub does not know.\nSecond line.\nAsked: ${INSTRUCTIONS}\n\nFacts:\n${'Movies drive: off.\n'.repeat(250)}`));
  // The same, but the body was not cut: whatever the prompt was, it held no question, so the entry is left alone.
  journal.record(fake('run-gone-4', titleFromText(INSTRUCTIONS), `Arr.\nAsked: ${INSTRUCTIONS} Tell me a joke.`));
  // The run was pruned and its entry is an ordinary one: left alone.
  journal.record(fake('run-gone-3', 'Which filament for a bracket?', 'PETG.'));
  // An answer that itself has a line starting "Asked: " keeps all of it: the prompt is after the last one.
  journal.record(fake('run-gone-5', 'House question', `Line one.\nAsked: the hub, twice.\nLine three.\nAsked: ${wrapped(QUESTION)}`));
  // An entry the caller named something else keeps its name, even with the run gone.
  journal.record(fake('run-gone-6', 'Automation: nightly check', `${ANSWER}\nAsked: ${wrapped(QUESTION)}`));

  assert.deepEqual(repairPromptTitles({ storage, journal, runLedger }), { retitled: 3 });
  assert.equal(byRef(journal, 'run-gone-5').title, QUESTION);
  assert.equal(byRef(journal, 'run-gone-5').body, 'Line one.\nAsked: the hub, twice.\nLine three.');
  assert.equal(byRef(journal, 'run-gone-6').title, 'Automation: nightly check');
  assert.equal(byRef(journal, 'run-gone-1').title, QUESTION);
  assert.equal(byRef(journal, 'run-gone-1').body, ANSWER);
  assert.equal(byRef(journal, 'run-gone-2').title, 'The hub does not know.');
  assert.equal(byRef(journal, 'run-gone-2').body, 'The hub does not know.\nSecond line.');
  assert.equal(byRef(journal, 'run-gone-3').title, 'Which filament for a bracket?');
  assert.equal(byRef(journal, 'run-gone-4').title, titleFromText(INSTRUCTIONS));
});

test('the repair does nothing, and is not marked done, when the journal is unavailable', t => {
  const { storage, runLedger } = setup(t);
  const journal = createJournal({ db: { exec() { throw new Error('disk I/O error'); } }, log: () => {} });
  assert.deepEqual(repairPromptTitles({ storage, journal, runLedger }), { retitled: 0, skipped: true });
  assert.equal(storage.readSetting(REPAIR_KEY, null), null);
});
