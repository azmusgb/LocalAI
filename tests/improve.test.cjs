'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const imp = require('../app/improve');

const AT = '2026-10-15T20:00:00.000Z';
const byId = list => new Map(list.map(c => [c.id, c]));
const apply = (items, upserts) => {
  const map = new Map(items.map(i => [i.id, i]));
  for (const u of upserts) map.set(u.id, { ...(map.get(u.id) || {}), ...u });
  return [...map.values()];
};

test('stageOf follows the spec table, first match wins', () => {
  const changes = byId([{ id: 'c1', status: 'staged' }, { id: 'c2', status: 'applied' }]);
  assert.equal(imp.stageOf({ status: 'fixed', changeId: 'c1' }, changes), 'shipped');
  assert.equal(imp.stageOf({ status: 'deferred' }, changes), 'setAside');
  assert.equal(imp.stageOf({ status: 'rejected' }, changes), 'setAside');
  assert.equal(imp.stageOf({ status: 'in_progress' }, changes), 'inProgress');
  assert.equal(imp.stageOf({ status: 'approved', changeId: 'c1' }, changes), 'inProgress');
  assert.equal(imp.stageOf({ status: 'approved', changeId: 'c2' }, changes), 'backlog');
  assert.equal(imp.stageOf({ status: 'proposed' }, changes), 'backlog');
});

test('a link to a missing change falls back to Backlog', () => {
  assert.equal(imp.stageOf({ status: 'proposed', changeId: 'gone' }, new Map()), 'backlog');
  assert.equal(imp.stageOf({ status: 'approved', changeId: 'gone' }), 'backlog');
});

test('shouldPromote: high severity or seen three times, open only', () => {
  assert.equal(imp.shouldPromote({ status: 'open', severity: 'high', occurrences: 1 }), true);
  assert.equal(imp.shouldPromote({ status: 'open', severity: 'medium', occurrences: 3 }), true);
  assert.equal(imp.shouldPromote({ status: 'open', severity: 'medium', occurrences: 2 }), false);
  assert.equal(imp.shouldPromote({ status: 'resolved', severity: 'high', occurrences: 9 }), false);
});

test('promoteSignal and ideaItem build backlog items', () => {
  const p = imp.promoteSignal({ id: 'i1', name: 'Syntax check failed', detail: 'x'.repeat(3000), severity: 'high' }, AT);
  assert.deepEqual([p.id, p.source, p.signalId, p.status, p.severity], ['signal-i1', 'signal', 'i1', 'proposed', 'high']);
  assert.equal(p.summary.length, 2000);
  assert.equal(imp.signalItemId('i9'), 'signal-i9');

  assert.equal(imp.ideaItem('   \n ', AT), null);
  const idea = imp.ideaItem('Remember the image size\nand the style too', AT);
  assert.deepEqual([idea.source, idea.status, idea.title], ['idea', 'approved', 'Remember the image size']);
  assert.match(idea.id, /^idea-\d+-[0-9a-f]{4}$/);
  const long = imp.ideaItem('a'.repeat(20000), AT);
  assert.equal(long.title.length, 120);
  assert.equal(long.summary.length, 2000);
});

test('reconcile promotes each eligible signal once, and never over a rejected item', () => {
  const signals = [{ id: 's1', status: 'open', severity: 'high', occurrences: 1, name: 'A' }, { id: 's2', status: 'open', severity: 'low', occurrences: 1, name: 'B' }];
  const first = imp.reconcile({ items: [], changes: [], signals, at: AT });
  assert.deepEqual(first.upserts.map(u => u.id), ['signal-s1']);
  const second = imp.reconcile({ items: apply([], first.upserts), changes: [], signals, at: AT });
  assert.deepEqual(second.upserts, []);
  const rejected = imp.reconcile({ items: [{ id: 'signal-s1', status: 'rejected', source: 'signal', signalId: 's1' }], changes: [], signals, at: AT });
  assert.deepEqual(rejected.upserts, []);
});

test('a resolved signal ships its Backlog item but leaves an In-progress one alone', () => {
  const signals = [{ id: 's1', status: 'resolved', severity: 'high', occurrences: 2 }, { id: 's2', status: 'resolved', severity: 'high', occurrences: 2 }];
  const items = [
    { id: 'signal-s1', source: 'signal', signalId: 's1', status: 'proposed' },
    { id: 'signal-s2', source: 'signal', signalId: 's2', status: 'in_progress' }
  ];
  const { upserts } = imp.reconcile({ items, changes: [], signals, at: AT });
  assert.equal(upserts.length, 1);
  assert.deepEqual([upserts[0].id, upserts[0].status, upserts[0].decisionNote], ['signal-s1', 'fixed', 'Resolved on its own']);
});

test('an applied change ships its item, and start-up stamps the release', () => {
  const items = [{ id: 'idea-1', source: 'idea', status: 'in_progress', changeId: 'c1' }];
  const changes = [{ id: 'c1', status: 'applied' }];
  const shipped = imp.reconcile({ items, changes, signals: [], at: AT }).upserts;
  assert.equal(shipped[0].status, 'fixed');
  assert.deepEqual(shipped[0].shipped, { pending: true, at: AT });
  const after = apply(items, shipped);
  assert.deepEqual(imp.reconcile({ items: after, changes, signals: [], at: AT }).upserts, []);
  const stamped = imp.reconcile({ items: after, changes, signals: [], at: AT, startup: true, release: { version: '2.0.300', commit: 'abc' } }).upserts;
  assert.deepEqual(stamped[0].shipped, { version: '2.0.300', commit: 'abc', at: AT, pending: false });
});

test('an unfinished change with no item gets one, once', () => {
  const changes = [{ id: 'c7', status: 'validation_failed', summary: 'Fix the selector' }, { id: 'c8', status: 'applied', summary: 'Done already' }];
  const first = imp.reconcile({ items: [], changes, signals: [], at: AT }).upserts;
  assert.equal(first.length, 1);
  assert.deepEqual([first[0].source, first[0].status, first[0].changeId, first[0].title], ['idea', 'in_progress', 'c7', 'Fix the selector']);
  assert.deepEqual(imp.reconcile({ items: apply([], first), changes, signals: [], at: AT }).upserts, []);
});

test('moveToTopBoost puts the item one above the highest open score', () => {
  const scoreOf = i => (i.base || 0) + (i.priorityBoost || 0);
  const open = [{ id: 'a', base: 50 }, { id: 'b', base: 30, priorityBoost: 5 }, { id: 'c', base: 10 }];
  const boost = imp.moveToTopBoost(open[2], open, scoreOf);
  assert.equal(scoreOf({ ...open[2], priorityBoost: boost }), 51);
});

test('handToClaude approves, boosts by 30 and appends its note', () => {
  const patch = imp.handToClaude({ priorityBoost: 4, decisionNote: 'x' }, AT);
  assert.deepEqual(patch, { status: 'approved', handedToClaude: true, handedAt: AT, priorityBoost: 34, decisionNote: 'x · Handed to Claude' });
  assert.equal(imp.handToClaude({}, AT).decisionNote, 'Handed to Claude');
});
