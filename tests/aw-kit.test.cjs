'use strict';
// app/public/aw/kit.js: text from outside made safe for Agent World's canvas and lists.
const test = require('node:test');
const assert = require('node:assert/strict');
const { clean } = require('../app/public/aw/kit.js');

test('clean strips control and direction characters and keeps one line', () => {
  assert.equal(clean('Fix‮ gnirts\u0000\nnext\tline⁦x⁩'), 'Fix gnirts next line x');
  assert.equal(clean('  a ‏ b  '), 'a b');
  assert.equal(clean(null), '');
  assert.equal(clean(42), '42');
});

test('clean cuts to n characters with an ellipsis, counting code points', () => {
  assert.equal(clean('abcdefghij', 5), 'abcd…');
  assert.equal(clean('abcde', 5), 'abcde');
  assert.equal(clean('🚚🚚🚚🚚', 3), '🚚🚚…');
  assert.equal(clean('x'.repeat(200)).length, 80);
});
