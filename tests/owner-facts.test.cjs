'use strict';
// Owner facts (docs/superpowers/specs/2026-11-19-owner-facts-design.md, PR 1: the list): the rules in app/owner-facts.js
// and the memory routes that enforce them (app/server/projects.js), with a store that can fail to read.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const rules = require('../app/owner-facts');
const { createProjects } = require('../app/server/projects');

const fact = (id, text, createdAt = '2026-11-01T00:00:00Z', extra = {}) => ({ id, projectId: '', category: 'owner', text, pinned: false, createdAt, updatedAt: createdAt, ...extra });
const day = n => new Date(Date.UTC(2026, 10, 1 + n)).toISOString();

test('a fact is one line of up to 200 characters', () => {
  assert.deepEqual(rules.check('  I print PLA\n on a   Bambu X2D.  '), { ok: true, text: 'I print PLA on a Bambu X2D.' });
  assert.equal(rules.check('x'.repeat(200)).ok, true);
  const long = rules.check('x'.repeat(201));
  assert.equal(long.ok, false);
  assert.match(long.error, /200 characters; this one has 201/);
  assert.equal(rules.check('   ').ok, false);
  assert.equal(rules.check(null).ok, false);
  assert.equal(rules.check(42).ok, false);
});

test('only shared notes in the owner category are facts, newest first', () => {
  const notes = [fact('a', 'old', day(1)), { ...fact('b', 'in a project', day(5)), projectId: 'prj-1' }, { ...fact('c', 'a note', day(6)), category: 'note' }, fact('d', 'new', day(3)), null, 'junk'];
  assert.deepEqual(rules.facts(notes).map(n => n.id), ['d', 'a']);
  assert.equal(rules.isFact({ category: 'owner' }), true, 'a missing projectId is the shared one');
  assert.deepEqual(rules.facts(undefined), []);
});

test('the list holds 30; the 31st is refused as full and nothing is dropped', () => {
  const notes = Array.from({ length: 30 }, (_, i) => fact('f' + i, 'Fact number ' + i, day(i)));
  const v = rules.canSave(notes, 'One more fact.');
  assert.equal(v.ok, false);
  assert.equal(v.full, true);
  assert.match(v.error, /30 of 30/);
  assert.equal(notes.length, 30);
  assert.equal(rules.canSave(notes, 'Fact number 3 edited', 'f3').ok, true, 'editing a fact on a full list is fine');
  assert.equal(rules.canSave(notes.slice(1), 'One more fact.').ok, true);
  assert.equal(rules.canSave(notes, 'Shared note made a fact', 'mem-shared').full, true, 'a note made a fact counts against the cap');
});

test('the same fact twice is refused, whatever its case or punctuation', () => {
  const notes = [fact('a', 'Answers in metric.')];
  assert.equal(rules.canSave(notes, 'answers in METRIC').duplicate, true);
  assert.equal(rules.canSave(notes, 'Answers in metric!', 'a').ok, true, 'a fact may be saved over itself');
  assert.equal(rules.sameKey('  Hello,  World! '), 'hello world');
});

test('select keeps older facts within the budget; the newest go first', () => {
  const notes = [fact('old', 'a'.repeat(300), day(1)), fact('mid', 'b'.repeat(300), day(2)), fact('new', 'c'.repeat(300), day(3)), fact('tiny', 'short', day(4))];
  const { kept, left, used } = rules.select(notes, 800, 3);
  assert.deepEqual(kept.map(n => n.id), ['old', 'mid', 'tiny'], 'a short newer fact still fits where a long one did not');
  assert.deepEqual(left.map(n => n.id), ['new']);
  assert.equal(used, 303 + 303 + 8);
  assert.deepEqual(rules.select(notes, 0).kept, []);
  assert.deepEqual(rules.select([], 800), { kept: [], left: [], used: 0 });
  assert.equal(rules.BUDGET, 800);
  assert.deepEqual(rules.select(notes, NaN).kept, []);
});

// The memory routes with an in-memory store. failRead makes the next store read throw, as a broken database would.
function routes(seed = []) {
  const state = { items: seed.map(x => ({ ...x })), failRead: false, saves: 0, activity: [] };
  let n = 0;
  const ctx = {
    MEMORY_STORE: 'memory', PROJECTS_STORE: 'projects', CONVERSATIONS_STORE: 'conversations', KNOWLEDGE_STORE: 'knowledge',
    json: (res, status, body) => { res.status = status; res.body = body; },
    makeId: p => `${p}-${++n}`, normalizeTitle: v => v, nowIso: () => '2026-11-19T12:00:00Z',
    objectStore: name => { assert.equal(name, 'memory'); if (state.failRead) throw new Error('database is locked'); return state.items.map(x => ({ ...x })); },
    readBody: async req => req.body, recordActivity: (...a) => state.activity.push(a), requireFeature: () => true,
    saveStore: (name, items) => { state.items = items.map(x => ({ ...x })); state.saves++; },
    storage: {}, storageError: (res, e, d = 400) => ctx.json(res, e.statusCode || d, { error: String(e.message || e) }) // as app/server/http.js does
  };
  const api = createProjects(ctx);
  const call = async (fn, body, url = 'http://x/api/memory') => { const res = {}; await api[fn]({ body }, res, new URL(url)); return res; };
  return { state, call };
}

test('POST /api/memory/add stores a fact as one normalised line', async () => {
  const { state, call } = routes();
  const r = await call('apiMemoryAdd', { category: 'owner', text: ' The PC has a\nGTX 1660 Super. ' });
  assert.equal(r.status, 201);
  assert.equal(r.body.item.text, 'The PC has a GTX 1660 Super.');
  assert.equal(r.body.item.projectId, '');
  assert.equal(state.items.length, 1);
  assert.equal(state.activity[0][1], 'Saved a fact about you');
});

test('add refuses a long fact, one filed under a project, a duplicate and the 31st', async () => {
  const { state, call } = routes(Array.from({ length: 29 }, (_, i) => fact('f' + i, 'Fact ' + i, day(i))));
  let r = await call('apiMemoryAdd', { category: 'owner', text: 'y'.repeat(201) });
  assert.equal(r.status, 400); assert.match(r.body.error, /200 characters/);
  r = await call('apiMemoryAdd', { category: 'owner', projectId: 'prj-1', text: 'Uses metric.' });
  assert.equal(r.status, 400); assert.match(r.body.error, /no project/);
  r = await call('apiMemoryAdd', { category: 'owner', text: 'fact 3' });
  assert.equal(r.status, 409); assert.match(r.body.error, /already on your list/);
  r = await call('apiMemoryAdd', { category: 'owner', text: 'The thirtieth fact.' });
  assert.equal(r.status, 201);
  r = await call('apiMemoryAdd', { category: 'owner', text: 'The thirty-first fact.' });
  assert.equal(r.status, 409);
  assert.equal(r.body.full, true); assert.equal(r.body.max, 30);
  assert.match(r.body.error, /30 of 30/);
  assert.equal(state.items.length, 30, 'nothing was dropped to make room');
});

test('other notes keep their old rules: 4,000 characters, any category, any project', async () => {
  const { state, call } = routes(Array.from({ length: 30 }, (_, i) => fact('f' + i, 'Fact ' + i)));
  const r = await call('apiMemoryAdd', { category: 'decision', projectId: 'prj-1', text: 'z'.repeat(5000) });
  assert.equal(r.status, 201);
  assert.equal(r.body.item.text.length, 4000);
  assert.equal(state.items.length, 31);
});

test('update edits a fact under the same rules, and makes a shared note a fact', async () => {
  const shared = { id: 'mem-s', projectId: '', category: 'note', text: 'Prefers matte finishes.', createdAt: day(0) };
  const project = { id: 'mem-p', projectId: 'prj-1', category: 'note', text: 'Budget 18k', createdAt: day(0) };
  const longShared = { id: 'mem-l', projectId: '', category: 'note', text: 'w'.repeat(240), createdAt: day(0) };
  const { state, call } = routes([fact('a', 'Answers in metric.'), fact('b', 'Prints PLA.'), shared, project, longShared]);
  let r = await call('apiMemoryUpdate', { id: 'a', text: 'Answers in metric,\n always.' });
  assert.equal(r.status, 200); assert.equal(r.body.item.text, 'Answers in metric, always.');
  r = await call('apiMemoryUpdate', { id: 'a', category: 'owner', text: '   ' });
  assert.equal(r.status, 400);
  r = await call('apiMemoryUpdate', { id: 'a', text: 'v'.repeat(201) });
  assert.equal(r.status, 400);
  r = await call('apiMemoryUpdate', { id: 'a', text: 'prints pla' });
  assert.equal(r.status, 409);
  assert.equal(state.items.find(x => x.id === 'a').text, 'Answers in metric, always.', 'a refused edit changes nothing');
  r = await call('apiMemoryUpdate', { id: 'mem-s', category: 'owner' });
  assert.equal(r.status, 200); assert.equal(r.body.item.category, 'owner');
  r = await call('apiMemoryUpdate', { id: 'mem-p', category: 'owner' });
  assert.equal(r.status, 400); assert.match(r.body.error, /shared note/);
  r = await call('apiMemoryUpdate', { id: 'mem-l', category: 'owner' });
  assert.equal(r.status, 400, 'a shared note over 200 characters cannot become a fact');
  assert.equal(state.items.find(x => x.id === 'mem-l').category, 'note');
});

test('making a note a fact on a full list is refused as full', async () => {
  const seed = [...Array.from({ length: 30 }, (_, i) => fact('f' + i, 'Fact ' + i)), { id: 'mem-s', projectId: '', category: 'note', text: 'Short note.' }];
  const { state, call } = routes(seed);
  const r = await call('apiMemoryUpdate', { id: 'mem-s', category: 'owner' });
  assert.equal(r.status, 409); assert.equal(r.body.full, true);
  assert.equal(state.items.find(x => x.id === 'mem-s').category, 'note');
});

test('a store that cannot be read refuses the change and says so; it never counts as an empty list', async () => {
  const { state, call } = routes([fact('a', 'Answers in metric.')]);
  state.failRead = true;
  let r = await call('apiMemoryAdd', { category: 'owner', text: 'New fact.' });
  assert.equal(r.status, 503);
  assert.match(r.body.error, /Couldn't read your saved facts, so nothing was changed\. database is locked/);
  r = await call('apiMemoryUpdate', { id: 'a', category: 'owner', text: 'Edited.' });
  assert.equal(r.status, 503);
  assert.equal(state.saves, 0);
  await assert.rejects(call('apiMemory', undefined), /database is locked/, 'GET /api/memory fails loudly (the server answers 500), never with items: []');
});

test('the page uses the same limits as the server', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'app', 'public', 'owner-facts.js'), 'utf8');
  assert.match(page, new RegExp(`MAX_FACTS\\s*=\\s*${rules.MAX_FACTS}\\b`));
  assert.match(page, new RegExp(`MAX_LENGTH\\s*=\\s*${rules.MAX_LENGTH}\\b`));
  assert.match(page, /CATEGORY\s*=\s*'owner'/);
});

test('forTurn: used, none, and a failed read that is never "none"', () => {
  assert.deepEqual(rules.forTurn(() => [fact('a', 'Metric.')]).facts.map(f => f.id), ['a']);
  assert.deepEqual(rules.forTurn(() => [{ id: 's', projectId: '', category: 'note', text: 'shared' }]), { state: 'none' });
  assert.deepEqual(rules.forTurn(() => { throw new Error('locked'); }), { state: 'unreadable' });
  assert.deepEqual(rules.forTurn(() => null), { state: 'unreadable' });
});

test('runMeta and cardLine: used on this PC, left out for a cloud model, unreadable', () => {
  const used = { state: 'used', facts: [fact('a', 'Metric.'), fact('b', 'PLA.')] };
  assert.deepEqual(rules.runMeta(used, { sent: true }), { memoryFacts: ['a', 'b'] });
  assert.deepEqual(rules.runMeta(used, { sent: false }), {}, 'fitting left the block out: nothing claimed');
  assert.deepEqual(rules.runMeta(used, { sent: true, cloud: true }), { memoryFactsCloud: true });
  assert.deepEqual(rules.runMeta({ state: 'unreadable' }), { memoryFactsUnread: true });
  assert.deepEqual(rules.runMeta({ state: 'none' }), {});
  assert.equal(rules.cardLine({ memoryFacts: ['a'] }).text, 'Used 1 of your saved facts');
  assert.equal(rules.cardLine({ memoryFacts: ['a', 'b'] }).text, 'Used 2 of your saved facts');
  assert.equal(rules.cardLine({ memoryFactsCloud: true }).text, rules.CLOUD);
  assert.equal(rules.cardLine({ memoryFactsUnread: true, memoryFacts: ['a'] }).text, rules.UNREADABLE, 'a failed read wins');
  assert.equal(rules.cardLine({ memoryFacts: [] }), null);
  assert.equal(rules.cardLine(null), null);
});
