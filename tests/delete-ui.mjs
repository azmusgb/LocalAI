import './browser-target-guard.mjs';
import { chromium, devices } from 'playwright';
import assert from 'node:assert/strict';

// Deleting from Work (Select, or a run's Details), Library and a project, with Undo in the toast. The API is stubbed.
const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const browser = await chromium.launch({ headless: true });
const failures = [];
async function check(name, fn) { try { await fn(); console.log('PASS', name); } catch (e) { failures.push(`${name}: ${e.message}`); console.error('FAIL', name, e.message); } }

const iso = m => new Date(Date.now() - m * 60000).toISOString();
const RUNS = [
  { id: 'run-a', threadId: 'run-a', type: 'chat', title: 'Plan the garden', card: { kind: 'chat', title: 'Plan the garden', summary: '' }, status: 'completed', createdAt: iso(5), updatedAt: iso(5), kept: false },
  { id: 'run-b', threadId: 'run-b', type: 'chat', title: 'Heat pump prices', card: { kind: 'chat', title: 'Heat pump prices', summary: '' }, status: 'completed', createdAt: iso(9), updatedAt: iso(9), kept: false },
  { id: 'run-c', threadId: 'run-c', type: 'chat', title: 'Still answering', card: { kind: 'chat', title: 'Still answering', summary: '' }, status: 'running', createdAt: iso(1), updatedAt: iso(1), kept: false }
];

const LIBRARY = [{ id: 'lib-fox', kind: 'image', title: 'A red fox', status: 'saved', createdAt: iso(30), updatedAt: iso(30), meta: { imageUrl: '/favicon.svg' }, data: {} }];
const PROJECTS = [{ id: 'proj-garden', name: 'Garden', description: 'Beds and watering', counts: { conversations: 0, knowledge: 0, memory: 0 }, createdAt: iso(60), updatedAt: iso(60) }];
async function open(options, hash) {
  const page = await browser.newPage({ serviceWorkers: 'block', ...options });
  const calls = [];
  let gone = new Set();
  await page.addInitScript(() => { localStorage.setItem('localai.firstRun.done', '1'); });
  await page.route(u => u.pathname === '/api/runs', r => {
    const id = new URL(r.request().url()).searchParams.get('id');
    if (id) { const item = RUNS.find(x => x.id === id && !gone.has(x.threadId)); return item ? r.fulfill({ json: { item } }) : r.fulfill({ status: 404, json: { error: 'Run not found' } }); }
    return r.fulfill({ json: { items: RUNS.filter(x => !gone.has(x.threadId)), more: false } });
  });
  await page.route(u => u.pathname === '/api/library', r => r.fulfill({ json: { items: LIBRARY.filter(x => !gone.has(x.id)), counts: {}, total: 1 } }));
  await page.route(u => u.pathname === '/api/projects', r => r.fulfill({ json: { items: PROJECTS.filter(x => !gone.has(x.id)) } }));
  await page.route(u => /^\/api\/(conversations|knowledge)$/.test(u.pathname), r => r.fulfill({ json: { items: [] } }));
  await page.route(u => u.pathname === '/api/items/delete', async r => {
    const body = JSON.parse(r.request().postData()); calls.push(['delete', body]);
    if (body.items.some(x => x.id === 'run-c')) return r.fulfill({ status: 409, json: { error: '“Still answering” isn\'t finished yet. Stop it first, then delete it.' } });
    body.items.forEach(x => gone.add(x.id));
    return r.fulfill({ json: { ok: true, trashId: 't1', deleted: { runs: body.items.length, library: 0, projects: 0 } } });
  });
  await page.route(u => u.pathname === '/api/items/restore', r => { calls.push(['restore', JSON.parse(r.request().postData())]); gone = new Set(); return r.fulfill({ json: { ok: true, restored: { runs: 2, library: 0, projects: 0 } } }); });
  await page.goto(base + hash, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.showView === 'function');
  return { page, calls };
}
const titles = page => page.locator('#workList .list-row').evaluateAll(rs => rs.map(r => r.querySelector('.list-row__title')?.textContent.trim()));

for (const [name, options] of [['computer', { viewport: { width: 1280, height: 900 } }], ['phone', devices['iPhone 14']]]) {
  await check(`${name}: Select picks rows in Work, Delete removes them, Undo brings them back`, async () => {
    const { page, calls } = await open(options, '#work');
    await page.locator('#workList .list-row').first().waitFor();
    await page.locator('#workSelect').click();
    assert.equal(await page.locator('#workDeleteSelected').isDisabled(), true, 'nothing picked yet');
    await page.locator('#workList .list-row', { hasText: 'Plan the garden' }).locator('input[type="checkbox"]').check();
    await page.locator('#workList .list-row', { hasText: 'Heat pump prices' }).locator('input[type="checkbox"]').check();
    assert.equal(await page.locator('#workDeleteSelected').innerText(), 'Delete (2)');
    await page.locator('#workDeleteSelected').click();
    await page.waitForFunction(() => /Deleted 2 items/.test(document.getElementById('toast')?.textContent || ''));
    assert.deepEqual(calls[0], ['delete', { items: [{ kind: 'thread', id: 'run-a' }, { kind: 'thread', id: 'run-b' }] }]);
    await page.waitForFunction(() => ![...document.querySelectorAll('#workList .list-row__title')].some(t => /Plan the garden/.test(t.textContent)));
    assert.equal(await page.locator('#workSelect').getAttribute('aria-pressed'), 'false', 'Select mode ends after a delete');
    await page.locator('#toast button', { hasText: 'Undo' }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('#workList .list-row__title')].some(t => /Plan the garden/.test(t.textContent)));
    assert.deepEqual(calls[1], ['restore', { trashId: 't1' }]);
    assert.match(await page.locator('#toast').innerText(), /Put back/);
    await page.close();
  });

  await check(`${name}: a run that is still running says why it can't be deleted`, async () => {
    const { page } = await open(options, '#work');
    await page.locator('#workList .list-row').first().waitFor();
    await page.locator('#workSelect').click();
    await page.locator('#workList .list-row', { hasText: 'Still answering' }).locator('input[type="checkbox"]').check();
    await page.locator('#workDeleteSelected').click();
    await page.waitForFunction(() => /Stop it first/.test(document.getElementById('toast')?.textContent || ''));
    assert.ok((await titles(page)).includes('Still answering'));
    await page.close();
  });

  await check(`${name}: nothing scrolls sideways in Select mode`, async () => {
    const { page } = await open(options, '#work');
    await page.locator('#workList .list-row').first().waitFor();
    await page.locator('#workSelect').click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.close();
  });
}

await check('a run\'s Details has Delete: the run view closes and Work drops the row', async () => {
  const { page, calls } = await open({ viewport: { width: 1280, height: 900 } }, '#work');
  await page.locator('#workList .list-row', { hasText: 'Plan the garden' }).locator('.work-open').click();
  await page.locator('#runDetailsBtn').click();
  await page.waitForSelector('#runDetailsSheet[open]');
  await page.locator('#runDetailsSheet').getByRole('button', { name: 'Delete' }).click();
  await page.waitForFunction(() => /Deleted 1 item/.test(document.getElementById('toast')?.textContent || ''));
  assert.deepEqual(calls[0], ['delete', { items: [{ kind: 'thread', id: 'run-a' }] }]);
  await page.waitForSelector('#runDetailsSheet:not([open])', { state: 'attached' });
  await page.waitForFunction(() => ![...document.querySelectorAll('#workList .list-row__title')].some(t => /Plan the garden/.test(t.textContent)));
  await page.close();
});

await check('Library: × on a picture deletes it with Undo, without asking first', async () => {
  const { page, calls } = await open({ viewport: { width: 1280, height: 900 } }, '#library');
  const card = page.locator('[data-artifact="lib-fox"]');
  await card.waitFor();
  await card.locator('.delete-artifact').click();
  await page.waitForFunction(() => /Deleted 1 item/.test(document.getElementById('toast')?.textContent || ''));
  assert.deepEqual(calls[0], ['delete', { items: [{ kind: 'library', id: 'lib-fox' }] }]);
  await card.waitFor({ state: 'detached' });
  await page.locator('#toast button', { hasText: 'Undo' }).click();
  await page.locator('[data-artifact="lib-fox"]').waitFor();
  await page.close();
});

await check('a project has Delete project; its work stays, under no project', async () => {
  const { page, calls } = await open({ viewport: { width: 1280, height: 900 } }, '#projects');
  await page.locator('#projectList', { hasText: 'Garden' }).waitFor();
  await page.locator('#projectList').getByText('Garden').first().click();
  await page.locator('#projectDelete').click();
  await page.waitForFunction(() => /Deleted 1 item/.test(document.getElementById('toast')?.textContent || ''));
  assert.deepEqual(calls[0], ['delete', { items: [{ kind: 'project', id: 'proj-garden' }] }]);
  await page.waitForFunction(() => !/Garden/.test(document.getElementById('projectList')?.textContent || ''));
  await page.close();
});

await browser.close();
if (failures.length) { console.error('\nDelete failures:\n' + failures.map(x => ' - ' + x).join('\n')); process.exit(1); }
console.log('\nAll delete checks passed.');
