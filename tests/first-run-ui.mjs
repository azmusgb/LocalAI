// First run: the Get started card on Home, and no developer-tools switch to find (navigation update, 2 Nov).
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const browser = await chromium.launch();
let failed = 0;
async function check(name, fn) { try { await fn(); console.log('PASS', name) } catch (e) { failed++; console.log('FAIL', name, e.message) } }

const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
// Start as a new user: no saved choices (an old developer-tools choice of off changes nothing).
await context.addInitScript(() => { if (!sessionStorage.getItem('seeded')) { localStorage.clear(); localStorage.setItem('localai.devTools', '0'); sessionStorage.setItem('seeded', '1') } });
const page = await context.newPage({ serviceWorkers: 'block' });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto(base, { waitUntil: 'networkidle' });
const runs = await (await fetch(base + '/api/runs?limit=1')).json();   // anything in Work means a first task was tried
const models = await (await fetch(base + '/api/models')).json().catch(() => ({}));
const expectCard = !models.defaultInstalled || !(runs.items || []).length;

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
  // Pi Hub's items (data-hub-need) aren't service rows; a server that can reach a real hub may list them.
  assert.equal(await page.locator('#homeNeedsList .ui-need:not([data-hub-need])').count(), 0);
});
await check('a sample task that cannot start says what Chat needs; step 3 is done only once a run opens', async () => {
  if (!expectCard) return;
  const gated = await page.locator('.mode[data-mode="ask"]').isDisabled();
  await page.locator('#firstRun [data-sample="0"]').click();
  if (gated) {
    await page.waitForSelector('#homeComposerError:not([hidden])');
    assert.equal(await page.locator('#homeComposerError').innerText(), 'Chat needs Intelligence running. See Assistant status');
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
// No developer-tools switch (2 Nov): a new install sees Improve and Tools, and Settings has no switch to find.
await check('a new install sees Improve and System › Tools, and Settings has no developer-tools switch', async () => {
  assert.equal(await page.locator('.ux-primary-item[data-domain="improve"]').isVisible(), true);
  await page.evaluate(() => window.showView('tools'));
  await page.waitForSelector('#tools.active #toolsCards .tool-card');
  assert.equal(await page.locator('#toolsCards .tool-card').count(), 5);
  await page.evaluate(() => window.showView('settings'));
  await page.waitForSelector('#settings.active');
  assert.equal(await page.locator('.dev-tools-pref').count(), 0);
});
await check('Health shows the secure-connection card (the host itself counts as secure)', async () => {
  await page.evaluate(() => window.showView('status'));
  await page.waitForSelector('#status.active .secure-card[data-state]');
  assert.equal(await page.locator('.secure-card').getAttribute('data-state'), 'good');
});
await check('dismissing Get started keeps it hidden after reload', async () => {
  if (!expectCard) return;
  await page.evaluate(() => window.showView('home'));
  await page.locator('#firstRun .first-run-foot [data-first-run-dismiss]').click();
  assert.equal(await page.locator('#firstRun').count(), 0);
  // With Get started gone, Needs you takes over the service rows.
  if (coreDown.length) await page.waitForFunction(() => document.querySelectorAll('#homeNeedsList .ui-need').length > 0);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  assert.equal(await page.locator('#firstRun').count(), 0);
});
await check('no script errors', async () => assert.deepEqual(errors, []));

await browser.close();
if (failed) { console.log(`${failed} first-run check(s) failed`); process.exit(1) }
