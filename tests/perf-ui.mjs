// Frame-time budget for Agent World, the one page that animates a canvas: while the demo mission plays, with the CPU
// slowed 4x (about a phone), frames stay at 30 fps or better and none takes 200 ms. Measured 2026-10-16: 60 fps
// (p95 16.8 ms), longest animation frame 86 ms, at both phone and desktop width.
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
    await page.evaluate(() => window.showView('agents'));
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

await browser.close();
if (failures.length) { console.error(`\n${failures.length} performance check(s) failed`); process.exit(1); }
console.log('\nAll performance checks passed');
