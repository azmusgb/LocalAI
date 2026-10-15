'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { plannerError, approvalTitle } = require('../app/plain-text.js');

test('a planner timeout reads as a sentence, without internal fields', () => {
  const m = plannerError({ aborted: true, timeoutMs: 600000, elapsedMs: 599974, name: 'Error', message: 'Engineering planner watchdog exceeded 600000 ms' });
  assert.equal(m, "The planning model didn't finish within 10 minutes, so this attempt was stopped.");
});

test('a connection failure names the cause once', () => {
  assert.equal(plannerError({ aborted: false, timeoutMs: 600000, code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:11434' }),
    "Couldn't reach the planning model (ECONNREFUSED). Check that Ollama is running, then try again.");
  assert.equal(plannerError({ aborted: false, timeoutMs: 600000, message: 'socket hang up' }),
    "Couldn't reach the planning model (socket hang up). Check that Ollama is running, then try again.");
});

test('a change approval is titled by what the change does, not its id', () => {
  assert.equal(approvalTitle({ id: 'chg-1790627729628-7be1a51', summary: 'Fix the Images page model selector', request: 'x' }), 'Apply change: Fix the Images page model selector');
  assert.equal(approvalTitle({ id: 'chg-1', summary: 'Proposed change', request: 'Make the header fit on phones' }), 'Apply change: Make the header fit on phones');
});
