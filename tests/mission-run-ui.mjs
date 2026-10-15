import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Task 7: a mission started from Home is a run: its view opens at once, Agent World moves in, and Work lists it.
const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const axePath = join(dirname(fileURLToPath(import.meta.url)), 'vendor', 'axe.min.js');
const shotDir = process.env.SHOT_DIR || '';
const browser = await chromium.launch({ headless: true });
const T = { timeout: 6000 };
const failures = [];
async function check(name, fn) { try { await fn(); console.log('PASS', name); } catch (error) { failures.push(`${name}: ${error.message}`); console.error('FAIL', name, error.message); } }
const NOW = Date.now();
const GOAL = 'Review the onboarding flow';
const worker = (id, name, state) => ({ id, name, state, model: 'test-model', dependsOn: [], reason: name });
const mission = { id: 'mission-1', goal: GOAL, projectId: '', status: 'running', createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(), timeline: [], results: [], workers: [worker('router', 'Mission Router', 'complete'), worker('code_analyst', 'Code Analyst', 'running'), worker('synthesis', 'Coordinator', 'pending')] };
const missionRun = (o = {}) => ({
  id: 'run-m1', type: 'agent', status: 'running', progress: 33, threadId: 'run-m1', title: GOAL, createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(),
  input: { goal: GOAL }, meta: { missionId: 'mission-1' }, output: null, artifactIds: [],
  card: { kind: 'agent', icon: 'automate', title: GOAL, summary: '', badge: { label: 'Working', tone: 'accent' }, preview: null, action: { label: 'Open' }, approval: null }, ...o
});
async function open(viewport, { hash = '#home', runs = [] } = {}) {
  const db = { runs, sent: [] };
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport, isMobile: viewport.width < 760, hasTouch: viewport.width < 760 });
  await ctx.addInitScript(() => { try { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem('localai.firstRun.done', '1'); localStorage.setItem('localai.home.mode', 'mission'); } } catch {} });
  const page = await ctx.newPage({ serviceWorkers: 'block' });
  page.db = db; page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  const json = (r, body, status = 200) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await ctx.route(u => u.pathname === '/api/approvals', r => json(r, { items: [] }));
  await ctx.route(u => u.pathname === '/api/activity', r => json(r, { items: [] }));
  await page.route(u => u.pathname === '/api/capabilities', r => json(r, { services: ['ollama', 'search', 'comfy', 'n8n'].map(name => ({ name, label: name, state: 'HEALTHY', required: true })), models: { defaultInstalled: true }, images: { available: true }, version: '1' }));
  await page.route(u => u.pathname === '/api/agents/missions', r => json(r, { items: [mission] }));
  await page.route(u => u.pathname === '/api/agents/mission', r => { db.missionGets = (db.missionGets || 0) + 1; const id = new URL(r.request().url()).searchParams.get('id'); id === mission.id ? json(r, { mission }) : json(r, { error: 'Mission not found' }, 404); });
  await page.route(u => u.pathname === '/api/agents/missions/start', r => { db.sent.push(JSON.parse(r.request().postData())); db.runs.push(missionRun()); json(r, { runId: 'run-m1', threadId: 'run-m1' }, 202); });
  await page.route(u => u.pathname === '/api/runs', r => {
    const q = new URL(r.request().url()).searchParams;
    if (q.get('id')) { const it = db.runs.find(x => x.id === q.get('id')); return it ? json(r, { item: it }) : json(r, { error: 'Run not found' }, 404); }
    json(r, { items: db.runs, summary: {} });
  });
  await page.goto(base + '/' + hash, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.showView === 'function' && window.LocalAIRouter && window.LocalAIHome && window.LocalAIMissions && location.hash, null, { timeout: 8000 });
  return page;
}
const phone = { width: 390, height: 844 };
const awc = '#agentWorldCityMount';

const page = await open({ width: 1280, height: 860 });
await check('Mission mode Send posts async, opens #run/<runId> with Agent World, the headline and the timeline inside the run view', async () => {
  await page.locator('#commandInput').fill(GOAL); await page.locator('#commandGo').click();
  await page.waitForFunction(() => location.hash === '#run/run-m1', null, T);
  assert.equal(page.db.sent[0].goal, GOAL);
  assert.equal(page.db.sent[0].async, true);
  for (const sel of [awc, '#agentTimeline', '#agentMissionHeadline', '#agentMissionProgress'])
    await page.locator('#runDrawer ' + sel).waitFor({ state: 'attached', timeout: 6000 });
  assert.equal(await page.locator(awc).count(), 1);
  await page.locator('#runDrawer .awc').waitFor({ state: 'visible', timeout: 6000 });
  assert.equal(await page.locator('#agentMissionHeadline').innerText(), GOAL);
  assert.ok(await page.locator('#agentTimeline .mission-line').count() >= 3, 'the mission is selected: its workers are listed');
  const box = await page.locator('#runDrawer .awc').boundingBox();
  assert.ok(box && box.width > 200 && box.height > 100, 'Agent World has a size inside the run view');
});
await check('closing the run view returns Agent World, headline and timeline to #agents', async () => {
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#runDrawerBackdrop.show'), null, T);
  for (const id of ['agentWorldCityMount', 'agentTimeline', 'agentMissionHeadline', 'agentMissionProgress'])
    assert.equal(await page.evaluate(i => { const n = document.querySelectorAll('#' + i); return n.length === 1 && !!n[0].closest('#agents'); }, id), true, id);
  assert.equal(await page.locator('#runDrawer ' + awc).count(), 0);
});
await check('Work lists the mission run under the Missions chip', async () => {
  await page.evaluate(() => { location.hash = '#work?kind=missions'; });
  await page.waitForSelector('#work.active .run-card[data-kind="agent"]', T);
  assert.match(await page.locator('#work .run-card[data-kind="agent"]').first().innerText(), /Review the onboarding flow/);
});
await check('no script errors', async () => assert.deepEqual(page.errors, []));
await page.context().close();

await check('a mission transition updates the run view in place: same Agent World node, same scroll, same focus; a different run re-mounts', async () => {
  const other = missionRun({ id: 'run-m3', title: 'Other', meta: { missionId: 'mission-1' } });
  const p = await open({ width: 1280, height: 520 }, { runs: [missionRun(), other] });
  const gets = () => p.db.missionGets || 0;
  await p.evaluate(() => window.LocalAIRuns.show('run-m1'));
  await p.locator('#runDrawer .awc').waitFor({ state: 'visible', timeout: 6000 });
  await p.waitForFunction(() => document.querySelectorAll('#agentTimeline .mission-line').length >= 3, null, T);
  const before = await p.evaluate(() => { const d = document.getElementById('runDrawer'); d.scrollTop = 150; const b = document.querySelector('#agentTimeline .mission-line'); b.focus(); document.querySelector('#runDrawer .awc').__tag = 'same'; document.querySelector('#runDrawer .run-body').__tag = 'slot'; return { top: d.scrollTop, focus: document.activeElement === b }; });
  assert.ok(before.top > 0 && before.focus, 'set up scrolled and focused: ' + JSON.stringify(before));
  const g0 = gets();
  p.db.runs[0] = missionRun({ progress: 66, updatedAt: new Date(Date.now() + 5000).toISOString(), events: [{ at: new Date().toISOString(), status: 'running', detail: 'Mission progress: 2 of 3 steps' }] });
  await p.evaluate(() => window.LocalAIRuns.refresh());
  await p.waitForFunction(() => document.querySelector('#runDrawer [role="progressbar"]')?.getAttribute('aria-valuenow') === '66', null, T);
  const after = await p.evaluate(() => { const d = document.getElementById('runDrawer'); return { same: document.querySelector('#runDrawer .awc')?.__tag === 'same', slot: document.querySelector('#runDrawer .run-body')?.__tag === 'slot', top: d.scrollTop, focus: document.activeElement === document.querySelector('#agentTimeline .mission-line'), inside: !!document.querySelector('#runDrawer #agentWorldCityMount') }; });
  assert.deepEqual(after, { same: true, slot: true, top: before.top, focus: true, inside: true });
  assert.equal(gets(), g0, 'no mission refetch for a progress change');
  await p.evaluate(() => window.LocalAIRuns.show('run-m3'));
  await p.waitForFunction(() => document.querySelector('#runDrawerTitle')?.textContent.includes('Other'), null, T);
  assert.equal(await p.evaluate(() => document.querySelector('#runDrawer .run-body')?.__tag), undefined, 'another run mounts a fresh body');
  assert.equal(await p.locator('#runDrawer #agentWorldCityMount').count(), 1);
  await p.context().close();
});
await check('the pending view settles once: a second fail does not replace the first message', async () => {
  const p = await open({ width: 1280, height: 860 });
  await p.evaluate(() => { const h = window.LocalAIRuns.openPending({ kind: 'mission', title: 'x' }); h.fail('First problem'); h.fail('Second problem'); });
  await p.locator('#runDrawer [role="alert"]').waitFor(T);
  assert.match(await p.locator('#runDrawer').innerText(), /First problem/);
  assert.doesNotMatch(await p.locator('#runDrawer').innerText(), /Second problem/);
  await p.context().close();
});
await check('a mission run view asks for the one mission, not the whole list', async () => {
  const p = await open({ width: 1280, height: 860 }, { runs: [missionRun()] });
  let list = 0; p.on('request', q => { if (new URL(q.url()).pathname === '/api/agents/missions') list++; });
  const before = list;
  await p.evaluate(() => window.LocalAIRuns.show('run-m1'));
  await p.locator('#runDrawer .awc').waitFor({ state: 'visible', timeout: 6000 });
  await p.waitForFunction(() => document.querySelectorAll('#agentTimeline .mission-line').length >= 3, null, T);
  assert.ok((p.db.missionGets || 0) >= 1);
  assert.equal(list, before);
  await p.context().close();
});

await check('a mission run without a mission id shows the plain Output block', async () => {
  const p = await open({ width: 1280, height: 860 }, { runs: [missionRun({ id: 'run-m2', meta: {}, status: 'completed', output: { note: 'plain' } })] });
  await p.evaluate(() => window.LocalAIRuns.show('run-m2'));
  await p.locator('#runDrawer .run-output').waitFor(T);
  assert.equal(await p.locator('#runDrawer ' + awc).count(), 0);
  await p.context().close();
});

await check('a failed start fails the Starting… view and keeps the text on Home', async () => {
  const p = await open({ width: 1280, height: 860 });
  await p.route(u => u.pathname === '/api/agents/missions/start', r => r.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Pick at least one specialist' }) }));
  await p.locator('#commandInput').fill(GOAL); await p.locator('#commandGo').click();
  await p.locator('#runDrawer [role="alert"]').waitFor(T);
  assert.match(await p.locator('#runDrawer').innerText(), /Pick at least one specialist/);
  await p.keyboard.press('Escape');
  await p.waitForFunction(() => !document.querySelector('#runDrawerBackdrop.show'), null, T);
  assert.equal(await p.locator('#commandInput').inputValue(), GOAL);
  await p.context().close();
});

await check('390x844: the mission run view fits, passes axe color-contrast and target-size', async () => {
  const p = await open(phone, { runs: [missionRun()] });
  await p.evaluate(() => window.LocalAIRuns.show('run-m1'));
  await p.locator('#runDrawer .awc').waitFor({ state: 'visible', timeout: 6000 });
  await p.waitForTimeout(600);
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1 && document.querySelector('#runDrawer').scrollWidth <= document.querySelector('#runDrawer').clientWidth + 1), true, 'no sideways scroll');
  if (shotDir) await p.screenshot({ path: join(shotDir, 'task-7-mission-run-390.png') });
  await p.addScriptTag({ path: axePath });
  const v = await p.evaluate(() => window.axe.run('#runDrawer', { runOnly: { type: 'rule', values: ['color-contrast', 'target-size'] } }).then(r => r.violations.map(x => `${x.id}: ${x.nodes.map(n => n.html.slice(0, 120)).join(' | ')}`)));
  assert.deepEqual(v, []);
  await p.context().close();
});

await browser.close();
if (failures.length) { console.error('\n' + failures.length + ' failing:\n- ' + failures.join('\n- ')); process.exit(1); }
console.log('mission-run-ui: all passed');
