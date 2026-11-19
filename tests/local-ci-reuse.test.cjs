'use strict';

// Local CI reuses a green result for an identical tree, and splits the browser suites across workers. The decisions
// are in scripts/local-ci-lib.mjs, the cache file handling in scripts/local-ci-cache.mjs; the dry-run tests at the end
// run scripts/local-ci.mjs itself with stand-in steps.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const lib = () => import(pathToFileURL(path.join(ROOT, 'scripts/local-ci-lib.mjs')).href);
const cache = () => import(pathToFileURL(path.join(ROOT, 'scripts/local-ci-cache.mjs')).href);

const TREE = 'a'.repeat(40), DEPS = 'b'.repeat(64);
const base = { tree: TREE, node: 'v22.13.0', deps: DEPS, pwsh: true, dirty: false };

test('the reuse key changes with the tree, Node, the dependencies or the PowerShell steps; dirty or unknown input has none', async () => {
  const { reuseKey } = await lib();
  const key = reuseKey(base);
  assert.ok(key);
  assert.equal(reuseKey({ ...base }), key, 'same input, same key');
  for (const change of [{ tree: 'c'.repeat(40) }, { node: 'v22.14.0' }, { deps: 'd'.repeat(64) }, { pwsh: false }]) {
    const other = reuseKey({ ...base, ...change });
    assert.ok(other && other !== key, `changing ${Object.keys(change)[0]} gives another key`);
  }
  assert.equal(reuseKey({ ...base, dirty: true }), null, 'uncommitted or untracked changes: no key');
  assert.equal(reuseKey({ ...base, dirty: undefined }), null, 'unknown dirtiness is not clean');
  assert.equal(reuseKey({ ...base, tree: null }), null);
  assert.equal(reuseKey({ ...base, tree: 'HEAD' }), null);
  assert.equal(reuseKey({ ...base, deps: null }), null, 'dependencies that could not be identified: no key');
  assert.equal(reuseKey({ ...base, node: '' }), null);
});

test('only a real run with every step green is recorded; a suite green on retry still counts', async () => {
  const { shouldRecordGreen } = await lib();
  const green = { key: 'k', dry: false, stopped: false, state: 'success', failedSteps: [] };
  assert.equal(shouldRecordGreen(green), true);
  assert.equal(shouldRecordGreen({ ...green, dry: true }), false, 'dry run');
  assert.equal(shouldRecordGreen({ ...green, stopped: true }), false, 'stopped run');
  assert.equal(shouldRecordGreen({ ...green, state: 'failure', failedSteps: ['Browser acceptance'] }), false, 'failed run');
  assert.equal(shouldRecordGreen({ ...green, failedSteps: ['Kit literals'] }), false, 'partial: a step failed');
  assert.equal(shouldRecordGreen({ ...green, state: 'error' }), false);
  assert.equal(shouldRecordGreen({ ...green, key: null }), false, 'no key');
});

test('the green list keeps the newest fifty, one per key, and finds a match by key', async () => {
  const { addGreen, findGreen, GREEN_CAP } = await lib();
  assert.equal(GREEN_CAP, 50);
  let list = [];
  for (let i = 0; i < 60; i++) list = addGreen(list, { key: `k${i}`, tree: TREE, at: `t${i}`, summary: `s${i}` });
  assert.equal(list.length, 50);
  assert.equal(list[0].key, 'k59', 'newest first');
  assert.equal(findGreen(list, 'k5'), null, 'the oldest fell off');
  assert.equal(findGreen(list, 'k10').summary, 's10');
  list = addGreen(list, { key: 'k10', tree: TREE, at: 'again', summary: 'newer' });
  assert.equal(list.filter(e => e.key === 'k10').length, 1, 'a key is kept once');
  assert.equal(findGreen(list, 'k10').at, 'again');
  assert.equal(findGreen(list, null), null);
  assert.equal(findGreen(undefined, 'k1'), null, 'a missing or damaged file finds nothing');
  assert.equal(findGreen([{ key: 'x' }], 'x'), null, 'an entry without a summary or time is not trusted');
  assert.throws(() => addGreen([], { tree: TREE }), /key/);
});

test('the reused result is announced and posted with its original summary, marked (reused)', async () => {
  const { reuseLine, reusedDescription } = await lib();
  const entry = { tree: TREE, at: '2026-11-19T10:00:00.000Z', pr: 581, summary: 'All passed: 1200 unit tests, 68/68 browser suites' };
  assert.equal(reuseLine(entry), `Reusing the green result from 2026-11-19T10:00:00.000Z for tree aaaaaaa (PR #581)`);
  assert.equal(reuseLine({ ...entry, pr: null }).endsWith('(a local run)'), true);
  assert.equal(reusedDescription(entry), 'All passed: 1200 unit tests, 68/68 browser suites (reused)');
  const long = reusedDescription({ ...entry, summary: 'x'.repeat(200) });
  assert.equal(long.length, 140, 'fits a commit status');
  assert.ok(long.endsWith(' (reused)'));
});

test('the cache is written atomically: replaced whole, no temporary file left, the old file kept when a write fails', async () => {
  const { writeJsonAtomic, readJson } = await cache();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-ci-cache-'));
  try {
    const file = path.join(dir, 'nested', 'green.json');
    writeJsonAtomic(file, { green: [1] });
    writeJsonAtomic(file, { green: [2] });
    assert.deepEqual(readJson(file, null), { green: [2] });
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['green.json'], 'no temporary file is left behind');
    assert.throws(() => writeJsonAtomic(file, { n: 1n }), /BigInt/);
    assert.deepEqual(readJson(file, null), { green: [2] }, 'a failed write leaves the previous file whole');
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['green.json']);
    const bad = [];
    assert.deepEqual(readJson(path.join(dir, 'missing.json'), { empty: true }, m => bad.push(m)), { empty: true });
    assert.equal(bad.length, 0, 'a missing file is simply empty');
    fs.writeFileSync(path.join(dir, 'broken.json'), '{"green": [');
    assert.deepEqual(readJson(path.join(dir, 'broken.json'), {}, m => bad.push(m)), {});
    assert.equal(bad.length, 1, 'a damaged file is reported, not taken as empty silently');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('worker count: one per three cores, one to four; LOCALAI_CI_SHARDS overrides and is checked', async () => {
  const { shardCount } = await lib();
  assert.equal(shardCount({ cpus: 1 }), 1);
  assert.equal(shardCount({ cpus: 5 }), 1);
  assert.equal(shardCount({ cpus: 11 }), 3);
  assert.equal(shardCount({ cpus: 32 }), 4);
  assert.equal(shardCount({ cpus: undefined }), 1);
  assert.equal(shardCount({ cpus: 32, env: '1' }), 1);
  assert.equal(shardCount({ cpus: 4, env: '6' }), 6);
  assert.equal(shardCount({ cpus: 11, env: '' }), 3, 'empty means the default');
  for (const bad of ['0', 'two', '-1', '2.5', '17']) assert.throws(() => shardCount({ cpus: 8, env: bad }), /LOCALAI_CI_SHARDS/);
});

test('--shard i/n is read strictly', async () => {
  const { parseShard } = await lib();
  assert.deepEqual(parseShard('1/4'), { index: 0, count: 4 });
  assert.deepEqual(parseShard('4/4'), { index: 3, count: 4 });
  for (const bad of ['0/4', '5/4', '1/0', '1', 'a/b', '', undefined]) assert.equal(parseShard(bad), null, String(bad));
});

const SUITES = Array.from({ length: 23 }, (_, i) => `s${String(i).padStart(2, '0')}-ui.mjs`);
const flat = shards => shards.flat().sort();

test('the split puts every suite in exactly one shard, the same way each time', async () => {
  const { partitionSuites } = await lib();
  const durations = Object.fromEntries(SUITES.map((s, i) => [s, (i * 37) % 50 + 1]));
  for (const n of [1, 2, 3, 4, 7, 30]) {
    for (const d of [{}, durations]) {
      const shards = partitionSuites([...SUITES].reverse(), n, d);
      assert.equal(shards.length, n);
      assert.deepEqual(flat(shards), [...SUITES].sort(), `n=${n}: each suite exactly once`);
      assert.deepEqual(partitionSuites(SUITES, n, d), shards, 'input order does not matter');
    }
  }
  assert.deepEqual(partitionSuites(['a-ui.mjs', 'a-ui.mjs'], 2), [['a-ui.mjs'], []], 'a duplicate name is one suite');
});

test('with no times recorded the split is alphabetical round-robin', async () => {
  const { partitionSuites } = await lib();
  assert.deepEqual(partitionSuites(['d-ui.mjs', 'b-ui.mjs', 'a-ui.mjs', 'c-ui.mjs', 'e-ui.mjs'], 2), [['a-ui.mjs', 'c-ui.mjs', 'e-ui.mjs'], ['b-ui.mjs', 'd-ui.mjs']]);
});

test('with times recorded the split is longest first, each to the least-loaded shard', async () => {
  const { partitionSuites } = await lib();
  const d = { 'a-ui.mjs': 10, 'b-ui.mjs': 60, 'c-ui.mjs': 30, 'd-ui.mjs': 25, 'e-ui.mjs': 5 };
  assert.deepEqual(partitionSuites(Object.keys(d), 2, d), [['b-ui.mjs', 'e-ui.mjs'], ['c-ui.mjs', 'd-ui.mjs', 'a-ui.mjs']]);
  // A new suite with no time counts as the average (26 s here), so it is placed among the long ones, not last.
  const withNew = partitionSuites([...Object.keys(d), 'new-ui.mjs'], 3, d);
  assert.deepEqual(withNew, [['b-ui.mjs'], ['c-ui.mjs', 'a-ui.mjs', 'e-ui.mjs'], ['new-ui.mjs', 'd-ui.mjs']]);
});

test('suite times are read from passing suites only', async () => {
  const { suiteDurations } = await lib();
  assert.deepEqual(suiteDurations('--- a-ui.mjs: passed in 4.1s\nnoise\n--- b-ui.mjs: FAILED in 9.0s\n--- c-ui.mjs: passed in 12s\n'), { 'a-ui.mjs': 4.1, 'c-ui.mjs': 12 });
  assert.deepEqual(suiteDurations(''), {});
});

const shardOut = (passed, total, failed = []) => `${failed.map(f => `--- ${f}: FAILED in 1.0s\n`).join('')}\n${passed} of ${total} browser suites passed${failed.length ? `; failed: ${failed.join(', ')}` : ''}\n`;

test('the workers\' summaries merge into one line the existing parsers read', async () => {
  const { mergeShardResults, browserSuiteCounts } = await lib();
  const green = mergeShardResults([{ ok: true, out: shardOut(22, 22) }, { ok: true, out: shardOut(22, 22) }, { ok: true, out: shardOut(2, 2) }]);
  assert.equal(green.ok, true);
  assert.equal(green.line, '46 of 46 browser suites passed');
  assert.deepEqual(browserSuiteCounts(green.line), { passed: 46, total: 46 });
  const red = mergeShardResults([{ ok: true, out: shardOut(22, 22) }, { ok: false, out: shardOut(20, 22, ['b-ui.mjs', 'c-ui.mjs']) }, { ok: false, out: shardOut(1, 2, ['visual-ui.mjs']) }]);
  assert.equal(red.ok, false);
  assert.equal(red.line, '43 of 46 browser suites passed; failed: b-ui.mjs, c-ui.mjs, visual-ui.mjs');
  assert.deepEqual(browserSuiteCounts(red.line), { passed: 43, total: 46 });
  assert.deepEqual(red.failed, ['b-ui.mjs', 'c-ui.mjs', 'visual-ui.mjs']);
});

test('a worker that printed no summary makes the result red and is named', async () => {
  const { mergeShardResults } = await lib();
  const r = mergeShardResults([{ name: 'worker 1/2', ok: true, out: shardOut(3, 3) }, { name: 'worker 2/2', ok: false, out: 'Error: browser crashed' }]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['worker 2/2']);
  assert.equal(r.line, '3 of 3 browser suites passed');
  const exitOnly = mergeShardResults([{ ok: false, out: shardOut(3, 3) }]);
  assert.equal(exitOnly.ok, false, 'a non-zero exit is red even when the line reads all passed');
});

test('a failed suite is retried on the server of the worker that ran it; a wholesale failure is not retried', async () => {
  const { retryPlan } = await lib();
  const parts = [{ out: shardOut(22, 22) }, { out: shardOut(21, 22, ['work-ui.mjs']) }, { out: shardOut(21, 22, ['home-ui.mjs']) }, { out: shardOut(2, 2) }];
  assert.deepEqual(retryPlan(parts), [{ suite: 'work-ui.mjs', worker: 1 }, { suite: 'home-ui.mjs', worker: 2 }]);
  assert.deepEqual(retryPlan([{ out: shardOut(18, 22, ['a-ui.mjs', 'b-ui.mjs']) }, { out: shardOut(20, 22, ['c-ui.mjs', 'd-ui.mjs']) }]), [], 'four failures: not a flake');
  assert.deepEqual(retryPlan([{ out: shardOut(1, 1) }]), []);
});

const runBrowser = (...a) => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tests/run-browser.mjs'), '--list', ...a], { encoding: 'utf8', env: { ...process.env, LOCALAI_CI_DURATIONS: '' } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split('\n').filter(Boolean);
};

test('run-browser.mjs: the shards and the solo suites together are every suite, each once', async () => {
  const { SOLO_SUITES } = await lib();
  const all = runBrowser();
  assert.ok(all.length > 10);
  for (const n of [1, 3, 4]) {
    const shards = Array.from({ length: n }, (_, i) => runBrowser('--shard', `${i + 1}/${n}`));
    assert.deepEqual([...shards.flat(), ...runBrowser('--solo')].sort(), all, `n=${n}`);
    for (const s of SOLO_SUITES) assert.ok(!shards.flat().includes(s), `${s} runs alone, in no shard`);
  }
  assert.deepEqual(runBrowser('--solo'), [...SOLO_SUITES].sort());
  const bad = spawnSync(process.execPath, [path.join(ROOT, 'tests/run-browser.mjs'), '--shard', '5/4', '--list'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
});

test('run-browser.mjs: a full suite name matches only that suite, so a retry runs only the suite that failed', () => {
  assert.deepEqual(runBrowser('home-ui.mjs'), ['home-ui.mjs']);
  assert.ok(runBrowser('home').includes('voice-home-ui.mjs'), 'a partial name still matches as a substring');
});

// The script itself, dry: stand-in steps, no server, no CI slot, no posting.
function dryRun(env = {}, ...args) {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-ci-dry-cache-'));
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/local-ci.mjs'), '--dry', ...args], { cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, LOCALAI_CI_CACHE_DIR: cacheDir, LOCALAI_CI_SHARDS: '3', LOCALAI_CI_DRY_REUSE: '', LOCALAI_CI_FAIL_SUITE: '', LOCALAI_CI_FAIL_UNIT: '', ...env } });
  const written = fs.readdirSync(cacheDir);
  fs.rmSync(cacheDir, { recursive: true, force: true });
  return { ...r, written };
}

test('a dry run walks the workers and the retry, and never records a green result or suite times', () => {
  const green = dryRun();
  assert.equal(green.status, 0, green.stdout + green.stderr);
  assert.match(green.stdout, /Browser suites, worker 3\/3: ok/);
  assert.match(green.stdout, /Browser suites, solo: ok/);
  assert.match(green.stdout, /✅ All passed/);
  assert.doesNotMatch(green.stdout, /recorded as green/);
  assert.deepEqual(green.written, [], 'nothing written to the cache');

  const flake = dryRun({ LOCALAI_CI_FAIL_SUITE: 'home-ui.mjs' });
  assert.equal(flake.status, 0, flake.stdout);
  assert.match(flake.stdout, /=== Retry home-ui\.mjs \(worker 1\)/, 'retried on the worker that ran it');
  assert.match(flake.stdout, /All passed, 1 suite on retry: home-ui\.mjs/);
  assert.deepEqual(flake.written, []);

  const one = dryRun({ LOCALAI_CI_SHARDS: '1' });
  assert.equal(one.status, 0);
  assert.match(one.stdout, /Browser acceptance \(one worker/);
  assert.doesNotMatch(one.stdout, /worker 1\/1|solo/);
});

test('a dry run walks the reuse path: it skips the steps and says it reused; --fresh runs them', () => {
  const reused = dryRun({ LOCALAI_CI_DRY_REUSE: '1' });
  assert.equal(reused.status, 0, reused.stdout + reused.stderr);
  assert.match(reused.stdout, /Reusing the green result from \(dry run\) for tree [0-9a-f]{7}/);
  assert.match(reused.stdout, /\(reused\)/);
  assert.doesNotMatch(reused.stdout, /=== Unit and contract tests/);
  assert.deepEqual(reused.written, []);
  const fresh = dryRun({ LOCALAI_CI_DRY_REUSE: '1' }, '--fresh');
  assert.equal(fresh.status, 0);
  assert.match(fresh.stdout, /--fresh: running everything/);
  assert.match(fresh.stdout, /=== Unit and contract tests/);
  assert.doesNotMatch(fresh.stdout, /Reusing/);
});
