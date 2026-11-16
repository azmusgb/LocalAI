'use strict';

// The platform map on Atlas (platform capture spec, design item 4): the four systems plus home-mcp and netmon as nodes,
// one link per consumer system and provider with a mark in words, every declared edge in the table, and the calls with
// no declared edge grouped by repository and calling module. The pure parts are tested here; tests/atlas-platform-ui.mjs
// drives the section in a browser.
const test = require('node:test');
const assert = require('node:assert/strict');

const platform = require('../app/public/atlas-platform.js');

const consumer = (repo, module, state, detail = '') => ({ repo, module, state, detail,
  check: { checked: 'confirmed', consumer_missing: 'consumer missing', not_checked: 'no snapshot' }[state] });
const edge = (id, path, consumers, providerState = 'checked', extra = {}) => {
  const c = consumers.map((x) => consumer(...x));
  let check = 'confirmed';
  if (providerState === 'provider_missing') check = 'provider missing';
  else if (c.some((x) => x.state === 'consumer_missing')) check = 'consumer missing';
  else if (providerState === 'not_checked' || c.some((x) => x.state === 'not_checked')) check = 'no snapshot';
  return { id, contract: null, label: null, state: 'checked', check,
    provider: { repo: 'pi-hub', module: 'hub/app.py', method: 'GET', path, state: providerState, detail: '' }, consumers: c, ...extra };
};
const contracts = (list, undeclared = []) => ({ contracts: list, undeclared, brokenCount: 0, commits: {} });

const FIXTURE = contracts([
  edge('records-v1', '/api/records', [['localai', 'app/pi-hub.js', 'checked'], ['home-mcp', 'src/home_mcp/server.py', 'not_checked', "home-mcp isn't mapped"]]),
  edge('now-summary', '/api/now', [['localai', 'app/pi-hub.js', 'consumer_missing', 'Declared but not found']]),
  edge('print-lab-sync', '/api/lab/{project}/sync', [['print-lab', 'lab/sync.py', 'checked']]),
  edge('display-feed', '/api/display/feed', [['bambuhelper-smart-display', 'firmware/feed.cpp', 'not_checked', 'firmware source, not parsed']]),
]);

test('the six platform nodes are always there, with the smart display and netmon notes', () => {
  const m = platform.platformModel(null, contracts([]));
  assert.deepEqual(m.nodes.map((n) => n.id), ['pi-hub', 'localai', 'print-lab', 'bambuhelper-smart-display', 'home-mcp', 'netmon']);
  assert.equal(m.nodes.find((n) => n.id === 'netmon').note, 'Writes files, no HTTP link');
  assert.equal(m.nodes.find((n) => n.id === 'bambuhelper-smart-display').note, 'Firmware source, not parsed');
  assert.equal(m.state, 'empty');
});

test('one link per consumer system and provider, its mark the worst of its routes, in words', () => {
  const m = platform.platformModel(null, FIXTURE);
  assert.equal(m.state, 'ready');
  const byId = Object.fromEntries(m.links.map((l) => [l.id, l]));
  assert.deepEqual(Object.keys(byId).sort(), ['bambuhelper-smart-display>pi-hub', 'home-mcp>pi-hub', 'localai>pi-hub', 'print-lab>pi-hub']);
  assert.equal(byId['localai>pi-hub'].mark.text, 'Missing');
  assert.equal(byId['localai>pi-hub'].routes.length, 2);
  assert.equal(byId['print-lab>pi-hub'].mark.text, 'Confirmed');
  assert.equal(byId['home-mcp>pi-hub'].mark.text, 'Not checked', 'home-mcp is judged by its own consumer, not the edge as a whole');
  assert.equal(byId['bambuhelper-smart-display>pi-hub'].mark.tone, 'unknown');
  assert.ok(!m.links.some((l) => l.from === 'netmon' || l.to === 'netmon'), 'netmon has no HTTP link');
});

test('a missing provider marks every consumer link missing', () => {
  const m = platform.platformModel(null, contracts([edge('x', '/api/x', [['localai', 'a.js', 'checked'], ['print-lab', 'b.py', 'checked']], 'provider_missing')]));
  assert.deepEqual(m.links.map((l) => l.mark.text), ['Missing', 'Missing']);
});

test('the layout gives one position per node and one path per link', () => {
  const m = platform.platformModel(null, FIXTURE);
  const lay = platform.platformLayout(m.nodes, m.links);
  assert.equal(lay.nodes.length, 6);
  assert.deepEqual(lay.nodes.map((n) => n.id).sort(), m.nodes.map((n) => n.id).sort());
  for (const n of lay.nodes) assert.ok(n.x > 0 && n.x < lay.width && n.y > 0 && n.y < lay.height, `${n.id} inside the frame`);
  assert.equal(new Set(lay.nodes.map((n) => `${n.x},${n.y}`)).size, 6, 'no two nodes share a place');
  assert.equal(lay.paths.length, m.links.length);
  for (const p of lay.paths) {
    assert.match(p.d, /^M[\d. -]+C[\d. -]+L[\d. -]+$/);
    assert.ok(Number.isFinite(p.mx) && Number.isFinite(p.my));
  }
  const pi = lay.nodes.find((n) => n.id === 'pi-hub'), lab = lay.nodes.find((n) => n.id === 'print-lab');
  assert.ok(pi.y < lab.y, 'the provider sits above its consumers');
  const marks = lay.paths.map((p) => p.mx).sort((a, b) => a - b);
  for (let i = 1; i < marks.length; i++) assert.ok(marks[i] - marks[i - 1] >= 100, 'marks never crowd each other');
});

test('a layout with no links still places every node', () => {
  const m = platform.platformModel(null, contracts([]));
  const lay = platform.platformLayout(m.nodes, m.links);
  assert.equal(lay.nodes.length, 6);
  assert.equal(lay.paths.length, 0);
});

test('120 edges still produce a complete table, one row per declared edge, in full', () => {
  const list = Array.from({ length: 120 }, (_, i) => edge(`edge-${i}`, `/api/route-${i}`, [['localai', `app/m${i}.js`, i % 3 ? 'checked' : 'consumer_missing']]));
  const rows = platform.tableRows(platform.platformModel(null, contracts(list)));
  assert.equal(rows.length, 120);
  assert.deepEqual(rows.map((r) => r.id), list.map((e) => e.id));
  const r0 = rows[0];
  assert.equal(r0.route, 'GET /api/route-0');
  assert.equal(r0.provider, 'Pi Hub · hub/app.py');
  assert.deepEqual(r0.consumers.map((c) => c.text), ['Local AI · app/m0.js']);
  assert.equal(r0.mark.text, 'Missing');
  assert.equal(rows[1].mark.text, 'Confirmed');
});

test('the edge mark reads the check: confirmed, missing (either side) and not checked', () => {
  assert.deepEqual(platform.markFor('confirmed'), { key: 'confirmed', text: 'Confirmed', tone: 'ok' });
  assert.equal(platform.markFor('provider missing').text, 'Missing');
  assert.equal(platform.markFor('consumer missing').text, 'Missing');
  assert.equal(platform.markFor('no snapshot').text, 'Not checked');
  assert.equal(platform.markFor('anything else').text, 'Not checked');
});

test('calls with no declared edge are grouped by repository, then by calling module, biggest first', () => {
  const und = [
    ...Array.from({ length: 6 }, (_, i) => ({ repo: 'localai', module: 'app/ollama.js', method: null, path: `/api/t${i}`, line: i + 1 })),
    { repo: 'localai', module: 'host/mac-watch/watch.py', method: 'POST', path: '/api/notify/mac-watch', line: 180 },
    ...Array.from({ length: 3 }, (_, i) => ({ repo: 'pi-hub', module: 'hub/bambuddy.py', method: 'GET', path: `/api/v1/x${i}`, line: 10 + i })),
  ];
  const groups = platform.groupUndeclared(und);
  assert.deepEqual(groups.map((g) => [g.repo, g.count]), [['localai', 7], ['pi-hub', 3]]);
  assert.deepEqual(groups[0].modules.map((m) => [m.module, m.calls.length]), [['app/ollama.js', 6], ['host/mac-watch/watch.py', 1]]);
  assert.equal(groups[0].label, 'Local AI');
  assert.deepEqual(platform.groupUndeclared(null), []);
});

test('loading, an error from the server and an error from the browser each say so', () => {
  assert.equal(platform.platformModel(null, null).state, 'loading');
  const server = platform.platformModel(null, { error: { code: 'contracts_load_error', message: 'Contracts file not found.' }, contracts: [] });
  assert.equal(server.state, 'error');
  assert.equal(server.message, 'Contracts file not found.');
  const browser = platform.platformModel(null, { error: 'HTTP 500', contracts: [] });
  assert.equal(browser.state, 'error');
  assert.equal(browser.message, 'HTTP 500');
});

test('a node takes its label and map freshness from the systems list when it has them', () => {
  const systems = { hosts: [{ id: 'pc', repos: [
    { repo: 'localai', label: 'Local AI', snapshot: { commit: 'a'.repeat(40) }, freshness: { state: 'current' } },
    { repo: 'print-lab', label: 'Print lab', snapshot: null, freshness: { state: 'no snapshot' } }] }] };
  const m = platform.platformModel(systems, FIXTURE);
  assert.equal(m.nodes.find((n) => n.id === 'localai').line, 'Map matches the running release');
  assert.equal(m.nodes.find((n) => n.id === 'print-lab').line, 'Not mapped yet');
  assert.equal(m.nodes.find((n) => n.id === 'pi-hub').line, '', 'no systems row, no line');
});
