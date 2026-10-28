'use strict';
// Main Street's shared building helpers (app/public/street/common.js): cut, count, asks and runsBuilding.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const dir = path.join(__dirname, '..', 'app', 'public', 'street');
const C = require(path.join(dir, 'common.js'));
const item = i => ({ id: 'i' + i });
const src = o => Object.assign({ running: [], waiting: 0, needsYou: [], failedUnseen: [], recent: [] }, o);
const street = o => ({ chat: src(), ...o });

test('cut: short strings pass, long ones end in an ellipsis at n', () => {
  assert.equal(C.cut('abc'), 'abc');
  assert.equal(C.cut('x'.repeat(60)), 'x'.repeat(60));
  assert.equal(C.cut('x'.repeat(61)), 'x'.repeat(59) + '…');
  assert.equal(C.cut('abcdef', 4), 'abc…');
  assert.equal(C.cut('abcd', 4), 'abcd');
});

test('count: a finite positive number floored, else 0', () => {
  for (const [v, want] of [[3, 3], [3.9, 3], [0, 0], [-2, 0], [NaN, 0], [Infinity, 0], ['5', 0], [null, 0], [undefined, 0], [0.5, 0], [1e300, 1e300]]) assert.equal(C.count(v), want, String(v));
});

test('asks: counts and the first item (needs you, then failed)', () => {
  assert.deepEqual(C.asks(undefined), { needsYou: 0, failed: 0, first: null });
  assert.deepEqual(C.asks(src()), { needsYou: 0, failed: 0, first: null });
  assert.deepEqual(C.asks(src({ failedUnseen: [item(4), item(5)] })), { needsYou: 0, failed: 2, first: item(4) });
  assert.deepEqual(C.asks(src({ needsYou: [item(1)], failedUnseen: [item(4)] })), { needsYou: 1, failed: 1, first: item(1) });
});

const B = C.runsBuilding({ id: 'chat', key: 'chat', title: 'Chat Café', width: 240, roof: 'flat' });
const st = o => B.state({ street: street({ chat: src(o) }) });

test('runsBuilding: identity and state', () => {
  assert.equal(B.id, 'chat'); assert.equal(B.width, 240); assert.equal(B.roof, 'flat');
  const busy = st({ running: [item(1), item(2), item(3), item(4)], waiting: 47 });
  assert.equal(busy.running, 3); assert.equal(busy.more, 47); assert.equal(busy.down, false);
  assert.equal(B.state({ street: null }).down, true);
  assert.equal(B.state(null).down, true);
});

test('runsBuilding: chip copy', () => {
  const chip = s => B.chip(s);
  assert.deepEqual(chip(st()), { title: 'Chat Café', detail: 'Quiet', tone: 'quiet' });
  assert.deepEqual(chip(st({ running: [item(1), item(2), item(3)] })), { title: 'Chat Café', detail: '3 running', tone: 'busy' });
  assert.deepEqual(chip(st({ running: [item(1), item(2), item(3)], waiting: 47 })), { title: 'Chat Café', detail: '50 running', tone: 'busy' });
  assert.deepEqual(chip(st({ running: [item(1), item(2)], needsYou: [item(3)] })), { title: 'Chat Café', detail: '2 running · 1 need you', tone: 'attention' });
  assert.deepEqual(chip(st({ failedUnseen: [item(1)] })), { title: 'Chat Café', detail: '1 failed', tone: 'attention' });
  assert.deepEqual(chip(st({ running: [item(1)], needsYou: [item(2)], failedUnseen: [item(3)] })), { title: 'Chat Café', detail: '1 running · 1 need you · 1 failed', tone: 'attention' });
  assert.deepEqual(chip(st({ needsYou: [item(2)] })), { title: 'Chat Café', detail: '1 need you', tone: 'attention' });
  assert.deepEqual(chip(B.state({ street: null })), { title: 'Chat Café', detail: 'Not answering', tone: 'down' });
  assert.ok(chip(st({ running: [item(1)], waiting: 1e300, needsYou: [item(2)] })).detail.length <= 60);
});

test('runsBuilding: stillKey, item and animates', () => {
  assert.equal(B.stillKey(B.state({ street: null })), 'down');
  assert.equal(B.stillKey(st()), 'unlit');
  assert.equal(B.stillKey(st({ running: [item(1)] })), 'lit');
  assert.equal(B.stillKey(st({ needsYou: [item(1)] })), 'ask');
  assert.equal(B.stillKey(st({ running: [item(1)], needsYou: [item(1)] })), 'lit');
  assert.equal(B.stillKey(st({ failedUnseen: [item(1)] })), 'unlit');
  assert.equal(B.item(st()), null);
  assert.deepEqual(B.item(st({ running: [item(1)] })), item(1));
  assert.deepEqual(B.item(st({ running: [item(1)], failedUnseen: [item(2)] })), item(2));
  assert.deepEqual(B.item(st({ running: [item(1)], failedUnseen: [item(2)], needsYou: [item(3)] })), item(3));
  assert.equal(B.animates(st()), false);
  assert.equal(B.animates(st({ running: [item(1)] })), true);
  assert.equal(B.animates(st({ waiting: 2 })), true);
  assert.equal(B.animates(st({ needsYou: [item(1)] })), false, 'needs-you-only is static');
  assert.equal(B.animates(B.state({ street: null })), false);
});

test('every building file declares animates', () => {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.js') && !['art.js', 'street.js', 'common.js', 'traffic.js', 'night.js', 'page.js'].includes(f));
  assert.ok(files.length >= 6);
  for (const f of files) assert.equal(typeof require(path.join(dir, f)).animates, 'function', f);
});
