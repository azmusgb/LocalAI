import { chromium, devices } from 'playwright';
import assert from 'node:assert/strict';

// Work › Spreadsheets: GridCraft requests from inside the app, on a computer and a phone. The bridge is stubbed.
const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const browser = await chromium.launch({ headless: true });
const failures = [];
async function check(name, fn) { try { await fn(); console.log('PASS', name); } catch (e) { failures.push(`${name}: ${e.message}`); console.error('FAIL', name, e.message); } }

async function until(fn, what, ms = 5000) {
  for (const end = Date.now() + ms; !fn();) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise(r => setTimeout(r, 50)); }
}

async function open(options) {
  const page = await browser.newPage({ serviceWorkers: 'block', ...options });
  const runs = [], reads = { workbook: 0, ranges: [], opened: [] };
  const book = { ok: true, title: 'Quarterly Sales', file: 'Quarterly-Sales-Dashboard.xlsx', dirty: true, activeSheet: 'Sales',
    sheets: [{ name: 'Sales', usedRange: 'A1:AN250', cells: 900 }, { name: 'Notes', usedRange: 'A1:B2', cells: 2 }, { name: 'Blank', usedRange: null, cells: 0 }] };
  const wide = Array.from({ length: 200 }, (_, r) => Array.from({ length: 30 }, (_, c) => r === 0 ? `Column ${c + 1} heading` : r * 100 + c));
  wide[1][1] = 'North'; wide[1][2] = { error: '#DIV/0!' }; wide[1][3] = null; wide[1][4] = '$1,250.00';
  await page.route(u => u.pathname === '/api/gridcraft/workbook', r => { reads.workbook++; return r.fulfill({ json: book }); });
  await page.route(u => u.pathname === '/api/gridcraft/workbooks', r => r.fulfill({ json: { ok: true, workbooks: [{ name: 'Budget.xlsx', size: 1, modified: 1 }, { name: 'Quarterly-Sales-Dashboard.xlsx', size: 1, modified: 1 }] } }));
  await page.route(u => u.pathname === '/api/gridcraft/range', r => {
    const q = new URL(r.request().url()).searchParams;
    reads.ranges.push(`${q.get('sheet')}!${q.get('range')}`);
    if (q.get('sheet') === 'Notes') return r.fulfill({ json: { ok: true, range: 'A1:B2', rows: [['Owner', 'Kim'], [null, true]], truncated: false } });
    return r.fulfill({ json: { ok: true, range: 'A1:AD200', rows: wide, truncated: true } });
  });
  await page.route(u => u.pathname === '/api/gridcraft/open', r => { reads.opened.push(JSON.parse(r.request().postData()).name); return r.fulfill({ json: { ok: true, name: 'Budget.xlsx' } }); });
  await page.route(u => u.pathname === '/api/gridcraft/health', r => r.fulfill({ json: { ok: true, gridcraftConnected: true, model: 'qwen3:4b-instruct' } }));
  await page.route(u => u.pathname === '/api/gridcraft/run', async r => {
    const { prompt } = JSON.parse(r.request().postData());
    runs.push(prompt);
    if (prompt.includes('break')) return r.fulfill({ status: 500, json: { ok: false, error: 'GridCraft agent failed', reason: 'httpx.ConnectError: connection refused' } });
    return r.fulfill({ json: { ok: true, answer: 'The Sales total is 48,250.', durationSec: 2 } });
  });
  await page.goto(base + '/#spreadsheets', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#spreadsheets.active');
  return { page, runs, reads };
}

for (const [name, options] of [['computer', { viewport: { width: 1280, height: 900 } }], ['phone', devices['iPhone 14']]]) {
  const { page, runs, reads } = await open(options);

  await check(`${name}: the page says GridCraft is ready`, async () => {
    await page.locator('#sheetsStatus[data-state="ready"]').waitFor({ timeout: 8000 });
    assert.equal(await page.locator('#sheetsStatus').innerText(), 'Ready');
  });

  await check(`${name}: the Workbook card shows the open workbook's active sheet`, async () => {
    await page.locator('#sheetsGrid td.is-error').first().waitFor({ timeout: 8000 });
    assert.equal(await page.locator('#sheetsBookTitle').innerText(), 'Quarterly Sales');
    assert.equal(await page.locator('#sheetsDirty').isVisible(), true);
    assert.equal(await page.locator('#sheetsPicker').inputValue(), 'Quarterly-Sales-Dashboard.xlsx');
    assert.deepEqual(await page.locator('#sheetsTabs [role=tab]').allInnerTexts(), ['Sales', 'Notes', 'Blank']);
    assert.equal(await page.locator('#sheetsTabs [aria-selected=true]').innerText(), 'Sales');
    assert.equal(reads.ranges[0], 'Sales!A1:AN250');
    assert.deepEqual(await page.locator('#sheetsGrid thead th').evaluateAll(t => [t[0].textContent, t[25].textContent, t[26].textContent, t[29].textContent, t[0].scope]), ['A', 'Z', 'AA', 'AD', 'col']);
    assert.equal(await page.locator('#sheetsGrid tbody th').first().innerText(), '1');
    const row2 = page.locator('#sheetsGrid tbody tr').nth(1).locator('td');
    assert.equal(await row2.nth(1).innerText(), 'North');
    assert.equal(await row2.nth(2).innerText(), '#DIV/0!');
    assert.equal(await row2.nth(3).innerText(), '');
    const align = await row2.evaluateAll(t => [0, 1, 4].map(i => getComputedStyle(t[i]).textAlign));
    assert.deepEqual(align, ['right', 'left', 'right'], 'numbers right-aligned, text left');
    assert.notEqual(await row2.nth(2).evaluate(e => getComputedStyle(e).color), await row2.nth(1).evaluate(e => getComputedStyle(e).color), 'errors in a different colour');
    assert.equal(await page.locator('#sheetsNote').innerText(), 'Showing the first 200 rows and 30 columns.');
    assert.ok((await page.locator('#sheetsGrid tbody th, #sheetsGrid td').evaluateAll(t => t.slice(0, 40).map(e => parseFloat(getComputedStyle(e).fontSize)))).every(n => n >= 14), 'text is at least 14px');
  });

  await check(`${name}: the grid scrolls sideways inside its card, never the page`, async () => {
    const wrap = page.locator('#sheetsGridWrap');
    const m = await wrap.evaluate(e => ({ sw: e.scrollWidth, cw: e.clientWidth, page: document.documentElement.scrollWidth <= window.innerWidth }));
    assert.ok(m.sw > m.cw, 'the grid is wider than its card');
    assert.equal(m.page, true);
    await wrap.evaluate(e => { e.scrollLeft = 600; e.scrollTop = 300; });
    const stuck = await page.evaluate(() => {
      const w = document.getElementById('sheetsGridWrap').getBoundingClientRect();
      const head = document.querySelector('#sheetsGrid thead th').getBoundingClientRect(), row = document.querySelector('#sheetsGrid tbody th').getBoundingClientRect();
      return Math.abs(head.top - w.top) < 3 && Math.abs(row.left - w.left) < 3;
    });
    assert.equal(stuck, true, 'header row and row numbers stay in view');
  });

  await check(`${name}: tabs switch sheets, with arrow keys too; an empty sheet says so`, async () => {
    await page.locator('#sheetsTabs [role=tab]', { hasText: 'Notes' }).click();
    await page.waitForFunction(() => document.querySelector('#sheetsGrid tbody td')?.textContent === 'Owner');
    assert.equal(await page.locator('#sheetsGrid tbody tr').nth(1).locator('td').nth(1).innerText(), 'TRUE');
    assert.equal(await page.locator('#sheetsNote').isVisible(), false);
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => document.querySelector('#sheetsNote')?.textContent === 'This sheet is empty.');
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Blank');
    assert.equal(await page.locator('#sheetsGridWrap').isVisible(), false);
    await page.keyboard.press('Home');
    await page.locator('#sheetsGrid td.is-error').first().waitFor();
  });

  await check(`${name}: an example fills the box, Run shows the answer`, async () => {
    await page.locator('[data-sheets-example="1"]').click();
    assert.match(await page.locator('#sheetsPrompt').inputValue(), /total of the Sales column/);
    await page.locator('#sheetsRun').click();
    await page.locator('#sheetsResult[data-kind="done"]').waitFor();
    assert.equal(await page.locator('#sheetsResultText').innerText(), 'The Sales total is 48,250.');
    assert.equal(await page.locator('#sheetsRetry').isVisible(), false);
    assert.equal(runs.length, 1);
    await until(() => reads.workbook === 2, 'the workbook reloads after a successful Run');
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

  await check(`${name}: picking another workbook opens it in GridCraft and reloads`, async () => {
    const before = reads.workbook;
    await page.locator('#sheetsPicker').selectOption('Budget.xlsx');
    await page.locator('.ask-sheet .ask-sheet__ok').click(); // the open workbook has unsaved changes
    await until(() => reads.workbook > before, 'reloads after opening');
    assert.deepEqual(reads.opened, ['Budget.xlsx']);
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
