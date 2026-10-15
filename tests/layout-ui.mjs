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
  const context = await browser.newContext({ serviceWorkers: 'block', viewport, isMobile, hasTouch: isMobile });
  await context.addInitScript(() => { localStorage.setItem('localai.firstRun.done', '1'); localStorage.setItem('localai.devTools', '1'); });
  const page = await context.newPage({ serviceWorkers: 'block' });
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
      // The page clips sideways overflow, so also look for anything drawn past the edge that isn't in a scroller.
      const past = await page.evaluate(() => {
        const W = document.documentElement.clientWidth, out = [];
        for (const el of document.querySelectorAll('.view.active *')) {
          const r = el.getBoundingClientRect(); if (!r.width || r.right <= W + 1) continue;
          let a = el.parentElement, clipped = false;
          for (; a && a !== document.body; a = a.parentElement) { const o = getComputedStyle(a).overflowX; if (o !== 'visible' && o !== 'clip' && a.getBoundingClientRect().right <= W + 1) { clipped = true; break; } }
          if (!clipped) out.push((el.id ? '#' + el.id : el.className?.baseVal ?? el.className ?? el.tagName).toString().slice(0, 40) + ` (+${Math.round(r.right - W)}px)`);
        }
        return out.slice(0, 3);
      });
      if (past.length) wide.push(`${id}: ${past.join(', ')}`);
    }
    assert.deepEqual(wide, []);
    await context.close();
  });

  await check(`${size[0]}: run rows stay inside the run list`, async () => {
    const { page, context } = await open(size);
    await page.evaluate(() => window.showView('runs')); // the Runs page (reachable by id); #work is the Work timeline
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

  await check(`${size[0]}: Work rows stay inside their list, with a thumbnail and no per-row Open bar`, async () => {
    const { page, context } = await open(size);
    await page.evaluate(() => { location.hash = '#work' });
    await page.waitForSelector('#workList .run-card');
    const out = await page.evaluate(() => [...document.querySelectorAll('#workList .run-card')].map(c => {
      const list = c.closest('.list-group').getBoundingClientRect(), r = c.getBoundingClientRect();
      return r.right - list.right;
    }).filter(d => d > 1));
    assert.deepEqual(out, [], 'rows wider than their list');
    const img = await page.$eval('#workList .run-card__preview--image img', i => i.getBoundingClientRect().width);
    assert.ok(img <= 96, `image preview is a thumbnail (got ${img}px)`);
    assert.equal(await page.locator('#workList .run-card__action').filter({ hasText: /^Open$/ }).count(), 0);
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

await check('desktop: every menu entry draws a sprite icon, not a letter', async () => {
  const { page, context } = await open(SIZES[1]);
  const bad = [];
  for (const d of ['home', 'projects', 'improve', 'system']) {
    await page.click(`.ux-primary-item[data-domain="${d}"]`);
    await page.waitForTimeout(150);
    bad.push(...await page.evaluate(() => [...document.querySelectorAll('.ux-primary-symbol, .ux-secondary-link .ux-link-icon')]
      .filter(e => !e.querySelector('svg use[href^="#i-"]') || e.textContent.trim()).map(e => (e.closest('[data-view],[data-domain]')?.dataset.view || e.closest('[data-domain]')?.dataset.domain) + ':' + e.textContent.trim())));
  }
  assert.deepEqual([...new Set(bad)], []);
  await context.close();
});

await check('every project picker says what it will use, even with no projects yet', async () => {
  const { page, context } = await open(SIZES[0]);
  const blank = [];
  for (const [view, id] of [['knowledge', 'knowledgeProject'], ['memory', 'memoryProject']]) {
    await page.evaluate(h => { location.hash = h }, '#' + view);
    await page.waitForFunction(i => document.getElementById(i)?.options.length > 0, id, { timeout: 5000 }).catch(() => {});
    const label = await page.evaluate(i => { const el = document.getElementById(i); return el?.selectedOptions[0]?.textContent.trim() || ''; }, id);
    if (!label) blank.push(id);
  }
  assert.deepEqual(blank, []);
  await context.close();
});

for (const size of SIZES) await check(`${size[0]}: the Files tree is a compact list: one line per entry, the path only on hover`, async () => {
  const { page, context } = await open(size);
  const tree = [{ type: 'directory', name: 'projects', path: 'projects', children: [
    { type: 'directory', name: 'ImageOCR', path: 'projects/ImageOCR', children: [{ type: 'file', name: 'main.py', path: 'projects/ImageOCR/main.py' }] },
    { type: 'file', name: 'notes.md', path: 'projects/notes.md' },
    { type: 'file', name: 'torch-2.14.0+cu126-cp312-cp312-win_amd64-with-a-very-long-unbroken-name.whl', path: 'projects/torch.whl' }] }];
  await page.route(u => u.pathname === '/api/workbench/tree', r => r.fulfill({ json: { items: tree } }));
  await page.evaluate(() => { location.hash = '#workbench' });
  await page.evaluate(() => window.loadWorkbench?.() ?? document.getElementById('workbenchTreeBtn')?.click());
  await page.waitForSelector('#workbenchTree [data-file-path="projects/notes.md"]');
  const rows = await page.$$eval('#workbenchTree .tree-row', els => els.map(e => { const i = e.querySelector('svg').getBoundingClientRect(), t = e.querySelector('span').getBoundingClientRect(); return { h: e.getBoundingClientRect().height, oneLine: Math.abs((i.top + i.bottom) / 2 - (t.top + t.bottom) / 2) < 4, text: e.textContent.trim(), title: e.getAttribute('title') }; }));
  assert.ok(rows.length >= 3, `rows: ${rows.length}`);
  for (const r of rows) {
    assert.ok(r.h <= 40, `${r.text} is ${r.h}px tall`);
    assert.ok(r.oneLine, `${r.text}: icon and name are on different lines`);
    assert.ok(!r.text.includes('/projects') && !/projects\/.+\//.test(r.text), `path repeated in "${r.text}"`);
    assert.match(r.title || '', /^projects/);
  }
  const edge = await page.evaluate(() => { const W = document.documentElement.clientWidth; return ['#workbenchTree', '#workbench .card'].map(q => Math.round(document.querySelector(q).getBoundingClientRect().right - W)); });
  assert.ok(edge.every(d => d <= 0), `Files runs past the screen edge by ${edge.join('/')}px`);
  await context.close();
});

await check('phone: under each page title, status sits on the left and the page action on the right', async () => {
  const { page, context } = await open(SIZES[0]);
  const wrong = [];
  for (const id of ['issues', 'changes', 'workbench', 'repoTools', 'operations']) {
    await page.evaluate(h => { location.hash = h }, '#' + id);
    await page.waitForTimeout(200);
    const r = await page.evaluate(i => {
      const bar = document.querySelector(`#${i}.active > .topbar`); if (!bar || getComputedStyle(bar).display === 'none') return null;
      const box = bar.getBoundingClientRect(), vis = k => k.getBoundingClientRect().width > 0;
      const pill = [...bar.querySelectorAll('.pill, .statuschip, .badge')].find(vis), btns = [...bar.querySelectorAll('button, .btn')].filter(vis), btn = btns.at(-1);
      return { pillLeft: pill ? pill.getBoundingClientRect().left - box.left : null, btnRight: btn ? box.right - btn.getBoundingClientRect().right : null };
    }, id);
    if (!r) continue;
    if (r.pillLeft !== null && r.pillLeft > 2) wrong.push(`${id}: status ${Math.round(r.pillLeft)}px from the left`);
    if (r.btnRight !== null && r.btnRight > 2) wrong.push(`${id}: action ${Math.round(r.btnRight)}px from the right`);
  }
  assert.deepEqual(wrong, []);
  await context.close();
});

await browser.close();
if (failed) { console.log(`${failed} layout check(s) failed`); process.exit(1) }
