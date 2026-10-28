'use strict';
// Missions HQ's drawing (app/public/street/missions.js) against a recording fake 2D context: a figure per running
// mission (up to 3, one per floor), the roof antenna's light blinking only while busy, no one and no light when quiet or
// down, and only what moves drawn each frame. How it looks is checked by eye in tests/street-gallery.html.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { draw, assertClean, fills, stops } = require('./street-draw-kit.cjs');
const missions = require(path.join(__dirname, '..', 'app', 'public', 'street', 'missions.js'));

const job = i => ({ id: 'm' + i, title: 'Mission ' + i, status: 'running' });
const world = (running, waiting = 0, needsYou = 0) => ({ street: { missions: {
  running: Array.from({ length: running }, (_, i) => job(i)), waiting, needsYou: Array.from({ length: needsYou }, (_, i) => job(9 + i)), failedUnseen: [] } } });
const BEACON = '#ff4d3d', AMBER = '#ffc640';

test('setup: Missions HQ, 260 wide, roof line at 90', () => {
  assert.equal(missions.id, 'missions'); assert.equal(missions.width, 260); assert.equal(missions.roof, 90);
  assert.equal(missions.chip(missions.state(world(2))).title, 'Missions HQ');
  assert.equal(typeof missions.lights, 'function'); // its lights: street-night.test.cjs
});

test('busy: a figure per running mission, up to 3, each on its own floor and moving', () => {
  for (const [n, want] of [[1, 1], [2, 2], [3, 3], [8, 3]]) assert.equal(draw(missions, world(n)).live.person, want, `${n} running`);
  const a = draw(missions, world(3), 0), b = draw(missions, world(3), 2500);
  assert.notDeepEqual(a.liveRec.args.filter(x => x[0] === 'translate'), b.liveRec.args.filter(x => x[0] === 'translate'), 'the figures move');
  assert.equal(draw(missions, world(0, 2)).live.person || 0, 0, 'waiting missions light the building but add no one');
});

test('busy: the antenna light blinks; it is never lit in the still', () => {
  const on = draw(missions, world(1), 100), off = draw(missions, world(1), 1000);
  assert.ok(fills(on.liveRec).includes(BEACON), 'on early in the cycle');
  assert.ok(!fills(off.liveRec).includes(BEACON), 'off later in the cycle');
  assert.ok(!fills(on.stillRec).includes(BEACON));
});

// The engine's chip sits over the roof line (y 90) at the building's centre, so the busy signal must blink below it and
// the antenna stand at the roof's far end.
test('busy: status lamps below the roof line blink with the antenna, which stands at the far end of the roof', () => {
  const lamps = r => r.liveRec.args.filter(([k, x, y, rad]) => k === 'arc' && y > 90 && rad === 3.5);
  assert.equal(lamps(draw(missions, world(1), 100)).length, 2, 'two lamps lit below the roof line');
  assert.equal(lamps(draw(missions, world(1), 1000)).length, 0, 'and dark half the cycle');
  const ant = draw(missions, world(1), 100).liveRec.args.filter(([k, x, y, rad]) => k === 'arc' && y < 90 && rad === 2.6);
  assert.ok(ant.length > 0 && ant.every(([, x]) => x >= 236), 'the antenna light is at the roof\'s far end');
});

test('a mission that needs you: lit and still, a figure with an amber cue in the still, an empty live frame', () => {
  const r = draw(missions, world(0, 0, 1));
  assert.equal(missions.stillKey(r.s), 'ask');
  assert.equal(r.still.person, 1); assert.ok(fills(r.stillRec).includes(AMBER), 'the cue is in the still');
  assert.deepEqual(r.liveRec.log, [], 'nothing moves');
  const both = draw(missions, world(2, 0, 1));
  assert.equal(both.still.person || 0, 0, 'a busy still has no static people');
  assert.ok(!fills(both.stillRec).includes(AMBER)); assert.ok(fills(both.liveRec).includes(AMBER), 'busy with an ask: the cue rides the live frame');
  assert.equal(missions.stillKey(both.s), missions.stillKey(draw(missions, world(1)).s));
});

test('quiet and down: dark floors, antenna off, no one; down is boarded with no light at all', () => {
  for (const t of [0, 500, 77777]) {
    const q = draw(missions, world(0), t);
    assert.equal(q.calls.person || 0, 0); assert.equal(q.calls.glow || 0, 0); assert.equal(q.calls.rays || 0, 0);
    assert.ok(!fills(q.stillRec).includes(BEACON), 'antenna light off');
    assert.deepEqual(q.liveRec.log, [], 'nothing moves');
  }
  const d = draw(missions, { street: null });
  assert.ok(d.s.down);
  assert.equal(d.calls.person || 0, 0); assert.equal(d.calls.glow || 0, 0); assert.equal(d.calls.rays || 0, 0);
  assert.ok(d.still.boards >= 4, 'every floor and the door boarded');
  assert.equal(d.stillRec.log.filter(m => m === 'createRadialGradient').length, 0, 'no light');
  assert.deepEqual(d.liveRec.log, []);
});

test('balanced save/restore, finite numbers, smoothing never off', () => {
  for (const w of [world(3, 2, 1), world(1), world(0, 0, 1), world(0), { street: null }]) for (const t of [0, 16, 1e6]) assertClean(draw(missions, w, t));
});

test('a busy frame draws only what moves', () => {
  const r = draw(missions, world(3, 1));
  for (const col of ['#1f4f8a', '#2a5d9e', '#7a5228']) {
    assert.ok(fills(r.stillRec).includes(col), `the still paints ${col}`);
    assert.ok(!fills(r.liveRec).includes(col), `a busy frame does not repaint ${col}`);
  }
  for (const col of ['#12305a', '#f4e2c2']) assert.ok(stops(r.stillRec).includes(col) && !stops(r.liveRec).includes(col), `the room (${col}) is in the still only`);
  assert.equal(r.live.brick || 0, 0); assert.equal(r.live.steel || 0, 0);
  assert.equal(r.still.person || 0, 0, 'people are not in the still');
});
