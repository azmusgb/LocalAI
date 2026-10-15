'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

test('Claude board ingests progress and findings, ranks them, and records votes and decisions', { timeout: 30000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-claude-'));
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
  const post = async (p, body, status = 201) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    assert.equal(r.status, status, JSON.stringify(j));
    return j;
  };
  const board = async (q = '') => (await fetch(`${base}/api/claude/board${q}`)).json();

  await post('/api/claude/events', { sessionId: 'Review 1', sessionTitle: 'Code review', events: [
    { kind: 'phase', title: 'Review', status: 'started', phase: 'review' },
    { tool: 'Bash', title: 'Run tests', status: 'done' }
  ] });
  await post('/api/claude/events', { sessionId: 'other', title: 'Unrelated', status: 'bogus' });
  await post('/api/claude/findings', { sessionId: 'review-1', findings: [
    { id: 'sec-1', title: 'LAN to host execution', category: 'security', severity: 'high' },
    { id: 'perf-1', title: 'Full rewrites', category: 'performance', severity: 'medium', summary: '<b>x</b>' },
    { id: 'ui-1', title: 'Dead code', category: 'cleanup', severity: 'low' }
  ] });

  let b = await board();
  assert.deepEqual(b.events.slice(0, 3).map(e => e.title), ['Unrelated', 'Run tests', 'Review'], 'newest event first');
  assert.equal(b.events[0].status, 'info', 'unknown status normalized');
  assert.equal(b.sessions.find(s => s.id === 'review-1').eventCount, 2);
  assert.deepEqual(b.findings.map(f => f.id), ['sec-1', 'perf-1', 'ui-1'], 'ranked by severity');
  assert.deepEqual(b.summary.byCategory.security, { high: 1, medium: 0, low: 0, open: 1, total: 1 });
  assert.equal((await board('?session=other')).events.length, 1, 'session filter');

  for (let i = 0; i < 3; i++) await post('/api/claude/findings/vote', { id: 'ui-1', delta: 1 }, 200);
  await post('/api/claude/findings/vote', { id: 'perf-1', delta: 2 }, 400);
  b = await board();
  assert.deepEqual(b.findings.map(f => f.id), ['sec-1', 'ui-1', 'perf-1'], 'three up-votes lift a low finding (5 + 18) above a medium one (15), not a high one (30)');

  await post('/api/claude/findings/decision', { id: 'sec-1', status: 'fixed' }, 200);
  await post('/api/claude/findings/decision', { id: 'perf-1', status: 'approved', note: 'do next' }, 200);
  await post('/api/claude/findings/decision', { id: 'perf-1', status: 'done' }, 400);
  await post('/api/claude/findings/decision', { id: 'missing', status: 'fixed' }, 404);
  const activity = (await (await fetch(`${base}/api/activity`)).json()).items.filter(x => x.type === 'claude');
  assert.deepEqual(activity.map(x => x.detail).slice(0, 2).sort(), ['Full rewrites', 'LAN to host execution'], 'the audit log names the finding, not its id');
  assert.ok(!activity.some(x => x.detail === 'missing'), 'a decision on a missing finding is not logged');
  b = await board();
  assert.equal(b.findings.at(-1).id, 'sec-1', 'fixed findings sink');
  assert.equal(b.summary.byStatus.fixed, 1);

  // Re-reporting a finding updates its text but keeps operator votes and decisions.
  await post('/api/claude/findings', { findings: [{ id: 'perf-1', title: 'Full rewrites (updated)' }] });
  const perf = (await board()).findings.find(f => f.id === 'perf-1');
  assert.equal(perf.title, 'Full rewrites (updated)');
  assert.equal(perf.status, 'approved');
  assert.equal(perf.severity, 'medium');

  const priorities = await (await fetch(`${base}/api/claude/priorities`)).json();
  assert.deepEqual(priorities.items.map(f => f.id), ['perf-1', 'ui-1'], 'open work in rank order, fixed excluded');
  assert.equal(priorities.items[0].decisionNote, 'do next');
});
