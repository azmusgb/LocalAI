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

await browser.close();
if (failures.length) { console.error('\nAgent World failures:\n' + failures.map(x => ' - ' + x).join('\n')); process.exit(1); }
console.log('\nAll Agent World checks passed.');
