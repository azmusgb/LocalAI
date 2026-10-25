'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMaterialsClient, summarize } = require('../app/materials');

const spool = (o) => ({ material: 'PLA', label_weight: 1000, weight_used: 0, archived_at: null, ...o });

test('summarize refuses a malformed answer and counts an empty inventory', () => {
  assert.equal(summarize(null), null);
  assert.equal(summarize({}), null);
  const empty = summarize([]);
  assert.equal(empty.status, '0 spools');
  assert.deepEqual(empty.summary, { spools: 0, loaded: 0, low: 0, unknown: 0, queue: 0 });
});

test('summarize counts Bambuddy spools, the AMS and what is low', () => {
  const s = summarize([
    spool({ id: 1, color_name: 'Grey', weight_used: 900 }),                                 // 100 g left: low (15%)
    spool({ id: 2, color_name: 'Dusty Rose', weight_used: 400 }),                           // 600 g left
    spool({ id: 3, color_name: 'Shadow Storm', weight_used: 0 }),                           // never weighed: unknown, not low
    spool({ id: 4, color_name: 'Red', weight_used: 700, low_stock_threshold_pct: 40 }),     // 300 g, under its own 40%
    spool({ id: 5, color_name: 'Old', archived_at: '2026-10-01T00:00:00' })                 // archived: left out
  ], [{ spool_id: 2 }, { spool_id: 99 }]);
  assert.deepEqual(s.summary, { spools: 4, loaded: 1, low: 2, unknown: 1, queue: 0 });
  assert.equal(s.status, 'Grey PLA · 100 g left · 1 more low');
});

test('without low spools the status counts spools and the AMS', () => {
  assert.equal(summarize([spool({ id: 1 }), spool({ id: 2 })], [{ spool_id: 1 }]).status, '2 spools · 1 in the AMS');
  assert.equal(summarize([spool({ id: 1 })]).status, '1 spool');
});

test('createMaterialsClient off returns null without network fetch', async () => {
  let called = false;
  const client = createMaterialsClient({ url: 'off', fetchImpl: () => { called = true; } });
  assert.equal(await client.read(), null);
  assert.equal(called, false);
});

test('createMaterialsClient reads Bambuddy once a minute at most', async () => {
  const paths = [];
  let t = 0;
  const client = createMaterialsClient({
    url: 'http://127.0.0.1:8000',
    now: () => t,
    fetchImpl: async (u) => {
      paths.push(new URL(u).pathname);
      return { ok: true, json: async () => (String(u).includes('assignments') ? [{ spool_id: 1 }] : [spool({ id: 1, color_name: 'Grey' })]) };
    }
  });
  assert.equal((await client.read()).status, '1 spool · 1 in the AMS');
  await client.read();
  assert.deepEqual(paths.sort(), ['/api/v1/inventory/assignments', '/api/v1/inventory/spools']);
  t = 61000;
  await client.read();
  assert.equal(paths.length, 4);
});

test('createMaterialsClient gives null when Bambuddy does not answer', async () => {
  const client = createMaterialsClient({ url: 'http://127.0.0.1:8000', fetchImpl: async () => { throw new Error('refused'); } });
  assert.equal(await client.read(), null);
});

test('createMaterialsClient sends the Bambuddy API key when one is set', async () => {
  const seen = [];
  const fetchImpl = async (u, o) => { seen.push(o.headers || null); return { ok: true, json: async () => [] }; };
  await createMaterialsClient({ url: 'http://127.0.0.1:8000', fetchImpl }).read();
  await createMaterialsClient({ url: 'http://127.0.0.1:8000', key: 'bb_test', fetchImpl }).read();
  assert.deepEqual(seen, [null, null, { 'X-API-Key': 'bb_test' }, { 'X-API-Key': 'bb_test' }]);
});
