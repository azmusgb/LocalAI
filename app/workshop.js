'use strict';

// Services › Workshop display: the BambuHelper touchscreen beside the 3D printer (docs/WORKSHOP-DISPLAY.md).
// Local AI sends the display at most three requests, all GET: /hardware/health (is it answering; a 401 means it is up
// and its portal sign-in is on); only when LOCALAI_WORKSHOP_STATUS_TOKEN is set, /api/status/lite with that read-only
// Bearer token (firmware 12.1.0); and only when LOCALAI_WORKSHOP_CODE_TOKEN is set and the owner taps Show sign-in code,
// /api/portal-code with that Bearer token. It links to the display's own portal and never proxies it: the portal holds
// the printer controls (Stop among them) behind its own sign-in, and Local AI must not become another way to them.
// The tokens stay on the server: they are never logged, never put in an error or an answer, and child processes don't
// get them (childEnv drops every *TOKEN* variable). The sign-in code is never logged or stored either.
const { modelFetchWithTimeout } = require('./model-http');

const DEFAULT_URL = 'http://10.0.0.124';
const TIMEOUT_MS = 4000;
const MAX_BODY = 16 * 1024; // the real answers are about 500 bytes
const HEALTH_PATH = '/hardware/health';
const LITE_PATH = '/api/status/lite';
const CODE_PATH = '/api/portal-code';
const POLL_MS = 30 * 1000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;

// 10/8, 172.16/12 and 192.168/16 (the home network), or 127/8 (tests run a stand-in device on loopback).
function privateIpv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number);
  if ([a, b, c, d].some(n => n > 255)) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 127;
}

// LOCALAI_WORKSHOP_URL, or the default when it is unset or empty. Only a plain http(s) address on the home network
// (a private IPv4 address or a .local name), with no path, query or credentials, is used; anything else counts as
// not set up (null), so the appliance never fetches an outside address or offers a link to one.
function portalUrl(raw = process.env.LOCALAI_WORKSHOP_URL) {
  const text = String(raw ?? '').trim() || DEFAULT_URL;
  let u;
  try { u = new URL(text); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/') return null;
  const host = u.hostname.toLowerCase();
  const lan = privateIpv4(host) || /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+local$/.test(host);
  return lan ? u.origin : null;
}

const text = v => (typeof v === 'string' ? v.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 80) || null : null);

async function readCapped(response, limit) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) { await reader.cancel().catch(() => {}); throw new Error('Answer too large'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// What the Services card shows. The object is rebuilt field by field: nothing else the display reports (Wi-Fi
// strength, memory, printer state) passes through. signIn: false when the health route answered without a sign-in
// (the firmware of 18 Oct 2026), true when it asked for one (401: the display is up and protected), null when offline.
async function workshopStatus({ url = portalUrl(), fetchImpl = modelFetchWithTimeout, timeoutMs = TIMEOUT_MS } = {}) {
  const offline = { online: false, board: null, panel: null, screen: null, touchscreenConfigured: null, signIn: null, portalUrl: url };
  if (!url) return offline;
  try {
    const r = await fetchImpl(`${url}${HEALTH_PATH}`, { method: 'GET', headers: { Accept: 'application/json' } }, timeoutMs);
    if (r.status === 401) { await r.body?.cancel().catch(() => {}); return { ...offline, online: true, signIn: true }; }
    if (!r.ok) { await r.body?.cancel().catch(() => {}); return offline; }
    const d = JSON.parse(await readCapped(r, MAX_BODY));
    if (!d || typeof d !== 'object' || Array.isArray(d)) return offline;
    return {
      online: true,
      board: text(d.board),
      panel: text(d.panel),
      screen: Number.isSafeInteger(d.screen) ? d.screen : null,
      touchscreenConfigured: typeof d.touchscreenConfigured === 'boolean' ? d.touchscreenConfigured : null,
      signIn: false,
      portalUrl: url
    };
  } catch {
    return offline;
  }
}

// ---- printer status through the read-only token (GET /api/status/lite, firmware 12.1.0) ----
// The answer, per the firmware's docs/status-lite-token-12-1-0.md:
//   {schema:1, firmware:{…}, printers:[{slot, connection, activity, freshness, ageSeconds, progressPercent,
//    remainingMinutes, error:{code, text, canceled}|null}]}
// Only the first listed printer is used, and only these words reach the browser:
//   state: printing | paused | error | cancelled (stopped on purpose) | idle | unknown; progress (0–100) and minutesLeft only while printing or paused;
//   errorCode (the printer's own code, e.g. 0700_8010) only in error.
// access: ok | refused (401: no token on the display, or a revoked one) | unsupported (404: older firmware or the
// display's own setup Wi-Fi) | busy (429) | offline (no answer, an odd answer, or the time limit).
// Bambu's two cancel-class print_error codes (BambuHelper src/hms_lookup.h, printErrorIsCancel): 0300_400C "The task
// was canceled." and 0500_400E "Printing was cancelled.". Compared as hex digits, so 0300_400C and 0300-400C both match.
const CANCEL_CODES = new Set(['0300400C', '0500400E']);
const intIn = (v, lo, hi) => (Number.isSafeInteger(v) && v >= lo && v <= hi ? v : null);
const UNKNOWN_PRINTER = { state: 'unknown', progress: null, minutesLeft: null, errorCode: null };

function printerSummary(d) {
  const p = Array.isArray(d?.printers) ? d.printers.find(x => x && typeof x === 'object' && !Array.isArray(x)) : null;
  if (!p || p.connection !== 'online' || p.freshness !== 'fresh') return { ...UNKNOWN_PRINTER };
  const err = p.error && typeof p.error === 'object' && !Array.isArray(p.error) ? p.error : null;
  const code = typeof err?.code === 'string' && /^[0-9A-Za-z_-]{1,24}$/.test(err.code) ? err.code : null;
  const activity = String(p.activity || '');
  // A stop on purpose raises print_error like a fault. The display flags it (canceled) when its board knows the code;
  // the two cancel codes are matched here too, so a board without the table doesn't turn a stop into an error.
  const cancel = err && (err.canceled === true || CANCEL_CODES.has(String(err.code || '').replace(/[^0-9A-Fa-f]/g, '').toUpperCase()));
  const state = activity === 'printing' || activity === 'preparing' ? (err && !cancel ? 'error' : 'printing')
    : activity === 'paused' ? (err && !cancel ? 'error' : 'paused')
      : activity === 'idle' || activity === 'finished' ? (err && !cancel ? 'error' : 'idle')
        : cancel ? 'cancelled'
          // Bambu reports a stopped print as FAILED. A real fault always carries a code; with none (e.g. the display
          // restarted after the stop and lost it) say "Print stopped" rather than raise an error on Home.
          : activity === 'error' && !err ? 'cancelled'
            : activity === 'error' || err ? 'error'
              : 'unknown';
  const running = state === 'printing' || state === 'paused';
  return {
    state,
    progress: running ? intIn(p.progressPercent, 0, 100) : null,
    minutesLeft: running ? intIn(p.remainingMinutes, 0, 100000) : null,
    errorCode: state === 'error' ? code : null
  };
}

// One read. Never throws, and never puts the token (or anything from the request) in what it returns.
async function readPrinter({ url, token, fetchImpl = modelFetchWithTimeout, timeoutMs = TIMEOUT_MS }) {
  try {
    const r = await fetchImpl(`${url}${LITE_PATH}`, { method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } }, timeoutMs);
    const access = r.status === 200 ? 'ok' : r.status === 401 ? 'refused' : r.status === 404 ? 'unsupported' : r.status === 429 ? 'busy' : 'offline';
    if (access !== 'ok') { await r.body?.cancel().catch(() => {}); return { ...UNKNOWN_PRINTER, access }; }
    const d = JSON.parse(await readCapped(r, MAX_BODY));
    if (!d || typeof d !== 'object' || Array.isArray(d)) return { ...UNKNOWN_PRINTER, access: 'offline' };
    return { ...printerSummary(d), access: 'ok' };
  } catch {
    return { ...UNKNOWN_PRINTER, access: 'offline' };
  }
}

// The one server-side poller: every 30 s while the display answers, then 60 s, 2, 4 and 5 min while it doesn't (or
// refuses the token, so a wrong one doesn't keep tripping the display's lock-out). Tabs read its last answer and never
// add requests of their own. A 429 keeps the last answer and tries again at the normal pace. Nothing is logged.
function createPrinterPoller({ url = portalUrl(), token = process.env.LOCALAI_WORKSHOP_STATUS_TOKEN, fetchImpl = modelFetchWithTimeout, timeoutMs = TIMEOUT_MS, pollMs = POLL_MS, maxBackoffMs = MAX_BACKOFF_MS, now = () => Date.now() } = {}) {
  const secret = String(token ?? '').trim();
  const enabled = Boolean(url && secret);
  let last = enabled ? { ...UNKNOWN_PRINTER, access: 'offline', seenAt: null } : null;
  let failures = 0;
  let timer = null;
  let stopped = true;
  async function poll() {
    const r = await readPrinter({ url, token: secret, fetchImpl, timeoutMs });
    if (r.access === 'busy') return pollMs;
    if (r.access === 'ok') { failures = 0; last = { ...r, seenAt: new Date(now()).toISOString() }; return pollMs; }
    failures++;
    last = { ...r, seenAt: last?.seenAt ?? null }; // nothing old is shown as current
    return Math.min(pollMs * 2 ** failures, maxBackoffMs);
  }
  function loop() {
    if (stopped) return;
    poll().then(wait => {
      if (stopped) return;
      timer = setTimeout(loop, wait);
      timer.unref?.();
    });
  }
  return {
    enabled,
    current: () => (last ? { ...last } : null),
    poll: () => (enabled ? poll() : Promise.resolve(null)),
    start() { if (enabled && stopped) { stopped = false; loop(); } return this; },
    stop() { stopped = true; clearTimeout(timer); timer = null; }
  };
}

// ---- the portal sign-in code through the code token (GET /api/portal-code, Services › Show sign-in code) ----
// The display answers {code:"ABCDEFGHJK", bootId:…} with Cache-Control: no-store; only the code is kept, and only when it
// is 10 letters or digits. Read on demand, once per tap: nothing is cached, polled, logged or stored.
// access: ok | not_set_up (no token or no address) | refused (401: the key was revoked or replaced) | unsupported (404:
// older firmware) | busy (429: the display's rate limit) | offline (no answer, an odd answer, or the time limit).
const CODE_WORDS = {
  not_set_up: "Sign-in code access isn't set up. Add code access in the display's portal (More → Sign-in code access).",
  refused: "The display turned the key down: it was revoked or replaced. Add code access again in the display's portal and update stack.env.",
  unsupported: "The display's firmware can't share its sign-in code yet. Install the update.",
  busy: 'The display is busy. Try again in a minute.',
  offline: "The display isn't answering."
};

function codeToken(raw = process.env.LOCALAI_WORKSHOP_CODE_TOKEN) {
  return String(raw ?? '').trim();
}

async function readPortalCode({ url = portalUrl(), token = codeToken(), fetchImpl = modelFetchWithTimeout, timeoutMs = TIMEOUT_MS } = {}) {
  const secret = String(token ?? '').trim();
  if (!url || !secret) return { access: 'not_set_up' };
  try {
    const r = await fetchImpl(`${url}${CODE_PATH}`, { method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${secret}` } }, timeoutMs);
    const access = r.status === 200 ? 'ok' : r.status === 401 ? 'refused' : r.status === 404 ? 'unsupported' : r.status === 429 ? 'busy' : 'offline';
    if (access !== 'ok') { await r.body?.cancel().catch(() => {}); return { access }; }
    const d = JSON.parse(await readCapped(r, MAX_BODY));
    const code = typeof d?.code === 'string' ? d.code.trim().toUpperCase() : '';
    return /^[A-Z0-9]{10}$/.test(code) ? { access: 'ok', code } : { access: 'offline' };
  } catch {
    return { access: 'offline' };
  }
}

module.exports = { DEFAULT_URL, TIMEOUT_MS, POLL_MS, HEALTH_PATH, LITE_PATH, CODE_PATH, CODE_WORDS, portalUrl, workshopStatus, printerSummary, readPrinter, createPrinterPoller, codeToken, readPortalCode };
