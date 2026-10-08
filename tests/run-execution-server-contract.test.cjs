'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.resolve(__dirname, '../app/server.js'), 'utf8');

test('server initializes the durable unified run ledger', () => {
  assert.match(server, /require\('\.\/run-ledger'\)/);
  assert.match(server, /new RunLedger\(\{ storage \}\)/);
  assert.match(server, /const activeRunControllers = new Map\(\)/);
});

test('server exposes unified run read, cancel, and retry endpoints', () => {
  assert.match(server, /p === '\/api\/runs'/);
  assert.match(server, /p === '\/api\/runs\/cancel'/);
  assert.match(server, /p === '\/api\/runs\/retry'/);
  assert.match(server, /async function apiRuns/);
  assert.match(server, /async function apiRunCancel/);
  assert.match(server, /async function apiRunRetry/);
});

test('chat and image execution paths publish run IDs and terminal state', () => {
  assert.match(server, /createChatExecution\(body, false\)/);
  assert.match(server, /createChatExecution\(body, true\)/);
  assert.match(server, /activeRunControllers\.set\(execution\.id, controller\)/);
  assert.match(server, /runLedger\.stream\(execution\.id/);
  assert.match(server, /runLedger\.complete\(execution\.id/);
  assert.match(server, /runLedger\.fail\(execution\.id/);
  assert.match(server, /runId: execution\.id/);
  assert.match(server, /type: 'image'/);
});

test('legacy execution histories are normalized instead of discarded', () => {
  assert.match(server, /function legacyUnifiedRuns/);
  assert.match(server, /legacy-agent:/);
  assert.match(server, /legacy-automation:/);
  assert.match(server, /legacy-engineering:/);
  assert.match(server, /effectiveEngineeringRuns\(\)/);
  assert.match(server, /automationRunStore\(\)/);
  assert.match(server, /agentRunStore\(\)/);
});

test('retry is explicitly allowlisted and engineering remains approval-driven', () => {
  assert.match(server, /new Set\(\['\/api\/chat','\/api\/images\/generate','\/api\/agents\/run','\/api\/automations\/run'\]\)/);
  assert.doesNotMatch(server, /new Set\([^\n]*\/api\/engineering/);
  assert.match(server, /This run does not support retry/);
});
