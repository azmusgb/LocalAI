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
async function fakeOllama(t) {
  let n = 0;
  const s = http.createServer((req, res) => {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url.startsWith('/api/chat')) { n++; return res.end(JSON.stringify({ message: { role: 'assistant', content: `answer ${n}` }, done: true })); }
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

test('two turns in one thread: one title (the first message), "2 turns", one Library item with the latest answer', async t => {
  const { base } = await startServer(t, { ollama: await fakeOllama(t) });
  await chat(base, { threadId: THREAD, messages: [{ role: 'user', content: 'How do heat pumps work' }] });
  await new Promise(r => setTimeout(r, 20));
  await chat(base, { threadId: THREAD, messages: [{ role: 'user', content: 'How do heat pumps work' }, { role: 'assistant', content: 'answer 1' }, { role: 'user', content: 'And in winter?' }] });

  const rows = (await get(base, '/api/runs?threads=1&limit=20')).items.filter(r => r.threadId === THREAD);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'How do heat pumps work');
  assert.equal(rows[0].card.title, 'How do heat pumps work');
  assert.equal(rows[0].turns, 2);
  // The run header (the latest turn, opened by id) carries the same name.
  const opened = (await get(base, '/api/runs?id=' + encodeURIComponent(rows[0].id))).item;
  assert.equal(opened.threadTitle, 'How do heat pumps work');

  const lib = (await get(base, '/api/library')).items.filter(i => i.kind === 'conversation');
  assert.equal(lib.length, 1);
  assert.equal(lib[0].title, 'How do heat pumps work');
  assert.equal(lib[0].summary, 'answer 2');
  assert.equal(Object.keys(lib[0].data.turns).length, 2, 'every turn\'s full answer stays readable');
  // Both runs point at the same Library item.
  const runs = (await get(base, '/api/runs?threadId=' + THREAD)).items;
  assert.deepEqual([...new Set(runs.flatMap(r => r.artifactIds))], [lib[0].id]);
});

test('repair:library-threads-v1 merges per-turn duplicates by thread, keeping the oldest item\'s id; runs once', async t => {
  let runA, runB, runC;
  const { base } = await startServer(t, { seed: s => {
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
