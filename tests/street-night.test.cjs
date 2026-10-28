'use strict';
// Main Street at night (app/public/street/night.js and each building's lights(state)): every building lists its lights in
// its own box; a down or hidden building has none (nor a kiosk that isn't set up), a quiet one keeps its lamps lit, and a busy one lights its windows too.
// And the night clock: 19:00 to 07:00 local time.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const load = n => require(path.join(__dirname, '..', 'app', 'public', 'street', n + '.js'));

const item = i => ({ id: 'i' + i, title: 'Job ' + i, status: 'running' });
const src = o => Object.assign({ running: [], waiting: 0, needsYou: [], failedUnseen: [], recent: [] }, o);
const street = o => ({ chat: src(), images: src(), missions: src(), garage: src(), sheets: src(), clock: src(), ...o });
const runs = id => ({ down: { street: null }, quiet: { street: street() }, busy: { street: street({ [id]: src({ running: [item(1), item(2)] }) }) }, ask: { street: street({ [id]: src({ needsYou: [item(3)] }) }) } });
const WORLDS = {
  chat: runs('chat'), images: runs('images'), missions: runs('missions'), garage: runs('garage'), clock: runs('clock'),
  sheets: { down: {}, quiet: { sheets: { bridge: true, excel: true, inFlight: 0 }, street: street() }, busy: { sheets: { bridge: true, excel: true, inFlight: 1 }, street: street() } },
  foundry: { down: {}, quiet: { models: { loaded: [], queue: { waiting: 0 } } }, busy: { models: { loaded: [{ name: 'qwen3' }], queue: { waiting: 1 } } } },
  workshop: { down: { printer: { setUp: true, access: 'denied', state: 'idle' } }, quiet: { printer: { setUp: true, access: 'ok', state: 'idle' } }, busy: { printer: { setUp: true, access: 'ok', state: 'printing', progress: 40 } } },
  // The kiosk has no quiet state: not set up it stands dark (no flood lamps); set up and online it is lit.
  kiosk: { down: { kiosk: { setUp: true, online: false } }, off: { kiosk: { setUp: false } }, busy: { kiosk: { setUp: true, online: true, firmware: '12.8.0' } } },
  yard: { quiet: { crews: [] }, busy: { crews: [{ id: 'a', title: 'A', state: 'working' }, { id: 'b', title: 'B', state: 'waiting' }] } },
};
const KINDS = new Set(['window', 'lamp', 'glow']);

for (const [id, w] of Object.entries(WORLDS)) {
  test(id + ': lights by state, inside the building', () => {
    const d = load(id);
    assert.equal(typeof d.lights, 'function');
    const at = world => d.lights(d.state(world));
    const down = w.down ? at(w.down) : d.lights({ ...d.state(w.busy), hidden: true });
    assert.deepEqual(down, [], 'none when down or hidden');
    if (w.off) assert.deepEqual(at(w.off), [], 'none when not set up');
    const quiet = w.quiet ? at(w.quiet) : [], busy = at(w.busy);
    if (w.quiet) assert.ok(quiet.some(l => l.kind === 'lamp'), `a lamp when quiet: ${JSON.stringify(quiet)}`);
    else assert.ok(busy.some(l => l.kind === 'lamp'), `a lamp when lit: ${JSON.stringify(busy)}`);
    assert.ok(busy.length > quiet.length, `more when busy: ${busy.length} > ${quiet.length}`);
    assert.ok(busy.some(l => l.kind === 'window'), 'a lit window when busy');
    if (w.ask) assert.ok(at(w.ask).some(l => l.kind === 'window'), 'a window when it needs you');
    for (const l of [...quiet, ...busy]) {
      assert.ok(KINDS.has(l.kind), l.kind);
      assert.match(l.color, /^#[0-9a-f]{6}$/i);
      for (const k of ['x', 'y', 'w', 'h']) assert.ok(Number.isFinite(l[k]), `${k} is a number`);
      assert.ok(l.w > 0 && l.h > 0, 'has size');
      assert.ok(l.x >= 0 && l.y >= 0 && l.x + l.w <= d.width && l.y + l.h <= 300, `${JSON.stringify(l)} inside 0..${d.width} x 0..300`);
    }
  });
}

test('night is 19:00 to 07:00 local time', () => {
  const N = load('night');
  const at = (h, m = 0) => N.isNight(new Date(2026, 9, 28, h, m, 30));
  assert.deepEqual([at(6, 59), at(7), at(12), at(18, 59), at(19), at(23), at(0)], [true, false, false, false, true, true, true]);
});

test('one shared timer while anyone watches, and watchers hear only a change', () => {
  const N = load('night');
  const real = { si: globalThis.setInterval, ci: globalThis.clearInterval, D: globalThis.Date };
  const timers = new Map(); let next = 1, hour = 18;
  globalThis.setInterval = (fn, ms) => { timers.set(next, { fn, ms }); return next++; };
  globalThis.clearInterval = t => timers.delete(t);
  globalThis.Date = class extends real.D { constructor(...a) { if (a.length) super(...a); else super(2026, 9, 28, hour, 59, 30); } };
  try {
    const heard = [];
    assert.equal(N.now(), false);
    const a = N.watch(v => heard.push(['a', v])), b = N.watch(v => heard.push(['b', v]));
    assert.equal(timers.size, 1, 'one timer for both');
    assert.equal([...timers.values()][0].ms, 60000, 'once a minute');
    const tick = () => [...timers.values()][0].fn();
    tick(); assert.deepEqual(heard, [], 'no change, no call');
    hour = 19; tick(); assert.deepEqual(heard, [['a', true], ['b', true]]);
    tick(); assert.equal(heard.length, 2, 'once per change');
    a(); assert.equal(timers.size, 1); b(); assert.equal(timers.size, 0, 'stops with the last watcher');
  } finally { Object.assign(globalThis, { setInterval: real.si, clearInterval: real.ci, Date: real.D }); }
});
