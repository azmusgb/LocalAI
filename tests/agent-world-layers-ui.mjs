import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addAxe } from './axe-helper.mjs';

// Agent World's layer hook (LocalAIAgentWorld.addLayer) and its on-demand modules (app/public/aw/*.js): the modules are
// fetched only once the city is first on screen, and a layer can reserve tiles that no worker walks into, paint the
// cached ground by state, draw a small overlay each frame, be tapped, and list its rows under City services.
const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const browser = await chromium.launch({ headless: true });
const failures = [];
async function check(name, fn) { try { await fn(); console.log('PASS', name); } catch (e) { failures.push(`${name}: ${e.message}`); console.error('FAIL', name, e.message); } }

const MISSION = {
  id: 'mission-layers', goal: 'Layer hook', status: 'running', createdAt: new Date(Date.now() - 60e3).toISOString(), updatedAt: new Date().toISOString(), results: [], timeline: [],
  workers: [{ id: 'router', name: 'Mission Router', state: 'complete', dependsOn: [] }, { id: 'ux_analyst', name: 'UX Analyst', state: 'pending', dependsOn: ['router'] }, { id: 'code_analyst', name: 'Code Analyst', state: 'pending', dependsOn: ['router'] }]
};
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
await context.addInitScript(() => { try { localStorage.setItem('localai.firstRun.done', '1'); localStorage.setItem('localai.devTools', '0'); localStorage.setItem('localai.debug', '1'); } catch {} });
const page = await context.newPage();
const errors = [], awRequests = [];
page.on('pageerror', e => errors.push(e.message));
page.on('request', r => { if (new URL(r.url()).pathname.startsWith('/aw/')) awRequests.push(new URL(r.url()).pathname); });
await page.route(u => u.pathname === '/api/agents/missions', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: [MISSION] }) }));
await page.goto(base + '/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => typeof window.showView === 'function' && window.LocalAIAgentWorld?.addLayer);

await check('the on-demand modules are not fetched while the city is off screen', async () => {
  await page.waitForTimeout(500);
  assert.deepEqual(awRequests, []);
  assert.equal(await page.evaluate(() => !!window.LocalAIAWKit), false);
});

await page.evaluate(() => window.showView('agents'));
await page.waitForFunction(() => window.__awcLayout?.().workers.length === 3);

await check('opening Agent World fetches each on-demand module once', async () => {
  await page.waitForFunction(() => !!window.LocalAIAWKit, null, { timeout: 5000 });
  await page.evaluate(() => window.showView('home')); await page.waitForTimeout(200);
  await page.evaluate(() => window.showView('agents')); await page.waitForTimeout(400);
  assert.deepEqual(awRequests, ['/aw/kit.js', '/aw/landmarks.js']);
  assert.equal(await page.evaluate(() => window.LocalAIAWKit.clean('a‮b', 80)), 'a b');
});

await page.evaluate(() => { window.LocalAIAgentWorld.follow(false); window.LocalAIAgentWorld.view('fit'); });
await page.waitForFunction(() => window.__awcLayout().workers.every(w => !w.moving), null, { timeout: 20000 });

// Every route between districts, as the flow test in agent-world-ui.mjs walks them, as tiles (each leg sampled).
const ZONES = ['command', 'ux', 'docs', 'engineering', 'validation', 'models', 'projects', 'repair'];
const tilesWalked = () => page.evaluate(zones => {
  const T = 32, out = new Set();
  for (const id of ['router', 'ux_analyst', 'code_analyst']) for (const from of [undefined, ...zones]) for (const z of zones) for (const inside of [true, false]) {
    const p = window.__awcSim.route(id, z, inside, from).points;
    for (let i = 1; i < p.length; i++) for (let s = 0; s <= 16; s++) { const x = p[i - 1].x + (p[i].x - p[i - 1].x) * s / 16, y = p[i - 1].y + (p[i].y - p[i - 1].y) * s / 16; out.add(Math.floor(x / T) + ',' + Math.floor(y / T)); }
  }
  return [...out];
}, ZONES);
// The empty west block (x 4-12, y 10-12, where Claude Yard goes) and the stretch of avenue beside it (x 13-14, y 10-12),
// which routes from the top-left districts to the bottom-left ones use today and can go round.
const RESERVE = [{ x: 4, y: 10, w: 9, h: 3 }, { x: 13, y: 10, w: 2, h: 3 }];
const inReserve = k => { const [x, y] = k.split(',').map(Number); return RESERVE.some(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h); };

// The shipped landmarks layer would add its own rows and tiles; this test checks the hook alone.
await page.evaluate(() => window.LocalAIAWLandmarks?.stop());
const before = await tilesWalked(), treesBefore = (await page.evaluate(() => window.__awcLayout().trees)).length;
await page.evaluate(reserve => {
  const L = window.__L = { draws: 0, grounds: 0, v: 1, opened: [] }, item = { id: 'yard', label: 'Test yard', detail: 'Nothing here yet' };
  window.__bad = window.LocalAIAgentWorld.addLayer({ draw() { throw new Error('a broken layer'); }, hit() { throw new Error('a broken hit'); }, rows() { throw new Error('broken rows'); } });
  window.__layer = window.LocalAIAgentWorld.addLayer({
    reserve,
    ground: { sig: () => 'v' + L.v, paint(ctx) { L.grounds++; ctx.fillStyle = '#ff00ff'; ctx.fillRect(4 * 32, 10 * 32, 9 * 32, 3 * 32); } },
    draw() { L.draws++; },
    hit: (x, y) => x >= 4 * 32 && x < 13 * 32 && y >= 10 * 32 && y < 13 * 32 ? item : null,
    rows: () => [item],
    open(it) { L.opened.push(it.id); }
  });
}, RESERVE);

await check('a layer draws every frame, and a broken layer does not stop it', async () => {
  const a = await page.evaluate(() => window.__L.draws); await page.waitForTimeout(400);
  const b = await page.evaluate(() => window.__L.draws);
  assert.ok(b > a + 5, `draws went from ${a} to ${b}`);
});
await check('the ground is painted once per state, not every frame', async () => {
  await page.waitForTimeout(300);
  const g1 = await page.evaluate(() => window.__L.grounds);
  assert.ok(g1 >= 1, 'painted into the ground cache');
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(() => window.__L.grounds), g1, 'not repainted while the state is the same');
  await page.evaluate(() => { window.__L.v = 2; });
  await page.waitForFunction(n => window.__L.grounds > n, g1, { timeout: 2000 });
  const shown = await page.evaluate(() => { const c = window.LocalAIAgentWorld.camera(), k = c.base * c.shown.zoom * c.dpr, x = Math.round(c.shown.panX * c.dpr + 8.5 * 32 * k), y = Math.round(c.shown.panY * c.dpr + 11.5 * 32 * k), d = document.getElementById('awcCanvas').getContext('2d').getImageData(x, y, 1, 1).data; return [...d]; });
  assert.ok(shown[0] > 150 && shown[2] > 150 && shown[1] < 120, `the painted ground shows on the canvas: rgba ${shown}`);
});
await check('reserved tiles are never entered by a worker, and no tree or lamp grows there', async () => {
  assert.ok(before.some(inReserve), 'without the layer some route used that avenue (so the check means something)');
  const after = await tilesWalked();
  assert.deepEqual(after.filter(inReserve), []);
  const treesAfter = (await page.evaluate(() => window.__awcLayout().trees)).length;
  assert.ok(treesAfter < treesBefore, `trees ${treesBefore} -> ${treesAfter}`);
});
await check('a tap on the layer selects it and opens it', async () => {
  const pt = await page.evaluate(() => { const c = window.LocalAIAgentWorld.camera(), r = document.getElementById('awcCanvas').getBoundingClientRect(), k = c.base * c.shown.zoom; return { x: r.left + c.shown.panX + 8.5 * 32 * k, y: r.top + c.shown.panY + 11.5 * 32 * k, r: { l: r.left, t: r.top, w: r.width, h: r.height } }; });
  assert.ok(pt.x > pt.r.l && pt.x < pt.r.l + pt.r.w && pt.y > pt.r.t && pt.y < pt.r.t + pt.r.h, `the yard is on screen: ${JSON.stringify(pt)}`);
  await page.mouse.click(pt.x, pt.y);
  await page.waitForFunction(() => window.__L.opened.length === 1);
  assert.match(await page.locator('#awcSelection').innerText(), /Test yard[\s\S]*Nothing here yet/);
});
await check('its row is listed under City services and opens the same thing', async () => {
  const s = page.locator('#awServices');
  await s.waitFor({ state: 'visible' });
  assert.equal(await s.locator('h2').innerText(), 'City services');
  const rows = s.locator('[role="list"] > [role="listitem"] > button');
  assert.equal(await rows.count(), 1);
  assert.match(await rows.first().innerText(), /Test yard\s*Nothing here yet/);
  await rows.first().click();
  assert.deepEqual(await page.evaluate(() => window.__L.opened), ['yard', 'yard']);
});
await check('City services passes axe (no serious or critical violations)', async () => {
  await addAxe(page, join(dirname(fileURLToPath(import.meta.url)), 'vendor', 'axe.min.js'));
  const v = await page.evaluate(async () => (await window.axe.run('#awServices')).violations.filter(x => ['serious', 'critical'].includes(x.impact)).map(x => x.id + ': ' + x.nodes.map(n => n.target).join(' ')));
  assert.deepEqual(v, []);
});
await check('removing the layer gives the tiles back and hides City services', async () => {
  await page.evaluate(() => { window.__layer.remove(); window.__bad.remove(); });
  assert.equal(await page.locator('#awServices').isHidden(), true);
  const back = await tilesWalked();
  assert.ok(back.some(inReserve), 'routes may use that avenue again');
});
await check('no script errors', async () => assert.deepEqual(errors, []));

await browser.close();
if (failures.length) { console.error(`\n${failures.length} failed:\n${failures.join('\n')}`); process.exit(1); }
console.log('\nall agent world layer checks passed');
