'use strict';
// The Workshop Garage's drawing (app/public/street/workshop.js) against a recording fake 2D context: printing runs the
// head, fills the bar to the progress and lights the shop; paused shows the printer with no light, motion or beacon;
// an error flashes the beacon with the door shut; idle and not set up are dark and still; down is boarded with no light;
// the still never shows progress. How it looks is checked by eye in tests/street-gallery.html.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { draw, assertClean, fills } = require('./street-draw-kit.cjs');
const workshop = require(path.join(__dirname, '..', 'app', 'public', 'street', 'workshop.js'));

const world = p => ({ printer: Object.assign({ setUp: true, access: 'ok' }, p) });
const norm = rec => rec.sets.map(([k, v]) => [k, typeof v === 'object' ? 'gradient' : v]);
const printing = (progress = 42) => world({ state: 'printing', progress, minutesLeft: 10 });
// The bar's fill: the fillRect right after the bar colour is set.
function bar(r) {
  const { sets } = r.liveRec;
  const i = sets.findIndex(([k, v]) => k === 'fillStyle' && (v === '#5bd37a' || v === '#e3a51b'));
  return i < 0 ? null : sets[i][1];
}

test('printing: the head runs, the bar fills, the shop is lit and the mechanic stands in the door', () => {
  const a = draw(workshop, printing(), 0), b = draw(workshop, printing(), 900);
  assert.equal(a.live.person, 1); assert.ok(a.live.glow >= 3);
  assert.equal(bar(a), '#5bd37a');
  assert.notDeepEqual(a.liveRec.args, b.liveRec.args, 'the head moves');
  assert.equal(a.calls.boards || 0, 0);
});

test('the still never depends on progress; the part and bar do', () => {
  const lo = draw(workshop, printing(10)), hi = draw(workshop, printing(90));
  assert.deepEqual(lo.stillRec.log, hi.stillRec.log); assert.deepEqual(norm(lo.stillRec), norm(hi.stillRec));
  assert.notDeepEqual(lo.liveRec.log.filter(m => m === 'fillRect').length, hi.liveRec.log.filter(m => m === 'fillRect').length);
});

test('paused: door up, printer shown, no light, no motion, no beacon', () => {
  const a = draw(workshop, world({ state: 'paused', progress: 42 }), 0), b = draw(workshop, world({ state: 'paused', progress: 42 }), 4321);
  assert.equal(a.live.glow || 0, 0); assert.equal(a.live.person || 0, 0);
  assert.equal(bar(a), '#e3a51b');
  assert.ok(!fills(a.liveRec).includes('#ff3b30'));
  assert.deepEqual(a.liveRec.args, b.liveRec.args); assert.deepEqual(norm(a.liveRec), norm(b.liveRec));
});

test('error: the door stays shut and the beacon flashes', () => {
  const r = draw(workshop, world({ state: 'error' }));
  assert.ok(fills(r.liveRec).includes('#ff3b30')); assert.equal(r.live.glow, 2); assert.equal(bar(r), null);
  assert.equal(r.live.person || 0, 0);
});

test('idle, not set up and down: still and dark; down is boarded', () => {
  for (const w of [world({ state: 'idle' }), { printer: { setUp: false } }]) for (const t of [0, 777]) {
    const r = draw(workshop, w, t);
    assert.deepEqual(r.liveRec.log, []); assert.equal(r.calls.person || 0, 0);
  }
  const d = draw(workshop, world({ access: 'unreachable', state: null }));
  assert.ok(d.s.down); assert.deepEqual(d.liveRec.log, []);
  assert.equal(d.calls.glow || 0, 0); assert.equal(d.still.boards, 2);
});

test('balanced save/restore, finite numbers, smoothing never off', () => {
  for (const w of [printing(), printing(null), world({ state: 'paused' }), world({ state: 'error' }), world({ state: 'idle' }), { printer: { setUp: false } }, world({ access: 'x' })])
    for (const t of [0, 16, 1e6]) assertClean(draw(workshop, w, t));
});

test('a printing frame draws only what moves', () => {
  const r = draw(workshop, printing(), 1500);
  for (const col of ['#7a5f40', '#262629', '#3a3f48']) {
    assert.ok(fills(r.stillRec).includes(col), `the still paints ${col}`);
    assert.ok(!fills(r.liveRec).includes(col), `a busy frame does not repaint ${col}`);
  }
  assert.equal(r.live.corrugated || 0, 0); assert.equal(r.live.crate || 0, 0); assert.equal(r.still.person || 0, 0);
});
