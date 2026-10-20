'use strict';
// Keys that sign in one non-browser caller for named routes only (docs/WORKSHOP-DISPLAY.md › Local AI cards). The
// appliance keeps only the SHA-256 of each key, in a file under DATA_DIR that the owner's setup script writes; the
// caller sends the key itself in a header. Today: the Workshop display's key for GET /api/display/feed, so its idle
// screen keeps working when sign-in starts refusing unsigned callers (#331).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function createRouteKey({ dataDir, file, header }) {
  const keyFile = path.join(dataDir, file);
  let cache = { mtimeMs: -1, hash: null };
  function expected() {
    try {
      const { mtimeMs } = fs.statSync(keyFile);
      if (mtimeMs !== cache.mtimeMs) {
        const hex = fs.readFileSync(keyFile, 'utf8').trim();
        cache = { mtimeMs, hash: /^[0-9a-f]{64}$/i.test(hex) ? Buffer.from(hex, 'hex') : null };
      }
      return cache.hash;
    } catch { cache = { mtimeMs: -1, hash: null }; return null; }
  }
  return {
    configured: () => !!expected(),
    authorized(req) {
      const want = expected(), got = req.headers[header];
      if (!want || typeof got !== 'string' || !got) return false;
      return crypto.timingSafeEqual(crypto.createHash('sha256').update(got).digest(), want);
    }
  };
}

module.exports = { createRouteKey };
