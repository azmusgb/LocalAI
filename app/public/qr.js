// QR codes for "open on your phone": byte mode, error correction level M, versions 1-10 (up to 213 bytes, plenty
// for a LAN address). Self-contained so the page needs no library; tests decode its output with a real scanner.
(root => {
'use strict';
// Per version: [total codewords, ECC codewords per block, [blocks, data codewords per block], ...groups].
const SPEC = [null,
  [26, 10, [1, 16]], [44, 16, [1, 28]], [70, 26, [1, 44]], [100, 18, [2, 32]], [134, 24, [2, 43]],
  [172, 16, [4, 27]], [196, 18, [4, 31]], [242, 22, [2, 38], [2, 39]], [292, 22, [3, 36], [2, 37]], [346, 26, [4, 43], [1, 44]]];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
const FORMAT_M = 0; // format bits for level M

function mul(x, y) { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; } return z; }
function eccFor(data, len) {
  const div = new Array(len).fill(0); div[len - 1] = 1; let r = 1;
  for (let i = 0; i < len; i++) { for (let j = 0; j < len; j++) { div[j] = mul(div[j], r); if (j + 1 < len) div[j] ^= div[j + 1]; } r = mul(r, 2); }
  const out = new Array(len).fill(0);
  for (const b of data) { const f = b ^ out.shift(); out.push(0); for (let i = 0; i < len; i++) out[i] ^= mul(div[i], f); }
  return out;
}
const dataCapacity = v => SPEC[v].slice(2).reduce((n, [blocks, per]) => n + blocks * per, 0);

function codewords(bytes, v) {
  const cap = dataCapacity(v), bits = [];
  const put = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(4, 4); put(bytes.length, v < 10 ? 8 : 16); for (const b of bytes) put(b, 8);
  put(0, Math.min(4, cap * 8 - bits.length)); while (bits.length % 8) bits.push(0);
  const data = []; for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; data.length < cap; pad ^= 0xec ^ 0x11) data.push(pad);
  const blocks = []; let at = 0;
  for (const [count, per] of SPEC[v].slice(2)) for (let i = 0; i < count; i++) { const d = data.slice(at, at += per); blocks.push({ d, e: eccFor(d, SPEC[v][1]) }); }
  const out = [], longest = Math.max(...blocks.map(b => b.d.length));
  for (let i = 0; i < longest; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
  for (let i = 0; i < SPEC[v][1]; i++) for (const b of blocks) out.push(b.e[i]);
  return out;
}

function build(bytes, v, mask) {
  const size = v * 4 + 17, dark = [...Array(size)].map(() => new Array(size).fill(false)), fixed = dark.map(r => r.map(() => false));
  const set = (x, y, on) => { dark[y][x] = on; fixed[y][x] = true; };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]])
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
      if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
    }
  const al = ALIGN[v], last = al.length - 1;
  al.forEach((ay, i) => al.forEach((ax, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }));
  const format = () => {
    const data = (FORMAT_M << 3) | mask; let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412, bit = i => ((bits >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  format();
  if (v >= 7) {
    let rem = v; for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (v << 12) | rem;
    for (let i = 0; i < 18; i++) { const on = ((bits >>> i) & 1) === 1, a = size - 11 + (i % 3), b = Math.floor(i / 3); set(a, b, on); set(b, a, on); }
  }
  const data = codewords(bytes, v), flip = MASKS[mask];
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
      if (fixed[y][x]) continue;
      const on = i < data.length * 8 && ((data[i >>> 3] >>> (7 - (i & 7))) & 1) === 1; i++;
      dark[y][x] = on !== flip(x, y);
    }
  }
  return dark;
}
const MASKS = [
  (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, x => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
  (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0, (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0];

// Lower is easier to scan: long runs, 2x2 blocks, finder look-alikes and an uneven dark ratio all cost points.
function penalty(m) {
  const n = m.length; let p = 0, darkCount = 0;
  const lines = [...m, ...m.map((_, x) => m.map(r => r[x]))];
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= n; i++) { if (i < n && line[i] === line[i - 1]) run++; else { if (run >= 5) p += run - 2; run = 1; } }
    const s = line.map(b => (b ? '1' : '0')).join('');
    for (const pat of ['10111010000', '00001011101']) for (let at = s.indexOf(pat); at >= 0; at = s.indexOf(pat, at + 1)) p += 40;
  }
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (m[y][x]) darkCount++;
    if (x < n - 1 && y < n - 1 && m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) p += 3;
  }
  return p + Math.floor(Math.abs(darkCount * 20 - n * n * 10) / (n * n)) * 10;
}

function matrix(text) {
  const bytes = [...new TextEncoder().encode(String(text))];
  const v = SPEC.findIndex((s, i) => i > 0 && bytes.length + (i < 10 ? 2 : 3) <= dataCapacity(i));
  if (v < 1) throw new Error('Text is too long for a QR code here');
  let best = null, bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) { const m = build(bytes, v, mask), s = penalty(m); if (s < bestScore) { best = m; bestScore = s; } }
  return best;
}

// Dark on white with the required 4-module quiet zone, whatever the page theme.
function svg(text, label = 'QR code') {
  const m = matrix(text), n = m.length + 8;
  let d = '';
  m.forEach((row, y) => row.forEach((on, x) => { if (on) d += `M${x + 4} ${y + 4}h1v1h-1z`; }));
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<svg class="qr" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" role="img" aria-label="${esc(label)}"><rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

const api = { matrix, svg };
if (typeof module === 'object' && module.exports) module.exports = api; else root.LocalAIQR = api;
})(typeof window !== 'undefined' ? window : globalThis);
