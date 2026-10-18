'use strict';

// GET /api/busy: what a restart would interrupt. The host's auto-deploy holds an update while it says busy.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { Storage } = require('../app/storage');
const { RunLedger } = require('../app/run-ledger');
const { activeWork, createInFlight, STALE_MS } = require('../app/busy');
const { spawnAppServer } = require('./spawn-server.cjs');

function ledger(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-busy-'));
  const storage = new Storage({ dataDir });
  t.after(() => { storage.close?.(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return new RunLedger({ storage });
}

test('idle: finished, failed, cancelled and approval-waiting runs are not busy', t => {
  const runs = ledger(t);
  runs.complete(runs.start(runs.create({ type: 'chat', title: 'Done chat' }).id).id, { summary: 'ok' });
  runs.fail(runs.create({ type: 'image', title: 'Broken image' }).id, 'no engine');
  runs.cancel(runs.create({ type: 'research', title: 'Stopped' }).id);
  runs.update(runs.create({ type: 'agent', title: 'Waiting for approval' }).id, { status: 'awaiting_approval' });
  const all = runs.list({ all: true });
  const out = activeWork({ runs: all, missions: [{ id: 'mission-1', status: 'complete', goal: 'Old' }], specialists: [{ status: 'error' }] });
  assert.deepEqual(out, { busy: false, active: [], since: null });
});

test('active: queued, running and streaming runs, a running mission and in-flight work are listed', t => {
  const runs = ledger(t);
  runs.create({ type: 'chat', title: 'Queued chat' });
  const image = runs.start(runs.create({ type: 'image', title: 'A lighthouse at dusk' }).id);
  runs.stream(runs.create({ type: 'research', title: 'Streaming research' }).id);
  // A mission is a ledger run and an orchestrator mission: it is listed once.
  const missionRun = runs.start(runs.create({ type: 'agent', title: 'Review the Work page', meta: { missionId: 'mission-a' } }).id);
  runs.complete(runs.create({ type: 'chat', title: 'Finished' }).id);
  const inFlight = createInFlight();
  const endGridcraft = inFlight.track('gridcraft', 'GridCraft: total the March column');
  inFlight.track('automation', 'Morning health check');
  const out = activeWork({
    runs: runs.list({ all: true }),
    missions: [
      { id: 'mission-a', status: 'running', goal: 'Review the Work page', createdAt: missionRun.createdAt },
      { id: 'mission-b', status: 'running', goal: 'A mission with no ledger run', createdAt: new Date().toISOString() }
    ],
    specialists: [{ status: 'running', agentName: 'Code Analyst', createdAt: new Date().toISOString() }],
    inFlight: inFlight.list()
  });
  assert.equal(out.busy, true);
  const titles = out.active.map(a => a.kind + ':' + a.title).sort();
  assert.deepEqual(titles, [
    'agent:Review the Work page', 'automation:Morning health check', 'chat:Queued chat', 'gridcraft:GridCraft: total the March column',
    'image:A lighthouse at dusk', 'mission:A mission with no ledger run', 'research:Streaming research', 'specialist:Code Analyst'
  ]);
  for (const a of out.active) assert.deepEqual(Object.keys(a).sort(), ['kind', 'startedAt', 'title']);
  assert.equal(out.since, out.active.map(a => a.startedAt).filter(Boolean).sort()[0]);
  assert.ok(out.since <= image.startedAt);
  endGridcraft();
  assert.deepEqual(inFlight.list().map(w => w.kind), ['automation']);
});

test('a record quiet for longer than the stale limit does not hold updates; titles are short', () => {
  const now = Date.parse('2026-10-17T12:00:00Z');
  const old = new Date(now - STALE_MS - 1000).toISOString(), recent = new Date(now - 60000).toISOString();
  const out = activeWork({
    now,
    runs: [
      { type: 'chat', title: 'Stuck', status: 'running', updatedAt: old, startedAt: old },
      { type: 'chat', title: 'x'.repeat(300), status: 'running', updatedAt: recent, startedAt: recent }
    ],
    missions: [{ id: 'm', status: 'running', goal: 'Stuck mission', updatedAt: old }]
  });
  assert.equal(out.active.length, 1);
  assert.ok(out.active[0].title.length <= 80);
  assert.equal(out.since, recent);
});

test('GET /api/busy answers idle, then lists a GridCraft request while it is in flight', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-busy-api-'));
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const bridge = http.createServer(async (req, res) => {
    req.resume();
    await held;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, answer: 'done', durationSec: 1 }));
  });
  bridge.listen(0, '127.0.0.1');
  await once(bridge, 'listening');
  const { child, ready } = spawnAppServer({ env: { DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, GRIDCRAFT_URL: `http://127.0.0.1:${bridge.address().port}`, OLLAMA_URL: 'http://127.0.0.1:9' } });
  t.after(() => { release(); child.kill(); bridge.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = await ready;

  const idle = await (await fetch(base + '/api/busy')).json();
  assert.deepEqual(idle, { busy: false, active: [], since: null });

  const request = fetch(base + '/api/gridcraft/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'Sum column B', mode: 'read' }) });
  let busy;
  for (let i = 0; i < 50; i++) {
    busy = await (await fetch(base + '/api/busy')).json();
    if (busy.busy) break;
    await new Promise(r => setTimeout(r, 50));
  }
  assert.equal(busy.busy, true);
  assert.deepEqual(busy.active.map(a => [a.kind, a.title]), [['gridcraft', 'GridCraft: Sum column B']]);
  assert.equal(busy.since, busy.active[0].startedAt);
  assert.doesNotMatch(JSON.stringify(busy), /127\.0\.0\.1|localai-busy|DATA_DIR/);

  release();
  assert.equal((await request).status, 200);
  const after = await (await fetch(base + '/api/busy')).json();
  assert.equal(after.busy, false);
});
