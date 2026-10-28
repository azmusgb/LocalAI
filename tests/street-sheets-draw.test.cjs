'use strict';
// The Spreadsheets Office's drawing (app/public/street/sheets.js) against a recording fake 2D context: cells tick and the
// clerk types while working; with the bridge up and Excel shut (its own 'dim' still) the clerk sits in a lit office at a
// dim screen and nothing is drawn each frame; quiet is dark and empty; down is boarded with no light; only what moves is
// drawn each frame. How it looks is checked by eye in tests/street-gallery.html.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { draw, assertClean, fills, stops } = require('./street-draw-kit.cjs');
const sheets = require(path.join(__dirname, '..', 'app', 'public', 'street', 'sheets.js'));

const world = (bridge, excel, inFlight) => ({ sheets: { bridge, excel, inFlight } });
const cells = r => r.liveRec.sets.filter(([k, v]) => k === 'fillStyle' && (v === '#ffd98a' || v === '#fff7d6')).length;

test('working: the clerk types at a bright screen and cells light in turn', () => {
  const r = draw(sheets, world(true, true, 1));
  assert.equal(r.still.person, 1, 'the clerk sits in the lit still');
  assert.ok(fills(r.stillRec).includes('#d8f2dc'), 'a bright screen');
  assert.ok(r.liveRec.log.includes('stroke'), 'the forearm types');
  assert.equal(cells(draw(sheets, world(true, true, 1), 0)), 0, 'the sheet starts empty');
  assert.equal(cells(draw(sheets, world(true, true, 1), 350 * 4)), 4, 'four cells after four ticks');
  assert.equal(cells(draw(sheets, world(true, true, 1), 350 * 12)), 10, 'all ten, then it clears');
});

test('bridge up, Excel shut: its own still, lit with the clerk at a dim screen; nothing drawn each frame', () => {
  const s = sheets.state(world(true, false, 0));
  assert.equal(sheets.stillKey(s), 'dim');
  assert.notEqual(sheets.stillKey(s), sheets.stillKey(sheets.state(world(true, true, 0))));
  const r = draw(sheets, world(true, false, 0), 100);
  assert.equal(r.still.person, 1);
  assert.ok(fills(r.stillRec).includes('#2c4a3a') && !fills(r.stillRec).includes('#d8f2dc'), 'a dim screen');
  assert.ok(stops(r.stillRec).includes('#f2e2c2'), 'a lit office');
  for (const t of [0, 100, 5000]) assert.deepEqual(draw(sheets, world(true, false, 0), t).liveRec.log, []);
});

test('quiet and down: no one, no light; down is boarded', () => {
  for (const t of [0, 500, 77777]) {
    const q = draw(sheets, world(true, true, 0), t);
    assert.equal(q.calls.person || 0, 0); assert.equal(q.calls.glow || 0, 0); assert.deepEqual(q.liveRec.log, []);
  }
  const d = draw(sheets, world(null, null, 0));
  assert.ok(d.s.down);
  assert.equal(d.calls.person || 0, 0); assert.equal(d.calls.glow || 0, 0);
  assert.equal(d.still.boards, 3, 'both windows and the door boarded');
});

test('balanced save/restore, finite numbers, smoothing never off', () => {
  for (const w of [world(true, true, 2), world(true, false, 0), world(true, true, 0), world(null, null, 0)]) for (const t of [0, 16, 1e6]) assertClean(draw(sheets, w, t));
});

test('a busy frame draws only what moves', () => {
  const r = draw(sheets, world(true, true, 1), 2000);
  for (const col of ['#e6d6b8', '#cfe8d4', '#8fa7b8']) {
    assert.ok(fills(r.stillRec).includes(col), `the still paints ${col}`);
    assert.ok(!fills(r.liveRec).includes(col), `a busy frame does not repaint ${col}`);
  }
  assert.ok(stops(r.stillRec).includes('#f2e2c2') && !stops(r.liveRec).includes('#f2e2c2'), 'the office is in the still only');
  for (const col of ['#6f4a2a', '#d8f2dc']) assert.ok(!fills(r.liveRec).includes(col), `no desk or screen repaint (${col})`);
  assert.equal(r.live.steel || 0, 0); assert.equal(r.live.lamp || 0, 0); assert.equal(r.live.person || 0, 0); assert.equal(r.live.box || 0, 0);
});
