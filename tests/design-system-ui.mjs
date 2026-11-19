// Every view follows the design system: no text under 11px, blue primary actions, clean phone breadcrumb. Every check runs
// with the system set to dark and again set to light (step 13, L10): the page follows the system's theme.
import './browser-target-guard.mjs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const views = ['home','ask','create','library','projects','knowledge','memory','agents','claude','automations','automationStudio','actions','engineering','approvals','status','operations','activity','workbench','repoTools','powershell','inbox','runs','models'];
const browser = await chromium.launch();
let failed = 0;
let scheme = 'dark';
async function check(name, fn) { name = `${scheme}: ${name}`; try { await fn(); console.log('PASS', name) } catch (e) { failed++; console.log('FAIL', name, e.message) } }

for (scheme of ['dark', 'light']) {

const page = await browser.newPage({ serviceWorkers: 'block', colorScheme: scheme, viewport: { width: 1440, height: 900 } });
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
// The type scale's floor (E6): secondary text is at least 13 px on every owner page; only badges and pills go smaller.
// Missions (#agents) keeps its own type until its redesign.
await check('no visible text under 13px outside badges, on owner pages', async () => {
  const small = [];
  for (const v of views) {
    if (v === 'agents' || !await page.evaluate(v => { if (!document.getElementById(v)) return false; window.showView(v); return true }, v)) continue;
    await page.waitForTimeout(250);
    for (const t of await page.evaluate(() => [...document.querySelectorAll('main .view.active *, .ux-shell *')].filter(el => el.offsetParent && !el.closest('.badge,.pill,.statuschip,kbd,.awc,#agents,[data-diagnostic],svg') && [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) && parseFloat(getComputedStyle(el).fontSize) < 12.5).map(el => `${String(el.className || el.tagName).slice(0, 40)} ${getComputedStyle(el).fontSize}`))) small.push(`${v}: ${t}`);
  }
  assert.deepEqual([...new Set(small)], []);
});
await check('primary actions use the accent, not white', async () => {
  await page.evaluate(() => window.showView('agents'));
  const colors = await page.evaluate(() => [...document.querySelectorAll('.btn.primary,.btn-primary,.go')].filter(b => b.offsetParent).map(b => getComputedStyle(b).backgroundColor));
  assert.ok(colors.length > 0);
  for (const c of colors) assert.notEqual(c, 'rgb(238, 244, 255)', 'white primary button');
});
await check('one stylesheet of its own beside the kit\'s, nothing injected at runtime', async () => {
  const sheets = await page.evaluate(() => [...document.querySelectorAll('link[rel=stylesheet],style')].map(e => e.getAttribute('href') || 'inline <style>'));
  assert.deepEqual(sheets, ['/ui/tokens.css', '/ui/components.css', '/app.css', '/ui/needs.css']); // the kit's values, then its page parts (before app.css, so app.css wins a tie) and its Needs you rows
});
await page.close();

const foundation = await browser.newPage({ serviceWorkers: 'block', colorScheme: scheme, viewport: { width: 1440, height: 900 } });
const origin = new URL(base).origin;
const requested = [];
foundation.on('request', r => requested.push(r.url()));
await foundation.goto(base, { waitUntil: 'networkidle' });
await check('font is Archivo from /fonts and no cross-origin requests', async () => {
  const foreign = requested.filter(u => /^https?:/.test(u) && new URL(u).origin !== origin);
  assert.deepEqual(foreign, []);
  assert.ok(await foundation.evaluate(async () => { await document.fonts.load('16px Archivo'); return document.fonts.check('16px Archivo') }), 'Archivo not loaded');
  assert.ok(requested.some(u => u.includes('/fonts/archivo-latin-ui.woff2')), 'font not fetched from /fonts');
  const family = await foundation.evaluate(() => getComputedStyle(document.body).fontFamily);
  assert.match(family, /^"?Archivo/);
});
await check('icon sprite has every named symbol', async () => {
  const names = 'home workspace automate build system search bell chevron-down chevron-right send globe compose refresh image plus check x'.split(' ');
  const missing = await foundation.evaluate(n => n.filter(x => !document.querySelector(`symbol#i-${x}[viewBox="0 0 24 24"]`)), names);
  assert.deepEqual(missing, []);
});
await check('statusBadge maps statuses', async () => {
  const got = await foundation.evaluate(() => Object.fromEntries(['awaiting_approval','ready','needs_attention','applied','completed','answered','running','failed','queued','DOWN','HEALTHY','OPTIONAL_OFFLINE'].map(s => [s, window.LocalAIKit.statusBadge(s)])));
  const want = { awaiting_approval: ['Ready to review','accent'], ready: ['Ready to review','accent'], needs_attention: ['Needs a look','attention'], applied: ['Done','good'], completed: ['Done','good'], answered: ['Done','good'], running: ['Running','accent'], failed: ['Failed','bad'], queued: ['Queued','neutral'], DOWN: ['Down','bad'], HEALTHY: ['Healthy','good'], OPTIONAL_OFFLINE: ['Offline','neutral'] };
  for (const [k, [label, tone]] of Object.entries(want)) assert.deepEqual(got[k], { label, tone }, k);
  assert.match(await foundation.evaluate(() => window.LocalAIKit.badgeHtml('failed')), /badge--bad[^>]*>Failed</);
  assert.match(await foundation.evaluate(() => window.LocalAIKit.icon('home')), /<use href="#i-home"/);
});
await foundation.close();

const phone = await browser.newPage({ serviceWorkers: 'block', colorScheme: scheme, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await phone.goto(base, { waitUntil: 'networkidle' });
await check('phone breadcrumb shows no orphan separators', async () => {
  const seps = await phone.evaluate(() => [...document.querySelectorAll('.ux-context-sep')].filter(s => s.offsetParent).length);
  assert.equal(seps, 0);
});
await phone.close();

const shell = await browser.newPage({ serviceWorkers: 'block', colorScheme: scheme, viewport: { width: 1440, height: 900 } });
await shell.goto(base, { waitUntil: 'networkidle' });
// The page takes the system's theme from the kit's tokens.css, and the current page's rail item is readable in it (in
// light it was near-white on a pale teal until L10).
await check('the page follows the system theme and the current rail item reads at 4.5:1', async () => {
  const got = await shell.evaluate(() => {
    const rgb = c => (c.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
    const lum = ([r, g, b]) => [r, g, b].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
    const bg = rgb(getComputedStyle(document.body).backgroundColor);
    const item = document.querySelector('.ux-primary-item[data-active="true"] span:last-child');
    const fg = item ? rgb(getComputedStyle(item).color) : null;
    const [a, b] = fg ? [lum(fg), lum(bg)].sort((x, y) => y - x) : [0, 0];
    return { light: lum(bg) > 0.5, ratio: fg ? (a + 0.05) / (b + 0.05) : 0 };
  });
  assert.equal(got.light, scheme === 'light', 'page background');
  assert.ok(got.ratio >= 4.5, `current rail item at ${got.ratio.toFixed(2)}:1`);
});
await shell.close();
}
await browser.close();
if (failed) process.exit(1);
