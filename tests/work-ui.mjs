import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { addAxe } from './axe-helper.mjs';
const { workKind } = createRequire(import.meta.url)('../app/run-cards.js'); // the server's own chip mapping

const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const axePath = join(dirname(fileURLToPath(import.meta.url)), 'vendor', 'axe.min.js');
const browser = await chromium.launch({ headless: true });
const T = { timeout: 6000 };
const failures = [];
async function check(name, fn) {
  try { await fn(); console.log('PASS', name); } catch (error) { failures.push(`${name}: ${error.message}`); console.error('FAIL', name, error.message); }
}

// Noon today, on the page's clock too: Work groups by calendar day, so ages measured from the real time put "2 hours
// ago" on Yesterday between midnight and 2 AM and the day-group check failed every night.
const HOUR = 3600e3, NOW = new Date(new Date().setHours(12, 0, 0, 0)).getTime();
let seq = 0;
// A /api/runs list item the way the server sends it: the run plus `card`.
const item = (kind, title, ageMs, o = {}) => {
  const n = ++seq, status = o.status || 'completed';
  return {
    id: o.id || `run-${NOW - ageMs}-${n}`, type: kind, status, progress: o.progress ?? (status === 'running' ? 20 : 100), threadId: o.threadId || undefined,
    kept: o.kept ?? (kind === 'chat' || kind === 'research' ? false : undefined),   // the server marks chats and research (☆ Keep)
    createdAt: new Date(NOW - ageMs).toISOString(), updatedAt: new Date(NOW - ageMs).toISOString(),
    card: { kind, icon: 'system', title, summary: o.summary || '', badge: { label: status === 'running' ? 'Working' : 'Done', tone: status === 'running' ? 'accent' : 'good' }, preview: null, action: { label: 'Open' }, approval: null }
  };
};
const mixed = () => [
  item('chat', 'Plan the garden', 5 * 60e3, { summary: 'Raised beds and tomatoes' }),
  item('image', 'A red fox at dusk', 2 * HOUR),
  item('chat', 'Why is sqlite so fast', 26 * HOUR, { summary: 'WAL mode explained' }),
  item('agent', 'Summarise the inbox', 3 * 24 * HOUR),
  item('engineering', 'Add a dark mode toggle', 3 * 24 * HOUR + HOUR),
  item('research', 'Heat pump prices', 30 * 24 * HOUR),
  item('automation', 'Nightly backup', 31 * 24 * HOUR)
];
// Stub state: `list(url)` answers each /api/runs request; `calls` records the URLs.
async function open(viewport, hash, list, { storage = {}, center = true } = {}) {
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport, isMobile: viewport.width < 760, hasTouch: viewport.width < 760 });
  await ctx.addInitScript(s => { try { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); } } catch {} }, { 'localai.devTools': '1', ...storage });
  const page = await ctx.newPage({ serviceWorkers: 'block' });
  await page.clock.install({ time: NOW });
  page.calls = []; page.known = new Map();
  await page.route(u => u.pathname === '/api/runs', async r => {
    const url = new URL(r.request().url());
    const json = body => r.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (url.searchParams.get('id')) { const it = page.known.get(url.searchParams.get('id')); return it ? json({ item: it }) : r.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Run not found"}' }); }
    if (!url.searchParams.get('threads')) return json({ items: center ? [...page.known.values()] : [], summary: {} }); // the run center's own poll (newest 120)
    page.calls.push(url);
    let out = await list(url, page.calls.length);
    const kind = url.searchParams.get('kind'); // the server filters by Work's chip
    if (kind && Array.isArray(out)) out = out.filter(it => workKind(it) === kind);
    for (const it of Array.isArray(out) ? out : []) page.known.set(it.id, it);
    if (out && out.status) return r.fulfill({ status: out.status, contentType: 'application/json', body: JSON.stringify({ error: 'Server blew up' }) });
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: out, summary: {} }) });
  });
  await page.goto(base + '/' + hash, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.showView === 'function' && window.LocalAIRouter && location.hash, null, { timeout: 8000 });
  return page;
}
const rows = page => page.locator('#work .run-card');
// A chip asks the server for its kind; the list is busy until that page arrives.
const pick = async (page, k) => { await page.locator(`[data-work-kind="${k}"]`).click(); await page.waitForSelector('#workList:not([aria-busy="true"])', T); };
// Pages like the server: `kind` first, then newest first by (createdAt, id), `before` and `limit`.
const newestFirst = (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
const paged = all => url => { const k = url.searchParams.get('kind'); let l = [...all].filter(it => !k || workKind(it) === k).sort(newestFirst); const b = url.searchParams.get('before'); if (b) { const ref = l.find(x => x.id === b); l = l.filter(x => newestFirst(x, ref) > 0); } return l.slice(0, Number(url.searchParams.get('limit')) || 120); };
const chatsAndOldMission = () => [...Array.from({ length: 70 }, (_, i) => item('chat', `Chat ${i}`, (i + 1) * HOUR, { threadId: `t${i}` })), item('agent', 'The old mission', 200 * HOUR, { id: 'old-mission' })];
const kinds = async page => [...new Set(await rows(page).evaluateAll(r => r.map(x => x.dataset.kind)))].sort();
const desk = { width: 1280, height: 860 }, phone = { width: 390, height: 844 };

await check('day groups come in order: Today, Yesterday, Earlier this week, Older', async () => {
  const page = await open(desk, '#work', async () => mixed());
  await page.waitForSelector('#work.active .run-card', T);
  assert.deepEqual(await page.locator('#work .work-day').allInnerTexts(), ['Today', 'Yesterday', 'Earlier this week', 'Older']);
  assert.equal(await rows(page).count(), 7);
  const urls = page.calls.map(u => u.search);
  assert.ok(urls.some(s => s.includes('threads=1') && s.includes('limit=60')), urls.join());
  await page.context().close();
});

// A7 P6: the hourly health check is one row a day, its newest run, with the count and the time range; Select shows each.
await check('an automation run many times in one day is one row with its count and times; Select mode lists each run', async () => {
  const hourly = h => ({ ...item('automation', 'Hourly health check', h * HOUR, { summary: 'All good' }), meta: { automationId: 'auto-health' } });
  const page = await open(desk, '#work', async () => [item('chat', 'Plan the garden', 5 * 60e3), ...[1, 2, 3, 4].map(hourly), hourly(30)]);
  await page.waitForSelector('#work.active .run-card', T);
  const titles = await rows(page).evaluateAll(r => r.map(x => x.querySelector('.list-row__title, .run-card__title')?.textContent.trim()));
  assert.deepEqual(titles.filter(t => t === 'Hourly health check').length, 2, 'one row today, one yesterday: ' + titles.join(' | '));
  const today = page.locator('#work .work-group').first();
  assert.match(await today.innerText(), /4 times · 8:00\s?AM–11:00\s?AM · All good/);
  assert.doesNotMatch(await page.locator('#work .work-group').nth(1).innerText(), /times/, 'a single run says nothing about repeats');
  await page.locator('#workSelect').click();
  await page.waitForFunction(() => document.querySelectorAll('#work .work-pick').length === 6, null, T);
  await page.context().close();
});

await check('chips filter by kind, the hash mirrors the chip, and a reload keeps it', async () => {
  const page = await open(desk, '#work', async () => mixed());
  await page.waitForSelector('#work .run-card', T);
  assert.deepEqual(await page.locator('#work [data-work-kind]').evaluateAll(b => b.map(x => x.dataset.workKind)), ['all', 'needs', 'chats', 'images', 'missions', 'sheets', 'changes', 'other']);
  await pick(page, 'images');
  assert.deepEqual(await kinds(page), ['image']);
  assert.equal(page.calls.at(-1).searchParams.get('kind'), 'images', 'the chip asks the server');
  assert.equal(await page.evaluate(() => location.hash), '#work?kind=images');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#work.active .run-card', T);
  assert.deepEqual(await kinds(page), ['image']);
  assert.equal(await page.locator('[data-work-kind="images"]').getAttribute('aria-checked'), 'true');
  await pick(page, 'chats');
  assert.deepEqual(await kinds(page), ['chat', 'research']);
  await pick(page, 'missions');
  assert.deepEqual(await kinds(page), ['agent']);
  await pick(page, 'changes');
  assert.deepEqual(await kinds(page), ['engineering']);
  await pick(page, 'other');
  assert.deepEqual(await kinds(page), ['automation']);
  await pick(page, 'all');
  assert.equal(await rows(page).count(), 7);
  await page.context().close();
});

await check('the chips are one segmented control: one Tab stop, arrows move and pick, like the page tabs (E5)', async () => {
  const page = await open(desk, '#work', async () => mixed());
  await page.waitForSelector('#work .run-card', T);
  const group = page.locator('#work .work-chips');
  assert.equal(await group.getAttribute('role'), 'radiogroup');
  assert.match(await group.getAttribute('class'), /\bux-tabs\b/);
  const chips = page.locator('#work .work-chips .ux-tab');
  assert.deepEqual(await chips.evaluateAll(b => b.map(x => [x.getAttribute('role'), x.tabIndex])), [['radio', 0], ['radio', -1], ['radio', -1], ['radio', -1], ['radio', -1], ['radio', -1], ['radio', -1], ['radio', -1]]);
  await chips.first().focus();
  await page.keyboard.press('ArrowRight');
  await page.waitForSelector('#workList:not([aria-busy="true"])', T);
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.workKind), 'needs');
  await page.keyboard.press('ArrowRight');
  await page.waitForSelector('#workList:not([aria-busy="true"])', T);
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.workKind), 'chats');
  assert.equal(await page.locator('[data-work-kind="chats"]').getAttribute('aria-checked'), 'true');
  assert.deepEqual(await kinds(page), ['chat', 'research']);
  await page.keyboard.press('End');
  await page.waitForSelector('#workList:not([aria-busy="true"])', T);
  assert.equal(await page.evaluate(() => location.hash), '#work?kind=other');
  assert.equal(await chips.evaluateAll(b => b.filter(x => x.tabIndex === 0).map(x => x.dataset.workKind).join()), 'other');
  await page.context().close();
});

await check('the filter is remembered; the hash wins over what is remembered', async () => {
  const page = await open(desk, '#work', async () => mixed(), { storage: { 'localai.work.kind': 'images' } });
  await page.waitForSelector('#work .run-card', T);
  assert.deepEqual(await kinds(page), ['image']);
  assert.equal(await page.evaluate(() => location.hash), '#work?kind=images');
  const other = await open(desk, '#work?kind=missions', async () => mixed(), { storage: { 'localai.work.kind': 'images' } });
  await other.waitForSelector('#work .run-card', T);
  assert.deepEqual(await kinds(other), ['agent']);
  await page.context().close(); await other.context().close();
});

await check('search filters the loaded rows by title and summary, ignoring case', async () => {
  const page = await open(desk, '#work', async () => mixed());
  await page.waitForSelector('#work .run-card', T);
  await page.locator('#workSearch').fill('SQLite');
  assert.deepEqual(await rows(page).locator('.list-row__title').allInnerTexts(), ['Why is sqlite so fast']);
  await page.locator('#workSearch').fill('raised beds');
  assert.deepEqual(await rows(page).locator('.list-row__title').allInnerTexts(), ['Plan the garden']);
  await page.locator('#workSearch').fill('zzzz');
  assert.equal(await rows(page).count(), 0);
  assert.match(await page.locator('#work').innerText(), /Nothing matches/);
  await page.locator('#workSearch').fill('');
  assert.equal(await rows(page).count(), 7);
  assert.equal(await page.calls.length, 1, 'search never asks the server');
  await page.context().close();
});

await check('Show more appends the next page by before= and hides when fewer than 60 come back', async () => {
  const first = Array.from({ length: 60 }, (_, i) => item('chat', `Chat ${i}`, (i + 1) * HOUR, { threadId: `t${i}` }));
  const next = Array.from({ length: 5 }, (_, i) => item('chat', `Old chat ${i}`, (100 + i) * HOUR, { threadId: `o${i}` }));
  const page = await open(desk, '#work', async url => url.searchParams.get('before') ? next : first);
  await page.waitForSelector('#work .run-card', T);
  assert.equal(await rows(page).count(), 60);
  assert.equal(await page.locator('#workMore').isVisible(), true);
  await page.locator('#workMore').click();
  await page.waitForFunction(() => document.querySelectorAll('#work .run-card').length === 65, null, T);
  assert.equal(page.calls.at(-1).searchParams.get('before'), first[59].id);
  assert.equal(page.calls.at(-1).searchParams.get('limit'), '60');
  assert.equal(await page.locator('#workMore').isVisible(), false);
  await page.context().close();
});

// The chips filter on the server, so an older mission behind a page of chats is one tap away. An empty first page then
// means there are none, and Show more stays hidden.
await check('a chip asks the server for its kind: an old mission behind 70 chats shows; Show more pages within the kind', async () => {
  const page = await open(desk, '#work', paged(chatsAndOldMission()));
  await page.waitForSelector('#work .run-card', T);
  assert.equal(await rows(page).count(), 60);
  assert.equal(await page.locator('#workMore').isVisible(), true);
  await pick(page, 'missions');
  assert.deepEqual(await rows(page).locator('.list-row__title').allInnerTexts(), ['The old mission']);
  assert.equal(page.calls.at(-1).searchParams.get('kind'), 'missions');
  assert.equal(await page.locator('#workMore').isVisible(), false, 'one mission: nothing more to show');
  await pick(page, 'chats');
  assert.equal(await rows(page).count(), 60);
  await page.locator('#workMore').click();
  await page.waitForFunction(() => document.querySelectorAll('#work .run-card').length === 70, null, T);
  assert.equal(page.calls.at(-1).searchParams.get('kind'), 'chats');
  assert.ok(page.calls.at(-1).searchParams.get('before'));
  assert.deepEqual(await kinds(page), ['chat']);
  assert.equal(await page.locator('#workMore').isVisible(), false);
  await page.context().close();
});

await check('a kind with none says so, and Show more stays hidden', async () => {
  const first = Array.from({ length: 60 }, (_, i) => item('chat', `Chat ${i}`, (i + 1) * HOUR, { threadId: `t${i}` }));
  const page = await open(desk, '#work', async () => first);
  await page.waitForSelector('#work .run-card', T);
  assert.equal(await page.locator('#workMore').isVisible(), true);
  await pick(page, 'missions');
  assert.equal(await rows(page).count(), 0);
  assert.match(await page.locator('#work').innerText(), /No missions yet/);
  assert.equal(await page.locator('#workMore').isVisible(), false);
  await pick(page, 'all');
  assert.equal(await page.locator('#workMore').isVisible(), true);
  await page.context().close();
});

await check('a failed load says so with Retry, and Retry recovers', async () => {
  let fail = true;
  const page = await open(desk, '#work', async () => fail ? { status: 500 } : mixed());
  await page.waitForSelector('#work .state-error', T);
  assert.match(await page.locator('#work .state-error').innerText(), /Couldn't load your work\./);
  fail = false;
  await page.locator('#work .state-error button', { hasText: 'Retry' }).click();
  await page.waitForSelector('#work .run-card', T);
  assert.equal(await rows(page).count(), 7);
  await page.context().close();
});

await check('a running row updates in place within 6 s and the scroll position stays', async () => {
  let n = 0;
  const filler = Array.from({ length: 30 }, (_, i) => item('chat', `Filler ${i}`, (i + 2) * HOUR, { threadId: `f${i}` }));
  const run = item('agent', 'Sorting the archive', 60e3, { status: 'running' });
  const page = await open(desk, '#work', async () => { n++; return [{ ...run, progress: n === 1 ? 20 : 70 }, ...filler]; });
  await page.waitForSelector('#work .run-card', T);
  const bar = page.locator(`#work [data-run-id="${run.id}"] [role="progressbar"]`);
  assert.equal(await bar.getAttribute('aria-valuenow'), '20');
  await page.evaluate(() => window.scrollTo(0, 400));
  const before = await page.evaluate(() => window.scrollY);
  assert.ok(before > 100, 'the page scrolls');
  await page.waitForFunction(id => document.querySelector(`#work [data-run-id="${id}"] [role="progressbar"]`)?.getAttribute('aria-valuenow') === '70', run.id, T);
  assert.ok(Math.abs(await page.evaluate(() => window.scrollY) - before) < 4, 'scroll kept');
  assert.equal(await page.locator(`#work [data-run-id="${run.id}"]`).count(), 1);
  await page.context().close();
});

await check('a failed refresh keeps the list but says it is stale; the next good one clears that', async () => {
  // A28: unreadable is not current. With the server down the last list (a "running" run included) stayed on screen
  // with no cue at all.
  let n = 0;
  const run = item('agent', 'Sorting the archive', 60e3, { status: 'running' });
  const page = await open(desk, '#work', async () => { n++; return n === 2 || n === 3 ? { status: 500 } : [run, ...mixed()]; });
  await page.waitForSelector('#work .run-card', T);
  assert.equal(await page.locator('#workNotice').isHidden(), true, 'no notice while the reads are good');
  const live = page.locator(`#work [data-run-id="${run.id}"]`);
  assert.equal(await live.locator('[role="progressbar"]').count(), 1);
  await page.waitForSelector('#workNotice:not([hidden])', T);
  // The kit's words: source_down with the one name "Local AI", and the age.
  assert.match(await page.locator('#workNotice').innerText(), /^Local AI isn't answering\. Showing runs from (\d+ min ago|\d{1,2}:\d{2}\s?[AP]M)\.$/);
  assert.equal(await page.locator('#workNotice').getAttribute('role'), 'status');
  assert.equal(await rows(page).count(), 8, 'the last list stays on screen');
  assert.equal(await page.locator('#workPlate [data-plate-lamp]').innerText(), 'Unknown', 'a stale running count is not shown as Running');
  assert.equal(await page.locator('#workPlate .ui-readout').innerText(), '—');
  assert.match(await page.locator('#workSources').innerText(), /Not answering\s+last read /);
  // A run read as running before the failure is not known to be running now: the unknown chip, no progress bar.
  assert.equal((await live.locator('.list-row__trail').innerText()).trim(), 'Unknown');
  assert.equal(await live.locator('.list-row__trail .ui-chip--unknown').count(), 1);
  assert.equal(await live.locator('[role="progressbar"]').count(), 0);
  // A second failed poll with the same words does not write the live region again.
  await page.evaluate(() => { window.__noticeWrites = 0; new MutationObserver(m => { window.__noticeWrites += m.length; }).observe(document.getElementById('workNotice'), { childList: true, characterData: true, subtree: true }); });
  for (let i = 0; i < 80 && n < 3; i++) await page.waitForTimeout(100);
  await page.waitForTimeout(300);
  assert.equal(n >= 3, true, 'the second failed poll happened');
  assert.equal(await page.evaluate(() => window.__noticeWrites), 0, 'the same text is not rewritten');
  await page.waitForSelector('#workNotice[hidden]', { ...T, state: 'attached' });
  assert.equal(await page.locator('#workPlate [data-plate-lamp]').innerText(), 'Running');
  assert.match(await page.locator('#workSources').innerText(), /Answering/);
  assert.equal(await live.locator('[role="progressbar"]').count(), 1, 'the bar is back after a good read');
  assert.doesNotMatch(await live.locator('.list-row__trail').innerText(), /Unknown/);
  await page.context().close();
});

await check('a chat thread says how many turns (from the server) and keeps its latest summary', async () => {
  const a = { ...item('chat', 'Budget talk', 1 * HOUR, { threadId: 'tb', summary: 'Latest answer about the budget' }), turns: 3 };
  const c = { ...item('chat', 'Lone chat', 3 * HOUR, { threadId: 'tl', summary: 'Just one turn' }), turns: 1 };
  const page = await open(desk, '#work', async () => [a, c]);
  await page.waitForSelector('#work .run-card', T);
  assert.equal(await page.locator(`#work [data-run-id="${a.id}"] .list-row__sub`).innerText(), 'Chat · 3 turns');
  assert.match(await page.locator(`#work [data-run-id="${a.id}"]`).innerText(), /Latest answer about the budget/);
  assert.equal(await page.locator(`#work [data-run-id="${c.id}"] .list-row__sub`).innerText(), 'Just one turn');
  await page.context().close();
});

await check('a text run shows its answer once, not as summary and again as preview', async () => {
  const r = item('chat', 'Meaning of life', HOUR, { threadId: 'ml', summary: 'The answer is forty-two' });
  r.card.preview = { type: 'text', text: 'The answer is forty-two, as computed by Deep Thought.' };
  const other = item('research', 'Quotes', 2 * HOUR, { summary: 'Short summary' });
  other.card.preview = { type: 'text', text: 'A different full text that adds more' };
  const page = await open(desk, '#work', async () => [r, other]);
  await page.waitForSelector('#work .run-card', T);
  const t = await page.locator(`#work [data-run-id="${r.id}"]`).innerText();
  assert.equal(t.split('The answer is forty-two').length - 1, 1, t);
  assert.match(await page.locator(`#work [data-run-id="${other.id}"]`).innerText(), /Short summary[\s\S]*A different full text/);
  await page.context().close();
});

// A7 P1/P8 (L2b): Work's faceplate counts what is running from the rows, names the newest, and shows no count when the
// first page fails.
await check("Work's faceplate: what is running, the newest, today and this week; a failed load shows no count", async () => {
  const live = item('chat', 'Writing the summary', 60_000, { status: 'running' }), older = item('chat', 'Last week', 3 * 864e5);
  let page = await open(desk, '#work', async () => [live, older]);
  await page.waitForSelector('#workPlate[aria-busy="false"]', T);
  assert.equal((await page.locator('#workPlate .ui-readout').innerText()).trim(), '1 running');
  assert.equal((await page.locator('#workPlate [data-plate-lamp]').innerText()).trim(), 'Running');
  assert.equal(await page.locator('#workLatest').innerText(), 'Latest: Writing the summary');
  assert.deepEqual([await page.locator('#workToday').innerText(), await page.locator('#workWeek').innerText()], ['1', '2']);
  await page.context().close();
  page = await open(desk, '#work', async () => ({ status: 500 }));
  await page.waitForSelector('#workPlate[aria-busy="false"]', T);
  assert.equal((await page.locator('#workPlate .ui-readout').innerText()).trim(), '—');
  assert.match(await page.locator('#workSources').innerText(), /Not answering/);
  await page.context().close();
});

await check('the whole row opens the run: no per-row Open button, Review and Retry stay small buttons', async () => {
  const rev = item('engineering', 'Fix the login bug', HOUR, { status: 'awaiting_approval' }); rev.card.action = { label: 'Review' };
  const retry = item('agent', 'Failed mission', 2 * HOUR, { status: 'failed' }); retry.card.action = { label: 'Retry' };
  const plain = item('chat', 'Plain chat', 3 * HOUR, { threadId: 'pc' });
  const page = await open(desk, '#work', async () => [rev, retry, plain]);
  await page.waitForSelector('#work .run-card', T);
  assert.equal(await page.locator('#work .run-card__action').filter({ hasText: /^Open$/ }).count(), 0);
  assert.deepEqual(await page.locator('#work .work-secondary').allInnerTexts(), ['Review', 'Retry']);
  const name = page.getByRole('button', { name: 'Plain chat', exact: true });   // its ☆ is "Keep Plain chat"
  assert.equal(await name.count(), 1, 'the row has one button named by its title');
  const row = page.locator(`#work [data-run-id="${plain.id}"]`);
  await row.scrollIntoViewIfNeeded();   // the faceplate sits above the list (A7 P1)
  const box = await row.boundingBox();
  await page.mouse.click(box.x + box.width - 140, box.y + box.height / 2); // empty space inside the row, away from the title text
  await page.waitForFunction(h => location.hash === h, '#run/' + plain.id, T);
  await page.evaluate(() => history.back());
  await page.waitForSelector('#work.active', T);
  await page.locator(`#work [data-run-id="${rev.id}"] .work-secondary`).click();
  await page.waitForFunction(h => location.hash === h, '#run/' + rev.id, T);
  await page.context().close();
});

await check('Work says Work everywhere, and its strip lists Work and Assistant automations', async () => {
  const page = await open(desk, '#work', async () => mixed());
  await page.waitForSelector('#work .run-card', T);
  assert.equal(await page.locator('#work h1').innerText(), 'Work');
  const chrome = await page.evaluate(() => [document.getElementById('uxContextBar')?.innerText, document.getElementById('uxPageStrip')?.innerText].join(' | '));
  assert.match(chrome, /Work/); assert.doesNotMatch(chrome, /Runs/);
  assert.doesNotMatch(await page.locator('#work').innerText(), /\bRuns\b/);
  assert.deepEqual(await page.locator('#uxPageStrip button').allInnerTexts(), ['Work', 'Agent World', 'Assistant automations']);
  await page.context().close();
});

await check('390px: a 40-character title is shown whole, not cut at ~20 characters', async () => {
  const long = 'Summarise the quarterly sales report now';
  assert.equal(long.length, 40);
  const r = item('agent', long, HOUR, { status: 'running' });
  const page = await open(phone, '#work', async () => [r, ...mixed()]);
  await page.waitForSelector('#work .run-card', T);
  const t = page.locator(`#work [data-run-id="${r.id}"] .list-row__title`);
  const m = await t.evaluate(e => ({ clipped: e.scrollHeight > e.clientHeight + 1 || e.scrollWidth > e.clientWidth + 1, ellipsis: getComputedStyle(e).textOverflow, overflow: getComputedStyle(e).overflow }));
  assert.equal(m.clipped, false, JSON.stringify(m));
  const row = await page.locator(`#work [data-run-id="${r.id}"]`).boundingBox();
  assert.ok(row.x <= 18 && row.width >= 390 - 2 * 18, `the list is flush to a 16px gutter: ${JSON.stringify(row)}`);
  await page.context().close();
});

await check('a run that disappears is dropped on the next refresh', async () => {
  const live = item('agent', 'Still working', 60e3, { status: 'running' }), gone = item('chat', 'About to vanish', HOUR, { threadId: 'gone' });
  const page = await open(desk, '#work', async (_u, n) => n === 1 ? [live, gone] : [live]);
  await page.waitForSelector(`#work [data-run-id="${gone.id}"]`, T);
  await page.waitForFunction(id => !document.querySelector(`#work [data-run-id="${id}"]`), gone.id, T);
  await page.context().close();
});

await check('opening a row opens its run view', async () => {
  const page = await open(desk, '#work', async () => mixed());
  await page.waitForSelector('#work .run-card', T);
  const id = await rows(page).first().getAttribute('data-run-id');
  await rows(page).first().click();
  await page.waitForFunction(h => location.hash === h, '#run/' + id, T);
  await page.evaluate(() => history.back());
  await page.waitForFunction(() => location.hash === '#work', null, T);
  await page.waitForSelector('#work.active', T);
  await page.context().close();
});

await check('a spreadsheet request opens Spreadsheets, where Keep and Discard are', async () => {
  const page = await open(desk, '#work', async () => [item('spreadsheet', 'Add a Total row to Sales', 10 * 60e3, { id: 'legacy-gridcraft:gc-1', status: 'awaiting_approval' }), ...mixed()]);
  await page.waitForSelector('#work .run-card[data-run-id="legacy-gridcraft:gc-1"]', T);
  await page.locator('#work .run-card[data-run-id="legacy-gridcraft:gc-1"] .work-open').click();
  await page.waitForFunction(() => location.hash === '#spreadsheets', null, T);
  await page.waitForSelector('#spreadsheets.active', T);
  await page.context().close();
});

await check('a row the run center has not loaded still opens (by id)', async () => {
  const page = await open(desk, '#work', async () => mixed(), { center: false });
  await page.waitForSelector('#work .run-card', T);
  const id = await rows(page).nth(2).getAttribute('data-run-id');
  await rows(page).nth(2).click();
  await page.waitForFunction(h => location.hash === h, '#run/' + id, T);
  await page.waitForSelector('#runDrawer .run-view-head, #runDrawer', T);
  await page.context().close();
});

await check("nothing yet: the list says so, and the faceplate's Start something opens Home's composer", async () => {
  const page = await open(desk, '#work', async () => []);
  await page.waitForSelector('#work .empty-state', T);
  assert.match(await page.locator('#workList').innerText(), /Nothing yet\s+What you start from Home appears here/);
  assert.equal(await page.locator('#work button', { hasText: 'Start something' }).count(), 1);
  await page.locator('#workStart').click();   // the faceplate's: one Start something per page (A7 P1)
  await page.waitForSelector('#home.active', T);
  await page.waitForFunction(() => document.activeElement?.id === 'commandInput', null, T);
  await page.context().close();
});

// #agents is Agent World again (Pi Hub A7 plan, decision 9); Work's Missions filter is #work?kind=missions.
await check('/#work?kind=missions lands on the old mission behind 70 chats', async () => {
  const page = await open(desk, '#work?kind=missions', paged(chatsAndOldMission()));
  await page.waitForSelector('#work.active .run-card', T);
  assert.equal(await page.evaluate(() => location.hash), '#work?kind=missions');
  assert.deepEqual(await rows(page).locator('.list-row__title').allInnerTexts(), ['The old mission']);
  await page.context().close();
});

for (const viewport of [phone, desk]) {
  await check(`${viewport.width}px: /#work?kind=missions lands on Work with the Missions chip, only mission rows`, async () => {
    const page = await open(viewport, '#work?kind=missions', async () => mixed());
    await page.waitForSelector('#work.active .run-card', T);
    assert.equal(await page.locator('[data-work-kind="missions"]').getAttribute('aria-checked'), 'true');
    assert.deepEqual(await kinds(page), ['agent']);
    assert.equal(await page.evaluate(() => location.hash), '#work?kind=missions');
    assert.equal(await page.locator('#agents.active').count(), 0);
    await page.context().close();
  });
}

await check('☆ Keep on a chat row keeps it in Library and a second tap takes it out; the row stays and does not open', async () => {
  const chat = item('chat', 'Plan the garden', 5 * 60e3, { summary: 'Raised beds' }), img = item('image', 'A red fox at dusk', 2 * HOUR);
  const page = await open(desk, '#work', async () => [chat, img]);
  const posts = [];
  await page.route(u => u.pathname === '/api/library/keep', r => { const b = JSON.parse(r.request().postData()); posts.push(b); r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, kept: b.kept, item: null }) }); });
  const star = page.locator(`[data-run-id="${chat.id}"] .work-keep`);
  await star.waitFor(T);
  assert.equal(await page.locator(`[data-run-id="${img.id}"] .work-keep`).count(), 0, 'images are kept by themselves');
  assert.equal(await star.getAttribute('aria-pressed'), 'false');
  assert.equal(await star.getAttribute('aria-label'), 'Keep Plan the garden');
  assert.equal(await star.innerText(), '☆');
  await star.click();
  await page.waitForFunction(id => document.querySelector(`[data-run-id="${id}"] .work-keep`)?.getAttribute('aria-pressed') === 'true', chat.id, T);
  assert.equal(await star.innerText(), '★');
  assert.ok(!/^#run\//.test(await page.evaluate(() => location.hash)), 'the tap did not open the run');
  await star.click();
  await page.waitForFunction(id => document.querySelector(`[data-run-id="${id}"] .work-keep`)?.getAttribute('aria-pressed') === 'false', chat.id, T);
  assert.deepEqual(posts, [{ runId: chat.id, kept: true }, { runId: chat.id, kept: false }]);
  assert.equal(await page.locator(`#work [data-run-id="${chat.id}"]`).count(), 1, 'un-keep leaves the row in Work');
  await page.context().close();
});

await check('axe: Work passes color-contrast and target-size at 390x844', async () => {
  const page = await open(phone, '#work', async () => [...mixed(), item('agent', 'Sorting the archive', 60e3, { status: 'running' })]);
  await page.waitForSelector('#work .run-card', T);
  await addAxe(page, axePath);
  const v = await page.evaluate(() => window.axe.run('#work', { runOnly: { type: 'rule', values: ['color-contrast', 'target-size'] } }).then(r => r.violations.map(x => `${x.id}: ${x.nodes.map(n => n.html).join(' | ')}`)));
  assert.deepEqual(v, []);
  await pick(page, 'images');
  const v2 = await page.evaluate(() => window.axe.run('#work', { runOnly: { type: 'rule', values: ['color-contrast', 'target-size'] } }).then(r => r.violations.map(x => x.id)));
  assert.deepEqual(v2, []);
  await page.context().close();
});

await browser.close();
if (failures.length) { console.error('\n' + failures.length + ' failing:\n' + failures.join('\n')); process.exit(1); }
console.log('\nAll Work UI checks passed');
