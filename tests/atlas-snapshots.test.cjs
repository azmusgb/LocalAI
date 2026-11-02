'use strict';

// System Atlas snapshots (platform baseline 6.4, plan PR 1): one repository at one commit, scanned from a clean copy
// made with git archive, kept per repository and commit, with "changed" meaning changed since the previous snapshot.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'quick_arch.py');
const PY = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);
const GIT = spawnSync('git', ['--version']).status === 0;
const skip = !PY || !GIT;

function sh(cwd, cmd, args) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

// A small repository with two commits; returns its folder and both commits.
function fixtureRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-repo-'));
  const git = (...a) => sh(dir, 'git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a]);
  git('init', '-q');
  const w = (p, s) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), s); };
  w('hub/app.py', 'from hub import db\n');
  w('hub/db.py', 'X = 1\n');
  w('hub/static/js/main.js', "import './util.js';\n");
  w('hub/static/js/util.js', 'export const u = 1;\n');
  w('tests/test_db.py', 'from hub import db\n');
  git('add', '-A'); git('commit', '-q', '-m', 'one');
  const first = git('rev-parse', 'HEAD');
  w('hub/lab.py', 'from hub import db\n');
  w('hub/db.py', 'X = 2\n');
  git('add', '-A'); git('commit', '-q', '-m', 'two');
  const second = git('rev-parse', 'HEAD');
  return { dir, gitDir: path.join(dir, '.git'), first, second };
}

function snapshot(store, repo, gitDir, commit, extraEnv = {}) {
  return spawnSync(PY, ['-I', SCRIPT, '--repo', repo, '--git-dir', gitDir, '--commit', commit],
    { encoding: 'utf8', timeout: 120000, env: { ...process.env, ATLAS_SNAPSHOTS: store, ...extraEnv } });
}

const index = (store) => JSON.parse(fs.readFileSync(path.join(store, 'index.json'), 'utf8')).snapshots;
const graph = (store, repo, commit) => JSON.parse(fs.readFileSync(path.join(store, repo, commit, 'graph.json'), 'utf8'));

test('a snapshot maps one commit from a clean copy and leaves the working tree alone', { skip }, () => {
  const { dir, gitDir, first } = fixtureRepo();
  fs.writeFileSync(path.join(dir, 'hub', 'uncommitted.py'), 'Y = 1\n');  // must not appear: it is not in the commit
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-store-'));
  const r = snapshot(store, 'pi-hub', gitDir, first);
  assert.equal(r.status, 0, r.stderr);
  const g = graph(store, 'pi-hub', first);
  const ids = g.nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, ['hub/app.py', 'hub/db.py', 'hub/static/js/main.js', 'hub/static/js/util.js', 'tests/test_db.py']);
  assert.equal(g.root, `pi-hub@${first}`);
  assert.equal(g.snapshot.commit, first);
  assert.equal(g.snapshot.changedSince, null);
  assert.equal(g.stats.changed, 0);
  assert.equal(sh(dir, 'git', ['status', '--porcelain']), '?? hub/uncommitted.py');  // nothing else touched
  const row = index(store)[0];
  assert.equal(row.repo, 'pi-hub');
  assert.match(row.committedAt, /^\d{4}-\d\d-\d\dT/);
});

test('other repositories get their own domains; Local AI keeps its rules', { skip }, () => {
  const { gitDir, first } = fixtureRepo();
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-store-'));
  assert.equal(snapshot(store, 'pi-hub', gitDir, first).status, 0);
  const domains = Object.fromEntries(graph(store, 'pi-hub', first).nodes.map((n) => [n.id, n.domain]));
  assert.equal(domains['hub/static/js/main.js'], 'UI');
  assert.equal(domains['hub/app.py'], 'Platform');
  assert.equal(domains['hub/db.py'], 'Data');
  assert.equal(domains['tests/test_db.py'], 'Tests');
  // The same tree as "localai" goes through Local AI's rules, which know nothing of hub/.
  assert.equal(snapshot(store, 'localai', gitDir, first).status, 0);
  const local = Object.fromEntries(graph(store, 'localai', first).nodes.map((n) => [n.id, n.domain]));
  assert.notEqual(local['hub/static/js/main.js'], 'UI');
});

test('"changed" means changed since the previous snapshot of the same repository', { skip }, () => {
  const { gitDir, first, second } = fixtureRepo();
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-store-'));
  assert.equal(snapshot(store, 'pi-hub', gitDir, first).status, 0);
  assert.equal(snapshot(store, 'pi-hub', gitDir, second).status, 0);
  const g = graph(store, 'pi-hub', second);
  assert.equal(g.snapshot.changedSince, first);
  assert.equal(g.stats.changed, 2);  // hub/db.py edited, hub/lab.py added
  assert.deepEqual(g.nodes.filter((n) => n.changed).map((n) => n.id).sort(), ['hub/db.py', 'hub/lab.py']);
});

test('a ref resolves to its commit, and the newest five per repository are kept', { skip }, () => {
  const { dir, gitDir } = fixtureRepo();
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-store-'));
  const made = [];
  for (let i = 0; i < 6; i += 1) {
    sh(dir, 'git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', `c${i}`]);
    assert.equal(snapshot(store, 'pi-hub', gitDir, 'HEAD').status, 0);
    made.push(sh(dir, 'git', ['rev-parse', 'HEAD']));
  }
  const kept = index(store).filter((r) => r.repo === 'pi-hub').map((r) => r.commit);
  assert.deepEqual(kept.sort(), made.slice(1).sort());
  assert.equal(fs.existsSync(path.join(store, 'pi-hub', made[0])), false);  // its folder went too
  // Re-running a commit replaces its row instead of adding a second one.
  assert.equal(snapshot(store, 'pi-hub', gitDir, made[5]).status, 0);
  assert.equal(index(store).filter((r) => r.commit === made[5]).length, 1);
});

test('bad input is refused before anything is written', { skip }, () => {
  const { gitDir, first } = fixtureRepo();
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-store-'));
  for (const name of ['../escape', 'Pi Hub', '', '-x']) {
    const r = snapshot(store, name, gitDir, first);
    assert.notEqual(r.status, 0, `accepted ${JSON.stringify(name)}`);
  }
  assert.notEqual(snapshot(store, 'pi-hub', gitDir, 'no-such-ref').status, 0);
  const partial = spawnSync(PY, ['-I', SCRIPT, '--repo', 'pi-hub'], { encoding: 'utf8', env: { ...process.env, ATLAS_SNAPSHOTS: store } });
  assert.notEqual(partial.status, 0);
  assert.match(partial.stderr, /go together/);
  assert.equal(fs.existsSync(path.join(store, 'index.json')), false);
});
