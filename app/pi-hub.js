'use strict';
// The hub's shape (pi-hub tests/test_evolve.py): movies.playing is null or up to 6 {title, show, year, kind, who, device,
// state: playing|paused|buffering, progress 0-100, minutes_left, poster: "/api/now/poster/<n>.jpg"|null};
// issues[] is {tone: bad|warn, what, say}.
// The Raspberry Pi's hub (another appliance on the home network: Plex, Homebridge, the camera bridge) answers
// GET /api/now with a summary for screens, no key needed. Local AI reads it once a minute at most for the Workshop
// display's cards: what Plex is playing, and the hub's own issues (docs/WORKSHOP-DISPLAY.md › Pi hub cards).
// LOCALAI_PI_HUB_URL sets the address (default http://10.0.0.30); "off" turns it off. Never throws.

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

// The hub's one "Needs you" list (GET /api/needs: {count, items:[{id, source, tone, title, detail, link}], unread}),
// built by the hub from its own issues, Local AI's attention cards and the printer. Untrusted text: only strings pass,
// an item needs an id and a title, and the link is left out. The display feed cuts and caps it (app/display-feed.js).
const plain = (v, n) => (typeof v === 'string' ? str(v, n) : '');
function needsList(d) {
  if (!Array.isArray(d?.items)) return null;
  const items = d.items.filter(i => i && typeof i === 'object')
    .map(i => ({ id: plain(i.id, 64), source: plain(i.source, 24), tone: plain(i.tone, 12), title: plain(i.title, 80), detail: plain(i.detail, 200) }))
    .filter(i => i.id && i.title).slice(0, 20);
  return { items };
}

function createPiHub({ url = process.env.LOCALAI_PI_HUB_URL || 'http://10.0.0.30', fetchImpl = fetch, now = Date.now } = {}) {
  const off = !url || url === 'off';
  let cache = { at: -Infinity, value: null };
  async function read() {
    if (off) return null;
    if (now() - cache.at < CACHE_MS) return cache.value;
    let value = null;
    try {
      const r = await fetchImpl(new URL('/api/now', url), { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (r.ok) value = summarize(await r.json());
    } catch { value = null; }
    cache = { at: now(), value };
    return value;
  }
  // The hub's "Needs you" list ({items}) at most every 30 s; null when it is off, down or slow (3 s).
  let needsCache = { at: -Infinity, value: null };
  async function needs() {
    if (off) return null;
    if (now() - needsCache.at < NEEDS_CACHE_MS) return needsCache.value;
    let value = null;
    try {
      const r = await fetchImpl(new URL('/api/needs', url), { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: 'application/json' } });
      if (r.ok) value = needsList(await r.json());
    } catch { value = null; }
    needsCache = { at: now(), value };
    return value;
  }
  // The poster of playing item `n` (a JPEG), or null.
  async function poster(n) {
    if (off || !Number.isInteger(n) || n < 0 || n > 5) return null;
    try {
      const r = await fetchImpl(new URL(`/api/now/poster/${n}.jpg`, url), { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!r.ok || !/^image\/jpeg/.test(r.headers.get('content-type') || '')) return null;
      const buf = Buffer.from(await r.arrayBuffer());
      return buf.length > 4 && buf.length <= 400 * 1024 ? buf : null;
    } catch { return null; }
  }
  return { read, needs, poster };
}

module.exports = { createPiHub, summarize, playingItem, needsList };
