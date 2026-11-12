'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const push = require('../app/push.js');

// RFC 8291 §5 and Appendix A.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  message: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN'
};
const b64u = (s) => Buffer.from(s, 'base64url');
function jwk(privateB64u, publicB64u) {
  const pub = b64u(publicB64u);
  return { kty: 'EC', crv: 'P-256', d: privateB64u, x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') };
}

// The receiving side of RFC 8291, so the tests can read what encrypt() produced.
function decrypt(body, uaPrivate, uaPublic, auth) {
  const salt = body.subarray(0, 16), idlen = body[20], asPublic = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  const ecdh = crypto.createECDH('prime256v1'); ecdh.setPrivateKey(b64u(uaPrivate));
  const secret = ecdh.computeSecret(asPublic);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, b64u(auth), Buffer.concat([Buffer.from('WebPush: info\0'), b64u(uaPublic), asPublic]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const padded = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  return padded.subarray(0, padded.lastIndexOf(2)).toString('utf8');
}
function memorySettings() {
  const m = new Map();
  return { readSetting: (k, f) => (m.has(k) ? structuredClone(m.get(k)) : f), writeSetting: (k, v) => m.set(k, structuredClone(v)) };
}

test('encrypt matches RFC 8291 section 5', () => {
  const out = push.encrypt(Buffer.from(RFC.plaintext), { p256dh: RFC.uaPublic, auth: RFC.auth },
    { salt: b64u(RFC.salt), serverKeys: { privateJwk: jwk(RFC.asPrivate, RFC.asPublic), publicKey: RFC.asPublic } });
  assert.equal(out.toString('base64url'), RFC.message);
});

test('encrypt round-trips unicode', () => {
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  const auth = crypto.randomBytes(16).toString('base64url');
  const out = push.encrypt(Buffer.from('Café → done 🎉'), { p256dh: ua.getPublicKey().toString('base64url'), auth });
  assert.equal(decrypt(out, ua.getPrivateKey().toString('base64url'), ua.getPublicKey().toString('base64url'), auth), 'Café → done 🎉');
});

test('vapidHeader is a valid ES256 JWT', () => {
  const vapid = push.loadOrCreateVapid(memorySettings());
  const now = Date.parse('2026-10-15T12:00:00Z');
  const header = push.vapidHeader('https://web.push.apple.com/QAbc', vapid, { subject: 'https://github.com/azmusgb/LocalAI', now });
  const m = /^vapid t=([^,]+), k=(\S+)$/.exec(header);
  assert.ok(m, header);
  assert.equal(m[2], vapid.publicKey);
  const [h, c, sig] = m[1].split('.');
  assert.deepEqual(JSON.parse(b64u(h)), { typ: 'JWT', alg: 'ES256' });
  const claims = JSON.parse(b64u(c));
  assert.equal(claims.aud, 'https://web.push.apple.com');
  assert.equal(claims.sub, 'https://github.com/azmusgb/LocalAI');
  assert.ok(Number.isInteger(claims.exp));
  const hours = (claims.exp - now / 1000) / 3600;
  assert.ok(hours >= 11 && hours <= 13, String(hours));
  const key = crypto.createPublicKey({ key: jwk(vapid.privateJwk.d, vapid.publicKey), format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, b64u(sig)));
});

test('loadOrCreateVapid creates once', () => {
  const settings = memorySettings();
  const a = push.loadOrCreateVapid(settings), b = push.loadOrCreateVapid(settings);
  assert.equal(a.publicKey, b.publicKey);
  const raw = b64u(a.publicKey);
  assert.equal(raw.length, 65);
  assert.equal(raw[0], 4);
});

test('isAllowedEndpoint', () => {
  for (const ok of ['https://web.push.apple.com/abc', 'https://fcm.googleapis.com/fcm/send/x', 'https://updates.push.services.mozilla.com/wpush/v2/x']) assert.equal(push.isAllowedEndpoint(ok), true, ok);
  for (const bad of ['http://web.push.apple.com/x', 'https://evil.com/x', 'https://push.apple.com.evil.com/x', 'https://10.0.0.81/x', 'not a url', '']) assert.equal(push.isAllowedEndpoint(bad), false, bad);
});

test('sendPush posts the right headers and reports gone', async () => {
  const vapid = push.loadOrCreateVapid(memorySettings());
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  const sub = { endpoint: 'https://web.push.apple.com/QAbc', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } };
  let seen = null, status = 201;
  const fetchImpl = async (url, init) => { seen = { url, init }; return new Response(null, { status }); };
  const r = await push.sendPush(sub, { title: 'Hi', body: 'There' }, { vapid, subject: 'https://github.com/azmusgb/LocalAI', urgency: 'high', topic: 'run:abc', fetchImpl });
  assert.deepEqual(r, { ok: true, status: 201, gone: false });
  assert.equal(seen.url, sub.endpoint);
  assert.equal(seen.init.method, 'POST');
  const h = seen.init.headers;
  assert.equal(h['Content-Encoding'], 'aes128gcm');
  assert.equal(h['Content-Type'], 'application/octet-stream');
  assert.equal(h.TTL, '86400');
  assert.equal(h.Urgency, 'high');
  assert.match(h.Topic, /^[A-Za-z0-9_-]{1,32}$/);
  assert.match(h.Authorization, /^vapid t=/);
  assert.ok(Buffer.isBuffer(seen.init.body));
  status = 410;
  assert.deepEqual(await push.sendPush(sub, { title: 'x' }, { vapid, subject: 's', urgency: 'normal', topic: 't', fetchImpl }), { ok: false, status: 410, gone: true });
  await assert.rejects(push.sendPush({ ...sub, endpoint: 'https://evil.com/x' }, { title: 'x' }, { vapid, subject: 's', fetchImpl }), /not an allowed push endpoint/);
});
