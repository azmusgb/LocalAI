'use strict';
// Projects › Print lab: the page updates itself after each `lab` command (app/public/print-lab-refresh.js). The watcher
// checks the sync fingerprint every 3 s while the page is on screen, applies a new one once, holds it while a sheet or
// field is in use, and says "Can't reach Local AI" only after three failures in a row. Timers are faked.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'app/public/print-lab-refresh.js'), 'utf8');
const win = {};
vm.runInNewContext(src, { window: win });
const R = win.LocalAIPrintLabRefresh;

// A fake clock: tick() runs the one pending timer (the watcher keeps at most one) and waits for its promises.
function clock() {
  let next = null;
  const timers = { setTimeout: (fn, ms) => { next = { fn, ms }; return 1; }, clearTimeout: () => { next = null; } };
  const settle = () => new Promise(r => setImmediate(r));
  return { timers, pendingMs: () => next && next.ms, async tick() { const t = next; next = null; if (t) t.fn(); for (let i = 0; i < 5; i++) await settle(); } };
}
function harness(values, opts = {}) {
  const c = clock(), seen = { applied: 0, checks: 0, failures: [] };
  let i = 0;
  const w = R.watch({
    check: async () => { seen.checks++; const v = values[Math.min(i++, values.length - 1)]; if (v instanceof Error) throw v; return v; },
    apply: async () => { seen.applied++; },
    isActive: opts.isActive || (() => true),
    isBusy: opts.isBusy || (() => false),
    onFailures: n => seen.failures.push(n),
    timers: c.timers
  });
  return { c, w, seen };
}

test('checks every 3 s', async () => {
  const { c } = harness(['a']);
  await c.tick();
  assert.equal(c.pendingMs(), 3000);
});

test('unchanged fingerprint does nothing', async () => {
  const { c, seen } = harness(['a', 'a', 'a']);
  for (let k = 0; k < 3; k++) await c.tick();
  assert.equal(seen.checks, 3);
  assert.equal(seen.applied, 0);
});

test('a new fingerprint applies once', async () => {
  const { c, seen } = harness(['a', 'b', 'b', 'b']);
  for (let k = 0; k < 4; k++) await c.tick();
  assert.equal(seen.applied, 1);
});

test('held while a sheet is open', async () => {
  let busy = false;
  const { c, seen } = harness(['a', 'b', 'b', 'b'], { isBusy: () => busy });
  await c.tick();
  busy = true;
  await c.tick();
  await c.tick();
  assert.equal(seen.applied, 0);
  busy = false;
  await c.tick();
  assert.equal(seen.applied, 1);
  await c.tick();
  assert.equal(seen.applied, 1);
});

test('paused while hidden or inactive', async () => {
  let active = false;
  const { c, w, seen } = harness(['a', 'b'], { isActive: () => active });
  await c.tick();
  await c.tick();
  assert.equal(seen.checks, 0);
  active = true;
  w.poke();
  await c.tick();
  assert.equal(seen.checks, 1);
});

test('three failures then recovery', async () => {
  const down = new Error('down');
  const { c, seen } = harness(['a', down, down, down, 'a']);
  for (let k = 0; k < 5; k++) await c.tick();
  assert.deepEqual(seen.failures, [1, 2, 3, 0]);
  assert.equal(seen.applied, 0);
});

test('stop ends the checks', async () => {
  const { c, w, seen } = harness(['a', 'b']);
  await c.tick();
  w.stop();
  await c.tick();
  assert.equal(seen.checks, 1);
});

test('the first project to arrive is applied (no project yet is not a baseline)', async () => {
  const { c, seen } = harness([null, null, 'a', 'a']);
  for (let k = 0; k < 4; k++) await c.tick();
  assert.equal(seen.applied, 1);
});

test('quiet render keeps scroll and open details', () => {
  const opened = [];
  const details = id => ({ id, set open(v) { if (v) opened.push(id); } });
  const before = { querySelectorAll: sel => (sel === 'details[open]' ? [details('lab-d-E-004'), details('lab-earlier')] : []), ownerDocument: { activeElement: { id: 'labCopy-E-008' }, defaultView: { scrollY: 640 } } };
  const snap = R.snapshot(before);
  assert.deepEqual(JSON.parse(JSON.stringify(snap)), { scrollY: 640, open: ['lab-d-E-004', 'lab-earlier'], focusId: 'labCopy-E-008', focus: null, anchor: null });
  let scrolled = null, focused = null;
  const byId = { 'lab-d-E-004': details('lab-d-E-004'), 'lab-earlier': details('lab-earlier'), 'labCopy-E-008': { focus: o => { focused = o; } } };
  const after = { querySelector: sel => byId[sel.replace(/^#/, '').replace(/\\/g, '')] || null, ownerDocument: { defaultView: { scrollTo: (x, y) => { scrolled = y; } } } };
  R.restore(after, snap);
  assert.deepEqual(opened, ['lab-d-E-004', 'lab-earlier']);
  assert.equal(scrolled, 640);
  assert.deepEqual(JSON.parse(JSON.stringify(focused)), { preventScroll: true });
});
