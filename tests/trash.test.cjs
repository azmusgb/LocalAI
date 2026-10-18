'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RunLedger } = require('../app/run-ledger');
const { Trash, KEEP_MS } = require('../app/trash');

// The run ledger's settings, kept in memory (as tests/run-ledger.test.cjs does).
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
  pruneSettings() { return 0; }
}

function setup() {
  const settings = new MemorySettings();
  const ledger = new RunLedger({ storage: settings });
  const data = { library: [], projects: [], conversations: [], knowledge: [], memory: [] };
  const collections = { get: name => JSON.parse(JSON.stringify(data[name])), set: (name, items) => { data[name] = JSON.parse(JSON.stringify(items)); } };
  let clock = Date.parse('2026-10-18T12:00:00Z');
  const kept = [];
  const trash = new Trash({ settings, ledger, collections, now: () => clock, beforeLibraryRemove: it => kept.push(it.id) });
  const chat = (threadId, title) => { const r = ledger.create({ type: 'chat', title, threadId }); ledger.complete(r.id, { summary: 'ok' }); return ledger.get(r.id); };
  return { settings, ledger, data, trash, chat, kept, tick: ms => { clock += ms; } };
}
const ids = items => items.map(x => x.id);

test('deleting a chat removes every turn of its thread and what Library holds for it', () => {
  const { ledger, data, trash, chat } = setup();
  const first = chat(null, 'Plan the garden');
  const second = chat(first.threadId, 'And the watering?');
  const other = chat(null, 'Unrelated');
  data.library = [
    { id: 'lib-thread', kind: 'conversation', meta: { threadId: first.threadId } },
    { id: 'lib-image', kind: 'image', meta: { runId: second.id } },
    { id: 'lib-other', kind: 'conversation', meta: { threadId: other.threadId } }
  ];
  const out = trash.delete([{ kind: 'thread', id: first.threadId }]);
  assert.ok(out.trashId);
  assert.deepEqual(out.deleted, { runs: 2, library: 2, projects: 0 });
  assert.equal(ledger.get(first.id), null);
  assert.equal(ledger.get(second.id), null);
  assert.ok(ledger.get(other.id), 'other chats stay');
  assert.deepEqual(ids(data.library), ['lib-other']);
});

test('Undo puts every run and Library item back where it was', () => {
  const { ledger, data, trash, chat } = setup();
  const run = chat(null, 'Plan the garden');
  data.library = [{ id: 'a', kind: 'note' }, { id: 'lib-thread', kind: 'conversation', meta: { threadId: run.threadId } }, { id: 'b', kind: 'note' }];
  const before = ledger.get(run.id);
  const { trashId } = trash.delete([{ kind: 'thread', id: run.threadId }]);
  data.library.unshift({ id: 'new', kind: 'note' }); // something added meanwhile stays
  const back = trash.restore(trashId);
  assert.deepEqual(back.restored, { runs: 1, library: 1, projects: 0 });
  assert.deepEqual(ledger.get(run.id), before);
  assert.deepEqual(ids(data.library), ['new', 'a', 'lib-thread', 'b']);
  assert.throws(() => trash.restore(trashId), e => e.status === 404, 'Undo only once');
});

test('a chat that is still running cannot be deleted, and nothing changes', () => {
  const { ledger, data, trash } = setup();
  const live = ledger.create({ type: 'chat', title: 'Still answering' });
  ledger.start(live.id);
  data.library = [{ id: 'x', kind: 'conversation', meta: { threadId: live.threadId } }];
  assert.throws(() => trash.delete([{ kind: 'thread', id: live.threadId }]), e => e.status === 409 && /Stop it first/.test(e.message));
  assert.ok(ledger.get(live.id));
  assert.deepEqual(ids(data.library), ['x']);
});

test('unknown items are refused; several items in one call share one Undo', () => {
  const { data, trash, chat } = setup();
  assert.throws(() => trash.delete([{ kind: 'thread', id: 'run-nope' }]), e => e.status === 404);
  assert.throws(() => trash.delete([{ kind: 'thread', id: 'legacy-agent:1' }]), e => e.status === 409);
  assert.throws(() => trash.delete([{ kind: 'mystery', id: 'x' }]), e => e.status === 400);
  assert.throws(() => trash.delete([]), e => e.status === 400);
  const a = chat(null, 'A'), b = chat(null, 'B');
  data.library = [{ id: 'note', kind: 'note' }];
  const out = trash.delete([{ kind: 'thread', id: a.threadId }, { kind: 'thread', id: b.threadId }, { kind: 'library', id: 'note' }]);
  assert.deepEqual(out.deleted, { runs: 2, library: 1, projects: 0 });
  assert.deepEqual(trash.restore(out.trashId).restored, { runs: 2, library: 1, projects: 0 });
});

test('deleting a Library item leaves its runs in Work, and keeps their long answers first', () => {
  const { ledger, data, trash, chat, kept } = setup();
  const run = chat(null, 'Kept chat');
  data.library = [{ id: 'lib-thread', kind: 'conversation', meta: { threadId: run.threadId } }];
  trash.delete([{ kind: 'library', id: 'lib-thread' }]);
  assert.deepEqual(data.library, []);
  assert.ok(ledger.get(run.id), 'the chat stays in Work');
  assert.deepEqual(kept, ['lib-thread']);
});

test('deleting a project moves its work to no project; Undo files it again', () => {
  const { ledger, data, trash, chat } = setup();
  data.projects = [{ id: 'p1', name: 'Garden' }, { id: 'p2', name: 'Other' }];
  const run = chat(null, 'Filed chat');
  ledger.file(run.id, { projectId: 'p1' });
  data.conversations = [{ id: 'c1', projectId: 'p1' }, { id: 'c2', projectId: 'p2' }];
  data.knowledge = [{ id: 'k1', projectId: 'p1' }];
  data.memory = [{ id: 'm1', projectId: 'p1' }];
  const out = trash.delete([{ kind: 'project', id: 'p1' }]);
  assert.deepEqual(out.deleted, { runs: 0, library: 0, projects: 1 });
  assert.deepEqual(ids(data.projects), ['p2']);
  assert.equal(ledger.get(run.id).projectId ?? null, null);
  assert.deepEqual(data.conversations.map(x => x.projectId ?? null), [null, 'p2']);
  assert.equal(data.knowledge[0].projectId ?? null, null);
  assert.equal(data.memory[0].projectId ?? null, null);
  trash.restore(out.trashId);
  assert.deepEqual(ids(data.projects), ['p1', 'p2']);
  assert.equal(ledger.get(run.id).projectId, 'p1');
  assert.deepEqual(data.conversations.map(x => x.projectId), ['p1', 'p2']);
  assert.equal(data.knowledge[0].projectId, 'p1');
  assert.equal(data.memory[0].projectId, 'p1');
});

test('after a day the trash is emptied for good, and Undo is no longer possible', () => {
  const { trash, chat, tick, settings } = setup();
  const old = trash.delete([{ kind: 'thread', id: chat(null, 'Old').threadId }]);
  tick(KEEP_MS - 1000);
  const recent = trash.delete([{ kind: 'thread', id: chat(null, 'Recent').threadId }]);
  tick(2000);
  assert.equal(trash.purge(), 1);
  assert.throws(() => trash.restore(old.trashId), e => e.status === 404);
  assert.ok(trash.restore(recent.trashId));
  assert.equal([...settings.values.keys()].filter(k => k.startsWith('trash/')).length, 0);
});
