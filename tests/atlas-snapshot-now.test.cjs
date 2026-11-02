'use strict';

// System Atlas "Snapshot now" (plan PR 4): the PC fetches a bare, fetch-only mirror of an allowed repository, resolves
// the ref and scans that commit; one run at a time, a repeated request while one waits is that request, and a request
// while one runs queues behind it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PY = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);
const GIT = spawnSync('git', ['--version']).status === 0;
const skip = !PY || !GIT;

function sh(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

function fixtureRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-remote-'));
  sh(dir, 'init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(dir, 'hub'));
  fs.writeFileSync(path.join(dir, 'hub', 'app.py'), 'from hub import db\n');
  fs.writeFileSync(path.join(dir, 'hub', 'db.py'), 'X = 1\n');
  sh(dir, 'add', '-A'); sh(dir, 'commit', '-q', '-m', 'one');
  return dir;
}

// Runs Python against the runner with a temporary store and mirror folder; the script prints one JSON line.
function py(code, env = {}) {
  const r = spawnSync(PY, ['-I', '-c', `
import json, sys, pathlib
sys.path.insert(0, ${JSON.stringify(ROOT)})
import atlas_snapshot_runner as m
${code}`], { encoding: 'utf8', timeout: 180000, env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

test('a snapshot clones the mirror on first use, then fetches it for the next one', { skip }, () => {
  const remote = fixtureRepo();
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-store-'));
  const mirrors = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-mirrors-'));
  const first = sh(remote, 'rev-parse', 'HEAD');
  const out = py(`
r = m.SnapshotRunner(remotes={'pi-hub': ${JSON.stringify(remote)}}, mirrors=pathlib.Path(${JSON.stringify(mirrors)}))
job = r.request('pi-hub', 'main'); r.wait(120)
print(json.dumps({'job': job, 'status': r.status()}))`, { ATLAS_SNAPSHOTS: store });
  assert.equal(out.job.state, 'queued');
  const done = out.status.recent[0];
  assert.equal(done.state, 'done', done.error);
  assert.equal(done.commit, first);
  assert.ok(fs.existsSync(path.join(store, 'pi-hub', first, 'graph.json')));
  assert.ok(fs.existsSync(path.join(mirrors, 'pi-hub.git', 'HEAD')));  // a bare mirror, not a working tree
  assert.equal(fs.existsSync(path.join(mirrors, 'pi-hub.git', 'hub')), false);

  fs.writeFileSync(path.join(remote, 'hub', 'lab.py'), 'from hub import db\n');
  sh(remote, 'add', '-A'); sh(remote, 'commit', '-q', '-m', 'two');
  const second = sh(remote, 'rev-parse', 'HEAD');
  const again = py(`
r = m.SnapshotRunner(remotes={'pi-hub': ${JSON.stringify(remote)}}, mirrors=pathlib.Path(${JSON.stringify(mirrors)}))
r.request('pi-hub', 'main'); r.wait(120)
print(json.dumps(r.status()['recent'][0]))`, { ATLAS_SNAPSHOTS: store });
  assert.equal(again.state, 'done', again.error);
  assert.equal(again.commit, second);
  const graph = JSON.parse(fs.readFileSync(path.join(store, 'pi-hub', second, 'graph.json'), 'utf8'));
  assert.equal(graph.snapshot.changedSince, first);
});

test('unknown repositories and unsafe refs are refused before anything runs', { skip: !PY }, () => {
  const out = py(`
calls = []
r = m.SnapshotRunner(remotes={'pi-hub': 'x'}, run=lambda *a, **k: calls.append(a))
codes = []
for repo, ref in [('netmon', 'main'), ('../pi-hub', 'main'), ('pi-hub', '--upload-pack=x'), ('pi-hub', 'a..b'),
                  ('pi-hub', 'main; rm'), ('pi-hub', 'x' * 101)]:
    try: r.request(repo, ref); codes.append('accepted')
    except m.SnapshotRequestError as e: codes.append([e.code, e.status])
print(json.dumps({'codes': codes, 'calls': len(calls), 'status': r.status()}))`);
  assert.deepEqual(out.codes, [
    ['atlas_repo_unknown', 404], ['atlas_repo_unknown', 404], ['atlas_ref_invalid', 400],
    ['atlas_ref_invalid', 400], ['atlas_ref_invalid', 400], ['atlas_ref_invalid', 400],
  ]);
  assert.equal(out.calls, 0);
  assert.deepEqual(out.status.queued, []);
});

test('one run at a time: a repeat while waiting is the same job, a repeat while running queues once', { skip: !PY }, () => {
  const out = py(`
import threading, subprocess
gate = threading.Event(); started = threading.Event()
def run(args, **k):
    if args[0] != 'git': started.set(); gate.wait(10)
    elif 'clone' in args: pathlib.Path(args[-1]).mkdir(parents=True, exist_ok=True); (pathlib.Path(args[-1]) / 'HEAD').write_text('x')
    return subprocess.CompletedProcess(args, 0, 'a' * 40 + '\\n', '')
r = m.SnapshotRunner(remotes={'pi-hub': 'x', 'print-lab': 'y'}, mirrors=pathlib.Path(${JSON.stringify(fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-fake-')))}), run=run)
a = r.request('pi-hub', 'main'); started.wait(10)
b = r.request('pi-hub', 'main')      # the same as the running one: queues behind it
c = r.request('pi-hub', 'main')      # the same as the waiting one: that job
d = r.request('print-lab', 'main')
mid = r.status()
gate.set(); r.wait(10)
print(json.dumps({'ids': [a['id'], b['id'], c['id'], d['id']], 'running': mid['running']['id'],
                  'queued': [j['id'] for j in mid['queued']], 'done': [j['state'] for j in r.status()['recent']]}))`);
  assert.deepEqual(out.ids, [1, 2, 2, 3]);
  assert.equal(out.running, 1);
  assert.deepEqual(out.queued, [2, 3]);
  assert.deepEqual(out.done, ['done', 'done', 'done']);
});

test('a failed fetch or scan is reported on its job and the next job still runs', { skip }, () => {
  const out = py(`
r = m.SnapshotRunner(remotes={'pi-hub': '/no/such/remote', 'print-lab': '/no/such/either'},
                     mirrors=pathlib.Path(${JSON.stringify(fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-mirrors-')))}))
r.request('pi-hub', 'main'); r.request('print-lab', 'main'); r.wait(60)
print(json.dumps(r.status()['recent']))`);
  assert.deepEqual(out.map((j) => j.state), ['failed', 'failed']);
  assert.match(out[0].error, /git clone failed/);
});

test('extra repositories come from ATLAS_REPO_REMOTES, and only well-formed ones', { skip: !PY }, () => {
  const out = py(`print(json.dumps(sorted(m.remotes_from_env('netmon=git@github-atlas-netmon:azmusgb/netmon.git,bad name=x,evil=https://x.example/r.git'))))`);
  assert.deepEqual(out, ['localai', 'netmon', 'pi-hub', 'print-lab']);
});

test('the proxy forwards snapshot requests, and starting one needs sign-in', () => {
  const { guarded } = require('../app/signin');
  assert.equal(guarded('/api/atlas/snapshot', 'POST'), true);
  assert.equal(guarded('/api/atlas/snapshot', 'GET'), false);
  const js = fs.readFileSync(path.join(ROOT, 'app/server/atlas.js'), 'utf8');
  assert.match(js, /\['\/api\/atlas\/snapshot', '\/api\/atlas\/snapshot'\]/);
  const page = require('../app/public/architecture.js');
  assert.equal(page.snapshotStateText({ repo: 'pi-hub', ref: 'main', state: 'running' }), 'Taking a snapshot of Pi Hub at main…');
  assert.equal(page.snapshotStateText({ repo: 'pi-hub', state: 'done', commit: 'a'.repeat(40) }), 'The snapshot of Pi Hub at aaaaaaa is ready.');
  assert.equal(page.snapshotStateText({ repo: 'print-lab', state: 'failed', error: 'git clone failed' }), 'The snapshot of Print lab failed: git clone failed');
  assert.equal(page.snapshotStateText(null), '');
});
