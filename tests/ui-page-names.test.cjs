'use strict';
// Text a person reads that sends them to "System › <page>" must name a page Local AI has. Spreadsheets said
// "Check System › Health", which is Pi Hub's page, not this one. Comments may name Pi Hub's pages; strings may not.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const V = require('../app/public/view-registry.js');

const PUBLIC = path.join(__dirname, '..', 'app', 'public');
const names = [...new Set(V.VIEWS.filter((v) => v.domain === 'system').flatMap((v) => [v.label, v.tab, v.short]).filter(Boolean))]
  .sort((a, b) => b.length - a.length); // longest first: "Assistant status" before "Status"
const ARROW = /System\s*(?:›|&rsaquo;|&#8250;|>)\s*/g;

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'ui' || e.name === 'fonts' ? [] : files(p); // ui/ is the vendored kit
    return /\.(js|html)$/.test(e.name) ? [p] : [];
  });
}
// Comments are blanked (newlines kept, so line numbers hold). A "//" inside a string or URL is left alone.
const uncomment = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

function badRefs(src, where) {
  const code = uncomment(src), bad = [];
  for (const m of code.matchAll(ARROW)) {
    const rest = code.slice(m.index + m[0].length);
    if (!names.some((n) => rest.startsWith(n) && !/[A-Za-z0-9]/.test(rest[n.length] || ''))) {
      bad.push(`${where}:${code.slice(0, m.index).split('\n').length} ${m[0]}${rest.split(/[.'"`<\n]/)[0].slice(0, 30)}`);
    }
  }
  return bad;
}

test('the scan knows real names and catches a wrong one', () => {
  assert.deepEqual(badRefs("x('Open System › Assistant settings to turn it on')", 'a'), []);
  assert.deepEqual(badRefs("x('See System › Browser & computer.')", 'a'), []);
  assert.deepEqual(badRefs("x('See System › n8n workflows')", 'a'), []);
  assert.deepEqual(badRefs('/* Pi Hub\'s System › Health */\n// System › Health', 'a'), []);
  assert.equal(badRefs("x('Check System › Health.')", 'a').length, 1);
  assert.equal(badRefs('<p>See System &rsaquo; Health</p>', 'a').length, 1);
  assert.equal(badRefs("x('See System › Statuses')", 'a').length, 1, 'a prefix of a longer word is not the page');
});

test('every "System › X" a person can read names one of Local AI\'s System pages', () => {
  const bad = files(PUBLIC).flatMap((f) => badRefs(fs.readFileSync(f, 'utf8'), path.relative(PUBLIC, f)));
  assert.deepEqual(bad, [], `known pages: ${names.join(', ')}`);
});
