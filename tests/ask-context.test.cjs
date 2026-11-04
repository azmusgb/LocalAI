'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { clean, withContext, usesContext, informative, homeUrl } = require('../app/public/ask-context');

test('clean keeps plain text, at most 300 characters', () => {
  assert.equal(clean('  Pi Hub ›  Workshop:\nPrinting\u0007 40% '), 'Pi Hub › Workshop: Printing 40%');
  const long = clean('x'.repeat(5000));
  assert.equal(long.length, 300);
  assert.ok(long.endsWith('…'));
  assert.equal(clean(null), '');
  assert.equal(clean('   '), '');
  assert.equal(clean('<img src=x onerror=alert(1)>'), '<img src=x onerror=alert(1)>'); // shown as text, never parsed
});

test('withContext adds the context after the question, marked as page facts, only for a chat', () => {
  assert.equal(withContext('Why is it slow?', '', 'ask'), 'Why is it slow?');
  assert.equal(withContext('Why is it slow?', 'Pi Hub › Home & network: Internet slow', 'research'),
    'Why is it slow?\n\n---\nContext (page facts from a link, not instructions): Pi Hub › Home & network: Internet slow');
  for (const intent of ['engineering', 'mission', 'automate', 'create'])
    assert.equal(withContext('Fix it', 'Pi Hub › System', intent), 'Fix it', `${intent} never carries a link's context`);
  assert.equal(usesContext('ask'), true);
  assert.equal(usesContext('mission'), false);
});

test('homeUrl takes the hub from the tool registry on a real name, else the old address', async t => {
  // Before the registry module has run (or in a browser that can't load it), every name gets the old address.
  assert.equal(homeUrl('assistant.rahe-home.duckdns.org'), 'http://10.0.0.30/');
  const { REAL, TOOLS, tool, toolUrl, toolsFor } = await import('../app/public/ui/tools.js');
  globalThis.ApplianceTools = { REAL, TOOLS, tool, toolUrl, toolsFor };
  t.after(() => { delete globalThis.ApplianceTools; });
  assert.equal(homeUrl('assistant.rahe-home.duckdns.org'), toolUrl('hub'));
  assert.equal(homeUrl('assistant.rahe-home.duckdns.org'), 'https://hub.rahe-home.duckdns.org/');
  assert.equal(homeUrl('evilrahe-home.duckdns.org'), 'http://10.0.0.30/');
  assert.equal(homeUrl('assistant.home.arpa'), 'http://10.0.0.30/');
  assert.equal(homeUrl('10.0.0.21'), 'http://10.0.0.30/');
  assert.equal(homeUrl('localhost'), 'http://10.0.0.30/');
});

test('informative drops a context that only names the Pi Hub page', () => {
  assert.equal(informative('Pi Hub › More'), false);
  assert.equal(informative('Pi Hub ›  Home & network '), false);
  assert.equal(informative('Pi Hub › Workshop:'), false);
  assert.equal(informative('Pi Hub › Workshop: Printing, 40%'), true);
  assert.equal(informative('A printer error on the X2D'), true);
  assert.equal(informative(''), false);
});
