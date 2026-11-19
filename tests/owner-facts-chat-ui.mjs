import './browser-target-guard.mjs';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { addAxe } from './axe-helper.mjs';

// Owner facts under a chat answer (docs/superpowers/specs/2026-11-19-owner-facts-design.md §3, §4): "Used 2 of your
// saved facts" (a link to Memory), "Your saved facts weren't used: this answer came from a cloud model." and the
// failed-read warning, beside the project-notes line. The API is stubbed with runs as /api/runs sends them (their
// card from app/run-cards.js); the page and run view are the real ones. LOCALAI_SHOTS=<dir> saves screenshots.
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
const desk = { width: 1280, height: 860 }, phone = { width: 390, height: 844 };
const NOW = Date.now();
const THREAD = 't-' + 'c3'.repeat(16);
const USED = { text: 'Used 2 of your saved facts', count: 2, unread: false, cloud: false };
const CLOUD = { text: "Your saved facts weren't used: this answer came from a cloud model.", count: 0, unread: false, cloud: true };
const UNREAD = { text: "Couldn't read your saved facts", count: 0, unread: true, cloud: false };
const NOTES = { text: 'Used 1 note from RIFT tiles', projectId: 'prj_rift', count: 1, unread: false };
const run = (n, prompt, text, { facts = null, memory = null, status = 'completed', route = 'Answered on this PC' } = {}) => ({
  id: `run-${NOW + n * 1000}-${n}`, type: 'chat', status, progress: 100, threadId: THREAD,
  title: prompt.slice(0, 40), createdAt: new Date(NOW + n * 1000).toISOString(), updatedAt: new Date(NOW + n * 1000).toISOString(),
  input: { prompt, model: 'm' }, output: { text }, artifactIds: [], kept: true,
  card: { kind: 'chat', icon: 'compose', title: prompt, summary: text, badge: { label: 'Done', tone: 'good' }, preview: null, action: { label: 'Open' }, approval: null, route: { text: route, why: '' }, memory, facts }
});

async function open(viewport, runs, scheme = 'dark') {
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport, isMobile: viewport.width < 760, hasTouch: viewport.width < 760, colorScheme: scheme, reducedMotion: 'reduce' });
  await ctx.addInitScript(() => { try { localStorage.setItem('localai.firstRun.done', '1'); } catch {} });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  const json = (r, body, status = 200) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await ctx.route(u => u.pathname === '/api/approvals', r => json(r, { items: [] }));
  await page.route(u => u.pathname === '/api/capabilities', r => json(r, { services: ['ollama', 'search'].map(name => ({ name, label: name, state: 'HEALTHY', required: true })), models: { defaultInstalled: true }, images: { available: true }, version: '1' }));
  await page.route(u => u.pathname === '/api/memory', r => json(r, { items: [] }));
  await page.route(u => u.pathname === '/api/runs', r => {
    const q = new URL(r.request().url()).searchParams;
    if (q.get('id')) { const it = runs.find(x => x.id === q.get('id')); return it ? json(r, { item: it }) : json(r, { error: 'Run not found' }, 404); }
    if (q.get('threadId')) return json(r, { items: runs.filter(x => x.threadId === q.get('threadId')), summary: {} });
    json(r, { items: runs, summary: {} });
  });
  await page.goto(base + '/#home', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.showView === 'function' && window.LocalAIRouter && window.LocalAIRuns, null, { timeout: 8000 });
  return page;
}
const openRun = async (page, id) => { await page.evaluate(i => window.LocalAIRuns.show(i), id); await page.locator('#runDrawer .chat-turn--assistant').first().waitFor(T); };
async function axe(page, scope) {
  await addAxe(page, axePath);
  return page.evaluate(sel => window.axe.run(sel, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] } })
    .then(r => r.violations.filter(x => ['serious', 'critical'].includes(x.impact)).map(x => `${x.id}: ${x.nodes.slice(0, 3).map(n => n.target.join(' ')).join(' | ')}`)), scope);
}
const shot = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`) }); };

for (const [viewport, scheme] of [[desk, 'dark'], [phone, 'light'], [phone, 'dark'], [desk, 'light']]) {
  const tag = `${viewport.width}px ${scheme}`;
  await check(`${tag}: "Used 2 of your saved facts" sits under the answer before the notes line, and links to Memory`, async () => {
    const runs = [run(1, 'Which filament?', 'PLA.'), run(2, 'What nozzle temperature should I use?', 'Use 210 °C for your PLA.', { facts: USED, memory: NOTES })];
    const page = await open(viewport, runs, scheme);
    await openRun(page, runs[1].id);
    const answer = page.locator('#runDrawer .chat-turn--assistant', { hasText: 'Use 210 °C' });
    await answer.locator('.run-memory').nth(1).waitFor(T);
    assert.deepEqual((await answer.locator('.run-memory').allInnerTexts()).map(s => s.trim()), ['Used 2 of your saved facts', 'Used 1 note from RIFT tiles']);
    assert.equal(await page.locator('#runDrawer .run-memory').count(), 2, 'only the turn that used them has lines');
    const link = answer.locator('.run-memory a', { hasText: 'Used 2 of your saved facts' });
    assert.equal(await link.getAttribute('href'), '#memory');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, 'no horizontal overflow');
    assert.deepEqual(await axe(page, '#runDrawer'), []);
    await shot(page, `facts-used-${viewport.width}-${scheme}`);
    await link.focus();
    assert.equal(await link.evaluate(a => a.matches(':focus-visible') || getComputedStyle(a).outlineStyle !== 'none'), true, 'visible focus');
    await page.keyboard.press('Enter');
    await page.locator('#memory.active').waitFor(T);
    await page.locator('#ownerFacts').waitFor(T);
    assert.deepEqual(page.errors, []);
    await page.context().close();
  });
}

await check('a cloud answer says the facts weren\'t used, as plain text, with no link and no warning', async () => {
  const runs = [run(1, 'Compare PETG and ASA', 'ASA for outdoors.', { facts: CLOUD, route: 'Answered by Llama 3.3 70B · Groq' })];
  const page = await open(desk, runs);
  await openRun(page, runs[0].id);
  const line = page.locator('#runDrawer .run-memory');
  await line.waitFor(T);
  assert.equal((await line.innerText()).trim(), "Your saved facts weren't used: this answer came from a cloud model.");
  assert.equal(await line.locator('a').count(), 0);
  assert.doesNotMatch(await line.getAttribute('class'), /ui-notice/);
  assert.deepEqual(await axe(page, '#runDrawer'), []);
  await shot(page, 'facts-cloud-1280-dark');
  await page.context().close();
});

await check('a failed read warns "Couldn\'t read your saved facts", never "Used 0", and offers Memory', async () => {
  const runs = [run(1, 'What nozzle temperature?', 'Most PLA prints at 200–220 °C.', { facts: UNREAD })];
  const page = await open(phone, runs, 'light');
  await openRun(page, runs[0].id);
  const line = page.locator('#runDrawer .run-memory');
  await line.waitFor(T);
  assert.match(await line.getAttribute('class'), /ui-notice--warn/);
  assert.match(await line.innerText(), /^Couldn't read your saved facts\. This answer was written without them\. Open Memory$/);
  assert.equal(await line.locator('a').getAttribute('href'), '#memory');
  assert.doesNotMatch(await page.locator('#runDrawer').innerText(), /Used 0|no facts/i);
  assert.deepEqual(await axe(page, '#runDrawer'), []);
  await shot(page, 'facts-unread-390-light');
  await page.context().close();
});

await browser.close();
if (failures.length) { console.error(`\n${failures.length} failed:\n${failures.join('\n')}`); process.exit(1); }
