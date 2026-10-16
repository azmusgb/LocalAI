'use strict';

// Runs stylelint (correctness rules only, see .stylelintrc.json) over the app's stylesheets.
// stylelint is a devDependency. The deploy validator (deploy/Test-LocalAI-Candidate.ps1) runs its own short list of
// tests and installs no npm packages, and a checkout without `npm ci` has no node_modules, so when stylelint is not
// installed this test skips with a note instead of failing.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
let installed = true;
try { require.resolve('stylelint/package.json', { paths: [root] }); } catch { installed = false; }

test('app stylesheets pass stylelint', { skip: installed ? false : 'stylelint is not installed (run npm ci); skipping the CSS lint' }, async () => {
  const { default: stylelint } = await import('stylelint');
  const dir = path.join(root, 'app', 'public');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.css')).map(f => path.join(dir, f));
  assert.ok(files.length > 0, 'no stylesheets found');
  const { results } = await stylelint.lint({ files, configFile: path.join(root, '.stylelintrc.json'), cwd: root });
  const problems = results.flatMap(r => [...r.parseErrors, ...r.warnings, ...r.invalidOptionWarnings].map(w => `${path.relative(root, r.source)}:${w.line || ''}:${w.column || ''} ${w.text}`));
  assert.deepEqual(problems, [], `stylelint found problems:\n${problems.join('\n')}`);
});

// The config must actually catch what it is for.
test('the stylelint config catches an invalid hex, an unknown property and a duplicate', { skip: installed ? false : 'stylelint is not installed' }, async () => {
  const { default: stylelint } = await import('stylelint');
  const { results } = await stylelint.lint({ code: '.a{color:#ggg;colr:red;margin:0;padding:0;margin:1px}', configFile: path.join(root, '.stylelintrc.json'), cwd: root });
  const rules = new Set(results[0].warnings.map(w => w.rule));
  for (const r of ['color-no-invalid-hex', 'property-no-unknown', 'declaration-block-no-duplicate-properties']) assert.ok(rules.has(r), `${r} did not fire`);
});
