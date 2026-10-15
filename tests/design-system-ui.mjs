// Every view follows the design system: no text under 11px, blue primary actions, clean phone breadcrumb.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const views = ['home','ask','create','library','projects','knowledge','memory','agents','claude','automations','automationStudio','actions','engineering','changes','approvals','status','operations','activity','quality','issues','workbench','repoTools','powershell','inbox','runs','models','integrations'];
const browser = await chromium.launch();
let failed = 0;
async function check(name, fn) { try { await fn(); console.log('PASS', name) } catch (e) { failed++; console.log('FAIL', name, e.message) } }

const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(base, { waitUntil: 'networkidle' });
await check('no visible text under 11px in any view', async () => {
  const tiny = [];
  for (const v of views) {
    if (!await page.evaluate(v => { if (!document.getElementById(v)) return false; window.showView(v); return true }, v)) continue;
    await page.waitForTimeout(250);
    for (const t of await page.evaluate(() => [...document.querySelectorAll('body *')].filter(el => el.offsetParent && [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) && parseFloat(getComputedStyle(el).fontSize) < 11).map(el => `${el.className || el.tagName} ${getComputedStyle(el).fontSize}`))) tiny.push(`${v}: ${t}`);
  }
  assert.deepEqual(tiny, []);
});
await check('primary actions use the accent, not white', async () => {
  await page.evaluate(() => window.showView('agents'));
  const colors = await page.evaluate(() => [...document.querySelectorAll('.btn.primary,.go')].filter(b => b.offsetParent).map(b => getComputedStyle(b).backgroundColor));
  assert.ok(colors.length > 0);
  for (const c of colors) assert.notEqual(c, 'rgb(238, 244, 255)', 'white primary button');
});
await check('design system stylesheet stays last', async () => {
  const last = await page.evaluate(() => [...document.head.querySelectorAll('link[rel=stylesheet],style')].pop()?.id);
  assert.equal(last, 'designSystemCss');
});
await page.close();

const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await phone.goto(base, { waitUntil: 'networkidle' });
await check('phone breadcrumb shows no orphan separators', async () => {
  const seps = await phone.evaluate(() => [...document.querySelectorAll('.ux-context-sep')].filter(s => s.offsetParent).length);
  assert.equal(seps, 0);
});
await browser.close();
if (failed) process.exit(1);
