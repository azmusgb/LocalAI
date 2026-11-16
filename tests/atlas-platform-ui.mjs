// The platform map on Atlas (platform capture spec, design item 4), in a browser: the six systems above the Systems
// strip, each link with a mark in words, a link chosen from the keyboard shows its provider and consumers, the table
// lists every declared edge (also 120 of them), the calls with no declared edge are one grouped list off the graph, a
// phone gets a list of systems, and loading, an error, no edges and nothing checked each say so. Reduced motion: no
// transition or animation runs in the section. Axe at 390 in both schemes.
import { chromium, devices } from 'playwright';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addAxe } from './axe-helper.mjs';

const require = createRequire(import.meta.url);
const { atlasFixture, systemsFixture, contractsFixture } = require('./atlas-map-fixture.cjs');
// The fixture serves every edge app/atlas/contracts.json declares, so the table's row count follows the file.
const DECLARED = require('../app/atlas/contracts.json').length;
const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const axePath = join(dirname(fileURLToPath(import.meta.url)), 'vendor', 'axe.min.js');
const browser = await chromium.launch({ headless: true });
const failures = [];
async function check(name, fn) {
  try { await fn(); console.log('PASS', name); } catch (error) { failures.push(`${name}: ${error.message}`); console.error('FAIL', name, error.message); }
}

async function open(device, { contracts = contractsFixture(), contractsStatus = 200, delay = 0, scheme = 'dark', systems = systemsFixture() } = {}) {
  const ctx = await browser.newContext({ ...device, serviceWorkers: 'block', colorScheme: scheme, reducedMotion: 'reduce' });
  await ctx.addInitScript(() => { try { localStorage.setItem('localai.firstRun.done', '1'); } catch {} });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  const json = (route, body, code = 200) => route.fulfill({ status: code, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route((u) => u.pathname === '/api/atlas/graph', (r) => json(r, atlasFixture()));
  await page.route((u) => u.pathname === '/api/atlas/systems', (r) => json(r, systems));
  await page.route((u) => u.pathname === '/api/atlas/contracts', async (r) => {
    if (delay) await new Promise((res) => setTimeout(res, delay));
    await json(r, contracts, contractsStatus);
  });
  await page.route((u) => u.pathname === '/api/atlas/summary', (r) => json(r, { providers: { ollama: { available: false }, goose: { available: false } } }));
  await page.route((u) => u.pathname === '/api/atlas/snapshots', (r) => json(r, { repos: ['localai', 'pi-hub', 'print-lab'], snapshots: [] }));
  await page.route((u) => u.pathname === '/api/atlas/node', (r) => json(r, { node: { testEvidence: [] } }));
  await page.route((u) => u.pathname === '/api/releases', (r) => json(r, { current: { commit: 'ff9081c', deployedAt: '2026-10-15T00:00:00Z' }, history: [] }));
  await page.goto(`${base}/#home`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.showView === 'function');
  await page.evaluate(() => window.showView('architecture'));
  return page;
}
const S = '#atlas-platform';
const ready = (page) => page.locator(`${S}[data-state="ready"]`).waitFor({ timeout: 8000 });

const desk = await open({ viewport: { width: 1440, height: 900 } });
await check('the platform map sits above the Systems strip with the six systems and a mark in words on each link', async () => {
  await ready(desk);
  assert.equal(await desk.evaluate(() => {
    const a = document.getElementById('atlas-platform'), b = document.getElementById('atlasSystems');
    return !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  }), true, 'platform map before the strip');
  assert.equal(await desk.locator(`${S} h2`).first().innerText(), 'Platform map');
  assert.deepEqual(await desk.locator(`${S} .atlas-platform-canvas .atlas-platform-node`).evaluateAll((els) => els.map((e) => e.dataset.node)),
    ['pi-hub', 'localai', 'print-lab', 'bambuhelper-smart-display', 'home-mcp', 'netmon']);
  assert.match(await desk.locator(`${S} .atlas-platform-canvas [data-node="netmon"]`).innerText(), /Writes files, no HTTP link/);
  assert.match(await desk.locator(`${S} .atlas-platform-canvas [data-node="bambuhelper-smart-display"]`).innerText(), /Firmware source, not parsed/);
  const marks = await desk.locator(`${S} .atlas-platform-canvas button[data-platform-link]`).evaluateAll((els) => els.map((e) => [e.dataset.platformLink, e.dataset.mark, e.innerText.replace(/\s+/g, ' ').trim()]));
  assert.equal(marks.length, 5, JSON.stringify(marks));
  assert.match(marks.find((m) => m[0] === 'bambuhelper-smart-display>localai')[2], /^Not checked\s+3 routes/, 'the display reads Local AI too (firmware not parsed)');
  assert.deepEqual(marks.find((m) => m[0] === 'localai>pi-hub').slice(1, 2), ['missing']);
  assert.match(marks.find((m) => m[0] === 'localai>pi-hub')[2], /^Missing/);
  assert.match(marks.find((m) => m[0] === 'home-mcp>pi-hub')[2], /^Not checked/);
  assert.equal(await desk.locator(`${S} .atlas-platform-canvas path.atlas-platform-edge`).count(), 5, 'one path per link');
  assert.deepEqual(await desk.locator(`${S} .atlas-platform-legend .ui-chip`).allInnerTexts(), ['Confirmed', 'Missing', 'Not checked']);
});

await check('tab to a link, Enter shows its provider and consumers; Space shows another', async () => {
  await desk.locator(`${S} [role="tab"][aria-selected="true"]`).focus();
  for (let i = 0; i < 12; i++) {
    await desk.keyboard.press('Tab');
    if (await desk.evaluate(() => !!document.activeElement?.dataset?.platformLink)) break;
  }
  const first = await desk.evaluate(() => document.activeElement.dataset.platformLink);
  assert.ok(first, 'Tab reaches a link');
  await desk.keyboard.press('Enter');
  const detail = desk.locator(`${S} .atlas-platform-detail--graph`);
  assert.equal(await detail.isVisible(), true);
  const text = await detail.innerText();
  assert.match(text, /Provider/);
  assert.match(text, /Pi Hub · hub\/app\.py/);
  assert.match(text, /Consumers/);
  assert.equal(await desk.evaluate(() => document.activeElement.dataset.platformLink), first, 'focus stays on the link');
  assert.equal(await desk.locator(`${S} .atlas-platform-canvas [data-platform-link="${first}"]`).getAttribute('aria-pressed'), 'true');
  await desk.locator(`${S} .atlas-platform-canvas [data-platform-link="localai>pi-hub"]`).focus();
  await desk.keyboard.press(' ');
  const local = await detail.innerText();
  assert.match(local, /Local AI → Pi Hub/);
  assert.match(local, /GET \/api\/camera/);
  assert.match(local, /Declared but not found in app\/print-lab\.js/);
  assert.match(local, /Local AI · app\/pi-hub\.js/);
  const records = (await detail.locator('[data-edge="records-v1"] .atlas-platform-route').innerText()).replace(/\s+/g, ' ');
  assert.match(records, /Confirmed for Local AI/, 'the route mark says whose it is');
  assert.match(records, /Whole contract: Not checked/, 'and the edge-level mark sits beside it, as in the table');
});

await check('the table lists every declared edge in full, and arrow keys move between Graph and Table', async () => {
  await desk.locator(`${S} [role="tab"][data-view="graph"]`).focus();
  await desk.keyboard.press('ArrowRight');
  assert.equal(await desk.evaluate(() => document.activeElement.dataset.view), 'table');
  assert.equal(await desk.locator(`${S} [role="tab"][data-view="table"]`).getAttribute('aria-selected'), 'true');
  assert.equal(await desk.locator(`${S} .atlas-platform-table tbody tr`).count(), DECLARED);
  assert.equal(await desk.locator(`${S} .atlas-platform-canvas`).isVisible(), false);
  const row = await desk.locator(`${S} .atlas-platform-table tr[data-edge="records-v1"]`).innerText();
  assert.match(row, /GET \/api\/records/);
  assert.match(row, /home-mcp · src\/home_mcp\/server\.py/);
  assert.match(row, /Not checked/);
  assert.match(row, /home-mcp isn't mapped/, 'the table carries the reason the check gave');
  assert.match(await desk.locator(`${S} .atlas-platform-summary`).innerText(), /Live releases: Pi Hub 4444444, Local AI fffffff/);
  await desk.keyboard.press('ArrowLeft');
  assert.equal(await desk.locator(`${S} [role="tab"][data-view="graph"]`).getAttribute('aria-selected'), 'true');
});

await check('Show on map opens the repository map at that module; a firmware consumer cannot be shown', async () => {
  const commit = 'a'.repeat(40);
  const requested = [];
  const json = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  await desk.route((u) => u.pathname === '/api/atlas/snapshots', (r) => json(r, { repos: ['localai', 'pi-hub', 'print-lab'],
    snapshots: [{ repo: 'pi-hub', commit, createdAt: '2026-11-14T10:00:00Z', source: 'git' }] }));
  await desk.route((u) => u.pathname === '/api/atlas/graph' && u.searchParams.get('repo') === 'pi-hub', (r) => {
    requested.push(new URL(r.request().url()).searchParams.get('commit'));
    return json(r, JSON.parse(JSON.stringify(atlasFixture()).replaceAll('app/server.js', 'hub/app.py')));
  });
  await desk.locator(`${S} [role="tab"][data-view="table"]`).click();
  const row = desk.locator(`${S} .atlas-platform-table tr[data-edge="records-v1"]`);
  const show = row.locator('td[data-label="Provider"] button.atlas-platform-show');
  assert.equal(await show.innerText(), 'Show on map', 'the visible label');
  assert.equal(await show.getAttribute('aria-label'), 'Show on map: hub/app.py in Pi Hub', 'the name starts with the visible label');
  assert.equal(await show.getAttribute('data-atlas-cross-repo'), 'pi-hub');
  assert.equal(await show.getAttribute('data-atlas-cross-module'), 'hub/app.py');
  assert.equal(await show.getAttribute('aria-disabled'), null);
  await show.focus();
  assert.equal(await desk.evaluate(() => document.activeElement.classList.contains('atlas-platform-show')), true, 'reachable by keyboard');
  await show.click();
  await desk.waitForFunction(() => document.getElementById('atlasRepo').value === 'pi-hub');
  assert.deepEqual(requested, [commit], "the repository's newest snapshot is drawn");
  await desk.waitForFunction(() => document.getElementById('atlasSelectedPath').textContent.trim() === 'app.py', null, { timeout: 8000 });
  assert.equal(await desk.locator('#atlasSelectedMeta code').innerText(), 'hub/app.py');
  // A button that cannot be used stays focusable, says why in words, and does nothing when pressed.
  const fw = desk.locator(`${S} .atlas-platform-table tr[data-edge="display-feed"] td[data-label="Consumers"] button.atlas-platform-show`);
  assert.equal(await fw.getAttribute('aria-disabled'), 'true');
  assert.equal(await fw.evaluate((b) => b.disabled), false, 'aria-disabled, not the disabled attribute');
  assert.equal(await fw.getAttribute('data-atlas-cross-repo'), null, 'the map handler never sees it');
  assert.equal(await fw.getAttribute('aria-label'), 'Show on map: firmware/platform/localai/workshop_localai_feed.cpp in Smart display');
  const why = await fw.getAttribute('aria-describedby');
  assert.equal(await desk.locator(`#${why}`).innerText(), 'Not on the map: firmware source, not parsed');
  await fw.focus();
  assert.equal(await desk.evaluate(() => document.activeElement.getAttribute('aria-disabled')), 'true', 'keyboard reachable');
  const before = requested.length;
  await fw.click({ force: true });
  await desk.waitForTimeout(500);
  assert.equal(await desk.locator('#atlasRepo').inputValue(), 'pi-hub', 'pressing it changes nothing');
  assert.equal(requested.length, before);
  const ps = desk.locator(`${S} .atlas-platform-table tr[data-edge="releases-v1-write"] button.atlas-platform-show[aria-label*=".ps1"]`);
  assert.equal(await ps.getAttribute('aria-disabled'), 'true', 'the PowerShell consumer is not scanned');
  assert.match(await desk.locator(`#${await ps.getAttribute('aria-describedby')}`).innerText(), /source not scanned/);
});

await check('calls with no declared edge are one closed list, grouped by repository and module, never on the graph', async () => {
  const und = desk.locator(`${S} details.atlas-platform-undeclared`);
  assert.equal(await und.getAttribute('open'), null);
  assert.match(await und.locator('summary').first().innerText(), /96 calls with no declared edge/);
  await und.locator('summary').first().click();
  assert.deepEqual(await und.locator('.atlas-platform-undeclared-repo > h3').allInnerTexts(),
    ['Smart display · 40 calls', 'Pi Hub · 34 calls', 'Local AI · 22 calls']);
  assert.match(await und.locator('details summary', { hasText: 'hub/bambuddy.py' }).innerText(), /28 calls/);
  assert.equal(await desk.locator(`${S} .atlas-platform-canvas button[data-platform-link]`).count(), 5, 'undeclared calls are not links');
});

await check('reduced motion: nothing in the section animates or transitions', async () => {
  const moving = await desk.evaluate(() => {
    const els = [...document.querySelectorAll('#atlas-platform, #atlas-platform *')];
    return els.filter((e) => { const s = getComputedStyle(e); return s.transitionDuration.split(',').some((d) => parseFloat(d) > 0) || s.animationName !== 'none'; }).length;
  });
  assert.equal(moving, 0);
});

await check('a long system name is cut short on the graph with its full text in the title', async () => {
  const long = contractsFixture();
  long.contracts[0].consumers.push({ repo: 'a-very-long-repository-name-for-a-system-nobody-planned', module: 'src/somewhere/deep/inside/the/tree/client.py', state: 'not_checked', detail: "isn't mapped", check: 'no snapshot' });
  const p = await open({ viewport: { width: 1024, height: 800 } }, { contracts: long });
  await ready(p);
  const node = p.locator(`${S} .atlas-platform-canvas [data-node="a-very-long-repository-name-for-a-system-nobody-planned"] .atlas-platform-name`);
  assert.equal(await node.getAttribute('title'), 'a-very-long-repository-name-for-a-system-nobody-planned');
  assert.ok(await node.evaluate((e) => e.scrollWidth > e.clientWidth), 'cut short');
  assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways page scroll');
  assert.deepEqual(p.errors, []);
  await p.context().close();
});

await check('no script errors at 1440', async () => assert.deepEqual(desk.errors, []));
await desk.context().close();

const many = await open({ viewport: { width: 1440, height: 900 } }, { contracts: contractsFixture({ extra: 100 }) });
await check('declared edges are all in the table', async () => {
  await ready(many);
  await many.locator(`${S} [role="tab"][data-view="table"]`).click();
  assert.equal(await many.locator(`${S} .atlas-platform-table tbody tr`).count(), DECLARED + 100);
  assert.match(await many.locator(`${S} .atlas-platform-table caption`).innerText(), new RegExp(`${DECLARED + 100} declared edges`));
});
await many.context().close();

for (const scheme of ['dark', 'light']) {
  const phone = await open(devices['iPhone 14'], { scheme });
  await check(`at 390 px (${scheme}) the graph is a list of systems with their links, no sideways scroll, axe clean`, async () => {
    await ready(phone);
    assert.equal(await phone.locator(`${S} .atlas-platform-canvas`).isVisible(), false);
    const list = phone.locator(`${S} .atlas-platform-list`);
    assert.equal(await list.isVisible(), true);
    assert.deepEqual(await list.locator('[data-node] .atlas-platform-name').allInnerTexts(),
      ['Pi Hub', 'Local AI', 'Print lab', 'Smart display', 'home-mcp', 'netmon']);
    assert.equal(await list.locator('button[data-platform-link]').count(), 5);
    await list.locator('[data-platform-link="print-lab>pi-hub"]').click();
    const shown = list.locator('[data-node="print-lab"] .atlas-platform-detail');
    assert.match(await shown.innerText(), /Print lab → Pi Hub/, 'the detail opens under the chosen system');
    const head = await shown.locator('h3').boundingBox();
    const vh = await phone.evaluate(() => innerHeight);
    assert.ok(head && head.y >= 0 && head.y + head.height <= vh, `the detail heading is in view (${JSON.stringify(head)}, ${vh})`);
    assert.equal(await phone.evaluate(() => document.activeElement.dataset.platformLink), 'print-lab>pi-hub', 'focus stays on the link');
    assert.match(await phone.locator(`${S} [role="status"]`).innerText(), /Print lab → Pi Hub/, 'announced');
    const h = await list.locator('[data-platform-link="print-lab>pi-hub"]').evaluate((e) => e.getBoundingClientRect().height);
    assert.ok(h >= 44, `link height ${h}`);
    assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways page scroll');
    await addAxe(phone, axePath);
    const r = await phone.evaluate(() => window.axe.run('#atlas-platform', { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice'] }));
    const bad = r.violations.filter((v) => ['serious', 'critical'].includes(v.impact)).flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target}`));
    assert.deepEqual(bad, []);
    assert.deepEqual(phone.errors, []);
  });
  await phone.context().close();
}

const slow = await open({ viewport: { width: 1440, height: 900 } }, { delay: 1500 });
await check('while the contracts load the section says so', async () => {
  assert.match(await slow.locator(S).innerText(), /Checking the links between systems/);
  assert.equal(await slow.locator(S).getAttribute('aria-busy'), 'true');
  await ready(slow);
  assert.equal(await slow.locator(S).getAttribute('aria-busy'), 'false');
});
await slow.context().close();

const broken = await open({ viewport: { width: 1440, height: 900 } }, { contracts: { error: { message: 'Atlas could not read its contracts.' } }, contractsStatus: 500 });
await check('a contracts error says what failed and how to try again', async () => {
  await broken.locator(`${S}[data-state="error"]`).waitFor({ timeout: 8000 });
  const notice = broken.locator(`${S} .ui-notice--bad`);
  assert.match(await notice.innerText(), /could not be checked: Atlas could not read its contracts\..*Refresh/);
  assert.deepEqual(broken.errors, []);
});
await broken.context().close();

const fileGone = await open({ viewport: { width: 1440, height: 900 } }, { contracts: { error: { code: 'contracts_load_error', message: 'Contracts file not found.' }, contracts: [], undeclared: [], brokenCount: 0, commits: {} } });
await check('the server saying the contracts file is missing is an error, not an empty map', async () => {
  await fileGone.locator(`${S}[data-state="error"]`).waitFor({ timeout: 8000 });
  assert.match(await fileGone.locator(`${S} .ui-notice--bad`).innerText(), /Contracts file not found\./);
});
await fileGone.context().close();

const none = await open({ viewport: { width: 1440, height: 900 } }, { contracts: { contracts: [], undeclared: [], brokenCount: 0, commits: {} } });
await check('no declared edges says so and still shows the systems', async () => {
  await none.locator(`${S}[data-state="empty"]`).waitFor({ timeout: 8000 });
  assert.match(await none.locator(`${S} .ui-empty`).innerText(), /No links between systems are declared yet/);
  assert.equal(await none.locator(`${S} .atlas-platform-canvas .atlas-platform-node`).count(), 6);
});
await none.context().close();

const unchecked = contractsFixture();
for (const c of unchecked.contracts) { c.check = 'no snapshot'; c.provider.state = 'not_checked'; c.provider.detail = 'No snapshot available for pi-hub'; for (const k of c.consumers) { k.state = 'not_checked'; k.check = 'no snapshot'; } }
const noSnap = await open({ viewport: { width: 1440, height: 900 } }, { contracts: unchecked });
await check('with no snapshots every link reads Not checked, never Confirmed', async () => {
  await ready(noSnap);
  const marks = await noSnap.locator(`${S} .atlas-platform-canvas button[data-platform-link]`).evaluateAll((els) => els.map((e) => e.dataset.mark));
  assert.deepEqual([...new Set(marks)], ['not-checked']);
  await noSnap.locator(`${S} [data-platform-link="localai>pi-hub"]`).first().click();
  assert.match(await noSnap.locator(`${S} .atlas-platform-detail--graph`).innerText(), /No snapshot available for pi-hub/);
});
await noSnap.context().close();

await browser.close();
if (failures.length) { console.error(`\n${failures.length} check(s) failed`); process.exit(1); }
console.log('\nAll platform map checks passed');
