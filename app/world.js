'use strict';

// GET /api/world: Agent World's one read-only summary of the services around the city (the landmarks: the Model
// Foundry, the Workshop garage, the Spreadsheets office and the kiosk billboard), about 1-3 KB. The page polls it only
// while Agent World is on screen, one request at a time. Every source is cached here, so however many tabs poll:
//   models   Ollama GET /api/ps at most once every 10 s, plus the mission model queue and what is running (both in memory);
//   printer  the Workshop poller's last read (app/workshop.js): no request of its own to the display;
//   sheets   the GridCraft bridge's /health at most once every 15 s, plus GridCraft requests in flight;
//   kiosk    the display's GET /hardware/health at most once a minute (counted from when a request starts, so a slow or
//            failing display isn't asked again sooner), and the firmware version from the poller's last ok answer;
//   crews    null until Claude crews are added (round 1, PR 4).
// A read that is already under way is shared, never doubled. A source that is down or not set up says so with null
// (never 0, [] or a stale value shown as current). Nothing secret is in the answer: no token, no address, no host path.
// The answer has no timestamps, so its ETag changes only when what it says changes, and a poll that changes nothing is
// a 304.
const crypto = require('node:crypto');

const MODELS_MS = 10 * 1000;
const SHEETS_MS = 15 * 1000;
const KIOSK_MS = 60 * 1000;
const TIMEOUT_MS = 4000;
const MAX_MODELS = 6;
const MAX_KINDS = 8;
const MODEL_NAME = /^[\w.:/-]{1,80}$/;
const FIRMWARE = /^[\w.-]{1,24}$/;
const PRINTER_STATES = new Set(['printing', 'paused', 'error', 'cancelled', 'ended', 'idle']);
const PRINTER_ACCESS = new Set(['ok', 'refused', 'unsupported', 'busy', 'offline', 'stale']);

// read() at most once per `ms` (from when it starts) and never twice at once. A read that throws counts as null.
function cached(read, ms, now) {
  let value = null, startedAt = -Infinity, pending = null;
  return function get() {
    if (pending) return pending;
    if (now() - startedAt < ms) return Promise.resolve(value);
    startedAt = now();
    pending = Promise.resolve().then(read).catch(() => null).then(v => { value = v ?? null; pending = null; return value; });
    return pending;
  };
}

const mb = n => (Number.isFinite(n) && n >= 0 ? Math.round(n / (1024 * 1024)) : null);
const int = n => (Number.isSafeInteger(n) && n >= 0 ? n : 0);

// Ollama /api/ps: the loaded models, with their size and how much of it is on the GPU. null when Ollama didn't answer.
async function readLoadedModels({ ollamaUrl, fetchImpl, timeoutMs = TIMEOUT_MS }) {
  if (!ollamaUrl) return null;
  const r = await fetchImpl(`${String(ollamaUrl).replace(/\/$/, '')}/api/ps`, { method: 'GET' }, timeoutMs);
  if (!r.ok) { await r.body?.cancel?.().catch(() => {}); return null; }
  const d = await r.json();
  if (!Array.isArray(d?.models)) return null;
  return d.models.filter(m => m && typeof m.name === 'string' && MODEL_NAME.test(m.name)).slice(0, MAX_MODELS)
    .map(m => ({ name: m.name, sizeMb: mb(m.size), vramMb: mb(m.size_vram) }));
}

function createWorld({
  ollamaUrl, fetchImpl,
  modelQueue = () => null, // () => {active, waiting} | null
  busy = () => null, // () => busy.activeWork(...) | null
  printer = null, // the Workshop poller (createPrinterPoller): current(), firmware(), enabled
  bridgeHealth = async () => null, // () => {bridge, excel}
  gridcraftInFlight = () => 0,
  kioskUrl = () => null, // () => the display's address (workshop.portalUrl()) or null when not set up
  kioskHealth = async () => null, // (url) => workshop.workshopStatus({url})
  now = () => Date.now()
} = {}) {
  const loaded = cached(() => readLoadedModels({ ollamaUrl, fetchImpl }), MODELS_MS, now);
  const sheets = cached(() => bridgeHealth(), SHEETS_MS, now);
  const kiosk = cached(() => kioskHealth(kioskUrl()), KIOSK_MS, now);

  function models(list) {
    let q = null, b = null;
    try { q = modelQueue(); } catch {}
    try { b = busy(); } catch {}
    const kinds = {};
    for (const a of Array.isArray(b?.active) ? b.active : []) {
      const k = String(a?.kind || 'work').replace(/[^\w-]/g, '').slice(0, 24) || 'work';
      if (k in kinds || Object.keys(kinds).length < MAX_KINDS) kinds[k] = (kinds[k] || 0) + 1;
    }
    return {
      loaded: list,
      queue: q ? { active: int(q.active), waiting: int(q.waiting) } : null,
      busy: b ? { total: Array.isArray(b.active) ? b.active.length : 0, kinds } : null
    };
  }
  function printerPart() {
    const setUp = !!printer?.enabled;
    let p = null;
    try { p = setUp ? printer.current() : null; } catch {}
    if (!p) return { setUp, access: null, state: null, progress: null, minutesLeft: null, errorCode: null };
    return {
      setUp,
      access: PRINTER_ACCESS.has(p.access) ? p.access : null,
      state: PRINTER_STATES.has(p.state) ? p.state : null, // 'unknown' is said as null
      progress: Number.isSafeInteger(p.progress) ? p.progress : null,
      minutesLeft: Number.isSafeInteger(p.minutesLeft) ? p.minutesLeft : null,
      errorCode: typeof p.errorCode === 'string' && /^[0-9A-Za-z_-]{1,24}$/.test(p.errorCode) ? p.errorCode : null
    };
  }
  function sheetsPart(h) {
    let n = 0;
    try { n = int(gridcraftInFlight()); } catch {}
    return { bridge: typeof h?.bridge === 'boolean' ? h.bridge : null, excel: h?.bridge === true && typeof h.excel === 'boolean' ? h.excel : null, inFlight: n };
  }
  async function kioskPart() {
    let url = null;
    try { url = kioskUrl(); } catch {}
    if (!url) return { setUp: false, online: null, signIn: null, firmware: null };
    const h = await kiosk();
    const online = typeof h?.online === 'boolean' ? h.online : null;
    let fw = null, signIn = online && typeof h.signIn === 'boolean' ? h.signIn : null;
    try {
      fw = printer?.firmware?.() ?? null;
      if (online && printer?.current?.()?.access === 'ok') signIn = true; // the token only exists on firmware with the sign-in
    } catch {}
    return { setUp: true, online, signIn, firmware: online && typeof fw === 'string' && FIRMWARE.test(fw) ? fw : null };
  }

  async function summary() {
    const [list, health, k] = await Promise.all([loaded(), sheets(), kioskPart()]);
    return { schema: 1, models: models(list), printer: printerPart(), sheets: sheetsPart(health), kiosk: k, crews: null };
  }

  async function api(req, res) {
    let body;
    try { body = JSON.stringify(await summary()); } catch { body = null; }
    if (!body) { res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end('{"error":"Agent World summary unavailable"}'); }
    const etag = `"w-${crypto.createHash('sha1').update(body).digest('base64url').slice(0, 22)}"`;
    const headers = { 'Cache-Control': 'no-cache', ETag: etag };
    const match = String(req.headers['if-none-match'] || '').split(',').map(s => s.trim().replace(/^W\//, ''));
    if (match.includes(etag)) { res.writeHead(304, headers); return res.end(); }
    res.writeHead(200, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
  }
  return { summary, api };
}

module.exports = { createWorld, cached, readLoadedModels, MODELS_MS, SHEETS_MS, KIOSK_MS, FIRMWARE };
