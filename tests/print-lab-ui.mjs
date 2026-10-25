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
    exp('E-008', 'printing', { needs: { id: 'E-008', urgency: 0, action: 'Judge the print', why: 'Look at: top edge.', command: 'uv run lab exp verdict E-008 --rank A --note "what you see"' } }),
    exp('E-006', 'needs_approval', { check: { status: 'needs_approval', guards: [{ code: 'per_test_time', ok: false, result: 'needs_approval', message: '248.7 / 45 min per test' }] }, needs: { id: 'E-006', urgency: 2, action: 'Approve or drop', why: '248.7 / 45 min per test', command: 'uv run lab exp approve E-006 --reason "..."' } }),
    exp('E-004', 'answered', { outcome: 'refuted', validity: { status: 'valid', reasons: [{ code: 'cross_plate_by_design', status: 'valid' }] }, verdict: { kind: 'ranking', note: 'they look good', at: '2026-10-24T23:14:18Z' }, photos: [{ run: 'PR-004-01', path: 'photos/PR-004-1.jpg', sha256: sha }] })
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
for (const [name, viewport] of [['iPhone', { width: 390, height: 844 }], ['desktop', { width: 1440, height: 900 }]]) {
  const page = await browser.newPage({ viewport, colorScheme: 'dark' });
  page.on('pageerror', e => errors.push(`${name}: ${e.message}`));
  await page.goto(`${base}/#printLab`);
  await page.waitForSelector('#printLab.active .lab-needs-card');

  await check(`${name}: Needs you comes first, most urgent first, each with its command and Copy`, async () => {
    const rows = await page.locator('.lab-needs .list-row__title').allInnerTexts();
    assert.deepEqual(rows, ['Judge the print · E-008', 'Approve or drop · E-006']);
    assert.equal(await page.locator('.lab-needs code').first().innerText(), 'uv run lab exp verdict E-008 --rank A --note "what you see"');
    assert.equal(await page.locator('.lab-needs .lab-copy').count(), 2);
    assert.equal(await page.locator('#printLab h1').innerText(), 'Projects');
  });
  await check(`${name}: the question shows its budget, what the next test adds and that it continues`, async () => {
    const q = await page.locator('.lab-question').innerText();
    assert.match(q, /99\.4 \/ 480 min/);
    assert.match(q, /E-006 would add 248\.7 min, 76\.4 g/);
    assert.match(q, /Continue/);
  });
  await check(`${name}: cards show requested vs printed, and finished work is folded under Earlier`, async () => {
    assert.match(await page.locator('#lab-E-008').innerText(), /5A: 250 asked, 147 printed mm\/s/);
    assert.equal(await page.locator('.lab-earlier').getAttribute('open'), null);
    assert.equal(await page.locator('.lab-earlier #lab-E-004').count(), 1);
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
