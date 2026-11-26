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
  const sites = caddy.split('\n').filter(l => /^https?:\/\//.test(l) && l.includes('LOCALAI_REMOTE_NAME'));
  assert.deepEqual(sites.map(l => l.split(':')[0]), ['https', 'http']);
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

// Caddy 2.10 sends *.ts.net names to the Tailscale daemon for certificates unless an automation policy names them;
// from inside Docker that daemon is unreachable and every handshake fails. The Tailscale site must stand alone with an
// explicit internal issuer (checked with caddy adapt/run 2.10: the shared `tls internal` site failed the handshake).
test('the Tailscale name has its own site with an explicit internal issuer', () => {
  const caddy = read('deploy/caddy/Caddyfile');
  const start = caddy.indexOf('https://{$LOCALAI_REMOTE_NAME');
  assert.ok(start > 0);
  const header = caddy.slice(start, caddy.indexOf('\n', start));
  assert.equal(header.split(',').length, 1, 'no other names share the Tailscale site');
  const block = caddy.slice(start, caddy.indexOf('\n}\n', start));
  assert.match(block, /tls \{\s*issuer internal \{\s*lifetime 12h\s*\}\s*\}/);
  const shared = caddy.slice(caddy.indexOf('https://{$LOCALAI_NAME}'), caddy.indexOf('\n}\n', caddy.indexOf('https://{$LOCALAI_NAME}')));
  assert.doesNotMatch(shared, /LOCALAI_REMOTE_NAME/);
});

// 17 Oct: each deploy gave a few seconds of 502 ("dial tcp: lookup local-ai-appliance ... failed") while the appliance
// was recreated. The proxy waits and retries, then says "updating" (JSON for the API) instead of an error.
test('the HTTPS front end rides over an appliance restart', () => {
  const caddy = read('deploy/caddy/Caddyfile');
  const proxy = /reverse_proxy local-ai-appliance:3080 \{([^}]*)\}/.exec(caddy);
  assert.ok(proxy, 'reverse_proxy block');
  const secs = v => Number(/^(\d+)s$/.exec(v)?.[1] ?? /^(\d+)ms$/.exec(v)?.[1] / 1000);
  const tryFor = /lb_try_duration (\S+)/.exec(proxy[1]), every = /lb_try_interval (\S+)/.exec(proxy[1]);
  assert.ok(tryFor && secs(tryFor[1]) >= 15 && secs(tryFor[1]) <= 30, `lb_try_duration ${tryFor && tryFor[1]}`);
  assert.ok(every && secs(every[1]) > 0 && secs(every[1]) <= 2, `lb_try_interval ${every && every[1]}`);
  assert.match(proxy[1], /flush_interval -1/, 'streams still pass straight through');
  // Both appliance sites (LAN and Tailscale) import the snippet that carries the retry and the "updating" answers.
  const appliance = caddy.slice(caddy.indexOf('(appliance) {'), caddy.indexOf('\n}\n', caddy.indexOf('(appliance) {')));
  assert.match(appliance, /import updating/);
  assert.equal((caddy.match(/^\s*import appliance$/gm) || []).length, 2);
  const updating = caddy.slice(caddy.indexOf('(updating) {'), caddy.indexOf('\n}\n', caddy.indexOf('(updating) {')));
  assert.match(updating, /handle_errors 502 503 504 \{/);
  assert.match(updating, /header Retry-After \d+/);
  assert.match(updating, /@api path \/api\/\* \/healthz/);
  assert.match(updating, /header Content-Type application\/json\s+respond `\{"error":"Local AI is updating","updating":true\}` 503/);
  assert.match(updating, /<meta http-equiv="refresh" content="\d+">/);
  assert.match(updating, /Local AI is updating, back in a moment/);
  // Caddy fills {placeholders} in a response body; the page must have no braces of its own.
  const html = /respond `(<!doctype[^`]*)`/.exec(updating)[1];
  assert.doesNotMatch(html, /[{}]/);
});

// /healthz lists the addresses a phone can switch to; the appliance needs both the LAN IP and the Tailscale name.
test('the appliance gets the host IP and the Tailscale name from stack.env', () => {
  const compose = read('deploy/stack/compose.yml');
  const appliance = compose.slice(compose.indexOf('\n  appliance:'), compose.indexOf('\n  https:'));
  assert.match(appliance, /LOCALAI_REMOTE_NAME: \$\{LOCALAI_REMOTE_NAME:-\}/);
  assert.match(appliance, /LOCALAI_HOST_IP: \$\{LOCALAI_HOST_IP:-\}/);
});

// 25 Nov: Caddy sent every file uncompressed, so ui.js went out at ~380 KB while tests/budgets.test.cjs budgets the
// shell gzipped. Caddy's default encode list takes text/*, which includes text/event-stream (checked with caddy 2.11:
// the SSE answer came back Content-Encoding: zstd), so the type list must be explicit and leave streams out.
test('the HTTPS front end compresses the app shell and API answers but never event streams', () => {
  const caddy = read('deploy/caddy/Caddyfile');
  const start = caddy.indexOf('(appliance) {');
  const appliance = caddy.slice(start, caddy.indexOf('\n}\n', start));
  const encode = /\n\tencode \{\n([\s\S]*?)\n\t\}\n/.exec(appliance);
  assert.ok(encode, 'the appliance snippet (both sites) has an encode block');
  assert.match(encode[1], /^\t\tzstd$/m);
  assert.match(encode[1], /^\t\tgzip$/m);
  const types = [...encode[1].matchAll(/^\t\t\theader Content-Type (\S+)$/gm)].map(m => m[1]);
  for (const t of ['text/html*', 'text/css*', 'application/javascript*', 'application/json*', 'image/svg+xml*']) {
    assert.ok(types.includes(t), `compresses ${t}`);
  }
  // Every match line is one Content-Type value (a line with several values fails to adapt in caddy 2.10/2.11).
  const matchLines = encode[1].split('\n').filter(l => /^\t\t\t\S/.test(l));
  assert.equal(matchLines.length, types.length, 'only single-value Content-Type lines in the match block');
  for (const t of types) {
    assert.ok(!'text/event-stream'.startsWith(t.replace(/\*$/, '')), `${t} would match text/event-stream`);
    assert.notEqual(t, '*');
  }
  // The proxy still flushes at once, so the uncompressed streams arrive event by event.
  assert.match(appliance, /flush_interval -1/);
});
