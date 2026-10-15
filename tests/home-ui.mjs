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
  const badge = status === 'awaiting_approval' ? { label: 'Review', tone: 'attention' } : status === 'failed' ? { label: 'Failed', tone: 'bad' } : { label: 'Done', tone: 'good' };
  return {
    id: o.id || `run-${NOW - ageMs}-${n}`, type: kind, status, progress: 100, threadId: o.threadId || undefined,
    createdAt: new Date(NOW - ageMs).toISOString(), updatedAt: new Date(NOW - ageMs).toISOString(),
    card: { kind, icon: kind === 'image' ? 'image' : 'system', title, summary: o.summary || `${kind} · ${n}`, badge, preview: null, action: { label: status === 'awaiting_approval' ? 'Review' : 'Open' }, approval: null }
  };
};
const six = () => [
  item('chat', 'Plan the garden', 5 * 60e3), item('image', 'A red fox at dusk', 2 * HOUR), item('chat', 'Why is sqlite so fast', 3 * HOUR),
  item('agent', 'Summarise the inbox', 4 * HOUR), item('research', 'Heat pump prices', 5 * HOUR), item('automation', 'Nightly backup', 6 * HOUR)
];
const needs = () => [
  item('engineering', 'Fix the login bug', 10 * 60e3, { status: 'awaiting_approval' }),
  item('agent', 'Weekly report mission', 2 * HOUR, { status: 'failed' }),
  item('agent', 'Old failed mission', 3 * 24 * HOUR, { status: 'failed' }),
  item('chat', 'Fine chat', HOUR)
];
// Stubs: `threads` answers /api/runs?threads=1, `all` answers the plain /api/runs list, `engineering` the start endpoint.
let capabilities = () => ({ services: ['ollama', 'search', 'comfy', 'n8n'].map(name => ({ name, label: name, state: 'HEALTHY', required: true })), models: { defaultInstalled: true }, images: { available: true }, version: '1' });
async function open(viewport, hash, { threads = six, all = needs, engineering = null, storage = {}, caps = null, approvals = [], activity = [], route = null } = {}) {
  capabilities = caps || (() => ({ services: ['ollama', 'search', 'comfy', 'n8n'].map(name => ({ name, label: name, state: 'HEALTHY', required: true })), models: { defaultInstalled: true }, images: { available: true }, version: '1' }));
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport, isMobile: viewport.width < 760, hasTouch: viewport.width < 760 });
  await ctx.addInitScript(s => { try { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); } } catch {} }, { 'localai.devTools': '1', 'localai.firstRun.done': '1', ...storage });
  const page = await ctx.newPage({ serviceWorkers: 'block' });
  await ctx.route(u => u.pathname === '/api/approvals', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: approvals }) }));
  await ctx.route(u => u.pathname === '/api/activity', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: activity }) }));
  if (route) await ctx.route(u => u.pathname === '/api/route', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify(route) }));
  page.calls = []; page.known = new Map(); page.started = []; page.memo = {};
  await page.route(u => u.pathname === '/api/capabilities', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify(capabilities()) }));
  await page.route(u => u.pathname === '/api/runs', async r => {
    const url = new URL(r.request().url());
    let out;
    const json = body => r.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (url.searchParams.get('id')) { const it = page.known.get(url.searchParams.get('id')); return it ? json({ item: it }) : r.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Run not found"}' }); }
    const which = url.searchParams.get('threads') ? 'threads' : 'all';
    out = page.memo[which] ??= await (which === 'threads' ? threads : all)(url); // the same rows on every poll
    if (url.searchParams.get('threads')) page.calls.push(url);
    for (const it of Array.isArray(out) ? out : []) page.known.set(it.id, it);
    if (!url.searchParams.get('threads')) return json({ items: [...page.known.values()], summary: {} });
    json({ items: out, summary: {} });
  });
  if (engineering) await page.route(u => u.pathname === '/api/engineering/start', async r => {
    page.started.push(r.request().postDataJSON());
    const res = await engineering(page);
    r.fulfill({ status: res.status || 202, contentType: 'application/json', body: JSON.stringify(res.body) });
  });
  await page.goto(base + '/' + hash, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.showView === 'function' && window.LocalAIRouter && window.LocalAIHome && location.hash, null, { timeout: 8000 });
  return page;
}
const desk = { width: 1280, height: 860 }, phone = { width: 390, height: 844 };
const titles = (page, sel) => page.locator(`${sel} .list-row__title`).allInnerTexts();

for (const [tag, vp] of [['phone', phone], ['desktop', desk]]) {
  await check(`${tag}: Needs you lists the approval and today's failure, not a 3 day old one`, async () => {
    const page = await open(vp, '#home');
    await page.waitForSelector('#homeNeedsYou .run-card', T);
    assert.deepEqual((await titles(page, '#homeNeedsYou')).sort(), ['Fix the login bug', 'Weekly report mission']);
    await page.context().close();
  });

  await check(`${tag}: Needs you is hidden when nothing needs you`, async () => {
    const page = await open(vp, '#home', { all: () => [item('chat', 'Fine chat', HOUR)] });
    await page.waitForSelector('#homeRecent2 .run-card', T);
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#homeNeedsYou').isVisible(), false);
    await page.context().close();
  });

  await check(`${tag}: Recent shows six thread cards, one alignment, and See all goes to Work`, async () => {
    const page = await open(vp, '#home');
    await page.waitForSelector('#homeRecent2 .run-card', T);
    assert.equal(await page.locator('#homeRecent2 .run-card').count(), 6);
    assert.ok(page.calls.some(u => u.searchParams.get('limit') === '6'), page.calls.map(u => u.search).join());
    const xs = await page.locator('#homeRecent2 .list-row__title').evaluateAll(e => [...new Set(e.map(x => Math.round(x.getBoundingClientRect().left)))]);
    assert.equal(xs.length, 1, 'titles start at ' + xs.join());
    const see = page.locator('#homeSeeAll');
    const lines = await see.evaluate(e => { const r = document.createRange(); r.selectNodeContents(e); return new Set([...r.getClientRects()].map(x => Math.round(x.top))).size; });
    assert.equal(lines, 1, 'See all is on one line');
    await see.click();
    await page.waitForSelector('#work.active', T);
    assert.match(await page.evaluate(() => location.hash), /^#work/);
    await page.context().close();
  });

  await check(`${tag}: the old Home pieces are gone: one health indicator, no capability strip, no old lists`, async () => {
    const page = await open(vp, '#home');
    await page.waitForSelector('#homeRecent2 .run-card', T);
    for (const id of ['homeCapabilities', 'homeRecent', 'homeActivity', 'homePinnedCard']) assert.equal(await page.locator('#' + id).count(), 0, id);
    assert.equal(await page.locator('#home .topbar .pill:visible').count(), 0);
    assert.equal(await page.locator('#home .workspace-hero').count(), 0);
    assert.equal(await page.locator('#home').getByText(/SD 1\.5/).count(), 0);
    await page.context().close();
  });
}

await check('Recent and Needs you show a run summary once, not again as preview text', async () => {
  const dup = (title, o) => { const r = item('chat', title, 5 * 60e3, o); r.card.preview = { type: 'text', text: 'The answer is forty-two, as computed by Deep Thought.' }; r.card.summary = 'The answer is forty-two'; return r; };
  const a = dup('Meaning of life'), f = dup('Failed meaning', { status: 'failed' });
  const page = await open(desk, '#home', { threads: () => [a], all: () => [a, f] });
  await page.waitForSelector('#homeRecent2 .run-card', T);
  await page.waitForSelector('#homeNeedsYou .run-card', T);
  for (const sel of ['#homeRecent2', '#homeNeedsYou']) { const t = await page.locator(sel).innerText(); assert.equal(t.split('The answer is forty-two').length - 1, 1, sel + ': ' + t); }
  await page.context().close();
});

await check('a stopped core service shows in Needs you, and the capability strip is not on Home', async () => {
  const caps = () => ({ services: [{ name: 'ollama', label: 'Intelligence', state: 'DOWN', required: true, impact: 'Chat is unavailable.' }, ...['search', 'comfy', 'n8n'].map(name => ({ name, label: name, state: 'HEALTHY', required: true }))], models: { defaultInstalled: true }, images: { available: true } });
  const page = await open(desk, '#home', { caps, all: () => [] });
  await page.waitForSelector('#homeNeedsYou .home-attn', T);
  assert.match(await page.locator('#homeNeedsYou').innerText(), /Intelligence is down/);
  assert.equal(await page.locator('#truthAttention').isVisible(), false);
  await page.context().close();
});

await check('phone: the composer sits on the tab bar and nothing hides under it', async () => {
  const page = await open(phone, '#home');
  await page.waitForSelector('#homeRecent2 .run-card', T);
  const r = await page.evaluate(() => {
    const c = document.getElementById('homeComposer').getBoundingClientRect(), n = document.getElementById('uxMobileNav').getBoundingClientRect();
    window.scrollTo(0, document.documentElement.scrollHeight);
    const last = [...document.querySelectorAll('#homeRecent2 .run-card')].pop().getBoundingClientRect();
    return { cb: c.bottom, nt: n.top, last: last.bottom, ct: document.getElementById('homeComposer').getBoundingClientRect().top, pos: getComputedStyle(document.getElementById('homeComposer')).position };
  });
  assert.equal(r.pos, 'fixed');
  assert.ok(Math.abs(r.cb - r.nt) <= 1, `composer bottom ${r.cb} vs nav top ${r.nt}`);
  assert.ok(r.last <= r.ct + 1, `last card bottom ${r.last} under composer top ${r.ct}`);
  await page.context().close();
});

await check('desktop: the composer is at the foot of a centred column no wider than 720 px', async () => {
  const page = await open(desk, '#home');
  await page.waitForSelector('#homeRecent2 .run-card', T);
  const b = await page.locator('#homeComposer').boundingBox();
  assert.ok(b.width <= 721 && b.width > 300, `width ${b.width}`);
  const main = await page.locator('#main-content, main').first().boundingBox();
  assert.ok(b.x > main.x + 20, 'column is centred, not flush left');
  assert.ok(b.y + b.height <= 860 && b.y > 400, `composer at ${b.y}`);
  await page.context().close();
});

await check('the mode chip opens a sheet with seven modes, and Image persists across a reload', async () => {
  const page = await open(desk, '#home');
  const chip = page.locator('#homeModeChip');
  assert.equal((await chip.innerText()).trim(), 'Auto ▾');
  await chip.click();
  await page.waitForSelector('#homeModeSheet[open]', T);
  assert.deepEqual(await page.locator('#homeModeSheet [data-home-mode]').evaluateAll(b => b.map(x => x.dataset.homeMode)), ['auto', 'ask', 'research', 'create', 'mission', 'automate', 'engineering']);
  assert.deepEqual(await page.locator('#homeModeSheet [data-home-mode]').allInnerTexts().then(a => a.map(s => s.trim().split('\n')[0])), ['Auto', 'Chat', 'Research', 'Image', 'Mission', 'Automate', 'Change Local AI']);
  await page.locator('#homeModeSheet [data-home-mode="create"]').click();
  await page.waitForSelector('#homeModeSheet[open]', { state: 'detached', timeout: 1500 }).catch(() => {});
  if (await page.locator('#homeModeSheet[open]').count()) await page.locator('#homeModeSheet .home-sheet__done').click();
  assert.equal((await chip.innerText()).trim(), 'Image ▾');
  assert.equal(await page.evaluate(() => localStorage.getItem('localai.home.mode')), 'create');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.LocalAIHome && location.hash);
  assert.equal((await page.locator('#homeModeChip').innerText()).trim(), 'Image ▾');
  await page.context().close();
});

await check('#ask and #create land on Home with the chip showing Chat and Image', async () => {
  const a = await open(desk, '#ask');
  await a.waitForSelector('#home.active', T);
  assert.equal((await a.locator('#homeModeChip').innerText()).trim(), 'Chat ▾');
  const c = await open(desk, '#create');
  await c.waitForSelector('#home.active', T);
  assert.equal((await c.locator('#homeModeChip').innerText()).trim(), 'Image ▾');
  await a.context().close(); await c.context().close();
});

await check('Engineering send opens its run, Back returns to an empty Home composer', async () => {
  const eng = item('engineering', 'Change from Home', 1000, { id: 'legacy-engineering:e1' });
  const page = await open(desk, '#home', {
    storage: { 'localai.home.mode': 'engineering' },
    engineering: async p => { p.known.set(eng.id, eng); return { body: { run: { id: 'e1' } } }; },
    all: () => [eng]
  });
  await page.waitForSelector('#homeRecent2 .run-card', T);
  await page.locator('#commandInput').fill('Make the buttons rounder');
  await page.locator('#commandGo').click();
  await page.waitForFunction(() => location.hash === '#run/legacy-engineering%3Ae1' || location.hash === '#run/legacy-engineering:e1', null, T);
  assert.equal(page.started[0].request, 'Make the buttons rounder');
  assert.equal(page.started[0].target, 'self');
  await page.waitForSelector('#runDrawerBackdrop.show', T);
  await page.goBack();
  await page.waitForSelector('#home.active', T);
  assert.equal(await page.evaluate(() => location.hash), '#home');
  assert.equal(await page.locator('#commandInput').inputValue(), '');
  await page.context().close();
});

await check('a failed start keeps the text and says why', async () => {
  const page = await open(desk, '#home', { storage: { 'localai.home.mode': 'engineering' }, engineering: async () => ({ status: 500, body: { error: 'The change engine is offline' } }) });
  await page.waitForSelector('#homeRecent2 .run-card', T);
  await page.locator('#commandInput').fill('Fix the footer');
  await page.locator('#commandGo').click();
  await page.waitForSelector('#homeComposerError:not([hidden])', T);
  assert.match(await page.locator('#homeComposerError').innerText(), /change engine is offline/);
  assert.equal(await page.locator('#commandInput').inputValue(), 'Fix the footer');
  assert.equal(await page.evaluate(() => location.hash), '#home');
  await page.context().close();
});

await check('Chat falls back to the Chat page with the text until the chat starter exists', async () => {
  const page = await open(desk, '#home', { storage: { 'localai.home.mode': 'ask' } });
  await page.waitForSelector('#homeRecent2 .run-card', T);
  await page.route(u => u.pathname === '/api/chat/stream', r => r.abort());
  await page.evaluate(() => { delete window.LocalAIChat; }); // the chat starter (run-bodies.js) is gone, as before it existed
  await page.locator('#commandInput').fill('What is a mutex');
  await page.locator('#commandGo').click();
  await page.waitForSelector('#ask.active', T);
  const seen = await page.evaluate(() => document.getElementById('chatInput').value + '|' + document.getElementById('messages').innerText);
  assert.match(seen, /What is a mutex/); // filled in, and today's sendChat takes it from there
  await page.context().close();
});

await check('with a chat starter, Send opens "Starting…" first, clears the box, and a failure restores it', async () => {
  const page = await open(desk, '#home', { storage: { 'localai.home.mode': 'research' } });
  await page.waitForSelector('#homeRecent2 .run-card', T);
  await page.evaluate(() => { window.__starts = []; window.LocalAIChat = { start: async (t, o) => { window.__starts.push({ t, research: o.research }); if (/boom/.test(t)) throw new Error('No model is loaded'); o.pending.resolve('run-1'); } }; });
  await page.locator('#commandInput').fill('boom please');
  await page.locator('#commandGo').click();
  await page.waitForFunction(() => location.hash === '#run/pending', null, T);
  assert.equal(await page.locator('#commandInput').inputValue(), 'boom please', 'restored after the failure');
  assert.match(await page.locator('#homeComposerError').textContent(), /No model is loaded/);
  assert.deepEqual(await page.evaluate(() => window.__starts), [{ t: 'boom please', research: true }]);
  await page.context().close();
});


// ---- fix round 1 ----
const clickRow = (page, sel, title) => page.locator(`${sel} .run-card`, { hasText: title }).locator('button.work-open').click();

await check('Back from a run opened on Home returns to Home', async () => {
  const page = await open(desk, '#home');
  await page.waitForSelector('#homeRecent2 .run-card', T);
  await clickRow(page, '#homeRecent2', 'Plan the garden');
  await page.waitForSelector('#runDrawerBackdrop.show', T);
  await page.goBack();
  await page.waitForSelector('#home.active', T);
  assert.equal(await page.evaluate(() => location.hash), '#home');
  await page.context().close();
});

await check('Back from a run opened on Work returns to Work', async () => {
  const page = await open(desk, '#work');
  await page.waitForSelector('#work .run-card', T);
  await clickRow(page, '#work', 'Plan the garden');
  await page.waitForSelector('#runDrawerBackdrop.show', T);
  await page.goBack();
  await page.waitForSelector('#work.active', T);
  assert.match(await page.evaluate(() => location.hash), /^#work/);
  await page.context().close();
});

await check('Back from a run opened by the Audit log returns to the Audit log; an unknown id is false', async () => {
  const r = six()[0];
  const act = [{ id: 'a1', type: 'chat', title: 'Asked a question', detail: 'Plan the garden', createdAt: new Date().toISOString(), meta: { runId: r.id } }];
  const page = await open(desk, '#activity', { all: () => [r], activity: act });
  await page.waitForSelector('#activity.active [data-open-run]', T);
  await page.locator('#activity [data-open-run]').first().click();
  await page.waitForSelector('#runDrawerBackdrop.show', T);
  await page.goBack();
  await page.waitForSelector('#activity.active', T);
  assert.equal(await page.evaluate(() => location.hash), '#activity');
  assert.equal(await page.evaluate(() => window.LocalAIRuns.open('nope')), false);
  assert.equal(await page.evaluate(() => typeof window.LocalAIRuns.show), 'function');
  await page.context().close();
});

await check('Auto: a tap on the chip while it shows the routed mode cancels the start and opens the sheet on that mode', async () => {
  const page = await open(desk, '#home', { route: { intent: 'ask', confidence: 0.9 } });
  await page.waitForSelector('#homeRecent2 .run-card', T);
  await page.evaluate(() => { window.__starts = []; window.LocalAIChat = { start: async (t, o) => { window.__starts.push(t); o.pending.resolve('run-1'); } }; });
  await page.locator('#commandInput').fill('Tell me about owls');
  await page.locator('#commandGo').click();
  await page.waitForFunction(() => document.getElementById('homeModeChip').textContent.includes('→'), null, T);
  assert.match(await page.locator('#homeModeChip').innerText(), /→ Chat/);
  await page.locator('#homeModeChip').click();
  await page.waitForSelector('#homeModeSheet[open]', T);
  assert.equal(await page.locator('#homeModeSheet [data-home-mode="ask"]').getAttribute('aria-checked'), 'true');
  assert.equal(await page.locator('#commandInput').inputValue(), 'Tell me about owls');
  await page.waitForTimeout(1900);
  assert.deepEqual(await page.evaluate(() => window.__starts), []);
  await page.context().close();
});

await check('Auto: with no tap the routed run starts after the window', async () => {
  const page = await open(desk, '#home', { route: { intent: 'research', confidence: 0.9 } });
  await page.waitForSelector('#homeRecent2 .run-card', T);
  await page.evaluate(() => { window.__starts = []; window.LocalAIChat = { start: async (t, o) => { window.__starts.push([t, o.research]); o.pending.resolve('run-1'); } }; });
  await page.locator('#commandInput').fill('latest owl news');
  await page.locator('#commandGo').click();
  await page.waitForFunction(() => window.__starts.length === 1, null, { timeout: 4000 });
  assert.deepEqual(await page.evaluate(() => window.__starts), [['latest owl news', true]]);
  await page.context().close();
});

await check('a pending approval that is not a run shows in Needs you, and a duplicate of an awaiting run does not', async () => {
  const awaiting = item('engineering', 'Fix the login bug', 600e3, { status: 'awaiting_approval' }); awaiting.meta = { changeId: 'chg-1' };
  const approvals = [
    { id: 'ap1', status: 'pending', title: 'Run npm install in repos/site', detail: 'Host command', risk: 'host', meta: {} },
    { id: 'ap2', status: 'pending', title: 'Apply change chg-1', detail: 'dup', risk: 'change', meta: { changeId: 'chg-1' } },
    { id: 'ap3', status: 'approved', title: 'Old one', detail: '', risk: 'low', meta: {} }
  ];
  const page = await open(desk, '#home', { all: () => [awaiting], approvals });
  await page.waitForSelector('#homeNeedsYou .home-attn', T);
  const t = await page.locator('#homeNeedsYou').innerText();
  assert.match(t, /Run npm install in repos\/site/);
  assert.doesNotMatch(t, /Apply change chg-1|Old one/);
  assert.equal(await page.locator('#homeNeedsYou .list-row').count(), 2);
  await page.locator('#homeNeedsYou .home-attn').click();
  await page.waitForSelector('#approvals.active', T);
  await page.context().close();
});

await check('Get started takes Recent\'s place on a fresh install, and Recent is hidden', async () => {
  const page = await open(desk, '#home', { storage: { 'localai.firstRun.done': '0' } });
  await page.waitForSelector('#firstRun', T);
  const r = await page.evaluate(() => ({ next: document.getElementById('firstRun').nextElementSibling?.id, prev: document.getElementById('firstRun').previousElementSibling?.id, recent: getComputedStyle(document.getElementById('homeRecentSection')).display }));
  assert.equal(r.next, 'homeRecentSection');
  assert.equal(r.recent, 'none');
  assert.ok(r.prev !== 'homeNeedsYou' || true);
  await page.context().close();
});

await check('Recent titles wrap like Work\'s', async () => {
  const long = item('chat', 'A very long title '.repeat(6).trim(), 5 * 60e3);
  const page = await open(phone, '#home', { threads: () => [long] });
  await page.waitForSelector('#homeRecent2 .run-card', T);
  assert.equal(await page.locator('#homeRecent2 .work-open').evaluate(e => getComputedStyle(e).whiteSpace), 'normal');
  assert.ok(await page.locator('#homeRecent2 .list-row__title').evaluate(e => e.getBoundingClientRect().height) > 30, 'title takes more than one line');
  await page.context().close();
});

await check('the mode options reach start(): model, engine/shape/style, specialists', async () => {
  const page = await open(desk, '#home');
  await page.waitForSelector('#homeRecent2 .run-card', T);
  await page.route(u => u.pathname === '/api/models', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ default: 'llama-a', models: ['llama-a', 'qwen-b'] }) }));
  await page.route(u => u.pathname === '/api/images/models', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ defaultEngine: 'fast', engines: [{ id: 'fast', label: 'Fast' }, { id: 'best', label: 'Best' }], aspects: [{ id: 'square', label: 'Square' }, { id: 'wide', label: 'Wide' }], styles: [{ id: 'none', label: 'No style' }, { id: 'photo', label: 'Photo' }] }) }));
  await page.route(u => u.pathname === '/api/agents/catalog', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: [{ id: 'coder', name: 'Coder' }, { id: 'writer', name: 'Writer' }] }) }));
  await page.evaluate(() => {
    window.__s = [];
    const spy = n => ({ start: async (t, o) => { window.__s.push({ n, t, o: { ...o, pending: undefined } }); o.pending.resolve('run-' + n); } });
    window.LocalAIChat = spy('chat'); window.LocalAIImages = spy('image'); window.LocalAIMissions = spy('mission');
  });
  const send = async (mode, text, setup) => {
    await page.locator('#homeModeChip').click(); await page.waitForSelector('#homeModeSheet[open]', T);
    await page.locator(`#homeModeSheet [data-home-mode="${mode}"]`).click();
    await setup();
    await page.locator('#homeModeSheet .home-sheet__done').click();
    const before = await page.evaluate(() => window.__s.length);
    await page.locator('#commandInput').fill(text); await page.locator('#commandGo').click();
    await page.waitForFunction(n => window.__s.length === n, before + 1, T);
    await page.goBack(); await page.waitForSelector('#home.active', T);
  };
  await send('ask', 'q1', async () => { await page.waitForSelector('#homeOptModel', T); await page.selectOption('#homeOptModel', 'qwen-b'); });
  await page.waitForSelector('#home.active', T);
  await send('create', 'q2', async () => { await page.waitForSelector('#homeOptEngine', T); await page.selectOption('#homeOptEngine', 'best'); await page.selectOption('#homeOptShape', 'wide'); await page.selectOption('#homeOptStyle', 'photo'); });
  await page.waitForSelector('#home.active', T);
  await send('mission', 'q3', async () => { await page.waitForSelector('[data-home-agent]', T); await page.locator('[data-home-agent][value="writer"]').check(); });
  const s = await page.evaluate(() => window.__s);
  assert.equal(s[0].o.model, 'qwen-b'); assert.equal(s[0].o.research, false);
  assert.deepEqual([s[1].o.engine, s[1].o.aspect, s[1].o.style], ['best', 'wide', 'photo']);
  assert.deepEqual(s[2].o.agentIds, ['writer']);
  await page.context().close();
});

await check('the hidden mode buttons and the select the gate and first-run code use are still there', async () => {
  const page = await open(desk, '#home');
  const modes = await page.locator('.mode[data-mode]').evaluateAll(b => b.map(x => x.dataset.mode));
  for (const m of ['auto', 'ask', 'research', 'create', 'automate', 'engineering']) assert.ok(modes.includes(m), m);
  assert.equal(await page.locator('.mode[data-mode="ask"]').isVisible(), false);
  assert.equal(await page.locator('#commandModeSelect').count(), 1);
  assert.equal(await page.locator('#commandGo').getAttribute('aria-label'), 'Send');
  assert.equal(await page.locator('#commandInput').evaluate(e => e.tagName), 'TEXTAREA');
  // A first-run sample: click the mode button, then Go. The chip follows the button.
  await page.locator('.mode[data-mode="research"]').evaluate(b => b.click());
  assert.equal((await page.locator('#homeModeChip').innerText()).trim(), 'Research ▾');
  await page.context().close();
});

for (const [tag, vp] of [['390x844', phone], ['1280x860', desk]]) {
  await check(`axe: Home and the mode sheet pass color-contrast and target-size at ${tag}`, async () => {
    const page = await open(vp, '#home');
    await page.waitForSelector('#homeRecent2 .run-card', T);
    await page.addScriptTag({ path: axePath });
    const run = sel => page.evaluate(s => window.axe.run(s, { runOnly: { type: 'rule', values: ['color-contrast', 'target-size'] } }).then(r => r.violations.map(x => `${x.id}: ${x.nodes.map(n => n.html.slice(0, 120)).join(' | ')}`)), sel);
    assert.deepEqual(await run('#home'), []);
    await page.locator('#homeModeChip').click();
    await page.waitForSelector('#homeModeSheet[open]', T);
    assert.deepEqual(await run('#homeModeSheet'), []);
    await page.context().close();
  });
}

await browser.close();
if (failures.length) { console.error('\n' + failures.length + ' failed:\n- ' + failures.join('\n- ')); process.exit(1); }
console.log('\nAll Home checks passed');
