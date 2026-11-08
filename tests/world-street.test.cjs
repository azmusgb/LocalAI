'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { streetKey, buildStreet, crewList, STREET_KEYS } = require('../app/world-street');

const now = Date.parse('2026-10-27T12:00:00Z');
const iso = (minAgo) => new Date(now - minAgo * 60000).toISOString();
const run = (id, type, status, over = {}) => ({ id, type, status, createdAt: iso(10), updatedAt: iso(10), ...over });

test('streetKey maps every run type', () => {
  const table = { chat: 'chat', research: 'chat', image: 'images', agent: 'missions', engineering: 'garage', spreadsheet: 'sheets', automation: 'clock', mission: 'missions', specialist: 'missions', nope: null };
  for (const [type, key] of Object.entries(table)) assert.equal(streetKey({ type }), key, type);
  assert.equal(streetKey({}), null);
  assert.deepEqual(STREET_KEYS, ['chat', 'images', 'missions', 'garage', 'sheets', 'clock']);
});

test('buildStreet caps running at 3 and counts the rest as waiting', () => {
  const runs = [];
  for (let i = 0; i < 5; i++) runs.push(run('r' + i, 'chat', i % 2 ? 'streaming' : 'running', { createdAt: iso(50 - i) }));
  runs.push(run('q1', 'chat', 'queued'), run('q2', 'chat', 'queued'));
  const c = buildStreet(runs, { now }).chat;
  assert.equal(c.running.length, 3);
  assert.equal(c.waiting, 4);
  assert.deepEqual(c.running.map((i) => i.id), ['r4', 'r3', 'r2']);
});

test('buildStreet lists approvals and unseen failures per building', () => {
  const eng = run('e1', 'engineering', 'awaiting_approval');
  const img = run('i1', 'image', 'failed', { createdAt: iso(61), finishedAt: iso(60) });
  const s = buildStreet([eng, img], { now });
  assert.deepEqual(s.garage.needsYou.map((i) => i.id), ['e1']);
  assert.deepEqual(s.images.failedUnseen.map((i) => i.id), ['i1']);
  const seen = buildStreet([eng, { ...img, seenAt: iso(5) }], { now });
  assert.deepEqual(seen.images.failedUnseen, []);
});

test('buildStreet caps needsYou and failedUnseen at 3 per building', () => {
  const runs = [];
  for (let i = 0; i < 5; i++) runs.push(run('p' + i, 'engineering', 'awaiting_approval', { createdAt: iso(100 - i) }), run('f' + i, 'engineering', 'failed', { title: 'goal ' + i, createdAt: iso(100 - i), finishedAt: iso(30 - i) }));
  const g = buildStreet(runs, { now }).garage;
  assert.equal(g.needsYou.length, 3);
  assert.equal(g.failedUnseen.length, 3);
});

test('buildStreet recent is the last 3 finished, newest first', () => {
  const runs = [1, 2, 3, 4, 5].map((n) => run('c' + n, 'chat', 'completed', { createdAt: iso(100 - n), finishedAt: iso(50 - n) }));
  runs.push(run('x', 'chat', 'cancelled', { createdAt: iso(200), finishedAt: iso(300) }));
  assert.deepEqual(buildStreet(runs, { now }).chat.recent.map((i) => i.id), ['c5', 'c4', 'c3']);
});

test('items carry exactly id, title, status, startedAt', () => {
  const s = buildStreet([run('a', 'chat', 'running')], { now });
  assert.deepEqual(Object.keys(s.chat.running[0]).sort(), ['id', 'startedAt', 'status', 'title']);
  assert.equal(s.chat.running[0].startedAt, iso(10));
});

test('a missions item also carries its missionId (meta, then output, then source), and only there', () => {
  const runs = [
    run('run-a', 'agent', 'running', { meta: { missionId: 'mission-a' }, output: { missionId: 'other' } }),
    run('run-b', 'agent', 'completed', { output: { missionId: 'mission-b' }, finishedAt: iso(1) }),
    run('run-c', 'agent', 'completed', { meta: { sourceId: 'mission-c' }, finishedAt: iso(2) }),
    run('run-d', 'agent', 'completed', { finishedAt: iso(3) }),
    run('chat-1', 'chat', 'running', { meta: { missionId: 'nope' } })
  ];
  const s = buildStreet(runs, { now });
  assert.deepEqual(s.missions.running[0], { id: 'run-a', title: s.missions.running[0].title, status: 'running', startedAt: iso(10), missionId: 'mission-a' });
  assert.deepEqual(s.missions.recent.map((i) => i.missionId), ['mission-b', 'mission-c', undefined]);
  assert.ok(!('missionId' in s.missions.recent[2]), 'no missionId key when the run names none');
  assert.ok(!('missionId' in s.chat.running[0]), 'other buildings keep {id, title, status, startedAt}');
});

test('titles are readableTitle (which already caps at 80)', () => {
  const s = buildStreet([run('a', 'chat', 'running', { meta: { label: 'é'.repeat(300) } })], { now });
  assert.equal(s.chat.running[0].title.length, 80);
});

test('every key is present when there are no runs', () => {
  const empty = { running: [], waiting: 0, needsYou: [], failedUnseen: [], recent: [] };
  assert.deepEqual(buildStreet([], { now }), Object.fromEntries(STREET_KEYS.map((k) => [k, empty])));
});

test('crewList caps at 6 and trims', () => {
  const live = Array.from({ length: 9 }, (_, i) => ({ id: 's' + i, title: 't'.repeat(200), state: i % 2 ? 'waiting' : 'working', lastEvent: 'a'.repeat(200), at: 1, extra: 1 }));
  const out = crewList(live);
  assert.equal(out.length, 6);
  for (const c of out) {
    assert.deepEqual(Object.keys(c).sort(), ['id', 'lastAction', 'state', 'title']);
    assert.equal(c.title.length, 80);
    assert.equal(c.lastAction.length, 80);
  }
  assert.equal(out[1].state, 'waiting');
});

test('a malformed run keeps a string id and a null startedAt; a run with no id is dropped', () => {
  const s = buildStreet([run(42, 'chat', 'running', { createdAt: 12345 }), run(undefined, 'chat', 'running'), run('', 'chat', 'running'), run(null, 'chat', 'queued')], { now });
  assert.deepEqual(s.chat.running, [{ id: '42', title: s.chat.running[0].title, status: 'running', startedAt: null }]);
  assert.equal(s.chat.waiting, 0);
});

test('crewList skips empty entries', () => {
  const out = crewList([null, undefined, 0, { id: 'a', title: 't', state: 'working', lastEvent: 'Edit' }]);
  assert.deepEqual(out, [{ id: 'a', title: 't', state: 'working', lastAction: 'Edit' }]);
});
