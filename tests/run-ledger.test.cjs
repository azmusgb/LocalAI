'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RunLedger } = require('../app/run-ledger');

class MemorySettings {
  constructor() { this.values = new Map(); }
  readSetting(key, fallback) { return this.values.has(key) ? JSON.parse(JSON.stringify(this.values.get(key))) : fallback; }
  writeSetting(key, value) { this.values.set(key, JSON.parse(JSON.stringify(value))); }
}

test('run lifecycle is durable and normalized', () => {
  const storage = new MemorySettings();
  const ledger = new RunLedger({ storage });
  const created = ledger.create({
    type: 'chat',
    title: 'Explain status',
    input: { prompt: 'Explain status' },
    cancellable: true,
    retryRequest: { path: '/api/chat', body: { messages: [{ role: 'user', content: 'Explain status' }] } }
  });

  assert.equal(created.status, 'queued');
  assert.equal(created.retryable, false);
  assert.equal(created.cancellable, true);

  const started = ledger.start(created.id);
  assert.equal(started.status, 'running');
  assert.ok(started.startedAt);

  const streaming = ledger.stream(created.id);
  assert.equal(streaming.status, 'streaming');

  const completed = ledger.complete(created.id, { summary: 'Done', output: { text: 'OK' }, artifactIds: ['artifact-1'] });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.progress, 100);
  assert.equal(completed.retryable, true);
  assert.equal(completed.cancellable, false);
  assert.deepEqual(completed.artifactIds, ['artifact-1']);

  const reloaded = new RunLedger({ storage }).get(created.id);
  assert.equal(reloaded.status, 'completed');
  assert.equal(reloaded.summary, 'Done');
  assert.equal(Object.hasOwn(reloaded, 'retryRequest'), false);
});

test('terminal runs cannot be moved back into an active status', () => {
  const ledger = new RunLedger({ storage: new MemorySettings() });
  const run = ledger.create({ type: 'task', title: 'Task' });
  ledger.start(run.id);
  ledger.fail(run.id, new Error('boom'));
  const unchanged = ledger.update(run.id, { status: 'running' }, 'should not restart');
  assert.equal(unchanged.status, 'failed');
  assert.equal(unchanged.error, 'boom');
});

test('cancel and retry contracts are explicit', () => {
  const ledger = new RunLedger({ storage: new MemorySettings() });
  const withoutRetry = ledger.create({ type: 'image', title: 'Image', cancellable: true });
  assert.equal(ledger.cancel(withoutRetry.id, 'stop').status, 'cancelled');
  assert.equal(ledger.retryRequest(withoutRetry.id), null);

  const retryable = ledger.create({
    type: 'automation', title: 'Health check',
    retryRequest: { path: '/api/automations/run', body: { id: 'auto-1' } }
  });
  ledger.start(retryable.id);
  ledger.complete(retryable.id);
  assert.deepEqual(ledger.retryRequest(retryable.id), { path: '/api/automations/run', body: { id: 'auto-1' } });
});

test('constructor fails interrupted active runs after appliance restart but preserves approval waits', () => {
  const storage = new MemorySettings();
  const first = new RunLedger({ storage });
  const queued = first.create({ type: 'chat', title: 'Queued', cancellable: true });
  const running = first.create({ type: 'chat', title: 'Running', cancellable: true });
  first.start(running.id);
  const streaming = first.create({ type: 'chat', title: 'Streaming', cancellable: true });
  first.start(streaming.id);
  first.stream(streaming.id);
  const waiting = first.create({ type: 'engineering', title: 'Waiting for approval' });
  first.update(waiting.id, { status: 'awaiting_approval', progress: 65 }, 'Human approval required');

  const restarted = new RunLedger({ storage });
  for (const id of [queued.id, running.id, streaming.id]) {
    const run = restarted.get(id);
    assert.equal(run.status, 'failed');
    assert.match(run.error, /interrupted by appliance restart/i);
    assert.ok(run.finishedAt);
    assert.equal(run.cancellable, false);
    assert.ok(run.events.some(event => event.status === 'failed' && /appliance restart/i.test(event.detail)));
  }
  assert.equal(restarted.get(waiting.id).status, 'awaiting_approval');
});

test('oversized durable payloads are bounded instead of growing the settings row indefinitely', () => {
  const ledger = new RunLedger({ storage: new MemorySettings() });
  const huge = 'x'.repeat(80 * 1024);
  const run = ledger.create({
    type: 'chat',
    title: 'Large run',
    input: { prompt: huge },
    retryRequest: { path: '/api/chat', body: { prompt: huge } },
    meta: { detail: huge }
  });
  assert.deepEqual(run.input, { truncated: true });
  assert.deepEqual(run.meta, { truncated: true });
  assert.equal(run.retryable, false);

  const completed = ledger.complete(run.id, { output: { text: huge } });
  assert.equal(completed.output.truncated, true);
  assert.ok(completed.output.preview.length <= 12000);
  assert.equal(completed.retryable, false, 'oversized retry payloads are deliberately not persisted');
});

test('ledger keeps newest runs within its configured bound', () => {
  const storage = new MemorySettings();
  const ledger = new RunLedger({ storage, maxRuns: 20 });
  for (let i = 0; i < 25; i++) ledger.create({ type: 'task', title: `Task ${i}` });
  const runs = ledger.list({ limit: 100 });
  assert.equal(runs.length, 20);
  assert.equal(runs[0].title, 'Task 24');
});
