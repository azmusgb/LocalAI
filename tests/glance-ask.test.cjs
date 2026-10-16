'use strict';

// "Ask Local AI": the voice router in front of /api/glance/ask (GET ?q= and POST {text}), plain text out.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { Storage } = require('../app/storage');

async function freePort() {
  const s = http.createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening');
  const port = s.address().port; await new Promise(r => s.close(r)); return port;
}

// reply: the mock model's answer text, or a number for an HTTP error status.
async function startServer(t, { reply = 'Fine.', seed, env = {}, onChat } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-ask-'));
  if (seed) { const storage = new Storage({ dataDir }); seed(storage); storage.close?.(); }
  const chats = [];
  const mock = http.createServer((req, res) => {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      if (req.url === '/api/tags') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ models: [{ name: 'test-model' }] })); }
      if (req.url === '/api/ps') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ models: [] })); }
      if (req.url === '/api/chat') { try { chats.push(JSON.parse(body)); } catch {} if (onChat && onChat(chats.length, res)) return; }
      if (typeof reply === 'number') { res.writeHead(reply); return res.end('model down'); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: { content: reply } }));
    });
  });
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  let log = '';
  const child = spawn(process.execPath, [path.resolve(__dirname, '../app/server.js')], {
    env: { ...process.env, DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, PORT: String(port), OLLAMA_URL: `http://127.0.0.1:${mock.address().port}`, MODEL: 'test-model',
      SELF_APP_ROOT: path.resolve(__dirname, '../app'),
      COMFY_URL: 'http://127.0.0.1:9', N8N_URL: 'http://127.0.0.1:9', PROXY_URL: 'http://127.0.0.1:9', SEARXNG_URL: 'http://127.0.0.1:9', MAC_AI_HOME_URL: 'http://127.0.0.1:9', MAC_DSH_URL: 'http://127.0.0.1:9', ...env }
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
  const ask = async q => { const r = await fetch(`${base}/api/glance/ask?q=${encodeURIComponent(q)}`); return { status: r.status, type: r.headers.get('content-type'), body: await r.text() }; };
  return { base, chats, ask };
}

test('time questions are answered from the clock without the model', { timeout: 30000 }, async t => {
  const { ask, chats } = await startServer(t);
  const r = await ask('what time is it');
  assert.equal(r.status, 200);
  assert.match(r.type, /^text\/plain/);
  assert.match(r.body, /^Today is \w+, \w+ \d+, \d{4}\. It is \d{1,2}:\d{2} in the (morning|afternoon|evening|night)\.$/);
  assert.equal(chats.length, 0);
});

test('"anything need me" names the pending approval', { timeout: 30000 }, async t => {
  const stamp = '2026-10-15T00:00:00Z';
  const { ask, chats } = await startServer(t, { seed: s => s.put('approvals', { id: 'appr-1', title: 'Fix the login bug', detail: '', risk: 'high', status: 'pending', createdAt: stamp, updatedAt: stamp, meta: {} }, 0) });
  const r = await ask('anything need me');
  assert.equal(r.status, 200);
  assert.match(r.body, /Fix the login bug/);
  assert.equal(chats.length, 0);
});

test('empty or noise dictation is a spoken prompt with HTTP 200', { timeout: 30000 }, async t => {
  const { ask, chats } = await startServer(t);
  for (const q of ['', 'um']) {
    const r = await ask(q);
    assert.equal(r.status, 200, q);
    assert.equal(r.body, "I didn't catch that.");
  }
  assert.equal(chats.length, 0);
});

test('model markdown, links and emoji never reach the speaker, and the prompt knows the day', { timeout: 30000 }, async t => {
  const { ask, chats } = await startServer(t, { reply: '**Sure** 🙂 see https://example.com/x\n- one\n- two. Third. Fourth.' });
  const r = await ask('explain WAL mode');
  assert.equal(r.status, 200);
  assert.doesNotMatch(r.body, /\*|http|\p{Extended_Pictographic}|^- /mu);
  assert.ok((r.body.match(/[.!?](\s|$)/g) || []).length <= 2, r.body);
  const system = chats.at(-1).messages.find(m => m.role === 'system').content;
  const weekday = new Date().toLocaleDateString('en-US', { weekday: 'long' });
  assert.ok(system.includes(weekday), `system prompt has ${weekday}`);
  assert.match(system, /read aloud/);
});

test('POST {text} still works and answers in plain text', { timeout: 30000 }, async t => {
  const { base } = await startServer(t, { reply: 'It is sunny.' });
  const r = await fetch(`${base}/api/glance/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'explain WAL mode' }) });
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'It is sunny.');
  const empty = await fetch(`${base}/api/glance/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '' }) });
  assert.equal(empty.status, 200);
  assert.equal(await empty.text(), "I didn't catch that.");
});

test('a down model is a plain-text 503 sentence, never JSON', { timeout: 30000 }, async t => {
  const { ask } = await startServer(t, { reply: 500 });
  const r = await ask('explain WAL mode');
  assert.equal(r.status, 503);
  assert.match(r.type, /^text\/plain/);
  assert.equal(r.body, "Local AI can't answer right now. Try again in a minute.");
});

test('a malformed POST body is "didn\'t catch that", not a server failure', { timeout: 30000 }, async t => {
  const { base, chats } = await startServer(t);
  const r = await fetch(`${base}/api/glance/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' });
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "I didn't catch that.");
  assert.equal(chats.length, 0);
});

test('an oversized POST body is a plain-text 413', { timeout: 30000 }, async t => {
  const { base, chats } = await startServer(t);
  const r = await fetch(`${base}/api/glance/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'a'.repeat(1100000) }) });
  assert.equal(r.status, 413);
  assert.match(r.headers.get('content-type'), /^text\/plain/);
  assert.equal(await r.text(), 'That was too long for me.');
  assert.equal(chats.length, 0);
});

// Follow-up threads: an ask within five minutes continues the same conversation.
const runsFor = async base => (await (await fetch(`${base}/api/runs?limit=50`)).json()).items;

test('a follow-up within the window shares the thread and sends the earlier turn to the model', { timeout: 30000 }, async t => {
  const { ask, chats, base } = await startServer(t, { reply: 'Sunny and warm.' });
  await ask('explain WAL mode');
  await ask('and why is that useful');
  assert.equal(chats.length, 2);
  const second = chats[1].messages.filter(m => m.role !== 'system').map(m => `${m.role}:${m.content}`);
  assert.deepEqual(second, ['user:explain WAL mode', 'assistant:Sunny and warm.', 'user:and why is that useful']);
  const chatRuns = (await runsFor(base)).filter(r => r.type === 'chat');
  assert.equal(chatRuns.length, 2);
  assert.equal(chatRuns[0].threadId, chatRuns[1].threadId);
  assert.match(chatRuns[0].threadId, /^t-[0-9a-f]{32}$/);
});

test('a time answer is a turn in the thread, so a follow-up has context', { timeout: 30000 }, async t => {
  const { ask, chats } = await startServer(t, { reply: 'Cooler.' });
  const time = await ask('what time is it');
  await ask('and what about tomorrow');
  const msgs = chats[0].messages.filter(m => m.role !== 'system');
  assert.equal(msgs[0].content, 'what time is it');
  assert.equal(msgs[1].content, time.body);
  assert.equal(msgs[2].content, 'and what about tomorrow');
});

test('"start over" begins a new thread without the old history', { timeout: 30000 }, async t => {
  const { ask, chats, base } = await startServer(t, { reply: 'Okay then.' });
  await ask('explain WAL mode');
  await ask('start over, explain journaling');
  const msgs = chats[1].messages.filter(m => m.role !== 'system');
  assert.deepEqual(msgs.map(m => m.content), ['explain journaling']);
  const ids = new Set((await runsFor(base)).filter(r => r.type === 'chat').map(r => r.threadId));
  assert.equal(ids.size, 2);
});

test('overlapping asks both answer and the thread records both turns in order', { timeout: 30000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-ask-'));
  const chats = [];
  const mock = http.createServer((req, res) => {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      if (req.url === '/api/tags') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ models: [{ name: 'test-model' }] })); }
      if (req.url === '/api/ps') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ models: [] })); }
      if (req.url !== '/api/chat') { res.writeHead(404); return res.end(); }
      const parsed = JSON.parse(body), last = parsed.messages.at(-1).content; chats.push(parsed);
      setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ message: { content: `Answer to ${last}.` } })); }, last === 'first question' ? 500 : 0);
    });
  });
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  let log = '';
  const child = spawn(process.execPath, [path.resolve(__dirname, '../app/server.js')], { env: { ...process.env, DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, PORT: String(port), OLLAMA_URL: `http://127.0.0.1:${mock.address().port}`, MODEL: 'test-model', SELF_APP_ROOT: path.resolve(__dirname, '../app'), COMFY_URL: 'http://127.0.0.1:9', N8N_URL: 'http://127.0.0.1:9', PROXY_URL: 'http://127.0.0.1:9', SEARXNG_URL: 'http://127.0.0.1:9', MAC_AI_HOME_URL: 'http://127.0.0.1:9', MAC_DSH_URL: 'http://127.0.0.1:9' } });
  child.stdout.on('data', c => log += c); child.stderr.on('data', c => log += c);
  t.after(async () => { if (child.exitCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; } mock.closeAllConnections(); await new Promise(r => mock.close(r)); fs.rmSync(dataDir, { recursive: true, force: true }); });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`${base}/healthz`)).ok) break; } catch {} if (i === 79) throw new Error(log); await new Promise(r => setTimeout(r, 50)); }
  const get = q => fetch(`${base}/api/glance/ask?q=${encodeURIComponent(q)}`).then(async r => ({ status: r.status, body: await r.text() }));
  const p1 = get('first question');
  await new Promise(r => setTimeout(r, 100));
  const p2 = get('second question');
  const [a, b] = await Promise.all([p1, p2]);
  assert.deepEqual([a.status, a.body], [200, 'Answer to first question.']);
  assert.deepEqual([b.status, b.body], [200, 'Answer to second question.']);
  const msgs = chats[1].messages.filter(m => m.role !== 'system').map(m => m.content);
  assert.deepEqual(msgs, ['first question', 'Answer to first question.', 'second question']);
  const runs = (await runsFor(base)).filter(r => r.type === 'chat');
  assert.equal(runs.length, 2);
  assert.equal(runs[0].threadId, runs[1].threadId);
});

test('"start over" on its own resets the thread for the next ask', { timeout: 30000 }, async t => {
  const { ask, chats, base } = await startServer(t, { reply: 'Okay then.' });
  await ask('explain WAL mode');
  const r = await ask('start over');
  assert.equal(r.body, 'Okay. What is your question?');
  await ask('explain journaling');
  assert.deepEqual(chats[1].messages.filter(m => m.role !== 'system').map(m => m.content), ['explain journaling']);
  const ids = new Set((await runsFor(base)).filter(x => x.type === 'chat').map(x => x.threadId));
  assert.equal(ids.size, 2);
});

test('a stuck answer does not block the next ask past the queue wait', { timeout: 30000 }, async t => {
  const { ask, chats } = await startServer(t, { reply: 'Fine.', env: { LOCALAI_VOICE_QUEUE_WAIT_MS: '200' }, onChat: n => n === 1 });
  ask('first question').catch(() => {});
  await new Promise(r => setTimeout(r, 100));
  const started = Date.now();
  const r = await ask('second question');
  assert.equal(r.status, 200);
  assert.equal(r.body, 'Fine.');
  assert.ok(Date.now() - started < 3000);
  assert.deepEqual(chats[1].messages.filter(m => m.role !== 'system').map(m => m.content), ['second question']);
});

test('a failed ask leaves the thread intact for the next one', { timeout: 30000 }, async t => {
  const { ask, chats } = await startServer(t, { reply: 'Fine.', onChat: (n, res) => { if (n === 2) { res.writeHead(500); res.end('down'); return true; } } });
  await ask('first question');
  assert.equal((await ask('second question')).status, 503);
  assert.equal((await ask('third question')).status, 200);
  assert.deepEqual(chats[2].messages.filter(m => m.role !== 'system').map(m => m.content), ['first question', 'Fine.', 'third question']);
});

test('the five-minute window runs from the previous ask, not its answer', { timeout: 30000 }, async t => {
  const clock = path.join(os.tmpdir(), `localai-clock-${process.pid}-${Date.now()}`);
  const min = 60000, t0 = Date.now();
  fs.writeFileSync(clock, String(t0));
  t.after(() => fs.rmSync(clock, { force: true }));
  const { ask, chats } = await startServer(t, { reply: 'Fine.', env: { LOCALAI_TEST_NOW_FILE: clock }, onChat: n => { if (n === 1) fs.writeFileSync(clock, String(t0 + 4 * min)); } });
  await ask('first question');
  fs.writeFileSync(clock, String(t0 + 5.5 * min));
  await ask('second question');
  assert.deepEqual(chats[1].messages.filter(m => m.role !== 'system').map(m => m.content), ['second question']);
  fs.writeFileSync(clock, String(t0 + 6 * min));
  await ask('third question');
  assert.equal(chats[2].messages.filter(m => m.role !== 'system').length, 3);
});

const HANDOFF = "Still working on that \u2014 I'll send it to your phone.";
const readLog = f => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const waitFor = async (fn, ms = 5000) => { const end = Date.now() + ms; for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 25)); } };
const delayed = ms => (n, res) => { setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ message: { content: 'The slow answer. Second sentence.' } })); }, ms); return true; };

test('a slow answer is handed off to the phone and sent as one notification', { timeout: 30000 }, async t => {
  const log = path.join(os.tmpdir(), `localai-notify-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(log, { force: true }));
  const { ask } = await startServer(t, { env: { LOCALAI_VOICE_BUDGET_MS: '200', LOCALAI_NOTIFY_LOG: log }, onChat: delayed(700) });
  const started = Date.now();
  const r = await ask('tell me something interesting');
  assert.equal(r.status, 200);
  assert.equal(r.body, HANDOFF);
  assert.ok(Date.now() - started < 450, `took ${Date.now() - started}ms`);
  assert.deepEqual(readLog(log), []);
  const [n] = await waitFor(() => { const l = readLog(log); return l.length ? l : null; });
  await new Promise(r => setTimeout(r, 300));
  const all = readLog(log);
  assert.equal(all.length, 1, JSON.stringify(all));
  assert.equal(n.kind, 'answer');
  assert.equal(n.title, 'Local AI answered');
  assert.equal(n.body, 'The slow answer. Second sentence.');
  assert.match(n.url, /^#run\/.+/);
  assert.equal(n.tag, 'answer:' + n.url.slice(5));
});

test('a slow answer is still recorded in the voice thread', { timeout: 30000 }, async t => {
  const { ask, chats } = await startServer(t, { env: { LOCALAI_VOICE_BUDGET_MS: '200' }, onChat: (n, res) => n === 1 ? delayed(500)(n, res) : false });
  assert.equal((await ask('first question')).body, HANDOFF);
  const r = await ask('and the second');
  assert.equal(r.status, 200);
  await waitFor(() => chats.length > 1);
  assert.deepEqual(chats[1].messages.filter(m => m.role !== 'system').map(m => m.content), ['first question', 'The slow answer. Second sentence.', 'and the second']);
});

test('a slow answer that fails sends a "couldn\'t answer" notification', { timeout: 30000 }, async t => {
  const log = path.join(os.tmpdir(), `localai-notify-${process.pid}-${Date.now()}-f`);
  t.after(() => fs.rmSync(log, { force: true }));
  const { ask } = await startServer(t, { env: { LOCALAI_VOICE_BUDGET_MS: '200', LOCALAI_NOTIFY_LOG: log }, onChat: (n, res) => { setTimeout(() => { res.writeHead(500); res.end('down'); }, 500); return true; } });
  assert.equal((await ask('tell me something')).body, HANDOFF);
  const [n] = await waitFor(() => { const l = readLog(log); return l.length ? l : null; });
  await new Promise(r => setTimeout(r, 300));
  assert.equal(readLog(log).length, 1, JSON.stringify(readLog(log)));
  assert.equal(n.title, "Local AI couldn't answer");
  assert.match(n.body, /HTTP 500/);
});

test('a fast answer sends no notification', { timeout: 30000 }, async t => {
  const log = path.join(os.tmpdir(), `localai-notify-${process.pid}-${Date.now()}-q`);
  t.after(() => fs.rmSync(log, { force: true }));
  const { ask } = await startServer(t, { reply: 'Quick one.', env: { LOCALAI_VOICE_BUDGET_MS: '2000', LOCALAI_NOTIFY_LOG: log } });
  assert.equal((await ask('tell me something')).body, 'Quick one.');
  await new Promise(r => setTimeout(r, 300));
  assert.deepEqual(readLog(log), []);
});

test('the budget includes time spent waiting behind an earlier ask', { timeout: 30000 }, async t => {
  const { ask } = await startServer(t, { env: { LOCALAI_VOICE_BUDGET_MS: '300', LOCALAI_VOICE_QUEUE_WAIT_MS: '5000' }, onChat: (n, res) => n === 1 ? delayed(1500)(n, res) : false });
  ask('first question');
  await new Promise(r => setTimeout(r, 100));
  const started = Date.now();
  const r = await ask('second question');
  assert.equal(r.body, HANDOFF);
  assert.ok(Date.now() - started < 600);
});

test('two failed handoffs close together each send their own notification', { timeout: 30000 }, async t => {
  const log = path.join(os.tmpdir(), `localai-notify-${process.pid}-${Date.now()}-two`);
  t.after(() => fs.rmSync(log, { force: true }));
  const { ask } = await startServer(t, { env: { LOCALAI_VOICE_BUDGET_MS: '200', LOCALAI_NOTIFY_LOG: log }, onChat: (n, res) => { setTimeout(() => { res.writeHead(500); res.end('down'); }, 400); return true; } });
  assert.equal((await ask('first question')).body, HANDOFF);
  assert.equal((await ask('second question')).body, HANDOFF);
  const got = await waitFor(() => { const l = readLog(log); return l.length >= 2 ? l : null; });
  await new Promise(r => setTimeout(r, 300));
  const all = readLog(log);
  assert.equal(all.length, 2, JSON.stringify(all));
  assert.notEqual(all[0].tag, all[1].tag);
});
