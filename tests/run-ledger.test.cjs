'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RunLedger, isKept } = require('../app/run-ledger');

class MemorySettings {
  constructor() { this.values = new Map(); }
  readSetting(key, fallback) { return this.values.has(key) ? JSON.parse(JSON.stringify(this.values.get(key))) : fallback; }
  writeSetting(key, value) { this.values.set(key, JSON.parse(JSON.stringify(value))); }
  deleteSetting(key) { this.values.delete(key); }
  prefixed(prefix) { return [...this.values.keys()].filter(k => k.startsWith(prefix)).sort().reverse(); }
  listSettings(prefix, { limit, where = {} } = {}) {
    return this.prefixed(prefix).map(k => this.readSetting(k))
      .filter(v => Object.entries(where).every(([f, x]) => String(v[f]) === String(x))).slice(0, limit ?? Infinity);
  }
  pruneSettings(prefix, keep, { exempt = {} } = {}) {
    const isExempt = v => (exempt.truthy || []).some(p => { const x = v[p.slice(2)]; return x != null && x !== '' && x !== 0 && x !== false && x !== 'false'; })
      || (exempt.nonEmptyArray || []).some(p => Array.isArray(v[p.slice(2)]) && v[p.slice(2)].length > 0);
    const drop = this.prefixed(prefix).filter(k => !isExempt(this.values.get(k))).slice(keep);
    drop.forEach(k => this.values.delete(k)); return drop.length;
  }
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

test('runs live in one settings row each and the legacy single-row ledger is migrated once', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { Storage } = require('../app/storage');
  const { RUN_LEDGER_KEY, RUN_KEY_PREFIX } = require('../app/run-ledger');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-ledger-'));
  const storage = new Storage({ dataDir });
  try {
    const legacy = [
      { id: 'run-1700000000002-bbbbbbb', type: 'chat', title: 'newer', status: 'streaming', events: [] },
      { id: 'run-1700000000001-aaaaaaa', type: 'image', title: 'older', status: 'completed', events: [] }
    ];
    storage.writeSetting(RUN_LEDGER_KEY, legacy);
    const ledger = new RunLedger({ storage, maxRuns: 20 });
    assert.equal(storage.readSetting(RUN_LEDGER_KEY, null), null, 'legacy row removed after migration');
    assert.deepEqual(ledger.list().map(r => r.title), ['newer', 'older']);
    assert.equal(ledger.get('run-1700000000002-bbbbbbb').status, 'failed', 'interrupted legacy run reconciled');
    assert.deepEqual(ledger.list({ type: 'image' }).map(r => r.title), ['older']);
    const fresh = ledger.create({ type: 'chat', title: 'fresh' });
    assert.equal(ledger.list({ limit: 1 })[0].id, fresh.id, 'new runs sort first');
    assert.equal(ledger.list({ status: 'queued' })[0].id, fresh.id);
    for (let i = 0; i < 25; i++) ledger.create({ type: 'chat', title: `bulk ${i}` });
    assert.equal(storage.listSettings(RUN_KEY_PREFIX).length, 20, 'pruned to maxRuns');
    ledger.update(ledger.list({ limit: 1 })[0].id, { status: 'running' });
    assert.equal(storage.readSetting('status', 'untouched'), 'untouched', 'other settings unaffected');
    new RunLedger({ storage, maxRuns: 20 });
    assert.equal(storage.listSettings(RUN_KEY_PREFIX, { where: { status: 'running' } }).length, 0, 'restart reconciles per-row runs');
  } finally { storage.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('run carries projectId, threadId and pinned', () => {
  const ledger = new RunLedger({ storage: new MemorySettings() });
  const a = ledger.create({ projectId: 'proj-1', threadId: 't-1' });
  assert.equal(a.projectId, 'proj-1'); assert.equal(a.threadId, 't-1'); assert.equal(a.pinned, false);
  const b = ledger.create({});
  assert.equal(b.projectId, null); assert.equal(b.threadId, b.id); assert.equal(b.pinned, false);
});

test('bad ids are not stored', () => {
  const ledger = new RunLedger({ storage: new MemorySettings() });
  assert.equal(ledger.create({ projectId: '../x' }).projectId, null);
  const long = ledger.create({ threadId: 'a'.repeat(200) });
  assert.equal(long.threadId, long.id);
  const obj = ledger.create({ threadId: {} });
  assert.equal(obj.threadId, obj.id);
});

test('file() pins and files; null unfiles', () => {
  const ledger = new RunLedger({ storage: new MemorySettings() });
  const run = ledger.create({});
  assert.equal(ledger.file(run.id, { pinned: true }).pinned, true);
  const filed = ledger.file(run.id, { projectId: 'p' });
  assert.equal(filed.projectId, 'p'); assert.equal(filed.pinned, true);
  assert.equal(ledger.file(run.id, { projectId: null }).projectId, null);
  assert.equal(ledger.file('nope', { pinned: true }), null);
});

test('pinned and filed runs survive pruning; an artifact-only run does not', () => {
  const ledger = new RunLedger({ storage: new MemorySettings(), maxRuns: 20 });
  const kept = Array.from({ length: 4 }, () => ledger.create({}));
  const withArtifact = ledger.create({});
  ledger.file(kept[0].id, { pinned: true }); ledger.file(kept[1].id, { pinned: true });
  ledger.file(kept[2].id, { projectId: 'p' }); ledger.file(kept[3].id, { projectId: 'p' });
  ledger.complete(withArtifact.id, { artifactIds: ['a1'] });
  for (let i = 0; i < 30; i++) ledger.create({});
  for (const r of kept) assert.ok(ledger.get(r.id), 'kept run ' + r.id);
  assert.equal(ledger.get(withArtifact.id), null, 'artifact-only run aged out');
  const keptIds = new Set(kept.map(r => r.id));
  assert.equal(ledger.list({ limit: 500 }).filter(r => !keptIds.has(r.id)).length, 20);
});

test('isKept is pinned or filed only', () => {
  assert.equal(isKept({ artifactIds: ['a'] }), false);
  assert.equal(isKept({ pinned: true }), true);
  assert.equal(isKept({ projectId: 'p' }), true);
  assert.equal(isKept(null), false);
});

test('list filters and collapses threads', () => {
  const ledger = new RunLedger({ storage: new MemorySettings() });
  ledger.create({ threadId: 't' }); ledger.create({ threadId: 't' });
  const t3 = ledger.create({ threadId: 't' }); const u = ledger.create({ threadId: 'u' });
  assert.equal(ledger.list({ threadId: 't' }).length, 3);
  const collapsed = ledger.list({ collapseThreads: true });
  assert.equal(collapsed.length, 2);
  assert.deepEqual(collapsed.map(r => r.id), [u.id, t3.id]);
  assert.equal(ledger.list({ collapseThreads: true, limit: 1 }).length, 1);
  assert.equal(ledger.list({ projectId: 'zzz' }).length, 0);
});

test('onTransition fires once per status change and never breaks update', () => {
  const storage = new MemorySettings();
  const seen = [];
  const ledger = new RunLedger({ storage, onTransition: (run, previous) => seen.push([run.status, previous]) });
  const run = ledger.create({ type: 'chat', title: 'x' });
  ledger.start(run.id);
  ledger.update(run.id, { progress: 50 });
  ledger.complete(run.id, { summary: 'done' });
  assert.deepEqual(seen, [['running', 'queued'], ['completed', 'running']]);
  const throwing = new RunLedger({ storage: new MemorySettings(), onTransition: () => { throw new Error('boom'); } });
  const r2 = throwing.create({ type: 'chat', title: 'y' });
  assert.equal(throwing.start(r2.id).status, 'running');
});
