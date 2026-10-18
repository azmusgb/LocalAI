'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnAppServer } = require('./spawn-server.cjs');

test('the mission event stream sends keep-alive comments while quiet', { timeout: 30000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-sse-'));
  const { child, ready } = spawnAppServer({
    env: { DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, SSE_KEEPALIVE_MS: '200', OLLAMA_URL: 'http://127.0.0.1:9' }
  });
  t.after(() => { child.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = await ready;

  const ctrl = new AbortController();
  const res = await fetch(base + '/api/agents/missions/events', { signal: ctrl.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader(), dec = new TextDecoder();
  let text = '';
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && (text.match(/: keepalive/g) || []).length < 2) {
    const { value, done } = await reader.read(); if (done) break; text += dec.decode(value);
  }
  ctrl.abort();
  assert.match(text, /^: connected/);
  assert.ok((text.match(/: keepalive/g) || []).length >= 2, `expected keep-alive comments, got ${JSON.stringify(text)}`);
});
