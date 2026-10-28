import { chromium } from 'playwright';
import assert from 'node:assert/strict';

// Main Street's engine (app/public/street/street.js): mount(el, {mode:'strip'}) draws the buildings on one canvas with
// cached stills, a 30 fps loop that runs only on screen, and one chip button per building. Each check mounts a fresh
// strip on the app page (opened on Health, so Home's own strip is not mounted) and feeds it a world with setWorld; /api/world is routed to hang unless a check gives
// its own route (the shared poller, below, would otherwise overwrite the worlds the checks set).
const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const browser = await chromium.launch({ headless: true });
const failures = [];
async function check(name, fn) { try { await fn(); console.log('PASS', name); } catch (e) { failures.push(`${name}: ${e.message}`); console.error('FAIL', name, e.message); } }

const src = o => ({ running: [], waiting: 0, needsYou: [], failedUnseen: [], recent: [], ...o });
const job = i => ({ id: 'j' + i, title: 'Job ' + i, status: 'running', startedAt: Date.now() - 60000 * i });
const BUSY = {
  schema: 1,
  models: { loaded: [{ name: 'qwen3:4b-instruct-32k', sizeMb: 3100, vramMb: 3100 }], queue: { active: 1, waiting: 2 }, busy: { total: 1, kinds: { chat: 1 } } },
  printer: { setUp: true, access: 'ok', state: 'printing', progress: 62, minutesLeft: 41, errorCode: null },
  sheets: { bridge: true, excel: true, inFlight: 1 },
  kiosk: { setUp: true, online: true, signIn: true, firmware: '12.8.0' },
  crews: null,
  street: { chat: src({ running: [job(1), job(2)], waiting: 1 }), images: src({ running: [job(3)] }), missions: src(), garage: src(), sheets: src({ running: [job(4)] }), clock: src() }
};
const TITLES = ['Chat Café', 'Image Studio', 'Spreadsheets Office', 'Model Foundry', 'Workshop Garage', 'Kiosk Billboard'];

const contexts = [];
// A fresh page with the street's modules loaded and a strip mounted in a fixed box at the top (in view). window.__el is
// the mount element, window.__opened the ids onOpen got. setWorld(world) runs unless world is null.
async function fresh({ viewport = { width: 1280, height: 800 }, dpr = 1, world = BUSY, reduced = false, clock = false, route = () => {} } = {}) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: dpr, serviceWorkers: 'block', reducedMotion: reduced ? 'reduce' : 'no-preference' });
  contexts.push(context);
  await context.addInitScript(() => { try { localStorage.setItem('localai.firstRun.done', '1'); } catch {} });
  const page = await context.newPage();
  page.errors = [];
  await page.route('**/api/world', route);
  if (clock) await page.clock.install();
  page.on('pageerror', e => page.errors.push(e.message));
  await page.goto(base + '/#status', { waitUntil: 'domcontentloaded' }); // off Home: Home mounts its own strip
  await page.waitForFunction(() => typeof window.LocalAIStreetLoad === 'function');
  await page.evaluate(async world => {
    await window.LocalAIStreetLoad();
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999';
    window.__el = document.body.appendChild(el); window.__opened = [];
    window.__street = window.LocalAIStreet.mount(el, { mode: 'strip', onOpen: id => window.__opened.push(id) });
    if (world) window.LocalAIStreet.setWorld(world);
  }, world);
  if (clock) await page.clock.pauseAt(new Date(Date.now() + 1000));
  return page;
}
const chipTexts = page => page.evaluate(() => [...window.__el.querySelectorAll('.street-chip:not(.street-chip--stale)')].map(b => b.textContent));
const stats = page => page.evaluate(() => window.LocalAIStreet.stats());

await check('the strip stays hidden until the first world, and shows its canvas and chips after', async () => {
  const page = await fresh({ world: null });
  assert.equal(await page.evaluate(() => window.__el.querySelector('.street').hidden), true, 'hidden before a world');
  await page.evaluate(w => window.LocalAIStreet.setWorld(w), BUSY);
  const r = await page.evaluate(() => { const s = window.__el.querySelector('.street'); return { hidden: s.hidden, h: s.querySelector('.street__canvas').clientHeight, chips: !!s.querySelector('.street__chips') }; });
  assert.deepEqual(r, { hidden: false, h: 160, chips: true });
});

await check('six chips in street order with the right words', async () => {
  const page = await fresh();
  const t = await chipTexts(page);
  assert.equal(t.length, 6, `six chips: ${JSON.stringify(t)}`);
  TITLES.forEach((title, i) => assert.ok(t[i].startsWith(title), `chip ${i} starts with ${title}: ${t[i]}`));
  assert.ok(t[3].includes('qwen3:4b-instruct-32k loaded · 2 waiting'), t[3]);
  const chip = await page.evaluate(() => { const b = window.__el.querySelectorAll('.street-chip')[3]; return { tag: b.tagName, type: b.type, label: b.getAttribute('aria-label'), busy: b.classList.contains('street-chip--busy') }; });
  assert.deepEqual(chip, { tag: 'BUTTON', type: 'button', label: 'Model Foundry: qwen3:4b-instruct-32k loaded · 2 waiting', busy: true });
  await page.evaluate(() => window.__el.querySelectorAll('.street-chip')[3].click());
  assert.deepEqual(await page.evaluate(() => window.__opened), ['foundry'], 'a chip opens its building');
  assert.deepEqual(page.errors, []);
});

await check('chips have room: no chip text is cut at 1280, and the buildings spread across the strip', async () => {
  const page = await fresh();
  const r = await page.evaluate(() => {
    const s = window.__el.querySelector('.street'), a = s.getBoundingClientRect(), chips = [...s.querySelectorAll('.street-chip')];
    const cut = [...s.querySelectorAll('.street-chip span')].filter(e => e.scrollWidth > e.clientWidth).map(e => e.textContent);
    const boxes = chips.map(b => b.getBoundingClientRect());
    const overlap = boxes.some((b, i) => i && b.left < boxes[i - 1].right);
    return { cut, overlap, first: boxes[0].left - a.left, last: a.right - boxes[boxes.length - 1].right, label: s.getAttribute('aria-label'), hidden: s.querySelector('canvas').getAttribute('aria-hidden') };
  });
  assert.deepEqual(r.cut, [], `no chip text cut: ${JSON.stringify(r.cut)}`);
  assert.equal(r.overlap, false, 'chips do not overlap');
  assert.ok(r.first < 120 && r.last < 120, `the street fills the strip: ${r.first}, ${r.last}`);
  assert.equal(r.label, 'Agent World street'); assert.equal(r.hidden, 'true');
});

await check('a title with HTML is text', async () => {
  const evil = '<img src=x onerror=window.__x=1>';
  const page = await fresh({ world: { ...BUSY, models: { ...BUSY.models, loaded: [{ name: evil }] } } });
  await page.waitForTimeout(200);
  const t = await chipTexts(page);
  assert.ok(t[3].includes(evil + ' loaded'), t[3]);
  assert.equal(await page.evaluate(() => window.__el.querySelector('.street__chips img')), null, 'no element made from the name');
  assert.equal(await page.evaluate(() => typeof window.__x), 'undefined');
});

await check('stills rebuild only when the picture changes', async () => {
  const page = await fresh();
  const s0 = (await stats(page)).stills;
  assert.ok(s0 >= 6, `one still per building at first: ${s0}`);
  await page.evaluate(w => window.LocalAIStreet.setWorld(w), BUSY);
  assert.equal((await stats(page)).stills, s0, 'the same world again');
  await page.evaluate(w => window.LocalAIStreet.setWorld({ ...w, printer: { ...w.printer, progress: 63 } }), BUSY);
  assert.equal((await stats(page)).stills, s0, 'only the progress changed');
  await page.evaluate(w => window.LocalAIStreet.setWorld({ ...w, models: { ...w.models, loaded: [] } }), BUSY);
  assert.equal((await stats(page)).stills, s0 + 1, 'the Foundry went dark');
});

await check('canvas follows size and DPR', async () => {
  const page = await fresh();
  const r = await page.evaluate(() => { const c = window.__el.querySelector('canvas'); return { w: c.width, cw: c.clientWidth, h: c.height, ch: c.clientHeight }; });
  assert.equal(r.w, r.cw); assert.equal(r.h, r.ch);
  assert.equal(r.cw, 1280);
  await page.setViewportSize({ width: 390, height: 844 });
  const phone = await fresh({ viewport: { width: 390, height: 844 }, dpr: 3 });
  await phone.waitForTimeout(100);
  const p = await phone.evaluate(() => { const s = window.__el.querySelector('.street'), c = s.querySelector('canvas'); return { w: c.width, cw: c.clientWidth, h: c.height, ch: c.clientHeight, sw: s.scrollWidth, scw: s.clientWidth }; });
  assert.equal(p.w, p.cw * 3); assert.equal(p.ch, 132); assert.equal(p.h, 132 * 3);
  assert.ok(p.sw > p.scw, `the street scrolls on a phone: ${p.sw} > ${p.scw}`);
});

await check('the street fits on a desktop and scrolls on a phone, and a change brings its building into view', async () => {
  const page = await fresh();
  assert.deepEqual(await page.evaluate(() => { const s = window.__el.querySelector('.street'); return s.scrollWidth <= s.clientWidth; }), true, 'fits at 1280');
  const phone = await fresh({ viewport: { width: 390, height: 844 }, reduced: true });
  const left0 = await phone.evaluate(() => window.__el.querySelector('.street').scrollLeft);
  await phone.evaluate(w => window.LocalAIStreet.setWorld({ ...w, kiosk: { setUp: false } }), BUSY);
  await phone.waitForTimeout(100);
  const r = await phone.evaluate(() => { const s = window.__el.querySelector('.street'), k = [...s.querySelectorAll('.street-chip')].pop(); const a = s.getBoundingClientRect(), b = k.getBoundingClientRect(); return { left: s.scrollLeft, inView: b.left >= a.left - 1 && b.right <= a.right + 1 }; });
  assert.ok(r.left > left0 && r.inView, `the kiosk scrolled into view: ${JSON.stringify(r)}`);
  // Once the person scrolls, a change leaves the camera alone for a while.
  await phone.evaluate(() => { const s = window.__el.querySelector('.street'); s.dispatchEvent(new WheelEvent('wheel', { deltaY: -2000, bubbles: true, cancelable: true })); });
  await phone.waitForTimeout(100);
  const left1 = await phone.evaluate(() => window.__el.querySelector('.street').scrollLeft);
  assert.ok(left1 < r.left, `the wheel scrolled the street: ${left1}`);
  await phone.evaluate(w => window.LocalAIStreet.setWorld(w), BUSY);
  await phone.waitForTimeout(100);
  assert.equal(await phone.evaluate(() => window.__el.querySelector('.street').scrollLeft), left1, 'the camera stays where the person put it');
});

await check('a mouse drag scrolls a narrow street and does not open a chip; a plain click does', async () => {
  const page = await fresh({ viewport: { width: 500, height: 600 } });
  await page.evaluate(() => { window.__el.id = 'streetMount'; });
  const box = await page.locator('#streetMount .street').boundingBox();
  await page.mouse.move(box.x + 400, box.y + 120); await page.mouse.down();
  await page.mouse.move(box.x + 200, box.y + 120, { steps: 5 }); await page.mouse.up();
  const r = await page.evaluate(() => { const s = window.__el.querySelector('.street'); return [s.scrollLeft, s.scrollWidth - s.clientWidth]; });
  assert.ok(Math.abs(r[0] - 200) <= 1 && r[1] > 200, `dragged 200 px: ${r}`);
  const chip = page.locator('#streetMount .street-chip', { hasText: 'Model Foundry' });
  const c = await chip.boundingBox();
  await page.mouse.move(c.x + 10, c.y + 10); await page.mouse.down();
  await page.mouse.move(c.x + 60, c.y + 10, { steps: 4 }); await page.mouse.up();
  assert.deepEqual(await page.evaluate(() => window.__opened), [], 'a drag that starts on a chip is not a click');
  await chip.click();
  assert.deepEqual(await page.evaluate(() => window.__opened), ['foundry']);
});

await check("one broken building doesn't stop the street", async () => {
  const page = await fresh();
  await page.evaluate(w => {
    window.__warns = []; const warn = console.warn; console.warn = (...a) => { window.__warns.push(a.map(String).join(' ')); warn.apply(console, a); };
    window.LocalAIStreet.register({ id: 'yard', width: 100, state: () => ({}), chip: () => ({ title: 'Y', detail: 'y', tone: 'quiet' }), drawStill() {}, drawLive() { throw new Error('boom'); } });
    window.LocalAIStreet.setWorld(w);
    const s = window.__el.querySelector('.street'); s.scrollLeft = s.scrollWidth; // the yard stands at the far end
  }, BUSY);
  const f0 = (await stats(page)).frames;
  await page.waitForTimeout(1200);
  const f1 = (await stats(page)).frames;
  assert.ok(f1 - f0 >= 20, `about 30 frames ran: ${f1 - f0}`);
  const t = await chipTexts(page);
  assert.equal(t.length, 7); TITLES.forEach((title, i) => assert.ok(t[i].startsWith(title)));
  await page.waitForTimeout(300);
  assert.ok((await stats(page)).frames > f1, 'frames keep rising');
  const warns = await page.evaluate(() => window.__warns);
  assert.equal(warns.length, 1, JSON.stringify(warns)); assert.ok(warns[0].includes('yard'), warns[0]);
  assert.deepEqual(page.errors, []);
});

await check('the loop holds to 30 fps', async () => {
  const page = await fresh();
  const f0 = (await stats(page)).frames;
  await page.waitForTimeout(2000);
  const n = (await stats(page)).frames - f0;
  assert.ok(n >= 40 && n <= 64, `about 60 frames in 2 s: ${n}`);
});

await check('reduced motion draws once, then stops', async () => {
  const page = await fresh();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(150);
  const f0 = (await stats(page)).frames;
  await page.waitForTimeout(1000);
  assert.equal((await stats(page)).frames, f0, 'no frames while still');
  await page.evaluate(w => window.LocalAIStreet.setWorld(w), BUSY);
  assert.equal((await stats(page)).frames, f0 + 1, 'one frame per world');
  const fresh2 = await fresh({ reduced: true });
  const g0 = (await stats(fresh2)).frames;
  assert.ok(g0 >= 1, 'a frame drawn at mount');
  await fresh2.waitForTimeout(1000);
  assert.equal((await stats(fresh2)).frames, g0);
});

await check('off screen, no frames', async () => {
  const page = await fresh();
  await page.evaluate(() => { window.__el.style.marginTop = '5000px'; });
  await page.waitForTimeout(300);
  const f0 = (await stats(page)).frames;
  await page.waitForTimeout(800);
  assert.equal((await stats(page)).frames, f0, 'no frames off screen');
  await page.evaluate(() => { window.__el.style.marginTop = '0'; });
  await page.waitForTimeout(500);
  assert.ok((await stats(page)).frames > f0, 'frames again on screen');
});

await check('destroy removes the strip and stops drawing', async () => {
  const page = await fresh();
  await page.evaluate(() => window.__street.destroy());
  const f0 = (await stats(page)).frames;
  await page.waitForTimeout(500);
  assert.equal((await stats(page)).frames, f0);
  assert.equal(await page.evaluate(() => window.__el.querySelector('.street')), null);
});

// The shared poller: one fetch of /api/world every 10 s while a strip is on screen and the page visible. A fake clock
// moves time; each step waits for the request to land.
const STALE = "Can't reach LocalAI, retrying";
function stub() {
  const s = { mode: 'ok', n: 0, world: BUSY };
  s.route = route => {
    s.n++;
    if (s.mode === 'ok') return route.fulfill({ json: s.world });
    if (s.mode === '500') return route.fulfill({ status: 500, body: 'no' });
    if (s.mode === 'abort') return route.abort();
    if (s.mode === 'badjson') return route.fulfill({ status: 200, contentType: 'application/json', body: '{' });
    if (s.mode === 'schema2') return route.fulfill({ json: { schema: 2 } });
  };
  return s;
}
async function step(page, s) {
  const n = s.n; await page.clock.runFor(10000);
  for (let i = 0; i < 100 && s.n === n; i++) await new Promise(r => setTimeout(r, 20));
  await new Promise(r => setTimeout(r, 100));
}
async function until(page, fn, what) { try { await page.waitForFunction(fn, null, { timeout: 3000 }); } catch { throw new Error('timed out waiting for ' + what); } }

await check('polls every 10 s only while visible', async () => {
  const s = stub(); const page = await fresh({ world: null, clock: true, route: s.route });
  await until(page, () => !window.__el.querySelector('.street').hidden, 'the first world');
  assert.equal(s.n, 1, 'one request at once');
  for (let i = 0; i < 3; i++) await step(page, s);
  assert.equal(s.n, 4, 'the first plus three in 30 s');
  await page.evaluate(() => { for (const k of ['hidden', 'visibilityState']) Object.defineProperty(document, k, { configurable: true, get: () => k === 'hidden' ? true : 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.clock.runFor(30000); await new Promise(r => setTimeout(r, 300));
  assert.equal(s.n, 4, 'no requests while hidden');
  await page.evaluate(() => { for (const k of ['hidden', 'visibilityState']) Object.defineProperty(document, k, { configurable: true, get: () => k === 'hidden' ? false : 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
  for (let i = 0; i < 100 && s.n === 4; i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(s.n, 5, 'one request at once when visible again');
});

await check('a street scrolled off screen is not polled; destroying the last mount stops the poller', async () => {
  const s = stub(); const page = await fresh({ world: null, clock: true, route: s.route });
  await until(page, () => !window.__el.querySelector('.street').hidden, 'the first world');
  await page.evaluate(() => { window.__el.style.marginTop = '5000px'; });
  await page.waitForTimeout(300);
  const n = s.n; await page.clock.runFor(30000); await new Promise(r => setTimeout(r, 300));
  assert.equal(s.n, n, 'no requests off screen');
  await page.evaluate(() => window.__street.destroy());
  await page.clock.runFor(30000); await new Promise(r => setTimeout(r, 300));
  assert.equal(s.n, n, 'none after the last destroy');
});

await check('bad answers keep the last picture and say so', async () => {
  const s = stub(); const page = await fresh({ world: null, clock: true, route: s.route });
  await until(page, () => !window.__el.querySelector('.street').hidden, 'the first world');
  const good = await chipTexts(page);
  assert.equal(good.length, 6);
  assert.equal(await page.evaluate(() => window.__el.querySelectorAll('.street-chip--stale').length), 0, 'no stale chip at first');
  for (const mode of ['500', 'abort', 'badjson', 'schema2']) {
    s.mode = mode; await step(page, s);
    await until(page, () => !!window.__el.querySelector('.street.is-stale'), mode + ' to mark it stale');
    const r = await page.evaluate(() => ({ stale: [...window.__el.querySelectorAll('.street-chip--stale')].map(b => b.textContent), op: getComputedStyle(window.__el.querySelector('.street__canvas')).opacity, hidden: window.__el.querySelector('.street').hidden }));
    assert.deepEqual(r, { stale: [STALE], op: '0.55', hidden: false }, mode);
    assert.deepEqual(await chipTexts(page), good, mode + ' keeps the last chips');
  }
  s.mode = 'ok'; await step(page, s);
  await until(page, () => !window.__el.querySelector('.street.is-stale'), 'a good answer to clear it');
  assert.equal(await page.evaluate(() => window.__el.querySelectorAll('.street-chip--stale').length), 0, 'the stale chip goes');
  assert.equal(await page.evaluate(() => getComputedStyle(window.__el.querySelector('.street__canvas')).opacity), '1');
});

await check('nothing shows before the first answer', async () => {
  const page = await fresh({ world: null });
  await page.waitForTimeout(400);
  const r = await page.evaluate(() => ({ hidden: window.__el.querySelector('.street').hidden, chips: window.__el.querySelectorAll('.street-chip').length }));
  assert.deepEqual(r, { hidden: true, chips: 0 });
});

await check('a failure before the first answer keeps the strip hidden, and a second mount shows stale too', async () => {
  const s = stub(); s.mode = '500'; const page = await fresh({ world: null, clock: true, route: s.route });
  await new Promise(r => setTimeout(r, 300));
  assert.equal(await page.evaluate(() => window.__el.querySelector('.street').hidden), true);
  s.mode = 'ok'; await step(page, s);
  await until(page, () => !window.__el.querySelector('.street').hidden, 'the first good world');
  s.mode = '500'; await step(page, s);
  await until(page, () => !!window.__el.querySelector('.street.is-stale'), 'stale');
  await page.evaluate(() => { const el = document.createElement('div'); document.body.append(el); window.__second = el; window.LocalAIStreet.mount(el, { mode: 'strip' }); });
  await new Promise(r => setTimeout(r, 200));
  const r = await page.evaluate(() => ({ cls: window.__second.querySelector('.street').className, chips: [...window.__second.querySelectorAll('.street-chip--stale')].map(b => b.textContent) }));
  assert.ok(r.cls.includes('is-stale'), r.cls); assert.deepEqual(r.chips, [STALE]);
});

await check('the scroller is a labelled region', async () => {
  const page = await fresh();
  assert.deepEqual(await page.evaluate(() => { const s = window.__el.querySelector('.street'); return [s.getAttribute('role'), s.getAttribute('aria-label')]; }), ['region', 'Agent World street']);
});

await check('a street on a display:none page is not polled or drawn, and wakes when the page shows', async () => {
  const s = stub(); const page = await fresh({ world: null, clock: true, route: s.route });
  await page.evaluate(() => window.__street.destroy());
  await page.evaluate(() => { const p = document.createElement('div'); p.style.cssText = 'display:none;position:fixed;top:0;left:0;right:0'; document.body.append(p); const el = document.createElement('div'); p.append(el); window.__p = p; window.__q = el; window.__s2 = window.LocalAIStreet.mount(el, { mode: 'strip' }); });
  const n = s.n;
  await page.clock.runFor(30000); await new Promise(r => setTimeout(r, 300));
  assert.equal(s.n, n, 'no requests with no world yet');
  await page.evaluate(w => window.LocalAIStreet.setWorld(w), BUSY);
  const f = (await stats(page)).frames;
  await page.clock.runFor(30000); await new Promise(r => setTimeout(r, 300));
  assert.equal(s.n, n, 'no requests after a world');
  assert.equal((await stats(page)).frames, f, 'no frames');
  await page.evaluate(() => { window.__p.style.display = 'block'; });
  await step(page, s);
  assert.ok(s.n > n, 'requests resume within one tick');
  await page.clock.runFor(500);
  await page.waitForFunction(f => window.LocalAIStreet.stats().frames > f, f, { timeout: 3000 });
});

await check('a street shown below the fold is not polled or drawn until scrolled into view', async () => {
  const s = stub(); const page = await fresh({ world: null, clock: true, route: s.route });
  await page.evaluate(() => window.__street.destroy());
  await page.evaluate(() => { const p = document.createElement('div'); p.style.display = 'none'; const sp = document.createElement('div'); sp.style.height = '3000px'; const el = document.createElement('div'); p.append(sp, el); document.body.append(p); window.__p = p; window.__q = el; window.LocalAIStreet.mount(el, { mode: 'strip' }); });
  await page.evaluate(w => window.LocalAIStreet.setWorld(w), BUSY);
  await page.evaluate(() => { window.__p.style.display = 'block'; });
  await page.clock.runFor(100); await new Promise(r => setTimeout(r, 300));
  const n = s.n, f = (await stats(page)).frames;
  await page.clock.runFor(30000); await new Promise(r => setTimeout(r, 300));
  assert.equal(s.n, n, 'no requests below the fold');
  assert.equal((await stats(page)).frames, f, 'no frames below the fold');
  await page.evaluate(() => window.__q.scrollIntoView());
  await step(page, s);
  assert.ok(s.n > n, 'requests resume once in view');
  await page.clock.runFor(500);
  await page.waitForFunction(f => window.LocalAIStreet.stats().frames > f, f, { timeout: 3000 });
});

for (const c of contexts) await c.close();
await browser.close();
if (failures.length) { console.error(`\n${failures.length} failed:\n` + failures.join('\n')); process.exit(1); }
console.log('\nall street engine checks passed');
