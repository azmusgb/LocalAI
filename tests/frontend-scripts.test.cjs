'use strict';
// Every front-end module must be loaded by index.html and precached by the service worker. A merge that resolves the
// one-line <script> list or SHELL by keeping one side silently drops a module (it dropped run-bodies.js once, in #151).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pub = path.join(__dirname, '..', 'app', 'public');
// Not a page module: the service worker itself.
const NOT_PAGE_SCRIPTS = new Set(['sw.js']);
const modules = fs.readdirSync(pub).filter(f => f.endsWith('.js') && !NOT_PAGE_SCRIPTS.has(f));

// Loaded on first use by ui.js, not on every page load (still precached by the service worker).
const ON_DEMAND = new Set(['agent-world-watch.js', 'print-lab.js', 'print-lab-guide.js', 'print-lab-photos.js']);

test('index.html loads every front-end module', () => {
  const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
  const loaded = new Set([...html.matchAll(/<script[^>]*\ssrc="\/([^"]+\.js)"/g)].map(m => m[1]));
  assert.deepEqual(modules.filter(f => !loaded.has(f) && !ON_DEMAND.has(f)), []);
  const ui = fs.readFileSync(path.join(pub, 'ui.js'), 'utf8');
  for (const f of ON_DEMAND) assert.ok(ui.includes(`'/${f}'`), `ui.js loads ${f} on demand`);
});

test('the service worker precaches every front-end module', () => {
  const sw = fs.readFileSync(path.join(pub, 'sw.js'), 'utf8');
  const shell = sw.match(/const SHELL=\[([^\]]*)\]/);
  assert.ok(shell, 'sw.js defines SHELL');
  const cached = new Set([...shell[1].matchAll(/'\/([^']+\.js)'/g)].map(m => m[1]));
  assert.deepEqual(modules.filter(f => !cached.has(f)), []);
});

// Agent World's on-demand modules (app/public/aw/*.js) are not in index.html: ui.js loads the ones in AW_MODS the first
// time the city is on screen, and the service worker precaches them so the city works offline too.
test('every Agent World on-demand module is in the loader and precached, and none is in index.html', () => {
  const aw = fs.readdirSync(path.join(pub, 'aw')).filter(f => f.endsWith('.js')).map(f => f.slice(0, -3)).sort();
  const ui = fs.readFileSync(path.join(pub, 'ui.js'), 'utf8'), list = ui.match(/AW_MODS=\[([^\]]*)\]/);
  assert.ok(list, 'ui.js defines AW_MODS');
  assert.deepEqual([...list[1].matchAll(/'([^']+)'/g)].map(m => m[1]).sort(), aw);
  const sw = fs.readFileSync(path.join(pub, 'sw.js'), 'utf8'), shell = sw.match(/const SHELL=\[([^\]]*)\]/)[1];
  assert.deepEqual(aw.filter(m => !shell.includes(`'/aw/${m}.js'`)), []);
  const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
  assert.deepEqual(aw.filter(m => html.includes(`/aw/${m}.js`)), []);
});
