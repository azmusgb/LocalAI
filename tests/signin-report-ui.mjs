import './browser-target-guard.mjs';
import { chromium, devices } from 'playwright';
import assert from 'node:assert/strict';

// Assistant status › Sign-in (report only): the callers that would be refused, Clear list, and the empty state. The API is stubbed.
const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const browser = await chromium.launch({ headless: true });
const failures = [];
async function check(name, fn) { try { await fn(); console.log('PASS', name); } catch (e) { failures.push(`${name}: ${e.message}`); console.error('FAIL', name, e.message); } }

const ago = m => new Date(Date.now() - m * 60000).toISOString();
async function open(options) {
  const page = await browser.newPage({ serviceWorkers: 'block', ...options });
  let callers = [
    { ip: '10.0.0.37', kind: 'iPhone', count: 12, firstAt: ago(300), lastAt: ago(3), lastPath: '/api/status', lastMethod: 'GET' },
    { ip: '100.64.1.2', kind: 'Shortcuts', count: 1, firstAt: ago(120), lastAt: ago(120), lastPath: '/api/glance', lastMethod: 'GET' }
  ];
  await page.addInitScript(() => { localStorage.setItem('localai.firstRun.done', '1'); });
  await page.route(u => u.pathname === '/api/signin/report', r => r.fulfill({ json: { mode: 'report', since: ago(600), callers } }));
  await page.route(u => u.pathname === '/api/signin/report/clear', r => { callers = []; return r.fulfill({ json: { ok: true } }); });
  await page.goto(base + '/#settings', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#settings.active');
  return page;
}

for (const [name, options] of [['computer', { viewport: { width: 1280, height: 900 } }], ['phone', devices['iPhone 14']]]) {
  await check(`${name}: Health lists who would be refused, and Clear list empties it`, async () => {
    const page = await open(options);
    await page.locator('#signinList .signin-row').first().waitFor();
    const rows = await page.locator('#signinList .signin-row').allInnerTexts();
    assert.equal(rows.length, 2);
    assert.match(rows[0], /iPhone · 10\.0\.0\.37[\s\S]*12 requests, last 3 min ago: GET \/api\/status/);
    assert.match(rows[1], /Shortcuts · 100\.64\.1\.2[\s\S]*1 request, last 2 h ago: GET \/api\/glance/);
    await page.locator('#signinClear').click();
    await page.locator('#signinList', { hasText: 'came from a paired device' }).waitFor();
    assert.equal(await page.locator('#signinClear').isHidden(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'nothing scrolls sideways');
    await page.close();
  });
}

await browser.close();
if (failures.length) { console.error('\nSign-in report failures:\n' + failures.map(x => ' - ' + x).join('\n')); process.exit(1); }
console.log('\nAll sign-in report checks passed.');
