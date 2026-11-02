'use strict';

// The Architecture page's review fixes (1 Nov 2026): an honest freshness line, a map ordered callers-above-callees
// that fits all its rows, findings that say why, and plain copy.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { plural, orderDomains, scanFreshness, findingReason, domainSummary } = require('../app/public/architecture.js');

const NOW = Date.parse('2026-11-02T03:00:00Z');

test('counts read as English', () => {
  assert.equal(plural(1, 'module'), '1 module');
  assert.equal(plural(0, 'module'), '0 modules');
  assert.equal(plural(52, 'module'), '52 modules');
});

test('domains that use others come before the domains they use', () => {
  const graph = {
    nodes: [
      { id: 'ui.js', domain: 'UI' }, { id: 'api.js', domain: 'API' }, { id: 'db.js', domain: 'Data' },
      { id: 't.js', domain: 'Tests' },
    ],
    edges: [
      { source: 'ui.js', target: 'api.js' }, { source: 'api.js', target: 'db.js' }, { source: 'ui.js', target: 'db.js' },
      { source: 't.js', target: 'db.js' },
    ],
  };
  const { domains, links } = domainSummary(graph);
  assert.deepEqual(orderDomains(domains, links).map((d) => d.id), ['UI', 'API', 'Data']);
  // Unlinked domains keep a stable order: larger first, then by name.
  assert.deepEqual(orderDomains([{ id: 'B', count: 1 }, { id: 'A', count: 1 }, { id: 'C', count: 3 }], []).map((d) => d.id), ['C', 'A', 'B']);
});

test('the scan says how old it is and warns when it predates the running release', () => {
  assert.deepEqual(scanFreshness('2026-11-02T01:00:00Z', '2026-11-01T20:00:00Z', NOW), { text: 'Scanned 2 h ago.', stale: false });
  const old = scanFreshness('2026-10-31T23:06:12Z', '2026-11-02T02:48:00Z', NOW);
  assert.equal(old.stale, true);
  assert.match(old.text, /^Scanned 28 h ago, before the release deployed 12 min ago/);
  assert.deepEqual(scanFreshness('2026-11-02T01:00:00Z', null, NOW), { text: 'Scanned 2 h ago.', stale: false });
  assert.deepEqual(scanFreshness(undefined, null, NOW), { text: 'Scan time unknown.', stale: true });
});

test('a finding says why, in the rules\' words, without repeating itself', () => {
  assert.equal(findingReason({ signals: [
    { title: 'Critical architectural risk' }, { title: 'Large architectural blast radius' }, { title: 'Critical architectural risk' },
  ] }), 'Critical architectural risk · Large architectural blast radius');
  assert.equal(findingReason({ signals: [{ rule: 'high-fanout' }] }), 'high-fanout');
  assert.equal(findingReason({ signals: [] }), 'No detail returned');
  assert.equal(findingReason(null), 'No detail returned');
});

test('the map sizes to its rows, and the page copy is plain', () => {
  const js = fs.readFileSync(path.join(ROOT, 'app/public/architecture.js'), 'utf8');
  assert.doesNotMatch(js, /height=500/);  // the fourth row of domains was cut off at a fixed height
  assert.match(js, /const height=startY\*2\+rows\*cardH/);
  assert.doesNotMatch(js, /max confidence|Atlas evidence is current/);
  assert.match(js, /prefers-reduced-motion: reduce/);
  const html = fs.readFileSync(path.join(ROOT, 'app/public/index.html'), 'utf8');
  for (const gone of ['Deterministic findings', 'Evidence-bounded', 'Atlas facts first', 'System Atlas: deterministic']) {
    assert.ok(!html.includes(gone), gone);
  }
  assert.match(html, /data-atlas-mode="architecture">Structure<\/button>/);
  assert.match(html, /<button id="atlasMapBack" class="btn-outline" type="button" hidden>/);
});
