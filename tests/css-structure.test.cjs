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
