'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { Storage } = require('../app/storage');
const { createResearchStore } = require('../app/research/store');
const { createTopicManager } = require('../app/research/topics');
const { createBudget } = require('../app/research/budget');

let T;
function setup(start = '2026-11-19T15:00:00Z') {
  T = Date.parse(start);
  const storage = new Storage({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'budget-')) });
  const tz = 'America/New_York';
  const store = createResearchStore({ db: storage.db, now: () => T, timeZone: tz });
  const topics = createTopicManager({ db: storage.db, now: () => T });
  const budget = createBudget({ db: storage.db, store, topics, now: () => T, timeZone: tz });
  const topic = (over = {}) => topics.addTopic({ name: 'T' + Math.random(), ...over });
  return { storage, store, topics, budget, topic };
}

test('a topic stops at its daily call budget and the refusal says which cap and when it resets', () => {
  const { budget, topic } = setup();
  const t = topic({ budgetCalls: 2 });
  assert.equal(budget.reserve({ topicId: t.id, chars: 10 }).ok, true);
  assert.equal(budget.reserve({ topicId: t.id, chars: 10 }).ok, true);
  const r = budget.reserve({ topicId: t.id, chars: 10 });
  assert.equal(r.ok, false); assert.equal(r.code, 'budget_exhausted'); assert.equal(r.cap, 'topic.day.calls');
  assert.equal(r.limit, 2); assert.equal(r.used, 2);
  assert.equal(r.resetsAt, '2026-11-20T05:00:00.000Z', 'next local midnight in New York (UTC-5)');
});

test('the character budget is checked with the planned size before the call', () => {
  const { budget, topic } = setup();
  const t = topic({ budgetChars: 100 });
  assert.equal(budget.reserve({ topicId: t.id, chars: 60 }).ok, true);
  const r = budget.reserve({ topicId: t.id, chars: 60 });
  assert.equal(r.code, 'budget_exhausted'); assert.equal(r.cap, 'topic.day.chars');
  assert.equal(budget.reserve({ topicId: t.id, chars: 40 }).ok, true, 'exactly the limit is allowed');
});

test('a new local day resets the day caps, the week cap still counts', () => {
  const { budget, topic, store } = setup();
  store.setMeta('budget.week.calls', '3');
  const t = topic({ budgetCalls: 5 });
  for (let i = 0; i < 3; i++) assert.equal(budget.reserve({ topicId: t.id }).ok, true);
  assert.equal(budget.reserve({ topicId: t.id }).cap, 'week.calls');
  T += 24 * 3600000;
  assert.equal(budget.reserve({ topicId: t.id }).cap, 'week.calls', 'yesterday still counts this week');
  T += 7 * 24 * 3600000;
  assert.equal(budget.reserve({ topicId: t.id }).ok, true, 'a week later it has dropped out');
});

test('the per-repository and the global day caps apply across topics', () => {
  const { budget, topic, store } = setup();
  store.setMeta('budget.repo.day.calls', '2');
  const a = topic({ targetProject: 'LocalAI' }), b = topic({ targetProject: 'LocalAI' }), c = topic({ targetProject: 'pi-hub' });
  assert.equal(budget.reserve({ topicId: a.id }).ok, true);
  assert.equal(budget.reserve({ topicId: b.id }).ok, true);
  const r = budget.reserve({ topicId: a.id });
  assert.equal(r.code, 'budget_exhausted'); assert.equal(r.cap, 'repo.LocalAI.day.calls');
  assert.equal(budget.reserve({ topicId: c.id }).ok, true, 'another repository is unaffected');
  store.setMeta('budget.day.calls', '3');
  assert.equal(budget.reserve({ topicId: c.id }).cap, 'day.calls');
});

test('tier 2 is refused until the owner sets an allowance', () => {
  const { budget, topic, store } = setup();
  const t = topic();
  const r = budget.reserve({ topicId: t.id, tier: 2, chars: 5 });
  assert.equal(r.code, 'budget_exhausted'); assert.equal(r.cap, 'tier2.day.calls');
  store.setMeta('budget.tier2.day.calls', '1'); store.setMeta('budget.tier2.day.chars', '10');
  assert.equal(budget.reserve({ topicId: t.id, tier: 2, chars: 5 }).ok, true);
  assert.equal(budget.reserve({ topicId: t.id, tier: 2, chars: 5 }).cap, 'tier2.day.calls');
  assert.equal(budget.reserve({ topicId: t.id, tier: 1 }).ok, true, 'tier 2 spend does not eat tier 1');
});

test('paused, retired and unknown topics are refused without recording spend', () => {
  const { budget, topic, topics, storage } = setup();
  const t = topic();
  topics.updateTopic(t.id, { status: 'paused', reason: 'test' });
  assert.equal(budget.reserve({ topicId: t.id }).code, 'topic_inactive');
  assert.equal(budget.reserve({ topicId: 'nope' }).code, 'unknown_topic');
  assert.equal(budget.reserve({ topicId: t.id, chars: -1 }).code, 'bad_request');
  assert.equal(storage.db.prepare("SELECT count(*) n FROM research_events WHERE entity_type='budget'").get().n, 0);
});

test('an unreadable counter or config refuses the call and reads as unreadable, never zero used', () => {
  const { budget, topic, store, storage } = setup();
  const t = topic();
  store.setMeta('budget.day.calls', 'lots');
  assert.equal(budget.reserve({ topicId: t.id }).code, 'budget_unreadable');
  const s = budget.state(); assert.equal(s.unreadable, true); assert.deepEqual(s.caps, []);
  store.setMeta('budget.day.calls', '20');
  assert.equal(budget.reserve({ topicId: t.id }).ok, true);
  storage.db.exec("UPDATE research_events SET reason = 'not json' WHERE entity_type = 'budget'");
  assert.equal(budget.reserve({ topicId: t.id }).code, 'budget_unreadable');
  assert.equal(budget.state().unreadable, true);
  storage.db.exec('DROP TABLE research_events');
  assert.equal(budget.reserve({ topicId: t.id }).code, 'budget_unreadable');
  assert.equal(budget.state().unreadable, true);
});

test('state lists every cap with limit, used and resetsAt', () => {
  const { budget, topic } = setup();
  const t = topic();
  budget.reserve({ topicId: t.id, chars: 30 }); budget.reserve({ topicId: t.id, chars: 20 });
  const s = budget.state();
  assert.equal(s.unreadable, false);
  const by = Object.fromEntries(s.caps.map(c => [c.name, c]));
  assert.equal(by['day.calls'].used, 2); assert.equal(by['day.chars'].used, 50); assert.equal(by['week.calls'].limit, 100);
  assert.equal(by['tier2.day.calls'].limit, 0);
  assert.ok(s.caps.every(c => typeof c.resetsAt === 'string' && !Number.isNaN(Date.parse(c.resetsAt))));
});

test('the reset is exact across a daylight-saving change (a 25-hour day)', () => {
  const { budget, topic } = setup('2026-11-01T04:30:00Z'); // 00:30 EDT on the day clocks go back
  const t = topic(); budget.reserve({ topicId: t.id });
  const r = budget.state().caps.find(c => c.name === 'day.calls');
  assert.equal(r.resetsAt, '2026-11-02T05:00:00.000Z', '25 hours later: midnight EST');
});

test('the check and the spend cannot be split: a refused call records nothing', () => {
  const { budget, topic, storage } = setup();
  const t = topic({ budgetCalls: 1 });
  budget.reserve({ topicId: t.id }); budget.reserve({ topicId: t.id }); budget.reserve({ topicId: t.id });
  assert.equal(storage.db.prepare("SELECT count(*) n FROM research_events WHERE entity_type='budget'").get().n, 1);
});
