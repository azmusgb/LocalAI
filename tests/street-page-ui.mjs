import { chromium } from 'playwright';
import assert from 'node:assert/strict';

// The Agent World page as the street (app/public/street/page.js): #agents opens in street mode, the full street fills
// the stage, a tapped building is focused and its panel (#awPlace) shows in the rail (the sheet on a phone), and the URL
// says which building (#agents?place=<id>). Missions HQ hands over to mission mode. /api/world is stubbed per check.
const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const browser = await chromium.launch({ headless: true });
const failures = [];
async function check(name, fn) { try { await fn(); console.log('PASS', name); } catch (e) { failures.push(`${name}: ${e.message}`); console.error('FAIL', name, e.message); } }
const T = { timeout: 10000 };

const src = o => ({ running: [], waiting: 0, needsYou: [], failedUnseen: [], recent: [], ...o });
const LONG = '<img src=x onerror="window.__pwn=1">' + 'x'.repeat(264);
const WORLD = {
  schema: 1,
  models: { loaded: [{ name: 'qwen3:4b-instruct-32k', sizeMb: 3100, vramMb: 3100 }], queue: { active: 1, waiting: 2 }, busy: { total: 1, kinds: { chat: 1 } } },
  printer: { setUp: true, access: 'ok', state: 'idle', progress: null, minutesLeft: null, errorCode: null },
  sheets: { bridge: true, excel: true, inFlight: 0 },
  kiosk: { setUp: false, online: null, signIn: null, firmware: null },
  crews: null,
  street: {
    chat: src({ needsYou: [{ id: 'run-need', title: 'Pick a size for the poster', status: 'needs_you', startedAt: Date.now() - 120000 }], running: [{ id: 'run-long', title: LONG, status: 'running', startedAt: Date.now() - 60000 }] }),
    images: src({ running: [{ id: 'img-1', title: 'A red barn', status: 'running', startedAt: Date.now() - 30000 }] }),
    missions: src(), garage: src(), sheets: src(), clock: src()
  }
};

async function open(hash, { viewport = { width: 1440, height: 900 }, world = WORLD } = {}) {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
  await context.addInitScript(() => { try { localStorage.setItem('localai.firstRun.done', '1'); } catch {} });
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  await page.route('**/api/world', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(world) }));
  await page.goto(base + '/' + hash, { waitUntil: 'domcontentloaded' });
  return page;
}
const street = '#agents[data-aw-mode="street"] #awStreetMount .street:not([hidden])';
const place = page => page.locator('#awPlace');
// How far building id's chip is from the street box's centre, in px.
// Chips stand in street order, one per building standing in the world.
const offCentre = (page, id, world = WORLD) => page.evaluate(([id, w]) => {
  const s = document.querySelector('#awStreetMount .street'), ids = window.LocalAIStreet.defs().filter(d => !d.state(w).hidden).map(d => d.id);
  const c = s.querySelectorAll('.street-chip:not(.street-chip--stale)')[ids.indexOf(id)];
  const a = c.getBoundingClientRect(), b = s.getBoundingClientRect(); return Math.abs(a.left + a.width / 2 - (b.left + b.width / 2));
}, [id, world]);
// Focus scrolls smoothly: wait (up to 5 s) for the building to come to rest in the centre.
async function centred(page, id) { let o = Infinity; for (let i = 0; i < 50 && o >= 4; i++) { o = await offCentre(page, id); if (o >= 4) await page.waitForTimeout(100); } return o; }

await check('#agents opens in street mode: the full street shows, the old city does not', async () => {
  const page = await open('#status');
  await page.waitForFunction(() => !!window.LocalAIRouter);
  await page.evaluate(() => window.LocalAIRouter.open('agents'));
  await page.waitForSelector(street, T);
  assert.equal(await page.locator('#awStreetMount').isVisible(), true);
  assert.equal(await page.locator('#agentWorldCityMount').isVisible(), false, 'old city hidden');
  assert.equal(await page.locator('#awToStreet').isVisible(), false);
  assert.equal(await page.evaluate(() => window.LocalAIStreetPage.mode()), 'street');
  assert.equal(await page.locator('#awTitle').textContent(), 'Agent World');
  await page.waitForFunction(() => /busy|need you|All quiet/.test(document.getElementById('awStatus').textContent), null, T);
  assert.match(await page.locator('#awStatus').textContent(), /^(\d+ busy( · \d+ need you)?|\d+ need you|All quiet)$/);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

await check('390px: #agents stays #agents until the person picks a building (the first snap is not theirs)', async () => {
  const page = await open('#status', { viewport: { width: 390, height: 844 } });
  await page.waitForFunction(() => !!window.LocalAIRouter);
  await page.evaluate(() => window.LocalAIRouter.open('agents'));
  await page.waitForSelector(street, T);
  await page.waitForTimeout(1500);
  assert.equal(await page.evaluate(() => location.hash), '#agents');
  assert.equal(await page.locator('#awPlace h2').count(), 0, 'no building picked');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

await check('tapping the Foundry chip shows its panel and puts the building in the URL', async () => {
  const page = await open('#status');
  await page.waitForFunction(() => !!window.LocalAIRouter);
  await page.evaluate(() => window.LocalAIRouter.open('agents'));
  await page.waitForSelector(street, T);
  await page.locator('#awStreetMount .street-chip', { hasText: 'qwen3:4b-instruct-32k' }).first().click();
  await page.waitForFunction(() => location.hash === '#agents?place=foundry', null, T);
  await page.waitForSelector('#awPlace:not([hidden]) h2', T);
  assert.equal(await place(page).locator('h2').textContent(), 'Model Foundry');
  const link = place(page).locator('a', { hasText: 'Open Models' });
  assert.equal(await link.count(), 1);
  assert.equal(await link.getAttribute('href'), '#models');
  assert.ok(await centred(page, 'foundry') < 4, 'foundry centred');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

await check('#agents?place=garage cold: street mode focused on the garage, its panel shown', async () => {
  const page = await open('#agents?place=garage');
  await page.waitForSelector(street, T);
  await page.waitForSelector('#awPlace:not([hidden]) h2', T);
  assert.equal(await place(page).locator('h2').textContent(), 'Repair Garage');
  assert.equal(await page.evaluate(() => location.hash), '#agents?place=garage');
  assert.ok(await centred(page, 'garage') < 4, 'garage centred');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

await check('a needs-you row opens its run', async () => {
  const page = await open('#agents?place=chat');
  await page.waitForSelector('#awPlace:not([hidden]) h2', T);
  await page.evaluate(() => { window.__shown = []; window.LocalAIRuns = { ...window.LocalAIRuns, show: id => window.__shown.push(id) }; });
  const row = place(page).locator('button', { hasText: 'Pick a size for the poster' });
  assert.equal(await row.textContent(), 'Pick a size for the posterNeeds you');
  await row.click();
  assert.deepEqual(await page.evaluate(() => window.__shown), ['run-need']);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

await check('390px: a 300-character markup title in a row is text, cut, and never widens the page', async () => {
  const page = await open('#agents?place=chat', { viewport: { width: 390, height: 844 } });
  await page.waitForSelector('#awPlace:not([hidden]) h2', T);
  const r = await page.evaluate(() => ({
    text: document.getElementById('awPlace').textContent, imgs: document.querySelectorAll('#awPlace img').length, pwn: window.__pwn,
    sw: document.documentElement.scrollWidth, iw: innerWidth,
    rows: [...document.querySelectorAll('#awPlace .aw-place__row')].map(b => b.scrollWidth <= b.clientWidth + 1 || getComputedStyle(b.firstChild).textOverflow === 'ellipsis')
  }));
  assert.ok(r.text.includes('<img src=x onerror='), 'shown as text');
  assert.ok(r.text.includes('x…'), 'cut with …');
  assert.equal(r.imgs, 0);
  assert.equal(r.pwn, undefined);
  assert.ok(r.sw <= r.iw, `${r.sw} > ${r.iw}`);
  assert.ok(r.rows.every(Boolean), JSON.stringify(r.rows));
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

await check('390px: swiping one building moves the peek to the next one', async () => {
  const page = await open('#agents?place=chat', { viewport: { width: 390, height: 844 } });
  await page.waitForSelector(street, T);
  await page.waitForFunction(() => document.getElementById('awSheetStatus').textContent.startsWith('Chat Café: '), null, T);
  assert.equal(await page.locator('#awSheetStatus').isVisible(), true);
  await page.waitForTimeout(400);
  const box = await page.locator('#awStreetMount .street').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(box.width, 0);
  await page.waitForFunction(() => document.getElementById('awSheetStatus').textContent.startsWith('Image Studio: '), null, T);
  assert.equal(await page.locator('#awSheetStatus').textContent(), 'Image Studio: 1 running');
  await page.waitForFunction(() => location.hash === '#agents?place=images', null, T);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

await check("Missions HQ's chip goes to mission mode, and ← Street comes back", async () => {
  const page = await open('#agents?place=chat');
  await page.waitForSelector(street, T);
  await page.locator('#awStreetMount .street-chip', { hasText: 'Missions HQ' }).click();
  await page.waitForSelector('#agents[data-aw-mode="mission"]', T);
  assert.equal(await page.evaluate(() => location.hash), '#agents?mission=latest');
  assert.equal(await page.locator('#awToStreet').isVisible(), true);
  assert.equal(await page.locator('#awStreetMount').isVisible(), false);
  assert.equal(await page.evaluate(() => window.LocalAIStreetPage.mode()), 'mission');
  await page.locator('#awToStreet').click();
  await page.waitForSelector(street, T);
  assert.equal(await page.evaluate(() => location.hash), '#agents');
  assert.equal(await page.locator('#awToStreet').isVisible(), false);
  await page.evaluate(() => history.back());
  await page.waitForSelector('#agents[data-aw-mode="mission"]', T);
  await page.evaluate(() => history.back());
  await page.waitForSelector(street, T);
  assert.equal(await page.evaluate(() => location.hash), '#agents?place=chat');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

await check("the mission code's header words wait for mission mode and come back there", async () => {
  const page = await open('#agents?place=chat');
  await page.route(u => u.pathname === '/api/agents/missions', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [{ id: 'm-1', goal: 'Fix the phone screens', status: 'running', workers: [], results: [], timeline: [] }] }) }));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector(street, T);
  await page.waitForFunction(() => document.getElementById('awSheetStatus').textContent.startsWith('Chat Café: '), null, T);
  const words = await page.evaluate(() => document.getElementById('awStatus').textContent);
  await page.evaluate(() => { document.getElementById('awTitle').textContent = 'Something else'; document.getElementById('awStatus').innerHTML = '<b>Working</b> · 2 of 4'; });
  await page.waitForTimeout(50);
  assert.deepEqual(await page.evaluate(() => [document.getElementById('awTitle').textContent, document.getElementById('awStatus').textContent]), ['Agent World', words]);
  await page.evaluate(() => window.LocalAIStreetPage.toMission('latest'));
  await page.waitForSelector('#agents[data-aw-mode="mission"]', T);
  await page.waitForFunction(() => document.getElementById('awTitle').textContent === 'Fix the phone screens', null, T);
  const own = await page.evaluate(() => window.LocalAIAgentWords.statusSentence({ id: 'm-1', goal: 'Fix the phone screens', status: 'running', workers: [], results: [], timeline: [] }).text);
  await page.waitForFunction(t => document.getElementById('awStatus').textContent === t, own, T);
  assert.notEqual(own, words);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

// ---- Mission mode (Task 4): window.LocalAIMissionView, its triggers, and Back between the two modes ----
const at = s => new Date(Date.now() - s * 1000).toISOString();
const M_NEW = { id: 'm-new', goal: 'Tidy the phone screens', status: 'running', createdAt: at(60), updatedAt: at(5), workers: [{ id: 'router', name: 'Mission Router', state: 'running', dependsOn: [] }], results: [], timeline: [] };
const M_OLD = { id: 'm-old', goal: 'Write the spring newsletter', status: 'complete', createdAt: at(9000), updatedAt: at(8000), workers: [{ id: 'router', name: 'Mission Router', state: 'complete', dependsOn: [] }], results: [], timeline: [], answer: 'Done.' };
const json = body => r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
async function missions(page, items = [M_NEW, M_OLD]) {
  await page.route(u => u.pathname === '/api/agents/missions', json({ items }));
  await page.route(u => u.pathname === '/api/agents/mission', r => { const id = new URL(r.request().url()).searchParams.get('id'); const m = items.find(x => x.id === id); return m ? json({ mission: m })(r) : r.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not found"}' }); });
}
// Counts what the old city paints on its canvas: flat means it draws no frames.
const countCity = ctx => ctx.addInitScript(() => {
  window.__cityDraws = 0; const P = CanvasRenderingContext2D.prototype;
  for (const k of ['drawImage', 'fillRect']) { const f = P[k]; P[k] = function (...a) { if (this.canvas && this.canvas.id === 'awcCanvas') window.__cityDraws++; return f.apply(this, a); }; }
});
const mission = '#agents[data-aw-mode="mission"]';

await check('#agents?mission=latest cold: mission mode, the old city on screen, ← Street shown', async () => {
  const page = await open('#agents?mission=latest');
  await missions(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector(mission + ' #agentWorldCityMount #awcCanvas', T);
  assert.equal(await page.locator('#awToStreet').isVisible(), true);
  assert.equal(await page.locator('#awStreetMount').isVisible(), false);
  assert.equal(await page.evaluate(() => typeof window.LocalAIMissionView?.show), 'function');
  await page.waitForFunction(() => document.getElementById('agentMissionHeadline').textContent === 'Tidy the phone screens', null, T);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

await check('#agents?mission=<id> cold shows that mission, not the latest', async () => {
  const page = await open('#agents?mission=m-old');
  await missions(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector(mission, T);
  await page.waitForFunction(() => document.getElementById('agentMissionHeadline').textContent === 'Write the spring newsletter', null, T);
  await page.waitForTimeout(500);
  assert.equal(await page.locator('#agentMissionHeadline').textContent(), 'Write the spring newsletter');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

await check('← Street goes to the street; Back returns to mission mode, Back again to the page before', async () => {
  const page = await open('#status');
  await missions(page);
  await page.waitForFunction(() => !!window.LocalAIRouter);
  await page.evaluate(() => window.LocalAIRouter.go('#agents?mission=latest'));
  await page.waitForSelector(mission, T);
  await page.locator('#awToStreet').click();
  await page.waitForSelector(street, T);
  assert.equal(await page.evaluate(() => location.hash), '#agents');
  await page.evaluate(() => history.back());
  await page.waitForSelector(mission, T);
  assert.equal(await page.evaluate(() => location.hash), '#agents?mission=latest');
  assert.equal(await page.locator('#awToStreet').isVisible(), true);
  await page.evaluate(() => history.back());
  await page.waitForSelector('#status.active', T);
  assert.equal(await page.evaluate(() => location.hash), '#status');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

await check('back on the street from a mission, a bare #agents has no building focused', async () => {
  const page = await open('#agents?place=chat');
  await missions(page);
  await page.waitForSelector('#awPlace:not([hidden]) h2', T);
  await page.evaluate(() => window.LocalAIStreetPage.toMission('latest'));
  await page.waitForSelector(mission, T);
  await page.locator('#awToStreet').click();
  await page.waitForSelector(street, T);
  assert.equal(await page.evaluate(() => location.hash), '#agents');
  await page.waitForTimeout(300);
  assert.equal(await place(page).locator('h2').count(), 0, 'no building focused');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

await check('390px: switching modes lowers the sheet to its peek, both ways', async () => {
  const page = await open('#agents?place=chat', { viewport: { width: 390, height: 844 } });
  await missions(page);
  await page.waitForSelector(street, T);
  await page.locator('#awSheetHandle').click();
  await page.waitForFunction(() => document.getElementById('awSheet').dataset.snap === 'half', null, T);
  await place(page).locator('a, button').last().waitFor(T);
  await page.evaluate(() => window.LocalAIStreetPage.toMission('latest'));
  await page.waitForSelector(mission, T);
  await page.waitForFunction(() => document.getElementById('awSheet').dataset.snap === 'peek', null, T);
  await page.locator('#awSheetHandle').click();
  await page.waitForFunction(() => document.getElementById('awSheet').dataset.snap === 'half', null, T);
  await page.evaluate(() => window.LocalAIStreetPage.toStreet());
  await page.waitForSelector(street, T);
  await page.waitForFunction(() => document.getElementById('awSheet').dataset.snap === 'peek', null, T);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

await check('a mission running while on the street makes Missions HQ busy, and the page stays the street (15 s)', async () => {
  const world = { ...WORLD, street: { ...WORLD.street, missions: src({ running: [{ id: 'm-new', title: 'Tidy the phone screens', status: 'running', startedAt: Date.now() - 60000 }] }) } };
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  await context.addInitScript(() => { try { localStorage.setItem('localai.firstRun.done', '1'); } catch {} });
  const page = await context.newPage(); page.errors = []; page.on('pageerror', e => page.errors.push(e.message));
  await page.clock.install();
  await page.route('**/api/world', json(world));
  await missions(page);
  await page.goto(base + '/#agents?place=chat', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(street, T);
  await page.locator('#awStreetMount .street-chip.street-chip--busy', { hasText: 'Missions HQ' }).waitFor(T);
  await page.clock.fastForward(15000);
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.LocalAIStreetPage.mode()), 'street');
  assert.equal(await page.evaluate(() => location.hash), '#agents?place=chat');
  assert.equal(await page.locator('#agentWorldCityMount').isVisible(), false);
  assert.deepEqual(page.errors, []);
  await context.close();
});

await check('starting a mission from the start sheet lands in mission mode on it; Back returns to the street', async () => {
  const page = await open('#agents?place=chat');
  await missions(page, [M_OLD]);
  await page.route(u => u.pathname === '/api/agents/dispatch', json({ routing: { mode: 'auto', workers: [] } }));
  await page.route(u => u.pathname === '/api/agents/missions/start', json({ mission: M_NEW }));
  await page.route(u => u.pathname === '/api/agents/mission', json({ mission: M_NEW }));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector(street, T);
  await page.locator('#awMoreBtn').click();
  await page.locator('[data-aw-menu="new"]').click();
  await page.locator('#agentGoal').fill('Tidy the phone screens');
  await page.locator('#missionRunBtn').click();
  await page.waitForSelector(mission, T);
  await page.waitForFunction(() => location.hash === '#agents?mission=m-new', null, T);
  await page.waitForFunction(() => document.getElementById('agentMissionHeadline').textContent === 'Tidy the phone screens', null, T);
  assert.equal(await page.locator('#awcCanvas').isVisible(), true);
  await page.evaluate(() => history.back());
  await page.waitForSelector(street, T);
  assert.equal(await page.evaluate(() => location.hash), '#agents?place=chat');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

await check('Watch mode from ⋯ on the street goes to mission mode', async () => {
  const page = await open('#agents?place=chat');
  await missions(page);
  await page.waitForSelector(street, T);
  await page.locator('#awMoreBtn').click();
  await page.locator('[data-aw-menu="watch"]').click();
  await page.waitForSelector(mission, T);
  assert.equal(await page.evaluate(() => location.hash), '#agents?mission=latest');
  assert.equal(await page.locator('#awcCanvas').isVisible(), true);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

await check("Work › Missions' Open Agent World opens the latest mission", async () => {
  const page = await open('#work?kind=missions');
  await missions(page);
  await page.locator('#workOpenAgentWorld').click();
  await page.waitForSelector(mission, T);
  assert.equal(await page.evaluate(() => location.hash), '#agents?mission=latest');
  await page.evaluate(() => history.back());
  await page.waitForSelector('#work.active', T);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

await check('on the street the old city draws nothing; in mission mode it does', async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  await context.addInitScript(() => { try { localStorage.setItem('localai.firstRun.done', '1'); } catch {} });
  await countCity(context);
  const page = await context.newPage(); page.errors = []; page.on('pageerror', e => page.errors.push(e.message));
  await page.route('**/api/world', json(WORLD));
  await missions(page);
  await page.goto(base + '/#agents?mission=latest', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(mission + ' #awcCanvas', T);
  const a = await page.evaluate(() => window.__cityDraws); await page.waitForTimeout(600);
  assert.ok(await page.evaluate(() => window.__cityDraws) > a, 'the city draws in mission mode');
  await page.locator('#awToStreet').click();
  await page.waitForSelector(street, T);
  await page.waitForTimeout(300);
  const b = await page.evaluate(() => window.__cityDraws); await page.waitForTimeout(1500);
  assert.equal(await page.evaluate(() => window.__cityDraws), b, 'flat on the street');
  assert.equal(await page.evaluate(() => window.LocalAIMissionStream?.isOpen()), false, 'no mission stream on the street');
  assert.deepEqual(page.errors, []);
  await context.close();
});

await check('Watch mode (full screen) then Back: the street, the old city asleep, one /api/world poller; Watch replaced the entry', async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  await context.addInitScript(() => { try { localStorage.setItem('localai.firstRun.done', '1'); } catch {} });
  await countCity(context);
  const page = await context.newPage(); page.errors = []; page.on('pageerror', e => page.errors.push(e.message));
  await page.clock.install();
  let worlds = 0;
  await page.route('**/api/world', r => { worlds++; return json(WORLD)(r); });
  await missions(page);
  await page.goto(base + '/#agents?place=chat', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(street, T);
  await page.evaluate(() => window.LocalAIStreetPage.toMission('latest'));
  await page.waitForSelector(mission + ' #awcCanvas', T);
  const len = await page.evaluate(() => history.length);
  await page.locator('#awMoreBtn').click();
  await page.locator('[data-aw-menu="watch"]').click();
  await page.waitForFunction(() => window.LocalAIAgentWorldWatch?.active() && !!document.querySelector('.awc-v3.is-expanded'), null, T);
  assert.equal(await page.evaluate(() => history.length), len, 'Watch replaced the mission entry');
  assert.equal(await page.evaluate(() => location.hash), '#agents?mission=latest');
  await page.evaluate(() => history.back());
  await page.waitForSelector(street, T);
  assert.equal(await page.evaluate(() => location.hash), '#agents?place=chat');
  assert.equal(await page.evaluate(() => window.LocalAIAgentWorldWatch.active()), false, 'watch mode ended');
  assert.equal(await page.locator('.awc-v3.is-expanded').count(), 0, 'full screen ended');
  assert.equal(await page.locator('#awcCanvas').isVisible(), false);
  await page.waitForTimeout(300);
  const b = await page.evaluate(() => window.__cityDraws); await page.waitForTimeout(1500);
  assert.equal(await page.evaluate(() => window.__cityDraws), b, 'the old city draws nothing');
  const w = worlds; await page.clock.runFor(30000); await page.waitForTimeout(300);
  assert.ok(worlds - w <= 4, `${worlds - w} /api/world requests in 30 s: one poller makes 3`);
  assert.deepEqual(page.errors, []);
  await context.close();
});

await check('Replay from ⋯ in mission mode replaces the entry: Back goes straight to the street', async () => {
  const done = { ...M_OLD, timeline: [{ at: at(8990), type: 'mission-start', workers: M_OLD.workers }, { at: at(8000), type: 'mission-complete', status: 'complete', workers: M_OLD.workers }] };
  const page = await open('#agents?place=chat');
  await missions(page, [done]);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector(street, T);
  await page.evaluate(() => window.LocalAIStreetPage.toMission('latest'));
  await page.waitForSelector(mission, T);
  await page.waitForFunction(() => document.getElementById('agentMissionHeadline').textContent === 'Write the spring newsletter', null, T);
  const len = await page.evaluate(() => history.length);
  await page.locator('#awMoreBtn').click();
  await page.locator('[data-aw-menu="replay"]').click();
  await page.waitForFunction(() => location.hash === '#agents?mission=m-old', null, T);
  assert.equal(await page.evaluate(() => history.length), len, 'replaced, not pushed');
  await page.evaluate(() => history.back());
  await page.waitForSelector(street, T);
  assert.equal(await page.evaluate(() => location.hash), '#agents?place=chat');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

await check('390px: mission mode cold, ← Street in the sheet’s peek goes to the street', async () => {
  const page = await open('#agents?mission=latest', { viewport: { width: 390, height: 844 } });
  await missions(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector(mission, T);
  const b = page.locator('#awPeekStreet');
  await b.waitFor({ state: 'visible', ...T });
  const box = await b.boundingBox();
  assert.ok(box && box.y >= 0 && box.y + box.height <= 844 && box.x >= 0 && box.x + box.width <= 390, JSON.stringify(box));
  await b.click();
  await page.waitForSelector(street, T);
  assert.equal(await page.evaluate(() => location.hash), '#agents');
  assert.equal(await b.isVisible(), false);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

await browser.close();
if (failures.length) { console.error(`\n${failures.length} failed:\n` + failures.join('\n')); process.exit(1); }
console.log('\nstreet-page: all passed');
