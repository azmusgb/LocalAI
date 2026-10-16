'use strict';

// /api/glance and brief chat answers, for Siri Shortcuts on an iPhone or Apple Watch (docs/APPLE-WATCH.md).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

async function freePort() {
  const s = http.createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening');
  const port = s.address().port; await new Promise(r => s.close(r)); return port;
}

async function startServer(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-glance-'));
  const chats = [];
  const mock = http.createServer((req, res) => {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'test-model' }] }));
      if (req.url === '/api/ps') return res.end(JSON.stringify({ models: [] }));
      if (req.url === '/api/chat') { try { chats.push(JSON.parse(body)); } catch {} }
      res.end(JSON.stringify({ message: { content: 'It is sunny.' } }));
    });
  });
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  let log = '';
  const child = spawn(process.execPath, [path.resolve(__dirname, '../app/server.js')], {
    env: { ...process.env, DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, PORT: String(port), OLLAMA_URL: `http://127.0.0.1:${mock.address().port}`, MODEL: 'test-model',
      COMFY_URL: 'http://127.0.0.1:9', N8N_URL: 'http://127.0.0.1:9', PROXY_URL: 'http://127.0.0.1:9', SEARXNG_URL: 'http://127.0.0.1:9', MAC_AI_HOME_URL: 'http://127.0.0.1:9', MAC_DSH_URL: 'http://127.0.0.1:9' }
  });
  child.stdout.on('data', c => log += c); child.stderr.on('data', c => log += c);
  t.after(async () => {
    if (child.exitCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
    mock.closeAllConnections(); await new Promise(r => mock.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error(log);
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch {}
    if (i === 79) throw new Error(`Server did not start: ${log}`);
    await new Promise(r => setTimeout(r, 50));
  }
  return { base, chats };
}

test('glance speaks what needs the owner and the health of the appliance', { timeout: 30000 }, async t => {
  const { base } = await startServer(t);
  const needs = await (await fetch(`${base}/api/glance`)).json();
  assert.equal(needs.topic, 'needs');
  assert.equal(typeof needs.speech, 'string');
  assert.match(needs.speech, /^(Nothing needs you right now\.|Needs you: )/);
  // With only Intelligence answering in this test, the other core services are down and the summary says so.
  assert.equal(needs.health.ok, false);
  assert.ok(needs.health.down.includes('Image generation'));
  assert.match(needs.speech, /Image generation/);

  const health = await fetch(`${base}/api/glance?topic=health&format=text`);
  assert.equal(health.status, 200);
  assert.match(health.headers.get('content-type'), /^text\/plain/);
  const spoken = await health.text();
  assert.match(spoken, /are down\. Everything else is up\.$/);
  assert.doesNotMatch(spoken, /[{}<]/, 'plain sentence, nothing to parse');
});

test('brief chat asks the model for a short spoken answer; normal chat does not', { timeout: 30000 }, async t => {
  const { base, chats } = await startServer(t);
  const ask = body => fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const brief = await (await ask({ messages: [{ role: 'user', content: 'Weather?' }], brief: true })).json();
  assert.equal(brief.message.content, 'It is sunny.');
  await ask({ messages: [{ role: 'user', content: 'Weather?' }] });
  const systems = chats.map(c => c.messages.find(m => m.role === 'system')?.content || '');
  assert.equal(systems.length, 2);
  assert.match(systems[0], /read aloud on a watch/);
  assert.doesNotMatch(systems[1], /read aloud on a watch/);
});

test('ask takes one text field and answers in plain text with the brief instruction', { timeout: 30000 }, async t => {
  const { base, chats } = await startServer(t);
  const ask = body => fetch(`${base}/api/glance/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const r = await ask({ text: '  Tell me a joke?  ' });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/plain/);
  assert.equal(await r.text(), 'It is sunny.');
  const sent = chats.at(-1);
  assert.match(sent.messages.find(m => m.role === 'system').content, /read aloud on a watch/);
  assert.equal(sent.messages.at(-1).content, 'Tell me a joke?');
  // Siri speaks whatever comes back, so nothing-heard is a spoken prompt, not an error page.
  const none = await ask({ text: '' });
  assert.equal(none.status, 200);
  assert.equal(await none.text(), "I didn't catch that.");
  assert.equal((await ask({})).status, 200);
  const runs = await (await fetch(`${base}/api/runs?limit=5`)).json();
  const run = runs.items.find(x => x.type === 'chat');
  assert.ok(run, 'the question is an ordinary chat run');
});
