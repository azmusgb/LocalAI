'use strict';

// The same check the quality scan runs on the live app ("DOM reference contract" in app/server.js,
// domReferenceFailures): every $('id') in app.js must be an id in index.html. Here it runs on every PR, so a page
// change that drops an element shows up before it reaches the appliance's issue list.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pub = path.resolve(__dirname, '../app/public');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(pub, 'app.js'), 'utf8');

test('every $(id) in app.js names an element in index.html', () => {
  const ids = new Set([...html.matchAll(/\bid=["']([^"']+)["']/g)].map(m => m[1]));
  const refs = new Set([...js.matchAll(/\$\(["']([^"']+)["']\)/g)].map(m => m[1]));
  assert.deepEqual([...refs].filter(id => !ids.has(id)), []);
});
