import { chromium } from 'playwright';
import assert from 'node:assert/strict';

// Pinned pages (navigation depth, D2): pin from a page heading, Home's Pinned row, ⌘K's first group, unpin, the
// four-page limit and a save that fails. The server keeps the list, so each check starts by putting it right.
const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const browser = await chromium.launch({ headless: true });
const failures = [];
async function check(name, fn) { try { await fn(); console.log('PASS', name); } catch (e) { failures.push(`${name}: ${e.message}`); console.error('FAIL', name, e.message); } }
const setPins = ids => fetch(base + '/api/nav/pins', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) }).then(r => assert.equal(r.status, 200));

const page = await browser.newPage({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
const open = async hash => { await page.goto(base + '/' + hash, { waitUntil: 'domcontentloaded' }); await page.waitForFunction(h => document.body.dataset.view === h.slice(1) && window.LocalAIPins, hash); await page.evaluate(() => window.LocalAIPins.load()); };
const toggle = () => page.locator('.view.active [data-pin-toggle]');
const labels = sel => page.locator(sel).allInnerTexts().then(t => t.map(x => x.trim()));

await check('a page heading has a Pin button, off at first; Home has none', async () => {
  await setPins([]);
  await open('#models');
  assert.equal(await toggle().count(), 1);
  assert.equal(await toggle().getAttribute('aria-pressed'), 'false');
  await open('#backlog'); // a heading in the page anatomy (.ui-page__head)
  assert.equal(await page.locator('#backlog .ui-page__head [data-pin-toggle]').count(), 1);
  await open('#home');
  assert.equal(await page.locator('[data-pin-toggle]').count(), 0);
  assert.equal(await page.locator('#homePinned').isHidden(), true, 'Home hides the row when nothing is pinned');
});

await check('pressing Pin saves to the server, and Home shows the page in a Pinned row that opens it', async () => {
  await setPins([]);
  await open('#models');
  await toggle().click();
  await page.waitForFunction(() => document.querySelector('.view.active [data-pin-toggle]')?.getAttribute('aria-pressed') === 'true');
  assert.deepEqual((await (await fetch(base + '/api/nav/pins')).json()).ids, ['models']);
  await page.evaluate(() => { location.hash = '#home'; });
  await page.waitForSelector('#homePinned:not([hidden])');
  assert.deepEqual(await labels('#homePinnedList button'), ['Models']);
  await page.locator('#homePinnedList button', { hasText: 'Models' }).click();
  await page.waitForFunction(() => document.body.dataset.view === 'models');
});

await check('the palette lists pinned pages first, under Pinned', async () => {
  await setPins(['settings', 'models']);
  await open('#status');
  await page.keyboard.press('Control+k');
  await page.waitForSelector('#cmdk.show .cmdk-group');
  assert.equal((await labels('#cmdk .cmdk-group__label'))[0], 'Pinned');
  assert.deepEqual(await labels('#cmdk .cmdk-group:first-child [role=option]'), ['Assistant settings', 'Models']);
  assert.equal(await page.locator('#cmdk [role=option]').first().innerText(), 'Assistant settings');
  await page.keyboard.press('Escape');
});

await check('pressing the button again unpins; Home hides the row', async () => {
  await setPins(['models']);
  await open('#models');
  assert.equal(await toggle().getAttribute('aria-pressed'), 'true');
  await toggle().click();
  await page.waitForFunction(() => document.querySelector('.view.active [data-pin-toggle]')?.getAttribute('aria-pressed') === 'false');
  assert.deepEqual((await (await fetch(base + '/api/nav/pins')).json()).ids, []);
  await page.evaluate(() => { location.hash = '#home'; });
  await page.waitForFunction(() => document.getElementById('homePinned').hidden);
});

await check('with four pinned, pinning a fifth explains that unpinning one makes room, and saves nothing', async () => {
  await setPins(['work', 'projects', 'status', 'settings']);
  await open('#models');
  let puts = 0; page.on('request', r => { if (r.method() === 'PUT') puts++; });
  await toggle().click();
  await page.waitForSelector('.view.active [data-pin-note]');
  assert.match(await page.locator('.view.active [data-pin-note]').innerText(), /Unpin one to make room/);
  assert.equal(await toggle().getAttribute('aria-pressed'), 'false');
  assert.equal(puts, 0);
  assert.deepEqual((await (await fetch(base + '/api/nav/pins')).json()).ids, ['work', 'projects', 'status', 'settings']);
});

await check('a failed save shows an inline error and keeps the old state', async () => {
  await setPins([]);
  await open('#models');
  const fail = r => r.request().method() === 'PUT' ? r.fulfill({ status: 500, json: { error: 'disk full' } }) : r.continue();
  const pinsUrl = u => u.pathname === '/api/nav/pins';
  await page.route(pinsUrl, fail);
  await toggle().click();
  await page.waitForSelector('.view.active [data-pin-note]');
  assert.match(await page.locator('.view.active [data-pin-note]').innerText(), /Couldn't save your pins\. disk full/);
  assert.equal(await toggle().getAttribute('aria-pressed'), 'false');
  await page.unroute(pinsUrl, fail);
  assert.deepEqual((await (await fetch(base + '/api/nav/pins')).json()).ids, []);
});

await check('the button works from the keyboard and shows a focus ring', async () => {
  await setPins([]);
  await open('#models');
  await toggle().focus();
  await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab'); // keyboard focus, so :focus-visible applies
  assert.equal(await toggle().evaluate(el => el === document.activeElement), true);
  assert.notEqual(await toggle().evaluate(el => getComputedStyle(el).outlineStyle), 'none');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.view.active [data-pin-toggle]')?.getAttribute('aria-pressed') === 'true');
  await setPins([]);
});

await browser.close();
if (failures.length) { console.error('\nPins failures:\n' + failures.map(x => ' - ' + x).join('\n')); process.exit(1); }
console.log('\nAll pins checks passed.');
