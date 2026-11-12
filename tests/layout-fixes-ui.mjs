// Layout fixes from the UX review: the phone run view header and output, Work without a page list on desktop, the System
// tab strip on phones, and the Missions placeholder weight.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const browser = await chromium.launch({ headless: true });
const T = { timeout: 6000 };
const failures = [];
async function check(name, fn) { try { await fn(); console.log('PASS', name); } catch (e) { failures.push(`${name}: ${e.message}`); console.error('FAIL', name, e.message); } }

const phone = { width: 390, height: 844 }, desk = { width: 1280, height: 860 };
const TITLE = 'Explain in careful detail how a heat pump moves warmth from cold outdoor air into a house in the middle of winter';
const out = { text: Array.from({ length: 60 }, (_, i) => `line ${i} of the output ` + 'x'.repeat(i % 7 === 0 ? 120 : 10)).join('\n') };
const now = new Date().toISOString();
const run = { id: 'run-long', type: 'automation', title: TITLE, status: 'completed', progress: 100, createdAt: now, updatedAt: now, output: out, summary: '', events: [], artifactIds: [],
  card: { kind: 'automation', icon: 'refresh', title: TITLE, summary: '', badge: { label: 'Done', tone: 'good' }, preview: null, action: { label: 'Open' }, approval: null } };

async function open(viewport, hash, { runs = [] } = {}) {
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport, isMobile: viewport.width < 760, hasTouch: viewport.width < 760 });
  await ctx.addInitScript(() => { try { localStorage.setItem('localai.devTools', '1'); localStorage.setItem('localai.firstRun.done', '1'); } catch {} });
  const page = await ctx.newPage();
  await page.route(u => u.pathname === '/api/runs', r => {
    const q = new URL(r.request().url()).searchParams, id = q.get('id');
    if (id) { const it = runs.find(x => x.id === id); return r.fulfill({ status: it ? 200 : 404, contentType: 'application/json', body: JSON.stringify(it ? { item: it } : { error: 'Run not found' }) }); }
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: runs, summary: {} }) });
  });
  await page.goto(base + '/' + hash, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.showView === 'function' && window.LocalAIRouter && window.LocalAIRuns && location.hash && document.querySelector('#uxMobileNav'), null, { timeout: 8000 });
  return page;
}

await check('phone: the run view title clamps to two lines (full title on hover) and the output grows with its text', async () => {
  const page = await open(phone, '#home', { runs: [run] });
  await page.evaluate(id => window.LocalAIRuns.show(id), run.id);
  await page.waitForSelector('#runDrawer .run-output', T);
  const t = await page.$eval('#runDrawerTitle', e => { const cs = getComputedStyle(e); return { h: e.getBoundingClientRect().height, lh: parseFloat(cs.lineHeight), title: e.title, full: e.textContent }; });
  assert.equal(t.full, TITLE);
  assert.equal(t.title, TITLE);
  assert.ok(t.h <= t.lh * 2 + 2, `title is ${t.h}px tall, line height ${t.lh}`);
  const o = await page.$eval('#runDrawer .run-output', e => { const cs = getComputedStyle(e); return { clientH: e.clientHeight, scrollH: e.scrollHeight, overflowY: cs.overflowY, maxH: cs.maxHeight, sideways: e.scrollWidth > e.clientWidth + 1 }; });
  assert.ok(o.scrollH <= o.clientH + 1, `output scrolls inside itself: ${o.scrollH} > ${o.clientH}`);
  assert.ok(o.clientH > 360, `output is taller than the old 360px box: ${o.clientH}`);
  assert.equal(o.sideways, false);
  await page.context().close();
});

await check('desktop: one rail and one strip on every page; the top bar names the area', async () => {
  const page = await open(desk, '#work');
  await page.waitForSelector('#work.active', T);
  await page.waitForTimeout(300);
  const left = () => page.evaluate(() => document.querySelector('main').getBoundingClientRect().left);
  const area = async () => (await page.locator('#uxContextBar .ux-context-left').innerText()).replace(/\s+/g, ' ').trim();
  const x = await left();
  assert.ok(x < 120, `main starts at ${x}px, beside the 76px rail`);
  assert.equal(await area(), 'Work');
  assert.deepEqual(await page.locator('#uxPageStrip button').allInnerTexts(), ['Work', 'Agent World', 'Assistant automations']);
  await page.evaluate(() => LocalAIRouter.go('#status'));
  await page.waitForSelector('#status.active', T);
  await page.waitForTimeout(300);
  assert.equal(await left(), x, 'content starts at the same x in every area');
  assert.equal(await area(), 'System');
  assert.equal(await page.locator('#uxPageStrip [aria-current="page"]').innerText(), 'Status');
  await page.context().close();
});

// Every strip fits a 320 px phone since Status and Connections became one page (#524), so nothing overflows by itself.
// The scrolling still matters for a longer label or larger text: the check narrows the strip to make it overflow.
await check('small phone: the System tab strip scrolls, fades at the overflowing edge, and keeps the open tab in view', async () => {
  const page = await open({ width: 320, height: 640 }, '#status');
  await page.waitForSelector('#status.active', T);
  const strip = page.locator('#uxPageStrip');
  await strip.waitFor({ state: 'visible', timeout: 6000 });
  await strip.evaluate(e => { e.style.maxWidth = '200px'; e.dispatchEvent(new Event('scroll')); });
  const info = () => strip.evaluate(e => ({ sw: e.scrollWidth, cw: e.clientWidth, left: e.scrollLeft, start: e.dataset.fadeStart, end: e.dataset.fadeEnd, mask: getComputedStyle(e).maskImage || getComputedStyle(e).webkitMaskImage }));
  let i = await info();
  assert.ok(i.sw > i.cw + 20, 'the strip overflows');
  assert.equal(i.end, 'true'); assert.notEqual(i.start, 'true');
  assert.ok(i.mask && i.mask !== 'none', 'a fade is drawn at the cut-off edge: ' + i.mask);
  await strip.evaluate(e => { e.scrollLeft = e.scrollWidth; });
  await page.waitForFunction(() => document.getElementById('uxPageStrip').dataset.fadeEnd === 'false', null, T);
  i = await info();
  assert.equal(i.start, 'true');
  await page.evaluate(() => LocalAIRouter.go('#activity'));
  await page.waitForSelector('#activity.active', T);
  await page.waitForTimeout(300);
  const vis = await page.evaluate(() => { const s = document.getElementById('uxPageStrip'), b = s.querySelector('[aria-current="page"]'), sr = s.getBoundingClientRect(), br = b.getBoundingClientRect(); return br.left >= sr.left - 1 && br.right <= sr.right + 1; });
  assert.ok(vis, 'the open tab is fully inside the strip');
  await page.context().close();
});

await check('the Missions objective placeholder is normal weight', async () => {
  const page = await open(phone, '#home');
  await page.evaluate(() => LocalAIRouter.open('agents'));
  await page.waitForSelector('#agents.active', T);
  assert.equal(await page.$eval('#agentGoal', e => getComputedStyle(e, '::placeholder').fontWeight), '400');
  await page.context().close();
});

await browser.close();
if (failures.length) { console.error('\n' + failures.join('\n')); process.exit(1); }
console.log('All layout fix checks passed.');
