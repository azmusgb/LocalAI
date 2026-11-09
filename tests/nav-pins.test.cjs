'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawnAppServer } = require('./spawn-server.cjs');
const pins = require('../app/public/pins');

// The rules the server and the browser share (app/public/pins.js).
test('clean keeps known pages in order, drops unknown ids, repeats, Home and non-strings', () => {
  assert.deepEqual(pins.clean(['models', 'nope', 'models', 'home', 7, null, 'status']), { ids: ['models', 'status'], tooMany: false });
  assert.deepEqual(pins.clean(undefined), { ids: [], tooMany: false });
});
test('clean flags more than four pages; a hidden page without an owner area cannot be pinned', () => {
  const r = pins.clean(['work', 'models', 'status', 'settings', 'activity']);
  assert.equal(r.tooMany, true);
  assert.equal(r.ids.length, 4);
  assert.deepEqual(pins.clean(['ask', 'runs', 'spreadsheets']).ids, ['spreadsheets']);
});

async function startServer(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-pins-'));
  const off = 'http://127.0.0.1:9';
  const { child, ready } = spawnAppServer({ env: { DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, OLLAMA_URL: off, COMFY_URL: off, N8N_URL: off, PROXY_URL: off, SEARXNG_URL: off, MAC_AI_HOME_URL: off, MAC_DSH_URL: off } });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = await ready;
  const put = (body, headers = {}) => fetch(base + '/api/nav/pins', { method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const get = async () => (await fetch(base + '/api/nav/pins')).json();
  return { put, get };
}

test('GET is empty at first; PUT saves, cleans and returns the list; GET reads it back', async t => {
  const { put, get } = await startServer(t);
  assert.deepEqual((await get()).ids, []);
  const r = await put({ ids: ['models', 'nope', 'models', 'status'] });
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).ids, ['models', 'status']);
  assert.deepEqual((await get()).ids, ['models', 'status']);
  assert.equal((await put({ ids: [] })).status, 200);
  assert.deepEqual((await get()).ids, []);
});

test('PUT refuses a fifth page with a plain message, and keeps the old list', async t => {
  const { put, get } = await startServer(t);
  await put({ ids: ['work'] });
  const r = await put({ ids: ['work', 'models', 'status', 'settings', 'activity'] });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /up to 4 pages.*Unpin one/);
  assert.deepEqual((await get()).ids, ['work']);
});

test('PUT refuses a body without a list, bad JSON, a wrong content type and a foreign origin', async t => {
  const { put, get } = await startServer(t);
  assert.equal((await put({ ids: 'models' })).status, 400);
  assert.equal((await put({})).status, 400);
  assert.equal((await put('{nope')).status, 400);
  assert.equal((await put({ ids: ['models'] }, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await put({ ids: ['models'] }, { Origin: 'https://evil.example' })).status, 403);
  assert.deepEqual((await get()).ids, []);
});
