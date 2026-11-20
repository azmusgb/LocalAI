import './browser-target-guard.mjs';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { addAxe } from './axe-helper.mjs';

// This browser's sign-in (sign-in design A2, signin-report.js): one notice above every page while it isn't signed in,
// with one action that goes to pairing (Improve › Claude Code); a read refused for sign-in says "Sign in on this device to
// see …" in place of the page's error, ⌘K's Past work too. whoami decides at load, any 401 {signIn:true} decides too, and a
// failed whoami decides nothing. A throwaway server answers from loopback, so it is the host and always signed in: the
// refusals are Playwright routes. LOCALAI_SHOTS=<dir> saves screenshots at phone and desktop widths, light and dark.
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
const DESK = { width: 1440, height: 900 }, PHONE = { width: 390, height: 844 };

// who: the whoami answer ({paired, signedIn}), a status number for a failed one, or null to let the server answer.
// refuse: the guarded reads answer 401 {signIn:true}, as they do through Caddy without a device.
async function open({ who = null, refuse = false, viewport = DESK, colorScheme = 'dark', hash = '#home', hasTouch = false } = {}) {
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
  if (refuse) for (const p of ['**/api/improve/items*', '**/api/journal?*', '**/api/claude/board*', '**/api/facts/suggestions*'])
    await page.route(p, route => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify(REFUSED) }));
  await page.goto(base + '/' + hash, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.showView === 'function' && window.LocalAISignIn && document.getElementById('signinNotice'));
  return page;
}
const notice = page => page.locator('#signinNotice .ui-notice');
const shot = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`) }); };
const settle = page => page.waitForTimeout(600);
async function axe(page, sel) {
  await addAxe(page, axePath);
  const r = await page.evaluate(([s, tags]) => window.axe.run(s, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] }), [sel, TAGS]);
  return r.violations.filter(v => v.impact === 'serious' || v.impact === 'critical').map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`);
}

await check('not signed in (whoami): one calm notice under the page strip, read politely, with one action to pairing', async () => {
  const page = await open({ who: { paired: false, signedIn: false } });
  await notice(page).waitFor(T);
  assert.equal(await page.locator('#signinNotice').getAttribute('aria-live'), 'polite');
  assert.equal(await page.locator('.ui-notice', { hasText: "isn't signed in" }).count(), 1, 'one notice on the page');
  assert.match(await notice(page).getAttribute('class'), /ui-notice--warn/, "the kit's notice");
  assert.equal((await notice(page).locator('span').innerText()).trim(), "This browser isn't signed in to Local AI, so some pages stay hidden.");
  const pair = notice(page).locator('a[data-signin-pair]');
  assert.equal(await pair.count(), 1, 'one action');
  assert.equal(await pair.innerText(), 'Pair this browser');
  assert.equal(await pair.getAttribute('href'), '#claude');
  // Under the area's strip, above the page (DESIGN, the page: the notice sits under the strip).
  const order = await page.evaluate(() => { const n = document.getElementById('signinNotice'), s = document.getElementById('uxPageStrip') || document.getElementById('uxContextBar'); return !s || !!(s.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING); });
  assert.ok(order, 'after the page strip');
  // Keyboard: Tab reaches it, and its focus ring shows.
  await pair.focus();
  assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-signin-pair')), true);
  await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
  const ring = await page.evaluate(() => { const a = document.activeElement, s = a && getComputedStyle(a); return a?.hasAttribute('data-signin-pair') ? `${s.outlineStyle} ${s.outlineWidth}` : 'not focused'; });
  assert.match(ring, /^solid 2px$/, 'a visible focus ring');
  assert.deepEqual(await axe(page, '#signinNotice'), []);
  assert.deepEqual(page.errors, []);
  await shot(page, 'notice-desktop-dark');
  await page.context().close();
});

await check('a read refused for sign-in says "Sign in on this device to see …" with the same action, not an error', async () => {
  const page = await open({ who: { paired: false, signedIn: false }, refuse: true, hash: '#backlog' });
  const state = page.locator('#backlogList [data-signin-state]');
  await state.waitFor(T);
  assert.equal((await state.locator('.empty-state__title').innerText()).trim(), 'Sign in on this device to see the backlog.');
  assert.equal(await state.locator('a[data-signin-pair][href="#claude"]').innerText(), 'Pair this browser');
  assert.equal(await page.locator('#backlogList [role="alert"], #backlogList button', { hasText: 'Retry' }).count(), 0, 'no error to retry');
  assert.equal((await page.locator('#backlogTop').innerText()).trim(), 'Sign in on this device to see the Backlog.');
  assert.doesNotMatch(await page.locator('#backlogSources').innerText(), /Not answering/, 'a refused read is not a source that is down');
  assert.equal(await notice(page).count(), 1, 'and the one notice above the page');
  assert.deepEqual(await axe(page, '#backlog'), []);
  assert.deepEqual(page.errors, []);
  await shot(page, 'backlog-desktop-dark');
  await page.context().close();
});

await check("⌘K's Past work says to sign in, and its action closes the palette and opens pairing (no notice there)", async () => {
  const page = await open({ who: { paired: false, signedIn: false }, refuse: true });
  await page.waitForFunction(() => document.querySelector('#uxCommandBtn'));
  await page.locator('#uxCommandBtn').click(); await page.waitForSelector('#cmdk.show');
  await page.locator('#cmdkInput').pressSequentially('mode', { delay: 20 });
  const past = page.locator('#cmdkPast .ui-notice');
  await past.waitFor(T);
  assert.equal((await past.locator('span').innerText()).trim(), 'Sign in on this device to see past work.');
  assert.equal(await page.locator('#cmdkPast [data-cmd-journal-error]').count(), 0, "not \"Couldn't search past work\"");
  assert.match(await page.locator('#cmdkCount').textContent(), /sign in to see past work/);
  await shot(page, 'palette-desktop-dark');
  await past.locator('a[data-signin-pair]').click();
  await page.waitForSelector('#claude.active', T);
  assert.equal(await page.locator('#cmdk.show').count(), 0, 'the palette closed');
  assert.equal(await page.locator('#signinNotice').isVisible(), false, 'the pairing page needs no notice pointing at itself');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

await check('a failed whoami decides nothing: no notice until a real 401 {signIn:true}; a plain 401 changes nothing', async () => {
  const page = await open({ who: 503 });
  await settle(page);
  assert.ok(page.whoami >= 1, 'whoami was asked');
  assert.equal(await notice(page).count(), 0, 'not "not signed in" from a failed read');
  assert.equal(await page.evaluate(() => window.LocalAISignIn.get()), null, 'not known');
  await page.route('**/api/claude/chat/sessions', route => route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"Unauthorized"}' }));
  await page.evaluate(() => fetch('/api/claude/chat/sessions').catch(() => {}));
  await settle(page);
  assert.equal(await notice(page).count(), 0, 'a 401 without signIn is not a sign-in refusal');
  await page.route('**/api/journal?*', route => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify(REFUSED) }));
  const caught = await page.evaluate(() => window.LocalAIUI.fetchJson('/api/journal?q=x').then(() => null, e => ({ signIn: e.signIn, message: e.message })));
  assert.deepEqual(caught, { signIn: true, message: REFUSED.error }, 'the shared helper marks the refusal');
  await notice(page).waitFor(T);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

await check('signed in (paired): no notice, also after a page change', async () => {
  const page = await open({ who: { paired: true, signedIn: true } });
  await settle(page);
  assert.equal(await notice(page).count(), 0);
  assert.equal(await page.evaluate(() => window.LocalAISignIn.get()), 'in');
  await page.evaluate(() => window.showView('backlog')); await page.waitForSelector('#backlog.active');
  await settle(page);
  assert.equal(await notice(page).count(), 0);
  assert.equal(await page.locator('[data-signin-state]').count(), 0);
  await page.context().close();
});

await check('the host itself (the real whoami, from loopback): signed in, no notice, the Backlog reads', async () => {
  const page = await open({ hash: '#backlog' });
  await page.waitForFunction(() => window.LocalAISignIn.get() === 'in', null, T);
  await page.waitForFunction(() => document.querySelector('#backlogList > :not(.state-loading)'), null, T);
  assert.equal(await notice(page).count(), 0);
  assert.equal(await page.locator('[data-signin-state]').count(), 0);
  assert.equal(await page.locator('#signinNotice').innerHTML(), '', 'an empty live region, nothing drawn');
  await page.context().close();
});

await check('pairing elsewhere, then a page change: whoami is asked again and the notice goes', async () => {
  let signedIn = false;
  const page = await open({ who: null });
  await page.route('**/api/claude/chat/whoami', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ paired: signedIn, signedIn }) }));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await notice(page).waitFor(T);
  signedIn = true;
  await page.evaluate(() => { location.hash = '#work'; });
  await page.waitForFunction(() => !document.querySelector('#signinNotice .ui-notice'), null, T);
  await page.context().close();
});

await check('phone width, light and dark: the notice and its action fit without overflow, a 44 px target', async () => {
  for (const colorScheme of ['light', 'dark']) {
    const page = await open({ who: { paired: false, signedIn: false }, refuse: true, viewport: PHONE, colorScheme, hasTouch: true });
    await notice(page).waitFor(T);
    const m = await page.evaluate(() => { const n = document.querySelector('#signinNotice .ui-notice').getBoundingClientRect(), a = document.querySelector('#signinNotice a').getBoundingClientRect(); return { over: document.documentElement.scrollWidth - innerWidth, right: n.right, w: innerWidth, h: a.height }; });
    assert.ok(m.over <= 0, `no horizontal overflow (${m.over} px)`);
    assert.ok(m.right <= m.w, 'the notice fits the width');
    assert.ok(m.h >= 40, `a full-size target (${m.h} px)`);
    assert.deepEqual(await axe(page, '#signinNotice'), []);
    await shot(page, `notice-phone-${colorScheme}`);
    if (colorScheme === 'light') { await page.setViewportSize(DESK); await shot(page, 'notice-desktop-light'); }
    await page.evaluate(() => window.showView('backlog')); await page.locator('#backlogList [data-signin-state]').waitFor(T);
    await page.setViewportSize(PHONE);
    await page.locator('#backlogList').scrollIntoViewIfNeeded();
    await shot(page, `backlog-phone-${colorScheme}`);
    await page.context().close();
  }
});

await browser.close();
if (failures.length) { console.error(`\n${failures.length} failure(s):\n${failures.join('\n')}`); process.exit(1); }
console.log('signin-notice-ui: all passed');
