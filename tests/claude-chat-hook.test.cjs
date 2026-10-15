'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'host', 'claude-chat', 'hook.py');
const SID = '0123456789abcdef-session';

async function relay(t) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
      res.setHeader('Content-Type', 'application/json');
      res.end('{"ok":true}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const handle = { requests, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.close(r); server.closeAllConnections?.(); }) };
  if (t) t.after(() => handle.close());
  return handle;
}

function setup({ key = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-hook-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  if (key) fs.writeFileSync(path.join(home, 'mac.key'), 'secret-key\n');
  const out = path.join(dir, 'bridge-argv.json');
  const bridge = `python3 -I -c 'import sys,json;open(sys.argv[1],"w").write(json.dumps(sys.argv[2:]))' ${out}`;
  return { dir, home, out, bridge };
}

function runHook(input, env, hook = HOOK) {
  return new Promise((resolve) => {
    const started = Date.now();
    let done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); resolve({ ms: Date.now() - started, ...v }); };
    const child = spawn('python3', ['-I', hook], { env: { PATH: process.env.PATH, ...env } });
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ code: null }); }, 8000);
    child.stdin.on('error', () => {});
    child.on('error', (error) => finish({ code: null, error }));
    child.on('close', (code) => finish({ code }));
    child.stdin.end(JSON.stringify(input));
  });
}

async function waitFor(file, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8')) return fs.readFileSync(file, 'utf8');
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

const line = (o) => JSON.stringify(o);
const user = (content) => line({ type: 'user', message: { role: 'user', content } });
const asst = (content) => line({ type: 'assistant', message: { role: 'assistant', content } });
const writeTranscript = (dir, lines) => { const p = path.join(dir, 't.jsonl'); fs.writeFileSync(p, lines.join('\n') + '\n'); return p; };

function envFor(s, r, extra = {}) {
  return { LOCALAI_CHAT: '1', LOCALAI_CHAT_HOME: s.home, LOCALAI_URL: r.url, LOCALAI_CHAT_BRIDGE_CMD: s.bridge, ...extra };
}

test('without LOCALAI_CHAT=1 nothing happens on any event', async (t) => {
  const r = await relay(t); const s = setup();
  const tr = writeTranscript(s.dir, [user('hi'), asst([{ type: 'text', text: 'yo' }])]);
  for (const ev of [
    { hook_event_name: 'SessionStart', session_id: SID, cwd: '/a/b' },
    { hook_event_name: 'UserPromptSubmit', session_id: SID, cwd: '/a/b', prompt: 'hi' },
    { hook_event_name: 'Stop', session_id: SID, cwd: '/a/b', transcript_path: tr },
  ]) {
    const e = envFor(s, r); delete e.LOCALAI_CHAT;
    assert.equal((await runHook(ev, e)).code, 0);
  }
  await new Promise((x) => setTimeout(x, 300));
  assert.equal(r.requests.length, 0);
  assert.equal(fs.existsSync(s.out), false);
});

test('SessionStart starts the bridge with sessionId, title and cwd', async (t) => {
  const r = await relay(t); const s = setup();
  const res = await runHook({ hook_event_name: 'SessionStart', session_id: SID, cwd: '/Users/x/my proj' }, envFor(s, r));
  assert.equal(res.code, 0);
  const argv = JSON.parse(await waitFor(s.out));
  assert.deepEqual(argv, [SID, 'my proj · 01234567', '/Users/x/my proj']);
});

test('UserPromptSubmit posts the prompt as a terminal user message', async (t) => {
  const r = await relay(t); const s = setup();
  const res = await runHook({ hook_event_name: 'UserPromptSubmit', session_id: SID, cwd: '/a', prompt: 'do <b>it</b> 🎉' }, envFor(s, r));
  assert.equal(res.code, 0);
  assert.equal(r.requests.length, 1);
  const q = r.requests[0];
  assert.equal(q.method, 'POST');
  assert.equal(q.url, '/api/claude/chat/mirror');
  assert.equal(q.headers['x-localai-mac-key'], 'secret-key');
  assert.equal(q.headers['content-type'], 'application/json');
  assert.deepEqual(q.body, { sessionId: SID, role: 'user', source: 'terminal', text: 'do <b>it</b> 🎉' });
});

test('a prompt starting with "[LocalAI web · " is not posted; missing key does nothing', async (t) => {
  const r = await relay(t); const s = setup();
  await runHook({ hook_event_name: 'UserPromptSubmit', session_id: SID, cwd: '/a', prompt: '[LocalAI web · iPhone] hello' }, envFor(s, r));
  assert.equal(r.requests.length, 0);
  const n = setup({ key: false });
  await runHook({ hook_event_name: 'UserPromptSubmit', session_id: SID, cwd: '/a', prompt: 'x' }, envFor(n, r));
  assert.equal(r.requests.length, 0);
});

test('long prompts are truncated to 50,000 characters', async (t) => {
  const r = await relay(t); const s = setup();
  await runHook({ hook_event_name: 'UserPromptSubmit', session_id: SID, cwd: '/a', prompt: 'a'.repeat(60000) }, envFor(s, r));
  assert.equal(r.requests[0].body.text.length, 50000);
});

test('Stop posts the assistant text after the last user entry', async (t) => {
  const r = await relay(t); const s = setup();
  const tr = writeTranscript(s.dir, [
    user('first'), asst([{ type: 'text', text: 'OLD' }]),
    user([{ type: 'text', text: 'second' }]),
    asst([{ type: 'text', text: 'Part one' }, { type: 'tool_use', id: 't1', name: 'Bash', input: {} }]),
    user([{ type: 'tool_result', tool_use_id: 't1', content: 'out' }]),
    asst([{ type: 'text', text: 'Part two' }]),
  ]);
  const res = await runHook({ hook_event_name: 'Stop', session_id: SID, cwd: '/a', transcript_path: tr }, envFor(s, r));
  assert.equal(res.code, 0);
  assert.equal(r.requests.length, 1);
  assert.deepEqual(r.requests[0].body, { sessionId: SID, role: 'assistant', source: 'reply', text: 'Part one\n\nPart two' });
});

test('Stop prefers last_assistant_message over a transcript that has not caught up', async (t) => {
  const r = await relay(t); const s = setup();
  const lagging = writeTranscript(s.dir, [user('go'), asst([{ type: 'text', text: 'Working on it' }])]);
  const res = await runHook({ hook_event_name: 'Stop', session_id: SID, cwd: '/a', transcript_path: lagging, last_assistant_message: 'The final answer.' }, envFor(s, r));
  assert.equal(res.code, 0);
  assert.equal(r.requests.length, 1);
  assert.deepEqual(r.requests[0].body, { sessionId: SID, role: 'assistant', source: 'reply', text: 'The final answer.' });
});

test('Stop with an empty or non-string last_assistant_message falls back to the transcript', async (t) => {
  const r = await relay(t); const s = setup();
  const tr = writeTranscript(s.dir, [user('go'), asst([{ type: 'text', text: 'from transcript' }])]);
  for (const value of ['', '   ', null, 42]) {
    assert.equal((await runHook({ hook_event_name: 'Stop', session_id: SID, cwd: '/a', transcript_path: tr, last_assistant_message: value }, envFor(s, r))).code, 0);
  }
  assert.deepEqual(r.requests.map((q) => q.body.text), ['from transcript', 'from transcript', 'from transcript', 'from transcript']);
});

test('Stop with a tool-only turn or a malformed transcript line posts nothing and exits 0', async (t) => {
  const r = await relay(t); const s = setup();
  const toolOnly = writeTranscript(s.dir, [user('go'), asst([{ type: 'tool_use', id: 't', name: 'Bash', input: {} }])]);
  assert.equal((await runHook({ hook_event_name: 'Stop', session_id: SID, cwd: '/a', transcript_path: toolOnly }, envFor(s, r))).code, 0);
  const bad = writeTranscript(s.dir, [user('go'), '{not json', asst([{ type: 'tool_use', id: 't', name: 'X', input: {} }])]);
  assert.equal((await runHook({ hook_event_name: 'Stop', session_id: SID, cwd: '/a', transcript_path: bad }, envFor(s, r))).code, 0);
  assert.equal((await runHook({ hook_event_name: 'Stop', session_id: SID, cwd: '/a', transcript_path: '/nonexistent/t.jsonl' }, envFor(s, r))).code, 0);
  assert.equal(r.requests.length, 0);
});

test('relay down -> exit 0 within 10 s', async (t) => {
  const r = await relay(t); const s = setup();
  const url = r.url; await r.close();
  const res = await runHook({ hook_event_name: 'UserPromptSubmit', session_id: SID, cwd: '/a', prompt: 'hi' }, envFor(s, { url }));
  assert.equal(res.code, 0);
  assert.ok(res.ms < 10000);
});

test('Stop skips malformed transcript lines and still posts the reply', async (t) => {
  const r = await relay(t); const s = setup();
  const a = writeTranscript(s.dir, [user('go'), '{not json', asst([{ type: 'text', text: 'ok' }])]);
  assert.equal((await runHook({ hook_event_name: 'Stop', session_id: SID, cwd: '/a', transcript_path: a }, envFor(s, r))).code, 0);
  assert.equal(r.requests.length, 1);
  assert.equal(r.requests[0].body.text, 'ok');
  const b = writeTranscript(s.dir, [user('go'), asst([{ type: 'text', text: 'one' }]), '{"broken', asst([{ type: 'text', text: 'two' }])]);
  assert.equal((await runHook({ hook_event_name: 'Stop', session_id: SID, cwd: '/a', transcript_path: b }, envFor(s, r))).code, 0);
  assert.equal(r.requests.length, 2);
  assert.equal(r.requests[1].body.text, 'one\n\ntwo');
});

test('SessionStart without mac.key does not start the bridge', async (t) => {
  const r = await relay(t); const s = setup({ key: false });
  assert.equal((await runHook({ hook_event_name: 'SessionStart', session_id: SID, cwd: '/a/b' }, envFor(s, r))).code, 0);
  assert.equal(await waitFor(s.out, 700), null);
});

test('runHook fails fast (no hang) when the hook cannot run', async () => {
  const res = await runHook({ hook_event_name: 'Stop' }, {}, '/nonexistent/hook.py');
  assert.notEqual(res.code, 0);
  assert.ok(res.ms < 5000);
});
