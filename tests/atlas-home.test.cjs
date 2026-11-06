'use strict';
// Atlas runs from its own copy of the release (C:\LocalAI\atlas, #450) but maps the checkout and keeps .atlas/ there:
// the deploy writes repo-root.txt beside the copy, and every Atlas script resolves ROOT from it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const FILES = ['atlas_intelligence.py', 'atlas_snapshot_runner.py', 'quick_arch.py'];
const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

function roots(home, env = {}) {
  const code = 'import json, sys; sys.path.insert(0, sys.argv[1]); import atlas_intelligence as a, quick_arch as q, atlas_snapshot_runner as r; '
    + 'print(json.dumps({"ai": str(a.ROOT), "graph": str(a.ATLAS_HTML), "qa": str(q.ROOT), "snapshots": str(q.SNAPSHOTS), "mirrors": str(r.MIRRORS), "script": str(r.SnapshotRunner.__init__.__defaults__)}))';
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('ATLAS_')));
  return JSON.parse(execFileSync(python, ['-c', code, home], { env: { ...clean, ...env }, encoding: 'utf8' }));
}

function copy() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-home-')));
  const home = path.join(base, 'atlas');
  const repo = path.join(base, 'repo');
  fs.mkdirSync(home); fs.mkdirSync(repo);
  for (const file of FILES) fs.copyFileSync(path.join(root, file), path.join(home, file));
  return { base, home, repo };
}

test('Atlas run from its own copy maps the checkout named in repo-root.txt', () => {
  const { base, home, repo } = copy();
  fs.writeFileSync(path.join(home, 'repo-root.txt'), `${repo}\n`);
  const r = roots(home);
  assert.equal(r.ai, repo);
  assert.equal(r.qa, repo);
  assert.equal(r.graph, path.join(repo, '.atlas', 'graph', 'system-atlas.html'));
  assert.equal(r.snapshots, path.join(repo, '.atlas', 'snapshots'));
  assert.equal(r.mirrors, path.join(base, 'atlas-repos'));
  assert.ok(r.script.includes(path.join(home, 'quick_arch.py')), `quick_arch runs from the copy: ${r.script}`);
});

test('without repo-root.txt Atlas maps its own folder, and ATLAS_ROOT overrides both', () => {
  const { home, repo } = copy();
  assert.equal(roots(home).ai, home);
  fs.writeFileSync(path.join(home, 'repo-root.txt'), path.join(home, 'elsewhere'));
  assert.equal(roots(home, { ATLAS_ROOT: repo }).ai, repo);
});
