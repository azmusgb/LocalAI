'use strict';
// A <dialog> sheet is opened with LocalAIUI.showSheet (components.js), never with its own showModal() and 'close' listener.
// The close event is queued, so a sheet closed and opened again in the same task gets the old opening's close event while the
// new one shows; a hand-written listener then released the new sheet's Back entry (home, Improve and run details sheets did).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pub = path.join(__dirname, '..', 'app', 'public');
// components.js owns showSheet, and its ask() and approvalSheet() build a new <dialog> for every opening (removed on close).
const OWNER = 'components.js';
const files = fs.readdirSync(pub).filter(f => f.endsWith('.js') && f !== OWNER);

const lines = f => fs.readFileSync(path.join(pub, f), 'utf8').split('\n');
const where = (re) => files.flatMap(f => lines(f).flatMap((l, i) => re.test(l) ? [`${f}:${i + 1}`] : []));

test('only components.js listens for a dialog close event', () => {
  assert.deepEqual(where(/addEventListener\(\s*['"]close['"]/), [], 'open the sheet with LocalAIUI.showSheet(d, onClosed) and do the clean-up in onClosed');
});

test('a <dialog> with a Back entry is opened with showSheet, not showModal() + sheetHistory()', () => {
  // The command palette (app.js) uses showModal() with no Back entry and no close listener, so it is not a sheet.
  const both = files.filter(f => lines(f).some(l => /\.showModal\s*\(/.test(l)) && lines(f).some(l => /sheetHistory\s*(\?\.)?\(/.test(l)));
  assert.deepEqual(both, [], 'use LocalAIUI.showSheet(d, onClosed)');
});
