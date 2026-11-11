'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { matrix, svg } = require('../app/public/qr.js');

// An independent reader: it re-derives the function patterns, reads the format bits, unmasks the zigzag, and checks
// every block's Reed-Solomon syndromes before decoding the byte-mode payload. Encoder bugs can't hide behind it.
const MASKS = [
  (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, x => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
  (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0, (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0];
const BLOCKS = [null, [10, [16]], [16, [28]], [26, [44]], [18, [32, 32]], [24, [43, 43]], [16, [27, 27, 27, 27]],
  [18, [31, 31, 31, 31]], [22, [38, 38, 39, 39]], [22, [36, 36, 36, 37, 37]], [26, [43, 43, 43, 43, 44]]];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
const EXP = [], LOG = [];
for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x = (x << 1) ^ (x & 0x80 ? 0x11d : 0); }
const gmul = (a, b) => (a && b ? EXP[(LOG[a] + LOG[b]) % 255] : 0);

function read(m) {
  const size = m.length, v = (size - 17) / 4;
  assert.ok(Number.isInteger(v) && v >= 1 && v <= 10, 'size is a QR version 1-10');
  const fixed = m.map(r => r.map(() => false)), mark = (x, y) => { if (x >= 0 && y >= 0 && x < size && y < size) fixed[y][x] = true; };
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) mark(cx + dx, cy + dy);
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      assert.equal(m[cy + dy][cx + dx], d !== 2, 'finder pattern');
    }
  }
  for (let i = 0; i < size; i++) { mark(6, i); mark(i, 6); if (i > 7 && i < size - 8) assert.equal(m[6][i], i % 2 === 0, 'timing'); }
  const al = ALIGN[v], last = al.length - 1;
  al.forEach((ay, i) => al.forEach((ax, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) mark(ax + dx, ay + dy);
  }));
  for (let i = 0; i < 9; i++) { mark(8, i); mark(i, 8); }
  for (let i = 0; i < 8; i++) { mark(size - 1 - i, 8); mark(8, size - 1 - i); }
  if (v >= 7) for (let i = 0; i < 18; i++) { mark(size - 11 + (i % 3), Math.floor(i / 3)); mark(Math.floor(i / 3), size - 11 + (i % 3)); }
  assert.equal(m[size - 8][8], true, 'dark module');
  // Format: both copies agree, the BCH code checks out, level M.
  let a = 0, b = 0;
  const first = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
  first.forEach(([x, y], i) => { if (m[y][x]) a |= 1 << i; });
  for (let i = 0; i < 8; i++) if (m[8][size - 1 - i]) b |= 1 << i;
  for (let i = 8; i < 15; i++) if (m[size - 15 + i][8]) b |= 1 << i;
  assert.equal(a, b, 'format copies match');
  const fmt = a ^ 0x5412, data = fmt >>> 10;
  let rem = data; for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  assert.equal((data << 10) | rem, fmt, 'format BCH');
  assert.equal(data >>> 3, 0, 'error correction level M');
  const flip = MASKS[data & 7];
  const bits = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
      if (!fixed[y][x]) bits.push(m[y][x] !== flip(x, y) ? 1 : 0);
    }
  }
  const words = []; for (let i = 0; i + 8 <= bits.length; i += 8) words.push(bits.slice(i, i + 8).reduce((p, c) => (p << 1) | c, 0));
  const [ec, lens] = BLOCKS[v], blocks = lens.map(() => []), longest = Math.max(...lens);
  let at = 0;
  for (let i = 0; i < longest; i++) lens.forEach((len, k) => { if (i < len) blocks[k].push(words[at++]); });
  for (let i = 0; i < ec; i++) blocks.forEach(blk => blk.push(words[at++]));
  for (const blk of blocks) for (let i = 0; i < ec; i++) {
    let s = 0; for (const c of blk) s = gmul(s, EXP[i]) ^ c;
    assert.equal(s, 0, 'Reed-Solomon syndrome');
  }
  const payload = blocks.flatMap((blk, k) => blk.slice(0, lens[k]));
  const stream = payload.flatMap(w => [7, 6, 5, 4, 3, 2, 1, 0].map(i => (w >>> i) & 1));
  const take = n => { let x = 0; for (let i = 0; i < n; i++) x = (x << 1) | stream.shift(); return x; };
  assert.equal(take(4), 4, 'byte mode');
  const n = take(v < 10 ? 8 : 16);
  return Buffer.from(Array.from({ length: n }, () => take(8))).toString('utf8');
}

test('QR codes read back exactly across every supported size, with valid error correction', () => {
  const sizes = new Set();
  const samples = ['https://10.0.0.81/', 'http://10.0.0.81/localai-ca.crt', 'Héllo · 世界 ✓', 'x'];
  for (let len = 1; len <= 213; len += 4) samples.push(Array.from({ length: len }, (_, i) => String.fromCharCode(33 + ((i * 13 + len) % 90))).join(''));
  for (const text of samples) { const m = matrix(text); sizes.add(m.length); assert.equal(read(m), text); }
  assert.deepEqual([...sizes].sort((a, b) => a - b), [21, 25, 29, 33, 37, 41, 45, 49, 53, 57]);
});

test('QR text that does not fit is refused, and the SVG keeps a white quiet zone', () => {
  assert.throws(() => matrix('x'.repeat(214)), /too long/);
  const out = svg('https://10.0.0.81/', 'Open <Local AI>');
  assert.match(out, /^<svg class="qr" [^>]*viewBox="0 0 33 33"/);
  assert.match(out, /aria-label="Open &lt;Local AI&gt;"/);
  assert.match(out, /<rect width="33" height="33" fill="#fff"\/>/);
});
