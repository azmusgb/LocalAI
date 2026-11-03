'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createVoice } = require('../app/server/voice');
const glance = require('../app/glance');
const voice = require('../app/voice');
const needsYou = require('../app/public/needs-you');

function attention({ runs = [], approvals = [], watch = [] } = {}) {
  let result;
  const forbidden = new Proxy({}, { get: (_, key) => { throw new Error(`Unexpected external dependency: ${String(key)}`); } });
  const handlers = createVoice({ voice, glance, needsYou, needsThreads: () => runs, approvalStore: () => approvals,
    watchdog: { list: () => watch }, piHub: forbidden, materialsClient: forbidden, weather: forbidden,
    getCapabilitiesSnapshot: () => { throw new Error('Must not probe services'); },
    json: (_, status, body) => { result = { status, body }; } });
  return handlers.apiAttention({}, {}).then(() => result);
}

test('own attention is independent of the household aggregate, models and remote services', async () => {
  const { status, body } = await attention();
  assert.equal(status, 200);
  assert.equal(body.schema, 1); assert.equal(body.source, 'localai');
  assert.equal(body.cards.length, 1); assert.equal(body.cards[0].count, 0);
  assert.equal(body.needs, undefined);
});

test('own attention uses Home approval deduplication and watchdog warnings', async () => {
  const { status, body } = await attention({
    runs: [{ id: 'r1', status: 'awaiting_approval', meta: { changeId: 'c1' } }],
    approvals: [{ id: 'a1', status: 'pending', meta: { changeId: 'c1' } }, { id: 'a2', status: 'pending', title: 'Continue?' }],
    watch: [{ id: 'disk', title: 'Mac disk is full', severity: 'high' }]
  });
  assert.equal(status, 200);
  assert.equal(body.cards[0].count, 2, 'the approval represented by a run is counted once');
  // Pi Hub lists the finding itself, not the display's "Heads up" (display-feed.js attentionCards)
  assert.equal(body.cards[1].kind, 'watch'); assert.equal(body.cards[1].title, 'Mac disk is full');
  assert.ok(body.cards.every(c => c.kind !== 'home'));
});
