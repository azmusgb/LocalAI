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
// Every building at rest: nothing on the street moves (an online kiosk breathes, so it is not set up here).
const QUIET = {
  schema: 1,
  models: { loaded: [], queue: { active: 0, waiting: 0 }, busy: { total: 0, kinds: {} } },
  printer: { setUp: true, access: 'ok', state: 'idle', progress: null, minutesLeft: null, errorCode: null },
  sheets: { bridge: true, excel: true, inFlight: 0 },
  kiosk: { setUp: false, online: null, signIn: null, firmware: null },
  crews: null,
  street: { chat: src(), images: src(), missions: src(), garage: src(), sheets: src(), clock: src() }
};
const TITLES = ['Chat Café', 'Image Studio', 'Spreadsheets Office', 'Model Foundry', 'Workshop Garage', 'Kiosk Billboard'];
// The street grows building by building, so the checks never hard-code how many stand: standing(page, world) is the
// titles of the buildings the registered defs put on the street for a world (hidden ones left out), in street order,
// and inOrder(texts) checks the first six still stand among them in their order.
const standing = (page, world) => page.evaluate(w => window.LocalAIStreet.defs().filter(d => !d.state(w).hidden).map(d => d.chip(d.state(w)).title), world);
const inOrder = t => { let at = -1; for (const title of TITLES) { const i = t.findIndex((x, j) => j > at && x.startsWith(title)); assert.ok(i > at, `${title} stands after the one before: ${JSON.stringify(t)}`); at = i; } };
const chipOf = (t, title) => t.find(x => x.startsWith(title)) || '';

const contexts = [];
// A fresh page with the street's modules loaded and a strip mounted in a fixed box at the top (in view). window.__el is
// the mount element, window.__opened the ids onOpen got. setWorld(world) runs unless world is null.
// fixed: a local Date the page's clock reads (timers run in real time); at: a fake clock installed at that Date (timers move
// only with page.clock.runFor and in real time).
// full: a container that many px tall mounted in mode 'full' (window.__focus collects the ids onFocus got).
async function fresh({ viewport = { width: 1280, height: 800 }, dpr = 1, world = BUSY, reduced = false, clock = false, fixed = null, at = null, route = () => {}, full = 0 } = {}) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: dpr, serviceWorkers: 'block', reducedMotion: reduced ? 'reduce' : 'no-preference' });
  contexts.push(context);
  await context.addInitScript(() => { try { localStorage.setItem('localai.firstRun.done', '1'); } catch {} });
  const page = await context.newPage();
  page.errors = [];
  await page.route('**/api/world', route);
  if (clock) await page.clock.install();
  if (at) await page.clock.install({ time: at });
  if (fixed) await page.clock.setFixedTime(fixed);
  page.on('pageerror', e => page.errors.push(e.message));
  await page.goto(base + '/#status', { waitUntil: 'domcontentloaded' }); // off Home: Home mounts its own strip
  await page.waitForFunction(() => typeof window.LocalAIStreetLoad === 'function');
  await page.evaluate(async ([world, full]) => {
    await window.LocalAIStreetLoad();
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999' + (full ? ';height:' + full + 'px' : '');
    window.__el = document.body.appendChild(el); window.__opened = []; window.__focus = [];
    window.__street = window.LocalAIStreet.mount(el, { mode: full ? 'full' : 'strip', onOpen: id => window.__opened.push(id), onFocus: id => window.__focus.push(id) });
    if (world) window.LocalAIStreet.setWorld(world);
  }, [world, full]);
  if (clock) await page.clock.pauseAt(new Date(Date.now() + 1000));
  return page;
}
const chipTexts = page => page.evaluate(() => [...window.__el.querySelectorAll('.street-chip:not(.street-chip--stale)')].map(b => b.textContent));
const stats = page => page.evaluate(() => window.LocalAIStreet.stats());
// Timing checks must hold on a loaded machine (local CI runs every browser suite at once), so none counts a minimum of
// frames in a wall-clock window. rise(page, from, by) waits (up to 10 s) for the frame count to pass from + by;
// settle(page) waits until no frame has been drawn for 500 ms (up to 10 s) and returns the count.
async function rise(page, from, by, what) {
  try { await page.waitForFunction(([f, b]) => window.LocalAIStreet.stats().frames - f >= b, [from, by], { timeout: 10000 }); }
  catch { throw new Error(`${what}: frames rose by ${(await stats(page)).frames - from}, not ${by}`); }
}
async function settle(page) {
  let f = (await stats(page)).frames;
  for (let i = 0; i < 20; i++) { await page.waitForTimeout(500); const g = (await stats(page)).frames; if (g === f) return g; f = g; }
  throw new Error('the loop never stopped: ' + f);
}

await check('the strip stays hidden until the first world, and shows its canvas and chips after', async () => {
  const page = await fresh({ world: null });
  assert.equal(await page.evaluate(() => window.__el.querySelector('.street').hidden), true, 'hidden before a world');
  await page.evaluate(w => window.LocalAIStreet.setWorld(w), BUSY);
  const r = await page.evaluate(() => { const s = window.__el.querySelector('.street'); return { hidden: s.hidden, h: s.querySelector('.street__canvas').clientHeight, chips: !!s.querySelector('.street__chips') }; });
  assert.deepEqual(r, { hidden: false, h: 160, chips: true });
});

await check('a chip per building in street order with the right words', async () => {
  const page = await fresh();
  const t = await chipTexts(page), want = await standing(page, BUSY);
  assert.ok(want.length >= TITLES.length, JSON.stringify(want));
  assert.equal(t.length, want.length, `a chip per building: ${JSON.stringify(t)}`);
  want.forEach((title, i) => assert.ok(t[i].startsWith(title), `chip ${i} starts with ${title}: ${t[i]}`));
  inOrder(t);
  const f = t.findIndex(x => x.startsWith('Model Foundry'));
  assert.ok(t[f].includes('qwen3:4b-instruct-32k loaded · 2 waiting'), t[f]);
  const chip = await page.evaluate(f => { const b = window.__el.querySelectorAll('.street-chip')[f]; return { tag: b.tagName, type: b.type, label: b.getAttribute('aria-label'), busy: b.classList.contains('street-chip--busy'), desc: b.getAttribute('aria-description'), title: b.title }; }, f);
  assert.deepEqual(chip, { tag: 'BUTTON', type: 'button', label: 'Model Foundry: qwen3:4b-instruct-32k loaded · 2 waiting', busy: true, desc: 'Opens Agent World', title: 'Opens Agent World' });
  await page.evaluate(f => window.__el.querySelectorAll('.street-chip')[f].click(), f);
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
  assert.ok(chipOf(t, 'Model Foundry').includes(evil + ' loaded'), JSON.stringify(t));
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

// A def's stamp (the Clock Tower's hour) is part of its still's cache key only: a new stamp rebuilds the still but is not
// a change, so the camera stays put on a street that scrolls.
await check('a new stamp rebuilds a still without moving the camera', async () => {
  const page = await fresh({ viewport: { width: 390, height: 844 }, reduced: true });
  await page.evaluate(w => { window.__stamp = '3'; window.LocalAIStreet.register({ id: 'yard', width: 100, state: () => ({}), stillKey: () => 'same', stamp: () => window.__stamp, chip: () => ({ title: 'Y', detail: 'y', tone: 'quiet' }), drawStill() {}, drawLive() {}, animates: () => false }); window.LocalAIStreet.setWorld(w); window.__el.querySelector('.street').scrollLeft = 0; }, BUSY);
  await page.waitForTimeout(100);
  const at = () => page.evaluate(() => { const s = window.__el.querySelector('.street'); return { left: s.scrollLeft, fits: s.scrollWidth <= s.clientWidth, stills: window.LocalAIStreet.stats().stills }; });
  const a = await at();
  assert.equal(a.fits, false, 'the street scrolls');
  await page.evaluate(w => window.LocalAIStreet.setWorld(w), BUSY);
  assert.equal((await at()).stills, a.stills, 'the same stamp: no rebuild');
  await page.evaluate(w => { window.__stamp = '4'; window.LocalAIStreet.setWorld(w); }, BUSY);
  await page.waitForTimeout(400);
  const b = await at();
  assert.equal(b.stills, a.stills + 1, 'a new stamp: one rebuild');
  assert.equal(b.left, a.left, 'the camera did not move');
  assert.deepEqual(page.errors, []);
});

// Toggling the developer tools hides or shows the Claude Yard: a stillKey to or from 'hidden' is not a change, so the camera stays.
await check('a building appearing or disappearing (stillKey hidden) does not move the camera', async () => {
  const page = await fresh({ viewport: { width: 390, height: 844 }, reduced: true });
  const reg = () => page.evaluate(w => { window.__h = true; window.LocalAIStreet.register({ id: 'yard', width: 100, state: () => ({ hidden: window.__h }), stillKey: s => s.hidden ? 'hidden' : 'idle', chip: () => ({ title: 'Y', detail: 'y', tone: 'quiet' }), drawStill() {}, drawLive() {}, animates: () => false }); window.LocalAIStreet.setWorld(w); window.__el.querySelector('.street').scrollLeft = 0; }, BUSY);
  await reg(); await page.waitForTimeout(100);
  const left = () => page.evaluate(() => window.__el.querySelector('.street').scrollLeft);
  assert.equal(await left(), 0);
  await page.evaluate(w => { window.__h = false; window.LocalAIStreet.setWorld(w); }, BUSY);
  await page.waitForTimeout(400);
  assert.equal(await left(), 0, 'shown: the camera did not move');
  await page.evaluate(w => { window.__el.querySelector('.street').scrollLeft = 0; window.__h = true; window.LocalAIStreet.setWorld(w); }, BUSY);
  await page.waitForTimeout(400);
  assert.equal(await left(), 0, 'hidden: the camera did not move');
  assert.deepEqual(page.errors, []);
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
  // A wide desktop shows the whole street; at 1280 the street (each building in a slot at least 200 px wide) scrolls.
  const wide = await fresh({ viewport: { width: 2560, height: 1440 } });
  const [ws, wc] = await wide.evaluate(() => { const s = window.__el.querySelector('.street'); return [s.scrollWidth, s.clientWidth]; });
  assert.ok(ws <= wc, `fits at 2560: ${ws} <= ${wc}`);
  const page = await fresh();
  const [ns, nc] = await page.evaluate(() => { const s = window.__el.querySelector('.street'); return [s.scrollWidth, s.clientWidth]; });
  assert.ok(ns > nc, `scrolls at 1280: ${ns} > ${nc}`);
  const phone = await fresh({ viewport: { width: 390, height: 844 }, reduced: true });
  const left0 = await phone.evaluate(() => window.__el.querySelector('.street').scrollLeft);
  await phone.evaluate(w => window.LocalAIStreet.setWorld({ ...w, kiosk: { setUp: false } }), BUSY);
  await phone.waitForTimeout(100);
  const r = await phone.evaluate(() => { const s = window.__el.querySelector('.street'), k = [...s.querySelectorAll('.street-chip')].find(b => b.textContent.startsWith('Kiosk')); const a = s.getBoundingClientRect(), b = k.getBoundingClientRect(); return { left: s.scrollLeft, inView: b.left >= a.left - 1 && b.right <= a.right + 1 }; });
  assert.ok(r.left > left0 && r.inView, `the kiosk scrolled into view: ${JSON.stringify(r)}`);
  // Once the person scrolls, a change leaves the camera alone for a while.
  await phone.evaluate(() => { const s = window.__el.querySelector('.street'); s.dispatchEvent(new WheelEvent('wheel', { deltaY: -2000, shiftKey: true, bubbles: true, cancelable: true })); });
  await phone.waitForTimeout(100);
  const left1 = await phone.evaluate(() => window.__el.querySelector('.street').scrollLeft);
  assert.ok(left1 < r.left, `shift+wheel scrolled the street: ${left1}`);
  await phone.evaluate(w => window.LocalAIStreet.setWorld(w), BUSY);
  await phone.waitForTimeout(100);
  assert.equal(await phone.evaluate(() => window.__el.querySelector('.street').scrollLeft), left1, 'the camera stays where the person put it');
});

await check('a plain vertical wheel over a narrow street scrolls the page, not the street', async () => {
  const page = await fresh({ viewport: { width: 390, height: 844 }, reduced: true });
  const r = await page.evaluate(() => {
    const s = window.__el.querySelector('.street'), left = s.scrollLeft, out = [];
    for (const deltaY of [300, -300]) { const e = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true }); s.dispatchEvent(e); out.push(e.defaultPrevented); }
    return { wide: s.scrollWidth > s.clientWidth, same: s.scrollLeft === left, prevented: out };
  });
  assert.deepEqual(r, { wide: true, same: true, prevented: [false, false] });
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
    // The engine stands only the ids in its ORDER, so the broken def stands in for the Clock Tower (restored below).
    window.__clock = window.LocalAIStreet.defs().find(d => d.id === 'clock');
    window.LocalAIStreet.register({ id: 'clock', width: 100, state: () => ({}), chip: () => ({ title: 'Y', detail: 'y', tone: 'quiet' }), drawStill() {}, drawLive() { throw new Error('boom'); } });
    window.LocalAIStreet.setWorld(w);
    const s = window.__el.querySelector('.street'), y = [...s.querySelectorAll('.street-chip')].find(b => b.textContent === 'Yy');
    s.scrollLeft = parseFloat(y.style.left) - s.clientWidth / 2; // the broken one in view, so its drawLive runs
  }, BUSY);
  const f0 = (await stats(page)).frames;
  await rise(page, f0, 20, 'the loop runs on');
  const f1 = (await stats(page)).frames;
  const t = await chipTexts(page);
  assert.equal(t.length, (await standing(page, BUSY)).length); inOrder(t); assert.ok(t.includes('Yy'), 'the broken building keeps its chip');
  await page.waitForTimeout(300);
  assert.ok((await stats(page)).frames > f1, 'frames keep rising');
  const warns = await page.evaluate(() => window.__warns);
  assert.equal(warns.length, 1, JSON.stringify(warns)); assert.ok(warns[0].includes('clock'), warns[0]);
  await page.evaluate(w => { window.LocalAIStreet.register(window.__clock); window.LocalAIStreet.setWorld(w); }, BUSY);
  assert.ok((await chipTexts(page)).some(x => x.startsWith('Clock Tower')), 'the Clock Tower is back');
  assert.deepEqual(page.errors, []);
});

// The cap, measured on the page's fake clock (its requestAnimationFrame fires every 16 ms of fake time, so the count
// doesn't depend on machine load): 30 fps over 16 ms ticks is a frame every third tick, about 41 in 2 s; an uncapped loop
// would draw 125 and a 60 fps one 125. In real time, load only lowers the count, so there the cap is an upper bound.
await check('the loop holds to 30 fps', async () => {
  const page = await fresh({ clock: true });
  await page.waitForTimeout(300);
  const f0 = (await stats(page)).frames;
  await page.waitForTimeout(500);
  assert.equal((await stats(page)).frames, f0, 'no frames while the clock stands still');
  await page.clock.runFor(2000);
  const n = (await stats(page)).frames - f0;
  assert.ok(n >= 35 && n <= 61, `at most 30 fps, and the loop keeps up, in 2 s of page time: ${n}`);
  const real = await fresh(), r0 = (await stats(real)).frames;
  await real.waitForTimeout(2000);
  const m = (await stats(real)).frames - r0;
  assert.ok(m >= 1 && m <= 64, `no more than 30 fps in 2 s of real time: ${m}`);
});

await check('a quiet street draws once and stops; a busy one runs; quiet to busy starts it again', async () => {
  const page = await fresh({ world: QUIET });
  const f0 = await settle(page);
  assert.ok(f0 >= 1, 'a frame was drawn');
  await page.waitForTimeout(1000);
  assert.equal((await stats(page)).frames, f0, 'no frames while nothing moves');
  await page.evaluate(w => window.LocalAIStreet.setWorld(w), BUSY);
  await rise(page, f0, 15, 'a busy street runs again');
  await page.evaluate(w => window.LocalAIStreet.setWorld(w), QUIET);
  const f2 = await settle(page);
  await page.waitForTimeout(1000);
  assert.equal((await stats(page)).frames, f2, 'stops again once all is quiet');
  // One busy building is enough, and an online kiosk's glow counts.
  await page.evaluate(w => window.LocalAIStreet.setWorld({ ...w, kiosk: { setUp: true, online: true, signIn: true, firmware: '1' } }), QUIET);
  await rise(page, f2, 15, 'the online kiosk breathes');
  assert.deepEqual(page.errors, []);
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
  assert.equal(good.length, (await standing(page, BUSY)).length); inOrder(good);
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

await check('a request that hangs past 8 s is a failure: stale, and the next poll still runs', async () => {
  // Real time (no fake clock): the timeout is AbortSignal.timeout's, which a fake clock does not drive.
  let n = 0; const page = await fresh({ route: () => { n++; } }); // never answers
  await page.waitForTimeout(6000);
  assert.equal(await page.evaluate(() => !!window.__el.querySelector('.street.is-stale')), false, 'not stale before the timeout');
  await until(page, () => !!window.__el.querySelector('.street.is-stale'), 'the timeout to mark it stale');
  const r = await page.evaluate(() => [...window.__el.querySelectorAll('.street-chip--stale')].map(b => b.textContent));
  assert.deepEqual(r, [STALE]);
  for (let i = 0; i < 60 && n < 2; i++) await page.waitForTimeout(100);
  assert.ok(n >= 2, `the poller is not stuck busy: ${n} requests`);
});

await check('coming back on screen within 2 s of a poll waits out the gap', async () => {
  const s = stub(); const page = await fresh({ world: null, clock: true, route: s.route });
  await until(page, () => !window.__el.querySelector('.street').hidden, 'the first world');
  await step(page, s);
  const n = s.n;
  const vis = h => page.evaluate(h => { for (const k of ['hidden', 'visibilityState']) Object.defineProperty(document, k, { configurable: true, get: () => k === 'hidden' ? h : (h ? 'hidden' : 'visible') }); document.dispatchEvent(new Event('visibilitychange')); }, h);
  await vis(true); await vis(false);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(s.n, n, 'no request at once, the last was just now');
  await page.clock.runFor(2100);
  for (let i = 0; i < 100 && s.n === n; i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(s.n, n + 1, 'one request once the gap is up');
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

// A chip with something specific opens that run; the rest open Agent World. A hidden building leaves the street.
await check('a chip opens its building\'s run, else Agent World, and its hint says which', async () => {
  const w = { ...BUSY, street: { ...BUSY.street, chat: src({ needsYou: [{ id: 'r1', title: 'Ask', status: 'needs_you', startedAt: Date.now() }] }), images: src() } };
  const page = await fresh({ world: w });
  await page.evaluate(() => {
    window.__shown = null; window.__go = [];
    window.LocalAIRuns = { show: id => { window.__shown = id; } };
    window.LocalAIRouter = { go: h => window.__go.push(h) };
    window.__calls = [];
    const old = document.getElementById('homeStreetMount'); if (old) old.id = 'homeStreetMountOld';
    window.__home = document.body.appendChild(document.createElement('div')); window.__home.id = 'homeStreetMount';
    window.LocalAIStreet.mountHome();
    window.__m2 = window.LocalAIStreet.mount(window.__el.appendChild(document.createElement('div')), { mode: 'strip', onOpen: (id, item) => window.__calls.push([id, item && item.id]) });
  });
  await page.evaluate(w => window.LocalAIStreet.setWorld(w), w);
  const hints = await page.evaluate(() => { const h = window.__home.querySelectorAll('.street-chip'); return [h[0].title, h[0].getAttribute('aria-description'), h[1].title]; });
  assert.deepEqual(hints, ['Opens this run', 'Opens this run', 'Opens Agent World']);
  await page.evaluate(() => window.__home.querySelectorAll('.street-chip')[0].click());
  assert.equal(await page.evaluate(() => window.__shown), 'r1');
  await page.evaluate(() => window.__home.querySelectorAll('.street-chip')[1].click());
  assert.deepEqual(await page.evaluate(() => window.__go), ['#agents']);
  await page.evaluate(() => { const c = window.__el.querySelectorAll('.street')[1].querySelectorAll('.street-chip'); c[0].click(); c[1].click(); });
  assert.deepEqual(await page.evaluate(() => window.__calls), [['chat', 'r1'], ['images', null]]);
  // the hint follows the item as the world changes
  await page.evaluate(w => window.LocalAIStreet.setWorld(w), QUIET);
  assert.equal(await page.evaluate(() => window.__home.querySelectorAll('.street-chip')[0].title), 'Opens Agent World');
});

await check('a sheets chip with a needs-you item opens that run', async () => {
  const w = { ...QUIET, street: { ...QUIET.street, sheets: src({ needsYou: [{ id: 's9', title: 'Sheet', status: 'needs_you', startedAt: Date.now() }] }) } };
  const page = await fresh({ world: w });
  await page.evaluate(() => {
    window.__shown = null; window.__go = [];
    window.LocalAIRuns = { show: id => { window.__shown = id; } };
    window.LocalAIRouter = { go: h => window.__go.push(h) };
    const old = document.getElementById('homeStreetMount'); if (old) old.id = 'homeStreetMountOld';
    window.__home = document.body.appendChild(document.createElement('div')); window.__home.id = 'homeStreetMount';
    window.LocalAIStreet.mountHome();
  });
  await page.evaluate(w => window.LocalAIStreet.setWorld(w), w);
  const chip = () => page.evaluate(() => { const b = [...window.__home.querySelectorAll('.street-chip')].find(x => x.textContent.startsWith('Spreadsheets')); return { title: b.title, aria: b.getAttribute('aria-description') }; });
  assert.deepEqual(await chip(), { title: 'Opens this run', aria: 'Opens this run' });
  await page.evaluate(() => [...window.__home.querySelectorAll('.street-chip')].find(x => x.textContent.startsWith('Spreadsheets')).click());
  assert.equal(await page.evaluate(() => window.__shown), 's9');
  assert.deepEqual(await page.evaluate(() => window.__go), []);
  assert.deepEqual(page.errors, []);
});

await check('a hidden building has no chip, the next one moves left, and unhiding restores it', async () => {
  const page = await fresh();
  const lefts = () => page.evaluate(() => [...window.__el.querySelectorAll('.street-chip')].map(b => [b.textContent.slice(0, 6), Math.round(b.getBoundingClientRect().left)]));
  await page.evaluate(w => { window.__hide = false; window.LocalAIStreet.register({ id: 'images', width: 100, state: () => ({ hidden: window.__hide }), chip: () => ({ title: 'Hid', detail: 'x', tone: 'quiet' }), drawStill() {}, drawLive() {}, animates: () => false }); window.LocalAIStreet.setWorld(w); }, BUSY);
  const shown = await lefts(), n = (await standing(page, BUSY)).length;
  assert.equal(shown.length, n); assert.ok(shown.some(c => c[0].startsWith('Hid')));
  await page.evaluate(w => { window.__hide = true; window.LocalAIStreet.setWorld(w); }, BUSY);
  const hid = await lefts();
  assert.equal(hid.length, n - 1); assert.ok(!hid.some(c => c[0].startsWith('Hid')));
  const at = (l, t) => l.find(c => c[0].startsWith(t))[1];
  assert.ok(at(hid, 'Spread') < at(shown, 'Spread'), `moved left: ${at(hid, 'Spread')} < ${at(shown, 'Spread')}`);
  await page.evaluate(w => { window.__hide = false; window.LocalAIStreet.setWorld(w); }, BUSY);
  assert.deepEqual(await lefts(), shown);
  assert.deepEqual(page.errors, []);
});

// The Claude Yard: on the street only while the developer tools are on; it counts the sessions and never shows a title.
const CREWS = [{ id: 'k1', title: 'Fix the build', state: 'working', lastAction: 'Edit' }, { id: 'k2', title: 'Docs', state: 'working', lastAction: 'Read' }, { id: 'k3', title: 'Plan', state: 'waiting', lastAction: 'Ask' }];
const yardChip = page => page.evaluate(() => [...window.__el.querySelectorAll('.street-chip')].map(b => b.textContent).find(t => t.startsWith('Claude Yard')) || null);
await check('the Claude Yard is off the street while the developer tools are off, and on it once they are on', async () => {
  const page = await fresh({ world: null });
  await page.evaluate(w => { document.body.classList.add('dev-tools-off'); window.LocalAIStreet.setWorld(w); }, { ...BUSY, crews: CREWS });
  assert.equal(await yardChip(page), null, 'no yard chip');
  await page.evaluate(w => { document.body.classList.remove('dev-tools-off'); window.LocalAIStreet.setWorld(w); }, { ...BUSY, crews: CREWS });
  assert.equal(await yardChip(page), 'Claude Yard2 working · 1 waiting');
  assert.equal(await page.evaluate(() => { const b = [...window.__el.querySelectorAll('.street-chip')].pop(); b.click(); return [b.title, window.__opened.at(-1)]; }).then(r => r.join()), 'Opens Agent World,yard');
  await page.evaluate(w => { document.body.classList.add('dev-tools-off'); window.LocalAIStreet.setWorld(w); }, { ...BUSY, crews: CREWS });
  assert.equal(await yardChip(page), null, 'gone again');
  assert.deepEqual(page.errors, []);
});

await check("a session's title, markup or right-to-left, never reaches the page", async () => {
  const evil = '<img src=x onerror=window.__y=1>', rtl = '\u202Eשלום\u202C';
  const page = await fresh({ world: null });
  await page.evaluate(w => { document.body.classList.remove('dev-tools-off'); window.LocalAIStreet.setWorld(w); },
    { ...BUSY, crews: [{ id: 'e1', title: evil, state: 'working', lastAction: evil }, { id: 'e2', title: rtl, state: 'waiting', lastAction: rtl }] });
  await page.waitForTimeout(200);
  const t = await yardChip(page);
  assert.equal(t, 'Claude Yard1 working · 1 waiting');
  const all = await page.evaluate(() => window.__el.textContent + [...window.__el.querySelectorAll('[aria-label],[title]')].map(b => b.getAttribute('aria-label') + b.title).join());
  assert.ok(!all.includes(evil) && !all.includes(rtl) && !all.includes('שלום'), 'no title in the strip');
  assert.equal(await page.evaluate(() => window.__el.querySelector('img')), null);
  assert.equal(await page.evaluate(() => typeof window.__y), 'undefined');
});

// Traffic: a beacon on the façade of a building that needs you, a stalled car with its hazards on in front of one with a
// failure (each pulses 60 s per ask id, then stays steady), and a car that drives off the end of the street when a run
// finishes (only between two worlds the strip was on screen for; never under reduced motion).
const ask = (key, o) => ({ ...QUIET, street: { ...QUIET.street, [key]: src(o) } });
const RUN = ask('chat', { running: [job(1)] }), DONE = ask('chat', { recent: [{ ...job(1), status: 'completed' }] });
await check('a beacon pulses for 60 s on a building that needs you, then stands steady', async () => {
  const page = await fresh({ world: ask('chat', { needsYou: [job(7)] }), clock: true });
  await page.clock.runFor(1000);
  const s0 = await stats(page);
  assert.equal(s0.beacons, 1, 'one beacon');
  await page.clock.runFor(1000);
  assert.ok((await stats(page)).frames > s0.frames, 'it pulses');
  await page.clock.runFor(61000);
  const f = (await stats(page)).frames;
  await page.clock.runFor(2000);
  const s1 = await stats(page);
  assert.equal(s1.frames, f, 'steady after 60 s: no frames');
  assert.equal(s1.beacons, 1, 'still drawn');
  // A new ask on the same building pulses again; a failure there too parks a car with its hazards on.
  await page.evaluate(w => window.LocalAIStreet.setWorld(w), ask('chat', { needsYou: [job(8)], failedUnseen: [job(9)] }));
  await page.clock.runFor(1000);
  const s2 = await stats(page);
  assert.ok(s2.frames > f + 1, 'a new ask pulses again');
  assert.deepEqual([s2.beacons, s2.stalled], [1, 1]);
  assert.deepEqual(page.errors, []);
});

await check('a flood of asks shows one beacon and one stalled car per building', async () => {
  const many = n => Array.from({ length: 10 }, (_, i) => job(n + i));
  const street = Object.fromEntries(Object.keys(QUIET.street).map((k, i) => [k, src({ needsYou: many(i * 100), failedUnseen: many(i * 100 + 50) })]));
  const page = await fresh({ viewport: { width: 2560, height: 1440 }, world: { ...QUIET, street } });
  await page.evaluate(w => { window.__w = w; }, { ...QUIET, street });
  await page.waitForTimeout(300);
  const s = await stats(page), n = Object.keys(street).length;
  assert.deepEqual([s.beacons, s.stalled, s.cars], [n, n, 0]);
  // Each beacon hangs at its def's anchor (else width - 22, 200), on the façade below its chip, where the chip can't cover it.
  const r = await page.evaluate(at => {
    const box = window.__el.querySelector('.street'), top = box.getBoundingClientRect().top, z = box.querySelector('canvas').clientHeight / 360;
    return at.map(([id, x, y]) => {
      const d = window.LocalAIStreet.defs().find(d => d.id === id), want = d.beacon || { x: d.width - 22, y: 200 };
      const chip = [...box.querySelectorAll('.street-chip')].find(b => b.textContent.startsWith(d.chip(d.state(window.__w)).title));
      return { id, ok: x === want.x && y === want.y, clear: chip.getBoundingClientRect().bottom - top < (y - 34) * z };
    });
  }, s.beaconAt);
  assert.equal(r.length, n);
  for (const b of r) assert.deepEqual(b, { id: b.id, ok: true, clear: true });
  assert.deepEqual(page.errors, []);
});

await check('a run that finishes drives a car off the street in 4 s', async () => {
  const page = await fresh({ world: RUN });
  await page.waitForTimeout(200);
  assert.equal((await stats(page)).cars, 0);
  await page.evaluate(w => window.LocalAIStreet.setWorld(w), DONE);
  assert.equal((await stats(page)).cars, 1, 'a car pulls out');
  const f = (await stats(page)).frames;
  await page.waitForFunction(f => window.LocalAIStreet.stats().frames > f + 5, f, { timeout: 3000 }); // it moves
  await page.evaluate(w => window.LocalAIStreet.setWorld(w), DONE);
  assert.equal((await stats(page)).cars, 1, 'the same world again sends no second car');
  await page.waitForTimeout(4000);
  assert.equal((await stats(page)).cars, 0, 'gone after 4 s');
  // At most three at once.
  const run = ask('images', { running: [job(1), job(2), job(3)] }), r2 = { ...run, street: { ...run.street, chat: src({ running: [job(4), job(5)] }) } };
  await page.evaluate(w => window.LocalAIStreet.setWorld(w), r2);
  await page.evaluate(w => window.LocalAIStreet.setWorld(w), { ...QUIET, street: { ...QUIET.street, images: src({ recent: [1, 2, 3].map(i => ({ ...job(i), status: 'completed' })) }), chat: src({ recent: [4, 5].map(i => ({ ...job(i), status: 'completed' })) }) } });
  assert.equal((await stats(page)).cars, 3, 'three at most');
  // A failed or cancelled run sends no car.
  await page.waitForTimeout(4500);
  await page.evaluate(w => window.LocalAIStreet.setWorld(w), RUN);
  await page.evaluate(w => window.LocalAIStreet.setWorld(w), ask('chat', { recent: [{ ...job(1), status: 'failed' }] }));
  assert.equal((await stats(page)).cars, 0, 'no car for a failure');
  assert.deepEqual(page.errors, []);
});

await check('no burst of cars after the strip comes back: a world while hidden resets the baseline', async () => {
  const page = await fresh({ world: RUN });
  await page.evaluate(w => { window.__el.style.display = 'none'; window.LocalAIStreet.setWorld(w); }, DONE);
  await page.evaluate(() => { window.__el.style.display = ''; });
  await page.waitForTimeout(200);
  assert.equal((await stats(page)).cars, 0, 'finished while hidden');
  // Hidden for the first world and shown for the second: no car either.
  await page.evaluate(w => { window.__el.style.display = 'none'; window.LocalAIStreet.setWorld(w); }, RUN);
  await page.evaluate(w => { window.__el.style.display = ''; window.LocalAIStreet.setWorld(w); }, DONE);
  assert.equal((await stats(page)).cars, 0, 'hidden for the run');
  // Off screen counts as hidden.
  await page.evaluate(w => { window.__el.style.marginTop = '5000px'; window.LocalAIStreet.setWorld(w); }, RUN);
  await page.evaluate(w => window.LocalAIStreet.setWorld(w), DONE);
  assert.equal((await stats(page)).cars, 0, 'off screen');
  assert.deepEqual(page.errors, []);
});

await check('reduced motion: no cars, and the beacon and hazards are drawn steady', async () => {
  const page = await fresh({ world: RUN, reduced: true });
  await page.evaluate(w => window.LocalAIStreet.setWorld(w), { ...DONE, street: { ...DONE.street, chat: src({ ...DONE.street.chat, needsYou: [job(7)], failedUnseen: [job(8)] }) } });
  const s = await stats(page);
  assert.deepEqual([s.cars, s.beacons, s.stalled], [0, 1, 1]);
  await page.waitForTimeout(500);
  assert.equal((await stats(page)).frames, s.frames, 'no frames: steady');
  assert.deepEqual(page.errors, []);
});

await check('a hidden building has no beacon or stalled car', async () => {
  const page = await fresh({ world: null });
  await page.evaluate(w => { window.LocalAIStreet.register({ ...window.LocalAIStreet.defs().find(d => d.id === 'clock'), state: () => ({ hidden: true, needsYou: 1, failed: 1, first: { id: 'x' } }) }); window.LocalAIStreet.setWorld(w); }, QUIET);
  await page.waitForTimeout(200);
  const s = await stats(page);
  assert.deepEqual([s.beacons, s.stalled], [0, 0]);
});

// Night (street/night.js): 19:00 to 07:00 local time, one shared timer checks once a minute; the street darkens, the sky
// has stars, and lit buildings glow onto the wet road.
const local = (h, m, s = 0) => new Date(2026, 9, 28, h, m, s);
// The canvas's mean colour (r + g + b) over a CSS-pixel box.
const lum = (page, x, y, w = 4, h = 4) => page.evaluate(([x, y, w, h]) => { const cv = window.__el.querySelector('canvas'), k = cv.width / cv.clientWidth, d = cv.getContext('2d').getImageData(Math.round(x * k), Math.round(y * k), Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))).data; let t = 0; for (let i = 0; i < d.length; i += 4) t += d[i] + d[i + 1] + d[i + 2]; return t / (d.length / 4); }, [x, y, w, h]);

await check('night falls at 19:00: every still rebuilds once and the sky darkens', async () => {
  const page = await fresh({ world: QUIET, at: local(18, 59, 30) });
  await page.waitForTimeout(300);
  const a = await stats(page), sky0 = await lum(page, 8, 8), n = (await standing(page, QUIET)).length;
  assert.equal(a.night, false, 'day at 18:59:30');
  await page.clock.runFor(60000); await page.waitForTimeout(300);
  const b = await stats(page), sky1 = await lum(page, 8, 8);
  assert.equal(b.night, true, 'night at 19:00:30');
  assert.equal(b.stills - a.stills, n, `each still once: ${b.stills - a.stills} for ${n} buildings`);
  assert.ok(sky1 < sky0 - 100, `the sky darkens: ${sky0} -> ${sky1}`);
  await page.clock.runFor(60000); await page.waitForTimeout(200);
  assert.equal((await stats(page)).stills, b.stills, 'nothing more a minute later');
  assert.deepEqual(page.errors, []);
});

// stats().night is what the street draws (the mount's night), not the clock's; a page coming back to the front checks
// the clock at once, so a tab left in the background overnight doesn't wait up to a minute.
await check("stats().night is the street's own; coming back visible rechecks the clock at once", async () => {
  const page = await fresh({ world: QUIET, at: local(18, 59, 30) });
  await page.waitForTimeout(300);
  const a = await stats(page);
  assert.equal(a.night, false, 'day at 18:59:30');
  await page.clock.setSystemTime(local(19, 0, 10)); // the clock moves on; the minute timer hasn't fired
  assert.equal(await page.evaluate(() => window.LocalAIStreetNight.isNight()), true, 'the clock says night');
  assert.equal((await stats(page)).night, false, 'the street still draws day');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForTimeout(300);
  const b = await stats(page);
  assert.equal(b.night, true, 'night on coming back');
  assert.equal(b.stills - a.stills, (await standing(page, QUIET)).length, 'each still rebuilt once');
  assert.deepEqual(page.errors, []);
});

await check('a quiet street at night draws nothing per frame', async () => {
  const page = await fresh({ world: QUIET, fixed: local(21, 0) });
  await page.waitForTimeout(400);
  assert.equal((await stats(page)).night, true);
  const f = await settle(page), px = await page.evaluate(() => window.__el.querySelector('canvas').toDataURL());
  await page.waitForTimeout(1000);
  assert.equal((await stats(page)).frames, f, 'no frames');
  assert.equal(await page.evaluate(() => window.__el.querySelector('canvas').toDataURL()), px, 'the same picture');
  assert.deepEqual(page.errors, []);
});

await check("a busy window's glow lights the road under it at night", async () => {
  const road = async page => {
    await page.waitForTimeout(400);
    // Chat Café's window is centred 40 units left of the building's middle (its chip's middle); the road is y 327-360.
    return page.evaluate(() => { const cv = window.__el.querySelector('canvas'), b = [...window.__el.querySelectorAll('.street-chip')].find(x => x.textContent.startsWith('Chat Café')).getBoundingClientRect(), z = cv.clientHeight / 360;
      return { x: b.left + b.width / 2 - cv.getBoundingClientRect().left - 40 * z, y: 334 * z, h: 20 * z }; });
  };
  const day = await fresh({ fixed: local(12, 0) }), night = await fresh({ fixed: local(21, 0) });
  const p = await road(day), q = await road(night);
  const d = await lum(day, p.x - 4, p.y, 8, p.h), n = await lum(night, q.x - 4, q.y, 8, q.h);
  assert.ok(n > d + 20, `the road under the lit window is brighter at night: day ${d}, night ${n}`);
  // And a quiet building's road stays darker at night than by day.
  const qd = await fresh({ world: QUIET, fixed: local(12, 0) }), qn = await fresh({ world: QUIET, fixed: local(21, 0) });
  const r = await road(qd), s = await road(qn);
  assert.ok(await lum(qn, s.x - 4, s.y, 8, s.h) < await lum(qd, r.x - 4, r.y, 8, r.h), 'quiet: darker at night');
  assert.deepEqual([day.errors, night.errors], [[], []]);
});

// The full-page street (mode 'full'): as tall as its container, zoom = height / 360 (0.8 to 2), and focus(id).
// centreOff(page, id): how far building id's centre (its chip's) is from the box's centre, in CSS px.
const centreOff = (page, id) => page.evaluate(id => { const s = window.__el.querySelector('.street'), d = window.LocalAIStreet.defs().find(x => x.id === id), t = d.chip(d.state(window.__w || {})).title;
  const b = [...s.querySelectorAll('.street-chip')].find(x => x.textContent.startsWith(t)).getBoundingClientRect(), a = s.getBoundingClientRect(); return Math.abs(b.left + b.width / 2 - (a.left + a.width / 2)); }, id);
// centred(page, id): waits (up to 10 s: a smooth scroll can start late on a loaded machine) for building id to be centred
// within 4 px, then for the scroll to hold still for 300 ms; returns how far off it ended.
async function centred(page, id) {
  for (let i = 0; i < 50 && await centreOff(page, id) >= 4; i++) await page.waitForTimeout(200);
  let l = -1;
  for (let i = 0; i < 30; i++) { const m = await page.evaluate(() => window.__el.querySelector('.street').scrollLeft); if (m === l) break; l = m; await page.waitForTimeout(300); }
  return centreOff(page, id);
}

await check('full mode: as tall as its container, zoom = height / 360', async () => {
  const page = await fresh({ full: 480 });
  const r = await page.evaluate(() => { const s = window.__el.querySelector('.street'), c = s.querySelector('canvas'), d = window.LocalAIStreet.defs().find(x => x.id === 'foundry');
    const b = [...s.querySelectorAll('.street-chip')].find(x => x.textContent.startsWith('Model Foundry'));
    return { h: c.clientHeight, ch: c.height, zoom: (parseFloat(b.style.bottom) - 4) / (360 - (d.roof || 120)) }; });
  assert.equal(r.h, 480); assert.equal(r.ch, 480);
  assert.ok(Math.abs(r.zoom - 480 / 360) < 0.01, `zoom ${r.zoom}`);
  const low = await fresh({ full: 200 });
  assert.equal(await low.evaluate(() => window.__el.querySelector('canvas').clientHeight), 300, 'at least 300 px tall');
  assert.deepEqual([page.errors, low.errors], [[], []]);
});

await check('focus centres a building and marks it; refocusing redraws no still', async () => {
  const page = await fresh({ full: 480 });
  await page.evaluate(w => { window.__w = w; }, BUSY);
  await page.evaluate(() => window.__street.focus('foundry'));
  const off = await centred(page, 'foundry');
  assert.ok(off < 4, `centred: ${off}`);
  assert.equal(await page.evaluate(() => window.__street.focused()), 'foundry');
  const s0 = (await stats(page)).stills;
  await page.evaluate(() => window.__street.focus('foundry'));
  await centred(page, 'foundry');
  assert.equal((await stats(page)).stills, s0, 'no still redrawn');
  await page.evaluate(() => window.__street.focus(null));
  assert.equal(await page.evaluate(() => window.__street.focused()), null);
  assert.deepEqual(await page.evaluate(() => window.__focus), [], 'onFocus is not called for a programmatic focus');
  assert.deepEqual(page.errors, []);
});

await check('reduced motion: focus is instant', async () => {
  const page = await fresh({ full: 480, reduced: true });
  await page.evaluate(w => { window.__w = w; }, BUSY);
  const off = await page.evaluate(() => { window.__street.focus('foundry'); const s = window.__el.querySelector('.street'), b = [...s.querySelectorAll('.street-chip')].find(x => x.textContent.startsWith('Model Foundry')).getBoundingClientRect(), a = s.getBoundingClientRect(); return Math.abs(b.left + b.width / 2 - (a.left + a.width / 2)); });
  assert.ok(off < 4, `centred at once: ${off}`);
  // A focus before the first world is kept: the street opens centred on it.
  const early = await fresh({ full: 480, reduced: true, world: null });
  await early.evaluate(w => { window.__w = w; window.__street.focus('foundry'); window.LocalAIStreet.setWorld(w); }, BUSY);
  const o2 = await centreOff(early, 'foundry');
  assert.ok(o2 < 4, `opens on the focus: ${o2}`);
  assert.equal(await early.evaluate(() => window.__street.focused()), 'foundry');
});

await check('a phone snaps one building at a time, and a swipe that settles on the next one calls onFocus', async () => {
  const page = await fresh({ viewport: { width: 390, height: 844 }, full: 520 });
  await page.evaluate(w => { window.__w = w; }, BUSY);
  const r = await page.evaluate(() => { const s = window.__el.querySelector('.street'); return { snap: getComputedStyle(s).scrollSnapType, w: s.clientWidth }; });
  assert.ok(r.snap.includes('x'), r.snap);
  await page.evaluate(() => window.__street.focus('images'));
  assert.ok(await centred(page, 'images') < 4, 'images centred');
  const next = await page.evaluate(w => { const ids = window.LocalAIStreet.defs().filter(d => !d.state(w).hidden).map(d => d.id); return ids[ids.indexOf('images') + 1]; }, BUSY);
  const box = await page.locator('.street').last().boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(r.w, 0);
  const off = await centred(page, next);
  assert.ok(off < 4, `${next} centred: ${off}`);
  await page.waitForTimeout(300);
  assert.deepEqual(await page.evaluate(() => window.__focus), [next]);
  assert.equal(await page.evaluate(() => window.__street.focused()), next);
  assert.deepEqual(page.errors, []);
});

await check('a quiet full street with a focus draws nothing per frame, and the rest of the street is dimmed', async () => {
  const page = await fresh({ full: 480, world: QUIET, fixed: local(12, 0) });
  await page.evaluate(w => { window.__w = w; }, QUIET);
  await settle(page);
  const before = await lum(page, 10, 10);
  await page.evaluate(() => window.__street.focus('foundry'));
  await centred(page, 'foundry');
  const f = await settle(page), px = await page.evaluate(() => window.__el.querySelector('canvas').toDataURL());
  await page.waitForTimeout(1000);
  assert.equal((await stats(page)).frames, f, 'no frames');
  assert.equal(await page.evaluate(() => window.__el.querySelector('canvas').toDataURL()), px, 'the same picture');
  const after = await lum(page, 10, 10);
  assert.ok(after < before * 0.9 && after > before * 0.75, `the sky away from the focus is dimmed 15%: ${before} -> ${after}`);
  assert.deepEqual(page.errors, []);
});

for (const c of contexts) await c.close();
await browser.close();
if (failures.length) { console.error(`\n${failures.length} failed:\n` + failures.join('\n')); process.exit(1); }
console.log('\nall street engine checks passed');
