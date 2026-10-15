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

// ---- ask(): the approval sheet ----
const ap = await newPage();
await ap.evaluate(() => { const b = document.createElement('button'); b.id = 'opener'; b.textContent = 'open'; document.body.prepend(b); });
const openAsk = (opts) => ap.evaluate(o => { document.getElementById('opener').focus(); window.__r = undefined; window.__confirms = 0; window.LocalAIUI.ask(o).then(r => { window.__r = r; }); }, opts);
const result = () => ap.evaluate(() => window.__r);
const sheet = ap.locator('dialog.ask-sheet[open]');
const base1 = { title: 'Save a.txt?', effect: 'A backup is made first.', confirmLabel: 'Save' };
await check('ask resolves {ok:true} on Confirm and restores focus to the opener', async () => {
  await openAsk(base1);
  await sheet.waitFor();
  assert.equal(await sheet.getAttribute('aria-labelledby') !== null && await sheet.getAttribute('aria-describedby') !== null, true);
  assert.match(await sheet.innerText(), /Save a\.txt\?[\s\S]*A backup is made first\./);
  await sheet.getByRole('button', { name: 'Save' }).click();
  await ap.waitForFunction(() => window.__r);
  assert.deepEqual(await result(), { ok: true });
  assert.equal(await ap.evaluate(() => document.activeElement.id), 'opener');
  assert.equal(await ap.locator('dialog.ask-sheet').count(), 0);
});
await check('ask resolves {ok:false} on Cancel, Escape and a backdrop click', async () => {
  await openAsk(base1); await sheet.waitFor();
  assert.equal(await ap.evaluate(() => document.activeElement.textContent), 'Cancel');
  await sheet.getByRole('button', { name: 'Cancel' }).click();
  await ap.waitForFunction(() => window.__r); assert.deepEqual(await result(), { ok: false });
  await openAsk(base1); await sheet.waitFor(); await ap.keyboard.press('Escape');
  await ap.waitForFunction(() => window.__r); assert.deepEqual(await result(), { ok: false });
  assert.equal(await ap.evaluate(() => document.activeElement.id), 'opener');
  await openAsk(base1); await sheet.waitFor();
  await ap.mouse.click(5, 5);
  await ap.waitForFunction(() => window.__r); assert.deepEqual(await result(), { ok: false });
});
await check('typed:RUN keeps Confirm disabled until RUN is typed', async () => {
  await openAsk({ ...base1, confirmLabel: 'Run', tone: 'host', typed: 'RUN' }); await sheet.waitFor();
  const btn = sheet.getByRole('button', { name: 'Run' });
  assert.equal(await btn.isDisabled(), true);
  const field = sheet.locator('input');
  assert.equal(await ap.evaluate(() => document.activeElement.tagName), 'INPUT');
  await field.fill('run'); assert.equal(await btn.isDisabled(), true);
  await field.fill('RUN'); assert.equal(await btn.isDisabled(), false);
  await btn.click(); await ap.waitForFunction(() => window.__r);
  assert.deepEqual(await result(), { ok: true });
});
await check('input returns the typed value (password type is honoured)', async () => {
  await openAsk({ title: 'Approval key', confirmLabel: 'Use key', input: { label: 'Key', type: 'password', placeholder: 'paste' } }); await sheet.waitFor();
  assert.equal(await sheet.locator('input').getAttribute('type'), 'password');
  await sheet.locator('input').fill('s3cret');
  await sheet.locator('input').press('Enter');
  await ap.waitForFunction(() => window.__r);
  assert.deepEqual(await result(), { ok: true, value: 's3cret' });
});
await check('a double click on Confirm resolves once and fires one confirm', async () => {
  const n = await ap.evaluate(async () => {
    document.getElementById('opener').focus();
    let resolved = 0; const p = window.LocalAIUI.ask({ title: 'Twice?', confirmLabel: 'Go' }).then(r => { resolved++; return r; });
    const btn = [...document.querySelectorAll('dialog.ask-sheet button')].find(b => b.textContent === 'Go');
    let clicks = 0; document.querySelector('dialog.ask-sheet').addEventListener('close', () => clicks++);
    btn.click(); btn.click();
    const r = await p; await new Promise(x => setTimeout(x, 50));
    return { resolved, clicks, ok: r.ok };
  });
  assert.deepEqual(n, { resolved: 1, clicks: 1, ok: true });
});
await check('axe: the open sheet passes color-contrast and target-size at 390x844', async () => {
  await ap.addScriptTag({ path: axePath });
  for (const o of [{ ...base1 }, { title: 'Run it?', effect: 'line one\nline two', confirmLabel: 'Run', tone: 'host', typed: 'RUN' }, { title: 'Delete "x"?', confirmLabel: 'Delete', tone: 'danger' }, { title: 'Name', confirmLabel: 'Create', input: { label: 'Project name', type: 'text' } }]) {
    await openAsk(o); await sheet.waitFor();
    const v = await ap.evaluate(() => window.axe.run('dialog.ask-sheet', { runOnly: { type: 'rule', values: ['color-contrast', 'target-size'] } }).then(r => r.violations.map(v => `${v.id}: ${v.nodes.map(n => n.html).join(' | ')}`)));
    assert.deepEqual(v, [], o.title);
    await ap.waitForTimeout(300);
    const box = await sheet.boundingBox();
    assert.ok(box.width <= 390 && box.y + box.height <= 844 + 1, 'fits the phone viewport');
    await ap.keyboard.press('Escape'); await ap.waitForFunction(() => window.__r);
  }
});
await ap.close();

await browser.close();
if (failures.length) { console.error(`\n${failures.length} failure(s):\n- ${failures.join('\n- ')}`); process.exit(1); }
console.log('components UI checks passed');
