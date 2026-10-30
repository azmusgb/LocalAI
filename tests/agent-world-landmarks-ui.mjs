import { chromium } from 'playwright';
import assert from 'node:assert/strict';

// Agent World landmarks (app/public/aw/landmarks.js): GET /api/world lights the Model Foundry, the Workshop garage, the
// Spreadsheets office and the Display billboard. Stubbed answers: busy, quiet and down. Each place is a City services
// row and a tap target that opens its page, a change repaints the ground once, and nothing walks into the buildings.
const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const browser = await chromium.launch({ headless: true });
const failures = [];
async function check(name, fn) { try { await fn(); console.log('PASS', name); } catch (e) { failures.push(`${name}: ${e.message}`); console.error('FAIL', name, e.message); } }

const BUSY = {
  schema: 1,
  models: { loaded: [{ name: 'qwen3:4b-instruct-32k', sizeMb: 3100, vramMb: 3100 }], queue: { active: 1, waiting: 2 }, busy: { total: 1, kinds: { chat: 1 } } },
  printer: { setUp: true, access: 'ok', state: 'printing', progress: 62, minutesLeft: 41, errorCode: null },
  sheets: { bridge: true, excel: true, inFlight: 1 },
  kiosk: { setUp: true, online: true, signIn: true, firmware: '12.8.0' },
  crews: null
};
const DOWN = {
  schema: 1,
  models: { loaded: null, queue: null, busy: null },
  printer: { setUp: true, access: null, state: null, progress: null, minutesLeft: null, errorCode: null },
  sheets: { bridge: false, excel: null, inFlight: 0 },
  kiosk: { setUp: true, online: false, signIn: null, firmware: null },
  crews: null
};
const ERROR = { ...BUSY, printer: { setUp: true, access: 'ok', state: 'error', progress: 62, minutesLeft: null, errorCode: '0300_4001' } };
const MISSION = {
  id: 'mission-landmarks', goal: 'Landmarks', status: 'running', createdAt: new Date(Date.now() - 60e3).toISOString(), updatedAt: new Date().toISOString(), results: [], timeline: [],
  workers: [{ id: 'router', name: 'Mission Router', state: 'complete', dependsOn: [] }, { id: 'code_analyst', name: 'Code Analyst', state: 'pending', dependsOn: ['router'] }]
};

let answer = BUSY, worldCalls = 0;
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
await context.addInitScript(() => { try { localStorage.setItem('localai.firstRun.done', '1'); localStorage.setItem('localai.devTools', '0'); localStorage.setItem('localai.debug', '1'); } catch {} });
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.route(u => u.pathname === '/api/agents/missions', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: [MISSION] }) }));
await page.route(u => u.pathname === '/api/world', r => { worldCalls++; return r.fulfill({ contentType: 'application/json', body: JSON.stringify(answer) }); });
// Start off Home: Home's own street strip polls /api/world while it is on screen.
await page.goto(base + '/#status', { waitUntil: 'networkidle' });
await page.waitForFunction(() => typeof window.showView === 'function' && window.LocalAIAgentWorld?.addLayer);

await check('the city off screen never asks for /api/world', async () => {
  await page.waitForTimeout(400);
  assert.equal(worldCalls, 0);
});

await page.evaluate(() => window.showView('agents'));
await page.waitForFunction(() => !!window.LocalAIAWLandmarks?.state(), null, { timeout: 8000 });
const rowText = () => page.locator('#awcLayerRows').innerText();

await check('busy: each place is a City services row that says what it is doing', async () => {
  await page.waitForFunction(() => document.querySelectorAll('#awcLayerRows button').length === 4);
  const t = await rowText();
  for (const want of ['Model Foundry', 'Working · qwen3:4b-instruct-32k · 2 waiting', 'Workshop garage', 'Printing · 62% · 41 min left', 'Spreadsheets office', '1 request running', 'Display billboard', 'Online · Firmware 12.8.0'])
    assert.ok(t.includes(want), `rows say "${want}": ${t}`);
});

await check('a row opens the page that deals with it', async () => {
  await page.locator('#awcLayerRows button', { hasText: 'Spreadsheets office' }).click();
  await page.waitForFunction(() => document.querySelector('#spreadsheets')?.classList.contains('active'));
  await page.evaluate(() => window.showView('agents'));
  await page.waitForFunction(() => document.querySelectorAll('#awcLayerRows button').length === 4);
});

await check('tapping the garage on the map opens Services', async () => {
  await page.evaluate(() => { window.LocalAIAgentWorld.follow(false); window.LocalAIAgentWorld.view('fit'); });
  await page.waitForTimeout(600);
  const pt = await page.evaluate(() => {
    const c = document.getElementById('awcCanvas'), r = c.getBoundingClientRect(), cam = window.LocalAIAgentWorld.camera(), s = (cam.shown.zoom ? cam.base * cam.shown.zoom : 1);
    const wx = (27 + 2) * 32, wy = (10 + 2) * 32; return { x: r.left + cam.shown.panX + wx * s, y: r.top + cam.shown.panY + wy * s };
  });
  await page.mouse.click(pt.x, pt.y);
  await page.waitForFunction(() => document.querySelector('#integrations')?.classList.contains('active'), null, { timeout: 4000 });
  await page.evaluate(() => window.showView('agents'));
  await page.waitForFunction(() => document.querySelectorAll('#awcLayerRows button').length === 4);
});

await check('no worker route goes through the new buildings', async () => {
  const zones = ['command', 'ux', 'docs', 'engineering', 'validation', 'models', 'projects', 'repair'];
  const bad = await page.evaluate(zones => {
    const T = 32, boxes = [{ x: 27, y: 10, w: 4, h: 3 }, { x: 27, y: 1, w: 4, h: 2 }, { x: 32, y: 1, w: 3, h: 2 }], out = [];
    for (const from of [undefined, ...zones]) for (const z of zones) for (const inside of [true, false]) {
      const p = window.__awcSim.route('code_analyst', z, inside, from).points;
      for (let i = 1; i < p.length; i++) for (let s = 0; s <= 16; s++) {
        const x = Math.floor((p[i - 1].x + (p[i].x - p[i - 1].x) * s / 16) / T), y = Math.floor((p[i - 1].y + (p[i].y - p[i - 1].y) * s / 16) / T);
        if (boxes.some(b => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h)) out.push(`${from}->${z}: ${x},${y}`);
      }
    }
    return out.slice(0, 5);
  }, zones);
  assert.deepEqual(bad, []);
});

await check('down: the places say so plainly, and an unchanged answer does not refresh the rows', async () => {
  answer = DOWN;
  await page.evaluate(() => window.LocalAIAWLandmarks.poll());
  await page.waitForFunction(() => document.querySelector('#awcLayerRows')?.innerText.includes('Bridge down'));
  const t = await rowText();
  for (const want of ['Not answering · The model server didn’t answer', 'Not answering · The printer isn’t reporting right now', 'Bridge down', 'Offline'])
    assert.ok(t.includes(want), `rows say "${want}": ${t}`);
  const before = await page.evaluate(() => document.querySelector('#awcLayerRows button'));
  await page.evaluate(() => { window.__sameRow = document.querySelector('#awcLayerRows button'); });
  await page.evaluate(() => window.LocalAIAWLandmarks.poll()); await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.__sameRow === document.querySelector('#awcLayerRows button')), true, 'no re-render for the same answer');
  void before;
});

await check('a printer error names the code', async () => {
  answer = ERROR;
  await page.evaluate(() => window.LocalAIAWLandmarks.poll());
  await page.waitForFunction(() => document.querySelector('#awcLayerRows')?.innerText.includes('Needs attention · Error 0300_4001'));
});

await check('expired telemetry is not a current printer state', async () => {
  answer = { ...BUSY, printer: { setUp: true, access: 'stale', state: null, progress: null, via: 'pi-hub' } };
  await page.evaluate(() => window.LocalAIAWLandmarks.poll());
  await page.waitForFunction(() => document.querySelector('#awcLayerRows')?.innerText.includes('Reading expired'));
});

await check('a finished print still asks for its plate confirmation', async () => {
  answer = { ...BUSY, printer: { setUp: true, access: 'ok', state: 'idle', needsPlateClear: true, via: 'pi-hub' } };
  await page.evaluate(() => window.LocalAIAWLandmarks.poll());
  await page.waitForFunction(() => document.querySelector('#awcLayerRows')?.innerText.includes('Print finished · Check and clear the plate'));
});

await check('reduced motion keeps drawing without errors', async () => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(500);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
});

await check('no script errors', async () => { assert.deepEqual(errors, []); });

await browser.close();
if (failures.length) { console.error(`${failures.length} landmark check(s) failed`); process.exit(1); }
console.log('All landmark checks passed.');
