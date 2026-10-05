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

const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.ux-primary-rail');

await check('integration hub is reachable from System', async () => {
  await page.locator('.ux-primary-item[data-domain="system"]').click();
  await page.waitForSelector('#status.active');
  const integrationLink = page.locator('.ux-secondary-link[data-view="integrations"]');
  await integrationLink.waitFor({ state: 'visible' });
  await integrationLink.click();
  await page.waitForSelector('#integrations.active');
  assert.equal(await page.locator('#uxContextView').innerText(), 'Integrations');
});

await check('native Local AI integrations are first-class', async () => {
  const body = await page.locator('#integrations').innerText();
  assert.match(body, /n8n/i);
  assert.match(body, /ComfyUI/i);
  assert.match(body, /Stable Video Diffusion/i);
  assert.match(body, /SadTalker/i);
  assert.match(body, /Keep native/i);
  assert.equal(await page.locator('[data-integration-source="n8n"]').count(), 1);
  assert.equal(await page.locator('[data-integration-source="comfy"]').count(), 1);
});

await check('recommended bridges are visible without becoming core dependencies', async () => {
  const body = await page.locator('#integrations').innerText();
  for (const label of ['Penpot', 'Obsidian', 'Hugging Face', 'Photopea', 'LanguageTool']) {
    assert.match(body, new RegExp(label, 'i'));
  }
  const externalLinks = page.locator('#integrations a[target="_blank"]');
  assert.ok(await externalLinks.count() >= 5);
});

await check('reviewed alternatives are explicitly classified', async () => {
  const body = await page.locator('#uxIntegrationAlternatives').innerText();
  for (const label of ['Gemini', 'Nano Banana', 'ImageFX', 'Google Flow', 'DALL', 'Meta AI', 'You.com', 'Coze', 'Bardeen', 'Pixlr', 'Lovart', 'Laxis', 'Google Slides', '10Web', 'Icons8']) {
    assert.match(body, new RegExp(label, 'i'));
  }
});

await check('integration status refresh stays in-page', async () => {
  await page.locator('#uxIntegrationRefresh').click();
  await page.waitForTimeout(250);
  assert.ok(await page.locator('#uxIntegrationStatusSummary').isVisible());
});

await page.close();

const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
await mobile.goto(base, { waitUntil: 'domcontentloaded' });
await mobile.waitForSelector('#uxMobileNav');

await check('integration hub is reachable on mobile', async () => {
  await mobile.locator('#uxMobileNav [data-domain="system"]').click();
  await mobile.waitForSelector('#status.active');
  await mobile.locator('#uxContextMenu').click();
  const link = mobile.locator('#uxMobileSheet .ux-mobile-link', { hasText: 'Integrations' });
  await link.waitFor({ state: 'visible' });
  await link.click();
  await mobile.waitForSelector('#integrations.active');
});

await check('integration hub does not create horizontal page overflow on mobile', async () => {
  const dims = await mobile.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth
  }));
  assert.ok(dims.scrollWidth <= dims.clientWidth + 2, `scrollWidth ${dims.scrollWidth} > clientWidth ${dims.clientWidth}`);
});

await mobile.close();
await browser.close();

if (failures.length) {
  console.error(`\n${failures.length} integration hub check(s) failed:`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('\nAll integration hub checks passed.');
