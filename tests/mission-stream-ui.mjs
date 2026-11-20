import './browser-target-guard.mjs';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

// A dropped mission stream says so above the faceplate ("Reconnecting"); once the browser reconnects, the notice goes away.
const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
let calls = 0;
await page.route('**/api/agents/missions/events*', route => (++calls === 1 ? route.abort('connectionreset') : route.continue()));
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof window.showView === 'function');
await page.evaluate(() => window.showView('agents'));
let failed = false;
try {
  await page.waitForFunction(() => /Reconnecting/.test(document.getElementById('awNotice')?.textContent || '') && !document.getElementById('awNotice').hidden, null, { timeout: 15000 });
  console.log('PASS a dropped stream says it is reconnecting');
  await page.waitForFunction(() => document.getElementById('awNotice').hidden, null, { timeout: 20000 });
  assert.ok(calls >= 2, 'the browser reconnected');
  console.log('PASS the notice clears once the stream is back');
} catch (e) { failed = true; console.error('FAIL mission stream reconnect notice', e.message); }
await page.unrouteAll({ behavior: 'ignoreErrors' });
await browser.close();
if (failed) process.exit(1);
console.log('\nAll mission stream checks passed.');
