'use strict';
// One conversation, one name, one Library item (critique §3.1, plan A3; owner decision D10: a conversation keeps its
// first message as its title).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { Storage } = require('../app/storage');
const { RunLedger } = require('../app/run-ledger');
const { continueThread, mergeThreads } = require('../app/library-threads');
const { spawnAppServer } = require('./spawn-server.cjs');

// A stand-in Ollama: /api/chat answers "answer N" for the Nth request.
async function fakeOllama(t, reply = n => `answer ${n}`) {
  let n = 0;
  const s = http.createServer((req, res) => {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url.startsWith('/api/chat')) { n++; return res.end(JSON.stringify({ message: { role: 'assistant', content: reply(n) }, done: true })); }
      if (req.url.startsWith('/api/tags')) return res.end(JSON.stringify({ models: [] }));
      res.end('{}');
    });
  });
  s.listen(0, '127.0.0.1'); await once(s, 'listening');
  t.after(() => s.close());
  return `http://127.0.0.1:${s.address().port}`;
}
async function startServer(t, { seed, ollama } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-threads-'));
  if (seed) { const storage = new Storage({ dataDir }); seed(storage); storage.close?.(); }
  const off = 'http://127.0.0.1:9';
  const { child, ready } = spawnAppServer({
    env: { DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, OLLAMA_URL: ollama || off, SEARXNG_URL: off, COMFY_URL: off, N8N_URL: off, PROXY_URL: off, MAC_AI_HOME_URL: off, MAC_DSH_URL: off }
  });
  t.after(() => { child.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { base: await ready, dataDir };
}
const get = async (base, p) => (await fetch(base + p)).json();
const chat = (base, body) => fetch(base + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
const THREAD = 't-' + 'c3'.repeat(16);

const post = (base, p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));

test('two turns in one thread: one title, "2 turns"; nothing in Library until ☆ Keep, then one item with every turn', async t => {
  const { base } = await startServer(t, { ollama: await fakeOllama(t) });
  await chat(base, { threadId: THREAD, messages: [{ role: 'user', content: 'How do heat pumps work' }] });
  await new Promise(r => setTimeout(r, 20));
  await chat(base, { threadId: THREAD, messages: [{ role: 'user', content: 'How do heat pumps work' }, { role: 'assistant', content: 'answer 1' }, { role: 'user', content: 'And in winter?' }] });

  const rows = (await get(base, '/api/runs?threads=1&limit=20')).items.filter(r => r.threadId === THREAD);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'How do heat pumps work');
  assert.equal(rows[0].card.title, 'How do heat pumps work');
  assert.equal(rows[0].turns, 2);
  assert.equal(rows[0].kept, false, 'a finished chat is not kept by itself');
  // The run header (the latest turn, opened by id) carries the same name.
  const opened = (await get(base, '/api/runs?id=' + encodeURIComponent(rows[0].id))).item;
  assert.equal(opened.threadTitle, 'How do heat pumps work');
  assert.equal(opened.kept, false);

  // Library holds only what you keep (owner decision, 18 Oct): a finished chat stays in Work only.
  assert.deepEqual((await get(base, '/api/library')).items, []);

  // ☆ Keep on the latest turn keeps the whole conversation as one item.
  const kept = await post(base, '/api/library/keep', { runId: rows[0].id, kept: true });
  assert.equal(kept.status, 200); assert.equal(kept.body.kept, true);
  let lib = (await get(base, '/api/library')).items;
  assert.equal(lib.length, 1);
  assert.equal(lib[0].kind, 'conversation');
  assert.equal(lib[0].kept, true);
  assert.equal(lib[0].title, 'How do heat pumps work');
  assert.equal(lib[0].summary, 'answer 2');
  assert.equal(lib[0].meta.threadId, THREAD);
  assert.deepEqual(Object.values(lib[0].data.turns), ['answer 1', 'answer 2'], 'every turn\'s full answer stays readable');
  // Keep again: still one item.
  await post(base, '/api/library/keep', { runId: rows[0].id, kept: true });
  assert.equal((await get(base, '/api/library')).items.length, 1);
  // Every turn of the thread reads as kept.
  assert.ok((await get(base, '/api/runs?threadId=' + THREAD)).items.every(r => r.kept === true));

  // A later turn of a kept conversation updates its item in place and points at it.
  await chat(base, { threadId: THREAD, messages: [{ role: 'user', content: 'How do heat pumps work' }, { role: 'assistant', content: 'answer 2' }, { role: 'user', content: 'And cost?' }] });
  lib = (await get(base, '/api/library')).items;
  assert.equal(lib.length, 1); assert.equal(lib[0].summary, 'answer 3'); assert.equal(Object.keys(lib[0].data.turns).length, 3);
  const latest = (await get(base, '/api/runs?threadId=' + THREAD)).items.find(r => r.summary === 'answer 3');
  assert.deepEqual(latest.artifactIds, [lib[0].id]);

  // Un-keep takes it out of Library, not out of Work.
  const off = await post(base, '/api/library/keep', { runId: rows[0].id, kept: false });
  assert.equal(off.status, 200); assert.equal(off.body.kept, false);
  assert.deepEqual((await get(base, '/api/library')).items, []);
  const runs = (await get(base, '/api/runs?threadId=' + THREAD)).items;
  assert.equal(runs.length, 3); assert.ok(runs.every(r => r.kept === false));
});

test('a chat in a new thread stays out of Library; Keep rejects bad input and non-chat runs', async t => {
  let image;
  const { base } = await startServer(t, { ollama: await fakeOllama(t), seed: s => { image = new RunLedger({ storage: s }).create({ type: 'image', title: 'A lighthouse' }); } });
  const r = await chat(base, { messages: [{ role: 'user', content: 'Reply exactly: EVOLUTION_OK' }] });
  assert.ok(r.runId);
  assert.deepEqual((await get(base, '/api/library')).items, []);
  assert.equal((await post(base, '/api/library/keep', { runId: r.runId })).status, 400, 'kept must be given');
  assert.equal((await post(base, '/api/library/keep', { runId: 'run-none', kept: true })).status, 404);
  assert.equal((await post(base, '/api/library/keep', { runId: image.id, kept: true })).status, 409);
  assert.equal((await post(base, '/api/library/keep', { runId: r.runId, kept: true })).body.item.title, 'Reply exactly: EVOLUTION_OK');
});

test('an answer too long for the run stays readable by run id without being kept', async t => {
  const LONG = 'a long answer '.repeat(2500);   // ~35 KB: the run ledger keeps only a preview
  const { base } = await startServer(t, { ollama: await fakeOllama(t, () => LONG) });
  const r = await chat(base, { messages: [{ role: 'user', content: 'Tell me everything' }] });
  const run = (await get(base, '/api/runs?id=' + r.runId)).item;
  assert.equal(run.output.truncated, true);
  assert.deepEqual((await get(base, '/api/library')).items, []);
  assert.equal((await get(base, '/api/runs/answers?ids=' + r.runId)).answers[r.runId], LONG);
  // Keep files the full answer in the Library item too.
  const kept = await post(base, '/api/library/keep', { runId: r.runId, kept: true });
  assert.equal(kept.body.item.data.turns[r.runId], LONG);
  assert.equal((await fetch(base + '/api/runs/answers?ids=not%20an%20id')).status, 400);
});

test('repair:library-threads-v1 merges per-turn duplicates by thread, keeping the oldest item\'s id; runs once', async t => {
  let runA, runB, runC;
  const { base } = await startServer(t, { seed: s => {
    s.writeSetting('repair:library-kept-v1', { completedAt: 'earlier', moved: 0 });   // this test is about merging; the kept-only repair has its own tests
    const ledger = new RunLedger({ storage: s });
    runA = ledger.create({ type: 'chat', title: 'Plan a garden', threadId: THREAD });
    runB = ledger.create({ type: 'chat', title: 'What about shade', threadId: THREAD });
    runC = ledger.create({ type: 'chat', title: 'Alone', threadId: 't-' + 'd4'.repeat(16) });
    const item = (id, title, summary, runId, at) => ({ id, kind: 'conversation', title, summary, createdAt: at, pinned: false, meta: { runId }, data: { prompt: title, response: summary } });
    s.put('library', item('lib-c', 'Alone', 'only answer', runC.id, '2026-10-01T00:00:03.000Z'), 0);
    s.put('library', item('lib-b', 'What about shade', 'second answer', runB.id, '2026-10-01T00:00:02.000Z'), 1);
    s.put('library', item('lib-a', 'Plan a garden', 'first answer', runA.id, '2026-10-01T00:00:01.000Z'), 2);
    s.put('library', { id: 'lib-img', kind: 'image', title: 'A lighthouse', summary: '', createdAt: '2026-10-01T00:00:00.000Z', pinned: false, meta: {}, data: {} }, 3);
  } });
  const lib = (await get(base, '/api/library')).items;
  assert.deepEqual(lib.map(i => i.id).sort(), ['lib-a', 'lib-c', 'lib-img']);
  const a = lib.find(i => i.id === 'lib-a');
  assert.equal(a.title, 'Plan a garden');
  assert.equal(a.summary, 'second answer');
  assert.equal(a.meta.threadId, THREAD);
  assert.deepEqual(a.data.turns, { [runA.id]: 'first answer', [runB.id]: 'second answer' });
  assert.equal(lib.find(i => i.id === 'lib-c').summary, 'only answer');
});

test('continueThread updates the thread\'s item; mergeThreads leaves other kinds alone', () => {
  const items = [{ id: 'x', kind: 'conversation', title: 'First', summary: 'a1', meta: { threadId: 't1', runId: 'r1' }, data: { response: 'a1', turns: { r1: 'a1' } } }];
  const next = continueThread(items, { threadId: 't1', runId: 'r2', summary: 'a2', data: { prompt: 'Second', response: 'a2' }, now: 'now' });
  assert.equal(next.id, 'x'); assert.equal(next.title, 'First'); assert.equal(next.summary, 'a2');
  assert.deepEqual(next.data.turns, { r1: 'a1', r2: 'a2' });
  assert.equal(continueThread(items, { threadId: 't2', runId: 'r3' }), null);
  const { items: out, merged } = mergeThreads([{ id: 'i', kind: 'image' }, ...items], () => 't1');
  assert.equal(merged, 0); assert.equal(out.length, 2);
});
