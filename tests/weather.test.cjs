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

test('geocode returns null when nothing matches or the service fails', async () => {
  assert.equal(await weather.geocode('zzzz', { fetch: reply({}) }), null);
  assert.equal(await weather.geocode('zzzz', { fetch: reply({}, false, 500) }), null);
  assert.equal(await weather.geocode('', { fetch: reply({}) }), null);
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
    now: { tempC: 23.6, code: 1 },
    today: { maxC: 31.2, minC: 18.4, rainChance: 60, code: 3 },
    tomorrow: { maxC: 28.9, minC: 16.1, rainChance: 0, code: 0 }
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
  assert.match(weather.weatherSentence(f, { when: 'tonight', place: 'Phoenix' }), /^Tonight in Phoenix: .*low of 65/);
});

test('weatherSentence without a place says "here" for every time', () => {
  const f = { now: { tempC: 23.6, code: 1 }, today: { maxC: 31.2, minC: 18.4, rainChance: 60, code: 3 }, tomorrow: { maxC: 28.9, minC: 16.1, rainChance: 0, code: 0 } };
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
  assert.equal((await weather.geocode('Springfield, UK', { fetch: f })).lat, 37.2);
  assert.equal((await weather.geocode('Springfield, GB', { fetch: f })).lat, 51.7);
  assert.equal((await weather.geocode('Springfield, United Kingdom', { fetch: f })).lat, 51.7);
  assert.equal((await weather.geocode('Springfield, ZZ', { fetch: f })).lat, 37.2);
  assert.equal((await weather.geocode('Springfield', { fetch: f })).lat, 37.2);
});
