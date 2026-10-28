'use strict';
// The Claude Yard's drawing (app/public/street/yard.js) against a recording fake 2D context: a fenced yard under a
// striped canopy with a Claude-orange worker at a laptop for each session shown (up to 3), typing while that session
// works and still while it waits, a '+' badge when there are more, and an empty yard with closed laptops when there are
// none. Only what moves is drawn each frame. How it looks is checked by eye in tests/street-gallery.html.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { draw, assertClean, fills, stops } = require('./street-draw-kit.cjs');
const yard = require(path.join(__dirname, '..', 'app', 'public', 'street', 'yard.js'));

const crew = (i, state = 'working', title) => ({ id: 'c' + i, title: title || 'Session ' + i, state, lastAction: 'Edit' });
const world = (working, waiting = 0) => ({ crews: [...Array.from({ length: working }, (_, i) => crew(i)), ...Array.from({ length: waiting }, (_, i) => crew(10 + i, 'waiting'))] });
const ORANGE = '#d97757', BADGE = '#b5513a', SCREEN = '#1f1b19';

test('setup: Claude Yard, 260 wide, roof line at 180, no lights yet, a tap always opens Agent World', () => {
  assert.equal(yard.id, 'yard'); assert.equal(yard.width, 260); assert.equal(yard.roof, 180);
  const s = yard.state(world(2, 1));
  assert.equal(yard.chip(s).title, 'Claude Yard');
  assert.deepEqual(yard.lights(s), []);
  assert.equal(yard.item(s), null); assert.equal(yard.item(yard.state(world(0))), null);
});

test('state: counts, at most 3 sessions shown (working first), the rest as more; no document means not hidden', () => {
  const s = yard.state({ crews: [crew(1, 'waiting'), crew(2), crew(3, 'waiting'), crew(4), crew(5)] });
  assert.deepEqual(s, { hidden: false, working: 3, waiting: 2, more: 2, down: false,
    sessions: [{ id: 'c2', title: 'Session 2', state: 'working' }, { id: 'c4', title: 'Session 4', state: 'working' }, { id: 'c5', title: 'Session 5', state: 'working' }] });
  // An unreadable board is "No sessions", never boarded: it isn't a service the owner runs.
  for (const w of [{ crews: null }, {}, null, { crews: 'x' }]) {
    const e = yard.state(w);
    assert.deepEqual(e, { hidden: false, working: 0, waiting: 0, sessions: [], more: 0, down: false });
    assert.deepEqual(yard.chip(e), { title: 'Claude Yard', detail: 'No sessions', tone: 'quiet' });
  }
});

test('a session keeps its seat and its look as it switches between working and waiting', () => {
  const a = yard.state({ crews: [crew('a'), crew('b'), crew('c', 'waiting')] }), b = yard.state({ crews: [crew('a', 'waiting'), crew('b'), crew('c')] });
  assert.deepEqual(a.sessions.map(x => x.id), ['ca', 'cb', 'cc']); assert.deepEqual(b.sessions.map(x => x.id), ['ca', 'cb', 'cc']);
  assert.deepEqual(a.sessions.map(x => x.state), ['working', 'working', 'waiting']); assert.deepEqual(b.sessions.map(x => x.state), ['waiting', 'working', 'working']);
  assert.equal(yard.stamp(a).replace(/[kq]/g, ''), yard.stamp(b).replace(/[kq]/g, ''), 'skins follow the sessions');
  // Working sessions are still picked first when there are more than three.
  const c = yard.state({ crews: [crew('a', 'waiting'), crew('b', 'waiting'), crew('c', 'waiting'), crew('d')] });
  assert.ok(c.sessions.some(x => x.id === 'cd')); assert.equal(c.more, 1);
});

test('hidden while developer tools are off', () => {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'document'), old = globalThis.document;
  try {
    globalThis.document = { body: { classList: { contains: c => c === 'dev-tools-off' } } };
    const s = yard.state(world(1));
    assert.equal(s.hidden, true); assert.equal(yard.stillKey(s), 'hidden'); assert.equal(yard.animates(s), false);
    globalThis.document = { body: { classList: { contains: () => false } } };
    assert.equal(yard.state(world(1)).hidden, false);
  } finally { if (had) globalThis.document = old; else delete globalThis.document; }
});

test('stillKey and stamp: busy or idle, and the stamp names each shown session and the badge', () => {
  assert.equal(yard.stillKey(yard.state(world(1))), 'busy');
  assert.equal(yard.stillKey(yard.state(world(0, 2))), 'busy', 'waiting sessions still sit at open laptops');
  assert.equal(yard.stillKey(yard.state(world(0))), 'idle');
  const seats = w => yard.stamp(yard.state(w)).replace(/\d/g, '');
  assert.equal(seats(world(2, 1)), 'kkq');
  assert.equal(seats(world(1, 3)), 'kqq+');
  assert.match(yard.stamp(yard.state(world(2, 1))), /^(k[0-2]){2}q[0-2]$/, 'each seat names its skin too');
  assert.equal(yard.stamp(yard.state(world(0))), '');
  assert.equal(yard.animates(yard.state(world(1))), true);
  assert.equal(yard.animates(yard.state(world(0, 2))), false);
  assert.equal(yard.animates(yard.state(world(0))), false);
});

test('busy: a worker in Claude orange at an open laptop per session, in the still; working ones type in the live frame', () => {
  const r = draw(yard, world(2, 1));
  assert.equal(r.still.person, 3, 'three workers'); assert.equal(r.live.person || 0, 0, 'no worker is redrawn each frame');
  assert.ok(fills(r.stillRec).includes(SCREEN), 'open laptops');
  const a = draw(yard, world(2, 1), 0), b = draw(yard, world(2, 1), 130);
  assert.notDeepEqual(a.liveRec.args, b.liveRec.args, 'the forearms move');
  const strokes = rec => rec.log.filter(m => m === 'stroke').length;
  assert.equal(strokes(a.liveRec), 4, 'two forearms for each of the two working sessions');
  // The waiting session's forearms rest in the still.
  assert.ok(strokes(r.stillRec) > 0);
});

test('only waiting sessions: workers at open laptops, all still, an empty live frame', () => {
  for (const t of [0, 400, 98765]) {
    const r = draw(yard, world(0, 2), t);
    assert.equal(r.still.person, 2); assert.ok(fills(r.stillRec).includes(SCREEN));
    assert.deepEqual(r.liveRec.log, [], 'nothing moves');
  }
});

test("a '+' badge when there are more sessions than workers", () => {
  assert.ok(fills(draw(yard, world(2, 2)).stillRec).includes(BADGE));
  assert.ok(!fills(draw(yard, world(2, 1)).stillRec).includes(BADGE));
});

test('idle (and an unreadable board): an empty yard, laptops closed, no light, nothing moves', () => {
  for (const w of [world(0), { crews: null }]) for (const t of [0, 500, 77777]) {
    const r = draw(yard, w, t);
    assert.equal(r.calls.person || 0, 0, 'no one'); assert.equal(r.calls.glow || 0, 0, 'no light'); assert.equal(r.calls.rays || 0, 0);
    assert.ok(!fills(r.stillRec).includes(SCREEN), 'laptops closed');
    assert.ok(fills(r.stillRec).includes(ORANGE), 'the canopy still stands');
    assert.deepEqual(r.liveRec.log, [], 'nothing moves');
    assert.equal(r.s.down, false); assert.equal(r.calls.boards || 0, 0, 'never boarded');
  }
});

test('balanced save/restore, finite numbers, smoothing never off', () => {
  for (const w of [world(3, 3), world(1), world(0, 1), world(0), { crews: null }]) for (const t of [0, 16, 1e6]) assertClean(draw(yard, w, t));
});

test('a busy frame draws only what moves', () => {
  const r = draw(yard, world(3, 2), 900);
  for (const col of [ORANGE, SCREEN, BADGE, '#b89c74', '#d9b98c']) {
    assert.ok(fills(r.stillRec).includes(col), `the still paints ${col}`);
    assert.ok(!fills(r.liveRec).includes(col), `a busy frame does not repaint ${col}`);
  }
  assert.ok(!stops(r.liveRec).length, 'no gradients each frame');
  assert.equal(r.live.steel || 0, 0); assert.equal(r.live.glow || 0, 0);
});
