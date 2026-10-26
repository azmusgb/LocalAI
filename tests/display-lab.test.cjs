'use strict';

// The Workshop display's Judge it sheet (app/display-lab.js): GET /api/display/lab/judge and POST /api/display/lab/verdict.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { Readable } = require('node:stream');
const { Storage } = require('../app/storage');
const { createPrintLab } = require('../app/print-lab');
const { createDisplayLab } = require('../app/display-lab');
const { spawnAppServer } = require('./spawn-server.cjs');

const NOW = '2026-10-26T12:00:00.000Z';
const RUN = 'PR-021-01';
const CRITERIA = [
  { key: 'print', label: 'Printed cleanly?', choices: ['clean', 'flawed', 'failed'] },
  { key: 'apart', label: 'Twists apart by hand?', choices: ['yes', 'hard', 'no'] }
];
const VARIANTS = [{ id: 'E-021-A', tab: '21A' }, { id: 'E-021-B', tab: '21B' }];
const indexExp = (extra = {}) => ({ id: 'E-021', status: 'printing', question_text: 'Does a 0.2 mm seam gap hide the join?', judge_on: 'the seam on the top face', run: RUN, runs: [{ id: RUN, started_at: '2026-10-26T09:00:00Z' }], due_at: '2026-10-26T11:00:00Z', verdict: null, criteria: CRITERIA, variants: VARIANTS, ...extra });
const record = (extra = {}) => ({ id: 'E-021', judge_on: 'the seam on the top face', criteria: CRITERIA, variants: VARIANTS, print_runs: [{ id: RUN }], ...extra });
let gen = 0;
const index = (exp = indexExp(), rec = record()) => ({
  schema: 'print-lab-index/1', project: 'hex-tile', generated_at: new Date(Date.parse('2026-10-26T10:00:00Z') + (gen++) * 1000).toISOString(), fingerprint: `f${gen}`,
  experiments: [exp], records: { 'E-021': { type: 'experiment', file: 'experiments/E-021.json', sha256: crypto.createHash('sha256').update(JSON.stringify(rec)).digest('hex'), payload: rec } }
});
const GRADES = { '21A': { print: 'clean', apart: 'no' }, '21B': { print: 'failed', apart: null } };

function fakeRes() {
  return { headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, writeHead(s, h = {}) { this.status = s; Object.assign(this.headers, h); }, end(d) { this.body = d; } };
}
function fakeReq(method, url, body, extra = {}) {
  const raw = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const req = Readable.from(raw ? [raw] : []);
  return Object.assign(req, { method, url, headers: { host: 'localai.test', ...(raw ? { 'content-length': String(raw.length) } : {}) } }, extra);
}

function harness(t, { printer = { state: 'idle' } } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-display-lab-'));
  const storage = new Storage({ dataDir });
  t.after(() => { storage.close?.(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const json = (res, status, body) => { res.status = status; res.body = body; };
  const lab = createPrintLab({ storage, dataDir, json, macAuthorized: req => Boolean(req.mac), deviceFor: req => req.device || null, now: () => NOW, clock: () => Date.parse(NOW), printer: () => printer });
  const display = createDisplayLab({ labStore: lab, json, authorized: req => req.displayKey === true });
  const judge = async (run = RUN, { key = true } = {}) => { const res = fakeRes(); await display.judge(fakeReq('GET', `/api/display/lab/judge?run=${run}`, undefined, { displayKey: key }), res, new URL(`http://x/api/display/lab/judge?run=${run}`)); return res; };
  const verdict = async (body, { key = true } = {}) => { const res = fakeRes(); await display.verdict(fakeReq('POST', '/api/display/lab/verdict', body, { displayKey: key }), res); return res; };
  const phone = async body => { const res = fakeRes(); await lab.handle(fakeReq('POST', '/api/lab/hex-tile/requests', body, { device: { id: 'dev-phone-1' } }), res, '/api/lab/hex-tile/requests'); return res; };
  const pending = async () => { const res = fakeRes(); await lab.handle(fakeReq('GET', '/api/lab/hex-tile/requests?status=pending', undefined, { mac: true }), res, '/api/lab/hex-tile/requests'); return res.body.items; };
  const sync = ix => assert.equal(lab.sync('hex-tile', ix)[0], 200);
  return { lab, judge, verdict, phone, pending, sync };
}

test('display key required', async t => {
  const h = harness(t);
  h.sync(index());
  assert.equal((await h.judge(RUN, { key: false })).status, 401);
  const r = await h.verdict({ run: RUN, requestId: 'rq-0000000000000001', grades: GRADES, inconclusive: null }, { key: false });
  assert.equal(r.status, 401);
  assert.deepEqual(await h.pending(), []);
});

test('judge returns only the record\'s tabs and criteria', async t => {
  const h = harness(t);
  // The index's own copy says something else: the record is what counts.
  h.sync(index(indexExp({ criteria: [{ key: 'x', label: 'X', choices: ['a'] }], variants: [{ id: 'E-021-Z', tab: '21Z' }] }),
    record({ variants: [...VARIANTS, { id: 'E-021-R', tab: '21R', role: 'reference' }], criteria: [...CRITERIA, { key: 42, label: 'broken' }] })));
  const r = await h.judge();
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { experiment: 'E-021', run: RUN, judgeOn: 'the seam on the top face', tabs: ['21A', '21B'], criteria: CRITERIA, judged: null, pending: null });
});

test('no criteria → phoneOnly', async t => {
  const h = harness(t);
  h.sync(index(indexExp({ criteria: undefined }), record({ criteria: undefined })));
  const r = await h.judge();
  assert.equal(r.status, 200);
  assert.equal(r.body.phoneOnly, true);
  assert.match(r.body.reason, /Judge it on your phone/);
  const v = await h.verdict({ run: RUN, requestId: 'rq-0000000000000001', grades: {}, inconclusive: null });
  assert.equal(v.status, 409);
  assert.deepEqual(await h.pending(), []);
});

test('verdict queues the same body the phone does', async t => {
  const a = harness(t), b = harness(t);
  a.sync(index()); b.sync(index());
  const id = 'rq-00000000000000aa';
  const p = await a.phone({ id, kind: 'verdict', experiment: 'E-021', run: RUN, payload: { grades: GRADES, lighting: 'diagnostic', note: null, inconclusive: null, replace: false } });
  assert.equal(p.status, 200);
  const d = await b.verdict({ run: RUN, requestId: id, grades: GRADES, inconclusive: null, replace: false });
  assert.equal(d.status, 202);
  assert.deepEqual(d.body, { id, status: 'pending' });
  const [fromPhone] = await a.pending(), [fromDisplay] = await b.pending();
  assert.equal(fromPhone.by, 'dev-phone-1');
  assert.equal(fromDisplay.by, 'display');
  const { by: _p, ...phoneBody } = fromPhone, { by: _d, ...displayBody } = fromDisplay;
  assert.deepEqual(displayBody, phoneBody);

  // Now it shows as judged on the display, with the request's state.
  const j = await b.judge();
  assert.deepEqual(j.body.judged, { at: NOW, by: 'display' });
  assert.deepEqual(j.body.pending, { id, status: 'pending', message: null });
  assert.deepEqual((await a.judge()).body.judged, { at: NOW, by: 'phone' });
});

test('inconclusive and replace are passed on as the phone sends them', async t => {
  const h = harness(t);
  h.sync(index());
  const r = await h.verdict({ run: RUN, requestId: 'rq-00000000000000ab', grades: {}, inconclusive: 'bed adhesion failure', replace: true });
  assert.equal(r.status, 202);
  const [item] = await h.pending();
  assert.deepEqual(item.payload, { grades: {}, lighting: 'diagnostic', note: null, inconclusive: 'bed adhesion failure', replace: true });
  assert.equal((await h.verdict({ run: RUN, requestId: 'rq-00000000000000ac', grades: {}, inconclusive: 7 })).status, 400);
  assert.equal((await h.verdict({ run: RUN, requestId: 'rq-00000000000000ad', grades: {}, inconclusive: '  ' })).status, 400);
});

test('bad choice → 400, nothing queued', async t => {
  const h = harness(t);
  h.sync(index());
  for (const grades of [
    { ...GRADES, '21A': { print: 'shiny', apart: 'no' } },
    { ...GRADES, '21A': { print: 'clean', apart: 'no', colour: 'red' } },
    { ...GRADES, '21A': { print: '–', apart: 'no' } },
    { '21A': GRADES['21A'] }, // a strip left out
    { ...GRADES, '21A': { print: 'clean' } }, // a criterion left out
    'print:clean'
  ]) {
    const r = await h.verdict({ run: RUN, requestId: 'rq-0000000000000002', grades, inconclusive: null });
    assert.equal(r.status, 400, JSON.stringify(grades));
    assert.ok(r.body.error);
  }
  assert.deepEqual(await h.pending(), []);
});

test('unknown tab → 400', async t => {
  const h = harness(t);
  h.sync(index());
  const r = await h.verdict({ run: RUN, requestId: 'rq-0000000000000003', grades: { ...GRADES, '21Z': { print: 'clean', apart: 'no' } }, inconclusive: null });
  assert.equal(r.status, 400);
  const ref = await h.verdict({ run: RUN, requestId: 'rq-0000000000000003', grades: { ...GRADES, 'E-021-A': { print: 'clean', apart: 'no' } }, inconclusive: null });
  assert.equal(ref.status, 400);
  assert.deepEqual(await h.pending(), []);
});

test('verdict refused when the record moved', async t => {
  const h = harness(t);
  h.sync(index());
  const body = { run: 'PR-021-02', requestId: 'rq-0000000000000004', grades: GRADES, inconclusive: null };
  const r = await h.verdict(body);
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'This print has changed. Open it again.');
  assert.equal((await h.judge('PR-021-02')).status, 409);
  // A new run started: the old run's sheet is refused too.
  h.sync(index(indexExp({ run: 'PR-021-02', runs: [{ id: RUN }, { id: 'PR-021-02', started_at: '2026-10-26T11:30:00Z' }] })));
  assert.equal((await h.verdict({ ...body, run: RUN })).status, 409);
  // Nothing to judge (still printing).
  const busy = harness(t, { printer: { state: 'printing' } });
  busy.sync(index());
  assert.equal((await busy.verdict({ ...body, run: RUN })).status, 409);
  assert.deepEqual(await h.pending(), []);
});

test('same requestId twice → one request', async t => {
  const h = harness(t);
  h.sync(index());
  const body = { run: RUN, requestId: 'rq-0000000000000005', grades: GRADES, inconclusive: null };
  assert.equal((await h.verdict(body)).status, 202);
  const again = await h.verdict(body);
  assert.equal(again.status, 202);
  assert.deepEqual(again.body, { id: 'rq-0000000000000005', status: 'pending' });
  assert.equal((await h.pending()).length, 1);
});

test('20 pending → 429', async t => {
  const h = harness(t);
  h.sync(index());
  for (let i = 0; i < 20; i++) assert.equal((await h.phone({ id: `rq-${String(i).padStart(16, '0')}`, kind: 'verdict', experiment: 'E-021', run: RUN, payload: {} })).status, 200);
  const r = await h.verdict({ run: RUN, requestId: 'rq-00000000000000ff', grades: GRADES, inconclusive: null });
  assert.equal(r.status, 429);
  assert.equal((await h.pending()).length, 20);
});

test('the routes are wired to the display key', { timeout: 30000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-display-lab-srv-'));
  const key = 'wsd_' + 'c'.repeat(48);
  fs.writeFileSync(path.join(dataDir, 'workshop-display-key.sha256'), crypto.createHash('sha256').update(key).digest('hex'));
  const dead = 'http://127.0.0.1:9';
  const { child, ready } = spawnAppServer({ env: { DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, OLLAMA_URL: dead, SEARXNG_URL: dead, COMFY_URL: dead, N8N_URL: dead, PROXY_URL: dead, MAC_AI_HOME_URL: dead, MAC_DSH_URL: dead, LOCALAI_MATERIALS_URL: 'off', LOCALAI_PI_HUB_URL: 'off' } });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = await ready;
  // Through Caddy (X-Forwarded-For) so the host's own pass doesn't apply.
  const via = { 'X-Forwarded-For': '10.0.0.99' };
  assert.equal((await fetch(`${base}/api/display/lab/judge?run=${RUN}`, { headers: via })).status, 401);
  const post = headers => fetch(`${base}/api/display/lab/verdict`, { method: 'POST', headers: { ...via, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ run: RUN, requestId: 'rq-0000000000000006', grades: GRADES, inconclusive: null }) });
  assert.equal((await post({})).status, 401);
  // With the key: nothing is being judged on this empty appliance.
  assert.equal((await fetch(`${base}/api/display/lab/judge?run=${RUN}`, { headers: { ...via, 'X-LocalAI-Display-Key': key } })).status, 409);
  assert.equal((await post({ 'X-LocalAI-Display-Key': key })).status, 409);
});
