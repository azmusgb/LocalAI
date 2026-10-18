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
