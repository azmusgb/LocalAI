// Improve › Research (app/public/research-page.js): a read-only page over GET /api/research/state. The state route is
// stubbed in the browser so each state can be shown: on, paused, off, unreadable budget / measures / reader, a failed
// read (503, malformed body) and a refresh that fails after a good read. A failed or unreadable part must say so and
// never show zero, empty or off. Phone and desktop, axe, no write requests. SHOTS=<dir> saves screenshots there.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
const axe = async (page, sel) => { await addAxe(page, axePath); return page.evaluate(([s, tags]) => window.axe.run(document.querySelector(s), { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] }).then(r => r.violations.map(x => `${x.id}: ${x.nodes.map(n => n.target.join(' ')).join(', ')}`)), [sel, TAGS]); };

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-research-ui-'));
const off = 'http://127.0.0.1:9';
const { child, ready } = spawnAppServer({ env: { DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, SEARXNG_URL: off, COMFY_URL: off, N8N_URL: off, PROXY_URL: off, GRIDCRAFT_URL: off, MAC_AI_HOME_URL: off, MAC_DSH_URL: off, LOCALAI_WORKSHOP_URL: off } });
const base = await ready;
const browser = await chromium.launch();

const measure = (o = {}) => ({ noData: false, value: 0.5, num: 3, den: 6, unit: 'documents that needed no model call', note: 'stored documents minus model calls made', ...o });
const GOOD = {
  enabled: true, paused: false, running: false, fetchesToday: 4, dailyFetches: 24, lastTickAt: '2026-11-20T09:30:00.000Z', lastTickSkipped: '',
  sources: { active: 3, paused: 1, quarantined: 0, retired: 2 }, error: '', unreadable: false,
  budget: { unreadable: false, caps: [
    { name: 'day.calls', limit: 20, used: 7, resetsAt: '2026-11-21T00:00:00.000Z' },
    { name: 'day.chars', limit: 100000, used: 0, resetsAt: '2026-11-21T00:00:00.000Z' },
    { name: 'tier2.day.calls', limit: 0, used: 0, resetsAt: '2026-11-21T00:00:00.000Z' }] },
  reader: { enabled: true, unreadable: false, running: false, cursor: 41, lastTickAt: '2026-11-20T09:31:00.000Z', last: { code: 'no_finding', reason: 'nothing relevant, or the quote was not in the document', at: '2026-11-20T09:31:00.000Z', documentId: 'doc-1' }, counts: { read: 12, findings: 2, outOfScope: 1, failed: 0 }, dailyFindings: 10 },
  measures: { unreadable: false, measures: {
    costPerValidatedImprovement: { noData: true, value: null, num: 0, den: 0, unit: 'model calls per validated finding', note: 'all model spend divided by validated findings' },
    modelCallsAvoided: measure(),
    defectDetection: { noData: true, value: null, num: 0, den: 0, unit: '', note: 'not measured: the system does not yet record confirmed defects to compare its checks against' },
    recommendationPrecision: measure({ value: 0, num: 0, den: 4, unit: 'validated of findings with a verdict', note: '' }),
    regressionEscapes: { noData: true, value: null, num: 0, den: 0, unit: '', note: 'not measured: the system does not yet record reverts or fixes of shipped changes' },
    investigationEfficiency: measure({ value: 2.5, num: 5, den: 2, unit: 'model calls per decided finding', note: 'decided means kept, dismissed or promoted' }) } },
};
const variant = patch => ({ ...GOOD, ...patch });

try {
  for (const [name, viewport] of [['phone', { width: 390, height: 844 }], ['desktop', { width: 1280, height: 900 }]]) {
    const page = await browser.newPage({ serviceWorkers: 'block', viewport, colorScheme: process.env.DARK ? 'dark' : 'light' });
    const errors = [], writes = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => { if (r.url().includes('/api/research') && r.method() !== 'GET') writes.push(`${r.method()} ${r.url()}`); });
    let reply = { status: 200, body: GOOD };
    await page.route(u => u.pathname === '/api/research/state', r => r.fulfill({ status: reply.status, contentType: 'application/json', body: typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body) }));
    await page.goto(base, { waitUntil: 'networkidle' });
    const open = async (r) => { reply = r; await page.evaluate(() => window.showView('home')); await page.evaluate(() => window.showView('research')); await page.waitForSelector('#researchBody > *:not(.state-loading)'); };
    const text = sel => page.locator(sel).innerText();

    await check(`${name}: Research is a page of Improve, in its strip, named from the registry`, async () => {
      await open({ status: 200, body: GOOD });
      assert.equal(await text('#research h1'), 'Research');
      const strip = await page.locator('#uxPageStrip button').allInnerTexts(); assert.deepEqual(strip, ['Changes', 'Signals', 'Research', 'Claude Code', 'Atlas']);
    });

    await check(`${name}: on: status, sources, reader, budget and the six measures`, async () => {
      assert.match(await text('#researchPlate'), /Research intake[\s\S]*On[\s\S]*Fetched 4 of 24 allowed today/);
      assert.match(await text('#researchPlate'), /Active sources\s*3[\s\S]*Retired\s*2/);
      const reader = await text('#researchReader');
      assert.match(reader, /Last result[\s\S]*No finding/);
      assert.match(reader, /Documents read\s*12/);
      assert.equal(await page.locator('#researchMeasures tbody tr').count(), 6);
      assert.equal(await page.locator('#researchBudget tbody tr').count(), 3);
      assert.match(await text('#researchBudget'), /Model calls today\s*7\s*20/);
      assert.match(await text('#researchBudget'), /Claude calls today\s*0\s*None allowed/);
    });

    await check(`${name}: a measure with no data says "No data" and its note, never 0%; a real 0 stays 0%`, async () => {
      const rows = await page.locator('#researchMeasures tbody tr').allInnerTexts();
      const defect = rows.find(r => /Defect detection/.test(r));
      assert.match(defect, /No data/); assert.match(defect, /does not yet record confirmed defects/); assert.doesNotMatch(defect, /0%/);
      assert.match(rows.find(r => /Cost per validated/.test(r)), /No data/);
      assert.match(rows.find(r => /Recommendation precision/.test(r)), /0%[\s\S]*0 of 4/);
      assert.match(rows.find(r => /Investigation efficiency/.test(r)), /2\.5[\s\S]*5 of 2/);
    });
    await check(`${name}: on is axe-clean`, async () => { assert.deepEqual(await axe(page, '#research'), []); });
    await shot(page, `research-on-${name}.png`);

    await check(`${name}: paused says paused`, async () => {
      await open({ status: 200, body: variant({ paused: true }) });
      assert.match(await text('#researchPlate'), /Paused[\s\S]*nothing is fetched until it is resumed/i);
    });

    await check(`${name}: off says off and that nothing is fetched or read`, async () => {
      await open({ status: 200, body: variant({ enabled: false, paused: false, reader: { ...GOOD.reader, enabled: false, last: { code: 'off', reason: 'the reader is off' } } }) });
      assert.match(await text('#researchPlate'), /Off[\s\S]*Nothing is fetched or read/);
      assert.match(await text('#researchReader'), /Reader\s*Reads stored[\s\S]*Off/);
    });
    await shot(page, `research-off-${name}.png`);

    await check(`${name}: an unreadable budget, measures and reader each say so and show no zero in their place`, async () => {
      await open({ status: 200, body: variant({ budget: { unreadable: true, reason: 'day.calls is not a whole number', caps: [] }, measures: { unreadable: true, reason: 'the measures could not be read', measures: {} }, reader: { enabled: true, unreadable: true, running: false, last: { code: 'none', reason: 'has not run' }, counts: { read: 0, findings: 0, outOfScope: 0, failed: 0 }, dailyFindings: 10 } }) });
      assert.match(await text('#researchBudget'), /Couldn't read the model budget \(day\.calls is not a whole number\)[\s\S]*none is assumed to be zero/);
      assert.equal(await page.locator('#researchBudget table').count(), 0);
      assert.match(await text('#researchMeasures'), /Couldn't read the measures/);
      assert.equal(await page.locator('#researchMeasures table').count(), 0);
      assert.match(await text('#researchReaderSec'), /place in the documents couldn't be read/);
      assert.match(await text('#researchReader'), /Can't read/);
      assert.doesNotMatch(await text('#researchReaderSec'), /Cursor: 0/);
    });
    await check(`${name}: unreadable parts are axe-clean`, async () => { assert.deepEqual(await axe(page, '#research'), []); });
    await shot(page, `research-unreadable-${name}.png`);

    await check(`${name}: the state route failing says it could not read, with Retry, and shows no status`, async () => {
      await open({ status: 503, body: { error: 'research state could not be read' } });
      const body = await text('#researchBody');
      assert.match(body, /Couldn't load research/); assert.match(body, /research state could not be read/);
      assert.equal(await page.locator('#researchPlate').count(), 0);
      assert.match(await text('#researchSources'), /Research:\s*Not answering/);
      assert.deepEqual(await axe(page, '#research'), []);
      reply = { status: 200, body: GOOD };
      await page.getByRole('button', { name: 'Retry' }).click();
      await page.waitForSelector('#researchPlate');
    });
    await shot(page, `research-failed-${name}.png`);

    await check(`${name}: a malformed reply is a failed read, not an empty page`, async () => {
      await open({ status: 200, body: '{"enabled":true}' });
      assert.match(await text('#researchBody'), /Couldn't load research[\s\S]*unreadable reply/);
      await open({ status: 200, body: 'not json' });
      assert.match(await text('#researchBody'), /Couldn't load research/);
    });

    await check(`${name}: long content wraps inside the page`, async () => {
      const long = 'x'.repeat(300);
      await open({ status: 200, body: variant({ error: long, reader: { ...GOOD.reader, cursor: long, last: { code: 'error', reason: long, at: GOOD.reader.lastTickAt } } }) });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no horizontal scroll');
    });
    await shot(page, `research-long-${name}.png`);

    await check(`${name}: the page makes no write request and has no page errors`, async () => { assert.deepEqual(writes, []); assert.deepEqual(errors, []); });
    await page.close();
  }
} finally {
  await browser.close();
  child.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
if (failed) { console.log(`${failed} failed`); process.exit(1); }
