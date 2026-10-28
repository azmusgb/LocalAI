'use strict';
// The Chat Café's drawing (app/public/street/chat.js) against a recording fake 2D context: a figure and a bubble per
// running chat (up to 3), the "+" badge only when more wait, no one and no light when quiet or down, and only what moves
// drawn each frame. How it looks is checked by eye in tests/street-gallery.html.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { art, draw, assertClean, fills, stops } = require('./street-draw-kit.cjs');
const chat = require(path.join(__dirname, '..', 'app', 'public', 'street', 'chat.js'));

const job = i => ({ id: 'j' + i, title: 'Job ' + i, status: 'running' });
const world = (running, waiting = 0, needsYou = 0) => ({ street: { chat: {
  running: Array.from({ length: running }, (_, i) => job(i)), waiting, needsYou: Array.from({ length: needsYou }, (_, i) => job(9 + i)), failedUnseen: [] } } });

test('busy: a figure per running chat, up to 3; a waiting one adds the badge, not a figure', () => {
  for (const [n, want] of [[1, 1], [2, 2], [3, 3], [7, 3]]) assert.equal(draw(chat, world(n)).live.person, want, `${n} running`);
  const badge = r => r.liveRec.sets.some(([k, v]) => k === 'fillStyle' && v === '#7a3a10');
  assert.ok(!badge(draw(chat, world(2))), 'no badge with none waiting');
  assert.ok(badge(draw(chat, world(2, 3))), 'a badge when more wait');
});

test('a chat that needs you shows a figure with an amber bubble even with none running', () => {
  const r = draw(chat, world(0, 0, 1));
  assert.equal(r.live.person, 1);
  assert.ok(fills(r.liveRec).includes('#ffc640'), 'the amber bubble');
});

test('quiet and down: no one, no light; down is boarded', () => {
  for (const t of [0, 500, 77777]) {
    const q = draw(chat, world(0), t);
    assert.equal(q.calls.person || 0, 0); assert.equal(q.calls.rays || 0, 0);
    assert.equal(q.calls.glow || 0, 0); assert.equal(q.still.lamp, 1);
    // The kit's glow inside lamp() isn't counted above, so count every radial gradient: the wall lamp's is the only light.
    assert.equal(q.stillRec.log.filter(m => m === 'createRadialGradient').length, 1, 'only the wall lamp is lit');
    assert.deepEqual(q.liveRec.log, [], 'nothing moves');
  }
  const d = draw(chat, { street: null });
  assert.ok(d.s.down);
  assert.equal(d.calls.person || 0, 0); assert.equal(d.calls.glow || 0, 0); assert.equal(d.calls.rays || 0, 0);
  assert.ok(d.still.boards >= 2, 'window and door boarded');
  assert.equal(d.stillRec.log.filter(m => m === 'createRadialGradient').length, 0, 'not even the lamp');
});

test('balanced save/restore, finite numbers, smoothing never off', () => {
  for (const w of [world(3, 2, 1), world(0), { street: null }]) for (const t of [0, 16, 1e6]) assertClean(draw(chat, w, t));
});

test('a busy frame draws only what moves', () => {
  const r = draw(chat, world(2, 1));
  for (const col of ['#7a5228', '#3c6b57']) {
    assert.ok(fills(r.stillRec).includes(col), `the still paints ${col}`);
    assert.ok(!fills(r.liveRec).includes(col), `a busy frame does not repaint ${col}`);
  }
  assert.ok(stops(r.stillRec).includes('#6a3d26') && !stops(r.liveRec).includes('#6a3d26'), 'the room is in the still only');
  assert.equal(r.live.brick || 0, 0); assert.equal(r.live.glow || 0, 0); assert.equal(r.live.rays || 0, 0);
  assert.equal(r.still.person || 0, 0, 'people are not in the still');
  assert.ok(art.palette.lamp);
});
