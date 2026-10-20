'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPiHub, summarize, playingItem } = require('../app/pi-hub');
const { buildFeed } = require('../app/display-feed');

test('playing items of any reasonable shape become a title, progress, state and where', () => {
  assert.deepEqual(playingItem('Arrival'), { title: 'Arrival' });
  assert.deepEqual(playingItem({ title: 'Arrival', progress: 42.4, state: 'Paused', player: 'Living Room TV' }), { title: 'Arrival', progress: 42, state: 'paused', where: 'Living Room TV' });
  assert.equal(playingItem({ show: 'Severance', episode: 'S2 · E3', percent: 0.5 }).progress, 50);
  assert.equal(playingItem({ show: 'Severance', episode: 'S2 · E3' }).title, 'Severance · S2 · E3');
  assert.equal(playingItem({}), null);
  assert.equal(playingItem(null), null);
});

test('the hub summary keeps up to 3 playing and 2 issues; odd answers give nothing', () => {
  const s = summarize({ issues: [{ tone: 'bad', what: 'Movies drive', say: 'It dropped out.' }, { what: 'x' }, { what: 'y' }], movies: { playing: ['a', 'b', 'c', 'd'] } });
  assert.equal(s.playing.length, 3);
  assert.deepEqual(s.issues.map(i => [i.what, i.tone]), [['Movies drive', 'bad'], ['x', 'warn']]);
  assert.deepEqual(summarize(null), { playing: [], issues: [] });
});

test('the display feed shows Now playing and the Pi issue', () => {
  const pi = summarize({ issues: [{ tone: 'bad', what: 'Movies drive', say: 'It dropped out.' }], movies: { playing: [{ title: 'Arrival', progress: 42, player: 'TV' }, 'Other'] } });
  const cards = buildFeed({ needs: { count: 0 }, pi }).cards;
  assert.deepEqual(cards.map(c => c.kind), ['needs', 'home', 'playing']);
  assert.equal(cards[1].title, 'Pi: Movies drive');
  assert.equal(cards[1].tone, 'attention');
  assert.equal(cards[2].text, 'Arrival · 42% · TV · 1 more');
  assert.equal(cards[2].percent, 42);
});

test('the hub is read at most once a minute, and a failure is quiet', async () => {
  let t = 0, calls = 0;
  const hub = createPiHub({ url: 'http://pi', now: () => t, fetchImpl: async () => { calls++; return { ok: true, json: async () => ({ movies: { playing: ['A'] } }) }; } });
  assert.equal((await hub.read()).playing[0].title, 'A');
  await hub.read();
  assert.equal(calls, 1);
  t += 61000;
  await hub.read();
  assert.equal(calls, 2);
  const down = createPiHub({ url: 'http://pi', fetchImpl: async () => { throw new Error('down'); } });
  assert.equal(await down.read(), null);
  assert.equal(await createPiHub({ url: 'off' }).read(), null);
});
