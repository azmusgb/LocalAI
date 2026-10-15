import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const browser = await chromium.launch({ headless: true });
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    console.log('PASS', name);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.error('FAIL', name, error.message);
  }
}

const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.ux-primary-rail');

const secondaryLabels = () => page.locator('#uxSecondaryGroups .ux-link-copy strong').allInnerTexts();
const crumb = async () => (await page.locator('.ux-context-left').innerText()).replace(/\s+/g, ' ').trim();

await check('home has one command surface and a short breadcrumb', async () => {
  await page.locator('.ux-primary-item[data-domain="home"]').click();
  await page.waitForSelector('#home.active');
  assert.equal(await page.locator('#home .quick').count(), 0);
  assert.equal(await page.locator('#commandInput').getAttribute('placeholder'), 'Ask anything, or describe a task…');
  assert.equal(await crumb(), 'Local AI / Home');
});

await check('change requests and the engineering agent are one page', async () => {
  await page.locator('.ux-primary-item[data-domain="build"]').click();
  await page.waitForSelector('#changes.active');
  const labels = await secondaryLabels();
  assert.ok(labels.includes('Change requests'));
  assert.ok(!labels.includes('Engineering agent'), 'Engineering agent should not have its own nav entry');
  assert.equal(await page.locator('#engineering').count(), 0);
  const options = await page.locator('#engineeringAttempts option').allInnerTexts();
  assert.ok(options.some(o => /^Plan only/.test(o)));
  await page.evaluate(() => window.showView('engineering'));
  await page.waitForSelector('#changes.active');
});

await check('opening a page loads its data even without a nav button click', async () => {
  const waitForNotifications = page.waitForRequest(r => r.url().includes('/api/notifications'), { timeout: 5000 });
  await page.evaluate(() => window.showView('inbox'));
  await waitForNotifications;
});

for (const [parent, child, childTab, domain] of [
  ['issues', 'quality', 'Quality signals', 'build'],
  ['inbox', 'approvals', 'Approvals', 'home'],
  ['projects', 'knowledge', 'Sources', 'workspace'],
]) {
  await check(`${child} is a tab of ${parent}`, async () => {
    await page.locator(`.ux-primary-item[data-domain="${domain}"]`).click();
    await page.locator(`.ux-secondary-link[data-view="${parent}"]`).click();
    await page.waitForSelector(`#${parent}.active`);
    const tabs = page.locator(`#${parent} .ux-tabs .ux-tab`);
    assert.ok(await tabs.count() >= 2);
    assert.equal(await page.locator(`#${parent} .ux-tab[data-ux-tab="${parent}"]`).getAttribute('aria-selected'), 'true');
    await page.locator(`#${parent} .ux-tab[data-ux-tab="${child}"]`).click();
    await page.waitForSelector(`#${child}.active`);
    assert.equal(await page.locator(`#${child} .ux-tab[data-ux-tab="${child}"]`).innerText(), childTab);
    assert.equal(await page.locator(`#${child} .ux-tab[data-ux-tab="${child}"]`).getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#uxContextView').innerText(), await page.locator(`#${child} h1`).first().innerText());
    assert.ok((await page.locator(`.ux-secondary-link[data-view="${parent}"]`).getAttribute('class')).includes('active'), 'parent stays highlighted in the nav');
    assert.ok(!(await secondaryLabels()).includes(childTab), `${childTab} should not have its own nav entry`);
  });
}

await check('no script errors while navigating', async () => {
  assert.deepEqual(pageErrors, []);
});
await page.close();

const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
await mobile.goto(base, { waitUntil: 'domcontentloaded' });
await mobile.waitForSelector('#uxMobileNav');

await check('mobile sheet lists pages, not tabs', async () => {
  await mobile.evaluate(() => document.querySelector('#uxMobileNav [data-domain="home"]')?.click());
  await mobile.locator('#uxContextMenu').click();
  await mobile.locator('#uxMobileSheet').waitFor({ state: 'visible' });
  const items = await mobile.locator('#uxMobileSheetItems .ux-mobile-link strong').allInnerTexts();
  assert.deepEqual(items, ['Home', 'Inbox']);
  await mobile.locator('#uxMobileSheetClose').click();
});

await check('mobile tab pages have no horizontal overflow', async () => {
  for (const view of ['issues', 'inbox', 'projects', 'changes']) {
    await mobile.evaluate(v => window.showView(v), view);
    await mobile.waitForSelector(`#${view}.active`);
    const dims = await mobile.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    assert.ok(dims.sw <= dims.cw + 2, `${view}: scrollWidth ${dims.sw} > clientWidth ${dims.cw}`);
  }
});
await mobile.close();
await browser.close();

if (failures.length) {
  console.error('\nNavigation failures:\n' + failures.map(x => ' - ' + x).join('\n'));
  process.exit(1);
}
console.log('\nAll navigation checks passed.');
