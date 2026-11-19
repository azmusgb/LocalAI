'use strict';
// The hub's shape (pi-hub tests/test_evolve.py): movies.playing is null or up to 6 {title, show, year, kind, who, device,
// state: playing|paused|buffering, progress 0-100, minutes_left, poster: "/api/now/poster/<n>.jpg"|null};
// issues[] is {tone: bad|warn, what, say}.
// The Raspberry Pi's hub (another appliance on the home network: Plex, Homebridge, the camera bridge) answers
// GET /api/now with a summary for screens, no key needed. Local AI reads it once a minute at most for the Workshop
// display's cards: what Plex is playing, and the hub's own issues (docs/WORKSHOP-DISPLAY.md › Pi hub cards).
// LOCALAI_PI_HUB_URL sets the address (default http://10.0.0.80); "off" turns it off. Never throws.

const CACHE_MS = 60 * 1000, NEEDS_CACHE_MS = 30 * 1000, TIMEOUT_MS = 3000;
const str = (v, n = 80) => (typeof v === 'string' ? v : v == null ? '' : String(v)).replace(/\s+/g, ' ').trim().slice(0, n);

// One playing item, whatever shape the hub sends: a title, and what it can of progress, state and where.
function playingItem(p) {
  if (typeof p === 'string') return p.trim() ? { title: str(p) } : null;
  if (!p || typeof p !== 'object') return null;
  const title = str(p.title || p.name || p.show || p.grandparentTitle);
  if (!title) return null;
  const pct = Number(p.progress ?? p.percent ?? p.progressPercent);
  const left = Number(p.minutes_left);
  return {
    title: p.episode ? `${title} · ${str(p.episode, 40)}` : title,
    progress: Number.isFinite(pct) ? Math.max(0, Math.min(100, Math.round(pct <= 1 && pct > 0 && !Number.isInteger(pct) ? pct * 100 : pct))) : null,
    state: str(p.state || p.status, 12).toLowerCase() || null,
    where: str(p.device || p.player || p.where || p.who || p.user, 30) || null,
    minutesLeft: Number.isFinite(left) && left >= 0 ? Math.round(left) : null,
    // The hub serves the poster itself (baseline JPEG, at most 300x450); Local AI passes it on to the display.
    poster: typeof p.poster === 'string' && /^\/api\/now\/poster\/\d+\.jpg$/.test(p.poster) ? p.poster : null
  };
}

function summarize(d) {
  const playing = (Array.isArray(d?.movies?.playing) ? d.movies.playing : []).map(playingItem).filter(Boolean).slice(0, 3);
  const issues = (Array.isArray(d?.issues) ? d.issues : [])
    .map(i => ({ what: str(i?.what, 40), say: str(i?.say, 120), tone: ['bad', 'warn'].includes(i?.tone) ? i.tone : 'warn' }))
    .filter(i => i.what).slice(0, 2);
  return { playing, issues };
}

// The hub's one "Needs you" list (GET /api/needs: {count, items:[{id, source, tone, title, detail, link, action}], unread}),
// built by the hub from its own issues, Local AI's attention cards and the printer. Untrusted text: only strings pass,
// an item needs an id and a title, and the link is a hub path. `action` keeps only its phrase key (A7 P2: the kit turns
// "open_network" into "Open Network"; an unknown key shows no words), never words or a link of its own. count is the hub's own total (the display's "+N more"),
// else the number of items. The display feed cuts and caps it (app/display-feed.js).
const plain = (v, n) => (typeof v === 'string' ? str(v, n) : '');
// A long sentence is cut at a word with an ellipsis, never in the middle of one ("... or adhe").
function cutWords(v, n) {
  const t = typeof v === 'string' ? str(v, 4000) : '';
  if (t.length <= n) return t;
  const head = t.slice(0, n - 1), space = head.lastIndexOf(' ');
  return (space >= n * 0.6 ? head.slice(0, space) : head).replace(/[\s,;:.-]+$/, '') + '…';
}
// A need's link: a plain path on the hub ("/workshop"), else '' (the hub's root). Never another site or scheme.
const hubPath = (v) => (typeof v === 'string' && /^\/(?!\/)[A-Za-z0-9/_-]{0,63}$/.test(v) ? v : '');
const verbKey = (a) => (a && typeof a === 'object' && typeof a.key === 'string' && /^[a-z_]{1,32}$/.test(a.key) ? a.key : '');
function needsList(d) {
  if (!Array.isArray(d?.items)) return null;
  const items = d.items.filter(i => i && typeof i === 'object')
    .map(i => ({ id: plain(i.id, 64), source: plain(i.source, 24), tone: plain(i.tone, 12), title: plain(i.title, 80), detail: cutWords(i.detail, 400), link: hubPath(i.link), action: verbKey(i.action) }))
    .filter(i => i.id && i.title);
  const count = Number.isSafeInteger(d.count) && d.count >= 0 ? d.count : items.length;
  return { count, items: items.slice(0, 20) };
}

// The household's designated printer record comes from Bambuddy through Pi Hub. Validate source time even
// after a cache hit: a responsive hub must not make an old printer reading current. Never fall back to a
// different authority when the hub is unavailable. Only these fields leave the adapter.
const PRINTER_CACHE_MS = 15000, PRINTER_MAX_AGE_MS = 90000;
const PRINTER_STATES = { printing: 'printing', paused: 'paused', finished: 'idle', failed: 'error', idle: 'idle' };
function printerRecord(body, now = Date.now()) {
  if (!Array.isArray(body?.records)) return null;
  const r = body.records.find(r => r?.id === 'printer');
  if (!r || r.source !== 'bambuddy' || typeof r.as_of !== 'number' || !Number.isFinite(r.as_of) || r.as_of < 0 || r.as_of > 8.64e12) return null;
  const age = now - r.as_of * 1000;
  const stale = r.stale === true || age > PRINTER_MAX_AGE_MS || age < -5000;
  const state = !stale && Object.hasOwn(PRINTER_STATES, r.state) ? PRINTER_STATES[r.state] : null;
  const d = r.detail || {};
  const integer = (v, max) => Number.isSafeInteger(v) && v >= 0 && v <= max ? v : null;
  const running = state === 'printing' || state === 'paused';
  return {
    setUp: true, access: stale ? 'stale' : state ? 'ok' : 'offline', state,
    progress: running ? integer(d.progress, 100) : null,
    minutesLeft: running ? integer(d.minutes_left, 100000) : null,
    errorCode: null, ...(!stale && ['finished', 'failed'].includes(r.state) ? { needsPlateClear: true } : {}), source: 'bambuddy', via: 'pi-hub', seenAt: new Date(r.as_of * 1000).toISOString()
  };
}

// Bambuddy's print log as Pi Hub serves it to machines (GET /api/now/prints, platform amendment A29 D1: prints, newest
// first, at most 20, and prints_available: false when Bambuddy didn't answer the hub) → {ok: true, prints} or
// {ok: false, source}: which source could not be read. Untrusted text: only these fields leave, cut to size; times
// become ISO strings. Past work (A28 D3) reads it at ask time through createPiHub().prints and keeps none of it.
const PRINTS_MAX = 20, PRINTS_CACHE_MS = 15000;
const isoOf = s => (Number.isFinite(s) && s > 0 && s < 8.64e12 ? new Date(s * 1000).toISOString() : null);
function printLog(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, source: 'pi-hub' };
  if (body.prints_available === false) return { ok: false, source: 'bambuddy' };
  if (body.prints_available !== true || !Array.isArray(body.prints)) return { ok: false, source: 'pi-hub' };
  const num = v => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const prints = body.prints.filter(p => p && typeof p === 'object' && (Number.isSafeInteger(p.id) || (typeof p.id === 'string' && /^[\w-]{1,40}$/.test(p.id)))).slice(0, PRINTS_MAX)
    .map(p => ({ id: String(p.id), name: str(p.name, 80) || 'Untitled', status: str(p.status, 20).toLowerCase() || null, word: str(p.word, 24) || null,
      started: isoOf(p.started), ended: isoOf(p.ended), seconds: num(p.seconds), grams: num(p.grams), error: str(p.error, 200) || null }));
  return { ok: true, prints };
}

function createPiHub({ url = process.env.LOCALAI_PI_HUB_URL || 'http://10.0.0.80', fetchImpl = fetch, now = Date.now, timeoutMs = TIMEOUT_MS } = {}) {
  const off = !url || url === 'off';
  let cache = { at: -Infinity, value: null };
  async function read() {
    if (off) return null;
    if (now() - cache.at < CACHE_MS) return cache.value;
    let value = null;
    try {
      const r = await fetchImpl(new URL('/api/now', url), { signal: AbortSignal.timeout(timeoutMs) });
      if (r.ok) value = summarize(await r.json());
    } catch { value = null; }
    cache = { at: now(), value };
    return value;
  }
  // The hub's "Needs you" list ({count, items}) at most every 30 s; null when it is off, down or slow (3 s). One fetch
  // at a time: while one is out, callers get the last value (or null) at once. The hub's /api/needs reads Local AI's
  // feed, so a second fetch here could start a request chain between the two (the feed fetches needs only for the
  // display's key, which the hub doesn't send; this also guards older hub versions). New hubs read /api/attention.
  let needsCache = { at: -Infinity, value: null }, needsInFlight = null;
  async function needs() {
    if (off) return null;
    if (now() - needsCache.at < NEEDS_CACHE_MS) return needsCache.value;
    if (needsInFlight) return needsCache.value;
    needsInFlight = (async () => {
      let value = null;
      try {
        const r = await fetchImpl(new URL('/api/needs', url), { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/json' } });
        if (r.ok) value = needsList(await r.json());
      } catch { value = null; }
      needsCache = { at: now(), value };
      return value;
    })().finally(() => { needsInFlight = null; });
    return needsInFlight;
  }
  let printerCache = { at: -Infinity, body: null }, printerInFlight = null;
  async function printer() {
    if (off) return null;
    if (now() - printerCache.at >= PRINTER_CACHE_MS) {
      if (!printerInFlight) {
        printerInFlight = (async () => {
          let body = null;
          try {
            const r = await fetchImpl(new URL('/api/records', url), { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/json' } });
            if (r.ok) body = await r.json();
          } catch { body = null; }
          printerCache = { at: now(), body };
        })().finally(() => { printerInFlight = null; });
      }
      await printerInFlight;
    }
    return printerRecord(printerCache.body, now());
  }
  // Pi Hub's print list for one Past work answer (A29): {ok: true, prints} or {ok: false, source}. 'off' when
  // LOCALAI_PI_HUB_URL is off; 'bambuddy' when the hub answered that Bambuddy didn't; 'pi-hub' for anything else (no
  // answer, slow past the timeout, a redirect to the signed-in hub, a non-200, a body that isn't the list). A list read
  // is kept 15 s so a quick second question doesn't ask again; a failure is not kept, so asking again reads again.
  // One fetch at a time. Never throws.
  let printsCache = { at: -Infinity, value: null }, printsInFlight = null;
  async function prints() {
    if (off) return { ok: false, source: 'off' };
    if (printsCache.value && now() - printsCache.at < PRINTS_CACHE_MS) return printsCache.value;
    if (!printsInFlight) {
      printsInFlight = (async () => {
        let value;
        try {
          const r = await fetchImpl(new URL('/api/now/prints', url), { signal: AbortSignal.timeout(timeoutMs), redirect: 'error', headers: { Accept: 'application/json' } });
          value = r.ok && r.status === 200 ? printLog(await r.json()) : { ok: false, source: 'pi-hub' };
        } catch { value = { ok: false, source: 'pi-hub' }; }
        if (value.ok) printsCache = { at: now(), value };
        return value;
      })().finally(() => { printsInFlight = null; });
    }
    return printsInFlight;
  }
  // The poster of playing item `n` (a JPEG), or null.
  async function poster(n) {
    if (off || !Number.isInteger(n) || n < 0 || n > 5) return null;
    try {
      const r = await fetchImpl(new URL(`/api/now/poster/${n}.jpg`, url), { signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok || !/^image\/jpeg/.test(r.headers.get('content-type') || '')) return null;
      const buf = Buffer.from(await r.arrayBuffer());
      return buf.length > 4 && buf.length <= 400 * 1024 ? buf : null;
    } catch { return null; }
  }
  return { read, needs, poster, printer, prints };
}

module.exports = { createPiHub, summarize, playingItem, needsList, printerRecord, printLog };
