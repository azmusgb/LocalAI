'use strict';
// A job the Windows host claimed but never reported on is failed once it is past its timeout plus a grace period.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPowerShell } = require('../app/server/powershell');

const { failStaleRunning } = createPowerShell({ nowIso: () => '2026-11-01T00:00:00.000Z' });
const at = (ms) => new Date(ms).toISOString();

test('a running job past its timeout and the grace period is failed with a reason', () => {
  const now = Date.parse('2026-11-01T00:00:00Z');
  const items = [
    { id: 'ps-old', status: 'running', timeoutSec: 60, hostStartedAt: at(now - (60 + 5 * 60 + 1) * 1000) },
    { id: 'ps-new', status: 'running', timeoutSec: 60, hostStartedAt: at(now - 30 * 1000) },
    { id: 'ps-done', status: 'completed', timeoutSec: 60, hostStartedAt: at(now - 86400000) },
  ];
  assert.equal(failStaleRunning(items, now), true);
  assert.equal(items[0].status, 'failed');
  assert.equal(items[0].exitCode, -1);
  assert.match(items[0].stderr, /never reported a result/);
  assert.equal(items[1].status, 'running');
  assert.equal(items[2].status, 'completed');
  assert.equal(failStaleRunning(items, now), false, 'nothing left to change');
});

test('a running job with no start time is left alone', () => {
  const items = [{ id: 'ps-x', status: 'running', timeoutSec: 60 }];
  assert.equal(failStaleRunning(items, Date.now()), false);
});
