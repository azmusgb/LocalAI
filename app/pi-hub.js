'use strict';
// The Raspberry Pi's hub (another appliance on the home network: Plex, Homebridge, the camera bridge) answers
// GET /api/now with a summary for screens, no key needed. Local AI reads it once a minute at most for the Workshop
// display's cards: what Plex is playing, and the hub's own issues (docs/WORKSHOP-DISPLAY.md › Pi hub cards).
// LOCALAI_PI_HUB_URL sets the address (default http://10.0.0.30); "off" turns it off. Never throws.

const CACHE_MS = 60 * 1000, TIMEOUT_MS = 3000;
const str = (v, n = 80) => (typeof v === 'string' ? v : v == null ? '' : String(v)).replace(/\s+/g, ' ').trim().slice(0, n);

// One playing item, whatever shape the hub sends: a title, and what it can of progress, state and where.
function playingItem(p) {
  if (typeof p === 'string') return p.trim() ? { title: str(p) } : null;
  if (!p || typeof p !== 'object') return null;
  const title = str(p.title || p.name || p.show || p.grandparentTitle);
  if (!title) return null;
  const pct = Number(p.progress ?? p.percent ?? p.progressPercent);
  return {
    title: p.episode ? `${title} · ${str(p.episode, 40)}` : title,
    progress: Number.isFinite(pct) ? Math.max(0, Math.min(100, Math.round(pct <= 1 && pct > 0 && !Number.isInteger(pct) ? pct * 100 : pct))) : null,
    state: str(p.state || p.status, 12).toLowerCase() || null,
    where: str(p.player || p.device || p.where || p.user, 30) || null
  };
}

function summarize(d) {
  const playing = (Array.isArray(d?.movies?.playing) ? d.movies.playing : []).map(playingItem).filter(Boolean).slice(0, 3);
  const issues = (Array.isArray(d?.issues) ? d.issues : [])
    .map(i => ({ what: str(i?.what, 40), say: str(i?.say, 120), tone: ['bad', 'warn'].includes(i?.tone) ? i.tone : 'warn' }))
    .filter(i => i.what).slice(0, 2);
  return { playing, issues };
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
  return { read };
}

module.exports = { createPiHub, summarize, playingItem };
