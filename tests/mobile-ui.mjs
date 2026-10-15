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
const page = await browser.newPage({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
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
  const top = await page.evaluate(() => Math.round(document.querySelector('#uxHeader').getBoundingClientRect().top));
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

// ---- The phone shell: one header, underline page tabs, a tab bar flush with the bottom (390×844, Developer tools on).
const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
phone.on('pageerror', e => pageErrors.push(e.message));
await phone.addInitScript(() => localStorage.setItem('localai.devTools', '1'));
await phone.goto(base, { waitUntil: 'domcontentloaded' });
await phone.waitForSelector('#uxMobileNav');
await phone.waitForFunction(() => typeof window.showView === 'function' && window.LocalAIViews);
const show = async (p, view) => { await p.evaluate(v => { window.showView(v); window.scrollTo(0, 0); }, view); await p.waitForTimeout(200); await p.evaluate(() => window.scrollTo(0, 0)); };
// Visible means it takes up space and is not clipped to a 1px screen-reader box.
const shellMetrics = () => {
  const box = e => e && e.getBoundingClientRect();
  const shown = e => { if (!e) return false; const b = e.getBoundingClientRect(), cs = getComputedStyle(e); return b.width > 2 && b.height > 2 && cs.display !== 'none' && cs.visibility !== 'hidden'; };
  const header = document.querySelector('#uxHeader'), strip = document.querySelector('#uxPageStrip'), nav = document.querySelector('#uxMobileNav');
  const sec = document.querySelector('.view.active');
  // The first box the eye meets: a card, a button row, a pill (wrappers that start at the same spot count too).
  const first = [...sec.querySelectorAll('*')].filter(shown).sort((a, b) => box(a).top - box(b).top)[0];
  const pills = shown(strip) ? [...strip.querySelectorAll('a')].filter(a => { const cs = getComputedStyle(a); return cs.backgroundColor !== 'rgba(0, 0, 0, 0)' || parseFloat(cs.borderTopWidth) > 0; }).map(a => a.textContent) : [];
  const h1 = sec.querySelector('.topbar h1');
  return {
    header: shown(header) ? box(header).height : 0, headerBottom: shown(header) ? box(header).bottom : 0,
    strip: shown(strip) ? box(strip).height : null, stripBottom: shown(strip) ? box(strip).bottom : 0,
    stripLinks: shown(strip) ? strip.querySelectorAll('a[data-strip-view]').length : 0, pills,
    first: first ? { top: Math.round(box(first).top), what: first.tagName + '#' + first.id + '.' + first.className } : null,
    navBottom: box(nav).bottom, innerHeight: window.innerHeight,
    navItems: [...nav.querySelectorAll('[data-domain]')].filter(shown).length,
    navIcons: [...nav.querySelectorAll('[data-domain]')].filter(b => b.querySelector('svg use')).length,
    h1: shown(h1),
  };
};

await check('phone shell: compact header, underline tabs and content near the top on every page', async () => {
  const problems = [];
  const all = await phone.evaluate(() => window.LocalAIViews.VIEWS.map(v => v.id));
  for (const view of all) {
    await show(phone, view);
    const m = await phone.evaluate(shellMetrics);
    if (!(m.header > 0 && m.header <= 56)) problems.push(`${view}: header height ${m.header}`);
    if (m.strip !== null && m.strip > 44) problems.push(`${view}: page tabs ${m.strip}px tall`);
    if (m.strip !== null && !m.stripLinks) problems.push(`${view}: page tabs are not links`);
    if (m.pills.length) problems.push(`${view}: tabs drawn as pills (${m.pills.join(', ')})`);
    if (!m.first) problems.push(`${view}: nothing visible`);
    else {
      if (m.first.top > 120) problems.push(`${view}: first content at ${m.first.top}px (${m.first.what})`);
      if (m.first.top < Math.max(m.headerBottom, m.stripBottom) - 1) problems.push(`${view}: first content ${m.first.top}px sits under the header/tabs`);
    }
    if (Math.abs(m.navBottom - m.innerHeight) > 1) problems.push(`${view}: tab bar bottom ${m.navBottom} != ${m.innerHeight}`);
    if (m.navItems !== 5 || m.navIcons !== 5) problems.push(`${view}: tab bar has ${m.navItems} items, ${m.navIcons} with sprite icons`);
    if (m.h1) problems.push(`${view}: page title h1 is visible`);
  }
  assert.deepEqual(problems, []);
});

await check('phone header: brand on Home, domain button elsewhere that opens the page sheet', async () => {
  await show(phone, 'home');
  assert.equal(await phone.locator('#uxHeaderDomain').isVisible(), false, 'Home shows the brand, not the domain button');
  assert.match(await phone.locator('#uxHeader .ux-header-brand').innerText(), /Good (morning|afternoon|evening)\s+Local AI/);
  await show(phone, 'library');
  const domain = phone.locator('#uxHeaderDomain');
  assert.equal((await domain.innerText()).trim(), 'Workspace');
  assert.equal(await domain.locator('svg use').getAttribute('href'), '#i-chevron-down');
  assert.equal(await phone.locator('#uxPageStrip a[aria-current="page"]').innerText(), 'Library');
  await domain.click();
  await phone.locator('#uxMobileSheet[data-open="true"]').waitFor();
  assert.equal(await domain.getAttribute('aria-expanded'), 'true');
  assert.match(await phone.locator('#uxMobileSheetTitle').innerText(), /Workspace/);
  await phone.locator('#uxMobileSheetClose').click();
  await phone.locator('#uxMobileSheet[data-open="false"]').waitFor({ state: 'attached' });
});

await check('phone header: Search opens the palette; Health swaps it for its refresh action', async () => {
  await show(phone, 'ask');
  assert.equal(await phone.locator('#uxHeaderAction').isVisible(), false);
  await phone.locator('#uxSearchBtn').click();
  await phone.waitForFunction(() => document.querySelector('#cmdk')?.classList.contains('show'));
  await phone.keyboard.press('Escape');
  await phone.evaluate(() => { const c = document.querySelector('#cmdk'); c.classList.remove('show'); c.setAttribute('aria-hidden', 'true'); });
  await show(phone, 'status');
  assert.equal(await phone.locator('#uxSearchBtn').isVisible(), false);
  const action = phone.locator('#uxHeaderAction');
  assert.equal(await action.isVisible(), true);
  assert.equal(await action.getAttribute('aria-label'), 'Check again');
  assert.equal(await action.locator('svg use').getAttribute('href'), '#i-refresh');
  const checked = phone.waitForRequest(r => r.url().includes('/api/status'), { timeout: 5000 });
  await action.click();
  await checked;
  assert.equal(await phone.locator('#statusRetryBtn').count(), 1, 'the desktop button stays in the page');
  await show(phone, 'models');
  assert.equal(await phone.locator('#uxHeaderAction').isVisible(), false, 'the action belongs to Health only');
  assert.equal(await phone.locator('#uxSearchBtn').isVisible(), true);
  // A page can set and clear its own action.
  await phone.evaluate(() => window.LocalAIShell.setAction({ icon: 'plus', label: 'Add model', onClick: () => { window.__added = true; } }));
  await phone.locator('#uxHeaderAction[aria-label="Add model"]').click();
  assert.equal(await phone.evaluate(() => window.__added), true);
  await phone.evaluate(() => window.LocalAIShell.clearAction());
  assert.equal(await phone.locator('#uxHeaderAction').isVisible(), false);
});

await check('phone header: the Inbox bell carries its count in its label', async () => {
  await show(phone, 'ask');
  await phone.evaluate(() => window.dispatchEvent(new CustomEvent('localai:inbox-count', { detail: { unread: 3, pending: 1 } })));
  const bell = phone.locator('#uxHeader #uxInboxBtn');
  await bell.waitFor({ state: 'visible' });
  assert.equal(await bell.locator('svg use').getAttribute('href'), '#i-bell');
  assert.match(await bell.getAttribute('aria-label'), /\b4\b/);
  assert.equal((await phone.locator('#uxInboxCount').innerText()).trim(), '4');
  const r = await bell.evaluate(b => b.getBoundingClientRect());
  assert.ok(r.width >= 44 && r.height >= 44, `bell ${r.width}x${r.height}`);
  await bell.click();
  await phone.waitForSelector('#inbox.active');
});

await check('phone tab bar: Developer tools off leaves four equal items, on restores five', async () => {
  await show(phone, 'home');
  const widths = () => phone.evaluate(() => [...document.querySelectorAll('#uxMobileNav [data-domain]')].filter(b => b.getBoundingClientRect().width > 0).map(b => Math.round(b.getBoundingClientRect().width)));
  await phone.evaluate(() => window.LocalAIFirstRun.applyDevTools(false));
  const off = await widths();
  assert.equal(off.length, 4);
  assert.ok(Math.max(...off) - Math.min(...off) <= 1, `uneven: ${off}`);
  const navW = await phone.evaluate(() => document.querySelector('#uxMobileNav').getBoundingClientRect().width);
  assert.ok(off.reduce((a, b) => a + b, 0) >= navW - 24, `items ${off} do not fill ${navW}`);
  await phone.evaluate(() => window.LocalAIFirstRun.applyDevTools(true));
  assert.equal((await widths()).length, 5);
});
await phone.close();

await check('320px phone: Build page tabs scroll and keep the active tab in view', async () => {
  const small = await browser.newPage({ viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true });
  small.on('pageerror', e => pageErrors.push(e.message));
  await small.addInitScript(() => localStorage.setItem('localai.devTools', '1'));
  await small.goto(base, { waitUntil: 'domcontentloaded' });
  await small.waitForFunction(() => typeof window.showView === 'function' && document.querySelector('#uxPageStrip'));
  for (const view of ['changes', 'powershell', 'repoTools', 'activity']) {
    await show(small, view);
    const r = await small.evaluate(() => {
      const strip = document.querySelector('#uxPageStrip'), a = strip.querySelector('[aria-current="page"]');
      const s = strip.getBoundingClientRect(), b = a.getBoundingClientRect();
      return { scrolls: strip.scrollWidth > strip.clientWidth, overflowX: getComputedStyle(strip).overflowX, wraps: strip.getBoundingClientRect().height > 46,
        inView: b.left >= s.left - 1 && b.right <= s.right + 1, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, label: a.textContent };
    });
    assert.ok(r.overflowX === 'auto' || r.overflowX === 'scroll', `${view}: strip overflow-x ${r.overflowX}`);
    if (view !== 'activity') assert.ok(r.scrolls, `${view}: Build tabs should scroll at 320px`);
    assert.ok(!r.wraps, `${view}: tabs wrap`);
    assert.ok(r.inView, `${view}: active tab ${r.label} is not fully visible`);
    assert.ok(r.sw <= r.cw + 1, `${view}: page scrolls sideways ${r.sw} > ${r.cw}`);
  }
  await small.close();
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
