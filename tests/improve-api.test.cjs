'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { Storage } = require('../app/storage');
const { spawnAppServer, stopChild, removeTree } = require('./spawn-server.cjs');

const APP = path.resolve(__dirname, '../app');
const dataDirs = new Map(); // base URL → that server's DATA_DIR
const RELEASE = { commit: 'a'.repeat(40), version: '2.0.300', deployedAt: '2026-10-15T20:00:00.000Z' };

// Starts a server on its own data folder. `seed(storage)` runs first; `release` runs a copy of app/ with a release.json.
async function startServer(t, { seed, release, ollama } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-improve-'));
  if (seed) { const storage = new Storage({ dataDir }); seed(storage); storage.close?.(); }
  let appDir = APP;
  if (release) {
    appDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'localai-app-')), 'app');
    fs.cpSync(APP, appDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, 'release.json'), JSON.stringify(release));
  }
  const { child, ready } = spawnAppServer({ appDir, env: { DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, OLLAMA_URL: ollama || 'http://127.0.0.1:9' } });
  t.after(async () => {
    await stopChild(child);
    removeTree(dataDir);
    if (release) removeTree(path.dirname(appDir));
  });
  const base = await ready;
  dataDirs.set(base, dataDir);
  return base;
}
const post = (base, p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));
const board = async base => (await (await fetch(base + '/api/claude/board')).json());
const finding = async (base, id) => (await board(base)).findings?.find(f => f.id === id) || (await board(base)).items?.find(f => f.id === id);

test('a Claude re-report keeps the backlog fields and the owner\'s votes', { timeout: 30000 }, async t => {
  const base = await startServer(t, {
    seed: s => s.writeSetting('claude-finding/x1', { id: 'x1', sessionId: 's', title: 'Old', category: 'ux', severity: 'medium', status: 'approved', source: 'idea', changeId: 'c1', handedToClaude: true, votes: { up: 2, down: 0 }, priorityBoost: 0, createdAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-15T00:00:00Z' })
  });
  assert.equal((await post(base, '/api/claude/findings', { sessionId: 's', findings: [{ id: 'x1', title: 'New title' }] })).status, 201);
  const f = await finding(base, 'x1');
  assert.equal(f.title, 'New title');
  assert.deepEqual([f.source, f.changeId, f.handedToClaude, f.votes.up], ['idea', 'c1', true, 2]);
});

test('a finding cannot claim to be a signal or an idea through the board API', { timeout: 30000 }, async t => {
  const base = await startServer(t);
  await post(base, '/api/claude/findings', { sessionId: 's', findings: [{ id: 'x2', title: 'Sneaky', source: 'signal', changeId: 'c9', handedToClaude: true }] });
  const f = await finding(base, 'x2');
  assert.equal(f.source, undefined);
  assert.equal(f.changeId, undefined);
  assert.equal(f.handedToClaude, undefined);
});

test('two scans at once still promote a serious signal only once', { timeout: 60000 }, async t => {
  const base = await startServer(t, {
    seed: s => s.put('issues', { id: 'issue-hot', key: 'browser-runtime:boom', kind: 'browser-runtime', name: 'Boom', detail: 'stack', severity: 'high', status: 'open', occurrences: 1, createdAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-15T00:00:00Z', lastSeenAt: '2026-10-15T00:00:00Z', lastEventAt: '2026-10-15T00:00:00Z', changeId: null }, 0)
  });
  await Promise.all([post(base, '/api/issues/scan', {}), post(base, '/api/issues/scan', {})]);
  const all = (await board(base)).findings || (await board(base)).items;
  const promoted = all.filter(f => f.id === 'signal-issue-hot');
  assert.equal(promoted.length, 1);
  assert.deepEqual([promoted[0].source, promoted[0].status, promoted[0].severity], ['signal', 'proposed', 'high']);
});

test('start-up stamps shipped items with the deployed release', { timeout: 60000 }, async t => {
  const base = await startServer(t, {
    release: RELEASE,
    seed: s => s.writeSetting('claude-finding/x3', { id: 'x3', sessionId: 's', title: 'Shipped one', category: 'ux', severity: 'low', status: 'fixed', source: 'idea', shipped: { pending: true, at: '2026-10-15T19:00:00.000Z' }, votes: { up: 0, down: 0 }, priorityBoost: 0, createdAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-15T00:00:00Z' })
  });
  const f = await finding(base, 'x3');
  assert.deepEqual(f.shipped, { version: '2.0.300', commit: 'a'.repeat(40), at: '2026-10-15T19:00:00.000Z', pending: false });
});

test('/api/claude/priorities keeps its exact field list', { timeout: 30000 }, async t => {
  const base = await startServer(t);
  await post(base, '/api/claude/findings', { sessionId: 's', findings: [{ id: 'x4', title: 'Anything', severity: 'high' }] });
  const { items } = await (await fetch(base + '/api/claude/priorities')).json();
  // decisionNote is present only when set (an undefined value is dropped from the JSON), so it is optional here.
  const keys = Object.keys(items[0]).filter(k => k !== 'decisionNote').sort();
  assert.deepEqual(keys, ['category', 'file', 'fix', 'id', 'rank', 'score', 'severity', 'status', 'title', 'votes'].sort());
  assert.ok(Object.keys(items[0]).every(k => k !== 'source' && k !== 'stage' && k !== 'shipped'), 'no Improve fields leak into priorities');
});

// A stand-in model for change planning: always proposes one small edit, so a plan is created in state "planned".
async function mockPlanner(t) {
  const plan = { summary: 'Planned change', notes: '', files: [{ path: 'public/app.js', operations: [{ type: 'append', content: '// planned' }] }] };
  const srv = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ message: { content: JSON.stringify(plan) }, done: true })); }); });
  srv.listen(0, '127.0.0.1'); await once(srv, 'listening'); t.after(() => srv.close());
  return `http://127.0.0.1:${srv.address().port}`;
}
const items = async base => (await (await fetch(base + '/api/improve/items')).json()).items;
const itemById = async (base, id) => (await items(base)).find(i => i.id === id);

test('Add to backlog creates an approved idea in the Backlog', { timeout: 30000 }, async t => {
  const base = await startServer(t);
  const r = await post(base, '/api/improve/idea', { text: 'Remember the image size\nAnd the style', start: false });
  assert.equal(r.status, 201);
  const it = await itemById(base, r.body.item.id);
  assert.deepEqual([it.source, it.status, it.stage, it.title], ['idea', 'approved', 'backlog', 'Remember the image size']);
});

test('blank ideas are refused; long ones are clipped', { timeout: 30000 }, async t => {
  const base = await startServer(t);
  const blank = await post(base, '/api/improve/idea', { text: '  \n ' });
  assert.deepEqual([blank.status, blank.body.error], [400, 'Describe the change first.']);
  const long = await post(base, '/api/improve/idea', { text: 'a'.repeat(20000) });
  assert.equal(long.status, 201);
  assert.deepEqual([long.body.item.title.length, long.body.item.summary.length], [120, 2000]);
});

test('Start now plans a change and links it to exactly one item', { timeout: 60000 }, async t => {
  const base = await startServer(t, { ollama: await mockPlanner(t) });
  const r = await post(base, '/api/improve/idea', { text: 'Make the header sticky', start: true });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.ok(r.body.change?.id);
  const it = await itemById(base, r.body.item.id);
  assert.deepEqual([it.changeId, it.status, it.stage], [r.body.change.id, 'approved', 'inProgress']);
  assert.equal((await items(base)).filter(i => i.changeId === r.body.change.id).length, 1);
  const again = await post(base, '/api/improve/item', { id: it.id, action: 'start' });
  assert.equal(again.status, 409);
});

test('Move to top ranks first; Hand to Claude leads the priorities with its note', { timeout: 30000 }, async t => {
  const base = await startServer(t);
  await post(base, '/api/claude/findings', { sessionId: 's', findings: [{ id: 'big', title: 'Big', severity: 'high' }, { id: 'small', title: 'Small', severity: 'low' }] });
  assert.equal((await post(base, '/api/improve/item', { id: 'small', action: 'moveToTop' })).status, 200);
  assert.equal((await itemById(base, 'small')).rank, 1);
  const idea = (await post(base, '/api/improve/idea', { text: 'Hand me over' })).body.item;
  await post(base, '/api/improve/item', { id: idea.id, action: 'handToClaude' });
  const top = (await (await fetch(base + '/api/claude/priorities')).json()).items[0];
  assert.deepEqual([top.id, top.decisionNote], [idea.id, 'Handed to Claude']);
});

test('Defer, Reject and an unknown id', { timeout: 30000 }, async t => {
  const base = await startServer(t);
  const a = (await post(base, '/api/improve/idea', { text: 'Later' })).body.item;
  await post(base, '/api/improve/item', { id: a.id, action: 'defer' });
  assert.equal((await itemById(base, a.id)).stage, 'setAside');
  assert.equal((await post(base, '/api/improve/item', { id: 'nope', action: 'defer' })).status, 404);
  assert.equal((await post(base, '/api/improve/item', { id: a.id, action: 'explode' })).status, 400);
});

test('Discard rejects the running change and sets the item aside', { timeout: 60000 }, async t => {
  const base = await startServer(t, { ollama: await mockPlanner(t) });
  const r = (await post(base, '/api/improve/idea', { text: 'Try something', start: true })).body;
  assert.equal((await post(base, '/api/improve/item', { id: r.item.id, action: 'discard', then: 'aside' })).status, 200);
  const it = await itemById(base, r.item.id);
  assert.deepEqual([it.status, it.stage], ['deferred', 'setAside']);
  const change = (await (await fetch(base + '/api/changes')).json()).items.find(c => c.id === r.change.id);
  assert.equal(change.status, 'rejected');
});

test('Promote and Dismiss signals; a dismissed one never comes back', { timeout: 60000 }, async t => {
  const issue = (id, name) => ({ id, key: 'browser-runtime:' + name, kind: 'browser-runtime', name, detail: '', severity: 'medium', status: 'open', occurrences: 1, createdAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-15T00:00:00Z', lastSeenAt: '2026-10-15T00:00:00Z', lastEventAt: '2026-10-15T00:00:00Z', changeId: null });
  const base = await startServer(t, { seed: s => { s.put('issues', issue('i-a', 'Alpha'), 0); s.put('issues', issue('i-b', 'Beta'), 1); } });
  assert.equal((await post(base, '/api/improve/signal', { id: 'i-a', action: 'promote' })).status, 200);
  assert.equal((await itemById(base, 'signal-i-a')).source, 'signal');
  assert.equal((await post(base, '/api/improve/signal', { id: 'i-b', action: 'dismiss' })).status, 200);
  await post(base, '/api/issues/scan', {});
  const signals = (await (await fetch(base + '/api/improve/items')).json()).signals;
  assert.equal(signals.find(x => x.id === 'i-b').status, 'ignored');
  assert.equal(await itemById(base, 'signal-i-b'), undefined);
});

const seedItem = (s, id, extra) => s.writeSetting('claude-finding/' + id, { id, sessionId: 'owner', title: 'Item ' + id, category: 'idea', severity: 'medium', status: 'approved', source: 'idea', votes: { up: 0, down: 0 }, priorityBoost: 0, createdAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-15T00:00:00Z', ...extra });
const seedChange = (s, id, status, extra = {}) => s.put('changes', { id, target: 'self', root: 'app', request: 'Do ' + id, summary: 'Change ' + id, files: [], status, createdAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-15T00:00:00Z', validation: null, diffs: [], ...extra }, 0);
const changeById = async (base, id) => (await (await fetch(base + '/api/changes')).json()).items.find(c => c.id === id);

test('Back to backlog retires the running change, so it does not reappear as a second item', { timeout: 60000 }, async t => {
  const base = await startServer(t, { ollama: await mockPlanner(t) });
  const r = (await post(base, '/api/improve/idea', { text: 'Undo me', start: true })).body;
  assert.equal((await post(base, '/api/improve/item', { id: r.item.id, action: 'backToBacklog' })).status, 200);
  assert.equal((await changeById(base, r.change.id)).status, 'rejected');
  const all = await items(base);
  assert.equal(all.filter(i => i.changeId === r.change.id && i.id !== r.item.id).length, 0);
  assert.equal(all.find(i => i.id === r.item.id).stage, 'backlog');
});

test('Retry retires the failed change and links the new one, with no duplicate item', { timeout: 60000 }, async t => {
  const base = await startServer(t, { ollama: await mockPlanner(t), seed: s => { seedChange(s, 'chg-old', 'validation_failed'); seedItem(s, 'idea-r', { changeId: 'chg-old' }); } });
  assert.equal((await post(base, '/api/improve/item', { id: 'idea-r', action: 'retry' })).status, 200);
  assert.equal((await changeById(base, 'chg-old')).status, 'rejected');
  const all = await items(base), it = all.find(i => i.id === 'idea-r');
  assert.notEqual(it.changeId, 'chg-old');
  assert.equal(it.stage, 'inProgress');
  assert.equal(all.filter(i => i.changeId === 'chg-old' || i.changeId === it.changeId).length, 1);
});

test('a change planned outside Improve is not turned into a backlog item while running', { timeout: 60000 }, async t => {
  const base = await startServer(t, { ollama: await mockPlanner(t) });
  const r = await post(base, '/api/changes/plan', { request: 'Direct change', target: 'self' });
  assert.equal(r.status, 201);
  assert.equal((await items(base)).filter(i => i.changeId === r.body.item.id).length, 0);
});

test('Discard rejects a pending approval and refuses a change that is being deployed', { timeout: 60000 }, async t => {
  const base = await startServer(t, { seed: s => {
    s.put('approvals', { id: 'appr-1', title: 'Apply change', detail: '', risk: 'high', status: 'pending', createdAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-15T00:00:00Z', meta: { changeId: 'chg-w' } }, 0);
    seedChange(s, 'chg-w', 'awaiting_approval', { approvalId: 'appr-1' }); seedItem(s, 'idea-w', { changeId: 'chg-w' });
    seedChange(s, 'chg-d', 'apply_requested'); seedItem(s, 'idea-d', { changeId: 'chg-d' });
  } });
  assert.equal((await post(base, '/api/improve/item', { id: 'idea-w', action: 'discard', then: 'backlog' })).status, 200);
  const approvals = (await (await fetch(base + '/api/approvals')).json()).items;
  assert.equal(approvals.find(a => a.id === 'appr-1').status, 'rejected');
  const d = await post(base, '/api/improve/item', { id: 'idea-d', action: 'discard', then: 'backlog' });
  assert.equal(d.status, 409);
  // Start-up hands changes left at apply_requested to Claude as a pull request (approved, shipVia pr); still locked.
  const shipping = await changeById(base, 'chg-d');
  assert.equal(shipping.status, 'approved');
  assert.equal(shipping.shipVia, 'pr');
});

test('Start now keeps the idea and says so when planning fails', { timeout: 60000 }, async t => {
  const base = await startServer(t);
  const r = await post(base, '/api/improve/idea', { text: 'Plan me when the model is down', start: true });
  assert.equal(r.status, 201);
  assert.ok(r.body.error, 'reports the planning error');
  assert.equal((await itemById(base, r.body.item.id)).stage, 'backlog');
});

test('a rejected signal item stays rejected on a large board', { timeout: 60000 }, async t => {
  const base = await startServer(t, { seed: s => {
    for (let i = 0; i < 1005; i++) s.writeSetting('claude-finding/zz-' + String(i).padStart(4, '0'), { id: 'zz-' + String(i).padStart(4, '0'), sessionId: 's', title: 'Filler', category: 'other', severity: 'low', status: 'proposed', votes: { up: 0, down: 0 }, priorityBoost: 0, createdAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-15T00:00:00Z' });
    s.put('issues', { id: 'i-r', key: 'browser-runtime:r', kind: 'browser-runtime', name: 'R', detail: '', severity: 'high', status: 'open', occurrences: 1, createdAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-15T00:00:00Z', lastSeenAt: '2026-10-15T00:00:00Z', lastEventAt: '2026-10-15T00:00:00Z', changeId: null }, 0);
    s.writeSetting('claude-finding/signal-i-r', { id: 'signal-i-r', sessionId: 'improve', title: 'R', category: 'bug', severity: 'high', status: 'rejected', source: 'signal', signalId: 'i-r', votes: { up: 0, down: 0 }, priorityBoost: 0, createdAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-15T00:00:00Z' });
  } });
  await post(base, '/api/issues/scan', {});
  const store = new Storage({ dataDir: dataDirs.get(base), readOnly: true });
  try {
    assert.equal(store.readSetting('claude-finding/signal-i-r', null).status, 'rejected');
  } finally {
    store.close?.();
  }
});


test('actions that make no sense for an item\'s stage are refused', { timeout: 60000 }, async t => {
  const base = await startServer(t, { ollama: await mockPlanner(t), seed: s => {
    seedItem(s, 'idea-done', { status: 'fixed' });
    seedItem(s, 'idea-aside', { status: 'deferred' });
    seedChange(s, 'chg-run', 'planned'); seedItem(s, 'idea-run', { changeId: 'chg-run' });
    seedItem(s, 'idea-plain', {});
  } });
  for (const action of ['handToClaude', 'start', 'moveToTop', 'retry', 'defer', 'reject']) {
    assert.equal((await post(base, '/api/improve/item', { id: 'idea-done', action })).status, 409, `shipped: ${action}`);
  }
  for (const action of ['handToClaude', 'start', 'moveToTop']) {
    assert.equal((await post(base, '/api/improve/item', { id: 'idea-aside', action })).status, 409, `set aside: ${action}`);
  }
  assert.equal((await post(base, '/api/improve/item', { id: 'idea-plain', action: 'retry' })).status, 409, 'retry needs a failed change');
  assert.equal((await post(base, '/api/improve/item', { id: 'idea-aside', action: 'backToBacklog' })).status, 200, 'set-aside items can come back');
  // Deferring an item with a running change stops that change.
  assert.equal((await post(base, '/api/improve/item', { id: 'idea-run', action: 'defer' })).status, 200);
  assert.equal((await changeById(base, 'chg-run')).status, 'rejected');
});

test('Improve\'s own ids cannot be created through the board API, but Claude can update them', { timeout: 30000 }, async t => {
  const base = await startServer(t, { seed: s => seedItem(s, 'idea-mine', {}) });
  const r = await post(base, '/api/claude/findings', { sessionId: 's', findings: [{ id: 'signal-issue-x', title: 'Squatter' }, { id: 'idea-change-y', title: 'Squatter 2' }, { id: 'idea-mine', title: 'Item idea-mine', status: 'in_progress' }] });
  assert.equal(r.status, 201);
  assert.equal(await itemById(base, 'signal-issue-x'), undefined);
  assert.equal(await itemById(base, 'idea-change-y'), undefined);
  const mine = await itemById(base, 'idea-mine');
  assert.deepEqual([mine.status, mine.source], ['in_progress', 'idea']);
});

test('a long idea in multibyte text is clipped, not refused', { timeout: 30000 }, async t => {
  const base = await startServer(t);
  const r = await post(base, '/api/improve/idea', { text: '🙂'.repeat(20000) });
  assert.equal(r.status, 201);
  assert.ok(r.body.item.summary.length <= 2000);
});

test('a masked cross-origin "Script error." never becomes a signal; a real error does', { timeout: 60000 }, async t => {
  const base = await startServer(t);
  // #139 drops opaque errors at the door (202 ignored); either way they must never reach Signals.
  const masked = await post(base, '/api/quality/client-event', { type: 'error', message: 'Script error.', source: '/', line: 0 });
  assert.equal(masked.status, 202);
  assert.equal(masked.body.ignored, true);
  const real = await post(base, '/api/quality/client-event', { type: 'error', message: 'TypeError: x is undefined', source: '/app.js', line: 12, stack: 'at f (/app.js:12)' });
  assert.equal(real.body.item.severity, 'high');
  await post(base, '/api/issues/scan', {});
  const signals = (await (await fetch(base + '/api/improve/items')).json()).signals;
  assert.equal(signals.some(s => s.name === 'Script error.'), false);
  assert.equal(signals.some(s => s.name.startsWith('TypeError: x is undefined')), true);
});

test('dismissing a promoted signal closes its backlog item; Back to backlog clears the hand-off', { timeout: 60000 }, async t => {
  const base = await startServer(t, { seed: s => {
    s.put('issues', { id: 'i-d', key: 'browser-runtime:d', kind: 'browser-runtime', name: 'D', detail: '', severity: 'medium', status: 'open', occurrences: 1, createdAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-15T00:00:00Z', lastSeenAt: '2026-10-15T00:00:00Z', lastEventAt: '2026-10-15T00:00:00Z', changeId: null }, 0);
    seedItem(s, 'idea-h', { handedToClaude: true, priorityBoost: 30, decisionNote: 'Handed to Claude' });
  } });
  await post(base, '/api/improve/signal', { id: 'i-d', action: 'promote' });
  await post(base, '/api/improve/signal', { id: 'i-d', action: 'dismiss' });
  const promoted = await itemById(base, 'signal-i-d');
  assert.deepEqual([promoted.status, promoted.stage], ['rejected', 'setAside']);
  assert.equal((await post(base, '/api/improve/item', { id: 'idea-h', action: 'backToBacklog' })).status, 200);
  const h = await itemById(base, 'idea-h');
  assert.deepEqual([h.handedToClaude, h.priorityBoost], [false, 0]);
});

test('deciding a change\'s approval from Approvals or the run view decides the change too', { timeout: 60000 }, async t => {
  const approval = (id, changeId) => ({ id, title: 'Apply change ' + changeId, detail: '', risk: 'high', status: 'pending', createdAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-15T00:00:00Z', meta: { changeId, type: 'change', target: 'self' } });
  const base = await startServer(t, { seed: s => {
    s.put('approvals', approval('appr-a', 'chg-a'), 0); seedChange(s, 'chg-a', 'awaiting_approval', { approvalId: 'appr-a' });
    s.put('approvals', approval('appr-r', 'chg-r'), 1); seedChange(s, 'chg-r', 'awaiting_approval', { approvalId: 'appr-r' });
    s.put('approvals', { id: 'appr-x', title: 'Agent action', detail: '', risk: 'medium', status: 'pending', createdAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-15T00:00:00Z', meta: { type: 'agent' } }, 2);
  } });
  const a = await post(base, '/api/approvals/decide', { id: 'appr-a', decision: 'approved' });
  assert.equal(a.status, 200);
  assert.equal(a.body.item.status, 'approved');
  assert.equal((await changeById(base, 'chg-a')).status, 'approved');
  await post(base, '/api/approvals/decide', { id: 'appr-r', decision: 'rejected' });
  assert.equal((await changeById(base, 'chg-r')).status, 'rejected');
  // Approvals that aren't for a change behave as before.
  assert.equal((await post(base, '/api/approvals/decide', { id: 'appr-x', decision: 'approved' })).body.item.status, 'approved');
});

// Look review, 1 Nov: two backlog rows read "Overall assessment". The same words from the same source within minutes are one item.
test('the same idea twice within minutes is one backlog item; a finding without an id repeats into the first', { timeout: 30000 }, async t => {
  const base = await startServer(t);
  const a = await post(base, '/api/improve/idea', { text: '## Overall assessment\nThe Home page needs a clearer printer card.' });
  const b = await post(base, '/api/improve/idea', { text: '## Overall assessment\nThe Home page needs a clearer printer card.' });
  assert.deepEqual([a.status, b.status, b.body.item.id], [201, 200, a.body.item.id]);
  const f1 = await post(base, '/api/claude/findings', { sessionId: 's', findings: [{ title: '## Overall assessment', summary: 'first' }] });
  const f2 = await post(base, '/api/claude/findings', { sessionId: 's', findings: [{ title: 'Overall assessment', summary: 'second' }] });
  assert.equal(f1.body.items[0].id, f2.body.items[0].id);
  // An id means "this one": two ids with one title stay two items, and a different source never merges.
  await post(base, '/api/claude/findings', { sessionId: 's', findings: [{ id: 'k1', title: 'Same words' }, { id: 'k2', title: 'Same words' }] });
  const all = await items(base);
  assert.equal(all.filter(i => i.title === 'Same words').length, 2);
  assert.equal(all.filter(i => /^(## )?Overall assessment$|^The Home page needs/.test(i.title)).length, 2, 'one idea and one Claude finding');
});
