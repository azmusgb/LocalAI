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
