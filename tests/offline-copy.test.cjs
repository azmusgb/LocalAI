'use strict';
// app/public/offline-copy.js: the page tells the owner when it is a saved copy (the service worker answered from its
// cache because Local AI couldn't be reached), and replaces itself when Local AI runs a different build.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pub = path.resolve(__dirname, '../app/public');
const offline = require(path.join(pub, 'offline-copy.js'));
const sw = fs.readFileSync(path.join(pub, 'sw.js'), 'utf8');

test('relativeTime says how old a saved copy is in plain words', () => {
  const now = Date.parse('2026-10-16T12:00:00Z');
  const ago = ms => offline.relativeTime(new Date(now - ms).toISOString(), now);
  assert.equal(ago(5 * 1000), 'just now');
  assert.equal(ago(60 * 1000), '1 minute ago');
  assert.equal(ago(42 * 60 * 1000), '42 minutes ago');
  assert.equal(ago(60 * 60 * 1000), '1 hour ago');
  assert.equal(ago(5 * 60 * 60 * 1000), '5 hours ago');
  assert.equal(ago(26 * 60 * 60 * 1000), 'yesterday');
  assert.equal(ago(3 * 24 * 60 * 60 * 1000), '3 days ago');
  assert.equal(offline.relativeTime('', now), 'an earlier visit');
  assert.equal(offline.relativeTime('not a date', now), 'an earlier visit');
  // a clock that runs behind the server's Date header must not say "in 2 minutes"
  assert.equal(ago(-2 * 60 * 1000), 'just now');
});

test('buildDiffers compares the page build with what /healthz reports', () => {
  const page = { version: '2.0.431', releaseCommit: 'a'.repeat(40) };
  assert.equal(offline.buildDiffers(page, { version: '2.0.431', releaseCommit: 'a'.repeat(40) }), false);
  assert.equal(offline.buildDiffers(page, { version: '2.0.432', releaseCommit: 'a'.repeat(40) }), true);
  assert.equal(offline.buildDiffers(page, { version: '2.0.431', releaseCommit: 'b'.repeat(40) }), true);
  // a checkout has no release: null from /healthz and '' in the page are the same build
  assert.equal(offline.buildDiffers({ version: '2.0.0', releaseCommit: '' }, { version: '2.0.0', releaseCommit: null }), false);
  // a page that doesn't know its own build can't be compared, so it never reloads
  assert.equal(offline.buildDiffers(null, { version: '2.0.0' }), false);
  assert.equal(offline.buildDiffers({ version: '', releaseCommit: '' }, { version: '2.0.0' }), false);
  assert.equal(offline.buildDiffers(page, null), false);
  assert.equal(offline.buildDiffers(page, { status: 'ok' }), false);
});

test('buildKey names a build for the reload-once guard', () => {
  assert.equal(offline.buildKey({ version: '2.0.1', releaseCommit: 'abc' }), '2.0.1@abc');
  assert.equal(offline.buildKey({ version: '2.0.1', releaseCommit: null }), '2.0.1@');
});

test('the service worker marks a saved copy and the page loads the module that reads the mark', () => {
  assert.match(sw, /X-LocalAI-Offline-Copy/);
  assert.match(sw, /localai-offline-copy/);
  assert.match(sw, /'\/offline-copy\.js'/);
  assert.match(sw, /const CACHE='local-ai-shell-v1\.18-unified-runs[^']*-offline1'/);
});
