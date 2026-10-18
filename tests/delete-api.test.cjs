'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnAppServer } = require('./spawn-server.cjs');
const { once } = require('node:events');

// POST /api/items/delete and /api/items/restore against a server whose runs, Library and projects are seeded first.
async function startServer(t, seed) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-delete-'));
  const { Storage } = require('../app/storage');
  const { RunLedger } = require('../app/run-ledger');
  const storage = new Storage({ dataDir });
  const ids = seed(storage, new RunLedger({ storage }));
  storage.close?.();
  const off = 'http://127.0.0.1:9';
  const { child, ready } = spawnAppServer({ env: { DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, OLLAMA_URL: off, COMFY_URL: off, N8N_URL: off, PROXY_URL: off, SEARXNG_URL: off, MAC_AI_HOME_URL: off, MAC_DSH_URL: off } });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = await ready;
  const post = (url, body, headers = {}) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const get = async url => (await fetch(base + url)).json();
  return { base, post, get, ids };
}

function seed(storage, ledger) {
  const chat = (title, threadId) => { const r = ledger.create({ type: 'chat', title, threadId }); ledger.complete(r.id, { summary: 'ok' }); return r; };
  const first = chat('Plan the garden'), second = chat('And the watering?', first.threadId), other = chat('Unrelated');
  const live = ledger.create({ type: 'change', title: 'Waiting for your OK' }); ledger.update(live.id, { status: 'awaiting_approval' }); // a running run is marked interrupted at startup; one waiting for approval is not
  for (const it of [
    { id: 'lib-garden', kind: 'conversation', title: 'Plan the garden', status: 'saved', kept: true, createdAt: '2026-10-18T10:00:00Z', updatedAt: '2026-10-18T10:00:00Z', meta: { threadId: first.threadId }, data: {} },
    { id: 'lib-note', kind: 'research', title: 'A note', status: 'saved', kept: true, createdAt: '2026-10-18T09:00:00Z', updatedAt: '2026-10-18T09:00:00Z', meta: {}, data: {} }
  ]) storage.upsert('library', it);
  storage.upsert('projects', { id: 'proj-garden', title: 'Garden', name: 'Garden', status: 'active', createdAt: '2026-10-18T08:00:00Z', updatedAt: '2026-10-18T08:00:00Z' });
  ledger.file(other.id, { projectId: 'proj-garden' });
  return { thread: first.threadId, second: second.id, other: other.id, live: live.threadId };
}

test('Delete takes a whole chat out of Work and Library, and Undo brings it back', { timeout: 30000 }, async t => {
  const { post, get, ids } = await startServer(t, seed);
  const runIds = async () => (await get('/api/runs?limit=50')).items.map(x => x.id);
  const libIds = async () => (await get('/api/library')).items.map(x => x.id);
  assert.ok((await runIds()).includes(ids.second));

  const del = await post('/api/items/delete', { items: [{ kind: 'thread', id: ids.thread }] });
  assert.equal(del.status, 200);
  const { trashId, deleted } = await del.json();
  assert.deepEqual(deleted, { runs: 2, library: 1, projects: 0 });
  assert.equal((await runIds()).includes(ids.second), false);
  assert.deepEqual(await libIds(), ['lib-note']);

  const undo = await post('/api/items/restore', { trashId });
  assert.equal(undo.status, 200);
  assert.ok((await runIds()).includes(ids.second));
  assert.deepEqual((await libIds()).sort(), ['lib-garden', 'lib-note']);
  assert.equal((await post('/api/items/restore', { trashId })).status, 404, 'Undo works once');
});

test('Delete refuses a running chat, unknown items, and requests from other sites', { timeout: 30000 }, async t => {
  const { post, base, ids } = await startServer(t, seed);
  const live = await post('/api/items/delete', { items: [{ kind: 'thread', id: ids.live }] });
  assert.equal(live.status, 409);
  assert.match((await live.json()).error, /isn't finished yet\. Stop it first/);
  assert.equal((await post('/api/items/delete', { items: [{ kind: 'thread', id: 'run-nope' }] })).status, 404);
  assert.equal((await post('/api/items/delete', { items: [] })).status, 400);
  assert.equal((await post('/api/items/delete', { items: [{ kind: 'thread', id: ids.thread }] }, { Origin: 'http://evil.example' })).status, 403);
  const form = await fetch(base + '/api/items/delete', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(form.status, 415);
});

test('Deleting a project keeps its chats, under no project; Library items delete on their own', { timeout: 30000 }, async t => {
  const { post, get, ids } = await startServer(t, seed);
  const del = await post('/api/items/delete', { items: [{ kind: 'project', id: 'proj-garden' }, { kind: 'library', id: 'lib-note' }] });
  assert.equal(del.status, 200);
  assert.deepEqual((await del.json()).deleted, { runs: 0, library: 1, projects: 1 });
  const projects = await get('/api/projects');
  assert.equal((projects.items || projects.projects || []).some(p => p.id === 'proj-garden'), false);
  const run = (await get('/api/runs?limit=50')).items.find(x => x.id === ids.other);
  assert.ok(run, 'the chat is still in Work');
  assert.equal(run.projectId ?? null, null);
});
