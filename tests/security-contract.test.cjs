'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const server = require('./server-source.cjs').serverSource(); // server.js and app/server/*.js
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

test('the Windows host runs each signed PowerShell job once, from its own ledger, and stops the whole tree on timeout', () => {
  assert.match(hostRunner, /ran-jobs\.txt/);
  const check = hostRunner.indexOf('Test-JobAlreadyRan ([string]$job.id)');
  const record = hostRunner.indexOf('Add-RanJob ([string]$job.id)');
  const start = hostRunner.indexOf("Start-Process -FilePath 'powershell.exe'");
  assert.ok(hostRunner.indexOf('Test-JobSignature $job') < check && check < record && record < start, 'signature, then the ledger check, then the record, then the run');
  assert.match(hostRunner, /taskkill\.exe \/PID \$proc\.Id \/T \/F/);
});

test('GridCraft bridge rejects cross-site and non-JSON posts and runs the agent in UTF-8', () => {
  assert.match(bridge, /Origin not allowed/);
  assert.match(bridge, /Content-Type must be application\/json/);
  assert.match(bridge, /'PYTHONUTF8': '1'/);
});

test('the browser app never calls native confirm() or prompt()', () => {
  const dir = path.join(root, 'app', 'public');
  const re = /(^|[^.\w])(window\.)?(confirm|prompt)\(/m;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
  assert.ok(files.includes('app.js'));
  for (const f of files) assert.doesNotMatch(fs.readFileSync(path.join(dir, f), 'utf8'), re, `${f} uses a native dialog; use LocalAIUI.ask`);
  assert.ok(re.test('if(!confirm(x))'), 'regex catches confirm(');
  assert.ok(!re.test('await LocalAIUI.ask({})') && !re.test('x.confirm(1)') && !re.test('onConfirm(1)'), 'regex ignores ask( and methods');
});
