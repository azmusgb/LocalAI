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

async function geocode(place, opts = {}) {
  const name = String(place || '').trim();
  if (!name) return null;
  // Open-Meteo matches place names, not "City, ST": search on the part before the first comma.
  const u = new URL('/v1/search', geoUrl());
  u.searchParams.set('name', name.split(',')[0].trim());
  u.searchParams.set('count', '1');
  u.searchParams.set('language', 'en');
  try {
    const hit = (await getJson(u, opts)).results?.[0];
    if (!hit || typeof hit.latitude !== 'number' || typeof hit.longitude !== 'number') return null;
    return { name: hit.name, lat: hit.latitude, lon: hit.longitude, timeZone: hit.timezone || null };
  } catch { return null; }
}

async function reverse(lat, lon, opts = {}) {
  const u = new URL(`/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&zoom=10`, reverseUrl());
  try {
    const a = (await getJson(u, { ...opts, headers: { 'User-Agent': 'LocalAI-appliance' } })).address || {};
    return a.city || a.town || a.village || a.county || null;
  } catch { return null; }
}

async function forecast(lat, lon, opts = {}) {
  const u = new URL('/v1/forecast', openMeteoUrl());
  u.searchParams.set('latitude', String(lat));
  u.searchParams.set('longitude', String(lon));
  u.searchParams.set('current', 'temperature_2m,weather_code');
  u.searchParams.set('daily', 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max');
  u.searchParams.set('timezone', opts.timeZone || 'auto');
  u.searchParams.set('forecast_days', '2');
  const j = await getJson(u, opts);
  const d = j.daily || {};
  const day = i => ({ maxC: d.temperature_2m_max?.[i], minC: d.temperature_2m_min?.[i], rainChance: d.precipitation_probability_max?.[i] ?? 0, code: d.weather_code?.[i] });
  if (!j.current || typeof j.current.temperature_2m !== 'number' || typeof day(0).maxC !== 'number') throw new Error('Unexpected forecast');
  return { now: { tempC: j.current.temperature_2m, code: j.current.weather_code }, today: day(0), tomorrow: day(1) };
}

// WMO weather code to plain words.
const WORDS = [
  [[0], 'sunny'], [[1], 'mostly sunny'], [[2], 'partly cloudy'], [[3], 'overcast'], [[45, 48], 'foggy'],
  [[51, 53, 55, 56, 57], 'drizzly'], [[61, 63, 80, 81], 'rainy'], [[65, 66, 67, 82], 'heavy rain'],
  [[71, 73, 75, 77, 85, 86], 'snowy'], [[95, 96, 99], 'stormy']
];
const describe = code => (WORDS.find(([codes]) => codes.includes(code)) || [0, 'mixed'])[1];

function weatherSentence(f, { when = 'now', place, units = 'F' } = {}) {
  const deg = c => Math.round(units === 'C' ? c : c * 1.8 + 32);
  const where = place || 'Here';
  if (when === 'now') return `Right now in ${where}: ${deg(f.now.tempC)} degrees and ${describe(f.now.code)}.`;
  const day = when === 'tomorrow' ? f.tomorrow : f.today;
  const rain = day.rainChance >= 20 ? `${Math.round(day.rainChance)} percent chance of rain` : 'no rain expected';
  const label = { tomorrow: 'Tomorrow', tonight: 'Tonight', today: 'Today' }[when] || 'Today';
  if (when === 'tonight') return `Tonight in ${where}: ${describe(day.code)}, low of ${deg(day.minC)}, ${rain}.`;
  return `${label} in ${where}: ${describe(day.code)}, high of ${deg(day.maxC)}, low of ${deg(day.minC)}, ${rain}.`;
}

module.exports = { geocode, reverse, forecast, weatherSentence };
