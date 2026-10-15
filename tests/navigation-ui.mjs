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
// These checks cover the Build domain, which a fresh install hides until Developer tools is switched on.
await page.addInitScript(() => localStorage.setItem('localai.devTools', '1'));
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.ux-primary-rail');
// window.showView is published once app.js finishes binding, which can land after the rail renders.
await page.waitForFunction(() => typeof window.showView === 'function');

const secondaryLabels = () => page.locator('#uxSecondaryGroups .ux-link-label').allInnerTexts();
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

await check('top bar shows one Inbox count and opens the right tab', async () => {
  // Stub the two sources so the real loaders produce known counts.
  const counts = { unread: 0, pending: 2 };
  await page.route('**/api/notifications', route => route.fulfill({ json: { items: [], unread: counts.unread } }));
  await page.route('**/api/approvals', route => route.fulfill({ json: { items: Array.from({ length: counts.pending }, (_, i) => ({ id: `a${i}`, status: 'pending', title: 'Approve change', createdAt: new Date().toISOString() })) } }));
  const refresh = async () => {
    for (const view of ['inbox', 'approvals']) {
      const loaded = page.waitForResponse(r => r.url().includes(view === 'inbox' ? '/api/notifications' : '/api/approvals'));
      await page.evaluate(v => window.showView(v), view);
      await loaded;
    }
    await page.evaluate(() => window.showView('home'));
  };
  try {
    await refresh();
    await page.waitForFunction(() => document.querySelector('#uxInboxCount')?.textContent === '2');
    await page.locator('#uxInboxBtn').click();
    await page.waitForSelector('#approvals.active');
    counts.unread = 3;
    await refresh();
    await page.waitForFunction(() => document.querySelector('#uxInboxCount')?.textContent === '5');
    await page.locator('#uxInboxBtn').click();
    await page.waitForSelector('#inbox.active');
    counts.unread = 0; counts.pending = 0;
    await refresh();
    await page.waitForFunction(() => document.querySelector('#uxInboxBtn')?.hidden === true);
  } finally {
    await page.unroute('**/api/notifications');
    await page.unroute('**/api/approvals');
  }
});

await check('GridCraft is reachable from Integrations', async () => {
  await page.evaluate(() => window.showView('integrations'));
  await page.waitForSelector('#integrations[data-integration-v2="true"]');
  const link = page.locator('#integrations a[href="/gridcraft.html"]');
  await link.waitFor({ state: 'visible' });
  assert.equal(await link.innerText(), 'Open GridCraft');
  await page.locator('[data-integration-source-v2="gridcraft"]').filter({ hasNotText: 'Checking' }).waitFor({ timeout: 8000 });
});

await check('audit log links runs to Runs', async () => {
  assert.equal(await page.evaluate(() => typeof window.LocalAIRuns.open), 'function');
  assert.equal(await page.evaluate(() => window.LocalAIRuns.open('no-such-run')), false);
  await page.waitForSelector('#runs.active');
});

await check('page list collapses to the rail, shows the page strip, and remembers it', async () => {
  await page.evaluate(() => window.showView('library'));
  await page.locator('.ux-nav-collapse').click();
  assert.equal(await page.locator('.ux-secondary-nav').isVisible(), false);
  assert.deepEqual(await page.locator('#uxPageStrip a').allInnerTexts(), ['Chat', 'Images', 'Library', 'Projects']);
  assert.equal(await page.locator('#uxPageStrip [aria-current="page"]').innerText(), 'Library');
  await page.locator('#uxPageStrip [data-strip-view="projects"]').click();
  await page.waitForSelector('#projects.active');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.classList.contains('ux-nav-collapsed'));
  await page.locator('.ux-nav-expand').click();
  assert.equal(await page.locator('.ux-secondary-nav').isVisible(), true);
  assert.equal(await page.locator('#uxPageStrip').isVisible(), false);
});

await check('no script errors while navigating', async () => {
  assert.deepEqual(pageErrors, []);
});
await page.close();

const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
await mobile.addInitScript(() => localStorage.setItem('localai.devTools', '1'));
await mobile.goto(base, { waitUntil: 'domcontentloaded' });
await mobile.waitForSelector('#uxMobileNav');
await mobile.waitForFunction(() => typeof window.showView === 'function');

await check('mobile sheet lists pages, not tabs', async () => {
  // Home's header is the brand; the Home section's page list opens from its other page, Inbox.
  await mobile.evaluate(() => window.showView('inbox'));
  await mobile.waitForSelector('#inbox.active');
  await mobile.locator('#uxHeaderDomain').click();
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
await check('phone: the page tabs switch pages in the section in one tap', async () => {
  await mobile.locator('#uxMobileNav [data-domain="workspace"]').tap();
  await mobile.waitForSelector('#ask.active');
  assert.equal(await mobile.locator('#uxHeaderDomain').innerText(), 'Workspace');
  assert.deepEqual(await mobile.locator('#uxPageStrip a').allInnerTexts(), ['Chat', 'Images', 'Library', 'Projects']);
  await mobile.locator('#uxPageStrip [data-strip-view="library"]').tap();
  await mobile.waitForSelector('#library.active');
  assert.equal(await mobile.locator('#uxPageStrip [aria-current="page"]').innerText(), 'Library');
  const h = await mobile.locator('#uxPageStrip a').first().evaluate(b => b.getBoundingClientRect().height);
  assert.ok(h >= 43.5 && h <= 44.5, `page tab height ${h}`);
});
await mobile.close();
await browser.close();

if (failures.length) {
  console.error('\nNavigation failures:\n' + failures.map(x => ' - ' + x).join('\n'));
  process.exit(1);
}
console.log('\nAll navigation checks passed.');
