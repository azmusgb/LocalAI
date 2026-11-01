'use strict';
// Pi Hub's service key: Pi Hub sends X-LocalAI-Hub-Key; the appliance keeps only LOCALAI_HUB_KEY_SHA256 (hex SHA-256).
// Empty means nobody is let in. Read per request so a restart or a test sees the current env.
const crypto = require('node:crypto');

function authorized(req) {
  const want = String(process.env.LOCALAI_HUB_KEY_SHA256 || '').trim().toLowerCase();
  const got = req.headers['x-localai-hub-key'];
  if (!want || typeof got !== 'string' || !got) return false;
  const a = Buffer.from(crypto.createHash('sha256').update(got).digest('hex'), 'utf8'), b = Buffer.from(want, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { authorized };
