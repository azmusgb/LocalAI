'use strict';

// Answer feedback through the running server: rate a finished chat, see the verdict on its run card and in the summary,
// 404 and 409 from the route, and the sign-in gate on the write.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { spawnAppServer } = require('./spawn-server.cjs');

test('POST /api/runs/feedback rates a finished chat; its card and the summary show it; 404, 409 and sign-in', { timeout: 30000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-feedback-api-'));
  let fail = false;
  const mock = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'test-model' }] }));
      if (req.url === '/api/ps') return res.end(JSON.stringify({ models: [] }));
      if (fail) { res.statusCode = 500; return res.end('model crashed'); }
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
  const post = (p, body, headers = {}) => fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const rate = (body, headers) => post('/api/runs/feedback', body, headers);

  const chat = await (await post('/api/chat', { messages: [{ role: 'user', content: 'Which filament for a shelf bracket?' }] })).json();
  assert.ok(chat.runId);
  const card = async id => (await (await fetch(`${base}/api/runs?id=${encodeURIComponent(id)}`)).json()).item.card;
  assert.equal((await card(chat.runId)).feedback, null, 'not rated yet');

  const r = await rate({ id: chat.runId, verdict: 'bad', note: 'Too brittle outdoors' });
  assert.equal(r.status, 200);
  assert.deepEqual((({ verdict, note }) => ({ verdict, note }))((await r.json()).feedback), { verdict: 'bad', note: 'Too brittle outdoors' });
  assert.deepEqual((await card(chat.runId)).feedback, { verdict: 'bad', note: 'Too brittle outdoors' });
  const listed = (await (await fetch(`${base}/api/runs?limit=5`)).json()).items.find(x => x.id === chat.runId);
  assert.deepEqual(listed.card.feedback, { verdict: 'bad', note: 'Too brittle outdoors' });

  const s = await (await fetch(`${base}/api/runs/feedback/summary`)).json();
  assert.deepEqual(s.days30.rows, [{ provider: 'ollama', model: 'test-model', good: 0, bad: 1 }]);
  assert.deepEqual(s.recent.map(x => [x.runId, x.asked, x.note, x.kept]), [[chat.runId, 'Which filament for a shelf bracket?', 'Too brittle outdoors', true]]);

  assert.equal((await rate({ id: chat.runId, verdict: 'good' })).status, 200);
  assert.deepEqual((await card(chat.runId)).feedback, { verdict: 'good', note: '' });
  assert.equal((await rate({ id: chat.runId, verdict: null })).status, 200);
  assert.equal((await card(chat.runId)).feedback, null);

  assert.equal((await rate({ id: 'run-1-nope', verdict: 'good' })).status, 404);
  fail = true;
  const failed = await post('/api/chat', { messages: [{ role: 'user', content: 'Will this fail?' }] });
  assert.notEqual(failed.status, 200);
  const failedRun = (await (await fetch(`${base}/api/runs?limit=5`)).json()).items.find(x => x.status === 'failed');
  assert.ok(failedRun, 'the failed chat is a failed run');
  assert.equal((await rate({ id: failedRun.id, verdict: 'good' })).status, 409);
  assert.equal('feedback' in (await card(failedRun.id)), true, 'a failed chat card still says it has no verdict');

  // Through Caddy without a paired device: refused, and nothing changed.
  const lan = { 'X-Forwarded-For': '10.0.0.37', 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' };
  const refused = await rate({ id: chat.runId, verdict: 'good' }, lan);
  assert.equal(refused.status, 401);
  assert.equal((await refused.json()).signIn, true);
  assert.equal((await card(chat.runId)).feedback, null);
  assert.equal((await fetch(`${base}/api/runs/feedback/summary`, { headers: lan })).status, 200, 'reading the summary stays report-only');
});
