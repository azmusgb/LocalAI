import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { addAxe } from './axe-helper.mjs';

// Task 5: a chat started from Home opens as a run view; the whole thread's conversation lives there and you reply in place.
const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const axePath = join(dirname(fileURLToPath(import.meta.url)), 'vendor', 'axe.min.js');
const browser = await chromium.launch({ headless: true });
const T = { timeout: 6000 };
const failures = [];
async function check(name, fn) {
  try { await fn(); console.log('PASS', name); } catch (error) { failures.push(`${name}: ${error.message}`); console.error('FAIL', name, error.message); }
}
const desk = { width: 1280, height: 860 }, phone = { width: 390, height: 844 };
const NOW = Date.now();
const THREAD = 't-' + 'a1'.repeat(16);
let seq = 0;
// A ledger run the way /api/runs sends it (with a card). Threads are keyed by threadId.
const run = (n, prompt, text, o = {}) => ({
  id: o.id || `run-${NOW + n * 1000}-${++seq}`, type: o.type || 'chat', status: o.status || 'completed', progress: 100, threadId: o.threadId === undefined ? THREAD : o.threadId,
  title: prompt.slice(0, 40), createdAt: new Date(NOW + n * 1000).toISOString(), updatedAt: new Date(NOW + n * 1000).toISOString(),
  input: { prompt, model: 'm' }, output: o.output || { text }, artifactIds: o.artifactIds || [],
  card: { kind: o.type || 'chat', icon: 'system', title: prompt, summary: text, badge: { label: 'Done', tone: 'good' }, preview: null, action: { label: 'Open' }, approval: null }
});
const three = () => [run(3, 'third question', 'third answer'), run(1, 'first question', 'first answer'), run(2, 'second question', 'second answer')];

// db.runs: every ledger run the stub knows (a test can push into it); db.library: Library items.
async function open(viewport, hash, { runs = [], library = [], storage = {}, stream = 'live' } = {}) {
  const db = { runs, library };
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport, isMobile: viewport.width < 760, hasTouch: viewport.width < 760 });
  await ctx.addInitScript(s => { try { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); } } catch {} }, { 'localai.devTools': '1', 'localai.firstRun.done': '1', ...storage });
  // /api/chat/stream is a controllable SSE stream: __reqs records each request body, __streams[i].push(event, data) / .close(), and an abort errors it.
  await ctx.addInitScript(() => { window.__pd = 0; const add = document.addEventListener.bind(document); document.addEventListener = (t, ...a) => { if (t === 'pointerdown') window.__pd++; return add(t, ...a); }; });
  await ctx.addInitScript(mode => {
    const real = window.fetch.bind(window); window.__reqs = []; window.__streams = []; window.__aborted = 0;
    window.fetch = (url, opts = {}) => {
      if (!String(url).includes('/api/chat/stream')) return real(url, opts);
      window.__reqs.push(JSON.parse(opts.body));
      if (mode === 'nometa') return Promise.resolve(new Response('event: token\ndata: {"text":"hi"}\n\nevent: done\ndata: {"elapsedMs":1}\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
      if (mode === 'holdfail') return new Promise(res => { window.__failReq = () => res(new Response(JSON.stringify({ error: 'No model is loaded' }), { status: 503, headers: { 'Content-Type': 'application/json' } })); });
      if (mode === 'fail') return Promise.resolve(new Response(JSON.stringify({ error: 'No model is loaded' }), { status: 503, headers: { 'Content-Type': 'application/json' } }));
      let ctl; const enc = new TextEncoder();
      const rs = new ReadableStream({ start(c) { ctl = c; } });
      window.__streams.push({ push: (ev, data) => ctl.enqueue(enc.encode(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`)), close: () => ctl.close() });
      opts.signal?.addEventListener('abort', () => { window.__aborted++; try { ctl.error(new DOMException('Aborted', 'AbortError')); } catch {} });
      return Promise.resolve(new Response(rs, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
    };
  }, stream);
  const page = await ctx.newPage({ serviceWorkers: 'block' });
  page.db = db; page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  const json = (r, body, status = 200) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await ctx.route(u => u.pathname === '/api/approvals', r => json(r, { items: [] }));
  await ctx.route(u => u.pathname === '/api/activity', r => json(r, { items: [] }));
  await page.route(u => u.pathname === '/api/capabilities', r => json(r, { services: ['ollama', 'search', 'comfy', 'n8n'].map(name => ({ name, label: name, state: 'HEALTHY', required: true })), models: { defaultInstalled: true }, images: { available: true }, version: '1' }));
  await page.route(u => u.pathname === '/api/library', r => json(r, { items: db.library, counts: {}, total: db.library.length }));
  await page.route(u => u.pathname === '/api/runs', r => {
    const q = new URL(r.request().url()).searchParams, all = db.runs;
    if (q.get('id')) { const it = all.find(x => x.id === q.get('id')); return it ? json(r, { item: it }) : json(r, { error: 'Run not found' }, 404); }
    if (q.get('threadId')) return json(r, { items: all.filter(x => x.threadId === q.get('threadId')), summary: {} });
    json(r, { items: all, summary: {} });
  });
  await page.goto(base + '/' + hash, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.showView === 'function' && window.LocalAIRouter && window.LocalAIHome && window.LocalAIChat && location.hash, null, { timeout: 8000 });
  return page;
}
const turns = (page, who) => page.locator(`#runDrawer .chat-turn--${who}`).allInnerTexts();
const reqs = page => page.evaluate(() => window.__reqs);

await check('Home Chat: Send opens #run/pending, meta resolves it to the run, and tokens appear in the run view', async () => {
  const page = await open(desk, '#home', { storage: { 'localai.home.mode': 'ask' } });
  await page.locator('#commandInput').fill('What is a mutex');
  await page.locator('#commandGo').click();
  await page.waitForFunction(() => location.hash === '#run/pending', null, T);
  await page.waitForFunction(() => window.__reqs.length === 1, null, T);
  const body = (await reqs(page))[0];
  assert.match(body.threadId, /^t-[0-9a-f]{32}$/);
  assert.equal(body.webSearch, false);
  assert.deepEqual(body.messages, [{ role: 'user', content: 'What is a mutex' }]);
  const r = run(1, 'What is a mutex', '', { id: 'run-live-1', threadId: body.threadId, status: 'running' }); r.output = null;
  page.db.runs.push(r);
  await page.evaluate(() => window.__streams[0].push('meta', { model: 'm', sources: [], runId: 'run-live-1' }));
  await page.waitForFunction(() => location.hash === '#run/run-live-1', null, T);
  await page.evaluate(() => { window.__streams[0].push('token', { text: 'A mutex ' }); window.__streams[0].push('token', { text: 'locks.' }); });
  await page.locator('#runDrawer .chat-turn--assistant', { hasText: 'A mutex locks.' }).waitFor(T);
  assert.deepEqual(await turns(page, 'user'), ['What is a mutex']);
  assert.equal(page.errors.length, 0, page.errors.join('|'));
  await page.context().close();
});

await check('Home Research sends webSearch; a failed start shows the reason and keeps the text', async () => {
  const page = await open(desk, '#home', { storage: { 'localai.home.mode': 'research' }, stream: 'fail' });
  await page.locator('#commandInput').fill('heat pumps');
  await page.locator('#commandGo').click();
  await page.waitForFunction(() => window.__reqs.length === 1, null, T);
  assert.equal((await reqs(page))[0].webSearch, true);
  await page.waitForSelector('#homeComposerError:not([hidden])', T);
  assert.match(await page.locator('#homeComposerError').textContent(), /No model is loaded/);
  assert.equal(await page.locator('#commandInput').inputValue(), 'heat pumps');
  await page.locator('#runDrawer .status-error', { hasText: 'No model is loaded' }).waitFor(T);
  await page.context().close();
});

// A chat that fails to start is still a Chat, offers Try again, and for a model problem points at Models.
await check('Home Chat failure: subtitle "Chat", Try again resends, a model error links to Models', async () => {
  const page = await open(desk, '#home', { storage: { 'localai.home.mode': 'ask' }, stream: 'fail' });
  await page.locator('#commandInput').fill('What is a mutex');
  await page.locator('#commandGo').click();
  await page.locator('#runDrawer .status-error', { hasText: 'No model is loaded' }).waitFor(T);
  assert.equal(await page.locator('#runDrawer .run-drawer-sub').innerText(), 'Chat');
  assert.equal(await page.locator('#runDrawer button', { hasText: 'Close' }).count(), 1);
  assert.equal(await page.locator('#runDrawer button', { hasText: 'Open Models' }).count(), 1);
  await page.locator('#runDrawer button', { hasText: 'Try again' }).click();
  await page.waitForFunction(() => window.__reqs.length === 2, null, T);
  assert.deepEqual((await reqs(page))[1].messages, [{ role: 'user', content: 'What is a mutex' }]);
  await page.locator('#runDrawer .status-error', { hasText: 'No model is loaded' }).waitFor(T);
  await page.locator('#runDrawer button', { hasText: 'Open Models' }).click();
  await page.waitForSelector('#models.active', T);
  assert.equal(page.errors.length, 0, page.errors.join('|'));
  await page.context().close();
});

await check('a thread with 3 runs renders 3 user and 3 assistant turns in order', async () => {
  const page = await open(desk, '#home', { runs: three() });
  await page.evaluate(id => window.LocalAIRuns.show(id), page.db.runs[1].id);
  await page.locator('#runDrawer .chat-turn--assistant').nth(2).waitFor(T);
  assert.deepEqual(await turns(page, 'user'), ['first question', 'second question', 'third question']);
  assert.deepEqual(await turns(page, 'assistant'), ['first answer', 'second answer', 'third answer']);
  await page.context().close();
});

await check('a truncated answer shows the full text from the Library', async () => {
  const r = run(1, 'long one', '', { output: { truncated: true, preview: 'PREVIEW' }, artifactIds: ['art-1'] });
  const page = await open(desk, '#home', { runs: [r], library: [{ id: 'other', data: { response: 'nope' } }, { id: 'art-1', data: { response: 'FULL LIBRARY ANSWER' } }] });
  await page.evaluate(id => window.LocalAIRuns.show(id), r.id);
  await page.locator('#runDrawer .chat-turn--assistant', { hasText: 'FULL LIBRARY ANSWER' }).waitFor(T);
  await page.context().close();
});

await check('a truncated answer with no Library copy never shows raw JSON', async () => {
  const bad = run(1, 'long one', '', { output: { truncated: true, preview: '{"text":"The beginning of a very long answ' }, artifactIds: ['gone'], threadId: 't-bad' });
  const good = run(1, 'parsable', '', { output: { truncated: true, preview: '{"text":"Parsed preview text"}' }, artifactIds: ['gone2'], threadId: 't-good' });
  const page = await open(desk, '#home', { runs: [bad, good], library: [] });
  await page.evaluate(id => window.LocalAIRuns.show(id), bad.id);
  await page.locator('#runDrawer .chat-turn--assistant', { hasText: 'This answer was too long to keep here.' }).waitFor(T);
  assert.ok(!/truncated|\{"/.test(await page.locator('#runDrawer').innerText()));
  await page.evaluate(id => window.LocalAIRuns.show(id), good.id);
  await page.locator('#runDrawer .chat-turn--assistant', { hasText: 'Parsed preview text' }).waitFor(T);
  assert.ok(!/truncated|\{"/.test(await page.locator('#runDrawer').innerText()));
  await page.context().close();
});

await check('a reply never sends the "too long to keep" placeholder to the model as an answer', async () => {
  const bad = run(1, 'long one', '', { output: { truncated: true, preview: '{"text":"The beginning of a very long answ' }, artifactIds: ['gone'], threadId: 't-bad' });
  const page = await open(desk, '#home', { runs: [bad], library: [] });
  await page.evaluate(id => window.LocalAIRuns.show(id), bad.id);
  await page.locator('#runDrawer .chat-turn--assistant', { hasText: 'This answer was too long to keep here.' }).waitFor(T);
  await page.locator('#runReply').fill('and then?'); await page.locator('#runReply').press('Enter');
  await page.waitForFunction(() => window.__reqs.length === 1, null, T);
  const msgs = (await reqs(page))[0].messages;
  assert.ok(!JSON.stringify(msgs).includes('too long to keep'), JSON.stringify(msgs));
  assert.deepEqual(msgs.filter(m => m.role === 'user').map(m => m.content), ['long one', 'and then?']);
  await page.context().close();
});

for (const [tag, vp] of [['390x844', phone], ['1280x860', desk]]) await check(`${tag}: a failed chat run is not a dead end: the reply box works and More offers Retry`, async () => {
  const f = run(1, 'why is the sky blue', '', { status: 'failed', output: null }); f.error = 'The model stopped answering'; f.retryable = true;
  const page = await open(vp, '#home', { runs: [f] });
  await page.evaluate(id => window.LocalAIRuns.show(id), f.id);
  await page.locator('#runDrawer .chat-turn--error', { hasText: 'The model stopped answering' }).waitFor(T);
  assert.equal(await page.locator('#runReply').isVisible(), true);
  assert.equal(await page.locator('#runReply').isEnabled(), true);
  await page.locator('#runMoreBtn').click();
  assert.equal(await page.locator('.run-menu button', { hasText: 'Retry' }).isEnabled(), true);
  await page.keyboard.press('Escape');
  await page.locator('#runReply').fill('try again please'); await page.locator('#runReply').press('Enter');
  await page.waitForFunction(() => window.__reqs.length === 1, null, T);
  const b = (await reqs(page))[0];
  assert.equal(b.threadId, THREAD);
  assert.equal(b.messages.at(-1).content, 'try again please');
  assert.ok(!b.messages.some(m => m.content === 'The model stopped answering'), 'the failure text is not sent as an answer');
  await page.context().close();
});

await check('a reply sends the thread id and the previous turns, and the answer streams in place', async () => {
  const page = await open(desk, '#home', { runs: three() });
  await page.evaluate(id => window.LocalAIRuns.show(id), page.db.runs[0].id);
  await page.locator('#runReply').waitFor(T);
  await page.locator('#runReply').fill('and a fourth?');
  await page.locator('#runReplySend').click();
  await page.waitForFunction(() => window.__reqs.length === 1, null, T);
  const b = (await reqs(page))[0];
  assert.equal(b.threadId, THREAD);
  assert.deepEqual(b.messages, [
    { role: 'user', content: 'first question' }, { role: 'assistant', content: 'first answer' },
    { role: 'user', content: 'second question' }, { role: 'assistant', content: 'second answer' },
    { role: 'user', content: 'third question' }, { role: 'assistant', content: 'third answer' },
    { role: 'user', content: 'and a fourth?' }]);
  assert.equal(await page.locator('#runReply').inputValue(), '');
  await page.evaluate(() => { window.__streams[0].push('meta', { runId: 'run-r4' }); window.__streams[0].push('token', { text: 'fourth answer' }); });
  await page.locator('#runDrawer .chat-turn--assistant', { hasText: 'fourth answer' }).waitFor(T);
  assert.deepEqual(await turns(page, 'user'), ['first question', 'second question', 'third question', 'and a fourth?']);
  // Finishing: the ledger now has the 4th run; the view keeps showing 4 turns (not duplicated).
  page.db.runs.push(run(4, 'and a fourth?', 'fourth answer', { id: 'run-r4' }));
  await page.evaluate(() => { window.__streams[0].push('done', { runId: 'run-r4', elapsedMs: 1, model: 'm', sources: [] }); window.__streams[0].close(); });
  await page.waitForFunction(() => document.getElementById('runReplySend').textContent === 'Send', null, T);
  await page.waitForTimeout(300);
  assert.deepEqual(await turns(page, 'assistant'), ['first answer', 'second answer', 'third answer', 'fourth answer']);
  await page.context().close();
});

await check('while streaming the reply button reads Stop, a second Enter sends nothing, and Stop aborts and re-enables', async () => {
  const page = await open(desk, '#home', { runs: three() });
  await page.evaluate(id => window.LocalAIRuns.show(id), page.db.runs[0].id);
  await page.locator('#runReply').fill('one more');
  await page.locator('#runReply').press('Enter');
  await page.waitForFunction(() => document.getElementById('runReplySend').textContent === 'Stop', null, T);
  await page.locator('#runReply').fill('sneaky');
  await page.locator('#runReply').press('Enter');
  await page.waitForTimeout(200);
  assert.equal((await reqs(page)).length, 1);
  await page.evaluate(() => window.__streams[0].push('token', { text: 'partial' }));
  await page.locator('#runDrawer .chat-turn--assistant', { hasText: 'partial' }).waitFor(T);
  await page.locator('#runReplySend').click();
  await page.waitForFunction(() => document.getElementById('runReplySend').textContent === 'Send', null, T);
  assert.equal(await page.evaluate(() => window.__aborted), 1);
  assert.equal(await page.locator('#runReplySend').isEnabled(), true);
  assert.equal(await page.locator('#runReply').isEnabled(), true);
  assert.equal((await reqs(page)).length, 1);
  assert.equal(page.errors.length, 0, page.errors.join('|'));
  await page.context().close();
});

await check('a run view rebuild while a reply streams keeps the stream, the draft and the focus', async () => {
  const runs = three(); runs[1].status = 'running';
  const page = await open(desk, '#home', { runs });
  await page.evaluate(id => window.LocalAIRuns.show(id), runs[1].id);
  await page.locator('#runReply').fill('first reply'); await page.locator('#runReply').press('Enter');
  await page.waitForFunction(() => window.__reqs.length === 1, null, T);
  await page.evaluate(() => window.__streams[0].push('token', { text: 'partial answer' }));
  await page.locator('#runDrawer .chat-turn--assistant', { hasText: 'partial answer' }).waitFor(T);
  await page.locator('#runReply').click(); await page.keyboard.type('next draft');
  runs[1].updatedAt = new Date(NOW + 99000).toISOString(); runs[1].progress = 42;   // the poll sees a change and rebuilds the view
  await page.waitForTimeout(4500);
  assert.equal(await page.locator('#runReply').inputValue(), 'next draft');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'runReply');
  assert.equal(await page.locator('#runReplySend').innerText(), 'Stop');
  assert.ok((await turns(page, 'assistant')).includes('partial answer'));
  assert.equal(await page.locator('#runDrawer .chat-turn--user').count(), 4);
  await page.context().close();
});

const long = () => Array.from({ length: 12 }, (_, i) => run(i + 1, `question ${i + 1}`, `answer ${i + 1} `.repeat(30)));
await check('at 390x844 the reply box stays visible when the keyboard takes 300px (layout shrinks)', async () => {
  const page = await open(phone, '#home', { runs: long() });
  await page.evaluate(id => window.LocalAIRuns.show(id), page.db.runs[0].id);
  await page.locator('#runReply').waitFor(T);
  await page.locator('#runReply').focus();
  await page.setViewportSize({ width: 390, height: 544 });
  await page.waitForTimeout(250);
  const b = await page.locator('#runReply').boundingBox();
  assert.ok(b.y >= 0 && b.y + b.height <= 544, `reply box ${b.y}..${b.y + b.height} not inside 544`);
  await page.context().close();
});

await check('at 390x844 the reply box stays above a keyboard that only shrinks the visual viewport', async () => {
  const page = await open(phone, '#home', { runs: long() });
  await page.evaluate(id => window.LocalAIRuns.show(id), page.db.runs[0].id);
  await page.locator('#runReply').waitFor(T);
  await page.evaluate(() => { const vv = window.visualViewport; Object.defineProperty(vv, 'height', { configurable: true, value: 544 }); vv.dispatchEvent(new Event('resize')); });
  await page.waitForTimeout(250);
  const b = await page.locator('#runReply').boundingBox(), s = await page.locator('#runReplySend').boundingBox();
  assert.ok(b.y >= 0 && b.y + b.height <= 544, `reply box ${b.y}..${b.y + b.height} not inside 544`);
  assert.ok(s.y + s.height <= 544, 'send button is above the keyboard');
  await page.context().close();
});

// Nothing is hover-only: on a phone the two-line title opens in full on a tap; on a desktop the full text stays on hover.
const TITLE = 'Explain in careful detail how a heat pump moves warmth from cold outdoor air into a house in the middle of winter, and what that costs';
const titled = () => Object.assign(run(1, TITLE, 'the answer'), { title: TITLE });   // the run view shows run.title, which run() cuts to 40 characters
await check('390x844: a tap on the clamped run title shows all of it; a second tap folds it again', async () => {
  const page = await open(phone, '#home', { runs: [titled()] });
  await page.evaluate(id => window.LocalAIRuns.show(id), page.db.runs[0].id);
  await page.locator('#runDrawerTitle').waitFor(T);
  const t = page.locator('#runDrawerTitle');
  const lines = () => t.evaluate(e => ({ h: e.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(e).lineHeight) }));
  const before = await lines();
  assert.ok(before.h <= before.lh * 2 + 2, `title is ${before.h}px before the tap`);
  assert.equal(await t.getAttribute('aria-expanded'), 'false');
  await t.tap();
  const after = await lines();
  assert.ok(after.h > before.lh * 2 + 2, `title is still ${after.h}px after the tap`);
  assert.equal(await t.getAttribute('aria-expanded'), 'true');
  await t.tap();
  assert.ok((await lines()).h <= before.lh * 2 + 2, 'second tap folds it');
  assert.equal(await t.getAttribute('title'), TITLE);
  await page.context().close();
});
await check('1280x860: the run title is not clamped and keeps its hover text', async () => {
  const page = await open(desk, '#home', { runs: [titled()] });
  await page.evaluate(id => window.LocalAIRuns.show(id), page.db.runs[0].id);
  await page.locator('#runDrawerTitle').waitFor(T);
  assert.equal(await page.locator('#runDrawerTitle').getAttribute('title'), TITLE);
  assert.equal(await page.locator('#runDrawerTitle').evaluate(e => e.scrollHeight > e.clientHeight + 1), false);
  await page.context().close();
});

// On a notched iPhone the reply bar must clear the home indicator: its bottom padding carries env(safe-area-inset-bottom).
// Chromium reports the inset as 0, so the rule is read from the stylesheet, not the computed padding.
await check('the reply bar keeps the safe-area inset under Reply and Send', async () => {
  const page = await open(phone, '#home', { runs: long() });
  await page.evaluate(id => window.LocalAIRuns.show(id), page.db.runs[0].id);
  await page.locator('#runReply').waitFor(T);
  const r = await page.evaluate(() => {
    const bar = document.querySelector('.chat-body__reply');
    const rules = [];
    for (const sheet of document.styleSheets) { let list; try { list = sheet.cssRules; } catch { continue; } for (const rule of list) if (rule.selectorText && bar.matches(rule.selectorText)) rules.push(rule.style.paddingBottom || rule.style.padding || ''); }
    return { safe: rules.some(p => /safe-area-inset-bottom/.test(p)), pad: parseFloat(getComputedStyle(bar).paddingBottom) };
  });
  assert.ok(r.safe, 'no rule on the reply bar uses env(safe-area-inset-bottom)');
  assert.ok(r.pad >= 12, `padding-bottom ${r.pad}px`);
  await page.context().close();
});

await check('/#ask lands on Home with the chip reading "Chat ▾"', async () => {
  const page = await open(desk, '#ask');
  await page.waitForSelector('#home.active', T);
  assert.equal((await page.locator('#homeModeChip').innerText()).trim(), 'Chat ▾');
  await page.context().close();
});

for (const [tag, vp] of [['390x844', phone], ['1280x860', desk]]) {
  await check(`axe: the chat run view passes color-contrast and target-size at ${tag}`, async () => {
    const page = await open(vp, '#home', { runs: three() });
    await page.evaluate(id => window.LocalAIRuns.show(id), page.db.runs[0].id);
    await page.locator('#runDrawer .chat-turn--assistant').nth(2).waitFor(T);
    await addAxe(page, axePath);
    const v = await page.evaluate(() => window.axe.run('#runDrawer', { runOnly: { type: 'rule', values: ['color-contrast', 'target-size'] } }).then(r => r.violations.map(x => `${x.id}: ${x.nodes.map(n => n.html.slice(0, 120)).join(' | ')}`)));
    assert.deepEqual(v, []);
    await page.context().close();
  });
}

await check('the scroll position survives a run view rebuild', async () => {
  const runs = long(); runs[0].status = 'running';
  const page = await open(phone, '#home', { runs });
  await page.evaluate(id => window.LocalAIRuns.show(id), runs[0].id);
  await page.locator('#runReply').waitFor(T);
  await page.waitForTimeout(500);
  await page.evaluate(() => { document.getElementById('runDrawer').scrollTop = 150; });
  await page.waitForTimeout(300);
  runs[0].updatedAt = new Date(NOW + 99000).toISOString(); runs[0].progress = 42;
  await page.waitForTimeout(4500);
  const top = await page.evaluate(() => document.getElementById('runDrawer').scrollTop);
  assert.ok(Math.abs(top - 150) <= 2, `scrollTop ${top}, expected 150`);
  await page.context().close();
});

await check('a stream that ends with no run id fails the pending view and Home keeps the text', async () => {
  const page = await open(desk, '#home', { storage: { 'localai.home.mode': 'ask' }, stream: 'nometa' });
  await page.locator('#commandInput').fill('no meta here');
  await page.locator('#commandGo').click();
  await page.waitForSelector('#homeComposerError:not([hidden])', T);
  assert.match(await page.locator('#homeComposerError').textContent(), /could not be started/);
  assert.equal(await page.locator('#commandInput').inputValue(), 'no meta here');
  await page.locator('#runDrawer .status-error', { hasText: 'could not be started' }).waitFor(T);
  await page.context().close();
});

await check('a failed reply keeps the draft typed meanwhile and offers Retry with the failed text', async () => {
  const page = await open(desk, '#home', { runs: three(), stream: 'holdfail' });
  await page.evaluate(id => window.LocalAIRuns.show(id), page.db.runs[0].id);
  await page.locator('#runReply').fill('first try'); await page.locator('#runReply').press('Enter');
  await page.waitForFunction(() => window.__reqs.length === 1, null, T);
  await page.locator('#runReply').fill('a new draft');
  await page.evaluate(() => window.__failReq());
  await page.locator('#runDrawer .chat-body__error', { hasText: 'No model is loaded' }).waitFor(T);
  assert.equal(await page.locator('#runReply').inputValue(), 'a new draft');
  await page.locator('#runDrawer .chat-body__retry').click();
  await page.waitForFunction(() => window.__reqs.length === 2, null, T);
  assert.equal((await reqs(page))[1].messages.at(-1).content, 'first try');
  await page.context().close();
});

await check('a failed reply with an empty box puts the text back', async () => {
  const page = await open(desk, '#home', { runs: three(), stream: 'holdfail' });
  await page.evaluate(id => window.LocalAIRuns.show(id), page.db.runs[0].id);
  await page.locator('#runReply').fill('first try'); await page.locator('#runReply').press('Enter');
  await page.waitForFunction(() => window.__reqs.length === 1, null, T);
  await page.evaluate(() => window.__failReq());
  await page.locator('#runDrawer .chat-body__error').waitFor(T);
  assert.equal(await page.locator('#runReply').inputValue(), 'first try');
  await page.context().close();
});

await check('opening three chat runs registers one pointerdown listener, not three', async () => {
  const rs = [0, 1, 2].map(i => run(i + 1, `q${i}`, `a${i}`, { threadId: 't-' + String(i).repeat(32) }));
  const page = await open(desk, '#home', { runs: rs });
  for (const r of rs) { await page.evaluate(id => window.LocalAIRuns.show(id), r.id); await page.locator('#runDrawer .chat-turn--assistant', { hasText: 'a' + rs.indexOf(r) }).waitFor(T); await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
  assert.ok(await page.evaluate(() => window.__pd) <= 1);
  await page.context().close();
});

await browser.close();
if (failures.length) { console.error('\n' + failures.length + ' failed:\n- ' + failures.join('\n- ')); process.exit(1); }
console.log('\nAll chat run view checks passed');
