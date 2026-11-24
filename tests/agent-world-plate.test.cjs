'use strict';
// Agent World on the page anatomy (Pi Hub A7 plan, decision 9, L3): the mission is the page's faceplate. missionPlate
// is pure (agent-world-words.js); withRouteText gives a mission the run card's "Answered by" label (app/server/agents.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const A = require('../app/public/agent-world-words.js');
const { withRouteText } = require('../app/server/agents.js');

const at = min => new Date(Date.UTC(2026, 10, 5, 10, min, 0)).toISOString();
const w = (id, state, extra = {}) => ({ id, name: id === 'ux_analyst' ? 'UX Analyst' : id === 'synthesis' ? 'Coordinator' : 'Researcher', state, ...extra });
const ids = p => p.actions.map(a => a.id + (a.primary ? '*' : ''));
const reading = (p, label) => p.readings.find(r => r.label === label)?.value;

test('running: lamp Working, readout "1 of 3 done", what is happening, New mission only', () => {
  const m = { goal: 'Look over the phone screens', status: 'running', createdAt: at(0), workers: [w('research_agent', 'complete'), w('ux_analyst', 'running'), w('synthesis', 'pending')] };
  const p = A.missionPlate(m);
  assert.deepEqual(p.lamp, { tone: 'live', word: 'Working' });
  assert.deepEqual(p.readout, { value: '1 of 3', unit: 'done' });
  assert.equal(p.caption, 'Look over the phone screens');
  assert.equal(p.note, 'UX Analyst is reviewing the screens');
  assert.deepEqual(ids(p), ['start']);
  assert.equal(reading(p, 'Workers'), '3');
  assert.equal(reading(p, 'Searched'), 'Your projects');
});

test('done: lamp Done, readout is the time it took, See the answer first, Answered by from the route label', () => {
  const m = { goal: 'g', status: 'complete', createdAt: at(0), finishedAt: at(4), routeText: 'Answered by Llama 3.3 70B · Groq', policy: { allowWeb: true },
    workers: [w('research_agent', 'complete'), w('synthesis', 'complete'), w('research_agent-followup-1', 'complete')] };
  const p = A.missionPlate(m);
  assert.deepEqual(p.lamp, { tone: 'ok', word: 'Done' });
  assert.deepEqual(p.readout, { value: '4', unit: 'min' });
  assert.deepEqual(ids(p), ['result*', 'start']);
  assert.equal(p.actions[0].label, 'See the answer');
  assert.deepEqual(p.readings.map(r => r.label), ['Answered by', 'Searched', 'Workers']);
  assert.equal(reading(p, 'Answered by'), 'Llama 3.3 70B · Groq');
  assert.equal(reading(p, 'Searched'), 'Your projects and the web');
  assert.equal(reading(p, 'Workers'), '2', 'a follow-up is the same worker');
  assert.equal(A.missionPlate({ ...m, routeText: 'Answered on this PC' }).readings[0].value, 'This PC');
});

test('done: under a minute and over an hour read as the readout', () => {
  const base = { goal: 'g', status: 'complete', createdAt: at(0), workers: [w('synthesis', 'complete')] };
  assert.deepEqual(A.missionPlate({ ...base, finishedAt: new Date(Date.parse(at(0)) + 20e3).toISOString() }).readout, { value: '<1', unit: 'min' });
  assert.deepEqual(A.missionPlate({ ...base, finishedAt: new Date(Date.parse(at(0)) + 65 * 60e3).toISOString() }).readout, { value: '1 h 05', unit: '' });
  assert.equal(A.missionPlate({ ...base, createdAt: 'nonsense' }).readout, null, 'no time is never a made-up one');
});

test('an older mission without a route label has no Answered by line, never a guess', () => {
  const m = { goal: 'g', status: 'complete', createdAt: at(0), finishedAt: at(2), route: { provider: 'groq', model: 'x' }, workers: [w('synthesis', 'complete')] };
  const p = A.missionPlate(m);
  assert.equal(reading(p, 'Answered by'), undefined);
  assert.deepEqual(p.readings.map(r => r.label), ['Searched', 'Workers']);
});

test('needs attention: lamp Needs attention, Retry mission first, the reason as the note', () => {
  const m = { goal: 'g', status: 'needs_attention', createdAt: at(0), workers: [w('ux_analyst', 'error', { errorCode: 'MODEL_CONNECTION_ERROR' }), w('synthesis', 'blocked', { dependsOn: ['ux_analyst'] })] };
  const p = A.missionPlate(m);
  assert.deepEqual(p.lamp, { tone: 'bad', word: 'Needs attention' });
  assert.deepEqual(p.readout, { value: '0 of 2', unit: 'done' });
  assert.deepEqual(ids(p), ['retry*', 'start']);
  assert.equal(p.note, 'UX Analyst stopped: the model didn’t answer');
});

test('partly done: See the answer first, Retry mission beside it', () => {
  const m = { goal: 'g', status: 'complete', createdAt: at(0), finishedAt: at(3), workers: [w('ux_analyst', 'error'), w('synthesis', 'complete')] };
  assert.deepEqual(ids(A.missionPlate(m)), ['result*', 'retry', 'start']);
});

test('no mission ever: No missions yet, New mission and a demo; a demo owns the faceplate', () => {
  const p = A.missionPlate(null);
  assert.equal(p.lamp, null);
  assert.match(p.caption, /^No missions yet/);
  assert.deepEqual(ids(p), ['start*', 'demo']);
  const d = A.missionPlate({ goal: 'real', status: 'running', workers: [] }, { demo: true });
  assert.deepEqual(d.lamp, { tone: 'unknown', word: 'Demo' });
  assert.deepEqual(d.actions, []);
  assert.doesNotMatch(d.caption, /real/);
});

test('the missions API labels where the summary was written, as the run card does', () => {
  assert.equal(withRouteText({ id: 'm1', route: { provider: 'ollama', model: 'qwen' } }).routeText, 'Answered on this PC');
  assert.match(withRouteText({ id: 'm1', route: { provider: 'groq', model: 'llama-3.3-70b-versatile' } }).routeText, /^Answered by .+ · Groq$/);
  assert.equal(withRouteText({ id: 'm1' }).routeText, undefined);
  assert.equal(withRouteText({ id: 'm1', route: { provider: 'unknown' } }).routeText, undefined, 'an unknown provider says nothing');
  assert.equal(withRouteText(null), null);
});

// The page: head, the faceplate with the city as its aside, then the sections in order, and the ⋯ menu's items.
test('Agent World is drawn on the anatomy, with its sections in order and a short menu', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'public', 'index.html'), 'utf8');
  const page = html.slice(html.indexOf('<section id="agents"'), html.indexOf('<dialog id="awStart"'));
  assert.match(page, /<h1 class="ui-page__title">Agent World<\/h1>\s*<p class="ui-page__purpose">Give the team a goal; watch them work it\.<\/p>/);
  const order = ['id="awNotice"', 'id="awPlate"', 'ui-faceplate__aside aw-city', 'id="agentWorldCityMount"', 'id="awSheet"', 'id="awNeeds"', 'id="agentMissionControl"', 'aw-results', 'aw-crew', 'aw-story-box', 'aw-all-box', 'id="awSources"'];
  const pos = order.map(s => page.indexOf(s));
  assert.ok(pos.every(p => p > 0), 'missing: ' + order.filter((s, i) => pos[i] < 0).join(', '));
  assert.deepEqual([...pos].sort((a, b) => a - b), pos, 'in order: ' + order.join(' → '));
  assert.equal((page.match(/ui-faceplate[ "]/g) || []).length, 1, 'one faceplate');
  const menu = page.slice(page.indexOf('id="awMenu"'), page.indexOf('</div>\n</div>', page.indexOf('id="awMenu"')));
  const items = [...menu.matchAll(/role="menuitem(?:checkbox)?"[^>]*>([^<]+)</g)].map(m => m[1]);
  assert.deepEqual(items, ['Copy the answer', 'Open in Work', 'All missions', 'Try a demo mission', 'Labels', 'Flows', 'Night', 'Watch the replay', 'Watch mode', 'Full screen', 'Fit the city', 'Replay speed: 1×']);
  assert.doesNotMatch(page, /awEmpty"|data-aw-menu="new"/, 'the empty card and the menu’s Start are the faceplate’s now');
});
