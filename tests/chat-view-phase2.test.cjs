'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('run-bodies.js adopts Amendment A30 Phase 2 semantic chat kit tokens', () => {
  const code = fs.readFileSync(path.join(__dirname, '../app/public/run-bodies.js'), 'utf8');

  // Verify chat thread adoption
  assert.ok(code.includes('ui-chat-thread'), 'turns container has ui-chat-thread class');

  // Verify composer and action adoption
  assert.ok(code.includes('ui-chat-composer'), 'reply form has ui-chat-composer class');
  assert.ok(code.includes('ui-chat-composer__input'), 'reply textarea has ui-chat-composer__input class');
  assert.ok(code.includes('ui-chat-composer__action'), 'send button has ui-chat-composer__action class');

  // Verify message bubble adoption
  assert.ok(code.includes('ui-chat-msg'), 'message bubble has ui-chat-msg class');
  assert.ok(code.includes('ui-chat-msg--streaming'), 'streaming message bubble has ui-chat-msg--streaming class');
});
