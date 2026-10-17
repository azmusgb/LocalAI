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

await check('no script errors', async () => assert.deepEqual(errors, []));
await browser.close();
if (failures.length) { console.error('\nLibrary failures:\n' + failures.map(x => ' - ' + x).join('\n')); process.exit(1); }
console.log('\nAll Library checks passed.');
