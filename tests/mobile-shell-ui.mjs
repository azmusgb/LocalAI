import './browser-target-guard.mjs';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';

const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const shots = process.env.MOBILE_SHELL_SHOTS || '';
if (shots) mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ headless: true });
const failures = [];
async function check(name, fn) {
  try { await fn(); console.log('PASS', name); } catch (error) { failures.push(`${name}: ${error.message}`); console.error('FAIL', name, error.message); }
}
const json = (r, body, status = 200) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const HOUR = 3600e3, NOW = Date.now();
let seq = 0;
const item = (kind, title, ageMs, status = 'completed') => {
  const n = ++seq;
  const badge = status === 'awaiting_approval' ? { label: 'Review', tone: 'attention' } : status === 'failed' ? { label: 'Failed', tone: 'bad' } : { label: 'Done', tone: 'good' };
  return { id: `run-${NOW - ageMs}-${n}`, type: kind, status, progress: 100, createdAt: new Date(NOW - ageMs).toISOString(), updatedAt: new Date(NOW - ageMs).toISOString(),
    card: { kind, icon: 'system', title, summary: `${kind} · ${n}`, badge, preview: null, action: { label: 'Open' }, approval: null } };
};
const recent = () => [item('chat', 'Plan the garden', 5 * 60e3), item('image', 'A red fox at dusk', 2 * HOUR), item('chat', 'Why is sqlite so fast', 3 * HOUR), item('agent', 'Summarise the inbox', 4 * HOUR), item('research', 'Heat pump prices', 5 * HOUR), item('automation', 'Nightly backup', 6 * HOUR)];
const needsRuns = () => [item('engineering', 'Fix the login bug', 10 * 60e3, 'awaiting_approval'), item('agent', 'Weekly report mission', 2 * HOUR, 'failed'), ...recent()];
const caps = () => ({ services: ['ollama', 'search', 'comfy', 'n8n'].map(name => ({ name, label: name, state: 'HEALTHY', required: true })), models: { defaultInstalled: true }, images: { available: true }, version: '1' });

const okStatus = () => ({ overall: 'HEALTHY', checkedAt: new Date().toISOString(), services: caps().services.map(x => ({ ...x, impact: 'Works.' })), certification: {} });
async function open(viewport, hash, { scheme = 'dark', runs = needsRuns, capabilities = caps, hub = null, status = null, capStatus = 200, text = false, inset = 0 } = {}) {
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport, colorScheme: scheme, isMobile: viewport.width < 760, hasTouch: viewport.width < 760 });
  await ctx.addInitScript(s => { try { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); } } catch {} }, { 'localai.firstRun.done': '1' });
  const page = await ctx.newPage();
  await ctx.route(u => u.pathname === '/api/approvals', r => json(r, { items: [] }));
  await ctx.route(u => u.pathname === '/api/home/hub-needs', r => json(r, { items: hub }));
  await ctx.route(u => u.pathname === '/api/capabilities', r => json(r, capabilities(), capStatus));
  await ctx.route(u => u.pathname === '/api/status', r => status ? status(r) : json(r, okStatus()));
  await ctx.route(u => u.pathname === '/api/runs', r => json(r, { items: runs(), summary: {} }));
  if (inset) { const cdp = await ctx.newCDPSession(page); await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: inset, bottom: 0, left: 0, right: 0 } }); }
  await page.goto(base + '/' + hash, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.showView === 'function' && window.LocalAIRouter && window.LocalAIHome && location.hash, null, { timeout: 8000 });
  await page.waitForSelector('#uxMobileNav', { state: 'attached', timeout: 8000 });
  if (text) await bigText(page);
  return page;
}
const phone = { width: 390, height: 844 };


// The text size a reader sets in the browser: html's font-size doubles, so rem (every kit token) follows.
const bigText = page => page.addStyleTag({ content: 'html{font-size:200%!important}' });
const areaViews = ['home', 'inbox', 'work', 'agents', 'projects', 'library', 'backlog', 'signals', 'architecture', 'system', 'status', 'tools'];

for (const scheme of ['light', 'dark']) for (const large of [false, true]) {
  await check(`phone ${scheme}${large ? ', text at 200%' : ''}: one local nav row under the global bar, no overlap, no clipped label`, async () => {
    const page = await open(phone, '#home', { scheme });
    if (large) await bigText(page);
    let stuck = 0;
    for (const view of areaViews) {
      await page.evaluate(v => window.showView(v), view);
      await page.waitForTimeout(250);
      for (const scrolled of [false, true]) {
        if (scrolled) { await page.evaluate(() => window.scrollTo(0, 1e6)); await page.waitForTimeout(150); }
        const at = `${view}${scrolled ? ' scrolled' : ''}`;
        const r = await page.evaluate(() => {
          const vis = e => e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0;
          const box = e => { const b = e.getBoundingClientRect(); return { top: b.top, bottom: b.bottom }; };
          const bar = document.getElementById('uxContextBar'), strip = document.getElementById('uxPageStrip');
          const levels = [...document.querySelectorAll('.ux-breadcrumb-home,.ux-context-sep,.ux-context-view')].filter(vis).length;
          const buttons = [...strip.querySelectorAll('button')], hasStrip = vis(strip);
          const unreachable = [], clipped = [];
          strip.style.scrollSnapType = 'none'; // a swipe snaps to a tab's start; reachability is about where the strip can scroll
          if (hasStrip) for (const b of buttons) {
            { const rg = document.createRange(); rg.selectNodeContents(b); const t = rg.getBoundingClientRect(), bb = b.getBoundingClientRect(); if (t.right > bb.right + 1 || t.left < bb.left - 1) clipped.push(b.textContent); }
            b.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'instant' });
            const sr = strip.getBoundingClientRect(), br = b.getBoundingClientRect();
            if (br.left < sr.left - 1 || br.right > sr.right + 1) unreachable.push(b.textContent);
          }
          const nav = document.getElementById('uxMobileNav'), spans = [...nav.querySelectorAll('button>span')];
          const navClipped = spans.filter(sp => sp.scrollWidth > sp.clientWidth + 1 || sp.getBoundingClientRect().right > sp.closest('button').getBoundingClientRect().right + 1 || sp.getBoundingClientRect().left < sp.closest('button').getBoundingClientRect().left - 1).map(sp => sp.textContent);
          const sr = spans.map(sp => sp.getBoundingClientRect()), navOverlap = sr.some((a, i) => sr.slice(i + 1).some(b => a.left < b.right - 0.5 && b.left < a.right - 0.5));
          const overflowX = document.documentElement.scrollWidth > innerWidth;
          return { bar: box(bar), strip: hasStrip ? box(strip) : null, levels, unreachable, clipped, navClipped, navOverlap, overflowX, n: buttons.length, sy: scrollY };
        });
        if (r.strip) assert.equal(r.levels, 0, `${at}: breadcrumb pieces still show next to the strip`);
        assert.equal(r.strip === null, ['system', 'status', 'tools'].includes(view), `${at}: strip shown only where the area has more than one page`);
        if (r.strip) assert.ok(r.strip.top >= r.bar.bottom - 0.5, `${at}: strip top ${r.strip.top} overlaps the header bottom ${r.bar.bottom}`);
        if (scrolled && r.sy > 60) stuck++;
        if (scrolled && r.strip && r.sy > 60) assert.ok(Math.abs(r.strip.top - r.bar.bottom) <= 1 && r.bar.top >= -1 && r.bar.top <= 1, `${at}: sticky header and strip stay stacked: ${JSON.stringify(r)}`);
        assert.deepEqual(r.unreachable, [], `${at}: strip items out of reach`);
        assert.deepEqual(r.clipped, [], `${at}: strip labels clipped`);
        assert.deepEqual(r.navClipped, [], `${at}: tab bar labels clipped`);
        assert.equal(r.navOverlap, false, `${at}: tab bar labels run together`);
        assert.equal(r.overflowX, false, `${at}: the page scrolls sideways`);
      }
    }
    assert.ok(stuck >= 1, 'at least one page was long enough to scroll the header into its stuck position');
    await page.context().close();
  });
}

await check('the open tab bar destination differs in background, icon weight, label weight and an edge bar, not colour alone', async () => {
  const page = await open(phone, '#home');
  const r = await page.evaluate(() => {
    const on = document.querySelector('#uxMobileNav [data-active="true"]'), off = document.querySelector('#uxMobileNav [data-active="false"]');
    const s = (e, sel, p) => getComputedStyle(sel ? e.querySelector(sel) : e)[p];
    return { bg: [s(on, 'b', 'backgroundColor'), s(off, 'b', 'backgroundColor')], icon: [s(on, '.icon', 'strokeWidth'), s(off, '.icon', 'strokeWidth')], weight: [s(on, null, 'fontWeight'), s(off, null, 'fontWeight')], bar: [s(on, null, 'borderTopColor'), s(off, null, 'borderTopColor')], current: on.getAttribute('aria-current') };
  });
  assert.notEqual(r.bg[0], r.bg[1], 'background');
  assert.ok(parseFloat(r.icon[0]) > parseFloat(r.icon[1]), 'icon weight');
  assert.ok(Number(r.weight[0]) > Number(r.weight[1]), 'label weight');
  assert.notEqual(r.bar[0], r.bar[1], 'edge bar'); assert.equal(r.bar[1], 'rgba(0, 0, 0, 0)', 'edge bar off');
  assert.equal(r.current, 'true');
  await page.context().close();
});

// (1) The on-screen keyboard. Chromium resizes the layout viewport when a keyboard opens (as Android Chrome does), which is
// what shrinking the viewport emulates. iOS Safari instead keeps the layout viewport and shrinks only visualViewport; that
// cannot be emulated here, Home's own dock (home.js dockToNav) is written for it and the tab bar is hidden while Home types.
for (const [view, sel] of [['#home', '#commandInput'], ['#ask', '#chatInput']]) {
  await check(`keyboard open on ${view}: the tab bar does not cover the focused field and the field stays on screen`, async () => {
    const page = await open(phone, view);
    await page.evaluate(s => window.scrollTo(0, 1e6), sel);
    await page.focus(sel);
    await page.setViewportSize({ width: 390, height: 420 });
    await page.waitForTimeout(400);
    await page.evaluate(s => document.querySelector(s).scrollIntoView({ block: 'center' }), sel);
    await page.waitForTimeout(200);
    const r = await page.evaluate(s => {
      const f = document.querySelector(s).getBoundingClientRect(), n = document.getElementById('uxMobileNav'), nb = getComputedStyle(n).display === 'none' ? null : n.getBoundingClientRect();
      const bar = document.getElementById('uxContextBar').getBoundingClientRect();
      const c = document.getElementById('homeComposer'), cb = c && getComputedStyle(c).display !== 'none' ? c.getBoundingClientRect() : null;
      return { f: { top: f.top, bottom: f.bottom }, navTop: nb ? nb.top : null, barBottom: bar.bottom, composerTop: cb ? cb.top : null, vh: innerHeight };
    }, sel);
    assert.ok(r.f.bottom <= r.vh + 0.5 && r.f.top >= -0.5, `field is off screen: ${JSON.stringify(r)}`);
    if (r.navTop !== null) assert.ok(r.f.bottom <= r.navTop + 0.5, `tab bar covers the field: ${JSON.stringify(r)}`);
    await page.context().close();
  });
}

// (2) Scrolling with a taller bar: 200% text and a notch (safe-area top inset). The strip must sit exactly under the bar.
for (const [label, opts] of [['normal', {}], ['text at 200%', { text: true }], ['safe-area top 47px', { inset: 47 }], ['text at 200% and safe-area top 47px', { text: true, inset: 47 }]]) {
  await check(`scrolling (${label}): the document scrolls; header and page strip stay stacked with no gap or overlap`, async () => {
    const page = await open(phone, '#library', opts);
    await page.waitForTimeout(400);
    const h = await page.evaluate(() => ({ doc: document.documentElement.scrollHeight, vh: innerHeight, strip: !!document.getElementById('uxPageStrip') && getComputedStyle(document.getElementById('uxPageStrip')).display !== 'none' }));
    assert.ok(h.strip, 'Library shows a page strip');
    await page.evaluate(() => document.querySelector('main').insertAdjacentHTML('beforeend', '<div id="tallPad" style="height:3000px"></div>'));
    for (const y of [0, 400, 1500]) {
      await page.evaluate(v => window.scrollTo(0, v), y);
      await page.waitForTimeout(150);
      const r = await page.evaluate(() => {
        const b = document.getElementById('uxContextBar').getBoundingClientRect(), s = document.getElementById('uxPageStrip').getBoundingClientRect();
        return { barTop: b.top, barBottom: b.bottom, stripTop: s.top, sy: scrollY };
      });
      if (y) assert.ok(r.sy > 0, 'the document scrolled, not an inner box');
      if (y) assert.ok(Math.abs(r.barTop) <= 0.5, `bar stays at the top at scroll ${y}: ${JSON.stringify(r)}`);
      assert.ok(Math.abs(r.stripTop - r.barBottom) <= 0.5, `strip sits ${r.stripTop - r.barBottom}px from the bar at scroll ${y}: ${JSON.stringify(r)}`);
    }
    await page.context().close();
  });
}

// (3) Selection: one tab, said four ways; hidden pages light the area that owns them.
await check('tab bar: tapping each area marks exactly one tab (aria-current and data-active) with non-colour cues', async () => {
  const page = await open(phone, '#home');
  const ids = await page.evaluate(() => window.LocalAIViews.DOMAINS.map(d => d.id));
  assert.equal(ids.length, 5);
  for (const id of ids) {
    await page.tap(`#uxMobileNav [data-domain="${id}"]`);
    await page.waitForTimeout(300);
    const r = await page.evaluate(() => {
      const tabs = [...document.querySelectorAll('#uxMobileNav [data-domain]')];
      const on = tabs.filter(t => t.dataset.active === 'true'), cur = tabs.filter(t => t.getAttribute('aria-current') === 'true');
      const off = tabs.find(t => t.dataset.active !== 'true'), g = (e, sel, p) => getComputedStyle(sel ? e.querySelector(sel) : e)[p];
      const e = on[0];
      return { on: on.map(t => t.dataset.domain), cur: cur.map(t => t.dataset.domain), n: tabs.length, domain: document.body.dataset.domain,
        cues: { bg: g(e, 'b', 'backgroundColor') !== g(off, 'b', 'backgroundColor'), icon: parseFloat(g(e, '.icon', 'strokeWidth')) > parseFloat(g(off, '.icon', 'strokeWidth')), weight: Number(g(e, null, 'fontWeight')) > Number(g(off, null, 'fontWeight')), edge: g(e, null, 'borderTopColor') !== g(off, null, 'borderTopColor') } };
    });
    assert.deepEqual(r.on, [id], `data-active after tapping ${id}`);
    assert.deepEqual(r.cur, [id], `aria-current after tapping ${id}`);
    assert.equal(r.n, 5);
    assert.deepEqual(r.cues, { bg: true, icon: true, weight: true, edge: true }, `non-colour cues for ${id}`);
  }
  await page.context().close();
});
for (const [hash, owner] of [['ask', 'home'], ['create', 'home'], ['runs', 'work'], ['spreadsheets', 'work']]) {
  await check(`tab bar: the hidden page ${hash} lights its owning area (${owner})`, async () => {
    const page = await open(phone, '#home');
    await page.evaluate(v => window.showView(v), hash);
    await page.waitForTimeout(400);
    const r = await page.evaluate(() => ({ on: [...document.querySelectorAll('#uxMobileNav [data-active="true"]')].map(t => t.dataset.domain), cur: [...document.querySelectorAll('#uxMobileNav [aria-current="true"]')].map(t => t.dataset.domain), view: document.body.dataset.view }));
    assert.deepEqual(r.on, [owner], JSON.stringify(r)); assert.deepEqual(r.cur, [owner], JSON.stringify(r));
    await page.context().close();
  });
}

// (4) Text enlargement on the tab bar.
await check('text at 200%: tab bar labels sit inside their column and the page does not scroll sideways', async () => {
  const page = await open(phone, '#home', { text: true });
  await page.waitForTimeout(300);
  const r = await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('#uxMobileNav button')];
    const cols = tabs.map(t => t.getBoundingClientRect()), out = [];
    tabs.forEach((t, i) => { const sp = t.querySelector('span'), rg = document.createRange(); rg.selectNodeContents(sp); const tr = rg.getBoundingClientRect(), c = cols[i];
      if (tr.left < c.left - 0.5 || tr.right > c.right + 0.5 || sp.scrollWidth > sp.clientWidth + 1) out.push(sp.textContent); });
    const overlap = cols.some((a, i) => cols.slice(i + 1).some(b => a.left < b.right - 0.5 && b.left < a.right - 0.5));
    return { out, overlap, overflowX: document.documentElement.scrollWidth > innerWidth, fs: getComputedStyle(tabs[0]).fontSize };
  });
  assert.deepEqual(r.out, [], JSON.stringify(r)); assert.equal(r.overlap, false); assert.equal(r.overflowX, false);
  await page.context().close();
});

// (5) Windows services down: each is named, none is empty or healthy, and the shell still renders.
const svc = (down, state = 'DOWN') => () => ({ services: [['ollama', 'Ollama'], ['comfy', 'ComfyUI'], ['gridcraft', 'GridCraft'], ['artcraft', 'ArtCraft']].map(([name, label]) => ({ name, label, state: name === down ? state : 'HEALTHY', required: true, impact: `${label} is not answering.` })), models: { defaultInstalled: true }, images: { available: true }, version: '1' });
for (const down of ['ollama', 'comfy', 'gridcraft', 'artcraft']) {
  const label = { ollama: 'Ollama', comfy: 'ComfyUI', gridcraft: 'GridCraft', artcraft: 'ArtCraft' }[down];
  await check(`${down} down: Home and Status name it as down; the shell still renders`, async () => {
    const stat = r => json(r, { overall: 'DOWN', checkedAt: new Date().toISOString(), services: svc(down)().services, certification: {} });
    const page = await open(phone, '#home', { capabilities: svc(down), status: stat });
    await page.waitForFunction(l => document.getElementById('home')?.innerText.includes(l + ' is down'), label, { timeout: 8000 }).catch(() => {});
    const home = await page.evaluate(() => document.getElementById('home').innerText);
    assert.match(home, new RegExp(`${label} is down`), `Home names ${label} as down`);
    assert.doesNotMatch(home, /Nothing needs you/i);
    await page.evaluate(() => window.showView('status')); await page.waitForTimeout(500);
    const rows = await page.evaluate(() => [...document.querySelectorAll('#serviceList li')].map(li => li.innerText.replace(/\s+/g, ' ')));
    const row = rows.find(x => x.includes(label));
    assert.ok(row && /Down/.test(row), `Status row for ${label}: ${JSON.stringify(rows)}`);
    assert.ok(rows.filter(x => /Healthy/.test(x)).length === 3, 'the other three read healthy');
    assert.ok(await page.locator('#uxMobileNav button').count() === 5 && await page.locator('#uxContextBar').isVisible(), 'shell renders');
    await page.context().close();
  });
}
await check('both service reads failing (502): Home and Status say the check failed, never ready or empty; the shell renders', async () => {
  const page = await open(phone, '#home', { capStatus: 502, capabilities: () => ({ error: 'bad gateway' }), status: r => json(r, { error: 'bad gateway' }, 502) });
  await page.waitForFunction(() => /Status unavailable/.test(document.getElementById('home')?.innerText || ''), null, { timeout: 15000 });
  const home = await page.evaluate(() => document.getElementById('home').innerText);
  assert.doesNotMatch(home, /Nothing needs you|Everything is ready/i);
  await page.evaluate(() => window.showView('status')); await page.waitForTimeout(600);
  const st = await page.evaluate(() => ({ summary: document.getElementById('statusSummary').textContent, err: document.querySelector('#serviceList .status-error')?.textContent || '', dot: document.getElementById('homeState').textContent }));
  assert.match(st.summary, /Couldn't check the services/); assert.match(st.err, /couldn't be read/); assert.equal(st.dot, 'Unavailable');
  assert.ok(await page.locator('#uxMobileNav button').count() === 5, 'shell renders');
  await page.context().close();
});

// (6) axe on the changed regions at phone width.
await check('axe: Home at 390 px, tab bar, header bar and page strip have no violations', async () => {
  const { addAxe } = await import('./axe-helper.mjs');
  const { fileURLToPath } = await import('node:url'); const { dirname, join } = await import('node:path');
  const page = await open(phone, '#library');
  await page.waitForTimeout(500);
  await addAxe(page, join(dirname(fileURLToPath(import.meta.url)), 'vendor', 'axe.min.js'));
  for (const v of ['library', 'home']) {
    await page.evaluate(x => window.showView(x), v); await page.waitForTimeout(500);
    const res = await page.evaluate(() => window.axe.run({ include: [['#uxMobileNav'], ['#uxContextBar'], ['#uxPageStrip']] }, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag22aa', 'best-practice'] } }));
    assert.deepEqual(res.violations.map(x => `${x.id}: ${x.nodes.map(n => n.target.join(' ')).join(', ')}`), [], `axe on ${v}`);
  }
  await page.context().close();
});

if (shots) for (const scheme of ['light', 'dark']) for (const [name, hash] of [['home', '#home'], ['work', '#work'], ['library', '#library']]) {
  const page = await open(phone, hash, { scheme });
  if (name === 'home') await page.waitForSelector('#homeNeedsYou .ui-need', { timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${shots}/${name}-390-${scheme}.png` });
  await page.context().close();
}
await browser.close();
if (failures.length) { console.error(`\n${failures.length} failed`); process.exit(1); }
