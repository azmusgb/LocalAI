'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const ui = fs.readFileSync(path.join(root, 'app/public/ui.js'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'app/public/sw.js'), 'utf8');

test('Models surface consumes live model runtime truth', () => {
  assert.match(ui, /id = 'models'/);
  assert.match(ui, /fetch\('\/api\/models'/);
  assert.match(ui, /models\.installed/);
  assert.match(ui, /models\.loaded/);
  assert.match(ui, /contextLength/);
  assert.match(ui, /sizeVramBytes/);
  assert.match(ui, /Loaded \/ installed models/);
});

test('Attention flags inventory and default-model problems without treating idle unload as failure', () => {
  assert.match(ui, /Model inventory could not be verified/);
  assert.match(ui, /Configured default model is not installed/);
  assert.match(ui, /Active model residency is unavailable/);
  assert.match(ui, /Ollama loads models on demand and may unload them after idle time/);

  const attentionStart = ui.indexOf('function attentionItems');
  const attentionEnd = ui.indexOf('function renderAttention', attentionStart);
  assert.ok(attentionStart >= 0 && attentionEnd > attentionStart);
  const attentionSource = ui.slice(attentionStart, attentionEnd);
  assert.doesNotMatch(attentionSource, /loadedCount\s*===\s*0/);
  assert.doesNotMatch(attentionSource, /!.*loadedCount/);
});

test('service worker keeps the model runtime shell assets cacheable across cache-key revisions', () => {
  assert.match(sw, /const CACHE='local-ai-shell-v1\.18-[^']+'/);
  assert.match(sw, /'\/ui\.js'/);
});
