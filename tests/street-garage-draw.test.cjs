'use strict';
// The Repair Garage's drawing (app/public/street/garage.js) against a recording fake 2D context: a car on a raised lift
// in the open bay with a mechanic under it while busy, sparks now and then, both bays shut and dark when quiet, boarded
// when down, and only what moves drawn each frame. How it looks is checked by eye in tests/street-gallery.html.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { draw, assertClean, fills, stops } = require('./street-draw-kit.cjs');
const garage = require(path.join(__dirname, '..', 'app', 'public', 'street', 'garage.js'));

const job = i => ({ id: 'g' + i, title: 'Fix ' + i, status: 'running' });
const world = (running, waiting = 0, needsYou = 0) => ({ street: { garage: {
  running: Array.from({ length: running }, (_, i) => job(i)), waiting, needsYou: Array.from({ length: needsYou }, (_, i) => job(9 + i)), failedUnseen: [] } } });
const CAR = '#3f7fc4', SPARK = '#fff3b0', AMBER = '#ffc640';
const sparks = r => r.liveRec.sets.some(([k, v]) => (k === 'fillStyle' || k === 'strokeStyle') && v === SPARK);

test('setup: Repair Garage, 240 wide, roof line at 160, no lights yet', () => {
  assert.equal(garage.id, 'garage'); assert.equal(garage.width, 240); assert.equal(garage.roof, 160);
  assert.equal(garage.chip(garage.state(world(1))).title, 'Repair Garage');
  assert.deepEqual(garage.lights(garage.state(world(1))), []);
});

test('busy: the car is up on the lift in the open bay and the mechanic works under it', () => {
  const r = draw(garage, world(2));
  assert.ok(fills(r.stillRec).includes(CAR), 'the car is in the still');
  assert.equal(r.live.person, 1, 'one mechanic'); assert.equal(r.still.person || 0, 0);
  const a = draw(garage, world(1), 0), b = draw(garage, world(1), 400);
  assert.notDeepEqual(a.liveRec.args, b.liveRec.args, 'the wrench works');
});

test('busy: sparks now and then, not all the time', () => {
  const ts = Array.from({ length: 160 }, (_, i) => i * 50), on = ts.filter(t => sparks(draw(garage, world(1), t)));
  assert.ok(on.length > 0, 'sparks fly sometimes'); assert.ok(on.length < ts.length / 2, 'but not most of the time');
});

test('a job that needs you: lit and still, the mechanic with an amber cue in the still, an empty live frame', () => {
  const r = draw(garage, world(0, 0, 1));
  assert.equal(garage.stillKey(r.s), 'ask');
  assert.equal(r.still.person, 1); assert.ok(fills(r.stillRec).includes(AMBER));
  assert.ok(fills(r.stillRec).includes(CAR), 'the bay is open');
  assert.deepEqual(r.liveRec.log, [], 'nothing moves');
  const both = draw(garage, world(1, 0, 1));
  assert.ok(!fills(both.stillRec).includes(AMBER)); assert.ok(fills(both.liveRec).includes(AMBER));
});

// The pier lamp's glow is drawn inside art.js (lamp), so the glow counts below only cover what garage.js draws itself.
test('quiet: both bays shut, no car, no one, no glow or rays of its own, nothing moves; down: boarded, no radial gradient at all', () => {
  for (const t of [0, 500, 77777]) {
    const q = draw(garage, world(0), t);
    assert.equal(q.calls.person || 0, 0); assert.equal(q.calls.glow || 0, 0); assert.equal(q.calls.rays || 0, 0);
    assert.ok(!fills(q.stillRec).includes(CAR), 'the bays are shut');
    assert.deepEqual(q.liveRec.log, [], 'nothing moves');
  }
  const d = draw(garage, { street: null });
  assert.ok(d.s.down);
  assert.equal(d.calls.person || 0, 0); assert.equal(d.calls.glow || 0, 0); assert.equal(d.calls.rays || 0, 0);
  assert.ok(!fills(d.stillRec).includes(CAR));
  assert.ok(d.still.boards >= 2, 'both bays boarded');
  assert.equal(d.stillRec.log.filter(m => m === 'createRadialGradient').length, 0, 'no light');
  assert.deepEqual(d.liveRec.log, []);
});

test('balanced save/restore, finite numbers, smoothing never off', () => {
  for (const w of [world(3, 2, 1), world(1), world(0, 0, 1), world(0), { street: null }]) for (const t of [0, 16, 1e6]) assertClean(draw(garage, w, t));
});

test('a busy frame draws only what moves', () => {
  const r = draw(garage, world(1, 1), 900);
  for (const col of [CAR, '#e05a2a', '#2d3a2a']) {
    assert.ok(fills(r.stillRec).includes(col), `the still paints ${col}`);
    assert.ok(!fills(r.liveRec).includes(col), `a busy frame does not repaint ${col}`);
  }
  assert.ok(stops(r.stillRec).includes('#5c5e66') && !stops(r.liveRec).includes('#5c5e66'), 'the bay is in the still only');
  assert.equal(r.live.brick || 0, 0); assert.equal(r.live.steel || 0, 0);
});
