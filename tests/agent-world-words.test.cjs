'use strict';
// app/public/agent-world-words.js: what Agent World says about a mission and its workers, in the owner's words.
// Pure functions of the mission JSON the server sends (/api/agents/missions), so they are tested here, not in a browser.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const words = require(path.resolve(__dirname, '../app/public/agent-world-words.js'));
const T0 = Date.parse('2026-10-17T17:12:13Z');
const at = s => new Date(T0 + s * 1000).toISOString();
const router = (o = {}) => ({ id: 'router', name: 'Mission Router', state: 'complete', dependsOn: [], ...o });
const ux = (o = {}) => ({ id: 'ux_analyst', name: 'UX Analyst', state: 'pending', dependsOn: ['router'], ...o });
const coord = (o = {}) => ({ id: 'synthesis', name: 'Coordinator', state: 'pending', dependsOn: ['ux_analyst'], ...o });
const mission = (o = {}) => ({ id: 'm1', goal: 'Improve the look and polish of Agent World', status: 'running', createdAt: at(0), updatedAt: at(60), workers: [router(), ux(), coord()], results: [], ...o });

test('workers are named and described in words, not ids', () => {
  assert.equal(words.workerName(router()), 'Team lead');
  assert.equal(words.workerName({ id: 'model_router', name: 'Mission Router' }), 'Team lead');
  assert.equal(words.workerName(ux()), 'UX Analyst');
  assert.equal(words.workerName({ id: 'x_y' }), 'X y');
  assert.equal(words.workerRole(ux()), 'Reviews screens for usability');
  assert.equal(words.workerRole(router()), 'Picks the team and plans the work');
  assert.equal(words.workerRole(coord()), 'Puts everyone’s findings together');
  assert.equal(words.workerRole({ id: 'unknown_helper', name: 'Helper' }), 'Helps with the mission');
});

test('each state has one owner word and a tone', () => {
  assert.deepEqual(words.stateBadge('running'), { label: 'Working', tone: 'accent' });
  assert.deepEqual(words.stateBadge('complete'), { label: 'Done', tone: 'good' });
  assert.deepEqual(words.stateBadge('pending'), { label: 'Waiting', tone: 'neutral' });
  assert.deepEqual(words.stateBadge('error'), { label: 'Needs you', tone: 'bad' });
  assert.deepEqual(words.stateBadge('blocked'), { label: 'Needs you', tone: 'bad' });
});

test('a worker’s second line says what it is doing now', () => {
  const m = mission({ workers: [router(), ux({ state: 'running', phase: 'inference' }), coord()] });
  assert.equal(words.workerStep(m.workers[1], m), 'Reviewing the screens');
  assert.equal(words.workerStep({ ...m.workers[1], phase: 'Gather context' }, m), 'Reading the sources');
  assert.equal(words.workerStep({ ...m.workers[1], phase: 'model_queue', queuePosition: 2 }, m), 'Waiting for the model (2 ahead)');
  assert.equal(words.workerStep(m.workers[2], m), 'Waiting for UX Analyst');
  assert.equal(words.workerStep(router(), m), 'Picked the team');
  assert.equal(words.workerStep(ux({ state: 'complete', startedAt: at(0), finishedAt: at(150) }), m), 'Finished in 3 min');
  assert.equal(words.workerStep(ux({ state: 'error', errorCode: 'MODEL_CONNECTION_ERROR' }), m), 'Stopped: the model didn’t answer');
  const stopped = mission({ workers: [router(), ux({ state: 'error' }), coord({ state: 'blocked' })] });
  assert.equal(words.workerStep(stopped.workers[2], stopped), 'Couldn’t start: UX Analyst stopped');
});

test('errors are said in plain words', () => {
  assert.equal(words.errorWords('MODEL_CONNECTION_ERROR', 'fetch failed'), 'the model didn’t answer');
  assert.equal(words.errorWords('', 'fetch failed'), 'the model didn’t answer');
  assert.equal(words.errorWords('MODEL_TIMEOUT', ''), 'the model took too long');
  assert.equal(words.errorWords('APPLIANCE_RESTART', ''), 'Local AI restarted while it was working');
  assert.equal(words.errorWords('', 'Disk full.'), 'disk full');
  assert.equal(words.errorWords('', 'x'.repeat(200)), 'something went wrong');
  assert.equal(words.errorWords('', ''), 'something went wrong');
});

test('the status sentence: working, needs you, done, idle', () => {
  const running = mission({ workers: [router(), ux({ state: 'running', phase: 'inference' }), coord()] });
  assert.deepEqual(words.statusSentence(running), { tone: 'working', label: 'Working', text: 'Working · 1 of 3 done · UX Analyst is reviewing the screens' });
  const two = mission({ workers: [router(), ux({ state: 'running' }), { id: 'research_agent', name: 'Research Agent', state: 'running' }, coord()] });
  assert.equal(words.statusSentence(two).text, 'Working · 1 of 4 done · UX Analyst and Research Agent are working');
  const failed = mission({ status: 'needs_attention', error: 'Mission stopped after specialist failure', workers: [router(), ux({ state: 'error', errorCode: 'MODEL_CONNECTION_ERROR', error: null }), coord({ state: 'blocked' })] });
  assert.deepEqual(words.statusSentence(failed), { tone: 'attention', label: 'Needs you', text: 'Needs you · 1 of 3 done · UX Analyst stopped: the model didn’t answer' });
  // The worker's own error can live on its result instead.
  const viaResult = mission({ status: 'needs_attention', workers: [router(), ux({ state: 'error' }), coord({ state: 'blocked' })], results: [{ agentId: 'ux_analyst', status: 'error', error: 'fetch failed', errorCode: 'MODEL_CONNECTION_ERROR' }] });
  assert.equal(words.statusSentence(viaResult).text, 'Needs you · 1 of 3 done · UX Analyst stopped: the model didn’t answer');
  const done = mission({ status: 'complete', updatedAt: at(240), finishedAt: at(250), workers: [router(), ux({ state: 'complete' }), coord({ state: 'complete' })] });
  assert.deepEqual(words.statusSentence(done), { tone: 'done', label: 'Done', text: 'Done in 4 min · 3 workers' });
  assert.deepEqual(words.statusSentence(null), { tone: 'idle', label: '', text: 'Give your team a goal' });
  const starting = mission({ workers: [router({ state: 'running' })] });
  assert.equal(words.statusSentence(starting).text, 'Starting · the team lead is picking the team');
});

test('durations read like a person would say them', () => {
  assert.equal(words.duration(20e3), 'under a minute');
  assert.equal(words.duration(90e3), '2 min');
  assert.equal(words.duration(4 * 60e3), '4 min');
  assert.equal(words.duration(75 * 60e3), '1 h 15 min');
  assert.equal(words.duration(NaN), '');
});

test('the story: the mission’s events as sentences, newest first', () => {
  const snap = (type, s, uxState, coState, o = {}) => ({ at: at(s), type, workerId: o.workerId || '', detail: o.detail || '', status: o.status || 'running', workers: [router(), ux({ state: uxState, ...(o.ux || {}) }), coord({ state: coState })] });
  const m = mission({
    status: 'needs_attention',
    timeline: [
      snap('mission-start', 0, 'pending', 'pending', { workerId: 'router' }),
      snap('dispatch', 1, 'running', 'pending', { workerId: 'ux_analyst' }),
      snap('worker-progress', 2, 'running', 'pending', { workerId: 'ux_analyst' }),
      snap('heartbeat', 3, 'running', 'pending'),
      snap('worker-result', 300, 'error', 'pending', { workerId: 'ux_analyst', ux: { errorCode: 'MODEL_CONNECTION_ERROR' } }),
      snap('mission-attention', 301, 'error', 'blocked', { status: 'needs_attention' })
    ]
  });
  const s = words.storyEvents(m);
  assert.deepEqual(s.map(e => e.text), [
    'The mission stopped and needs you',
    'Coordinator couldn’t start: UX Analyst stopped',
    'UX Analyst stopped: the model didn’t answer',
    'Coordinator is waiting for UX Analyst',
    'UX Analyst started reviewing the screens',
    'The team lead picked the team: UX Analyst and Coordinator'
  ]);
  assert.deepEqual(s.map(e => e.workerId), ['', 'synthesis', 'ux_analyst', 'synthesis', 'ux_analyst', 'router']);
  assert.deepEqual(s.map(e => e.tone), ['bad', 'bad', 'bad', 'wait', 'working', 'done']);
  assert.equal(s[2].at, at(300));
});

test('the story of a finished mission ends with the summary', () => {
  const t = (type, s, u, c, status = 'running') => ({ at: at(s), type, status, workers: [router(), ux({ state: u }), coord({ state: c })] });
  const m = mission({ status: 'complete', timeline: [t('mission-start', 0, 'pending', 'pending'), t('dispatch', 1, 'running', 'pending'), t('worker-result', 120, 'complete', 'pending'), t('synthesis', 121, 'complete', 'running'), t('mission-complete', 200, 'complete', 'complete', 'complete')] });
  assert.deepEqual(words.storyEvents(m).slice(0, 4).map(e => e.text), ['Done: the summary is ready', 'Coordinator finished', 'Coordinator started putting the findings together', 'UX Analyst finished']);
});

test('a mission without a timeline still tells where each worker is', () => {
  const m = mission({ timeline: [], workers: [router(), ux({ state: 'running' }), coord()] });
  assert.deepEqual(words.storyEvents(m).map(e => e.text), ['Coordinator is waiting for UX Analyst', 'UX Analyst is reviewing the screens', 'The team lead picked the team: UX Analyst and Coordinator']);
});

test('runs of events from one worker are grouped', () => {
  const g = words.groupStory([{ workerId: 'a', text: '1' }, { workerId: 'a', text: '2' }, { workerId: '', text: '3' }, { workerId: 'b', text: '4' }]);
  assert.deepEqual(g.map(x => [x.workerId, x.items.map(i => i.text)]), [['a', ['1', '2']], ['', ['3']], ['b', ['4']]]);
});
