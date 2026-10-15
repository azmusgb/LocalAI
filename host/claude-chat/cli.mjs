// LocalAI chat CLI: pair devices, list/revoke them, and check the Mac side. Outbound HTTP only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = process.env.LOCALAI_CHAT_HOME || path.join(os.homedir(), '.claude', 'localai-chat');
const BASE = (process.env.LOCALAI_URL || 'http://10.0.0.21:3080').replace(/\/+$/, '');
const API = `${BASE}/api/claude/chat`;
const INSTALL_HINT = 'run host/claude-chat/install.sh from the LocalAI repo';

function die(msg) { console.error(`localai-chat: ${msg}`); process.exit(1); }

function readKey() {
  try { return fs.readFileSync(path.join(HOME, 'mac.key'), 'utf8').trim(); } catch { return ''; }
}
function needKey() {
  const key = readKey();
  if (!key) die(`no Mac key at ${path.join(HOME, 'mac.key')}; ${INSTALL_HINT}`);
  return key;
}

async function call(method, route, key, body) {
  let res;
  try {
    res = await fetch(`${API}${route}`, {
      method,
      headers: { 'X-LocalAI-Mac-Key': key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000)
    });
  } catch (e) { die(`cannot reach ${BASE} (${e.cause?.code || e.message})`); }
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}
function fail(r, what) {
  if (r.status === 401) die(`the relay rejected the Mac key; re-run the installer to push its hash`);
  die(`${what} failed (HTTP ${r.status}${r.data?.error ? `: ${r.data.error}` : ''})`);
}
const when = (ms) => (ms ? new Date(ms).toLocaleString() : 'never');

async function pair(args) {
  const [code, ...nameParts] = args;
  if (!code) die('usage: localai-chat pair <code> [name...]');
  const key = needKey();
  const body = { code };
  if (nameParts.length) body.name = nameParts.join(' ');
  const r = await call('POST', '/pair/approve', key, body);
  if (r.status === 404) die('unknown or expired code');
  if (r.status !== 200) fail(r, 'pairing');
  console.log(`Paired device ${r.data.deviceId}`);
}

async function devices() {
  const r = await call('GET', '/devices', needKey());
  if (r.status !== 200) fail(r, 'listing devices');
  if (!r.data.items.length) return console.log('No paired devices.');
  for (const d of r.data.items) console.log(`${d.id}  ${d.name}  paired ${when(d.pairedAt)}  last seen ${when(d.lastSeenAt)}`);
}

async function revoke(args) {
  if (!args[0]) die('usage: localai-chat revoke <id>');
  const r = await call('POST', '/devices/revoke', needKey(), { id: args[0] });
  if (r.status === 404) die(`unknown device ${args[0]}`);
  if (r.status !== 200) fail(r, 'revoke');
  console.log(`Revoked ${args[0]}`);
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
async function status() {
  const key = readKey();
  console.log(`Mac key:   ${key ? 'present' : `missing (${INSTALL_HINT})`}`);
  let reachable = false, accepted = null;
  try {
    const res = await fetch(`${API}/devices`, { headers: key ? { 'X-LocalAI-Mac-Key': key } : {}, signal: AbortSignal.timeout(5000) });
    reachable = true;
    if (key) accepted = res.status === 200;
  } catch { /* unreachable */ }
  console.log(`Relay:     ${reachable ? `reachable (${BASE})` : `unreachable (${BASE})`}`);
  console.log(`Key:       ${accepted === null ? (key ? 'unknown (relay unreachable)' : 'n/a') : accepted ? 'accepted' : 'rejected (re-run the installer)'}`);
  const runDir = path.join(HOME, 'run');
  const bridges = [];
  let names = [];
  try { names = fs.readdirSync(runDir).filter((n) => n.endsWith('.pid')); } catch { /* none */ }
  for (const n of names) {
    const id = n.slice(0, -4);
    const pid = parseInt(fs.readFileSync(path.join(runDir, n), 'utf8'), 10);
    if (!pid || !alive(pid)) continue;
    let last = 'none yet';
    try { last = fs.readFileSync(path.join(runDir, `${id}.last`), 'utf8').trim() || last; } catch { /* none */ }
    bridges.push(`  ${id}  pid ${pid}  last injection ${last}`);
  }
  console.log(bridges.length ? `Bridges:\n${bridges.join('\n')}` : 'Bridges:   none running');
}

const [cmd, ...rest] = process.argv.slice(2);
const commands = { pair, devices, revoke, status };
if (!commands[cmd]) die('usage: localai-chat pair <code> [name...] | devices | revoke <id> | status');
await commands[cmd](rest);
