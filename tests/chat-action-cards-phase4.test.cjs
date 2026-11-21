'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('run-bodies.js implements Amendment A30 Phase 4 action proposal cards', () => {
  const code = fs.readFileSync(path.join(__dirname, '../app/public/run-bodies.js'), 'utf8');

  // Verify action proposal logic and UI result card pattern
  assert.ok(code.includes('ui-result-card run-action-proposal'), 'uses ui-result-card for action proposals');
  assert.ok(code.includes('Confirm on Pi Hub ↗'), 'button links to confirmation on Pi Hub');
  assert.ok(code.includes('source_run='), 'carries run id in source_run parameter for audit');

  // Verify dangerous action styling
  assert.ok(code.includes("action.danger ? 'ui-btn--danger' : 'ui-btn--primary'"), 'dangerous actions use ui-btn--danger');

  // Verify printer vs system routing
  assert.ok(code.includes('/workshop'), 'printer actions target /workshop');
  assert.ok(code.includes('/system#fixes'), 'system fix actions target /system#fixes');

  // Verify detection of proposed actions
  assert.ok(code.includes('restart:plex') && code.includes('restart:pi') && code.includes('pause'), 'lists standard Pi Hub actions');
});
