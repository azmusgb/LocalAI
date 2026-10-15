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
const newPage = async (setup, path = '') => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  if (setup) await setup(page);
  await page.goto(base + path, { waitUntil: 'domcontentloaded' });
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
  // Once it works, serve an empty Library so the result doesn't depend on what other suites saved on the shared server.
  const p = await newPage(pg => pg.route('**/api/library', r => fail ? r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"x"}' }) : r.fulfill({ json: { items: [] } })));
  await p.waitForSelector('#libraryGrid .state-error', { state: 'attached' });
  fail = false;
  await p.locator('#libraryGrid .state-error button').evaluate(b => b.click());
  // Wait for the re-rendered list, not just for the error to go: on a slow runner the grid is briefly empty.
  await p.waitForFunction(() => /Nothing saved yet/.test(document.querySelector('#libraryGrid')?.innerText || ''), null, { timeout: 10000 });
  assert.equal(await p.locator('#libraryGrid .state-error').count(), 0);
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
const closeSheets = () => ap.evaluate(() => document.querySelectorAll('dialog.ask-sheet').forEach(d => d.close()));
await check('aria-describedby is set only when the sheet has effect text', async () => {
  await openAsk({ title: 'No detail?', confirmLabel: 'Go' }); await sheet.waitFor();
  assert.equal(await sheet.getAttribute('aria-describedby'), null);
  await sheet.getByRole('button', { name: 'Cancel' }).click(); await ap.waitForFunction(() => window.__r);
  await openAsk(base1); await sheet.waitFor();
  const id = await sheet.getAttribute('aria-describedby');
  assert.ok(id, 'has aria-describedby');
  assert.equal(await ap.locator('#' + id).isVisible(), true);
  await sheet.getByRole('button', { name: 'Cancel' }).click(); await ap.waitForFunction(() => window.__r);
});
await closeSheets();
await check('computer batch confirmation says how many operations are not listed', async () => {
  await ap.evaluate(() => { document.getElementById('computerBatch').value = JSON.stringify([1,2,3,4,5].map(i => ({ op: 'mkdir', path: 'd' + i }))); document.getElementById('computerRunBtn').click(); });
  await sheet.waitFor();
  const t = await sheet.locator('.ask-sheet__effect').innerText();
  assert.match(t, /d3/); assert.doesNotMatch(t, /d4/); assert.match(t, /\+2 more/);
  await closeSheets();
});
await closeSheets();
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
await check('ask select returns the chosen option value (Not filed gives an empty string)', async () => {
  await openAsk({ title: 'File this run', confirmLabel: 'File', select: { label: 'Project', options: [{ value: '', label: 'Not filed' }, { value: 'prj_a', label: 'Alpha' }, { value: 'prj_b', label: 'Beta' }] } }); await sheet.waitFor();
  assert.equal(await sheet.locator('input').count(), 0);
  await sheet.locator('select').selectOption('prj_b');
  await sheet.getByRole('button', { name: 'File' }).click();
  await ap.waitForFunction(() => window.__r);
  assert.deepEqual(await result(), { ok: true, value: 'prj_b' });
  await openAsk({ title: 'File this run', confirmLabel: 'File', select: { label: 'Project', options: [{ value: '', label: 'Not filed' }, { value: 'prj_a', label: 'Alpha' }] } }); await sheet.waitFor();
  await sheet.getByRole('button', { name: 'File' }).click();
  await ap.waitForFunction(() => window.__r);
  assert.deepEqual(await result(), { ok: true, value: '' });
});
await ap.close();

// ---- run card and run view (the /api/runs list is stubbed) ----
const PIX = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#357"/></svg>');
const now = new Date().toISOString();
const stubRuns = () => [
  { id: 'run_img', type: 'image', title: 'Sunset poster', status: 'completed', progress: 100, updatedAt: now, createdAt: now, summary: 'One image', output: { images: [{ imageUrl: PIX }] }, events: [{ status: 'completed', at: now, detail: 'Image saved' }], pinned: false, projectId: null,
    card: { kind: 'image', icon: 'image', title: 'Sunset poster', summary: 'One image', badge: { label: 'Done', tone: 'good' }, preview: { type: 'image', src: PIX, count: 1 }, action: { label: 'Open' }, approval: null, view: 'create' } },
  { id: 'run_eng', type: 'engineering', title: 'Fix the login bug', status: 'awaiting_approval', progress: 40, updatedAt: now, createdAt: now, summary: 'Two files change', output: 'planned', events: [{ status: 'awaiting_approval', at: now, detail: 'Waiting for review' }], pinned: false, projectId: null,
    card: { kind: 'engineering', icon: 'build', title: 'Fix the login bug', summary: 'Two files change', badge: { label: 'Ready to review', tone: 'accent' }, preview: { type: 'diff', changeId: 'chg_1', files: [{ path: 'app/auth.js', added: 12, removed: 3 }, { path: 'app/login.html', added: 2, removed: 0 }] }, action: { label: 'Review' }, approval: { id: 'apr_1', title: 'Apply the login fix', detail: 'Edits 2 files', risk: 'high' }, view: 'changes' } }
];
const rv = { posts: [], runs: stubRuns(), fail: null };
const live = { id: 'run_live', type: 'image', title: 'Moonrise render', status: 'running', progress: 45, updatedAt: now, createdAt: now, summary: '', output: null, events: [], pinned: false, projectId: null, cancellable: true,
  card: { kind: 'image', icon: 'image', title: 'Moonrise render', summary: '', badge: { label: 'Running', tone: 'accent' }, preview: null, action: { label: 'Open' }, approval: null, view: 'create' } };
const stubSetup = async pg => {
  await pg.route(u => u.pathname === '/api/runs', r => {
    const id = new URL(r.request().url()).searchParams.get('id');
    if (!id) return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: rv.runs, summary: {} }) });
    const item = [...rv.runs, live].find(x => x.id === id);
    r.fulfill({ status: item ? 200 : 404, contentType: 'application/json', body: JSON.stringify(item ? { item } : { error: 'Run not found' }) });
  });
  await pg.route('**/api/projects', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: [{ id: 'prj_a', name: 'Alpha' }, { id: 'prj_b', name: 'Beta' }] }) }));
  await pg.route(u => ['/api/runs/update', '/api/approvals/decide'].includes(u.pathname), r => {
    const body = JSON.parse(r.request().postData() || '{}'); rv.posts.push([new URL(r.request().url()).pathname, body]);
    if (rv.fail && new URL(r.request().url()).pathname === '/api/runs/update') return r.fulfill({ status: rv.fail.status, contentType: 'application/json', body: JSON.stringify({ error: rv.fail.error }) });
    if (new URL(r.request().url()).pathname === '/api/runs/update') { const i = rv.runs.findIndex(x => x.id === body.id); const { pinned, projectId } = body; rv.runs[i] = { ...rv.runs[i], ...(pinned !== undefined ? { pinned } : {}), ...(projectId !== undefined ? { projectId } : {}) }; return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ item: rv.runs[i] }) }); }
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ item: { id: body.id, status: body.decision } }) });
  });
};
const runPage = await newPage(stubSetup);
await runPage.waitForSelector('.navbtn[data-view="runs"]', { state: 'attached' });
await runPage.evaluate(() => document.querySelector('.navbtn[data-view="runs"]').click());
await runPage.waitForSelector('#runList .list-row');
const drawerOpen = () => runPage.locator('#runDrawerBackdrop.show #runDrawer');
const openRun = async id => { await runPage.locator(`#runList .list-row[data-run-id="${id}"] button.btn-primary`).click(); await drawerOpen().waitFor(); };
const dsheet = () => runPage.locator('#runDetailsSheet');
const openSheet = async () => { await drawerOpen().getByRole('button', { name: 'Details' }).click(); await runPage.waitForSelector('#runDetailsSheet[open]'); };
const closeRun = async () => { if (await runPage.locator('#runDetailsSheet[open]').count()) await runPage.keyboard.press('Escape'); await runPage.keyboard.press('Escape'); await runPage.waitForSelector('#runDrawerBackdrop:not(.show)', { state: 'attached' }); };
await check('Runs shows one card per run: thumbnail, diff stat and the Review action', async () => {
  assert.equal(await runPage.locator('#runList .list-row').count(), 2);
  assert.equal(await runPage.locator('#runList .list-row[data-run-id="run_img"] .list-row__icon svg use').getAttribute('href'), '#i-image');
  assert.equal(await runPage.locator('#runList .list-row[data-run-id="run_img"] img').getAttribute('src'), PIX);
  const eng = runPage.locator('#runList .list-row[data-run-id="run_eng"]');
  assert.equal(await eng.locator('button.btn-primary').innerText(), 'Review');
  assert.match(await eng.innerText(), /Fix the login bug[\s\S]*2 files[\s\S]*\+14[\s\S]*-3[\s\S]*Review[\s\S]*Ready to review/);
  assert.equal(await eng.locator('.badge.badge--accent').count(), 1);
});
await check('opening a run shows header, Not filed, Pin and File, then the approval bar before Timeline', async () => {
  await openRun('run_eng');
  const d = drawerOpen();
  const t = await d.innerText();
  assert.match(t, /Fix the login bug/); assert.match(t, /Engineering · Not filed/);
  assert.equal(await d.getByRole('button', { name: 'Pin' }).count(), 0, 'Pin lives in the details sheet');
  assert.equal(await d.locator('.run-approval').count(), 1);
  assert.match(await d.locator('.run-approval').innerText(), /Apply the login fix[\s\S]*High risk/);
  assert.ok(t.indexOf('Apply the login fix') < t.indexOf('Output'));
  assert.doesNotMatch(t, /Timeline/);
  await openSheet();
  const sh = dsheet();
  assert.equal(await sh.getByRole('button', { name: 'Pin' }).count(), 1);
  assert.equal(await sh.getByRole('button', { name: 'File…' }).count(), 1);
  assert.match(await sh.innerText(), /Timeline/);
  await runPage.keyboard.press('Escape'); await runPage.waitForSelector('#runDetailsSheet:not([open])', { state: 'attached' });
  assert.equal(await runPage.locator('#runList .list-row[data-run-id="run_img"]').count(), 1);
});
await check('axe: the open run view passes color-contrast and target-size', async () => {
  await runPage.addScriptTag({ path: axePath });
  await openSheet();
  for (const sel of ['#runDrawer', '#runDetailsSheet', '#runList']) {
    const v = await runPage.evaluate(s => window.axe.run(s, { runOnly: { type: 'rule', values: ['color-contrast', 'target-size'] } }).then(r => r.violations.map(v => `${v.id}: ${v.nodes.map(n => n.html).join(' | ')}`)), sel);
    assert.deepEqual(v, [], sel);
  }
  await runPage.keyboard.press('Escape'); await runPage.waitForSelector('#runDetailsSheet:not([open])', { state: 'attached' });
});
await check('Approve is a plain confirm (no typed word) and POSTs the decision once', async () => {
  rv.posts.length = 0;
  await drawerOpen().getByRole('button', { name: 'Approve' }).click();
  const dlg = runPage.locator('dialog.ask-sheet[open]'); await dlg.waitFor();
  assert.equal(await dlg.locator('input').count(), 0);
  await dlg.getByRole('button', { name: 'Approve' }).click();
  await runPage.waitForFunction(() => !document.querySelector('dialog.ask-sheet'));
  await runPage.waitForTimeout(150);
  assert.deepEqual(rv.posts.filter(p => p[0] === '/api/approvals/decide'), [['/api/approvals/decide', { id: 'apr_1', decision: 'approved' }]]);
  assert.equal(await drawerOpen().count(), 1, 'Escape on the sheet does not close the run view');
});
await check('Cancelling the Reject confirm posts nothing; Escape closes only the sheet', async () => {
  rv.posts.length = 0;
  await drawerOpen().getByRole('button', { name: 'Reject' }).click();
  await runPage.locator('dialog.ask-sheet[open]').waitFor();
  await runPage.keyboard.press('Escape');
  await runPage.waitForFunction(() => !document.querySelector('dialog.ask-sheet'));
  assert.deepEqual(rv.posts, []);
  assert.equal(await drawerOpen().count(), 1);
});
await check('Pin POSTs /api/runs/update {pinned:true} and the button becomes Unpin', async () => {
  rv.posts.length = 0;
  await openSheet();
  await dsheet().getByRole('button', { name: 'Pin', exact: true }).click();
  await dsheet().getByRole('button', { name: 'Unpin' }).waitFor();
  assert.deepEqual(rv.posts, [['/api/runs/update', { id: 'run_eng', pinned: true }]]);
});
await check('File… picks a project in a select and shows its name', async () => {
  rv.posts.length = 0;
  await dsheet().getByRole('button', { name: 'File…' }).click();
  const dlg = runPage.locator('dialog.ask-sheet[open]'); await dlg.waitFor();
  assert.deepEqual(await dlg.locator('select option').allInnerTexts(), ['Not filed', 'Alpha', 'Beta']);
  await dlg.locator('select').selectOption('prj_b');
  await dlg.getByRole('button', { name: 'File', exact: true }).click();
  await drawerOpen().getByText('Beta').waitFor();
  assert.deepEqual(rv.posts, [['/api/runs/update', { id: 'run_eng', projectId: 'prj_b' }]]);
  assert.doesNotMatch(await drawerOpen().innerText(), /Not filed/);
});
await check('a body registered for a kind mounts in place of Output', async () => {
  await closeRun();
  await runPage.evaluate(() => window.LocalAIUI.registerRunBody('image', (run, el) => { el.innerHTML = `<div id="imgBody">gallery for ${run.id}</div>`; }));
  await openRun('run_img');
  const d = drawerOpen();
  assert.match(await d.locator('#imgBody').innerText(), /gallery for run_img/);
  assert.doesNotMatch(await d.innerText(), /Output/);
  await closeRun();
  await openRun('run_eng');
  assert.match(await drawerOpen().innerText(), /Output/);
  await closeRun();
});
await check('LocalAIRuns.open still returns false for an unknown id', async () => {
  assert.equal(await runPage.evaluate(() => window.LocalAIRuns.open('nope')), false);
});
const refreshRuns = async () => { await runPage.evaluate(() => document.getElementById('runsRefresh').click()); await runPage.waitForTimeout(300); };
await check('a failed Pin shows its message visibly in the run view', async () => {
  rv.fail = { status: 409, error: 'This run is managed by its own page and cannot be filed yet' };
  await openRun('run_img'); await openSheet();
  await dsheet().getByRole('button', { name: 'Pin', exact: true }).click();
  const msg = dsheet().locator('.run-view-error');
  await msg.waitFor();
  assert.match(await msg.innerText(), /managed by its own page/);
  assert.equal(await msg.isVisible(), true);
  rv.fail = null; await closeRun();
});
await check('a legacy run offers no Pin or File… and says it is managed elsewhere', async () => {
  rv.runs.push({ ...rv.runs[0], id: 'legacy-agent:1', title: 'Old agent run' }); await refreshRuns();
  await openRun('legacy-agent:1'); await openSheet();
  const d = dsheet();
  assert.equal(await d.getByRole('button', { name: /^(Pin|Unpin)$/ }).count(), 0);
  assert.equal(await d.getByRole('button', { name: 'File…' }).count(), 0);
  assert.match(await d.innerText(), /Managed on its own page/);
  await closeRun();
});
await check('a filed run shows its project name, and Project removed when it is gone', async () => {
  rv.runs.find(x => x.id === 'run_img').projectId = 'prj_a'; await refreshRuns();
  await openRun('run_img');
  await drawerOpen().locator('.run-view-project', { hasText: 'Alpha' }).waitFor();
  await closeRun();
  rv.runs.find(x => x.id === 'run_img').projectId = 'prj_gone'; await refreshRuns();
  await openRun('run_img');
  await drawerOpen().locator('.run-view-project', { hasText: 'Project removed' }).waitFor();
  await closeRun();
});
await check('a run with no start or finish time shows dashes, never 1969', async () => {
  await openRun('run_eng'); await openSheet();
  const t = await dsheet().innerText();
  assert.doesNotMatch(t, /1969|1970/);
  assert.match(await dsheet().locator('.run-detail', { hasText: 'Started' }).innerText(), /—/);
  await closeRun();
});
await check('opening a run is routing: the hash is #run/<id>', async () => {
  await openRun('run_img');
  assert.equal(await runPage.evaluate(() => location.hash), '#run/run_img');
});
await check('phone: the run view fills the viewport and covers the tab bar', async () => {
  const box = await runPage.locator('#runDrawer').boundingBox();
  assert.deepEqual([box.x, box.y, box.width, box.height], [0, 0, 390, 844]);
  assert.equal(await runPage.evaluate(() => { const n = document.getElementById('uxMobileNav'); if (!n) return 'no nav'; const r = n.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !!hit.closest('#runDrawer'); }), true);
});
await check('desktop: the run view is a right-side panel, at most 820 wide', async () => {
  await runPage.setViewportSize({ width: 1280, height: 860 });
  const box = await runPage.locator('#runDrawer').boundingBox();
  assert.ok(box.width <= 820 && box.width >= 700, `width ${box.width}`);
  assert.equal(Math.round(box.x + box.width), 1280);
  await runPage.setViewportSize({ width: 390, height: 844 });
});
await check('details grid and Timeline are hidden until the info button is pressed, then sit in the sheet', async () => {
  assert.equal(await runPage.locator('#runDrawer .run-detail-grid').count(), 0);
  assert.equal(await runPage.locator('.run-detail-grid').first().isVisible(), false);
  assert.equal(await runPage.getByText('Timeline', { exact: true }).first().isVisible(), false);
  await openSheet();
  assert.equal(await runPage.locator('#runDetailsSheet .run-detail-grid').isVisible(), true);
  assert.equal(await runPage.locator('#runDetailsSheet').getByText('Timeline', { exact: true }).isVisible(), true);
  assert.equal(await dsheet().getByRole('button', { name: 'Pin' }).isVisible(), true);
  assert.equal(await dsheet().getByRole('button', { name: 'File…' }).isVisible(), true);
});
await check('Escape closes the sheet first, then the run view', async () => {
  await runPage.keyboard.press('Escape'); await runPage.waitForSelector('#runDetailsSheet:not([open])', { state: 'attached' });
  assert.equal(await drawerOpen().count(), 1);
  await runPage.keyboard.press('Escape'); await runPage.waitForSelector('#runDrawerBackdrop:not(.show)', { state: 'attached' });
  assert.doesNotMatch(await runPage.evaluate(() => location.hash), /run\//);
});
await check('history.back() closes the run view, and the back button does the same', async () => {
  await openRun('run_img');
  await runPage.evaluate(() => history.back());
  await runPage.waitForSelector('#runDrawerBackdrop:not(.show)', { state: 'attached' });
  await openRun('run_img');
  await drawerOpen().getByRole('button', { name: 'Back' }).click();
  await runPage.waitForSelector('#runDrawerBackdrop:not(.show)', { state: 'attached' });
});
await check('the More menu holds Cancel run and Retry', async () => {
  await openRun('run_img');
  await drawerOpen().getByRole('button', { name: 'More' }).click();
  assert.equal(await runPage.getByRole('menuitem', { name: 'Cancel run' }).count(), 1);
  assert.equal(await runPage.getByRole('menuitem', { name: 'Retry' }).count(), 1);
  await runPage.keyboard.press('Escape'); await closeRun();
});
await check('reloading on #run/<running image run> reopens it with its progress bar', async () => {
  await runPage.goto(base + '/#run/run_live'); await runPage.reload();
  await runPage.waitForSelector('#runDrawerBackdrop.show #runDrawer [role="progressbar"]');
  assert.match(await drawerOpen().innerText(), /Moonrise render/);
  await drawerOpen().getByRole('button', { name: 'Back' }).click();
  await runPage.waitForFunction(() => location.hash === '#home');
  assert.equal(await drawerOpen().count(), 0);
});
await check('a missing run says so and offers Open Work; no page error', async () => {
  const errors = [];
  const mp = await newPage(stubSetup, '/#run/run-missing'); mp.on('pageerror', e => errors.push(e.message));
  await mp.waitForSelector('#runDrawerBackdrop.show');
  await mp.getByText('This run is no longer available').waitFor();
  await mp.locator('#runDrawer .btn-outline', { hasText: 'Open Work' }).click();
  await mp.waitForFunction(() => location.hash === '#work');
  assert.deepEqual(errors, []);
  await mp.close();
});
await check('openPending shows Starting…, resolve swaps the hash without a new history entry, fail offers Close', async () => {
  await runPage.evaluate(() => { window.__h = window.LocalAIRuns.openPending({ kind: 'image', title: 'Sunset poster' }); });
  await runPage.waitForSelector('#runDrawerBackdrop.show');
  const t = await drawerOpen().innerText();
  assert.match(t, /Starting…/); assert.match(t, /Sunset poster/);
  assert.equal(await runPage.evaluate(() => location.hash), '#run/pending');
  const len = await runPage.evaluate(() => history.length);
  await runPage.evaluate(() => window.__h.resolve('run_live'));
  await runPage.waitForFunction(() => location.hash === '#run/run_live');
  await drawerOpen().getByText('Moonrise render').waitFor();
  assert.equal(await runPage.evaluate(() => history.length), len);
  await closeRun();
  await runPage.evaluate(() => { window.__h = window.LocalAIRuns.openPending({ kind: 'chat', title: 'Question' }); });
  await runPage.waitForSelector('#runDrawerBackdrop.show');
  await runPage.evaluate(() => window.__h.fail('The model is not running.'));
  await drawerOpen().getByText('The model is not running.').waitFor();
  await drawerOpen().getByRole('button', { name: 'Close' }).click();
  await runPage.waitForSelector('#runDrawerBackdrop:not(.show)', { state: 'attached' });
});
await check('#run/pending with nothing pending goes Home: on load, and after fail, Close and Forward', async () => {
  const errors = [];
  const pp = await newPage(stubSetup, '/#run/pending'); pp.on('pageerror', e => errors.push(e.message));
  await pp.waitForFunction(() => location.hash === '#home');
  await pp.waitForSelector('#home.active');
  assert.equal(await pp.locator('#runDrawerBackdrop.show').count(), 0);
  assert.deepEqual(errors, []); await pp.close();
  await runPage.evaluate(() => window.showView('home'));
  await runPage.evaluate(() => { window.__h = window.LocalAIRuns.openPending({ kind: 'chat', title: 'Q' }); });
  await runPage.evaluate(() => window.__h.fail('x'));
  await drawerOpen().getByRole('button', { name: 'Close' }).click();
  await runPage.waitForSelector('#runDrawerBackdrop:not(.show)', { state: 'attached' });
  await runPage.evaluate(() => history.forward());
  await runPage.waitForFunction(() => location.hash === '#home');
  assert.equal(await runPage.locator('#runDrawerBackdrop.show').count(), 0);
  assert.equal(await runPage.locator('.run-spinner:visible').count(), 0);
});
await check('Forward onto a run keeps Back working: Close goes back, not Home', async () => {
  await runPage.evaluate(() => window.showView('home'));
  await runPage.evaluate(() => { location.hash = '#work'; });
  await runPage.waitForFunction(() => location.hash === '#work');
  await runPage.waitForSelector('#work.active [data-run-id="run_img"]');   // Work lists the runs; its row opens the run view
  await runPage.locator('#work [data-run-id="run_img"] button.work-open').click(); await drawerOpen().waitFor();
  await runPage.evaluate(() => history.back());
  await runPage.waitForFunction(() => location.hash === '#work');
  await runPage.evaluate(() => history.forward());
  await runPage.waitForSelector('#runDrawerBackdrop.show');
  assert.equal(await runPage.evaluate(() => location.hash), '#run/run_img');
  const len = await runPage.evaluate(() => history.length);
  await drawerOpen().getByRole('button', { name: 'Back' }).click();
  await runPage.waitForFunction(() => location.hash === '#work');
  assert.equal(await runPage.evaluate(() => history.length), len, 'Close goes back, it does not push or replace Home');
  await runPage.evaluate(() => history.forward());
  await runPage.waitForSelector('#runDrawerBackdrop.show'); // the run entry is still ahead, so Close went back
  await closeRun();
});
await check('Home run center renders the same cards', async () => {
  await runPage.evaluate(() => window.showView('home'));
  await runPage.waitForSelector('#homeRunList .list-row', { state: 'attached' }); // Home no longer shows this panel; its cards still render for the run view
  assert.equal(await runPage.locator('#homeRunList .list-row[data-run-id="run_eng"] button.btn-primary').innerText(), 'Review');
});
await runPage.close();

await browser.close();
if (failures.length) { console.error(`\n${failures.length} failure(s):\n- ${failures.join('\n- ')}`); process.exit(1); }
console.log('components UI checks passed');
