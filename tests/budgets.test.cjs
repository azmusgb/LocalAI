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
// 2026-10-17: +10 KB for the Agent World redesign (agent-world-words.js, the phone sheet, crew rows, story, worker card,
// start sheet); its last PR removed the old panels (form, timeline, inspector, history, tabs, side panels): 237 -> 236 KB.
// 2026-10-17: +7 KB (and app.css +2 KB) for the Spreadsheets workbook view: grid, edit review, history and modes.
// spreadsheets.js is loaded with the shell; if the router ever loads page scripts on demand it should move there.
// 2026-10-17: +1 KB: navigation step 5 (#285) put main 0.2 KB over (240.2 KB measured): the strip's scroll-to-a-tab-start
// helper and the Inbox's shared waiting words, on top of the Agent World buildings (#283).
// 2026-10-18: 241 → 242 KB for the saved copy's "Open over Tailscale" and Health's address list (241.7 KB measured).
// 2026-10-18: 242 → 243 KB for Agent World's partial-findings words ("Finished with partial findings", the mission
// note, the Partly done badge): +0.4 KB, 242.0 KB measured.
// 2026-10-18: 243 → 245 KB for the saved copy switching to the other address on its own (offline-copy.js +2.1 KB:
// the probe, the move notice with Cancel, the quiet way back; app.css +0.2 KB): 244.6 KB measured.
// 2026-10-18: 245 → 246 KB (and ui.js 95 → 96 KB) for ☆ Keep (Library holds only what you keep): the run view's Keep
// button, Work's ☆ on chat rows, Library's "take out" wording and the long-answer lookup (+0.7 KB; ui.js 95.3 KB).
// 2026-10-18: 245 → 247 KB (and ui.js 95 → 97 KB) for the Agent World visuals follow-ups: bigger workers on phones, flows
// that leave each door straight to the street, see-through signs over a worker, the building's outline while it goes
// up, cars that stop at crossings, and their test hooks (ui.js +1.7 KB; 246.4 KB measured).
// 2026-10-18: both together (☆ Keep + Agent World follow-ups) measure 247.7 KB, ui.js 97.0 KB: 248 / 98 KB.
// 2026-10-18: 248 → 250 KB (and app.js 35 → 36 KB) for Best's quick preview: the preview setting, the Preview tag, the
// Make the full picture / Keep preview bar and its request logic (+1.4 KB; 249.0 KB measured, app.js 35.3 KB).
// 2026-10-18: 250 → 253 KB for changing a Spreadsheets cell by hand (the inline editor, the phone sheet and its markup,
// the Direct edit review): spreadsheets.js +1.8 KB, index.html +0.2 KB, app.css +0.1 KB; with the Workshop card (#307,
// ui.js +0.7 KB) 252.0 KB measured.
// 2026-10-18: 253 → 256 KB for handing requests to change Local AI itself to Claude Code (self-change.js 1.8 KB: the
// detector and the Hand to Claude suggestion on Home, Agent World and New idea; +0.3 KB elsewhere). main measured
// 249.96 KB before it; about 254.6 KB with it and #308.
// 2026-10-18: 256 → 257 KB for the Workshop display's sign-in words and printer status (card wording from the
// display's real answer, its printer line, the jump to the card, Home's printer line: ui.js +0.6 KB, home.js +0.6 KB; 255.9 KB measured with #309).
// 2026-10-18: 257 → 260 KB: the merge of #311 (delete with Undo, +1.85 KB) kept main's 257 and dropped its own raise and
// the components.js limit; 258.7 KB measured with #313's worker routes.
// 2026-10-18: 260 → 262 KB (and home.js its own 11 KB) for a Needs you that stays short: needs-you.js (1.5 KB, the rule
// Home, Work's Needs you filter and the server share: seen on any device, a day, a retry or a later success), Home's
// cap of 3 rows with See all, failures of one goal as one row, and the printer line above it (260.6 KB measured).
// 2026-10-18: 262 → 263 KB (and ui.js 100 → 102 KB) for the Workshop display's Show sign-in code (the button, the code
// box with Copy, Open portal and Hide, the 60 s hide, the plain-http copy fallback, the not-set-up line: ui.js +1.05 KB,
// app.css +0.2 KB) and its Print stopped wording; 261.9 KB measured.
// 2026-10-19: 263 → 264 KB (and ui.js 102 → 103 KB) for Agent World's lighting and building pass: building fronts
// painted once into cached sprites (framed windows, lobbies with awnings, roof parapets), warm/cool light and a vignette,
// textured grass and streets, glowing lamps, marching flow lines, busy-district brackets and light (ui.js +1.7 KB; 263.6 KB measured).
// 2026-10-19: 264 → 268 KB (and ui.js 103 → 107 KB) for Agent World's bolder pass: the time-of-day sky (the drift, the
// spotlight on the busy district, haze, rays, shadows that follow the sun), cars that read from above, birds, water
// glints, stars and fireflies, hand-off arcs between roofs and the bigger mission-complete moment (ui.js +3.4 KB, app.css
// +0.3 KB; 267.4 KB measured). All drawn in code: no images.
// 2026-10-19: 268 → 271 KB (and ui.js 107 → 109 KB) for Agent World's replay timeline and Retry mission: the slim bar
// under the city (in the sheet on a phone) with Play, times, hand-off/error/finish marks, drag and keyboard scrubbing and
// the speed; Retry mission beside the city when a mission failed or partly failed; the demo's own header (ui.js +2.2 KB,
// app.css +0.3 KB, index.html +0.1 KB; 270.3 KB measured).
// 2026-10-19: 271 → 277 KB for Images › Fix a part (fix-part.js 4.8 KB: the soft ellipse mask from a tap or drag, the
// brush layer over it, the Hands / Face / Ears / Remove object chips, the original-beside-two-versions view with Keep;
// app.js +0.3 KB for its hooks, app.css +0.3 KB, index.html +0.2 KB): about 275.9 KB measured with #339.
// 2026-10-19: 277 → 278 KB for the accessibility pass (prod-a11y, a11y-axe): crew-summary.js (0.85 KB, Agent World's
// crew count for screen readers, kept beside the crew list) and the crew list's list markup (+0.1 KB). The CSS for 44 px
// touch targets paid for itself by folding nine copies of the focus ring into one token (app.css +0.1 KB in all).
// main measured 276.3 KB; this 277.3 KB.
// 2026-10-19: 278 → 280 KB for sign-in's report-only step: signin-report.js (1.1 KB, Health's list of callers that would
// be refused), its card (index.html +0.1 KB) and the cookie renewal on load (app.js +0.05 KB). 279.2 KB measured.
const TOTAL = 280 * KB; // +2 KB on 2026-10-17 for System › Spreadsheets (spreadsheets.js and its markup), which replaced the separate GridCraft page
// 2026-10-17: +1 KB: main was 41 bytes over after the navigation PRs (#270), and showSheet (components.js) adds 0.15 KB.
// 2026-10-17: 238 → 236 KB after navigation step 4 removed the desktop page list, the phone section sheet and the in-page
// tab rows (234.9 KB measured).
// 2026-10-17: ui.js +1 KB for the ArtCraft card on Services (live status and its Open button).
// 2026-10-18: 236 → 238 KB for the Agent World visuals pass (signs on the roofs, bubbles that step aside, flows along
// the streets: 236.5 KB measured); the pass as a whole aims at no more than +6 KB.
// 2026-10-18: 238 → 240 KB (and ui.js 93 → 95 KB) for its last part, district buildings and the ground: silhouettes
// and props, shadows, lit windows, sidewalks, crossings, lamps, benches, trees (239.1 KB measured; +4 KB for the pass).
// 2026-10-18: ui.js 98 → 99 KB for Agent World's start sheet offering Hand to Claude (+0.1 KB; main was 97.9 KB, this
// measures 98.0 KB). The suggestion itself lives in self-change.js.
// 2026-10-18: ui.js 99 → 100 KB for Agent World workers walking out of their door and along the streets with square
// turns (routeToTarget and its street legs, +0.8 KB); with the Workshop printer line (#312) ui.js measures 99.5 KB.
// 2026-10-19: app.css 41 → 42 KB and index.html 13 → 14 KB for Spreadsheets' live steps while a request runs (the list
// and its four rules: app.css +62 bytes, index.html +48 bytes; main had 4 and 16 bytes left). spreadsheets.js +0.4 KB.
// 2026-10-19: ui.js 109 → 110 KB for spreadsheet requests in Work: their rows and #run links open Spreadsheets (+0.1 KB;
// main had 44 bytes left).
const PER_FILE = { 'ui.js': 110 * KB, 'components.js': 11 * KB, 'app.css': 42 * KB, 'app.js': 36 * KB, 'index.html': 14 * KB, 'home.js': 11 * KB };
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

// Spacing lives in the stylesheet (plan E6): .stack-8/12 and .grow, not one-off style="" attributes. The Missions view
// (#agents) keeps its own markup until its redesign.
test('no inline style= in index.html', () => {
  const owner = html.slice(0, html.indexOf('<section id="agents"')) + html.slice(html.indexOf('<section id="automationStudio"'));
  assert.deepEqual([...owner.matchAll(/<[a-z][^>]*\sstyle="[^"]*"[^>]*>/g)].map(m => m[0].slice(0, 80)), []);
});

// Five type sizes and three radii (plan E6): every font size and radius outside Missions comes from a --ds-* token, and
// nothing reads under 13 px except badges and pills.
test('font sizes and radii come from the --ds-* scale', () => {
  const css = fs.readFileSync(path.join(pub, 'app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const missions = /awc|agent-|#agents|mission-|route-|timeline-(step|vertical|dot)|inspector|evidence-|history-(row|state)|result-card|routing-rationale|mini-plan|execution-output|agent-world/;
  const stray = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].trim(); if (sel.startsWith('@') || sel.startsWith(':root') || missions.test(sel)) continue;
    for (const d of m[2].matchAll(/font-size:\s*([^;]+)|\bfont:([^;]*?\d+(?:\.\d+)?px)/g)) if (/\d+(?:\.\d+)?px/.test(d[1] || d[2])) stray.push(`${sel.slice(0, 60)} { ${d[0]} }`);
    for (const d of m[2].matchAll(/border-radius:\s*([^;]+)/g)) if (/\b(?:[1-9]|[1-9]\d)(?:\.\d+)?px\b/.test(d[1])) stray.push(`${sel.slice(0, 60)} { ${d[0]} }`);
  }
  assert.deepEqual(stray, []);
  const root = /--ds-fs-1:(\d+)px;--ds-fs-2:(\d+)px;--ds-fs-3:(\d+)px;--ds-fs-4:(\d+)px;--ds-fs-5:(\d+)px/.exec(css);
  assert.ok(root && Number(root[1]) >= 13, 'five steps, the smallest 13 px');
});
