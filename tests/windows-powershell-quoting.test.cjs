'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Windows PowerShell 5.1 (what the host runs) drops double quotes inside an argument it passes to a native program,
// so docker --format '{{index .Config.Labels "com.docker.compose.project"}}' reaches docker without them and fails
// ("function "com" not defined"). Templates must avoid double quotes: use {{json ...}} and read it in PowerShell.
test('no docker --format template in a host script contains a double quote', () => {
  const root = path.join(__dirname, '..');
  const files = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.')) walk(p); else if (e.name.endsWith('.ps1')) files.push(p); } })(root);
  const bad = [];
  for (const f of files) fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/--format\s+'([^']*)'/g)) if (m[1].includes('"')) bad.push(`${path.relative(root, f)}:${i + 1}`);
  });
  assert.deepEqual(bad, []);
});
