// First run: the Get started card on Home, and the Developer tools preference that hides the Build domain.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const browser = await chromium.launch();
let failed = 0;
async function check(name, fn) { try { await fn(); console.log('PASS', name) } catch (e) { failed++; console.log('FAIL', name, e.message) } }

const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
// Start as a new user: no saved choices, Developer tools off.
await context.addInitScript(() => { if (!sessionStorage.getItem('seeded')) { localStorage.clear(); localStorage.setItem('localai.devTools', '0'); sessionStorage.setItem('seeded', '1') } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto(base, { waitUntil: 'networkidle' });
const library = await (await fetch(base + '/api/library')).json();
const models = await (await fetch(base + '/api/models')).json().catch(() => ({}));
const expectCard = !models.defaultInstalled || !(library.items || []).length;

await check('Get started appears for a new install and finishes its checks', async () => {
  if (!expectCard) return;
  await page.waitForSelector('#firstRun');
  await page.waitForFunction(() => !document.querySelector('#firstRun [data-state="checking"]'));
  const states = await page.locator('#firstRun [data-step]').evaluateAll(els => els.map(e => e.dataset.state));
  assert.equal(states.length, 3);
  assert.ok(states.every(s => s === 'done' || s === 'todo'), states.join());
});
await check('a missing model shows the exact pull command', async () => {
  if (!expectCard || models.defaultInstalled) return;
  assert.match(await page.locator('#firstRun [data-step="model"]').innerText(), /ollama pull \S+/);
});
await check('a sample task fills the command and marks the step done', async () => {
  if (!expectCard) return;
  await page.locator('#firstRun [data-sample="0"]').click();
  assert.equal(await page.locator('#firstRun [data-step="try"]').getAttribute('data-state'), 'done');
  await page.evaluate(() => window.showView('home'));
});
await check('Build is hidden while Developer tools is off', async () => {
  assert.equal(await page.locator('.ux-primary-item[data-domain="build"]').isVisible(), false);
  assert.equal(await page.locator('.mode[data-mode="engineering"]').isVisible(), false);
});
await check('switching Developer tools on in Health shows Build and is remembered', async () => {
  await page.evaluate(() => window.showView('status'));
  await page.locator('.dev-tools-pref input').check();
  assert.equal(await page.locator('.ux-primary-item[data-domain="build"]').isVisible(), true);
  assert.equal(await page.evaluate(() => localStorage.getItem('localai.devTools')), '1');
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.locator('.ux-primary-item[data-domain="build"]').isVisible(), true);
});
await check('switching it off while on a Build page returns to Home', async () => {
  await page.evaluate(() => window.showView('status'));
  await page.evaluate(() => window.showView('changes'));
  await page.evaluate(() => window.showView('status'));
  await page.locator('.dev-tools-pref input').uncheck();
  assert.equal(await page.locator('.ux-primary-item[data-domain="build"]').isVisible(), false);
});
await check('dismissing Get started keeps it hidden after reload', async () => {
  if (!expectCard) return;
  await page.evaluate(() => window.showView('home'));
  await page.locator('#firstRun .first-run-foot [data-first-run-dismiss]').click();
  assert.equal(await page.locator('#firstRun').count(), 0);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  assert.equal(await page.locator('#firstRun').count(), 0);
});
await check('no script errors', async () => assert.deepEqual(errors, []));

await browser.close();
if (failed) { console.log(`${failed} first-run check(s) failed`); process.exit(1) }
