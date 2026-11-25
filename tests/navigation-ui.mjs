import './browser-target-guard.mjs';
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
const crumbOf = async pg => (await pg.locator('.ux-context-left').innerText()).replace(/\s+/g, ' ').trim(); // this reads the rest
const crumb = () => crumbOf(page);

await check('home has one command surface and a short breadcrumb', async () => {
  await page.locator('.ux-primary-item[data-domain="home"]').click();
  await page.waitForSelector('#home.active');
  assert.equal(await page.locator('#home .quick').count(), 0);
  assert.equal(await page.locator('#commandInput').getAttribute('placeholder'), 'Ask anything, or describe a task…');
  assert.deepEqual(await stripLabels(), ['Overview', 'Decisions'], 'Home has its area\'s page strip');
  assert.doesNotMatch(await crumb(), /Local AI \//, 'no breadcrumb');
});

// System is one page, Assistant, with five cards and no strip row (kit 2.26.0, Pi Hub A27 D3). Each card opens its page,
// which starts with "← Assistant". Developer tools is a page of five tool cards (A27 D1), each tool with "← Developer tools".
const SYSTEM_CARDS = ['Assistant status', 'Models', 'Developer tools', 'Assistant settings', 'Audit log'];
const TOOL_CARDS = ['Files', 'Repository', 'PowerShell', 'Browser & computer', 'n8n workflows'];
const noStrip = async (pg, why) => assert.equal(await pg.locator('#uxPageStrip').isHidden(), true, `${why}: no strip row`);
const backTo = (pg, id) => pg.locator(`#${id} > .tool-back a`).getAttribute('href');
// Status and Connections are one page (navigation depth, D1): the cards sit under Services, the old address still works.
await check('System: one page of five cards, no strip row; Assistant status holds Connections', async () => {
  await page.locator('.ux-primary-item[data-domain="system"]').click();
  await page.waitForSelector('#system.active');
  assert.equal(await page.evaluate(() => location.hash), '#system');
  assert.equal(await page.title(), 'Assistant · Local AI');
  await noStrip(page, 'system');
  assert.deepEqual(await page.locator('#systemCards .tool-card strong').allInnerTexts(), SYSTEM_CARDS);
  await page.locator('#systemCards .tool-card', { hasText: 'Assistant status' }).click();
  await page.waitForSelector('#status.active');
  await noStrip(page, 'status');
  assert.equal(await backTo(page, 'status'), '#system');
  await page.waitForSelector('#statusConnections [data-integration-source-v2="n8n"]');
  assert.equal(await page.locator('#integrations').count(), 0, 'no page of its own');
  assert.equal(await page.locator('#statusRetryBtn').count(), 1, 'one Check again');
  assert.equal(await page.getByText('Connected services', { exact: true }).count(), 0, 'no second summary plate');
});

await check('#integrations opens Status, and #integrations?card=workshop brings the Workshop card into view', async () => {
  await page.evaluate(() => { location.hash = '#home'; });
  await page.waitForSelector('#home.active');
  await page.evaluate(() => { location.hash = '#integrations'; });
  await page.waitForSelector('#status.active');
  assert.equal(await page.evaluate(() => window.LocalAIViews.resolve('integrations')), 'status');
  assert.equal(await page.locator('.ux-primary-item[aria-current]').getAttribute('data-domain'), 'system');
  await page.evaluate(() => { location.hash = '#home'; });
  await page.waitForSelector('#home.active');
  await page.evaluate(() => { location.hash = '#integrations?card=workshop'; });
  await page.waitForSelector('#status.active');
  await page.waitForFunction(() => document.activeElement?.closest('.ux-int-card')?.querySelector('#ux-int-v2-workshop'), null, { timeout: 5000 });
  const r = await page.evaluate(() => { const b = document.querySelector('#ux-int-v2-workshop').closest('.ux-int-card').getBoundingClientRect(); return { top: b.top, bottom: b.bottom, vh: innerHeight }; });
  assert.ok(r.bottom > 0 && r.top < r.vh, `the Workshop card is on screen: ${JSON.stringify(r)}`);
});

// Every System card opens its page with the way back; Developer tools' cards open each tool at its own address with
// System lit and no tab; the kit's retired ids (tools-*, assistant-status, the two Changes stages) still land. Atlas is
// Improve's.
await check('System cards open their pages; Developer tools lists every tool; retired ids land; Architecture is Improve › Atlas', async () => {
  const ids = ['status', 'models', 'tools', 'settings', 'activity'];
  for (const [i, label] of SYSTEM_CARDS.entries()) {
    await page.evaluate(() => { location.hash = '#system'; });
    await page.waitForSelector('#system.active');
    await page.locator('#systemCards .tool-card', { hasText: label }).first().click();
    await page.waitForSelector(`#${ids[i]}.active`, { timeout: 5000 });
    assert.equal(await page.evaluate(() => location.hash), '#' + ids[i]);
    assert.equal(await backTo(page, ids[i]), '#system', `${ids[i]} has the way back`);
    assert.equal(await page.locator('.ux-primary-item[aria-current]').getAttribute('data-domain'), 'system');
    await noStrip(page, ids[i]);
  }
  assert.equal(await page.locator('#uxAdvancedStrip').count(), 0, 'no second strip');
  await page.evaluate(() => { location.hash = '#tools'; });
  await page.waitForSelector('#tools.active', { timeout: 5000 });
  assert.deepEqual(await page.locator('#toolsCards .tool-card strong').allInnerTexts(), TOOL_CARDS);
  for (const hash of ['workbench', 'repoTools', 'powershell', 'actions', 'automations']) {
    await page.evaluate(h => { location.hash = '#' + h; }, hash);
    await page.waitForSelector(`#${hash}.active`, { timeout: 5000 });
    assert.equal(await backTo(page, hash), '#tools', `${hash} goes back to Developer tools`);
    await noStrip(page, hash);
  }
  await page.locator('#automations > .tool-back a').click();
  await page.waitForSelector('#tools.active', { timeout: 5000 });
  await page.locator('#tools > .tool-back a').click();
  await page.waitForSelector('#system.active', { timeout: 5000 });
  for (const [old, now] of [['assistant-status', 'status'], ['tools-files', 'workbench'], ['tools-repository', 'repoTools'], ['tools-powershell', 'powershell'],
    ['tools-browser', 'actions'], ['tools-n8n', 'automations'], ['changes-in-progress', 'inProgress'], ['changes-shipped', 'shipped']]) {
    await page.evaluate(h => { location.hash = '#' + h; }, old);
    await page.waitForSelector(`#${now}.active`, { timeout: 5000 });
    assert.equal(await page.evaluate(() => location.hash), '#' + now, `#${old} lands on #${now}`);
  }
  await page.evaluate(() => { location.hash = '#tools'; });
  await page.waitForSelector('#tools.active', { timeout: 5000 });
  assert.equal(await page.locator('#toolsCards [data-tool="architecture"]').count(), 0, 'Architecture is not a tool card');
  await page.evaluate(() => { location.hash = '#architecture'; });
  await page.waitForSelector('#architecture.active', { timeout: 5000 });
  assert.equal(await crumbOf(page), 'Improve');
  assert.equal(await page.locator('#uxPageStrip [aria-current="page"]').innerText(), 'Atlas');
  assert.deepEqual(await stripLabels(), ['Changes', 'Signals', 'Research', 'Claude Code', 'Atlas']);
});

// One Changes page (navigation depth, D4): In progress and Shipped keep their addresses, light Changes and share its stage chips.
await check('Improve: Backlog, In progress and Shipped are one Changes page with stage chips', async () => {
  const stages = [['backlog', 'Backlog'], ['inProgress', 'In progress'], ['shipped', 'Shipped']];
  for (const [id, current] of stages) {
    await page.evaluate(h => { location.hash = '#' + h; }, id);
    await page.waitForSelector(`#${id}.active`, { timeout: 5000 });
    assert.deepEqual(await stripLabels(), ['Changes', 'Signals', 'Research', 'Claude Code', 'Atlas'], `${id} strip`);
    assert.equal(await page.locator('#uxPageStrip [aria-current="page"]').innerText(), 'Changes', `${id} lights Changes`);
    const chips = page.locator(`#${id} .changes-stages a`);
    assert.deepEqual(await chips.allInnerTexts(), ['Backlog', 'In progress', 'Shipped'], `${id} chips`);
    assert.deepEqual(await page.locator(`#${id} .changes-stages a[aria-current="page"]`).allInnerTexts(), [current], `${id} aria-current`);
    assert.deepEqual(await chips.evaluateAll(as => as.map(a => a.getAttribute('href'))), ['#backlog', '#inProgress', '#shipped']);
  }
  await page.locator('#shipped .changes-stages a', { hasText: 'Backlog' }).click();
  await page.waitForSelector('#backlog.active', { timeout: 5000 });
  assert.equal(await page.locator('#backlog h1').innerText(), 'Changes');
  await page.locator('#backlog .changes-stages a', { hasText: 'In progress' }).click();
  await page.waitForSelector('#inProgress.active', { timeout: 5000 });
  assert.equal(await page.evaluate(() => location.hash), '#inProgress');
});

// A strip has at most five items in every area (navigation depth). System has one page, so no strip row.
const STRIP_MAX = { work: 5, projects: 5, improve: 5, system: 1 };
await check('every area strip has at most 5 items', async () => {
  for (const area of ['work', 'projects', 'improve', 'system']) {
    await page.evaluate(h => { location.hash = '#' + h; }, area === 'improve' ? 'backlog' : area);
    await page.waitForSelector(`body[data-domain="${area}"]`, { timeout: 5000 });
    const n = await page.locator('#uxPageStrip button').count();
    assert.ok(n <= STRIP_MAX[area], `${area} strip has ${n} items`);
  }
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

// Agent World is a Work tab (Pi Hub A7 plan, decision 9): the top bar names Work, the strip lights Agent World. A hidden
// page that remains (Chat, Images) names itself in the top bar and lights the area that owns it.
await check('a hidden page names itself in the top bar and lights the area that owns it', async () => {
  await page.evaluate(() => window.showView('agents'));
  await page.waitForSelector('#agents.active');
  await page.waitForFunction(() => document.querySelector('#uxContextView')?.textContent === 'Work');
  assert.equal(await page.locator('.ux-primary-item[data-domain="work"]').getAttribute('aria-current'), 'true');
  assert.deepEqual(await stripLabels(), ['Work', 'Agent World', 'Assistant automations']);
  assert.equal(await page.title(), 'Agent World · Local AI');
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

// Spreadsheets (a Work kind) left Projects (2 Nov, D4): it opens by its address and ⌘K, lights the area that owns it,
// names itself in the top bar and shows no strip. Print lab left too, and since step 6's PR 6.4 its address sends the
// browser to Pi Hub's /lab (print-lab-ui checks that), so it isn't opened here.
for (const [id, domain, label] of [['spreadsheets', 'work', 'Spreadsheets']]) {
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
  ['work', 'automationStudio', 'Assistant automations', 'work', 'Work'],
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
// appliance reports (or says it has none) and links every part's deploys to Pi Hub's Versions (platform step 4).
await check('#deployments opens Shipped, with Running now above the releases', async () => {
  await page.evaluate(() => { location.hash = '#deployments'; });
  await page.waitForSelector('#shipped.active', { timeout: 5000 });
  const card = page.locator('#shipped #shippedNow');
  await card.waitFor();
  assert.equal(await card.locator('h2').innerText(), 'Running now');
  await page.waitForFunction(() => !/Checking/.test(document.querySelector('#shippedNow [data-dep-line]').textContent), null, { timeout: 10000 });
  assert.match(await card.innerText(), /reported by the appliance|has not reported a revision/);
  assert.doesNotMatch(await card.innerText(), /No deployment feed yet/);
  const versions = card.locator('a[data-dep-versions]');
  assert.equal(await versions.innerText(), 'Pi Hub › Versions');
  assert.match(await versions.getAttribute('href'), /^(https:\/\/hub\.rahe-home\.duckdns\.org|http:\/\/10\.0\.0\.80)\/versions$/);
  assert.equal(await versions.getAttribute('rel'), 'noopener');
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

await check('GridCraft is reachable from Status, and opens System › Spreadsheets', async () => {
  await page.evaluate(() => window.showView('integrations'));
  await page.waitForSelector('#status.active #statusConnections[data-integration-v2="true"]');
  await page.locator('[data-integration-source-v2="gridcraft"]').filter({ hasNotText: 'Checking' }).waitFor({ timeout: 8000 });
  const open = page.locator('#statusConnections [data-integration-view="spreadsheets"]');
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
  await page.evaluate(() => window.showView('signals'));
  await page.waitForSelector('#signals.active');
  const strip = await stripLabels();
  assert.ok(strip.includes('Changes') && strip.includes('Signals'), strip.join(','));
  assert.equal(await page.locator('#uxPageStrip [aria-current="page"]').innerText(), 'Signals');
  await page.locator('#uxPageStrip [data-strip-view="research"]').click();
  await page.waitForSelector('#research.active');
  assert.equal(await page.locator('#uxPageStrip [aria-current="page"]').innerText(), 'Research');
  assert.equal(await page.locator('.ux-secondary-nav, #uxSecondaryGroups, .ux-nav-collapse').count(), 0, 'no page list column');
});

await check('the Projects tab lands on Projects, and Library is its Library tab (D7)', async () => {
  await page.locator('.ux-primary-item[data-domain="projects"]').click();
  await page.waitForSelector('#projects.active');
  assert.equal(await page.evaluate(() => location.hash), '#projects');
  assert.deepEqual(await stripLabels(), ['Projects', 'Sources', 'Memory', 'Library']);
  await page.locator('#uxPageStrip [data-strip-view="library"]').click();
  await page.waitForSelector('#library.active');
  assert.equal(await page.locator('#library h1').innerText(), 'Library');
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
await check('phone: System opens its cards; a card opens its page in one tap, and the way back returns', async () => {
  await mobile.locator('#uxMobileNav [data-domain="system"]').tap();
  await mobile.waitForSelector('#system.active');
  assert.equal(await mobile.locator('.ux-context-domain').innerText(), 'System');
  await noStrip(mobile, 'system');
  const h = await mobile.locator('#systemCards .tool-card').first().evaluate(b => b.getBoundingClientRect().height);
  assert.ok(h >= 44, `card height ${h}`);
  await mobile.locator('#systemCards .tool-card', { hasText: 'Models' }).tap();
  await mobile.waitForSelector('#models.active');
  const back = mobile.locator('#models > .tool-back a');
  assert.ok((await back.evaluate(a => a.getBoundingClientRect().height)) >= 44, 'the way back is a full-size target');
  await back.tap();
  await mobile.waitForSelector('#system.active');
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
await check('phone, a new install: System shows Developer tools with no switch, and every System card is reachable', async () => {
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await ctx.addInitScript(() => { localStorage.removeItem('localai.devTools'); localStorage.setItem('localai.firstRun.done', '1'); });
  const pg = await ctx.newPage();
  const errs = []; pg.on('pageerror', e => errs.push(e.message));
  await pg.goto(base + '/#system', { waitUntil: 'domcontentloaded' });
  await pg.waitForFunction(() => typeof window.showView === 'function');
  await pg.waitForSelector('#system.active');
  assert.deepEqual(await pg.locator('#systemCards .tool-card strong').allInnerTexts(), SYSTEM_CARDS);
  await pg.locator('#systemCards .tool-card', { hasText: 'Audit log' }).click();
  await pg.waitForSelector('#activity.active');
  await pg.locator('#activity > .tool-back a').click();
  await pg.waitForSelector('#system.active');
  await pg.locator('#systemCards .tool-card', { hasText: 'Developer tools' }).click();
  await pg.waitForSelector('#tools.active #toolsCards .tool-card');
  assert.deepEqual(await pg.locator('#toolsCards .tool-card strong').allInnerTexts(), TOOL_CARDS);
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
  for (const view of ['system', 'projects', 'backlog']) {
    await pg.goto(base + '/#' + view, { waitUntil: 'domcontentloaded' });
    await pg.waitForSelector(`#${view}.active`);
    await pg.waitForTimeout(200);
    const off = await pg.evaluate(() => { const s = document.querySelector('#uxPageStrip').getBoundingClientRect(); return [...document.querySelectorAll('#uxPageStrip button')].filter(b => { const r = b.getBoundingClientRect(); return r.left < s.left - 1 || r.right > s.right + 1; }).map(b => b.textContent); });
    assert.deepEqual(off, [], `${view}: tabs off-screen`);
    // Improve's four items fit without scrolling; System's six still scroll until Connections joins Status (step 2).
    const fit = await pg.evaluate(() => { const s = document.querySelector('#uxPageStrip'); return [s.scrollWidth, s.clientWidth]; });
    if (view === 'backlog') assert.ok(fit[0] <= fit[1], `${view}: strip overflows (${fit[0]} > ${fit[1]})`);
  }
  await ctx.close();
});
await check('phone 390: System has no strip row, and Assistant and Status (with its cards) fit the width', async () => {
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await ctx.addInitScript(() => { localStorage.setItem('localai.firstRun.done', '1'); });
  const pg = await ctx.newPage();
  await pg.goto(base + '/#integrations', { waitUntil: 'domcontentloaded' });
  await pg.waitForSelector('#status.active');
  await pg.waitForSelector('#statusConnections [data-integration-source-v2="n8n"]');
  await noStrip(pg, 'status');
  for (const view of ['status', 'system', 'tools']) {
    if (view !== 'status') { await pg.evaluate(h => { location.hash = '#' + h; }, view); await pg.waitForSelector(`#${view}.active`); }
    const r = await pg.evaluate(() => ({ dw: document.documentElement.scrollWidth, dc: document.documentElement.clientWidth }));
    assert.ok(r.dw <= r.dc + 2, `${view} overflows: ${r.dw} > ${r.dc}`);
  }
  await ctx.close();
});
// Owner, 2 Nov: diagnostic details are a preference (Settings › Show diagnostic details), on by default, kept per browser.
await check('Settings: Show diagnostic details is on by default; off hides Health and Agent World diagnostics and survives a reload', async () => {
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } });
  await ctx.addInitScript(() => { localStorage.setItem('localai.firstRun.done', '1'); });
  const pg = await ctx.newPage();
  const errs = []; pg.on('pageerror', e => errs.push(e.message));
  await pg.goto(base + '/#settings', { waitUntil: 'domcontentloaded' });
  await pg.waitForSelector('#settings.active .diag-pref');
  const box = pg.locator('#settings [data-diagnostics-toggle]');
  assert.equal(await box.isChecked(), true, 'on by default');
  await pg.goto(base + '/#status', { waitUntil: 'domcontentloaded' });
  await pg.waitForSelector('#status.active');
  assert.equal(await pg.locator('#status details[data-diagnostic]').isVisible(), true, 'Advanced service details shown');
  await pg.goto(base + '/#settings', { waitUntil: 'domcontentloaded' });
  await pg.waitForSelector('#settings.active .diag-pref');
  await pg.locator('#settings .diag-pref').click();
  assert.equal(await box.isChecked(), false);
  assert.equal(await pg.evaluate(() => [document.body.classList.contains('diagnostics-off'), localStorage.getItem('localai.diagnostics')].join()), 'true,0');
  await pg.reload({ waitUntil: 'domcontentloaded' });
  await pg.waitForSelector('#settings.active .diag-pref');
  assert.equal(await pg.locator('#settings [data-diagnostics-toggle]').isChecked(), false, 'kept after reload');
  await pg.goto(base + '/#status', { waitUntil: 'domcontentloaded' });
  await pg.waitForSelector('#status.active');
  assert.equal(await pg.locator('#status details[data-diagnostic]').isVisible(), false, 'Advanced service details hidden');
  assert.equal(await pg.locator('#serviceList').isVisible(), true, 'services still shown');
  assert.equal(await pg.locator('.aw-start__dev').evaluate(el => getComputedStyle(el).display), 'none', 'Agent World Advanced hidden');
  assert.equal(await pg.locator('[data-aw-menu="demo"]').evaluate(el => getComputedStyle(el).display), 'none', 'demo hidden');
  assert.deepEqual(errs, []);
  await ctx.close();
});
await browser.close();

if (failures.length) {
  console.error('\nNavigation failures:\n' + failures.map(x => ' - ' + x).join('\n'));
  process.exit(1);
}
console.log('\nAll navigation checks passed.');
