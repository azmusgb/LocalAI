import { chromium } from 'playwright';
import assert from 'node:assert/strict';

// Phone: links and buttons inside text (Integrations guidance links, the Home setup card) are at least 44 px tall.
const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const browser = await chromium.launch({ headless: true });
const failures = [];
async function check(name, fn) {
  try { await fn(); console.log('PASS', name); } catch (error) { failures.push(`${name}: ${error.message}`); console.error('FAIL', name, error.message); }
}
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await page.goto(base + '/#home', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof window.showView === 'function');
const small = sel => page.evaluate(s => [...document.querySelectorAll(s)].filter(e => e.offsetParent).map(e => [e.textContent.trim().slice(0, 30), Math.round(e.getBoundingClientRect().height)]).filter(([, h]) => h < 44), sel);

await check('Integrations: guidance links are at least 44 px tall', async () => {
  await page.evaluate(() => window.showView('integrations'));
  await page.waitForSelector('.view.active .ux-int-research-grid a', { state: 'attached' });
  assert.deepEqual(await small('.view.active .ux-int-research-grid a'), []);
});

await check('Home setup card: its links and buttons are at least 44 px tall', async () => {
  await page.evaluate(() => window.showView('home'));
  const card = await page.waitForSelector('.first-run-steps', { timeout: 8000 }).catch(() => null);
  if (!card) return; // the setup card only shows while something is missing
  await page.waitForTimeout(1500);
  assert.deepEqual(await small('.first-run-steps a, .first-run-steps .btn'), []);
});

await browser.close();
if (failures.length) { console.error('\nTouch target failures:\n' + failures.map(x => ' - ' + x).join('\n')); process.exit(1); }
console.log('\nAll touch target checks passed.');
