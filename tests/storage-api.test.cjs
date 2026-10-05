'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { Storage } = require('../app/storage');

test('HTTP state remains compatible, persists across restart and retains concurrent model results', { timeout: 30000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-api-'));
  const legacy = [{ id: 'legacy-chat', title: 'Imported', projectId: 'missing', messages: [{ role: 'user', content: 'Old conversation' }] }];
  fs.writeFileSync(path.join(dataDir, 'conversations.json'), JSON.stringify(legacy));
  const mock = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(req.url === '/api/tags' ? { models: [{ name: 'test-model' }] } : { message: { content: 'Independent result' } }));
    }, 50));
  });
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  const mockUrl = 'http://127.0.0.1:' + mock.address().port;
  let child, base, diagnostics = '';
  const stop = async () => {
    const running = child;
    child = undefined;
    if (!running || running.exitCode !== null || running.signalCode !== null) return;
    const done = once(running, 'exit'); running.kill('SIGTERM'); await done;
  };
  t.after(async () => { await stop(); mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve)); fs.rmSync(dataDir, { recursive: true, force: true }); });
  async function start() {
    const reserve = http.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
    const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
    base = 'http://127.0.0.1:' + port;
    child = spawn(process.execPath, [path.resolve(__dirname, '../app/server.js')], {
      env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), OLLAMA_URL: mockUrl, MODEL: 'test-model', SELF_APP_ROOT: path.resolve(__dirname, '../app'), WORKSPACE_ROOT: dataDir }
    });
    child.stdout.on('data', chunk => diagnostics += chunk); child.stderr.on('data', chunk => diagnostics += chunk);
    for (let attempt = 0; attempt < 60; attempt++) {
      if (child.exitCode !== null) throw new Error(diagnostics);
      try { if ((await fetch(base + '/healthz')).ok) return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Server did not start: ' + diagnostics);
  }
  async function api(url, body) {
    const response = await fetch(base + url, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const value = await response.json();
    assert.ok(response.ok, `${url}: HTTP ${response.status}: ${JSON.stringify(value)}`);
    return value;
  }
  await start();
  assert.equal((await api('/healthz')).storage.engine, 'sqlite');
  assert.deepEqual((await api('/api/conversations?projectId=missing')).items, legacy);
  const project = (await api('/api/projects/create', { name: 'Durable project' })).item;
  const messages = Array.from({ length: 60 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: 'Message ' + index }));
  const saved = (await api('/api/conversations/save', { projectId: project.id, messages })).item;
  assert.equal(saved.messages.length, 60);
  const source = (await api('/api/knowledge/import', { projectId: project.id, name: 'evidence.txt', content: 'durable evidence '.repeat(400) })).item;
  const listed = await api('/api/knowledge?projectId=' + project.id);
  assert.equal(listed.items[0].id, source.id); assert.equal(listed.items[0].chunks, undefined);
  assert.ok((await api('/api/knowledge/search', { projectId: project.id, query: 'durable' })).hits.length);
  assert.deepEqual((await api('/api/projects')).items[0].counts, { conversations: 1, knowledge: 1, artifacts: 0 });
  const paged = await api('/api/conversations?limit=1&offset=1');
  assert.equal(paged.items.length, 1); assert.equal(paged.total, 2);
  assert.equal((await fetch(base + '/api/conversations?limit=0')).status, 400);
  assert.equal((await fetch(base + '/api/projects?offset=-1')).status, 400);
  const runs = await Promise.all(['one', 'two'].map(goal => api('/api/agents/run', { goal, projectId: project.id })));
  assert.ok(runs.every(value => value.run.status === 'complete'));
  const stored = (await api('/api/agents')).items;
  assert.equal(stored.length, 2); assert.ok(stored.every(run => run.status === 'complete'));
  const automation = (await api('/api/automations/create', { name: 'Parallel prompt', prompt: 'Test', kind: 'prompt' })).item;
  const automatic = await Promise.all([api('/api/automations/run', { id: automation.id }), api('/api/automations/run', { id: automation.id })]);
  assert.ok(automatic.every(value => value.run.status === 'complete'));
  assert.equal((await api('/api/storage/status')).counts.automationRuns, 2);
  await api('/api/conversations/delete', { id: 'legacy-chat' });
  await api('/api/knowledge/delete', { id: source.id });
  await stop(); await start();
  assert.equal((await api('/api/conversations')).total, 1);
  assert.deepEqual((await api('/api/conversations')).items[0].messages, messages);
  assert.equal((await api('/api/knowledge')).total, 0);
  await stop();
  const storage = new Storage({ dataDir });
  try {
    assert.equal(storage.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 60);
    assert.equal(storage.db.prepare('SELECT COUNT(*) AS n FROM knowledge_chunks').get().n, 0);
    assert.ok(storage.list('automationRuns').every(run => run.status === 'complete'));
  } finally { storage.close(); }
  assert.equal(fs.readFileSync(path.join(dataDir, 'conversations.json'), 'utf8'), JSON.stringify(legacy), 'runtime must never rewrite legacy JSON');
});
