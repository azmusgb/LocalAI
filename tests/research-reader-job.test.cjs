'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { Storage } = require('../app/storage');
const { createResearchStore } = require('../app/research/store');
const { createTopicManager } = require('../app/research/topics');
const { createBudget } = require('../app/research/budget');
const { createReaderJob, parseAnswer } = require('../app/research/reader-job');

let T;
const PAD = ' ' + 'The release also lists every other change in this line, so the entry is long enough to be worth a model read.'.repeat(2);
const TEXT = 'Node 22.14 fixes CVE-2026-0001 in the http parser. Upgrade at once. '.repeat(1) + 'The release also updates npm, refreshes the bundled root certificates and lists every change since 22.13 in the changelog for this line.';
function setup(opts = {}) {
  T = Date.parse('2026-11-19T15:00:00Z');
  const storage = new Storage({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'reader-')) });
  const store = createResearchStore({ db: storage.db, now: () => T, timeZone: 'UTC' });
  const topics = createTopicManager({ db: storage.db, now: () => T });
  const budget = createBudget({ db: storage.db, store, topics, now: () => T, timeZone: 'UTC' });
  const calls = [];
  const ctl = { answer: JSON.stringify({ relevant: true, claim: 'Node fixes a parser CVE', verbatim_quote: 'fixes CVE-2026-0001 in the http parser', target_project: 'LocalAI', relevance: 'Security Advisory' }), throws: null };
  const runModel = async (prompt, system, timeout) => { calls.push({ prompt, system, timeout }); if (ctl.throws) throw new Error(ctl.throws); return ctl.answer; };
  const job = createReaderJob({ store, topics, budget, runModel, enabled: true, now: () => T, ...opts });
  const source = store.addSource({ name: 'Node', url: 'https://example.com/node.atom', topics: ['Node'] });
  const topic = topics.addTopic({ name: 'node', budgetCalls: 5, budgetChars: 100000 });
  const feed = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>t</title>'
    + '<entry><id>a</id><title>Node 22.14</title><link href="https://example.com/a"/><updated>2026-11-18T10:00:00Z</updated><content>' + TEXT + '</content></entry></feed>';
  const addDoc = (id = 'a', text = TEXT) => store.saveEntries(source.id, [{ id, title: 'Node ' + id, url: 'https://example.com/' + id, text, published: '2026-11-18T10:00:00Z' }]);
  void feed;
  return { storage, store, topics, budget, job, calls, ctl, source, topic, addDoc };
}

test('parseAnswer takes one JSON object out of fences and chatter, and nothing else', () => {
  assert.deepEqual(parseAnswer('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseAnswer('Sure! {"a":1} done'), { a: 1 });
  for (const bad of ['', 'no json', '[1,2]', '{broken', null, undefined]) assert.equal(parseAnswer(bad), null);
});

test('off, paused and busy do nothing: no model call and no budget spend', async () => {
  const off = setup({ enabled: false }); off.addDoc();
  assert.equal((await off.job.tick()).code, 'off'); assert.equal(off.calls.length, 0);
  const p = setup(); p.addDoc(); p.store.setMeta('paused', '1');
  assert.equal((await p.job.tick()).code, 'paused'); assert.equal(p.calls.length, 0);
  const b = setup({ busy: () => ({ busy: true }) }); b.addDoc();
  assert.equal((await b.job.tick()).code, 'busy'); assert.equal(b.calls.length, 0);
  const bt = setup({ busy: () => { throw new Error('x'); } }); bt.addDoc();
  assert.equal((await bt.job.tick()).code, 'busy', 'an unknown busy state is treated as busy');
  assert.equal(b.storage.db.prepare("SELECT count(*) n FROM research_events WHERE entity_type='budget'").get().n, 0);
});

test('a new document is read once, in an untrusted block, and stored as a finding with its quote', async () => {
  const s = setup(); s.addDoc();
  const r = await s.job.tick();
  assert.equal(r.code, 'finding'); assert.equal(s.calls.length, 1);
  assert.match(s.calls[0].prompt, /<<<UNTRUSTED_DOCUMENT_TEXT/); assert.match(s.calls[0].system, /no tools/i);
  const f = s.store.listFindings({ status: 'extracted' });
  assert.equal(f.length, 1); assert.equal(f[0].quote, 'fixes CVE-2026-0001 in the http parser');
  assert.equal((await s.job.tick()).code, 'idle', 'the cursor moved past it');
  assert.equal(s.calls.length, 1);
});

test('a revised entry is a new document and is read again; an unchanged one is not', async () => {
  const s = setup(); s.addDoc(); await s.job.tick();
  s.addDoc('a', TEXT); assert.equal((await s.job.tick()).code, 'idle', 'same text, no new revision');
  s.addDoc('a', TEXT + ' Also fixes a leak.'); 
  assert.equal((await s.job.tick()).code, 'finding'); assert.equal(s.calls.length, 2);
});

test('a quote that is not in the document yields no finding but the document counts as read', async () => {
  const s = setup(); s.addDoc();
  s.ctl.answer = JSON.stringify({ relevant: true, claim: 'x', verbatim_quote: 'text that is not there', target_project: 'LocalAI', relevance: 'Optimization' });
  assert.equal((await s.job.tick()).code, 'no_finding');
  assert.equal(s.store.listFindings({ status: 'extracted' }).length, 0);
  assert.equal((await s.job.tick()).code, 'idle');
  s.addDoc('b'); s.ctl.answer = 'not json at all';
  assert.equal((await s.job.tick()).code, 'no_finding');
});

test('an exhausted budget queues the document, keeps it first in line and reads it after the reset', async () => {
  const s = setup(); s.topics.updateTopic(s.topic.id, { budgetCalls: 1, reason: 'test' });
  s.addDoc('a'); s.addDoc('b', 'Second doc fixes CVE-2026-0001 in the http parser.' + PAD);
  assert.equal((await s.job.tick()).code, 'finding');
  const r = await s.job.tick();
  assert.equal(r.code, 'budget_exhausted'); assert.equal(r.queued, true); assert.equal(r.cap, 'topic.day.calls'); assert.ok(r.resetsAt);
  assert.equal(s.calls.length, 1, 'no model call after the refusal');
  assert.equal(s.store.getMeta('reader.cursor') !== null, true);
  T += 24 * 3600000;
  assert.equal((await s.job.tick()).code, 'finding', 'the queued document is read after the reset');
  assert.equal(s.calls.length, 2);
});

test('an unreadable budget stops the reader with an error and no model call', async () => {
  const s = setup(); s.addDoc(); s.store.setMeta('budget.day.calls', 'lots');
  const r = await s.job.tick();
  assert.equal(r.code, 'error'); assert.equal(s.calls.length, 0);
  assert.equal(s.job.state().cursor, 0, 'the document is still queued');
});

test('a document no active topic covers is not read and is counted', async () => {
  const s = setup(); s.addDoc(); s.topics.updateTopic(s.topic.id, { status: 'paused', reason: 'test' });
  const r = await s.job.tick();
  assert.equal(r.code, 'out_of_scope'); assert.equal(s.calls.length, 0); assert.equal(s.job.state().counts.outOfScope, 1);
});

test('the daily findings cap stops reading and the rest wait', async () => {
  const s = setup({ dailyFindings: 1 }); s.addDoc('a'); s.addDoc('b', 'Another fixes CVE-2026-0001 in the http parser.' + PAD);
  assert.equal((await s.job.tick()).code, 'finding');
  assert.equal((await s.job.tick()).code, 'daily_cap'); assert.equal(s.calls.length, 1);
});

test('a failing model holds the reader, retries, and skips the document only after three failures', async () => {
  const s = setup(); s.addDoc(); s.ctl.throws = 'model down';
  assert.equal((await s.job.tick()).code, 'model_failed');
  assert.equal((await s.job.tick()).code, 'held', 'no immediate retry'); assert.equal(s.calls.length, 1);
  T += 16 * 60000; assert.equal((await s.job.tick()).code, 'model_failed');
  T += 16 * 60000; const third = await s.job.tick();
  assert.equal(third.code, 'failed'); assert.equal(s.job.state().counts.failed, 1);
  assert.equal((await s.job.tick()).code, 'idle');
});

test('an unreadable cursor is unreadable in state and an error in a tick, never "caught up"', async () => {
  const s = setup(); s.addDoc(); s.store.setMeta('reader.cursor', 'banana');
  assert.equal(s.job.state().unreadable, true);
  assert.equal((await s.job.tick()).code, 'error'); assert.equal(s.calls.length, 0);
});

test('two ticks at once never run two reads', async () => {
  const s = setup(); s.addDoc();
  const [a, b] = await Promise.all([s.job.tick(), s.job.tick()]);
  assert.deepEqual([a.code, b.code].sort(), ['busy', 'finding']); assert.equal(s.calls.length, 1);
});

test('a document with almost no text is skipped without a model call or budget spend, and counted', async () => {
  const t = setup(); t.addDoc('thin', 'A short teaser.'); t.addDoc('empty', '');
  const first = await t.job.tick();
  assert.equal(first.code, 'too_thin'); assert.equal(t.calls.length, 0);
  assert.equal((await t.job.tick()).code, 'too_thin');
  assert.equal((await t.job.tick()).code, 'idle', 'both were passed over, the cursor moved');
  assert.equal(t.calls.length, 0);
  assert.equal(t.job.state().counts.tooThin, 2); assert.equal(t.job.state().counts.read, 0);
  assert.equal(t.storage.db.prepare("SELECT count(*) n FROM research_events WHERE entity_type='budget'").get().n, 0);
  t.addDoc('full'); assert.equal((await t.job.tick()).code, 'finding', 'a document with real text is still read');
  const tuned = setup({ minTextChars: 5 }); tuned.addDoc('thin', 'A short teaser.');
  await tuned.job.tick(); assert.equal(tuned.calls.length, 1, 'the threshold is a setting: a short document is read when it is lowered');
});

test('a document from a paused or retired source is passed over unread and counted; an active one is still read', async () => {
  const t = setup(); t.addDoc('a');
  for (const status of ['paused', 'retired']) {
    t.store.updateSource(t.source.id, { status });
    t.addDoc('d-' + status, TEXT + ' ' + status);
    const r = await t.job.tick();
    assert.equal(r.code, 'source_inactive', status); assert.match(r.reason, new RegExp(status));
  }
  assert.equal(t.calls.length, 0); assert.equal(t.job.state().counts.sourceInactive, 2);
  assert.equal(t.storage.db.prepare("SELECT count(*) n FROM research_events WHERE entity_type='budget'").get().n, 0);
  t.store.updateSource(t.source.id, { status: 'active' }); t.addDoc('later', TEXT + ' later');
  assert.equal((await t.job.tick()).code, 'finding', 'back to active, new documents are read');
});

test('a read with no finding says why: not relevant, quote rejected, or not an answer', async () => {
  const s = setup();
  s.addDoc('a'); s.ctl.answer = '{"relevant": false}';
  let r = await s.job.tick();
  assert.equal(r.code, 'no_finding'); assert.equal(r.why, 'not_relevant'); assert.match(r.reason, /not relevant/i);
  s.addDoc('b'); s.ctl.answer = JSON.stringify({ relevant: true, claim: 'x', verbatim_quote: 'text that is not there', target_project: 'LocalAI', relevance: 'Optimization' });
  r = await s.job.tick();
  assert.equal(r.why, 'quote_rejected'); assert.match(r.reason, /quote/i);
  s.addDoc('c'); s.ctl.answer = 'I could not decide';
  r = await s.job.tick();
  assert.equal(r.why, 'unparsable'); assert.match(r.reason, /JSON answer/i);
  const c = s.job.state().counts;
  assert.equal(c.read, 3); assert.equal(c.notRelevant, 1); assert.equal(c.quoteRejected, 1); assert.equal(c.unparsable, 1); assert.equal(c.findings, 0);
  s.addDoc('d'); s.ctl.answer = JSON.stringify({ relevant: true, claim: 'Node fixes a parser CVE', verbatim_quote: 'fixes CVE-2026-0001 in the http parser', target_project: 'LocalAI', relevance: 'Security Advisory' });
  r = await s.job.tick();
  assert.equal(r.code, 'finding'); assert.equal(r.why, undefined);
});

test('the tallies and recent reads survive a restart; an unreadable tally is an error, never zero', async () => {
  const t = setup(); t.addDoc('a'); t.ctl.answer = '{"relevant": false}';
  await t.job.tick(); t.addDoc('thin', 'short'); await t.job.tick();
  const again = createReaderJob({ store: t.store, topics: t.topics, budget: t.budget, runModel: async () => '{}', enabled: true, now: () => T });
  const st = again.state();
  assert.equal(st.counts.read, 1); assert.equal(st.counts.notRelevant, 1); assert.equal(st.counts.tooThin, 1);
  assert.deepEqual(st.recent.map(r => [r.outcome, r.why]), [['too_thin', ''], ['no_finding', 'not_relevant']], 'newest first');
  assert.equal(st.recent[1].title, 'Node a'); assert.equal(st.countsUnreadable, false);
  t.store.setMeta('reader.counts', 'not json');
  const bad = again.state();
  assert.equal(bad.counts, null); assert.equal(bad.countsUnreadable, true); assert.equal(bad.unreadable, false, 'the cursor is still fine');
  t.addDoc('b'); assert.equal((await again.tick()).code, 'no_finding', 'a broken tally does not stop the reader');
});

test('the recent-reads list is trimmed to the newest 200', () => {
  const t = setup();
  for (let i = 0; i < 205; i++) t.store.addRead('doc-' + i, 'too_thin');
  const all = t.store.listReads(500);
  assert.equal(all.length, 200); assert.equal(all[0].documentId, 'doc-204'); assert.equal(all[199].documentId, 'doc-5');
});
