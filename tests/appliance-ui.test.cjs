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

// Local AI's own stylesheet still names its colours --ds-* (they become the kit's names section by section, L4 to L9):
// they carry the kit's dark values, and this test keeps them equal to the synced copy.
test('the design tokens carry the kit\'s dark colours', () => {
  const kit = JSON.parse(read('ui/tokens.json')).color;
  const css = read('app.css').replace(/\s+/g, '');
  for (const [ds, ui] of [['bg', 'bg'], ['surface', 'surface'], ['surface-2', 'surface2'], ['line', 'line'], ['line-2', 'line2'],
    ['line-input', 'fieldLine'], ['text', 'text'], ['muted', 'muted'], ['accent', 'accent'], ['accent-text', 'accentText'],
    ['accent-ink', 'onAccent'], ['accent-soft', 'accentSoft'], ['good', 'ok'], ['bad', 'bad'], ['attention', 'warn'],
    ['bg-2', 'bar'], ['surface-3', 'line'], ['line-card', 'line']])
    assert.ok(css.includes(`--ds-${ds}:${kit[ui].dark}`), `--ds-${ds} should be the kit's ${ui} (${kit[ui].dark})`);
});

// Pi Hub A22 1.3 (step 13, L3): the kit's values come from the kit's own file. index.html loads /ui/tokens.css before
// every other sheet, and Local AI's stylesheet defines no --ui-* name of its own (it used to alias each one, and held
// the small text at 13 px; the kit's sizes are rem on the kit's root curve now, the same as Pi Hub's).
test('the page loads the kit\'s tokens.css first and app.css defines no --ui-* name', () => {
  const sheets = [...read('index.html').matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map(m => m[1]);
  assert.deepEqual(sheets, ['/ui/tokens.css', '/ui/components.css', '/app.css', '/ui/needs.css']);
  const own = [...read('app.css').matchAll(/(?:^|[;{\s])(--ui-[a-z0-9-]+)\s*:/g)].map(m => m[1]);
  assert.deepEqual([...new Set(own)], []);
  // Dark only until L10: the kit's file follows the system's theme unless the page says dark.
  assert.match(read('index.html'), /<html lang="en" data-theme="dark">/);
});

// The navy shades from before the kit are gone (and since 1.4, Faceplate, the Slate + Sky ones too) from the app's chrome (the canvas's own night palette, --aw-*, stays).
test('no old navy shades in the app chrome', () => {
  const css = read('app.css').replace(/\s+/g, '');
  const old = ['#0c1828', '#182b45', '#1f2c42', '#8698b1', '#293348', '#aebdd0', '#778597', '#0a0d12', '#090c10',
    'rgba(9,11,15,', 'rgba(7,11,17,', 'rgba(7,10,15,', 'rgba(9,14,22,', 'rgba(4,8,14,',
    '#0b1118', '#121a24', '#1a2431', '#5ab4ff', 'rgba(92,184,255,', 'rgba(90,180,255,', 'Figtree'];
  assert.deepEqual(old.filter(c => css.includes(c)), []);
  // Faint text is the kit's muted at 90% over the page: neutral, and 4.5:1 on the page, a card, the well and a tab.
  assert.ok(css.includes('--ds-faint:#9ba29d'), '--ds-faint is #9ba29d');
});

// Fresh look review, 25 Oct: the last colours from before the kit (the lavender logo tile, a periwinkle blue, a navy
// glow, a cyan progress bar, dim nav labels) are gone from the app's own styles.
test('no off-palette colours left in the app chrome', () => {
  const css = read('app.css').replace(/\s+/g, '');
  const old = ['#99c7ff', '#8b75ff', '#a9c4ff', '#7f89ff', 'rgba(111,132,255', 'rgba(121,169,255', '#b9d2ff', '#9fc1ff',
    '#c8b5ff', 'rgba(169,140,255', 'rgba(75,120,210', '#55dff1', '#758398', '#8090a5'];
  assert.deepEqual(old.filter(c => css.includes(c)), []);
});

// Look review: on Services, a printer error on the Workshop display card was plain grey next to a green "Online".
test('a printer error on the Services card is marked as one', () => {
  const ui = read('ui.js'), css = read('app.css').replace(/\s+/g, '');
  assert.match(ui, /box\.dataset\.tone = p\?\.state === 'error' \? 'bad'/);
  assert.ok(css.includes('.ux-int-guidance[data-tone="bad"]{border-left-color:var(--ds-bad);color:var(--ds-text)'));
});

// Look review: phone filter chips cut off with no cue; awkward Signals copy. (Its print-lab command check went with the lab page, N5.)
test('chips fade at the edge, Signals says what to do', () => {
  const css = read('app.css').replace(/\s+/g, '');
  assert.ok(css.includes('.work-chips.ux-tabs{mask-image:linear-gradient(90deg,#000calc(100%-28px),transparent)'));
  assert.ok(read('improve.js').includes('Press Run checks to look for some now.'));
});

// Look review: Inbox cards sat inside another card (a double border); every audit entry carried a full "Open run" button.
test('Inbox is one layer of cards and the audit log opens runs from a small link', () => {
  const css = read('app.css').replace(/\s+/g, '');
  assert.ok(css.includes('#inbox>.card{background:transparent;border:0;padding:0;box-shadow:none;'));
  assert.match(read('app.js'), /<button class="link-btn" type="button" data-open-run=/);
  assert.ok(css.includes('.link-btn{'));
});

// N5: "← Home" is born with Pi Hub's registry address; nothing waits for a later script to correct a bare IP.
test('the header\'s "← Home" link is written with the registry address, not 10.0.0.80', () => {
  const ui = read('ui.js');
  const m = /id="uxPiHubLink" href="'\+hubHref\+'"/.exec(ui);
  assert.ok(m, 'the link takes its address from hubHref in the markup');
  assert.match(ui, /const hubHref=window\.ApplianceTools\?\.toolUrl\('hub'\)\|\|'https:\/\/hub\.rahe-home\.duckdns\.org\/';/);
  assert.ok(!/id="uxPiHubLink"[^>]*10\.0\.0\.80/.test(ui), 'no bare IP in the markup');
});
