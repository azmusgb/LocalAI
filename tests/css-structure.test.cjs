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
// sees (the run view's --run-vvh backdrop rule went that way once). So every class the newest markup creates must be
// styled somewhere: the shared components, the run bodies, Home, Work and the run view (ui.js's execution runtime).
// A class built by concatenation ('run-card__preview--'+type, `chat-turn--${kind}`) counts if any rule starts with that prefix.
const PUBLIC = path.join(__dirname, '..', 'app', 'public');
const SOURCES = {
  'components.js': src => src,
  'run-bodies.js': src => src,
  'home.js': src => src,
  'work.js': src => src,
  'ui.js': src => { const a = src.indexOf('// ==== execution-runtime.js'), b = src.indexOf('// ===== Long lists', a); assert.ok(a >= 0 && b > a, 'ui.js: the execution-runtime section moved; update this test'); return src.slice(a, b); }
};
// Hooks for scripts and tests, not for styling.
const UNSTYLED = new Set(['ask-sheet__cancel', 'chat-body__retry', 'home-sheet__done']);
const HOLE = '\u0000', LIT = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
// The classes a piece of JS creates: className = …, cls = …, class="…", h('tag', '…'), classList.add/toggle('…'). In a className
// expression, a class literal starts it or is a ternary branch ('a' + (x ? 'b' : 'c')); a literal glued to what follows
// ('badge--' + tone, `chat-turn--${kind}`) ends in a prefix, written 'badge--*'.
function classesIn(src) {
  const out = new Set();
  src = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
  const take = (text, glued = false) => {
    const toks = text.replace(/\$\{[^}]*\}/g, HOLE).split(/(\s+)/);
    toks.forEach((tok, i) => {
      if (!tok.trim() || tok.startsWith(HOLE)) return;
      const h = tok.indexOf(HOLE), name = h >= 0 ? tok.slice(0, h) + '*' : glued && i === toks.length - 1 ? tok + '*' : tok;
      if (/^[A-Za-z_][\w-]*\*?$/.test(name)) out.add(name);
    });
  };
  for (const m of src.matchAll(/\.className\s*=\s*([^;,\n]+)/g)) {
    const rhs = m[1];
    for (const l of rhs.matchAll(LIT)) {
      const before = rhs.slice(0, l.index).trimEnd(), after = rhs.slice(l.index + l[0].length).trimStart();
      if (before === '' || /[?:]$/.test(before) && !/[=!]==?$/.test(before)) take(l[2], after.startsWith('+'));
    }
  }
  for (const m of src.matchAll(/\bcls\s*=\s*(`(?:[^`$]|\$\{(?:[^{}]|\{[^{}]*\})*\})*`|'[^']*')/g)) take(m[1].slice(1, -1)); // const cls = `chat-turn chat-turn--${who}`
  for (const m of src.matchAll(/\bclass="([^"]*)"/g)) take(m[1]);
  for (const m of src.matchAll(/\bh\(\s*'[\w-]+'\s*,\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)) take(m[2]);
  for (const m of src.matchAll(/classList\.(?:add|toggle)\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)) take(m[2]);
  return out;
}
const styled = (defined, c) => c.endsWith('*') ? defined.some(d => d.startsWith(c.slice(0, -1))) : defined.includes(c);
// The kit's components.css styles its own ui-* classes (appliance-ui, synced); a class either file styles counts.
const definedClasses = () => [...new Set(['app.css', 'ui/components.css'].flatMap(f => [...fs.readFileSync(path.join(PUBLIC, f), 'utf8').matchAll(/\.([A-Za-z_][\w-]*)/g)].map(m => m[1])))];
test('every class the new markup creates has a rule in app.css', () => {
  const defined = definedClasses(), missing = [];
  for (const [file, part] of Object.entries(SOURCES)) {
    const used = classesIn(part(fs.readFileSync(path.join(PUBLIC, file), 'utf8')));
    assert.ok(used.size > 3, `${file}: found almost no classes; the matcher no longer fits this file`);
    for (const c of used) if (!UNSTYLED.has(c) && !styled(defined, c)) missing.push(`${file}: ${c}`);
  }
  assert.deepEqual(missing, [], `classes with no rule in app.css:\n${missing.join('\n')}`);
});
// The guard must actually catch a dropped rule, in each file it reads.
test('the class guard fails when a rule a file needs is missing', () => {
  const defined = definedClasses();
  for (const [file, part] of Object.entries(SOURCES)) {
    const used = [...classesIn(part(fs.readFileSync(path.join(PUBLIC, file), 'utf8')))].filter(c => !UNSTYLED.has(c) && !c.endsWith('*'));
    const victim = used.find(c => !['muted', 'btn-primary', 'btn-outline', 'card'].includes(c)) || used[0];
    assert.equal(styled(defined.filter(d => d !== victim), victim), false, `${file}: dropping .${victim} went unnoticed`);
  }
  assert.deepEqual([...classesIn("a.className = `chat-turn chat-turn--${who}`; b.className = x === 'Error' ? 'status-error' : 'muted'; d.className='ask-sheet ask-sheet--'+(o.tone||'default'); h('div', 'chat-body'); s.classList.add('run-body-image'); c.innerHTML = '<div class=\"work-group\">'; // h('div', 'cls')")].sort(),
    ['ask-sheet', 'ask-sheet--*', 'chat-body', 'chat-turn', 'chat-turn--*', 'muted', 'run-body-image', 'status-error', 'work-group'].sort());
  // the two load-bearing run-view rules, by name
  const css = fs.readFileSync(path.join(PUBLIC, 'app.css'), 'utf8');
  assert.match(css, /--run-vvh/, 'the run view backdrop sizes to the visual viewport (--run-vvh)');
  assert.match(css, /\.run-drawer\b/, '.run-drawer has rules');
});

// The design-system section owns how titles, cards, buttons and fields look. Older layers that prefix their
// selectors with body.ux-v3 out-rank it, so any paint they set there wins and the page shows two designs at once.
test('the old navigation layer does not repaint what the design system owns', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'app', 'public', 'app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const owned = /^(h1|h2|\.sub|\.card|\.item-card|\.btn|\.btn\.primary|input|textarea|select)(:hover|:focus)?$/;
  const paint = /^(color|background|background-color|border-color|border-radius|font-size|font|letter-spacing|line-height|outline)$/;
  const found = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sels = m[1].split(',').map(s => s.trim()).filter(s => s.startsWith('body.ux-v3 ') && owned.test(s.slice('body.ux-v3 '.length)));
    if (!sels.length) continue;
    const props = m[2].split(';').map(d => d.split(':')[0].trim()).filter(p => paint.test(p));
    if (props.length) found.push(`${sels.join(',')} { ${props.join(', ')} }`);
  }
  assert.deepEqual(found, []);
});
