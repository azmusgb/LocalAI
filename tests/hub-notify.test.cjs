'use strict';
const test = require('node:test');
const fs = require('node:fs'), path = require('node:path');
const assert = require('node:assert/strict');
const { createHubNotify, clickFor } = require('../app/hub-notify.js');

const fakeFetch = (statusOrThrow, calls) => async (url, opts) => {
  calls.push({ url, opts, body: JSON.parse(opts.body) });
  if (statusOrThrow === 'throw') throw new Error('ECONNREFUSED');
  return { status: statusOrThrow };
};

test('no key or a plain http hub means no Pi Hub channel', () => {
  assert.equal(createHubNotify({ key: '' }), null);
  assert.equal(createHubNotify({ key: 'k', url: 'http://hub' }), null);
});

test('posts the event to /api/notify/localai with the deploy key and a tap link on the app name', async () => {
  const calls = [];
  const send = createHubNotify({ key: 'k1', url: 'https://hub.example/', name: 'localai.home.arpa', fetchImpl: fakeFetch(200, calls) });
  const r = await send({ kind: 'failed', title: 'Failed', body: 'Run 7', url: '/?open=run:r7', tag: 'run:r7' });
  assert.deepEqual(r, { ok: true, status: 200 });
  assert.equal(calls[0].url, 'https://hub.example/api/notify/localai');
  assert.equal(calls[0].opts.headers['X-Hub-Deploy-Key'], 'k1');
  assert.equal(calls[0].opts.redirect, 'error');
  assert.deepEqual(calls[0].body, { kind: 'failed', title: 'Failed', body: 'Run 7', click: 'https://localai.home.arpa/?open=run:r7', dedupe: 'failed:run:r7:Failed' });
});

test('2xx and 429 count as taken; 4xx, 5xx and network errors do not', async () => {
  for (const [s, ok] of [[200, true], [429, true], [400, false], [401, false], [502, false], ['throw', false]]) {
    const send = createHubNotify({ key: 'k', fetchImpl: fakeFetch(s, []) });
    assert.equal((await send({ kind: 'service', title: 'Down' })).ok, ok, String(s));
  }
});

test('only an app path becomes a tap link', () => {
  assert.equal(clickFor('/?open=status', 'localai.home.arpa'), 'https://localai.home.arpa/?open=status');
  assert.equal(clickFor('#run/1', 'n'), undefined);
  assert.equal(clickFor('//evil.example/', 'n'), undefined);
  assert.equal(clickFor('/a b', 'n'), undefined);
  assert.equal(clickFor('/\\evil', 'n'), undefined);
});

test('long text is cut to what Pi Hub accepts', async () => {
  const calls = [];
  const send = createHubNotify({ key: 'k', fetchImpl: fakeFetch(200, calls) });
  await send({ kind: 'answer', title: 't'.repeat(300), body: 'b'.repeat(900), tag: 'x'.repeat(200) });
  assert.equal(calls[0].body.title.length, 120);
  assert.equal(calls[0].body.body.length, 500);
  assert.equal(calls[0].body.dedupe.length, 80);
});

test('the notifier has its own URL variable; compose never sets the LAN one pi-hub.js reads', () => {
  const fs = require('node:fs'), path = require('node:path');
  const src = fs.readFileSync(path.resolve(__dirname, '../app/hub-notify.js'), 'utf8');
  assert.match(src, /process\.env\.LOCALAI_PI_HUB_NOTIFY_URL/);
  assert.doesNotMatch(src, /process\.env\.LOCALAI_PI_HUB_URL\b/);
  const compose = fs.readFileSync(path.resolve(__dirname, '../deploy/stack/compose.yml'), 'utf8');
  assert.doesNotMatch(compose, /^\s*LOCALAI_PI_HUB_URL:/m, 'pi-hub.js and print-lab.js keep http://10.0.0.30');
});


test('the default app name is the registry address, not the retired home.arpa name', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../app/hub-notify.js'), 'utf8');
  assert.match(src, /LOCALAI_NAME \|\| 'assistant\.rahe-home\.duckdns\.org'/);
  assert.doesNotMatch(src, /home\.arpa/);
});
