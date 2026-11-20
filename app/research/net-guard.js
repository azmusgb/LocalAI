'use strict';

// Decides whether a URL, and the addresses its host resolves to, may be contacted by research intake.
// https only, port 443 only, host on the owner's allow list (exact match), never an IP literal, and
// every resolved address must be public: if any one is blocked the host is refused.

const net = require('node:net');
const dns = require('node:dns');
const { domainToASCII } = require('node:url');

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
// IPv6 is allow-list based: an address is public only if it is global unicast (2000::/3) and is neither a reserved
// block nor a form that carries an IPv4 address, which is then judged by the IPv4 list.
const BLOCKED_V6 = new net.BlockList();
for (const [prefix, bits] of [['64:ff9b:1::', 48], ['2001::', 32], ['2001:db8::', 32], ['100::', 64], ['fec0::', 10],
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) BLOCKED_V6.addSubnet(prefix, bits, 'ipv6');

// The 16 bytes of an IPv6 address, or null when it is not a plain IPv6 address (a zone id is refused too).
function v6Bytes(ip) {
  if (net.isIP(ip) !== 6 || ip.includes('%')) return null;
  let host;
  try { host = new URL(`http://[${ip}]/`).hostname.slice(1, -1); } catch { return null; }
  const [head, tail] = host.split('::');
  const part = t => (t ? t.split(':').map(g => parseInt(g, 16)) : []);
  const h = part(head), t = tail === undefined ? [] : part(tail);
  const groups = tail === undefined ? h : [...h, ...new Array(8 - h.length - t.length).fill(0), ...t];
  if (groups.length !== 8 || groups.some(g => !Number.isInteger(g))) return null;
  return groups.flatMap(g => [g >> 8, g & 255]);
}

const zero = (b, from, to) => b.slice(from, to).every(x => x === 0);
const dotted = (b, at) => b.slice(at, at + 4).join('.');

function isBlockedV6(ip) {
  const b = v6Bytes(ip);
  if (!b) return true;
  if (zero(b, 0, 10) && b[10] === 255 && b[11] === 255) return BLOCKED.check(dotted(b, 12), 'ipv4'); // mapped
  if (zero(b, 0, 12)) return true; // IPv4-compatible (::/96), deprecated
  if (zero(b, 0, 8) && b[8] === 255 && b[9] === 255 && b[10] === 0 && b[11] === 0) return BLOCKED.check(dotted(b, 12), 'ipv4'); // translated
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(b, 4, 12)) return BLOCKED.check(dotted(b, 12), 'ipv4'); // NAT64
  if (b[0] === 0x20 && b[1] === 0x02) return BLOCKED.check(dotted(b, 2), 'ipv4'); // 6to4
  if ((b[0] & 0xe0) !== 0x20) return true; // not global unicast
  return BLOCKED_V6.check(ip, 'ipv6');
}

function isBlockedAddress(ip) {
  if (typeof ip !== 'string') return true;
  const family = net.isIP(ip);
  if (family === 0) return true;
  try {
    return family === 4 ? BLOCKED.check(ip, 'ipv4') : isBlockedV6(ip);
  } catch {
    return true;
  }
}

// An allow-list entry the way the URL parser writes a host: punycode, lower case, one trailing dot removed.
const normaliseHost = h => (typeof h === 'string' ? domainToASCII(h).toLowerCase().replace(/\.$/, '') : '');

function checkUrl(url, { allowHosts } = {}) {
  let u;
  try { u = new URL(url); } catch { throw new GuardError('bad_url', 'not a valid URL'); }
  if (u.protocol !== 'https:') throw new GuardError('bad_scheme', 'only https is allowed');
  if (u.username || u.password) throw new GuardError('bad_url', 'credentials in a URL are not allowed');
  if (u.port && u.port !== '443') throw new GuardError('bad_port', 'only port 443 is allowed');
  if (net.isIP(u.hostname.replace(/^\[|\]$/g, '')) !== 0) throw new GuardError('ip_literal', 'an IP address is not a host name');
  u.hostname = u.hostname.toLowerCase().replace(/\.$/, '');
  const allowed = Array.isArray(allowHosts) ? allowHosts.map(normaliseHost).filter(Boolean) : [];
  if (!u.hostname || !allowed.includes(u.hostname)) throw new GuardError('host_not_allowed', 'host is not on the allow list');
  return u;
}

async function vetHost(hostname, { lookup = host => dns.promises.lookup(host, { all: true }) } = {}) {
  let results;
  try { results = await lookup(hostname, { all: true }); } catch { throw new GuardError('dns_failed', 'host did not resolve'); }
  if (!Array.isArray(results) || !results.length) throw new GuardError('dns_failed', 'host did not resolve');
  if (results.some(r => !r || isBlockedAddress(r.address))) throw new GuardError('blocked_address', 'host resolves to a blocked address');
  return results.map(r => ({ address: r.address, family: net.isIP(r.address) }));
}

module.exports = { GuardError, isBlockedAddress, checkUrl, vetHost };
