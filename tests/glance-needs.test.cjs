'use strict';

// Siri and the Watch ("What needs me?": GET /api/glance and Ask Local AI) say what Home's Needs you lists, by the same
// rule (app/public/needs-you.js): Home picks over /api/runs and adds the pending approvals; the server must agree.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawnAppServer } = require('./spawn-server.cjs');
const N = require('../app/public/needs-you');

test('glance and voice count and name what Home lists under Needs you, and follow it as runs are opened', { timeout: 30000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-glance-needs-'));
  const { Storage } = require('../app/storage');
  const { RunLedger } = require('../app/run-ledger');
  const storage = new Storage({ dataDir }), ledger = new RunLedger({ storage });
  // A few ms apart, so "newest first" and "answered by a later success" don't hang on two runs sharing a millisecond.
  const failed = async (title, o = {}) => { await new Promise(r => setTimeout(r, 5)); const r = ledger.create({ type: 'agent', title, ...o }); ledger.fail(r.id, 'Mission stopped'); return r.id; };
  // Two failures of one goal (one row on Home), one other failure, and one answered by a later success (not on Home).
  const a = await failed('Weekly report'), b = await failed('Weekly report'), c = await failed('Plan the garden');
  await failed('Sort the photos');
  await new Promise(r => setTimeout(r, 20)); // the success starts later than the failure it answers
  const ok = ledger.create({ type: 'agent', title: 'Sort the photos' }); ledger.complete(ok.id, { summary: 'done' });
  storage.close?.();
  const off = 'http://127.0.0.1:9';
  const { child, ready } = spawnAppServer({ env: { DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, OLLAMA_URL: off, COMFY_URL: off, N8N_URL: off, PROXY_URL: off, SEARXNG_URL: off, MAC_AI_HOME_URL: off, MAC_DSH_URL: off, GRIDCRAFT_URL: off } });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = await ready;
  const get = async url => (await fetch(base + url)).json();
  const post = (url, body) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  await post('/api/approvals/create', { title: 'Restart the media server', detail: 'x' });
  // A Claude finding waiting for a decision is not on Home's Needs you, so it is not spoken as needing you.
  await post('/api/claude/findings', { sessionId: 's', findings: [{ id: 'f1', title: 'Tidy the CSS', severity: 'low' }] });

  // Home's count: its rows (approval rows, then failures grouped by goal), as app/public/home.js builds them.
  const homeRows = async () => {
    const runs = (await get('/api/runs?limit=120')).items;
    const needs = N.pick(runs);
    const waiting = new Set(needs.filter(r => r.status === 'awaiting_approval').map(r => r.meta?.changeId).filter(Boolean));
    const approvals = (await get('/api/approvals')).items.filter(x => x.status === 'pending' && !(x.meta?.changeId && waiting.has(x.meta.changeId)));
    const failedRows = N.group(needs.filter(r => r.status === 'failed'));
    return { count: needs.filter(r => r.status !== 'failed').length + approvals.length + failedRows.length, failedTitles: failedRows.map(g => g.run.title) };
  };
  const glanceCount = async () => (await get('/api/glance')).needsYou.count;
  const spoken = async () => (await fetch(`${base}/api/glance/ask?q=${encodeURIComponent('what needs me')}`)).text();

  let home = await homeRows();
  assert.equal(home.count, 3, 'one approval, Weekly report (×2) and Plan the garden');
  assert.equal(await glanceCount(), home.count);
  const g = await get('/api/glance');
  assert.deepEqual(g.needsYou.items.map(i => [i.kind, i.count]), [['approvals', 1], ['failed', 2]]);
  assert.doesNotMatch(g.speech, /finding|change request/);
  // Voice also names core services that are down (Home's Fix rows); in this test only the appliance itself runs.
  const down = g.health.down.length;
  assert.ok(down > 0);
  const things = n => new RegExp(`^${n} things need you, including `);
  let said = await spoken();
  assert.match(said, things(home.count + down), said);
  assert.match(said, /including Restart the media server, the Plan the garden failed, and the Weekly report failed\./, 'approvals first, then failures newest first, one per goal');
  assert.doesNotMatch(said, /Sort the photos|Tidy the CSS/, 'not what Home leaves out');

  // Opened on a device (seen): gone from Home, from the glance and from what Siri says.
  assert.equal((await post('/api/runs/seen', { ids: [a, b] })).status, 200);
  home = await homeRows();
  assert.equal(home.count, 2);
  assert.equal(await glanceCount(), home.count);
  said = await spoken();
  assert.match(said, things(home.count + down), said);
  assert.match(said, /including Restart the media server, the Plan the garden failed, and .+ is down\./, said);
  assert.doesNotMatch(said, /Weekly report/);

  assert.equal((await post('/api/runs/seen', { ids: [c] })).status, 200);
  assert.equal((await homeRows()).count, 1);
  assert.equal(await glanceCount(), 1);
  said = await spoken();
  assert.match(said, things(1 + down), said);
  assert.doesNotMatch(said, /failed/);
});
