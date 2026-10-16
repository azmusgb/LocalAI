// Keyboard and screen-reader basics for moving around: the tab title names the page, focus lands on the new page
// (not left on the menu), and the ⌘K palette is a real modal dialog that gives focus back when it closes.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const browser = await chromium.launch();
let failed = 0;
async function check(name, fn) { try { await fn(); console.log('PASS', name) } catch (e) { failed++; console.log('FAIL', name, e.message) } }
async function open(viewport = { width: 1440, height: 900 }) {
  const context = await browser.newContext({ viewport });
  await context.addInitScript(() => { localStorage.setItem('localai.firstRun.done', '1'); localStorage.setItem('localai.devTools', '1'); });
  const page = await context.newPage();
  await page.goto(base + '/#home', { waitUntil: 'networkidle' });
  return { page, context };
}
const inView = (page, id) => page.evaluate(i => !!document.activeElement?.closest('#' + i), id);

await check('the first load leaves focus alone and titles the tab', async () => {
  const { page, context } = await open();
  assert.equal(await page.title(), 'Local AI');
  assert.equal(await page.evaluate(() => document.activeElement === document.body), true);
  await context.close();
});

await check('choosing a page from the menu titles the tab and moves focus to that page', async () => {
  const { page, context } = await open();
  await page.click('.ux-primary-item[data-domain="system"]');
  await page.waitForFunction(() => document.title === 'Health · Local AI');
  await page.waitForFunction(() => !!document.activeElement?.closest('#status'), null, { timeout: 2000 }).catch(() => {});
  assert.equal(await inView(page, 'status'), true, 'focus is on the Health page');
  await page.click('#uxSecondaryGroups .ux-secondary-link[data-view="models"]');
  await page.waitForFunction(() => document.title === 'Models · Local AI');
  await page.waitForFunction(() => !!document.activeElement?.closest('#models'), null, { timeout: 2000 }).catch(() => {});
  assert.equal(await inView(page, 'models'), true, 'focus is on the Models page');
  await context.close();
});

await check('switching tabs inside a page keeps focus on the tab', async () => {
  const { page, context } = await open();
  await page.evaluate(() => { location.hash = '#issues' });
  await page.waitForSelector('#issues.active .ux-tab');
  const tab = page.locator('#issues .ux-tab', { hasText: 'Quality signals' });
  await tab.focus(); await tab.press('Enter');
  await page.waitForFunction(() => document.title === 'Quality signals · Local AI');
  await page.waitForFunction(() => !!document.activeElement?.closest('#quality .ux-tabs'), null, { timeout: 2000 }).catch(() => {});
  assert.match(await page.evaluate(() => document.activeElement?.textContent || ''), /Quality signals/);
  assert.equal(await page.evaluate(() => !!document.activeElement?.closest('.ux-tabs')), true);
  await context.close();
});

await check('⌘K is a modal dialog: focus stays inside, the highlighted page opens on Enter, Escape returns focus', async () => {
  const { page, context } = await open();
  await page.focus('#uxCommandBtn');
  await page.keyboard.press('Meta+k');
  await page.waitForFunction(() => document.getElementById('cmdk')?.open === true);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'cmdkInput');
  for (let i = 0; i < 12; i++) await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => !!document.activeElement?.closest('#cmdk')), true, 'Tab stays in the palette');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.getElementById('cmdk')?.open === false);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'uxCommandBtn', 'focus returns to what opened it');

  await page.click('#uxCommandBtn');
  await page.waitForFunction(() => document.getElementById('cmdk')?.open === true);
  await page.keyboard.type('model');
  // A combobox: focus stays in the search box and the highlighted option is aria-activedescendant.
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'cmdkInput');
  assert.match(await page.evaluate(() => document.getElementById(document.getElementById('cmdkInput').getAttribute('aria-activedescendant'))?.textContent || ''), /Models/);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.title === 'Models · Local AI');
  assert.equal(await page.evaluate(() => document.getElementById('cmdk').open), false);
  await page.waitForFunction(() => !!document.activeElement?.closest('#models'), null, { timeout: 2000 }).catch(() => {});
  assert.equal(await inView(page, 'models'), true, 'focus moves to the chosen page');

  await page.keyboard.press('Control+k');
  await page.waitForFunction(() => document.getElementById('cmdk')?.open === true);
  await page.keyboard.type('health');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.title === 'Health · Local AI');
  await context.close();
});

await check('closing the run view does not pull focus to the page heading', async () => {
  const { page, context } = await open();
  const now = new Date().toISOString();
  const run = { id: 'r1', type: 'chat', title: 'Hello', status: 'completed', progress: 100, updatedAt: now, createdAt: now, summary: 'x', output: 'x', events: [], pinned: false, projectId: null,
    card: { kind: 'chat', icon: 'compose', title: 'Hello', summary: 'x', badge: { label: 'Done', tone: 'good' }, preview: { type: 'text', text: 'x' }, action: { label: 'Open' }, approval: null } };
  await page.route(u => u.pathname === '/api/runs', r => { const id = new URL(r.request().url()).searchParams.get('id'); r.fulfill({ json: id ? { item: run } : { items: [run], summary: {} } }) });
  await page.evaluate(() => { location.hash = '#work' });
  const row = page.locator('.view.active .run-card').first(); await row.waitFor();
  await row.click();
  await page.waitForFunction(() => location.hash === '#run/r1', null, { timeout: 5000 });
  await page.locator('#runDrawer button').first().focus(); // as a user tabbing into it would
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => location.hash === '#work', null, { timeout: 5000 }).catch(async () => { throw new Error('Escape did not close: ' + await page.evaluate(() => location.hash)) });
  await page.waitForTimeout(300);
  assert.notEqual(await page.evaluate(() => document.activeElement?.tagName), 'H1');
  await context.close();
});

await browser.close();
if (failed) { console.log(`${failed} navigation accessibility check(s) failed`); process.exit(1) }
