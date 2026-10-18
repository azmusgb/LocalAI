'use strict';
// Copy lint (plan A5): words the owner shouldn't meet on an owner page. Counts banned words in what the app shows:
// index.html's text, placeholders, titles and aria-labels outside developer-only pages, and the prose string
// literals of the scripts that render owner pages. Every owner page is at 0 now; keep it there.
// A file's ceiling may only go down: a new banned word is reworded in the glossary's words, not allowed through.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.resolve(__dirname, '../app/public');
const { VIEWS } = require(path.join(PUBLIC, 'view-registry.js'));

// The Copy rules' banned list. Extend it as terms retire (plan E1). RETIRED are the words the glossary in
// docs/USER-GUIDE.md replaces (run, change, service); the last test keeps the two lists the same.
const RETIRED = ['companion', 'execution', 'integration', 'change request'];
const BANNED = new RegExp(String.raw`\b(capabilit(?:y|ies)|runtimes?|orchestration|inventory|workspaces?|artifacts?|patch(?:es)?|${RETIRED.map(w => w.replace(/ /g, '\\s') + 's?').join('|')})\b`, 'gi');

// Developer-only pages: Improve, the four pages behind the developer switch (owner decision D1), and any section
// marked data-dev.
const DEV = new Set([...VIEWS.filter(v => v.domain === 'improve').map(v => v.id), 'workbench', 'repoTools', 'powershell', 'actions']);

const CEILING = {
  'index.html': 0,
  'app.js': 0,
  'ui.js': 0,
  'home.js': 0,
  'work.js': 0,
  'components.js': 0,
  'run-bodies.js': 0,
  'view-registry.js': 0,
  'offline-copy.js': 0
};

const decode = s => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

// What index.html shows outside developer pages: text between tags, and the placeholder/title/aria-label attributes.
function htmlStrings(html) {
  html = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '');
  const parts = html.split(/(?=<section\b)/i).filter(part => {
    const open = /^<section\b([^>]*)>/i.exec(part);
    if (!open) return true;
    const id = /\bid="([^"]+)"/.exec(open[1])?.[1];
    return !(DEV.has(id) || /\bdata-dev\b/.test(open[1]));
  });
  const out = [];
  for (const part of parts) {
    for (const m of part.matchAll(/\b(?:placeholder|title|aria-label)="([^"]*)"/g)) out.push(decode(m[1]));
    for (const t of part.replace(/<[^>]*>/g, '\n').split('\n')) if (t.trim()) out.push(decode(t.trim()));
  }
  return out;
}

// Prose literals in a script: quoted or template strings with a space in them, markup and ${…} removed. Paths,
// ids, class names and keys have no spaces, so they are left out. A view's `aka` list is never shown: it holds the
// old names ⌘K still finds a page by, so retired words belong there.
function scriptStrings(src) {
  const out = [];
  src = src.replace(/\baka:\s*\[[^\]]*\]/g, ' ');
  for (const m of src.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) {
    let s = m[1] ?? m[2] ?? m[3] ?? '';
    s = s.replace(/\$\{[^}]*\}/g, ' ').replace(/<[^>]*>/g, ' ').replace(/\b[\w-]+="[^"]*"/g, ' ');
    if (/\s/.test(s.trim()) && /[a-z]/i.test(s) && !/^[./#]/.test(s.trim())) out.push(s);
  }
  return out;
}

function count(file) {
  const src = fs.readFileSync(path.join(PUBLIC, file), 'utf8');
  const strings = file.endsWith('.html') ? htmlStrings(src) : scriptStrings(src);
  const hits = [];
  for (const s of strings) for (const m of s.matchAll(BANNED)) hits.push(`${m[0]}: ${s.trim().slice(0, 90)}`);
  return hits;
}

for (const [file, ceiling] of Object.entries(CEILING)) {
  test(`copy lint: ${file} has no more than ${ceiling} banned word(s) on owner pages`, () => {
    const hits = count(file);
    assert.ok(hits.length <= ceiling, `${file}: ${hits.length} banned word(s), ceiling ${ceiling}. New ones:\n${hits.join('\n')}`);
    assert.equal(hits.length, ceiling, `${file}: down to ${hits.length} from ${ceiling}. Lower its CEILING to ${hits.length} so it can't creep back.`);
  });
}

test('copy lint sees banned words where they are, and skips developer pages, markup and paths', () => {
  const html = '<section id="home" class="view"><p>Open your workspace</p><input placeholder="Runtime"></section><section id="powershell"><p>workspace</p></section><section id="x" data-dev><p>artifact</p></section>';
  assert.equal(htmlStrings(html).join('|').match(BANNED).length, 2);
  const js = "const a='/api/workspace',b='workspaceRoot',c=`<div class=\"artifact-card\">${x}</div>`,d='Saved to your workspace library',e={aka:['change requests','old workspace']};";
  assert.deepEqual(scriptStrings(js).join('|').match(BANNED), ['workspace']);
});

// The glossary in the user guide is the vocabulary (plan E1): each retired word is listed under "Instead of", and each
// word the glossary teaches is one the app actually shows, word for word.
test('the user guide glossary retires the same words and teaches words the app shows', () => {
  const guide = fs.readFileSync(path.resolve(__dirname, '../docs/USER-GUIDE.md'), 'utf8');
  const section = /^## Glossary\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(guide)?.[1];
  assert.ok(section, 'docs/USER-GUIDE.md has a ## Glossary section');
  const rows = section.split('\n').filter(l => /^\|\s*\*\*/.test(l)).map(l => l.split('|').slice(1, -1).map(c => c.trim()));
  assert.ok(rows.length >= 6, 'the glossary has its rows');
  const insteadOf = rows.map(r => r[2].toLowerCase()).join(', ');
  for (const w of RETIRED) assert.match(insteadOf, new RegExp(`\\b${w}\\b`), `"${w}" is retired, so the glossary lists it under Instead of`);
  const shown = [...Object.keys(CEILING), 'improve.js'].map(f => (f.endsWith('.html') ? htmlStrings : scriptStrings)(fs.readFileSync(path.join(PUBLIC, f), 'utf8')).join('\n'))
    .concat(VIEWS.map(v => `${v.label}\n${v.tab || ''}`)).join('\n');
  for (const [term] of rows) {
    const word = term.replace(/\*\*/g, '');
    assert.match(shown, new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'), `the app shows "${word}"`);
  }
});
