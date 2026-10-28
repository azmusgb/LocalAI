'use strict';
// Main Street's traffic layer (app/public/street/traffic.js) without a browser: world() diffs consecutive worlds into
// departing cars (completed only, at most 3, only while on screen, none under reduced motion) and keeps a first-seen time
// per ask; draw() hangs the beacon at def.beacon (else width - 22, 200) and pulses the beacon and the hazards on their own ids.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

let T = 0;
Object.defineProperty(globalThis, 'performance', { value: { now: () => T }, configurable: true, writable: true });
const drawn = [];
globalThis.LocalAIStreetArt = { car: (c, x, y, o) => drawn.push(['car', x, y, o]), beacon: (c, x, y, o) => drawn.push(['beacon', x, y, o]) };
const traffic = require(path.join(__dirname, '..', 'app', 'public', 'street', 'traffic.js'));

const src = o => ({ running: [], waiting: 0, needsYou: [], failedUnseen: [], recent: [], ...o });
const job = (id, status = 'running') => ({ id, title: id, status });
const done = id => job(id, 'completed');
const def = (id, extra) => ({ id, width: 240, ...extra });
// One standing building per street key, its state the asks counted from the world (as runsBuilding does).
const list = (w, defs) => defs.map((d, i) => { const r = (w.street || {})[d.id] || src(); return { d, x: i * 300, s: { needsYou: r.needsYou.length, failed: r.failedUnseen.length, first: r.needsYou[0] || r.failedUnseen[0] || null } }; });
const world = street => ({ schema: 1, street });

test('a completed run drives off; failed and cancelled ones do not; at most three at once', () => {
  T = 0; const m = traffic.make(), defs = [def('chat'), def('images')];
  const w1 = world({ chat: src({ running: [job('a'), job('b'), job('c'), job('d')] }), images: src({ running: [job('e'), job('f')] }) });
  m.world(w1, list(w1, defs), true, false);
  assert.equal(traffic.stats().cars, 0, 'the first world is a baseline');
  const w2 = world({ chat: src({ recent: [job('a', 'failed'), job('b', 'cancelled')] }), images: src({ recent: [done('e')] }) });
  m.world(w2, list(w2, defs), true, false);
  assert.equal(traffic.stats().cars, 1, 'only the completed run');
  const w3 = world({ chat: src({ recent: [done('c'), done('d'), done('x')] }), images: src() });
  m.world(w1, list(w1, defs), true, false); m.world(w3, list(w3, defs), true, false);
  assert.equal(traffic.stats().cars, 3, 'capped at three (x never ran here, so it sends none)');
  T = 4001; assert.equal(traffic.stats().cars, 0, 'gone after 4 s');
  // Five runs finishing in one world, from an empty street: the cap drops the last two.
  const w4 = world({ chat: src({ recent: [done('a'), done('b'), done('c'), done('d')] }), images: src({ recent: [done('f')] }) });
  m.world(w1, list(w1, defs), true, false); m.world(w4, list(w4, defs), true, false);
  assert.equal(traffic.stats().cars, 3, 'five finished at once, capped at three');
  T = 8002; assert.equal(traffic.stats().cars, 0, 'gone after 4 s');
  m.destroy();
});

test('a world while off screen resets the baseline, and reduced motion sends no cars', () => {
  T = 0; const m = traffic.make(), defs = [def('chat')];
  const run = world({ chat: src({ running: [job('a')] }) }), fin = world({ chat: src({ recent: [done('a')] }) });
  m.world(run, list(run, defs), true, false); m.world(fin, list(fin, defs), false, false);
  assert.equal(traffic.stats().cars, 0, 'finished while off screen');
  m.world(run, list(run, defs), false, false); m.world(fin, list(fin, defs), true, false);
  assert.equal(traffic.stats().cars, 0, 'off screen for the run');
  m.world(run, list(run, defs), true, true); m.world(fin, list(fin, defs), true, true);
  assert.equal(traffic.stats().cars, 0, 'reduced motion');
  m.world(run, list(run, defs), true, false); m.world(fin, list(fin, defs), true, false);
  assert.equal(traffic.stats().cars, 1, 'on screen both times');
  T = 5000; m.destroy();
});

test('beacons hang at def.beacon or the default; beacon and hazards pulse on their own ids', () => {
  T = 0; const m = traffic.make(), defs = [def('chat', { beacon: { x: 219, y: 258 } }), def('images')];
  const w1 = world({ chat: src({ needsYou: [job('n1')], failedUnseen: [job('f1')] }), images: src({ needsYou: [job('n2')] }) });
  m.world(w1, list(w1, defs), true, false);
  drawn.length = 0; T = 1000;
  assert.equal(m.draw({}, list(w1, defs), 0, 2000, 2000, false), true, 'pulsing moves');
  assert.deepEqual(traffic.stats().beaconAt, [['chat', 219, 258], ['images', 218, 200]]);
  assert.deepEqual(drawn.filter(d => d[0] === 'beacon').map(d => [d[1], d[2]]), [[219, 258], [518, 200]]);
  assert.equal(traffic.stats().stalled, 1);
  T = 61000; drawn.length = 0;
  assert.equal(m.draw({}, list(w1, defs), 0, 2000, 2000, false), false, 'steady after 60 s');
  assert.ok(drawn.every(d => (d[3].glow ?? d[3].hazard) === 1), 'all steady');
  // A new failure on the same building: its hazards pulse again, its beacon (same needs-you id) stays steady.
  const w2 = world({ chat: src({ needsYou: [job('n1')], failedUnseen: [job('f2')] }), images: src({ needsYou: [job('n2')] }) });
  m.world(w2, list(w2, defs), true, false); T = 62000; drawn.length = 0;
  assert.equal(m.draw({}, list(w2, defs), 0, 2000, 2000, false), true);
  const car = drawn.find(d => d[0] === 'car'), chat = drawn.find(d => d[0] === 'beacon' && d[1] === 219);
  assert.ok(car[3].hazard < 1, `the new failure pulses: ${car[3].hazard}`);
  assert.equal(chat[3].glow, 1, 'the beacon stays steady');
  // Off view: nothing drawn or counted. Reduced motion: drawn steady, not moving.
  assert.equal(m.draw({}, list(w2, defs), 5000, 100, 6000, false), false);
  assert.deepEqual([traffic.stats().beacons, traffic.stats().stalled], [0, 0]);
  drawn.length = 0;
  assert.equal(m.draw({}, list(w2, defs), 0, 2000, 2000, true), false);
  assert.ok(drawn.length === 3 && drawn.every(d => (d[3].glow ?? d[3].hazard) === 1));
  m.destroy();
});
