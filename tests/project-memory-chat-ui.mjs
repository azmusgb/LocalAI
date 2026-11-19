import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { addAxe } from './axe-helper.mjs';

// Project Memory in chat (docs/superpowers/specs/2026-11-19-project-memory-in-chat-design.md): the line under a chat
// answer ("Used N notes from <project>", a link to Projects › Memory on that project), the failed-read line, and the
// project's "Use these notes in chat" switch on the Memory tab (on, off, saving, a failed save). Axe on both views.
// The API is stubbed; the page, router and run view are the real ones. LOCALAI_SHOTS=<dir> also saves screenshots.
const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const shots = process.env.LOCALAI_SHOTS || '';
if (shots) mkdirSync(shots, { recursive: true });
const axePath = join(dirname(fileURLToPath(import.meta.url)), 'vendor', 'axe.min.js');
const browser = await chromium.launch({ headless: true });
const T = { timeout: 6000 };
const failures = [];
async function check(name, fn) {
  try { await fn(); console.log('PASS', name); } catch (error) { failures.push(`${name}: ${error.message}`); console.error('FAIL', name, error.message); }
}
const desk = { width: 1280, height: 860 }, tablet = { width: 820, height: 1180 }, phone = { width: 390, height: 844 };
const NOW = Date.now();
const THREAD = 't-' + 'b2'.repeat(16);
const LONG = 'The RIFT ten-inch closed-back tiles for the hallway wall, second printing batch';
const PROJECTS = [
  { id: 'prj_rift', name: 'RIFT tiles', description: '', createdAt: new Date(NOW - 86400e3).toISOString(), updatedAt: new Date(NOW).toISOString(), pinned: false, counts: { conversations: 1, knowledge: 0, artifacts: 0 } },
  { id: 'prj_long', name: LONG, description: '', createdAt: new Date(NOW - 86400e3).toISOString(), updatedAt: new Date(NOW).toISOString(), pinned: false, notesInChat: false, counts: { conversations: 0, knowledge: 0, artifacts: 0 } },
];
const NOTES = [
  { id: 'mem_layer', projectId: 'prj_rift', category: 'decision', text: 'Layer height is 0.2 mm', pinned: true, createdAt: new Date(NOW - 7200e3).toISOString() },
  { id: 'mem_petg', projectId: 'prj_rift', category: 'note', text: 'Tiles are PETG', pinned: false, createdAt: new Date(NOW - 3600e3).toISOString() },
];
// A ledger run the way /api/runs sends it, with its card (app/run-cards.js): route, and the notes line (memory).
const run = (n, prompt, text, memory = null) => ({
  id: `run-${NOW + n * 1000}-${n}`, type: 'chat', status: 'completed', progress: 100, threadId: THREAD, projectId: 'prj_rift',
  title: prompt.slice(0, 40), createdAt: new Date(NOW + n * 1000).toISOString(), updatedAt: new Date(NOW + n * 1000).toISOString(),
  input: { prompt, model: 'm' }, output: { text }, artifactIds: [], kept: true,
  card: { kind: 'chat', icon: 'compose', title: prompt, summary: text, badge: { label: 'Done', tone: 'good' }, preview: null, action: { label: 'Open' }, approval: null,
    route: { text: 'Answered on this PC', why: 'Project notes stay on this PC' }, memory }
});
const USED = { text: 'Used 2 notes from RIFT tiles', projectId: 'prj_rift', count: 2, unread: false };
const UNREAD = { text: "Couldn't read this project's notes", projectId: 'prj_rift', count: 0, unread: true };

// db.update: how POST /api/projects/update answers ('ok' | 'fail' | 'hold'); db.posts: what it was sent.
async function open(viewport, hash, { runs = [], update = 'ok', scheme = 'dark' } = {}) {
  const db = { runs, update, posts: [], memoryQueries: [], release: null, projects: PROJECTS.map(p => ({ ...p })) };
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport, isMobile: viewport.width < 760, hasTouch: viewport.width < 760, colorScheme: scheme, reducedMotion: 'reduce' });
  await ctx.addInitScript(s => { try { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); } } catch {} }, { 'localai.devTools': '1', 'localai.firstRun.done': '1' });
  const page = await ctx.newPage();
  page.db = db; page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  const json = (r, body, status = 200) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await ctx.route(u => u.pathname === '/api/approvals', r => json(r, { items: [] }));
  await ctx.route(u => u.pathname === '/api/activity', r => json(r, { items: [] }));
  await page.route(u => u.pathname === '/api/capabilities', r => json(r, { services: ['ollama', 'search'].map(name => ({ name, label: name, state: 'HEALTHY', required: true })), models: { defaultInstalled: true }, images: { available: true }, version: '1' }));
  await page.route(u => u.pathname === '/api/projects', r => json(r, { items: db.projects, total: db.projects.length }));
  await page.route(u => u.pathname === '/api/projects/intelligence', r => json(r, { project: db.projects[0], memory: NOTES, summary: { knowledge: 0, conversations: 1, pinnedMemory: 1 } }));
  // memoryQueries: the notes list's reads (app.js always names a projectId). Memory's facts group (owner-facts.js) reads
  // /api/memory without one, for the facts and the shared notes it may offer as facts; that read is not the list's.
  await page.route(u => u.pathname === '/api/memory', r => { const q = new URL(r.request().url()).searchParams, p = q.get('projectId') || ''; if (q.has('projectId')) db.memoryQueries.push(p); json(r, { items: NOTES.filter(n => n.projectId === p) }); });
  await page.route(u => u.pathname === '/api/memory/add', r => { const b = JSON.parse(r.request().postData()); db.adds = [...(db.adds || []), b]; json(r, { item: { id: 'mem_new', ...b, pinned: false, createdAt: new Date().toISOString() } }, 201); });
  await page.route(u => u.pathname === '/api/projects/update', async r => {
    const b = JSON.parse(r.request().postData()); db.posts.push(b);
    if (db.update === 'fail') return json(r, { error: 'Storage is busy' }, 500);
    if (db.update === 'hold') await new Promise(res => { db.release = res; });
    const p = db.projects.find(x => x.id === b.id); if (typeof b.notesInChat === 'boolean') p.notesInChat = b.notesInChat;
    json(r, { item: p });
  });
  await page.route(u => u.pathname === '/api/runs', r => {
    const q = new URL(r.request().url()).searchParams;
    if (q.get('id')) { const it = db.runs.find(x => x.id === q.get('id')); return it ? json(r, { item: it }) : json(r, { error: 'Run not found' }, 404); }
    if (q.get('threadId')) return json(r, { items: db.runs.filter(x => x.threadId === q.get('threadId')), summary: {} });
    json(r, { items: db.runs, summary: {} });
  });
  await page.goto(base + '/' + hash, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.showView === 'function' && window.LocalAIRouter && window.LocalAIRuns && location.hash, null, { timeout: 8000 });
  return page;
}
async function axe(page, scope) {
  await addAxe(page, axePath);
  return page.evaluate(sel => window.axe.run(sel, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] } })
    .then(r => r.violations.filter(x => ['serious', 'critical'].includes(x.impact)).map(x => `${x.id}: ${x.nodes.slice(0, 3).map(n => n.target.join(' ')).join(' | ')}`)), scope);
}
const shot = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`), fullPage: name.startsWith('memory') }); };
const openRun = async (page, id) => { await page.evaluate(i => window.LocalAIRuns.show(i), id); await page.locator('#runDrawer .chat-turn--assistant').first().waitFor(T); };
const openMemory = async (page, projectId = 'prj_rift') => {
  await page.evaluate(p => window.LocalAIRouter.go('#memory' + (p ? '?p=' + p : '')), projectId);
  await page.locator('#memory.active').waitFor(T);
  if (projectId) await page.waitForFunction(p => document.getElementById('memoryProject')?.value === p && !document.getElementById('memoryChat').hidden, projectId, T);
};

for (const [viewport, scheme] of [[desk, 'dark'], [phone, 'light'], [phone, 'dark'], [tablet, 'light'], [tablet, 'dark'], [desk, 'light']]) {
  const tag = `${viewport.width}px ${scheme}`;
  await check(`${tag}: "Used 2 notes from RIFT tiles" sits under the answer with the route, and links to Memory on that project`, async () => {
    const runs = [run(1, 'Compare PETG and ASA', 'PETG.'), run(2, 'What layer height did we settle on?', 'It is 0.2 mm.', USED)];
    const page = await open(viewport, '#home', { runs, scheme });
    await openRun(page, runs[1].id);
    const answer = page.locator('#runDrawer .chat-turn--assistant', { hasText: 'It is 0.2 mm.' });
    await answer.locator('.run-memory').waitFor(T);
    assert.equal(await page.locator('#runDrawer .run-memory').count(), 1, 'only the turn that used notes has the line');
    assert.equal((await answer.locator('.run-route').innerText()).trim(), 'Answered on this PC. Project notes stay on this PC.');
    const link = answer.locator('.run-memory a');
    assert.equal((await link.innerText()).trim(), 'Used 2 notes from RIFT tiles');
    assert.equal(await link.getAttribute('href'), '#memory?p=prj_rift');
    assert.ok((await link.boundingBox()).height >= 44, 'the link is a 44 px target');
    assert.deepEqual(await axe(page, '#runDrawer'), []);
    await shot(page, `chat-used-${viewport.width}-${scheme}`);
    // Keyboard: the link is reachable and opens Memory filtered to the project.
    await link.focus();
    assert.equal(await link.evaluate(a => getComputedStyle(a).outlineStyle !== 'none' || a.matches(':focus-visible')), true, 'visible focus');
    await page.keyboard.press('Enter');
    await page.locator('#memory.active').waitFor(T);
    await page.waitForFunction(() => document.getElementById('memoryProject')?.value === 'prj_rift', null, T);
    await page.locator('#memoryList .memory-card', { hasText: 'Layer height is 0.2 mm' }).waitFor(T);
    assert.ok(page.db.memoryQueries.includes('prj_rift'), 'the list is read for that project');
    assert.equal(await page.locator('#memoryChat').isVisible(), true);
    assert.equal(await page.locator('#memoryChatSwitch').isChecked(), true, 'on by default');
    assert.deepEqual(await axe(page, '#memory'), []);
    await shot(page, `memory-switch-on-${viewport.width}-${scheme}`);
    assert.deepEqual(page.errors, []);
    await page.context().close();
  });
}

await check('a failed read says "Couldn\'t read this project\'s notes" and never "Used 0 notes"', async () => {
  const runs = [run(1, 'What layer height?', 'I cannot say from here.', UNREAD)];
  const page = await open(desk, '#home', { runs });
  await openRun(page, runs[0].id);
  const line = page.locator('#runDrawer .run-memory');
  await line.waitFor(T);
  assert.match(await line.getAttribute('class'), /ui-notice--warn/);
  assert.match(await line.innerText(), /^Couldn't read this project's notes\. This answer was written without them\. Open Memory$/);
  assert.doesNotMatch(await page.locator('#runDrawer').innerText(), /Used \d+ notes?|no notes/i);
  assert.equal(await line.locator('a').getAttribute('href'), '#memory?p=prj_rift');
  assert.deepEqual(await axe(page, '#runDrawer'), []);
  await shot(page, 'chat-unread-1280-dark');
  await page.context().close();
});

await check('a line without a usable project id links to Memory itself, never to "undefined"', async () => {
  const runs = [run(1, 'What layer height?', 'It is 0.2 mm.', { text: 'Used 1 note from RIFT tiles', count: 1, unread: false }), run(2, 'And infill?', '15%.', { ...USED, projectId: 'bad id"><b>' })];
  const page = await open(desk, '#home', { runs });
  await openRun(page, runs[0].id);
  await page.locator('#runDrawer .run-memory a').nth(1).waitFor(T);
  assert.deepEqual(await page.locator('#runDrawer .run-memory a').evaluateAll(as => as.map(a => a.getAttribute('href'))), ['#memory', '#memory']);
  await page.context().close();
});

await check('an answer that used no notes has no line', async () => {
  const runs = [run(1, 'Compare PETG and ASA', 'PETG.')];
  const page = await open(desk, '#home', { runs });
  await openRun(page, runs[0].id);
  assert.equal(await page.locator('#runDrawer .run-memory').count(), 0);
  await page.context().close();
});

await check('the switch: off is saved, said, and kept with focus on the switch; on again', async () => {
  const page = await open(desk, '#home');
  await openMemory(page);
  const cb = page.locator('#memoryChatSwitch');
  assert.equal(await cb.isChecked(), true);
  assert.match(await page.locator('#memoryChatHint').innerText(), /answered on this PC with its pinned and newest notes/);
  await cb.focus();
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.getElementById('memoryChatHint').textContent.includes('without these notes'), null, T);
  assert.deepEqual(page.db.posts, [{ id: 'prj_rift', notesInChat: false }]);
  assert.equal(await cb.isChecked(), false);
  assert.equal(await cb.evaluate(el => document.activeElement === el), true, 'focus stays on the switch');
  assert.equal(await page.locator('#memoryChatError').isHidden(), true);
  await page.getByText('Turned off notes in chat for RIFT tiles').first().waitFor(T);
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.getElementById('memoryChatSwitch').checked && !document.getElementById('memoryChatSwitch').disabled, null, T);
  assert.deepEqual(page.db.posts.at(-1), { id: 'prj_rift', notesInChat: true });
  await page.context().close();
});

await check('the switch while saving: disabled and "Saving…", then settled', async () => {
  const page = await open(desk, '#home', { update: 'hold' });
  await openMemory(page);
  await page.locator('#memoryChatSwitch').click();
  await page.waitForFunction(() => document.getElementById('memoryChatSwitch').disabled, null, T);
  assert.equal((await page.locator('#memoryChatHint').innerText()).trim(), 'Saving…');
  await shot(page, 'memory-switch-saving-1280-dark');
  page.db.release();
  await page.waitForFunction(() => !document.getElementById('memoryChatSwitch').disabled, null, T);
  assert.equal(await page.locator('#memoryChatSwitch').isChecked(), false);
  await page.context().close();
});

await check('a failed save puts the switch back, says why beside it, and keeps saying it until a save works', async () => {
  const page = await open(phone, '#home', { update: 'fail', scheme: 'light' });
  await openMemory(page);
  await page.locator('#memoryChatSwitch').click();
  const err = page.locator('#memoryChatError');
  await err.waitFor({ state: 'visible', ...T });
  assert.equal(await err.getAttribute('role'), 'alert');
  assert.match(await err.innerText(), /^Couldn't save the switch: Storage is busy\. It is still on; try again\.$/);
  assert.equal(await page.locator('#memoryChatSwitch').isChecked(), true, 'back to what is saved');
  assert.match(await page.locator('#memoryChatHint').innerText(), /with its pinned and newest notes/);
  assert.deepEqual(await axe(page, '#memory'), []);
  await shot(page, 'memory-switch-failed-390-light');
  // It stays with that project's switch until a save works: away to another project and back.
  await page.locator('#memoryProject').selectOption('prj_long');
  await err.waitFor({ state: 'hidden', ...T });
  await page.locator('#memoryProject').selectOption('prj_rift');
  await err.waitFor({ state: 'visible', ...T });
  assert.match(await err.innerText(), /^Couldn't save the switch: Storage is busy\./);
  page.db.update = 'ok';
  await page.locator('#memoryChatSwitch').click();
  await err.waitFor({ state: 'hidden', ...T });
  assert.equal(await page.locator('#memoryChatSwitch').isChecked(), false);
  await page.context().close();
});

await check('a project whose switch is off shows it off; Shared (no project) has no switch; a long name does not overflow', async () => {
  const page = await open(phone, '#home');
  await openMemory(page, 'prj_long');
  assert.equal(await page.locator('#memoryChatSwitch').isChecked(), false);
  assert.match(await page.locator('#memoryChatHint').innerText(), /without these notes/);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no horizontal overflow');
  const before = page.db.memoryQueries.length;
  await page.locator('#memoryProject').selectOption('');
  for (let i = 0; i < 60 && !page.db.memoryQueries.slice(before).includes(''); i++) await page.waitForTimeout(50);
  assert.ok(page.db.memoryQueries.slice(before).includes(''), 'the Shared list is read');
  await page.waitForTimeout(200);
  assert.equal(await page.locator('#memoryProject').inputValue(), '', 'Shared stays chosen (it does not snap back to the linked project)');
  assert.equal(await page.locator('#memoryChat').isVisible(), false, 'no switch for Shared notes');
  assert.match(page.url(), /#memory$/, 'the address follows the picker');
  await page.locator('#memoryForm .phone-fold__toggle').click().catch(() => {});
  await page.locator('#memoryText').fill('A shared note');
  await page.locator('#memoryAddBtn').click();
  for (let i = 0; i < 60 && !page.db.adds; i++) await page.waitForTimeout(50);
  assert.equal(page.db.adds?.[0]?.projectId, '', 'Save memory files it as Shared');
  assert.equal(await page.locator('#memoryProject').inputValue(), '', 'still Shared after saving');
  // Leaving Memory and coming back by its tab keeps Shared: the project the link opened is forgotten once you choose.
  await page.evaluate(() => window.LocalAIRouter.go('#knowledge'));
  await page.locator('#knowledge.active').waitFor(T);
  const back = page.db.memoryQueries.length;
  await page.evaluate(() => window.LocalAIRouter.go('#memory'));
  await page.locator('#memory.active').waitFor(T);
  for (let i = 0; i < 60 && page.db.memoryQueries.length === back; i++) await page.waitForTimeout(50);
  assert.equal(page.db.memoryQueries.at(-1), '', 'the Shared list is read again');
  assert.equal(await page.locator('#memoryProject').inputValue(), '', 'Shared after returning by the tab');
  assert.equal(await page.locator('#memoryChat').isVisible(), false);
  assert.deepEqual(page.db.posts, [], 'the switch was never sent for a project');
  await page.locator('#memoryProject').selectOption('prj_rift');
  await page.waitForFunction(() => !document.getElementById('memoryChat').hidden, null, T);
  assert.match(page.url(), /#memory\?p=prj_rift$/);
  await page.context().close();
});

await check('a link to a deleted project says it no longer exists, and does not pretend to be Shared', async () => {
  const runs = [run(1, 'What layer height?', 'It is 0.2 mm.', { ...USED, projectId: 'prj_gone' })];
  const page = await open(phone, '#home', { runs, scheme: 'light' });
  // First a real project, so "What it knows" has counts that must not carry over.
  await openMemory(page, 'prj_rift');
  await page.locator('#projectIntel .home-insight').waitFor(T);
  await openRun(page, runs[0].id);
  await page.locator('#runDrawer .run-memory a').click();
  await page.locator('#memory.active').waitFor(T);
  const gone = page.locator('#memoryGone');
  await gone.waitFor(T);
  assert.match(await gone.getAttribute('class'), /ui-notice--warn/);
  assert.match(await gone.innerText(), /no longer exists/);
  assert.equal((await page.locator('#memoryProject option:checked').innerText()).trim(), 'Project no longer exists');
  assert.ok(!page.db.memoryQueries.includes(''), 'Shared notes are not shown in its place');
  assert.equal(await page.locator('#memoryList .memory-card').count(), 0);
  assert.equal(await page.locator('#memoryChat').isVisible(), false);
  assert.equal(await page.locator('#projectIntel .home-insight').count(), 0, "the previous project's counts are gone");
  assert.match(await page.locator('#projectIntel').innerText(), /Choose a project to see what the assistant remembers/);
  assert.equal(await page.locator('#memoryAddBtn').isDisabled(), true, 'Save memory is unavailable');
  const reason = page.locator('#memoryAddReason');
  assert.equal(await reason.isVisible(), true, 'with the reason beside it');
  assert.match(await reason.innerText(), /Choose a project or Shared above/);
  assert.equal(await page.locator('#memoryAddBtn').getAttribute('aria-describedby'), 'memoryAddReason');
  assert.deepEqual(await axe(page, '#memory'), []);
  await shot(page, 'memory-gone-390-light');
  // Choosing a project goes on as normal.
  await page.locator('#memoryProject').selectOption('prj_rift');
  await page.locator('#memoryList .memory-card', { hasText: 'Layer height is 0.2 mm' }).waitFor(T);
  assert.equal(await gone.count(), 0);
  assert.equal(await page.locator('#memoryAddBtn').isDisabled(), false);
  assert.equal(await reason.isHidden(), true);
  await page.context().close();
});

await check('a long project name in the line wraps inside the answer', async () => {
  const runs = [run(1, 'What layer height?', 'It is 0.2 mm.', { ...USED, text: `Used 12 notes from ${LONG}`, projectId: 'prj_long' })];
  const page = await open(phone, '#home', { runs });
  await openRun(page, runs[0].id);
  const line = page.locator('#runDrawer .run-memory');
  await line.waitFor(T);
  const [lineBox, turnBox] = await Promise.all([line.boundingBox(), page.locator('#runDrawer .chat-turn--assistant').boundingBox()]);
  assert.ok(lineBox.x + lineBox.width <= turnBox.x + turnBox.width + 1, 'the line stays inside the answer');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no horizontal overflow');
  await shot(page, 'chat-used-long-390-dark');
  await page.context().close();
});

await browser.close();
if (failures.length) { console.error('\n' + failures.length + ' failed:\n- ' + failures.join('\n- ')); process.exit(1); }
console.log('\nAll project Memory in chat checks passed');
