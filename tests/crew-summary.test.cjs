'use strict';
// Agent World's crew count for screen readers (app/public/crew-summary.js): the words it reads out. The page wiring
// (following #awcRoster, the canvas pointing at it) is checked in a browser by tests/agent-world-ui.mjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const { summary } = require('../app/public/crew-summary');

test('counts the crew by state, in the order the rows show them', () => {
  assert.equal(summary(['done', 'working', 'waiting', 'waiting']), '4 workers: 1 done, 1 working, 2 waiting.');
  assert.equal(summary(['working']), '1 worker: 1 working.');
  assert.equal(summary(['done', 'needs you', 'needs you']), '3 workers: 1 done, 2 need you.');
});

test('says so when there is no crew yet', () => {
  assert.equal(summary([]), 'No workers yet.');
});
