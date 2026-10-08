'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const runtime = fs.readFileSync(path.join(root, 'app/public/execution-runtime.js'), 'utf8');
const mobile = fs.readFileSync(path.join(root, 'app/public/mobile-overhaul.js'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'app/public/sw.js'), 'utf8');

test('Runs surface and Home run center are installed', () => {
  assert.match(runtime, /section\.id = 'runs'/);
  assert.match(runtime, /button\.dataset\.view = 'runs'/);
  assert.match(runtime, /panel\.id = 'homeRunCenter'/);
  assert.match(runtime, /Execution history/);
});

test('execution drawer exposes lifecycle, cancel, retry, output, and timeline', () => {
  assert.match(runtime, /runDrawerBackdrop/);
  assert.match(runtime, /Cancel run/);
  assert.match(runtime, /Retry/);
  assert.match(runtime, /\/api\/runs\/cancel/);
  assert.match(runtime, /\/api\/runs\/retry/);
  assert.match(runtime, /Timeline/);
  assert.match(runtime, /Output/);
  assert.match(runtime, /event\.key === 'Escape'/);
});

test('run polling is more frequent while work is active', () => {
  assert.match(runtime, /state\.runs\.some\(active\) \? 3000 : 15000/);
  assert.match(runtime, /\/api\/runs\?limit=120/);
  assert.match(runtime, /awaiting_approval/);
  assert.match(runtime, /streaming/);
});

test('mobile shell loads execution runtime and offline shell caches it', () => {
  assert.match(mobile, /script\.src = '\/execution-runtime\.js'/);
  assert.match(mobile, /loadExecutionRuntime\(\)/);
  assert.match(sw, /local-ai-shell-v1\.18-unified-runs/);
  assert.match(sw, /'\/execution-runtime\.js'/);
});
