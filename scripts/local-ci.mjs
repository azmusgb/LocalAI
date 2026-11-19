#!/usr/bin/env node
// Local CI: the repository's only CI. Runs the checks on this machine and posts the result to the pull request
// as a "local-ci" commit status.
//
//   npm run ci -- 195            test PR #195 merged with the latest main, post pending, then success or failure
//   npm run ci -- 195 --no-post  same, without posting
//   npm run ci                   test the current checkout as it is (never posts)
//   npm run ship -- 195          same as ci -- 195, then merges the PR if it's green (only the commit that was tested),
//                                after re-checking it against main if main moved during the run (see below), and
//                                moves the `release` branch, which is what the host deploys, to the merge commit
//
// A PR is tested in a throwaway worktree (its head merged with origin/main, as GitHub's pull_request runs do), so
// your own checkout is never touched. The log is kept in the system temp folder and its path printed at the end.
//
// What a red looks like on the PR: the failure status names the failed steps, and one comment names the failing
// unit tests (first ten) and any browser suite that failed twice. A browser suite that fails is run once more on
// its own against the server it ran on; if it passes, the run is green but the status reads "All passed, 1 suite on
// retry: <suite>" and a comment says so, so flakes stay visible. Unit tests are never retried. With a PR number, a
// title longer than 70 characters or with more than one clause (";" or " — ") gets one advisory comment, since PR
// titles become the release notes; that never fails the run. The decisions are in scripts/local-ci-lib.mjs, tested
// by tests/local-ci.test.cjs.
//
// Ship re-check: a run tests the PR with main as main was when it started, ~15 minutes earlier. Before merging, ship
// fetches main again; if it moved, it merges the newer main into the tested tree and re-runs the fast checks (npm test,
// and the deploy validator when pwsh is installed; not the browser suites), up to three times while main keeps moving.
// A conflict or a red re-check means no merge: a failure status "main moved; re-check failed: <tests>", a PR comment
// naming them, and a non-zero exit. What is left: a merge in the seconds between the last fetch and ship's own, or one
// made without ship (GitHub can't make a merge conditional on main's commit).
//
// Dry run, for working on this script without taking the machine's CI slot: LOCALAI_CI_DRY=1 skips the queue and
// every real step (each prints a stand-in line instead), starts no server and never posts; it prints what it would
// have posted. LOCALAI_CI_FAIL_UNIT=<test name> makes the dry unit step red with that test; LOCALAI_CI_FAIL_SUITE=<x-ui.mjs>
// makes the dry browser step fail that suite, which then passes on retry. A PR number still works in a dry run
// (worktree, merge, title check). With --merge, a dry run pretends main moved once and runs the re-check with stand-ins
// (LOCALAI_CI_MAIN_MOVED=0: main didn't move; LOCALAI_CI_RECHECK_CONFLICT=1: the newer main conflicts;
// LOCALAI_CI_FAIL_RECHECK=<test name>: the re-check is red with that test), then prints the merge it would have run.
// `--dry` is the same as LOCALAI_CI_DRY=1.
//
// Reusing a green result: after a run with every step green, the tested tree is recorded in
// <git common dir>/localai-ci/green.json (local, shared by every worktree, newest 50 kept). A later ci or ship that
// would test the identical tree (same tree hash, Node version, PowerShell steps and installed dependencies; a local run
// only from a clean checkout) skips the steps, prints "Reusing the green result from …", and posts the same success
// status marked "(reused)"; ship then goes on exactly as after a full run, re-checking if main has moved since.
// A failed, stopped or dry run is never recorded. `--fresh` always runs everything. In a dry run,
// LOCALAI_CI_DRY_REUSE=1 pretends a green result is on record, to walk the reuse path.
//
// Browser suites run in LOCALAI_CI_SHARDS workers side by side (default: one per three cores, at most four; 1 = one
// worker, as before), each with its own fresh server, port and data folder (tests/run-browser.mjs --shard i/n). The
// timing-sensitive suites (SOLO_SUITES: perf-ui, visual-ui) run after them, alone, on the first worker's server. The
// split is longest-first by each suite's last time, recorded in <git common dir>/localai-ci/durations.json.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { failingUnitTests, ciSummary, failureComment, retryComment,
  releaseNoteAdvice, RELEASE_NOTE_MARKER, shipMergeArgs, shipNextStep, recheckOutcome, releaseDecision, RELEASE_BRANCH,
  mergedPrs, unshippedNote, prMode, reuseKey, shouldRecordGreen, addGreen, findGreen, reuseLine, reusedDescription,
  shardCount, suiteDurations, mergeShardResults, retryPlan, SOLO_SUITES } from './local-ci-lib.mjs';
import { readJson, writeJsonAtomic, fileHash } from './local-ci-cache.mjs';

const args = process.argv.slice(2);
const pr = args.find(a => /^\d+$/.test(a));
const DRY = process.env.LOCALAI_CI_DRY === '1' || args.includes('--dry');
const fresh = args.includes('--fresh');
const post = Boolean(pr) && !args.includes('--no-post') && !DRY;
const ship = args.includes('--merge');
const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-ci-'));
const logFile = path.join(work, 'ci.log');
const log = fs.createWriteStream(logFile);
const say = line => { console.log(line); log.write(line + '\n'); };
const git = (...a) => execFileSync('git', a, { cwd: repoRoot, encoding: 'utf8' }).trim();
const gh = (...a) => execFileSync('gh', a, { cwd: repoRoot, encoding: 'utf8' }).trim();
// Local CI's own cache (scripts/local-ci-cache.mjs): green results and suite times, in the git common dir.
// LOCALAI_CI_CACHE_DIR points it elsewhere (tests/local-ci-reuse.test.cjs uses a throwaway folder).
const cacheDir = process.env.LOCALAI_CI_CACHE_DIR || path.join(git('rev-parse', '--path-format=absolute', '--git-common-dir'), 'localai-ci');
const GREEN_FILE = path.join(cacheDir, 'green.json'), DURATIONS_FILE = path.join(cacheDir, 'durations.json');
const cacheWarning = m => say(`(local CI cache: ${m})`);

let dir = repoRoot, sha = null, worktree = null, baseRef = 'main', testedBase = null, releaseOnly = false;
const hasPwsh = (() => { try { execFileSync('pwsh', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } })();
async function status(state, description) {
  if (!post) { if (pr) say(`(not posting) status ${state}: ${description}`); return; }
  try {
    gh('api', '-X', 'POST', `repos/{owner}/{repo}/statuses/${sha}`, '-f', `state=${state}`, '-f', 'context=local-ci',
      '-f', `description=${description.slice(0, 140)}`);
  } catch (e) { say(`(couldn't post the status: ${e.message.split('\n')[0]})`); }
}
// A PR comment; what the status can't hold (test names, the retry note). Never throws: a comment is not the result.
function comment(body) {
  if (!post) { if (pr) say(`(not posting) comment:\n${body.split('\n').map(l => '  | ' + l).join('\n')}`); return; }
  try { gh('pr', 'comment', pr, '--body', body); } catch (e) { say(`(couldn't post the comment: ${e.message.split('\n')[0]})`); }
}

// `buffered`: for steps that run side by side (the browser workers). Their output goes to the log in one block when the
// step ends, instead of interleaved with the others'.
function run(name, cmd, cmdArgs, { env = {}, cwd = dir, buffered = false } = {}) {
  if (DRY) [cmd, cmdArgs] = dryCommand(name);
  return new Promise(resolve => {
    say(buffered ? `=== ${name} (started)` : `\n=== ${name}`);
    const child = track(spawn(cmd, cmdArgs, { cwd, env: { ...process.env, ...env }, shell: false, detached: true }));
    let tail = '', out = '';
    const block = [];
    const take = d => { const s = d.toString(); if (buffered) block.push(s); else log.write(s); tail = (tail + s).slice(-4000); out = (out + s).slice(-2e6); };
    child.stdout.on('data', take); child.stderr.on('data', take);
    child.on('close', code => {
      if (buffered) log.write(`\n=== ${name}\n${block.join('')}`);
      say(code === 0 ? `--- ${name}: ok` : `--- ${name}: FAILED (exit ${code})`);
      resolve({ ok: code === 0, tail, out });
    });
  });
}

// Dry run: each step is a node one-liner that prints what the real step's output would show and exits like it.
function dryCommand(name) {
  const failUnit = process.env.LOCALAI_CI_FAIL_UNIT, failSuite = process.env.LOCALAI_CI_FAIL_SUITE;
  let script = `console.log('(dry) ${name.replace(/'/g, '')}')`;
  if (name === 'Unit and contract tests' && failUnit) script = `console.log('✖ ' + ${JSON.stringify(failUnit)} + ' (1ms)\\nℹ pass 5\\nℹ fail 1\\n\\n✖ failing tests:\\n\\n✖ ' + ${JSON.stringify(failUnit)} + ' (1ms)'); process.exit(1)`;
  // The browser workers: "Browser suites" (one worker), "Browser suites, worker k/n", "Browser suites, solo". The
  // injected failure lands in the first worker.
  else if (/^Browser suites(?:, worker 1\/| ?$)/.test(name) && failSuite) script = `console.log('--- ' + ${JSON.stringify(failSuite)} + ': FAILED in 0.1s\\n\\n13 of 14 browser suites passed; failed: ' + ${JSON.stringify(failSuite)}); process.exit(1)`;
  else if (name.startsWith('Browser suites')) script = `console.log('--- dry-ui.mjs: passed in 0.1s\\n\\n14 of 14 browser suites passed')`;
  else if (name.startsWith('Retry ')) script = `console.log('1 of 1 browser suites passed')`;
  else if (name === 'Re-check: unit and contract tests' && process.env.LOCALAI_CI_FAIL_RECHECK) script = `console.log('✖ ' + ${JSON.stringify(process.env.LOCALAI_CI_FAIL_RECHECK)} + ' (1ms)\\nℹ pass 5\\nℹ fail 1'); process.exit(1)`;
  return [process.execPath, ['-e', script]];
}

// Children run in their own process groups so a stopped run can take its whole tree (npm, node --test, browsers) with it.
const children = new Set();
function track(child) { children.add(child); child.on('exit', () => children.delete(child)); return child; }
function killChildren() { for (const c of children) { try { process.kill(-c.pid, 'SIGTERM'); } catch {} } }

// One run at a time on this machine: two full runs at once slow each other into timeouts. The lock is a directory
// (mkdir is atomic) holding the owner's pid; a lock whose owner is gone is taken over.
const LOCK = path.join(os.tmpdir(), 'localai-ci.lock');
let haveLock = false;
const lockOwner = () => { try { return JSON.parse(fs.readFileSync(path.join(LOCK, 'owner.json'), 'utf8')); } catch { return null; } };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
async function queue() {
  if (DRY) { say('(dry run: not taking the CI slot)'); return; }
  let told = 0;
  for (;;) {
    try {
      fs.mkdirSync(LOCK);
      fs.writeFileSync(path.join(LOCK, 'owner.json'), JSON.stringify({ pid: process.pid, pr: pr || null, since: new Date().toISOString() }));
      haveLock = true;
      return;
    } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const owner = lockOwner();
    if (owner && !alive(owner.pid)) { fs.rmSync(LOCK, { recursive: true, force: true }); continue; }
    if (!owner) { await new Promise(r => setTimeout(r, 1000)); if (!lockOwner()) fs.rmSync(LOCK, { recursive: true, force: true }); continue; }
    if (Date.now() - told > 60000) {
      const who = owner.pr ? `PR #${owner.pr}` : 'a local run';
      say(`Waiting for the local CI run on ${who} (pid ${owner.pid}) to finish…`);
      await status('pending', `Queued behind ${who}`);
      told = Date.now();
    }
    await new Promise(r => setTimeout(r, 5000));
  }
}
function releaseLock() { if (haveLock && lockOwner()?.pid === process.pid) fs.rmSync(LOCK, { recursive: true, force: true }); haveLock = false; }

// A fresh server for one browser worker: its own data folder, and PORT=0 so the system picks a port no one holds (a
// port probed free and then passed in can be taken by another worker or suite in between; tests/spawn-server.cjs).
// Resolves with { server, url }; url is null when the server didn't come up (its log is server-<label>.log).
async function startServer(label) {
  if (DRY) return { server: null, url: 'http://127.0.0.1:9' };
  const data = fs.mkdtempSync(path.join(work, `data-${label}-`));
  const server = track(spawn(process.execPath, ['app/server.js'], { cwd: dir, env: { ...process.env, LOCALAI_WORKSHOP_URL: process.env.LOCALAI_WORKSHOP_URL || 'http://127.0.0.1:9', LOCALAI_PI_HUB_URL: process.env.LOCALAI_PI_HUB_URL || 'off', DATA_DIR: data, WORKSPACE_ROOT: data, PORT: '0' }, detached: true }));
  const serverLog = fs.createWriteStream(path.join(work, `server-${label}.log`));
  server.stdout.pipe(serverLog); server.stderr.pipe(serverLog);
  const port = await new Promise(resolve => {
    let seen = '';
    const done = p => { clearTimeout(timer); server.stdout.off('data', onData); server.off('exit', onExit); resolve(p); };
    const onData = b => { seen = (seen + b).slice(-4000); const m = seen.match(/listening on 0\.0\.0\.0:(\d+)/); if (m) done(Number(m[1])); };
    const onExit = () => done(null);
    const timer = setTimeout(() => done(null), 30000);
    server.stdout.on('data', onData); server.once('exit', onExit);
  });
  if (!port) return { server, url: null };
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 30; i++) {
    try { if ((await fetch(`${url}/healthz`)).ok) return { server, url }; } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  return { server, url: null };
}

// The browser suites, in `workers` side by side, each against its own fresh server (tests/run-browser.mjs --shard
// k/n), then the timing-sensitive SOLO_SUITES alone on the first worker's server. With one worker, every suite runs in
// order against one server, as before. A suite that fails is run once more on its own against the server of the worker
// that ran it; one that passes then counts as passed but is reported in `retried`. Each passing suite's time is
// recorded for the next split. Returns { ok, passed, total, retried, failing }.
async function browserSuites(workers) {
  const none = { ok: false, passed: 0, total: 0, retried: [], failing: [] };
  say(`\n=== Browser acceptance (${workers === 1 ? 'one worker' : `${workers} workers side by side, then ${SOLO_SUITES.join(' and ')} alone`}${DRY ? '; dry run, no server' : ''})`);
  const servers = await Promise.all(Array.from({ length: workers }, (_, k) => startServer(workers === 1 ? 'main' : String(k + 1))));
  try {
    const down = servers.map((s, k) => (s.url ? null : k + 1)).filter(Boolean);
    if (down.length) { say(`--- Browser acceptance: FAILED (server did not become ready${workers > 1 ? ` for worker ${down.join(', ')}` : ''}; see ${workers === 1 ? 'server-main.log' : 'server-<worker>.log'})`); return { ...none, failing: ['server did not start'] }; }
    for (const [k, s] of servers.entries()) if (!DRY) say(`(worker ${k + 1}: fresh server at ${s.url})`);
    const envFor = k => ({ LOCALAI_URL: servers[k].url, LOCALAI_CI_DURATIONS: DURATIONS_FILE });
    let parts;
    if (workers === 1) parts = [{ name: 'Browser suites', worker: 0, ...(await run('Browser suites', process.execPath, ['tests/run-browser.mjs'], { env: envFor(0) })) }];
    else {
      parts = await Promise.all(servers.map(async (_, k) => {
        const name = `Browser suites, worker ${k + 1}/${workers}`;
        return { name, worker: k, ...(await run(name, process.execPath, ['tests/run-browser.mjs', '--shard', `${k + 1}/${workers}`], { env: envFor(k), buffered: true })) };
      }));
      parts.push({ name: 'Browser suites, solo', worker: 0, ...(await run('Browser suites, solo', process.execPath, ['tests/run-browser.mjs', '--solo'], { env: envFor(0) })) });
    }
    recordDurations(parts);
    const merged = mergeShardResults(parts);
    if (workers > 1) say(`\n${merged.line}${merged.missing.length ? ` (no result from: ${merged.missing.join(', ')})` : ''}`);
    const counts = { passed: merged.passed, total: merged.total };
    if (merged.ok) return { ...none, ok: true, ...counts };
    const plan = retryPlan(parts);
    if (!plan.length || merged.missing.length) {
      say(merged.failed.length > plan.length ? `(${merged.failed.length} suites failed: not a flake, nothing retried)` : merged.missing.length ? '(a worker gave no result; nothing retried)' : '(no suite named as failed; nothing retried)');
      return { ...none, ...counts, failing: merged.failed.length ? merged.failed : merged.missing };
    }
    const retried = [], failing = [];
    for (const { suite, worker } of plan) {
      const again = await run(`Retry ${suite}${workers > 1 ? ` (worker ${worker + 1})` : ''}`, process.execPath, ['tests/run-browser.mjs', suite], { env: envFor(worker) });
      (again.ok ? retried : failing).push(suite);
    }
    return { ok: !failing.length, passed: counts.passed + retried.length, total: counts.total, retried, failing };
  } finally { for (const s of servers) s.server?.kill(); }
}

// Keeps each passing suite's time for the next run's split. Never fails the run: the times only balance the workers.
function recordDurations(parts) {
  if (DRY) return;
  const found = Object.assign({}, ...parts.map(p => suiteDurations(p.out)));
  if (!Object.keys(found).length) return;
  try {
    const known = readJson(DURATIONS_FILE, {}, cacheWarning);
    writeJsonAtomic(DURATIONS_FILE, { ...(known && typeof known === 'object' && !Array.isArray(known) ? known : {}), ...found });
  } catch (e) { cacheWarning(`couldn't save suite times: ${e.message}`); }
}

// PR titles are the release notes. One advisory comment per PR, never a red.
function adviseOnTitle(title) {
  const advice = releaseNoteAdvice(title);
  if (!advice) return;
  say(`\n${advice}`);
  if (post) {
    try {
      const existing = JSON.parse(gh('pr', 'view', pr, '--json', 'comments')).comments || [];
      if (existing.some(c => String(c.body || '').startsWith(RELEASE_NOTE_MARKER))) return;
    } catch {}
  }
  comment(advice);
}

// The tree under test gets its own complete dependencies, installed once per lockfile from package-lock.json
// (devDependencies included) and cached in ~/.cache/localai-ci. Borrowing a checkout's node_modules let eslint and
// stylelint go missing, and their tests skip rather than fail. Runs hold the queue lock here, so one install at a time.
function ciDeps(treeDir) {
  if (DRY) return path.join(repoRoot, 'node_modules');
  const lock = fs.readFileSync(path.join(treeDir, 'package-lock.json'));
  const cache = path.join(os.homedir(), '.cache', 'localai-ci', 'deps-' + crypto.createHash('sha256').update(lock).digest('hex').slice(0, 16));
  if (!fs.existsSync(path.join(cache, 'node_modules', '.package-lock.json'))) {
    fs.rmSync(cache, { recursive: true, force: true });
    fs.mkdirSync(cache, { recursive: true });
    for (const f of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(treeDir, f), path.join(cache, f));
    say('Installing the locked dependencies (once per lockfile)…');
    execFileSync('npm', ['ci', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: cache, stdio: 'pipe' });
  }
  return path.join(cache, 'node_modules');
}

async function main() {
  const workers = shardCount({ cpus: os.cpus().length, env: process.env.LOCALAI_CI_SHARDS });  // a bad value stops here
  if (pr) {
    const head = JSON.parse(gh('pr', 'view', pr, '--json', 'headRefOid,headRefName,baseRefName,state,title'));
    const plan = prMode({ state: head.state, ship, pr });
    if (plan.mode === 'refuse') throw new Error(plan.reason);
    if (plan.mode === 'release-main') {
      // Merged on GitHub without ship: test the base branch as it is now, and release it if green (shipAfterGreen).
      releaseOnly = true; baseRef = head.baseRefName;
      git('fetch', '-q', 'origin', baseRef);
      sha = git('rev-parse', `origin/${baseRef}`); testedBase = sha;
      worktree = path.join(work, 'tree');
      git('worktree', 'add', '-q', '--detach', worktree, sha);
      dir = worktree;
      say(`PR #${pr} is already merged (without ship): testing ${baseRef} @ ${sha.slice(0, 7)} to release it${DRY ? ' [dry run]' : ''}`);
      await queue();
      await status('pending', 'Running on ' + os.hostname());
      try { fs.symlinkSync(ciDeps(dir), path.join(dir, 'node_modules')); }
      catch (e) { say(`--- Dependencies: FAILED (${String(e.message).split('\n')[0]})`); await status('error', 'Could not install dependencies'); return false; }
    } else {
    sha = head.headRefOid;
    baseRef = head.baseRefName;
    git('fetch', '-q', 'origin', head.baseRefName, `pull/${pr}/head`);
    worktree = path.join(work, 'tree');
    git('worktree', 'add', '-q', '--detach', worktree, sha);
    dir = worktree;
    say(`Local CI for PR #${pr} (${head.headRefName} @ ${sha.slice(0, 7)}) merged with origin/${head.baseRefName}${DRY ? ' [dry run]' : ''}`);
    try { adviseOnTitle(head.title); } catch (e) { say(`(title check skipped: ${e.message.split('\n')[0]})`); }
    await queue();
    await status('pending', 'Running on ' + os.hostname());
    // The main this run tests: the ship re-check compares against it. (Fetched before the queue, so a wait counts too.)
    testedBase = git('rev-parse', `origin/${head.baseRefName}`);
    noticeUnshipped();
    try { execFileSync('git', ['merge', '-q', '--no-edit', `origin/${head.baseRefName}`], { cwd: dir, stdio: 'pipe' }); }
    catch { say(`--- Merge with ${head.baseRefName}: FAILED (conflicts; merge main into the branch first)`); await status('failure', `Conflicts with ${head.baseRefName}`); return false; }
    try { fs.symlinkSync(ciDeps(dir), path.join(dir, 'node_modules')); }
    catch (e) { say(`--- Dependencies: FAILED (${String(e.message).split('\n')[0]})`); await status('error', 'Could not install dependencies'); return false; }
    }
  } else {
    say(`Local CI for the current checkout (${git('rev-parse', '--short', 'HEAD')}); nothing is posted${DRY ? ' [dry run]' : ''}`);
    await queue();
  }

  // The tree about to be tested, and whether a green result for it is on record (reuseKey says what makes it the same).
  const tested = testedKey();
  if (fresh) say('(--fresh: running everything, not reusing a green result)');
  else {
    const hit = DRY && process.env.LOCALAI_CI_DRY_REUSE === '1'
      ? { tree: tested.tree || 'dry0000', at: '(dry run)', pr: pr || null, summary: 'All passed: (dry) 14/14 browser suites' }
      : findGreen(readJson(GREEN_FILE, {}, cacheWarning)?.green, tested.key);
    if (hit) {
      const description = reusedDescription(hit);
      say(`\n${reuseLine(hit)}`);
      say(`✅ ${description}`);
      await status('success', description);
      return true;
    }
    if (!tested.key) say(`(no reuse: ${tested.why})`);
  }

  const results = [];
  const step = async (name, ...a) => { const r = await run(name, ...a); results.push([name, r.ok]); return r; };
  const jsFiles = ['app', 'app/public', 'tests'].flatMap(d => fs.readdirSync(path.join(dir, d)).filter(f => /\.(js|mjs|cjs)$/.test(f) && (d !== 'tests' || /\.(mjs|cjs)$/.test(f))).map(f => `${d}/${f}`));
  await step('JavaScript syntax', 'sh', ['-c', jsFiles.map(f => `node --check '${f}'`).join(' && ')]);
  const unit = await step('Unit and contract tests', 'npm', ['test']);
  await step('Python syntax', 'python3', ['-m', 'py_compile', 'host/gridcraft-bridge.py', 'host/gridcraft-agent/gridcraft_ai.py']);
  if (hasPwsh) {
    await step('PowerShell syntax', 'pwsh', ['-NoProfile', '-Command', "$f=$false; Get-ChildItem -Path deploy,tests,host -Filter '*.ps1' -File -Recurse | % { $t=$null;$e=$null; [System.Management.Automation.Language.Parser]::ParseFile($_.FullName,[ref]$t,[ref]$e)|Out-Null; if($e.Count){$f=$true; Write-Host \"$($_.FullName): $($e[0].Message)\"} }; if($f){exit 1}"]);
    await step('Validate deployment candidate', 'pwsh', ['-NoProfile', '-File', 'deploy/Test-LocalAI-Candidate.ps1', '-CandidateRoot', '.', '-LocalNode']);
  } else say('\n(pwsh not installed: PowerShell steps skipped)');
  await step('No private-key files', 'sh', ['-c', "! find app -type f \\( -name '*.pem' -o -name '*.key' -o -name '*.pfx' -o -name '*.p12' -o -name '.env' \\) | grep ."]);
  await step('Kit drift', 'node', ['scripts/kit-drift.mjs']);  // prints the kit copy's line; warn-only unless KIT_DRIFT_ENFORCE=1
  await step('Kit literals', 'node', ['app/public/ui/literals.mjs', 'app/public']);  // Pi Hub A22 1.5: no hand-written colour, size or private name is added (.kit-literals-baseline.json)
  const browser = await browserSuites(workers);
  results.push(['Browser acceptance', browser.ok]);
  if (browser.retried.length) say(`(passed on retry: ${browser.retried.join(', ')})`);

  const failedSteps = results.filter(([, ok]) => !ok).map(([n]) => n);
  const unitCount = (unit.out.match(/ℹ pass (\d+)/) || [])[1];
  const { state, description } = ciSummary({ failedSteps, unitCount, browser, pwshSkipped: !hasPwsh });
  say(`\n${state === 'success' ? '✅' : '❌'} ${description}`);
  await status(state, description);
  if (failedSteps.length) comment(failureComment({ failedSteps, failingTests: unit.ok ? [] : failingUnitTests(unit.out), failingSuites: browser.failing, host: os.hostname() }));
  else if (browser.retried.length) comment(retryComment(browser.retried));
  if (shouldRecordGreen({ key: tested.key, dry: DRY, stopped: stopping, state, failedSteps })) {
    try {
      const entry = { key: tested.key, tree: tested.tree, node: process.version, at: new Date().toISOString(), pr: pr ? Number(pr) : null, summary: description };
      writeJsonAtomic(GREEN_FILE, { green: addGreen(readJson(GREEN_FILE, {}, cacheWarning)?.green, entry) });
      say(`(recorded as green for tree ${tested.tree.slice(0, 7)}: a ci or ship of the same tree reuses it)`);
    } catch (e) { cacheWarning(`couldn't record the green result: ${e.message}`); }
  }
  return state === 'success';
}

// The reuse key for the tree in `dir` (reuseKey). Never throws: a part that can't be read means no key, and says why.
function testedKey() {
  try {
    const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: dir, encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: dir, encoding: 'utf8' }).trim() !== '';
    const deps = fileHash(path.join(dir, 'node_modules', '.package-lock.json'));
    const key = reuseKey({ tree, node: process.version, deps, pwsh: hasPwsh, dirty });
    return { tree, key, why: dirty ? 'the checkout has uncommitted or untracked changes' : !deps ? 'no node_modules/.package-lock.json to identify the dependencies' : 'the tree could not be identified' };
  } catch (e) { return { tree: null, key: null, why: `couldn't read the tree (${String(e.message).split('\n')[0]})` }; }
}

// Ship, after a green run: re-check against the newest main, then merge. Runs before cleanup, so the tested worktree
// (and the CI slot) are still there. Returns whether the PR was merged (or, in a dry run, would have been).
let dryFetches = 0;
function latestBase() {
  if (DRY) return process.env.LOCALAI_CI_MAIN_MOVED !== '0' && ++dryFetches === 1 ? 'dry-new' : null;
  git('fetch', '-q', 'origin', baseRef);
  return git('rev-parse', `origin/${baseRef}`);
}
// Merges the newer main into the tested tree; false on a conflict.
function mergeNewerBase() {
  if (DRY) { say(`(dry) merge origin/${baseRef} into the tested tree`); return process.env.LOCALAI_CI_RECHECK_CONFLICT !== '1'; }
  try { execFileSync('git', ['merge', '-q', '--no-edit', `origin/${baseRef}`], { cwd: dir, stdio: 'pipe' }); }
  catch { try { execFileSync('git', ['merge', '--abort'], { cwd: dir, stdio: 'ignore' }); } catch {} return false; }
  // A newer main may have changed the lockfile: point the tree at the matching dependencies.
  const deps = ciDeps(dir), link = path.join(dir, 'node_modules');
  if (fs.readlinkSync(link) !== deps) { fs.unlinkSync(link); fs.symlinkSync(deps, link); }
  return true;
}
async function shipAfterGreen() {
  if (!DRY && !post) { say('Not merged: ship needs a PR number and posting (no --no-post, no dry run).'); return false; }
  if (releaseOnly) {
    // Nothing to merge: release the tested main, unless main moved during the run (then it holds untested work).
    const latest = latestBase();
    if (!DRY && latest !== testedBase) { say(`Release not moved: ${baseRef} moved during the run (${testedBase.slice(0, 7)} → ${latest.slice(0, 7)}); run ship again.`); return false; }
    if (DRY) { say(`(dry run) would move ${RELEASE_BRANCH} to ${baseRef}`); return true; }
    advanceRelease();
    return true;
  }
  let tested = testedBase || 'dry-old';
  for (let rechecks = 0; ; rechecks++) {
    const latest = latestBase() || tested;
    const next = shipNextStep({ testedBase: tested, latestBase: latest, rechecks });
    if (next === 'merge') break;
    if (next === 'give-up') { say(`Not merged: ${baseRef} kept moving through ${rechecks} re-checks; run ship again.`); return false; }
    say(`\n${baseRef} moved since the run started (${tested.slice(0, 7)} → ${latest.slice(0, 7)}): re-checking against it before merging.`);
    const results = [];
    let unit = { ok: true, out: '' };
    const conflict = !mergeNewerBase();
    if (!conflict) {
      unit = await run('Re-check: unit and contract tests', 'npm', ['test']);
      results.push(['Unit and contract tests', unit.ok]);
      if (hasPwsh) results.push(['Validate deployment candidate', (await run('Re-check: validate deployment candidate', 'pwsh', ['-NoProfile', '-File', 'deploy/Test-LocalAI-Candidate.ps1', '-CandidateRoot', '.', '-LocalNode'])).ok]);
    }
    const outcome = recheckOutcome({ base: baseRef, conflict, failedSteps: results.filter(([, ok]) => !ok).map(([n]) => n),
      failingTests: unit.ok ? [] : failingUnitTests(unit.out), host: os.hostname() });
    if (!outcome.ok) {
      say(`\n❌ Not merged: ${outcome.description}`);
      await status(outcome.state, outcome.description);
      comment(outcome.comment);
      return false;
    }
    say(`--- Re-check against ${baseRef} @ ${latest.slice(0, 7)}: ok`);
    tested = latest;
  }
  if (DRY) { say(`(dry run) would merge${pr ? `: gh ${shipMergeArgs(pr, sha).join(' ')}` : ' (no PR number, so nothing to merge)'}`); return true; }
  try { gh(...shipMergeArgs(pr, sha)); say(`Merged PR #${pr} (${sha.slice(0, 7)}).`); }
  catch (e) {
    // Merged on GitHub while this run tested it: release main if main is exactly what was tested (releaseDecision checks).
    let merged = false; try { merged = gh('pr', 'view', pr, '--json', 'state', '-q', '.state').trim() === 'MERGED'; } catch {}
    if (merged) { say(`PR #${pr} was merged on GitHub during the run; releasing main if it is what this run tested.`); advanceRelease(); return true; }
    say(`Not merged: ${String(e.stderr || e.message).trim().split('\n')[0]} (was something pushed after the test started?)`); return false;
  }
  advanceRelease();
  return true;
}

// Says first when main holds PRs merged without ship (no green local-ci on their head): this run tests them too, and a
// ship releases them. Never fails the run.
function noticeUnshipped() {
  if (DRY || baseRef !== 'main') return;
  try {
    git('fetch', '-q', 'origin', RELEASE_BRANCH);
    const merges = mergedPrs(git('log', '--first-parent', '--merges', '--format=%H %P|%s', `origin/${RELEASE_BRANCH}..${testedBase}`));
    for (const m of merges) {
      try { m.green = gh('api', `repos/{owner}/{repo}/commits/${m.head}/status`, '-q', '.statuses[]|select(.context=="local-ci")|.state').split('\n').includes('success'); }
      catch { m.green = true; }  // can't tell: say nothing about it
    }
    const note = unshippedNote(merges, pr, ship);
    if (note) say(note);
  } catch (e) { say(`(couldn't check main for unshipped merges: ${String(e.message).split('\n')[0]})`); }
}

// Moves `release`, the branch the host deploys, to the merge commit when its tree is the one just tested. Never fails
// the ship: when it doesn't move, the host keeps running the previous release and says so in the Inbox.
function advanceRelease() {
  try {
    git('fetch', '-q', 'origin', baseRef);
    const merged = git('rev-parse', `origin/${baseRef}`);
    const testedTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: dir, encoding: 'utf8' }).trim();
    const decision = releaseDecision({ base: baseRef, testedTree, mergedTree: git('rev-parse', `${merged}^{tree}`) });
    if (!decision.advance) { say(`Release not moved: ${decision.reason}.`); return; }
    // LOCALAI_SHIP lets the push past .githooks/pre-push, which refuses pushes to main and release otherwise.
    execFileSync('git', ['push', '-q', 'origin', `${merged}:refs/heads/${RELEASE_BRANCH}`], { cwd: repoRoot, stdio: 'pipe', env: { ...process.env, LOCALAI_SHIP: '1' } });
    say(`Release moved to ${merged.slice(0, 7)}; the host deploys it within about 5 minutes.`);
  } catch (e) { say(`Release not moved: ${String(e.stderr || e.message).trim().split('\n')[0]}`); }
}

let ok = false;
// Stopped (Ctrl-C, kill): stop the tests, say so on the PR, and clean up like a normal end.
let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, async () => {
  if (stopping) return; stopping = true;
  say(`\nStopped (${sig}).`);
  killChildren();
  if (sha) await status('error', 'Stopped before it finished');
  if (worktree) { try { git('worktree', 'remove', '--force', worktree); } catch {} }
  releaseLock();
  process.exit(130);
});
try {
  ok = await main();
  if (ship) { if (ok) ok = await shipAfterGreen(); else say(`Not merged: local CI isn't green.`); }
}
catch (e) { ok = false; say(`Local CI couldn't run: ${e.message}`); if (sha) await status('error', `Couldn't run: ${e.message}`); }
finally {
  killChildren();
  releaseLock();
  if (worktree) { try { git('worktree', 'remove', '--force', worktree); } catch {} }
  say(`Log: ${logFile}`);
  log.end();
}
process.exit(ok ? 0 : 1);
