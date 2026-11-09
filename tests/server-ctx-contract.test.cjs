'use strict';

// The area modules in app/server/*.js are built as createX(ctx) from app/server.js and destructure what they use from
// ctx. A name a module destructures that server.js does not pass is undefined until the code that uses it runs, so the
// server starts and one route fails later. This reads both sides as text and fails at once.
// The same check lists names a module is given but never uses, so the ctx objects can be narrowed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.resolve(__dirname, '../app');
const SERVER = fs.readFileSync(path.join(APP, 'server.js'), 'utf8');

// The top-level keys of the object literal whose '{' is at text[open]: `a`, `a: expr`, `'a': expr`, `[...]` and `...spread`
// entries, skipping nested brackets, strings and template literals.
function objectKeys(text, open) {
  const keys = [];
  let depth = 0;
  let entry = '';
  const flush = () => {
    const e = entry.trim();
    entry = '';
    if (!e) return;
    if (e.startsWith('...')) { keys.push({ spread: e }); return; }
    const m = /^(?:['"]([^'"]+)['"]|([A-Za-z_$][\w$]*))\s*(?::|$|\()/.exec(e);
    if (m) keys.push({ name: m[1] || m[2] });
    else keys.push({ unparsed: e.slice(0, 40) });
  };
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      if (depth > 1) { i = j; continue; }
      entry += text.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === '{' || c === '(' || c === '[') {
      depth++;
      if (depth === 1) continue;
    } else if (c === '}' || c === ')' || c === ']') {
      depth--;
      if (depth === 0) { flush(); return keys; }
    } else if (c === ',' && depth === 1) { flush(); continue; }
    if (depth >= 1) entry += c;
  }
  throw new Error('unterminated object literal in server.js');
}

// { module file, factory name, names passed } for every require('./server/x').createY({ ... }) call in server.js.
function wiredModules() {
  const re = /require\('\.\/server\/([a-z-]+)'\)\.(create[A-Za-z]+)\(\{/g;
  const out = [];
  for (let m; (m = re.exec(SERVER));) {
    const keys = objectKeys(SERVER, m.index + m[0].length - 1);
    out.push({ file: `${m[1]}.js`, factory: m[2], keys });
  }
  return out;
}

// The names a module destructures from ctx on one `const { ... } = ctx;` line, or null when it takes no ctx that way.
function destructured(source) {
  const m = /const \{([^}]*)\} = ctx;/.exec(source);
  if (!m) return null;
  return m[1].split(',').map(s => s.trim()).filter(Boolean).map(s => s.split(':').pop().trim());
}

const wired = wiredModules();
const unusedByModule = {};

test('server.js wires the area modules this test can see', () => {
  assert.ok(wired.length >= 15, `found only ${wired.length} createX(ctx) calls in app/server.js`);
});

for (const { file, factory, keys } of wired) {
  const source = fs.readFileSync(path.join(APP, 'server', file), 'utf8');
  const wanted = destructured(source);
  if (!wanted) continue;

  test(`server.js passes ${factory} every ctx name app/server/${file} destructures`, () => {
    const unparsed = keys.filter(k => k.unparsed);
    assert.deepEqual(unparsed, [], `${factory}: ctx entries this test cannot read`);
    if (keys.some(k => k.spread)) return; // a spread supplies names this test cannot list
    const given = new Set(keys.map(k => k.name));
    const missing = wanted.filter(n => !given.has(n));
    assert.deepEqual(missing, [], `${factory} destructures ${missing.join(', ')} from ctx but server.js does not pass it`);
  });
  unusedByModule[factory] = keys.filter(k => k.name && !new RegExp(`(?<![\\w$.])${k.name.replace(/\$/g, '\\$')}(?![\\w$])`).test(source.replace(/const \{[^}]*\} = ctx;/, ''))).map(k => k.name);
}

test('no createX(ctx) call is given a name its module never uses', { todo: 'narrow the ctx objects' }, () => {
  const unused = Object.fromEntries(Object.entries(unusedByModule).filter(([, names]) => names.length));
  assert.deepEqual(unused, {});
});
