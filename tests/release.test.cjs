'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { readRelease } = require('../app/release');

test('release identity is optional for development and validated for managed deployments', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-release-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(readRelease(root), null);
  fs.writeFileSync(path.join(root, 'release.json'), '{invalid');
  assert.throws(() => readRelease(root), /Invalid deployment/);
  fs.writeFileSync(path.join(root, 'release.json'), JSON.stringify({ commit: 'short-sha' }));
  assert.throws(() => readRelease(root), /full commit SHA/);
  const commit = '1234567890abcdef1234567890abcdef12345678';
  fs.writeFileSync(path.join(root, 'release.json'), JSON.stringify({ commit }));
  assert.deepEqual(readRelease(root), { commit });
});

test('release version, time and notes are read when present and sanitised', t => {
  const { appVersion } = require('../app/release');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-release-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const commit = '1234567890abcdef1234567890abcdef12345678';
  // PowerShell's ConvertTo-Json writes a single note as an object, not an array.
  fs.writeFileSync(path.join(root, 'release.json'), JSON.stringify({ commit, version: '2.0.431', deployedAt: '2026-10-15T15:00:00Z', notes: { title: 'Only one', pr: 92 } }));
  assert.deepEqual(readRelease(root).notes, [{ title: 'Only one', pr: 92 }]);
  fs.writeFileSync(path.join(root, 'release.json'), JSON.stringify({ commit, version: 'v2 beta', deployedAt: 'yesterday', notes: [{ title: ' Images: edit ', pr: 79 }, { title: '' }, { pr: 3 }, { title: 'No PR' }, { title: 'Bad pr', pr: -1 }] }));
  assert.deepEqual(readRelease(root), { commit, notes: [{ title: 'Images: edit', pr: 79 }, { title: 'No PR' }, { title: 'Bad pr' }] });
  assert.equal(appVersion(root, { commit, version: '2.0.431' }), '2.0.431');
  // No release version: the checkout's package.json (one level up from app/), then APP_VERSION.
  const app = path.join(root, 'app'); fs.mkdirSync(app);
  assert.equal(appVersion(app, null, { APP_VERSION: '1.18' }), '1.18');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '2.1.0' }));
  assert.equal(appVersion(app, null, {}), '2.1.0');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.0.0' }));
  assert.equal(appVersion(app, null, {}), '1.18');
});
