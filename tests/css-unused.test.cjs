'use strict';

// Dead CSS guard: every class and id that app.css styles must be referenced somewhere in app/public's markup or
// scripts, so rules for removed markup don't pile up again. Needs no npm packages.
//
// A name counts as referenced when it appears as a whole word in any .html or .js file in app/public (class="…",
// id="…", getElementById('…'), querySelector('.…'), classList.add('…'), className = `… ${x}`, h('div', '…') all
// contain it literally), or when the scripts build it from a literal prefix: 'badge--' + tone or `chat-turn--${kind}`
// makes every badge--… and chat-turn--… name referenced.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', 'app', 'public');

// Names no file in app/public spells out or builds from a literal prefix. Each says where it comes from.
const ALLOWLIST = new Map([
  // Service states come from the server as data: '.state.' + s.status, 'dot ' + s.status.
  ['HEALTHY', 'service status from /api/status'],
  ['DEGRADED', 'service status from /api/status'],
  ['DOWN', 'service status from /api/status'],
  ['OPTIONAL_OFFLINE', 'service status from /api/status'],
  // Integrations' live check: element.className = `ux-int-live ${String(state).toLowerCase()}` (ui.js).
  ['degraded', 'lower-cased integration state']
]);

function sources() {
  const out = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(html|js|mjs)$/.test(e.name)) out.push(fs.readFileSync(p, 'utf8'));
    }
  };
  walk(PUBLIC);
  return out.join('\n');
}

// The class and id names in app.css's selectors (not in declarations, so colours like #fff are not ids).
function selectorNames(css) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""');
  const names = new Map();
  for (const m of css.matchAll(/(^|[{};])([^{};]*)\{/g)) {
    const prelude = m[2].trim();
    if (!prelude || prelude.startsWith('@')) continue;
    for (const n of prelude.replace(/\[[^\]]*\]/g, '').matchAll(/([.#])(-?[A-Za-z_][\w-]*)/g)) names.set(n[1] + n[2], n[2]);
  }
  return names;
}

function unreferenced(css, src) {
  const words = new Set(src.match(/[A-Za-z_][\w-]*/g));
  const builtFrom = name => {
    for (let i = name.length - 1; i > 0; i--) {
      if (name[i] !== '-' && name[i] !== '_') continue;
      const prefix = name.slice(0, i + 1);
      if (['\'', '"', '`', '${'].some(end => src.includes(prefix + end))) return true;
    }
    return false;
  };
  return [...selectorNames(css)].filter(([, n]) => !words.has(n) && !ALLOWLIST.has(n) && !builtFrom(n)).map(([k]) => k).sort();
}

test('every class and id app.css styles is used in app/public', () => {
  const dead = unreferenced(fs.readFileSync(path.join(PUBLIC, 'app.css'), 'utf8'), sources());
  assert.deepEqual(dead, [], `app.css styles names nothing in app/public uses; delete their rules (or, for a name built at run time, add it to ALLOWLIST with its source):\n${dead.join('\n')}`);
});

test('the dead-CSS check sees literal, prefixed and allowlisted names', () => {
  const css = '.used{} .gone{} #alsoGone>.used{} .badge--good{} .chip:not(.x){} .HEALTHY{} @media(max-width:9px){.inner{color:#abc}}';
  const src = '<div class="used inner chip x"></div> el.className = "badge--" + tone;';
  assert.deepEqual(unreferenced(css, src), ['#alsoGone', '.gone']);
});
