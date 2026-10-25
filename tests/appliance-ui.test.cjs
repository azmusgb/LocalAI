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
    ['accent-ink', 'onAccent'], ['accent-soft', 'accentSoft'], ['good', 'ok'], ['bad', 'bad'], ['attention', 'warn']])
    assert.ok(css.includes(`--ds-${ds}:${kit[ui].dark}`), `--ds-${ds} should be the kit's ${ui} (${kit[ui].dark})`);
});
