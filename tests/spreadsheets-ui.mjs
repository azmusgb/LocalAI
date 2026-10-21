import { chromium, devices } from 'playwright';
import assert from 'node:assert/strict';

// System › Spreadsheets: the workbook, GridCraft requests in each mode, keeping or discarding a Review request, and
// changing a cell by hand, on a computer and a phone. The appliance's /api/gridcraft routes are stubbed.
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
const colNum = s => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
const colName = n => { let s = ''; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = (n - r - 1) / 26; } return s; };
function notes(range) {
  const [, c1s, r1s, c2s, r2s] = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range);
  const r1 = +r1s, r2 = +r2s, c1 = colNum(c1s), c2 = colNum(c2s);
  const rows = Array.from({ length: r2 - r1 + 1 }, (_, i) => Array.from({ length: c2 - c1 + 1 }, (__, j) => c1 + j === 1 ? `Note ${r1 + i}` : `${colName(c1 + j)}${r1 + i}`));
  const usedRange = c2 > 1 ? 'A1:AZ250' : 'A1:A250';
  return { ...SALES, sheet: 'Notes', usedRange, range, truncated: r2 < 250 || c2 < colNum(usedRange.split(':')[1].replace(/\d+/g, '')), values: rows, formulas: rows, raw: rows };
}

async function open(options) {
  const page = await browser.newPage({ serviceWorkers: 'block', ...options });
  const calls = { runs: [], workbook: [], keep: 0, discard: 0, open: [], new: [], upload: [], download: [], cell: [] };
  const book = { file: SALES.file, dirty: false, busy: false, edited: {} }; // what GridCraft has open; edited: cells changed by hand
  let runs = [], files = [SALES.file, 'Budget.xlsx', 'Inventory.csv'];
  await page.route(u => u.pathname === '/api/gridcraft/workbooks', r => r.fulfill({ json: { ok: true, items: files.map(name => ({ name, size: 2048, modified: '2026-10-17T09:00:00+00:00' })) } }));
  await page.route(u => u.pathname === '/api/gridcraft/open', r => {
    const { name } = JSON.parse(r.request().postData());
    calls.open.push(name);
    if (runs.some(x => x.status === 'review')) return r.fulfill({ status: 409, json: { ok: false, error: 'A request is waiting for review. Keep or discard its changes first, then open another workbook.' } });
    Object.assign(book, { file: name, dirty: false });
    return r.fulfill({ json: { ok: true, file: name } });
  });
  await page.route(u => u.pathname === '/api/gridcraft/new', r => {
    const { name } = JSON.parse(r.request().postData());
    calls.new.push(name);
    if (files.includes(name)) return r.fulfill({ status: 409, json: { ok: false, error: `${name} already exists in the GridCraft folder` } });
    files = [...files, name].sort();
    Object.assign(book, { file: name, dirty: false });
    return r.fulfill({ json: { ok: true, file: name } });
  });
  await page.route(u => u.pathname === '/api/gridcraft/upload', r => {
    const { name, data } = JSON.parse(r.request().postData());
    calls.upload.push({ name, data });
    files = [...files, name].sort();
    Object.assign(book, { file: name, dirty: false });
    return r.fulfill({ json: { ok: true, file: name, size: Buffer.from(data, 'base64').length } });
  });
  await page.context().route(u => u.pathname === '/api/gridcraft/download', r => {
    const name = new URL(r.request().url()).searchParams.get('name') || book.file;
    calls.download.push(name);
    return r.fulfill({
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${name}"`
      },
      body: Buffer.from('504b030414000000', 'hex')
    });
  });
  await page.route(u => u.pathname === '/api/gridcraft/health', r => r.fulfill({ json: { ok: true, gridcraftConnected: true, model: 'qwen3:4b-instruct' } }));
  await page.route(u => u.pathname === '/api/gridcraft/workbook', r => {
    const q = new URL(r.request().url()).searchParams;
    calls.workbook.push(q.toString());
    if (q.get('sheet') === 'Notes') return r.fulfill({ json: notes(q.get('range') || 'A1:A100') });
    const changed = runs.some(x => x.status === 'review');
    const named = book.file === SALES.file ? {} : { file: book.file, title: book.file.replace(/\.\w+$/, '') };
    const values = (changed ? [SALES.values[0], ['North', '$50,000', '$51,340', '$101,340'], SALES.values[2]] : SALES.values).map(r => [...r]);
    const formulas = SALES.formulas.map(r => [...r]);
    for (const [ref, input] of Object.entries(book.edited)) { const i = +ref.slice(1) - 1, j = ref.charCodeAt(0) - 65; values[i][j] = input; formulas[i][j] = input; }
    return r.fulfill({ json: { ...SALES, ...named, dirty: changed || book.dirty, values, formulas } });
  });
  // A cell changed by hand: GridCraft is busy (409), or the edit joins the newest Direct edit waiting for review.
  await page.route(u => u.pathname === '/api/gridcraft/cell', r => {
    const body = JSON.parse(r.request().postData());
    calls.cell.push(body);
    if (book.busy) return r.fulfill({ status: 409, json: { ok: false, error: 'GridCraft is busy with a request. Change the cell when it finishes.' } });
    const i = +body.cell.slice(1) - 1, j = body.cell.charCodeAt(0) - 65, before = book.edited[body.cell] ?? SALES.formulas[i][j];
    book.edited[body.cell] = body.input;
    const edit = { tool: 'set_cell', sheet: body.sheet, range: body.cell, before: [[before]], after: [[body.input]], afterValues: [[body.input]] };
    const last = runs[0], where = `${body.sheet}!${body.cell}`;
    const run = last?.kind === 'edit' && last.status === 'review'
      ? { ...last, prompt: `${last.prompt}, ${where}`, edits: [...last.edits, edit], undoSteps: last.undoSteps + 1 }
      : { id: `gc-${runs.length + 1}`, kind: 'edit', prompt: `Direct edit: ${where}`, mode: 'review', status: 'review', answer: `You changed ${where} by hand.`, error: '', edits: [edit], changes: [], undoSteps: 1, undoTop: ['Enter Cell'], createdAt: new Date().toISOString() };
    runs = [run, ...runs.filter(x => x.id !== run.id)];
    return r.fulfill({ json: { ok: true, run } });
  });
  await page.route(u => u.pathname === '/api/gridcraft/progress', r => r.fulfill({ json: { ok: true, running: calls.runs.length > 0, turn: 2, steps: [
    { tool: 'inspect_workbook', text: 'Looking over the workbook' }, { tool: 'read_range', text: 'Reading Sales!A1:D3' },
    { tool: 'set_cell', text: 'Changing Sales!Z9', failed: true }, { tool: 'evaluate_formula', text: 'Calculating =SUM(Sales!B2:B3)' }] } }));
  await page.route(u => u.pathname === '/api/gridcraft/runs', r => r.fulfill({ json: { items: runs } }));
  await page.route(u => /\/api\/gridcraft\/runs\/[^/]+\/(keep|discard)$/.test(u.pathname), r => {
    const action = r.request().url().endsWith('keep') ? 'keep' : 'discard';
    calls[action]++;
    if (action === 'discard' && calls.discard === 1) return r.fulfill({ status: 409, json: { ok: false, error: 'The workbook changed in GridCraft after this request, so undoing it could remove other work.' } });
    if (action === 'discard') book.edited = {};
    runs = runs.map(x => x.status === 'review' ? { ...x, status: action === 'keep' ? 'kept' : 'discarded' } : x);
    return r.fulfill({ json: { ok: true, dirty: false } });
  });
  await page.route(u => u.pathname === '/api/gridcraft/run', async r => {
    const { prompt, mode } = JSON.parse(r.request().postData());
    calls.runs.push({ prompt, mode });
    if (prompt.includes('slowly')) await new Promise(res => setTimeout(res, 4000)); // long enough for the steps to show
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

  await check(`${name}: the examples are the kit's outline buttons; on a phone the workbook comes before the request box`, async () => {
    assert.equal(await page.locator('#sheetsExamples .btn-outline').count(), 3);
    const top = sel => page.locator(sel).evaluate(el => el.getBoundingClientRect().top);
    if (name === 'phone') assert.ok(await top('#sheetsBook') < await top('.sheets-ask'), 'workbook first on a phone');
    else assert.ok(Math.abs(await top('#sheetsBook') - await top('.sheets-ask')) < 4, 'side by side on a computer');
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

  await check(`${name}: another sheet pages through its rows and columns, and Go to jumps to a cell or range`, async () => {
    await page.locator('#sheetsTabs [data-sheet="Notes"]').click();
    await page.locator('#sheetsGrid td[data-cell="A100"]').waitFor();
    assert.match(await page.locator('#sheetsPagerText').innerText(), /Rows 1–100 of 250/);
    assert.equal(await page.locator('#sheetsColPager').isHidden(), true, 'one column needs no column pager');
    await page.locator('[data-sheets-page="1"]').click();
    await page.locator('#sheetsGrid td[data-cell="A101"]').waitFor();
    assert.ok(calls.workbook.some(q => q.includes('range=A101%3AA200')));
    // Go to a range on the current sheet:
    await page.locator('#sheetsGoInput').fill('A50:A55');
    await page.locator('#sheetsGo button[type="submit"]').click();
    await page.locator('#sheetsGrid td[data-cell="A50"]').waitFor();
    assert.ok(calls.workbook.some(q => q.includes('range=A50%3AA55')));
    assert.equal(await page.locator('#sheetsCellRef').innerText(), 'Notes!A50');
    // Go to a cell past column 40 (AN) on row 105: pages to rows 101–200 and columns AO–AZ:
    await page.locator('#sheetsGoInput').fill('AZ105');
    await page.locator('#sheetsGo button[type="submit"]').click();
    await page.locator('#sheetsGrid td[data-cell="AZ105"]').waitFor();
    assert.ok(calls.workbook.some(q => q.includes('range=AO101%3AAZ200')));
    assert.equal(await page.locator('#sheetsCellRef').innerText(), 'Notes!AZ105');
    assert.equal(await page.locator('#sheetsCellValue').innerText(), 'AZ105');
    assert.match(await page.locator('#sheetsPagerText').innerText(), /Columns AO–AZ of AZ/);
    assert.equal(await page.locator('#sheetsColPager').isVisible(), true);
    await page.locator('[data-sheets-cols="-1"]').click();
    await page.locator('#sheetsGrid td[data-cell="AN101"]').waitFor();
    assert.match(await page.locator('#sheetsPagerText').innerText(), /Columns A–AN of AZ/);
    await page.locator('[data-sheets-cols="1"]').click();
    await page.locator('#sheetsGrid td[data-cell="AZ105"]').waitFor();
    // Invalid Go to input and unknown sheet say why:
    await page.locator('#sheetsGoInput').fill('not-a-cell');
    await page.locator('#sheetsGo button[type="submit"]').click();
    await page.locator('#sheetsGoError').waitFor({ state: 'visible' });
    assert.match(await page.locator('#sheetsGoError').innerText(), /Enter a cell like B12/);
    await page.locator('#sheetsGoInput').fill('Missing!A1');
    await page.locator('#sheetsGo button[type="submit"]').click();
    assert.match(await page.locator('#sheetsGoError').innerText(), /No sheet named Missing/);
    // Qualified sheet!cell switches sheets and clears the error:
    await page.locator('#sheetsGoInput').fill('Sales!D3');
    await page.locator('#sheetsGo button[type="submit"]').click();
    await page.locator('#sheetsGrid td[data-cell="D3"]').waitFor();
    assert.equal(await page.locator('#sheetsCellRef').innerText(), 'Sales!D3');
    assert.equal(await page.locator('#sheetsGoError').isHidden(), true);
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

  await check(`${name}: while a request runs, its steps show as they happen, and go when it finishes`, async () => {
    await page.locator('#sheetsMode [data-mode="read"]').click();
    await page.locator('#sheetsPrompt').fill('Add up the sales slowly');
    await page.locator('#sheetsRun').click();
    await page.locator('#sheetsSteps li').first().waitFor({ timeout: 5000 });
    const steps = await page.locator('#sheetsSteps li').allInnerTexts();
    assert.deepEqual(steps, ['Looking over the workbook', 'Reading Sales!A1:D3', 'Changing Sales!Z9 (didn’t work)', 'Calculating =SUM(Sales!B2:B3)']);
    assert.equal(await page.locator('#sheetsSteps li.is-current').innerText(), 'Calculating =SUM(Sales!B2:B3)');
    await page.locator('#sheetsResult[data-kind="done"]').waitFor();
    assert.equal(await page.locator('#sheetsSteps').isHidden(), true, 'the answer replaces the steps');
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

  await check(`${name}: New workbook, Upload and Download manage workbook files`, async () => {
    for (const sel of ['#sheetsNew', '#sheetsUpload', '#sheetsDownload']) {
      const b = await page.locator(sel).boundingBox();
      assert.ok(b.height >= 44 && b.width >= 44, `${sel} is ${Math.round(b.width)}x${Math.round(b.height)}`);
    }
    assert.match(await page.locator('#sheetsDownload').getAttribute('href'), /\/api\/gridcraft\/download\?name=Budget\.xlsx$/);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#sheetsDownload').click()]);
    assert.equal(dl.suggestedFilename(), 'Budget.xlsx');
    assert.match(dl.url(), /\/api\/gridcraft\/download\?name=Budget\.xlsx$/);
    // New workbook adds .xlsx if omitted and opens the created file:
    await page.locator('#sheetsNew').click();
    const ask = page.locator('dialog.ask-sheet');
    await ask.waitFor({ state: 'visible' });
    await ask.locator('input').fill('Forecast-2027');
    await ask.locator('.ask-sheet__ok').click();
    await page.waitForFunction(() => document.querySelector('#sheetsTitle')?.textContent === 'Forecast-2027');
    assert.deepEqual(calls.new, ['Forecast-2027.xlsx']);
    assert.equal(await page.locator('#sheetsBooks').inputValue(), 'Forecast-2027.xlsx');
    assert.match(await page.locator('#sheetsDownload').getAttribute('href'), /name=Forecast-2027\.xlsx$/);
    // Upload an .xlsx file from the phone or computer:
    const xlsxBuf = Buffer.from('504b030414000000', 'hex');
    await page.locator('#sheetsUploadInput').setInputFiles({
      name: 'Phone-Report.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: xlsxBuf
    });
    await page.waitForFunction(() => document.querySelector('#sheetsTitle')?.textContent === 'Phone-Report');
    assert.deepEqual(calls.upload, [{ name: 'Phone-Report.xlsx', data: xlsxBuf.toString('base64') }]);
    assert.equal(await page.locator('#sheetsBooks').inputValue(), 'Phone-Report.xlsx');
    // Return to Budget.xlsx for subsequent checks:
    await page.locator('#sheetsBooks').selectOption('Budget.xlsx');
    await page.waitForFunction(() => document.querySelector('#sheetsTitle')?.textContent === 'Budget');
    calls.open = ['Budget.xlsx'];
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

  const cell = ref => page.locator(`#sheetsGrid td[data-cell="${ref}"]`);
  const fits = async sel => { const b = await page.locator(sel).boundingBox(); assert.ok(b.height >= 44 && b.width >= 44, `${sel} is ${Math.round(b.width)}x${Math.round(b.height)}`); };
  if (name === 'computer') {
    await check(`${name}: Enter changes a cell inline; it shows amber and waits for review`, async () => {
      await cell('B3').click();
      await page.keyboard.press('Enter');
      const input = cell('B3').locator('input');
      assert.equal(await input.inputValue(), '39150', 'the editor starts from what the cell holds');
      await input.fill('40000');
      if (shots) await page.locator('#sheetsBook').screenshot({ path: `${shots}/sheets-${name}-cell-editing.png` });
      await input.press('Enter');
      await cell('B3').and(page.locator('.is-pending')).waitFor();
      assert.deepEqual(calls.cell.at(-1), { sheet: 'Sales', cell: 'B3', input: '40000' });
      assert.equal(await cell('B3').innerText(), '40000');
      assert.equal(await page.locator('#sheetsResultTitle').innerText(), 'Direct edit: Sales!B3');
      await page.locator('#sheetsReview').waitFor({ state: 'visible' });
      assert.match(await page.locator('#sheetsHistory').innerText(), /Direct edit: Sales!B3[\s\S]*Waiting for review/);
      assert.match(await page.locator('#sheetsChanges').innerText(), /B3[\s\S]*39150[\s\S]*40000/);
      await page.waitForFunction(() => document.activeElement?.dataset?.cell === 'B3');
    });
    await check(`${name}: typing on a cell starts a change, F2 and double-click too; Esc cancels`, async () => {
      const sent = calls.cell.length;
      await cell('C3').click();
      await page.keyboard.type('=B3*2');
      assert.equal(await cell('C3').locator('input').inputValue(), '=B3*2');
      await page.keyboard.press('Escape');
      assert.equal(await cell('C3').locator('input').count(), 0);
      assert.equal(await cell('C3').innerText(), '$37,980', 'Esc puts the cell back');
      await page.waitForFunction(() => document.activeElement?.dataset?.cell === 'C3');
      await page.keyboard.press('F2');
      await cell('C3').locator('input').waitFor();
      await page.keyboard.press('Escape');
      await cell('D3').dblclick();
      assert.equal(await cell('D3').locator('input').inputValue(), '=B3+C3', 'a formula cell edits its formula');
      await page.keyboard.press('Escape');
      assert.equal(calls.cell.length, sent, 'nothing was sent');
    });
    await check(`${name}: a second change joins the same review; GridCraft busy says so and changes nothing`, async () => {
      await cell('C2').click();
      await cell('C2').click(); // a click on the selected cell changes it
      await cell('C2').locator('input').fill('52000');
      await page.keyboard.press('Enter');
      await cell('C2').and(page.locator('.is-pending')).waitFor();
      assert.equal(await page.locator('#sheetsHistory .sheets-run').filter({ hasText: 'Direct edit' }).count(), 1, 'one review for both');
      book.busy = true;
      await cell('A3').dblclick();
      await cell('A3').locator('input').fill('Southwest');
      await page.keyboard.press('Enter');
      await page.locator('#sheetsCellError').waitFor({ state: 'visible' });
      assert.match(await page.locator('#sheetsCellError').innerText(), /Sales!A3 wasn't changed\. GridCraft is busy with a request/);
      await page.waitForFunction(() => document.querySelector('#sheetsGrid td[data-cell="A3"]')?.textContent === 'South');
      book.busy = false;
    });
  } else {
    await check(`${name}: a cell changes in a small sheet: reference, value, formula, Save and Cancel`, async () => {
      await cell('D3').click();
      await fits('#sheetsEditCell');
      await page.locator('#sheetsEditCell').click();
      const sheet = page.locator('#sheetsEdit');
      await sheet.waitFor({ state: 'visible' });
      assert.equal(await page.locator('#sheetsEditTitle').innerText(), 'Change Sales!D3');
      assert.match(await page.locator('#sheetsEditNow').innerText(), /Now: \$77,130\s+Formula: =B3\+C3/);
      assert.equal(await page.locator('#sheetsEditInput').inputValue(), '=B3+C3');
      for (const sel of ['#sheetsEditInput', '#sheetsEditSave', '#sheetsEditCancel']) await fits(sel);
      if (shots) { await page.waitForTimeout(400); await page.screenshot({ path: `${shots}/sheets-${name}-cell-sheet.png` }); } // after the sheet's slide-in
      const box = await sheet.boundingBox(), vw = page.viewportSize().width;
      assert.ok(box.x >= 0 && box.x + box.width <= vw + 0.5, 'the sheet fits the screen');
      assert.equal(await page.evaluate(() => document.querySelector('#sheetsEdit').scrollWidth <= document.querySelector('#sheetsEdit').clientWidth), true, 'nothing in it scrolls sideways');
      await page.locator('#sheetsEditInput').fill('xyz');
      await page.locator('#sheetsEditCancel').click();
      await sheet.waitFor({ state: 'hidden' });
      assert.equal(calls.cell.length, 0, 'Cancel sends nothing');
      await cell('B3').click();
      await cell('B3').click(); // a tap on the selected cell opens the sheet
      await sheet.waitFor({ state: 'visible' });
      assert.equal(await page.locator('#sheetsEditInput').inputValue(), '39150');
      book.busy = true;
      await page.locator('#sheetsEditInput').fill('41000');
      await page.locator('#sheetsEditSave').click();
      await page.locator('#sheetsEditError').waitFor({ state: 'visible' });
      assert.match(await page.locator('#sheetsEditError').innerText(), /busy with a request/);
      assert.equal(await sheet.isVisible(), true, 'the sheet stays open to try again');
      book.busy = false;
      await page.locator('#sheetsEditSave').click();
      await sheet.waitFor({ state: 'hidden' });
      assert.deepEqual(calls.cell.at(-1), { sheet: 'Sales', cell: 'B3', input: '41000' });
      await cell('B3').and(page.locator('.is-pending')).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    });
  }

  await check(`${name}: Keep and Discard clear the amber from changed cells`, async () => {
    await page.locator('#sheetsKeep').click();
    await page.locator('#sheetsReview').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#sheetsGrid td.is-pending').count(), 0, 'kept');
    assert.match(await page.locator('#sheetsHistory').innerText(), /Direct edit[\s\S]*Kept/);
    if (name === 'computer') {
      await cell('A2').dblclick();
      await cell('A2').locator('input').fill('Northeast');
      await page.keyboard.press('Enter');
    } else {
      await cell('A2').click();
      await page.locator('#sheetsEditCell').click();
      await page.locator('#sheetsEditInput').fill('Northeast');
      await page.locator('#sheetsEditSave').click();
    }
    await cell('A2').and(page.locator('.is-pending')).waitFor();
    if (shots) await page.screenshot({ path: `${shots}/sheets-${name}-cell-review.png`, fullPage: true });
    await page.locator('#sheetsDiscard').click();
    await page.locator('#sheetsReview').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#sheetsGrid td.is-pending').count(), 0, 'discarded');
    await page.waitForFunction(() => document.querySelector('#sheetsGrid td[data-cell="A2"]')?.textContent === 'North');
  });

  await check(`${name}: Read only can't change cells`, async () => {
    const sent = calls.cell.length;
    await page.locator('#sheetsMode [data-mode="read"]').click();
    assert.equal(await page.locator('#sheetsGrid').getAttribute('aria-readonly'), 'true');
    await cell('B2').click();
    assert.equal(await page.locator('#sheetsEditCell').isVisible(), false, 'no Change button');
    await cell('B2').click();
    await page.keyboard.press('Enter');
    if (name === 'computer') await cell('B2').dblclick();
    assert.equal(await page.locator('#sheetsGrid input').count(), 0);
    assert.equal(await page.locator('#sheetsEdit').isVisible(), false);
    assert.match(await page.locator('#sheetsCellError').innerText(), /Read only is on/);
    assert.equal(calls.cell.length, sent);
    await page.locator('#sheetsMode [data-mode="review"]').click();
    assert.equal(await page.locator('#sheetsEditCell').isVisible(), true);
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
