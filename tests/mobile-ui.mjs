import { chromium } from 'playwright';
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
const views = await page.evaluate(() => window.LocalAIViews.VIEWS.map(v => v.id));

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
  await page.evaluate(() => window.showView('integrations'));
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
  for (const view of ['home', 'library', 'issues', 'inbox', 'projects']) {
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

await check('shell: the icon sprite takes no space above the app', async () => {
  assert.equal(await shell.evaluate(() => Math.round(document.querySelector('.app').getBoundingClientRect().top + window.scrollY)), 0);
});

await check('shell: the inbox bell names its count', async () => {
  await shell.evaluate(() => window.dispatchEvent(new CustomEvent('localai:inbox-count', { detail: { unread: 3, pending: 1 } })));
  assert.match(await shell.locator('#uxInboxBtn').getAttribute('aria-label'), /3 unread, 1 approval/);
  assert.equal(await shell.locator('#uxInboxCount').innerText(), '4');
  assert.match(await shell.locator('#uxInboxBtn').getAttribute('aria-label'), /^Inbox, 4 waiting/);
  await shell.evaluate(() => window.dispatchEvent(new CustomEvent('localai:inbox-count', { detail: { unread: 0, pending: 0 } })));
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

await check('shell: many page tabs scroll on a 320px phone and the active one is in view', async () => {
  await shell.setViewportSize({ width: 320, height: 640 });
  await shell.evaluate(() => window.showView('powershell'));
  await shell.waitForTimeout(200);
  const r = await shell.evaluate(() => {
    const strip = document.querySelector('#uxPageStrip'), s = strip.getBoundingClientRect(), a = strip.querySelector('[aria-current="page"]').getBoundingClientRect();
    return { scrolls: strip.scrollWidth > strip.clientWidth, inView: a.left >= s.left - 1 && a.right <= s.right + 1, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, wraps: s.height > 45 };
  });
  assert.ok(r.scrolls, 'Build has more tabs than fit, so the strip scrolls');
  assert.ok(r.inView, 'the active tab is scrolled into view');
  assert.ok(!r.wraps, 'tabs stay on one line');
  assert.ok(r.sw <= r.cw + 1, `page scrolls sideways: ${r.sw} > ${r.cw}`);
  await shell.setViewportSize({ width: 390, height: 844 });
});

await check('shell: with Developer tools off the tab bar has four equal items', async () => {
  await shell.evaluate(() => window.showView('status'));
  await shell.locator('.dev-tools-pref input').uncheck();
  const widths = await shell.evaluate(() => [...document.querySelectorAll('#uxMobileNav [data-domain]')].map(b => b.getBoundingClientRect().width).filter(w => w > 0));
  assert.equal(widths.length, 4);
  assert.ok(Math.max(...widths) - Math.min(...widths) < 1, `unequal widths ${widths}`);
  await shell.locator('.dev-tools-pref input').check();
  assert.equal(await shell.evaluate(() => [...document.querySelectorAll('#uxMobileNav [data-domain]')].filter(b => b.getBoundingClientRect().width > 0).length), 5);
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

await check('shell: Health puts Check again in the header in place of Search', async () => {
  await shell.evaluate(() => window.showView('status'));
  await shell.waitForTimeout(150);
  const action = shell.locator('#uxHeaderAction');
  await action.waitFor({ state: 'visible' });
  assert.equal(await action.getAttribute('aria-label'), 'Check again');
  assert.equal(await shell.locator('#uxCommandBtn').isVisible(), false, 'Search gives its place to the page action');
  assert.equal(await shell.locator('#statusRetryBtn').isVisible(), false, 'no second Check again on the page');
  const checked = shell.waitForRequest(r => r.url().includes('/api/status'));
  await action.click();
  await checked;
  await shell.evaluate(() => window.showView('models'));
  await shell.waitForTimeout(150);
  assert.equal(await shell.locator('#uxCommandBtn').isVisible(), true, 'Search is back on pages without an action');
});
await shell.close();

await check('no script errors on phone', async () => {
  assert.deepEqual(pageErrors, []);
});

await browser.close();
if (failures.length) {
  console.error('\nPhone failures:\n' + failures.map(x => ' - ' + x).join('\n'));
  process.exit(1);
}
console.log('\nAll phone checks passed.');
