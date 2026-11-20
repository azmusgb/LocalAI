'use strict';

// Decides whether a URL, and the addresses its host resolves to, may be contacted by research intake.
// https only, port 443 only, host on the owner's allow list (exact match), never an IP literal, and
// every resolved address must be public: if any one is blocked the host is refused.

const net = require('node:net');
const dns = require('node:dns');

class GuardError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'GuardError';
    this.code = code;
  }
}

const BLOCKED = new net.BlockList();
for (const [prefix, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]]) BLOCKED.addSubnet(prefix, bits, 'ipv4');
BLOCKED.addAddress('::', 'ipv6');
BLOCKED.addAddress('::1', 'ipv6');
for (const [prefix, bits] of [['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) BLOCKED.addSubnet(prefix, bits, 'ipv6');

// The IPv4 part of an IPv4-mapped IPv6 address (dotted or hex form), else null.
function mappedV4(ip) {
  const s = ip.toLowerCase();
  let m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (m) return m[1];
  m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(s);
  if (!m) return null;
  const hi = parseInt(m[1], 16), lo = parseInt(m[2], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

function isBlockedAddress(ip) {
  if (typeof ip !== 'string') return true;
  const family = net.isIP(ip);
  if (family === 0) return true;
  try {
    if (family === 4) return BLOCKED.check(ip, 'ipv4');
    const v4 = mappedV4(ip);
    return v4 ? BLOCKED.check(v4, 'ipv4') : BLOCKED.check(ip, 'ipv6');
  } catch {
    return true;
  }
}

function checkUrl(url, { allowHosts } = {}) {
  let u;
  try { u = new URL(url); } catch { throw new GuardError('bad_url', 'not a valid URL'); }
  if (u.protocol !== 'https:') throw new GuardError('bad_scheme', 'only https is allowed');
  if (u.username || u.password) throw new GuardError('bad_url', 'credentials in a URL are not allowed');
  if (u.port && u.port !== '443') throw new GuardError('bad_port', 'only port 443 is allowed');
  if (net.isIP(u.hostname.replace(/^\[|\]$/g, '')) !== 0) throw new GuardError('ip_literal', 'an IP address is not a host name');
  u.hostname = u.hostname.toLowerCase().replace(/\.$/, '');
  const allowed = Array.isArray(allowHosts) ? allowHosts.map(h => String(h).toLowerCase().replace(/\.$/, '')) : [];
  if (!u.hostname || !allowed.includes(u.hostname)) throw new GuardError('host_not_allowed', 'host is not on the allow list');
  return u;
}

async function vetHost(hostname, { lookup = host => dns.promises.lookup(host, { all: true }) } = {}) {
  let results;
  try { results = await lookup(hostname, { all: true }); } catch { throw new GuardError('dns_failed', 'host did not resolve'); }
  if (!Array.isArray(results) || !results.length) throw new GuardError('dns_failed', 'host did not resolve');
  if (results.some(r => !r || isBlockedAddress(r.address))) throw new GuardError('blocked_address', 'host resolves to a blocked address');
  return results.map(r => ({ address: r.address, family: r.family }));
}

module.exports = { GuardError, isBlockedAddress, checkUrl, vetHost };
