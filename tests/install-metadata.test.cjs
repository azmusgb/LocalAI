'use strict';

// Added to the Home Screen, Local AI should look like one app: the status bar, the splash screen, the page and the
// manifest all on the page background (#0a111c), the page drawing under a translucent iOS status bar, a short name
// under the icon, and an icon Android can mask without cutting off the mark (critique §3.7).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', 'app', 'public');
const BG = '#0a111c';
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'manifest.json'), 'utf8'));
const meta = name => { const m = html.match(new RegExp(`<meta\\s+name="${name}"\\s+content="([^"]*)"`, 'i')); return m && m[1]; };
// Width and height from a PNG's IHDR chunk.
const pngSize = file => { const b = fs.readFileSync(file); assert.equal(b.toString('latin1', 1, 4), 'PNG', `${file} is a PNG`); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };

test('the page, theme-color and the manifest share one background colour', () => {
  assert.match(fs.readFileSync(path.join(PUBLIC, 'app.css'), 'utf8'), new RegExp(`--ds-bg:${BG}`, 'i'), 'the page background');
  assert.equal(meta('theme-color')?.toLowerCase(), BG);
  assert.equal(manifest.background_color.toLowerCase(), BG);
  assert.equal(manifest.theme_color.toLowerCase(), BG);
});

test('iOS: the page runs under a translucent status bar, with a short name under the icon', () => {
  assert.equal(meta('apple-mobile-web-app-status-bar-style'), 'black-translucent');
  assert.equal(meta('apple-mobile-web-app-title'), 'Local AI');
  assert.match(html, /viewport-fit=cover/, 'the page may draw into the safe areas (the header pads itself)');
});

test('the manifest offers a 512px maskable icon whose mark sits inside the safe zone', () => {
  const masks = manifest.icons.filter(i => String(i.purpose || '').split(/\s+/).includes('maskable'));
  assert.ok(masks.length >= 1, 'a maskable icon');
  const icon = masks.find(i => i.sizes === '512x512');
  assert.ok(icon, 'at 512x512');
  const file = path.join(PUBLIC, icon.src.replace(/^\//, ''));
  assert.ok(fs.existsSync(file), `${icon.src} exists`);
  assert.deepEqual(pngSize(file), [512, 512]);
  assert.ok(manifest.icons.some(i => i.sizes === '512x512' && String(i.purpose || 'any').split(/\s+/).includes('any')), 'the plain icon stays for launchers that don\'t mask');
});
