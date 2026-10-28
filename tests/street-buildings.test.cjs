'use strict';
// Main Street's first six buildings (app/public/street/*.js): pure state(world), stillKey(state) and chip(state).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const load = n => require(path.join(__dirname, '..', 'app', 'public', 'street', n + '.js'));
const LONG = 'x'.repeat(300);
const item = i => ({ id: 'i' + i });
const src = o => Object.assign({ running: [], waiting: 0, needsYou: [], failedUnseen: [], recent: [] }, o);
const street = o => ({ chat: src(), images: src(), missions: src(), garage: src(), sheets: src(), clock: src(), ...o });
const fits = c => { assert.ok(c.detail.length <= 60); assert.ok(c.detail.endsWith('…')); };

for (const [id, name] of [['chat', 'Chat Café'], ['images', 'Image Studio']]) {
  test(id + ': state and chip', () => {
    const d = load(id);
    assert.equal(d.id, id); assert.equal(d.width, 240);
    const busy = d.state({ street: street({ [id]: src({ running: [item(1), item(2), item(3)], waiting: 47 }) }) });
    assert.deepEqual(busy, { running: 3, more: 47, needsYou: 0, failed: 0, down: false });
    assert.deepEqual(d.chip(busy), { title: name, detail: '50 running', tone: 'busy' });
    const need = d.state({ street: street({ [id]: src({ running: [item(1)], needsYou: [item(2), item(3)], failedUnseen: [item(4)] }) }) });
    assert.equal(need.failed, 1);
    assert.deepEqual(d.chip(need), { title: name, detail: '1 running · 2 need you', tone: 'attention' });
    const quiet = d.state({ street: street() });
    assert.deepEqual(d.chip(quiet), { title: name, detail: 'Quiet', tone: 'quiet' });
    const down = d.state({ street: null });
    assert.equal(down.down, true);
    assert.deepEqual(d.chip(down), { title: name, detail: 'Not answering', tone: 'down' });
    // Chat/Images detail is built from counts only (a 300-character title can't reach it), so the cut is unreachable: it stays short.
    const huge = d.state({ street: street({ [id]: src({ running: [item(1)], waiting: 1e300, needsYou: [item(2)] }) }) });
    assert.ok(d.chip(huge).detail.length <= 60);
    assert.notEqual(d.stillKey(busy), d.stillKey(quiet));
    assert.notEqual(d.stillKey(down), d.stillKey(quiet));
    assert.equal(typeof d.drawStill, 'function'); assert.equal(typeof d.drawLive, 'function');
  });
}

test('sheets: state and chip', () => {
  const d = load('sheets');
  assert.equal(d.width, 220);
  const mk = (sheets, st) => d.state({ sheets, street: st || street() });
  const busy = mk({ bridge: true, excel: true, inFlight: 1 });
  assert.deepEqual(busy, { working: true, bridge: true, excel: true, down: false });
  assert.equal(d.chip(busy).detail, 'Working');
  assert.equal(mk({ bridge: true, excel: true, inFlight: 0 }, street({ sheets: src({ running: [item(1)] }) })).working, true);
  const quiet = mk({ bridge: true, excel: true, inFlight: 0 });
  assert.deepEqual(d.chip(quiet), { title: 'Spreadsheets Office', detail: 'Ready', tone: 'quiet' });
  assert.equal(d.chip(mk({ bridge: true, excel: false, inFlight: 0 })).detail, 'Excel not open');
  const down = mk({ bridge: null, excel: null, inFlight: 0 });
  assert.equal(down.down, true);
  assert.deepEqual(d.chip(down), { title: 'Spreadsheets Office', detail: 'Not answering', tone: 'down' });
  assert.equal(d.state({ sheets: null, street: null }).down, true);
  // Fixed copy only ('Working', 'Ready', 'Excel not open'): a 300-character value cannot reach the detail, so '…' is unreachable.
  assert.ok(d.chip(mk({ bridge: true, excel: false, inFlight: 0 }, street({ sheets: src({ running: [item(1)] }) }))).detail.length <= 60);
  assert.notEqual(d.stillKey(busy), d.stillKey(quiet));
});

test('foundry: state and chip', () => {
  const d = load('foundry');
  assert.equal(d.width, 320);
  const m = (loaded, waiting) => d.state({ models: { loaded, queue: { active: 1, waiting }, busy: false } });
  const busy = m([{ name: 'llama3', sizeMb: 1, vramMb: 1 }, { name: 'b' }], 4);
  assert.deepEqual(busy, { model: 'llama3', loaded: 2, queued: 4, down: false });
  assert.deepEqual(d.chip(busy), { title: 'Model Foundry', detail: 'llama3 loaded · 4 waiting', tone: 'busy' });
  assert.equal(d.chip(m([{ name: 'llama3' }], 0)).detail, 'llama3 loaded');
  const quiet = m([], 0);
  assert.deepEqual(d.chip(quiet), { title: 'Model Foundry', detail: 'No model loaded', tone: 'quiet' });
  const down = m(null, 0);
  assert.equal(down.down, true);
  assert.deepEqual(d.chip(down), { title: 'Model Foundry', detail: 'Not answering', tone: 'down' });
  assert.equal(d.state({ models: null }).down, true);
  fits(d.chip(m([{ name: LONG }], 2)));
  assert.notEqual(d.stillKey(busy), d.stillKey(quiet));
});

test('workshop: state and chip', () => {
  const d = load('workshop');
  assert.equal(d.width, 260);
  const p = o => d.state({ printer: Object.assign({ setUp: true, access: 'ok', state: 'idle', progress: null, minutesLeft: null, errorCode: null }, o) });
  const busy = p({ state: 'printing', progress: 42, minutesLeft: 17 });
  assert.deepEqual(d.chip(busy), { title: 'Workshop Garage', detail: 'Printing · 42% · 17 min left', tone: 'busy' });
  const quiet = p({});
  assert.deepEqual(d.chip(quiet), { title: 'Workshop Garage', detail: 'Idle', tone: 'quiet' });
  const err = p({ state: 'error' });
  assert.equal(err.error, true);
  assert.deepEqual(d.chip(err), { title: 'Workshop Garage', detail: 'Error', tone: 'attention' });
  const off = p({ setUp: false, access: null });
  assert.equal(off.down, false);
  assert.deepEqual(d.chip(off), { title: 'Workshop Garage', detail: 'Not set up', tone: 'quiet' });
  const down = p({ access: 'denied' });
  assert.equal(down.down, true);
  assert.deepEqual(d.chip(down), { title: 'Workshop Garage', detail: 'Not answering', tone: 'down' });
  // Set up but not read yet (the poller's first look is pending): checking, not down, and not boarded.
  const checking = p({ access: null });
  assert.equal(checking.down, false);
  assert.deepEqual(d.chip(checking), { title: 'Workshop Garage', detail: 'Checking…', tone: 'quiet' });
  assert.notEqual(d.stillKey(checking), 'down');
  for (const a of ['denied', 'unreachable', 'error', '', false]) assert.equal(p({ access: a }).down, true, `access ${JSON.stringify(a)} stays down`);
  assert.equal(d.state({ printer: null }).down, true);
  assert.notEqual(d.stillKey(busy), d.stillKey(quiet));
  assert.equal(d.stillKey(p({ state: 'printing', progress: 10 })), d.stillKey(p({ state: 'printing', progress: 90 })));
  fits(d.chip(p({ state: 'printing', progress: 5, minutesLeft: 'y'.repeat(300) })));
  const paused = p({ state: 'paused', progress: 30 });
  assert.deepEqual(d.chip(paused), { title: 'Workshop Garage', detail: 'Paused · 30%', tone: 'quiet' });
  assert.equal(d.chip(p({ state: 'paused' })).detail, 'Paused');
  assert.equal(d.stillKey(paused), d.stillKey(busy));
  for (const st of ['cancelled', 'ended']) assert.equal(d.chip(p({ state: st })).detail, 'Idle');
});

test('kiosk: state and chip', () => {
  const d = load('kiosk');
  assert.equal(d.width, 140);
  const k = o => d.state({ kiosk: Object.assign({ setUp: true, online: true, signIn: true, firmware: '1.2.3' }, o) });
  const on = k({});
  assert.deepEqual(on, { setUp: true, online: true, firmware: '1.2.3', down: false });
  assert.deepEqual(d.chip(on), { title: 'Kiosk Billboard', detail: 'Online · 1.2.3', tone: 'quiet' });
  assert.equal(d.chip(k({ firmware: null })).detail, 'Online');
  const off = k({ setUp: false, online: null, firmware: null });
  assert.deepEqual(d.chip(off), { title: 'Kiosk Billboard', detail: 'Not set up', tone: 'quiet' });
  const down = k({ online: false });
  assert.equal(down.down, true);
  assert.deepEqual(d.chip(down), { title: 'Kiosk Billboard', detail: 'Not answering', tone: 'down' });
  assert.equal(d.state({ kiosk: null }).down, true);
  fits(d.chip(k({ firmware: LONG })));
  assert.notEqual(d.stillKey(on), d.stillKey(off));
});

// animates(state): each building says whether its live layer moves. The engine stops its loop when no building on view
// animates, so a building that says false must draw the same live frame at any t.
const kit = require('./street-draw-kit.cjs');
const pr = o => ({ printer: Object.assign({ setUp: true, access: 'ok', state: 'idle', progress: null, minutesLeft: null, errorCode: null }, o) });
const ANIM = {
  chat: [[{ street: street({ chat: src({ running: [item(1)] }) }) }, true], [{ street: street({ chat: src({ needsYou: [item(1)] }) }) }, true], [{ street: street() }, false], [{ street: null }, false]],
  images: [[{ street: street({ images: src({ running: [item(1)] }) }) }, true], [{ street: street() }, false], [{ street: null }, false]],
  sheets: [[{ sheets: { bridge: true, excel: true, inFlight: 1 }, street: street() }, true], [{ sheets: { bridge: true, excel: true, inFlight: 0 }, street: street() }, false], [{ sheets: { bridge: true, excel: false, inFlight: 0 }, street: street() }, false], [{ sheets: null, street: null }, false]],
  foundry: [[{ models: { loaded: [{ name: 'm' }], queue: { waiting: 2 } } }, true], [{ models: { loaded: [], queue: { waiting: 0 } } }, false], [{ models: null }, false]],
  workshop: [[pr({ state: 'printing', progress: 40 }), true], [pr({ state: 'error' }), true], [pr({}), false], [pr({ state: 'paused', progress: 30 }), false], [pr({ access: null }), false], [pr({ setUp: false, access: null }), false], [pr({ access: 'denied' }), false], [{ printer: null }, false]],
  kiosk: [[{ kiosk: { setUp: true, online: true, firmware: '1' } }, true], [{ kiosk: { setUp: false, online: null } }, false], [{ kiosk: { setUp: true, online: false } }, false], [{ kiosk: null }, false]],
};
for (const [id, cases] of Object.entries(ANIM)) {
  test(id + ': animates(state) is declared, and a still building draws the same live frame at any t', () => {
    const d = load(id);
    assert.equal(typeof d.animates, 'function', id + ' declares animates');
    for (const [w, want] of cases) {
      const s = d.state(w);
      assert.equal(d.animates(s), want, id + ' ' + JSON.stringify(w).slice(0, 120));
      if (want) continue;
      const frame = t => { const r = kit.draw(d, w, t); return JSON.stringify([r.liveRec.args, r.liveRec.sets]); };
      assert.equal(frame(0), frame(12345), id + ' is still at any t: ' + JSON.stringify(w).slice(0, 120));
      assert.equal(frame(0), frame(777), id + ' is still at any t');
    }
  });
}
