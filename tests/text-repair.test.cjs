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
