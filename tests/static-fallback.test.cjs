'use strict';
// The page shell is served for any unknown page path (the hash router owns pages), but never for /api/: an API address
// nothing serves must answer 404 JSON, or a removed or misspelt endpoint reads as a 200 and its caller fails to parse HTML.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createWeb } = require('../app/server/web.js');

function get(pathname) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-static-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><head></head><body>shell</body></html>');
  return new Promise((resolve) => {
    const sent = (status, body, type) => { fs.rmSync(dir, { recursive: true, force: true }); resolve({ status, body: String(body), type }); };
    const { serveStatic } = createWeb({
      PUBLIC_DIR: dir, fs, path, crypto, APP_VERSION: 'test', release: () => ({}), accessAddresses: () => [],
      json: (res, status, obj) => sent(status, JSON.stringify(obj), 'application/json'),
      text: (res, status, body, type) => sent(status, body, type || 'text/plain'),
    });
    serveStatic({ headers: {} }, { writeHead() {}, end() {} }, pathname);
  });
}

test('an unknown /api/ address answers 404 JSON, not the page shell', async () => {
  for (const p of ['/api/no-such', '/api/atlas/nothing-here', '/api']) {
    const r = await get(p);
    assert.equal(r.status, 404, p);
    assert.match(r.type, /json/, p);
    assert.deepEqual(JSON.parse(r.body), { error: 'Not found' }, p);
  }
});

test('an unknown page path still gets the shell', async () => {
  const r = await get('/work');
  assert.equal(r.status, 200);
  assert.match(r.body, /shell/);
});

test('a path that merely starts with "api" is a page, not the API', async () => {
  assert.equal((await get('/apiary')).status, 200);
});
