'use strict';
// Web Push, built in: VAPID request signing (RFC 8292) and aes128gcm payload encryption (RFC 8291 / 8188) with
// node:crypto, posted to the browser's push service. Only Apple, Google and Mozilla push hosts are allowed.

const crypto = require('node:crypto');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s || ''), 'base64url');
const RECORD_SIZE = 4096;

function rawPublicKey(jwk) {
  return Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)]);
}

// The appliance's signing key pair, made once and kept in settings (push:vapid).
function loadOrCreateVapid(settings) {
  const saved = settings.readSetting('push:vapid', null);
  if (saved?.publicKey && saved?.privateJwk?.d) return saved;
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const privateJwk = privateKey.export({ format: 'jwk' });
  const vapid = { publicKey: b64u(rawPublicKey(privateJwk)), privateJwk };
  settings.writeSetting('push:vapid', vapid);
  return vapid;
}

// "vapid t=<JWT>, k=<public key>": an ES256 JWT for the push service's origin, valid 12 hours.
function vapidHeader(endpoint, vapid, { subject, now = Date.now() }) {
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }));
  const key = crypto.createPrivateKey({ key: vapid.privateJwk, format: 'jwk' });
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${vapid.publicKey}`;
}

// RFC 8291: a fresh sender key pair and salt per message (both can be fixed for the RFC's test vector).
function encrypt(plaintext, { p256dh, auth }, { salt = crypto.randomBytes(16), serverKeys = null } = {}) {
  const uaPublic = fromB64u(p256dh);
  const ecdh = crypto.createECDH('prime256v1');
  if (serverKeys) ecdh.setPrivateKey(fromB64u(serverKeys.privateJwk.d));
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(uaPublic);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, fromB64u(auth), Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  // One record: the plaintext, then the 0x02 delimiter that marks the last record.
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(RECORD_SIZE);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

// Push services Local AI may contact. PUSH_TEST_ENDPOINT_HOST (tests only, never set on the appliance) also
// allows plain-HTTP endpoints on that one host, so tests can run a fake push service.
function isAllowedEndpoint(value) {
  let url;
  try { url = new URL(String(value)); } catch { return false; }
  const testHost = process.env.PUSH_TEST_ENDPOINT_HOST;
  if (testHost && url.host === testHost && (url.protocol === 'http:' || url.protocol === 'https:')) return true;
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return host.endsWith('.push.apple.com') || host === 'fcm.googleapis.com' || host === 'updates.push.services.mozilla.com';
}

const topicFor = (tag) => crypto.createHash('sha256').update(String(tag || 'localai')).digest('base64url').slice(0, 32);

async function sendPush(subscription, payload, { vapid, subject, urgency = 'normal', topic, ttl = 86400, fetchImpl = fetch, timeoutMs = 10000 }) {
  if (!isAllowedEndpoint(subscription?.endpoint)) throw new Error(`${subscription?.endpoint} is not an allowed push endpoint`);
  const body = encrypt(Buffer.from(JSON.stringify(payload)), subscription.keys);
  const response = await fetchImpl(subscription.endpoint, {
    method: 'POST',
    headers: {
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttl),
      Urgency: urgency,
      Topic: topicFor(topic),
      Authorization: vapidHeader(subscription.endpoint, vapid, { subject })
    },
    body,
    signal: AbortSignal.timeout(timeoutMs)
  });
  return { ok: response.status >= 200 && response.status < 300, status: response.status, gone: response.status === 404 || response.status === 410 };
}

module.exports = { loadOrCreateVapid, vapidHeader, encrypt, isAllowedEndpoint, sendPush };
