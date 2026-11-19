// axe-core on every page in view-registry.js, at 1440 px and on an iPhone 14, with the dark and the light colour
// scheme (Local AI is dark only, so light must look the same to axe), on a server seeded with real records (projects,
// chats, sources, memory, automations, alerts, approvals, ideas, Claude board findings) and with missions in Agent World
// (one running, one done with results). Also the run view, Agent World's ⋯ menu and start sheet, Home's mode sheet and
// the ⌘K palette. Fails on:
//  - any serious or critical axe violation not in ALLOW below;
//  - on the iPhone, any control you can tap with a hit area under 44 × 44 px (found by hit-testing, so padding and
//    invisible ::before hit areas count);
//  - a control named only by a symbol (×, −, ▶), which axe accepts as a name;
//  - at 1440, a Tab stop with no visible focus ring (Tab once around every page).
// Report mode: AXE_REPORT=<file> writes every violation (all impacts) by rule, plus the small targets, and never fails.
// AXE_ONLY=home,agents, AXE_DEVICE=1440 and AXE_SCHEME=dark narrow a run while working on a fix.
import './browser-target-guard.mjs';
import { chromium, devices } from 'playwright';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { addAxe } from './axe-helper.mjs';

const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const REPORT = process.env.AXE_REPORT || '';
const axePath = join(dirname(fileURLToPath(import.meta.url)), 'vendor', 'axe.min.js');
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

// What axe may report because it cannot comply: { rule, match (a CSS selector the failing node matches), why }. Only for
// content Local AI does not draw itself (a third-party embed) or that has no DOM (a <canvas>), each with its reason.
// Empty on 2026-10-19: the Agent World city is a canvas, but axe does not look inside one, and everything drawn over it
// (zoom, Follow, the tooltip, the replay bar) is DOM that complies. Its text equivalent is the crew list (#awcRoster)
// and the crew count (#awCrewSummary, which the canvas points at with aria-describedby).
const ALLOW = [];
// Tap targets under 44 px that are fine: WCAG's inline exception (a link inside a sentence) and controls whose size the
// platform draws (range thumbs).
const TARGET_SKIP = 'input[type=range],input[type=hidden],.visually-hidden,[inert] *,[aria-hidden=true] *';

const iso = ago => new Date(Date.now() - ago * 1000).toISOString();
async function post(path, body) {
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw Error(`${path}: ${r.status} ${await r.text()}`);
  return r.json();
}
// Suites share one server: what Home would ask about (the pending approval) is decided again at the end.
const seeded = {};
async function seed() {
  const p = await post('/api/projects/create', { name: 'Kitchen remodel', description: 'Quotes, measurements and the plan.' });
  const projectId = p.item.id;
  await post('/api/projects/create', { name: 'Garden', description: 'What to plant and when.' });
  await post('/api/conversations/save', { projectId, title: 'Countertop options', messages: [{ role: 'user', content: 'Which countertop is easiest to keep clean?' }, { role: 'assistant', content: 'Quartz: it does not need sealing.' }] });
  await post('/api/knowledge/import', { projectId, name: 'Measurements.txt', content: 'Wall A: 3.2 m. Wall B: 2.4 m. Window at 1.1 m.' });
  await post('/api/memory/add', { projectId, text: 'The budget is 18,000 dollars.', category: 'fact', pinned: true });
  await post('/api/memory/add', { projectId, text: 'Prefers matte finishes.', category: 'preference' });
  await post('/api/automations/create', { name: 'Morning check', kind: 'health', schedule: 'daily' });
  await post('/api/automations/create', { name: 'Weekly summary', kind: 'prompt', prompt: 'Summarise the week.', schedule: 'manual' });
  await post('/api/notifications/seed', {});
  seeded.approval = (await post('/api/approvals/create', { title: 'Write a file in the workspace', detail: 'notes/plan.md', risk: 'low' })).item.id;
  await post('/api/improve/idea', { text: 'Make the Library search remember the last filter' });
  const cats = ['ux', 'bug', 'a11y', 'idea'], sevs = ['high', 'medium', 'low'];
  await post('/api/claude/findings', { sessionId: 'axe-seed', findings: cats.flatMap((c, i) => sevs.map((s, j) => ({ id: `axe-${c}-${s}`, title: `Finding ${c} ${s}`, category: c, severity: s, area: 'ui', summary: 'Something to look at.', status: (i + j) % 3 ? 'proposed' : 'fixed' }))) });
  await post('/api/claude/events', { sessionId: 'axe-seed', sessionTitle: 'Accessibility pass', cwd: '/tmp', sessionStatus: 'active', events: Array.from({ length: 12 }, (_, i) => ({ kind: i % 4 ? 'action' : 'phase', title: `Step ${i}`, detail: 'Ran a command.', status: 'done', tool: 'Bash' })) });
}

// Missions are model runs, so they are stubbed: one running (workers in every state, a story), one done with results.
const w = (id, name, state, extra = {}) => ({ id, name, state, model: 'test-model', dependsOn: id === 'router' ? [] : ['router'], reason: name, ...extra });
const RUNNING = { id: 'mission-axe-1', goal: 'Look over the phone screens for anything confusing', projectId: '', status: 'running', createdAt: iso(300), updatedAt: iso(5),
  workers: [w('router', 'Mission Router', 'complete'), w('ux_analyst', 'UX Analyst', 'running'), w('code_analyst', 'Code Analyst', 'pending'), w('synthesis', 'Coordinator', 'pending')],
  timeline: [{ at: iso(300), type: 'mission-start' }, { at: iso(290), type: 'dispatch', agentId: 'ux_analyst' }], results: [] };
const DONE = { ...RUNNING, id: 'mission-axe-0', status: 'complete', goal: 'Plan the kitchen order', createdAt: iso(7200), updatedAt: iso(6000), answer: 'Order the cabinets first; the counters need their measurements.',
  workers: RUNNING.workers.map(x => ({ ...x, state: 'complete' })), results: [{ agentId: 'ux_analyst', agentName: 'UX Analyst', status: 'complete', answer: 'Three things to fix.', evidenceRecords: [{ title: 'Cabinet guide', url: 'https://example.com/guide' }] }] };
const card = (kind, title, label, tone) => ({ kind, icon: kind, title, summary: 'A short summary.', badge: { label, tone }, preview: null, action: { label: 'Open' }, approval: null });
const RUNS = [
  { id: 'run-axe-m', type: 'agent', status: 'running', progress: 25, threadId: 'run-axe-m', title: RUNNING.goal, createdAt: iso(300), updatedAt: iso(5), input: { goal: RUNNING.goal }, meta: { missionId: RUNNING.id }, output: null, artifactIds: [], card: card('agent', RUNNING.goal, 'Working', 'accent') },
  { id: 'run-axe-c', type: 'chat', status: 'complete', progress: 100, threadId: 'run-axe-c', title: 'Countertop options', createdAt: iso(3600), updatedAt: iso(3500), input: { prompt: 'Which countertop?' }, meta: {}, output: { text: 'Quartz.' }, artifactIds: [], card: card('chat', 'Countertop options', 'Done', 'good') },
  { id: 'run-axe-f', type: 'image', status: 'failed', progress: 0, threadId: 'run-axe-f', title: 'A kitchen at dusk', createdAt: iso(9000), updatedAt: iso(8990), input: { prompt: 'A kitchen at dusk' }, meta: {}, output: null, error: 'The image engine is not running.', artifactIds: [], card: card('image', 'A kitchen at dusk', 'Failed', 'bad') }
];

const browser = await chromium.launch({ headless: true });
async function open(device, colorScheme) {
  const { defaultBrowserType, ...opts } = device; // Chromium runs every device here
  const ctx = await browser.newContext({ ...opts, colorScheme, serviceWorkers: 'block' });
  await ctx.addInitScript(() => { try { localStorage.setItem('localai.firstRun.done', '1'); localStorage.setItem('localai.devTools', '1'); } catch {} });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  const json = (r, body, status = 200) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route(u => u.pathname === '/api/agents/missions', r => json(r, { items: [RUNNING, DONE] }));
  await page.route(u => u.pathname === '/api/agents/mission', r => { const id = new URL(r.request().url()).searchParams.get('id'); const m = [RUNNING, DONE].find(x => x.id === id); m ? json(r, { mission: m }) : json(r, { error: 'Mission not found' }, 404); });
  await page.route(u => u.pathname === '/api/agents/missions/events', r => r.fulfill({ status: 204, body: '' }));
  await page.route(u => u.pathname === '/api/runs', r => { const id = new URL(r.request().url()).searchParams.get('id'); if (id) { const it = RUNS.find(x => x.id === id); return it ? json(r, { item: it }) : json(r, { error: 'Run not found' }, 404); } json(r, { items: RUNS, summary: {} }); });
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.showView === 'function' && window.LocalAIViews);
  return page;
}

async function axe(page) {
  await addAxe(page, axePath);
  return page.evaluate(tags => window.axe.run(document, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] })
    .then(r => r.violations.map(v => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map(n => ({ target: n.target.join(' '), allowed: false, summary: n.failureSummary?.split('\n').slice(1, 2).join('') || '' })) }))), TAGS);
}
// Mark allowed nodes (the selector check runs in the page, so `match` can use any CSS).
async function markAllowed(page, violations) {
  for (const v of violations) for (const n of v.nodes) {
    const a = ALLOW.find(x => x.rule === v.id);
    if (a) n.allowed = await page.evaluate(([t, m]) => { try { return !!document.querySelector(t)?.matches(m); } catch { return false; } }, [n.target, a.match]);
  }
  return violations;
}

// Hit areas: from the middle of each visible control, walk out along both axes while hit-testing still lands on it.
async function smallTargets(page) {
  return page.evaluate(skip => {
    const sel = 'a[href],button,input,select,textarea,summary,[role=button],[role=tab],[role=link],[role=menuitem],[role=menuitemcheckbox],[role=radio],[role=checkbox],[role=switch],[role=option],[tabindex]:not([tabindex="-1"])';
    const out = [];
    const hits = (el, x, y) => { const h = document.elementFromPoint(x, y); return !!h && (h === el || el.contains(h) || h.closest('label')?.control === el); };
    const inline = el => el.tagName === 'A' && getComputedStyle(el).display === 'inline' && (el.parentElement?.textContent || '').trim().length > (el.textContent || '').trim().length + 2;
    for (const el of document.querySelectorAll(sel)) {
      if (el.matches(skip) || el.disabled || el.closest('[hidden],[inert],[aria-hidden=true],.visually-hidden') || inline(el)) continue;
      const r0 = el.getBoundingClientRect(); if (!r0.width || !r0.height || getComputedStyle(el).visibility === 'hidden') continue;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight || !hits(el, cx, cy)) continue; // covered: not tappable here
      const reach = (dx, dy) => { let d = 0; while (d < 44 && hits(el, cx + dx * (d + 1), cy + dy * (d + 1))) d++; return d; };
      const wide = reach(-1, 0) + reach(1, 0) + 1, tall = reach(0, -1) + reach(0, 1) + 1;
      // Hit-testing samples whole pixels from a fractional middle, so an exact 44 px box can read 43.
      if (wide < 43 || tall < 43) out.push({ target: el.id ? '#' + el.id : el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''), name: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30), size: `${wide}x${tall}` });
    }
    scrollTo(0, 0);
    return out;
  }, TARGET_SKIP);
}

// A control whose only text is a symbol (×, −, ▶, ⋯, ☆) needs a name in words: axe accepts "×" as a name.
async function symbolNames(page) {
  return page.evaluate(() => [...document.querySelectorAll('button,a[href],[role=button],summary')].filter(el => {
    if (el.closest('[hidden],[aria-hidden=true]') || !el.getClientRects().length) return false;
    if (el.getAttribute('aria-label')?.trim() || el.getAttribute('aria-labelledby') || el.getAttribute('title')?.trim()) return false;
    const vis = [...el.childNodes].map(n => n.nodeType === 3 ? n.textContent : n.matches?.('.visually-hidden,[aria-hidden=true]') ? (n.matches('.visually-hidden') ? n.textContent : '') : n.textContent).join('');
    return !/[\p{L}\p{N}]/u.test(vis) && !el.querySelector('img[alt]:not([alt=""])');
  }).map(el => (el.id ? '#' + el.id : el.tagName.toLowerCase() + '.' + String(el.className).trim().split(/\s+/).join('.')) + ` "${el.textContent.trim().slice(0, 8)}"`));
}

// Tab through the page: every stop must look different focused than blurred (its outline, shadow, border or background,
// or those of its ::before/::after, parent or siblings, for rings drawn around a wrapper).
async function focusMisses(page, stops = 200) {
  await page.evaluate(() => { document.activeElement?.blur?.(); scrollTo(0, 0); });
  const seen = new Set(), miss = [];
  let first = null;
  for (let i = 0; i < stops; i++) {
    await page.keyboard.press('Tab');
    const r = await page.evaluate(() => {
      const el = document.activeElement; if (!el || el === document.body) return null;
      window.__axeN ??= new WeakMap(); if (!window.__axeN.has(el)) window.__axeN.set(el, window.__axeC = (window.__axeC || 0) + 1);
      const name = el.id ? '#' + el.id : el.tagName.toLowerCase() + '.' + String(el.className).trim().split(/\s+/).join('.') + ':' + (el.textContent || '').trim().slice(0, 16);
      const key = name + '@' + window.__axeN.get(el);
      if (el.tagName === 'CANVAS' || el.tagName === 'IFRAME') return { key, ok: true };
      const props = ['outline-style', 'outline-width', 'outline-color', 'box-shadow', 'border-color', 'background-color', 'text-decoration-line'];
      const look = () => [el, el.parentElement, ...(el.parentElement ? [...el.parentElement.children] : [])].flatMap(n => [null, '::before', '::after'].map(p => { const s = getComputedStyle(n, p); return props.map(k => s.getPropertyValue(k)).join('|'); })).join('#');
      const on = look(); el.blur(); const off = look(); el.focus({ preventScroll: true });
      return { key, ok: on !== off };
    });
    if (!r) continue; // past the last stop: the next Tab wraps to the first
    if (r.key === first) break; // once around
    first ??= r.key;
    if (seen.has(r.key)) continue;
    seen.add(r.key); if (!r.ok) miss.push(r.key.replace(/@[^@]*$/, ''));
  }
  if (process.env.AXE_DEBUG) console.log('focus stops', seen.size);
  return miss;
}

const failures = [];
const report = { at: new Date().toISOString(), runs: [] };
async function check(name, fn) {
  try { await fn(); console.log('PASS', name); } catch (error) { failures.push(`${name}: ${error.message}`); console.error('FAIL', name, error.message); }
}

await seed();
const DEVICES = [['1440', { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }], ['iPhone 14', devices['iPhone 14']]];
const ONLY = (process.env.AXE_ONLY || '').split(',').filter(Boolean);
for (const [dname, device] of DEVICES.filter(([n]) => !process.env.AXE_DEVICE || n === process.env.AXE_DEVICE)) for (const scheme of process.env.AXE_SCHEME ? [process.env.AXE_SCHEME] : ['dark', 'light']) {
  const page = await open(device, scheme);
  // printLab sends the browser to Pi Hub's /lab (step 6, PR 6.4; print-lab-ui checks that): it is no page of Local AI's.
  const views = await page.evaluate(() => window.LocalAIViews.VIEWS.map(v => v.id).filter(id => id !== 'printLab'));
  const states = [...views.map(id => ({ name: id, go: p => p.evaluate(v => window.showView(v), id) })),
    // Agent World with the mission sheet raised on a phone (the crew list, story and result are in it), and the run view.
    { name: 'agents (done mission)', go: async p => { await p.evaluate(() => window.showView('agents')); await p.evaluate(() => window.LocalAIMissions.show('mission-axe-0', { replay: false })); if (dname !== '1440') await p.locator('#awSheetHandle').click(); } },
    { name: 'run view (mission)', go: p => p.evaluate(() => window.LocalAIRuns.show('run-axe-m')) },
    // What opens over a page: Agent World's ⋯ menu, its start sheet, Home's mode sheet and the ⌘K palette.
    // The ⋯ button is desktop only; the start sheet opens through the menu's own handler on both.
    ...(dname === '1440' ? [{ name: 'agents (⋯ menu)', go: async p => { await p.evaluate(() => window.showView('agents')); await p.locator('#awMoreBtn').click(); } }] : []),
    { name: 'agents (start sheet)', go: async p => { await p.evaluate(() => { window.showView('agents'); window.LocalAIAgentStart.open(); }); } },
    { name: 'home (mode sheet)', go: async p => { await p.keyboard.press('Escape'); await p.evaluate(() => window.showView('home')); await p.locator('#homeModeChip').click(); } },
    { name: 'command palette', go: async p => { await p.keyboard.press('Escape'); await p.keyboard.press('Control+k'); } }];
  for (const s of states.filter(x => !ONLY.length || ONLY.some(o => x.name.startsWith(o)))) {
    await check(`axe: ${s.name} at ${dname}, ${scheme}`, async () => {
      await s.go(page);
      await page.waitForTimeout(700);
      // Home's last row, "See all", sits under the sticky composer on a screen this tall when several things need you (a stopped
      // service each, an approval, Pi Hub's items); a person scrolls to it, so this check does too.
      if (s.name === 'home') {
        await page.evaluate(() => document.querySelector('#homeNeedsList .ui-needs__more a')?.scrollIntoView({ block: 'center' }));
        await page.waitForTimeout(300);
      }
      const v = await markAllowed(page, await axe(page));
      const touch = dname === '1440' ? [] : await smallTargets(page);
      const symbols = await symbolNames(page);
      // Focus rings: once per page, at 1440 in the dark scheme (Tab order does not change with the scheme).
      const focus = dname === '1440' && scheme === 'dark' && views.includes(s.name) ? await focusMisses(page) : [];
      report.runs.push({ device: dname, scheme, view: s.name, violations: v, smallTargets: touch, symbolNames: symbols, focusMisses: focus });
      if (REPORT) return;
      const bad = v.filter(x => ['serious', 'critical'].includes(x.impact)).flatMap(x => x.nodes.filter(n => !n.allowed).map(n => `${x.id} (${x.impact}): ${n.target}`));
      const list = a => a.slice(0, 8).join(' | ') + (a.length > 8 ? ` … and ${a.length - 8} more` : '');
      if (bad.length) throw Error(list(bad));
      if (touch.length) throw Error('tap targets under 44 px: ' + list(touch.map(t => `${t.target} "${t.name}" ${t.size}`)));
      if (symbols.length) throw Error('named only by a symbol: ' + list(symbols));
      if (focus.length) throw Error('no visible focus: ' + list(focus));
    });
    if (s.name === 'run view (mission)' || s.name === 'command palette') await page.keyboard.press('Escape');
  }
  await check(`no script errors at ${dname}, ${scheme}`, async () => { if (page.errors.length) throw Error(page.errors.join(' | ')); });
  await page.context().close();
}
await browser.close();
await post('/api/approvals/decide', { id: seeded.approval, decision: 'rejected' });

if (REPORT) {
  // Unique nodes per rule across all pages, devices and schemes (a node that fails on every page counts once).
  const byRule = {};
  for (const r of report.runs) for (const v of r.violations) { const b = byRule[v.id] || (byRule[v.id] = { impact: v.impact, help: v.help, nodes: new Set(), pages: new Set() }); for (const n of v.nodes) b.nodes.add(`${r.device}|${n.target}`); b.pages.add(`${r.view}@${r.device}/${r.scheme}`); }
  const small = new Set(report.runs.flatMap(r => r.smallTargets.map(t => `${r.view}|${t.target}|${t.name}|${t.size}`)));
  const symbols = new Set(report.runs.flatMap(r => r.symbolNames)), focus = new Set(report.runs.flatMap(r => r.focusMisses));
  report.summary = { byRule: Object.fromEntries(Object.entries(byRule).map(([k, b]) => [k, { impact: b.impact, help: b.help, uniqueNodes: b.nodes.size, pageRuns: b.pages.size }])), smallTargets44: small.size, smallTargetList: [...small], symbolNames: [...symbols], focusMisses: [...focus] };
  writeFileSync(REPORT, JSON.stringify(report, null, 1));
  console.log(JSON.stringify({ byRule: report.summary.byRule, smallTargets44: small.size, symbolNames: symbols.size, focusMisses: focus.size }, null, 1));
}
if (failures.length) { console.error(`\n${failures.length} axe check(s) failed`); process.exit(1); }
console.log('\nAll axe checks passed');
