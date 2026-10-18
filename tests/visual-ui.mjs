// Visual regression: screenshots of the key pages at phone and desktop width, compared with saved baselines.
// Catches a merge that silently drops CSS or markup (it has happened: #111, #113, #151, #175).
//
// Starts its own appliance on a fresh, empty data directory with every outside service off, so the pages look the
// same on every run; the clock is fixed, animations are off and the version number is masked.
//
// Baselines live in tests/visual/<platform>/ (fonts render differently per OS). A missing baseline is written and the
// check passes with a note. After an intended visual change: LOCALAI_VISUAL_UPDATE=1 node tests/visual-ui.mjs, then
// look at the new PNGs before committing them. A failing page writes <name>.actual.png and <name>.diff.png (red =
// changed pixels) to tests/visual/<platform>/__results__/ (ignored by git).
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const { spawnAppServer } = createRequire(import.meta.url)('./spawn-server.cjs');

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, 'visual', process.platform);
const results = path.join(dir, '__results__');
const UPDATE = process.env.LOCALAI_VISUAL_UPDATE === '1';
// A pixel counts as changed when a colour channel moves by more than this; a page fails above MAX_CHANGED of its pixels.
const CHANNEL = 24, MAX_CHANGED = 0.002;
const NOW = Date.parse('2026-10-14T15:30:00Z');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-visual-'));
const off = 'http://127.0.0.1:9';
const { child: server, ready } = spawnAppServer({
  env: { DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, OLLAMA_URL: off, SEARXNG_URL: off, COMFY_URL: off, N8N_URL: off, PROXY_URL: off, MAC_AI_HOME_URL: off, MAC_DSH_URL: off, GRIDCRAFT_URL: off, LOCALAI_WORKSHOP_URL: off }
});
const base = await ready;

const PAGES = ['home', 'work', 'library', 'projects', 'backlog', 'claude', 'status', 'models'];
const VIEWPORTS = [{ name: 'phone', width: 390, height: 844, mobile: true }, { name: 'desktop', width: 1280, height: 860, mobile: false }];

const browser = await chromium.launch({ headless: true });
const failures = [], notes = [];

// Fixed data for the lists, so the pages show real content rather than empty states. Times are relative to NOW.
const ago = s => new Date(NOW - s * 1000).toISOString();
const run = (id, kind, title, s, o = {}) => ({ id, type: kind, status: o.status || 'completed', progress: o.status === 'running' ? 40 : 100, createdAt: ago(s), updatedAt: ago(s),
  ...(kind === 'chat' || kind === 'research' ? { kept: !!o.kept } : {}),   // the server marks chats and research for ☆ Keep
  card: { kind, icon: 'system', title, summary: o.summary || '', badge: { label: o.status === 'running' ? 'Working' : o.status === 'failed' ? 'Failed' : 'Done', tone: o.status === 'running' ? 'accent' : o.status === 'failed' ? 'bad' : 'good' }, preview: null, action: { label: 'Open' }, approval: null } });
const RUNS = [
  run('run-1', 'agent', 'Compare NAS drives for Plex', 120, { status: 'running', summary: 'Three specialists working' }),
  run('run-2', 'chat', 'Plan the vegetable garden', 3600, { summary: 'Raised beds, tomatoes and basil', kept: true }),
  run('run-3', 'image', 'A red fox reading in a library, watercolor', 7200),
  run('run-4', 'research', 'Heat pump prices in Arizona', 90000, { summary: 'Five sources compared' }),
  run('run-5', 'engineering', 'Add a dark mode toggle', 4 * 86400, { status: 'failed' }),
  run('run-6', 'automation', 'Nightly backup', 20 * 86400)
];
const LIBRARY = [
  { id: 'lib-1', kind: 'conversation', title: 'Plan the vegetable garden', summary: 'Raised beds, tomatoes and basil along the south fence.', createdAt: ago(3600), pinned: true, meta: {}, data: {} },
  { id: 'lib-2', kind: 'research', title: 'Heat pump prices in Arizona', summary: 'Installed prices range from about $9,000 to $16,000.', createdAt: ago(90000), pinned: false, meta: {}, data: {} },
  { id: 'lib-3', kind: 'conversation', title: 'Why is SQLite so fast?', summary: 'WAL mode, page cache and no network round trips.', createdAt: ago(3 * 86400), pinned: false, meta: {}, data: {} }
];
const FINDINGS = [['ux', 'high', 'proposed'], ['bug', 'high', 'in_progress'], ['bug', 'medium', 'fixed'], ['a11y', 'medium', 'approved'], ['cleanup', 'low', 'deferred'], ['security', 'high', 'fixed']]
  .map(([category, severity, status], i) => ({ id: `f-${i}`, title: `Finding ${i + 1}: ${category} problem worth fixing`, category, severity, status, summary: 'What is wrong, and where.', fix: 'What to change.', votes: { up: i % 2, down: 0 }, createdAt: ago(86400 + i * 600), updatedAt: ago(3600 + i * 60) }));
const EVENTS = Array.from({ length: 6 }, (_, i) => ({ id: `e${i}`, sessionId: 'cc-visual', at: ago(60 + i * 90), kind: 'action', tool: 'Bash', title: `Step ${6 - i}: run the tests`, detail: '', status: 'done' }));
async function stubData(page) {
  const json = (route, body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  await page.route(u => u.pathname === '/api/runs', route => { const id = new URL(route.request().url()).searchParams.get('id'); return id ? json(route, { item: RUNS.find(r => r.id === id) }) : json(route, { items: RUNS, summary: {} }); });
  await page.route(u => u.pathname === '/api/library', route => json(route, { items: LIBRARY }));
  await page.route('**/api/claude/board*', async route => {
    // The page can move on mid-request (connection reset); drop that request instead of crashing the suite.
    const res = await route.fetch().catch(() => null); if (!res) return route.abort().catch(() => {});
    const j = await res.json();
    const byCategory = {}, byStatus = {};
    for (const f of FINDINGS) { byStatus[f.status] = (byStatus[f.status] || 0) + 1; const c = byCategory[f.category] || (byCategory[f.category] = { high: 0, medium: 0, low: 0, open: 0, total: 0 }); c[f.severity]++; c.total++; if (!['fixed', 'rejected'].includes(f.status)) c.open++; }
    await json(route, { ...j, sessions: [{ id: 'cc-visual', title: 'LocalAI · Claude Code · visual', updatedAt: ago(60) }], events: EVENTS, findings: FINDINGS, summary: { ...j.summary, total: FINDINGS.length, byStatus, byCategory } });
  });
}

// The rest of the owner pages (registry, after navigation step 4), at phone and 1440 wide. Each gets a few rows of fixed
// data so the baseline shows the page's real layout, on an appliance whose services are up. `ready` is what the page
// draws once its data is in. These stubs apply to these pages only, so the pages above keep their baselines.
const PROJECTS = [
  { id: 'p-garden', name: 'Garden', description: 'Beds, watering and what to plant when.', pinned: true, counts: { conversations: 4, knowledge: 2, artifacts: 3 }, createdAt: ago(30 * 86400), updatedAt: ago(3600) },
  { id: 'p-house', name: 'House upgrades', description: 'Heat pump, solar and the attic.', pinned: false, counts: { conversations: 2, knowledge: 1, artifacts: 1 }, createdAt: ago(60 * 86400), updatedAt: ago(90000) }
];
const KNOWLEDGE = [
  { id: 'k-1', name: 'Raised bed planting guide.pdf', projectId: 'p-garden', size: 284 * 1024, mimeType: 'application/pdf', createdAt: ago(5 * 86400) },
  { id: 'k-2', name: 'Watering schedule.md', projectId: 'p-garden', size: 6 * 1024, mimeType: 'text/markdown', createdAt: ago(4 * 86400) },
  { id: 'k-3', name: 'Heat pump quotes.txt', projectId: 'p-house', size: 12 * 1024, mimeType: 'text/plain', createdAt: ago(2 * 86400) },
  { id: 'k-4', name: 'Router setup notes.md', projectId: '', size: 3 * 1024, mimeType: 'text/markdown', createdAt: ago(86400) }
];
const MEMORY = [
  { id: 'm-1', projectId: '', category: 'preference', text: 'Answer in short paragraphs, metric units first.', pinned: true, createdAt: ago(9 * 86400) },
  { id: 'm-2', projectId: '', category: 'decision', text: 'Backups go to the NAS every night at 2 AM, not to the cloud.', pinned: false, createdAt: ago(6 * 86400) },
  { id: 'm-3', projectId: '', category: 'goal', text: 'Keep everything on this computer unless I say otherwise.', pinned: false, createdAt: ago(2 * 86400) }
];
const NOTIFICATIONS = [
  { id: 'n-1', kind: 'health', level: 'warning', title: 'Images is slow to answer', detail: 'ComfyUI took 9 seconds to respond to the last health check.', read: false, resolved: false, createdAt: ago(1800), updatedAt: ago(1800) },
  { id: 'n-2', kind: 'automation', level: 'error', title: 'Nightly backup failed', detail: 'The NAS share was not reachable at 2:00 AM. It runs again tonight.', read: true, resolved: false, createdAt: ago(48000), updatedAt: ago(40000) },
  { id: 'n-3', kind: 'system', level: 'info', title: 'Model download finished', detail: 'qwen3:4b-instruct is installed and ready.', read: true, resolved: true, createdAt: ago(3 * 86400), updatedAt: ago(3 * 86400) }
];
const APPROVALS = [
  { id: 'a-1', kind: 'powershell', title: 'Restart the Plex service on the Windows computer', detail: 'Runs Restart-Service Plex. Playback stops for about a minute.', risk: 'medium', status: 'pending', createdAt: ago(600), updatedAt: ago(600) },
  { id: 'a-2', kind: 'change', title: 'Add a dark mode toggle', detail: 'Approved change, shipped as a pull request.', risk: 'low', status: 'approved', createdAt: ago(2 * 86400), updatedAt: ago(2 * 86400 - 600) }
];
const AUTOMATIONS = {
  items: [
    { id: 'au-1', name: 'Morning news digest', kind: 'research', schedule: 'daily', enabled: true, prompt: 'Summarize the local news.', nextRunAt: ago(-15 * 3600), createdAt: ago(10 * 86400) },
    { id: 'au-2', name: 'Weekly garden reminder', kind: 'prompt', schedule: 'weekly', enabled: false, prompt: 'What needs doing in the garden this week?', nextRunAt: null, createdAt: ago(20 * 86400) }
  ],
  runs: [
    { id: 'ar-1', automationId: 'au-1', name: 'Morning news digest', status: 'completed', startedAt: ago(9 * 3600 + 40), finishedAt: ago(9 * 3600), output: 'Three stories: the new light rail line opens Monday, water rates rise in January, and the library extends its hours.' },
    { id: 'ar-2', automationId: 'au-2', name: 'Weekly garden reminder', status: 'failed', startedAt: ago(7 * 86400), finishedAt: ago(7 * 86400 - 5), output: 'The model was not loaded.' }
  ]
};
const MONITORS = [{ id: 'mo-1', name: 'Local AI health', kind: 'health', lastState: 'HEALTHY', lastRunAt: ago(420), createdAt: ago(30 * 86400) }];
const ACTIVITY = [
  { id: 'ac-1', type: 'chat', title: 'Chat answered', detail: 'Plan the vegetable garden', at: ago(3600), meta: { runId: 'run-2' } },
  { id: 'ac-2', type: 'image', title: 'Image made', detail: 'A red fox reading in a library, watercolor', at: ago(7200), meta: { runId: 'run-3' } },
  { id: 'ac-3', type: 'automation', title: 'Automation ran', detail: 'Morning news digest', at: ago(9 * 3600), meta: {} },
  { id: 'ac-4', type: 'research', title: 'Research finished', detail: 'Heat pump prices in Arizona', at: ago(90000), meta: { runId: 'run-4' } },
  { id: 'ac-5', type: 'system', title: 'Appliance started', detail: 'Local AI Appliance v2.0.0 is ready.', at: ago(2 * 86400), meta: {} }
];
const item = (id, title, stage, o = {}) => ({ id, title, stage, source: 'claude', severity: 'medium', status: 'proposed', votes: { up: 0, down: 0 }, summary: 'What is wrong, and where.', createdAt: ago(5 * 86400), updatedAt: ago(86400), ...o });
const IMPROVE = {
  items: [
    item('i-1', 'Phone: the composer hides the Send button behind the keyboard', 'backlog', { severity: 'high' }),
    item('i-2', 'Work list loses its filter after a run finishes', 'inProgress', { status: 'in_progress', sessionId: 'cc-visual' }),
    item('i-3', 'Show model download progress on Models', 'inProgress', { source: 'idea', status: 'approved', change: { id: 'chg-1', status: 'awaiting_approval' } }),
    item('i-4', 'Retry a failed image with one tap', 'inProgress', { source: 'idea', status: 'approved', change: { id: 'chg-2', status: 'validation_failed' } }),
    item('i-5', 'Library search matches words inside kept chats', 'shipped', { status: 'fixed', pr: 'https://github.com/azmusgb/LocalAI/pull/271', shipped: { version: '2.0.431', at: ago(2 * 86400) } }),
    item('i-6', 'Inbox counts approvals and alerts together', 'shipped', { status: 'fixed', pr: 'https://github.com/azmusgb/LocalAI/pull/266', shipped: { version: '2.0.431', at: ago(2 * 86400 + 600) } }),
    item('i-7', 'Health says which service is down, in words', 'shipped', { status: 'fixed', pr: 'https://github.com/azmusgb/LocalAI/pull/259', shipped: { version: '2.0.425', at: ago(6 * 86400) } }),
    item('i-8', 'Audit log folds repeated restarts into one line', 'shipped', { status: 'fixed', decisionNote: 'Resolved on its own', shipped: { pending: true, at: ago(3600) } })
  ],
  signals: [
    { id: 's-1', name: 'Chat answer took over 60 seconds', severity: 'high', status: 'open', occurrences: 4, lastSeenAt: ago(5400) },
    { id: 's-2', name: 'Images: ComfyUI returned an empty picture', severity: 'medium', status: 'open', occurrences: 1, lastSeenAt: ago(2 * 86400) },
    { id: 's-3', name: 'Browser error on Work: list failed to load', severity: 'low', status: 'open', occurrences: 2, lastSeenAt: ago(3 * 86400) }
  ]
};
const RELEASES = [{ version: '2.0.425', deployedAt: ago(5 * 86400), notes: [{ title: 'Health says which service is down, in words', pr: 259 }] }, { version: '2.0.431', deployedAt: ago(36 * 3600), notes: [{ title: 'Library search matches words inside kept chats', pr: 271 }] }];
const QUALITY = { latest: { checks: [{ name: 'Home loads', result: 'PASS' }, { name: 'Chat answers within 60 seconds', result: 'FAIL', detail: '4 of the last 20 took longer' }, { name: 'Images make a picture', result: 'PASS' }] }, events: [{ message: 'TypeError: list is undefined', source: 'work.js', createdAt: ago(3 * 86400) }] };
// Spreadsheets: the /api/gridcraft routes as tests/spreadsheets-ui.mjs stubs them, with two finished requests.
const SHEET = {
  ok: true, title: 'Quarterly Sales Dashboard', file: 'Quarterly-Sales-Dashboard.xlsx', dirty: false, activeSheet: 'Sales',
  sheets: [{ name: 'Sales', usedRange: 'A1:D5', cells: 20, tables: 1, charts: 0 }, { name: 'Notes', usedRange: 'A1:A12', cells: 12, tables: 0, charts: 0 }],
  sheet: 'Sales', usedRange: 'A1:D5', range: 'A1:D5', truncated: false,
  values: [['Region', 'Q1', 'Q2', 'Total'], ['North', '$48,200', '$51,340', '$99,540'], ['South', '$39,150', '$37,980', '$77,130'], ['East', '$42,800', '$45,010', '$87,810'], ['West', '$51,600', '$49,270', '$100,870']],
  formulas: [['Region', 'Q1', 'Q2', 'Total'], ['North', 48200, 51340, '=B2+C2'], ['South', 39150, 37980, '=B3+C3'], ['East', 42800, 45010, '=B4+C4'], ['West', 51600, 49270, '=B5+C5']],
  raw: [['Region', 'Q1', 'Q2', 'Total'], ['North', 48200, 51340, 99540], ['South', 39150, 37980, 77130], ['East', 42800, 45010, 87810], ['West', 51600, 49270, 100870]]
};
const SHEET_RUNS = [
  { id: 'gc-2', prompt: 'Bold the header row', mode: 'review', status: 'kept', answer: 'Made row 1 bold.', error: '', edits: [], changes: [{ tool: 'format_range', summary: 'Formatted A1:D1: bold' }], undoSteps: 1, undoTop: ['Bold'], createdAt: ago(1200) },
  { id: 'gc-1', prompt: 'What is the total of the Sales column? Do not change anything.', mode: 'read', status: 'done', answer: 'The four regions total $365,350.', error: '', edits: [], changes: [], undoSteps: 0, undoTop: [], createdAt: ago(3000) }
];
async function stubPages(page) {
  const json = (route, body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  const up = s => ({ ...s, state: 'HEALTHY', displayState: 'HEALTHY', availability: 'available', severity: 'ok', statusCode: 200, latencyMs: 12, error: null });
  // The server's own answer with every service up and a fixed check time (the server's clock would differ per run).
  const healthy = async (route, extra = {}) => {
    const res = await route.fetch().catch(() => null); if (!res) return route.abort().catch(() => {});
    const j = await res.json();
    await json(route, { ...j, ...extra, overall: 'HEALTHY', checkedAt: ago(30), services: (j.services || []).map(up) });
  };
  await page.route(u => u.pathname === '/api/status', route => healthy(route));
  await page.route(u => u.pathname === '/api/capabilities', route => healthy(route, { images: { available: true } }));
  await page.route(u => u.pathname === '/api/artcraft/status', route => json(route, { ok: true, installed: true, running: false, version: '0.41.0' }));
  await page.route(u => u.pathname === '/api/workshop/status', route => json(route, { online: true, board: 'Waveshare_ESP32-S3-Touch-LCD-3.5', panel: 'ST7796_320x480_FT6336', screen: 6, touchscreenConfigured: true, portalUrl: 'http://10.0.0.124' }));
  await page.route(u => u.pathname === '/api/notifications', route => json(route, { items: NOTIFICATIONS, unread: NOTIFICATIONS.filter(n => !n.read).length }));
  await page.route(u => u.pathname === '/api/approvals', route => json(route, { items: APPROVALS }));
  await page.route(u => u.pathname === '/api/projects', route => json(route, { items: PROJECTS }));
  await page.route(u => u.pathname === '/api/knowledge', route => { const p = new URL(route.request().url()).searchParams.get('projectId'); return json(route, { items: p ? KNOWLEDGE.filter(k => k.projectId === p) : KNOWLEDGE }); });
  await page.route(u => u.pathname === '/api/memory', route => json(route, { items: MEMORY }));
  await page.route(u => u.pathname === '/api/automations', route => json(route, AUTOMATIONS));
  await page.route(u => u.pathname === '/api/monitors', route => json(route, { items: MONITORS }));
  await page.route(u => u.pathname === '/api/activity', route => json(route, { items: ACTIVITY }));
  await page.route(u => u.pathname === '/api/improve/items', route => json(route, IMPROVE));
  await page.route(u => u.pathname === '/api/quality', route => json(route, QUALITY));
  await page.route(u => u.pathname === '/api/releases', async route => {
    const res = await route.fetch().catch(() => null); if (!res) return route.abort().catch(() => {});
    await json(route, { ...(await res.json()), history: RELEASES });
  });
  await page.route(u => u.pathname === '/api/gridcraft/health', route => json(route, { ok: true, gridcraftConnected: true, model: 'qwen3:4b-instruct' }));
  await page.route(u => u.pathname === '/api/gridcraft/workbooks', route => json(route, { ok: true, items: [SHEET.file, 'Budget.xlsx', 'Inventory.csv'].map(name => ({ name, size: 2048, modified: ago(86400) })) }));
  await page.route(u => u.pathname === '/api/gridcraft/workbook', route => json(route, SHEET));
  await page.route(u => u.pathname === '/api/gridcraft/runs', route => json(route, { items: SHEET_RUNS }));
}
const MORE_PAGES = {
  inbox: '#inboxList .inbox-approval',
  signals: '#signalsList .improve-row',
  shipped: '#shippedList .improve-row',
  inProgress: '#inProgressList .improve-row',
  integrations: '#uxIntegrationNativeCountV2:text("2/2")',
  automationStudio: '#automationList .item-card',
  activity: '#activityList .activity-item',
  knowledge: '#knowledgeList .item-card',
  memory: '#memoryList .memory-card',
  spreadsheets: '#sheetsGrid td[data-cell="D5"]'
};
const MORE_VIEWPORTS = [VIEWPORTS[0], { name: 'desktop1440', width: 1440, height: 900, mobile: false }];

// What differs between runs by design: the version, response times, a fresh pairing code, and when the server last
// checked its services (the server's clock, not the page's). Shipped's release headings come from fixed data, so they stay.
const masks = page => [page.getByText(/^\s*(Local AI |Version |v)?\d+\.\d+\.\d+\s*$/).and(page.locator(':not(.improve-release > h3)')), page.getByText(/^\s*\d+\s*ms\s*$/), page.locator('#claudeChatCode, .claude-chat-cmd code, #statusCheckedAt')];

// Agent World in its four states (design 2026-10-17-agent-world), phone and 1440 wide. The city is animated, so its canvas
// is hidden (the map box stays) and the story's clock times are masked: these baselines guard the page around the city.
const A_W = (u, c, ux = {}) => [{ id: 'router', name: 'Mission Router', state: 'complete', dependsOn: [] }, { id: 'ux_analyst', name: 'UX Analyst', state: u, dependsOn: ['router'], ...ux }, { id: 'synthesis', name: 'Coordinator', state: c, dependsOn: ['ux_analyst'] }];
const A_BASE = { goal: 'Improve the look and polish of Agent World', createdAt: ago(300), updatedAt: ago(60), results: [] };
const A_TL = [{ at: ago(300), type: 'mission-start', workers: A_W('pending', 'pending') }, { at: ago(299), type: 'dispatch', workers: A_W('running', 'pending') }];
const AGENT_STATES = {
  empty: [],
  running: [{ ...A_BASE, id: 'm-run', status: 'running', workers: A_W('running', 'pending'), timeline: A_TL }],
  needs: [{ ...A_BASE, id: 'm-bad', status: 'needs_attention', workers: A_W('error', 'blocked', { errorCode: 'MODEL_CONNECTION_ERROR' }), timeline: [...A_TL, { at: ago(60), type: 'mission-attention', status: 'needs_attention', workers: A_W('error', 'blocked', { errorCode: 'MODEL_CONNECTION_ERROR' }) }] }],
  done: [{ ...A_BASE, id: 'm-done', status: 'complete', finishedAt: ago(60), answer: 'Three fixes for the phone screens, in order of impact.', workers: A_W('complete', 'complete'), results: [{ agentId: 'ux_analyst', agentName: 'UX Analyst', status: 'complete', answer: 'Three things to fix.' }], timeline: [...A_TL, { at: ago(60), type: 'mission-complete', status: 'complete', workers: A_W('complete', 'complete') }] }]
};
const AGENT_VIEWPORTS = [VIEWPORTS[0], { name: 'desktop1440', width: 1440, height: 900, mobile: false }];
async function shoot(viewport, view, missions, ready) {
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport, isMobile: viewport.mobile, hasTouch: viewport.mobile, deviceScaleFactor: 1, reducedMotion: 'reduce', colorScheme: 'dark', locale: 'en-US', timezoneId: 'America/New_York' });
  await ctx.addInitScript(() => { try { localStorage.setItem('localai.firstRun.done', '1'); sessionStorage.setItem('localai.httpsTrusted', '0'); } catch {} });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(NOW);
  await stubData(page);
  if (ready) await stubPages(page);
  if (missions) await page.route(u => u.pathname === '/api/agents/missions', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: missions }) }));
  await page.goto(`${base}/#${missions ? 'home' : view}`, { waitUntil: 'networkidle' });
  if (missions) await page.evaluate(() => window.showView('agents'));
  await page.waitForFunction(v => typeof window.showView === 'function' && document.querySelector(`#${v}.active, .view.active`), view);
  if (ready) await page.locator(ready).first().waitFor({ timeout: 8000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600); // lists load after the page shows
  if (missions) await page.addStyleTag({ content: '#awcCanvas{visibility:hidden}' }); // the city animates; its box and everything over it stay
  const mask = missions ? [...masks(page), page.locator('#agentTimeline time')] : masks(page);
  const shot = await page.screenshot({ animations: 'disabled', caret: 'hide', mask, maskColor: '#ff00ff' });
  await ctx.close();
  return shot;
}

// Compares two PNGs in the browser (canvas), so the suite needs no image library. Returns {changed, total, diff}.
const cmp = await browser.newPage();
async function compare(a, b) {
  return cmp.evaluate(async ({ a, b, channel }) => {
    const load = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
    const [x, y] = await Promise.all([load(a), load(b)]);
    if (x.width !== y.width || x.height !== y.height) return { changed: Infinity, total: x.width * x.height, size: `${x.width}x${x.height} vs ${y.width}x${y.height}` };
    const c = document.createElement('canvas'); c.width = x.width; c.height = x.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(x, 0, 0); const p = g.getImageData(0, 0, c.width, c.height);
    g.clearRect(0, 0, c.width, c.height); g.drawImage(y, 0, 0); const q = g.getImageData(0, 0, c.width, c.height);
    const out = g.createImageData(c.width, c.height);
    let changed = 0;
    for (let i = 0; i < p.data.length; i += 4) {
      const d = Math.max(Math.abs(p.data[i] - q.data[i]), Math.abs(p.data[i + 1] - q.data[i + 1]), Math.abs(p.data[i + 2] - q.data[i + 2]));
      if (d > channel) { changed++; out.data.set([255, 0, 64, 255], i); } else out.data.set([q.data[i] >> 2, q.data[i + 1] >> 2, q.data[i + 2] >> 2, 255], i);
    }
    g.putImageData(out, 0, 0);
    return { changed, total: c.width * c.height, diff: changed ? c.toDataURL('image/png') : '' };
  }, { a: 'data:image/png;base64,' + a.toString('base64'), b: 'data:image/png;base64,' + b.toString('base64'), channel: CHANNEL });
}

try {
  fs.mkdirSync(dir, { recursive: true });
  fs.rmSync(results, { recursive: true, force: true });
  const shots = [...VIEWPORTS.flatMap(viewport => PAGES.map(view => ({ name: `${view}-${viewport.name}`, viewport, view }))),
    ...AGENT_VIEWPORTS.flatMap(viewport => Object.entries(AGENT_STATES).map(([state, missions]) => ({ name: `agents-${state}-${viewport.name}`, viewport, view: 'agents', missions }))),
    ...MORE_VIEWPORTS.flatMap(viewport => Object.entries(MORE_PAGES).map(([view, ready]) => ({ name: `${view}-${viewport.name}`, viewport, view, ready })))];
  {
    for (const { name, viewport, view, missions, ready } of shots) {
      const file = path.join(dir, `${name}.png`);
      try {
        const shot = await shoot(viewport, view, missions, ready);
        if (UPDATE || !fs.existsSync(file)) {
          fs.writeFileSync(file, shot);
          notes.push(`${UPDATE ? 'updated' : 'new baseline'}: ${path.relative(process.cwd(), file)}`);
          console.log('PASS', name, UPDATE ? '(baseline updated)' : '(baseline written)');
          continue;
        }
        const r = await compare(fs.readFileSync(file), shot);
        if (r.changed / r.total > MAX_CHANGED) {
          fs.mkdirSync(results, { recursive: true });
          fs.writeFileSync(path.join(results, `${name}.actual.png`), shot);
          if (r.diff) fs.writeFileSync(path.join(results, `${name}.diff.png`), Buffer.from(r.diff.split(',')[1], 'base64'));
          throw new Error(r.size ? `size changed (${r.size})` : `${(r.changed / r.total * 100).toFixed(2)}% of pixels changed (${r.changed}); see ${path.relative(process.cwd(), results)}/${name}.diff.png`);
        }
        console.log('PASS', name, r.changed ? `(${r.changed} pixels within tolerance)` : '');
      } catch (e) { failures.push(`${name}: ${e.message}`); console.error('FAIL', name, e.message); }
    }
  }
} finally {
  await browser.close().catch(() => {});
  if (server.exitCode === null) { const done = once(server, 'exit'); server.kill('SIGTERM'); await done; }
  fs.rmSync(dataDir, { recursive: true, force: true });
}
for (const n of notes) console.log('NOTE', n);
if (failures.length) {
  console.error(`\n${failures.length} visual check(s) failed. If the change is intended: LOCALAI_VISUAL_UPDATE=1 node tests/visual-ui.mjs`);
  process.exit(1);
}
console.log('\nAll visual checks passed');
