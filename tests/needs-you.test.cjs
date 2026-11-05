'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawnAppServer } = require('./spawn-server.cjs');
const N = require('../app/public/needs-you');

const HOUR = 3600e3, NOW = Date.parse('2026-10-18T16:00:00Z');
let seq = 0;
const run = (type, title, ageMs, o = {}) => {
  const id = o.id || `run-${++seq}`, at = new Date(NOW - ageMs).toISOString();
  return { id, threadId: o.threadId || id, type, title, status: o.status || 'failed', createdAt: at, updatedAt: o.updatedAt || at, finishedAt: o.finishedAt || null, retryOf: o.retryOf || null, seenAt: o.seenAt };
};
const ids = list => list.map(r => r.id);

test('approvals always need you; a failure needs you for a day, until opened, retried or answered by a later success', () => {
  const approval = run('change', 'Apply the fix', 5 * 24 * HOUR, { id: 'apr', status: 'awaiting_approval' });
  const fresh = run('agent', 'Weekly report', 2 * HOUR, { id: 'fresh' });
  const old = run('agent', 'Old mission', 25 * HOUR, { id: 'old' });
  const opened = run('chat', 'Opened one', HOUR, { id: 'opened', seenAt: new Date(NOW).toISOString() });
  const retried = run('image', 'A fox', 3 * HOUR, { id: 'retried' }), retry = run('image', 'A fox', 2 * HOUR, { id: 'retry', status: 'running', retryOf: 'retried' });
  const done = run('agent', 'Polish agent world', HOUR, { status: 'completed' });
  const before = run('agent', 'Polish agent world', 3 * HOUR, { id: 'answered' });
  const after = run('agent', 'Polish agent world', 30 * 60e3, { id: 'after' });
  const cancelled = run('agent', 'Tidy the inbox', HOUR, { status: 'cancelled' }), tidy = run('agent', 'Tidy the inbox', 2.5 * HOUR, { id: 'tidy' });
  const out = N.pick([approval, fresh, old, opened, retried, retry, done, before, after, cancelled, tidy], { now: NOW });
  assert.deepEqual(ids(out), ['apr', 'after', 'fresh', 'tidy']);
});

test('a day is counted from when it failed, not from when it started or was last filed', () => {
  const long = run('agent', 'Long mission', 30 * HOUR, { id: 'long', finishedAt: new Date(NOW - 20 * HOUR).toISOString(), updatedAt: new Date(NOW - HOUR).toISOString() });
  assert.deepEqual(ids(N.pick([long], { now: NOW })), ['long']);
  assert.deepEqual(ids(N.pick([long], { now: NOW + 5 * HOUR })), []);
});

test('only the latest turn of a thread counts', () => {
  const failed = run('chat', 'Q', 3 * HOUR, { id: 'f', threadId: 't' }), ok = run('chat', 'Q again', HOUR, { id: 'ok', threadId: 't', status: 'completed' });
  assert.deepEqual(ids(N.pick([failed, ok], { now: NOW })), []);
});

test('failures of one goal fold into one entry, newest first; approvals stay one each', () => {
  const list = N.pick([
    run('agent', 'Improve look feel and polish of agent world', 1 * HOUR, { id: 'a1' }),
    run('chat', 'Chat', 2 * HOUR, { id: 'c1' }),
    run('agent', 'Improve  look feel and polish of Agent World', 3 * HOUR, { id: 'a2' }),
    run('agent', 'Improve look feel and polish of agent world', 4 * HOUR, { id: 'a3' }),
    run('chat', 'Chat', 5 * HOUR, { id: 'c2' }),
    run('image', 'Improve look feel and polish of agent world', 6 * HOUR, { id: 'i1' }),
    run('change', 'One', 7 * HOUR, { id: 'p1', status: 'awaiting_approval' }),
    run('change', 'One', 8 * HOUR, { id: 'p2', status: 'awaiting_approval' })
  ], { now: NOW });
  assert.deepEqual(N.group(list).map(g => [g.run.id, g.runs.length]), [['p1', 1], ['p2', 1], ['a1', 3], ['c1', 2], ['i1', 1]]);
});

// The server: /api/runs carries seenAt from POST /api/runs/seen, so every device agrees; Work's kind=needs uses the same rule.
test('seen is kept on the server, and Work\'s Needs you filter matches Home\'s rule', { timeout: 30000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-needs-'));
  const { Storage } = require('../app/storage');
  const { RunLedger } = require('../app/run-ledger');
  const storage = new Storage({ dataDir }), ledger = new RunLedger({ storage });
  const failed = title => { const r = ledger.create({ type: 'agent', title }); ledger.fail(r.id, 'Mission stopped'); return r.id; };
  const a = failed('Weekly report'), b = failed('Weekly report'), c = failed('Plan the garden');
  const ok = ledger.create({ type: 'chat', title: 'Fine' }); ledger.complete(ok.id, { summary: 'ok' });
  storage.close?.();
  const off = 'http://127.0.0.1:9';
  const { child, ready } = spawnAppServer({ env: { DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, OLLAMA_URL: off, COMFY_URL: off, N8N_URL: off, PROXY_URL: off, SEARXNG_URL: off, MAC_AI_HOME_URL: off, MAC_DSH_URL: off } });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = await ready;
  const get = async url => (await fetch(base + url)).json();
  const post = (url, body, headers = {}) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const needs = async () => (await get('/api/runs?threads=1&kind=needs')).items.map(x => x.id).sort();

  assert.deepEqual(await needs(), [a, b, c].sort());
  assert.deepEqual(ids(N.pick((await get('/api/runs?limit=120')).items)).sort(), [a, b, c].sort(), 'Home\'s pick over /api/runs agrees');

  assert.equal((await post('/api/runs/seen', { ids: [a, b] })).status, 200);
  assert.deepEqual(await needs(), [c]);
  const listed = (await get('/api/runs?limit=120')).items;
  assert.ok(listed.find(x => x.id === a).seenAt && !listed.find(x => x.id === c).seenAt, 'another device reading /api/runs sees seenAt');
  assert.ok((await get('/api/runs?id=' + a)).item.seenAt, 'the run view sees it too');
  assert.ok((await get('/api/runs?threads=1&limit=60')).items.some(x => x.id === a), 'it stays in Work');

  assert.equal((await post('/api/runs/seen', { ids: [] })).status, 400);
  assert.equal((await post('/api/runs/seen', { ids: ['../etc'] })).status, 400);
  assert.equal((await post('/api/runs/seen', { ids: [c] }, { Origin: 'http://evil.example' })).status, 403);

  // Deleting a failure (Delete with Undo, #311) takes it out of Needs you too.
  assert.equal((await post('/api/items/delete', { items: [{ kind: 'thread', id: c }] })).status, 200);
  assert.deepEqual(await needs(), []);
});

// Home's Recent: an hourly automation used to fill all six rows. Its repeats fold into its newest run.
test('recent folds repeats of one automation into its newest run and leaves out what Needs you shows', () => {
  const auto = (id, ageH, o = {}) => ({ ...run('automation', 'Hourly Stack & ComfyUI Health Check', ageH * HOUR, { id, status: 'completed', ...o }), meta: { automationId: 'auto-1' } });
  const items = [auto('a1', 1), run('chat', 'What is on tonight', 1.5 * HOUR, { id: 'c1', status: 'completed' }), auto('a2', 2), auto('a3', 3),
    run('image', 'A fox', 4 * HOUR, { id: 'i1', status: 'completed' }), auto('a4', 4), run('agent', 'Weekly report', 5 * HOUR, { id: 'needs1' }),
    { ...run('automation', 'Nightly backup', 6 * HOUR, { id: 'b1', status: 'completed' }), meta: { automationId: 'auto-2' } }];
  assert.deepEqual(ids(N.recent(items, [{ id: 'needs1' }])), ['a1', 'c1', 'i1', 'b1']);
  assert.equal(N.recent(items, [], 2).length, 2);
  assert.deepEqual(ids(N.recent([], [])), []);
});

// Home's Needs you also lists Pi Hub's items that aren't Local AI's own rows (one list on every screen).
test('hubRows: everything but the summary of Local AI\'s own rows, with where each opens', () => {
  const items = [
    { id: 'printer:plate', source: 'Printer', tone: 'attention', title: 'Clear the plate', detail: 'Finished E-022', link: '/workshop' },
    { id: 'localai:needs-2', source: 'Local AI', tone: 'attention', title: 'Needs you', detail: '2 approvals' },
    { id: 'localai:watch-mac-disk', source: 'Local AI', tone: 'warn', title: 'Worth a look', detail: 'Mac disk is 94% full', link: '' },
    { id: 'localai:judge-PR-022-01', source: 'Local AI', tone: 'attention', title: 'Judge E-022', detail: 'Look at: ridges', link: '/lab?p=hex-tile&e=E-022&do=judge' },
    { id: 'localai:lab-PR-022-01', source: 'Local AI', tone: 'busy', title: 'Lab · E-022', detail: '' },
    { id: 'pi:disk', source: 'Pi', tone: 'bad', title: 'Pi disk is full', detail: '', link: '/pi' },
    { id: 'pi:odd', source: 'Pi', tone: 'weird', title: 'Odd', detail: '' },
    { id: '', title: 'no id' }, null];
  const rows = N.hubRows(items);
  assert.deepEqual(rows.map(r => r.id), ['printer:plate', 'localai:watch-mac-disk', 'localai:judge-PR-022-01', 'localai:lab-PR-022-01', 'pi:disk', 'pi:odd']);
  assert.deepEqual(rows.map(r => r.tone), ['attention', 'warn', 'attention', 'warn', 'bad', 'warn'], 'only bad, attention and warn; anything else is warn');
  assert.deepEqual(rows.map(r => r.open), [{ hub: '/workshop' }, { view: 'status' }, { hub: '/lab?p=hex-tile&e=E-022&do=judge' }, { hub: '/lab' }, { hub: '/pi' }, { hub: '/' }]);
  assert.equal(rows[0].title, 'Clear the plate');
  assert.equal(rows[0].detail, 'Finished E-022');
  assert.deepEqual(N.hubRows(null), []);
  assert.deepEqual(N.hubRows('no'), []);
});

test('hubRows keeps the hub\'s verb as a phrase key only (A7 P2), never words', () => {
  const rows = N.hubRows([{ id: 'pi:net', title: 'Ad blocking', link: '/network', action: 'open_network' },
    { id: 'pi:x', title: 'X', action: 'Click <b>here</b>' }, { id: 'pi:y', title: 'Y' }]);
  assert.deepEqual(rows.map(r => r.action), ['open_network', '', '']);
});

test('byTone: bad, then attention, then warn; the same tone keeps its order', () => {
  const list = [{ k: 1, tone: 'warn' }, { k: 2, tone: 'attention' }, { k: 3, tone: 'bad' }, { k: 4, tone: 'attention' }, { k: 5, tone: 'bad' }];
  assert.deepEqual(N.byTone(list).map(x => x.k), [3, 5, 2, 4, 1]);
  assert.deepEqual(list.map(x => x.k), [1, 2, 3, 4, 5], 'the input is left as it was');
});
