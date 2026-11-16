'use strict';

// The Architecture page (Atlas redesign spec, PR 3): a map of named modules in columns from callers to what they use,
// an inspector that says why a module ranks where it does, and at most six findings in plain words. The pure parts
// are tested here; tests/atlas-map-ui.mjs drives the page in a browser.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const page = require('../app/public/architecture.js');
const { plural, orderDomains, domainSummary, buildModel, columnsFor, mapLayout, lookHereFirst, whyRanks,
  freshnessLine, lensBand, riskLevel, skippedSummary, emptyMapText } = page;

const NOW = Date.parse('2026-11-04T12:00:00Z');

// A small LocalAI-shaped graph: two browser scripts calling the server over HTTP, the server wiring up modules, a
// shared store with tests, and one browser call nothing serves.
function graph(extra = {}) {
  const node = (id, domain, more = {}) => ({ id, label: id.split('/').pop(), domain, risk: 10, testRefs: 0, ...more });
  return {
    schemaVersion: 2,
    generatedAt: '2026-11-03T12:00:00Z',
    nodes: [
      node('app/public/home.js', 'UI'), node('app/public/work.js', 'UI'),
      node('app/server.js', 'Platform', { risk: 72, riskParts: { reach: 0, out: 72, in: 0, tested: 0 } }),
      node('app/server/chat.js', 'API'), node('app/agent.js', 'AI'),
      node('app/notify.js', 'Core', { changed: true }),
      node('app/storage.js', 'Data', { risk: 21, testRefs: 2, reach: 4, riskParts: { reach: 30, out: 0, in: 9, tested: -18 } }),
      node('tests/storage.test.cjs', 'Tests'),
    ],
    edges: [
      { source: 'app/public/home.js', target: 'app/server.js', kind: 'http', paths: ['/api/health'] },
      { source: 'app/public/work.js', target: 'app/server/chat.js', kind: 'http', paths: ['/api/chat'] },
      { source: 'app/server.js', target: 'app/server/chat.js', kind: 'import' },
      { source: 'app/server.js', target: 'app/storage.js', kind: 'import' },
      { source: 'app/server.js', target: 'app/notify.js', kind: 'import' },
      { source: 'app/server/chat.js', target: 'app/agent.js', kind: 'import' },
      { source: 'app/agent.js', target: 'app/storage.js', kind: 'import' },
      { source: 'app/notify.js', target: 'app/storage.js', kind: 'import' },
      { source: 'tests/storage.test.cjs', target: 'app/storage.js', kind: 'test' },
    ],
    danglingHttp: [{ source: 'app/public/work.js', path: '/api/missing', line: 4 }],
    ...extra,
  };
}

test('counts read as English, and risk bands match the scanner', () => {
  assert.equal(plural(1, 'module'), '1 module');
  assert.equal(plural(52, 'module'), '52 modules');
  assert.deepEqual([70, 69, 48, 47, 28, 27, 0].map(riskLevel), ['critical', 'high', 'high', 'medium', 'medium', 'low', 'low']);
});

test('the model keeps production modules, splits import and HTTP links, and lists the tests that import each', () => {
  const m = buildModel(graph());
  assert.ok(!m.nodes.has('tests/storage.test.cjs'), 'tests are counted, not drawn');
  const store = m.nodes.get('app/storage.js');
  assert.deepEqual(store.tests, ['tests/storage.test.cjs']);
  assert.deepEqual([...store.usedBy].sort(), ['app/agent.js', 'app/notify.js', 'app/server.js']);
  assert.equal(store.reach, 4, "the scanner's reach wins when it sent one");
  const server = m.nodes.get('app/server.js');
  assert.deepEqual([...server.httpFrom], ['app/public/home.js']);
  assert.equal(server.usedBy.size, 0, 'an HTTP call is not an import');
  assert.equal(m.links.filter((l) => l.kind === 'http').length, 2);
  assert.equal(m.links.filter((l) => l.kind === 'import').length, 6);
  // A version 1 snapshot: no kind, no reach. A link from a test is still a test, and reach is worked out here.
  const v1 = buildModel({ ...graph(), schemaVersion: undefined,
    edges: graph().edges.filter((e) => e.kind !== 'http').map(({ kind, ...e }) => e),
    nodes: graph().nodes.map(({ reach, riskParts, ...n }) => n) });
  assert.equal(v1.version, 1);
  assert.deepEqual(v1.nodes.get('app/storage.js').tests, ['tests/storage.test.cjs']);
  assert.equal(v1.nodes.get('app/storage.js').reach, 4, 'agent, notify, chat (through agent) and server');
});

test('odd graphs never break the model: no id, no domain, null or duplicate links, unknown ends', () => {
  const m = buildModel({ schemaVersion: 2, danglingHttp: [null, { source: 'a.js', path: '/api/x' }],
    nodes: [{ id: 'a.js', domain: 'Core' }, { domain: 'Core' }, null, { id: 'b.js' }],
    edges: [null, { source: 'a.js', target: 'b.js' }, { source: 'a.js', target: 'b.js', kind: 'import' }, { source: 'a.js', target: 'zzz.js' },
      { source: 'a.js', target: 'a.js' }] });
  assert.deepEqual([...m.nodes.keys()].sort(), ['a.js', 'b.js']);
  assert.equal(m.nodes.get('b.js').domain, 'Other');
  assert.equal(m.links.length, 1, 'a duplicate link counts once');
  assert.equal(m.dangling.length, 1);
  const lay = mapLayout(m, columnsFor(m, 'localai'));
  assert.equal(lay.rows.length, 2);
  assert.equal(lookHereFirst(m).items[0].node, 'a.js');
  assert.equal(lookHereFirst(buildModel({ schemaVersion: 2, danglingHttp: [], nodes: [], edges: [] })).note, '', 'an empty map claims nothing about its calls');
});

test('columns run from callers to what they use, by the repository\'s own domains', () => {
  const cols = columnsFor(buildModel(graph()), 'localai');
  assert.deepEqual(cols.map((c) => c.title), ['Browser', 'Entry', 'Server', 'Capabilities', 'Shared', 'Data']);
  assert.deepEqual(cols.find((c) => c.title === 'Data').domains, ['Data']);
  // Another repository: its domains in caller-first order, at most six columns, nothing dropped.
  const other = { nodes: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((d) => ({ id: `${d}.py`, domain: d })), edges: [] };
  const oc = columnsFor(buildModel(other), 'pi-hub');
  assert.ok(oc.length <= 6);
  assert.deepEqual(oc.flatMap((c) => c.domains).sort(), ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
  const { domains, links } = domainSummary({ nodes: [{ id: 'u', domain: 'UI' }, { id: 'a', domain: 'API' }], edges: [{ source: 'u', target: 'a' }] });
  assert.deepEqual(orderDomains(domains, links).map((d) => d.id), ['UI', 'API']);
});

test('the layout gives every module one row in its column, riskiest first, and nothing overlaps', () => {
  const m = buildModel(graph());
  const cols = columnsFor(m, 'localai');
  const lay = mapLayout(m, cols);
  assert.equal(lay.rows.length, m.nodes.size);
  const at = new Map(lay.rows.map((r) => [r.id, r]));
  assert.ok(at.get('app/public/home.js').x < at.get('app/server.js').x);
  assert.ok(at.get('app/server.js').x < at.get('app/storage.js').x);
  const seen = new Set();
  for (const r of lay.rows) {
    const key = `${r.x}:${r.y}`;
    assert.ok(!seen.has(key), `${r.id} overlaps another row`);
    seen.add(key);
    assert.ok(r.y + lay.rowHeight <= lay.height && r.x + lay.colWidth <= lay.width);
  }
  assert.ok(lay.heads.some((h) => h.kind === 'column' && h.text === 'Browser'));
  assert.deepEqual(mapLayout(buildModel({ nodes: [], edges: [] }), []).rows, []);
});

test('past 400 modules each domain is one row until it is opened', () => {
  const nodes = Array.from({ length: 420 }, (_, i) => ({ id: `app/m${i}.js`, domain: i < 400 ? 'Core' : 'AI' }));
  const m = buildModel({ nodes, edges: [] });
  const cols = columnsFor(m, 'localai');
  const shut = mapLayout(m, cols);
  assert.deepEqual(shut.rows.map((r) => r.domain).sort(), ['AI', 'Core']);
  assert.ok(shut.rows.every((r) => r.collapsed && r.count > 0));
  const open = mapLayout(m, cols, { open: new Set(['AI']) });
  assert.equal(open.rows.filter((r) => !r.collapsed).length, 20);
  assert.equal(open.rows.filter((r) => r.collapsed).length, 1);
});

test('look here first: at most six findings, each a sentence with its reason, and dangling calls first', () => {
  const m = buildModel(graph());
  const found = lookHereFirst(m);
  assert.ok(found.items.length >= 1 && found.items.length <= 6);
  assert.match(found.items[0].title, /work\.js calls \/api\/missing, which nothing serves/);
  for (const f of found.items) {
    assert.ok(m.nodes.has(f.node), f.node);
    assert.ok(f.title.length > 10 && f.detail.length > 10, JSON.stringify(f));
    assert.ok(['critical', 'high', 'medium', 'low'].includes(f.level));
  }
  assert.equal(new Set(found.items.map((f) => f.node)).size, found.items.length, 'one finding per module');
  // With every call served, it says so rather than staying silent.
  const served = lookHereFirst(buildModel(graph({ danglingHttp: [] })));
  assert.match(served.note, /Every browser call to \/api has a route/);
  const older = lookHereFirst(buildModel({ ...graph(), schemaVersion: 1, danglingHttp: undefined }));
  assert.match(older.note, /Older snapshot/);
});

test('why it ranks here: the score\'s parts in plain words, and counts for an older snapshot', () => {
  const m = buildModel(graph());
  const store = whyRanks(m.nodes.get('app/storage.js'));
  assert.ok(store.some((s) => /depend on it, directly or not/.test(s)), store.join(' | '));
  assert.ok(store.some((s) => /2 tests import it/.test(s)), store.join(' | '));
  const server = whyRanks(m.nodes.get('app/server.js'));
  assert.ok(server.some((s) => /No test imports it/.test(s)));
  assert.ok(server.some((s) => /imports 3 modules/.test(s)));
  assert.ok(whyRanks(m.nodes.get('app/notify.js')).some((s) => /changed since the previous snapshot/.test(s)));
  const old = buildModel({ ...graph(), nodes: graph().nodes.map(({ riskParts, ...n }) => n) });
  assert.ok(whyRanks(old.nodes.get('app/storage.js')).some((s) => /rescan/i.test(s)));
});

test('each lens paints a band, and colour is never the only signal for a change', () => {
  const m = buildModel(graph());
  const store = m.nodes.get('app/storage.js'), server = m.nodes.get('app/server.js');
  assert.equal(lensBand(server, 'risk'), 'critical');
  assert.equal(lensBand(store, 'tests'), 'medium');
  assert.equal(lensBand(server, 'tests'), 'critical');
  assert.equal(lensBand(store, 'reach'), 'medium');
  assert.equal(lensBand(m.nodes.get('app/notify.js'), 'changed'), 'changed');
  assert.equal(lensBand(store, 'changed'), 'quiet');
});

test('the freshness line says the snapshot\'s age and whether it matches the running release', () => {
  const g = { generatedAt: '2026-10-31T12:00:00Z', snapshot: { commit: 'a'.repeat(40) } };
  const stale = freshnessLine(g, { commit: 'ff9081c0', deployedAt: '2026-11-03T00:00:00Z' }, NOW);
  assert.equal(stale.stale, true);
  assert.match(stale.text, /^Snapshot 31 Oct · 4 days old · older than the running release ff9081c$/);
  const same = freshnessLine({ generatedAt: '2026-11-04T10:00:00Z', snapshot: { commit: 'ff9081c0aaaa' } }, { commit: 'ff9081c0aaaa', deployedAt: '2026-11-03T00:00:00Z' }, NOW);
  assert.deepEqual(same, { text: 'Snapshot 4 Nov · today · the running release', stale: false });
  // The latest scan has no commit of its own: a scan newer than the deploy is current, an older one is not.
  assert.equal(freshnessLine({ generatedAt: '2026-11-04T10:00:00Z' }, { commit: 'ff9081c', deployedAt: '2026-11-03T00:00:00Z' }, NOW).stale, false);
  assert.equal(freshnessLine({ generatedAt: '2026-11-02T10:00:00Z' }, { commit: 'ff9081c', deployedAt: '2026-11-03T00:00:00Z' }, NOW).stale, true);
  assert.deepEqual(freshnessLine({}, null, NOW), { text: 'Snapshot time unknown', stale: true });
  assert.equal(freshnessLine({ generatedAt: '2026-11-01T12:00:00Z' }, null, NOW).text, 'Snapshot 1 Nov · 3 days old');
});

test('the page keeps its contracts: lenses are pressed buttons, / searches, motion is optional', () => {
  const html = fs.readFileSync(path.join(ROOT, 'app/public/index.html'), 'utf8');
  for (const lens of ['risk', 'tests', 'reach', 'changed']) assert.match(html, new RegExp(`data-atlas-lens="${lens}" aria-pressed="(true|false)"`), lens);
  assert.match(html, /<button id="atlasMapBack" class="btn-outline" type="button" hidden>/);
  assert.match(html, /<svg id="atlasMap"/);
  assert.match(html, /id="atlasFindingList"/);
  assert.ok(!html.includes('data-atlas-mode'), 'the plate\'s tabs are gone');
  const js = fs.readFileSync(path.join(ROOT, 'app/public/architecture.js'), 'utf8');
  assert.match(js, /prefers-reduced-motion: reduce/);
  assert.match(js, /e\.key==='\/'/);
  assert.doesNotMatch(js, /plateLayout/);
  const css = fs.readFileSync(path.join(ROOT, 'app/public/app.css'), 'utf8');
  assert.match(css, /#architecture \.atlas-map-wrap\{[^}]*overflow:auto/);
  assert.doesNotMatch(css, /atlas-block-frame|atlas-cells/);
});

test('the graph the app serves carries the scanner\'s schema version and dangling calls', () => {
  const src = fs.readFileSync(path.join(ROOT, 'app/server/atlas.js'), 'utf8');
  assert.match(src, /schemaVersion: graph\.schemaVersion \|\| 1/);
  assert.match(src, /danglingHttp: Array\.isArray\(graph\.danglingHttp\) \? graph\.danglingHttp : null/);
});

test('skipped files: one plain sentence from the data, a capped list, nothing when none', () => {
  const rows = (n) => Array.from({ length: n }, (_, i) => ({ path: `src/f${i}.cpp`, reason: 'firmware source, not parsed' }));
  assert.equal(skippedSummary(graph()), null);
  assert.equal(skippedSummary(graph({ skipped: [] })), null);
  assert.equal(skippedSummary(graph({ skipped: 'x' })), null);
  const one = skippedSummary(graph({ skipped: rows(1) }));
  assert.equal(one.sentence, '1 firmware file is listed, not parsed.');
  const many = skippedSummary(graph({ skipped: [...rows(114), { path: null }, null] }));
  assert.equal(many.sentence, '114 firmware files are listed, not parsed.');
  const big = skippedSummary(graph({ skipped: rows(250) }));
  assert.equal(big.paths.length, 200);
  assert.equal(big.more, 50);
  assert.equal(skippedSummary(graph({ skipped: [{ path: 'a.bin', reason: 'binary' }] })).sentence, '1 file is listed, not parsed.');
});

test('the empty map explains skipped files', () => {
  assert.equal(emptyMapText(graph()), 'No production modules in this snapshot.');
  assert.equal(emptyMapText(graph({ skipped: [{ path: 'a.cpp', reason: 'firmware source, not parsed' }] })),
    'No production modules in this snapshot. 1 firmware file is listed, not parsed.');
});
