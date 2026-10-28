'use strict';
// Shared by the tests/street-*-draw.test.cjs files: a recording fake 2D context (method names, property sets, numeric args), and draw(def, world, t), which draws a
// building's still and one live frame with the art kit's helpers counted. Not a test file itself (no .test.cjs).
const assert = require('node:assert/strict');
const path = require('node:path');

const art = require(path.join(__dirname, '..', 'app', 'public', 'street', 'art.js'));
globalThis.Path2D = globalThis.Path2D || class Path2D { constructor(d) { this.d = d; } };
const env = { night: false, reduced: false, zoom: 1, dpr: 2 };

function fakeCtx() {
  const log = [], sets = [], args = [], props = {};
  const grad = () => ({ addColorStop(o, c) { log.push('stop:' + c); } });
  const ctx = new Proxy(props, {
    get(t, k) {
      if (k in t) return t[k];
      if (typeof k !== 'string') return undefined;
      return (...a) => {
        log.push(k); args.push([k, ...a.filter(v => typeof v === 'number')]);
        if (k === 'fill' && a[0] && a[0].d) log.push('fillPath:' + a[0].d);
        for (const v of a) if (typeof v === 'number') assert.ok(Number.isFinite(v), `${k} got a finite number`);
        if (k === 'createLinearGradient' || k === 'createRadialGradient') return grad();
        if (k === 'getTransform') return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
        return undefined;
      };
    },
    set(t, k, v) { sets.push([k, v]); t[k] = v; return true; },
  });
  return { ctx, log, sets, args };
}

// calls: art helper counts over still + live; still: counts after the still; live: counts in the live frame only.
function draw(def, world, t = 1234) {
  const calls = {};
  globalThis.LocalAIStreetArt = Object.fromEntries(Object.entries(art).map(([k, f]) =>
    [k, typeof f === 'function' ? (...a) => { calls[k] = (calls[k] || 0) + 1; return f(...a); } : f]));
  try {
    const s = def.state(world), still = fakeCtx(), live = fakeCtx();
    def.drawStill(still.ctx, s, env);
    const stillCalls = { ...calls };
    def.drawLive(live.ctx, s, t, env);
    const liveCalls = Object.fromEntries(Object.entries(calls).map(([k, n]) => [k, n - (stillCalls[k] || 0)]).filter(([, n]) => n > 0));
    return { s, calls, still: stillCalls, live: liveCalls, stillRec: still, liveRec: live };
  } finally { globalThis.LocalAIStreetArt = art; }
}

// Every frame and still keeps save/restore balanced, every number finite, and smoothing on.
function assertClean(r) {
  for (const rec of [r.stillRec, r.liveRec]) {
    assert.equal(rec.log.filter(m => m === 'save').length, rec.log.filter(m => m === 'restore').length, 'save/restore balance');
    assert.deepEqual(rec.sets.filter(([k, v]) => k === 'imageSmoothingEnabled' && !v), []);
  }
}
const fills = rec => rec.sets.filter(([k]) => k === 'fillStyle').map(([, v]) => v);
const stops = rec => rec.log.filter(m => m.startsWith('stop:')).map(m => m.slice(5));

module.exports = { art, env, fakeCtx, draw, assertClean, fills, stops };
