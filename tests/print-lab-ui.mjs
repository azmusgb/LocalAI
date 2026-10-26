// Projects › Print lab: the Mac's lab page, read-only. A throwaway server gets a fixture through the real sync route
// (with the Mac key), then the page is checked on an iPhone and a desktop: Needs you first with each command and Copy,
// the question's budget, a link that opens an experiment's details, Earlier folded, photos from the server, and axe.
// SHOTS=<dir> saves screenshots there.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
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
const { child, ready } = spawnAppServer({ env: { DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, OLLAMA_URL: off, SEARXNG_URL: off, COMFY_URL: off, N8N_URL: off, PROXY_URL: off, GRIDCRAFT_URL: off, MAC_AI_HOME_URL: off, MAC_DSH_URL: off, LOCALAI_WORKSHOP_URL: off } });
const base = await ready;

// A 1 x 1 JPEG, sent the way `lab sync` sends photos.
const jpg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');
const sha = crypto.createHash('sha256').update(jpg).digest('hex');
const exp = (id, status, extra = {}) => ({ id, question: 'Q-002', status, provenance: 'prospective', question_text: `${id}: does the top edge print clean?`, hypothesis: 'The ripple is gone.', prediction: 'No ripple from 60 cm.', why_this_test: 'Only this shows the upper edge.', test_kind: 'height_strip', judge_on: 'top edge', factor: { name: 'inner_wall_speed', unit: 'mm/s', values: [250, 80] }, variants: [{ id: `${id}-A`, tab: '5A', requested: 250, realized: 147, as_asked: false, unit: 'mm/s' }, { id: `${id}-B`, tab: '5B', requested: 80, realized: 80, as_asked: true, unit: 'mm/s' }], reference_variants: [], estimate: { minutes: 99.4, g: 29.1 }, layer_time_median_s: 13.7, usage: null, check: null, outcome: null, validity: null, verdict: null, approval: null, abandoned_reason: null, filament: null, runs: [], photos: [], ai_observations: [], needs: null, ...extra });
const index = {
  schema: 'print-lab-index/1', project: 'hex-tile', generated_at: new Date().toISOString(), fingerprint: 'f'.repeat(64),
  questions: [{ id: 'Q-002', question: 'Is v58 good enough on a full tile?', status: 'active', budget: { minutes: 480, g: 300, test_minutes: 45, test_g: 25 }, spent: { minutes: 99.4, g: 29.1 }, next: { id: 'E-006', minutes: 248.7, g: 76.4 }, stop: { kind: null, text: 'continue' }, streak: 0, evidence: { informative: 1, uninformative: 0 }, experiments: ['E-004', 'E-006', 'E-008'], plans: [], answered: 1 }],
  experiments: [
    exp('E-008', 'printing', {
      criteria: [
        { key: 'print', label: 'Printed cleanly?', choices: ['clean', 'flawed', 'failed'] },
        { key: 'apart', label: 'Twists apart by hand?', choices: ['yes', 'hard', 'no'] }
      ],
      run: 'PR-008-01',
      variants: [
        { id: 'E-008-A', tab: '12A', requested: 250, realized: 147, as_asked: false, unit: 'mm/s' },
        { id: 'E-008-B', tab: '12B', requested: 80, realized: 80, as_asked: true, unit: 'mm/s' }
      ],
      needs: { id: 'E-008', urgency: 0, action: 'Judge the print', why: 'Look at: top edge.', command: 'uv run lab exp verdict E-008 --rank A --note "what you see"' }
    }),
    exp('E-009', 'printing', { judge_on: 'both fronts', due_at: new Date(Date.now() + 90 * 60e3).toISOString(),
      needs: { id: 'E-009', urgency: 0, action: 'Judge the print', due_at: new Date(Date.now() + 90 * 60e3).toISOString(), why: 'Printing until about 11:55 (estimate). Then look at: both fronts. Photos help.', command: 'uv run lab exp verdict E-009 --accept "yes|no" --note "what you see"' } }),
    exp('E-007', 'answered', { test_kind: 'full_part', verdict: { kind: 'acceptance', good_enough: true, defects: ['separation very hard'], note: 'faces good', at: new Date(Date.now() - 3600e3).toISOString() } }),
    exp('E-006', 'needs_approval', { check: { status: 'needs_approval', guards: [{ code: 'per_test_time', ok: false, result: 'needs_approval', message: '248.7 / 45 min per test' }] }, needs: { id: 'E-006', urgency: 2, action: 'Approve or drop', why: '248.7 / 45 min per test', command: 'uv run lab exp approve E-006 --reason "..."' } }),
    exp('E-004', 'answered', { outcome: 'refuted', validity: { status: 'valid', reasons: [{ code: 'cross_plate_by_design', status: 'valid' }] }, verdict: { kind: 'ranking', note: 'they look good', at: '2026-09-24T23:14:18Z' }, photos: [{ run: 'PR-004-01', path: 'photos/PR-004-1.jpg', sha256: sha }] })
  ],
  needs: [], problems: [], records: { 'E-004': { type: 'experiment', file: 'experiments/E-004.json', sha256: 'a'.repeat(64), payload: { id: 'E-004' } } }
};
index.needs = index.experiments.filter(x => x.needs).map(x => x.needs);
const put = await fetch(`${base}/api/lab/hex-tile/photos/${sha}.jpg`, { method: 'PUT', headers: { 'X-LocalAI-Mac-Key': KEY, 'Content-Type': 'image/jpeg' }, body: jpg });
assert.equal(put.status, 200);
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
    assert.deepEqual(rows, ['Judge the print · E-008', 'Printing · E-009', 'Approve or drop · E-006']);
    assert.equal(await page.locator('.lab-needs code').first().innerText(), 'uv run lab exp verdict E-008 --rank A --note "what you see"');
    assert.equal(await page.locator('.lab-needs .lab-copy').count(), 2);  // none for the print still running
    assert.equal(await page.locator('#printLab h1').innerText(), 'Projects');
  });
  await check(`${name}: a print still running says when it's due instead of asking for a verdict`, async () => {
    const row = page.locator('.lab-needs .list-row').filter({ hasText: 'E-009' });
    assert.match(await row.innerText(), /Done about \d\d:\d\d \(estimate\)\. Then look at: both fronts\./);
    assert.equal(await row.locator('code').count(), 0);
  });
  await check(`${name}: a result from the last few days stays out of Earlier, with Accepted and its defects`, async () => {
    assert.equal(await page.locator('.lab-earlier #lab-E-007').count(), 0);
    const card = await page.locator('#lab-E-007').innerText();
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
  await check(`${name}: printing card with criteria shows Add photos and Record verdict, and the light hint`, async () => {
    const card = page.locator('#lab-E-008');
    assert.equal(await card.locator('.lab-add-photos').count(), 1);
    assert.equal(await card.locator('.lab-record-verdict').count(), 1);
    assert.match(await card.locator('.lab-light-hint').innerText(), /Raking light from one side/);
  });
  await check(`${name}: verdict sheet has rows and chips; Send stays disabled until complete`, async () => {
    await page.locator('#lab-E-008 .lab-record-verdict').click();
    await page.waitForSelector('#labVerdictSheet[open]');
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
    assert.equal(await page.locator('.lab-verdict-row[data-tab="12A"] button[data-choice="clean"]').getAttribute('aria-checked'), 'true');
    assert.equal(await page.locator('#labVerdictSend').isDisabled(), false);
    await page.locator('#labVerdictCancel').click();
  });
  await check(`${name}: sending verdict shows Waiting for the Mac, then Recorded when applied`, async () => {
    await page.locator('#lab-E-008 .lab-record-verdict').click();
    await page.waitForSelector('#labVerdictSheet[open]');
    await page.locator('#labVerdictSend').click();
    const status = page.locator('#labVerdictStatus');
    await status.waitFor();
    assert.match(await status.innerText(), /Waiting for the Mac/);

    // Mac fetches pending and applies it
    const listRes = await fetch(`${base}/api/lab/hex-tile/requests?status=pending`, { headers: { 'X-LocalAI-Mac-Key': KEY } });
    const { items } = await listRes.json();
    const vReq = items.find(i => i.kind === 'verdict');
    assert.ok(vReq);
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
    const img = page.locator('#lab-E-004 .lab-shots img').first();
    await img.scrollIntoViewIfNeeded();
    assert.equal(await img.evaluate(i => i.complete && i.naturalWidth), 1);
    assert.match(await page.locator('#lab-E-004').innerText(), /Prediction refuted[\s\S]*Fair comparison/);
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
const done = once(child, 'exit'); child.kill('SIGTERM'); await done;
fs.rmSync(dataDir, { recursive: true, force: true });
if (failed) { console.log(`${failed} check(s) failed`); process.exit(1); }
console.log('print-lab-ui: all checks passed');
