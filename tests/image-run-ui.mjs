import './browser-target-guard.mjs';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { addAxe } from './axe-helper.mjs';

// Task 6: images started from Home open as a run view; the image editor moves in, and goes back to #create on close.
const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const axePath = join(dirname(fileURLToPath(import.meta.url)), 'vendor', 'axe.min.js');
const browser = await chromium.launch({ headless: true });
const T = { timeout: 6000 };
const failures = [];
async function check(name, fn) { try { await fn(); console.log('PASS', name); } catch (error) { failures.push(`${name}: ${error.message}`); console.error('FAIL', name, error.message); } }
const aspects = [['square', 'Square', [512, 512], [1024, 1024]]].map(([id, label, s, l]) => ({ id, label, sizes: { 512: s, 1024: l } }));
const models = { engines: [{ id: 'fast', label: 'Fast', blurb: 'Quick drafts.', family: 'sd15', base: 512 }], custom: [], upscale: false, defaultEngine: 'fast', aspects, styles: [{ id: 'none', label: 'None' }] };
const NOW = Date.now();
const imgRun = (n, o = {}) => ({
  id: `run-i${n}`, type: 'image', status: 'completed', progress: 100, threadId: o.threadId === undefined ? 't1' : o.threadId, title: 'a cat ' + n,
  createdAt: new Date(NOW + n * 1000).toISOString(), updatedAt: new Date(NOW + n * 1000).toISOString(),
  input: { prompt: 'a cat', engine: 'fast', width: 512, height: 512, count: 1, style: 'none' },
  output: { engineLabel: 'Fast', width: 512, height: 512, elapsedMs: 4000, images: [{ imageUrl: `/x${n}.png`, seed: 10 + n }] }, artifactIds: [],
  card: { kind: 'image', icon: 'image', title: 'a cat ' + n, summary: '', badge: { label: 'Done', tone: 'good' }, preview: null, action: { label: 'Open' }, approval: null }
});
async function open(viewport, { runs = [], hash = '#home', mode = 'create' } = {}) {
  const db = { runs, sent: [], delay: 400 };
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport, isMobile: viewport.width < 760, hasTouch: viewport.width < 760 });
  await ctx.addInitScript(m => { try { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem('localai.firstRun.done', '1'); if (m) localStorage.setItem('localai.home.mode', m); } } catch {} }, mode);
  const page = await ctx.newPage({ serviceWorkers: 'block' });
  page.db = db; page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  const json = (r, body, status = 200) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await ctx.route(u => u.pathname === '/api/approvals', r => json(r, { items: [] }));
  await ctx.route(u => u.pathname === '/api/activity', r => json(r, { items: [] }));
  await page.route(u => u.pathname === '/api/capabilities', r => json(r, { services: ['ollama', 'search', 'comfy', 'n8n'].map(name => ({ name, label: name, state: 'HEALTHY', required: true })), models: { defaultInstalled: true }, images: { available: true }, version: '1' }));
  await page.route(u => u.pathname === '/api/library', r => json(r, { items: [], counts: {}, total: 0 }));
  await page.route(u => u.pathname === '/api/images/models', r => json(r, models));
  await page.route(u => /^\/x\d*\.png$/.test(u.pathname), r => { const n = Number(/x(\d*)\.png/.exec(new URL(r.request().url()).pathname)[1] || 0); r.fulfill({ body: `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="hsl(${n * 70 + 200},60%,45%)"/><circle cx="256" cy="256" r="${60 + n * 30}" fill="hsl(${n * 70 + 20},80%,70%)"/></svg>`, contentType: 'image/svg+xml' }); });
  await page.route(u => u.pathname === '/api/images/generate', async r => {
    const body = JSON.parse(r.request().postData()); db.sent.push(body);
    await new Promise(res => setTimeout(res, db.delay));
    const run = imgRun(db.runs.length + 1, { threadId: body.threadId || 't1' }); db.runs.push(run);
    json(r, { ...run.output, imageUrl: run.output.images[0].imageUrl, seed: run.output.images[0].seed, images: run.output.images, prompt: body.prompt, usedPrompt: body.prompt, runId: run.id, threadId: run.threadId, edited: !!body.source });
  });
  await page.route(u => u.pathname === '/api/runs', r => {
    const q = new URL(r.request().url()).searchParams;
    if (q.get('id')) { const it = db.runs.find(x => x.id === q.get('id')); return it ? json(r, { item: it }) : json(r, { error: 'Run not found' }, 404); }
    if (q.get('threadId')) return json(r, { items: db.runs.filter(x => x.threadId === q.get('threadId')), summary: {} });
    json(r, { items: db.runs, summary: {} });
  });
  await page.goto(base + '/' + hash, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.showView === 'function' && window.LocalAIRouter && window.LocalAIHome && window.LocalAIImages && location.hash, null, { timeout: 8000 });
  return page;
}
const home = async (page, text) => { await page.locator('#commandInput').fill(text); await page.locator('#commandGo').click(); };
const phone = { width: 390, height: 844 };

const page = await open({ width: 1280, height: 860 });
await check('Image mode Send shows Creating your image… with a counter that advances, then opens the run with the image', async () => {
  page.db.delay = 2500;
  await home(page, 'a cat');
  await page.locator('#runDrawer .run-view-state__text').waitFor(T);
  assert.match(await page.locator('#runDrawer .run-view-state__text').innerText(), /^Creating your image… \d+ s$/);
  await page.waitForFunction(() => /^Creating your image… [1-9]\d* s$/.test(document.querySelector('#runDrawer .run-view-state__text')?.textContent || ''), null, T);
  page.db.delay = 400;
  await page.waitForFunction(() => location.hash === '#run/run-i1', null, T);
  await page.locator('#runDrawer #generatedImage').waitFor(T);
  assert.match(await page.locator('#generatedImage').getAttribute('src'), /x1\.png/);
  assert.equal(await page.locator('#runDrawer #imageStage').count(), 1);
  assert.equal(await page.locator('#runDrawer #imageActions').isVisible(), true);
});
await check('Another version posts the thread and moves to the new version, with a strip of versions', async () => {
  await page.locator('#imageAgain').click();
  await page.waitForFunction(() => location.hash === '#run/run-i2', null, T);
  assert.equal(page.db.sent[1].threadId, 't1');
  await page.locator('#runDrawer .run-body-image__strip button').nth(1).waitFor(T);
  assert.equal(await page.locator('#runDrawer .run-body-image__strip button').count(), 2);
  assert.match(await page.locator('#generatedImage').getAttribute('src'), /x2\.png/);
});
await check('a strip thumbnail routes to that version (no new history) and survives a rebuild', async () => {
  const len = await page.evaluate(() => history.length);
  await page.locator('#runDrawer .run-body-image__strip button').nth(0).click();
  await page.waitForFunction(() => location.hash === '#run/run-i1' && /x1\.png/.test(document.querySelector('#generatedImage').src), null, T);
  assert.equal(await page.evaluate(() => history.length), len, 'no new history entry');
  // A rebuild of the run view (the run changed) keeps the second... the clicked version.
  page.db.runs[0].title = 'a cat renamed'; page.db.runs[0].updatedAt = new Date().toISOString();
  await page.evaluate(() => window.LocalAIRuns.refresh());
  await page.waitForFunction(() => /renamed/.test(document.querySelector('#runDrawer').innerText), null, T);
  assert.match(await page.locator('#generatedImage').getAttribute('src'), /x1\.png/);
  assert.equal(await page.evaluate(() => location.hash), '#run/run-i1');
  assert.equal(await page.locator('#runDrawer .run-body-image__strip button[aria-current="true"]').count(), 1);
});
await check('Edit opens the editor inside the run view; Apply edit posts the thread and the source', async () => {
  await page.locator('#imageEditThis').click();
  await page.locator('#runDrawer #imageEditPanel').waitFor({ state: 'visible', ...T });
  assert.equal(await page.locator('#runDrawer #generateBtn').innerText(), 'Apply edit');
  await page.locator('#runDrawer #imagePrompt').fill('add a hat');
  await page.locator('#runDrawer #generateBtn').click();
  await page.waitForFunction(() => document.querySelector('#imageEditPanel') && !!document.querySelector('#runDrawer'), null, T);
  await page.waitForFunction(() => location.hash === '#run/run-i3', null, T);
  const b = page.db.sent.at(-1);
  assert.equal(b.threadId, 't1');
  assert.match(b.source, /^data:image\/png;base64,/);
});
await check('closing the run view returns the stage and editor to #create', async () => {
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#runDrawerBackdrop.show'), null, T);
  for (const id of ['imageStage', 'imageEditPanel', 'generateBtn', 'imagePrompt', 'imageActions', 'imageAgain'])
    assert.equal(await page.evaluate(i => { const n = document.querySelectorAll('#' + i); return n.length === 1 && !!n[0].closest('#create'); }, id), true, id);
  assert.equal(await page.locator('#runDrawer #imageStage').count(), 0);
});
await check('no script errors', async () => assert.deepEqual(page.errors, []));
await page.context().close();

await check('a run opened later (not made here) has Another version and Edit that keep its thread', async () => {
  const p = await open({ width: 1280, height: 860 }, { runs: [imgRun(1, { threadId: 't9' }), imgRun(2, { threadId: 't9' })], mode: 'ask' });
  await p.evaluate(() => window.LocalAIRuns.show('run-i2'));
  await p.locator('#runDrawer #generatedImage').waitFor(T);
  assert.match(await p.locator('#generatedImage').getAttribute('src'), /x2\.png/);
  await p.locator('#imageAgain').click();
  await p.waitForFunction(() => location.hash === '#run/run-i3', null, T);
  assert.equal(p.db.sent[0].threadId, 't9');
  assert.equal(p.db.sent[0].prompt, 'a cat');
  await p.context().close();
});

await check('a Best preview opened as a run shows Preview and Make the full picture, which asks for its shape and seed', async () => {
  const pvRun = imgRun(1, { threadId: 't7' });
  Object.assign(pvRun, { meta: { preview: true }, input: { ...pvRun.input, engine: 'best', aspect: 'portrait', width: 400, height: 576, steps: 6 }, output: { ...pvRun.output, engine: 'best', engineLabel: 'Best', preview: true, width: 400, height: 576 } });
  const p = await open({ width: 1280, height: 860 }, { runs: [pvRun], mode: 'ask' });
  await p.evaluate(() => window.LocalAIRuns.show('run-i1'));
  await p.locator('#runDrawer #imagePreviewBar:not([hidden])').waitFor(T);
  assert.equal(await p.locator('#runDrawer #imagePreviewTag').isVisible(), true);
  assert.equal(await p.locator('#imageFullEstimate').innerText(), 'About 4 minutes');
  await addAxe(p, axePath);
  const v = await p.evaluate(() => window.axe.run('#runDrawer', { runOnly: { type: 'rule', values: ['color-contrast', 'target-size'] } }).then(r => r.violations.map(x => `${x.id}: ${x.nodes.map(n => n.html.slice(0, 120)).join(' | ')}`)));
  assert.deepEqual(v, []);
  await p.locator('#imageMakeFull').click();
  await p.waitForFunction(() => location.hash === '#run/run-i2', null, T);
  const b = p.db.sent[0];
  assert.deepEqual([b.previewOf, b.seed, b.preview, b.aspect, b.width, b.steps, b.threadId], ['run-i1', 11, undefined, 'portrait', undefined, undefined, 't7']);
  assert.deepEqual(p.errors, []);
  await p.context().close();
});

await check('a failed start fails the Starting… view and keeps the text on Home', async () => {
  const p = await open({ width: 1280, height: 860 });
  await p.unroute(u => u.pathname === '/api/images/generate').catch(() => {});
  await p.route(u => u.pathname === '/api/images/generate', r => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'ComfyUI: out of memory' }) }));
  await home(p, 'a dog');
  await p.locator('#runDrawer [role="alert"]').waitFor(T);
  assert.match(await p.locator('#runDrawer').innerText(), /out of memory/);
  await p.keyboard.press('Escape');
  await p.waitForFunction(() => !document.querySelector('#runDrawerBackdrop.show'), null, T);
  assert.equal(await p.locator('#commandInput').inputValue(), 'a dog');
  await p.context().close();
});

await check('axe: the image run view with a strip passes color-contrast and target-size at 390x844', async () => {
  const p = await open(phone, { runs: [imgRun(1), imgRun(2), imgRun(3)], mode: 'ask' });
  await p.evaluate(() => window.LocalAIRuns.show('run-i3'));
  await p.locator('#runDrawer .run-body-image__strip button').nth(2).waitFor(T);
  await p.waitForFunction(() => document.querySelector('#generatedImage')?.complete, null, T);
  await addAxe(p, axePath);
  const v = await p.evaluate(() => window.axe.run('#runDrawer', { runOnly: { type: 'rule', values: ['color-contrast', 'target-size'] } }).then(r => r.violations.map(x => `${x.id}: ${x.nodes.map(n => n.html.slice(0, 120)).join(' | ')}`)));
  assert.deepEqual(v, []);
  if (process.env.SHOT) await p.screenshot({ path: process.env.SHOT });
  await p.context().close();
});

await browser.close();
if (failures.length) { console.error(`\n${failures.length} image run check(s) failed`); process.exit(1); }
