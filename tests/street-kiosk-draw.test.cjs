'use strict';
// The Kiosk Billboard's drawing (app/public/street/kiosk.js) against a recording fake 2D context: online, the screen
// shows the weather and glows; not set up it is dark and still; down it is dark, boarded and still. How it looks is
// checked by eye in tests/street-gallery.html.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { draw, assertClean, fills, stops } = require('./street-draw-kit.cjs');
const kiosk = require(path.join(__dirname, '..', 'app', 'public', 'street', 'kiosk.js'));

const online = { kiosk: { setUp: true, online: true } }, unset = { kiosk: { setUp: false } }, offline = { kiosk: { setUp: true, online: false } };

test('online: the weather on a glowing screen, the lamps lit', () => {
  const r = draw(kiosk, online);
  assert.ok(fills(r.stillRec).includes('#ffd34a'), 'the sun'); assert.equal(r.still.rays, 1);
  assert.equal(r.live.glow, 1);
  assert.notDeepEqual(draw(kiosk, online, 0).liveRec.args, draw(kiosk, online, 2000).liveRec.args, 'the glow breathes');
});

test('not set up, offline and gone: dark and still; down is boarded', () => {
  for (const w of [unset, offline, {}]) for (const t of [0, 999]) {
    const r = draw(kiosk, w, t);
    assert.deepEqual(r.liveRec.log, []); assert.equal(r.calls.rays || 0, 0); assert.equal(r.calls.glow || 0, 0);
    assert.ok(!fills(r.stillRec).includes('#ffd34a'));
    assert.equal(r.still.boards || 0, r.s.down ? 1 : 0);
  }
});

test('balanced save/restore, finite numbers, smoothing never off', () => {
  for (const w of [online, unset, offline]) for (const t of [0, 16, 1e6]) assertClean(draw(kiosk, w, t));
});

test('an online frame draws only what moves', () => {
  const r = draw(kiosk, online, 1500);
  for (const col of ['#ffd34a', '#ffffff', '#3c434f']) {
    assert.ok(fills(r.stillRec).includes(col), `the still paints ${col}`);
    assert.ok(!fills(r.liveRec).includes(col), `a frame does not repaint ${col}`);
  }
  assert.ok(stops(r.stillRec).includes('#3a7bd5') && !stops(r.liveRec).includes('#3a7bd5'), 'the screen is in the still');
  assert.equal(r.live.steel || 0, 0);
});
