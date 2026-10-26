'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPiHub, summarize, playingItem } = require('../app/pi-hub');
const { buildFeed } = require('../app/display-feed');

test('playing items of any reasonable shape become a title, progress, state and where', () => {
  assert.deepEqual(playingItem('Arrival'), { title: 'Arrival' });
  assert.deepEqual(playingItem({ title: 'Arrival', progress: 42.4, state: 'Paused', player: 'Living Room TV' }), { title: 'Arrival', progress: 42, state: 'paused', where: 'Living Room TV', minutesLeft: null, poster: null });
  // The hub's committed shape (pi-hub tests/test_evolve.py).
  const hub = playingItem({ title: 'Severance: Woe\'s Hollow', show: 'Severance', year: null, kind: 'episode', who: 'bill', device: 'Living Room', state: 'playing', progress: 61, minutes_left: 19, poster: '/api/now/poster/0.jpg' });
  assert.deepEqual([hub.where, hub.minutesLeft, hub.poster], ['Living Room', 19, '/api/now/poster/0.jpg']);
  assert.equal(playingItem({ title: 'x', poster: 'http://evil/x.jpg' }).poster, null);
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
  const pi = summarize({ issues: [{ tone: 'bad', what: 'Movies drive', say: 'It dropped out.' }], movies: { playing: [{ title: 'Arrival', progress: 42, device: 'TV', poster: '/api/now/poster/0.jpg' }, 'Other'] } });
  const feed = buildFeed({ needs: { count: 0 }, pi, images: [{ title: 'A fox', imageUrl: '/api/images/view?filename=a.png' }] });
  const cards = feed.cards;
  assert.deepEqual(feed.images.map(i => i.imageUrl), ['/api/display/poster?n=0', '/api/images/view?filename=a.png'], 'the poster leads the pictures');
  assert.equal(buildFeed({ needs: { count: 0 }, pi: summarize({ movies: { playing: [{ title: 'A', state: 'paused', minutes_left: 5 }] } }) }).cards[1].text, 'A · paused');
  assert.equal(buildFeed({ needs: { count: 0 }, pi: summarize({ movies: { playing: [{ title: 'A', minutes_left: 5 }] } }) }).cards[1].text, 'A · 5 min left');
  assert.deepEqual(cards.map(c => c.kind), ['needs', 'home', 'playing', 'image']);
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

test('needs: the hub list is read at most every 30 s, plain strings only, and a failure is quiet (null)', async () => {
  let t = 0, calls = 0, url;
  const hub = createPiHub({ url: 'http://pi', now: () => t, fetchImpl: async (u) => { calls++; url = String(u); return { ok: true, json: async () => ({ count: 1, items: [{ id: 'pi:disk', source: 'pi', tone: 'bad', title: 'Disk', detail: 'Full', link: '/x' }, 7], unread: 0 }) }; } });
  assert.deepEqual(await hub.needs(), { items: [{ id: 'pi:disk', source: 'pi', tone: 'bad', title: 'Disk', detail: 'Full' }] });
  assert.equal(url, 'http://pi/api/needs');
  await hub.needs();
  assert.equal(calls, 1);
  t += 31000;
  await hub.needs();
  assert.equal(calls, 2);
  assert.equal(await createPiHub({ url: 'http://pi', fetchImpl: async () => { throw new Error('down'); } }).needs(), null);
  assert.equal(await createPiHub({ url: 'http://pi', fetchImpl: async () => ({ ok: false }) }).needs(), null);
  assert.equal(await createPiHub({ url: 'http://pi', fetchImpl: async () => ({ ok: true, json: async () => ({ items: 'no' }) }) }).needs(), null);
  assert.equal(await createPiHub({ url: 'off' }).needs(), null);
});
