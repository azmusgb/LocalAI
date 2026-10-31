'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnAppServer } = require('./spawn-server.cjs');

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;

  await new Promise((resolve, reject) => {
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.removeListener('exit', finish);
      reject(new Error(`child ${child.pid || 'unknown'} did not exit after kill()`));
    }, 5000);
    timer.unref?.();

    child.once('exit', finish);

    try {
      if (!child.kill()) finish();
    } catch (error) {
      child.removeListener('exit', finish);
      clearTimeout(timer);
      reject(error);
    }
  });
}

function removeTree(dir) {
  fs.rmSync(dir, {
    recursive: true,
    force: true,
    ...(process.platform === 'win32'
      ? { maxRetries: 5, retryDelay: 50 }
      : {}),
  });
}


test('the mission event stream sends keep-alive comments while quiet', { timeout: 30000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-sse-'));
  const { child, ready } = spawnAppServer({
    env: { DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, SSE_KEEPALIVE_MS: '200', OLLAMA_URL: 'http://127.0.0.1:9' }
  });
  t.after(async () => {
    await stopChild(child);
    removeTree(dataDir);
  });
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
