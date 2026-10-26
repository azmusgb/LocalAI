'use strict';
// Pi Hub one home, step 5: Local AI wears the appliance-ui kit's colours (dark only), from an untouched synced copy.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const pub = path.join(__dirname, '..', 'app', 'public');
const read = f => fs.readFileSync(path.join(pub, f), 'utf8');

test('the kit copy in app/public/ui is untouched', () => {
  const r = spawnSync(process.execPath, [path.join(pub, 'ui', 'verify.mjs'), path.join(pub, 'ui')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

// Local AI keeps one stylesheet and its own /fonts (design-system-ui checks both), so it doesn't load the kit's CSS: its
// --ds-* colours carry the kit's dark values, and this test keeps them equal to the synced copy.
test('the design tokens carry the kit\'s dark colours', () => {
  const kit = JSON.parse(read('ui/tokens.json')).color;
  const css = read('app.css').replace(/\s+/g, '');
  for (const [ds, ui] of [['bg', 'bg'], ['surface', 'surface'], ['surface-2', 'surface2'], ['line', 'line'], ['line-2', 'line2'],
    ['line-input', 'fieldLine'], ['text', 'text'], ['muted', 'muted'], ['accent', 'accent'], ['accent-text', 'accentText'],
    ['accent-ink', 'onAccent'], ['accent-soft', 'accentSoft'], ['good', 'ok'], ['bad', 'bad'], ['attention', 'warn'],
    ['bg-2', 'bar'], ['surface-3', 'line'], ['line-card', 'line']])
    assert.ok(css.includes(`--ds-${ds}:${kit[ui].dark}`), `--ds-${ds} should be the kit's ${ui} (${kit[ui].dark})`);
});

// The navy shades from before the kit are gone from the app's chrome (the canvas's own night palette, --aw-*, stays).
test('no old navy shades in the app chrome', () => {
  const css = read('app.css').replace(/\s+/g, '');
  const old = ['#0c1828', '#182b45', '#1f2c42', '#8698b1', '#293348', '#aebdd0', '#778597', '#0a0d12', '#090c10',
    'rgba(9,11,15,', 'rgba(7,11,17,', 'rgba(7,10,15,', 'rgba(9,14,22,', 'rgba(4,8,14,'];
  assert.deepEqual(old.filter(c => css.includes(c)), []);
  // Faint text is the kit's muted at 90% over the page: neutral, and 4.5:1 on the page, a card, the well and a tab.
  assert.ok(css.includes('--ds-faint:#8593a4'), '--ds-faint is #8593a4');
});
