'use strict';

// Local CI (scripts/local-ci.mjs) decides what to post to a PR from test output. The decisions live in
// scripts/local-ci-lib.mjs so they can be checked here without running the real steps.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const lib = () => import(pathToFileURL(path.resolve(__dirname, '../scripts/local-ci-lib.mjs')).href);

const UNIT_OUTPUT = `
✔ passes (0.28ms)
✖ fails one (0.333583ms)
▶ outer
  ✖ inner fails (0.093708ms)
✖ outer (0.202375ms)
✖ tests/example.test.cjs (12.5ms)
ℹ tests 4
ℹ pass 1
ℹ fail 3
✖ failing tests:

test at tests/example.test.cjs:1:88
✖ fails one (0.333583ms)
  AssertionError [ERR_ASSERTION]: 1 == 2
test at tests/example.test.cjs:1:156
✖ inner fails (0.093708ms)
  AssertionError [ERR_ASSERTION]: 1 == 3
`;

test('failing unit tests are read from node --test output, once each, files and headers left out', async () => {
  const { failingUnitTests } = await lib();
  assert.deepEqual(failingUnitTests(UNIT_OUTPUT), ['fails one', 'inner fails', 'outer']);
  assert.deepEqual(failingUnitTests('✔ all good (1ms)\nℹ pass 1\nℹ fail 0'), []);
  assert.deepEqual(failingUnitTests(''), []);
});

test('at most ten failing test names are kept', async () => {
  const { failingUnitTests } = await lib();
  const out = Array.from({ length: 25 }, (_, i) => `✖ test number ${i} (1ms)`).join('\n');
  const names = failingUnitTests(out);
  assert.equal(names.length, 10);
  assert.equal(names[0], 'test number 0');
  assert.equal(names[9], 'test number 9');
});

const BROWSER_OUTPUT = `
=== layout-ui.mjs
--- layout-ui.mjs: passed in 4.1s

=== work-ui.mjs
some stack trace
--- work-ui.mjs: FAILED in 9.0s

=== models-ui.mjs
--- models-ui.mjs: FAILED in 2.2s

12 of 14 browser suites passed; failed: work-ui.mjs, models-ui.mjs
`;

test('failed browser suites and the pass count are read from run-browser output', async () => {
  const { failedBrowserSuites, browserSuiteCounts } = await lib();
  assert.deepEqual(failedBrowserSuites(BROWSER_OUTPUT), ['work-ui.mjs', 'models-ui.mjs']);
  assert.deepEqual(browserSuiteCounts(BROWSER_OUTPUT), { passed: 12, total: 14 });
  assert.deepEqual(failedBrowserSuites('14 of 14 browser suites passed'), []);
  assert.equal(browserSuiteCounts('nothing useful'), null);
});

test('a few failed browser suites are retried; a wholesale failure is not a flake', async () => {
  const { suitesToRetry } = await lib();
  assert.deepEqual(suitesToRetry(['work-ui.mjs']), ['work-ui.mjs']);
  assert.deepEqual(suitesToRetry(['a-ui.mjs', 'b-ui.mjs', 'c-ui.mjs']), ['a-ui.mjs', 'b-ui.mjs', 'c-ui.mjs']);
  assert.deepEqual(suitesToRetry(['a-ui.mjs', 'b-ui.mjs', 'c-ui.mjs', 'd-ui.mjs']), []);
  assert.deepEqual(suitesToRetry([]), []);
});

test('the status says all passed, and names a suite that passed on retry', async () => {
  const { ciSummary } = await lib();
  const clean = ciSummary({ failedSteps: [], unitCount: '812', browser: { passed: 14, total: 14, retried: [], failing: [] }, pwshSkipped: false });
  assert.deepEqual(clean, { state: 'success', description: 'All passed: 812 unit tests, 14/14 browser suites' });

  const retried = ciSummary({ failedSteps: [], unitCount: '812', browser: { passed: 14, total: 14, retried: ['work-ui.mjs'], failing: [] }, pwshSkipped: true });
  assert.equal(retried.state, 'success');
  assert.match(retried.description, /^All passed, 1 suite on retry: work-ui\.mjs/);
  assert.match(retried.description, /812 unit tests, 14\/14 browser suites/);
  assert.match(retried.description, /PowerShell skipped/);

  const two = ciSummary({ failedSteps: [], unitCount: null, browser: { passed: 14, total: 14, retried: ['a-ui.mjs', 'b-ui.mjs'], failing: [] }, pwshSkipped: false });
  assert.match(two.description, /^All passed, 2 suites on retry: a-ui\.mjs, b-ui\.mjs/);
});

test('the status names the failed steps and the browser suites that failed twice', async () => {
  const { ciSummary } = await lib();
  const red = ciSummary({ failedSteps: ['Unit and contract tests', 'Browser acceptance'], unitCount: '800', browser: { passed: 13, total: 14, retried: [], failing: ['work-ui.mjs'] }, pwshSkipped: false });
  assert.equal(red.state, 'failure');
  assert.equal(red.description, 'Failed: Unit and contract tests, Browser acceptance (work-ui.mjs)');
  // A suite that passed on retry never makes the run red.
  const mixed = ciSummary({ failedSteps: ['Python syntax'], unitCount: '800', browser: { passed: 14, total: 14, retried: ['work-ui.mjs'], failing: [] }, pwshSkipped: false });
  assert.equal(mixed.state, 'failure');
  assert.equal(mixed.description, 'Failed: Python syntax');
  assert.ok(red.description.length <= 140);
});

test('a red run gets one comment naming the failing tests and suites', async () => {
  const { failureComment } = await lib();
  const body = failureComment({ failedSteps: ['Unit and contract tests', 'Browser acceptance'], failingTests: ['fails one', 'inner fails'], failingSuites: ['work-ui.mjs'], host: 'mac' });
  assert.match(body, /local-ci.*failed/i);
  assert.match(body, /Unit and contract tests/);
  assert.match(body, /- fails one\n- inner fails/);
  assert.match(body, /work-ui\.mjs/);
  assert.match(body, /failed twice/);
  // Only the steps that failed are named; nothing invented when no test names were found.
  const terse = failureComment({ failedSteps: ['Python syntax'], failingTests: [], failingSuites: [], host: 'mac' });
  assert.match(terse, /Python syntax/);
  assert.doesNotMatch(terse, /tests?:/i);
});

test('a suite that passed on retry gets a comment so the flake is tracked', async () => {
  const { retryComment } = await lib();
  const one = retryComment(['work-ui.mjs']);
  assert.match(one, /work-ui\.mjs/);
  assert.match(one, /passed on retry|passed when run again/i);
  assert.match(one, /green/i);
  const two = retryComment(['a-ui.mjs', 'b-ui.mjs']);
  assert.match(two, /a-ui\.mjs/); assert.match(two, /b-ui\.mjs/);
});

// PR titles become release notes (docs/DEPLOY.md). Long or multi-clause titles get one advisory comment; never a red.
test('release-note advice fires on long or multi-clause titles only', async () => {
  const { releaseNoteAdvice, RELEASE_NOTE_MARKER } = await lib();
  assert.equal(releaseNoteAdvice('Fix old Work image summaries where the count read as a width'), null);
  // 71 characters: one over.
  assert.ok(releaseNoteAdvice('Fix old image summaries in Work so the count no longer reads as a width'));
  assert.equal(releaseNoteAdvice('Short title'), null);
  assert.equal(releaseNoteAdvice('x'.repeat(70)), null);
  const long = releaseNoteAdvice('x'.repeat(71));
  assert.ok(long && long.startsWith(RELEASE_NOTE_MARKER));
  assert.match(long, /≤ 70 chars, one clause/);
  assert.ok(releaseNoteAdvice('Fix the header; also tidy the footer'));
  assert.ok(releaseNoteAdvice('Fix the header — and tidy the footer'));
  // A plain hyphen and an em dash with no spaces are not clause breaks.
  assert.equal(releaseNoteAdvice('Fix the drop-down and the footer—quickly'), null);
  assert.equal(releaseNoteAdvice(''), null);
  assert.equal(releaseNoteAdvice(undefined), null);
});

test('ship merges only the tested commit, and refuses anything else', async () => {
  const { shipMergeArgs } = await lib();
  const sha = 'a'.repeat(40);
  assert.deepEqual(shipMergeArgs(270, sha), ['pr', 'merge', '270', '--merge', '--match-head-commit', sha]);
  assert.throws(() => shipMergeArgs('270; rm -rf /', sha));
  assert.throws(() => shipMergeArgs(270, 'main'));
  assert.throws(() => shipMergeArgs(270, null));
});

// Ship re-checks against the newest main before it merges: two PRs green on their own can be red together.
test('ship merges when main has not moved, re-checks when it has, and gives up if it keeps moving', async () => {
  const { shipNextStep, MAX_RECHECKS } = await lib();
  const a = 'a'.repeat(40), b = 'b'.repeat(40);
  assert.equal(shipNextStep({ testedBase: a, latestBase: a }), 'merge');
  assert.equal(shipNextStep({ testedBase: a, latestBase: b }), 'recheck');
  assert.equal(shipNextStep({ testedBase: a, latestBase: b, rechecks: MAX_RECHECKS - 1 }), 'recheck');
  assert.equal(shipNextStep({ testedBase: a, latestBase: b, rechecks: MAX_RECHECKS }), 'give-up');
  // After a re-check, main where that re-check saw it means merge.
  assert.equal(shipNextStep({ testedBase: b, latestBase: b, rechecks: 1 }), 'merge');
  assert.throws(() => shipNextStep({ testedBase: null, latestBase: a }));
  assert.throws(() => shipNextStep({ testedBase: a, latestBase: '' }));
});

test('a green re-check lets ship merge', async () => {
  const { recheckOutcome } = await lib();
  assert.deepEqual(recheckOutcome({ base: 'main', failedSteps: [], failingTests: [] }), { ok: true });
});

test('a red re-check blocks the merge and names the failing tests', async () => {
  const { recheckOutcome } = await lib();
  const red = recheckOutcome({ base: 'main', failedSteps: ['Unit and contract tests'], failingTests: ['the app shell stays within its total download budget (gzipped)'], host: 'mac' });
  assert.equal(red.ok, false);
  assert.equal(red.state, 'failure');
  assert.equal(red.description, 'main moved; re-check failed: the app shell stays within its total download budget (gzipped)');
  assert.match(red.comment, /not merged/i);
  assert.match(red.comment, /- the app shell stays within its total download budget/);
  assert.match(red.comment, /Unit and contract tests/);
  // A red step with no test names (the deploy validator) is named instead.
  const validator = recheckOutcome({ base: 'main', failedSteps: ['Validate deployment candidate'] });
  assert.equal(validator.description, 'main moved; re-check failed: Validate deployment candidate');
  assert.doesNotMatch(validator.comment, /Failing/);
});

test('a conflict with the newer main blocks the merge', async () => {
  const { recheckOutcome } = await lib();
  const c = recheckOutcome({ base: 'main', conflict: true });
  assert.equal(c.ok, false);
  assert.equal(c.state, 'failure');
  assert.equal(c.description, 'main moved; re-check failed: conflicts with the newer main');
  assert.match(c.comment, /merge `main` into the branch/);
});

test('ship moves release only to a merge commit whose tree is the one it tested', async () => {
  const { releaseDecision, RELEASE_BRANCH } = await lib();
  const a = 'a'.repeat(40), b = 'b'.repeat(40);
  assert.equal(RELEASE_BRANCH, 'release');
  assert.deepEqual(releaseDecision({ testedTree: a, mergedTree: a }), { advance: true });
  assert.equal(releaseDecision({ testedTree: a, mergedTree: b }).advance, false);
  assert.match(releaseDecision({ testedTree: a, mergedTree: b }).reason, /did not test/);
  assert.equal(releaseDecision({ testedTree: '', mergedTree: a }).advance, false);
  assert.deepEqual(releaseDecision({ base: 'feat/x', testedTree: a, mergedTree: a }), { advance: false, reason: 'the PR merged into feat/x, not main' });
});

// A PR merged on GitHub without ship lands on main untested and never deploys; the next ship tests and releases it
// along with its own PR, and says so first, so a red run isn't blamed on the wrong PR.
test('mergedPrs reads the PR merges on main that release does not have yet, oldest first', async () => {
  const { mergedPrs } = await lib();
  const a = 'a'.repeat(40), b = 'b'.repeat(40), c = 'c'.repeat(40), d = 'd'.repeat(40), e = 'e'.repeat(40);
  const out = [
    `${c} ${a} ${d}|Merge pull request #408 from azmusgb/feat/home-needs-pi`,
    `${a} ${e} ${b}|Merge pull request #407 from azmusgb/fix/lab-usage-labels`,
    `${e} ${a}|Merge branch 'main' into x`,
  ].join('\n');
  assert.deepEqual(mergedPrs(out), [{ pr: 407, merge: a, head: b }, { pr: 408, merge: c, head: d }]);
  assert.deepEqual(mergedPrs(''), []);
});

test('unshippedNote names PRs merged without a green local-ci, never the one being shipped', async () => {
  const { unshippedNote } = await lib();
  assert.equal(unshippedNote([], 409, true), null);
  assert.equal(unshippedNote([{ pr: 406, green: true }], 409, true), null);
  assert.equal(unshippedNote([{ pr: 409, green: false }], 409, true), null);
  assert.equal(unshippedNote([{ pr: 407, green: false }, { pr: 408, green: false }, { pr: 406, green: true }], 409, true),
    'Note: #407 and #408 are on main but were never shipped (merged on GitHub without local CI). This run tests them with PR #409 and releases them too; if it fails, check whether the failure comes from them.');
  assert.equal(unshippedNote([{ pr: 407, green: false }], 409, false),
    'Note: #407 is on main but was never shipped (merged on GitHub without local CI). This run tests it with PR #409; if it fails, check whether the failure comes from it.');
  assert.equal(unshippedNote([{ pr: 1, green: false }, { pr: 2, green: false }, { pr: 3, green: false }], 9, true).slice(0, 26), 'Note: #1, #2 and #3 are on');
});
