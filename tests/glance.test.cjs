'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { healthSummary, needsYouSummary } = require('../app/glance');

const svc = (label, state, required = true) => ({ label, state, required });
const all = ['Intelligence', 'Image generation', 'Automation engine', 'Conversation compatibility', 'Web research'];

test('health: all up names the version and count, and ignores optional companions', () => {
  const h = healthSummary({ version: '2.0.258', services: [...all.map(l => svc(l, 'HEALTHY')), svc('Companion home', 'DOWN', false)] });
  assert.equal(h.ok, true);
  assert.equal(h.speech, 'Local AI 2.0.258 is running and all 5 core services are up.');
});

test('health: names what is down', () => {
  const one = healthSummary({ services: all.map(l => svc(l, l === 'Image generation' ? 'DOWN' : 'HEALTHY')) });
  assert.equal(one.speech, 'Image generation is down. Everything else is up.');
  const two = healthSummary({ services: all.map(l => svc(l, /Image|Web/.test(l) ? 'DOWN' : 'HEALTHY')) });
  assert.equal(two.speech, 'Image generation and Web research are down. Everything else is up.');
  const none = healthSummary({ services: all.map(l => svc(l, 'DOWN')) });
  assert.equal(none.speech, 'Local AI is running, but none of its core services are answering.');
  assert.equal(healthSummary({}).speech, 'Local AI is running, but its services could not be checked.');
});

test('needs you: lists what waits on the owner, then failures, progress and health', () => {
  const health = healthSummary({ services: all.map(l => svc(l, l === 'Image generation' ? 'DOWN' : 'HEALTHY')) });
  const n = needsYouSummary({ approvals: 1, changes: 11, findings: 2, failedToday: 1, running: 2 }, health);
  assert.equal(n.count, 14);
  assert.equal(n.speech, 'Needs you: 1 approval, 11 unfinished change requests and 2 Claude findings to decide. 1 run failed today. 2 runs are in progress. Image generation is down. Everything else is up.');
});

test('needs you: nothing pending says so, and a healthy appliance adds nothing', () => {
  const n = needsYouSummary({}, healthSummary({ services: all.map(l => svc(l, 'HEALTHY')) }));
  assert.equal(n.count, 0);
  assert.equal(n.speech, 'Nothing needs you right now.');
});
