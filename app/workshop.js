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
//   state: printing | paused | error | cancelled (stopped on purpose) | ended (FAILED with no code: stop or fault) | idle | unknown; progress (0–100) and minutesLeft only while printing or paused;
//   errorCode (the printer's own code, e.g. 0700_8010) only in error.
// access: ok | refused (401: no token on the display, or a revoked one) | unsupported (404: older firmware or the
// display's own setup Wi-Fi) | busy (429) | offline (no answer, an odd answer, or the time limit); and from the poller
// only, stale (the last good answer is more than STALE_MS old).
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
          // Bambu reports a stopped print as FAILED. With no code at all (e.g. the display restarted and lost it) it may
          // have been a stop or a fault: 'ended', said neutrally ("Print ended — check the display"), neither a
          // cancel nor an error on Home. Only the cancel codes or the display's own flag make it 'cancelled'.
          : activity === 'error' && !err ? 'ended'
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

// The display's firmware version from the same answer (firmware.version, e.g. "12.1.0"), only when it is a short plain
// version: Agent World's kiosk shows it. Nothing else under firmware (its source commit) is kept.
const FIRMWARE = /^[\w.-]{1,24}$/;
const firmwareOf = d => (typeof d?.firmware?.version === 'string' && FIRMWARE.test(d.firmware.version) ? d.firmware.version : null);

// One read. Never throws, and never puts the token (or anything from the request) in what it returns. withFirmware adds
// firmware (firmwareOf) to an ok answer.
async function readPrinter({ url, token, fetchImpl = modelFetchWithTimeout, timeoutMs = TIMEOUT_MS, withFirmware = false }) {
  try {
    const r = await fetchImpl(`${url}${LITE_PATH}`, { method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } }, timeoutMs);
    const access = r.status === 200 ? 'ok' : r.status === 401 ? 'refused' : r.status === 404 ? 'unsupported' : r.status === 429 ? 'busy' : 'offline';
    if (access !== 'ok') { await r.body?.cancel().catch(() => {}); return { ...UNKNOWN_PRINTER, access }; }
    const d = JSON.parse(await readCapped(r, MAX_BODY));
    if (!d || typeof d !== 'object' || Array.isArray(d)) return { ...UNKNOWN_PRINTER, access: 'offline' };
    return { ...printerSummary(d), access: 'ok', ...(withFirmware ? { firmware: firmwareOf(d) } : {}) };
  } catch {
    return { ...UNKNOWN_PRINTER, access: 'offline' };
  }
}

// The one server-side poller: every 30 s while the display answers, then 60 s, 2, 4 and 5 min while it doesn't (or
// refuses the token, so a wrong one doesn't keep tripping the display's lock-out). Tabs read its last answer and never
// add requests of their own. One 429 keeps the last answer and tries again at the normal pace; a second in a row makes
// it unknown (access busy), so a busy display never leaves an old "42%" up. Whatever happens, an answer older than
// STALE_MS is reported as unknown (access stale) rather than as current. Nothing is logged.
const STALE_MS = 2 * 60 * 1000;
const BUSY_MISSES = 2;
function createPrinterPoller({ url = portalUrl(), token = process.env.LOCALAI_WORKSHOP_STATUS_TOKEN, fetchImpl = modelFetchWithTimeout, timeoutMs = TIMEOUT_MS, pollMs = POLL_MS, maxBackoffMs = MAX_BACKOFF_MS, staleMs = STALE_MS, now = () => Date.now() } = {}) {
  const secret = String(token ?? '').trim();
  const enabled = Boolean(url && secret);
  let last = enabled ? { ...UNKNOWN_PRINTER, access: 'offline', seenAt: null } : null;
  let failures = 0;
  let busy = 0;
  let timer = null;
  let stopped = true;
  let firmware = null; // from the last ok answer
  async function poll() {
    const { firmware: fw, ...r } = await readPrinter({ url, token: secret, fetchImpl, timeoutMs, withFirmware: true });
    if (r.access === 'ok') firmware = fw ?? null;
    if (r.access === 'busy') {
      if (++busy >= BUSY_MISSES) last = { ...r, seenAt: last?.seenAt ?? null };
      return pollMs;
    }
    busy = 0;
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
    current() {
      if (!last) return null;
      const age = last.seenAt ? now() - Date.parse(last.seenAt) : Infinity;
      if (last.access === 'ok' && !(age <= staleMs)) return { ...UNKNOWN_PRINTER, access: 'stale', seenAt: last.seenAt };
      return { ...last };
    },
    // The firmware version the display last reported with an ok answer, or null; never a request of its own.
    firmware: () => firmware,
    poll: () => (enabled ? poll() : Promise.resolve(null)),
    start() { if (enabled && stopped) { stopped = false; loop(); } return this; },
    stop() { stopped = true; clearTimeout(timer); timer = null; }
  };
}

// ---- the portal sign-in code through the code token (GET /api/portal-code, Services › Show sign-in code) ----
// The display answers {code:"ABCDEFGHJK", bootId:…} with Cache-Control: no-store; only the code is kept, and only when it
// is 10 letters or digits. Read on demand through createPortalCodeGate (below): nothing is polled, logged or stored, and
// the only copy kept is that gate's few seconds in memory.
// access: ok | not_set_up (no token or no address) | refused (401: the key was revoked or replaced) | unsupported (404:
// older firmware) | busy (429: the display's rate limit) | offline (no answer, an odd answer, or the time limit).
const CODE_WORDS = {
  not_set_up: "Sign-in code access isn't set up. Add code access in the display's portal (More → Sign-in code access).",
  refused: "The display turned the key down: it was revoked or replaced. Add code access again in the display's portal and update stack.env.",
  unsupported: "The display's firmware can't share its sign-in code yet. Install the update.",
  busy: 'The display is busy. Try again in a few minutes.',
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

// The one way the server asks for the code (POST /api/workshop/portal-code). The display counts wrong keys toward its
// sign-in lock-out and rate-limits the route, so taps (or a script hammering the route) never turn into a burst:
//  - one request at a time: callers that arrive while one is out share its answer;
//  - at most one request every CODE_GAP_MS: inside that window the last answer is served again, from memory only (it is
//    dropped when the window ends; never written to disk, an answer cache or a log);
//  - after a 401 (the key was revoked) or a 429 (the display's own limit) nothing is sent for minutes; callers get the
//    same reason with retryAfterMs.
const CODE_GAP_MS = 5000;
const CODE_REFUSED_HOLD_MS = 5 * 60 * 1000;
const CODE_BUSY_HOLD_MS = 2 * 60 * 1000;
function createPortalCodeGate({ read = readPortalCode, now = () => Date.now(), gapMs = CODE_GAP_MS, refusedHoldMs = CODE_REFUSED_HOLD_MS, busyHoldMs = CODE_BUSY_HOLD_MS } = {}) {
  let inflight = null; // { url, promise }
  let last = null; // { url, startedAt, result }: the last answer, kept for gapMs only
  let hold = null; // { url, access, until }
  let forget = null;
  const drop = () => { last = null; clearTimeout(forget); forget = null; };
  return function get(opts = {}) {
    const url = opts.url ?? portalUrl();
    const t = now();
    if (hold && (hold.url !== url || t >= hold.until)) hold = null;
    if (hold) return Promise.resolve({ access: hold.access, retryAfterMs: hold.until - t });
    if (inflight && inflight.url === url) return inflight.promise;
    if (last && (last.url !== url || t - last.startedAt >= gapMs)) drop();
    if (last) return Promise.resolve({ ...last.result });
    const startedAt = t;
    const promise = new Promise(r => r(read({ ...opts, url }))).catch(() => ({ access: 'offline' })).then(result => {
      if (inflight?.promise === promise) inflight = null;
      if (result.access === 'refused' || result.access === 'busy') {
        const ms = result.access === 'refused' ? refusedHoldMs : busyHoldMs;
        hold = { url, access: result.access, until: now() + ms };
        drop();
        return { ...result, retryAfterMs: ms };
      }
      drop();
      last = { url, startedAt, result };
      forget = setTimeout(drop, Math.max(0, startedAt + gapMs - now()));
      forget.unref?.();
      return { ...result };
    });
    inflight = { url, promise };
    return promise;
  };
}

// ---- Chamber Camera streaming & bridge ----
const DEFAULT_CAMERA_URL = 'http://10.0.0.30/api/camera.jpg';
const MAX_CAMERA_BYTES = 512 * 1024;

function cameraUrl(raw = process.env.LOCALAI_WORKSHOP_CAMERA_URL) {
  const text = String(raw ?? '').trim() || DEFAULT_CAMERA_URL;
  let u;
  try { u = new URL(text); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  const lan = privateIpv4(host) || /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+local$/.test(host);
  return lan ? u.href : null;
}

function cameraSources(primary = cameraUrl()) {
  const out = [];
  if (primary) out.push(primary);
  const fallbacks = [
    'http://10.0.0.30/api/camera.jpg',
    'http://10.0.0.30:8091/x2d/frame.jpg',
    'http://10.0.0.16:8091/x2d/frame.jpg',
    'http://127.0.0.1:8091/x2d/frame.jpg'
  ];
  for (const f of fallbacks) {
    if (!out.includes(f)) out.push(f);
  }
  return out;
}

async function fetchCameraFrame({
  url = cameraUrl(),
  sources = null,
  fetchImpl = modelFetchWithTimeout,
  timeoutMs = 3000,
  maxBytes = MAX_CAMERA_BYTES
} = {}) {
  const list = sources || cameraSources(url);
  for (const src of list) {
    try {
      const r = await fetchImpl(src, { method: 'GET', headers: { Accept: 'image/jpeg' } }, timeoutMs);
      if (r.status === 200) {
        const ct = r.headers.get('content-type') || 'image/jpeg';
        const reader = r.body?.getReader();
        if (!reader) continue;
        const chunks = [];
        let size = 0;
        let oversized = false;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > maxBytes) {
            await reader.cancel().catch(() => {});
            oversized = true;
            break;
          }
          chunks.push(value);
        }
        if (oversized || chunks.length === 0) continue;
        const buf = Buffer.concat(chunks);
        if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
          return { ok: true, source: src, buffer: buf, contentType: ct };
        }
      } else {
        await r.body?.cancel().catch(() => {});
      }
    } catch {}
  }
  return { ok: false, status: 503 };
}

async function cameraStatus({
  sources = null,
  fetchImpl = modelFetchWithTimeout,
  timeoutMs = 1500
} = {}) {
  const healthUrls = sources || (process.env.LOCALAI_WORKSHOP_CAMERA_PROBES === 'off' ? [] : [
    'http://10.0.0.30/api/camera',
    'http://10.0.0.16:8091/x2d/health.json',
    'http://127.0.0.1:8091/x2d/health.json'
  ]);
  for (const hu of healthUrls) {
    try {
      const r = await fetchImpl(hu, { method: 'GET', headers: { Accept: 'application/json' } }, timeoutMs);
      if (r.ok) {
        const d = JSON.parse(await readCapped(r, 4096));
        if (d && typeof d === 'object') {
          return {
            available: Boolean(d.ok || d.fresh),
            source: d.source || null,
            reason: d.reason || null
          };
        }
      }
    } catch {}
  }
  return { available: false, source: null, reason: 'offline' };
}

module.exports = {
  FIRMWARE, firmwareOf, DEFAULT_URL, DEFAULT_CAMERA_URL, STALE_MS, CODE_GAP_MS, CODE_REFUSED_HOLD_MS, CODE_BUSY_HOLD_MS,
  createPortalCodeGate, TIMEOUT_MS, POLL_MS, HEALTH_PATH, LITE_PATH, CODE_PATH, CODE_WORDS,
  portalUrl, cameraUrl, cameraSources, fetchCameraFrame, cameraStatus,
  workshopStatus, printerSummary, readPrinter, createPrinterPoller, codeToken, readPortalCode
};
