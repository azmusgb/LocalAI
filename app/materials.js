'use strict';

// LocalAI Materials client: reads inventory summary and spool alert facts from the
// LocalAI Materials service (GET /api/display-feed).
// LOCALAI_MATERIALS_URL sets the address (e.g. http://127.0.0.1:8888, default: 'off'). Never throws.

const CACHE_MS = 60 * 1000;
const TIMEOUT_MS = 3000;
const str = (v, n = 80) => (typeof v === 'string' ? v : v == null ? '' : String(v)).replace(/\s+/g, ' ').trim().slice(0, n);

function summarize(d) {
  if (!d || typeof d !== 'object') return null;
  const s = d.summary || {};
  return {
    title: str(d.title || 'LocalAI Materials', 40),
    status: str(d.status, 90),
    stale: Boolean(d.stale),
    summary: {
      spools: Number.isSafeInteger(s.spools) ? s.spools : 0,
      loaded: Number.isSafeInteger(s.loaded) ? s.loaded : 0,
      low: Number.isSafeInteger(s.low) ? s.low : 0,
      unknown: Number.isSafeInteger(s.unknown) ? s.unknown : 0,
      queue: Number.isSafeInteger(s.queue) ? s.queue : 0,
    },
    metrics: Array.isArray(d.metrics)
      ? d.metrics.map(m => ({ label: str(m?.label, 20), value: str(m?.value, 20) })).slice(0, 4)
      : []
  };
}

function createMaterialsClient({ url = process.env.LOCALAI_MATERIALS_URL || 'off', fetchImpl = fetch, now = Date.now } = {}) {
  const off = !url || url === 'off';
  let cache = { at: -Infinity, value: null };

  async function read() {
    if (off) return null;
    if (now() - cache.at < CACHE_MS) return cache.value;
    let value = null;
    try {
      const r = await fetchImpl(new URL('/api/display-feed', url), { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (r.ok) value = summarize(await r.json());
    } catch {
      value = null;
    }
    cache = { at: now(), value };
    return value;
  }

  return { read, summarize };
}

module.exports = { createMaterialsClient, summarize };
