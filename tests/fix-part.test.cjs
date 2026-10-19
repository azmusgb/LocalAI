'use strict';
// Images › Fix a part (app/public/fix-part.js): the soft ellipse mask, the circle a tap or drag makes, the prompt and
// the request. The page wiring needs a browser (tests/fix-part-ui.mjs); these helpers are pure.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'public', 'fix-part.js'), 'utf8');
const ctx = { window: {}, document: { readyState: 'loading', addEventListener() {} }, Uint8ClampedArray, Math, String, Number };
vm.runInNewContext(src, ctx);
const F = ctx.window.LocalAIFixPart;

test('the mask is white inside the ellipse, black outside, with a soft edge over the outer 15%', () => {
  const w = 200, h = 100, e = { cx: 100, cy: 50, rx: 80, ry: 40 };
  const v = F.ellipseMask(w, h, e);
  const at = (x, y) => v[y * w + x];
  assert.equal(at(100, 50), 255, 'centre');
  assert.equal(at(100 + 60, 50), 255, '75% of the way out is still full');
  assert.equal(at(0, 0), 0, 'corner');
  assert.equal(at(199, 50), 0, 'beyond the radius');
  // Along the long axis the edge band (85%..100% of rx, x 168..180) falls smoothly from 255 to 0.
  const band = [];
  for (let x = 166; x <= 181; x++) band.push(at(x, 50));
  assert.ok(band.some(n => n > 0 && n < 255), `soft values in the band: ${band}`);
  for (let i = 1; i < band.length; i++) assert.ok(band[i] <= band[i - 1], `falls monotonically: ${band}`);
  assert.equal(band[0], 255);
  assert.equal(band.at(-1), 0);
  // The soft band is about 15% of the radius wide (12 px of 80), not a hard step.
  const soft = band.filter(n => n > 0 && n < 255).length;
  assert.ok(soft >= 9 && soft <= 13, `soft band ${soft} px`);
});

test('the feather can be changed, and an empty or degenerate ellipse paints nothing', () => {
  const w = 100, h = 100, e = { cx: 50, cy: 50, rx: 40, ry: 40 };
  const softer = F.ellipseMask(w, h, e, 0.5), harder = F.ellipseMask(w, h, e, 0.15);
  assert.ok(softer[50 * w + 75] < 255 && harder[50 * w + 75] === 255);
  assert.ok(F.ellipseMask(w, h, null).every(n => n === 0));
  assert.ok(F.ellipseMask(w, h, { cx: 50, cy: 50, rx: 0, ry: 10 }).every(n => n === 0));
});

test('mask pixels carry the mask in the red channel (grey), are opaque, and brush strokes count as full white', () => {
  const w = 40, h = 20, e = { cx: 10, cy: 10, rx: 8, ry: 8 };
  const strokes = new Uint8ClampedArray(w * h * 4);
  strokes[(10 * w + 35) * 4 + 3] = 140; // one painted pixel far outside the ellipse
  const px = F.maskPixels(w, h, e, strokes);
  const rgba = (x, y) => [...px.slice((y * w + x) * 4, (y * w + x) * 4 + 4)];
  assert.deepEqual(rgba(10, 10), [255, 255, 255, 255]);
  assert.deepEqual(rgba(30, 2), [0, 0, 0, 255]);
  assert.deepEqual(rgba(35, 10), [255, 255, 255, 255], 'the brush adds to the area');
  const edge = rgba(17, 10);
  assert.ok(edge[0] > 0 && edge[0] < 255 && edge[0] === edge[1] && edge[1] === edge[2], `grey edge ${edge}`);
  for (let i = 3; i < px.length; i += 4) assert.equal(px[i], 255);
  assert.deepEqual([...F.maskPixels(2, 1, null, null)], [0, 0, 0, 255, 0, 0, 0, 255]);
});

test('a tap circles the part around it; a drag fits the box of its path, widened for the soft edge', () => {
  const tap = F.ellipseFromPath([[300, 200], [304, 203]], 1000, 800);
  assert.deepEqual([tap.cx, tap.cy, tap.rx, tap.ry], [300, 200, 128, 128]);
  // A loop around the part: the box of every point, not just the ends.
  const loop = F.ellipseFromPath([[100, 100], [200, 80], [300, 100], [200, 185], [110, 110]], 1000, 800);
  assert.equal(loop.cx, 200);
  assert.equal(loop.cy, 132.5);
  // The full-white core (85% of the radius) covers the circled box.
  assert.ok(Math.abs(loop.rx * (1 - F.FEATHER) - 100) < 1e-9, `rx ${loop.rx}`);
  assert.ok(Math.abs(loop.ry * (1 - F.FEATHER) - 52.5) < 1e-9, `ry ${loop.ry}`);
  // A thin drag still gives a usable ellipse.
  const line = F.ellipseFromPath([[100, 100], [200, 100]], 1000, 800);
  assert.equal(line.ry, 16);
});

test('the prompt says what to change first, then the scene', () => {
  assert.equal(F.composePrompt('bigger fennec ears.', 'a fox girl in a forest, soft light'), 'bigger fennec ears. a fox girl in a forest, soft light');
  assert.equal(F.composePrompt('  no hat ', ''), 'no hat');
  assert.equal(F.composePrompt('', 'a fox'), '');
});

test('the request is a full-strength masked edit asking for two versions', () => {
  const body = F.fixBody({ fix: 'bigger fennec ears', scene: 'a fox girl', source: 'data:image/png;base64,AA', mask: 'data:image/png;base64,BB', width: 1024, height: 1024, engine: 'best', style: 'photo' });
  assert.deepEqual(JSON.parse(JSON.stringify(body)), {
    prompt: 'bigger fennec ears. a fox girl', source: 'data:image/png;base64,AA', mask: 'data:image/png;base64,BB',
    sourceWidth: 1024, sourceHeight: 1024, strength: 1, count: 2, engine: 'best', style: 'photo', enhance: false, upscale: false
  });
  assert.equal(F.fixBody({ fix: 'x', strength: 0.7 }).strength, 0.7);
  assert.equal(F.fixBody({ fix: 'x' }).style, 'none');
});

test('the chips are Hands, Face, Ears and Remove object, in plain words', () => {
  assert.deepEqual([...F.PRESETS.map(p => p.label)], ['Hands', 'Face', 'Ears', 'Remove object']);
  assert.equal(F.PRESETS.find(p => p.id === 'remove').text, 'nothing here, same background as around it');
  for (const p of F.PRESETS) assert.match(p.text, /^[a-z ,]+$/, `${p.label}: ${p.text}`);
});
