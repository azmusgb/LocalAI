import { chromium, devices } from 'playwright';
import assert from 'node:assert/strict';

// System › Spreadsheets: the workbook, GridCraft requests in each mode, and keeping or discarding a Review request, on a
// computer and a phone. The appliance's /api/gridcraft routes are stubbed.
const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const shots = process.env.SHEETS_SHOTS; // a directory: save a screenshot of each layout for review
const browser = await chromium.launch({ headless: true });
const failures = [];
async function check(name, fn) { try { await fn(); console.log('PASS', name); } catch (e) { failures.push(`${name}: ${e.message}`); console.error('FAIL', name, e.message); } }

const EXAMPLE_TOTAL = 'What is the total of the Sales column? Do not change anything.';
const SALES = {
  ok: true, title: 'Quarterly Sales Dashboard', file: 'Quarterly-Sales-Dashboard.xlsx', dirty: false, activeSheet: 'Sales',
  sheets: [{ name: 'Sales', usedRange: 'A1:D3', cells: 9, tables: 1, charts: 0 }, { name: 'Notes', usedRange: 'A1:A250', cells: 250, tables: 0, charts: 0 }],
  sheet: 'Sales', usedRange: 'A1:D3', range: 'A1:D3', truncated: false,
  values: [['Region', 'Q1', 'Q2', 'Total'], ['North', '$48,200', '$51,340', '$99,540'], ['South', '$39,150', '$37,980', '$77,130']],
  formulas: [['Region', 'Q1', 'Q2', 'Total'], ['North', 48200, 51340, '=B2+C2'], ['South', 39150, 37980, '=B3+C3']],
  raw: [['Region', 'Q1', 'Q2', 'Total'], ['North', 48200, 51340, 99540], ['South', 39150, 37980, 77130]]
};
function notes(range) {
  const [a, b] = range.split(':'), r1 = +a.slice(1), r2 = +b.slice(1);
  const rows = Array.from({ length: r2 - r1 + 1 }, (_, i) => [`Note ${r1 + i}`]);
  return { ...SALES, sheet: 'Notes', usedRange: 'A1:A250', range, truncated: r2 < 250, values: rows, formulas: rows, raw: rows };
}

async function open(options) {
  const page = await browser.newPage({ serviceWorkers: 'block', ...options });
  const calls = { runs: [], workbook: [], keep: 0, discard: 0, open: [] };
  const book = { file: SALES.file, dirty: false }; // what GridCraft has open
  let runs = [];
  await page.route(u => u.pathname === '/api/gridcraft/workbooks', r => r.fulfill({ json: { ok: true, items: [SALES.file, 'Budget.xlsx', 'Inventory.csv'].map(name => ({ name, size: 2048, modified: '2026-10-17T09:00:00+00:00' })) } }));
  await page.route(u => u.pathname === '/api/gridcraft/open', r => {
    const { name } = JSON.parse(r.request().postData());
    calls.open.push(name);
    if (runs.some(x => x.status === 'review')) return r.fulfill({ status: 409, json: { ok: false, error: 'A request is waiting for review. Keep or discard its changes first, then open another workbook.' } });
    Object.assign(book, { file: name, dirty: false });
    return r.fulfill({ json: { ok: true, file: name } });
  });
  await page.route(u => u.pathname === '/api/gridcraft/health', r => r.fulfill({ json: { ok: true, gridcraftConnected: true, model: 'qwen3:4b-instruct' } }));
  await page.route(u => u.pathname === '/api/gridcraft/workbook', r => {
    const q = new URL(r.request().url()).searchParams;
    calls.workbook.push(q.toString());
    if (q.get('sheet') === 'Notes') return r.fulfill({ json: notes(q.get('range') || 'A1:A100') });
    const changed = runs.some(x => x.status === 'review');
    const named = book.file === SALES.file ? {} : { file: book.file, title: book.file.replace(/\.\w+$/, '') };
    return r.fulfill({ json: { ...SALES, ...named, dirty: changed || book.dirty, values: changed ? [SALES.values[0], ['North', '$50,000', '$51,340', '$101,340'], SALES.values[2]] : SALES.values } });
  });
  await page.route(u => u.pathname === '/api/gridcraft/runs', r => r.fulfill({ json: { items: runs } }));
  await page.route(u => /\/api\/gridcraft\/runs\/[^/]+\/(keep|discard)$/.test(u.pathname), r => {
    const action = r.request().url().endsWith('keep') ? 'keep' : 'discard';
    calls[action]++;
    if (action === 'discard' && calls.discard === 1) return r.fulfill({ status: 409, json: { ok: false, error: 'The workbook changed in GridCraft after this request, so undoing it could remove other work.' } });
    runs = runs.map(x => x.status === 'review' ? { ...x, status: action === 'keep' ? 'kept' : 'discarded' } : x);
    return r.fulfill({ json: { ok: true, dirty: false } });
  });
  await page.route(u => u.pathname === '/api/gridcraft/run', async r => {
    const { prompt, mode } = JSON.parse(r.request().postData());
    calls.runs.push({ prompt, mode });
    if (prompt.includes('break')) return r.fulfill({ status: 500, json: { ok: false, error: 'GridCraft agent failed', reason: 'httpx.ConnectError: connection refused' } });
    const edits = mode === 'review' ? [{ tool: 'set_cell', sheet: 'Sales', range: 'B2', before: [[48200]], after: [[50000]], afterValues: [[50000]] }] : [];
    const run = { id: `gc-${runs.length + 1}`, prompt, mode, status: mode === 'review' ? 'review' : 'done', answer: mode === 'review' ? 'Set North Q1 to 50,000.' : 'The Sales total is 48,250.', error: '', edits, changes: mode === 'review' ? [{ tool: 'format_range', summary: 'Formatted B2: bold' }] : [], undoSteps: 2, undoTop: ['Bold', 'Enter Cell'], createdAt: new Date().toISOString() };
    runs = [run, ...runs];
    return r.fulfill({ json: { ok: true, answer: run.answer, durationSec: 2, run } });
  });
  await page.goto(base + '/#spreadsheets', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#spreadsheets.active');
  return { page, calls, book };
}

for (const [name, options] of [['computer', { viewport: { width: 1280, height: 900 } }], ['phone', devices['iPhone 14']]]) {
  const { page, calls, book } = await open(options);

  await check(`${name}: the page says GridCraft is ready and shows the workbook`, async () => {
    await page.locator('#sheetsStatus[data-state="ready"]').waitFor({ timeout: 8000 });
    assert.equal(await page.locator('#sheetsStatus').innerText(), 'Ready');
    await page.locator('#sheetsGrid td[data-cell="A1"]').waitFor();
    assert.equal(await page.locator('#sheetsTitle').innerText(), 'Quarterly Sales Dashboard');
    assert.deepEqual(await page.locator('#sheetsTabs [role="tab"]').allInnerTexts(), ['Sales', 'Notes']);
    assert.equal(await page.locator('#sheetsGrid td[data-cell="B2"]').innerText(), '$48,200');
    assert.equal(await page.locator('#sheetsGrid td.is-formula').count(), 2);
    assert.equal(await page.locator('#sheetsDirty').isVisible(), false);
  });

  await check(`${name}: a cell shows its formula, and Show formulas shows them in the grid`, async () => {
    await page.locator('#sheetsGrid td[data-cell="D2"]').click();
    assert.equal(await page.locator('#sheetsCellRef').innerText(), 'Sales!D2');
    assert.equal(await page.locator('#sheetsCellFormula').innerText(), '=B2+C2');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.locator('#sheetsCellRef').innerText(), 'Sales!C2', 'arrow keys move the selection');
    await page.locator('#sheetsFormulas').click();
    assert.equal(await page.locator('#sheetsFormulas').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#sheetsGrid td[data-cell="D3"]').innerText(), '=B3+C3');
    await page.locator('#sheetsFormulas').click();
    await page.locator('#sheetsAskCell').click();
    assert.equal(await page.locator('#sheetsPrompt').inputValue(), 'Sales!C2 ');
  });

  await check(`${name}: another sheet pages through its rows`, async () => {
    await page.locator('#sheetsTabs [data-sheet="Notes"]').click();
    await page.locator('#sheetsGrid td[data-cell="A100"]').waitFor();
    assert.match(await page.locator('#sheetsPagerText').innerText(), /Rows 1–100 of 250/);
    await page.locator('[data-sheets-page="1"]').click();
    await page.locator('#sheetsGrid td[data-cell="A101"]').waitFor();
    assert.ok(calls.workbook.some(q => q.includes('range=A101%3AA200')));
    await page.locator('#sheetsTabs [data-sheet="Sales"]').click();
    await page.locator('#sheetsGrid td[data-cell="D3"]').waitFor();
  });

  await check(`${name}: Read only sends its mode and shows the answer`, async () => {
    await page.locator('#sheetsMode [data-mode="read"]').click();
    assert.match(await page.locator('#sheetsModeHint').innerText(), /cannot change anything/);
    await page.locator('[data-sheets-example="1"]').click();
    await page.locator('#sheetsRun').click();
    await page.locator('#sheetsResult[data-kind="done"]').waitFor();
    assert.equal(await page.locator('#sheetsResultText').innerText(), 'The Sales total is 48,250.');
    assert.deepEqual(calls.runs.at(-1), { prompt: EXAMPLE_TOTAL, mode: 'read' });
    assert.equal(await page.locator('#sheetsReview').isVisible(), false);
  });

  await check(`${name}: a Review request shows what changed, highlights it, and can be kept`, async () => {
    await page.locator('#sheetsMode [data-mode="review"]').click();
    await page.locator('#sheetsPrompt').fill('Set North Q1 to 50000');
    await page.locator('#sheetsRun').click();
    await page.locator('#sheetsReview').waitFor({ state: 'visible' });
    assert.deepEqual(calls.runs.at(-1).mode, 'review');
    assert.match(await page.locator('#sheetsChanges').innerText(), /B2[\s\S]*48200[\s\S]*50000/);
    assert.match(await page.locator('#sheetsChanges').innerText(), /Formatted B2: bold/);
    await page.locator('#sheetsGrid td[data-cell="B2"].is-pending').waitFor();
    await page.locator('#sheetsDirty').waitFor({ state: 'visible' });
    assert.match(await page.locator('#sheetsHistory').innerText(), /Waiting for review/);
    assert.equal(await page.locator('#spreadsheets .btn-primary:visible').count(), 1, 'Keep changes is the one blue action while a review waits');
    if (shots) await page.screenshot({ path: `${shots}/sheets-${name}-review.png`, fullPage: true });
    await page.locator('.sheets-goto[data-cell="B2"]').click();
    assert.match(await page.locator('#sheetsCellChange').innerText(), /48200 → 50000/);
    await page.locator('#sheetsKeep').click();
    await page.locator('#sheetsReview').waitFor({ state: 'hidden' });
    assert.equal(calls.keep, 1);
    assert.match(await page.locator('#sheetsHistory').innerText(), /Kept/);
    await page.locator('#sheetsDirty').waitFor({ state: 'hidden' });
  });

  await check(`${name}: Discard says why it can't, then undoes the latest request`, async () => {
    await page.locator('#sheetsPrompt').fill('Set North Q1 to 50000 again');
    await page.locator('#sheetsRun').click();
    await page.locator('#sheetsReview').waitFor({ state: 'visible' });
    await page.locator('#sheetsDiscard').click();
    await page.waitForFunction(() => /changed in GridCraft/.test(document.querySelector('#sheetsReviewNote')?.textContent || ''));
    await page.locator('#sheetsDiscard').click();
    await page.locator('#sheetsReview').waitFor({ state: 'hidden' });
    assert.match(await page.locator('#sheetsHistory').innerText(), /Discarded/);
  });

  await check(`${name}: a failure says why, keeps GridCraft "Ready", and Try again resends it`, async () => {
    const before = calls.runs.length;
    await page.locator('#sheetsPrompt').fill('break the workbook');
    await page.locator('#sheetsRun').click();
    await page.locator('#sheetsResult[data-kind="error"]').waitFor();
    assert.match(await page.locator('#sheetsResultText').innerText(), /GridCraft agent failed: httpx\.ConnectError: connection refused/);
    await page.locator('#sheetsStatus[data-state="ready"]').waitFor();
    await page.locator('#sheetsRetry').click();
    await page.waitForFunction(() => document.querySelector('#sheetsRun')?.disabled === false && document.querySelector('#sheetsResult')?.dataset.kind === 'error');
    assert.equal(calls.runs.length, before + 2);
  });

  await check(`${name}: the workbook menu lists the GridCraft folder and opens another workbook`, async () => {
    const menu = page.locator('#sheetsBooks');
    await menu.waitFor({ state: 'visible' });
    assert.deepEqual(await menu.locator('option').allInnerTexts(), [SALES.file, 'Budget.xlsx', 'Inventory.csv']);
    assert.equal(await menu.inputValue(), SALES.file, 'the open workbook is selected');
    assert.ok((await menu.boundingBox()).height >= 44, 'the menu is 44px to touch');
    await page.locator('#sheetsTabs [data-sheet="Notes"]').click();
    await page.locator('#sheetsGrid td[data-cell="A100"]').waitFor();
    await menu.selectOption('Budget.xlsx');
    await page.waitForFunction(() => document.querySelector('#sheetsTitle')?.textContent === 'Budget');
    assert.deepEqual(calls.open, ['Budget.xlsx']);
    assert.equal(calls.workbook.at(-1), '', 'the new workbook opens on its own first sheet');
    assert.equal(await menu.inputValue(), 'Budget.xlsx');
    assert.equal(await page.locator('#sheetsTabs [aria-selected="true"]').innerText(), 'Sales');
  });

  await check(`${name}: with unsaved changes it asks first, and Cancel opens nothing`, async () => {
    book.dirty = true;
    await page.locator('#sheetsRefresh').click();
    await page.locator('#sheetsDirty').waitFor({ state: 'visible' });
    await page.locator('#sheetsBooks').selectOption('Inventory.csv');
    const sheet = page.locator('dialog.ask-sheet');
    await sheet.waitFor({ state: 'visible' });
    assert.match(await sheet.innerText(), /Budget\.xlsx has unsaved changes in GridCraft\. Open Inventory\.csv anyway\?/);
    await sheet.locator('.ask-sheet__cancel').click();
    await sheet.waitFor({ state: 'detached' });
    assert.deepEqual(calls.open, ['Budget.xlsx'], 'nothing was opened');
    assert.equal(await page.locator('#sheetsBooks').inputValue(), 'Budget.xlsx');
    book.dirty = false;
  });

  await check(`${name}: while a request waits for review, opening says why it can't`, async () => {
    await page.locator('#sheetsMode [data-mode="review"]').click();
    await page.locator('#sheetsPrompt').fill('Set North Q1 to 50000 once more');
    await page.locator('#sheetsRun').click();
    await page.locator('#sheetsReview').waitFor({ state: 'visible' });
    await page.locator('#sheetsDirty').waitFor({ state: 'visible' });
    await page.locator('#sheetsBooks').selectOption('Inventory.csv');
    await page.locator('dialog.ask-sheet .ask-sheet__ok').click();
    await page.locator('#sheetsResult[data-kind="error"]').waitFor();
    assert.match(await page.locator('#sheetsResultText').innerText(), /waiting for review\. Keep or discard its changes first/);
    assert.equal(await page.locator('#sheetsBooks').inputValue(), 'Budget.xlsx', 'the menu still shows the open workbook');
    assert.equal(await page.locator('#spreadsheets .btn-primary:visible').count(), 1);
    if (shots) await page.screenshot({ path: `${shots}/sheets-${name}-open-refused.png`, fullPage: true });
    await page.locator('#sheetsKeep').click();
    await page.locator('#sheetsReview').waitFor({ state: 'hidden' });
  });

  await check(`${name}: the mode is remembered`, async () => {
    await page.locator('#sheetsMode [data-mode="apply"]').click();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#spreadsheets.active');
    assert.equal(await page.locator('#sheetsMode [aria-checked="true"]').getAttribute('data-mode'), 'apply');
  });

  await check(`${name}: nothing scrolls sideways`, async () => {
    await page.locator('#sheetsGrid td[data-cell="A1"]').waitFor();
    if (shots) await page.screenshot({ path: `${shots}/sheets-${name}.png`, fullPage: true });
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
