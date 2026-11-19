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
  assert.match(fn('chatMessages'), /projectMemory\.memoryMessage\(prep\.memory\)/);
  assert.doesNotMatch(fn('cloudMessages'), /prep\.memory|memoryMessage/);
  // The memory message is built in exactly one place.
  assert.equal(src.split('memoryMessage(').length - 1, 1);
});
