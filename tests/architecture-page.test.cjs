'use strict';

// The Architecture page's review fixes (1 Nov 2026): an honest freshness line, a map ordered callers-above-callees
// that fits all its rows, findings that say why, and plain copy.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { plural, orderDomains, scanFreshness, findingReason, domainSummary, plateLayout } = require('../app/public/architecture.js');

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
  assert.match(js, /const height=Math\.max\(plate\.height,120\)/);  // the plate's viewBox is as tall as its shelves
  assert.doesNotMatch(js, /max confidence|Atlas evidence is current/);
  assert.match(js, /prefers-reduced-motion: reduce/);
  const html = fs.readFileSync(path.join(ROOT, 'app/public/index.html'), 'utf8');
  for (const gone of ['Deterministic findings', 'Evidence-bounded', 'Atlas facts first', 'System Atlas: deterministic']) {
    assert.ok(!html.includes(gone), gone);
  }
  assert.match(html, /data-atlas-mode="architecture">Structure<\/button>/);
  assert.match(html, /<button id="atlasMapBack" class="btn-outline" type="button" hidden>/);
});

test('live follow-ups: a late snapshot list still picks the newest commit, and a short map sits at the top', () => {
  const js = fs.readFileSync(path.join(ROOT, 'app/public/architecture.js'), 'utf8');
  assert.match(js, /if\(state\.repo!=='localai'&&!state\.commit\)state\.commit=rows\[0\]\?\.commit\|\|'';/);
  const html = fs.readFileSync(path.join(ROOT, 'app/public/index.html'), 'utf8');
  assert.match(html, /<svg id="atlasMap"[^>]*preserveAspectRatio="xMidYMin meet"/);
});

// The plate (redesign, 2 Nov 2026): one square per module, a block per domain, shelves spanning the sheet.
test('the plate gives every module one square, inside its domain block, and nothing overlaps', () => {
  const mods = (d, n) => Array.from({ length: n }, (_, i) => ({ id: `${d}/${i}.js` }));
  const groups = [['UI', 52], ['Core', 28], ['API', 21], ['AI', 11], ['Data', 7], ['Platform', 1], ['Docs', 1]]
    .map(([id, n]) => ({ id, nodes: mods(id, n) }));
  const plate = plateLayout(groups, 1000);
  assert.equal(plate.cells.length, 121);
  assert.equal(new Set(plate.cells.map((c) => c.id)).size, 121);
  assert.equal(plate.blocks.length, groups.length);
  const inside = (c, b) => c.x >= b.x && c.y >= b.y && c.x + plate.size <= b.x + b.w && c.y + plate.size <= b.y + b.h;
  for (const g of groups) {
    const block = plate.blocks.find((b) => b.id === g.id);
    for (const n of g.nodes) assert.ok(inside(plate.cells.find((c) => c.id === n.id), block), n.id);
  }
  for (const a of plate.blocks) {
    assert.ok(a.x >= 0 && a.x + a.w <= 1000 + 1e-9, `${a.id} stays on the sheet`);
    for (const b of plate.blocks) {
      if (a === b) continue;
      assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, `${a.id} and ${b.id} overlap`);
    }
  }
  // Each shelf spans the sheet: its last block ends at the right edge.
  const shelves = new Map();
  for (const b of plate.blocks) shelves.set(b.y, Math.max(shelves.get(b.y) || 0, b.x + b.w));
  for (const right of shelves.values()) assert.equal(right, 1000);
  assert.equal(plate.height, Math.max(...plate.blocks.map((b) => b.y + b.h)));
});

test('the plate copes with nothing, and squares shrink as a repository grows', () => {
  assert.deepEqual(plateLayout([], 1000), { width: 1000, height: 0, size: 32, blocks: [], cells: [] });
  const big = plateLayout([{ id: 'A', nodes: Array.from({ length: 900 }, (_, i) => ({ id: String(i) })) }], 1000);
  assert.equal(big.cells.length, 900);
  assert.ok(big.size < 20);
  assert.ok(big.blocks[0].h > 0 && big.blocks[0].w === 1000);
});
