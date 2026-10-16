import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const browser = await chromium.launch({ headless: true });
const T = { timeout: 6000 };
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

const DEFAULTS = { home: 'home', work: 'work', projects: 'library', improve: 'backlog', system: 'status' };

async function open(viewport, hash, { devTools = '1' } = {}) {
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport, isMobile: viewport.width < 760, hasTouch: viewport.width < 760 });
  await ctx.addInitScript(v => { try { localStorage.setItem('localai.devTools', v); } catch {} }, devTools);
  const page = await ctx.newPage({ serviceWorkers: 'block' });
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  await page.goto(base + '/' + hash, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.showView === "function" && window.LocalAIRouter && location.hash && document.querySelector("#uxMobileNav"), null, { timeout: 8000 });
  return page;
}
const nav = page => page.locator(page.viewportSize().width < 760 ? '#uxMobileNav' : '.ux-primary-rail');
const item = (page, d) => nav(page).locator(`[data-domain="${d}"]`);
// The `work` page is created by a later task; until then Work shows the run list.
const workSection = page => page.evaluate(() => document.getElementById('work') ? '#work' : '#runs');

for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 860 }]) {
  const tag = `${viewport.width}px`;

  await check(`${tag}: loading with a hash honours it, and no hash means #home`, async () => {
    const page = await open(viewport, '#library');
    await page.waitForSelector('#library.active', T);
    assert.equal(await page.evaluate(() => location.hash), '#library');
    const bare = await open(viewport, '');
    await bare.waitForSelector('#home.active', T);
    assert.equal(await bare.evaluate(() => location.hash), '#home');
    await page.context().close(); await bare.context().close();
  });

  await check(`${tag}: each tab sets the hash to that page's default view`, async () => {
    const page = await open(viewport, '');
    for (const [d, view] of Object.entries(DEFAULTS)) {
      await item(page, d).click();
      await page.waitForFunction(h => location.hash === h, '#' + view, T);
      const sel = view === 'work' ? await workSection(page) : '#' + view;
      await page.waitForSelector(sel + '.active', T);
    }
    await page.context().close();
  });

  await check(`${tag}: Back follows real navigation`, async () => {
    const page = await open(viewport, '');
    await item(page, 'projects').click();
    await page.waitForSelector('#library.active', T);
    await item(page, 'system').click();
    await page.waitForSelector('#status.active', T);
    await page.evaluate(() => history.back());
    await page.waitForSelector('#library.active', T);
    await page.evaluate(() => history.back());
    await page.waitForSelector('#home.active', T);
    assert.equal(await page.evaluate(() => location.hash), '#home');
    await page.context().close();
  });

  await check(`${tag}: showView from code replaces the hash and never loops`, async () => {
    const page = await open(viewport, '');
    const before = await page.evaluate(() => history.length);
    await page.evaluate(() => { window.showView('models'); window.showView('inbox'); });
    await page.waitForSelector('#inbox.active', T);
    assert.equal(await page.evaluate(() => location.hash), '#inbox');
    assert.equal(await page.evaluate(() => history.length), before);
    await page.context().close();
  });

  await check(`${tag}: old ids land on their new page with the intent kept`, async () => {
    const ask = await open(viewport, '#ask');
    await ask.waitForSelector('#home.active', T);
    assert.equal(await ask.evaluate(() => LocalAIRouter.current().query.get('mode')), 'ask');
    const agents = await open(viewport, '#agents');
    await agents.waitForSelector((await workSection(agents)) + '.active', T);
    assert.equal(await agents.evaluate(() => LocalAIRouter.current().query.get('kind')), 'missions');
    assert.equal(await agents.evaluate(() => LocalAIRouter.current().page), 'work');
    assert.deepEqual(await agents.evaluate(() => LocalAIRouter.intentFor('agents')), { kind: 'missions' });
    assert.deepEqual(await agents.evaluate(() => LocalAIRouter.intentFor('create')), { mode: 'create' });
    await ask.context().close(); await agents.context().close();
  });

  await check(`${tag}: hidden pages stay reachable from code`, async () => {
    const page = await open(viewport, '');
    await page.evaluate(() => window.showView('ask'));
    await page.waitForSelector('#ask.active', T);
    assert.equal(await nav(page).locator('[data-domain]').evaluateAll(els => els.map(e => e.dataset.domain).join()), 'home,work,projects,improve,system');
    await page.context().close();
  });

  await check(`${tag}: a domain id in the hash opens that domain's first page`, async () => {
    for (const [id, view] of [['improve', 'backlog'], ['system', 'status'], ['work', 'work'], ['home', 'home'], ['projects', 'projects']]) {
      const page = await open(viewport, '#' + id);
      await page.waitForSelector('#' + view + '.active', T);
      assert.equal(await page.evaluate(() => location.hash), '#' + view, id);
      await page.context().close();
    }
  });

  await check(`${tag}: opening a hidden page from the app pushes it, and Back returns`, async () => {
    const page = await open(viewport, '#work');
    await page.waitForSelector('#work.active', T);
    const before = await page.evaluate(() => history.length);
    await page.evaluate(() => LocalAIRouter.open('agents'));
    await page.waitForSelector('#agents.active', T);
    assert.equal(await page.evaluate(() => location.hash), '#agents');
    assert.equal(await page.evaluate(() => history.length), before + 1);
    await page.evaluate(() => history.back());
    await page.waitForSelector('#work.active', T);
    await page.evaluate(() => history.forward());
    await page.waitForSelector('#agents.active', T);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#agents.active', T); // the entry's own state survives a reload
    await page.context().close();
  });

  await check(`${tag}: a page opened while a run is open shows the page and Back leaves it`, async () => {
    const page = await open(viewport, '#home');
    await page.evaluate(() => LocalAIRouter.go('#run/missing-run'));
    await page.waitForSelector('#runDrawerBackdrop.show', T);
    await page.evaluate(() => window.LocalAIOpen('/?open=status'));
    await page.waitForSelector('#status.active', T);
    assert.equal(await page.locator('#runDrawerBackdrop.show').count(), 0);
    assert.equal(await page.evaluate(() => location.hash), '#status');
    await page.evaluate(() => history.back());
    await page.waitForFunction(() => location.hash !== '#status', null, T);
    await page.context().close();
  });

  if (viewport.width >= 760) {
    await check(`${tag}: secondary links, Models and Integrations push history and set the hash`, async () => {
      const page = await open(viewport, '#status');
      await page.waitForSelector('#status.active', T);
      for (const view of ['activity', 'models', 'integrations', 'status']) {
        const before = await page.evaluate(() => history.length);
        await page.locator(`.ux-secondary-link[data-view="${view}"]`).click();
        await page.waitForSelector(`#${view}.active`, T);
        assert.equal(await page.evaluate(() => location.hash), '#' + view);
        assert.equal(await page.evaluate(() => history.length), before + 1, view);
      }
      await page.locator('.ux-secondary-link[data-view="models"]').click();
      await page.waitForSelector('#models.active', T);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#models.active', T);
      await page.evaluate(() => history.back());
      await page.waitForSelector('#status.active', T);
      await page.context().close();
    });
  }

  await check(`${tag}: a tab tapped while the app is still starting is kept`, async () => {
    const ctx = await browser.newContext({ serviceWorkers: 'block', viewport, isMobile: viewport.width < 760, hasTouch: viewport.width < 760 });
    const page = await ctx.newPage({ serviceWorkers: 'block' });
    await page.route('**/api/config', async r => { await new Promise(res => setTimeout(res, 800)); await r.fallback(); });
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(viewport.width < 760 ? '#uxMobileNav' : '.ux-primary-rail', { timeout: 8000 });
    const before = await page.evaluate(() => history.length);
    await item(page, 'projects').click();
    await page.waitForFunction(() => typeof window.showView === 'function' && location.hash, null, { timeout: 8000 });
    await page.waitForSelector('#library.active', T);
    assert.equal(await page.evaluate(() => location.hash), '#library');
    assert.equal(await page.evaluate(() => history.length), before + 1);
    await ctx.close();
  });

  await check(`${tag}: Run paths go to the registered handler`, async () => {
    const page = await open(viewport, '');
    await page.evaluate(() => { window.__runs = []; LocalAIRouter.onRun(id => window.__runs.push(id)); LocalAIRouter.go('#run/abc'); });
    await page.waitForFunction(() => window.__runs.includes('abc'), null, T);
    assert.equal(await page.evaluate(() => LocalAIRouter.current().runId), 'abc');
    await page.context().close();
  });

  await check(`${tag}: Developer tools off hides Improve but its pages still open`, async () => {
    const page = await open(viewport, '#changes', { devTools: '0' });
    await page.waitForSelector('#changes.active', T);
    assert.equal(await item(page, 'improve').isVisible(), false);
    const boxes = await nav(page).locator('[data-domain]:visible').evaluateAll(els => els.map(e => Math.round(e.getBoundingClientRect().width)));
    assert.equal(boxes.length, 4);
    if (viewport.width < 760) assert.ok(Math.max(...boxes) - Math.min(...boxes) <= 1, `unequal widths ${boxes}`);
    await page.context().close();
  });
}

await browser.close();
if (failures.length) { console.error('\n' + failures.join('\n')); process.exit(1); }
