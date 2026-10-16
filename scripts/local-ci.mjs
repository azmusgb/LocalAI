#!/usr/bin/env node
// Local CI: runs what .github/workflows/validate.yml runs, on this machine, and posts the result to the pull request
// as a "local-ci" commit status (statuses aren't billed, so this works while GitHub Actions can't start).
//
//   npm run ci -- 195            test PR #195 merged with the latest main, post pending, then success or failure
//   npm run ci -- 195 --no-post  same, without posting
//   npm run ci                   test the current checkout as it is (never posts)
//
// A PR is tested in a throwaway worktree (its head merged with origin/main, as GitHub's pull_request runs do), so
// your own checkout is never touched. The log is kept in the system temp folder and its path printed at the end.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const args = process.argv.slice(2);
const pr = args.find(a => /^\d+$/.test(a));
const post = Boolean(pr) && !args.includes('--no-post');
const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-ci-'));
const logFile = path.join(work, 'ci.log');
const log = fs.createWriteStream(logFile);
const say = line => { console.log(line); log.write(line + '\n'); };
const git = (...a) => execFileSync('git', a, { cwd: repoRoot, encoding: 'utf8' }).trim();
const gh = (...a) => execFileSync('gh', a, { cwd: repoRoot, encoding: 'utf8' }).trim();

let dir = repoRoot, sha = null, worktree = null;
async function status(state, description) {
  if (!post) return;
  try {
    gh('api', '-X', 'POST', `repos/{owner}/{repo}/statuses/${sha}`, '-f', `state=${state}`, '-f', 'context=local-ci',
      '-f', `description=${description.slice(0, 140)}`);
  } catch (e) { say(`(couldn't post the status: ${e.message.split('\n')[0]})`); }
}

function run(name, cmd, cmdArgs, { env = {}, cwd = dir } = {}) {
  return new Promise(resolve => {
    say(`\n=== ${name}`);
    const child = track(spawn(cmd, cmdArgs, { cwd, env: { ...process.env, ...env }, shell: false, detached: true }));
    let tail = '';
    const take = d => { const s = d.toString(); log.write(s); tail = (tail + s).slice(-4000); };
    child.stdout.on('data', take); child.stderr.on('data', take);
    child.on('close', code => { say(code === 0 ? `--- ${name}: ok` : `--- ${name}: FAILED (exit ${code})`); resolve({ ok: code === 0, tail }); });
  });
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

const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

async function browserSuites() {
  const data = fs.mkdtempSync(path.join(work, 'data-'));
  const port = await freePort();
  say(`\n=== Browser acceptance (fresh server on port ${port})`);
  const server = track(spawn(process.execPath, ['app/server.js'], { cwd: dir, env: { ...process.env, DATA_DIR: data, WORKSPACE_ROOT: data, PORT: String(port) }, detached: true }));
  const serverLog = fs.createWriteStream(path.join(work, 'server.log'));
  server.stdout.pipe(serverLog); server.stderr.pipe(serverLog);
  try {
    let ready = false;
    for (let i = 0; i < 30 && !ready; i++) {
      try { ready = (await fetch(`http://127.0.0.1:${port}/healthz`)).ok; } catch {}
      if (!ready) await new Promise(r => setTimeout(r, 1000));
    }
    if (!ready) { say('--- Browser acceptance: FAILED (server did not become ready; see server.log)'); return { ok: false, summary: 'server did not start' }; }
    const r = await run('Browser suites', process.execPath, ['tests/run-browser.mjs'], { env: { LOCALAI_URL: `http://127.0.0.1:${port}` } });
    const m = r.tail.match(/(\d+) of (\d+) browser suites passed/);
    return { ok: r.ok, summary: m ? `${m[1]}/${m[2]} browser suites` : 'browser suites' };
  } finally { server.kill(); }
}

async function main() {
  if (pr) {
    const head = JSON.parse(gh('pr', 'view', pr, '--json', 'headRefOid,headRefName,baseRefName,state'));
    if (head.state !== 'OPEN') throw new Error(`PR #${pr} is ${head.state.toLowerCase()}`);
    sha = head.headRefOid;
    git('fetch', '-q', 'origin', head.baseRefName, `pull/${pr}/head`);
    worktree = path.join(work, 'tree');
    git('worktree', 'add', '-q', '--detach', worktree, sha);
    dir = worktree;
    fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(dir, 'node_modules'));
    say(`Local CI for PR #${pr} (${head.headRefName} @ ${sha.slice(0, 7)}) merged with origin/${head.baseRefName}`);
    await queue();
    await status('pending', 'Running on ' + os.hostname());
    try { execFileSync('git', ['merge', '-q', '--no-edit', `origin/${head.baseRefName}`], { cwd: dir, stdio: 'pipe' }); }
    catch { say(`--- Merge with ${head.baseRefName}: FAILED (conflicts; merge main into the branch first)`); await status('failure', `Conflicts with ${head.baseRefName}`); return false; }
  } else {
    say(`Local CI for the current checkout (${git('rev-parse', '--short', 'HEAD')}); nothing is posted`);
    await queue();
  }

  const results = [];
  const step = async (name, ...a) => { const r = await run(name, ...a); results.push([name, r.ok]); return r; };
  const jsFiles = ['app', 'app/public', 'tests'].flatMap(d => fs.readdirSync(path.join(dir, d)).filter(f => /\.(js|mjs|cjs)$/.test(f) && (d !== 'tests' || /\.(mjs|cjs)$/.test(f))).map(f => `${d}/${f}`));
  await step('JavaScript syntax', 'sh', ['-c', jsFiles.map(f => `node --check '${f}'`).join(' && ')]);
  const unit = await step('Unit and contract tests', 'npm', ['test']);
  await step('Python syntax', 'python3', ['-m', 'py_compile', 'host/gridcraft-bridge.py', 'host/gridcraft-agent/gridcraft_ai.py']);
  const hasPwsh = (() => { try { execFileSync('pwsh', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } })();
  if (hasPwsh) {
    await step('PowerShell syntax', 'pwsh', ['-NoProfile', '-Command', "$f=$false; Get-ChildItem -Path deploy,tests,host -Filter '*.ps1' -File -Recurse | % { $t=$null;$e=$null; [System.Management.Automation.Language.Parser]::ParseFile($_.FullName,[ref]$t,[ref]$e)|Out-Null; if($e.Count){$f=$true; Write-Host \"$($_.FullName): $($e[0].Message)\"} }; if($f){exit 1}"]);
    await step('Validate deployment candidate', 'pwsh', ['-NoProfile', '-File', 'deploy/Test-LocalAI-Candidate.ps1', '-CandidateRoot', '.', '-LocalNode']);
  } else say('\n(pwsh not installed: PowerShell steps skipped)');
  await step('No private-key files', 'sh', ['-c', "! find app -type f \\( -name '*.pem' -o -name '*.key' -o -name '*.pfx' -o -name '*.p12' -o -name '.env' \\) | grep ."]);
  const browser = await browserSuites();
  results.push(['Browser acceptance', browser.ok]);

  const failed = results.filter(([, ok]) => !ok).map(([n]) => n);
  const unitCount = (unit.tail.match(/ℹ pass (\d+)/) || [])[1];
  const summary = failed.length ? `Failed: ${failed.join(', ')}` : `All passed: ${unitCount ? unitCount + ' unit tests, ' : ''}${browser.summary}${hasPwsh ? '' : ' (PowerShell skipped)'}`;
  say(`\n${failed.length ? '❌' : '✅'} ${summary}`);
  await status(failed.length ? 'failure' : 'success', summary);
  return !failed.length;
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
try { ok = await main(); }
catch (e) { say(`Local CI couldn't run: ${e.message}`); if (sha) await status('error', `Couldn't run: ${e.message}`); }
finally {
  killChildren();
  releaseLock();
  if (worktree) { try { git('worktree', 'remove', '--force', worktree); } catch {} }
  say(`Log: ${logFile}`);
  log.end();
}
process.exit(ok ? 0 : 1);
