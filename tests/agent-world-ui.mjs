import { chromium, devices } from 'playwright';
import assert from 'node:assert/strict';

// Agent World lives on the Missions page, which sub-project 2 hid from the menus. Work › Missions links to it.
// Phone: the city fills the screen between the header and the tab bar, everything else is in a bottom sheet, and the
// page itself never scrolls (design: docs/superpowers/specs/2026-10-17-agent-world-design.md).
const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const browser = await chromium.launch({ headless: true });
const failures = [];
async function check(name, fn) { try { await fn(); console.log('PASS', name); } catch (e) { failures.push(`${name}: ${e.message}`); console.error('FAIL', name, e.message); } }

const now = Date.now(), at = s => new Date(now - s * 1000).toISOString();
const MISSION = {
  id: 'mission-ui-1', goal: 'Improve the look and polish of Agent World', status: 'running', createdAt: at(300), updatedAt: at(5),
  workers: [
    { id: 'router', name: 'Mission Router', state: 'complete', dependsOn: [] },
    { id: 'ux_analyst', name: 'UX Analyst', state: 'running', phase: 'inference', dependsOn: ['router'], model: 'qwen3:4b-instruct-32k' },
    { id: 'synthesis', name: 'Coordinator', state: 'pending', dependsOn: ['ux_analyst'] }
  ],
  results: [], timeline: []
};
async function seeded(context) {
  await context.addInitScript(() => { try { localStorage.setItem('localai.firstRun.done', '1'); } catch {} });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route(u => u.pathname === '/api/agents/missions', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: [MISSION] }) }));
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.showView === 'function');
  await page.evaluate(() => window.showView('agents'));
  await page.waitForSelector('#agents.active #awcCanvas');
  await page.waitForFunction(() => document.querySelector('#awcRoster [data-awc-roster]'));
  return { page, errors };
}
// The canvas has a real backing store (CSS size x device pixels, capped at 2) and something is drawn on it.
const canvasState = page => page.evaluate(() => {
  const c = document.getElementById('awcCanvas'), r = c.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
  const d = c.getContext('2d').getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
  return { w: r.width, h: r.height, top: r.top, bw: c.width, bh: c.height, want: [Math.round(r.width * dpr), Math.round(r.height * dpr)], painted: d[3] > 0 };
});

// iPhone 14 and SE (WebKit's device settings on Chromium: size, scale factor, touch).
for (const name of ['iPhone 14', 'iPhone SE']) {
  const { defaultBrowserType, ...device } = devices[name];
  const context = await browser.newContext({ ...device, serviceWorkers: 'block' });
  const { page, errors } = await seeded(context);
  const vw = device.viewport.width, vh = device.viewport.height;
  await check(`${name}: the city renders on screen without scrolling, at the device's pixel density`, async () => {
    await page.waitForFunction(() => { const c = document.getElementById('awcCanvas'); return c.width > 0 && c.getContext('2d').getImageData(c.width >> 1, c.height >> 1, 1, 1).data[3] > 0; }, null, { timeout: 5000 });
    const s = await canvasState(page);
    assert.ok(s.painted, 'the canvas is painted');
    assert.ok(s.w >= vw - 1, `the city is full width (${s.w} of ${vw})`);
    assert.ok(s.h >= vh * 0.5, `the city fills the screen (${Math.round(s.h)} of ${vh} tall)`);
    assert.ok(s.top < 140, `the city starts under the header (top ${Math.round(s.top)})`);
    assert.deepEqual([s.bw, s.bh], s.want, 'canvas backing store matches CSS size x device pixels');
  });
  await check(`${name}: the page is one screen: no page scroll, nothing sideways`, async () => {
    const d = await page.evaluate(() => ({ sh: document.scrollingElement.scrollHeight, ih: innerHeight, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    assert.ok(d.sh <= d.ih + 1, `page scrolls: ${d.sh} > ${d.ih}`);
    assert.ok(d.sw <= d.cw + 1, `page scrolls sideways: ${d.sw} > ${d.cw}`);
  });
  await check(`${name}: the sheet peeks with the status sentence and crew, above the tab bar`, async () => {
    const sheet = page.locator('#awSheet');
    await sheet.waitFor({ state: 'visible' });
    assert.equal(await sheet.getAttribute('data-snap'), 'peek');
    assert.match(await page.locator('#awSheetStatus').innerText(), /Working · 1 of 3 done · UX Analyst is reviewing the screens/);
    assert.equal(await page.locator('#awSheetAvatars [data-worker]').count(), 3);
    const nav = await page.locator('#uxMobileNav').boundingBox(), handle = await page.locator('#awSheetHandle').boundingBox();
    assert.ok(handle && nav && handle.y + handle.height <= nav.y, 'the handle is above the tab bar');
    const peek = await page.evaluate(() => { const s = document.getElementById('awSheet').getBoundingClientRect(), n = document.getElementById('uxMobileNav').getBoundingClientRect(); return n.top - s.top; });
    assert.ok(peek >= 96 && peek <= 140, `peek height ${Math.round(peek)} px`);
  });
  await check(`${name}: the keyboard hint is not shown on a touch screen`, async () => {
    assert.equal(await page.locator('.awc__hint').isVisible(), false);
  });
  await check(`${name}: tapping the handle raises the sheet; Back lowers it and stays on the page`, async () => {
    await page.locator('#awSheetHandle').click();
    await page.waitForFunction(() => document.getElementById('awSheet').dataset.snap === 'half');
    assert.equal(await page.locator('#awSheetHandle').getAttribute('aria-expanded'), 'true');
    await page.evaluate(() => history.back());
    await page.waitForFunction(() => document.getElementById('awSheet').dataset.snap === 'peek');
    assert.equal(await page.locator('#agents').evaluate(el => el.classList.contains('active')), true);
  });
  await check(`${name}: the crew are rows: avatar, name, role in words, state`, async () => {
    await page.locator('#awSheetHandle').click();
    await page.waitForFunction(() => document.getElementById('awSheet').dataset.snap === 'half');
    const rows = page.locator('#awcRoster [data-awc-roster]');
    assert.equal(await rows.count(), 3);
    const boxes = await rows.evaluateAll(r => r.map(x => x.getBoundingClientRect()).map(b => ({ x: b.x, y: b.y, w: b.width })));
    assert.ok(boxes.every(b => Math.abs(b.x - boxes[0].x) < 2 && b.w > 250), 'rows stack vertically at full width');
    assert.ok(boxes[1].y > boxes[0].y && boxes[2].y > boxes[1].y);
    const ux = await rows.nth(1).innerText();
    assert.match(ux, /UX Analyst/); assert.match(ux, /Reviews screens for usability/); assert.match(ux, /Working/); assert.match(ux, /Reviewing the screens/);
    assert.match(await rows.nth(0).innerText(), /Team lead/);
    await page.evaluate(() => history.back());
    await page.waitForFunction(() => document.getElementById('awSheet').dataset.snap === 'peek');
  });
  await check(`${name}: dragging the handle up snaps the sheet to full, down to peek`, async () => {
    const h = await page.locator('#awSheetHandle').boundingBox(), cx = h.x + h.width / 2, cy = h.y + h.height / 2;
    const drag = async (dy) => {
      await page.locator('#awSheetHandle').dispatchEvent('pointerdown', { pointerId: 7, pointerType: 'touch', clientX: cx, clientY: cy, isPrimary: true });
      for (let i = 1; i <= 6; i++) await page.locator('#awSheetHandle').dispatchEvent('pointermove', { pointerId: 7, pointerType: 'touch', clientX: cx, clientY: cy + dy * i / 6, isPrimary: true });
      await page.locator('#awSheetHandle').dispatchEvent('pointerup', { pointerId: 7, pointerType: 'touch', clientX: cx, clientY: cy + dy, isPrimary: true });
    };
    await drag(-vh);
    await page.waitForFunction(() => document.getElementById('awSheet').dataset.snap === 'full');
    const top = await page.locator('#awSheet').evaluate(el => el.getBoundingClientRect().top);
    assert.ok(top >= 0, 'the sheet stays on screen');
    await page.evaluate(() => history.back());
    await page.waitForFunction(() => document.getElementById('awSheet').dataset.snap === 'peek');
  });
  await check(`${name}: drag pans and pinch zooms the city`, async () => {
    const c = page.locator('#awcCanvas'), b = await c.boundingBox(), cx = b.x + b.width / 2, cy = b.y + b.height / 3;
    const before = await page.evaluate(() => window.LocalAIAgentWorld.camera());
    await c.dispatchEvent('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: cx, clientY: cy, isPrimary: true });
    await c.dispatchEvent('pointermove', { pointerId: 1, pointerType: 'touch', clientX: cx + 80, clientY: cy, isPrimary: true });
    await c.dispatchEvent('pointerup', { pointerId: 1, pointerType: 'touch', clientX: cx + 80, clientY: cy, isPrimary: true });
    const panned = await page.evaluate(() => window.LocalAIAgentWorld.camera());
    assert.notEqual(panned.panX, before.panX, 'drag pans');
    await c.dispatchEvent('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: cx - 30, clientY: cy });
    await c.dispatchEvent('pointerdown', { pointerId: 2, pointerType: 'touch', clientX: cx + 30, clientY: cy });
    await c.dispatchEvent('pointermove', { pointerId: 2, pointerType: 'touch', clientX: cx + 100, clientY: cy });
    await c.dispatchEvent('pointerup', { pointerId: 2, pointerType: 'touch', clientX: cx + 100, clientY: cy });
    await c.dispatchEvent('pointerup', { pointerId: 1, pointerType: 'touch', clientX: cx - 30, clientY: cy });
    assert.ok((await page.evaluate(() => window.LocalAIAgentWorld.camera())).zoom > panned.zoom, 'pinch zooms in');
  });
  await check(`${name}: no script errors`, async () => assert.deepEqual(errors, []));
  await context.close();
}

for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
  const page = await browser.newPage({ serviceWorkers: 'block', viewport, isMobile: viewport.width < 500, hasTouch: viewport.width < 500 });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/#work', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#work.active');
  await check(`${viewport.width}px: the Agent World link shows only on Work › Missions`, async () => {
    await page.locator('[data-work-kind="all"]').click();
    assert.equal(await page.locator('#workAgentWorld').isVisible(), false);
    await page.locator('[data-work-kind="missions"]').click();
    await page.locator('#workAgentWorld').waitFor({ state: 'visible' });
  });
  await check(`${viewport.width}px: Open Agent World opens the Missions page with the world`, async () => {
    const before = await page.evaluate(() => history.length);
    await page.locator('#workOpenAgentWorld').click();
    await page.waitForSelector('#agents.active');
    await page.waitForSelector('#agentWorldCityMount .awc');
    assert.equal(await page.evaluate(() => history.length), before + 1); // pushed: Back returns to Work
    await page.evaluate(() => history.back());
    await page.waitForSelector('#work.active');
  });
  await check(`${viewport.width}px: no script errors`, async () => assert.deepEqual(errors, []));
  await page.close();
}

// Desktop at 1x and 2x: the city is painted at the screen's pixel density, so the pixel art stays crisp.
for (const deviceScaleFactor of [1, 2]) {
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 }, deviceScaleFactor });
  const { page, errors } = await seeded(context);
  await check(`1440px @${deviceScaleFactor}x: the city is painted at full resolution`, async () => {
    await page.waitForFunction(() => { const c = document.getElementById('awcCanvas'); return c.getContext('2d').getImageData(c.width >> 1, c.height >> 1, 1, 1).data[3] > 0; }, null, { timeout: 5000 });
    const s = await canvasState(page);
    assert.ok(s.painted);
    assert.deepEqual([s.bw, s.bh], s.want);
    assert.ok(s.w >= 640, `the city is at least 640 px wide (${s.w})`);
  });
  await check(`1440px @${deviceScaleFactor}x: no script errors`, async () => assert.deepEqual(errors, []));
  await context.close();
}

// Story-first layout (design PR 2): header sentence and one action, crew + worker card + story, history in Work.
const T0 = Date.now() - 400e3, t = s => new Date(T0 + s * 1000).toISOString();
const snapW = (u, c, ux = {}) => [{ id: 'router', name: 'Mission Router', state: 'complete', dependsOn: [] }, { id: 'ux_analyst', name: 'UX Analyst', state: u, dependsOn: ['router'], model: 'qwen3:4b-instruct-32k', routingMeta: { capabilityScore: 0, modelScore: 38 }, ...ux }, { id: 'synthesis', name: 'Coordinator', state: c, dependsOn: ['ux_analyst'] }];
const FAILED = {
  id: 'mission-ui-failed', goal: 'Improve the look and polish of Agent World', status: 'needs_attention', error: 'Mission stopped after specialist failure', createdAt: t(0), updatedAt: t(301),
  workers: snapW('error', 'blocked', { errorCode: 'MODEL_CONNECTION_ERROR' }),
  results: [{ agentId: 'ux_analyst', agentName: 'UX Analyst', status: 'error', error: 'fetch failed', errorCode: 'MODEL_CONNECTION_ERROR' }],
  timeline: [{ at: t(0), type: 'mission-start', workers: snapW('pending', 'pending') }, { at: t(1), type: 'dispatch', workers: snapW('running', 'pending') }, { at: t(300), type: 'worker-result', workers: snapW('error', 'pending', { errorCode: 'MODEL_CONNECTION_ERROR' }) }, { at: t(301), type: 'mission-attention', status: 'needs_attention', workers: snapW('error', 'blocked', { errorCode: 'MODEL_CONNECTION_ERROR' }) }]
};
const DONE = { ...FAILED, id: 'mission-ui-done', status: 'complete', error: '', answer: 'The summary of what the team found.', finishedAt: t(240), workers: snapW('complete', 'complete'), results: [{ agentId: 'ux_analyst', agentName: 'UX Analyst', status: 'complete', answer: 'Three things to fix.' }], timeline: [] };
async function withMission(contextOpts, mission) {
  const context = await browser.newContext({ serviceWorkers: 'block', ...contextOpts });
  await context.addInitScript(() => { try { localStorage.setItem('localai.firstRun.done', '1'); } catch {} });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route(u => u.pathname === '/api/agents/missions', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: [mission] }) }));
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.showView === 'function');
  await page.evaluate(() => window.showView('agents'));
  await page.waitForFunction(g => document.getElementById('awTitle')?.textContent === g, mission.goal);
  return { context, page, errors };
}
{
  const { context, page, errors } = await withMission({ viewport: { width: 1440, height: 900 } }, FAILED);
  await check('1440px: the header says what went wrong and offers one action', async () => {
    assert.match(await page.locator('#awStatus').innerText(), /^Needs you · 1 of 3 done · UX Analyst stopped: the model didn’t answer$/);
    assert.equal(await page.locator('#awPrimary').innerText(), 'Try again');
    assert.equal(await page.locator('#agents .pill').count(), 0, 'the Mission-first pill is gone');
  });
  await check('1440px: the city fills the main area; the rail beside it is 360 px', async () => {
    const city = await page.locator('.aw-city').boundingBox(), rail = await page.locator('#awSheet').boundingBox();
    assert.ok(Math.abs(rail.width - 360) < 2, `rail ${rail.width}`);
    assert.ok(rail.x >= city.x + city.width, 'rail is to the right of the city');
    assert.ok((await page.locator('.awc__mapWrap').boundingBox()).height >= 520, 'the city is at least 520 px tall');
  });
  await check('1440px: the story tells the mission in sentences, newest first', async () => {
    const items = await page.locator('#agentTimeline li li').allInnerTexts();
    assert.match(items[0], /The mission stopped and needs you/);
    assert.ok(items.some(x => /UX Analyst stopped: the model didn’t answer/.test(x)));
    assert.match(items.at(-1), /The team lead picked the team: UX Analyst and Coordinator/);
    assert.equal(await page.getByText('Mission timeline').count(), 0);
  });
  await check('1440px: history lives in Work: one link, no list', async () => {
    assert.equal(await page.locator('#agentMissionHistory a').getAttribute('href'), '#work?kind=missions');
    assert.equal(await page.locator('#agentHistorySearch').count(), 0);
  });
  await check('1440px: a crew row opens the worker card: why it stopped and Try again; developer details hidden', async () => {
    await page.locator('#awcRoster [data-awc-roster="ux_analyst"]').click();
    const card = page.locator('#agentInspector');
    await card.waitFor({ state: 'visible' });
    const text = await card.innerText();
    assert.match(text, /UX Analyst/); assert.match(text, /Reviews screens for usability/); assert.match(text, /Stopped: the model didn’t answer/);
    await card.locator('#agentRetryBtn').waitFor({ state: 'visible' });
    assert.equal(await card.locator('[data-dev-only]').isVisible(), false, 'model and scores only with developer tools');
    await page.locator('#awWorkerClose').click();
    await card.waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.awcRoster), 'ux_analyst', 'focus returns to the crew row');
  });
  await check('1440px: Try again starts the same goal again', async () => {
    const bodies = [];
    await page.route(u => u.pathname === '/api/agents/missions/start', r => { bodies.push(r.request().postDataJSON()); r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"stubbed"}' }); });
    await page.route(u => u.pathname === '/api/agents/dispatch', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ routing: { mode: 'auto', workers: [] } }) }));
    await page.locator('#awPrimary').click();
    await page.waitForFunction(() => true); for (let i = 0; i < 50 && !bodies.length; i++) await page.waitForTimeout(100);
    assert.equal(bodies[0]?.goal, FAILED.goal);
  });
  await check('1440px: the ⋯ menu opens, moves with arrows, closes with Escape back on its button', async () => {
    await page.locator('#awMoreBtn').click();
    const menu = page.locator('#awMenu');
    await menu.waitFor({ state: 'visible' });
    assert.deepEqual(await menu.locator('[data-aw-menu]:visible').allInnerTexts(), ['Start a new mission', 'Watch the replay', 'Open in Work', 'Copy result', 'All missions']);
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.awMenu), 'replay');
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => document.activeElement.id), 'awMoreBtn');
    await page.locator('#awMoreBtn').click();
    await menu.locator('[data-aw-menu="all"]').click();
    await page.waitForSelector('#work.active');
  });
  await check('1440px: no script errors', async () => assert.deepEqual(errors, []));
  await context.close();
}
{
  const { context, page, errors } = await withMission({ viewport: { width: 1440, height: 900 } }, DONE);
  await check('1440px: a finished mission says how long it took and offers the result', async () => {
    assert.match(await page.locator('#awStatus').innerText(), /^Done in 4 min · 3 workers$/);
    assert.equal(await page.locator('#awPrimary').innerText(), 'See the result');
  });
  await check('1440px: no script errors (done)', async () => assert.deepEqual(errors, []));
  await context.close();
}
{
  const { context, page, errors } = await withMission({ viewport: { width: 900, height: 1100 } }, FAILED);
  await check('900px: the rail is under the city, crew beside the story', async () => {
    const city = await page.locator('.aw-city').boundingBox(), crew = await page.locator('.aw-crew').boundingBox(), story = await page.locator('.aw-story-box').boundingBox();
    assert.ok(crew.y >= city.y + city.height, 'crew under the city');
    assert.ok(story.x > crew.x + crew.width - 2 && Math.abs(story.y - crew.y) < 4, 'story beside the crew');
  });
  await check('900px: no script errors', async () => assert.deepEqual(errors, []));
  await context.close();
}
{
  const { defaultBrowserType, ...device } = devices['iPhone 14'];
  const { context, page, errors } = await withMission(device, FAILED);
  await check('iPhone 14: the peek offers Try again; a crew row raises the sheet to the worker card', async () => {
    assert.equal(await page.locator('#awPeekAction').innerText(), 'Try again');
    await page.locator('#awSheetHandle').click();
    await page.waitForFunction(() => document.getElementById('awSheet').dataset.snap === 'half');
    await page.locator('#awcRoster [data-awc-roster="ux_analyst"]').click();
    await page.locator('#agentInspector').waitFor({ state: 'visible' });
  });
  await check('iPhone 14: ⋯ is in the header and opens the menu', async () => {
    await page.locator('#uxHeaderAction').click();
    await page.locator('#awMenu').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
  });
  await check('iPhone 14: no script errors (story)', async () => assert.deepEqual(errors, []));
  await context.close();
}

// Start a mission (design PR 3): one sheet, the team in words as you type, Advanced only with developer tools; the
// empty city invites a goal and offers a demo.
async function emptyPage(contextOpts) {
  const context = await browser.newContext({ serviceWorkers: 'block', ...contextOpts });
  await context.addInitScript(() => { try { localStorage.setItem('localai.firstRun.done', '1'); } catch {} });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const sent = [];
  await page.route(u => u.pathname === '/api/agents/missions', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: [] }) }));
  await page.route(u => u.pathname === '/api/agents/dispatch', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ routing: { mode: 'auto', workers: [{ agentId: 'ux_analyst', name: 'UX Analyst' }] } }) }));
  await page.route(u => u.pathname === '/api/agents/missions/start', r => { sent.push(r.request().postDataJSON()); r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"stubbed"}' }); });
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.showView === 'function');
  await page.evaluate(() => window.showView('agents'));
  await page.waitForSelector('#agents.active #awcCanvas');
  return { context, page, errors, sent };
}
for (const [label, opts] of [['1440px', { viewport: { width: 1440, height: 900 } }], ['iPhone 14', (({ defaultBrowserType, ...d }) => d)(devices['iPhone 14'])]]) {
  const { context, page, errors, sent } = await emptyPage(opts);
  await check(`${label}: with no mission the city invites a goal and offers a demo`, async () => {
    const empty = page.locator('#awEmpty');
    await empty.waitFor({ state: 'visible' });
    assert.match(await empty.innerText(), /Give your team a goal/);
    await page.locator('#awEmptyDemo').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.agent-compose').isVisible(), false, 'no form on the page itself');
  });
  await check(`${label}: Start a mission opens the sheet; typing shows the team in words`, async () => {
    await page.locator('#awEmptyStart').click();
    const sheet = page.locator('#awStart');
    await sheet.waitFor({ state: 'visible' });
    assert.match(await sheet.innerText(), /What should the team do\?/);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'agentGoal');
    await page.locator('#agentGoal').fill('Check the phone screens for problems');
    await page.locator('#awTeam').getByText('A UX Analyst will review screens for usability; a Coordinator will put everyone’s findings together.').waitFor();
    assert.equal(await page.locator('#awTeam img').count(), 2, 'a portrait per worker');
    assert.equal(await sheet.locator('#agentAdvancedPanel, #agentAdvancedToggle').first().isVisible(), false, 'Advanced only with developer tools');
    assert.match(await sheet.innerText(), /Let the team search the web/);
  });
  await check(`${label}: Start sends the goal and the choices`, async () => {
    await page.locator('#agentWebSearch').check();
    await page.locator('#missionRunBtn').click();
    for (let i = 0; i < 50 && !sent.length; i++) await page.waitForTimeout(100);
    assert.equal(sent[0]?.goal, 'Check the phone screens for problems');
    assert.equal(sent[0]?.webSearch, true);
    await page.locator('#agentInlineNotice').waitFor({ state: 'visible' }); // the stubbed failure is said in the sheet
  });
  await check(`${label}: Escape closes the sheet and focus returns`, async () => {
    await page.keyboard.press('Escape');
    await page.locator('#awStart').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => document.activeElement.id), 'awEmptyStart');
  });
  await check(`${label}: Try a demo mission runs the city and hides the invitation`, async () => {
    await page.locator('#awEmptyDemo').click();
    await page.locator('#awEmpty').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.querySelectorAll('#awcRoster [data-awc-roster]').length >= 3);
  });
  await check(`${label}: no script errors (start)`, async () => assert.deepEqual(errors, []));
  await context.close();
}
// The More menu's "Try a demo mission" starts the demo without the card's button; the invitation must still go.
{
  const { context, page, errors } = await emptyPage({ viewport: { width: 1440, height: 900 } });
  await check('1440px: a demo started from the menu hides the invitation', async () => {
    await page.locator('#awEmpty').waitFor({ state: 'visible' });
    await page.evaluate(() => window.LocalAIAgentWorld.demo());
    await page.locator('#awEmpty').waitFor({ state: 'hidden' });
    await page.waitForTimeout(2500); // a later status refresh must not bring it back while the demo runs
    assert.equal(await page.locator('#awEmpty').isVisible(), false);
    assert.deepEqual(errors, []);
  });
  await context.close();
}
// A goal that changes Local AI itself: the start sheet offers Claude Code (Hand to Claude) and still starts the mission.
for (const [label, opts] of [['1440px', { viewport: { width: 1440, height: 900 } }], ['iPhone 14', (({ defaultBrowserType, ...d }) => d)(devices['iPhone 14'])]]) {
  const { context, page, errors, sent } = await emptyPage(opts);
  const handed = [];
  await page.route(u => u.pathname === '/api/improve/handoff', r => { handed.push(r.request().postDataJSON()); r.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ item: { id: 'idea-1' } }) }); });
  const SELF = 'Improve look feel and polish of agent world';
  await check(`${label}: a plain goal gets no suggestion; a goal to change Local AI itself does`, async () => {
    await page.locator('#awEmptyStart').click();
    await page.locator('#awStart').waitFor({ state: 'visible' });
    await page.locator('#agentGoal').fill('plan the vegetable garden');
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#awSelfChange').isVisible(), false, 'no suggestion for a plain mission');
    await page.locator('#agentGoal').fill(SELF);
    const box = page.locator('#awSelfChange');
    await box.waitFor({ state: 'visible' });
    assert.match(await box.innerText(), /This is a change to Local AI itself\. Claude Code reviews the code and opens a tested pull request\./);
    await box.getByRole('button', { name: 'Start a mission anyway' }).waitFor({ state: 'visible' });
    await page.locator('#agentGoal').fill('plan the vegetable garden');
    await box.waitFor({ state: 'hidden' });
  });
  await check(`${label}: Hand to Claude posts the goal from Agent World, says where it went and closes the sheet`, async () => {
    await page.locator('#agentGoal').fill(SELF);
    await page.locator('#awSelfChange').getByRole('button', { name: 'Hand to Claude' }).click();
    await page.locator('#awStart').waitFor({ state: 'hidden' });
    assert.deepEqual(handed, [{ text: SELF, from: 'agentWorld' }]);
    assert.equal(sent.length, 0, 'no mission started');
    await page.waitForFunction(() => /Handed to Claude Code — it appears in Improve › In progress/.test(document.getElementById('toast')?.textContent || ''));
  });
  await check(`${label}: Start a mission anyway starts the mission`, async () => {
    await page.evaluate(() => window.LocalAIAgentStart.open());
    await page.locator('#awStart').waitFor({ state: 'visible' });
    await page.locator('#agentGoal').fill(SELF);
    await page.locator('#awSelfChange').getByRole('button', { name: 'Start a mission anyway' }).click();
    for (let i = 0; i < 50 && !sent.length; i++) await page.waitForTimeout(100);
    assert.equal(sent[0]?.goal, SELF);
    assert.equal(handed.length, 1, 'nothing more handed over');
  });
  await check(`${label}: no script errors (hand to Claude)`, async () => assert.deepEqual(errors, []));
  await context.close();
}
{
  const { context, page, errors } = await emptyPage({ viewport: { width: 1440, height: 900 } });
  await check('1440px: a started mission flies the camera to Command Center', async () => {
    await page.unroute(u => u.pathname === '/api/agents/missions/start');
    const m = { id: 'mission-started', goal: 'Fly test', status: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), workers: [{ id: 'router', name: 'Mission Router', state: 'complete', dependsOn: [] }, { id: 'ux_analyst', name: 'UX Analyst', state: 'running', dependsOn: ['router'] }], results: [], timeline: [] };
    await page.route(u => u.pathname === '/api/agents/missions/start', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ mission: m }) }));
    await page.locator('#awPrimary').click();
    await page.locator('#agentGoal').fill('Fly test');
    await page.locator('#missionRunBtn').click();
    await page.locator('#awStart').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => window.LocalAIAgentWorld.camera().zoom > 1.2);
    assert.equal(await page.locator('#awTitle').innerText(), 'Fly test');
  });
  await check('1440px: Advanced shows with developer tools on', async () => {
    await page.evaluate(() => document.body.classList.remove('dev-tools-off'));
    await page.locator('#awPrimary').click().catch(() => {});
    await page.evaluate(() => window.LocalAIAgentStart.open());
    await page.locator('#agentAdvancedToggle').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
  });
  await check('1440px: no script errors (fly)', async () => assert.deepEqual(errors, []));
  await context.close();
}

// The city's behaviour (design PR 4): follow by default, three controls (the rest in ⋯ › View), floating notes,
// moments (flag, warning sign, fireworks) and the reduced-motion path.
const RUN = () => ({ id: 'mission-ui-run', goal: 'Watch the team', status: 'running', createdAt: new Date(Date.now() - 60e3).toISOString(), updatedAt: new Date().toISOString(),
  workers: [{ id: 'router', name: 'Mission Router', state: 'complete', dependsOn: [] }, { id: 'ux_analyst', name: 'UX Analyst', state: 'running', dependsOn: ['router'] }, { id: 'synthesis', name: 'Coordinator', state: 'pending', dependsOn: ['ux_analyst'] }], results: [], timeline: [] });
const push = (page, m) => page.evaluate(m => window.dispatchEvent(new CustomEvent('localai:agentworld-mission', { detail: { mission: m } })), m);
for (const [label, opts] of [['1440px', { viewport: { width: 1440, height: 900 } }], ['iPhone 14', (({ defaultBrowserType, ...d }) => d)(devices['iPhone 14'])]]) {
  const { context, page, errors } = await withMission(opts, RUN());
  await check(`${label}: the camera follows the action by default; moving it pauses Follow, the button resumes`, async () => {
    await page.waitForFunction(() => window.LocalAIAgentWorld.following());
    assert.equal(await page.locator('#awcFollow').getAttribute('aria-pressed'), 'true');
    await page.waitForFunction(() => window.LocalAIAgentWorld.camera().zoom > 1.2, null, { timeout: 5000 });
    const c = page.locator('#awcCanvas'), b = await c.boundingBox(), x = b.x + b.width / 2, y = b.y + b.height / 3;
    await c.dispatchEvent('pointerdown', { pointerId: 3, pointerType: 'touch', clientX: x, clientY: y, isPrimary: true });
    await c.dispatchEvent('pointermove', { pointerId: 3, pointerType: 'touch', clientX: x + 60, clientY: y + 20, isPrimary: true });
    await c.dispatchEvent('pointerup', { pointerId: 3, pointerType: 'touch', clientX: x + 60, clientY: y + 20, isPrimary: true });
    assert.equal(await page.evaluate(() => window.LocalAIAgentWorld.following()), false);
    assert.equal(await page.locator('#awcFollow').getAttribute('aria-pressed'), 'false');
    await page.locator('#awcFollow').click();
    assert.equal(await page.evaluate(() => window.LocalAIAgentWorld.following()), true);
  });
  await check(`${label}: three controls over the city; the rest is in ⋯ › View`, async () => {
    assert.deepEqual(await page.locator('.awc__controls button:visible').evaluateAll(b => b.map(x => x.id)), ['awcZoomOut', 'awcZoomIn', 'awcFollow']);
    assert.equal(await page.locator('.awc__commandbar').count(), 0);
    assert.equal(await page.getByText(/Artifacts?/).count(), 0, 'no “Artifacts”');
    await (label === '1440px' ? page.locator('#awMoreBtn') : page.locator('#uxHeaderAction')).click();
    const view = page.locator('#awMenu [data-aw-view]');
    assert.deepEqual(await view.allInnerTexts(), ['Labels', 'Flows', 'Night', 'Full screen', 'Fit the city', 'Replay speed: 1×']);
    await page.locator('#awMenu [data-aw-view="night"]').click();
    assert.equal(await page.evaluate(() => window.LocalAIAgentWorld.display().night), true);
  });
  await check(`${label}: changes float over the city as short notes, at most three`, async () => {
    const m = RUN(); m.workers[1].state = 'complete'; m.workers[2].state = 'running';
    await push(page, m);
    await page.locator('#awcToasts li', { hasText: 'UX Analyst finished' }).waitFor();
    await page.locator('#awcToasts li', { hasText: 'Coordinator started putting the findings together' }).waitFor();
    for (const s of ['complete', 'error']) { const n = RUN(); n.workers[2].state = s; n.workers[1].state = 'complete'; await push(page, n); }
    assert.ok(await page.locator('#awcToasts li').count() <= 3);
  });
  await check(`${label}: moments: a flag for a finished worker, a warning sign for a stopped one, fireworks when done`, async () => {
    const bad = RUN(); bad.workers[1].state = 'error'; bad.status = 'needs_attention'; await push(page, bad);
    assert.ok((await page.evaluate(() => window.LocalAIAgentWorld.moments())).warnings.includes('ux_analyst'));
    const done = RUN(); done.status = 'complete'; done.workers.forEach(w => { w.state = 'complete'; }); await push(page, done);
    const mo = await page.evaluate(() => window.LocalAIAgentWorld.moments());
    assert.ok(mo.flags.includes('ux_analyst') && mo.fireworks, JSON.stringify(mo));
  });
  await check(`${label}: no script errors (city)`, async () => assert.deepEqual(errors, []));
  await context.close();
}
{
  const { context, page, errors } = await withMission({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' }, RUN());
  await check('reduced motion: the camera jumps, workers don’t walk, no fireworks', async () => {
    await page.locator('#awcRoster [data-awc-roster="ux_analyst"]').click();
    await page.waitForTimeout(80);
    const c = await page.evaluate(() => window.LocalAIAgentWorld.camera());
    assert.equal(c.shown.zoom, c.zoom, 'no easing');
    assert.equal(await page.evaluate(() => window.LocalAIAgentWorld.walking()), 0);
    const done = RUN(); done.status = 'complete'; done.workers.forEach(w => { w.state = 'complete'; }); await push(page, done);
    assert.equal((await page.evaluate(() => window.LocalAIAgentWorld.moments())).fireworks, false);
  });
  await check('reduced motion: no script errors', async () => assert.deepEqual(errors, []));
  await context.close();
}

// Workers (visuals pass, 2026-10-18-agent-world-visuals.md): a look per role, a walk cycle, still frames with reduced
// motion. window.__awcLayout() (localStorage localai.debug = 1) says where each worker is drawn, in canvas pixels.
const PAIR = () => ({ id: 'mission-ui-pair', goal: 'Two roles', status: 'running', createdAt: new Date(Date.now() - 60e3).toISOString(), updatedAt: new Date().toISOString(),
  workers: [{ id: 'ux_analyst', name: 'UX Analyst', state: 'pending', dependsOn: [] }, { id: 'code_analyst', name: 'Code Analyst', state: 'pending', dependsOn: [] }, { id: 'synthesis', name: 'Coordinator', state: 'running', dependsOn: [] }], results: [], timeline: [] });
const debugOn = context => context.addInitScript(() => { try { localStorage.setItem('localai.debug', '1'); } catch {} });
const frames = page => page.evaluate(() => Object.fromEntries(window.__awcLayout().workers.map(w => [w.id, w.frame])));
for (const [label, opts] of [['1440px', { viewport: { width: 1440, height: 900 } }], ['reduced motion', { viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' }]]) {
  const context = await browser.newContext({ serviceWorkers: 'block', ...opts }); await debugOn(context);
  await context.addInitScript(() => { try { localStorage.setItem('localai.firstRun.done', '1'); } catch {} });
  const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route(u => u.pathname === '/api/agents/missions', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: [PAIR()] }) }));
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.showView === 'function');
  await page.evaluate(() => window.showView('agents'));
  await page.waitForFunction(() => window.__awcLayout?.().workers.length === 3 && window.__awcLayout().workers.every(w => w.frame !== undefined));
  await page.evaluate(() => { window.LocalAIAgentWorld.follow(false); window.LocalAIAgentWorld.view('fit'); });
  if (label === '1440px') {
    await check('1440px: workers walk with a 4-frame cycle on their way', async () => {
      const seen = new Set();
      for (let i = 0; i < 20 && seen.size < 3; i++) { const l = await page.evaluate(() => window.__awcLayout().workers.find(w => w.moving)); if (l && l.frame >= 1 && l.frame <= 4) seen.add(l.frame); await page.waitForTimeout(60); }
      assert.ok(seen.size >= 2, `walk frames seen: ${[...seen]}`);
    });
    await check('1440px: workers with different roles look different (each wears their district colour)', async () => {
      await page.waitForFunction(() => window.__awcLayout().workers.every(w => !w.moving), null, { timeout: 15000 });
      await page.waitForTimeout(300);
      const r = await page.evaluate(() => {
        const c = document.getElementById('awcCanvas'), g = c.getContext('2d'), ws = window.__awcLayout().workers.filter(w => w.id !== 'synthesis');
        const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
        return ws.map(w => { const b = w.box, d = g.getImageData(Math.round(b.x), Math.round(b.y), Math.round(b.w), Math.round(b.h)).data;
          const count = h => { const [R, G, B] = rgb(h); let n = 0; for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - R) < 24 && Math.abs(d[i + 1] - G) < 24 && Math.abs(d[i + 2] - B) < 24) n++; return n; };
          return { id: w.id, own: count(w.vest), other: count(ws.find(x => x !== w).vest), px: d.length / 4 }; });
      });
      for (const w of r) assert.ok(w.own > 20 && w.own > w.other * 4, `${w.id}: ${w.own} pixels of its vest colour, ${w.other} of the other's (${JSON.stringify(r)})`);
    });
  } else {
    await check('reduced motion: no walk cycle; each worker holds one still frame', async () => {
      const a = await frames(page); await page.waitForTimeout(700); const b = await frames(page);
      assert.deepEqual(a, b, 'frames do not change');
      assert.ok(Object.values(a).every(f => f < 1 || f > 4), `no walk frames: ${JSON.stringify(a)}`);
      assert.equal(await page.evaluate(() => window.LocalAIAgentWorld.walking()), 0);
    });
  }
  await check(`${label}: no script errors (workers)`, async () => assert.deepEqual(errors, []));
  await context.close();
}

// Signs and bubbles (visuals pass, PR 2): a district's sign and progress pill sit on its roof; name tags and bubbles
// step aside so none covers a sign or another bubble, with eight workers busy around the roofs. The selected Validator
// is stopped inside Repair Bay, right under its sign, so its name tag has to move.
{
  const W8 = (id, name, state, dependsOn = []) => ({ id, name, state, dependsOn });
  const CROWD = { id: 'mission-ui-crowd', goal: 'A busy city', status: 'running', createdAt: new Date(Date.now() - 60e3).toISOString(), updatedAt: new Date().toISOString(), results: [], timeline: [], workers: [
    W8('router', 'Mission Router', 'complete'), W8('ux_analyst', 'UX Analyst', 'running', ['router']), W8('code_analyst', 'Code Analyst', 'running', ['router']), W8('documentation', 'Documentation Agent', 'pending', ['ux_analyst']),
    W8('validator', 'Validator', 'error', ['code_analyst']), W8('research_agent', 'Research Agent', 'complete', ['router']), W8('performance_analyst', 'Performance Analyst', 'running', ['router']), W8('synthesis', 'Coordinator', 'pending', ['documentation', 'code_analyst'])] };
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } }); await debugOn(context);
  const { page, errors } = await (async () => { await context.addInitScript(() => { try { localStorage.setItem('localai.firstRun.done', '1'); } catch {} });
    const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route(u => u.pathname === '/api/agents/missions', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: [CROWD] }) }));
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' }); await page.waitForFunction(() => typeof window.showView === 'function');
    await page.evaluate(() => window.showView('agents')); await page.waitForFunction(() => window.__awcLayout?.().workers.length === 8); return { page, errors }; })();
  await check('1440px: no name tag or bubble covers a district sign or another bubble', async () => {
    await page.evaluate(() => window.LocalAIAgentWorld.follow(false));
    await page.waitForFunction(() => window.__awcLayout().workers.every(w => !w.moving), null, { timeout: 20000 });
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('localai:agentworld-focus', { detail: { workerId: 'validator' } })));
    await page.waitForTimeout(1500);
    const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    let most = 0;
    for (let i = 0; i < 8; i++) {
      const l = await page.evaluate(() => window.__awcLayout());
      assert.ok(l.labels.length >= 8, `every district has a sign (${l.labels.length})`);
      most = Math.max(most, l.bubbles.length);
      for (const b of l.bubbles) {
        for (const s of l.labels) assert.ok(!overlap(b, s), `bubble ${JSON.stringify(b)} covers sign ${JSON.stringify(s)}`);
        for (const o of l.bubbles) if (o !== b) assert.ok(!overlap(b, o), 'two bubbles overlap');
      }
      await page.waitForTimeout(120);
    }
    assert.ok(most >= 3, `the working workers and the selected one show bubbles (${most})`);
  });
  await check('1440px: the ground has lamp posts and trees in three shapes and two sizes', async () => {
    const l = await page.evaluate(() => window.__awcLayout());
    assert.deepEqual([...new Set(l.trees)].sort(), ['0L', '0S', '1L', '1S', '2L', '2S']);
    assert.ok(l.lamps >= 10, `${l.lamps} lamp posts`);
  });
  await check('1440px: no script errors (signs)', async () => assert.deepEqual(errors, []));
  await context.close();
}

// Follow-ups to the visuals pass: workers drawn 1.25x on phones (and still tappable where they are drawn), flows that
// leave each door straight down to the street (every leg horizontal or vertical), and cars that stop short of a zebra
// crossing while a worker is on it. window.__awcSim (debug only) puts a worker or a car somewhere, so this is exact.
const FLOW = () => ({ id: 'mission-ui-flow', goal: 'Flows and crossings', status: 'running', createdAt: new Date(Date.now() - 60e3).toISOString(), updatedAt: new Date().toISOString(), results: [], timeline: [],
  workers: [{ id: 'router', name: 'Mission Router', state: 'complete', dependsOn: [] }, { id: 'ux_analyst', name: 'UX Analyst', state: 'pending', dependsOn: ['router'] }, { id: 'documentation', name: 'Documentation Agent', state: 'pending', dependsOn: ['ux_analyst'] },
    { id: 'code_analyst', name: 'Code Analyst', state: 'pending', dependsOn: ['router'] }, { id: 'performance_analyst', name: 'Performance Analyst', state: 'pending', dependsOn: ['code_analyst'] }, { id: 'validator', name: 'Validator', state: 'pending', dependsOn: ['performance_analyst'] }] });
async function cityWithFlow(opts) {
  const context = await browser.newContext({ serviceWorkers: 'block', ...opts }); await debugOn(context);
  await context.addInitScript(() => { try { localStorage.setItem('localai.firstRun.done', '1'); } catch {} });
  const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route(u => u.pathname === '/api/agents/missions', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: [FLOW()] }) }));
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' }); await page.waitForFunction(() => typeof window.showView === 'function');
  await page.evaluate(() => window.showView('agents')); await page.waitForFunction(() => window.__awcLayout?.().workers.length === 6);
  await page.evaluate(() => { window.LocalAIAgentWorld.follow(false); window.LocalAIAgentWorld.view('fit'); });
  await page.waitForFunction(() => window.__awcLayout().workers.every(w => !w.moving), null, { timeout: 20000 });
  await page.waitForTimeout(400);
  return { context, page, errors };
}
const spriteScale = page => page.evaluate(() => { const l = window.__awcLayout(), c = window.LocalAIAgentWorld.camera(), k = c.base * c.shown.zoom * c.dpr; return { scale: l.workerScale, ratio: l.workers.map(w => w.box.h / (56 * k)) }; });
{
  const { context, page, errors } = await cityWithFlow({ viewport: { width: 1440, height: 900 } });
  await check('1440px: workers are drawn at their usual size', async () => {
    const s = await spriteScale(page);
    assert.equal(s.scale, 1);
    for (const r of s.ratio) assert.ok(Math.abs(r - 1) < 0.02, `box height ratio ${r}`);
  });
  await check('1440px: every flow runs door to street to door in straight legs, none diagonal', async () => {
    const flows = (await page.evaluate(() => window.__awcLayout())).flows;
    assert.ok(flows.length >= 4, `${flows.length} flows`);
    for (const f of flows) {
      assert.ok(f.points.length >= 3, `${f.from}>${f.to} has ${f.points.length} points`);
      f.points.slice(1).forEach((q, i) => { const p = f.points[i]; assert.ok(Math.abs(q.x - p.x) < 0.5 || Math.abs(q.y - p.y) < 0.5, `${f.from}>${f.to} leg ${i} is diagonal: ${JSON.stringify([p, q])}`); });
      // straight down to a street in front of the door, or along the front when the street is behind it; never back up
      const [a, b] = f.points; assert.ok(b.y >= a.y - 0.5, `${f.from}>${f.to} leaves its door without cutting back through the building`);
    }
  });
  await check('1440px: a worker walks out of the door straight to the street, then along it, with no diagonal leg', async () => {
    const zones = ['command', 'ux', 'docs', 'engineering', 'validation', 'models', 'projects', 'repair'];
    const ids = ['router', 'ux_analyst', 'documentation', 'code_analyst', 'performance_analyst', 'validator'];
    // from where each worker stands now, and from a desk inside every district, to a desk or an apron spot in every district
    const routes = await page.evaluate(({ ids, zones }) => ids.flatMap(id => [undefined, ...zones].flatMap(from => zones.flatMap(z => [true, false].map(inside => ({ id, z, inside, r: window.__awcSim.route(id, z, inside, from) }))))), { ids, zones });
    assert.equal(routes.length, ids.length * (zones.length + 1) * zones.length * 2);
    let fromInside = 0;
    for (const { id, z, inside, r } of routes) {
      const p = r.points, name = `${id} from ${r.from}${r.inside ? ' (inside)' : ''} to ${z}${inside ? ' (inside)' : ''}`;
      assert.ok(p.length >= (r.inside && r.from === z && inside ? 1 : 2), `${name} has ${p.length} points`);
      p.slice(1).forEach((q, i) => { const a = p[i]; assert.ok(Math.abs(q.x - a.x) < 0.5 || Math.abs(q.y - a.y) < 0.5, `${name} leg ${i} is diagonal: ${JSON.stringify([a, q])}`); });
      if (r.inside) {
        fromInside++;
        if (r.from === z && inside) { assert.ok(p.every(q => q.y < r.door.outside.y), `${name} stays indoors`); continue; }
        const at = p.findIndex(q => Math.abs(q.x - r.door.outside.x) < 0.5 && Math.abs(q.y - r.door.outside.y) < 0.5);
        assert.ok(at > 0, `${name} goes out through its door`);
        const di = p[at - 1]; assert.ok(Math.abs(di.x - r.door.outside.x) < 0.5 && di.y < r.door.outside.y, `${name} walks straight out of the door`);
        assert.ok(p[at + 1].y >= r.door.outside.y - 0.5, `${name} does not turn back into the building from the door step`);
      }
    }
    assert.equal(fromInside, ids.length * zones.length * zones.length * 2, 'every route from a desk is checked');
  });
  await check('1440px: a car stops short of a zebra crossing while a worker is on it, then drives on', async () => {
    // car 2 drives down the east avenue (x 816) towards the crossing at y 384-416; the UX Analyst stands on it
    const z = await page.evaluate(() => window.__awcLayout().crossings.find(c => c.axis === 'y' && c.x === 800 && c.y === 384));
    assert.ok(z, 'the crossing is listed');
    await page.evaluate(() => { window.__awcSim.put('ux_analyst', 830, 400); window.__awcSim.car(2, 816, 330); });
    await page.waitForFunction(() => window.__awcLayout().cars[2].go === 0, null, { timeout: 8000 });
    const a = (await page.evaluate(() => window.__awcLayout())).cars[2]; await page.waitForTimeout(600); const b = (await page.evaluate(() => window.__awcLayout())).cars[2];
    assert.ok(a.y + 7 <= z.y, `stopped before the stripes (front ${a.y + 7}, crossing at ${z.y})`);
    assert.ok(a.y + 7 >= z.y - 12, `stopped close to them (front ${a.y + 7})`);
    assert.equal(b.y, a.y, 'and stays stopped');
    await page.evaluate(() => window.__awcSim.put('ux_analyst', 160, 330));
    await page.waitForFunction(y => window.__awcLayout().cars[2].y - 7 > y, z.y + z.h, { timeout: 8000 });
  });
  await check('1440px: no script errors (flows and cars)', async () => assert.deepEqual(errors, []));
  await context.close();
}
for (const name of ['iPhone 14', 'iPad Mini']) {
  const { defaultBrowserType, ...device } = devices[name];
  const { context, page, errors } = await cityWithFlow(device);
  await check(`${name}: workers are drawn 1.25x, and a tap on the head of the bigger sprite still selects them`, async () => {
    const s = await spriteScale(page);
    assert.equal(s.scale, 1.25);
    for (const r of s.ratio) assert.ok(Math.abs(r - 1.25) < 0.03, `box height ratio ${r}`);
    const target = await page.evaluate(() => {
      const c = document.getElementById('awcCanvas'), r = c.getBoundingClientRect(), dpr = window.LocalAIAgentWorld.camera().dpr;
      for (const w of window.__awcLayout().workers) {
        // just under the hat: above where the unscaled sprite's hit circle reached
        const x = r.left + (w.box.x + w.box.w / 2) / dpr, y = r.top + (w.box.y + w.box.h * 0.15) / dpr;
        if (document.elementFromPoint(x, y) === c) return { id: w.id, x, y };
      }
      return null;
    });
    assert.ok(target, 'a worker is on screen and uncovered');
    await page.touchscreen.tap(target.x, target.y);
    await page.waitForFunction(() => !!document.querySelector('#awcSelection strong'));
    const want = await page.evaluate(w => window.LocalAIAgentWords.workerName(w), FLOW().workers.find(w => w.id === target.id));
    assert.equal(await page.locator('#awcSelection strong').innerText(), want);
  });
  await check(`${name}: no script errors (worker scale)`, async () => assert.deepEqual(errors, []));
  await context.close();
}

// Live review (17 Oct): while a mission ran, the phone's collapsed sheet offered nothing, the header's hidden button
// still said "Start a mission", the city called the team lead "Mission Router", and the worker card listed scores.
const visiblePrimaries = page => page.evaluate(() => [...document.querySelectorAll('#agents .btn-primary')].filter(b => { const r = b.getBoundingClientRect(); return r.width > 2 && r.height > 2 && getComputedStyle(b).visibility !== 'hidden'; }).map(b => b.textContent.trim()));
const panCity = async page => {
  const c = page.locator('#awcCanvas'), b = await c.boundingBox(), x = b.x + b.width / 2, y = b.y + b.height / 3;
  await c.dispatchEvent('pointerdown', { pointerId: 9, pointerType: 'touch', clientX: x, clientY: y, isPrimary: true });
  await c.dispatchEvent('pointermove', { pointerId: 9, pointerType: 'touch', clientX: x + 60, clientY: y + 20, isPrimary: true });
  await c.dispatchEvent('pointerup', { pointerId: 9, pointerType: 'touch', clientX: x + 60, clientY: y + 20, isPrimary: true });
};
{
  const { defaultBrowserType, ...device } = devices['iPhone 14'];
  const { context, page, errors } = await withMission(device, RUN());
  await check('iPhone 14 running: the peek always offers a next step, 44 px tall, and never two loud ones', async () => {
    await page.waitForFunction(() => window.LocalAIAgentWorld.following());
    const a = page.locator('#awPeekAction');
    await a.waitFor({ state: 'visible' });
    assert.equal(await a.innerText(), 'See the crew', 'following: a quiet action');
    assert.ok((await a.boundingBox()).height >= 44);
    assert.deepEqual(await visiblePrimaries(page), []);
    await panCity(page);
    await page.waitForFunction(() => document.getElementById('awPeekAction').textContent === 'Watch live');
    assert.ok((await a.boundingBox()).height >= 44);
    assert.deepEqual(await visiblePrimaries(page), ['Watch live']);
    await a.tap();
    assert.equal(await page.evaluate(() => window.LocalAIAgentWorld.following()), true);
    await page.waitForFunction(() => document.getElementById('awPeekAction').textContent === 'See the crew');
    await a.tap();
    await page.waitForFunction(() => document.getElementById('awSheet').dataset.snap === 'half');
    await page.evaluate(() => history.back());
    await page.waitForFunction(() => document.getElementById('awSheet').dataset.snap === 'peek');
  });
  await check('iPhone 14: at peek the crew rows are inert and a tap there never reaches them', async () => {
    assert.equal(await page.evaluate(() => document.getElementById('awSheetBody').inert), true);
    const hit = await page.evaluate(() => { const r = document.querySelector('#awcRoster [data-awc-roster]').getBoundingClientRect(), e = document.elementFromPoint(r.x + r.width / 2, Math.min(innerHeight - 1, r.y + r.height / 2)); return !!e?.closest('#awcRoster'); });
    assert.equal(hit, false);
  });
  await check('iPhone 14: at half a real tap on a crew row focuses that worker and opens the card, on this page', async () => {
    await page.locator('#awSheetHandle').tap();
    await page.waitForFunction(() => document.getElementById('awSheet').dataset.snap === 'half');
    const row = page.locator('#awcRoster [data-awc-roster="ux_analyst"]');
    await page.waitForFunction(() => { const y = document.getElementById('awSheet').getBoundingClientRect().y, s = window.__awY; window.__awY = y; return s === y; }, null, { polling: 100 }); // the sheet has settled
    const b = await row.boundingBox(), nav = await page.locator('#uxMobileNav').boundingBox();
    assert.ok(b.y + b.height / 2 < nav.y, 'the row is above the tab bar');
    await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
    await page.locator('#agentInspector').waitFor({ state: 'visible' });
    assert.match(await page.locator('#awWorkerName').innerText(), /UX Analyst/);
    assert.equal(await page.evaluate(() => document.querySelector('#agents').classList.contains('active')), true, 'still on Agent World');
    assert.notEqual(await page.locator('#awSheet').getAttribute('data-snap'), 'peek');
  });
  await check('iPhone 14: no script errors (live review)', async () => assert.deepEqual(errors, []));
  await context.close();
}
{
  const { context, page, errors } = await withMission({ viewport: { width: 1440, height: 900 } }, RUN());
  await check('1440px running (loaded from history): no Start a mission; Watch live once the camera stops following', async () => {
    await page.waitForFunction(() => window.LocalAIAgentWorld.following());
    assert.match(await page.locator('#awStatus').innerText(), /^Working · 1 of 3 done/);
    assert.equal(await page.locator('#awPrimary').isVisible(), false, 'following: no loud action');
    assert.notEqual(await page.locator('#awPrimary').textContent(), 'Start a mission');
    await panCity(page);
    await page.locator('#awPrimary').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#awPrimary').innerText(), 'Watch live');
    assert.deepEqual(await visiblePrimaries(page), ['Watch live']);
    await page.locator('#awPrimary').click();
    assert.equal(await page.evaluate(() => window.LocalAIAgentWorld.following()), true);
    await page.locator('#awPrimary').waitFor({ state: 'hidden' });
  });
  await check('1440px: developer tools off: no Mission Router anywhere, no scores in the worker card', async () => {
    assert.equal(await page.evaluate(() => document.body.classList.contains('dev-tools-off')), true);
    assert.equal(await page.evaluate(() => document.documentElement.outerHTML.includes('Mission Router')), false, 'not in the DOM');
    const names = await page.evaluate(() => window.LocalAIAgentWorld.names());
    assert.ok(names.includes('Team lead') && !names.includes('Mission Router'), 'city labels: ' + names.join(', '));
    await page.locator('#awcRoster [data-awc-roster="router"]').click();
    const card = page.locator('#agentInspector');
    await card.waitFor({ state: 'visible' });
    assert.doesNotMatch(await card.innerText(), /Skill fit|Model fit|Grounding|Fallback|Assignment rationale|Model\b/);
    assert.match(await card.innerText(), /Team lead/);
  });
  await check('1440px: no script errors (live review)', async () => assert.deepEqual(errors, []));
  await context.close();
}
{
  const reason = 'Interrupted: the appliance restarted while this was running';
  const m = { ...RUN(), status: 'error', error: reason, workers: [{ id: 'router', name: 'Mission Router', state: 'complete', dependsOn: [] }, { id: 'code_analyst', name: 'Code Analyst', state: 'error', error: reason, dependsOn: ['router'] }, { id: 'synthesis', name: 'Coordinator', state: 'blocked', error: reason, dependsOn: ['code_analyst'] }] };
  const { context, page, errors } = await withMission({ viewport: { width: 1440, height: 900 } }, m);
  await check('1440px: an interrupted mission reads "was interrupted by an update", whole in the crew row', async () => {
    assert.equal(await page.locator('#awStatus').innerText(), 'Needs you · 1 of 3 done · Code Analyst was interrupted by an update');
    const step = page.locator('#awcRoster [data-awc-roster="code_analyst"] .awc__rosterText span');
    assert.equal(await step.innerText(), 'Interrupted by an update');
    assert.ok(await step.evaluate(e => e.scrollWidth <= e.clientWidth + 1), 'not cut off');
    assert.equal(await page.locator('#awPrimary').innerText(), 'Try again');
  });
  await check('1440px: no script errors (interrupted)', async () => assert.deepEqual(errors, []));
  await context.close();
}

// Results and replay (design PR 5): Summary, What each worker found, Sources; one scrubber; owner words only.
const DONE2 = { ...DONE, id: 'mission-ui-done2', timeline: FAILED.timeline.slice(0, 3).concat([{ at: t(240), type: 'mission-complete', status: 'complete', workers: snapW('complete', 'complete') }]),
  results: [{ agentId: 'ux_analyst', agentName: 'UX Analyst', status: 'complete', answer: 'Three things to fix on the phone screens.', evidenceRecords: [{ title: 'Apple guidelines', source: 'https://developer.apple.com/design/' }, { title: 'App review notes', source: 'knowledge:doc-1#chunk-0' }] }] };
const DEV_WORDS = /Synthesis|Evidence|Routing|Mission Router|Capability|Grounding|Fallback|Simulation|Artifact|Inspector|Worker outputs/i;
{
  const { context, page, errors } = await withMission({ viewport: { width: 1440, height: 900 } }, DONE2);
  await check('1440px: results read Summary, What each worker found, Sources', async () => {
    const box = page.locator('#agentResultBody');
    assert.deepEqual(await box.locator('h3').allInnerTexts(), ['Summary', 'What each worker found', 'Sources']);
    assert.match(await box.innerText(), /The summary of what the team found\./);
    const worker = box.locator('details', { hasText: 'UX Analyst' });
    await worker.locator('summary').click();
    assert.match(await worker.innerText(), /Three things to fix on the phone screens\./);
    assert.equal(await box.locator('a[href="https://developer.apple.com/design/"]').innerText(), 'Apple guidelines');
    assert.match(await box.innerText(), /App review notes/);
  });
  await check('1440px: one replay scrubber under the city, with event markers and Play', async () => {
    const scrub = page.locator('#awcScrub');
    await scrub.waitFor({ state: 'visible' });
    assert.equal(await page.locator('#awcReplayMarkers button').count(), 4);
    for (const gone of ['#awcReplayPrev', '#awcReplayNext', '#awcDemoPlay', '#awcDemoScenario']) assert.equal(await page.locator(gone).count(), 0, gone);
    await page.locator('#awcReplayPlay').click();
    assert.equal(await page.locator('#awcReplayPlay').getAttribute('aria-label'), 'Pause the replay');
    await page.locator('#awcReplayPlay').click();
    const city = await page.locator('.awc__mapWrap').boundingBox(), s = await scrub.boundingBox();
    assert.ok(s.y >= city.y + city.height - 1, 'under the city');
  });
  await check('1440px: replay speed is in ⋯ › View; the demo only with developer tools', async () => {
    await page.locator('#awMoreBtn').click();
    await page.locator('#awMenu [data-aw-view="speed"]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#awMenu [data-aw-menu="demo"]').isVisible(), false);
    await page.keyboard.press('Escape');
  });
  await check('1440px: no developer words on the page with developer tools off', async () => {
    const text = await page.locator('#agents').innerText();
    assert.doesNotMatch(text, DEV_WORDS);
  });
  await check('1440px: with developer tools on, Routing and the demo appear', async () => {
    await page.evaluate(() => document.body.classList.remove('dev-tools-off'));
    await page.locator('#agentResultBody details', { hasText: 'Routing' }).waitFor({ state: 'visible' });
    await page.locator('#awMoreBtn').click();
    await page.locator('#awMenu [data-aw-menu="demo"]').click();
    await page.locator('#awcLiveBtn').waitFor({ state: 'visible' });
    await page.locator('#awcLiveBtn').click();
    await page.locator('#awcLiveBtn').waitFor({ state: 'hidden' });
    await page.evaluate(() => document.body.classList.add('dev-tools-off'));
  });
  await check('1440px: no script errors (results)', async () => assert.deepEqual(errors, []));
  await context.close();
}
{
  const { context, page, errors } = await withMission({ viewport: { width: 1440, height: 900 } }, FAILED);
  await check('1440px: no summary says why', async () => {
    assert.match(await page.locator('#agentResultBody').innerText(), /No summary: the Coordinator couldn’t start because UX Analyst stopped\./);
  });
  await check('1440px: no script errors (no summary)', async () => assert.deepEqual(errors, []));
  await context.close();
}
// iPad in portrait (tablet, 761–1023 px): the city is full width. Live, Work's one-item page list stayed open on this
// hidden page (an iPad keeps the list on listed pages) and squeezed the city to 434 of 768 px.
{
  const { defaultBrowserType, ...device } = devices['iPad Mini'];
  const context = await browser.newContext({ ...device, serviceWorkers: 'block' });
  const { page, errors } = await seeded(context);
  await check('iPad Mini: the city is full width; Work’s page list is closed', async () => {
    await page.waitForTimeout(300);
    const m = await page.evaluate(() => {
      const w = s => document.querySelector(s)?.getBoundingClientRect().width || 0, sec = document.querySelector('.ux-secondary-nav');
      return { vw: innerWidth, main: w('main'), canvas: w('#awcCanvas'), secShown: !!sec && getComputedStyle(sec).display !== 'none' && sec.getBoundingClientRect().width > 0 };
    });
    assert.equal(m.secShown, false, 'the page list is hidden');
    assert.ok(m.main >= m.vw - 80, `main content takes all but the rail (${Math.round(m.main)} of ${m.vw})`);
    assert.ok(m.canvas >= m.main * 0.85, `the city is at least 85% of the main content (${Math.round(m.canvas)} of ${Math.round(m.main)})`);
  });
  await check('iPad Mini: no script errors', async () => assert.deepEqual(errors, []));
  await context.close();
}
{
  const { defaultBrowserType, ...device } = devices['iPhone 14'];
  const { context, page, errors } = await withMission(device, DONE2);
  await check('iPhone 14: See the result raises the sheet to the summary', async () => {
    await page.locator('#awPeekAction').click();
    await page.waitForFunction(() => document.getElementById('awSheet').dataset.snap === 'full');
    await page.locator('#agentResultBody h3', { hasText: 'Summary' }).waitFor({ state: 'visible' });
    await page.locator('#awcScrub').waitFor({ state: 'attached' });
  });
  await check('iPhone 14: no script errors (results)', async () => assert.deepEqual(errors, []));
  await context.close();
}

await browser.close();
if (failures.length) { console.error('\nAgent World failures:\n' + failures.map(x => ' - ' + x).join('\n')); process.exit(1); }
console.log('\nAll Agent World checks passed.');
