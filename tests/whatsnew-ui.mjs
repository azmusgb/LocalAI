// Health › What's new and the one-time "Updated to …" notice. /api/releases is mocked.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const browser = await chromium.launch();
let failed = 0;
async function check(name, fn) { try { await fn(); console.log('PASS', name) } catch (e) { failed++; console.log('FAIL', name, e.message) } }
const releases = (version) => ({ current: { version, commit: 'cd9c7e4e466f4b5d674ed17abefb080efb358918', deployedAt: '2026-10-15T14:47:23Z' }, repoUrl: 'https://github.com/example/LocalAI',
  history: [{ version, commit: 'cd9c7e4e466f4b5d674ed17abefb080efb358918', deployedAt: '2026-10-15T14:47:23Z', notes: [{ title: 'Inbox: quieter badge', pr: 92 }, { title: 'No PR here' }] },
    { version: '2.0.190', commit: 'a'.repeat(40), deployedAt: '2026-10-14T10:00:00Z', notes: [] }] });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
let version = '2.0.204';
await context.route('**/api/releases', r => r.fulfill({ json: releases(version) }));
await context.addInitScript(() => localStorage.setItem('localai.firstRun.done', '1'));
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));

await check('first visit: no update notice, version remembered', async () => {
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  assert.equal(await page.locator('#toast.whatsnew-toast').count(), 0);
  assert.equal(await page.evaluate(() => localStorage.getItem('localai.seenVersion')), '2.0.204');
});
await check('What\'s new lists releases, their changes and PR links', async () => {
  await page.evaluate(() => window.showView('status'));
  await page.waitForSelector('#whatsNew .whatsnew-release');
  assert.match(await page.locator('#whatsNew').innerText(), /Version 2\.0\.204/);
  assert.deepEqual(await page.locator('#whatsNew .whatsnew-release[open] li').allInnerTexts(), ['Inbox: quieter badge #92', 'No PR here']);
  assert.equal(await page.locator('#whatsNew a[href$="/pull/92"]').count(), 1);
  assert.match(await page.locator('#whatsNew .whatsnew-release').nth(1).innerText(), /2\.0\.190/);
});
await check('after an update: one notice that opens What\'s new, not repeated', async () => {
  version = '2.0.210';
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('#toast.whatsnew-toast.show');
  assert.match(await page.locator('#toast').innerText(), /Updated to 2\.0\.210/);
  await page.click('.whatsnew-open');
  await page.waitForSelector('#status.active');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  assert.equal(await page.locator('#toast.whatsnew-toast.show').count(), 0);
});
await check('no script errors', async () => assert.deepEqual(errors, []));
await browser.close();
if (failed) { console.log(`${failed} what's-new check(s) failed`); process.exit(1) }
