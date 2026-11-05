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
  assert.deepEqual(await hub.needs(), { count: 1, items: [{ id: 'pi:disk', source: 'pi', tone: 'bad', title: 'Disk', detail: 'Full', link: '/x', action: '' }] });
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

// Local AI's feed reads Pi Hub's needs, and Pi Hub's needs read Local AI's feed: a second fetch while one is out would
// start a request chain between the two. While one fetch is in progress, callers get the last value (or null) at once.
test('needs: one fetch at a time; callers meanwhile get the last value (or null) at once', async () => {
  let t = 0, calls = 0, release;
  const hub = createPiHub({ url: 'http://pi', now: () => t, fetchImpl: async () => {
    calls++;
    await new Promise((r) => { release = r; });
    return { ok: true, json: async () => ({ count: 9, items: [{ id: 'a', title: 'A' }] }) };
  } });
  const first = hub.needs();
  const others = await Promise.all(Array.from({ length: 9 }, () => hub.needs()));
  assert.deepEqual(others, Array(9).fill(null), 'no last value yet: null');
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await first, { count: 9, items: [{ id: 'a', source: '', tone: '', title: 'A', detail: '', link: '', action: '' }] });
  t += 31000;
  const again = hub.needs();
  assert.equal((await hub.needs()).count, 9, 'the last value while the next fetch is out');
  assert.equal(calls, 2);
  release();
  await again;
});

test('needs: the hub\'s count passes on; without one it is the number of items', async () => {
  const hub = (body) => createPiHub({ url: 'http://pi', fetchImpl: async () => ({ ok: true, json: async () => body }) });
  assert.equal((await hub({ count: 14, items: [{ id: 'a', title: 'A' }] }).needs()).count, 14);
  assert.equal((await hub({ count: 'x', items: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }] }).needs()).count, 2);
});

test('needs: an item keeps only a plain path on the hub as its link', async () => {
  const items = [{ id: 'a', title: 'A', link: '/workshop' }, { id: 'b', title: 'B', link: 'tool:assistant' }, { id: 'c', title: 'C', link: 'https://evil.example/' },
    { id: 'd', title: 'D', link: '//evil.example/x' }, { id: 'e', title: 'E' }, { id: 'f', title: 'F', link: '/pi?x=<b>' }];
  const hub = createPiHub({ url: 'http://pi', fetchImpl: async () => ({ ok: true, json: async () => ({ count: 6, items }) }) });
  assert.deepEqual((await hub.needs()).items.map(i => i.link), ['/workshop', '', '', '', '', '']);
});


const { printerRecord } = require('../app/pi-hub');
const printerBody = (over = {}) => ({ records: [{ id: 'printer', source: 'bambuddy', as_of: 1000, state: 'printing',
  stale: false, detail: { progress: 42, minutes_left: 12, token: 'must-not-leak' }, ...over }] });

test('printer: designated household record, bounded fields, source time and no source secrets', () => {
  const p = printerRecord(printerBody(), 1010000);
  assert.deepEqual(p, { setUp: true, access: 'ok', state: 'printing', progress: 42, minutesLeft: 12,
    errorCode: null, source: 'bambuddy', via: 'pi-hub', seenAt: '1970-01-01T00:16:40.000Z' });
  assert.equal(JSON.stringify(p).includes('must-not-leak'), false);
  for (const [state, expected] of [['paused', 'paused'], ['finished', 'idle'], ['failed', 'error'], ['idle', 'idle']]) {
    assert.equal(printerRecord(printerBody({ state }), 1010000).state, expected);
  }
  for (const body of [null, {}, { records: 'bad' }, printerBody({ source: 'pi_status' }), printerBody({ as_of: '1000' }),
    printerBody({ as_of: Infinity }), printerBody({ as_of: 1e30 })]) assert.equal(printerRecord(body, 1010000), null);
  for (const over of [{ stale: true }, { as_of: 900 }, { as_of: 1016 }]) {
    const stale = printerRecord(printerBody(over), 1010000);
    assert.equal(stale.access, 'stale');
    assert.equal(stale.state, null); assert.equal(stale.progress, null); assert.equal(stale.minutesLeft, null);
  }
  assert.equal(printerRecord(printerBody({ state: 'finished' }), 1010000).needsPlateClear, true);
  assert.equal(printerRecord(printerBody({ state: 'finished', stale: true }), 1010000).needsPlateClear, undefined);
  assert.equal(printerRecord(printerBody({ detail: { progress: 101, minutes_left: -1 } }), 1010000).progress, null);
});

test('printer: concurrent reads share one fetch; cached source expires even while hub still answers', async () => {
  let t = 1080000, calls = 0, release;
  const gate = new Promise(r => { release = r; });
  const hub = createPiHub({ url: 'http://pi', now: () => t, fetchImpl: async url => {
    calls++; assert.equal(String(url), 'http://pi/api/records'); await gate;
    return { ok: true, json: async () => printerBody() };
  } });
  const reads = Promise.all(Array.from({ length: 10 }, () => hub.printer()));
  assert.equal(calls, 1); release();
  assert.ok((await reads).every(p => p.access === 'ok'));
  t += 11000;
  assert.equal((await hub.printer()).access, 'stale');
  assert.equal(calls, 1, 'a cached fetch never resets the source confirmation time');
  t += 5000; await hub.printer(); assert.equal(calls, 2);
});

test('printer: unavailable or disabled hub gives null and failures are cached', async () => {
  let calls = 0;
  const hub = createPiHub({ url: 'http://pi', fetchImpl: async () => { calls++; throw new Error('down'); } });
  assert.equal(await hub.printer(), null); assert.equal(await hub.printer(), null); assert.equal(calls, 1);
  assert.equal(await createPiHub({ url: 'off', fetchImpl: () => assert.fail('disabled') }).printer(), null);
});

test('needs: an item keeps its verb as a phrase key and nothing else (A7 P2)', () => {
  const { needsList } = require('../app/pi-hub');
  const items = needsList({ items: [{ id: 'a', title: 'T', link: '/network', action: { key: 'open_network', link: '/network' } },
    { id: 'b', title: 'T', action: { key: 'Open <script>' } }, { id: 'c', title: 'T', action: 'judge_it' }, { id: 'd', title: 'T' }] }).items;
  assert.deepEqual(items.map(i => i.action), ['open_network', '', '', '']);
});

test('needs: a long detail is cut at a word with an ellipsis, never mid-word', () => {
  const { needsList } = require('../app/pi-hub');
  const long = 'Look at the band first, then the wall and the channel features: no disturbance, curling, nozzle marks, spaghetti, or adhesion problems. '.repeat(6).trim();
  const [item] = needsList({ items: [{ id: 'a', title: 'T', detail: long }] }).items;
  assert.ok(item.detail.length <= 400 && item.detail.endsWith('…'), item.detail.slice(-30));
  const kept = item.detail.slice(0, -1);
  assert.ok(long.startsWith(kept) && long[kept.length] === ' ', 'cut at a word boundary');
  assert.equal(needsList({ items: [{ id: 'a', title: 'T', detail: 'Short.' }] }).items[0].detail, 'Short.');
});
