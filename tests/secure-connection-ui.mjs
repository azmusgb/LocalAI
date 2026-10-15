import { chromium } from 'playwright';
import assert from 'node:assert/strict';

// The page must look like another device on the LAN (not localhost), so map a test name to the server.
const base = new URL(process.env.LOCALAI_URL || 'http://127.0.0.1:3080');
const name = 'localai.test';
const browser = await chromium.launch({ headless: true, args: [`--host-resolver-rules=MAP ${name} ${base.hostname}`] });
const failures = [];
async function check(label, fn) { try { await fn(); console.log('PASS', label); } catch (e) { failures.push(`${label}: ${e.message}`); console.error('FAIL', label, e.message); } }

const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const probes = [];
page.on('request', r => { if (r.url().startsWith(`https://${name}/`)) probes.push(r.url()); });
await page.goto(`http://${name}:${base.port}/`, { waitUntil: 'load' });
await page.waitForFunction(() => typeof window.showView === 'function');
await page.waitForTimeout(1500);

await check('no HTTPS trust probe while Health is closed', async () => {
  assert.deepEqual(probes, []);
});

await check('opening Health probes once, and reopening it does not probe again', async () => {
  await page.evaluate(() => window.showView('status'));
  await page.waitForSelector('#status.active .secure-card[data-state]');
  assert.equal(probes.length, 1);
  await page.evaluate(() => window.showView('home'));
  await page.evaluate(() => window.showView('status'));
  await page.waitForTimeout(500);
  assert.equal(probes.length, 1);
});

await check('the setup steps are folded and the card sits below the service list', async () => {
  assert.equal(await page.locator('.secure-card').getAttribute('data-state'), 'todo');
  assert.equal(await page.locator('.secure-setup').evaluate(d => d.open), false);
  assert.equal(await page.locator('.secure-steps').isVisible(), false);
  const below = await page.evaluate(() => {
    const services = document.getElementById('serviceList').closest('.card');
    return !!(services.compareDocumentPosition(document.querySelector('.secure-card')) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  assert.ok(below, 'secure card should follow the service list');
  await page.locator('.secure-setup > summary').click();
  assert.equal(await page.locator('.secure-steps').isVisible(), true);
});

await browser.close();
if (failures.length) { console.error('\nSecure connection failures:\n' + failures.map(x => ' - ' + x).join('\n')); process.exit(1); }
console.log('\nAll secure connection checks passed.');
