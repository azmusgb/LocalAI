// Projects › Print lab: the Mac's lab page, read-only. A throwaway server gets a fixture through the real sync route
// (with the Mac key), then the page is checked on an iPhone and a desktop: Needs you first with each command and Copy,
// the question's budget, a link that opens an experiment's details, Earlier folded, photos from the server, and axe.
// The page's buttons (Judge it, It's printing now, Approve, Drop) queue requests the test answers as the Mac would; a
// stand-in Workshop display and camera bridge on loopback give the live print block its state and its no-picture
// reason; thumbnails, the viewer, Compare and the checklist are checked on both sizes.
// SHOTS=<dir> saves screenshots there.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { addAxe } from './axe-helper.mjs';

const { spawnAppServer } = createRequire(import.meta.url)('./spawn-server.cjs');
const axePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'vendor', 'axe.min.js');
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];
const shots = process.env.SHOTS || '';
let failed = 0;
async function check(name, fn) { try { await fn(); console.log('PASS', name); } catch (e) { failed++; console.log('FAIL', name, e.message); } }
const shot = async (page, name) => { if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, name), fullPage: true }); } };

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
  questions: [{ id: 'Q-002', question: 'Is v58 good enough on a full tile?', status: 'active', budget: { minutes: 480, g: 300, test_minutes: 45, test_g: 25 }, spent: { minutes: 99.4, g: 29.1 }, next: { id: 'E-006', minutes: 248.7, g: 76.4 }, stop: { kind: null, text: 'continue' }, streak: 0, evidence: { informative: 1, uninformative: 0 }, experiments: ['E-004', 'E-006', 'E-008'], plans: [], answered: 1 }],
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
    exp('E-007', 'answered', { test_kind: 'full_part', usage: { minutes: 263.1, g: 86.2, minutes_source: 'observed', g_source: 'estimate' }, run: 'PR-007-01', runs: [{ id: 'PR-007-01', started_at: '2026-10-24T10:00:00Z' }], verdict: { kind: 'acceptance', good_enough: true, defects: ['separation very hard'], note: 'faces good', at: new Date(Date.now() - 3600e3).toISOString() }, photos: [{ run: 'PR-007-01', path: 'photos/PR-007-01-1.jpg', sha256: shaOf(e7) }] }),
    exp('E-006', 'needs_approval', { check: { status: 'needs_approval', guards: [{ code: 'per_test_time', ok: false, result: 'needs_approval', message: '248.7 / 45 min per test' }] }, needs: { id: 'E-006', urgency: 2, action: 'Approve or drop', why: '248.7 / 45 min per test', command: 'uv run lab exp approve E-006 --reason "..."' } }),
    exp('E-004', 'answered', { run: 'PR-004-01', runs: [{ id: 'PR-004-01', started_at: '2026-10-23T10:00:00Z' }], outcome: 'refuted', validity: { status: 'valid', reasons: [{ code: 'cross_plate_by_design', status: 'valid' }] }, verdict: { kind: 'ranking', note: 'they look good', at: '2026-09-24T23:14:18Z' }, photos: [{ run: 'PR-004-01', path: 'photos/PR-004-1.jpg', sha256: sha }] })
  ],
  needs: [], problems: [], records: {
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
// The Mac's side of a request: the newest pending one of a kind, answered.
const pending = async kind => {
  const { items } = await (await fetch(`${base}/api/lab/hex-tile/requests?status=pending`, { headers: { 'X-LocalAI-Mac-Key': KEY } })).json();
  return items.filter(i => i.kind === kind).pop();
};
const answer = (id, status, message) => fetch(`${base}/api/lab/hex-tile/requests/${id}/result`, { method: 'POST', headers: { 'X-LocalAI-Mac-Key': KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ status, message }) });
const sync = await fetch(`${base}/api/lab/hex-tile/sync`, { method: 'POST', headers: { 'X-LocalAI-Mac-Key': KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(index) });
assert.equal(sync.status, 200);

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

for (const [name, viewport] of [['iPhone', { width: 390, height: 844 }], ['desktop', { width: 1440, height: 900 }]]) {
  const context = await browser.newContext({ viewport, colorScheme: 'dark' });
  await context.addCookies([{ name: cookieName, value: cookieVal, url: base }]);
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(`${name}: ${e.message}`));
  await page.goto(`${base}/#printLab`);
  await page.waitForSelector('#printLab.active .lab-needs-card');

  await check(`${name}: Needs you comes first, most urgent first, each with its command and Copy`, async () => {
    const rows = await page.locator('.lab-needs .list-row__title').allInnerTexts();
    assert.deepEqual(rows, ['Judge the print · E-008', 'Send it to the printer · E-009', 'Approve or drop · E-006']);
    assert.equal(await page.locator('.lab-needs code').first().textContent(), 'uv run lab exp verdict E-008 --rank A --note "what you see"');
    assert.equal(await page.locator('.lab-needs .lab-copy').count(), 3);
    assert.equal(await page.locator('#printLab h1').innerText(), 'Projects');
  });
  await check(`${name}: a print still running says when it's due instead of asking for a verdict, until the printer says it's done`, async () => {
    // E-008's need with an estimated end 90 min away (lab sync sends due_at while a print runs).
    const due = new Date(Date.now() + 90 * 60e3).toISOString();
    const tweak = state => async route => { const r = await route.fetch(); const d = await r.json();
      d.index.needs = d.index.needs.map(n => (n.id === 'E-008' ? { ...n, due_at: due } : n)); d.live = { ...d.live, state };
      await route.fulfill({ response: r, json: d }); };
    const row = () => page.locator('.lab-needs .list-row').filter({ has: page.locator('[data-lab-open="E-008"]') });
    await page.route('**/api/lab/hex-tile', tweak('printing'));
    await page.reload();
    await page.waitForSelector('#printLab.active .lab-needs-card');
    assert.equal(await row().locator('.list-row__title').innerText(), 'Printing · E-008');
    assert.match(await row().innerText(), /Done about \d\d:\d\d \(estimate\)\. Then look at: top edge: no ripples; the pair snaps apart by hand\./);
    assert.equal(await row().locator('code').count(), 0);
    assert.equal(await row().locator('.lab-acts button').count(), 0);
    await page.unroute('**/api/lab/hex-tile');
    await page.route('**/api/lab/hex-tile', tweak('idle'));
    await page.reload();
    await page.waitForSelector('#printLab.active .lab-needs-card');
    assert.equal(await row().locator('.list-row__title').innerText(), 'Judge the print · E-008');
    assert.deepEqual(await row().locator('.lab-acts button').allInnerTexts(), ['Judge it', 'Add photos']);
    await page.unroute('**/api/lab/hex-tile');
    await page.reload();
    await page.waitForSelector('#printLab.active .lab-needs-card');
  });
  await check(`${name}: a result from the last few days stays out of Earlier, with Accepted and its defects`, async () => {
    assert.equal(await page.locator('.lab-earlier #lab-E-007').count(), 0);
    const card = await page.locator('#lab-E-007').innerText();
    const cost = await page.locator('#lab-E-007').textContent();
    assert.match(cost, /used 263\.1 min, 86\.2 g \(estimated\)/);  // grams fell back to the slicer estimate
    assert.match(await page.locator('#lab-E-008').textContent(), /reserved 99\.4 min, 29\.1 g while it prints/);
    assert.match(card, /Accepted/);
    assert.match(card, /Defects: separation very hard/);
  });
  await check(`${name}: the question shows its budget, what the next test adds and that it continues`, async () => {
    const q = await page.locator('.lab-question').innerText();
    assert.match(q, /99\.4 \/ 480 min/);
    assert.match(q, /E-006 would add 248\.7 min, 76\.4 g/);
    assert.match(q, /Continue/);
  });
  await check(`${name}: cards show requested vs printed, and finished work is folded under Earlier`, async () => {
    assert.match(await page.locator('#lab-E-008').innerText(), /12A: 250 asked, 147 printed mm\/s/);
    assert.equal(await page.locator('.lab-earlier').getAttribute('open'), null);
    assert.equal(await page.locator('.lab-earlier #lab-E-004').count(), 1);
  });
  await check(`${name}: each Needs you item has its button; the command waits under Run it on the Mac instead`, async () => {
    const row = id => page.locator('.lab-needs .list-row').filter({ has: page.locator(`[data-lab-open="${id}"]`) });
    assert.deepEqual(await row('E-008').locator('.lab-acts button').allInnerTexts(), ['Judge it', 'Add photos']);
    assert.deepEqual(await row('E-009').locator('.lab-acts button').allInnerTexts(), ["It's printing now"]);
    assert.match(await row('E-009').innerText(), /only once it's actually printing/i);
    assert.deepEqual(await row('E-006').locator('.lab-acts button').allInnerTexts(), ['Approve', 'Drop']);
    const mac = row('E-006').locator('details.lab-mac');
    assert.equal(await mac.getAttribute('open'), null);
    assert.equal(await mac.locator('summary').innerText(), 'Run it on the Mac instead');
    assert.equal(await mac.locator('code').isVisible(), false);
  });
  await check(`${name}: printing card shows Add photos and Judge it, and the checklist above them`, async () => {
    const card = page.locator('#lab-E-008');
    assert.equal(await card.locator('.lab-add-photos').count(), 1);
    assert.equal(await card.locator('.lab-record-verdict').innerText(), 'Judge it');
    await card.locator('.lab-checklist input').first().waitFor();
    const list = await card.locator('.lab-checklist').innerText();
    assert.match(list, /top edge: no ripples[\s\S]*the pair snaps apart by hand[\s\S]*Raking light from one side[\s\S]*Same distance[\s\S]*Tab in frame/);
  });
  await check(`${name}: checklist ticks stay on this device after a reload`, async () => {
    const box = page.locator('#lab-E-008 .lab-checklist input').nth(2);
    if (!(await box.isChecked())) await box.check();
    await page.reload();
    await page.waitForSelector('#lab-E-008 .lab-checklist input');
    assert.equal(await page.locator('#lab-E-008 .lab-checklist input').nth(2).isChecked(), true);
    assert.equal(await page.locator('#lab-E-008 .lab-checklist input').nth(0).isChecked(), false);
  });
  await check(`${name}: It's printing now sends start with the tap time, shows Waiting for the Mac, then the Mac's refusal as plain text`, async () => {
    const before = Date.now();
    await page.locator('.lab-start[data-exp="E-009"]').click();
    const status = page.locator('[data-act-status="E-009"]');
    await page.waitForFunction(() => /Waiting for the Mac/.test(document.querySelector('[data-act-status="E-009"]')?.textContent || ''));
    const r = await pending('start');
    assert.equal(r.experiment, 'E-009');
    assert.equal(r.run, null);
    assert.equal(r.run_seen, null);
    const tapped = Date.parse(r.payload.tapped_at);
    assert.ok(tapped >= before - 1000 && tapped <= Date.now() + 1000, r.payload.tapped_at);
    await answer(r.id, 'refused', '<img src=x onerror="window.__labx=1">E-009 changed since the page was loaded; reload and try again.');
    await page.waitForFunction(() => /changed since/.test(document.querySelector('[data-act-status="E-009"]')?.textContent || ''));
    assert.equal(await status.locator('img').count(), 0);
    assert.equal(await page.evaluate(() => window.__labx), undefined);
  });
  await check(`${name}: Approve lists what is being approved, needs a reason, and sends the build and guards the page showed`, async () => {
    await page.locator('.lab-approve[data-exp="E-006"]').click();
    await page.waitForSelector('#labApproveSheet[open]');
    await page.waitForFunction(() => document.querySelectorAll('#labApproveGuards li').length === 1);
    assert.match(await page.locator('#labApproveGuards').innerText(), /248\.7 \/ 45 min per test/);
    const send = page.locator('#labApproveSend');
    assert.equal(await send.innerText(), 'Approve');
    assert.equal(await send.isDisabled(), true);
    await page.locator('#labApproveReason').fill('worth the time for a clean answer');
    assert.equal(await send.isDisabled(), false);
    await send.click();
    await page.waitForFunction(() => /Waiting for the Mac/.test(document.getElementById('labApproveStatus')?.textContent || ''));
    const r = await pending('approve');
    assert.deepEqual(r.payload, { reason: 'worth the time for a clean answer', build_seen: 'BLD-006-01', reasons_seen: ['per_test_time'] });
    await answer(r.id, 'applied', 'Approved BLD-006-01 for: per_test_time.');
    await page.waitForFunction(() => /Done/.test(document.getElementById('labApproveStatus')?.textContent || ''));
    await page.locator('#labApproveCancel').click();
  });
  await check(`${name}: Drop needs a reason and a second tap before it sends`, async () => {
    await page.locator('.lab-drop[data-exp="E-006"]').click();
    await page.waitForSelector('#labDropSheet[open]');
    const send = page.locator('#labDropSend');
    assert.equal(await send.isDisabled(), true);
    await page.locator('#labDropReason').fill('the strip came loose');
    await send.click();
    assert.equal(await page.locator('#labDropConfirm').isVisible(), true);
    assert.equal(await send.innerText(), 'Yes, drop E-006');
    assert.equal(await pending('abandon'), undefined, 'nothing sent before the confirm');
    await send.click();
    await page.waitForFunction(() => /Waiting for the Mac/.test(document.getElementById('labDropStatus')?.textContent || ''));
    const r = await pending('abandon');
    assert.deepEqual(r.payload, { reason: 'the strip came loose' });
    await answer(r.id, 'applied', 'E-006 abandoned.');
    await page.waitForFunction(() => /Done/.test(document.getElementById('labDropStatus')?.textContent || ''));
    await page.locator('#labDropCancel').click();
  });
  await check(`${name}: the printing item shows the live print and the camera's no-picture reason`, async () => {
    const live = page.locator('#lab-E-008 .lab-live');
    await live.waitFor();
    const text = await live.innerText();
    assert.match(text, /Printing/);
    assert.match(text, /42%/);
    assert.match(text, /1 h 35 min left/);
    assert.match(text, /done about/);
    assert.equal(await live.locator('[role="progressbar"]').getAttribute('aria-valuenow'), '42');
    await page.waitForFunction(() => /LAN Only Liveview is off/.test(document.querySelector('#lab-E-008 .lab-cam__why')?.textContent || ''));
    assert.equal(await live.locator('.lab-cam__img').isVisible(), false);
  });
  await check(`${name}: with a picture from the bridge, the snapshot shows`, async () => {
    cam.on = true;
    try {
      await page.goto(`${base}/#printLab`, { waitUntil: 'load' });
      await page.waitForFunction(() => { const i = document.querySelector('#lab-E-008 .lab-cam__img'); return i && !i.hidden && i.complete && i.naturalWidth === 1; });
    } finally { cam.on = false; }
  });
  await check(`${name}: thumbnails (6 and +2), the viewer with arrows, and Compare against the last good-enough run`, async () => {
    const thumbs = page.locator('#lab-E-008 .lab-thumbs .lab-thumb');
    await thumbs.first().waitFor();
    assert.equal(await page.locator('#lab-E-008 .lab-thumbs img').count(), 6);
    assert.equal(await page.locator('#lab-E-008 .lab-thumb--more').innerText(), '+2');
    await thumbs.first().click();
    await page.waitForSelector('#labViewer[open]');
    assert.match(await page.locator('#labViewer .lab-viewer__cap').innerText(), /12A · PR-008-01 · 1 of 8/);
    await page.keyboard.press('ArrowRight');
    assert.match(await page.locator('#labViewer .lab-viewer__cap').innerText(), /2 of 8/);
    await page.locator('#labViewer .lab-viewer__img').dblclick();
    assert.match(await page.locator('#labViewer .lab-viewer__img').evaluate(i => i.style.transform), /scale\(2/);
    await page.keyboard.press('Escape');
    await page.waitForSelector('#labViewer:not([open])', { state: 'attached' });
    await page.locator('#lab-E-008 .lab-compare-open').click();
    await page.waitForSelector('#labCompare[open]');
    const sides = page.locator('#labCompare select');
    assert.equal(await sides.nth(0).inputValue(), 'PR-008-01');
    assert.equal(await sides.nth(1).inputValue(), 'PR-007-01');
    const pair = page.locator('#labCompare .lab-compare__pair').filter({ hasText: '12A' }).first();
    assert.equal(await pair.locator('img').count(), 2);
    await sides.nth(1).selectOption('PR-004-01');
    assert.equal(await page.locator('#labCompare .lab-compare__pair').filter({ hasText: '12A' }).first().locator('img').count(), 1);
    await page.locator('#labCompareClose').click();
  });
  await check(`${name}: a finished print makes Judge it the main button; two printing runs show a plain conflict`, async () => {
    const tweak = live => async route => { const r = await route.fetch(); const d = await r.json(); d.live = typeof live === 'function' ? live(d.live) : live; await route.fulfill({ response: r, json: d }); };
    await page.route('**/api/lab/hex-tile', tweak(l => ({ ...l, state: 'idle', progress: null, minutesLeft: null, finishAt: null })));
    await page.reload();
    await page.waitForSelector('#lab-E-008 .lab-live');
    assert.match(await page.locator('#lab-E-008 .lab-live').innerText(), /Finished/);
    assert.match(await page.locator('#lab-E-008 .lab-record-verdict').getAttribute('class'), /btn-primary/);
    await page.unroute('**/api/lab/hex-tile');
    await page.route('**/api/lab/hex-tile', tweak({ conflict: true }));
    await page.reload();
    await page.waitForSelector('#printLab.active .lab-needs-card');
    assert.match(await page.locator('.lab-conflict').innerText(), /Two runs say they're printing; check the Mac/);
    assert.equal(await page.locator('.lab-live').count(), 0);
    await page.unroute('**/api/lab/hex-tile');
    await page.reload();
    await page.waitForSelector('#lab-E-008 .lab-live');
  });
  await check(`${name}: verdict sheet has rows and chips; Send stays disabled until complete`, async () => {
    await page.locator('#lab-E-008 .lab-record-verdict').click();
    await page.waitForSelector('#labVerdictSheet[open]');
    await page.locator('#labVerdictLighting').selectOption('diagnostic');  // the light is never assumed
    const send = page.locator('#labVerdictSend');
    assert.equal(await send.isDisabled(), true);

    // Pick for 12A only
    await page.locator('.lab-verdict-row[data-tab="12A"] button[data-choice="clean"]').click();
    await page.locator('.lab-verdict-row[data-tab="12A"] button[data-choice="no"]').click();
    assert.equal(await send.isDisabled(), true);

    // Complete 12B
    await page.locator('.lab-verdict-row[data-tab="12B"] button[data-choice="clean"]').click();
    await page.locator('.lab-verdict-row[data-tab="12B"] button[data-choice="yes"]').click();
    assert.equal(await send.isDisabled(), false);

    // Close sheet
    await page.locator('#labVerdictCancel').click();
  });
  await check(`${name}: an unsent draft survives a reload`, async () => {
    await page.reload();
    await page.waitForSelector('#printLab.active .lab-needs-card');
    await page.locator('#lab-E-008 .lab-record-verdict').click();
    await page.waitForSelector('#labVerdictSheet[open]');
    await page.locator('#labVerdictLighting').selectOption('diagnostic');  // the light is never assumed
    assert.equal(await page.locator('.lab-verdict-row[data-tab="12A"] button[data-choice="clean"]').getAttribute('aria-checked'), 'true');
    assert.equal(await page.locator('#labVerdictSend').isDisabled(), false);
    await page.locator('#labVerdictCancel').click();
  });
  await check(`${name}: sending verdict shows Waiting for the Mac, then Recorded when applied; – means not judged`, async () => {
    await page.locator('#lab-E-008 .lab-record-verdict').click();
    await page.waitForSelector('#labVerdictSheet[open]');
    await page.locator('#labVerdictLighting').selectOption('diagnostic');  // the light is never assumed
    await page.locator('.lab-verdict-row[data-tab="12B"] button[data-criterion="apart"][data-choice="–"]').click();
    assert.equal(await page.locator('#labVerdictSend').isDisabled(), false);
    await page.locator('#labVerdictSend').click();
    const status = page.locator('#labVerdictStatus');
    await status.waitFor();
    assert.match(await status.innerText(), /Waiting for the Mac/);

    // Mac fetches pending and applies it
    const listRes = await fetch(`${base}/api/lab/hex-tile/requests?status=pending`, { headers: { 'X-LocalAI-Mac-Key': KEY } });
    const { items } = await listRes.json();
    const vReq = items.find(i => i.kind === 'verdict');
    assert.ok(vReq);
    assert.deepEqual(vReq.payload.grades['12B'], { print: 'clean', apart: null });
    await fetch(`${base}/api/lab/hex-tile/requests/${vReq.id}/result`, {
      method: 'POST',
      headers: { 'X-LocalAI-Mac-Key': KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'applied', message: 'E-008 answered' })
    });

    // Sheet notices applied on next poll
    await page.waitForFunction(() => /Recorded/.test(document.getElementById('labVerdictStatus')?.textContent || ''));
    await page.locator('#labVerdictCancel').click();
  });
  await check(`${name}: refusal containing already has a verdict offers Replace verdict`, async () => {
    await page.locator('#lab-E-008 .lab-record-verdict').click();
    await page.waitForSelector('#labVerdictSheet[open]');
    await page.locator('#labVerdictLighting').selectOption('diagnostic');  // the light is never assumed
    await page.locator('.lab-verdict-row[data-tab="12A"] button[data-choice="clean"]').click();
    await page.locator('.lab-verdict-row[data-tab="12A"] button[data-choice="no"]').click();
    await page.locator('.lab-verdict-row[data-tab="12B"] button[data-choice="clean"]').click();
    await page.locator('.lab-verdict-row[data-tab="12B"] button[data-choice="yes"]').click();
    await page.locator('#labVerdictSend').click();

    const listRes = await fetch(`${base}/api/lab/hex-tile/requests?status=pending`, { headers: { 'X-LocalAI-Mac-Key': KEY } });
    const { items } = await listRes.json();
    const vReq = items.find(i => i.kind === 'verdict');
    assert.ok(vReq);
    await fetch(`${base}/api/lab/hex-tile/requests/${vReq.id}/result`, {
      method: 'POST',
      headers: { 'X-LocalAI-Mac-Key': KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'refused', message: 'E-008 already has a verdict. Use --replace to change it; the old one is kept.' })
    });

    await page.waitForSelector('#labVerdictReplace:not([hidden])');
    assert.match(await page.locator('#labVerdictError').innerText(), /already has a verdict/);
    await page.locator('#labVerdictCancel').click();
  });
  await check(`${name}: selecting two images shows thumbnails with tab chips, Send photos PUTs incoming and POSTs request`, async () => {
    const testFile1 = path.join(dataDir, 'test1.jpg');
    const testFile2 = path.join(dataDir, 'test2.jpg');
    fs.writeFileSync(testFile1, jpg);
    fs.writeFileSync(testFile2, jpg);

    const fileInput = page.locator('#lab-E-008 input[type="file"]');
    await fileInput.setInputFiles([testFile1, testFile2]);
    await page.waitForSelector('#labPhotosSheet[open]');

    const rows = page.locator('.lab-photo-row');
    assert.equal(await rows.count(), 2);
    assert.equal(await rows.nth(0).locator('button[data-tab]').count(), 2);
    await rows.nth(0).locator('button[data-tab="12A"]').click();
    await rows.nth(1).locator('button[data-tab="12B"]').click();

    await page.locator('#labPhotosSend').click();
    await page.waitForSelector('#labPhotosSheet:not([open])', { state: 'attached' });

    const listRes = await fetch(`${base}/api/lab/hex-tile/requests?status=pending`, { headers: { 'X-LocalAI-Mac-Key': KEY } });
    const { items } = await listRes.json();
    const photoReq = items.find(i => i.kind === 'photos');
    assert.ok(photoReq);
    assert.equal(photoReq.payload.photos[0].tab, '12A');
    assert.equal(photoReq.payload.photos[1].tab, '12B');
    await page.waitForFunction(() => /Photos/.test(document.getElementById('lab-E-008')?.textContent || ''));
  });
  await check(`${name}: a Needs-you link opens that experiment's details`, async () => {
    await page.locator('[data-lab-open="E-006"]').first().click();
    assert.equal(await page.locator('#lab-E-006 .lab-details').getAttribute('open'), '');
    assert.match(await page.locator('#lab-E-006 .lab-guards').innerText(), /248\.7 \/ 45 min per test/);
    assert.match(await page.evaluate(() => location.hash), /#printLab\?e=E-006/);
  });
  await check(`${name}: an old experiment's photo comes from Local AI`, async () => {
    await page.locator('.lab-earlier > summary').click();
    const img = page.locator('#lab-E-004 .lab-thumbs img').first();
    await img.scrollIntoViewIfNeeded();
    assert.equal(await img.evaluate(i => i.complete && i.naturalWidth), 1);
    assert.match(await page.locator('#lab-E-004').innerText(), /Prediction refuted[\s\S]*Fair comparison/);
  });
  await check(`${name}: How the lab works is folded, and opens to the ten steps, the rules and where things live`, async () => {
    const guide = page.locator('#printLabGuide');
    assert.equal(await guide.getAttribute('open'), null);
    await guide.locator('summary').click();
    assert.equal(await guide.getAttribute('open'), '');
    assert.deepEqual(await guide.locator('.lab-guide__flow > li > b').allInnerTexts(),
      ['Question', 'Plan', 'Build', 'Check', 'Approval, if needed', 'Send', 'Start', 'Photos', 'Verdict', 'Outcome']);
    assert.match(await guide.innerText(), /One factor per experiment[\s\S]*Asked for vs what printed[\s\S]*Mac[\s\S]*Local AI[\s\S]*Phone/);
    assert.match(await guide.innerText(), /lab exp send/);
  });
  await check(`${name}: the verdict sheet starts with no light chosen and won't send without one`, async () => {
    await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('printLab:draft:')) localStorage.removeItem(k); });
    await page.locator('#lab-E-008 .lab-record-verdict').click();
    await page.waitForSelector('#labVerdictSheet[open]');
    assert.equal(await page.locator('#labVerdictLighting').inputValue(), '');
    for (const tab of ['12A', '12B']) for (const c of ['clean', 'yes']) await page.locator(`.lab-verdict-row[data-tab="${tab}"] button[data-choice="${c}"]`).click();
    assert.equal(await page.locator('#labVerdictSend').isDisabled(), true);
    await page.locator('#labVerdictLighting').selectOption('room');
    assert.equal(await page.locator('#labVerdictSend').isDisabled(), false);
    await page.locator('#labVerdictCancel').click();
  });
  await check(`${name}: Record what happened asks only each subject's own questions, with nothing chosen`, async () => {
    await page.locator('#lab-E-007 .lab-observe').click();
    await page.waitForSelector('#labObserveSheet[open] [data-subject="pair"]');
    assert.equal(await page.locator('#labObserveSheet input[type=radio]:checked').count(), 0);
    assert.equal(await page.locator('#labObserveSend').isDisabled(), true);
    assert.deepEqual(await page.locator('[data-subject="pair"] fieldset legend').allInnerTexts(), ['Separation', 'Overall']);
    assert.deepEqual(await page.locator('[data-subject="tile1"] fieldset legend').allInnerTexts(), ['Which side', 'Face', 'Back', 'Mounting']);
    assert.match(await page.locator('#labObserveMissing').innerText(), /Which part/);
  });
  await check(`${name}: "Doesn't apply" needs a reason, and the draft survives a reload`, async () => {
    const pick = (q, v) => page.locator(`#labObserveSheet [data-q="${q}"] input[value="${v}"]`).check();
    await pick('variant', 'E-007-A'); await pick('identified', 'confirmed');
    await pick('pair.separation', 'not_applicable');
    await pick('pair.acceptance', 'accepted_with_defects');
    for (const t of ['tile1', 'tile2']) { await pick(`${t}.side`, t === 'tile1' ? 'left' : 'right'); await pick(`${t}.face`, 'clean'); await pick(`${t}.backing`, 'not_assessed'); await pick(`${t}.mounting`, 'unknown'); }
    await pick('light', 'room');
    assert.equal(await page.locator('#labObserveSend').isDisabled(), true);
    assert.match(await page.locator('#labObserveMissing').innerText(), /why separation doesn't apply/);
    await page.locator('#labObserveSheet [data-note-input="pair.separation"]').fill('the pair broke on the plate');
    assert.equal(await page.locator('#labObserveSend').isDisabled(), false);
    await page.reload();
    await page.waitForSelector('#printLab.active .lab-needs-card');
    await page.locator('#lab-E-007 .lab-observe').click();
    await page.waitForSelector('#labObserveSheet[open] [data-subject="pair"]');
    assert.equal(await page.locator('#labObserveSheet [data-q="pair.separation"] input[value="not_applicable"]').isChecked(), true);
    assert.equal(await page.locator('#labObserveSend').isDisabled(), false);
  });
  await check(`${name}: sending makes one request with complete snapshots; Recorded when the Mac applies it`, async () => {
    await page.locator('#labObserveSend').click();
    await page.waitForFunction(() => /Waiting for the Mac/.test(document.getElementById('labObserveStatus')?.textContent || ''));
    const { items } = await (await fetch(`${base}/api/lab/hex-tile/requests?status=pending`, { headers: { 'X-LocalAI-Mac-Key': KEY } })).json();
    const reqs = items.filter(i => i.kind === 'observation');
    assert.equal(reqs.length, 1);
    const snaps = reqs[0].payload.snapshots;
    assert.deepEqual(snaps.map(s => s.subject.kind), ['pair', 'tile', 'tile']);
    assert.deepEqual(Object.keys(snaps[0].outcomes).sort(), ['acceptance', 'separation']);
    assert.deepEqual(Object.keys(snaps[1].outcomes).sort(), ['acceptance', 'backing', 'face', 'mounting']);
    assert.deepEqual(snaps[0].outcomes.separation, { status: 'not_applicable', value: null, note: 'the pair broke on the plate' });
    assert.deepEqual(snaps[1].outcomes.acceptance, { status: 'not_assessed', value: null, note: null });
    assert.equal(snaps[1].subject.tile, 'left');
    assert.equal(snaps[0].viewing.light, 'room');
    assert.equal(snaps[0].source.kind, 'owner_report');
    await answer(reqs[0].id, 'applied', 'Recorded OBS-0001, OBS-0002, OBS-0003');
    await page.waitForFunction(() => /Recorded/.test(document.getElementById('labObserveStatus')?.textContent || ''));
    assert.equal(await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('printLab:observe:')).length), 0);
    await page.locator('#labObserveClose').click();
  });
  await check(`${name}: the Record what happened sheet passes axe`, async () => {
    await page.locator('#lab-E-007 .lab-observe').click();
    await page.waitForSelector('#labObserveSheet[open] [data-subject="pair"]');
    await addAxe(page, axePath);
    const r = await page.evaluate(async () => await window.axe.run(document.getElementById('labObserveSheet'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } }));
    assert.deepEqual(r.violations.map(v => v.id), []);
    await page.locator('#labObserveClose').click();
  });
  await check(`${name}: axe finds nothing on the page`, async () => {
    await addAxe(page, axePath);
    const v = await page.evaluate(tags => window.axe.run(document.getElementById('printLab'), { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] }).then(r => r.violations.map(x => `${x.id}: ${x.nodes.map(n => n.target.join(' ')).join(', ')}`)), TAGS);
    assert.deepEqual(v, []);
  });
  await shot(page, `print-lab-${name}.png`);
  await page.close();
}
await check('a direct link to an experiment opens it', async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(`${base}/#printLab?e=E-004`);
  await page.waitForSelector('#lab-E-004 .lab-details[open]');
  assert.equal(await page.locator('.lab-earlier').getAttribute('open'), '');
  await page.close();
});
await check('no script errors', async () => assert.deepEqual(errors, []));

await browser.close();
stub.close();
const done = once(child, 'exit'); child.kill('SIGTERM'); await done;
fs.rmSync(dataDir, { recursive: true, force: true });
if (failed) { console.log(`${failed} check(s) failed`); process.exit(1); }
console.log('print-lab-ui: all checks passed');
