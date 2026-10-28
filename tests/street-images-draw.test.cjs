'use strict';
// The Image Studio's drawing (app/public/street/images.js) against a recording fake 2D context: the painter and the
// filling canvas only while busy, no one and no light when quiet or down, and only what moves drawn each frame. How it
// looks is checked by eye in tests/street-gallery.html.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { draw, assertClean, fills, stops } = require('./street-draw-kit.cjs');
const images = require(path.join(__dirname, '..', 'app', 'public', 'street', 'images.js'));

const job = i => ({ id: 'j' + i, title: 'Job ' + i, status: 'running' });
const world = (running, waiting = 0, needsYou = 0) => ({ street: { images: {
  running: Array.from({ length: running }, (_, i) => job(i)), waiting, needsYou: Array.from({ length: needsYou }, (_, i) => job(9 + i)), failedUnseen: [] } } });
const bands = r => ['#7fc4f0', '#f6d27a', '#e98a5a', '#6aaa6e', '#3f7a4c'].filter(c => fills(r.liveRec).includes(c)).length;

test('busy: the painter paints and the canvas fills band by band over 6 s', () => {
  const r = draw(images, world(1));
  assert.equal(r.live.person, 1); assert.equal(r.live.rays, 1);
  assert.equal(bands(draw(images, world(1), 0)), 1, 'blank at the start of the cycle (only the brush tip carries colour)');
  assert.equal(bands(draw(images, world(1), 1500)), 2);
  assert.equal(bands(draw(images, world(1), 5900)), 5, 'full by the end');
  const ask = draw(images, world(0, 0, 1));
  assert.deepEqual(ask.liveRec.log, [], 'a needs-you-only live frame is empty');
  assert.equal(images.stillKey(ask.s), 'ask', 'the studio stays lit in its own still');
});

test('quiet and down: no painter, no light; down is boarded', () => {
  for (const t of [0, 500, 77777]) {
    const q = draw(images, world(0), t);
    assert.equal(q.calls.person || 0, 0); assert.equal(q.calls.rays || 0, 0); assert.equal(q.calls.glow || 0, 0);
    assert.deepEqual(q.liveRec.log, [], 'nothing moves');
  }
  const d = draw(images, { street: null });
  assert.ok(d.s.down);
  assert.equal(d.calls.person || 0, 0); assert.equal(d.calls.glow || 0, 0); assert.equal(d.calls.rays || 0, 0);
  assert.equal(d.still.boards, 2, 'window and door boarded');
});

test('balanced save/restore, finite numbers, smoothing never off', () => {
  for (const w of [world(3, 2, 1), world(0), { street: null }]) for (const t of [0, 16, 1e6]) assertClean(draw(images, w, t));
});

test('a busy frame draws only what moves', () => {
  const r = draw(images, world(2), 3000);
  for (const col of ['#6b3a5a', '#fbf8f2', '#c9bfae']) {
    assert.ok(fills(r.stillRec).includes(col), `the still paints ${col}`);
    assert.ok(!fills(r.liveRec).includes(col), `a busy frame does not repaint ${col}`);
  }
  assert.ok(stops(r.stillRec).includes('#f3e6cf') && !stops(r.liveRec).includes('#f3e6cf'), 'the room is in the still only');
  assert.equal(r.live.brick || 0, 0); assert.equal(r.live.glow || 0, 0); assert.equal(r.still.person || 0, 0);
});
