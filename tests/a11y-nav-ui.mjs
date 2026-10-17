// Keyboard and screen-reader basics for moving around: the tab title names the page, focus lands on the new page
// (not left on the menu), and the ⌘K palette is a real modal dialog that gives focus back when it closes.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const browser = await chromium.launch();
let failed = 0;
async function check(name, fn) { try { await fn(); console.log('PASS', name) } catch (e) { failed++; console.log('FAIL', name, e.message) } }
async function open(viewport = { width: 1440, height: 900 }, before = null) {
  const context = await browser.newContext({ viewport });
  await context.addInitScript(() => { localStorage.setItem('localai.firstRun.done', '1'); localStorage.setItem('localai.devTools', '1'); });
  const page = await context.newPage();
  if (before) await before(page);
  await page.goto(base + '/#home', { waitUntil: 'networkidle' });
  return { page, context };
}
const inView = (page, id) => page.evaluate(i => !!document.activeElement?.closest('#' + i), id);

await check('the first load leaves focus alone and titles the tab', async () => {
  const { page, context } = await open();
  assert.equal(await page.title(), 'Local AI');
  assert.equal(await page.evaluate(() => document.activeElement === document.body), true);
  await context.close();
});

await check('choosing a page from the menu titles the tab and moves focus to that page', async () => {
  const { page, context } = await open();
  await page.click('.ux-primary-item[data-domain="system"]');
  await page.waitForFunction(() => document.title === 'Health · Local AI');
  await page.waitForFunction(() => !!document.activeElement?.closest('#status'), null, { timeout: 2000 }).catch(() => {});
  assert.equal(await inView(page, 'status'), true, 'focus is on the Health page');
  await page.click('#uxSecondaryGroups .ux-secondary-link[data-view="models"]');
  await page.waitForFunction(() => document.title === 'Models · Local AI');
  await page.waitForFunction(() => !!document.activeElement?.closest('#models'), null, { timeout: 2000 }).catch(() => {});
  assert.equal(await inView(page, 'models'), true, 'focus is on the Models page');
  await context.close();
});

await check('switching tabs inside a page keeps focus on the tab', async () => {
  const { page, context } = await open();
  // #issues now resolves to Improve's Signals stage, so this uses Projects, which still has tabs.
  await page.evaluate(() => { location.hash = '#projects' });
  await page.waitForSelector('#projects.active .ux-tab');
  const tab = page.locator('#projects .ux-tab', { hasText: 'Sources' });
  await tab.focus(); await tab.press('Enter');
  await page.waitForFunction(() => document.title === 'Sources · Local AI');
  await page.waitForFunction(() => !!document.activeElement?.closest('#knowledge .ux-tabs'), null, { timeout: 2000 }).catch(() => {});
  assert.match(await page.evaluate(() => document.activeElement?.textContent || ''), /Sources/);
  assert.equal(await page.evaluate(() => !!document.activeElement?.closest('.ux-tabs')), true);
  await context.close();
});

await check('⌘K is a modal dialog: focus stays inside, the highlighted page opens on Enter, Escape returns focus', async () => {
  const { page, context } = await open();
  await page.focus('#uxCommandBtn');
  await page.keyboard.press('Meta+k');
  await page.waitForFunction(() => document.getElementById('cmdk')?.open === true);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'cmdkInput');
  for (let i = 0; i < 12; i++) await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => !!document.activeElement?.closest('#cmdk')), true, 'Tab stays in the palette');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.getElementById('cmdk')?.open === false);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'uxCommandBtn', 'focus returns to what opened it');

  await page.click('#uxCommandBtn');
  await page.waitForFunction(() => document.getElementById('cmdk')?.open === true);
  await page.keyboard.type('model');
  // A combobox: focus stays in the search box and the highlighted option is aria-activedescendant.
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'cmdkInput');
  assert.match(await page.evaluate(() => document.getElementById(document.getElementById('cmdkInput').getAttribute('aria-activedescendant'))?.textContent || ''), /Models/);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.title === 'Models · Local AI');
  assert.equal(await page.evaluate(() => document.getElementById('cmdk').open), false);
  await page.waitForFunction(() => !!document.activeElement?.closest('#models'), null, { timeout: 2000 }).catch(() => {});
  assert.equal(await inView(page, 'models'), true, 'focus moves to the chosen page');

  await page.keyboard.press('Control+k');
  await page.waitForFunction(() => document.getElementById('cmdk')?.open === true);
  await page.keyboard.type('health');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.title === 'Health · Local AI');
  await context.close();
});

await check('closing the run view does not pull focus to the page heading', async () => {
  const { page, context } = await open();
  const now = new Date().toISOString();
  const run = { id: 'r1', type: 'chat', title: 'Hello', status: 'completed', progress: 100, updatedAt: now, createdAt: now, summary: 'x', output: 'x', events: [], pinned: false, projectId: null,
    card: { kind: 'chat', icon: 'compose', title: 'Hello', summary: 'x', badge: { label: 'Done', tone: 'good' }, preview: { type: 'text', text: 'x' }, action: { label: 'Open' }, approval: null } };
  await page.route(u => u.pathname === '/api/runs', r => { const id = new URL(r.request().url()).searchParams.get('id'); r.fulfill({ json: id ? { item: run } : { items: [run], summary: {} } }) });
  await page.evaluate(() => { location.hash = '#work' });
  const row = page.locator('.view.active .run-card').first(); await row.waitFor();
  await row.click();
  await page.waitForFunction(() => location.hash === '#run/r1', null, { timeout: 5000 });
  await page.locator('#runDrawer button').first().focus(); // as a user tabbing into it would
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => location.hash === '#work', null, { timeout: 5000 }).catch(async () => { throw new Error('Escape did not close: ' + await page.evaluate(() => location.hash)) });
  await page.waitForTimeout(300);
  assert.notEqual(await page.evaluate(() => document.activeElement?.tagName), 'H1');
  await context.close();
});

await check('sending from Home keeps focus in the run view through the pending→run re-render, and the answer is announced', async () => {
  // Chat is available (the Chat mode is gated on the model service).
  const { page, context } = await open(undefined, p => p.route(u => u.pathname === '/api/capabilities', r => r.fulfill({ json: { services: ['ollama', 'search', 'comfy', 'n8n'].map(name => ({ name, label: name, state: 'HEALTHY', required: true })), models: { defaultInstalled: true }, images: { available: true }, version: '1' } })));
  // A controllable /api/chat/stream, as chat-run-ui.mjs stubs it: __streams[0].push(event, data) / .close().
  await page.evaluate(() => {
    const real = window.fetch.bind(window); window.__streams = [];
    window.fetch = (url, opts = {}) => {
      if (!String(url).includes('/api/chat/stream')) return real(url, opts);
      let ctl; const enc = new TextEncoder();
      const rs = new ReadableStream({ start(c) { ctl = c; } });
      window.__streams.push({ push: (ev, data) => ctl.enqueue(enc.encode(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`)), close: () => ctl.close() });
      return Promise.resolve(new Response(rs, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
    };
  });
  const now = new Date().toISOString();
  const run = { id: 'r-home-1', type: 'chat', threadId: 't-home', title: 'What is a mutex', status: 'running', progress: 10, updatedAt: now, createdAt: now, input: { prompt: 'What is a mutex' }, output: null, events: [], projectId: null,
    card: { kind: 'chat', icon: 'compose', title: 'What is a mutex', summary: '', badge: { label: 'Working', tone: 'accent' }, preview: null, action: { label: 'Open' }, approval: null } };
  await page.route(u => u.pathname === '/api/runs', r => { const q = new URL(r.request().url()).searchParams; r.fulfill({ json: q.get('id') ? { item: run } : { items: q.get('threadId') ? [run] : [], summary: {} } }) });
  await page.evaluate(() => window.LocalAIHome.setMode('ask'));
  await page.waitForFunction(() => !document.querySelector('.mode[data-mode="ask"]')?.disabled, null, { timeout: 4000 });
  await page.locator('#commandInput').fill('What is a mutex');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => location.hash === '#run/pending', null, { timeout: 4000 });
  await page.waitForTimeout(300);
  assert.equal(await inView(page, 'runDrawer'), true, 'focus is in the run view while it says Starting…');
  await page.evaluate(() => { window.__streams[0].push('meta', { runId: 'r-home-1', threadId: 't-home' }); window.__streams[0].push('token', { text: 'A mutex is a lock.' }); });
  await page.waitForFunction(() => location.hash === '#run/r-home-1', null, { timeout: 4000 });
  await page.waitForTimeout(300);
  assert.equal(await inView(page, 'runDrawer'), true, 'focus stays in the run view after the pending→run re-render');
  assert.notEqual(await page.evaluate(() => document.activeElement?.tagName), 'BODY');
  await page.evaluate(() => { window.__streams[0].push('done', { elapsedMs: 1 }); window.__streams[0].close(); });
  await page.waitForFunction(() => document.getElementById('runLiveRegion')?.textContent === 'Answer ready.', null, { timeout: 4000 });
  assert.equal(await inView(page, 'runDrawer'), true, 'focus is still in the run view when the answer is ready');
  await context.close();
});

// ---- Semantics (critique §3.8) ----
const active = page => page.evaluate(() => { const a = document.activeElement; return a ? { id: a.id, tab: a.dataset?.uxTab || '', mode: a.dataset?.homeMode || '', text: (a.textContent || '').trim() } : null; });

await check('page tabs: one tab stop, arrows/Home/End move between tabs, each tab names the page it controls', async () => {
  const { page, context } = await open();
  await page.evaluate(() => { location.hash = '#projects' });
  await page.waitForSelector('#projects.active .ux-tab');
  const tabs = page.locator('#projects .ux-tab');
  assert.deepEqual(await tabs.evaluateAll(ts => ts.map(t => t.tabIndex)), [0, -1, -1, -1], 'only the selected tab is in the Tab order');
  assert.deepEqual(await tabs.evaluateAll(ts => ts.map(t => t.getAttribute('aria-controls'))), ['projects', 'knowledge', 'memory', 'library']);
  await tabs.first().focus();
  await page.keyboard.press('ArrowRight');
  await page.waitForSelector('#knowledge.active');
  await page.waitForFunction(() => document.activeElement?.closest('#knowledge') && document.activeElement.dataset.uxTab === 'knowledge', null, { timeout: 2000 });
  assert.deepEqual(await page.locator('#knowledge .ux-tab').evaluateAll(ts => ts.map(t => t.tabIndex)), [-1, 0, -1, -1]);
  await page.keyboard.press('End');
  await page.waitForSelector('#library.active');
  await page.waitForFunction(() => document.activeElement?.closest('#library') && document.activeElement.dataset.uxTab === 'library', null, { timeout: 2000 });
  await page.keyboard.press('ArrowRight'); // wraps
  await page.waitForSelector('#projects.active');
  await page.waitForFunction(() => document.activeElement?.closest('#projects') && document.activeElement.dataset.uxTab === 'projects', null, { timeout: 2000 });
  await page.keyboard.press('ArrowLeft'); // wraps back to the last tab
  await page.waitForSelector('#library.active');
  await page.waitForFunction(() => document.activeElement?.closest('#library') && document.activeElement.dataset.uxTab === 'library', null, { timeout: 2000 });
  await page.keyboard.press('Home');
  await page.waitForSelector('#projects.active');
  await page.waitForFunction(() => document.activeElement?.dataset?.uxTab === 'projects', null, { timeout: 2000 });
  await context.close();
});

await check('Home mode sheet: the modes are one radio group; arrows choose, Tab leaves it', async () => {
  const { page, context } = await open();
  await page.focus('#homeModeChip');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#homeModeSheet[open]');
  const radios = page.locator('#homeModeSheet [role="radio"]');
  await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'radio' && document.activeElement.getAttribute('aria-checked') === 'true', null, { timeout: 2000 });
  assert.equal(await radios.evaluateAll(rs => rs.filter(r => r.tabIndex === 0).length), 1, 'one radio in the Tab order');
  const first = (await active(page)).mode;
  await page.keyboard.press('ArrowDown');
  const next = await active(page);
  assert.notEqual(next.mode, first);
  assert.equal(await page.locator(`#homeModeSheet [data-home-mode="${next.mode}"]`).getAttribute('aria-checked'), 'true', 'the arrow chose it');
  assert.equal(await radios.evaluateAll(rs => rs.filter(r => r.tabIndex === 0).length), 1);
  await page.keyboard.press('ArrowUp');
  assert.equal((await active(page)).mode, first);
  await page.keyboard.press('Tab');
  assert.notEqual(await page.evaluate(() => document.activeElement?.getAttribute('role')), 'radio', 'Tab leaves the group');
  await context.close();
});

await check('the menus are navigation landmarks and mark the current page', async () => {
  const { page, context } = await open();
  await page.evaluate(() => window.showView('models'));
  await page.waitForSelector('#models.active');
  const primary = page.locator('[role="navigation"][aria-label="Primary"], nav[aria-label="Primary"]').filter({ has: page.locator('.ux-primary-item') });
  assert.equal(await primary.count(), 1, 'the rail is a Primary navigation landmark');
  const pages = page.locator('[role="navigation"][aria-label="Pages in this section"], nav[aria-label="Pages in this section"]').filter({ has: page.locator('.ux-secondary-link') });
  assert.equal(await pages.count(), 1, 'the page list is a navigation landmark');
  assert.deepEqual(await page.locator('.ux-secondary-link[aria-current="page"]').evaluateAll(b => b.map(x => x.dataset.view)), ['models']);
  assert.equal(await page.locator('.ux-primary-item[aria-current]').getAttribute('data-domain'), 'system');
  await page.evaluate(() => window.showView('status'));
  await page.waitForFunction(() => document.querySelector('.ux-secondary-link[aria-current="page"]')?.dataset.view === 'status');
  assert.equal(await page.locator('.ux-secondary-link[aria-current="page"]').count(), 1);
  await context.close();
});

await check('fields have names, and an error is tied to its field', async () => {
  const { page, context } = await open();
  for (const id of ['knowledgeQuery', 'browserUrl', 'autoName', 'workbenchPath', 'workbenchSearch', 'repoPath']) {
    const name = await page.evaluate(i => { const e = document.getElementById(i); return e?.getAttribute('aria-label') || (e?.labels?.[0]?.textContent || '').trim(); }, id);
    assert.ok(name, `#${id} has a name besides its placeholder`);
  }
  await page.evaluate(() => window.showView('models'));
  await page.waitForSelector('#modelPullForm');
  await page.fill('#modelPullName', 'not a model;rm');
  await page.click('#modelPullForm button[type="submit"]');
  await page.waitForSelector('#modelPullError:not([hidden])');
  await page.waitForFunction(() => document.getElementById('modelPullName').getAttribute('aria-invalid') === 'true', null, { timeout: 2000 });
  assert.match(await page.getAttribute('#modelPullName', 'aria-describedby'), /\bmodelPullError\b/);
  // Every error box with a field follows its box: shown → invalid and described, hidden → neither.
  for (const [err, field] of [['homeComposerError', 'commandInput'], ['improveIdeaError', 'improveIdeaText'], ['modelPullError', 'modelPullName']]) {
    await page.evaluate(e => { const b = document.getElementById(e); b.textContent = 'Something is wrong'; b.hidden = false; }, err);
    await page.waitForFunction(([e, f]) => { const x = document.getElementById(f); return x.getAttribute('aria-invalid') === 'true' && (x.getAttribute('aria-describedby') || '').split(' ').includes(e); }, [err, field], { timeout: 2000 });
    await page.evaluate(e => { document.getElementById(e).hidden = true; }, err);
    await page.waitForFunction(([e, f]) => { const x = document.getElementById(f); return !x.hasAttribute('aria-invalid') && !(x.getAttribute('aria-describedby') || '').split(' ').includes(e); }, [err, field], { timeout: 2000 });
  }
  await context.close();
});

const NOW = new Date().toISOString();
const chatRun = { id: 'r-chat', type: 'chat', title: 'Hello', status: 'completed', progress: 100, threadId: 't-' + 'b2'.repeat(16), updatedAt: NOW, createdAt: NOW, input: { prompt: 'Hello there', model: 'm' }, output: { text: 'Hi, how can I help?' }, artifactIds: [], pinned: false, projectId: null,
  card: { kind: 'chat', icon: 'compose', title: 'Hello there', summary: 'Hi, how can I help?', badge: { label: 'Done', tone: 'good' }, preview: null, action: { label: 'Open' }, approval: null } };
const stubRuns = (page, runs) => page.route(u => u.pathname === '/api/runs', r => { const q = new URL(r.request().url()).searchParams; if (q.get('id')) { const it = runs.find(x => x.id === q.get('id')); return it ? r.fulfill({ json: { item: it } }) : r.fulfill({ status: 404, json: { error: 'Run not found' } }); } if (q.get('threadId')) return r.fulfill({ json: { items: runs.filter(x => x.threadId === q.get('threadId')), summary: {} } }); r.fulfill({ json: { items: runs, summary: {} } }); });

await check('run lists are lists, the run view has a heading, and each turn says who spoke', async () => {
  const { page, context } = await open();
  await stubRuns(page, [chatRun]);
  await page.evaluate(() => { location.hash = '#work' });
  await page.locator('#work .run-card').first().waitFor();
  await page.waitForFunction(() => !!document.querySelector('#work [role="list"] > .run-card[role="listitem"]'), null, { timeout: 2000 });
  await page.evaluate(() => window.LocalAIRuns.show('r-chat'));
  await page.locator('#runDrawer .chat-turn--assistant').first().waitFor();
  assert.equal(await page.evaluate(() => document.getElementById('runDrawerTitle')?.tagName), 'H2');
  assert.deepEqual(await page.locator('#runDrawer .chat-turn--user').evaluateAll(t => t.map(x => x.getAttribute('aria-label'))), ['You']);
  assert.deepEqual(await page.locator('#runDrawer .chat-turn--assistant').evaluateAll(t => t.map(x => x.getAttribute('aria-label'))), ['Local AI']);
  await context.close();
});

await check('⌘K announces how many pages match', async () => {
  const { page, context } = await open();
  await page.keyboard.press('Meta+k');
  await page.waitForFunction(() => document.getElementById('cmdk')?.open === true);
  const status = page.locator('#cmdk [role="status"]');
  assert.equal(await status.count(), 1);
  const n = await page.locator('#cmdkList [role="option"]').count();
  assert.equal(await status.textContent(), `${n} pages`);
  await page.keyboard.type('audit');
  await page.waitForFunction(() => document.querySelector('#cmdk [role="status"]')?.textContent === '1 page');
  await page.keyboard.type('zzz');
  await page.waitForFunction(() => document.querySelector('#cmdk [role="status"]')?.textContent === 'No pages match');
  await context.close();
});

// ---- Four keyboard journeys the review ran, kept as permanent checks (G5). Keyboard only from the first key press. ----
async function tabTo(page, selector, max = 60) {
  for (let i = 0; i < max; i++) { await page.keyboard.press('Tab'); if (await page.evaluate(s => !!document.activeElement?.matches?.(s), selector)) return; }
  throw new Error(`Tab never reached ${selector}`);
}

await check('journey: ask from Home with the keyboard, and focus lands in the run view', async () => {
  // Chat is available (the mode is gated on the model service) and Home is in Chat mode; the rest is keys.
  const { page, context } = await open(undefined, p => p.route(u => u.pathname === '/api/capabilities', r => r.fulfill({ json: { services: ['ollama', 'search', 'comfy', 'n8n'].map(name => ({ name, label: name, state: 'HEALTHY', required: true })), models: { defaultInstalled: true }, images: { available: true }, version: '1' } })));
  await page.route(u => u.pathname === '/api/chat/stream', r => r.fulfill({ status: 200, contentType: 'text/event-stream', body: 'event: meta\ndata: {"model":"m","sources":[],"runId":"r-chat"}\n\nevent: token\ndata: {"text":"Hi, how can I help?"}\n\nevent: done\ndata: {"elapsedMs":1,"model":"m","sources":[],"runId":"r-chat"}\n\n' }));
  await stubRuns(page, [chatRun]);
  await page.evaluate(() => window.LocalAIHome.setMode('ask'));
  await page.waitForFunction(() => !document.querySelector('.mode[data-mode="ask"]')?.disabled, null, { timeout: 4000 });
  await tabTo(page, '#commandInput');
  await page.keyboard.type('Hello there');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => location.hash.startsWith('#run/'), null, { timeout: 6000 });
  await page.waitForTimeout(300);
  // Sub-project B owns which element gets focus; this journey only needs it to be inside the run view.
  assert.equal(await inView(page, 'runDrawer'), true, 'focus is in the run view');
  await context.close();
});

await check('journey: act on a Backlog item with the keyboard', async () => {
  const { page, context } = await open();
  const posts = [];
  const item = { id: 'idea-1', title: 'Remember my image size', severity: 'medium', status: 'approved', source: 'idea', votes: { up: 0, down: 0 }, priorityBoost: 0, rank: 1, score: 50, stage: 'backlog', change: null, createdAt: NOW, updatedAt: NOW };
  await page.route('**/api/improve/items', r => r.fulfill({ json: { items: [item], signals: [] } }));
  await page.route('**/api/improve/{item,idea,signal}', r => { posts.push(r.request().postDataJSON()); r.fulfill({ json: { item } }); });
  await page.evaluate(() => { location.hash = '#backlog' });
  await page.waitForSelector('#backlog.active #backlogList .improve-row__open');
  await tabTo(page, '#backlogList .improve-row__open');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#improveItemSheet[open]');
  await page.waitForFunction(() => !!document.activeElement?.closest('#improveItemSheet'), null, { timeout: 2000 });
  await tabTo(page, '#improveItemActions [data-item-act]', 20);
  await page.keyboard.press('Enter');
  for (let i = 0; i < 60 && !posts.length; i++) await page.waitForTimeout(50);
  assert.equal(posts.length, 1, 'the action was sent');
  assert.equal(posts[0].id, 'idea-1');
  // Where focus goes after the action is Sub-project B's (B2: refocus and confirm); it adds that assertion here.
  await context.close();
});

await check('journey: approve with the keyboard', async () => {
  const { page, context } = await open();
  const decided = [];
  let items = [{ id: 'ap1', title: 'Write notes.md', detail: 'Writes one file', risk: 'low', status: 'pending', createdAt: NOW }];
  await page.route(u => u.pathname === '/api/approvals', r => r.fulfill({ json: { items } }));
  await page.route(u => u.pathname === '/api/approvals/decide', r => { const b = r.request().postDataJSON(); decided.push(b); items = items.map(x => x.id === b.id ? { ...x, status: b.decision } : x); r.fulfill({ json: { ok: true } }); });
  // One queue: old #approvals links open the Inbox; "Review: …" opens the approval sheet, where the decision is made.
  await page.evaluate(() => { location.hash = '#approvals' });
  await page.waitForSelector('#inbox.active [data-approval-open="ap1"]');
  await tabTo(page, '[data-approval-open="ap1"]');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.getElementById('approvalSheet')?.open === true);
  await tabTo(page, '#approvalSheet [data-decide="approved"]');
  await page.keyboard.press('Enter');
  for (let i = 0; i < 60 && !decided.length; i++) await page.waitForTimeout(50);
  assert.deepEqual(decided.map(d => [d.id, d.decision]), [['ap1', 'approved']]);
  await context.close();
});

await check('journey: ⌘K to a page with the keyboard, and focus lands on that page', async () => {
  const { page, context } = await open();
  await page.keyboard.press('Meta+k');
  await page.waitForFunction(() => document.getElementById('cmdk')?.open === true);
  await page.keyboard.type('audit');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#activity.active');
  await page.waitForFunction(() => !!document.activeElement?.closest('#activity'), null, { timeout: 2000 });
  assert.equal(await page.title(), 'Audit log · Local AI');
  await context.close();
});


await browser.close();
if (failed) { console.log(`${failed} navigation accessibility check(s) failed`); process.exit(1) }
