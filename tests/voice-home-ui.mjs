import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const browser = await chromium.launch({ headless: true });
const failures = [];
async function check(label, fn) { try { await fn(); console.log('PASS', label); } catch (e) { failures.push(`${label}: ${e.message}`); console.error('FAIL', label, e.message); } }

const context = await browser.newContext({ viewport: { width: 1000, height: 800 }, serviceWorkers: 'block' });
const page = await context.newPage();
let home = {};
const posts = [];
await page.route('**/api/voice/home', route => {
  const req = route.request();
  if (req.method() === 'POST') {
    const { place } = JSON.parse(req.postData() || '{}');
    posts.push(place);
    if (/nowhere/i.test(place)) return route.fulfill({ status: 400, json: { error: "Couldn't find that place." } });
    home = { place: 'Phoenix', lat: 33.45, lon: -112.07, timeZone: 'America/Phoenix' };
    return route.fulfill({ json: home });
  }
  return route.fulfill({ json: home });
});
await page.goto(base, { waitUntil: 'load' });
await page.waitForFunction(() => typeof window.showView === 'function');
await page.evaluate(() => window.showView('status'));
await page.waitForSelector('#status.active .voice-home-pref');

await check('an unset home location says so', async () => {
  await page.waitForFunction(() => /Home location: Not set/.test(document.querySelector('.voice-home-pref')?.textContent || ''));
});

await check('Change… asks for a place and shows the saved one', async () => {
  await page.locator('.voice-home-pref button').click();
  await page.locator('.ask-sheet input').fill('Phoenix, AZ');
  await page.locator('.ask-sheet__ok').click();
  await page.waitForFunction(() => /Home location: Phoenix/.test(document.querySelector('.voice-home-pref')?.textContent || ''));
  assert.deepEqual(posts, ['Phoenix, AZ']);
});

await check('a place that cannot be found shows the reason and keeps the old home', async () => {
  await page.locator('.voice-home-pref button').click();
  await page.locator('.ask-sheet input').fill('nowhere');
  await page.locator('.ask-sheet__ok').click();
  await page.waitForFunction(() => /Couldn't find that place\./.test(document.querySelector('.voice-home-pref')?.textContent || ''));
  assert.match(await page.locator('.voice-home-pref').innerText(), /Home location: Phoenix/);
});

await browser.close();
if (failures.length) { console.error('\nVoice home failures:\n' + failures.map(x => ' - ' + x).join('\n')); process.exit(1); }
console.log('\nAll voice home checks passed.');
