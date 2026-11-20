const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Extract and test the validation logic
const workbenchSrc = fs.readFileSync(path.join(__dirname, '../app/server/workbench.js'), 'utf8');

// Test via evaluating isolated functions
const net = require('net');
const dns = require('dns');

test('validateExternalUrl blocks loopback, private RFC1918, and tailnet addresses', async () => {
  // Extract isPrivateIp and validateExternalUrl
  const fnMatch = workbenchSrc.match(/function isPrivateIp[\s\S]*?async function validateExternalUrl[\s\S]*?\n {2}\}/);
  assert.ok(fnMatch, 'Found validation functions');
  
  const evalScope = new Function('net', 'dns', `${fnMatch[0]}; return { isPrivateIp, validateExternalUrl };`);
  const { isPrivateIp, validateExternalUrl } = evalScope(net, dns);

  // Private IPs
  assert.equal(isPrivateIp('127.0.0.1'), true);
  assert.equal(isPrivateIp('10.0.1.5'), true);
  assert.equal(isPrivateIp('172.16.0.1'), true);
  assert.equal(isPrivateIp('192.168.1.1'), true);
  assert.equal(isPrivateIp('100.80.0.5'), true); // Tailscale/CGNAT
  assert.equal(isPrivateIp('169.254.1.1'), true); // Link local
  assert.equal(isPrivateIp('::1'), true);
  assert.equal(isPrivateIp('fe80::1'), true);
  assert.equal(isPrivateIp('8.8.8.8'), false);
  assert.equal(isPrivateIp('1.1.1.1'), false);

  // Direct IP URL checks
  await assert.rejects(async () => await validateExternalUrl('http://127.0.0.1/test'), /blocked/);
  await assert.rejects(async () => await validateExternalUrl('http://192.168.1.1/admin'), /blocked/);
  await assert.rejects(async () => await validateExternalUrl('http://10.0.0.1:8080'), /blocked/);
  await assert.rejects(async () => await validateExternalUrl('http://localhost:3000'), /blocked/);

  // Allowed public URL
  const u = await validateExternalUrl('https://example.com');
  assert.equal(u.hostname, 'example.com');
});
