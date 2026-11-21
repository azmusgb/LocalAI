'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { Storage } = require('../app/storage');
const { createResearchStore } = require('../app/research/store');
const { createTopicManager } = require('../app/research/topics');
const { createBudget } = require('../app/research/budget');
const { createMeasures } = require('../app/research/measures');

function setup() {
  let T = Date.parse('2026-11-19T15:00:00Z');
  const storage = new Storage({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'measures-')) });
  const store = createResearchStore({ db: storage.db, now: () => ++T, timeZone: 'UTC' });
  const topics = createTopicManager({ db: storage.db, now: () => T });
  const budget = createBudget({ db: storage.db, store, topics, now: () => T, timeZone: 'UTC' });
  const measures = createMeasures({ db: storage.db });
  const source = store.addSource({ name: 'S', url: 'https://example.com/s.atom', topics: ['t'] });
  const topic = topics.addTopic({ name: 't', budgetCalls: 50 });
  const doc = n => { store.saveEntries(source.id, [{ id: 'e' + n, title: 'T' + n, url: 'https://example.com/' + n, text: 'text ' + n, published: '2026-11-18T10:00:00Z' }]); return store.nextDocumentAfter(n - 1); };
  const finding = n => { const d = doc(n); return store.addFinding({ documentId: d.id, sourceId: source.id, claim: 'c' + n, quote: 'text ' + n }); };
  return { storage, store, topics, budget, measures, topic, finding, doc };
}

test('an empty system has no data for every measure, never 0%', () => {
  const r = setup().measures.compute();
  assert.equal(r.unreadable, false);
  for (const m of Object.values(r.measures)) { assert.equal(m.noData, true); assert.equal(m.value, null); }
});

test('cost per validated improvement divides all spend by findings whose newest outcome is validated', () => {
  const s = setup();
  const f1 = s.finding(1), f2 = s.finding(2);
  for (let i = 0; i < 4; i++) s.budget.reserve({ topicId: s.topic.id, chars: 100 });
  s.store.decideFinding(f1.id, 'promoted'); s.store.decideFinding(f2.id, 'kept');
  s.store.recordOutcome({ findingId: f1.id, metricName: 'm', beforeVal: 1, afterVal: 2, verdict: 'validated' });
  const m = s.measures.compute().measures;
  assert.equal(m.costPerValidatedImprovement.value, 4); assert.equal(m.costPerValidatedImprovement.den, 1);
  assert.equal(m.costPerValidatedImprovement.chars, 400);
  assert.equal(m.investigationEfficiency.value, 2, '4 calls over 2 decided findings');
  assert.deepEqual(m.investigationEfficiency.byTier.tier1, { calls: 4, chars: 400 });
});

test('precision uses each finding’s newest outcome: a later refuted overrides an earlier validated', () => {
  const s = setup();
  const a = s.finding(1), b = s.finding(2), c = s.finding(3);
  s.store.recordOutcome({ findingId: a.id, metricName: 'm', beforeVal: 0, afterVal: 1, verdict: 'validated' });
  s.store.recordOutcome({ findingId: b.id, metricName: 'm', beforeVal: 0, afterVal: 1, verdict: 'validated' });
  s.store.recordOutcome({ findingId: b.id, metricName: 'm', beforeVal: 1, afterVal: 0, verdict: 'refuted' });
  s.store.recordOutcome({ findingId: c.id, metricName: 'm', beforeVal: 0, afterVal: 1, verdict: 'inconclusive' });
  const p = s.measures.compute().measures.recommendationPrecision;
  assert.deepEqual([p.num, p.den, p.value], [1, 2, 0.5], 'inconclusive is not judged');
});

test('model calls avoided counts documents that cost no call, and never goes negative', () => {
  const s = setup();
  s.doc(1); s.doc(2); s.doc(3); s.budget.reserve({ topicId: s.topic.id, chars: 1 });
  const a = s.measures.compute().measures.modelCallsAvoided;
  assert.deepEqual([a.num, a.den], [2, 3]);
  for (let i = 0; i < 5; i++) s.budget.reserve({ topicId: s.topic.id, chars: 1 });
  assert.equal(s.measures.compute().measures.modelCallsAvoided.num, 0);
});

test('defect detection and regression escapes say what is not recorded instead of guessing', () => {
  const m = setup().measures.compute().measures;
  for (const k of ['defectDetection', 'regressionEscapes']) { assert.equal(m[k].noData, true); assert.match(m[k].note, /not measured/); }
});

test('a bad budget row, a missing table or a throw makes the result unreadable, with no measures shown', () => {
  const s = setup(); s.budget.reserve({ topicId: s.topic.id });
  s.storage.db.exec("UPDATE research_events SET reason = 'junk' WHERE entity_type = 'budget'");
  let r = s.measures.compute(); assert.equal(r.unreadable, true); assert.deepEqual(r.measures, {});
  s.storage.db.exec('DROP TABLE research_outcomes');
  r = s.measures.compute(); assert.equal(r.unreadable, true);
});
