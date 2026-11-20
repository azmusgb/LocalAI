'use strict';

// Claude session records are bounded: the board keeps the most recent sessions plus any an open finding still names,
// and a session stored "active" with no event for the live window is reported idle, not active forever.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { Storage } = require('../app/storage');
const { spawnAppServer } = require('./spawn-server.cjs');
const changes = require('../app/server/changes');

const NOW = Date.parse('2026-11-19T12:00:00Z');
const iso = msAgo => new Date(NOW - msAgo).toISOString();
const session = (id, msAgo, extra = {}) => ({ id, title: id, status: 'active', startedAt: iso(msAgo), updatedAt: iso(msAgo), eventCount: 1, ...extra });

test('claudeKeptSessions keeps the newest `cap` sessions and drops the rest', () => {
  const sessions = Array.from({ length: 10 }, (_, i) => session(`s${i}`, i * 60000));
  const { keep, drop } = changes.claudeKeptSessions(sessions.slice().reverse(), [], 3);
  assert.deepEqual(keep.map(s => s.id), ['s0', 's1', 's2'], 'newest first, cap respected');
  assert.deepEqual(drop.map(s => s.id).sort(), ['s3', 's4', 's5', 's6', 's7', 's8', 's9']);
});

test('claudeKeptSessions never drops a session an open finding names, and does drop one only closed findings name', () => {
  const sessions = Array.from({ length: 6 }, (_, i) => session(`cc-${i}aaaaaaa`, i * 60000));
  const findings = [
    { id: 'a', sessionId: 'cc-4aaaaaaa', status: 'proposed' },
    { id: 'b', sessionId: '5aaaaaaa-full-uuid', status: 'in_progress' }, // Improve matches cc-<first 8> too
    { id: 'c', sessionId: 'cc-3aaaaaaa', status: 'fixed' },
    { id: 'd', sessionId: 'cc-2aaaaaaa', status: 'rejected' }
  ];
  const { keep, drop } = changes.claudeKeptSessions(sessions, findings, 1);
  assert.deepEqual(keep.map(s => s.id), ['cc-0aaaaaaa', 'cc-4aaaaaaa', 'cc-5aaaaaaa'], 'cap plus open-finding sessions, newest first');
  assert.deepEqual(drop.map(s => s.id).sort(), ['cc-1aaaaaaa', 'cc-2aaaaaaa', 'cc-3aaaaaaa'], 'fixed and rejected findings do not hold a session');
});

test('claudeSessionView reports a stored-active session with no event for the live window as idle', () => {
  const window = changes.CLAUDE_LIVE_WINDOW_MS;
  const fresh = changes.claudeSessionView(session('a', 0, { lastEventAt: iso(window - 1000) }), NOW);
  assert.equal(fresh.status, 'active', 'an event inside the window stays active');
  assert.equal(fresh.stale, undefined);
  const old = changes.claudeSessionView(session('b', 0, { lastEventAt: iso(window + 1000) }), NOW);
  assert.equal(old.status, 'idle', 'a fresh updatedAt (a findings post) does not keep it active when the last event is old');
  assert.equal(old.stale, true);
  assert.equal(changes.claudeSessionView(session('c', window + 1000), NOW).status, 'idle', 'older records without lastEventAt fall back to updatedAt');
  assert.equal(changes.claudeSessionView(session('d', 0, { updatedAt: 'not a date' }), NOW).status, 'idle', 'an unreadable time is not shown as active');
  assert.equal(changes.claudeSessionView(session('e', window * 10, { status: 'done' }), NOW).status, 'done', 'done and failed are left as reported');
  assert.equal(changes.claudeSessionView(session('f', window * 10, { status: 'failed' }), NOW).status, 'failed');
});

test('board: posting events prunes stored sessions to the cap, keeps open-finding sessions, and reports stale ones idle', { timeout: 30000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-claude-cap-'));
  const cap = changes.CLAUDE_MAX_SESSIONS;
  const now = Date.now(), at = msAgo => new Date(now - msAgo).toISOString();
  const storage = new Storage({ dataDir });
  // cap + 50 stale "active" sessions, the oldest of which has an open finding and one a fixed finding.
  for (let i = 0; i < cap + 50; i++) {
    const id = `cc-${String(i).padStart(8, '0')}`;
    storage.writeSetting(`claude-session/${id}`, { id, title: 'billrahe · Claude Code', status: 'active', startedAt: at(86400000), updatedAt: at(3600000 + i * 60000), eventCount: 1 });
  }
  const oldest = `cc-${String(cap + 49).padStart(8, '0')}`, closed = `cc-${String(cap + 48).padStart(8, '0')}`;
  storage.writeSetting('claude-finding/keep-me', { id: 'keep-me', sessionId: oldest, title: 'open', category: 'other', severity: 'medium', status: 'approved', votes: { up: 0, down: 0 }, createdAt: at(0), updatedAt: at(0) });
  storage.writeSetting('claude-finding/done', { id: 'done', sessionId: closed, title: 'done', category: 'other', severity: 'medium', status: 'fixed', votes: { up: 0, down: 0 }, createdAt: at(0), updatedAt: at(0) });
  storage.close();

  const { child, ready } = spawnAppServer({ env: { DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, OLLAMA_URL: 'http://127.0.0.1:9', SEARXNG_URL: 'http://127.0.0.1:9', COMFY_URL: 'http://127.0.0.1:9', N8N_URL: 'http://127.0.0.1:9', PROXY_URL: 'http://127.0.0.1:9', MAC_AI_HOME_URL: 'http://127.0.0.1:9', MAC_DSH_URL: 'http://127.0.0.1:9' } });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = await ready;
  const board = async () => (await fetch(`${base}/api/claude/board`)).json();

  let b = await board();
  assert.ok(b.sessions.length <= cap + 1, `board lists at most the cap plus open-finding sessions before any prune (got ${b.sessions.length})`);
  assert.ok(b.sessions.some(s => s.id === oldest), 'the session an open finding names is listed');
  assert.ok(b.sessions.every(s => s.status !== 'active'), 'sessions with no event for 30 min are not reported active');

  const r = await fetch(`${base}/api/claude/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'cc-newone01', sessionTitle: 'new', sessionStatus: 'active', events: [{ title: 'Run tests' }] }) });
  assert.equal(r.status, 201);
  b = await board();
  assert.equal(b.sessions[0].id, 'cc-newone01');
  assert.equal(b.sessions[0].status, 'active', 'a session with a fresh event is active');
  assert.ok(b.sessions[0].lastEventAt, 'events stamp lastEventAt');

  const stored = new Storage({ dataDir, readOnly: true });
  try {
    const ids = stored.listSettings('claude-session/').map(s => s.id);
    assert.equal(ids.length, cap + 1, 'stored sessions pruned to the cap plus the open-finding session');
    assert.ok(ids.includes(oldest), 'a session with an open finding is never pruned');
    assert.ok(!ids.includes(closed), 'a session whose only finding is fixed is pruned');
  } finally { stored.close(); }
});
