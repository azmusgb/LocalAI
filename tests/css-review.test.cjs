'use strict';

// CSS review, 4 Nov 2026: what app.css and ui.js must keep. hidden always hides, focus is the app's one ring, every
// disclosure shows whether it is open, Home's clear button is a 44 px target, smooth scrolling honours reduced motion,
// and the phone keeps room for the tab bar once, not twice.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pub = path.join(__dirname, '..', 'app', 'public');
const css = fs.readFileSync(path.join(pub, 'app.css'), 'utf8');
const ui = fs.readFileSync(path.join(pub, 'ui.js'), 'utf8');
const rule = (sel) => {
  const i = css.indexOf(`${sel}{`);
  return i < 0 ? '' : css.slice(i, css.indexOf('}', i) + 1);
};

test('[hidden] always hides, whatever display a class sets (Missions › specialists, the Systems list)', () => {
  assert.match(css, /(^|[}\s])\[hidden\]\{display:none!important\}/m);
});

test('focus is the app ring, not the 28% glow or a fill a shade off the menu', () => {
  // Both rules sit in cleaned sections (Home in L9, Agent World's menu in L9's remainder), so they write the same ring
  // with the kit's name: a 2px accent-text outline.
  assert.match(rule('.home-context__clear:focus-visible'), /outline:2px solid var\(--ui-accent-text\)/);
  assert.match(css, /\.aw-menu button:focus-visible\{[^}]*outline:2px solid var\(--ui-accent-text\)/);
  assert.doesNotMatch(css, /\.aw-menu button:is\(:hover,:focus-visible\)\{[^}]*outline:none/);
});

test('every disclosure that drops the browser triangle draws its own open and closed chevron', () => {
  for (const sel of ['.img-advanced summary', '.inbox-resolved>summary', '.whatsnew-release summary', '.secure-setup>summary',
    '.aw-worker__out summary', '.aw-results__dev summary']) {
    const chevron = css.match(/:is\(([^)]*)\)::after\{content:"";[^}]*border-right:2px solid currentColor/);
    assert.ok(chevron && chevron[1].split(',').includes(sel), `${sel} has a chevron`);
  }
  assert.match(rule('.img-advanced summary'), /min-height:var\(--ui-target\)/);  // the kit's 44 px touch target
});

test("Home's context clear button is a 44 px target", () => {
  assert.match(rule('.home-context__clear'), /min-width:var\(--ui-target\);min-height:var\(--ui-target\)/);
});

test('smooth scrolling asks prefers-reduced-motion first', () => {
  assert.doesNotMatch(ui, /behavior:\s*'smooth'/);
});

test("the phone reserves the tab bar's height once (main), not again on body", () => {
  // The tab bar's height is written as 78px since --mobile-nav-height went (L9's remainder).
  assert.doesNotMatch(css, /body\{padding-bottom: ?calc\((var\(--mobile-nav-height\)|78px)/);
  assert.match(css, /body\.ux-v3 main\{padding:0 13px calc\(92px \+ env\(safe-area-inset-bottom\)\)\}/);
});
