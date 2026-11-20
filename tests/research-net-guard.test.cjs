'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { GuardError, isBlockedAddress, checkUrl, vetHost } = require('../app/research/net-guard');

const code = fn => { try { fn(); } catch (e) { assert.ok(e instanceof GuardError); return e.code; } return 'no error'; };
const allow = { allowHosts: ['example.com'] };

test('blocked ranges', () => {
  for (const ip of ['0.0.0.1', '10.0.0.80', '100.64.0.1', '100.109.178.34', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255',
    '192.0.0.1', '192.168.1.1', '198.18.0.1', '224.0.0.1', '255.255.255.255', '::', '::1', 'fc00::1', 'fd12::1', 'fe80::1', 'ff02::1',
    '::ffff:10.0.0.80', '::ffff:127.0.0.1', 'not-an-ip', '']) assert.equal(isBlockedAddress(ip), true, ip);
});
test('public addresses pass', () => {
  for (const ip of ['1.1.1.1', '93.184.216.34', '172.32.0.1', '100.128.0.1', '2606:4700::1111', '::ffff:1.1.1.1']) assert.equal(isBlockedAddress(ip), false, ip);
});
test('checkUrl refuses what it must', () => {
  assert.equal(code(() => checkUrl('not a url', allow)), 'bad_url');
  assert.equal(code(() => checkUrl('http://example.com/feed', allow)), 'bad_scheme');
  assert.equal(code(() => checkUrl('file:///etc/passwd', allow)), 'bad_scheme');
  assert.equal(code(() => checkUrl('https://example.com:8443/feed', allow)), 'bad_port');
  assert.equal(code(() => checkUrl('https://user:pw@example.com/feed', allow)), 'bad_url');
  assert.equal(code(() => checkUrl('https://other.com/feed', allow)), 'host_not_allowed');
  assert.equal(code(() => checkUrl('https://sub.example.com/feed', allow)), 'host_not_allowed');
});
test('checkUrl refuses numeric and literal hosts even when listed', () => {
  for (const u of ['https://2130706433/', 'https://127.1/', 'https://0x7f000001/', 'https://10.0.0.80/', 'https://[::1]/', 'https://[::ffff:10.0.0.80]/'])
    assert.equal(code(() => checkUrl(u, { allowHosts: [new URL(u).hostname] })), 'ip_literal', u);
});
test('checkUrl normalises case and a trailing dot', () => {
  assert.equal(checkUrl('https://EXAMPLE.com./feed', allow).hostname, 'example.com');
  assert.equal(checkUrl('https://example.com:443/feed', allow).port, '');
});
test('vetHost refuses when any address is blocked', async () => {
  const mixed = async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.80', family: 4 }];
  await assert.rejects(vetHost('example.com', { lookup: mixed }), e => e.code === 'blocked_address');
  await assert.rejects(vetHost('example.com', { lookup: async () => [] }), e => e.code === 'dns_failed');
  await assert.rejects(vetHost('example.com', { lookup: async () => { throw new Error('ENOTFOUND'); } }), e => e.code === 'dns_failed');
  assert.deepEqual(await vetHost('example.com', { lookup: async () => [{ address: '93.184.216.34', family: 4 }] }), [{ address: '93.184.216.34', family: 4 }]);
});
test('IPv6 forms that embed or hide an IPv4', () => {
  for (const ip of ['::ffff:7f00:1', '0:0:0:0:0:ffff:10.0.0.80', '::FFFF:10.0.0.80', '::10.0.0.80', '::7f00:1', '::ffff:0:10.0.0.80',
    '64:ff9b::10.0.0.80', '64:ff9b::a00:50', '64:ff9b:1::1', '2002:0a00:0050::1', '2002:7f00:0001::', '2001::1',
    '2001:0:4136:e378:8000:63bf:3fff:fdd2', '2001:db8::1', '100::1', 'fec0::1', '4000::1', '::2', 'fe80::1%eth0']) assert.equal(isBlockedAddress(ip), true, ip);
  for (const ip of ['2606:4700::1111', '2001:4860:4860::8888', '::ffff:1.1.1.1', '::ffff:101:101', '64:ff9b::1.1.1.1', '2002:0101:0101::1'])
    assert.equal(isBlockedAddress(ip), false, ip);
});
