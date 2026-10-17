'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const runtime = fs.readFileSync(path.join(root, 'app/public/ui.js'), 'utf8');
const mobile = fs.readFileSync(path.join(root, 'app/public/ui.js'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'app/public/sw.js'), 'utf8');

test('Runs surface and Home run center are installed', () => {
  assert.match(runtime, /section\.id = 'runs'/);
  assert.match(runtime, /button\.dataset\.view = 'runs'/);
  assert.match(runtime, /panel\.id = 'homeRunCenter'/);
  assert.match(runtime, /<h2>All runs<\/h2>/);
});

test('execution drawer exposes lifecycle, cancel, retry, lineage, output, and timeline', () => {
  assert.match(runtime, /runDrawerBackdrop/);
  assert.match(runtime, /Cancel run/);
  assert.match(runtime, /Retry/);
  assert.match(runtime, /\/api\/runs\/cancel/);
  assert.match(runtime, /\/api\/runs\/retry/);
  assert.match(runtime, /\['Try', String\(run\.attempt \|\| 1\)\]/);
  assert.match(runtime, /\['Retry of', run\.retryOf \|\| '—'\]/);
  assert.match(runtime, /Timeline/);
  assert.match(runtime, /Output/);
  assert.match(runtime, /event\.key === 'Escape'/);
});

test('runs render as shared cards and the run view files, pins and shows the approval bar', () => {
  assert.match(runtime, /LocalAIUI\.runCard/);
  assert.match(runtime, /registerRunBody|runBodyFor/);
  assert.match(runtime, /Not filed/);
  assert.match(runtime, /'Pin'/);
  assert.match(runtime, /\/api\/runs\/update/);
  assert.match(runtime, /\/api\/approvals\/decide/);
});

test('run polling is more frequent while work is active', () => {
  assert.match(runtime, /state\.runs\.some\(active\) \? 3000 : 15000/);
  assert.match(runtime, /\/api\/runs\?limit=120/);
  assert.match(runtime, /awaiting_approval/);
  assert.match(runtime, /streaming/);
});

test('mobile shell loads execution runtime and offline shell caches it', () => {
  assert.match(mobile, /\/\/ ==== execution-runtime\.js/, 'execution runtime ships in the ui.js bundle');
  assert.match(sw, /local-ai-shell-v1\.18-unified-runs/);
  assert.match(sw, /'\/ui\.js'/);
});
