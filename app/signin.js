'use strict';

// Sign-in for every API route (docs/superpowers/specs/2026-10-18-sign-in-design.md). Report-only by default (A7): every API
// request without a device is counted by caller, so Health can list who would be locked out, and only the GUARDED routes
// below are refused. LOCALAI_SIGN_IN=required in stack.env refuses every API route that isn't open.
// Signed in: a paired device's cookie (claude-chat.js, A1) or the Mac key (A5). Always allowed: requests that did not
// come through Caddy from the host itself (no X-Forwarded-For, from loopback or the network's gateway, A4) and the routes a device needs
// before it is paired (A2). Pages and static files are not checked: the pairing screen has to load.
// routeKeys: { path: req => bool } signs in a caller for that one path only (the Workshop display's feed key).

const OPEN = new Set(['/healthz', '/api/claude/chat/pair-request', '/api/claude/chat/pair-status', '/api/claude/chat/whoami', '/api/display/pair']);
// Refused without a device even in report mode: these run code (node/npm/git), write or list the mounted workspace,
// fetch arbitrary URLs from inside the container, approve or stage changes, or post and clear alerts. Unsigned, any LAN
// or tailnet device could use them (docs/SECURITY.md). The host's own requests and the display's key still pass.
const GUARDED = [
  /^\/api\/workbench\//, /^\/api\/computer\//, /^\/api\/browser\/fetch$/, /^\/api\/actions\/http-check$/, /^\/api\/repo\/inspect$/,
  /^\/api\/changes(\/|$)/, /^\/api\/approvals\/(create|decide)$/, /^\/api\/display\/approvals\/decide$/, /^\/api\/display\/lab\/verdict$/,
  /^\/api\/engineering\//, /^\/api\/issues\/prepare-change$/, /^\/api\/powershell\//,
  /^\/api\/notifications\/(system|seed|update)$/, /^\/api\/signin\/report\/clear$/, /^\/api\/display\/notify$/,
  // It hands out the Workshop display's sign-in code.
  /^\/api\/workshop\/portal-code$/,
  // The owner's suggested facts: reading them shows what was said in chats; deciding writes a fact into memory.
  /^\/api\/facts\/suggestions(\/decide)?$/,
  // The owner's past work (A7 sign-in): reading, deleting or asking about journal entries.
  /^\/api\/journal(\/(delete|ask))?$/,
  // Research intake: the source list and what was read show what the owner follows; the writes start outbound fetches.
  /^\/api\/research\//,
  // Claude's queue: handing a request or an item to Claude, adding an idea, promoting a signal, or changing an item's
  // decision or votes. Each lands on the board a Claude session works from, so one left open would bypass the others.
  /^\/api\/improve\/(handoff|item|idea|signal)$/, /^\/api\/claude\/findings\/(decision|vote)$/,
  // Reporting to that board: the Mac's hooks and Claude sessions send the Mac key. An unsigned finding would reach
  // /api/claude/priorities and the phone, or pre-plant an id a session later updates.
  /^\/api\/claude\/(findings|events)$/,
  // Reading that board: session titles and folders, findings, handed-over requests and the owner's notes.
  /^\/api\/claude\/(board|priorities)$/, /^\/api\/improve\/items$/,
];
// Refused without a device when they change something (any method but GET/HEAD): starting agent runs, writing
// workbooks through the GridCraft bridge, importing or deleting library data, and the display's alert settings.
const GUARDED_WRITES = [
  /^\/api\/agents\/(dispatch|run|missions\/start|specialist\/run)$/, /^\/api\/gridcraft\/(new|cell|upload|run|open|decide)$/,
  /^\/api\/knowledge\/import$/, /^\/api\/library\/delete$/, /^\/api\/items\/delete$/, /^\/api\/display\/alerts$/,
  // Siblings of the above: retrying, cancelling, filing or rating runs, deleting knowledge, chats and memory, pulling or deleting models.
  /^\/api\/runs\/(retry|cancel|update|feedback)$/, /^\/api\/knowledge\/delete$/, /^\/api\/conversations\/delete$/,
  /^\/api\/memory\/(add|update|delete)$/, /^\/api\/models\/(pull|delete|routing)$/,
  // The print lab's sync and photo uploads: only the Mac writes them (app/print-lab.js also checks its key).
  /^\/api\/lab\//,
  // System Atlas: asking runs a local model for minutes; a Goose brief writes a file on the PC; a snapshot fetches
  // a repository and scans it.
  /^\/api\/atlas\/(ask|goose|snapshot)$/,
];
const guarded = (p, method = 'POST') => GUARDED.some(re => re.test(p))
  || (method !== 'GET' && method !== 'HEAD' && GUARDED_WRITES.some(re => re.test(p)));
const KEEP = 50; // callers listed
const SAVE_MS = 30000;
const REPORT_KEY = 'signin/report';

function callerIp(req) { return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim(); }

// The host itself (A4): requests that reach the appliance without Caddy (no X-Forwarded-For) from loopback or the
// container network's gateway, which is the address the Windows host's own requests arrive from through the published
// port. Not any address without Caddy: n8n, SearXNG and the Ollama proxy share the Docker network and must sign in like
// everyone else. LOCALAI_HOST_ADDRESSES (comma-separated) overrides the gateway found in /proc/net/route.
const plain = (a) => String(a || '').replace(/^::ffff:/, '');
function defaultGateway(routeFile = '/proc/net/route') {
  try {
    for (const line of require('node:fs').readFileSync(routeFile, 'utf8').split('\n').slice(1)) {
      const [, dest, gw] = line.trim().split(/\s+/);
      if (dest === '00000000' && gw && gw !== '00000000') return gw.match(/../g).reverse().map((h) => parseInt(h, 16)).join('.');
    }
  } catch { /* not Linux, or no route table: loopback only */ }
  return null;
}
function hostAddresses(env = process.env, routeFile) {
  const set = new Set(['127.0.0.1', '::1']);
  const listed = String(env.LOCALAI_HOST_ADDRESSES || '').split(',').map((a) => a.trim()).filter(Boolean);
  for (const a of listed.length ? listed : [defaultGateway(routeFile)]) if (a) set.add(plain(a));
  return set;
}
function kindOf(ua) {
  ua = String(ua || '');
  if (/watchOS|Watch\d/.test(ua)) return 'Apple Watch';
  if (/iPhone|iPad|iPod/.test(ua)) return /iPad/.test(ua) ? 'iPad' : 'iPhone';
  if (/Android/.test(ua)) return 'Android';
  if (/Shortcuts|CFNetwork|Siri/i.test(ua)) return 'Shortcuts';
  if (/ESP32|Workshop-Display/i.test(ua)) return 'Workshop display';
  if (/Macintosh|Mac OS X/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  if (/curl|python|node|PowerShell|Go-http|okhttp/i.test(ua)) return 'Script';
  return ua ? 'Other' : 'No browser';
}

function createSignIn({ storage, signedIn, routeKeys = {}, required = process.env.LOCALAI_SIGN_IN === 'required', hosts = hostAddresses(), now = () => Date.now() }) {
  const saved = storage.readSetting(REPORT_KEY, null);
  const report = { since: saved?.since || now(), callers: new Map((Array.isArray(saved?.callers) ? saved.callers : []).map(c => [`${c.ip}|${c.kind}`, c])) };
  let dirty = false, lastSave = 0;
  function save(force = false) {
    if (!dirty || (!force && now() - lastSave < SAVE_MS)) return;
    const callers = [...report.callers.values()].sort((a, b) => b.lastAt - a.lastAt).slice(0, KEEP);
    report.callers = new Map(callers.map(c => [`${c.ip}|${c.kind}`, c]));
    storage.writeSetting(REPORT_KEY, { since: report.since, callers });
    dirty = false; lastSave = now();
  }

  // 'host' | 'open' | 'signed-in' | 'route-key' | 'refused': what the request is, under sign-in. 'signed-in' is a paired
  // device or the Mac key; 'route-key' is a key that signs a caller in for that one path only (the display's, Pi Hub's).
  // A refused one is recorded; blocks() says whether to turn it away. Callers may read the result too: owner-only work
  // (owner-fact suggestions after a chat) takes only 'host' and 'signed-in'.
  function check(req, p) {
    if (!p.startsWith('/api/') && p !== '/healthz') return 'open';
    if (!req.headers['x-forwarded-for'] && hosts.has(plain(req.socket?.remoteAddress))) return 'host';
    if (OPEN.has(p)) return 'open';
    if (signedIn(req)) return 'signed-in';
    if (routeKeys[p]?.(req)) return 'route-key';
    const ip = callerIp(req) || 'unknown', kind = kindOf(req.headers['user-agent']), key = `${ip}|${kind}`, t = now();
    const c = report.callers.get(key) || { ip, kind, count: 0, firstAt: t };
    report.callers.set(key, { ...c, count: c.count + 1, lastAt: t, lastPath: p.slice(0, 120), lastMethod: req.method });
    dirty = true; save();
    return 'refused';
  }
  function blocks(result, p, method) { return result === 'refused' && (required || guarded(p, method)); }
  function apiReport(req, res, json) {
    save(true);
    json(res, 200, { mode: required ? 'required' : 'report', guarded: GUARDED.map(re => re.source), guardedWrites: GUARDED_WRITES.map(re => re.source), since: new Date(report.since).toISOString(),
      callers: [...report.callers.values()].sort((a, b) => b.lastAt - a.lastAt).slice(0, KEEP)
        .map(c => ({ ip: c.ip, kind: c.kind, count: c.count, firstAt: new Date(c.firstAt).toISOString(), lastAt: new Date(c.lastAt).toISOString(), lastPath: c.lastPath, lastMethod: c.lastMethod })) });
  }
  function clear() { report.since = now(); report.callers.clear(); dirty = true; save(true); }
  return { check, blocks, apiReport, clear, flush: () => save(true), mode: required ? 'required' : 'report' };
}

module.exports = { createSignIn, kindOf, guarded, hostAddresses, defaultGateway, OPEN };
