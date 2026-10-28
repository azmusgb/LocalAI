// Frame-time budget for Agent World, the one page that animates a canvas: while the demo mission plays, with the CPU
// slowed 4x (about a phone), frames stay at 30 fps or better and none takes 200 ms. Measured 2026-10-16: 60 fps
// (p95 16.8 ms), longest animation frame 86 ms, at both phone and desktop width. Since 2026-10-17 it also runs on an
// emulated iPhone 14 (touch, 3x screen; the canvas paints at 2x).
import { chromium, devices } from 'playwright';
import assert from 'node:assert/strict';

const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const P95_MS = 34, LONGEST_MS = 200, SLOWDOWN = 4, SECONDS = 4;
const browser = await chromium.launch({ headless: true });
const failures = [];
async function check(name, fn) {
  try { await fn(); console.log('PASS', name); } catch (error) { failures.push(`${name}: ${error.message}`); console.error('FAIL', name, error.message); }
}

// The phone runs twice: a narrow window, and an iPhone 14 (touch, 3x screen: the canvas paints at 2x).
const { defaultBrowserType, ...iphone } = devices['iPhone 14'];
for (const [label, opts] of [['390px', { viewport: { width: 390, height: 844 } }], ['iPhone 14', iphone], ['1280px', { viewport: { width: 1280, height: 860 } }]]) {
  await check(`Agent World demo at ${label}: p95 frame <= ${P95_MS} ms and no frame over ${LONGEST_MS} ms at ${SLOWDOWN}x CPU slowdown`, async () => {
    const page = await browser.newPage(opts);
    await page.goto(base + '/', { waitUntil: 'networkidle' });
    await page.evaluate(() => window.LocalAIRouter.go('#agents?mission=latest'));
    await page.waitForSelector('#awcCanvas');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: SLOWDOWN });
    await page.evaluate(() => window.LocalAIAgentWorld.demo());
    await page.locator('#awcCanvas').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const r = await page.evaluate(seconds => new Promise(done => {
      const gaps = [], long = [];
      try { new PerformanceObserver(l => l.getEntries().forEach(e => long.push(e.duration))).observe({ type: 'long-animation-frame' }); } catch {}
      let last = performance.now(); const end = last + seconds * 1000;
      const frame = now => { gaps.push(now - last); last = now; if (now < end) requestAnimationFrame(frame); else { gaps.sort((a, b) => a - b); done({ frames: gaps.length, p95: gaps[Math.floor(gaps.length * 0.95)], longest: Math.max(0, ...long) }); } };
      requestAnimationFrame(frame);
    }), SECONDS);
    assert.match(await page.locator('#awSheetStatus').textContent(), /Starting|Working|Done/, 'the demo mission is playing');
    assert.ok(r.p95 <= P95_MS, `p95 frame ${r.p95.toFixed(1)} ms over ${r.frames} frames`);
    assert.ok(r.longest <= LONGEST_MS, `longest animation frame ${Math.round(r.longest)} ms`);
    console.log(`  ${label}: ${r.frames} frames, p95 ${r.p95.toFixed(1)} ms, longest ${Math.round(r.longest)} ms`);
    await page.close();
  });
}

// Main Street's strip on Home: with the CPU throttled the way the checks above do it, the engine's own frame timer
// (stats().avgMs, the mean cost of a frame it draws) stays under 8 ms at a 390 px phone with a 3x screen.
const BUSY = {
  schema: 1,
  models: { loaded: [{ name: 'qwen3:4b-instruct-32k', sizeMb: 3100, vramMb: 3100 }], queue: { active: 1, waiting: 2 }, busy: { total: 1, kinds: { chat: 1 } } },
  printer: { setUp: true, access: 'ok', state: 'printing', progress: 62, minutesLeft: 41, errorCode: null },
  sheets: { bridge: true, excel: true, inFlight: 1 },
  kiosk: { setUp: true, online: true, signIn: true, firmware: '12.8.0' },
  crews: null,
  street: Object.fromEntries(['chat', 'images', 'missions', 'garage', 'sheets', 'clock'].map(k => [k, { running: k === 'chat' || k === 'images' ? [{ id: 'j' + k, title: 'Job', status: 'running', startedAt: Date.now() - 60000 }] : [], waiting: 0, needsYou: [], failedUnseen: [], recent: [] }]))
};
await check('Main Street strip stays within its frame budget', async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, serviceWorkers: 'block' });
  await ctx.addInitScript(() => { try { localStorage.setItem('localai.firstRun.done', '1'); } catch {} });
  await ctx.route(u => u.pathname === '/api/world', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify(BUSY) }));
  const page = await ctx.newPage();
  await page.goto(base + '/#home', { waitUntil: 'domcontentloaded' });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: SLOWDOWN });
  await page.waitForSelector('#homeStreet .street:not([hidden])', { timeout: 10000 });
  await page.waitForTimeout(3000);
  const s = await page.evaluate(() => window.LocalAIStreet.stats());
  assert.ok(s.frames > 0, 'the street drew frames');
  assert.ok(s.avgMs < 8, `avg frame ${s.avgMs} ms over ${s.frames} frames`);
  console.log(`  Main Street: ${s.frames} frames, avg ${s.avgMs} ms at ${SLOWDOWN}x slowdown`);
  await ctx.close();
});

// The flood (plan Review Focus 1) at night: 10 asks and 10 failures in every street key, every other building busy and
// the Yard's crews at work, at 21:00 local time, so every frame draws the night pass (sky, wash, light layers) on top of
// the beacons, hazards and moving buildings. Same budget: under 8 ms a frame at 390 px with a 3x screen.
const many = (k, status) => Array.from({ length: 10 }, (_, i) => ({ id: `${k}-${status}-${i}`, title: 'Job ' + i, status, startedAt: Date.now() - 60000 }));
const FLOOD = {
  ...BUSY,
  crews: [{ id: 'k1', title: 'Fix the build', state: 'working', lastAction: 'Edit' }, { id: 'k2', title: 'Docs', state: 'working', lastAction: 'Read' }, { id: 'k3', title: 'Plan', state: 'waiting', lastAction: 'Ask' }],
  street: Object.fromEntries(['chat', 'images', 'missions', 'garage', 'sheets', 'clock'].map(k => [k, { running: [{ id: k + '-r', title: 'Job', status: 'running', startedAt: Date.now() - 60000 }], waiting: 1, needsYou: many(k, 'awaiting_approval'), failedUnseen: many(k, 'failed'), recent: [] }]))
};
await check('Main Street strip with the flood of asks at night stays within its frame budget', async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, serviceWorkers: 'block' });
  await ctx.addInitScript(() => { try { localStorage.setItem('localai.firstRun.done', '1'); localStorage.setItem('localai.devTools', '1'); } catch {} });
  await ctx.route(u => u.pathname === '/api/world', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify(FLOOD) }));
  const page = await ctx.newPage();
  await page.clock.setFixedTime(new Date(2026, 9, 28, 21, 0));
  await page.goto(base + '/#home', { waitUntil: 'domcontentloaded' });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: SLOWDOWN });
  await page.waitForSelector('#homeStreet .street:not([hidden])', { timeout: 10000 });
  await page.waitForTimeout(3000);
  const s = await page.evaluate(() => window.LocalAIStreet.stats());
  assert.equal(s.night, true, 'the street is at night');
  assert.ok(s.beacons >= 1 && s.stalled >= 1, `the buildings in view show their asks: beacons ${s.beacons}, stalled ${s.stalled}`);
  assert.ok(s.frames > 0, 'the street drew frames');
  assert.ok(s.avgMs < 8, `avg frame ${s.avgMs} ms over ${s.frames} frames`);
  console.log(`  Main Street flood at night: ${s.frames} frames, avg ${s.avgMs} ms at ${SLOWDOWN}x slowdown, ${s.beacons} beacons, ${s.stalled} stalled`);
  await ctx.close();
});

await browser.close();
if (failures.length) { console.error(`\n${failures.length} performance check(s) failed`); process.exit(1); }
console.log('\nAll performance checks passed');
