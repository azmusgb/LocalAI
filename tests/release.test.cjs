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
