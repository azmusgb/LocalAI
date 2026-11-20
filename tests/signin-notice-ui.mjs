import './browser-target-guard.mjs';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { addAxe } from './axe-helper.mjs';

// This browser's sign-in (sign-in design A2, signin-report.js). In report mode a read refused with 401 {signIn:true}
// says "Pair this browser to see this. Approve the code on your Mac." where it was refused (Changes, Claude Code, ⌘K's
// Past work, suggested facts, the idea sheet), with one Pair action per screen. Only when sign-in is required for every
// route (whoami's mode) does one notice sit under the strip on every page. A failed whoami decides nothing. A throwaway
// server answers from loopback, so it is the host and always signed in: whoami and the refusals are Playwright routes.
// LOCALAI_SHOTS=<dir> saves screenshots at phone and desktop widths, light and dark.
const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const shots = process.env.LOCALAI_SHOTS || '';
if (shots) fs.mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ headless: true });
const failures = [];
async function check(name, fn) { try { await fn(); console.log('PASS', name); } catch (e) { failures.push(`${name}: ${e.message}`); console.error('FAIL', name, e.message); } }
const axePath = join(dirname(fileURLToPath(import.meta.url)), 'vendor', 'axe.min.js');
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']; // as axe-ui.mjs
const T = { timeout: 8000 };
const REFUSED = { error: 'Sign in on this device first: pair it under Improve › Claude Code.', signIn: true };
const SEE = 'Pair this browser to see this. Approve the code on your Mac.';
const ACT = 'Pair this browser to do this. Approve the code on your Mac.';
const OUT = { paired: false, signedIn: false, mode: 'report' }, REQUIRED = { paired: false, signedIn: false, mode: 'required' };
const DESK = { width: 1440, height: 900 }, PHONE = { width: 390, height: 844 };
const GUARDED_READS = ['**/api/improve/items*', '**/api/journal?*', '**/api/claude/board*', '**/api/facts/suggestions*'];
const refuse = route => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify(REFUSED) });

// who: the whoami answer, a status number for a failed one, or null to let the server answer.
// reads: the guarded reads answer 401 {signIn:true}, as they do through Caddy without a device.
async function open({ who = null, reads = false, viewport = DESK, colorScheme = 'dark', hash = '#home', hasTouch = false } = {}) {
  const context = await browser.newContext({ viewport, colorScheme, hasTouch, serviceWorkers: 'block' });
  const page = await context.newPage();
  page.errors = []; page.on('pageerror', e => page.errors.push(e.message));
  page.whoami = 0;
  await page.addInitScript(() => { try { localStorage.setItem('localai.firstRun.done', '1'); } catch {} });
  if (who !== null) await page.route('**/api/claude/chat/whoami', route => {
    page.whoami++;
    return typeof who === 'number' ? route.fulfill({ status: who, contentType: 'application/json', body: '{"error":"down"}' })
      : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(who) });
  });
  if (reads) for (const p of GUARDED_READS) await page.route(p, refuse);
  await page.goto(base + '/' + hash, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.showView === 'function' && window.LocalAISignIn && document.getElementById('signinNotice'));
  return page;
}
const notice = page => page.locator('#signinNotice .ui-notice');
const shot = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`) }); };
const settle = page => page.waitForTimeout(600);
const visiblePairs = (page, sel) => page.locator(`${sel} [data-signin-pair]:visible`).count();
async function axe(page, sel) {
  await addAxe(page, axePath);
  const r = await page.evaluate(([s, tags]) => window.axe.run(s, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] }), [sel, TAGS]);
  return r.violations.filter(v => v.impact === 'serious' || v.impact === 'critical').map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`);
}

await check('report mode, not paired, nothing refused: no notice on every page', async () => {
  const page = await open({ who: OUT });
  await page.waitForFunction(() => window.LocalAISignIn.get() === 'out', null, T);
  assert.equal(await page.evaluate(() => window.LocalAISignIn.mode()), 'report');
  await settle(page);
  assert.equal(await notice(page).count(), 0);
  assert.equal(await page.locator('#signinNotice').innerHTML(), '', 'an empty live region');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

await check('sign-in required: one notice under the page strip, read politely, with one Pair action', async () => {
  const page = await open({ who: REQUIRED });
  await notice(page).waitFor(T);
  assert.equal(await page.locator('#signinNotice').getAttribute('aria-live'), 'polite');
  assert.match(await notice(page).getAttribute('class'), /ui-notice--warn/, "the kit's notice");
  assert.equal((await notice(page).locator('span').innerText()).trim(), 'Pair this browser to use Local AI. Approve the code on your Mac.');
  const pair = notice(page).locator('a[data-signin-pair]');
  assert.equal(await pair.count(), 1, 'one action');
  assert.equal(await pair.innerText(), 'Pair this browser');
  assert.equal(await pair.getAttribute('href'), '#claude');
  const after = await page.evaluate(() => { const n = document.getElementById('signinNotice'), s = document.getElementById('uxPageStrip') || document.getElementById('uxContextBar'); return !s || !!(s.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING); });
  assert.ok(after, 'after the page strip');
  await pair.focus(); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
  const ring = await page.evaluate(() => { const a = document.activeElement, s = a && getComputedStyle(a); return a?.hasAttribute('data-signin-pair') ? `${s.outlineStyle} ${s.outlineWidth}` : 'not focused'; });
  assert.match(ring, /^solid 2px$/, 'keyboard reaches it, with a visible focus ring');
  assert.deepEqual(await axe(page, '#signinNotice'), []);
  assert.deepEqual(page.errors, []);
  await shot(page, 'required-notice-desktop-dark');
  await page.context().close();
});

await check('Changes, items read refused: the sentence and one Pair in the list, New idea disabled with its reason', async () => {
  const page = await open({ who: OUT, reads: true, hash: '#backlog' });
  const state = page.locator('#backlogList [data-signin-state]');
  await state.waitFor(T);
  assert.equal((await state.innerText()).replace(/\s+/g, ' ').trim(), `${SEE} Pair this browser`);
  assert.equal(await visiblePairs(page, '#backlog'), 1, 'one Pair button on the screen');
  assert.equal(await page.locator('#backlogList [role="alert"], #backlogList button', { hasText: 'Retry' }).count(), 0, 'no error to retry');
  const idea = page.locator('#improveNewIdea');
  assert.equal(await idea.isDisabled(), true);
  assert.equal((await page.locator('#improveNewIdeaWhy').innerText()).trim(), 'Pair this browser to add ideas.');
  assert.equal(await idea.getAttribute('aria-describedby'), 'improveNewIdeaWhy');
  assert.doesNotMatch(await page.locator('#backlogSources').innerText(), /Not answering/, 'a refused read is not a source that is down');
  assert.equal(await notice(page).count(), 0, 'no app-wide notice in report mode');
  assert.deepEqual(await axe(page, '#backlog'), []);
  assert.deepEqual(page.errors, []);
  await shot(page, 'changes-desktop-dark');
  await page.context().close();
});

await check('the idea sheet: a save refused for sign-in says so with Pair, which closes the sheet and opens pairing', async () => {
  const page = await open({ who: OUT, hash: '#backlog' });
  await page.route('**/api/improve/idea', refuse);
  await page.evaluate(() => { window.LocalAIImprove.openIdea('Remember my image size'); });
  await page.waitForSelector('#improveIdeaSheet[open]');
  await page.locator('#improveIdeaSheet [data-idea-start="false"]').click();
  const line = page.locator('#improveIdeaSignIn .ui-notice');
  await line.waitFor(T);
  assert.equal((await line.locator('span').innerText()).trim(), ACT);
  assert.equal(await page.locator('#improveIdeaError').isVisible(), false, 'not the raw error as well');
  assert.equal(await page.locator('#improveIdeaText').inputValue(), 'Remember my image size', 'what was typed is kept');
  await shot(page, 'idea-sheet-desktop-dark');
  await line.locator('[data-signin-pair]').click();
  await page.waitForSelector('#claude.active', T);
  assert.equal(await page.locator('#improveIdeaSheet[open]').count(), 0, 'the sheet closed');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

await check('Claude Code, board read refused: its activity says to pair (no second Pair), "not read", never stuck on Loading', async () => {
  const page = await open({ who: OUT, reads: true, hash: '#claude' });
  const state = page.locator('#claudeTimeline [data-signin-state]');
  await state.waitFor(T);
  assert.equal((await state.innerText()).replace(/\s+/g, ' ').trim(), SEE);
  assert.equal(await page.locator('#claudeTimeline [data-signin-pair]').count(), 0, 'the pairing card is the one way to pair here');
  assert.doesNotMatch(await page.locator('#claudeTimeline').innerText(), /Loading/);
  assert.equal((await page.locator('#claudeLive').innerText()).trim(), 'not read');
  assert.doesNotMatch(await page.locator('#claudeLive').getAttribute('class'), /\boff\b/, 'unknown, not offline');
  await page.locator('#claudeChatPair').waitFor(T);
  assert.match(await page.locator('#claudeChatPair').innerText(), /Pair this browser once: it signs it in to all of Local AI, not only this chat\. Approve the code on your Mac\./);
  assert.equal(await page.locator('#signinNotice').isVisible(), false);
  assert.deepEqual(await axe(page, '#claude'), []);
  assert.deepEqual(page.errors, []);
  await shot(page, 'claude-desktop-dark');
  await page.context().close();
});

await check("⌘K's Past work says to pair, and its action closes the palette and opens pairing", async () => {
  const page = await open({ who: OUT, reads: true });
  await page.waitForFunction(() => document.querySelector('#uxCommandBtn'));
  await page.locator('#uxCommandBtn').click(); await page.waitForSelector('#cmdk.show');
  await page.locator('#cmdkInput').pressSequentially('mode', { delay: 20 });
  const past = page.locator('#cmdkPast .ui-notice');
  await past.waitFor(T);
  assert.equal((await past.locator('span').innerText()).trim(), SEE);
  assert.equal(await page.locator('#cmdkPast [data-cmd-journal-error]').count(), 0, "not \"Couldn't search past work\"");
  assert.match(await page.locator('#cmdkCount').textContent(), /pair this browser to see past work/);
  await shot(page, 'palette-desktop-dark');
  await past.locator('a[data-signin-pair]').click();
  await page.waitForSelector('#claude.active', T);
  assert.equal(await page.locator('#cmdk.show').count(), 0, 'the palette closed');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

await check('inside Pi Hub, the words say "the Assistant"', async () => {
  const page = await open({ who: REQUIRED });
  await notice(page).waitFor(T);
  await page.evaluate(() => { window.LocalAIFramed.active = () => true; });
  assert.equal(await page.evaluate(() => window.LocalAISignIn.name()), 'the Assistant');
  await page.close();
  await page.context().close();
});

await check('a failed whoami decides nothing; a refused read still says to pair where it was refused', async () => {
  const page = await open({ who: 503, reads: true });
  await settle(page);
  assert.ok(page.whoami >= 1, 'whoami was asked');
  assert.equal(await page.evaluate(() => window.LocalAISignIn.get()), null, 'not known');
  const caught = await page.evaluate(() => window.LocalAIUI.fetchJson('/api/journal?q=x').then(() => null, e => ({ signIn: e.signIn, message: e.message })));
  assert.deepEqual(caught, { signIn: true, message: REFUSED.error }, 'the shared helper marks the refusal');
  const plain = await page.evaluate(() => window.LocalAIUI.fetchJson('/api/claude/chat/sessions').then(() => null, e => e.signIn));
  assert.equal(plain, false, 'a 401 without signIn is not a sign-in refusal');
  await page.evaluate(() => window.showView('backlog'));
  await page.locator('#backlogList [data-signin-state]').waitFor(T);
  assert.equal(await notice(page).count(), 0);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

await check('signed in (paired), and the host itself: nothing drawn, the Backlog reads', async () => {
  for (const who of [{ paired: true, signedIn: true, mode: 'report' }, null]) {
    const page = await open({ who, hash: '#backlog' });
    await page.waitForFunction(() => window.LocalAISignIn.get() === 'in', null, T);
    await page.waitForFunction(() => document.querySelector('#backlogList > :not(.state-loading)'), null, T);
    assert.equal(await notice(page).count(), 0);
    assert.equal(await page.locator('[data-signin-state], #improveNewIdeaWhy:visible').count(), 0);
    assert.equal(await page.locator('#improveNewIdea').isDisabled(), false);
    await page.context().close();
  }
});

await check('sign-in required, then paired elsewhere and a page change: whoami is asked again and the notice goes', async () => {
  let who = REQUIRED;
  const page = await open();
  await page.route('**/api/claude/chat/whoami', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(who) }));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await notice(page).waitFor(T);
  who = { paired: true, signedIn: true, mode: 'required' };
  await page.evaluate(() => { location.hash = '#work'; });
  await page.waitForFunction(() => !document.querySelector('#signinNotice .ui-notice'), null, T);
  await page.context().close();
});

await check('phone width, light and dark: the notice and Changes fit without overflow, a 44 px target', async () => {
  for (const colorScheme of ['light', 'dark']) {
    const page = await open({ who: REQUIRED, reads: true, viewport: PHONE, colorScheme, hasTouch: true });
    await notice(page).waitFor(T);
    const m = await page.evaluate(() => { const n = document.querySelector('#signinNotice .ui-notice').getBoundingClientRect(), a = document.querySelector('#signinNotice a').getBoundingClientRect(); return { over: document.documentElement.scrollWidth - innerWidth, right: n.right, w: innerWidth, h: a.height }; });
    assert.ok(m.over <= 0, `no horizontal overflow (${m.over} px)`);
    assert.ok(m.right <= m.w, 'the notice fits the width');
    assert.ok(m.h >= 44, `a full-size target (${m.h} px)`);
    assert.deepEqual(await axe(page, '#signinNotice'), []);
    await shot(page, `required-notice-phone-${colorScheme}`);
    if (colorScheme === 'light') { await page.setViewportSize(DESK); await shot(page, 'required-notice-desktop-light'); await page.setViewportSize(PHONE); }
    await page.context().close();
    const changes = await open({ who: OUT, reads: true, viewport: PHONE, colorScheme, hasTouch: true, hash: '#backlog' });
    await changes.locator('#backlogList [data-signin-state]').waitFor(T);
    assert.ok(await changes.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 0, 'Changes: no horizontal overflow');
    await shot(changes, `changes-phone-${colorScheme}`);
    await changes.locator('#backlogList').scrollIntoViewIfNeeded();
    await shot(changes, `changes-list-phone-${colorScheme}`);
    if (colorScheme === 'light') { await changes.setViewportSize(DESK); await shot(changes, 'changes-desktop-light'); }
    await changes.context().close();
  }
});

await browser.close();
if (failures.length) { console.error(`\n${failures.length} failure(s):\n${failures.join('\n')}`); process.exit(1); }
console.log('signin-notice-ui: all passed');
