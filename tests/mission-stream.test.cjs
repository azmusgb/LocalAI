'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

test('the mission event stream sends keep-alive comments while quiet', { timeout: 30000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-sse-'));
  const reserve = http.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise(r => reserve.close(r));
  const child = spawn(process.execPath, [path.resolve(__dirname, '../app/server.js')], {
    env: { ...process.env, DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, PORT: String(port), SSE_KEEPALIVE_MS: '200', OLLAMA_URL: 'http://127.0.0.1:9' },
    stdio: 'ignore'
  });
  t.after(() => { child.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }

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
