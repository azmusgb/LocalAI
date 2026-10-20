'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createDisplayPairing } = require('../app/display-pairing');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'localai-pair-'));
const codeOf = (start) => start.code;

test('the right code gives a new key, whose SHA-256 replaces the old one, once', () => {
  const dir = tmp();
  let paired = 0;
  const p = createDisplayPairing({ dataDir: dir, onPaired: () => paired++ });
  fs.writeFileSync(path.join(dir, 'workshop-display-key.sha256'), 'old');
  const code = codeOf(p.start());
  assert.match(code, /^\d{6}$/);
  assert.equal(p.status().pending, true);
  const r = p.pair({ code });
  assert.match(r.key, /^wsd_[0-9a-f]{48}$/);
  assert.equal(r.tlsName, 'localai.home.arpa');
  assert.equal(fs.readFileSync(path.join(dir, 'workshop-display-key.sha256'), 'utf8'), crypto.createHash('sha256').update(r.key).digest('hex'));
  assert.equal(paired, 1);
  assert.equal(p.status().pending, false);
  assert.ok(p.status().pairedAt);
  assert.throws(() => p.pair({ code }), (e) => e.statusCode === 410);
});

test('a wrong code is refused; five end the attempt; a code runs out after 10 minutes', () => {
  let t = 0;
  const p = createDisplayPairing({ dataDir: tmp(), now: () => t });
  const code = codeOf(p.start());
  const wrong = code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 4; i++) assert.throws(() => p.pair({ code: wrong }), (e) => e.statusCode === 403);
  assert.throws(() => p.pair({ code: wrong }), (e) => e.statusCode === 429);
  assert.throws(() => p.pair({ code }), (e) => e.statusCode === 410);
  const again = codeOf(p.start());
  assert.throws(() => p.pair({ code: 'abc' }), (e) => e.statusCode === 400);
  t += 10 * 60 * 1000;
  assert.throws(() => p.pair({ code: again }), (e) => e.statusCode === 410);
});
