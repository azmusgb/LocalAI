// Accessibility sweep: axe (WCAG 2.2 AA + best practices) on every page at phone and desktop width, with data in the
// lists that once failed (Claude Code heat map and activity, Library, Issues, What's new), plus keyboard checks.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { addAxe } from './axe-helper.mjs';

const base = process.env.LOCALAI_URL || 'http://127.0.0.1:3080';
const axePath = join(dirname(fileURLToPath(import.meta.url)), 'vendor', 'axe.min.js');
const browser = await chromium.launch({ headless: true });
const failures = [];
async function check(name, fn) {
  try { await fn(); console.log('PASS', name); } catch (error) { failures.push(`${name}: ${error.message}`); console.error('FAIL', name, error.message); }
}

const { VIEWS } = await (async () => {
  const page = await browser.newPage();
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.LocalAIViews);
  // printLab sends the browser to Pi Hub's /lab (step 6, PR 6.4; print-lab-ui checks that): it is no page of Local AI's.
  const ids = await page.evaluate(() => window.LocalAIViews.VIEWS.map(v => v.id).filter(id => id !== 'printLab'));
  await page.close();
  return { VIEWS: ids };
})();

const iso = ago => new Date(Date.now() - ago * 1000).toISOString();
const CATS = ['ux', 'bug', 'security', 'cleanup', 'idea', 'a11y'], SEVS = ['high', 'medium', 'low'];
// Uneven counts, so the heat map has full, faint and empty (disabled) cells.
const FINDINGS = CATS.flatMap((category, c) => SEVS.flatMap((severity, s) => Array.from({ length: (c * 3 + s) % 5 * 3 }, (_, i) => ({
  id: `f-${category}-${severity}-${i}`, title: `Finding ${category} ${severity} ${i}`, category, severity, status: i % 4 ? 'proposed' : 'fixed',
  summary: 'Something to look at.', votes: { up: 0, down: 0 }, createdAt: iso(3600), updatedAt: iso(60)
}))));
const EVENTS = Array.from({ length: 80 }, (_, i) => ({ id: `e${i}`, sessionId: 's1', at: iso(i * 30), kind: 'action', tool: 'Bash', title: `Step ${i} of a long session`, detail: 'Ran a command.', status: 'done' }));
const LIBRARY = Array.from({ length: 9 }, (_, i) => ({ id: `lib-${i}`, kind: i % 3 ? 'conversation' : 'research', title: `Saved item ${i} with a fairly long title`, summary: 'A short summary of what was made.', createdAt: iso(i * 3600), pinned: i === 0, meta: {}, data: {} }));
const ISSUES = [{ id: 'issue-1', key: 'k1', kind: 'browser-runtime', name: 'RangeError: Maximum call stack size exceeded.', detail: Array.from({ length: 40 }, (_, i) => `    at frame${i} (app.js:${i}:1)`).join('\n'), severity: 'high', status: 'open', occurrences: 3, createdAt: iso(7200), updatedAt: iso(60), lastSeenAt: iso(60) }];
const RELEASES = { current: { version: '2.0.400', commit: 'a'.repeat(40), deployedAt: iso(600) }, repoUrl: 'https://github.com/example/LocalAI', history: [{ commit: 'a'.repeat(40), version: '2.0.400', deployedAt: iso(600), notes: [{ title: 'A change people can read about', pr: 181 }, { title: 'Another one', pr: 180 }] }] };

async function stubbed(viewport) {
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport, isMobile: viewport.width < 760, hasTouch: viewport.width < 760 });
  await ctx.addInitScript(() => { try { localStorage.setItem('localai.firstRun.done', '1'); } catch {} });
  const page = await ctx.newPage();
  const json = (route, body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/claude/board*', async route => {
    // The page can move on mid-request (connection reset); drop that request instead of crashing the suite.
    const res = await route.fetch().catch(() => null); if (!res) return route.abort().catch(() => {}); const j = await res.json();
    const byCategory = {};
    for (const f of FINDINGS) { const c = byCategory[f.category] || (byCategory[f.category] = { high: 0, medium: 0, low: 0, open: 0, total: 0 }); c[f.severity]++; c.total++; if (f.status !== 'fixed') c.open++; }
    await json(route, { ...j, events: EVENTS, findings: FINDINGS, summary: { ...j.summary, total: FINDINGS.length, byCategory } });
  });
  await page.route(u => u.pathname === '/api/library', route => json(route, { items: LIBRARY }));
  await page.route(u => u.pathname === '/api/issues', route => json(route, { items: ISSUES }));
  await page.route(u => u.pathname === '/api/releases', route => json(route, RELEASES));
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.showView === 'function');
  return page;
}

const RULES = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];
for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 860 }]) {
  const page = await stubbed(viewport);
  for (const id of VIEWS) {
    await check(`axe: ${id} at ${viewport.width}px`, async () => {
      await page.evaluate(v => window.showView(v), id);
      await page.waitForTimeout(700);
      await addAxe(page, axePath);
      const v = await page.evaluate(rules => window.axe.run(document, { runOnly: { type: 'tag', values: rules } })
        .then(r => r.violations.map(x => `${x.id}: ${x.nodes.slice(0, 3).map(n => n.target.join(' ')).join(' | ')}`)), RULES);
      assert.deepEqual(v, []);
    });
  }
  await page.context().close();
}

await check('Agent World result: headed sections in order; Routing closed below them', async () => {
  const page = await stubbed({ width: 1280, height: 860 });
  await page.evaluate(() => window.showView('agents'));
  await page.evaluate(m => window.LocalAISpecialists.renderMission(m), { id: 'm-a11y', goal: 'A goal', status: 'complete', answer: 'The summary.', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), workers: [{ id: 'router', name: 'Mission Router', state: 'complete' }], results: [] });
  await page.waitForFunction(() => document.querySelectorAll('#agentResultBody h3').length === 3);
  assert.deepEqual(await page.locator('#agentResultBody h3').allInnerTexts(), ['Summary', 'What each worker found', 'Sources']);
  const routing = page.locator('#agentResultBody details', { hasText: 'Routing' });
  assert.equal(await routing.isVisible(), true);
  assert.equal(await routing.evaluate(d => d.open), false, 'Routing starts closed');
  await page.context().close();
});

await check('phone: every page keeps its h1 for screen readers, though the header shows the title', async () => {
  const page = await stubbed({ width: 390, height: 844 });
  for (const id of ['library', 'status', 'claude', 'work']) {
    await page.evaluate(v => window.showView(v), id);
    await page.waitForTimeout(300);
    // The accessibility tree, as a screen reader gets it: display:none would drop the heading, visually hidden keeps it.
    const label = await page.locator(`#${id} h1`).first().textContent();
    assert.equal(await page.getByRole('heading', { level: 1, name: label.trim(), exact: true }).count() >= 1, true, `${id}: "${label.trim()}"`);
  }
  await page.context().close();
});

await browser.close();
if (failures.length) { console.error(`\n${failures.length} accessibility check(s) failed`); process.exit(1); }
console.log('\nAll accessibility checks passed');
