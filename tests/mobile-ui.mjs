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

// Phone shell (redesign task 2), on a 390×844 phone.
const shell = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
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
        title: !!(title && title.getBoundingClientRect().height > 0)
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
  await shell.evaluate(() => window.dispatchEvent(new CustomEvent('localai:inbox-count', { detail: { unread: 0, pending: 0 } })));
  assert.equal(await shell.locator('#uxInboxBtn').isVisible(), true, 'the bell stays on phones at zero');
  assert.equal(await shell.locator('#uxInboxCount').isVisible(), false, 'no badge at zero');
});

await check('shell: a page action shows in the header only on its page', async () => {
  let clicked = 0;
  await shell.exposeFunction('__shellActionClicked', () => { clicked++; });
  await shell.evaluate(() => window.LocalAIShell.setAction('status', { icon: 'refresh', label: 'Check again', onClick: () => window.__shellActionClicked() }));
  await shell.evaluate(() => window.showView('status'));
  await shell.locator('#uxHeaderAction').click();
  assert.equal(await shell.locator('#uxHeaderAction').getAttribute('aria-label'), 'Check again');
  assert.equal(clicked, 1);
  await shell.evaluate(() => window.showView('models'));
  assert.equal(await shell.locator('#uxHeaderAction').isVisible(), false);
  await shell.evaluate(() => window.LocalAIShell.clearAction('status'));
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
await shell.close();

// Home and Chat (redesign task 3). Capabilities are stubbed with 11 unfinished change requests.
const hc = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
hc.on('pageerror', e => pageErrors.push(e.message));
await hc.route('**/api/capabilities', async route => {
  const res = await route.fetch(); const json = await res.json();
  await route.fulfill({ response: res, json: { ...json, changes: { ...(json.changes || {}), pending: 11 } } });
});
await hc.goto(base, { waitUntil: 'domcontentloaded' });
await hc.waitForFunction(() => typeof window.showView === 'function');
await hc.evaluate(() => { document.getElementById('firstRun')?.remove(); window.showView('home'); });

await check('home: one ask card, one row of quick starts, no status tiles or execution map', async () => {
  assert.equal((await hc.locator('#home .workspace-hero h1').innerText()).trim(), 'What should we do?');
  const tops = await hc.locator('#home .home-quick .suggestion-chip').evaluateAll(els => els.map(e => Math.round(e.getBoundingClientRect().top)));
  assert.ok(tops.length === 3 && new Set(tops).size === 1, `quick starts on ${new Set(tops).size} rows`);
  for (const id of ['#homeCapabilities', '#homeExecutionCard', '#homeActivityCard']) assert.equal(await hc.locator(id).isVisible(), false, `${id} is visible`);
});

await check('home: Needs you lists unfinished change requests and opens them', async () => {
  const row = hc.locator('#truthAttention .truth-attention-item', { hasText: '11 change requests are unfinished' });
  await row.waitFor({ state: 'visible' });
  assert.equal((await hc.locator('#truthAttentionTitle').innerText()).trim(), 'Needs you');
  await row.locator('.truth-attention-action').click();
  await hc.waitForSelector('#changes.active');
});

await check('chat: empty state, a globe that drives web research, no idle text, composer clear of the empty state', async () => {
  await hc.evaluate(() => window.showView('ask'));
  await hc.locator('#chatEmpty').waitFor({ state: 'visible' });
  const r = await hc.evaluate(() => { const a = document.querySelector('#chatEmpty').getBoundingClientRect(), b = document.querySelector('.composer-wrap').getBoundingClientRect(); return a.bottom <= b.top + 1; });
  assert.ok(r, 'the empty state overlaps the composer');
  assert.equal(await hc.locator('#chatState').isVisible(), false, 'Idle is shown');
  await hc.locator('#chatEmpty [data-chat-suggest]').first().click();
  assert.equal(await hc.locator('#chatInput').inputValue(), 'Explain this error message to me');
  await hc.evaluate(() => { const c = document.getElementById('webSearch'); c.disabled = false; c.checked = false; });
  const toggle = hc.locator('#chatWebToggle');
  await hc.waitForFunction(() => !document.getElementById('chatWebToggle').disabled);
  await toggle.click();
  assert.equal(await hc.evaluate(() => document.getElementById('webSearch').checked), true);
  assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
  await toggle.click();
  assert.equal(await hc.evaluate(() => document.getElementById('webSearch').checked), false);
  await hc.evaluate(() => { document.getElementById('webSearch').disabled = true; });
  await hc.waitForFunction(() => document.getElementById('chatWebToggle').disabled);
});

await check('chat: with the keyboard open the composer stays on screen', async () => {
  await hc.setViewportSize({ width: 390, height: 544 });
  await hc.evaluate(() => { window.showView('ask'); document.getElementById('chatInput').focus(); });
  await hc.waitForTimeout(200);
  const r = await hc.evaluate(() => ({ input: document.getElementById('chatInput').getBoundingClientRect().bottom, send: document.getElementById('sendBtn').getBoundingClientRect().bottom, h: window.innerHeight }));
  assert.ok(r.input <= r.h && r.send <= r.h, `composer at ${r.input}/${r.send}, viewport ${r.h}`);
  await hc.setViewportSize({ width: 390, height: 844 });
});
await hc.unrouteAll({ behavior: 'ignoreErrors' });
await hc.close();

// Change requests and Missions (redesign task 4), with stubbed changes and missions.
const cm = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
cm.on('pageerror', e => pageErrors.push(e.message));
await cm.addInitScript(() => { try { localStorage.setItem('localai.devTools', '1'); } catch {} });
const now = Date.now(), iso = ms => new Date(now - ms).toISOString();
const stubChanges = [
  { id: 'chg-1', summary: 'Remember the last image size', target: 'self', status: 'awaiting_approval', files: [{}, {}], createdAt: iso(3 * 3600e3), updatedAt: iso(3 * 3600e3) },
  { id: 'chg-2', summary: 'Fix the Create page model selector', target: 'self', status: 'validation_failed', files: [], createdAt: iso(16 * 86400e3), updatedAt: iso(16 * 86400e3) },
  { id: 'chg-3', summary: 'Tidy the audit log', target: 'self', status: 'applied', files: [{}], createdAt: iso(20 * 86400e3), updatedAt: iso(20 * 86400e3) }
];
await cm.route('**/api/changes', route => route.fulfill({ json: { items: stubChanges, pending: 11 } }));
await cm.route('**/api/agents/missions', route => route.fulfill({ json: { items: [{ id: 'm-1', goal: 'Identify one mission completion behavior and cite the source file', status: 'complete', createdAt: iso(200e3), updatedAt: iso(20e3), workers: [{ id: 'router', name: 'Router', state: 'complete' }, { id: 'research_agent', name: 'Research', state: 'complete' }, { id: 'coordinator', name: 'Coordinator', state: 'complete' }], results: [] }] } }));
await cm.goto(base, { waitUntil: 'domcontentloaded' });
await cm.waitForFunction(() => typeof window.showView === 'function' && window.LocalAIKit);

await check('changes: banner, readable picker values, plain-language badges, banner filters to what is left to do', async () => {
  await cm.evaluate(() => window.showView('changes'));
  await cm.locator('#changesBanner').waitFor({ state: 'visible' });
  assert.equal(await cm.locator('#changesBannerCount').innerText(), '11');
  const target = await cm.evaluate(() => { const s = document.getElementById('engineeringTarget'), r = s.getBoundingClientRect(), c = getComputedStyle(s); return { text: s.selectedOptions[0]?.textContent.trim(), w: r.width, color: c.color, op: c.opacity }; });
  assert.ok(target.text && target.w >= 80 && target.color !== 'rgba(0, 0, 0, 0)' && target.op !== '0', `target picker hides its value: ${JSON.stringify(target)}`);
  const list = await cm.locator('#changeList').innerText();
  assert.match(list, /Ready to review/); assert.match(list, /Needs a look/); assert.match(list, /Done/);
  assert.doesNotMatch(await cm.locator('#changes').innerText(), /awaiting_approval|validation_failed|needs_attention/);
  await cm.locator('#changesBanner').click();
  assert.equal(await cm.locator('#changeList [data-change-id]').count(), 2, 'applied changes are filtered out');
  await cm.locator('#changeFilterAll').click();
  assert.equal(await cm.locator('#changeList [data-change-id]').count(), 3);
});

await check('missions: a quiet goal field and the last mission with its outcome', async () => {
  await cm.evaluate(() => window.showView('agents'));
  const goal = await cm.evaluate(() => { const c = getComputedStyle(document.getElementById('agentGoal'), '::placeholder'); const t = getComputedStyle(document.getElementById('agentGoal')); return { weight: Number(t.fontWeight), pweight: Number(c.fontWeight), size: parseFloat(t.fontSize) }; });
  assert.ok(goal.weight <= 400 && goal.pweight <= 400 && goal.size <= 17, `goal text ${JSON.stringify(goal)}`);
  const card = cm.locator('#missionLastCard');
  await card.waitFor({ state: 'visible' });
  assert.match(await card.innerText(), /Identify one mission completion behavior/);
  assert.match(await card.locator('.badge').innerText(), /Done/);
  assert.match(await card.innerText(), /Router, Research, Coordinator · 3 min/);
  await card.locator('[data-last-read]').click();
  assert.equal(await cm.locator('[data-agent-result-tab="summary"]').evaluate(b => b.classList.contains('active')), true);
});
await cm.close();

await check('no script errors on phone', async () => {
  assert.deepEqual(pageErrors, []);
});

await browser.close();
if (failures.length) {
  console.error('\nPhone failures:\n' + failures.map(x => ' - ' + x).join('\n'));
  process.exit(1);
}
console.log('\nAll phone checks passed.');
