import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const axePath = join(dirname(fileURLToPath(import.meta.url)), 'vendor', 'axe.min.js');
const browser = await chromium.launch({ headless: true });
const T = { timeout: 6000 };
const failures = [];
async function check(name, fn) {
  try { await fn(); console.log('PASS', name); } catch (error) { failures.push(`${name}: ${error.message}`); console.error('FAIL', name, error.message); }
}

const HOUR = 3600e3, NOW = Date.now();
let seq = 0;
// A /api/runs list item the way the server sends it: the run plus `card`.
const item = (kind, title, ageMs, o = {}) => {
  const n = ++seq, status = o.status || 'completed';
  return {
    id: o.id || `run-${NOW - ageMs}-${n}`, type: kind, status, progress: o.progress ?? (status === 'running' ? 20 : 100), threadId: o.threadId || undefined,
    createdAt: new Date(NOW - ageMs).toISOString(), updatedAt: new Date(NOW - ageMs).toISOString(),
    card: { kind, icon: 'system', title, summary: o.summary || '', badge: { label: status === 'running' ? 'Working' : 'Done', tone: status === 'running' ? 'accent' : 'good' }, preview: null, action: { label: 'Open' }, approval: null }
  };
};
const mixed = () => [
  item('chat', 'Plan the garden', 5 * 60e3, { summary: 'Raised beds and tomatoes' }),
  item('image', 'A red fox at dusk', 2 * HOUR),
  item('chat', 'Why is sqlite so fast', 26 * HOUR, { summary: 'WAL mode explained' }),
  item('agent', 'Summarise the inbox', 3 * 24 * HOUR),
  item('engineering', 'Add a dark mode toggle', 3 * 24 * HOUR + HOUR),
  item('research', 'Heat pump prices', 30 * 24 * HOUR),
  item('automation', 'Nightly backup', 31 * 24 * HOUR)
];
// Stub state: `list(url)` answers each /api/runs request; `calls` records the URLs.
async function open(viewport, hash, list, { storage = {}, center = true } = {}) {
  const ctx = await browser.newContext({ viewport, isMobile: viewport.width < 760, hasTouch: viewport.width < 760 });
  await ctx.addInitScript(s => { try { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); } } catch {} }, { 'localai.devTools': '1', ...storage });
  const page = await ctx.newPage();
  page.calls = []; page.known = new Map();
  await page.route(u => u.pathname === '/api/runs', async r => {
    const url = new URL(r.request().url());
    const json = body => r.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (url.searchParams.get('id')) { const it = page.known.get(url.searchParams.get('id')); return it ? json({ item: it }) : r.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Run not found"}' }); }
    if (!url.searchParams.get('threads')) return json({ items: center ? [...page.known.values()] : [], summary: {} }); // the run center's own poll (newest 120)
    page.calls.push(url);
    const out = await list(url, page.calls.length);
    for (const it of Array.isArray(out) ? out : []) page.known.set(it.id, it);
    if (out && out.status) return r.fulfill({ status: out.status, contentType: 'application/json', body: JSON.stringify({ error: 'Server blew up' }) });
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: out, summary: {} }) });
  });
  await page.goto(base + '/' + hash, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.showView === 'function' && window.LocalAIRouter && location.hash, null, { timeout: 8000 });
  return page;
}
const rows = page => page.locator('#work .run-card');
const kinds = async page => [...new Set(await rows(page).evaluateAll(r => r.map(x => x.dataset.kind)))].sort();
const desk = { width: 1280, height: 860 }, phone = { width: 390, height: 844 };


const inView = page => page.evaluate(() => !!document.activeElement?.closest('#runDrawerBackdrop'));
const openRow = async (page, id) => { await page.locator(`#work [data-run-id="${id}"] button`).first().focus(); await page.keyboard.press('Enter'); await page.waitForSelector('#runDrawerBackdrop.show #runDetailsBtn', T); };
const runs = () => [item('chat', 'Plan the garden', 5 * 60e3, { id: 'run-a', summary: 'Raised beds' }), item('agent', 'Sorting the archive', 60e3, { id: 'run-b', status: 'running' })];

await check('the page behind is inert while the run view is open, and not after', async () => {
  const page = await open(desk, '#work', async () => runs());
  await page.waitForSelector('#work .run-card', T);
  await openRow(page, 'run-a');
  assert.equal(await page.evaluate(() => document.querySelector('.app').inert), true);
  assert.equal(await page.evaluate(() => [...document.body.children].filter(e => e.id !== 'runDrawerBackdrop' && e.inert).length > 0), true);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.getElementById('runDrawerBackdrop').classList.contains('show'), null, T);
  assert.equal(await page.evaluate(() => document.querySelector('.app').inert), false);
  assert.equal(await page.evaluate(() => [...document.body.children].some(e => e.inert && e.id !== 'uxMobileSheet')), false);
  await page.context().close();
});

await check('30 Tabs never leave the run view; Shift+Tab from the first wraps to the last', async () => {
  const page = await open(desk, '#work', async () => runs());
  await page.waitForSelector('#work .run-card', T);
  await openRow(page, 'run-a');
  for (let i = 0; i < 30; i++) { await page.keyboard.press('Tab'); assert.ok(await inView(page), `tab ${i + 1} left the run view`); }
  await page.evaluate(() => document.querySelector('#runDrawer button').focus());
  await page.keyboard.press('Shift+Tab');
  const last = await page.evaluate(() => { const f = [...document.querySelectorAll('#runDrawer button, #runDrawer a[href], #runDrawer input, #runDrawer select, #runDrawer textarea, #runDrawer [tabindex="0"]')].filter(e => !e.disabled && e.offsetParent); return f[f.length - 1] === document.activeElement; });
  assert.ok(last, 'Shift+Tab did not wrap to the last control');
  await page.context().close();
});

await check('focus is not <body> after a re-render', async () => {
  const page = await open(desk, '#work', async () => runs());
  await page.waitForSelector('#work .run-card', T);
  await openRow(page, 'run-b');
  await page.focus('#runDetailsBtn');
  page.known.get('run-b').progress = 55; page.known.get('run-b').summary = 'Halfway';
  await page.evaluate(() => window.LocalAIRuns.refresh());
  await page.waitForFunction(() => document.querySelector('#runDrawer .run-view-bar')?.getAttribute('aria-valuenow') === '55', null, T);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'runDetailsBtn');
  await page.context().close();
});

await check('from Home to Work, opening a run puts focus inside the run view', async () => {
  const page = await open(desk, '#home', async () => runs());
  await page.evaluate(() => window.LocalAIRouter.go('#work'));
  await page.waitForSelector('#work.active .run-card', T);
  await page.locator('#work [data-run-id="run-a"] button').first().click();
  await page.waitForSelector('#runDrawerBackdrop.show #runDetailsBtn', T);
  await page.waitForFunction(() => document.activeElement?.closest('#runDrawerBackdrop'), null, T);
  await page.context().close();
});

await check('Escape returns focus to the row that opened the run', async () => {
  const page = await open(desk, '#work', async () => runs());
  await page.waitForSelector('#work .run-card', T);
  await openRow(page, 'run-b');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.getElementById('runDrawerBackdrop').classList.contains('show'), null, T);
  await page.waitForFunction(() => document.activeElement?.closest('[data-run-id]')?.dataset.runId === 'run-b', null, T);
  await page.context().close();
});

await check('if the opener was re-rendered away, focus goes to the same run row', async () => {
  const page = await open(desk, '#work', async () => runs());
  await page.waitForSelector('#work .run-card', T);
  await openRow(page, 'run-b');
  await page.evaluate(() => { const c = document.querySelector('#work [data-run-id="run-b"]'); const n = c.cloneNode(true); c.replaceWith(n); });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement?.closest('[data-run-id]')?.dataset.runId === 'run-b', null, T);
  await page.context().close();
});

await check('with the details sheet open, Tab stays inside the sheet; Escape closes the sheet first', async () => {
  const page = await open(desk, '#work', async () => runs());
  await page.waitForSelector('#work .run-card', T);
  await openRow(page, 'run-a');
  await page.click('#runDetailsBtn');
  await page.waitForFunction(() => document.getElementById('runDetailsSheet').open, null, T);
  for (let i = 0; i < 15; i++) { await page.keyboard.press('Tab'); assert.ok(await page.evaluate(() => !!document.activeElement?.closest('#runDetailsSheet')), `tab ${i + 1} left the sheet`); }
  await page.keyboard.press('Shift+Tab');
  assert.ok(await page.evaluate(() => !!document.activeElement?.closest('#runDetailsSheet')));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.getElementById('runDetailsSheet').open, null, T);
  assert.ok(await page.evaluate(() => document.getElementById('runDrawerBackdrop').classList.contains('show')));
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'runDetailsBtn');
  await page.context().close();
});

await check('axe: the open run view passes color-contrast and target-size on phone and desktop', async () => {
  for (const vp of [phone, desk]) {
    const page = await open(vp, '#work', async () => runs());
    await page.waitForSelector('#work .run-card', T);
    await openRow(page, 'run-a');
    await page.addScriptTag({ path: axePath });
    const v = await page.evaluate(() => window.axe.run('#runDrawerBackdrop', { runOnly: { type: 'rule', values: ['color-contrast', 'target-size'] } }).then(r => r.violations.map(x => `${x.id}: ${x.nodes.map(n => n.html).join(' | ')}`)));
    assert.deepEqual(v, []);
    await page.context().close();
  }
});

await browser.close();
if (failures.length) { console.error('\n' + failures.length + ' failing:\n' + failures.join('\n')); process.exit(1); }
console.log('\nAll run view a11y checks passed');
