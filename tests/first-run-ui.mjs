// First run: the Get started card on Home, and the Developer tools preference that hides the Build domain.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const browser = await chromium.launch();
let failed = 0;
async function check(name, fn) { try { await fn(); console.log('PASS', name) } catch (e) { failed++; console.log('FAIL', name, e.message) } }

const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
// Start as a new user: no saved choices, Developer tools off.
await context.addInitScript(() => { if (!sessionStorage.getItem('seeded')) { localStorage.clear(); localStorage.setItem('localai.devTools', '0'); sessionStorage.setItem('seeded', '1') } });
const page = await context.newPage({ serviceWorkers: 'block' });
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
await check('a missing model offers a one-click download', async () => {
  if (!expectCard || models.defaultInstalled) return;
  assert.equal(await page.locator('#firstRun [data-first-run-download]').isVisible(), true);
});
// One story: while Get started is on Home, Needs you does not repeat its step 1 as red "Fix" rows.
const status = await (await fetch(base + '/api/status')).json().catch(() => ({}));
const coreDown = (status.services || []).filter(s => s.required !== false && s.state !== 'HEALTHY');
await check('while Get started shows, Needs you lists no service rows', async () => {
  if (!expectCard) return;
  await page.waitForFunction(() => window.LocalAIHome && document.querySelector('#firstRun'));
  await page.waitForTimeout(300);
  assert.equal(await page.locator('#homeNeedsList .home-attn').count(), 0);
});
await check('a sample task that cannot start says what Chat needs; step 3 is done only once a run opens', async () => {
  if (!expectCard) return;
  const gated = await page.locator('.mode[data-mode="ask"]').isDisabled();
  await page.locator('#firstRun [data-sample="0"]').click();
  if (gated) {
    await page.waitForSelector('#homeComposerError:not([hidden])');
    assert.equal(await page.locator('#homeComposerError').innerText(), 'Chat needs Intelligence running. See Health');
    assert.equal(await page.locator('#firstRun [data-step="try"]').getAttribute('data-state'), 'todo', 'a failed send is not a done step');
    // A run opening (the pending run resolves to a real id) is what completes the step.
    await page.evaluate(() => window.LocalAIRuns.openPending({ kind: 'ask', title: 'Q' }).resolve('run_first'));
  } else {
    await page.waitForFunction(() => /^#run\/(?!pending)/.test(location.hash));
  }
  await page.waitForFunction(() => document.querySelector('#firstRun [data-step="try"]')?.dataset.state === 'done');
  await page.waitForLoadState('networkidle');
  // Leave the run view the way the owner would, so Home is clickable again.
  await page.evaluate(() => window.LocalAIRouter.go('#home'));
  await page.waitForSelector('#runDrawerBackdrop:not(.show)', { state: 'attached' });
  await page.evaluate(() => window.showView('home'));
});
await check('Health: a stopped core service says what to do about it', async () => {
  if (!coreDown.length) return;
  await page.evaluate(() => window.showView('status'));
  await page.waitForSelector('#status.active #serviceList .service-card');
  const card = page.locator('#serviceList .service-card', { hasText: 'Intelligence' });
  if (coreDown.some(s => s.name === 'ollama')) assert.match(await card.innerText(), /Start Ollama on the Windows host\./);
  assert.doesNotMatch(await page.locator('#serviceList').innerText(), /capability/i);
  await page.evaluate(() => window.showView('home'));
});
await check('Build is hidden while Developer tools is off', async () => {
  assert.equal(await page.locator('.ux-primary-item[data-domain="improve"]').isVisible(), false);
  assert.equal(await page.locator('.mode[data-mode="engineering"]').isVisible(), false);
});
await check('switching Developer tools on in Health shows Build and is remembered', async () => {
  await page.evaluate(() => window.showView('status'));
  await page.waitForSelector('#status.active .dev-tools-pref input');
  assert.match(await page.locator('.dev-tools-pref').innerText(), /Adds Improve to the menu: change requests, issues, quality signals and the Claude board\./);
  await page.locator('.dev-tools-pref input').check();
  assert.equal(await page.locator('.ux-primary-item[data-domain="improve"]').isVisible(), true);
  assert.equal(await page.evaluate(() => localStorage.getItem('localai.devTools')), '1');
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.locator('.ux-primary-item[data-domain="improve"]').isVisible(), true);
});
await check('Health shows the secure-connection card (the host itself counts as secure)', async () => {
  await page.evaluate(() => window.showView('status'));
  await page.waitForSelector('#status.active .secure-card[data-state]');
  assert.equal(await page.locator('.secure-card').getAttribute('data-state'), 'good');
});
await check('switching it off while on a Build page returns to Home', async () => {
  await page.evaluate(() => window.showView('status'));
  await page.evaluate(() => window.showView('backlog'));
  await page.evaluate(() => window.showView('status'));
  await page.locator('.dev-tools-pref input').uncheck();
  assert.equal(await page.locator('.ux-primary-item[data-domain="improve"]').isVisible(), false);
});
await check('dismissing Get started keeps it hidden after reload', async () => {
  if (!expectCard) return;
  await page.evaluate(() => window.showView('home'));
  await page.locator('#firstRun .first-run-foot [data-first-run-dismiss]').click();
  assert.equal(await page.locator('#firstRun').count(), 0);
  // With Get started gone, Needs you takes over the service rows.
  if (coreDown.length) await page.waitForFunction(() => document.querySelectorAll('#homeNeedsList .home-attn').length > 0);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  assert.equal(await page.locator('#firstRun').count(), 0);
});
await check('no script errors', async () => assert.deepEqual(errors, []));

await browser.close();
if (failed) { console.log(`${failed} first-run check(s) failed`); process.exit(1) }
