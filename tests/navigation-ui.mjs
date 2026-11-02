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
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.ux-primary-rail');
// window.showView is published once app.js finishes binding, which can land after the rail renders.
await page.waitForFunction(() => typeof window.showView === 'function');

// Navigation spec step 4: the rail picks the area; the page strip under the top bar lists its pages; the top bar names
// the area (a page without a strip, such as Missions, names itself).
const stripLabels = () => page.locator('#uxPageStrip button').allInnerTexts();
const crumbOf = async pg => (await pg.locator('.ux-context-left').innerText()).replace(/\s+/g, ' ').replace(/^← Pi Hub ?/, '').trim(); // "← Pi Hub" is in the bar of every page; this reads the rest
const crumb = () => crumbOf(page);

await check('home has one command surface and a short breadcrumb', async () => {
  await page.locator('.ux-primary-item[data-domain="home"]').click();
  await page.waitForSelector('#home.active');
  assert.equal(await page.locator('#home .quick').count(), 0);
  assert.equal(await page.locator('#commandInput').getAttribute('placeholder'), 'Ask anything, or describe a task…');
  assert.equal(await page.locator('#uxPageStrip').isVisible(), false, 'Home has no page strip');
  assert.doesNotMatch(await crumb(), /Local AI \//, 'no breadcrumb');
});

// System's strip is Health · Models · Services · Tools · Settings · Audit log (navigation update, 2 Nov). Tools is one
// page of cards; each System tool opens at its own address with Tools lit. Architecture is Improve's Atlas tab.
await check('System: Tools lists every tool, each opens at its address with Tools lit; Architecture is Improve › Atlas', async () => {
  await page.locator('.ux-primary-item[data-domain="system"]').click();
  await page.waitForSelector('#status.active');
  assert.deepEqual(await stripLabels(), ['Health', 'Models', 'Services', 'Tools', 'Settings', 'Audit log']);
  assert.equal(await page.locator('#uxAdvancedStrip').count(), 0, 'no second strip');
  await page.locator('#uxPageStrip [data-strip-view="tools"]').click();
  await page.waitForSelector('#tools.active', { timeout: 5000 });
  assert.deepEqual(await page.locator('#toolsCards .tool-card strong').allInnerTexts(), ['Files', 'Repository', 'PowerShell', 'Browser & computer', 'n8n workflows', 'Architecture']);
  for (const hash of ['workbench', 'repoTools', 'powershell', 'actions', 'automations']) {
    await page.evaluate(h => { location.hash = '#' + h; }, hash);
    await page.waitForSelector(`#${hash}.active`, { timeout: 5000 });
    assert.equal(await page.locator('#uxPageStrip [aria-current="page"]').innerText(), 'Tools', hash);
    assert.deepEqual(await stripLabels(), ['Health', 'Models', 'Services', 'Tools', 'Settings', 'Audit log'], `${hash} adds no tab`);
  }
  await page.evaluate(() => { location.hash = '#tools'; });
  await page.waitForSelector('#tools.active', { timeout: 5000 });
  await page.locator('#toolsCards [data-tool="architecture"]').click();
  await page.waitForSelector('#architecture.active', { timeout: 5000 });
  assert.equal(await crumbOf(page), 'Improve');
  assert.equal(await page.locator('#uxPageStrip [aria-current="page"]').innerText(), 'Atlas');
  assert.deepEqual(await stripLabels(), ['Backlog', 'Doing', 'Shipped', 'Signals', 'Claude', 'Atlas']);
});

// The legacy pages are retired (owner decision D4): their addresses land on the page that replaced them.
await check('retired pages are gone and their addresses land on Signals, In progress and Work', async () => {
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } });
  await ctx.addInitScript(() => { localStorage.setItem('localai.firstRun.done', '1'); });
  const pg = await ctx.newPage();
  const errs = [], missing = [];
  pg.on('pageerror', e => errs.push(e.message));
  pg.on('response', r => { if (r.status() === 404) missing.push(r.url()); });
  await pg.goto(base + '/#home', { waitUntil: 'domcontentloaded' });
  await pg.waitForFunction(() => typeof window.showView === 'function');
  for (const id of ['issues', 'quality', 'changes']) assert.equal(await pg.locator(`section#${id}`).count(), 0, `#${id} section is gone`);
  for (const [from, to] of [['issues', 'signals'], ['quality', 'signals'], ['changes', 'inProgress'], ['runs', 'work'], ['engineering', 'inProgress']]) {
    await pg.evaluate(h => { location.hash = h; }, '#' + from);
    await pg.waitForFunction(t => document.querySelector('.view.active')?.id === t, to, { timeout: 5000 });
  }
  const labels = await pg.locator('#uxPageStrip button').allInnerTexts();
  assert.ok(!labels.includes('Change requests') && !labels.includes('Issues'), `strip: ${labels}`);
  await pg.waitForTimeout(300);
  assert.deepEqual(errs, []);
  assert.deepEqual(missing, [], 'nothing 404s');
  await ctx.close();
});

// A hidden page that remains (Missions, Chat, Images) names itself in the top bar and lights the area that owns it.
await check('a hidden page names itself in the top bar and lights the area that owns it', async () => {
  await page.evaluate(() => window.showView('agents'));
  await page.waitForSelector('#agents.active');
  await page.waitForFunction(() => document.querySelector('#uxContextView')?.textContent === 'Missions');
  assert.equal(await crumb(), 'Missions');
  assert.equal(await page.locator('.ux-primary-item[data-domain="work"]').getAttribute('aria-current'), 'true');
  assert.equal(await page.locator('#uxPageStrip').isVisible(), false);
  await page.evaluate(() => window.showView('ask'));
  await page.waitForSelector('#ask.active');
  await page.waitForFunction(() => document.querySelector('#uxContextView')?.textContent === 'Chat');
  assert.equal(await crumb(), 'Chat');
  assert.equal(await page.locator('.ux-primary-item[data-domain="home"]').getAttribute('aria-current'), 'true');
  await page.evaluate(() => window.showView('home'));
});

await check('opening a page loads its data even without a nav button click', async () => {
  const waitForNotifications = page.waitForRequest(r => r.url().includes('/api/notifications'), { timeout: 5000 });
  await page.evaluate(() => window.showView('inbox'));
  await waitForNotifications;
});

// Spreadsheets (a Work kind) and Print lab (Pi Hub's, kept here until retired) left Projects (2 Nov, D4): each opens by
// its address and ⌘K, lights the area that owns it, names itself in the top bar and shows no strip.
for (const [id, domain, label] of [['spreadsheets', 'work', 'Spreadsheets'], ['printLab', 'home', 'Print lab']]) {
  await check(`${id} opens by address, lights ${domain} and names itself`, async () => {
    await page.evaluate(h => { location.hash = '#' + h; }, id);
    await page.waitForSelector(`#${id}.active`, { timeout: 5000 });
    assert.equal(await page.locator(`.ux-primary-item[data-domain="${domain}"]`).getAttribute('aria-current'), 'true');
    assert.equal(await page.locator('#uxContextView').innerText(), label);
    assert.equal(await page.locator('#uxPageStrip').isVisible(), false, 'no strip');
    assert.equal(await page.locator(`#${id} h1`).innerText(), label);
  });
}
for (const [parent, child, childTab, domain, area] of [
  ['projects', 'knowledge', 'Sources', 'projects', 'Projects'],
  ['projects', 'library', 'Library', 'projects', 'Projects'],
  ['work', 'automationStudio', 'Automations', 'work', 'Work'],
]) {
  await check(`${child} is a tab of ${parent}, in the strip`, async () => {
    await page.locator(`.ux-primary-item[data-domain="${domain}"]`).click();
    await page.waitForSelector(`#${parent}.active`);
    assert.equal(await page.locator(`#uxPageStrip [data-strip-view="${parent}"]`).getAttribute('aria-current'), 'page');
    await page.locator(`#uxPageStrip [data-strip-view="${child}"]`).click();
    await page.waitForSelector(`#${child}.active`);
    assert.equal(await page.locator('#uxPageStrip [aria-current="page"]').innerText(), childTab);
    assert.equal(await page.locator(`.ux-primary-item[data-domain="${domain}"]`).getAttribute('aria-current'), 'true', 'its area stays lit');
    assert.equal(await crumb(), area);
    assert.equal(await page.locator(`#${child} .ux-page-tabs, #${child} [role="tablist"][aria-label$=" sections"]`).count(), 0, 'no second row of page tabs');
  });
}

// Deployments merged into Shipped (2 Nov): the old address opens Shipped, whose Running now card names the revision the
// appliance reports (or says it has none) and says what is not connected.
await check('#deployments opens Shipped, with Running now above the releases', async () => {
  await page.evaluate(() => { location.hash = '#deployments'; });
  await page.waitForSelector('#shipped.active', { timeout: 5000 });
  const card = page.locator('#shipped #shippedNow');
  await card.waitFor();
  assert.equal(await card.locator('h2').innerText(), 'Running now');
  await page.waitForFunction(() => !/Checking/.test(document.querySelector('#shippedNow [data-dep-line]').textContent), null, { timeout: 10000 });
  assert.match(await card.innerText(), /reported by the appliance|has not reported a revision/);
  assert.match(await card.innerText(), /No deployment feed yet for Workshop OS/);
  assert.ok(await page.evaluate(() => { const c = document.getElementById('shippedNow'), l = document.getElementById('shippedList'); return !!(c.compareDocumentPosition(l) & Node.DOCUMENT_POSITION_FOLLOWING); }), 'Running now comes before the releases');
});

// The bell (navigation update, 2 Nov): on every page, desktop too, its number is Home's "Needs you · N", and it opens Home
// at Needs you. History beside that heading opens the Inbox.
await check('the bell shows Needs you\'s number on every page and opens Home at Needs you', async () => {
  // Two approvals waiting, so Needs you has rows whatever else the server holds.
  await page.route('**/api/approvals', route => route.fulfill({ json: { items: [0, 1].map(i => ({ id: `bell${i}`, status: 'pending', title: 'Approve change', createdAt: new Date().toISOString() })) } }));
  try {
  await page.evaluate(() => window.showView('home'));
  await page.evaluate(() => window.LocalAIHome.refresh());
  const n = await page.evaluate(() => document.querySelector('#homeNeedsCount').textContent.replace(/\D/g, ''));
  assert.ok(Number(n) >= 2, `Needs you counts the approvals: ${n}`);
  for (const view of ['home', 'status', 'backlog', 'work']) {
    await page.evaluate(v => window.showView(v), view);
    assert.equal(await page.locator('#uxInboxBtn').isVisible(), true, `bell on ${view}`);
    assert.equal(await page.locator('#uxInboxCount').innerText(), n, `bell number on ${view}`);
  }
  await page.locator('#uxInboxBtn').click();
  await page.waitForSelector('#home.active');
  await page.waitForFunction(() => document.activeElement?.id === 'homeNeedsTitle', null, { timeout: 4000 });
  await page.locator('#homeHistory').click();
  await page.waitForSelector('#inbox.active');
  } finally { await page.unroute('**/api/approvals'); }
});

await check('GridCraft is reachable from Services, and opens System › Spreadsheets', async () => {
  await page.evaluate(() => window.showView('integrations'));
  await page.waitForSelector('#integrations[data-integration-v2="true"]');
  await page.locator('[data-integration-source-v2="gridcraft"]').filter({ hasNotText: 'Checking' }).waitFor({ timeout: 8000 });
  const open = page.locator('#integrations [data-integration-view="spreadsheets"]');
  await open.waitFor({ state: 'visible' });
  assert.equal(await open.innerText(), 'Open Spreadsheets');
  await open.click();
  await page.waitForSelector('#spreadsheets.active');
});

await check('opening a run keeps you on your page (open is false for an unknown id and moves nothing)', async () => {
  const before = await page.evaluate(() => location.hash);
  assert.equal(await page.evaluate(() => typeof window.LocalAIRuns.open), 'function');
  assert.equal(await page.evaluate(() => window.LocalAIRuns.open('no-such-run')), false);
  assert.equal(await page.evaluate(() => location.hash), before);
});

await check('the page strip switches pages in the area and marks the open one', async () => {
  await page.evaluate(() => window.showView('models'));
  await page.waitForSelector('#models.active');
  const strip = await stripLabels();
  assert.ok(strip.includes('Health') && strip.includes('Models'), strip.join(','));
  assert.equal(await page.locator('#uxPageStrip [aria-current="page"]').innerText(), 'Models');
  await page.locator('#uxPageStrip [data-strip-view="status"]').click();
  await page.waitForSelector('#status.active');
  assert.equal(await page.locator('#uxPageStrip [aria-current="page"]').innerText(), 'Health');
  assert.equal(await page.locator('.ux-secondary-nav, #uxSecondaryGroups, .ux-nav-collapse').count(), 0, 'no page list column');
});

await check('the Projects tab lands on Projects, and Library is its Library tab (D7)', async () => {
  await page.locator('.ux-primary-item[data-domain="projects"]').click();
  await page.waitForSelector('#projects.active');
  assert.equal(await page.evaluate(() => location.hash), '#projects');
  assert.deepEqual(await stripLabels(), ['Projects', 'Sources', 'Memory', 'Library']);
  await page.locator('#uxPageStrip [data-strip-view="library"]').click();
  await page.waitForSelector('#library.active');
  assert.equal(await page.locator('#library h1').innerText(), 'Projects');
  // An old #library link still opens it, as the tab of Projects.
  await page.evaluate(() => { location.hash = '#home' });
  await page.waitForSelector('#home.active');
  await page.evaluate(() => { location.hash = '#library' });
  await page.waitForSelector('#library.active');
  assert.equal(await page.locator('#uxPageStrip [aria-current="page"]').innerText(), 'Library');
});

await check('no script errors while navigating', async () => {
  assert.deepEqual(pageErrors, []);
});
await page.close();

const mobile = await browser.newPage({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
await mobile.goto(base, { waitUntil: 'domcontentloaded' });
await mobile.waitForSelector('#uxMobileNav');
await mobile.waitForFunction(() => typeof window.showView === 'function');

await check('phone: no section menu; the strip lists the pages and tabs of the area', async () => {
  await mobile.evaluate(() => window.showView('projects'));
  await mobile.waitForSelector('#projects.active');
  assert.equal(await mobile.locator('#uxContextMenu, #uxMobileSheet').count(), 0, 'the ⌄ sheet is gone');
  assert.deepEqual(await mobile.locator('#uxPageStrip button').allInnerTexts(), ['Projects', 'Sources', 'Memory', 'Library']);
  await mobile.locator('#uxPageStrip [data-strip-view="memory"]').click();
  await mobile.waitForSelector('#memory.active');
  await mobile.evaluate(() => history.back());
  await mobile.waitForSelector('#projects.active');
});

await check('mobile tab pages have no horizontal overflow', async () => {
  for (const view of ['inbox', 'projects', 'signals', 'inProgress']) {
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

// No switch (D1): a new install sees the same System strip and Tools page as any other, on a phone too.
await check('phone, a new install: System shows Tools with no switch, and every System tab is reachable', async () => {
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await ctx.addInitScript(() => { localStorage.removeItem('localai.devTools'); localStorage.setItem('localai.firstRun.done', '1'); });
  const pg = await ctx.newPage();
  const errs = []; pg.on('pageerror', e => errs.push(e.message));
  await pg.goto(base + '/#status', { waitUntil: 'domcontentloaded' });
  await pg.waitForFunction(() => typeof window.showView === 'function');
  await pg.waitForSelector('#status.active');
  assert.deepEqual(await pg.locator('#uxPageStrip button').allInnerTexts(), ['Health', 'Models', 'Services', 'Tools', 'Settings', 'Audit log']);
  await pg.locator('#uxPageStrip [data-strip-view="activity"]').click();
  await pg.waitForSelector('#activity.active');
  await pg.locator('#uxPageStrip [data-strip-view="tools"]').click();
  await pg.waitForSelector('#tools.active #toolsCards .tool-card');
  assert.equal(await pg.locator('.dev-tools-pref, [data-dev-tools-toggle]').count(), 0, 'no developer-tools switch');
  assert.deepEqual(errs, []);
  await ctx.close();
});
// Acceptance (2 Nov): at 390 px no page strip has a tab off-screen. The phone strip is compact (13 px, 16 px gaps; owner,
// 2 Nov). Improve fits since Deployments merged into Shipped (step 4).
await check('phone 390: the System, Projects and Improve strips have every tab on screen', async () => {
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await ctx.addInitScript(() => { localStorage.setItem('localai.firstRun.done', '1'); });
  const pg = await ctx.newPage();
  for (const view of ['status', 'projects', 'backlog']) {
    await pg.goto(base + '/#' + view, { waitUntil: 'domcontentloaded' });
    await pg.waitForSelector(`#${view}.active`);
    await pg.waitForTimeout(200);
    const off = await pg.evaluate(() => { const s = document.querySelector('#uxPageStrip').getBoundingClientRect(); return [...document.querySelectorAll('#uxPageStrip button')].filter(b => { const r = b.getBoundingClientRect(); return r.left < s.left - 1 || r.right > s.right + 1; }).map(b => b.textContent); });
    assert.deepEqual(off, [], `${view}: tabs off-screen`);
  }
  await ctx.close();
});
await browser.close();

if (failures.length) {
  console.error('\nNavigation failures:\n' + failures.map(x => ' - ' + x).join('\n'));
  process.exit(1);
}
console.log('\nAll navigation checks passed.');
