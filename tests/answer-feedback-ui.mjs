// Answer feedback in the browser (docs/superpowers/specs/2026-11-19-answer-feedback-design.md): Good answer / Not right
// under a finished answer (press, change, clear, the note, a failed save, keyboard only), none on a failed run, the
// Past work body, and Models › How answers have landed in its empty, loaded and failed states. axe on both. The
// server's routes are stubbed in the page, so it runs against any server at LOCALAI_URL. SHOTS=<dir> saves screenshots.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addAxe } from './axe-helper.mjs';

const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const axePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'vendor', 'axe.min.js');
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];
const shots = process.env.SHOTS || '';
const browser = await chromium.launch({ headless: true });
const T = { timeout: 6000 };
const failures = [];
async function check(name, fn) { try { await fn(); console.log('PASS', name); } catch (e) { failures.push(`${name}: ${e.message}`); console.error('FAIL', name, e.message); } }
const shot = async (page, name) => { if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, name), fullPage: false }); } };
const axe = async (page, sel) => { await addAxe(page, axePath); return page.evaluate(([s, tags]) => window.axe.run(document.querySelector(s), { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] }).then(r => r.violations.filter(v => ['serious', 'critical'].includes(v.impact)).map(x => `${x.id}: ${x.nodes.map(n => n.target.join(' ')).join(', ')}`)), [sel, TAGS]); };

const NOW = Date.now();
const route = { text: 'Answered on this PC', why: 'House question' };
const run = (id, o = {}) => ({
  id, type: o.type || 'chat', status: o.status || 'completed', progress: 100, threadId: o.threadId || id, title: o.prompt || 'Which filament for an outdoor bracket?',
  createdAt: new Date(NOW - (o.ago || 0)).toISOString(), updatedAt: new Date(NOW - (o.ago || 0)).toISOString(),
  input: { prompt: o.prompt || 'Which filament for an outdoor bracket?' }, output: o.output === undefined ? { text: o.text || 'ASA: it shrugs off sun and heat better than PETG.' } : o.output,
  error: o.error || null, meta: o.meta || { route: { provider: 'ollama', model: 'qwen3:4b', class: 'private', why: 'House question' } },
  card: { kind: o.type || 'chat', icon: 'compose', title: o.prompt || 'Which filament for an outdoor bracket?', summary: '', badge: { label: o.status === 'failed' ? 'Failed' : 'Done', tone: o.status === 'failed' ? 'bad' : 'good' }, preview: null, action: { label: 'Open' }, approval: null, route: o.status === 'failed' ? null : route, ...(o.feedback !== undefined ? { feedback: o.feedback } : {}) }
});

const SUMMARY = {
  total: 6,
  days30: { since: '', good: 4, bad: 1, rows: [{ provider: 'ollama', model: 'qwen3:4b', good: 3, bad: 1 }, { provider: 'groq', model: 'llama-3.3-70b-versatile', good: 1, bad: 0 }] },
  days90: { since: '', good: 5, bad: 1, rows: [{ provider: 'ollama', model: 'qwen3:4b', good: 4, bad: 1 }, { provider: 'groq', model: 'llama-3.3-70b-versatile', good: 1, bad: 0 }] },
  recent: [
    { runId: 'run-kept', at: new Date(NOW - 3600e3).toISOString(), kind: 'chat', provider: 'ollama', model: 'qwen3:4b', note: 'It suggested PLA for a hot car', asked: 'Which filament for a dashboard clip?', kept: true },
    { runId: 'run-gone', at: new Date(NOW - 40 * 86400e3).toISOString(), kind: 'research', provider: '', model: '', note: '', asked: 'When does the hardware store close?', kept: false }
  ]
};

// db.runs: the ledger the stub serves; db.posts: each POST /api/runs/feedback body; db.fail: answer the next ones with 503.
async function open(viewport, { runs = [], summary = SUMMARY, summaryStatus = 200, scheme = 'dark' } = {}) {
  const db = { runs, posts: [], fail: false, summary, summaryStatus, verdicts: {} };
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport, colorScheme: scheme, reducedMotion: 'reduce', isMobile: viewport.width < 760, hasTouch: viewport.width < 760 });
  await ctx.addInitScript(() => { try { localStorage.setItem('localai.firstRun.done', '1'); } catch {} });
  const page = await ctx.newPage();
  page.db = db; page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  const json = (r, body, status = 200) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const withVerdict = x => db.verdicts[x.id] === undefined ? x : { ...x, card: { ...x.card, feedback: db.verdicts[x.id] } };
  await page.route(u => u.pathname === '/api/runs', r => {
    const q = new URL(r.request().url()).searchParams;
    if (q.get('id')) { const it = db.runs.find(x => x.id === q.get('id')); return it ? json(r, { item: withVerdict(it) }) : json(r, { error: 'Run not found' }, 404); }
    if (q.get('threadId')) return json(r, { items: db.runs.filter(x => x.threadId === q.get('threadId')).map(withVerdict), summary: {} });
    json(r, { items: db.runs.map(withVerdict), summary: {} });
  });
  await page.route(u => u.pathname === '/api/runs/feedback', async r => {
    const b = JSON.parse(r.request().postData() || '{}'); db.posts.push(b);
    if (db.hold) await db.hold;
    if (db.fail) return json(r, { error: "Couldn't read or save answer ratings right now." }, 503);
    db.verdicts[b.id] = b.verdict ? { verdict: b.verdict, note: b.verdict === 'bad' ? (b.note || '') : '' } : null;
    json(r, { feedback: b.verdict ? { runId: b.id, verdict: b.verdict, note: b.verdict === 'bad' ? (b.note || '') : '', at: new Date().toISOString() } : null });
  });
  await page.route(u => u.pathname === '/api/runs/feedback/summary', r => db.summaryStatus === 200 ? json(r, db.summary) : json(r, { error: "Couldn't read or save answer ratings right now." }, db.summaryStatus));
  await page.goto(base + '/#home', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.showView === 'function' && window.LocalAIRouter, null, { timeout: 8000 });
  return page;
}
const pressed = page => page.evaluate(() => [...document.querySelectorAll('#runDrawer .answer-feedback button[data-verdict]')].map(b => `${b.dataset.verdict}:${b.getAttribute('aria-pressed')}`));
const toast = page => page.evaluate(() => document.getElementById('toast')?.textContent || '');
const openRun = async (page, id) => { await page.evaluate(h => window.LocalAIRouter.go(h), `#run/${id}`); await page.locator('#runDrawer .answer-feedback button[data-verdict="good"]').waitFor(T); };

const desk = { width: 1280, height: 860 }, phone = { width: 390, height: 844 }, tablet = { width: 820, height: 1180 };

await check('press Good answer, change to Not right with a note, then clear; each saved and announced', async () => {
  const page = await open(desk, { runs: [run('run-a', { feedback: null })] });
  await openRun(page, 'run-a');
  assert.deepEqual(await pressed(page), ['good:false', 'bad:false']);
  // The route line shares the control's row.
  assert.equal(await page.locator('#runDrawer .chat-turn .answer-feedback > .run-route').count(), 1);
  const good = page.getByRole('button', { name: 'Good answer' }), bad = page.getByRole('button', { name: 'Not right' });
  await good.click();
  await page.waitForFunction(() => document.querySelector('#runDrawer button[data-verdict="good"]')?.getAttribute('aria-pressed') === 'true', null, T);
  assert.deepEqual(page.db.posts.at(-1), { id: 'run-a', verdict: 'good' });
  assert.match(await toast(page), /Marked as a good answer/);
  assert.equal(await page.locator('#runDrawer .answer-feedback__note').isHidden(), true, 'no note field after Good answer');

  await bad.click();
  await page.waitForFunction(() => document.querySelector('#runDrawer button[data-verdict="bad"]')?.getAttribute('aria-pressed') === 'true', null, T);
  assert.deepEqual(await pressed(page), ['good:false', 'bad:true']);
  assert.match(await toast(page), /Marked as not right/);
  const field = page.getByLabel('What was wrong? (optional)');
  await field.waitFor(T);
  assert.equal(await field.getAttribute('maxlength'), '300');
  await shot(page, 'feedback-note-desktop-dark.png');
  await field.fill('It forgot ASA needs an enclosure');
  await page.getByRole('button', { name: 'Save note' }).click();
  await page.waitForFunction(() => document.querySelector('#runDrawer .answer-feedback__note')?.hidden === true, null, T);
  assert.deepEqual(page.db.posts.at(-1), { id: 'run-a', verdict: 'bad', note: 'It forgot ASA needs an enclosure' });
  assert.match(await toast(page), /Saved what was wrong/);
  assert.equal(await page.evaluate(() => document.activeElement?.dataset?.verdict), 'bad', 'focus goes back to Not right');

  await bad.click();
  await page.waitForFunction(() => document.querySelector('#runDrawer button[data-verdict="bad"]')?.getAttribute('aria-pressed') === 'false', null, T);
  assert.deepEqual(page.db.posts.at(-1), { id: 'run-a', verdict: null });
  assert.deepEqual(await pressed(page), ['good:false', 'bad:false']);
  assert.match(await toast(page), /Rating cleared/);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

await check('a saved verdict comes back from the run card; skipping the note keeps Not right', async () => {
  const page = await open(desk, { runs: [run('run-b', { feedback: { verdict: 'bad', note: 'Wrong year' } })] });
  await openRun(page, 'run-b');
  assert.deepEqual(await pressed(page), ['good:false', 'bad:true']);
  assert.equal(await page.locator('#runDrawer .answer-feedback__note').isHidden(), true, 'an old verdict does not open the note');
  await page.context().close();
});

await check('a failed save says so, and the button keeps its earlier state (never shown as saved)', async () => {
  const page = await open(desk, { runs: [run('run-c', { feedback: { verdict: 'good', note: '' } })] });
  await openRun(page, 'run-c');
  page.db.fail = true;
  let release; page.db.hold = new Promise(r => { release = r; });
  await page.getByRole('button', { name: 'Not right' }).click();
  // Saving: the control says so and nothing is pressed yet.
  await page.waitForFunction(() => /Saving/.test(document.querySelector('#runDrawer .answer-feedback__state')?.textContent || ''), null, T);
  assert.equal(await page.locator('#runDrawer button[data-verdict="bad"]').getAttribute('aria-busy'), 'true');
  assert.deepEqual(await pressed(page), ['good:true', 'bad:false']);
  release();
  const fail = page.locator('#runDrawer .answer-feedback__fail');
  await fail.waitFor({ state: 'visible', ...T });
  assert.equal(await fail.innerText(), "Couldn't save that. Try again.");
  assert.equal(await fail.getAttribute('role'), 'alert');
  assert.deepEqual(await pressed(page), ['good:true', 'bad:false']);
  assert.equal(await page.locator('#runDrawer .answer-feedback__note').isHidden(), true);
  assert.equal(await page.locator('#runDrawer button[data-verdict="bad"]').getAttribute('aria-busy'), null);
  await shot(page, 'feedback-failed-desktop-dark.png');
  // Trying again works and clears the message.
  page.db.fail = false; page.db.hold = null;
  await page.getByRole('button', { name: 'Not right' }).click();
  await page.waitForFunction(() => document.querySelector('#runDrawer button[data-verdict="bad"]')?.getAttribute('aria-pressed') === 'true', null, T);
  assert.equal(await fail.isHidden(), true);
  await page.context().close();
});

await check('keyboard only: Tab reaches the buttons after the answer, Enter and Space press them, the note saves with Enter', async () => {
  const page = await open(desk, { runs: [run('run-k', { feedback: null })] });
  await openRun(page, 'run-k');
  await page.evaluate(() => { const h = document.querySelector('#runDrawer h1, #runDrawer h2'); h.tabIndex = -1; h.focus(); });
  let reached = false;
  for (let i = 0; i < 30 && !reached; i++) { await page.keyboard.press('Tab'); reached = await page.evaluate(() => document.activeElement?.dataset?.verdict === 'good'); }
  assert.ok(reached, 'Tab reaches Good answer');
  const ring = await page.evaluate(() => { const s = getComputedStyle(document.activeElement); return s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0; });
  assert.ok(ring, 'the focused button shows a focus ring');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-pressed') === 'true', null, T);
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.dataset?.verdict), 'bad');
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.querySelector('#runDrawer button[data-verdict="bad"]')?.getAttribute('aria-pressed') === 'true', null, T);
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.closest('.answer-feedback__note') !== null && document.activeElement.tagName), 'INPUT');
  await page.keyboard.type('Too vague');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#runDrawer .answer-feedback__note')?.hidden === true, null, T);
  assert.deepEqual(page.db.posts.map(p => p.verdict), ['good', 'bad', 'bad']);
  assert.equal(page.db.posts.at(-1).note, 'Too vague');
  await page.context().close();
});

await check('no control on a failed answer; Past work answers have one', async () => {
  const page = await open(desk, { runs: [run('run-f', { status: 'failed', output: null, error: 'The local model is not answering.', meta: {} }),
    run('run-p', { type: 'prompt', prompt: 'What did I ask about yesterday?', meta: { mode: 'history', route: { provider: 'ollama', model: 'qwen3:4b', class: 'private', why: 'Past work' } }, output: { text: 'You asked about PETG.', citations: [], entries: [], from: 'journal' }, feedback: null })] });
  await page.evaluate(() => window.LocalAIRouter.go('#run/run-f'));
  await page.locator('#runDrawer .chat-turn--assistant').waitFor(T);
  await page.waitForTimeout(400);
  assert.equal(await page.locator('#runDrawer .answer-feedback').count(), 0);
  await openRun(page, 'run-p');
  await page.getByRole('button', { name: 'Good answer' }).click();
  await page.waitForFunction(() => document.querySelector('#runDrawer button[data-verdict="good"]')?.getAttribute('aria-pressed') === 'true', null, T);
  assert.deepEqual(page.db.posts.at(-1), { id: 'run-p', verdict: 'good' });
  await page.context().close();
});

for (const [name, viewport] of [['phone', phone], ['tablet', tablet], ['desktop', desk]]) for (const scheme of ['dark', 'light']) {
  await check(`${name} ${scheme}: the control is axe-clean, fits, and has touch-size targets`, async () => {
    const page = await open(viewport, { scheme, runs: [run('run-v', { feedback: { verdict: 'bad', note: '' }, text: 'ASA: it shrugs off sun and heat better than PETG, but it needs an enclosure and good ventilation while printing.' })] });
    await openRun(page, 'run-v');
    await page.getByRole('button', { name: 'Not right' }).click();   // clears it
    await page.getByRole('button', { name: 'Not right' }).click();   // and back, with the note open
    await page.getByLabel('What was wrong? (optional)').waitFor(T);
    assert.deepEqual(await axe(page, '#runDrawer'), []);
    const sizes = await page.evaluate(() => [...document.querySelectorAll('#runDrawer .answer-feedback button')].map(b => Math.round(b.getBoundingClientRect().height)));
    if (viewport.width < 760) assert.ok(sizes.every(h => h >= 44), `touch targets: ${sizes}`);
    const over = await page.evaluate(() => { const r = document.querySelector('#runDrawer .answer-feedback').getBoundingClientRect(); return r.right > document.documentElement.clientWidth + 1; });
    assert.equal(over, false, 'no horizontal overflow');
    await page.locator('#runDrawer .answer-feedback').scrollIntoViewIfNeeded();
    await shot(page, `feedback-${name}-${scheme}.png`);
    await page.context().close();
  });
}

await check('Models › How answers have landed: loaded, with counts by model, links to kept runs and "no longer kept"', async () => {
  for (const [name, viewport] of [['phone', phone], ['desktop', desk]]) for (const scheme of ['dark', 'light']) {
    const page = await open(viewport, { scheme });
    await page.evaluate(() => window.showView('models'));
    await page.locator('#answerFeedbackBody table').first().waitFor(T);
    const captions = await page.locator('#answerFeedbackBody caption').allInnerTexts();
    assert.deepEqual(captions, ['Last 30 days: 4 good, 1 not right', 'Last 90 days: 5 good, 1 not right']);
    const first = await page.locator('#answerFeedbackBody table').first().locator('tbody tr').first().innerText();
    assert.match(first, /On this PC · qwen3:4b/); assert.match(first, /75%/);
    const link = page.locator('#answerFeedbackRecent a');
    assert.equal(await link.count(), 1);
    assert.equal(await link.getAttribute('href'), '#run/run-kept');
    const rows = await page.locator('#answerFeedbackRecent li').allInnerTexts();
    assert.match(rows[0], /It suggested PLA for a hot car/);
    assert.match(rows[1], /No note/); assert.match(rows[1], /Not recorded/); assert.match(rows[1], /this run is no longer kept/);
    assert.deepEqual(await axe(page, '#modelRouting'), []);
    await page.locator('#answerFeedback').scrollIntoViewIfNeeded();
    await shot(page, `models-feedback-loaded-${name}-${scheme}.png`);
    assert.deepEqual(page.errors, []);
    await page.context().close();
  }
});

await check('Models › How answers have landed: empty says how to rate; a failed read says so and never shows zeros', async () => {
  const page = await open(desk, { summary: { total: 0, days30: { since: '', good: 0, bad: 0, rows: [] }, days90: { since: '', good: 0, bad: 0, rows: [] }, recent: [] } });
  await page.evaluate(() => window.showView('models'));
  await page.locator('#answerFeedbackBody .state-empty').waitFor(T);
  assert.equal(await page.locator('#answerFeedbackBody').innerText(), 'No answers rated yet. Use the buttons under an answer.');
  assert.deepEqual(await axe(page, '#modelRouting'), []);
  await page.locator('#answerFeedback').scrollIntoViewIfNeeded();
  await shot(page, 'models-feedback-empty-desktop-dark.png');
  await page.context().close();

  const bad = await open(desk, { summaryStatus: 503 });
  await bad.evaluate(() => window.showView('models'));
  await bad.locator('#answerFeedbackBody .state-error').waitFor(T);
  const text = await bad.locator('#answerFeedbackBody').innerText();
  assert.match(text, /Couldn't load how answers have landed/);
  assert.doesNotMatch(text, /\b0\b|No answers rated/);
  assert.equal(await bad.locator('#answerFeedbackBody table').count(), 0);
  assert.deepEqual(await axe(bad, '#modelRouting'), []);
  await bad.locator('#answerFeedback').scrollIntoViewIfNeeded();
  await shot(bad, 'models-feedback-failed-desktop-dark.png');
  // Retry reads again.
  bad.db.summaryStatus = 200;
  await bad.locator('#answerFeedbackBody .state-error button').click();
  await bad.locator('#answerFeedbackBody table').first().waitFor(T);
  await bad.context().close();
});

await browser.close();
if (failures.length) { console.error(`\n${failures.length} failed:\n${failures.join('\n')}`); process.exit(1); }
console.log('\nanswer feedback: all passed');
