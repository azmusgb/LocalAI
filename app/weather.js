'use strict';

// Weather for the spoken "Ask Local AI": Open-Meteo for places and forecasts, OpenStreetMap Nominatim for the
// name of where you are. Every function takes {fetch} so tests can stub the network; each call gives up after 3 s.

const openMeteoUrl = () => process.env.OPEN_METEO_URL || 'https://api.open-meteo.com';
const geoUrl = () => process.env.OPEN_METEO_GEO_URL || 'https://geocoding-api.open-meteo.com';
const reverseUrl = () => process.env.REVERSE_GEO_URL || 'https://nominatim.openstreetmap.org';
const TIMEOUT_MS = 3000;

async function getJson(url, { fetch: f = globalThis.fetch, headers, timeoutMs = TIMEOUT_MS } = {}) {
  const r = await f(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

const US_STATES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming' };

async function geocode(place, opts = {}) {
  const text = String(place || '').trim();
  if (!text) return null;
  // "Springfield, IL": search the name, then prefer the match for the qualifier (state, abbreviation or country).
  const [name, ...rest] = text.split(',');
  const qualifier = rest.join(',').trim().toLowerCase();
  const u = new URL('/v1/search', geoUrl());
  u.searchParams.set('name', name.trim());
  u.searchParams.set('count', '10');
  u.searchParams.set('language', 'en');
  // A service failure rejects (the caller says "couldn't reach"); only an empty result is null.
  const hits = ((await getJson(u, opts)).results || []).filter(h => h && typeof h.latitude === 'number' && typeof h.longitude === 'number');
  if (!hits.length) return null;
  const lc = v => String(v || '').toLowerCase();
  const abbr = qualifier.toUpperCase();
  const states = new Set([qualifier, lc(US_STATES[abbr])].filter(Boolean));
  const countries = new Set([qualifier, abbr === 'UK' ? 'gb' : ''].filter(Boolean));
  // US states first ("Springfield, IN" is Indiana, not India), then countries.
  const hit = (qualifier && (hits.find(h => states.has(lc(h.admin1))) || hits.find(h => countries.has(lc(h.country)) || countries.has(lc(h.country_code))))) || hits[0];
  return { name: hit.name, lat: hit.latitude, lon: hit.longitude, timeZone: hit.timezone || null };
}

async function reverse(lat, lon, opts = {}) {
  const u = new URL(`/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&zoom=10`, reverseUrl());
  try {
    const a = (await getJson(u, { ...opts, headers: { 'User-Agent': 'LocalAI-appliance' } })).address || {};
    return a.city || a.town || a.village || a.county || null;
  } catch { return null; }
}

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// "Tonight": 18:00 today to 06:00 tomorrow in the location's own clock (Open-Meteo returns local times, so
// plain string comparison works). Past 18:00 it starts now; after midnight and before 06:00 it ends at 06:00 today.
function tonightWindow(nowTime) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):/.exec(String(nowTime || ''));
  if (!m) return null;
  const hourNow = `${m[1]}T${m[2]}:00`;
  if (m[2] < '06') return { start: hourNow, end: `${m[1]}T06:00` };
  const next = new Date(Date.parse(`${m[1]}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const six = `${m[1]}T18:00`;
  return { start: hourNow > six ? hourNow : six, end: `${next}T06:00` };
}

function tonightFrom(j) {
  const h = j.hourly || {}, w = tonightWindow(j.current?.time);
  if (!w || !Array.isArray(h.time)) return null;
  const temps = [], rain = [], codes = [];
  h.time.forEach((t, i) => {
    if (t < w.start || t > w.end) return;
    const [temp, r, c] = [num(h.temperature_2m?.[i]), num(h.precipitation_probability?.[i]), num(h.weather_code?.[i])];
    if (temp !== null) temps.push(temp);
    if (r !== null) rain.push(r);
    if (c !== null) codes.push(c);
  });
  if (!temps.length && !codes.length) return null;
  // WMO codes rise with severity, so the worst is the largest.
  return { minC: temps.length ? Math.min(...temps) : null, rainChance: rain.length ? Math.max(...rain) : null, code: codes.length ? Math.max(...codes) : null };
}

async function forecast(lat, lon, opts = {}) {
  const u = new URL('/v1/forecast', openMeteoUrl());
  u.searchParams.set('latitude', String(lat));
  u.searchParams.set('longitude', String(lon));
  u.searchParams.set('current', 'temperature_2m,weather_code,is_day');
  u.searchParams.set('daily', 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max');
  u.searchParams.set('hourly', 'temperature_2m,weather_code,precipitation_probability');
  u.searchParams.set('timezone', opts.timeZone || 'auto');
  u.searchParams.set('forecast_days', '2');
  const j = await getJson(u, opts);
  const d = j.daily || {}, c = j.current || {};
  const day = i => ({ maxC: num(d.temperature_2m_max?.[i]), minC: num(d.temperature_2m_min?.[i]), rainChance: num(d.precipitation_probability_max?.[i]), code: num(d.weather_code?.[i]) });
  const out = {
    now: { tempC: num(c.temperature_2m), code: num(c.weather_code), isDay: num(c.is_day) },
    today: day(0), tomorrow: day(1), tonight: tonightFrom(j)
  };
  if (out.now.tempC === null && out.now.code === null && out.today.maxC === null && out.tomorrow.maxC === null && !out.tonight) throw new Error('Unexpected forecast');
  return out;
}

// WMO weather code to plain words. Clear nights are "clear", not "sunny".
const WORDS = [
  [[0], 'sunny'], [[1], 'mostly sunny'], [[2], 'partly cloudy'], [[3], 'overcast'], [[45, 48], 'foggy'],
  [[51, 53, 55], 'drizzly'], [[56, 57], 'freezing drizzle'], [[61, 63, 80, 81], 'rainy'], [[65, 67, 82], 'heavy rain'], [[66], 'freezing rain'],
  [[71, 73, 75, 77, 85, 86], 'snowy'], [[95, 96, 99], 'stormy']
];
const NIGHT = { 0: 'clear', 1: 'mostly clear' };
function describe(code, night = false) {
  if (typeof code !== 'number') return null;
  if (night && NIGHT[code]) return NIGHT[code];
  return (WORDS.find(([codes]) => codes.includes(code)) || [0, 'mixed'])[1];
}

// One spoken sentence, or null when nothing usable is there (never "null" or "NaN" in speech).
function weatherSentence(f, { when = 'now', place, units = 'F' } = {}) {
  const where = place ? `in ${place}` : 'here';
  const deg = c => Math.round(units === 'C' ? c : c * 1.8 + 32);
  const rainClause = r => (typeof r === 'number' ? (r >= 20 ? `${Math.round(r)} percent chance of rain` : 'no rain expected') : null);
  if (when === 'now') {
    const n = f.now || {};
    const temp = typeof n.tempC === 'number' ? `${deg(n.tempC)} degrees` : null;
    const sky = describe(n.code, n.isDay === 0);
    const body = temp && sky ? `${temp} and ${sky}` : temp || sky;
    return body ? `Right now ${where}: ${body}.` : null;
  }
  const label = { tomorrow: 'Tomorrow', tonight: 'Tonight', today: 'Today' }[when] || 'Today';
  let parts;
  if (when === 'tonight') {
    const t = f.tonight || {};
    parts = [describe(t.code, true), typeof t.minC === 'number' ? `low of ${deg(t.minC)}` : null, rainClause(t.rainChance)];
  } else {
    const day = (when === 'tomorrow' ? f.tomorrow : f.today) || {};
    parts = [describe(day.code), typeof day.maxC === 'number' ? `high of ${deg(day.maxC)}` : null, typeof day.minC === 'number' ? `low of ${deg(day.minC)}` : null, rainClause(day.rainChance)];
  }
  parts = parts.filter(Boolean);
  return parts.length ? `${label} ${where}: ${parts.join(', ')}.` : null;
}

module.exports = { geocode, reverse, forecast, weatherSentence };
