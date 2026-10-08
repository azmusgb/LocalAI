'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.resolve(__dirname, '../app/server.js'), 'utf8');

test('server consumes the model runtime module and preserves /api/models', () => {
  assert.match(server, /require\('\.\/model-runtime'\)/);
  assert.match(server, /loadOllamaModelRuntime\(/);
  assert.match(server, /p === '\/api\/models'/);
});

test('capability snapshot exposes installed and loaded text-model truth', () => {
  assert.match(server, /models: modelRuntime/);
  assert.match(server, /Installed text models:/);
  assert.match(server, /Loaded text models:/);
  assert.match(server, /Model runtime detail:/);
});

test('legacy apiModels fields remain present for existing clients', () => {
  assert.match(server, /default: MODEL/);
  assert.match(server, /models: \[MODEL\]/);
  assert.match(server, /installed:/);
  assert.match(server, /loaded:/);
});
