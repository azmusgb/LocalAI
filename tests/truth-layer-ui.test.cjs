const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const sourcePath = path.resolve(__dirname, '../app/public/ui.js');
const source = fs.readFileSync(sourcePath, 'utf8');

test('truth layer browser bundle parses as JavaScript', () => {
  assert.doesNotThrow(() => new vm.Script(source, { filename: sourcePath }));
});

test('truth layer consumes the authoritative capability registry', () => {
  assert.match(source, /fetch\('\/api\/capabilities'/);
  assert.match(source, /cache:\s*'no-store'/);
  assert.match(source, /service\(snapshot, name\)/);
});

test('truth layer gates user-visible modes from live capabilities', () => {
  for (const mode of ['ask', 'research', 'create', 'automate', 'engineering']) {
    assert.match(source, new RegExp(`gateMode\\('${mode}'`));
  }
  assert.match(source, /dataset\.truthDisabled/);
  assert.match(source, /aria-disabled/);
});

test('truth layer exposes actionable attention state', () => {
  assert.match(source, /truthAttention/);
  assert.match(source, /attentionItems\(snapshot\)/);
  assert.match(source, /Open Health/);
  assert.match(source, /Open approvals/);
  assert.match(source, /Open Signals/);
});
