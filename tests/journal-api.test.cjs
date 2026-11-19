'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { spawnAppServer } = require('./spawn-server.cjs');

test('finished chats are searchable through /api/journal and can be deleted', { timeout: 30000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-journal-api-'));
  const mock = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'test-model' }] }));
      if (req.url === '/api/ps') return res.end(JSON.stringify({ models: [] }));
      res.end(JSON.stringify({ message: { content: 'Use PETG for the bracket.' } }));
    });
  });
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  const off = 'http://127.0.0.1:9';
  const { child, ready } = spawnAppServer({
    env: { DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, OLLAMA_URL: `http://127.0.0.1:${mock.address().port}`, MODEL: 'test-model',
      COMFY_URL: off, N8N_URL: off, PROXY_URL: off, SEARXNG_URL: off, MAC_AI_HOME_URL: off, MAC_DSH_URL: off, LOCALAI_PI_HUB_URL: 'off' }
  });
  t.after(async () => {
    if (child.exitCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
    mock.closeAllConnections(); await new Promise(r => mock.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = await ready;
  const get = async q => { const r = await fetch(`${base}/api/journal${q}`); assert.equal(r.status, 200); return r.json(); };
  const del = id => fetch(`${base}/api/journal/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });

  const chat = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'Which filament for a shelf bracket?' }] }) });
  assert.equal(chat.status, 200);

  const found = await get('?q=bracket');
  assert.equal(found.items.length, 1);
  assert.equal(found.items[0].source, 'run');
  assert.match(found.items[0].body, /PETG/);
  assert.match(found.items[0].link, /^#run\/run-/);
  assert.equal((await get('?q=bracket&source=print')).items.length, 0);
  assert.equal((await get('?limit=999&from=not-a-date')).items.length >= 1, true);

  const r = await del(found.items[0].id);
  assert.equal(r.status, 200);
  assert.equal((await get('?q=bracket')).items.length, 0);
  assert.equal((await del(found.items[0].id)).status, 404);
  assert.equal((await del('')).status, 404);
});

// Past work (POST /api/journal/ask): the question is checked before any run exists; a run answers from the journal
// with citations, on this PC; a model that fails leaves a failed run with the entries it read.
test('POST /api/journal/ask: 400 for no question, one run that answers with citations, a failed run keeps its entries', { timeout: 30000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-journal-ask-api-'));
  let mode = 'chat';
  const asked = [];
  const mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'test-model' }] }));
      if (req.url === '/api/ps') return res.end(JSON.stringify({ models: [] }));
      const sent = body ? JSON.parse(body) : {};
      const system = sent.messages?.[0]?.content || '';
      if (/Answer only from the numbered entries/.test(system)) {
        asked.push(sent);
        if (mode === 'fail') { res.statusCode = 500; return res.end('model crashed'); }
        return res.end(JSON.stringify({ message: { content: 'You asked which filament suits a bracket: PETG [1] [9].' } }));
      }
      res.end(JSON.stringify({ message: { content: 'Use PETG for the bracket.' } }));
    });
  });
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  const off = 'http://127.0.0.1:9';
  const { child, ready } = spawnAppServer({
    env: { DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, OLLAMA_URL: `http://127.0.0.1:${mock.address().port}`, MODEL: 'test-model',
      COMFY_URL: off, N8N_URL: off, PROXY_URL: off, SEARXNG_URL: off, MAC_AI_HOME_URL: off, MAC_DSH_URL: off, LOCALAI_PI_HUB_URL: 'off' }
  });
  t.after(async () => {
    if (child.exitCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
    mock.closeAllConnections(); await new Promise(r => mock.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = await ready;
  const ask = body => fetch(`${base}/api/journal/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const finished = async id => {
    for (let i = 0; i < 100; i++) {
      const { item } = await (await fetch(`${base}/api/runs?id=${encodeURIComponent(id)}`)).json();
      if (['completed', 'failed'].includes(item?.status)) return item;
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('the run did not finish');
  };
  const runsNow = async () => (await (await fetch(`${base}/api/runs?limit=500`)).json()).items.length;

  for (const body of [{}, { question: '' }, { question: '   ' }, { question: 42 }, { question: 'x'.repeat(501) }]) {
    const r = await ask(body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 40));
    assert.ok((await r.json()).error);
  }
  assert.equal(await runsNow(), 0, 'a refused question starts nothing');

  assert.equal((await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'Which filament for a shelf bracket?' }] }) })).status, 200);
  const r = await ask({ question: 'what did I ask about the bracket', bigger: true });
  assert.equal(r.status, 202);
  const { runId } = await r.json();
  assert.match(runId, /^run-/);
  const run = await finished(runId);
  assert.equal(run.type, 'prompt'); assert.equal(run.meta.mode, 'history');
  assert.equal(run.status, 'completed');
  assert.equal(run.meta.route.provider, 'ollama');
  assert.equal(run.output.text, 'You asked which filament suits a bracket: PETG [1] [9].');
  assert.equal(run.output.entries.length, 1);
  assert.deepEqual(run.output.citations.map(c => c.n), [1], '[9] names no entry and is ignored');
  assert.match(run.output.citations[0].link, /^#run\/run-/);
  assert.equal(asked.length, 1); assert.equal(asked[0].tools, undefined);
  assert.equal(await runsNow(), 2, 'the chat, and one Past work run');
  assert.equal((await (await fetch(`${base}/api/journal?q=bracket`)).json()).items.length, 1, 'the answer is not in the journal');

  mode = 'fail';
  const failed = await finished((await (await ask({ question: 'what did I ask about the bracket' })).json()).runId);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'The local model reported an error instead of an answer. Try again.', 'plain words, not the model server\'s text');
  assert.equal(failed.output.entries.length, 1, 'the entries it read are still shown');
  assert.equal(failed.retryable, true);

  // Retry asks the same question again: a new Past work run under the same rules.
  mode = 'chat';
  const again = await fetch(`${base}/api/runs/retry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: failed.id }) });
  assert.equal(again.status, 200);
  const retried = await finished((await again.json()).runId);
  assert.equal(retried.type, 'prompt'); assert.equal(retried.meta.mode, 'history'); assert.equal(retried.retryOf, failed.id);
  assert.equal(retried.status, 'completed'); assert.equal(retried.meta.route.provider, 'ollama');
  assert.equal(asked.at(-1).tools, undefined);

  // ?ids= says which entries still exist, so a stored answer can show what was deleted since.
  const id = run.output.entries[0].id;
  assert.deepEqual((await (await fetch(`${base}/api/journal?ids=${id},j-nope`)).json()).items.map(x => x.id), [id]);
  assert.equal((await fetch(`${base}/api/journal/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })).status, 200);
  assert.deepEqual((await (await fetch(`${base}/api/journal?ids=${id}`)).json()).items, []);
});
