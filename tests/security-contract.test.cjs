'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'app', 'server.js'), 'utf8');
const hostRunner = fs.readFileSync(path.join(root, 'host', 'powershell-bridge', 'Run-LocalAI-PowerShellHost.ps1'), 'utf8');
const bridge = fs.readFileSync(path.join(root, 'host', 'gridcraft-bridge.py'), 'utf8');

test('child processes never inherit the appliance environment wholesale', () => {
  assert.doesNotMatch(server, /env:\s*\{\s*\.\.\.process\.env/);
  const start = server.indexOf('const SECRET_ENV=');
  assert.ok(start > 0, 'SECRET_ENV filter missing');
  const factory = new Function(`${server.slice(start, server.indexOf('function allowedCommand', start))}; return childEnv;`);
  process.env.POWERSHELL_UI_TOKEN = 'ui-secret';
  process.env.POWERSHELL_BRIDGE_TOKEN = 'bridge-secret';
  process.env.SOME_API_KEY = 'k';
  const env = factory()({ CI: '1' });
  assert.equal(env.POWERSHELL_UI_TOKEN, undefined);
  assert.equal(env.POWERSHELL_BRIDGE_TOKEN, undefined);
  assert.equal(env.SOME_API_KEY, undefined);
  assert.equal(env.CI, '1');
  assert.equal(env.PATH, process.env.PATH);
});

test('PowerShell jobs need a signature that only the Windows host verifies', () => {
  assert.match(server, /approval signature is required/);
  assert.match(server, /signature:item\.approvalSignature/);
  assert.match(hostRunner, /Test-JobSignature \$job/);
  assert.match(hostRunner, /localai-ps-v1/);
});

test('GridCraft bridge rejects cross-site and non-JSON posts and runs the agent in UTF-8', () => {
  assert.match(bridge, /Origin not allowed/);
  assert.match(bridge, /Content-Type must be application\/json/);
  assert.match(bridge, /'PYTHONUTF8': '1'/);
});
