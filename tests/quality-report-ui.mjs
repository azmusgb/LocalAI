import './browser-target-guard.mjs';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

// The page reports its own errors to /api/quality/client-event, but not the opaque "Script error." that browsers
// substitute for errors in scripts they consider foreign (extensions and the like).
const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ serviceWorkers: 'block' });
const reports = [];
await page.route('**/api/quality/client-event', async route => { reports.push(JSON.parse(route.request().postData() || '{}')); await route.fulfill({ status: 201, json: { item: {} } }); });
await page.goto(base, { waitUntil: 'load' });
await page.waitForFunction(() => typeof window.showView === 'function');
await page.waitForTimeout(500);
reports.length = 0;
let failed = 0;
try {
  await page.evaluate(() => window.dispatchEvent(new ErrorEvent('error', { message: 'Script error.' })));
  await page.evaluate(() => window.dispatchEvent(new ErrorEvent('error', { message: 'Boom', filename: `${location.origin}/ui.js`, lineno: 7, error: new Error('Boom') })));
  await page.waitForTimeout(500);
  assert.deepEqual(reports.map(r => r.message), ['Boom']);
  console.log('PASS opaque "Script error." is not reported; a real error is');
} catch (e) { failed++; console.error('FAIL', e.message); }
await browser.close();
if (failed) process.exit(1);
console.log('\nAll quality report checks passed.');
