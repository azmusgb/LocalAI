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
await check('one stylesheet, nothing injected at runtime', async () => {
  const sheets = await page.evaluate(() => [...document.querySelectorAll('link[rel=stylesheet],style')].map(e => e.getAttribute('href') || 'inline <style>'));
  assert.deepEqual(sheets, ['/app.css']);
});
await page.close();

const foundation = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const origin = new URL(base).origin;
const requested = [];
foundation.on('request', r => requested.push(r.url()));
await foundation.goto(base, { waitUntil: 'networkidle' });
await check('font is Figtree from /fonts and no cross-origin requests', async () => {
  const foreign = requested.filter(u => /^https?:/.test(u) && new URL(u).origin !== origin);
  assert.deepEqual(foreign, []);
  assert.ok(await foundation.evaluate(async () => { await document.fonts.load('16px Figtree'); return document.fonts.check('16px Figtree') }), 'Figtree not loaded');
  assert.ok(requested.some(u => u.includes('/fonts/figtree-latin-wght-normal.woff2')), 'font not fetched from /fonts');
  const family = await foundation.evaluate(() => getComputedStyle(document.body).fontFamily);
  assert.match(family, /^"?Figtree/);
});
await check('icon sprite has every named symbol', async () => {
  const names = 'home workspace automate build system search bell chevron-down chevron-right send globe compose refresh image plus check x'.split(' ');
  const missing = await foundation.evaluate(n => n.filter(x => !document.querySelector(`symbol#i-${x}[viewBox="0 0 24 24"]`)), names);
  assert.deepEqual(missing, []);
});
await check('statusBadge maps statuses', async () => {
  const got = await foundation.evaluate(() => Object.fromEntries(['awaiting_approval','ready','needs_attention','applied','complete','completed','answered','running','failed','queued','DOWN','HEALTHY','OPTIONAL_OFFLINE'].map(s => [s, window.LocalAIKit.statusBadge(s)])));
  const want = { awaiting_approval: ['Ready to review','accent'], ready: ['Ready to review','accent'], needs_attention: ['Needs a look','attention'], applied: ['Done','good'], complete: ['Done','good'], completed: ['Done','good'], answered: ['Done','good'], running: ['Running','accent'], failed: ['Failed','bad'], queued: ['Queued','neutral'], DOWN: ['Down','bad'], HEALTHY: ['Healthy','good'], OPTIONAL_OFFLINE: ['Offline','neutral'] };
  for (const [k, [label, tone]] of Object.entries(want)) assert.deepEqual(got[k], { label, tone }, k);
  assert.match(await foundation.evaluate(() => window.LocalAIKit.badgeHtml('failed')), /badge--bad[^>]*>Failed</);
  assert.match(await foundation.evaluate(() => window.LocalAIKit.icon('home')), /<use href="#i-home"/);
});
await foundation.close();

const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await phone.goto(base, { waitUntil: 'networkidle' });
await check('phone breadcrumb shows no orphan separators', async () => {
  const seps = await phone.evaluate(() => [...document.querySelectorAll('.ux-context-sep')].filter(s => s.offsetParent).length);
  assert.equal(seps, 0);
});
await browser.close();
if (failed) process.exit(1);
