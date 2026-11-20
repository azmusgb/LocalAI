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

async function open(viewport, hash, { runs = [], askStatus = 202, deleteStatus = 200, retryStatus = 200, storage = {}, gone = [], intelligence = true, idsFail = false } = {}) {
  const db = { runs, asks: [], deletes: [], retries: [], gone: new Set(gone) };
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport, isMobile: viewport.width < 760, hasTouch: viewport.width < 760 });
  await ctx.addInitScript(s => { try { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); } } catch {} }, { 'localai.firstRun.done': '1', ...storage });
  const page = await ctx.newPage();
  page.db = db; page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  const json = (r, body, status = 200) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await ctx.route(u => u.pathname === '/api/approvals', r => json(r, { items: [] }));
  await page.route(u => u.pathname === '/api/capabilities', r => json(r, { services: [['ollama', intelligence], ['search', true], ['comfy', true], ['n8n', true]].map(([name, up]) => ({ name, label: name, state: up ? 'HEALTHY' : 'DOWN', required: true })), models: { defaultInstalled: true }, images: { available: true }, version: '1' }));
  // ?ids=: the entries that still exist (db.gone were deleted elsewhere, or before a reload).
  db.idsChecks = 0;
  await page.route(u => u.pathname === '/api/journal' && u.searchParams.has('ids'), r => { db.idsChecks++; return idsFail ? json(r, { error: "Couldn't read your past work." }, 503) : json(r, { items: new URL(r.request().url()).searchParams.get('ids').split(',').filter(id => !db.gone.has(id)).map(id => ({ id })) }); });
  await page.route(u => u.pathname === '/api/runs/retry', r => {
    const { id } = JSON.parse(r.request().postData()); db.retries.push(id);
    if (retryStatus !== 200) return json(r, { error: 'The run ledger is busy' }, retryStatus);
    const was = db.runs.find(x => x.id === id), run = pastRun('run-past-retry', { title: was?.title });
    db.runs.push(run); json(r, { ok: true, replayedFrom: id, runId: run.id });
  });
  await page.route(u => u.pathname === '/api/journal/ask', r => {
    const b = JSON.parse(r.request().postData()); db.asks.push(b);
    if (askStatus !== 202) return json(r, { error: 'Ask a question.' }, askStatus);
    const run = pastRun('run-past-new', { status: 'running', title: b.question, output: null }); db.runs.push(run);
    json(r, { runId: run.id, run }, 202);
  });
  await page.route(u => u.pathname === '/api/journal/delete', r => { const b = JSON.parse(r.request().postData()); db.deletes.push(b); if (deleteStatus === 200) db.gone.add(b.id); json(r, deleteStatus === 200 ? { ok: true } : { error: 'Past work is switched off.' }, deleteStatus); });
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
  const hub = cites.nth(1).locator('a');
  assert.match(await hub.getAttribute('href'), /^https:\/\/[^/]+\/workshop$/, "a print cites Workshop on Pi Hub (A28 D3)");
  assert.equal(await hub.getAttribute('target'), '_blank'); assert.equal(await hub.getAttribute('rel'), 'noopener');
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

await check('a delete the server refuses (journal switched off: 503) says why beside the entry, not "Already deleted", and keeps Delete', async () => {
  const page = await open(desk, '#run/run-past-1', { runs: [pastRun('run-past-1')], deleteStatus: 503 });
  const row = body(page).locator('.past-work__entry').first();
  await row.waitFor(T);
  await row.locator('.past-work__delete').click();
  await page.locator('dialog.ask-sheet[open] .ask-sheet__ok').click();
  const note = row.locator('p.ui-notice.ui-notice--bad[role="alert"]', { hasText: "Couldn't delete it" });
  await note.waitFor(T);
  assert.equal((await note.innerText()).trim(), "Couldn't delete it: Past work is switched off. Try again.");
  assert.doesNotMatch(await row.innerText(), /Already deleted/);
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

await check('a source that could not be read: the answer names it once, with Try again and (prints) a Workshop link; films say no record is kept', async () => {
  const out = (text, from, unread) => ({ text, citations: [], entries: [], from, unread });
  const page = await open(desk, '#run/run-p1', { runs: [
    pastRun('run-p1', { title: 'did my last print finish', output: out("I can't read Pi Hub's print list from here, so I can't say what was printed. Workshop on Pi Hub shows it.", 'prints', "Pi Hub's print list can't be read from here") }),
    pastRun('run-p2', { title: 'did my last print finish', output: out("Bambuddy isn't answering, so I can't say what was printed.", 'prints', "Bambuddy isn't answering") }),
    pastRun('run-f1', { title: 'what did I watch on Saturday', output: out("I keep no record of what was watched, so I can't say.", 'none', null) })
  ] });
  for (const id of ['run-p1', 'run-p2']) {
    await page.evaluate(h => window.LocalAIRouter.go(h), '#run/' + id);
    const again = body(page).locator('.past-work__again');
    await again.locator('button', { hasText: 'Try again' }).waitFor(T);
    assert.match(await again.locator('a.ui-btn').getAttribute('href'), /^https:\/\/[^/]+\/workshop$/, `${id}: Workshop on Pi Hub`);
    assert.equal(await body(page).locator('.past-work__source').count(), 0, `${id}: the answer is not repeated`);
    assert.equal(await body(page).locator('.ui-empty').count(), 0, `${id}: no "nothing matched"`);
    assert.doesNotMatch(await body(page).innerText(), /Nothing in your past work matched/);
  }
  await body(page).locator('.past-work__again button').click();
  await page.waitForFunction(() => location.hash === '#run/run-past-retry', null, T);
  assert.deepEqual(page.db.retries, ['run-p2'], 'Try again asks the same question again');
  await page.evaluate(h => window.LocalAIRouter.go(h), '#run/run-f1');
  await body(page).locator('.past-work__answer', { hasText: 'I keep no record of what was watched' }).waitFor(T);
  assert.equal(await body(page).locator('.past-work__source').count(), 0, 'films: said once, by the answer');
  assert.equal(await body(page).locator('.past-work__again').count(), 0, 'films: nothing to ask again');
  assert.equal(await body(page).locator('.ui-empty').count(), 0);
  assert.equal((await body(page).locator('h3').allTextContents()).includes('What it read'), false);
  await page.context().close();
});

// A29: a print question answered from Pi Hub's print list. Every print cites Workshop on Pi Hub; the rows are Pi Hub's,
// so no Delete and no journal check; the run finished, so no Try again. Then the Bambuddy-down answer, said once.
await check('a print answer from Pi Hub: each print cites Workshop, rows are Pi Hub\'s without Delete; Bambuddy down is one line with Workshop', async () => {
  const prints = [
    { n: 1, id: 'print-812', at: iso(3), source: 'print', kind: 'Finished', title: 'RIFT tile 10in · Finished', link: 'hub:workshop' },
    { n: 2, id: 'print-811', at: iso(28), source: 'print', kind: 'Failed', title: 'cable_clip · Failed', link: 'hub:workshop' },
    { n: 3, id: 'print-810', at: iso(50), source: 'print', kind: 'Cancelled', title: 'hinge_test · Cancelled', link: 'hub:workshop' }
  ];
  const text = 'Yes: RIFT tile 10in finished [1]. Before it, cable_clip failed when the filament ran out [2], and hinge_test was cancelled [3].';
  const page = await open(desk, '#run/run-pp', { runs: [
    pastRun('run-pp', { title: 'did my last print finish', output: { text, citations: prints.map(({ n, id, link, title, at }) => ({ n, id, link, title, at })), entries: prints, from: 'prints', unread: null } }),
    pastRun('run-pb', { title: 'did my last print finish', output: { text: "Bambuddy isn't answering, so I can't say what was printed.", citations: [], entries: [], from: 'prints', unread: "Bambuddy isn't answering" } })
  ] });
  await body(page).locator('.past-work__answer').waitFor(T);
  assert.equal(await body(page).locator('.past-work__answer').textContent(), text);
  assert.deepEqual(await body(page).locator('h3').allTextContents(), ['Answer', 'Cited', 'What it read']);
  const cites = body(page).locator('.past-work__cites li a');
  assert.equal(await cites.count(), 3);
  for (let i = 0; i < 3; i++) {
    assert.match(await cites.nth(i).getAttribute('href'), /^https:\/\/[^/]+\/workshop$/, `print ${i + 1} cites Workshop on Pi Hub`);
    assert.equal(await cites.nth(i).getAttribute('rel'), 'noopener');
  }
  const rows = body(page).locator('.past-work__entry');
  assert.equal(await rows.count(), 3);
  assert.deepEqual(await rows.locator('.ui-row__title').allTextContents(), ['RIFT tile 10in · Finished ↗', 'cable_clip · Failed ↗', 'hinge_test · Cancelled ↗']);
  for (let i = 0; i < 3; i++) assert.match(await rows.nth(i).locator('span.ui-row__detail').textContent(), / · Pi Hub · Workshop$/);
  assert.equal(await body(page).locator('.past-work__delete').count(), 0, 'prints are not in the journal: nothing to delete');
  assert.equal(await body(page).locator('.past-work__again').count(), 0, 'a finished answer has no Try again');
  assert.equal(page.db.idsChecks, 0, 'no journal check for Pi Hub rows');
  await page.evaluate(() => window.LocalAIRouter.go('#run/run-pb'));
  await body(page).locator('.past-work__answer', { hasText: "Bambuddy isn't answering, so I can't say what was printed." }).waitFor(T);
  assert.doesNotMatch(await body(page).innerText(), /no prints|print list is empty|Nothing in your past work matched/i, 'Bambuddy down is never "no prints"');
  assert.match(await body(page).locator('.past-work__again a.ui-btn').getAttribute('href'), /^https:\/\/[^/]+\/workshop$/);
  assert.equal(await body(page).locator('.past-work__again button', { hasText: 'Try again' }).count(), 1);
  assert.equal(page.errors.length, 0, page.errors.join('|'));
  await page.context().close();
});

await check('a failed run offers Try again, which asks the same question as a new run and opens it', async () => {
  const failed = pastRun('run-past-f', { status: 'failed', error: "The local model isn't answering, so there is no answer yet. Check Intelligence on Assistant status, then try again.", output: { text: '', citations: [], entries: entries.slice(0, 1), from: 'journal', unread: null } });
  const page = await open(desk, '#run/run-past-f', { runs: [failed] });
  const again = body(page).locator('.past-work__again button', { hasText: 'Try again' });
  await again.waitFor(T);
  assert.doesNotMatch(await page.locator('#runDrawer').innerText(), /ECONNREFUSED|Ollama/);
  assert.equal(await body(page).locator('.past-work__again .ui-notice:visible').count(), 0, 'no empty error box under Try again');
  await again.click();
  await page.waitForFunction(() => location.hash === '#run/run-past-retry', null, T);
  assert.deepEqual(page.db.retries, ['run-past-f']);
  await body(page).locator('.past-work__answer').waitFor(T);
  assert.equal(await body(page).locator('.past-work__again').count(), 0, 'a finished run has no Try again');
  await page.context().close();
});

await check('an entry deleted before a reload (or elsewhere) shows as deleted, without Delete', async () => {
  const page = await open(desk, '#run/run-past-1', { runs: [pastRun('run-past-1')], gone: ['j-1-a'] });
  const first = body(page).locator('.past-work__entry').first();
  await first.locator('.past-work__status', { hasText: 'Deleted from your past work' }).waitFor(T);
  assert.equal(await first.locator('.past-work__delete').count(), 0);
  assert.equal(await body(page).locator('.past-work__entry').nth(1).locator('.past-work__delete').count(), 1, 'one still there keeps Delete');
  await page.context().close();
});

await check('with Intelligence down, Past work stays on and says what it needs', async () => {
  const page = await open(desk, '#home', { intelligence: false });
  await page.waitForFunction(() => document.querySelector('.mode[data-mode="ask"]')?.disabled, null, T);
  await page.locator('#homeModeChip').click();
  const row = page.locator('#homeModeSheet [data-home-mode="history"]');
  await row.waitFor(T);
  assert.equal(await row.isEnabled(), true);
  assert.equal((await row.locator('span').textContent()).trim(), "Answers need Intelligence running; it can still say what it couldn't find");
  assert.equal(await page.locator('#homeModeSheet [data-home-mode="ask"]').isDisabled(), true, 'Chat is gated as before');
  await page.context().close();
});

await check('a failed check for deleted entries says so in one line, and keeps Delete', async () => {
  const page = await open(desk, '#run/run-past-1', { runs: [pastRun('run-past-1')], idsFail: true });
  const notice = body(page).locator('.ui-notice.ui-notice--warn', { hasText: "Couldn't check which entries were deleted since" });
  await notice.waitFor(T);
  assert.equal(await notice.evaluate(n => n.nextElementSibling?.classList.contains('ui-rows') && n.previousElementSibling?.textContent), 'What it read', 'under "What it read", above the entries');
  assert.equal(await body(page).locator('.past-work__delete').count(), 2, 'entries are not drawn as deleted');
  await page.context().close();
});

await check('the whole entry row is the link target, and Delete stays clickable above it', async () => {
  const page = await open(phone, '#run/run-past-1', { runs: [pastRun('run-past-1')] });
  const row = body(page).locator('.past-work__entry').first();
  await row.waitFor(T);
  const box = await row.boundingBox(), link = await row.locator('a').evaluate(a => getComputedStyle(a, '::after').position);
  assert.equal(link, 'absolute'); assert.ok(box.height >= 44, `row is ${box.height}px tall`);
  await row.locator('.past-work__delete').click();
  await page.locator('dialog.ask-sheet[open]').waitFor(T);
  await page.context().close();
});

await check('touch targets at 390: a one-line citation and the Workshop link are at least 44px tall', async () => {
  const short = { n: 1, id: 'j-9-s', at: iso(2), source: 'run', kind: 'chat', title: 'Hinges', link: '#run/run-h' };
  const page = await open(phone, '#run/run-t1', { runs: [
    pastRun('run-t1', { output: { text: 'Brass [1].', citations: [short], entries: [short], from: 'journal', unread: null } }),
    pastRun('run-t2', { title: 'did my last print finish', output: { text: "Bambuddy isn't answering, so I can't say what was printed.", citations: [], entries: [], from: 'prints', unread: "Bambuddy isn't answering" } })
  ] });
  assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), true, 'a touch context');
  const cite = body(page).locator('.past-work__cites li').first();
  await cite.waitFor(T);
  const one = await cite.evaluate(li => { const a = li.querySelector('a'); return a.getClientRects().length === 1; });
  assert.ok(one, 'the citation link is one line');
  assert.ok((await cite.boundingBox()).height >= 44, `citation row ${(await cite.boundingBox()).height}px`);
  assert.equal(await cite.locator('a').evaluate(a => { const r = a.closest('li').getBoundingClientRect(), x = r.left + 4, y = r.top + r.height / 2; return document.elementFromPoint(x, y)?.closest('a') === a; }), true, 'the whole row opens the link');
  assert.equal(await body(page).locator('.past-work__entry .past-work__delete').first().evaluate(b => { const r = b.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('button') === b; }), true, 'Delete is above the cover');
  await page.evaluate(() => window.LocalAIRouter.go('#run/run-t2'));
  const hub = body(page).locator('.past-work__again a.ui-btn');
  await hub.waitFor(T);
  assert.ok((await hub.boundingBox()).height >= 44, `Workshop link ${(await hub.boundingBox()).height}px`);
  await page.context().close();
});

await check('a Try again the server refuses says why in a bad notice beside it, and keeps Try again', async () => {
  const failed = pastRun('run-past-f2', { status: 'failed', error: "The local model isn't answering, so there is no answer yet.", output: { text: '', citations: [], entries: [], from: 'journal', unread: null } });
  const page = await open(desk, '#run/run-past-f2', { runs: [failed], retryStatus: 503 });
  const again = body(page).locator('.past-work__again button', { hasText: 'Try again' });
  await again.waitFor(T);
  await again.click();
  await body(page).locator('.past-work__again p.ui-notice.ui-notice--bad[role="alert"]', { hasText: "Couldn't ask again: The run ledger is busy." }).waitFor(T);
  assert.equal(await again.isEnabled(), true);
  assert.equal(await body(page).locator('.status-error').count(), 0, 'Past work draws no muted error text');
  await page.context().close();
});

await browser.close();
if (failures.length) { console.error(`\n${failures.length} failed:\n${failures.join('\n')}`); process.exit(1); }
