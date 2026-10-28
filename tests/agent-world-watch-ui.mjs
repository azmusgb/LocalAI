import { chromium } from 'playwright';
import assert from 'node:assert/strict';

// Agent World watch mode (docs/USER-GUIDE.md › Watch mode): ⋯ › Watch mode loads /agent-world-watch.js on demand,
// fills the window with the city, captions the mission, and Exit puts the page back as it was.
const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const browser = await chromium.launch({ headless: true });
const failures = [];
async function check(name, fn) { try { await fn(); console.log('PASS', name); } catch (e) { failures.push(`${name}: ${e.message}`); console.error('FAIL', name, e.message); } }

const now = Date.now(), at = s => new Date(now - s * 1000).toISOString();
const MISSION = {
  id: 'mission-watch-1', goal: 'Compare three NAS drives', status: 'running', createdAt: at(300), updatedAt: at(5),
  workers: [
    { id: 'router', name: 'Mission Router', state: 'complete', dependsOn: [] },
    { id: 'research_agent', name: 'Research Agent', state: 'running', phase: 'inference', dependsOn: ['router'] },
    { id: 'synthesis', name: 'Coordinator', state: 'pending', dependsOn: ['research_agent'] }
  ],
  results: [], timeline: []
};

async function open(path) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(() => { try { localStorage.setItem('localai.firstRun.done', '1'); localStorage.setItem('localai.devTools', '0'); } catch {} });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route(u => u.pathname === '/api/agents/missions', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: [MISSION] }) }));
  await page.goto(base + path, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.showView === 'function');
  await page.evaluate(() => window.LocalAIRouter.go('#agents?mission=latest'));
  await page.waitForSelector('#agents.active #awcCanvas');
  return { page, context, errors };
}

await check('watch mode is not part of the page load', async () => {
  const { page, context } = await open('/');
  assert.equal(await page.evaluate(() => typeof window.LocalAIAgentWorldWatch), 'undefined');
  assert.equal(await page.locator('script[src="/agent-world-watch.js"]').count(), 0);
  await context.close();
});

await check('⋯ › Watch mode fills the window, captions the mission, and Exit restores the page', async () => {
  const { page, context, errors } = await open('/');
  await page.evaluate(() => document.querySelector('[data-aw-menu="watch"]').click());
  await page.waitForFunction(() => window.LocalAIAgentWorldWatch?.active());
  await page.waitForSelector('.aw-watch:not([hidden]) .aw-watch__title');
  await page.waitForFunction(() => document.querySelector('.aw-watch__title').textContent === 'Compare three NAS drives');
  assert.ok(await page.evaluate(() => document.body.classList.contains('aw-watching')));
  assert.ok(await page.evaluate(() => !!document.querySelector('.awc-v3.is-expanded')), 'the city is expanded');
  const box = await page.locator('.awc-v3.is-expanded').boundingBox();
  assert.ok(box.width >= 1270 && box.height >= 790, `fills the window (${box.width}x${box.height})`);
  assert.match(await page.locator('.aw-watch__status').textContent(), /\S/);
  await page.locator('.aw-watch__sound').click();
  assert.equal(await page.locator('.aw-watch__sound').getAttribute('aria-pressed'), 'false');
  await page.locator('.aw-watch__exit').click();
  assert.equal(await page.evaluate(() => window.LocalAIAgentWorldWatch.active()), false);
  assert.ok(await page.locator('.aw-watch').isHidden());
  assert.ok(await page.evaluate(() => !document.querySelector('.awc-v3.is-expanded') && !document.body.classList.contains('aw-watching')));
  assert.deepEqual(errors, []);
  await context.close();
});

await check('?watch=1 starts watch mode by itself', async () => {
  const { page, context, errors } = await open('/?open=agents&watch=1');
  await page.waitForFunction(() => window.LocalAIAgentWorldWatch?.active(), null, { timeout: 8000 });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !window.LocalAIAgentWorldWatch.active());
  assert.deepEqual(errors, []);
  await context.close();
});

await browser.close();
if (failures.length) { console.error(`\n${failures.length} failed:\n- ${failures.join('\n- ')}`); process.exit(1); }
console.log('\nAgent World watch mode: all checks passed');
