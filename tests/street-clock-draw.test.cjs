'use strict';
// The Clock Tower's drawing (app/public/street/clock.js) against a recording fake 2D context: hands on the real local
// time (pinned here with clock.setNow, a CommonJS-only test seam), the minute hand sweeping and the bell swinging only while busy, still hands and a still
// bell when quiet, a boarded belfry and a dark face when down, and only what moves drawn each frame. How it looks is
// checked by eye in tests/street-gallery.html.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { draw, assertClean, fills, stops } = require('./street-draw-kit.cjs');
const clock = require(path.join(__dirname, '..', 'app', 'public', 'street', 'clock.js'));

const job = i => ({ id: 'c' + i, title: 'Automation ' + i, status: 'running' });
const world = (running, waiting = 0, needsYou = 0) => ({ street: { clock: {
  running: Array.from({ length: running }, (_, i) => job(i)), waiting, needsYou: Array.from({ length: needsYou }, (_, i) => job(9 + i)), failedUnseen: [] } } });
const BRONZE = '#c08a3e', FACE = '#f6eed6', AMBER = '#ffc640', TAU = Math.PI * 2;
const at = (h, m) => clock.setNow(() => new Date(2026, 9, 28, h, m, 0));
test.afterEach(() => clock.setNow(null));
// Each hand is drawn as translate(face centre) then rotate(angle), hour hand first; the face sits below the belfry
// (y > 150) and the bell hangs in it (translate to its pivot, y < 150, then rotate).
const turns = (rec, below) => rec.args.filter((a, i) => a[0] === 'rotate' && rec.args[i - 1]?.[0] === 'translate' && (rec.args[i - 1][2] > 150) === below).map(a => a[1]);
const hands = rec => { const h = turns(rec, true); return h.length ? h.slice(-2) : null; };
const near = (a, b) => Math.abs(((a - b) % TAU + TAU + Math.PI) % TAU - Math.PI) < 1e-6;
const bellAngle = rec => turns(rec, false)[0];

test('setup: Clock Tower, 140 wide, roof line at 60, a clock that reads the real time', () => {
  assert.equal(clock.id, 'clock'); assert.equal(clock.width, 140); assert.equal(clock.roof, 60);
  assert.equal(clock.chip(clock.state(world(1))).title, 'Clock Tower');
  assert.equal(typeof clock.lights, 'function'); // its lights: street-night.test.cjs
  assert.equal(clock.now, undefined, 'no clock on the def');
});

test('busy: the hands and the bell are in the live frame only, the hands read the real time between sweeps', () => {
  at(3, 0);
  const r = draw(clock, world(1), 3000);
  assert.ok(stops(r.liveRec).includes(BRONZE), 'the bell swings in the live frame');
  assert.ok(!stops(r.stillRec).includes(BRONZE), 'and is not in a busy still');
  assert.equal(hands(r.stillRec), null, 'no hands in a busy still');
  const [h, m] = hands(r.liveRec);
  assert.ok(near(h, TAU / 4), 'hour hand at 3'); assert.ok(near(m, 0), 'minute hand at 12');
  at(10, 30);
  const [h2, m2] = hands(draw(clock, world(1), 3000).liveRec);
  assert.ok(near(h2, TAU * 10.5 / 12), 'hour hand half past 10'); assert.ok(near(m2, Math.PI), 'minute hand at 6');
});

test('busy: the minute hand sweeps fast and the bell swings, both with t', () => {
  at(3, 0);
  const ms = [0, 200, 400, 600, 800].map(t => hands(draw(clock, world(1), t).liveRec)[1]);
  assert.equal(new Set(ms.map(x => x.toFixed(4))).size, ms.length, 'the minute hand moves frame to frame: ' + ms);
  const hs = [0, 400, 800].map(t => hands(draw(clock, world(1), t).liveRec)[0]);
  assert.ok(hs.every(x => near(x, TAU / 4)), 'the hour hand keeps the real hour');
  const bs = [0, 300, 700, 1100].map(t => bellAngle(draw(clock, world(1), t).liveRec));
  assert.ok(new Set(bs.map(x => x.toFixed(4))).size >= 3, 'the bell swings: ' + bs);
  assert.ok(bs.every(b => Math.abs(b) < .6), 'within its arch');
});

test('quiet: still hands at the time of the rebuild, a still bell, no glow, nothing live at any t', () => {
  at(3, 0);
  for (const t of [0, 500, 77777]) {
    const q = draw(clock, world(0), t);
    assert.deepEqual(q.liveRec.log, [], 'nothing moves');
    assert.equal(q.calls.glow || 0, 0); assert.equal(q.calls.rays || 0, 0);
    assert.ok(stops(q.stillRec).includes(BRONZE), 'the bell hangs in the still');
    const [h, m] = hands(q.stillRec);
    assert.ok(near(h, TAU / 4) && near(m, 0), 'the still shows 3:00');
  }
  at(9, 15);
  const [h, m] = hands(draw(clock, world(0)).stillRec);
  assert.ok(near(h, TAU * 9.25 / 12) && near(m, TAU / 4), 'a later rebuild shows the later time');
  assert.equal(clock.stillKey(clock.state(world(0))), 'unlit', 'the key does not depend on the time');
});

// The engine caches a still by its stillKey and stamp; only the stillKey counts as a change (one that moves the camera).
test('stamp: a quiet tower stamps its still with the hour, so the hands are redrawn within the hour; busy and down do not', () => {
  at(3, 59); const a = clock.stamp(clock.state(world(0)));
  at(4, 0); const b = clock.stamp(clock.state(world(0)));
  assert.equal(a, '3'); assert.equal(b, '4');
  assert.equal(clock.stamp(clock.state(world(0, 0, 1))), '4', 'needs you only: still hands too');
  assert.equal(clock.stamp(clock.state(world(1))), '', 'busy: the hands are live');
  assert.equal(clock.stamp(clock.state({ street: null })), '', 'down: no hands');
});

test('an automation that needs you: lit and still, hands and the cue in the still, an empty live frame', () => {
  at(3, 0);
  const r = draw(clock, world(0, 0, 1));
  assert.equal(clock.stillKey(r.s), 'ask');
  assert.ok(fills(r.stillRec).includes(AMBER), 'the cue is in the still');
  assert.ok(hands(r.stillRec), 'still hands'); assert.ok(stops(r.stillRec).includes(BRONZE), 'a still bell');
  assert.ok((r.still.glow || 0) > 0, 'the face is lit');
  assert.deepEqual(r.liveRec.log, [], 'nothing moves');
  const both = draw(clock, world(1, 0, 1));
  assert.ok(!fills(both.stillRec).includes(AMBER)); assert.ok(fills(both.liveRec).includes(AMBER), 'busy with an ask: the cue rides the live frame');
});

test('down: a boarded belfry and a dark face, no hands, no bell, no light at all', () => {
  const d = draw(clock, { street: null });
  assert.ok(d.s.down);
  assert.ok(d.still.boards >= 1, 'the belfry is boarded');
  assert.ok(!stops(d.stillRec).includes(FACE) && !fills(d.stillRec).includes(FACE), 'the face is dark');
  assert.ok(!hands(d.stillRec)); assert.ok(!stops(d.stillRec).includes(BRONZE));
  assert.equal(d.calls.glow || 0, 0); assert.equal(d.stillRec.log.filter(m => m === 'createRadialGradient').length, 0, 'no light');
  assert.deepEqual(d.liveRec.log, []);
});

test('balanced save/restore, finite numbers, smoothing never off', () => {
  for (const w of [world(3, 2, 1), world(1), world(0, 0, 1), world(0), { street: null }]) for (const t of [0, 16, 1e6]) assertClean(draw(clock, w, t));
});

test('a busy frame draws only what moves', () => {
  at(3, 0);
  const r = draw(clock, world(1, 1), 900);
  for (const col of [FACE, '#3f8f7c']) {
    assert.ok(stops(r.stillRec).includes(col) || fills(r.stillRec).includes(col), `the still paints ${col}`);
    assert.ok(!stops(r.liveRec).includes(col) && !fills(r.liveRec).includes(col), `a busy frame does not repaint ${col}`);
  }
  assert.equal(r.live.tex || 0, 0); assert.equal(r.live.steel || 0, 0); assert.equal(r.live.glow || 0, 0);
});
