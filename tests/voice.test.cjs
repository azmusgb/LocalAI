'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classify, speakable } = require('../app/voice');
const { voiceFacts } = require('../app/voice-context');
const { needsYouItems, needsYouSentence } = require('../app/glance');

test('classify routes spoken questions by rules', () => {
  const rows = [
    ['anything need me', 'needs'], ["what's waiting for me", 'needs'],
    ['is local ai ok', 'health'], ['is localai ok', 'health'],
    ["what's the date", 'time'], ['whats the date', 'time'], ['tell me the date', 'time'], ['tell me the time', 'time'], ['what time is it', 'time'],
    ["what's the weather tomorrow", 'weather'],
    ['who won the world series last year', 'current'], ['latest news on SpaceX', 'current'],
    ['approve the login fix', 'refuse'], ['deploy it', 'refuse'], ['delete the library', 'refuse'],
    ['', 'empty'], ['um', 'empty'], ['  Uh, ', 'empty'],
    ['explain WAL mode', 'chat']
  ];
  for (const [text, intent] of rows) assert.equal(classify(text).intent, intent, text);
  assert.deepEqual(classify('make an image of a red fox'), { intent: 'action', action: 'image', subject: 'a red fox' });
  const m = classify('start a mission to compare NAS drives');
  assert.equal(m.intent, 'action'); assert.equal(m.action, 'mission');
  assert.equal(classify('research the best NAS for Plex').action, 'research');
});

test('speakable strips markdown, links, emoji and keeps two sentences', () => {
  const out = speakable('**Yes** — see https://x.y 🙂\n- a\n- b. Third. Fourth.');
  assert.doesNotMatch(out, /\*|http|[-•]\s|\p{Extended_Pictographic}/u);
  assert.ok((out.match(/[.!?](\s|$)/g) || []).length <= 2, out);
  assert.equal(speakable('See [the docs](https://a.b/c) now. `code` ok. More.'), 'See the docs now. code ok.');
});

test('speakable keeps decimals and abbreviations inside a sentence', () => {
  assert.equal(speakable('It is 3.5 degrees out. Bring a coat. Third.'), 'It is 3.5 degrees out. Bring a coat.');
  assert.equal(speakable('Use e.g. curl. Or wget. Or ftp.'), 'Use e.g. curl. Or wget.');
  assert.equal(speakable('Meet at 5 p.m. today. Then dinner. Then bed.'), 'Meet at 5 p.m. today. Then dinner.');
});

test('"No." ends a sentence unless a number follows', () => {
  assert.equal(speakable('Answer: no. Then wait. Then stop.'), 'Answer: no. Then wait.');
  assert.equal(speakable('Ticket No. 5 is open. Check it. Later.'), 'Ticket No. 5 is open. Check it.');
});

test('voiceFacts states the day and the local time', () => {
  assert.equal(
    voiceFacts({ now: new Date('2026-10-16T04:42:00Z'), timeZone: 'America/Phoenix' }),
    'Today is Thursday, October 15, 2026. It is 9:42 in the evening.'
  );
  assert.equal(
    voiceFacts({ now: new Date('2026-10-16T04:42:00Z'), timeZone: 'America/Phoenix', includeZone: true }),
    'Today is Thursday, October 15, 2026. It is 9:42 in the evening in America/Phoenix.'
  );
});

test('needsYouItems names things and the sentence speaks up to three', () => {
  const items = needsYouItems({
    approvals: [{ title: 'Fix the login bug' }], changes: [], findings: [],
    failedRuns: [{ title: 'Weekly report mission' }], downServices: []
  });
  assert.deepEqual(items, [{ kind: 'approval', title: 'Fix the login bug' }, { kind: 'failed', title: 'Weekly report mission' }]);
  assert.equal(needsYouSentence(items), 'Two things need you: Fix the login bug and the Weekly report mission failed.');
  assert.equal(needsYouSentence([]), 'Nothing needs you right now.');
  assert.match(needsYouSentence([1, 2, 3, 4, 5].map(i => ({ kind: 'approval', title: 'T' + i }))), /^5 things need you, including T1, T2, and T3\.$/);
});
