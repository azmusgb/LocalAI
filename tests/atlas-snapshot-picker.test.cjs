'use strict';

// System Atlas snapshots, page side (plan PR 3): a repository and commit picker on the Architecture page. Local AI's
// latest scan stays the default and keeps findings, Ask and Goose; a snapshot shows its graph alone until PR 5.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { snapshotChoices, commitLabel, snapshotNote } = require('../app/public/architecture.js');

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const NOW = Date.parse('2026-11-01T12:00:00Z');

test('Local AI is always offered first, and only allowed repositories with full commits are kept', () => {
  const choices = snapshotChoices({
    repos: ['pi-hub', 'localai', 'print-lab'],
    snapshots: [
      { repo: 'pi-hub', commit: B }, { repo: 'pi-hub', commit: A },
      { repo: 'netmon', commit: A }, { repo: 'print-lab', commit: 'abc1234' }, null,
    ],
  });
  assert.deepEqual([...choices.keys()], ['localai', 'pi-hub', 'print-lab']);
  assert.deepEqual(choices.get('pi-hub').map((r) => r.commit), [B, A]);
  assert.deepEqual(choices.get('print-lab'), []);
});

test('with no snapshot list (error or old server) the page still offers Local AI', () => {
  for (const list of [null, undefined, {}, { repos: 'x', snapshots: 'y' }]) {
    assert.deepEqual([...snapshotChoices(list).keys()], ['localai']);
  }
});

test('a commit reads as its short form and its age, and the newest says so', () => {
  assert.equal(commitLabel({ commit: A, committedAt: '2026-11-01T11:30:00Z' }, true, NOW), 'aaaaaaa · 30 min ago (newest)');
  assert.equal(commitLabel({ commit: A, committedAt: '2026-10-29T12:00:00Z' }, false, NOW), 'aaaaaaa · 3 days ago');
  assert.equal(commitLabel({ commit: A }, false, NOW), 'aaaaaaa');
  assert.equal(commitLabel({ commit: A, committedAt: '2026-11-01T13:00:00Z' }, false, NOW), 'aaaaaaa · just now');  // clock skew
});

test('an older snapshot is marked stale and names the newer one', () => {
  const rows = [{ commit: B, committedAt: '2026-11-01T10:00:00Z' }, { commit: A, committedAt: '2026-10-30T12:00:00Z' }];
  assert.deepEqual(snapshotNote(rows[0], rows, NOW), { text: 'Commit bbbbbbb · committed 2 h ago', stale: false });
  assert.deepEqual(snapshotNote(rows[1], rows, NOW),
    { text: 'Commit aaaaaaa · committed 2 days ago · a newer snapshot exists (bbbbbbb)', stale: true });
  assert.equal(snapshotNote({ commit: A }, [{ commit: A }], NOW).text, 'Commit aaaaaaa · commit time unknown');
  assert.deepEqual(snapshotNote(undefined, rows, NOW), { text: '', stale: false });
});

test('the picker is labelled native selects, and the page reads snapshots by repository and commit', () => {
  const html = fs.readFileSync(path.join(ROOT, 'app/public/index.html'), 'utf8');
  for (const id of ['atlasRepo', 'atlasCommit']) {
    assert.match(html, new RegExp(`<label for="${id}">[^<]+</label><select id="${id}">`), id);
  }
  assert.match(html, /id="atlasSourceNote"/);
  const js = fs.readFileSync(path.join(ROOT, 'app/public/architecture.js'), 'utf8');
  assert.match(js, /\/api\/atlas\/snapshots/);
  assert.match(js, /\/api\/atlas\/graph\?repo=\$\{encodeURIComponent\(state\.repo\)\}&commit=\$\{encodeURIComponent\(state\.commit\)\}/);
  // Findings, the node, Ask and Goose follow the chosen snapshot (plan PR 5).
  assert.match(js, /scoped\('\/api\/atlas\/summary'\)/);
  assert.match(js, /scoped\(`\/api\/atlas\/node\?path=/);
  assert.equal((js.match(/\.\.\.scope\(\)/g) || []).length, 2);
});
