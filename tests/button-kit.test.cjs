'use strict';
// One button kit (plan E4): .btn-primary, .btn-outline, .btn-danger and .icon-btn. The old .btn / .btn primary /
// .btn danger / .iconbtn are gone from every page except Missions (#agents), which keeps its own until its redesign.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.resolve(__dirname, '../app/public');
const read = f => fs.readFileSync(path.join(PUBLIC, f), 'utf8');
// The Missions view and the Agent World / specialist sections of ui.js are out of scope (owner: separate redesign).
function outsideMissions(file, src) {
  const cut = (s, a, b) => (a < 0 || b < 0 ? s : s.slice(0, a) + s.slice(b));
  if (file === 'index.html') return cut(src, src.indexOf('<section id="agents"'), src.indexOf('<section id="automationStudio"'));
  if (file === 'ui.js') for (const n of ['agent-specialists.js', 'agent-world-city.js']) { const a = src.indexOf(`// ==== ${n} ====`); src = cut(src, a, src.indexOf('\n// ==== ', a + 10)); }
  return src;
}
const OLD = /\b(?:class(?:Name)?\s*=\s*\\?["'`]|(?:el|h)\(\s*'[a-z]+'\s*,\s*')(?:[^"'`\n]*\s)?(btn|iconbtn)(?=[\s"'`\\])/g;

test('no page outside Missions uses the old .btn or .iconbtn classes', () => {
  const hits = [];
  for (const f of ['index.html', 'app.js', 'ui.js', 'work.js', 'components.js', 'home.js', 'improve.js', 'run-bodies.js', 'qr.js', 'spreadsheets.js']) {
    for (const m of outsideMissions(f, read(f)).matchAll(OLD)) hits.push(`${f}: ${m[0].slice(0, 60)}`);
  }
  assert.deepEqual(hits, []);
});

test('the stylesheet defines the kit once and styles .btn only inside Missions', () => {
  const css = read('app.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const stray = [];
  for (const m of css.matchAll(/([^{}]+)\{[^{}]*\}/g)) for (const s of m[1].split(',')) {
    if (/\.iconbtn\b/.test(s) || (/\.btn(?![\w-])/.test(s) && !/#agents|\.agent-/.test(s))) stray.push(s.trim());
  }
  assert.deepEqual(stray, [], 'old button selectors');
  for (const k of ['btn-primary', 'btn-outline', 'btn-danger', 'icon-btn']) assert.match(css, new RegExp(`\\.${k}\\b[^{]*\\{`), `.${k} is defined`);
});
