'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const BRIDGE = path.join(__dirname, '..', 'host', 'claude-chat', 'bridge.mjs');
const SID = 'sess-abc123';
const TOKEN = 'tok-xyz';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, what, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

async function fakeRelay(t) {
  const state = { requests: [], queue: [], failures: 0 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      state.requests.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
      res.setHeader('Content-Type', 'application/json');
      if (req.url.startsWith('/api/claude/chat/inbox') && state.failures > 0) {
        state.failures--;
        res.statusCode = 500;
        return res.end('{"error":"boom"}');
      }
      if (req.url.startsWith('/api/claude/chat/inbox')) {
        const end = Date.now() + 150;
        while (!state.queue.length && Date.now() < end) await sleep(10);
        return res.end(JSON.stringify({ items: state.queue.splice(0) }));
      }
      res.end('{"ok":true}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  state.url = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections?.(); }));
  return state;
}

async function fakeInbox(t) {
  const sock = path.join(os.tmpdir(), `cb${process.pid}${Math.random().toString(36).slice(2, 6)}.sock`);
  const conns = [];
  const server = net.createServer((c) => {
    const rec = { at: Date.now(), data: '', closed: false };
    conns.push(rec);
    c.on('data', (d) => { rec.data += d; });
    c.on('close', () => { rec.closed = true; });
    c.on('error', () => {});
  });
  await new Promise((r) => server.listen(sock, r));
  let closed = false;
  const close = () => new Promise((r) => { if (closed) return r(); closed = true; server.close(() => r()); });
  t.after(async () => { await close(); try { fs.unlinkSync(sock); } catch {} });
  return { sock, conns, close, lines: (i) => conns[i].data.split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
}

function startBridge(t, { relay, sock, home, env = {}, sid = SID }) {
  const proc = spawn('node', [BRIDGE, sid, 'My title', '/work/dir'], {
    env: {
      ...process.env,
      LOCALAI_URL: relay.url,
      LOCALAI_CHAT_HOME: home,
      CLAUDE_CODE_MESSAGING_SOCKET: sock,
      CLAUDE_CODE_MESSAGING_TOKEN: TOKEN,
      LOCALAI_CHAT_INJECT_GAP_MS: '50',
      LOCALAI_CHAT_BACKOFF_MS: '50',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const handle = { proc, output: '', exited: null };
  proc.stdout.on('data', (d) => { handle.output += d; });
  proc.stderr.on('data', (d) => { handle.output += d; });
  handle.exit = new Promise((r) => proc.on('exit', (code) => { handle.exited = code; r(code); }));
  t.after(() => { if (handle.exited === null) proc.kill('SIGKILL'); });
  return handle;
}

function makeHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbh-'));
  fs.writeFileSync(path.join(dir, 'mac.key'), 'the-mac-key\n');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const log = (home) => { try { return fs.readFileSync(path.join(home, 'bridge.log'), 'utf8'); } catch { return ''; } };
const exitsWithin = (b, ms, what) => Promise.race([b.exit, sleep(ms).then(() => { throw new Error(`bridge did not exit: ${what}`); })]);

test('announces the session, then injects each queued message as auth line + user line with the [LocalAI web · <device>] prefix', async (t) => {
  const relay = await fakeRelay(t);
  const inbox = await fakeInbox(t);
  const home = makeHome(t);
  relay.queue.push({ id: 11, seq: 1, text: 'hello "world" <b>', deviceName: 'Phone' }, { id: 12, seq: 2, text: 'no device', deviceName: '' });
  startBridge(t, { relay, sock: inbox.sock, home });
  await until(() => inbox.conns.length >= 2 && inbox.conns[1].closed, 'two injections');

  const announce = relay.requests.find((r) => r.url === '/api/claude/chat/announce');
  assert.equal(announce.method, 'POST');
  assert.deepEqual(announce.body, { sessionId: SID, title: 'My title', cwd: '/work/dir' });
  assert.equal(announce.headers['x-localai-mac-key'], 'the-mac-key');
  assert.equal(announce.headers['content-type'], 'application/json');
  const poll = relay.requests.find((r) => r.url.startsWith('/api/claude/chat/inbox'));
  assert.equal(poll.method, 'GET');
  assert.equal(poll.url, `/api/claude/chat/inbox?sessionId=${SID}&wait=25`);
  assert.equal(poll.headers['x-localai-mac-key'], 'the-mac-key');

  assert.deepEqual(inbox.lines(0), [
    { type: 'auth', token: TOKEN },
    { type: 'user', message: { role: 'user', content: '[LocalAI web · Phone] hello "world" <b>' } },
  ]);
  assert.equal(inbox.conns[0].data, `{"type":"auth","token":"${TOKEN}"}\n` + JSON.stringify(inbox.lines(0)[1]) + '\n');
  assert.equal(inbox.lines(1)[1].message.content, '[LocalAI web · web] no device');
  assert.ok(fs.existsSync(path.join(home, 'run', `${SID}.last`)));
  assert.ok(!log(home).includes('hello'));
  assert.ok(!log(home).includes(TOKEN));
});

test('one message per connection, at least 1 s apart (configured gap)', async (t) => {
  const relay = await fakeRelay(t);
  const inbox = await fakeInbox(t);
  const home = makeHome(t);
  relay.queue.push({ id: 1, seq: 1, text: 'a', deviceName: 'd' }, { id: 2, seq: 2, text: 'b', deviceName: 'd' }, { id: 3, seq: 3, text: 'c', deviceName: 'd' });
  startBridge(t, { relay, sock: inbox.sock, home, env: { LOCALAI_CHAT_INJECT_GAP_MS: '300' } });
  await until(() => inbox.conns.length >= 3, 'three connections');
  for (const c of inbox.conns) assert.equal(c.data.split('\n').filter(Boolean).length, 2);
  assert.ok(inbox.conns[1].at - inbox.conns[0].at >= 290, 'gap 1');
  assert.ok(inbox.conns[2].at - inbox.conns[1].at >= 290, 'gap 2');
});

test('a second bridge for the same session exits at once while the first is alive', async (t) => {
  const relay = await fakeRelay(t);
  const inbox = await fakeInbox(t);
  const home = makeHome(t);
  const first = startBridge(t, { relay, sock: inbox.sock, home });
  const pidfile = path.join(home, 'run', `${SID}.pid`);
  await until(() => fs.existsSync(pidfile), 'pidfile');
  assert.equal(fs.readFileSync(pidfile, 'utf8').trim(), String(first.proc.pid));
  const second = startBridge(t, { relay, sock: inbox.sock, home });
  assert.equal(await exitsWithin(second, 3000, 'second'), 0);
  assert.equal(first.exited, null);
  assert.equal(fs.readFileSync(pidfile, 'utf8').trim(), String(first.proc.pid));
});

test('exits and removes its pidfile when the socket path disappears', async (t) => {
  const relay = await fakeRelay(t);
  const inbox = await fakeInbox(t);
  const home = makeHome(t);
  const b = startBridge(t, { relay, sock: inbox.sock, home });
  const pidfile = path.join(home, 'run', `${SID}.pid`);
  await until(() => fs.existsSync(pidfile), 'pidfile');
  await until(() => relay.requests.some((r) => r.url.startsWith('/api/claude/chat/inbox')), 'first poll');
  await inbox.close();
  try { fs.unlinkSync(inbox.sock); } catch {}
  assert.equal(await exitsWithin(b, 5000, 'socket gone'), 0);
  assert.ok(!fs.existsSync(pidfile));
});

test('relay returns 500 twice, then recovers: the queued message is still injected', async (t) => {
  const relay = await fakeRelay(t);
  const inbox = await fakeInbox(t);
  const home = makeHome(t);
  relay.failures = 2;
  relay.queue.push({ id: 5, seq: 1, text: 'survivor', deviceName: 'Mac' });
  startBridge(t, { relay, sock: inbox.sock, home });
  await until(() => inbox.conns.length >= 1 && inbox.conns[0].closed, 'injection after recovery');
  assert.equal(inbox.lines(0)[1].message.content, '[LocalAI web · Mac] survivor');
  assert.equal(inbox.conns.length, 1);
  assert.ok(relay.requests.filter((r) => r.url.startsWith('/api/claude/chat/inbox')).length >= 3);
});

test('an injection that fails while the socket exists is retried (3 tries) and then logged as lost', async (t) => {
  const relay = await fakeRelay(t);
  const home = makeHome(t);
  // A regular file at the socket path: it exists, but connecting always fails.
  const sock = path.join(os.tmpdir(), `cbf${process.pid}${Math.random().toString(36).slice(2, 6)}.sock`);
  fs.writeFileSync(sock, '');
  t.after(() => { try { fs.unlinkSync(sock); } catch {} });
  relay.queue.push({ id: 77, seq: 1, text: 'doomed', deviceName: 'd' });
  startBridge(t, { relay, sock, home });
  await until(() => log(home).includes('lost 77'), 'lost log line');
  const l = log(home);
  assert.equal((l.match(/inject failed 77/g) || []).length, 3);
  assert.ok(!l.includes('doomed'));
});
