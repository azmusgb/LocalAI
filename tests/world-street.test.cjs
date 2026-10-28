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

test('titles are readableTitle cut to 80', () => {
  const s = buildStreet([run('a', 'chat', 'running', { meta: { label: 'é'.repeat(300) } })], { now });
  assert.equal(s.chat.running[0].title.length, 80);
});

test('every key is present when there are no runs', () => {
  const empty = { running: [], waiting: 0, needsYou: [], failedUnseen: [], recent: [] };
  assert.deepEqual(buildStreet([], { now }), Object.fromEntries(STREET_KEYS.map((k) => [k, empty])));
});

test('crewList caps at 6 and trims', () => {
  const live = Array.from({ length: 9 }, (_, i) => ({ id: 's' + i, title: 't'.repeat(200), state: i % 2 ? 'waiting' : 'working', lastAction: 'a'.repeat(200), extra: 1 }));
  const out = crewList(live);
  assert.equal(out.length, 6);
  for (const c of out) {
    assert.deepEqual(Object.keys(c).sort(), ['id', 'lastAction', 'state', 'title']);
    assert.equal(c.title.length, 80);
    assert.equal(c.lastAction.length, 80);
  }
  assert.equal(out[1].state, 'waiting');
});
