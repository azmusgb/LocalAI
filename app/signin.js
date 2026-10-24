'use strict';

// Sign-in for every API route (docs/superpowers/specs/2026-10-18-sign-in-design.md). Report-only by default (A7): every API
// request without a device is counted by caller, so Health can list who would be locked out, and only the GUARDED routes
// below are refused. LOCALAI_SIGN_IN=required in stack.env refuses every API route that isn't open.
// Signed in: a paired device's cookie (claude-chat.js, A1) or the Mac key (A5). Always allowed: requests that did not
// come through Caddy (no X-Forwarded-For: the host itself or the Docker network, A4) and the routes a device needs
// before it is paired (A2). Pages and static files are not checked: the pairing screen has to load.
// routeKeys: { path: req => bool } signs in a caller for that one path only (the Workshop display's feed key).

const OPEN = new Set(['/healthz', '/api/claude/chat/pair-request', '/api/claude/chat/pair-status', '/api/claude/chat/whoami', '/api/display/pair']);
// Refused without a device even in report mode: these run code (node/npm/git), write or list the mounted workspace,
// fetch arbitrary URLs from inside the container, approve or stage changes, or post and clear alerts. Unsigned, any LAN
// or tailnet device could use them (docs/SECURITY.md). The host's own requests and the display's key still pass.
const GUARDED = [
  /^\/api\/workbench\//, /^\/api\/computer\//, /^\/api\/browser\/fetch$/, /^\/api\/http-check$/, /^\/api\/repo\/inspect$/,
  /^\/api\/changes(\/|$)/, /^\/api\/approvals\/(create|decide)$/, /^\/api\/display\/approvals\/decide$/,
  /^\/api\/engineering\/start$/, /^\/api\/issues\/prepare-change$/, /^\/api\/improve\/handoff$/, /^\/api\/powershell\//,
  /^\/api\/notifications\/(system|seed)$/, /^\/api\/signin\/report\/clear$/,
];
const guarded = p => GUARDED.some(re => re.test(p));
const KEEP = 50; // callers listed
const SAVE_MS = 30000;
const REPORT_KEY = 'signin/report';

function callerIp(req) { return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim(); }
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

function createSignIn({ storage, signedIn, routeKeys = {}, required = process.env.LOCALAI_SIGN_IN === 'required', now = () => Date.now() }) {
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

  // 'host' | 'open' | 'signed-in' | 'refused': what the request is, under sign-in. A refused one is recorded; blocks()
  // says whether to turn it away.
  function check(req, p) {
    if (!p.startsWith('/api/') && p !== '/healthz') return 'open';
    if (!req.headers['x-forwarded-for']) return 'host';
    if (OPEN.has(p)) return 'open';
    if (signedIn(req) || routeKeys[p]?.(req)) return 'signed-in';
    const ip = callerIp(req) || 'unknown', kind = kindOf(req.headers['user-agent']), key = `${ip}|${kind}`, t = now();
    const c = report.callers.get(key) || { ip, kind, count: 0, firstAt: t };
    report.callers.set(key, { ...c, count: c.count + 1, lastAt: t, lastPath: p.slice(0, 120), lastMethod: req.method });
    dirty = true; save();
    return 'refused';
  }
  function blocks(result, p) { return result === 'refused' && (required || guarded(p)); }
  function apiReport(req, res, json) {
    save(true);
    json(res, 200, { mode: required ? 'required' : 'report', guarded: GUARDED.map(re => re.source), since: new Date(report.since).toISOString(),
      callers: [...report.callers.values()].sort((a, b) => b.lastAt - a.lastAt).slice(0, KEEP)
        .map(c => ({ ip: c.ip, kind: c.kind, count: c.count, firstAt: new Date(c.firstAt).toISOString(), lastAt: new Date(c.lastAt).toISOString(), lastPath: c.lastPath, lastMethod: c.lastMethod })) });
  }
  function clear() { report.since = now(); report.callers.clear(); dirty = true; save(true); }
  return { check, blocks, apiReport, clear, flush: () => save(true) };
}

module.exports = { createSignIn, kindOf, guarded, OPEN };
