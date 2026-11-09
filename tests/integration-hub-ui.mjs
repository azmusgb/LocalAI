import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const browser = await chromium.launch({ headless: true });
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    console.log('PASS', name);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.error('FAIL', name, error.message);
  }
}

const page = await browser.newPage({ serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } });
// ArtCraft lives on the Windows computer; stub the appliance's view of it.
const artcraftOpens = [];
let artcraftRunning = false;
await page.route(u => u.pathname === '/api/artcraft/status', r => r.fulfill({ json: { ok: true, installed: true, running: artcraftRunning, version: '0.41.0' } }));
await page.route(u => u.pathname === '/api/artcraft/open', r => {
  artcraftOpens.push({ method: r.request().method(), type: r.request().headers()['content-type'] });
  const already = artcraftRunning; artcraftRunning = true;
  return r.fulfill({ json: { ok: true, alreadyRunning: already } });
});
// The Workshop display is a device on the home network; stub the appliance's view of it.
const WORKSHOP_ONLINE = { online: true, board: 'Waveshare_ESP32-S3-Touch-LCD-3.5', panel: 'ST7796_320x480_FT6336', screen: 6, touchscreenConfigured: true, signIn: false, portalUrl: 'http://10.0.0.124', printer: null };
let workshopStatus = WORKSHOP_ONLINE;
await page.route(u => u.pathname === '/api/workshop/status', r => r.fulfill({ json: workshopStatus }));
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.ux-primary-rail');

await check('the connections are on Status, under its Services list', async () => {
  await page.locator('.ux-primary-item[data-domain="system"]').click();
  await page.waitForSelector('#status.active');
  await page.waitForSelector('#statusConnections[data-integration-v2="true"]');
  assert.equal(await page.locator('#uxPageStrip [data-strip-view="integrations"]').count(), 0, 'Connections has no page of its own');
  assert.equal(await page.locator('#integrations').count(), 0);
  assert.equal(await page.locator('#uxIntegrationRefreshV2').count(), 0, 'one Check again, on the Status plate');
  const below = await page.evaluate(() => document.querySelector('#serviceList').closest('.ui-section').compareDocumentPosition(document.querySelector('#statusConnections')) & Node.DOCUMENT_POSITION_FOLLOWING);
  assert.ok(below, 'the cards come after the Services list');
});

await check('native Local AI integrations remain first-class', async () => {
  const body = await page.locator('#statusConnections').innerText();
  assert.match(body, /n8n/i);
  assert.match(body, /ComfyUI/i);
  assert.match(body, /Built in/i);
  assert.match(body, /Built in · images/i);
  assert.equal(await page.locator('[data-integration-source-v2="n8n"]').count(), 1);
  assert.equal(await page.locator('[data-integration-source-v2="comfy"]').count(), 1);
});

await check('ArtCraft has a card that says it uses cloud services, shows whether it is open, and opens it', async () => {
  const card = page.locator('.ux-int-card', { hasText: 'ArtCraft' });
  const body = await card.innerText();
  assert.match(body, /On the Windows computer · uses cloud services/);
  assert.match(body, /cloud services and your ArtCraft account, unlike Images/);
  assert.match(body, /Use Images for anything private/);
  const live = card.locator('[data-integration-source-v2="artcraft"]');
  await page.waitForFunction(() => /Installed, not open · 0\.41\.0/.test(document.querySelector('[data-integration-source-v2="artcraft"]')?.textContent || ''));
  await card.getByRole('button', { name: 'Open on the Windows computer' }).click();
  await page.locator('#toast', { hasText: 'ArtCraft is opening on the Windows computer' }).waitFor();
  assert.deepEqual(artcraftOpens, [{ method: 'POST', type: 'application/json' }]);
  await card.getByRole('button', { name: 'Open on the Windows computer' }).click();
  await page.locator('#toast', { hasText: "It's already open there" }).waitFor();
  await page.locator('#statusRetryBtn').click();
  await page.waitForFunction(() => /Open now/.test(document.querySelector('[data-integration-source-v2="artcraft"]')?.textContent || ''));
  assert.match(await live.getAttribute('class'), /healthy/);
});

await check('the Workshop display card shows whether it is answering and opens its own portal in a new tab', async () => {
  const card = page.locator('.ux-int-card', { hasText: 'Workshop display' });
  const body = await card.innerText();
  assert.match(body, /On your network · no sign-in yet/);
  assert.match(body, /touchscreen beside the 3D printer/);
  assert.match(body, /has the printer controls and, for now, no sign-in/);
  assert.match(body, /Away from home, Tailscale must be on\./);
  const live = '[data-integration-source-v2="workshop"]';
  await page.waitForFunction(s => /Online · Waveshare 3\.5"/.test(document.querySelector(s)?.textContent || ''), live);
  assert.match(await card.locator(live).getAttribute('class'), /healthy/);
  const link = card.getByRole('link', { name: 'Open Workshop portal' });
  assert.equal(await link.isVisible(), true);
  assert.equal(await link.getAttribute('href'), 'http://10.0.0.124');
  assert.equal(await link.getAttribute('target'), '_blank');
  assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');

  workshopStatus = { online: false, board: null, panel: null, screen: null, touchscreenConfigured: null, signIn: null, portalUrl: 'http://10.0.0.124', printer: null };
  await page.locator('#statusRetryBtn').click();
  await page.waitForFunction(s => /Not answering/.test(document.querySelector(s)?.textContent || ''), live);
  assert.doesNotMatch(await card.locator(live).getAttribute('class'), /healthy/);
  assert.equal(await link.isVisible(), true, 'the portal can still be opened while the appliance cannot reach it');
  assert.equal(await link.getAttribute('href'), 'http://10.0.0.124');

  workshopStatus = { ...workshopStatus, portalUrl: null };
  await page.locator('#statusRetryBtn').click();
  await page.waitForFunction(s => /Address not set up/.test(document.querySelector(s)?.textContent || ''), live);
  assert.equal(await card.locator('[data-integration-portal]').isVisible(), false, 'no link without a valid address');
  workshopStatus = WORKSHOP_ONLINE;
  await page.locator('#statusRetryBtn').click();
  await page.waitForFunction(s => /Online/.test(document.querySelector(s)?.textContent || ''), live);
});

await check('the Workshop display card: a 401 reads as online with its own sign-in, never offline; printer status words', async () => {
  const card = page.locator('.ux-int-card', { hasText: 'Workshop display' });
  const live = '[data-integration-source-v2="workshop"]';
  const refresh = async (status, re) => { workshopStatus = status; await page.locator('#statusRetryBtn').click(); await page.waitForSelector('#statusConnections[aria-busy="false"]'); await page.waitForFunction(([s, r]) => new RegExp(r).test(document.querySelector(s)?.textContent || ''), [live, re.source]); };
  const signedIn = { online: true, board: null, panel: null, screen: null, touchscreenConfigured: null, signIn: true, portalUrl: 'http://10.0.0.124', printer: null };
  await refresh(signedIn, /Online · sign-in on/);
  assert.match(await card.locator(live).getAttribute('class'), /healthy/);
  let body = await card.innerText();
  assert.match(body, /On your network · its own sign-in/);
  assert.match(body, /the portal asks for the code shown on the display \(System → Local Portal\)/);
  assert.doesNotMatch(body, /no sign-in/);
  assert.equal(await card.locator('[data-workshop-printer]').isVisible(), false, 'no token, no printer line');

  // Offline keeps the sign-in words the display last gave.
  await refresh({ ...signedIn, online: false, signIn: null }, /Not answering/);
  assert.match(await card.innerText(), /On your network · its own sign-in/);

  const printer = (state, o = {}) => ({ state, progress: null, minutesLeft: null, errorCode: null, access: 'ok', seenAt: '2026-10-18T12:00:00.000Z', ...o });
  const line = card.locator('[data-workshop-printer]');
  await refresh({ ...signedIn, printer: printer('printing', { progress: 42, minutesLeft: 70 }) }, /sign-in on/);
  assert.equal(await line.innerText(), 'Printer · 42% · 1 h 10 min left');
  await refresh({ ...signedIn, printer: printer('idle') }, /sign-in on/);
  assert.equal(await line.innerText(), 'Printer · Idle');
  await refresh({ ...signedIn, printer: printer('cancelled') }, /sign-in on/);
  assert.equal(await line.innerText(), 'Printer · Print stopped', 'a print stopped on purpose is not an error');
  await refresh({ ...signedIn, printer: printer('ended') }, /sign-in on/);
  assert.equal(await line.innerText(), 'Printer · Print ended — check the display', 'FAILED with no code is neither a stop nor an error');
  await refresh({ ...signedIn, printer: printer('error', { errorCode: '0700_8010' }) }, /sign-in on/);
  assert.equal(await line.innerText(), 'Printer · Stopped with an error (0700_8010)', 'a real fault still says so');
  await refresh({ ...signedIn, printer: { ...printer('unknown'), access: 'refused' } }, /sign-in on/);
  assert.match(await line.innerText(), /turned the token down/);
  await refresh({ ...signedIn, printer: { ...printer('unknown'), access: 'unsupported' } }, /sign-in on/);
  assert.match(await line.innerText(), /update the display/);
  // Two 429s in a row, or no good answer for 2 minutes: the old progress is not left up.
  await refresh({ ...signedIn, printer: printer('printing', { progress: 42 }) }, /sign-in on/);
  await refresh({ ...signedIn, printer: { ...printer('unknown'), access: 'busy' } }, /sign-in on/);
  assert.equal(await line.innerText(), 'Printer status: the display is busy.');
  await refresh({ ...signedIn, printer: { ...printer('unknown'), access: 'stale' } }, /sign-in on/);
  assert.equal(await line.innerText(), 'Printer status: no recent answer.');

  await refresh(WORKSHOP_ONLINE, /Online · Waveshare/);
  body = await card.innerText();
  assert.match(body, /On your network · no sign-in yet/, 'an answer without a 401 means no sign-in yet');
  assert.equal(await line.isVisible(), false);
});

await check('services are grouped: what works here is open, ideas and outside websites fold away', async () => {
  const groups = page.locator('#uxIntegrationCardsV2 .ux-int-group');
  assert.deepEqual(await groups.locator('h3').allInnerTexts(), ['Working here', 'Could add', 'Outside websites']);
  assert.equal(await page.locator('#uxIntegrationCardsV2 details.ux-int-group[open]').count(), 0);
  assert.ok(await page.locator('#uxIntegrationCardsV2 section.ux-int-group .ux-int-card', { hasText: 'Workshop display' }).isVisible());
  // Open the folded groups the way a person would, for the checks below.
  for (const summary of await page.locator('#uxIntegrationCardsV2 details.ux-int-group > summary').all()) await summary.click();
});

await check('unverified media extensions do not pretend to be installed', async () => {
  const svd = page.locator('.ux-int-card', { hasText: 'Stable Video Diffusion' });
  const sad = page.locator('.ux-int-card', { hasText: 'SadTalker' });
  assert.match(await svd.innerText(), /Not set up/i);
  assert.match(await sad.innerText(), /Not set up/i);
  // No live status: nothing is checked for what isn't set up.
  assert.equal(await svd.locator('.ux-int-live').count(), 0);
  assert.equal(await sad.locator('.ux-int-live').count(), 0);
});

await check('research-backed safeguards are visible and actionable', async () => {
  // Policy, safeguards and the roadmap sit behind one disclosure; open it the way a person would.
  const about = page.locator('.ux-int-about');
  if (await about.getAttribute('open') === null) await about.locator('summary').click();
  const research = page.locator('.ux-int-research');
  const body = await research.innerText();
  assert.match(body, /n8n security check/i);
  assert.match(body, /ComfyUI add-ons/i);
  assert.match(body, /Penpot on your own server/i);
  assert.ok(await research.locator('a[target="_blank"]').count() >= 3);
});

await check('Penpot bridge favors self-hosting and MCP', async () => {
  const card = page.locator('.ux-int-card', { hasText: 'Penpot' });
  const body = await card.innerText();
  assert.match(body, /if you run your own copy/i);
  assert.match(body, /access key is a password/i);
  const hrefs = await card.locator('a').evaluateAll(nodes => nodes.map(node => node.href));
  assert.ok(hrefs.some(href => href.includes('help.penpot.app/technical-guide/getting-started')));
  assert.ok(hrefs.some(href => href.includes('help.penpot.app/mcp')));
});

await check('Obsidian is modeled as a local vault bridge', async () => {
  const card = page.locator('.ux-int-card', { hasText: 'Obsidian' });
  const body = await card.innerText();
  assert.match(body, /Obsidian notes as Sources/i);
  assert.match(body, /only read the vault folder/i);
  assert.equal(await card.locator('[data-integration-view="projects"]').count(), 1);
});

await check('external trust crossings are explicit', async () => {
  const external = page.locator('#statusConnections [data-external="true"]');
  assert.ok(await external.count() >= 6);
  for (const link of await external.all()) {
    assert.match(await link.getAttribute('aria-label'), /opens external site/i);
    assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
  }
});

await check('reviewed alternatives are progressive disclosure', async () => {
  const details = page.locator('.ux-int-reviewed');
  assert.equal(await details.getAttribute('open'), null);
  await details.locator('summary').click();
  await page.locator('#uxIntegrationAlternativesV2').waitFor({ state: 'visible' });
  const body = await page.locator('#uxIntegrationAlternativesV2').innerText();
  for (const label of ['Gemini', 'Nano Banana', 'ImageFX', 'Google Flow', 'DALL', 'Meta AI', 'You.com', 'Coze', 'Bardeen', 'Pixlr', 'Lovart', 'Laxis', 'Google Slides', '10Web', 'Icons8']) {
    assert.match(body, new RegExp(label, 'i'));
  }
});

await check('integration status refresh is resilient and remains in-page', async () => {
  const button = page.locator('#statusRetryBtn');
  await button.click();
  await page.waitForFunction(() => document.querySelector('#statusConnections')?.getAttribute('aria-busy') === 'false');
  assert.match(await page.locator('#uxIntegrationStatusSummaryV2').innerText(), /^Checked /);
  assert.equal(await button.isEnabled(), true);
  // A failed read says so, keeps the cards, and the next Check again recovers.
  let failReads = true;
  await page.route(u => ['/api/status', '/api/gridcraft/health', '/api/artcraft/status', '/api/workshop/status'].includes(u.pathname), r => failReads ? r.abort() : r.fallback());
  await button.click();
  await page.waitForFunction(() => /unavailable/.test(document.querySelector('#uxIntegrationStatusSummaryV2')?.textContent || ''));
  assert.ok(await page.locator('#uxIntegrationCardsV2 .ux-int-card').count() >= 6, 'the cards stay when the read fails');
  failReads = false;
  await button.click();
  await page.waitForFunction(() => /^Checked /.test(document.querySelector('#uxIntegrationStatusSummaryV2')?.textContent || ''));
});

await check('each service says when it was last asked and whether it answered; no answer never reads as healthy', async () => {
  const ago = new Date(Date.now() - 60000).toISOString();
  let n8n = { name: 'n8n', state: 'HEALTHY', statusCode: 200, checkedAt: ago };
  const isStatus = u => u.pathname === '/api/status';
  await page.route(isStatus, r => r.fulfill({ json: { overall: 'DEGRADED', checkedAt: ago, services: [n8n, { name: 'comfy', state: 'DOWN', statusCode: null, error: 'refused' }] } }));
  const refresh = async () => { await page.waitForFunction(() => document.querySelector('#uxIntegrationRefreshV2')?.getAttribute('aria-busy') === 'false'); await page.locator('#uxIntegrationRefreshV2').click(); };
  const seen = name => page.locator(`[data-integration-seen="${name}"]`);
  const clock = d => new Date(d).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  await refresh();
  await page.waitForFunction(t => document.querySelector('[data-integration-seen="n8n"]')?.textContent === t, `Answered at ${clock(ago)}`);
  // ComfyUI's probe has no checkedAt (an older server): nothing is shown, not a made-up time.
  assert.equal(await seen('comfy').innerText(), '');
  assert.equal(await seen('artcraft').count(), 1);
  assert.match(await seen('artcraft').innerText(), /^Answered at /);
  // n8n stops answering: the card says so, with the last time it did.
  n8n = { name: 'n8n', state: 'DOWN', statusCode: null, checkedAt: new Date().toISOString(), error: 'refused' };
  await refresh();
  await page.waitForFunction(() => /^No answer at/.test(document.querySelector('[data-integration-seen="n8n"]')?.textContent || ''));
  assert.equal(await seen('n8n').innerText(), `No answer at ${clock(n8n.checkedAt)} · last answered ${clock(ago)}`);
  assert.equal(await seen('n8n').getAttribute('data-tone'), 'attention');
  // The whole status request fails: every core service says no answer rather than keeping a healthy-looking time.
  await page.unroute(isStatus);
  await page.route(isStatus, r => r.abort());
  await refresh();
  await page.waitForFunction(() => /^No answer at/.test(document.querySelector('[data-integration-seen="comfy"]')?.textContent || ''));
  assert.match(await seen('comfy').innerText(), /^No answer at .* · no answer yet this visit$/);
  await page.unroute(isStatus);
});

await page.close();

const mobile = await browser.newPage({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
await mobile.goto(base, { waitUntil: 'domcontentloaded' });
await mobile.waitForSelector('#uxMobileNav');

await check('the connections are on Status on mobile', async () => {
  await mobile.locator('#uxMobileNav [data-domain="system"]').click();
  await mobile.waitForSelector('#status.active');
  await mobile.waitForSelector('#statusConnections[data-integration-v2="true"]');
});

await check('integration hub does not create horizontal page overflow on mobile', async () => {
  const dims = await mobile.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth
  }));
  assert.ok(dims.scrollWidth <= dims.clientWidth + 2, `scrollWidth ${dims.scrollWidth} > clientWidth ${dims.clientWidth}`);
});

await check('integration actions meet mobile touch-target guidance', async () => {
  const action = mobile.locator('#uxIntegrationCardsV2 .ux-int-action').first();
  await action.waitFor({ state: 'visible' });
  const box = await action.boundingBox();
  assert.ok(box && box.height >= 44, `expected >=44px touch target, got ${box?.height}`);
});

await mobile.close();

// Workshop display › Show sign-in code, at iPhone width on the page's own clock (so the 60 s hide is checked without waiting).
{
  const CODE = 'QWZ7RT4XKP';
  const phone = await browser.newPage({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await phone.clock.install();
  let codeStatus = { ...WORKSHOP_ONLINE, signIn: true, codeAccess: false };
  let codeAnswer = { status: 200, json: { code: CODE, address: 'http://10.0.0.124' } };
  const asks = [];
  await phone.route(u => u.pathname === '/api/workshop/status', r => r.fulfill({ json: codeStatus }));
  await phone.route(u => u.pathname === '/api/workshop/portal-code', r => {
    asks.push({ method: r.request().method(), type: r.request().headers()['content-type'] });
    return r.fulfill({ status: codeAnswer.status, headers: { 'Cache-Control': 'no-store' }, json: codeAnswer.json });
  });
  // Capture what Copy puts on the clipboard.
  await phone.addInitScript(() => { window.__copied = []; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async t => { window.__copied.push(t); } } }); });
  await phone.goto(`${base}#integrations`, { waitUntil: 'domcontentloaded' });
  await phone.waitForSelector('#status.active #statusConnections[data-integration-v2="true"]');
  const card = phone.locator('.ux-int-card', { hasText: 'Workshop display' });
  const refresh = async () => { await phone.locator('#statusRetryBtn').click(); await phone.waitForSelector('#statusConnections[aria-busy="false"]'); };
  const show = card.getByRole('button', { name: 'Show sign-in code' });
  const value = card.locator('[data-workshop-code-value]');

  await check('Workshop sign-in code: without code access, one muted line says how to add it and there is no button', async () => {
    await refresh();
    const off = card.locator('[data-workshop-code-off]');
    await off.waitFor({ state: 'visible' });
    assert.equal(await off.innerText(), "To show the sign-in code here, add code access in the display's portal (More → Sign-in code access)");
    assert.equal(await show.isVisible(), false);
  });

  await check('Workshop sign-in code: shows the code large in two groups of 5, with Copy and Open portal, 44 px targets at iPhone width', async () => {
    codeStatus = { ...codeStatus, codeAccess: true };
    await refresh();
    await show.waitFor({ state: 'visible' });
    assert.equal(await card.locator('[data-workshop-code-off]').isVisible(), false);
    await show.click();
    await value.waitFor({ state: 'visible' });
    assert.equal(await value.innerText(), 'QWZ7R T4XKP');
    assert.equal(await value.getAttribute('aria-label'), 'Sign-in code Q W Z 7 R T 4 X K P');
    assert.deepEqual(asks, [{ method: 'POST', type: 'application/json' }]);
    const size = await value.evaluate(el => parseFloat(getComputedStyle(el).fontSize));
    assert.ok(size >= 26, `the code is large (${size}px)`);
    const portal = card.getByRole('link', { name: 'Open portal (opens in a new tab)' });
    assert.equal(await portal.getAttribute('href'), 'http://10.0.0.124');
    assert.equal(await portal.getAttribute('target'), '_blank');
    assert.equal(await portal.getAttribute('rel'), 'noopener noreferrer');
    for (const target of [card.getByRole('button', { name: 'Copy' }), portal, card.getByRole('button', { name: 'Hide' })]) {
      const box = await target.boundingBox();
      assert.ok(box && box.height >= 44 && box.width >= 44, `tap target ${box?.width}x${box?.height}`);
    }
    const dims = await phone.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    assert.ok(dims[0] <= dims[1] + 2, `no sideways scroll (${dims})`);
    await card.getByRole('button', { name: 'Copy' }).click();
    await phone.locator('#toast', { hasText: 'Code copied' }).waitFor();
    assert.deepEqual(await phone.evaluate(() => window.__copied), [CODE], 'copied without the space');
    const kept = await phone.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, url: location.href }));
    assert.ok(!kept.includes(CODE) && !kept.includes('QWZ7R'), 'never in storage or the address');
  });

  await check('Workshop sign-in code: hides itself after 60 s', async () => {
    await phone.clock.runFor(59000);
    assert.equal(await value.isVisible(), true, 'still shown at 59 s');
    await phone.clock.runFor(1500);
    assert.equal(await value.isVisible(), false, 'gone at 60 s');
    assert.equal(await value.evaluate(el => el.textContent), '', 'and taken out of the page');
    assert.equal(await show.isVisible(), true, 'the button is back');
  });

  await check('Workshop sign-in code: hides when the page is hidden, and says plainly why it cannot be shown', async () => {
    await show.click();
    await value.waitFor({ state: 'visible' });
    await phone.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
    assert.equal(await value.isVisible(), false);
    assert.equal(await value.evaluate(el => el.textContent), '');
    await phone.evaluate(() => { delete document.hidden; });
    const reason = "The display turned the key down: it was revoked or replaced. Add code access again in the display's portal and update stack.env.";
    codeAnswer = { status: 502, json: { reason: 'refused', error: reason } };
    await show.click();
    await card.locator('[data-workshop-code-msg]', { hasText: 'turned the key down' }).waitFor();
    assert.equal(await value.isVisible(), false);
    codeAnswer = { status: 503, json: { reason: 'busy', error: 'The display is busy. Try again in a few minutes.' } };
    await show.click();
    await card.locator('[data-workshop-code-msg]', { hasText: 'busy' }).waitFor();
    assert.equal(await show.isEnabled(), true);
  });

  // The plain-http address has no clipboard API; Copy still works.
  await check('Workshop sign-in code: Copy works without the clipboard API (plain http)', async () => {
    codeAnswer = { status: 200, json: { code: CODE, address: 'http://10.0.0.124' } };
    await phone.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }); window.__copied = []; document.addEventListener('copy', () => { const t = document.activeElement; window.__copied.push(t.value.slice(t.selectionStart, t.selectionEnd)); }); });
    await show.click();
    await value.waitFor({ state: 'visible' });
    await card.getByRole('button', { name: 'Copy' }).click();
    await phone.locator('#toast', { hasText: 'Code copied' }).waitFor();
    assert.deepEqual(await phone.evaluate(() => window.__copied), [CODE]);
    assert.equal(await phone.locator('textarea[readonly]').count(), 0, 'the helper box is gone');
    await card.getByRole('button', { name: 'Hide' }).click();
    assert.equal(await value.isVisible(), false);
  });
  await phone.close();
}

await browser.close();

if (failures.length) {
  console.error(`\n${failures.length} integration hub check(s) failed:`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('\nAll integration hub checks passed.');
