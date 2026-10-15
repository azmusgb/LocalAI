// LocalAI Claude chat bridge: relays web messages from the LocalAI appliance
// into a Claude Code session's messaging socket. Outbound HTTP(S) only (see relay.mjs).
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describeError, loadConfig, request } from './relay.mjs';

const [sessionId, title = '', cwd = ''] = process.argv.slice(2);
const HOME = process.env.LOCALAI_CHAT_HOME || path.join(os.homedir(), '.claude', 'localai-chat');
const RELAY = loadConfig(HOME);
const SOCKET = process.env.CLAUDE_CODE_MESSAGING_SOCKET || '';
const TOKEN = process.env.CLAUDE_CODE_MESSAGING_TOKEN || '';
const INJECT_GAP = Number(process.env.LOCALAI_CHAT_INJECT_GAP_MS ?? 1000);
const BACKOFF_START = Number(process.env.LOCALAI_CHAT_BACKOFF_MS ?? 1000);
const BACKOFF_MAX = 30000;
const WRITE_TIMEOUT = Number(process.env.LOCALAI_CHAT_WRITE_TIMEOUT_MS ?? 5000);
const RETRY_GAP = Math.min(500, INJECT_GAP);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logFile = path.join(HOME, 'bridge.log');
function log(msg) {
  try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${msg}\n`); } catch { /* ignore */ }
}

const runDir = path.join(HOME, 'run');
const pidFile = path.join(runDir, `${sessionId}.pid`);
const lastFile = path.join(runDir, `${sessionId}.last`);
// One bridge per messaging socket: /clear starts a new session id in the same Claude process (same socket).
const lockFile = path.join(runDir, `sock-${crypto.createHash('sha256').update(SOCKET).digest('hex').slice(0, 16)}.json`);

function readLock() {
  try {
    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    return lock && Number.isInteger(lock.pid) && lock.pid > 0 ? lock : { pid: 0, sessionId: '' };
  } catch (e) { return e.code === 'ENOENT' ? null : { pid: 0, sessionId: '' }; }
}
function cleanup() {
  try {
    if (fs.readFileSync(pidFile, 'utf8').trim() === String(process.pid)) fs.unlinkSync(pidFile);
  } catch { /* ignore */ }
  try { if (readLock()?.pid === process.pid) fs.unlinkSync(lockFile); } catch { /* ignore */ }
}
function quit(code = 0) { cleanup(); process.exit(code); }
process.on('SIGTERM', () => { log('SIGTERM'); quit(0); });
process.on('SIGINT', () => { log('SIGINT'); quit(0); });

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Take the socket lock atomically ('wx'). A live holder for this session wins (we exit); a live holder for another
// session on this socket is the bridge of a cleared conversation and is told to stop; a dead or unreadable lock is cleared.
async function takeSocketLock() {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, sessionId }), { flag: 'wx' });
      return;
    } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const lock = readLock();
    if (!lock) continue;
    if (lock.pid && lock.pid !== process.pid && alive(lock.pid)) {
      if (lock.sessionId === sessionId) process.exit(0);
      log(`replacing bridge ${lock.pid} for session ${lock.sessionId} on this socket`);
      try { process.kill(lock.pid, 'SIGTERM'); } catch { /* gone */ }
      const end = Date.now() + 2000;
      while (alive(lock.pid) && Date.now() < end) await sleep(50);
      if (alive(lock.pid)) { try { process.kill(lock.pid, 'SIGKILL'); } catch { /* gone */ } }
    }
    // Clear the stale lock, but only if it still names the holder we examined.
    try { if (readLock()?.pid === lock.pid) fs.unlinkSync(lockFile); } catch { /* raced; retry */ }
  }
  log('socket lock busy; exiting');
  process.exit(0);
}

let macKey = '';
async function setup() {
  fs.mkdirSync(HOME, { recursive: true });
  if (!sessionId) { log('missing session id'); process.exit(1); }
  try { macKey = fs.readFileSync(path.join(HOME, 'mac.key'), 'utf8').trim(); } catch { macKey = ''; }
  if (!macKey) { log('mac key missing; exiting'); process.exit(1); }
  if (!SOCKET || !TOKEN) { log('messaging socket/token missing; exiting'); process.exit(1); }
  fs.mkdirSync(runDir, { recursive: true });
  try {
    const old = parseInt(fs.readFileSync(pidFile, 'utf8'), 10);
    if (old > 0 && old !== process.pid && alive(old)) process.exit(0);
  } catch { /* no pidfile */ }
  await takeSocketLock();
  fs.writeFileSync(pidFile, String(process.pid));
  log(`started session ${sessionId} pid ${process.pid}`);
  if (RELAY.configError) log(RELAY.configError);
}

const headers = (extra = {}) => ({ 'X-LocalAI-Mac-Key': macKey, ...extra });

async function announce() {
  const res = await request(RELAY, 'POST', '/api/claude/chat/announce', {
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ sessionId, title, cwd }),
  });
  if (!res.ok) {
    log(res.status === 401 ? 'mac key rejected' : `announce failed ${res.status}`);
    throw new Error(`announce ${res.status}`);
  }
}

function writeSocket(item) {
  const who = item.deviceName || 'web';
  const auth = JSON.stringify({ type: 'auth', token: TOKEN });
  const user = JSON.stringify({ type: 'user', message: { role: 'user', content: `[LocalAI web · ${who}] ${item.text}` } });
  return new Promise((resolve) => {
    let settled = false;
    const done = (err) => { if (!settled) { settled = true; clearTimeout(timer); sock.destroy(); resolve(err || null); } };
    let connected = false;
    const sock = net.createConnection(SOCKET);
    const timer = setTimeout(() => done(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), WRITE_TIMEOUT);
    sock.on('error', (e) => { if (!connected) noteConnect(e); done(e); });
    sock.on('connect', () => { connected = true; noteConnect(null); sock.write(`${auth}\n${user}\n`, (e) => { if (e) done(e); else sock.end(); }); });
    sock.on('close', () => done(null));
  });
}

// Consecutive ENOENT/ECONNREFUSED connects (probes and injections alike); any successful connect resets it.
let refusals = 0;
function noteConnect(err) {
  if (!err) { refusals = 0; return; }
  if (err.code !== 'ENOENT' && err.code !== 'ECONNREFUSED') return;
  if (++refusals >= 3) { log('socket unreachable; exiting'); quit(0); }
}

// Liveness probe: connect and immediately hang up, writing nothing.
function probe() {
  return new Promise((resolve) => {
    const sock = net.createConnection(SOCKET);
    const timer = setTimeout(() => { sock.destroy(); resolve(); }, 2000);
    const end = () => { clearTimeout(timer); sock.destroy(); resolve(); };
    sock.on('connect', () => { noteConnect(null); end(); });
    sock.on('error', (e) => { noteConnect(e); end(); });
  });
}

let lastInject = 0;

async function inject(item) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (!fs.existsSync(SOCKET)) { log('socket gone; exiting'); quit(0); }
    const wait = lastInject + INJECT_GAP - Date.now();
    if (wait > 0) await sleep(wait);
    const err = await writeSocket(item);
    lastInject = Date.now();
    if (!err) {
      try { fs.writeFileSync(lastFile, new Date().toISOString()); } catch { /* ignore */ }
      log(`injected ${item.id}`);
      return;
    }
    log(`inject failed ${item.id} attempt ${attempt} ${err.code || err.message}`);
    if (attempt < 3) await sleep(RETRY_GAP);
  }
  log(`lost ${item.id}`);
}

// The inbox leases the messages it returns; acknowledging them marks them delivered. Only acked ids are injected, so a
// message whose ack failed (or whose lease already ran out) is left for the relay to offer again instead of being
// injected twice. Returns the set of acked ids (empty on any failure).
async function ack(items) {
  const ids = items.map((i) => i.id);
  let acked = new Set();
  try {
    const res = await request(RELAY, 'POST', '/api/claude/chat/inbox/ack', {
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ sessionId, ids }),
    });
    if (res.ok) {
      const data = res.json();
      if (Array.isArray(data.acked)) acked = new Set(data.acked);
    } else {
      log(res.status === 401 ? 'mac key rejected' : `ack failed ${res.status}`);
    }
  } catch (e) {
    log(`ack error ${describeError(RELAY, e)}`.trim());
  }
  const ok = ids.filter((id) => acked.has(id));
  log(`acked ${ok.length}/${ids.length}`);
  for (const id of ids) if (!acked.has(id)) log(`ack missing ${id}`);
  return acked;
}

async function main() {
  await setup();
  let backoff = BACKOFF_START;
  let announced = false;
  for (;;) {
    if (!fs.existsSync(SOCKET)) { log('socket gone; exiting'); quit(0); }
    await probe();
    try {
      if (!announced) { await announce(); announced = true; log('announced'); }
      const res = await request(RELAY, 'GET', `/api/claude/chat/inbox?sessionId=${encodeURIComponent(sessionId)}&wait=25`, {
        headers: headers(),
        timeoutMs: 35000,
      });
      if (!res.ok) {
        log(res.status === 401 ? 'mac key rejected' : `inbox failed ${res.status}`);
        announced = false;
        await sleep(backoff);
        backoff = Math.min(backoff * 2, BACKOFF_MAX);
        continue;
      }
      const data = res.json();
      backoff = BACKOFF_START;
      const items = Array.isArray(data.items) ? data.items : [];
      if (items.length) log(`received ${items.length}`);
      if (!items.length) continue;
      const acked = await ack(items);
      for (const item of items) if (acked.has(item.id)) await inject(item);
    } catch (e) {
      log(`relay error ${describeError(RELAY, e)}`.trim());
      announced = false;
      await sleep(backoff);
      backoff = Math.min(backoff * 2, BACKOFF_MAX);
    }
  }
}

main().catch((e) => { log(`fatal ${e && e.message}`); quit(1); });
