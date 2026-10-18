'use strict';
// Library holds only what you keep (owner decision, 18 Oct). The one-time repair repair:library-kept-v1 takes the
// chats and research that were saved to Library by themselves out of it: kept, pinned and project items stay, images
// stay, runs and threads are untouched (so all of them are still in Work), and a backup makes it reversible.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { Storage } = require('../app/storage');
const { RunLedger } = require('../app/run-ledger');
const { splitKept, staysInLibrary } = require('../app/library-threads');
const { spawnAppServer } = require('./spawn-server.cjs');

const off = 'http://127.0.0.1:9';
const ENV = { OLLAMA_URL: off, SEARXNG_URL: off, COMFY_URL: off, N8N_URL: off, PROXY_URL: off, MAC_AI_HOME_URL: off, MAC_DSH_URL: off };
async function boot(t, dataDir) {
  const { child, ready } = spawnAppServer({ env: { ...ENV, DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir } });
  t.after(() => child.kill());
  const base = await ready;
  return { base, stop: async () => { if (child.exitCode === null) { child.kill(); await once(child, 'exit'); } } };
}
const tempDir = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-kept-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
function withStorage(dataDir, fn) { const s = new Storage({ dataDir }); try { return fn(s); } finally { s.close(); } }
const get = async (base, p) => (await fetch(base + p)).json();
const item = (id, kind, extra = {}) => ({ id, kind, title: id, summary: '', createdAt: '2026-10-01T00:00:00.000Z', pinned: false, meta: {}, data: {}, ...extra });
const LONG = 'long answer '.repeat(3000);   // ~36 KB: more than the run ledger keeps

function seed(dataDir) {
  return withStorage(dataDir, s => {
    const ledger = new RunLedger({ storage: s });
    const run = (type, title) => ledger.create({ type, title });
    const auto = run('chat', 'Reply exactly: EVOLUTION_OK'), research = run('research', 'Heat pumps'), filed = run('chat', 'Filed one');
    const pinnedRun = run('chat', 'Pinned in Work'), long = run('chat', 'A long one');
    ledger.complete(auto.id, { summary: 'EVOLUTION_OK', output: { text: 'EVOLUTION_OK' } });
    ledger.complete(long.id, { summary: 'long', output: { text: LONG } });
    ledger.file(filed.id, { projectId: 'proj-garden' });
    ledger.file(pinnedRun.id, { pinned: true });
    const items = [
      item('auto', 'conversation', { meta: { runId: auto.id, threadId: auto.threadId }, data: { response: 'EVOLUTION_OK', turns: { [auto.id]: 'EVOLUTION_OK' } } }),
      item('research', 'research', { meta: { runId: research.id } }),
      item('legacy', 'conversation'),   // an old item with no run at all
      item('long', 'conversation', { meta: { runId: long.id }, data: { response: LONG, turns: { [long.id]: LONG } } }),
      item('pinned', 'conversation', { pinned: true }),
      item('project', 'conversation', { meta: { projectId: 'proj-garden' } }),
      item('filed-run', 'conversation', { meta: { runId: filed.id } }),
      item('pinned-run', 'conversation', { meta: { runId: pinnedRun.id } }),
      item('kept', 'research', { kept: true }),
      item('image', 'image', { meta: { imageUrl: '/generated/a.png' } })
    ];
    items.forEach((it, i) => s.put('library', it, i));
    return { auto, research, long };
  });
}

test('staysInLibrary: kept, pinned and project chats stay; auto-saved chats and research leave; other kinds stay', () => {
  assert.equal(staysInLibrary(item('a', 'conversation')), false);
  assert.equal(staysInLibrary(item('a', 'research')), false);
  assert.equal(staysInLibrary(item('a', 'conversation', { kept: true })), true);
  assert.equal(staysInLibrary(item('a', 'conversation', { pinned: true })), true);
  assert.equal(staysInLibrary(item('a', 'conversation', { projectId: 'p' })), true);
  assert.equal(staysInLibrary(item('a', 'conversation'), () => true), true);
  assert.equal(staysInLibrary(item('a', 'image')), true);
  const { keep, moved } = splitKept([item('x', 'image'), item('y', 'conversation')]);
  assert.deepEqual([keep.map(i => i.id), moved.map(i => i.id)], [['x'], ['y']]);
});

test('repair:library-kept-v1 moves auto-saved chats out of Library, keeps the rest, backs them up and runs once', async t => {
  const dataDir = tempDir(t);
  const runs = seed(dataDir);
  let server = await boot(t, dataDir);

  const lib = (await get(server.base, '/api/library')).items.map(i => i.id).sort();
  assert.deepEqual(lib, ['filed-run', 'image', 'kept', 'pinned', 'pinned-run', 'project']);

  // Runs and threads are untouched: every moved chat is still in Work.
  const work = (await get(server.base, '/api/runs?limit=50')).items;
  for (const r of [runs.auto, runs.research, runs.long]) assert.ok(work.some(w => w.id === r.id), `${r.title} is still in Work`);
  assert.equal(work.find(w => w.id === runs.auto.id).kept, false);
  // A long answer that lived only in Library stays readable from its run.
  assert.equal((await get(server.base, '/api/runs/answers?ids=' + runs.long.id)).answers[runs.long.id], LONG);

  // The Audit log says what happened.
  const audit = (await get(server.base, '/api/activity')).items.filter(a => /^Library: /.test(a.title));
  assert.deepEqual(audit.map(a => a.title), ["Library: 4 auto-saved chats moved out; they're still in Work"]);
  await server.stop();

  // The backup holds the removed records whole, and the repair is recorded as done.
  const { done, backup } = withStorage(dataDir, s => {
    s.put('library', item('later-auto', 'conversation'), 0);   // seeded after the repair: a second start must leave it
    return { done: s.readSetting('repair:library-kept-v1', null), backup: s.readSetting('backup:library-kept-v1', null) };
  });
  assert.equal(done.moved, 4);
  assert.deepEqual(backup.ids.sort(), ['auto', 'legacy', 'long', 'research']);
  assert.equal(backup.items.find(i => i.id === 'long').data.turns[runs.long.id], LONG);

  server = await boot(t, dataDir);
  assert.ok((await get(server.base, '/api/library')).items.some(i => i.id === 'later-auto'), 'a second start does nothing');
  assert.equal((await get(server.base, '/api/activity')).items.filter(a => /^Library: /.test(a.title)).length, 1);
  await server.stop();
  assert.deepEqual(withStorage(dataDir, s => s.readSetting('backup:library-kept-v1', null)).ids.sort(), backup.ids.sort());
});

test('repair:library-kept-v1 on a fresh install: nothing to move, no Audit line, no backup', async t => {
  const dataDir = tempDir(t);
  const server = await boot(t, dataDir);
  assert.deepEqual((await get(server.base, '/api/library')).items, []);
  assert.equal((await get(server.base, '/api/activity')).items.filter(a => /^Library: /.test(a.title)).length, 0);
  await server.stop();
  withStorage(dataDir, s => {
    assert.equal(s.readSetting('repair:library-kept-v1', null).moved, 0);
    assert.equal(s.readSetting('backup:library-kept-v1', null), null);
  });
});
