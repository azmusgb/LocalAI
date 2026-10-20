'use strict';
// Pairing the Workshop display (docs/WORKSHOP-DISPLAY.md › Pairing): Services › Workshop display › Pair display shows
// a 6-digit code for 10 minutes; the display, given the code on its touchscreen, fetches Local AI's CA over plain
// HTTP (/localai-ca.crt), then sends the code over HTTPS pinned to that CA and gets a new display key back. The
// appliance keeps only the key's SHA-256 (the file route-keys.js reads), so pairing replaces the old key at once.
// Five wrong codes end the attempt; only one code is open at a time.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CODE_MS = 10 * 60 * 1000, TRIES = 5;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

function createDisplayPairing({ dataDir, keyFile = 'workshop-display-key.sha256', tlsName = 'localai.home.arpa', now = Date.now, onPaired = () => {} }) {
  let pending = null; // { hash, expiresAt, tries }
  let pairedAt = null;

  function start() {
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    pending = { hash: sha(code), expiresAt: now() + CODE_MS, tries: 0 };
    return { code, expiresAt: new Date(pending.expiresAt).toISOString() };
  }

  function status() {
    const open = !!pending && now() < pending.expiresAt;
    return { pending: open, expiresAt: open ? new Date(pending.expiresAt).toISOString() : null, pairedAt };
  }

  // {code} from the display. Throws an Error with statusCode for every refusal.
  function pair(input) {
    const fail = (statusCode, message) => { const e = new Error(message); e.statusCode = statusCode; throw e; };
    if (!pending || now() >= pending.expiresAt) { pending = null; fail(410, 'No pairing code is open. Start one in Local AI: Services, Workshop display, Pair display.'); }
    const code = String(input?.code ?? '');
    if (!/^\d{6}$/.test(code)) fail(400, 'The code is 6 digits.');
    if (!crypto.timingSafeEqual(sha(code), pending.hash)) {
      if (++pending.tries >= TRIES) { pending = null; fail(429, 'Too many wrong codes. Start pairing again in Local AI.'); }
      fail(403, "That code doesn't match.");
    }
    pending = null;
    const key = `wsd_${crypto.randomBytes(24).toString('hex')}`;
    const file = path.join(dataDir, keyFile);
    fs.writeFileSync(`${file}.tmp`, sha(key).toString('hex'));
    fs.renameSync(`${file}.tmp`, file);
    pairedAt = new Date(now()).toISOString();
    onPaired();
    return { key, tlsName };
  }

  return { start, status, pair };
}

module.exports = { createDisplayPairing };
