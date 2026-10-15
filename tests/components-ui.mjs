import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const axePath = join(dirname(fileURLToPath(import.meta.url)), 'vendor', 'axe.min.js');
const browser = await chromium.launch({ headless: true });
const failures = [];
async function check(name, fn) {
  try { await fn(); console.log('PASS', name); } catch (error) { failures.push(`${name}: ${error.message}`); console.error('FAIL', name, error.message); }
}
const newPage = async (setup) => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  if (setup) await setup(page);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.LocalAIUI && typeof window.showView === 'function');
  return page;
};
const fixture = page => page.evaluate(() => { document.getElementById('fx')?.remove(); const d = document.createElement('div'); d.id = 'fx'; document.body.prepend(d); });

const page = await newPage();
await fixture(page);
const run = (load, extra = '') => page.evaluate(([load, extra]) => {
  const fx = document.getElementById('fx');
  window.__p = window.LocalAIUI.loadInto(fx, eval(load), { render: (c, t) => { c.innerHTML = t.length ? t.map(x => `<p class="row">${x}</p>`).join('') : ''; return t.length > 0; }, empty: 'No runs yet.', what: 'runs' });
  return window.__p.then(() => 'ok', () => 'rejected');
}, [load, extra]);
const text = () => page.locator('#fx').innerText();

await check('loadInto renders a resolved load', async () => {
  assert.equal(await run('async()=>["a","b"]'), 'ok');
  assert.equal(await page.locator('#fx .row').count(), 2);
});
await check('render returning false shows the empty copy', async () => {
  await run('async()=>[]');
  assert.match(await text(), /No runs yet\./);
});
await check('a rejected load shows the error and a Retry button', async () => {
  assert.equal(await run('async()=>{throw new Error("boom")}'), 'rejected');
  const t = await text();
  assert.match(t, /Couldn't load runs\./); assert.match(t, /boom/);
  assert.equal(await page.locator('#fx .state-error button.btn-outline', { hasText: 'Retry' }).count(), 1);
});
await check('success, failed Retry replaces the list, second Retry restores it', async () => {
  await page.evaluate(() => { window.__mode = 'ok'; const fx = document.getElementById('fx'); window.__load = async () => { if (window.__mode === 'fail') throw new Error('offline'); return ['x', 'y', 'z']; }; window.__opts = { render: (c, t) => { c.innerHTML = t.map(i => `<p class="row">${i}</p>`).join(''); return true; }, empty: 'none', what: 'runs' }; return window.LocalAIUI.loadInto(fx, window.__load, window.__opts); });
  assert.equal(await page.locator('#fx .row').count(), 3);
  await page.evaluate(() => { window.__mode = 'fail'; });
  await page.locator('#fx').evaluate(fx => window.LocalAIUI.loadInto(fx, window.__load, window.__opts).catch(() => {}));
  assert.equal(await page.locator('#fx .row').count(), 0);
  await page.locator('#fx .state-error button').click();
  await page.waitForSelector('#fx .state-error');
  assert.match(await text(), /offline/);
  await page.evaluate(() => { window.__mode = 'ok'; });
  await page.locator('#fx .state-error button').click();
  await page.waitForSelector('#fx .row');
  assert.equal(await page.locator('#fx .row').count(), 3);
  assert.equal(await page.locator('#fx .state-error').count(), 0);
});
await check('a slow load shows the loading state only after 300 ms', async () => {
  await fixture(page);
  await page.evaluate(() => { window.__p = window.LocalAIUI.loadInto(document.getElementById('fx'), () => new Promise(r => setTimeout(() => r(['s']), 900)), { render: (c, t) => { c.innerHTML = '<p class="row">s</p>'; return true; }, empty: 'e', what: 'runs' }); });
  assert.equal(await page.locator('#fx .state-loading').count(), 0, 'not before 300 ms');
  await page.waitForSelector('#fx .state-loading', { timeout: 700 });
  await page.waitForSelector('#fx .row');
  assert.equal(await page.locator('#fx .state-loading').count(), 0);
});
await check('a fast load never flashes the loading state', async () => {
  await fixture(page);
  const seen = await page.evaluate(async () => { const fx = document.getElementById('fx'); let s = false; const mo = new MutationObserver(() => { if (fx.querySelector('.state-loading')) s = true; }); mo.observe(fx, { childList: true, subtree: true }); await window.LocalAIUI.loadInto(fx, async () => ['q'], { render: (c, t) => { c.innerHTML = '<p>q</p>'; return true; }, empty: 'e', what: 'runs' }); await new Promise(r => setTimeout(r, 400)); return s; });
  assert.equal(seen, false);
});
await check('fetchJson rejects on non-2xx with the server error and on non-JSON', async () => {
  const r = await page.evaluate(async () => {
    const out = [];
    for (const u of ['/api/definitely-missing-route', '/index.html']) { try { await window.LocalAIUI.fetchJson(u); out.push('resolved'); } catch (e) { out.push(e.message); } }
    return out;
  });
  assert.notEqual(r[0], 'resolved'); assert.notEqual(r[1], 'resolved');
});
await check('axe: the error and loading states pass color-contrast and target-size', async () => {
  await fixture(page);
  await run('async()=>{throw new Error("boom")}');
  await page.addScriptTag({ path: axePath });
  const err = await page.evaluate(() => window.axe.run('#fx', { runOnly: { type: 'rule', values: ['color-contrast', 'target-size'] } }).then(r => r.violations.map(v => `${v.id}: ${v.nodes.map(n => n.html).join(' | ')}`)));
  assert.deepEqual(err, []);
  await fixture(page);
  await page.evaluate(() => { window.LocalAIUI.loadInto(document.getElementById('fx'), () => new Promise(() => {}), { render: () => true, empty: 'e', what: 'runs' }); });
  await page.waitForSelector('#fx .state-loading');
  const load = await page.evaluate(() => window.axe.run('#fx', { runOnly: { type: 'rule', values: ['color-contrast', 'target-size'] } }).then(r => r.violations.map(v => v.id)));
  assert.deepEqual(load, []);
});
await page.close();

for (const [api, sel, view, hint] of [['/api/library', '#libraryGrid', 'library', 'your library'], ['/api/activity', '#activityList', 'activity', 'activity']]) {
  await check(`${api} failing shows an error in ${sel}, not an empty list`, async () => {
    const p = await newPage(pg => pg.route('**' + api, r => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"disk on fire"}' })));
    await p.waitForSelector(`${sel} .state-error`, { state: 'attached' });
    const t = await p.locator(sel).innerText();
    assert.match(t, new RegExp(`Couldn't load ${hint}\\.`));
    assert.doesNotMatch(t, /Nothing saved yet|No activity yet/);
    await p.close();
  });
}
await check('library Retry recovers once the API works', async () => {
  let fail = true;
  const p = await newPage(pg => pg.route('**/api/library', r => fail ? r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"x"}' }) : r.fallback()));
  await p.waitForSelector('#libraryGrid .state-error', { state: 'attached' });
  fail = false;
  await p.locator('#libraryGrid .state-error button').evaluate(b => b.click());
  await p.waitForFunction(() => !document.querySelector('#libraryGrid .state-error'));
  assert.match(await p.locator('#libraryGrid').innerText(), /Nothing saved yet/);
  await p.close();
});

await browser.close();
if (failures.length) { console.error(`\n${failures.length} failure(s):\n- ${failures.join('\n- ')}`); process.exit(1); }
console.log('components UI checks passed');
