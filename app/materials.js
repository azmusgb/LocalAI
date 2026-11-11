'use strict';

// Materials: the filament spools in Bambuddy, the Bambu printer manager in Docker on the Raspberry Pi. Since
// 24 Oct 2026 Bambuddy holds the household's spools; it reads the AMS and takes each print's filament off its spool.
// Local AI reads GET /api/v1/inventory/spools and /api/v1/inventory/assignments (no key on the LAN) once a minute at
// most, for the Workshop display's Materials card (app/display-feed.js).
// LOCALAI_MATERIALS_URL sets Bambuddy's address (default http://10.0.0.80:8000); "off" turns it off. Never throws.
// LOCALAI_MATERIALS_KEY: a Bambuddy API key with "Read status" only, sent as X-API-Key; needed once Bambuddy's sign-in is on.

const CACHE_MS = 60 * 1000;
const TIMEOUT_MS = 3000;
const LOW_PCT = 15;  // Bambuddy's default when a spool has no threshold of its own
const str = (v, n = 80) => (typeof v === 'string' ? v : v == null ? '' : String(v)).replace(/\s+/g, ' ').trim().slice(0, n);

// What a spool has left, in grams, and whether that is a reading (a print, a scale or the AMS) rather than the label.
function remaining(s) {
  const total = Number(s.label_weight) > 0 ? Number(s.label_weight) : 1000;
  const used = Number(s.weight_used) || 0;
  return {
    total,
    left: Math.max(0, Math.round(total - used)),
    measured: used > 0 || s.last_scale_weight != null || Boolean(s.tray_uuid)
  };
}

// Bambuddy's spools and AMS assignments, summarised in the shape the display feed takes.
function summarize(spools, assignments = []) {
  if (!Array.isArray(spools)) return null;
  const active = spools.filter((s) => s && typeof s === 'object' && !s.archived_at);
  const loadedIds = new Set((Array.isArray(assignments) ? assignments : []).map((a) => a?.spool_id).filter((id) => id != null));
  const low = [];
  let unknown = 0;
  for (const s of active) {
    const r = remaining(s);
    if (!r.measured) unknown += 1;
    const pct = Number(s.low_stock_threshold_pct) > 0 ? Number(s.low_stock_threshold_pct) : LOW_PCT;
    if (r.measured && r.left <= (r.total * pct) / 100) low.push({ name: str([s.color_name, s.material].filter(Boolean).join(' '), 40), left: r.left });
  }
  low.sort((a, b) => a.left - b.left);
  const loaded = active.filter((s) => loadedIds.has(s.id)).length;
  const status = low.length
    ? `${low[0].name} · ${low[0].left} g left${low.length > 1 ? ` · ${low.length - 1} more low` : ''}`
    : `${active.length} spool${active.length === 1 ? '' : 's'}${loaded ? ` · ${loaded} in the AMS` : ''}`;
  return {
    title: 'Materials',
    status: str(status, 90),
    stale: false,
    summary: { spools: active.length, loaded, low: low.length, unknown, queue: 0 },
    metrics: [{ label: 'Spools', value: String(active.length) }, { label: 'Low', value: String(low.length) }]
  };
}

function createMaterialsClient({ url = process.env.LOCALAI_MATERIALS_URL || 'http://10.0.0.80:8000', key = process.env.LOCALAI_MATERIALS_KEY || '', fetchImpl = fetch, now = Date.now } = {}) {
  const off = !url || url === 'off';
  let cache = { at: -Infinity, value: null };

  async function getJson(path) {
    const r = await fetchImpl(new URL(path, url), { signal: AbortSignal.timeout(TIMEOUT_MS), ...(key ? { headers: { 'X-API-Key': key } } : {}) });
    return r.ok ? r.json() : null;
  }

  async function read() {
    if (off) return null;
    if (now() - cache.at < CACHE_MS) return cache.value;
    let value = null;
    try {
      const [spools, assignments] = await Promise.all([
        getJson('/api/v1/inventory/spools'),
        getJson('/api/v1/inventory/assignments').catch(() => [])
      ]);
      value = summarize(spools, assignments || []);
    } catch {
      value = null;
    }
    cache = { at: now(), value };
    return value;
  }

  return { read, summarize };
}

module.exports = { createMaterialsClient, summarize };
