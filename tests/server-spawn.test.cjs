'use strict';
// Tests start app/server.js with spawnAppServer() (tests/spawn-server.cjs: PORT=0, the server reports the port it got).
// Probing for a free port and passing it in as PORT races every other test for it between the probe closing and the server
// binding: on macOS the 0.0.0.0 bind still succeeds, and 127.0.0.1 requests reach whoever took the port.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('no test passes a probed PORT to app/server.js', () => {
  const hits = [];
  for (const f of fs.readdirSync(__dirname).filter(f => /\.(c|m)?js$/.test(f) && f !== 'spawn-server.cjs' && f !== path.basename(__filename))) {
    fs.readFileSync(path.join(__dirname, f), 'utf8').split('\n').forEach((line, i) => { if (/\bPORT: String\(/.test(line)) hits.push(`${f}:${i + 1}`); });
  }
  assert.deepEqual(hits, [], 'start the server with spawnAppServer() from tests/spawn-server.cjs');
});
