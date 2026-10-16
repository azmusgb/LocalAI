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
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, 'visual', process.platform);
const results = path.join(dir, '__results__');
const UPDATE = process.env.LOCALAI_VISUAL_UPDATE === '1';
// A pixel counts as changed when a colour channel moves by more than this; a page fails above MAX_CHANGED of its pixels.
const CHANNEL = 24, MAX_CHANGED = 0.002;
const NOW = Date.parse('2026-10-14T15:30:00Z');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-visual-'));
const probe = http.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise(r => probe.close(r));
const base = `http://127.0.0.1:${port}`, off = 'http://127.0.0.1:9';
const server = spawn(process.execPath, [path.resolve(here, '../app/server.js')], {
  env: { ...process.env, DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, PORT: String(port), OLLAMA_URL: off, SEARXNG_URL: off, COMFY_URL: off, N8N_URL: off, PROXY_URL: off, MAC_AI_HOME_URL: off, MAC_DSH_URL: off, GRIDCRAFT_URL: off }
});
let log = ''; server.stdout.on('data', c => log += c); server.stderr.on('data', c => log += c);
for (let i = 0; ; i++) {
  if (server.exitCode !== null) throw new Error(log);
  try { if ((await fetch(`${base}/healthz`)).ok) break; } catch {}
  if (i > 100) throw new Error(`Server did not start: ${log}`);
  await new Promise(r => setTimeout(r, 100));
}

const PAGES = ['home', 'work', 'library', 'projects', 'backlog', 'claude', 'status', 'models'];
const VIEWPORTS = [{ name: 'phone', width: 390, height: 844, mobile: true }, { name: 'desktop', width: 1280, height: 860, mobile: false }];

const browser = await chromium.launch({ headless: true });
const failures = [], notes = [];

// Fixed data for the lists, so the pages show real content rather than empty states. Times are relative to NOW.
const ago = s => new Date(NOW - s * 1000).toISOString();
const run = (id, kind, title, s, o = {}) => ({ id, type: kind, status: o.status || 'completed', progress: o.status === 'running' ? 40 : 100, createdAt: ago(s), updatedAt: ago(s),
  card: { kind, icon: 'system', title, summary: o.summary || '', badge: { label: o.status === 'running' ? 'Working' : o.status === 'failed' ? 'Failed' : 'Done', tone: o.status === 'running' ? 'accent' : o.status === 'failed' ? 'bad' : 'good' }, preview: null, action: { label: 'Open' }, approval: null } });
const RUNS = [
  run('run-1', 'agent', 'Compare NAS drives for Plex', 120, { status: 'running', summary: 'Three specialists working' }),
  run('run-2', 'chat', 'Plan the vegetable garden', 3600, { summary: 'Raised beds, tomatoes and basil' }),
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

// What differs between runs by design: the version, response times, a fresh pairing code, and when the server last
// checked its services (the server's clock, not the page's).
const masks = page => [page.getByText(/^\s*(Local AI |Version |v)?\d+\.\d+\.\d+\s*$/), page.getByText(/^\s*\d+\s*ms\s*$/), page.locator('#claudeChatCode, .claude-chat-cmd code, #statusCheckedAt')];

async function shoot(viewport, view) {
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport, isMobile: viewport.mobile, hasTouch: viewport.mobile, deviceScaleFactor: 1, reducedMotion: 'reduce', colorScheme: 'dark', locale: 'en-US', timezoneId: 'America/New_York' });
  await ctx.addInitScript(() => { try { localStorage.setItem('localai.firstRun.done', '1'); sessionStorage.setItem('localai.httpsTrusted', '0'); } catch {} });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(NOW);
  await stubData(page);
  await page.goto(`${base}/#${view}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(v => typeof window.showView === 'function' && document.querySelector(`#${v}.active, .view.active`), view);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600); // lists load after the page shows
  const shot = await page.screenshot({ animations: 'disabled', caret: 'hide', mask: masks(page), maskColor: '#ff00ff' });
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
  for (const viewport of VIEWPORTS) {
    for (const view of PAGES) {
      const name = `${view}-${viewport.name}`, file = path.join(dir, `${name}.png`);
      try {
        const shot = await shoot(viewport, view);
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
