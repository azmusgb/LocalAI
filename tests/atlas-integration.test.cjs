'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { extractAtlasGraph, normalizeAtlasBaseUrl } = require('../app/server/atlas');
const { domainSummary } = require('../app/public/architecture');

test('Atlas graph parser extracts deterministic DATA without executing page JavaScript', () => {
  const graph = extractAtlasGraph('<script>const DATA = {"nodes":[{"id":"a","domain":"Core"}],"edges":[],"stats":{"files":1}}; const nope = 1;</script>');
  assert.equal(graph.nodes[0].id, 'a');
  assert.equal(graph.stats.files, 1);
});

test('Atlas upstream is loopback by default', () => {
  assert.equal(normalizeAtlasBaseUrl('http://127.0.0.1:8765'), 'http://127.0.0.1:8765');
  assert.throws(() => normalizeAtlasBaseUrl('http://10.0.0.21:8765'), /loopback/);
  assert.equal(normalizeAtlasBaseUrl('http://10.0.0.21:8765', { allowRemote: true }), 'http://10.0.0.21:8765');
});

test('domain summary excludes tests and aggregates cross-domain edges', () => {
  const summary = domainSummary({
    nodes: [
      {id:'a',domain:'API',risk:50},
      {id:'b',domain:'Core',risk:20,changed:true},
      {id:'t',domain:'Tests',risk:0}
    ],
    edges: [{source:'a',target:'b'},{source:'t',target:'a'}]
  });
  assert.deepEqual(summary.domains.map(d=>d.id).sort(), ['API','Core']);
  assert.equal(summary.links.length, 1);
  assert.equal(summary.links[0].count, 1);
});

test('native Architecture workspace is wired into the website contract', () => {
  const html = fs.readFileSync(path.join(ROOT, 'app/public/index.html'), 'utf8');
  const registry = fs.readFileSync(path.join(ROOT, 'app/public/view-registry.js'), 'utf8');
  const server = fs.readFileSync(path.join(ROOT, 'app/server.js'), 'utf8');
  assert.match(html, /id="architecture" class="view architecture-view"/);
  assert.match(html, /src="\/architecture\.js"/);
  // Styles live in app.css (one stylesheet: design-system-ui.mjs); no separate sheet.
  assert.doesNotMatch(html, /href="\/architecture\.css"/);
  assert.match(fs.readFileSync(path.join(ROOT, 'app/public/app.css'), 'utf8'), /==== System Atlas \(System › Architecture/);
  assert.match(registry, /id:'architecture'/);
  assert.match(server, /require\('\.\/server\/atlas'\)/);
  assert.match(server, /p\.startsWith\('\/api\/atlas\/'\)/);
});

test('Architecture section lives inside main and its assets are offline-shell managed', () => {
  // Architecture section lives inside main.
  const html = fs.readFileSync(path.join(ROOT, 'app/public/index.html'), 'utf8');
  const sw = fs.readFileSync(path.join(ROOT, 'app/public/sw.js'), 'utf8');

  const mainOpen = html.indexOf('<main');
  const mainClose = html.indexOf('</main>', mainOpen);
  const architecture = html.indexOf('<section id="architecture" class="view architecture-view"');

  assert.ok(mainOpen >= 0, 'main exists');
  assert.ok(mainClose > mainOpen, 'main closes');
  assert.ok(
    architecture > mainOpen && architecture < mainClose,
    'Architecture must be a native main view'
  );

  assert.match(sw, /['"]\/architecture\.js['"]/);
  assert.doesNotMatch(sw, /['"]\/architecture\.css['"]/);
  assert.match(sw, /const CACHE='[^']*atlas1[^']*'/);
});

