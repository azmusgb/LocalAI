// Layout guard: no page scrolls sideways on a phone or a desktop, run rows stay inside their list whatever they
// hold, and the approval sheet is styled. Behaviour suites miss lost or conflicting CSS; this one doesn't.
import assert from 'node:assert/strict';
import { chromium, devices } from 'playwright';

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
  // Long unbroken check details and browser errors must wrap inside the Signals lists.
  await page.route(u => u.pathname === '/api/quality', r => r.fulfill({ json: { latest: { checks: [{ name: 'service health', result: 'FAIL', detail: LONG }] }, events: [{ message: LONG, source: LONG, createdAt: now }] } }));
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

// Nothing is hover-only: a desktop shows the path on hover; a phone (pointer: coarse) shows the parent folder under the name.
for (const size of SIZES) await check(`${size[0]}: the Files tree is a compact list: the path on hover, or the parent folder under the name on touch`, async () => {
  const { page, context } = await open(size);
  const touch = size[2];
  const tree = [{ type: 'directory', name: 'projects', path: 'projects', children: [
    { type: 'directory', name: 'ImageOCR', path: 'projects/ImageOCR', children: [{ type: 'file', name: 'main.py', path: 'projects/ImageOCR/main.py' }] },
    { type: 'file', name: 'notes.md', path: 'projects/notes.md' },
    { type: 'file', name: 'torch-2.14.0+cu126-cp312-cp312-win_amd64-with-a-very-long-unbroken-name.whl', path: 'projects/torch.whl' }] }];
  await page.route(u => u.pathname === '/api/workbench/tree', r => r.fulfill({ json: { items: tree } }));
  await page.evaluate(() => { location.hash = '#workbench' });
  await page.evaluate(() => window.loadWorkbench?.() ?? document.getElementById('workbenchTreeBtn')?.click());
  await page.waitForSelector('#workbenchTree [data-file-path="projects/notes.md"]');
  const rows = await page.$$eval('#workbenchTree .tree-row', els => els.map(e => { const i = e.querySelector('svg').getBoundingClientRect(), t = e.querySelector('span').getBoundingClientRect(); const p = e.querySelector('.tree-path'); const pb = p && p.getBoundingClientRect(); return { h: e.getBoundingClientRect().height, oneLine: Math.abs((i.top + i.bottom) / 2 - (t.top + t.bottom) / 2) < 4, name: e.querySelector('span').textContent.trim(), text: e.textContent.trim(), title: e.getAttribute('title'), path: pb && pb.height > 0 ? { text: p.textContent.trim(), below: pb.top >= t.bottom - 1, size: parseFloat(getComputedStyle(p).fontSize) } : null }; }));
  assert.ok(rows.length >= 3, `rows: ${rows.length}`);
  for (const r of rows) {
    assert.ok(r.h <= (touch && r.path ? 60 : 40), `${r.text} is ${r.h}px tall`);
    assert.ok(r.oneLine, `${r.text}: icon and name are on different lines`);
    assert.match(r.title || '', /^projects/);
    const parent = r.title.includes('/') ? r.title.slice(0, r.title.lastIndexOf('/')) : '';
    if (!touch) assert.equal(r.path, null, `${r.name}: the path is written out on a desktop ("${r.text}")`);
    else if (!parent) assert.equal(r.path, null, `${r.name}: a top-level entry shows a parent`);
    else { assert.ok(r.path, `${r.name}: no parent folder under the name on touch`); assert.equal(r.path.text, parent); assert.ok(r.path.below, `${r.name}: the folder is not under the name`); assert.ok(r.path.size >= 13, `${r.name}: folder text is ${r.path.size}px`); }
  }
  const edge = await page.evaluate(() => { const W = document.documentElement.clientWidth; return ['#workbenchTree', '#workbench .card'].map(q => Math.round(document.querySelector(q).getBoundingClientRect().right - W)); });
  assert.ok(edge.every(d => d <= 0), `Files runs past the screen edge by ${edge.join('/')}px`);
  await context.close();
});

await check('phone: under each page title, status sits on the left and the page action on the right', async () => {
  const { page, context } = await open(SIZES[0]);
  const wrong = [];
  for (const id of ['signals', 'inProgress', 'workbench', 'repoTools', 'automationStudio']) {
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

await check('phone: the top bar and page tabs are solid, so scrolled content never shows through them', async () => {
  const { page, context } = await open(SIZES[0]);
  await page.evaluate(() => { location.hash = '#claude' });
  await page.waitForTimeout(300);
  const seeThrough = await page.evaluate(() => ['.ux-context-bar', '.ux-page-strip'].map(q => [...document.querySelectorAll(q)])
    .flat().filter(e => e.getBoundingClientRect().height > 0 && ['sticky', 'fixed'].includes(getComputedStyle(e).position))
    .map(e => [e.className, getComputedStyle(e).backgroundColor]).filter(([, bg]) => { const m = bg.match(/rgba?\(([^)]+)\)/); const a = m ? (m[1].split(',')[3] ?? '1') : '0'; return parseFloat(a) < 1; }));
  assert.deepEqual(seeThrough, []);
  await context.close();
});

// Secondary text a phone can read: nothing in a Library card or the Audit log is under 13px, and an audit detail wraps
// to two lines instead of being cut to one.
const smallText = (page, sel) => page.evaluate(s => {
  const out = []; const w = document.createTreeWalker(document.querySelector(s), NodeFilter.SHOW_TEXT); let n;
  while ((n = w.nextNode())) { if (!n.textContent.trim()) continue; const e = n.parentElement, r = e.getBoundingClientRect(); if (!r.width || !r.height) continue; const fs = parseFloat(getComputedStyle(e).fontSize); if (fs < 13) out.push(`${e.className || e.tagName} ${fs}px "${n.textContent.trim().slice(0, 30)}"`); }
  return [...new Set(out)];
}, sel);
await check('phone: Library cards and the Audit log have no text under 13px, and an audit detail wraps to two lines', async () => {
  const { page, context } = await open(SIZES[0]);
  await page.route(u => u.pathname === '/api/library', r => r.fulfill({ json: { items: [{ id: 'l1', kind: 'conversation', title: 'Plan the vegetable garden', summary: 'Raised beds, tomatoes and basil along the south fence.', createdAt: now, pinned: true, meta: {}, data: {} }], counts: {}, total: 1 } }));
  await page.route(u => u.pathname === '/api/activity', r => r.fulfill({ json: { items: [
    { id: 'a1', type: 'run', title: 'Run finished', detail: LONG, at: now, meta: { runId: 'r_txt' } },
    { id: 'a2', type: 'system', title: 'Service restarted', detail: 'Ollama came back after 40 seconds.', at: now, meta: {} }] } }));
  await page.evaluate(() => { location.hash = '#library' });
  await page.waitForSelector('#library .artifact');
  assert.deepEqual(await smallText(page, '#library .library-grid'), []);
  await page.evaluate(() => { location.hash = '#activity' });
  await page.waitForSelector('#activityList .activity-item');
  assert.deepEqual(await smallText(page, '#activityList'), []);
  const d = await page.$eval('#activityList .activity-detail', e => { const cs = getComputedStyle(e); return { ws: cs.whiteSpace, h: e.getBoundingClientRect().height, lh: parseFloat(cs.lineHeight), w: e.getBoundingClientRect().width, sw: e.scrollWidth }; });
  assert.notEqual(d.ws, 'nowrap');
  assert.ok(d.h > d.lh * 1.5 && d.h <= d.lh * 2 + 2, `detail is ${d.h}px for line height ${d.lh}: not two lines`);
  assert.ok(d.sw <= d.w + 1, 'detail runs sideways');
  await context.close();
});

// The narrowest phones: a Work row still leaves 200px for its text.
await check('320px: a Work row keeps at least 200px for its text', async () => {
  const { page, context } = await open(['narrow', { width: 320, height: 640 }, true]);
  await page.evaluate(() => { location.hash = '#work' });
  await page.waitForSelector('#work .run-card .list-row__main');
  const widths = await page.$$eval('#work .run-card .list-row__main', els => els.map(e => Math.round(e.getBoundingClientRect().width)));
  assert.ok(widths.length >= 3 && widths.every(w => w >= 200), `text columns are ${widths.join('/')}px wide`);
  assert.equal(await overflow(page), 0, 'Work scrolls sideways at 320px');
  await context.close();
});

// ---- Phone polish (critique §3.7): the iPad shell, the scrolled header, sheets that hold the page still ----
async function device(name) {
  const context = await browser.newContext({ ...devices[name], serviceWorkers: 'block' });
  await context.addInitScript(() => { localStorage.setItem('localai.firstRun.done', '1'); });
  const page = await context.newPage();
  await page.goto(base + '/#home', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.showView === 'function' && window.LocalAIShell && window.LocalAICommand);
  return { page, context };
}
const go = async (page, id) => { await page.evaluate(v => window.LocalAIRouter.open(v), id); await page.waitForFunction(v => document.getElementById(v)?.classList.contains('active'), id); await page.waitForTimeout(250); };

for (const name of ['iPad Mini', 'iPad Mini landscape']) {
  await check(`${name}: the content starts at the same x on every page, and there is no ⌘K hint on a touch screen`, async () => {
    const { page, context } = await device(name);
    const xs = {};
    for (const id of ['home', 'work', 'inbox', 'library', 'status', 'backlog']) {
      await go(page, id);
      xs[id] = await page.evaluate(() => Math.round(document.querySelector('.view.active').getBoundingClientRect().left));
    }
    assert.equal(new Set(Object.values(xs)).size, 1, `content x per page: ${JSON.stringify(xs)}`);
    const hints = await page.evaluate(() => [...document.querySelectorAll('kbd')].filter(k => k.getBoundingClientRect().width > 0).map(k => k.textContent));
    assert.deepEqual(hints, [], 'no keyboard-shortcut hint where there is no hover');
    await context.close();
  });
}

await check('desktop with a mouse: Work still drops the page list, and the ⌘K hint shows', async () => {
  const { page, context } = await open(SIZES[1]);
  await go(page, 'work');
  assert.ok(await page.evaluate(() => document.body.classList.contains('ux-single-page')));
  assert.ok(await page.evaluate(() => [...document.querySelectorAll('.ux-context-search kbd')].some(k => k.getBoundingClientRect().width > 0)), '⌘K hint visible');
  await context.close();
});

await check('phone: the sticky header gets a hairline once the page scrolls, where no page tabs draw one', async () => {
  const { page, context } = await device('iPhone 14');
  const line = () => page.evaluate(() => getComputedStyle(document.querySelector('.ux-context-bar')).boxShadow);
  await go(page, 'work');
  await page.evaluate(() => { document.getElementById('work').style.minHeight = '3000px'; window.scrollTo(0, 0); });
  await page.waitForTimeout(150);
  assert.equal(await line(), 'none', 'no line at the top');
  await page.evaluate(() => window.scrollTo(0, 300));
  await page.waitForTimeout(150);
  assert.match(await line(), /1px/, 'a 1px line once scrolled');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(150);
  assert.equal(await line(), 'none', 'gone again at the top');
  await go(page, 'status'); // System has page tabs, whose own border is the line
  await page.evaluate(() => { document.getElementById('status').style.minHeight = '3000px'; window.scrollTo(0, 300); });
  await page.waitForTimeout(150);
  assert.equal(await line(), 'none', 'the page tabs already draw the line');
  await context.close();
});

await check('phone: an open sheet holds the page still (iOS scroll lock) and closing it returns to the same place', async () => {
  const { page, context } = await device('iPhone 14');
  await go(page, 'integrations');
  await page.evaluate(() => { document.getElementById('integrations').style.minHeight = '3000px'; window.scrollTo(0, 500); });
  await page.waitForTimeout(150);
  const body = () => page.evaluate(() => ({ pos: getComputedStyle(document.body).position, top: document.body.style.top, y: Math.round(scrollY) }));
  // ⌘K
  await page.evaluate(() => window.LocalAICommand.open());
  await page.waitForSelector('#cmdk[open]');
  await page.waitForTimeout(100);
  let b = await body();
  assert.equal(b.pos, 'fixed'); assert.equal(b.top, '-500px');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  b = await body();
  assert.notEqual(b.pos, 'fixed'); assert.equal(b.y, 500, 'back where you were');
  // The page menu sheet
  await page.click('#uxContextMenu');
  await page.waitForFunction(() => document.body.classList.contains('ux-sheet-open'));
  await page.waitForTimeout(100);
  b = await body();
  assert.equal(b.pos, 'fixed'); assert.equal(b.top, '-500px');
  await page.goBack(); // Back closes the sheet
  await page.waitForFunction(() => !document.body.classList.contains('ux-sheet-open'));
  await page.waitForTimeout(150);
  b = await body();
  assert.notEqual(b.pos, 'fixed'); assert.equal(b.y, 500, 'back where you were after the page menu');
  // Opening another page from a sheet starts that page at its top.
  await page.evaluate(() => window.LocalAICommand.open());
  await page.waitForSelector('#cmdk[open]');
  await page.fill('#cmdkInput', 'models');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#models.active');
  await page.waitForTimeout(200);
  b = await body();
  assert.notEqual(b.pos, 'fixed'); assert.equal(b.y, 0);
  await context.close();
});

await browser.close();
if (failed) { console.log(`${failed} layout check(s) failed`); process.exit(1) }
