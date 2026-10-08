'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRuntimeSnapshot, loadOllamaModelRuntime } = require('../app/model-runtime');

test('buildRuntimeSnapshot merges installed and loaded model state', () => {
  const snapshot = buildRuntimeSnapshot(
    {
      models: [
        {
          name: 'qwen2.5-coder:7b',
          digest: 'abc',
          size: 4700000000,
          modified_at: '2026-10-01T12:00:00Z',
          details: {
            format: 'gguf',
            family: 'qwen2',
            families: ['qwen2'],
            parameter_size: '7.6B',
            quantization_level: 'Q4_K_M'
          }
        },
        { name: 'gemma3:4b', digest: 'def', size: 3300000000 }
      ]
    },
    {
      models: [
        {
          name: 'qwen2.5-coder:7b',
          model: 'qwen2.5-coder:7b',
          digest: 'abc',
          size: 4700000000,
          size_vram: 1200000000,
          context_length: 16384,
          expires_at: '2026-10-08T05:00:00Z'
        }
      ]
    },
    'qwen2.5-coder:7b'
  );

  assert.equal(snapshot.installedCount, 2);
  assert.equal(snapshot.loadedCount, 1);
  assert.equal(snapshot.defaultInstalled, true);
  assert.equal(snapshot.defaultLoaded, true);
  assert.equal(snapshot.runtimeAvailable, true);
  assert.equal(snapshot.installed[0].loaded, true);
  assert.equal(snapshot.installed[0].runtime.contextLength, 16384);
  assert.equal(snapshot.installed[0].runtime.sizeVramBytes, 1200000000);
  assert.equal(snapshot.installed[1].loaded, false);
});

test('loadOllamaModelRuntime treats /api/ps failure as runtime-detail degradation', async () => {
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    if (url.endsWith('/api/tags')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ models: [{ name: 'qwen2.5-coder:7b' }] })
      };
    }
    return {
      ok: false,
      status: 503,
      json: async () => ({})
    };
  };

  const snapshot = await loadOllamaModelRuntime({
    baseUrl: 'http://ollama:11434/',
    fetchWithTimeout: fakeFetch,
    defaultModel: 'qwen2.5-coder:7b'
  });

  assert.deepEqual(calls, [
    'http://ollama:11434/api/tags',
    'http://ollama:11434/api/ps'
  ]);
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.installedCount, 1);
  assert.equal(snapshot.loadedCount, 0);
  assert.equal(snapshot.runtimeAvailable, false);
  assert.match(snapshot.runtimeError, /HTTP 503/);
  assert.equal(snapshot.defaultInstalled, true);
});

test('loadOllamaModelRuntime fails when installed-model discovery fails', async () => {
  const fakeFetch = async () => ({
    ok: false,
    status: 502,
    json: async () => ({})
  });

  await assert.rejects(
    loadOllamaModelRuntime({
      baseUrl: 'http://ollama:11434',
      fetchWithTimeout: fakeFetch,
      defaultModel: 'qwen2.5-coder:7b'
    }),
    /HTTP 502/
  );
});
