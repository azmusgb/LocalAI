'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { Storage } = require('../app/storage');
const { createNav } = require('../app/server/nav');
const { spawnAppServer } = require('./spawn-server.cjs');

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-nav-opens-'));
  const storage = new Storage({ dataDir });
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { storage, nav: createNav({ storage, json() {}, readBody() {}, sameOriginJson: () => true, storageError() {} }) };
}
const day = (y, m, d) => new Date(y, m - 1, d, 12);

test('opens are counted per view and day, most opened first', t => {
  const { nav, storage } = setup(t), today = day(2026, 11, 9);
  for (let i = 0; i < 3; i++) assert.equal(nav.record('work', today), 'work');
  nav.record('home', today);
  nav.record('home', day(2026, 11, 8));
  assert.deepEqual(storage.readSetting('nav-opens:2026-11-09'), { day: '2026-11-09', views: { work: 3, home: 1 } });
  assert.deepEqual(nav.totals(30, today), [
    { view: 'work', label: 'Work', count: 3 },
    { view: 'home', label: 'Home', count: 2 }
  ]);
  assert.deepEqual(nav.totals(1, today).map(x => x.view), ['work', 'home'], 'one day counts only today');
  assert.equal(nav.totals(1, today).find(x => x.view === 'home').count, 1);
});

test('only known ids count, and an alias counts as the page it resolves to', t => {
  const { nav, storage } = setup(t), today = day(2026, 11, 9);
  for (const bad of ['', 'nope', '__proto__', 'x'.repeat(100), null, undefined, 7, {}, ['work']]) assert.equal(nav.record(bad, today), null, String(bad));
  assert.equal(storage.listSettings('nav-opens:').length, 0, 'a refused id writes nothing');
  assert.equal(nav.record('deployments', today), 'shipped');
  assert.equal(nav.record('changes', today), 'inProgress');
  assert.deepEqual(nav.totals(30, today).map(x => x.view).sort(), ['inProgress', 'shipped']);
});

test('counts older than 90 days are pruned on the next write', t => {
  const { nav, storage } = setup(t), today = day(2026, 11, 9);
  nav.record('home', day(2026, 7, 1));  // 131 days back
  nav.record('home', day(2026, 8, 12)); // 89 days back: kept
  nav.record('home', day(2026, 8, 11)); // 90 days back: out (today and the 89 days before are kept)
  nav.record('work', today);
  const keys = storage.listSettings('nav-opens:').map(r => r.day).sort();
  assert.deepEqual(keys, ['2026-08-12', '2026-11-09']);
  assert.equal(nav.totals(90, today).length, 2);
});

test('reset forgets every count and nothing else', t => {
  const { nav, storage } = setup(t), today = day(2026, 11, 9);
  storage.writeSetting('nav-pins', { ids: ['work'] });
  nav.record('home', today); nav.record('work', day(2026, 11, 1));
  assert.equal(nav.clear(), 2);
  assert.deepEqual(nav.totals(30, today), []);
  assert.deepEqual(storage.readSetting('nav-pins'), { ids: ['work'] });
  assert.equal(nav.clear(), 0);
});

test('the HTTP routes validate, count, list and reset', { timeout: 30000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-nav-api-'));
  const off = 'http://127.0.0.1:9';
  const { child, ready } = spawnAppServer({ env: { DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, OLLAMA_URL: off, COMFY_URL: off, N8N_URL: off, PROXY_URL: off, SEARXNG_URL: off, MAC_AI_HOME_URL: off, MAC_DSH_URL: off, LOCALAI_PI_HUB_URL: 'off' } });
  t.after(async () => {
    if (child.exitCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = await ready;
  const post = (body, headers = { 'Content-Type': 'application/json' }) => fetch(`${base}/api/nav/open`, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal((await post({ view: 'work' })).status, 200);
  assert.equal((await post({ view: 'work' })).status, 200);
  assert.equal((await post({ view: 'runs' })).status, 200);
  assert.equal((await post({ view: 'nope' })).status, 400);
  assert.equal((await post({})).status, 400);
  assert.equal((await post({ view: 'work' }, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post({ view: 'work' }, { 'Content-Type': 'application/json', Origin: 'https://evil.example' })).status, 403);
  for (const days of ['0', '91', 'x', '2.5']) assert.equal((await fetch(`${base}/api/nav/opens?days=${days}`)).status, 400, days);
  const list = await (await fetch(`${base}/api/nav/opens?days=30`)).json();
  assert.equal(list[0].view, 'work'); assert.equal(list[0].count, 3, 'runs is an alias of work');
  assert.equal(list[0].label, 'Work');
  assert.equal((await fetch(`${base}/api/nav/opens`, { method: 'DELETE', headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(`${base}/api/nav/opens`, { method: 'DELETE' })).status, 200);
  assert.deepEqual(await (await fetch(`${base}/api/nav/opens`)).json(), []);
});
