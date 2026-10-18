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
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.ux-primary-rail');

await check('integration hub is reachable from System', async () => {
  await page.locator('.ux-primary-item[data-domain="system"]').click();
  await page.waitForSelector('#status.active');
  const integrationLink = page.locator('#uxPageStrip [data-strip-view="integrations"]');
  await integrationLink.waitFor({ state: 'visible' });
  await integrationLink.click();
  await page.waitForSelector('#integrations.active');
  await page.waitForSelector('#integrations[data-integration-v2="true"]');
  assert.equal(await page.locator('#uxPageStrip [aria-current="page"]').innerText(), 'Services');
});

await check('native Local AI integrations remain first-class', async () => {
  const body = await page.locator('#integrations').innerText();
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
  await page.locator('#uxIntegrationRefreshV2').click();
  await page.waitForFunction(() => /Open now/.test(document.querySelector('[data-integration-source-v2="artcraft"]')?.textContent || ''));
  assert.match(await live.getAttribute('class'), /healthy/);
});

await check('unverified media extensions do not pretend to be installed', async () => {
  const svd = page.locator('.ux-int-card', { hasText: 'Stable Video Diffusion' });
  const sad = page.locator('.ux-int-card', { hasText: 'SadTalker' });
  assert.match(await svd.innerText(), /Not set up/i);
  assert.match(await svd.innerText(), /Not verified/i);
  assert.match(await sad.innerText(), /Not set up/i);
  assert.match(await sad.innerText(), /Not verified/i);
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
  const external = page.locator('#integrations [data-external="true"]');
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
  const button = page.locator('#uxIntegrationRefreshV2');
  await button.click();
  await page.waitForFunction(() => document.querySelector('#uxIntegrationRefreshV2')?.getAttribute('aria-busy') === 'false');
  assert.ok(await page.locator('#uxIntegrationStatusSummaryV2').isVisible());
  assert.ok(await page.locator('#uxIntegrationLastCheckedV2').isVisible());
  assert.equal(await button.isEnabled(), true);
});

await page.close();

const mobile = await browser.newPage({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
await mobile.goto(base, { waitUntil: 'domcontentloaded' });
await mobile.waitForSelector('#uxMobileNav');

await check('integration hub is reachable on mobile', async () => {
  await mobile.locator('#uxMobileNav [data-domain="system"]').click();
  await mobile.waitForSelector('#status.active');
  const link = mobile.locator('#uxPageStrip [data-strip-view="integrations"]');
  await link.waitFor({ state: 'visible' });
  await link.click();
  await mobile.waitForSelector('#integrations.active');
  await mobile.waitForSelector('#integrations[data-integration-v2="true"]');
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
await browser.close();

if (failures.length) {
  console.error(`\n${failures.length} integration hub check(s) failed:`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('\nAll integration hub checks passed.');
