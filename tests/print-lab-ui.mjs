// Print lab on Local AI since platform step 6, PR 6.4: the tab sends the browser to Pi Hub's /lab. A throwaway server
// still gets a fixture through the real sync route (with the Mac key), since /api/lab/* stays until 6.7; then, on an
// iPhone and a desktop, each Print lab address lands on Pi Hub's /lab with its e, p and do, and Back returns to Local AI.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import http from 'node:http';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const { spawnAppServer } = createRequire(import.meta.url)('./spawn-server.cjs');
let failed = 0;
async function check(name, fn) { try { await fn(); console.log('PASS', name); } catch (e) { failed++; console.log('FAIL', name, e.message); } }

const KEY = 'print-lab-ui-key';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-lab-ui-'));
fs.writeFileSync(path.join(dataDir, 'claude-chat-mac-key.sha256'), crypto.createHash('sha256').update(KEY).digest('hex'));
const off = 'http://127.0.0.1:9';
// A 1 x 1 JPEG, sent the way `lab sync` sends photos.
const jpg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');
const sha = crypto.createHash('sha256').update(jpg).digest('hex');
// More distinct photos: the same picture with bytes after its end, so each has its own sha256.
const photoBytes = i => Buffer.concat([jpg, Buffer.alloc(i + 1, i + 1)]);
const shaOf = b => crypto.createHash('sha256').update(b).digest('hex');

// The stand-in Workshop display (printer status) and the Pi's camera bridge and hub, on loopback.
const cam = { on: false };
const stub = http.createServer((req, res) => {
  const send = (status, body, type = 'application/json') => { res.writeHead(status, { 'Content-Type': type }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
  if (req.url === '/hardware/health') return send(200, { board: 'x' });
  if (req.url === '/api/status/lite') return send(200, { schema: 1, printers: [{ slot: 0, connection: 'online', activity: 'printing', freshness: 'fresh', ageSeconds: 1, progressPercent: 42, remainingMinutes: 95, error: null }] });
  if (req.url === '/x2d/frame.jpg') return cam.on ? send(200, jpg, 'image/jpeg') : send(503, 'no frame', 'text/plain');
  if (req.url === '/api/camera') return send(200, { ok: false, reason: 'liveview_off' });
  send(404, {});
});
stub.listen(0, '127.0.0.1');
await once(stub, 'listening');
const stubUrl = `http://127.0.0.1:${stub.address().port}`;
const { child, ready } = spawnAppServer({ env: { DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, OLLAMA_URL: off, SEARXNG_URL: off, COMFY_URL: off, N8N_URL: off, PROXY_URL: off, GRIDCRAFT_URL: off, MAC_AI_HOME_URL: off, MAC_DSH_URL: off, LOCALAI_WORKSHOP_URL: stubUrl, LOCALAI_WORKSHOP_STATUS_TOKEN: 'status-token', LOCALAI_LAB_CAMERA_URL: `${stubUrl}/x2d/frame.jpg`, LOCALAI_PI_HUB_URL: stubUrl, LOCALAI_BAMBUDDY_URL: off, LOCALAI_MATERIALS_URL: 'off' } });
const base = await ready;
const exp = (id, status, extra = {}) => ({ id, question: 'Q-002', status, provenance: 'prospective', question_text: `${id}: does the top edge print clean?`, hypothesis: 'The ripple is gone.', prediction: 'No ripple from 60 cm.', why_this_test: 'Only this shows the upper edge.', test_kind: 'height_strip', judge_on: 'top edge', factor: { name: 'inner_wall_speed', unit: 'mm/s', values: [250, 80] }, variants: [{ id: `${id}-A`, tab: '5A', requested: 250, realized: 147, as_asked: false, unit: 'mm/s' }, { id: `${id}-B`, tab: '5B', requested: 80, realized: 80, as_asked: true, unit: 'mm/s' }], reference_variants: [], estimate: { minutes: 99.4, g: 29.1 }, layer_time_median_s: 13.7, usage: null, check: null, outcome: null, validity: null, verdict: null, approval: null, abandoned_reason: null, filament: null, runs: [], photos: [], ai_observations: [], needs: null, ...extra });
const e8 = Array.from({ length: 8 }, (_, i) => photoBytes(i)), e7 = photoBytes(20);
const index = {
  schema: 'print-lab-index/1', project: 'hex-tile', generated_at: new Date().toISOString(), fingerprint: 'f'.repeat(64),
  questions: [{ id: 'Q-002', question: 'Is v58 good enough on a full tile?', status: 'active', budget: { minutes: 480, g: 300, test_minutes: 45, test_g: 25 }, spent: { minutes: 99.4, g: 29.1 }, next: { id: 'E-006', minutes: 248.7, g: 76.4 }, stop: { kind: null, text: 'continue' }, streak: 0, evidence: { informative: 1, uninformative: 0 }, experiments: ['E-004', 'E-006', 'E-008'], plans: [{ after: 'E-008', if: 'the top edge is clean', next: 'a full tile on terracotta' }], answered: 1 }],
  experiments: [
    exp('E-008', 'printing', {
      reserved: { minutes: 99.4, g: 29.1 },
      criteria: [
        { key: 'print', label: 'Printed cleanly?', choices: ['clean', 'flawed', 'failed'] },
        { key: 'apart', label: 'Twists apart by hand?', choices: ['yes', 'hard', 'no'] }
      ],
      run: 'PR-008-01',
      variants: [
        { id: 'E-008-A', tab: '12A', requested: 250, realized: 147, as_asked: false, unit: 'mm/s' },
        { id: 'E-008-B', tab: '12B', requested: 80, realized: 80, as_asked: true, unit: 'mm/s' }
      ],
      runs: [{ id: 'PR-008-01', started_at: '2026-10-25T20:00:00Z' }],
      judge_on: 'top edge: no ripples; the pair snaps apart by hand',
      photos: e8.map((b, i) => ({ run: 'PR-008-01', path: `photos/PR-008-01-${i + 1}.jpg`, sha256: shaOf(b) })),
      needs: { id: 'E-008', urgency: 0, action: 'Judge the print', why: 'Look at: top edge.', command: 'uv run lab exp verdict E-008 --rank A --note "what you see"' }
    }),
    exp('E-009', 'approved', { needs: { id: 'E-009', urgency: 1, action: 'Send it to the printer', why: 'Approved; then record that it started.', command: 'uv run lab exp start E-009' } }),
    exp('E-007', 'answered', { test_kind: 'full_part', filament: 'Kexcelled Light Matte Terracotta PLA', reference_variants: ['E-004-A'], usage: { minutes: 263.1, g: 86.2, minutes_source: 'observed', g_source: 'estimate' }, run: 'PR-007-01', runs: [{ id: 'PR-007-01', started_at: '2026-10-24T10:00:00Z' }], verdict: { kind: 'acceptance', good_enough: true, defects: ['separation very hard'], note: 'faces good', at: new Date(Date.now() - 3600e3).toISOString() }, photos: [{ run: 'PR-007-01', path: 'photos/PR-007-01-1.jpg', sha256: shaOf(e7) }] }),
    exp('E-006', 'needs_approval', { check: { status: 'needs_approval', guards: [{ code: 'per_test_time', ok: false, result: 'needs_approval', message: '248.7 / 45 min per test' }] }, needs: { id: 'E-006', urgency: 2, action: 'Approve or drop', why: '248.7 / 45 min per test', command: 'uv run lab exp approve E-006 --reason "..."' } }),
    exp('E-004', 'answered', { variants: [{ id: 'E-004-A', tab: '40', requested: 40, realized: 40, as_asked: true, unit: 'mm/s', grade: 'clean' }, { id: 'E-004-B', tab: '80', requested: 80, realized: 80, as_asked: true, unit: 'mm/s', grade: 'faint' }], finding: 'clean up to 40, faint at 80', ai_observations: [{ confidence: 0.834, confirmed: false, assessment: 'Faint banding on the 80 strip.' }], run: 'PR-004-01', runs: [{ id: 'PR-004-01', started_at: '2026-10-23T10:00:00Z' }], outcome: 'refuted', validity: { status: 'valid', reasons: [{ code: 'cross_plate_by_design', status: 'valid' }] }, verdict: { kind: 'ranking', note: 'they look good', at: '2026-09-24T23:14:18Z' }, photos: [{ run: 'PR-004-01', path: 'photos/PR-004-1.jpg', sha256: sha }] })
  ],
  needs: [], problems: [], colours: { terracotta: '#c0623a', 'light matte terracotta': '#d08a6a' }, records: {
    'E-004': { type: 'experiment', file: 'experiments/E-004.json', sha256: 'a'.repeat(64), payload: { id: 'E-004' } },
    'E-006': { type: 'experiment', file: 'experiments/E-006.json', sha256: 'b'.repeat(64), payload: { id: 'E-006', builds: [{ id: 'BLD-006-01', ok: true, check: { status: 'needs_approval', guards: [{ code: 'owner_stopped', ok: true, result: 'blocked', message: 'question active' }, { code: 'per_test_time', ok: false, result: 'needs_approval', message: '248.7 / 45 min per test' }] } }] } },
    'E-007': { type: 'experiment', file: 'experiments/E-007.json', sha256: 'c'.repeat(64), payload: { id: 'E-007', print_runs: [{ id: 'PR-007-01', photos: [{ sha256: shaOf(e7), tab: '12A' }] }] } },
    'E-008': { type: 'experiment', file: 'experiments/E-008.json', sha256: 'd'.repeat(64), payload: { id: 'E-008', print_runs: [{ id: 'PR-008-01', photos: e8.map((b, i) => ({ sha256: shaOf(b), tab: i % 2 ? '12B' : '12A' })) }] } }
  }
};
index.needs = index.experiments.filter(x => x.needs).map(x => x.needs);
for (const b of [jpg, e7, ...e8]) {
  const put = await fetch(`${base}/api/lab/hex-tile/photos/${shaOf(b)}.jpg`, { method: 'PUT', headers: { 'X-LocalAI-Mac-Key': KEY, 'Content-Type': 'image/jpeg' }, body: b });
  assert.equal(put.status, 200);
}
assert.equal((await fetch(`${base}/api/lab/hex-tile/sync`, { method: 'POST', headers: { 'X-LocalAI-Mac-Key': KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(index) })).status, 200);

const browser = await chromium.launch();
const errors = [];

// Pair a device for phone tests
const pairRes = await fetch(`${base}/api/claude/chat/pair-request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
const { id: pairId, code } = await pairRes.json();
await fetch(`${base}/api/claude/chat/pair/approve`, {
  method: 'POST',
  headers: { 'X-LocalAI-Mac-Key': KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({ code, name: 'Test Device' })
});
const statusRes = await fetch(`${base}/api/claude/chat/pair-status?id=${pairId}`);
const rawCookie = statusRes.headers.get('set-cookie') || '';
const [nameVal] = rawCookie.split(';');
const eqIdx = nameVal.indexOf('=');
const cookieName = nameVal.slice(0, eqIdx).trim();
const cookieVal = nameVal.slice(eqIdx + 1).trim();

// Platform step 6, PR 6.4: Local AI's Print lab tab sends the browser to Pi Hub's /lab, keeping e, p and do (the plan's
// acceptance: "#/printLab?e=E-025 lands on Pi Hub's URL with e"). Opened on 127.0.0.1, Local AI's address for the hub is
// the old one, http://10.0.0.30; the test answers it itself, so nothing leaves this machine.
const HUB_LAB = /^http:\/\/10\.0\.0\.30\/lab(\?|$)/;
async function urlBecomes(page, ok, ms = 10000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 100))) if (ok(page.url())) return;
  throw new Error(`still at ${page.url()}`);
}
for (const [name, viewport] of [['iPhone', { width: 390, height: 844 }], ['desktop', { width: 1440, height: 900 }]]) {
  const context = await browser.newContext({ viewport, colorScheme: 'dark' });
  await context.addCookies([{ name: cookieName, value: cookieVal, url: base }]);
  const hubHits = [];
  await context.route(u => u.hostname === '10.0.0.30' || u.hostname.endsWith('.rahe-home.duckdns.org'), r => {
    hubHits.push(r.request().url());
    return r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Pi Hub lab</title>' });
  });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(`${name}: ${e.message}`));

  for (const [hash, want] of [
    ['#printLab', 'http://10.0.0.30/lab'],
    ['#/printLab?e=E-025', 'http://10.0.0.30/lab?e=E-025'],
    ['#printLab?p=hex-tile&e=E-023&do=judge', 'http://10.0.0.30/lab?p=hex-tile&e=E-023&do=judge'],
  ]) {
    await check(`${name}: ${hash} lands on Pi Hub's ${want.slice(17)}`, async () => {
      await page.goto(`${base}/${hash}`);
      await page.waitForURL(HUB_LAB, { timeout: 10000 });
      assert.equal(page.url(), want);
      assert.equal(await page.title(), 'Pi Hub lab', 'the stand-in hub answered, not a real one');
    });
  }

  await check(`${name}: going back doesn't bounce off the lab again`, async () => {
    await page.goto(`${base}/#home`);
    await page.waitForFunction(() => typeof window.showView === 'function');
    await page.evaluate(() => { location.hash = '#printLab'; });
    // From inside the app the redirect follows a same-document hash change, which Playwright's navigation waits report
    // as aborted; the address bar is what counts, so poll it.
    await urlBecomes(page, u => HUB_LAB.test(u));
    await page.goBack().catch(() => {});
    await urlBecomes(page, u => new URL(u).origin === new URL(base).origin);
    await page.waitForFunction(() => typeof window.showView === 'function');
    assert.notEqual(new URL(page.url()).hash, '#printLab', 'the replaced entry is gone, so Back is Local AI');
  });

  assert.ok(hubHits.every(u => HUB_LAB.test(u)), `only Pi Hub's /lab was asked for: ${hubHits.join(', ')}`);
  await page.close();
  await context.close();
}

await check('no script errors', async () => assert.deepEqual(errors, []));

await browser.close();
stub.close();
const done = once(child, 'exit'); child.kill('SIGTERM'); await done;
fs.rmSync(dataDir, { recursive: true, force: true });
if (failed) { console.log(`${failed} check(s) failed`); process.exit(1); }
console.log('print-lab-ui: all checks passed');
