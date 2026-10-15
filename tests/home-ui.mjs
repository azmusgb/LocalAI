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
async function open(viewport, hash, { threads = six, all = needs, engineering = null, storage = {}, caps = null } = {}) {
  capabilities = caps || (() => ({ services: ['ollama', 'search', 'comfy', 'n8n'].map(name => ({ name, label: name, state: 'HEALTHY', required: true })), models: { defaultInstalled: true }, images: { available: true }, version: '1' }));
  const ctx = await browser.newContext({ viewport, isMobile: viewport.width < 760, hasTouch: viewport.width < 760 });
  await ctx.addInitScript(s => { try { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); } } catch {} }, { 'localai.devTools': '1', 'localai.firstRun.done': '1', ...storage });
  const page = await ctx.newPage();
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
