'use strict';
// Colour and icon semantics (plan E7): colour says status only, so severity is a neutral badge with its word; each
// icon means one thing; files get a file icon; menus draw icons from the sprite, never letters or loose glyphs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.resolve(__dirname, '../app/public');
const read = f => fs.readFileSync(path.join(PUBLIC, f), 'utf8');
const { VIEWS, DOMAINS } = require(path.join(PUBLIC, 'view-registry.js'));
const { KINDS } = (() => { const src = fs.readFileSync(path.resolve(__dirname, '../app/run-cards.js'), 'utf8'); return { KINDS: eval('(' + /const KINDS = Object\.freeze\((\{[^)]*\})\)/.exec(src)[1] + ')') }; })();

test('severity is a neutral badge with its word, not a status colour', () => {
  const improve = read('improve.js');
  const sev = /const sev=x=>`([^`]*)`/.exec(improve)?.[1];
  assert.ok(sev, 'improve.js has its sev() badge');
  assert.match(sev, /badge--neutral/);
  assert.doesNotMatch(sev, /\$\{TONE/, 'no severity-to-colour map');
  assert.doesNotMatch(improve, /Handed to Claude[^']*'[^']*badge--accent|badge--accent">Handed to Claude/, '"Handed to Claude" is not "Running" blue');
});

test('one icon per meaning: sparkle is Claude, compose is chat, alert is Signals, check is done, files are files', () => {
  const improve = read('improve.js'), app = read('app.js');
  const ICON = eval('(' + /const ICON=(\{[^}]*\})/.exec(improve)[1] + ')');
  assert.equal(ICON.claude, 'sparkle'); assert.equal(ICON.signal, 'alert');
  assert.notEqual(ICON.idea, 'compose', 'an idea is not a chat'); assert.notEqual(ICON.idea, 'sparkle');
  assert.equal(KINDS.chat[0], 'compose');
  for (const [k, [ico]] of Object.entries(KINDS)) if (k !== 'chat') assert.ok(!['compose', 'sparkle', 'alert'].includes(ico), `${k} runs borrow ${ico}`);
  assert.deepEqual(VIEWS.filter(v => v.svg === 'sparkle').map(v => v.id), ['claude']);
  assert.deepEqual(VIEWS.filter(v => v.svg === 'alert').map(v => v.id), ['signals']);
  assert.match(read('index.html'), /<symbol id="i-file"/);
  assert.match(app, /ico\('file'\)/, 'Files draws files with the file icon');
  assert.doesNotMatch(app, /ico\('compose'\)/);
});

test('no letter glyphs in menus: the old aside, the registry and the Audit log use the sprite', () => {
  const html = read('index.html'), ui = read('ui.js'), app = read('app.js');
  assert.doesNotMatch(html + ui, /class=\\?"navicon/);
  for (const v of VIEWS) assert.equal(v.icon, undefined, `${v.id} has a letter icon`);
  for (const d of DOMAINS) assert.equal(d.symbol, undefined, `${d.id} has a symbol glyph`);
  assert.doesNotMatch(app, /const icons\s*=\s*\{[^}]*'[✦⌕◇●↻□]'/);
});
