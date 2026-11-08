// Tests for the Between Systems UI drawer, inspector cross-repo links, and broken edge findings
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import os from 'node:os';
import fs from 'node:fs';

const req = createRequire(import.meta.url);
const { atlasFixture, systemsFixture } = req('./atlas-map-fixture.cjs');
const { spawnAppServer } = req('./spawn-server.cjs');

const dataDir = fs.mkdtempSync(join(os.tmpdir(), 'contracts-ui-test-'));
const { child, ready } = spawnAppServer({
  env: {
    DATA_DIR: dataDir,
    WORKSPACE_ROOT: dataDir,
    LOCALAI_PI_HUB_URL: 'off',
    LOCALAI_WORKSHOP_URL: 'off',
    OLLAMA_URL: 'off',
    SEARXNG_URL: 'off',
    COMFY_URL: 'off',
    N8N_URL: 'off',
    PROXY_URL: 'off',
    GRIDCRAFT_URL: 'off',
    MAC_AI_HOME_URL: 'off',
    MAC_DSH_URL: 'off'
  }
});
const base = await ready;
const browser = await chromium.launch({ headless: true });
const failures = [];

async function check(name, fn) {
  try { await fn(); console.log('PASS', name); } catch (error) { failures.push(`${name}: ${error.message}`); console.error('FAIL', name, error.message); }
}

const contractsFixture = () => ({
  contracts: [
    {
      id: 'records-v1',
      contract: 'record.v1',
      state: 'checked',
      provider: { repo: 'pi-hub', module: 'hub/app.py', method: 'GET', path: '/api/records', state: 'checked' },
      consumers: [
        { repo: 'localai', module: 'app/server.js', state: 'checked' },
        { repo: 'home-mcp', module: 'src/home_mcp/server.py', state: 'not_checked', detail: "home-mcp isn't mapped" }
      ]
    },
    {
      id: 'broken-route',
      label: 'Broken Service',
      state: 'broken',
      provider: { repo: 'pi-hub', module: 'hub/missing.py', method: 'GET', path: '/api/missing', state: 'provider_missing', detail: 'pi-hub does not serve /api/missing at e693e6e' },
      consumers: [
        { repo: 'localai', module: 'app/server.js', state: 'checked' }
      ]
    }
  ],
  brokenCount: 1,
  commits: { localai: '9cce9df000000000000000000000000000000000', 'pi-hub': 'e693e6e000000000000000000000000000000000' }
});

async function openPage({ contracts = contractsFixture() } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', reducedMotion: 'reduce' });
  await ctx.addInitScript(() => { try { localStorage.setItem('localai.firstRun.done', '1'); } catch {} });
  const page = await ctx.newPage();
  const json = (route, body, code = 200) => route.fulfill({ status: code, contentType: 'application/json', body: JSON.stringify(body) });

  await page.route((u) => u.pathname === '/api/atlas/graph', (r) => json(r, atlasFixture()));
  await page.route((u) => u.pathname === '/api/atlas/systems', (r) => json(r, systemsFixture()));
  await page.route((u) => u.pathname === '/api/atlas/contracts', (r) => json(r, contracts));
  await page.route((u) => u.pathname === '/api/atlas/summary', (r) => json(r, { providers: { ollama: { available: false }, goose: { available: false } } }));
  await page.route((u) => u.pathname === '/api/atlas/snapshots', (r) => json(r, { repos: ['localai', 'pi-hub', 'print-lab'], snapshots: [] }));
  await page.route((u) => u.pathname === '/api/atlas/node', (r) => json(r, { node: { testEvidence: [] } }));
  await page.route((u) => u.pathname === '/api/releases', (r) => json(r, { current: { commit: 'ff9081c', deployedAt: '2026-10-15T00:00:00Z' }, history: [] }));

  await page.goto(`${base}/#home`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.showView === 'function');
  await page.evaluate(() => window.showView('architecture'));
  await page.locator('#atlasMap .atlas-row').first().waitFor({ timeout: 8000 });
  return page;
}

try {
  const page = await openPage();

  await check('Between systems section displays summary and expands on click', async () => {
    const summary = page.locator('#atlasContractsSummary');
    await summary.waitFor();
    const text = await summary.innerText();
    assert.match(text, /1 broken contract edge at the live commits/);

    const toggle = page.locator('#atlasContractsToggle');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    const body = page.locator('#atlasContractsBody');
    assert.equal(await body.isHidden(), true);

    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(await body.isVisible(), true);

    const rows = page.locator('#atlasContractsList .atlas-contract-row');
    assert.equal(await rows.count(), 2);
  });

  await check('Broken contract edge surfaces as top Look here first finding', async () => {
    const firstFinding = page.locator('#atlasFindingList .atlas-finding').first();
    await firstFinding.waitFor();
    const findingText = await firstFinding.innerText();
    assert.match(findingText, /Broken Service|does not serve \/api\/missing/);
  });

  await check('Inspector displays cross-system calls when module is selected', async () => {
    await page.locator('#atlasMap [data-atlas-node="app/server.js"]').click();
    const linksGroup = page.locator('#atlasNodeLinks .atlas-links--cross');
    await linksGroup.first().waitFor();
    const title = await linksGroup.first().innerText();
    assert.match(title, /Calls to other systems|Other systems that call this/);
  });

} finally {
  await browser.close();
  if (child?.kill) child.kill('SIGTERM');
}

if (failures.length) {
  console.error(`\n${failures.length} UI test failures:`);
  for (const f of failures) console.error('-', f);
  process.exit(1);
} else {
  console.log('\nAll contracts UI tests passed.');
}
