import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { addAxe } from './axe-helper.mjs';

// Projects › Memory › About you and the house (docs/superpowers/specs/2026-11-19-owner-facts-design.md, PR 1): the list
// of facts with Add, Edit and Delete, its empty, full, error and failed-save states, "Make this a fact" on short shared
// notes, keyboard only and axe. The memory API is stubbed with an in-page store that applies the server's rules.
const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const axePath = join(dirname(fileURLToPath(import.meta.url)), 'vendor', 'axe.min.js');
const browser = await chromium.launch({ headless: true });
const T = { timeout: 8000 };
const failures = [];
async function check(name, fn) {
  try { await fn(); console.log('PASS', name); } catch (error) { failures.push(`${name}: ${error.message}`); console.error('FAIL', name, error.message); }
}
const desk = { width: 1280, height: 900 }, phone = { width: 390, height: 844 };
const iso = n => new Date(Date.UTC(2026, 10, 1, 12) + n * 3600e3).toISOString();
const fact = (id, text, n = 0) => ({ id, projectId: '', category: 'owner', text, pinned: false, createdAt: iso(n), updatedAt: iso(n) });
const note = (id, text, projectId = '', n = 0) => ({ id, projectId, category: 'note', text, pinned: false, createdAt: iso(n), updatedAt: iso(n) });
const FULL = Array.from({ length: 30 }, (_, i) => fact('f' + i, `Fact number ${i + 1}.`, i));

// fail: { read, add, update, delete } -> status to answer with instead of doing it. loadScript: false aborts /owner-facts.js.
async function open(viewport, { items = [], fail = {}, loadScript = true } = {}) {
  const db = { items: items.map(x => ({ ...x })), posts: [], fail: { ...fail } };
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport, isMobile: viewport.width < 760, hasTouch: viewport.width < 760 });
  await ctx.addInitScript(() => { try { localStorage.setItem('localai.firstRun.done', '1'); } catch {} });
  const page = await ctx.newPage();
  page.db = db; page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  const json = (r, body, status = 200) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const facts = () => db.items.filter(x => x.category === 'owner' && !x.projectId);
  const one = t => String(t || '').replace(/\s+/g, ' ').trim();
  if (!loadScript) await page.route(u => u.pathname === '/owner-facts.js', r => r.abort());
  await page.route(u => u.pathname === '/api/projects', r => json(r, { items: [{ id: 'prj-1', name: 'Garden', counts: {} }], total: 1 }));
  await page.route(u => u.pathname === '/api/memory', r => {
    if (db.fail.read) return json(r, { error: 'database is locked' }, db.fail.read);
    const p = new URL(r.request().url()).searchParams.get('projectId');
    json(r, { items: p ? db.items.filter(x => x.projectId === p) : db.items });
  });
  await page.route(u => /^\/api\/memory\/(add|update|delete)$/.test(u.pathname), r => {
    const kind = new URL(r.request().url()).pathname.split('/').pop(), b = JSON.parse(r.request().postData() || '{}');
    db.posts.push({ kind, ...b });
    if (db.fail[kind]) return json(r, { error: db.fail[kind] === 409 ? 'Your list is full: 30 of 30. Delete or edit a fact to make room; nothing is removed for you.' : 'database is locked' }, db.fail[kind]);
    if (kind === 'add') {
      const it = { ...fact('mem-new-' + db.posts.length, one(b.text), 900 + db.posts.length), category: b.category, projectId: b.projectId || '' };
      if (b.category === 'owner' && facts().length >= 30) return json(r, { error: 'Your list is full.', full: true }, 409);
      db.items.unshift(it); return json(r, { item: it }, 201);
    }
    const it = db.items.find(x => x.id === b.id); if (!it) return json(r, { error: 'Memory not found' }, 404);
    if (kind === 'delete') { db.items = db.items.filter(x => x !== it); return json(r, { ok: true }); }
    if (typeof b.text === 'string') it.text = one(b.text);
    if (b.category) it.category = b.category;
    json(r, { item: it });
  });
  await page.goto(base + '/#memory', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.showView === 'function' && document.getElementById('memory')?.classList.contains('active'), null, { timeout: 10000 });
  if (loadScript) await page.locator('#ownerFactsBody[aria-busy="false"]').waitFor(T);
  return page;
}
const group = page => page.locator('#ownerFacts');
const rows = page => page.locator('#ownerFactsList > li');
const close = page => page.context().close();

await check('empty: says what to add, Add saves a fact as one line, and it never shows as a shared note', async () => {
  const page = await open(desk, { items: [note('mem-s1', 'Prefers matte finishes.')] });
  await group(page).locator('#ownerFactsEmpty', { hasText: 'No facts yet. Add one, like the printer you use or units you prefer.' }).waitFor(T);
  assert.equal((await page.locator('#ownerFactsTitle').textContent()).trim(), 'About you and the house');
  assert.equal(await page.locator('#ownerFactsCount').count(), 0);
  // The group comes before the per-project notes.
  assert.ok(await page.evaluate(() => document.getElementById('ownerFacts').compareDocumentPosition(document.getElementById('memoryList')) & Node.DOCUMENT_POSITION_FOLLOWING));
  await page.locator('#ownerFactText').fill('  I print PLA\non a Bambu X2D. ');
  await page.locator('#ownerFactAddBtn').click();
  await rows(page).first().waitFor(T);
  assert.equal((await rows(page).first().locator('.owner-fact__text').textContent()).trim(), 'I print PLA on a Bambu X2D.');
  assert.deepEqual(page.db.posts[0], { kind: 'add', projectId: '', category: 'owner', text: 'I print PLA on a Bambu X2D.' });
  assert.equal(await page.locator('#ownerFactText').inputValue(), '');
  assert.equal((await page.locator('#ownerFactsCount').textContent()).trim(), '1 of 30');
  await page.locator('#toast', { hasText: 'Added the fact' }).waitFor(T);
  await page.locator('#memoryList .memory-card').first().waitFor(T);
  assert.equal(await page.locator('#memoryList').getByText('I print PLA').count(), 0, 'a fact is not drawn as a shared note');
  assert.deepEqual(page.errors, []);
  await close(page);
});

await check('Add: an empty fact is refused here, and a failed save keeps the text and says why', async () => {
  const page = await open(desk, { fail: { add: 503 } });
  await page.locator('#ownerFactAddBtn').click();
  await page.locator('#ownerFactsAddError', { hasText: 'Write the fact first.' }).waitFor(T);
  assert.equal(await page.locator('#ownerFactText').getAttribute('aria-invalid'), 'true');
  assert.equal(page.db.posts.length, 0);
  await page.locator('#ownerFactText').fill('Answers in metric.');
  await page.locator('#ownerFactText').press('Enter');
  await page.locator('#ownerFactsAddError', { hasText: "Couldn't add this fact: database is locked." }).waitFor(T);
  assert.equal(await page.locator('#ownerFactText').inputValue(), 'Answers in metric.');
  assert.equal(await page.locator('#ownerFactAddBtn').isEnabled(), true);
  assert.equal(await page.locator('#ownerFactAddBtn').textContent(), 'Add fact');
  assert.equal(await page.locator('#ownerFactsEmpty').count(), 1);
  await close(page);
});

await check('saving: Add is disabled and says Adding… until the server answers', async () => {
  const page = await open(desk);
  let release; const held = new Promise(r => { release = r; });
  await page.route(u => u.pathname === '/api/memory/add', async r => { await held; r.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ item: fact('mem-held', 'Held.', 5) }) }); });
  await page.locator('#ownerFactText').fill('Held.');
  await page.locator('#ownerFactAddBtn').click();
  await page.locator('#ownerFactAddBtn:disabled', { hasText: 'Adding…' }).waitFor(T);
  release();
  await rows(page).first().waitFor(T);
  await close(page);
});

await check('Edit: saves in place; Escape cancels and puts focus back on Edit; a failed save keeps the text', async () => {
  const page = await open(desk, { items: [fact('a', 'Answers in metric.', 1), fact('b', 'Prints PLA.', 2)] });
  assert.deepEqual(await rows(page).locator('.owner-fact__text').allTextContents(), ['Answers in metric.', 'Prints PLA.'], 'oldest first, so a new one lands beside Add');
  const edit = rows(page).nth(0).getByRole('button', { name: 'Edit' });
  await edit.click();
  const input = page.locator('#ownerFactEdit');
  assert.equal(await input.inputValue(), 'Answers in metric.');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'ownerFactEdit');
  await input.press('Escape');
  await page.waitForFunction(() => document.activeElement?.matches('[data-fact-id="a"] [data-fact-edit]'), null, T);
  assert.equal(page.db.posts.length, 0);
  await rows(page).nth(0).getByRole('button', { name: 'Edit' }).click();
  await page.locator('#ownerFactEdit').fill('Answers in metric, always.');
  await page.locator('#ownerFactEdit').press('Enter');
  await rows(page).nth(0).locator('.owner-fact__text', { hasText: 'Answers in metric, always.' }).waitFor(T);
  assert.deepEqual(page.db.posts.at(-1), { kind: 'update', id: 'a', category: 'owner', text: 'Answers in metric, always.' });
  await page.waitForFunction(() => document.activeElement?.matches('[data-fact-id="a"] [data-fact-edit]'), null, T);
  page.db.fail.update = 503;
  await rows(page).nth(1).getByRole('button', { name: 'Edit' }).click();
  await page.locator('#ownerFactEdit').fill('Prints PETG.');
  await page.getByRole('button', { name: 'Save fact' }).click();
  await rows(page).nth(1).locator('.owner-facts__error', { hasText: "Couldn't save this fact: database is locked." }).waitFor(T);
  assert.equal(await page.locator('#ownerFactEdit').inputValue(), 'Prints PETG.');
  assert.equal(await page.getByRole('button', { name: 'Save fact' }).isEnabled(), true);
  await close(page);
});

await check('Delete asks first in the shared sheet; Cancel keeps the fact, Delete removes it', async () => {
  const page = await open(desk, { items: [fact('a', 'Answers in metric.', 1), fact('b', 'Prints PLA.', 2)] });
  await rows(page).nth(0).getByRole('button', { name: 'Delete' }).click();
  const sheet = page.locator('dialog.ask-sheet--danger');
  await sheet.waitFor(T);
  assert.equal((await sheet.locator('.ask-sheet__title').textContent()).trim(), 'Delete this fact?');
  assert.match(await sheet.locator('.ask-sheet__effect').textContent(), /"Answers in metric\." comes off your list for good/);
  await sheet.getByRole('button', { name: 'Cancel' }).click();
  assert.equal(await rows(page).count(), 2);
  assert.equal(page.db.posts.length, 0);
  await rows(page).nth(0).getByRole('button', { name: 'Delete' }).click();
  await page.locator('dialog.ask-sheet--danger').getByRole('button', { name: 'Delete' }).click();
  await page.waitForFunction(() => document.querySelectorAll('#ownerFactsList > li').length === 1, null, T);
  assert.deepEqual(page.db.posts.at(-1), { kind: 'delete', id: 'a' });
  await page.waitForFunction(() => document.activeElement?.matches('[data-fact-id="b"] [data-fact-delete]'), null, T);
  page.db.fail.delete = 503;
  await rows(page).nth(0).getByRole('button', { name: 'Delete' }).click();
  await page.locator('dialog.ask-sheet--danger').getByRole('button', { name: 'Delete' }).click();
  await rows(page).nth(0).locator('.owner-facts__error', { hasText: "Couldn't delete this fact: database is locked." }).waitFor(T);
  assert.equal(await rows(page).count(), 1);
  await close(page);
});

const hiddenFrom = page => page.evaluate(() => [...document.querySelectorAll('#ownerFactsList > li')].filter(li => li.hidden).length);
// The focused element is on screen and not under the sticky head: the point at its centre is it or inside it.
const uncovered = page => page.evaluate(() => {
  const el = document.activeElement, r = el.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return !!hit && (hit === el || el.contains(hit));
});

await check('full: the list shows 5 with "Show all 30 facts"; the reason sits beside the disabled Add', async () => {
  const page = await open(desk, { items: FULL });
  assert.equal(await rows(page).count(), 30);
  assert.equal(await hiddenFrom(page), 25, 'the first 5 show');
  assert.equal(await rows(page).nth(4).isVisible(), true);
  assert.equal(await rows(page).nth(5).isVisible(), false);
  assert.equal((await page.locator('#ownerFactsCount').textContent()).trim(), '30 of 30');
  assert.equal((await page.locator('#ownerFactsRule').textContent()).trim(), 'Full: 30 of 30. Delete or edit a fact to add another.');
  assert.equal(await page.locator('#ownerFactText').isDisabled(), true);
  assert.equal(await page.locator('#ownerFactAddBtn').isDisabled(), true);
  assert.equal(await page.locator('#ownerFactText').getAttribute('aria-describedby'), 'ownerFactsRule');
  // Reason beside Add: the rule line is right under the field, not past the list.
  const [field, rule] = await Promise.all([page.locator('#ownerFactText').boundingBox(), page.locator('#ownerFactsRule').boundingBox()]);
  assert.ok(rule.y - (field.y + field.height) < 60, 'the reason is next to Add');
  const more = page.locator('#ownerFactsMore');
  assert.equal(await more.getAttribute('aria-expanded'), 'false');
  assert.equal((await more.textContent()).trim(), 'Show all 30 facts');
  await more.focus(); await page.keyboard.press('Enter');
  assert.equal(await page.locator('#ownerFactsMore').getAttribute('aria-expanded'), 'true');
  assert.equal(await hiddenFrom(page), 0);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'ownerFactsMore', 'focus stays on the toggle');
  await page.keyboard.press('Enter');
  assert.equal(await hiddenFrom(page), 25);
  await rows(page).nth(3).getByRole('button', { name: 'Edit' }).click();
  await page.locator('#ownerFactEdit').fill('Fact four, edited.');
  await page.locator('#ownerFactEdit').press('Enter');
  await rows(page).nth(3).locator('.owner-fact__text', { hasText: 'Fact four, edited.' }).waitFor(T);
  // While editing, Save fact is the only primary button in the group.
  await rows(page).nth(0).getByRole('button', { name: 'Edit' }).click();
  assert.equal(await group(page).locator('.ui-btn--primary').count(), 1);
  assert.equal((await group(page).locator('.ui-btn--primary').textContent()).trim(), 'Save fact');
  await close(page);
});

await check('full: "Make this a fact" is disabled with the reason, and comes back when a fact is deleted', async () => {
  const page = await open(desk, { items: [...FULL, note('mem-s1', 'Prefers matte finishes.')] });
  const btn = page.locator('#memoryList [data-mem-fact="mem-s1"]');
  await btn.waitFor({ state: 'attached', ...T });
  assert.equal(await btn.isDisabled(), true);
  assert.equal(await btn.getAttribute('aria-describedby'), 'ownerFactsRule');
  await rows(page).nth(0).getByRole('button', { name: 'Delete' }).click();
  await page.locator('dialog.ask-sheet--danger').getByRole('button', { name: 'Delete' }).click();
  await page.waitForFunction(() => document.querySelectorAll('#ownerFactsList > li').length === 29, null, T);
  assert.equal(await btn.isEnabled(), true);
  assert.equal(await btn.getAttribute('aria-describedby'), null);
  assert.equal(await page.locator('#ownerFactText').isEnabled(), true);
  assert.equal((await page.locator('#ownerFactsRule').textContent()).trim(), 'One sentence, up to 200 characters.');
  await close(page);
});

await check('delete the only fact, keyboard: focus lands on the Add field', async () => {
  const page = await open(desk, { items: [fact('a', 'Answers in metric.')] });
  await rows(page).nth(0).getByRole('button', { name: 'Delete' }).focus();
  await page.keyboard.press('Enter');
  await page.locator('dialog.ask-sheet--danger').waitFor(T);
  await page.keyboard.press('Tab');                  // Cancel → Delete
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Delete');
  await page.keyboard.press('Enter');
  await page.locator('#ownerFactsEmpty').waitFor(T);
  await page.waitForFunction(() => document.activeElement?.id === 'ownerFactText', null, T);
  await close(page);
});

for (const vp of [{ width: 1366, height: 768 }, phone]) {
  await check(`${vp.width}px: after "Make this a fact" the focused Edit is in view, past the first 5, not under the sticky head`, async () => {
    const page = await open(vp, { items: [...FULL.slice(0, 8), note('mem-s1', 'Prefers matte finishes.')] });
    const btn = page.locator('#memoryList [data-mem-fact="mem-s1"]');
    await btn.scrollIntoViewIfNeeded(); await btn.click();
    await page.waitForFunction(() => document.activeElement?.matches('[data-fact-id="mem-s1"] [data-fact-edit]'), null, T);
    assert.equal(await page.locator('#ownerFactsMore').getAttribute('aria-expanded'), 'true', 'the list opened to show it');
    assert.equal(await uncovered(page), true);
    await close(page);
  });
}

await check('editing a fact past the first 5 keeps focus on it after Save', async () => {
  const page = await open(desk, { items: FULL.slice(0, 9) });
  await page.locator('#ownerFactsMore').click();
  await rows(page).nth(7).getByRole('button', { name: 'Edit' }).click();
  await page.locator('#ownerFactEdit').fill('Fact eight, edited.');
  await page.locator('#ownerFactEdit').press('Enter');
  await page.waitForFunction(() => document.activeElement?.matches('[data-fact-id="f7"] [data-fact-edit]'), null, T);
  assert.equal(await uncovered(page), true);
  await close(page);
});

await check('error: a failed read says so, never "No facts yet", and Try again reads it again', async () => {
  const page = await open(desk, { items: [fact('a', 'Answers in metric.')], fail: { read: 500 } });
  await page.locator('#ownerFactsError[role="alert"]', { hasText: "Couldn't read your saved facts: database is locked." }).waitFor(T);
  assert.equal(await group(page).getByText('No facts yet').count(), 0);
  assert.equal(await page.locator('#ownerFactsAdd').count(), 0, 'no Add while the list is unknown');
  page.db.fail.read = 0;
  await page.locator('#ownerFactsRetry').click();
  await rows(page).first().waitFor(T);
  assert.equal(await page.locator('#ownerFactsError').count(), 0);
  await close(page);
});

await check('loading, and a script that fails to load says so instead of loading forever', async () => {
  const page = await open(desk, { loadScript: false });
  await page.locator('#ownerFactsBody .ui-notice--bad[role="alert"]', { hasText: "Couldn't load this." }).waitFor(T);
  await close(page);
  const slow = await browser.newContext({ serviceWorkers: 'block', viewport: desk });
  const p = await slow.newPage();
  await p.route(u => u.pathname === '/api/memory', () => {});   // never answers
  await p.goto(base + '/#memory', { waitUntil: 'domcontentloaded' });
  await p.locator('#ownerFactsBody[aria-busy="true"] .ui-skeleton').first().waitFor(T);
  await p.locator('#ownerFactsBody [role="status"]', { hasText: 'Loading your facts' }).waitFor({ state: 'attached', ...T });
  await slow.close();
});

await check('Make this a fact: on short shared notes only; it moves the note into the list, and a refusal is said beside it', async () => {
  const long = 'w'.repeat(240);
  const page = await open(desk, { items: [fact('a', 'Answers in metric.', 1), note('mem-s1', 'Prefers matte finishes.', '', 2), note('mem-s2', long, '', 3), note('mem-s3', 'Backups go to the NAS.', '', 4), note('mem-p1', 'Budget 18k', 'prj-1', 5)] });
  const card = id => page.locator(`#memoryList .memory-card:has([data-mem-del="${id}"])`);
  await card('mem-s1').locator('[data-mem-fact]').waitFor(T);
  assert.equal(await card('mem-s2').locator('[data-mem-fact]').count(), 0, 'a note over 200 characters cannot become a fact');
  assert.equal(await card('mem-p1').locator('[data-mem-fact]').count(), 0, 'a project note cannot');
  await card('mem-s1').getByRole('button', { name: 'Make this a fact' }).click();
  await rows(page).nth(1).locator('.owner-fact__text', { hasText: 'Prefers matte finishes.' }).waitFor(T);
  assert.deepEqual(page.db.posts.at(-1), { kind: 'update', id: 'mem-s1', category: 'owner' });
  await page.waitForFunction(() => !document.querySelector('#memoryList [data-mem-del="mem-s1"]'), null, T);
  await page.locator('#toast', { hasText: 'Made it a fact' }).waitFor(T);
  page.db.fail.update = 409;
  await card('mem-s3').getByRole('button', { name: 'Make this a fact' }).click();
  await card('mem-s3').locator('.owner-facts__error[role="alert"]', { hasText: "Couldn't make it a fact: Your list is full: 30 of 30" }).waitFor(T);
  assert.equal(await card('mem-s3').getByRole('button', { name: 'Make this a fact' }).isEnabled(), true);
  // Choosing a project and coming back to Shared redraws the notes; the button comes back with them.
  await page.locator('#memoryProject').selectOption('prj-1');
  await card('mem-p1').waitFor(T);
  assert.equal(await page.locator('#memoryList [data-mem-fact]').count(), 0);
  await page.locator('#memoryProject').selectOption('');
  await card('mem-s3').locator('[data-mem-fact]').waitFor(T);
  assert.deepEqual(page.errors, []);
  await close(page);
});

await check('keyboard only: add, edit and delete with Tab, Enter and Escape, with the focus ring showing', async () => {
  const page = await open(desk, { items: [fact('a', 'Answers in metric.', 1)] });
  const ring = () => page.evaluate(() => { const s = getComputedStyle(document.activeElement); return s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2; });
  await page.locator('#ownerFactsTitle').evaluate(h => { h.tabIndex = -1; h.focus(); });
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Edit');
  assert.ok(await ring(), 'Edit shows the focus ring');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Delete');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'ownerFactText');
  assert.ok(await ring(), 'the field shows the focus ring');
  await page.keyboard.type('The PC has a GTX 1660 Super.');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('#ownerFactsList > li').length === 2, null, T);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'ownerFactText', 'focus stays on Add for the next one');
  await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.activeElement.closest('li')?.textContent.includes('GTX') && document.activeElement.textContent), 'Edit');
  await page.keyboard.press('Enter');
  await page.keyboard.press('End');
  await page.keyboard.type(' 6 GB.');
  await page.keyboard.press('Enter');
  await rows(page).nth(1).locator('.owner-fact__text', { hasText: 'Super. 6 GB.' }).waitFor(T);
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Delete');
  await page.keyboard.press('Enter');
  await page.locator('dialog.ask-sheet--danger').waitFor(T);
  await page.keyboard.press('Escape');
  await page.locator('dialog.ask-sheet--danger').waitFor({ state: 'detached', ...T });
  assert.equal(await rows(page).count(), 2);
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Delete', 'focus returns to Delete');
  await close(page);
});

for (const [name, vp] of [['phone', phone], ['desktop', desk]]) {
  await check(`long content on ${name}: no horizontal overflow; touch-size controls; axe finds nothing serious`, async () => {
    const longWord = 'x'.repeat(200), longSentence = ('The workshop printer is a Bambu Lab X2D with the AMS, and I mostly print PLA and PETG at 0.2 mm layers ').slice(0, 199) + '.';
    const page = await open(vp, { items: [fact('a', longWord, 1), fact('b', longSentence, 2), fact('c', '<img src=x onerror="window.__xss=1">', 3), note('mem-s1', 'Prefers matte finishes.')] });
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    assert.equal(await rows(page).nth(2).locator('img').count(), 0);
    const over = await page.evaluate(() => [...document.querySelectorAll('#ownerFacts *')].filter(e => e.getBoundingClientRect().right > document.documentElement.clientWidth + 1).map(e => e.className || e.tagName).slice(0, 5));
    assert.deepEqual(over, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
    if (vp === phone) {
      const small = await page.evaluate(() => [...document.querySelectorAll('#ownerFacts button, #ownerFacts input, #memoryList [data-mem-fact]')].filter(e => e.offsetParent).map(e => e.getBoundingClientRect()).filter(r => r.height < 44 || r.width < 44).length);
      assert.equal(small, 0, 'every control is at least 44 px on touch');
    }
    await page.locator('#memoryList [data-mem-fact]').waitFor(T);
    await addAxe(page, axePath);
    const found = await page.evaluate(async () => (await window.axe.run(document.querySelector('#memory'), { resultTypes: ['violations'] })).violations.filter(v => ['serious', 'critical'].includes(v.impact)).map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).slice(0, 3).join(', ')}`));
    assert.deepEqual(found, []);
    await rows(page).nth(0).getByRole('button', { name: 'Edit' }).click();
    await page.locator('#ownerFactEdit').fill('');
    await page.getByRole('button', { name: 'Save fact' }).click();
    await page.locator('[data-fact-id="a"] .owner-facts__error', { hasText: 'Write the fact first, or Delete it.' }).waitFor(T);
    // Off the button first: the kit's light-mode hover on a primary button measures 4.08:1 (appliance-ui's to fix), and
    // this checks the form at rest.
    await page.mouse.move(0, 0);
    const editAxe = await page.evaluate(async () => (await window.axe.run(document.querySelector('#ownerFacts'), { resultTypes: ['violations'] })).violations.filter(v => ['serious', 'critical'].includes(v.impact)).map(v => v.id + ' ' + v.nodes.map(n => n.target.join(' ') + ' ' + n.failureSummary).join(' | ')));
    assert.deepEqual(editAxe, [], 'the edit form passes too');
    if (process.env.OWNER_FACTS_SHOTS) await page.screenshot({ path: join(process.env.OWNER_FACTS_SHOTS, `memory-${name}.png`), fullPage: true });
    await close(page);
  });
}

await browser.close();
if (failures.length) { console.error(`\n${failures.length} failed:\n${failures.join('\n')}`); process.exit(1); }
