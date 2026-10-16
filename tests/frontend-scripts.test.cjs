'use strict';
// Every front-end module must be loaded by index.html and precached by the service worker. A merge that resolves the
// one-line <script> list or SHELL by keeping one side silently drops a module (it dropped run-bodies.js once, in #151).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pub = path.join(__dirname, '..', 'app', 'public');
// Not page modules: the service worker itself, and GridCraft's script, which its own page (gridcraft.html) loads.
const NOT_PAGE_SCRIPTS = new Set(['sw.js', 'gridcraft.js']);
const modules = fs.readdirSync(pub).filter(f => f.endsWith('.js') && !NOT_PAGE_SCRIPTS.has(f));

test('index.html loads every front-end module', () => {
  const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
  const loaded = new Set([...html.matchAll(/<script[^>]*\ssrc="\/([^"]+\.js)"/g)].map(m => m[1]));
  assert.deepEqual(modules.filter(f => !loaded.has(f)), []);
});

test('the service worker precaches every front-end module', () => {
  const sw = fs.readFileSync(path.join(pub, 'sw.js'), 'utf8');
  const shell = sw.match(/const SHELL=\[([^\]]*)\]/);
  assert.ok(shell, 'sw.js defines SHELL');
  const cached = new Set([...shell[1].matchAll(/'\/([^']+\.js)'/g)].map(m => m[1]));
  assert.deepEqual(modules.filter(f => !cached.has(f)), []);
});
