// The decisions local CI (scripts/local-ci.mjs) makes from test output: which tests failed, which browser suites to
// run again, what the commit status and the PR comments say. Pure functions, no I/O, so tests/local-ci.test.cjs can
// check them without running the real steps.

// Names of the failing tests in node --test (spec reporter) output: "✖ name (1.2ms)" lines, each name once, in the
// order they first appear. Per-file lines ("✖ tests/x.test.cjs (…)") and the "✖ failing tests:" header are left out.
export function failingUnitTests(output, max = 10) {
  const names = [];
  for (const line of String(output || '').split('\n')) {
    const m = line.match(/^\s*✖ (.+?) \(\d+(?:\.\d+)?m?s\)\s*$/);
    if (!m) continue;
    const name = m[1].trim();
    if (/\.(?:cjs|mjs|js)$/.test(name) || names.includes(name)) continue;
    names.push(name);
    if (names.length >= max) break;
  }
  return names;
}

// Browser suites that run-browser.mjs reported as failed ("--- work-ui.mjs: FAILED in 9.0s"), each once.
export function failedBrowserSuites(output) {
  const names = [];
  for (const m of String(output || '').matchAll(/^--- (\S+-ui\.mjs): FAILED\b/gm)) if (!names.includes(m[1])) names.push(m[1]);
  return names;
}

// "12 of 14 browser suites passed" → { passed: 12, total: 14 }; null when the line is missing.
export function browserSuiteCounts(output) {
  const m = String(output || '').match(/(\d+) of (\d+) browser suites passed/);
  return m ? { passed: Number(m[1]), total: Number(m[2]) } : null;
}

// A suite that fails on its own is run once more; when more than this many fail at once the server or the change is
// broken, not flaky, and nothing is retried.
export const MAX_RETRIED_SUITES = 3;
export function suitesToRetry(failed) {
  return failed.length && failed.length <= MAX_RETRIED_SUITES ? [...failed] : [];
}

const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

// The commit status. `browser.failing` are suites red after their retry, `browser.retried` those green on retry.
// A retried suite never makes the run red, but it is named so flakes are tracked rather than hidden.
export function ciSummary({ failedSteps, unitCount, browser, pwshSkipped }) {
  const b = browser || { passed: 0, total: 0, retried: [], failing: [] };
  if (failedSteps.length) {
    const steps = failedSteps.map(s => s === 'Browser acceptance' && b.failing?.length ? `${s} (${b.failing.join(', ')})` : s);
    return { state: 'failure', description: `Failed: ${steps.join(', ')}` };
  }
  const counts = `${unitCount ? unitCount + ' unit tests, ' : ''}${b.total ? `${b.passed}/${b.total} browser suites` : 'browser suites'}${pwshSkipped ? ' (PowerShell skipped)' : ''}`;
  const retried = b.retried || [];
  const description = retried.length ? `All passed, ${plural(retried.length, 'suite')} on retry: ${retried.join(', ')} (${counts})` : `All passed: ${counts}`;
  return { state: 'success', description };
}

// The one comment a red run leaves on the PR, so the red is not missed and the failing tests are named without
// opening the log.
export function failureComment({ failedSteps, failingTests = [], failingSuites = [], host = '' }) {
  const lines = [`**local-ci failed**${host ? ` on ${host}` : ''}: ${failedSteps.join(', ')}.`];
  if (failingTests.length) lines.push('', `Failing ${plural(failingTests.length, 'unit test')}${failingTests.length >= 10 ? ' (first ten)' : ''}:`, ...failingTests.map(n => `- ${n}`));
  if (failingSuites.length) lines.push('', `Browser ${plural(failingSuites.length, 'suite')} that failed twice (once and again on retry): ${failingSuites.join(', ')}.`);
  lines.push('', 'A red check has been a real bug before; fix or explain it before merging.');
  return lines.join('\n');
}

// Posted when a browser suite failed and then passed when run again: the run is green, the flake is on record.
export function retryComment(retried) {
  const list = retried.join(', ');
  return `**local-ci**: browser ${retried.length === 1 ? 'suite' : 'suites'} ${list} failed once and passed on retry, so the check is green. ` +
    'If the same suite does this on another PR it is a bug to find, not noise.';
}

// PR titles become the release notes (docs/DEPLOY.md). A long title or one with several clauses gets a note; it
// never fails the run. The marker lets a later run see that the note was already left.
export const RELEASE_NOTE_MARKER = 'Release note:';
export function releaseNoteAdvice(title) {
  const t = String(title || '');
  if (!t) return null;
  if (t.length <= 70 && !t.includes(';') && !t.includes(' — ')) return null;
  return `${RELEASE_NOTE_MARKER} this title becomes the release note; consider ≤ 70 chars, one clause. (It is ${t.length} characters${t.includes(';') || t.includes(' — ') ? ' and has more than one clause' : ''}.)`;
}

// npm run ship -- <PR>: after a green run, merge exactly the commit that was tested. --match-head-commit makes GitHub
// refuse the merge if anything was pushed to the PR after the test began, so an untested commit never lands.
export function shipMergeArgs(pr, sha) {
  if (!/^\d+$/.test(String(pr)) || !/^[0-9a-f]{40}$/.test(String(sha))) throw new Error('ship needs a PR number and the tested commit');
  return ['pr', 'merge', String(pr), '--merge', '--match-head-commit', String(sha)];
}

// npm run ship -- <PR>: the run tests the PR merged with main as main was when the run started (~15 min earlier).
// Another PR merged meanwhile isn't in what was tested, and two PRs green on their own can be red together (twice the
// shell's size budget went over that way). So after a green run ship fetches main again and, if main has moved,
// merges it into the tested tree and re-runs the fast checks (npm test, the deploy validator) before merging. Main
// can move again during that minute or two, so this repeats, at most MAX_RECHECKS times.
export const MAX_RECHECKS = 3;
// What to do next: 'merge' (main is where the last check saw it), 'recheck' (main moved; check again), or 'give-up'
// (it kept moving through MAX_RECHECKS re-checks; run ship again later).
export function shipNextStep({ testedBase, latestBase, rechecks = 0 }) {
  if (!testedBase || !latestBase) throw new Error('ship needs the main commit that was tested and the latest one');
  if (testedBase === latestBase) return 'merge';
  return rechecks >= MAX_RECHECKS ? 'give-up' : 'recheck';
}

// The result of one re-check against the newer main. `conflict`: the PR no longer merges with it. `failedSteps`: the
// re-check steps that went red; `failingTests`: unit test names from their output. Returns whether ship may go on and,
// when it may not, the failure status and the PR comment.
export function recheckOutcome({ base = 'main', conflict = false, failedSteps = [], failingTests = [], host = '' }) {
  if (!conflict && !failedSteps.length) return { ok: true };
  const what = conflict ? `conflicts with the newer ${base}` : failingTests.length ? failingTests.join(', ') : failedSteps.join(', ');
  const description = `${base} moved; re-check failed: ${what}`;
  const lines = [`**local-ci: not merged.** The full run was green, but \`${base}\` moved while it ran, and the re-check against the newer \`${base}\`${host ? ` on ${host}` : ''} failed.`];
  if (conflict) lines.push('', `The PR no longer merges cleanly with \`${base}\`: merge \`${base}\` into the branch, then ship again.`);
  else {
    lines.push('', `Failed: ${failedSteps.join(', ')}.`);
    if (failingTests.length) lines.push('', `Failing ${plural(failingTests.length, 'test')}${failingTests.length >= 10 ? ' (first ten)' : ''}:`, ...failingTests.map(n => `- ${n}`));
    lines.push('', `Each change passes on its own; together with what landed on \`${base}\` they don't. Merge \`${base}\` into the branch and fix it there.`);
  }
  return { ok: false, state: 'failure', description, comment: lines.join('\n') };
}

// The host deploys only the `release` branch (deploy/Run-LocalAI-AutoDeploy.ps1), and only ship moves it: to the merge
// commit, when that commit holds exactly the tree ship just tested. A commit pushed straight to main, or merged on
// GitHub without ship, never reaches it. Returns whether to move release and, when not, why.
export const RELEASE_BRANCH = 'release';
// Only a PR into main may move release (a PR into another branch merges there, not into what main ships). The push is
// a plain fast-forward, so git itself refuses a release commit that doesn't descend from the current one.
export function releaseDecision({ base = 'main', testedTree, mergedTree }) {
  if (base !== 'main') return { advance: false, reason: `the PR merged into ${base}, not main` };
  if (!/^[0-9a-f]{40}$/.test(String(testedTree)) || !/^[0-9a-f]{40}$/.test(String(mergedTree))) return { advance: false, reason: 'could not read the tested or merged tree' };
  if (testedTree !== mergedTree) return { advance: false, reason: 'main holds something the run did not test (it moved during the merge); ship the next PR, or run ship again' };
  return { advance: true };
}

// What a run does with the PR it was given. An open PR is tested merged with main. A PR already merged on GitHub can't be
// merged again, but ship still owes main a release (5 Nov: #497, #499-#502 merged on GitHub while ship waited): it tests
// main as it is now and, if green, moves release there; releaseDecision still checks main's tree is the tested one.
export function prMode({ state, ship, pr }) {
  if (state === 'OPEN') return { mode: 'pr' };
  if (state === 'MERGED' && ship) return { mode: 'release-main' };
  return { mode: 'refuse', reason: `PR #${pr} is ${String(state || 'unknown').toLowerCase()}${state === 'MERGED' ? '; ship it to release main' : ''}` };
}

// PRs merged on GitHub without ship (26 Oct: #407 and #408) land on main untested and never deploy; the next ship
// tests and releases them with its own PR. mergedPrs reads `git log --first-parent --merges --format='%H %P|%s'
// origin/release..origin/main` (newest first) into [{pr, merge, head}], oldest first; the head is the merge's second
// parent, where ship posts its local-ci status.
export function mergedPrs(out) {
  const found = [];
  for (const line of String(out || '').split('\n')) {
    const m = /^([0-9a-f]{40}) [0-9a-f]{40} ([0-9a-f]{40})\|Merge pull request #(\d+) /.exec(line);
    if (m) found.push({ pr: Number(m[3]), merge: m[1], head: m[2] });
  }
  return found.reverse();
}
// The line a run prints first when main holds PRs without a green local-ci (other than the one it tests), or null.
export function unshippedNote(merges, pr, releasing) {
  const prs = merges.filter(m => !m.green && m.pr !== Number(pr)).map(m => `#${m.pr}`);
  if (!prs.length) return null;
  const one = prs.length === 1, list = one ? prs[0] : `${prs.slice(0, -1).join(', ')} and ${prs[prs.length - 1]}`;
  return `Note: ${list} ${one ? 'is' : 'are'} on main but ${one ? 'was' : 'were'} never shipped (merged on GitHub without local CI). `
    + `This run tests ${one ? 'it' : 'them'} with PR #${pr}${releasing ? ` and releases ${one ? 'it' : 'them'} too` : ''}; `
    + `if it fails, check whether the failure comes from ${one ? 'it' : 'them'}.`;
}

// Reusing a green run. A ship right after a green `npm run ci -- <PR>` used to test the identical tree a second time
// (~15 min). The key is what the run actually tested: the tree hash (the PR merged with main, or main itself), the Node
// version, whether the PowerShell steps ran, and the installed dependencies (a hash of node_modules/.package-lock.json;
// the lockfile is in the tree, but this is what was really loaded). A dirty checkout, or any part that couldn't be read,
// gives no key, so nothing is reused or recorded.
export function reuseKey({ tree, node, deps, pwsh, dirty }) {
  if (dirty !== false) return null;
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(String(tree || '')) || !/^v\d+\.\d+\.\d+/.test(String(node || '')) || !/^[0-9a-f]{16,}$/.test(String(deps || ''))) return null;
  return `${tree} ${node} ${pwsh ? 'pwsh' : 'no-pwsh'} ${deps}`;
}

// A result is recorded only after a real run that finished with every step green (a suite green on retry counts, as it
// does for the status). Never a dry, stopped or failed run, nor one without a key.
export function shouldRecordGreen({ key, dry, stopped, state, failedSteps = [] }) {
  return Boolean(key) && !dry && !stopped && state === 'success' && !failedSteps.length;
}

// The cache keeps the newest GREEN_CAP results, newest first, one per key.
export const GREEN_CAP = 50;
export function addGreen(entries, entry, cap = GREEN_CAP) {
  if (!entry?.key) throw new Error('a green result needs its key');
  const rest = (Array.isArray(entries) ? entries : []).filter(e => e && e.key !== entry.key);
  return [entry, ...rest].slice(0, cap);
}
export function findGreen(entries, key) {
  if (!key || !Array.isArray(entries)) return null;
  return entries.find(e => e && e.key === key && typeof e.summary === 'string' && e.at) || null;
}
// What a reusing run prints, and the status it posts (the original summary, marked as reused).
export function reuseLine(entry) {
  return `Reusing the green result from ${entry.at} for tree ${String(entry.tree).slice(0, 7)}${entry.pr ? ` (PR #${entry.pr})` : ' (a local run)'}`;
}
export function reusedDescription(entry) {
  const tag = ' (reused)';
  return String(entry.summary).slice(0, 140 - tag.length) + tag;
}

// Splitting the browser suites across workers. Suites known to be timing-sensitive run alone after the shards finish
// (perf-ui fails on frame times, visual-ui on pixels), so other shards' load can't make them flaky.
export const SOLO_SUITES = ['perf-ui.mjs', 'visual-ui.mjs'];

// Default worker count: one per three cores, at most four. LOCALAI_CI_SHARDS overrides it; 1 runs every suite in one
// worker, as before.
export function shardCount({ cpus, env }) {
  const set = String(env ?? '').trim();
  if (set) {
    if (!/^\d+$/.test(set) || Number(set) < 1 || Number(set) > 16) throw new Error(`LOCALAI_CI_SHARDS must be a whole number from 1 to 16 (got "${set}")`);
    return Number(set);
  }
  return Math.min(4, Math.max(1, Math.floor((Number(cpus) || 1) / 3)));
}

// "--shard 2/4" → { index: 1, count: 4 } (index from 0); null for anything else.
export function parseShard(spec) {
  const m = /^(\d+)\/(\d+)$/.exec(String(spec || ''));
  if (!m) return null;
  const i = Number(m[1]), n = Number(m[2]);
  return n >= 1 && i >= 1 && i <= n ? { index: i - 1, count: n } : null;
}

// Assigns suites to n shards. With recorded durations: longest first, each to the least-loaded shard (lowest index on a
// tie); a suite with no recorded time counts as the average of the known ones. With none: alphabetical round-robin.
// Every suite lands in exactly one shard, and the same input always gives the same split.
export function partitionSuites(suites, n, durations = {}) {
  const count = Math.max(1, Math.floor(Number(n) || 1));
  const names = [...new Set(suites)].sort();
  const shards = Array.from({ length: count }, () => []);
  const known = names.map(s => durations?.[s]).filter(d => Number.isFinite(d) && d >= 0);
  if (!known.length) { names.forEach((s, i) => shards[i % count].push(s)); return shards; }
  const average = known.reduce((a, b) => a + b, 0) / known.length;
  const cost = s => (Number.isFinite(durations[s]) && durations[s] >= 0 ? durations[s] : average);
  const load = new Array(count).fill(0);
  for (const s of [...names].sort((a, b) => cost(b) - cost(a) || (a < b ? -1 : 1))) {
    let k = 0;
    for (let j = 1; j < count; j++) if (load[j] < load[k]) k = j;
    shards[k].push(s); load[k] += cost(s);
  }
  return shards;
}

// Seconds per suite from run-browser output ("--- x-ui.mjs: passed in 4.1s"). Failed suites are left out: a failure's
// time says little about the next run's.
export function suiteDurations(output) {
  const found = {};
  for (const m of String(output || '').matchAll(/^--- (\S+-ui\.mjs): passed in (\d+(?:\.\d+)?)s\b/gm)) found[m[1]] = Number(m[2]);
  return found;
}

// One result from several run-browser outputs (the shards, and the solo suites run after them), in the summary-line
// format browserSuiteCounts and failedBrowserSuites read. A worker that printed no summary line (it crashed, or its
// server died) makes the whole result not ok, and is named in `missing`.
export function mergeShardResults(parts) {
  let passed = 0, total = 0, ok = true;
  const failed = [], missing = [];
  parts.forEach((p, i) => {
    const counts = browserSuiteCounts(p.out);
    if (!counts) { missing.push(p.name || `worker ${i + 1}`); ok = false; }
    else { passed += counts.passed; total += counts.total; }
    for (const s of failedBrowserSuites(p.out)) if (!failed.includes(s)) failed.push(s);
    if (!p.ok) ok = false;
  });
  const line = `${passed} of ${total} browser suites passed${failed.length ? `; failed: ${failed.join(', ')}` : ''}`;
  return { ok: ok && !failed.length, passed, total, failed, missing, line };
}

// Which worker's server a failed suite is retried on: the one that ran it. Returns [{ suite, worker }] in the order the
// suites failed, or [] when there are too many to call it a flake (suitesToRetry).
export function retryPlan(parts) {
  const owner = new Map();
  // A part names the worker whose server it ran on (the solo phase runs on worker 0's); its place in the list is only
  // a fallback for parts that don't say.
  parts.forEach((p, i) => { for (const s of failedBrowserSuites(p.out)) if (!owner.has(s)) owner.set(s, Number.isInteger(p.worker) ? p.worker : i); });
  return suitesToRetry([...owner.keys()]).map(suite => ({ suite, worker: owner.get(suite) }));
}
