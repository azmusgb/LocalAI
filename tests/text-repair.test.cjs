const test = require('node:test');
const assert = require('node:assert/strict');
const { repairText } = require('../app/text-repair.js');

// Encode as UTF-8, decode as Windows-1252 (with C1 bytes kept as-is), like Windows PowerShell does.
const CP1252 = { 0x80: 0x20AC, 0x82: 0x201A, 0x83: 0x0192, 0x84: 0x201E, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02C6, 0x89: 0x2030, 0x8A: 0x0160, 0x8B: 0x2039, 0x8C: 0x0152, 0x8E: 0x017D, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201C, 0x94: 0x201D, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02DC, 0x99: 0x2122, 0x9A: 0x0161, 0x9B: 0x203A, 0x9C: 0x0153, 0x9E: 0x017E, 0x9F: 0x0178 };
const garble = s => [...Buffer.from(s, 'utf8')].map(b => String.fromCodePoint(CP1252[b] || b)).join('');

test('repairs text garbled once, twice and three times', () => {
  for (const original of ['512 × 512 generated image', 'strengths — critical bugs', 'Here’s a plan…', 'Next → done']) {
    assert.equal(repairText(garble(original)), original);
    assert.equal(repairText(garble(garble(original))), original);
    assert.equal(repairText(garble(garble(garble(original)))), original);
  }
});

test('repairs the rows found on the appliance', () => {
  assert.equal(repairText('512 ÃƒÆ’Ã¢â‚¬â€\u009d 512 generated image'), '512 × 512 generated image');
  assert.equal(repairText('closer to a defensÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦'), 'closer to a defens…');
});

test('leaves correct text alone', () => {
  for (const s of ['café naïve résumé', 'Größe', '日本語 and emoji 🎉', '512 × 512', 'plain ascii', 'Ä Ö Ü ß', '—', '']) assert.equal(repairText(s), s);
  assert.equal(repairText(null), null);
  assert.equal(repairText(42), 42);
});

test('repairs only the broken part of mixed text', () => {
  assert.equal(repairText(`café ${garble('— ok')} 🎉`), 'café — ok 🎉');
});

// Old image-run summaries put the count before the size ("1 704 × 1024 image …"), so the count reads as a width.
test('rewrites old image-run summaries so the count no longer reads as a width', () => {
  const { repairImageSummary } = require('../app/text-repair.js');
  assert.equal(repairImageSummary('1 704 × 1024 image edited with Quality (X)'), '704 × 1024 image, edited with Quality (X)');
  assert.equal(repairImageSummary('1 512 × 512 image made with Fast'), '512 × 512 image, made with Fast');
  assert.equal(repairImageSummary('3 1024 × 680 images edited with Quality (X)'), '3 images, 1024 × 680, edited with Quality (X)');
  assert.equal(repairImageSummary('2 512 × 512 images made with Fast · seed 7'), '2 images, 512 × 512, made with Fast · seed 7');
  // Nothing after the size: no dangling comma.
  assert.equal(repairImageSummary('1 704 × 1024 image'), '704 × 1024 image');
  assert.equal(repairImageSummary('4 512 × 512 images'), '4 images, 512 × 512');
});

test('leaves modern and unrelated summaries alone', () => {
  const { repairImageSummary } = require('../app/text-repair.js');
  for (const s of ['Image edited with Quality (X) · 704 × 1024', '3 images made with Fast · 512 × 512', '704 × 1024 image, edited with Quality (X)',
    '12 imagery notes', 'An idée', '', '1 704 × 1024 imagery']) assert.equal(repairImageSummary(s), s);
  assert.equal(repairImageSummary(null), null);
  assert.equal(repairImageSummary(42), 42);
});
