'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { clean, withContext, homeUrl } = require('../app/public/ask-context');

test('clean keeps plain text, at most 300 characters', () => {
  assert.equal(clean('  Pi Hub ›  Workshop:\nPrinting\u0007 40% '), 'Pi Hub › Workshop: Printing 40%');
  const long = clean('x'.repeat(5000));
  assert.equal(long.length, 300);
  assert.ok(long.endsWith('…'));
  assert.equal(clean(null), '');
  assert.equal(clean('   '), '');
  assert.equal(clean('<img src=x onerror=alert(1)>'), '<img src=x onerror=alert(1)>'); // shown as text, never parsed
});

test('withContext adds the context after the question', () => {
  assert.equal(withContext('Why is it slow?', ''), 'Why is it slow?');
  assert.equal(withContext('Why is it slow?', 'Pi Hub › Home & network: Internet slow'),
    'Why is it slow?\n\nContext: Pi Hub › Home & network: Internet slow');
});

test('homeUrl goes to the hub by the name or the old address', () => {
  assert.equal(homeUrl('assistant.home.arpa'), 'https://home.home.arpa/');
  assert.equal(homeUrl('home.arpa'), 'https://home.home.arpa/');
  assert.equal(homeUrl('10.0.0.21'), 'http://10.0.0.30/');
  assert.equal(homeUrl('localhost'), 'http://10.0.0.30/');
});
