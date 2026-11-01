// The model coordinator's controls (docs/superpowers/specs/2026-10-26-model-coordinator-design.md, step 3), on a
// throwaway server with a fake Groq key: Models › Cloud models (the switch, each service, what runs where; never a key),
// Home's "Use a bigger model" / "Keep on this PC" (shown only with cloud on, sent once, then reset), and "Answered by"
// on a run. Phone and desktop, axe. SHOTS=<dir> saves screenshots there.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { addAxe } from './axe-helper.mjs';

const { spawnAppServer } = createRequire(import.meta.url)('./spawn-server.cjs');
const axePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'vendor', 'axe.min.js');
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];
const shots = process.env.SHOTS || '';
let failed = 0;
async function check(name, fn) { try { await fn(); console.log('PASS', name); } catch (e) { failed++; console.log('FAIL', name, e.message); } }
const shot = async (page, name) => { if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, name), fullPage: true }); } };
const axe = async (page, sel) => { await addAxe(page, axePath); return page.evaluate(([s, tags]) => window.axe.run(document.querySelector(s), { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] }).then(r => r.violations.map(x => `${x.id}: ${x.nodes.map(n => n.target.join(' ')).join(', ')}`)), [sel, TAGS]); };

const KEY = 'gsk_ui_test_never_shown_123456';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-routing-ui-'));
const off = 'http://127.0.0.1:9';
// A stand-in Ollama so Chat is available (its gate reads the model list); the chat itself is caught in the browser.
const ollama = http.createServer((req, res) => { req.resume(); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(req.url === '/api/tags' ? { models: [{ name: 'qwen3:4b-instruct-32k', size: 1 }] } : req.url === '/api/ps' ? { models: [] } : { version: '0.0.0' })); });
ollama.listen(0, '127.0.0.1'); await once(ollama, 'listening');
const { child, ready } = spawnAppServer({ env: { DATA_DIR: dataDir, WORKSPACE_ROOT: dataDir, OLLAMA_URL: `http://127.0.0.1:${ollama.address().port}`, MODEL: 'qwen3:4b-instruct-32k', SEARXNG_URL: off, COMFY_URL: off, N8N_URL: off, PROXY_URL: off, GRIDCRAFT_URL: off, MAC_AI_HOME_URL: off, MAC_DSH_URL: off, LOCALAI_WORKSHOP_URL: off, LOCALAI_GROQ_API_KEY: KEY, LOCALAI_GROQ_URL: off, LOCALAI_CEREBRAS_API_KEY: '' } });
const base = await ready;
const browser = await chromium.launch();

// A finished research run whose answer came from Groq, for the run view.
const RUN = { id: 'run-cloud-ui', type: 'research', threadId: 'run-cloud-ui', title: 'Compare PETG and ASA', status: 'completed', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  input: { prompt: 'Compare PETG and ASA' }, output: { text: 'ASA resists UV better.' }, summary: 'ASA resists UV better.',
  meta: { route: { provider: 'groq', model: 'llama-3.3-70b-versatile', class: 'shareable', why: 'Not private: research about public topics' } },
  card: { kind: 'research', icon: 'globe', title: 'Compare PETG and ASA', summary: 'ASA resists UV better.', badge: { label: 'Done', tone: 'good' }, preview: null, action: { label: 'Open' }, approval: null, view: 'ask', route: { text: 'Answered by Llama 3.3 70B · Groq', why: 'Not private: research about public topics' } } };

try {
  for (const [name, viewport] of [['phone', { width: 390, height: 844 }], ['desktop', { width: 1280, height: 900 }]]) {
    const page = await browser.newPage({ serviceWorkers: 'block', viewport });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => { try { localStorage.setItem('localai.home.mode', 'ask'); } catch {} });
    const bodies = [];
    await page.route(u => u.pathname === '/api/chat/stream', r => { bodies.push(JSON.parse(r.request().postData() || '{}')); r.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"test: not sent"}' }); });
    await page.goto(base, { waitUntil: 'networkidle' });

    await check(`${name}: Models shows the switch off, each cloud service and what runs where, never a key`, async () => {
      await page.evaluate(() => window.showView('models'));
      await page.waitForSelector('#modelCloudSwitch');
      assert.equal(await page.isChecked('#modelCloudSwitch'), false);
      assert.match(await page.locator('#modelCloudState').innerText(), /^Off/);
      const rows = await page.locator('#modelRoutingProviders li').allInnerTexts();
      assert.equal(rows.length, 2);
      assert.match(rows.find(r => /Groq/.test(r)), /Key set/);
      assert.match(rows.find(r => /Cerebras/.test(r)), /No key/);
      assert.ok(await page.locator('#modelRoutingTable tbody tr').count() >= 6);
      assert.ok(!(await page.content()).includes(KEY.slice(0, 12)), 'no key on the page');
    });
    await check(`${name}: Models › Cloud models is axe-clean`, async () => { assert.deepEqual(await axe(page, '#modelRouting'), []); });
    await shot(page, `model-routing-${name}.png`);

    await check(`${name}: Home has no cloud toggles while cloud is off`, async () => {
      await page.evaluate(() => window.LocalAIRouter.go('#home'));
      await page.waitForSelector('#commandInput');
      await page.waitForTimeout(300);
      assert.equal(await page.locator('#homeRoute').isHidden(), true);
    });

    await check(`${name}: turning the switch on saves it`, async () => {
      await page.evaluate(() => window.showView('models'));
      await page.locator('#modelCloudSwitch').check();
      await page.waitForFunction(() => /^On/.test(document.getElementById('modelCloudState')?.textContent || ''));
      assert.equal((await (await fetch(base + '/api/models/routing')).json()).cloud, true);
    });

    await check(`${name}: with cloud on, Home offers the two toggles once something is typed; one at a time; they go with one send, then reset`, async () => {
      await page.evaluate(() => window.LocalAIRouter.go('#home'));
      await page.waitForSelector('#homeComposer');
      await page.waitForTimeout(300);
      assert.equal(await page.locator('#homeRoute').isVisible(), false, 'an idle composer is one row');
      await page.fill('#commandInput', 'Compare PETG and ASA for outdoor parts');
      await page.waitForSelector('#homeRoute:not([hidden])');
      await page.locator('label[for="homeBigger"]').click();
      await page.locator('label[for="homeKeepLocal"]').click();
      assert.deepEqual([await page.isChecked('#homeBigger'), await page.isChecked('#homeKeepLocal')], [false, true]);
      await page.locator('label[for="homeBigger"]').click();
      assert.deepEqual(await axe(page, '#homeComposer'), []);
      await shot(page, `model-routing-home-${name}.png`);
      await page.fill('#commandInput', 'Compare PETG and ASA for outdoor parts');
      // Out of the box first, as a tap on Send does: on a phone the composer moves back onto the tab bar when typing stops.
      await page.locator('#commandInput').blur();
      const asked = page.waitForRequest(r => r.url().includes('/api/chat/stream'), { timeout: 8000 }).catch(() => null);
      await page.click('#commandGo');
      await asked;
      await shot(page, `model-routing-sent-${name}.png`);
      const sent = bodies.at(-1);
      assert.ok(sent, 'a chat was sent');
      assert.equal(sent.bigger, true);
      assert.equal(sent.keepLocal, undefined);
      assert.equal(await page.isChecked('#homeBigger'), false, 'reset after the send');
      // The stand-in refused the chat: wait for the run view to say so, then close it.
      await page.waitForFunction(() => /not sent/.test(document.getElementById('runDrawer')?.textContent || ''));
      await page.evaluate(() => window.LocalAIRouter.go('#home', { replace: true }));
      await page.waitForFunction(() => !document.body.classList.contains('run-view-open'));
    });

    await check(`${name}: turning the switch off hides the toggles again`, async () => {
      await page.evaluate(() => window.showView('models'));
      await page.waitForSelector('#modelCloudSwitch');
      await page.locator('#modelCloudSwitch').uncheck();
      await page.waitForFunction(() => /^Off/.test(document.getElementById('modelCloudState')?.textContent || ''));
      await page.evaluate(() => window.LocalAIRouter.go('#home'));
      await page.waitForTimeout(500);
      assert.equal(await page.locator('#homeRoute').isHidden(), true);
    });

    await check(`${name}: a run says where its answer came from, and why`, async () => {
      await page.route(u => u.pathname === '/api/runs', r => {
        const q = new URL(r.request().url()).searchParams;
        r.fulfill({ contentType: 'application/json', body: JSON.stringify(q.get('id') ? { item: RUN } : { items: [RUN], summary: { total: 1, active: 0, failed: 0, awaitingApproval: 0 } }) });
      });
      await page.evaluate(() => window.LocalAIRouter.go('#run/run-cloud-ui'));
      const line = page.locator('#runDrawer .chat-turn .run-route');
      await line.waitFor();
      assert.equal(await line.innerText(), 'Answered by Llama 3.3 70B · Groq. Not private: research about public topics.');
      assert.deepEqual(await axe(page, '#runDrawer'), []);
      await shot(page, `model-routing-run-${name}.png`);
    });
    await check(`${name}: no page errors`, async () => { assert.deepEqual(errors, []); });
    await page.close();
  }
} finally {
  await browser.close();
  child.kill();
  ollama.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
if (failed) { console.log(`${failed} failed`); process.exit(1); }
