'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawnAppServer } = require('./spawn-server.cjs');

// The Connections page shows, per service, when the appliance last asked it. That time comes from the probe itself, and a
// probe that could not connect still has one (the page says "No answer at ...", never a healthy-looking blank).
test('/api/status: every service carries the time it was probed, answered or not', { timeout: 30000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-checked-at-'));
  const off = 'http://127.0.0.1:9';
  const { child, ready } = spawnAppServer({
    env: { DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, OLLAMA_URL: off, SEARXNG_URL: off, COMFY_URL: off, N8N_URL: off, PROXY_URL: off, MAC_AI_HOME_URL: off, MAC_DSH_URL: off }
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = await ready;
  const before = Date.now();
  const status = await (await fetch(`${base}/api/status`)).json();
  const after = Date.now();
  assert.ok(status.services.length >= 5);
  for (const service of status.services) {
    assert.equal(service.state, 'DOWN', `${service.name} is unreachable here`);
    assert.equal(service.statusCode, null);
    const at = Date.parse(service.checkedAt);
    assert.ok(at >= before - 1000 && at <= after + 1000, `${service.name} checkedAt is when it was probed: ${service.checkedAt}`);
  }
});
