'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const PAYLOAD = path.join(ROOT, 'scripts', 'atlas-investigations');
const read = name => fs.readFileSync(path.join(PAYLOAD, name), 'utf8');

test('Atlas investigation installer payload is complete and read-only by design', () => {
  for (const name of ['Install-Atlas-Investigations.ps1','patch.py','harden.py','atlas-investigations.js','atlas-investigations.css','atlas-investigations.test.cjs']) {
    assert.ok(fs.existsSync(path.join(PAYLOAD, name)), `${name} is missing`);
  }
  const patch = read('patch.py');
  const harden = read('harden.py');
  assert.match(patch, /ATLAS_GOOSE_OLLAMA_HOST/);
  assert.match(patch, /http:\/\/127\.0\.0\.1:11434/);
  assert.match(patch, /subprocess\.run/);
  assert.match(patch, /\/api\/atlas\/investigations/);
  assert.match(patch, /\/api\/atlas\/investigation/);
  assert.match(patch, /450000/);
  assert.match(harden, /ATLAS_GOOSE_BIN/);
  assert.match(harden, /ATLAS_GOOSE_EVIDENCE_MAX_CHARS/);
  assert.match(harden, /GOOSE_MODE.*smart_approve/);
  assert.match(harden, /--no-session/);
  assert.match(harden, /--no-profile/);
  assert.match(harden, /--with-builtin/);
  assert.match(harden, /developer/);
  assert.match(harden, /--max-turns/);
  assert.match(harden, /--max-tool-repetitions/);
});

test('viewer is accessible, responsive, safe-rendered, and has no MutationObserver', () => {
  const js = read('atlas-investigations.js');
  const css = read('atlas-investigations.css');
  assert.doesNotMatch(js, /MutationObserver/);
  assert.match(js, /document\.createElement\('dialog'\)/);
  assert.match(js, /textContent/);
  assert.match(js, /\/api\/knowledge\/import/);
  assert.match(js, /capture:true/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion:reduce/);
  assert.match(css, /max-width:820px/);
  assert.match(css, /max-width:560px/);
});

test('installer is fail-closed before live promotion', () => {
  const ps = read('Install-Atlas-Investigations.ps1');
  const patch = read('patch.py');
  assert.match(ps, /harden\.py/);
  assert.match(ps, /atlas_intelligence\.py --self-test/);
  assert.match(ps, /node --check/);
  assert.match(ps, /node --test/);
  assert.match(ps, /git --no-pager diff --check/);
  assert.match(ps, /if \(\$NoPromote\)/);
  assert.match(ps, /atlas-investigations-before-/);
  assert.match(patch, /Refusing to overwrite unrelated existing file/);
});
