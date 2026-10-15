// Layout guard: no page scrolls sideways on a phone or a desktop, run rows stay inside their list whatever they
// hold, and the approval sheet is styled. Behaviour suites miss lost or conflicting CSS; this one doesn't.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const browser = await chromium.launch();
let failed = 0;
async function check(name, fn) { try { await fn(); console.log('PASS', name) } catch (e) { failed++; console.log('FAIL', name, e.message) } }

const PIX = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"><rect width="900" height="600" fill="#357"/></svg>');
const now = new Date().toISOString();
const LONG = 'a-very-long-unbroken-file-name-that-would-push-the-row-wider-than-any-phone-'.repeat(3);
const runs = [
  { id: 'r_img', type: 'image', title: 'portrait of an old fisherman wearing a bright red baseball cap in the rain', status: 'completed', updatedAt: now, createdAt: now,
    card: { kind: 'image', icon: 'image', title: 'portrait of an old fisherman wearing a bright red baseball cap in the rain', summary: '704 × 1024 image, edited with Quality', badge: { label: 'Done', tone: 'good' }, preview: { type: 'image', src: PIX, count: 1 }, action: { label: 'Open' }, approval: null } },
  { id: 'r_txt', type: 'chat', title: LONG, status: 'completed', updatedAt: now, createdAt: now,
    card: { kind: 'chat', icon: 'compose', title: LONG, summary: LONG, badge: { label: 'Done', tone: 'good' }, preview: { type: 'text', text: LONG }, action: { label: 'Open' }, approval: null } },
  { id: 'r_diff', type: 'engineering', title: 'Fix the login bug', status: 'awaiting_approval', progress: 40, updatedAt: now, createdAt: now,
    card: { kind: 'engineering', icon: 'build', title: 'Fix the login bug', summary: 'Two files change', badge: { label: 'Ready to review', tone: 'accent' }, preview: { type: 'diff', files: [{ path: LONG, added: 3, removed: 1 }] }, action: { label: 'Review' }, approval: null } }
].map(r => ({ progress: 100, summary: r.card.summary, output: null, events: [{ status: r.status, at: now, detail: '' }], pinned: false, projectId: null, ...r }));

const SIZES = [['phone', { width: 390, height: 844 }, true], ['desktop', { width: 1440, height: 900 }, false]];
async function open(size) {
  const [, viewport, isMobile] = size;
  const context = await browser.newContext({ viewport, isMobile, hasTouch: isMobile });
  await context.addInitScript(() => { localStorage.setItem('localai.firstRun.done', '1'); localStorage.setItem('localai.devTools', '1'); });
  const page = await context.newPage();
  await page.route(u => u.pathname === '/api/runs', r => r.fulfill({ json: { items: runs, summary: {} } }));
  await page.goto(base + '/#home', { waitUntil: 'networkidle' });
  return { page, context };
}
const overflow = page => page.evaluate(() => { const d = document.documentElement; return d.scrollWidth - d.clientWidth; });

for (const size of SIZES) {
  await check(`${size[0]}: no page scrolls sideways`, async () => {
    const { page, context } = await open(size);
    const ids = await page.evaluate(() => window.LocalAIViews.VIEWS.map(v => v.id));
    const wide = [];
    for (const id of ids) {
      await page.evaluate(h => { location.hash = h }, '#' + id);
      await page.waitForTimeout(250);
      const by = await overflow(page);
      if (by > 1) wide.push(`${id} (+${by}px)`);
    }
    assert.deepEqual(wide, []);
    await context.close();
  });

  await check(`${size[0]}: run rows stay inside the run list`, async () => {
    const { page, context } = await open(size);
    await page.evaluate(() => { location.hash = '#work' });
    await page.waitForSelector('#runList .run-card');
    const out = await page.evaluate(() => [...document.querySelectorAll('#runList .run-card')].map(c => {
      const list = c.closest('.run-list').getBoundingClientRect(), r = c.getBoundingClientRect();
      return r.right - list.right;
    }).filter(d => d > 1));
    assert.deepEqual(out, [], 'rows wider than their list');
    const img = await page.$eval('#runList .run-card__preview--image img', i => i.getBoundingClientRect().width);
    assert.ok(img <= 96, `image preview is a thumbnail (got ${img}px)`);
    const btn = await page.$eval('#runList .run-card__action', b => b.getBoundingClientRect().width);
    assert.ok(btn < 200, `Open is a button, not a bar (got ${btn}px)`);
    await context.close();
  });

  await check(`${size[0]}: the approval sheet is styled`, async () => {
    const { page, context } = await open(size);
    await page.evaluate(() => { window.LocalAIUI.ask({ title: 'Run this?', effect: 'It changes things.', confirmLabel: 'Run' }); });
    const s = await page.waitForSelector('dialog.ask-sheet[open]');
    const box = await s.evaluate(d => { const r = d.getBoundingClientRect(), cs = getComputedStyle(d); return { w: r.width, radius: parseFloat(cs.borderTopLeftRadius), pad: parseFloat(getComputedStyle(d.querySelector('.ask-sheet__form')).paddingTop) }; });
    assert.ok(box.w <= Math.min(460, size[1].width) + 1, `sheet width ${box.w}`);
    assert.ok(box.radius > 0, 'sheet has rounded corners');
    assert.ok(box.pad >= 16, 'form is padded');
    await context.close();
  });
}

await browser.close();
if (failed) { console.log(`${failed} layout check(s) failed`); process.exit(1) }
