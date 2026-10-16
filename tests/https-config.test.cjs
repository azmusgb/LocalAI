'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

// An empty Caddy site address drops every host match (checked with `caddy adapt` 2.10), so the Tailscale name must
// always reach Caddy as a name: a default in the Caddyfile, in compose, and in the installer.
test('the Tailscale site address can never be empty', () => {
  const caddy = read('deploy/caddy/Caddyfile');
  const sites = caddy.split('\n').filter(l => /^https?:\/\//.test(l));
  assert.equal(sites.length, 2);
  for (const line of sites) assert.match(line, /\{\$LOCALAI_REMOTE_NAME:localai\.remote\.invalid\}/, line);
  const compose = read('deploy/stack/compose.yml');
  const https = compose.slice(compose.indexOf('\n  https:'), compose.indexOf('\n  n8n:'));
  assert.match(https, /LOCALAI_REMOTE_NAME: \$\{LOCALAI_REMOTE_NAME:-localai\.remote\.invalid\}/);
  const installer = read('deploy/Install-LocalAI-HTTPS.ps1');
  assert.match(installer, /-e "LOCALAI_REMOTE_NAME=\$remoteSite"/);
  assert.match(installer, /\$remoteSite = if \(\$RemoteName\) \{ \$RemoteName \} else \{ 'localai\.remote\.invalid' \}/);
});

test('the Tailscale firewall rule admits only Tailscale addresses', () => {
  const installer = read('deploy/Install-LocalAI-HTTPS.ps1');
  const rule = installer.split('\n').find(l => l.includes("'Local AI HTTPS (Tailscale)'") && l.includes('New-NetFirewallRule'));
  assert.ok(rule, 'rule exists');
  assert.match(rule, /-RemoteAddress 100\.64\.0\.0\/10/);
  assert.match(rule, /-LocalPort 80,443/);
});

test('on a compose host the installer updates stack.env and lets compose recreate Caddy and the appliance', () => {
  const installer = read('deploy/Install-LocalAI-HTTPS.ps1');
  assert.match(installer, /\$labels\.'com\.docker\.compose\.project' -eq 'local-ai'/);
  assert.match(installer, /Set-StackEnv \$stackEnv @\{ LOCALAI_HOST_IP = \$HostIp; LOCALAI_NAME = \$Name; LOCALAI_REMOTE_NAME = \$RemoteName \}/);
  assert.match(installer, /Invoke-Docker compose --env-file \$stackEnv -f \$compose up -d https appliance/);
  // A fresh Tailscale install is not on PATH yet, and only a signed-in node's name is usable.
  assert.match(installer, /\$env:ProgramFiles\\Tailscale\\tailscale\.exe/);
  assert.match(installer, /BackendState -eq 'Running'/);
});
