import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { addAxe } from './axe-helper.mjs';

// Past work (memory-core spec §4 as changed by platform amendment A28): the composer's Past work mode posts the question
// to /api/journal/ask and opens the run; the run view shows the answer, its citations as links, then every entry it read,
// each journal entry with Delete (A28 D6). Also a failed run, nothing found, long and hostile text. The API is stubbed.
const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const axePath = join(dirname(fileURLToPath(import.meta.url)), 'vendor', 'axe.min.js');
const browser = await chromium.launch({ headless: true });
const T = { timeout: 8000 };
const failures = [];
async function check(name, fn) {
  try { await fn(); console.log('PASS', name); } catch (error) { failures.push(`${name}: ${error.message}`); console.error('FAIL', name, error.message); }
}
const desk = { width: 1280, height: 860 }, phone = { width: 390, height: 844 };
const NOW = Date.now();
const iso = n => new Date(NOW - n * 3600e3).toISOString();
const entries = [
  { n: 1, id: 'j-1-a', at: iso(20), source: 'run', kind: 'chat', title: 'Which filament for a shelf bracket?', link: '#run/run-old-1' },
  { n: 2, id: 'j-2-b', at: iso(30), source: 'run', kind: 'image', title: '<img src=x onerror="window.__xss=1">Poster', link: 'javascript:window.__xss=1' },
  { n: 3, id: 'print-41', at: iso(10), source: 'print', kind: 'Finished', title: 'shelf_bracket_v3 · Finished', link: 'hub:workshop' }
];
const pastRun = (id, o = {}) => ({
  id, type: 'prompt', status: o.status || 'completed', progress: o.status === 'running' ? 40 : 100, threadId: id, title: o.title || 'what did I ask about the bracket',
  createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(), input: { prompt: o.title || 'what did I ask about the bracket' },
  meta: { mode: 'history', route: { provider: 'ollama', model: 'm', class: 'private', why: 'Your past work stays on this PC' } }, error: o.error || null,
  output: o.output === undefined ? { text: 'You asked which filament suits a shelf bracket; PETG [1]. The print finished [3].', citations: [entries[0], entries[2]].map(({ n, id, link, title, at }) => ({ n, id, link, title, at })), entries, from: 'journal', unread: null } : o.output,
  card: { kind: 'prompt', icon: 'history', title: o.title || 'what did I ask about the bracket', summary: '', badge: o.status === 'failed' ? { label: 'Failed', tone: 'bad' } : o.status === 'running' ? { label: 'Running', tone: 'accent' } : { label: 'Done', tone: 'good' }, preview: null, action: { label: 'Open' }, approval: null, route: { text: 'Answered on this PC', why: 'Your past work stays on this PC' } }
});

async function open(viewport, hash, { runs = [], askStatus = 202, deleteStatus = 200, storage = {} } = {}) {
  const db = { runs, asks: [], deletes: [] };
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport, isMobile: viewport.width < 760, hasTouch: viewport.width < 760 });
  await ctx.addInitScript(s => { try { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); } } catch {} }, { 'localai.firstRun.done': '1', ...storage });
  const page = await ctx.newPage();
  page.db = db; page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  const json = (r, body, status = 200) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await ctx.route(u => u.pathname === '/api/approvals', r => json(r, { items: [] }));
  await page.route(u => u.pathname === '/api/journal/ask', r => {
    const b = JSON.parse(r.request().postData()); db.asks.push(b);
    if (askStatus !== 202) return json(r, { error: 'Ask a question.' }, askStatus);
    const run = pastRun('run-past-new', { status: 'running', title: b.question, output: null }); db.runs.push(run);
    json(r, { runId: run.id, run }, 202);
  });
  await page.route(u => u.pathname === '/api/journal/delete', r => { db.deletes.push(JSON.parse(r.request().postData())); json(r, deleteStatus === 200 ? { ok: true } : { error: 'The journal is switched off' }, deleteStatus); });
  await page.route(u => u.pathname === '/api/runs', r => {
    const q = new URL(r.request().url()).searchParams;
    if (q.get('id')) { const it = db.runs.find(x => x.id === q.get('id')); return it ? json(r, { item: it }) : json(r, { error: 'Run not found' }, 404); }
    json(r, { items: db.runs, summary: {} });
  });
  await page.goto(base + '/' + hash, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.showView === 'function' && window.LocalAIRouter && window.LocalAIHome && window.LocalAIRuns && location.hash, null, { timeout: 10000 });
  return page;
}
const body = page => page.locator('#runDrawer .past-work');

await check('the mode sheet offers Past work with its hint, and never names it History', async () => {
  const page = await open(desk, '#home');
  await page.locator('#homeModeChip').click();
  const row = page.locator('#homeModeSheet [data-home-mode="history"]');
  await row.waitFor(T);
  assert.equal((await row.locator('b').textContent()).trim(), 'Past work');
  assert.equal((await row.locator('span').textContent()).trim(), 'Answers from what you did here');
  const words = await page.locator('#homeModeSheet .home-modes').innerText();
  assert.doesNotMatch(words, /Ask history|\bHistory\b/);
  await row.click();
  await page.waitForFunction(() => /Past work/.test(document.getElementById('homeModeChip').textContent), null, T);
  assert.equal(await page.evaluate(() => localStorage.getItem('localai.home.mode')), 'history');
  await page.context().close();
});

await check('Past work: send posts the question, opens the run, waits, then shows answer, citations and entries', async () => {
  const page = await open(desk, '#home', { storage: { 'localai.home.mode': 'history' } });
  await page.locator('#commandInput').fill('what did I ask about the bracket');
  await page.locator('#commandGo').click();
  await page.waitForFunction(() => location.hash === '#run/run-past-new', null, T);
  assert.deepEqual(page.db.asks, [{ question: 'what did I ask about the bracket' }]);
  assert.equal(await page.locator('#commandInput').inputValue(), '', 'the composer is cleared once the run started');
  await body(page).locator('p[role="status"]', { hasText: 'Reading your past work' }).waitFor(T);
  assert.match(await page.locator('#runDrawer').innerText(), /Past work/, 'the run view names the kind');
  // The server finishes the run; the run view follows it.
  Object.assign(page.db.runs[0], pastRun('run-past-new'), { title: 'what did I ask about the bracket' });
  await body(page).locator('.past-work__answer').waitFor({ timeout: 12000 });
  assert.equal(await body(page).locator('.past-work__answer').textContent(), 'You asked which filament suits a shelf bracket; PETG [1]. The print finished [3].');
  const order = await body(page).locator('h3').allTextContents();
  assert.deepEqual(order, ['Answer', 'Cited', 'What it read'], 'answer, then citations, then entries');
  const cites = body(page).locator('.past-work__cites li');
  assert.equal(await cites.count(), 2);
  assert.equal(await cites.nth(0).locator('a').getAttribute('href'), '#run/run-old-1', 'an in-app route is a link');
  assert.equal(await cites.nth(1).locator('a').count(), 0, "Pi Hub's hub: link is shown without a link");
  const rows = body(page).locator('.past-work__entry');
  assert.equal(await rows.count(), 3);
  assert.equal(await rows.nth(1).locator('a').count(), 0, 'a javascript: link never becomes a link');
  assert.equal(await rows.nth(1).locator('.ui-row__title').textContent(), '<img src=x onerror="window.__xss=1">Poster', 'stored text is shown as text');
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  assert.match(await rows.nth(0).locator('span.ui-row__detail').textContent(), / · Local AI$/);
  assert.match(await rows.nth(2).locator('span.ui-row__detail').textContent(), / · Pi Hub · Workshop$/);
  assert.equal(await rows.nth(2).locator('button').count(), 0, "a Pi Hub print row has no Delete");
  assert.equal(await rows.nth(0).locator('button', { hasText: 'Delete' }).count(), 1);
  assert.equal(page.errors.length, 0, page.errors.join('|'));
  await page.context().close();
});

await check('Delete asks first, posts the entry id to /api/journal/delete, and says it is gone; Cancel deletes nothing', async () => {
  const page = await open(desk, '#run/run-past-1', { runs: [pastRun('run-past-1')] });
  await body(page).locator('.past-work__entry').first().waitFor(T);
  const del = body(page).locator('.past-work__entry').first().locator('.past-work__delete');
  // Keyboard: the button is reachable and its focus ring is visible.
  await del.focus();
  assert.notEqual(await del.evaluate(n => getComputedStyle(n).outlineStyle), 'none', 'focus is visible');
  await page.keyboard.press('Enter');
  const sheet = page.locator('dialog.ask-sheet[open]');
  await sheet.waitFor(T);
  assert.match(await sheet.innerText(), /Delete "Which filament for a shelf bracket\?" from your past work\?/);
  await sheet.locator('.ask-sheet__cancel').click();
  await sheet.waitFor({ state: 'detached', ...T });
  assert.equal(page.db.deletes.length, 0, 'Cancel deletes nothing');
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('past-work__delete')), true, 'focus returns to Delete');
  await del.click();
  await sheet.waitFor(T);
  await sheet.locator('.ask-sheet__ok', { hasText: 'Delete' }).click();
  await body(page).locator('.past-work__entry').first().locator('.past-work__status', { hasText: 'Deleted from your past work' }).waitFor(T);
  assert.deepEqual(page.db.deletes, [{ id: 'j-1-a' }]);
  assert.equal(await body(page).locator('.past-work__entry').first().locator('.past-work__delete').count(), 0);
  assert.equal(await page.evaluate(() => !!document.activeElement?.closest('#runDrawer')), true, 'focus stays in the run view');
  await page.context().close();
});

await check('a delete the server refuses says why beside the entry and keeps Delete', async () => {
  const page = await open(desk, '#run/run-past-1', { runs: [pastRun('run-past-1')], deleteStatus: 503 });
  const row = body(page).locator('.past-work__entry').first();
  await row.waitFor(T);
  await row.locator('.past-work__delete').click();
  await page.locator('dialog.ask-sheet[open] .ask-sheet__ok').click();
  await row.locator('.past-work__status[role="alert"]', { hasText: "Couldn't delete it: The journal is switched off" }).waitFor(T);
  assert.equal(await row.locator('.past-work__delete').isEnabled(), true);
  await page.context().close();
});

await check('a failed run shows the reason and still lists what it read; nothing found is a plain empty state', async () => {
  const failed = pastRun('run-past-f', { status: 'failed', error: 'The model took longer than 180 s (request timed out)', output: { text: '', citations: [], entries: entries.slice(0, 1), from: 'journal', unread: null } });
  const page = await open(desk, '#run/run-past-f', { runs: [failed, pastRun('run-past-e', { title: 'when did I buy a zeppelin', output: { text: "I don't have anything about that.", citations: [], entries: [], from: 'journal', unread: null } })] });
  await body(page).locator('.past-work__entry').waitFor(T);
  assert.match(await page.locator('#runDrawer').innerText(), /request timed out/);
  assert.equal(await body(page).locator('.past-work__entry').count(), 1);
  await page.evaluate(() => window.LocalAIRouter.go('#run/run-past-e'));
  await body(page).locator('.ui-empty', { hasText: 'Nothing in your past work matched this question.' }).waitFor(T);
  assert.equal(await body(page).locator('.past-work__answer').textContent(), "I don't have anything about that.");
  assert.equal(await body(page).locator('.past-work__cites').count(), 0);
  await page.context().close();
});

await check('a failed ask keeps the question in the composer and says why', async () => {
  const page = await open(desk, '#home', { storage: { 'localai.home.mode': 'history' }, askStatus: 400 });
  await page.locator('#commandInput').fill('what did I do');
  await page.locator('#commandGo').click();
  await page.waitForSelector('#homeComposerError:not([hidden])', T);
  assert.match(await page.locator('#homeComposerError').textContent(), /Ask a question/);
  assert.equal(await page.locator('#commandInput').inputValue(), 'what did I do');
  await page.context().close();
});

await check('long content on a phone: no horizontal overflow; axe finds nothing serious', async () => {
  const long = 'A very long answer sentence that keeps going without a break '.repeat(30) + 'x'.repeat(400) + ' [1]';
  const many = Array.from({ length: 30 }, (_, i) => ({ n: i + 1, id: `j-${i}-z`, at: iso(i), source: 'run', kind: 'chat', title: `Entry ${i} ` + 'w'.repeat(180), link: `#run/run-${i}` }));
  const page = await open(phone, '#run/run-past-l', { runs: [pastRun('run-past-l', { output: { text: long, citations: many.slice(0, 1), entries: many, from: 'journal', unread: null } })] });
  await body(page).locator('.past-work__entry').nth(29).waitFor(T);
  const over = await page.evaluate(() => [...document.querySelectorAll('#runDrawer .past-work *')].filter(n => n.getBoundingClientRect().right > document.documentElement.clientWidth + 1).map(n => n.className || n.tagName).slice(0, 3));
  assert.deepEqual(over, [], 'nothing runs off the right edge');
  const target = await body(page).locator('.past-work__delete').first().boundingBox();
  assert.ok(target.height >= 44, `Delete is ${target.height}px tall`);
  await addAxe(page, axePath);
  const found = await page.evaluate(async () => (await window.axe.run(document.querySelector('#runDrawer'), { resultTypes: ['violations'] })).violations.filter(v => ['serious', 'critical'].includes(v.impact)).map(v => `${v.id}: ${v.nodes.length}`));
  assert.deepEqual(found, []);
  await page.context().close();
});

await browser.close();
if (failures.length) { console.error(`\n${failures.length} failed:\n${failures.join('\n')}`); process.exit(1); }
