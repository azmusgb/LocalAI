'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fitMessages, estimateTokens, warmTextModel, unloadTextModel, CHARS_PER_TOKEN, parseNumCtx, parseKeepAlive } = require('../app/text-context');

const sys = { role: 'system', content: 'You are helpful.' };
const chars = ms => ms.reduce((n, m) => n + m.content.length, 0);
const opts = { numCtx: 1024 + 1000, reserve: 1024 }; // 1000 tokens of prompt, about 3500 chars

test('estimates tokens as chars / 3.5', () => {
  assert.equal(CHARS_PER_TOKEN, 3.5);
  assert.equal(estimateTokens('x'.repeat(350)), 100);
});

test('fitMessages keeps everything when small', () => {
  const ms = [sys, { role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }, { role: 'user', content: 'again' }];
  assert.deepEqual(fitMessages(ms, opts), ms);
});

test('fitMessages drops the oldest turns first and keeps system and newest', () => {
  const ms = [sys];
  for (let i = 0; i < 10; i++) ms.push({ role: i % 2 ? 'assistant' : 'user', content: `t${i} ` + 'x'.repeat(996) });
  const out = fitMessages(ms, opts);
  assert.deepEqual(out[0], sys);
  assert.equal(out.at(-1).content, ms.at(-1).content);
  assert.ok(out.length < ms.length);
  assert.ok(estimateTokens(out.map(m => m.content).join('')) <= 1000);
  // what is left is a contiguous newest run
  const kept = out.slice(1).map(m => m.content.slice(0, 2));
  assert.deepEqual(kept, ms.slice(-kept.length).map(m => m.content.slice(0, 2)));
});

test('a single huge message is truncated to fit, not dropped', () => {
  const out = fitMessages([sys, { role: 'user', content: 'q'.repeat(50000) }], opts);
  assert.equal(out.length, 2);
  assert.equal(out[1].role, 'user');
  assert.ok(out[1].content.length > 1000);
  assert.ok(estimateTokens(out.map(m => m.content).join('')) <= 1000);
});

test('sources are trimmed before user turns', () => {
  const user = { role: 'user', content: 'u'.repeat(1500) };
  const ms = [sys, { role: 'system', kind: 'sources', content: 's'.repeat(6000) }, user, { role: 'assistant', content: 'a'.repeat(500) }, { role: 'user', content: 'last' }];
  const out = fitMessages(ms, opts);
  assert.equal(out.length, 5, 'no turn dropped');
  const src = out.find(m => m.content.startsWith('s'));
  assert.ok(src.content.length < 6000 && src.content.length > 0);
  assert.equal(out.find(m => m.content.startsWith('u')).content, user.content);
  assert.ok(out.every(m => !('kind' in m)), 'marker not sent to the model');
  assert.ok(chars(out) <= 3500);
});

test('sources are dropped entirely when they cannot help', () => {
  const ms = [sys, { role: 'system', kind: 'sources', content: 's'.repeat(9000) }, { role: 'user', content: 'u'.repeat(3400) }];
  const out = fitMessages(ms, opts);
  assert.ok(!out.some(m => m.content.startsWith('s')));
  assert.ok(out.some(m => m.content.startsWith('u')));
});

test('warm and unload send the right bodies and never throw', async () => {
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true }; };
  await warmTextModel({ fetch, url: 'http://o', model: 'm', numCtx: 8192, keepAlive: '30m' });
  await unloadTextModel({ fetch, url: 'http://o', model: 'm' });
  assert.equal(calls[0].url, 'http://o/api/generate');
  assert.equal(calls[0].body.model, 'm');
  assert.equal(calls[0].body.keep_alive, '30m');
  assert.equal(calls[0].body.options.num_ctx, 8192);
  assert.equal(calls[0].body.options.num_predict, 1);
  assert.equal(calls[1].body.keep_alive, 0);
  const boom = async () => { throw new Error('down'); };
  await warmTextModel({ fetch: boom, url: 'http://o', model: 'm' });
  await unloadTextModel({ fetch: boom, url: 'http://o', model: 'm' });
});

test('unload waits at most about 2 seconds', async () => {
  const hang = () => new Promise(() => {});
  const t0 = Date.now();
  await unloadTextModel({ fetch: hang, url: 'http://o', model: 'm', waitMs: 50 });
  assert.ok(Date.now() - t0 < 1000);
});

test('a huge message keeps its head and its tail, the middle is cut', () => {
  const body = 'INSTRUCTIONS: do it.' + 'm'.repeat(50000) + 'QUESTION?';
  const out = fitMessages([sys, { role: 'user', content: body }], opts);
  const c = out[1].content;
  assert.ok(c.startsWith('INSTRUCTIONS:'));
  assert.ok(c.endsWith('QUESTION?'));
  assert.ok(c.includes('\n…\n'));
  assert.ok(estimateTokens(out.map(m => m.content).join('')) <= 1000);
  const head = c.indexOf('\n…\n');
  assert.ok(head > (c.length - 3) * 0.55 && head < (c.length - 3) * 0.65, 'head gets about 60%');
});

test('LOCALAI_NUM_CTX parser: integers 2048..131072 only', () => {
  const warn = () => { warn.n++; }; warn.n = 0;
  assert.equal(parseNumCtx(undefined, 8192, 'X', warn), 8192);
  assert.equal(parseNumCtx('4096', 8192, 'X', warn), 4096);
  assert.equal(parseNumCtx('2048', 8192, 'X', warn), 2048);
  assert.equal(parseNumCtx('131072', 8192, 'X', warn), 131072);
  assert.equal(warn.n, 0);
  for (const bad of ['2047', '131073', 'abc', 'Infinity', '8192.5', '-1', '0', '']) assert.equal(parseNumCtx(bad, 8192, 'X', warn), 8192, bad);
  assert.equal(warn.n, 7, 'warns for each bad value except empty');
});

test('LOCALAI_KEEP_ALIVE parser: durations, -1 and 0 only', () => {
  const warn = () => { warn.n++; }; warn.n = 0;
  assert.equal(parseKeepAlive(undefined, warn), '30m');
  for (const ok of ['30m', '1h', '90s', '1.5h', '5m']) assert.equal(parseKeepAlive(ok, warn), ok);
  assert.equal(parseKeepAlive('-1', warn), -1);
  assert.equal(parseKeepAlive('0', warn), 0);
  assert.equal(warn.n, 0);
  for (const bad of ['forever', '30', '5 m', '-5m', '1d', 'm']) assert.equal(parseKeepAlive(bad, warn), '30m', bad);
  assert.equal(warn.n, 6);
});
