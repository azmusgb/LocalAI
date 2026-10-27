'use strict';
// Print lab: each run's Bambuddy print and the prints made outside the lab (app/public/print-lab.js render).
const test = require('node:test');
const assert = require('node:assert/strict');
const { render } = require('../app/public/print-lab.js');

const exp = (id, runs) => ({ id, question: 'Q-1', status: 'printing', provenance: 'prospective', question_text: 'Does it print?', test_kind: 'full_part', factor: null, variants: [], reference_variants: [], estimate: null, usage: null, check: null, outcome: null, validity: null, verdict: null, filament: null, runs, photos: [], ai_observations: [], needs: null });
const page = (runs, extra = {}) => render({ meta: {}, index: { project: 'p', questions: [], experiments: [exp('E-001', runs)], needs: [], problems: [], colours: {}, ...extra } });
const text = h => h.replace(/<[^>]*>/g, '');
const run = (extra = {}) => ({ id: 'PR-001-01', started_at: '2026-10-25T20:00:00Z', ...extra });
const print = (extra = {}) => ({ id: 42, status_word: 'Finished', minutes: 72, grams: 12.4, failed_at_estimate: null, failure_reason: null, linked: true, ...extra });

test('a failed linked run says where it failed, its time and grams, and links to Bambuddy', () => {
  const h = page([run({ print: print({ status_word: 'Failed', failed_at_estimate: 0.4, minutes: 45, grams: 9.6 }), entered_on_mac: false })]);
  assert.match(text(h), /Failed at ~40 % \(estimate\) · 45 min · 10 g · from Bambuddy print #42 ↗/);
  assert.match(h, /<a href="https:\/\/bambuddy\.home\.arpa\/" target="_blank" rel="noopener">/);
});

test('a finished run shows hours and minutes without a failure point', () => {
  const h = page([run({ print: print(), entered_on_mac: false })]);
  assert.match(text(h), /Finished · 1 h 12 min · 12 g · from Bambuddy print #42/);
  assert.doesNotMatch(h, /estimate\)/);
});

test('a run entered on the Mac says so', () => {
  assert.match(page([run({ print: null, entered_on_mac: true })]), /entered on the Mac/);
});

test('outside the lab lists the prints, and is absent when empty or missing', () => {
  const outside = [{ print: 7, archive: 3, name: 'Benchy', status_word: 'Finished', started: '2026-10-25T20:00:00Z', ended: null }];
  const h = page([], { outside });
  assert.match(h, /Outside the lab/);
  assert.match(h, /Benchy · Finished · /);
  assert.match(h, /from Bambuddy print #7 ↗/);
  assert.doesNotMatch(page([], { outside: [] }), /Outside the lab/);
  assert.doesNotMatch(page([]), /Outside the lab/);
});

test('without the new fields the page is unchanged', () => {
  const h = page([run()]);
  assert.doesNotMatch(h, /Bambuddy|entered on the Mac|Outside the lab/);
});

test('names from Bambuddy are escaped', () => {
  const h = page([run({ print: print({ status_word: '<script>x</script>' }) })], { outside: [{ print: 1, archive: 1, name: '<script>alert(1)</script>', status_word: 'Finished', started: '2026-10-25T20:00:00Z', ended: null }] });
  assert.doesNotMatch(h, /<script>/);
  assert.match(h, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});
