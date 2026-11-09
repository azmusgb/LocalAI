// Page-open counter: opening pages is counted on this appliance, Settings › Pages you open lists the top ones, and Reset
// forgets them behind a confirmation. Needs a server with a throwaway data folder (the counts are shared, then reset).
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const browser = await chromium.launch();
let failed = 0;
async function check(name, fn) { try { await fn(); console.log('PASS', name) } catch (e) { failed++; console.log('FAIL', name, e.message) } }
async function open(hash = '#home') {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => { localStorage.setItem('localai.firstRun.done', '1'); });
  const page = await context.newPage();
  await page.goto(base + '/' + hash, { waitUntil: 'networkidle' });
  return { page, context };
}
const opens = async () => (await fetch(base + '/api/nav/opens?days=30')).json();

await check('three pages are counted once each and Settings lists them', async () => {
  await fetch(base + '/api/nav/opens', { method: 'DELETE' });
  const { page, context } = await open('#home');
  await page.waitForTimeout(1600); // Home's first paint is counted once, after the pause
  const posts = [];
  page.on('request', r => { if (r.url().endsWith('/api/nav/open') && r.method() === 'POST') posts.push(r.postDataJSON().view) });
  for (const view of ['work', 'models', 'work']) {
    await page.evaluate(v => window.LocalAIRouter.go('#' + v), view);
    await page.waitForFunction(v => document.body.dataset.view === v, view);
    await page.waitForTimeout(1600);
  }
  assert.deepEqual(posts, ['work', 'models', 'work'], 'one report per change');
  await page.evaluate(() => window.LocalAIRouter.go('#settings'));
  await page.waitForFunction(() => document.querySelectorAll('#pagesOpenList .pages-open-row').length >= 3);
  const rows = await page.locator('#pagesOpenList .pages-open-row').allInnerTexts();
  const text = rows.join('|').replace(/\s+/g, ' ');
  assert.match(text, /Work 2/); assert.match(text, /Models 1/); assert.match(text, /Home 1/);
  await context.close();
});

await check('the same page is never reported twice in a row', async () => {
  await fetch(base + '/api/nav/opens', { method: 'DELETE' });
  const { page, context } = await open('#work');
  await page.waitForTimeout(1600);
  await page.evaluate(() => window.LocalAIRouter.go('#work'));
  await page.waitForTimeout(1600);
  const work = (await opens()).find(x => x.view === 'work');
  assert.equal(work?.count, 1);
  await context.close();
});

await check('Reset asks first, then empties the card', async () => {
  const { page, context } = await open('#settings');
  await page.waitForFunction(() => document.querySelectorAll('#pagesOpenList .pages-open-row').length >= 1);
  await page.click('#pagesOpenReset');
  await page.locator('.ask-sheet__cancel').click();
  assert.ok((await opens()).length >= 1, 'cancel keeps the counts');
  await page.click('#pagesOpenReset');
  await page.locator('.ask-sheet__ok').click();
  await page.waitForFunction(() => document.querySelector('#pagesOpenList')?.textContent.includes('Nothing counted yet'));
  assert.equal(await page.locator('#pagesOpenReset').isHidden(), true);
  assert.deepEqual((await opens()).filter(x => x.view !== 'settings'), []);
  await context.close();
});

await check('a failed read is said plainly', async () => {
  const { page, context } = await open('#home');
  await page.route('**/api/nav/opens?*', r => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"storage busy"}' }));
  await page.evaluate(() => window.LocalAIRouter.go('#settings'));
  await page.waitForFunction(() => /Couldn't read the counts: storage busy/.test(document.querySelector('#pagesOpenList')?.textContent || ''));
  await context.close();
});

await check('a failing report never blocks navigation', async () => {
  const { page, context } = await open('#home');
  await page.route('**/api/nav/open', r => r.abort());
  await page.evaluate(() => window.LocalAIRouter.go('#models'));
  await page.waitForFunction(() => document.body.dataset.view === 'models');
  await page.waitForTimeout(1600);
  assert.equal(await page.evaluate(() => document.querySelector('.view.active')?.id), 'models');
  await context.close();
});

await browser.close();
process.exit(failed ? 1 : 0);
