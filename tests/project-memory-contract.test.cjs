'use strict';

// Platform amendment A28 D5.4: project Memory notes never feed a run that has tools. Only chat and research turns
// (app/server/chat.js) read them; missions, agents, GridCraft and change planning can't, because nothing they run
// can reach the notes or the block. Read as text, so a later require or a new ctx wire fails here at once.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const PM = require('../app/project-memory');

const APP = path.resolve(__dirname, '../app');
const read = rel => fs.readFileSync(path.join(APP, rel), 'utf8');
function jsFiles(dir) {
  return fs.readdirSync(path.join(APP, dir), { withFileTypes: true }).flatMap(e => {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) return rel === 'public' || rel === 'atlas' ? [] : jsFiles(rel);
    return e.name.endsWith('.js') ? [rel] : [];
  });
}
const SERVER_FILES = jsFiles('.').map(f => f.replace(/^\.\//, ''));

test('only app/server/chat.js (and the run card, for its line) load app/project-memory.js', () => {
  const loaders = SERVER_FILES.filter(f => /require\(['"](?:\.\.?\/)+project-memory['"]\)/.test(read(f))).sort();
  assert.deepEqual(loaders, ['run-cards.js', path.join('server', 'chat.js')].sort());
  // The run card uses only the line under the answer, never the block.
  assert.match(read('run-cards.js'), /const \{ cardLine: memoryLine \} = require\('\.\/project-memory'\);/);
});

test('the notes block markers are written only in app/project-memory.js', () => {
  const name = PM.OPEN.replace(/^<<</, '');
  const writers = SERVER_FILES.filter(f => read(f).includes(name));
  assert.deepEqual(writers, ['project-memory.js']);
});

test('the notes reader is wired into createChat and no other area module', () => {
  const server = read('server.js');
  const calls = [...server.matchAll(/require\('\.\/server\/([a-z-]+)'\)\.(create[A-Za-z]+)\(\{([^\n]*)\}\);/g)];
  assert.ok(calls.length >= 15, 'found the createX(ctx) calls');
  const withNotes = calls.filter(([, , , args]) => /\bprojectNotes\b/.test(args)).map(([, file]) => file);
  assert.deepEqual(withNotes, ['chat']);
  // The memory store is read by its routes (projects) and by that one reader, nowhere else in server.js.
  const reads = [...server.matchAll(/storage\.list\(MEMORY_STORE/g)].length;
  assert.equal(reads, 1);
});

test('missions, agents, GridCraft and change planning neither read notes nor build the block', () => {
  const toolRuns = ['agent-orchestrator.js', 'agent-runtime.js', 'agent-tools.js', 'mission-answer.js', 'mission-evidence.js',
    path.join('server', 'agents.js'), path.join('server', 'gridcraft.js'), path.join('server', 'changes.js'), path.join('server', 'workbench.js')];
  for (const f of toolRuns) {
    const src = read(f);
    assert.doesNotMatch(src, /project-memory|projectNotes|memoryMessage|UNTRUSTED_NOTES|MEMORY_STORE|['"]memory['"]\s*,\s*\{\s*projectId/, `${f} must not reach project notes`);
  }
});

test('chat puts the block only in what this PC\'s model is sent, never in what a cloud model is sent', () => {
  const src = read(path.join('server', 'chat.js'));
  const fn = name => { const at = src.indexOf(`function ${name}(`); assert.ok(at >= 0, name); return src.slice(at, src.indexOf('\n  }\n', at)); };
  assert.match(fn('chatMessages'), /projectMemory\.memoryMessage\(\{ project: prep\.memory\?\.project, notes, facts \}\)/);
  assert.doesNotMatch(fn('cloudMessages'), /prep\.memory|prep\.facts|memoryMessage/);
  // The memory message is built in exactly one place.
  assert.equal(src.split('memoryMessage(').length - 1, 1);
});

// Owner facts (docs/superpowers/specs/2026-11-19-owner-facts-design.md §3): the same rule. Only chat (chat, research and
// voice turns) reads them, through the shared-notes reader it already has, and only the run card reads their line.
test('only app/server/chat.js (and the run card, for its line) use the owner facts in a turn', () => {
  const loaders = SERVER_FILES.filter(f => /require\(['"](?:\.\.?\/)+owner-facts['"]\)/.test(read(f))).sort();
  assert.deepEqual(loaders, ['run-cards.js', path.join('server', 'chat.js'), path.join('server', 'projects.js')].sort());
  assert.match(read('run-cards.js'), /const \{ cardLine: factsLine \} = require\('\.\/owner-facts'\);/);
  // The memory routes use only the list's rules, never the turn's reader.
  assert.doesNotMatch(read(path.join('server', 'projects.js')), /forTurn|runMeta|cardLine/);
});

test('missions, agents, GridCraft and change planning never get the owner facts', () => {
  const toolRuns = ['agent-orchestrator.js', 'agent-runtime.js', 'agent-tools.js', 'mission-answer.js', 'mission-evidence.js',
    path.join('server', 'agents.js'), path.join('server', 'gridcraft.js'), path.join('server', 'changes.js'), path.join('server', 'workbench.js')];
  for (const f of toolRuns) assert.doesNotMatch(read(f), /owner-facts|ownerFacts|forTurn|category\s*===?\s*['"]owner['"]/, `${f} must not reach the owner facts`);
});

test("facts are read after routing and never go into a cloud model's messages", () => {
  const src = read(path.join('server', 'chat.js')).replace(/^\s*\/\/.*$/gm, '');   // code, not comments
  const prep = src.slice(src.indexOf('async function prepareChat('), src.indexOf('function projectFor('));
  assert.ok(prep.indexOf('coordinator.route(') < prep.indexOf('ownerFacts.forTurn('), 'the route is decided before the facts are read');
  assert.doesNotMatch(prep.slice(0, prep.indexOf('coordinator.route(')), /ownerFacts|prep\.facts/);
  const cloud = src.slice(src.indexOf('function cloudMessages('), src.indexOf('async function prepareChat('));
  assert.doesNotMatch(cloud, /prep\.facts|ownerFacts/);
  // The run says who answered: a cloud answer records that the facts were left out.
  assert.equal(src.split('ownerFacts.runMeta(prep.facts, { sent: local.factsSent, cloud: !!cloud })').length - 1, 2);
});
