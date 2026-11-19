'use strict';

// Contract (spec 2026-11-19-owner-facts-design.md, Testing; A28 D5.4): the owner-fact suggestion job runs only after
// a chat answered through the chat routes. No mission, agent, GridCraft, change-planner, voice or Past work path
// reaches it, it is `quick` work (always this PC), and its routes are refused without a signed-in device.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const modelRouter = require('../app/model-router');
const { guarded } = require('../app/signin');

const APP = path.resolve(__dirname, '../app');
const read = rel => fs.readFileSync(path.join(APP, rel), 'utf8');
const NAMES = /fact-suggestions|factSuggestions|suggestFact|afterChat/;

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'public' || e.name === 'node_modules' ? [] : jsFiles(p);
    return e.name.endsWith('.js') ? [p] : [];
  });
}

test('only server.js (wiring) and server/chat.js (the chat routes) name the suggestion job', () => {
  const naming = jsFiles(APP).map(f => path.relative(APP, f)).filter(rel => rel !== 'fact-suggestions.js' && NAMES.test(read(rel))).sort();
  assert.deepEqual(naming, ['server.js', path.join('server', 'chat.js')].sort());
});

test('no mission, agent, GridCraft, planner, voice or Past work module reaches it', () => {
  for (const rel of ['agent-orchestrator.js', 'agent-runtime.js', 'agent-tools.js', 'mission-answer.js', 'mission-evidence.js', 'journal-ask.js', 'voice.js',
    path.join('server', 'agents.js'), path.join('server', 'gridcraft.js'), path.join('server', 'changes.js'), path.join('server', 'journal.js'), path.join('server', 'voice.js'), path.join('server', 'automations.js')]) {
    assert.ok(!NAMES.test(read(rel)), `${rel} must not name the suggestion job`);
  }
});

test('in chat.js the job is scheduled only after an answer is sent, from /api/chat and /api/chat/stream, never from chatOnce', () => {
  const chat = read(path.join('server', 'chat.js'));
  const calls = [...chat.matchAll(/suggestFact\(/g)].length;
  assert.equal(calls, 3, 'its definition and the two chat routes');
  const fn = name => { const at = chat.indexOf(`async function ${name}(`); assert.ok(at >= 0, name); const next = chat.indexOf('\n  async function ', at + 1); return chat.slice(at, next < 0 ? undefined : next); };
  assert.ok(!/suggestFact\(/.test(fn('chatOnce')), 'chatOnce (shared with voice) does not schedule it');
  const once = fn('apiChat');
  assert.ok(once.indexOf('json(res, 200, out)') < once.indexOf('suggestFact('), '/api/chat answers first');
  const stream = fn('apiChatStream');
  assert.ok(stream.indexOf('res.end()') < stream.indexOf('suggestFact('), 'the stream ends first');
  assert.ok(stream.indexOf("send('done'") < stream.indexOf('suggestFact('));
});

test('the job is quick work: always this PC, whatever the cloud switch says', () => {
  const src = read('fact-suggestions.js');
  assert.match(src, /coordinator\.route\(\{ kind: 'quick'/);
  assert.equal(modelRouter.KINDS.quick.cloud, false);
  const r = modelRouter.route({ kind: 'quick', text: 'I print PLA', cloud: true, bigger: true, keys: { groq: true, cerebras: true }, localModel: 'm' });
  assert.equal(r.class, 'private');
  assert.deepEqual(r.order.map(o => o.provider), ['ollama']);
});

test('the routes are owner-only: refused without a signed-in device, reads included', () => {
  for (const p of ['/api/facts/suggestions', '/api/facts/suggestions/decide']) {
    assert.equal(guarded(p, 'GET'), true, `${p} GET`);
    assert.equal(guarded(p, 'POST'), true, `${p} POST`);
  }
  const server = read('server.js');
  assert.match(server, /'GET' && p === '\/api\/facts\/suggestions'\)/);
  assert.match(server, /'POST' && p === '\/api\/facts\/suggestions\/decide'\)/);
});
