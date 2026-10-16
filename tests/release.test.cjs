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

const { deployCheck } = require('../app/release');
test('deployCheck: a release deployed after the report is the latest passed check', () => {
  const report = { available: true, result: 'PASS', summary: '3 PASS / 0 WARN / 0 FAIL', modifiedAt: '2026-09-28T04:34:37.758Z' };
  const release = { commit: 'b'.repeat(40), version: '2.0.386', deployedAt: '2026-10-16T21:52:52.586Z' };
  assert.deepEqual(deployCheck(report, release), { available: true, result: 'PASS', summary: '2.0.386 passed its deploy checks', modifiedAt: '2026-10-16T21:52:52.586Z', source: 'release' });
  // No report file at all: the release still says when the last check passed.
  assert.equal(deployCheck({ available: false, result: 'UNKNOWN', summary: null, modifiedAt: null }, release).modifiedAt, '2026-10-16T21:52:52.586Z');
  // A report newer than the release (a later manual certification run) wins, failures included.
  const newer = { available: true, result: 'FAIL', summary: '2 PASS / 0 WARN / 1 FAIL', modifiedAt: '2026-10-17T08:00:00.000Z' };
  assert.equal(deployCheck(newer, release), newer);
  // In a checkout (no release.json) the report stands as it is.
  assert.equal(deployCheck(report, null), report);
  assert.equal(deployCheck(report, { commit: 'c'.repeat(40) }), report, 'a release without a deploy time');
});
