import { chromium } from 'playwright';
import assert from 'node:assert/strict';

// Library (Projects › Everything you kept): text items are list rows, images are cards; on a phone one column
// so titles have room, and the type label in words people use.
const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const browser = await chromium.launch({ headless: true });
const failures = [];
async function check(name, fn) {
  try { await fn(); console.log('PASS', name); } catch (error) { failures.push(`${name}: ${error.message}`); console.error('FAIL', name, error.message); }
}
const at = new Date().toISOString();
const items = [
  { id: 'c1', kind: 'chat', title: 'How do I reset the router to factory settings without losing the config', summary: 'Hold reset for ten seconds.', createdAt: at },
  { id: 'r1', kind: 'research', title: 'Best NAS drives', summary: 'Compared two.', createdAt: at },
  { id: 'i1', kind: 'image', title: 'A lighthouse at dusk', summary: '', createdAt: at }
];
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const errors = []; page.on('pageerror', e => errors.push(e.message));
await page.route('**/api/library', r => r.fulfill({ json: { items } }));
await page.goto(base + '/#library', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof window.showView === 'function');
await page.evaluate(() => window.showView('library'));
await page.waitForSelector('#library.active #libraryGrid .artifact');

await check('one column on a phone, and long titles are not cut to one line', async () => {
  const xs = await page.locator('#libraryGrid .artifact').evaluateAll(a => [...new Set(a.map(e => Math.round(e.getBoundingClientRect().left)))]);
  assert.equal(xs.length, 1);
  const t = await page.locator('[data-artifact="c1"] .artifact-title').evaluate(e => ({ h: e.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(e).lineHeight) || 20 }));
  assert.ok(t.h > t.lh * 1.5, `title height ${t.h}`);
});

await check('type labels read Conversation, Research, Image', async () => {
  assert.deepEqual(await page.locator('#libraryGrid .artifact-kind').allInnerTexts(), ['Conversation', 'Research', 'Image']);
});

await check('text items are list rows; images are cards', async () => {
  assert.equal(await page.locator('#libraryGrid .artifact--row').count(), 2);
  assert.equal(await page.locator('[data-artifact="c1"].artifact--row .artifact-preview').count(), 0);
  assert.equal(await page.locator('[data-artifact="i1"].artifact:not(.artifact--row)').count(), 1);
  assert.equal(await page.locator('[data-artifact="i1"].artifact--row').count(), 0);
});

await check('desktop: rows span the page, one under another; image cards sit side by side', async () => {
  const many = [...items, { id: 'i2', kind: 'image', title: 'A fox', summary: '', createdAt: at }];
  const desk = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await desk.route('**/api/library', r => r.fulfill({ json: { items: many } }));
  await desk.goto(base + '/#library', { waitUntil: 'domcontentloaded' });
  await desk.waitForSelector('#library.active #libraryGrid .artifact--row');
  const box = id => desk.locator(`[data-artifact="${id}"]`).evaluate(e => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  const [c1, r1, i1, i2, grid] = [await box('c1'), await box('r1'), await box('i1'), await box('i2'), await desk.locator('#libraryGrid').evaluate(e => e.getBoundingClientRect().width)];
  assert.ok(c1.w > grid * 0.9 && r1.w > grid * 0.9, `rows ${c1.w}/${r1.w} of ${grid}`);
  assert.ok(r1.y > c1.y && c1.h < 120, `row height ${c1.h}`);
  assert.ok(Math.abs(i1.y - i2.y) < 2 && i2.x > i1.x, 'image cards share a row');
  await desk.close();
});

await check('phone: pages by 24, chips in one scrolling row, the count in the search box (F3)', async () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ id: 'm' + i, kind: i % 3 ? 'chat' : 'research', title: 'Kept thing ' + i, summary: '', createdAt: at }));
  const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await p.route('**/api/library', r => r.fulfill({ json: { items: many } }));
  await p.goto(base + '/#library', { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('#library.active #libraryGrid .artifact');
  const shown = () => p.locator('#libraryGrid .artifact:not(.mobile-clipped)').count();
  await p.waitForFunction(() => document.querySelector('#libraryGrid > .mobile-more'));
  assert.equal(await shown(), 24);
  assert.equal(await p.locator('#libraryGrid > .mobile-more').innerText(), 'Show 24 more');
  await p.locator('#libraryGrid > .mobile-more').click();
  assert.equal(await shown(), 48);
  assert.equal(await p.locator('#libraryGrid > .mobile-more').innerText(), 'Show 12 more');
  assert.equal(await p.evaluate(() => document.activeElement?.classList.contains('mobile-more')), true, 'focus stays on Show more');
  await p.locator('#libraryGrid > .mobile-more').click();
  assert.equal(await shown(), 60);
  assert.equal(await p.locator('#libraryGrid > .mobile-more').count(), 0);
  assert.equal(await p.locator('#librarySearch').getAttribute('placeholder'), 'Search 60 things you kept…');
  const tops = await p.locator('#library .library-chips .ux-tab').evaluateAll(b => [...new Set(b.map(e => Math.round(e.getBoundingClientRect().top)))]);
  assert.equal(tops.length, 1, 'the chips sit in one row');
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'no sideways page scroll');
  await p.locator('#library [data-kind="research"]').click();
  assert.equal(await shown(), 20, 'a new filter starts from the first page (20 research items, too few to clip)');
  await p.close();
});

await check('un-keep from Library: a chat is taken out (it stays in Work), and the empty Library says how to keep one', async () => {
  const p = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  p.on('pageerror', e => errors.push(e.message));
  let lib = [{ id: 'c9', kind: 'conversation', title: 'Plan the garden', summary: 'Raised beds.', createdAt: at, kept: true, pinned: false, meta: {}, data: {} }];
  const deleted = [];
  await p.route('**/api/library', r => r.fulfill({ json: { items: lib } }));
  await p.route('**/api/library/delete', r => { deleted.push(JSON.parse(r.request().postData()).id); lib = []; r.fulfill({ json: { ok: true } }); });
  await p.goto(base + '/#library', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => typeof window.showView === 'function');
  await p.evaluate(() => window.showView('library'));
  await p.locator('[data-artifact="c9"] .delete-artifact').click();
  const sheet = p.locator('dialog.ask-sheet[open]');
  await sheet.waitFor({ timeout: 6000 });
  const text = await sheet.innerText();
  assert.match(text, /Take "Plan the garden" out of Library\?/);
  assert.match(text, /It stays in Work/);
  await sheet.getByRole('button', { name: 'Take out' }).click();
  await p.waitForFunction(() => /Tap ☆ Keep on a chat to keep it here/.test(document.getElementById('libraryGrid')?.innerText || ''), null, { timeout: 6000 });
  assert.deepEqual(deleted, ['c9']);
  await p.close();
});

await check('no script errors', async () => assert.deepEqual(errors, []));
await browser.close();
if (failures.length) { console.error('\nLibrary failures:\n' + failures.map(x => ' - ' + x).join('\n')); process.exit(1); }
console.log('\nAll Library checks passed.');
