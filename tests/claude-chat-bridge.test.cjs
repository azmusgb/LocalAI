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
  const state = { requests: [], queue: [], failures: 0, announceFailures: 0, inbox401: false };
  const handler = (req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      state.requests.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
      res.setHeader('Content-Type', 'application/json');
      if (req.url.startsWith('/api/claude/chat/announce') && state.announceFailures > 0) {
        state.announceFailures--;
        res.statusCode = 500;
        return res.end('{"error":"boom"}');
      }
      if (req.url.startsWith('/api/claude/chat/inbox') && state.inbox401) {
        res.statusCode = 401;
        return res.end('{"error":"nope"}');
      }
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
  };
  let server = null;
  state.start = async (port = 0) => {
    server = http.createServer(handler);
    await new Promise((r) => server.listen(port, '127.0.0.1', r));
    state.port = server.address().port;
    state.url = `http://127.0.0.1:${state.port}`;
  };
  state.stop = async () => {
    if (!server) return;
    const s = server;
    server = null;
    await new Promise((r) => { s.close(r); s.closeAllConnections?.(); });
  };
  await state.start();
  t.after(() => state.stop());
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

test('an injection that fails while the socket exists is retried (3 tries), logged as lost, and the bridge keeps delivering', async (t) => {
  const relay = await fakeRelay(t);
  const home = makeHome(t);
  const sock = path.join(os.tmpdir(), `cbs${process.pid}${Math.random().toString(36).slice(2, 6)}.sock`);
  t.after(() => { try { fs.unlinkSync(sock); } catch {} });
  // A stale socket file: exists, but nothing listens (ECONNREFUSED on macOS and Linux).
  const stale = spawn('node', ['-e', `require('net').createServer().listen(process.argv[1], () => console.log('up'))`, sock], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => stale.kill('SIGKILL'));
  await new Promise((r) => stale.stdout.once('data', r));
  stale.kill('SIGKILL');
  await new Promise((r) => stale.on('exit', r));
  assert.ok(fs.existsSync(sock));

  relay.queue.push({ id: 77, seq: 1, text: 'doomed', deviceName: 'd' });
  const b = startBridge(t, { relay, sock, home });
  await until(() => log(home).includes('lost 77'), 'lost log line');
  const l = log(home);
  assert.equal((l.match(/inject failed 77/g) || []).length, 3);
  assert.ok(!l.includes('doomed'));
  assert.equal(b.exited, null, 'bridge keeps running after one lost message');

  // Session recovers: a live listener replaces the stale file; the next message is delivered.
  fs.unlinkSync(sock);
  const live = net.createServer((c) => { c.on('data', (d) => { live.got = (live.got || '') + d; }); c.on('error', () => {}); });
  await new Promise((r) => live.listen(sock, r));
  t.after(() => new Promise((r) => live.close(r)));
  relay.queue.push({ id: 78, seq: 2, text: 'next', deviceName: 'd' });
  await until(() => (live.got || '').includes('[LocalAI web · d] next'), 'next message delivered');
  assert.equal(b.exited, null);
});

test('announce failing (500) is retried with backoff; the session is announced later and messages are injected', async (t) => {
  const relay = await fakeRelay(t);
  const inbox = await fakeInbox(t);
  const home = makeHome(t);
  relay.announceFailures = 1;
  relay.queue.push({ id: 31, seq: 1, text: 'after announce', deviceName: 'd' });
  startBridge(t, { relay, sock: inbox.sock, home });
  await until(() => relay.requests.filter((r) => r.url === '/api/claude/chat/announce').length >= 2, 'second announce');
  await until(() => inbox.conns.length >= 1 && inbox.conns[0].closed, 'injection');
  assert.equal(inbox.lines(0)[1].message.content, '[LocalAI web · d] after announce');
});

test('relay unreachable (fetch throws): the bridge backs off, re-announces on recovery and injects the queued message', async (t) => {
  const relay = await fakeRelay(t);
  const inbox = await fakeInbox(t);
  const home = makeHome(t);
  const port = relay.port;
  await relay.stop();
  const b = startBridge(t, { relay, sock: inbox.sock, home });
  await until(() => log(home).includes('relay error'), 'relay error logged');
  assert.equal(b.exited, null);
  relay.queue.push({ id: 41, seq: 1, text: 'back', deviceName: 'd' });
  await relay.start(port);
  await until(() => inbox.conns.length >= 1 && inbox.conns[0].closed, 'injection after relay returns');
  assert.equal(inbox.lines(0)[1].message.content, '[LocalAI web · d] back');
  assert.ok(relay.requests.some((r) => r.url === '/api/claude/chat/announce'));
});

test('a 401 on the inbox logs "mac key rejected", backs off, and neither exits nor spins', async (t) => {
  const relay = await fakeRelay(t);
  const inbox = await fakeInbox(t);
  const home = makeHome(t);
  relay.inbox401 = true;
  const b = startBridge(t, { relay, sock: inbox.sock, home, env: { LOCALAI_CHAT_BACKOFF_MS: '200' } });
  await until(() => log(home).includes('mac key rejected'), 'rejection logged');
  await sleep(1000);
  assert.equal(b.exited, null);
  const polls = relay.requests.filter((r) => r.url.startsWith('/api/claude/chat/inbox')).length;
  assert.ok(polls >= 2 && polls <= 6, `expected backed-off polling, got ${polls}`);
});
