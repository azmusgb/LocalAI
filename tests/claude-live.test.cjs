'use strict';

// GET /api/claude/board `live`: which Claude Code sessions are active right now, derived from each session's newest event.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { Storage } = require('../app/storage');

test('Claude board live sessions: working, waiting, excluded, ordered, titled with the short id', { timeout: 30000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-claude-live-'));
  const now = Date.now();
  const ago = s => new Date(now - s * 1000).toISOString();
  // Events are seeded directly so they can be old; the API always stamps "now".
  const storage = new Storage({ dataDir });
  let n = 0;
  const seed = (id, title, events) => {
    storage.writeSetting(`claude-session/${id}`, { id, title, status: 'active', startedAt: ago(7200), updatedAt: events[0].at, eventCount: events.length });
    for (const e of events) storage.writeSetting(`claude-event/${String(now - n * 1000).padStart(14, '0')}-${(n++).toString(36).padStart(3, '0')}`, { sessionId: id, kind: 'action', tool: '', detail: '', status: 'info', phase: '', ...e });
  };
  // Newest event first within a session.
  seed('cc-aaaa1111', 'home · Claude Code', [{ at: ago(30), title: 'Edit app/server.js' }, { at: ago(3000), title: 'Finished responding' }]);
  seed('cc-bbbb2222', 'home · Claude Code', [{ at: ago(300), title: 'Finished responding' }]);
  seed('cc-cccc3333', 'api · Claude Code', [{ at: ago(600), title: 'Run tests' }]);
  seed('cc-dddd4444', 'old · Claude Code', [{ at: ago(2400), title: 'Run tests' }]);
  seed('cc-eeee5555', 'home · Claude Code', [{ at: ago(10), title: 'Read README.md' }]);
  seed('cc-ffff6666', 'stale-stop · Claude Code', [{ at: ago(2400), title: 'Finished responding' }]);
  storage.close();

  const reserve = http.createServer();
  reserve.listen(0, '127.0.0.1');
  await once(reserve, 'listening');
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  let diagnostics = '';
  const child = spawn(process.execPath, [path.resolve(__dirname, '../app/server.js')], {
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), WORKSPACE_ROOT: dataDir, OLLAMA_URL: 'http://127.0.0.1:9', SEARXNG_URL: 'http://127.0.0.1:9', COMFY_URL: 'http://127.0.0.1:9', N8N_URL: 'http://127.0.0.1:9', PROXY_URL: 'http://127.0.0.1:9', MAC_AI_HOME_URL: 'http://127.0.0.1:9', MAC_DSH_URL: 'http://127.0.0.1:9' }
  });
  child.stdout.on('data', c => diagnostics += c);
  child.stderr.on('data', c => diagnostics += c);
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) throw new Error(diagnostics);
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch {}
    if (attempt === 79) throw new Error(`Server did not start: ${diagnostics}`);
    await new Promise(r => setTimeout(r, 100));
  }

  const { live } = await (await fetch(`${base}/api/claude/board`)).json();
  assert.ok(Array.isArray(live), 'board has a live array');
  const by = id => live.find(l => l.id === id);
  assert.equal(by('cc-aaaa1111').state, 'working', 'a 30 s old non-Stop event is working, even after an older Stop');
  assert.equal(by('cc-aaaa1111').lastEvent, 'Edit app/server.js');
  assert.equal(by('cc-bbbb2222').state, 'waiting', 'a Stop 5 min old is waiting');
  assert.equal(by('cc-cccc3333').state, 'waiting', 'a non-Stop event 10 min old is idle, so waiting');
  assert.equal(by('cc-dddd4444'), undefined, '40 min old is excluded');
  assert.equal(by('cc-ffff6666'), undefined, 'a 40 min old Stop is excluded');
  assert.deepEqual(live.map(l => l.id), ['cc-eeee5555', 'cc-aaaa1111', 'cc-bbbb2222', 'cc-cccc3333'], 'working first, newest first within each group');
  assert.equal(by('cc-aaaa1111').title, 'home · Claude Code · aaaa1111', 'title carries the short id without the cc- prefix');
  assert.notEqual(by('cc-aaaa1111').title, by('cc-eeee5555').title, 'identical session titles stay distinguishable');
  assert.ok(Number.isFinite(Date.parse(by('cc-bbbb2222').at)), 'at is an ISO time');
});
