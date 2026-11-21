'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createChatReaders } = require('../app/chat-readers');

test('createChatReaders exposes the 4 Amendment A30 D2 read-only tools', () => {
  const fakePiHub = {
    now: async () => ({ status: 'ok', nowPlaying: { title: 'Dune' } }),
    prints: async () => ({ ok: true, prints: [{ id: 'p1', name: 'Gridfinity' }] }),
    needs: async () => ({ count: 1, items: [{ title: 'Filter change' }] }),
    printer: async () => ({ status: 'printing', bedTemp: 60, nozzleTemp: 220 })
  };

  const tools = createChatReaders({ piHub: fakePiHub });
  assert.equal(tools.length, 4);

  const names = tools.map(t => t.name);
  assert.ok(names.includes('read_hub_now'));
  assert.ok(names.includes('read_hub_prints'));
  assert.ok(names.includes('read_hub_needs'));
  assert.ok(names.includes('read_hub_printer'));
});

test('chat readers mark output as untrusted and return structured card evidence', async () => {
  const fakePiHub = {
    now: async () => ({ status: 'ok', summary: 'System healthy' }),
    prints: async () => ({ ok: false, source: 'pi-hub' }),
    needs: async () => null,
    printer: async () => ({ status: 'idle' })
  };

  const tools = createChatReaders({ piHub: fakePiHub });
  const readNow = tools.find(t => t.name === 'read_hub_now');
  const resNow = await readNow.execute({});

  assert.ok(resNow.evidence.length > 0);
  assert.ok(resNow.evidence[0].source.startsWith('pi-hub:now'));
  assert.equal(resNow.data.status, 'ok');

  const readNeeds = tools.find(t => t.name === 'read_hub_needs');
  const resNeeds = await readNeeds.execute({});
  assert.equal(resNeeds.data.available, false);
  assert.equal(resNeeds.data.reason, 'source_down');
});
