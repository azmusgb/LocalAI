'use strict';

// Every exact route app/server.js answers (p === '/api/...') should be named in at least one test. Atlas cannot see
// route-level coverage, so this is the measure. tests/route-coverage.allow.json lists the routes with no test today:
// a new untested route fails here, and so does an allowed route that has since gained a test (remove it from the list).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.resolve(__dirname, '../app');
const TESTS = __dirname;
const SELF = path.basename(__filename);

const routes = [...new Set([...fs.readFileSync(path.join(APP, 'server.js'), 'utf8').matchAll(/p === '(\/api\/[^']*)'/g)].map(m => m[1]))].sort();
const allowed = JSON.parse(fs.readFileSync(path.join(TESTS, 'route-coverage.allow.json'), 'utf8'));
const testText = fs.readdirSync(TESTS)
  .filter(f => /\.(cjs|mjs|js)$/.test(f) && f !== SELF)
  .map(f => fs.readFileSync(path.join(TESTS, f), 'utf8'))
  .join('\n');
const untested = routes.filter(r => !testText.includes(r));

test('server.js routes are found', () => {
  assert.ok(routes.length >= 100, `found only ${routes.length} routes in app/server.js`);
});

test('every route is named in a test or listed in route-coverage.allow.json', () => {
  const fresh = untested.filter(r => !allowed.includes(r));
  assert.deepEqual(fresh, [], `no test names these routes: add a test, or list them in tests/route-coverage.allow.json`);
});

test('route-coverage.allow.json lists only routes that exist and are still untested', () => {
  const stale = allowed.filter(r => !routes.includes(r) || !untested.includes(r));
  assert.deepEqual(stale, [], 'remove these from tests/route-coverage.allow.json');
});
