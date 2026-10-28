'use strict';
// Projects › Print lab: what only the Mac's page.html showed (spool colour, plans, strip grades, a sweep's finding, AI
// readings, the reference wipe), as app/public/print-lab-evidence.js renders it. Copy matches print-lab's lab/page.py.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'app/public/print-lab-evidence.js'), 'utf8');
const win = {};
vm.runInNewContext(src, { window: win });
const E = win.LocalAIPrintLabEvidence;

test('longest colour name wins', () => {
  assert.equal(E.spoolColour('Light Matte Terracotta PLA', { terracotta: '#c0623a', 'light matte terracotta': '#d08a6a' }), '#d08a6a');
  assert.equal(E.spoolColour('Terracotta PLA', { terracotta: '#c0623a' }), '#c0623a');
});

test("colour values that aren't #rrggbb are ignored", () => {
  assert.equal(E.spoolColour('Red PLA', { red: 'red; background:url(x)' }), '#8698b1');
  assert.equal(E.spoolColour('Grey PLA', { red: '#ff0000' }), '#8698b1');
  assert.equal(E.spoolColour(null, null), '#8698b1');
});

test('plans read as on the Mac', () => {
  const h = E.plansHtml({ plans: [{ after: 'E-024', if: 'clean', next: 'v70 on <terracotta>' }] });
  assert.match(h, /Plans/);
  assert.match(h, /After E-024, if clean: v70 on &lt;terracotta&gt;/);
  assert.equal(E.plansHtml({}), '');
});

test('grade and finding', () => {
  assert.equal(E.gradeText({ grade: 'faint' }), ' · faint');
  assert.equal(E.gradeText({ grade: { print: 'clean', apart: 'no' } }), ' · print clean · apart no');
  assert.equal(E.gradeText({ grade: { print: 'failed', apart: null } }), ' · print failed');
  assert.equal(E.gradeText({}), '');
  assert.match(E.findingHtml({ finding: 'clean up to 60' }), /Finding: clean up to 60/);
  assert.equal(E.findingHtml({}), '');
});

test('AI readings', () => {
  const h = E.aiHtml({ ai_observations: [{ confidence: 0.834, confirmed: false, assessment: '<b>ok' }, { confidence: 0.5, confirmed: true, assessment: 'fine' }] });
  assert.match(h, /AI reading \(83% sure, unconfirmed\): &lt;b&gt;ok/);
  assert.match(h, /AI reading \(50% sure\): fine/);
  assert.equal(E.aiHtml({}), '');
});

const photo = sha => ({ sha256: sha.repeat(64), path: 'photos/x.jpg' });
const src_ = p => `/api/lab/hex-tile/photo/${p.sha256}.jpg`;

test('wipe', () => {
  const ref = { id: 'E-020', photos: [photo('a')] }, x = { id: 'E-021', reference_variants: ['E-020-A'], photos: [photo('b')] };
  const h = E.wipeHtml(x, { 'E-020': ref, 'E-021': x }, src_);
  assert.match(h, /type="range"/);
  assert.match(h, /value="50"/);
  assert.match(h, /aria-label="Drag between E-020 and E-021"/);
  assert.match(h, new RegExp(`/photo/${'a'.repeat(64)}\\.jpg`));
  assert.match(h, new RegExp(`/photo/${'b'.repeat(64)}\\.jpg`));
});

test('no wipe without both photos', () => {
  const x = { id: 'E-021', reference_variants: ['E-020-A'], photos: [photo('b')] };
  assert.equal(E.wipeHtml(x, { 'E-020': { id: 'E-020', photos: [] }, 'E-021': x }, src_), '');
  assert.equal(E.wipeHtml(x, { 'E-021': x }, src_), '');
  assert.equal(E.wipeHtml({ ...x, photos: [{ path: 'photos/local-only.jpg' }] }, { 'E-020': { id: 'E-020', photos: [photo('a')] } }, src_), '');
  assert.equal(E.wipeHtml({ id: 'E-021', photos: [photo('b')] }, {}, src_), '');
});

test('reconciliation table returns empty string when no variants', () => {
  assert.equal(E.reconHtml(null), '');
  assert.equal(E.reconHtml({}), '');
  assert.equal(E.reconHtml({ variants: [] }), '');
});

test('reconciliation table highlights volumetric cap when as_asked is false', () => {
  const x = {
    id: 'E-008',
    status: 'printing',
    variants: [
      { id: 'E-008-A', tab: '12A', requested: 250, realized: 147, as_asked: false, unit: 'mm/s' },
      { id: 'E-008-B', tab: '12B', requested: 80, realized: 80, as_asked: true, unit: 'mm/s' }
    ]
  };
  const html = E.reconHtml(x);
  assert.match(html, /<table class="lab-recon__table">/);
  assert.match(html, /<th scope="col">Variant<\/th>/);
  assert.match(html, /<th scope="col">Requested<\/th>/);
  assert.match(html, /<th scope="col">Sliced<\/th>/);
  assert.match(html, /<th scope="col">Observed<\/th>/);
  assert.match(html, /<strong>12A<\/strong> <span class="meta">\(E-008-A\)<\/span>/);
  assert.match(html, /250 mm\/s/);
  assert.match(html, /147 mm\/s <span class="badge badge--attention" title="[^"]*">Capped<\/span>/);
  assert.match(html, /<strong>12B<\/strong> <span class="meta">\(E-008-B\)<\/span>/);
  assert.match(html, /80 mm\/s/);
  assert.match(html, /Pending inspection/);
});

test('reconciliation table displays observed grades and acceptance verdict', () => {
  const x = {
    id: 'E-004',
    status: 'answered',
    variants: [
      { id: 'E-004-A', tab: '40', requested: 40, realized: 40, as_asked: true, unit: 'mm/s', grade: 'clean' },
      { id: 'E-004-B', tab: '80', requested: 80, realized: 80, as_asked: true, unit: 'mm/s', grade: 'faint' }
    ],
    verdict: { kind: 'ranking', note: 'they look good' }
  };
  const html = E.reconHtml(x);
  assert.match(html, /<span class="badge badge--good">clean<\/span>/);
  assert.match(html, /<span class="badge badge--attention">faint<\/span>/);

  const xAcc = {
    id: 'E-007',
    status: 'answered',
    variants: [
      { id: 'E-007-A', tab: '12A', requested: 147, realized: 147, as_asked: true, unit: 'mm/s' }
    ],
    verdict: { kind: 'acceptance', good_enough: true, defects: ['separation very hard'] }
  };
  const htmlAcc = E.reconHtml(xAcc);
  assert.match(htmlAcc, /<span class="badge badge--good">Accepted<\/span>/);
  assert.match(htmlAcc, /separation very hard/);

  const xRej = {
    id: 'E-014',
    status: 'answered',
    variants: [
      { id: 'E-014-A', tab: '14A', requested: 140, realized: 140, as_asked: true, unit: 'mm/s' }
    ],
    verdict: { kind: 'acceptance', good_enough: false, defects: ['pair cracks when separated'] }
  };
  const htmlRej = E.reconHtml(xRej);
  assert.match(htmlRej, /<span class="badge badge--bad">Not good enough<\/span>/);
  assert.match(htmlRej, /pair cracks when separated/);
});
