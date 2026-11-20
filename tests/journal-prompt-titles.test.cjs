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
