'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const { makeTlsFixture, OPENSSL_MISSING } = require('./tls-fixture.cjs');

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

async function fakeRelay(t, { tls = null } = {}) {
  // ackStatus: HTTP status for ack calls; ackOmit: ids the fake leaves out of `acked` (as if their lease had expired).
  const state = { requests: [], queue: [], failures: 0, announceFailures: 0, inbox401: false, ackStatus: 200, ackOmit: new Set() };
  const handler = (req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      state.requests.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null, at: Date.now() });
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
      if (req.url === '/api/claude/chat/inbox/ack') {
        if (state.ackStatus !== 200) { res.statusCode = state.ackStatus; return res.end('{"error":"boom"}'); }
        const ids = JSON.parse(body).ids;
        return res.end(JSON.stringify({ acked: ids.filter((id) => !state.ackOmit.has(id)) }));
      }
      if (req.url.startsWith('/api/claude/chat/inbox')) {
        const end = Date.now() + 150;
        let gone = false;
        res.on('close', () => { gone = true; });
        while (!state.queue.length && Date.now() < end && !gone) await sleep(10);
        if (gone) return; // like the real relay: a poller that went away leaves messages queued
        return res.end(JSON.stringify({ items: state.queue.splice(0) }));
      }
      res.end('{"ok":true}');
    });
  };
  let server = null;
  state.start = async (port = 0) => {
    server = tls ? https.createServer({ key: tls.key, cert: tls.cert }, handler) : http.createServer(handler);
    state.tlsFailures = 0;
    server.on('tlsClientError', () => { state.tlsFailures++; });
    await new Promise((r) => server.listen(port, '127.0.0.1', r));
    state.port = server.address().port;
    state.url = `${tls ? 'https' : 'http'}://127.0.0.1:${state.port}`;
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
    // Liveness probes connect and hang up without data; only record connections that send something.
    c.on('data', (d) => { if (!rec.data) { rec.at = Date.now(); conns.push(rec); } rec.data += d; });
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
  // A bridge still running at teardown may write its log while the directory is removed; never let that race throw,
  // or node:test skips the remaining after hooks (the bridge kill, closing listeners) and the file never exits.
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); } catch { /* best effort */ } });
  return dir;
}

const lockPath = (home, sock) => path.join(home, 'run', `sock-${crypto.createHash('sha256').update(sock).digest('hex').slice(0, 16)}.json`);
const readLock = (home, sock) => { try { return JSON.parse(fs.readFileSync(lockPath(home, sock), 'utf8')); } catch { return null; } };
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
  const acks = relay.requests.filter((r) => r.url === '/api/claude/chat/inbox/ack');
  assert.equal(acks.length, 1);
  assert.equal(acks[0].method, 'POST');
  assert.deepEqual(acks[0].body, { sessionId: SID, ids: [11, 12] });
  assert.equal(acks[0].headers['x-localai-mac-key'], 'the-mac-key');
  assert.equal(acks[0].headers['content-type'], 'application/json');
  assert.ok(acks[0].at <= inbox.conns[0].at, 'ack is sent before the first injection');
  assert.ok(log(home).includes('acked 2/2'));

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

test('one bridge per messaging socket: a bridge for a new session on the same socket (/clear) replaces the old one', async (t) => {
  const relay = await fakeRelay(t);
  const inbox = await fakeInbox(t);
  const home = makeHome(t);
  const a = startBridge(t, { relay, sock: inbox.sock, home, sid: 'sess-A' });
  await until(() => readLock(home, inbox.sock)?.pid === a.proc.pid, 'lock held by A');
  assert.deepEqual(readLock(home, inbox.sock), { pid: a.proc.pid, sessionId: 'sess-A' });
  await until(() => relay.requests.some((r) => r.url.includes('sessionId=sess-A')), 'A polls');

  const b = startBridge(t, { relay, sock: inbox.sock, home, sid: 'sess-B' });
  assert.equal(await exitsWithin(a, 4000, 'old bridge A'), 0);
  assert.ok(!fs.existsSync(path.join(home, 'run', 'sess-A.pid')), 'A removed its pidfile');
  await until(() => readLock(home, inbox.sock)?.pid === b.proc.pid, 'lock held by B');
  assert.deepEqual(readLock(home, inbox.sock), { pid: b.proc.pid, sessionId: 'sess-B' });
  await until(() => relay.requests.some((r) => r.url === '/api/claude/chat/announce' && r.body.sessionId === 'sess-B'), 'B announces');
  await until(() => relay.requests.some((r) => r.url.includes('sessionId=sess-B')), 'B polls');
  assert.ok(log(home).includes('replacing bridge'));

  relay.queue.push({ id: 9, seq: 1, text: 'to B', deviceName: 'd' });
  await until(() => inbox.conns.length >= 1 && inbox.conns[0].closed, 'B injects');
  assert.equal(inbox.lines(0)[1].message.content, '[LocalAI web · d] to B');

  const b2 = startBridge(t, { relay, sock: inbox.sock, home, sid: 'sess-B' });
  assert.equal(await exitsWithin(b2, 3000, 'second B'), 0);
  assert.equal(b.exited, null);
  assert.equal(readLock(home, inbox.sock).pid, b.proc.pid);
});

test('a lock left by a dead bridge is cleared and taken; the lock is removed on exit', async (t) => {
  const relay = await fakeRelay(t);
  const inbox = await fakeInbox(t);
  const home = makeHome(t);
  fs.mkdirSync(path.join(home, 'run'), { recursive: true });
  fs.writeFileSync(lockPath(home, inbox.sock), JSON.stringify({ pid: 2147483646, sessionId: SID }));
  const b = startBridge(t, { relay, sock: inbox.sock, home });
  await until(() => readLock(home, inbox.sock)?.pid === b.proc.pid, 'lock taken over');
  b.proc.kill('SIGTERM');
  assert.equal(await exitsWithin(b, 3000, 'SIGTERM'), 0);
  assert.ok(!fs.existsSync(lockPath(home, inbox.sock)));
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

async function staleSocket(t) {
  const sock = path.join(os.tmpdir(), `cbs${process.pid}${Math.random().toString(36).slice(2, 6)}.sock`);
  t.after(() => { try { fs.unlinkSync(sock); } catch {} });
  // A stale socket file: exists, but nothing listens (ECONNREFUSED on macOS and Linux).
  const dead = spawn('node', ['-e', `require('net').createServer().listen(process.argv[1], () => console.log('up'))`, sock], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => dead.kill('SIGKILL'));
  await new Promise((r) => dead.stdout.once('data', r));
  dead.kill('SIGKILL');
  await new Promise((r) => dead.on('exit', r));
  assert.ok(fs.existsSync(sock));
  return sock;
}

test('a stale socket (listener killed, file left behind) with nothing queued: the bridge exits after 3 refused connects and removes its pidfile', async (t) => {
  const relay = await fakeRelay(t);
  const home = makeHome(t);
  const sock = await staleSocket(t);
  const b = startBridge(t, { relay, sock, home });
  assert.equal(await exitsWithin(b, 5000, 'stale socket'), 0);
  assert.ok(!fs.existsSync(path.join(home, 'run', `${SID}.pid`)));
  assert.ok(log(home).includes('socket unreachable'));
});

test('an injection that fails while the socket accepts connections is retried (3 tries), logged as lost, and the bridge keeps delivering', async (t) => {
  const relay = await fakeRelay(t);
  const home = makeHome(t);
  const sock = path.join(os.tmpdir(), `cbl${process.pid}${Math.random().toString(36).slice(2, 6)}.sock`);
  t.after(() => { try { fs.unlinkSync(sock); } catch {} });
  // Accepts every connection but never reads: connect succeeds, the large write cannot complete.
  const held = [];
  const stuck = net.createServer((c) => { c.pause(); c.on('error', () => {}); held.push(c); });
  await new Promise((r) => stuck.listen(sock, r));
  let stuckClosed = false;
  const closeStuck = () => new Promise((r) => { if (stuckClosed) return r(); stuckClosed = true; held.forEach((c) => c.destroy()); stuck.close(() => r()); });
  t.after(closeStuck);

  relay.queue.push({ id: 77, seq: 1, text: 'x'.repeat(4 * 1024 * 1024), deviceName: 'd' });
  const b = startBridge(t, { relay, sock, home, env: { LOCALAI_CHAT_WRITE_TIMEOUT_MS: '200' } });
  await until(() => log(home).includes('lost 77'), 'lost log line', 15000);
  const l = log(home);
  assert.equal((l.match(/inject failed 77/g) || []).length, 3);
  assert.equal(b.exited, null, 'bridge keeps running after one lost message');

  // Swap in a normal listener; the next message is delivered.
  await closeStuck();
  try { fs.unlinkSync(sock); } catch {}
  let got = '';
  const live = net.createServer((c) => { c.on('data', (d) => { got += d; }); c.on('error', () => {}); });
  await new Promise((r) => live.listen(sock, r));
  t.after(() => new Promise((r) => live.close(r)));
  relay.queue.push({ id: 78, seq: 2, text: 'next', deviceName: 'd' });
  await until(() => got.includes('[LocalAI web · d] next'), 'next message delivered');
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

test('normal path: each message is acknowledged and injected exactly once', async (t) => {
  const relay = await fakeRelay(t);
  const inbox = await fakeInbox(t);
  const home = makeHome(t);
  relay.queue.push({ id: 'sess:1', seq: 1, text: 'one', deviceName: 'd' }, { id: 'sess:2', seq: 2, text: 'two', deviceName: 'd' });
  startBridge(t, { relay, sock: inbox.sock, home });
  await until(() => inbox.conns.length >= 2 && inbox.conns[1].closed, 'two injections');
  await sleep(500);
  assert.deepEqual(inbox.conns.map((c, i) => inbox.lines(i)[1].message.content), ['[LocalAI web · d] one', '[LocalAI web · d] two']);
  assert.equal(relay.requests.filter((r) => r.url === '/api/claude/chat/inbox/ack').length, 1);
  assert.ok(!log(home).includes('ack missing'));
});

test('an ack that fails (500) injects nothing and logs "ack missing"; the bridge keeps polling', async (t) => {
  const relay = await fakeRelay(t);
  const inbox = await fakeInbox(t);
  const home = makeHome(t);
  relay.ackStatus = 500;
  relay.queue.push({ id: 'sess:7', seq: 7, text: 'not yet', deviceName: 'd' });
  const b = startBridge(t, { relay, sock: inbox.sock, home });
  await until(() => log(home).includes('ack missing sess:7'), 'ack missing logged');
  assert.ok(log(home).includes('acked 0/1'));
  await sleep(400);
  assert.equal(inbox.conns.length, 0, 'an unacknowledged message is not injected');
  assert.equal(b.exited, null);
  // The relay requeues it after the lease and offers it again; this time the ack succeeds.
  relay.ackStatus = 200;
  relay.queue.push({ id: 'sess:7', seq: 7, text: 'not yet', deviceName: 'd' });
  await until(() => inbox.conns.length >= 1 && inbox.conns[0].closed, 'injection after a good ack');
  await sleep(300);
  assert.equal(inbox.conns.length, 1);
  assert.equal(inbox.lines(0)[1].message.content, '[LocalAI web · d] not yet');
});

test('an id missing from "acked" is not injected; the acked ones are', async (t) => {
  const relay = await fakeRelay(t);
  const inbox = await fakeInbox(t);
  const home = makeHome(t);
  relay.ackOmit.add('sess:2');
  relay.queue.push({ id: 'sess:1', seq: 1, text: 'kept', deviceName: 'd' }, { id: 'sess:2', seq: 2, text: 'expired', deviceName: 'd' }, { id: 'sess:3', seq: 3, text: 'also kept', deviceName: 'd' });
  startBridge(t, { relay, sock: inbox.sock, home });
  await until(() => inbox.conns.length >= 2 && inbox.conns[1].closed, 'two injections');
  await sleep(400);
  assert.deepEqual(inbox.conns.map((c, i) => inbox.lines(i)[1].message.content), ['[LocalAI web · d] kept', '[LocalAI web · d] also kept']);
  assert.ok(log(home).includes('acked 2/3'));
  assert.ok(log(home).includes('ack missing sess:2'));
  assert.ok(!log(home).includes('ack missing sess:1'));
});

// ---- HTTPS: the relay behind Caddy, trusted through the CA the installer fetched -------------------------------------
const tlsFixture = makeTlsFixture();
const tlsSkip = tlsFixture ? false : OPENSSL_MISSING;
test.after(() => tlsFixture?.cleanup());
const writeConfig = (home, config) => fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));

test('HTTPS: config.json url + CA -> the bridge verifies the relay with that CA and works', { skip: tlsSkip }, async (t) => {
  const relay = await fakeRelay(t, { tls: tlsFixture });
  const inbox = await fakeInbox(t);
  const home = makeHome(t);
  writeConfig(home, { url: relay.url, ca: tlsFixture.caPath });
  relay.queue.push({ id: 21, seq: 1, text: 'over tls', deviceName: 'Phone' });
  // No LOCALAI_URL: the URL comes from config.json.
  startBridge(t, { relay, sock: inbox.sock, home, env: { LOCALAI_URL: undefined, NODE_EXTRA_CA_CERTS: undefined } });
  await until(() => inbox.conns.length >= 1 && inbox.conns[0].closed, 'injection over https');
  assert.equal(inbox.lines(0)[1].message.content, '[LocalAI web · Phone] over tls');
  const announce = relay.requests.find((r) => r.url === '/api/claude/chat/announce');
  assert.equal(announce.headers['x-localai-mac-key'], 'the-mac-key');
  assert.equal(relay.tlsFailures, 0);
});

test('HTTPS: no CA configured -> the handshake fails, nothing is sent, and the log says why', { skip: tlsSkip }, async (t) => {
  const relay = await fakeRelay(t, { tls: tlsFixture });
  const inbox = await fakeInbox(t);
  const home = makeHome(t);
  writeConfig(home, { url: relay.url });
  startBridge(t, { relay, sock: inbox.sock, home, env: { LOCALAI_URL: undefined, NODE_EXTRA_CA_CERTS: undefined } });
  await until(() => /relay error tls \S+: the certificate of https:\/\/127\.0\.0\.1:\d+ is not trusted \(CA: none configured\)/.test(log(home)), 'tls error logged');
  assert.equal(relay.requests.length, 0, 'the Mac key never left over an unverified connection');
  assert.match(log(home), /install\.sh/);
});

test('HTTPS: a different CA is refused (mismatched certificate)', { skip: tlsSkip }, async (t) => {
  const relay = await fakeRelay(t, { tls: tlsFixture });
  const inbox = await fakeInbox(t);
  const home = makeHome(t);
  writeConfig(home, { url: relay.url, ca: tlsFixture.otherCaPath });
  startBridge(t, { relay, sock: inbox.sock, home, env: { LOCALAI_URL: undefined } });
  await until(() => log(home).includes(`is not trusted (CA: ${tlsFixture.otherCaPath})`), 'tls error logged');
  assert.equal(relay.requests.length, 0);
});

test('HTTPS: a configured CA file that is missing fails clearly instead of falling back to system roots', { skip: tlsSkip }, async (t) => {
  const relay = await fakeRelay(t, { tls: tlsFixture });
  const inbox = await fakeInbox(t);
  const home = makeHome(t);
  const missing = path.join(home, 'nope.crt');
  writeConfig(home, { url: relay.url, ca: missing });
  startBridge(t, { relay, sock: inbox.sock, home, env: { LOCALAI_URL: undefined } });
  await until(() => log(home).includes(`relay error CA file unreadable: ${missing}`), 'ca error logged');
  assert.equal(relay.requests.length, 0);
});

test('LOCALAI_URL overrides config.json', async (t) => {
  const relay = await fakeRelay(t);
  const inbox = await fakeInbox(t);
  const home = makeHome(t);
  writeConfig(home, { url: 'https://127.0.0.1:9', ca: path.join(home, 'nope.crt') });
  startBridge(t, { relay, sock: inbox.sock, home });
  await until(() => relay.requests.some((r) => r.url === '/api/claude/chat/announce'), 'announce via the env URL');
});

test('an unreadable config.json stops the bridge from sending anything (no fallback to the HTTP default)', async (t) => {
  const relay = await fakeRelay(t);
  const inbox = await fakeInbox(t);
  const home = makeHome(t);
  fs.writeFileSync(path.join(home, 'config.json'), '{"url": "https://10.0.0.21", ');
  startBridge(t, { relay, sock: inbox.sock, home }); // even with LOCALAI_URL set
  await until(() => /relay error config\.json unreadable/.test(log(home)), 'config error logged');
  await sleep(200);
  assert.equal(relay.requests.length, 0);
});
