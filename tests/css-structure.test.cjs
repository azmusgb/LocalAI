'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Browsers close an unterminated block at end of file, so a missing `}` renders fine until someone appends a rule,
// which then silently lands inside the open @media block.
test('every stylesheet closes all of its blocks', () => {
  const dir = path.join(__dirname, '..', 'app', 'public');
  for (const name of fs.readdirSync(dir).filter(f => f.endsWith('.css'))) {
    const css = fs.readFileSync(path.join(dir, name), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""');
    let depth = 0;
    for (const ch of css) {
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; assert.ok(depth >= 0, `${name}: a } closes nothing`); }
    }
    assert.equal(depth, 0, `${name}: ${depth} block(s) left open at end of file`);
  }
});

// A merge that keeps only one side of an app.css conflict drops rules without breaking anything a behaviour test
// sees. The shared components are the newest markup, so every class they create must be styled somewhere.
// A class built by concatenation ('run-card__preview--'+type) counts if any rule starts with that prefix.
test('every class the shared components create has a rule in app.css', () => {
  const dir = path.join(__dirname, '..', 'app', 'public');
  const css = fs.readFileSync(path.join(dir, 'app.css'), 'utf8');
  const defined = [...new Set([...css.matchAll(/\.([A-Za-z_][\w-]*)/g)].map(m => m[1]))];
  const src = fs.readFileSync(path.join(dir, 'components.js'), 'utf8');
  const used = new Set();
  for (const m of src.matchAll(/className\s*=\s*(["'`])([^"'`]*)\1|class="([^"$]*)"/g))
    for (const c of (m[2] ?? m[3]).split(/\s+/)) if (/^[A-Za-z_][\w-]*$/.test(c)) used.add(c);
  // Hooks for scripts and tests, not for styling.
  const unstyled = new Set(['ask-sheet__cancel']);
  const missing = [...used].filter(c => !unstyled.has(c) && !(c.endsWith('-') ? defined.some(d => d.startsWith(c)) : defined.includes(c)));
  assert.deepEqual(missing, [], `classes with no rule in app.css: ${missing.join(' ')}`);
});
