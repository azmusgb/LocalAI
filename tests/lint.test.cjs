// ESLint over the whole repo (eslint.config.mjs): fails on any error, so `npm test` is the lint guard while CI is
// unavailable. eslint is a devDependency; where it isn't installed (a deploy candidate checked without
// devDependencies) the test skips instead of failing. deploy/Test-LocalAI-Candidate.ps1 runs a fixed $nativeTests
// list that doesn't include this file.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const root = path.join(__dirname, '..');
let ESLint = null;
try { ({ ESLint } = require(require.resolve('eslint', { paths: [root] }))); } catch {}

test('eslint reports no errors', { timeout: 120000, skip: ESLint ? false : 'eslint is not installed (run npm ci to install devDependencies); lint skipped' }, async () => {
  const eslint = new ESLint({ cwd: root });
  const results = await eslint.lintFiles(['.']);
  const errors = results.filter(r => r.errorCount > 0);
  const text = errors.length ? (await eslint.loadFormatter('stylish')).format(errors) : '';
  assert.equal(errors.reduce((n, r) => n + r.errorCount, 0), 0, `eslint found errors (npm run lint):\n${text}`);
});
