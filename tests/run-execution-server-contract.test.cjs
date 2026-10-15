'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.resolve(__dirname, '../app/server.js'), 'utf8');

function functionSource(name, nextName = '') {
  const start = server.indexOf(`async function ${name}`);
  assert.ok(start >= 0, `${name} must exist`);
  if (!nextName) return server.slice(start);
  const end = server.indexOf(`async function ${nextName}`, start + 1);
  assert.ok(end > start, `${nextName} must follow ${name}`);
  return server.slice(start, end);
}

test('server initializes the durable unified run ledger', () => {
  assert.match(server, /require\('\.\/run-ledger'\)/);
  assert.match(server, /new RunLedger\(\{ storage[ ,]/);
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

test('streaming cancellation is armed before preparatory work and propagates into research fetches', () => {
  const stream = functionSource('apiChatStream', 'apiGenerateImage');
  const register = stream.indexOf('activeRunControllers.set(execution.id, controller)');
  const prepare = stream.indexOf('await prepareChat(body, controller.signal)');
  assert.ok(register >= 0, 'stream controller must be registered');
  assert.ok(prepare >= 0, 'stream preparation must receive the controller signal');
  assert.ok(register < prepare, 'controller registration must happen before chat preparation');
  assert.match(stream, /controller\.signal\.aborted \|\| runLedger\.get\(execution\.id\)\?\.status === 'cancelled'/);
  assert.match(server, /searxSearch\(lastUser\.content, signal\)/);
  assert.match(server, /fetchWithTimeout\(u\.toString\(\), \{ signal \}, 8000\)/);
  assert.match(server, /externalSignal\?\.addEventListener\('abort', abortFromExternal, \{ once: true \}\)/);
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

test('retry preserves parent lineage and increments attempts for native and legacy runs', () => {
  const retry = functionSource('apiRunRetry');
  assert.match(retry, /const nextAttempt = Math\.max\(1, Number\(parent\?\.attempt\) \|\| 1\) \+ 1/);
  assert.match(retry, /runLedger\.update\(result\.runId, \{ attempt: nextAttempt, retryOf: id \}/);
  assert.match(retry, /retry\.attempt = nextAttempt/);
  assert.match(retry, /retry\.retryOf = id/);
  assert.match(retry, /newRunId = 'legacy-agent:' \+ retry\.id/);
  assert.match(retry, /newRunId = 'legacy-automation:' \+ retry\.id/);
  assert.match(server, /attempt: Number\.isSafeInteger\(Number\(run\.attempt\)\)/);
  assert.match(server, /retryOf: run\.retryOf \|\| null/);
});
