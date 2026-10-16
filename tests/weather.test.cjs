'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const weather = require('../app/weather');

const reply = (body, ok = true, status = 200) => async () => ({ ok, status, json: async () => body });
const recorder = body => { const calls = []; const f = async (url, opts) => { calls.push({ url: String(url), opts }); return { ok: true, status: 200, json: async () => body }; }; f.calls = calls; return f; };

const FORECAST = {
  current: { temperature_2m: 23.6, weather_code: 1 },
  daily: {
    weather_code: [3, 0], temperature_2m_max: [31.2, 28.9], temperature_2m_min: [18.4, 16.1], precipitation_probability_max: [60, 0]
  }
};

test('geocode parses Open-Meteo search results', async () => {
  const f = recorder({ results: [{ name: 'Phoenix', latitude: 33.4484, longitude: -112.074, timezone: 'America/Phoenix', admin1: 'Arizona' }] });
  const r = await weather.geocode('Phoenix, AZ', { fetch: f });
  assert.deepEqual(r, { name: 'Phoenix', lat: 33.4484, lon: -112.074, timeZone: 'America/Phoenix' });
  assert.match(f.calls[0].url, /\/v1\/search\?/);
  assert.match(f.calls[0].url, /name=Phoenix/);
});

test('geocode returns null when nothing matches, and rejects when the service fails (M5)', async () => {
  assert.equal(await weather.geocode('zzzz', { fetch: reply({}) }), null);
  assert.equal(await weather.geocode('zzzz', { fetch: reply({ results: [] }) }), null);
  assert.equal(await weather.geocode('', { fetch: reply({}) }), null);
  await assert.rejects(weather.geocode('zzzz', { fetch: reply({}, false, 500) }));
  await assert.rejects(weather.geocode('zzzz', { fetch: async () => { throw new Error('ECONNREFUSED'); } }));
});

test('reverse asks Nominatim with a User-Agent and picks city, town, village, then county', async () => {
  const f = recorder({ address: { city: 'Tempe', county: 'Maricopa County' } });
  assert.equal(await weather.reverse(33.4, -111.9, { fetch: f }), 'Tempe');
  assert.match(f.calls[0].url, /\/reverse\?format=jsonv2&lat=33\.4&lon=-111\.9&zoom=10/);
  assert.equal(f.calls[0].opts.headers['User-Agent'], 'LocalAI-appliance');
  assert.equal(await weather.reverse(1, 2, { fetch: reply({ address: { town: 'Oro Valley' } }) }), 'Oro Valley');
  assert.equal(await weather.reverse(1, 2, { fetch: reply({ address: { village: 'Cave Creek' } }) }), 'Cave Creek');
  assert.equal(await weather.reverse(1, 2, { fetch: reply({ address: { county: 'Pima County' } }) }), 'Pima County');
  assert.equal(await weather.reverse(1, 2, { fetch: reply({ address: {} }) }), null);
  assert.equal(await weather.reverse(1, 2, { fetch: reply({}, false, 500) }), null);
});

test('forecast parses current, today and tomorrow, and rejects on a service error', async () => {
  const f = recorder(FORECAST);
  const r = await weather.forecast(33.4, -112.1, { fetch: f, timeZone: 'America/Phoenix' });
  assert.deepEqual(r, {
    now: { tempC: 23.6, code: 1, isDay: null },
    today: { maxC: 31.2, minC: 18.4, rainChance: 60, code: 3 },
    tomorrow: { maxC: 28.9, minC: 16.1, rainChance: 0, code: 0 },
    tonight: null
  });
  assert.match(f.calls[0].url, /timezone=America%2FPhoenix/);
  assert.match((await (async () => { const g = recorder(FORECAST); await weather.forecast(1, 2, { fetch: g }); return g.calls[0].url; })()), /timezone=auto/);
  await assert.rejects(weather.forecast(1, 2, { fetch: reply({}, false, 500) }));
});

test('weatherSentence: tomorrow in F and C, spoken numbers only', () => {
  const f = { now: { tempC: 23.6, code: 1 }, today: { maxC: 31.2, minC: 18.4, rainChance: 60, code: 3 }, tomorrow: { maxC: 28.9, minC: 16.1, rainChance: 0, code: 0 } };
  assert.equal(weather.weatherSentence(f, { when: 'tomorrow', place: 'Phoenix', units: 'F' }), 'Tomorrow in Phoenix: sunny, high of 84, low of 61, no rain expected.');
  assert.equal(weather.weatherSentence(f, { when: 'tomorrow', place: 'Phoenix', units: 'C' }), 'Tomorrow in Phoenix: sunny, high of 29, low of 16, no rain expected.');
  assert.equal(weather.weatherSentence(f, { when: 'tomorrow', place: 'Phoenix' }), 'Tomorrow in Phoenix: sunny, high of 84, low of 61, no rain expected.');
  assert.equal(weather.weatherSentence(f, { when: 'now', place: 'Phoenix', units: 'F' }), 'Right now in Phoenix: 74 degrees and mostly sunny.');
  assert.equal(weather.weatherSentence(f, { when: 'today', place: null }), 'Today here: overcast, high of 88, low of 65, 60 percent chance of rain.');
});

test('weatherSentence without a place says "here" for every time', () => {
  const f = { tonight: { minC: 11, rainChance: 5, code: 0 }, now: { tempC: 23.6, code: 1 }, today: { maxC: 31.2, minC: 18.4, rainChance: 60, code: 3 }, tomorrow: { maxC: 28.9, minC: 16.1, rainChance: 0, code: 0 } };
  assert.match(weather.weatherSentence(f, { when: 'tomorrow' }), /^Tomorrow here: /);
  assert.match(weather.weatherSentence(f, { when: 'tonight' }), /^Tonight here: /);
  assert.match(weather.weatherSentence(f, { when: 'now' }), /^Right now here: /);
  assert.match(weather.weatherSentence(f, { when: 'today', place: null }), /^Today here: /);
});

test('geocode uses the qualifier after the comma: state names, abbreviations, countries; else the first match', async () => {
  const results = [
    { name: 'Springfield', latitude: 37.2, longitude: -93.3, timezone: 'America/Chicago', admin1: 'Missouri', country: 'United States', country_code: 'US' },
    { name: 'Springfield', latitude: 39.8, longitude: -89.6, timezone: 'America/Chicago', admin1: 'Illinois', country: 'United States', country_code: 'US' },
    { name: 'Springfield', latitude: 51.7, longitude: 0.5, timezone: 'Europe/London', admin1: 'England', country: 'United Kingdom', country_code: 'GB' }
  ];
  const f = recorder({ results });
  assert.equal((await weather.geocode('Springfield, IL', { fetch: f })).lat, 39.8);
  assert.match(f.calls[0].url, /count=10/);
  assert.match(f.calls[0].url, /name=Springfield(&|$)/);
  assert.equal((await weather.geocode('Springfield, Illinois', { fetch: f })).lat, 39.8);
  assert.equal((await weather.geocode('springfield, il', { fetch: f })).lat, 39.8);
  assert.equal((await weather.geocode('Springfield, UK', { fetch: f })).lat, 51.7);
  assert.equal((await weather.geocode('Springfield, GB', { fetch: f })).lat, 51.7);
  assert.equal((await weather.geocode('Springfield, United Kingdom', { fetch: f })).lat, 51.7);
  assert.equal((await weather.geocode('Springfield, ZZ', { fetch: f })).lat, 37.2);
  assert.equal((await weather.geocode('Springfield', { fetch: f })).lat, 37.2);
});

// ---- fix round 1 ----
const hourlyFixture = ({ nowTime = '2026-10-15T19:00', is_day = 0 } = {}) => {
  const time = [], temperature_2m = [], weather_code = [], precipitation_probability = [];
  for (const day of ['2026-10-15', '2026-10-16']) for (let h = 0; h < 24; h++) {
    const hh = String(h).padStart(2, '0');
    time.push(`${day}T${hh}:00`); temperature_2m.push(20); weather_code.push(0); precipitation_probability.push(0);
  }
  const set = (t, temp, code, rain) => { const i = time.indexOf(t); temperature_2m[i] = temp; weather_code[i] = code; precipitation_probability[i] = rain; };
  set('2026-10-15T10:00', -50, 95, 90);   // before the window
  set('2026-10-15T18:00', -40, 95, 90);   // before "now" when asked at 19:00
  set('2026-10-15T22:00', 11, 2, 5);      // inside: the low, and the worst code
  set('2026-10-16T05:00', 12, 0, 10);     // inside, the rain peak
  set('2026-10-16T07:00', -60, 99, 100);  // after 06:00
  return { current: { time: nowTime, temperature_2m: 15, weather_code: 0, is_day }, daily: FORECAST.daily, hourly: { time, temperature_2m, weather_code, precipitation_probability } };
};

test('I1: tonight is hourly, from now (past 18:00) to 06:00: min temp, max rain, worst code', async () => {
  const f = recorder(hourlyFixture());
  const r = await weather.forecast(33.4, -112.1, { fetch: f });
  assert.deepEqual(r.tonight, { minC: 11, rainChance: 10, code: 2 });
  assert.match(f.calls[0].url, /hourly=temperature_2m%2Cweather_code%2Cprecipitation_probability/);
  assert.match(f.calls[0].url, /current=[^&]*is_day/);
  assert.match(f.calls[0].url, /timezone=auto/);
});

test('I1: asked in the afternoon, tonight starts at 18:00; asked after midnight it runs to 06:00 today', async () => {
  const afternoon = await weather.forecast(1, 2, { fetch: recorder(hourlyFixture({ nowTime: '2026-10-15T11:00' })) });
  assert.deepEqual(afternoon.tonight, { minC: -40, rainChance: 90, code: 95 }); // 18:00 is in; 10:00 and next-day 07:00 stay out
  const fx = hourlyFixture({ nowTime: '2026-10-16T02:00' });
  const late = await weather.forecast(1, 2, { fetch: recorder(fx) });
  assert.deepEqual(late.tonight, { minC: 12, rainChance: 10, code: 0 }); // 02:00 to 06:00 on the 16th: the 05:00 hour
});

test('I1: tonight is spoken from the window', () => {
  const f = { now: { tempC: 15, code: 0, isDay: 0 }, tonight: { minC: 11, rainChance: 5, code: 0 } };
  assert.equal(weather.weatherSentence(f, { when: 'tonight', place: 'X' }), 'Tonight in X: clear, low of 52, no rain expected.');
  assert.equal(weather.weatherSentence({ tonight: { minC: 11, rainChance: 40, code: 2 } }, { when: 'tonight', place: 'X' }), 'Tonight in X: partly cloudy, low of 52, 40 percent chance of rain.');
  assert.equal(weather.weatherSentence({ tonight: null }, { when: 'tonight', place: 'X' }), null);
});

test('I2: at night, sunny and mostly sunny are clear and mostly clear', async () => {
  const r = await weather.forecast(1, 2, { fetch: recorder(hourlyFixture({ is_day: 0 })) });
  assert.equal(r.now.isDay, 0);
  const night = code => weather.weatherSentence({ now: { tempC: 16, code, isDay: 0 } }, { when: 'now', place: 'X' });
  assert.equal(night(0), 'Right now in X: 61 degrees and clear.');
  assert.equal(night(1), 'Right now in X: 61 degrees and mostly clear.');
  assert.equal(weather.weatherSentence({ now: { tempC: 16, code: 0, isDay: 1 } }, { when: 'now', place: 'X' }), 'Right now in X: 61 degrees and sunny.');
});

test('M1: null or missing values are left out; nothing usable is null', () => {
  const bad = /null|NaN|undefined/;
  const day = { maxC: 30, minC: null, rainChance: null, code: 0 };
  const a = weather.weatherSentence({ today: day, tomorrow: { maxC: undefined, minC: undefined, rainChance: undefined, code: 3 }, now: { tempC: null, code: 3 } }, { when: 'today', place: 'X' });
  assert.equal(a, 'Today in X: sunny, high of 86.');
  assert.equal(weather.weatherSentence({ today: day, tomorrow: { code: 3 }, now: { tempC: null, code: 3 } }, { when: 'tomorrow', place: 'X' }), 'Tomorrow in X: overcast.');
  assert.equal(weather.weatherSentence({ now: { tempC: null, code: 3 } }, { when: 'now', place: 'X' }), 'Right now in X: overcast.');
  assert.equal(weather.weatherSentence({ now: { tempC: 20, code: null } }, { when: 'now', place: 'X' }), 'Right now in X: 68 degrees.');
  for (const when of ['now', 'today', 'tomorrow', 'tonight']) {
    const s = weather.weatherSentence({ now: {}, today: {}, tomorrow: {}, tonight: {} }, { when, place: 'X' });
    assert.equal(s, null);
    assert.doesNotMatch(String(a), bad);
  }
});

test('M1: a forecast with nothing usable rejects', async () => {
  await assert.rejects(weather.forecast(1, 2, { fetch: reply({}) }));
  await assert.rejects(weather.forecast(1, 2, { fetch: reply({ current: { temperature_2m: null }, daily: {} }) }));
});

test('M3: a 2-letter qualifier is a US state before a country code', async () => {
  const ca = [
    { name: 'London', latitude: 42.98, longitude: -81.2, timezone: 'America/Toronto', admin1: 'Ontario', country: 'Canada', country_code: 'CA' },
    { name: 'London', latitude: 37.1, longitude: -120.4, timezone: 'America/Los_Angeles', admin1: 'California', country: 'United States', country_code: 'US' }
  ];
  assert.equal((await weather.geocode('London, CA', { fetch: recorder({ results: ca }) })).lat, 37.1);
  assert.equal((await weather.geocode('London, Canada', { fetch: recorder({ results: ca }) })).lat, 42.98);
  const inn = [
    { name: 'Springfield', latitude: 10, longitude: 10, timezone: 'Asia/Kolkata', admin1: 'Kerala', country: 'India', country_code: 'IN' },
    { name: 'Springfield', latitude: 39.8, longitude: -86.1, timezone: 'America/Indiana/Indianapolis', admin1: 'Indiana', country: 'United States', country_code: 'US' }
  ];
  assert.equal((await weather.geocode('Springfield, IN', { fetch: recorder({ results: inn }) })).lat, 39.8);
  assert.equal((await weather.geocode('Springfield, India', { fetch: recorder({ results: inn }) })).lat, 10);
  // no state of that name among the results: the country code still works
  assert.equal((await weather.geocode('Springfield, IN', { fetch: recorder({ results: [inn[0]] }) })).lat, 10);
});
