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

const page = await browser.newPage({ serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } });
// These checks cover the Build domain, which a fresh install hides until Developer tools is switched on.
await page.addInitScript(() => localStorage.setItem('localai.devTools', '1'));
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.ux-primary-rail');
// window.showView is published once app.js finishes binding, which can land after the rail renders.
await page.waitForFunction(() => typeof window.showView === 'function');

const secondaryLabels = () => page.locator('#uxSecondaryGroups .ux-link-label').allInnerTexts();
const crumbOf = async pg => (await pg.locator('.ux-context-left').innerText()).replace(/\s+/g, ' ').trim();
const crumb = () => crumbOf(page);

await check('home has one command surface and a short breadcrumb', async () => {
  await page.locator('.ux-primary-item[data-domain="home"]').click();
  await page.waitForSelector('#home.active');
  assert.equal(await page.locator('#home .quick').count(), 0);
  assert.equal(await page.locator('#commandInput').getAttribute('placeholder'), 'Ask anything, or describe a task…');
  assert.equal(await crumb(), 'Local AI / Home');
});

await check('change requests and the engineering agent are one page', async () => {
  await page.locator('.ux-primary-item[data-domain="improve"]').click();
  await page.waitForSelector('#backlog.active'); // Improve opens on its Backlog (sub-project 4)
  await page.evaluate(() => window.showView('changes'));
  await page.waitForSelector('#changes.active');
  const labels = await secondaryLabels();
  // Change requests opens from inside the app but has no menu entry: Improve › In progress shows the same changes.
  assert.ok(!labels.includes('Change requests'));
  assert.ok(labels.includes('In progress'));
  assert.ok(!labels.includes('Engineering agent'), 'Engineering agent should not have its own nav entry');
  assert.equal(await page.locator('#engineering').count(), 0);
  const options = await page.locator('#engineeringAttempts option').allInnerTexts();
  assert.ok(options.some(o => /^Plan only/.test(o)));
  await page.evaluate(() => window.showView('engineering'));
  await page.waitForSelector('#inProgress.active'); // the old engineering id means Improve › In progress now
});

await check('opening a page loads its data even without a nav button click', async () => {
  const waitForNotifications = page.waitForRequest(r => r.url().includes('/api/notifications'), { timeout: 5000 });
  await page.evaluate(() => window.showView('inbox'));
  await waitForNotifications;
});

for (const [parent, child, childTab, domain] of [
  // Issues / Quality signals are hidden while Signals (Improve) shows the same detections.
  ['inbox', 'approvals', 'Approvals', 'home'],
  ['projects', 'knowledge', 'Sources', 'projects'],
  ['projects', 'library', 'Everything you kept', 'projects'],
]) {
  await check(`${child} is a tab of ${parent}`, async () => {
    await page.locator(`.ux-primary-item[data-domain="${domain}"]`).click();
    // A domain with one page (Projects) has no page list beside the rail: the rail item opens that page.
    const link = page.locator(`.ux-secondary-link[data-view="${parent}"]`);
    const listed = await link.isVisible();
    if (listed) await link.click();
    await page.waitForSelector(`#${parent}.active`);
    const tabs = page.locator(`#${parent} .ux-tabs .ux-tab`);
    assert.ok(await tabs.count() >= 2);
    assert.equal(await page.locator(`#${parent} .ux-tab[data-ux-tab="${parent}"]`).getAttribute('aria-selected'), 'true');
    await page.locator(`#${parent} .ux-tab[data-ux-tab="${child}"]`).click();
    await page.waitForSelector(`#${child}.active`);
    assert.equal(await page.locator(`#${child} .ux-tab[data-ux-tab="${child}"]`).innerText(), childTab);
    assert.equal(await page.locator(`#${child} .ux-tab[data-ux-tab="${child}"]`).getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#uxContextView').innerText(), await page.locator(`#${child} h1`).first().innerText());
    if (listed) assert.ok((await link.getAttribute('class')).includes('active'), 'parent stays highlighted in the nav');
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

await check('opening a run keeps you on your page (open is false for an unknown id and moves nothing)', async () => {
  const before = await page.evaluate(() => location.hash);
  assert.equal(await page.evaluate(() => typeof window.LocalAIRuns.open), 'function');
  assert.equal(await page.evaluate(() => window.LocalAIRuns.open('no-such-run')), false);
  assert.equal(await page.evaluate(() => location.hash), before);
});

await check('page list collapses to the rail, shows the page strip, and remembers it', async () => {
  await page.evaluate(() => window.showView('models'));
  await page.locator('.ux-nav-collapse').click();
  assert.equal(await page.locator('.ux-secondary-nav').isVisible(), false);
  const strip = await page.locator('#uxPageStrip button').allInnerTexts();
  assert.ok(strip.includes('Health') && strip.includes('Models'), strip.join(','));
  assert.equal(await page.locator('#uxPageStrip [aria-current="page"]').innerText(), 'Models');
  await page.locator('#uxPageStrip [data-strip-view="status"]').click();
  await page.waitForSelector('#status.active');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.classList.contains('ux-nav-collapsed'));
  await page.locator('.ux-nav-expand').click();
  assert.equal(await page.locator('.ux-secondary-nav').isVisible(), true);
  assert.equal(await page.locator('#uxPageStrip').isVisible(), false);
});

await check('the Projects tab lands on Projects, and Library is its "Everything you kept" tab (D7)', async () => {
  await page.locator('.ux-primary-item[data-domain="projects"]').click();
  await page.waitForSelector('#projects.active');
  assert.equal(await page.evaluate(() => location.hash), '#projects');
  const tabs = await page.locator('#projects .ux-tabs .ux-tab').allInnerTexts();
  assert.ok(tabs.includes('Everything you kept'), tabs.join(','));
  assert.equal((await secondaryLabels()).includes('Library'), false, 'Library has no menu entry of its own');
  await page.locator('#projects .ux-tab[data-ux-tab="library"]').click();
  await page.waitForSelector('#library.active');
  assert.equal(await page.locator('#library h1').innerText(), 'Projects');
  assert.match(await crumb(), /Projects/);
  // An old #library link still opens it, as the tab of Projects.
  await page.evaluate(() => { location.hash = '#home' });
  await page.waitForSelector('#home.active');
  await page.evaluate(() => { location.hash = '#library' });
  await page.waitForSelector('#library.active');
  assert.equal(await page.locator('#library .ux-tab.active').innerText(), 'Everything you kept');
});

await check('no script errors while navigating', async () => {
  assert.deepEqual(pageErrors, []);
});
await page.close();

const mobile = await browser.newPage({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
await mobile.addInitScript(() => localStorage.setItem('localai.devTools', '1'));
await mobile.goto(base, { waitUntil: 'domcontentloaded' });
await mobile.waitForSelector('#uxMobileNav');
await mobile.waitForFunction(() => typeof window.showView === 'function');

await check('mobile sheet lists pages, not tabs', async () => {
  // Home itself shows the brand instead of the section menu, so open it from Inbox (same section).
  await mobile.evaluate(() => window.showView('inbox'));
  await mobile.locator('#uxContextMenu').click();
  await mobile.locator('#uxMobileSheet').waitFor({ state: 'visible' });
  const items = await mobile.locator('#uxMobileSheetItems .ux-mobile-link strong').allInnerTexts();
  assert.deepEqual(items, ['Home', 'Inbox']);
  await mobile.locator('#uxMobileSheetClose').click();
});

await check('Back closes the phone section sheet without leaving the page', async () => {
  await mobile.evaluate(() => window.showView('inbox'));
  await mobile.waitForSelector('#inbox.active');
  const before = await mobile.evaluate(() => ({ h: location.hash }));
  await mobile.locator('#uxContextMenu').click();
  await mobile.locator('#uxMobileSheet').waitFor({ state: 'visible' });
  assert.ok(await mobile.evaluate(() => !!history.state?.localaiSheet), 'the open sheet has a history entry');
  await mobile.evaluate(() => history.back());
  await mobile.waitForFunction(() => document.getElementById('uxMobileSheet').dataset.open === 'false');
  assert.equal(await mobile.evaluate(() => location.hash), before.h);
  assert.equal(await mobile.locator('#inbox.active').count(), 1);
  // Closing with the sheet's own button pops the entry; a link inside the sheet replaces it (one Back returns to where you were).
  await mobile.locator('#uxContextMenu').click();
  await mobile.locator('#uxMobileSheet').waitFor({ state: 'visible' });
  await mobile.locator('#uxMobileSheetClose').click();
  await mobile.waitForFunction(() => document.getElementById('uxMobileSheet').dataset.open === 'false');
  await mobile.waitForFunction(() => !history.state || !history.state.localaiSheet);
  assert.equal(await mobile.locator('#inbox.active').count(), 1);
  await mobile.locator('#uxContextMenu').click();
  await mobile.locator('#uxMobileSheet').waitFor({ state: 'visible' });
  await mobile.locator('#uxMobileSheetItems .ux-mobile-link', { hasText: 'Home' }).click();
  await mobile.waitForSelector('#home.active');
  assert.equal(await mobile.evaluate(() => location.hash), '#home');
  await mobile.evaluate(() => history.back());
  await mobile.waitForSelector('#inbox.active');
});

await check('mobile tab pages have no horizontal overflow', async () => {
  for (const view of ['issues', 'inbox', 'projects', 'changes']) {
    await mobile.evaluate(v => window.showView(v), view);
    await mobile.waitForSelector(`#${view}.active`);
    const dims = await mobile.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    assert.ok(dims.sw <= dims.cw + 2, `${view}: scrollWidth ${dims.sw} > clientWidth ${dims.cw}`);
  }
});
await check('phone: the page strip switches pages in the section in one tap', async () => {
  await mobile.locator('#uxMobileNav [data-domain="system"]').tap();
  await mobile.waitForSelector('#status.active');
  assert.equal(await mobile.locator('.ux-context-domain').innerText(), 'System');
  assert.ok((await mobile.locator('#uxPageStrip button').allInnerTexts()).includes('Models'));
  await mobile.locator('#uxPageStrip [data-strip-view="models"]').tap();
  await mobile.waitForSelector('#models.active');
  assert.equal(await mobile.locator('#uxPageStrip [aria-current="page"]').innerText(), 'Models');
  const h = await mobile.locator('#uxPageStrip button').first().evaluate(b => b.getBoundingClientRect().height);
  assert.ok(h >= 43.5 && h <= 52, `strip button height ${h}`);
});
await check('chat sends a valid threadId where crypto.randomUUID does not exist (plain http)', async () => {
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1000, height: 800 } });
  const pg = await ctx.newPage({ serviceWorkers: 'block' });
  const errs = [];
  pg.on('pageerror', e => errs.push(e.message));
  await pg.addInitScript(() => { delete crypto.randomUUID; });
  let body = null;
  // A glob like '**/api/chat**' no longer matches /api/chat/stream in current Playwright; match the path.
  await pg.route(u => u.pathname.startsWith('/api/chat'), route => {
    body = JSON.parse(route.request().postData() || '{}');
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'event: meta\ndata: {"model":"m","sources":[],"runId":"r1"}\n\nevent: done\ndata: {"elapsedMs":1,"model":"m","sources":[],"runId":"r1"}\n\n' });
  });
  await pg.goto(base, { waitUntil: 'domcontentloaded' });
  await pg.waitForFunction(() => typeof window.showView === 'function');
  await pg.evaluate(() => window.showView('ask'));
  await pg.fill('#chatInput', 'hello there');
  await pg.click('#sendBtn');
  for (let i = 0; i < 50 && !body; i++) await pg.waitForTimeout(100);
  assert.ok(body, 'chat request was sent');
  assert.match(body.threadId, /^t-[0-9a-f]{32}$/);
  assert.deepEqual(errs, []);
  await ctx.close();
});
await check('chat threadId survives a reload and changes after New conversation', async () => {
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1000, height: 800 } });
  const pg = await ctx.newPage({ serviceWorkers: 'block' });
  const ids = [];
  // A glob like '**/api/chat**' no longer matches /api/chat/stream in current Playwright; match the path.
  await pg.route(u => u.pathname.startsWith('/api/chat'), route => {
    ids.push(JSON.parse(route.request().postData() || '{}').threadId);
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'event: meta\ndata: {"model":"m","sources":[],"runId":"r1"}\n\nevent: done\ndata: {"elapsedMs":1,"model":"m","sources":[],"runId":"r1"}\n\n' });
  });
  const turn = async (n, text) => {
    await pg.evaluate(() => window.showView('ask'));
    await pg.fill('#chatInput', text); await pg.click('#sendBtn');
    for (let i = 0; i < 50 && ids.length < n; i++) await pg.waitForTimeout(100);
    assert.equal(ids.length, n, 'chat request ' + n + ' was sent');
    await pg.waitForTimeout(300);
  };
  await pg.goto(base, { waitUntil: 'domcontentloaded' });
  await pg.waitForFunction(() => typeof window.showView === 'function');
  await turn(1, 'first');
  await pg.reload({ waitUntil: 'domcontentloaded' });
  await pg.waitForFunction(() => typeof window.showView === 'function');
  await turn(2, 'second');
  assert.match(ids[0], /^t-[0-9a-f]{32}$/);
  assert.equal(ids[1], ids[0], 'same thread after reload');
  await pg.evaluate(() => { window.LocalAIUI.ask = async () => ({ ok: true }); });
  await pg.click('#newChatBtn'); await pg.waitForTimeout(300);
  await turn(3, 'third');
  assert.notEqual(ids[2], ids[0], 'new conversation starts a new thread');
  await ctx.close();
});
await mobile.close();

// Developer tools off (a new install): System's menu, the page strip and the phone sheet hold the owner's pages only.
// The developer pages still open by address, and the switch brings them back.
const OWNER_SYSTEM = ['Health', 'Models', 'Integrations', 'Automations', 'Monitors', 'Audit log'];
const DEV_SYSTEM = ['Claude Code', 'Files', 'Repository', 'PowerShell', 'Browser & computer', 'n8n workflows'];
await check('developer tools off: System lists the owner pages only; a developer page still opens by address', async () => {
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } });
  await ctx.addInitScript(() => { localStorage.setItem('localai.devTools', '0'); localStorage.setItem('localai.firstRun.done', '1'); });
  const pg = await ctx.newPage();
  const errs = []; pg.on('pageerror', e => errs.push(e.message));
  await pg.goto(base + '/#status', { waitUntil: 'domcontentloaded' });
  await pg.waitForFunction(() => typeof window.showView === 'function' && document.body.classList.contains('dev-tools-off'));
  await pg.waitForSelector('#status.active');
  assert.deepEqual(await pg.locator('#uxSecondaryGroups .ux-link-label').allInnerTexts(), OWNER_SYSTEM);
  assert.deepEqual(await pg.locator('#uxSecondaryGroups .ux-secondary-label').allInnerTexts(), ['Health', 'Automations', 'History'], 'an empty Tools group is not shown');
  await pg.locator('.ux-nav-collapse').click();
  assert.deepEqual(await pg.locator('#uxPageStrip button').allInnerTexts(), OWNER_SYSTEM);
  await pg.locator('.ux-nav-expand').click();
  // Deep links keep working, as Improve's do.
  await pg.evaluate(() => { location.hash = '#powershell'; });
  await pg.waitForSelector('#powershell.active');
  assert.equal(await crumbOf(pg), 'Local AI / System / PowerShell');
  assert.deepEqual(await pg.locator('#uxSecondaryGroups .ux-link-label').allInnerTexts(), OWNER_SYSTEM, 'the open developer page does not add itself to the menu');
  // The switch brings every developer page back, in place.
  await pg.evaluate(() => window.showView('status'));
  await pg.locator('.dev-tools-pref input').check();
  await pg.waitForFunction(() => !document.body.classList.contains('dev-tools-off'));
  const all = await pg.locator('#uxSecondaryGroups .ux-link-label').allInnerTexts();
  for (const label of [...OWNER_SYSTEM, ...DEV_SYSTEM]) assert.ok(all.includes(label), `${label} is listed with the switch on: ${all}`);
  await pg.locator('.ux-nav-collapse').click();
  assert.equal((await pg.locator('#uxPageStrip button').allInnerTexts()).length, OWNER_SYSTEM.length + DEV_SYSTEM.length);
  await pg.locator('.ux-nav-expand').click();
  // Switching it off while on a developer page returns to Home, as it does for Improve.
  await pg.evaluate(() => window.showView('workbench'));
  await pg.waitForSelector('#workbench.active');
  await pg.evaluate(() => document.querySelector('.dev-tools-pref input').click());
  await pg.waitForSelector('#home.active');
  assert.deepEqual(errs, []);
  await ctx.close();
});
await check('phone, developer tools off: the section sheet and page strip list the owner pages only', async () => {
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await ctx.addInitScript(() => { localStorage.setItem('localai.devTools', '0'); localStorage.setItem('localai.firstRun.done', '1'); });
  const pg = await ctx.newPage();
  await pg.goto(base + '/#status', { waitUntil: 'domcontentloaded' });
  await pg.waitForFunction(() => typeof window.showView === 'function' && document.body.classList.contains('dev-tools-off'));
  await pg.waitForSelector('#status.active');
  assert.deepEqual(await pg.locator('#uxPageStrip button').allInnerTexts(), OWNER_SYSTEM);
  await pg.locator('#uxContextMenu').click();
  await pg.locator('#uxMobileSheet').waitFor({ state: 'visible' });
  assert.deepEqual(await pg.locator('#uxMobileSheetItems .ux-mobile-link strong').allInnerTexts(), OWNER_SYSTEM);
  await ctx.close();
});
await browser.close();

if (failures.length) {
  console.error('\nNavigation failures:\n' + failures.map(x => ' - ' + x).join('\n'));
  process.exit(1);
}
console.log('\nAll navigation checks passed.');
