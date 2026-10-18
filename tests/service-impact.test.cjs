'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawnAppServer } = require('./spawn-server.cjs');

// Home › Needs you shows a down service's impact: it says what stops working, never "Core capability affected".
test('a down core service says what stops working; an optional one says the rest is fine', { timeout: 30000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-impact-'));
  const off = 'http://127.0.0.1:9';
  const { child, ready } = spawnAppServer({
    env: { DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, OLLAMA_URL: off, SEARXNG_URL: off, COMFY_URL: off, N8N_URL: off, PROXY_URL: off, MAC_AI_HOME_URL: off, MAC_DSH_URL: off, GRIDCRAFT_URL: off }
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = await ready;
  const { services } = await (await fetch(`${base}/api/capabilities`)).json();
  const impact = name => services.find(s => s.name === name)?.impact;
  assert.equal(impact('ollama'), 'Chat, research and missions are unavailable.');
  assert.equal(impact('comfy'), 'Images are unavailable.');
  assert.equal(impact('home'), 'Core appliance unaffected');
  assert.ok(services.every(s => !/capability/i.test(s.impact || '')), 'no developer words');
});
