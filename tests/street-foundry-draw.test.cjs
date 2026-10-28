'use strict';
// The Model Foundry's drawing (app/public/street/foundry.js) against a recording fake 2D context: what each state shows
// (a crate per queued job up to 4, fire and smoke only while busy, no worker or light when down), and that it leaves the
// context balanced and never turns smoothing off. How it looks is checked by eye in tests/street-gallery.html.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const art = require(path.join(__dirname, '..', 'app', 'public', 'street', 'art.js'));
const foundry = require(path.join(__dirname, '..', 'app', 'public', 'street', 'foundry.js'));
globalThis.Path2D = globalThis.Path2D || class Path2D { constructor(d) { this.d = d; } };

function fakeCtx() {
  const log = [], sets = [], props = {};
  const grad = () => ({ addColorStop() {} });
  const ctx = new Proxy(props, {
    get(t, k) {
      if (k in t) return t[k];
      if (typeof k !== 'string') return undefined;
      return (...a) => {
        log.push(k);
        for (const v of a) if (typeof v === 'number') assert.ok(Number.isFinite(v), `${k} got a finite number`);
        if (k === 'createLinearGradient' || k === 'createRadialGradient') return grad();
        if (k === 'getTransform') return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
        return undefined;
      };
    },
    set(t, k, v) { sets.push([k, v]); t[k] = v; return true; },
  });
  return { ctx, log, sets };
}

// Draw the still and one live frame with art helpers counted.
function draw(world, t = 1234) {
  const calls = {};
  globalThis.LocalAIStreetArt = Object.fromEntries(Object.entries(art).map(([k, f]) =>
    [k, typeof f === 'function' ? (...a) => { calls[k] = (calls[k] || 0) + 1; return f(...a); } : f]));
  const s = foundry.state(world), { ctx, log, sets } = fakeCtx();
  const env = { night: false, reduced: false, zoom: 1, dpr: 2 };
  foundry.drawStill(ctx, s, env);
  const still = { ...calls };
  foundry.drawLive(ctx, s, t, env);
  globalThis.LocalAIStreetArt = art;
  return { calls, still, log, sets };
}
const world = (loaded, waiting) => ({ models: { loaded, queue: { active: 0, waiting } } });
const busy = q => world([{ name: 'qwen3:14b' }], q);

test('busy: a crate per queued job, up to 4', () => {
  for (const [q, n] of [[0, 0], [1, 1], [2, 2], [4, 4], [9, 4]]) assert.equal(draw(busy(q)).calls.crate || 0, n, `${q} queued`);
});

test('busy burns and smokes; quiet is cold and still; down has no one and no light', () => {
  const b = draw(busy(2));
  assert.ok(b.calls.smoke > 0 && b.calls.rays > 0 && b.calls.person === 1);
  for (const t of [0, 500, 77777]) {
    const q = draw(world([], 3), t);
    assert.equal(q.calls.smoke || 0, 0); assert.equal(q.calls.rays || 0, 0); assert.equal(q.calls.crate || 0, 0);
    assert.equal(q.calls.person, 1, 'the worker still stands in the door');
    assert.ok(!q.log.includes('setLineDash'), 'nothing pours');
  }
  const d = draw(world(null, 0));
  assert.equal(d.calls.person || 0, 0); assert.equal(d.calls.smoke || 0, 0); assert.equal(d.calls.glow || 0, 0);
  assert.equal(d.calls.rays || 0, 0);
});

test('balanced save/restore, finite numbers, smoothing never off', () => {
  for (const w of [busy(3), world([], 0), world(null, 0)]) for (const t of [0, 16, 1e6]) {
    const { log, sets } = draw(w, t);
    assert.equal(log.filter(m => m === 'save').length, log.filter(m => m === 'restore').length);
    assert.deepEqual(sets.filter(([k, v]) => k === 'imageSmoothingEnabled' && !v), []);
  }
});
