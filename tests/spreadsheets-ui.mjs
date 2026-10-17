import { chromium, devices } from 'playwright';
import assert from 'node:assert/strict';

// Work › Spreadsheets: GridCraft requests from inside the app, on a computer and a phone. The bridge is stubbed.
const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const browser = await chromium.launch({ headless: true });
const failures = [];
async function check(name, fn) { try { await fn(); console.log('PASS', name); } catch (e) { failures.push(`${name}: ${e.message}`); console.error('FAIL', name, e.message); } }

async function open(options) {
  const page = await browser.newPage({ serviceWorkers: 'block', ...options });
  const runs = [];
  await page.route(u => u.pathname === '/api/gridcraft/health', r => r.fulfill({ json: { ok: true, gridcraftConnected: true, model: 'qwen3:4b-instruct' } }));
  await page.route(u => u.pathname === '/api/gridcraft/run', async r => {
    const { prompt } = JSON.parse(r.request().postData());
    runs.push(prompt);
    if (prompt.includes('break')) return r.fulfill({ status: 500, json: { ok: false, error: 'GridCraft agent failed', reason: 'httpx.ConnectError: connection refused' } });
    return r.fulfill({ json: { ok: true, answer: 'The Sales total is 48,250.', durationSec: 2 } });
  });
  await page.goto(base + '/#spreadsheets', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#spreadsheets.active');
  return { page, runs };
}

for (const [name, options] of [['computer', { viewport: { width: 1280, height: 900 } }], ['phone', devices['iPhone 14']]]) {
  const { page, runs } = await open(options);

  await check(`${name}: the page says GridCraft is ready`, async () => {
    await page.locator('#sheetsStatus[data-state="ready"]').waitFor({ timeout: 8000 });
    assert.equal(await page.locator('#sheetsStatus').innerText(), 'Ready');
  });

  await check(`${name}: an example fills the box, Run shows the answer`, async () => {
    await page.locator('[data-sheets-example="1"]').click();
    assert.match(await page.locator('#sheetsPrompt').inputValue(), /total of the Sales column/);
    await page.locator('#sheetsRun').click();
    await page.locator('#sheetsResult[data-kind="done"]').waitFor();
    assert.equal(await page.locator('#sheetsResultText').innerText(), 'The Sales total is 48,250.');
    assert.equal(await page.locator('#sheetsRetry').isVisible(), false);
    assert.equal(runs.length, 1);
  });

  await check(`${name}: a failure says why, keeps GridCraft "Ready", and Try again resends it`, async () => {
    await page.locator('#sheetsPrompt').fill('break the workbook');
    await page.locator('#sheetsRun').click();
    await page.locator('#sheetsResult[data-kind="error"]').waitFor();
    assert.match(await page.locator('#sheetsResultText').innerText(), /GridCraft agent failed: httpx\.ConnectError: connection refused/);
    await page.locator('#sheetsStatus[data-state="ready"]').waitFor();
    await page.locator('#sheetsRetry').click();
    await page.waitForFunction(() => document.querySelector('#sheetsRun')?.disabled === false && document.querySelector('#sheetsResult')?.dataset.kind === 'error');
    assert.equal(runs.length, 3);
  });

  await check(`${name}: nothing scrolls sideways`, async () => {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  });
  await page.close();
}

await check('the old /gridcraft.html address opens Spreadsheets', async () => {
  const page = await browser.newPage({ serviceWorkers: 'block' });
  await page.goto(base + '/gridcraft.html');
  await page.waitForSelector('#spreadsheets.active', { timeout: 10000 });
  await page.close();
});

await browser.close();
if (failures.length) { console.error('\nSpreadsheets failures:\n' + failures.map(x => ' - ' + x).join('\n')); process.exit(1); }
console.log('\nAll Spreadsheets checks passed.');
