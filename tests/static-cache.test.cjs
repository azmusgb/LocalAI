'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

test('app code revalidates with ETags so a deploy shows up on the next load', { timeout: 30000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-static-'));
  const reserve = http.createServer();
  reserve.listen(0, '127.0.0.1');
  await once(reserve, 'listening');
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  let diagnostics = '';
  const child = spawn(process.execPath, [path.resolve(__dirname, '../app/server.js')], {
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), WORKSPACE_ROOT: dataDir, OLLAMA_URL: 'http://127.0.0.1:9', SEARXNG_URL: 'http://127.0.0.1:9', COMFY_URL: 'http://127.0.0.1:9', N8N_URL: 'http://127.0.0.1:9', PROXY_URL: 'http://127.0.0.1:9', MAC_AI_HOME_URL: 'http://127.0.0.1:9', MAC_DSH_URL: 'http://127.0.0.1:9' }
  });
  child.stdout.on('data', c => diagnostics += c);
  child.stderr.on('data', c => diagnostics += c);
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) throw new Error(diagnostics);
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch {}
    if (attempt === 79) throw new Error(`Server did not start: ${diagnostics}`);
    await new Promise(r => setTimeout(r, 100));
  }
  for (const file of ['/ui.js', '/components.js', '/app.css', '/index.html', '/sw.js']) {
    const first = await fetch(base + file);
    assert.equal(first.status, 200, file);
    assert.equal(first.headers.get('cache-control'), 'no-cache', `${file} must revalidate`);
    const etag = first.headers.get('etag');
    assert.match(etag, /^"[\w-]{22}"$/, file);
    await first.arrayBuffer();
    const again = await fetch(base + file, { headers: { 'If-None-Match': etag } });
    assert.equal(again.status, 304, `${file} unchanged should be 304`);
    const stale = await fetch(base + file, { headers: { 'If-None-Match': '"stale-release-etag-000"' } });
    assert.equal(stale.status, 200, `${file} changed should be sent in full`);
  }
  // The shell carries the build it came from, so a saved copy knows its release and a stale page can replace itself.
  const health = await (await fetch(base + '/healthz')).json();
  for (const file of ['/', '/index.html']) {
    const html = await (await fetch(base + file)).text();
    assert.match(html, new RegExp(`<meta name="localai-version" content="${health.version.replace(/\./g, '\\.')}">`), file);
    assert.match(html, new RegExp(`<meta name="localai-release" content="${health.releaseCommit || ''}">`), file);
  }
});
