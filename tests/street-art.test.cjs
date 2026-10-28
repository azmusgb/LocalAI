'use strict';
// Main Street's drawing kit (app/public/street/art.js), run against a recording fake 2D context: every helper draws
// without throwing, and none ever turns image smoothing off (the street is drawn at full resolution, never pixelated).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'public', 'street', 'art.js'), 'utf8');

function load() {
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: 'art.js' });
  return ctx.window.LocalAIStreetArt;
}

// A 2D context that records every call and property set. Gradients and patterns are objects with addColorStop.
function fakeCtx() {
  const log = [], sets = [], props = { canvas: { width: 800, height: 360 } };
  const grad = () => ({ addColorStop(o, c) { log.push('addColorStop'); assert.ok(o >= 0 && o <= 1, `stop ${o} in [0,1]`); assert.equal(typeof c, 'string'); } });
  const ctx = new Proxy(props, {
    get(t, k) {
      if (k in t) return t[k];
      if (typeof k !== 'string') return undefined;
      return (...a) => {
        log.push(k);
        for (const v of a) if (typeof v === 'number') assert.ok(Number.isFinite(v), `${k} got a finite number`);
        if (k === 'createLinearGradient' || k === 'createRadialGradient' || k === 'createPattern') return grad();
        if (k === 'measureText') return { width: 10 };
        if (k === 'getTransform') return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
        return undefined;
      };
    },
    set(t, k, v) { sets.push([k, v]); t[k] = v; return true; },
  });
  return { ctx, log, sets };
}

const A = load();

function callAll(ctx, t) {
  A.brick(ctx, 0, 0, 120, 80, {});
  A.brick(ctx, 0, 0, 120, 80, { tone: 'side' });
  A.brick(ctx, 0, 0, 120, 80, { tone: 'warm' });
  A.brickSide(ctx, 0, 0, 30, 80);
  A.corrugated(ctx, 0, 0, 100, 40);
  A.steel(ctx, 0, 0, 100, 8);
  A.glass(ctx, 0, 0, 80, 60);
  A.glow(ctx, 50, 50, 40, 20, '#ffb04a', 0.6);
  A.rays(ctx, [[0, 0], [10, 0], [30, 80], [5, 80]], '#ffd38a', 0.35);
  A.softShadow(ctx, 50, 300, 60, 6);
  A.person(ctx, 40, 300, {});
  A.crate(ctx, 10, 10, 20);
  A.smoke(ctx, 50, 40, t);
  A.fire(ctx, 0, 0, 40, 60, t);
  A.sidewalk(ctx, 0, 400);
  A.road(ctx, 0, 400);
  A.skyline(ctx, 0, 400, 0);
  A.skyline(ctx, 0, 400, 1);
  A.brickSide(ctx, 0, 0, 30, 80, { skew: 6, tone: 'sand' });
  A.tex(ctx, A.brick, 0, 0, 60, 40, { tone: 'slate' });
  A.plank(ctx, 0, 0, 40, 10, 6);
  A.boards(ctx, 0, 0, 120, 60);
  A.boards(ctx, 0, 0, 30, 80);
  A.lamp(ctx, 20, 40, true);
  A.lamp(ctx, 20, 40, false);
  A.person(ctx, 40, 300, { prop: 'brush', reach: [4, -6], tip: '#ff0000' });
  A.car(ctx, 100, 318, { color: '#3a7bd5', hazard: t % 1, wheel: t * 3 });
  A.car(ctx, 100, 336, {});
  A.beacon(ctx, 120, 106, { glow: t % 1, color: '#ffb02e' });
  A.beacon(ctx, 120, 106, {});
}

test('every helper draws without throwing', () => {
  for (const t of [0, 0.5, 3.7, 1000]) {
    const { ctx, log } = fakeCtx();
    callAll(ctx, t);
    assert.ok(log.includes('fill'), 'something was filled');
    assert.ok(log.includes('createLinearGradient'), 'gradients are used');
  }
  assert.ok(Object.isFrozen(A.palette), 'palette is frozen');
  for (const [k, v] of Object.entries(A.palette)) assert.match(v, /^#[0-9a-f]{6}$/i, `palette.${k} is a colour`);
});

test('helpers leave the context as they found it (save and restore balance)', () => {
  const { ctx, log } = fakeCtx();
  callAll(ctx, 1.2);
  for (const p of ['clipboard', 'wrench', 'tablet', 'hammer', 'brush', null]) A.person(ctx, 0, 300, { prop: p });
  assert.equal(log.filter(m => m === 'save').length, log.filter(m => m === 'restore').length);
});

test('art never turns off smoothing', () => {
  const { ctx, sets } = fakeCtx();
  callAll(ctx, 2);
  for (const p of ['clipboard', 'wrench', 'tablet', 'hammer', 'brush', null]) A.person(ctx, 0, 300, { prop: p, pose: 1 });
  assert.deepEqual(sets.filter(([k, v]) => k === 'imageSmoothingEnabled' && v === false), []);
  assert.ok(!/imageSmoothingEnabled\s*=\s*(false|0)/.test(src), 'art.js never sets imageSmoothingEnabled false');
});

test('person draws every prop', () => {
  const counts = {};
  for (const p of ['clipboard', 'wrench', 'tablet', 'hammer', 'brush', null]) {
    const { ctx, log } = fakeCtx();
    A.person(ctx, 0, 300, { prop: p, vest: '#ff7e46', hat: '#ffc640', skin: '#e9b88f', pose: 0.5 });
    assert.ok(log.includes('fill'), `person with ${p} fills`);
    counts[p] = log.length;
  }
  for (const p of ['clipboard', 'wrench', 'tablet', 'hammer', 'brush']) assert.ok(counts[p] > counts.null, `${p} draws more than no prop`);
});

// The street's traffic: a car (nose right, y its middle, wheels on y + 14) whose hazard lamps glow with hazard 0..1 and
// whose wheels turn by wheel radians, and a roof beacon standing on y whose halo grows with glow 0..1.
test('car and beacon draw, and their lights follow hazard and glow', () => {
  const lights = (fn, o) => { const { ctx, log } = fakeCtx(); fn(ctx, 100, 300, o); return log.filter(m => m === 'createRadialGradient').length; };
  assert.ok(lights(A.car, { hazard: 1 }) > lights(A.car, { hazard: 0 }), 'hazard lamps glow when on');
  assert.ok(lights(A.beacon, { glow: 1 }) > lights(A.beacon, { glow: 0 }), 'the beacon has a halo when it glows');
  for (const fn of [A.car, A.beacon]) {
    const { ctx, log, sets } = fakeCtx();
    fn(ctx, 0, 0, { color: '#c0392b', hazard: 0.5, glow: 0.5, wheel: 1 });
    assert.ok(log.includes('fill'));
    assert.equal(log.filter(m => m === 'save').length, log.filter(m => m === 'restore').length);
    assert.deepEqual(sets.filter(([k, v]) => k === 'imageSmoothingEnabled' && v === false), []);
  }
});
