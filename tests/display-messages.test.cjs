'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDisplayMessages, clean } = require('../app/display-messages');

const memoryStorage = () => { const m = new Map(); return { readSetting: (k, d) => (m.has(k) ? m.get(k) : d), writeSetting: (k, v) => m.set(k, v) }; };

test('a message is checked: a title, short text, a known tone, one allowed action', () => {
  assert.deepEqual(clean({ title: 'Render done', text: 'The fox' }), { title: 'Render done', text: 'The fox', tone: 'info', chime: true, action: null });
  assert.deepEqual(clean({ title: 'Tea', action: { type: 'timer', minutes: 4 }, chime: false, tone: 'ok' }).action, { type: 'timer', minutes: 4 });
  assert.equal(clean({ title: 'x'.repeat(60) }).title.length, 24);
  assert.throws(() => clean({ text: 'no title' }), /title/);
  assert.throws(() => clean({ title: 'x', action: { type: 'print', file: 'a.3mf' } }), /action/);
  assert.throws(() => clean({ title: 'x', action: { type: 'timer', minutes: 999 } }), /action/);
  assert.equal(clean({ title: 'x', tone: 'nope' }).tone, 'info');
});

test('seq only grows, messages last 15 minutes, and at most 6 a minute are taken', () => {
  let t = 1_000_000;
  const d = createDisplayMessages({ storage: memoryStorage(), now: () => t });
  const a = d.post({ title: 'a' }), b = d.post({ title: 'b' });
  assert.ok(b.seq > a.seq);
  for (let i = 0; i < 4; i++) d.post({ title: `m${i}` });
  assert.throws(() => d.post({ title: 'seventh' }), (e) => e.statusCode === 429);
  t += 61_000;
  d.post({ title: 'later' });
  t += 14 * 60_000; // the first six are older than 15 minutes now; "later" is not
  assert.deepEqual(d.recent().map((m) => m.title), ['later']);
  assert.equal('source' in d.recent()[0], false);
});

test('notifications show on the display for the kinds picked; in quiet hours only a failure chimes', () => {
  let t = Date.parse('2026-10-20T15:00:00Z'); // 11:00 in New York
  const d = createDisplayMessages({ storage: memoryStorage(), now: () => t, timeZone: 'America/New_York' });
  const m = d.fromNotification({ kind: 'needs-you', title: 'Approval needed', body: 'Deploy LocalAI' });
  assert.deepEqual([m.tone, m.chime, m.action], ['attention', true, { type: 'show', page: 'localai' }]);
  assert.equal(d.fromNotification({ kind: 'answer', title: 'x' }), null);
  t = Date.parse('2026-10-21T03:00:00Z'); // 23:00
  assert.equal(d.fromNotification({ kind: 'finished', title: 'Done', body: 'x' }).chime, false);
  assert.equal(d.fromNotification({ kind: 'failed', title: 'Failed', body: 'x' }).chime, true);
  d.updateSettings({ kinds: ['failed'] });
  assert.equal(d.fromNotification({ kind: 'finished', title: 'Done' }), null);
  assert.throws(() => d.updateSettings({ quiet: { start: '25:00' } }), /HH:MM/);
});
