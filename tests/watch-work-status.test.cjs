'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { workStatus } = require('../app/public/agent-world-watch');
const empty = () => ({ running: [], waiting: 0, needsYou: [], failedUnseen: [], recent: [] });
const world = (entry = {}, crews = []) => ({ street: { images: { ...empty(), ...entry }, chat: empty() }, crews });

test('watch mode sees work outside missions and never calls it idle', () => {
  assert.deepEqual(workStatus(world({ running: [{ title: 'Render wall panel' }] })), { mode: 'running', text: 'Working on: Render wall panel' });
  assert.equal(workStatus(world({ waiting: 2 })).mode, 'queued');
  assert.equal(workStatus(world({ needsYou: [{ title: 'Approve next experiment' }] })).mode, 'attention');
  assert.equal(workStatus(world({ failedUnseen: [{ title: 'Image failed' }] })).mode, 'attention');
});

test('unknown sources block idle replay; a confirmed empty street permits it', () => {
  for (const input of [null, {}, { street: [] }, { street: {} }, { street: { x: {} } }]) assert.equal(workStatus(input).mode, 'unavailable');
  assert.equal(workStatus(world({}, null)).mode, 'unavailable');
  assert.equal(workStatus(world()).mode, 'idle');
});

test('Claude work and decisions block idle replay too', () => {
  assert.equal(workStatus(world({}, [{ title: 'Fix printer adapter', state: 'working' }])).mode, 'running');
  assert.deepEqual(workStatus(world({}, [{ title: 'Review the patch', state: 'waiting' }])), {
    mode: 'attention', text: 'Review the patch · waiting for you'
  });
});

test('concurrent work still signals a decision waiting', () => {
  assert.match(workStatus(world({ running: [{ title: 'Research' }], needsYou: [{ title: 'Approve' }] })).text, /1 needs you/);
});
