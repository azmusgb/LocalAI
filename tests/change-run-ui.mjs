import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Task 6: an engineering run opens as a run view that holds the change detail (or the run's steps until a change exists).
const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const axePath = join(dirname(fileURLToPath(import.meta.url)), 'vendor', 'axe.min.js');
const browser = await chromium.launch({ headless: true });
const T = { timeout: 8000 };
const failures = [];
async function check(name, fn) { try { await fn(); console.log('PASS', name); } catch (error) { failures.push(`${name}: ${error.message}`); console.error('FAIL', name, error.message); } }
const NOW = Date.now();
const engRun = (id, changeId, o = {}) => ({
  id: 'legacy-engineering:' + id, type: 'engineering', status: o.status || 'completed', progress: 100, title: 'Make the buttons rounder', summary: o.summary || '',
  createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(), input: { request: 'Make the buttons rounder' }, output: changeId ? { changeId } : null,
  source: { kind: 'engineering', id }, meta: { changeId: changeId || null }, artifactIds: [],
  card: { kind: 'engineering', icon: 'system', title: 'Make the buttons rounder', summary: '', badge: { label: 'Done', tone: 'good' }, preview: null, action: { label: 'Open' }, approval: null }
});
const change = (o = {}) => ({ id: 'c1', status: 'awaiting_approval', summary: 'Rounder buttons', request: 'Make the buttons rounder', target: 'workspace', root: 'repos', files: [{ path: 'app.css', operations: [{}] }], validation: { checks: [{ name: 'Syntax', result: 'PASS', detail: 'ok' }] }, diffs: [{ path: 'app.css', diff: '-a\n+b' }], ...o });
async function open(viewport, db) {
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport, isMobile: viewport.width < 760, hasTouch: viewport.width < 760 });
  await ctx.addInitScript(() => { try { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem('localai.firstRun.done', '1'); } } catch {} });
  const page = await ctx.newPage();
  page.errors = []; page.posts = [];
  page.on('pageerror', e => page.errors.push(e.message));
  const json = (r, body, status = 200) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await ctx.route(u => u.pathname === '/api/approvals', r => json(r, { items: [] }));
  await ctx.route(u => u.pathname === '/api/activity', r => json(r, { items: [] }));
  await page.route(u => u.pathname === '/api/capabilities', r => json(r, { services: ['ollama', 'search', 'comfy', 'n8n'].map(name => ({ name, label: name, state: 'HEALTHY', required: true })), models: { defaultInstalled: true }, images: { available: true }, version: '1' }));
  await page.route(u => u.pathname === '/api/changes', r => json(r, { items: db.changes, pending: db.changes.length }));
  await page.route(u => u.pathname === '/api/changes/approve', r => { const b = JSON.parse(r.request().postData()); page.posts.push(b); db.changes[0].status = b.decision; db.runs[0].summary = b.decision; json(r, { item: db.changes[0] }); });
  await page.route(u => u.pathname === '/api/engineering/runs', r => json(r, { items: db.eng }));
  await page.route(u => u.pathname === '/api/runs', r => {
    const q = new URL(r.request().url()).searchParams;
    if (q.get('id')) { const it = db.runs.find(x => x.id === q.get('id')); return it ? json(r, { item: it }) : json(r, { error: 'Run not found' }, 404); }
    json(r, { items: db.runs, summary: {} });
  });
  await page.goto(base + '/#home', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.showView === 'function' && window.LocalAIRouter && window.LocalAIRuns && location.hash, null, { timeout: 8000 });
  return page;
}

await check('a run with a change shows the change detail with Approve in the run view; Approve refreshes it', async () => {
  const db = { changes: [change()], runs: [engRun('e1', 'c1')], eng: [] };
  const page = await open({ width: 1280, height: 860 }, db);
  await page.evaluate(() => window.LocalAIRuns.show('legacy-engineering:e1'));
  await page.locator('#runDrawer [data-change-approve="c1"]').waitFor(T);
  assert.match(await page.locator('#runDrawer .run-body').innerText(), /Rounder buttons/);
  assert.match(await page.locator('#runDrawer .run-body').innerText(), /Syntax/);
  await page.locator('#runDrawer [data-change-approve="c1"]').click();
  await page.locator('#runDrawer [data-change-apply="c1"]').waitFor(T);
  assert.deepEqual(page.posts, [{ id: 'c1', decision: 'approved' }]);
  assert.equal(await page.locator('#runDrawer [data-change-approve]').count(), 0);
  assert.equal(await page.locator('#changeDetail [data-change-approve]').count(), 0, 'the Changes page copy is not the one shown');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});
await check('a hosted change is fetched fresh, not read from the startup cache', async () => {
  const db = { changes: [change({ status: 'planned' })], runs: [engRun('e1', 'c1')], eng: [] };
  const page = await open({ width: 1280, height: 860 }, db);
  await page.waitForTimeout(500);
  db.changes[0].status = 'awaiting_approval';
  await page.evaluate(() => window.LocalAIRuns.show('legacy-engineering:e1'));
  await page.locator('#runDrawer [data-change-approve="c1"]').waitFor(T);
  assert.equal(await page.locator('#runDrawer [data-change-stage]').count(), 0);
  await page.context().close();
});
await check('a run with no change yet shows its steps, then the change once it exists', async () => {
  const db = { changes: [], runs: [engRun('e2', null, { status: 'running' })], eng: [{ id: 'e2', status: 'running', request: 'x', steps: [{ name: 'Plan the patch', state: 'running', detail: 'working' }], finalChangeId: null }] };
  const page = await open({ width: 1280, height: 860 }, db);
  await page.evaluate(() => window.LocalAIRuns.show('legacy-engineering:e2'));
  await page.locator('#runDrawer .run-body').getByText('Plan the patch').waitFor(T);
  assert.equal(await page.locator('#runDrawer [data-change-approve]').count(), 0);
  db.changes.push(change()); db.eng[0].finalChangeId = 'c1'; db.eng[0].status = 'completed';
  await page.locator('#runDrawer [data-change-approve="c1"]').waitFor({ timeout: 12000 });
  await page.context().close();
});
await check('#changes still renders the change in #changeDetail', async () => {
  const db = { changes: [change()], runs: [], eng: [] };
  const page = await open({ width: 1280, height: 860 }, db);
  await page.evaluate(() => window.showView('changes'));
  await page.locator('#changeDetail [data-change-approve="c1"]').waitFor(T);
  await page.context().close();
});
await check('axe: the change run view passes color-contrast and target-size at 390x844', async () => {
  const db = { changes: [change()], runs: [engRun('e1', 'c1')], eng: [] };
  const page = await open({ width: 390, height: 844 }, db);
  await page.evaluate(() => window.LocalAIRuns.show('legacy-engineering:e1'));
  await page.locator('#runDrawer [data-change-approve="c1"]').waitFor(T);
  await page.addScriptTag({ path: axePath });
  const v = await page.evaluate(() => window.axe.run('#runDrawer', { runOnly: { type: 'rule', values: ['color-contrast', 'target-size'] } }).then(r => r.violations.map(x => `${x.id}: ${x.nodes.map(n => n.html.slice(0, 120)).join(' | ')}`)));
  assert.deepEqual(v, []);
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
  await page.context().close();
});
await browser.close();
if (failures.length) { console.error(`\n${failures.length} change run check(s) failed`); process.exit(1); }
