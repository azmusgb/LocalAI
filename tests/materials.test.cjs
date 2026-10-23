'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMaterialsClient, summarize } = require('../app/materials');

test('summarize handles null and malformed payloads cleanly', () => {
  assert.equal(summarize(null), null);
  assert.equal(summarize('not-an-object'), null);
  const empty = summarize({});
  assert.equal(empty.title, 'LocalAI Materials');
  assert.equal(empty.stale, false);
  assert.deepEqual(empty.summary, { spools: 0, loaded: 0, low: 0, unknown: 0, queue: 0 });
});

test('summarize parses valid display-feed payload', () => {
  const d = {
    title: 'LocalAI Materials',
    status: '1 spool low',
    stale: false,
    summary: { spools: 15, loaded: 4, low: 1, unknown: 0, queue: 2 },
    metrics: [{ label: 'Spools', value: '15' }, { label: 'Loaded', value: '4' }]
  };
  const s = summarize(d);
  assert.equal(s.title, 'LocalAI Materials');
  assert.equal(s.status, '1 spool low');
  assert.equal(s.summary.spools, 15);
  assert.equal(s.summary.loaded, 4);
  assert.equal(s.summary.low, 1);
  assert.equal(s.metrics.length, 2);
});

test('createMaterialsClient off returns null without network fetch', async () => {
  let called = false;
  const client = createMaterialsClient({
    url: 'off',
    fetchImpl: () => { called = true; }
  });
  const res = await client.read();
  assert.equal(res, null);
  assert.equal(called, false);
});

test('createMaterialsClient fetches and caches response', async () => {
  let calls = 0;
  const mockPayload = {
    title: 'LocalAI Materials',
    status: 'Inventory healthy',
    summary: { spools: 8, loaded: 4, low: 0, unknown: 0, queue: 0 }
  };
  const client = createMaterialsClient({
    url: 'http://127.0.0.1:8888',
    fetchImpl: async () => {
      calls++;
      return {
        ok: true,
        json: async () => mockPayload
      };
    }
  });

  const first = await client.read();
  assert.equal(first.status, 'Inventory healthy');
  assert.equal(calls, 1);

  // Cached call
  const second = await client.read();
  assert.equal(second.status, 'Inventory healthy');
  assert.equal(calls, 1);
});
