// Builds app/public/icons/icon-maskable-512.png from icon-512.png: the same picture at 80% on its own background
// colour, so a launcher that masks the icon (a circle, a squircle) never cuts into the tile. The maskable safe zone
// is the centred circle of radius 40%; at 80% the tile's rounded corners stay inside it.
// Node built-ins only (zlib, fs). Run: node scripts/make-maskable-icon.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { inflateSync, deflateSync, crc32 } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const icons = fileURLToPath(new URL('../app/public/icons/', import.meta.url));
const SCALE = 0.8;

function decode(buf) {
  if (buf.toString('latin1', 1, 4) !== 'PNG') throw new Error('not a PNG');
  let off = 8, w = 0, h = 0, depth = 0, type = 0, interlace = 0;const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), kind = buf.toString('latin1', off + 4, off + 8), data = buf.subarray(off + 8, off + 8 + len);
    if (kind === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; type = data[9]; interlace = data[12]; }
    else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    off += 12 + len;
  }
  const bpp = { 2: 3, 6: 4 }[type];
  if (depth !== 8 || !bpp || interlace) throw new Error(`unsupported PNG (depth ${depth}, colour type ${type}, interlace ${interlace})`);
  const raw = inflateSync(Buffer.concat(idat)), stride = w * bpp, px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), row = px.subarray(y * stride, (y + 1) * stride), up = y ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0, b = up ? up[i] : 0, c = up && i >= bpp ? up[i - bpp] : 0;
      let v = src[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      row[i] = v & 255;
    }
  }
  // Always hand back RGBA.
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) { for (let k = 0; k < 3; k++) rgba[i * 4 + k] = px[i * bpp + k]; rgba[i * 4 + 3] = bpp === 4 ? px[i * bpp + 3] : 255; }
  return { w, h, rgba };
}

function encode(w, h, rgba) {
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const chunk = (kind, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(kind, 'latin1'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0); return Buffer.concat([len, body, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const src = decode(readFileSync(icons + 'icon-512.png'));
const { w, h } = src, out = Buffer.alloc(w * h * 4);
const bg = [...src.rgba.subarray(0, 4)]; // the icon's own corner colour, so the padding is seamless
const inner = Math.round(w * SCALE), pad = (w - inner) / 2;
const at = (x, y, k) => src.rgba[(Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))) * 4 + k];
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const o = (y * w + x) * 4, u = (x - pad + 0.5) / SCALE - 0.5, v = (y - pad + 0.5) / SCALE - 0.5;
  if (x < pad || y < pad || x >= w - pad || y >= h - pad) { for (let k = 0; k < 4; k++) out[o + k] = bg[k]; continue; }
  // Bilinear sample of the source: smooth edges at 80%.
  const x0 = Math.floor(u), y0 = Math.floor(v), fx = u - x0, fy = v - y0;
  for (let k = 0; k < 4; k++) out[o + k] = Math.round(at(x0, y0, k) * (1 - fx) * (1 - fy) + at(x0 + 1, y0, k) * fx * (1 - fy) + at(x0, y0 + 1, k) * (1 - fx) * fy + at(x0 + 1, y0 + 1, k) * fx * fy);
}
writeFileSync(icons + 'icon-maskable-512.png', encode(w, h, out));
console.log('wrote app/public/icons/icon-maskable-512.png');
