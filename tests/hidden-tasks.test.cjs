'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Scheduled tasks that run in the owner's session must not flash a console window: powershell.exe opens one even
// with -WindowStyle Hidden, so each installer starts PowerShell through conhost --headless.
const INSTALLERS = ['host/powershell-bridge/Enable-LocalAI-PowerShellHost.ps1', 'deploy/Install-LocalAI-DeployAgent.ps1', 'deploy/Install-LocalAI-Backup.ps1'];

for (const file of INSTALLERS) {
  test(`${file} starts its task through conhost --headless`, () => {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const actions = src.split('\n').filter(l => /New-ScheduledTaskAction/.test(l));
    assert.ok(actions.length > 0, 'no scheduled task action found');
    for (const line of actions) {
      assert.match(line, /-Execute 'conhost\.exe'/, line.trim());
      assert.match(line, /--headless/, line.trim());
    }
  });
}
