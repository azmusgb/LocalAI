import { chromium, devices } from 'playwright';
import assert from 'node:assert/strict';

const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const browser = await chromium.launch({ headless: true });
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    console.log('PASS', name);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.error('FAIL', name, error.message);
  }
}

// A small Android phone: the narrowest common width.
const page = await browser.newPage({ serviceWorkers: 'block', viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#uxMobileNav');
await page.waitForFunction(() => typeof window.showView === 'function' && window.LocalAIViews);
// printLab sends the browser to Pi Hub's /lab (step 6, PR 6.4; print-lab-ui checks that): it is no page of Local AI's.
const views = await page.evaluate(() => window.LocalAIViews.VIEWS.map(v => v.id).filter(id => id !== 'printLab'));

await check('no page scrolls sideways and no form field makes iOS zoom', async () => {
  const problems = [];
  for (const view of views) {
    await page.evaluate(v => window.showView(v), view);
    await page.waitForTimeout(150);
    const r = await page.evaluate(() => {
      const sec = document.querySelector('.view.active');
      const visible = e => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(e).display !== 'none'; };
      const zoom = [...sec.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=hidden]),select,textarea')]
        .filter(visible).filter(e => parseFloat(getComputedStyle(e).fontSize) < 16).map(e => e.id || e.name || e.tagName);
      return { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, zoom };
    });
    if (r.sw > r.cw + 1) problems.push(`${view}: scrollWidth ${r.sw} > ${r.cw}`);
    if (r.zoom.length) problems.push(`${view}: form text under 16px (${r.zoom.join(', ')})`);
  }
  assert.deepEqual(problems, []);
});

await check('the top bar stays at the top while scrolling', async () => {
  await page.evaluate(() => window.showView('status'));
  await page.waitForTimeout(300);
  await page.evaluate(() => window.scrollTo(0, 1200));
  await page.waitForTimeout(150);
  const top = await page.evaluate(() => Math.round(document.querySelector('#uxContextBar').getBoundingClientRect().top));
  assert.equal(top, 0, 'top bar should stick (body must not be its own scroll container)');
  assert.equal(await page.locator('.app > aside').isVisible(), false, 'the empty sidebar strip is hidden on phones');
});

await check('chat composer and Send sit above the tab bar', async () => {
  await page.evaluate(() => window.showView('ask'));
  await page.waitForTimeout(200);
  const r = await page.evaluate(() => ({
    send: document.querySelector('#sendBtn').getBoundingClientRect().bottom,
    nav: document.querySelector('#uxMobileNav').getBoundingClientRect().top,
  }));
  assert.ok(r.send <= r.nav, `Send bottom ${r.send} is under the tab bar at ${r.nav}`);
});

await check('the run view\'s chat reply box and Send sit inside the screen (the tab bar is covered by the run view)', async () => {
  const run = { id: 'run-mobile-1', type: 'chat', status: 'completed', progress: 100, threadId: 't-' + 'b2'.repeat(16), title: 'Hello', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), input: { prompt: 'Hello' }, output: { text: 'Hi there' }, card: { kind: 'chat', title: 'Hello', summary: 'Hi there', badge: { label: 'Done', tone: 'good' }, action: { label: 'Open' }, approval: null } };
  await page.route(u => u.pathname === '/api/runs', r => { const q = new URL(r.request().url()).searchParams; r.fulfill({ contentType: 'application/json', body: JSON.stringify(q.get('id') ? { item: run } : { items: [run], summary: {} }) }); });
  await page.evaluate(() => window.LocalAIRuns.show('run-mobile-1'));
  await page.locator('#runReplySend').waitFor({ timeout: 6000 });
  const r = await page.evaluate(() => ({ send: document.querySelector('#runReplySend').getBoundingClientRect().bottom, reply: document.querySelector('#runReply').getBoundingClientRect().bottom, h: innerHeight }));
  assert.ok(r.send <= r.h && r.reply <= r.h, `reply box (${r.reply}) / Send (${r.send}) must be inside the ${r.h}px screen`);
  await page.unroute(u => u.pathname === '/api/runs');
  await page.evaluate(() => window.history.back());
});

await check('chips, filters and tabs are at least 44px tall', async () => {
  const short = [];
  for (const view of ['home', 'library', 'signals', 'inbox', 'projects']) {
    await page.evaluate(v => { window.showView(v); window.scrollTo(0, 0); }, view);
    await page.waitForTimeout(150);
    short.push(...await page.evaluate(() => [...document.querySelectorAll('.view.active :is(.mode,.filter,.ux-tab)')]
      // 43.5: subpixel layout can report a 44px min-height as 43.99.
      .filter(e => e.getBoundingClientRect().height > 0 && e.getBoundingClientRect().height < 43.5)
      .map(e => `${e.textContent.trim()} ${Math.round(e.getBoundingClientRect().height)}px`)));
  }
  assert.deepEqual(short, []);
});

await check('home shows the brand and a greeting in the top bar, not a section name', async () => {
  await page.evaluate(() => window.showView('home'));
  await page.waitForTimeout(150);
  assert.match((await page.locator('.ux-context-left').innerText()).replace(/\s+/g, ' ').trim(), /^Good (morning|afternoon|evening) Local AI$/);
  assert.equal(await page.locator('#uxContextMenu').isVisible(), false, 'no section menu on Home');
  const search = await page.locator('#uxCommandBtn').boundingBox();
  assert.ok(search.x > 360 / 2, `Search sits at the right with the bell, not beside the brand (x=${search.x})`);
});

await check('long lists show the first items and a Show more button', async () => {
  // Opening Audit log fetches the real list; let that render first so it can't replace the test items.
  const loaded = page.waitForResponse(r => r.url().includes('/api/activity'));
  await page.evaluate(() => window.showView('activity'));
  await loaded;
  await page.waitForTimeout(100);
  await page.evaluate(() => {
    const list = document.getElementById('activityList');
    list.innerHTML = Array.from({ length: 30 }, (_, i) => `<div class="activity-item">Event ${i + 1}</div>`).join('');
  });
  await page.waitForTimeout(100);
  const more = page.locator('#activityList > .mobile-more');
  await more.waitFor({ state: 'visible' });
  assert.equal(await more.innerText(), 'Show 15 more');
  assert.equal(await page.locator('#activityList > .activity-item:visible').count(), 15);
  await more.click();
  assert.equal(await page.locator('#activityList > .activity-item:visible').count(), 30);
  assert.equal(await page.locator('#activityList > .mobile-more').count(), 0);
  // A re-render keeps the list expanded.
  await page.evaluate(() => { document.getElementById('activityList').innerHTML = Array.from({ length: 30 }, (_, i) => `<div class="activity-item">Event ${i}</div>`).join(''); });
  await page.waitForTimeout(100);
  assert.equal(await page.locator('#activityList > .activity-item:visible').count(), 30);
});

// Phone shell (redesign task 2), on a 390×844 phone.
const shell = await browser.newPage({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
shell.on('pageerror', e => pageErrors.push(e.message));
await shell.addInitScript(() => { try { localStorage.setItem('localai.devTools', '1'); } catch {} });
await shell.goto(base, { waitUntil: 'domcontentloaded' });
await shell.waitForSelector('#uxMobileNav');
await shell.waitForFunction(() => typeof window.showView === 'function' && window.LocalAIShell);

await check('shell: one compact header, underline tabs, flush tab bar with icons, no repeated page title', async () => {
  const problems = [];
  for (const view of views) {
    await shell.evaluate(v => { window.showView(v); window.scrollTo(0, 0); }, view);
    await shell.waitForTimeout(120);
    const r = await shell.evaluate(() => {
      const box = s => document.querySelector(s)?.getBoundingClientRect();
      const strip = document.querySelector('#uxPageStrip');
      const stripShown = strip && !strip.hidden && strip.getBoundingClientRect().height > 0;
      const nav = document.querySelector('#uxMobileNav');
      const items = [...nav.querySelectorAll('[data-domain]')].filter(b => b.getBoundingClientRect().width > 0);
      const title = document.querySelector('.view.active .topbar h1');
      return {
        header: box('#uxContextBar').height,
        strip: stripShown ? strip.getBoundingClientRect().height : 0,
        pill: stripShown ? [...strip.querySelectorAll('button')].some(b => { const c = getComputedStyle(b).backgroundColor; return c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent'; }) : false,
        navBottom: nav.getBoundingClientRect().bottom, vh: window.innerHeight,
        icons: items.filter(b => b.querySelector('svg use')).length, items: items.length,
        // Shown on screen, not just present: the h1 stays for screen readers inside a 1px clipped (visually hidden) box.
        title: !!(title && title.getBoundingClientRect().height > 0 && !(() => { for (let e = title; e && !e.classList.contains('view'); e = e.parentElement) { const r = e.getBoundingClientRect(); if (r.width <= 1 || r.height <= 1) return true; } return false; })())
      };
    });
    if (r.header > 56) problems.push(`${view}: header ${Math.round(r.header)}px`);
    if (r.strip > 44.5) problems.push(`${view}: page tabs ${Math.round(r.strip)}px`);
    if (r.pill) problems.push(`${view}: page tab has a pill background`);
    if (Math.abs(r.navBottom - r.vh) > 1) problems.push(`${view}: tab bar ends at ${r.navBottom}, viewport ${r.vh}`);
    if (r.items !== 5 || r.icons !== 5) problems.push(`${view}: tab bar ${r.items} items, ${r.icons} with icons`);
    if (r.title) problems.push(`${view}: page heading still visible`);
  }
  assert.deepEqual(problems, []);
});

await check('shell: the icon sprite takes no space above the app; only the "← Pi Hub" bar is above it', async () => {
  const r = await shell.evaluate(() => ({ app: Math.round(document.querySelector('.app').getBoundingClientRect().top + window.scrollY), bar: Math.round(document.querySelector('nav.ui-backbar').getBoundingClientRect().bottom + window.scrollY), barTop: Math.round(document.querySelector('nav.ui-backbar').getBoundingClientRect().top + window.scrollY) }));
  assert.equal(r.barTop, 0);
  assert.equal(r.app, r.bar);
});

// The bell's number is Needs you's (home.js sends it from any page; navigation update, 2 Nov).
await check('shell: the bell names what needs you', async () => {
  await shell.evaluate(() => window.dispatchEvent(new CustomEvent('localai:needs-count', { detail: { n: 4 } })));
  assert.equal(await shell.locator('#uxInboxBtn').getAttribute('aria-label'), 'Needs you, 4 waiting');
  assert.equal(await shell.locator('#uxInboxCount').innerText(), '4');
  await shell.evaluate(() => window.dispatchEvent(new CustomEvent('localai:needs-count', { detail: { n: 0 } })));
  assert.equal(await shell.locator('#uxInboxBtn').isVisible(), true, 'the bell stays on phones at zero');
  assert.equal(await shell.locator('#uxInboxCount').isVisible(), false, 'no badge at zero');
});

await check('shell: a page action shows in the header only on its page', async () => {
  let clicked = 0;
  await shell.exposeFunction('__shellActionClicked', () => { clicked++; });
  await shell.evaluate(() => window.LocalAIShell.setAction('activity', { icon: 'refresh', label: 'Reload', onClick: () => window.__shellActionClicked() }));
  await shell.evaluate(() => window.showView('activity'));
  await shell.locator('#uxHeaderAction').click();
  assert.equal(await shell.locator('#uxHeaderAction').getAttribute('aria-label'), 'Reload');
  assert.equal(clicked, 1);
  await shell.evaluate(() => window.showView('models'));
  assert.equal(await shell.locator('#uxHeaderAction').isVisible(), false);
  await shell.evaluate(() => window.LocalAIShell.clearAction('activity'));
});

await check('shell: the page tabs stay on one line on a 320px phone and the active one is in view', async () => {
  await shell.setViewportSize({ width: 320, height: 640 });
  await shell.evaluate(() => window.showView('powershell'));
  await shell.waitForTimeout(200);
  const r = await shell.evaluate(() => {
    const strip = document.querySelector('#uxPageStrip'), s = strip.getBoundingClientRect(), a = strip.querySelector('[aria-current="page"]').getBoundingClientRect();
    return { scrolls: strip.scrollWidth > strip.clientWidth, inView: a.left >= s.left - 1 && a.right <= s.right + 1, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, wraps: s.height > 45 };
  });
  // System's five tabs may fit at 320 px now; if they do not, the strip scrolls rather than wraps (checked below).
  assert.ok(r.inView, 'the active tab is scrolled into view');
  assert.ok(!r.wraps, 'tabs stay on one line');
  assert.ok(r.sw <= r.cw + 1, `page scrolls sideways: ${r.sw} > ${r.cw}`);
  await shell.setViewportSize({ width: 390, height: 844 });
});

await check('shell: the tab bar has five equal items', async () => {
  const widths = await shell.evaluate(() => [...document.querySelectorAll('#uxMobileNav [data-domain]')].map(b => b.getBoundingClientRect().width).filter(w => w > 0));
  assert.equal(widths.length, 5);
  assert.ok(Math.max(...widths) - Math.min(...widths) < 1, `unequal widths ${widths}`);
});
await check('shell: tab-bar icons come from the registry', async () => {
  const items = await shell.evaluate(() => {
    const icons = Object.fromEntries(window.LocalAIViews.DOMAINS.map(d => [d.id, d.icon]));
    return [...document.querySelectorAll('#uxMobileNav [data-domain]')].map(b => ({ want: icons[b.dataset.domain], got: b.querySelector('svg use')?.getAttribute('href') }));
  });
  assert.equal(items.length, 5);
  for (const i of items) {
    assert.ok(i.want, 'every domain names its icon');
    assert.equal(i.got, '#i-' + i.want);
  }
});

await check('shell: Search and the bell keep their places on every page; Health keeps Check again in the page', async () => {
  const slots = () => shell.evaluate(() => ['#uxCommandBtn', '#uxInboxBtn'].map(s => { const e = document.querySelector(s), r = e?.getBoundingClientRect(); return e && r.width > 0 ? `${s}@${Math.round(r.left)}` : `${s} hidden`; }).join(' '));
  const seen = new Set();
  for (const v of ['home', 'work', 'projects', 'backlog', 'signals', 'status', 'models', 'spreadsheets']) {
    await shell.evaluate(id => window.showView(id), v);
    await shell.waitForTimeout(150);
    assert.equal(await shell.locator('#uxCommandBtn').isVisible(), true, `Search on ${v}`);
    seen.add(await slots());
  }
  assert.equal(seen.size, 1, `header slots move between pages: ${[...seen].join(' | ')}`);
  await shell.evaluate(() => window.showView('status'));
  await shell.locator('#statusRetryBtn').waitFor({ state: 'visible' });
  const checked = shell.waitForRequest(r => r.url().includes('/api/status'));
  await shell.locator('#statusRetryBtn').click();
  await checked;
});
await shell.close();

// ---- Phone polish (critique §3.7): pull to refresh, the mode sheet, ⌘K as a bottom sheet ----
async function phone(device, { dev = false } = {}) {
  const context = await browser.newContext({ ...devices[device], serviceWorkers: 'block' });
  const p = await context.newPage();
  p.on('pageerror', e => pageErrors.push(`${device}: ${e.message}`));
  if (dev) await p.addInitScript(() => { try { localStorage.setItem('localai.devTools', '1'); } catch {} });
  await p.goto(base, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('#uxMobileNav');
  await p.waitForFunction(() => typeof window.showView === 'function' && window.LocalAIShell && window.LocalAICommand);
  return { p, context };
}
// A finger pulls down from y=200 by `dy` px (touchstart, a few touchmoves, touchend) on the open page (not a text field).
const pull = (p, dy) => p.evaluate(async dy => {
  const x = 180, y0 = 200, target = document.querySelector('.view.active') || document.body;
  const touch = y => new Touch({ identifier: 7, target, clientX: x, clientY: y, pageX: x, pageY: y + scrollY });
  const fire = (type, y) => { const t = touch(y); target.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, composed: true, touches: type === 'touchend' ? [] : [t], targetTouches: type === 'touchend' ? [] : [t], changedTouches: [t] })); };
  fire('touchstart', y0);
  for (let i = 1; i <= 5; i++) { fire('touchmove', y0 + dy * i / 5); await new Promise(r => setTimeout(r, 16)); }
  fire('touchend', y0 + dy);
}, dy);

await check('pull to refresh: Work, Inbox, Library and Backlog refresh once on a pull past 64px, and say so', async () => {
  const { p, context } = await phone('iPhone 14', { dev: true });
  try {
    assert.equal(await p.evaluate(() => getComputedStyle(document.documentElement).overscrollBehaviorY), 'contain', 'iOS should not rubber-band the shell');
    for (const [view, api] of [['work', '/api/runs'], ['inbox', '/api/notifications'], ['library', '/api/library'], ['backlog', '/api/improve/items']]) {
      await p.evaluate(v => { window.LocalAIRouter.open(v); }, view);
      await p.waitForFunction(v => document.getElementById(v)?.classList.contains('active'), view);
      await p.waitForTimeout(700); // the page's own first load settles
      await p.evaluate(() => window.scrollTo(0, 0));
      let hits = 0;
      const count = r => { if (new URL(r.url()).pathname === api) hits++; };
      p.on('request', count);
      await pull(p, 30);
      await p.waitForTimeout(400);
      assert.equal(hits, 0, `${view}: a 30px pull is not a refresh`);
      await pull(p, 110);
      await p.waitForFunction(() => /Updating|Updated just now/.test(document.getElementById('pullRefresh')?.textContent || ''), null, { timeout: 2000 });
      await p.waitForFunction(() => /Updated just now/.test(document.getElementById('pullRefresh')?.textContent || ''), null, { timeout: 4000 });
      await p.waitForTimeout(300);
      p.off('request', count);
      assert.equal(hits, 1, `${view}: one pull asks ${api} once (saw ${hits})`);
      assert.equal(await p.locator('#pullRefresh').getAttribute('role'), 'status');
    }
    // Health has its own Check again: a pull there is just a scroll.
    await p.evaluate(() => { window.LocalAIRouter.open('status'); });
    await p.waitForTimeout(600);
    let health = 0;
    const onReq = r => { if (new URL(r.url()).pathname === '/api/status') health++; };
    p.on('request', onReq);
    await pull(p, 110);
    await p.waitForTimeout(500);
    p.off('request', onReq);
    assert.equal(health, 0, 'Health has no pull to refresh');
  } finally { await context.close(); }
});

await check('Home mode sheet: one bottom-anchored column of 56px rows, the current mode nearest the thumb; Back closes it', async () => {
  for (const device of ['iPhone SE', 'iPhone 14']) {
    const { p, context } = await phone(device);
    try {
      await p.evaluate(() => window.LocalAIHome.setMode('auto'));
      await p.click('#homeModeChip');
      await p.waitForSelector('#homeModeSheet[open]');
      await p.waitForTimeout(250);
      const r = await p.evaluate(() => {
        const rows = [...document.querySelectorAll('#homeModeSheet [role="radio"]')].map(b => { const x = b.getBoundingClientRect(); return { id: b.dataset.homeMode, checked: b.getAttribute('aria-checked') === 'true', left: Math.round(x.left), width: Math.round(x.width), h: x.height }; });
        return { rows, sheet: document.getElementById('homeModeSheet').getBoundingClientRect().bottom, vh: innerHeight };
      });
      assert.ok(r.rows.length >= 6, `${device}: ${r.rows.length} modes`);
      assert.equal(new Set(r.rows.map(x => x.left)).size, 1, `${device}: one column (lefts ${r.rows.map(x => x.left)})`);
      assert.equal(new Set(r.rows.map(x => x.width)).size, 1, `${device}: rows share one width`);
      assert.ok(r.rows.every(x => x.h >= 56), `${device}: rows at least 56px (${r.rows.map(x => Math.round(x.h))})`);
      assert.ok(Math.abs(r.sheet - r.vh) <= 1, `${device}: the sheet sits on the bottom edge (${r.sheet} vs ${r.vh})`);
      const last = r.rows[r.rows.length - 1];
      assert.equal(last.id, 'auto', `${device}: the current mode is the lowest row`);
      assert.ok(last.checked);
      assert.deepEqual(r.rows.slice(-2).map(x => x.id), ['ask', 'auto'], `${device}: Chat sits just above the current mode`);
      // Choosing a mode that has options keeps the sheet open and the rows where they are (a thumb, or arrow keys, don't chase them).
      const before = r.rows.map(x => x.id);
      const pick = await p.evaluate(() => ['ask', 'create', 'mission', 'research'].find(m => !document.querySelector(`#homeModeSheet [data-home-mode="${m}"]`)?.disabled));
      if (pick) {
        await p.click(`#homeModeSheet [data-home-mode="${pick}"]`);
        await p.waitForTimeout(150);
        assert.deepEqual(await p.evaluate(() => [...document.querySelectorAll('#homeModeSheet [role="radio"]')].map(b => b.dataset.homeMode)), before);
      }
      await p.goBack();
      await p.waitForFunction(() => !document.getElementById('homeModeSheet').open, null, { timeout: 2000 });
      assert.equal(await p.evaluate(() => window.LocalAIHome.mode()), pick || 'auto');
      // Opened again, the rows start from the new current mode.
      await p.click('#homeModeChip');
      await p.waitForSelector('#homeModeSheet[open]');
      assert.equal(await p.evaluate(() => [...document.querySelectorAll('#homeModeSheet [role="radio"]')].pop().dataset.homeMode), pick || 'auto');
    } finally { await context.close(); }
  }
});

await check('⌘K on a phone: a bottom sheet with the search at its top and the 8 likeliest pages, grouped; typing finds the rest', async () => {
  const { p, context } = await phone('iPhone 14');
  try {
    for (const v of ['inbox', 'models', 'library']) { await p.evaluate(v => window.LocalAIRouter.open(v), v); await p.waitForTimeout(200); }
    await p.evaluate(() => window.LocalAIRouter.open('status'));
    await p.waitForTimeout(200);
    await p.evaluate(() => window.LocalAICommand.open());
    await p.waitForSelector('#cmdk[open]');
    await p.waitForTimeout(250);
    const r = await p.evaluate(() => {
      const card = document.querySelector('.cmdk-card').getBoundingClientRect(), input = document.getElementById('cmdkInput').getBoundingClientRect();
      const opts = [...document.querySelectorAll('#cmdkList [role="option"]')];
      const groups = [...document.querySelectorAll('#cmdkList [role="group"]')].map(g => ({ label: document.getElementById(g.getAttribute('aria-labelledby'))?.textContent || g.getAttribute('aria-label'), items: [...g.querySelectorAll('[role="option"]')].map(o => o.dataset.cmdView) }));
      return { cardBottom: card.bottom, cardLeft: card.left, cardWidth: card.width, inputTop: input.top - card.top, vh: innerHeight, vw: innerWidth, ids: opts.map(o => o.dataset.cmdView), groups, focus: document.activeElement?.id };
    });
    assert.ok(Math.abs(r.cardBottom - r.vh) <= 1, `sheet bottom ${r.cardBottom} vs ${r.vh}`);
    assert.ok(r.cardLeft <= 1 && r.cardWidth >= r.vw - 2, 'full width');
    assert.ok(r.inputTop < 40, `the search is at the top of the sheet (${r.inputTop}px down)`);
    assert.equal(r.focus, 'cmdkInput');
    assert.equal(r.ids.length, 8, `8 pages (${r.ids})`);
    assert.equal(new Set(r.ids).size, 8, 'no page twice');
    assert.ok(!r.ids.includes('status'), 'not the page you are on');
    assert.equal(r.groups[0].label, 'Recent');
    assert.deepEqual(r.groups[0].items.slice(0, 3), ['library', 'models', 'inbox'], 'most recent first');
    assert.ok(r.groups.length >= 2 && r.groups.every(g => g.label && g.items.length), JSON.stringify(r.groups));
    assert.ok(r.groups.some(g => g.label === 'System' && g.items.length === 4), 'then the pages of the section you are in: ' + JSON.stringify(r.groups));
    await p.fill('#cmdkInput', 'audit');
    await p.waitForTimeout(100);
    assert.deepEqual(await p.evaluate(() => [...document.querySelectorAll('#cmdkList [role="option"]')].map(o => o.dataset.cmdView)), ['activity'], 'typing reaches every page');
    await p.fill('#cmdkInput', '');
    await p.keyboard.press('ArrowDown');
    await p.keyboard.press('Enter');
    await p.waitForFunction(() => !document.getElementById('cmdk').open);
    await p.waitForFunction(() => document.querySelector('.view.active')?.id !== 'status', null, { timeout: 2000 }).catch(() => {});
    assert.equal(await p.evaluate(() => document.querySelector('.view.active').id), 'models', 'arrows walk the suggestions in order');
  } finally { await context.close(); }
  // Desktop keeps the full list, ungrouped, in the centred palette.
  const desk = await browser.newPage({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
  try {
    await desk.goto(base, { waitUntil: 'domcontentloaded' });
    await desk.waitForFunction(() => window.LocalAICommand);
    await desk.evaluate(() => window.LocalAICommand.open());
    await desk.waitForSelector('#cmdk[open]');
    const d = await desk.evaluate(() => ({ n: document.querySelectorAll('#cmdkList [role="option"]').length, groups: document.querySelectorAll('#cmdkList [role="group"]').length, top: document.querySelector('.cmdk-card').getBoundingClientRect().top }));
    assert.ok(d.n > 8, `desktop lists every page (${d.n})`);
    assert.equal(d.groups, 0);
    assert.ok(d.top < 200, 'desktop palette sits near the top');
  } finally { await desk.close(); }
});

await check('no script errors on phone', async () => {
  assert.deepEqual(pageErrors, []);
});

await browser.close();
if (failures.length) {
  console.error('\nPhone failures:\n' + failures.map(x => ' - ' + x).join('\n'));
  process.exit(1);
}
console.log('\nAll phone checks passed.');
