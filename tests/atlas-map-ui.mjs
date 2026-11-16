// The Architecture page's map (Atlas redesign spec, PR 3), in a browser, on a fixed graph (tests/atlas-map-fixture.cjs):
// named modules in columns with links, selecting a module colours what it uses and what uses it, the inspector says why it
// ranks where it does, at most six findings, search with / Enter Escape, lenses as pressed buttons, the page at 390 px
// with 44 px rows and no sideways scroll, axe on the drawn map in both schemes, an older snapshot and a missing graph.
import { chromium, devices } from 'playwright';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addAxe } from './axe-helper.mjs';

const { atlasFixture, systemsFixture } = createRequire(import.meta.url)('./atlas-map-fixture.cjs');
const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const axePath = join(dirname(fileURLToPath(import.meta.url)), 'vendor', 'axe.min.js');
const browser = await chromium.launch({ headless: true });
const failures = [];
async function check(name, fn) {
  try { await fn(); console.log('PASS', name); } catch (error) { failures.push(`${name}: ${error.message}`); console.error('FAIL', name, error.message); }
}

async function open(device, { graph = atlasFixture(), status = 200, scheme = 'dark', systems = systemsFixture(), systemsStatus = 200 } = {}) {
  const ctx = await browser.newContext({ ...device, serviceWorkers: 'block', colorScheme: scheme, reducedMotion: 'reduce' });
  await ctx.addInitScript(() => { try { localStorage.setItem('localai.firstRun.done', '1'); } catch {} });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  const json = (route, body, code = 200) => route.fulfill({ status: code, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route((u) => u.pathname === '/api/atlas/graph', (r) => status === 200 ? json(r, graph) : json(r, { error: { code: 'atlas_graph_unavailable', message: 'System Atlas HTML was not found.' } }, status));
  await page.route((u) => u.pathname === '/api/atlas/systems', (r) => json(r, systems, systemsStatus));
  await page.route((u) => u.pathname === '/api/atlas/summary', (r) => json(r, { providers: { ollama: { available: false }, goose: { available: false } } }));
  await page.route((u) => u.pathname === '/api/atlas/snapshots', (r) => json(r, { repos: ['localai', 'pi-hub', 'print-lab'], snapshots: [] }));
  await page.route((u) => u.pathname === '/api/atlas/node', (r) => json(r, { node: { testEvidence: [] } }));
  await page.route((u) => u.pathname === '/api/releases', (r) => json(r, { current: { commit: 'ff9081c', deployedAt: '2026-10-15T00:00:00Z' }, history: [] }));
  await page.goto(`${base}/#home`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.showView === 'function');
  await page.evaluate(() => window.showView('architecture'));
  if (status === 200) await page.locator(graph.nodes.some((n) => n.domain !== 'Tests') ? '#atlasMap .atlas-row' : '.atlas-map-wrap[data-state="empty"]').first().waitFor({ timeout: 8000 });
  return page;
}
const row = (page, id) => page.locator(`#atlasMap [data-atlas-node="${id}"]`);

const desk = await open({ viewport: { width: 1440, height: 900 } });
await check('every production module is a named row in its column, and HTTP calls are dashed links', async () => {
  const fx = atlasFixture();
  const prod = fx.nodes.filter((n) => n.domain !== 'Tests').length;
  assert.equal(await desk.locator('#atlasMap .atlas-row[data-atlas-node]').count(), prod);
  const heads = await desk.locator('#atlasMap .atlas-column').allTextContents();
  assert.deepEqual(heads, ['Browser', 'Entry', 'Server', 'Capabilities', 'Shared', 'Data']);
  assert.equal(await desk.locator('#atlasMap .atlas-edge--http').count(), 5);
  assert.ok(await desk.locator('#atlasMap .atlas-edge:not(.atlas-edge--http)').count() >= 20);
  assert.match(await desk.locator('#atlasWebStatus').innerText(), /^Snapshot 14 Oct · \d+ days? old · not the running release ff9081c|^Snapshot 14 Oct/);
  const mapW = await desk.evaluate(() => [document.getElementById('atlasMap').getBoundingClientRect().width, document.querySelector('#architecture .atlas-map-wrap').clientWidth]);
  assert.ok(mapW[0] <= mapW[1], `the six columns fit the frame at 1440 (${mapW})`);
});

await check('selecting server.js colours what it uses and says why it ranks here', async () => {
  await row(desk, 'app/server.js').click();
  assert.equal(await desk.locator('#atlasMap .atlas-edge.is-out').count(), 12);
  assert.equal(await desk.locator('#atlasMap .atlas-edge.is-in:not(.atlas-edge--http)').count(), 0, 'nothing imports it');
  assert.equal(await desk.locator('#atlasMap .atlas-edge--http.is-in').count(), 1, 'home.js calls it');
  assert.ok(await desk.locator('#atlasMap .atlas-row.is-dim').count() > 0, 'the rest dims');
  assert.equal(await desk.locator('#atlasSelectedPath').innerText(), 'server.js');
  assert.match(await desk.locator('#atlasSelectedMeta').innerText(), /risk · \d+\/100/);
  const why = await desk.locator('#atlasWhy li').allInnerTexts();
  assert.ok(why.includes('It imports 12 modules (+46).'), why.join(' | '));
  assert.ok(why.includes('No test imports it.'));
  assert.equal(await desk.locator('.atlas-links--uses li').count(), 12);
  assert.equal(await desk.locator('.atlas-links--http li').count(), 1, 'home.js calls it over HTTP');
});

await check('a module used by others lists them, and its tests, and walking the list moves the selection', async () => {
  await row(desk, 'app/storage.js').click();
  assert.equal(await desk.locator('.atlas-links--usedby li').count(), 4);
  assert.equal(await desk.locator('#atlasEvidenceList li').count(), 6);
  assert.equal(await desk.locator('#atlasMap .atlas-edge.is-in').count(), 4);
  await desk.locator('.atlas-links--usedby [data-atlas-node="app/run-ledger.js"]').click();
  assert.equal(await desk.locator('#atlasSelectedPath').innerText(), 'run-ledger.js');
});

await check('look here first: at most six findings, a call nothing serves first, and a finding selects its module', async () => {
  const titles = await desk.locator('#atlasFindingList .atlas-finding strong').allInnerTexts();
  assert.ok(titles.length >= 2 && titles.length <= 6, titles.join(' | '));
  assert.equal(titles[0], 'improve.js calls /api/improve/retired, which nothing serves');
  assert.ok(titles.some((t) => /server\.js wires up 12 modules and no test imports it/.test(t)), titles.join(' | '));
  await desk.locator('#atlasFindingList .atlas-finding').nth(1).click();
  assert.match(await desk.locator('#atlasSelectedPath').innerText(), /\.js$/);
});

await check('/ focuses search, Enter picks the first match, Escape clears the search and then the selection', async () => {
  await desk.locator('#atlasMapBack').click();
  await desk.locator('body').press('/');
  assert.equal(await desk.evaluate(() => document.activeElement.id), 'atlasNodeSearch');
  await desk.keyboard.type('journal');
  assert.ok(await desk.locator('#atlasMap .atlas-row.is-match').count() >= 1);
  await desk.keyboard.press('Enter');
  assert.equal(await desk.locator('#atlasSelectedPath').innerText(), 'journal.js');
  await desk.locator('#atlasNodeSearch').focus();
  await desk.keyboard.press('Escape');
  assert.equal(await desk.locator('#atlasNodeSearch').inputValue(), '');
  assert.equal(await desk.locator('#atlasSelectedBody').isVisible(), true);
  await desk.keyboard.press('Escape');
  assert.equal(await desk.locator('#atlasSelectedBody').isVisible(), false);
});

await check('lenses are pressed buttons that repaint the rows; the changed one carries a dot too', async () => {
  await desk.locator('[data-atlas-lens="tests"]').click();
  assert.equal(await desk.locator('[data-atlas-lens="tests"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await desk.locator('[data-atlas-lens="risk"]').getAttribute('aria-pressed'), 'false');
  assert.equal(await row(desk, 'app/server.js').getAttribute('data-band'), 'critical');
  assert.equal(await row(desk, 'app/storage.js').getAttribute('data-band'), 'low');
  await desk.locator('[data-atlas-lens="changed"]').click();
  assert.equal(await row(desk, 'app/notify.js').getAttribute('data-band'), 'changed');
  assert.equal(await desk.locator('#atlasMap .atlas-dot').count(), 1);
  await desk.locator('[data-atlas-lens="risk"]').click();
});

await check('a module row opens with the keyboard', async () => {
  await row(desk, 'app/glance.js').focus();
  await desk.keyboard.press('Enter');
  assert.equal(await desk.locator('#atlasSelectedPath').innerText(), 'glance.js');
  assert.equal(await desk.evaluate(() => document.activeElement.dataset.atlasNode), 'app/glance.js', 'focus stays on the row');
});
await check('the chosen row is pressed, Enter in search closes the results, a finding moves focus to the inspector', async () => {
  await row(desk, 'app/journal.js').click();
  assert.equal(await row(desk, 'app/journal.js').getAttribute('aria-pressed'), 'true');
  assert.equal(await row(desk, 'app/glance.js').getAttribute('aria-pressed'), 'false');
  await desk.locator('#atlasNodeSearch').fill('storage');
  await desk.locator('#atlasNodeSearch').press('Enter');
  assert.equal(await desk.locator('#atlasSearchResults').isHidden(), true, 'the results close after Enter');
  await desk.locator('[data-atlas-lens="tests"]').click();
  assert.equal(await desk.locator('#atlasSearchResults').isHidden(), true, 'and stay closed when the map is repainted');
  await desk.locator('[data-atlas-lens="risk"]').click();
  await desk.locator('#atlasNodeSearch').fill('');
  await desk.locator('#atlasFindingList .atlas-finding').first().focus();
  await desk.keyboard.press('Enter');
  assert.equal(await desk.evaluate(() => document.activeElement.id), 'atlasSelectedPath');
  await desk.keyboard.press('Escape');
  assert.equal(await desk.evaluate(() => document.activeElement.dataset.atlasNode), 'app/public/improve.js', 'Escape returns focus to the row');
});

await check('details that arrive after another module was chosen are not shown for it', async () => {
  await desk.route((u) => u.pathname === '/api/atlas/node', async (r) => {
    const slow = new URL(r.request().url()).searchParams.get('path') === 'app/storage.js';
    if (slow) await new Promise((res) => setTimeout(res, 800));
    await r.fulfill({ contentType: 'application/json', body: JSON.stringify({ node: { testEvidence: slow ? [{ test: 'tests/only-storage.test.cjs' }] : [] } }) });
  });
  await row(desk, 'app/storage.js').click();
  await row(desk, 'app/glance.js').click();
  await desk.waitForTimeout(1200);
  await desk.locator('[data-atlas-lens="reach"]').click();  // any redraw would show leaked details
  await desk.locator('[data-atlas-lens="risk"]').click();
  assert.equal(await desk.locator('#atlasSelectedPath').innerText(), 'glance.js');
  assert.ok(!(await desk.locator('#architecture .atlas-inspector').innerText()).includes('only-storage'), 'storage.js evidence leaked into glance.js');
  await desk.unroute((u) => u.pathname === '/api/atlas/node');
});

await check('the Systems strip shows each host, its services in one line, and opens a repository on the map', async () => {
  assert.deepEqual(await desk.locator('#atlasSystemsList .atlas-host h3').evaluateAll((els) => els.map((e) => e.firstChild.textContent)),
    ['Raspberry Pi', 'Windows PC', 'Mac', 'Devices', 'Off-site']);
  assert.match(await desk.locator('#atlasSystemsNote').innerText(), /^From Pi Hub, just now\.$/);
  assert.equal(await desk.locator('[data-host="pi"] .atlas-host-health').innerText(), '1 of 3 need a look: Ad blocking (paused)');
  assert.equal(await desk.locator('[data-host="pi"] .atlas-host-health').getAttribute('data-tone'), 'warn');
  assert.match(await desk.locator('[data-atlas-repo="localai"]').innerText(), /Map is of a different commit than the running release · map eeeeeee, live fffffff · \d+ days old/);
  assert.match(await desk.locator('[data-atlas-repo="print-lab"]').innerText(), /Not mapped yet/);
  assert.equal(await desk.locator('[data-host="pi"] .atlas-host-target').innerText().then((t) => t.replace(/\s+/g, ' ')), 'netmon 2222222 · not mapped');
  assert.equal(await desk.locator('[data-host="offsite"] .atlas-host-none').innerText(), 'Nothing deployed here.');
  assert.equal(await desk.locator('[data-atlas-repo="localai"]').getAttribute('aria-pressed'), 'true');
  await desk.locator('[data-atlas-repo="print-lab"]').click();
  await desk.locator('.atlas-map-wrap[data-state="empty"]').waitFor({ timeout: 8000 });
  assert.match(await desk.locator('#atlasMapTitle').innerText(), /No snapshots of Print lab yet/);
  assert.equal(await desk.locator('[data-atlas-repo="print-lab"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await desk.locator('[data-atlas-repo="localai"]').getAttribute('aria-pressed'), 'false');
  await desk.locator('[data-atlas-repo="localai"]').click();
  await desk.locator('#atlasMap .atlas-row').first().waitFor({ timeout: 8000 });
  assert.equal(await desk.evaluate(() => document.activeElement.id), 'atlasMapTitle');
});

await check('no script errors at 1440', async () => assert.deepEqual(desk.errors, []));
await desk.context().close();

for (const scheme of ['dark', 'light']) {
  const phone = await open(devices['iPhone 14'], { scheme });
  await check(`at 390 px (${scheme}) the page never scrolls sideways, rows are 44 px, and axe finds nothing serious`, async () => {
    assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways page scroll');
    const h = await row(phone, 'app/server.js').evaluate((el) => el.getBoundingClientRect().height);
    assert.ok(h >= 44, `row height ${h}`);
    await row(phone, 'app/storage.js').evaluate((el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await phone.waitForTimeout(300);
    await addAxe(phone, axePath);
    const r = await phone.evaluate(() => window.axe.run('#architecture', { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice'] }));
    const bad = r.violations.filter((v) => ['serious', 'critical'].includes(v.impact)).flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target}`));
    assert.deepEqual(bad, []);
  });
  await check(`no script errors at 390 (${scheme})`, async () => assert.deepEqual(phone.errors, []));
  await phone.context().close();
}

const older = await open({ viewport: { width: 1440, height: 900 } }, { graph: atlasFixture({ version: 1 }) });
await check('a version 1 snapshot still opens, without HTTP links, and says to rescan', async () => {
  assert.equal(await older.locator('#atlasMap .atlas-edge--http').count(), 0);
  assert.match(await older.locator('#atlasWebStatus').innerText(), /older snapshot: rescan for HTTP links/);
  assert.match(await older.locator('#atlasFindingNote').innerText(), /Older snapshot/);
  await row(older, 'app/storage.js').click();
  assert.ok((await older.locator('#atlasWhy li').allInnerTexts()).some((t) => /rescan/i.test(t)));
  assert.deepEqual(older.errors, []);
});
await older.context().close();

const missing = await open({ viewport: { width: 1440, height: 900 } }, { status: 503 });
await check('a missing graph says what failed, on the map and in the status line', async () => {
  await missing.locator('.atlas-map-wrap[data-state="error"]').waitFor({ timeout: 8000 });
  assert.match(await missing.locator('#atlasMapState').innerText(), /could not be read/);
  assert.equal(await missing.locator('#atlasWebStatus').getAttribute('data-tone'), 'error');
  assert.deepEqual(missing.errors, []);
});
await missing.context().close();

const away = await open({ viewport: { width: 1440, height: 900 } }, { systems: systemsFixture({ source: 'cache' }) });
await check('when the Pi is away the strip draws its kept copy and says how old it is', async () => {
  assert.equal(await away.locator('#atlasSystemsNote').innerText(), 'Pi Hub could not be reached (timeout). Showing its list from 2 hours ago.');
  assert.equal(await away.locator('#atlasSystemsNote').getAttribute('data-tone'), 'warn');
  assert.equal(await away.locator('#atlasSystemsList .atlas-host').count(), 5);
});
await away.context().close();

const noHub = await open({ viewport: { width: 1440, height: 900 } }, { systems: { error: { code: 'atlas_systems_unavailable', message: 'Pi Hub could not be reached (refused).' } }, systemsStatus: 503 });
await check('with no Pi and no copy the strip says what failed and the map still draws', async () => {
  await noHub.locator('#atlasSystemsNote[data-tone="error"]').waitFor({ timeout: 8000 });
  assert.equal(await noHub.locator('#atlasSystemsNote').innerText(), 'Pi Hub could not be reached (refused). The map below still works.');
  assert.equal(await noHub.locator('#atlasSystemsList').isHidden(), true);
  assert.ok(await noHub.locator('#atlasMap .atlas-row').count() > 0);
  assert.deepEqual(noHub.errors, []);
});
await noHub.context().close();

const skipped = [{ path: 'src/main.cpp', reason: 'firmware source, not parsed' }, { path: 'src/<b>x</b>.h', reason: 'firmware source, not parsed' }];
const partial = await open({ viewport: { width: 1440, height: 900 } }, { graph: atlasFixture({ skipped }) });
await check('skipped files: a sentence in the source note and the paths behind a disclosure, escaped', async () => {
  assert.match(await partial.locator('#atlasSourceNote').innerText(), /2 firmware files are listed, not parsed\./);
  assert.equal(await partial.locator('#atlasSkipped').isVisible(), true);
  assert.equal(await partial.locator('#atlasSkipped li').count(), 2);
  assert.equal(await partial.locator('#atlasSkipped b').count(), 0);
  assert.match(await partial.locator('#atlasSkipped').textContent(), /src\/<b>x<\/b>\.h/);
  assert.deepEqual(partial.errors, []);
});
await partial.context().close();
const complete = await open({ viewport: { width: 1440, height: 900 } });
await check('a complete map says nothing about skipped files', async () => {
  assert.doesNotMatch(await complete.locator('#atlasSourceNote').innerText(), /not parsed/);
  assert.equal(await complete.locator('#atlasSkipped').isHidden(), true);
});
await complete.context().close();
const fwOnly = await open({ viewport: { width: 1440, height: 900 } }, { graph: atlasFixture({ nodes: [], edges: [], skipped }) });
await check('a firmware-only snapshot explains why the map is empty', async () => {
  assert.equal(await fwOnly.locator('#atlasMapState').innerText(), 'No production modules in this snapshot. 2 firmware files are listed, not parsed.');
  assert.equal(await fwOnly.locator('#atlasSkipped li').count(), 2);
  assert.deepEqual(fwOnly.errors, []);
});
await fwOnly.context().close();

await browser.close();
if (failures.length) { console.error(`\n${failures.length} check(s) failed`); process.exit(1); }
console.log('\nAll Architecture map checks passed');
