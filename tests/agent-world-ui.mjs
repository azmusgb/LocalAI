import { chromium } from 'playwright';
import assert from 'node:assert/strict';

// Agent World lives on the Missions page, which sub-project 2 hid from the menus. Work › Missions links to it.
const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const browser = await chromium.launch({ headless: true });
const failures = [];
async function check(name, fn) { try { await fn(); console.log('PASS', name); } catch (e) { failures.push(`${name}: ${e.message}`); console.error('FAIL', name, e.message); } }

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
await browser.close();
if (failures.length) { console.error('\nAgent World failures:\n' + failures.map(x => ' - ' + x).join('\n')); process.exit(1); }
console.log('\nAll Agent World checks passed.');
