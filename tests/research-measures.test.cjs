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

test('with nothing recorded, defect detection and regression escapes are noData, never 0%', () => {
  const m = setup().measures.compute().measures;
  for (const k of ['defectDetection', 'regressionEscapes']) { assert.equal(m[k].noData, true); assert.equal(m[k].value, null); assert.equal(m[k].den, 0); }
});

test('a bad budget row, a missing table or a throw makes the result unreadable, with no measures shown', () => {
  const s = setup(); s.budget.reserve({ topicId: s.topic.id });
  s.storage.db.exec("UPDATE research_events SET reason = 'junk' WHERE entity_type = 'budget'");
  let r = s.measures.compute(); assert.equal(r.unreadable, true); assert.deepEqual(r.measures, {});
  s.storage.db.exec('DROP TABLE research_outcomes');
  r = s.measures.compute(); assert.equal(r.unreadable, true);
});

const { createOutcomes } = require('../app/research/outcomes');

test('defect detection: flagged over recorded defects, newest record per defect wins, zero denominator is noData', () => {
  const s = setup(); const o = createOutcomes({ db: s.storage.db });
  assert.equal(s.measures.compute().measures.defectDetection.noData, true);
  o.recordDefect({ defectId: 'd1', source: 'seeded', flaggedByCheck: true, check: 'contracts' });
  o.recordDefect({ defectId: 'd2', source: 'confirmed', flaggedByCheck: false });
  o.recordDefect({ defectId: 'd3', source: 'confirmed', flaggedByCheck: false });
  o.recordDefect({ defectId: 'd3', source: 'confirmed', flaggedByCheck: true, note: 'correction' });
  const d = s.measures.compute().measures.defectDetection;
  assert.deepEqual([d.noData, d.num, d.den, d.value], [false, 2, 3, 2 / 3]);
  assert.deepEqual(Object.keys(d).sort(), ['den', 'noData', 'note', 'num', 'unit', 'value']);
});

test('regression escapes: only reverts or fixes a gate should have caught, over shipped changes, each change once', () => {
  const s = setup(); const o = createOutcomes({ db: s.storage.db });
  assert.equal(s.measures.compute().measures.regressionEscapes.noData, true);
  for (const id of ['c1', 'c2', 'c3', 'c4']) o.recordShipOutcome({ changeId: id, outcome: 'shipped' });
  o.recordShipOutcome({ changeId: 'c1', outcome: 'reverted', gateShouldHaveCaught: true });
  o.recordShipOutcome({ changeId: 'c1', outcome: 'fixed_after_ship', gateShouldHaveCaught: true });
  o.recordShipOutcome({ changeId: 'c2', outcome: 'fixed_after_ship', gateShouldHaveCaught: false });
  o.recordShipOutcome({ changeId: 'c3', outcome: 'reverted', gateShouldHaveCaught: true });
  const r = s.measures.compute().measures.regressionEscapes;
  assert.deepEqual([r.noData, r.num, r.den, r.value], [false, 2, 4, 0.5]);
});

test('recorder validation: bad input, unshipped revert, duplicate ship, bad writer are refused and store nothing', () => {
  const s = setup(); const o = createOutcomes({ db: s.storage.db });
  const code = f => { try { f(); } catch (e) { return e.status; } return 'none'; };
  assert.equal(code(() => o.recordShipOutcome({ changeId: 'c1', outcome: 'reverted', gateShouldHaveCaught: true })), 409);
  assert.equal(code(() => o.recordShipOutcome({ changeId: 'bad id!', outcome: 'shipped' })), 400);
  assert.equal(code(() => o.recordShipOutcome({ changeId: 'c1', outcome: 'exploded' })), 400);
  assert.equal(code(() => o.recordShipOutcome({ changeId: 'c1', outcome: 'shipped', by: 'model' })), 400);
  o.recordShipOutcome({ changeId: 'c1', outcome: 'shipped' });
  assert.equal(code(() => o.recordShipOutcome({ changeId: 'c1', outcome: 'shipped' })), 409);
  assert.equal(code(() => o.recordShipOutcome({ changeId: 'c1', outcome: 'reverted', gateShouldHaveCaught: 'yes' })), 400);
  assert.equal(code(() => o.recordShipOutcome({ changeId: 'c1', outcome: 'shipped', gateShouldHaveCaught: true })), 400);
  assert.equal(code(() => o.recordDefect({ source: 'guess', flaggedByCheck: true })), 400);
  assert.equal(code(() => o.recordDefect({ source: 'seeded', flaggedByCheck: 'true' })), 400);
  assert.equal(code(() => o.recordDefect({ source: 'seeded', flaggedByCheck: true, by: 'model' })), 400);
  assert.equal(s.storage.db.prepare("SELECT count(*) AS n FROM research_events WHERE entity_type IN ('ship_record','defect_record')").get().n, 1);
});

test('recorded free text is redacted and capped', () => {
  const s = setup(); const o = createOutcomes({ db: s.storage.db });
  o.recordDefect({ defectId: 'd1', source: 'seeded', flaggedByCheck: true, note: 'x'.repeat(1000) });
  const row = s.storage.db.prepare("SELECT reason FROM research_events WHERE entity_type = 'defect_record'").get();
  assert.ok(JSON.parse(row.reason).note.length <= 300);
});

test('a malformed recorded row makes the measures unreadable, never zero', () => {
  for (const [type, to, reason] of [['defect_record', 'flagged', 'not json'], ['defect_record', 'maybe', '{}'], ['ship_record', 'reverted', '{}'], ['ship_record', 'reverted', '{"gateShouldHaveCaught":true}'], ['ship_record', 'exploded', '{}']]) {
    const s = setup();
    s.storage.db.prepare("INSERT INTO research_events (id, entity_type, entity_id, from_state, to_state, by, reason, at) VALUES ('x', ?, 'e', '', ?, 'owner', ?, '2026-11-19T00:00:00Z')").run(type, to, reason);
    const r = s.measures.compute();
    assert.equal(r.unreadable, true, `${type} ${to} ${reason}`); assert.deepEqual(r.measures, {});
  }
});

test('a model-written row is not accepted: a row whose writer is not owner or code is unreadable', () => {
  const s = setup();
  s.storage.db.prepare("INSERT INTO research_events (id, entity_type, entity_id, from_state, to_state, by, reason, at) VALUES ('x', 'defect_record', 'e', '', 'flagged', 'model', '{}', '2026-11-19T00:00:00Z')").run();
  assert.equal(s.measures.compute().unreadable, true);
});

test('a failed read of the recorded rows makes the measures unreadable', () => {
  const s = setup();
  s.storage.db.exec('DROP TABLE research_events');
  assert.equal(s.measures.compute().unreadable, true);
});
