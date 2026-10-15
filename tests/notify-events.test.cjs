'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runEvent, serviceEvent, noticeEvent } = require('../app/notify.js');

const run = (patch) => ({ id: 'r1', title: 'Make a fox', status: 'running', startedAt: '2026-10-15T12:00:00.000Z', finishedAt: null, summary: '', error: '', ...patch });

test('runs: approval, failure and long finishes notify; short or cancelled ones do not', () => {
  assert.deepEqual(runEvent(run({ status: 'awaiting_approval' }), 'running'), { kind: 'needs-you', title: 'Waiting for your approval', body: 'Make a fox', url: '/?open=run:r1', tag: 'run:r1' });
  // Only the run's title reaches the lock screen: never its output or error text (spec: Privacy).
  assert.deepEqual(runEvent(run({ status: 'failed', error: 'ComfyUI: out of memory', finishedAt: '2026-10-15T12:00:05.000Z' }), 'running'), { kind: 'failed', title: 'Failed', body: 'Make a fox', url: '/?open=run:r1', tag: 'run:r1' });
  assert.deepEqual(runEvent(run({ status: 'completed', summary: 'The first words of a private answer', finishedAt: '2026-10-15T12:00:30.000Z' }), 'running'), { kind: 'finished', title: 'Done', body: 'Make a fox', url: '/?open=run:r1', tag: 'run:r1' });
  assert.equal(runEvent(run({ status: 'completed', finishedAt: '2026-10-15T12:00:29.999Z' }), 'running'), null);
  assert.equal(runEvent(run({ status: 'completed', startedAt: null, finishedAt: '2026-10-15T12:05:00.000Z' }), 'queued'), null);
  assert.equal(runEvent(run({ status: 'cancelled' }), 'running'), null);
  assert.equal(runEvent(run({ status: 'running' }), 'queued'), null);
});

test('health: down lists the affected services; recovered replaces it', () => {
  assert.deepEqual(serviceEvent('DOWN', ['Intelligence', 'Web research']), { kind: 'service', title: 'Down: Intelligence, Web research', body: 'Local AI health changed to DOWN', url: '/?open=status', tag: 'service' });
  assert.deepEqual(serviceEvent('HEALTHY', []), { kind: 'service', title: 'Recovered', body: 'All core services are back.', url: '/?open=status', tag: 'service' });
});

test('notices: approvals need you, host failures are failures, the rest nothing', () => {
  assert.deepEqual(noticeEvent('approval', 'Apply change chg-1', 'Two files', 'attention'), { kind: 'needs-you', title: 'Approval needed', body: 'Apply change chg-1', url: '/?open=approvals', tag: 'approval:Apply change chg-1' });
  assert.deepEqual(noticeEvent('deploy', 'Automatic update to abc failed', 'Rolled back', 'attention', { source: 'host' }), { kind: 'failed', title: 'Automatic update to abc failed', body: 'Rolled back', url: '/?open=inbox', tag: 'deploy' });
  assert.equal(noticeEvent('deploy', 'Local AI updated to 2.0.300', '', 'info', { source: 'host' }), null);
  assert.deepEqual(noticeEvent('backup', 'Nightly backup failed', 'disk full', 'attention', { source: 'host' }).kind, 'failed');
  // The app's own health monitor fires for optional companions every 15 minutes; Down/recovered covers outages.
  assert.equal(noticeEvent('monitor', 'Local AI health: attention needed', 'Companion home', 'attention', {}), null);
  assert.equal(noticeEvent('monitor', 'Disk almost full', 'C: 3% free', 'attention', { source: 'host' }).kind, 'failed');
  assert.equal(noticeEvent('issue', 'Quality issues detected', '', 'attention'), null);
});
