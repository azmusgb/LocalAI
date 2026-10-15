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

await check('home shows one name in the top bar', async () => {
  await page.evaluate(() => window.showView('home'));
  await page.waitForTimeout(150);
  assert.equal((await page.locator('.ux-context-left').innerText()).trim(), 'Home');
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

await check('no script errors on phone', async () => {
  assert.deepEqual(pageErrors, []);
});

await browser.close();
if (failures.length) {
  console.error('\nPhone failures:\n' + failures.map(x => ' - ' + x).join('\n'));
  process.exit(1);
}
console.log('\nAll phone checks passed.');
