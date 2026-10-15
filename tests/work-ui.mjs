import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const axePath = join(dirname(fileURLToPath(import.meta.url)), 'vendor', 'axe.min.js');
const browser = await chromium.launch({ headless: true });
const T = { timeout: 6000 };
const failures = [];
async function check(name, fn) {
  try { await fn(); console.log('PASS', name); } catch (error) { failures.push(`${name}: ${error.message}`); console.error('FAIL', name, error.message); }
}

const HOUR = 3600e3, NOW = Date.now();
let seq = 0;
// A /api/runs list item the way the server sends it: the run plus `card`.
const item = (kind, title, ageMs, o = {}) => {
  const n = ++seq, status = o.status || 'completed';
  return {
    id: o.id || `run-${NOW - ageMs}-${n}`, type: kind, status, progress: o.progress ?? (status === 'running' ? 20 : 100), threadId: o.threadId || undefined,
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
  const ctx = await browser.newContext({ viewport, isMobile: viewport.width < 760, hasTouch: viewport.width < 760 });
  await ctx.addInitScript(s => { try { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); } } catch {} }, { 'localai.devTools': '1', ...storage });
  const page = await ctx.newPage();
  page.calls = []; page.known = new Map();
  await page.route(u => u.pathname === '/api/runs', async r => {
    const url = new URL(r.request().url());
    const json = body => r.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (url.searchParams.get('id')) { const it = page.known.get(url.searchParams.get('id')); return it ? json({ item: it }) : r.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Run not found"}' }); }
    if (!url.searchParams.get('threads')) return json({ items: center ? [...page.known.values()] : [], summary: {} }); // the run center's own poll (newest 120)
    page.calls.push(url);
    const out = await list(url, page.calls.length);
    for (const it of Array.isArray(out) ? out : []) page.known.set(it.id, it);
    if (out && out.status) return r.fulfill({ status: out.status, contentType: 'application/json', body: JSON.stringify({ error: 'Server blew up' }) });
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: out, summary: {} }) });
  });
  await page.goto(base + '/' + hash, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.showView === 'function' && window.LocalAIRouter && location.hash, null, { timeout: 8000 });
  return page;
}
const rows = page => page.locator('#work .run-card');
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

await check('chips filter by kind, the hash mirrors the chip, and a reload keeps it', async () => {
  const page = await open(desk, '#work', async () => mixed());
  await page.waitForSelector('#work .run-card', T);
  assert.deepEqual(await page.locator('#work [data-work-kind]').evaluateAll(b => b.map(x => x.dataset.workKind)), ['all', 'chats', 'images', 'missions', 'changes', 'other']);
  await page.locator('[data-work-kind="images"]').click();
  assert.deepEqual(await kinds(page), ['image']);
  assert.equal(await page.evaluate(() => location.hash), '#work?kind=images');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#work.active .run-card', T);
  assert.deepEqual(await kinds(page), ['image']);
  assert.equal(await page.locator('[data-work-kind="images"]').getAttribute('aria-pressed'), 'true');
  await page.locator('[data-work-kind="chats"]').click();
  assert.deepEqual(await kinds(page), ['chat', 'research']);
  await page.locator('[data-work-kind="missions"]').click();
  assert.deepEqual(await kinds(page), ['agent']);
  await page.locator('[data-work-kind="changes"]').click();
  assert.deepEqual(await kinds(page), ['engineering']);
  await page.locator('[data-work-kind="other"]').click();
  assert.deepEqual(await kinds(page), ['automation']);
  await page.locator('[data-work-kind="all"]').click();
  assert.equal(await rows(page).count(), 7);
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

await check('a chat thread with several runs says how many turns', async () => {
  const a = item('chat', 'Budget talk', 1 * HOUR, { threadId: 'tb' }), b = item('chat', 'Budget talk', 2 * HOUR, { threadId: 'tb', summary: 'older turn' }), c = item('chat', 'Lone chat', 3 * HOUR, { threadId: 'tl' });
  const page = await open(desk, '#work', async () => [a, b, c]);
  await page.waitForSelector('#work .run-card', T);
  assert.equal(await rows(page).count(), 2);
  assert.equal(await page.locator(`#work [data-run-id="${a.id}"] .list-row__sub`).innerText(), 'Chat · 2 turns');
  assert.equal(await page.locator(`#work [data-run-id="${c.id}"] .list-row__sub`).count(), 0);
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

await check('a row the run center has not loaded still opens (by id)', async () => {
  const page = await open(desk, '#work', async () => mixed(), { center: false });
  await page.waitForSelector('#work .run-card', T);
  const id = await rows(page).nth(2).getAttribute('data-run-id');
  await rows(page).nth(2).click();
  await page.waitForFunction(h => location.hash === h, '#run/' + id, T);
  await page.waitForSelector('#runDrawer .run-view-head, #runDrawer', T);
  await page.context().close();
});

await check('nothing yet: the empty state starts something on Home', async () => {
  const page = await open(desk, '#work', async () => []);
  await page.waitForSelector('#work .empty-state', T);
  assert.match(await page.locator('#work').innerText(), /Nothing yet\. What should we do\?/);
  await page.locator('#work button', { hasText: 'Start something' }).click();
  await page.waitForSelector('#home.active', T);
  await page.waitForFunction(() => document.activeElement?.id === 'commandInput', null, T);
  await page.context().close();
});

for (const viewport of [phone, desk]) {
  await check(`${viewport.width}px: /#agents lands on Work with the Missions chip, only mission rows`, async () => {
    const page = await open(viewport, '#agents', async () => mixed());
    await page.waitForSelector('#work.active .run-card', T);
    assert.equal(await page.locator('[data-work-kind="missions"]').getAttribute('aria-pressed'), 'true');
    assert.deepEqual(await kinds(page), ['agent']);
    assert.equal(await page.evaluate(() => location.hash), '#work?kind=missions');
    assert.equal(await page.locator('#agents.active').count(), 0);
    await page.context().close();
  });
}

await check('axe: Work passes color-contrast and target-size at 390x844', async () => {
  const page = await open(phone, '#work', async () => [...mixed(), item('agent', 'Sorting the archive', 60e3, { status: 'running' })]);
  await page.waitForSelector('#work .run-card', T);
  await page.addScriptTag({ path: axePath });
  const v = await page.evaluate(() => window.axe.run('#work', { runOnly: { type: 'rule', values: ['color-contrast', 'target-size'] } }).then(r => r.violations.map(x => `${x.id}: ${x.nodes.map(n => n.html).join(' | ')}`)));
  assert.deepEqual(v, []);
  await page.locator('[data-work-kind="images"]').click();
  const v2 = await page.evaluate(() => window.axe.run('#work', { runOnly: { type: 'rule', values: ['color-contrast', 'target-size'] } }).then(r => r.violations.map(x => x.id)));
  assert.deepEqual(v2, []);
  await page.context().close();
});

await browser.close();
if (failures.length) { console.error('\n' + failures.length + ' failing:\n' + failures.join('\n')); process.exit(1); }
console.log('\nAll Work UI checks passed');
