'use strict';
// Size budgets for what every page load downloads: index.html and the scripts and stylesheet it references, gzipped
// (the appliance serves them compressed). Measured on 2026-10-16 at 198 KB in all; the budgets allow about 10% growth.
// A PR that goes over should either earn it (raise the number here, saying why in the PR) or trim something.
// When the CSS cleanup shrinks app.css, lower its budget so the space isn't quietly refilled (35.2 KB on 2026-10-16 after
// the first cleanup pass, so 39 KB).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const pub = path.join(__dirname, '..', 'app', 'public');
const KB = 1024;
// 2026-10-17: +10 KB for the Agent World redesign while its old panels and new ones overlap (agent-world-words.js, the
// phone sheet, crew rows); the last Agent World PR removes the old panels and brings this back down.
// 2026-10-17: +7 KB (and app.css +2 KB) for the Spreadsheets workbook view: grid, edit review, history and modes.
// spreadsheets.js is loaded with the shell; if the router ever loads page scripts on demand it should move there.
const TOTAL = 237 * KB; // +2 KB on 2026-10-17 for System › Spreadsheets (spreadsheets.js and its markup), which replaced the separate GridCraft page
// 2026-10-17: ui.js +1 KB for the ArtCraft card on Services (live status and its Open button).
const PER_FILE = { 'ui.js': 93 * KB, 'app.css': 41 * KB, 'app.js': 35 * KB, 'index.html': 13 * KB };
const OTHER = 10 * KB; // any other module the shell loads

const gz = f => zlib.gzipSync(fs.readFileSync(path.join(pub, f)), { level: 9 }).length;
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const shell = ['index.html', ...[...html.matchAll(/<(?:script|link)[^>]*\s(?:src|href)="\/([^"]+\.(?:js|css))"/g)].map(m => m[1])];
const sizes = Object.fromEntries(shell.map(f => [f, gz(f)]));
const kb = n => `${(n / KB).toFixed(1)} KB`;

test('the app shell stays within its total download budget (gzipped)', () => {
  const total = Object.values(sizes).reduce((a, b) => a + b, 0);
  assert.ok(total <= TOTAL, `app shell is ${kb(total)} gzipped, over the ${kb(TOTAL)} budget: ${Object.entries(sizes).map(([f, n]) => `${f} ${kb(n)}`).join(', ')}`);
});

test('each shell file stays within its own budget (gzipped)', () => {
  const over = Object.entries(sizes).filter(([f, n]) => n > (PER_FILE[f] ?? OTHER)).map(([f, n]) => `${f}: ${kb(n)} > ${kb(PER_FILE[f] ?? OTHER)}`);
  assert.deepEqual(over, []);
});

test('the budget covers the files the shell really loads', () => {
  for (const f of ['ui.js', 'app.js', 'app.css']) assert.ok(f in sizes, `${f} is loaded by index.html`);
});
