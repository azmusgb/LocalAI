'use strict';
// atlas-investigations-v1
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('Atlas Intelligence executes bounded read-only Goose investigations', () => {
  const py = read('atlas_intelligence.py');
  assert.match(py, /atlas-investigations-v1/);
  assert.match(py, /atlas-investigation-hardening-v2/);
  assert.match(py, /"--no-session"/);
  assert.match(py, /"--no-profile"/);
  assert.match(py, /"--with-builtin"/);
  assert.match(py, /"developer"/);
  assert.match(py, /"--system"/);
  assert.match(py, /Read-only architecture investigation/);
  assert.match(py, /GOOSE_MODE.*smart_approve/);
  assert.match(py, /ATLAS_GOOSE_BIN/);
  assert.match(py, /ATLAS_GOOSE_OLLAMA_HOST/);
  assert.match(py, /ATLAS_GOOSE_TIMEOUT_SECONDS/);
  assert.match(py, /ATLAS_MODEL_EVIDENCE_MAX_CHARS/);
  assert.match(py, /ATLAS_OLLAMA_TIMEOUT_SECONDS/);
  assert.match(py, /def _bounded_model_evidence/);
  assert.match(py, /def list_investigations/);
  assert.match(py, /def read_investigation/);
});

test('Local AI proxies investigation history and gives Goose a long-running timeout', () => {
  const server = read('app/server/atlas.js');
  assert.match(server, /\/api\/atlas\/investigations/);
  assert.match(server, /\/api\/atlas\/investigation/);
  assert.match(server, /const isGoose/);
  assert.match(server, /450000/);
});

test('Architecture has a native investigation viewer without MutationObserver feedback loops', () => {
  const js = read('app/public/atlas-investigations.js');
  const css = read('app/public/atlas-investigations.css');
  assert.match(js, /atlas-investigations-v1/);
  assert.match(js, /atlasInvestigationDialog/);
  assert.match(js, /\/api\/atlas\/goose/);
  assert.match(js, /\/api\/knowledge\/import/);
  assert.doesNotMatch(js, /MutationObserver/);
  assert.match(css, /prefers-reduced-motion:reduce/);
  assert.match(css, /max-width:820px/);
  assert.match(css, /max-width:560px/);
  assert.match(css, /max-height:420px/);
  assert.match(css, /min-width:420px/);
});

test('Investigation assets are in the page and offline shell', () => {
  const html = read('app/public/index.html');
  const sw = read('app/public/sw.js');
  for (const asset of ['/atlas-investigations.js','/atlas-investigations.css']) {
    assert.ok(html.includes(asset), `${asset} missing from index.html`);
    assert.ok(sw.includes(asset), `${asset} missing from sw.js`);
  }
  assert.match(sw, /investigations1-atlas1/);
});
