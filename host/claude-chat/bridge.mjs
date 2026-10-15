// LocalAI Claude chat bridge: relays web messages from the LocalAI appliance
// into a Claude Code session's messaging socket. Outbound HTTP only.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const [sessionId, title = '', cwd = ''] = process.argv.slice(2);
const HOME = process.env.LOCALAI_CHAT_HOME || path.join(os.homedir(), '.claude', 'localai-chat');
const URL_BASE = (process.env.LOCALAI_URL || 'http://10.0.0.21:3080').replace(/\/+$/, '');
const SOCKET = process.env.CLAUDE_CODE_MESSAGING_SOCKET || '';
const TOKEN = process.env.CLAUDE_CODE_MESSAGING_TOKEN || '';
const INJECT_GAP = Number(process.env.LOCALAI_CHAT_INJECT_GAP_MS ?? 1000);
const BACKOFF_START = Number(process.env.LOCALAI_CHAT_BACKOFF_MS ?? 1000);
const BACKOFF_MAX = 30000;
const RETRY_GAP = Math.min(500, INJECT_GAP);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logFile = path.join(HOME, 'bridge.log');
function log(msg) {
  try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${msg}\n`); } catch { /* ignore */ }
}

const runDir = path.join(HOME, 'run');
const pidFile = path.join(runDir, `${sessionId}.pid`);
const lastFile = path.join(runDir, `${sessionId}.last`);

function cleanup() {
  try {
    if (fs.readFileSync(pidFile, 'utf8').trim() === String(process.pid)) fs.unlinkSync(pidFile);
  } catch { /* ignore */ }
}
function quit(code = 0) { cleanup(); process.exit(code); }
process.on('SIGTERM', () => { log('SIGTERM'); quit(0); });
process.on('SIGINT', () => { log('SIGINT'); quit(0); });

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

let macKey = '';
function setup() {
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
  fs.writeFileSync(pidFile, String(process.pid));
  log(`started session ${sessionId} pid ${process.pid}`);
}

const headers = (extra = {}) => ({ 'X-LocalAI-Mac-Key': macKey, ...extra });

async function announce() {
  const res = await fetch(`${URL_BASE}/api/claude/chat/announce`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ sessionId, title, cwd }),
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 401) log('mac key rejected');
  else if (!res.ok) log(`announce failed ${res.status}`);
  await res.arrayBuffer().catch(() => {});
}

function writeSocket(item) {
  const who = item.deviceName || 'web';
  const auth = JSON.stringify({ type: 'auth', token: TOKEN });
  const user = JSON.stringify({ type: 'user', message: { role: 'user', content: `[LocalAI web · ${who}] ${item.text}` } });
  return new Promise((resolve) => {
    let settled = false;
    const done = (err) => { if (!settled) { settled = true; clearTimeout(timer); sock.destroy(); resolve(err || null); } };
    const sock = net.createConnection(SOCKET);
    const timer = setTimeout(() => done(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), 5000);
    sock.on('error', done);
    sock.on('connect', () => { sock.write(`${auth}\n${user}\n`, (e) => { if (e) done(e); else sock.end(); }); });
    sock.on('close', () => done(null));
  });
}

let connectFailures = 0;
let lastInject = 0;

async function inject(item) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (!fs.existsSync(SOCKET)) { log('socket gone; exiting'); quit(0); }
    const wait = lastInject + INJECT_GAP - Date.now();
    if (wait > 0) await sleep(wait);
    const err = await writeSocket(item);
    lastInject = Date.now();
    if (!err) {
      connectFailures = 0;
      try { fs.writeFileSync(lastFile, new Date().toISOString()); } catch { /* ignore */ }
      log(`injected ${item.id}`);
      return;
    }
    log(`inject failed ${item.id} attempt ${attempt} ${err.code || err.message}`);
    if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
      if (++connectFailures >= 3) {
        log(`lost ${item.id}`);
        log('socket unreachable; exiting');
        quit(0);
      }
    }
    if (attempt < 3) await sleep(RETRY_GAP);
  }
  log(`lost ${item.id}`);
}

async function main() {
  setup();
  let backoff = BACKOFF_START;
  let announced = false;
  for (;;) {
    if (!fs.existsSync(SOCKET)) { log('socket gone; exiting'); quit(0); }
    try {
      if (!announced) { await announce(); announced = true; }
      const res = await fetch(`${URL_BASE}/api/claude/chat/inbox?sessionId=${encodeURIComponent(sessionId)}&wait=25`, {
        headers: headers(),
        signal: AbortSignal.timeout(35000),
      });
      if (!res.ok) {
        await res.arrayBuffer().catch(() => {});
        log(res.status === 401 ? 'mac key rejected' : `inbox failed ${res.status}`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, BACKOFF_MAX);
        continue;
      }
      const data = await res.json();
      backoff = BACKOFF_START;
      const items = Array.isArray(data.items) ? data.items : [];
      if (items.length) log(`received ${items.length}`);
      for (const item of items) await inject(item);
    } catch (e) {
      log(`relay error ${e.name || ''} ${e.code || e.cause?.code || ''}`.trim());
      await sleep(backoff);
      backoff = Math.min(backoff * 2, BACKOFF_MAX);
    }
  }
}

main().catch((e) => { log(`fatal ${e && e.message}`); quit(1); });
