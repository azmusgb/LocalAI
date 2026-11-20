import './browser-target-guard.mjs';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { addAxe } from './axe-helper.mjs';

// Suggested facts (docs/superpowers/specs/2026-11-19-owner-facts-design.md §2, §4, D3; owner facts PR 2): on Projects ›
// Memory, "Suggested by Local AI" in About you and the house with Save, Edit and No, its failed read, a full list, a
// failed save that keeps the text, a long suggestion, keyboard and focus; and under a chat answer the one quiet line
// "Local AI suggests remembering: …" with a link to Memory. The API is stubbed in the page with the server's rules
// (app/fact-suggestions.js decide); the page, run view and scripts are the real ones. LOCALAI_SHOTS=<dir> saves screenshots.
const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const shots = process.env.LOCALAI_SHOTS || '';
if (shots) mkdirSync(shots, { recursive: true });
const axePath = join(dirname(fileURLToPath(import.meta.url)), 'vendor', 'axe.min.js');
const browser = await chromium.launch({ headless: true });
const T = { timeout: 8000 };
const failures = [];
async function check(name, fn) {
  try { await fn(); console.log('PASS', name); } catch (error) { failures.push(`${name}: ${error.message}`); console.error('FAIL', name, error.message); }
}
const desk = { width: 1280, height: 900 }, phone = { width: 390, height: 844 };
const NOW = Date.now();
const iso = n => new Date(Date.UTC(2026, 10, 1, 12) + n * 3600e3).toISOString();
const fact = (id, text, n = 0) => ({ id, projectId: '', category: 'owner', text, pinned: false, createdAt: iso(n), updatedAt: iso(n) });
const sug = (id, text, runId = 'run-x') => ({ id, text, createdAt: iso(100), runId, caller: 'host' });
const FULL = Array.from({ length: 30 }, (_, i) => fact('f' + i, `Fact number ${i + 1}.`, i));
const PLA = 'You print mostly PLA on a Bambu X2D.', METRIC = 'You prefer answers in metric units.';
const LONG = ('You keep every spool of filament in a sealed dry box with fresh desiccant beside the printer in the garage, ' +
  'labelled by brand, colour and the date it was opened, and you dry nylon before each print').slice(0, 199) + '.';
const THREAD = 't-' + 'f5'.repeat(16);
const USED = { text: 'Used 2 of your saved facts', count: 2, unread: false, cloud: false };
const chatRun = (n, prompt, text, { fresh = true, facts = null } = {}) => {
  const at = new Date(fresh ? NOW + n * 1000 : NOW - 3600e3 + n * 1000).toISOString();
  return {
    id: `run-${n}-${fresh ? 'new' : 'old'}`, type: 'chat', status: 'completed', progress: 100, threadId: THREAD, title: prompt.slice(0, 40),
    createdAt: at, updatedAt: at, finishedAt: at, input: { prompt, model: 'm' }, output: { text }, artifactIds: [], kept: true,
    card: { kind: 'chat', icon: 'compose', title: prompt, summary: text, badge: { label: 'Done', tone: 'good' }, preview: null, action: { label: 'Open' }, approval: null, route: { text: 'Answered on this PC', why: '' }, memory: null, facts }
  };
};

// fail: { read: status, decide: status } answers with that status instead. suggestions: the pending list.
// expanded: the facts group starts unfolded (its sessionStorage key). holdRead: the suggestions read waits for page.db.letRead().
async function open(viewport, { items = [], suggestions = [], fail = {}, scheme = 'dark', hash = '#memory', runs = [], expanded = true, holdRead = false } = {}) {
  const db = { items: items.map(x => ({ ...x })), sugs: suggestions.map(x => ({ ...x })), posts: [], reads: 0, fail: { ...fail } };
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport, isMobile: viewport.width < 760, hasTouch: viewport.width < 760, colorScheme: scheme, reducedMotion: 'reduce' });
  await ctx.addInitScript(on => { try { localStorage.setItem('localai.firstRun.done', '1'); if (on) sessionStorage.setItem('localai.ownerFacts.expanded', '1'); } catch {} }, expanded);
  if (holdRead) db.readHeld = new Promise(r => { db.letRead = r; });
  const page = await ctx.newPage();
  page.db = db; page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  const json = (r, body, status = 200) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const facts = () => db.items.filter(x => x.category === 'owner' && !x.projectId);
  const one = t => String(t || '').replace(/\s+/g, ' ').trim();
  await ctx.route(u => u.pathname === '/api/approvals', r => json(r, { items: [] }));
  await page.route(u => u.pathname === '/api/projects', r => json(r, { items: [], total: 0 }));
  await page.route(u => u.pathname === '/api/memory', r => json(r, { items: db.items }));
  await page.route(u => u.pathname === '/api/facts/suggestions', async r => {
    db.reads++;
    if (db.readHeld) await db.readHeld;
    if (db.fail.read === 401) return json(r, { error: 'Sign in on this device first: pair it under Improve › Claude Code.', signIn: true }, 401);
    if (db.fail.read) return json(r, { error: "Couldn't read your suggested facts." }, db.fail.read);
    json(r, { items: db.sugs });
  });
  await page.route(u => u.pathname === '/api/facts/suggestions/decide', async r => {
    const b = JSON.parse(r.request().postData() || '{}');
    db.posts.push(b);
    if (db.held) await db.held;
    if (db.fail.decide) return json(r, { error: 'database is locked' }, db.fail.decide);
    const it = db.sugs.find(x => x.id === b.id); if (!it) return json(r, { error: 'That suggestion is gone.' }, 404);
    if (b.action === 'no') { db.sugs = db.sugs.filter(x => x !== it); return json(r, { ok: true, state: 'declined', item: it }); }
    if (facts().length >= 30) return json(r, { error: 'Your list is full: 30 of 30. Delete or edit a fact to make room; nothing is removed for you.', full: true, max: 30 }, 409);
    let text = it.text;
    if (typeof b.text === 'string') { text = one(b.text); if (!/[.!]$/.test(text)) text += '.'; }
    const f = fact('mem-s' + db.posts.length, text, 500 + db.posts.length);
    db.items.unshift(f); db.sugs = db.sugs.filter(x => x !== it);
    json(r, { ok: true, state: 'saved', item: it, fact: { id: f.id, text: f.text, createdAt: f.createdAt } });
  });
  if (runs.length) {
    await page.route(u => u.pathname === '/api/runs', r => {
      const q = new URL(r.request().url()).searchParams;
      if (q.get('id')) { const it = runs.find(x => x.id === q.get('id')); return it ? json(r, { item: it }) : json(r, { error: 'Run not found' }, 404); }
      json(r, { items: q.get('threadId') ? runs.filter(x => x.threadId === q.get('threadId')) : runs, summary: {} });
    });
  }
  await page.goto(base + '/' + hash, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.showView === 'function' && window.LocalAIRuns, null, { timeout: 10000 });
  if (hash === '#memory') await page.locator('#ownerFactsBody[aria-busy="false"]').waitFor(T);
  return page;
}
const rows = page => page.locator('#ownerSuggestList > li');
const factTexts = page => page.locator('#ownerFactsList .owner-fact__text').allInnerTexts();
async function axe(page, scope) {
  await addAxe(page, axePath);
  return page.evaluate(sel => window.axe.run(sel, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] } })
    .then(r => r.violations.filter(x => ['serious', 'critical'].includes(x.impact)).map(x => `${x.id}: ${x.nodes.slice(0, 3).map(n => n.target.join(' ')).join(' | ')}`)), scope);
}
const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const shot = async (page, name, sel) => { if (shots) await (sel ? page.locator(sel).screenshot({ path: join(shots, `${name}.png`) }) : page.screenshot({ path: join(shots, `${name}.png`), fullPage: false })); };

// ---- Memory ----

for (const [viewport, scheme] of [[desk, 'dark'], [desk, 'light'], [phone, 'dark'], [phone, 'light']]) {
  const tag = `${viewport.width}px ${scheme}`;
  await check(`${tag}: suggestions sit above the saved facts with Save, Edit and No; axe and touch size`, async () => {
    const page = await open(viewport, { items: [fact('f1', 'You live in a two-storey house.')], suggestions: [sug('fs-1', PLA), sug('fs-2', LONG)], scheme });
    await rows(page).nth(1).waitFor(T);
    assert.equal((await page.locator('#ownerSuggestTitle').textContent()).trim(), 'Suggested by Local AI');
    assert.match(await page.locator('#ownerSuggestNote').textContent(), /Nothing is saved until you choose Save\./);
    assert.ok(await page.evaluate(() => document.getElementById('ownerSuggestList').compareDocumentPosition(document.getElementById('ownerFactsList')) & Node.DOCUMENT_POSITION_FOLLOWING), 'before the saved facts');
    assert.deepEqual((await rows(page).first().locator('button').allInnerTexts()).map(s => s.trim()), ['Save', 'Edit', 'No']);
    assert.equal((await rows(page).nth(1).locator('.owner-fact__text').textContent()).trim(), LONG, 'a long suggestion is shown whole');
    assert.equal(await noOverflow(page), true, 'no horizontal overflow');
    if (viewport.width < 760) {
      const small = await rows(page).locator('button').evaluateAll(bs => bs.map(b => b.getBoundingClientRect()).filter(r => r.height < 44 || r.width < 44).length);
      assert.equal(small, 0, '44 px targets');
    }
    assert.deepEqual(await axe(page, '#ownerFacts'), []);
    await page.locator('#ownerFacts').scrollIntoViewIfNeeded();
    await shot(page, `memory-suggestions-${viewport.width}-${scheme}`);
    assert.deepEqual(page.errors, []);
    await page.context().close();
  });
}

await check('Save: the suggestion becomes a fact, leaves the list, focus lands on the new fact; nothing was saved before', async () => {
  const page = await open(desk, { suggestions: [sug('fs-1', PLA), sug('fs-2', METRIC)] });
  await rows(page).nth(1).waitFor(T);
  assert.equal(await page.locator('#ownerFactsEmpty').count(), 1, 'no facts until Save');
  assert.equal(page.db.posts.length, 0);
  await rows(page).first().locator('[data-suggest-save]').click();
  await page.locator('#ownerFactsList').waitFor(T);
  assert.deepEqual(page.db.posts, [{ id: 'fs-1', action: 'save' }]);
  assert.deepEqual(await factTexts(page), [PLA]);
  assert.equal(await rows(page).count(), 1);
  assert.equal((await page.locator('#ownerFactsCount').textContent()).trim(), '1 of 30');
  await page.locator('#toast', { hasText: 'Saved the fact' }).waitFor(T);
  assert.equal(await page.evaluate(() => document.activeElement?.matches('#ownerFactsList [data-fact-edit]') && document.activeElement.closest('[data-fact-id]').querySelector('.owner-fact__text').textContent), PLA);
  await page.context().close();
});

await check('Edit opens inline with the suggested text, saves the owner\'s words as a fact; Escape cancels back to Edit', async () => {
  const page = await open(desk, { suggestions: [sug('fs-1', PLA)] });
  const row = rows(page).first();
  await row.locator('[data-suggest-edit]').click();
  const input = page.locator('#ownerSuggestEdit');
  await input.waitFor(T);
  assert.equal(await input.inputValue(), PLA);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'ownerSuggestEdit');
  await page.keyboard.press('Escape');
  await page.locator('#ownerSuggestEdit').waitFor({ state: 'detached', ...T });
  assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-suggest-edit')), true, 'focus back on Edit');
  await page.keyboard.press('Enter');
  await input.fill('You print mostly PETG on the X2D');
  await page.keyboard.press('Enter');
  await page.locator('#ownerFactsList').waitFor(T);
  assert.deepEqual(page.db.posts, [{ id: 'fs-1', action: 'save', text: 'You print mostly PETG on the X2D' }]);
  assert.deepEqual(await factTexts(page), ['You print mostly PETG on the X2D.']);
  assert.equal(await page.locator('#ownerSuggestList').count(), 0, 'none left: the heading goes too');
  await page.context().close();
});

await check('No: remembered by the server, the row goes, focus moves to the next suggestion; the last one hands focus to Add', async () => {
  const page = await open(desk, { suggestions: [sug('fs-1', PLA), sug('fs-2', METRIC)] });
  await rows(page).first().locator('[data-suggest-no]').click();
  await page.waitForFunction(() => document.querySelectorAll('#ownerSuggestList > li').length === 1);
  assert.deepEqual(page.db.posts, [{ id: 'fs-1', action: 'no' }]);
  await page.locator('#toast', { hasText: "Local AI won't suggest that again" }).waitFor(T);
  assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-suggest-no') && document.activeElement.closest('li').dataset.suggestId), 'fs-2');
  await page.keyboard.press('Enter');
  await page.locator('#ownerSuggestList').waitFor({ state: 'detached', ...T });
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'ownerFactText');
  assert.equal(await page.locator('#ownerFactsEmpty').count(), 1, 'No saved nothing');
  await page.context().close();
});

await check('keyboard only: Tab reaches Save, Enter saves, and a redraw keeps focus on the same control', async () => {
  const page = await open(phone, { items: [fact('f1', 'You live in a two-storey house.')], suggestions: [sug('fs-1', PLA), sug('fs-2', METRIC)], scheme: 'light' });
  await rows(page).first().locator('[data-suggest-save]').focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-suggest-edit')), true);
  await page.keyboard.press('Shift+Tab');
  // Something else redraws the group (Show all, a fact saved): the focused control is put back.
  await page.evaluate(() => window.LocalAIOwnerFacts.reload());
  await page.waitForFunction(() => document.getElementById('ownerFactsBody').getAttribute('aria-busy') === 'false' && window.LocalAIOwnerFacts);
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-suggest-save') && document.activeElement.closest('li').dataset.suggestId), 'fs-1');
  await page.keyboard.press('Enter');
  await page.locator('#ownerFactsList [data-fact-id="mem-s1"]').waitFor(T);
  const r = await page.evaluate(() => { const b = document.activeElement.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, h: innerHeight }; });
  assert.ok(r.top >= 0 && r.bottom <= r.h, `the focused control is on screen (${JSON.stringify(r)})`);
  await page.context().close();
});

await check('full list: Save and Edit are disabled with the reason beside them; No still works', async () => {
  const page = await open(phone, { items: FULL, suggestions: [sug('fs-1', PLA)] });
  const row = rows(page).first();
  await row.waitFor(T);
  assert.equal(await row.locator('[data-suggest-save]').isDisabled(), true);
  assert.equal(await row.locator('[data-suggest-edit]').isDisabled(), true);
  assert.equal(await row.locator('[data-suggest-no]').isDisabled(), false);
  const why = row.locator('#ownerSuggest0Why');
  assert.equal((await why.textContent()).trim(), 'Your list is full (30 of 30). Delete a fact to save this one.');
  assert.match(await row.locator('[data-suggest-save]').getAttribute('aria-describedby'), /ownerSuggest0Why/);
  assert.deepEqual(await axe(page, '#ownerFacts'), []);
  await page.locator('#ownerSuggestList').scrollIntoViewIfNeeded();
  await shot(page, 'memory-suggestions-full-390-dark');
  await row.locator('[data-suggest-no]').click();
  await page.locator('#ownerSuggestList').waitFor({ state: 'detached', ...T });
  assert.deepEqual(page.db.posts, [{ id: 'fs-1', action: 'no' }]);
  await page.context().close();
});

await check('saving shows Saving… with focus kept and announced; a failed save keeps the edited text and says why once', async () => {
  const page = await open(desk, { suggestions: [sug('fs-1', PLA)], fail: { decide: 500 } });
  let release; page.db.held = new Promise(r => { release = r; });
  await rows(page).first().locator('[data-suggest-edit]').click();
  await page.locator('#ownerSuggestEdit').fill('You print mostly PLA and PETG');
  await page.locator('#ownerSuggestList button[type="submit"]').click();
  await page.locator('#ownerSuggestList button[type="submit"]', { hasText: 'Saving…' }).waitFor(T);
  assert.equal(await page.locator('#ownerSuggestList [data-suggest-cancel]').isDisabled(), true);
  assert.equal(await page.locator('#ownerSuggestEdit').evaluate(i => i.readOnly), true);
  // Focus stays on the pressed button (busy, not disabled), and the live line says what is happening.
  assert.deepEqual(await page.evaluate(() => { const a = document.activeElement; return [a?.type, a?.getAttribute('aria-busy'), a?.getAttribute('aria-disabled')]; }), ['submit', 'true', 'true']);
  assert.equal((await page.locator('#ownerSuggestLive').textContent()).trim(), 'Saving…');
  release();
  const err = page.locator('#ownerSuggestList .owner-facts__error');
  await err.waitFor(T);
  assert.equal((await err.textContent()).trim(), 'Database is locked. Choose Save fact to try again.', "the server's reason once, and the way out");
  assert.equal(await page.locator('#ownerSuggestEdit').inputValue(), 'You print mostly PLA and PETG', 'what was typed stays');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'ownerSuggestEdit');
  assert.equal((await page.locator('#ownerSuggestList button[type="submit"]').textContent()).trim(), 'Save fact');
  assert.equal(await page.locator('#ownerSuggestList button[type="submit"]').getAttribute('aria-busy'), null);
  assert.equal((await page.locator('#ownerSuggestLive').textContent()).trim(), '');
  assert.equal(await page.locator('#ownerFactsEmpty').count(), 1, 'nothing shown as saved');
  await shot(page, 'memory-suggestions-failed-save-1280-dark', '#ownerFacts');
  await page.context().close();
});

await check('failed read: says it couldn\'t read the suggestions (never "none"), keeps the facts, and Try again reads again', async () => {
  const page = await open(desk, { items: [fact('f1', 'You live in a two-storey house.')], suggestions: [sug('fs-1', PLA)], fail: { read: 503 } });
  const n = page.locator('#ownerSuggestState');
  await n.waitFor(T);
  assert.match(await n.getAttribute('class'), /ui-notice--warn/, 'the same warning as under an answer');
  assert.equal(await n.getAttribute('role'), null, 'drawn with the page: no alert');
  assert.equal((await n.textContent()).trim(), "Couldn't read your suggested facts.", "the server's reason, once");
  assert.equal((await page.locator('#ownerSuggestCount').textContent()).trim(), '', 'open, the warning says it once');
  assert.equal((await page.locator('#ownerFactsSavedTitle').textContent()).trim(), 'Saved facts', 'the saved list keeps its heading');
  await page.locator('#ownerFactsToggle').click();
  assert.equal((await page.locator('#ownerSuggestCount').textContent()).trim(), "· suggestions couldn't be read", 'folded, the count line says so');
  await page.locator('#ownerFactsToggle').click();
  assert.deepEqual(await factTexts(page), ['You live in a two-storey house.'], 'the saved facts still show');
  assert.doesNotMatch(await page.locator('#ownerFacts').innerText(), /no suggest/i);
  assert.deepEqual(await axe(page, '#ownerFacts'), []);
  await shot(page, 'memory-suggestions-read-failed-1280-dark', '#ownerFacts');
  delete page.db.fail.read;
  await page.locator('#ownerSuggestRetry').click();
  await rows(page).first().waitFor(T);
  assert.equal(await page.locator('#ownerSuggestState').count(), 0);
  assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-suggest-save')), true, 'focus moves to the first suggestion');
  await page.context().close();
});

await check('a device that isn\'t paired is told where suggestions show, as plain text; none pending shows nothing', async () => {
  let page = await open(desk, { suggestions: [sug('fs-1', PLA)], fail: { read: 401 } });
  const n = page.locator('#ownerSuggestState');
  await n.waitFor(T);
  assert.equal((await n.textContent()).trim(), 'Suggested facts show on a paired device: pair this one under Improve › Claude Code.');
  assert.doesNotMatch(await n.getAttribute('class'), /ui-notice/);
  await page.context().close();
  page = await open(desk, { suggestions: [] });
  await page.waitForFunction(() => document.getElementById('ownerFactsToggle'));
  await page.waitForTimeout(300);
  assert.ok(page.db.reads >= 1);
  assert.equal((await page.locator('#ownerSuggestCount').textContent()).trim(), '');
  assert.equal(await page.locator('#ownerSuggestTitle, #ownerSuggestState, #ownerSuggestList').count(), 0);
  await page.context().close();
});

await check('folded: the count line says how many wait and the toggle opens them; notes stay on a phone\'s first screen (system-lists)', async () => {
  const notes = [1, 2, 3].map(n => ({ id: `m${n}`, projectId: '', category: 'note', text: `Memory ${n}`, pinned: false, createdAt: iso(n), updatedAt: iso(n) }));
  const page = await open(phone, { items: [fact('f1', 'You live in a two-storey house.'), ...notes], suggestions: [sug('fs-1', PLA), sug('fs-2', METRIC), sug('fs-3', LONG)], expanded: false });
  await page.locator('#ownerSuggestCount').waitFor(T);
  assert.equal((await page.locator('#ownerFactsBody .owner-facts__count').textContent()).trim(), '1 of 30 facts · used only in answers from this PC · 3 suggestions');
  assert.equal(await page.locator('#ownerFactsPanel').isVisible(), false);
  assert.equal(await page.locator('#ownerSuggestList').isVisible(), false);
  await page.locator('#memoryList .memory-card').first().waitFor(T);
  const top = await page.locator('#memoryList .memory-card').first().evaluate(e => e.getBoundingClientRect().top);
  console.log(`  first note top at 390x844 with 3 suggestions: ${Math.round(top)}px`);
  assert.ok(top < 844 - 120, `the first note starts at ${Math.round(top)}px, on the first screen`);
  await shot(page, 'memory-folded-3-suggestions-390-dark');
  assert.equal((await page.locator('#ownerFactsToggle').textContent()).trim(), 'Show facts and 3 suggestions');
  await page.locator('#ownerFactsToggle').click();
  await rows(page).nth(2).waitFor(T);
  assert.equal(await page.locator('#ownerFactsToggle').getAttribute('aria-expanded'), 'true');
  await page.context().close();
  // No facts yet: the toggle names what is there to see.
  const p2 = await open(desk, { suggestions: [sug('fs-1', PLA)], expanded: false });
  await p2.locator('#ownerSuggestCount').waitFor(T);
  assert.equal((await p2.locator('#ownerFactsToggle').textContent()).trim(), 'Show 1 suggestion');
  assert.equal((await p2.locator('#ownerSuggestCount').textContent()).trim(), '· 1 suggestion');
  // Opening it hides the toggle (no saved facts to hide again), and focus goes to the suggestion, not past it to Add.
  await p2.locator('#ownerFactsToggle').click();
  await rows(p2).first().waitFor(T);
  assert.equal(await p2.locator('#ownerFactsToggle').isHidden(), true);
  assert.equal(await p2.evaluate(() => document.activeElement?.hasAttribute('data-suggest-save') && document.activeElement.closest('li').dataset.suggestId), 'fs-1');
  await p2.context().close();
  // No facts and no suggestions: opening still goes to Add.
  const p3 = await open(desk, { suggestions: [], expanded: false });
  await p3.waitForTimeout(300);
  await p3.locator('#ownerFactsToggle').click();
  assert.equal(await p3.evaluate(() => document.activeElement?.id), 'ownerFactText');
  await p3.context().close();
});

await check('the saved facts get their own heading and count, a section gap below the suggestions', async () => {
  const page = await open(desk, { items: [fact('f1', 'You live in a two-storey house.'), fact('f2', 'You have a heat pump.', 1)], suggestions: [sug('fs-1', PLA)] });
  await rows(page).first().waitFor(T);
  assert.equal((await page.locator('#ownerFactsSavedTitle').textContent()).trim(), 'Saved facts');
  assert.equal(await page.locator('#ownerFactsSavedTitle + #ownerFactsList').count(), 1, 'the count line above says how many: not repeated here');
  const gap = await page.evaluate(() => {
    const a = document.querySelector('.owner-facts__suggest').getBoundingClientRect(), b = document.getElementById('ownerFactsSavedTitle').getBoundingClientRect();
    const s5 = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-s-5')) * parseFloat(getComputedStyle(document.documentElement).fontSize);
    return { gap: b.top - a.bottom, s5 };
  });
  assert.ok(Math.abs(gap.gap - gap.s5) <= 1, `gap ${gap.gap}px, s-5 ${gap.s5}px`);
  await shot(page, 'memory-saved-heading-1280-dark', '#ownerFacts');
  await page.context().close();
});

await check('the saved facts draw without waiting for the suggestions read', async () => {
  const page = await open(desk, { items: [fact('f1', 'You live in a two-storey house.')], suggestions: [sug('fs-1', PLA)], holdRead: true });
  await page.locator('#ownerFactsList').waitFor(T);
  assert.deepEqual(await factTexts(page), ['You live in a two-storey house.']);
  assert.equal(await page.locator('#ownerSuggestList, #ownerSuggestState').count(), 0, 'still reading: nothing said yet');
  page.db.letRead();
  await rows(page).first().waitFor(T);
  await page.context().close();
});

// ---- under a chat answer ----

const openRun = async (page, id) => { await page.evaluate(i => window.LocalAIRuns.show(i), id); await page.locator('#runDrawer .chat-turn--assistant').first().waitFor(T); };

for (const [viewport, scheme] of [[desk, 'dark'], [desk, 'light'], [phone, 'dark'], [phone, 'light']]) {
  await check(`${viewport.width}px ${scheme}: one quiet line under the answer it came from, linking to Memory; axe`, async () => {
    const runs = [chatRun(1, 'Which printer do I have?', 'A Bambu X2D.'), chatRun(2, 'I print mostly PLA on my X2D. What temperature?', 'Try 215 °C.', { facts: USED })];
    const page = await open(viewport, { hash: '#home', runs, suggestions: [sug('fs-1', PLA, runs[1].id)], scheme });
    await openRun(page, runs[1].id);
    const answer = page.locator('#runDrawer .chat-turn--assistant', { hasText: 'Try 215' });
    const line = answer.locator('.fact-line');
    await line.waitFor(T);
    assert.equal((await line.textContent()).trim(), `Local AI suggests remembering: “${PLA}” Review on Memory`);
    assert.equal(await page.locator('#runDrawer .fact-line').count(), 1, 'only under the answer it came from');
    assert.doesNotMatch(await line.getAttribute('class'), /ui-notice/);
    assert.equal(await line.locator('a').getAttribute('href'), '#memory?review=suggestions');
    assert.equal(await line.locator('button').count(), 0, 'no decision under the answer: that is on Memory');
    assert.equal(await answer.evaluate(n => n.lastElementChild.className), 'fact-line', 'last, after "Used 2 of your saved facts"');
    assert.ok(await answer.evaluate(n => n.querySelector('.run-memory').compareDocumentPosition(n.querySelector('.fact-line')) & Node.DOCUMENT_POSITION_FOLLOWING));
    if (viewport.width < 760) assert.ok((await line.locator('a').boundingBox()).height >= 44, '44 px link');
    assert.equal(await noOverflow(page), true);
    assert.deepEqual(await axe(page, '#runDrawer'), []);
    await shot(page, `answer-line-${viewport.width}-${scheme}`);
    // A repaint doesn't add a second line.
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await page.waitForTimeout(300);
    assert.equal(await answer.locator('.fact-line').count(), 1);
    assert.equal(await answer.evaluate(n => n.lastElementChild.className), 'fact-line');
    assert.deepEqual(page.errors, []);
    await page.context().close();
  });
}

await check('a suggestion that arrives after the answer shows up without a reload; deciding on Memory takes the line off', async () => {
  const runs = [chatRun(1, 'I print mostly PLA on my X2D. What temperature?', 'Try 215 °C.')];
  const page = await open(desk, { hash: '#home', runs, suggestions: [] });
  await openRun(page, runs[0].id);
  await page.waitForTimeout(500);
  assert.equal(await page.locator('#runDrawer .fact-line').count(), 0, 'none yet: nothing');
  page.db.sugs = [sug('fs-1', PLA, runs[0].id)];
  await page.locator('#runDrawer .fact-line').waitFor({ timeout: 10000 });
  const link = page.locator('#runDrawer .fact-line a');
  await link.focus();
  await page.keyboard.press('Enter');
  await page.locator('#memory.active').waitFor(T);
  await rows(page).first().waitFor(T);
  await rows(page).first().locator('[data-suggest-no]').click();
  await page.locator('#ownerSuggestList').waitFor({ state: 'detached', ...T });
  await page.waitForFunction(() => !document.querySelector('.fact-line'), null, T);
  await page.context().close();
});

await check('390: "Review on Memory" opens a folded group with the suggestion in view and focus on it', async () => {
  const runs = [chatRun(1, 'I print mostly PLA on my X2D. What temperature?', 'Try 215 °C.')];
  const page = await open(phone, { hash: '#home', runs, items: [fact('f1', 'You live in a two-storey house.')], suggestions: [sug('fs-1', PLA, runs[0].id)], expanded: false });
  await openRun(page, runs[0].id);
  await page.locator('#runDrawer .fact-line a').click();
  await page.locator('#memory.active').waitFor(T);
  await page.locator('#ownerSuggestList').waitFor({ state: 'visible', ...T });
  await page.waitForFunction(() => document.activeElement?.closest('#ownerSuggestList'), null, T);
  assert.equal(await page.locator('#ownerFactsToggle').getAttribute('aria-expanded'), 'true');
  const r = await page.evaluate(() => { const b = document.activeElement.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, h: innerHeight }; });
  assert.ok(r.top >= 0 && r.bottom <= r.h, `the focused Save is on screen (${JSON.stringify(r)})`);
  await shot(page, 'memory-review-link-390-dark');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

await check('only the newest answer gets a line: a late suggestion for an earlier answer never pushes the later one down', async () => {
  const runs = [chatRun(1, 'I print mostly PLA on my X2D. What temperature?', 'Try 215 °C.'), chatRun(2, 'And for PETG?', 'Try 240 °C.')];
  const page = await open(desk, { hash: '#home', runs, suggestions: [] });
  await openRun(page, runs[1].id);
  await page.locator('#runDrawer .chat-turn--assistant', { hasText: 'Try 240' }).waitFor(T);
  const later = () => page.locator('#runDrawer .chat-turn--assistant', { hasText: 'Try 240' }).evaluate(n => n.getBoundingClientRect().top);
  await page.locator('#runDrawer .answer-feedback').nth(1).waitFor(T);
  await page.waitForTimeout(600);   // the drawer has settled
  const before = await later();
  page.db.sugs = [sug('fs-1', PLA, runs[0].id)];
  const reads = page.db.reads;
  for (let i = 0; i < 80 && page.db.reads < reads + 2; i++) await page.waitForTimeout(100);   // two more polls
  assert.ok(page.db.reads >= reads + 2, 'it did read again');
  assert.equal(await page.locator('#runDrawer .fact-line').count(), 0);
  assert.equal(await later(), before, 'the later answer did not move');
  await page.context().close();
});

await check('a failed read under a fresh answer warns, and the next check that works replaces it', async () => {
  const runs = [chatRun(1, 'I print mostly PLA on my X2D. What temperature?', 'Try 215 °C.')];
  const page = await open(desk, { hash: '#home', runs, fail: { read: 503 } });
  await openRun(page, runs[0].id);
  const line = page.locator('#runDrawer .fact-line');
  await line.waitFor(T);
  assert.match(await line.getAttribute('class'), /ui-notice--warn/);
  delete page.db.fail.read; page.db.sugs = [sug('fs-1', PLA, runs[0].id)];
  await page.locator('#runDrawer .fact-line:not(.ui-notice)', { hasText: 'Local AI suggests remembering' }).waitFor({ timeout: 12000 });
  assert.equal(await page.locator('#runDrawer .fact-line').count(), 1);
  await page.context().close();
});

await check('under a fresh answer a failed read says so; an older answer and a device that isn\'t paired show nothing', async () => {
  const fresh = [chatRun(1, 'I print PLA. Temperature?', 'Try 215 °C.')];
  let page = await open(phone, { hash: '#home', runs: fresh, fail: { read: 503 }, scheme: 'light' });
  await openRun(page, fresh[0].id);
  const line = page.locator('#runDrawer .fact-line');
  await line.waitFor(T);
  assert.match(await line.getAttribute('class'), /ui-notice--warn/);
  assert.equal((await line.textContent()).trim(), "Couldn't check whether this answer suggested a fact to remember. Open Memory");
  assert.deepEqual(await axe(page, '#runDrawer'), []);
  await shot(page, 'answer-line-read-failed-390-light');
  await page.context().close();
  const old = [chatRun(1, 'I print PLA. Temperature?', 'Try 215 °C.', { fresh: false })];
  page = await open(desk, { hash: '#home', runs: old, fail: { read: 503 } });
  await openRun(page, old[0].id);
  await page.waitForTimeout(800);
  assert.equal(await page.locator('#runDrawer .fact-line').count(), 0);
  await page.context().close();
  page = await open(desk, { hash: '#home', runs: fresh, fail: { read: 401 } });
  await openRun(page, fresh[0].id);
  await page.waitForTimeout(3500);
  assert.equal(await page.locator('#runDrawer .fact-line').count(), 0);
  assert.ok(page.db.reads >= 1);
  await page.context().close();
});

await browser.close();
if (failures.length) { console.error(`\n${failures.length} failed:\n${failures.join('\n')}`); process.exit(1); }
